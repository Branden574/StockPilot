import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as React from 'react';

import { AuthProvider, useAuth } from '@/lib/auth-context';
import { cycleCountSync } from '@/lib/cycle-count-sync';
import { initDb } from '@/lib/db';
import { usePushNotifications } from '@/lib/use-push-notifications';
import { useSync } from '@/lib/use-sync';

export default function RootLayout() {
  // Initialise SQLite + cycle-count sync engine once at app start so any
  // screen that calls getDb() / useSyncStatus() can assume both are
  // ready. Idempotent — initDb() short-circuits if the DB is already
  // open.
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await initDb();
      } catch (e) {
        console.warn('[init] db init failed', e);
      }
      if (!cancelled) {
        cycleCountSync.start();
      }
    })();
    return () => {
      cancelled = true;
      cycleCountSync.stop();
    };
  }, []);

  return (
    <AuthProvider>
      <StatusBar style="light" />
      <RootGate />
    </AuthProvider>
  );
}

function RootGate() {
  const { session, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  // Register an Expo push token + persist to push_tokens whenever the
  // signed-in user changes. No-op for nullable session.
  usePushNotifications(session?.user ?? null);
  // Pull mobile snapshot + drain the offline action queue on app open
  // and every 60s while foregrounded. Also no-op for nullable session.
  useSync(session?.user ?? null);

  React.useEffect(() => {
    if (loading) return;
    const inAuthGroup = segments[0] === '(auth)';
    if (!session && !inAuthGroup) {
      router.replace('/(auth)/sign-in');
    } else if (session && inAuthGroup) {
      router.replace('/');
    }
  }, [session, loading, segments, router]);

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#0a0f1f' } }}>
      <Stack.Screen name="(auth)" />
      {/*
        The (drawer) group hosts the bottom tabs inside a drawer
        navigator (see app/(drawer)/_layout.tsx). Modal screens below
        stay at the root Stack so their back-swipe still works.
      */}
      <Stack.Screen name="(drawer)" />
      <Stack.Screen name="item/[id]" options={{ presentation: 'card' }} />
      <Stack.Screen name="scan-po/index" options={{ presentation: 'card' }} />
      <Stack.Screen
        name="cycle-count/scan/[id]"
        options={{ presentation: 'fullScreenModal' }}
      />
      <Stack.Screen name="bundles/index" options={{ presentation: 'card' }} />
      <Stack.Screen name="bundles/[id]" options={{ presentation: 'card' }} />
    </Stack>
  );
}
