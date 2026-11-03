import type { AppearanceStyle } from '@stockpilot/core';
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
import { isThisDeviceLowEnd } from './device-class';
import { getGlassModule } from './glass-module';
import { selectMaterial, selectScene, type GlassMaterial } from './material';
import { applyOsScheme } from './os-scheme';
import { getAppearanceController } from './singleton';
import { useReduceTransparency } from './use-reduce-transparency';

/**
 * AppearanceProvider (plan 5.1): sits above GestureHandlerRootView in
 * app/_layout.tsx and gives useTheme() the person's Design and Theme.
 *
 * It renders its children exactly once and never keys them: changing the
 * appearance re-renders the tree the way a device Light/Dark change always
 * did, so RootLayout's mount-only effect (initDb, pruneRejected, the
 * cycle-count sync engine), RootGate's hooks (push registration, useSync, the
 * account gate), the scanner tab, open sheets and typed forms all keep their
 * state. Before the first paint it reads AsyncStorage, and only on the first
 * start of the new JS with no record of its own (item 31) the signed-in
 * person's row, all capped by APPEARANCE_READ_TIMEOUT_MS.
 *
 * Three contexts, so a sync-status change ("Saving...", "Saved to your
 * account") re-renders only the readers of the control (the Appearance
 * screen, the Settings row, the crash-fallback notice, the intro card), never
 * the 157 useTheme() callers (ThemeContext: the Design, Theme, material and
 * scene) and never RootLayout (ReadyContext: one boolean that flips once at
 * launch).
 */

/**
 * Same cap as the font gate (app/_layout.tsx FONT_GATE_TIMEOUT_MS), and
 * running alongside it, not after it: past it, the rollout's default Design.
 * The first-start account read (item 31) waits inside it, never adds to it.
 */
export const APPEARANCE_READ_TIMEOUT_MS = 4000;

function useMaterial(style: AppearanceStyle): { material: GlassMaterial; scene: boolean } {
  const reduceTransparency = useReduceTransparency();
  // The glass module and the device class are looked at only once Liquid
  // Glass is actually drawn: classic, and a build with the kill switch off,
  // never load them.
  const glass = style === 'liquid-glass';
  const glassModuleAvailable = glass && getGlassModule() !== null;
  const lowEnd = glass && isThisDeviceLowEnd();
  const inputs = {
    style,
    os: Platform.OS,
    version: Platform.Version,
    glassModuleAvailable,
    reduceTransparency,
    lowEnd,
  };
  return { material: selectMaterial(inputs), scene: selectScene(inputs) };
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

  // Item 32: a Design adopted from the account while the person was in the
  // middle of something is drawn at the next return to the app at the latest.
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') controller.resumed();
    });
    return () => sub.remove();
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

  const { material, scene } = useMaterial(snapshot.style);

  // A fixed Light or Dark Theme also sets the OS scheme in both Designs, so
  // alerts and the keyboard match the screens (Night glass gets dark ones);
  // System, and the 'off' rollout, hand it back to the device (item 34).
  React.useEffect(() => {
    applyOsScheme(snapshot.theme);
  }, [snapshot.theme]);

  const theme = React.useMemo<AppearanceThemeContextValue>(
    () => ({ style: snapshot.style, theme: snapshot.theme, material, scene }),
    [snapshot.style, snapshot.theme, material, scene],
  );

  const control = React.useMemo<AppearanceControl>(
    () => ({
      chosenStyle: snapshot.state.style,
      chosenTheme: snapshot.state.theme,
      style: snapshot.style,
      theme: snapshot.theme,
      rollout: snapshot.rollout,
      status: snapshot.state.status,
      ready: snapshot.ready,
      glassEnabled: snapshot.glassEnabled,
      fallbackActive: snapshot.fallbackActive,
      introVisible: snapshot.introVisible,
      material,
      chooseStyle: controller.chooseStyle,
      chooseTheme: controller.chooseTheme,
      keepGlass: controller.keepGlass,
      dismissIntro: controller.dismissIntro,
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
