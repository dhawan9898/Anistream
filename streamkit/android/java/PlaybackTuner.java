package __APP_PACKAGE__;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.media3.common.Format;
import androidx.media3.common.Player;
import androidx.media3.common.VideoSize;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.analytics.AnalyticsListener;

import java.net.InetAddress;
import java.net.URI;
import java.util.Locale;
import java.util.function.Supplier;

/**
 * Small playback helpers shared by both apps:
 * <ul>
 *   <li>DNS pre-resolution of the stream host, so the first request does not wait for it.</li>
 *   <li>Stall memory: two rebuffers within 90 s while quality is on Auto cap the video bitrate at
 *       three quarters of the current rendition for four minutes, so a flaky connection settles on a
 *       steady picture instead of oscillating between sharp and buffering.</li>
 *   <li>Per-stream enhancement strength from bits-per-pixel: starved streams get a stronger clean-up.</li>
 *   <li>An optional stats badge (resolution, bitrate, buffer, dropped frames, effects).</li>
 * </ul>
 */
@UnstableApi
public final class PlaybackTuner implements Player.Listener {
    private static final long REBUFFER_WINDOW_MS = 90_000;
    private static final long CAP_MS = 240_000;

    private final ExoPlayer player;
    private final Handler handler;
    private final VideoEnhance.Live live;
    private boolean wasReady = false;
    private long lastSeekMs = -10_000;
    private long firstRebufferMs = 0;
    private int rebuffers = 0;
    private final Runnable uncap;

    public PlaybackTuner(ExoPlayer player, Handler handler, VideoEnhance.Live live) {
        this.player = player;
        this.handler = handler;
        this.live = live;
        this.uncap = () -> {
            try {
                player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                        .setMaxVideoBitrate(Integer.MAX_VALUE).build());
            } catch (Throwable ignored) { }
        };
        player.addListener(this);
    }

    public void release() {
        handler.removeCallbacks(uncap);
        try { player.removeListener(this); } catch (Throwable ignored) { }
    }

    /** Warms the DNS cache for the stream's host on a background thread. */
    public static void prefetchDns(String url) {
        if (url == null) return;
        new Thread(() -> {
            try {
                String host = URI.create(url).getHost();
                if (host != null) InetAddress.getAllByName(host);
            } catch (Throwable ignored) { }
        }, "dns-prefetch").start();
    }

    @Override
    public void onPositionDiscontinuity(Player.PositionInfo oldPosition, Player.PositionInfo newPosition, int reason) {
        if (reason == Player.DISCONTINUITY_REASON_SEEK || reason == Player.DISCONTINUITY_REASON_SEEK_ADJUSTMENT) {
            lastSeekMs = SystemClock.elapsedRealtime();
        }
    }

    @Override
    public void onPlaybackStateChanged(int state) {
        long now = SystemClock.elapsedRealtime();
        if (state == Player.STATE_READY) {
            wasReady = true;
            return;
        }
        // A rebuffer: buffering after playing normally, and not because the viewer just seeked.
        if (state == Player.STATE_BUFFERING && wasReady && player.getPlayWhenReady() && now - lastSeekMs > 3000) {
            if (rebuffers == 0 || now - firstRebufferMs > REBUFFER_WINDOW_MS) {
                rebuffers = 0;
                firstRebufferMs = now;
            }
            rebuffers++;
            if (rebuffers >= 2) {
                rebuffers = 0;
                capQuality();
            }
        }
    }

    private void capQuality() {
        try {
            Format f = player.getVideoFormat();
            if (f == null || f.bitrate <= 0) return;
            int cap = (int) (f.bitrate * 0.75f);
            player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                    .setMaxVideoBitrate(cap).build());
            handler.removeCallbacks(uncap);
            handler.postDelayed(uncap, CAP_MS);
        } catch (Throwable ignored) { }
    }

    @Override
    public void onVideoSizeChanged(VideoSize size) {
        updateStrength();
    }

    @Override
    public void onTracksChanged(androidx.media3.common.Tracks tracks) {
        updateStrength();
    }

    /** More bits per pixel means a cleaner source, so it needs less help. */
    private void updateStrength() {
        float s = 1f;
        try {
            Format f = player.getVideoFormat();
            if (f != null && f.bitrate > 0 && f.width > 0 && f.height > 0) {
                float fps = f.frameRate > 0 ? f.frameRate : 24f;
                float bpp = f.bitrate / (f.width * (float) f.height * fps);
                s = bpp < 0.04f ? 1.3f : bpp < 0.07f ? 1.15f : bpp < 0.12f ? 1f : bpp < 0.2f ? 0.9f : 0.8f;
            }
        } catch (Throwable ignored) { }
        live.strength = s;
    }

    // ---------------------------------------------------------------- stats badge

    /** Small overlay for the curious (and for tuning): what is actually playing, and how it is going. */
    public static final class StatsBadge {
        private final TextView view;
        private final Handler handler = new Handler(android.os.Looper.getMainLooper());
        private ExoPlayer player;
        private Supplier<String> extra;
        private int dropped = 0;
        private boolean enabled = false;
        private AnalyticsListener listener;
        private final Runnable tick = new Runnable() {
            @Override
            public void run() {
                if (!enabled) return;
                render();
                handler.postDelayed(this, 1000);
            }
        };

        public StatsBadge(Context c, ViewGroup root) {
            view = new TextView(c);
            view.setTextColor(Color.WHITE);
            view.setTextSize(11);
            view.setTypeface(Typeface.MONOSPACE);
            view.setBackgroundColor(Color.argb(150, 0, 0, 0));
            int pad = Math.round(6 * c.getResources().getDisplayMetrics().density);
            view.setPadding(pad, pad, pad, pad);
            view.setVisibility(android.view.View.GONE);
            view.setClickable(false);
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                    Gravity.TOP | Gravity.START);
            lp.leftMargin = pad * 2;
            lp.topMargin = pad * 9;
            root.addView(view, lp);
        }

        /** Binds to a (new) player; the dropped-frame count starts over. */
        public void attach(ExoPlayer p, Supplier<String> extraInfo) {
            if (player != null && listener != null) {
                try { player.removeAnalyticsListener(listener); } catch (Throwable ignored) { }
            }
            player = p;
            extra = extraInfo;
            dropped = 0;
            listener = new AnalyticsListener() {
                @Override
                public void onDroppedVideoFrames(EventTime eventTime, int droppedFrames, long elapsedMs) {
                    dropped += droppedFrames;
                }
            };
            p.addAnalyticsListener(listener);
        }

        public void setEnabled(boolean on) {
            enabled = on;
            handler.removeCallbacks(tick);
            view.setVisibility(on ? android.view.View.VISIBLE : android.view.View.GONE);
            if (on) {
                render();
                handler.postDelayed(tick, 1000);
            }
        }

        public void release() {
            handler.removeCallbacks(tick);
            if (player != null && listener != null) {
                try { player.removeAnalyticsListener(listener); } catch (Throwable ignored) { }
            }
            player = null;
        }

        private void render() {
            ExoPlayer p = player;
            if (p == null) return;
            StringBuilder sb = new StringBuilder();
            try {
                Format f = p.getVideoFormat();
                if (f != null) {
                    sb.append(f.width).append('x').append(f.height);
                    if (f.frameRate > 0) sb.append(String.format(Locale.US, " %.0ffps", f.frameRate));
                    if (f.bitrate > 0) sb.append(String.format(Locale.US, " %.1fMbps", f.bitrate / 1_000_000f));
                    if (f.sampleMimeType != null) sb.append(' ').append(f.sampleMimeType.replace("video/", ""));
                    sb.append('\n');
                }
                long bufferedMs = Math.max(0, p.getBufferedPosition() - p.getCurrentPosition());
                sb.append(String.format(Locale.US, "buffer %.0fs  dropped %d", bufferedMs / 1000f, dropped));
                if (extra != null) sb.append('\n').append(extra.get());
            } catch (Throwable t) {
                sb.append("stats unavailable");
            }
            view.setText(sb.toString());
        }
    }
}
