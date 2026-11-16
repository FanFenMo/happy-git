package com.happygit.server.cloud;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.nio.charset.StandardCharsets;
import java.util.*;
import static com.happygit.server.cloud.CloudJson.*;
import static com.happygit.server.cloud.CloudIngestService.*;

/** Freezes bounded export ranges in MySQL. Hadoop writes and closes the file before commit. */
@Service @Profile("cloud")
public class CloudExportService {
    private final JdbcTemplate db;
    public CloudExportService(JdbcTemplate db) { this.db=db; }
    @Transactional public ObjectNode prepare() {
        var pending=db.queryForList("SELECT export_id FROM cloud_exports WHERE state='pending' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED");
        if (!pending.isEmpty()) return load((String)pending.get(0).get("export_id"));
        var users=db.queryForList("SELECT * FROM cloud_users u WHERE analysis_enabled=TRUE AND (revision>exported_revision OR EXISTS (SELECT 1 FROM cloud_streams s WHERE s.subject_id=u.subject_id AND s.analysis_epoch=u.analysis_epoch AND s.accepted_through>s.exported_through)) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED");
        if (users.isEmpty()) return object().put("state","idle");
        var user=users.get(0); String subject=(String)user.get("subject_id"); long epoch=value(user,"analysis_epoch");
        // A second prepare may have waited behind a concurrent freeze of this user.
        var existing=db.queryForList("SELECT export_id FROM cloud_exports WHERE subject_id=? AND analysis_epoch=? AND state='pending' FOR UPDATE",subject,epoch);
        if (!existing.isEmpty()) return load((String)existing.get(0).get("export_id"));
        ArrayNode records=JSON.createArrayNode(), ranges=JSON.createArrayNode();
        ObjectNode seed=object().put("kind","subject").put("subjectId",subject).put("analysisEpoch",epoch).put("sourceKind","client_authenticated")
                .put("observedAt",System.currentTimeMillis()).put("revision",value(user,"revision"));
        seed.setAll((ObjectNode)parse((String)user.get("preferences_json"))); records.add(seed);
        for (String kind:List.of("stars","owned")) {
            var collections=db.queryForList("SELECT payload_json FROM cloud_collections WHERE subject_id=? AND analysis_epoch=? AND collection_kind=? AND complete=TRUE ORDER BY revision DESC LIMIT 1",subject,epoch,kind);
            if (!collections.isEmpty()) records.add(parse((String)collections.get(0).get("payload_json")));
        }
        var streams=db.queryForList("SELECT * FROM cloud_streams WHERE subject_id=? AND analysis_epoch=? AND accepted_through>exported_through ORDER BY stream_epoch LIMIT 1",subject,epoch);
        for (var stream:streams) {
            long start=value(stream,"exported_through")+1, end=Math.min(value(stream,"accepted_through"),start+499);
            var events=db.queryForList("SELECT payload_json FROM cloud_events WHERE stream_epoch=? AND device_seq BETWEEN ? AND ? ORDER BY device_seq",stream.get("stream_epoch"),start,end);
            for (var event:events) if (event.get("payload_json")!=null) {
                JsonNode raw=parse((String)event.get("payload_json"));
                ObjectNode row=object().put("kind","event").put("subjectId",subject).put("eventId",raw.path("eventId").asText())
                        .put("repoId",raw.path("repoId").asText()).put("occurredAt",raw.path("effectiveAt").asLong())
                        .put("source",raw.path("source").asText().equals("repo_open")?"repo_open":"browse")
                        .put("entrySource",raw.path("entrySource").asText(raw.path("source").asText()))
                        .put("sourceKind","client_authenticated").put("analysisEpoch",epoch)
                        .put("streamEpoch",(String)stream.get("stream_epoch"));
                // Sequence is taken from the receipt, including gaps occupied by discarded records.
                row.put("deviceSeq",raw.path("deviceSeq").asLong()); records.add(row);
            }
            ranges.add(object().put("streamEpoch",(String)stream.get("stream_epoch")).put("firstSeq",value(stream,"exported_through")+1).put("lastSeq",end));
        }
        String id=UUID.randomUUID().toString(), bytes=jsonl(records);
        db.update("INSERT INTO cloud_exports VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?)",id,subject,epoch,value(user,"revision"),"pending",records.toString(),hash(bytes),bytes.getBytes(StandardCharsets.UTF_8).length,records.size(),ranges.toString(),System.currentTimeMillis());
        return load(id);
    }
    public ObjectNode load(String id) {
        var rows=db.queryForList("SELECT * FROM cloud_exports WHERE export_id=?",id);
        if (rows.isEmpty()) throw error(404,"EXPORT_NOT_FOUND","归档批次不存在");
        var row=rows.get(0); String state=(String)row.get("state");
        if (state.equals("invalidated")) throw error(409,"STALE_ANALYSIS_EPOCH","归档范围已失效");
        ObjectNode response=object().put("exportId",id).put("state",state).put("subjectId",(String)row.get("subject_id"))
                .put("analysisEpoch",value(row,"analysis_epoch")).put("sha256",(String)row.get("sha256"))
                .put("bytes",value(row,"byte_count")).put("recordCount",value(row,"record_count"));
        response.set("ranges",parse((String)row.get("ranges_json")));
        if (row.get("records_json")!=null) response.set("records",parse((String)row.get("records_json")));
        if (row.get("archive_json")!=null) response.set("archive",parse((String)row.get("archive_json")));
        return response;
    }
    @Transactional public ObjectNode commit(String id, JsonNode descriptor) {
        var initial=db.queryForMap("SELECT subject_id FROM cloud_exports WHERE export_id=?",id);
        var user=db.queryForMap("SELECT * FROM cloud_users WHERE subject_id=? FOR UPDATE",initial.get("subject_id"));
        var row=db.queryForMap("SELECT * FROM cloud_exports WHERE export_id=? FOR UPDATE",id);
        if (!enabled(user)||value(user,"analysis_epoch")!=value(row,"analysis_epoch")||row.get("state").equals("invalidated")) throw error(409,"STALE_ANALYSIS_EPOCH","归档范围已失效");
        if (row.get("state").equals("committed")) return load(id);
        if (!row.get("sha256").equals(descriptor.path("sha256").asText())||value(row,"byte_count")!=number(descriptor,"bytes",0)
                ||value(row,"record_count")!=number(descriptor,"records",1)) throw error(409,"ARCHIVE_MISMATCH","归档摘要、字节数或记录数不一致");
        String path=descriptor.path("path").asText();
        if (!path.startsWith("hdfs://") || path.endsWith(".inprogress")) throw error(400,"INVALID_ARCHIVE","需要闭合 HDFS 文件");
        db.update("UPDATE cloud_exports SET state='committed',archive_json=? WHERE export_id=?",descriptor.toString(),id);
        for (JsonNode range:parse((String)row.get("ranges_json"))) db.update("UPDATE cloud_streams SET exported_through=GREATEST(exported_through,?) WHERE stream_epoch=? AND analysis_epoch=?",range.path("lastSeq").asLong(),range.path("streamEpoch").asText(),row.get("analysis_epoch"));
        db.update("UPDATE cloud_users SET exported_revision=GREATEST(exported_revision,?) WHERE subject_id=?",row.get("revision"),row.get("subject_id"));
        return load(id);
    }
    public JsonNode scopes() {
        ArrayNode scopes=JSON.createArrayNode();
        for (var row:db.queryForList("SELECT subject_id,analysis_epoch FROM cloud_users WHERE analysis_enabled=TRUE")) scopes.add(object().put("subjectId",(String)row.get("subject_id")).put("analysisEpoch",value(row,"analysis_epoch")));
        return scopes;
    }
    static String jsonl(JsonNode records) { StringBuilder bytes=new StringBuilder(); for(JsonNode row:records) bytes.append(row).append('\n'); return bytes.toString(); }
}
