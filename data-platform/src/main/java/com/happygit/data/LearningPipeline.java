package com.happygit.data;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import org.apache.hadoop.conf.Configuration;
import org.apache.hadoop.fs.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Fit once, select on temporal validation evidence, then project with immutable artifacts. */
public final class LearningPipeline {
    private final Configuration configuration;
    @FunctionalInterface public interface Progress { void record(String phase,ObjectNode detail) throws Exception; }
    public LearningPipeline(Configuration configuration){this.configuration=configuration;}

    public ObjectNode train(ObjectNode request,String destination,Progress progress) throws Exception {
        long started=System.currentTimeMillis();
        ObjectNode dataset=LearningFiles.verified(configuration,(ObjectNode)request.path("dataset"));
        Path root=new Path(destination);FileSystem fs=root.getFileSystem(configuration);
        if(fs.exists(root))throw new IllegalArgumentException("Training attempt already exists");fs.mkdirs(root);
        Configuration conf=new Configuration(configuration);RunJournal.use(conf,root);conf.setLong("hg.referenceTime",dataset.path("referenceTime").asLong());
        long seed=request.path("seed").asLong(20261103);int iterations=request.path("maxIterations").asInt(12);
        double tolerance=request.path("tolerance").asDouble(1e-5);
        if(iterations<1||iterations>50||tolerance<=0||tolerance>1)throw new IllegalArgumentException("Invalid iteration budget or tolerance");
        JsonNode centerCounts=request.path("centerCounts").isArray()?request.path("centerCounts"):Json.MAPPER.readTree("[4,8]");
        JsonNode alphas=request.path("directionBlends").isArray()?request.path("directionBlends"):Json.MAPPER.readTree("[0,0.25,0.5]");
        JsonNode behaviors=request.path("behaviors").isArray()?request.path("behaviors"):Json.MAPPER.readTree("[{\"browseHalfLifeDays\":30,\"starWeight\":3,\"ownedWeight\":1.5},{\"browseHalfLifeDays\":60,\"starWeight\":2,\"ownedWeight\":1.5}]");
        if(centerCounts.isEmpty()||centerCounts.size()>4||alphas.isEmpty()||alphas.size()>8||behaviors.isEmpty()||behaviors.size()>4||centerCounts.size()*behaviors.size()>12)throw new IllegalArgumentException("Training grid exceeds the configured budget");
        for(JsonNode k:centerCounts)if(!k.isIntegralNumber()||k.asInt()<1||k.asInt()>32)throw new IllegalArgumentException("Center count must be 1..32");
        for(JsonNode alpha:alphas)if(!alpha.isNumber()||alpha.asDouble()<0||alpha.asDouble()>1)throw new IllegalArgumentException("Direction blend must be 0..1");
        progress.record("preparing",dataset);
        ObjectNode training=normalize(conf,LearningDataset.pipelineManifest(dataset,"train"),new Path(root,"train-input"));
        ObjectNode validation=normalize(conf,LearningDataset.pipelineManifest(dataset,"validation"),new Path(root,"validation-input"));
        ObjectNode best=null;double bestScore=-1;ArrayNode candidates=Json.MAPPER.createArrayNode();int behaviorId=0;
        for(JsonNode behavior:behaviors) {
            Configuration fit=new Configuration(conf);applyBehavior(fit,behavior);Path attempt=new Path(root,"behavior-"+(behaviorId++));
            ObjectNode fitted=runProfiles(fit,training,new Path(attempt,"train"),null);
            ObjectNode dictionary=LearningFiles.read(fit,fitted.path("outputs").path("featureSpace").asText());dictionary.remove("modelVersion");
            ObjectNode projection=projection(dictionary);String featureVersion=Json.sha256(Json.bytes(projection));
            Path space=new Path(attempt,"space.json");LearningFiles.write(fit,space,dictionary);
            Configuration context=new Configuration(fit);context.setLong("hg.eventEnd",dataset.path("validationSplitAt").asLong());context.setLong("hg.collectionEnd",dataset.path("validationSplitAt").asLong());
            // Manual tags have no historical observation timestamp; omit them from temporal selection.
            context.setBoolean("hg.omitManualTags",true);
            ObjectNode known=runProfiles(context,validation,new Path(attempt,"validation-context"),space);
            Configuration future=new Configuration(fit);future.setLong("hg.eventStart",dataset.path("validationSplitAt").asLong());future.setBoolean("hg.omitCollections",true);future.setBoolean("hg.omitManualTags",true);
            ObjectNode target=runProfiles(future,validation,new Path(attempt,"validation-target"),space);
            Path evalRows=new Path(attempt,"validation-pairs.jsonl");
            try(FSDataOutputStream out=fs.create(evalRows,false)) {
                for(ObjectNode role:Arrays.asList(Json.object().put("path",known.path("outputs").path("profiles").asText()).put("role","context"),Json.object().put("path",target.path("outputs").path("profiles").asText()).put("role","target")))
                    HdfsFiles.forEachJsonLine(fit,new Path(role.path("path").asText()),row->{row.put("validationRole",role.path("role").asText());out.write((row.toString()+"\n").getBytes(StandardCharsets.UTF_8));});
                out.hsync();
            }
            for(JsonNode count:centerCounts) {
                int k=count.asInt();Path trial=new Path(attempt,"centers-"+k);Configuration train=new Configuration(fit);train.setInt("hg.centers",k);train.setLong("hg.seed",seed);
                ArrayNode jobs=Json.MAPPER.createArrayNode();Path centers=Pipeline.stage(train,trial,"L01-initial-centers",LearningJobs.SeedMap.class,LearningJobs.SeedReduce.class,Collections.singletonList(new Path(fitted.path("outputs").path("profiles").asText())),false,jobs);
                List<ObjectNode> current=HdfsFiles.readJsonLines(train,centers);if(current.isEmpty())throw new IllegalArgumentException("No training users with evidence");
                ArrayNode trace=Json.MAPPER.createArrayNode();
                for(int iteration=0;iteration<iterations;iteration++) {
                    train.set("hg.centersPath",centers.toString());
                    Path updated=Pipeline.stage(train,trial,String.format(Locale.ROOT,"L02-iteration-%02d",iteration),LearningJobs.CenterMap.class,LearningJobs.CenterReduce.class,Collections.singletonList(new Path(fitted.path("outputs").path("profiles").asText())),true,jobs);
                    Map<String,ObjectNode> byId=new TreeMap<>();for(ObjectNode center:HdfsFiles.readJsonLines(train,updated))byId.put(center.path("centerId").asText(),center);
                    double change=0;List<ObjectNode> next=new ArrayList<>();
                    for(ObjectNode previous:current){ObjectNode center=byId.getOrDefault(previous.path("centerId").asText(),previous.deepCopy().put("members",0));change=Math.max(change,1-Vectors.dot(previous.path("vector"),center.path("vector")));next.add(center);}
                    centers=new Path(trial,String.format(Locale.ROOT,"centers-%02d.jsonl",iteration));
                    writeCenters(train,centers,next);current=next;trace.addObject().put("iteration",iteration+1).put("maximumCosineChange",change).put("stopped",change<=tolerance);
                    progress.record("training",Json.object().put("centerCount",k).put("iteration",iteration+1).put("maximumCosineChange",change));
                    if(change<=tolerance)break;
                }
                for(ObjectNode center:current)center.set("keywords",keywords(center.path("vector"),dictionary));
                ObjectNode artifact=Json.object().put("schemaVersion","1.0.0").put("algorithm","spherical-kmeans-mr-1").put("namespace",dataset.path("namespace").asText())
                        .put("catalogMode",dataset.path("catalogMode").asText()).put("datasetKind",dataset.path("datasetKind").asText())
                        .put("datasetVersion",dataset.path("datasetVersion").asText()).put("inputDigest",dataset.path("inputDigest").asText())
                        .put("catalogSnapshotId",dataset.path("catalogSnapshotId").asText()).put("featureSpaceVersion",featureVersion).put("codeDigest",LearningFiles.codeDigest());
                artifact.set("projection",projection);artifact.set("catalog",dataset.path("catalog"));artifact.set("centers",Json.MAPPER.valueToTree(current));artifact.set("scopes",dataset.path("scopes"));artifact.set("sourceCounts",dataset.path("counts"));artifact.set("dataset",request.path("dataset"));
                ObjectNode config=artifact.putObject("config").put("seed",seed).put("requestedCenters",k).put("effectiveCenters",current.size()).put("maxIterations",iterations).put("tolerance",tolerance).put("directionBlend",0).put("emptyCenterPolicy","retain_previous_vector");
                config.set("behavior",behavior);artifact.set("iterations",trace);artifact.set("jobs",jobs);
                Path artifactPath=new Path(trial,"candidate.json");LearningFiles.write(train,artifactPath,artifact);
                train.set("hg.artifact",artifactPath.toString());train.set("hg.alphas",alphas.toString());
                Path scores=Pipeline.stage(train,trial,"L03-validation",LearningJobs.ValidationMap.class,LearningJobs.ValidationReduce.class,Collections.singletonList(evalRows),true,jobs);
                Map<Double,double[]> metrics=new TreeMap<>();HdfsFiles.forEachJsonLine(train,scores,row->{double[] sum=metrics.computeIfAbsent(row.path("alpha").asDouble(),ignored->new double[3]);sum[0]+=row.path("score").asDouble();sum[1]+=row.path("baseline").asDouble();sum[2]++;});
                for(var entry:metrics.entrySet()) {
                    double[] sum=entry.getValue();double score=sum[0]/sum[2];ObjectNode metric=candidates.addObject().put("centerCount",k).put("directionBlend",entry.getKey()).put("users",(long)sum[2]).put("cosine",score).put("baselineCosine",sum[1]/sum[2]);metric.set("behavior",behavior);
                    if(score>bestScore+1e-12){bestScore=score;best=artifact.deepCopy();best.with("config").put("directionBlend",entry.getKey());best.set("selection",metric.deepCopy());}
                }
            }
        }
        if(best==null)throw new IllegalArgumentException("Validation has no users with both context and held-out evidence; no model is publishable");
        ObjectNode validationReport=best.putObject("validation").put("passed",true).put("selectedOn","validation").put("metric","temporal-heldout-cosine")
                .put("splitAt",dataset.path("validationSplitAt").asLong()).put("users",best.path("selection").path("users").asLong()).put("testUsed",false);
        validationReport.set("candidates",candidates);validationReport.set("selected",best.path("selection"));
        String version="portrait-"+Json.sha256(Json.bytes(best)).substring(0,24);best.put("modelVersion",version);
        progress.record("candidate",Json.object().put("modelVersion",version));
        ObjectNode saved=LearningFiles.write(conf,new Path(root,"artifact.json"),best);
        ObjectNode descriptor=Json.object().put("namespace",best.path("namespace").asText()).put("modelVersion",version).put("artifactPath",saved.path("path").asText()).put("artifactDigest",saved.path("sha256").asText()).put("trainedAt",System.currentTimeMillis());
        for(String field:Arrays.asList("catalogMode","datasetKind","datasetVersion","inputDigest","catalogSnapshotId","featureSpaceVersion","codeDigest","projection","scopes","sourceCounts","validation"))descriptor.set(field,best.path(field));
        LearningFiles.write(conf,new Path(root,"model-descriptor.json"),descriptor);
        ObjectNode receipt=Json.object().put("state","validated").put("modelVersion",version).put("datasetVersion",best.path("datasetVersion").asText())
                .put("referenceTime",dataset.path("referenceTime").asLong()).put("framework",conf.get("mapreduce.framework.name","local"))
                .put("startedAt",started).put("completedAt",System.currentTimeMillis()).put("elapsedMs",System.currentTimeMillis()-started);
        receipt.set("sourceCounts",dataset.path("counts"));receipt.set("model",descriptor);receipt.set("jobs",RunJournal.read(conf));
        LearningFiles.write(conf,new Path(root,"training-run.json"),receipt);progress.record("validated",descriptor);return descriptor;
    }
    public ObjectNode infer(ObjectNode manifest,ObjectNode model,String destination) throws Exception {
        ObjectNode artifact=load(model);Path root=new Path(destination);FileSystem fs=root.getFileSystem(configuration);
        if(fs.exists(root))throw new IllegalArgumentException("Inference attempt already exists");fs.mkdirs(root);
        Path space=new Path(root,"space.json");LearningFiles.write(configuration,space,(ObjectNode)artifact.path("projection").path("dictionary"));
        Configuration conf=new Configuration(configuration);RunJournal.use(conf,root);applyBehavior(conf,artifact.path("config").path("behavior"));conf.setLong("hg.referenceTime",manifest.path("referenceTime").asLong());
        ObjectNode normalized=normalize(conf,manifest,new Path(root,"input"));ObjectNode baseline=runProfiles(conf,normalized,new Path(root,"baseline"),space);
        conf.set("hg.artifact",model.path("artifactPath").asText());ArrayNode jobs=Json.MAPPER.createArrayNode();
        Path learned=Pipeline.stage(conf,root,"L04-portraits",LearningJobs.InferMap.class,Jobs.IdentityReduce.class,Collections.singletonList(new Path(baseline.path("outputs").path("profiles").asText())),false,jobs);
        ObjectNode result=Json.object().put("modelVersion",artifact.path("modelVersion").asText()).put("baseline",baseline.path("outputs").path("profiles").asText()).put("profiles",learned.toString()).put("completedAt",System.currentTimeMillis());
        result.set("jobs",RunJournal.read(conf));LearningFiles.write(conf,new Path(root,"inference.json"),result);return result;
    }
    ObjectNode load(ObjectNode descriptor) throws Exception {
        ObjectNode artifact=LearningFiles.verified(configuration,Json.object().put("path",descriptor.path("artifactPath").asText()).put("sha256",descriptor.path("artifactDigest").asText()));
        if(!artifact.path("modelVersion").equals(descriptor.path("modelVersion"))||!Json.sha256(Json.bytes(artifact.path("projection"))).equals(artifact.path("featureSpaceVersion").asText()))throw new IllegalArgumentException("Model artifact version mismatch");
        if(!LearningFiles.describe(configuration,new Path(artifact.path("catalog").path("path").asText())).path("sha256").equals(artifact.path("catalog").path("sha256")))throw new IllegalArgumentException("Model catalog digest mismatch");return artifact;
    }
    ObjectNode normalize(Configuration conf,ObjectNode manifest,Path root) throws Exception {
        List<Path> inputs=new ArrayList<>();
        for(JsonNode descriptor:manifest.path("files")) {
            Path file=new Path(descriptor.path("path").asText());if(!LearningFiles.describe(conf,file).path("sha256").equals(descriptor.path("sha256")))throw new IllegalArgumentException("Frozen input digest mismatch");inputs.add(file);
        }
        ArrayNode stages=Json.MAPPER.createArrayNode();Path output=Pipeline.stage(conf,root,"L00-canonical",LearningJobs.InputMap.class,LearningJobs.InputReduce.class,inputs,false,stages);
        ObjectNode result=manifest.deepCopy();ArrayNode files=result.putArray("files");
        FileStatus[] parts=output.getFileSystem(conf).listStatus(output);Arrays.sort(parts,Comparator.comparing(status->status.getPath().toString()));
        for(FileStatus file:parts)if(file.getPath().getName().startsWith("part-"))files.add(LearningFiles.describe(conf,file.getPath()));
        LearningFiles.write(conf,new Path(root,"normalized.json"),result);return result;
    }
    private ObjectNode runProfiles(Configuration conf,ObjectNode manifest,Path output,Path space) throws Exception {
        ObjectNode descriptor=new Pipeline(conf).run(manifest,output.toString(),space,false);return LearningFiles.verified(conf,descriptor);
    }
    static void applyBehavior(Configuration conf,JsonNode behavior) {
        for(String field:Arrays.asList("browseHalfLifeDays","starWeight","ownedWeight")) {
            double value=behavior.path(field).asDouble(-1);if(!Double.isFinite(value)||value<0||(field.equals("browseHalfLifeDays")&&value<=0))throw new IllegalArgumentException("Invalid behavior parameter: "+field);
            conf.setDouble("hg."+field,value);
        }
    }
    private static void writeCenters(Configuration conf,Path output,List<ObjectNode> centers) throws Exception {
        try(FSDataOutputStream out=output.getFileSystem(conf).create(output,false)){for(ObjectNode center:centers)out.write((center.toString()+"\n").getBytes(StandardCharsets.UTF_8));out.hsync();}
    }
    private static ArrayNode keywords(JsonNode vector,ObjectNode dictionary) {
        Map<Integer,String> terms=new HashMap<>();dictionary.path("text").fields().forEachRemaining(e->terms.put(e.getValue().path("index").asInt(),e.getKey()));
        ObjectNode weights=Json.object();for(int i=0;i<vector.path("indices").size();i++){String term=terms.get(vector.path("indices").get(i).asInt());if(term!=null)weights.put(term,vector.path("values").get(i).asDouble());}
        return Portraits.topKeys(weights,5);
    }
    private static ObjectNode projection(ObjectNode dictionary) throws Exception {
        ObjectNode result=Json.object().put("format","happygit-sparse-8192-v1").put("tokenizerVersion","technical-nfkc-bigram-1").put("normalization","NFKC-lowercase-root")
                .put("tokenPattern","c\\+\\+|c#|\\.net|node\\.js|[a-z0-9]+|[\\u4e00-\\u9fff]{2,}").put("chinese","overlapping-bigrams").put("readmeCodePointLimit",8000).put("maxCoordinates",256);
        result.set("stopWords",Json.MAPPER.readTree("[\"the\",\"a\",\"an\",\"and\",\"or\",\"to\",\"of\",\"for\",\"in\",\"is\",\"with\",\"this\",\"that\"]"));
        result.putObject("termWeights").put("name",2).put("description",2).put("topics",2).put("readme",1);
        result.putObject("blockWeights").put("language",.20).put("topic",.30).put("text",.50);result.put("textTf","1+ln(count)").put("textIdf","ln((documents+1)/(df+1))+1");result.set("dictionary",dictionary);return result;
    }
}
