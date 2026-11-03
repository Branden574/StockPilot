import type { AppearanceMode } from '@stockpilot/core';
import { describe, expect, it, vi } from 'vitest';

import type { AccountAnswer, AppearanceAccount } from './account';
import { FakeStorage } from './__fixtures__/fake-storage';
import { createAppearanceController } from './controller';
import { PHONE_APPEARANCE_KEYS as KEYS } from './store';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));

/**
 * The phone's appearance controller over the shared reducer (plan 3.4), with
 * a fake AsyncStorage and a fake account whose answers the test releases by
 * hand, so every race in the plan is played out in order.
 */

const T0 = Date.parse('2026-11-02T20:00:00Z');
const row = (mode: AppearanceMode, at: string) => ({ appearance: mode, updated_at: at });

class FakeAccount implements AppearanceAccount {
  readonly calls: { kind: 'fetch' | 'save'; userId: string; mode?: AppearanceMode }[] = [];
  private pending: ((answer: AccountAnswer) => void)[] = [];
  auto: ((kind: 'fetch' | 'save', userId: string, mode?: AppearanceMode) => AccountAnswer) | null =
    null;

  fetch(userId: string) {
    this.calls.push({ kind: 'fetch', userId });
    return this.answer('fetch', userId);
  }

  save(userId: string, mode: AppearanceMode) {
    this.calls.push({ kind: 'save', userId, mode });
    return this.answer('save', userId, mode);
  }

  private answer(kind: 'fetch' | 'save', userId: string, mode?: AppearanceMode) {
    if (this.auto) return Promise.resolve(this.auto(kind, userId, mode));
    return new Promise<AccountAnswer>((resolve) => this.pending.push(resolve));
  }

  /** Answer the oldest call still waiting. */
  async release(answer: AccountAnswer) {
    const next = this.pending.shift();
    if (!next) throw new Error('no call waiting');
    next(answer);
    await settle();
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0));

function setup(
  seed: Record<string, string> = {},
  opts: { glassEnabled?: boolean; now?: number } = {},
) {
  const storage = new FakeStorage(seed);
  const account = new FakeAccount();
  let now = opts.now ?? T0;
  const controller = createAppearanceController({
    storage,
    account,
    now: () => now,
    glassEnabled: opts.glassEnabled ?? true,
  });
  return {
    storage,
    account,
    controller,
    snap: () => controller.getSnapshot(),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const device = (mode: AppearanceMode, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, mode, lastClassic: mode === 'liquid-glass' ? 'dark' : mode, ...extra });

describe('first paint', () => {
  it('an install that never chose anything starts in System, as the phone always behaved', async () => {
    const { controller, snap } = setup();
    expect(snap().ready).toBe(false);
    await controller.hydrate();
    expect(snap()).toMatchObject({ ready: true, effective: 'system', fallbackActive: false });
  });

  it('reads storage once however often it is asked (a re-mounted provider, development double effects)', async () => {
    const { controller, storage } = setup({ [KEYS.device]: device('dark') });
    const reads: string[] = [];
    const read = storage.getItem.bind(storage);
    storage.getItem = async (key) => {
      reads.push(key);
      return read(key);
    };
    await Promise.all([controller.hydrate(), controller.hydrate()]);
    await controller.hydrate();
    expect(reads).toHaveLength(3); // the device, sync and fallback keys, once each
  });

  it('a stored choice is shown from the first paint', async () => {
    const { controller, snap } = setup({ [KEYS.device]: device('liquid-glass') });
    await controller.hydrate();
    expect(snap().effective).toBe('liquid-glass');
  });

  it('a malformed record is dropped: System, never Liquid Glass', async () => {
    const { controller, snap } = setup({ [KEYS.device]: '{"v":1,"mode":"Liquid Glass"}' });
    await controller.hydrate();
    expect(snap().effective).toBe('system');
  });

  it('when the read never answers in time the app goes on in System, and a late read still applies if nothing was chosen', async () => {
    const { controller, snap, storage } = setup({ [KEYS.device]: device('dark') });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const read = storage.getItem.bind(storage);
    storage.getItem = async (key) => {
      await gate;
      return read(key);
    };
    const hydrating = controller.hydrate();
    controller.giveUpWaiting();
    expect(snap()).toMatchObject({ ready: true, effective: 'system' });
    release();
    await hydrating;
    expect(snap().effective).toBe('dark');
  });

  it('a late read never overrides a choice made after the wait gave up', async () => {
    const { controller, snap, storage } = setup({ [KEYS.device]: device('dark') });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const read = storage.getItem.bind(storage);
    storage.getItem = async (key) => {
      await gate;
      return read(key);
    };
    const hydrating = controller.hydrate();
    controller.giveUpWaiting();
    controller.choose('light');
    release();
    await hydrating;
    expect(snap().effective).toBe('light');
  });
});

describe('the kill switch (EXPO_PUBLIC_LIQUID_GLASS off)', () => {
  it('a stored Liquid Glass renders as classic System and is kept, not rewritten', async () => {
    const { controller, snap, storage } = setup(
      { [KEYS.device]: device('liquid-glass') },
      { glassEnabled: false },
    );
    await controller.hydrate();
    expect(snap().effective).toBe('system');
    expect(snap().state.mode).toBe('liquid-glass');
    await controller.flush();
    expect(storage.json(KEYS.device)).toMatchObject({ mode: 'liquid-glass' });
  });

  it('Liquid Glass cannot be chosen', async () => {
    const { controller, snap } = setup({}, { glassEnabled: false });
    await controller.hydrate();
    controller.choose('liquid-glass');
    expect(snap().state.mode).toBe('system');
  });
});

describe('choosing', () => {
  it('signed out: applies at once and is kept on this phone with its time, nothing is sent', async () => {
    const { controller, snap, storage, account } = setup();
    await controller.hydrate();
    controller.setSession(null);
    controller.choose('liquid-glass');
    expect(snap().effective).toBe('liquid-glass');
    await controller.flush();
    expect(storage.json(KEYS.device)).toEqual({
      v: 1,
      mode: 'liquid-glass',
      lastClassic: 'system',
      anonAt: T0,
    });
    expect(account.calls).toEqual([]);
  });

  it('signed in: applies at once, says Saving, and says Saved only after the server answered with it', async () => {
    const { controller, snap, account, storage } = setup();
    await controller.hydrate();
    controller.setSession('user-a');
    await account.release({ ok: true, row: null }); // the first fetch: no row
    controller.choose('dark');
    expect(snap().effective).toBe('dark');
    expect(snap().state.status).toBe('saving');
    expect(account.calls.at(-1)).toEqual({ kind: 'save', userId: 'user-a', mode: 'dark' });
    await account.release({ ok: true, row: row('dark', '2026-11-02T20:00:01.123456+00:00') });
    expect(snap().state.status).toBe('synced');
    await controller.flush();
    expect(storage.json(KEYS.sync)).toEqual({
      v: 1,
      userId: 'user-a',
      dirty: false,
      syncedAt: '2026-11-02T20:00:01.123456+00:00',
    });
  });

  it('a failed save keeps the choice on the phone, stays unsaved and offers Try again', async () => {
    const { controller, snap, account } = setup();
    await controller.hydrate();
    controller.setSession('user-a');
    await account.release({ ok: true, row: null });
    controller.choose('light');
    await account.release({ ok: false, reason: 'error' });
    expect(snap()).toMatchObject({ effective: 'light' });
    expect(snap().state).toMatchObject({ status: 'failed', dirty: true });
    controller.retry();
    expect(account.calls.at(-1)).toEqual({ kind: 'save', userId: 'user-a', mode: 'light' });
    await account.release({ ok: true, row: row('light', '2026-11-02T20:00:02Z') });
    expect(snap().state.status).toBe('synced');
  });

  it('the account store missing (web shipped before the migration) says this phone only', async () => {
    const { controller, snap, account } = setup();
    await controller.hydrate();
    controller.setSession('user-a');
    await account.release({ ok: false, reason: 'missing-table' });
    expect(snap().state.status).toBe('unavailable');
  });

  it('Try again after the read found no account store reads again, and the answer counts once the table exists', async () => {
    const { controller, snap, account } = setup({ [KEYS.device]: device('light') });
    await controller.hydrate();
    controller.setSession('user-a');
    await account.release({ ok: false, reason: 'missing-table' });
    expect(snap().state).toMatchObject({ status: 'unavailable', dirty: false });

    controller.retry();
    expect(account.calls).toEqual([
      { kind: 'fetch', userId: 'user-a' },
      { kind: 'fetch', userId: 'user-a' },
    ]);
    await account.release({ ok: true, row: row('dark', '2026-11-02T20:00:03Z') });
    expect(snap().effective).toBe('dark');
    expect(snap().state.status).toBe('synced');
  });

  it('two quick choices never reach the server out of order', async () => {
    const { controller, snap, account } = setup();
    await controller.hydrate();
    controller.setSession('user-a');
    await account.release({ ok: true, row: null });
    controller.choose('dark');
    controller.choose('liquid-glass');
    expect(account.calls.filter((c) => c.kind === 'save')).toHaveLength(1);
    await account.release({ ok: true, row: row('dark', '2026-11-02T20:00:01Z') });
    expect(account.calls.at(-1)).toEqual({ kind: 'save', userId: 'user-a', mode: 'liquid-glass' });
    await account.release({ ok: true, row: row('liquid-glass', '2026-11-02T20:00:02Z') });
    expect(snap().state).toMatchObject({ status: 'synced', mode: 'liquid-glass', dirty: false });
  });
});

describe('reconciling with the account', () => {
  it("adopts the account's choice on a phone that never synced with this person", async () => {
    const { controller, snap, account } = setup({ [KEYS.device]: device('light') });
    await controller.hydrate();
    controller.setSession('user-a');
    expect(account.calls).toEqual([{ kind: 'fetch', userId: 'user-a' }]);
    await account.release({ ok: true, row: row('liquid-glass', '2026-11-01T10:00:00Z') });
    expect(snap().effective).toBe('liquid-glass');
    expect(snap().state.status).toBe('synced');
  });

  it('a late fetch never overwrites a choice made while it was in flight', async () => {
    const { controller, snap, account } = setup();
    await controller.hydrate();
    controller.setSession('user-a');
    controller.choose('dark'); // while the fetch is out
    await account.release({ ok: true, row: row('liquid-glass', '2026-11-01T10:00:00Z') });
    expect(snap().effective).toBe('dark');
  });

  it('no row: the phone keeps its value and uploads nothing', async () => {
    const { controller, snap, account } = setup({ [KEYS.device]: device('dark') });
    await controller.hydrate();
    controller.setSession('user-a');
    await account.release({ ok: true, row: null });
    expect(snap().effective).toBe('dark');
    expect(account.calls.filter((c) => c.kind === 'save')).toEqual([]);
  });

  it('a choice made signed out within 30 minutes is pushed to the account that signs in', async () => {
    const { controller, account, snap } = setup({
      [KEYS.device]: device('liquid-glass', { anonAt: T0 - 10 * 60_000 }),
    });
    await controller.hydrate();
    controller.setSession('user-a');
    expect(account.calls).toEqual([{ kind: 'save', userId: 'user-a', mode: 'liquid-glass' }]);
    expect(snap().state.anonAt).toBeNull();
  });

  it('an older pre-sign-in choice is not pushed: the account row decides', async () => {
    const { controller, account, snap } = setup({
      [KEYS.device]: device('liquid-glass', { anonAt: T0 - 31 * 60_000 }),
    });
    await controller.hydrate();
    controller.setSession('user-a');
    expect(account.calls).toEqual([{ kind: 'fetch', userId: 'user-a' }]);
    await account.release({ ok: true, row: row('light', '2026-11-01T10:00:00Z') });
    expect(snap().effective).toBe('light');
  });

  it("an unsaved choice of one person is never written under another person's account", async () => {
    const { controller, account, storage } = setup();
    await controller.hydrate();
    controller.setSession('user-a');
    await account.release({ ok: true, row: null });
    controller.choose('liquid-glass');
    await account.release({ ok: false, reason: 'error' }); // user-a's choice stays unsaved
    controller.setSession(null); // sign-out
    await controller.flush();
    expect(storage.data.has(KEYS.sync)).toBe(false);
    controller.setSession('user-b');
    const saves = account.calls.filter((c) => c.kind === 'save');
    expect(saves.every((c) => c.userId === 'user-a')).toBe(true);
    expect(account.calls.at(-1)).toEqual({ kind: 'fetch', userId: 'user-b' });
  });

  it('sign-out keeps the look on the phone', async () => {
    const { controller, account, snap } = setup();
    await controller.hydrate();
    controller.setSession('user-a');
    await account.release({ ok: true, row: row('liquid-glass', '2026-11-01T10:00:00Z') });
    controller.setSession(null);
    expect(snap().effective).toBe('liquid-glass');
    expect(snap().state.status).toBe('signed-out');
  });

  it('the session arriving before the stored read is applied after it', async () => {
    const { controller, account } = setup({ [KEYS.device]: device('dark') });
    controller.setSession('user-a');
    expect(account.calls).toEqual([]);
    await controller.hydrate();
    expect(account.calls).toEqual([{ kind: 'fetch', userId: 'user-a' }]);
  });
});

describe('the one-time crash fallback (plan 5.6)', () => {
  const seed = {
    [KEYS.device]: device('liquid-glass'),
    [KEYS.fallback]: '1',
  };

  it('after a crash in Liquid Glass the next launch is classic once, and the flag is cleared', async () => {
    const { controller, snap, storage } = setup(seed);
    await controller.hydrate();
    expect(snap()).toMatchObject({ effective: 'dark', fallbackActive: true });
    // The stored choice is untouched.
    expect(snap().state.mode).toBe('liquid-glass');
    await controller.flush();
    expect(storage.data.has(KEYS.fallback)).toBe(false);
    expect(storage.json(KEYS.device)).toMatchObject({ mode: 'liquid-glass' });

    // The launch after: glass again.
    const again = createAppearanceController({
      storage,
      account: new FakeAccount(),
      now: () => T0,
      glassEnabled: true,
    });
    await again.hydrate();
    expect(again.getSnapshot()).toMatchObject({ effective: 'liquid-glass', fallbackActive: false });
  });

  it('"Turn Liquid Glass back on" shows it again without changing anything stored', async () => {
    const { controller, snap, storage } = setup(seed);
    await controller.hydrate();
    controller.endFallback('glass');
    expect(snap()).toMatchObject({ effective: 'liquid-glass', fallbackActive: false });
    await controller.flush();
    expect(storage.json(KEYS.device)).toMatchObject({ mode: 'liquid-glass' });
  });

  it('"Use classic" makes the previous classic look the choice', async () => {
    const { controller, snap, storage } = setup(seed);
    await controller.hydrate();
    controller.endFallback('classic');
    expect(snap()).toMatchObject({ effective: 'dark', fallbackActive: false });
    expect(snap().state.mode).toBe('dark');
    await controller.flush();
    expect(storage.json(KEYS.device)).toMatchObject({ mode: 'dark', lastClassic: 'dark' });
  });

  it('a flag left over from a classic choice does nothing', async () => {
    const { controller, snap } = setup({ [KEYS.device]: device('light'), [KEYS.fallback]: '1' });
    await controller.hydrate();
    expect(snap()).toMatchObject({ effective: 'light', fallbackActive: false });
  });
});

describe('what the controller touches', () => {
  it('only the three appearance keys, whatever happens', async () => {
    const { controller, account, storage } = setup({
      [KEYS.device]: device('liquid-glass'),
      [KEYS.fallback]: '1',
    });
    account.auto = (kind, _userId, mode) =>
      kind === 'save'
        ? { ok: true, row: row(mode!, '2026-11-02T20:00:05Z') }
        : { ok: true, row: row('light', '2026-11-01T10:00:00Z') };
    await controller.hydrate();
    controller.setSession('user-a');
    await settle();
    controller.choose('dark');
    await settle();
    controller.setSession(null);
    controller.choose('system');
    await controller.flush();
    expect([...storage.touched].sort()).toEqual([KEYS.fallback, KEYS.device, KEYS.sync].sort());
  });

  it('notifies subscribers only when what they read changed', async () => {
    const { controller } = setup();
    const listener = vi.fn();
    controller.subscribe(listener);
    await controller.hydrate();
    const calls = listener.mock.calls.length;
    controller.setSession(null); // nothing to change: already signed out
    expect(listener.mock.calls.length).toBe(calls);
    const before = controller.getSnapshot();
    expect(controller.getSnapshot()).toBe(before);
  });
});
