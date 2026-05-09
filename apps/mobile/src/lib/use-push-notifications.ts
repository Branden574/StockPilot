import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { Linking, Platform } from 'react-native';

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

        await supabase.from('push_tokens').upsert(
          {
            user_id: user.id,
            token,
            platform: Platform.OS === 'ios' ? 'ios' : 'android',
            last_used_at: new Date().toISOString(),
          },
          { onConflict: 'token' },
        );
      } catch (err) {
        // Best-effort. We never want a notifications setup failure to
        // crash the app shell or block the user from signing in.
        console.warn('[push] registration failed', err);
      }
    })();

    // Tap handler: open the deep link if one was supplied.
    tapSubscription = Notifications.addNotificationResponseReceivedListener((res) => {
      const link = (res.notification.request.content.data as { link?: string })?.link;
      if (link && typeof link === 'string') {
        // Internal /dashboard/... paths are translated to native
        // stockpilot:// deep links. Anything else is only opened if
        // it's an explicit https:// or stockpilot:// URL — this
        // blocks `javascript:`, `intent:`, `data:`, and other unsafe
        // schemes that would otherwise be opened verbatim by
        // Linking.openURL if the push payload were ever poisoned.
        if (link.startsWith('/dashboard/inventory/')) {
          const id = link.split('/').pop();
          if (id) Linking.openURL(`stockpilot://item/${id}`).catch(() => {});
        } else if (link.startsWith('/dashboard/purchase-orders/')) {
          const id = link.split('/').pop();
          if (id) Linking.openURL(`stockpilot://po/${id}`).catch(() => {});
        } else if (link.startsWith('https://') || link.startsWith('stockpilot://')) {
          Linking.openURL(link).catch(() => {});
        }
      }
    });

    return () => {
      cancelled = true;
      tapSubscription?.remove();
    };
  }, [user]);
}
