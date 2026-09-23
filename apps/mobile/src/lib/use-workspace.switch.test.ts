import { describe, expect, it, vi } from 'vitest';

import { setActiveOrg } from './use-workspace';

// vi.mock / vi.hoisted are hoisted above these imports by vitest's transform.
// Everything use-workspace.ts reaches for at runtime is replaced, so the real
// setActiveOrg runs under node.

const store = vi.hoisted(() => new Map<string, string>());
const storage = vi.hoisted(() => ({
  getItem: vi.fn(async (k: string) => store.get(k) ?? null),
  setItem: vi.fn(async (k: string, v: string) => {
    store.set(k, v);
  }),
  removeItem: vi.fn(async (k: string) => {
    store.delete(k);
  }),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));
vi.mock('./auth-context', () => ({ useAuth: vi.fn() }));
const dbMock = vi.hoisted(() => ({ deleteOrgData: vi.fn(async () => {}) }));
vi.mock('./db', () => dbMock);
vi.mock('./enabled-modules', () => ({ refreshEnabledModules: vi.fn() }));
const syncMock = vi.hoisted(() => ({ syncNow: vi.fn(async () => {}) }));
vi.mock('./sync', () => syncMock);
vi.mock('./supabase', () => {
  // loadWarehouses: from('warehouses').select().eq().order() -> { data, error }
  const query = {
    select: () => query,
    eq: () => query,
    order: async () => ({ data: [], error: null }),
  };
  return { supabase: { from: () => query } };
});

const orgWrites = () =>
  storage.setItem.mock.calls.filter(([k]) => k === 'workspace.activeOrgId').map(([, v]) => v);

describe('setActiveOrg: one switch at a time, the last choice wins', () => {
  it('a re-tap of the still-highlighted workspace during a switch is applied, not lost', async () => {
    await setActiveOrg('org-b'); // B is the active workspace
    storage.setItem.mockClear();
    syncMock.syncNow.mockClear();

    // The switch to C waits in the cache wipe (behind a pull that is mid-write).
    let releaseWipe: (() => void) | undefined;
    dbMock.deleteOrgData.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseWipe = resolve;
        }),
    );
    const toC = setActiveOrg('org-c');
    await vi.waitFor(() => expect(releaseWipe).toBeDefined());
    // B is still highlighted in the sheet; the person taps it again.
    const backToB = setActiveOrg('org-b');
    releaseWipe?.();
    await Promise.all([toC, backToB]);

    expect(orgWrites()).toEqual(['org-c', 'org-b']);
    expect(syncMock.syncNow).toHaveBeenCalledTimes(2);
    expect(syncMock.syncNow).toHaveBeenLastCalledWith(true);

    // B is what the app now shows: choosing it again changes nothing.
    storage.setItem.mockClear();
    await setActiveOrg('org-b');
    expect(orgWrites()).toEqual([]);
  });

  it('two switches asked for back to back publish in order and end on the second', async () => {
    storage.setItem.mockClear();
    const first = setActiveOrg('org-d');
    const second = setActiveOrg('org-e');
    await Promise.all([first, second]);
    expect(orgWrites()).toEqual(['org-d', 'org-e']);
    storage.setItem.mockClear();
    await setActiveOrg('org-e');
    expect(orgWrites()).toEqual([]);
  });

  it('a failed switch does not block the next one', async () => {
    dbMock.deleteOrgData.mockClear();
    storage.setItem.mockImplementationOnce(async () => {
      throw new Error('storage full');
    });
    await expect(setActiveOrg('org-f')).rejects.toThrow('storage full');
    storage.setItem.mockClear();
    await setActiveOrg('org-g');
    expect(orgWrites()).toEqual(['org-g']);
  });
});
