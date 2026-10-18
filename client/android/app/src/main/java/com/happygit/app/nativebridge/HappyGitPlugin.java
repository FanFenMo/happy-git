package com.happygit.app.nativebridge;

import android.content.Intent;
import android.net.Uri;
import com.happygit.app.R;
import com.getcapacitor.JSObject;
import com.getcapacitor.JSArray;
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

        apiBaseUrl = getContext().getString(R.string.happygit_api_base_url);

        gitHubAuth = new GitHubAuth(getContext(), localRepository, apiBaseUrl);
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
                if (isPersonal(operation, payload) && !"github.request".equals(operation)) {
                    synchronized (gitHubAuth) { dispatch(operation, payload, contextId, call); }
                } else dispatch(operation, payload, contextId, call);
            } catch (Exception e) {
                e.printStackTrace();
                resolveFailure(call, e.getMessage() != null && e.getMessage().matches("(AUTH_|CONFIG_|SYNC_|SESSION_|STORAGE_).*" ) ? e.getMessage() : "INTERNAL_ERROR", e.getMessage() != null ? e.getMessage() : "原生插件内部错误");
            }
        });
    }

    private void dispatch(String operation, JSObject payload, String contextId, PluginCall call) throws Exception {
        if (isPersonal(operation, payload)) gitHubAuth.assertContext(contextId);
        final String accountId = gitHubAuth.getCurrentAccountId();
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
                GitHubClient.Response resp = "searchTrending".equals(resource) ? GitHubClient.request(resource, args, null) : gitHubAuth.request(resource, args, contextId);
                JSObject ret = new JSObject();
                ret.put("status", resp.status);
                ret.put("body", resp.body != null ? resp.body : JSONObject.NULL);
                JSObject hdrs = new JSObject();
                for (String k : resp.headers.keySet()) hdrs.put(k, resp.headers.get(k));
                ret.put("headers", hdrs);
                resolveSuccess(call, ret);
                break;
            }

            case "account.saveProfile": {
                if (accountId == null) {
                    resolveFailure(call, "AUTH_REQUIRED", "尚未登录");
                    return;
                }
                if (!accountId.equals(payload.getJSObject("profile").getString("accountId"))) throw new IllegalStateException("SESSION_CHANGED");
                localRepository.saveProfile(accountId, payload.getJSObject("profile"));
                JSObject r = new JSObject();
                r.put("saved", true);
                resolveSuccess(call, r);
                break;
            }

            case "account.readSnapshot": {
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
                gitHubAuth.logout();
                if (accountId != null) localRepository.forgetAccount(accountId);
                JSObject r = new JSObject();
                resolveSuccess(call, gitHubAuth.session(null));
                break;
            }

            case "sync.begin": {
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
                if (accountId == null) {
                    resolveSuccess(call, null);
                    return;
                }
                JSONObject snapshot = localRepository.readAccountSnapshot(accountId);
                if (!snapshot.getJSONObject("preferences").optBoolean("historyEnabled", false) || !("authenticated".equals(gitHubAuth.getStatus()) || "offline".equals(gitHubAuth.getStatus())) || payload.getJSObject("repository").optBoolean("isPrivate")) {
                    resolveSuccess(call, null); return;
                }
                JSONObject entry = localRepository.recordBrowse(
                        accountId,
                        payload.getJSObject("repository"),
                        payload.optString("source", "trending"),
                        System.currentTimeMillis()
                );
                resolveSuccess(call, new JSObject(entry.toString()));
                break;
            }

            case "history.list": {
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
                if (accountId != null) {
                    localRepository.deleteHistory(accountId, payload.getString("repoId"));
                }
                JSObject r = new JSObject();
                r.put("deleted", true);
                resolveSuccess(call, r);
                break;
            }

            case "history.clear": {
                if (accountId != null) {
                    localRepository.clearHistory(accountId);
                }
                JSObject r = new JSObject();
                r.put("cleared", true);
                resolveSuccess(call, r);
                break;
            }

            case "history.count": {
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
                    resolveSuccess(call, data != null ? data : new JSONArray());
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

    private boolean isPersonal(String operation, JSObject payload) {
        return operation.matches("^(account\\.|sync\\.|repositories\\.|stars\\.|history\\.).*") || ("github.request".equals(operation) && !"searchTrending".equals(payload.optString("resource")));
    }

    private boolean isSafeGitHubUrl(String url) {
        try {
            Uri uri = Uri.parse(url);
            return "https".equalsIgnoreCase(uri.getScheme()) &&
                    "github.com".equalsIgnoreCase(uri.getHost()) &&
                    uri.getUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443);
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
