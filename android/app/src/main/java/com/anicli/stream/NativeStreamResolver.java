package com.anicli.stream;

import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.FutureTask;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Resolves an episode's stream inside the player, without the app's
 * JavaScript. It follows exactly the steps of aniCliCore.getEpisodeStream():
 * episode servers -> embed page -> sources endpoint -> (decrypt).
 *
 * Why it exists: next episode and audio switch used to need a round trip
 * through the WebView while it sat hidden behind the player for the whole
 * episode, and that round trip was the weak link ("stuck on loading" after a
 * couple of episodes). Resolving here makes those actions independent of the
 * WebView; the JS path stays as the fallback when this one can't find a stream.
 */
final class NativeStreamResolver {
    private static final String TAG = "NativeStreamResolver";
    private static final String HOST = "https://hianime.at";
    private static final String UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    private static final int TIMEOUT_MS = 10_000;
    private static final int MAX_SERVERS = 4;
    // Same constants as aniCliCore.decryptToken (key is 16 chars zero-padded to 32 bytes).
    private static final String KEY = "i?LMTAx0Q6,:}50U";
    private static final String IV = "W0;27ToaUpl_P%'c";

    // Streams resolved recently are reused (links last a while; this saves a
    // 3-request round trip when the same episode is asked for twice).
    private static final long REUSE_MS = 4 * 60 * 1000;
    private static final Map<String, Result> cache = new ConcurrentHashMap<>();

    static final class Result {
        final String url;
        final String referer;
        final String subtitlesJson;
        final long introStartMs, introEndMs, outroStartMs, outroEndMs;
        final String spriteVtt;
        final long resolvedAt = System.currentTimeMillis();

        Result(String url, String referer, String subtitlesJson, String spriteVtt,
               long introStartMs, long introEndMs, long outroStartMs, long outroEndMs) {
            this.spriteVtt = spriteVtt;
            this.url = url;
            this.referer = referer;
            this.subtitlesJson = subtitlesJson;
            this.introStartMs = introStartMs;
            this.introEndMs = introEndMs;
            this.outroStartMs = outroStartMs;
            this.outroEndMs = outroEndMs;
        }
    }

    private static final ExecutorService EXECUTOR = Executors.newFixedThreadPool(2);
    private static final Map<String, FutureTask<Result>> inFlight = new ConcurrentHashMap<>();

    private NativeStreamResolver() {}

    static void runAsync(Runnable task) {
        EXECUTOR.execute(task);
    }

    // Blocking - call from a background thread. Throws when no server yields
    // a stream. Concurrent asks for the same episode/audio (a prefetch and
    // the Next press that follows it) share one resolution.
    static Result resolve(String episodeId, String mode, boolean fresh) throws Exception {
        String key = episodeId + "|" + mode;
        Result cached = cache.get(key);
        if (!fresh && cached != null && System.currentTimeMillis() - cached.resolvedAt < REUSE_MS) return cached;

        FutureTask<Result> task = new FutureTask<>(() -> resolveUncached(episodeId, mode));
        FutureTask<Result> running = fresh ? null : inFlight.putIfAbsent(key, task);
        if (running == null) {
            inFlight.put(key, task);
            running = task;
            task.run();
        }
        try {
            return running.get();
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            throw cause instanceof Exception ? (Exception) cause : e;
        } finally {
            if (running == task) inFlight.remove(key, task);
        }
    }

    private static Result resolveUncached(String episodeId, String mode) throws Exception {
        String key = episodeId + "|" + mode;

        String serversJson = get(HOST + "/api/theme/episode/servers?episodeId=" + episodeId, UA, HOST + "/", false);
        String html = new JSONObject(serversJson).optString("html", "");
        if (html.isEmpty()) throw new IOException("servers response had no html");

        List<String> hashes = pickServerHashes(html, mode);
        if (hashes.isEmpty()) throw new IOException("no " + mode + " servers for episode " + episodeId);

        Exception last = null;
        for (String hash : hashes) {
            try {
                Result result = resolveEmbed(hash);
                if (result != null) {
                    cache.put(key, result);
                    if (cache.size() > 12) cache.clear();
                    return result;
                }
            } catch (Exception e) {
                last = e;
                Log.w(TAG, "server failed: " + e);
            }
        }
        throw last != null ? last : new IOException("no server produced a stream");
    }

    static void forget(String episodeId, String mode) {
        cache.remove(episodeId + "|" + mode);
    }

    private static final Pattern TAG_WITH_HASH = Pattern.compile("<[^>]*\\bdata-hash\\s*=\\s*[\"'][^\"']*[\"'][^>]*>");
    private static final Pattern HASH = Pattern.compile("\\bdata-hash\\s*=\\s*[\"']([^\"']*)[\"']");
    private static final Pattern TYPE = Pattern.compile("\\bdata-type\\s*=\\s*[\"']([^\"']*)[\"']");

    // The requested audio only; a sub request may fall back to whatever the
    // episode has, a dub request never turns into the subbed stream.
    private static List<String> pickServerHashes(String html, String mode) {
        Set<String> preferred = new LinkedHashSet<>();
        Set<String> any = new LinkedHashSet<>();
        Matcher tags = TAG_WITH_HASH.matcher(html);
        while (tags.find()) {
            String tag = tags.group();
            Matcher h = HASH.matcher(tag);
            if (!h.find() || h.group(1).isEmpty()) continue;
            any.add(h.group(1));
            Matcher t = TYPE.matcher(tag);
            if (t.find() && mode.equals(t.group(1))) preferred.add(h.group(1));
        }
        Set<String> chosen = !preferred.isEmpty() || "dub".equals(mode) ? preferred : any;
        List<String> list = new ArrayList<>(chosen);
        return list.size() > MAX_SERVERS ? list.subList(0, MAX_SERVERS) : list;
    }

    private static Result resolveEmbed(String hash) throws Exception {
        String embedUrl;
        try {
            embedUrl = new String(Base64.decode(hash, Base64.DEFAULT), StandardCharsets.UTF_8).trim();
        } catch (IllegalArgumentException e) {
            return null;
        }
        // The hash comes from a third-party page: plain web URLs only.
        if (!embedUrl.startsWith("https://") && !embedUrl.startsWith("http://")) return null;

        String embedHtml = get(embedUrl, UA, HOST + "/", false);
        URL embed = new URL(embedUrl);
        String origin = embed.getProtocol() + "://" + embed.getHost() + (embed.getPort() > 0 ? ":" + embed.getPort() : "");

        // Current embeds carry the whole payload inline (window.__P, XOR-ed
        // with a fixed key); older ones have a sources endpoint behind a data-id.
        JSONObject inline = parseInlinePayload(embedHtml);
        if (inline != null) {
            String src = inline.optString("src", "");
            if (src.isEmpty()) return null;
            JSONObject skip = inline.optJSONObject("skip");
            long[] intro = range(skip != null ? skip.optJSONObject("intro") : null);
            long[] outro = range(skip != null ? skip.optJSONObject("outro") : null);
            return new Result(src, origin + "/", subtitlesJson(inline.optJSONArray("subtitles")),
                    inline.optString("sprite_vtt", ""), intro[0], intro[1], outro[0], outro[1]);
        }

        Matcher id = Pattern.compile("data-id=\"(\\d+)\"", Pattern.CASE_INSENSITIVE).matcher(embedHtml);
        if (!id.find()) return null;
        String sourcesBody = get(origin + "/stream/getSourcesNew?id=" + id.group(1), UA, embedUrl, true);
        JSONObject sources = new JSONObject(sourcesBody);

        String file = null;
        JSONObject introObj = sources.optJSONObject("intro");
        JSONObject outroObj = sources.optJSONObject("outro");
        Object tracks = sources.opt("tracks");

        JSONArray list = sources.optJSONArray("sources");
        if (list != null && list.length() > 0 && list.optJSONObject(0) != null
                && !list.optJSONObject(0).optString("file", "").isEmpty()) {
            file = list.getJSONObject(0).getString("file");
        } else if (sources.has("enc")) {
            JSONObject dec = new JSONObject(decrypt(sources.getString("enc")));
            file = dec.optString("file", dec.optString("src", ""));
            if (introObj == null) introObj = dec.optJSONObject("intro");
            if (outroObj == null) outroObj = dec.optJSONObject("outro");
            if (tracks == null) tracks = dec.opt("tracks");
        }
        if (file == null || file.isEmpty()) return null;

        long[] intro = range(introObj);
        long[] outro = range(outroObj);
        return new Result(file, origin + "/", subtitlesJson(tracks), spriteOf(tracks),
                intro[0], intro[1], outro[0], outro[1]);
    }

    private static final Pattern INLINE_PAYLOAD = Pattern.compile("window\\.__P\\s*=\\s*\"([^\"]+)\"");
    private static final byte[] PAYLOAD_KEY = "otaku-embed-v1".getBytes(StandardCharsets.ISO_8859_1);

    private static JSONObject parseInlinePayload(String html) {
        Matcher m = INLINE_PAYLOAD.matcher(html);
        if (!m.find()) return null;
        try {
            byte[] data = Base64.decode(m.group(1), Base64.DEFAULT);
            for (int i = 0; i < data.length; i++) data[i] ^= PAYLOAD_KEY[i % PAYLOAD_KEY.length];
            return new JSONObject(new String(data, StandardCharsets.UTF_8));
        } catch (Exception e) {
            Log.w(TAG, "inline payload could not be decoded: " + e);
            return null;
        }
    }

    // The thumbnails sprite VTT among a sources payload's tracks.
    private static String spriteOf(Object tracks) {
        if (!(tracks instanceof JSONArray)) return "";
        JSONArray arr = (JSONArray) tracks;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject t = arr.optJSONObject(i);
            if (t != null && "thumbnails".equalsIgnoreCase(t.optString("kind", ""))) {
                String f = t.optString("file", t.optString("src", ""));
                if (!f.isEmpty()) return f;
            }
        }
        return "";
    }

    // { start, end } in seconds -> ms; {-1,-1} when absent or empty (0/0 means untagged).
    private static long[] range(JSONObject o) {
        if (o == null) return new long[]{-1, -1};
        double start = o.optDouble("start", -1);
        double end = o.optDouble("end", -1);
        if (start < 0 || end <= start) return new long[]{-1, -1};
        return new long[]{Math.round(start * 1000), Math.round(end * 1000)};
    }

    // Caption tracks only (the same array carries a thumbnail sprite VTT).
    private static String subtitlesJson(Object tracks) {
        JSONArray out = new JSONArray();
        if (!(tracks instanceof JSONArray)) return out.toString();
        JSONArray arr = (JSONArray) tracks;
        Set<String> seen = new LinkedHashSet<>();
        try {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject t = arr.optJSONObject(i);
                if (t == null) continue;
                String src = t.optString("file", t.optString("src", ""));
                String kind = t.optString("kind", "captions").toLowerCase(java.util.Locale.US);
                if (src.isEmpty() || (!kind.equals("captions") && !kind.equals("subtitles"))) continue;
                if (!seen.add(src)) continue;
                JSONObject o = new JSONObject();
                o.put("src", src);
                o.put("label", t.optString("label", t.optString("lang", "English")));
                o.put("default", t.optBoolean("default", false));
                out.put(o);
            }
        } catch (Exception e) {
            Log.w(TAG, "subtitle parse failed", e);
        }
        return out.toString();
    }

    private static String decrypt(String enc) throws Exception {
        String b64 = enc.replace('-', '+').replace('_', '/');
        int pad = b64.length() % 4;
        if (pad != 0) b64 = b64 + "====".substring(pad);
        byte[] data = Base64.decode(b64, Base64.DEFAULT);
        byte[] key = new byte[32];
        byte[] keyChars = KEY.getBytes(StandardCharsets.ISO_8859_1);
        System.arraycopy(keyChars, 0, key, 0, Math.min(32, keyChars.length));
        Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"),
                new IvParameterSpec(IV.getBytes(StandardCharsets.ISO_8859_1)));
        return new String(cipher.doFinal(data), StandardCharsets.UTF_8);
    }

    // GET with one retry for network errors and 429/5xx.
    private static String get(String url, String userAgent, String referer, boolean xhr) throws IOException {
        IOException last = null;
        for (int attempt = 0; attempt < 2; attempt++) {
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(TIMEOUT_MS);
                c.setReadTimeout(TIMEOUT_MS);
                c.setRequestProperty("User-Agent", userAgent);
                c.setRequestProperty("Referer", referer);
                if (xhr) c.setRequestProperty("X-Requested-With", "XMLHttpRequest");
                int code = c.getResponseCode();
                if (code == 429 || code >= 500) throw new IOException("HTTP " + code + " for " + url);
                if (code < 200 || code >= 300) throw new NonRetryable("HTTP " + code + " for " + url);
                try (InputStream in = c.getInputStream()) {
                    ByteArrayOutputStream buf = new ByteArrayOutputStream();
                    byte[] chunk = new byte[8192];
                    int n;
                    while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
                    return buf.toString("UTF-8");
                }
            } catch (NonRetryable e) {
                throw e;
            } catch (IOException e) {
                last = e;
                try { Thread.sleep(400); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); break; }
            } finally {
                if (c != null) c.disconnect();
            }
        }
        throw last != null ? last : new IOException("request failed: " + url);
    }

    private static final class NonRetryable extends IOException {
        NonRetryable(String message) { super(message); }
    }
}
