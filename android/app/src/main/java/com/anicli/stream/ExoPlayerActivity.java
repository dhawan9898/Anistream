package com.anicli.stream;

import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.view.GestureDetector;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.SeekBar;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.widget.PopupMenu;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.hls.HlsMediaSource;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;
import androidx.media3.ui.PlayerView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;

@UnstableApi
public class ExoPlayerActivity extends AppCompatActivity {
    private static final String TAG = "ExoPlayerActivity";
    private static final long SKIP_INTRO_START_MS = 5_000;
    private static final long SKIP_INTRO_END_MS = 120_000;
    private static final long SKIP_INTRO_JUMP_MS = 85_000;
    private static final long SEEK_STEP_MS = 10_000;
    private static final long CONTROLS_HIDE_DELAY_MS = 3_500;
    private static final long NEXT_EPISODE_THRESHOLD_MS = 20_000;
    private static final int NEXT_EPISODE_COUNTDOWN_SECONDS = 12;

    private PlayerView playerView;
    private ExoPlayer player;

    private View controlsRoot;
    private View scrimTop;
    private View scrimBottom;
    private TextView btnPlayPause;
    private TextView btnBack;
    private TextView btnRewind;
    private TextView btnForward;
    private TextView btnAudioSubs;
    private TextView btnSkipIntro;
    private TextView textTitle;
    private TextView textEpisode;
    private TextView textCurrentTime;
    private TextView textRemainingTime;
    private TextView gestureIndicator;
    private SeekBar seekBar;

    private LinearLayout nextEpisodeCard;
    private TextView textNextEpisodeCountdown;
    private TextView textNextEpisodeTitle;
    private TextView btnPlayNextNow;
    private boolean nextEpisodeTriggered = false;
    private int nextEpisodeCountdown = NEXT_EPISODE_COUNTDOWN_SECONDS;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean subtitlesEnabled = true;
    private boolean userSeeking = false;
    private String currentMode = "sub";
    private String animeTitle;
    private String episodeNumber;

    private AudioManager audioManager;
    private float currentBrightness = 0.5f;
    private GestureDetector gestureDetector;
    private float dragStartY;
    private boolean draggingVolume = false;
    private boolean draggingBrightness = false;

    private final Runnable progressTicker = new Runnable() {
        @Override
        public void run() {
            updateProgress();
            handler.postDelayed(this, 500);
        }
    };

    private final Runnable hideControlsRunnable = () -> setControlsVisible(false);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().setFlags(
                WindowManager.LayoutParams.FLAG_FULLSCREEN,
                WindowManager.LayoutParams.FLAG_FULLSCREEN
        );
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN |
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        );

        setContentView(R.layout.activity_exoplayer);
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);

        bindViews();
        styleGlassChrome();
        readInitialBrightness();
        setupGestures();
        setupControlListeners();

        Intent intent = getIntent();
        String videoUrl = intent.getStringExtra("url");
        String referer = intent.getStringExtra("referer");
        String subtitlesJson = intent.getStringExtra("subtitles");
        animeTitle = intent.getStringExtra("title");
        episodeNumber = intent.getStringExtra("episode");
        currentMode = intent.getStringExtra("mode");
        if (currentMode == null || currentMode.isEmpty()) currentMode = "sub";

        if (referer == null || referer.isEmpty()) {
            referer = "https://zokoanime.video/";
        }

        textTitle.setText(animeTitle != null ? animeTitle : "AniStream");
        textEpisode.setText("Ep " + (episodeNumber != null ? episodeNumber : "1") + " • " + currentMode.toUpperCase());

        if (videoUrl != null && !videoUrl.isEmpty()) {
            initializePlayer(videoUrl, referer, subtitlesJson);
        } else {
            Log.e(TAG, "No video URL provided to ExoPlayerActivity");
            finish();
        }
    }

    private void bindViews() {
        playerView = findViewById(R.id.player_view);
        controlsRoot = findViewById(R.id.controls_root);
        scrimTop = findViewById(R.id.scrim_top);
        scrimBottom = findViewById(R.id.scrim_bottom);
        btnPlayPause = findViewById(R.id.btn_play_pause);
        btnBack = findViewById(R.id.btn_back);
        btnRewind = findViewById(R.id.btn_rewind);
        btnForward = findViewById(R.id.btn_forward);
        btnAudioSubs = findViewById(R.id.btn_audio_subs);
        btnSkipIntro = findViewById(R.id.btn_skip_intro);
        textTitle = findViewById(R.id.text_title);
        textEpisode = findViewById(R.id.text_episode);
        textCurrentTime = findViewById(R.id.text_current_time);
        textRemainingTime = findViewById(R.id.text_remaining_time);
        gestureIndicator = findViewById(R.id.gesture_indicator);
        seekBar = findViewById(R.id.seek_bar);
        nextEpisodeCard = findViewById(R.id.next_episode_card);
        textNextEpisodeCountdown = findViewById(R.id.text_next_episode_countdown);
        textNextEpisodeTitle = findViewById(R.id.text_next_episode_title);
        btnPlayNextNow = findViewById(R.id.btn_play_next_now);
    }

    // Netflix-style chrome: clear video with bounded top/bottom scrims (not a
    // full-screen wash) and rounded semi-transparent "glass" pill buttons -
    // no drawable resources needed, no real-time blur behind the video.
    private void styleGlassChrome() {
        pill(btnBack, 20f, 0.35f);
        pill(btnAudioSubs, 20f, 0.35f);
        pill(btnRewind, 26f, 0.28f);
        pill(btnForward, 26f, 0.28f);
        pill(btnSkipIntro, 24f, 0.55f);
        pill(gestureIndicator, 24f, 0.55f);
        pill(nextEpisodeCard, 14f, 0.6f);

        GradientDrawable playBg = new GradientDrawable();
        playBg.setShape(GradientDrawable.OVAL);
        playBg.setColor(Color.parseColor("#B3312E81"));
        btnPlayPause.setBackground(playBg);

        GradientDrawable nextBg = new GradientDrawable();
        nextBg.setShape(GradientDrawable.RECTANGLE);
        nextBg.setCornerRadius(10f * getResources().getDisplayMetrics().density);
        nextBg.setColor(Color.parseColor("#6366f1"));
        btnPlayNextNow.setBackground(nextBg);

        scrimTop.setBackground(edgeScrim(GradientDrawable.Orientation.TOP_BOTTOM));
        scrimBottom.setBackground(edgeScrim(GradientDrawable.Orientation.BOTTOM_TOP));
    }

    private void pill(View view, float radiusDp, float alpha) {
        float density = getResources().getDisplayMetrics().density;
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.RECTANGLE);
        bg.setCornerRadius(radiusDp * density);
        int a = Math.round(alpha * 255);
        bg.setColor(Color.argb(a, 20, 20, 30));
        bg.setStroke(Math.round(density), Color.argb(40, 255, 255, 255));
        view.setBackground(bg);
    }

    private GradientDrawable edgeScrim(GradientDrawable.Orientation orientation) {
        return new GradientDrawable(orientation, new int[]{Color.argb(160, 0, 0, 0), Color.argb(0, 0, 0, 0)});
    }

    private void readInitialBrightness() {
        try {
            int sys = Settings.System.getInt(getContentResolver(), Settings.System.SCREEN_BRIGHTNESS);
            currentBrightness = sys / 255f;
        } catch (Exception e) {
            currentBrightness = 0.5f;
        }
    }

    private void setupControlListeners() {
        btnBack.setOnClickListener(v -> finish());
        btnPlayPause.setOnClickListener(v -> togglePlayPause());
        btnRewind.setOnClickListener(v -> seekBy(-SEEK_STEP_MS));
        btnForward.setOnClickListener(v -> seekBy(SEEK_STEP_MS));
        btnSkipIntro.setOnClickListener(v -> {
            seekBy(SKIP_INTRO_JUMP_MS);
            btnSkipIntro.setVisibility(View.GONE);
        });
        btnAudioSubs.setOnClickListener(this::showAudioSubtitlesMenu);
        btnPlayNextNow.setOnClickListener(v -> triggerNextEpisode());

        seekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar sb, int progress, boolean fromUser) {
                if (fromUser && player != null && player.getDuration() > 0) {
                    long target = (long) ((progress / 1000.0) * player.getDuration());
                    textCurrentTime.setText(formatTime(target));
                }
            }

            @Override
            public void onStartTrackingTouch(SeekBar sb) {
                userSeeking = true;
                showControls();
            }

            @Override
            public void onStopTrackingTouch(SeekBar sb) {
                if (player != null && player.getDuration() > 0) {
                    long target = (long) ((sb.getProgress() / 1000.0) * player.getDuration());
                    player.seekTo(target);
                }
                userSeeking = false;
                scheduleAutoHide();
            }
        });
    }

    // Netflix combines audio + subtitle selection behind one icon; do the same
    // instead of two separate top-bar buttons.
    private void showAudioSubtitlesMenu(View anchor) {
        PopupMenu menu = new PopupMenu(this, anchor);
        String otherMode = "sub".equals(currentMode) ? "Dub" : "Sub";
        menu.getMenu().add(0, 1, 0, "Subtitles: " + (subtitlesEnabled ? "On" : "Off"));
        menu.getMenu().add(0, 2, 1, "Switch Audio to " + otherMode);
        menu.setOnMenuItemClickListener(item -> {
            if (item.getItemId() == 1) {
                toggleSubtitles();
            } else if (item.getItemId() == 2) {
                requestModeSwitch();
            }
            return true;
        });
        menu.show();
    }

    private void requestModeSwitch() {
        String newMode = "sub".equals(currentMode) ? "dub" : "sub";
        ExoPlayerPlugin.notifyModeSwitchRequested(animeTitle, episodeNumber, newMode);
        finish();
    }

    private void toggleSubtitles() {
        if (player == null) return;
        subtitlesEnabled = !subtitlesEnabled;
        player.setTrackSelectionParameters(
                player.getTrackSelectionParameters().buildUpon()
                        .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, !subtitlesEnabled)
                        .build()
        );
    }

    private void triggerNextEpisode() {
        if (nextEpisodeTriggered) return;
        nextEpisodeTriggered = true;
        ExoPlayerPlugin.notifyNextEpisodeRequested(animeTitle, episodeNumber);
        finish();
    }

    private void togglePlayPause() {
        if (player == null) return;
        if (player.isPlaying()) {
            player.pause();
        } else {
            player.play();
        }
        showControls();
    }

    private void seekBy(long deltaMs) {
        if (player == null) return;
        long target = Math.max(0, Math.min(player.getCurrentPosition() + deltaMs, Math.max(player.getDuration(), 0)));
        player.seekTo(target);
        showControls();
    }

    private void initializePlayer(String videoUrl, String referer, String subtitlesJson) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Referer", referer);
        headers.put("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36");

        DefaultHttpDataSource.Factory dataSourceFactory = new DefaultHttpDataSource.Factory()
                .setDefaultRequestProperties(headers)
                .setAllowCrossProtocolRedirects(true)
                .setConnectTimeoutMs(15000)
                .setReadTimeoutMs(30000);

        Uri uri = Uri.parse(videoUrl);
        MediaItem.Builder mediaItemBuilder = new MediaItem.Builder().setUri(uri);

        java.util.List<MediaItem.SubtitleConfiguration> subtitleConfigs = parseSubtitles(subtitlesJson);
        if (!subtitleConfigs.isEmpty()) {
            mediaItemBuilder.setSubtitleConfigurations(subtitleConfigs);
        }
        MediaItem mediaItem = mediaItemBuilder.build();

        MediaSource mediaSource;
        if (videoUrl.contains(".m3u8")) {
            mediaSource = new HlsMediaSource.Factory(dataSourceFactory).createMediaSource(mediaItem);
        } else {
            mediaSource = new ProgressiveMediaSource.Factory(dataSourceFactory).createMediaSource(mediaItem);
        }

        player = new ExoPlayer.Builder(this).build();
        playerView.setPlayer(player);
        player.setMediaSource(mediaSource);
        player.prepare();
        player.setPlayWhenReady(true);

        player.addListener(new Player.Listener() {
            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                btnPlayPause.setText(isPlaying ? "⏸" : "▶");
                if (isPlaying) scheduleAutoHide(); else handler.removeCallbacks(hideControlsRunnable);
            }

            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_READY) {
                    textRemainingTime.setText("-" + formatTime(Math.max(player.getDuration(), 0)));
                }
            }
        });

        handler.post(progressTicker);
        showControls();
    }

    private java.util.List<MediaItem.SubtitleConfiguration> parseSubtitles(String subtitlesJson) {
        java.util.List<MediaItem.SubtitleConfiguration> configs = new java.util.ArrayList<>();
        if (subtitlesJson == null || subtitlesJson.isEmpty()) return configs;
        try {
            JSONArray arr = new JSONArray(subtitlesJson);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject obj = arr.getJSONObject(i);
                String src = obj.optString("src", "");
                if (src.isEmpty()) continue;
                String label = obj.optString("label", "English");
                boolean isDefault = obj.optBoolean("default", i == 0);
                MediaItem.SubtitleConfiguration config = new MediaItem.SubtitleConfiguration.Builder(Uri.parse(src))
                        .setMimeType(MimeTypes.TEXT_VTT)
                        .setLanguage(label.toLowerCase())
                        .setLabel(label)
                        .setSelectionFlags(isDefault ? C.SELECTION_FLAG_DEFAULT : 0)
                        .build();
                configs.add(config);
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to parse subtitles JSON", e);
        }
        return configs;
    }

    private void updateProgress() {
        if (player == null || userSeeking) return;
        long duration = Math.max(player.getDuration(), 0);
        long position = Math.max(player.getCurrentPosition(), 0);
        if (duration > 0) {
            seekBar.setProgress((int) ((position * 1000) / duration));
            textRemainingTime.setText("-" + formatTime(Math.max(duration - position, 0)));
        }
        textCurrentTime.setText(formatTime(position));

        boolean shouldShowSkip = position >= SKIP_INTRO_START_MS && position <= SKIP_INTRO_END_MS;
        if (shouldShowSkip && btnSkipIntro.getVisibility() != View.VISIBLE) {
            btnSkipIntro.setVisibility(View.VISIBLE);
        } else if (!shouldShowSkip && btnSkipIntro.getVisibility() == View.VISIBLE) {
            btnSkipIntro.setVisibility(View.GONE);
        }

        updateNextEpisodePrompt(duration, position);
    }

    // Netflix-style binge flow: in the last stretch of the episode, slide in a
    // "Next Episode" card with a countdown that auto-advances unless dismissed.
    private void updateNextEpisodePrompt(long duration, long position) {
        if (duration <= 0 || nextEpisodeTriggered) return;
        long remaining = duration - position;

        if (remaining > NEXT_EPISODE_THRESHOLD_MS) {
            if (nextEpisodeCard.getVisibility() == View.VISIBLE) {
                nextEpisodeCard.setVisibility(View.GONE);
                nextEpisodeCountdown = NEXT_EPISODE_COUNTDOWN_SECONDS;
            }
            return;
        }

        if (nextEpisodeCard.getVisibility() != View.VISIBLE) {
            nextEpisodeCard.setVisibility(View.VISIBLE);
            String nextNum = nextEpisodeNumber();
            textNextEpisodeTitle.setText(nextNum != null ? ("Episode " + nextNum) : "Next Episode");
            handler.post(nextEpisodeCountdownRunnable);
        }
    }

    private final Runnable nextEpisodeCountdownRunnable = new Runnable() {
        @Override
        public void run() {
            if (nextEpisodeTriggered || nextEpisodeCard.getVisibility() != View.VISIBLE) return;
            textNextEpisodeCountdown.setText("Playing next episode in " + nextEpisodeCountdown + "s");
            if (nextEpisodeCountdown <= 0) {
                triggerNextEpisode();
                return;
            }
            nextEpisodeCountdown--;
            handler.postDelayed(this, 1000);
        }
    };

    private String nextEpisodeNumber() {
        try {
            return String.valueOf(Integer.parseInt(episodeNumber) + 1);
        } catch (Exception e) {
            return null;
        }
    }

    private String formatTime(long ms) {
        long totalSeconds = ms / 1000;
        long minutes = totalSeconds / 60;
        long seconds = totalSeconds % 60;
        return String.format(java.util.Locale.US, "%02d:%02d", minutes, seconds);
    }

    private void showControls() {
        setControlsVisible(true);
        scheduleAutoHide();
    }

    private void scheduleAutoHide() {
        handler.removeCallbacks(hideControlsRunnable);
        if (player != null && player.isPlaying()) {
            handler.postDelayed(hideControlsRunnable, CONTROLS_HIDE_DELAY_MS);
        }
    }

    private void setControlsVisible(boolean visible) {
        controlsRoot.animate().cancel();
        controlsRoot.animate().alpha(visible ? 1f : 0f).setDuration(220).start();
        btnPlayPause.animate().cancel();
        btnPlayPause.animate().alpha(visible ? 1f : 0f).setDuration(220).start();
    }

    private boolean controlsVisible() {
        return controlsRoot.getAlpha() > 0.5f;
    }

    private void setupGestures() {
        gestureDetector = new GestureDetector(this, new GestureDetector.SimpleOnGestureListener() {
            @Override
            public boolean onSingleTapConfirmed(MotionEvent e) {
                setControlsVisible(!controlsVisible());
                if (controlsVisible()) scheduleAutoHide();
                return true;
            }

            @Override
            public boolean onDoubleTap(MotionEvent e) {
                int width = playerView.getWidth();
                if (e.getX() < width * 0.4f) {
                    seekBy(-SEEK_STEP_MS);
                } else if (e.getX() > width * 0.6f) {
                    seekBy(SEEK_STEP_MS);
                }
                return true;
            }
        });

        View overlay = findViewById(R.id.gesture_overlay);
        overlay.setOnTouchListener((v, event) -> {
            gestureDetector.onTouchEvent(event);
            handleVerticalDrag(v, event);
            return true;
        });
    }

    private void handleVerticalDrag(View v, MotionEvent event) {
        switch (event.getAction()) {
            case MotionEvent.ACTION_DOWN:
                dragStartY = event.getY();
                draggingVolume = event.getX() > v.getWidth() / 2f;
                draggingBrightness = !draggingVolume;
                break;
            case MotionEvent.ACTION_MOVE:
                float deltaY = dragStartY - event.getY();
                if (Math.abs(deltaY) < 12) return;
                dragStartY = event.getY();
                float fraction = deltaY / v.getHeight();
                if (draggingVolume) {
                    adjustVolume(fraction);
                } else if (draggingBrightness) {
                    adjustBrightness(fraction);
                }
                break;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                draggingVolume = false;
                draggingBrightness = false;
                handler.postDelayed(() -> gestureIndicator.setVisibility(View.GONE), 700);
                break;
        }
    }

    private void adjustVolume(float fraction) {
        if (audioManager == null) return;
        int max = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        int current = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC);
        int delta = Math.round(fraction * max * 2.5f);
        int next = Math.max(0, Math.min(max, current + delta));
        audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, next, 0);
        int percent = max > 0 ? Math.round((next * 100f) / max) : 0;
        showGestureIndicator("🔊 " + percent + "%");
    }

    private void adjustBrightness(float fraction) {
        currentBrightness = Math.max(0.02f, Math.min(1f, currentBrightness + fraction * 2.5f));
        WindowManager.LayoutParams params = getWindow().getAttributes();
        params.screenBrightness = currentBrightness;
        getWindow().setAttributes(params);
        int percent = Math.round(currentBrightness * 100);
        showGestureIndicator("☀ " + percent + "%");
    }

    private void showGestureIndicator(String text) {
        gestureIndicator.setText(text);
        gestureIndicator.setVisibility(View.VISIBLE);
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (player != null) {
            player.pause();
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        handler.removeCallbacksAndMessages(null);
        if (player != null) {
            player.release();
            player = null;
        }
    }
}
