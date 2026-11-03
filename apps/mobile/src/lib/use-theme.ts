import { resolveScheme } from '@stockpilot/core';
import { useColorScheme } from 'react-native';

import { useAppearanceTheme } from './appearance/context';
import { themeValueFor, type ThemeValue } from './appearance/theme-value';

export type { ThemeValue } from './appearance/theme-value';

/**
 * The current theme: the colour scheme (`mode`, 'light' | 'dark') and its
 * palette (`c`), plus the appearance fields Liquid Glass adds (style,
 * material, glass tokens, faces and type scale; appearance/theme-value.ts).
 *
 * The person's appearance comes from the AppearanceProvider (app/_layout.tsx):
 *   - System follows the device, exactly as this hook always did
 *     (`userInterfaceStyle: 'automatic'`; light when the device reports
 *     nothing). It is the default, so an install that never chose anything
 *     looks as it always has.
 *   - Dark and Light are fixed, and also set the OS scheme so alerts and the
 *     keyboard match (appearance/os-scheme.ts). That override is on only
 *     while a fixed scheme is chosen, so for System and Liquid Glass
 *     useColorScheme() below is the device's own scheme.
 *   - Liquid Glass follows the device for Day or Night glass (plan D3).
 * Outside the provider it is classic System, today's behaviour.
 *
 * The returned object is the SAME reference for a given (appearance, scheme,
 * material), and `c` is one of the module-level palettes, so memoised rows and
 * style arrays stay stable across renders. Its signature only grew: every
 * existing `{ c, mode }` caller compiles and draws as before.
 */
export function useTheme(): ThemeValue {
  const scheme = useColorScheme();
  const appearance = useAppearanceTheme();
  const chosen = appearance?.appearance ?? 'system';
  const mode = resolveScheme(chosen, scheme === 'dark');
  return themeValueFor(chosen, mode, appearance?.material ?? 'opaque');
}
