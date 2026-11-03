import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEmbedPayload } from './aniCliCore.ts';

// Builds the page the way current embeds do: window.__P = base64(XOR(json)).
function embedPage(payload: unknown): string {
  const key = 'otaku-embed-v1';
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let raw = '';
  for (let i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i] ^ key.charCodeAt(i % key.length));
  return `<html><script>window.__P="${btoa(raw)}"</script></html>`;
}

test('decodes the inline payload, including non-ASCII labels', () => {
  const payload = {
    src: 'https://cdn.example/master.m3u8',
    subtitles: [{ lang: 'pt', label: 'Português', default: false, src: 'https://cdn.example/pt.vtt' }],
    skip: { intro: { start: 254, end: 340 } },
    sprite_vtt: 'https://cdn.example/sprite.vtt'
  };
  assert.deepEqual(parseEmbedPayload(embedPage(payload)), payload);
});

test('returns null for pages without a payload or with a damaged one', () => {
  assert.equal(parseEmbedPayload('<html>no payload</html>'), null);
  assert.equal(parseEmbedPayload('<script>window.__P="@@@"</script>'), null);
});
