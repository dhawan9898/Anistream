import { useEffect, useSyncExternalStore } from 'react';
import { getDownloadsSnapshot, initDownloads, subscribeDownloads, type DownloadRecord } from './downloadService';

/** Live list of downloads (newest first). Loads them from storage on first use. */
export function useDownloads(): DownloadRecord[] {
  useEffect(() => { void initDownloads(); }, []);
  return useSyncExternalStore(subscribeDownloads, getDownloadsSnapshot, getDownloadsSnapshot);
}
