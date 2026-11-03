package com.happygit.data;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import org.apache.hadoop.conf.Configuration;
import org.apache.hadoop.fs.*;
import org.apache.hadoop.io.*;
import org.apache.hadoop.mapreduce.*;
import org.apache.hadoop.mapreduce.lib.input.FileInputFormat;
import org.apache.hadoop.mapreduce.lib.output.FileOutputFormat;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

public final class Pipeline {
    private final Configuration configuration;
    public Pipeline(Configuration configuration) { this.configuration=configuration; }
    public ObjectNode run(ObjectNode manifest,String destination) throws Exception {
        Configuration conf=new Configuration(configuration);
        conf.setLong("hg.referenceTime",manifest.path("referenceTime").asLong());
        conf.setBoolean("hg.synthetic",manifest.path("datasetKind").asText().equals("synthetic"));
        Path root=new Path(destination);FileSystem fs=root.getFileSystem(conf);
        if(fs.exists(root))throw new IOException("Run output exists; use a new attempt path");
        fs.mkdirs(root);
        try(FSDataOutputStream out=fs.create(new Path(root,"input-manifest.json"),false)){out.write(Json.bytes(manifest));out.hsync();}
        List<Path> raw=new ArrayList<>();
        for(JsonNode item:manifest.path("files")){
            Path p=new Path(item.path("path").asText());FileSystem source=p.getFileSystem(conf);
            java.security.MessageDigest digest=java.security.MessageDigest.getInstance("SHA-256");
            try(InputStream in=source.open(p)){byte[] buffer=new byte[65536];for(int n;(n=in.read(buffer))>=0;)digest.update(buffer,0,n);}
            StringBuilder hash=new StringBuilder();for(byte b:digest.digest())hash.append(String.format("%02x",b&255));
            if(!hash.toString().equals(item.path("sha256").asText()))throw new IOException("Frozen input digest mismatch");raw.add(p);
        }
        if(raw.isEmpty())throw new IOException("No committed input files");
        ObjectNode result=Json.object().put("modelVersion","mr-content-v2-data1").put("datasetKind",manifest.path("datasetKind").asText())
                .put("referenceTime",manifest.path("referenceTime").asLong()).put("namespace",manifest.path("namespace").asText());
        ArrayNode stages=result.putArray("stages");
        Path j01=stage(conf,root,"J01-repositories",Jobs.SnapshotMap.class,Jobs.SnapshotReduce.class,raw,false,stages);
        long catalog=stages.get(stages.size()-1).path("outputRecords").asLong();
        if(catalog==0)throw new IOException("No public repository observations at referenceTime");
        conf.setLong("hg.documentCount",catalog);
        Path j02=stage(conf,root,"J02-events",Jobs.EventMap.class,Jobs.EventReduce.class,raw,false,stages);
        Path j03=stage(conf,root,"J03-terms",Jobs.TermsMap.class,Jobs.IdentityReduce.class,Collections.singletonList(j01),false,stages);
        Path j04=stage(conf,root,"J04-df",Jobs.DfMap.class,Jobs.DfReduce.class,Collections.singletonList(j03),false,stages);
        Path j05=stage(conf,root,"J05-feature-space",Jobs.SpaceMap.class,Jobs.SpaceReduce.class,Collections.singletonList(j04),false,stages);
        conf.set("hg.space",new Path(j05,"part-r-00000").toString());
        List<ObjectNode> dictionary=HdfsFiles.readJsonLines(conf,new Path(conf.get("hg.space")));
        result.put("featureSpaceVersion",Json.sha256((dictionary.get(0).toString()+"\n").getBytes(StandardCharsets.UTF_8)));
        Path j06=stage(conf,root,"J06-vectors",Jobs.VectorMap.class,Jobs.IdentityReduce.class,Collections.singletonList(j03),false,stages);
        List<Path> evidenceInput=new ArrayList<>(raw);evidenceInput.add(j02);
        // The evidence mapper reads normalized events only, so raw event rows are excluded below.
        Path collections=new Path(root,"collection-input.jsonl");
        try(FSDataOutputStream out=fs.create(collections,false)){
            for(Path p:raw)for(ObjectNode item:HdfsFiles.readJsonLines(conf,p))
                if(item.path("kind").asText().equals("collection"))out.write((item.toString()+"\n").getBytes(StandardCharsets.UTF_8));
            out.hsync();
        }
        Path j07=stage(conf,root,"J07-evidence",Jobs.EvidenceMap.class,Jobs.EvidenceReduce.class,Arrays.asList(j02,collections),false,stages);
        Path j08=stage(conf,root,"J08-join",Jobs.JoinMap.class,Jobs.JoinReduce.class,Arrays.asList(j06,j07),true,stages);
        List<Path> profileInput=new ArrayList<>(raw);profileInput.add(j08);
        Path j09=stage(conf,root,"J09-profiles",Jobs.ProfileMap.class,Jobs.ProfileReduce.class,profileInput,true,stages);
        Path j10=stage(conf,root,"J10-cohorts",Jobs.GroupMap.class,Jobs.GroupReduce.class,Collections.singletonList(j09),false,stages);
        conf.set("hg.profiles",j09.toString());
        Path j11=stage(conf,root,"J11-candidates",Jobs.RecallMap.class,Jobs.RecallReduce.class,Collections.singletonList(j06),false,stages);
        Path j12=stage(conf,root,"J12-public",Jobs.PopularMap.class,Jobs.PopularReduce.class,Collections.singletonList(j06),false,stages);
        ObjectNode outputs=result.putObject("outputs");outputs.put("repositories",j06.toString()).put("profiles",j09.toString()).put("cohorts",j10.toString()).put("candidates",j11.toString()).put("publicRanking",j12.toString()).put("featureSpace",conf.get("hg.space"));
        result.put("repositoryCount",catalog).put("profileCount",stages.get(8).path("outputRecords").asLong()).put("completedAt",System.currentTimeMillis());
        Path resultFile=new Path(root,"result-manifest.json");
        try(FSDataOutputStream out=fs.create(resultFile,false)){out.write(Json.bytes(result));out.hsync();}
        return Json.object().put("path",fs.makeQualified(resultFile).toString()).put("sha256",Json.sha256(Json.bytes(result)))
                .put("repositoryCount",catalog).put("profileCount",result.path("profileCount").asLong()).put("referenceTime",result.path("referenceTime").asLong())
                .put("datasetKind",result.path("datasetKind").asText());
    }
    @SuppressWarnings("rawtypes")
    private Path stage(Configuration conf,Path root,String name,Class<? extends Mapper> mapper,Class<? extends Reducer> reducer,List<Path> inputs,boolean grouped,ArrayNode stages) throws Exception {
        Job job=Job.getInstance(new Configuration(conf),"happygit-"+root.getName()+"-"+name);
        job.setJarByClass(Pipeline.class);job.setMapperClass(mapper);job.setReducerClass(reducer);
        job.setMapOutputKeyClass(Text.class);job.setMapOutputValueClass(Text.class);job.setOutputKeyClass(NullWritable.class);job.setOutputValueClass(Text.class);
        job.setNumReduceTasks(name.startsWith("J05")?1:conf.getInt("hg.reducers",2));
        if(grouped){job.setPartitionerClass(Jobs.PrefixPartition.class);job.setGroupingComparatorClass(Jobs.PrefixGroup.class);}
        for(Path input:inputs)FileInputFormat.addInputPath(job,input);
        FileInputFormat.setMaxInputSplitSize(job,32L*1024*1024);
        Path output=new Path(root,name);FileOutputFormat.setOutputPath(job,output);
        long started=System.currentTimeMillis();
        if(!job.waitForCompletion(true))throw new IOException("MapReduce stage failed: "+name+" job="+job.getJobID());
        ObjectNode record=stages.addObject().put("stage",name).put("jobId",job.getJobID().toString()).put("startedAt",started).put("finishedAt",System.currentTimeMillis())
                .put("inputRecords",job.getCounters().findCounter(Jobs.Count.INPUT).getValue()).put("outputRecords",job.getCounters().findCounter(Jobs.Count.OUTPUT).getValue())
                .put("ignored",job.getCounters().findCounter(Jobs.Count.IGNORED).getValue()).put("duplicates",job.getCounters().findCounter(Jobs.Count.DUPLICATE).getValue())
                .put("dotProducts",job.getCounters().findCounter(Jobs.Count.DOT_PRODUCTS).getValue()).put("missingFeatureEvents",job.getCounters().findCounter(Jobs.Count.MISSING_FEATURE).getValue());
        record.put("mapTasks",job.getCounters().findCounter(JobCounter.TOTAL_LAUNCHED_MAPS).getValue()).put("reduceTasks",job.getCounters().findCounter(JobCounter.TOTAL_LAUNCHED_REDUCES).getValue());
        Path checkpoint=new Path(root,name+".json");try(FSDataOutputStream out=root.getFileSystem(conf).create(checkpoint,false)){out.write(Json.bytes(record));out.hsync();}
        return output;
    }
}
