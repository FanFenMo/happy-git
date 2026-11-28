package com.happygit.server.cloud;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.nio.file.*;
import java.text.Normalizer;
import java.util.*;
import java.util.regex.*;
import static com.happygit.server.cloud.CloudJson.*;
import static com.happygit.server.cloud.CloudIngestService.*;

/** Transactional model and personal generation pointers. Artifact bodies stay in Hadoop. */
@Service @Profile("cloud")
public class CloudLearningService {
    private static final int VECTOR_DIMENSION = 8192;
    private static final double MS_PER_DAY = 86_400_000.0;
    private static final Pattern TOKEN_PATTERN = Pattern.compile("c\\+\\+|c#|\\.net|node\\.js|[a-z0-9]+|[\\u4e00-\\u9fff]{2,}");
    private static final Set<String> STOP_WORDS = Set.of(
            "the", "a", "an", "and", "or", "to", "of", "for", "in", "is", "with", "this", "that",
            "from", "using", "used", "based", "build", "built", "simple", "fast", "easy", "open",
            "source", "project", "library", "tool", "tools", "framework", "github", "http", "https",
            "www", "com", "org", "io", "readme", "license", "mit", "apache", "repo", "install",
            "example", "examples", "demo", "documentation", "docs", "code", "repository", "repositories",
            "img", "png", "svg", "jpg", "未标注"
    );

    private final JdbcTemplate db;
    private final CloudAuthService auth;
    private final String centersPath;
    private volatile long cachedCentersMtime = -1L;
    private volatile List<JsonNode> cachedCenters = List.of();

    public CloudLearningService(JdbcTemplate db, CloudAuthService auth) {
        this(db, auth, "");
    }

    @Autowired
    public CloudLearningService(JdbcTemplate db, CloudAuthService auth,
            @Value("${happygit.cloud.centers-path:/var/lib/happygit/active-model-centers.json}") String centersPath) {
        this.db = db;
        this.auth = auth;
        this.centersPath = centersPath == null ? "" : centersPath.trim();
    }

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
        if(!Set.of("scheduled","failed","cancelled").contains(state))throw error(400,"INVALID_STATE","需要 scheduled、failed 或 cancelled");
        String message=body.path("error").asText("");if(message.length()>512)message=message.substring(0,512);
        int changed=db.update("UPDATE learning_inference_queue SET state=?,task_id=?,error_message=? WHERE subject_id=? AND analysis_epoch=? AND request_revision=? AND model_version=? AND state<>'succeeded'"+(state.equals("scheduled")?" AND state IN ('queued','failed','cancelled')":""),
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
        var queue=db.queryForList("SELECT state,request_revision FROM learning_inference_queue WHERE subject_id=? FOR UPDATE",subject);
        if(!queue.isEmpty()&&queue.get(0).get("state").equals("cancelled")&&value(queue.get(0),"request_revision")==summary.path("requestRevision").asLong())throw error(409,"INFERENCE_CANCELLED","本次推断已取消");
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
        boolean empty=payload.path("profile").path("vector").path("indices").isEmpty()
                && payload.path("profile").path("languages").isEmpty()
                && payload.path("profile").path("topics").isEmpty();
        payload.put("state",stale?"stale":empty?"no_evidence":"current").put("status",stale?"stale":empty?"empty":"ready");
        if(!search)return payload;
        ObjectNode plan=payload.path("searchPlan").isObject()?((ObjectNode)payload.path("searchPlan")).deepCopy():object();
        for(String field:List.of("subjectId","analysisEpoch","state","status","generationId","modelVersion","featureSpaceVersion","catalogSnapshotId","referenceTime","generatedAt","processedThrough"))plan.set(field,payload.path(field));
        return plan;
    }

    @Transactional
    public ObjectNode computePortrait(String authorization, JsonNode body) {
        var session = auth.session(authorization);
        String subject = (String) session.get("subject_id");
        var current = db.queryForMap("SELECT * FROM cloud_users WHERE subject_id=? FOR UPDATE", subject);
        long epoch = value(current, "analysis_epoch");
        long revision = value(current, "revision");
        if (!enabled(current)) {
            return object().put("subjectId", subject).put("analysisEpoch", epoch)
                    .put("state", "disabled").put("status", "analysis_disabled");
        }

        ObjectNode activeModel = active("production");
        ObjectNode model = activeModel.path("model").isObject() ? (ObjectNode) activeModel.path("model") : object();
        String modelVersion = model.path("modelVersion").asText("");
        if (modelVersion.isEmpty()) modelVersion = "online-fallback-v1";
        String featureSpaceVersion = model.path("featureSpaceVersion").asText("");
        String catalogSnapshotId = model.path("catalogSnapshotId").asText("");
        JsonNode projection = model.path("projection");
        JsonNode dictionary = projection.path("dictionary");
        JsonNode blockWeights = projection.path("blockWeights");
        double langScale = Math.sqrt(blockWeights.path("language").asDouble(0.20));
        double topicScale = Math.sqrt(blockWeights.path("topic").asDouble(0.30));
        double textScale = Math.sqrt(blockWeights.path("text").asDouble(0.50));

        JsonNode req = body == null || body.isNull() ? object() : body;
        ObjectNode userPrefs = (ObjectNode) parse((String) current.get("preferences_json"));
        Set<String> hiddenSet = new HashSet<>();
        for (JsonNode item : userPrefs.path("hiddenRepoIds")) {
            String v = item.asText("").trim().toLowerCase(Locale.ROOT);
            if (!v.isEmpty()) hiddenSet.add(v);
        }
        for (JsonNode item : req.path("hiddenRepoIds")) {
            String v = item.asText("").trim().toLowerCase(Locale.ROOT);
            if (!v.isEmpty()) hiddenSet.add(v);
        }

        List<String> manualTags = new ArrayList<>();
        Set<String> seenManual = new LinkedHashSet<>();
        for (JsonNode sourceArray : List.of(req.path("manualTags"), userPrefs.path("manualTags"))) {
            if (!sourceArray.isArray()) continue;
            for (JsonNode item : sourceArray) {
                String tag = item.asText("").trim();
                String norm = tag.toLowerCase(Locale.ROOT);
                if (!norm.isEmpty() && seenManual.add(norm)) manualTags.add(tag);
            }
        }

        long now = System.currentTimeMillis();
        Map<String, RepoEvidence> evidenceMap = new LinkedHashMap<>();
        Set<String> ownedIds = new TreeSet<>();
        for (JsonNode repo : req.path("starred")) {
            addRepoEvidence(evidenceMap, hiddenSet, repo, 3.0, "star", null);
        }
        for (JsonNode repo : req.path("owned")) {
            String id = repo.path("repoId").asText(repo.path("canonicalKey").asText("")).trim();
            if (!id.isEmpty()) ownedIds.add(id);
            addRepoEvidence(evidenceMap, hiddenSet, repo, 1.5, "owned", null);
        }
        boolean historyEnabled = req.path("historyEnabled").asBoolean(true);
        int browseEventCount = 0;
        if (historyEnabled) {
            for (JsonNode item : req.path("history")) {
                JsonNode repo = item.path("repository").isObject() ? item.path("repository") : item;
                long visits = Math.max(1L, item.path("visitCount").asLong(1L));
                long viewedAt = item.path("lastViewedAt").asLong(item.path("occurredAt").asLong(now));
                double days = Math.max(0.0, (now - viewedAt) / MS_PER_DAY);
                double histWeight = Math.min(1.0 + Math.log(visits), 3.0) * Math.pow(2.0, -days / 30.0);
                if (addRepoEvidence(evidenceMap, hiddenSet, repo, histWeight, "browse", viewedAt)) {
                    browseEventCount++;
                }
            }
        }

        Map<String, Double> languageScores = new TreeMap<>();
        Map<String, Double> topicScores = new TreeMap<>();
        Map<String, KeywordScore> keywordScores = new LinkedHashMap<>();
        Map<String, List<String>> topicEvidenceRepos = new LinkedHashMap<>();
        double[] userVector = new double[VECTOR_DIMENSION];
        boolean hasDictionary = dictionary.isObject() && dictionary.path("language").isObject();
        int missingFeatureEvents = 0;

        for (RepoEvidence ev : evidenceMap.values()) {
            JsonNode repo = ev.repo;
            String repoDisplay = ev.fullName.isEmpty() ? ev.key : ev.fullName;
            String lang = repo.path("primaryLanguage").asText("").trim();
            if (!lang.isEmpty() && !"未标注".equals(lang)) {
                languageScores.merge(lang, ev.weight, Double::sum);
                addKeywordScore(keywordScores, lang, ev.weight * 0.65, "language", ev.fullName);
            }
            Set<String> repoTopics = new LinkedHashSet<>();
            for (JsonNode topicNode : repo.path("topics")) {
                String cleanTopic = topicNode.asText("").trim().toLowerCase(Locale.ROOT);
                if (!cleanTopic.isEmpty() && repoTopics.add(cleanTopic)) {
                    topicScores.merge(cleanTopic, ev.weight, Double::sum);
                    addKeywordScore(keywordScores, cleanTopic, ev.weight * 0.85, "topic", ev.fullName);
                    topicEvidenceRepos.computeIfAbsent(cleanTopic, k -> new ArrayList<>());
                    List<String> list = topicEvidenceRepos.get(cleanTopic);
                    if (list.size() < 5 && !list.contains(repoDisplay)) list.add(repoDisplay);
                }
            }

            Map<String, Long> termCounts = new TreeMap<>();
            countTokens(termCounts, repo.path("name").asText(""), 2);
            countTokens(termCounts, repo.path("description").asText(""), 2);
            for (String topic : repoTopics) countTokens(termCounts, topic, 2);
            for (Map.Entry<String, Long> tc : termCounts.entrySet()) {
                double tf = 1.0 + Math.log(tc.getValue());
                addKeywordScore(keywordScores, tc.getKey(), ev.weight * 0.35 * tf, "text", ev.fullName);
            }

            if (hasDictionary) {
                double[] repoVec = new double[VECTOR_DIMENSION];
                boolean matchedAny = false;
                if (!lang.isEmpty() && dictionary.path("language").has(lang) && dictionary.path("language").path(lang).isInt()) {
                    repoVec[dictionary.path("language").path(lang).asInt()] = langScale;
                    matchedAny = true;
                }
                Map<Integer, Double> topicBlock = new TreeMap<>();
                for (String t : repoTopics) {
                    JsonNode idx = dictionary.path("topic").path(t);
                    if (idx.isInt()) {
                        topicBlock.put(idx.asInt(), 1.0);
                        matchedAny = true;
                    }
                }
                addScaledBlock(repoVec, topicBlock, topicScale);
                Map<Integer, Double> textBlock = new TreeMap<>();
                for (Map.Entry<String, Long> tc : termCounts.entrySet()) {
                    JsonNode feat = dictionary.path("text").path(tc.getKey());
                    if (feat.isObject() && tc.getValue() > 0) {
                        double val = (1.0 + Math.log(tc.getValue())) * feat.path("idf").asDouble(1.0);
                        textBlock.put(feat.path("index").asInt(), val);
                        matchedAny = true;
                    }
                }
                addScaledBlock(repoVec, textBlock, textScale);
                if (!matchedAny) missingFeatureEvents++;
                for (int i = 0; i < VECTOR_DIMENSION; i++) {
                    if (repoVec[i] > 0) userVector[i] += ev.weight * repoVec[i];
                }
            }
        }

        for (String tag : manualTags) {
            String clean = tag.trim().toLowerCase(Locale.ROOT);
            if (clean.isEmpty()) continue;
            topicScores.merge(clean, 4.0, Double::sum);
            addKeywordScore(keywordScores, tag.trim(), 4.0, "manual", "");
            if (hasDictionary) {
                JsonNode topicIdx = dictionary.path("topic").path(clean);
                if (topicIdx.isInt()) userVector[topicIdx.asInt()] += 4.0 * topicScale;
                for (String tok : tokenize(clean)) {
                    JsonNode feat = dictionary.path("text").path(tok);
                    if (feat.isObject()) {
                        userVector[feat.path("index").asInt()] += 4.0 * feat.path("idf").asDouble(1.0) * textScale;
                    }
                }
            }
        }

        ObjectNode normalizedVector = normalizeVector(userVector, 512);
        ObjectNode languagesDist = normalizedDistribution(languageScores);
        ObjectNode topicsDist = normalizedDistribution(topicScores);

        // 基于关键词或主题补足 topInterests，防止仓库缺少 topics 时画像出现空标签
        List<Map.Entry<String, Double>> sortedTopics = new ArrayList<>(topicScores.entrySet());
        sortedTopics.sort((a, b) -> Double.compare(b.getValue(), a.getValue()));
        ArrayNode topInterests = JSON.createArrayNode();
        Set<String> seenInterests = new HashSet<>();
        double maxTopicWeight = sortedTopics.isEmpty() ? 1.0 : Math.max(1e-9, sortedTopics.get(0).getValue());
        for (Map.Entry<String, Double> entry : sortedTopics) {
            if (topInterests.size() >= 10) break;
            seenInterests.add(entry.getKey().toLowerCase(Locale.ROOT));
            ObjectNode ti = topInterests.addObject();
            ti.put("tag", entry.getKey());
            ti.put("score", round4(entry.getValue() / maxTopicWeight));
            ArrayNode evList = ti.putArray("evidenceRepos");
            for (String rn : topicEvidenceRepos.getOrDefault(entry.getKey(), List.of())) evList.add(rn);
        }

        List<KeywordScore> sortedKeywords = new ArrayList<>(keywordScores.values());
        sortedKeywords.sort((a, b) -> Double.compare(b.weight, a.weight));
        double maxKwWeight = sortedKeywords.isEmpty() ? 1.0 : Math.max(1e-9, sortedKeywords.get(0).weight);
        ArrayNode keywordsArray = JSON.createArrayNode();
        for (int i = 0; i < Math.min(14, sortedKeywords.size()); i++) {
            KeywordScore kw = sortedKeywords.get(i);
            ArrayNode row = keywordsArray.addArray();
            row.add(kw.label).add(round4(kw.weight)).add(kw.source);
            if (topInterests.size() < 8 && seenInterests.add(kw.canonical)) {
                ObjectNode ti = topInterests.addObject();
                ti.put("tag", kw.label);
                ti.put("score", round4(kw.weight / maxKwWeight));
                ArrayNode evList = ti.putArray("evidenceRepos");
                for (String rn : kw.repos) evList.add(rn);
            }
        }

        // 匹配真实训练的 K-means 聚类中心，结合向量余弦与语言/标签辅助相似度
        List<JsonNode> centers = loadActiveCenters(modelVersion);
        List<CenterMatch> matches = new ArrayList<>();
        for (JsonNode center : centers) {
            if (center.path("members").asLong(0) == 0) continue;
            double vecSim = sparseDot(normalizedVector, center.path("vector"));
            double metaSim = metadataAffinity(languagesDist, topicsDist, keywordScores, center);
            double score = vecSim > 0 ? (0.75 * vecSim + 0.25 * metaSim) : metaSim * 0.6;
            if (score > 0.01) {
                matches.add(new CenterMatch(center, score));
            }
        }
        matches.sort((a, b) -> Double.compare(b.score, a.score));
        if (matches.size() > 4) matches = new ArrayList<>(matches.subList(0, 4));

        ArrayNode directions = JSON.createArrayNode();
        double totalMatchSq = matches.stream().mapToDouble(m -> m.score * m.score).sum();
        if (totalMatchSq > 0) {
            for (CenterMatch m : matches) {
                double weight = (m.score * m.score) / totalMatchSq;
                ObjectNode dir = directions.addObject();
                String centerId = m.center.path("centerId").asText("direction");
                ArrayNode dirTopics = topMapKeys(m.center.path("topics"), 3);
                ArrayNode dirLangs = topMapKeys(m.center.path("languages"), 2);
                dir.put("directionId", centerId);
                dir.put("label", describeDirectionLabel(centerId, dirLangs, dirTopics));
                dir.put("weight", round4(weight));
                dir.put("similarity", round4(m.score));
                dir.set("topics", dirTopics);
                dir.set("languages", dirLangs);
                ArrayNode kwList = dir.putArray("keywords");
                for (JsonNode k : m.center.path("keywords")) {
                    String kwText = k.asText("").trim().toLowerCase(Locale.ROOT);
                    if (!kwText.isEmpty() && !STOP_WORDS.contains(kwText)) kwList.add(k.asText());
                }
                dir.set("evidenceRepos", collectDirectionEvidence(evidenceMap, dirLangs, dirTopics));
            }
        } else if (!evidenceMap.isEmpty() || !manualTags.isEmpty()) {
            // 若无可用中心文件或暂无匹配中心，则按用户最强语言/标签聚类构造可追溯方向
            for (Map.Entry<String, Double> langEntry : topDistributionEntries(languagesDist, 3)) {
                ObjectNode dir = directions.addObject();
                String langName = langEntry.getKey();
                dir.put("directionId", "local-lang-" + langName.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "-"));
                dir.put("label", langName + " 生态探索");
                dir.put("weight", round4(langEntry.getValue()));
                dir.putArray("languages").add(langName);
                ArrayNode dirTopics = dir.putArray("topics");
                for (JsonNode ti : topInterests) {
                    if (dirTopics.size() >= 3) break;
                    dirTopics.add(ti.path("tag").asText());
                }
                dir.set("evidenceRepos", collectDirectionEvidence(evidenceMap, dir.path("languages"), dirTopics));
            }
        }

        List<RepoEvidence> sortedEvidence = new ArrayList<>(evidenceMap.values());
        sortedEvidence.sort((a, b) -> Double.compare(b.weight, a.weight));
        ArrayNode evidenceArray = JSON.createArrayNode();
        for (int i = 0; i < Math.min(16, sortedEvidence.size()); i++) {
            RepoEvidence ev = sortedEvidence.get(i);
            ObjectNode item = evidenceArray.addObject();
            if (!ev.repoId.isEmpty()) item.put("repoId", ev.repoId);
            if (!ev.canonicalKey.isEmpty()) item.put("canonicalKey", ev.canonicalKey);
            item.put("fullName", ev.fullName.isEmpty() ? ev.key : ev.fullName);
            if (!ev.htmlUrl.isEmpty()) item.put("htmlUrl", ev.htmlUrl);
            if (!ev.primaryLanguage.isEmpty()) item.put("primaryLanguage", ev.primaryLanguage);
            if (ev.starCount >= 0) item.put("starCount", ev.starCount);
            item.put("weight", round4(ev.weight));
            ArrayNode srcArr = item.putArray("sources");
            for (String s : ev.sources) srcArr.add(s);
            ArrayNode tArr = item.putArray("topics");
            for (JsonNode t : ev.repo.path("topics")) tArr.add(t.asText());
        }

        ObjectNode profileNode = object();
        profileNode.put("subjectId", subject);
        profileNode.put("modelVersion", modelVersion);
        profileNode.set("vector", normalizedVector);
        profileNode.set("languages", languagesDist);
        profileNode.set("topics", topicsDist);
        profileNode.set("directions", directions);
        profileNode.set("topInterests", topInterests);
        profileNode.set("keywords", keywordsArray);
        profileNode.set("evidenceRepos", evidenceArray);
        profileNode.set("manualTags", JSON.valueToTree(manualTags));

        ObjectNode searchPlan = buildOnlineSearchPlan(directions, languagesDist, topInterests, hiddenSet, ownedIds);

        ObjectNode processedMap = object();
        for (var stream : db.queryForList(
                "SELECT stream_epoch, accepted_through FROM cloud_streams WHERE subject_id=? AND analysis_epoch=?",
                subject, epoch)) {
            long acc = value(stream, "accepted_through");
            String streamId = (String) stream.get("stream_epoch");
            processedMap.put(streamId, acc);
            db.update("UPDATE cloud_streams SET processed_through=? WHERE stream_epoch=?", acc, streamId);
        }

        String inputSeed = subject + ":" + epoch + ":" + revision + ":" + now + ":" + evidenceMap.size() + ":" + manualTags.size();
        String inputId = hash("input:" + inputSeed);
        String inputDigest = hash("digest:" + inputId + ":" + modelVersion);
        String generationId = "gen-live-" + hash(inputId + ":" + UUID.randomUUID()).substring(0, 24);

        searchPlan.put("generationId", generationId)
                .put("modelVersion", modelVersion)
                .put("featureSpaceVersion", featureSpaceVersion)
                .put("catalogSnapshotId", catalogSnapshotId)
                .put("referenceTime", now);

        ObjectNode payload = object()
                .put("subjectId", subject)
                .put("analysisEpoch", epoch)
                .put("inputId", inputId)
                .put("generationId", generationId)
                .put("modelVersion", modelVersion)
                .put("featureSpaceVersion", featureSpaceVersion)
                .put("catalogSnapshotId", catalogSnapshotId)
                .put("referenceTime", now)
                .put("generatedAt", now)
                .put("inputDigest", inputDigest);
        payload.set("processedThrough", processedMap);
        payload.putObject("inputVersions").put("revision", revision).put("analysisEpoch", epoch);
        payload.putObject("coverage")
                .put("evidenceRepositories", evidenceMap.size())
                .put("browseEvents", browseEventCount)
                .put("missingFeatureEvents", missingFeatureEvents);
        payload.set("profile", profileNode);
        payload.set("searchPlan", searchPlan);

        boolean hasEvidence = !evidenceMap.isEmpty() || !manualTags.isEmpty();
        ObjectNode summary = object()
                .put("subjectId", subject)
                .put("analysisEpoch", epoch)
                .put("revision", revision)
                .put("referenceTime", now)
                .put("requestRevision", 0);
        summary.set("processedThrough", processedMap);

        db.update("INSERT IGNORE INTO learning_inputs(input_id,subject_id,analysis_epoch,input_revision,reference_time,summary_json,created_at) VALUES(?,?,?,?,?,?,?)",
                inputId, subject, epoch, revision, now, summary.toString(), now);
        db.update("INSERT INTO learning_generations(generation_id,subject_id,analysis_epoch,model_version,input_id,input_digest,reference_time,state,payload_json,created_at) VALUES(?,?,?,?,?,?,?,'published',?,?)",
                generationId, subject, epoch, modelVersion, inputId, inputDigest, now, payload.toString(), now);
        db.update("INSERT INTO learning_current(subject_id,generation_id) VALUES(?,?) ON DUPLICATE KEY UPDATE generation_id=VALUES(generation_id)",
                subject, generationId);
        db.update("INSERT INTO learning_inference_queue(subject_id,analysis_epoch,request_revision,model_version,state,requested_at,task_id,error_message) "
                + "VALUES(?,?,1,?,'succeeded',?,?,NULL) ON DUPLICATE KEY UPDATE analysis_epoch=VALUES(analysis_epoch),"
                + "request_revision=request_revision+1,model_version=VALUES(model_version),state='succeeded',requested_at=VALUES(requested_at),error_message=NULL",
                subject, epoch, modelVersion, now, generationId);

        ObjectNode response = payload.deepCopy();
        response.put("state", hasEvidence ? "current" : "no_evidence");
        response.put("status", hasEvidence ? "ready" : "empty");
        return response;
    }

    private List<JsonNode> loadActiveCenters(String expectedModelVersion) {
        if (centersPath.isEmpty()) return List.of();
        try {
            Path path = Path.of(centersPath);
            if (!Files.isRegularFile(path)) return List.of();
            long mtime = Files.getLastModifiedTime(path).toMillis();
            if (mtime != cachedCentersMtime) {
                JsonNode root = JSON.readTree(Files.readString(path));
                List<JsonNode> list = new ArrayList<>();
                for (JsonNode c : root.path("centers")) list.add(c);
                cachedCenters = list;
                cachedCentersMtime = mtime;
            }
            return cachedCenters;
        } catch (Exception ignored) {
            return List.of();
        }
    }

    private static boolean addRepoEvidence(Map<String, RepoEvidence> map, Set<String> hiddenSet, JsonNode repo,
            double weight, String source, Long observedAt) {
        if (repo == null || !repo.isObject()) return false;
        String vis = repo.path("visibility").asText("");
        if ("private".equalsIgnoreCase(vis) || repo.path("private").asBoolean(false)) return false;
        String repoId = repo.path("repoId").asText(repo.path("id").asText("")).trim();
        String fullName = repo.path("fullName").asText(repo.path("full_name").asText("")).trim();
        String canonicalKey = repo.path("canonicalKey").asText(fullName).trim().toLowerCase(Locale.ROOT);
        if (canonicalKey.isEmpty() && repoId.isEmpty()) return false;
        if ((!repoId.isEmpty() && hiddenSet.contains(repoId.toLowerCase(Locale.ROOT)))
                || (!canonicalKey.isEmpty() && hiddenSet.contains(canonicalKey))) {
            return false;
        }
        String key = !canonicalKey.isEmpty() ? canonicalKey : repoId;
        RepoEvidence existing = map.get(key);
        if (existing == null) {
            String htmlUrl = repo.path("htmlUrl").asText(fullName.isEmpty() ? "" : "https://github.com/" + fullName);
            String lang = repo.path("primaryLanguage").asText(repo.path("language").asText("")).trim();
            long stars = repo.has("starCount") && repo.path("starCount").isNumber() ? repo.path("starCount").asLong() : -1L;
            existing = new RepoEvidence(key, repoId, canonicalKey, fullName, htmlUrl, lang, stars, repo);
            map.put(key, existing);
        }
        existing.weight += weight;
        existing.sources.add(source);
        if (observedAt != null && observedAt > existing.latestAt) existing.latestAt = observedAt;
        return true;
    }

    private static void addKeywordScore(Map<String, KeywordScore> map, String label, double weight, String source, String repoName) {
        if (label == null || weight <= 0) return;
        String trimmed = label.trim();
        String canonical = Normalizer.normalize(trimmed, Normalizer.Form.NFKC).toLowerCase(Locale.ROOT);
        if (canonical.length() < 2 || STOP_WORDS.contains(canonical)) return;
        KeywordScore ks = map.get(canonical);
        if (ks == null) {
            ks = new KeywordScore(canonical, trimmed, source);
            map.put(canonical, ks);
        } else if (!ks.source.equals(source)) {
            ks.source = "mixed";
        }
        ks.weight += weight;
        if (!repoName.isEmpty() && ks.repos.size() < 4) ks.repos.add(repoName);
    }

    private static List<String> tokenize(String text) {
        String clean = Normalizer.normalize(text == null ? "" : text, Normalizer.Form.NFKC).toLowerCase(Locale.ROOT);
        List<String> result = new ArrayList<>();
        Matcher matcher = TOKEN_PATTERN.matcher(clean);
        while (matcher.find()) {
            String term = matcher.group();
            if (term.matches("[\\u4e00-\\u9fff]+")) {
                for (int i = 0; i + 1 < term.length(); i++) result.add(term.substring(i, i + 2));
            } else if (!STOP_WORDS.contains(term) && term.length() >= 2) {
                result.add(term);
            }
        }
        return result;
    }

    private static void countTokens(Map<String, Long> counts, String text, long weight) {
        for (String term : tokenize(text)) counts.merge(term, weight, Long::sum);
    }

    private static void addScaledBlock(double[] sum, Map<Integer, Double> block, double scale) {
        double norm = Math.sqrt(block.values().stream().mapToDouble(v -> v * v).sum());
        if (norm > 0) {
            block.forEach((index, value) -> {
                if (index >= 0 && index < VECTOR_DIMENSION) sum[index] += scale * value / norm;
            });
        }
    }

    private static ObjectNode normalizeVector(double[] sum, int limit) {
        List<Integer> coords = new ArrayList<>();
        for (int i = 0; i < sum.length; i++) {
            if (sum[i] > 0 && Double.isFinite(sum[i])) coords.add(i);
        }
        coords.sort((a, b) -> {
            int cmp = Double.compare(sum[b], sum[a]);
            return cmp != 0 ? cmp : Integer.compare(a, b);
        });
        if (coords.size() > limit) coords = new ArrayList<>(coords.subList(0, limit));
        coords.sort(Integer::compare);
        double sq = 0;
        for (int idx : coords) sq += sum[idx] * sum[idx];
        ObjectNode vec = object().put("dimension", VECTOR_DIMENSION);
        ArrayNode indices = vec.putArray("indices");
        ArrayNode values = vec.putArray("values");
        if (sq > 0) {
            double norm = Math.sqrt(sq);
            for (int idx : coords) {
                indices.add(idx);
                values.add(round4(sum[idx] / norm));
            }
        }
        return vec;
    }

    private static double sparseDot(JsonNode a, JsonNode b) {
        JsonNode ai = a.path("indices"), av = a.path("values");
        JsonNode bi = b.path("indices"), bv = b.path("values");
        int i = 0, j = 0;
        double sum = 0;
        while (i < ai.size() && j < bi.size()) {
            int x = ai.get(i).asInt(), y = bi.get(j).asInt();
            if (x == y) sum += av.get(i++).asDouble() * bv.get(j++).asDouble();
            else if (x < y) i++;
            else j++;
        }
        return Math.max(0.0, Math.min(1.0, sum));
    }

    private static double metadataAffinity(ObjectNode userLangs, ObjectNode userTopics,
            Map<String, KeywordScore> keywords, JsonNode center) {
        double score = 0;
        JsonNode cLangs = center.path("languages");
        Iterator<Map.Entry<String, JsonNode>> li = userLangs.fields();
        while (li.hasNext()) {
            var e = li.next();
            if (cLangs.has(e.getKey())) {
                score += Math.sqrt(e.getValue().asDouble() * cLangs.path(e.getKey()).asDouble());
            }
        }
        JsonNode cTopics = center.path("topics");
        Iterator<Map.Entry<String, JsonNode>> ti = userTopics.fields();
        while (ti.hasNext()) {
            var e = ti.next();
            if (cTopics.has(e.getKey())) {
                score += 1.2 * Math.sqrt(e.getValue().asDouble() * cTopics.path(e.getKey()).asDouble());
            }
        }
        for (JsonNode kw : center.path("keywords")) {
            String k = kw.asText("").trim().toLowerCase(Locale.ROOT);
            if (!k.isEmpty() && keywords.containsKey(k)) score += 0.08;
        }
        return Math.min(1.0, score);
    }

    private static ObjectNode normalizedDistribution(Map<String, Double> raw) {
        ObjectNode out = object();
        double total = raw.values().stream().mapToDouble(Double::doubleValue).sum();
        if (total <= 0) return out;
        List<Map.Entry<String, Double>> sorted = new ArrayList<>(raw.entrySet());
        sorted.sort((a, b) -> Double.compare(b.getValue(), a.getValue()));
        for (Map.Entry<String, Double> e : sorted) {
            out.put(e.getKey(), round4(e.getValue() / total));
        }
        return out;
    }

    private static ArrayNode topMapKeys(JsonNode obj, int limit) {
        List<Map.Entry<String, JsonNode>> entries = new ArrayList<>();
        obj.fields().forEachRemaining(entries::add);
        entries.sort((a, b) -> Double.compare(b.getValue().asDouble(), a.getValue().asDouble()));
        ArrayNode arr = JSON.createArrayNode();
        for (int i = 0; i < Math.min(limit, entries.size()); i++) arr.add(entries.get(i).getKey());
        return arr;
    }

    private static List<Map.Entry<String, Double>> topDistributionEntries(ObjectNode obj, int limit) {
        List<Map.Entry<String, Double>> entries = new ArrayList<>();
        obj.fields().forEachRemaining(e -> entries.add(Map.entry(e.getKey(), e.getValue().asDouble())));
        entries.sort((a, b) -> Double.compare(b.getValue(), a.getValue()));
        return entries.size() > limit ? entries.subList(0, limit) : entries;
    }

    private static String describeDirectionLabel(String centerId, ArrayNode langs, ArrayNode topics) {
        List<String> parts = new ArrayList<>();
        if (langs.size() > 0) parts.add(langs.get(0).asText());
        if (topics.size() > 0) parts.add(topics.get(0).asText());
        if (!parts.isEmpty()) return String.join(" · ", parts) + " 方向";
        return centerId;
    }

    private static ArrayNode collectDirectionEvidence(Map<String, RepoEvidence> evidenceMap,
            JsonNode dirLangs, JsonNode dirTopics) {
        Set<String> langs = new HashSet<>();
        for (JsonNode l : dirLangs) langs.add(l.asText("").toLowerCase(Locale.ROOT));
        Set<String> topics = new HashSet<>();
        for (JsonNode t : dirTopics) topics.add(t.asText("").toLowerCase(Locale.ROOT));
        List<RepoEvidence> matched = new ArrayList<>();
        for (RepoEvidence ev : evidenceMap.values()) {
            boolean hit = !ev.primaryLanguage.isEmpty() && langs.contains(ev.primaryLanguage.toLowerCase(Locale.ROOT));
            if (!hit) {
                for (JsonNode t : ev.repo.path("topics")) {
                    if (topics.contains(t.asText("").toLowerCase(Locale.ROOT))) {
                        hit = true;
                        break;
                    }
                }
            }
            if (hit) matched.add(ev);
        }
        if (matched.isEmpty()) matched.addAll(evidenceMap.values());
        matched.sort((a, b) -> Double.compare(b.weight, a.weight));
        ArrayNode arr = JSON.createArrayNode();
        for (int i = 0; i < Math.min(5, matched.size()); i++) {
            RepoEvidence ev = matched.get(i);
            arr.add(ev.fullName.isEmpty() ? ev.key : ev.fullName);
        }
        return arr;
    }

    private static ObjectNode buildOnlineSearchPlan(ArrayNode directions, ObjectNode languages,
            ArrayNode topInterests, Set<String> hiddenSet, Set<String> ownedIds) {
        ObjectNode plan = object().put("maxQueries", 4).put("maxPages", 8);
        ArrayNode queries = plan.putArray("queries");
        Set<String> excludeIds = new TreeSet<>(ownedIds);
        excludeIds.addAll(hiddenSet);
        Set<String> unique = new HashSet<>();
        for (JsonNode dir : directions) {
            ObjectNode q = object()
                    .put("id", "dir_" + dir.path("directionId").asText("q"))
                    .put("directionId", dir.path("directionId").asText(""))
                    .put("language", dir.path("languages").path(0).asText(""))
                    .put("sort", "updated")
                    .put("pages", 2);
            q.set("topics", dir.path("topics"));
            q.set("keywords", dir.path("keywords"));
            q.putObject("exclude").set("repoIds", JSON.valueToTree(excludeIds));
            if (unique.add(q.path("language").asText() + "|" + q.path("topics").toString())) {
                queries.add(q);
            }
            if (queries.size() >= 4) break;
        }
        if (queries.isEmpty() && (languages.size() > 0 || topInterests.size() > 0)) {
            ObjectNode q = queries.addObject()
                    .put("id", "dir_primary")
                    .put("language", topMapKeys(languages, 1).path(0).asText(""))
                    .put("sort", "stars")
                    .put("pages", 2);
            ArrayNode tArr = q.putArray("topics");
            for (int i = 0; i < Math.min(3, topInterests.size()); i++) {
                tArr.add(topInterests.get(i).path("tag").asText());
            }
            q.putArray("keywords");
            q.putObject("exclude").set("repoIds", JSON.valueToTree(excludeIds));
        }
        return plan;
    }

    private static double round4(double v) {
        return Math.round(v * 10000.0) / 10000.0;
    }

    private static final class RepoEvidence {
        final String key, repoId, canonicalKey, fullName, htmlUrl, primaryLanguage;
        final long starCount;
        final JsonNode repo;
        final Set<String> sources = new LinkedHashSet<>();
        double weight = 0;
        long latestAt = 0;
        RepoEvidence(String key, String repoId, String canonicalKey, String fullName, String htmlUrl,
                String primaryLanguage, long starCount, JsonNode repo) {
            this.key = key;
            this.repoId = repoId;
            this.canonicalKey = canonicalKey;
            this.fullName = fullName;
            this.htmlUrl = htmlUrl;
            this.primaryLanguage = primaryLanguage;
            this.starCount = starCount;
            this.repo = repo;
        }
    }

    private static final class KeywordScore {
        final String canonical, label;
        String source;
        double weight = 0;
        final List<String> repos = new ArrayList<>();
        KeywordScore(String canonical, String label, String source) {
            this.canonical = canonical;
            this.label = label;
            this.source = source;
        }
    }

    private static final class CenterMatch {
        final JsonNode center;
        final double score;
        CenterMatch(JsonNode center, double score) {
            this.center = center;
            this.score = score;
        }
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
        result.putObject("runtime").put("releaseId",System.getenv().getOrDefault("HG_RELEASE_ID","unversioned")).put("sourceCommit",System.getenv().getOrDefault("HG_SOURCE_COMMIT","unknown"))
                .put("nodeConfigSha256",System.getenv().getOrDefault("HG_NODE_CONFIG_SHA256","unknown")).put("javaVersion",System.getProperty("java.version"));
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
