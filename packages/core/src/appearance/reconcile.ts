import {
  isLaterTimestamp,
  parseAccountRow,
  parseAnonFlowRecord,
  parseDeviceRecord,
  parseStyle,
  parseSyncRecord,
  parseThemeSetting,
} from './parse';
import {
  APPEARANCE_AXES,
  PRE_SIGN_IN_CHOICE_WINDOW_MS,
  PRE_SIGN_IN_CLOCK_SKEW_MS,
  type AccountAppearanceRow,
  type AccountSyncRecord,
  type AnonFlowRecord,
  type AppearanceAxis,
  type AppearancePatch,
  type AppearanceStyle,
  type AppearanceValues,
  type DeviceAppearanceRecord,
  type ThemeSetting,
} from './types';

/**
 * How the device's appearance and the account's are reconciled (plan 3.4, as
 * revised by plans/REVISION-DEFAULT.md R4, which folds in FOLLOWUPS SR1-SR4).
 * A pure reducer: (state, event) -> { state, effects }. The platform layer
 * (web provider, phone store) performs the effects in order and feeds the
 * results back as events. Nothing here reads a clock, storage or the network:
 * the time and every stored value arrive in the events, so every rule is
 * unit-tested. Nothing here knows the rollout either: the reducer stores what
 * the person chose, and `shownStyle` decides what is shown.
 *
 * The two axes, Design (`style`) and Theme, are chosen, marked dirty, saved
 * and adopted each on its own. A null axis means "not chosen".
 *
 * The rules, by number in the plan:
 *   1  An explicit choice applies at once and bumps `gen`. Signed out, it is
 *      kept on the device with `anonAt`, and the axis joins this flow's
 *      signed-out axes (`anonAxes`). Signed in, the axis is marked dirty and
 *      saved to the account at once.
 *   2  A failed save keeps the choice on the device, stays dirty and says so
 *      (status 'failed', or 'unavailable' when the table is missing); `retry`
 *      tries again. Nothing claims 'synced' unless the server answered.
 *   3  A fetch records `gen` when it starts; its answer is dropped if `gen`
 *      moved while it was in flight, so a late fetch never overwrites a newer
 *      choice.
 *   4  After authentication the row decides, per axis:
 *      (a) SR3/SR4: only on a real sign-in (no account to one), and only for
 *          an axis chosen signed out in this same flow less than 30 minutes
 *          ago (SR2: one-sided window), the signed-out choice is offered to
 *          the account. The row is read first: a value in the row wins; a
 *          null one takes the signed-out choice. On every other
 *          'authenticated' the signed-out stamp is simply cleared;
 *      (b) SR1: this person's own unsaved axis is pushed without reading the
 *          row only when it was chosen in this session, or its stored sync
 *          record names this person and has a confirmed syncedAt. Otherwise
 *          the row is read first: a null row axis takes the device value (it
 *          is this person's own choice), a set one wins and is adopted;
 *      (c) any other axis adopts the row's value when the row is newer than
 *          the last sync or this device never synced with this person;
 *      (d) an axis the row does not hold keeps the device value and is not
 *          uploaded.
 *   5  Sign-out keeps the device's appearance and erases the sync record.
 *   6  Another person signing in never inherits the previous person's dirty
 *      axes or sync record.
 * Saves are one at a time and send only the dirty axes: a choice made while a
 * save is in flight is sent when that save answers, so two saves can never
 * land at the server out of order. A save's answer echoes the whole row: the
 * axes it sent must match (else 'failed'), and any axis it did not send is
 * adopted from it, so a Theme saved on one device picks up a Design another
 * device saved (round 2, finding 6).
 */

/**
 *   idle         signed in, nothing to report yet (no row, or not fetched)
 *   signed-out   no account: the choice is on this device only, by design
 *   saving       a save is in flight
 *   synced       the account holds what this device shows (the server said so)
 *   failed       the last save failed; the choice is on this device only, retry offered
 *   unavailable  the account store does not exist yet; this device only
 */
export type AppearanceSyncStatus =
  'idle' | 'signed-out' | 'saving' | 'synced' | 'failed' | 'unavailable';

/** Why an `apply` happened: the phone defers only 'adopted' Design changes. */
export type AppearanceApplySource = 'hydrate' | 'choice' | 'cross-tab' | 'adopted';

export interface AppearanceState extends AppearanceValues {
  /** When the last choice made signed out was made (ms since the epoch), else null. */
  anonAt: number | null;
  /**
   * The axes chosen signed out in this sign-in flow (this tab on the web,
   * this run on the phone). Empty: not in a flow, nothing may reach an
   * account. This is the plan's `anonInFlow`, kept per axis so that a value
   * the previous person left on the other axis is never offered (SR4).
   */
  anonAxes: AppearanceAxis[];
  /** Whose account the sync fields describe; null when there is none. */
  userId: string | null;
  /** Axes this device holds that `userId`'s account has not stored yet. */
  dirtyAxes: AppearanceAxis[];
  /**
   * Dirty axes that must be checked against the row before they are pushed
   * (SR1, SR4): a value in the row wins, a null one takes the device value.
   * Always a subset of dirtyAxes; never sent.
   */
  uncheckedAxes: AppearanceAxis[];
  /** The account row's updated_at at the last confirmed read or write. */
  syncedAt: string | null;
  /** Bumped by every explicit or cross-tab choice; fetches and saves carry it. */
  gen: number;
  /** The save in flight (its gen and what it sent), or null. */
  saving: { gen: number; axes: AppearancePatch } | null;
  status: AppearanceSyncStatus;
}

export type AppearanceFailure = 'missing-table' | 'error';

/** One axis and a value for it. */
export type AppearanceChoice =
  { axis: 'style'; value: AppearanceStyle } | { axis: 'theme'; value: ThemeSetting };

export type AppearanceEvent =
  /** Device start: the stored records, read raw (malformed values are
   *  dropped here), and on the web this tab's signed-out stamp. */
  | { type: 'hydrate'; device: unknown; sync: unknown; anonFlow?: unknown; now: number }
  /** The person picked a value for one axis. `userId` is the signed-in person, or null. */
  | ({ type: 'choose'; userId: string | null; now: number } & AppearanceChoice)
  /** "Keep Liquid Glass" on the one-time notice: the Design becomes an explicit choice. */
  | { type: 'keep-glass'; userId: string | null; now: number }
  /** Another tab changed the device record (web `storage` event). */
  | { type: 'device-changed'; device: unknown; now: number }
  /** A session is known (after sign-in, or on start while signed in). */
  | { type: 'authenticated'; userId: string; now: number }
  /** The person signed out, or the session ended. */
  | { type: 'signed-out' }
  | { type: 'fetch-succeeded'; userId: string; gen: number; row: unknown }
  | { type: 'fetch-failed'; userId: string; gen: number; reason: AppearanceFailure }
  | { type: 'save-succeeded'; userId: string; gen: number; row: unknown }
  | { type: 'save-failed'; userId: string; gen: number; reason: AppearanceFailure }
  /** Try again: the button, window focus, reconnect. `userId` is the signed-in person. */
  | { type: 'retry'; userId: string | null };

export type AppearanceEffect =
  /** Show these values now. The platform maps `style` through `shownStyle`
   *  (rollout, crash fallback) and leaves its own theme alone when `theme`
   *  is null. */
  | ({ type: 'apply'; source: AppearanceApplySource } & AppearanceValues)
  /** Write the device record (web: localStorage, and the cookie for an explicit Design; phone: AsyncStorage). */
  | { type: 'persist-device'; record: DeviceAppearanceRecord }
  /** Write the sync record, or remove it (null). */
  | { type: 'persist-sync'; record: AccountSyncRecord | null }
  /** Write this tab's signed-out stamp, or remove it (null). The phone keeps it in memory only. */
  | { type: 'persist-anon-flow'; record: AnonFlowRecord | null }
  /** Upsert the person's own row with exactly these columns, then report save-succeeded/failed with this gen. */
  | { type: 'save'; userId: string; axes: AppearancePatch; gen: number }
  /** Read the person's own row, then report fetch-succeeded/failed with this gen. */
  | { type: 'fetch'; userId: string; gen: number };

export interface AppearanceTransition {
  state: AppearanceState;
  effects: AppearanceEffect[];
}

export const INITIAL_APPEARANCE_STATE: AppearanceState = {
  style: null,
  theme: null,
  anonAt: null,
  anonAxes: [],
  userId: null,
  dirtyAxes: [],
  uncheckedAxes: [],
  syncedAt: null,
  gen: 0,
  saving: null,
  status: 'signed-out',
};

export function deviceRecordOf(state: AppearanceState): DeviceAppearanceRecord {
  const record: DeviceAppearanceRecord = { v: 2 };
  if (state.style !== null) record.style = state.style;
  if (state.theme !== null) record.theme = state.theme;
  if (state.anonAt !== null) record.anonAt = state.anonAt;
  return record;
}

export function syncRecordOf(state: AppearanceState): AccountSyncRecord | null {
  if (state.userId === null) return null;
  return { v: 2, userId: state.userId, dirtyAxes: [...state.dirtyAxes], syncedAt: state.syncedAt };
}

export function anonFlowRecordOf(state: AppearanceState): AnonFlowRecord | null {
  if (state.anonAt === null || state.anonAxes.length === 0) return null;
  return { v: 1, anonAt: state.anonAt, axes: [...state.anonAxes] };
}

/**
 * What the "Use classic design" recovery action writes (plan 5.6, revision
 * R4): the Design becomes Classic and the Theme is left as it is.
 */
export function recoveryAppearance(): { style: 'classic' } {
  return { style: 'classic' };
}

/**
 * A choice made signed out at `anonAt` still counts at `now` (rule 4a). The
 * window is one-sided (SR2): from PRE_SIGN_IN_CLOCK_SKEW_MS in the future (a
 * clock slightly behind) up to, not including, 30 minutes in the past. A
 * stamp further in the future is a broken clock and never counts.
 */
export function isFreshPreSignInChoice(anonAt: number, now: number): boolean {
  const age = now - anonAt;
  return age >= -PRE_SIGN_IN_CLOCK_SKEW_MS && age < PRE_SIGN_IN_CHOICE_WINDOW_MS;
}

const done = (state: AppearanceState, effects: AppearanceEffect[] = []): AppearanceTransition => ({
  state,
  effects,
});

function union(a: readonly AppearanceAxis[], b: readonly AppearanceAxis[]): AppearanceAxis[] {
  return APPEARANCE_AXES.filter((axis) => a.includes(axis) || b.includes(axis));
}

function without(a: readonly AppearanceAxis[], b: readonly AppearanceAxis[]): AppearanceAxis[] {
  return a.filter((axis) => !b.includes(axis));
}

function sameAxes(a: readonly AppearanceAxis[], b: readonly AppearanceAxis[]): boolean {
  return a.length === b.length && a.every((axis) => b.includes(axis));
}

function valueOf(
  values: AppearanceValues,
  axis: AppearanceAxis,
): AppearanceStyle | ThemeSetting | null {
  return axis === 'style' ? values.style : values.theme;
}

function withValue(
  state: AppearanceState,
  axis: AppearanceAxis,
  value: AppearanceStyle | ThemeSetting | null,
): AppearanceState {
  return axis === 'style'
    ? { ...state, style: value as AppearanceStyle | null }
    : { ...state, theme: value as ThemeSetting | null };
}

function applyOf(state: AppearanceState, source: AppearanceApplySource): AppearanceEffect {
  return { type: 'apply', source, style: state.style, theme: state.theme };
}

/** Forget the sync fields: for a different person, or nobody. */
function withoutSync(state: AppearanceState, userId: string | null): AppearanceState {
  return {
    ...state,
    userId,
    dirtyAxes: [],
    uncheckedAxes: [],
    syncedAt: null,
    saving: null,
    status: userId === null ? 'signed-out' : 'idle',
  };
}

/**
 * Send the dirty axes that need no check against the row, unless a save is
 * already in flight (that one's answer sends them).
 */
function pushDirty(state: AppearanceState): AppearanceTransition {
  if (state.userId === null) return done(state);
  const axes: AppearancePatch = {};
  for (const axis of without(state.dirtyAxes, state.uncheckedAxes)) {
    if (axis === 'style' && state.style !== null) axes.style = state.style;
    if (axis === 'theme' && state.theme !== null) axes.theme = state.theme;
  }
  if (Object.keys(axes).length === 0) return done(state);
  if (state.saving !== null) return done({ ...state, status: 'saving' });
  const next: AppearanceState = { ...state, saving: { gen: state.gen, axes }, status: 'saving' };
  return done(next, [{ type: 'save', userId: state.userId, axes, gen: state.gen }]);
}

/**
 * Take a row's answer, per axis, for the axes not in `sent`:
 *   unchecked dirty axis: a value in the row wins and is adopted (the dirty
 *     flag goes); a null one leaves the axis dirty and now checked, to push;
 *   checked dirty axis: kept, to push (this person's own choice);
 *   clean axis: adopted when `adoptClean` and the row holds a different value.
 */
function takeRow(
  state: AppearanceState,
  row: AccountAppearanceRow,
  sent: readonly AppearanceAxis[],
  adoptClean: boolean,
): { next: AppearanceState; adopted: boolean } {
  let next = state;
  let adopted = false;
  for (const axis of APPEARANCE_AXES) {
    if (sent.includes(axis)) continue;
    const rowValue = valueOf(row, axis);
    if (next.uncheckedAxes.includes(axis)) {
      const uncheckedAxes = without(next.uncheckedAxes, [axis]);
      if (rowValue !== null) {
        if (rowValue !== valueOf(next, axis)) adopted = true;
        next = {
          ...withValue(next, axis, rowValue),
          uncheckedAxes,
          dirtyAxes: without(next.dirtyAxes, [axis]),
        };
      } else {
        next = { ...next, uncheckedAxes };
      }
      continue;
    }
    if (next.dirtyAxes.includes(axis)) continue;
    if (adoptClean && rowValue !== null && rowValue !== valueOf(next, axis)) {
      next = withValue(next, axis, rowValue);
      adopted = true;
    }
  }
  return { next, adopted };
}

/** The effects that record a row's answer, then any push it leaves. */
function settle(
  before: AppearanceState,
  next: AppearanceState,
  adopted: boolean,
  idleStatus: AppearanceSyncStatus,
): AppearanceTransition {
  const effects: AppearanceEffect[] = [];
  if (adopted) {
    effects.push(applyOf(next, 'adopted'), {
      type: 'persist-device',
      record: deviceRecordOf(next),
    });
  }
  const pushed = pushDirty({ ...next, status: idleStatus });
  if (
    pushed.state.syncedAt !== before.syncedAt ||
    !sameAxes(pushed.state.dirtyAxes, before.dirtyAxes)
  ) {
    effects.push({ type: 'persist-sync', record: syncRecordOf(pushed.state) });
  }
  return done(pushed.state, [...effects, ...pushed.effects]);
}

/** The flow axes a hydrated stamp brings back: only while it names the device record's anonAt. */
function anonAxesFrom(
  flow: AnonFlowRecord | null,
  device: DeviceAppearanceRecord | null,
): AppearanceAxis[] {
  if (!flow || !device || device.anonAt === undefined || flow.anonAt !== device.anonAt) return [];
  return flow.axes.filter((axis) => (axis === 'style' ? device.style : device.theme) !== undefined);
}

function choose(
  state: AppearanceState,
  choice: AppearanceChoice,
  userId: string | null,
  now: number,
): AppearanceTransition {
  const gen = state.gen + 1;
  if (userId === null) {
    // Rule 1, signed out: nothing to save to. The sync record belongs to an
    // account that is not signed in, so it goes (rule 5). The axis joins this
    // flow's signed-out axes; earlier ones stay only while they are fresh, so
    // a choice someone made in this tab long ago does not ride along.
    const earlier =
      state.userId === null && state.anonAt !== null && isFreshPreSignInChoice(state.anonAt, now)
        ? state.anonAxes
        : [];
    const next: AppearanceState = {
      ...withoutSync(withValue(state, choice.axis, choice.value), null),
      anonAt: now,
      anonAxes: union(earlier, [choice.axis]),
      gen,
    };
    const effects: AppearanceEffect[] = [
      applyOf(next, 'choice'),
      { type: 'persist-device', record: deviceRecordOf(next) },
      { type: 'persist-anon-flow', record: anonFlowRecordOf(next) },
    ];
    if (state.userId !== null) effects.push({ type: 'persist-sync', record: null });
    return done(next, effects);
  }
  // Rule 1, signed in. A different person than the sync record names:
  // start that person's sync from nothing (rule 6), then mark the axis dirty.
  // A choice made in this session needs no check against the row (SR1).
  const base = state.userId === userId ? state : withoutSync(state, userId);
  const chosen: AppearanceState = {
    ...withValue(base, choice.axis, choice.value),
    anonAt: null,
    anonAxes: [],
    dirtyAxes: union(base.dirtyAxes, [choice.axis]),
    uncheckedAxes: without(base.uncheckedAxes, [choice.axis]),
    gen,
  };
  const pushed = pushDirty(chosen);
  const effects: AppearanceEffect[] = [
    applyOf(chosen, 'choice'),
    { type: 'persist-device', record: deviceRecordOf(pushed.state) },
    { type: 'persist-sync', record: syncRecordOf(pushed.state) },
  ];
  if (state.anonAxes.length > 0 || state.anonAt !== null) {
    effects.push({ type: 'persist-anon-flow', record: null });
  }
  return done(pushed.state, [...effects, ...pushed.effects]);
}

export function reduceAppearance(
  state: AppearanceState,
  event: AppearanceEvent,
): AppearanceTransition {
  switch (event.type) {
    case 'hydrate': {
      const device = parseDeviceRecord(event.device, event.now);
      const sync = parseSyncRecord(event.sync);
      const flow = parseAnonFlowRecord(event.anonFlow);
      const style = device?.style ?? null;
      const theme = device?.theme ?? null;
      // A dirty axis with no value on this device has nothing to send.
      const dirtyAxes = (sync?.dirtyAxes ?? []).filter(
        (axis) => (axis === 'style' ? style : theme) !== null,
      );
      const anonAxes = anonAxesFrom(flow, device);
      const next: AppearanceState = {
        ...INITIAL_APPEARANCE_STATE,
        gen: state.gen,
        style,
        theme,
        anonAt: device?.anonAt ?? null,
        anonAxes,
        userId: sync?.userId ?? null,
        dirtyAxes,
        // SR1: a stored dirty axis is trusted only with a confirmed sync.
        uncheckedAxes: sync?.syncedAt === null ? dirtyAxes : [],
        syncedAt: sync?.syncedAt ?? null,
        status: sync ? 'idle' : 'signed-out',
      };
      const effects: AppearanceEffect[] = [applyOf(next, 'hydrate')];
      // A stamp for another choice (another tab's, or an older one) is stale.
      if (event.anonFlow != null && anonAxes.length === 0) {
        effects.push({ type: 'persist-anon-flow', record: null });
      }
      return done(next, effects);
    }

    case 'choose': {
      const value =
        event.axis === 'style' ? parseStyle(event.value) : parseThemeSetting(event.value);
      if (value === null) return done(state);
      return choose(
        state,
        { axis: event.axis, value } as AppearanceChoice,
        event.userId,
        event.now,
      );
    }

    case 'keep-glass': {
      // The one-time notice's "Keep Liquid Glass": the Design shown by default
      // becomes the person's own choice (saved like any choice). Already
      // chosen explicitly: nothing to do.
      if (state.style === 'liquid-glass') return done(state);
      return choose(state, { axis: 'style', value: 'liquid-glass' }, event.userId, event.now);
    }

    case 'device-changed': {
      // Another tab made a choice: it is newer than anything in flight here,
      // so it bumps gen (a fetch started before it is dropped). That tab saves
      // it; this one only shows it. SR3: while signed in, the other tab's
      // signed-out stamp is ignored. Signed out, it is taken, but this tab's
      // flow ends: the choice was made in another tab (SR4).
      const device = parseDeviceRecord(event.device, event.now);
      if (!device) return done(state);
      const style = device.style ?? null;
      const theme = device.theme ?? null;
      const anonAt = state.userId === null ? (device.anonAt ?? null) : state.anonAt;
      if (style === state.style && theme === state.theme && anonAt === state.anonAt) {
        return done(state);
      }
      const anonAxes = anonAt === state.anonAt ? state.anonAxes : [];
      const next: AppearanceState = {
        ...state,
        style,
        theme,
        anonAt,
        anonAxes,
        gen: state.gen + 1,
      };
      const effects: AppearanceEffect[] = [];
      if (style !== state.style || theme !== state.theme) effects.push(applyOf(next, 'cross-tab'));
      if (anonAxes.length === 0 && state.anonAxes.length > 0) {
        effects.push({ type: 'persist-anon-flow', record: null });
      }
      return done(next, effects);
    }

    case 'authenticated': {
      const transition = state.userId === null;
      // Rule 6: a sync record for anyone else is not this person's.
      const base = state.userId === event.userId ? state : withoutSync(state, event.userId);
      // Rule 4a (SR3, SR4): only a real sign-in may take this flow's fresh
      // signed-out axes, and only after the row is read (they become
      // unchecked dirty axes). Any other 'authenticated' just clears the stamp.
      const claim =
        transition && state.anonAt !== null && isFreshPreSignInChoice(state.anonAt, event.now)
          ? state.anonAxes.filter((axis) => valueOf(state, axis) !== null)
          : [];
      let next: AppearanceState = {
        ...base,
        anonAt: null,
        anonAxes: [],
        dirtyAxes: union(base.dirtyAxes, claim),
        uncheckedAxes: union(base.uncheckedAxes, claim),
      };
      const effects: AppearanceEffect[] = [];
      if (state.anonAt !== null) {
        effects.push({ type: 'persist-device', record: deviceRecordOf(next) });
      }
      if (state.anonAt !== null || state.anonAxes.length > 0) {
        effects.push({ type: 'persist-anon-flow', record: null });
      }
      if (base !== state || claim.length > 0) {
        effects.push({ type: 'persist-sync', record: syncRecordOf(next) });
      }

      if (next.uncheckedAxes.length > 0 || transition) {
        // The row first (SR1, SR4). A save in flight answers with the row too.
        if (next.saving !== null) return done(next, effects);
        return done(next, [...effects, { type: 'fetch', userId: event.userId, gen: next.gen }]);
      }
      if (next.dirtyAxes.length > 0) {
        // Rule 4b: this person's own unsaved choice wins.
        const pushed = pushDirty(next);
        next = pushed.state;
        return done(next, [...effects, ...pushed.effects]);
      }
      if (next.saving !== null) return done(next, effects);
      // Rules 4c / 4d: read the row once; the answer decides.
      return done(next, [...effects, { type: 'fetch', userId: event.userId, gen: next.gen }]);
    }

    case 'signed-out': {
      // Rule 5: the device keeps its look; the sync record goes. An answer to
      // a save or fetch still in flight is ignored from now on.
      if (state.userId === null && state.status === 'signed-out') return done(state);
      const next = withoutSync(state, null);
      return done(next, [{ type: 'persist-sync', record: null }]);
    }

    case 'fetch-succeeded': {
      if (event.userId !== state.userId) return done(state);
      if (event.gen !== state.gen) {
        // Rule 3: a choice was made since it started, so the answer is
        // dropped. Axes still waiting for a check need a fresh read, unless
        // a save in flight will answer with the row.
        if (state.uncheckedAxes.length > 0 && state.saving === null) {
          return done(state, [{ type: 'fetch', userId: state.userId, gen: state.gen }]);
        }
        return done(state);
      }
      const row = parseAccountRow(event.row);
      if (!row) {
        // Rule 4d: no row (or one this code cannot read). Every axis keeps its
        // device value; nothing inherited is uploaded. An unchecked dirty axis
        // is this person's own choice: it is now checked and pushed.
        const next: AppearanceState = { ...state, uncheckedAxes: [] };
        return settle(state, next, false, 'idle');
      }
      // Rule 4c applies to the clean axes only when the row moved since the
      // last sync (or this device never synced with this person).
      const newer = state.syncedAt === null || isLaterTimestamp(row.updatedAt, state.syncedAt);
      const { next, adopted } = takeRow(state, row, [], newer);
      return settle(state, newer ? { ...next, syncedAt: row.updatedAt } : next, adopted, 'synced');
    }

    case 'fetch-failed': {
      if (event.userId !== state.userId || event.gen !== state.gen) return done(state);
      // A missing table is a fact worth showing; any other read failure claims
      // nothing and leaves the status as it was.
      return done(event.reason === 'missing-table' ? { ...state, status: 'unavailable' } : state);
    }

    case 'save-succeeded': {
      if (event.userId !== state.userId || state.saving?.gen !== event.gen) return done(state);
      const sent = state.saving.axes;
      const cleared: AppearanceState = { ...state, saving: null };
      if (event.gen !== state.gen) {
        // A newer choice (here or in another tab) was made while this save
        // was in flight: still dirty, so send what is current now. The echo
        // is not adopted: it is older than that choice.
        return pushDirty(cleared);
      }
      const sentAxes = APPEARANCE_AXES.filter((axis) => sent[axis] !== undefined);
      const row = parseAccountRow(event.row);
      if (!row || sentAxes.some((axis) => valueOf(row, axis) !== sent[axis])) {
        // The server did not echo what this device sent, so nothing proves
        // the account holds it: stay dirty and offer Try again (no loop).
        return done({ ...cleared, status: 'failed' });
      }
      // Round 2, finding 6: the echo is the newest row; every axis not sent
      // is taken from it, then its updated_at is recorded.
      const sentCleared: AppearanceState = {
        ...cleared,
        dirtyAxes: without(cleared.dirtyAxes, sentAxes),
        uncheckedAxes: without(cleared.uncheckedAxes, sentAxes),
      };
      const { next, adopted } = takeRow(sentCleared, row, sentAxes, true);
      return settle(state, { ...next, syncedAt: row.updatedAt }, adopted, 'synced');
    }

    case 'save-failed': {
      if (event.userId !== state.userId || state.saving?.gen !== event.gen) return done(state);
      // Rule 2: still dirty, still applied on this device, and said so.
      return done({
        ...state,
        saving: null,
        status: event.reason === 'missing-table' ? 'unavailable' : 'failed',
      });
    }

    case 'retry': {
      if (event.userId === null || event.userId !== state.userId) return done(state);
      if (state.saving !== null) return done(state);
      if (state.uncheckedAxes.length > 0) {
        // Axes waiting for the row: read it (its answer pushes or adopts them).
        return done(state, [{ type: 'fetch', userId: state.userId, gen: state.gen }]);
      }
      if (state.dirtyAxes.length === 0 && state.status === 'unavailable') {
        // The READ found no account store (fetch-failed 'missing-table'), so
        // there is nothing to resend: read the row again. Once the table
        // exists the answer is taken as any first read is (rules 4c / 4d).
        return done(state, [{ type: 'fetch', userId: state.userId, gen: state.gen }]);
      }
      return pushDirty(state);
    }
  }
}
