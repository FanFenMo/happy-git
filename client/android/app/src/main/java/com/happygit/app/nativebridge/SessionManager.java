package com.happygit.app.nativebridge;

import android.content.Context;
import android.content.Intent;
import com.happygit.app.GitHubLoginActivity;
import org.json.JSONObject;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

public class SessionManager {

    private static volatile SessionManager instance;

    private final Context context;
    private final LocalRepository localRepository;
    private final GitHubWebViewHost webViewHost;
    private final PageTaskScheduler scheduler;
    private final PageExecutor pageExecutor;

    private String contextId;
    private String accountId;
    private String login;
    private String status = "guest";
    private Long verifiedAt;
    private JSONObject profile;

    private final Map<String, JSONObject> loginTasks = new ConcurrentHashMap<>();

    public SessionManager(Context context, LocalRepository localRepository, GitHubWebViewHost webViewHost, PageTaskScheduler scheduler, PageExecutor pageExecutor) {
        this.context = context.getApplicationContext();
        this.localRepository = localRepository;
        this.webViewHost = webViewHost;
        this.scheduler = scheduler;
        this.pageExecutor = pageExecutor;
        this.contextId = UUID.randomUUID().toString();
        instance = this;
    }

    public static SessionManager getInstance() {
        return instance;
    }

    public synchronized JSONObject getSessionContext() {
        JSONObject obj = new JSONObject();
        try {
            obj.put("contextId", contextId);
            obj.put("accountId", accountId != null ? accountId : JSONObject.NULL);
            obj.put("login", login != null ? login : JSONObject.NULL);
            obj.put("status", status);
            obj.put("verifiedAt", verifiedAt != null ? verifiedAt : JSONObject.NULL);
            obj.put("profile", profile != null ? profile : JSONObject.NULL);
        } catch (Exception ignored) {}
        return obj;
    }

    public synchronized void assertContext(String reqContextId) throws Exception {
        if (reqContextId != null && !reqContextId.isEmpty() && !reqContextId.equals(this.contextId)) {
            throw new Exception("SESSION_CHANGED");
        }
    }

    public synchronized JSONObject restoreSession() {
        status = "restoring";
        try {
            String activeAccountId = localRepository.readSetting("active_account_id");
            if (activeAccountId == null || activeAccountId.isEmpty()) {
                contextId = UUID.randomUUID().toString();
                accountId = null;
                login = null;
                status = "guest";
                verifiedAt = null;
                profile = null;
                return getSessionContext();
            }

            JSONObject snapshot = localRepository.readAccountSnapshot(activeAccountId);
            if (snapshot.isNull("profile")) {
                status = "guest";
                return getSessionContext();
            }

            this.profile = snapshot.getJSONObject("profile");
            this.login = profile.optString("login");
            this.accountId = activeAccountId;
            this.status = "authenticated";
            this.verifiedAt = System.currentTimeMillis();
            this.contextId = UUID.randomUUID().toString();

            // 异步后台验证远端身份
            new Thread(() -> {
                try {
                    scheduler.withPageLease(contextId, "verify", () -> {
                        pageExecutor.navigate("https://github.com", 15000);
                        JSONObject identity = pageExecutor.executeScript("readCurrentIdentity", null);
                        if ("anonymous".equals(identity.optString("kind"))) {
                            synchronized (SessionManager.this) {
                                status = "reauth_required";
                            }
                        }
                        return null;
                    });
                } catch (Exception e) {
                    if (e.getMessage() != null && e.getMessage().contains("NETWORK_UNAVAILABLE")) {
                        synchronized (SessionManager.this) {
                            status = "offline";
                        }
                    }
                }
            }).start();

        } catch (Exception e) {
            status = "guest";
        }
        return getSessionContext();
    }

    public synchronized JSONObject beginLogin(String intentStr) {
        String loginTaskId = "login_" + System.currentTimeMillis() + "_" + UUID.randomUUID().toString().substring(0, 6);
        JSONObject task = new JSONObject();
        try {
            task.put("loginTaskId", loginTaskId);
            task.put("state", "opening");
            task.put("intent", intentStr != null ? intentStr : "login");
            task.put("session", JSONObject.NULL);
            task.put("error", JSONObject.NULL);
        } catch (Exception ignored) {}
        loginTasks.put(loginTaskId, task);

        Intent intent = new Intent(context, GitHubLoginActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        intent.putExtra("loginTaskId", loginTaskId);
        context.startActivity(intent);

        JSONObject res = new JSONObject();
        try {
            res.put("loginTaskId", loginTaskId);
            res.put("state", "opening");
        } catch (Exception ignored) {}
        return res;
    }

    public JSONObject getLoginTask(String loginTaskId) {
        return loginTasks.get(loginTaskId);
    }

    public synchronized JSONObject cancelLogin(String loginTaskId) {
        JSONObject task = loginTasks.get(loginTaskId);
        if (task != null) {
            try { task.put("state", "cancelled"); } catch (Exception ignored) {}
        }
        JSONObject res = new JSONObject();
        try { res.put("cancelled", true); } catch (Exception ignored) {}
        return res;
    }

    public synchronized void onIdentityDetected(String loginTaskId, String detectedLogin, String detectedAccountId) {
        JSONObject task = loginTasks.get(loginTaskId);
        if (task != null && "cancelled".equals(task.optString("state"))) {
            return;
        }

        try {
            activateIdentity(detectedLogin, detectedAccountId);
            if (task != null) {
                task.put("state", "authenticated");
                task.put("session", getSessionContext());
            }
        } catch (Exception e) {
            if (task != null) {
                try {
                    task.put("state", "failed");
                    JSONObject err = new JSONObject();
                    err.put("code", "ACTIVATE_FAILED");
                    err.put("message", e.getMessage());
                    task.put("error", err);
                } catch (Exception ignored) {}
            }
        }
    }

    public synchronized void onLoginClosed(String loginTaskId) {
        JSONObject task = loginTasks.get(loginTaskId);
        if (task != null && !"authenticated".equals(task.optString("state"))) {
            try { task.put("state", "cancelled"); } catch (Exception ignored) {}
        }
    }

    public synchronized void activateIdentity(String detectedLogin, String detectedAccountId) throws Exception {
        String finalAccountId = detectedAccountId;

        // 尝试到个人资料页提取完整资料补齐数字 ID
        JSONObject profileData = new JSONObject();
        profileData.put("login", detectedLogin);
        profileData.put("displayName", detectedLogin);
        profileData.put("profileUrl", "https://github.com/" + detectedLogin);
        profileData.put("fetchedAt", System.currentTimeMillis());

        try {
            scheduler.withPageLease(contextId, "identity", () -> {
                pageExecutor.navigate("https://github.com/" + detectedLogin, 20000);
                JSONObject args = new JSONObject();
                args.put("expectedLogin", detectedLogin);
                JSONObject p = pageExecutor.executeScript("readProfile", args);
                if (p != null && p.length() > 0) {
                    profileData.put("bio", p.opt("bio"));
                    profileData.put("location", p.opt("location"));
                    profileData.put("company", p.opt("company"));
                    profileData.put("avatarUrl", p.opt("avatarUrl"));
                    if (p.has("accountId") && !p.isNull("accountId")) {
                        profileData.put("accountId", p.getString("accountId"));
                    }
                }
                return null;
            });
        } catch (Exception ignored) {}

        if (finalAccountId == null || finalAccountId.isEmpty()) {
            finalAccountId = profileData.optString("accountId", detectedLogin);
        }
        profileData.put("accountId", finalAccountId);

        localRepository.saveProfile(finalAccountId, profileData);
        localRepository.saveSetting("active_account_id", finalAccountId);

        this.contextId = UUID.randomUUID().toString();
        this.accountId = finalAccountId;
        this.login = detectedLogin;
        this.status = "authenticated";
        this.verifiedAt = System.currentTimeMillis();
        this.profile = profileData;
    }

    public synchronized JSONObject logout() {
        this.status = "logging_out";
        CountDownLatch latch = new CountDownLatch(1);
        webViewHost.clearSession(latch::countDown);
        try {
            latch.await(5, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {}

        localRepository.saveSetting("active_account_id", "");

        this.contextId = UUID.randomUUID().toString();
        this.accountId = null;
        this.login = null;
        this.status = "guest";
        this.verifiedAt = null;
        this.profile = null;

        return getSessionContext();
    }

    public synchronized JSONObject forgetCurrentAccount() {
        String act = this.accountId;
        logout();
        if (act != null && !act.isEmpty()) {
            localRepository.forgetAccount(act);
        }
        JSONObject res = new JSONObject();
        try { res.put("ok", true); } catch (Exception ignored) {}
        return res;
    }

    public String getCurrentAccountId() {
        return accountId;
    }
}
