import type { AppearanceMode, AppearanceSyncStatus, ClassicAppearanceMode } from '@stockpilot/core';
import * as React from 'react';

import type { GlassMaterial } from './material';

/**
 * The appearance contexts and their hooks, apart from the provider so that
 * useTheme() (imported by 157 files) depends on nothing but React and these
 * types: not on the controller, storage or the Supabase client.
 */

export interface AppearanceThemeContextValue {
  /** The appearance to draw (after the kill switch and the crash fallback). */
  appearance: AppearanceMode;
  material: GlassMaterial;
}

export interface AppearanceControl {
  /** The person's stored choice (may be Liquid Glass while the fallback shows classic). */
  choice: AppearanceMode;
  /** What is drawn right now. */
  effective: AppearanceMode;
  lastClassic: ClassicAppearanceMode;
  status: AppearanceSyncStatus;
  ready: boolean;
  glassEnabled: boolean;
  fallbackActive: boolean;
  material: GlassMaterial;
  choose(mode: AppearanceMode): void;
  retry(): void;
  endFallback(choice: 'glass' | 'classic'): void;
}

export const ThemeContext = React.createContext<AppearanceThemeContextValue | null>(null);
export const ControlContext = React.createContext<AppearanceControl | null>(null);
/** The stored choice was read (or the first-paint wait gave up). True outside the provider. */
export const ReadyContext = React.createContext<boolean>(true);

/** For useTheme() only: the appearance and material, or null outside the provider. */
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
 * The Appearance screen's control and the crash-fallback notice. It changes
 * with every sync status, so the root never reads it (useAppearanceReady).
 * Outside the provider (never in the app) it reports a ready classic System
 * that cannot be changed.
 */
export function useAppearance(): AppearanceControl {
  return React.useContext(ControlContext) ?? OUTSIDE_PROVIDER;
}

const noop = () => undefined;
const OUTSIDE_PROVIDER: AppearanceControl = {
  choice: 'system',
  effective: 'system',
  lastClassic: 'system',
  status: 'signed-out',
  ready: true,
  glassEnabled: false,
  fallbackActive: false,
  material: 'opaque',
  choose: noop,
  retry: noop,
  endFallback: noop,
};
