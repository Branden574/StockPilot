import { useNetworkState } from 'expo-network';
import * as React from 'react';
import { Alert, AppState } from 'react-native';

import {
  ORDER_DONT_SEND_COPY,
  ORDER_SEE_MY_ORDERS_COPY,
  SIGN_IN_HELD_DROPPED_COPY,
  SIGN_IN_HELD_NOT_NOW_COPY,
  SIGN_IN_HELD_UNCONFIRMED_COPY,
  SIGN_IN_HELD_UNCONFIRMED_TITLE_COPY,
  signInHeldPlacedCopy,
} from '@stockpilot/core';

import { accountEpoch } from '../account-epoch';
import { useAuth } from '../auth-context';
import { isOfflineState } from '../exceptions-api';
import { loadOrgs, useWorkspace } from '../use-workspace';
import { orderStorefrontApi, orderStore } from './services';
import { createStorefrontSession, type StorefrontSession, type StorefrontSnapshot } from './session';
import { checkHeldSubmissions, heldWithdrawSentence, withdrawHeldSubmission, type HoldCheck } from './sign-out-hold';

/**
 * THE PHONE STOREFRONT'S HOOKS (phone ordering PO-4): the one session of this
 * app run (session.ts) behind the real calls, AsyncStorage and the account
 * epoch (services.ts), and the hooks the screens and the root use. Nothing
 * here decides anything: every rule is in the pure modules beside it, and
 * order-storefront-wiring.test.ts pins this file to them.
 */

let shared: StorefrontSession | null = null;

/** The one storefront session of this app run. */
export function storefrontSession(): StorefrontSession {
  if (!shared) {
    shared = createStorefrontSession({
      api: orderStorefrontApi,
      store: orderStore,
      epoch: accountEpoch,
      now: () => Date.now(),
    });
  }
  return shared;
}

/**
 * The storefront for the signed-in account and the active workspace, or null
 * while it is not open for them (the first render after a switch, or signed
 * out): nothing of another account or organization is ever shown.
 */
export function useStorefront(): StorefrontSnapshot | null {
  const session = storefrontSession();
  const snap = React.useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { user } = useAuth();
  const { activeOrgId } = useWorkspace();
  if (!user || !activeOrgId || !snap.scope) return null;
  if (snap.scope.userId !== user.id || snap.scope.orgId !== activeOrgId) return null;
  return snap;
}

/** Whether this phone is definitely offline (expo-network; unknown reads as online). */
export function useOffline(): boolean {
  return isOfflineState(useNetworkState());
}

/**
 * Opens the storefront for the signed-in account and the active workspace
 * (a switch starts over), and reads what is stale when the app returns to the
 * foreground or the connection comes back, including the status of a send
 * that is not confirmed. Never sends.
 */
export function useStorefrontScope(): void {
  const session = storefrontSession();
  const { user } = useAuth();
  const { activeOrgId, activeWarehouseId } = useWorkspace();
  const userId = user?.id ?? null;
  React.useEffect(() => {
    if (!userId || !activeOrgId) {
      session.close();
      return;
    }
    void session.open({ userId, orgId: activeOrgId, activeWarehouseId });
  }, [session, userId, activeOrgId, activeWarehouseId]);

  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void session.focus();
    });
    return () => sub.remove();
  }, [session]);

  const offline = useOffline();
  const wasOffline = React.useRef(offline);
  React.useEffect(() => {
    if (wasOffline.current && !offline) void session.focus();
    wasOffline.current = offline;
  }, [offline, session]);
}

/**
 * At sign-in, and when the app returns to the foreground, the order requests
 * this account held at its last sign-out are checked (reads only): placed is
 * said; one that can no longer be checked from this phone (an organization
 * the account left, or 30 days unknown) is dropped with one sentence; still
 * unknown offers "Don't send it" and "See my orders", once per app run.
 * "Don't send it" always says what happened; with no answer it is offered
 * again. Never resends.
 */
export function useHeldOrderSubmissions(userId: string | null, onSeeOrders: () => void): void {
  const offered = React.useRef(new Set<string>());
  const running = React.useRef(false);
  const seeOrders = React.useRef(onSeeOrders);
  React.useLayoutEffect(() => {
    seeOrders.current = onSeeOrders;
  });

  React.useEffect(() => {
    if (!userId) return;
    const deps = {
      userId,
      store: orderStore,
      calls: orderStorefrontApi,
      // Read only when a marker is held; a failed read drops nothing.
      memberOrgIds: async () => (await loadOrgs(userId))?.map((o) => o.id) ?? null,
    };
    const run = async () => {
      if (running.current) return;
      running.current = true;
      try {
        const result = await checkHeldSubmissions(deps);
        for (const label of result.placed) Alert.alert(signInHeldPlacedCopy(label));
        if (result.dropped > 0) Alert.alert(SIGN_IN_HELD_DROPPED_COPY);
        for (const hold of result.unknown) {
          const id = `${hold.orgId}.${hold.key}`;
          if (offered.current.has(id)) continue;
          offered.current.add(id);
          Alert.alert(SIGN_IN_HELD_UNCONFIRMED_TITLE_COPY, SIGN_IN_HELD_UNCONFIRMED_COPY, [
            { text: SIGN_IN_HELD_NOT_NOW_COPY, style: 'cancel' },
            { text: ORDER_SEE_MY_ORDERS_COPY, onPress: () => seeOrders.current() },
            {
              text: ORDER_DONT_SEND_COPY,
              onPress: () =>
                void withdrawHeldSubmission(deps, hold)
                  .catch((): HoldCheck => ({ outcome: 'unknown' }))
                  .then((check) => {
                    // No answer: not counted as offered, so it is asked again.
                    if (check.outcome === 'unknown') offered.current.delete(id);
                    Alert.alert(heldWithdrawSentence(check));
                  }),
            },
          ]);
        }
      } catch {
        // Kept for the next foreground.
      } finally {
        running.current = false;
      }
    };
    void run();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void run();
    });
    return () => sub.remove();
  }, [userId]);
}
