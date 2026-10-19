package com.happygit.app.nativebridge;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

public class PageExecutor {

    private final Context context;
    private final GitHubWebViewHost webViewHost;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private JSONObject scriptTemplates;

    public PageExecutor(Context context, GitHubWebViewHost webViewHost) {
        this.context = context.getApplicationContext();
        this.webViewHost = webViewHost;
        loadScriptTemplates();
    }

    private synchronized void loadScriptTemplates() {
        if (scriptTemplates != null) return;
        try (InputStream is = context.getAssets().open("happygit/page-scripts.json");
             BufferedReader reader = new BufferedReader(new InputStreamReader(is))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) sb.append(line);
            JSONObject json = new JSONObject(sb.toString());
            scriptTemplates = json.optJSONObject("scripts");
        } catch (Exception e) {
            scriptTemplates = new JSONObject();
        }
    }

    public void navigate(String url, long timeoutMs) throws Exception {
        WebView webView = webViewHost.getOrCreateWorkWebView();
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<Exception> errorRef = new AtomicReference<>();
        AtomicBoolean isCompleted = new AtomicBoolean(false);

        mainHandler.post(() -> {
            webView.setWebViewClient(new WebViewClient() {
                @Override
                public void onPageFinished(WebView view, String finishedUrl) {
                    if (isCompleted.compareAndSet(false, true)) {
                        latch.countDown();
                    }
                }

                @Override
                public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                    if (request.isForMainFrame() && isCompleted.compareAndSet(false, true)) {
                        errorRef.set(new Exception("NETWORK_UNAVAILABLE: 页面加载失败"));
                        latch.countDown();
                    }
                }
            });
            webView.loadUrl(url);
        });

        boolean finished = latch.await(timeoutMs, TimeUnit.MILLISECONDS);
        if (!finished) {
            mainHandler.post(webView::stopLoading);
            throw new Exception("PAGE_TIMEOUT: 页面导航超时");
        }
        if (errorRef.get() != null) {
            throw errorRef.get();
        }
    }

    public void reload(long timeoutMs) throws Exception {
        WebView webView = webViewHost.getOrCreateWorkWebView();
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<Exception> errorRef = new AtomicReference<>();
        AtomicBoolean isCompleted = new AtomicBoolean(false);

        mainHandler.post(() -> {
            webView.setWebViewClient(new WebViewClient() {
                @Override
                public void onPageFinished(WebView view, String finishedUrl) {
                    if (isCompleted.compareAndSet(false, true)) {
                        latch.countDown();
                    }
                }

                @Override
                public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                    if (request.isForMainFrame() && isCompleted.compareAndSet(false, true)) {
                        errorRef.set(new Exception("NETWORK_UNAVAILABLE: 页面刷新失败"));
                        latch.countDown();
                    }
                }
            });
            webView.reload();
        });

        boolean finished = latch.await(timeoutMs, TimeUnit.MILLISECONDS);
        if (!finished) {
            mainHandler.post(webView::stopLoading);
            throw new Exception("PAGE_TIMEOUT: 页面刷新超时");
        }
        if (errorRef.get() != null) {
            throw errorRef.get();
        }
    }

    public JSONObject executeScript(String scriptId, JSONObject args) throws Exception {
        loadScriptTemplates();
        String template = scriptTemplates != null ? scriptTemplates.optString(scriptId, "") : "";
        if (template.isEmpty()) {
            throw new IllegalArgumentException("UNKNOWN_PAGE_SCRIPT: " + scriptId);
        }

        String argsStr = (args != null) ? args.toString() : "{}";
        String script = template.replace("%ARGS%", argsStr);

        WebView webView = webViewHost.getOrCreateWorkWebView();
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> resultRef = new AtomicReference<>();

        mainHandler.post(() -> webView.evaluateJavascript(script, value -> {
            resultRef.set(value);
            latch.countDown();
        }));

        latch.await(10, TimeUnit.SECONDS);
        String raw = resultRef.get();
        if (raw == null || raw.equals("null")) return new JSONObject();

        // 规范化 Android evaluateJavascript 返回的转义 JSON 字符串
        String cleanJson = raw;
        if (cleanJson.startsWith("\"") && cleanJson.endsWith("\"")) {
            cleanJson = cleanJson.substring(1, cleanJson.length() - 1)
                    .replace("\\\"", "\"").replace("\\\\", "\\");
        }

        try {
            return new JSONObject(cleanJson);
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    public JSONObject waitForStructure(String expectedPageKind, long timeoutMs) throws Exception {
        long start = System.currentTimeMillis();
        while (System.currentTimeMillis() - start < timeoutMs) {
            JSONObject info = executeScript("detectPage", null);
            if ("rate_limit".equals(info.optString("pageKind"))) {
                throw new Exception("RATE_LIMITED");
            }
            if (info.optBoolean("hasStructure")) {
                if (expectedPageKind == null || expectedPageKind.equals(info.optString("pageKind"))) {
                    return info;
                }
            }
            Thread.sleep(250);
        }
        return executeScript("detectPage", null);
    }
}
