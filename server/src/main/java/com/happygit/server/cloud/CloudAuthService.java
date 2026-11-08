package com.happygit.server.cloud;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.web.client.RestClient;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import java.net.*;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import static com.happygit.server.cloud.CloudJson.*;

@Service @Profile("cloud")
public class CloudAuthService {
    private final JdbcTemplate db;
    private final TransactionTemplate tx;
    private final RestClient http;
    private final String clientId, clientSecret, callback;
    public CloudAuthService(JdbcTemplate db, PlatformTransactionManager manager,
            @Value("${happygit.cloud.client-id}") String clientId,
            @Value("${happygit.cloud.client-secret}") String clientSecret,
            @Value("${happygit.cloud.callback-url}") String callback) {
        this.db = db; this.tx = new TransactionTemplate(manager);
        this.clientId = clientId; this.clientSecret = clientSecret; this.callback = callback;
        var factory = new JdkClientHttpRequestFactory(HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build());
        factory.setReadTimeout(Duration.ofSeconds(20)); this.http = RestClient.builder().requestFactory(factory).build();
    }
    public ObjectNode begin(JsonNode body) {
        String proof = body.path("codeChallenge").asText("");
        if (!proof.matches("[A-Za-z0-9_-]{43}")) throw error(400,"INVALID_PROOF","需要 S256 codeChallenge");
        if (clientId.isBlank() || clientSecret.isBlank() || callback.isBlank()) throw error(503,"AUTH_NOT_CONFIGURED","云端身份尚未配置");
        long now = System.currentTimeMillis();
        db.update("DELETE FROM cloud_logins WHERE expires_at < ?", now);
        if (db.queryForObject("SELECT COUNT(*) FROM cloud_logins",Long.class) >= 1000) throw error(429,"LOGIN_BUSY","请稍后发起授权");
        String id = secret(), state = secret(), verifier = secret(); long expires = now + 600_000;
        db.update("INSERT INTO cloud_logins VALUES(?,?,?,?,'pending',NULL,?)", id, proof, hash(state), verifier, expires);
        return object().put("challengeId",id).put("expiresAt",expires).put("intervalMs",1500)
                .put("authorizationUrl","https://github.com/login/oauth/authorize?client_id="+encode(clientId)+"&redirect_uri="+encode(callback)
                        +"&state="+state+"&code_challenge="+challenge(verifier)+"&code_challenge_method=S256&scope=read%3Auser");
    }
    public boolean callback(String state, String code, String denied) {
        if (state == null) return false;
        List<Map<String,Object>> rows = db.queryForList("SELECT * FROM cloud_logins WHERE state_hash=?", hash(state));
        if (rows.isEmpty()) return false;
        var pending = rows.get(0); String id = (String) pending.get("challenge_id"); long now = System.currentTimeMillis();
        if (db.update("UPDATE cloud_logins SET status='exchanging' WHERE challenge_id=? AND status='pending' AND expires_at>?",id,now) != 1) return false;
        try {
            if (denied != null || code == null) throw error(401,"AUTH_DENIED","授权未完成");
            JsonNode tokens = http.post().uri("https://github.com/login/oauth/access_token").header("Accept","application/json")
                    .body(Map.of("client_id",clientId,"client_secret",clientSecret,"code",code,"redirect_uri",callback,"code_verifier",pending.get("verifier")))
                    .retrieve().body(JsonNode.class);
            if (tokens == null || !tokens.hasNonNull("access_token")) throw error(401,"AUTH_DENIED","授权未完成");
            JsonNode identity = http.get().uri("https://api.github.com/user").header("Accept","application/vnd.github+json")
                    .header("Authorization","Bearer "+tokens.path("access_token").asText()).retrieve().body(JsonNode.class);
            if (identity == null || !identity.path("id").asText().matches("[0-9]+")) throw error(502,"INVALID_UPSTREAM_IDENTITY","GitHub 身份无效");
            return tx.execute(status -> {
                db.update("INSERT INTO cloud_users(subject_id,github_id,login,preferences_json,created_at) VALUES(?,?,?,'{\"manualTags\":[],\"hiddenRepoIds\":[]}',?) ON DUPLICATE KEY UPDATE login=VALUES(login)",
                        UUID.randomUUID().toString(),identity.path("id").asText(),identity.path("login").asText(),System.currentTimeMillis());
                String subject = db.queryForObject("SELECT subject_id FROM cloud_users WHERE github_id=?",String.class,identity.path("id").asText());
                return db.update("UPDATE cloud_logins SET status='authenticated',subject_id=? WHERE challenge_id=? AND status='exchanging' AND expires_at>?",subject,id,System.currentTimeMillis()) == 1;
            });
        } catch (RuntimeException failure) { db.update("UPDATE cloud_logins SET status='denied' WHERE challenge_id=?",id); return false; }
    }
    public ObjectNode poll(JsonNode body) {
        return tx.execute(status -> {
            var rows = db.queryForList("SELECT * FROM cloud_logins WHERE challenge_id=? FOR UPDATE",body.path("challengeId").asText());
            if (rows.isEmpty()) return object().put("state","expired");
            var row = rows.get(0);
            String verifier = body.path("codeVerifier").asText("");
            if (!verifier.matches("[A-Za-z0-9_-]{43,128}") || !challenge(verifier).equals(row.get("proof"))) throw error(403,"INVALID_PROOF","授权证明不匹配");
            if (((Number)row.get("expires_at")).longValue() < System.currentTimeMillis()) return object().put("state","expired");
            String state = (String)row.get("status");
            if (!state.equals("authenticated")) return object().put("state",state.equals("exchanging")?"pending":state);
            ObjectNode session = issue((String)row.get("subject_id"),null);
            db.update("UPDATE cloud_logins SET status='consumed',verifier='' WHERE challenge_id=?",row.get("challenge_id"));
            return session.put("state","authenticated");
        });
    }
    private ObjectNode issue(String subject, String device) {
        String access = secret(), refresh = secret(); long now = System.currentTimeMillis();
        db.update("INSERT INTO cloud_sessions VALUES(?,?,?,?,?,?,FALSE)",hash(access),hash(refresh),subject,device,now+3_600_000,now+30L*86400000);
        return object().put("accessToken",access).put("refreshToken",refresh).put("expiresAt",now+3_600_000).put("subjectId",subject)
                .put("accountId",db.queryForObject("SELECT github_id FROM cloud_users WHERE subject_id=?",String.class,subject));
    }
    public ObjectNode refresh(JsonNode body) {
        String token = body.path("refreshToken").asText("");
        if (!token.matches("[A-Za-z0-9_-]{43}")) throw error(401,"SESSION_EXPIRED","需要重新登录");
        return tx.execute(status -> {
            var rows = db.queryForList("SELECT * FROM cloud_sessions WHERE refresh_hash=? AND revoked=FALSE AND refresh_expires_at>? FOR UPDATE",hash(token),System.currentTimeMillis());
            if (rows.isEmpty()) throw error(401,"SESSION_EXPIRED","需要重新登录");
            var row = rows.get(0); db.update("UPDATE cloud_sessions SET revoked=TRUE WHERE access_hash=?",row.get("access_hash"));
            return issue((String)row.get("subject_id"),(String)row.get("device_id"));
        });
    }
    Map<String,Object> session(String authorization) {
        if (authorization == null || !authorization.matches("Bearer [A-Za-z0-9_-]{43}")) throw error(401,"SESSION_REQUIRED","需要应用会话");
        var rows = db.queryForList("SELECT * FROM cloud_sessions WHERE access_hash=? AND revoked=FALSE AND access_expires_at>?",hash(authorization.substring(7)),System.currentTimeMillis());
        if (rows.isEmpty()) throw error(401,"SESSION_EXPIRED","需要重新登录"); return rows.get(0);
    }
    public void logout(String authorization) {
        if (authorization==null||!authorization.matches("Bearer [A-Za-z0-9_-]{43}")) throw error(401,"SESSION_REQUIRED","需要应用会话");
        // The expired access credential can still revoke its associated refresh credential.
        db.update("UPDATE cloud_sessions SET revoked=TRUE WHERE access_hash=?",hash(authorization.substring(7)));
    }
    private static String encode(String value) { return URLEncoder.encode(value,StandardCharsets.UTF_8); }
}
