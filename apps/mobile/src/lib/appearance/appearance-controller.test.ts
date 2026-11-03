import type { AppearancePatch, GlassRollout } from '@stockpilot/core';
import { describe, expect, it, vi } from 'vitest';

import type { AccountAnswer, AppearanceAccount } from './account';
import { FakeStorage } from './__fixtures__/fake-storage';
import { createAppearanceController, type AdoptionHolds } from './controller';
import { PHONE_APPEARANCE_KEYS as KEYS } from './store';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));

/**
 * The phone's appearance controller over the shared reducer (plan 3.4, as
 * revised by REVISION-DEFAULT R2-R5, R9, R13 and items 29-32), with a fake
 * AsyncStorage, a fake account whose answers the test releases by hand, a
 * fake "who is signed in" for the first start, and fake holds, so every race
 * is played out in order.
 */

const T0 = Date.parse('2026-11-03T20:00:00Z');
const A = '6f1c2a9e-1b2c-4d3e-8f40-0a1b2c3d4e5f';
const B = '0b9e7c1d-2a3b-4c5d-9e6f-7a8b9c0d1e2f';

const row = (
  values: { style?: string | null; theme?: string | null },
  at: string,
): Record<string, unknown> => ({
  style: values.style ?? null,
  theme: values.theme ?? null,
  updated_at: at,
});

type Call = { kind: 'fetch' | 'save'; userId: string; axes?: AppearancePatch };

class FakeAccount implements AppearanceAccount {
  readonly calls: Call[] = [];
  private pending: ((answer: AccountAnswer) => void)[] = [];
  auto: ((kind: 'fetch' | 'save', userId: string, axes?: AppearancePatch) => AccountAnswer) | null =
    null;

  fetch(userId: string) {
    this.calls.push({ kind: 'fetch', userId });
    return this.answer('fetch', userId);
  }

  save(userId: string, axes: AppearancePatch) {
    this.calls.push({ kind: 'save', userId, axes });
    return this.answer('save', userId, axes);
  }

  private answer(kind: 'fetch' | 'save', userId: string, axes?: AppearancePatch) {
    if (this.auto) return Promise.resolve(this.auto(kind, userId, axes));
    return new Promise<AccountAnswer>((resolve) => this.pending.push(resolve));
  }

  get waiting(): number {
    return this.pending.length;
  }

  /** Answer the oldest call still waiting. */
  async release(answer: AccountAnswer) {
    const next = this.pending.shift();
    if (!next) throw new Error('no call waiting');
    next(answer);
    await settle();
  }
}

/** Holds the test turns on and off (the B44 update holds, the Scan tab, a count). */
class FakeHolds implements AdoptionHolds {
  held = false;
  private listeners = new Set<() => void>();
  isHeld = () => this.held;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  set(held: boolean) {
    this.held = held;
    for (const fn of [...this.listeners]) fn();
  }
  get subscribers(): number {
    return this.listeners.size;
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0));

function setup(
  seed: Record<string, string> = {},
  opts: {
    rollout?: GlassRollout;
    now?: number;
    /** What the stored session says at the first start (item 31). */
    peek?: string | null | (() => Promise<string | null>);
    /** The same phone again: a later cold start reads what the earlier one stored. */
    storage?: FakeStorage;
  } = {},
) {
  const storage = opts.storage ?? new FakeStorage(seed);
  const account = new FakeAccount();
  const holds = new FakeHolds();
  let now = opts.now ?? T0;
  const peeks: number[] = [];
  const peek = opts.peek ?? null;
  const controller = createAppearanceController({
    storage,
    account,
    now: () => now,
    rollout: opts.rollout ?? 'default',
    holds,
    peekSignedInUser: () => {
      peeks.push(1);
      return typeof peek === 'function' ? peek() : Promise.resolve(peek);
    },
  });
  return {
    storage,
    account,
    holds,
    controller,
    peeks,
    snap: () => controller.getSnapshot(),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const device = (record: Record<string, unknown>) => JSON.stringify({ v: 2, ...record });
const syncRecord = (record: Record<string, unknown>) => JSON.stringify({ v: 2, ...record });

describe('first paint', () => {
  it('under default, a phone that never chose sees Liquid Glass, following the device for Day or Night (R9)', async () => {
    const { controller, snap } = setup();
    expect(snap().ready).toBe(false);
    await controller.hydrate();
    expect(snap()).toMatchObject({
      ready: true,
      style: 'liquid-glass',
      theme: null,
      fallbackActive: false,
    });
  });

  it('under opt-in, a phone that never chose sees classic', async () => {
    const { controller, snap } = setup({}, { rollout: 'opt-in' });
    await controller.hydrate();
    expect(snap()).toMatchObject({ ready: true, style: 'classic', theme: null });
  });

  it('reads storage once however often it is asked (a re-mounted provider, development double effects)', async () => {
    const { controller, storage } = setup({ [KEYS.device]: device({ theme: 'dark' }) });
    const reads: string[] = [];
    const read = storage.getItem.bind(storage);
    storage.getItem = async (key) => {
      reads.push(key);
      return read(key);
    };
    await Promise.all([controller.hydrate(), controller.hydrate()]);
    await controller.hydrate();
    expect(reads).toHaveLength(4); // the device, sync, fallback and intro keys, once each
  });

  it('a stored choice is shown from the first paint, each axis on its own', async () => {
    const { controller, snap } = setup({
      [KEYS.device]: device({ style: 'classic', theme: 'dark' }),
    });
    await controller.hydrate();
    expect(snap()).toMatchObject({ style: 'classic', theme: 'dark' });
    const other = setup({ [KEYS.device]: device({ theme: 'light' }) });
    await other.controller.hydrate();
    expect(other.snap()).toMatchObject({ style: 'liquid-glass', theme: 'light' });
  });

  it('a malformed record is dropped and means never chose: the rollout default', async () => {
    const { controller, snap } = setup({ [KEYS.device]: '{"v":2,"style":"Classic"}' });
    await controller.hydrate();
    expect(snap().style).toBe('liquid-glass');
    const optIn = setup({ [KEYS.device]: '{"v":2,"style":"Liquid Glass"}' }, { rollout: 'opt-in' });
    await optIn.controller.hydrate();
    expect(optIn.snap().style).toBe('classic');
  });

  it('the stage 2 v1 record is never read: its words meant something else', async () => {
    const { controller, snap } = setup({
      'stockpilot.appearance.v1': JSON.stringify({ v: 1, mode: 'dark', lastClassic: 'dark' }),
    });
    await controller.hydrate();
    expect(snap()).toMatchObject({ style: 'liquid-glass', theme: null });
  });

  it('when the read never answers in time the app goes on in the rollout default, and a late read still applies if nothing was chosen', async () => {
    const { controller, snap, storage } = setup({ [KEYS.device]: device({ style: 'classic' }) });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const read = storage.getItem.bind(storage);
    storage.getItem = async (key) => {
      await gate;
      return read(key);
    };
    const hydrating = controller.hydrate();
    controller.giveUpWaiting();
    expect(snap()).toMatchObject({ ready: true, style: 'liquid-glass' });
    release();
    await hydrating;
    expect(snap().style).toBe('classic');
  });

  it('a late read never overrides a choice made after the wait gave up', async () => {
    const { controller, snap, storage } = setup({ [KEYS.device]: device({ style: 'classic' }) });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const read = storage.getItem.bind(storage);
    storage.getItem = async (key) => {
      await gate;
      return read(key);
    };
    const hydrating = controller.hydrate();
    controller.giveUpWaiting();
    controller.chooseTheme('light');
    release();
    await hydrating;
    expect(snap()).toMatchObject({ style: 'liquid-glass', theme: 'light' });
  });
});

describe('the first start of the new JS (round 2, finding 10; item 31)', () => {
  it('signed in with no v2 record: the first paint waits for the account row, so a Classic chooser opens in Classic', async () => {
    const { controller, snap, account, holds, peeks } = setup({}, { peek: A });
    holds.held = true; // nothing is on screen yet: a hold must not defer the first look
    await controller.hydrate();
    expect(peeks).toHaveLength(1);
    expect(snap().ready).toBe(false);
    expect(account.calls).toEqual([{ kind: 'fetch', userId: A }]);
    await account.release({ ok: true, row: row({ style: 'classic' }, '2026-11-02T10:00:00Z') });
    expect(snap()).toMatchObject({ ready: true, style: 'classic' });
  });

  it('no row: the first paint goes on in the rollout default as soon as the row answers', async () => {
    const { controller, snap, account } = setup({}, { peek: A });
    await controller.hydrate();
    await account.release({ ok: true, row: null });
    expect(snap()).toMatchObject({ ready: true, style: 'liquid-glass' });
  });

  it('a read that fails (offline) ends the wait at once, in the rollout default', async () => {
    const { controller, snap, account } = setup({}, { peek: A });
    await controller.hydrate();
    await account.release({ ok: false, reason: 'error' });
    expect(snap()).toMatchObject({ ready: true, style: 'liquid-glass' });
  });

  it('the wait is inside the same 4 s cap: giving up shows the rollout default, and the late row then waits for the holds', async () => {
    const { controller, snap, account, holds, storage } = setup({}, { peek: A });
    await controller.hydrate();
    controller.giveUpWaiting();
    expect(snap()).toMatchObject({ ready: true, style: 'liquid-glass' });
    holds.held = true;
    await account.release({ ok: true, row: row({ style: 'classic' }, '2026-11-02T10:00:00Z') });
    // Stored at once ...
    await controller.flush();
    expect(storage.json(KEYS.device)).toEqual({ v: 2, style: 'classic' });
    expect(snap().state.style).toBe('classic');
    // ... shown when nothing holds it.
    expect(snap()).toMatchObject({ style: 'liquid-glass', adoptionPending: true });
    holds.set(false);
    expect(snap()).toMatchObject({ style: 'classic', adoptionPending: false });
  });

  it('only the first start waits: the next cold start opens at once and reads the row after the first paint', async () => {
    const first = setup({}, { peek: A });
    await first.controller.hydrate();
    expect(first.snap().ready).toBe(false);
    await first.account.release({ ok: true, row: null }); // never chose anywhere
    await first.controller.flush();

    // The next cold start of the same phone; the person still never chose.
    const next = setup({}, { peek: A, storage: first.storage });
    await next.controller.hydrate();
    expect(next.snap()).toMatchObject({ ready: true, style: 'liquid-glass' });
    expect(next.peeks).toHaveLength(0);
    expect(next.account.calls).toEqual([]);
    // The session bridge reports the person after the first paint; the row is read then.
    next.controller.setSession(A);
    expect(next.account.calls).toEqual([{ kind: 'fetch', userId: A }]);
  });

  it('a first start cut short by the 4 s cap, whose read then failed, is still the only one that waits', async () => {
    const cut = setup({}, { peek: A });
    await cut.controller.hydrate();
    cut.controller.giveUpWaiting();
    await cut.account.release({ ok: false, reason: 'error' });
    await cut.controller.flush();
    const next = setup({}, { peek: A, storage: cut.storage });
    await next.controller.hydrate();
    expect(next.snap().ready).toBe(true);
    expect(next.peeks).toHaveLength(0);
  });

  it('a phone signed out at its first start, signed in during that run, never waits at a later start', async () => {
    const first = setup({}, { peek: null });
    await first.controller.hydrate();
    expect(first.snap().ready).toBe(true);
    first.controller.setSession(A); // the sign-in screen
    await first.account.release({ ok: true, row: null });
    await first.controller.flush();
    const next = setup({}, { peek: A, storage: first.storage });
    await next.controller.hydrate();
    expect(next.snap().ready).toBe(true);
    expect(next.peeks).toHaveLength(0);
  });

  it('the session ending during the wait ends it at once: there is no row to wait for', async () => {
    const { controller, snap, account } = setup({}, { peek: A });
    await controller.hydrate();
    expect(snap().ready).toBe(false);
    // AuthProvider is mounted during the wait (finding 2): a refresh refused
    // by the server signs the phone out, and the bridge says so.
    controller.setSession(null);
    expect(snap()).toMatchObject({ ready: true, style: 'liquid-glass' });
    expect(snap().state.status).toBe('signed-out');
    await account.release({ ok: true, row: row({ style: 'classic' }, '2026-11-02T10:00:00Z') });
    expect(snap().style).toBe('liquid-glass');
  });

  it('the bridge reporting the person before the peek answers (AuthProvider mounts at font-ready): one read, and the first paint still waits for the row', async () => {
    let answerPeek: (user: string | null) => void = () => undefined;
    const before = setup(
      {},
      { peek: () => new Promise<string | null>((resolve) => (answerPeek = resolve)) },
    );
    const hydrating = before.controller.hydrate();
    await settle();
    expect(before.peeks).toHaveLength(1);
    before.controller.setSession(A); // the bridge, while auth-js is still initialising
    expect(before.account.calls).toEqual([{ kind: 'fetch', userId: A }]);
    answerPeek(A);
    await hydrating;
    expect(before.snap().ready).toBe(false);
    expect(before.account.calls).toHaveLength(1);
    await before.account.release({
      ok: true,
      row: row({ style: 'classic' }, '2026-11-02T10:00:00Z'),
    });
    expect(before.snap()).toMatchObject({ ready: true, style: 'classic' });

    // The row answering before the peek does: ready, in the row's Design, as the peek lands.
    let answerLate: (user: string | null) => void = () => undefined;
    const racing = setup(
      {},
      { peek: () => new Promise<string | null>((resolve) => (answerLate = resolve)) },
    );
    const hydrating2 = racing.controller.hydrate();
    await settle();
    racing.controller.setSession(A);
    await racing.account.release({
      ok: true,
      row: row({ style: 'classic' }, '2026-11-02T10:00:00Z'),
    });
    expect(racing.snap().ready).toBe(false);
    answerLate(A);
    await hydrating2;
    expect(racing.snap()).toMatchObject({ ready: true, style: 'classic' });
    expect(racing.account.calls).toHaveLength(1);
  });

  it('a stored record, a signed-out phone, or the off rollout never waits for the account', async () => {
    const stored = setup({ [KEYS.device]: device({ theme: 'dark' }) }, { peek: A });
    await stored.controller.hydrate();
    expect(stored.snap().ready).toBe(true);
    expect(stored.peeks).toHaveLength(0);

    const signedOut = setup({}, { peek: null });
    await signedOut.controller.hydrate();
    expect(signedOut.snap().ready).toBe(true);
    expect(signedOut.account.calls).toEqual([]);

    const off = setup({}, { peek: A, rollout: 'off' });
    await off.controller.hydrate();
    expect(off.snap().ready).toBe(true);
    expect(off.peeks).toHaveLength(0);
    expect(off.account.calls).toEqual([]);
  });

  it('the session bridge reporting the same person later reads nothing twice', async () => {
    const { controller, account } = setup({}, { peek: A });
    await controller.hydrate();
    await account.release({ ok: true, row: null });
    controller.setSession(A);
    expect(account.calls).toEqual([{ kind: 'fetch', userId: A }]);
  });

  it('the bridge saying nobody (a revoked session) signs the controller out', async () => {
    const { controller, account, snap } = setup({}, { peek: A });
    await controller.hydrate();
    controller.setSession(null);
    await account.release({ ok: true, row: row({ style: 'classic' }, '2026-11-02T10:00:00Z') });
    expect(snap().state.status).toBe('signed-out');
    expect(snap().style).toBe('liquid-glass');
  });
});

describe('the kill switch (EXPO_PUBLIC_LIQUID_GLASS)', () => {
  it('off: a stored Liquid Glass renders as classic and is kept, not rewritten', async () => {
    const { controller, snap, storage } = setup(
      { [KEYS.device]: device({ style: 'liquid-glass', theme: 'dark' }) },
      { rollout: 'off' },
    );
    await controller.hydrate();
    // Classic, following the device, exactly today's phone: the stored Theme
    // is kept too, but not shown (the phone had no Theme choice before).
    expect(snap()).toMatchObject({ style: 'classic', theme: null, glassEnabled: false });
    expect(snap().state.style).toBe('liquid-glass');
    await controller.flush();
    expect(storage.json(KEYS.device)).toEqual({ v: 2, style: 'liquid-glass', theme: 'dark' });
  });

  it('off: the appearance layer is inert: no choice, no write, no account read or save', async () => {
    const { controller, snap, account, storage } = setup(
      {
        [KEYS.fallback]: '1',
        [KEYS.sync]: syncRecord({ userId: A, dirtyAxes: [], syncedAt: null }),
      },
      { rollout: 'off' },
    );
    const written: string[] = [];
    const set = storage.setItem.bind(storage);
    const remove = storage.removeItem.bind(storage);
    storage.setItem = async (key, value) => {
      written.push(key);
      return set(key, value);
    };
    storage.removeItem = async (key) => {
      written.push(key);
      return remove(key);
    };
    await controller.hydrate();
    controller.setSession(A);
    controller.chooseStyle('liquid-glass');
    controller.chooseTheme('dark');
    controller.keepGlass();
    controller.dismissIntro();
    controller.retry();
    controller.setSession(null);
    await controller.flush();
    expect(snap()).toMatchObject({ style: 'classic', theme: null, introVisible: false });
    expect(account.calls).toEqual([]);
    expect(written).toEqual([]);
  });

  it('opt-in: Liquid Glass can be chosen, and is then shown', async () => {
    const { controller, snap } = setup({}, { rollout: 'opt-in' });
    await controller.hydrate();
    controller.chooseStyle('liquid-glass');
    expect(snap().style).toBe('liquid-glass');
  });
});

describe('choosing', () => {
  it('signed out: applies at once and is kept on this phone with its time, nothing is sent', async () => {
    const { controller, snap, storage, account } = setup();
    await controller.hydrate();
    controller.setSession(null);
    controller.chooseStyle('classic');
    expect(snap().style).toBe('classic');
    await controller.flush();
    expect(storage.json(KEYS.device)).toEqual({ v: 2, style: 'classic', anonAt: T0 });
    expect(account.calls).toEqual([]);
  });

  it('switching the Design never changes the Theme, and the reverse', async () => {
    const { controller, snap } = setup({ [KEYS.device]: device({ theme: 'dark' }) });
    await controller.hydrate();
    controller.chooseStyle('classic');
    expect(snap()).toMatchObject({ style: 'classic', theme: 'dark' });
    controller.chooseTheme('system');
    expect(snap()).toMatchObject({ style: 'classic', theme: 'system' });
  });

  it('signed in: applies at once, says Saving, sends only that axis, and says Saved only after the server answered with it', async () => {
    const { controller, snap, account, storage } = setup({
      [KEYS.device]: device({ theme: 'light' }),
    });
    await controller.hydrate();
    controller.setSession(A);
    await account.release({ ok: true, row: null }); // the first fetch: no row
    controller.chooseTheme('dark');
    expect(snap().theme).toBe('dark');
    expect(snap().state.status).toBe('saving');
    expect(account.calls.at(-1)).toEqual({ kind: 'save', userId: A, axes: { theme: 'dark' } });
    await account.release({
      ok: true,
      row: row({ theme: 'dark' }, '2026-11-03T20:00:01.123456+00:00'),
    });
    expect(snap().state.status).toBe('synced');
    await controller.flush();
    expect(storage.json(KEYS.sync)).toEqual({
      v: 2,
      userId: A,
      dirtyAxes: [],
      syncedAt: '2026-11-03T20:00:01.123456+00:00',
    });
  });

  it('a failed save keeps the choice on the phone, stays unsaved and offers Try again', async () => {
    const { controller, snap, account } = setup({ [KEYS.device]: device({ theme: 'light' }) });
    await controller.hydrate();
    controller.setSession(A);
    await account.release({ ok: true, row: null });
    controller.chooseStyle('classic');
    await account.release({ ok: false, reason: 'error' });
    expect(snap().style).toBe('classic');
    expect(snap().state).toMatchObject({ status: 'failed', dirtyAxes: ['style'] });
    controller.retry();
    expect(account.calls.at(-1)).toEqual({ kind: 'save', userId: A, axes: { style: 'classic' } });
    await account.release({ ok: true, row: row({ style: 'classic' }, '2026-11-03T20:00:02Z') });
    expect(snap().state.status).toBe('synced');
  });

  it('the account store missing (web shipped before the migration) says this phone only', async () => {
    const { controller, snap, account } = setup({ [KEYS.device]: device({ theme: 'light' }) });
    await controller.hydrate();
    controller.setSession(A);
    await account.release({ ok: false, reason: 'missing-table' });
    expect(snap().state.status).toBe('unavailable');
  });

  it('Try again after the read found no account store reads again, and the answer counts once the table exists', async () => {
    const { controller, snap, account } = setup({ [KEYS.device]: device({ theme: 'light' }) });
    await controller.hydrate();
    controller.setSession(A);
    await account.release({ ok: false, reason: 'missing-table' });
    expect(snap().state).toMatchObject({ status: 'unavailable', dirtyAxes: [] });

    controller.retry();
    expect(account.calls).toEqual([
      { kind: 'fetch', userId: A },
      { kind: 'fetch', userId: A },
    ]);
    await account.release({ ok: true, row: row({ style: 'classic' }, '2026-11-03T20:00:03Z') });
    expect(snap().style).toBe('classic');
    expect(snap().state.status).toBe('synced');
  });

  it('two quick choices never reach the server out of order', async () => {
    const { controller, snap, account } = setup({ [KEYS.device]: device({ theme: 'light' }) });
    await controller.hydrate();
    controller.setSession(A);
    await account.release({ ok: true, row: null });
    controller.chooseStyle('classic');
    controller.chooseStyle('liquid-glass');
    expect(account.calls.filter((c) => c.kind === 'save')).toHaveLength(1);
    await account.release({ ok: true, row: row({ style: 'classic' }, '2026-11-03T20:00:01Z') });
    expect(account.calls.at(-1)).toEqual({
      kind: 'save',
      userId: A,
      axes: { style: 'liquid-glass' },
    });
    await account.release({
      ok: true,
      row: row({ style: 'liquid-glass' }, '2026-11-03T20:00:02Z'),
    });
    expect(snap().state).toMatchObject({ status: 'synced', style: 'liquid-glass', dirtyAxes: [] });
  });

  it('Keep Liquid Glass makes the default an explicit, saved Design', async () => {
    const { controller, snap, account } = setup({ [KEYS.device]: device({ theme: 'light' }) });
    await controller.hydrate();
    controller.setSession(A);
    await account.release({ ok: true, row: null });
    expect(snap().state.style).toBeNull();
    controller.keepGlass();
    expect(snap().state.style).toBe('liquid-glass');
    expect(account.calls.at(-1)).toEqual({
      kind: 'save',
      userId: A,
      axes: { style: 'liquid-glass' },
    });
  });
});

describe('reconciling with the account', () => {
  it("adopts the account's Design on a phone that never synced with this person", async () => {
    const { controller, snap, account } = setup({ [KEYS.device]: device({ theme: 'light' }) });
    await controller.hydrate();
    controller.setSession(A);
    expect(account.calls).toEqual([{ kind: 'fetch', userId: A }]);
    await account.release({ ok: true, row: row({ style: 'classic' }, '2026-11-01T10:00:00Z') });
    expect(snap()).toMatchObject({ style: 'classic', theme: 'light' });
    expect(snap().state.status).toBe('synced');
  });

  it('a late fetch never overwrites a choice made while it was in flight', async () => {
    const { controller, snap, account } = setup({ [KEYS.device]: device({ theme: 'light' }) });
    await controller.hydrate();
    controller.setSession(A);
    controller.chooseStyle('liquid-glass'); // while the fetch is out
    await account.release({ ok: true, row: row({ style: 'classic' }, '2026-11-01T10:00:00Z') });
    expect(snap().style).toBe('liquid-glass');
  });

  it('no row: the phone keeps its values and uploads nothing', async () => {
    const { controller, snap, account } = setup({
      [KEYS.device]: device({ style: 'classic', theme: 'dark' }),
    });
    await controller.hydrate();
    controller.setSession(A);
    await account.release({ ok: true, row: null });
    expect(snap()).toMatchObject({ style: 'classic', theme: 'dark' });
    expect(account.calls.filter((c) => c.kind === 'save')).toEqual([]);
  });

  it('SR4: a choice made signed out in this run is offered to the account that signs in, after the row is read', async () => {
    const { controller, account, snap, advance } = setup();
    await controller.hydrate();
    controller.setSession(null);
    controller.chooseStyle('classic');
    advance(5 * 60_000);
    controller.setSession(A);
    expect(account.calls).toEqual([{ kind: 'fetch', userId: A }]);
    await account.release({ ok: true, row: null });
    expect(account.calls.at(-1)).toEqual({ kind: 'save', userId: A, axes: { style: 'classic' } });
    expect(snap().state.anonAt).toBeNull();
  });

  it('SR4: a row that holds a Design wins over the signed-out choice; nothing is saved', async () => {
    const { controller, account, snap } = setup();
    await controller.hydrate();
    controller.setSession(null);
    controller.chooseStyle('classic');
    controller.setSession(A);
    await account.release({
      ok: true,
      row: row({ style: 'liquid-glass' }, '2026-11-01T10:00:00Z'),
    });
    expect(snap().style).toBe('liquid-glass');
    expect(account.calls.filter((c) => c.kind === 'save')).toEqual([]);
  });

  it('SR4: a signed-out choice from an earlier run (no stamp in memory) never reaches the account', async () => {
    const { controller, account } = setup({
      [KEYS.device]: device({ style: 'classic', anonAt: T0 - 60_000 }),
    });
    await controller.hydrate();
    controller.setSession(A);
    await account.release({ ok: true, row: null });
    expect(account.calls).toEqual([{ kind: 'fetch', userId: A }]);
  });

  it("an unsaved choice of one person is never written under another person's account", async () => {
    const { controller, account, storage } = setup({ [KEYS.device]: device({ theme: 'light' }) });
    await controller.hydrate();
    controller.setSession(A);
    await account.release({ ok: true, row: null });
    controller.chooseStyle('classic');
    await account.release({ ok: false, reason: 'error' }); // A's choice stays unsaved
    controller.setSession(null); // sign-out
    await controller.flush();
    expect(storage.data.has(KEYS.sync)).toBe(false);
    controller.setSession(B);
    const saves = account.calls.filter((c) => c.kind === 'save');
    expect(saves.every((c) => c.userId === A)).toBe(true);
    expect(account.calls.at(-1)).toEqual({ kind: 'fetch', userId: B });
  });

  it('SR1: a stored unsaved choice without a confirmed sync is checked against the row first', async () => {
    const { controller, account, snap } = setup({
      [KEYS.device]: device({ style: 'classic' }),
      [KEYS.sync]: syncRecord({ userId: A, dirtyAxes: ['style'], syncedAt: null }),
    });
    await controller.hydrate();
    controller.setSession(A);
    expect(account.calls).toEqual([{ kind: 'fetch', userId: A }]);
    await account.release({
      ok: true,
      row: row({ style: 'liquid-glass' }, '2026-11-01T10:00:00Z'),
    });
    expect(snap().style).toBe('liquid-glass');
  });

  it('round 2, finding 6: a Theme saved here adopts the Design the web saved', async () => {
    const { controller, account, snap } = setup({
      [KEYS.device]: device({ theme: 'light' }),
      [KEYS.sync]: syncRecord({ userId: A, dirtyAxes: [], syncedAt: '2026-11-03T10:00:00Z' }),
    });
    await controller.hydrate();
    controller.setSession(A);
    await account.release({ ok: true, row: row({ theme: 'light' }, '2026-11-03T10:00:00Z') });
    // The web saves Classic at T1; then the phone saves a Theme at T2.
    controller.chooseTheme('dark');
    await account.release({
      ok: true,
      row: row({ style: 'classic', theme: 'dark' }, '2026-11-03T10:05:00Z'),
    });
    expect(snap()).toMatchObject({ style: 'classic', theme: 'dark' });
    expect(snap().state.status).toBe('synced');
  });

  it('sign-out keeps the look on the phone', async () => {
    const { controller, account, snap } = setup({ [KEYS.device]: device({ theme: 'light' }) });
    await controller.hydrate();
    controller.setSession(A);
    await account.release({ ok: true, row: row({ style: 'classic' }, '2026-11-01T10:00:00Z') });
    controller.setSession(null);
    expect(snap().style).toBe('classic');
    expect(snap().state.status).toBe('signed-out');
  });

  it('the session arriving before the stored read is applied after it', async () => {
    const { controller, account } = setup({ [KEYS.device]: device({ theme: 'dark' }) });
    controller.setSession(A);
    expect(account.calls).toEqual([]);
    await controller.hydrate();
    expect(account.calls).toEqual([{ kind: 'fetch', userId: A }]);
  });
});

describe('a Design adopted later waits until the person is not in the middle of something (item 32)', () => {
  async function adoptedWhile(held: boolean) {
    const ctx = setup({ [KEYS.device]: device({ theme: 'light' }) });
    await ctx.controller.hydrate();
    ctx.controller.setSession(A);
    ctx.holds.held = held;
    await ctx.account.release({
      ok: true,
      row: row({ style: 'classic' }, '2026-11-01T10:00:00Z'),
    });
    return ctx;
  }

  it('nothing holds it: shown at once', async () => {
    const { snap } = await adoptedWhile(false);
    expect(snap()).toMatchObject({ style: 'classic', adoptionPending: false });
  });

  it('under a hold (a sheet, an alert, a draft, a write, the Scan tab, a count): stored at once, shown when the hold ends', async () => {
    const { snap, holds, storage, controller } = await adoptedWhile(true);
    await controller.flush();
    expect(storage.json(KEYS.device)).toEqual({ v: 2, style: 'classic', theme: 'light' });
    expect(snap()).toMatchObject({ style: 'liquid-glass', adoptionPending: true });
    holds.set(true); // another hold change that is still held changes nothing
    expect(snap().style).toBe('liquid-glass');
    holds.set(false);
    expect(snap()).toMatchObject({ style: 'classic', adoptionPending: false });
    expect(holds.subscribers).toBe(0);
  });

  it('or at the next return to the app (background, then active), held or not', async () => {
    const { snap, controller } = await adoptedWhile(true);
    controller.onAppState('background');
    expect(snap()).toMatchObject({ style: 'liquid-glass', adoptionPending: true });
    controller.onAppState('active');
    expect(snap()).toMatchObject({ style: 'classic', adoptionPending: false });
  });

  it('inactive to active is not a return (Control Center, Face ID, an alert, the app switcher): the scan keeps its look', async () => {
    const { snap, controller } = await adoptedWhile(true);
    controller.onAppState('inactive');
    controller.onAppState('active');
    expect(snap()).toMatchObject({ style: 'liquid-glass', adoptionPending: true });
    // A real return after it still draws it.
    controller.onAppState('inactive');
    controller.onAppState('background');
    controller.onAppState('active');
    expect(snap()).toMatchObject({ style: 'classic', adoptionPending: false });
    // And one return draws once: the next inactive to active changes nothing.
    controller.onAppState('inactive');
    controller.onAppState('active');
    expect(snap().style).toBe('classic');
  });

  it('a choice made in Settings applies at once, held or not, and replaces a waiting one', async () => {
    const { snap, controller } = await adoptedWhile(true);
    controller.chooseStyle('liquid-glass');
    expect(snap()).toMatchObject({ style: 'liquid-glass', adoptionPending: false });
    expect(snap().state.style).toBe('liquid-glass');
  });

  it('an adopted Theme is not held: only the Design waits', async () => {
    const ctx = setup({ [KEYS.device]: device({ style: 'classic' }) });
    await ctx.controller.hydrate();
    ctx.controller.setSession(A);
    ctx.holds.held = true;
    await ctx.account.release({ ok: true, row: row({ theme: 'dark' }, '2026-11-01T10:00:00Z') });
    expect(ctx.snap()).toMatchObject({ style: 'classic', theme: 'dark', adoptionPending: false });
  });

  it('an adopted Design the screen already shows needs no wait', async () => {
    const ctx = setup({ [KEYS.device]: device({ theme: 'light' }) });
    await ctx.controller.hydrate();
    ctx.controller.setSession(A);
    ctx.holds.held = true;
    await ctx.account.release({
      ok: true,
      row: row({ style: 'liquid-glass' }, '2026-11-01T10:00:00Z'),
    });
    expect(ctx.snap()).toMatchObject({ style: 'liquid-glass', adoptionPending: false });
  });
});

describe('a read that failed is read again (rule 2; R9 "until it can read the row")', () => {
  async function offlineFirstStart() {
    const ctx = setup({}, { peek: A });
    await ctx.controller.hydrate();
    await ctx.account.release({ ok: false, reason: 'error' }); // offline, or a timeout
    return ctx;
  }

  it('a Classic chooser whose first read failed gets Classic once the network is back', async () => {
    const { controller, snap, account } = await offlineFirstStart();
    expect(snap()).toMatchObject({ ready: true, style: 'liquid-glass', retryOwed: true });
    controller.onNetwork(false);
    controller.onNetwork(true);
    expect(account.calls).toEqual([
      { kind: 'fetch', userId: A },
      { kind: 'fetch', userId: A },
    ]);
    await account.release({ ok: true, row: row({ style: 'classic' }, '2026-11-02T10:00:00Z') });
    expect(snap()).toMatchObject({ style: 'classic', retryOwed: false });
    expect(snap().state.status).toBe('synced');
  });

  it('the first network report after the failure counts: the listener is armed only once a retry is owed', async () => {
    const { controller, account } = await offlineFirstStart();
    controller.onNetwork(true);
    expect(account.calls.filter((c) => c.kind === 'fetch')).toHaveLength(2);
  });

  it('the app coming to the foreground reads it again too, and so does Try again', async () => {
    const foreground = await offlineFirstStart();
    foreground.controller.onAppState('active');
    expect(foreground.account.calls.filter((c) => c.kind === 'fetch')).toHaveLength(2);

    const button = await offlineFirstStart();
    button.controller.retry();
    expect(button.account.calls.filter((c) => c.kind === 'fetch')).toHaveLength(2);
  });

  it('one read at a time, and none once a read answered', async () => {
    const { controller, account, snap } = await offlineFirstStart();
    controller.onNetwork(true);
    controller.onNetwork(true); // another report while the read is out
    controller.onAppState('active');
    expect(account.calls.filter((c) => c.kind === 'fetch')).toHaveLength(2);
    await account.release({ ok: true, row: null });
    expect(snap().retryOwed).toBe(false);
    controller.onNetwork(true);
    controller.onAppState('active');
    controller.retry();
    expect(account.calls.filter((c) => c.kind === 'fetch')).toHaveLength(2);
  });

  it('a read that fails again stays owed; signing out owes nothing', async () => {
    const { controller, account, snap } = await offlineFirstStart();
    controller.onNetwork(true);
    await account.release({ ok: false, reason: 'error' });
    expect(snap().retryOwed).toBe(true);
    controller.setSession(null);
    expect(snap().retryOwed).toBe(false);
    controller.onNetwork(true);
    expect(account.calls.filter((c) => c.kind === 'fetch')).toHaveLength(2);
  });

  it('an unsaved choice is what is sent again, not a read: its answer is the row', async () => {
    const { controller, account, snap } = await offlineFirstStart();
    controller.chooseTheme('dark');
    await account.release({ ok: false, reason: 'error' });
    controller.onNetwork(true);
    expect(account.calls.at(-1)).toEqual({ kind: 'save', userId: A, axes: { theme: 'dark' } });
    await account.release({
      ok: true,
      row: row({ style: 'classic', theme: 'dark' }, '2026-11-02T10:00:00Z'),
    });
    expect(snap()).toMatchObject({ style: 'classic', theme: 'dark', retryOwed: false });
  });
});

describe('the one-time crash fallback (plan 5.6)', () => {
  it('after a crash in Liquid Glass the next launch is classic once, and the flag is cleared', async () => {
    const { controller, snap, storage } = setup({ [KEYS.fallback]: '1' });
    await controller.hydrate();
    expect(snap()).toMatchObject({ style: 'classic', fallbackActive: true });
    // The stored choice is untouched (never chose: still the default).
    expect(snap().state.style).toBeNull();
    await controller.flush();
    expect(storage.data.has(KEYS.fallback)).toBe(false);

    // The launch after: glass again.
    const again = createAppearanceController({
      storage,
      account: new FakeAccount(),
      now: () => T0,
      rollout: 'default',
      holds: new FakeHolds(),
      peekSignedInUser: async () => null,
    });
    await again.hydrate();
    expect(again.getSnapshot()).toMatchObject({ style: 'liquid-glass', fallbackActive: false });
  });

  it('"Turn Liquid Glass back on" shows it again without changing anything stored', async () => {
    const { controller, snap, storage } = setup({
      [KEYS.device]: device({ style: 'liquid-glass' }),
      [KEYS.fallback]: '1',
    });
    await controller.hydrate();
    controller.endFallback('glass');
    expect(snap()).toMatchObject({ style: 'liquid-glass', fallbackActive: false });
    await controller.flush();
    expect(storage.json(KEYS.device)).toEqual({ v: 2, style: 'liquid-glass' });
  });

  it('"Use classic design" makes Classic the choice and keeps the Theme', async () => {
    const { controller, snap, storage } = setup({
      [KEYS.device]: device({ style: 'liquid-glass', theme: 'dark' }),
      [KEYS.fallback]: '1',
    });
    await controller.hydrate();
    controller.endFallback('classic');
    expect(snap()).toMatchObject({ style: 'classic', theme: 'dark', fallbackActive: false });
    await controller.flush();
    expect(storage.json(KEYS.device)).toMatchObject({ style: 'classic', theme: 'dark' });
  });

  it('a flag left over from a classic choice, or under off, does nothing', async () => {
    const classic = setup({ [KEYS.device]: device({ style: 'classic' }), [KEYS.fallback]: '1' });
    await classic.controller.hydrate();
    expect(classic.snap()).toMatchObject({ style: 'classic', fallbackActive: false });
    const off = setup({ [KEYS.fallback]: '1' }, { rollout: 'off' });
    await off.controller.hydrate();
    expect(off.snap().fallbackActive).toBe(false);
  });
});

describe('the one-time "new look" card (R13)', () => {
  it('shows under default, in glass, while the Design is not the person’s own choice, until answered', async () => {
    const { controller, snap, storage } = setup();
    await controller.hydrate();
    expect(snap().introVisible).toBe(true);
    controller.dismissIntro();
    expect(snap().introVisible).toBe(false);
    await controller.flush();
    expect(storage.data.get(KEYS.introSeen)).toBe('1');
    // Closing chose nothing.
    expect(snap().state.style).toBeNull();
  });

  it('"Use classic design" chooses Classic and marks it seen', async () => {
    const { controller, snap, storage } = setup();
    await controller.hydrate();
    controller.chooseStyle('classic');
    expect(snap()).toMatchObject({ introVisible: false, style: 'classic' });
    await controller.flush();
    expect(storage.data.get(KEYS.introSeen)).toBe('1');
  });

  it('"Keep Liquid Glass" makes it the person’s own choice and marks it seen', async () => {
    const { controller, snap, storage } = setup();
    await controller.hydrate();
    controller.keepGlass();
    expect(snap()).toMatchObject({ introVisible: false, style: 'liquid-glass' });
    expect(snap().state.style).toBe('liquid-glass');
    await controller.flush();
    expect(storage.data.get(KEYS.introSeen)).toBe('1');
  });

  it('never under opt-in or off, never in classic, never after an explicit choice, never once seen, never during the crash fallback', async () => {
    for (const [seed, rollout] of [
      [{}, 'opt-in'],
      [{}, 'off'],
      [{ [KEYS.device]: device({ style: 'classic' }) }, 'default'],
      [{ [KEYS.device]: device({ style: 'liquid-glass' }) }, 'default'],
      [{ [KEYS.introSeen]: '1' }, 'default'],
      [{ [KEYS.fallback]: '1' }, 'default'],
    ] as const) {
      const { controller, snap } = setup(seed, { rollout });
      await controller.hydrate();
      expect(snap().introVisible, JSON.stringify({ seed, rollout })).toBe(false);
    }
  });
});

describe('what the controller touches', () => {
  it('only the four appearance keys, whatever happens', async () => {
    const { controller, account, storage } = setup({
      [KEYS.device]: device({ style: 'liquid-glass' }),
      [KEYS.fallback]: '1',
    });
    account.auto = (kind, _userId, axes) =>
      kind === 'save'
        ? { ok: true, row: row({ ...axes }, '2026-11-03T20:00:05Z') }
        : { ok: true, row: row({ theme: 'light' }, '2026-11-01T10:00:00Z') };
    await controller.hydrate();
    controller.setSession(A);
    await settle();
    controller.chooseStyle('classic');
    await settle();
    controller.setSession(null);
    controller.chooseTheme('system');
    controller.dismissIntro();
    await controller.flush();
    expect([...storage.touched].sort()).toEqual(
      [KEYS.fallback, KEYS.device, KEYS.sync, KEYS.introSeen].sort(),
    );
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
