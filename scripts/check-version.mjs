// check-version.mjs - Fails the build when the app version is inconsistent.
//
// Android installs an update only when its versionCode is higher than the
// installed one. v7.0 shipped versionCode 10 while v6.4 (released from a
// side branch) was already 14, so every v6.4 install refused the update.
// From v7.1 on the code is derived from the version name - major * 100 +
// minor - so a higher version name always means a higher versionCode, and
// this check keeps package.json, build.gradle and the formula in sync.
import { readFileSync } from 'node:fs';

// Highest versionCode ever published (v6.4 = 14, v7.0 = 10). Nothing may
// ship at or below it.
const HIGHEST_PUBLISHED_VERSION_CODE = 14;

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const gradle = readFileSync(new URL('../android/app/build.gradle', import.meta.url), 'utf8');

const code = Number(gradle.match(/versionCode\s+(\d+)/)?.[1]);
const name = gradle.match(/versionName\s+"([^"]+)"/)?.[1];
const [major, minor] = String(pkg.version).split('.').map(Number);

const errors = [];
if (name !== `${major}.${minor}`) {
  errors.push(`build.gradle versionName "${name}" does not match package.json ${pkg.version} (expected "${major}.${minor}")`);
}
if (code !== major * 100 + minor) {
  errors.push(`versionCode ${code} should be ${major * 100 + minor} (major * 100 + minor for ${major}.${minor})`);
}
if (!(code > HIGHEST_PUBLISHED_VERSION_CODE)) {
  errors.push(`versionCode ${code} is not above the highest published code ${HIGHEST_PUBLISHED_VERSION_CODE} - devices would refuse the update`);
}

if (errors.length > 0) {
  console.error('Version check failed:\n - ' + errors.join('\n - '));
  process.exit(1);
}
console.log(`Version OK: ${name} (versionCode ${code})`);
