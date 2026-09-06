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
 * Registers an Expo push token for the signed-in user and persists it
 * into public.push_tokens. Re-runs on user change so tokens stay
 * scoped to the right account when an admin signs in/out on the same
 * device. Also installs a tap handler that opens the deep link sent
 * with the notification (e.g. /dashboard/inventory/{id}).
 */
export function usePushNotifications(user: User | null) {
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    let tapSubscription: Notifications.Subscription | null = null;

    (async () => {
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
        if (!granted || cancelled) return;

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
        if (!token || cancelled) return;

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
        const { error: registerErr } = await supabase.rpc('register_push_token', {
          p_token: token,
          p_platform: Platform.OS === 'ios' ? 'ios' : 'android',
          p_device_id: null,
        });
        if (registerErr) throw registerErr;
      } catch (err) {
        // Best-effort. We never want a notifications setup failure to
        // crash the app shell or block the user from signing in.
        console.warn('[push] registration failed', err);
      }
    })();

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
