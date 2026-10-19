package com.happygit.app.nativebridge;

import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

public class GitHubWebViewHost {

    private final Context context;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private WebView workWebView;

    public GitHubWebViewHost(Context context) {
        this.context = context.getApplicationContext();
    }

    public synchronized WebView getOrCreateWorkWebView() {
        if (workWebView != null) return workWebView;

        if (Looper.myLooper() == Looper.getMainLooper()) {
            initWebView();
        } else {
            CountDownLatch latch = new CountDownLatch(1);
            mainHandler.post(() -> {
                initWebView();
                latch.countDown();
            });
            try {
                latch.await(5, TimeUnit.SECONDS);
            } catch (InterruptedException ignored) {}
        }
        return workWebView;
    }

    private void initWebView() {
        if (workWebView != null) return;
        workWebView = new WebView(context);
        WebSettings s = workWebView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            cm.setAcceptThirdPartyCookies(workWebView, true);
        }
    }

    public void clearSession(Runnable onDone) {
        mainHandler.post(() -> {
            if (workWebView != null) {
                workWebView.stopLoading();
                workWebView.loadUrl("about:blank");
            }
            CookieManager cm = CookieManager.getInstance();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                cm.removeAllCookies(val -> {
                    cm.flush();
                    if (onDone != null) onDone.run();
                });
            } else {
                cm.removeAllCookie();
                if (onDone != null) onDone.run();
            }
        });
    }

    public void destroy() {
        mainHandler.post(() -> {
            if (workWebView != null) {
                workWebView.stopLoading();
                workWebView.destroy();
                workWebView = null;
            }
        });
    }
}
