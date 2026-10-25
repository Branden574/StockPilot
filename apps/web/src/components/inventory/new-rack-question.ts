import {
  normalizeRackFields,
  parseNewRackConfirmationDetail,
  type ActionError,
  type NewRackConfirmationDetail,
} from '@stockpilot/core';

import type { PlacementConfirmContent } from './placement-confirm-dialog';

/**
 * "Create new rack 1-B?" on the web create surfaces (2026-10-24).
 *
 * The SERVER asks: a create whose opening stock would land on a rack that does
 * not exist is refused before anything is written (NEW_RACK_REQUIRES_
 * CONFIRMATION, see @stockpilot/core inventory/new-rack-confirmation.ts). The
 * New item form, Add more sizes and Duplicate turn that refusal into the
 * placement dialog, with the server's own title, sentence and near-matches, and
 * send the same save again with the person's answer. So the web says what the
 * phone says (apps/mobile/app/item/new.tsx), and no web path can skip it.
 */

/** The confirm button: the phone's words for the same question. */
export const NEW_RACK_CONFIRM_LABEL = 'Create rack and save';

/** The server's question in a refused save, or null for any other refusal. */
export function newRackQuestion(error: ActionError): NewRackConfirmationDetail | null {
  return parseNewRackConfirmationDetail(error.details);
}

/** The dialog for the question: Go back, "Use 17-B instead", Create rack and save. */
export function newRackConfirmContent(
  question: NewRackConfirmationDetail,
): PlacementConfirmContent {
  return {
    title: question.title,
    message: question.message,
    ...(question.suggestions.length > 0 ? { suggestions: question.suggestions } : {}),
    confirmLabel: NEW_RACK_CONFIRM_LABEL,
  };
}

/**
 * A near-match ("17-B") as the two rack boxes. The suggestion is an existing
 * rack's own label, so the shared decomposer gives back exactly the number and
 * row that label is made of, and the save then names that rack.
 */
export function rackFieldsFromLabel(label: string): { number: string; row: string } {
  const parts = normalizeRackFields({ number: label, row: '' });
  return { number: parts.number, row: (parts.row ?? '').toUpperCase() };
}
