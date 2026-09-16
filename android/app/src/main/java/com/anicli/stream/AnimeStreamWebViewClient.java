package com.anicli.stream;

import android.net.Uri;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class AnimeStreamWebViewClient extends BridgeWebViewClient {
    private static final String TAG = "AnimeStreamProxy";
    private static final String PROXY_PATH = "/_anime_proxy_";

    public AnimeStreamWebViewClient(Bridge bridge) {
        super(bridge);
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (uri != null && PROXY_PATH.equals(uri.getPath())) {
            return handleProxy(request);
        }
        return super.shouldInterceptRequest(view, request);
    }

    private WebResourceResponse handleProxy(WebResourceRequest request) {
        Uri uri = request.getUrl();
        String targetUrl = uri.getQueryParameter("url");
        String referer = uri.getQueryParameter("ref");

        Map<String, String> corsHeaders = new HashMap<>();
        corsHeaders.put("Access-Control-Allow-Origin", "*");
        corsHeaders.put("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        corsHeaders.put("Access-Control-Allow-Headers", "*");
        corsHeaders.put("Access-Control-Max-Age", "86400");

        if (targetUrl == null || targetUrl.isEmpty()) {
            return new WebResourceResponse("text/plain", "UTF-8", 400, "Bad Request", corsHeaders, new ByteArrayInputStream("Missing url parameter".getBytes(StandardCharsets.UTF_8)));
        }

        if (referer == null || referer.isEmpty()) {
            referer = "https://zokoanime.video/";
        }

        if ("OPTIONS".equalsIgnoreCase(request.getMethod())) {
            return new WebResourceResponse("text/plain", "UTF-8", 200, "OK", corsHeaders, new ByteArrayInputStream(new byte[0]));
        }

        try {
            URL url = new URL(targetUrl);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod(request.getMethod());
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            conn.setInstanceFollowRedirects(true);

            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
            conn.setRequestProperty("Referer", referer);
            String origin = referer.replaceAll("/+$", "");
            conn.setRequestProperty("Origin", origin);

            Map<String, String> clientHeaders = request.getRequestHeaders();
            if (clientHeaders != null) {
                String range = clientHeaders.get("Range");
                if (range == null) range = clientHeaders.get("range");
                if (range != null) {
                    conn.setRequestProperty("Range", range);
                }
            }

            int responseCode = conn.getResponseCode();
            String contentType = conn.getContentType();
            String mimeType = guessMimeType(targetUrl, contentType);

            Map<String, String> responseHeaders = new HashMap<>(corsHeaders);
            for (Map.Entry<String, List<String>> entry : conn.getHeaderFields().entrySet()) {
                if (entry.getKey() != null && !entry.getKey().equalsIgnoreCase("Access-Control-Allow-Origin")) {
                    StringBuilder sb = new StringBuilder();
                    for (String val : entry.getValue()) {
                        if (sb.length() > 0) sb.append(", ");
                        sb.append(val);
                    }
                    responseHeaders.put(entry.getKey(), sb.toString());
                }
            }
            responseHeaders.put("Access-Control-Allow-Origin", "*");

            boolean isM3u8 = targetUrl.contains(".m3u8") || mimeType.contains("mpegurl");
            if (isM3u8 && responseCode >= 200 && responseCode < 300) {
                String proxyEndpoint = uri.getScheme() + "://" + uri.getAuthority() + PROXY_PATH;
                return rewriteM3u8(conn, targetUrl, referer, proxyEndpoint, responseCode, responseHeaders);
            }

            InputStream is = responseCode >= 400 ? conn.getErrorStream() : conn.getInputStream();
            if (is == null) {
                is = new ByteArrayInputStream(new byte[0]);
            }
            return new WebResourceResponse(mimeType, "UTF-8", responseCode, "OK", responseHeaders, is);

        } catch (Exception e) {
            Log.e(TAG, "Proxy error for url " + targetUrl, e);
            return new WebResourceResponse("text/plain", "UTF-8", 500, "Internal Error", corsHeaders, new ByteArrayInputStream(e.getMessage().getBytes(StandardCharsets.UTF_8)));
        }
    }

    private String guessMimeType(String url, String contentType) {
        if (contentType != null && !contentType.isEmpty()) {
            return contentType.split(";")[0].trim();
        }
        String lower = url.toLowerCase();
        if (lower.contains(".m3u8")) return "application/vnd.apple.mpegurl";
        if (lower.contains(".vtt")) return "text/vtt";
        if (lower.contains(".ts")) return "video/MP2T";
        if (lower.contains(".mp4") || lower.contains(".m4s")) return "video/mp4";
        return "application/octet-stream";
    }

    private WebResourceResponse rewriteM3u8(HttpURLConnection conn, String baseUrl, String referer, String proxyEndpoint, int responseCode, Map<String, String> responseHeaders) throws Exception {
        BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) {
            line = line.trim();
            if (line.isEmpty()) {
                sb.append("\n");
                continue;
            }
            if (line.startsWith("#")) {
                if (line.contains("URI=\"")) {
                    int startIdx = line.indexOf("URI=\"") + 5;
                    int endIdx = line.indexOf("\"", startIdx);
                    if (endIdx > startIdx) {
                        String rawUri = line.substring(startIdx, endIdx);
                        String resolved = resolveUri(baseUrl, rawUri);
                        String proxied = proxyEndpoint + "?url=" + URLEncoder.encode(resolved, "UTF-8") + "&ref=" + URLEncoder.encode(referer, "UTF-8");
                        line = line.substring(0, startIdx) + proxied + line.substring(endIdx);
                    }
                }
                sb.append(line).append("\n");
            } else {
                String resolved = resolveUri(baseUrl, line);
                String proxied = proxyEndpoint + "?url=" + URLEncoder.encode(resolved, "UTF-8") + "&ref=" + URLEncoder.encode(referer, "UTF-8");
                sb.append(proxied).append("\n");
            }
        }
        reader.close();

        byte[] bytes = sb.toString().getBytes(StandardCharsets.UTF_8);
        return new WebResourceResponse("application/vnd.apple.mpegurl", "UTF-8", responseCode, "OK", responseHeaders, new ByteArrayInputStream(bytes));
    }

    private String resolveUri(String baseUrl, String relativeOrAbsolute) {
        if (relativeOrAbsolute.startsWith("http://") || relativeOrAbsolute.startsWith("https://")) {
            return relativeOrAbsolute;
        }
        try {
            URL base = new URL(baseUrl);
            return new URL(base, relativeOrAbsolute).toString();
        } catch (Exception e) {
            return relativeOrAbsolute;
        }
    }
}
