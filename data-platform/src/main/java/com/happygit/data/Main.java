package com.happygit.data;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import org.apache.hadoop.conf.Configuration;
import org.apache.hadoop.fs.Path;
import java.nio.file.Files;
import java.nio.charset.StandardCharsets;
import java.util.*;

public final class Main {
    private static final Set<String> TYPES=new HashSet<>(Arrays.asList("repository","collection","import","process"));
    public static void main(String[] args) throws Exception {
        if(args.length==0){System.out.println("HappyGit data: worker | enqueue | plan | plan-control | export-catalog | archive-cloud | import | process | pipeline | status | serve");return;}
        Map<String,String> options=new LinkedHashMap<>();for(int i=1;i<args.length;i+=2){if(!args[i].startsWith("--")||i+1>=args.length)throw new IllegalArgumentException("Expected --key value");options.put(args[i].substring(2),args[i+1]);}
        Configuration conf=new Configuration();String config=System.getenv("HADOOP_CONF_DIR");
        if(config!=null)for(String file:Arrays.asList("core-site.xml","hdfs-site.xml","yarn-site.xml","mapred-site.xml"))conf.addResource(new Path(config,file));
        String root=options.getOrDefault("root",System.getenv().getOrDefault("HG_DATA_ROOT","/happygit/data"));
        String namespace=Json.requireId(options.getOrDefault("namespace","public"));
        if(args[0].equals("pipeline")){
            ObjectNode manifest=Json.parse(Files.readString(java.nio.file.Path.of(required(options,"manifest"))));
            System.out.println(new Pipeline(conf).run(manifest,required(options,"output")));return;
        }
        String connect=options.getOrDefault("zk",System.getenv().getOrDefault("HG_ZK_CONNECT","127.0.0.1:2181"));
        try(TaskStore store=new TaskStore(connect,System.getenv().getOrDefault("HG_ZK_ROOT","/happygit"),12000,System.getenv("HG_ZK_AUTH"))){
            switch(args[0]){
                case "plan":System.out.println(CollectionPlan.create(store,Json.parse(Files.readString(java.nio.file.Path.of(required(options,"file"))))));break;
                case "plan-control":System.out.println(store.controlPlan(required(options,"id"),required(options,"action"),Integer.parseInt(options.getOrDefault("extra-budget","0"))));break;
                case "export-catalog":System.out.println(new CatalogSnapshot(store,conf).export(namespace,java.nio.file.Path.of(required(options,"output"))));break;
                case "archive-cloud":{
                    ObjectNode frozen=new CloudArchiveClient().prepare();
                    if(frozen.path("state").asText().equals("idle")){System.out.println(frozen);break;}
                    String id=frozen.path("exportId").asText();System.out.println(store.enqueue("cloud-export",namespace,id,Json.object().put("exportId",id),id));break;
                }
                case "enqueue":{
                    String type=options.getOrDefault("type","repository");if(!TYPES.contains(type)||type.equals("process")||type.equals("import"))throw new IllegalArgumentException("Use dedicated command for process/import");
                    ObjectNode input=Json.object();if(type.equals("collection"))input.put("collectionKind",options.getOrDefault("kind","stars")).put("subjectId",required(options,"subject"));
                    System.out.println(store.enqueue(type,namespace,required(options,"target"),input,options.getOrDefault("request",UUID.randomUUID().toString())));break;
                }
                case "import":{
                    // Trusted operator only: never interpret this as an authenticated user-upload API.
                    List<ObjectNode> rows=new ArrayList<>();for(String line:Files.readAllLines(java.nio.file.Path.of(required(options,"file")),StandardCharsets.UTF_8))if(!line.isBlank())rows.add(Json.parse(line));
                    String id=UUID.randomUUID().toString();ObjectNode archive=new HdfsFiles(conf,root).write(namespace,id,"operator",rows);
                    String task=store.enqueue("import",namespace,options.getOrDefault("target","operator-input"),Json.object(),id);
                    ObjectNode claim=store.claim(task,"operator");store.finish(claim,archive);System.out.println(archive);break;
                }
                case "process":{
                    ObjectNode manifest=Json.object().put("namespace",namespace).put("referenceTime",Long.parseLong(options.getOrDefault("reference-time",Long.toString(System.currentTimeMillis()))))
                            .put("datasetKind",options.getOrDefault("dataset-kind","real"));
                    if(!Arrays.asList("real","synthetic").contains(manifest.path("datasetKind").asText()))throw new IllegalArgumentException("dataset-kind must be real or synthetic");
                    ArrayNode files=manifest.putArray("files");Map<String,ObjectNode> collections=new TreeMap<>();
                    for(ObjectNode task:store.committed(namespace)){
                        if(task.path("type").asText().equals("cloud-export"))throw new IllegalArgumentException("Cloud exports require scope-aware snapshot assembly before processing (next portrait iteration)");
                        if(Arrays.asList("process","discovery").contains(task.path("type").asText()))continue;
                        if(task.path("type").asText().equals("collection")){
                            if(!task.path("result").path("collectionComplete").asBoolean())continue;
                            String key=task.path("target").asText().toLowerCase(Locale.ROOT)+"\n"+task.path("input").path("subjectId").asText()+"\n"+task.path("input").path("collectionKind").asText();ObjectNode old=collections.get(key);
                            if(old==null||old.path("createdAt").asLong()<task.path("createdAt").asLong())collections.put(key,task);
                        }else files.add(task.path("result"));
                    }
                    for(ObjectNode task:collections.values())files.add(task.path("result"));
                    if(files.isEmpty())throw new IllegalArgumentException("No committed archives in namespace");
                    String request=options.getOrDefault("request",UUID.randomUUID().toString());
                    ObjectNode frozen=new HdfsFiles(conf,root).write(namespace,"manifest-"+UUID.randomUUID(),"operator",Collections.singletonList(manifest));
                    System.out.println(store.enqueue("process",namespace,"batch",frozen,request));break;
                }
                case "worker": runWorker(store,conf,root,options);break;
                case "status":{ObjectNode status=Json.object();status.set("plans",Json.MAPPER.valueToTree(store.plans()));status.set("workers",Json.MAPPER.valueToTree(store.workers()));status.set("tasks",Json.MAPPER.valueToTree(store.list()));System.out.println(status);break;}
                case "serve":new ConsoleServer(store,conf,root,options).start();Thread.currentThread().join();break;
                default:throw new IllegalArgumentException("Unknown command: "+args[0]);
            }
        }
    }
    static String required(Map<String,String> options,String key){String v=options.get(key);if(v==null||v.isBlank())throw new IllegalArgumentException("Missing --"+key);return v;}
    private static void runWorker(TaskStore store,Configuration conf,String root,Map<String,String> options) throws Exception {
        String worker=Json.requireId(options.getOrDefault("id",java.net.InetAddress.getLocalHost().getHostName()+"-"+UUID.randomUUID()));
        store.registerWorker(worker,Json.object().put("workerId",worker).put("host",java.net.InetAddress.getLocalHost().getHostName()).put("startedAt",System.currentTimeMillis()));
        HdfsFiles archives=new HdfsFiles(conf,root);GitHubCache cache=new GitHubCache(store,conf,root);
        while(!store.expired()&&!Thread.currentThread().isInterrupted()){
            boolean claimed=false;
            for(ObjectNode item:store.list()){
                if(item.path("type").asText().equals("import"))continue;
                ObjectNode task=store.claim(item.path("id").asText(),worker);if(task==null)continue;claimed=true;
                try{
                    String type=task.path("type").asText();ObjectNode result;
                    GitHubCollector collector=new GitHubCollector(System.getenv("GITHUB_TOKEN"),store,cache,task.path("input").path("planId").asText(),task.path("id").asText());
                    if(type.equals("process")){
                        ObjectNode descriptor=(ObjectNode)task.path("input");
                        ObjectNode frozen=HdfsFiles.readJsonLines(conf,new Path(descriptor.path("path").asText())).get(0);
                        if(!Json.sha256((frozen.toString()+"\n").getBytes(StandardCharsets.UTF_8)).equals(descriptor.path("sha256").asText()))throw new IllegalArgumentException("Manifest digest mismatch");
                        result=new Pipeline(conf).run(frozen,root+"/runs/"+task.path("namespace").asText()+"/"+task.path("id").asText()+"/"+task.path("token").asText());
                    }
                    else if(type.equals("cloud-export"))result=new CloudArchiveClient().archive(task,archives);
                    else{
                        List<ObjectNode> records;
                        if(type.equals("repository"))records=collector.repository(task.path("target").asText());
                        else if(type.equals("discovery"))records=collector.discover(task.path("input").path("query").asText(),task.path("input").path("page").asInt());
                        else records=collector.collection(task.path("target").asText(),task.path("input").path("collectionKind").asText(),task.path("input").path("subjectId").asText());
                        result=archives.write(task.path("namespace").asText(),task.path("id").asText(),task.path("token").asText(),records);
                        if(type.equals("collection"))result.put("collectionComplete",records.get(0).path("complete").asBoolean());
                        if(type.equals("discovery"))result.set("coverage",records.get(0));
                        if(type.equals("repository")){ObjectNode row=records.get(0);result.put("language",row.path("primaryLanguage").asText("unknown")).put("visibility",row.path("visibility").asText()).put("isArchived",row.path("isArchived").asBoolean());result.set("topics",row.path("topics"));}
                        result.set("lastRequest",collector.observation());
                        CollectionPlan.expand(store,task,records);
                    }
                    store.finish(task,result);System.out.println(Json.object().put("taskId",task.path("id").asText()).put("state","succeeded"));
                }catch(Exception failure){
                    if(store.expired())throw failure;
                    if(store.get(task.path("id").asText()).path("state").asText().equals("succeeded"))continue;
                    long retry=System.currentTimeMillis()+Math.min(300000,5000L*(1L<<Math.min(task.path("attempt").asInt(),6)));
                    boolean permanent=failure instanceof IllegalArgumentException;
                    if(failure instanceof CollectionPlan.Paused)task.put("attempt",task.path("attempt").asInt()-1);
                    if(failure instanceof GitHubCollector.FetchException){retry=((GitHubCollector.FetchException)failure).retryAt;permanent=((GitHubCollector.FetchException)failure).permanent;}
                    String message=failure.getClass().getSimpleName()+": "+String.valueOf(failure.getMessage());
                    System.err.println(Json.object().put("taskId",task.path("id").asText()).put("error",message));
                    try{store.retry(task,message,retry,permanent);}catch(org.apache.zookeeper.KeeperException.NoNodeException | IllegalStateException lost){/* new owner/session decides disposition */}
                }
                if(options.getOrDefault("once","false").equals("true"))return;
            }
            if(options.getOrDefault("once","false").equals("true"))return;
            if(!claimed)Thread.sleep(1500);
        }
    }
}
