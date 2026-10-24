import * as Updates from 'expo-updates';
import * as React from 'react';

import { notificationIntents } from './notification-intent';
import { pushOpenDiag, type PushOpenEvent } from './push-open-diagnostics';

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
 * EXCEPT on a launch from a notification (Phase 3, owner decision 1). The
 * reload restarts JavaScript, which drops the tapped notification on its way
 * to its order, and native's record of the tap with it (expo-notifications
 * recreates its module on reload). So when this launch has taken a tap
 * (notification-intent.ts), the fetched update is kept for the next cold
 * launch instead, and nothing is persisted.
 *
 * Startup-only (runs once on mount) so it never interrupts work mid-session.
 * No-op in dev / Expo Go, where updates aren't enabled.
 */
export function useOtaAutoReload(): void {
  React.useEffect(() => {
    let cancelled = false;
    void runStartupUpdate({
      isDev: __DEV__,
      isEnabled: Updates.isEnabled,
      checkForUpdateAsync: () => Updates.checkForUpdateAsync(),
      fetchUpdateAsync: () => Updates.fetchUpdateAsync(),
      reloadAsync: () => Updates.reloadAsync(),
      seenNotificationThisLaunch: () => notificationIntents.seenThisLaunch(),
      isCancelled: () => cancelled,
      diag: pushOpenDiag,
    });
    return () => {
      cancelled = true;
    };
  }, []);
}

export interface StartupUpdateDeps {
  isDev: boolean;
  isEnabled: boolean;
  checkForUpdateAsync(): Promise<{ isAvailable: boolean }>;
  fetchUpdateAsync(): Promise<unknown>;
  reloadAsync(): Promise<unknown>;
  /** True once this launch has taken a notification tap. */
  seenNotificationThisLaunch(): boolean;
  /** The hook unmounted. */
  isCancelled(): boolean;
  diag(event: PushOpenEvent): void;
}

export type StartupUpdateOutcome =
  'skipped' | 'up-to-date' | 'cancelled' | 'deferred' | 'reloaded' | 'failed';

/** The launch update check, with every call injected (use-ota-updates.test.ts). */
export async function runStartupUpdate(deps: StartupUpdateDeps): Promise<StartupUpdateOutcome> {
  if (deps.isDev || !deps.isEnabled) return 'skipped';
  try {
    const result = await deps.checkForUpdateAsync();
    if (deps.isCancelled()) return 'cancelled';
    if (!result.isAvailable) return 'up-to-date';
    await deps.fetchUpdateAsync();
    if (deps.isCancelled()) return 'cancelled';
    // Read AFTER the download: a tap during it counts too.
    if (deps.seenNotificationThisLaunch()) {
      deps.diag({ stage: 'ota-reload-deferred' });
      return 'deferred';
    }
    await deps.reloadAsync();
    return 'reloaded';
  } catch {
    // Best-effort — if anything fails, the default path still applies
    // the update on the next launch. No user-facing error.
    return 'failed';
  }
}
