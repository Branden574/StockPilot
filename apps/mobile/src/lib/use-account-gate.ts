import AsyncStorage from '@react-native-async-storage/async-storage';
import * as React from 'react';

import { classifyAuthProbe } from './account-disabled-probe';
import {
  getAccountGateState,
  setAccountGateState,
  subscribeAccountGate,
  type AccountGateState,
} from './account-disabled-state';
import {
  accountScopedStorageKeys,
  nextGateForProbe,
  PROBE_TIMEOUT_MS,
  runAccountEviction,
  setUnauthorizedHandler,
  withTimeout,
} from './account-eviction';
import { wipeForSignOut } from './db';
import { abortAllInFlight } from './request-cancellation';
import { supabase } from './supabase';

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
 * api() failure with a 401 rings the unauthorized bus. The paths that can
 * discover a disable are therefore:
 *
 *   1. cold launch / session restore — auth-context probes once it has hydrated
 *      a session;
 *   2. sign-in — GoTrue answers `user_banned` (auth-context);
 *   3. any protected request that 401s, from any screen, including the sync
 *      snapshot pull and the foreground/reconnect sync ticks — the bus, here;
 *   4. the live force-logout broadcast, via useSessionRevocation's onTargeted
 *      override — probeNow below runs BEFORE the local sign-out, while the
 *      token that GoTrue needs to answer still exists.
 *
 * All four funnel into the same gate state, and the eviction runs exactly once
 * per transition into `disabled`.
 */
export interface AccountGate {
  state: AccountGateState;
  /** True while a probe is in flight (drives the retry screen's spinner). */
  busy: boolean;
  /** Re-run the probe. The retry affordance on the unverified screen. */
  retry: () => void;
  /**
   * Probe now and report whether the account is CONFIRMED disabled. Handed to
   * useSessionRevocation so a god-admin disable shows the disabled screen
   * instead of "You were signed out from another device."
   */
  probeNow: () => Promise<boolean>;
}

export function useAccountGate(options: { onEvicted: () => void }): AccountGate {
  const { onEvicted } = options;
  const [state, setState] = React.useState<AccountGateState>(getAccountGateState);
  const [busy, setBusy] = React.useState(false);
  const evicting = React.useRef(false);

  React.useEffect(() => {
    // Re-read on mount as well as subscribing: auth-context's cold-launch probe
    // can land between this component's first render and this effect, and a
    // missed transition would leave a disabled account inside the app.
    setState(getAccountGateState());
    return subscribeAccountGate(setState);
  }, []);

  const probeNow = React.useCallback(async (): Promise<boolean> => {
    setBusy(true);
    try {
      // getUser() is the ONLY authority here: /api/v1 answers a disabled caller
      // with the same uniform 401 an anonymous caller gets, on purpose. A
      // rejected call (offline, DNS, timeout) classifies as 'unknown' and
      // changes nothing.
      const res = await withTimeout(supabase.auth.getUser(), PROBE_TIMEOUT_MS, null);
      const next = nextGateForProbe(getAccountGateState(), classifyAuthProbe(res));
      if (next) setAccountGateState(next);
      return next === 'disabled';
    } finally {
      setBusy(false);
    }
  }, []);

  // Any 401, anywhere in the app, gets ONE throttled probe. Registered here so
  // api.ts stays a plain module with no supabase / router / SQLite imports.
  React.useEffect(() => {
    setUnauthorizedHandler(() => {
      void probeNow();
    });
    return () => setUnauthorizedHandler(null);
  }, [probeNow]);

  // Evict on the transition into `disabled`, once. The ref (not state) is what
  // prevents a session-restoration loop: onAuthStateChange fires during the
  // eviction's own sign-out and would otherwise re-enter this effect.
  React.useEffect(() => {
    if (state !== 'disabled' || evicting.current) return;
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
        clearCaches: () => wipeForSignOut(),
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

  const retry = React.useCallback(() => {
    void probeNow();
  }, [probeNow]);

  return { state, busy, retry, probeNow };
}
