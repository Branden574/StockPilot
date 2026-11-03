import type { AppearanceMode } from '@stockpilot/core';
import { Appearance } from 'react-native';

/**
 * What the OS draws for the app (Alert.alert dialogs, the keyboard, pickers,
 * context menus) follows the window's interface style, not our palette. A
 * fixed Dark or Light therefore tells the OS the app's scheme
 * (Appearance.setColorScheme sets overrideUserInterfaceStyle on the app's
 * windows on iOS; AppCompatDelegate night mode on Android), so a dark app over
 * a light device never shows a light alert or keyboard.
 *
 * System and Liquid Glass leave the OS following the device ('unspecified'),
 * which is also what useColorScheme() reports to useTheme() then: the override
 * is only ever on while the choice is a fixed scheme, which ignores the device
 * scheme anyway. Leaving a fixed choice clears it, and the device's own scheme
 * arrives through RN's appearanceChanged event when the windows' traits change
 * back.
 *
 * The OS is called only on a change. Nothing has been overridden at launch, so
 * classic System (and Liquid Glass) never call it at all: the phone behaves
 * exactly as it did before there was a choice.
 */
export type OsColorScheme = 'light' | 'dark' | 'unspecified';

export function osSchemeFor(appearance: AppearanceMode): OsColorScheme {
  return appearance === 'dark' || appearance === 'light' ? appearance : 'unspecified';
}

let applied: OsColorScheme = 'unspecified';

/** Tell the OS the scheme for this appearance (the one drawn: after the kill switch and crash fallback). */
export function applyOsScheme(appearance: AppearanceMode): void {
  const next = osSchemeFor(appearance);
  if (next === applied) return;
  applied = next;
  try {
    Appearance.setColorScheme(next);
  } catch {
    // No native Appearance module (a test runtime): the palette still changes;
    // only the OS-drawn UI keeps the device scheme.
  }
}
