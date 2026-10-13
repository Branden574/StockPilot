import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { Platform } from 'react-native';

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
 * device.
 *
 * Taps are NOT handled here any more (Phase 3, iPhone push tap). The tap
 * listener lived in this effect, so it existed only once a user did: a tap
 * that launched the app, or came in signed out, was lost, and the rest
 * round-tripped through Linking.openURL with every failure swallowed.
 * notification-intent.ts now captures every tap from module scope, and
 * NotificationIntentHost opens it inside the app once the app is ready.
 */
export function usePushNotifications(user: User | null) {
  useEffect(() => {
    if (!user) return;
    let cancelled = false;

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

    return () => {
      cancelled = true;
    };
  }, [user]);
}
