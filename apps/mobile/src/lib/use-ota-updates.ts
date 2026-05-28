import * as Updates from 'expo-updates';
import * as React from 'react';

/**
 * On cold launch, check for an OTA update and — if one is available —
 * fetch and reload into it right away.
 *
 * Default expo-updates behavior (fallbackToCacheTimeout = 0) loads the
 * current bundle instantly, downloads the new one in the background, and
 * only applies it on the NEXT launch — which is why a fresh publish used
 * to need two quits. This applies it within the same launch (one quit):
 * the app starts on the current bundle, then auto-reloads into the new one
 * a moment later once it's fetched.
 *
 * Startup-only (runs once on mount) so it never interrupts work mid-session.
 * No-op in dev / Expo Go, where updates aren't enabled.
 */
export function useOtaAutoReload(): void {
  React.useEffect(() => {
    if (__DEV__ || !Updates.isEnabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await Updates.checkForUpdateAsync();
        if (cancelled || !result.isAvailable) return;
        await Updates.fetchUpdateAsync();
        if (cancelled) return;
        await Updates.reloadAsync();
      } catch {
        // Best-effort — if anything fails, the default path still applies
        // the update on the next launch. No user-facing error.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
}
