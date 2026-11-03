import {
  effectiveAppearance,
  INITIAL_APPEARANCE_STATE,
  reduceAppearance,
  type AppearanceEffect,
  type AppearanceEvent,
  type AppearanceMode,
  type AppearanceState,
} from '@stockpilot/core';

import type { AppearanceAccount } from './account';
import {
  clearFallbackFlag,
  readStoredAppearance,
  writeDeviceRecord,
  writeSyncRecord,
  type AppearanceStorage,
  type StoredAppearance,
} from './store';

/**
 * The phone's appearance controller: it drives the shared core reducer
 * (packages/core/src/appearance/reconcile.ts, plan 3.4) and performs its
 * effects against AsyncStorage and the person's own account row. No React
 * here, so every flow is unit-tested (appearance-controller.test.ts); the
 * provider (provider.tsx) only subscribes to it.
 *
 * Writes to storage run one after another in the order the reducer asked for
 * them, so a later record can never be overwritten by an earlier one. Saves
 * and fetches answer back into the reducer with the `gen` they started with,
 * and the reducer drops any answer that a newer choice has overtaken.
 */

export interface AppearanceSnapshot {
  readonly state: AppearanceState;
  /** The stored records were read (or the first-paint wait gave up on them). */
  readonly ready: boolean;
  /** What to render: the choice after the kill switch and the crash fallback. */
  readonly effective: AppearanceMode;
  /** This launch shows classic once because Liquid Glass crashed last time (plan 5.6). */
  readonly fallbackActive: boolean;
  /** EXPO_PUBLIC_LIQUID_GLASS for this bundle. */
  readonly glassEnabled: boolean;
}

export interface AppearanceControllerDeps {
  storage: AppearanceStorage;
  account: AppearanceAccount;
  now: () => number;
  glassEnabled: boolean;
}

export interface AppearanceController {
  getSnapshot(): AppearanceSnapshot;
  subscribe(listener: () => void): () => void;
  /** Read the stored records once, before the first paint. */
  hydrate(): Promise<void>;
  /** The first-paint wait ran out: go on with System; a late read still applies if nothing was chosen. */
  giveUpWaiting(): void;
  /** The signed-in person (null: signed out). Same id twice is a no-op. */
  setSession(userId: string | null): void;
  /** An explicit choice from the Appearance screen. */
  choose(mode: AppearanceMode): void;
  /** Try again: the button, the app coming to the foreground, the network coming back. */
  retry(): void;
  /** The crash-fallback notice was answered: show Liquid Glass again, or keep classic for good. */
  endFallback(choice: 'glass' | 'classic'): void;
  /** Resolves when every storage write asked for so far has finished (tests, recovery). */
  flush(): Promise<void>;
}

export function createAppearanceController(deps: AppearanceControllerDeps): AppearanceController {
  const { storage, account, now, glassEnabled } = deps;
  let state: AppearanceState = INITIAL_APPEARANCE_STATE;
  let ready = false;
  let hydrated = false;
  let fallbackActive = false;
  /** undefined until the auth layer reports; then the person's id or null. */
  let session: string | null | undefined;
  let writes: Promise<void> = Promise.resolve();
  let reading: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  const effectiveOf = (): AppearanceMode =>
    fallbackActive && state.mode === 'liquid-glass'
      ? state.lastClassic
      : effectiveAppearance(state.mode, glassEnabled);

  const build = (): AppearanceSnapshot => ({
    state,
    ready,
    effective: effectiveOf(),
    fallbackActive,
    glassEnabled,
  });
  let snapshot = build();

  const emit = () => {
    const next = build();
    if (
      next.state === snapshot.state &&
      next.ready === snapshot.ready &&
      next.effective === snapshot.effective &&
      next.fallbackActive === snapshot.fallbackActive
    ) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const enqueue = (write: () => Promise<void>) => {
    // A failed write is not fatal: the choice is still shown, and the next
    // choice or launch writes again. It never blocks the writes after it.
    writes = writes.then(write).catch(() => undefined);
  };

  const run = (effects: AppearanceEffect[]) => {
    for (const effect of effects) {
      switch (effect.type) {
        case 'apply':
          // The state's mode is what renders; nothing else to do.
          break;
        case 'persist-device': {
          const record = effect.record;
          enqueue(() => writeDeviceRecord(storage, record));
          break;
        }
        case 'persist-sync': {
          const record = effect.record;
          enqueue(() => writeSyncRecord(storage, record));
          break;
        }
        case 'save': {
          const { userId, mode, gen } = effect;
          void account
            .save(userId, mode)
            .catch(() => ({ ok: false as const, reason: 'error' as const }))
            .then((answer) =>
              dispatch(
                answer.ok
                  ? { type: 'save-succeeded', userId, gen, row: answer.row }
                  : { type: 'save-failed', userId, gen, reason: answer.reason },
              ),
            );
          break;
        }
        case 'fetch': {
          const { userId, gen } = effect;
          void account
            .fetch(userId)
            .catch(() => ({ ok: false as const, reason: 'error' as const }))
            .then((answer) =>
              dispatch(
                answer.ok
                  ? { type: 'fetch-succeeded', userId, gen, row: answer.row }
                  : { type: 'fetch-failed', userId, gen, reason: answer.reason },
              ),
            );
          break;
        }
      }
    }
  };

  function dispatch(event: AppearanceEvent) {
    const transition = reduceAppearance(state, event);
    state = transition.state;
    run(transition.effects);
    emit();
  }

  const applySession = () => {
    if (session === undefined) return;
    if (session === null) dispatch({ type: 'signed-out' });
    else dispatch({ type: 'authenticated', userId: session, now: now() });
  };

  const applyStored = (stored: StoredAppearance) => {
    if (stored.fallback) enqueue(() => clearFallbackFlag(storage));
    dispatch({ type: 'hydrate', device: stored.device, sync: stored.sync });
    // Exactly one classic launch after a crash in Liquid Glass; the flag is
    // gone from storage now, so the launch after this one is glass again
    // unless the person keeps classic.
    fallbackActive = stored.fallback && glassEnabled && state.mode === 'liquid-glass';
    hydrated = true;
    ready = true;
    emit();
    applySession();
  };

  const choose = (mode: AppearanceMode) => {
    if (mode === 'liquid-glass' && !glassEnabled) return;
    fallbackActive = false;
    dispatch({ type: 'choose', mode, userId: session ?? null, now: now() });
  };

  return {
    getSnapshot: () => snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    hydrate() {
      // One read per runtime, however often it is asked for (a re-mounted
      // provider, React's development double effects).
      if (reading === null) {
        reading = readStoredAppearance(storage).then((stored) => {
          if (hydrated && state.gen !== 0) {
            // The wait gave up first and a choice was made since: that choice
            // is newer (and was saved), so the late read is dropped.
            return;
          }
          applyStored(stored);
        });
      }
      return reading;
    },

    giveUpWaiting() {
      if (hydrated) return;
      hydrated = true;
      ready = true;
      emit();
      applySession();
    },

    setSession(userId) {
      if (userId === session) return;
      session = userId;
      if (hydrated) applySession();
    },

    choose,

    retry() {
      dispatch({ type: 'retry', userId: session ?? null });
    },

    endFallback(choice) {
      if (!fallbackActive) return;
      if (choice === 'classic') {
        choose(state.lastClassic);
        return;
      }
      fallbackActive = false;
      emit();
    },

    flush: async () => {
      // Writes may enqueue more writes (an answer that persists); wait them out.
      let seen: Promise<void> | null = null;
      while (seen !== writes) {
        seen = writes;
        await seen;
      }
    },
  };
}
