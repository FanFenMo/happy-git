package com.happygit.app.nativebridge;

import android.content.Context;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

public class GitHubAuth {

    private final CredentialStore credentialStore;
    private final LocalRepository localRepository;
    private final String clientId;

    private String currentContextId = "ctx_" + System.currentTimeMillis();
    private final Map<String, Challenge> activeChallenges = new ConcurrentHashMap<>();

    private static class Challenge {
        String clientId;
        String deviceCode;
        String userCode;
        String verificationUri;
        long expiresAt;
        long intervalMs;
        long nextPollAt;
    }

    public GitHubAuth(Context context, LocalRepository localRepository, String clientId) {
        this.credentialStore = new CredentialStore(context);
        this.localRepository = localRepository;
        this.clientId = clientId != null ? clientId : "";
    }

    public String getCurrentContextId() {
        return currentContextId;
    }

    public synchronized JSONObject beginAuthorization() throws Exception {
        if (clientId.isEmpty()) {
            throw new IllegalStateException("CONFIG_MISSING");
        }

        URL url = URI.create("https://github.com/login/device/code").toURL();
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("POST");
        conn.setRequestProperty("Accept", "application/json");
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setDoOutput(true);

        JSONObject payload = new JSONObject();
        payload.put("client_id", clientId);
        payload.put("scope", "offline_access");

        try (OutputStream os = conn.getOutputStream()) {
            os.write(payload.toString().getBytes("UTF-8"));
        }

        if (conn.getResponseCode() != 200) {
            throw new IllegalStateException("AUTH_BEGIN_FAILED: " + conn.getResponseCode());
        }

        JSONObject resp;
        try (InputStream is = conn.getInputStream();
             BufferedReader reader = new BufferedReader(new InputStreamReader(is, "UTF-8"))) {
            StringBuilder sb = new StringBuilder();
            String l;
            while ((l = reader.readLine()) != null) sb.append(l);
            resp = new JSONObject(sb.toString());
        }

        String challengeId = "ch_" + System.currentTimeMillis() + "_" + UUID.randomUUID().toString().substring(0, 6);
        long now = System.currentTimeMillis();
        long intervalMs = resp.optLong("interval", 5) * 1000;

        Challenge ch = new Challenge();
        ch.clientId = clientId;
        ch.deviceCode = resp.getString("device_code");
        ch.userCode = resp.getString("user_code");
        ch.verificationUri = resp.getString("verification_uri");
        ch.expiresAt = now + resp.optLong("expires_in", 900) * 1000;
        ch.intervalMs = intervalMs;
        ch.nextPollAt = now + intervalMs;
        activeChallenges.put(challengeId, ch);

        JSONObject result = new JSONObject();
        result.put("challengeId", challengeId);
        result.put("userCode", ch.userCode);
        result.put("verificationUri", ch.verificationUri);
        result.put("expiresAt", ch.expiresAt);
        result.put("intervalMs", ch.intervalMs);
        return result;
    }

    public synchronized JSONObject pollAuthorization(String challengeId) throws Exception {
        Challenge ch = activeChallenges.get(challengeId);
        if (ch == null) {
            JSONObject r = new JSONObject();
            r.put("state", "cancelled");
            r.put("nextPollAt", JSONObject.NULL);
            return r;
        }

        long now = System.currentTimeMillis();
        if (now > ch.expiresAt) {
            activeChallenges.remove(challengeId);
            JSONObject r = new JSONObject();
            r.put("state", "expired");
            r.put("nextPollAt", JSONObject.NULL);
            return r;
        }

        URL url = URI.create("https://github.com/login/oauth/access_token").toURL();
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("POST");
        conn.setRequestProperty("Accept", "application/json");
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setDoOutput(true);

        JSONObject payload = new JSONObject();
        payload.put("client_id", ch.clientId);
        payload.put("device_code", ch.deviceCode);
        payload.put("grant_type", "urn:ietf:params:oauth:grant-type:device_code");

        try (OutputStream os = conn.getOutputStream()) {
            os.write(payload.toString().getBytes("UTF-8"));
        }

        JSONObject resp;
        try (InputStream is = conn.getInputStream();
             BufferedReader reader = new BufferedReader(new InputStreamReader(is, "UTF-8"))) {
            StringBuilder sb = new StringBuilder();
            String l;
            while ((l = reader.readLine()) != null) sb.append(l);
            resp = new JSONObject(sb.toString());
        }

        if (resp.has("error")) {
            String err = resp.getString("error");
            if ("authorization_pending".equals(err)) {
                ch.nextPollAt = now + ch.intervalMs;
                JSONObject r = new JSONObject();
                r.put("state", "pending");
                r.put("nextPollAt", ch.nextPollAt);
                return r;
            }
            if ("slow_down".equals(err)) {
                ch.intervalMs = resp.optLong("interval", 10) * 1000;
                ch.nextPollAt = now + ch.intervalMs;
                JSONObject r = new JSONObject();
                r.put("state", "slowDown");
                r.put("nextPollAt", ch.nextPollAt);
                return r;
            }
            if ("expired_token".equals(err)) {
                activeChallenges.remove(challengeId);
                JSONObject r = new JSONObject();
                r.put("state", "expired");
                r.put("nextPollAt", JSONObject.NULL);
                return r;
            }
            activeChallenges.remove(challengeId);
            JSONObject r = new JSONObject();
            r.put("state", "denied");
            r.put("nextPollAt", JSONObject.NULL);
            return r;
        }

        if (resp.has("access_token")) {
            activeChallenges.remove(challengeId);
            String accessToken = resp.getString("access_token");

            GitHubClient.Response userRes = GitHubClient.request("currentUser", null, accessToken);
            if (userRes.status != 200 || userRes.body == null) {
                throw new IllegalStateException("VERIFY_USER_FAILED");
            }

            JSONObject rawUser = userRes.body;
            String accountId = String.valueOf(rawUser.getLong("id"));
            JSONObject profile = new JSONObject();
            profile.put("accountId", accountId);
            profile.put("login", rawUser.getString("login"));
            profile.put("displayName", rawUser.optString("name", rawUser.getString("login")));
            profile.put("avatarUrl", rawUser.optString("avatar_url", null));
            profile.put("profileUrl", rawUser.optString("html_url", "https://github.com/" + rawUser.getString("login")));
            profile.put("bio", rawUser.optString("bio", null));
            profile.put("location", rawUser.optString("location", null));
            profile.put("company", rawUser.optString("company", null));
            profile.put("publicRepoCount", rawUser.optInt("public_repos", 0));
            profile.put("followerCount", rawUser.optInt("followers", 0));
            profile.put("followingCount", rawUser.optInt("following", 0));
            profile.put("fetchedAt", now);

            JSONObject creds = new JSONObject();
            creds.put("accountId", accountId);
            creds.put("login", rawUser.getString("login"));
            creds.put("accessToken", accessToken);
            creds.put("refreshToken", resp.optString("refresh_token", null));
            creds.put("expiresAt", resp.has("expires_in") ? now + resp.getLong("expires_in") * 1000 : JSONObject.NULL);
            creds.put("clientId", ch.clientId);

            localRepository.saveProfile(accountId, profile);
            credentialStore.save(creds);
            localRepository.saveSetting("mode", "account");
            localRepository.saveSetting("active_account_id", accountId);

            currentContextId = "ctx_" + System.currentTimeMillis();

            JSONObject session = new JSONObject();
            session.put("status", "authenticated");
            session.put("accountId", accountId);
            session.put("contextId", currentContextId);
            session.put("profile", profile);
            session.put("verifiedAt", now);

            JSONObject r = new JSONObject();
            r.put("state", "authenticated");
            r.put("nextPollAt", JSONObject.NULL);
            r.put("session", session);
            return r;
        }

        JSONObject r = new JSONObject();
        r.put("state", "pending");
        r.put("nextPollAt", now + ch.intervalMs);
        return r;
    }

    public void cancelAuthorization(String challengeId) {
        activeChallenges.remove(challengeId);
    }

    public synchronized String ensureAccessToken() throws Exception {
        JSONObject creds = credentialStore.read();
        if (creds == null || !creds.has("accessToken")) {
            throw new IllegalStateException("AUTH_REQUIRED");
        }
        long now = System.currentTimeMillis();
        if (creds.has("expiresAt") && !creds.isNull("expiresAt")) {
            long expiresAt = creds.getLong("expiresAt");
            if (expiresAt - now < 60000 && creds.has("refreshToken") && !creds.isNull("refreshToken")) {
                refreshAccessToken(creds);
                creds = credentialStore.read();
            }
        }
        return creds.getString("accessToken");
    }

    private synchronized void refreshAccessToken(JSONObject creds) throws Exception {
        URL url = URI.create("https://github.com/login/oauth/access_token").toURL();
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("POST");
        conn.setRequestProperty("Accept", "application/json");
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setDoOutput(true);

        JSONObject payload = new JSONObject();
        payload.put("client_id", creds.optString("clientId", clientId));
        payload.put("grant_type", "refresh_token");
        payload.put("refresh_token", creds.getString("refreshToken"));

        try (OutputStream os = conn.getOutputStream()) {
            os.write(payload.toString().getBytes("UTF-8"));
        }

        JSONObject resp;
        try (InputStream is = conn.getInputStream();
             BufferedReader reader = new BufferedReader(new InputStreamReader(is, "UTF-8"))) {
            StringBuilder sb = new StringBuilder();
            String l;
            while ((l = reader.readLine()) != null) sb.append(l);
            resp = new JSONObject(sb.toString());
        }

        if (resp.has("access_token")) {
            long now = System.currentTimeMillis();
            creds.put("accessToken", resp.getString("access_token"));
            if (resp.has("refresh_token")) creds.put("refreshToken", resp.getString("refresh_token"));
            if (resp.has("expires_in")) creds.put("expiresAt", now + resp.getLong("expires_in") * 1000);
            credentialStore.save(creds);
        } else {
            throw new IllegalStateException("REFRESH_FAILED");
        }
    }

    public synchronized JSONObject restoreSession() {
        JSONObject creds = credentialStore.read();
        if (creds == null || !creds.has("accountId")) {
            JSONObject s = new JSONObject();
            try {
                s.put("status", "guest");
                s.put("accountId", JSONObject.NULL);
                s.put("contextId", currentContextId);
                s.put("profile", JSONObject.NULL);
                s.put("verifiedAt", JSONObject.NULL);
            } catch (Exception ignored) {}
            return s;
        }

        String accountId = creds.optString("accountId");
        long now = System.currentTimeMillis();
        try {
            String token = ensureAccessToken();
            GitHubClient.Response userRes = GitHubClient.request("currentUser", null, token);
            if (userRes.status == 200 && userRes.body != null) {
                JSONObject rawUser = userRes.body;
                JSONObject profile = new JSONObject();
                profile.put("accountId", accountId);
                profile.put("login", rawUser.getString("login"));
                profile.put("displayName", rawUser.optString("name", rawUser.getString("login")));
                profile.put("avatarUrl", rawUser.optString("avatar_url", null));
                profile.put("profileUrl", rawUser.optString("html_url", "https://github.com/" + rawUser.getString("login")));
                profile.put("bio", rawUser.optString("bio", null));
                profile.put("location", rawUser.optString("location", null));
                profile.put("company", rawUser.optString("company", null));
                profile.put("publicRepoCount", rawUser.optInt("public_repos", 0));
                profile.put("followerCount", rawUser.optInt("followers", 0));
                profile.put("followingCount", rawUser.optInt("following", 0));
                profile.put("fetchedAt", now);

                localRepository.saveProfile(accountId, profile);

                JSONObject s = new JSONObject();
                s.put("status", "authenticated");
                s.put("accountId", accountId);
                s.put("contextId", currentContextId);
                s.put("profile", profile);
                s.put("verifiedAt", now);
                return s;
            }
        } catch (Exception ignored) {}

        // 离线会话恢复
        try {
            JSONObject snap = localRepository.readAccountSnapshot(accountId);
            if (snap != null && snap.has("profile") && !snap.isNull("profile")) {
                JSONObject s = new JSONObject();
                s.put("status", "offline");
                s.put("accountId", accountId);
                s.put("contextId", currentContextId);
                s.put("profile", snap.getJSONObject("profile"));
                s.put("verifiedAt", snap.getJSONObject("profile").optLong("fetchedAt", now));
                return s;
            }
        } catch (Exception ignored) {}

        JSONObject s = new JSONObject();
        try {
            s.put("status", "guest");
            s.put("accountId", JSONObject.NULL);
            s.put("contextId", currentContextId);
            s.put("profile", JSONObject.NULL);
            s.put("verifiedAt", JSONObject.NULL);
        } catch (Exception ignored) {}
        return s;
    }

    public synchronized void logout() {
        credentialStore.clear();
        currentContextId = "ctx_" + System.currentTimeMillis();
        localRepository.saveSetting("mode", "guest");
        localRepository.saveSetting("active_account_id", null);
    }

    public String getCurrentAccountId() {
        JSONObject creds = credentialStore.read();
        return creds != null ? creds.optString("accountId", null) : null;
    }
}
