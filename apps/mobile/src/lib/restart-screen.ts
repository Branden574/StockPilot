import type { ReloadScreenOptions } from 'expo-updates';

/**
 * How Restart now looks (B44). expo-updates shows its own screen while it
 * restarts the app: white, with a blue spinner, unless reloadAsync is told
 * otherwise. This makes it the launch screen instead (app.config.ts,
 * expo-splash-screen: the icon contained on '#0a0f1f'), faded out when the new
 * version's first screen is up, so a restart looks like the app opening.
 *
 * The one require() of the icon lives here, alone: node cannot load a PNG, so
 * the tests replace this module (use-ota-updates.test.ts).
 */
export const LAUNCH_ICON: number = require('../../assets/icon.png');

export const RESTART_SCREEN = {
  backgroundColor: '#0a0f1f',
  image: LAUNCH_ICON,
  imageResizeMode: 'contain',
  imageFullScreen: false,
  spinner: { enabled: false },
  fade: true,
} as const satisfies ReloadScreenOptions;
