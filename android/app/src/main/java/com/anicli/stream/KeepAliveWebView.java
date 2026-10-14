package com.anicli.stream;

import android.content.Context;
import android.util.AttributeSet;
import android.view.View;
import com.getcapacitor.CapacitorWebView;

/**
 * The app's WebView, kept "visible" for Chromium while the native player
 * covers it.
 *
 * The player is a separate activity, so the activity holding this WebView is
 * stopped for the whole episode and Android reports its window as GONE.
 * Chromium then treats the page as hidden: timers are throttled to about one
 * a second and, after five minutes, to about one a *minute*. The player
 * depends on the page's JavaScript while it is open (resolving the next
 * episode, switching audio, saving watch history), and under that throttling
 * those requests crawled - the player sat on its loading spinner until the
 * episode was closed and reopened. Ignoring the GONE notification keeps the
 * page live; nothing is drawn for a stopped window, so it costs no frames.
 */
public class KeepAliveWebView extends CapacitorWebView {
    public KeepAliveWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
        if (visibility != View.GONE) {
            super.onWindowVisibilityChanged(View.VISIBLE);
        }
    }
}
