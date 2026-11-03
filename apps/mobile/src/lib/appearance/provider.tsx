import { styleOf, type AppearanceMode } from '@stockpilot/core';
import * as Network from 'expo-network';
import * as React from 'react';
import { AppState, Platform } from 'react-native';

import {
  ControlContext,
  ReadyContext,
  ThemeContext,
  type AppearanceControl,
  type AppearanceThemeContextValue,
} from './context';
import type { AppearanceSnapshot } from './controller';
import { getGlassModule } from './glass-module';
import { selectMaterial, type GlassMaterial } from './material';
import { applyOsScheme } from './os-scheme';
import { getAppearanceController } from './singleton';
import { useReduceTransparency } from './use-reduce-transparency';

/**
 * AppearanceProvider (plan 5.1): sits above GestureHandlerRootView in
 * app/_layout.tsx and gives useTheme() the person's appearance.
 *
 * It renders its children exactly once and never keys them: changing the
 * appearance re-renders the tree the way a device Light/Dark change always
 * did, so RootLayout's mount-only effect (initDb, pruneRejected, the
 * cycle-count sync engine), RootGate's hooks (push registration, useSync, the
 * account gate), the scanner tab, open sheets and typed forms all keep their
 * state. It reads nothing from the network before the first paint: one
 * AsyncStorage read, capped by APPEARANCE_READ_TIMEOUT_MS.
 *
 * Three contexts, so a sync-status change ("Saving...", "Saved to your
 * account") re-renders only the readers of the control (the Appearance
 * screen, the Settings row, the crash-fallback notice), never the 157
 * useTheme() callers (ThemeContext: the appearance and material) and never
 * RootLayout (ReadyContext: one boolean that flips once at launch).
 */

/** Same cap as the font gate (app/_layout.tsx FONT_GATE_TIMEOUT_MS): past it, System. */
export const APPEARANCE_READ_TIMEOUT_MS = 4000;

function useMaterial(effective: AppearanceMode): GlassMaterial {
  const reduceTransparency = useReduceTransparency();
  const style = styleOf(effective);
  // The glass module is looked at only once Liquid Glass is actually shown:
  // classic, and a build with the kill switch off, never load it.
  const glassModuleAvailable = style === 'liquid-glass' && getGlassModule() !== null;
  return selectMaterial({
    style,
    os: Platform.OS,
    version: Platform.Version,
    glassModuleAvailable,
    reduceTransparency,
  });
}

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const controller = getAppearanceController();
  const snapshot: AppearanceSnapshot = React.useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  React.useEffect(() => {
    void controller.hydrate();
    const timer = setTimeout(() => controller.giveUpWaiting(), APPEARANCE_READ_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [controller]);

  // Rule 2: a save that failed (or a read that found no account store) is
  // tried again when the app comes back to the foreground and when the
  // network comes back, as well as by Try again.
  const status = snapshot.state.status;
  React.useEffect(() => {
    if (status !== 'failed' && status !== 'unavailable') return;
    const appSub = AppState.addEventListener('change', (next) => {
      if (next === 'active') controller.retry();
    });
    let wasConnected: boolean | null = null;
    const netSub = Network.addNetworkStateListener((net) => {
      const connected = net.isConnected === true && net.isInternetReachable !== false;
      if (wasConnected === false && connected) controller.retry();
      wasConnected = connected;
    });
    return () => {
      appSub.remove();
      netSub.remove();
    };
  }, [controller, status]);

  const material = useMaterial(snapshot.effective);

  // A fixed Dark or Light also sets the OS scheme, so alerts and the keyboard
  // match the screens; System and Liquid Glass hand it back to the device.
  React.useEffect(() => {
    applyOsScheme(snapshot.effective);
  }, [snapshot.effective]);

  const theme = React.useMemo<AppearanceThemeContextValue>(
    () => ({ appearance: snapshot.effective, material }),
    [snapshot.effective, material],
  );

  const control = React.useMemo<AppearanceControl>(
    () => ({
      choice: snapshot.state.mode,
      effective: snapshot.effective,
      lastClassic: snapshot.state.lastClassic,
      status: snapshot.state.status,
      ready: snapshot.ready,
      glassEnabled: snapshot.glassEnabled,
      fallbackActive: snapshot.fallbackActive,
      material,
      choose: controller.choose,
      retry: controller.retry,
      endFallback: controller.endFallback,
    }),
    [snapshot, material, controller],
  );

  return (
    <ControlContext.Provider value={control}>
      <ReadyContext.Provider value={snapshot.ready}>
        <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
      </ReadyContext.Provider>
    </ControlContext.Provider>
  );
}

export { useAppearance, useAppearanceReady, useAppearanceTheme } from './context';
export type { AppearanceControl, AppearanceThemeContextValue } from './context';
