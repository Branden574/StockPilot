import type {
  AppearanceStyle,
  AppearanceSyncStatus,
  GlassRollout,
  ThemeSetting,
} from '@stockpilot/core';
import * as React from 'react';

import type { GlassMaterial } from './material';

/**
 * The appearance contexts and their hooks, apart from the provider so that
 * useTheme() (imported by 157 files) depends on nothing but React and these
 * types: not on the controller, storage or the Supabase client.
 */

export interface AppearanceThemeContextValue {
  /** The Design drawn (after the rollout, the crash fallback and a held adoption). */
  style: AppearanceStyle;
  /** The Theme drawn; null follows the device. */
  theme: ThemeSetting | null;
  material: GlassMaterial;
  /** The pre-blurred scene photo is drawn behind the content. */
  scene: boolean;
}

export interface AppearanceControl {
  /** The person's own Design choice; null = never chose (the rollout's default shows). */
  chosenStyle: AppearanceStyle | null;
  /** The person's own Theme choice; null = never chose (System). */
  chosenTheme: ThemeSetting | null;
  /** The Design drawn right now. */
  style: AppearanceStyle;
  /** The Theme drawn right now; null follows the device. */
  theme: ThemeSetting | null;
  rollout: GlassRollout;
  status: AppearanceSyncStatus;
  ready: boolean;
  /** rollout !== 'off': the Design choice is offered. */
  glassEnabled: boolean;
  fallbackActive: boolean;
  /** The one-time "new look" card on Home (R13). */
  introVisible: boolean;
  material: GlassMaterial;
  chooseStyle(style: AppearanceStyle): void;
  chooseTheme(theme: ThemeSetting): void;
  keepGlass(): void;
  dismissIntro(): void;
  retry(): void;
  endFallback(choice: 'glass' | 'classic'): void;
}

export const ThemeContext = React.createContext<AppearanceThemeContextValue | null>(null);
export const ControlContext = React.createContext<AppearanceControl | null>(null);
/** The stored choice was read (or the first-paint wait gave up). True outside the provider. */
export const ReadyContext = React.createContext<boolean>(true);

/** For useTheme() only: the Design, Theme, material and scene, or null outside the provider. */
export function useAppearanceTheme(): AppearanceThemeContextValue | null {
  return React.useContext(ThemeContext);
}

/**
 * The root's first-paint gate: only whether the stored choice was read. Its
 * own context, so RootLayout re-renders when this flips once at launch and
 * never when the sync status moves ("Saving...", "Saved to your account").
 */
export function useAppearanceReady(): boolean {
  return React.useContext(ReadyContext);
}

/**
 * The Appearance screen's control, the Settings row, the crash-fallback
 * notice and the intro card. It changes with every sync status, so the root
 * never reads it (useAppearanceReady). Outside the provider (never in the
 * app) it reports a ready classic System that cannot be changed.
 */
export function useAppearance(): AppearanceControl {
  return React.useContext(ControlContext) ?? OUTSIDE_PROVIDER;
}

const noop = () => undefined;
const OUTSIDE_PROVIDER: AppearanceControl = {
  chosenStyle: null,
  chosenTheme: null,
  style: 'classic',
  theme: null,
  rollout: 'off',
  status: 'signed-out',
  ready: true,
  glassEnabled: false,
  fallbackActive: false,
  introVisible: false,
  material: 'opaque',
  chooseStyle: noop,
  chooseTheme: noop,
  keepGlass: noop,
  dismissIntro: noop,
  retry: noop,
  endFallback: noop,
};
