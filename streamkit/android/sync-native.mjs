// sync-native.mjs - Copies the native pieces shared by both apps (the player's
// drawables and the thumbnail-sprite parser) into an Android project, stamping
// the app's package name into the Java sources.
//
// CLI:   node sync-native.mjs --package com.example.app --java <dir> --res <dir> [--check true]
// --check only reports drift (exit 1) instead of writing.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function sharedNativeFiles(packageName) {
  const files = [];
  for (const f of readdirSync(join(here, 'java'))) {
    files.push({
      to: (javaDir) => join(javaDir, f),
      content: readFileSync(join(here, 'java', f), 'utf8').replaceAll('__APP_PACKAGE__', packageName)
    });
  }
  for (const f of readdirSync(join(here, 'res/drawable'))) {
    files.push({
      to: (_javaDir, resDir) => join(resDir, 'drawable', f),
      content: readFileSync(join(here, 'res/drawable', f), 'utf8')
    });
  }
  return files;
}

/** Returns the list of files that were (or, in check mode, would be) changed. */
export function syncNative({ packageName, javaDir, resDir, check = false }) {
  const changed = [];
  for (const file of sharedNativeFiles(packageName)) {
    const target = file.to(javaDir, resDir);
    const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
    const norm = (s) => (s ? s.replace(/\r\n/g, '\n') : s);
    if (norm(current) === norm(file.content)) continue;
    changed.push(target);
    if (!check) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content);
    }
  }
  return changed;
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const packageName = arg('package');
  const javaDir = arg('java');
  const resDir = arg('res');
  if (!packageName || !javaDir || !resDir) throw new Error('Usage: sync-native.mjs --package P --java DIR --res DIR [--check true]');
  const check = arg('check') === 'true';
  const changed = syncNative({ packageName, javaDir, resDir, check });
  if (check && changed.length) {
    console.error('Native files differ from streamkit:\n  ' + changed.join('\n  '));
    process.exit(1);
  }
  console.log(check ? 'Native files match streamkit.' : `Synced ${changed.length} changed native file(s).`);
}
