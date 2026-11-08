package com.happygit.data;

import com.fasterxml.jackson.databind.node.*;
import com.sun.net.httpserver.*;
import org.apache.hadoop.conf.Configuration;
import org.apache.hadoop.fs.Path;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.Executors;

/** Operator-only control UI. No consumer identity or behavior upload endpoints. */
public final class ConsoleServer {
    private final TaskStore store;
    private final Configuration conf;
    private final String root;
    private final Map<String,String> options;
    private final String token=System.getenv().getOrDefault("HG_ADMIN_TOKEN","");
    public ConsoleServer(TaskStore store,Configuration conf,String root,Map<String,String> options){this.store=store;this.conf=conf;this.root=root;this.options=options;}
    public void start() throws IOException {
        String bind=options.getOrDefault("bind","127.0.0.1");
        if(!InetAddress.getByName(bind).isLoopbackAddress()&&token.length()<24)throw new IllegalArgumentException("Non-loopback console requires HG_ADMIN_TOKEN of at least 24 characters");
        HttpServer server=HttpServer.create(new InetSocketAddress(bind,Integer.parseInt(options.getOrDefault("port","8090"))),32);
        server.createContext("/",this::handle);server.setExecutor(Executors.newFixedThreadPool(6));server.start();
        System.out.println("Data console: http://"+bind+":"+server.getAddress().getPort());
    }
    private void handle(HttpExchange exchange) throws IOException {
        try{
            String path=exchange.getRequestURI().getPath();
            if(path.equals("/")||path.equals("/client")){
                if(!exchange.getRequestMethod().equals("GET")){send(exchange,405,Json.object().put("error","Method not allowed"));return;}
                try(InputStream in=getClass().getResourceAsStream("/console.html")){
                    if(in==null)throw new IOException("Console resource missing");byte[] body=in.readAllBytes();
                    exchange.getResponseHeaders().set("Content-Type","text/html; charset=utf-8");
                    exchange.getResponseHeaders().set("Content-Security-Policy","default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https://avatars.githubusercontent.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
                    exchange.sendResponseHeaders(200,body.length);exchange.getResponseBody().write(body);return;
                }
            }
            if(!path.startsWith("/api/platform/")){send(exchange,404,Json.object().put("error","Not found"));return;}
            String authorization=exchange.getRequestHeaders().getFirst("Authorization");
            if(!token.isEmpty()&&!MessageDigest.isEqual(("Bearer "+token).getBytes(StandardCharsets.UTF_8),String.valueOf(authorization).getBytes(StandardCharsets.UTF_8))){send(exchange,401,Json.object().put("error","需要管理员凭据"));return;}
            if(!exchange.getRequestMethod().equals("GET")){
                String origin=exchange.getRequestHeaders().getFirst("Origin");
                if(origin!=null&&!origin.equals("http://"+exchange.getRequestHeaders().getFirst("Host"))&&!origin.equals("https://"+exchange.getRequestHeaders().getFirst("Host")))throw new IllegalArgumentException("Origin mismatch");
            }
            if(exchange.getRequestMethod().equals("GET")&&path.equals("/api/platform/status")){
                List<ObjectNode> tasks=store.list();ObjectNode result=Json.object().put("observedAt",System.currentTimeMillis()).put("storageRoot",root)
                        .put("coordination","ZooKeeper").put("workerSessionExpired",store.expired()).put("deploymentMode",System.getenv().getOrDefault("HG_CLUSTER_MODE","local-development"));
                result.set("workers",Json.MAPPER.valueToTree(store.workers()));result.set("tasks",Json.MAPPER.valueToTree(tasks));
                ObjectNode rates=result.putObject("rateLimits");for(String scope:Arrays.asList("core","search")){ObjectNode observation=store.observation("github-rate-"+scope);if(observation!=null)rates.set(scope,observation);}
                ArrayNode plans=result.putArray("plans");
                for(ObjectNode plan:store.plans()){
                    ObjectNode summary=plan.deepCopy(),counts=summary.putObject("taskCounts"),languages=summary.putObject("languageObservations"),topics=summary.putObject("topicObservations");
                    for(ObjectNode task:tasks)if(task.path("input").path("planId").asText().equals(plan.path("planId").asText())){
                        String state=task.path("state").asText();counts.put(state,counts.path(state).asInt()+1);
                        if(state.equals("succeeded")&&task.path("type").asText().equals("repository")&&task.path("result").path("visibility").asText().equals("public")){
                            String language=task.path("result").path("language").asText("unknown");languages.put(language,languages.path(language).asInt()+1);
                            for(com.fasterxml.jackson.databind.JsonNode topic:task.path("result").path("topics"))topics.put(topic.asText(),topics.path(topic.asText()).asInt()+1);
                        }
                    }
                    plans.add(summary);
                }
                send(exchange,200,result);
            }else if(exchange.getRequestMethod().equals("POST")&&path.equals("/api/platform/plans")){
                send(exchange,202,CollectionPlan.create(store,body(exchange)));
            }else if(exchange.getRequestMethod().equals("POST")&&path.matches("/api/platform/plans/[A-Za-z0-9_.-]+/(pause|resume)")){
                String[] segments=path.split("/");ObjectNode input=body(exchange);
                send(exchange,200,store.controlPlan(segments[4],segments[5],input.path("extraBudget").asInt(0)));
            }else if(exchange.getRequestMethod().equals("GET")&&path.equals("/api/platform/catalog/export")){
                String namespace="public",query=exchange.getRequestURI().getRawQuery();if(query!=null&&query.startsWith("namespace="))namespace=Json.requireId(URLDecoder.decode(query.substring(10),StandardCharsets.UTF_8));
                ObjectNode snapshot=new CatalogSnapshot(store,conf).freeze(namespace);StringBuilder bytes=new StringBuilder();for(com.fasterxml.jackson.databind.JsonNode row:snapshot.path("records"))bytes.append(row).append('\n');
                snapshot.put("catalogSnapshotId",Json.sha256(bytes.toString().getBytes(StandardCharsets.UTF_8))).put("sha256",Json.sha256(bytes.toString().getBytes(StandardCharsets.UTF_8))).put("bytes",bytes.toString().getBytes(StandardCharsets.UTF_8).length);
                send(exchange,200,snapshot);
            }else if(exchange.getRequestMethod().equals("GET")&&path.equals("/api/platform/repositories")){
                String namespace="public";String query=exchange.getRequestURI().getRawQuery();
                if(query!=null&&query.startsWith("namespace="))namespace=Json.requireId(URLDecoder.decode(query.substring(10),StandardCharsets.UTF_8));
                Map<String,ObjectNode> repositories=new TreeMap<>();
                for(ObjectNode task:store.committed(namespace))if(task.path("type").asText().equals("repository")){
                    for(ObjectNode row:HdfsFiles.readJsonLines(conf,new Path(task.path("result").path("path").asText()))){
                        observeRepository(repositories,row);
                    }
                }
                ObjectNode result=Json.object().put("source","collected_public_catalog").put("personalized",false);
                repositories.values().removeIf(row->!row.path("visibility").asText().equals("public"));
                result.set("items",Json.MAPPER.valueToTree(repositories.values()));send(exchange,200,result);
            }else if(exchange.getRequestMethod().equals("POST")&&path.equals("/api/platform/tasks")){
                String origin=exchange.getRequestHeaders().getFirst("Origin");
                if(origin!=null&&!origin.equals("http://"+exchange.getRequestHeaders().getFirst("Host"))&&!origin.equals("https://"+exchange.getRequestHeaders().getFirst("Host")))throw new IllegalArgumentException("Origin mismatch");
                byte[] bytes=exchange.getRequestBody().readNBytes(4097);if(bytes.length>4096)throw new IllegalArgumentException("Request too large");
                ObjectNode input=Json.parse(new String(bytes,StandardCharsets.UTF_8));String target=Json.text(input,"target");
                if(!target.matches("[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"))throw new IllegalArgumentException("使用 owner/name 格式");
                String id=store.enqueue("repository",Json.requireId(input.path("namespace").asText("public")),target,Json.object(),Json.requireId(input.path("requestId").asText(UUID.randomUUID().toString())));
                send(exchange,202,Json.object().put("taskId",id));
            }else send(exchange,404,Json.object().put("error","Not found"));
        }catch(IllegalArgumentException e){send(exchange,400,Json.object().put("error",e.getMessage()));}
        catch(Exception e){System.err.println("Console request failed: "+e.getClass().getSimpleName());send(exchange,503,Json.object().put("error","数据平台暂不可用，请稍后重试"));}
        finally{exchange.close();}
    }
    static void observeRepository(Map<String,ObjectNode> repositories,ObjectNode row){
        String id=Json.text(row,"repoId");ObjectNode old=repositories.get(id);
        if(old==null||old.path("observedAt").asLong()<row.path("observedAt").asLong()){
            ObjectNode metadata=row.deepCopy();metadata.remove("readmeText");repositories.put(id,metadata);
        }
    }
    private void send(HttpExchange exchange,int code,ObjectNode value)throws IOException{
        byte[] bytes=Json.bytes(value);exchange.getResponseHeaders().set("Content-Type","application/json; charset=utf-8");exchange.getResponseHeaders().set("Cache-Control","no-store");
        exchange.getResponseHeaders().set("X-Content-Type-Options","nosniff");exchange.sendResponseHeaders(code,bytes.length);exchange.getResponseBody().write(bytes);
    }
    private ObjectNode body(HttpExchange exchange)throws IOException{
        byte[] bytes=exchange.getRequestBody().readNBytes(65537);if(bytes.length>65536)throw new IllegalArgumentException("Request too large");return Json.parse(new String(bytes,StandardCharsets.UTF_8));
    }
}
