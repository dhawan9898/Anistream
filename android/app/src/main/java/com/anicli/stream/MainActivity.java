package com.anicli.stream;

import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ExoPlayerPlugin.class);
        super.onCreate(savedInstanceState);

        // Keep the WebView's renderer at full priority (and, through
        // KeepAliveWebView, its page "visible"): the native player sits on
        // top of it for a whole episode and still relies on the app's
        // JavaScript (next episode, audio switch, watch history).
        WebView appWebView = getBridge() != null ? getBridge().getWebView() : null;
        if (appWebView != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            appWebView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }

        // Android back (button or gesture). Screens are in-memory state, not
        // URLs, so the app itself decides what "back" means: the web layer
        // exposes window.__anistreamBack(), which closes the top-most thing
        // (title page, genre page, search/settings/library -> Home) and
        // returns true. Only when it reports nothing left to close - i.e. on
        // Home - is the app sent to the background (like the Home button)
        // instead of being closed and losing its state.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                final WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                if (webView == null) {
                    moveTaskToBack(true);
                    return;
                }
                webView.evaluateJavascript(
                        "(function(){try{return window.__anistreamBack?window.__anistreamBack():false}catch(e){return false}})()",
                        value -> {
                            if (!"true".equals(value)) moveTaskToBack(true);
                        });
            }
        });
    }
}
