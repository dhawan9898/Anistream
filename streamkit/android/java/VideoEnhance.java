package __APP_PACKAGE__;

import android.content.Context;
import android.content.SharedPreferences;
import android.opengl.GLES20;

import androidx.media3.common.Effect;
import androidx.media3.common.VideoFrameProcessingException;
import androidx.media3.common.util.GlProgram;
import androidx.media3.common.util.GlUtil;
import androidx.media3.common.util.Size;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.effect.BaseGlShaderProgram;
import androidx.media3.effect.GlEffect;
import androidx.media3.effect.GlShaderProgram;

import java.util.ArrayList;
import java.util.List;

/**
 * Real-time GPU video enhancement for the native player (Media3 setVideoEffects), shared by
 * AniStream and CineStream. Everything runs on the GPU on the decoded frames; no re-encoding.
 *
 * <ul>
 *   <li><b>Sharpening</b>: one fragment-shader pass that upscales to the screen size with a
 *       Catmull-Rom bicubic filter, then restores line art. "Sharp" is a clamped unsharp mask for any
 *       content; "Anime" adds noise coring, extra line darkening and gradient-driven line thinning
 *       (the same idea as Anime4K's Darken/Thin shaders, in one pass). Overshoot is clamped to the
 *       local neighbourhood so there is no ringing.</li>
 *   <li><b>Ambient fill</b>: instead of black bars, the frame is re-rendered at the screen's shape.
 *       The picture sits in the middle, sharp and at its true aspect ratio; the rest shows a heavily
 *       blurred, dimmed, zoomed copy of the same frame. One decoder, one pass (a tiny 96px-wide
 *       blur source is rendered first).</li>
 * </ul>
 *
 * Fit / Crop / Fill are handled inside the fill shader (so toggling them costs nothing and works
 * while paused after a re-render); the PlayerView just shows the output frame stretched to its size.
 */
@UnstableApi
public final class VideoEnhance {
    private VideoEnhance() {}

    // Sharpening choices (stored).
    public static final int SHARP_AUTO = 0;   // "On": the processing is chosen per stream from its resolution
    public static final int SHARP_OFF = 1;

    // What "On" resolves to for a given stream (internal).
    private static final int LVL_SHARP = 2;         // natural-looking sharpening
    private static final int LVL_ANIME = 3;         // line-art restoration
    private static final int LVL_ANIME_PLUS = 4;    // + edge-preserving denoise first, refined lines after

    /** The processing level for a stream of this height; SHARP_OFF means leave it alone. */
    private static int autoLevel(boolean animeApp, boolean saver, int height) {
        if (animeApp) {
            if (height <= 576) return saver ? LVL_ANIME : LVL_ANIME_PLUS;   // old / SD anime: everything
            if (height <= 900) return LVL_ANIME;
            if (height <= 1080) return LVL_SHARP;
            return SHARP_OFF;                                               // already crisp
        }
        return height <= 720 ? LVL_SHARP : SHARP_OFF;
    }

    // Fit modes the fill shader understands (same order as the player's Fit / Crop / Fill button).
    public static final int FIT = 0;
    public static final int CROP = 1;
    public static final int FILL = 2;

    private static final String PREFS = "video_enhance";
    private static final String KEY_SHARPEN = "sharpen";
    private static final String KEY_AMBIENT = "ambient";
    private static final String KEY_VIVID = "vivid";
    private static final String KEY_AUDIO = "audio";
    private static final String KEY_SPATIAL = "spatial";
    private static final String KEY_SUB_SIZE = "subSize";
    private static final String KEY_SUB_STYLE = "subStyle";
    private static final String KEY_SUB_POS = "subPos";
    private static final String KEY_STATS = "stats";

    // Audio choices (stored).
    public static final int AUDIO_NORMAL = 0;
    public static final int AUDIO_BOOST = 1;   // louder than the system volume allows, with headroom
    public static final int AUDIO_NIGHT = 2;   // quiet loud parts, lift dialogue (compressor)
    public static final int AUDIO_DIALOGUE = 3; // speech band lifted, rumble trimmed

    /** Set when the GPU pipeline fails once; effects stay off until the app restarts. */
    private static volatile boolean disabledForSession = false;
    /** Quick before/after switch (long-press on Enhance) and thermal protection: effects off, settings kept. */
    private static volatile boolean bypassed = false;

    public static boolean isBypassed() {
        return bypassed;
    }

    public static void setBypass(boolean on) {
        bypassed = on;
    }

    private static boolean powerSaver(Context c) {
        try {
            android.os.PowerManager pm = (android.os.PowerManager) c.getSystemService(Context.POWER_SERVICE);
            return pm != null && pm.isPowerSaveMode();
        } catch (Throwable t) {
            return false;
        }
    }

    /** State the UI thread updates and the GL thread reads every frame. */
    public static final class Live {
        public volatile float viewAspect = 16f / 9f;   // current width / height of the video view
        public volatile float fullAspect = 16f / 9f;   // same, but only measured at full screen (PiP uses it)
        public volatile int viewW = 1920;
        public volatile int viewH = 1080;
        public volatile int fitMode = FIT;
        /** Set by the sharpen stage for the current stream: should the Anime+ refine pass run? */
        public volatile boolean refine = false;
        /** How much help this stream needs (0.8 clean .. 1.3 starved), from its bits per pixel. */
        public volatile float strength = 1f;
    }

    // ---------------------------------------------------------------- settings

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // Per-show memory: a choice made while watching a title is remembered for that title, and also
    // becomes the default other titles start from.
    private static String showKey(String title, String name) {
        return "show:" + title.trim().toLowerCase(java.util.Locale.ROOT) + ":" + name;
    }

    private static boolean hasShow(String title) {
        return title != null && !title.trim().isEmpty();
    }

    public static int getSharpen(Context c, String title) {
        SharedPreferences p = prefs(c);
        int v = hasShow(title) ? p.getInt(showKey(title, KEY_SHARPEN), p.getInt(KEY_SHARPEN, SHARP_AUTO))
                : p.getInt(KEY_SHARPEN, SHARP_AUTO);
        // Older builds stored Sharp / Anime / Anime+: they all mean "on" now.
        return v == SHARP_OFF ? SHARP_OFF : SHARP_AUTO;
    }

    public static void setSharpen(Context c, String title, int mode) {
        SharedPreferences.Editor e = prefs(c).edit().putInt(KEY_SHARPEN, mode);
        if (hasShow(title)) e.putInt(showKey(title, KEY_SHARPEN), mode);
        e.apply();
    }

    public static boolean getAmbient(Context c, String title) {
        SharedPreferences p = prefs(c);
        boolean global = p.getBoolean(KEY_AMBIENT, true);
        return hasShow(title) ? p.getBoolean(showKey(title, KEY_AMBIENT), global) : global;
    }

    public static void setAmbient(Context c, String title, boolean on) {
        SharedPreferences.Editor e = prefs(c).edit().putBoolean(KEY_AMBIENT, on);
        if (hasShow(title)) e.putBoolean(showKey(title, KEY_AMBIENT), on);
        e.apply();
    }

    public static boolean getVivid(Context c, String title) {
        SharedPreferences p = prefs(c);
        boolean global = p.getBoolean(KEY_VIVID, false);
        return hasShow(title) ? p.getBoolean(showKey(title, KEY_VIVID), global) : global;
    }

    public static void setVivid(Context c, String title, boolean on) {
        SharedPreferences.Editor e = prefs(c).edit().putBoolean(KEY_VIVID, on);
        if (hasShow(title)) e.putBoolean(showKey(title, KEY_VIVID), on);
        e.apply();
    }

    public static int getAudio(Context c, String title) {
        SharedPreferences p = prefs(c);
        int v = hasShow(title) ? p.getInt(showKey(title, KEY_AUDIO), p.getInt(KEY_AUDIO, AUDIO_NORMAL))
                : p.getInt(KEY_AUDIO, AUDIO_NORMAL);
        return v < AUDIO_NORMAL || v > AUDIO_DIALOGUE ? AUDIO_NORMAL : v;
    }

    public static void setAudio(Context c, String title, int mode) {
        SharedPreferences.Editor e = prefs(c).edit().putInt(KEY_AUDIO, mode);
        if (hasShow(title)) e.putInt(showKey(title, KEY_AUDIO), mode);
        e.apply();
    }

    public static boolean getSpatial(Context c, String title) {
        SharedPreferences p = prefs(c);
        boolean global = p.getBoolean(KEY_SPATIAL, false);
        return hasShow(title) ? p.getBoolean(showKey(title, KEY_SPATIAL), global) : global;
    }

    public static void setSpatial(Context c, String title, boolean on) {
        SharedPreferences.Editor e = prefs(c).edit().putBoolean(KEY_SPATIAL, on);
        if (hasShow(title)) e.putBoolean(showKey(title, KEY_SPATIAL), on);
        e.apply();
    }

    // Subtitle look: size 0 small / 1 medium / 2 large, style 0 outline / 1 box / 2 shadow,
    // position 0 low / 1 normal / 2 high. App-wide.
    public static int getSubSize(Context c) { return prefs(c).getInt(KEY_SUB_SIZE, 1); }
    public static int getSubStyle(Context c) { return prefs(c).getInt(KEY_SUB_STYLE, 0); }
    public static int getSubPos(Context c) { return prefs(c).getInt(KEY_SUB_POS, 1); }
    public static void setSubSize(Context c, int v) { prefs(c).edit().putInt(KEY_SUB_SIZE, v).apply(); }
    public static void setSubStyle(Context c, int v) { prefs(c).edit().putInt(KEY_SUB_STYLE, v).apply(); }
    public static void setSubPos(Context c, int v) { prefs(c).edit().putInt(KEY_SUB_POS, v).apply(); }

    /** Applies the saved subtitle size / style / position to a SubtitleView. */
    public static void applySubtitleStyle(Context c, androidx.media3.ui.SubtitleView view) {
        if (view == null) return;
        float[] sizes = {0.045f, 0.058f, 0.075f};
        float[] pos = {0.02f, 0.08f, 0.16f};
        int style = getSubStyle(c);
        androidx.media3.ui.CaptionStyleCompat st;
        if (style == 1) {
            st = new androidx.media3.ui.CaptionStyleCompat(android.graphics.Color.WHITE,
                    android.graphics.Color.argb(190, 0, 0, 0), android.graphics.Color.TRANSPARENT,
                    androidx.media3.ui.CaptionStyleCompat.EDGE_TYPE_NONE, android.graphics.Color.BLACK, null);
        } else if (style == 2) {
            st = new androidx.media3.ui.CaptionStyleCompat(android.graphics.Color.WHITE,
                    android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT,
                    androidx.media3.ui.CaptionStyleCompat.EDGE_TYPE_DROP_SHADOW, android.graphics.Color.BLACK, null);
        } else {
            st = new androidx.media3.ui.CaptionStyleCompat(android.graphics.Color.WHITE,
                    android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT,
                    androidx.media3.ui.CaptionStyleCompat.EDGE_TYPE_OUTLINE, android.graphics.Color.BLACK, null);
        }
        view.setStyle(st);
        view.setFractionalTextSize(sizes[Math.max(0, Math.min(2, getSubSize(c)))]);
        view.setBottomPaddingFraction(pos[Math.max(0, Math.min(2, getSubPos(c)))]);
    }

    // Enhance settings travel with the account (cloud sync): each value is [type, value] so ints,
    // longs, booleans and strings come back as they were. Audio sync offsets stay on the device
    // (they belong to that phone's earbuds).
    public static String exportPrefs(Context c) {
        org.json.JSONObject out = new org.json.JSONObject();
        try {
            for (java.util.Map.Entry<String, ?> e : prefs(c).getAll().entrySet()) {
                if (KEY_STATS.equals(e.getKey())) continue;
                Object v = e.getValue();
                org.json.JSONArray a = new org.json.JSONArray();
                if (v instanceof Boolean) { a.put("b"); a.put(((Boolean) v).booleanValue()); }
                else if (v instanceof Integer) { a.put("i"); a.put(((Integer) v).intValue()); }
                else if (v instanceof Long) { a.put("l"); a.put(((Long) v).longValue()); }
                else if (v instanceof Float) { a.put("f"); a.put(((Float) v).doubleValue()); }
                else if (v instanceof String) { a.put("s"); a.put((String) v); }
                else continue;
                out.put(e.getKey(), a);
            }
        } catch (Exception ignored) { }
        return out.toString();
    }

    public static void importPrefs(Context c, String json) {
        try {
            org.json.JSONObject in = new org.json.JSONObject(json);
            SharedPreferences.Editor ed = prefs(c).edit();
            java.util.Iterator<String> keys = in.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                if (KEY_STATS.equals(k)) continue;
                org.json.JSONArray a = in.optJSONArray(k);
                if (a == null || a.length() < 2) continue;
                switch (a.getString(0)) {
                    case "b": ed.putBoolean(k, a.getBoolean(1)); break;
                    case "i": ed.putInt(k, a.getInt(1)); break;
                    case "l": ed.putLong(k, a.getLong(1)); break;
                    case "f": ed.putFloat(k, (float) a.getDouble(1)); break;
                    case "s": ed.putString(k, a.getString(1)); break;
                    default: break;
                }
            }
            ed.apply();
        } catch (Exception ignored) { }
    }

    /** Manual subtitle timing for a show, in ms (positive = text appears later). Per show only. */
    public static long getSubOffset(Context c, String title) {
        return hasShow(title) ? prefs(c).getLong(showKey(title, "subOffset"), 0L) : 0L;
    }

    public static void setSubOffset(Context c, String title, long ms) {
        if (hasShow(title)) prefs(c).edit().putLong(showKey(title, "subOffset"), ms).apply();
    }

    public static boolean getStats(Context c) { return prefs(c).getBoolean(KEY_STATS, false); }
    public static void setStats(Context c, boolean on) { prefs(c).edit().putBoolean(KEY_STATS, on).apply(); }

    // Filled in on the GL thread the first time an effect is configured.
    private static volatile String gpuName = null;

    private static void captureGpu() {
        if (gpuName != null) return;
        try {
            gpuName = GLES20.glGetString(GLES20.GL_RENDERER);
        } catch (Throwable ignored) { }
    }

    /** One line for error reports: what was switched on, and on what hardware. */
    public static String diagnostics(Context c, boolean animeApp, String title) {
        return "enhance[sharpen=" + getSharpen(c, title) + " glow=" + getAmbient(c, title)
                + " vivid=" + getVivid(c, title) + " audio=" + getAudio(c, title)
                + " spatial=" + getSpatial(c, title) + " bypass=" + bypassed + " disabled=" + disabledForSession
                + " anime=" + animeApp + "] gpu=" + gpuName + " device=" + android.os.Build.MODEL
                + " sdk=" + android.os.Build.VERSION.SDK_INT;
    }

    /** Short status for the stats badge. */
    public static String statusLine(Context c, String title, Live live) {
        if (disabledForSession) return "fx off (failed on this device)";
        if (bypassed) return "fx bypassed";
        return String.format(java.util.Locale.US, "fx sharpen=%s glow=%s vivid=%s  strength %.2f%s",
                getSharpen(c, title) == SHARP_OFF ? "off" : "on", getAmbient(c, title) ? "on" : "off",
                getVivid(c, title) ? "on" : "off", live.strength, live.refine ? "  +refine" : "");
    }

    public static boolean isDisabledForSession() {
        return disabledForSession;
    }

    public static void disableForSession() {
        disabledForSession = true;
    }

    public static boolean ambientActive(Context c, String title) {
        return !disabledForSession && !bypassed && getAmbient(c, title);
    }

    /** Builds the effect chain for the current settings; empty when everything is off. */
    public static List<Effect> buildEffects(Context c, boolean animeApp, Live live, String title) {
        List<Effect> effects = new ArrayList<>();
        if (disabledForSession || bypassed) return effects;
        int sharpen = getSharpen(c, title);
        boolean vivid = getVivid(c, title);
        // Battery saver: the heaviest processing (Anime+) drops to plain Anime.
        boolean saver = powerSaver(c);
        boolean on = sharpen != SHARP_OFF;
        // Anime streams: clean compression noise at source resolution before anything is upscaled ...
        if (on && animeApp) effects.add(new DenoiseEffect(saver));
        // The sharpen stage also hosts the colour grade, so it stays in the chain for "Vivid".
        if (on || vivid) effects.add(new SharpenEffect(sharpen, animeApp, vivid, saver, live));
        // ... and refine the lines again at display resolution, where thinning is cleanest.
        // Each stage decides per stream whether it has anything to do and otherwise just copies.
        if (on && animeApp) effects.add(new RefineEffect(live));
        // Films often carry black bars inside the video itself: only the movie app looks for them.
        if (getAmbient(c, title)) effects.add(new AmbientFillEffect(live, !animeApp));
        return effects;
    }

    // ---------------------------------------------------------------- audio

    /**
     * Boost / Night audio on the player's audio session (system audio effects, no decoding work).
     * Any failure just leaves the audio untouched.
     */
    public static final class AudioFx {
        private android.media.audiofx.LoudnessEnhancer loudness;
        private android.media.audiofx.DynamicsProcessing dynamics;
        private android.media.audiofx.Virtualizer virtualizer;
        private final int mode;
        private final boolean spatial;

        public AudioFx(int mode, boolean spatial) {
            this.mode = mode;
            this.spatial = spatial;
        }

        public boolean wanted() {
            return mode != AUDIO_NORMAL || spatial;
        }

        public void attach(int sessionId) {
            if (!wanted() || sessionId == 0 || sessionId == -1) return;   // C.AUDIO_SESSION_ID_UNSET is 0
            release();
            try {
                if (mode == AUDIO_BOOST) {
                    loudness = new android.media.audiofx.LoudnessEnhancer(sessionId);
                    loudness.setTargetGain(500);   // +5 dB, in millibels
                    loudness.setEnabled(true);
                } else if (mode == AUDIO_NIGHT && android.os.Build.VERSION.SDK_INT >= 28) {
                    // Night: a limiter used as a compressor (squash loud scenes) with make-up gain.
                    android.media.audiofx.DynamicsProcessing.Config cfg =
                            new android.media.audiofx.DynamicsProcessing.Config.Builder(
                                    android.media.audiofx.DynamicsProcessing.VARIANT_FAVOR_FREQUENCY_RESOLUTION,
                                    2, false, 0, false, 0, false, 0, true).build();
                    dynamics = new android.media.audiofx.DynamicsProcessing(0, sessionId, cfg);
                    for (int ch = 0; ch < 2; ch++) {
                        dynamics.setLimiterByChannelIndex(ch, new android.media.audiofx.DynamicsProcessing.Limiter(
                                true, true, 0, 5f, 120f, 4f, -26f, 9f));
                    }
                    dynamics.setEnabled(true);
                } else if (mode == AUDIO_DIALOGUE && android.os.Build.VERSION.SDK_INT >= 28) {
                    // Dialogue: trim rumble, lift the speech band (1.5-4.5 kHz), keep peaks in check.
                    android.media.audiofx.DynamicsProcessing.Config cfg =
                            new android.media.audiofx.DynamicsProcessing.Config.Builder(
                                    android.media.audiofx.DynamicsProcessing.VARIANT_FAVOR_FREQUENCY_RESOLUTION,
                                    2, true, 4, false, 0, false, 0, true).build();
                    dynamics = new android.media.audiofx.DynamicsProcessing(0, sessionId, cfg);
                    float[] cutoff = {250f, 1500f, 4500f, 20000f};
                    float[] gain = {-2f, 2f, 4f, 0f};
                    for (int ch = 0; ch < 2; ch++) {
                        for (int b = 0; b < 4; b++) {
                            dynamics.setPreEqBandByChannelIndex(ch, b,
                                    new android.media.audiofx.DynamicsProcessing.EqBand(true, cutoff[b], gain[b]));
                        }
                        dynamics.setLimiterByChannelIndex(ch, new android.media.audiofx.DynamicsProcessing.Limiter(
                                true, true, 0, 1f, 60f, 10f, -1f, 0f));
                    }
                    dynamics.setEnabled(true);
                }
            } catch (Throwable t) {
                try { if (loudness != null) loudness.release(); } catch (Throwable ignored) { }
                try { if (dynamics != null) dynamics.release(); } catch (Throwable ignored) { }
                loudness = null;
                dynamics = null;
            }
            if (spatial) {
                try {
                    virtualizer = new android.media.audiofx.Virtualizer(0, sessionId);
                    if (virtualizer.getStrengthSupported()) virtualizer.setStrength((short) 650);
                    virtualizer.setEnabled(true);
                } catch (Throwable t) {
                    try { if (virtualizer != null) virtualizer.release(); } catch (Throwable ignored) { }
                    virtualizer = null;
                }
            }
        }

        public void release() {
            try { if (loudness != null) loudness.release(); } catch (Throwable ignored) { }
            try { if (dynamics != null) dynamics.release(); } catch (Throwable ignored) { }
            try { if (virtualizer != null) virtualizer.release(); } catch (Throwable ignored) { }
            loudness = null;
            dynamics = null;
            virtualizer = null;
        }
    }

    // ---------------------------------------------------------------- shared GL bits

    private static final String VERTEX_SHADER =
            "attribute vec4 aFramePosition;\n"
            + "varying vec2 vTexSamplingCoord;\n"
            + "void main() {\n"
            + "  gl_Position = aFramePosition;\n"
            + "  vTexSamplingCoord = aFramePosition.xy * 0.5 + 0.5;\n"
            + "}\n";

    private static GlProgram newProgram(String fragment) throws VideoFrameProcessingException {
        try {
            GlProgram p = new GlProgram(VERTEX_SHADER, fragment);
            p.setBufferAttribute("aFramePosition", GlUtil.getNormalizedCoordinateBounds(),
                    GlUtil.HOMOGENEOUS_COORDINATE_VECTOR_SIZE);
            return p;
        } catch (GlUtil.GlException e) {
            throw new VideoFrameProcessingException(e);
        }
    }

    private static int even(float v) {
        int i = Math.max(2, Math.round(v));
        return i & ~1;
    }

    // ---------------------------------------------------------------- sharpening

    private static final String SHARPEN_FRAGMENT =
            "precision highp float;\n"
            + "uniform sampler2D uTexSampler;\n"
            + "uniform vec2 uInSize;\n"
            + "uniform vec2 uTexel;\n"
            + "uniform float uPlain;\n"
            + "uniform float uAmount;\n"
            + "uniform float uDark;\n"
            + "uniform float uThin;\n"
            + "uniform float uCore;\n"
            + "uniform float uVivid;\n"
            + "uniform float uDeblock;\n"
            + "varying vec2 vTexSamplingCoord;\n"
            + "vec3 gMin;\n"
            + "vec3 gMax;\n"
            + "vec3 tap(vec2 uv) { return texture2D(uTexSampler, uv).rgb; }\n"
            + "float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }\n"
            // Optional "vivid" grade for washed-out sources, plus sub-step dither that hides the
            // banding low-bitrate streams show in flat gradients (sky, skin, backgrounds).
            + "vec3 finish(vec3 c) {\n"
            + "  if (uVivid > 0.5) {\n"
            + "    c = mix(vec3(lum(c)), c, 1.16);\n"
            + "    c = (c - 0.5) * 1.05 + 0.5;\n"
            + "  }\n"
            + "  float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));\n"
            + "  c += (n - 0.5) / 255.0;\n"
            + "  return clamp(c, 0.0, 1.0);\n"
            + "}\n"
            // Catmull-Rom bicubic in 9 bilinear taps; also records the 2x2 neighbourhood range.
            + "vec3 bicubic(vec2 uv) {\n"
            + "  vec2 pos = uv * uInSize;\n"
            + "  vec2 c = floor(pos - 0.5) + 0.5;\n"
            + "  vec2 f = pos - c;\n"
            + "  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));\n"
            + "  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);\n"
            + "  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));\n"
            + "  vec2 w3 = f * f * (-0.5 + 0.5 * f);\n"
            + "  vec2 w12 = w1 + w2;\n"
            + "  vec2 p0 = (c - 1.0) * uTexel;\n"
            + "  vec2 p3 = (c + 2.0) * uTexel;\n"
            + "  vec2 p12 = (c + w2 / w12) * uTexel;\n"
            + "  vec3 col = tap(vec2(p0.x, p0.y)) * w0.x * w0.y\n"
            + "           + tap(vec2(p12.x, p0.y)) * w12.x * w0.y\n"
            + "           + tap(vec2(p3.x, p0.y)) * w3.x * w0.y\n"
            + "           + tap(vec2(p0.x, p12.y)) * w0.x * w12.y\n"
            + "           + tap(vec2(p12.x, p12.y)) * w12.x * w12.y\n"
            + "           + tap(vec2(p3.x, p12.y)) * w3.x * w12.y\n"
            + "           + tap(vec2(p0.x, p3.y)) * w0.x * w3.y\n"
            + "           + tap(vec2(p12.x, p3.y)) * w12.x * w3.y\n"
            + "           + tap(vec2(p3.x, p3.y)) * w3.x * w3.y;\n"
            + "  vec3 a = tap(c * uTexel);\n"
            + "  vec3 b = tap((c + vec2(1.0, 0.0)) * uTexel);\n"
            + "  vec3 d = tap((c + vec2(0.0, 1.0)) * uTexel);\n"
            + "  vec3 e = tap((c + vec2(1.0, 1.0)) * uTexel);\n"
            + "  gMin = min(min(a, b), min(d, e));\n"
            + "  gMax = max(max(a, b), max(d, e));\n"
            + "  return col;\n"
            + "}\n"
            // Moves the sample toward the brighter side of an edge: dark strokes get thinner.
            + "vec2 thinWarp(vec2 uv) {\n"
            + "  float lx = lum(tap(uv + vec2(uTexel.x, 0.0))) - lum(tap(uv - vec2(uTexel.x, 0.0)));\n"
            + "  float ly = lum(tap(uv + vec2(0.0, uTexel.y))) - lum(tap(uv - vec2(0.0, uTexel.y)));\n"
            + "  vec2 g = vec2(lx, ly);\n"
            + "  float m = length(g);\n"
            + "  float k = smoothstep(0.03, 0.30, m);\n"
            + "  return uv + (g / (m + 0.0001)) * k * uThin * uTexel;\n"
            + "}\n"
            + "void main() {\n"
            + "  vec2 uv = vTexSamplingCoord;\n"
            + "  if (uPlain > 0.5) { gl_FragColor = vec4(finish(tap(uv)), 1.0); return; }\n"
            + "  vec2 w = uv;\n"
            + "  if (uThin > 0.0) w = thinWarp(uv);\n"
            + "  vec3 base = bicubic(w);\n"
            + "  vec2 r = uTexel * 0.75;\n"
            + "  vec3 low = 0.25 * (tap(w + vec2(r.x, r.y)) + tap(w + vec2(-r.x, r.y))\n"
            + "                   + tap(w + vec2(r.x, -r.y)) + tap(w + vec2(-r.x, -r.y)));\n"
            + "  float dl = lum(base - low);\n"
            + "  float cored = sign(dl) * max(abs(dl) - uCore, 0.0);\n"
            + "  float gain = uAmount * (dl < 0.0 ? 1.0 + uDark : 1.0);\n"
            + "  vec3 o = base + vec3(cored * gain);\n"
            + "  o = clamp(o, gMin - 0.02, gMax + 0.02);\n"
            // Deblock: in dark, flat areas (where compression blocks show most) blend toward the low-pass.
            + "  float dk = (1.0 - smoothstep(0.06, 0.32, lum(base)))\n"
            + "           * (1.0 - smoothstep(0.02, 0.07, lum(gMax) - lum(gMin))) * uDeblock;\n"
            + "  o = mix(o, low, dk * 0.6);\n"
            + "  gl_FragColor = vec4(finish(clamp(o, 0.0, 1.0)), 1.0);\n"
            + "}\n";

    private static final class SharpenEffect implements GlEffect {
        private final int mode;
        private final boolean animeApp;
        private final boolean vivid;
        private final boolean saver;
        private final Live live;

        SharpenEffect(int mode, boolean animeApp, boolean vivid, boolean saver, Live live) {
            this.mode = mode;
            this.animeApp = animeApp;
            this.vivid = vivid;
            this.saver = saver;
            this.live = live;
        }

        @Override
        public GlShaderProgram toGlShaderProgram(Context context, boolean useHdr)
                throws VideoFrameProcessingException {
            return new SharpenProgram(mode, animeApp, vivid, saver, live, useHdr);
        }
    }

    private static final class SharpenProgram extends BaseGlShaderProgram {
        private final GlProgram program;
        private final int mode;
        private final boolean animeApp;
        private final boolean vivid;
        private final boolean saver;
        private final Live live;
        private int inW = 1;
        private int inH = 1;
        // Resolved per stream in configure().
        private boolean plain = true;
        private float amount;
        private float dark;
        private float thin;
        private float core;
        private float deblock;
        private final boolean hdr;

        SharpenProgram(int mode, boolean animeApp, boolean vivid, boolean saver, Live live, boolean useHdr)
                throws VideoFrameProcessingException {
            super(useHdr, 1);
            this.mode = mode;
            this.animeApp = animeApp;
            this.vivid = vivid;
            this.saver = saver;
            this.hdr = useHdr;
            this.live = live;
            this.program = newProgram(SHARPEN_FRAGMENT);
        }

        private int resolve(int height) {
            return mode == SHARP_OFF ? SHARP_OFF : autoLevel(animeApp, saver, height);
        }

        @Override
        public Size configure(int inputWidth, int inputHeight) throws VideoFrameProcessingException {
            inW = Math.max(1, inputWidth);
            inH = Math.max(1, inputHeight);
            captureGpu();
            int level = resolve(inH);
            // HDR (PQ/HLG) frames pass through untouched: the filters and grade are tuned for SDR.
            if (hdr) level = SHARP_OFF;
            live.refine = level == LVL_ANIME_PLUS;
            // Strong enough to see on soft sources, gentle on already-crisp ones.
            float softness = inH <= 576 ? 1f : inH <= 720 ? 0.85f : inH <= 1080 ? 0.55f : 0.3f;
            plain = false;
            switch (level) {
                case LVL_ANIME_PLUS:
                    amount = 1.0f * softness + 0.15f;
                    dark = 0.6f;
                    thin = inH <= 1080 ? 0.20f * softness + 0.04f : 0f;
                    core = 0.010f;
                    break;
                case LVL_ANIME:
                    amount = 0.85f * softness + 0.1f;
                    dark = 0.45f;
                    thin = inH <= 1080 ? 0.30f * softness + 0.05f : 0f;
                    core = 0.012f;
                    break;
                case LVL_SHARP:
                    amount = 0.55f * softness + 0.05f;
                    dark = 0f;
                    thin = 0f;
                    core = 0.008f;
                    break;
                default:
                    plain = true;
                    amount = dark = thin = core = 0f;
                    deblock = 0f;
            }
            deblock = plain ? 0f : 1f;
            if (plain) return new Size(inW, inH);
            // Upscale (never down) to what the screen can show, so the sharpening works at display
            // resolution instead of after the system stretches a soft frame.
            float s = Math.min(live.viewW / (float) inW, live.viewH / (float) inH);
            if (s < 1.08f) s = 1f;
            s = Math.min(s, 4f);
            while (s > 1f && (double) inW * s * inH * s > 8_300_000d) s *= 0.9f;
            if (s <= 1f) return new Size(inW, inH);
            return new Size(even(inW * s), even(inH * s));
        }

        @Override
        public void drawFrame(int inputTexId, long presentationTimeUs)
                throws VideoFrameProcessingException {
            try {
                program.use();
                program.setSamplerTexIdUniform("uTexSampler", inputTexId, 0);
                program.setFloatsUniform("uInSize", new float[] {inW, inH});
                program.setFloatsUniform("uTexel", new float[] {1f / inW, 1f / inH});
                program.setFloatUniform("uPlain", plain ? 1f : 0f);
                float strength = Math.max(0.6f, Math.min(1.4f, live.strength));
                program.setFloatUniform("uAmount", amount * strength);
                program.setFloatUniform("uDeblock", deblock * Math.min(1.3f, strength));
                program.setFloatUniform("uDark", dark);
                program.setFloatUniform("uThin", thin);
                program.setFloatUniform("uCore", core);
                program.setFloatUniform("uVivid", vivid && !hdr ? 1f : 0f);
                program.bindAttributesAndUniforms();
                GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
                GlUtil.checkGlError();
            } catch (GlUtil.GlException e) {
                throw new VideoFrameProcessingException(e, presentationTimeUs);
            }
        }

        @Override
        public void release() throws VideoFrameProcessingException {
            super.release();
            try {
                program.delete();
            } catch (GlUtil.GlException e) {
                throw new VideoFrameProcessingException(e);
            }
        }
    }

    // ---------------------------------------------------------------- denoise (Anime+)

    // Edge-preserving 5x5 bilateral filter: flattens block and mosquito noise but keeps outlines,
    // because a pixel across a strong edge gets almost no weight.
    private static final String DENOISE_FRAGMENT =
            "precision highp float;\n"
            + "uniform sampler2D uTexSampler;\n"
            + "uniform vec2 uTexel;\n"
            + "uniform float uActive;\n"
            + "varying vec2 vTexSamplingCoord;\n"
            + "void main() {\n"
            + "  vec2 uv = vTexSamplingCoord;\n"
            + "  vec3 c = texture2D(uTexSampler, uv).rgb;\n"
            + "  if (uActive < 0.5) { gl_FragColor = vec4(c, 1.0); return; }\n"
            + "  vec3 sum = vec3(0.0);\n"
            + "  float wsum = 0.0;\n"
            + "  for (int i = -2; i <= 2; i++) {\n"
            + "    for (int j = -2; j <= 2; j++) {\n"
            + "      vec2 o = vec2(float(i), float(j));\n"
            + "      vec3 s = texture2D(uTexSampler, uv + o * uTexel).rgb;\n"
            + "      vec3 d = s - c;\n"
            + "      float w = exp(-dot(o, o) / 4.5) * exp(-dot(d, d) / 0.0072);\n"
            + "      sum += s * w;\n"
            + "      wsum += w;\n"
            + "    }\n"
            + "  }\n"
            + "  gl_FragColor = vec4(sum / wsum, 1.0);\n"
            + "}\n";

    private static final class DenoiseEffect implements GlEffect {
        private final boolean saver;

        DenoiseEffect(boolean saver) {
            this.saver = saver;
        }

        @Override
        public GlShaderProgram toGlShaderProgram(Context context, boolean useHdr)
                throws VideoFrameProcessingException {
            return new DenoiseProgram(saver, useHdr);
        }
    }

    private static final class DenoiseProgram extends BaseGlShaderProgram {
        private final GlProgram program;
        private final boolean saver;
        private final boolean hdr;
        private boolean active = false;
        private int inW = 1;
        private int inH = 1;

        DenoiseProgram(boolean saver, boolean useHdr) throws VideoFrameProcessingException {
            super(useHdr, 1);
            this.saver = saver;
            this.hdr = useHdr;
            this.program = newProgram(DENOISE_FRAGMENT);
        }

        @Override
        public Size configure(int inputWidth, int inputHeight) {
            inW = Math.max(1, inputWidth);
            inH = Math.max(1, inputHeight);
            active = !hdr && autoLevel(true, saver, inH) == LVL_ANIME_PLUS;
            return new Size(inW, inH);
        }

        @Override
        public void drawFrame(int inputTexId, long presentationTimeUs)
                throws VideoFrameProcessingException {
            try {
                program.use();
                program.setSamplerTexIdUniform("uTexSampler", inputTexId, 0);
                program.setFloatsUniform("uTexel", new float[] {1f / inW, 1f / inH});
                program.setFloatUniform("uActive", active ? 1f : 0f);
                program.bindAttributesAndUniforms();
                GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
                GlUtil.checkGlError();
            } catch (GlUtil.GlException e) {
                throw new VideoFrameProcessingException(e, presentationTimeUs);
            }
        }

        @Override
        public void release() throws VideoFrameProcessingException {
            super.release();
            try {
                program.delete();
            } catch (GlUtil.GlException e) {
                throw new VideoFrameProcessingException(e);
            }
        }
    }

    // ---------------------------------------------------------------- refine (Anime+)

    // Runs on the upscaled frame: finds edges with a Sobel on luma, nudges each pixel toward the
    // brighter side of the edge (dark strokes get thinner and crisper than at source resolution),
    // and clamps to the 3x3 neighbourhood so nothing overshoots.
    private static final String REFINE_FRAGMENT =
            "precision highp float;\n"
            + "uniform sampler2D uTexSampler;\n"
            + "uniform vec2 uTexel;\n"
            + "uniform float uStep;\n"
            + "uniform float uPull;\n"
            + "uniform float uActive;\n"
            + "varying vec2 vTexSamplingCoord;\n"
            + "vec3 tap(vec2 uv) { return texture2D(uTexSampler, uv).rgb; }\n"
            + "float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }\n"
            + "void main() {\n"
            + "  vec2 uv = vTexSamplingCoord;\n"
            + "  if (uActive < 0.5) { gl_FragColor = vec4(tap(uv), 1.0); return; }\n"
            + "  vec2 s = uTexel * uStep;\n"
            + "  vec3 c00 = tap(uv + vec2(-s.x, -s.y));\n"
            + "  vec3 c10 = tap(uv + vec2(0.0, -s.y));\n"
            + "  vec3 c20 = tap(uv + vec2(s.x, -s.y));\n"
            + "  vec3 c01 = tap(uv + vec2(-s.x, 0.0));\n"
            + "  vec3 c11 = tap(uv);\n"
            + "  vec3 c21 = tap(uv + vec2(s.x, 0.0));\n"
            + "  vec3 c02 = tap(uv + vec2(-s.x, s.y));\n"
            + "  vec3 c12 = tap(uv + vec2(0.0, s.y));\n"
            + "  vec3 c22 = tap(uv + vec2(s.x, s.y));\n"
            + "  float gx = (lum(c20) + 2.0 * lum(c21) + lum(c22)) - (lum(c00) + 2.0 * lum(c01) + lum(c02));\n"
            + "  float gy = (lum(c02) + 2.0 * lum(c12) + lum(c22)) - (lum(c00) + 2.0 * lum(c10) + lum(c20));\n"
            + "  vec2 g = vec2(gx, gy) * 0.25;\n"
            + "  float m = length(g);\n"
            + "  float k = smoothstep(0.04, 0.28, m);\n"
            + "  vec3 w = tap(uv + (g / (m + 0.0001)) * k * uPull * s);\n"
            + "  vec3 lo = min(min(min(c00, c10), min(c20, c01)), min(min(c11, c21), min(c02, min(c12, c22))));\n"
            + "  vec3 hi = max(max(max(c00, c10), max(c20, c01)), max(max(c11, c21), max(c02, max(c12, c22))));\n"
            + "  gl_FragColor = vec4(clamp(w, lo, hi), 1.0);\n"
            + "}\n";

    private static final class RefineEffect implements GlEffect {
        private final Live live;

        RefineEffect(Live live) {
            this.live = live;
        }

        @Override
        public GlShaderProgram toGlShaderProgram(Context context, boolean useHdr)
                throws VideoFrameProcessingException {
            return new RefineProgram(live, useHdr);
        }
    }

    private static final class RefineProgram extends BaseGlShaderProgram {
        private final GlProgram program;
        private final Live live;
        private boolean active = false;
        private int inW = 1;
        private int inH = 1;
        private float step = 1f;

        RefineProgram(Live live, boolean useHdr) throws VideoFrameProcessingException {
            super(useHdr, 1);
            this.live = live;
            this.program = newProgram(REFINE_FRAGMENT);
        }

        @Override
        public Size configure(int inputWidth, int inputHeight) {
            inW = Math.max(1, inputWidth);
            inH = Math.max(1, inputHeight);
            // Anime sources are mostly 480-720 lines: the bigger the upscale, the wider a source line
            // is in pixels, so the edge probe (and the pull) scale with the frame height.
            step = Math.max(1f, Math.min(3f, inH / 540f));
            active = live.refine;   // set by the sharpen stage just upstream, for this very stream
            return new Size(inW, inH);
        }

        @Override
        public void drawFrame(int inputTexId, long presentationTimeUs)
                throws VideoFrameProcessingException {
            try {
                program.use();
                program.setSamplerTexIdUniform("uTexSampler", inputTexId, 0);
                program.setFloatsUniform("uTexel", new float[] {1f / inW, 1f / inH});
                program.setFloatUniform("uStep", step);
                program.setFloatUniform("uPull", 0.55f);
                program.setFloatUniform("uActive", active ? 1f : 0f);
                program.bindAttributesAndUniforms();
                GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
                GlUtil.checkGlError();
            } catch (GlUtil.GlException e) {
                throw new VideoFrameProcessingException(e, presentationTimeUs);
            }
        }

        @Override
        public void release() throws VideoFrameProcessingException {
            super.release();
            try {
                program.delete();
            } catch (GlUtil.GlException e) {
                throw new VideoFrameProcessingException(e);
            }
        }
    }

    // ---------------------------------------------------------------- ambient fill

    // Box-filters the source into a smaller texture: each output pixel averages a 6x6 grid of its
    // block (bilinear taps overlap, so no source pixel is skipped and nothing shimmers).
    private static final String DOWNSAMPLE_FRAGMENT =
            "precision highp float;\n"
            + "uniform sampler2D uTexSampler;\n"
            + "uniform vec2 uBlock;\n"
            + "varying vec2 vTexSamplingCoord;\n"
            + "void main() {\n"
            + "  vec3 s = vec3(0.0);\n"
            + "  for (int i = 0; i < 6; i++) {\n"
            + "    for (int j = 0; j < 6; j++) {\n"
            + "      vec2 o = (vec2(float(i), float(j)) + 0.5) / 6.0 - 0.5;\n"
            + "      s += texture2D(uTexSampler, vTexSamplingCoord + o * uBlock).rgb;\n"
            + "    }\n"
            + "  }\n"
            + "  gl_FragColor = vec4(s / 36.0, 1.0);\n"
            + "}\n";

    // One direction of a wide separable gaussian (9 taps, 1.5 texels apart).
    private static final String BLUR_FRAGMENT =
            "precision highp float;\n"
            + "uniform sampler2D uTexSampler;\n"
            + "uniform vec2 uStep;\n"
            + "varying vec2 vTexSamplingCoord;\n"
            + "void main() {\n"
            + "  vec3 s = vec3(0.0);\n"
            + "  float wsum = 0.0;\n"
            + "  for (int k = -4; k <= 4; k++) {\n"
            + "    float d = float(k);\n"
            + "    float w = exp(-d * d / 12.5);\n"
            + "    s += texture2D(uTexSampler, vTexSamplingCoord + uStep * d * 1.5).rgb * w;\n"
            + "    wsum += w;\n"
            + "  }\n"
            + "  gl_FragColor = vec4(s / wsum, 1.0);\n"
            + "}\n";

    private static final String FILL_FRAGMENT =
            "precision highp float;\n"
            + "uniform sampler2D uTexSampler;\n"
            + "uniform sampler2D uLow;\n"
            + "uniform vec2 uLo;\n"
            + "uniform vec2 uHi;\n"
            + "uniform vec2 uCoverLo;\n"
            + "uniform vec2 uCoverHi;\n"
            + "uniform vec2 uOutSize;\n"
            + "uniform vec2 uLowSize;\n"
            + "uniform vec2 uLowTexel;\n"
            + "uniform vec4 uContent;\n"
            + "uniform float uDim;\n"
            + "varying vec2 vTexSamplingCoord;\n"
            + "vec3 lowTap(vec2 uv) { return texture2D(uLow, uv).rgb; }\n"
            // Catmull-Rom over the already-blurred texture: smooth, no bilinear diamonds.
            + "vec3 lowCubic(vec2 uv) {\n"
            + "  vec2 pos = uv * uLowSize;\n"
            + "  vec2 c = floor(pos - 0.5) + 0.5;\n"
            + "  vec2 f = pos - c;\n"
            + "  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));\n"
            + "  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);\n"
            + "  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));\n"
            + "  vec2 w3 = f * f * (-0.5 + 0.5 * f);\n"
            + "  vec2 w12 = w1 + w2;\n"
            + "  vec2 p0 = (c - 1.0) * uLowTexel;\n"
            + "  vec2 p3 = (c + 2.0) * uLowTexel;\n"
            + "  vec2 p12 = (c + w2 / w12) * uLowTexel;\n"
            + "  return lowTap(vec2(p0.x, p0.y)) * w0.x * w0.y\n"
            + "       + lowTap(vec2(p12.x, p0.y)) * w12.x * w0.y\n"
            + "       + lowTap(vec2(p3.x, p0.y)) * w3.x * w0.y\n"
            + "       + lowTap(vec2(p0.x, p12.y)) * w0.x * w12.y\n"
            + "       + lowTap(vec2(p12.x, p12.y)) * w12.x * w12.y\n"
            + "       + lowTap(vec2(p3.x, p12.y)) * w3.x * w12.y\n"
            + "       + lowTap(vec2(p0.x, p3.y)) * w0.x * w3.y\n"
            + "       + lowTap(vec2(p12.x, p3.y)) * w12.x * w3.y\n"
            + "       + lowTap(vec2(p3.x, p3.y)) * w3.x * w3.y;\n"
            + "}\n"
            + "void main() {\n"
            + "  vec2 uv = vTexSamplingCoord;\n"
            // Background: the frame zoomed to cover the screen, heavily blurred.
            + "  vec2 bq = clamp((uv - uCoverLo) / (uCoverHi - uCoverLo), 0.0, 1.0);\n"
            + "  vec3 bg = max(lowCubic(mix(uContent.xy, uContent.zw, bq)), 0.0);\n"
            + "  float l = dot(bg, vec3(0.299, 0.587, 0.114));\n"
            + "  bg = mix(vec3(l), bg, 1.2) * uDim;\n"
            + "  vec2 p = uv - 0.5;\n"
            + "  bg *= 1.0 - 0.45 * dot(p, p);\n"
            // Sharp picture, anti-aliased against the rect edge.
            + "  vec2 q = clamp((uv - uLo) / (uHi - uLo), 0.0, 1.0);\n"
            + "  vec3 fg = texture2D(uTexSampler, mix(uContent.xy, uContent.zw, q)).rgb;\n"
            + "  float edge = min(min(uv.x - uLo.x, uHi.x - uv.x) * uOutSize.x,\n"
            + "                   min(uv.y - uLo.y, uHi.y - uv.y) * uOutSize.y);\n"
            + "  vec3 c = mix(bg, fg, clamp(edge, 0.0, 1.0));\n"
            // Sub-step dither so the dark gradient does not band (about half an 8-bit step).
            + "  float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));\n"
            + "  c += (n - 0.5) / 255.0;\n"
            + "  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);\n"
            + "}\n";

    private static final class AmbientFillEffect implements GlEffect {
        private final Live live;
        private final boolean detectBars;

        AmbientFillEffect(Live live, boolean detectBars) {
            this.live = live;
            this.detectBars = detectBars;
        }

        @Override
        public GlShaderProgram toGlShaderProgram(Context context, boolean useHdr)
                throws VideoFrameProcessingException {
            return new AmbientFillProgram(live, detectBars, useHdr);
        }
    }

    private static final class AmbientFillProgram extends BaseGlShaderProgram {
        // Blur chain: source -> A (256 wide) -> B (64 wide) -> C -> B, gaussian-blurred at 64 wide.
        private static final int A_W = 256;
        private static final int B_W = 64;

        private final GlProgram fill;
        private final GlProgram down;
        private final GlProgram blur;
        private final Live live;
        private final boolean detectBars;
        // Visible part of the video in its own UV space (bars baked into films get cropped away).
        private final float[] content = {0f, 0f, 1f, 1f};
        private final float[] contentTarget = {0f, 0f, 1f, 1f};
        private float minTop = 1f, minBottom = 1f, minLeft = 1f, minRight = 1f;
        private int barSamples = 0;
        private int frameCount = 0;
        private java.nio.ByteBuffer pixels;
        private int inW = 1;
        private int inH = 1;
        private int outW = 1;
        private int outH = 1;
        private int aW = A_W, aH = 144, bW = B_W, bH = 36;
        private int texA = -1, fboA = -1, texB = -1, fboB = -1, texC = -1, fboC = -1;
        private final int[] savedFbo = new int[1];
        private final int[] savedViewport = new int[4];

        AmbientFillProgram(Live live, boolean detectBars, boolean useHdr) throws VideoFrameProcessingException {
            super(useHdr, 1);
            this.live = live;
            this.detectBars = detectBars;
            this.fill = newProgram(FILL_FRAGMENT);
            this.down = newProgram(DOWNSAMPLE_FRAGMENT);
            this.blur = newProgram(BLUR_FRAGMENT);
        }

        @Override
        public Size configure(int inputWidth, int inputHeight) throws VideoFrameProcessingException {
            inW = Math.max(1, inputWidth);
            inH = Math.max(1, inputHeight);
            captureGpu();
            float screen = live.fullAspect > 0f ? live.fullAspect : live.viewAspect;
            float video = inW / (float) inH;
            // A new stream (or rendition) starts the bar search over.
            for (int i = 0; i < 4; i++) { content[i] = i < 2 ? 0f : 1f; contentTarget[i] = content[i]; }
            minTop = minBottom = minLeft = minRight = 1f;
            barSamples = 0;
            frameCount = 0;
            // Output has the screen's shape and keeps the picture's resolution along its long side.
            if (screen > video * 1.01f) {
                outH = inH;
                outW = even(inH * screen);
            } else if (screen < video / 1.01f) {
                outW = inW;
                outH = even(inW / screen);
            } else {
                outW = inW;
                outH = inH;
            }
            if (outW > 4096) {
                float k = 4096f / outW;
                outW = even(outW * k);
                outH = even(outH * k);
            }
            aW = A_W;
            aH = Math.max(16, Math.min(512, Math.round(A_W / video)));
            bW = B_W;
            bH = Math.max(8, Math.min(256, Math.round(B_W / video)));
            pixels = detectBars ? java.nio.ByteBuffer.allocateDirect(aW * aH * 4) : null;
            try {
                releaseLow();
                texA = GlUtil.createTexture(aW, aH, /* useHighPrecisionColorComponents= */ false);
                fboA = GlUtil.createFboForTexture(texA);
                texB = GlUtil.createTexture(bW, bH, false);
                fboB = GlUtil.createFboForTexture(texB);
                texC = GlUtil.createTexture(bW, bH, false);
                fboC = GlUtil.createFboForTexture(texC);
            } catch (GlUtil.GlException e) {
                throw new VideoFrameProcessingException(e);
            }
            return new Size(outW, outH);
        }

        private void releaseLow() throws GlUtil.GlException {
            if (fboA != -1) GlUtil.deleteFbo(fboA);
            if (fboB != -1) GlUtil.deleteFbo(fboB);
            if (fboC != -1) GlUtil.deleteFbo(fboC);
            if (texA != -1) GlUtil.deleteTexture(texA);
            if (texB != -1) GlUtil.deleteTexture(texB);
            if (texC != -1) GlUtil.deleteTexture(texC);
            fboA = fboB = fboC = texA = texB = texC = -1;
        }

        private void pass(GlProgram p, int srcTex, int dstFbo, int w, int h, String uniform, float ux, float uy)
                throws GlUtil.GlException {
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, dstFbo);
            GLES20.glViewport(0, 0, w, h);
            p.use();
            p.setSamplerTexIdUniform("uTexSampler", srcTex, 0);
            p.setFloatsUniform(uniform, new float[] {ux, uy});
            p.bindAttributesAndUniforms();
            GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
        }

        @Override
        public void drawFrame(int inputTexId, long presentationTimeUs)
                throws VideoFrameProcessingException {
            try {
                // Rects in output UV space for the live view shape and fit mode.
                float a = live.viewAspect > 0f ? live.viewAspect : (float) outW / outH;
                // Aspect of the visible picture (bars cropped), not of the raw frame.
                float v = (inW / (float) inH) * ((content[2] - content[0]) / Math.max(0.05f, content[3] - content[1]));
                float[] fit = fitRect(a, v, FIT);
                float[] cover = fitRect(a, v, CROP);
                float[] r = live.fitMode == CROP ? cover : live.fitMode == FILL
                        ? new float[] {0f, 0f, 1f, 1f} : fit;

                // Blur chain renders into our own small FBOs; remember the real output target.
                GLES20.glGetIntegerv(GLES20.GL_FRAMEBUFFER_BINDING, savedFbo, 0);
                GLES20.glGetIntegerv(GLES20.GL_VIEWPORT, savedViewport, 0);
                pass(down, inputTexId, fboA, aW, aH, "uBlock", 1f / aW, 1f / aH);
                if (detectBars) {
                    if (frameCount++ % 10 == 0) sampleBars();
                    for (int i = 0; i < 4; i++) content[i] += (contentTarget[i] - content[i]) * 0.06f;
                }
                pass(down, texA, fboB, bW, bH, "uBlock", 1f / bW, 1f / bH);
                pass(blur, texB, fboC, bW, bH, "uStep", 1f / bW, 0f);
                pass(blur, texC, fboB, bW, bH, "uStep", 0f, 1f / bH);

                // Final pass: the frame itself.
                GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, savedFbo[0]);
                GLES20.glViewport(savedViewport[0], savedViewport[1], savedViewport[2], savedViewport[3]);
                fill.use();
                fill.setSamplerTexIdUniform("uTexSampler", inputTexId, 0);
                fill.setSamplerTexIdUniform("uLow", texB, 1);
                fill.setFloatsUniform("uLo", new float[] {r[0], r[1]});
                fill.setFloatsUniform("uHi", new float[] {r[2], r[3]});
                fill.setFloatsUniform("uCoverLo", new float[] {cover[0], cover[1]});
                fill.setFloatsUniform("uCoverHi", new float[] {cover[2], cover[3]});
                fill.setFloatsUniform("uOutSize", new float[] {outW, outH});
                fill.setFloatsUniform("uLowSize", new float[] {bW, bH});
                fill.setFloatsUniform("uLowTexel", new float[] {1f / bW, 1f / bH});
                fill.setFloatsUniform("uContent", new float[] {content[0], content[1], content[2], content[3]});
                fill.setFloatUniform("uDim", 0.55f);
                fill.bindAttributesAndUniforms();
                GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
                GlUtil.checkGlError();
            } catch (GlUtil.GlException e) {
                throw new VideoFrameProcessingException(e, presentationTimeUs);
            }
        }

        /**
         * Looks for black bars baked into the video, using the small box-filtered copy (fboA is still
         * bound). Only ever shrinks the estimate over time, so dark scenes (which look like wide bars)
         * cannot crop real picture: a true bar is black in every frame, a dark scene is not.
         */
        private void sampleBars() {
            try {
                pixels.clear();
                GLES20.glReadPixels(0, 0, aW, aH, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, pixels);
                int[] rowMax = new int[aH];
                int[] colMax = new int[aW];
                for (int y = 0; y < aH; y++) {
                    for (int x = 0; x < aW; x++) {
                        int i = (y * aW + x) * 4;
                        int m = Math.max(pixels.get(i) & 0xFF, Math.max(pixels.get(i + 1) & 0xFF, pixels.get(i + 2) & 0xFF));
                        if (m > rowMax[y]) rowMax[y] = m;
                        if (m > colMax[x]) colMax[x] = m;
                    }
                }
                final int black = 14;
                int bottom = 0;
                while (bottom < aH && rowMax[bottom] < black) bottom++;
                if (bottom >= aH) return;   // a fully black frame says nothing
                int top = 0;
                while (top < aH && rowMax[aH - 1 - top] < black) top++;
                int left = 0;
                while (left < aW && colMax[left] < black) left++;
                int right = 0;
                while (right < aW && colMax[aW - 1 - right] < black) right++;
                minBottom = Math.min(minBottom, bottom / (float) aH);
                minTop = Math.min(minTop, top / (float) aH);
                minLeft = Math.min(minLeft, left / (float) aW);
                minRight = Math.min(minRight, right / (float) aW);
                barSamples++;
                if (barSamples >= 6) {
                    contentTarget[0] = bar(minLeft);
                    contentTarget[1] = bar(minBottom);
                    contentTarget[2] = 1f - bar(minRight);
                    contentTarget[3] = 1f - bar(minTop);
                }
            } catch (Throwable ignored) {
                // Detection is a nicety: never let it break rendering.
            }
        }

        private static float bar(float fraction) {
            return fraction < 0.02f ? 0f : Math.min(fraction, 0.35f);
        }

        /** Where the picture lands in a frame shaped like the view (screen aspect a, video aspect v). */
        private static float[] fitRect(float a, float v, int mode) {
            // FIT: whole picture inside. CROP: picture covers everything.
            if (mode == FIT) {
                if (a >= v) {
                    float wf = v / a;
                    return new float[] {(1f - wf) / 2f, 0f, (1f + wf) / 2f, 1f};
                }
                float hf = a / v;
                return new float[] {0f, (1f - hf) / 2f, 1f, (1f + hf) / 2f};
            }
            if (a >= v) {
                float hf = a / v;
                return new float[] {0f, (1f - hf) / 2f, 1f, (1f + hf) / 2f};
            }
            float wf = v / a;
            return new float[] {(1f - wf) / 2f, 0f, (1f + wf) / 2f, 1f};
        }

        @Override
        public void release() throws VideoFrameProcessingException {
            super.release();
            try {
                releaseLow();
                fill.delete();
                down.delete();
                blur.delete();
            } catch (GlUtil.GlException e) {
                throw new VideoFrameProcessingException(e);
            }
        }
    }
}
