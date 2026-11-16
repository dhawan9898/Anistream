// updateService.ts - In-app APK updates from GitHub releases
import { Capacitor } from '@capacitor/core';
import { DownloadsPlugin } from '../plugins/downloadsPlugin';

declare const __APP_VERSION__: string;

export interface UpdateInfo {
  version: string;
  tagName: string;
  releaseName: string;
  releaseNotes: string;
  apkUrl: string;
  publishedAt: string;
  htmlUrl: string;
}

/**
 * Normalizes version strings ("v10.15" -> [10, 15]) and compares them.
 * Returns > 0 if candidate is newer than current, < 0 if older, 0 if equal.
 */
export function compareSemver(candidate: string, current: string): number {
  const parse = (v: string) =>
    v.replace(/^v/i, '')
      .split(/[-+.]/)
      .map(part => {
        const num = parseInt(part, 10);
        return isNaN(num) ? 0 : num;
      });

  const p1 = parse(candidate);
  const p2 = parse(current);
  const len = Math.max(p1.length, p2.length);

  for (let i = 0; i < len; i++) {
    const a = p1[i] ?? 0;
    const b = p2[i] ?? 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

/**
 * Queries GitHub releases API for the latest release asset and returns UpdateInfo
 * if a newer release is published with an APK asset.
 */
export async function checkForUpdate(
  repo = 'dhawan9898/Anistream',
  currentVersion = (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.0')
): Promise<UpdateInfo | null> {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'AniStream-App'
    }
  });

  if (!res.ok) {
    throw new Error(`GitHub update check failed with HTTP ${res.status}`);
  }

  const data = await res.json();
  const tagName = data.tag_name || '';
  const version = tagName.replace(/^v/i, '');

  if (compareSemver(version, currentVersion) <= 0) {
    return null; // Already up to date
  }

  // Find APK asset
  const assets: Array<{ name: string; browser_download_url: string }> = data.assets || [];
  const apkAsset = assets.find(a => a.name.toLowerCase().endsWith('.apk'));

  if (!apkAsset) {
    return null; // Release exists but no APK asset
  }

  return {
    version,
    tagName,
    releaseName: data.name || tagName,
    releaseNotes: data.body || '',
    apkUrl: apkAsset.browser_download_url,
    publishedAt: data.published_at || '',
    htmlUrl: data.html_url || `https://github.com/${repo}/releases`
  };
}

/**
 * Downloads and triggers Android package installation on native devices,
 * or opens the direct download URL in the browser.
 */
export async function installUpdate(
  apkUrl: string,
  onProgress?: (percent: number) => void
): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    let handle: { remove: () => void } | null = null;
    if (onProgress) {
      handle = await DownloadsPlugin.addListener('apkUpdateProgress', e => {
        onProgress(e.percent);
      });
    }

    try {
      await DownloadsPlugin.downloadAndInstallApk({ url: apkUrl });
    } finally {
      handle?.remove();
    }
  } else {
    // Web / browser environment: trigger direct browser download
    window.open(apkUrl, '_blank');
  }
}
