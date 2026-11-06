// set-version.mjs - Stamps a version "MAJOR.MINOR" into package.json and
// android/app/build.gradle (versionName + versionCode = major * 100 + minor,
// the formula scripts/check-version.mjs enforces).
//
// CI uses it to give every build of main its own incrementing version
// without committing back to the repo:  node scripts/set-version.mjs 10.4
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
const match = /^(\d+)\.(\d+)$/.exec(version ?? '');
if (!match) {
  console.error('Usage: node scripts/set-version.mjs MAJOR.MINOR   (e.g. 10.4)');
  process.exit(1);
}
const [major, minor] = [Number(match[1]), Number(match[2])];
if (minor > 99) {
  // versionCode = major * 100 + minor would collide with the next major.
  console.error(`Minor version ${minor} is above 99: bump the major version instead.`);
  process.exit(1);
}

const pkgUrl = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8'));
pkg.version = `${major}.${minor}.0`;
writeFileSync(pkgUrl, JSON.stringify(pkg, null, 2) + '\n');

const gradleUrl = new URL('../android/app/build.gradle', import.meta.url);
const gradle = readFileSync(gradleUrl, 'utf8')
  .replace(/versionCode\s+\d+/, `versionCode ${major * 100 + minor}`)
  .replace(/versionName\s+"[^"]*"/, `versionName "${major}.${minor}"`);
writeFileSync(gradleUrl, gradle);

console.log(`Version set to ${major}.${minor} (versionCode ${major * 100 + minor})`);
