package com.anicli.stream;

import android.app.Dialog;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.view.GestureDetector;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.SeekBar;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.Tracks;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy;
import androidx.media3.ui.PlayerView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;

@UnstableApi
public class ExoPlayerActivity extends AppCompatActivity {
    private static final String TAG = "ExoPlayerActivity";
    private static final long SEEK_STEP_MS = 10_000;
    private static final long CONTROLS_HIDE_DELAY_MS = 3_500;
    // Without an outro marker, post-play ("Next Episode") appears this close
    // to the end; its button then fills up over NEXT_EPISODE_COUNTDOWN_MS of
    // playback before advancing on its own, Netflix-style.
    private static final long NEXT_EPISODE_THRESHOLD_MS = 20_000;
    private static final long NEXT_EPISODE_COUNTDOWN_MS = 10_000;
    private static final long UNLOCK_HINT_MS = 3_000;
    private static final int NETFLIX_RED = Color.parseColor("#E50914");
    private static final float[] PLAYBACK_SPEEDS = {0.5f, 0.75f, 1f, 1.25f, 1.5f};
    private static final long PROGRESS_REPORT_INTERVAL_MS = 5_000;

    // Larger than ExoPlayer's own defaults (15s/50s/2.5s/5s) - trades a
    // little extra memory and a slightly slower initial join for a much
    // bigger cushion against mid-playback stalls on the flaky/proxied CDNs
    // this app streams from.
    private static final int MIN_BUFFER_MS = 30_000;
    private static final int MAX_BUFFER_MS = 60_000;
    private static final int BUFFER_FOR_PLAYBACK_MS = 2_500;
    private static final int BUFFER_FOR_PLAYBACK_AFTER_REBUFFER_MS = 5_000;

    private PlayerView playerView;
    private ExoPlayer player;

    private View controlsRoot;
    private View scrimTop;
    private View scrimBottom;
    private ImageView btnPlayPause;
    private ImageView btnBack;
    private View btnRewind;
    private View btnForward;
    private View btnSpeed;
    private TextView textSpeedLabel;
    private View btnLock;
    private View btnEpisodes;
    private View btnAudioSubs;
    private View btnNextEp;
    private TextView btnSkipIntro;
    private TextView btnSkipOutro;
    private TextView btnWatchCredits;
    private View btnNextEpisode;
    private View nextEpisodeFill;
    private View postPlayContainer;
    private View unlockContainer;
    private View btnUnlock;
    private TextView textTitle;
    private TextView textEpisode;
    private TextView textRemainingTime;
    private TextView gestureIndicator;
    private View bufferingSpinner;
    private SeekBar seekBar;

    private boolean nextEpisodeTriggered = false;
    // Post-play: playback position (ms) at which the "Next Episode" countdown
    // started, or -1 while it isn't showing. "Watch Credits" dismisses it
    // for the rest of the episode.
    private long postPlayStartMs = -1;
    private boolean postPlayDismissed = false;

    private float playbackSpeed = 1f;
    private boolean screenLocked = false;
    private final Runnable hideUnlockRunnable = () -> {
        if (unlockContainer != null) unlockContainer.setVisibility(View.GONE);
    };

    private LinearLayout errorOverlay;
    private TextView textErrorMessage;
    private TextView btnRetry;
    private String pendingVideoUrl;
    private String pendingReferer;
    private String pendingSubtitlesJson;

    // Every subtitle label found in the current stream's subtitle list, in
    // order - used to build the CC picker. currentSubtitleLabel is null when
    // captions are off, otherwise the label of the track that should be
    // showing (matched against Format.id, which parseSubtitles() sets to the
    // same label, once ExoPlayer reports its track groups).
    private final java.util.List<String> subtitleLabels = new java.util.ArrayList<>();
    private String defaultSubtitleLabel;
    private String currentSubtitleLabel;
    private boolean subtitleSelectionInitialized = false;

    // Quality can come from two places, preferred in this order:
    //
    // 1. Adaptive renditions ExoPlayer itself reports for the manifest
    //    (real, verified - only set once tracks actually resolve to more
    //    than one video Format in the same group). Selecting one applies a
    //    TrackSelectionOverride in place, no reload needed.
    // 2. The "qualities" list the JS side supplied (from the scraper), used
    //    only as a fallback, and only when it actually contains more than
    //    one distinct URL - the current scraper often lists the same URL
    //    under several fake quality labels, which is not a real choice and
    //    must not be offered as one.
    private boolean useAdaptiveQualityMenu = false;
    private androidx.media3.common.TrackGroup adaptiveVideoGroup;
    private final java.util.List<VideoQualityOption> videoQualityOptions = new java.util.ArrayList<>();
    private int currentVideoTrackIndex = -1; // -1 == Auto (adaptive)

    private final java.util.List<QualityOption> qualityOptions = new java.util.ArrayList<>();
    private String currentQualityLabel;

    // Real episode list for this anime (id + number only, enough to render a
    // picker and report a selection back to JS) - only populated when the JS
    // side actually supplied one, never guessed.
    private final java.util.List<EpisodeOption> episodeOptions = new java.util.ArrayList<>();

    // Real per-episode intro/ending timestamps from AniSkip, fetched once the
    // player reports a duration - null means no real data was found for that
    // half, so its button never shows (never a guessed range).
    private AniSkipClient.SkipInterval introInterval;
    private AniSkipClient.SkipInterval outroInterval;
    private boolean skipTimesFetched = false;

    private final Handler handler = new Handler(Looper.getMainLooper());

    // Self-healing playback. Transient failures (dropped connection, timeout,
    // 5xx) re-prepare the player in place - ExoPlayer keeps the position -
    // with exponential backoff, up to MAX_AUTO_RETRIES times. A link the CDN
    // now rejects (expired token: 401/403/404/410) can't be fixed by
    // retrying it, so JS is asked once to re-resolve a fresh one. Both
    // budgets refill after STABLE_PLAYBACK_MS of uninterrupted playback, so
    // a long episode on a flaky network can recover many times without a
    // persistently broken stream looping forever.
    private static final int MAX_AUTO_RETRIES = 4;
    private static final long STABLE_PLAYBACK_MS = 30_000;
    // Retries per individual segment/playlist load before it counts as a
    // player error (ExoPlayer's default is 3) - these CDNs drop requests.
    private static final int LOAD_RETRY_COUNT = 6;
    private int autoRetryCount = 0;
    private boolean freshStreamRequested = false;
    private long lastRecoveryRealtimeMs = 0;
    // Last real playback position, kept so a retry can resume even after
    // the player instance is gone.
    private long lastKnownPositionMs = 0;
    // True while a backoff retry is scheduled - the player sits in
    // STATE_IDLE meanwhile, which must still read as "loading".
    private boolean autoRetryPending = false;
    private final Runnable autoRetryRunnable = () -> {
        autoRetryPending = false;
        if (player != null) player.prepare();
    };
    private boolean userSeeking = false;
    private String currentMode = "sub";
    private String animeTitle;
    private String episodeNumber;

    private static final class QualityOption {
        final String label;
        final String url;

        QualityOption(String label, String url) {
            this.label = label;
            this.url = url;
        }
    }

    private static final class EpisodeOption {
        final String id;
        final String number;

        EpisodeOption(String id, String number) {
            this.id = id;
            this.number = number;
        }
    }

    private static final class VideoQualityOption {
        final String label;
        final int trackIndex;

        VideoQualityOption(String label, int trackIndex) {
            this.label = label;
            this.trackIndex = trackIndex;
        }
    }

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
            if (player != null && player.isPlaying()) {
                lastKnownPositionMs = Math.max(player.getCurrentPosition(), 0);
                if ((autoRetryCount > 0 || freshStreamRequested)
                        && android.os.SystemClock.elapsedRealtime() - lastRecoveryRealtimeMs > STABLE_PLAYBACK_MS) {
                    autoRetryCount = 0;
                    freshStreamRequested = false;
                }
            }
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

        currentActivity = new java.lang.ref.WeakReference<>(this);
        loadFromIntent(getIntent());
    }

    // The open player, if any - lets ExoPlayerPlugin.fail() report a stream
    // resolution failure into it.
    private static java.lang.ref.WeakReference<ExoPlayerActivity> currentActivity;

    static ExoPlayerActivity current() {
        ExoPlayerActivity activity = currentActivity != null ? currentActivity.get() : null;
        return activity != null && !activity.isFinishing() ? activity : null;
    }

    // singleTask: the JS side re-launches this activity with the resolved
    // stream (or with a new episode after next/dub/episode picks) - load it
    // into the same player instead of stacking a new one.
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        loadFromIntent(intent);
    }

    // An intent either carries a stream ("url") or only the title/episode
    // to show while JS resolves one (ExoPlayerPlugin.open), in which case
    // the player sits in its loading state until the stream arrives.
    private void loadFromIntent(Intent intent) {
        String videoUrl = intent.getStringExtra("url");
        String referer = intent.getStringExtra("referer");
        String subtitlesJson = intent.getStringExtra("subtitles");
        String qualitiesJson = intent.getStringExtra("qualities");
        String episodesJson = intent.getStringExtra("episodes");
        boolean isFallback = intent.getBooleanExtra("isFallback", false);
        String title = intent.getStringExtra("title");
        if (title != null) animeTitle = title;
        String episode = intent.getStringExtra("episode");
        if (episode != null) episodeNumber = episode;
        String mode = intent.getStringExtra("mode");
        if (mode != null && !mode.isEmpty()) currentMode = mode;
        if (currentMode == null || currentMode.isEmpty()) currentMode = "sub";

        if (referer == null || referer.isEmpty()) {
            referer = "https://zokoanime.video/";
        }

        textTitle.setText(animeTitle != null ? animeTitle : "AniStream");
        // isFallback means every real source failed and this is the app's
        // built-in demo clip, not the real episode - never let that look
        // like real content.
        textEpisode.setText("E" + (episodeNumber != null ? episodeNumber : "1")
                + ("dub".equals(currentMode) ? " · Dub" : "")
                + (isFallback ? " · DEMO - SOURCE UNAVAILABLE" : ""));

        if (episodesJson != null) parseEpisodes(episodesJson);
        btnEpisodes.setVisibility(episodeOptions.size() > 1 ? View.VISIBLE : View.GONE);
        btnNextEp.setVisibility(nextEpisodeNumber() != null ? View.VISIBLE : View.GONE);

        if (videoUrl == null || videoUrl.isEmpty()) {
            showLoadingState();
            return;
        }

        // Fresh episode: reset everything that belonged to the previous one.
        errorOverlay.setVisibility(View.GONE);
        nextEpisodeTriggered = false;
        postPlayDismissed = false;
        hidePostPlay();
        btnSkipIntro.setVisibility(View.GONE);
        btnSkipOutro.setVisibility(View.GONE);
        skipTimesFetched = false;
        subtitleSelectionInitialized = false;

        // Quality choices (when there's a real one) live in the Audio &
        // Subtitles panel, like the rest of Netflix's track selection.
        parseQualities(qualitiesJson, videoUrl);

        // Markers served alongside the stream (HiAnime-style) win; AniSkip
        // only fills in a half the server didn't tag - see maybeFetchSkipTimes().
        introInterval = readSkipRange(intent, "intro");
        outroInterval = readSkipRange(intent, "outro");

        releasePlayer();
        pendingVideoUrl = videoUrl;
        pendingReferer = referer;
        pendingSubtitlesJson = subtitlesJson;
        long startPositionMs = intent.getLongExtra("startPositionMs", 0L);
        lastKnownPositionMs = Math.max(0L, startPositionMs);
        initializePlayer(videoUrl, referer, subtitlesJson, Math.max(0L, startPositionMs), true);
    }

    private void releasePlayer() {
        handler.removeCallbacks(progressTicker);
        handler.removeCallbacks(autoRetryRunnable);
        autoRetryPending = false;
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (player != null) {
            player.release();
            player = null;
        }
    }

    // Black screen + spinner + title while JS resolves a stream - replaces
    // the old full-screen "Resolving..." overlay in the app.
    private void showLoadingState() {
        releasePlayer();
        playerView.setPlayer(null);
        errorOverlay.setVisibility(View.GONE);
        hidePostPlay();
        btnSkipIntro.setVisibility(View.GONE);
        btnSkipOutro.setVisibility(View.GONE);
        seekBar.setProgress(0);
        seekBar.setSecondaryProgress(0);
        textRemainingTime.setText("");
        btnPlayPause.setImageResource(R.drawable.ic_play);
        bufferingSpinner.setVisibility(View.VISIBLE);
        setControlsVisible(true);
        handler.removeCallbacks(hideControlsRunnable);
    }

    // Next episode / audio switch / episode pick: JS re-resolves the stream
    // and hands it back via onNewIntent - stay open, show the spinner.
    private void enterLoading(String newEpisodeNumber, String newMode) {
        reportProgressNow();
        if (newEpisodeNumber != null) episodeNumber = newEpisodeNumber;
        if (newMode != null) currentMode = newMode;
        // A different episode/audio track starts with fresh recovery budgets
        // and no position to resume.
        autoRetryCount = 0;
        freshStreamRequested = false;
        lastKnownPositionMs = 0;
        textEpisode.setText("E" + (episodeNumber != null ? episodeNumber : "1")
                + ("dub".equals(currentMode) ? " · Dub" : ""));
        btnNextEp.setVisibility(nextEpisodeNumber() != null ? View.VISIBLE : View.GONE);
        showLoadingState();
    }

    // JS couldn't resolve a stream for the requested episode.
    void showLoadFailure(String message) {
        releasePlayer();
        bufferingSpinner.setVisibility(View.GONE);
        textErrorMessage.setText(message);
        btnRetry.setText("Retry");
        btnRetry.setOnClickListener(v -> requestFreshStream());
        errorOverlay.setVisibility(View.VISIBLE);
        setControlsVisible(true);
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
        btnSpeed = findViewById(R.id.btn_speed);
        textSpeedLabel = findViewById(R.id.text_speed_label);
        btnLock = findViewById(R.id.btn_lock);
        btnEpisodes = findViewById(R.id.btn_episodes);
        btnAudioSubs = findViewById(R.id.btn_audio_subs);
        btnNextEp = findViewById(R.id.btn_next_ep);
        btnSkipIntro = findViewById(R.id.btn_skip_intro);
        btnSkipOutro = findViewById(R.id.btn_skip_outro);
        btnWatchCredits = findViewById(R.id.btn_watch_credits);
        btnNextEpisode = findViewById(R.id.btn_next_episode);
        nextEpisodeFill = findViewById(R.id.next_episode_fill);
        postPlayContainer = findViewById(R.id.post_play_container);
        unlockContainer = findViewById(R.id.unlock_container);
        btnUnlock = findViewById(R.id.btn_unlock);
        textTitle = findViewById(R.id.text_title);
        textEpisode = findViewById(R.id.text_episode);
        textRemainingTime = findViewById(R.id.text_remaining_time);
        gestureIndicator = findViewById(R.id.gesture_indicator);
        bufferingSpinner = findViewById(R.id.buffering_spinner);
        seekBar = findViewById(R.id.seek_bar);
        errorOverlay = findViewById(R.id.error_overlay);
        textErrorMessage = findViewById(R.id.text_error_message);
        btnRetry = findViewById(R.id.btn_retry);
    }

    // Netflix look: bare white icons over bounded top/bottom scrims, square-
    // cornered outlined skip buttons, a white "Next Episode" button that
    // fills up as it counts down, and a red seek bar (tinted in the layout).
    private void styleGlassChrome() {
        float density = getResources().getDisplayMetrics().density;

        for (TextView skip : new TextView[]{btnSkipIntro, btnSkipOutro, btnWatchCredits}) {
            GradientDrawable bg = new GradientDrawable();
            bg.setCornerRadius(4f * density);
            bg.setColor(Color.argb(165, 20, 20, 20));
            bg.setStroke(Math.round(1.5f * density), Color.argb(220, 255, 255, 255));
            skip.setBackground(bg);
        }

        GradientDrawable nextBg = new GradientDrawable();
        nextBg.setCornerRadius(4f * density);
        nextBg.setColor(Color.argb(190, 255, 255, 255));
        btnNextEpisode.setBackground(nextBg);
        btnNextEpisode.setClipToOutline(true);
        GradientDrawable fillBg = new GradientDrawable();
        fillBg.setCornerRadius(4f * density);
        fillBg.setColor(Color.WHITE);
        nextEpisodeFill.setBackground(fillBg);
        nextEpisodeFill.setPivotX(0f);
        nextEpisodeFill.setScaleX(0f);

        GradientDrawable unlockBg = new GradientDrawable();
        unlockBg.setShape(GradientDrawable.OVAL);
        unlockBg.setColor(Color.argb(128, 0, 0, 0));
        unlockBg.setStroke(Math.round(2 * density), Color.WHITE);
        btnUnlock.setBackground(unlockBg);

        darkPanel(gestureIndicator, 24f, 0.6f);
        darkPanel(errorOverlay, 6f, 0.92f);
        GradientDrawable retryBg = new GradientDrawable();
        retryBg.setCornerRadius(4f * density);
        retryBg.setColor(Color.WHITE);
        btnRetry.setBackground(retryBg);

        scrimTop.setBackground(edgeScrim(GradientDrawable.Orientation.TOP_BOTTOM));
        scrimBottom.setBackground(edgeScrim(GradientDrawable.Orientation.BOTTOM_TOP));
        // Chrome starts out visible, so start the skip buttons above it.
        postPlayContainer.setTranslationY(-dp(84));
    }

    private void darkPanel(View view, float radiusDp, float alpha) {
        float density = getResources().getDisplayMetrics().density;
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(radiusDp * density);
        bg.setColor(Color.argb(Math.round(alpha * 255), 20, 20, 20));
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
            if (player != null && introInterval != null) {
                player.seekTo(Math.max(0, introInterval.endMs));
            }
            btnSkipIntro.setVisibility(View.GONE);
        });
        btnSkipOutro.setOnClickListener(v -> {
            if (player != null && outroInterval != null) {
                player.seekTo(Math.max(0, outroInterval.endMs));
            }
            btnSkipOutro.setVisibility(View.GONE);
        });
        btnWatchCredits.setOnClickListener(v -> {
            postPlayDismissed = true;
            hidePostPlay();
        });
        btnNextEpisode.setOnClickListener(v -> triggerNextEpisode());
        btnSpeed.setOnClickListener(v -> showSpeedPanel());
        btnLock.setOnClickListener(v -> lockScreen());
        btnUnlock.setOnClickListener(v -> unlockScreen());
        btnAudioSubs.setOnClickListener(this::showAudioSubtitlesMenu);
        btnEpisodes.setOnClickListener(this::showEpisodeMenu);
        btnNextEp.setOnClickListener(v -> triggerNextEpisode());
        btnRetry.setOnClickListener(v -> retryPlayback());

        seekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar sb, int progress, boolean fromUser) {
                if (fromUser && player != null && player.getDuration() > 0) {
                    long target = (long) ((progress / 1000.0) * player.getDuration());
                    textRemainingTime.setText(formatTime(Math.max(player.getDuration() - target, 0)));
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

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    // Full-screen, near-black Netflix panel with a close "X" in the top-right
    // corner. The caller fills `content`; the returned dialog is already
    // showing.
    private Dialog showFullScreenPanel(View content) {
        Dialog dialog = new Dialog(this, android.R.style.Theme_Black_NoTitleBar_Fullscreen);
        android.widget.FrameLayout root = new android.widget.FrameLayout(this);
        root.setBackgroundColor(Color.argb(235, 0, 0, 0));
        root.setPadding(dp(28), dp(20), dp(28), dp(16));

        root.addView(content, new android.widget.FrameLayout.LayoutParams(
                android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
                android.widget.FrameLayout.LayoutParams.MATCH_PARENT));

        ImageView close = new ImageView(this);
        close.setImageResource(R.drawable.ic_close);
        close.setPadding(dp(8), dp(8), dp(8), dp(8));
        close.setContentDescription("Close");
        close.setOnClickListener(v -> dialog.dismiss());
        android.widget.FrameLayout.LayoutParams closeParams =
                new android.widget.FrameLayout.LayoutParams(dp(44), dp(44), Gravity.TOP | Gravity.END);
        root.addView(close, closeParams);

        dialog.setContentView(root);
        Window window = dialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT);
            // Show without taking focus first so the system bars don't pop
            // back in over the immersive player.
            window.setFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE);
            window.getDecorView().setSystemUiVisibility(getWindow().getDecorView().getSystemUiVisibility());
        }
        handler.removeCallbacks(hideControlsRunnable);
        dialog.setOnDismissListener(d -> scheduleAutoHide());
        dialog.show();
        if (window != null) window.clearFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE);
        return dialog;
    }

    // One selectable column ("Audio", "Subtitles", "Video Quality"): white
    // bold + checkmark for the active row, grey for the rest. Picking a row
    // runs its action and moves the checkmark there.
    private View buildOptionColumn(String title, java.util.List<MenuRow> rows) {
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);

        TextView header = new TextView(this);
        header.setText(title);
        header.setTextColor(Color.WHITE);
        header.setTextSize(18);
        header.setTypeface(header.getTypeface(), android.graphics.Typeface.BOLD);
        header.setPadding(0, 0, 0, dp(12));
        column.addView(header);

        java.util.List<ImageView> checks = new java.util.ArrayList<>();
        java.util.List<TextView> labels = new java.util.ArrayList<>();
        for (int i = 0; i < rows.size(); i++) {
            MenuRow row = rows.get(i);
            LinearLayout rowView = new LinearLayout(this);
            rowView.setOrientation(LinearLayout.HORIZONTAL);
            rowView.setGravity(Gravity.CENTER_VERTICAL);
            rowView.setPadding(0, dp(9), dp(8), dp(9));
            rowView.setClickable(true);

            ImageView check = new ImageView(this);
            check.setImageResource(R.drawable.ic_check);
            check.setVisibility(row.selected ? View.VISIBLE : View.INVISIBLE);
            LinearLayout.LayoutParams checkParams = new LinearLayout.LayoutParams(dp(20), dp(20));
            checkParams.setMarginEnd(dp(8));
            rowView.addView(check, checkParams);

            TextView label = new TextView(this);
            label.setText(row.label);
            label.setTextSize(15);
            styleOptionLabel(label, row.selected);
            rowView.addView(label);

            checks.add(check);
            labels.add(label);
            final int index = i;
            rowView.setOnClickListener(v -> {
                for (int j = 0; j < checks.size(); j++) {
                    checks.get(j).setVisibility(j == index ? View.VISIBLE : View.INVISIBLE);
                    styleOptionLabel(labels.get(j), j == index);
                }
                row.onSelect.run();
            });
            column.addView(rowView);
        }

        android.widget.ScrollView scroll = new android.widget.ScrollView(this);
        scroll.addView(column);
        return scroll;
    }

    private void styleOptionLabel(TextView label, boolean selected) {
        label.setTextColor(selected ? Color.WHITE : Color.parseColor("#A3A3A3"));
        label.setTypeface(null, selected ? android.graphics.Typeface.BOLD : android.graphics.Typeface.NORMAL);
    }

    // Netflix's "Audio & Subtitles" screen: side-by-side columns. Audio is
    // the sub/dub choice (re-resolved by JS), Subtitles lists "Off" plus
    // every track this stream really has, and a Video Quality column
    // appears only when there's a genuine choice of renditions.
    private void showAudioSubtitlesMenu(View anchor) {
        LinearLayout columns = new LinearLayout(this);
        columns.setOrientation(LinearLayout.HORIZONTAL);
        columns.setPadding(0, dp(28), dp(40), 0);
        final Dialog[] dialogRef = new Dialog[1];

        java.util.List<MenuRow> audioRows = new java.util.ArrayList<>();
        boolean isSub = "sub".equals(currentMode);
        // Switching audio re-resolves the stream in JS and closes the player.
        audioRows.add(new MenuRow("Japanese [Original]", isSub, () -> {
            if (isSub) return;
            if (dialogRef[0] != null) dialogRef[0].dismiss();
            requestModeSwitch();
        }));
        audioRows.add(new MenuRow("English (Dub)", !isSub, () -> {
            if (!isSub) return;
            if (dialogRef[0] != null) dialogRef[0].dismiss();
            requestModeSwitch();
        }));
        columns.addView(buildOptionColumn("Audio", audioRows), new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f));

        java.util.List<MenuRow> subtitleRows = new java.util.ArrayList<>();
        subtitleRows.add(new MenuRow("Off", currentSubtitleLabel == null, () -> selectSubtitle(null)));
        for (String label : subtitleLabels) {
            subtitleRows.add(new MenuRow(label, label.equals(currentSubtitleLabel), () -> selectSubtitle(label)));
        }
        columns.addView(buildOptionColumn("Subtitles", subtitleRows), new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f));

        java.util.List<MenuRow> qualityRows = new java.util.ArrayList<>();
        if (useAdaptiveQualityMenu) {
            qualityRows.add(new MenuRow("Auto", currentVideoTrackIndex == -1, () -> selectVideoQuality(-1)));
            for (VideoQualityOption option : videoQualityOptions) {
                qualityRows.add(new MenuRow(option.label, option.trackIndex == currentVideoTrackIndex,
                        () -> selectVideoQuality(option.trackIndex)));
            }
        } else if (qualityOptions.size() > 1) {
            for (QualityOption option : qualityOptions) {
                qualityRows.add(new MenuRow(option.label, option.label.equals(currentQualityLabel), () -> {
                    // Rebuilds the player - close the panel first.
                    if (dialogRef[0] != null) dialogRef[0].dismiss();
                    switchQuality(option);
                }));
            }
        }
        if (!qualityRows.isEmpty()) {
            columns.addView(buildOptionColumn("Video Quality", qualityRows), new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f));
        }

        dialogRef[0] = showFullScreenPanel(columns);
    }

    // Netflix "Playback Speed": five stops on a line, the active one a big
    // white dot, applied instantly.
    private void showSpeedPanel() {
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setGravity(Gravity.CENTER);

        TextView title = new TextView(this);
        title.setText("Playback Speed");
        title.setTextColor(Color.WHITE);
        title.setTextSize(20);
        title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
        title.setGravity(Gravity.CENTER);
        content.addView(title);

        android.widget.FrameLayout track = new android.widget.FrameLayout(this);
        LinearLayout.LayoutParams trackParams = new LinearLayout.LayoutParams(Math.min(dp(560),
                getResources().getDisplayMetrics().widthPixels - dp(80)), LinearLayout.LayoutParams.WRAP_CONTENT);
        trackParams.topMargin = dp(32);
        content.addView(track, trackParams);

        // Rail through the dot centers (10% inset = half of one of the five stops).
        View rail = new View(this);
        rail.setBackgroundColor(Color.argb(128, 255, 255, 255));
        android.widget.FrameLayout.LayoutParams railParams =
                new android.widget.FrameLayout.LayoutParams(android.widget.FrameLayout.LayoutParams.MATCH_PARENT, dp(2));
        railParams.topMargin = dp(13);
        track.addView(rail, railParams);
        track.post(() -> {
            int inset = track.getWidth() / 10;
            android.widget.FrameLayout.LayoutParams lp = (android.widget.FrameLayout.LayoutParams) rail.getLayoutParams();
            lp.leftMargin = inset;
            lp.rightMargin = inset;
            rail.setLayoutParams(lp);
        });

        LinearLayout stops = new LinearLayout(this);
        stops.setOrientation(LinearLayout.HORIZONTAL);
        track.addView(stops, new android.widget.FrameLayout.LayoutParams(
                android.widget.FrameLayout.LayoutParams.MATCH_PARENT, android.widget.FrameLayout.LayoutParams.WRAP_CONTENT));

        java.util.List<View> dots = new java.util.ArrayList<>();
        java.util.List<TextView> labels = new java.util.ArrayList<>();
        for (float speed : PLAYBACK_SPEEDS) {
            LinearLayout stop = new LinearLayout(this);
            stop.setOrientation(LinearLayout.VERTICAL);
            stop.setGravity(Gravity.CENTER_HORIZONTAL);
            stop.setClickable(true);

            android.widget.FrameLayout dotBox = new android.widget.FrameLayout(this);
            View dot = new View(this);
            dotBox.addView(dot, new android.widget.FrameLayout.LayoutParams(dp(12), dp(12), Gravity.CENTER));
            stop.addView(dotBox, new LinearLayout.LayoutParams(dp(28), dp(28)));

            TextView label = new TextView(this);
            label.setText(formatSpeed(speed) + (speed == 1f ? " (Normal)" : ""));
            label.setTextSize(13);
            label.setGravity(Gravity.CENTER);
            label.setPadding(0, dp(12), 0, 0);
            stop.addView(label);

            dots.add(dot);
            labels.add(label);
            stop.setOnClickListener(v -> {
                setPlaybackSpeed(speed);
                for (int i = 0; i < dots.size(); i++) styleSpeedStop(dots.get(i), labels.get(i), PLAYBACK_SPEEDS[i] == speed);
            });
            stops.addView(stop, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
            styleSpeedStop(dot, label, speed == playbackSpeed);
        }

        showFullScreenPanel(content);
    }

    private void styleSpeedStop(View dot, TextView label, boolean active) {
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.OVAL);
        bg.setColor(active ? Color.WHITE : Color.parseColor("#A3A3A3"));
        dot.setBackground(bg);
        int size = active ? dp(24) : dp(12);
        android.view.ViewGroup.LayoutParams lp = dot.getLayoutParams();
        lp.width = size;
        lp.height = size;
        dot.setLayoutParams(lp);
        label.setTextColor(active ? Color.WHITE : Color.parseColor("#A3A3A3"));
        label.setTypeface(null, active ? android.graphics.Typeface.BOLD : android.graphics.Typeface.NORMAL);
    }

    private static String formatSpeed(float speed) {
        return (speed == Math.round(speed) ? String.valueOf(Math.round(speed)) : String.valueOf(speed)) + "x";
    }

    private void setPlaybackSpeed(float speed) {
        playbackSpeed = speed;
        if (player != null) player.setPlaybackSpeed(speed);
        textSpeedLabel.setText("Speed (" + formatSpeed(speed) + ")");
    }

    // Netflix screen lock: hides every control and ignores gestures; a tap
    // only reveals the unlock button for a few seconds.
    private void lockScreen() {
        screenLocked = true;
        handler.removeCallbacks(hideControlsRunnable);
        setControlsVisible(false);
        postPlayContainer.setVisibility(View.GONE);
    }

    private void unlockScreen() {
        screenLocked = false;
        handler.removeCallbacks(hideUnlockRunnable);
        unlockContainer.setVisibility(View.GONE);
        postPlayContainer.setVisibility(View.VISIBLE);
        showControls();
    }

    private void flashUnlockButton() {
        unlockContainer.setVisibility(View.VISIBLE);
        handler.removeCallbacks(hideUnlockRunnable);
        handler.postDelayed(hideUnlockRunnable, UNLOCK_HINT_MS);
    }

    private void requestModeSwitch() {
        String newMode = "sub".equals(currentMode) ? "dub" : "sub";
        ExoPlayerPlugin.notifyModeSwitchRequested(animeTitle, episodeNumber, newMode);
        enterLoading(null, newMode);
    }

    private void selectSubtitle(String label) {
        currentSubtitleLabel = label;
        if (player != null) {
            applySubtitleSelection(player.getCurrentTracks());
        }
    }

    // Finds the text track group whose Format.id matches currentSubtitleLabel
    // (parseSubtitles() gives every subtitle config an id equal to its label)
    // and selects only that one, or disables text tracks entirely when
    // currentSubtitleLabel is null ("Off").
    private void applySubtitleSelection(Tracks tracks) {
        if (player == null) return;
        if (currentSubtitleLabel == null) {
            player.setTrackSelectionParameters(
                    player.getTrackSelectionParameters().buildUpon()
                            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
                            .clearOverridesOfType(C.TRACK_TYPE_TEXT)
                            .build()
            );
            return;
        }
        for (Tracks.Group group : tracks.getGroups()) {
            if (group.getType() != C.TRACK_TYPE_TEXT) continue;
            for (int i = 0; i < group.length; i++) {
                Format format = group.getTrackFormat(i);
                if (currentSubtitleLabel.equals(format.id)) {
                    // If ExoPlayer itself flags this track as unsupported
                    // (e.g. a format/codec it can't decode), selecting it
                    // will never render anything - log it so that's visible
                    // in logcat instead of silently doing nothing.
                    if (!group.isTrackSupported(i)) {
                        Log.w(TAG, "Subtitle track '" + currentSubtitleLabel + "' (mimeType=" + format.sampleMimeType
                                + ") is reported unsupported by ExoPlayer - it will not render.");
                    }
                    player.setTrackSelectionParameters(
                            player.getTrackSelectionParameters().buildUpon()
                                    .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                                    .clearOverridesOfType(C.TRACK_TYPE_TEXT)
                                    .addOverride(new TrackSelectionOverride(group.getMediaTrackGroup(), i))
                                    .build()
                    );
                    return;
                }
            }
        }
        Log.w(TAG, "Subtitle track '" + currentSubtitleLabel + "' not found in any text track group yet.");
    }

    // Populates qualityOptions from the "qualities" intent extra - but only
    // when it lists more than one genuinely distinct URL. The scraper this
    // app talks to currently repeats the same URL under several fake labels
    // ("1080p"/"720p"/"480p"/"Auto" all pointing at one file); offering that
    // as a choice would be exactly the kind of fake button we're trying not
    // to ship, so a single-URL list is treated as no choice at all.
    private void parseQualities(String qualitiesJson, String currentUrl) {
        qualityOptions.clear();
        currentQualityLabel = null;
        if (qualitiesJson == null || qualitiesJson.isEmpty()) return;
        java.util.List<QualityOption> parsed = new java.util.ArrayList<>();
        java.util.Set<String> distinctUrls = new java.util.HashSet<>();
        try {
            JSONArray arr = new JSONArray(qualitiesJson);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject obj = arr.getJSONObject(i);
                String url = obj.optString("url", "");
                String quality = obj.optString("quality", "");
                if (url.isEmpty() || quality.isEmpty()) continue;
                parsed.add(new QualityOption(quality, url));
                distinctUrls.add(url);
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to parse qualities JSON", e);
            return;
        }
        if (distinctUrls.size() <= 1) return;
        qualityOptions.addAll(parsed);
        for (QualityOption option : qualityOptions) {
            if (option.url.equals(currentUrl)) currentQualityLabel = option.label;
        }
        if (currentQualityLabel == null) {
            currentQualityLabel = qualityOptions.get(0).label;
        }
    }

    // Forces (or clears, for Auto) a specific rendition within the adaptive
    // video track group - no player rebuild needed, ExoPlayer just switches
    // renditions like it would on its own for bandwidth changes.
    private void selectVideoQuality(int trackIndex) {
        if (player == null || adaptiveVideoGroup == null) return;
        currentVideoTrackIndex = trackIndex;
        androidx.media3.common.TrackSelectionParameters.Builder builder =
                player.getTrackSelectionParameters().buildUpon()
                        .setTrackTypeDisabled(C.TRACK_TYPE_VIDEO, false)
                        .clearOverridesOfType(C.TRACK_TYPE_VIDEO);
        if (trackIndex >= 0) {
            builder.addOverride(new TrackSelectionOverride(adaptiveVideoGroup, trackIndex));
        }
        player.setTrackSelectionParameters(builder.build());
    }

    // Checked on every onTracksChanged - the very first time ExoPlayer
    // reports a video track group with more than one Format in it, that's a
    // real adaptive ladder, so switch the quality button over to it
    // permanently for this player instance.
    private void maybeResolveAdaptiveQuality(Tracks tracks) {
        if (useAdaptiveQualityMenu) return;
        for (Tracks.Group group : tracks.getGroups()) {
            if (group.getType() != C.TRACK_TYPE_VIDEO || group.length <= 1) continue;
            adaptiveVideoGroup = group.getMediaTrackGroup();
            videoQualityOptions.clear();
            for (int i = 0; i < group.length; i++) {
                Format format = group.getTrackFormat(i);
                videoQualityOptions.add(new VideoQualityOption(
                        format.height > 0 ? format.height + "p" : "Track " + (i + 1), i));
            }
            useAdaptiveQualityMenu = true;
            return;
        }
    }

    // Populates episodeOptions from the "episodes" intent extra - the real
    // episode list JS already fetched, not something reconstructed here.
    private void parseEpisodes(String episodesJson) {
        episodeOptions.clear();
        if (episodesJson == null || episodesJson.isEmpty()) return;
        try {
            JSONArray arr = new JSONArray(episodesJson);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject obj = arr.getJSONObject(i);
                String id = obj.optString("id", "");
                String number = obj.optString("number", "");
                if (id.isEmpty() || number.isEmpty()) continue;
                episodeOptions.add(new EpisodeOption(id, number));
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to parse episodes JSON", e);
        }
    }

    // Floating window centered over the video: a rounded card with a grid of
    // episode-number tiles (current one highlighted and scrolled into view),
    // dismissed by the close button, a tap outside, or back.
    private void showEpisodeMenu(View anchor) {
        float density = getResources().getDisplayMetrics().density;
        int screenW = getResources().getDisplayMetrics().widthPixels;
        int screenH = getResources().getDisplayMetrics().heightPixels;

        Dialog dialog = new Dialog(this);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable cardBg = new GradientDrawable();
        cardBg.setColor(Color.parseColor("#181818"));
        cardBg.setCornerRadius(8f * density);
        card.setBackground(cardBg);
        card.setElevation(16f * density);
        int pad = Math.round(16 * density);
        card.setPadding(pad, Math.round(14 * density), pad, pad);

        // Header: title + subtitle on the left, close button on the right.
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(0, 0, 0, Math.round(12 * density));

        LinearLayout titles = new LinearLayout(this);
        titles.setOrientation(LinearLayout.VERTICAL);
        titles.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        TextView titleView = new TextView(this);
        titleView.setText("Episodes");
        titleView.setTextColor(Color.WHITE);
        titleView.setTextSize(17);
        titleView.setTypeface(titleView.getTypeface(), android.graphics.Typeface.BOLD);
        titles.addView(titleView);
        TextView subtitleView = new TextView(this);
        subtitleView.setText((animeTitle != null ? animeTitle + " · " : "") + episodeOptions.size() + " episodes");
        subtitleView.setTextColor(Color.parseColor("#B3B3B3"));
        subtitleView.setMaxLines(1);
        subtitleView.setEllipsize(android.text.TextUtils.TruncateAt.END);
        subtitleView.setTextSize(12);
        titles.addView(subtitleView);
        header.addView(titles);

        ImageView close = new ImageView(this);
        close.setImageResource(R.drawable.ic_close);
        int closeSize = Math.round(36 * density);
        close.setPadding(Math.round(6 * density), Math.round(6 * density), Math.round(6 * density), Math.round(6 * density));
        close.setLayoutParams(new LinearLayout.LayoutParams(closeSize, closeSize));
        close.setContentDescription("Close");
        close.setOnClickListener(v -> dialog.dismiss());
        header.addView(close);
        card.addView(header);

        // Grid of episode tiles; column count adapts to the card width.
        int cardWidth = Math.min(Math.round(440 * density), screenW - Math.round(32 * density));
        int tileSize = Math.round(56 * density);
        int gap = Math.round(6 * density);
        int columns = Math.max(3, (cardWidth - 2 * pad + gap) / (tileSize + gap));

        android.widget.GridLayout grid = new android.widget.GridLayout(this);
        grid.setColumnCount(columns);
        View currentTile = null;
        for (EpisodeOption option : episodeOptions) {
            boolean isCurrent = option.number.equals(episodeNumber);
            TextView tile = new TextView(this);
            tile.setText(option.number);
            tile.setGravity(Gravity.CENTER);
            tile.setTextSize(14);
            // Netflix-style: the playing episode is a solid white tile.
            tile.setTextColor(isCurrent ? Color.BLACK : Color.parseColor("#D2D2D2"));
            if (isCurrent) tile.setTypeface(tile.getTypeface(), android.graphics.Typeface.BOLD);
            GradientDrawable tileBg = new GradientDrawable();
            tileBg.setCornerRadius(4f * density);
            tileBg.setColor(isCurrent ? Color.WHITE : Color.parseColor("#2F2F2F"));
            tile.setBackground(tileBg);
            android.widget.GridLayout.LayoutParams lp = new android.widget.GridLayout.LayoutParams(
                    android.widget.GridLayout.spec(android.widget.GridLayout.UNDEFINED),
                    android.widget.GridLayout.spec(android.widget.GridLayout.UNDEFINED, 1f));
            lp.width = 0;
            lp.height = Math.round(44 * density);
            lp.setMargins(gap / 2, gap / 2, gap / 2, gap / 2);
            tile.setLayoutParams(lp);
            tile.setClickable(true);
            tile.setOnClickListener(v -> {
                dialog.dismiss();
                selectEpisode(option);
            });
            grid.addView(tile);
            if (isCurrent) currentTile = tile;
        }

        android.widget.ScrollView scrollView = new android.widget.ScrollView(this);
        int rows = (episodeOptions.size() + columns - 1) / columns;
        int gridHeight = rows * (Math.round(44 * density) + gap);
        int maxGridHeight = Math.round(screenH * 0.8f) - Math.round(90 * density);
        scrollView.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                gridHeight > maxGridHeight ? maxGridHeight : LinearLayout.LayoutParams.WRAP_CONTENT));
        scrollView.addView(grid);
        card.addView(scrollView);

        if (currentTile != null) {
            final View target = currentTile;
            scrollView.post(() -> scrollView.scrollTo(0,
                    Math.max(0, target.getTop() - scrollView.getHeight() / 2 + target.getHeight() / 2)));
        }

        dialog.setContentView(card);
        dialog.setCanceledOnTouchOutside(true);
        Window window = dialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            window.setLayout(cardWidth, WindowManager.LayoutParams.WRAP_CONTENT);
            window.setGravity(Gravity.CENTER);
            window.setDimAmount(0.6f);
            // Keep the player immersive while the window is up.
            window.setFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE);
            window.getDecorView().setSystemUiVisibility(getWindow().getDecorView().getSystemUiVisibility());
        }
        dialog.show();
        if (window != null) window.clearFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE);
    }

    // Reports the pick back to JS (which knows how to re-resolve a stream
    // for it) and closes, mirroring triggerNextEpisode()'s handoff.
    private void selectEpisode(EpisodeOption option) {
        if (option.number.equals(episodeNumber)) return;
        ExoPlayerPlugin.notifyEpisodeSelected(animeTitle, episodeNumber, option.number);
        enterLoading(option.number, null);
    }

    private static final class MenuRow {
        final String label;
        final boolean selected;
        final Runnable onSelect;

        MenuRow(String label, boolean selected, Runnable onSelect) {
            this.label = label;
            this.selected = selected;
            this.onSelect = onSelect;
        }
    }

    // Rebuilds the player against a different quality rendition, resuming at
    // the same position and play state instead of restarting from 0:00. Only
    // reachable via showUrlQualityMenu, i.e. only when the URLs genuinely
    // differ - see parseQualities().
    private void switchQuality(QualityOption option) {
        if (player == null || option.label.equals(currentQualityLabel)) return;
        long resumePosition = Math.max(player.getCurrentPosition(), 0);
        boolean wasPlaying = player.isPlaying();
        currentQualityLabel = option.label;
        pendingVideoUrl = option.url;
        player.release();
        player = null;
        initializePlayer(option.url, pendingReferer, pendingSubtitlesJson, resumePosition, wasPlaying);
    }

    private void triggerNextEpisode() {
        if (nextEpisodeTriggered) return;
        nextEpisodeTriggered = true;
        String next = nextEpisodeNumber();
        ExoPlayerPlugin.notifyNextEpisodeRequested(animeTitle, episodeNumber);
        enterLoading(next, null);
    }

    // Surfaces the real cause of a playback failure - an HTTP status code
    // when the CDN itself rejected a request (blocked/expired link), or the
    // specific exception otherwise (e.g. an unrecognized container/codec) -
    // instead of one generic message that can't be told apart from any other
    // failure. Needed because this app has no real device to test against;
    // this is what turns the next report into an actual diagnosis.
    private String describePlaybackError(androidx.media3.common.PlaybackException error) {
        StringBuilder sb = new StringBuilder("Couldn't play this stream.\n");
        sb.append(error.getErrorCodeName());
        Throwable cause = error.getCause();
        while (cause != null) {
            if (cause instanceof HttpDataSource.InvalidResponseCodeException) {
                HttpDataSource.InvalidResponseCodeException httpEx = (HttpDataSource.InvalidResponseCodeException) cause;
                sb.append("\nHTTP ").append(httpEx.responseCode);
                if (httpEx.dataSpec != null && httpEx.dataSpec.uri != null) {
                    String uri = httpEx.dataSpec.uri.toString();
                    sb.append(" - ").append(uri.length() > 80 ? uri.substring(0, 80) + "…" : uri);
                }
                break;
            }
            if (cause.getMessage() != null && !cause.getMessage().isEmpty()) {
                sb.append("\n").append(cause.getClass().getSimpleName()).append(": ").append(cause.getMessage());
                break;
            }
            cause = cause.getCause();
        }
        return sb.toString();
    }

    // HTTP status behind a playback error, or -1 when it wasn't an HTTP failure.
    private static int httpStatusOf(PlaybackException error) {
        Throwable cause = error.getCause();
        while (cause != null) {
            if (cause instanceof HttpDataSource.InvalidResponseCodeException) {
                return ((HttpDataSource.InvalidResponseCodeException) cause).responseCode;
            }
            cause = cause.getCause();
        }
        return -1;
    }

    private static boolean isTransient(PlaybackException error) {
        switch (error.errorCode) {
            case PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED:
            case PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT:
            case PlaybackException.ERROR_CODE_IO_UNSPECIFIED:
            case PlaybackException.ERROR_CODE_TIMEOUT:
                return true;
            case PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS: {
                int status = httpStatusOf(error);
                return status >= 500 || status == 408 || status == 429;
            }
            default:
                return false;
        }
    }

    private static boolean isExpiredLink(PlaybackException error) {
        if (error.errorCode != PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS) return false;
        int status = httpStatusOf(error);
        return status == 401 || status == 403 || status == 404 || status == 410;
    }

    // Returns true when the error is being recovered from automatically.
    private boolean tryRecover(PlaybackException error) {
        if (player == null) return false;
        if (error.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW) {
            player.seekToDefaultPosition();
            player.prepare();
            return true;
        }
        if (isTransient(error) && autoRetryCount < MAX_AUTO_RETRIES) {
            long delayMs = 1000L << autoRetryCount;
            autoRetryCount++;
            lastRecoveryRealtimeMs = android.os.SystemClock.elapsedRealtime();
            Log.w(TAG, "Transient playback error, retry " + autoRetryCount + "/" + MAX_AUTO_RETRIES + " in " + delayMs + "ms");
            autoRetryPending = true;
            bufferingSpinner.setVisibility(View.VISIBLE);
            handler.removeCallbacks(autoRetryRunnable);
            handler.postDelayed(autoRetryRunnable, delayMs);
            return true;
        }
        if (isExpiredLink(error) && !freshStreamRequested) {
            Log.w(TAG, "Stream link rejected (HTTP " + httpStatusOf(error) + "), requesting a fresh one");
            // Posted: this runs inside the player's own error callback, and
            // requestFreshStream() releases that player.
            freshStreamRequested = true;
            handler.post(this::requestFreshStream);
            return true;
        }
        return false;
    }

    // Asks JS to resolve this episode again (bypassing its cache) and hand
    // back a new stream, resuming at the last known position. Used for
    // expired links and for the error overlay's Retry button.
    private void requestFreshStream() {
        freshStreamRequested = true;
        lastRecoveryRealtimeMs = android.os.SystemClock.elapsedRealtime();
        long resumeAt = player != null ? Math.max(player.getCurrentPosition(), 0) : lastKnownPositionMs;
        lastKnownPositionMs = resumeAt;
        reportProgressNow();
        showLoadingState();
        ExoPlayerPlugin.notifyRetryRequested(animeTitle, episodeNumber, resumeAt);
    }

    // A failed stream used to just hang on a black screen with an infinite
    // buffering spinner - show what happened and let the user retry or back out.
    private void showPlaybackError(String message) {
        handler.removeCallbacksAndMessages(null);
        textErrorMessage.setText(message);
        btnRetry.setText("Retry");
        btnRetry.setOnClickListener(v -> retryPlayback());
        errorOverlay.setVisibility(View.VISIBLE);
        setControlsVisible(true);
    }

    // Manual retry after the automatic recovery gave up: get a fresh stream
    // through JS (the old link may be dead) and resume where playback stopped.
    private void retryPlayback() {
        errorOverlay.setVisibility(View.GONE);
        autoRetryCount = 0;
        requestFreshStream();
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
        initializePlayer(videoUrl, referer, subtitlesJson, 0L, true);
    }

    // startPositionMs/playWhenReady let a quality switch rebuild the player
    // without restarting playback from 0:00.
    private void initializePlayer(String videoUrl, String referer, String subtitlesJson, long startPositionMs, boolean playWhenReady) {
        // Adaptive rendition info belongs to the ExoPlayer instance that
        // reported it - a fresh instance (retry, or a URL-based quality
        // switch) needs to re-resolve it from scratch rather than keep
        // pointing at a TrackGroup from the old one.
        useAdaptiveQualityMenu = false;
        adaptiveVideoGroup = null;
        videoQualityOptions.clear();
        currentVideoTrackIndex = -1;

        Map<String, String> headers = new HashMap<>();
        headers.put("Referer", referer);
        headers.put("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36");

        DefaultHttpDataSource.Factory dataSourceFactory = new DefaultHttpDataSource.Factory()
                .setDefaultRequestProperties(headers)
                .setAllowCrossProtocolRedirects(true)
                .setConnectTimeoutMs(15000)
                .setReadTimeoutMs(45000);

        Uri uri = Uri.parse(videoUrl);
        MediaItem.Builder mediaItemBuilder = new MediaItem.Builder().setUri(uri);

        // Explicitly set MIME type for HLS streams so DefaultMediaSourceFactory creates HlsMediaSource
        // even when the URL is proxied, redirected, or has query parameters without a literal .m3u8 extension
        boolean isHls = videoUrl.contains("m3u8") || videoUrl.contains("/hls/") || videoUrl.contains("master") || videoUrl.contains("index") || !videoUrl.toLowerCase(java.util.Locale.US).contains(".mp4");
        if (isHls) {
            mediaItemBuilder.setMimeType(MimeTypes.APPLICATION_M3U8);
        }

        java.util.List<MediaItem.SubtitleConfiguration> subtitleConfigs = parseSubtitles(subtitlesJson);
        if (!subtitleSelectionInitialized) {
            currentSubtitleLabel = defaultSubtitleLabel;
            subtitleSelectionInitialized = true;
        }

        if (!subtitleConfigs.isEmpty()) {
            mediaItemBuilder.setSubtitleConfigurations(subtitleConfigs);
        }

        MediaItem mediaItem = mediaItemBuilder.build();
        DefaultMediaSourceFactory mediaSourceFactory = new DefaultMediaSourceFactory(dataSourceFactory)
                .setLoadErrorHandlingPolicy(new DefaultLoadErrorHandlingPolicy(LOAD_RETRY_COUNT));

        // Bigger read-ahead buffer than ExoPlayer's defaults - fewer visible
        // stalls on the flaky/proxied CDNs this app streams from, at the
        // cost of a little extra memory and a slightly slower initial join.
        DefaultLoadControl loadControl = new DefaultLoadControl.Builder()
                .setBufferDurationsMs(MIN_BUFFER_MS, MAX_BUFFER_MS, BUFFER_FOR_PLAYBACK_MS, BUFFER_FOR_PLAYBACK_AFTER_REBUFFER_MS)
                .build();

        // Media audio focus: pause for calls/other apps, duck for
        // notifications; and pause when headphones are unplugged rather than
        // suddenly playing out loud.
        AudioAttributes audioAttributes = new AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                .build();

        player = new ExoPlayer.Builder(this)
                .setMediaSourceFactory(mediaSourceFactory)
                .setLoadControl(loadControl)
                .setAudioAttributes(audioAttributes, true)
                .setHandleAudioBecomingNoisy(true)
                .build();
        playerView.setPlayer(player);
        player.setPlaybackSpeed(playbackSpeed);
        player.setMediaItem(mediaItem);
        player.prepare();
        if (startPositionMs > 0) {
            player.seekTo(startPositionMs);
        }
        player.setPlayWhenReady(playWhenReady);

        player.addListener(new Player.Listener() {
            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                btnPlayPause.setImageResource(isPlaying ? R.drawable.ic_pause : R.drawable.ic_play);
                if (isPlaying) scheduleAutoHide(); else handler.removeCallbacks(hideControlsRunnable);
                // Keep the screen awake only while actually playing.
                if (isPlaying) {
                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            }

            @Override
            public void onPlaybackStateChanged(int state) {
                // STATE_BUFFERING covers both the initial load and any
                // mid-playback stall - showing a spinner for exactly that
                // state (and nothing else) means a stall always reads as
                // "still loading", never a frozen/broken player.
                boolean loading = state == Player.STATE_BUFFERING
                        || (state == Player.STATE_IDLE && autoRetryPending);
                bufferingSpinner.setVisibility(loading ? View.VISIBLE : View.GONE);
                if (state == Player.STATE_READY) {
                    textRemainingTime.setText(formatTime(Math.max(player.getDuration(), 0)));
                    maybeFetchSkipTimes();
                }
            }

            @Override
            public void onTracksChanged(Tracks tracks) {
                applySubtitleSelection(tracks);
                maybeResolveAdaptiveQuality(tracks);
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                Log.e(TAG, "Playback error", error);
                if (tryRecover(error)) return;
                showPlaybackError(describePlaybackError(error));
            }
        });

        // A quality switch calls this again on the same activity - avoid
        // stacking a second concurrent progress-update loop on top of the
        // still-running one.
        handler.removeCallbacks(progressTicker);
        handler.post(progressTicker);
        showControls();
    }

    private java.util.List<MediaItem.SubtitleConfiguration> parseSubtitles(String subtitlesJson) {
        java.util.List<MediaItem.SubtitleConfiguration> configs = new java.util.ArrayList<>();
        subtitleLabels.clear();
        defaultSubtitleLabel = null;
        if (subtitlesJson == null || subtitlesJson.isEmpty()) return configs;
        try {
            JSONArray arr = new JSONArray(subtitlesJson);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject obj = arr.getJSONObject(i);
                String src = obj.optString("src", "");
                if (src.isEmpty()) continue;
                String label = obj.optString("label", "English");
                // Track ids double as the menu's selection key (matched
                // against Format.id later), so duplicate labels need to stay
                // distinguishable.
                while (subtitleLabels.contains(label)) {
                    label = label + " (2)";
                }
                boolean isDefault = obj.optBoolean("default", i == 0);
                MediaItem.SubtitleConfiguration config = new MediaItem.SubtitleConfiguration.Builder(Uri.parse(src))
                        .setMimeType(subtitleMimeType(src))
                        .setLanguage(label.toLowerCase(java.util.Locale.US))
                        .setLabel(label)
                        .setId(label)
                        .setSelectionFlags(isDefault ? C.SELECTION_FLAG_DEFAULT : 0)
                        .build();
                configs.add(config);
                subtitleLabels.add(label);
                if (isDefault && defaultSubtitleLabel == null) defaultSubtitleLabel = label;
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to parse subtitles JSON", e);
        }
        if (defaultSubtitleLabel == null && !subtitleLabels.isEmpty()) {
            defaultSubtitleLabel = subtitleLabels.get(0);
        }
        return configs;
    }

    // Forcing every subtitle track to WebVTT regardless of its real format
    // was an unverified assumption - if a track is actually SRT/ASS/TTML,
    // parsing it as WebVTT silently yields zero cues (track selectable,
    // nothing ever renders, no error). Infer the real format from the file
    // extension instead, only defaulting to VTT when the extension doesn't
    // say otherwise.
    private static String subtitleMimeType(String url) {
        String lower = url.toLowerCase(java.util.Locale.US);
        int query = lower.indexOf('?');
        String path = query >= 0 ? lower.substring(0, query) : lower;
        if (path.endsWith(".srt")) return MimeTypes.APPLICATION_SUBRIP;
        if (path.endsWith(".ssa") || path.endsWith(".ass")) return MimeTypes.TEXT_SSA;
        if (path.endsWith(".ttml") || path.endsWith(".dfxp") || path.endsWith(".xml")) return MimeTypes.APPLICATION_TTML;
        return MimeTypes.TEXT_VTT;
    }

    // Looks up this exact anime + episode's real opening/ending timestamps
    // once the player reports a real duration (needed for AniSkip's
    // episodeLength query param) - only once per episode, not on every
    // progress tick.
    private void maybeFetchSkipTimes() {
        if (skipTimesFetched || player == null) return;
        if (introInterval != null && outroInterval != null) {
            skipTimesFetched = true;
            return;
        }
        long durationMs = player.getDuration();
        if (durationMs <= 0) return;
        skipTimesFetched = true;
        AniSkipClient.fetchSkipIntervals(animeTitle, episodeNumber, durationMs / 1000, handler,
                (opening, ending) -> {
                    if (introInterval == null) introInterval = opening;
                    if (outroInterval == null) outroInterval = ending;
                });
    }

    private static AniSkipClient.SkipInterval readSkipRange(Intent intent, String prefix) {
        long startMs = intent.getLongExtra(prefix + "StartMs", -1);
        long endMs = intent.getLongExtra(prefix + "EndMs", -1);
        if (startMs < 0 || endMs <= startMs) return null;
        return new AniSkipClient.SkipInterval(startMs, endMs);
    }

    private void updateProgress() {
        if (player == null || userSeeking) return;
        long duration = Math.max(player.getDuration(), 0);
        long position = Math.max(player.getCurrentPosition(), 0);
        if (duration > 0) {
            seekBar.setProgress((int) ((position * 1000) / duration));
            seekBar.setSecondaryProgress(player.getBufferedPercentage() * 10);
            textRemainingTime.setText(formatTime(Math.max(duration - position, 0)));
        }

        boolean shouldShowIntro = introInterval != null
                && position >= introInterval.startMs && position < introInterval.endMs;
        if (shouldShowIntro && btnSkipIntro.getVisibility() != View.VISIBLE) {
            btnSkipIntro.setVisibility(View.VISIBLE);
        } else if (!shouldShowIntro && btnSkipIntro.getVisibility() == View.VISIBLE) {
            btnSkipIntro.setVisibility(View.GONE);
        }

        boolean shouldShowOutro = outroInterval != null
                && position >= outroInterval.startMs && position < outroInterval.endMs;
        if (shouldShowOutro && btnSkipOutro.getVisibility() != View.VISIBLE) {
            btnSkipOutro.setVisibility(View.VISIBLE);
        } else if (!shouldShowOutro && btnSkipOutro.getVisibility() == View.VISIBLE) {
            btnSkipOutro.setVisibility(View.GONE);
        }

        updatePostPlay(duration, position, shouldShowOutro);
        maybeReportProgress(position, duration);
    }

    // Watch history lives in JS (Preferences storage) - the native player has
    // no way to write it directly, so it has to report its position back
    // over the bridge periodically, the same way it already reports discrete
    // events (mode switch, next episode, episode picks). Throttled to once
    // every few seconds; onStop() forces one final report so backing out or
    // backgrounding mid-episode still saves the real position.
    private long lastProgressReportRealtimeMs = 0;

    private void maybeReportProgress(long position, long duration) {
        if (duration <= 0) return;
        long now = android.os.SystemClock.elapsedRealtime();
        if (now - lastProgressReportRealtimeMs < PROGRESS_REPORT_INTERVAL_MS) return;
        lastProgressReportRealtimeMs = now;
        ExoPlayerPlugin.notifyProgressUpdate(animeTitle, episodeNumber, currentMode, position, duration);
    }

    private void reportProgressNow() {
        if (player == null) return;
        long duration = Math.max(player.getDuration(), 0);
        long position = Math.max(player.getCurrentPosition(), 0);
        if (duration <= 0) return;
        lastProgressReportRealtimeMs = android.os.SystemClock.elapsedRealtime();
        ExoPlayerPlugin.notifyProgressUpdate(animeTitle, episodeNumber, currentMode, position, duration);
    }

    // Netflix post-play: once the credits start (or, without an outro
    // marker, in the last stretch of the episode) show "Next Episode" with a
    // white fill that grows over NEXT_EPISODE_COUNTDOWN_MS of playback, then
    // advance. It runs on playback position, so pausing pauses it too.
    // "Watch Credits" (shown when there's no Skip Outro) dismisses it.
    private void updatePostPlay(long duration, long position, boolean inOutro) {
        if (duration <= 0 || nextEpisodeTriggered) return;
        boolean nearEnd = duration - position <= NEXT_EPISODE_THRESHOLD_MS;
        boolean want = nextEpisodeNumber() != null && !postPlayDismissed && (inOutro || nearEnd);
        if (!want) {
            hidePostPlay();
            return;
        }
        if (postPlayStartMs < 0 || position < postPlayStartMs) postPlayStartMs = position;
        btnNextEpisode.setVisibility(View.VISIBLE);
        btnWatchCredits.setVisibility(inOutro ? View.GONE : View.VISIBLE);
        float progress = Math.min(1f, (position - postPlayStartMs) / (float) NEXT_EPISODE_COUNTDOWN_MS);
        nextEpisodeFill.animate().cancel();
        nextEpisodeFill.animate().scaleX(progress).setDuration(450).start();
        if (progress >= 1f) triggerNextEpisode();
    }

    private void hidePostPlay() {
        postPlayStartMs = -1;
        btnNextEpisode.setVisibility(View.GONE);
        btnWatchCredits.setVisibility(View.GONE);
        nextEpisodeFill.animate().cancel();
        nextEpisodeFill.setScaleX(0f);
    }

    // The real next entry in the episode list JS supplied - null when this is
    // the last one or no list was given (never a guessed number).
    private String nextEpisodeNumber() {
        for (int i = 0; i < episodeOptions.size() - 1; i++) {
            if (episodeOptions.get(i).number.equals(episodeNumber)) return episodeOptions.get(i + 1).number;
        }
        return null;
    }

    // Netflix shows remaining time as m:ss (or h:mm:ss for long videos).
    private String formatTime(long ms) {
        long totalSeconds = ms / 1000;
        long hours = totalSeconds / 3600;
        long minutes = (totalSeconds % 3600) / 60;
        long seconds = totalSeconds % 60;
        if (hours > 0) return String.format(java.util.Locale.US, "%d:%02d:%02d", hours, minutes, seconds);
        return String.format(java.util.Locale.US, "%d:%02d", minutes, seconds);
    }

    private void showControls() {
        if (screenLocked) return;
        setControlsVisible(true);
        scheduleAutoHide();
    }

    private void scheduleAutoHide() {
        handler.removeCallbacks(hideControlsRunnable);
        if (player != null && player.isPlaying()) {
            handler.postDelayed(hideControlsRunnable, CONTROLS_HIDE_DELAY_MS);
        }
    }

    private boolean chromeVisible = true;

    // Fades the chrome and, once hidden, makes it INVISIBLE so its (now
    // transparent) buttons stop catching taps meant for the gesture layer.
    // The skip/post-play buttons ride up above the bottom bar while it's
    // shown and drop back to the corner when it hides.
    private void setControlsVisible(boolean visible) {
        if (visible && screenLocked) return;
        chromeVisible = visible;
        controlsRoot.animate().cancel();
        if (visible) {
            controlsRoot.setVisibility(View.VISIBLE);
            controlsRoot.animate().alpha(1f).setDuration(220).start();
        } else {
            controlsRoot.animate().alpha(0f).setDuration(220)
                    .withEndAction(() -> { if (!chromeVisible) controlsRoot.setVisibility(View.INVISIBLE); })
                    .start();
        }
        postPlayContainer.animate().cancel();
        postPlayContainer.animate().translationY(visible ? -dp(84) : 0f).setDuration(220).start();
    }

    private boolean controlsVisible() {
        return chromeVisible;
    }

    private void setupGestures() {
        gestureDetector = new GestureDetector(this, new GestureDetector.SimpleOnGestureListener() {
            @Override
            public boolean onSingleTapConfirmed(MotionEvent e) {
                if (screenLocked) {
                    flashUnlockButton();
                    return true;
                }
                setControlsVisible(!controlsVisible());
                if (controlsVisible()) scheduleAutoHide();
                return true;
            }

            @Override
            public boolean onDoubleTap(MotionEvent e) {
                if (screenLocked) return true;
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
                draggingVolume = !screenLocked && event.getX() > v.getWidth() / 2f;
                draggingBrightness = !screenLocked && !draggingVolume;
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
        reportProgressNow();
        if (player != null) {
            player.pause();
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (isFinishing()) ExoPlayerPlugin.notifyPlayerClosed();
        if (currentActivity != null && currentActivity.get() == this) currentActivity = null;
        handler.removeCallbacksAndMessages(null);
        if (player != null) {
            player.release();
            player = null;
        }
    }
}
