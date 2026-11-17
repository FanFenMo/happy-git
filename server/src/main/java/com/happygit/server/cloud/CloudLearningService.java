package com.happygit.server.cloud;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.util.*;
import static com.happygit.server.cloud.CloudJson.*;
import static com.happygit.server.cloud.CloudIngestService.*;

/** Transactional model and personal generation pointers. Artifact bodies stay in Hadoop. */
@Service @Profile("cloud")
public class CloudLearningService {
    private final JdbcTemplate db;
    private final CloudAuthService auth;
    public CloudLearningService(JdbcTemplate db, CloudAuthService auth) { this.db=db; this.auth=auth; }

    public static void requestInference(JdbcTemplate db, String subject, long epoch) {
        String version=db.queryForObject("SELECT model_version FROM learning_active WHERE namespace='production'",String.class);
        db.update("INSERT INTO learning_inference_queue(subject_id,analysis_epoch,model_version,state,requested_at) VALUES(?,?,?,'queued',?) "
                +"ON DUPLICATE KEY UPDATE analysis_epoch=VALUES(analysis_epoch),request_revision=request_revision+1,"
                +"model_version=VALUES(model_version),state='queued',requested_at=VALUES(requested_at),task_id=NULL,error_message=NULL",subject,epoch,version,System.currentTimeMillis());
    }
    private Map<String,Object> user(String subject, long epoch) {
        var users=db.queryForList("SELECT * FROM cloud_users WHERE subject_id=? FOR UPDATE",subject);
        if(users.isEmpty()||!enabled(users.get(0))||value(users.get(0),"analysis_epoch")!=epoch)
            throw error(409,"STALE_ANALYSIS_EPOCH","分析范围已失效");
        return users.get(0);
    }
    private ObjectNode descriptor(String namespace, String version) {
        var rows=db.queryForList("SELECT descriptor_json FROM learning_models WHERE namespace=? AND model_version=?",namespace,version);
        if(rows.isEmpty())throw error(404,"MODEL_NOT_FOUND","模型不存在");
        return (ObjectNode)parse((String)rows.get(0).get("descriptor_json"));
    }
    private void scopes(JsonNode body) {
        // Lock in subject order; privacy changes use the same user lock.
        TreeMap<String,JsonNode> sorted=new TreeMap<>();
        for(JsonNode scope:body.path("scopes")) sorted.put(id(scope,"subjectId"),scope);
        for(var entry:sorted.entrySet()) {
            var current=user(entry.getKey(),number(entry.getValue(),"analysisEpoch",1));
            if(value(current,"revision")!=number(entry.getValue(),"revision",0))
                throw error(409,"INPUT_CHANGED","训练范围或反馈已更新，请重新准备训练快照");
        }
    }
    @Transactional public ObjectNode checkScopes(JsonNode body) { scopes(body);return object().put("state","valid"); }
    @Transactional public ObjectNode register(JsonNode body) {
        String namespace=id(body,"namespace"),version=id(body,"modelVersion");
        if(namespace.equals("production")&&body.path("catalogMode").asText().equals("synthetic_fixture"))
            throw error(409,"EXPERIMENT_ONLY","合成项目制品只能发布到实验命名空间");
        for(String field:List.of("artifactDigest","featureSpaceVersion","catalogSnapshotId","inputDigest","codeDigest"))
            if(!body.path(field).asText().matches("[a-f0-9]{64}"))throw error(400,"INVALID_DIGEST",field);
        if(!body.path("projection").isObject()||!hash(body.path("projection").toString()).equals(body.path("featureSpaceVersion").asText()))
            throw error(400,"FEATURE_SPACE_DIGEST_MISMATCH","投影制品与特征空间摘要不一致");
        if(!body.path("artifactPath").asText().startsWith("hdfs://")&&!namespace.startsWith("experiment-"))
            throw error(400,"INVALID_ARTIFACT","生产模型需要闭合的 HDFS 制品");
        if(!body.path("validation").path("passed").asBoolean()||body.path("validation").path("users").asLong()<1
                ||!body.path("validation").path("selectedOn").asText().equals("validation"))
            throw error(409,"VALIDATION_REQUIRED","需要独立验证集上的实际选参与验证记录");
        scopes(body);
        var old=db.queryForList("SELECT descriptor_json FROM learning_models WHERE namespace=? AND model_version=?",namespace,version);
        if(!old.isEmpty()) {
            if(!canonical(parse((String)old.get(0).get("descriptor_json"))).toString().equals(canonical(body).toString()))
                throw error(409,"IDENTITY_CONFLICT","模型版本对应不同制品");
            return descriptor(namespace,version);
        }
        db.update("INSERT INTO learning_models VALUES(?,?,'validated',?,?,?)",namespace,version,body.toString(),body.path("validation").toString(),System.currentTimeMillis());
        db.update("INSERT IGNORE INTO learning_active VALUES(?,NULL,0,0)",namespace);
        return descriptor(namespace,version);
    }
    @Transactional public ObjectNode activate(JsonNode body, boolean rollback) {
        String namespace=id(body,"namespace"),version=id(body,"modelVersion");
        // Active pointer first, then subjects: all activation and generation publication use this order.
        var pointer=db.queryForMap("SELECT * FROM learning_active WHERE namespace=? FOR UPDATE",namespace);
        if(value(pointer,"revision")!=number(body,"expectedRevision",0))throw error(409,"MODEL_REVISION_CONFLICT","请刷新当前模型");
        var model=descriptor(namespace,version);scopes(model);
        String state=db.queryForObject("SELECT state FROM learning_models WHERE namespace=? AND model_version=?",String.class,namespace,version);
        if(!Set.of("validated","active","retired").contains(state))throw error(409,"VALIDATION_REQUIRED","模型未通过验证");
        if(rollback&&db.queryForObject("SELECT COUNT(*) FROM learning_model_events WHERE namespace=? AND model_version=?",Long.class,namespace,version)==0)
            throw error(409,"ROLLBACK_TARGET_REQUIRED","回退目标必须曾经发布");
        String reason=body.path("reason").asText("").trim();
        if(reason.isEmpty()||reason.length()>512)throw error(400,"REASON_REQUIRED","请填写发布或回退原因");
        long revision=value(pointer,"revision")+1,now=System.currentTimeMillis();
        db.update("UPDATE learning_models SET state='retired' WHERE namespace=? AND state='active'",namespace);
        db.update("UPDATE learning_models SET state='active' WHERE namespace=? AND model_version=?",namespace,version);
        db.update("UPDATE learning_active SET model_version=?,revision=?,updated_at=? WHERE namespace=?",version,revision,now,namespace);
        db.update("INSERT INTO learning_model_events VALUES(?,?,?,?,?,?,?,?)",UUID.randomUUID().toString(),namespace,version,rollback?"rollback":"publish",pointer.get("model_version"),revision,reason,now);
        if(namespace.equals("production"))
            for(var row:db.queryForList("SELECT subject_id,analysis_epoch FROM cloud_users WHERE analysis_enabled=TRUE ORDER BY subject_id FOR UPDATE"))
                requestInference(db,(String)row.get("subject_id"),value(row,"analysis_epoch"));
        return active(namespace);
    }
    public ObjectNode active(String namespace) {
        var rows=db.queryForList("SELECT * FROM learning_active WHERE namespace=?",namespace);
        ObjectNode result=object().put("namespace",namespace).put("state","pending").put("revision",0);
        if(rows.isEmpty())return result;
        var row=rows.get(0);result.put("revision",value(row,"revision"));
        if(row.get("model_version")!=null){result.put("state","active");result.set("model",descriptor(namespace,(String)row.get("model_version")));}
        return result;
    }

    /** Freeze only committed archives; each page is bounded and identified by a content digest. */
    @Transactional public ObjectNode inputs(String after, long through, int limit, boolean pendingOnly) {
        if(through==0)through=System.currentTimeMillis();
        if(limit<1||limit>100||through<1||through>System.currentTimeMillis())throw error(400,"INVALID_SNAPSHOT","无效的输入窗口");
        var users=db.queryForList("SELECT * FROM cloud_users u WHERE analysis_enabled=TRUE AND subject_id>? "+(pendingOnly?"AND EXISTS(SELECT 1 FROM learning_inference_queue q WHERE q.subject_id=u.subject_id AND q.state='queued') ":"")+"ORDER BY subject_id LIMIT ? FOR UPDATE",after,limit);
        ObjectNode result=object().put("referenceTime",through);ArrayNode items=result.putArray("items");
        String cursor=after;
        for(var row:users) {
            String subject=(String)row.get("subject_id");cursor=subject;long epoch=value(row,"analysis_epoch");
            var exports=db.queryForList("SELECT * FROM cloud_exports WHERE subject_id=? AND analysis_epoch=? AND state='committed' AND created_at<=? ORDER BY created_at,export_id",subject,epoch,through);
            if(exports.isEmpty())continue;
            ObjectNode input=object().put("subjectId",subject).put("analysisEpoch",epoch).put("revision",value(row,"revision")).put("referenceTime",through);
            ArrayNode archives=input.putArray("archives");TreeMap<String,Long> ranges=new TreeMap<>();long latest=-1;
            for(var archive:exports) {
                ObjectNode item=object().put("exportId",(String)archive.get("export_id")).put("revision",value(archive,"revision"));
                item.set("archive",parse((String)archive.get("archive_json")));archives.add(item);
                latest=Math.max(latest,value(archive,"revision"));
                for(JsonNode range:parse((String)archive.get("ranges_json")))ranges.merge(range.path("streamEpoch").asText(),range.path("lastSeq").asLong(),Math::max);
            }
            if(latest!=value(row,"revision"))continue; // preferences/collections must have reached Hadoop too
            ObjectNode progress=input.putObject("processedThrough");ranges.forEach(progress::put);
            var queued=db.queryForList("SELECT request_revision FROM learning_inference_queue WHERE subject_id=?",subject);
            input.put("requestRevision",queued.isEmpty()?0:value(queued.get(0),"request_revision"));
            var portraits=db.queryForList("SELECT generation_id,model_version,input_digest,created_at FROM learning_generations WHERE subject_id=? AND analysis_epoch=? AND state='published' ORDER BY created_at DESC LIMIT 1",subject,epoch);
            if(!portraits.isEmpty()) {
                var previous=portraits.get(0);input.set("derivedProfile",object().put("kind","derived_profile").put("subjectId",subject)
                        .put("modelVersion",(String)previous.get("model_version")).put("generationId",(String)previous.get("generation_id"))
                        .put("inputDigest",(String)previous.get("input_digest")).put("generatedAt",value(previous,"created_at")));
            }
            String inputId=hash(canonical(input).toString());input.put("inputId",inputId);
            db.update("INSERT IGNORE INTO learning_inputs VALUES(?,?,?,?,?,?,?)",inputId,subject,epoch,value(row,"revision"),through,input.toString(),System.currentTimeMillis());items.add(input);
        }
        result.put("nextAfter",cursor).put("hasMore",users.size()==limit);return result;
    }
    @Transactional public ObjectNode queue(JsonNode body) {
        String inputId=id(body,"inputId");var matches=db.queryForList("SELECT * FROM learning_inputs WHERE input_id=?",inputId);
        if(matches.isEmpty())return object().put("state","superseded");
        var frozen=matches.get(0);String subject=(String)frozen.get("subject_id");
        JsonNode input=parse((String)frozen.get("summary_json"));String state=body.path("state").asText();
        if(!Set.of("scheduled","failed").contains(state))throw error(400,"INVALID_STATE","需要 scheduled 或 failed");
        String message=body.path("error").asText("");if(message.length()>512)message=message.substring(0,512);
        int changed=db.update("UPDATE learning_inference_queue SET state=?,task_id=?,error_message=? WHERE subject_id=? AND analysis_epoch=? AND request_revision=? AND model_version=? AND state<>'succeeded'"+(state.equals("scheduled")?" AND state='queued'":""),
                state,id(body,"taskId"),message,subject,frozen.get("analysis_epoch"),input.path("requestRevision").asLong(),id(body,"modelVersion"));
        return object().put("state",changed==1?state:"superseded");
    }
    @Transactional public ObjectNode requeue() {
        for(var row:db.queryForList("SELECT subject_id,analysis_epoch FROM cloud_users WHERE analysis_enabled=TRUE ORDER BY subject_id FOR UPDATE"))requestInference(db,(String)row.get("subject_id"),value(row,"analysis_epoch"));
        return object().put("state","queued");
    }
    @Transactional public ObjectNode stage(JsonNode body) {
        String generation=id(body,"generationId"),subject=id(body,"subjectId"),inputId=id(body,"inputId");
        var frozen=db.queryForList("SELECT * FROM learning_inputs WHERE input_id=? AND subject_id=?",inputId,subject);
        if(frozen.isEmpty())throw error(409,"INPUT_NOT_FROZEN","需要服务端冻结的归档输入");
        var input=frozen.get(0);user(subject,value(input,"analysis_epoch"));
        ObjectNode summary=(ObjectNode)parse((String)input.get("summary_json"));
        if(number(body,"analysisEpoch",1)!=value(input,"analysis_epoch")||number(body,"referenceTime",1)!=value(input,"reference_time")
                ||!canonical(body.path("processedThrough")).toString().equals(canonical(summary.path("processedThrough")).toString())||!body.path("inputDigest").asText().matches("[a-f0-9]{64}"))
            throw error(409,"INPUT_MISMATCH","画像范围与冻结输入不一致");
        ObjectNode model=descriptor("production",id(body,"modelVersion"));
        for(String field:List.of("featureSpaceVersion","catalogSnapshotId"))
            if(!body.path(field).equals(model.path(field)))throw error(409,"MODEL_MISMATCH","画像制品版本不一致");
        if(!body.path("profile").isObject()||!body.path("searchPlan").isObject()||body.path("searchPlan").path("queries").size()>4)
            throw error(400,"INVALID_RESULT","需要画像和最多四条搜索方向");
        var old=db.queryForList("SELECT payload_json FROM learning_generations WHERE generation_id=?",generation);
        if(!old.isEmpty()) {
            if(!canonical(parse((String)old.get(0).get("payload_json"))).toString().equals(canonical(body).toString()))throw error(409,"IDENTITY_CONFLICT","画像代号对应不同结果");
        } else db.update("INSERT INTO learning_generations VALUES(?,?,?,?,?,?,?,'staged',?,?)",generation,subject,value(input,"analysis_epoch"),body.path("modelVersion").asText(),inputId,body.path("inputDigest").asText(),value(input,"reference_time"),body.toString(),System.currentTimeMillis());
        return object().put("generationId",generation).put("state","staged");
    }
    @Transactional public ObjectNode publish(String generation) {
        var pointer=db.queryForMap("SELECT * FROM learning_active WHERE namespace='production' FOR UPDATE");
        var row=db.queryForMap("SELECT * FROM learning_generations WHERE generation_id=?",generation);
        String subject=(String)row.get("subject_id");var current=user(subject,value(row,"analysis_epoch"));
        var input=db.queryForMap("SELECT * FROM learning_inputs WHERE input_id=?",row.get("input_id"));
        ObjectNode summary=(ObjectNode)parse((String)input.get("summary_json"));
        if(!Objects.equals(pointer.get("model_version"),row.get("model_version")))throw error(409,"MODEL_CHANGED","当前模型已更换，请重新推断");
        if(value(current,"revision")!=value(input,"input_revision"))throw error(409,"INPUT_CHANGED","集合或反馈已更新");
        var old=db.queryForList("SELECT g.* FROM learning_current c JOIN learning_generations g ON c.generation_id=g.generation_id WHERE c.subject_id=?",subject);
        if(!old.isEmpty()&&value(old.get(0),"reference_time")>value(row,"reference_time"))throw error(409,"OLDER_GENERATION","迟到结果不能覆盖较新结果");
        for(var stream:db.queryForList("SELECT stream_epoch,processed_through FROM cloud_streams WHERE subject_id=? AND analysis_epoch=? AND processed_through>0",subject,row.get("analysis_epoch")))
            if(summary.path("processedThrough").path((String)stream.get("stream_epoch")).asLong()<value(stream,"processed_through"))throw error(409,"PROGRESS_CONFLICT","较旧的输入缺少已处理的设备进度");
        Iterator<Map.Entry<String,JsonNode>> ranges=summary.path("processedThrough").fields();
        while(ranges.hasNext()) {
            var range=ranges.next();var streams=db.queryForList("SELECT * FROM cloud_streams WHERE stream_epoch=? AND subject_id=? AND analysis_epoch=?",range.getKey(),subject,row.get("analysis_epoch"));
            if(streams.isEmpty()||value(streams.get(0),"exported_through")<range.getValue().asLong()||value(streams.get(0),"processed_through")>range.getValue().asLong())
                throw error(409,"PROGRESS_CONFLICT","画像处理进度不能越过归档或倒退");
        }
        if(row.get("state").equals("invalidated"))throw error(409,"STALE_ANALYSIS_EPOCH","画像范围已清理");
        db.update("INSERT INTO learning_current VALUES(?,?) ON DUPLICATE KEY UPDATE generation_id=VALUES(generation_id)",subject,generation);
        db.update("UPDATE learning_generations SET state='published' WHERE generation_id=?",generation);
        summary.path("processedThrough").fields().forEachRemaining(range->db.update("UPDATE cloud_streams SET processed_through=? WHERE stream_epoch=?",range.getValue().asLong(),range.getKey()));
        db.update("UPDATE learning_inference_queue SET state='succeeded' WHERE subject_id=? AND request_revision=?",subject,summary.path("requestRevision").asLong());
        return object().put("state","published").put("generationId",generation);
    }
    @Transactional public ObjectNode portrait(String authorization, boolean search) {
        var session=auth.session(authorization);String subject=(String)session.get("subject_id");
        var current=db.queryForMap("SELECT * FROM cloud_users WHERE subject_id=? FOR UPDATE",subject);
        ObjectNode response=object().put("subjectId",subject).put("analysisEpoch",value(current,"analysis_epoch"));
        if(!enabled(current))return response.put("state","disabled").put("status","analysis_disabled");
        var rows=db.queryForList("SELECT g.*,i.input_revision FROM learning_current c JOIN learning_generations g ON g.generation_id=c.generation_id JOIN learning_inputs i ON i.input_id=g.input_id WHERE c.subject_id=? AND g.analysis_epoch=? AND g.state='published'",subject,current.get("analysis_epoch"));
        if(rows.isEmpty())return response.put("state","pending").put("status","pending");
        var row=rows.get(0);ObjectNode payload=(ObjectNode)parse((String)row.get("payload_json"));
        String active=active("production").path("model").path("modelVersion").asText();
        long pending=db.queryForObject("SELECT COUNT(*) FROM cloud_streams WHERE subject_id=? AND analysis_epoch=? AND accepted_through>processed_through",Long.class,subject,current.get("analysis_epoch"));
        boolean stale=!row.get("model_version").equals(active)||value(row,"input_revision")!=value(current,"revision")||pending>0;
        boolean empty=payload.path("profile").path("vector").path("indices").isEmpty();
        payload.put("state",stale?"stale":empty?"no_evidence":"current").put("status",stale?"stale":empty?"empty":"ready");
        if(!search)return payload;
        ObjectNode plan=payload.path("searchPlan").isObject()?((ObjectNode)payload.path("searchPlan")).deepCopy():object();
        for(String field:List.of("subjectId","analysisEpoch","state","status","generationId","modelVersion","featureSpaceVersion","catalogSnapshotId","referenceTime","generatedAt","processedThrough"))plan.set(field,payload.path(field));
        return plan;
    }
    public ObjectNode projection(String version) {
        return projection("production",version);
    }
    public ObjectNode projection(String namespace,String version) {
        ObjectNode model=descriptor(namespace,version),response=object();
        response.put("modelVersion",version).put("featureSpaceVersion",model.path("featureSpaceVersion").asText());
        response.set("projection",model.path("projection"));return response;
    }
    public ObjectNode featureSpace(String version) {
        var rows=db.queryForList("SELECT descriptor_json FROM learning_models WHERE namespace='production' AND JSON_UNQUOTE(JSON_EXTRACT(descriptor_json,'$.featureSpaceVersion'))=? ORDER BY created_at DESC LIMIT 1",version);
        if(rows.isEmpty())throw error(404,"FEATURE_SPACE_NOT_FOUND","特征空间不存在");
        return (ObjectNode)parse((String)rows.get(0).get("descriptor_json")).path("projection");
    }
    public ObjectNode cohorts() {
        // Reaggregate only currently authorized results; removed scopes never remain in cached totals.
        TreeMap<String,Double> languages=new TreeMap<>(),topics=new TreeMap<>();long count=0,generatedAt=0,referenceTime=0;
        ArrayNode generations=JSON.createArrayNode();
        for(var row:db.queryForList("SELECT g.payload_json FROM learning_current c JOIN learning_generations g ON g.generation_id=c.generation_id JOIN cloud_users u ON u.subject_id=c.subject_id JOIN learning_active a ON a.namespace='production' AND a.model_version=g.model_version WHERE u.analysis_enabled=TRUE AND u.analysis_epoch=g.analysis_epoch AND g.state='published' ORDER BY c.subject_id")) {
            JsonNode payload=parse((String)row.get("payload_json")),profile=payload.path("profile");count++;
            generations.add(payload.path("generationId").asText());generatedAt=Math.max(generatedAt,payload.path("generatedAt").asLong());referenceTime=Math.max(referenceTime,payload.path("referenceTime").asLong());
            profile.path("languages").fields().forEachRemaining(e->languages.merge(e.getKey(),e.getValue().asDouble(),Double::sum));
            profile.path("topics").fields().forEachRemaining(e->topics.merge(e.getKey(),e.getValue().asDouble(),Double::sum));
        }
        ObjectNode response=object().put("memberCount",count).put("suppressed",count<10).put("computedAt",System.currentTimeMillis()).put("source","published_authorized_portraits");
        if(count>=10){response.set("languages",distribution(languages));response.set("topics",distribution(topics));}
        response.put("modelVersion",active("production").path("model").path("modelVersion").asText()).put("generationId","cohorts-"+hash(generations.toString()).substring(0,24))
                .put("sourceKind","real_production").put("totalSubjects",count).put("referenceTime",referenceTime).put("generatedAt",generatedAt);
        ObjectNode cohort=response.putArray("cohorts").addObject().put("cohortId","published-users").put("label","已发布画像用户").put("memberCount",count).put("suppressed",count<10);
        cohort.set("languages",count>=10?response.path("languages"):object());cohort.set("topics",count>=10?response.path("topics"):object());
        return response;
    }
    private ObjectNode distribution(Map<String,Double> values) {
        ObjectNode result=object();double total=values.values().stream().mapToDouble(Double::doubleValue).sum();
        if(total>0)values.forEach((key,value)->result.put(key,value/total));return result;
    }
    public ObjectNode status() {
        ObjectNode result=object();result.set("active",active("production"));
        ArrayNode models=result.putArray("models");
        for(var row:db.queryForList("SELECT * FROM learning_models ORDER BY created_at DESC LIMIT 100")) {
            ObjectNode item=(ObjectNode)parse((String)row.get("descriptor_json"));item.remove("projection");item.put("state",(String)row.get("state"));models.add(item);
        }
        result.set("queue",JSON.valueToTree(db.queryForList("SELECT * FROM learning_inference_queue ORDER BY requested_at DESC LIMIT 100")));
        result.set("history",JSON.valueToTree(db.queryForList("SELECT * FROM learning_model_events ORDER BY created_at DESC LIMIT 100")));
        result.set("pointers",JSON.valueToTree(db.queryForList("SELECT * FROM learning_active ORDER BY namespace")));
        result.put("derivedProfiles",db.queryForObject("SELECT COUNT(*) FROM learning_generations WHERE payload_json IS NOT NULL",Long.class));
        result.put("newEvents",db.queryForObject("SELECT COUNT(*) FROM cloud_events e JOIN cloud_users u ON u.subject_id=e.subject_id AND u.analysis_epoch=e.analysis_epoch WHERE u.analysis_enabled=TRUE AND e.payload_json IS NOT NULL",Long.class));
        return result;
    }
}
