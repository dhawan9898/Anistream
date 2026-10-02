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

        // The native player covers this WebView for a whole episode, yet the
        // player still relies on the app's JavaScript (audio switch, reload,
        // watch history). Keep the WebView's renderer at full priority while
        // hidden instead of letting it be deprioritized in the background.
        WebView appWebView = getBridge() != null ? getBridge().getWebView() : null;
        if (appWebView != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            appWebView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }

        // Android back (button or gesture). The app's screens (title page,
        // genre page, other tabs, web player) push browser history entries
        // (see App.tsx), so back steps through them like the on-screen back
        // arrows do. With nothing left to go back to, the app is sent to the
        // background (like Home) instead of being closed and losing its state.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                } else {
                    moveTaskToBack(true);
                }
            }
        });
    }
}
