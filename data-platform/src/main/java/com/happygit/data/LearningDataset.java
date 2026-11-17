package com.happygit.data;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import org.apache.hadoop.conf.Configuration;
import org.apache.hadoop.fs.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;

/** Freezes canonical data and allowed cloud archives, never evaluation labels or old predictions. */
final class LearningDataset {
    private LearningDataset() {}
    static ObjectNode prepare(Configuration conf,java.nio.file.Path file,String namespace,Path output,CloudArchiveClient cloud) throws Exception {
        ObjectNode dataset=Json.parse(Files.readString(file));
        if(namespace.equals("production")&&dataset.path("catalogMode").asText().equals("synthetic_fixture"))
            throw new IllegalArgumentException("synthetic_fixture requires an experiment- namespace");
        FileSystem fs=output.getFileSystem(conf);if(fs.exists(output))throw new IllegalArgumentException("Snapshot output already exists");fs.mkdirs(output);
        Map<String,ObjectNode> descriptors=new TreeMap<>();
        for(JsonNode item:dataset.path("files"))descriptors.put(item.path("path").asText(),(ObjectNode)item);
        Map<String,String> splits=new TreeMap<>();
        Path splitPath=source(conf,file,"splits/subjects.jsonl",descriptors);
        HdfsFiles.forEachJsonLine(conf,splitPath,row->{
            String split=row.path("split").asText();if(!Arrays.asList("train","validation","test").contains(split))throw new IllegalArgumentException("Unknown subject split");
            if(splits.put(Json.requireId(row.path("subjectId").asText()),split)!=null)throw new IllegalArgumentException("Duplicate split subject");
        });
        ObjectNode manifest=Json.object().put("schemaVersion","1.0.0").put("namespace",Json.requireId(namespace))
                .put("catalogMode",dataset.path("catalogMode").asText()).put("datasetKind",dataset.path("catalogMode").asText().equals("synthetic_fixture")?"synthetic":"real")
                .put("referenceTime",cloud==null?dataset.path("referenceTime").asLong():System.currentTimeMillis())
                .put("baseDatasetVersion",dataset.path("datasetVersion").asText()).put("samplingRule","all historical train subjects plus authorized 90-day cloud evidence; stable subject hash 80/10/10; fixed test excluded from fit and selection");
        ObjectNode files=manifest.putObject("splits"),counts=manifest.putObject("counts");
        for(String split:Arrays.asList("train","validation","test"))files.putArray(split);
        Path catalog=new Path(output,"catalog.jsonl");
        try(FSDataOutputStream out=fs.create(catalog,false)) {
            HdfsFiles.forEachJsonLine(conf,source(conf,file,"canonical/repositories.jsonl",descriptors),row->{
                if(!row.path("kind").asText().equals("repository"))throw new IllegalArgumentException("Canonical catalog must contain repository rows");
                out.write((row.toString()+"\n").getBytes(StandardCharsets.UTF_8));increment(counts,"repositories");
            });out.hsync();
        }
        manifest.set("catalog",LearningFiles.describe(conf,catalog));manifest.put("catalogSnapshotId",manifest.path("catalog").path("sha256").asText());
        Map<String,FSDataOutputStream> writers=new TreeMap<>();
        try {
            for(String split:Arrays.asList("train","validation","test"))writers.put(split,fs.create(new Path(output,split+".jsonl"),false));
            for(String name:Arrays.asList("subjects","collections","events")) {
                HdfsFiles.forEachJsonLine(conf,source(conf,file,"canonical/"+name+".jsonl",descriptors),row->{
                    String kind=row.path("kind").asText(),subject=row.path("subjectId").asText(),split=splits.get(subject);
                    if(!Arrays.asList("subject","collection","event").contains(kind)||split==null)throw new IllegalArgumentException("Unsplit or unsupported canonical input");
                    ObjectNode clean=row.deepCopy();clean.remove(Arrays.asList("cohortHint","scenario","derived_profile","generatorTruth","split"));
                    writers.get(split).write((clean.toString()+"\n").getBytes(StandardCharsets.UTF_8));
                    increment(counts,split+"_"+kind);increment(counts,row.path("sourceKind").asText("unspecified")+"_"+kind);
                });
            }
            ArrayNode scopes=manifest.putArray("scopes"),cloudInputs=manifest.putArray("cloudInputs");
            if(cloud!=null) {
                String after="";boolean more;
                do {
                    ObjectNode page=cloud.inputs(after,after.isEmpty()?0:manifest.path("referenceTime").asLong());
                    manifest.put("referenceTime",page.path("referenceTime").asLong());
                    for(JsonNode input:page.path("items")) {
                        String subject=input.path("subjectId").asText();
                        String split=splits.getOrDefault(subject,split(subject));
                        scopes.add(Json.object().put("subjectId",subject).put("analysisEpoch",input.path("analysisEpoch").asLong()).put("revision",input.path("revision").asLong()));
                        cloudInputs.add(input);
                        for(JsonNode archive:input.path("archives")) {
                            ObjectNode descriptor=(ObjectNode)archive.path("archive");
                            if(!LearningFiles.describe(conf,new Path(descriptor.path("path").asText())).path("sha256").equals(descriptor.path("sha256")))throw new IllegalArgumentException("Cloud archive digest mismatch");
                            HdfsFiles.forEachJsonLine(conf,new Path(descriptor.path("path").asText()),row->{
                                if(!subject.equals(row.path("subjectId").asText())||input.path("analysisEpoch").asLong()!=row.path("analysisEpoch").asLong())throw new IllegalArgumentException("Cloud archive scope mismatch");
                                if(!Arrays.asList("subject","collection","event").contains(row.path("kind").asText()))throw new IllegalArgumentException("Derived profiles are not raw evidence");
                                writers.get(split).write((row.toString()+"\n").getBytes(StandardCharsets.UTF_8));increment(counts,split+"_cloud_"+row.path("kind").asText());
                            });
                        }
                    }
                    after=page.path("nextAfter").asText();more=page.path("hasMore").asBoolean();
                }while(more);
            }
            for(FSDataOutputStream out:writers.values())out.hsync();
        } finally { for(FSDataOutputStream out:writers.values())out.close(); }
        for(String split:Arrays.asList("train","validation","test"))((ArrayNode)files.path(split)).add(LearningFiles.describe(conf,new Path(output,split+".jsonl")));
        manifest.put("validationSplitAt",manifest.path("referenceTime").asLong()-7L*86400000);
        String digest=Json.sha256(Json.bytes(manifest));manifest.put("inputDigest",digest).put("datasetVersion","dataset-"+digest.substring(0,24));
        return LearningFiles.write(conf,new Path(output,"dataset.json"),manifest);
    }
    private static Path source(Configuration conf,java.nio.file.Path base,String relative,Map<String,ObjectNode> entries) throws Exception {
        ObjectNode descriptor=entries.get(relative);if(descriptor==null)throw new IllegalArgumentException("Dataset is missing "+relative);
        Path file=new Path(base.toAbsolutePath().getParent().resolve(relative).toUri());
        if(!LearningFiles.describe(conf,file).path("sha256").asText().equals(descriptor.path("sha256").asText()))throw new IllegalArgumentException("Dataset file hash mismatch: "+relative);
        return file;
    }
    static String split(String subject) {
        int bucket=Integer.parseInt(Json.sha256(subject.getBytes(StandardCharsets.UTF_8)).substring(0,6),16)%10;
        return bucket<8?"train":bucket==8?"validation":"test";
    }
    private static void increment(ObjectNode counts,String name){counts.put(name,counts.path(name).asLong()+1);}
    static ObjectNode pipelineManifest(ObjectNode dataset,String split) {
        ObjectNode result=Json.object().put("namespace",dataset.path("namespace").asText()).put("referenceTime",dataset.path("referenceTime").asLong()).put("datasetKind",dataset.path("datasetKind").asText());
        ArrayNode files=result.putArray("files");files.add(dataset.path("catalog"));for(JsonNode file:dataset.path("splits").path(split))files.add(file);return result;
    }
}
