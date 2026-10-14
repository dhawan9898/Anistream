package com.anicli.stream;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Log;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The seek bar's preview pictures: the stream's own thumbnail sprites. A
 * WebVTT file maps time ranges to regions ("sprite.jpg#xywh=160,0,160,90")
 * of a few sheet images; the frame for a position is cropped out of the sheet.
 * Everything loads in the background; frameAt() never blocks.
 */
final class ThumbnailSprites {
    private static final String TAG = "ThumbnailSprites";
    private static final String UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    private static final Pattern TIME = Pattern.compile("(?:(\\d+):)?(\\d+):(\\d+)[.,](\\d+)");
    private static final Pattern CUE = Pattern.compile(
            "((?:\\d+:)?\\d+:\\d+[.,]\\d+)\\s*-->\\s*((?:\\d+:)?\\d+:\\d+[.,]\\d+)[^\\n]*\\n\\s*(\\S+?)#xywh=(\\d+),(\\d+),(\\d+),(\\d+)");

    private final String referer;
    private final List<long[]> cues = new ArrayList<>();      // {startMs, endMs, x, y, w, h, sheetIndex}
    private final List<String> sheetUrls = new ArrayList<>();
    private final Map<String, Bitmap> sheets = new ConcurrentHashMap<>();
    private final Set<String> loading = new HashSet<>();
    private volatile boolean parsed = false;
    private volatile boolean released = false;

    // Last cropped frame, so scrubbing within one cue doesn't re-crop.
    private int lastCue = -1;
    private Bitmap lastFrame;

    private ThumbnailSprites(String referer) {
        this.referer = referer;
    }

    // Starts loading `vttUrl` in the background; `onParsed` runs (off the main
    // thread) once the cue list is known.
    static ThumbnailSprites load(String vttUrl, String referer) {
        ThumbnailSprites sprites = new ThumbnailSprites(referer);
        NativeStreamResolver.runAsync(() -> sprites.parse(vttUrl));
        return sprites;
    }

    void release() {
        released = true;
        sheets.clear();
        lastFrame = null;
    }

    // Aspect ratio (w/h) of the thumbnails, or 0 until known.
    synchronized float aspect() {
        if (cues.isEmpty()) return 0f;
        long[] c = cues.get(0);
        return c[5] > 0 ? (float) c[4] / c[5] : 0f;
    }

    private void parse(String vttUrl) {
        try {
            String text = fetchText(vttUrl);
            URL base = new URL(vttUrl);
            Matcher m = CUE.matcher(text);
            List<long[]> found = new ArrayList<>();
            List<String> urls = new ArrayList<>();
            while (m.find()) {
                String sheet = new URL(base, m.group(3)).toString();
                int index = urls.indexOf(sheet);
                if (index < 0) {
                    urls.add(sheet);
                    index = urls.size() - 1;
                }
                found.add(new long[]{
                        toMs(m.group(1)), toMs(m.group(2)),
                        Long.parseLong(m.group(4)), Long.parseLong(m.group(5)),
                        Long.parseLong(m.group(6)), Long.parseLong(m.group(7)), index});
            }
            synchronized (this) {
                cues.addAll(found);
                sheetUrls.addAll(urls);
            }
            parsed = !found.isEmpty();
            Log.i(TAG, "Thumbnails ready: " + found.size() + " cues, " + urls.size() + " sheets");
        } catch (Exception e) {
            Log.w(TAG, "Thumbnails unavailable: " + e);
        }
    }

    private static long toMs(String t) {
        Matcher m = TIME.matcher(t);
        if (!m.find()) return 0;
        long h = m.group(1) != null ? Long.parseLong(m.group(1)) : 0;
        long min = Long.parseLong(m.group(2));
        long s = Long.parseLong(m.group(3));
        String frac = (m.group(4) + "00").substring(0, 3);
        return ((h * 60 + min) * 60 + s) * 1000 + Long.parseLong(frac);
    }

    // The frame for `positionMs`, or null while its sheet is still loading
    // (then `onSheetLoaded` runs, off the main thread, when it arrives).
    synchronized Bitmap frameAt(long positionMs, Runnable onSheetLoaded) {
        if (!parsed || released || cues.isEmpty()) return null;
        int lo = 0, hi = cues.size() - 1, found = 0;
        while (lo <= hi) {
            int mid = (lo + hi) >>> 1;
            if (cues.get(mid)[0] <= positionMs) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
        }
        if (found == lastCue && lastFrame != null) return lastFrame;
        long[] cue = cues.get(found);
        String url = sheetUrls.get((int) cue[6]);
        Bitmap sheet = sheets.get(url);
        if (sheet == null) {
            requestSheet(url, onSheetLoaded);
            return lastFrame; // keep showing the previous frame meanwhile
        }
        try {
            int x = (int) Math.min(cue[2], Math.max(0, sheet.getWidth() - 1));
            int y = (int) Math.min(cue[3], Math.max(0, sheet.getHeight() - 1));
            int w = (int) Math.min(cue[4], sheet.getWidth() - x);
            int h = (int) Math.min(cue[5], sheet.getHeight() - y);
            lastFrame = Bitmap.createBitmap(sheet, x, y, w, h);
            lastCue = found;
        } catch (Exception e) {
            Log.w(TAG, "crop failed: " + e);
        }
        return lastFrame;
    }

    private void requestSheet(String url, Runnable onSheetLoaded) {
        synchronized (loading) {
            if (!loading.add(url)) return;
        }
        NativeStreamResolver.runAsync(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(12000);
                c.setRequestProperty("User-Agent", UA);
                c.setRequestProperty("Referer", referer);
                try (InputStream in = c.getInputStream()) {
                    Bitmap bitmap = BitmapFactory.decodeStream(in);
                    if (bitmap != null && !released) sheets.put(url, bitmap);
                } finally {
                    c.disconnect();
                }
            } catch (Exception e) {
                Log.w(TAG, "sheet failed: " + e);
            } finally {
                synchronized (loading) { loading.remove(url); }
            }
            if (!released && onSheetLoaded != null) onSheetLoaded.run();
        });
    }

    private String fetchText(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(8000);
        c.setReadTimeout(10000);
        c.setRequestProperty("User-Agent", UA);
        c.setRequestProperty("Referer", referer);
        try (InputStream in = c.getInputStream()) {
            java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            return buf.toString("UTF-8");
        } finally {
            c.disconnect();
        }
    }
}
