package com.happygit.app;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.lifecycle.Lifecycle;
import com.getcapacitor.BridgeActivity;
import com.happygit.app.nativebridge.HappyGitPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HappyGitPlugin.class);
        super.onCreate(savedInstanceState);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            private boolean awaitingWebResponse;

            @Override
            public void handleOnBackPressed() {
                if (awaitingWebResponse) return;
                WebView webView = getBridge() == null ? null : getBridge().getWebView();
                if (webView == null) {
                    forwardToSystem(this);
                    return;
                }

                awaitingWebResponse = true;
                webView.evaluateJavascript(
                    "(() => { const event = new CustomEvent('happygit:native-back', { cancelable: true }); " +
                    "window.dispatchEvent(event); return event.defaultPrevented; })()",
                    handled -> {
                        awaitingWebResponse = false;
                        if (isFinishing() || isDestroyed() ||
                                !getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.STARTED)) return;
                        if (!"true".equals(handled)) forwardToSystem(this);
                    }
                );
            }
        });
    }

    private void forwardToSystem(OnBackPressedCallback callback) {
        callback.setEnabled(false);
        getOnBackPressedDispatcher().onBackPressed();
        if (!isFinishing() && !isDestroyed()) callback.setEnabled(true);
    }
}
