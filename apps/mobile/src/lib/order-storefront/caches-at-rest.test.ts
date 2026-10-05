import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { orderCacheKeys, removeOrderCachesAtRest } from './caches-at-rest';

/**
 * L137: a sign-out the person did not ask for (the session revoked from the
 * web, an account eviction's own sign-out) cleared none of the phone's
 * storage, so the last order catalog and the photo map with its signed URLs
 * stayed at rest. The deliberate sign-out already removes every `workspace.`
 * key. An involuntary one now removes those two caches; the active
 * organization and warehouse, the order prefs and the carts stay, so the
 * person who signs back in finds their cart.
 */
const KEYS = [
  'workspace.orderCatalog.v1.u1.o1.w1',
  'workspace.orderCatalog.v1.u2.o1.w2',
  'workspace.orderPhotos.v1.u1.o1.w1',
  'workspace.orderDraft.v1.u1.o1.w1',
  'workspace.orderPrefs.v1.u1.o1',
  'workspace.activeOrgId',
  'workspace.warehouse.o1',
  'whatsNew.seen',
];

describe('orderCacheKeys', () => {
  it('names only the catalog and photo caches (every account), never prefs, drafts or the workspace', () => {
    expect(orderCacheKeys(KEYS)).toEqual([
      'workspace.orderCatalog.v1.u1.o1.w1',
      'workspace.orderCatalog.v1.u2.o1.w2',
      'workspace.orderPhotos.v1.u1.o1.w1',
    ]);
  });
});

describe('removeOrderCachesAtRest', () => {
  it('removes those keys in one call', async () => {
    const store = {
      getAllKeys: vi.fn(async () => KEYS),
      multiRemove: vi.fn(async (_k: readonly string[]) => {}),
    };
    await removeOrderCachesAtRest(store);
    expect(store.multiRemove).toHaveBeenCalledWith([
      'workspace.orderCatalog.v1.u1.o1.w1',
      'workspace.orderCatalog.v1.u2.o1.w2',
      'workspace.orderPhotos.v1.u1.o1.w1',
    ]);
  });

  it('is best-effort: a storage failure never throws, and nothing to remove makes no call', async () => {
    const failing = {
      getAllKeys: vi.fn(async () => {
        throw new Error('storage unavailable');
      }),
      multiRemove: vi.fn(async () => {}),
    };
    await expect(removeOrderCachesAtRest(failing)).resolves.toBeUndefined();
    const empty = { getAllKeys: vi.fn(async () => ['whatsNew.seen']), multiRemove: vi.fn(async () => {}) };
    await removeOrderCachesAtRest(empty);
    expect(empty.multiRemove).not.toHaveBeenCalled();
  });
});

describe('auth-context wiring (L137)', () => {
  const src = readFileSync(path.resolve(__dirname, '../auth-context.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  // Mutation caught: the removal dropped, or run on every null-session event
  // (a fresh install's INITIAL_SESSION) instead of the involuntary end only.
  it('removes the caches on an involuntary session end, beside markSessionEnded', () => {
    expect(src).toMatch(
      /const involuntary = isInvoluntarySessionEnd\(event, Boolean\(s\?\.user\)\);\s*if \(involuntary\) markSessionEnded\(\);\s*if \(involuntary\) void removeOrderCachesAtRest\(AsyncStorage\);/,
    );
  });
});
