// sync-streamkit.mjs - Refreshes the vendored ./streamkit copy from the canonical
// streamkit repo, then reinstalls it. Usage: node scripts/sync-streamkit.mjs [../streamkit]
import { cpSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const source = resolve(process.argv[2] ?? '../streamkit');
if (!existsSync(join(source, 'package.json'))) throw new Error(`No streamkit package at ${source}`);

for (const part of ['src', 'assets', 'android', 'package.json', 'README.md']) {
  rmSync(join('streamkit', part), { recursive: true, force: true });
  cpSync(join(source, part), join('streamkit', part), { recursive: true });
}
rmSync('node_modules/streamkit', { recursive: true, force: true });
execSync('npm install', { stdio: 'inherit' });
console.log('streamkit synced from', source);
