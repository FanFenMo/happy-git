package com.happygit.app;

import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.happygit.app.nativebridge.SessionManager;
import org.json.JSONObject;

/**
 * GitHubLoginActivity
 * 独立原生登录 Activity，包含原生地址提示与普通 WebView
 * (依据 project.md 第五节)
 */
public class GitHubLoginActivity extends Activity {

    public static final String EXTRA_ACCOUNT_ID = "accountId";
    public static final String EXTRA_LOGIN = "login";

    private WebView webView;
    private boolean isFinished = false;
    private String loginTaskId = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        loginTaskId = getIntent().getStringExtra("loginTaskId");

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#10151D"));

        // 原生顶部导航栏
        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setOrientation(LinearLayout.HORIZONTAL);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(24, 16, 24, 16);
        toolbar.setBackgroundColor(Color.parseColor("#19222D"));

        TextView closeBtn = new TextView(this);
        closeBtn.setText("✕");
        closeBtn.setTextSize(18);
        closeBtn.setTextColor(Color.parseColor("#F1F5FA"));
        closeBtn.setPadding(16, 8, 24, 8);
        closeBtn.setOnClickListener(v -> finish());
        toolbar.addView(closeBtn);

        TextView titleView = new TextView(this);
        titleView.setText("GitHub 登录 (github.com)");
        titleView.setTextSize(16);
        titleView.setTextColor(Color.parseColor("#F1F5FA"));
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1.0f);
        toolbar.addView(titleView, titleParams);

        TextView refreshBtn = new TextView(this);
        refreshBtn.setText("⟳");
        refreshBtn.setTextSize(20);
        refreshBtn.setTextColor(Color.parseColor("#F1F5FA"));
        refreshBtn.setPadding(24, 8, 16, 8);
        refreshBtn.setOnClickListener(v -> {
            if (webView != null) webView.reload();
        });
        toolbar.addView(refreshBtn);

        root.addView(toolbar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // WebView 配置
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            cookieManager.setAcceptThirdPartyCookies(webView, true);
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                checkIdentity();
            }
        });

        root.addView(webView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        webView.loadURL("https://github.com/login");
    }

    private void checkIdentity() {
        if (isFinished || webView == null) return;

        String probeScript = "(function() {\n" +
                "  var metaActorId = document.querySelector('meta[name=\"octolytics-actor-id\"]')?.getAttribute('content');\n" +
                "  var metaActorLogin = document.querySelector('meta[name=\"octolytics-actor-login\"]')?.getAttribute('content');\n" +
                "  var metaUserLogin = document.querySelector('meta[name=\"user-login\"]')?.getAttribute('content');\n" +
                "  var login = (metaActorLogin || metaUserLogin || '').trim();\n" +
                "  var accountId = (metaActorId && metaActorId !== '0') ? metaActorId.trim() : null;\n" +
                "  if (login && login !== 'undefined' && login !== 'null') {\n" +
                "    return JSON.stringify({ kind: 'authenticated', accountId: accountId, login: login });\n" +
                "  }\n" +
                "  var headerUser = document.querySelector('[data-login]')?.getAttribute('data-login')\n" +
                "    || document.querySelector('img.avatar-user')?.getAttribute('alt')?.replace(/^@/, '');\n" +
                "  if (headerUser && headerUser !== 'undefined' && headerUser !== 'null') {\n" +
                "    return JSON.stringify({ kind: 'authenticated', accountId: accountId, login: headerUser.trim() });\n" +
                "  }\n" +
                "  if (document.querySelector('input[name=\"otp\"]') || location.pathname.includes('/two-factor')) {\n" +
                "    return JSON.stringify({ kind: 'verification' });\n" +
                "  }\n" +
                "  return JSON.stringify({ kind: 'unknown' });\n" +
                "})();";

        webView.evaluateJavascript(probeScript, value -> {
            if (isFinished || value == null || value.equals("null")) return;
            try {
                String cleanJson = value;
                if (cleanJson.startsWith("\"") && cleanJson.endsWith("\"")) {
                    cleanJson = cleanJson.substring(1, cleanJson.length() - 1)
                            .replace("\\\"", "\"").replace("\\\\", "\\");
                }
                JSONObject obj = new JSONObject(cleanJson);
                String kind = obj.optString("kind");
                if ("authenticated".equals(kind)) {
                    isFinished = true;
                    String login = obj.optString("login");
                    String accountId = obj.optString("accountId", null);

                    SessionManager sm = SessionManager.getInstance();
                    if (sm != null && loginTaskId != null) {
                        sm.onIdentityDetected(loginTaskId, login, accountId);
                    }
                    finish();
                }
            } catch (Exception ignored) {}
        });
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        if (!isFinished) {
            SessionManager sm = SessionManager.getInstance();
            if (sm != null && loginTaskId != null) {
                sm.onLoginClosed(loginTaskId);
            }
        }
        super.onDestroy();
    }
}
