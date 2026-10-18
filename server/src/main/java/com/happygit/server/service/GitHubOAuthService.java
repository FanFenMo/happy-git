package com.happygit.server.service;

import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.web.client.RestClient;
import org.springframework.web.server.ResponseStatusException;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.Base64;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import org.springframework.http.client.JdkClientHttpRequestFactory;

@Service
public class GitHubOAuthService {
    private static final long TTL = 10 * 60 * 1000;
    private final SecureRandom random = new SecureRandom();
    private final Map<String, PendingLogin> logins = new ConcurrentHashMap<>();
    private final RestClient http;
    private final String clientId;
    private final String clientSecret;
    private final String callbackUrl;
    private final String appType;
    private final String githubUrl;

    private static class PendingLogin {
        final String id, proof, state, verifier;
        final long expiresAt = System.currentTimeMillis() + TTL;
        String status = "pending";
        JsonNode tokens;
        PendingLogin(String id, String proof, String state, String verifier) {
            this.id = id; this.proof = proof; this.state = state; this.verifier = verifier;
        }
    }

    public GitHubOAuthService(
            @Value("${happygit.oauth.client-id:}") String clientId,
            @Value("${happygit.oauth.client-secret:}") String clientSecret,
            @Value("${happygit.oauth.callback-url:}") String callbackUrl,
            @Value("${happygit.oauth.app-type:oauth-app}") String appType,
            @Value("${happygit.oauth.github-url:https://github.com}") String githubUrl) {
        this.clientId = clientId; this.clientSecret = clientSecret;
        this.callbackUrl = callbackUrl; this.appType = appType; this.githubUrl = githubUrl;
        var factory = new JdkClientHttpRequestFactory(HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10)).followRedirects(HttpClient.Redirect.NEVER).build());
        factory.setReadTimeout(Duration.ofSeconds(20));
        this.http = RestClient.builder().requestFactory(factory).build();
    }

    public Map<String, Object> begin(String proof) {
        if (clientId.isBlank() || clientSecret.isBlank() || callbackUrl.isBlank())
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "GitHub 网页授权尚未配置");
        if (proof == null || !proof.matches("[A-Za-z0-9_-]{43}"))
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "无效的授权请求");
        evictExpired();
        if (logins.size() >= 1000) throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS);
        var pending = new PendingLogin(secret(), proof, secret(), secret());
        logins.put(pending.id, pending);
        String url = githubUrl + "/login/oauth/authorize?client_id=" + encode(clientId)
                + "&redirect_uri=" + encode(callbackUrl) + "&state=" + pending.state
                + "&code_challenge=" + hash(pending.verifier) + "&code_challenge_method=S256&prompt=select_account";
        if (!"github-app".equals(appType)) url += "&scope=read%3Auser%20public_repo";
        return Map.of("challengeId", pending.id, "authorizationUrl", url,
                "expiresAt", pending.expiresAt, "intervalMs", 1500);
    }

    public boolean callback(String state, String code, String error) {
        var pending = logins.values().stream().filter(p -> p.state.equals(state)).findFirst().orElse(null);
        if (pending == null) return false;
        synchronized (pending) {
            if (pending.expiresAt < System.currentTimeMillis() || !pending.status.equals("pending")) return false;
            if (error != null || code == null) { pending.status = "denied"; return false; }
            pending.status = "exchanging";
        }
        try {
            JsonNode tokens = exchange(Map.of("client_id", clientId, "client_secret", clientSecret,
                    "code", code, "redirect_uri", callbackUrl, "code_verifier", pending.verifier));
            synchronized (pending) {
                if (!pending.status.equals("exchanging") || pending.expiresAt < System.currentTimeMillis()) return false;
                pending.tokens = tokens;
                pending.status = "authenticated";
            }
            return true;
        } catch (RuntimeException e) {
            synchronized (pending) { if (pending.status.equals("exchanging")) pending.status = "error"; }
            return false;
        }
    }

    public Map<String, Object> poll(String id, String verifier, boolean cancel) {
        var pending = logins.get(id == null ? "" : id);
        if (pending == null) return Map.of("state", "expired");
        if (verifier == null || !MessageDigest.isEqual(pending.proof.getBytes(StandardCharsets.US_ASCII),
                hash(verifier).getBytes(StandardCharsets.US_ASCII)))
            throw new ResponseStatusException(HttpStatus.FORBIDDEN);
        synchronized (pending) {
            if (cancel) {
                pending.status = "cancelled"; pending.tokens = null; logins.remove(pending.id);
                return Map.of("state", "cancelled");
            }
            if (pending.expiresAt < System.currentTimeMillis()) {
                logins.remove(pending.id); return Map.of("state", "expired");
            }
            if (pending.status.equals("authenticated")) {
                var result = Map.<String, Object>of("state", "authenticated", "tokens", pending.tokens);
                pending.tokens = null; pending.status = "consumed"; logins.remove(pending.id);
                return result;
            }
            return Map.of("state", pending.status.equals("exchanging") ? "pending" : pending.status,
                    "nextPollAt", System.currentTimeMillis() + 1500);
        }
    }

    public JsonNode refresh(String token) {
        if (token == null || token.isBlank() || token.length() > 2048)
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
        return exchange(Map.of("client_id", clientId, "client_secret", clientSecret,
                "grant_type", "refresh_token", "refresh_token", token));
    }

    @Scheduled(fixedDelay = 60000)
    public void evictExpired() {
        logins.values().removeIf(p -> {
            synchronized (p) {
                if (p.expiresAt >= System.currentTimeMillis()) return false;
                p.status = "expired"; p.tokens = null;
                return true;
            }
        });
    }

    private JsonNode exchange(Map<String, String> body) {
        JsonNode result;
        try {
            result = http.post().uri(githubUrl + "/login/oauth/access_token")
                    .header("Accept", "application/json").body(body).retrieve().body(JsonNode.class);
        } catch (RuntimeException e) {
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "GitHub 授权服务暂时不可用");
        }
        if (result == null || !result.hasNonNull("access_token"))
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "GitHub 授权已失效，请重新登录");
        return result;
    }

    private String secret() { byte[] bytes = new byte[32]; random.nextBytes(bytes); return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes); }
    private static String encode(String value) { return URLEncoder.encode(value, StandardCharsets.UTF_8); }
    private static String hash(String value) {
        try { return Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.US_ASCII))); }
        catch (java.security.NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }
}
