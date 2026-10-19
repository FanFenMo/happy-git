package com.happygit.app.nativebridge;

import org.json.JSONObject;

public class StarService {

    private final LocalRepository localRepository;
    private final PageTaskScheduler scheduler;
    private final PageExecutor pageExecutor;

    public StarService(LocalRepository localRepository, PageTaskScheduler scheduler, PageExecutor pageExecutor) {
        this.localRepository = localRepository;
        this.scheduler = scheduler;
        this.pageExecutor = pageExecutor;
    }

    public JSONObject readState(JSONObject context, String repoId, String fullName) {
        String accountId = context.optString("accountId");
        return localRepository.readStarState(accountId, repoId, fullName);
    }

    public JSONObject set(JSONObject context, JSONObject repository, boolean desiredStarred, String intentId) throws Exception {
        String accountId = context.optString("accountId");
        String contextId = context.optString("contextId");
        if (accountId.isEmpty() || !"authenticated".equals(context.optString("status"))) {
            throw new Exception("AUTH_REQUIRED");
        }

        String repoKey = repository.optString("repoId", repository.optString("canonicalKey"));
        String operationId = "op_" + intentId;

        JSONObject op = new JSONObject();
        op.put("operationId", operationId);
        op.put("accountId", accountId);
        op.put("repoId", repoKey);
        op.put("intentId", intentId);
        op.put("desiredStarred", desiredStarred);
        op.put("state", "created");
        localRepository.saveWebsiteOperation(op);

        return scheduler.withPageLease(contextId, "star", () -> {
            String fullName = repository.getString("fullName");
            String url = "https://github.com/" + fullName;
            pageExecutor.navigate(url, 25000);

            JSONObject before = pageExecutor.executeScript("readRepositoryStarState", null);
            boolean beforeStarred = before.optBoolean("starred", false);
            if (before.has("starred") && !before.isNull("starred") && beforeStarred == desiredStarred) {
                localRepository.updateWebsiteOperation(operationId, "unchanged", null, System.currentTimeMillis(), null);
                localRepository.applyConfirmedStar(accountId, repository, desiredStarred);
                JSONObject res = new JSONObject();
                res.put("state", "unchanged");
                res.put("starred", desiredStarred);
                res.put("confirmed", true);
                res.put("localCacheSaved", true);
                return res;
            }

            long attemptedTime = System.currentTimeMillis();
            localRepository.updateWebsiteOperation(operationId, "attempted", attemptedTime, null, null);

            JSONObject clickArgs = new JSONObject();
            clickArgs.put("desiredStarred", desiredStarred);
            JSONObject clickRes = pageExecutor.executeScript("setRepositoryStar", clickArgs);

            if (!clickRes.optBoolean("clicked", false)) {
                localRepository.updateWebsiteOperation(operationId, "failed", attemptedTime, null, "BUTTON_NOT_FOUND");
                JSONObject res = new JSONObject();
                res.put("state", "uncertain");
                res.put("starred", before.opt("starred"));
                res.put("confirmed", false);
                return res;
            }

            Thread.sleep(800);
            pageExecutor.reload(25000);

            JSONObject after = pageExecutor.executeScript("readRepositoryStarState", null);
            if (after.has("starred") && !after.isNull("starred") && after.optBoolean("starred") == desiredStarred) {
                long confirmedTime = System.currentTimeMillis();
                localRepository.updateWebsiteOperation(operationId, "confirmed", attemptedTime, confirmedTime, null);
                boolean localSaved = true;
                try {
                    localRepository.applyConfirmedStar(accountId, repository, desiredStarred);
                } catch (Exception e) {
                    localSaved = false;
                }
                JSONObject res = new JSONObject();
                res.put("state", "confirmed");
                res.put("starred", desiredStarred);
                res.put("confirmed", true);
                res.put("localCacheSaved", localSaved);
                return res;
            } else {
                localRepository.updateWebsiteOperation(operationId, "uncertain", attemptedTime, null, "STAR_STATE_UNCERTAIN");
                JSONObject res = new JSONObject();
                res.put("state", "uncertain");
                res.put("starred", after.opt("starred"));
                res.put("confirmed", false);
                return res;
            }
        });
    }
}
