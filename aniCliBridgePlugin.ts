// aniCliBridgePlugin.ts - Vite plugin bridging stream resolution & streaming proxy
import type { Plugin } from 'vite';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import { URL } from 'url';

function decryptToken(enc: string): string {
  try {
    const base64 = enc.replace(/-/g, '+').replace(/_/g, '/');
    const pad = base64.length % 4;
    const fullBase64 = pad ? base64 + '='.repeat(4 - pad) : base64;
    const encryptedBuf = Buffer.from(fullBase64, 'base64');

    const keyStr = 'i?LMTAx0Q6,:}50U';
    const keyBuf = Buffer.alloc(32);
    keyBuf.write(keyStr);

    const ivBuf = Buffer.from("W0;27ToaUpl_P%'c");

    const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuf, ivBuf);
    let decrypted = decipher.update(encryptedBuf, undefined, 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    console.error('[ani-cli-bridge] decryptToken error:', e);
    return '';
  }
}

// Only plain http(s) URLs on public hosts may go through /stream-proxy.
function isPublicHttpUrl(url: URL): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  // IPv6 literals: loopback, unspecified, unique-local (fc00::/7), link-local.
  if (host.includes(':') && (host === '::1' || host === '::' || /^(fc|fd|fe8|fe9|fea|feb)/.test(host) || host.startsWith('::ffff:'))) return false;
  return true;
}

async function resolveStream(query: string, ep: string, mode: string) {
  const REMOTE_HOST = 'https://hianime.at';
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': `${REMOTE_HOST}/`
  };

  // 1. Search anime
  const searchRes = await fetch(`${REMOTE_HOST}/search?keyword=${encodeURIComponent(query)}`, { headers });
  if (!searchRes.ok) throw new Error(`Search failed: HTTP ${searchRes.status}`);
  const searchHtml = await searchRes.text();

  const match = searchHtml.match(/href="https:\/\/hianime\.at\/([^"]+)"[^>]*title="([^"]+)"/i) ||
                searchHtml.match(/href="\/([^"]+)"[^>]*title="([^"]+)"/i);
  let numericAnimeId = '';
  if (match && match[1]) {
    numericAnimeId = match[1].split('-').pop() || '';
  }
  if (!numericAnimeId) throw new Error(`No anime found for query "${query}"`);

  // 2. Episode list
  const epRes = await fetch(`${REMOTE_HOST}/api/theme/episode/list/${numericAnimeId}`, { headers });
  if (!epRes.ok) throw new Error(`Episodes failed: HTTP ${epRes.status}`);
  const epData: any = await epRes.json();
  if (!epData.html) throw new Error('Episode list returned no HTML');

  const epMatches = Array.from((epData.html as string).matchAll(/data-number="([^"]+)"[^>]*data-id="([^"]+)"/g));
  let targetEpId = '';
  for (const m of epMatches) {
    if (m[1] === ep) {
      targetEpId = m[2];
      break;
    }
  }
  if (!targetEpId && epMatches.length > 0) {
    targetEpId = epMatches[0][2];
  }
  if (!targetEpId) throw new Error(`Episode ${ep} not found in episode list`);

  // 3. Servers
  const serversRes = await fetch(`${REMOTE_HOST}/api/theme/episode/servers?episodeId=${targetEpId}`, { headers });
  if (!serversRes.ok) throw new Error(`Servers failed: HTTP ${serversRes.status}`);
  const serversData: any = await serversRes.json();
  if (!serversData.html) throw new Error('Servers returned no HTML');

  const htmlStr = serversData.html as string;
  const hashMatch = htmlStr.match(new RegExp(`data-type="${mode}"[^>]*data-hash="([^"]+)"`, 'i')) ||
                    htmlStr.match(/data-hash="([^"]+)"/i);
  if (!hashMatch || !hashMatch[1]) throw new Error('No server embed hash found');

  const embedUrl = Buffer.from(hashMatch[1], 'base64').toString('utf8');

  // 4. Embed page
  const embedRes = await fetch(embedUrl, {
    headers: { ...headers, 'Referer': `${REMOTE_HOST}/` }
  });
  if (!embedRes.ok) throw new Error(`Embed failed: HTTP ${embedRes.status}`);
  const embedHtml = await embedRes.text();

  const idMatch = embedHtml.match(/data-id="(\d+)"/i);
  if (!idMatch || !idMatch[1]) throw new Error('No data-id in embed HTML');
  const dataId = idMatch[1];

  // 5. getSourcesNew
  const embedOrigin = new URL(embedUrl).origin;
  const sourcesUrl = `${embedOrigin}/stream/getSourcesNew?id=${dataId}`;
  const sourcesRes = await fetch(sourcesUrl, {
    headers: {
      ...headers,
      'Referer': embedUrl,
      'X-Requested-With': 'XMLHttpRequest'
    }
  });
  if (!sourcesRes.ok) throw new Error(`getSources failed: HTTP ${sourcesRes.status}`);
  const sourcesJson: any = await sourcesRes.json();

  let rawVideoLink = '';
  // Chapter markers (seconds) used for Skip Intro / Skip Outro - forwarded
  // as-is; the client validates them.
  let intro = sourcesJson.intro;
  let outro = sourcesJson.outro;
  if (sourcesJson.sources && sourcesJson.sources[0]?.file) {
    rawVideoLink = sourcesJson.sources[0].file;
  } else if (sourcesJson.enc) {
    const decStr = decryptToken(sourcesJson.enc);
    if (decStr) {
      const dec = JSON.parse(decStr);
      rawVideoLink = dec.file || dec.src;
      intro = intro || dec.intro;
      outro = outro || dec.outro;
    }
  }

  if (!rawVideoLink) throw new Error('Could not extract video link from sources payload');

  const subtitles = (sourcesJson.tracks || [])
    .filter((t: any) => t.kind === 'captions' || t.file)
    .map((s: any) => {
      const proxiedSub = `/stream-proxy?url=${encodeURIComponent(s.file || s.src)}&ref=${encodeURIComponent(embedOrigin + '/')}`;
      return {
        src: proxiedSub,
        label: s.label || s.lang || 'English',
        default: s.default === true
      };
    });

  const proxiedStreamUrl = `/stream-proxy?url=${encodeURIComponent(rawVideoLink)}&ref=${encodeURIComponent(embedOrigin + '/')}`;

  return {
    streamUrl: proxiedStreamUrl,
    rawStreamUrl: rawVideoLink,
    subtitles,
    qualities: [{ quality: '1080p', url: proxiedStreamUrl }],
    referer: `${embedOrigin}/`,
    intro,
    outro
  };
}

export function aniCliBridgePlugin(): Plugin {
  return {
    name: 'ani-cli-bridge',
    configureServer(server) {
      // 1. Endpoint: /api/ani-cli/stream?query=...&ep=1&mode=sub
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/ani-cli/stream')) {
          return next();
        }

        const reqUrl = new URL(req.url, 'http://localhost:3000');
        const query = reqUrl.searchParams.get('query') || 'solo leveling';
        const ep = reqUrl.searchParams.get('ep') || '1';
        const mode = reqUrl.searchParams.get('mode') || 'sub';

        console.log(`[ani-cli-bridge] Resolving stream: query="${query}", ep=${ep}, mode=${mode}`);

        try {
          const result = await resolveStream(query, ep, mode);
          console.log('[ani-cli-bridge] Stream resolved successfully:', result.rawStreamUrl);
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(JSON.stringify(result));
        } catch (err: any) {
          console.error('[ani-cli-bridge] Stream resolution error:', err);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err.message || 'Failed to resolve stream' }));
        }
      });

      // 2. Stream Proxy: /stream-proxy?url=...&ref=...
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/stream-proxy')) {
          return next();
        }

        const reqUrl = new URL(req.url, 'http://localhost:3000');
        const targetUrl = reqUrl.searchParams.get('url');
        const referer = reqUrl.searchParams.get('ref') || 'https://zokoanime.video/';

        if (!targetUrl) {
          res.statusCode = 400;
          res.end('Missing url query parameter');
          return;
        }

        try {
          const parsedTarget = new URL(targetUrl);
          // The dev server listens on the LAN (host: true), so this must not
          // become an open proxy into localhost / the private network.
          if (!isPublicHttpUrl(parsedTarget)) {
            res.statusCode = 403;
            res.end('Refusing to proxy this URL');
            return;
          }
          const isHttps = parsedTarget.protocol === 'https:';
          const client = isHttps ? https : http;

          const options: https.RequestOptions = {
            hostname: parsedTarget.hostname,
            port: parsedTarget.port || (isHttps ? 443 : 80),
            path: parsedTarget.pathname + parsedTarget.search,
            method: 'GET',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              'Referer': referer,
              'Origin': referer.replace(/\/$/, '')
            }
          };

          const proxyReq = client.request(options, (proxyRes) => {
            // CORS headers
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', '*');

            const contentType = proxyRes.headers['content-type'] || '';
            res.statusCode = proxyRes.statusCode || 200;

            const isM3U8 = targetUrl.includes('.m3u8') || contentType.includes('mpegurl');

            if (isM3U8) {
              // Rewrite relative segments, sub-playlists, keys, and media URIs in M3U8 playlist
              let body = '';
              proxyRes.setEncoding('utf8');
              proxyRes.on('data', (chunk) => { body += chunk; });
              proxyRes.on('end', () => {
                const rewritten = body.split('\n').map(line => {
                  const trimmed = line.trim();
                  if (!trimmed) return line;

                  // 1. Rewrite any URI="..." or URI='...' attributes inside tag lines (e.g. #EXT-X-STREAM-INF, #EXT-X-MEDIA, #EXT-X-KEY, #EXT-X-MAP)
                  if (trimmed.startsWith('#')) {
                    if (trimmed.includes('URI=')) {
                      return line.replace(/URI=(["'])([^"']+)\1/g, (_match, quote, uri) => {
                        const fullUrl = new URL(uri, targetUrl).toString();
                        const proxied = `/stream-proxy?url=${encodeURIComponent(fullUrl)}&ref=${encodeURIComponent(referer)}`;
                        return `URI=${quote}${proxied}${quote}`;
                      });
                    }
                    return line;
                  }

                  // 2. Rewrite non-# lines (segment or sub-playlist URLs) using proper URL resolution
                  const fullUrl = new URL(trimmed, targetUrl).toString();
                  return `/stream-proxy?url=${encodeURIComponent(fullUrl)}&ref=${encodeURIComponent(referer)}`;
                }).join('\n');

                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                res.end(rewritten);
              });
            } else {
              // Binary / video segment (.ts) or subtitles (.vtt)
              if (contentType) {
                res.setHeader('Content-Type', contentType);
              }
              proxyRes.pipe(res);
            }
          });

          proxyReq.on('error', (err) => {
            console.error('[stream-proxy] Error proxying stream:', err);
            res.statusCode = 502;
            res.end('Proxy error: ' + err.message);
          });

          proxyReq.end();
        } catch (err: any) {
          res.statusCode = 500;
          res.end('Invalid URL: ' + err.message);
        }
      });
    }
  };
}
