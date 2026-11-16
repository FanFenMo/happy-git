package com.happygit.server.cloud;

import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;
import static com.happygit.server.cloud.CloudJson.*;

@RestController @Profile("cloud") @RequestMapping("/api/v2")
public class CloudController {
    private final CloudAuthService auth; private final CloudIngestService ingest; private final CloudExportService exports; private final String admin;
    public CloudController(CloudAuthService auth,CloudIngestService ingest,CloudExportService exports,@Value("${happygit.cloud.admin-token}") String admin) {
        this.auth=auth;this.ingest=ingest;this.exports=exports;this.admin=admin;
    }
    @PostMapping("/auth/github/begin") public Object begin(@RequestBody JsonNode body) { return auth.begin(body); }
    @PostMapping("/auth/github/poll") public Object poll(@RequestBody JsonNode body) { return auth.poll(body); }
    @GetMapping(value="/auth/github/callback",produces=MediaType.TEXT_HTML_VALUE)
    public ResponseEntity<String> callback(@RequestParam(required=false) String state,@RequestParam(required=false) String code,@RequestParam(required=false) String error) {
        boolean ok=auth.callback(state,code,error);
        return ResponseEntity.status(ok?200:400).body("<!doctype html><html lang=zh-CN><meta charset=utf-8><title>HappyGit 云端身份</title><p>"+(ok?"云端身份核验完成，请返回 HappyGit。":"授权未完成，请返回 HappyGit 重试。")+"</p></html>");
    }
    @PostMapping("/session/refresh") public Object refresh(@RequestBody JsonNode body) { return auth.refresh(body); }
    @PostMapping("/session/logout") public Object logout(@RequestHeader(value="Authorization",required=false) String token) { auth.logout(token); return Map.of("state","revoked"); }
    @PostMapping("/devices/register") public Object register(@RequestHeader(value="Authorization",required=false) String token,@RequestBody JsonNode body) { return ingest.register(token,body); }
    @PostMapping("/events/batches") public Object events(@RequestHeader(value="Authorization",required=false) String token,@RequestBody JsonNode body) { return ingest.events(token,body); }
    @GetMapping("/me/preferences") public Object preferences(@RequestHeader(value="Authorization",required=false) String token) { return ingest.preferences(token); }
    @PutMapping("/me/preferences") public Object preferences(@RequestHeader(value="Authorization",required=false) String token,@RequestBody JsonNode body) { return ingest.updatePreferences(token,body,false); }
    @PostMapping("/me/analysis/reset") public Object reset(@RequestHeader(value="Authorization",required=false) String token,@RequestBody JsonNode body) { return ingest.updatePreferences(token,body,true); }
    @PutMapping("/me/collections") public Object collections(@RequestHeader(value="Authorization",required=false) String token,@RequestBody JsonNode body) { return ingest.collections(token,body); }
    @PostMapping("/internal/exports/prepare") public Object prepare(@RequestHeader(value="Authorization",required=false) String token) { admin(token);return exports.prepare(); }
    @GetMapping("/internal/exports/{id}") public Object export(@RequestHeader(value="Authorization",required=false) String token,@PathVariable String id) { admin(token);return exports.load(id); }
    @PostMapping("/internal/exports/{id}/commit") public Object commit(@RequestHeader(value="Authorization",required=false) String token,@PathVariable String id,@RequestBody JsonNode body) { admin(token);return exports.commit(id,body); }
    @GetMapping("/internal/analysis-scopes") public Object scopes(@RequestHeader(value="Authorization",required=false) String token) { admin(token);return exports.scopes(); }
    private void admin(String token) {
        if (admin.length()<32||token==null||!MessageDigest.isEqual(("Bearer "+admin).getBytes(StandardCharsets.UTF_8),token.getBytes(StandardCharsets.UTF_8))) throw error(403,"ADMIN_REQUIRED","需要数据平台服务凭据");
    }
    @ExceptionHandler(CloudProblem.class) public ResponseEntity<?> problem(CloudProblem error) { return ResponseEntity.status(error.status).body(Map.of("code",error.code,"message",error.getMessage())); }
    @ExceptionHandler(org.springframework.http.converter.HttpMessageNotReadableException.class)
    public ResponseEntity<?> malformedJson() { return ResponseEntity.badRequest().body(Map.of("code","INVALID_JSON","message","需要合法 JSON 正文")); }
    @ExceptionHandler(org.springframework.dao.DataAccessException.class)
    public ResponseEntity<?> persistenceUnavailable() { return ResponseEntity.status(503).body(Map.of("code","PERSISTENCE_UNAVAILABLE","message","业务存储暂不可用；本次请求未获得持久确认，请保留原身份重试")); }
}
