package com.happygit.data;

import com.fasterxml.jackson.databind.node.*;
import org.apache.hadoop.conf.Configuration;
import org.apache.hadoop.fs.*;
import org.apache.hadoop.mapreduce.Job;
import java.util.*;

/** Immutable submitted/finished receipts include unsuccessful attempts as well as successful jobs. */
final class RunJournal {
    private RunJournal() {}
    static void use(Configuration conf,Path root){if(conf.get("hg.runJournal")==null)conf.set("hg.runJournal",new Path(root,"job-records").toString());}
    static ObjectNode submitted(Configuration conf,Job job,String stage,Path output,long started) throws Exception {
        String id=job.getJobID().toString(),framework=conf.get("mapreduce.framework.name","local");
        ObjectNode record=Json.object().put("stage",stage).put("jobId",id).put("framework",framework).put("state","RUNNING")
                .put("startedAt",started).put("outputPath",output.toString()).put("driverHost",java.net.InetAddress.getLocalHost().getHostName());
        if(framework.equals("yarn")&&id.matches("job_[0-9]+_[0-9]+"))record.put("applicationId",id.replaceFirst("job_","application_"));
        if(conf.get("hg.taskId")!=null)record.put("taskId",conf.get("hg.taskId")).put("taskAttempt",conf.getInt("hg.taskAttempt",0));
        ObjectNode resources=record.putObject("resources");
        for(String name:Arrays.asList("mapreduce.map.memory.mb","mapreduce.reduce.memory.mb","yarn.app.mapreduce.am.resource.mb","mapreduce.map.cpu.vcores","mapreduce.reduce.cpu.vcores","mapreduce.job.queuename","hg.reducers"))
            if(conf.get(name)!=null)resources.put(name,conf.get(name));
        save(conf,record,"submitted");return record;
    }
    static void finished(Configuration conf,ObjectNode record,boolean succeeded,Exception failure) throws Exception {
        record.put("state",succeeded?"SUCCEEDED":failure instanceof RunGuard.Cancelled?"CANCELLED":"FAILED").put("finishedAt",System.currentTimeMillis());
        record.put("elapsedMs",record.path("finishedAt").asLong()-record.path("startedAt").asLong());
        if(failure!=null)record.put("error",failure.getClass().getSimpleName()+": "+failure.getMessage());save(conf,record,"finished");
    }
    private static void save(Configuration conf,ObjectNode record,String phase) throws Exception {
        String root=conf.get("hg.runJournal");if(root!=null)LearningFiles.write(conf,new Path(root,record.path("jobId").asText()+"-"+phase+".json"),record);
    }
    static ArrayNode read(Configuration conf) throws Exception {
        ArrayNode result=Json.MAPPER.createArrayNode();String root=conf.get("hg.runJournal");if(root==null)return result;
        Path path=new Path(root);FileSystem fs=path.getFileSystem(conf);if(!fs.exists(path))return result;
        TreeMap<String,ObjectNode> records=new TreeMap<>();
        for(FileStatus file:fs.listStatus(path)) {
            if(!file.isFile()||!file.getPath().getName().endsWith(".json"))continue;
            ObjectNode row=LearningFiles.read(conf,file.getPath().toString()),old=records.get(row.path("jobId").asText());
            if(old==null||row.path("finishedAt").asLong()>old.path("finishedAt").asLong())records.put(row.path("jobId").asText(),row);
        }
        List<ObjectNode> ordered=new ArrayList<>(records.values());ordered.sort(Comparator.comparingLong(row->row.path("startedAt").asLong()));ordered.forEach(result::add);return result;
    }
}
