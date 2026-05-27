import { useColorScheme } from 'react-native';

import { palette, type ThemeMode } from './theme';

/**
 * Returns the current theme mode + its color palette. Defaults to
 * light (the brand's primary mode); dark mirror follows system theme.
 * Settings will later expose a user override that wins over the
 * system value — wired through here so every primitive picks it up
 * without prop drilling.
 */
export function useTheme(): { mode: ThemeMode; c: ReturnType<typeof palette> } {
  const scheme = useColorScheme();
  const mode: ThemeMode = scheme === 'dark' ? 'dark' : 'light';
  return { mode, c: palette(mode) };
}
