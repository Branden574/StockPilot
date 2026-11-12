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
 * The person's appearance comes from the AppearanceProvider (app/_layout.tsx)
 * as two separate things (revision R1): the Design drawn (Liquid Glass or
 * Classic) and the Theme drawn:
 *   - System, or no Theme, follows the device, exactly as this hook always
 *     did (`userInterfaceStyle: 'automatic'`; light when the device reports
 *     nothing). It is the default, so a phone that never chose a Theme
 *     follows its device as it always has.
 *   - Dark and Light are fixed in both Designs (Night and Day glass), and also
 *     set the OS scheme so alerts and the keyboard match
 *     (appearance/os-scheme.ts). That override is on only while a fixed Theme
 *     is chosen, so for System useColorScheme() below is the device's own.
 * Outside the provider it is classic System, today's behaviour.
 *
 * The returned object is the SAME reference for a given (Design, scheme,
 * material, scene), and `c` is one of the module-level palettes, so memoised
 * rows and style arrays stay stable across renders. Its signature only grew:
 * every existing `{ c, mode }` caller compiles and draws as before.
 */
export function useTheme(): ThemeValue {
  const scheme = useColorScheme();
  const appearance = useAppearanceTheme();
  const mode = resolveScheme(appearance?.theme ?? null, scheme === 'dark');
  return themeValueFor(
    appearance?.style ?? 'classic',
    mode,
    appearance?.material ?? 'opaque',
    appearance?.scene ?? false,
  );
}
