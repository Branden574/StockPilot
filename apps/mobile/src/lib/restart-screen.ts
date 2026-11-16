import * as Updates from 'expo-updates';
import type { ReloadScreenOptions } from 'expo-updates';

import { ICON_LAUNCH_GROUND, PLAIN_LAUNCH_GROUND, launchLookFor } from './launch-look';

/**
 * How Restart now looks. expo-updates shows its own screen while it restarts
 * the app: white, with a blue spinner, unless reloadAsync is told otherwise.
 * This makes it the launch screen of the installed binary instead, faded out
 * when the new version's first screen is up, so a restart looks like the app
 * opening. The cover update-prompt-host.tsx draws just before the restart uses
 * the same look.
 *
 * - On a binary with the icon launch screen: the icon contained on
 *   ICON_LAUNCH_GROUND.
 * - On a binary with the plain launch screen: PLAIN_LAUNCH_GROUND, nothing on it.
 *
 * The one require() of the icon lives here, alone: node cannot load a PNG, so
 * the tests replace this module (use-ota-updates.test.ts).
 */
export const LAUNCH_ICON: number = require('../../assets/icon.png');

/** This binary's launch look. The runtime version is native, fixed for the install. */
export const LAUNCH_LOOK = launchLookFor(Updates.runtimeVersion);

const ICON_RESTART_SCREEN = {
  backgroundColor: ICON_LAUNCH_GROUND,
  image: LAUNCH_ICON,
  imageResizeMode: 'contain',
  imageFullScreen: false,
  spinner: { enabled: false },
  fade: true,
} as const satisfies ReloadScreenOptions;

const GROUND_RESTART_SCREEN = {
  backgroundColor: PLAIN_LAUNCH_GROUND,
  spinner: { enabled: false },
  fade: true,
} as const satisfies ReloadScreenOptions;

export const RESTART_SCREEN: ReloadScreenOptions =
  LAUNCH_LOOK === 'icon' ? ICON_RESTART_SCREEN : GROUND_RESTART_SCREEN;

/** The cover's ground: the restart screen's. */
export const RESTART_GROUND: string =
  LAUNCH_LOOK === 'icon' ? ICON_LAUNCH_GROUND : PLAIN_LAUNCH_GROUND;

/** Whether the cover draws the icon: only where the launch screen does. */
export const RESTART_SHOWS_ICON: boolean = LAUNCH_LOOK === 'icon';
