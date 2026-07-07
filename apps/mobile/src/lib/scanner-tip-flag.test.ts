import { beforeEach, describe, expect, it, vi } from 'vitest';

// expo-secure-store is a native module — mocked wholesale (vitest runs in
// node). The flag module keeps in-memory session state, so tests that need a
// "fresh app launch" re-import it via vi.resetModules(), same pattern as
// document-scanner.test.ts. vi.hoisted keeps stable fn handles across resets.
const store = vi.hoisted(() => ({
  getItemAsync: vi.fn<(key: string) => Promise<string | null>>(),
  setItemAsync: vi.fn<(key: string, value: string) => Promise<void>>(),
}));

vi.mock('expo-secure-store', () => store);

/** Import a fresh copy of the module — simulates a new app session. */
async function freshSession() {
  vi.resetModules();
  return import('./scanner-tip-flag');
}

beforeEach(() => {
  store.getItemAsync.mockReset().mockResolvedValue(null);
  store.setItemAsync.mockReset().mockResolvedValue(undefined);
});

describe('hasSeenScanTip', () => {
  it('is false on a fresh install (no stored marker) — the tip shows', async () => {
    const flag = await freshSession();
    await expect(flag.hasSeenScanTip()).resolves.toBe(false);
    expect(store.getItemAsync).toHaveBeenCalledWith('scan-tip-seen-v1');
  });

  it('is true when a previous session persisted the marker', async () => {
    store.getItemAsync.mockResolvedValue('1');
    const flag = await freshSession();
    await expect(flag.hasSeenScanTip()).resolves.toBe(true);
  });

  it('treats a storage read failure as unseen (never rejects — a broken keystore must not hide the tip forever or block the flow)', async () => {
    store.getItemAsync.mockRejectedValue(new Error('keystore unavailable'));
    const flag = await freshSession();
    await expect(flag.hasSeenScanTip()).resolves.toBe(false);
  });
});

describe('markScanTipSeen', () => {
  it('persists the marker under the versioned key', async () => {
    const flag = await freshSession();
    await flag.markScanTipSeen();
    expect(store.setItemAsync).toHaveBeenCalledWith('scan-tip-seen-v1', '1');
  });

  it('transitions unseen → seen for the session, short-circuiting later storage reads', async () => {
    const flag = await freshSession();
    await expect(flag.hasSeenScanTip()).resolves.toBe(false);

    await flag.markScanTipSeen();

    // Even if the persisted write never landed, the session flag answers —
    // and the keystore is not re-read once seen.
    store.getItemAsync.mockResolvedValue(null);
    await expect(flag.hasSeenScanTip()).resolves.toBe(true);
    expect(store.getItemAsync).toHaveBeenCalledTimes(1);
  });

  it('never rejects when the write fails — the scan flow must not be blocked', async () => {
    store.setItemAsync.mockRejectedValue(new Error('keystore unavailable'));
    const flag = await freshSession();
    await expect(flag.markScanTipSeen()).resolves.toBeUndefined();
  });

  it('with storage fully broken, the tip shows at most once per session (and again next launch)', async () => {
    store.getItemAsync.mockRejectedValue(new Error('keystore unavailable'));
    store.setItemAsync.mockRejectedValue(new Error('keystore unavailable'));

    const session1 = await freshSession();
    await expect(session1.hasSeenScanTip()).resolves.toBe(false); // shows once
    await session1.markScanTipSeen();
    await expect(session1.hasSeenScanTip()).resolves.toBe(true); // not again this session

    // "Relaunch": fresh module state, storage still broken → shows again.
    // Acceptable degradation; the alternative (trusting a failed write) would
    // be indistinguishable from never showing the tip at all.
    const session2 = await freshSession();
    await expect(session2.hasSeenScanTip()).resolves.toBe(false);
  });
});
