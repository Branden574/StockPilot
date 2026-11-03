import {
  isClassicAppearance,
  isLaterTimestamp,
  legacyAppearance,
  parseAccountRow,
  parseDeviceRecord,
  parseSyncRecord,
} from './parse';
import {
  PRE_SIGN_IN_CHOICE_WINDOW_MS,
  type AccountSyncRecord,
  type AppearanceMode,
  type ClassicAppearanceMode,
  type DeviceAppearanceRecord,
} from './types';

/**
 * How the device's appearance and the account's are reconciled (plan 3.4).
 * A pure reducer: (state, event) -> { state, effects }. The platform layer
 * (web provider, phone store) performs the effects in order and feeds the
 * results back as events. Nothing here reads a clock, storage or the network:
 * the time and every stored value arrive in the events, so every rule is
 * unit-tested.
 *
 * The rules, by number in the plan:
 *   1  An explicit choice applies at once and bumps `gen`. Signed out, it is
 *      kept on the device with `anonAt`. Signed in, it is marked dirty and
 *      saved to the account.
 *   2  A failed save keeps the choice on the device, stays dirty and says so
 *      (status 'failed', or 'unavailable' when the table is missing); `retry`
 *      tries again: it resends a dirty choice, or, when a read found no table
 *      and nothing is dirty, reads the row again. Nothing claims 'synced'
 *      unless the server answered.
 *   3  A fetch records `gen` when it starts; its answer is dropped if `gen`
 *      moved while it was in flight, so a late fetch never overwrites a newer
 *      choice.
 *   4  After authentication: (a) a choice made signed out less than 30 minutes
 *      ago is pushed to this account and the row is not adopted; an older one
 *      is forgotten as a pre-sign-in choice; (b) a dirty choice of this same
 *      person is pushed; (c) otherwise the row is fetched and adopted when it
 *      is newer than the last sync or this device never synced with this
 *      person; (d) no row: the device keeps its value and nothing is uploaded.
 *   5  Sign-out keeps the device's appearance and erases the sync record.
 *   6  Another person signing in never inherits the previous person's dirty
 *      choice or sync record.
 * Saves are one at a time: a choice made while a save is in flight is sent
 * when that save answers, so two saves can never land at the server out of
 * order.
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

export interface AppearanceState {
  mode: AppearanceMode;
  lastClassic: ClassicAppearanceMode;
  /** When a choice made signed out was made (ms since the epoch), else null. */
  anonAt: number | null;
  /** Whose account the sync fields describe; null when there is none. */
  userId: string | null;
  /** This device holds a choice `userId`'s account has not stored yet. */
  dirty: boolean;
  /** The account row's updated_at at the last confirmed read or write. */
  syncedAt: string | null;
  /** Bumped by every explicit or cross-tab choice; fetches and saves carry it. */
  gen: number;
  /** The gen of the save in flight, or null. */
  saving: number | null;
  status: AppearanceSyncStatus;
}

export type AppearanceFailure = 'missing-table' | 'error';

export type AppearanceEvent =
  /** Device start: the stored records, read raw (malformed values are dropped
   *  here), plus next-themes' legacy `theme` on the web. */
  | { type: 'hydrate'; device: unknown; sync: unknown; legacyTheme?: unknown }
  /** The person picked an appearance. `userId` is the signed-in person, or null. */
  | { type: 'choose'; mode: AppearanceMode; userId: string | null; now: number }
  /** Another tab changed the device record (web `storage` event). */
  | { type: 'device-changed'; device: unknown }
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
  /** Show this appearance now (the platform maps it through the kill switch). */
  | { type: 'apply'; mode: AppearanceMode }
  /** Write the device record (web: cookie + localStorage; phone: AsyncStorage). */
  | { type: 'persist-device'; record: DeviceAppearanceRecord }
  /** Write the sync record, or remove it (null). */
  | { type: 'persist-sync'; record: AccountSyncRecord | null }
  /** Upsert the person's own row with this mode, then report save-succeeded/failed with this gen. */
  | { type: 'save'; userId: string; mode: AppearanceMode; gen: number }
  /** Read the person's own row, then report fetch-succeeded/failed with this gen. */
  | { type: 'fetch'; userId: string; gen: number };

export interface AppearanceTransition {
  state: AppearanceState;
  effects: AppearanceEffect[];
}

export const INITIAL_APPEARANCE_STATE: AppearanceState = {
  mode: 'system',
  lastClassic: 'system',
  anonAt: null,
  userId: null,
  dirty: false,
  syncedAt: null,
  gen: 0,
  saving: null,
  status: 'signed-out',
};

export function deviceRecordOf(state: AppearanceState): DeviceAppearanceRecord {
  const record: DeviceAppearanceRecord = { v: 1, mode: state.mode, lastClassic: state.lastClassic };
  if (state.anonAt !== null) record.anonAt = state.anonAt;
  return record;
}

export function syncRecordOf(state: AppearanceState): AccountSyncRecord | null {
  if (state.userId === null) return null;
  return { v: 1, userId: state.userId, dirty: state.dirty, syncedAt: state.syncedAt };
}

/** The appearance the "Use classic appearance" recovery action returns to (plan 5.6). */
export function recoveryAppearance(state: AppearanceState): ClassicAppearanceMode {
  return state.lastClassic;
}

/** A choice made signed out at `anonAt` still counts at `now` (rule 4a). The
 *  window is symmetric so a clock set back by a few minutes does not make a
 *  fresh choice look stale, while a far-future stamp (a broken clock) still
 *  expires. */
export function isFreshPreSignInChoice(anonAt: number, now: number): boolean {
  return Math.abs(now - anonAt) < PRE_SIGN_IN_CHOICE_WINDOW_MS;
}

const done = (state: AppearanceState, effects: AppearanceEffect[] = []): AppearanceTransition => ({
  state,
  effects,
});

/** Forget the sync fields: for a different person, or nobody. */
function withoutSync(state: AppearanceState, userId: string | null): AppearanceState {
  return {
    ...state,
    userId,
    dirty: false,
    syncedAt: null,
    saving: null,
    status: userId === null ? 'signed-out' : 'idle',
  };
}

/** Send the dirty choice unless a save is already in flight (that one's answer sends it). */
function pushDirty(state: AppearanceState): AppearanceTransition {
  if (state.userId === null || !state.dirty) return done(state);
  if (state.saving !== null) return done({ ...state, status: 'saving' });
  const next = { ...state, saving: state.gen, status: 'saving' as const };
  return done(next, [{ type: 'save', userId: state.userId, mode: state.mode, gen: state.gen }]);
}

function withMode(state: AppearanceState, mode: AppearanceMode): AppearanceState {
  return { ...state, mode, lastClassic: isClassicAppearance(mode) ? mode : state.lastClassic };
}

export function reduceAppearance(
  state: AppearanceState,
  event: AppearanceEvent,
): AppearanceTransition {
  switch (event.type) {
    case 'hydrate': {
      const device = parseDeviceRecord(event.device);
      const sync = parseSyncRecord(event.sync);
      const mode = device?.mode ?? legacyAppearance(event.legacyTheme);
      const next: AppearanceState = {
        ...INITIAL_APPEARANCE_STATE,
        gen: state.gen,
        mode,
        lastClassic: device?.lastClassic ?? (isClassicAppearance(mode) ? mode : 'system'),
        anonAt: device?.anonAt ?? null,
        userId: sync?.userId ?? null,
        dirty: sync?.dirty ?? false,
        syncedAt: sync?.syncedAt ?? null,
        status: sync ? 'idle' : 'signed-out',
      };
      return done(next, [{ type: 'apply', mode }]);
    }

    case 'choose': {
      const gen = state.gen + 1;
      if (event.userId === null) {
        // Rule 1, signed out: nothing to save to. The sync record belongs to an
        // account that is not signed in, so it goes (rule 5).
        const next: AppearanceState = {
          ...withoutSync(withMode(state, event.mode), null),
          anonAt: event.now,
          gen,
        };
        const effects: AppearanceEffect[] = [
          { type: 'apply', mode: next.mode },
          { type: 'persist-device', record: deviceRecordOf(next) },
        ];
        if (state.userId !== null) effects.push({ type: 'persist-sync', record: null });
        return done(next, effects);
      }
      // Rule 1, signed in. A different person than the sync record names:
      // start that person's sync from nothing (rule 6), then mark dirty.
      const base = state.userId === event.userId ? state : withoutSync(state, event.userId);
      const chosen: AppearanceState = {
        ...withMode(base, event.mode),
        anonAt: null,
        dirty: true,
        gen,
      };
      const pushed = pushDirty(chosen);
      return done(pushed.state, [
        { type: 'apply', mode: chosen.mode },
        { type: 'persist-device', record: deviceRecordOf(pushed.state) },
        { type: 'persist-sync', record: syncRecordOf(pushed.state) },
        ...pushed.effects,
      ]);
    }

    case 'device-changed': {
      // Another tab made a choice: it is newer than anything in flight here,
      // so it bumps gen (a fetch started before it is dropped). That tab saves
      // it; this one only shows it.
      const device = parseDeviceRecord(event.device);
      if (!device || (device.mode === state.mode && (device.anonAt ?? null) === state.anonAt)) {
        return done(state);
      }
      const next: AppearanceState = {
        ...state,
        mode: device.mode,
        lastClassic: device.lastClassic,
        anonAt: device.anonAt ?? null,
        gen: state.gen + 1,
      };
      return done(next, [{ type: 'apply', mode: next.mode }]);
    }

    case 'authenticated': {
      // Rule 6: a sync record for anyone else is not this person's.
      let next = state.userId === event.userId ? state : withoutSync(state, event.userId);
      const effects: AppearanceEffect[] = [];
      if (next !== state) effects.push({ type: 'persist-sync', record: syncRecordOf(next) });

      if (next.anonAt !== null) {
        if (isFreshPreSignInChoice(next.anonAt, event.now)) {
          // Rule 4a: the newest explicit act on this device, made on the way
          // into this sign-in. Push it; do not adopt the row.
          next = { ...next, anonAt: null, dirty: true };
          const pushed = pushDirty(next);
          return done(pushed.state, [
            ...effects.filter((e) => e.type !== 'persist-sync'),
            { type: 'persist-device', record: deviceRecordOf(pushed.state) },
            { type: 'persist-sync', record: syncRecordOf(pushed.state) },
            ...pushed.effects,
          ]);
        }
        // Too old: an ordinary device value from here on (rule 4c / 4d).
        next = { ...next, anonAt: null };
        effects.push({ type: 'persist-device', record: deviceRecordOf(next) });
      }

      if (next.dirty) {
        // Rule 4b: this person's own unsaved choice wins.
        const pushed = pushDirty(next);
        return done(pushed.state, [...effects, ...pushed.effects]);
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
      // Rule 3: dropped when it answers for someone else, or a choice was made
      // since it started, or this device holds an unsaved choice.
      if (event.userId !== state.userId || event.gen !== state.gen || state.dirty) {
        return done(state);
      }
      const row = parseAccountRow(event.row);
      if (!row) {
        // Rule 4d: no row (or one this code cannot read). Keep the device
        // value; do not upload it.
        return done({ ...state, status: 'idle' });
      }
      if (state.syncedAt === null || isLaterTimestamp(row.updatedAt, state.syncedAt)) {
        // Rule 4c: adopt the account's choice.
        const next: AppearanceState = {
          ...withMode(state, row.mode),
          syncedAt: row.updatedAt,
          status: 'synced',
        };
        const effects: AppearanceEffect[] = [];
        if (next.mode !== state.mode) effects.push({ type: 'apply', mode: next.mode });
        effects.push(
          { type: 'persist-device', record: deviceRecordOf(next) },
          { type: 'persist-sync', record: syncRecordOf(next) },
        );
        return done(next, effects);
      }
      // The row is what this device last synced; nothing changed since.
      return done({ ...state, status: 'synced' });
    }

    case 'fetch-failed': {
      if (event.userId !== state.userId || event.gen !== state.gen) return done(state);
      // A missing table is a fact worth showing; any other read failure claims
      // nothing and leaves the status as it was.
      return done(event.reason === 'missing-table' ? { ...state, status: 'unavailable' } : state);
    }

    case 'save-succeeded': {
      if (event.userId !== state.userId || state.saving !== event.gen) return done(state);
      const cleared: AppearanceState = { ...state, saving: null };
      if (event.gen !== state.gen) {
        // A newer choice was made while this save was in flight: still dirty,
        // so send what is current now.
        return pushDirty(cleared);
      }
      const row = parseAccountRow(event.row);
      if (!row || row.mode !== state.mode) {
        // The server did not echo the row this device sent, so nothing proves
        // the account holds it: stay dirty and offer Try again (no loop).
        return done({ ...cleared, status: 'failed' });
      }
      const next: AppearanceState = {
        ...cleared,
        dirty: false,
        syncedAt: row.updatedAt,
        status: 'synced',
      };
      return done(next, [{ type: 'persist-sync', record: syncRecordOf(next) }]);
    }

    case 'save-failed': {
      if (event.userId !== state.userId || state.saving !== event.gen) return done(state);
      // Rule 2: still dirty, still applied on this device, and said so.
      return done({
        ...state,
        saving: null,
        status: event.reason === 'missing-table' ? 'unavailable' : 'failed',
      });
    }

    case 'retry': {
      if (event.userId === null || event.userId !== state.userId) return done(state);
      if (!state.dirty && state.saving === null && state.status === 'unavailable') {
        // The READ found no account store (fetch-failed 'missing-table'), so
        // there is nothing to resend: read the row again. Once the table
        // exists the answer is taken as any first read is (rules 4c / 4d).
        return done(state, [{ type: 'fetch', userId: state.userId, gen: state.gen }]);
      }
      return pushDirty(state);
    }
  }
}
