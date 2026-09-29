package com.anicli.stream;

import android.content.Intent;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ExoPlayerPlugin")
public class ExoPlayerPlugin extends Plugin {

    // Set on every play() call so the (separate) ExoPlayerActivity can notify
    // JS listeners of in-player actions - e.g. the sub/dub toggle, which
    // requires re-resolving the stream through the JS scraper and can't be
    // done natively.
    private static ExoPlayerPlugin activeInstance;

    @PluginMethod
    public void play(PluginCall call) {
        String url = call.getString("url");
        String title = call.getString("title", "AniStream");
        String episode = call.getString("episode", "1");
        String referer = call.getString("referer", "https://zokoanime.video/");
        String mode = call.getString("mode", "sub");
        JSArray subtitles = call.getArray("subtitles");
        JSArray qualities = call.getArray("qualities");
        JSArray episodes = call.getArray("episodes");
        boolean isFallback = call.getBoolean("isFallback", false);
        JSObject intro = call.getObject("intro");
        JSObject outro = call.getObject("outro");
        Double startPositionMs = call.getDouble("startPositionMs");

        if (url == null || url.isEmpty()) {
            call.reject("Must provide a video URL");
            return;
        }

        activeInstance = this;

        Intent intent = new Intent(getContext(), ExoPlayerActivity.class);
        intent.putExtra("url", url);
        intent.putExtra("title", title);
        intent.putExtra("episode", episode);
        intent.putExtra("referer", referer);
        intent.putExtra("mode", mode);
        intent.putExtra("subtitles", subtitles != null ? subtitles.toString() : null);
        intent.putExtra("qualities", qualities != null ? qualities.toString() : null);
        intent.putExtra("episodes", episodes != null ? episodes.toString() : null);
        intent.putExtra("isFallback", isFallback);
        putSkipRange(intent, "intro", intro);
        putSkipRange(intent, "outro", outro);
        if (startPositionMs != null && startPositionMs > 0) {
            intent.putExtra("startPositionMs", Math.round(startPositionMs));
        }

        // ExoPlayerActivity is singleTask: if it's already open (showing its
        // loading spinner) this is delivered to it via onNewIntent instead
        // of stacking a second player.
        getActivity().startActivity(intent);

        JSObject ret = new JSObject();
        ret.put("success", true);
        call.resolve(ret);
    }

    // Chapter markers from the stream's sources payload, in seconds - passed
    // on as <prefix>StartMs / <prefix>EndMs extras. Missing or empty (0/0)
    // markers are simply omitted.
    private static void putSkipRange(Intent intent, String prefix, JSObject range) {
        if (range == null) return;
        double start = range.optDouble("start", -1);
        double end = range.optDouble("end", -1);
        if (start < 0 || end <= start) return;
        intent.putExtra(prefix + "StartMs", Math.round(start * 1000));
        intent.putExtra(prefix + "EndMs", Math.round(end * 1000));
    }

    // Opens the player straight away in its loading state (title + spinner,
    // no URL yet) so there's no blocking "resolving" screen in the app; the
    // stream arrives later through play().
    @PluginMethod
    public void open(PluginCall call) {
        activeInstance = this;
        Intent intent = new Intent(getContext(), ExoPlayerActivity.class);
        intent.putExtra("title", call.getString("title", "AniStream"));
        intent.putExtra("episode", call.getString("episode", "1"));
        intent.putExtra("mode", call.getString("mode", "sub"));
        getActivity().startActivity(intent);
        call.resolve();
    }

    // Stream resolution failed - show it inside the open player.
    @PluginMethod
    public void fail(PluginCall call) {
        String message = call.getString("message", "Couldn't load this episode.");
        ExoPlayerActivity activity = ExoPlayerActivity.current();
        if (activity == null) {
            call.reject("Player is not open");
            return;
        }
        activity.runOnUiThread(() -> activity.showLoadFailure(message));
        call.resolve();
    }

    static void notifyPlayerClosed() {
        if (activeInstance == null) return;
        activeInstance.notifyListeners("playerClosed", new JSObject());
    }

    static void notifyModeSwitchRequested(String title, String episode, String newMode) {
        if (activeInstance == null) return;
        JSObject data = new JSObject();
        data.put("title", title);
        data.put("episode", episode);
        data.put("mode", newMode);
        activeInstance.notifyListeners("modeSwitchRequested", data);
    }

    static void notifyNextEpisodeRequested(String title, String episode) {
        if (activeInstance == null) return;
        JSObject data = new JSObject();
        data.put("title", title);
        data.put("episode", episode);
        activeInstance.notifyListeners("nextEpisodeRequested", data);
    }

    static void notifyEpisodeSelected(String title, String episode, String selectedNumber) {
        if (activeInstance == null) return;
        JSObject data = new JSObject();
        data.put("title", title);
        data.put("episode", episode);
        data.put("selectedNumber", selectedNumber);
        activeInstance.notifyListeners("episodeSelected", data);
    }

    // The native player is the only place playback position actually lives -
    // JS (and its watch-history storage) only finds out by being told,
    // periodically, the same way the other in-player actions are reported.
    static void notifyProgressUpdate(String title, String episode, String mode, long positionMs, long durationMs) {
        if (activeInstance == null) return;
        JSObject data = new JSObject();
        data.put("title", title);
        data.put("episode", episode);
        data.put("mode", mode);
        data.put("positionMs", positionMs);
        data.put("durationMs", durationMs);
        activeInstance.notifyListeners("progressUpdate", data);
    }
}
