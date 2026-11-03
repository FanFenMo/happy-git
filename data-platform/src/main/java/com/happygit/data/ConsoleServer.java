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
            if(exchange.getRequestMethod().equals("GET")&&path.equals("/api/platform/status")){
                List<ObjectNode> tasks=store.list();ObjectNode result=Json.object().put("observedAt",System.currentTimeMillis()).put("storageRoot",root)
                        .put("coordination","ZooKeeper").put("workerSessionExpired",store.expired()).put("deploymentMode",System.getenv().getOrDefault("HG_CLUSTER_MODE","local-development"));
                result.set("workers",Json.MAPPER.valueToTree(store.workers()));result.set("tasks",Json.MAPPER.valueToTree(tasks));send(exchange,200,result);
            }else if(exchange.getRequestMethod().equals("GET")&&path.equals("/api/platform/repositories")){
                String namespace="public";String query=exchange.getRequestURI().getRawQuery();
                if(query!=null&&query.startsWith("namespace="))namespace=Json.requireId(URLDecoder.decode(query.substring(10),StandardCharsets.UTF_8));
                Map<String,ObjectNode> repositories=new TreeMap<>();
                for(ObjectNode task:store.committed(namespace))if(task.path("type").asText().equals("repository")){
                    for(ObjectNode row:HdfsFiles.readJsonLines(conf,new Path(task.path("result").path("path").asText()))){
                        String id=Json.text(row,"repoId");ObjectNode old=repositories.get(id);
                        if(row.path("visibility").asText().equals("public")&&(old==null||old.path("observedAt").asLong()<row.path("observedAt").asLong())){
                            row.remove("readmeText");repositories.put(id,row);}
                    }
                }
                ObjectNode result=Json.object().put("source","collected_public_catalog").put("personalized",false);
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
    private void send(HttpExchange exchange,int code,ObjectNode value)throws IOException{
        byte[] bytes=Json.bytes(value);exchange.getResponseHeaders().set("Content-Type","application/json; charset=utf-8");exchange.getResponseHeaders().set("Cache-Control","no-store");
        exchange.getResponseHeaders().set("X-Content-Type-Options","nosniff");exchange.sendResponseHeaders(code,bytes.length);exchange.getResponseBody().write(bytes);
    }
}
