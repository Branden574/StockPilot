import { type Href, Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as React from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AccountDisabledScreen } from '@/components/account-disabled-screen';
import { BiometricLockScreen } from '@/components/biometric-lock-screen';
import { ColdLaunchSplash } from '@/components/cold-launch-splash';
import { AppErrorBoundary } from '@/components/error-boundary';
import { MfaChallengeScreen } from '@/components/mfa-challenge-screen';
import { WhatsNew } from '@/components/onboarding/whats-new';
import { clearSessionEnded, signedOutRoute } from '@/lib/account-eviction';
import { AuthProvider, useAuth } from '@/lib/auth-context';
import { ColdLaunchGateProvider } from '@/lib/cold-launch-gate';
import { cycleCountSync } from '@/lib/cycle-count-sync';
import { initDb } from '@/lib/db';
import { pruneRejected } from '@/lib/queue';
import { initSentry, Sentry } from '@/lib/sentry';
import { palette } from '@/lib/theme';
import { useAccountGate } from '@/lib/use-account-gate';
import { useBrandFonts } from '@/lib/use-fonts';
import { useOtaAutoReload } from '@/lib/use-ota-updates';
import { usePushNotifications } from '@/lib/use-push-notifications';
import { useSessionRevocation } from '@/lib/use-session-revocation';
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
        // RETENTION for terminally rejected offline work. Those rows are kept
        // on purpose (wipeForSignOut spares them) so the operator and support
        // can still see what was never sent — but "kept" cannot mean "kept
        // forever": on a shared warehouse device they would otherwise
        // accumulate for the life of the install, carrying one user's payloads
        // past every later sign-in. Best-effort and never fatal.
        await pruneRejected();
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

  // Mounted HERE, not in DrawerContent: a user sitting on an auth-group screen,
  // a pushed card screen, a full-screen modal or the pre-drawer cold-launch
  // path had no revocation listener at all, so a force-logout simply did not
  // reach them. RootGate is the one component mounted on every screen.
  //
  // The destination also changes, deliberately: the drawer sent a
  // force-logged-out user to '/(auth)/sign-in', this sends them to the same
  // place the unauthenticated redirect below uses, so there is one exit for
  // both. signedOutRoute() picks between them — see the redirect effect.
  const onForcedSignOut = React.useCallback(() => {
    router.replace(signedOutRoute() as Href);
  }, [router]);

  const accountGate = useAccountGate({ onEvicted: onForcedSignOut });
  const revocationOptions = React.useMemo(
    () => ({ onTargeted: accountGate.onSessionRevoked }),
    [accountGate.onSessionRevoked],
  );
  useSessionRevocation(session?.user?.id ?? null, onForcedSignOut, revocationOptions);

  React.useEffect(() => {
    // A disabled account owns the screen: leave the router alone so the
    // redirect below cannot fight the disabled screen (the session-restoration
    // loop this gate exists to prevent).
    if (loading || accountGate.state === 'disabled') return;
    const inAuthGroup = segments[0] === '(auth)';
    if (!session && !inAuthGroup) {
      // WHERE depends on WHY. An ordinary signed-out launch gets the marketing
      // screen. A device whose session was REVOKED under it gets sign-in: it
      // cannot know whether it was disabled — GoTrue answers `session_not_found`
      // to anything it asks — and a password grant is the one action that can
      // still find out, because GoTrue answers `user_banned` to that. Sending
      // it to the marketing screen instead is what the end-to-end run observed,
      // and it is a dead end. signedOutRoute() is a pure, STABLE read — this
      // effect depends on `segments` and re-runs before they settle, so a
      // read-and-clear latch answered sign-in once and then overwrote it with
      // the marketing screen on the very next pass.
      //
      // Both `welcome` and `sign-in` are cast: the generated route-type union
      // only refreshes on the next expo build (stays valid afterward).
      router.replace(signedOutRoute() as Href);
    } else if (session && inAuthGroup) {
      // A session again: whatever killed the last one is history, so the next
      // ordinary sign-out gets the marketing screen back. Without this the
      // sign-in destination would be sticky for the rest of the app's life.
      clearSessionEnded();
      router.replace('/');
    }
  }, [session, loading, segments, router, accountGate.state]);

  // The account gate outranks every other gate, and deliberately does NOT
  // require a session: a disabled user is rejected AT sign-in, so there is no
  // session to test. It also sits above the MFA gate — a disabled account must
  // not be asked for a TOTP code it can never usefully supply.
  if (!loading && accountGate.state === 'disabled') {
    return <AccountDisabledScreen />;
  }

  // A status we could NOT read ('unverified') deliberately renders NOTHING of
  // its own. It used to replace the whole app with a retry button, which meant
  // a GoTrue 5xx — an identity-server blip that says nothing about this account
  // — cut a warehouse phone off from its SQLite cache and its offline outbox,
  // the two things built to keep working without a server. The app now proceeds
  // on its cached session while useAccountGate re-probes in the background; only
  // a DEFINITIVE disabled verdict blocks, above.
  //
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
        <Stack.Screen name="size-count/review" options={{ presentation: 'card' }} />
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
