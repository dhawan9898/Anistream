// boundedCache.ts - Keeps the in-memory lookup caches from growing for as long
// as the app stays open. A Map iterates in insertion order, so the entries
// dropped are the ones added longest ago; anything dropped is simply looked
// up again (the disk cache answers most of those).
export function trimOldest(map: Map<unknown, unknown>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}
