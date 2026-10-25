/**
 * ONLY THE NEWEST READ LANDS.
 *
 * For a display fact a screen reads on its own, outside a load that already
 * drops stale answers with a sequence number of its own (the Movements list,
 * Receive POs and the home screen keep theirs inside their load): the item
 * screen's organization zone, and Staging's warehouse names and zone. Two
 * reads can be out at once (a refresh while the first read is still out, or a
 * workspace switch), and they can answer in either order. Only the answer to
 * the newest read is handed to `land`, so a late answer for the previous
 * workspace never replaces the current one's (slice 3 review, 2026-10-24).
 *
 * A read that throws answers `failed`, so `read` never rejects and a refresh
 * that waits for it always ends. Pure: no React Native import, so it is tested
 * on its own (newest-read.test.ts).
 */
export interface NewestRead<K> {
  /** Reads for `key`. Its answer lands unless a later read, or cancel(),
   *  came first. Never rejects. */
  read(key: K): Promise<void>;
  /** The key whose newest read is still out, or null. */
  pendingFor(): K | null;
  /** Drops the answer still out, if any (the screen's workspace went away). */
  cancel(): void;
}

export function createNewestRead<K, T>(
  fetch: (key: K) => Promise<T>,
  land: (key: K, value: T) => void,
  failed: T,
): NewestRead<K> {
  let newest = 0;
  let pending: K | null = null;
  return {
    async read(key) {
      const seq = ++newest;
      pending = key;
      let value: T;
      try {
        value = await fetch(key);
      } catch {
        value = failed;
      }
      if (seq !== newest) return;
      pending = null;
      land(key, value);
    },
    pendingFor: () => pending,
    cancel() {
      newest += 1;
      pending = null;
    },
  };
}
