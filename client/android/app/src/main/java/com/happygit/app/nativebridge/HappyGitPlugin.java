package com.happygit.app.nativebridge;

import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "HappyGit")
public class HappyGitPlugin extends Plugin {

    private LocalRepository localRepository;
    private GitHubWebViewHost webViewHost;
    private PageTaskScheduler scheduler;
    private PageExecutor pageExecutor;
    private SessionManager sessionManager;
    private AccountSyncService accountSyncService;
    private StarService starService;

    private final ExecutorService backgroundExecutor = Executors.newFixedThreadPool(4);

    @Override
    public void load() {
        super.load();
        localRepository = new LocalRepository(getContext());
        webViewHost = new GitHubWebViewHost(getContext());
        scheduler = new PageTaskScheduler();
        pageExecutor = new PageExecutor(getContext(), webViewHost);

        sessionManager = new SessionManager(getContext(), localRepository, webViewHost, scheduler, pageExecutor);
        accountSyncService = new AccountSyncService(localRepository, scheduler, pageExecutor);
        starService = new StarService(localRepository, scheduler, pageExecutor);
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
                String code = (e.getMessage() != null && e.getMessage().matches("(AUTH_|CONFIG_|SYNC_|SESSION_|STORAGE_|PAGE_|RATE_).*"))
                        ? e.getMessage() : "INTERNAL_ERROR";
                resolveFailure(call, code, e.getMessage() != null ? e.getMessage() : "原生插件内部错误");
            }
        });
    }

    private void dispatch(String operation, JSObject payload, String contextId, PluginCall call) throws Exception {
        JSONObject currentContext = sessionManager.getSessionContext();

        // 校验需要登录态的操作
        boolean isPersonal = isPersonalOp(operation);
        if (isPersonal) {
            if (contextId != null && !contextId.isEmpty()) {
                sessionManager.assertContext(contextId);
            }
            if ("guest".equals(currentContext.optString("status"))) {
                resolveFailure(call, "AUTH_REQUIRED", "该操作需要先登录 GitHub");
                return;
            }
        }

        String accountId = sessionManager.getCurrentAccountId();

        switch (operation) {
            case "app.initialize": {
                JSONObject session = sessionManager.restoreSession();
                String mode = localRepository.readSetting("mode");
                if (mode == null) mode = "unset";
                boolean shouldPromptLogin = "unset".equals(mode) && "guest".equals(session.optString("status"));

                JSObject data = new JSObject();
                data.put("session", new JSObject(session.toString()));
                data.put("mode", mode);
                data.put("shouldPromptLogin", shouldPromptLogin);
                resolveSuccess(call, data);
                break;
            }

            case "session.beginLogin": {
                JSONObject res = sessionManager.beginLogin(payload.getString("intent", "login"));
                resolveSuccess(call, new JSObject(res.toString()));
                break;
            }

            case "session.getLoginTask": {
                JSONObject res = sessionManager.getLoginTask(payload.getString("loginTaskId"));
                if (res != null) {
                    resolveSuccess(call, new JSObject(res.toString()));
                } else {
                    resolveFailure(call, "TASK_NOT_FOUND", "登录任务不存在");
                }
                break;
            }

            case "session.cancelLogin": {
                JSONObject res = sessionManager.cancelLogin(payload.getString("loginTaskId"));
                resolveSuccess(call, new JSObject(res.toString()));
                break;
            }

            case "session.restore": {
                JSONObject session = sessionManager.restoreSession();
                resolveSuccess(call, new JSObject(session.toString()));
                break;
            }

            case "session.logout": {
                JSONObject session = sessionManager.logout();
                resolveSuccess(call, new JSObject(session.toString()));
                break;
            }

            case "account.readSnapshot": {
                JSONObject snapshot = localRepository.readAccountSnapshot(accountId);
                resolveSuccess(call, new JSObject(snapshot.toString()));
                break;
            }

            case "account.sync": {
                JSONArray collections = payload.optJSONArray("collections");
                if (collections == null) {
                    collections = new JSONArray();
                    collections.put("profile");
                    collections.put("repos");
                    collections.put("stars");
                }
                boolean force = payload.optBoolean("force", false);
                JSONObject res = accountSyncService.start(currentContext, collections, force);
                resolveSuccess(call, new JSObject(res.toString()));
                break;
            }

            case "tasks.read": {
                JSONObject t = accountSyncService.getTask(payload.getString("taskId"));
                if (t != null) {
                    resolveSuccess(call, new JSObject(t.toString()));
                } else {
                    resolveFailure(call, "TASK_NOT_FOUND", "任务不存在");
                }
                break;
            }

            case "tasks.cancel": {
                boolean cancelled = accountSyncService.cancelTask(payload.getString("taskId"));
                JSObject res = new JSObject();
                res.put("cancelled", cancelled);
                resolveSuccess(call, res);
                break;
            }

            case "repositories.list": {
                String kind = payload.getString("kind", "repos");
                int offset = payload.optInt("offset", 0);
                int limit = payload.optInt("limit", 30);
                JSONObject list = localRepository.listRepositories(accountId, kind, offset, limit);
                resolveSuccess(call, new JSObject(list.toString()));
                break;
            }

            case "stars.readState": {
                JSONObject state = starService.readState(currentContext, payload.getString("repoId"), payload.getString("fullName"));
                resolveSuccess(call, new JSObject(state.toString()));
                break;
            }

            case "stars.set": {
                JSONObject repo = payload.getJSONObject("repository");
                boolean desiredStarred = payload.getBoolean("desiredStarred");
                String intentId = payload.getString("intentId", "star_" + System.currentTimeMillis());
                JSONObject result = starService.set(currentContext, repo, desiredStarred, intentId);
                resolveSuccess(call, new JSObject(result.toString()));
                break;
            }

            case "history.record": {
                JSONObject repo = payload.getJSONObject("repository");
                String source = payload.getString("source", "app");
                JSONObject pref = localRepository.readAccountSnapshot(accountId);
                if (!pref.getJSONObject("preferences").optBoolean("historyEnabled", true)) {
                    JSObject res = new JSObject();
                    res.put("saved", false);
                    res.put("reason", "history_disabled");
                    resolveSuccess(call, res);
                    return;
                }
                JSONObject item = localRepository.recordBrowse(accountId, repo, source, System.currentTimeMillis());
                JSObject res = new JSObject();
                res.put("saved", true);
                res.put("item", new JSObject(item.toString()));
                resolveSuccess(call, res);
                break;
            }

            case "history.list": {
                JSONObject cursor = payload.optJSONObject("cursor");
                int limit = payload.optInt("limit", 30);
                String keyword = payload.getString("keyword", "");
                JSONObject history = localRepository.listHistory(accountId, cursor, limit, keyword);
                resolveSuccess(call, new JSObject(history.toString()));
                break;
            }

            case "history.delete": {
                localRepository.deleteHistory(accountId, payload.getString("repoId"));
                JSObject res = new JSObject();
                res.put("deleted", true);
                resolveSuccess(call, res);
                break;
            }

            case "history.clear": {
                localRepository.clearHistory(accountId);
                JSObject res = new JSObject();
                res.put("cleared", true);
                resolveSuccess(call, res);
                break;
            }

            case "account.savePreferences": {
                localRepository.savePreferences(accountId, payload);
                JSObject res = new JSObject();
                res.put("saved", true);
                resolveSuccess(call, res);
                break;
            }

            case "account.forgetLocalData": {
                JSONObject res = sessionManager.forgetCurrentAccount();
                resolveSuccess(call, new JSObject(res.toString()));
                break;
            }

            case "discovery.refresh": {
                String mode = payload.getString("mode", "trending");
                if ("trending".equals(mode)) {
                    JSONObject trRes = scheduler.withPageLease(contextId, "trending", () -> {
                        pageExecutor.navigate("https://github.com/trending", 25000);
                        return pageExecutor.executeScript("readTrendingResults", null);
                    });
                    JSONArray items = trRes.optJSONArray("items");
                    if (items == null) items = new JSONArray();
                    localRepository.saveFeed("feed:trending", items, System.currentTimeMillis());

                    JSObject res = new JSObject();
                    res.put("items", new JSArray(items.toString()));
                    res.put("count", items.length());
                    resolveSuccess(call, res);
                } else if ("personalized".equals(mode)) {
                    JSONArray queryPlan = payload.optJSONArray("queryPlan");
                    JSONArray candidates = new JSONArray();
                    if (queryPlan != null) {
                        for (int i = 0; i < Math.min(queryPlan.length(), 4); i++) {
                            JSONObject q = queryPlan.getJSONObject(i);
                            String queryStr = q.optString("query", "stars:>100");
                            String sort = q.optString("sort", "stars");
                            String url = "https://github.com/search?q=" + URLEncoder.encode(queryStr, "UTF-8") + "&type=repositories&s=" + URLEncoder.encode(sort, "UTF-8");

                            try {
                                JSONObject sRes = scheduler.withPageLease(contextId, "discovery", () -> {
                                    pageExecutor.navigate(url, 25000);
                                    return pageExecutor.executeScript("readSearchResults", null);
                                });
                                JSONArray found = sRes.optJSONArray("items");
                                if (found != null) {
                                    for (int j = 0; j < found.length(); j++) candidates.put(found.getJSONObject(j));
                                    localRepository.saveDiscoveryCache(accountId, "search:" + queryStr + ":" + sort, q.toString(), found.toString(), System.currentTimeMillis(), System.currentTimeMillis() + 86400000L);
                                }
                            } catch (Exception ignored) {}
                        }
                    }
                    JSObject res = new JSObject();
                    res.put("candidates", new JSArray(candidates.toString()));
                    res.put("count", candidates.length());
                    resolveSuccess(call, res);
                } else {
                    JSObject res = new JSObject();
                    res.put("items", new JSArray());
                    res.put("count", 0);
                    resolveSuccess(call, res);
                }
                break;
            }

            case "discovery.read": {
                JSONObject cached = localRepository.readFeed(payload.getString("key", "feed:trending"));
                if (cached != null) {
                    resolveSuccess(call, new JSObject(cached.toString()));
                } else {
                    JSObject empty = new JSObject();
                    empty.put("items", new JSArray());
                    empty.put("fetchedAt", JSONObject.NULL);
                    resolveSuccess(call, empty);
                }
                break;
            }

            case "recommendation.createSnapshot": {
                JSONObject snap = localRepository.createSnapshot(accountId, payload.getString("purpose", "ranking"), payload.getString("reason", "user_request"));
                resolveSuccess(call, new JSObject(snap.toString()));
                break;
            }

            case "recommendation.commit": {
                JSONObject res = localRepository.commitRecommendation(
                        accountId,
                        payload.getString("inputId"),
                        payload.getJSONObject("inputVersions"),
                        payload.getString("purpose"),
                        payload.optJSONObject("profile"),
                        payload.optJSONObject("batch")
                );
                resolveSuccess(call, new JSObject(res.toString()));
                break;
            }

            case "recommendation.list": {
                JSONObject list = localRepository.listRecommendation(accountId, payload.optString("batchId", null), payload.optInt("offset", 0), payload.optInt("limit", 20));
                resolveSuccess(call, new JSObject(list.toString()));
                break;
            }

            case "recommendation.feedback": {
                localRepository.recordRecommendationFeedback(accountId, payload.getString("repoId"), payload.getString("kind"), payload.getString("eventId", "fb_" + System.currentTimeMillis()));
                JSObject res = new JSObject();
                res.put("recorded", true);
                resolveSuccess(call, res);
                break;
            }

            case "repository.open": {
                JSONObject repo = payload.getJSONObject("repository");
                String htmlUrl = repo.optString("htmlUrl", "");
                if (!htmlUrl.isEmpty() && "external".equals(payload.optString("target", "app"))) {
                    Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(htmlUrl));
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(intent);
                }
                boolean historySaved = false;
                if ("authenticated".equals(currentContext.optString("status"))) {
                    JSONObject pref = localRepository.readAccountSnapshot(accountId);
                    if (pref.getJSONObject("preferences").optBoolean("historyEnabled", true)) {
                        localRepository.recordBrowse(accountId, repo, payload.optString("source", "open"), System.currentTimeMillis());
                        historySaved = true;
                    }
                }
                JSObject res = new JSObject();
                res.put("opened", true);
                res.put("historySaved", historySaved);
                resolveSuccess(call, res);
                break;
            }

            default:
                resolveFailure(call, "UNKNOWN_OPERATION", "未知的原生操作: " + operation);
                break;
        }
    }

    private boolean isPersonalOp(String operation) {
        switch (operation) {
            case "account.readSnapshot":
            case "account.sync":
            case "repositories.list":
            case "stars.set":
            case "history.record":
            case "history.list":
            case "history.delete":
            case "history.clear":
            case "account.savePreferences":
            case "account.forgetLocalData":
            case "recommendation.createSnapshot":
            case "recommendation.commit":
            case "recommendation.list":
            case "recommendation.feedback":
                return true;
            default:
                return false;
        }
    }

    private void resolveSuccess(PluginCall call, JSObject data) {
        JSObject envelope = new JSObject();
        envelope.put("ok", true);
        envelope.put("data", data);
        envelope.put("contextId", sessionManager.getSessionContext().optString("contextId"));
        call.resolve(envelope);
    }

    private void resolveFailure(PluginCall call, String code, String message) {
        JSObject envelope = new JSObject();
        envelope.put("ok", false);
        JSObject error = new JSObject();
        error.put("code", code);
        error.put("message", message);
        envelope.put("error", error);
        envelope.put("contextId", sessionManager.getSessionContext().optString("contextId"));
        call.resolve(envelope);
    }

    @Override
    protected void handleOnDestroy() {
        if (webViewHost != null) {
            webViewHost.destroy();
        }
        super.handleOnDestroy();
    }
}
