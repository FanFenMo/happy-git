package com.happygit.data;

import com.fasterxml.jackson.databind.node.*;
import org.apache.hadoop.conf.Configuration;
import org.apache.hadoop.fs.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Files;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class LearningLoopIntegrationTest {
    @TempDir java.nio.file.Path temporaryDirectory;
    private java.nio.file.Path directory;

    private ObjectNode writeRows(Configuration conf,java.nio.file.Path file,List<ObjectNode> rows) throws Exception {
        Files.createDirectories(file.getParent());StringBuilder content=new StringBuilder();
        for(ObjectNode row:rows)content.append(row).append('\n');
        Files.writeString(file,content.toString());return LearningFiles.describe(conf,new Path(file.toUri()));
    }
    private ObjectNode event(String subject,String id,String repo,long at) {
        return Json.object().put("kind","event").put("subjectId",subject).put("eventId",id).put("repoId",repo).put("occurredAt",at).put("source","browse").put("sourceKind","synthetic_llm");
    }
    @Test void frozenTrainingInferenceAndNativeFeedbackProduceTraceableModelVersions() throws Exception {
        String retainedDirectory=System.getenv("HG_TEST_LEARNING_DIRECTORY");
        directory=retainedDirectory==null?temporaryDirectory:Files.createDirectories(java.nio.file.Path.of(retainedDirectory));
        Configuration conf=new Configuration();conf.set("fs.defaultFS","file:///");conf.set("mapreduce.framework.name","local");conf.setInt("hg.reducers",1);
        long now=System.currentTimeMillis();List<ObjectNode> repositories=new ArrayList<>(),subjects=new ArrayList<>(),events=new ArrayList<>(),splits=new ArrayList<>();
        for(int i=0;i<2;i++) {
            ObjectNode repo=Json.object().put("kind","repository").put("repoId",i==0?"23418517":"123").put("name",i==0?"database":"inference")
                    .put("fullName",i==0?"fixture/database":"fixture/inference").put("primaryLanguage",i==0?"Java":"Rust").put("description",i==0?"database storage engine":"inference neural transformer")
                    .put("visibility","public").put("observedAt",now-86400000).put("sourceKind","synthetic_fixture");
            repo.putArray("topics").add(i==0?"database":"machine-learning");repositories.add(repo);
        }
        for(String subject:Arrays.asList("train-java","train-rust","validation-java","test-rust")) {
            subjects.add(Json.object().put("kind","subject").put("subjectId",subject).put("sourceKind","synthetic_llm"));
            splits.add(Json.object().put("subjectId",subject).put("split",subject.startsWith("train")?"train":subject.startsWith("validation")?"validation":"test"));
            String repo=subject.endsWith("java")?"23418517":"123";
            events.add(event(subject,subject+"-context",repo,now-14L*86400000));events.add(event(subject,subject+"-future",repo,now-86400000));
        }
        ObjectNode source=Json.object().put("catalogMode","synthetic_fixture").put("datasetVersion","integration-initial").put("referenceTime",now);
        ArrayNode files=source.putArray("files");java.nio.file.Path input=directory.resolve("input");
        for(var part:Map.of("repositories",repositories,"subjects",subjects,"events",events,"collections",Collections.<ObjectNode>emptyList()).entrySet()) {
            ObjectNode descriptor=writeRows(conf,input.resolve("canonical/"+part.getKey()+".jsonl"),part.getValue());descriptor.put("path","canonical/"+part.getKey()+".jsonl");files.add(descriptor);
        }
        ObjectNode splitFile=writeRows(conf,input.resolve("splits/subjects.jsonl"),splits);splitFile.put("path","splits/subjects.jsonl");files.add(splitFile);
        java.nio.file.Path sourceFile=input.resolve("manifest.json");Files.writeString(sourceFile,source.toString());
        ObjectNode first=LearningDataset.prepare(conf,sourceFile,"experiment-integration",new Path(directory.resolve("snapshot-1").toUri()),null);
        ObjectNode request=Json.object().put("namespace","experiment-integration").put("seed",17).put("maxIterations",2);
        request.set("dataset",first);request.putArray("centerCounts").add(2);request.putArray("directionBlends").add(.25);
        request.putArray("behaviors").addObject().put("browseHalfLifeDays",30).put("starWeight",3).put("ownedWeight",1.5);
        LearningPipeline pipeline=new LearningPipeline(conf);ObjectNode model=pipeline.train(request,directory.resolve("model-1").toUri().toString(),(phase,detail)->{});
        ObjectNode artifact=pipeline.load(model);assertTrue(model.path("validation").path("passed").asBoolean());assertFalse(model.path("validation").path("testUsed").asBoolean());
        String immutableDigest=LearningFiles.describe(conf,new Path(model.path("artifactPath").asText())).path("sha256").asText();
        ObjectNode dataset=LearningFiles.verified(conf,first),inference=pipeline.infer(LearningDataset.pipelineManifest(dataset,"test"),model,directory.resolve("inference-1").toUri().toString());
        List<ObjectNode> profiles=HdfsFiles.readJsonLines(conf,new Path(inference.path("profiles").asText()));
        assertEquals(1,profiles.size());assertEquals("test-rust",profiles.get(0).path("subjectId").asText());assertFalse(profiles.get(0).path("directions").isEmpty());
        assertEquals(model.path("modelVersion"),profiles.get(0).path("modelVersion"));
        assertEquals(immutableDigest,LearningFiles.describe(conf,new Path(model.path("artifactPath").asText())).path("sha256").asText());
        String nativeEvents=System.getenv("HG_TEST_CLIENT_EVENTS");
        List<ObjectNode> feedback=nativeEvents==null?Collections.singletonList(event("train-java","new-browse","123",now-1000)):HdfsFiles.readJsonLines(conf,new Path(java.nio.file.Path.of(nativeEvents).toUri()));
        Set<String> known=new HashSet<>();for(ObjectNode subject:subjects)known.add(subject.path("subjectId").asText());
        for(ObjectNode row:feedback) {
            String subject=row.path("subjectId").asText();assertFalse(subject.startsWith("test"));
            if(known.add(subject)){subjects.add(Json.object().put("kind","subject").put("subjectId",subject).put("sourceKind",row.path("sourceKind").asText()));splits.add(Json.object().put("subjectId",subject).put("split","train"));}
            events.add(row);
        }
        files.removeAll();
        for(var part:Map.of("repositories",repositories,"subjects",subjects,"events",events,"collections",Collections.<ObjectNode>emptyList()).entrySet()) {
            ObjectNode descriptor=writeRows(conf,input.resolve("canonical/"+part.getKey()+".jsonl"),part.getValue());descriptor.put("path","canonical/"+part.getKey()+".jsonl");files.add(descriptor);
        }
        splitFile=writeRows(conf,input.resolve("splits/subjects.jsonl"),splits);splitFile.put("path","splits/subjects.jsonl");files.add(splitFile);Files.writeString(sourceFile,source.toString());
        ObjectNode second=LearningDataset.prepare(conf,sourceFile,"experiment-integration",new Path(directory.resolve("snapshot-2").toUri()),null);request.set("dataset",second);
        ObjectNode next=pipeline.train(request,directory.resolve("model-2").toUri().toString(),(phase,detail)->{});
        assertNotEquals(artifact.path("centers"),pipeline.load(next).path("centers"));
        assertNotEquals(model.path("modelVersion"),next.path("modelVersion"));assertNotEquals(model.path("artifactDigest"),next.path("artifactDigest"));
        assertNotEquals(model.path("datasetVersion"),next.path("datasetVersion"));assertEquals(model.path("featureSpaceVersion"),next.path("featureSpaceVersion"));
        ObjectNode inferred=pipeline.infer(LearningDataset.pipelineManifest(LearningFiles.verified(conf,second),"test"),next,directory.resolve("inference-2").toUri().toString());
        assertEquals("test-rust",HdfsFiles.readJsonLines(conf,new Path(inferred.path("profiles").asText())).get(0).path("subjectId").asText());
        String summary=System.getenv("HG_TEST_LEARNING_OUTPUT");
        if(summary!=null) {
            ObjectNode report=Json.object().put("nativeFeedback",nativeEvents!=null).put("feedbackEvents",feedback.size()).put("testUsedForTraining",false).put("immutableInference",true);
            report.set("initialModel",model);report.set("nextModel",next);report.set("initialCenters",artifact.path("centers"));report.set("nextCenters",pipeline.load(next).path("centers"));
            Files.writeString(java.nio.file.Path.of(summary),report.toString());
        }
    }
    @Test void modelExportBaselinePreservesCollectionsWhenBehaviorDiffersFromFixedRules() throws Exception {
        Configuration conf=new Configuration();conf.set("fs.defaultFS","file:///");conf.set("mapreduce.framework.name","local");conf.setInt("hg.reducers",1);
        long now=System.currentTimeMillis();
        ObjectNode repo=Json.object().put("kind","repository").put("repoId","23418517").put("name","database").put("fullName","fixture/database")
                .put("primaryLanguage","Java").put("description","database storage engine").put("visibility","public").put("observedAt",now-86400000).put("sourceKind","synthetic_fixture");
        repo.putArray("topics").add("database");
        List<ObjectNode> subjects=Arrays.asList(
                Json.object().put("kind","subject").put("subjectId","train-1").put("sourceKind","synthetic_llm"),
                Json.object().put("kind","subject").put("subjectId","val-1").put("sourceKind","synthetic_llm"),
                Json.object().put("kind","subject").put("subjectId","test-star-only").put("sourceKind","synthetic_llm"));
        List<ObjectNode> splits=Arrays.asList(
                Json.object().put("subjectId","train-1").put("split","train"),
                Json.object().put("subjectId","val-1").put("split","validation"),
                Json.object().put("subjectId","test-star-only").put("split","test"));
        List<ObjectNode> events=Arrays.asList(
                event("train-1","t1","23418517",now-14L*86400000),
                event("val-1","v1","23418517",now-14L*86400000),
                event("val-1","v2","23418517",now-86400000));
        ObjectNode starCollection=Json.object().put("kind","collection").put("subjectId","test-star-only").put("collectionKind","stars")
                .put("complete",true).put("revision",1).put("observedAt",now-3600000).put("sourceKind","synthetic_llm");
        starCollection.putArray("repoIds").add("23418517");
        ObjectNode source=Json.object().put("catalogMode","synthetic_fixture").put("datasetVersion","export-ref-time-test").put("referenceTime",now);
        ArrayNode files=source.putArray("files");java.nio.file.Path input=temporaryDirectory.resolve("export-input");
        for(var part:Map.of("repositories",Collections.singletonList(repo),"subjects",subjects,"events",events,"collections",Collections.singletonList(starCollection)).entrySet()) {
            ObjectNode descriptor=writeRows(conf,input.resolve("canonical/"+part.getKey()+".jsonl"),part.getValue());descriptor.put("path","canonical/"+part.getKey()+".jsonl");files.add(descriptor);
        }
        ObjectNode splitFile=writeRows(conf,input.resolve("splits/subjects.jsonl"),splits);splitFile.put("path","splits/subjects.jsonl");files.add(splitFile);
        java.nio.file.Path sourceFile=input.resolve("manifest.json");Files.writeString(sourceFile,source.toString());
        ObjectNode dataset=LearningDataset.prepare(conf,sourceFile,"experiment-export-ref",new Path(temporaryDirectory.resolve("export-snapshot").toUri()),null);
        ObjectNode request=Json.object().put("namespace","experiment-export-ref").put("seed",17).put("maxIterations",2);
        request.set("dataset",dataset);request.putArray("centerCounts").add(1);request.putArray("directionBlends").add(0.0);
        // Deliberately differ from fixed baseline (30, 3, 1.5) to exercise ModelExport's separate baseline branch.
        request.putArray("behaviors").addObject().put("browseHalfLifeDays",60).put("starWeight",2).put("ownedWeight",1.5);
        ObjectNode model=new LearningPipeline(conf).train(request,temporaryDirectory.resolve("export-model").toUri().toString(),(phase,detail)->{});
        ObjectNode protocol=Json.object().put("split","test").put("mode","both").put("userBlocks",1);protocol.set("dataset",dataset);protocol.set("model",model);
        java.nio.file.Path localOut=temporaryDirectory.resolve("export-local");
        ObjectNode report=ModelExport.run(conf,protocol,temporaryDirectory.resolve("export-hdfs").toUri().toString(),localOut);
        assertEquals("completed",report.path("state").asText());
        List<ObjectNode> baselineRows=HdfsFiles.readJsonLines(conf,new Path(localOut.resolve("baseline.jsonl").toUri()));
        assertEquals(1,baselineRows.size());
        assertEquals("ready",baselineRows.get(0).path("status").asText(),"star-only user must not lose collections in baseline export");
        assertTrue(baselineRows.get(0).path("evidenceRepos").toString().contains("23418517"));
    }
}
