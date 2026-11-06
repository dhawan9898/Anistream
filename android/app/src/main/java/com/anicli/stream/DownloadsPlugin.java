package com.anicli.stream;

import android.net.Uri;
import androidx.annotation.NonNull;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.offline.Download;
import androidx.media3.exoplayer.offline.DownloadHelper;
import androidx.media3.exoplayer.offline.DownloadRequest;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * JS bridge for offline downloads (see MediaDownloads). The web layer keeps
 * the episode metadata; this side owns the media files and reports progress
 * through "downloadChanged" events.
 */
@UnstableApi
@CapacitorPlugin(name = "DownloadsPlugin")
public class DownloadsPlugin extends Plugin {

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private MediaDownloads downloads;
    private final MediaDownloads.Listener listener = (id, state, percent, bytes) -> {
        JSObject e = new JSObject();
        e.put("id", id);
        e.put("state", state);
        e.put("percent", Math.round(percent * 10f) / 10f);
        e.put("bytes", bytes);
        notifyListeners("downloadChanged", e);
    };

    @Override
    public void load() {
        downloads = MediaDownloads.get(getContext());
        downloads.addListener(listener);
    }

    @Override
    protected void handleOnDestroy() {
        if (downloads != null) downloads.removeListener(listener);
        io.shutdownNow();
    }

    /**
     * start({ id, url, referer, maxHeight, subtitles: [{ src, label, default }] })
     * Resolves { subtitles } with the caption files saved next to the video
     * (file:// URIs usable offline) once the download has been queued.
     */
    @PluginMethod
    public void start(PluginCall call) {
        final String id = call.getString("id");
        final String url = call.getString("url");
        if (id == null || id.isEmpty() || url == null || url.isEmpty()) {
            call.reject("id and url are required");
            return;
        }
        final String referer = call.getString("referer");
        final int maxHeight = call.getInt("maxHeight", 720);
        final JSArray subs = call.getArray("subtitles");

        io.execute(() -> {
            final JSArray saved = saveSubtitles(id, subs, referer);
            // DownloadHelper wants a thread with a Looper; the main one will do.
            getActivity().runOnUiThread(() -> prepareAndQueue(call, id, url, referer, maxHeight, saved));
        });
    }

    private void prepareAndQueue(PluginCall call, String id, String url, String referer, int maxHeight, JSArray savedSubs) {
        try {
            MediaDownloads dl = MediaDownloads.get(getContext());
            dl.applyHeaders(referer);
            MediaItem.Builder item = new MediaItem.Builder().setUri(Uri.parse(url));
            if (!url.toLowerCase(java.util.Locale.US).contains(".mp4")) item.setMimeType(MimeTypes.APPLICATION_M3U8);
            // Highest rendition up to the chosen height (the helper prefers
            // the best bitrate within the limit).
            androidx.media3.exoplayer.trackselection.DefaultTrackSelector.Parameters params =
                    DownloadHelper.getDefaultTrackSelectorParameters(getContext())
                            .buildUpon()
                            .setMaxVideoSize(Integer.MAX_VALUE, Math.max(144, maxHeight))
                            .build();
            DownloadHelper helper = DownloadHelper.forMediaItem(
                    item.build(), params, new DefaultRenderersFactory(getContext()), dl.applyHeaders(referer));
            helper.prepare(new DownloadHelper.Callback() {
                @Override
                public void onPrepared(@NonNull DownloadHelper h) {
                    DownloadRequest request = h.getDownloadRequest(id, null);
                    h.release();
                    dl.manager().addDownload(request);
                    JSObject ret = new JSObject();
                    ret.put("subtitles", savedSubs);
                    call.resolve(ret);
                }

                @Override
                public void onPrepareError(@NonNull DownloadHelper h, @NonNull IOException e) {
                    h.release();
                    deleteSubtitles(id);
                    call.reject("Couldn't prepare the download: " + e.getMessage());
                }
            });
        } catch (RuntimeException e) {
            deleteSubtitles(id);
            call.reject("Couldn't start the download: " + e.getMessage());
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String id = call.getString("id");
        if (id == null) {
            call.reject("id is required");
            return;
        }
        MediaDownloads.get(getContext()).manager().removeDownload(id);
        deleteSubtitles(id);
        call.resolve();
    }

    /** list() -> { downloads: [{ id, state, percent, bytes }] } */
    @PluginMethod
    public void list(PluginCall call) {
        io.execute(() -> {
            JSArray out = new JSArray();
            for (Download d : MediaDownloads.get(getContext()).all()) {
                JSObject o = new JSObject();
                o.put("id", d.request.id);
                o.put("state", MediaDownloads.stateName(d.state));
                o.put("percent", d.state == Download.STATE_COMPLETED ? 100 : Math.max(0f, d.getPercentDownloaded()));
                o.put("bytes", d.getBytesDownloaded());
                out.put(o);
            }
            JSObject ret = new JSObject();
            ret.put("downloads", out);
            call.resolve(ret);
        });
    }

    /** Pauses or resumes every download. */
    @PluginMethod
    public void setPaused(PluginCall call) {
        boolean paused = call.getBoolean("paused", false);
        if (paused) MediaDownloads.get(getContext()).manager().pauseDownloads();
        else MediaDownloads.get(getContext()).manager().resumeDownloads();
        call.resolve();
    }

    // ---- captions -----------------------------------------------------------

    // Caption files are separate from the HLS stream, so they are saved too
    // (best effort: a failed caption never blocks the video download).
    private JSArray saveSubtitles(String id, JSArray subs, String referer) {
        JSArray saved = new JSArray();
        if (subs == null) return saved;
        File dir = MediaDownloads.get(getContext()).subtitleDir();
        String base = MediaDownloads.safeName(id);
        for (int i = 0; i < subs.length(); i++) {
            try {
                JSONObject s = subs.getJSONObject(i);
                String src = s.optString("src", "");
                if (!src.startsWith("http")) continue;
                File out = new File(dir, base + "_" + i + ".vtt");
                HttpURLConnection c = (HttpURLConnection) new URL(src).openConnection();
                c.setConnectTimeout(10_000);
                c.setReadTimeout(15_000);
                if (referer != null) c.setRequestProperty("Referer", referer);
                c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36");
                try (InputStream in = c.getInputStream(); FileOutputStream fos = new FileOutputStream(out)) {
                    byte[] buf = new byte[8192];
                    int n;
                    long total = 0;
                    while ((n = in.read(buf)) > 0 && total < 2_000_000) {
                        fos.write(buf, 0, n);
                        total += n;
                    }
                } finally {
                    c.disconnect();
                }
                JSObject o = new JSObject();
                o.put("src", Uri.fromFile(out).toString());
                o.put("label", s.optString("label", "Subtitles"));
                o.put("default", s.optBoolean("default", false));
                saved.put(o);
            } catch (JSONException | IOException | RuntimeException e) {
                android.util.Log.w("DownloadsPlugin", "caption " + i + " not saved", e);
            }
        }
        return saved;
    }

    private void deleteSubtitles(String id) {
        File dir = MediaDownloads.get(getContext()).subtitleDir();
        final String prefix = MediaDownloads.safeName(id) + "_";
        File[] files = dir.listFiles((d, name) -> name.startsWith(prefix));
        if (files != null) for (File f : files) //noinspection ResultOfMethodCallIgnored
            f.delete();
    }
}
