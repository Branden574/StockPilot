import {
  INITIAL_APPEARANCE_STATE,
  reduceAppearance,
  shownStyle,
  type AppearanceEffect,
  type AppearanceEvent,
  type AppearanceState,
  type AppearanceStyle,
  type GlassRollout,
  type ThemeSetting,
} from '@stockpilot/core';

import type { AppearanceAccount } from './account';
import {
  clearFallbackFlag,
  markIntroSeen,
  readStoredAppearance,
  writeDeviceRecord,
  writeSyncRecord,
  type AppearanceStorage,
  type StoredAppearance,
} from './store';

/**
 * The phone's appearance controller: it drives the shared core reducer
 * (packages/core/src/appearance/reconcile.ts, plan 3.4 as revised by
 * REVISION-DEFAULT R4) and performs its effects against AsyncStorage and the
 * person's own account row. No React here, so every flow is unit-tested
 * (appearance-controller.test.ts); the provider (provider.tsx) only
 * subscribes to it.
 *
 * Two choices, each on its own: the Design (Liquid Glass or Classic) and the
 * Theme (Light, Dark or System). The reducer stores what the person chose;
 * what is DRAWN is decided here:
 *   - the Design through core `shownStyle`: the rollout (off: classic; a
 *     Design never chosen: the rollout's default, Liquid Glass under
 *     'default') and the one-time crash fallback;
 *   - the Theme as chosen (null: follow the device), except under 'off',
 *     where the phone is exactly today's: classic, following the device.
 *
 * Under 'off' the layer is inert (R5): it reads the stored records (so they
 * are kept, never rewritten) but writes nothing, reads and saves nothing on
 * the account, and ignores every choice.
 *
 * Writes to storage run one after another in the order the reducer asked for
 * them, so a later record can never be overwritten by an earlier one. Saves
 * and fetches answer back into the reducer with the `gen` they started with,
 * and the reducer drops any answer that a newer choice has overtaken.
 *
 * Two phone-only rules (round 2, finding 10):
 *   - First start of the new JS (item 31): a phone with nothing of its own
 *     yet (no Design or Theme stored, and no account sync record, which the
 *     first start with someone signed in writes) whose stored session names
 *     a person (who owes no authenticator code) keeps the first paint held
 *     until that person's row is read, inside the same 4 s cap as the font
 *     gate (the provider's giveUpWaiting), so a Classic chooser opens in
 *     Classic. That start writes the sync record, so it is the only one that
 *     waits, whatever the row said (R9): a person who never chose anything is
 *     never held again.
 *   - Deferred adoption (item 32): a Design adopted from the account after
 *     the first paint that changes what is drawn is stored at once but drawn
 *     only when nothing holds it (the B44 update holds: open sheets, alerts,
 *     photo picks, drafts, writes in flight; and the Scan tab or a count entry
 *     screen in focus), or at the next return to the app, which is B44's:
 *     background, then active (inactive to active, from Control Center, Face
 *     ID, an alert or the app switcher, is not one). The person's own choices
 *     apply at once.
 *
 * Rule 2 on the phone: a save that failed, a read that found no account
 * store, and a read that failed (offline, a timeout) are tried again when the
 * app comes to the foreground, when the network reports itself online, and by
 * Try again. A read that failed owes the row (R9: the rollout default only
 * "until it can read the row"); the reducer keeps no trace of it (status stays
 * 'idle'), so this controller remembers it and announces the session again,
 * which reads the row exactly as at the start.
 */

/** What holds a Design adopted from the account back from being drawn. */
export interface AdoptionHolds {
  isHeld(): boolean;
  /** Called when isHeld() may have changed. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export interface AppearanceSnapshot {
  readonly state: AppearanceState;
  /** The stored records were read (or the first-paint wait gave up on them); from the start under 'off'. */
  readonly ready: boolean;
  /** The Design drawn: after the rollout, the crash fallback and a held adoption. */
  readonly style: AppearanceStyle;
  /** The Theme drawn; null follows the device. Always null under 'off'. */
  readonly theme: ThemeSetting | null;
  /** This launch shows classic once because Liquid Glass crashed last time (plan 5.6). */
  readonly fallbackActive: boolean;
  /** EXPO_PUBLIC_LIQUID_GLASS for this bundle. */
  readonly rollout: GlassRollout;
  /** rollout !== 'off': the Design choice is offered. */
  readonly glassEnabled: boolean;
  /** The one-time "new look" card on Home (R13). */
  readonly introVisible: boolean;
  /** A Design adopted from the account is stored and waits for the holds (item 32). */
  readonly adoptionPending: boolean;
  /**
   * Something is to be tried again (rule 2): a failed save, a read that found
   * no account store, or a read that failed. The provider listens for the
   * network only while this is true.
   */
  readonly retryOwed: boolean;
}

export interface AppearanceControllerDeps {
  storage: AppearanceStorage;
  account: AppearanceAccount;
  now: () => number;
  rollout: GlassRollout;
  holds: AdoptionHolds;
  /** The stored session's person for the first start (account.ts peekSignedInUser). */
  peekSignedInUser: () => Promise<string | null>;
}

export interface AppearanceController {
  getSnapshot(): AppearanceSnapshot;
  subscribe(listener: () => void): () => void;
  /** Read the stored records once, before the first paint. */
  hydrate(): Promise<void>;
  /** The first-paint wait ran out: go on with the rollout default; a late read still applies if nothing was chosen. */
  giveUpWaiting(): void;
  /** The signed-in person (null: signed out). Same id twice is a no-op. */
  setSession(userId: string | null): void;
  /** An explicit Design choice (Settings, the intro card, the crash notice). */
  chooseStyle(style: AppearanceStyle): void;
  /** An explicit Theme choice (Settings). */
  chooseTheme(theme: ThemeSetting): void;
  /** "Keep Liquid Glass" on the intro card: the default becomes the person's own choice. */
  keepGlass(): void;
  /** Close the intro card without choosing. */
  dismissIntro(): void;
  /** Try again: the button, the app coming to the foreground, the network coming back. */
  retry(): void;
  /**
   * Every AppState change, and the state found when the provider subscribed.
   * A return to the app (background, then active) draws a held adoption; any
   * 'active' tries again what is owed.
   */
  onAppState(next: string): void;
  /** A network report while a retry is owed: online tries again. */
  onNetwork(online: boolean): void;
  /** The crash-fallback notice was answered: show Liquid Glass again, or choose Classic. */
  endFallback(choice: 'glass' | 'classic'): void;
  /** Resolves when every storage write asked for so far has finished (tests, recovery). */
  flush(): Promise<void>;
  /**
   * Resolves once no save is in flight and every write asked for so far has
   * finished: "Use classic design" waits for it (capped) before the reload,
   * which would cut the save.
   */
  settled(): Promise<void>;
}

export function createAppearanceController(deps: AppearanceControllerDeps): AppearanceController {
  const { storage, account, now, rollout, holds, peekSignedInUser } = deps;
  const inert = rollout === 'off';
  let state: AppearanceState = INITIAL_APPEARANCE_STATE;
  // Under 'off' nothing stored can change what is drawn (classic, following
  // the device), so the first paint never waits for the read: the splash and
  // RootGate mount at fontsReady exactly as before the appearance layer
  // (stage 4 audit F2). The read still runs, to keep the records.
  let ready = inert;
  let hydrated = false;
  let fallbackActive = false;
  /** Unknown until the stored flag is read: never shown before. */
  let introSeen = true;
  /** undefined until the auth layer (or the first-start peek) reports; then the person's id or null. */
  let session: string | null | undefined;
  /** The session last handed to the reducer, so the same one is never reported twice. */
  let reported: string | null | undefined;
  /** The person's Design value being drawn; lags state.style only while an adoption is held. */
  let displayed: AppearanceStyle | null = null;
  let pending = false;
  let unsubscribeHolds: (() => void) | null = null;
  /** The first paint waits for the account row (item 31). */
  let waitingForAccount = false;
  let fetchesInFlight = 0;
  /** The last read for the signed-in person failed: the row is still owed (rule 2, R9). */
  let readOwed = false;
  /** A background was seen since the last return to the app (B44's definition of a return). */
  let sawBackground = false;
  let writes: Promise<void> = Promise.resolve();
  let reading: Promise<void> | null = null;
  /** Waiting for the save in flight to answer (settled()). */
  let saveWaiters: (() => void)[] = [];
  const listeners = new Set<() => void>();

  const drawn = (style: AppearanceStyle | null): AppearanceStyle =>
    shownStyle(style, rollout, fallbackActive);

  const isRetryOwed = (): boolean =>
    !inert && (state.status === 'failed' || state.status === 'unavailable' || readOwed);

  const build = (): AppearanceSnapshot => {
    const style = drawn(displayed);
    return {
      state,
      ready,
      style,
      theme: inert ? null : state.theme,
      fallbackActive,
      rollout,
      glassEnabled: !inert,
      introVisible:
        rollout === 'default' &&
        ready &&
        !introSeen &&
        !fallbackActive &&
        state.style === null &&
        style === 'liquid-glass',
      adoptionPending: pending,
      retryOwed: isRetryOwed(),
    };
  };
  let snapshot = build();

  const emit = () => {
    const next = build();
    if (
      next.state === snapshot.state &&
      next.ready === snapshot.ready &&
      next.style === snapshot.style &&
      next.theme === snapshot.theme &&
      next.fallbackActive === snapshot.fallbackActive &&
      next.introVisible === snapshot.introVisible &&
      next.adoptionPending === snapshot.adoptionPending &&
      next.retryOwed === snapshot.retryOwed
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

  const stopWatchingHolds = () => {
    unsubscribeHolds?.();
    unsubscribeHolds = null;
  };

  /** Draw the stored Design now (a held adoption ends). */
  const drawStored = () => {
    if (!pending) return;
    pending = false;
    displayed = state.style;
    stopWatchingHolds();
    emit();
  };

  const holdAdoption = () => {
    pending = true;
    if (unsubscribeHolds === null) {
      unsubscribeHolds = holds.subscribe(() => {
        if (!holds.isHeld()) drawStored();
      });
    }
  };

  const show = (effect: Extract<AppearanceEffect, { type: 'apply' }>) => {
    // Item 32: only a Design adopted from the account after the first paint,
    // that changes what is drawn, waits; everything else is drawn at once.
    if (
      effect.source === 'adopted' &&
      ready &&
      drawn(effect.style) !== drawn(displayed) &&
      holds.isHeld()
    ) {
      holdAdoption();
      return;
    }
    displayed = effect.style;
    if (pending) {
      pending = false;
      stopWatchingHolds();
    }
  };

  const endFirstStartWait = () => {
    if (!waitingForAccount) return;
    waitingForAccount = false;
    ready = true;
    emit();
  };

  const run = (effects: AppearanceEffect[]) => {
    for (const effect of effects) {
      switch (effect.type) {
        case 'apply':
          show(effect);
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
        case 'persist-anon-flow':
          // The phone keeps the sign-in flow in memory for this run (SR4):
          // the reducer's state is that memory; nothing is stored.
          break;
        case 'save': {
          const { userId, axes, gen } = effect;
          void account
            .save(userId, axes)
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
          fetchesInFlight += 1;
          void account
            .fetch(userId)
            .catch(() => ({ ok: false as const, reason: 'error' as const }))
            .then((answer) => {
              fetchesInFlight -= 1;
              // Only an answer the reducer takes counts (rule 3 drops one a
              // newer choice overtook). A missing table is 'unavailable',
              // owed through the status instead.
              if (state.userId === userId && state.gen === gen) {
                readOwed = !answer.ok && answer.reason === 'error';
              }
              dispatch(
                answer.ok
                  ? { type: 'fetch-succeeded', userId, gen, row: answer.row }
                  : { type: 'fetch-failed', userId, gen, reason: answer.reason },
              );
              endFirstStartWait();
            });
          break;
        }
      }
    }
  };

  function dispatch(event: AppearanceEvent) {
    const transition = reduceAppearance(state, event);
    // Another person, or nobody: an earlier person's read is owed to no one.
    if (transition.state.userId !== state.userId) readOwed = false;
    state = transition.state;
    // A save's answer echoes the whole row: synced means it was read.
    if (state.status === 'synced') readOwed = false;
    run(transition.effects);
    if (state.saving === null && saveWaiters.length > 0) {
      const waiting = saveWaiters;
      saveWaiters = [];
      for (const resolve of waiting) resolve();
    }
    emit();
  }

  const applySession = () => {
    if (inert || session === undefined || session === reported) return;
    reported = session;
    if (session === null) dispatch({ type: 'signed-out' });
    else dispatch({ type: 'authenticated', userId: session, now: now() });
  };

  const applyStored = (stored: StoredAppearance) => {
    // The phone has no sign-in flow from an earlier run (SR4): no stamp.
    dispatch({ type: 'hydrate', device: stored.device, sync: stored.sync, now: now() });
    // The reducer's account fields came from storage: the session is told again.
    reported = undefined;
    introSeen = stored.introSeen;
    // Exactly one classic launch after a crash in Liquid Glass; the flag is
    // gone from storage now, so the launch after this one is glass again
    // unless the person chooses Classic. Under 'off' nothing is written.
    if (!inert) {
      if (stored.fallback) enqueue(() => clearFallbackFlag(storage));
      fallbackActive = stored.fallback && drawn(state.style) === 'liquid-glass';
    }
    hydrated = true;
  };

  const chooseStyle = (style: AppearanceStyle) => {
    if (inert) return;
    fallbackActive = false;
    seeIntro();
    dispatch({ type: 'choose', axis: 'style', value: style, userId: session ?? null, now: now() });
  };

  const flush = async () => {
    // Writes may enqueue more writes (an answer that persists); wait them out.
    let seen: Promise<void> | null = null;
    while (seen !== writes) {
      seen = writes;
      await seen;
    }
  };

  /** Any Design choice answers the one-time card too. */
  const seeIntro = () => {
    if (introSeen) return;
    introSeen = true;
    enqueue(() => markIntroSeen(storage));
  };

  /**
   * The signed-in person whose row is owed, when the read is all that is:
   * nothing unsaved to send (its answer would be the row), no row check
   * pending (the reducer's own retry reads for that), no read or save out.
   */
  const owedReadFor = (): string | null =>
    readOwed &&
    typeof session === 'string' &&
    state.userId === session &&
    state.saving === null &&
    fetchesInFlight === 0 &&
    state.dirtyAxes.length === 0 &&
    state.uncheckedAxes.length === 0
      ? session
      : null;

  const retry = () => {
    if (inert) return;
    const reread = owedReadFor();
    if (reread !== null) {
      // The reducer's own retry has nothing to resend: announce the session
      // again, which reads the row (rules 4c, 4d) exactly as at the start.
      dispatch({ type: 'authenticated', userId: reread, now: now() });
      return;
    }
    // A read already out answers for this one.
    if (readOwed && fetchesInFlight > 0) return;
    dispatch({ type: 'retry', userId: session ?? null });
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
        reading = (async () => {
          const stored = await readStoredAppearance(storage);
          if (hydrated && state.gen !== 0) {
            // The wait gave up first and a choice was made since: that choice
            // is newer (and was saved), so the late read is dropped.
            return;
          }
          applyStored(stored);
          // Item 31: nothing of this phone's own (no Design or Theme stored, and
          // no sync record: no start of this JS has had anyone signed in), so
          // the person's row decides the first look. The 'authenticated' below
          // writes the sync record, so only this start waits (R9), whatever
          // the row says; never a signed-out phone.
          const nothingOfItsOwn =
            state.style === null && state.theme === null && state.userId === null;
          if (!inert && !ready && nothingOfItsOwn) {
            if (session === undefined) {
              const peeked = await peekSignedInUser().catch(() => null);
              if (session === undefined && peeked !== null) session = peeked;
            }
            waitingForAccount = typeof session === 'string' && !ready;
          }
          if (!waitingForAccount) ready = true;
          emit();
          applySession();
          // No read went out (a save in flight answers instead): do not hold the screen.
          if (waitingForAccount && fetchesInFlight === 0) endFirstStartWait();
        })();
      }
      return reading;
    },

    giveUpWaiting() {
      if (ready) return;
      hydrated = true;
      waitingForAccount = false;
      ready = true;
      emit();
      applySession();
    },

    setSession(userId) {
      if (userId === session) return;
      session = userId;
      if (hydrated) applySession();
      // The person the first paint waited for is gone (the session ended, or
      // was refused at its refresh): there is no row to wait for.
      endFirstStartWait();
    },

    chooseStyle,

    chooseTheme(theme) {
      if (inert) return;
      dispatch({
        type: 'choose',
        axis: 'theme',
        value: theme,
        userId: session ?? null,
        now: now(),
      });
    },

    keepGlass() {
      if (inert) return;
      fallbackActive = false;
      seeIntro();
      dispatch({ type: 'keep-glass', userId: session ?? null, now: now() });
      emit();
    },

    dismissIntro() {
      if (inert) return;
      seeIntro();
      emit();
    },

    retry,

    onAppState(next) {
      if (next === 'background') sawBackground = true;
      if (next !== 'active') return;
      if (sawBackground) {
        // A return to the app (B44, ota-update-prompt.ts onAppState): the
        // held adoption is drawn now. Inactive to active is not one.
        sawBackground = false;
        drawStored();
      }
      if (isRetryOwed()) retry();
    },

    onNetwork(online) {
      // Any online report while something is owed (the provider listens only
      // then), as use-sync.ts does: the first report after a failure may
      // already be the network coming back.
      if (online && isRetryOwed()) retry();
    },

    endFallback(choice) {
      if (!fallbackActive) return;
      if (choice === 'classic') {
        chooseStyle('classic');
        return;
      }
      fallbackActive = false;
      emit();
    },

    flush,

    settled: async () => {
      while (state.saving !== null) {
        await new Promise<void>((resolve) => saveWaiters.push(resolve));
      }
      await flush();
    },
  };
}
