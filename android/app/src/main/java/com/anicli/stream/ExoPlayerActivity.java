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
import androidx.media3.common.Player;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.Tracks;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.SeekParameters;
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy;
import androidx.media3.ui.CaptionStyleCompat;
import androidx.media3.ui.PlayerView;
import androidx.media3.ui.SubtitleView;

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
    // A stalled CDN connection is abandoned after this long and the load
    // retried (was 45 s - the player sat "buffering" that whole time).
    private static final int CONNECT_TIMEOUT_MS = 8_000;
    private static final int READ_TIMEOUT_MS = 12_000;
    // Retries per playlist/segment load before it becomes a player error
    // (ExoPlayer's default is 3) - these CDNs drop requests now and then.
    private static final int LOAD_RETRY_COUNT = 6;

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
    private SeekBar sliderBrightness;
    private SeekBar sliderVolume;

    // Scrubbing: the video itself seeks live (throttled) while the seek bar
    // is dragged, with a time bubble over the thumb.
    private View seekPreviewContainer;
    private View seekPreviewCard;
    private ImageView seekPreviewImage;
    private TextView seekPreviewTime;
    private ThumbnailSprites sprites;
    private long scrubTargetMs = -1;
    private boolean scrubSeekQueued = false;
    private boolean scrubWasPlaying = false;
    private static final long SCRUB_SEEK_INTERVAL_MS = 80;

    // Native stream resolution (see NativeStreamResolver): bumped per request
    // so a slow answer for something the viewer has moved on from is dropped.
    private int resolveToken = 0;
    private boolean nativePrefetchStarted = false;
    private static final long NATIVE_PREFETCH_REMAINING_MS = 180_000;
    // A stream the app resolved this long ago may have expired; resolve anew.
    private static final long PREFETCH_MAX_AGE_MS = 15 * 60 * 1000;
    private long prefetchedAtMs = 0;

    // True from the moment a new stream is asked for until it arrives; the
    // old player (if any) stays on screen, paused, meanwhile.
    private boolean awaitingStream = false;

    // Whether this title has an English dub (the audio panel offers it only then).
    private boolean hasDub = true;

    // Text tracks the player actually reports (side-loaded or embedded), by
    // the label shown in the Subtitles column.
    private final java.util.List<TextTrackOption> textTracks = new java.util.ArrayList<>();

    // Settings (Playback) handed over with each stream.
    private boolean autoSkipIntro = false;
    private boolean autoPlayNext = true;
    private boolean introAutoSkipped = false;

    // Where playback has to continue after a stream swap (audio switch,
    // re-resolve after an HTTP error). Remembered here, in the player, so the
    // position survives no matter what the JS round trip passes back.
    private long pendingResumeMs = -1;
    private String pendingResumeEpisode;
    // Position the freshly prepared stream must be at once it is ready; if the
    // player reports it started elsewhere (e.g. 0:00) it is seeked there.
    private long resumeGuardMs = -1;
    private long resumeGuardSince = 0;
    private static final long RESUME_GUARD_WINDOW_MS = 20_000;

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

    private static final class TextTrackOption {
        final String label;
        final androidx.media3.common.TrackGroup group;
        final int index;

        TextTrackOption(String label, androidx.media3.common.TrackGroup group, int index) {
            this.label = label;
            this.group = group;
            this.index = index;
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

    private final Runnable progressTicker = new Runnable() {
        @Override
        public void run() {
            updateProgress();
            handler.postDelayed(this, 500);
        }
    };

    private final Runnable hideControlsRunnable = () -> setControlsVisible(false);

    // Transient network failures (dropped Wi-Fi, CDN hiccup, 5xx) are
    // retried automatically with exponential backoff (1s, 2s, 4s) before the
    // error overlay is shown; every retry resumes at the last position
    // instead of restarting the episode from 0:00.
    private static final int MAX_AUTO_RETRIES = 3;
    private int autoRetryCount = 0;
    private long lastKnownPositionMs = 0;
    private final Runnable autoRetryRunnable = this::retryPlayback;
    // Loading watchdog: if no stream arrives this long after the player went
    // into its loading state (next episode, episode pick, audio switch), show
    // a Retry instead of spinning forever.
    private static final long LOADING_WATCHDOG_MS = 30_000;
    private final Runnable loadingWatchdog = this::showLoadingStalled;

    // HTTP failures (e.g. a 404 that a fresh lookup doesn't hit) get one
    // automatic re-resolve of the same episode per episode/audio, the same
    // thing closing and reopening the episode does. Key = "episode|mode".
    private String reloadAttemptedKey;
    // Position of the last automatic re-resolve: a later failure well past it
    // (an expired link on a long episode) gets another one.
    private long reloadedAtMs;

    // Next episode's stream, resolved ahead of time by JS (setNextEpisode).
    // Valid only while the episode/audio it was resolved after is playing.
    private Intent prefetchedNextIntent;
    private String prefetchedAfterEpisode;
    private String prefetchedMode;

    // A retry that fires while the app is in the background must not start
    // playing audio there (onStop paused the player on purpose).
    private boolean activityStopped = false;

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
        setupLevelSliders();

        currentActivity = new java.lang.ref.WeakReference<>(this);

        // Back gesture/button closes the player like the top-left arrow,
        // except while the screen is locked: then it only reveals the unlock
        // button (an accidental swipe must not end the episode).
        getOnBackPressedDispatcher().addCallback(this, new androidx.activity.OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (screenLocked) {
                    flashUnlockButton();
                } else {
                    finish();
                }
            }
        });

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
        if (intent.hasExtra("hasDub")) hasDub = intent.getBooleanExtra("hasDub", true);
        if (intent.hasExtra("autoSkipIntro")) autoSkipIntro = intent.getBooleanExtra("autoSkipIntro", false);
        if (intent.hasExtra("autoPlayNext")) autoPlayNext = intent.getBooleanExtra("autoPlayNext", true);
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
        handler.removeCallbacks(loadingWatchdog);
        awaitingStream = false;

        // Fresh episode: reset everything that belonged to the previous one.
        errorOverlay.setVisibility(View.GONE);
        nextEpisodeTriggered = false;
        postPlayDismissed = false;
        introAutoSkipped = false;
        nativePrefetchStarted = false;
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
        if (sprites != null) sprites.release();
        String spriteVtt = intent.getStringExtra("spriteVtt");
        sprites = spriteVtt != null && !spriteVtt.isEmpty() ? ThumbnailSprites.load(spriteVtt, referer) : null;
        long startPositionMs = intent.getLongExtra("startPositionMs", 0L);
        // Same episode coming back after an audio switch / re-resolve: the
        // position remembered by the player wins over whatever came back.
        if (pendingResumeMs > 0 && startPositionMs <= 0
                && episodeNumber != null && episodeNumber.equals(pendingResumeEpisode)) {
            startPositionMs = pendingResumeMs;
        }
        pendingResumeMs = -1;
        pendingResumeEpisode = null;
        resumeGuardMs = startPositionMs > 2_000 ? startPositionMs : -1;
        resumeGuardSince = android.os.SystemClock.elapsedRealtime();
        autoRetryCount = 0;
        lastKnownPositionMs = Math.max(0L, startPositionMs);
        initializePlayer(videoUrl, referer, subtitlesJson, Math.max(0L, startPositionMs), true);
    }

    // The screen must not time out while an episode is playing (or briefly
    // buffering with play intended); once paused, ended or failed the
    // normal screen timeout applies again.
    private void updateKeepScreenOn() {
        boolean keepOn = player != null
                && player.getPlayWhenReady()
                && player.getPlaybackState() != Player.STATE_ENDED
                && player.getPlaybackState() != Player.STATE_IDLE;
        if (keepOn) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
    }

    private void releasePlayer() {
        handler.removeCallbacks(progressTicker);
        handler.removeCallbacks(autoRetryRunnable);
        if (player != null) {
            player.release();
            player = null;
        }
        updateKeepScreenOn();
    }

    // Black screen + spinner + title while JS resolves a stream - replaces
    // the old full-screen "Resolving..." overlay in the app.
    private void showLoadingState() {
        awaitingStream = true;
        // The old stream (if any) stays on screen, paused, until the new one
        // replaces it - a switch of audio or episode must not tear the whole
        // player down to black and back.
        if (player != null) {
            player.pause();
        } else {
            seekBar.setProgress(0);
            seekBar.setSecondaryProgress(0);
            textRemainingTime.setText("");
            btnPlayPause.setImageResource(R.drawable.ic_play);
        }
        errorOverlay.setVisibility(View.GONE);
        hidePostPlay();
        btnSkipIntro.setVisibility(View.GONE);
        btnSkipOutro.setVisibility(View.GONE);
        bufferingSpinner.setVisibility(View.VISIBLE);
        setControlsVisible(true);
        handler.removeCallbacks(hideControlsRunnable);
        handler.removeCallbacks(loadingWatchdog);
        handler.postDelayed(loadingWatchdog, LOADING_WATCHDOG_MS);
    }

    // The app never answered the loading state with a stream. Retry asks it
    // for this same episode again (as if it had been picked from the list).
    private void showLoadingStalled() {
        if (!awaitingStream) return; // a stream did arrive
        final String episode = episodeNumber;
        bufferingSpinner.setVisibility(View.GONE);
        textErrorMessage.setText("This episode is taking too long to load.");
        btnRetry.setText("Retry");
        btnRetry.setOnClickListener(v -> retryFresh(() -> {
            // Native lookup failed too: ask the app, as if picked from the list.
            ExoPlayerPlugin.notifyEpisodeSelected(animeTitle, episode, episode);
            showLoadingState();
        }));
        errorOverlay.setVisibility(View.VISIBLE);
        setControlsVisible(true);
    }

    // Next episode / audio switch / episode pick: JS re-resolves the stream
    // and hands it back via onNewIntent - stay open, show the spinner.
    private void enterLoading(String newEpisodeNumber, String newMode) {
        reloadAttemptedKey = null;
        pendingResumeMs = -1;
        pendingResumeEpisode = null;
        reportProgressNow();
        if (newEpisodeNumber != null) episodeNumber = newEpisodeNumber;
        if (newMode != null) currentMode = newMode;
        textEpisode.setText("E" + (episodeNumber != null ? episodeNumber : "1")
                + ("dub".equals(currentMode) ? " · Dub" : ""));
        btnNextEp.setVisibility(nextEpisodeNumber() != null ? View.VISIBLE : View.GONE);
        showLoadingState();
    }

    private String episodeIdFor(String number) {
        if (number == null) return null;
        for (EpisodeOption option : episodeOptions) {
            if (option.number.equals(number)) return option.id;
        }
        return null;
    }

    // Resolves `number` in `mode` inside the player and starts it, continuing
    // at resumeMs. When that can't be done (no episode id, no server answers)
    // `fallback` hands the request to the app's JavaScript as before.
    // `announce` tells JS which episode/audio is now playing, so watch
    // history and its own bookkeeping follow.
    private void resolveNatively(final String number, final String mode, final long resumeMs,
                                 final boolean fresh, final boolean announce, final Runnable fallback) {
        final int token = ++resolveToken;
        final String episodeId = episodeIdFor(number);
        if (episodeId == null) {
            fallback.run();
            return;
        }
        NativeStreamResolver.runAsync(() -> {
            NativeStreamResolver.Result result = null;
            try {
                result = NativeStreamResolver.resolve(episodeId, mode, fresh);
            } catch (Exception e) {
                Log.w(TAG, "Native resolve failed for E" + number + " (" + mode + "): " + e);
            }
            final NativeStreamResolver.Result resolved = result;
            handler.post(() -> {
                if (token != resolveToken || isFinishing() || isDestroyed()) return;
                if (resolved == null) {
                    fallback.run();
                    return;
                }
                startResolved(number, mode, resumeMs, resolved, announce);
            });
        });
    }

    private void startResolved(String number, String mode, long resumeMs,
                               NativeStreamResolver.Result r, boolean announce) {
        Intent intent = new Intent(this, ExoPlayerActivity.class);
        intent.putExtra("url", r.url);
        intent.putExtra("title", animeTitle);
        intent.putExtra("episode", number);
        intent.putExtra("referer", r.referer);
        intent.putExtra("mode", mode);
        intent.putExtra("subtitles", r.subtitlesJson);
        if (r.spriteVtt != null && !r.spriteVtt.isEmpty()) intent.putExtra("spriteVtt", r.spriteVtt);
        intent.putExtra("isFallback", false);
        intent.putExtra("autoSkipIntro", autoSkipIntro);
        intent.putExtra("autoPlayNext", autoPlayNext);
        intent.putExtra("hasDub", hasDub);
        if (resumeMs > 0) intent.putExtra("startPositionMs", resumeMs);
        if (r.introStartMs >= 0) {
            intent.putExtra("introStartMs", r.introStartMs);
            intent.putExtra("introEndMs", r.introEndMs);
        }
        if (r.outroStartMs >= 0) {
            intent.putExtra("outroStartMs", r.outroStartMs);
            intent.putExtra("outroEndMs", r.outroEndMs);
        }
        if (announce) ExoPlayerPlugin.notifyNextEpisodeStarted(animeTitle, number, mode, r.url);
        setIntent(intent);
        loadFromIntent(intent);
    }

    // Warms the next episode's stream shortly before the current one ends,
    // so Next / the countdown starts it at once with a fresh link.
    private void maybePrefetchNextNatively(long duration, long position) {
        if (nativePrefetchStarted || duration <= 0 || duration - position > NATIVE_PREFETCH_REMAINING_MS) return;
        String next = nextEpisodeNumber();
        String id = episodeIdFor(next);
        if (id == null) return;
        nativePrefetchStarted = true;
        final String mode = currentMode;
        NativeStreamResolver.runAsync(() -> {
            try {
                NativeStreamResolver.resolve(id, mode, false);
                Log.i(TAG, "Prefetched E" + next + " natively");
            } catch (Exception e) {
                Log.w(TAG, "Native prefetch failed (will resolve on demand): " + e);
            }
        });
    }

    // Retry that really starts over: a fresh lookup (an old link may be dead)
    // at the position reached, falling back to the app's lookup.
    private void retryFresh(final Runnable fallback) {
        final long resumeAt = Math.max(lastKnownPositionMs, player != null ? player.getCurrentPosition() : 0);
        final String number = episodeNumber;
        final String mode = currentMode;
        errorOverlay.setVisibility(View.GONE);
        showLoadingState();
        resolveNatively(number, mode, resumeAt, true, true, fallback);
    }

    // JS couldn't resolve a stream for the requested episode.
    void showLoadFailure(String message) {
        handler.removeCallbacks(loadingWatchdog);
        awaitingStream = false;
        releasePlayer();
        playerView.setPlayer(null);
        bufferingSpinner.setVisibility(View.GONE);
        textErrorMessage.setText(message);
        btnRetry.setText("Go Back");
        btnRetry.setOnClickListener(v -> finish());
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
        sliderBrightness = findViewById(R.id.slider_brightness);
        sliderVolume = findViewById(R.id.slider_volume);
        errorOverlay = findViewById(R.id.error_overlay);
        textErrorMessage = findViewById(R.id.text_error_message);
        btnRetry = findViewById(R.id.btn_retry);
        seekPreviewContainer = findViewById(R.id.seek_preview_container);
        seekPreviewCard = findViewById(R.id.seek_preview_card);
        seekPreviewImage = findViewById(R.id.seek_preview_image);
        seekPreviewTime = findViewById(R.id.seek_preview_time);
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

        // Solid white button (readable over any scene); the countdown is a
        // thin red bar along its bottom edge.
        GradientDrawable nextBg = new GradientDrawable();
        nextBg.setCornerRadius(4f * density);
        nextBg.setColor(Color.WHITE);
        btnNextEpisode.setBackground(nextBg);
        btnNextEpisode.setClipToOutline(true);
        btnNextEpisode.setElevation(2f * density);
        nextEpisodeFill.setBackgroundColor(NETFLIX_RED);
        nextEpisodeFill.setPivotX(0f);
        nextEpisodeFill.setScaleX(0f);

        // Small black play icon in front of "Next Episode" (Netflix style).
        TextView nextLabel = findViewById(R.id.next_episode_label);
        android.graphics.drawable.Drawable playIcon = getDrawable(R.drawable.ic_play);
        if (nextLabel != null && playIcon != null) {
            playIcon = playIcon.mutate();
            playIcon.setTint(Color.BLACK);
            int size = Math.round(16 * density);
            playIcon.setBounds(0, 0, size, size);
            nextLabel.setCompoundDrawablesRelative(playIcon, null, null, null);
        }

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

        darkPanel(seekPreviewTime, 18f, 0.8f);
        GradientDrawable previewBg = new GradientDrawable();
        previewBg.setCornerRadius(8f * density);
        previewBg.setColor(Color.BLACK);
        previewBg.setStroke(Math.round(1.5f * density), Color.argb(200, 255, 255, 255));
        seekPreviewCard.setBackground(previewBg);
        seekPreviewCard.setClipToOutline(true);

        // Captions: white with a black outline reads on any scene.
        // Keep the last frame on screen while a new stream replaces the player
        // (audio switch, next episode) instead of flashing black.
        playerView.setKeepContentOnPlayerReset(true);
        SubtitleView subtitleView = playerView.getSubtitleView();
        if (subtitleView != null) {
            subtitleView.setStyle(new CaptionStyleCompat(Color.WHITE, Color.TRANSPARENT, Color.TRANSPARENT,
                    CaptionStyleCompat.EDGE_TYPE_OUTLINE, Color.BLACK, null));
            subtitleView.setFractionalTextSize(0.058f);
            subtitleView.setBottomPaddingFraction(0.08f);
        }

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
            resumeGuardMs = -1;
            if (player != null && introInterval != null) {
                player.seekTo(Math.max(0, introInterval.endMs));
            }
            btnSkipIntro.setVisibility(View.GONE);
        });
        btnSkipOutro.setOnClickListener(v -> {
            resumeGuardMs = -1;
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
                    updateScrub(progress, target);
                }
            }

            @Override
            public void onStartTrackingTouch(SeekBar sb) {
                userSeeking = true;
                showControls();
                handler.removeCallbacks(hideControlsRunnable);
                startScrub();
            }

            @Override
            public void onStopTrackingTouch(SeekBar sb) {
                endScrub(sb.getProgress());
                userSeeking = false;
                scheduleAutoHide();
            }
        });
    }

    // ---- Scrubbing ---------------------------------------------------------
    //
    // While the seek bar is dragged the video seeks along (to the nearest
    // keyframe, throttled), so the picture behind the thumb is the frame you
    // would land on; a bubble shows the time. Playback is paused meanwhile
    // and resumes, exactly positioned, on release.

    private void startScrub() {
        if (player == null || player.getDuration() <= 0) return;
        scrubWasPlaying = player.getPlayWhenReady();
        player.setPlayWhenReady(false);
        player.setSeekParameters(SeekParameters.CLOSEST_SYNC);
        seekPreviewContainer.animate().cancel();
        seekPreviewContainer.setAlpha(0f);
        seekPreviewContainer.setVisibility(View.VISIBLE);
        seekPreviewCard.setVisibility(sprites != null ? View.VISIBLE : View.GONE);
        if (sprites != null) {
            float aspect = sprites.aspect();
            if (aspect > 0) {
                android.view.ViewGroup.LayoutParams lp = seekPreviewCard.getLayoutParams();
                lp.height = Math.round(lp.width / aspect);
                seekPreviewCard.setLayoutParams(lp);
            }
        }
        long target = (long) ((seekBar.getProgress() / 1000.0) * player.getDuration());
        updateScrub(seekBar.getProgress(), target);
        seekPreviewContainer.animate().alpha(1f).setDuration(100).start();
    }

    private void updateScrub(int progress, long targetMs) {
        if (seekPreviewContainer.getVisibility() != View.VISIBLE) return;
        seekPreviewTime.setText(formatTime(Math.max(targetMs, 0)));
        showSpriteFrame(targetMs);

        // Follow the thumb, kept on screen.
        int[] seekLoc = new int[2];
        int[] rootLoc = new int[2];
        View root = findViewById(R.id.root_container);
        seekBar.getLocationInWindow(seekLoc);
        root.getLocationInWindow(rootLoc);
        int trackWidth = seekBar.getWidth() - seekBar.getPaddingLeft() - seekBar.getPaddingRight();
        float thumbX = seekLoc[0] - rootLoc[0] + seekBar.getPaddingLeft() + trackWidth * (progress / 1000f);
        int width = seekPreviewContainer.getWidth() > 0 ? seekPreviewContainer.getWidth() : dp(80);
        float x = Math.max(dp(8), Math.min(root.getWidth() - width - dp(8), thumbX - width / 2f));
        seekPreviewContainer.setTranslationX(x);

        scrubTargetMs = targetMs;
        if (player != null && !scrubSeekQueued) {
            scrubSeekQueued = true;
            handler.postDelayed(scrubSeekRunnable, SCRUB_SEEK_INTERVAL_MS);
        }
    }

    // The thumbnail for the scrub position (when the stream has sprites);
    // if its sheet is still downloading, it appears the moment it arrives.
    private void showSpriteFrame(long targetMs) {
        if (sprites == null) return;
        android.graphics.Bitmap frame = sprites.frameAt(targetMs,
                () -> handler.post(() -> {
                    if (userSeeking && scrubTargetMs >= 0) showSpriteFrame(scrubTargetMs);
                }));
        if (frame != null) seekPreviewImage.setImageBitmap(frame);
    }

    // Seeks are coalesced: while the finger moves quickly only the latest
    // target is decoded, instead of queueing a seek per pixel.
    private final Runnable scrubSeekRunnable = new Runnable() {
        @Override
        public void run() {
            scrubSeekQueued = false;
            if (player != null && scrubTargetMs >= 0) player.seekTo(scrubTargetMs);
        }
    };

    private void endScrub(int progress) {
        resumeGuardMs = -1;
        handler.removeCallbacks(scrubSeekRunnable);
        scrubSeekQueued = false;
        if (player != null && player.getDuration() > 0) {
            long target = (long) ((progress / 1000.0) * player.getDuration());
            player.setSeekParameters(SeekParameters.EXACT);
            player.seekTo(target);
            lastKnownPositionMs = target;
            if (scrubWasPlaying) player.setPlayWhenReady(true);
        }
        scrubTargetMs = -1;
        seekPreviewImage.setImageDrawable(null);
        seekPreviewContainer.animate().cancel();
        seekPreviewContainer.animate().alpha(0f).setDuration(140)
                .withEndAction(() -> seekPreviewContainer.setVisibility(View.GONE))
                .start();
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
        if (hasDub || !isSub) {
            audioRows.add(new MenuRow("English (Dub)", !isSub, () -> {
                if (!isSub) return;
                if (dialogRef[0] != null) dialogRef[0].dismiss();
                requestModeSwitch();
            }));
        }
        columns.addView(buildOptionColumn("Audio", audioRows), new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f));

        java.util.List<MenuRow> subtitleRows = new java.util.ArrayList<>();
        subtitleRows.add(new MenuRow("Off", currentSubtitleLabel == null, () -> selectSubtitle(null)));
        // The tracks the player really reports win; the labels from the
        // stream's own list are only used before it has reported any.
        java.util.List<String> menuLabels = new java.util.ArrayList<>();
        for (TextTrackOption option : textTracks) menuLabels.add(option.label);
        if (menuLabels.isEmpty()) menuLabels.addAll(subtitleLabels);
        for (String label : menuLabels) {
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

    // Switching audio continues from the current position (sub and dub of
    // an episode are the same cut) instead of restarting the episode.
    private void requestModeSwitch() {
        String newMode = "sub".equals(currentMode) ? "dub" : "sub";
        long position = player != null ? Math.max(player.getCurrentPosition(), 0) : lastKnownPositionMs;
        final String episode = episodeNumber;
        final String title = animeTitle;
        enterLoading(null, newMode);
        // Sub and dub are the same cut: carry on from here in the new audio.
        pendingResumeMs = position;
        pendingResumeEpisode = episode;
        resolveNatively(episode, newMode, position, false, true,
                () -> ExoPlayerPlugin.notifyModeSwitchRequested(title, episode, newMode, position));
    }

    private void selectSubtitle(String label) {
        currentSubtitleLabel = label;
        if (player != null) {
            applySubtitleSelection(player.getCurrentTracks());
        }
    }

    // Lists the text tracks the player reports, each under a unique label:
    // the one we gave side-loaded tracks, else the track's own label,
    // language or id.
    private void refreshTextTracks(Tracks tracks) {
        textTracks.clear();
        java.util.Set<String> used = new java.util.HashSet<>();
        int n = 0;
        for (Tracks.Group group : tracks.getGroups()) {
            if (group.getType() != C.TRACK_TYPE_TEXT) continue;
            for (int i = 0; i < group.length; i++) {
                Format format = group.getTrackFormat(i);
                n++;
                String label = format.label;
                if (label == null || label.isEmpty()) {
                    label = format.language != null && !format.language.isEmpty() && !"und".equals(format.language)
                            ? new java.util.Locale(format.language).getDisplayLanguage() : null;
                }
                if (label == null || label.isEmpty()) label = format.id != null ? format.id : "Subtitles " + n;
                String unique = label;
                for (int k = 2; used.contains(unique); k++) unique = label + " (" + k + ")";
                used.add(unique);
                textTracks.add(new TextTrackOption(unique, group.getMediaTrackGroup(), i));
            }
        }
    }

    // Shows the track labelled currentSubtitleLabel and nothing else, or turns
    // captions off entirely when it is null ("Off").
    private void applySubtitleSelection(Tracks tracks) {
        if (player == null) return;
        refreshTextTracks(tracks);
        if (currentSubtitleLabel == null) {
            player.setTrackSelectionParameters(
                    player.getTrackSelectionParameters().buildUpon()
                            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
                            .clearOverridesOfType(C.TRACK_TYPE_TEXT)
                            .build()
            );
            return;
        }
        for (TextTrackOption option : textTracks) {
            if (!currentSubtitleLabel.equals(option.label)) continue;
            player.setTrackSelectionParameters(
                    player.getTrackSelectionParameters().buildUpon()
                            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                            .clearOverridesOfType(C.TRACK_TYPE_TEXT)
                            .addOverride(new TrackSelectionOverride(option.group, option.index))
                            .build()
            );
            SubtitleView view = playerView.getSubtitleView();
            if (view != null) view.setVisibility(View.VISIBLE);
            return;
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
        final String previous = episodeNumber;
        final String title = animeTitle;
        enterLoading(option.number, null);
        resolveNatively(option.number, currentMode, 0, false, true,
                () -> ExoPlayerPlugin.notifyEpisodeSelected(title, previous, option.number));
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

    void setPrefetchedNext(String afterEpisode, String mode, Intent intent) {
        prefetchedAfterEpisode = afterEpisode;
        prefetchedMode = mode;
        prefetchedNextIntent = intent;
        prefetchedAtMs = android.os.SystemClock.elapsedRealtime();
        Log.i(TAG, "Next episode stream ready (after E" + afterEpisode + ", " + mode + ")");
    }

    private void triggerNextEpisode() {
        if (nextEpisodeTriggered) return;
        nextEpisodeTriggered = true;
        String next = nextEpisodeNumber();

        // Prefetched stream for exactly this transition: start it right here,
        // without a round trip through JavaScript (see setNextEpisode).
        Intent prefetched = prefetchedNextIntent;
        if (prefetched != null && next != null
                && android.os.SystemClock.elapsedRealtime() - prefetchedAtMs < PREFETCH_MAX_AGE_MS
                && episodeNumber != null && episodeNumber.equals(prefetchedAfterEpisode)
                && currentMode != null && currentMode.equals(prefetchedMode)
                && next.equals(prefetched.getStringExtra("episode"))) {
            prefetchedNextIntent = null;
            reportProgressNow(); // final position of the episode that's ending
            reloadAttemptedKey = null;
            Intent intent = new Intent(prefetched);
            intent.removeExtra("startPositionMs");
            intent.removeExtra("episodes"); // keep the list already loaded
            Log.i(TAG, "Starting prefetched E" + next);
            ExoPlayerPlugin.notifyNextEpisodeStarted(animeTitle, next, currentMode, intent.getStringExtra("url"));
            setIntent(intent);
            loadFromIntent(intent);
            return;
        }

        prefetchedNextIntent = null;
        final String previous = episodeNumber;
        final String title = animeTitle;
        enterLoading(next, null);
        // Resolved right here (usually warm from the prefetch); the app is
        // only asked when that fails.
        resolveNatively(next, currentMode, 0, false, true,
                () -> ExoPlayerPlugin.notifyNextEpisodeRequested(title, previous));
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

    // A failed stream used to just hang on a black screen with an infinite
    // buffering spinner - show what happened and let the user retry or back out.
    private void showPlaybackError(String message) {
        handler.removeCallbacksAndMessages(null);
        textErrorMessage.setText(message);
        btnRetry.setText("Retry");
        btnRetry.setOnClickListener(v -> retryFresh(this::retryPlayback));
        errorOverlay.setVisibility(View.VISIBLE);
        setControlsVisible(true);
    }

    private void retryPlayback() {
        awaitingStream = false;
        handler.removeCallbacks(loadingWatchdog);
        handler.removeCallbacks(autoRetryRunnable);
        errorOverlay.setVisibility(View.GONE);
        long resumeAt = lastKnownPositionMs;
        if (player != null) {
            resumeAt = Math.max(resumeAt, player.getCurrentPosition());
            player.release();
            player = null;
        }
        if (pendingVideoUrl != null) {
            initializePlayer(pendingVideoUrl, pendingReferer, pendingSubtitlesJson, Math.max(0L, resumeAt), !activityStopped);
        }
    }

    // URI of the HTTP request that failed, when the error was an HTTP status.
    private static String failedRequestUri(androidx.media3.common.PlaybackException error) {
        Throwable cause = error.getCause();
        while (cause != null) {
            if (cause instanceof HttpDataSource.InvalidResponseCodeException) {
                HttpDataSource.InvalidResponseCodeException httpEx = (HttpDataSource.InvalidResponseCodeException) cause;
                return httpEx.dataSpec != null && httpEx.dataSpec.uri != null ? httpEx.dataSpec.uri.toString() : null;
            }
            cause = cause.getCause();
        }
        return null;
    }

    // Removes the subtitle whose file is `uri` from the current stream's
    // list. False when `uri` isn't one of its subtitles.
    private boolean dropSubtitle(String uri) {
        if (pendingSubtitlesJson == null || pendingSubtitlesJson.isEmpty()) return false;
        try {
            JSONArray arr = new JSONArray(pendingSubtitlesJson);
            JSONArray kept = new JSONArray();
            boolean removed = false;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject obj = arr.getJSONObject(i);
                if (uri.equals(obj.optString("src", ""))) {
                    removed = true;
                } else {
                    kept.put(obj);
                }
            }
            if (!removed) return false;
            pendingSubtitlesJson = kept.toString();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    // Worth retrying automatically: connectivity/timeouts, and server-side
    // HTTP failures (429/5xx). A 403/404 or a parsing/decoder error will
    // fail the same way again, so those go straight to the error overlay.
    private static boolean isTransientError(androidx.media3.common.PlaybackException error) {
        switch (error.errorCode) {
            case androidx.media3.common.PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED:
            case androidx.media3.common.PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT:
            case androidx.media3.common.PlaybackException.ERROR_CODE_IO_UNSPECIFIED:
            case androidx.media3.common.PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW:
                return true;
            default:
                break;
        }
        Throwable cause = error.getCause();
        while (cause != null) {
            if (cause instanceof HttpDataSource.InvalidResponseCodeException) {
                int code = ((HttpDataSource.InvalidResponseCodeException) cause).responseCode;
                return code == 429 || code >= 500;
            }
            cause = cause.getCause();
        }
        return false;
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
        resumeGuardMs = -1;
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

        DefaultHttpDataSource.Factory dataSourceFactory = buildDataSourceFactory(referer);

        java.util.List<MediaItem.SubtitleConfiguration> subtitleConfigs = parseSubtitles(subtitlesJson);
        if (!subtitleSelectionInitialized) {
            // Dub: subtitles start off. The tracks a dub server lists are
            // usually the subbed release's captions, timed to the Japanese
            // dialogue, so they never line up with the English audio. They
            // can still be turned on from Audio & Subtitles.
            currentSubtitleLabel = "dub".equals(currentMode) ? null : defaultSubtitleLabel;
            subtitleSelectionInitialized = true;
        }

        MediaItem mediaItem = buildMediaItem(videoUrl, subtitleConfigs);
        DefaultMediaSourceFactory mediaSourceFactory = new DefaultMediaSourceFactory(dataSourceFactory)
                .setLoadErrorHandlingPolicy(new DefaultLoadErrorHandlingPolicy(LOAD_RETRY_COUNT));

        // Bigger read-ahead buffer than ExoPlayer's defaults - fewer visible
        // stalls on the flaky/proxied CDNs this app streams from, at the
        // cost of a little extra memory and a slightly slower initial join.
        DefaultLoadControl loadControl = new DefaultLoadControl.Builder()
                .setBufferDurationsMs(MIN_BUFFER_MS, MAX_BUFFER_MS, BUFFER_FOR_PLAYBACK_MS, BUFFER_FOR_PLAYBACK_AFTER_REBUFFER_MS)
                .build();

        // Media audio focus (pause for calls, duck for notifications) and
        // pause when headphones are unplugged instead of playing out loud.
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
        // Start position goes in with the item: prepare() then seekTo()
        // downloaded the opening segments first and threw them away.
        player.setMediaItem(mediaItem, Math.max(0L, startPositionMs));
        player.prepare();
        player.setPlayWhenReady(playWhenReady);

        player.addListener(new Player.Listener() {
            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                updateKeepScreenOn();
                btnPlayPause.setImageResource(isPlaying ? R.drawable.ic_pause : R.drawable.ic_play);
                if (isPlaying) scheduleAutoHide(); else handler.removeCallbacks(hideControlsRunnable);
            }

            @Override
            public void onPlaybackStateChanged(int state) {
                // STATE_BUFFERING covers both the initial load and any
                // mid-playback stall - showing a spinner for exactly that
                // state (and nothing else) means a stall always reads as
                // "still loading", never a frozen/broken player.
                bufferingSpinner.setVisibility(state == Player.STATE_BUFFERING ? View.VISIBLE : View.GONE);
                updateKeepScreenOn();
                if (state == Player.STATE_ENDED) {
                    if (autoPlayNext && !postPlayDismissed && nextEpisodeNumber() != null) {
                        triggerNextEpisode();
                    } else {
                        showControls();
                    }
                }
                if (state == Player.STATE_READY) {
                    // Recovered - a later hiccup gets the full retry budget.
                    autoRetryCount = 0;
                    enforceResumePosition();
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
            public void onPlayerError(androidx.media3.common.PlaybackException error) {
                Log.e(TAG, "Playback error", error);
                if (player != null) {
                    long position = player.getCurrentPosition();
                    if (position > 0) lastKnownPositionMs = position;
                }
                // A side-loaded subtitle file that fails (e.g. 404) is fatal
                // to ExoPlayer, while a browser just ignores it - drop that
                // track and keep playing.
                String failedUri = failedRequestUri(error);
                if (failedUri != null && dropSubtitle(failedUri)) {
                    Log.w(TAG, "Subtitle failed to load, continuing without it: " + failedUri);
                    retryPlayback();
                    return;
                }
                if (isTransientError(error) && autoRetryCount < MAX_AUTO_RETRIES) {
                    long delayMs = 1000L << autoRetryCount;
                    autoRetryCount++;
                    Log.w(TAG, "Transient playback error, retry " + autoRetryCount + "/" + MAX_AUTO_RETRIES + " in " + delayMs + "ms");
                    bufferingSpinner.setVisibility(View.VISIBLE);
                    handler.removeCallbacks(autoRetryRunnable);
                    handler.postDelayed(autoRetryRunnable, delayMs);
                    return;
                }
                // An HTTP error such as 404 is usually gone after a fresh
                // lookup of the episode (that's why closing and reopening it
                // works) - do that once automatically, resuming here.
                String key = episodeNumber + "|" + currentMode;
                if (failedUri != null
                        && (!key.equals(reloadAttemptedKey) || lastKnownPositionMs - reloadedAtMs > 30_000)) {
                    reloadedAtMs = lastKnownPositionMs;
                    Log.w(TAG, "HTTP error, re-resolving episode " + key + " once: " + failedUri);
                    final long resumeAt = lastKnownPositionMs;
                    final String number = episodeNumber;
                    final String mode = currentMode;
                    final String title = animeTitle;
                    releasePlayer();
                    errorOverlay.setVisibility(View.GONE);
                    showLoadingState();
                    lastKnownPositionMs = resumeAt;
                    pendingResumeMs = resumeAt;
                    pendingResumeEpisode = number;
                    NativeStreamResolver.forget(episodeIdFor(number) != null ? episodeIdFor(number) : "", mode);
                    resolveNatively(number, mode, resumeAt, true, false, () -> {
                        // Native lookup failed: ask the app once; if it is not
                        // there either, show the error.
                        if (ExoPlayerPlugin.notifyReloadRequested(title, number, mode, resumeAt)) {
                            reloadAttemptedKey = number + "|" + mode;
                        } else {
                            showPlaybackError(describePlaybackError(error));
                        }
                    });
                    reloadAttemptedKey = key;
                    return;
                }
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

    private DefaultHttpDataSource.Factory buildDataSourceFactory(String referer) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Referer", referer != null ? referer : "https://zokoanime.video/");
        // Browsers send Origin on HLS segment fetches and the CDN rejects
        // (403) requests without it, even though the provider's own player works.
        String ref = referer != null ? referer : "https://zokoanime.video/";
        try {
            Uri u = Uri.parse(ref);
            if (u.getScheme() != null && u.getHost() != null) {
                headers.put("Origin", u.getScheme() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : ""));
            }
        } catch (Exception ignored) {
        }
        headers.put("Accept", "*/*");
        headers.put("Accept-Language", "en-US,en;q=0.9");
        headers.put("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36");
        return new DefaultHttpDataSource.Factory()
                .setDefaultRequestProperties(headers)
                .setAllowCrossProtocolRedirects(true)
                .setConnectTimeoutMs(CONNECT_TIMEOUT_MS)
                .setReadTimeoutMs(READ_TIMEOUT_MS);
    }

    private MediaItem buildMediaItem(String videoUrl, java.util.List<MediaItem.SubtitleConfiguration> subtitleConfigs) {
        MediaItem.Builder mediaItemBuilder = new MediaItem.Builder().setUri(Uri.parse(videoUrl));
        // Explicitly set MIME type for HLS streams so DefaultMediaSourceFactory creates HlsMediaSource
        // even when the URL is proxied, redirected, or has query parameters without a literal .m3u8 extension
        boolean isHls = videoUrl.contains("m3u8") || videoUrl.contains("/hls/") || videoUrl.contains("master") || videoUrl.contains("index") || !videoUrl.toLowerCase(java.util.Locale.US).contains(".mp4");
        if (isHls) {
            mediaItemBuilder.setMimeType(MimeTypes.APPLICATION_M3U8);
        }
        if (subtitleConfigs != null && !subtitleConfigs.isEmpty()) {
            mediaItemBuilder.setSubtitleConfigurations(subtitleConfigs);
        }
        return mediaItemBuilder.build();
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

    // After a stream swap the player must be where the viewer was. If it is
    // ready somewhere clearly earlier (the new stream started over), seek
    // there. Stays armed - checked on ready and every tick - until the
    // position is right, the viewer seeks themselves, or the window passes.
    private void enforceResumePosition() {
        if (resumeGuardMs <= 0 || player == null) return;
        if (android.os.SystemClock.elapsedRealtime() - resumeGuardSince > RESUME_GUARD_WINDOW_MS) {
            resumeGuardMs = -1;
            return;
        }
        if (player.getPlaybackState() != Player.STATE_READY) return;
        if (player.getCurrentPosition() >= resumeGuardMs - 3_000) {
            resumeGuardMs = -1;
            return;
        }
        Log.w(TAG, "Stream started at " + player.getCurrentPosition() + "ms, resuming at " + resumeGuardMs + "ms");
        player.seekTo(resumeGuardMs);
    }

    private void updateProgress() {
        if (player == null || userSeeking || awaitingStream) return;
        enforceResumePosition();
        long duration = Math.max(player.getDuration(), 0);
        long position = Math.max(player.getCurrentPosition(), 0);
        if (position > 0) lastKnownPositionMs = position;
        if (duration > 0) {
            seekBar.setProgress((int) ((position * 1000) / duration));
            seekBar.setSecondaryProgress(player.getBufferedPercentage() * 10);
            textRemainingTime.setText(formatTime(Math.max(duration - position, 0)));
        }

        boolean shouldShowIntro = introInterval != null
                && position >= introInterval.startMs && position < introInterval.endMs;
        if (shouldShowIntro && autoSkipIntro && !introAutoSkipped) {
            // "Auto-Skip Intro" (Settings): jump past the opening once.
            introAutoSkipped = true;
            player.seekTo(Math.max(0, introInterval.endMs));
            showGestureIndicator("Skipped intro");
            handler.postDelayed(() -> gestureIndicator.setVisibility(View.GONE), 1200);
            shouldShowIntro = false;
        }
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

        // Report before updatePostPlay(): it may switch to the next episode,
        // after which this position would be reported under the new one.
        maybeReportProgress(position, duration);
        maybePrefetchNextNatively(duration, position);
        updatePostPlay(duration, position, shouldShowOutro);
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
        // With "Autoplay Next Episode" off the button just waits to be tapped.
        float progress = autoPlayNext
                ? Math.min(1f, (position - postPlayStartMs) / (float) NEXT_EPISODE_COUNTDOWN_MS)
                : 0f;
        nextEpisodeFill.animate().cancel();
        nextEpisodeFill.animate().scaleX(progress).setDuration(450).start();
        if (autoPlayNext && progress >= 1f) triggerNextEpisode();
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
        if (visible) syncLevelSliders();
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
            return true;
        });
    }

    // Brightness (left) and volume (right) sliders shown with the controls.
    // They drive the same values as the swipe gestures, and both stay in step.
    private void setupLevelSliders() {
        sliderBrightness.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) {
                if (!fromUser) return;
                currentBrightness = Math.max(0.02f, progress / 100f);
                WindowManager.LayoutParams params = getWindow().getAttributes();
                params.screenBrightness = currentBrightness;
                getWindow().setAttributes(params);
                scheduleAutoHide();
            }

            @Override
            public void onStartTrackingTouch(SeekBar bar) { }

            @Override
            public void onStopTrackingTouch(SeekBar bar) { scheduleAutoHide(); }
        });
        sliderVolume.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) {
                if (!fromUser || audioManager == null) return;
                int max = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
                audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, Math.round(progress * max / 100f), 0);
                scheduleAutoHide();
            }

            @Override
            public void onStartTrackingTouch(SeekBar bar) { }

            @Override
            public void onStopTrackingTouch(SeekBar bar) { scheduleAutoHide(); }
        });
        syncLevelSliders();
    }

    private void syncLevelSliders() {
        if (sliderBrightness != null) sliderBrightness.setProgress(Math.round(currentBrightness * 100));
        if (sliderVolume != null && audioManager != null) {
            int max = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
            int current = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC);
            sliderVolume.setProgress(max > 0 ? Math.round(current * 100f / max) : 0);
        }
    }

    private void showGestureIndicator(String text) {
        gestureIndicator.setText(text);
        gestureIndicator.setVisibility(View.VISIBLE);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // Dialogs and the system shade pull the bars back in; hide them again.
        if (hasFocus) {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        }
    }

    @Override
    protected void onStart() {
        super.onStart();
        activityStopped = false;
    }

    @Override
    protected void onStop() {
        super.onStop();
        activityStopped = true;
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
        resolveToken++;
        if (sprites != null) {
            sprites.release();
            sprites = null;
        }
        if (player != null) {
            player.release();
            player = null;
        }
    }
}
