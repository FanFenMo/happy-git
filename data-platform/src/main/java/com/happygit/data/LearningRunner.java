package com.happygit.data;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import org.apache.hadoop.conf.Configuration;
import org.apache.hadoop.fs.Path;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Worker and operator entry points; all long jobs retain the existing task lease. */
final class LearningRunner {
    private LearningRunner() {}
    static String submit(TaskStore store,ObjectNode request) throws Exception {
        Json.requireId(request.path("namespace").asText());
        if(!request.path("dataset").path("sha256").asText().matches("[a-f0-9]{64}"))throw new IllegalArgumentException("A frozen dataset descriptor is required");
        String identity=Json.sha256(Json.bytes(request));
        return store.enqueue("learning-train",request.path("namespace").asText(),"model",request,identity);
    }
    static ObjectNode train(Configuration conf,ObjectNode request,String destination,LearningPipeline.Progress progress) throws Exception {
        ObjectNode dataset=LearningFiles.verified(conf,(ObjectNode)request.path("dataset"));
        if(!dataset.path("namespace").equals(request.path("namespace")))throw new IllegalArgumentException("Dataset namespace mismatch");
        boolean register=request.path("registerModel").asBoolean(request.path("namespace").asText().equals("production"));
        CloudArchiveClient cloud=register||!dataset.path("scopes").isEmpty()?new CloudArchiveClient():null;
        if(cloud!=null)cloud.control("check-scopes",Json.object().set("scopes",dataset.path("scopes")));
        ObjectNode result=new LearningPipeline(conf).train(request,destination,progress);
        if(cloud!=null)cloud.control("check-scopes",Json.object().set("scopes",dataset.path("scopes")));
        if(register)cloud.control("models",result);return result;
    }
    static ObjectNode infer(Configuration conf,ObjectNode task,String destination) throws Exception {
        ObjectNode request=(ObjectNode)task.path("input"),model=(ObjectNode)request.path("model"),input=(ObjectNode)request.path("input");
        CloudArchiveClient cloud=new CloudArchiveClient();
        ObjectNode scope=Json.object().put("subjectId",input.path("subjectId").asText()).put("analysisEpoch",input.path("analysisEpoch").asLong()).put("revision",input.path("revision").asLong());
        ObjectNode check=Json.object();check.putArray("scopes").add(scope);cloud.control("check-scopes",check);
        ObjectNode artifact=new LearningPipeline(conf).load(model);
        ObjectNode manifest=Json.object().put("namespace","production").put("datasetKind","real").put("referenceTime",input.path("referenceTime").asLong());
        ArrayNode files=manifest.putArray("files");files.add(artifact.path("catalog"));for(JsonNode archive:input.path("archives"))files.add(archive.path("archive"));
        ObjectNode result=new LearningPipeline(conf).infer(manifest,model,destination);
        final ObjectNode[] profile={null};HdfsFiles.forEachJsonLine(conf,new Path(result.path("profiles").asText()),row->{
            if(profile[0]!=null||!row.path("subjectId").equals(input.path("subjectId")))throw new IllegalArgumentException("Inference block subject mismatch");profile[0]=row;
        });
        if(profile[0]==null)throw new IllegalArgumentException("Frozen input has no subject seed");
        String generation="generation-"+Json.sha256((task.path("id").asText()+"\n"+task.path("token").asText()).getBytes(StandardCharsets.UTF_8)).substring(0,32);
        ObjectNode payload=Json.object().put("subjectId",input.path("subjectId").asText()).put("analysisEpoch",input.path("analysisEpoch").asLong())
                .put("inputId",input.path("inputId").asText()).put("generationId",generation).put("modelVersion",model.path("modelVersion").asText())
                .put("featureSpaceVersion",artifact.path("featureSpaceVersion").asText()).put("catalogSnapshotId",artifact.path("catalogSnapshotId").asText())
                .put("referenceTime",input.path("referenceTime").asLong()).put("generatedAt",result.path("completedAt").asLong())
                .put("inputDigest",Json.sha256((input.toString()+"\n"+model.path("artifactDigest").asText()).getBytes(StandardCharsets.UTF_8)));
        payload.set("processedThrough",input.path("processedThrough"));payload.putObject("inputVersions").put("revision",input.path("revision").asLong()).put("analysisEpoch",input.path("analysisEpoch").asLong());
        payload.putObject("coverage").put("evidenceRepositories",profile[0].path("evidenceCount").asLong()).put("browseEvents",profile[0].path("browseEventCount").asLong()).put("missingFeatureEvents",profile[0].path("missingFeatureEventCount").asLong());
        payload.set("profile",profile[0]);ObjectNode plan=Portraits.searchPlan(profile[0]);
        for(String field:Arrays.asList("generationId","modelVersion","featureSpaceVersion","catalogSnapshotId","referenceTime"))plan.set(field,payload.path(field));payload.set("searchPlan",plan);
        ObjectNode saved=LearningFiles.write(conf,new Path(destination,"generation.json"),payload);
        cloud.control("generations",payload);cloud.control("generations/"+generation+"/publish",Json.object());
        saved.put("generationId",generation).put("state","published").put("subjectId",input.path("subjectId").asText());return saved;
    }
    static ObjectNode schedule(TaskStore store) throws Exception {
        CloudArchiveClient cloud=new CloudArchiveClient();ObjectNode active=cloud.active("production");
        if(!active.path("state").asText().equals("active"))return Json.object().put("state","pending_model").put("enqueued",0);
        ObjectNode model=((ObjectNode)active.path("model")).deepCopy();model.remove(Arrays.asList("projection","scopes","sourceCounts","validation"));
        int enqueued=0;String after="";long through=0;boolean more;
        do {
            ObjectNode page=cloud.inputs(after,through,true);through=page.path("referenceTime").asLong();
            for(JsonNode input:page.path("items")) {
                ObjectNode request=Json.object();request.set("model",model);request.set("input",input);
                String id=store.enqueue("learning-infer","production",input.path("subjectId").asText(),request,input.path("inputId").asText()+"-"+model.path("modelVersion").asText());
                cloud.control("queue",Json.object().put("inputId",input.path("inputId").asText()).put("modelVersion",model.path("modelVersion").asText()).put("taskId",id).put("state","scheduled"));enqueued++;
            }
            after=page.path("nextAfter").asText();more=page.path("hasMore").asBoolean();
        }while(more);
        return Json.object().put("state","scheduled").put("modelVersion",model.path("modelVersion").asText()).put("enqueued",enqueued);
    }
    static ObjectNode batch(TaskStore store,Configuration conf,String root,ObjectNode config) throws Exception {
        String namespace=Json.requireId(config.path("namespace").asText("production"));
        long every=config.path("trainEveryHours").asLong(24)*3600000L;
        if(every<3600000)throw new IllegalArgumentException("Scheduled training interval must be at least one hour");
        ObjectNode previous=store.observation("learning-batch-"+namespace);long now=System.currentTimeMillis();
        if(previous!=null&&now-previous.path("enqueuedAt").asLong()<every)return Json.object().put("state","waiting_interval");
        String attempt=UUID.randomUUID().toString();CloudArchiveClient cloud=config.path("includeCloud").asBoolean(true)?new CloudArchiveClient():null;
        ObjectNode snapshot=LearningDataset.prepare(conf,java.nio.file.Path.of(config.path("datasetManifest").asText()),namespace,new Path(root+"/learning/"+namespace+"/datasets/"+attempt),cloud);
        ObjectNode dataset=LearningFiles.verified(conf,snapshot);long current=0;Iterator<Map.Entry<String,JsonNode>> counts=dataset.path("counts").fields();
        while(counts.hasNext()){var entry=counts.next();if(entry.getKey().endsWith("_cloud_event"))current+=entry.getValue().asLong();}
        if(previous!=null&&current-previous.path("cloudEvents").asLong()<config.path("minNewEvents").asLong(100))return Json.object().put("state","waiting_data").put("cloudEvents",current);
        ObjectNode request=config.path("training").isObject()?((ObjectNode)config.path("training")).deepCopy():Json.object();request.put("namespace",namespace);request.set("dataset",snapshot);
        String task=submit(store,request);store.observe("learning-batch-"+namespace,Json.object().put("enqueuedAt",now).put("cloudEvents",current).put("taskId",task).put("datasetVersion",dataset.path("datasetVersion").asText()));
        return Json.object().put("state","queued").put("taskId",task).set("dataset",snapshot);
    }
}
