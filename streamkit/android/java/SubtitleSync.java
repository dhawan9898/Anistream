package __APP_PACKAGE__;

import android.os.Handler;
import android.text.Html;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Subtitle timing for the native player (shared by AniStream and CineStream through streamkit).
 *
 * ExoPlayer has no subtitle offset, and its cue events can only be delayed, never shown early.
 * So when the viewer moves the timing, the selected subtitle file is downloaded and parsed here
 * (WebVTT or SRT) and the player draws its lines itself at (position - offset): earlier or later,
 * instantly, without re-buffering the video. At offset 0 the player's own rendering is used.
 */
final class SubtitleSync {

    /** One subtitle line: shown from startMs (inclusive) to endMs (exclusive). */
    static final class Line {
        final long startMs;
        final long endMs;
        final String text;

        Line(long startMs, long endMs, String text) {
            this.startMs = startMs;
            this.endMs = endMs;
            this.text = text;
        }
    }

    final String url;
    private volatile List<Line> lines;
    private volatile boolean failed;

    SubtitleSync(String url) {
        this.url = url;
    }

    boolean isReady() { return lines != null; }

    boolean isFailed() { return failed; }

    /** Downloads and parses the file off the main thread, then runs onDone on [main]. */
    void load(Map<String, String> headers, Handler main, Runnable onDone) {
        new Thread(() -> {
            try {
                List<Line> parsed = parse(download(url, headers));
                if (parsed.isEmpty()) failed = true; else lines = parsed;
            } catch (Exception e) {
                failed = true;
            }
            main.post(onDone);
        }, "subtitle-sync").start();
    }

    /** The lines showing at [ms], styled (italics, bold), in file order. */
    List<CharSequence> textAt(long ms) {
        List<Line> all = lines;
        if (all == null) return Collections.emptyList();
        List<CharSequence> out = new ArrayList<>(2);
        // Lines are sorted by start: skip to the last one that started, then look back a little
        // for any that are still on screen (overlapping lines are rare and short).
        int lo = 0, hi = all.size() - 1, last = -1;
        while (lo <= hi) {
            int mid = (lo + hi) >>> 1;
            if (all.get(mid).startMs <= ms) { last = mid; lo = mid + 1; } else hi = mid - 1;
        }
        for (int i = last; i >= 0 && i > last - 8; i--) {
            Line l = all.get(i);
            if (ms < l.endMs) out.add(0, Html.fromHtml(l.text.replace("\n", "<br>"), Html.FROM_HTML_MODE_LEGACY));
        }
        return out;
    }

    private static String download(String url, Map<String, String> headers) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(10_000);
        c.setReadTimeout(15_000);
        c.setInstanceFollowRedirects(true);
        if (headers != null) for (Map.Entry<String, String> h : headers.entrySet()) c.setRequestProperty(h.getKey(), h.getValue());
        try (InputStream in = c.getInputStream()) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[16 * 1024];
            int n;
            while ((n = in.read(chunk)) > 0) {
                buf.write(chunk, 0, n);
                if (buf.size() > 8 * 1024 * 1024) throw new IllegalStateException("subtitle file too large");
            }
            return new String(buf.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            c.disconnect();
        }
    }

    private static final Pattern TIMING = Pattern.compile(
            "((?:\\d+:)?\\d{1,2}:\\d{2}[.,]\\d{1,3})\\s*-->\\s*((?:\\d+:)?\\d{1,2}:\\d{2}[.,]\\d{1,3})");

    /** WebVTT or SRT text into lines sorted by start time; tags the screen cannot show are dropped. */
    static List<Line> parse(String body) {
        List<Line> out = new ArrayList<>();
        if (body == null) return out;
        String text = body.replace("\uFEFF", "").replace("\r\n", "\n").replace('\r', '\n');
        for (String block : text.split("\n\\s*\n")) {
            String[] rows = block.split("\n");
            for (int i = 0; i < rows.length; i++) {
                Matcher m = TIMING.matcher(rows[i]);
                if (!m.find()) continue;
                long start = parseTime(m.group(1));
                long end = parseTime(m.group(2));
                StringBuilder sb = new StringBuilder();
                for (int j = i + 1; j < rows.length; j++) {
                    String row = clean(rows[j]);
                    if (row.isEmpty()) continue;
                    if (sb.length() > 0) sb.append('\n');
                    sb.append(row);
                }
                if (end > start && sb.length() > 0) out.add(new Line(start, end, sb.toString()));
                break;
            }
        }
        Collections.sort(out, (a, b) -> Long.compare(a.startMs, b.startMs));
        return out;
    }

    /** "01:02:03.456", "02:03,456" or "1:02:03.4" in milliseconds. */
    static long parseTime(String t) {
        String[] parts = t.replace(',', '.').split(":");
        double seconds = Double.parseDouble(parts[parts.length - 1]);
        long minutes = Long.parseLong(parts[parts.length - 2]);
        long hours = parts.length > 2 ? Long.parseLong(parts[parts.length - 3]) : 0;
        return Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000);
    }

    // Keeps <i>, <b>, <u> (rendered by Html.fromHtml); drops voice / class tags, inline timestamps and
    // ASS overrides ({\an8}), and escapes stray angle brackets (entities such as &amp; are left to Html).
    private static String clean(String row) {
        String s = row.replaceAll("\\{\\\\[^}]*\\}", "")
                .replaceAll("<\\d{1,2}:\\d{2}[^>]*>", "")
                .replaceAll("</?(?!/?[ibu]>)[^>]*>", "")
                .trim();
        return s.replaceAll("<(?!/?[ibu]>)", "&lt;");
    }
}
