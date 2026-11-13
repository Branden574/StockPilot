import type { ThemeSetting } from '@stockpilot/core';
import { Appearance } from 'react-native';

/**
 * What the OS draws for the app (Alert.alert dialogs, the keyboard, pickers,
 * context menus) follows the window's interface style, not our palette. A
 * fixed Light or Dark Theme therefore tells the OS the app's scheme
 * (Appearance.setColorScheme sets overrideUserInterfaceStyle on the app's
 * windows on iOS; AppCompatDelegate night mode on Android), so a dark app over
 * a light device never shows a light alert or keyboard. This holds in both
 * Designs (revision R9, item 34): Night glass gets dark alerts and keyboards.
 *
 * System, or no Theme (never chosen, or the 'off' rollout), leaves the OS
 * following the device ('unspecified'), which is also what useColorScheme()
 * reports to useTheme() then: the override is only ever on while a fixed
 * Theme is chosen, which ignores the device scheme anyway. Leaving a fixed
 * Theme clears it, and the device's own scheme arrives through RN's
 * appearanceChanged event when the windows' traits change back.
 *
 * The OS is called only on a change. Nothing has been overridden at launch, so
 * System never calls it at all: the phone behaves exactly as it did before
 * there was a choice.
 */
export type OsColorScheme = 'light' | 'dark' | 'unspecified';

export function osSchemeFor(theme: ThemeSetting | null): OsColorScheme {
  return theme === 'dark' || theme === 'light' ? theme : 'unspecified';
}

let applied: OsColorScheme = 'unspecified';

/** Tell the OS the scheme for the Theme drawn (the provider's, null under 'off'). */
export function applyOsScheme(theme: ThemeSetting | null): void {
  const next = osSchemeFor(theme);
  if (next === applied) return;
  applied = next;
  try {
    Appearance.setColorScheme(next);
  } catch {
    // No native Appearance module (a test runtime): the palette still changes;
    // only the OS-drawn UI keeps the device scheme.
  }
}
