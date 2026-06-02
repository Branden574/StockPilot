import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as React from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { BiometricLockScreen } from '@/components/biometric-lock-screen';
import { MfaChallengeScreen } from '@/components/mfa-challenge-screen';
import { AuthProvider, useAuth } from '@/lib/auth-context';
import { cycleCountSync } from '@/lib/cycle-count-sync';
import { initDb } from '@/lib/db';
import '@/lib/location-task';
import { palette } from '@/lib/theme';
import { useBrandFonts } from '@/lib/use-fonts';
import { useOtaAutoReload } from '@/lib/use-ota-updates';
import { usePushNotifications } from '@/lib/use-push-notifications';
import { useSync } from '@/lib/use-sync';
import { useTheme } from '@/lib/use-theme';

export default function RootLayout() {
  // Apply a freshly-published OTA on this launch (auto check + reload)
  // instead of the default "applies next launch" — so a published update
  // lands after one relaunch, not two.
  useOtaAutoReload();

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

  const fontsReady = useBrandFonts();
  const { mode, c } = useTheme();

  if (!fontsReady) {
    // Hold splash-style background until the three brand fonts are
    // resolved — avoids a flash of system fallback type which would
    // shift every line of copy.
    return <View style={{ flex: 1, backgroundColor: palette('light').paper }} />;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: c.paper }}>
      <AuthProvider>
        <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
        <RootGate />
      </AuthProvider>
    </GestureHandlerRootView>
  );
}

function RootGate() {
  const { session, loading, locked, mfaRequired } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const { c } = useTheme();

  usePushNotifications(session?.user ?? null);
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

  // MFA gate takes precedence over the biometric lock: a fresh password
  // sign-in that owes a TOTP code must complete it before anything else.
  if (!loading && session && mfaRequired) {
    return <MfaChallengeScreen />;
  }

  if (!loading && session && locked) {
    return <BiometricLockScreen />;
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: c.paper },
      }}
    >
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(drawer)" />
      <Stack.Screen name="item/[id]" options={{ presentation: 'card' }} />
      <Stack.Screen name="order/[id]" options={{ presentation: 'card' }} />
      <Stack.Screen name="scan-po/index" options={{ presentation: 'card' }} />
      <Stack.Screen
        name="cycle-count/scan/[id]"
        options={{ presentation: 'fullScreenModal' }}
      />
      <Stack.Screen name="bundles/index" options={{ presentation: 'card' }} />
      <Stack.Screen name="bundles/[id]" options={{ presentation: 'card' }} />
      <Stack.Screen name="rentals/new" options={{ presentation: 'card' }} />
      <Stack.Screen name="schedule/new" options={{ presentation: 'card' }} />
      <Stack.Screen name="ai/chat" options={{ presentation: 'card' }} />
    </Stack>
  );
}
