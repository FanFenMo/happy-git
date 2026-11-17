package com.happygit.app.nativebridge;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

public class CloudService {

    private final Context context;
    private final LocalRepository localRepository;
    private final CredentialStore credentialStore;
    private final Map<String, JSONObject> authChallenges = new ConcurrentHashMap<>();
    private final Set<String> flushingAccounts = ConcurrentHashMap.newKeySet();

    public CloudService(Context context, LocalRepository localRepository) {
        this.context = context;
        this.localRepository = localRepository;
        this.credentialStore = new CredentialStore(context);
    }

    private String getBaseUrl() {
        String custom = localRepository.readSetting("cloud_base_url");
        if (custom != null && !custom.trim().isEmpty()) {
            String unquoted = custom.replace("\"", "").trim();
            if (!unquoted.isEmpty()) {
                return unquoted.replaceAll("/+$", "");
            }
        }
        return "http://10.0.2.2:8080";
    }

    private synchronized JSONObject readTokens(String accountId) {
        if (accountId == null || accountId.isEmpty()) return null;
        JSONObject root = credentialStore.read();
        if (root == null) return null;
        JSONObject cloudMap = root.optJSONObject("cloudTokens");
        return cloudMap != null ? cloudMap.optJSONObject(accountId) : null;
    }

    private synchronized void saveTokens(String accountId, JSONObject tokenRecord) {
        try {
            JSONObject root = credentialStore.read();
            if (root == null) root = new JSONObject();
            JSONObject cloudMap = root.optJSONObject("cloudTokens");
            if (cloudMap == null) cloudMap = new JSONObject();
            if (tokenRecord == null) {
                cloudMap.remove(accountId);
            } else {
                cloudMap.put(accountId, tokenRecord);
            }
            root.put("cloudTokens", cloudMap);
            credentialStore.save(root);
        } catch (Exception e) {
            throw new IllegalStateException("STORAGE_UNAVAILABLE", e);
        }
    }

    private JSONObject requestJson(String path, String method, String bearerToken, JSONObject body) throws Exception {
        URL url = new URL(getBaseUrl() + path);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(25000);
        conn.setRequestMethod(method);
        conn.setRequestProperty("Accept", "application/json");
        if (bearerToken != null && !bearerToken.isEmpty()) {
            conn.setRequestProperty("Authorization", "Bearer " + bearerToken);
        }
        if (body != null) {
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(payload);
            }
        }

        int status = conn.getResponseCode();
        InputStream is = status >= 200 && status < 300 ? conn.getInputStream() : conn.getErrorStream();
        StringBuilder sb = new StringBuilder();
        if (is != null) {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    sb.append(line);
                }
            }
        }

        JSONObject parsed = sb.length() > 0 ? new JSONObject(sb.toString()) : new JSONObject();
        if (status < 200 || status >= 300) {
            JSONObject errObj = parsed.optJSONObject("error");
            String code = errObj != null ? errObj.optString("code", "HTTP_" + status) : parsed.optString("code", "HTTP_" + status);
            throw new IllegalStateException(code);
        }
        return parsed;
    }

    private String getValidAccessToken(String accountId) {
        JSONObject tokens = readTokens(accountId);
        if (tokens == null || tokens.optString("accessToken", "").isEmpty()) return null;
        long now = System.currentTimeMillis();
        if (tokens.optLong("expiresAt", 0) > now + 30000L) {
            return tokens.optString("accessToken");
        }
        String refreshToken = tokens.optString("refreshToken", "");
        if (refreshToken.isEmpty()) return null;
        try {
            JSONObject req = new JSONObject();
            req.put("refreshToken", refreshToken);
            JSONObject refreshed = requestJson("/api/v2/session/refresh", "POST", null, req);
            tokens.put("accessToken", refreshed.optString("accessToken"));
            if (refreshed.has("refreshToken")) tokens.put("refreshToken", refreshed.optString("refreshToken"));
            tokens.put("expiresAt", refreshed.optLong("expiresAt", now + 3600000L));
            saveTokens(accountId, tokens);
            return tokens.optString("accessToken");
        } catch (Exception e) {
            return null;
        }
    }

    private static String base64Url(byte[] bytes) {
        return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }

    public JSONObject beginAuth(String accountId, boolean openBrowser) throws Exception {
        if (accountId == null || accountId.isEmpty()) {
            throw new IllegalStateException("AUTH_REQUIRED");
        }
        byte[] verifierBytes = new byte[32];
        new SecureRandom().nextBytes(verifierBytes);
        String codeVerifier = base64Url(verifierBytes);
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(codeVerifier.getBytes(StandardCharsets.UTF_8));
        String codeChallenge = base64Url(digest);

        JSONObject req = new JSONObject();
        req.put("codeChallenge", codeChallenge);
        JSONObject res = requestJson("/api/v2/auth/github/begin", "POST", null, req);

        String challengeId = res.getString("challengeId");
        String authorizeUrl = res.optString("authorizeUrl", "");
        JSONObject ch = new JSONObject();
        ch.put("challengeId", challengeId);
        ch.put("codeVerifier", codeVerifier);
        ch.put("authorizeUrl", authorizeUrl);
        ch.put("expiresAt", res.optLong("expiresAt", System.currentTimeMillis() + 300000L));
        ch.put("accountId", accountId);
        authChallenges.put(challengeId, ch);

        if (openBrowser && !authorizeUrl.isEmpty()) {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(authorizeUrl));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
        }

        JSONObject out = new JSONObject();
        out.put("challengeId", challengeId);
        out.put("authorizeUrl", authorizeUrl);
        out.put("expiresAt", ch.optLong("expiresAt"));
        out.put("state", "pending");
        return out;
    }

    public JSONObject pollAuth(String accountId, String challengeId) throws Exception {
        JSONObject ch = authChallenges.get(challengeId);
        if (ch == null) {
            JSONObject out = new JSONObject();
            out.put("state", "failed");
            return out;
        }

        JSONObject req = new JSONObject();
        req.put("challengeId", challengeId);
        req.put("codeVerifier", ch.getString("codeVerifier"));
        JSONObject res = requestJson("/api/v2/auth/github/poll", "POST", null, req);

        if (!"authenticated".equals(res.optString("state"))) {
            JSONObject out = new JSONObject();
            out.put("challengeId", challengeId);
            out.put("state", res.optString("state", "pending"));
            return out;
        }

        authChallenges.remove(challengeId);
        String localAcc = accountId != null ? accountId : ch.optString("accountId");
        String cloudAcc = String.valueOf(res.opt("accountId"));

        if (!localAcc.equals(cloudAcc)) {
            JSONObject patch = new JSONObject();
            patch.put("subjectId", res.optString("subjectId"));
            patch.put("cloudAccountId", cloudAcc);
            patch.put("cloudBound", false);
            localRepository.saveCloudAccountState(localAcc, patch);

            JSONObject out = new JSONObject();
            out.put("challengeId", challengeId);
            out.put("state", "account_mismatch");
            return out;
        }

        JSONObject tokenRec = new JSONObject();
        tokenRec.put("accessToken", res.optString("accessToken"));
        tokenRec.put("refreshToken", res.optString("refreshToken"));
        tokenRec.put("expiresAt", res.optLong("expiresAt"));
        tokenRec.put("subjectId", res.optString("subjectId"));
        tokenRec.put("cloudAccountId", cloudAcc);
        saveTokens(localAcc, tokenRec);

        JSONObject patch = new JSONObject();
        patch.put("subjectId", res.optString("subjectId"));
        patch.put("cloudAccountId", cloudAcc);
        patch.put("cloudBound", true);
        patch.put("sessionExpiresAt", res.optLong("expiresAt"));
        localRepository.saveCloudAccountState(localAcc, patch);

        registerDeviceAndSyncStream(localAcc);
        flushOutbox(localAcc);
        syncCollections(localAcc);

        JSONObject out = new JSONObject();
        out.put("challengeId", challengeId);
        out.put("state", "authenticated");
        out.put("cloudSync", localRepository.readCloudSyncState(localAcc));
        return out;
    }

    public JSONObject cancelAuth(String challengeId) throws Exception {
        if (challengeId != null) authChallenges.remove(challengeId);
        JSONObject out = new JSONObject();
        out.put("cancelled", true);
        return out;
    }

    public JSONObject restoreSession(String accountId) throws Exception {
        JSONObject out = new JSONObject();
        if (accountId == null || accountId.isEmpty()) {
            out.put("state", "unbound");
            out.put("cloudSync", JSONObject.NULL);
            return out;
        }
        String token = getValidAccessToken(accountId);
        if (token == null) {
            out.put("state", "unbound");
            out.put("cloudSync", localRepository.readCloudSyncState(accountId));
            return out;
        }
        try {
            registerDeviceAndSyncStream(accountId);
            try { flushPendingPreferencesMutations(accountId); } catch (Exception ignored) {}
            out.put("state", "authenticated");
        } catch (Exception e) {
            out.put("state", "offline");
        }
        out.put("cloudSync", localRepository.readCloudSyncState(accountId));
        return out;
    }

    public JSONObject logoutSession(String accountId) throws Exception {
        if (accountId != null && !accountId.isEmpty()) {
            saveTokens(accountId, null);
            JSONObject patch = new JSONObject();
            patch.put("cloudBound", false);
            patch.put("sessionExpiresAt", JSONObject.NULL);
            localRepository.saveCloudAccountState(accountId, patch);
        }
        JSONObject out = new JSONObject();
        out.put("loggedOut", true);
        out.put("cloudSync", accountId != null ? localRepository.readCloudSyncState(accountId) : JSONObject.NULL);
        return out;
    }

    public JSONObject registerDeviceAndSyncStream(String accountId) throws Exception {
        String token = getValidAccessToken(accountId);
        if (token == null) throw new IllegalStateException("CLOUD_AUTH_REQUIRED");
        JSONObject localState = localRepository.readCloudSyncState(accountId);
        JSONObject req = new JSONObject();
        req.put("installationId", localState.getString("installationId"));
        JSONObject res = requestJson("/api/v2/devices/register", "POST", token, req);
        return localRepository.syncCloudStreamState(accountId, res);
    }

    public JSONObject flushOutbox(String accountId) throws Exception {
        JSONObject out = new JSONObject();
        if (accountId == null || accountId.isEmpty() || !flushingAccounts.add(accountId)) {
            out.put("flushed", false);
            out.put("cloudSync", accountId != null ? localRepository.readCloudSyncState(accountId) : JSONObject.NULL);
            return out;
        }
        try {
            JSONObject state = localRepository.readCloudSyncState(accountId);
            if (state == null || !state.optBoolean("cloudBound") || !state.optBoolean("accountMatched")) {
                out.put("flushed", false);
                out.put("cloudSync", state != null ? state : JSONObject.NULL);
                return out;
            }
            String token = getValidAccessToken(accountId);
            if (token == null) {
                out.put("flushed", false);
                out.put("cloudSync", state);
                return out;
            }
            try { flushPendingPreferencesMutations(accountId); } catch (Exception ignored) {}
            if (!state.optBoolean("analysisEnabled", true)) {
                out.put("flushed", false);
                out.put("cloudSync", localRepository.readCloudSyncState(accountId));
                return out;
            }
            if (state.isNull("deviceId") || state.optString("deviceId", "").isEmpty()) {
                state = registerDeviceAndSyncStream(accountId);
            }

            int batchesSent = 0;
            int eventsAcked = 0;
            while (true) {
                JSONObject batch = localRepository.readOutboxBatch(accountId, 500, 1048576);
                if (!batch.optBoolean("hasBatch", false)) break;

                JSONObject req = new JSONObject();
                req.put("requestId", batch.getString("requestId"));
                req.put("streamEpoch", batch.getString("streamEpoch"));
                req.put("analysisEpoch", batch.getLong("analysisEpoch"));
                req.put("firstSeq", batch.getLong("firstSeq"));
                req.put("events", batch.getJSONArray("events"));

                try {
                    JSONObject ack = requestJson("/api/v2/events/batches", "POST", token, req);
                    state = localRepository.applyOutboxAck(accountId, ack);
                    batchesSent++;
                    eventsAcked += batch.getJSONArray("events").length();
                } catch (Exception e) {
                    localRepository.recordOutboxError(accountId, e.getMessage(), System.currentTimeMillis() + 30000L);
                    break;
                }
            }

            out.put("flushed", true);
            out.put("batchesSent", batchesSent);
            out.put("eventsAcked", eventsAcked);
            out.put("cloudSync", localRepository.readCloudSyncState(accountId));
            return out;
        } finally {
            flushingAccounts.remove(accountId);
        }
    }

    public JSONObject syncCollections(String accountId) throws Exception {
        JSONObject out = new JSONObject();
        JSONObject state = localRepository.readCloudSyncState(accountId);
        if (state == null || !state.optBoolean("cloudBound") || !state.optBoolean("accountMatched") || !state.optBoolean("analysisEnabled", true)) {
            out.put("synced", false);
            out.put("cloudSync", state != null ? state : JSONObject.NULL);
            return out;
        }
        String token = getValidAccessToken(accountId);
        if (token == null) {
            out.put("synced", false);
            out.put("cloudSync", state);
            return out;
        }

        String[] kinds = new String[]{"stars", "owned"};
        for (String kind : kinds) {
            JSONObject prep = localRepository.readCollectionForCloudSync(accountId, kind);
            if (!prep.optBoolean("shouldUpload", false)) continue;
            JSONObject req = new JSONObject();
            JSONObject preferences = requestJson("/api/v2/me/preferences", "GET", token, null);
            req.put("operationId", prep.getString("operationId") + "_" + preferences.getLong("revision"));
            req.put("expectedRevision", preferences.getLong("revision"));
            req.put("analysisEpoch", prep.getLong("analysisEpoch"));
            req.put("collectionKind", kind);
            req.put("complete", true);
            req.put("observedAt", prep.getLong("observedAt"));
            req.put("repoIds", prep.getJSONArray("repoIds"));
            try {
                JSONObject res = requestJson("/api/v2/me/collections", "PUT", token, req);
                localRepository.markCollectionCloudSynced(
                        accountId, kind, res.optLong("revision", prep.getLong("expectedRevision") + 1),
                        true, prep.getString("snapshotHash"), prep.getString("operationId"));
            } catch (Exception ignored) {}
        }

        out.put("synced", true);
        out.put("cloudSync", localRepository.readCloudSyncState(accountId));
        return out;
    }

    public JSONObject syncPreferencesState(String accountId, String operationId, Boolean analysisEnabledOverride, JSONArray manualTagsOverride, JSONArray hiddenRepoIdsOverride, String tokenOverride) throws Exception {
        String token = tokenOverride != null ? tokenOverride : getValidAccessToken(accountId);
        if (token == null) throw new IllegalStateException("CLOUD_AUTH_REQUIRED");
        JSONObject localPref = localRepository.readCloudPreferencesSyncPayload(accountId);
        JSONObject remote = requestJson("/api/v2/me/preferences", "GET", token, null);

        boolean resolvedAnalysisEnabled = analysisEnabledOverride != null
                ? analysisEnabledOverride
                : localPref.optBoolean("analysisEnabled", remote.optBoolean("analysisEnabled", true));
        JSONArray resolvedManualTags = manualTagsOverride != null
                ? LocalRepository.sanitizeCloudIds(manualTagsOverride, 100, true)
                : localPref.optJSONArray("manualTags");
        if (resolvedManualTags == null) resolvedManualTags = new JSONArray();
        JSONArray resolvedHiddenRepoIds = hiddenRepoIdsOverride != null
                ? LocalRepository.sanitizeCloudIds(hiddenRepoIdsOverride, 20000, false)
                : localPref.optJSONArray("hiddenRepoIds");
        if (resolvedHiddenRepoIds == null) resolvedHiddenRepoIds = new JSONArray();

        String resolvedOpId = (operationId != null && !operationId.isEmpty())
                ? operationId
                : ("pref_" + accountId + "_" + System.currentTimeMillis());

        JSONObject req = new JSONObject();
        req.put("operationId", resolvedOpId);
        req.put("expectedRevision", remote.getLong("revision"));
        req.put("analysisEnabled", resolvedAnalysisEnabled);
        req.put("manualTags", resolvedManualTags);
        req.put("hiddenRepoIds", resolvedHiddenRepoIds);
        JSONObject updated = requestJson("/api/v2/me/preferences", "PUT", token, req);

        long prevEpoch = remote.optLong("analysisEpoch", 0);
        long nextEpoch = updated.optLong("analysisEpoch", prevEpoch);
        if (analysisEnabledOverride != null || prevEpoch != nextEpoch) {
            registerDeviceAndSyncStream(accountId);
        }
        return updated;
    }

    public JSONObject flushPendingPreferencesMutations(String accountId) {
        JSONObject out = new JSONObject();
        try {
            JSONArray pending = localRepository.readPendingClientMutations(accountId, "preferences");
            if (pending == null || pending.length() == 0) {
                out.put("flushed", true);
                out.put("count", 0);
                return out;
            }
            JSONObject latest = pending.getJSONObject(pending.length() - 1);
            syncPreferencesState(accountId, latest.getString("operationId"), null, null, null, null);
            for (int i = 0; i < pending.length(); i++) {
                localRepository.markClientMutationDone(pending.getJSONObject(i).getString("operationId"));
            }
            out.put("flushed", true);
            out.put("count", pending.length());
            return out;
        } catch (Exception e) {
            try {
                JSONArray pending = localRepository.readPendingClientMutations(accountId, "preferences");
                for (int i = 0; i < pending.length(); i++) {
                    localRepository.markClientMutationFailed(pending.getJSONObject(i).getString("operationId"), e.getMessage());
                }
                out.put("flushed", false);
                out.put("error", e.getMessage());
            } catch (Exception ignored) {}
            return out;
        }
    }

    public JSONObject syncFeedbackPreferences(String accountId, String operationId) throws Exception {
        JSONObject out = new JSONObject();
        JSONObject state = localRepository.readCloudSyncState(accountId);
        if (state == null || !state.optBoolean("cloudBound") || !state.optBoolean("accountMatched")) {
            out.put("synced", false);
            out.put("queued", false);
            return out;
        }
        String opId = (operationId != null && !operationId.isEmpty())
                ? operationId
                : ("pref_fb_" + accountId + "_" + System.currentTimeMillis());
        JSONObject payload = new JSONObject();
        payload.put("trigger", "feedback");
        localRepository.enqueueClientMutation(accountId, opId, "preferences", payload);
        JSONObject flushRes = flushPendingPreferencesMutations(accountId);
        out.put("synced", flushRes.optBoolean("flushed", false));
        out.put("queued", !flushRes.optBoolean("flushed", false));
        return out;
    }

    public JSONObject savePreferences(String accountId, JSONObject payload) throws Exception {
        localRepository.savePreferences(accountId, payload);
        boolean shouldSyncCloud = payload.has("analysisEnabled") || payload.has("manualTags") || payload.has("hiddenRepoIds") || payload.optBoolean("syncPreferences", false);
        if (shouldSyncCloud) {
            JSONObject state = localRepository.readCloudSyncState(accountId);
            if (state != null && state.optBoolean("cloudBound") && state.optBoolean("accountMatched")) {
                String opId = payload.optString("operationId", "");
                if (opId.isEmpty()) opId = "pref_" + accountId + "_" + System.currentTimeMillis();
                String token = getValidAccessToken(accountId);
                JSONObject meta = new JSONObject();
                meta.put("trigger", "savePreferences");
                if (token == null) {
                    localRepository.enqueueClientMutation(accountId, opId, "preferences", meta);
                } else {
                    try {
                        Boolean enabledOverride = payload.has("analysisEnabled") ? payload.optBoolean("analysisEnabled", true) : null;
                        JSONArray tagsOverride = payload.has("manualTags") && !payload.isNull("manualTags") ? payload.getJSONArray("manualTags") : null;
                        JSONArray hiddenOverride = payload.has("hiddenRepoIds") && !payload.isNull("hiddenRepoIds") ? payload.getJSONArray("hiddenRepoIds") : null;
                        syncPreferencesState(accountId, opId, enabledOverride, tagsOverride, hiddenOverride, token);
                        JSONArray pending = localRepository.readPendingClientMutations(accountId, "preferences");
                        for (int i = 0; i < pending.length(); i++) {
                            localRepository.markClientMutationDone(pending.getJSONObject(i).getString("operationId"));
                        }
                    } catch (Exception e) {
                        localRepository.enqueueClientMutation(accountId, opId, "preferences", meta);
                        localRepository.markClientMutationFailed(opId, e.getMessage());
                        if (!payload.optBoolean("bestEffort", false)) {
                            throw e;
                        }
                    }
                }
            }
        }
        JSONObject out = new JSONObject();
        out.put("saved", true);
        out.put("cloudSync", localRepository.readCloudSyncState(accountId));
        return out;
    }

    public JSONObject resetAnalysis(String accountId) throws Exception {
        JSONObject state = localRepository.readCloudSyncState(accountId);
        long nextEpoch = (state != null ? state.optLong("analysisEpoch", 1) : 1) + 1;
        boolean bound = state != null && state.optBoolean("cloudBound") && state.optBoolean("accountMatched");
        if (bound) {
            String token = getValidAccessToken(accountId);
            if (token == null) throw new IllegalStateException("CLOUD_AUTH_REQUIRED");
            JSONObject preferences = requestJson("/api/v2/me/preferences", "GET", token, null);
            JSONObject req = new JSONObject();
            req.put("expectedRevision", preferences.getLong("revision"));
            req.put("operationId", "reset_" + accountId + "_" + System.currentTimeMillis());
            JSONObject result = requestJson("/api/v2/me/analysis/reset", "POST", token, req);
            nextEpoch = result.getLong("analysisEpoch");
        }
        localRepository.resetCloudAnalysisLocalState(accountId, nextEpoch);
        if (bound) registerDeviceAndSyncStream(accountId);
        JSONObject out = new JSONObject();
        out.put("reset", true);
        out.put("analysisEpoch", nextEpoch);
        out.put("cloudSync", localRepository.readCloudSyncState(accountId));
        return out;
    }

    private String requestText(String path, String bearerToken) throws Exception {
        URL url = new URL(getBaseUrl() + path);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(25000);
        conn.setRequestMethod("GET");
        conn.setRequestProperty("Accept", "application/json");
        if (bearerToken != null && !bearerToken.isEmpty()) {
            conn.setRequestProperty("Authorization", "Bearer " + bearerToken);
        }
        int status = conn.getResponseCode();
        InputStream is = status >= 200 && status < 300 ? conn.getInputStream() : conn.getErrorStream();
        StringBuilder sb = new StringBuilder();
        if (is != null) {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (sb.length() > 0) sb.append('\n');
                    sb.append(line);
                }
            }
        }
        if (status < 200 || status >= 300) {
            throw new IllegalStateException("HTTP_" + status);
        }
        return sb.toString();
    }

    public JSONObject fetchVerifiedFeatureSpace(String bearerToken, String featureSpaceVersion) throws Exception {
        if (featureSpaceVersion == null || !featureSpaceVersion.matches("[a-f0-9]{64}")) {
            return null;
        }
        String raw = requestText("/api/v2/feature-spaces/" + featureSpaceVersion, bearerToken);
        String trimmed = raw.replaceAll("\\r?\\n$", "");
        String digestA = LocalRepository.sha256Hex(trimmed + "\n");
        String digestB = LocalRepository.sha256Hex(trimmed);
        if (!featureSpaceVersion.equals(digestA) && !featureSpaceVersion.equals(digestB)) {
            throw new IllegalStateException("FEATURE_SPACE_DIGEST_MISMATCH");
        }
        JSONObject parsed = new JSONObject(trimmed);
        JSONObject dictionary = parsed.optJSONObject("dictionary");
        if (dictionary != null) {
            java.util.Iterator<String> keys = dictionary.keys();
            while (keys.hasNext()) { String key = keys.next(); parsed.put(key, dictionary.get(key)); }
        }
        parsed.put("featureSpaceVersion", featureSpaceVersion);
        return parsed;
    }

    public JSONObject readPortrait(String accountId) {
        if (accountId == null || accountId.isEmpty()) return null;
        return localRepository.readCloudPortrait(accountId);
    }

    public JSONObject refreshPortrait(String accountId) throws Exception {
        JSONObject out = new JSONObject();
        if (accountId == null || accountId.isEmpty()) {
            out.put("refreshed", false);
            out.put("reason", "NO_ACTIVE_ACCOUNT");
            return out;
        }
        JSONObject state = localRepository.readCloudSyncState(accountId);
        if (state == null || !state.optBoolean("analysisEnabled", true)) {
            out.put("refreshed", false);
            out.put("reason", "ANALYSIS_DISABLED");
            out.put("cloudPortrait", readPortrait(accountId));
            return out;
        }
        if (!state.optBoolean("cloudBound", false) || !state.optBoolean("accountMatched", false)) {
            out.put("refreshed", false);
            out.put("reason", state.optBoolean("cloudBound", false) ? "CLOUD_ACCOUNT_MISMATCH" : "CLOUD_UNBOUND");
            out.put("cloudPortrait", readPortrait(accountId));
            return out;
        }
        String token = getValidAccessToken(accountId);
        if (token == null) {
            out.put("refreshed", false);
            out.put("reason", "CLOUD_AUTH_REQUIRED");
            out.put("cloudPortrait", readPortrait(accountId));
            return out;
        }
        try {
            JSONObject portrait = requestJson("/api/v2/me/portrait", "GET", token, null);
            JSONObject progress = portrait.optJSONObject("processedThrough");
            if (progress != null) portrait.put("processedThrough", progress.optLong(state.optString("streamEpoch", ""), 0));
            if (portrait.has("analysisEpoch") && !portrait.isNull("analysisEpoch")
                    && portrait.optLong("analysisEpoch") != state.optLong("analysisEpoch", 1)) {
                out.put("refreshed", false);
                out.put("reason", "STALE_ANALYSIS_EPOCH");
                out.put("cloudPortrait", readPortrait(accountId));
                return out;
            }
            JSONObject cached = readPortrait(accountId);
            String cachedFsVer = cached != null ? cached.optString("featureSpaceVersion", "") : "";
            String fsVer = portrait.optString("featureSpaceVersion", "");
            JSONObject featureSpace = portrait.optJSONObject("featureSpace");
            if (featureSpace == null && !fsVer.isEmpty() && (!fsVer.equals(cachedFsVer) || cached == null || cached.optJSONObject("featureSpace") == null)) {
                try {
                    featureSpace = fetchVerifiedFeatureSpace(token, fsVer);
                } catch (Exception fsErr) {
                    if ("FEATURE_SPACE_DIGEST_MISMATCH".equals(fsErr.getMessage())) throw fsErr;
                }
            }
            JSONObject savePayload = new JSONObject(portrait.toString());
            if (!savePayload.has("analysisEpoch") || savePayload.isNull("analysisEpoch")) {
                savePayload.put("analysisEpoch", state.optLong("analysisEpoch", 1));
            }
            if (featureSpace != null) savePayload.put("featureSpace", featureSpace);
            JSONObject saved = localRepository.saveCloudPortrait(accountId, savePayload);

            String genId = portrait.optString("generationId", "");
            if (!genId.isEmpty() && !"pending".equals(portrait.optString("status", "ready"))) {
                try {
                    JSONObject plan = requestJson("/api/v2/me/search-plan", "GET", token, null);
                    saved = localRepository.saveCloudSearchPlan(accountId, plan);
                } catch (Exception planErr) {
                    if (planErr.getMessage() == null || !planErr.getMessage().contains("HTTP_404")) {
                        throw planErr;
                    }
                }
            }
            long pt = portrait.optLong("processedThrough", 0);
            if (pt > state.optLong("processedThrough", 0)) {
                JSONObject ack = new JSONObject();
                ack.put("streamEpoch", state.optString("streamEpoch", "1"));
                ack.put("analysisEpoch", state.optLong("analysisEpoch", 1));
                ack.put("processedThrough", pt);
                localRepository.applyOutboxAck(accountId, ack);
                saved = readPortrait(accountId);
            }
            out.put("refreshed", true);
            out.put("cloudPortrait", saved);
            return out;
        } catch (Exception e) {
            out.put("refreshed", false);
            out.put("reason", e.getMessage() != null ? e.getMessage() : "PORTRAIT_FETCH_FAILED");
            out.put("cloudPortrait", readPortrait(accountId));
            return out;
        }
    }

    public JSONObject readCohorts() {
        return localRepository.readCloudCohorts("default");
    }

    public JSONObject refreshCohorts(String accountId) throws Exception {
        JSONObject out = new JSONObject();
        String token = (accountId != null && !accountId.isEmpty()) ? getValidAccessToken(accountId) : null;
        try {
            JSONObject res = requestJson("/api/v2/cohorts", "GET", token, null);
            JSONObject saved = localRepository.saveCloudCohorts("default", res);
            out.put("refreshed", true);
            out.put("cohorts", saved);
            return out;
        } catch (Exception e) {
            out.put("refreshed", false);
            out.put("reason", e.getMessage() != null ? e.getMessage() : "COHORTS_FETCH_FAILED");
            JSONObject cached = readCohorts();
            out.put("cohorts", cached != null ? cached : JSONObject.NULL);
            return out;
        }
    }
}
