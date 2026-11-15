package com.happygit.app;

import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.happygit.app.nativebridge.SessionManager;
import org.json.JSONObject;

/**
 * GitHubLoginActivity
 * 独立原生登录 Activity，包含原生地址提示与普通 WebView
 * (依据 project.md 第五节)
 */
public class GitHubLoginActivity extends AppCompatActivity {

    public static final String EXTRA_ACCOUNT_ID = "accountId";
    public static final String EXTRA_LOGIN = "login";

    private WebView webView;
    private LinearLayout rootLayout;
    private boolean isFinished = false;
    private String loginTaskId = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        loginTaskId = getIntent().getStringExtra("loginTaskId");

        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        WindowInsetsControllerCompat systemBars = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        systemBars.setAppearanceLightStatusBars(!dark);
        systemBars.setAppearanceLightNavigationBars(!dark);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            getWindow().setNavigationBarContrastEnforced(false);
        }

        rootLayout = new LinearLayout(this);
        rootLayout.setOrientation(LinearLayout.VERTICAL);
        rootLayout.setBackgroundColor(getColor(R.color.happygit_window_background));
        ViewCompat.setOnApplyWindowInsetsListener(rootLayout, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets keyboard = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
            return windowInsets;
        });

        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setOrientation(LinearLayout.HORIZONTAL);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(dp(8), dp(4), dp(8), dp(4));
        toolbar.setMinimumHeight(dp(64));
        toolbar.setBackgroundColor(getColor(R.color.happygit_surface));

        ImageButton closeButton = createToolbarButton(R.drawable.ic_close, "关闭 GitHub 登录");
        closeButton.setOnClickListener(view -> finish());
        toolbar.addView(closeButton, new LinearLayout.LayoutParams(dp(48), dp(48)));

        LinearLayout heading = new LinearLayout(this);
        heading.setOrientation(LinearLayout.VERTICAL);
        heading.setPadding(dp(8), 0, dp(8), 0);
        TextView titleView = new TextView(this);
        titleView.setText("GitHub 登录");
        titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        titleView.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        titleView.setTextColor(getColor(R.color.happygit_text));
        titleView.setMaxLines(1);
        titleView.setEllipsize(TextUtils.TruncateAt.END);
        heading.addView(titleView);

        TextView originView = new TextView(this);
        originView.setText("github.com");
        originView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        originView.setTextColor(getColor(R.color.happygit_text_secondary));
        originView.setMaxLines(1);
        heading.addView(originView);
        toolbar.addView(heading, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1.0f));

        ImageButton refreshButton = createToolbarButton(R.drawable.ic_refresh, "重新加载 GitHub 登录页面");
        refreshButton.setOnClickListener(view -> webView.reload());
        toolbar.addView(refreshButton, new LinearLayout.LayoutParams(dp(48), dp(48)));
        rootLayout.addView(toolbar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // WebView 配置
        webView = new WebView(this);
        webView.setBackgroundColor(getColor(R.color.happygit_window_background));
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
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

        rootLayout.addView(webView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1.0f));
        setContentView(rootLayout);
        ViewCompat.requestApplyInsets(rootLayout);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack();
                else finish();
            }
        });

        if (savedInstanceState == null) webView.loadUrl("https://github.com/login");
        else webView.restoreState(savedInstanceState);
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
            if (isFinishing() || isDestroyed() || isFinished || value == null || value.equals("null")) return;
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

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private ImageButton createToolbarButton(int iconResource, String label) {
        ImageButton button = new ImageButton(this);
        button.setImageResource(iconResource);
        button.setImageTintList(ColorStateList.valueOf(getColor(R.color.happygit_accent)));
        button.setContentDescription(label);
        button.setPadding(dp(12), dp(12), dp(12), dp(12));
        TypedValue background = new TypedValue();
        getTheme().resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, background, true);
        button.setBackgroundResource(background.resourceId);
        return button;
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onDestroy() {
        ViewCompat.setOnApplyWindowInsetsListener(rootLayout, null);
        if (webView != null) {
            webView.stopLoading();
            rootLayout.removeView(webView);
            webView.destroy();
            webView = null;
        }
        if (!isFinished && !isChangingConfigurations()) {
            SessionManager sm = SessionManager.getInstance();
            if (sm != null && loginTaskId != null) {
                sm.onLoginClosed(loginTaskId);
            }
        }
        super.onDestroy();
    }
}
