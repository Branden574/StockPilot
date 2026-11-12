import { peekSignedInUser, supabaseAppearanceAccount } from './account';
import { createAppearanceController, type AppearanceController } from './controller';
import { glassRollout } from './flag';
import { appearanceAdoptionHolds } from './holds';
import { asyncStorageAppearance } from './store';

/**
 * The app's one appearance controller, created by the AppearanceProvider on
 * its first render and kept for the life of the JS runtime (a provider that
 * re-rendered or re-mounted gets the same one, so nothing is read twice and no
 * second set of saves can start).
 */
let controller: AppearanceController | null = null;

export function getAppearanceController(): AppearanceController {
  if (controller === null) {
    controller = createAppearanceController({
      storage: asyncStorageAppearance,
      account: supabaseAppearanceAccount,
      now: () => Date.now(),
      rollout: glassRollout(),
      holds: appearanceAdoptionHolds(),
      peekSignedInUser,
    });
  }
  return controller;
}

/**
 * The controller if one exists, never creating it: for the error boundary,
 * which must not start the appearance layer just to report on it.
 */
export function peekAppearanceController(): AppearanceController | null {
  return controller;
}
