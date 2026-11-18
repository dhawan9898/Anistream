package com.anicli.stream;

import android.content.Context;
import android.content.SharedPreferences;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;

import androidx.media3.common.C;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.common.audio.BaseAudioProcessor;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.DefaultAudioSink;

import java.nio.ByteBuffer;

/**
 * Audio/video sync offset, remembered per output route (Bluetooth earbuds, wired, speaker): wireless
 * audio usually arrives 100-300 ms late, and the fix is different for every pair. A small
 * AudioProcessor in the player's audio sink either inserts silence (audio later) or drops samples
 * (audio earlier), so any offset works in either direction and changes apply immediately.
 */
@UnstableApi
public final class AudioSync {
    private AudioSync() {}

    private static final String PREFS = "audio_sync";
    public static final int[] STEPS_MS = {-200, -100, -50, 0, 50, 100, 200};

    /** "bt", "wired" or "speaker": which output the offset belongs to. */
    public static String route(Context c) {
        try {
            AudioManager am = (AudioManager) c.getSystemService(Context.AUDIO_SERVICE);
            if (am != null) {
                boolean wired = false;
                for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                    int t = d.getType();
                    if (t == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP || t == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
                            || (android.os.Build.VERSION.SDK_INT >= 31 && t == AudioDeviceInfo.TYPE_BLE_HEADSET)) {
                        return "bt";
                    }
                    if (t == AudioDeviceInfo.TYPE_WIRED_HEADPHONES || t == AudioDeviceInfo.TYPE_WIRED_HEADSET
                            || t == AudioDeviceInfo.TYPE_USB_HEADSET) {
                        wired = true;
                    }
                }
                if (wired) return "wired";
            }
        } catch (Throwable ignored) { }
        return "speaker";
    }

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static int getOffsetMs(Context c) {
        return prefs(c).getInt("offset:" + route(c), 0);
    }

    public static void setOffsetMs(Context c, int ms) {
        prefs(c).edit().putInt("offset:" + route(c), ms).apply();
    }

    /** Positive offsets play the audio later, negative ones earlier. 16-bit PCM only (the normal case). */
    public static final class Delay extends BaseAudioProcessor {
        private volatile int offsetMs;
        private long appliedFrames;
        private int sampleRate = 48000;
        private int frameSize = 4;

        public Delay(int offsetMs) {
            this.offsetMs = offsetMs;
        }

        public void setOffsetMs(int ms) {
            offsetMs = ms;
        }

        @Override
        protected AudioFormat onConfigure(AudioFormat inputAudioFormat) {
            if (inputAudioFormat.encoding != C.ENCODING_PCM_16BIT) return AudioFormat.NOT_SET;   // inactive
            sampleRate = inputAudioFormat.sampleRate;
            frameSize = inputAudioFormat.bytesPerFrame;
            return inputAudioFormat;
        }

        @Override
        public void queueInput(ByteBuffer input) {
            int remaining = input.remaining();
            if (remaining == 0) return;
            long want = (long) offsetMs * sampleRate / 1000L;
            long delta = want - appliedFrames;
            int silenceBytes = 0;
            int dropBytes = 0;
            if (delta > 0) {
                silenceBytes = (int) Math.min(delta * frameSize, 1 << 20);
                silenceBytes -= silenceBytes % frameSize;
                appliedFrames += silenceBytes / frameSize;
            } else if (delta < 0) {
                dropBytes = (int) Math.min(-delta * frameSize, remaining);
                dropBytes -= dropBytes % frameSize;
                appliedFrames -= dropBytes / frameSize;
            }
            ByteBuffer out = replaceOutputBuffer(silenceBytes + remaining - dropBytes);
            if (silenceBytes > 0) out.put(new byte[silenceBytes]);
            input.position(input.position() + dropBytes);
            out.put(input);
            out.flip();
        }

        @Override
        protected void onFlush() {
            appliedFrames = 0;   // the pipeline was cleared (seek, reconfigure): apply the offset afresh
        }

        @Override
        protected void onReset() {
            appliedFrames = 0;
        }
    }

    /** The player's default renderers, with the sync processor in the audio sink. */
    public static DefaultRenderersFactory factory(Context c, Delay delay) {
        return new DefaultRenderersFactory(c) {
            @Override
            protected AudioSink buildAudioSink(Context context, boolean enableFloatOutput,
                                               boolean enableAudioTrackPlaybackParams) {
                return new DefaultAudioSink.Builder(context)
                        .setEnableFloatOutput(enableFloatOutput)
                        .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
                        .setAudioProcessors(new AudioProcessor[] {delay})
                        .build();
            }
        };
    }
}
