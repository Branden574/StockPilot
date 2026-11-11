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
import { PRE_SIGN_IN_CHOICE_WINDOW_MS, PRE_SIGN_IN_CLOCK_SKEW_MS } from './types';

const A = 'a0000000-0000-4000-8000-0000000000a1';
const B = 'b0000000-0000-4000-8000-0000000000b1';
const T0 = Date.UTC(2026, 10, 2, 10, 0, 0);
const MIN = 60 * 1000;
const ROW_OLD = '2026-11-01T09:00:00.000001+00:00';
const ROW_NEW = '2026-11-02T09:00:00.000001+00:00';
const ROW_NEWER = '2026-11-02T09:30:00.000001+00:00';

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
const applies = (effects: AppearanceEffect[]) =>
  effects.filter((e): e is Extract<AppearanceEffect, { type: 'apply' }> => e.type === 'apply');

const hydrate = (
  device: unknown,
  sync: unknown,
  anonFlow?: unknown,
  now = T0,
): AppearanceEvent => ({
  type: 'hydrate',
  device,
  sync,
  anonFlow,
  now,
});

/** A device signed in as A, synced with A's row (Liquid Glass, Light at ROW_OLD), nothing pending. */
function syncedAsA(): AppearanceState {
  return run([
    hydrate(
      { v: 2, style: 'liquid-glass', theme: 'light' },
      { v: 2, userId: A, dirtyAxes: [], syncedAt: ROW_OLD },
    ),
  ]).state;
}

/** A save effect's answer: the server echoes the whole row. */
const row = (style: string | null, theme: string | null, updated_at = ROW_NEW) => ({
  style,
  theme,
  updated_at,
});

describe('hydrate', () => {
  it('nothing stored means never chose: no Design, no Theme (the rollout decides what is shown)', () => {
    const { state, effects } = run([hydrate(null, null)]);
    expect(state).toMatchObject({ style: null, theme: null, status: 'signed-out' });
    expect(effects).toEqual([{ type: 'apply', source: 'hydrate', style: null, theme: null }]);
  });

  it('malformed stored values are dropped and mean never chose', () => {
    for (const device of [
      'Liquid Glass',
      'classic',
      '{"v":2,"style":"glass"}',
      { v: 9, style: 'liquid-glass' },
      { v: 1, mode: 'liquid-glass', lastClassic: 'dark' },
      42,
    ]) {
      const { state } = run([hydrate(device, 'garbage')]);
      expect(state.style).toBeNull();
      expect(state.theme).toBeNull();
      expect(state.userId).toBeNull();
    }
  });

  it('the stage 2 sync record (version 1) is ignored', () => {
    const { state } = run([
      hydrate({ v: 2, style: 'classic' }, { v: 1, userId: A, dirty: true, syncedAt: ROW_OLD }),
    ]);
    expect(state).toMatchObject({ style: 'classic', userId: null, dirtyAxes: [] });
  });

  it('reads the device record and the sync record', () => {
    const { state } = run([
      hydrate(
        { v: 2, style: 'classic', theme: 'dark', anonAt: T0 },
        { v: 2, userId: A, dirtyAxes: ['theme'], syncedAt: ROW_OLD },
      ),
    ]);
    expect(state).toMatchObject({
      style: 'classic',
      theme: 'dark',
      anonAt: T0,
      userId: A,
      dirtyAxes: ['theme'],
      uncheckedAxes: [],
      syncedAt: ROW_OLD,
    });
  });

  it('SR1: a stored dirty axis without a confirmed sync must be checked against the row', () => {
    const { state } = run([
      hydrate(
        { v: 2, style: 'classic' },
        { v: 2, userId: A, dirtyAxes: ['style'], syncedAt: null },
      ),
    ]);
    expect(state).toMatchObject({ dirtyAxes: ['style'], uncheckedAxes: ['style'] });
  });

  it('a dirty axis with no value on this device is dropped (nothing to send)', () => {
    const { state } = run([
      hydrate(
        { v: 2, style: 'classic' },
        { v: 2, userId: A, dirtyAxes: ['style', 'theme'], syncedAt: ROW_OLD },
      ),
    ]);
    expect(state.dirtyAxes).toEqual(['style']);
  });

  it('SR2: an anonAt more than 60 s in the future is dropped at hydrate', () => {
    const { state } = run([
      hydrate({ v: 2, style: 'classic', anonAt: T0 + 2 * MIN }, null, undefined, T0),
    ]);
    expect(state.anonAt).toBeNull();
  });
});

describe('rule 1: an explicit choice', () => {
  it('signed out: applies at once, stays on the device with anonAt, stamps the flow, saves nothing', () => {
    const { state, effects } = run([
      hydrate(null, null),
      { type: 'choose', axis: 'style', value: 'classic', userId: null, now: T0 },
    ]);
    expect(state).toMatchObject({
      style: 'classic',
      anonAt: T0,
      anonAxes: ['style'],
      userId: null,
    });
    expect(effects).toEqual([
      { type: 'apply', source: 'choice', style: 'classic', theme: null },
      { type: 'persist-device', record: { v: 2, style: 'classic', anonAt: T0 } },
      { type: 'persist-anon-flow', record: { v: 1, anonAt: T0, axes: ['style'] } },
    ]);
  });

  it('signed in: applies, marks only that axis dirty, bumps gen and saves only that axis', () => {
    const before = syncedAsA();
    const { state, effects } = run(
      [{ type: 'choose', axis: 'style', value: 'classic', userId: A, now: T0 }],
      before,
    );
    expect(state.gen).toBe(before.gen + 1);
    expect(state).toMatchObject({
      style: 'classic',
      theme: 'light',
      dirtyAxes: ['style'],
      status: 'saving',
      anonAt: null,
    });
    expect(types(effects)).toEqual(['apply', 'persist-device', 'persist-sync', 'save']);
    expect(saves(effects)).toEqual([
      { type: 'save', userId: A, axes: { style: 'classic' }, gen: state.gen },
    ]);
    expect(effects[2]).toEqual({
      type: 'persist-sync',
      record: { v: 2, userId: A, dirtyAxes: ['style'], syncedAt: ROW_OLD },
    });
  });

  it('a Theme choice never changes the Design, and a Design choice never changes the Theme', () => {
    const theme = run(
      [{ type: 'choose', axis: 'theme', value: 'dark', userId: A, now: T0 }],
      syncedAsA(),
    );
    expect(theme.state).toMatchObject({ style: 'liquid-glass', theme: 'dark' });
    expect(saves(theme.effects)[0]!.axes).toEqual({ theme: 'dark' });
    const style = run(
      [{ type: 'choose', axis: 'style', value: 'classic', userId: A, now: T0 }],
      syncedAsA(),
    );
    expect(style.state).toMatchObject({ style: 'classic', theme: 'light' });
  });

  it('a value that is not one of the known words is ignored', () => {
    const before = syncedAsA();
    const bad = run(
      [
        {
          type: 'choose',
          axis: 'style',
          value: 'Liquid Glass',
          userId: A,
          now: T0,
        } as unknown as AppearanceEvent,
      ],
      before,
    );
    expect(bad.state).toBe(before);
    expect(bad.effects).toEqual([]);
  });

  it('a successful save clears that axis and records the server’s updated_at', () => {
    const chose = run(
      [{ type: 'choose', axis: 'theme', value: 'dark', userId: A, now: T0 }],
      syncedAsA(),
    );
    const { state, effects } = run(
      [
        {
          type: 'save-succeeded',
          userId: A,
          gen: chose.state.gen,
          row: row('liquid-glass', 'dark'),
        },
      ],
      chose.state,
    );
    expect(state).toMatchObject({
      dirtyAxes: [],
      syncedAt: ROW_NEW,
      status: 'synced',
      saving: null,
    });
    expect(effects).toEqual([
      { type: 'persist-sync', record: { v: 2, userId: A, dirtyAxes: [], syncedAt: ROW_NEW } },
    ]);
  });

  it('saves go one at a time; a choice made during a save is sent when it answers', () => {
    const first = run(
      [{ type: 'choose', axis: 'style', value: 'classic', userId: A, now: T0 }],
      syncedAsA(),
    );
    const second = run(
      [{ type: 'choose', axis: 'theme', value: 'dark', userId: A, now: T0 + 1 }],
      first.state,
    );
    expect(saves(second.effects)).toEqual([]);
    expect(second.state.status).toBe('saving');

    const answered = run(
      [{ type: 'save-succeeded', userId: A, gen: first.state.gen, row: row('classic', 'light') }],
      second.state,
    );
    expect(answered.state.dirtyAxes).toEqual(['style', 'theme']);
    expect(saves(answered.effects)).toEqual([
      { type: 'save', userId: A, axes: { style: 'classic', theme: 'dark' }, gen: second.state.gen },
    ]);
  });

  it('keep-glass makes the shown default an explicit, saved Design', () => {
    const signedIn = run([
      hydrate(null, { v: 2, userId: A, dirtyAxes: [], syncedAt: ROW_OLD }),
    ]).state;
    const { state, effects } = run([{ type: 'keep-glass', userId: A, now: T0 }], signedIn);
    expect(state).toMatchObject({ style: 'liquid-glass', dirtyAxes: ['style'] });
    expect(saves(effects)).toEqual([
      { type: 'save', userId: A, axes: { style: 'liquid-glass' }, gen: state.gen },
    ]);
    // Already Liquid Glass by choice: nothing to do.
    const again = run([{ type: 'keep-glass', userId: A, now: T0 }], syncedAsA());
    expect(again.effects).toEqual([]);
  });

  it('keep-glass signed out is a signed-out choice', () => {
    const { state } = run([hydrate(null, null), { type: 'keep-glass', userId: null, now: T0 }]);
    expect(state).toMatchObject({ style: 'liquid-glass', anonAt: T0, anonAxes: ['style'] });
  });

  it('the recovery action writes Classic and leaves the Theme alone', () => {
    expect(recoveryAppearance()).toEqual({ style: 'classic' });
  });
});

describe('rule 2: a failed save', () => {
  it('keeps the choice applied and dirty, says so, and Try again resends it', () => {
    const chose = run(
      [{ type: 'choose', axis: 'style', value: 'classic', userId: A, now: T0 }],
      syncedAsA(),
    );
    const failed = run(
      [{ type: 'save-failed', userId: A, gen: chose.state.gen, reason: 'error' }],
      chose.state,
    );
    expect(failed.state).toMatchObject({
      style: 'classic',
      dirtyAxes: ['style'],
      status: 'failed',
      saving: null,
    });
    expect(failed.effects).toEqual([]);

    const retried = run([{ type: 'retry', userId: A }], failed.state);
    expect(saves(retried.effects)).toEqual([
      { type: 'save', userId: A, axes: { style: 'classic' }, gen: chose.state.gen },
    ]);
  });

  it('never claims synced when the answer does not echo every sent axis', () => {
    const chose = run(
      [{ type: 'choose', axis: 'style', value: 'classic', userId: A, now: T0 }],
      syncedAsA(),
    );
    for (const answer of [
      null,
      row('liquid-glass', 'light'),
      row(null, 'light'),
      { style: 'classic' },
    ]) {
      const { state, effects } = run(
        [{ type: 'save-succeeded', userId: A, gen: chose.state.gen, row: answer }],
        chose.state,
      );
      expect(state).toMatchObject({ dirtyAxes: ['style'], status: 'failed', saving: null });
      expect(saves(effects)).toEqual([]);
    }
  });

  it('retry does nothing for another person, signed out, or when nothing is pending', () => {
    const chose = run(
      [{ type: 'choose', axis: 'theme', value: 'dark', userId: A, now: T0 }],
      syncedAsA(),
    );
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
      [{ type: 'choose', axis: 'style', value: 'classic', userId: A, now: T0 + 1 }],
      signedIn.state,
    );
    const late = run(
      [{ type: 'fetch-succeeded', userId: A, gen: fetch!.gen, row: row('liquid-glass', 'dark') }],
      chose.state,
    );
    expect(late.state).toBe(chose.state);
    expect(late.effects).toEqual([]);
  });

  it('is dropped when another tab made a choice after it started', () => {
    const signedIn = run([{ type: 'authenticated', userId: A, now: T0 }], syncedAsA());
    const [fetch] = fetches(signedIn.effects);
    const otherTab = run(
      [{ type: 'device-changed', device: { v: 2, style: 'classic', theme: 'light' }, now: T0 }],
      signedIn.state,
    );
    expect(otherTab.effects).toEqual([
      { type: 'apply', source: 'cross-tab', style: 'classic', theme: 'light' },
    ]);
    const late = run(
      [
        {
          type: 'fetch-succeeded',
          userId: A,
          gen: fetch!.gen,
          row: row('liquid-glass', 'dark', ROW_NEWER),
        },
      ],
      otherTab.state,
    );
    expect(late.state.style).toBe('classic');
  });

  it('a dropped answer is read again while axes still wait for the row', () => {
    const waiting = run([
      hydrate(
        { v: 2, style: 'classic' },
        { v: 2, userId: A, dirtyAxes: ['style'], syncedAt: null },
      ),
      { type: 'authenticated', userId: A, now: T0 },
    ]);
    const [fetch] = fetches(waiting.effects);
    const otherTab = run(
      [{ type: 'device-changed', device: { v: 2, style: 'classic', theme: 'dark' }, now: T0 }],
      waiting.state,
    );
    const late = run(
      [{ type: 'fetch-succeeded', userId: A, gen: fetch!.gen, row: null }],
      otherTab.state,
    );
    expect(late.effects).toEqual([{ type: 'fetch', userId: A, gen: otherTab.state.gen }]);
  });

  it('a save answer for an older save never marks a newer choice as synced', () => {
    const first = run(
      [{ type: 'choose', axis: 'style', value: 'classic', userId: A, now: T0 }],
      syncedAsA(),
    );
    const second = run(
      [{ type: 'choose', axis: 'style', value: 'liquid-glass', userId: A, now: T0 + 1 }],
      first.state,
    );
    const answered = run(
      [{ type: 'save-succeeded', userId: A, gen: first.state.gen, row: row('classic', 'light') }],
      second.state,
    );
    expect(answered.state.status).not.toBe('synced');
    expect(answered.state.dirtyAxes).toEqual(['style']);
    expect(answered.state.style).toBe('liquid-glass');
    expect(saves(answered.effects)).toEqual([
      { type: 'save', userId: A, axes: { style: 'liquid-glass' }, gen: second.state.gen },
    ]);
  });
});

describe('SR4 and rule 4a: a choice made signed out, then sign-in', () => {
  /** Signed out on a fresh device, chose Classic at T0 in this tab, then signs in as A. */
  const signIn = (now: number, anonFlow?: unknown) => {
    const chose = run([
      hydrate(null, null),
      { type: 'choose', axis: 'style', value: 'classic', userId: null, now: T0 },
    ]);
    // The web reloads on sign-in: the device record and this tab's stamp come back from storage.
    const reloaded = run(
      [
        hydrate(
          { v: 2, style: 'classic', anonAt: T0 },
          null,
          anonFlow ?? { v: 1, anonAt: T0, axes: ['style'] },
          now,
        ),
      ],
      chose.state,
    );
    return run([{ type: 'authenticated', userId: A, now }], reloaded.state);
  };

  it('the row is read first; nothing is pushed before it answers', () => {
    const { state, effects } = signIn(T0 + 5 * MIN);
    expect(state).toMatchObject({
      userId: A,
      anonAt: null,
      anonAxes: [],
      dirtyAxes: ['style'],
      uncheckedAxes: ['style'],
    });
    expect(saves(effects)).toEqual([]);
    expect(fetches(effects)).toEqual([{ type: 'fetch', userId: A, gen: state.gen }]);
    expect(effects).toContainEqual({ type: 'persist-device', record: { v: 2, style: 'classic' } });
    expect(effects).toContainEqual({ type: 'persist-anon-flow', record: null });
    expect(effects).toContainEqual({
      type: 'persist-sync',
      record: { v: 2, userId: A, dirtyAxes: ['style'], syncedAt: null },
    });
  });

  it('row null: the fresh signed-out choice wins and is saved', () => {
    const signedIn = signIn(T0 + 29 * MIN);
    const { state, effects } = run(
      [{ type: 'fetch-succeeded', userId: A, gen: signedIn.state.gen, row: null }],
      signedIn.state,
    );
    expect(saves(effects)).toEqual([
      { type: 'save', userId: A, axes: { style: 'classic' }, gen: state.gen },
    ]);
    expect(state).toMatchObject({ style: 'classic', status: 'saving', uncheckedAxes: [] });
  });

  it('row axis null: the choice wins on that axis; the row keeps its other axis', () => {
    const signedIn = signIn(T0 + MIN);
    const { state, effects } = run(
      [{ type: 'fetch-succeeded', userId: A, gen: signedIn.state.gen, row: row(null, 'dark') }],
      signedIn.state,
    );
    expect(state).toMatchObject({ style: 'classic', theme: 'dark' });
    expect(saves(effects)).toEqual([
      { type: 'save', userId: A, axes: { style: 'classic' }, gen: state.gen },
    ]);
    expect(applies(effects)).toEqual([
      { type: 'apply', source: 'adopted', style: 'classic', theme: 'dark' },
    ]);
  });

  it('row set: the stored Design wins over the signed-out choice and nothing is saved', () => {
    const signedIn = signIn(T0 + MIN);
    const { state, effects } = run(
      [
        {
          type: 'fetch-succeeded',
          userId: A,
          gen: signedIn.state.gen,
          row: row('liquid-glass', null),
        },
      ],
      signedIn.state,
    );
    expect(state).toMatchObject({
      style: 'liquid-glass',
      dirtyAxes: [],
      uncheckedAxes: [],
      status: 'synced',
    });
    expect(saves(effects)).toEqual([]);
    expect(applies(effects)).toEqual([
      { type: 'apply', source: 'adopted', style: 'liquid-glass', theme: null },
    ]);
  });

  it('SR2: at or past 30 minutes the choice is not offered; the device keeps it, uploads nothing', () => {
    for (const age of [30 * MIN, 31 * MIN, 24 * 60 * MIN]) {
      const { state, effects } = signIn(T0 + age);
      expect(state).toMatchObject({ anonAt: null, dirtyAxes: [], userId: A, style: 'classic' });
      expect(saves(effects)).toEqual([]);
      expect(fetches(effects)).toEqual([{ type: 'fetch', userId: A, gen: state.gen }]);
      const answered = run(
        [{ type: 'fetch-succeeded', userId: A, gen: state.gen, row: null }],
        state,
      );
      expect(saves(answered.effects)).toEqual([]);
    }
  });

  it('SR2: the window is one-sided, with 60 s for a clock slightly behind', () => {
    expect(PRE_SIGN_IN_CHOICE_WINDOW_MS).toBe(30 * MIN);
    expect(PRE_SIGN_IN_CLOCK_SKEW_MS).toBe(MIN);
    expect(isFreshPreSignInChoice(T0, T0)).toBe(true);
    expect(isFreshPreSignInChoice(T0, T0 + 30 * MIN - 1)).toBe(true);
    expect(isFreshPreSignInChoice(T0, T0 + 30 * MIN)).toBe(false);
    expect(isFreshPreSignInChoice(T0 + MIN, T0)).toBe(true);
    expect(isFreshPreSignInChoice(T0 + MIN + 1, T0)).toBe(false);
    expect(isFreshPreSignInChoice(T0 + 5 * MIN, T0)).toBe(false);
    expect(isFreshPreSignInChoice(T0 + 365 * 24 * 60 * MIN, T0)).toBe(false);
  });

  it('SR2: a future stamp kept in memory (a broken clock) is not offered', () => {
    const chose = run([
      hydrate(null, null),
      { type: 'choose', axis: 'style', value: 'classic', userId: null, now: T0 + 10 * MIN },
    ]);
    const { state, effects } = run([{ type: 'authenticated', userId: A, now: T0 }], chose.state);
    expect(state.dirtyAxes).toEqual([]);
    expect(saves(effects)).toEqual([]);
  });

  it('SR4: a choice made in another tab or an earlier visit (no matching stamp) never reaches the account', () => {
    for (const anonFlow of [null, { v: 1, anonAt: T0 - 1, axes: ['style'] }, 'garbage']) {
      const fresh = run([
        hydrate({ v: 2, style: 'classic', anonAt: T0 }, null, anonFlow, T0 + MIN),
        { type: 'authenticated', userId: A, now: T0 + MIN },
      ]);
      expect(fresh.state.dirtyAxes).toEqual([]);
      const answered = run(
        [{ type: 'fetch-succeeded', userId: A, gen: fresh.state.gen, row: null }],
        fresh.state,
      );
      expect(saves(answered.all)).toEqual([]);
      expect(answered.state.style).toBe('classic');
    }
  });

  it('SR4: only the axes chosen in this flow are offered, never the other axis someone left', () => {
    // A previous person chose Classic (their record stays on the device);
    // this person chooses Dark on the sign-in page, then signs in.
    const { state } = run([
      hydrate({ v: 2, style: 'classic' }, null),
      { type: 'choose', axis: 'theme', value: 'dark', userId: null, now: T0 },
      { type: 'authenticated', userId: A, now: T0 + MIN },
    ]);
    expect(state.dirtyAxes).toEqual(['theme']);
    const answered = run(
      [{ type: 'fetch-succeeded', userId: A, gen: state.gen, row: null }],
      state,
    );
    expect(saves(answered.effects)).toEqual([
      { type: 'save', userId: A, axes: { theme: 'dark' }, gen: state.gen },
    ]);
  });

  it('SR4: another tab’s signed-out choice ends this tab’s flow', () => {
    const { state, effects } = run([
      hydrate(null, null),
      { type: 'choose', axis: 'style', value: 'classic', userId: null, now: T0 },
      {
        type: 'device-changed',
        device: { v: 2, style: 'classic', theme: 'dark', anonAt: T0 + 1 },
        now: T0 + 1,
      },
    ]);
    expect(state).toMatchObject({ anonAt: T0 + 1, anonAxes: [], theme: 'dark' });
    expect(effects).toContainEqual({ type: 'persist-anon-flow', record: null });
    const signedIn = run([{ type: 'authenticated', userId: A, now: T0 + MIN }], state);
    expect(signedIn.state.dirtyAxes).toEqual([]);
  });

  it('a choice made signed out long ago in this tab does not ride along with a fresh one', () => {
    const { state } = run([
      hydrate(null, null),
      { type: 'choose', axis: 'style', value: 'classic', userId: null, now: T0 },
      { type: 'choose', axis: 'theme', value: 'dark', userId: null, now: T0 + 60 * MIN },
    ]);
    expect(state.anonAxes).toEqual(['theme']);
    const recent = run([
      hydrate(null, null),
      { type: 'choose', axis: 'style', value: 'classic', userId: null, now: T0 },
      { type: 'choose', axis: 'theme', value: 'dark', userId: null, now: T0 + 5 * MIN },
    ]);
    expect(recent.state.anonAxes).toEqual(['style', 'theme']);
  });

  it('a reload before the row answers keeps the offer, still checked against the row (SR1)', () => {
    const signedIn = signIn(T0 + MIN);
    const sync = signedIn.effects.find((e) => e.type === 'persist-sync') as Extract<
      AppearanceEffect,
      { type: 'persist-sync' }
    >;
    const reloaded = run([
      hydrate({ v: 2, style: 'classic' }, sync.record, undefined, T0 + 2 * MIN),
      { type: 'authenticated', userId: A, now: T0 + 2 * MIN },
    ]);
    expect(reloaded.state.uncheckedAxes).toEqual(['style']);
    expect(saves(reloaded.all)).toEqual([]);
    expect(fetches(reloaded.effects)).toHaveLength(1);
  });

  it('the phone keeps the flow in memory: sign-in in the same run, no reload', () => {
    const { state, effects } = run([
      hydrate(null, null),
      { type: 'choose', axis: 'style', value: 'classic', userId: null, now: T0 },
      { type: 'authenticated', userId: A, now: T0 + MIN },
    ]);
    expect(state.uncheckedAxes).toEqual(['style']);
    expect(fetches(effects)).toHaveLength(1);
  });
});

describe('SR3: signed-out stamps while signed in', () => {
  it('device-changed ignores another tab’s anonAt while signed in', () => {
    const { state } = run(
      [{ type: 'device-changed', device: { v: 2, style: 'classic', anonAt: T0 }, now: T0 }],
      syncedAsA(),
    );
    expect(state).toMatchObject({ style: 'classic', anonAt: null, anonAxes: [] });
    // A later 'authenticated' for the same person offers nothing.
    const again = run([{ type: 'authenticated', userId: A, now: T0 + MIN }], state);
    expect(saves(again.effects)).toEqual([]);
    expect(again.state.dirtyAxes).toEqual([]);
  });

  it('an authenticated that is not a sign-in clears the stamp and offers nothing', () => {
    const { state, effects } = run([
      hydrate(
        { v: 2, style: 'classic', anonAt: T0 },
        { v: 2, userId: A, dirtyAxes: [], syncedAt: ROW_OLD },
        { v: 1, anonAt: T0, axes: ['style'] },
      ),
      { type: 'authenticated', userId: A, now: T0 + MIN },
    ]);
    expect(state).toMatchObject({ anonAt: null, anonAxes: [], dirtyAxes: [] });
    expect(effects).toContainEqual({ type: 'persist-device', record: { v: 2, style: 'classic' } });
    expect(effects).toContainEqual({ type: 'persist-anon-flow', record: null });
    expect(saves(effects)).toEqual([]);
  });

  it('a stale stamp is removed at hydrate', () => {
    const { effects } = run([
      hydrate({ v: 2, style: 'classic' }, null, { v: 1, anonAt: T0, axes: ['style'] }),
    ]);
    expect(effects).toContainEqual({ type: 'persist-anon-flow', record: null });
  });
});

describe('SR1 and rule 4b: an unsaved choice found in storage', () => {
  it('confirmed sync for this person: pushed without reading the row', () => {
    const { state, effects } = run([
      hydrate(
        { v: 2, style: 'classic', theme: 'light' },
        { v: 2, userId: A, dirtyAxes: ['style'], syncedAt: ROW_OLD },
      ),
      { type: 'authenticated', userId: A, now: T0 },
    ]);
    expect(fetches(effects)).toEqual([]);
    expect(saves(effects)).toEqual([
      { type: 'save', userId: A, axes: { style: 'classic' }, gen: state.gen },
    ]);
  });

  it('no confirmed sync: the row is read first, nothing is pushed yet', () => {
    const { effects } = run([
      hydrate(
        { v: 2, style: 'classic' },
        { v: 2, userId: A, dirtyAxes: ['style'], syncedAt: null },
      ),
      { type: 'authenticated', userId: A, now: T0 },
    ]);
    expect(saves(effects)).toEqual([]);
    expect(fetches(effects)).toHaveLength(1);
  });

  it('round 2, finding 13: row axis null, so this person’s own unsaved choice is pushed', () => {
    const signedIn = run([
      hydrate(
        { v: 2, style: 'classic' },
        { v: 2, userId: A, dirtyAxes: ['style'], syncedAt: null },
      ),
      { type: 'authenticated', userId: A, now: T0 },
    ]);
    for (const answer of [null, row(null, 'dark')]) {
      const { state, effects } = run(
        [{ type: 'fetch-succeeded', userId: A, gen: signedIn.state.gen, row: answer }],
        signedIn.state,
      );
      expect(saves(effects)).toEqual([
        { type: 'save', userId: A, axes: { style: 'classic' }, gen: state.gen },
      ]);
      expect(state.status).toBe('saving');
      const saved = run(
        [
          {
            type: 'save-succeeded',
            userId: A,
            gen: state.gen,
            row: row('classic', answer ? 'dark' : null),
          },
        ],
        state,
      );
      expect(saved.state).toMatchObject({ status: 'synced', dirtyAxes: [], style: 'classic' });
    }
  });

  it('round 2, finding 13: row axis set, so the row wins, is adopted, and the dirty flag goes', () => {
    const signedIn = run([
      hydrate(
        { v: 2, style: 'classic' },
        { v: 2, userId: A, dirtyAxes: ['style'], syncedAt: null },
      ),
      { type: 'authenticated', userId: A, now: T0 },
    ]);
    const { state, effects } = run(
      [
        {
          type: 'fetch-succeeded',
          userId: A,
          gen: signedIn.state.gen,
          row: row('liquid-glass', null),
        },
      ],
      signedIn.state,
    );
    expect(state).toMatchObject({
      style: 'liquid-glass',
      dirtyAxes: [],
      uncheckedAxes: [],
      status: 'synced',
    });
    expect(saves(effects)).toEqual([]);
    expect(effects).toEqual([
      { type: 'apply', source: 'adopted', style: 'liquid-glass', theme: null },
      { type: 'persist-device', record: { v: 2, style: 'liquid-glass' } },
      { type: 'persist-sync', record: { v: 2, userId: A, dirtyAxes: [], syncedAt: ROW_NEW } },
    ]);
  });

  it('a choice in this session on an unchecked axis is trusted and pushed at once', () => {
    const signedIn = run([
      hydrate(
        { v: 2, style: 'classic', theme: 'dark' },
        { v: 2, userId: A, dirtyAxes: ['style', 'theme'], syncedAt: null },
      ),
      { type: 'authenticated', userId: A, now: T0 },
    ]);
    const chose = run(
      [{ type: 'choose', axis: 'theme', value: 'light', userId: A, now: T0 }],
      signedIn.state,
    );
    expect(saves(chose.effects)).toEqual([
      { type: 'save', userId: A, axes: { theme: 'light' }, gen: chose.state.gen },
    ]);
    expect(chose.state.uncheckedAxes).toEqual(['style']);
    // The save's echo is the row: it settles the unchecked Design too.
    const saved = run(
      [
        {
          type: 'save-succeeded',
          userId: A,
          gen: chose.state.gen,
          row: row('liquid-glass', 'light'),
        },
      ],
      chose.state,
    );
    expect(saved.state).toMatchObject({
      style: 'liquid-glass',
      theme: 'light',
      dirtyAxes: [],
      uncheckedAxes: [],
    });
    expect(saves(saved.effects)).toEqual([]);
  });
});

describe('rule 4c/4d and per-axis answers', () => {
  it('4c: a newer row is adopted on every clean axis', () => {
    const signedIn = run([{ type: 'authenticated', userId: A, now: T0 }], syncedAsA());
    const [fetch] = fetches(signedIn.effects);
    const { state, effects } = run(
      [{ type: 'fetch-succeeded', userId: A, gen: fetch!.gen, row: row('classic', 'dark') }],
      signedIn.state,
    );
    expect(state).toMatchObject({
      style: 'classic',
      theme: 'dark',
      syncedAt: ROW_NEW,
      status: 'synced',
    });
    expect(effects).toEqual([
      { type: 'apply', source: 'adopted', style: 'classic', theme: 'dark' },
      { type: 'persist-device', record: { v: 2, style: 'classic', theme: 'dark' } },
      { type: 'persist-sync', record: { v: 2, userId: A, dirtyAxes: [], syncedAt: ROW_NEW } },
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
          row: row('classic', 'dark', ROW_OLD),
        },
      ],
      signedIn.state,
    );
    expect(state).toMatchObject({ style: 'liquid-glass', theme: 'light', status: 'synced' });
    expect(effects).toEqual([]);
  });

  it('4c: a device that never synced with this person adopts the row', () => {
    const { state, all } = run([
      hydrate({ v: 2, style: 'liquid-glass', theme: 'dark' }, null),
      { type: 'authenticated', userId: A, now: T0 },
      { type: 'fetch-succeeded', userId: A, gen: 0, row: row('classic', null, ROW_OLD) },
    ]);
    expect(state).toMatchObject({ style: 'classic', theme: 'dark' });
    expect(saves(all)).toEqual([]);
  });

  it('4d: no row keeps the device values and uploads nothing', () => {
    const signedIn = run([
      hydrate({ v: 2, style: 'classic', theme: 'dark' }, null),
      { type: 'authenticated', userId: A, now: T0 },
    ]);
    const { state, effects } = run(
      [{ type: 'fetch-succeeded', userId: A, gen: signedIn.state.gen, row: null }],
      signedIn.state,
    );
    expect(state).toMatchObject({ style: 'classic', theme: 'dark', dirtyAxes: [], status: 'idle' });
    expect(effects).toEqual([]);
  });

  it('4d per axis: a null row axis keeps the device value', () => {
    const signedIn = run([{ type: 'authenticated', userId: A, now: T0 }], syncedAsA());
    const { state } = run(
      [{ type: 'fetch-succeeded', userId: A, gen: signedIn.state.gen, row: row('classic', null) }],
      signedIn.state,
    );
    expect(state).toMatchObject({ style: 'classic', theme: 'light' });
  });

  it('partial dirty fetch: clean axes follow 4c, the dirty one is pushed (not dropped whole)', () => {
    // A failed Theme save left Theme dirty (confirmed sync), then a reload.
    const signedIn = run([
      hydrate(
        { v: 2, style: 'liquid-glass', theme: 'dark' },
        { v: 2, userId: A, dirtyAxes: ['theme'], syncedAt: ROW_OLD },
      ),
    ]);
    // A fetch for A (e.g. retry after the table was missing) answers with a newer Classic.
    const fetched = run(
      [
        {
          type: 'fetch-succeeded',
          userId: A,
          gen: signedIn.state.gen,
          row: row('classic', 'light'),
        },
      ],
      signedIn.state,
    );
    expect(fetched.state).toMatchObject({ style: 'classic', theme: 'dark', syncedAt: ROW_NEW });
    expect(saves(fetched.effects)).toEqual([
      { type: 'save', userId: A, axes: { theme: 'dark' }, gen: fetched.state.gen },
    ]);
    expect(applies(fetched.effects)).toEqual([
      { type: 'apply', source: 'adopted', style: 'classic', theme: 'dark' },
    ]);
  });

  it('round 2, finding 6: the web saves Classic at T1, the phone saves a Theme at T2 and adopts Classic', () => {
    // The phone synced with A's row at ROW_OLD (Liquid Glass, Light). The web
    // then saved Classic at ROW_NEW. The phone, not having read it, saves Dark.
    const phone = run(
      [{ type: 'choose', axis: 'theme', value: 'dark', userId: A, now: T0 }],
      syncedAsA(),
    );
    expect(saves(phone.effects)[0]!.axes).toEqual({ theme: 'dark' });
    const { state, effects } = run(
      [
        {
          type: 'save-succeeded',
          userId: A,
          gen: phone.state.gen,
          row: row('classic', 'dark', ROW_NEWER),
        },
      ],
      phone.state,
    );
    expect(state).toMatchObject({
      style: 'classic',
      theme: 'dark',
      syncedAt: ROW_NEWER,
      status: 'synced',
    });
    expect(effects).toEqual([
      { type: 'apply', source: 'adopted', style: 'classic', theme: 'dark' },
      { type: 'persist-device', record: { v: 2, style: 'classic', theme: 'dark' } },
      { type: 'persist-sync', record: { v: 2, userId: A, dirtyAxes: [], syncedAt: ROW_NEWER } },
    ]);
    // A later read of the same row changes nothing more.
    const reread = run(
      [
        {
          type: 'fetch-succeeded',
          userId: A,
          gen: state.gen,
          row: row('classic', 'dark', ROW_NEWER),
        },
      ],
      state,
    );
    expect(reread.effects).toEqual([]);
  });

  it('a save echo with a null unsent axis keeps the device value', () => {
    const chose = run(
      [{ type: 'choose', axis: 'theme', value: 'dark', userId: A, now: T0 }],
      syncedAsA(),
    );
    const { state } = run(
      [{ type: 'save-succeeded', userId: A, gen: chose.state.gen, row: row(null, 'dark') }],
      chose.state,
    );
    expect(state).toMatchObject({ style: 'liquid-glass', theme: 'dark', status: 'synced' });
  });

  it('a row holding a value this code does not know is never adopted', () => {
    const signedIn = run([{ type: 'authenticated', userId: A, now: T0 }], syncedAsA());
    const { state } = run(
      [
        {
          type: 'fetch-succeeded',
          userId: A,
          gen: signedIn.state.gen,
          row: row('Liquid Glass', 'Dark'),
        },
      ],
      signedIn.state,
    );
    expect(state).toMatchObject({ style: 'liquid-glass', theme: 'light' });
  });
});

describe('apply.source per transition', () => {
  it('hydrate, choice, cross-tab and adopted', () => {
    expect(applies(run([hydrate(null, null)]).effects)[0]!.source).toBe('hydrate');
    expect(
      applies(
        run([{ type: 'choose', axis: 'style', value: 'classic', userId: A, now: T0 }], syncedAsA())
          .effects,
      )[0]!.source,
    ).toBe('choice');
    expect(
      applies(
        run([{ type: 'choose', axis: 'style', value: 'classic', userId: null, now: T0 }]).effects,
      )[0]!.source,
    ).toBe('choice');
    expect(applies(run([{ type: 'keep-glass', userId: null, now: T0 }]).effects)[0]!.source).toBe(
      'choice',
    );
    expect(
      applies(
        run([{ type: 'device-changed', device: { v: 2, style: 'classic' }, now: T0 }], syncedAsA())
          .effects,
      )[0]!.source,
    ).toBe('cross-tab');
    const signedIn = run([{ type: 'authenticated', userId: A, now: T0 }], syncedAsA());
    expect(
      applies(
        run(
          [
            {
              type: 'fetch-succeeded',
              userId: A,
              gen: signedIn.state.gen,
              row: row('classic', 'light'),
            },
          ],
          signedIn.state,
        ).effects,
      )[0]!.source,
    ).toBe('adopted');
  });

  it('an answer that changes nothing applies nothing', () => {
    const signedIn = run([{ type: 'authenticated', userId: A, now: T0 }], syncedAsA());
    const { effects } = run(
      [
        {
          type: 'fetch-succeeded',
          userId: A,
          gen: signedIn.state.gen,
          row: row('liquid-glass', 'light'),
        },
      ],
      signedIn.state,
    );
    expect(applies(effects)).toEqual([]);
  });
});

describe('rules 5 and 6: sign-out and another account', () => {
  it('sign-out keeps the look and erases the sync record', () => {
    const chose = run(
      [{ type: 'choose', axis: 'style', value: 'classic', userId: A, now: T0 }],
      syncedAsA(),
    );
    const { state, effects } = run([{ type: 'signed-out' }], chose.state);
    expect(state).toMatchObject({
      style: 'classic',
      theme: 'light',
      userId: null,
      dirtyAxes: [],
      syncedAt: null,
      status: 'signed-out',
    });
    expect(effects).toEqual([{ type: 'persist-sync', record: null }]);
  });

  it('an answer that arrives after sign-out is ignored', () => {
    const chose = run(
      [{ type: 'choose', axis: 'style', value: 'classic', userId: A, now: T0 }],
      syncedAsA(),
    );
    const out = run([{ type: 'signed-out' }], chose.state);
    const late = run(
      [{ type: 'save-succeeded', userId: A, gen: chose.state.gen, row: row('classic', 'light') }],
      out.state,
    );
    expect(late.state).toBe(out.state);
  });

  it('after sign-out, signing in again is a sign-in but offers nothing not chosen signed out', () => {
    const chose = run(
      [{ type: 'choose', axis: 'style', value: 'classic', userId: A, now: T0 }],
      syncedAsA(),
    );
    const out = run([{ type: 'signed-out' }], chose.state);
    const back = run([{ type: 'authenticated', userId: B, now: T0 + MIN }], out.state);
    expect(back.state.dirtyAxes).toEqual([]);
    const answered = run(
      [{ type: 'fetch-succeeded', userId: B, gen: back.state.gen, row: null }],
      back.state,
    );
    expect(saves(answered.effects)).toEqual([]);
  });

  it('A’s unsaved choice is never written under B; B gets B’s own row', () => {
    const chose = run(
      [{ type: 'choose', axis: 'style', value: 'classic', userId: A, now: T0 }],
      syncedAsA(),
    );
    const failed = run(
      [{ type: 'save-failed', userId: A, gen: chose.state.gen, reason: 'error' }],
      chose.state,
    );
    // B signs in on the same device without a clean sign-out (session expired).
    const asB = run([{ type: 'authenticated', userId: B, now: T0 + 60 * MIN }], failed.state);
    expect(saves(asB.effects)).toEqual([]);
    expect(asB.state).toMatchObject({ userId: B, dirtyAxes: [], syncedAt: null });
    expect(asB.effects).toContainEqual({
      type: 'persist-sync',
      record: { v: 2, userId: B, dirtyAxes: [], syncedAt: null },
    });
    expect(fetches(asB.effects)).toEqual([{ type: 'fetch', userId: B, gen: asB.state.gen }]);

    const adopted = run(
      [
        {
          type: 'fetch-succeeded',
          userId: B,
          gen: asB.state.gen,
          row: row('liquid-glass', 'dark', ROW_OLD),
        },
      ],
      asB.state,
    );
    expect(adopted.state).toMatchObject({ style: 'liquid-glass', theme: 'dark' });

    // A retry for A, or A's late answers, no longer do anything.
    expect(run([{ type: 'retry', userId: A }], adopted.state).effects).toEqual([]);
    expect(
      run(
        [
          {
            type: 'fetch-succeeded',
            userId: A,
            gen: adopted.state.gen,
            row: row('classic', 'light'),
          },
        ],
        adopted.state,
      ).state.style,
    ).toBe('liquid-glass');
  });

  it('rule 6 / SR1: a sync record for another person is ignored at sign-in', () => {
    const { state, effects } = run([
      hydrate(
        { v: 2, style: 'classic' },
        { v: 2, userId: A, dirtyAxes: ['style'], syncedAt: ROW_OLD },
      ),
      { type: 'authenticated', userId: B, now: T0 },
    ]);
    expect(saves(effects)).toEqual([]);
    expect(state).toMatchObject({ userId: B, dirtyAxes: [] });
  });

  it('B choosing on a device that still holds A’s sync record saves under B only', () => {
    const chose = run(
      [{ type: 'choose', axis: 'theme', value: 'dark', userId: B, now: T0 }],
      syncedAsA(),
    );
    expect(saves(chose.effects)).toEqual([
      { type: 'save', userId: B, axes: { theme: 'dark' }, gen: chose.state.gen },
    ]);
    expect(chose.state).toMatchObject({ userId: B, syncedAt: null });
  });

  it('a choice made signed out drops whatever sync record was left', () => {
    const { state, effects } = run(
      [{ type: 'choose', axis: 'theme', value: 'dark', userId: null, now: T0 }],
      syncedAsA(),
    );
    expect(state.userId).toBeNull();
    expect(effects).toContainEqual({ type: 'persist-sync', record: null });
  });
});

describe('the account store is missing', () => {
  it('a save that finds no table says device only, stays dirty, and never claims sync', () => {
    const chose = run(
      [{ type: 'choose', axis: 'style', value: 'classic', userId: A, now: T0 }],
      syncedAsA(),
    );
    const { state } = run(
      [{ type: 'save-failed', userId: A, gen: chose.state.gen, reason: 'missing-table' }],
      chose.state,
    );
    expect(state).toMatchObject({ status: 'unavailable', dirtyAxes: ['style'], style: 'classic' });
  });

  it('a fetch that finds no table says device only and keeps the device value', () => {
    const signedIn = run([{ type: 'authenticated', userId: A, now: T0 }], syncedAsA());
    const { state } = run(
      [{ type: 'fetch-failed', userId: A, gen: signedIn.state.gen, reason: 'missing-table' }],
      signedIn.state,
    );
    expect(state).toMatchObject({ status: 'unavailable', style: 'liquid-glass' });
  });

  it('Try again after a read that found no table reads the row again (nothing to resend)', () => {
    const signedIn = run([{ type: 'authenticated', userId: A, now: T0 }], syncedAsA());
    const missing = run(
      [{ type: 'fetch-failed', userId: A, gen: signedIn.state.gen, reason: 'missing-table' }],
      signedIn.state,
    );
    expect(missing.state).toMatchObject({ status: 'unavailable', dirtyAxes: [] });

    const retried = run([{ type: 'retry', userId: A }], missing.state);
    expect(fetches(retried.effects)).toEqual([
      { type: 'fetch', userId: A, gen: missing.state.gen },
    ]);
    expect(saves(retried.effects)).toEqual([]);
    expect(retried.state.status).toBe('unavailable');

    const answered = run(
      [{ type: 'fetch-succeeded', userId: A, gen: missing.state.gen, row: row('classic', 'dark') }],
      retried.state,
    );
    expect(answered.state).toMatchObject({ style: 'classic', theme: 'dark', status: 'synced' });

    expect(run([{ type: 'retry', userId: B }], missing.state).effects).toEqual([]);
    expect(run([{ type: 'retry', userId: null }], missing.state).effects).toEqual([]);
  });

  it('Try again with axes waiting for the row reads it', () => {
    const waiting = run([
      hydrate(
        { v: 2, style: 'classic' },
        { v: 2, userId: A, dirtyAxes: ['style'], syncedAt: null },
      ),
      { type: 'authenticated', userId: A, now: T0 },
    ]);
    const failed = run(
      [{ type: 'fetch-failed', userId: A, gen: waiting.state.gen, reason: 'error' }],
      waiting.state,
    );
    const retried = run([{ type: 'retry', userId: A }], failed.state);
    expect(fetches(retried.effects)).toHaveLength(1);
    expect(saves(retried.effects)).toEqual([]);
  });

  it('Try again after a save that found no table resends the choice, not a read', () => {
    const chose = run(
      [{ type: 'choose', axis: 'style', value: 'classic', userId: A, now: T0 }],
      syncedAsA(),
    );
    const missing = run(
      [{ type: 'save-failed', userId: A, gen: chose.state.gen, reason: 'missing-table' }],
      chose.state,
    );
    const retried = run([{ type: 'retry', userId: A }], missing.state);
    expect(saves(retried.effects)).toHaveLength(1);
    expect(fetches(retried.effects)).toEqual([]);
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
    const frozen = Object.freeze({
      ...before,
      dirtyAxes: Object.freeze([...before.dirtyAxes]) as typeof before.dirtyAxes,
      uncheckedAxes: Object.freeze([...before.uncheckedAxes]) as typeof before.uncheckedAxes,
      anonAxes: Object.freeze([...before.anonAxes]) as typeof before.anonAxes,
    });
    expect(() =>
      run(
        [
          { type: 'choose', axis: 'style', value: 'classic', userId: A, now: T0 },
          { type: 'choose', axis: 'theme', value: 'dark', userId: A, now: T0 },
          { type: 'signed-out' },
          { type: 'choose', axis: 'style', value: 'liquid-glass', userId: null, now: T0 },
          { type: 'authenticated', userId: B, now: T0 },
          { type: 'fetch-succeeded', userId: B, gen: 4, row: null },
        ],
        frozen,
      ),
    ).not.toThrow();
    expect(frozen).toEqual(before);
  });
});
