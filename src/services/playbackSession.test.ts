import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPreferredQuality } from './playbackSession.ts';
import { formatTime } from 'streamkit/player/playerUtils.ts';
import type { StreamSource } from '../providers/aniCliCore.ts';
import { DEFAULT_PREFERENCES } from './historyService.ts';

const source = (over: Partial<StreamSource> = {}): StreamSource => ({
  streamUrl: 'https://x/1080.m3u8',
  quality: '1080p',
  subtitles: [],
  qualities: [
    { quality: '1080p', url: 'https://x/1080.m3u8' },
    { quality: '720p', url: 'https://x/720.m3u8' }
  ],
  ...over
}) as StreamSource;

test('applyPreferredQuality switches to a distinct preferred rendition', () => {
  const out = applyPreferredQuality(source(), { ...DEFAULT_PREFERENCES, defaultQuality: '720p' });
  assert.equal(out.streamUrl, 'https://x/720.m3u8');
  assert.equal(out.quality, '720p');
});

test('applyPreferredQuality keeps the source when the URL is the same or the quality is unknown', () => {
  const s = source();
  assert.equal(applyPreferredQuality(s, { ...DEFAULT_PREFERENCES, defaultQuality: '1080p' }), s);
  assert.equal(applyPreferredQuality(s, { ...DEFAULT_PREFERENCES, defaultQuality: '360p' }), s);
});

test('formatTime renders m:ss and h:mm:ss and survives bad input', () => {
  assert.equal(formatTime(65), '1:05');
  assert.equal(formatTime(3725), '1:02:05');
  assert.equal(formatTime(NaN), '0:00');
  assert.equal(formatTime(-5), '0:00');
});
