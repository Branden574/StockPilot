import { useColorScheme } from 'react-native';

import { palette, type ThemeMode } from './theme';

/**
 * Returns the current theme mode + its color palette. The mode follows the
 * device appearance only (`userInterfaceStyle: 'automatic'`); there is no
 * in-app override, and Settings > Theme says so. Light when the system
 * reports nothing. The palette object is the same reference for a given
 * mode, so memoised rows and style arrays stay stable across renders.
 */
export function useTheme(): { mode: ThemeMode; c: ReturnType<typeof palette> } {
  const scheme = useColorScheme();
  const mode: ThemeMode = scheme === 'dark' ? 'dark' : 'light';
  return { mode, c: palette(mode) };
}
