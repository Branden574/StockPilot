import { describe, expect, it } from 'vitest';

import {
  INITIAL_APPEARANCE_STATE,
  isFreshPreSignInChoice,
  recoveryAppearance,
  reduceAppearance,
  type AppearanceEffect,
  type AppearanceEvent,
  type AppearanceState,
} from './reconcile';
import { PRE_SIGN_IN_CHOICE_WINDOW_MS } from './types';

const A = 'a0000000-0000-4000-8000-0000000000a1';
const B = 'b0000000-0000-4000-8000-0000000000b1';
const T0 = Date.UTC(2026, 10, 2, 10, 0, 0);
const MIN = 60 * 1000;
const ROW_OLD = '2026-11-01T09:00:00.000001+00:00';
const ROW_NEW = '2026-11-02T09:00:00.000001+00:00';

function run(
  events: AppearanceEvent[],
  start: AppearanceState = INITIAL_APPEARANCE_STATE,
): { state: AppearanceState; effects: AppearanceEffect[]; all: AppearanceEffect[] } {
  let state = start;
  let effects: AppearanceEffect[] = [];
  const all: AppearanceEffect[] = [];
  for (const event of events) {
    ({ state, effects } = reduceAppearance(state, event));
    all.push(...effects);
  }
  return { state, effects, all };
}

const types = (effects: AppearanceEffect[]) => effects.map((e) => e.type);
const saves = (effects: AppearanceEffect[]) =>
  effects.filter((e): e is Extract<AppearanceEffect, { type: 'save' }> => e.type === 'save');
const fetches = (effects: AppearanceEffect[]) =>
  effects.filter((e): e is Extract<AppearanceEffect, { type: 'fetch' }> => e.type === 'fetch');

/** A device signed in as A, synced with A's row (light at ROW_OLD), nothing pending. */
function syncedAsA(): AppearanceState {
  return run([
    {
      type: 'hydrate',
      device: { v: 1, mode: 'light', lastClassic: 'light' },
      sync: { v: 1, userId: A, dirty: false, syncedAt: ROW_OLD },
    },
  ]).state;
}

describe('hydrate', () => {
  it('a fresh install with nothing stored is classic System, as today', () => {
    const { state, effects } = run([{ type: 'hydrate', device: null, sync: null }]);
    expect(state.mode).toBe('system');
    expect(state.status).toBe('signed-out');
    expect(effects).toEqual([{ type: 'apply', mode: 'system' }]);
  });

  it('an existing web user with only next-themes’ theme keeps their look', () => {
    expect(
      run([{ type: 'hydrate', device: null, sync: null, legacyTheme: 'dark' }]).state.mode,
    ).toBe('dark');
    expect(
      run([{ type: 'hydrate', device: null, sync: null, legacyTheme: 'light' }]).state.lastClassic,
    ).toBe('light');
  });

  it('malformed stored values are dropped and never turn Liquid Glass on', () => {
    for (const device of [
      'Liquid Glass',
      '{"v":1,"mode":"glass"}',
      { v: 9, mode: 'liquid-glass' },
      42,
    ]) {
      const { state } = run([
        { type: 'hydrate', device, sync: 'garbage', legacyTheme: 'nonsense' },
      ]);
      expect(state.mode).toBe('system');
      expect(state.userId).toBeNull();
    }
  });

  it('reads the device record and the sync record', () => {
    const { state } = run([
      {
        type: 'hydrate',
        device: { v: 1, mode: 'liquid-glass', lastClassic: 'dark', anonAt: T0 },
        sync: { v: 1, userId: A, dirty: true, syncedAt: null },
      },
    ]);
    expect(state).toMatchObject({
      mode: 'liquid-glass',
      lastClassic: 'dark',
      anonAt: T0,
      userId: A,
      dirty: true,
      syncedAt: null,
    });
  });
});

describe('rule 1: an explicit choice', () => {
  it('signed out: applies at once, stays on the device with anonAt, saves nothing', () => {
    const { state, effects } = run([
      { type: 'hydrate', device: null, sync: null },
      { type: 'choose', mode: 'liquid-glass', userId: null, now: T0 },
    ]);
    expect(state).toMatchObject({ mode: 'liquid-glass', anonAt: T0, userId: null, dirty: false });
    expect(effects).toEqual([
      { type: 'apply', mode: 'liquid-glass' },
      {
        type: 'persist-device',
        record: { v: 1, mode: 'liquid-glass', lastClassic: 'system', anonAt: T0 },
      },
    ]);
  });

  it('signed in: applies, marks dirty, bumps gen and saves to the account', () => {
    const before = syncedAsA();
    const { state, effects } = run(
      [{ type: 'choose', mode: 'liquid-glass', userId: A, now: T0 }],
      before,
    );
    expect(state.gen).toBe(before.gen + 1);
    expect(state).toMatchObject({
      mode: 'liquid-glass',
      dirty: true,
      status: 'saving',
      anonAt: null,
    });
    expect(types(effects)).toEqual(['apply', 'persist-device', 'persist-sync', 'save']);
    expect(saves(effects)).toEqual([
      { type: 'save', userId: A, mode: 'liquid-glass', gen: state.gen },
    ]);
    expect(effects[2]).toEqual({
      type: 'persist-sync',
      record: { v: 1, userId: A, dirty: true, syncedAt: ROW_OLD },
    });
  });

  it('a successful save clears dirty and records the server’s updated_at', () => {
    const chose = run([{ type: 'choose', mode: 'dark', userId: A, now: T0 }], syncedAsA());
    const { state, effects } = run(
      [
        {
          type: 'save-succeeded',
          userId: A,
          gen: chose.state.gen,
          row: { appearance: 'dark', updated_at: ROW_NEW },
        },
      ],
      chose.state,
    );
    expect(state).toMatchObject({
      dirty: false,
      syncedAt: ROW_NEW,
      status: 'synced',
      saving: null,
    });
    expect(effects).toEqual([
      { type: 'persist-sync', record: { v: 1, userId: A, dirty: false, syncedAt: ROW_NEW } },
    ]);
  });

  it('lastClassic follows classic choices only, for the recovery action', () => {
    const { state } = run(
      [
        { type: 'choose', mode: 'dark', userId: A, now: T0 },
        { type: 'choose', mode: 'liquid-glass', userId: A, now: T0 + 1 },
      ],
      syncedAsA(),
    );
    expect(state.lastClassic).toBe('dark');
    expect(recoveryAppearance(state)).toBe('dark');
  });

  it('saves go one at a time; a choice made during a save is sent when it answers', () => {
    const first = run([{ type: 'choose', mode: 'dark', userId: A, now: T0 }], syncedAsA());
    const second = run(
      [{ type: 'choose', mode: 'liquid-glass', userId: A, now: T0 + 1 }],
      first.state,
    );
    expect(saves(second.effects)).toEqual([]);
    expect(second.state.status).toBe('saving');

    const answered = run(
      [
        {
          type: 'save-succeeded',
          userId: A,
          gen: first.state.gen,
          row: { appearance: 'dark', updated_at: ROW_NEW },
        },
      ],
      second.state,
    );
    expect(answered.state.dirty).toBe(true);
    expect(saves(answered.effects)).toEqual([
      { type: 'save', userId: A, mode: 'liquid-glass', gen: second.state.gen },
    ]);
  });
});

describe('rule 2: a failed save', () => {
  it('keeps the choice applied and dirty, says so, and Try again resends it', () => {
    const chose = run([{ type: 'choose', mode: 'liquid-glass', userId: A, now: T0 }], syncedAsA());
    const failed = run(
      [{ type: 'save-failed', userId: A, gen: chose.state.gen, reason: 'error' }],
      chose.state,
    );
    expect(failed.state).toMatchObject({
      mode: 'liquid-glass',
      dirty: true,
      status: 'failed',
      saving: null,
    });
    expect(failed.effects).toEqual([]);

    const retried = run([{ type: 'retry', userId: A }], failed.state);
    expect(saves(retried.effects)).toEqual([
      { type: 'save', userId: A, mode: 'liquid-glass', gen: chose.state.gen },
    ]);
  });

  it('never claims synced when the answer does not echo what was sent', () => {
    const chose = run([{ type: 'choose', mode: 'liquid-glass', userId: A, now: T0 }], syncedAsA());
    for (const row of [
      null,
      { appearance: 'dark', updated_at: ROW_NEW },
      { appearance: 'liquid-glass' },
    ]) {
      const { state, effects } = run(
        [{ type: 'save-succeeded', userId: A, gen: chose.state.gen, row }],
        chose.state,
      );
      expect(state).toMatchObject({ dirty: true, status: 'failed', saving: null });
      expect(saves(effects)).toEqual([]);
    }
  });

  it('retry does nothing for another person, signed out, or when nothing is pending', () => {
    const chose = run([{ type: 'choose', mode: 'dark', userId: A, now: T0 }], syncedAsA());
    const failed = run(
      [{ type: 'save-failed', userId: A, gen: chose.state.gen, reason: 'error' }],
      chose.state,
    );
    expect(run([{ type: 'retry', userId: B }], failed.state).effects).toEqual([]);
    expect(run([{ type: 'retry', userId: null }], failed.state).effects).toEqual([]);
    expect(run([{ type: 'retry', userId: A }], syncedAsA()).effects).toEqual([]);
  });
});

describe('rule 3: a late fetch', () => {
  it('is dropped when a choice was made after it started', () => {
    const signedIn = run([{ type: 'authenticated', userId: A, now: T0 }], syncedAsA());
    const [fetch] = fetches(signedIn.effects);
    expect(fetch).toBeDefined();

    const chose = run(
      [{ type: 'choose', mode: 'liquid-glass', userId: A, now: T0 + 1 }],
      signedIn.state,
    );
    const late = run(
      [
        {
          type: 'fetch-succeeded',
          userId: A,
          gen: fetch!.gen,
          row: { appearance: 'dark', updated_at: ROW_NEW },
        },
      ],
      chose.state,
    );
    expect(late.state.mode).toBe('liquid-glass');
    expect(late.state).toBe(chose.state);
    expect(late.effects).toEqual([]);
  });

  it('is dropped when another tab made a choice after it started', () => {
    const signedIn = run([{ type: 'authenticated', userId: A, now: T0 }], syncedAsA());
    const [fetch] = fetches(signedIn.effects);
    const otherTab = run(
      [{ type: 'device-changed', device: { v: 1, mode: 'liquid-glass', lastClassic: 'light' } }],
      signedIn.state,
    );
    expect(otherTab.effects).toEqual([{ type: 'apply', mode: 'liquid-glass' }]);
    const late = run(
      [
        {
          type: 'fetch-succeeded',
          userId: A,
          gen: fetch!.gen,
          row: { appearance: 'dark', updated_at: ROW_NEW },
        },
      ],
      otherTab.state,
    );
    expect(late.state.mode).toBe('liquid-glass');
  });

  it('a save answer for an older save never marks a newer choice as synced', () => {
    const first = run([{ type: 'choose', mode: 'dark', userId: A, now: T0 }], syncedAsA());
    const second = run([{ type: 'choose', mode: 'light', userId: A, now: T0 + 1 }], first.state);
    const answered = run(
      [
        {
          type: 'save-succeeded',
          userId: A,
          gen: first.state.gen,
          row: { appearance: 'dark', updated_at: ROW_NEW },
        },
      ],
      second.state,
    );
    expect(answered.state.status).not.toBe('synced');
    expect(answered.state.dirty).toBe(true);
  });
});

describe('rule 4: after authentication', () => {
  it('4a: a choice made signed out under 30 minutes ago is pushed and the row is not fetched', () => {
    const { state, effects } = run([
      { type: 'hydrate', device: null, sync: null },
      { type: 'choose', mode: 'liquid-glass', userId: null, now: T0 },
      { type: 'authenticated', userId: A, now: T0 + 29 * MIN },
    ]);
    expect(state).toMatchObject({
      mode: 'liquid-glass',
      anonAt: null,
      userId: A,
      dirty: true,
      status: 'saving',
    });
    expect(fetches(effects)).toEqual([]);
    expect(saves(effects)).toEqual([
      { type: 'save', userId: A, mode: 'liquid-glass', gen: state.gen },
    ]);
    expect(effects).toContainEqual({
      type: 'persist-device',
      record: { v: 1, mode: 'liquid-glass', lastClassic: 'system' },
    });
  });

  it('4a: the pushed choice wins over the account row even when the row is newer', () => {
    const pushed = run([
      { type: 'hydrate', device: null, sync: null },
      { type: 'choose', mode: 'liquid-glass', userId: null, now: T0 },
      { type: 'authenticated', userId: A, now: T0 + MIN },
    ]);
    const saved = run(
      [
        {
          type: 'save-succeeded',
          userId: A,
          gen: pushed.state.gen,
          row: { appearance: 'liquid-glass', updated_at: ROW_NEW },
        },
      ],
      pushed.state,
    );
    expect(saved.state).toMatchObject({ mode: 'liquid-glass', status: 'synced', dirty: false });
  });

  it('4a: at or past 30 minutes the choice is forgotten as pre-sign-in and the row decides', () => {
    for (const age of [30 * MIN, 31 * MIN, 24 * 60 * MIN]) {
      const { state, effects } = run([
        { type: 'hydrate', device: null, sync: null },
        { type: 'choose', mode: 'liquid-glass', userId: null, now: T0 },
        { type: 'authenticated', userId: A, now: T0 + age },
      ]);
      expect(state).toMatchObject({ anonAt: null, dirty: false, userId: A });
      expect(saves(effects)).toEqual([]);
      expect(fetches(effects)).toEqual([{ type: 'fetch', userId: A, gen: state.gen }]);
      expect(effects).toContainEqual({
        type: 'persist-device',
        record: { v: 1, mode: 'liquid-glass', lastClassic: 'system' },
      });

      const adopted = run(
        [
          {
            type: 'fetch-succeeded',
            userId: A,
            gen: state.gen,
            row: { appearance: 'dark', updated_at: ROW_OLD },
          },
        ],
        state,
      );
      expect(adopted.state.mode).toBe('dark');
    }
  });

  it('4a: the window is the 30 minutes the owner chose, both ways around a clock change', () => {
    expect(PRE_SIGN_IN_CHOICE_WINDOW_MS).toBe(30 * MIN);
    expect(isFreshPreSignInChoice(T0, T0)).toBe(true);
    expect(isFreshPreSignInChoice(T0, T0 + 30 * MIN - 1)).toBe(true);
    expect(isFreshPreSignInChoice(T0, T0 + 30 * MIN)).toBe(false);
    expect(isFreshPreSignInChoice(T0 + 5 * MIN, T0)).toBe(true);
    expect(isFreshPreSignInChoice(T0 + 365 * 24 * 60 * MIN, T0)).toBe(false);
  });

  it('4b: this person’s own unsaved choice is pushed, not overwritten by a fetch', () => {
    const { state, effects } = run([
      {
        type: 'hydrate',
        device: { v: 1, mode: 'liquid-glass', lastClassic: 'light' },
        sync: { v: 1, userId: A, dirty: true, syncedAt: ROW_OLD },
      },
      { type: 'authenticated', userId: A, now: T0 },
    ]);
    expect(fetches(effects)).toEqual([]);
    expect(saves(effects)).toEqual([
      { type: 'save', userId: A, mode: 'liquid-glass', gen: state.gen },
    ]);
  });

  it('4c: a newer row is adopted', () => {
    const signedIn = run([{ type: 'authenticated', userId: A, now: T0 }], syncedAsA());
    const [fetch] = fetches(signedIn.effects);
    const { state, effects } = run(
      [
        {
          type: 'fetch-succeeded',
          userId: A,
          gen: fetch!.gen,
          row: { appearance: 'liquid-glass', updated_at: ROW_NEW },
        },
      ],
      signedIn.state,
    );
    expect(state).toMatchObject({
      mode: 'liquid-glass',
      syncedAt: ROW_NEW,
      status: 'synced',
      lastClassic: 'light',
    });
    expect(effects).toEqual([
      { type: 'apply', mode: 'liquid-glass' },
      { type: 'persist-device', record: { v: 1, mode: 'liquid-glass', lastClassic: 'light' } },
      { type: 'persist-sync', record: { v: 1, userId: A, dirty: false, syncedAt: ROW_NEW } },
    ]);
  });

  it('4c: a row no newer than the last sync changes nothing', () => {
    const signedIn = run([{ type: 'authenticated', userId: A, now: T0 }], syncedAsA());
    const [fetch] = fetches(signedIn.effects);
    const { state, effects } = run(
      [
        {
          type: 'fetch-succeeded',
          userId: A,
          gen: fetch!.gen,
          row: { appearance: 'dark', updated_at: ROW_OLD },
        },
      ],
      signedIn.state,
    );
    expect(state.mode).toBe('light');
    expect(state.status).toBe('synced');
    expect(effects).toEqual([]);
  });

  it('4c: a device that never synced with this person adopts the row', () => {
    const { state } = run([
      { type: 'hydrate', device: { v: 1, mode: 'dark', lastClassic: 'dark' }, sync: null },
      { type: 'authenticated', userId: A, now: T0 },
      {
        type: 'fetch-succeeded',
        userId: A,
        gen: 0,
        row: { appearance: 'liquid-glass', updated_at: ROW_OLD },
      },
    ]);
    expect(state.mode).toBe('liquid-glass');
  });

  it('4d: no row keeps the device value and uploads nothing', () => {
    const signedIn = run([
      { type: 'hydrate', device: { v: 1, mode: 'dark', lastClassic: 'dark' }, sync: null },
      { type: 'authenticated', userId: A, now: T0 },
    ]);
    const { state, effects } = run(
      [{ type: 'fetch-succeeded', userId: A, gen: signedIn.state.gen, row: null }],
      signedIn.state,
    );
    expect(state).toMatchObject({ mode: 'dark', dirty: false, status: 'idle' });
    expect(effects).toEqual([]);
  });

  it('a row holding a value this code does not know is never adopted', () => {
    const signedIn = run([{ type: 'authenticated', userId: A, now: T0 }], syncedAsA());
    const { state } = run(
      [
        {
          type: 'fetch-succeeded',
          userId: A,
          gen: signedIn.state.gen,
          row: { appearance: 'Liquid Glass', updated_at: ROW_NEW },
        },
      ],
      signedIn.state,
    );
    expect(state.mode).toBe('light');
  });
});

describe('rules 5 and 6: sign-out and another account', () => {
  it('sign-out keeps the look and erases the sync record', () => {
    const chose = run([{ type: 'choose', mode: 'liquid-glass', userId: A, now: T0 }], syncedAsA());
    const { state, effects } = run([{ type: 'signed-out' }], chose.state);
    expect(state).toMatchObject({
      mode: 'liquid-glass',
      userId: null,
      dirty: false,
      syncedAt: null,
      status: 'signed-out',
    });
    expect(effects).toEqual([{ type: 'persist-sync', record: null }]);
  });

  it('an answer that arrives after sign-out is ignored', () => {
    const chose = run([{ type: 'choose', mode: 'liquid-glass', userId: A, now: T0 }], syncedAsA());
    const out = run([{ type: 'signed-out' }], chose.state);
    const late = run(
      [
        {
          type: 'save-succeeded',
          userId: A,
          gen: chose.state.gen,
          row: { appearance: 'liquid-glass', updated_at: ROW_NEW },
        },
      ],
      out.state,
    );
    expect(late.state).toBe(out.state);
  });

  it('A’s unsaved choice is never written under B; B gets B’s own row', () => {
    const chose = run([{ type: 'choose', mode: 'liquid-glass', userId: A, now: T0 }], syncedAsA());
    const failed = run(
      [{ type: 'save-failed', userId: A, gen: chose.state.gen, reason: 'error' }],
      chose.state,
    );
    // B signs in on the same device without a clean sign-out (session expired).
    const asB = run([{ type: 'authenticated', userId: B, now: T0 + 60 * MIN }], failed.state);
    expect(saves(asB.effects)).toEqual([]);
    expect(asB.state).toMatchObject({ userId: B, dirty: false, syncedAt: null });
    expect(asB.effects).toContainEqual({
      type: 'persist-sync',
      record: { v: 1, userId: B, dirty: false, syncedAt: null },
    });
    expect(fetches(asB.effects)).toEqual([{ type: 'fetch', userId: B, gen: asB.state.gen }]);

    const adopted = run(
      [
        {
          type: 'fetch-succeeded',
          userId: B,
          gen: asB.state.gen,
          row: { appearance: 'dark', updated_at: ROW_OLD },
        },
      ],
      asB.state,
    );
    expect(adopted.state.mode).toBe('dark');

    // A retry for A, or A's late answers, no longer do anything.
    expect(run([{ type: 'retry', userId: A }], adopted.state).effects).toEqual([]);
    expect(
      run(
        [
          {
            type: 'fetch-succeeded',
            userId: A,
            gen: adopted.state.gen,
            row: { appearance: 'light', updated_at: ROW_NEW },
          },
        ],
        adopted.state,
      ).state.mode,
    ).toBe('dark');
  });

  it('a sync record for another person is ignored at sign-in', () => {
    const { state, effects } = run([
      {
        type: 'hydrate',
        device: { v: 1, mode: 'liquid-glass', lastClassic: 'light' },
        sync: { v: 1, userId: A, dirty: true, syncedAt: ROW_OLD },
      },
      { type: 'authenticated', userId: B, now: T0 },
    ]);
    expect(saves(effects)).toEqual([]);
    expect(state).toMatchObject({ userId: B, dirty: false });
  });

  it('B choosing on a device that still holds A’s sync record saves under B only', () => {
    const chose = run([{ type: 'choose', mode: 'dark', userId: B, now: T0 }], syncedAsA());
    expect(saves(chose.effects)).toEqual([
      { type: 'save', userId: B, mode: 'dark', gen: chose.state.gen },
    ]);
    expect(chose.state).toMatchObject({ userId: B, syncedAt: null });
  });

  it('a choice made signed out drops whatever sync record was left', () => {
    const { state, effects } = run(
      [{ type: 'choose', mode: 'dark', userId: null, now: T0 }],
      syncedAsA(),
    );
    expect(state.userId).toBeNull();
    expect(effects).toContainEqual({ type: 'persist-sync', record: null });
  });
});

describe('the account store is missing', () => {
  it('a save that finds no table says device only, stays dirty, and never claims sync', () => {
    const chose = run([{ type: 'choose', mode: 'liquid-glass', userId: A, now: T0 }], syncedAsA());
    const { state } = run(
      [{ type: 'save-failed', userId: A, gen: chose.state.gen, reason: 'missing-table' }],
      chose.state,
    );
    expect(state).toMatchObject({ status: 'unavailable', dirty: true, mode: 'liquid-glass' });
  });

  it('a fetch that finds no table says device only and keeps the device value', () => {
    const signedIn = run([{ type: 'authenticated', userId: A, now: T0 }], syncedAsA());
    const { state } = run(
      [{ type: 'fetch-failed', userId: A, gen: signedIn.state.gen, reason: 'missing-table' }],
      signedIn.state,
    );
    expect(state).toMatchObject({ status: 'unavailable', mode: 'light' });
  });

  it('any other fetch failure changes nothing and claims nothing', () => {
    const signedIn = run([{ type: 'authenticated', userId: A, now: T0 }], syncedAsA());
    const { state } = run(
      [{ type: 'fetch-failed', userId: A, gen: signedIn.state.gen, reason: 'error' }],
      signedIn.state,
    );
    expect(state).toBe(signedIn.state);
    expect(state.status).not.toBe('synced');
  });
});

describe('purity', () => {
  it('never mutates the state it is given', () => {
    const before = syncedAsA();
    const frozen = Object.freeze({ ...before });
    expect(() =>
      run(
        [
          { type: 'choose', mode: 'liquid-glass', userId: A, now: T0 },
          { type: 'signed-out' },
          { type: 'authenticated', userId: B, now: T0 },
        ],
        frozen,
      ),
    ).not.toThrow();
    expect(frozen).toEqual(before);
  });
});
