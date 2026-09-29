package com.anicli.stream;

import android.os.Handler;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// Mirrors src/services/aniSkipService.ts on the JS side: ani-cli/hianime
// carry no chapter metadata of their own, so this looks the anime up on
// MyAnimeList (via the Jikan API) to get a MAL id, then asks the AniSkip API
// for that exact episode's real opening/ending timestamps. Either half comes
// back null when no real data exists for it - callers must treat that as
// "don't offer to skip it", never fall back to a guessed range.
final class AniSkipClient {
    private static final String TAG = "AniSkipClient";
    private static final int TIMEOUT_MS = 6000;
    private static final ExecutorService executor = Executors.newSingleThreadExecutor();

    // Title -> MAL id (or null if not found), so a multi-episode binge only
    // pays for the MAL lookup once.
    private static final Map<String, Integer> malIdCache = new HashMap<>();

    static final class SkipInterval {
        final long startMs;
        final long endMs;

        SkipInterval(long startMs, long endMs) {
            this.startMs = startMs;
            this.endMs = endMs;
        }
    }

    interface Callback {
        void onResult(SkipInterval opening, SkipInterval ending);
    }

    // Runs the whole lookup on a background thread and delivers the result
    // on mainHandler (the activity's own Handler, tied to the main Looper).
    static void fetchSkipIntervals(String title, String episodeNumber, long episodeLengthSeconds,
                                    Handler mainHandler, Callback callback) {
        executor.execute(() -> {
            SkipInterval[] result = fetchSkipIntervalsSync(title, episodeNumber, episodeLengthSeconds);
            mainHandler.post(() -> callback.onResult(result[0], result[1]));
        });
    }

    private static SkipInterval[] fetchSkipIntervalsSync(String title, String episodeNumber, long episodeLengthSeconds) {
        SkipInterval[] none = new SkipInterval[]{null, null};
        int epNum;
        try {
            epNum = Integer.parseInt(episodeNumber);
        } catch (Exception e) {
            return none;
        }
        if (title == null || title.isEmpty() || epNum <= 0 || episodeLengthSeconds <= 0) return none;

        Integer malId = resolveMalId(title);
        if (malId == null) return none;

        try {
            String url = "https://api.aniskip.com/v2/skip-times/" + malId + "/" + epNum
                    + "?types[]=op&types[]=ed&episodeLength=" + episodeLengthSeconds;
            JSONObject data = fetchJson(url);
            return new SkipInterval[]{extractInterval(data, "op"), extractInterval(data, "ed")};
        } catch (Exception e) {
            Log.w(TAG, "Skip-time lookup failed", e);
            return none;
        }
    }

    private static Integer resolveMalId(String title) {
        String cacheKey = title.trim().toLowerCase(Locale.US);
        if (malIdCache.containsKey(cacheKey)) return malIdCache.get(cacheKey);
        try {
            String url = "https://api.jikan.moe/v4/anime?q=" + URLEncoder.encode(title, "UTF-8") + "&limit=1";
            JSONObject data = fetchJson(url);
            JSONArray results = data.optJSONArray("data");
            Integer malId = null;
            if (results != null && results.length() > 0) {
                int id = results.getJSONObject(0).optInt("mal_id", -1);
                if (id > 0) malId = id;
            }
            malIdCache.put(cacheKey, malId);
            return malId;
        } catch (Exception e) {
            Log.w(TAG, "MAL id lookup failed", e);
            malIdCache.put(cacheKey, null);
            return null;
        }
    }

    private static SkipInterval extractInterval(JSONObject data, String skipType) {
        if (data == null) return null;
        JSONArray results = data.optJSONArray("results");
        if (results == null) return null;
        for (int i = 0; i < results.length(); i++) {
            JSONObject result = results.optJSONObject(i);
            if (result == null || !skipType.equals(result.optString("skipType"))) continue;
            JSONObject interval = result.optJSONObject("interval");
            if (interval == null) return null;
            double start = interval.optDouble("startTime", -1);
            double end = interval.optDouble("endTime", -1);
            if (start < 0 || end < 0 || end <= start) return null;
            return new SkipInterval(Math.round(start * 1000), Math.round(end * 1000));
        }
        return null;
    }

    private static JSONObject fetchJson(String urlString) throws Exception {
        URL url = new URL(urlString);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        try {
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(TIMEOUT_MS);
            connection.setReadTimeout(TIMEOUT_MS);
            connection.setRequestProperty("Accept", "application/json");
            int status = connection.getResponseCode();
            if (status != 200) throw new Exception("HTTP " + status + " from " + urlString);
            StringBuilder sb = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) sb.append(line);
            }
            return new JSONObject(sb.toString());
        } finally {
            connection.disconnect();
        }
    }

    private AniSkipClient() {
    }
}
