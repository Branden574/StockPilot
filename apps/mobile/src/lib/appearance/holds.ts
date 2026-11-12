import { isUpdatePromptHeld, subscribeUpdatePromptHolds } from '../update-prompt-holds';
import {
  combineHolds,
  isAppearanceAdoptionHeld,
  subscribeAppearanceAdoptionHolds,
} from './adoption-holds';
import type { AdoptionHolds } from './controller';

/**
 * What the app's appearance controller waits for before it draws a Design
 * adopted from the account (item 32): every hold of the phone update pop-up
 * (B44: open sheets, alerts, photo and file flows, unsaved drafts, writes in
 * flight; update-prompt-holds.ts, read only) and the appearance-only holds of
 * the Scan tab and the count entry screens (adoption-holds.ts).
 */
export function appearanceAdoptionHolds(): AdoptionHolds {
  return combineHolds(
    { isHeld: isUpdatePromptHeld, subscribe: subscribeUpdatePromptHolds },
    { isHeld: isAppearanceAdoptionHeld, subscribe: subscribeAppearanceAdoptionHolds },
  );
}
