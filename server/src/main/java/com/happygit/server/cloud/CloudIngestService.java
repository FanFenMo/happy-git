package com.happygit.server.cloud;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.util.*;
import static com.happygit.server.cloud.CloudJson.*;

@Service @Profile("cloud")
public class CloudIngestService {
    private final JdbcTemplate db;
    private final CloudAuthService auth;
    public CloudIngestService(JdbcTemplate db, CloudAuthService auth) { this.db=db; this.auth=auth; }
    private Map<String,Object> lock(Map<String,Object> session) {
        var user = db.queryForMap("SELECT * FROM cloud_users WHERE subject_id=? FOR UPDATE",session.get("subject_id"));
        if (db.queryForObject("SELECT COUNT(*) FROM cloud_sessions WHERE access_hash=? AND revoked=FALSE AND access_expires_at>?",Long.class,session.get("access_hash"),System.currentTimeMillis()) != 1)
            throw error(401,"SESSION_EXPIRED","需要重新登录");
        return user;
    }
    static long value(Map<String,Object> row, String key) { return ((Number)row.get(key)).longValue(); }
    static boolean enabled(Map<String,Object> row) { return Boolean.TRUE.equals(row.get("analysis_enabled")) || "1".equals(String.valueOf(row.get("analysis_enabled"))); }
    private void active(Map<String,Object> user, long epoch) {
        if (!enabled(user)) throw error(409,"ANALYSIS_DISABLED","云端分析已关闭");
        if (value(user,"analysis_epoch") != epoch) throw error(409,"STALE_ANALYSIS_EPOCH","重新读取设置并注册设备流");
    }
    private ObjectNode settings(Map<String,Object> user) {
        ObjectNode result = (ObjectNode)parse((String)user.get("preferences_json"));
        return result.put("subjectId",(String)user.get("subject_id")).put("analysisEnabled",enabled(user))
                .put("analysisEpoch",value(user,"analysis_epoch")).put("revision",value(user,"revision"));
    }
    @Transactional public ObjectNode preferences(String authorization) { return settings(lock(auth.session(authorization))); }
    @Transactional public ObjectNode register(String authorization, JsonNode body) {
        var session = auth.session(authorization); var user = lock(session); String subject = (String)user.get("subject_id");
        String installation = id(body,"installationId");
        db.update("INSERT INTO cloud_devices VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE installation_id=VALUES(installation_id)",UUID.randomUUID().toString(),subject,installation,System.currentTimeMillis());
        String device = db.queryForObject("SELECT device_id FROM cloud_devices WHERE subject_id=? AND installation_id=?",String.class,subject,installation);
        if (session.get("device_id") != null && !device.equals(session.get("device_id"))) throw error(409,"DEVICE_ALREADY_BOUND","本会话已绑定其他设备");
        db.update("UPDATE cloud_sessions SET device_id=? WHERE access_hash=?",device,session.get("access_hash"));
        long epoch = value(user,"analysis_epoch");
        db.update("INSERT INTO cloud_streams(stream_epoch,device_id,subject_id,analysis_epoch) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE device_id=VALUES(device_id)",UUID.randomUUID().toString(),device,subject,epoch);
        var stream = db.queryForMap("SELECT * FROM cloud_streams WHERE device_id=? AND analysis_epoch=?",device,epoch);
        ObjectNode result = ack(stream); result.set("preferences",settings(user)); return result;
    }
    private ObjectNode ack(Map<String,Object> stream) {
        return object().put("deviceId",(String)stream.get("device_id")).put("streamEpoch",(String)stream.get("stream_epoch"))
                .put("analysisEpoch",value(stream,"analysis_epoch")).put("acceptedThrough",value(stream,"accepted_through"))
                .put("exportedThrough",value(stream,"exported_through")).put("processedThrough",value(stream,"processed_through"))
                .put("serverTime",System.currentTimeMillis());
    }
    @Transactional public ObjectNode events(String authorization, JsonNode body) {
        var session = auth.session(authorization); var user = lock(session); String subject = (String)user.get("subject_id");
        long epoch = number(body,"analysisEpoch",1); active(user,epoch);
        String streamId = id(body,"streamEpoch"), request = id(body,"requestId");
        var streams = db.queryForList("SELECT * FROM cloud_streams WHERE stream_epoch=? AND subject_id=? AND device_id=? AND analysis_epoch=?",streamId,subject,session.get("device_id"),epoch);
        if (streams.isEmpty()) throw error(409,"DEVICE_STREAM_REQUIRED","请先注册本会话的设备流");
        var stream = streams.get(0); long accepted = value(stream,"accepted_through");
        JsonNode events = body.path("events"); long first = number(body,"firstSeq",1);
        if (!events.isArray() || events.isEmpty() || events.size()>500) throw error(400,"INVALID_BATCH","每批需要 1 至 500 条记录");
        String batchHash = hash(canonical(body).toString());
        var previous = db.queryForList("SELECT content_hash FROM cloud_batches WHERE subject_id=? AND request_id=?",subject,request);
        if (!previous.isEmpty() && !batchHash.equals(previous.get(0).get("content_hash"))) throw error(409,"IDENTITY_CONFLICT","批次身份对应不同内容");
        ArrayNode adjustments = JSON.createArrayNode(); long now = System.currentTimeMillis();
        for (int index=0; index<events.size(); index++) {
            JsonNode event = events.get(index); String eventId = id(event,"eventId"); long seq = number(event,"deviceSeq",1);
            if (seq != first+index || seq > MAX_SAFE) throw error(400,"INVALID_SEQUENCE","序号须从 firstSeq 连续递增");
            String payloadHash = event.path("payloadHash").asText("");
            if (!payloadHash.matches("[a-f0-9]{64}")) throw error(400,"INVALID_DIGEST","需要 SHA-256 十六进制摘要");
            boolean discard = event.path("recordKind").asText().equals("discard");
            ObjectNode record = object().put("recordKind",discard?"discard":"open").put("eventId",eventId).put("deviceSeq",seq).put("payloadHash",payloadHash);
            long effective = 0;
            if (!discard) {
                if (!event.path("recordKind").asText().equals("open") || !event.path("schemaVersion").asText().equals("1.0.0")) throw error(400,"INVALID_EVENT","需要 open/1.0.0 事件");
                if (!streamId.equals(id(event,"streamEpoch")) || epoch != number(event,"analysisEpoch",1)) throw error(400,"INVALID_EVENT_SCOPE","事件范围与批次不一致");
                String repo = id(event,"repoId"), source = event.path("source").asText(); long occurred = number(event,"occurredAt",1);
                if (!Set.of("browse","repo_open","recommended","trending","history","stars","owned","detail","open").contains(source)) throw error(400,"INVALID_SOURCE","不支持的浏览来源");
                ArrayNode canonical = JSON.createArrayNode().add("1.0.0").add(eventId).add(streamId).add(seq).add(epoch).add(repo).add(occurred).add(source);
                if (!hash(canonical.toString()).equals(payloadHash)) throw error(400,"DIGEST_MISMATCH","事件摘要不匹配");
                effective = occurred > now+300000 ? now : occurred;
                record.put("schemaVersion","1.0.0").put("streamEpoch",streamId).put("analysisEpoch",epoch)
                        .put("repoId",repo).put("occurredAt",occurred).put("source",source);
                if (event.has("entrySource")) record.put("entrySource",id(event,"entrySource"));
            }
            String contentHash = hash(record.toString());
            var old = db.queryForList("SELECT * FROM cloud_events WHERE subject_id=? AND event_id=?",subject,eventId);
            if (!old.isEmpty()) {
                var receipt = old.get(0);
                if (!streamId.equals(receipt.get("stream_epoch")) || seq != value(receipt,"device_seq") || !payloadHash.equals(receipt.get("payload_hash"))
                        || (!discard && !contentHash.equals(receipt.get("content_hash")))) throw error(409,"IDENTITY_CONFLICT","事件身份对应不同内容");
                if (!discard && receipt.get("effective_at") != null) adjustments.add(object().put("eventId",eventId).put("effectiveAt",value(receipt,"effective_at")));
                continue;
            }
            if (seq != accepted+1) throw error(409,"SEQUENCE_GAP","下一序号应为 "+(accepted+1));
            if (!discard) record.put("effectiveAt",effective).put("receivedAt",now);
            db.update("INSERT INTO cloud_events VALUES(?,?,?,?,?,?,?,?,?,?)",subject,eventId,streamId,seq,epoch,payloadHash,contentHash,discard?null:effective,discard?null:record.toString());
            if (!discard) adjustments.add(object().put("eventId",eventId).put("effectiveAt",effective));
            accepted=seq;
        }
        db.update("UPDATE cloud_streams SET accepted_through=? WHERE stream_epoch=?",accepted,streamId);
        if (previous.isEmpty()) db.update("INSERT INTO cloud_batches VALUES(?,?,?)",subject,request,batchHash);
        stream.put("accepted_through",accepted); ObjectNode result = ack(stream); result.set("timeAdjustments",adjustments); return result;
    }
    private ObjectNode replay(String subject, String operation, String digest) {
        var rows = db.queryForList("SELECT * FROM cloud_operations WHERE subject_id=? AND operation_id=?",subject,operation);
        if (rows.isEmpty()) return null;
        if (!digest.equals(rows.get(0).get("content_hash"))) throw error(409,"IDENTITY_CONFLICT","操作身份对应不同内容");
        return (ObjectNode)parse((String)rows.get(0).get("response_json"));
    }
    private ObjectNode remember(String subject, String operation, String digest, ObjectNode response) {
        db.update("INSERT INTO cloud_operations VALUES(?,?,?,?)",subject,operation,digest,response.toString()); return response;
    }
    private void expected(Map<String,Object> user, JsonNode body) {
        if (value(user,"revision") != number(body,"expectedRevision",0)) throw error(409,"REVISION_CONFLICT","先读取最新 revision");
    }
    @Transactional public ObjectNode collections(String authorization, JsonNode body) {
        var session = auth.session(authorization); var user = lock(session); String subject = (String)user.get("subject_id");
        String operation = id(body,"operationId"), digest = hash("collection:"+canonical(body)); ObjectNode replay = replay(subject,operation,digest); if (replay!=null) return replay;
        long epoch = number(body,"analysisEpoch",1); active(user,epoch); expected(user,body);
        String kind = body.path("collectionKind").asText();
        if (!Set.of("stars","owned").contains(kind) || !body.path("complete").isBoolean()) throw error(400,"INVALID_COLLECTION","需要集合类型和完整性");
        ArrayNode members = ids(body,"repoIds",20000); long observed = number(body,"observedAt",1);
        ObjectNode snapshot = object().put("kind","collection").put("subjectId",subject).put("analysisEpoch",epoch).put("collectionKind",kind)
                .put("complete",body.path("complete").asBoolean()).put("observedAt",observed).put("sourceKind","client_authenticated");
        snapshot.set("repoIds",members); long revision = value(user,"revision")+1; snapshot.put("revision",revision);
        db.update("INSERT INTO cloud_collections VALUES(?,?,?,?,?,?,?)",subject,epoch,kind,revision,body.path("complete").asBoolean(),snapshot.toString(),System.currentTimeMillis());
        db.update("UPDATE cloud_users SET revision=? WHERE subject_id=?",revision,subject);
        ObjectNode response = object().put("revision",revision).put("analysisEpoch",epoch).put("complete",body.path("complete").asBoolean()).put("activated",body.path("complete").asBoolean());
        return remember(subject,operation,digest,response);
    }
    @Transactional public ObjectNode updatePreferences(String authorization, JsonNode body, boolean reset) {
        var session = auth.session(authorization); var user = lock(session); String subject = (String)user.get("subject_id");
        String operation = id(body,"operationId"), digest = hash((reset?"reset:":"preferences:")+canonical(body)); ObjectNode replay = replay(subject,operation,digest); if (replay!=null) return replay;
        expected(user,body); long revision = value(user,"revision")+1, epoch = value(user,"analysis_epoch"); boolean enabled = enabled(user);
        ObjectNode prefs = (ObjectNode)parse((String)user.get("preferences_json"));
        if (!reset) {
            if (!body.path("analysisEnabled").isBoolean()) throw error(400,"INVALID_FIELD","analysisEnabled 必须明确指定");
            boolean next = body.path("analysisEnabled").asBoolean();
            if (enabled != next) epoch++;
            enabled=next; prefs.set("manualTags",ids(body,"manualTags",100)); prefs.set("hiddenRepoIds",ids(body,"hiddenRepoIds",20000));
        } else { epoch++; prefs=object(); prefs.putArray("manualTags"); prefs.putArray("hiddenRepoIds"); }
        if (epoch != value(user,"analysis_epoch")) {
            // Keep only receipts after consent changes; archived scopes are also invalidated.
            db.update("UPDATE cloud_events SET payload_json=NULL WHERE subject_id=?",subject);
            db.update("DELETE FROM cloud_collections WHERE subject_id=?",subject);
            db.update("UPDATE cloud_exports SET state='invalidated',records_json=NULL WHERE subject_id=?",subject);
        }
        db.update("UPDATE cloud_users SET revision=?,analysis_epoch=?,analysis_enabled=?,preferences_json=? WHERE subject_id=?",revision,epoch,enabled,prefs.toString(),subject);
        user.put("revision",revision);user.put("analysis_epoch",epoch);user.put("analysis_enabled",enabled);user.put("preferences_json",prefs.toString());
        return remember(subject,operation,digest,settings(user));
    }
    private ArrayNode ids(JsonNode body, String field, int limit) {
        JsonNode values=body.path(field); if (!values.isArray() || values.size()>limit) throw error(400,"INVALID_FIELD",field);
        ArrayNode output=JSON.createArrayNode(); Set<String> seen=new HashSet<>();
        for (JsonNode item:values) {
            String text=item.asText(""); if (!item.isTextual() || !text.matches("[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")) throw error(400,"INVALID_FIELD",field);
            if (seen.add(text)) output.add(text);
        }
        return output;
    }
}
