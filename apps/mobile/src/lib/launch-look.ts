import { palette } from './theme';

/**
 * Which launch screen the installed app binary has.
 *
 * The launch screen is native (app.config.ts, the expo-splash-screen entry):
 * it is fixed when the binary is built and changes only with a store build.
 * This JavaScript also reaches older binaries through phone updates. The screen
 * drawn while the app restarts into a phone update (restart-screen.ts) copies
 * the launch screen of the binary it runs on, so a restart looks like the app
 * opening on every installed version.
 *
 * - 'icon': binaries up to and including runtime LAST_ICON_LAUNCH_RUNTIME
 *   launch with the app icon contained on ICON_LAUNCH_GROUND.
 * - 'ground': every later binary launches on a plain PLAIN_LAUNCH_GROUND with
 *   nothing drawn on it, the loading animation's own ground.
 */
export type LaunchLook = 'icon' | 'ground';

/** The newest runtime version whose launch screen is the icon. */
export const LAST_ICON_LAUNCH_RUNTIME = '1.4.0';

/** The icon launch screen's ground. */
export const ICON_LAUNCH_GROUND = '#0a0f1f';

/** The plain launch screen's ground: the loading animation's ground. */
export const PLAIN_LAUNCH_GROUND = palette('dark').paper;

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * The launch look of a binary from its runtime version (expo-updates
 * `runtimeVersion`, read from the binary's own native config).
 *
 * A missing value means expo-updates is not running in this binary (it reports
 * '' then, as in a development build). A value that is not three dot-separated
 * numbers is not one a store build of this app reports. Both are treated as
 * 'ground': an unknown binary was built from the current config, and that
 * config has the plain launch screen.
 */
export function launchLookFor(runtimeVersion: string | null | undefined): LaunchLook {
  const found = VERSION.exec(runtimeVersion ?? '');
  const last = VERSION.exec(LAST_ICON_LAUNCH_RUNTIME);
  if (!found || !last) return 'ground';
  for (let i = 1; i <= 3; i++) {
    const a = Number(found[i]);
    const b = Number(last[i]);
    if (a !== b) return a < b ? 'icon' : 'ground';
  }
  return 'icon';
}
