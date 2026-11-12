import type { AppearanceStorage } from '../store';

/**
 * An in-memory AsyncStorage for the appearance tests that records every key it
 * is asked about, so a test can prove which keys the appearance reads and
 * writes (and that it touches nothing else: the outbox, the workspace keys).
 */
export class FakeStorage implements AppearanceStorage {
  readonly data = new Map<string, string>();
  readonly touched = new Set<string>();
  failReads = false;
  failWrites = false;

  constructor(seed: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(seed)) this.data.set(k, v);
  }

  async getItem(key: string): Promise<string | null> {
    this.touched.add(key);
    if (this.failReads) throw new Error('read refused');
    return this.data.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.touched.add(key);
    if (this.failWrites) throw new Error('write refused');
    this.data.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.touched.add(key);
    if (this.failWrites) throw new Error('write refused');
    this.data.delete(key);
  }

  json(key: string): unknown {
    const raw = this.data.get(key);
    return raw === undefined ? undefined : JSON.parse(raw);
  }
}
