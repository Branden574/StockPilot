import { type Href, Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as React from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { BiometricLockScreen } from '@/components/biometric-lock-screen';
import { ColdLaunchSplash } from '@/components/cold-launch-splash';
import { AppErrorBoundary } from '@/components/error-boundary';
import { MfaChallengeScreen } from '@/components/mfa-challenge-screen';
import { WhatsNew } from '@/components/onboarding/whats-new';
import { AuthProvider, useAuth } from '@/lib/auth-context';
import { ColdLaunchGateProvider } from '@/lib/cold-launch-gate';
import { cycleCountSync } from '@/lib/cycle-count-sync';
import { initDb } from '@/lib/db';
import { initSentry, Sentry } from '@/lib/sentry';
import { palette } from '@/lib/theme';
import { useBrandFonts } from '@/lib/use-fonts';
import { useOtaAutoReload } from '@/lib/use-ota-updates';
import { usePushNotifications } from '@/lib/use-push-notifications';
import { useSync } from '@/lib/use-sync';
import { useTheme } from '@/lib/use-theme';

// Initialise crash reporting as early as possible (module load = before the
// first render). No-op until EXPO_PUBLIC_SENTRY_DSN is set; see src/lib/sentry.ts.
initSentry();

// Flips true exactly once per JS runtime = once per COLD launch. A warm resume
// from background does NOT reload this module, so the branded splash never
// re-shows on resume — only on a true hard relaunch.
let coldLaunchHandled = false;

function RootLayout() {
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

  // Cold-launch branded splash (fire-once). `isCold` is computed once; the
  // splash overlays the app, then cross-dissolves to reveal whatever RootGate
  // shows underneath (the Face-ID lock on a locked cold launch).
  const [isCold] = React.useState(() => {
    if (coldLaunchHandled) return false;
    coldLaunchHandled = true;
    return true;
  });
  const [splashVisible, setSplashVisible] = React.useState(isCold);
  const [splashActive, setSplashActive] = React.useState(isCold);

  if (!fontsReady) {
    // Hold splash-style background until the three brand fonts are
    // resolved — avoids a flash of system fallback type which would
    // shift every line of copy. On a cold launch use the splash's dark
    // paper so there's no light flash before the (dark) branded splash.
    return (
      <View
        style={{ flex: 1, backgroundColor: isCold ? '#0c0d0a' : palette('light').paper }}
      />
    );
  }

  return (
    <GestureHandlerRootView
      style={{ flex: 1, backgroundColor: splashVisible ? '#0c0d0a' : c.paper }}
    >
      <AuthProvider>
        <StatusBar style={splashVisible || mode === 'dark' ? 'light' : 'dark'} />
        <ColdLaunchGateProvider splashActive={splashActive}>
          <AppErrorBoundary>
            <RootGate />
          </AppErrorBoundary>
        </ColdLaunchGateProvider>
      </AuthProvider>

      {/* Stacked ON TOP for a blank-frame-free crossfade: the splash fades its
          own opacity to 0, revealing RootGate (incl. the Face-ID lock) which is
          always rendered underneath. */}
      {splashVisible ? (
        <ColdLaunchSplash
          onHandoff={() => setSplashActive(false)}
          onDone={() => setSplashVisible(false)}
        />
      ) : null}
    </GestureHandlerRootView>
  );
}

// Sentry.wrap enables the native error boundary + touch/navigation context on
// the root. It is a transparent pass-through when Sentry has no DSN.
export default Sentry.wrap(RootLayout);

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
      // `welcome` is a new route; the generated route-type union only refreshes
      // on the next expo build, so cast until then (stays valid afterward).
      router.replace('/(auth)/welcome' as Href);
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
    <>
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
        <Stack.Screen name="size-count/new" options={{ presentation: 'card' }} />
        <Stack.Screen name="size-count/[id]" options={{ presentation: 'card' }} />
        <Stack.Screen name="size-count/capture" options={{ presentation: 'card' }} />
        <Stack.Screen name="bundles/index" options={{ presentation: 'card' }} />
        <Stack.Screen name="bundles/[id]" options={{ presentation: 'card' }} />
        <Stack.Screen name="rentals/new" options={{ presentation: 'card' }} />
        <Stack.Screen name="schedule/new" options={{ presentation: 'card' }} />
        <Stack.Screen name="ai/chat" options={{ presentation: 'card' }} />
        <Stack.Screen name="zendesk/web" options={{ presentation: 'card' }} />
      </Stack>
      {/* Global What's New — one mount above every authed route (drawer, tabs,
          and cold deep-links into pushed card screens). MFA/lock states early-
          return above, so this only renders in the normal authed shell. */}
      {session && !loading && !mfaRequired && !locked ? <WhatsNew /> : null}
    </>
  );
}
