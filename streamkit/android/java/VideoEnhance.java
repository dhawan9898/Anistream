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
        return !disabledForSession && (getAmbient(c) || getSharpen(c) != SHARP_OFF);
    }

    /** Builds the effect chain for the current settings; empty when everything is off. */
    public static List<Effect> buildEffects(Context c, boolean animeApp, Live live) {
        List<Effect> effects = new ArrayList<>();
        if (disabledForSession) return effects;
        int sharpen = getSharpen(c);
        if (sharpen != SHARP_OFF) effects.add(new SharpenEffect(sharpen, animeApp, live));
        if (getAmbient(c)) effects.add(new AmbientFillEffect(live));
        return effects;
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
            + "varying vec2 vTexSamplingCoord;\n"
            + "vec3 gMin;\n"
            + "vec3 gMax;\n"
            + "vec3 tap(vec2 uv) { return texture2D(uTexSampler, uv).rgb; }\n"
            + "float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }\n"
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
            + "  if (uPlain > 0.5) { gl_FragColor = vec4(tap(uv), 1.0); return; }\n"
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
            + "  gl_FragColor = vec4(clamp(o, 0.0, 1.0), 1.0);\n"
            + "}\n";

    private static final class SharpenEffect implements GlEffect {
        private final int mode;
        private final boolean animeApp;
        private final Live live;

        SharpenEffect(int mode, boolean animeApp, Live live) {
            this.mode = mode;
            this.animeApp = animeApp;
            this.live = live;
        }

        @Override
        public GlShaderProgram toGlShaderProgram(Context context, boolean useHdr)
                throws VideoFrameProcessingException {
            return new SharpenProgram(mode, animeApp, live, useHdr);
        }
    }

    private static final class SharpenProgram extends BaseGlShaderProgram {
        private final GlProgram program;
        private final int mode;
        private final boolean animeApp;
        private final Live live;
        private int inW = 1;
        private int inH = 1;
        // Resolved per stream in configure().
        private boolean plain = true;
        private float amount;
        private float dark;
        private float thin;
        private float core;

        SharpenProgram(int mode, boolean animeApp, Live live, boolean useHdr)
                throws VideoFrameProcessingException {
            super(useHdr, 1);
            this.mode = mode;
            this.animeApp = animeApp;
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

    // Renders the frame into a tiny texture: each output pixel averages a 4x4 grid of its block.
    private static final String DOWNSAMPLE_FRAGMENT =
            "precision highp float;\n"
            + "uniform sampler2D uTexSampler;\n"
            + "uniform vec2 uBlock;\n"
            + "varying vec2 vTexSamplingCoord;\n"
            + "void main() {\n"
            + "  vec3 s = vec3(0.0);\n"
            + "  for (int i = 0; i < 4; i++) {\n"
            + "    for (int j = 0; j < 4; j++) {\n"
            + "      vec2 o = (vec2(float(i), float(j)) + 0.5) / 4.0 - 0.5;\n"
            + "      s += texture2D(uTexSampler, vTexSamplingCoord + o * uBlock).rgb;\n"
            + "    }\n"
            + "  }\n"
            + "  gl_FragColor = vec4(s / 16.0, 1.0);\n"
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
            + "uniform vec2 uLowTexel;\n"
            + "uniform float uDim;\n"
            + "varying vec2 vTexSamplingCoord;\n"
            + "vec3 low(vec2 q) { return texture2D(uLow, clamp(q, 0.0, 1.0)).rgb; }\n"
            + "void main() {\n"
            + "  vec2 uv = vTexSamplingCoord;\n"
            // Background: the frame zoomed to cover the screen, heavily blurred (3x3 on a 96px source).
            + "  vec2 bq = (uv - uCoverLo) / (uCoverHi - uCoverLo);\n"
            + "  vec2 s = uLowTexel * 2.0;\n"
            + "  vec3 bg = low(bq) * 4.0\n"
            + "          + (low(bq + vec2(s.x, 0.0)) + low(bq - vec2(s.x, 0.0))\n"
            + "           + low(bq + vec2(0.0, s.y)) + low(bq - vec2(0.0, s.y))) * 2.0\n"
            + "          + low(bq + s) + low(bq - s) + low(bq + vec2(s.x, -s.y)) + low(bq + vec2(-s.x, s.y));\n"
            + "  bg /= 16.0;\n"
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
            // Dither so the dark gradient does not band.
            + "  float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));\n"
            + "  c += (n - 0.5) / 170.0;\n"
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
        private static final int LOW_W = 96;

        private final GlProgram fill;
        private final GlProgram down;
        private final Live live;
        private int inW = 1;
        private int inH = 1;
        private int outW = 1;
        private int outH = 1;
        private int lowW = LOW_W;
        private int lowH = 54;
        private int lowTex = -1;
        private int lowFbo = -1;
        private final int[] savedFbo = new int[1];
        private final int[] savedViewport = new int[4];

        AmbientFillProgram(Live live, boolean useHdr) throws VideoFrameProcessingException {
            super(useHdr, 1);
            this.live = live;
            this.fill = newProgram(FILL_FRAGMENT);
            this.down = newProgram(DOWNSAMPLE_FRAGMENT);
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
            lowW = LOW_W;
            lowH = Math.max(8, Math.min(256, Math.round(LOW_W / video)));
            try {
                releaseLow();
                lowTex = GlUtil.createTexture(lowW, lowH, /* useHighPrecisionColorComponents= */ false);
                lowFbo = GlUtil.createFboForTexture(lowTex);
            } catch (GlUtil.GlException e) {
                throw new VideoFrameProcessingException(e);
            }
            return new Size(outW, outH);
        }

        private void releaseLow() throws GlUtil.GlException {
            if (lowFbo != -1) GlUtil.deleteFbo(lowFbo);
            if (lowTex != -1) GlUtil.deleteTexture(lowTex);
            lowFbo = -1;
            lowTex = -1;
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

                // Pass 1: blur source (renders into our own small FBO; remember the output target).
                GLES20.glGetIntegerv(GLES20.GL_FRAMEBUFFER_BINDING, savedFbo, 0);
                GLES20.glGetIntegerv(GLES20.GL_VIEWPORT, savedViewport, 0);
                GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, lowFbo);
                GLES20.glViewport(0, 0, lowW, lowH);
                down.use();
                down.setSamplerTexIdUniform("uTexSampler", inputTexId, 0);
                down.setFloatsUniform("uBlock", new float[] {1f / lowW, 1f / lowH});
                down.bindAttributesAndUniforms();
                GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);

                // Pass 2: the frame itself.
                GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, savedFbo[0]);
                GLES20.glViewport(savedViewport[0], savedViewport[1], savedViewport[2], savedViewport[3]);
                fill.use();
                fill.setSamplerTexIdUniform("uTexSampler", inputTexId, 0);
                fill.setSamplerTexIdUniform("uLow", lowTex, 1);
                fill.setFloatsUniform("uLo", new float[] {r[0], r[1]});
                fill.setFloatsUniform("uHi", new float[] {r[2], r[3]});
                fill.setFloatsUniform("uCoverLo", new float[] {cover[0], cover[1]});
                fill.setFloatsUniform("uCoverHi", new float[] {cover[2], cover[3]});
                fill.setFloatsUniform("uOutSize", new float[] {outW, outH});
                fill.setFloatsUniform("uLowTexel", new float[] {1f / lowW, 1f / lowH});
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
            } catch (GlUtil.GlException e) {
                throw new VideoFrameProcessingException(e);
            }
        }
    }
}
