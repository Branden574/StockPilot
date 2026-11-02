import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { Linking, Platform } from 'react-native';

import { rewriteWebPath } from './web-path-rewrite';
import { supabase } from './supabase';

import type { User } from '@supabase/supabase-js';

/**
 * Foreground behavior: when the app is open and a push arrives, show
 * the banner + ring the bell. Without this, foreground pushes are
 * silently dropped.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

/**
 * Where this phone remembers the push token it registered, so a sign-out can
 * delete exactly that row (push-unbind.ts). The token is the phone's, not the
 * account's: the key is outside the `workspace.` keys a sign-out removes
 * (account-eviction.ts ACCOUNT_SCOPED_STORAGE_PREFIXES), and the sign-out
 * reads it before then anyway.
 */
export const PUSH_TOKEN_STORAGE_KEY = 'sp_push_token_v1';

/*
 * THE SIGN-OUT HOLD (S5). While a sign-out is deleting this phone's row, a
 * registration must not write it again. A token refresh during the sign-out
 * hands RootGate a new user object, the hook below runs again, and its
 * registration would bind the phone to the account once more after the
 * unbind. Each sign-out takes its own hold (two can overlap: a sign-out and a
 * message from another device), and registration waits for every hold to be
 * released.
 */
const holds = new Set<symbol>();

/** Hold registration until the returned hold is released. */
export function holdRegistration(): symbol {
  const hold = Symbol('push-registration-hold');
  holds.add(hold);
  return hold;
}

/** Release one hold. Releasing a hold twice, or one already gone, does nothing. */
export function releaseRegistration(hold: symbol): void {
  holds.delete(hold);
}

/*
 * Registrations already sent: the RPC and the remembering of its token. The
 * unbind waits for these first (registrationSettled), so the row a
 * registration is writing is the row it deletes. Real promises, not the
 * Supabase builder: a builder sends its request again each time it is awaited
 * (pattern #22).
 */
const inFlight = new Set<Promise<void>>();

/**
 * Wait for every registration already sent to answer and its token to be
 * remembered, for at most `ms`. Answers at once when none is in flight.
 */
export async function registrationSettled(ms: number): Promise<void> {
  if (inFlight.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled([...inFlight]).then(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

/** The token this phone last registered, or null. Rejects when the storage
 *  cannot be read (the unbind reports that as a failure, not as "none"). */
export function rememberedPushToken(): Promise<string | null> {
  return AsyncStorage.getItem(PUSH_TOKEN_STORAGE_KEY);
}

/**
 * Whether this session still owes its authenticator code (aal1, with a
 * verified factor: nextLevel aal2). A password alone must not bind this phone
 * to the account's notifications; the hook runs again when the code upgrades
 * the session.
 *
 * Fails closed: a level that cannot be read, or no session, owes it. With no
 * jwt, auth-js 2.105.1 reads the level from the stored session (it decodes
 * the access token and reads session.user.factors; GoTrueClient.js
 * _getAuthenticatorAssuranceLevel), refreshing only a token near expiry: no
 * request of its own.
 */
async function owesAuthenticatorCode(): Promise<boolean> {
  try {
    const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error || !data?.currentLevel) return true;
    return data.currentLevel === 'aal1' && data.nextLevel === 'aal2';
  } catch {
    return true;
  }
}

/**
 * Register this phone's Expo push token for the signed-in user, and remember
 * it (PUSH_TOKEN_STORAGE_KEY). Skipped on a simulator, without permission,
 * while the session owes its authenticator code, and while a sign-out holds
 * registration. The code step and the hold are read after the last await
 * before the RPC, so a sign-out that starts while the phone waits for the
 * permission, the token or the level is never missed.
 *
 * Never throws: a failure is warned, and never blocks the app shell or a
 * sign-in.
 */
export async function registerThisDevice(
  user: User | null,
  opts: { isCancelled?: () => boolean } = {},
): Promise<void> {
  if (!user) return;
  const cancelled = () => opts.isCancelled?.() === true;
  try {
    if (!Device.isDevice) {
      // Push tokens don't work in the iOS simulator / Android emulator.
      return;
    }

    // Permission ladder: get current → ask if not yet granted.
    const existing = await Notifications.getPermissionsAsync();
    let granted = existing.status === 'granted';
    if (!granted) {
      const requested = await Notifications.requestPermissionsAsync();
      granted = requested.status === 'granted';
    }
    if (!granted || cancelled()) return;

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'StockPilot alerts',
        importance: Notifications.AndroidImportance.DEFAULT,
        sound: 'default',
      });
    }

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      (Constants.easConfig as { projectId?: string } | undefined)?.projectId;
    const tokenRes = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    const token = tokenRes.data;
    if (!token || cancelled()) return;

    if (await owesAuthenticatorCode()) return;
    if (holds.size > 0 || cancelled()) return;

    // ═══ REBIND GOES THROUGH THE RPC, NOT A RAW UPSERT (0348) ═══
    //
    // `upsert(..., { onConflict: 'token' })` cannot rebind a token row that
    // still belongs to a PREVIOUS user of this device: push_tokens carries
    // one policy, push_tokens_self `using (user_id = auth.uid())`, so the
    // UPDATE half matches no row the new user may touch and Postgres
    // answers "new row violates row-level security policy". The catch
    // below then swallowed it as a warning — so the handset kept the old
    // binding and silently received the previous user's notifications.
    // register_push_token is SECURITY DEFINER and self-authorising on
    // auth.uid(): it deletes any other binding of this token, then writes
    // the caller's row. It is the only audited rebind path.
    const send = (async () => {
      const { error: registerErr } = await supabase.rpc('register_push_token', {
        p_token: token,
        p_platform: Platform.OS === 'ios' ? 'ios' : 'android',
        p_device_id: null,
      });
      if (registerErr) throw registerErr;
      await AsyncStorage.setItem(PUSH_TOKEN_STORAGE_KEY, token);
    })();
    inFlight.add(send);
    const settled = () => {
      inFlight.delete(send);
    };
    void send.then(settled, settled);
    await send;
  } catch (err) {
    // Best-effort. We never want a notifications setup failure to
    // crash the app shell or block the user from signing in.
    console.warn('[push] registration failed', err);
  }
}

/**
 * Registers this phone's Expo push token for the signed-in user
 * (registerThisDevice). Re-runs on user change so tokens stay scoped to the
 * right account when an admin signs in/out on the same device, and when the
 * authenticator code upgrades the session. Also installs a tap handler that
 * opens the deep link sent with the notification (e.g.
 * /dashboard/inventory/{id}).
 */
export function usePushNotifications(user: User | null) {
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    let tapSubscription: Notifications.Subscription | null = null;

    void registerThisDevice(user, { isCancelled: () => cancelled });

    // Hosts we'll trust as targets of an https:// deep link in a push
    // payload. An open-allowlist for any https:// URL would let a
    // poisoned notifications row redirect users to phishing pages.
    // Hard-pin to the known production hosts; localhost is allowed
    // only in dev so engineers testing locally still get clicks.
    const ALLOWED_HTTPS_HOSTS = ['stockpilotusa.com', 'www.stockpilotusa.com'];

    // Tap handler: open the deep link if one was supplied.
    tapSubscription = Notifications.addNotificationResponseReceivedListener((res) => {
      const link = (res.notification.request.content.data as { link?: string })?.link;
      if (link && typeof link === 'string') {
        // Internal web paths go through the ONE shared rewriter (see
        // web-path-rewrite.ts) — never a local mapping table.
        if (link.startsWith('/')) {
          const native = rewriteWebPath(link);
          Linking.openURL(`stockpilot://${native.replace(/^\//, '')}`).catch(() => {});
        } else if (link.startsWith('stockpilot://')) {
          Linking.openURL(link).catch(() => {});
        } else if (link.startsWith('https://')) {
          // Only follow https:// URLs that point at our known hosts.
          // Stops a poisoned `notifications.link` row from sending
          // a phone user to attacker.com via the in-app browser.
          try {
            const u = new URL(link);
            if (ALLOWED_HTTPS_HOSTS.includes(u.hostname.toLowerCase())) {
              Linking.openURL(link).catch(() => {});
            }
          } catch {
            // Malformed URL — drop silently.
          }
        }
      }
    });

    return () => {
      cancelled = true;
      tapSubscription?.remove();
    };
  }, [user]);
}
