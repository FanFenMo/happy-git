package com.happygit.data;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.*;

/** Service-to-service bridge: no Hadoop dependencies are loaded by the Spring API. */
final class CloudArchiveClient {
    private final URI base;private final String token;
    private final HttpClient http=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    CloudArchiveClient(){
        base=URI.create(System.getenv().getOrDefault("HG_CLOUD_API_URL","http://127.0.0.1:8081"));token=System.getenv().getOrDefault("HG_CLOUD_ADMIN_TOKEN","");
        if(token.length()<32)throw new IllegalArgumentException("HG_CLOUD_ADMIN_TOKEN requires at least 32 characters");
        if(!base.getScheme().equals("https")&&!(base.getScheme().equals("http")&&Arrays.asList("127.0.0.1","localhost","[::1]").contains(base.getHost())))throw new IllegalArgumentException("Cloud bridge requires HTTPS except loopback");
    }
    ObjectNode prepare()throws Exception{return request("POST","/api/v2/internal/exports/prepare",Json.object());}
    ObjectNode load(String id)throws Exception{return request("GET","/api/v2/internal/exports/"+Json.requireId(id),null);}
    ObjectNode archive(ObjectNode task,HdfsFiles files)throws Exception{
        String id=task.path("target").asText();ObjectNode frozen=load(id);
        if(frozen.path("state").asText().equals("committed"))return (ObjectNode)frozen.path("archive");
        List<ObjectNode> records=new ArrayList<>();for(JsonNode row:frozen.path("records"))records.add((ObjectNode)row);
        ObjectNode result=files.write(task.path("namespace").asText(),task.path("id").asText(),task.path("token").asText(),records);
        if(!result.path("sha256").equals(frozen.path("sha256"))||result.path("bytes").asLong()!=frozen.path("bytes").asLong())throw new IllegalArgumentException("Frozen export digest mismatch");
        ObjectNode committed=request("POST","/api/v2/internal/exports/"+id+"/commit",result);
        result=(ObjectNode)committed.path("archive");result.put("exportId",id).put("subjectId",frozen.path("subjectId").asText()).put("analysisEpoch",frozen.path("analysisEpoch").asLong());
        result.set("ranges",frozen.path("ranges"));return result;
    }
    private ObjectNode request(String method,String path,ObjectNode body)throws Exception{
        HttpRequest.Builder request=HttpRequest.newBuilder(base.resolve(path)).timeout(Duration.ofSeconds(45)).header("Authorization","Bearer "+token).header("Accept","application/json");
        if(body==null)request.GET();else request.header("Content-Type","application/json").method(method,HttpRequest.BodyPublishers.ofByteArray(Json.bytes(body)));
        HttpResponse<String> response=http.send(request.build(),HttpResponse.BodyHandlers.ofString());
        if(response.statusCode()==409||response.statusCode()==404)throw new IllegalArgumentException("Cloud export scope unavailable: HTTP "+response.statusCode());
        if(response.statusCode()!=200)throw new java.io.IOException("Cloud export API HTTP "+response.statusCode());
        return Json.parse(response.body());
    }
}
