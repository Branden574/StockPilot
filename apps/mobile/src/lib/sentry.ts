import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';

/**
 * Crash + error reporting.
 *
 * The DSN is injected at build time via EXPO_PUBLIC_SENTRY_DSN (set as an EAS
 * secret). UNTIL that secret exists, `dsn` is undefined, initSentry() returns
 * early WITHOUT calling Sentry.init, and every other Sentry.* call (wrap,
 * captureException) is a safe no-op — the app behaves exactly as it does today.
 * So this is dormant until you point it at a Sentry project; it can never
 * misbehave for lack of a DSN.
 *
 * NOTE: @sentry/react-native ships a NATIVE module. It must be present in the
 * binary — this only takes effect in a NEW build (version 1.0.1+), never via an
 * OTA to an older build that lacks the native side.
 */
const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

export function initSentry(): void {
  if (!dsn) return;
  Sentry.init({
    dsn,
    // Report only from real builds, never the dev client / simulator.
    enabled: !__DEV__,
    environment: __DEV__ ? 'development' : 'production',
    // Tie events to the app version (which equals the OTA runtime version),
    // so a crash can be traced to the exact release/OTA it shipped in.
    release: Constants.expoConfig?.version
      ? `stockpilot@${Constants.expoConfig.version}`
      : undefined,
    // Performance tracing — lightly sampled. Lower to 0 if it ever gets noisy.
    tracesSampleRate: 0.1,
    // Privacy: do NOT attach IP address / cookies / request bodies by default.
    sendDefaultPii: false,
  });
}

export { Sentry };
