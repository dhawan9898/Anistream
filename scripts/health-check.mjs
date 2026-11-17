// health-check.mjs - Live check that the streaming site still works end to end, run daily by
// .github/workflows/health-check.yml.   Run: node scripts/health-check.mjs
//
// It walks the same steps the app does for an episode: the site's home page -> a title's episode
// list -> the episode's servers -> a server's player page -> the stream's playlist. The run fails
// (and GitHub mails the repository owner) when a step breaks; when the site has only moved,
// editing "host" in site-config.json fixes every installed app without a release.
import { readFileSync, appendFileSync } from 'node:fs';

const host = JSON.parse(readFileSync(new URL('../site-config.json', import.meta.url), 'utf8')).host;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const steps = [];

async function get(url, referer, extra = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: referer, ...extra }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function step(name, run) {
  try {
    const detail = await run();
    steps.push({ name, ok: true, detail });
    console.log(`OK   ${name}: ${detail}`);
    return true;
  } catch (e) {
    steps.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

function decodePayload(html) {
  const m = html.match(/window\.__P\s*=\s*"([^"]+)"/);
  if (!m) return null;
  const raw = Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const key = Buffer.from('otaku-embed-v1');
  return JSON.parse(Buffer.from(raw.map((b, i) => b ^ key[i % key.length])).toString('utf8'));
}

let titleIds = [];
let episodeId = '';
let embeds = [];

const ok =
  (await step('home page', async () => {
    const html = await get(`${host}/home`, `${host}/`);
    titleIds = [...new Set([...html.matchAll(/data-id="(\d+)"/g)].map(m => m[1]))];
    if (titleIds.length < 5) throw new Error(`only ${titleIds.length} titles found on ${host}/home`);
    return `${titleIds.length} titles on ${host}`;
  })) &&
  (await step('episode list', async () => {
    for (const id of titleIds.slice(0, 6)) {
      const html = JSON.parse(await get(`${host}/api/theme/episode/list/${id}`, `${host}/`)).html ?? '';
      const ids = [...html.matchAll(/data-id="(\d+)"/g)].map(m => m[1]);
      if (ids.length) { episodeId = ids[0]; return `title ${id}: ${ids.length} episodes`; }
    }
    throw new Error('no title returned an episode list');
  })) &&
  (await step('episode servers', async () => {
    const html = JSON.parse(await get(`${host}/api/theme/episode/servers?episodeId=${episodeId}`, `${host}/`)).html ?? '';
    for (const tag of html.match(/<[^>]*\bdata-hash\s*=\s*["'][^"']*["'][^>]*>/g) ?? []) {
      const hash = tag.match(/data-hash\s*=\s*["']([^"']*)/)?.[1];
      const type = tag.match(/data-type\s*=\s*["']([^"']*)/)?.[1] ?? '?';
      const url = hash ? Buffer.from(hash, 'base64').toString('utf8').trim() : '';
      if (/^https?:\/\//.test(url)) embeds.push({ type, url });
    }
    if (!embeds.length) throw new Error(`no servers for episode ${episodeId}`);
    return `${embeds.length} servers (${[...new Set(embeds.map(e => e.type))].join(', ')})`;
  })) &&
  (await step('stream', async () => {
    const failures = [];
    for (const { type, url } of embeds) {
      try {
        const html = await get(url, `${host}/`);
        const origin = new URL(url).origin;
        let src = decodePayload(html)?.src;
        if (!src) {
          const id = html.match(/data-id="(\d+)"/i)?.[1];
          if (!id) throw new Error('player page has neither an inline payload nor a data-id');
          const sources = JSON.parse(await get(`${origin}/stream/getSourcesNew?id=${id}`, url, { 'X-Requested-With': 'XMLHttpRequest' }));
          src = sources.sources?.[0]?.file;
          if (!src) throw new Error(sources.enc ? 'sources are encrypted (not checked here)' : 'no sources');
        }
        const playlist = await get(src, `${origin}/`);
        if (!playlist.trimStart().startsWith('#EXTM3U')) throw new Error('the stream address did not return a playlist');
        return `${type} stream plays from ${new URL(url).hostname}`;
      } catch (e) {
        failures.push(`${new URL(url).hostname}: ${e instanceof Error ? e.message : e}`);
      }
    }
    throw new Error(`no server gave a playable stream (${failures.join('; ')})`);
  }));

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## AniStream site check (${host})\n\n| | Step | Result |\n|---|---|---|\n${steps.map(s => `| ${s.ok ? '✅' : '❌'} | ${s.name} | ${s.detail} |`).join('\n')}\n`);
}
process.exit(ok ? 0 : 1);
