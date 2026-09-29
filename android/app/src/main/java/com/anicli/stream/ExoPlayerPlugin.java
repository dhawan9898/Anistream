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

        getActivity().startActivity(intent);

        JSObject ret = new JSObject();
        ret.put("success", true);
        call.resolve(ret);
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
