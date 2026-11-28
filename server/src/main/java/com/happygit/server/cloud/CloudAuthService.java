package com.happygit.server.cloud;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.web.client.RestClient;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.web.util.HtmlUtils;
import java.net.*;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import static com.happygit.server.cloud.CloudJson.*;

@Service @Profile("cloud")
public class CloudAuthService {
    private final JdbcTemplate db;
    private final TransactionTemplate tx;
    private final RestClient http;
    private final String clientId, clientSecret, callback;
    private final boolean localAuthEnabled;
    private final ConcurrentHashMap<String, ObjectNode> localHints = new ConcurrentHashMap<>();

    public CloudAuthService(JdbcTemplate db, PlatformTransactionManager manager,
            String clientId, String clientSecret, String callback) {
        this(db, manager, clientId, clientSecret, callback, false);
    }

    @Autowired
    public CloudAuthService(JdbcTemplate db, PlatformTransactionManager manager,
            @Value("${happygit.cloud.client-id}") String clientId,
            @Value("${happygit.cloud.client-secret}") String clientSecret,
            @Value("${happygit.cloud.callback-url}") String callback,
            @Value("${happygit.cloud.local-auth-enabled:false}") boolean localAuthEnabled) {
        this.db = db; this.tx = new TransactionTemplate(manager);
        this.clientId = clientId; this.clientSecret = clientSecret; this.callback = callback;
        this.localAuthEnabled = localAuthEnabled;
        var factory = new JdkClientHttpRequestFactory(HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build());
        factory.setReadTimeout(Duration.ofSeconds(20)); this.http = RestClient.builder().requestFactory(factory).build();
    }

    public ObjectNode begin(JsonNode body) {
        String proof = body.path("codeChallenge").asText("");
        if (!proof.matches("[A-Za-z0-9_-]{43}")) throw error(400,"INVALID_PROOF","需要 S256 codeChallenge");
        boolean oauthConfigured = !clientId.isBlank() && !clientSecret.isBlank() && !callback.isBlank();
        if (!oauthConfigured && !localAuthEnabled) throw error(503,"AUTH_NOT_CONFIGURED","云端身份尚未配置");
        long now = System.currentTimeMillis();
        db.update("DELETE FROM cloud_logins WHERE expires_at < ?", now);
        localHints.entrySet().removeIf(entry -> entry.getValue().path("expiresAt").asLong(0) < now);
        if (db.queryForObject("SELECT COUNT(*) FROM cloud_logins",Long.class) >= 1000) throw error(429,"LOGIN_BUSY","请稍后发起授权");
        String id = secret(), state = secret(), verifier = secret(); long expires = now + 600_000;
        db.update("INSERT INTO cloud_logins VALUES(?,?,?,?,'pending',NULL,?)", id, proof, hash(state), verifier, expires);
        if (oauthConfigured) {
            return object().put("challengeId",id).put("expiresAt",expires).put("intervalMs",1500)
                    .put("authorizationUrl","https://github.com/login/oauth/authorize?client_id="+encode(clientId)+"&redirect_uri="+encode(callback)
                            +"&state="+state+"&code_challenge="+challenge(verifier)+"&code_challenge_method=S256&scope=read%3Auser");
        }
        String hintAccountId = cleanAccountId(body.path("accountId").asText(""));
        String hintLogin = cleanLogin(body.path("login").asText(""));
        String hintDisplayName = body.path("displayName").asText("").trim();
        ObjectNode hint = object().put("accountId", hintAccountId).put("login", hintLogin)
                .put("displayName", hintDisplayName).put("expiresAt", expires);
        localHints.put(id, hint);
        String origin = resolveLocalBaseOrigin();
        return object().put("challengeId",id).put("expiresAt",expires).put("intervalMs",1000)
                .put("authMode","local")
                .put("authorizationUrl", origin + "/api/v2/auth/github/local-authorize?state=" + encode(state));
    }

    public String renderLocalAuthorizePage(String state) {
        if (!localAuthEnabled) {
            return renderHtmlPage("云端授权未启用", "<p class=\"err\">当前服务端未开启本地受控授权模式。</p>", false);
        }
        if (state == null || state.isBlank()) {
            return renderHtmlPage("授权参数缺失", "<p class=\"err\">缺少授权 state 参数，请返回 HappyGit 重新发起授权。</p>", false);
        }
        long now = System.currentTimeMillis();
        List<Map<String,Object>> rows = db.queryForList(
                "SELECT * FROM cloud_logins WHERE state_hash=? AND status='pending' AND expires_at>?",
                hash(state), now);
        if (rows.isEmpty()) {
            return renderHtmlPage("授权链接已失效", "<p class=\"err\">本次授权请求已过期、已取消或已消费，请返回 HappyGit 重新点击授权。</p>", false);
        }
        String challengeId = (String) rows.get(0).get("challenge_id");
        ObjectNode hint = localHints.getOrDefault(challengeId, object());
        String accountId = cleanAccountId(hint.path("accountId").asText(""));
        String login = cleanLogin(hint.path("login").asText(""));
        String displayName = hint.path("displayName").asText("").trim();

        String safeState = HtmlUtils.htmlEscape(state);
        String safeAccountId = HtmlUtils.htmlEscape(accountId);
        String safeLogin = HtmlUtils.htmlEscape(login);
        String safeDisplay = HtmlUtils.htmlEscape(!displayName.isEmpty() ? displayName : (!login.isEmpty() ? login : "GitHub 开发者"));

        String accountSection;
        if (!accountId.isEmpty() && !login.isEmpty()) {
            accountSection = "<div class=\"account-card\">"
                    + "<div class=\"avatar\">" + HtmlUtils.htmlEscape(login.substring(0, 1).toUpperCase(Locale.ROOT)) + "</div>"
                    + "<div><div class=\"name\">" + safeDisplay + "</div>"
                    + "<div class=\"meta\">@" + safeLogin + " · ID " + safeAccountId + "</div></div></div>"
                    + "<input type=\"hidden\" name=\"accountId\" value=\"" + safeAccountId + "\"/>"
                    + "<input type=\"hidden\" name=\"login\" value=\"" + safeLogin + "\"/>";
        } else {
            accountSection = "<div class=\"field\"><label>GitHub 数字 ID</label>"
                    + "<input name=\"accountId\" required pattern=\"[0-9]+\" value=\"" + safeAccountId + "\" placeholder=\"例如 210000727\"/></div>"
                    + "<div class=\"field\"><label>GitHub 用户名</label>"
                    + "<input name=\"login\" required value=\"" + safeLogin + "\" placeholder=\"例如 FanFenMo\"/></div>";
        }

        String body = "<div class=\"badge\">HappyGit Cloud · 授权确认</div>"
                + "<h1>授权同步个人技术画像</h1>"
                + "<p class=\"desc\">确认后将绑定当前桌面端账号到云端分析服务，自动上传公开仓库、Star 与有效浏览线索，并即时更新云端个人技术画像。</p>"
                + "<form method=\"post\" action=\"/api/v2/auth/github/local-approve\">"
                + "<input type=\"hidden\" name=\"state\" value=\"" + safeState + "\"/>"
                + accountSection
                + "<ul class=\"scope\"><li>仅同步公开仓库、公开 Star 与本机有效浏览事件</li><li>严格核对本地与云端 GitHub 账号 ID 一致性</li><li>授权完成后自动计算并刷新个人云端画像</li></ul>"
                + "<div class=\"actions\">"
                + "<button type=\"submit\" name=\"action\" value=\"approve\" class=\"btn primary\">确认授权并更新云端画像</button>"
                + "<button type=\"submit\" name=\"action\" value=\"deny\" class=\"btn ghost\">取消授权</button>"
                + "</div></form>";
        return renderHtmlPage("HappyGit 云端账号授权", body, false);
    }

    public boolean approveLocalAuthorize(String state, String rawAccountId, String rawLogin, String action) {
        if (!localAuthEnabled || state == null || state.isBlank()) return false;
        List<Map<String,Object>> rows = db.queryForList("SELECT * FROM cloud_logins WHERE state_hash=?", hash(state));
        if (rows.isEmpty()) return false;
        var pending = rows.get(0);
        String id = (String) pending.get("challenge_id");
        long now = System.currentTimeMillis();
        if (db.update("UPDATE cloud_logins SET status='exchanging' WHERE challenge_id=? AND status='pending' AND expires_at>?", id, now) != 1) {
            return false;
        }
        ObjectNode hint = localHints.remove(id);
        if ("deny".equalsIgnoreCase(action)) {
            db.update("UPDATE cloud_logins SET status='denied' WHERE challenge_id=?", id);
            return false;
        }
        String accountId = cleanAccountId(rawAccountId);
        if (accountId.isEmpty() && hint != null) accountId = cleanAccountId(hint.path("accountId").asText(""));
        String login = cleanLogin(rawLogin);
        if (login.isEmpty() && hint != null) login = cleanLogin(hint.path("login").asText(""));
        if (accountId.isEmpty() || login.isEmpty()) {
            db.update("UPDATE cloud_logins SET status='denied' WHERE challenge_id=?", id);
            return false;
        }
        final String finalAccountId = accountId;
        final String finalLogin = login;
        try {
            return Boolean.TRUE.equals(tx.execute(status -> {
                db.update("INSERT INTO cloud_users(subject_id,github_id,login,preferences_json,created_at) VALUES(?,?,?,'{\"manualTags\":[],\"hiddenRepoIds\":[]}',?) ON DUPLICATE KEY UPDATE login=VALUES(login)",
                        UUID.randomUUID().toString(), finalAccountId, finalLogin, System.currentTimeMillis());
                String subject = db.queryForObject("SELECT subject_id FROM cloud_users WHERE github_id=?", String.class, finalAccountId);
                return db.update("UPDATE cloud_logins SET status='authenticated',subject_id=? WHERE challenge_id=? AND status='exchanging' AND expires_at>?",
                        subject, id, System.currentTimeMillis()) == 1;
            }));
        } catch (RuntimeException failure) {
            db.update("UPDATE cloud_logins SET status='denied' WHERE challenge_id=?", id);
            return false;
        }
    }

    public static String renderLocalResultPage(boolean ok, String action) {
        if (ok) {
            return renderHtmlPage("授权成功",
                    "<div class=\"badge ok\">授权已确认</div><h1>云端身份绑定成功</h1>"
                    + "<p class=\"desc\">HappyGit 正在自动同步您的公开仓库并计算云端个人技术画像，请返回应用查看动态画像视图。</p>"
                    + "<p class=\"tip\">此页面可安全关闭。</p>",
                    true);
        }
        boolean denied = "deny".equalsIgnoreCase(action);
        return renderHtmlPage(denied ? "已取消授权" : "授权未完成",
                "<div class=\"badge err\">" + (denied ? "已取消" : "授权未完成") + "</div><h1>"
                + (denied ? "您已取消本次云端授权" : "本次授权未能完成") + "</h1>"
                + "<p class=\"desc\">请返回 HappyGit，如需开启云端画像可随时重新发起授权。</p>",
                false);
    }

    private static String renderHtmlPage(String title, String content, boolean autoHint) {
        return "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
                + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                + "<title>" + HtmlUtils.htmlEscape(title) + "</title>"
                + "<style>"
                + "body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f5f7fa;color:#18283e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}"
                + ".card{width:100%;max-width:440px;background:#fff;border:1px solid rgba(207,217,232,.9);border-radius:16px;padding:28px;box-shadow:0 18px 48px rgba(24,40,62,.1)}"
                + ".badge{display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600;background:#edf2ff;color:#315ee7;margin-bottom:12px}"
                + ".badge.ok{background:#e7f6ee;color:#1f6f45}.badge.err{background:#fdecee;color:#ad3944}"
                + "h1{margin:0 0 10px;font-size:21px;line-height:1.35}.desc{margin:0 0 18px;font-size:13px;line-height:1.7;color:#53637a}"
                + ".account-card{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:12px;background:#f4f7fc;border:1px solid #dbe4f3;margin-bottom:16px}"
                + ".avatar{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;background:#315ee7;color:#fff;font-weight:700}"
                + ".name{font-size:14px;font-weight:700}.meta{font-size:12px;color:#53637a;font-family:monospace;margin-top:2px}"
                + ".field{margin-bottom:12px}.field label{display:block;font-size:12px;font-weight:600;margin-bottom:4px}"
                + ".field input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #cfd9e8;font-size:13px}"
                + ".scope{margin:0 0 20px;padding-left:18px;font-size:12px;line-height:1.8;color:#53637a}"
                + ".actions{display:grid;gap:10px}.btn{min-height:42px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid transparent}"
                + ".btn.primary{background:#315ee7;color:#fff}.btn.primary:hover{background:#244ccd}"
                + ".btn.ghost{background:#eef2f7;color:#18283e;border-color:#cfd9e8}"
                + ".tip{font-size:12px;color:#66758b;margin-top:12px}.err{color:#ad3944;font-size:13px;line-height:1.6}"
                + "</style></head><body><main class=\"card\">" + content + "</main>"
                + (autoHint ? "<script>setTimeout(()=>{try{window.close()}catch(_){}},1200)</script>" : "")
                + "</body></html>";
    }

    private String resolveLocalBaseOrigin() {
        if (callback != null && !callback.isBlank()) {
            try {
                URI uri = URI.create(callback.trim());
                if (uri.getScheme() != null && uri.getAuthority() != null) {
                    return uri.getScheme() + "://" + uri.getAuthority();
                }
            } catch (Exception ignored) {}
        }
        return "http://127.0.0.1:8080";
    }

    private static String cleanAccountId(String raw) {
        if (raw == null) return "";
        String cleaned = raw.trim();
        return cleaned.matches("[0-9]{1,32}") ? cleaned : "";
    }

    private static String cleanLogin(String raw) {
        if (raw == null) return "";
        String first = raw.trim().split("[\\s·]+")[0];
        return first.matches("[A-Za-z0-9][A-Za-z0-9-]{0,38}") ? first : "";
    }

    public boolean callback(String state, String code, String denied) {
        if (state == null) return false;
        List<Map<String,Object>> rows = db.queryForList("SELECT * FROM cloud_logins WHERE state_hash=?", hash(state));
        if (rows.isEmpty()) return false;
        var pending = rows.get(0); String id = (String) pending.get("challenge_id"); long now = System.currentTimeMillis();
        if (db.update("UPDATE cloud_logins SET status='exchanging' WHERE challenge_id=? AND status='pending' AND expires_at>?",id,now) != 1) return false;
        try {
            if (denied != null || code == null) throw error(401,"AUTH_DENIED","授权未完成");
            JsonNode tokens = http.post().uri("https://github.com/login/oauth/access_token").header("Accept","application/json")
                    .body(Map.of("client_id",clientId,"client_secret",clientSecret,"code",code,"redirect_uri",callback,"code_verifier",pending.get("verifier")))
                    .retrieve().body(JsonNode.class);
            if (tokens == null || !tokens.hasNonNull("access_token")) throw error(401,"AUTH_DENIED","授权未完成");
            JsonNode identity = http.get().uri("https://api.github.com/user").header("Accept","application/vnd.github+json")
                    .header("Authorization","Bearer "+tokens.path("access_token").asText()).retrieve().body(JsonNode.class);
            if (identity == null || !identity.path("id").asText().matches("[0-9]+")) throw error(502,"INVALID_UPSTREAM_IDENTITY","GitHub 身份无效");
            return tx.execute(status -> {
                db.update("INSERT INTO cloud_users(subject_id,github_id,login,preferences_json,created_at) VALUES(?,?,?,'{\"manualTags\":[],\"hiddenRepoIds\":[]}',?) ON DUPLICATE KEY UPDATE login=VALUES(login)",
                        UUID.randomUUID().toString(),identity.path("id").asText(),identity.path("login").asText(),System.currentTimeMillis());
                String subject = db.queryForObject("SELECT subject_id FROM cloud_users WHERE github_id=?",String.class,identity.path("id").asText());
                return db.update("UPDATE cloud_logins SET status='authenticated',subject_id=? WHERE challenge_id=? AND status='exchanging' AND expires_at>?",subject,id,System.currentTimeMillis()) == 1;
            });
        } catch (RuntimeException failure) { db.update("UPDATE cloud_logins SET status='denied' WHERE challenge_id=?",id); return false; }
    }
    public ObjectNode poll(JsonNode body) {
        return tx.execute(status -> {
            var rows = db.queryForList("SELECT * FROM cloud_logins WHERE challenge_id=? FOR UPDATE",body.path("challengeId").asText());
            if (rows.isEmpty()) return object().put("state","expired");
            var row = rows.get(0);
            String verifier = body.path("codeVerifier").asText("");
            if (!verifier.matches("[A-Za-z0-9_-]{43,128}") || !challenge(verifier).equals(row.get("proof"))) throw error(403,"INVALID_PROOF","授权证明不匹配");
            if (((Number)row.get("expires_at")).longValue() < System.currentTimeMillis()) return object().put("state","expired");
            String state = (String)row.get("status");
            if (!state.equals("authenticated")) return object().put("state",state.equals("exchanging")?"pending":state);
            ObjectNode session = issue((String)row.get("subject_id"),null);
            db.update("UPDATE cloud_logins SET status='consumed',verifier='' WHERE challenge_id=?",row.get("challenge_id"));
            return session.put("state","authenticated").put("supportsInstantPortrait", true);
        });
    }
    private ObjectNode issue(String subject, String device) {
        String access = secret(), refresh = secret(); long now = System.currentTimeMillis();
        db.update("INSERT INTO cloud_sessions VALUES(?,?,?,?,?,?,FALSE)",hash(access),hash(refresh),subject,device,now+3_600_000,now+30L*86400000);
        return object().put("accessToken",access).put("refreshToken",refresh).put("expiresAt",now+3_600_000).put("subjectId",subject)
                .put("accountId",db.queryForObject("SELECT github_id FROM cloud_users WHERE subject_id=?",String.class,subject));
    }
    public ObjectNode refresh(JsonNode body) {
        String token = body.path("refreshToken").asText("");
        if (!token.matches("[A-Za-z0-9_-]{43}")) throw error(401,"SESSION_EXPIRED","需要重新登录");
        return tx.execute(status -> {
            var rows = db.queryForList("SELECT * FROM cloud_sessions WHERE refresh_hash=? AND revoked=FALSE AND refresh_expires_at>? FOR UPDATE",hash(token),System.currentTimeMillis());
            if (rows.isEmpty()) throw error(401,"SESSION_EXPIRED","需要重新登录");
            var row = rows.get(0); db.update("UPDATE cloud_sessions SET revoked=TRUE WHERE access_hash=?",row.get("access_hash"));
            return issue((String)row.get("subject_id"),(String)row.get("device_id"));
        });
    }
    Map<String,Object> session(String authorization) {
        if (authorization == null || !authorization.matches("Bearer [A-Za-z0-9_-]{43}")) throw error(401,"SESSION_REQUIRED","需要应用会话");
        var rows = db.queryForList("SELECT * FROM cloud_sessions WHERE access_hash=? AND revoked=FALSE AND access_expires_at>?",hash(authorization.substring(7)),System.currentTimeMillis());
        if (rows.isEmpty()) throw error(401,"SESSION_EXPIRED","需要重新登录"); return rows.get(0);
    }
    public void logout(String authorization) {
        if (authorization==null||!authorization.matches("Bearer [A-Za-z0-9_-]{43}")) throw error(401,"SESSION_REQUIRED","需要应用会话");
        // The expired access credential can still revoke its associated refresh credential.
        db.update("UPDATE cloud_sessions SET revoked=TRUE WHERE access_hash=?",hash(authorization.substring(7)));
    }
    private static String encode(String value) { return URLEncoder.encode(value,StandardCharsets.UTF_8); }
}
