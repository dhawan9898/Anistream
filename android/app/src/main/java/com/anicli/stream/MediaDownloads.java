package com.anicli.stream;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import androidx.annotation.Nullable;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.database.DatabaseProvider;
import androidx.media3.database.StandaloneDatabaseProvider;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.cache.Cache;
import androidx.media3.datasource.cache.CacheDataSource;
import androidx.media3.datasource.cache.NoOpCacheEvictor;
import androidx.media3.datasource.cache.SimpleCache;
import androidx.media3.exoplayer.offline.Download;
import androidx.media3.exoplayer.offline.DownloadCursor;
import androidx.media3.exoplayer.offline.DownloadManager;
import java.io.File;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Executors;

/**
 * Process-wide offline store for downloaded episodes: one Media3 cache
 * (app-private files, never evicted - the user deletes downloads explicitly)
 * and the DownloadManager that fills it.
 *
 * Downloads run while the app process is alive and are resumed from the
 * download database the next time it starts. The same cache serves offline
 * playback (see {@link #cacheDataSourceFactory}).
 */
@UnstableApi
final class MediaDownloads {

    interface Listener {
        /** A download changed state or made progress. Always called on the main thread. */
        void onChanged(String id, String state, float percent, long bytes);
    }

    private static final long PROGRESS_INTERVAL_MS = 1000;
    private static MediaDownloads instance;

    static synchronized MediaDownloads get(Context context) {
        if (instance == null) instance = new MediaDownloads(context.getApplicationContext());
        return instance;
    }

    private final Context context;
    private final Cache cache;
    private final DownloadManager manager;
    private final DefaultHttpDataSource.Factory upstream;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final java.util.List<Listener> listeners = new java.util.concurrent.CopyOnWriteArrayList<>();

    private final Runnable progressTicker = new Runnable() {
        @Override
        public void run() {
            java.util.List<Download> current = manager.getCurrentDownloads();
            boolean active = false;
            for (Download d : current) {
                if (d.state == Download.STATE_DOWNLOADING) {
                    active = true;
                    emit(d);
                }
            }
            if (active) main.postDelayed(this, PROGRESS_INTERVAL_MS);
        }
    };

    private MediaDownloads(Context context) {
        this.context = context;
        DatabaseProvider db = new StandaloneDatabaseProvider(context);
        File dir = new File(context.getFilesDir(), "downloads");
        cache = new SimpleCache(dir, new NoOpCacheEvictor(), db);
        upstream = new DefaultHttpDataSource.Factory()
                .setAllowCrossProtocolRedirects(true)
                .setConnectTimeoutMs(15_000)
                .setReadTimeoutMs(20_000);
        applyHeaders(null);
        manager = new DownloadManager(context, db, cache, upstream, Executors.newFixedThreadPool(3));
        manager.setMaxParallelDownloads(2);
        manager.addListener(new DownloadManager.Listener() {
            @Override
            public void onDownloadChanged(DownloadManager m, Download download, @Nullable Exception finalException) {
                emit(download);
                main.removeCallbacks(progressTicker);
                main.postDelayed(progressTicker, PROGRESS_INTERVAL_MS);
            }

            @Override
            public void onDownloadRemoved(DownloadManager m, Download download) {
                for (Listener l : listeners) l.onChanged(download.request.id, "removed", 0f, 0L);
            }
        });
        // A DownloadManager starts paused; this also resumes whatever was
        // queued or half-finished when the app was last closed.
        manager.resumeDownloads();
    }

    DownloadManager manager() { return manager; }

    void addListener(Listener l) { listeners.add(l); }
    void removeListener(Listener l) { listeners.remove(l); }

    /** Request headers (Referer/Origin/UA) the stream's CDN insists on. */
    DefaultHttpDataSource.Factory applyHeaders(@Nullable String referer) {
        Map<String, String> headers = new HashMap<>();
        String ref = referer != null && !referer.isEmpty() ? referer : "https://zokoanime.video/";
        headers.put("Referer", ref);
        try {
            android.net.Uri u = android.net.Uri.parse(ref);
            if (u.getScheme() != null && u.getHost() != null) {
                headers.put("Origin", u.getScheme() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : ""));
            }
        } catch (Exception ignored) {
        }
        headers.put("Accept", "*/*");
        headers.put("Accept-Language", "en-US,en;q=0.9");
        headers.put("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36");
        upstream.setDefaultRequestProperties(headers);
        return upstream;
    }

    /** Reads downloaded media from the cache first and falls back to the network. */
    DataSource.Factory cacheDataSourceFactory(DataSource.Factory network) {
        return new CacheDataSource.Factory()
                .setCache(cache)
                .setUpstreamDataSourceFactory(network)
                .setCacheWriteDataSinkFactory(null) // playback never adds to the offline store
                .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR);
    }

    /** Every download the manager knows about. */
    java.util.List<Download> all() {
        java.util.List<Download> out = new java.util.ArrayList<>();
        try (DownloadCursor cursor = manager.getDownloadIndex().getDownloads()) {
            while (cursor.moveToNext()) out.add(cursor.getDownload());
        } catch (IOException e) {
            android.util.Log.w("MediaDownloads", "reading the download index failed", e);
        }
        return out;
    }

    File subtitleDir() {
        File dir = new File(context.getFilesDir(), "download_subs");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return dir;
    }

    static String safeName(String id) {
        return id.replaceAll("[^A-Za-z0-9._-]", "_");
    }

    static String stateName(int state) {
        switch (state) {
            case Download.STATE_QUEUED: return "queued";
            case Download.STATE_DOWNLOADING: return "downloading";
            case Download.STATE_COMPLETED: return "completed";
            case Download.STATE_FAILED: return "failed";
            case Download.STATE_STOPPED: return "stopped";
            case Download.STATE_REMOVING: return "removing";
            case Download.STATE_RESTARTING: return "downloading";
            default: return "queued";
        }
    }

    private void emit(Download d) {
        float percent = d.state == Download.STATE_COMPLETED ? 100f : Math.max(0f, d.getPercentDownloaded());
        String state = stateName(d.state);
        for (Listener l : listeners) l.onChanged(d.request.id, state, percent, d.getBytesDownloaded());
    }
}
