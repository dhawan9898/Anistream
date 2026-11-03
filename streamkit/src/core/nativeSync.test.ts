import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error plain .mjs build script without type declarations
import { syncNative } from '../../android/sync-native.mjs';

test('syncNative stamps the package, copies drawables, and reports drift in check mode', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-'));
  const javaDir = join(root, 'java'), resDir = join(root, 'res');
  const changed = syncNative({ packageName: 'com.example.app', javaDir, resDir });
  assert.ok(changed.length > 10);
  const java = readFileSync(join(javaDir, 'ThumbnailSprites.java'), 'utf8');
  assert.match(java, /^package com\.example\.app;/);
  assert.ok(!java.includes('__APP_PACKAGE__'));
  assert.ok(existsSync(join(resDir, 'drawable', 'ic_play.xml')));
  assert.deepEqual(syncNative({ packageName: 'com.example.app', javaDir, resDir, check: true }), []);
  assert.equal(syncNative({ packageName: 'com.other', javaDir, resDir, check: true }).length, 1, 'only the Java file depends on the package');
});
