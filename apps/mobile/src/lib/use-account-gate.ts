import AsyncStorage from '@react-native-async-storage/async-storage';
import * as React from 'react';

import {
  getAccountGateState,
  getDisableEvidence,
  setAccountGateState,
  subscribeAccountGate,
  type AccountGateState,
} from './account-disabled-state';
import {
  accountScopedStorageKeys,
  gateForRevocation,
  probeAndSettle,
  PROBE_TIMEOUT_MS,
  runAccountEviction,
  setUnauthorizedHandler,
  shouldRunEviction,
  unverifiedRetryDelayMs,
  withTimeout,
} from './account-eviction';
import { wipeForSignOut } from './db';
import { ACCOUNT_DISABLED_REJECTION } from './drain-failure';
import { rejectAllPending } from './queue';
import { abortAllInFlight } from './request-cancellation';
import { supabase } from './supabase';

import { isDisableRevocation } from '@stockpilot/core';

import type { AuthProbeResult } from './account-disabled-probe';

/**
 * The ONE place the account gate is wired to the device.
 *
 * Mounted by RootGate — the single component that renders on every screen —
 * so eviction reaches a user sitting on a pushed card screen, a full-screen
 * modal, or the pre-drawer cold-launch path. The DrawerContent mount it
 * replaces covered none of those.
 *
 * It reuses the app's EXISTING lifecycle architecture rather than adding
 * listeners of its own. There is no new AppState subscription here: foreground
 * resume and network reconnect already run useSync → syncNow → api(), and every
 * api() failure with a 401 rings the unauthorized bus.
 *
 * WHICH PATHS CAN ACTUALLY CONFIRM A DISABLE — and the correction the
 * end-to-end run forced. A disable revokes the user's sessions FIRST, so from
 * that moment the device is mute: its probe can only ever get
 * `session_not_found`. `user_banned` is unreachable on every path that runs
 * against a revoked session, which is all of them except one.
 *
 *   1. cold launch / session restore — auth-context probes a hydrated session.
 *      Post-revocation this answers 'signed-out', NOT 'disabled': the device
 *      signs out and lands on sign-in (settleProbeResult).
 *   2. SIGN-IN — GoTrue answers `user_banned` to a password grant (auth-context).
 *      This is the ONE path that can still confirm a disable outright, and it
 *      is where every offline / relaunched device converges.
 *   3. any protected request that 401s — same story as (1): 'signed-out'.
 *   4. the live eviction broadcast, via useSessionRevocation's onTargeted
 *      override. This is the ONLINE fast path: the broadcast NAMES the reason,
 *      and `onSessionRevoked` below believes it only once the probe has
 *      corroborated that the session really is gone (the channel is public and
 *      therefore forgeable — see gateForRevocation).
 *
 * They funnel into the same gate state, and the eviction — including the
 * terminal rejection of the offline outbox — runs exactly once per transition
 * into `disabled`. Keeping rejection on the TRANSITION rather than on either
 * discovery path is deliberate: (4) and (2) are the two ways a device learns
 * the truth, and wiring the outbox to just one of them is precisely the bug the
 * end-to-end run found.
 *
 * WHAT THE TRANSITION ALONE IS NOT ENOUGH FOR. Path (2) is a sign-in screen,
 * and GoTrue evaluates the ban BEFORE the password: `user_banned` comes back to
 * anyone who types a disabled colleague's address, with any password and no
 * credentials at all. The eviction destroys THIS DEVICE's queued work, which
 * after "Use password instead" on the biometric lock routinely belongs to
 * somebody else. So the transition raises the SCREEN from either path, and only
 * a verdict attributed to this device's own session (DisableEvidence 'session')
 * may evict — shouldRunEviction, below.
 */
export interface AccountGate {
  state: AccountGateState;
  /**
   * Probe now and report whether the account is CONFIRMED disabled. Driven by
   * the 401 bus and by the background re-probe loop that replaced the blocking
   * retry screen.
   */
  probeNow: () => Promise<boolean>;
  /**
   * Handed to useSessionRevocation as its `onTargeted` first refusal. Receives
   * the RAW broadcast payload so it can read the reason, corroborates it with a
   * probe, and returns true when it has taken the eviction over — which
   * suppresses the listener's "You were signed out from another device." alert,
   * a sentence that is simply not what happened.
   */
  onSessionRevoked: (payload: unknown) => Promise<boolean>;
}

export function useAccountGate(options: { onEvicted: () => void }): AccountGate {
  const { onEvicted } = options;
  const [state, setState] = React.useState<AccountGateState>(getAccountGateState);
  const evicting = React.useRef(false);

  React.useEffect(() => {
    // Re-read on mount as well as subscribing: auth-context's cold-launch probe
    // can land between this component's first render and this effect, and a
    // missed transition would leave a disabled account inside the app.
    setState(getAccountGateState());
    return subscribeAccountGate(setState);
  }, []);

  /**
   * One probe round trip, applied. Returns the raw verdict so the revocation
   * handler can reason about 'signed-out' — the answer a revoked device
   * actually gets — rather than only about "was it a confirmed ban".
   */
  const runProbe = React.useCallback(async (): Promise<AuthProbeResult> => {
    // getUser() is the ONLY authority here: /api/v1 answers a disabled caller
    // with the same uniform 401 an anonymous caller gets, on purpose. A
    // rejected call (offline, DNS, timeout) classifies as 'unknown' and
    // changes nothing.
    const { result, gate } = await probeAndSettle(
      getAccountGateState(),
      () => withTimeout(supabase.auth.getUser(), PROBE_TIMEOUT_MS, null),
      async () => {
        await supabase.auth.signOut({ scope: 'local' });
      },
    );
    if (gate) setAccountGateState(gate);
    return result;
  }, []);

  const probeNow = React.useCallback(async (): Promise<boolean> => {
    return (await runProbe()) === 'disabled';
  }, [runProbe]);

  /**
   * The ONLINE half of the disable story.
   *
   * The broadcast is the only thing that can name the reason — after the
   * server-side revoke, the probe below can never answer `user_banned` — but
   * the channel is public and therefore forgeable, so the reason is a claim and
   * the probe is the corroboration. gateForRevocation owns that judgement; this
   * just supplies both inputs and applies the verdict.
   *
   * Returning false hands the listener back its ordinary force-logout, which is
   * exactly right for a real sign-out-everywhere.
   */
  const onSessionRevoked = React.useCallback(
    async (payload: unknown): Promise<boolean> => {
      const claimsDisable = isDisableRevocation(payload);
      const probe = await runProbe();
      if (gateForRevocation(claimsDisable, probe) !== 'disabled') return false;
      setAccountGateState('disabled');
      return true;
    },
    [runProbe],
  );

  // Any 401, anywhere in the app, gets ONE throttled probe. Registered here so
  // api.ts stays a plain module with no supabase / router / SQLite imports.
  React.useEffect(() => {
    setUnauthorizedHandler(() => {
      void probeNow();
    });
    return () => setUnauthorizedHandler(null);
  }, [probeNow]);

  // Re-probe in the BACKGROUND while the status is unreadable, instead of
  // blocking the app behind a retry screen. A GoTrue 5xx says nothing about
  // this account, and an offline-first warehouse device must keep reaching its
  // cached work through an identity-server incident. The loop reschedules
  // itself on a backoff and unwinds the moment the gate settles either way.
  React.useEffect(() => {
    if (state !== 'unverified') return;
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      timer = setTimeout(() => {
        if (cancelled) return;
        void probeNow().finally(() => {
          if (cancelled || getAccountGateState() !== 'unverified') return;
          attempt += 1;
          schedule();
        });
      }, unverifiedRetryDelayMs(attempt));
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [state, probeNow]);

  // Evict on the transition into `disabled`, once — and ONLY when the verdict
  // is about the session this device is holding. The ref (not state) is what
  // prevents a session-restoration loop: onAuthStateChange fires during the
  // eviction's own sign-out and would otherwise re-enter this effect.
  React.useEffect(() => {
    // shouldRunEviction is what stops a FAILED sign-in from destroying somebody
    // else's queued work: `user_banned` comes back for any password, from the
    // sign-in screen, with no credentials — see account-eviction.ts.
    if (
      !shouldRunEviction({
        state,
        evidence: getDisableEvidence(),
        alreadyEvicting: evicting.current,
      })
    ) {
      return;
    }
    evicting.current = true;
    void (async () => {
      const failed = await runAccountEviction({
        cancelRequests: () => {
          abortAllInFlight();
        },
        // scope 'local': the server already revoked this session, and a global
        // sign-out would cascade into the user's other devices — which is not
        // this device's call to make.
        signOutLocal: async () => {
          await supabase.auth.signOut({ scope: 'local' });
        },
        // Park the offline outbox BEFORE the wipe. Eviction has already
        // cancelled the in-flight requests and dropped the session, so the
        // drains will never get to classify these rows themselves — and
        // wipeForSignOut used to delete them outright, which meant the queued
        // work vanished with no record and nothing to explain to the user.
        // Best-effort: if the rejection fails we still wipe, because losing the
        // record is bad but replaying the writes after a re-enable is worse.
        //
        // THE ONE REJECTION SITE. It hangs off the transition into `disabled`,
        // not off any single discovery path, and that is what makes it reachable
        // from BOTH: the corroborated eviction broadcast (a connected device)
        // and the `user_banned` sign-in rejection (a relaunched or offline one).
        // The end-to-end run found it wired only to a path that the session
        // revocation had made unreachable, and both queues stayed 'failed' —
        // retryable — instead of terminally rejected.
        clearCaches: async () => {
          try {
            await rejectAllPending(ACCOUNT_DISABLED_REJECTION);
          } catch (e) {
            console.warn('[account-gate] could not park the offline outbox', e);
          }
          await wipeForSignOut();
        },
        clearAccountStorage: async () => {
          const keys = accountScopedStorageKeys(await AsyncStorage.getAllKeys());
          if (keys.length > 0) await AsyncStorage.multiRemove(keys);
        },
        resetNavigation: onEvicted,
      });
      if (failed.length > 0) {
        console.warn('[account-gate] eviction finished with failed steps', failed);
      }
    })();
  }, [state, onEvicted]);

  // A gate that leaves `disabled` (the user signed out of the disabled screen)
  // re-arms the eviction for the next account on this device.
  React.useEffect(() => {
    if (state !== 'disabled') evicting.current = false;
  }, [state]);

  return { state, probeNow, onSessionRevoked };
}
