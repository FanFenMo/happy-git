package com.happygit.data;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import org.apache.hadoop.conf.Configuration;
import org.apache.hadoop.fs.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;

/** A frozen, file-oriented boundary for independent evaluation; it never changes active pointers. */
final class ModelExport {
    private ModelExport() {}
    static ObjectNode run(Configuration configuration,ObjectNode protocol,String destination,java.nio.file.Path local) throws Exception {
        Configuration conf=new Configuration(configuration);Path root=new Path(destination);FileSystem fs=root.getFileSystem(conf);
        if(fs.exists(root)||Files.exists(local))throw new IllegalArgumentException("Use new Hadoop and local export directories");
        ObjectNode dataset=LearningFiles.verified(conf,(ObjectNode)protocol.path("dataset"));
        CloudArchiveClient cloud=dataset.path("scopes").isEmpty()?null:new CloudArchiveClient();
        if(cloud!=null)cloud.control("check-scopes",Json.object().set("scopes",dataset.path("scopes")));
        String split=protocol.path("split").asText("test"),mode=protocol.path("mode").asText("both");
        if(!Arrays.asList("train","validation","test").contains(split)||!Arrays.asList("baseline","learned","both").contains(mode))throw new IllegalArgumentException("Unknown split or export mode");
        if(protocol.has("referenceTime")&&protocol.path("referenceTime").asLong()!=dataset.path("referenceTime").asLong())throw new IllegalArgumentException("Export referenceTime must match the frozen dataset");
        int blocks=protocol.path("userBlocks").asInt(1);if(blocks<1||blocks>64)throw new IllegalArgumentException("Use 1..64 stable user blocks");
        Set<String> requested=new TreeSet<>();for(JsonNode subject:protocol.path("subjectIds"))requested.add(Json.requireId(subject.asText()));
        ObjectNode model=(ObjectNode)protocol.path("model"),artifact=new LearningPipeline(conf).load(model);
        if(!dataset.path("catalogSnapshotId").equals(artifact.path("catalogSnapshotId")))throw new IllegalArgumentException("Evaluation catalog must match the model catalog");
        Files.createDirectories(local);fs.mkdirs(root);RunJournal.use(conf,root);
        LearningFiles.write(conf,new Path(root,"protocol.json"),protocol);
        String digest=Json.sha256(Json.bytes(protocol));long started=System.currentTimeMillis();
        ObjectNode report=Json.object().put("schemaVersion","1.0.0").put("state","running").put("protocolDigest",digest).put("split",split).put("mode",mode)
                .put("datasetVersion",dataset.path("datasetVersion").asText()).put("referenceTime",dataset.path("referenceTime").asLong())
                .put("catalogSnapshotId",artifact.path("catalogSnapshotId").asText()).put("featureSpaceVersion",artifact.path("featureSpaceVersion").asText())
                .put("modelVersion",artifact.path("modelVersion").asText()).put("codeDigest",LearningFiles.codeDigest()).put("framework",conf.get("mapreduce.framework.name","local"))
                .put("userBlocks",blocks).put("startedAt",started).put("testUsedForFit",false).put("vectorDimension",Vectors.DIMENSION);
        report.set("datasetCounts",dataset.path("counts"));report.putObject("selectedEvidenceCounts");report.set("requestedSubjects",Json.MAPPER.valueToTree(requested));report.set("model",model);
        report.putObject("predictionCounts");report.put("repositoryMaxCoordinates",256).put("profileMaxCoordinates",512);
        ObjectNode outputFiles=report.putObject("files");ArrayNode blockRecords=report.putArray("blocks");
        Map<String,BufferedWriter> writers=new TreeMap<>();Set<String> found=new TreeSet<>();
        try {
            for(String method:Arrays.asList("baseline","learned"))if(mode.equals("both")||mode.equals(method))writers.put(method,Files.newBufferedWriter(local.resolve(method+".jsonl"),StandardCharsets.UTF_8));
            for(int block=0;block<blocks;block++) {
                RunGuard.check(conf);Path blockRoot=new Path(root,"block-"+block),raw=new Path(blockRoot,"evidence.jsonl");fs.mkdirs(blockRoot);
                final int bucket=block;final long[] records={0},subjects={0};
                try(FSDataOutputStream out=fs.create(raw,false)) {
                    for(JsonNode descriptor:dataset.path("splits").path(split)) {
                        if(!LearningFiles.describe(conf,new Path(descriptor.path("path").asText())).path("sha256").equals(descriptor.path("sha256")))throw new IllegalArgumentException("Frozen split digest mismatch");
                        HdfsFiles.forEachJsonLine(conf,new Path(descriptor.path("path").asText()),row->{
                            String subject=Json.requireId(row.path("subjectId").asText());
                            if((!requested.isEmpty()&&!requested.contains(subject))||Integer.parseInt(Json.sha256(subject.getBytes(StandardCharsets.UTF_8)).substring(0,6),16)%blocks!=bucket)return;
                            out.write((row.toString()+"\n").getBytes(StandardCharsets.UTF_8));records[0]++;
                            ObjectNode counts=(ObjectNode)report.path("selectedEvidenceCounts");String count=row.path("sourceKind").asText("unspecified")+"_"+row.path("kind").asText();counts.put(count,counts.path(count).asLong()+1);
                            if(row.path("kind").asText().equals("subject")&&found.add(subject))subjects[0]++;
                        });
                    }
                    out.hsync();
                }
                ObjectNode blockRecord=blockRecords.addObject().put("block",block).put("inputRows",records[0]).put("subjects",subjects[0]);
                if(subjects[0]==0){blockRecord.put("state","empty");continue;}
                ObjectNode manifest=Json.object().put("namespace",dataset.path("namespace").asText()).put("referenceTime",dataset.path("referenceTime").asLong()).put("datasetKind",dataset.path("datasetKind").asText());
                manifest.putArray("files").add(artifact.path("catalog")).add(LearningFiles.describe(conf,raw));
                ObjectNode inferred=null;
                if(writers.containsKey("learned")) {
                    inferred=new LearningPipeline(conf).infer(manifest,model,new Path(blockRoot,"learned").toString());
                    exportRows(conf,new Path(inferred.path("profiles").asText()),writers.get("learned"),"learned_model",artifact.path("modelVersion").asText(),report);
                }
                if(writers.containsKey("baseline")) {
                    JsonNode behavior=artifact.path("config").path("behavior");Path profiles;
                    if(inferred!=null&&behavior.path("browseHalfLifeDays").asDouble()==30&&behavior.path("starWeight").asDouble()==3&&behavior.path("ownedWeight").asDouble()==1.5)profiles=new Path(inferred.path("baseline").asText());
                    else {
                        Configuration baseline=new Configuration(conf);LearningPipeline.applyBehavior(baseline,Json.object().put("browseHalfLifeDays",30).put("starWeight",3).put("ownedWeight",1.5));
                        Path space=new Path(blockRoot,"baseline-space.json");LearningFiles.write(baseline,space,(ObjectNode)artifact.path("projection").path("dictionary"));
                        ObjectNode normalized=new LearningPipeline(baseline).normalize(baseline,manifest,new Path(blockRoot,"baseline-input"));
                        ObjectNode result=LearningFiles.verified(baseline,new Pipeline(baseline).run(normalized,new Path(blockRoot,"baseline-fixed").toString(),space,false));
                        profiles=new Path(result.path("outputs").path("profiles").asText());
                    }
                    exportRows(conf,profiles,writers.get("baseline"),"baseline_mr_fixed_v1","rules-mr-30d-3-1.5-v1",report);
                }
                blockRecord.put("state","completed");
            }
            if(!requested.isEmpty()&&!found.equals(requested))throw new IllegalArgumentException("Requested users are absent from the selected split: "+difference(requested,found));
            if(cloud!=null)cloud.control("check-scopes",Json.object().set("scopes",dataset.path("scopes")));
            report.put("exportedSubjects",found.size()).put("state","completed");
        } catch(Exception failure) {
            report.put("state",failure instanceof RunGuard.Cancelled?"cancelled":"failed").put("error",failure.getClass().getSimpleName()+": "+failure.getMessage());throw failure;
        } finally {
            for(BufferedWriter writer:writers.values())writer.close();
            for(String method:writers.keySet()) {
                java.nio.file.Path file=local.resolve(method+".jsonl");ObjectNode descriptor=LearningFiles.describe(conf,new Path(file.toUri()));descriptor.put("path",method+".jsonl");outputFiles.set(method,descriptor);
            }
            report.put("finishedAt",System.currentTimeMillis()).put("elapsedMs",System.currentTimeMillis()-started);report.set("jobs",RunJournal.read(conf));
            LearningFiles.write(conf,new Path(root,"export-run.json"),report);Files.writeString(local.resolve("run-manifest.json"),report.toPrettyString(),StandardCharsets.UTF_8);
        }
        return report;
    }
    private static Set<String> difference(Set<String> requested,Set<String> found){Set<String> missing=new TreeSet<>(requested);missing.removeAll(found);return missing;}
    private static void exportRows(Configuration conf,Path source,BufferedWriter writer,String method,String version,ObjectNode report) throws Exception {
        HdfsFiles.forEachJsonLine(conf,source,row->{
            row.put("method",method).put("modelVersion",version).put("referenceTime",report.path("referenceTime").asLong()).put("inputDigest",report.path("protocolDigest").asText());
            row.set("featureSpaceVersion",report.path("featureSpaceVersion"));row.set("catalogSnapshotId",report.path("catalogSnapshotId"));row.set("evidenceRepos",row.path("usedRepoIds"));
            row.put("status",row.path("vector").path("indices").isEmpty()?"empty":"ready");writer.write(row.toString());writer.newLine();
            ObjectNode counts=(ObjectNode)report.path("predictionCounts");counts.put(method,counts.path(method).asLong()+1);
        });
    }
}
