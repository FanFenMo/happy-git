package com.happygit.app.nativebridge;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.util.Base64;
import org.json.JSONObject;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CompletableFuture;

public class GitHubAuth {
    private final CredentialStore store;
    private final LocalRepository repository;
    private final String apiBaseUrl;
    private final boolean debug;
    private volatile String contextId = UUID.randomUUID().toString();
    private volatile String status = "guest";
    private long authorizationVersion;
    private final Object refreshLock = new Object();
    private final Map<String, Challenge> challenges = new ConcurrentHashMap<>();
    private static class Challenge {
        String verifier, expected;
        JSONObject data;
    }
    public GitHubAuth(Context context, LocalRepository repository, String apiBaseUrl) {
        this.store = new CredentialStore(context);
        this.repository = repository;
        this.apiBaseUrl = apiBaseUrl.replaceAll("/+$", "");
        this.debug = (context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }
    public String getCurrentContextId() { return contextId; }
    public String getStatus() { return status; }
    public String getCurrentAccountId() { JSONObject creds = store.read(); return creds == null ? null : creds.optString("accountId", null); }
    public void assertContext(String expected) { if (!contextId.equals(expected)) throw new IllegalStateException("SESSION_CHANGED"); }

    private JSONObject broker(String endpoint, JSONObject payload) throws Exception {
        if (apiBaseUrl.isEmpty()) throw new IllegalStateException("CONFIG_MISSING");
        URI uri = URI.create(apiBaseUrl);
        boolean loopback = "localhost".equals(uri.getHost()) || "127.0.0.1".equals(uri.getHost()) || "10.0.2.2".equals(uri.getHost());
        if ((!"https".equals(uri.getScheme()) && !(debug && loopback && "http".equals(uri.getScheme()))) || uri.getUserInfo() != null)
            throw new IllegalStateException("CONFIG_INVALID");
        HttpURLConnection conn = (HttpURLConnection) URI.create(apiBaseUrl + "/api/auth/github/" + endpoint).toURL().openConnection();
        conn.setInstanceFollowRedirects(false);
        conn.setConnectTimeout(10000); conn.setReadTimeout(25000);
        conn.setRequestMethod("POST"); conn.setRequestProperty("Content-Type", "application/json"); conn.setDoOutput(true);
        try {
            try (var output = conn.getOutputStream()) { output.write(payload.toString().getBytes(StandardCharsets.UTF_8)); }
            int code = conn.getResponseCode();
            if (code != 200) throw new IllegalStateException(code == 401 ? "AUTH_REQUIRED" : code == 503 ? "CONFIG_MISSING" : "AUTH_SERVICE_ERROR");
            try (InputStream input = conn.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[4096];
                int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                return new JSONObject(output.toString("UTF-8"));
            }
        } finally { conn.disconnect(); }
    }
    private static String secret() { byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes); return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING); }
    private static String hash(String value) throws Exception { return Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.US_ASCII)), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING); }

    public JSONObject beginAuthorization() throws Exception {
        final long version;
        final String expected = contextId;
        synchronized (this) { authorizationVersion++; version = authorizationVersion; challenges.clear(); }
        Challenge ch = new Challenge(); ch.verifier = secret(); ch.expected = expected;
        JSONObject data = broker("begin", new JSONObject().put("codeChallenge", hash(ch.verifier)));
        URI url = URI.create(data.getString("authorizationUrl"));
        if (!"https".equals(url.getScheme()) || !"github.com".equals(url.getHost()) || url.getPort() != -1 || url.getUserInfo() != null || !"/login/oauth/authorize".equals(url.getPath()))
            throw new IllegalStateException("AUTH_SERVICE_ERROR");
        synchronized (this) {
            assertContext(expected);
            if (version != authorizationVersion) throw new IllegalStateException("AUTH_CANCELLED");
            ch.data = data; challenges.put(data.getString("challengeId"), ch);
        }
        return data;
    }
    public JSONObject pollAuthorization(String id) throws Exception {
        Challenge ch = challenges.get(id);
        if (ch == null) return new JSONObject().put("state", "cancelled");
        synchronized (ch) {
            JSONObject data = broker("poll", new JSONObject().put("challengeId", id).put("codeVerifier", ch.verifier));
            if (!"authenticated".equals(data.optString("state"))) return data;
            JSONObject tokens = data.getJSONObject("tokens");
            GitHubClient.Response user = GitHubClient.request("currentUser", null, tokens.getString("access_token"));
            synchronized (this) {
                if (challenges.get(id) != ch || !contextId.equals(ch.expected)) return new JSONObject().put("state", "cancelled");
                if (user.status != 200 || !(user.body instanceof JSONObject)) throw new IllegalStateException("AUTH_VERIFY_FAILED");
                JSONObject profile = profile((JSONObject) user.body);
                JSONObject creds = new JSONObject().put("accountId", profile.getString("accountId"))
                        .put("accessToken", tokens.getString("access_token"))
                        .put("refreshToken", tokens.opt("refresh_token"))
                        .put("expiresAt", tokens.has("expires_in") ? System.currentTimeMillis() + tokens.getLong("expires_in") * 1000 : JSONObject.NULL);
                repository.saveProfile(profile.getString("accountId"), profile);
                store.save(creds);
                status = "authenticated"; contextId = UUID.randomUUID().toString(); challenges.remove(id);
                repository.saveSetting("mode", "account");
                return new JSONObject().put("state", "authenticated").put("session", session(profile));
            }
        }
    }
    public synchronized void cancelAuthorization(String id) {
        if (id == null) {
            authorizationVersion++;
            for (String key : challenges.keySet()) cancelAuthorization(key);
        } else {
            Challenge ch = challenges.remove(id);
            if (ch != null) CompletableFuture.runAsync(() -> {
                try { broker("cancel", new JSONObject().put("challengeId", id).put("codeVerifier", ch.verifier)); }
                catch (Exception ignored) { /* 本地取消已生效，服务端请求仍受有效期限制。 */ }
            });
        }
    }
    private void refresh(String expected, String staleToken) throws Exception {
        synchronized (refreshLock) {
            assertContext(expected);
            JSONObject creds = store.read();
            if (creds == null) throw new IllegalStateException("AUTH_REQUIRED");
            if (!creds.getString("accessToken").equals(staleToken)) return;
            if (creds.isNull("refreshToken")) { status = "reauthRequired"; throw new IllegalStateException("AUTH_REQUIRED"); }
            JSONObject tokens;
            try { tokens = broker("refresh", new JSONObject().put("refreshToken", creds.getString("refreshToken"))); }
            catch (Exception e) { if ("AUTH_REQUIRED".equals(e.getMessage()) && expected.equals(contextId)) status = "reauthRequired"; throw e; }
            synchronized (this) {
                assertContext(expected);
                creds.put("accessToken", tokens.getString("access_token"));
                if (tokens.has("refresh_token")) creds.put("refreshToken", tokens.getString("refresh_token"));
                creds.put("expiresAt", tokens.has("expires_in") ? System.currentTimeMillis() + tokens.getLong("expires_in") * 1000 : JSONObject.NULL);
                store.save(creds);
            }
        }
    }
    public String ensureAccessToken(String expected) throws Exception {
        assertContext(expected);
        JSONObject creds = store.read();
        if (creds == null || "reauthRequired".equals(status)) throw new IllegalStateException("AUTH_REQUIRED");
        if (!creds.isNull("expiresAt") && creds.getLong("expiresAt") - System.currentTimeMillis() < 60000) refresh(expected, creds.getString("accessToken"));
        assertContext(expected);
        return store.read().getString("accessToken");
    }
    public GitHubClient.Response request(String resource, JSONObject args, String expected) throws Exception {
        String token = ensureAccessToken(expected);
        GitHubClient.Response result = GitHubClient.request(resource, args, token);
        assertContext(expected);
        if (result.status == 401) {
            refresh(expected, token);
            result = GitHubClient.request(resource, args, ensureAccessToken(expected));
            assertContext(expected);
            if (result.status == 401) { status = "reauthRequired"; throw new IllegalStateException("AUTH_REQUIRED"); }
        }
        if (result.status < 400) status = "authenticated";
        return result;
    }
    public JSONObject restoreSession() throws Exception {
        String expected = contextId, id = getCurrentAccountId();
        if (id == null) return session(null);
        try {
            GitHubClient.Response user = request("currentUser", null, expected);
            synchronized (this) {
                assertContext(expected);
                if (user.status == 200 && user.body instanceof JSONObject) {
                    JSONObject profile = profile((JSONObject) user.body);
                    if (!id.equals(profile.getString("accountId"))) { status = "reauthRequired"; throw new IllegalStateException("AUTH_REQUIRED"); }
                    repository.saveProfile(id, profile); status = "authenticated"; return session(profile);
                }
                status = "offline";
            }
        } catch (Exception e) {
            assertContext(expected);
            if (!"reauthRequired".equals(status)) status = "AUTH_REQUIRED".equals(e.getMessage()) ? "reauthRequired" : "offline";
        }
        return session(repository.readAccountSnapshot(id).optJSONObject("profile"));
    }
    public synchronized void logout() {
        store.clear(); cancelAuthorization(null);
        contextId = UUID.randomUUID().toString(); status = "guest";
        repository.saveSetting("mode", "guest"); repository.saveSetting("active_account_id", null);
    }
    public JSONObject session(JSONObject profile) throws Exception {
        return new JSONObject().put("status", status).put("accountId", getCurrentAccountId() == null ? JSONObject.NULL : getCurrentAccountId())
                .put("contextId", contextId).put("profile", profile == null ? JSONObject.NULL : profile)
                .put("verifiedAt", "authenticated".equals(status) ? System.currentTimeMillis() : JSONObject.NULL);
    }
    private JSONObject profile(JSONObject raw) throws Exception {
        return new JSONObject().put("accountId", String.valueOf(raw.getLong("id"))).put("login", raw.getString("login"))
                .put("displayName", raw.isNull("name") ? raw.getString("login") : raw.getString("name"))
                .put("avatarUrl", raw.opt("avatar_url")).put("profileUrl", raw.opt("html_url"))
                .put("bio", raw.opt("bio")).put("location", raw.opt("location")).put("company", raw.opt("company"))
                .put("publicRepoCount", raw.optInt("public_repos")).put("followerCount", raw.optInt("followers"))
                .put("followingCount", raw.optInt("following")).put("fetchedAt", System.currentTimeMillis());
    }
}
