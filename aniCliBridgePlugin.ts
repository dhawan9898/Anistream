// aniCliBridgePlugin.ts - Vite plugin bridging the real ani-cli shell core & streaming proxy
import type { Plugin } from 'vite';
import { exec } from 'child_process';
import path from 'path';
import https from 'https';
import http from 'http';
import { URL } from 'url';

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
        const dubFlag = mode === 'dub' ? '--dub' : '';

        console.log(`[ani-cli-bridge] Invoking ani-cli: query="${query}", ep=${ep}, mode=${mode}`);

        const projectRoot = path.resolve(process.cwd(), '..');
        const shPath = 'C:\\Program Files\\Git\\bin\\sh.exe';
        const aniCliPath = './ani-cli/ani-cli';
        const cmd = `"${shPath}" -c "ANI_CLI_MENU=cat ANI_CLI_PLAYER=debug ${aniCliPath} ${dubFlag} -e ${ep} -S 1 '${query.replace(/'/g, "")}'"`;

        exec(cmd, { cwd: projectRoot, timeout: 25000 }, (error, stdout, stderr) => {
          if (error) {
            console.error('[ani-cli-bridge] ani-cli error:', error, stderr);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Failed to resolve stream with ani-cli', details: stderr }));
            return;
          }

          console.log('[ani-cli-bridge] ani-cli stdout:', stdout);

          // Parse stdout
          const selectedLinkMatch = stdout.match(/Selected link:\s*([^\r\n]+)/);
          const subtitlesMatch = stdout.match(/Subtitles:\s*([^\r\n]+)/);
          const allLinksSection = stdout.match(/All links:\s*([\s\S]*?)Selected link:/);

          const rawVideoLink = selectedLinkMatch ? selectedLinkMatch[1].trim() : '';
          const rawSubLink = subtitlesMatch ? subtitlesMatch[1].trim() : '';

          if (!rawVideoLink) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'No video stream found in ani-cli output' }));
            return;
          }

          // Parse qualities
          const qualities: { quality: string; url: string }[] = [];
          if (allLinksSection && allLinksSection[1]) {
            const lines = allLinksSection[1].split('\n');
            for (const line of lines) {
              const qMatch = line.match(/^([0-9]+)\s*>\s*(https?:\/\/[^\s]+)/);
              if (qMatch) {
                const qLabel = `${qMatch[1]}p`;
                const proxiedUrl = `/stream-proxy?url=${encodeURIComponent(qMatch[2])}&ref=${encodeURIComponent('https://zokoanime.video/')}`;
                qualities.push({ quality: qLabel, url: proxiedUrl });
              }
            }
          }

          // Fallback or main stream proxy URL
          const proxiedStreamUrl = `/stream-proxy?url=${encodeURIComponent(rawVideoLink)}&ref=${encodeURIComponent('https://zokoanime.video/')}`;
          const proxiedSubUrl = rawSubLink 
            ? `/stream-proxy?url=${encodeURIComponent(rawSubLink)}&ref=${encodeURIComponent('https://zokoanime.video/')}`
            : '';

          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(JSON.stringify({
            streamUrl: proxiedStreamUrl,
            rawStreamUrl: rawVideoLink,
            subtitles: proxiedSubUrl ? [{ src: proxiedSubUrl, label: 'English', default: true }] : [],
            qualities: qualities.length > 0 ? qualities : [{ quality: '1080p', url: proxiedStreamUrl }],
            referer: 'https://zokoanime.video/'
          }));
        });
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
