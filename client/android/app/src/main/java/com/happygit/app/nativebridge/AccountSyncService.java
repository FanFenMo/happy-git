package com.happygit.app.nativebridge;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

public class AccountSyncService {

    private final LocalRepository localRepository;
    private final PageTaskScheduler scheduler;
    private final PageExecutor pageExecutor;
    private final Map<String, JSONObject> activeTasks = new ConcurrentHashMap<>();

    public AccountSyncService(LocalRepository localRepository, PageTaskScheduler scheduler, PageExecutor pageExecutor) {
        this.localRepository = localRepository;
        this.scheduler = scheduler;
        this.pageExecutor = pageExecutor;
    }

    public JSONObject getTask(String taskId) {
        return activeTasks.get(taskId);
    }

    public boolean cancelTask(String taskId) {
        JSONObject task = activeTasks.get(taskId);
        if (task != null) {
            try {
                task.put("isEnded", true);
                JSONObject err = new JSONObject();
                err.put("code", "TASK_CANCELLED");
                err.put("message", "任务已取消");
                task.put("error", err);
            } catch (Exception ignored) {}
            return true;
        }
        return false;
    }

    public synchronized JSONObject start(JSONObject context, JSONArray collections, boolean force) throws Exception {
        String taskId = "sync_" + System.currentTimeMillis() + "_" + UUID.randomUUID().toString().substring(0, 6);
        JSONObject taskRecord = new JSONObject();
        taskRecord.put("taskId", taskId);
        taskRecord.put("stage", "starting");
        taskRecord.put("scannedCount", 0);
        taskRecord.put("acceptedCount", 0);
        taskRecord.put("skippedPrivateCount", 0);
        taskRecord.put("pageSeq", 0);
        taskRecord.put("isEnded", false);
        taskRecord.put("error", JSONObject.NULL);
        activeTasks.put(taskId, taskRecord);

        String accountId = context.getString("accountId");
        String login = context.getString("login");
        String contextId = context.getString("contextId");

        new Thread(() -> {
            try {
                boolean syncProfile = false;
                boolean syncRepos = false;
                boolean syncStars = false;
                for (int i = 0; i < collections.length(); i++) {
                    String c = collections.getString(i);
                    if ("profile".equals(c)) syncProfile = true;
                    if ("repos".equals(c)) syncRepos = true;
                    if ("stars".equals(c)) syncStars = true;
                }

                if (syncProfile) {
                    taskRecord.put("stage", "syncing_profile");
                    doSyncProfile(accountId, login, contextId, taskRecord);
                }
                if (syncRepos && !taskRecord.getBoolean("isEnded")) {
                    taskRecord.put("stage", "syncing_repos");
                    doSyncCollection(accountId, login, "repos", contextId, taskRecord);
                }
                if (syncStars && !taskRecord.getBoolean("isEnded")) {
                    taskRecord.put("stage", "syncing_stars");
                    doSyncCollection(accountId, login, "stars", contextId, taskRecord);
                }

                taskRecord.put("stage", "finished");
                taskRecord.put("isEnded", true);
            } catch (Exception e) {
                try {
                    taskRecord.put("stage", "failed");
                    taskRecord.put("isEnded", true);
                    JSONObject err = new JSONObject();
                    err.put("code", "SYNC_ERROR");
                    err.put("message", e.getMessage() != null ? e.getMessage() : "同步失败");
                    taskRecord.put("error", err);
                } catch (Exception ignored) {}
            }
        }).start();

        JSONObject res = new JSONObject();
        res.put("taskId", taskId);
        return res;
    }

    private void doSyncProfile(String accountId, String login, String contextId, JSONObject task) throws Exception {
        scheduler.withPageLease(contextId, "sync", () -> {
            String url = "https://github.com/" + URLEncoder.encode(login, "UTF-8");
            pageExecutor.navigate(url, 20000);
            JSONObject args = new JSONObject();
            args.put("expectedLogin", login);
            JSONObject p = pageExecutor.executeScript("readProfile", args);
            if (p != null && p.length() > 0) {
                p.put("accountId", accountId);
                localRepository.saveProfile(accountId, p);
            }
            return null;
        });
    }

    private void doSyncCollection(String accountId, String login, String kind, String contextId, JSONObject task) throws Exception {
        String generationId = localRepository.beginSync(accountId, kind);
        String currentUrl = "repos".equals(kind)
                ? "https://github.com/" + URLEncoder.encode(login, "UTF-8") + "?tab=repositories"
                : "https://github.com/" + URLEncoder.encode(login, "UTF-8") + "?tab=stars";

        int pageSeq = 1;
        Set<String> visited = new HashSet<>();

        try {
            while (currentUrl != null && !task.getBoolean("isEnded")) {
                if (visited.contains(currentUrl)) {
                    throw new Exception("PAGINATION_STALLED");
                }
                visited.add(currentUrl);

                final String fetchUrl = currentUrl;
                final int seq = pageSeq;

                JSONObject pageResult = scheduler.withPageLease(contextId, "sync", () -> {
                    pageExecutor.navigate(fetchUrl, 25000);
                    JSONObject args = new JSONObject();
                    args.put("expectedLogin", login);
                    args.put("pageSeq", seq);
                    return pageExecutor.executeScript("repos".equals(kind) ? "readOwnedRepositories" : "readStarredRepositories", args);
                });

                if (pageResult == null || task.getBoolean("isEnded")) break;

                JSONArray items = pageResult.optJSONArray("items");
                if (items == null) items = new JSONArray();

                task.put("scannedCount", task.getInt("scannedCount") + items.length());
                task.put("acceptedCount", task.getInt("acceptedCount") + items.length());
                task.put("pageSeq", seq);

                String nextUrl = pageResult.isNull("nextUrl") ? null : pageResult.optString("nextUrl", null);

                localRepository.writeSyncPage(accountId, kind, generationId, seq, items, nextUrl, null);

                String completion = pageResult.optString("completion", "end");
                if ("end".equals(completion) || nextUrl == null || nextUrl.isEmpty()) {
                    localRepository.finishSync(accountId, kind, generationId);
                    break;
                }

                currentUrl = nextUrl;
                pageSeq++;
            }
        } catch (Exception e) {
            localRepository.abortSync(accountId, kind, generationId, "SYNC_FAILED", null);
            throw e;
        }
    }
}
