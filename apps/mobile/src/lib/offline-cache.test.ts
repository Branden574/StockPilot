import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { clearOfflineCache, type OfflineCacheDeps } from './offline-cache';

function deps(over: Partial<OfflineCacheDeps> = {}) {
  const calls: string[] = [];
  const d: OfflineCacheDeps = {
    isOnline: vi.fn(async () => true),
    deleteOrgData: vi.fn(async () => {
      calls.push('delete');
    }),
    syncNow: vi.fn(async (force: boolean) => {
      calls.push(`sync:${force}`);
    }),
    refreshEffectivePermissions: vi.fn(() => {
      calls.push('perms');
    }),
    refreshWarehouseScope: vi.fn(() => {
      calls.push('scope');
    }),
    ...over,
  };
  return { d, calls };
}

describe('clearOfflineCache (Settings > Offline cache > Clear)', () => {
  it('really clears: wipes the org cache, forces a FULL pull, then refreshes the hooks', async () => {
    const { d, calls } = deps();
    await expect(clearOfflineCache(d)).resolves.toEqual({ ok: true });
    expect(calls).toEqual(['delete', 'sync:true', 'perms', 'scope']);
  });

  it('refuses while offline and touches nothing (no copy it could not refill)', async () => {
    const { d, calls } = deps({ isOnline: vi.fn(async () => false) });
    await expect(clearOfflineCache(d)).resolves.toEqual({ ok: false, reason: 'offline' });
    expect(calls).toEqual([]);
  });

  it('a failed wipe surfaces (no false "Cleared") and skips the pull', async () => {
    const { d, calls } = deps({
      deleteOrgData: vi.fn(async () => {
        throw new Error('db locked');
      }),
    });
    await expect(clearOfflineCache(d)).rejects.toThrow('db locked');
    expect(calls).toEqual([]);
  });
});

describe('Settings wiring (source pins)', () => {
  const src = readFileSync(path.resolve(__dirname, '../../app/(drawer)/settings.tsx'), 'utf8');

  it('the Clear button calls clearOfflineCache with the real wipe and a forced sync', () => {
    const at = src.indexOf("title=\"Offline cache\"");
    const block = src.slice(at, at + 2500);
    expect(block).toMatch(/clearOfflineCache\(\{/);
    expect(block).toMatch(/deleteOrgData/);
    expect(block).toMatch(/syncNow/);
  });

  it('never claims "Cleared" without running the wipe', () => {
    const at = src.indexOf("title=\"Offline cache\"");
    const block = src.slice(at, at + 2500);
    const cleared = block.indexOf("'Cleared'");
    const call = block.indexOf('clearOfflineCache(');
    expect(call).toBeGreaterThan(-1);
    expect(cleared).toBeGreaterThan(call);
  });
});
