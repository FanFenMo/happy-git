package com.happygit.app.nativebridge;

import android.content.Intent;
import android.net.Uri;
import android.webkit.CookieManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@CapacitorPlugin(name = "HappyGit")
public class HappyGitPlugin extends Plugin {

    private LocalRepository localRepository;
    private GitHubWebViewHost webViewHost;
    private PageTaskScheduler scheduler;
    private PageExecutor pageExecutor;
    private SessionManager sessionManager;
    private AccountSyncService accountSyncService;
    private StarService starService;
    private CloudService cloudService;

    private final ExecutorService backgroundExecutor = Executors.newFixedThreadPool(4);
    private final ExecutorService searchExecutor = Executors.newFixedThreadPool(4);
    private static final long DISCOVERY_CACHE_TTL_MS = 2L * 60L * 60L * 1000L;
    private static final Pattern SCRIPT_TAG_PATTERN = Pattern.compile("<script\\b([^>]*)>([\\s\\S]*?)</script>", Pattern.CASE_INSENSITIVE);
    private static final Pattern TITLE_TAG_PATTERN = Pattern.compile("<title[^>]*>([\\s\\S]*?)</title>", Pattern.CASE_INSENSITIVE);
    private static final Pattern HTML_TAG_PATTERN = Pattern.compile("<[^>]+>");

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
        cloudService = new CloudService(getContext(), localRepository);
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
                String code = (e.getMessage() != null && e.getMessage().matches("(AUTH_|CLOUD_|CONFIG_|SYNC_|SESSION_|STORAGE_|PAGE_|RATE_|STREAM_|ANALYSIS_|SEQUENCE_|IDEMPOTENCY_|COLLECTION_).*"))
                        ? e.getMessage() : "INTERNAL_ERROR";
                resolveFailure(call, code, e.getMessage() != null ? e.getMessage() : "原生插件内部错误");
            }
        });
    }

    private void dispatch(String operation, JSObject payload, String contextId, PluginCall call) throws Exception {
        JSONObject currentContext = sessionManager.getSessionContext();

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

                JSONObject cloudSync = null;
                if ("authenticated".equals(session.optString("status")) && session.optString("accountId", null) != null) {
                    try {
                        JSONObject restored = cloudService.restoreSession(session.getString("accountId"));
                        cloudSync = restored.optJSONObject("cloudSync");
                    } catch (Exception ignored) {
                        cloudSync = localRepository.readCloudSyncState(session.optString("accountId"));
                    }
                }

                JSObject data = new JSObject();
                data.put("session", new JSObject(session.toString()));
                data.put("mode", mode);
                data.put("shouldPromptLogin", shouldPromptLogin);
                data.put("cloudSync", cloudSync != null ? new JSObject(cloudSync.toString()) : JSONObject.NULL);
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
                backgroundExecutor.execute(() -> {
                    try { cloudService.syncCollections(accountId); } catch (Exception ignored) {}
                });
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
                if (item.optBoolean("countedVisit", false)) {
                    backgroundExecutor.execute(() -> {
                        try { cloudService.flushOutbox(accountId); } catch (Exception ignored) {}
                    });
                }
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
                backgroundExecutor.execute(() -> {
                    try { cloudService.flushOutbox(accountId); } catch (Exception ignored) {}
                });
                JSObject res = new JSObject();
                res.put("deleted", true);
                resolveSuccess(call, res);
                break;
            }

            case "history.clear": {
                localRepository.clearHistory(accountId);
                backgroundExecutor.execute(() -> {
                    try { cloudService.flushOutbox(accountId); } catch (Exception ignored) {}
                });
                JSObject res = new JSObject();
                res.put("cleared", true);
                resolveSuccess(call, res);
                break;
            }

            case "account.savePreferences": {
                JSONObject res = cloudService.savePreferences(accountId, payload);
                resolveSuccess(call, new JSObject(res.toString()));
                break;
            }

            case "account.forgetLocalData": {
                try { cloudService.logoutSession(accountId); } catch (Exception ignored) {}
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
                    if (queryPlan == null) {
                        JSONObject planObj = payload.optJSONObject("queryPlan");
                        if (planObj != null) {
                            queryPlan = planObj.optJSONArray("queryPlan");
                        }
                    }
                    int maxQueries = 4;
                    int maxTotalPages = 8;
                    boolean forceRefresh = payload.optBoolean("forceRefresh", false);

                    List<JSONObject> plannedQueries = new ArrayList<>();
                    List<Integer> plannedPageBudgets = new ArrayList<>();
                    int budgetLeft = maxTotalPages;
                    if (queryPlan != null) {
                        for (int i = 0; i < Math.min(queryPlan.length(), maxQueries); i++) {
                            if (budgetLeft <= 0) break;
                            JSONObject q = queryPlan.getJSONObject(i);
                            int reqPages = Math.max(1, Math.min(2, q.optInt("maxPages", 1)));
                            int allowed = Math.min(reqPages, budgetLeft);
                            budgetLeft -= allowed;
                            plannedQueries.add(q);
                            plannedPageBudgets.add(allowed);
                        }
                    }

                    final AtomicBoolean rateLimited = new AtomicBoolean(false);
                    List<Future<JSONObject>> futures = new ArrayList<>();
                    for (int i = 0; i < plannedQueries.size(); i++) {
                        final JSONObject q = plannedQueries.get(i);
                        final int allowedPages = plannedPageBudgets.get(i);
                        futures.add(searchExecutor.submit(() -> {
                            String queryStr = q.optString("query", "stars:>100");
                            String sort = "updated".equals(q.optString("sort", "stars")) ? "updated" : "stars";
                            int startPage = Math.max(1, q.optInt("startPage", 1));

                            JSONObject report = new JSONObject();
                            report.put("id", q.optString("id", ""));
                            report.put("query", queryStr);
                            report.put("sort", sort);
                            report.put("startPage", startPage);
                            int pagesFetched = 0;
                            int cacheHits = 0;
                            Integer nextPageNum = null;
                            boolean exhausted = false;
                            JSONArray collected = new JSONArray();

                            for (int page = startPage; page < startPage + allowedPages; page++) {
                                if (rateLimited.get()) break;
                                String cacheKey = "search:" + queryStr + ":" + sort + ":p" + page;

                                if (!forceRefresh && accountId != null && !accountId.isEmpty()) {
                                    try {
                                        JSONObject cached = localRepository.readDiscoveryCache(accountId, cacheKey);
                                        if (cached != null) {
                                            JSONArray cachedItems = cached.optJSONArray("items");
                                            if (cachedItems != null && cachedItems.length() > 0) {
                                                pagesFetched++;
                                                cacheHits++;
                                                for (int j = 0; j < cachedItems.length(); j++) {
                                                    JSONObject item = cachedItems.optJSONObject(j);
                                                    if (item != null) collected.put(item);
                                                }
                                                nextPageNum = page + 1;
                                                continue;
                                            }
                                        }
                                    } catch (Exception ignored) {}
                                }

                                final String url = "https://github.com/search?q=" + URLEncoder.encode(queryStr, "UTF-8")
                                        + "&type=repositories&s=" + URLEncoder.encode(sort, "UTF-8") + "&o=desc"
                                        + (page > 1 ? "&p=" + page : "");
                                try {
                                    JSONObject sRes = fastFetchGitHubSearch(url, page);
                                    if (sRes == null) {
                                        final int pageArg = page;
                                        sRes = scheduler.withPageLease(contextId, "discovery", () -> {
                                            pageExecutor.navigate(url, 25000);
                                            JSONObject args = new JSONObject();
                                            args.put("pageSeq", pageArg);
                                            return pageExecutor.executeScript("readSearchResults", args);
                                        });
                                    }
                                    pagesFetched++;
                                    JSONArray found = sRes != null ? sRes.optJSONArray("items") : null;
                                    String nextUrl = sRes != null ? sRes.optString("nextUrl", "") : "";
                                    JSONArray normalizedBatch = new JSONArray();
                                    if (found != null) {
                                        for (int j = 0; j < found.length(); j++) {
                                            JSONObject item = normalizeSearchItem(found.optJSONObject(j), q, page);
                                            if (item != null) {
                                                normalizedBatch.put(item);
                                                collected.put(item);
                                            }
                                        }
                                        if (accountId != null && !accountId.isEmpty()) {
                                            localRepository.saveDiscoveryCache(
                                                    accountId,
                                                    cacheKey,
                                                    q.toString(),
                                                    normalizedBatch.toString(),
                                                    System.currentTimeMillis(),
                                                    System.currentTimeMillis() + DISCOVERY_CACHE_TTL_MS
                                            );
                                        }
                                    }
                                    if (!nextUrl.isEmpty() && !"null".equals(nextUrl)) {
                                        nextPageNum = page + 1;
                                    } else {
                                        nextPageNum = null;
                                        exhausted = true;
                                        break;
                                    }
                                } catch (Exception err) {
                                    report.put("error", err.getMessage());
                                    if (err.getMessage() != null && err.getMessage().contains("RATE_LIMITED")) {
                                        rateLimited.set(true);
                                    }
                                    break;
                                }
                            }
                            report.put("pagesFetched", pagesFetched);
                            report.put("cacheHits", cacheHits);
                            report.put("itemCount", 0);
                            report.put("nextPage", nextPageNum != null ? nextPageNum : JSONObject.NULL);
                            report.put("exhausted", exhausted);

                            JSONObject bundle = new JSONObject();
                            bundle.put("report", report);
                            bundle.put("items", collected);
                            return bundle;
                        }));
                    }

                    int pagesUsed = 0;
                    java.util.Set<String> seen = new java.util.HashSet<>();
                    JSONArray candidates = new JSONArray();
                    JSONArray queryReports = new JSONArray();
                    for (Future<JSONObject> f : futures) {
                        JSONObject bundle = f.get();
                        JSONObject report = bundle.getJSONObject("report");
                        JSONArray items = bundle.getJSONArray("items");
                        pagesUsed += report.optInt("pagesFetched", 0);
                        int added = 0;
                        for (int j = 0; j < items.length(); j++) {
                            JSONObject item = items.optJSONObject(j);
                            if (item == null) continue;
                            String key = item.optString("repoId", "");
                            if (key.isEmpty() || "null".equals(key)) {
                                key = item.optString("canonicalKey", "");
                            }
                            if (!key.isEmpty() && seen.add(key)) {
                                candidates.put(item);
                                added++;
                            }
                        }
                        report.put("itemCount", added);
                        queryReports.put(report);
                    }

                    JSObject res = new JSObject();
                    res.put("candidates", new JSArray(candidates.toString()));
                    res.put("count", candidates.length());
                    res.put("pagesUsed", pagesUsed);
                    res.put("bounded", true);
                    res.put("complete", false);
                    res.put("queries", new JSArray(queryReports.toString()));
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
                Boolean hiddenOverride = (payload.has("hidden") && !payload.isNull("hidden"))
                        ? payload.getBoolean("hidden")
                        : null;
                String eventId = payload.getString("eventId", "fb_" + System.currentTimeMillis());
                JSONObject fbRes = localRepository.recordRecommendationFeedback(
                        accountId,
                        payload.getString("repoId"),
                        payload.optString("kind", ""),
                        eventId,
                        hiddenOverride
                );
                backgroundExecutor.execute(() -> {
                    try {
                        cloudService.syncFeedbackPreferences(accountId, fbRes.optString("eventId", eventId));
                    } catch (Exception ignored) {}
                });
                resolveSuccess(call, new JSObject(fbRes.toString()));
                break;
            }

            case "recommendation.listHidden": {
                JSONObject hiddenRes = localRepository.listHiddenRecommendations(accountId);
                resolveSuccess(call, new JSObject(hiddenRes.toString()));
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
                        JSONObject item = localRepository.recordBrowse(accountId, repo, payload.optString("source", "open"), System.currentTimeMillis());
                        historySaved = true;
                        if (item.optBoolean("countedVisit", false)) {
                            backgroundExecutor.execute(() -> {
                                try { cloudService.flushOutbox(accountId); } catch (Exception ignored) {}
                            });
                        }
                    }
                }
                JSObject res = new JSObject();
                res.put("opened", true);
                res.put("historySaved", historySaved);
                resolveSuccess(call, res);
                break;
            }

            case "cloud.auth.begin": {
                JSONObject res = cloudService.beginAuth(accountId, payload.optBoolean("openBrowser", true));
                resolveSuccess(call, new JSObject(res.toString()));
                break;
            }

            case "cloud.auth.poll": {
                JSONObject res = cloudService.pollAuth(accountId, payload.getString("challengeId"));
                resolveSuccess(call, new JSObject(res.toString()));
                break;
            }

            case "cloud.auth.cancel": {
                JSONObject res = cloudService.cancelAuth(payload.optString("challengeId", null));
                resolveSuccess(call, new JSObject(res.toString()));
                break;
            }

            case "cloud.session.restore": {
                JSONObject res = cloudService.restoreSession(accountId);
                resolveSuccess(call, new JSObject(res.toString()));
                break;
            }

            case "cloud.session.logout": {
                JSONObject res = cloudService.logoutSession(accountId);
                resolveSuccess(call, new JSObject(res.toString()));
                break;
            }

            case "cloud.sync.readState": {
                JSONObject res = localRepository.readCloudSyncState(accountId);
                resolveSuccess(call, res != null ? new JSObject(res.toString()) : new JSObject());
                break;
            }

            case "cloud.sync.flush": {
                JSONObject res = cloudService.flushOutbox(accountId);
                resolveSuccess(call, new JSObject(res.toString()));
                break;
            }

            case "cloud.preferences.save": {
                JSONObject res = cloudService.savePreferences(accountId, payload);
                resolveSuccess(call, new JSObject(res.toString()));
                break;
            }

            case "cloud.analysis.reset": {
                JSONObject res = cloudService.resetAnalysis(accountId);
                resolveSuccess(call, new JSObject(res.toString()));
                break;
            }

            case "cloud.collections.sync": {
                JSONObject res = cloudService.syncCollections(accountId);
                resolveSuccess(call, new JSObject(res.toString()));
                break;
            }

            case "cloud.portrait.read": {
                JSONObject res = cloudService.readPortrait(accountId);
                resolveSuccess(call, res != null ? new JSObject(res.toString()) : new JSObject());
                break;
            }

            case "cloud.portrait.refresh": {
                JSONObject res = cloudService.refreshPortrait(accountId);
                resolveSuccess(call, new JSObject(res.toString()));
                break;
            }

            case "cloud.searchPlan.read": {
                JSONObject portrait = cloudService.readPortrait(accountId);
                JSObject res = new JSObject();
                res.put("status", portrait != null ? portrait.optString("status", "unbound") : "unbound");
                res.put("generationId", portrait != null ? portrait.opt("generationId") : JSONObject.NULL);
                res.put("modelVersion", portrait != null ? portrait.opt("modelVersion") : JSONObject.NULL);
                res.put("searchPlan", portrait != null ? portrait.opt("searchPlan") : JSONObject.NULL);
                resolveSuccess(call, res);
                break;
            }

            case "cloud.cohorts.read": {
                JSONObject res = cloudService.readCohorts();
                if (res != null) resolveSuccess(call, new JSObject(res.toString()));
                else resolveSuccess(call, new JSObject());
                break;
            }

            case "cloud.cohorts.refresh": {
                JSONObject res = cloudService.refreshCohorts(accountId);
                resolveSuccess(call, new JSObject(res.toString()));
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
            case "recommendation.listHidden":
            case "cloud.auth.begin":
            case "cloud.auth.poll":
            case "cloud.session.restore":
            case "cloud.session.logout":
            case "cloud.sync.readState":
            case "cloud.sync.flush":
            case "cloud.preferences.save":
            case "cloud.analysis.reset":
            case "cloud.collections.sync":
            case "cloud.portrait.read":
            case "cloud.portrait.refresh":
            case "cloud.searchPlan.read":
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

    private JSONObject fastFetchGitHubSearch(String urlStr, int pageSeq) throws Exception {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlStr);
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(12000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36");
            try {
                String cookie = CookieManager.getInstance().getCookie("https://github.com");
                if (cookie != null && !cookie.isEmpty()) {
                    conn.setRequestProperty("Cookie", cookie);
                }
            } catch (Exception ignored) {}

            int status = conn.getResponseCode();
            if (status == 429) {
                throw new Exception("RATE_LIMITED");
            }
            if (status < 200 || status >= 300) {
                return null;
            }

            StringBuilder sb = new StringBuilder();
            try (InputStream is = conn.getInputStream();
                 BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
                char[] buf = new char[8192];
                int n;
                while ((n = reader.read(buf)) != -1) {
                    sb.append(buf, 0, n);
                }
            }
            String html = sb.toString();
            Matcher titleMatcher = TITLE_TAG_PATTERN.matcher(html);
            if (titleMatcher.find()) {
                String title = titleMatcher.group(1);
                if (title != null && (title.contains("Rate limit") || title.contains("Whoa there!"))) {
                    throw new Exception("RATE_LIMITED");
                }
            }

            Matcher m = SCRIPT_TAG_PATTERN.matcher(html);
            while (m.find()) {
                String attrs = m.group(1);
                String body = m.group(2);
                if (attrs == null || body == null) continue;
                if (!attrs.contains("application/json") || !attrs.contains("embeddedData")) continue;
                if (!body.contains("blackbirdSearchRoute") && !body.contains("\"hl_name\"")) continue;
                try {
                    JSONObject parsed = new JSONObject(body);
                    JSONObject payload = parsed.optJSONObject("payload");
                    if (payload == null) continue;
                    JSONObject route = payload.optJSONObject("blackbirdSearchRoute");
                    if (route == null) route = payload;
                    JSONArray results = route.optJSONArray("results");
                    if (results == null) continue;

                    JSONArray items = new JSONArray();
                    java.util.Set<String> seenKeys = new java.util.HashSet<>();
                    for (int i = 0; i < results.length(); i++) {
                        JSONObject r = results.optJSONObject(i);
                        if (r == null) continue;
                        JSONObject repoWrapper = r.optJSONObject("repo");
                        JSONObject repoObj = repoWrapper != null ? repoWrapper.optJSONObject("repository") : null;
                        String fullName = "";
                        if (repoObj != null && !repoObj.optString("owner_login", "").isEmpty() && !repoObj.optString("name", "").isEmpty()) {
                            fullName = repoObj.optString("owner_login") + "/" + repoObj.optString("name");
                        } else if (!r.optString("hl_name", "").isEmpty()) {
                            fullName = cleanHtmlSnippet(r.optString("hl_name"));
                        }
                        if (fullName.isEmpty() || !fullName.contains("/")) continue;
                        String[] parts = fullName.split("/");
                        if (parts.length < 2) continue;
                        String normFull = parts[0] + "/" + parts[1];
                        String key = normFull.toLowerCase();
                        if (!seenKeys.add(key)) continue;

                        String desc = cleanHtmlSnippet(r.optString("hl_trunc_description", r.optString("description", "")));
                        JSONObject item = new JSONObject();
                        String idStr = r.has("id") && !r.isNull("id") ? String.valueOf(r.opt("id"))
                                : (repoObj != null && repoObj.has("id") && !repoObj.isNull("id") ? String.valueOf(repoObj.opt("id")) : "");
                        item.put("repoId", idStr.isEmpty() ? JSONObject.NULL : idStr);
                        item.put("canonicalKey", key);
                        item.put("owner", parts[0]);
                        item.put("name", parts[1]);
                        item.put("fullName", normFull);
                        item.put("htmlUrl", "https://github.com/" + normFull);
                        item.put("description", desc.isEmpty() ? JSONObject.NULL : desc);
                        item.put("purposeCue", desc.isEmpty() ? JSONObject.NULL : desc);
                        item.put("purposeSource", desc.isEmpty() ? JSONObject.NULL : "description");
                        String lang = r.optString("language", "").trim();
                        item.put("primaryLanguage", lang.isEmpty() || "null".equals(lang) ? JSONObject.NULL : lang);
                        if (r.has("followers") && !r.isNull("followers")) {
                            item.put("starCount", r.optLong("followers", 0));
                        } else {
                            item.put("starCount", JSONObject.NULL);
                        }
                        JSONArray topicsOut = new JSONArray();
                        JSONArray rawTopics = r.optJSONArray("topics");
                        if (rawTopics != null) {
                            for (int t = 0; t < rawTopics.length(); t++) {
                                Object tv = rawTopics.opt(t);
                                String ts = tv instanceof JSONObject ? ((JSONObject) tv).optString("name", "") : String.valueOf(tv);
                                ts = ts.trim().replaceFirst("^#", "");
                                if (!ts.isEmpty() && !"null".equals(ts)) topicsOut.put(ts);
                            }
                        }
                        item.put("topics", topicsOut);
                        String upd = repoObj != null ? repoObj.optString("updated_at", "") : r.optString("updated_at", "");
                        item.put("updatedAt", upd.isEmpty() || "null".equals(upd) ? JSONObject.NULL : upd);
                        items.put(item);
                    }

                    int pageCount = route.optInt("page_count", 0);
                    JSONObject out = new JSONObject();
                    out.put("items", items);
                    out.put("pageSeq", pageSeq);
                    if (items.length() > 0 && pageCount > pageSeq) {
                        out.put("nextUrl", urlStr + "&next=" + (pageSeq + 1));
                        out.put("completion", "more");
                    } else {
                        out.put("nextUrl", JSONObject.NULL);
                        out.put("completion", "end");
                    }
                    return out;
                } catch (Exception ignored) {}
            }
            return null;
        } catch (Exception e) {
            if (e.getMessage() != null && e.getMessage().contains("RATE_LIMITED")) {
                throw e;
            }
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private JSONObject normalizeSearchItem(JSONObject raw, JSONObject q, int page) {
        if (raw == null) return null;
        try {
            JSONObject item = new JSONObject(raw.toString());
            String fullName = item.optString("fullName", "").trim();
            if (fullName.isEmpty() || !fullName.contains("/")) return null;
            if (item.optString("canonicalKey", "").isEmpty()) {
                item.put("canonicalKey", fullName.toLowerCase());
            }
            String desc = item.optString("description", "").trim();
            if (!desc.isEmpty() && !"null".equals(desc)) {
                if (item.optString("purposeCue", "").isEmpty() || "null".equals(item.optString("purposeCue", ""))) {
                    item.put("purposeCue", desc);
                    item.put("purposeSource", "description");
                }
            }
            if (item.has("starCount") && item.opt("starCount") instanceof String) {
                Long parsedStars = parseCountText(item.optString("starCount", ""));
                item.put("starCount", parsedStars != null ? parsedStars : JSONObject.NULL);
            }
            JSONObject discBy = new JSONObject();
            discBy.put("queryId", q.has("id") ? q.opt("id") : JSONObject.NULL);
            discBy.put("directionId", q.has("directionId") ? q.opt("directionId") : JSONObject.NULL);
            discBy.put("generationId", q.has("generationId") ? q.opt("generationId") : JSONObject.NULL);
            discBy.put("page", page);
            item.put("discoveredBy", discBy);
            return item;
        } catch (Exception e) {
            return null;
        }
    }

    private static Long parseCountText(String raw) {
        if (raw == null) return null;
        String s = raw.trim().toLowerCase().replace(",", "");
        if (s.isEmpty() || "null".equals(s)) return null;
        try {
            if (s.endsWith("k")) {
                return Math.round(Double.parseDouble(s.substring(0, s.length() - 1)) * 1000.0);
            }
            if (s.endsWith("m")) {
                return Math.round(Double.parseDouble(s.substring(0, s.length() - 1)) * 1000000.0);
            }
            return Long.parseLong(s);
        } catch (Exception e) {
            return null;
        }
    }

    private static String cleanHtmlSnippet(String raw) {
        if (raw == null || raw.isEmpty()) return "";
        String noTags = HTML_TAG_PATTERN.matcher(raw).replaceAll("");
        return noTags
                .replace("&quot;", "\"")
                .replace("&#39;", "'")
                .replace("&apos;", "'")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&nbsp;", " ")
                .replace("&amp;", "&")
                .replaceAll("\\s+", " ")
                .trim();
    }

    @Override
    protected void handleOnDestroy() {
        searchExecutor.shutdownNow();
        backgroundExecutor.shutdownNow();
        if (webViewHost != null) {
            webViewHost.destroy();
        }
        super.handleOnDestroy();
    }
}
