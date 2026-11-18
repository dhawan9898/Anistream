package com.anicli.stream;

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
    public static final int SHARP_AUTO = 0;   // picked per stream from its resolution
    public static final int SHARP_OFF = 1;
    public static final int SHARP_SHARP = 2;  // natural-looking, any content
    public static final int SHARP_ANIME = 3;  // line-art restoration

    // Fit modes the fill shader understands (same order as the player's Fit / Crop / Fill button).
    public static final int FIT = 0;
    public static final int CROP = 1;
    public static final int FILL = 2;

    private static final String PREFS = "video_enhance";
    private static final String KEY_SHARPEN = "sharpen";
    private static final String KEY_AMBIENT = "ambient";
    private static final String KEY_VIVID = "vivid";
    private static final String KEY_AUDIO = "audio";

    // Audio choices (stored).
    public static final int AUDIO_NORMAL = 0;
    public static final int AUDIO_BOOST = 1;   // louder than the system volume allows, with headroom
    public static final int AUDIO_NIGHT = 2;   // quiet loud parts, lift dialogue (compressor)

    /** Set when the GPU pipeline fails once; effects stay off until the app restarts. */
    private static volatile boolean disabledForSession = false;

    /** State the UI thread updates and the GL thread reads every frame. */
    public static final class Live {
        public volatile float viewAspect = 16f / 9f;   // current width / height of the video view
        public volatile float fullAspect = 16f / 9f;   // same, but only measured at full screen (PiP uses it)
        public volatile int viewW = 1920;
        public volatile int viewH = 1080;
        public volatile int fitMode = FIT;
    }

    // ---------------------------------------------------------------- settings

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static int getSharpen(Context c) {
        int v = prefs(c).getInt(KEY_SHARPEN, SHARP_AUTO);
        return v < SHARP_AUTO || v > SHARP_ANIME ? SHARP_AUTO : v;
    }

    public static void setSharpen(Context c, int mode) {
        prefs(c).edit().putInt(KEY_SHARPEN, mode).apply();
    }

    public static boolean getAmbient(Context c) {
        return prefs(c).getBoolean(KEY_AMBIENT, true);
    }

    public static void setAmbient(Context c, boolean on) {
        prefs(c).edit().putBoolean(KEY_AMBIENT, on).apply();
    }

    public static boolean getVivid(Context c) {
        return prefs(c).getBoolean(KEY_VIVID, false);
    }

    public static void setVivid(Context c, boolean on) {
        prefs(c).edit().putBoolean(KEY_VIVID, on).apply();
    }

    public static int getAudio(Context c) {
        int v = prefs(c).getInt(KEY_AUDIO, AUDIO_NORMAL);
        return v < AUDIO_NORMAL || v > AUDIO_NIGHT ? AUDIO_NORMAL : v;
    }

    public static void setAudio(Context c, int mode) {
        prefs(c).edit().putInt(KEY_AUDIO, mode).apply();
    }

    public static boolean isDisabledForSession() {
        return disabledForSession;
    }

    public static void disableForSession() {
        disabledForSession = true;
    }

    public static boolean ambientActive(Context c) {
        return !disabledForSession && getAmbient(c);
    }

    public static boolean anyActive(Context c) {
        return !disabledForSession && (getAmbient(c) || getVivid(c) || getSharpen(c) != SHARP_OFF);
    }

    /** Builds the effect chain for the current settings; empty when everything is off. */
    public static List<Effect> buildEffects(Context c, boolean animeApp, Live live) {
        List<Effect> effects = new ArrayList<>();
        if (disabledForSession) return effects;
        int sharpen = getSharpen(c);
        boolean vivid = getVivid(c);
        // The sharpen stage also hosts the colour grade, so it stays in the chain for "Vivid".
        if (sharpen != SHARP_OFF || vivid) effects.add(new SharpenEffect(sharpen, animeApp, vivid, live));
        if (getAmbient(c)) effects.add(new AmbientFillEffect(live));
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
        private final int mode;

        public AudioFx(int mode) {
            this.mode = mode;
        }

        public boolean wanted() {
            return mode != AUDIO_NORMAL;
        }

        public void attach(int sessionId) {
            if (!wanted() || sessionId == 0 || sessionId == -1) return;   // C.AUDIO_SESSION_ID_UNSET is 0
            release();
            try {
                if (mode == AUDIO_BOOST) {
                    loudness = new android.media.audiofx.LoudnessEnhancer(sessionId);
                    loudness.setTargetGain(500);   // +5 dB, in millibels
                    loudness.setEnabled(true);
                } else if (android.os.Build.VERSION.SDK_INT >= 28) {
                    // Night: a limiter used as a compressor (squash loud scenes) with make-up gain.
                    android.media.audiofx.DynamicsProcessing.Config cfg =
                            new android.media.audiofx.DynamicsProcessing.Config.Builder(
                                    android.media.audiofx.DynamicsProcessing.VARIANT_FAVOR_FREQUENCY_RESOLUTION,
                                    2, false, 0, false, 0, false, 0, true).build();
                    dynamics = new android.media.audiofx.DynamicsProcessing(0, sessionId, cfg);
                    for (int ch = 0; ch < 2; ch++) {
                        android.media.audiofx.DynamicsProcessing.Limiter lim =
                                new android.media.audiofx.DynamicsProcessing.Limiter(
                                        true, true, 0, 5f, 120f, 4f, -26f, 9f);
                        dynamics.setLimiterByChannelIndex(ch, lim);
                    }
                    dynamics.setEnabled(true);
                }
            } catch (Throwable t) {
                release();
            }
        }

        public void release() {
            try { if (loudness != null) loudness.release(); } catch (Throwable ignored) { }
            try { if (dynamics != null) dynamics.release(); } catch (Throwable ignored) { }
            loudness = null;
            dynamics = null;
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
            + "  gl_FragColor = vec4(finish(clamp(o, 0.0, 1.0)), 1.0);\n"
            + "}\n";

    private static final class SharpenEffect implements GlEffect {
        private final int mode;
        private final boolean animeApp;
        private final boolean vivid;
        private final Live live;

        SharpenEffect(int mode, boolean animeApp, boolean vivid, Live live) {
            this.mode = mode;
            this.animeApp = animeApp;
            this.vivid = vivid;
            this.live = live;
        }

        @Override
        public GlShaderProgram toGlShaderProgram(Context context, boolean useHdr)
                throws VideoFrameProcessingException {
            return new SharpenProgram(mode, animeApp, vivid, live, useHdr);
        }
    }

    private static final class SharpenProgram extends BaseGlShaderProgram {
        private final GlProgram program;
        private final int mode;
        private final boolean animeApp;
        private final boolean vivid;
        private final Live live;
        private int inW = 1;
        private int inH = 1;
        // Resolved per stream in configure().
        private boolean plain = true;
        private float amount;
        private float dark;
        private float thin;
        private float core;

        SharpenProgram(int mode, boolean animeApp, boolean vivid, Live live, boolean useHdr)
                throws VideoFrameProcessingException {
            super(useHdr, 1);
            this.mode = mode;
            this.animeApp = animeApp;
            this.vivid = vivid;
            this.live = live;
            this.program = newProgram(SHARPEN_FRAGMENT);
        }

        /** What "Auto" means for a stream of this height. */
        private int resolve(int height) {
            if (mode != SHARP_AUTO) return mode;
            if (animeApp) return height <= 900 ? SHARP_ANIME : SHARP_SHARP;
            return height <= 720 ? SHARP_SHARP : SHARP_OFF;
        }

        @Override
        public Size configure(int inputWidth, int inputHeight) throws VideoFrameProcessingException {
            inW = Math.max(1, inputWidth);
            inH = Math.max(1, inputHeight);
            int level = resolve(inH);
            // Strong enough to see on soft sources, gentle on already-crisp ones.
            float softness = inH <= 576 ? 1f : inH <= 720 ? 0.85f : inH <= 1080 ? 0.55f : 0.3f;
            plain = false;
            switch (level) {
                case SHARP_ANIME:
                    amount = 0.85f * softness + 0.1f;
                    dark = 0.45f;
                    thin = inH <= 1080 ? 0.30f * softness + 0.05f : 0f;
                    core = 0.012f;
                    break;
                case SHARP_SHARP:
                    amount = 0.55f * softness + 0.05f;
                    dark = 0f;
                    thin = 0f;
                    core = 0.008f;
                    break;
                default:
                    plain = true;
                    amount = dark = thin = core = 0f;
            }
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
                program.setFloatUniform("uAmount", amount);
                program.setFloatUniform("uDark", dark);
                program.setFloatUniform("uThin", thin);
                program.setFloatUniform("uCore", core);
                program.setFloatUniform("uVivid", vivid ? 1f : 0f);
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
            + "  vec3 bg = max(lowCubic(bq), 0.0);\n"
            + "  float l = dot(bg, vec3(0.299, 0.587, 0.114));\n"
            + "  bg = mix(vec3(l), bg, 1.2) * uDim;\n"
            + "  vec2 p = uv - 0.5;\n"
            + "  bg *= 1.0 - 0.45 * dot(p, p);\n"
            // Sharp picture, anti-aliased against the rect edge.
            + "  vec2 q = clamp((uv - uLo) / (uHi - uLo), 0.0, 1.0);\n"
            + "  vec3 fg = texture2D(uTexSampler, q).rgb;\n"
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

        AmbientFillEffect(Live live) {
            this.live = live;
        }

        @Override
        public GlShaderProgram toGlShaderProgram(Context context, boolean useHdr)
                throws VideoFrameProcessingException {
            return new AmbientFillProgram(live, useHdr);
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
        private int inW = 1;
        private int inH = 1;
        private int outW = 1;
        private int outH = 1;
        private int aW = A_W, aH = 144, bW = B_W, bH = 36;
        private int texA = -1, fboA = -1, texB = -1, fboB = -1, texC = -1, fboC = -1;
        private final int[] savedFbo = new int[1];
        private final int[] savedViewport = new int[4];

        AmbientFillProgram(Live live, boolean useHdr) throws VideoFrameProcessingException {
            super(useHdr, 1);
            this.live = live;
            this.fill = newProgram(FILL_FRAGMENT);
            this.down = newProgram(DOWNSAMPLE_FRAGMENT);
            this.blur = newProgram(BLUR_FRAGMENT);
        }

        @Override
        public Size configure(int inputWidth, int inputHeight) throws VideoFrameProcessingException {
            inW = Math.max(1, inputWidth);
            inH = Math.max(1, inputHeight);
            float screen = live.fullAspect > 0f ? live.fullAspect : live.viewAspect;
            float video = inW / (float) inH;
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
                float v = inW / (float) inH;
                float[] fit = fitRect(a, v, FIT);
                float[] cover = fitRect(a, v, CROP);
                float[] r = live.fitMode == CROP ? cover : live.fitMode == FILL
                        ? new float[] {0f, 0f, 1f, 1f} : fit;

                // Blur chain renders into our own small FBOs; remember the real output target.
                GLES20.glGetIntegerv(GLES20.GL_FRAMEBUFFER_BINDING, savedFbo, 0);
                GLES20.glGetIntegerv(GLES20.GL_VIEWPORT, savedViewport, 0);
                pass(down, inputTexId, fboA, aW, aH, "uBlock", 1f / aW, 1f / aH);
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
                fill.setFloatUniform("uDim", 0.55f);
                fill.bindAttributesAndUniforms();
                GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
                GlUtil.checkGlError();
            } catch (GlUtil.GlException e) {
                throw new VideoFrameProcessingException(e, presentationTimeUs);
            }
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
