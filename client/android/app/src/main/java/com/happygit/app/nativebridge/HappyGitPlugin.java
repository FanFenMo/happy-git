package com.happygit.app.nativebridge;

import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "HappyGit")
public class HappyGitPlugin extends Plugin {

    private LocalRepository localRepository;
    private GitHubAuth gitHubAuth;
    private String apiBaseUrl = "";
    private final ExecutorService backgroundExecutor = Executors.newFixedThreadPool(4);

    @Override
    public void load() {
        super.load();
        localRepository = new LocalRepository(getContext());

        String clientId = "";
        try {
            int resId = getContext().getResources().getIdentifier("happygit_github_client_id", "string", getContext().getPackageName());
            if (resId != 0) clientId = getContext().getString(resId);

            int apiId = getContext().getResources().getIdentifier("happygit_api_base_url", "string", getContext().getPackageName());
            if (apiId != 0) apiBaseUrl = getContext().getString(apiId);
        } catch (Exception ignored) {}

        gitHubAuth = new GitHubAuth(getContext(), localRepository, clientId);
    }

    @PluginMethod
    public void invoke(PluginCall call) {
        String operation = call.getString("operation");
        JSObject payload = call.getObject("payload", new JSObject());
        String contextId = call.getString("contextId");

        if (operation == null) {
            resolveFailure(call, "INVALID_ARGUMENT", "缺少 operation 参数");
            return;
        }

        backgroundExecutor.execute(() -> {
            try {
                dispatch(operation, payload, contextId, call);
            } catch (Exception e) {
                e.printStackTrace();
                resolveFailure(call, "INTERNAL_ERROR", e.getMessage() != null ? e.getMessage() : "原生插件内部错误");
            }
        });
    }

    private void dispatch(String operation, JSObject payload, String contextId, PluginCall call) throws Exception {
        switch (operation) {
            case "app.initialize": {
                String mode = localRepository.readSetting("mode");
                if (mode == null) mode = "unset";
                JSONObject session = gitHubAuth.restoreSession();
                boolean shouldPromptLogin = "unset".equals(mode) && "guest".equals(session.optString("status"));

                JSObject data = new JSObject();
                data.put("session", new JSObject(session.toString()));
                data.put("mode", mode);
                data.put("shouldPromptLogin", shouldPromptLogin);
                resolveSuccess(call, data);
                break;
            }

            case "auth.begin": {
                JSONObject challenge = gitHubAuth.beginAuthorization();
                resolveSuccess(call, new JSObject(challenge.toString()));
                break;
            }

            case "auth.poll": {
                JSONObject progress = gitHubAuth.pollAuthorization(payload.getString("challengeId"));
                resolveSuccess(call, new JSObject(progress.toString()));
                break;
            }

            case "auth.cancel": {
                gitHubAuth.cancelAuthorization(payload.getString("challengeId"));
                JSObject r = new JSObject();
                r.put("cancelled", true);
                resolveSuccess(call, r);
                break;
            }

            case "auth.restore": {
                JSONObject session = gitHubAuth.restoreSession();
                resolveSuccess(call, new JSObject(session.toString()));
                break;
            }

            case "auth.logout": {
                gitHubAuth.logout();
                JSObject s = new JSObject();
                s.put("status", "guest");
                s.put("accountId", JSONObject.NULL);
                s.put("contextId", gitHubAuth.getCurrentContextId());
                s.put("profile", JSONObject.NULL);
                s.put("verifiedAt", JSONObject.NULL);
                resolveSuccess(call, s);
                break;
            }

            case "github.request": {
                String resource = payload.getString("resource");
                JSObject args = payload.getJSObject("args");
                String token = null;
                if ("currentUser".equals(resource) || "ownedRepos".equals(resource) || "starredRepos".equals(resource)
                        || "starState".equals(resource) || "addStar".equals(resource) || "removeStar".equals(resource)) {
                    token = gitHubAuth.ensureAccessToken();
                }
                GitHubClient.Response resp = GitHubClient.request(resource, args, token);
                JSObject ret = new JSObject();
                ret.put("status", resp.status);
                ret.put("body", resp.body != null ? new JSObject(resp.body.toString()) : JSONObject.NULL);
                JSObject hdrs = new JSObject();
                for (String k : resp.headers.keySet()) hdrs.put(k, resp.headers.get(k));
                ret.put("headers", hdrs);
                resolveSuccess(call, ret);
                break;
            }

            case "account.saveProfile": {
                String accountId = gitHubAuth.getCurrentAccountId();
                if (accountId == null) {
                    resolveFailure(call, "AUTH_REQUIRED", "尚未登录");
                    return;
                }
                localRepository.saveProfile(accountId, payload.getJSObject("profile"));
                JSObject r = new JSObject();
                r.put("saved", true);
                resolveSuccess(call, r);
                break;
            }

            case "account.readSnapshot": {
                String accountId = gitHubAuth.getCurrentAccountId();
                if (accountId == null) {
                    JSObject r = new JSObject();
                    r.put("profile", JSONObject.NULL);
                    resolveSuccess(call, r);
                    return;
                }
                JSONObject snap = localRepository.readAccountSnapshot(accountId);
                resolveSuccess(call, new JSObject(snap.toString()));
                break;
            }

            case "account.savePreferences": {
                String accountId = gitHubAuth.getCurrentAccountId();
                if (accountId == null) {
                    resolveFailure(call, "AUTH_REQUIRED", "尚未登录");
                    return;
                }
                localRepository.savePreferences(accountId, payload);
                JSObject r = new JSObject();
                r.put("saved", true);
                resolveSuccess(call, r);
                break;
            }

            case "account.forgetLocalData": {
                String accountId = gitHubAuth.getCurrentAccountId();
                if (accountId != null) {
                    localRepository.forgetAccount(accountId);
                }
                gitHubAuth.logout();
                JSObject r = new JSObject();
                r.put("forgotten", true);
                resolveSuccess(call, r);
                break;
            }

            case "sync.begin": {
                String accountId = gitHubAuth.getCurrentAccountId();
                if (accountId == null) {
                    resolveFailure(call, "AUTH_REQUIRED", "尚未登录");
                    return;
                }
                String genId = localRepository.beginSync(accountId, payload.getString("kind"));
                JSObject r = new JSObject();
                r.put("generationId", genId);
                resolveSuccess(call, r);
                break;
            }

            case "sync.writePage": {
                String accountId = gitHubAuth.getCurrentAccountId();
                if (accountId == null) {
                    resolveFailure(call, "AUTH_REQUIRED", "尚未登录");
                    return;
                }
                JSONArray items = payload.getJSONArray("items");
                Integer nextPage = payload.has("nextPage") && !payload.isNull("nextPage") ? payload.getInt("nextPage") : null;
                JSONObject res = localRepository.writeSyncPage(
                        accountId,
                        payload.getString("kind"),
                        payload.getString("generationId"),
                        payload.getInt("page"),
                        items,
                        nextPage
                );
                resolveSuccess(call, new JSObject(res.toString()));
                break;
            }

            case "sync.finish": {
                String accountId = gitHubAuth.getCurrentAccountId();
                if (accountId == null) {
                    resolveFailure(call, "AUTH_REQUIRED", "尚未登录");
                    return;
                }
                JSONObject res = localRepository.finishSync(
                        accountId,
                        payload.getString("kind"),
                        payload.getString("generationId")
                );
                resolveSuccess(call, new JSObject(res.toString()));
                break;
            }

            case "sync.abort": {
                String accountId = gitHubAuth.getCurrentAccountId();
                if (accountId != null) {
                    String errCode = payload.optString("errorCode", null);
                    Long retryAt = payload.has("retryAt") ? payload.getLong("retryAt") : null;
                    localRepository.abortSync(accountId, payload.getString("kind"), payload.getString("generationId"), errCode, retryAt);
                }
                JSObject r = new JSObject();
                r.put("aborted", true);
                resolveSuccess(call, r);
                break;
            }

            case "repositories.list": {
                String accountId = gitHubAuth.getCurrentAccountId();
                if (accountId == null) {
                    JSObject r = new JSObject();
                    r.put("items", new JSArray());
                    resolveSuccess(call, r);
                    return;
                }
                JSONObject res = localRepository.listRepositories(
                        accountId,
                        payload.getString("kind"),
                        payload.optInt("offset", 0),
                        payload.optInt("limit", 30)
                );
                resolveSuccess(call, new JSObject(res.toString()));
                break;
            }

            case "repositories.isStarred": {
                String accountId = gitHubAuth.getCurrentAccountId();
                if (accountId == null) {
                    JSObject r = new JSObject();
                    r.put("known", true);
                    r.put("starred", false);
                    resolveSuccess(call, r);
                    return;
                }
                JSONObject res = localRepository.isRepositoryStarred(accountId, payload.getString("repoId"));
                resolveSuccess(call, new JSObject(res.toString()));
                break;
            }

            case "stars.applyConfirmed": {
                String accountId = gitHubAuth.getCurrentAccountId();
                if (accountId == null) {
                    resolveFailure(call, "AUTH_REQUIRED", "尚未登录");
                    return;
                }
                localRepository.applyConfirmedStar(accountId, payload.getJSObject("repository"), payload.getBoolean("starred"));
                JSObject r = new JSObject();
                r.put("applied", true);
                resolveSuccess(call, r);
                break;
            }

            case "history.record": {
                String accountId = gitHubAuth.getCurrentAccountId();
                if (accountId == null) {
                    resolveSuccess(call, null);
                    return;
                }
                JSONObject entry = localRepository.recordBrowse(
                        accountId,
                        payload.getJSObject("repository"),
                        payload.optString("source", "trending"),
                        payload.optLong("viewedAt", System.currentTimeMillis())
                );
                resolveSuccess(call, new JSObject(entry.toString()));
                break;
            }

            case "history.list": {
                String accountId = gitHubAuth.getCurrentAccountId();
                if (accountId == null) {
                    JSObject r = new JSObject();
                    r.put("items", new JSArray());
                    r.put("total", 0);
                    resolveSuccess(call, r);
                    return;
                }
                JSONObject res = localRepository.listHistory(
                        accountId,
                        payload.getJSObject("cursor"),
                        payload.optInt("limit", 30),
                        payload.optString("keyword", "")
                );
                resolveSuccess(call, new JSObject(res.toString()));
                break;
            }

            case "history.delete": {
                String accountId = gitHubAuth.getCurrentAccountId();
                if (accountId != null) {
                    localRepository.deleteHistory(accountId, payload.getString("repoId"));
                }
                JSObject r = new JSObject();
                r.put("deleted", true);
                resolveSuccess(call, r);
                break;
            }

            case "history.clear": {
                String accountId = gitHubAuth.getCurrentAccountId();
                if (accountId != null) {
                    localRepository.clearHistory(accountId);
                }
                JSObject r = new JSObject();
                r.put("cleared", true);
                resolveSuccess(call, r);
                break;
            }

            case "history.count": {
                String accountId = gitHubAuth.getCurrentAccountId();
                int cnt = accountId != null ? localRepository.countHistory(accountId) : 0;
                resolveSuccess(call, cnt);
                break;
            }

            case "feed.fetchRemote": {
                if (apiBaseUrl == null || apiBaseUrl.isEmpty()) {
                    resolveFailure(call, "CONFIG_MISSING", "未配置后端服务地址");
                    return;
                }
                URL url = URI.create(apiBaseUrl + "/api/projects/trending?limit=20").toURL();
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                if (conn.getResponseCode() == 200) {
                    BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), "UTF-8"));
                    StringBuilder sb = new StringBuilder();
                    String line;
                    while ((line = reader.readLine()) != null) sb.append(line);
                    reader.close();
                    JSONObject resp = new JSONObject(sb.toString());
                    JSONArray data = resp.optJSONArray("data");
                    JSObject r = new JSObject();
                    r.put("items", data != null ? data : new JSONArray());
                    resolveSuccess(call, r);
                } else {
                    resolveFailure(call, "NETWORK_UNAVAILABLE", "后端响应: " + conn.getResponseCode());
                }
                break;
            }

            case "feed.read": {
                JSONObject res = localRepository.readFeed(payload.getString("key"));
                resolveSuccess(call, res != null ? new JSObject(res.toString()) : null);
                break;
            }

            case "feed.save": {
                localRepository.saveFeed(payload.getString("key"), payload.getJSONArray("items"), payload.optLong("fetchedAt", System.currentTimeMillis()));
                JSObject r = new JSObject();
                r.put("saved", true);
                resolveSuccess(call, r);
                break;
            }

            case "settings.save": {
                if (payload.has("mode")) {
                    localRepository.saveSetting("mode", payload.getString("mode"));
                }
                JSObject r = new JSObject();
                r.put("saved", true);
                resolveSuccess(call, r);
                break;
            }

            case "external.open": {
                String targetUrl = payload.getString("url");
                if (targetUrl == null || !isSafeGitHubUrl(targetUrl)) {
                    resolveFailure(call, "INVALID_ARGUMENT", "非法链接地址");
                    return;
                }
                getActivity().runOnUiThread(() -> {
                    try {
                        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(targetUrl));
                        getActivity().startActivity(intent);
                        JSObject r = new JSObject();
                        r.put("opened", true);
                        resolveSuccess(call, r);
                    } catch (Exception e) {
                        resolveFailure(call, "OPEN_FAILED", "无法打开外部浏览器: " + e.getMessage());
                    }
                });
                break;
            }

            default:
                resolveFailure(call, "INVALID_ARGUMENT", "未知操作: " + operation);
                break;
        }
    }

    private boolean isSafeGitHubUrl(String url) {
        try {
            Uri uri = Uri.parse(url);
            return "https".equalsIgnoreCase(uri.getScheme()) &&
                    "github.com".equalsIgnoreCase(uri.getHost()) &&
                    uri.getUserInfo() == null;
        } catch (Exception e) {
            return false;
        }
    }

    private void resolveSuccess(PluginCall call, Object data) {
        JSObject ret = new JSObject();
        ret.put("ok", true);
        if (data != null) ret.put("data", data);
        else ret.put("data", JSONObject.NULL);
        call.resolve(ret);
    }

    private void resolveFailure(PluginCall call, String code, String message) {
        JSObject ret = new JSObject();
        ret.put("ok", false);
        JSObject err = new JSObject();
        err.put("code", code);
        err.put("message", message);
        ret.put("error", err);
        call.resolve(ret);
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        backgroundExecutor.shutdown();
    }
}
