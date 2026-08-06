import * as Linking from 'expo-linking';

import type { PreparedMaintenanceEmail } from '@stockpilot/core';

/**
 * Mobile twin of web's `MaintenanceEmailAction` (maintenance-email-
 * action.tsx) — same builder (`prepareMaintenanceEmail`, packages/core),
 * same tenant-verified transport (`outlook-compose.ts`), same honesty
 * posture (open a draft, never claim it sent). The DIFFERENCE is the open
 * mechanism: web uses `window.open`/`window.location.assign` and reads a
 * `Window | null` back to detect a blocked popup; React Native has no popup
 * concept, so this uses `expo-linking`'s `openURL`, which either resolves
 * (a handler accepted the URL) or rejects (no handler, or the OS refused).
 * Every decision this feature needs is a pure function here — nothing about
 * transport selection, the R3 record-after-open ordering, the duplicate-
 * draft gate, or the condensed-notice gate is left to be "proven" only by
 * the screen rendering correctly, because `app/` screens cannot run under
 * this repo's vitest (see maintenance-upload.ts's own doc comment for the
 * same reasoning, and maintenance-api.test.ts's WIRING PINS block for what
 * that leaves un-provable at the screen layer).
 *
 * `expo-linking` (`~7.1.7`) is already a direct dependency of
 * apps/mobile/package.json — confirmed before writing this file — so this
 * introduces zero new native modules (binding constraint 1).
 */

/** Both refuse to open ANYTHING when linkFits is false — silent mail-client
 *  truncation is the failure these guards exist for. The selectable-text
 *  copy panel (screen-side) is the honest transport in that case. */
export async function openOutlookDraft(prepared: PreparedMaintenanceEmail): Promise<'opened' | 'blocked'> {
  if (!prepared.linkFits) return 'blocked';
  try {
    await Linking.openURL(prepared.outlookUrl);
    return 'opened';
  } catch {
    return 'blocked';
  }
}

export async function openMailtoDraft(prepared: PreparedMaintenanceEmail): Promise<'opened' | 'blocked'> {
  if (!prepared.linkFits) return 'blocked';
  try {
    await Linking.openURL(prepared.mailtoUrl);
    return 'opened';
  } catch {
    return 'blocked';
  }
}

export type EmailTransport = 'outlook' | 'mailto';

/**
 * Orchestration seam the detail screen calls into: picks the transport,
 * then — R3, mirroring web's `openDraft()` ordering exactly — invokes
 * `onOpened` ONLY after a real, successful open, and never before or
 * instead of one. `onOpened` is a synchronous callback; the screen uses it
 * to bump its local open-count AND fire the best-effort
 * `recordDraftOpened(id)` REST call (never awaited here — a network delay
 * on that bookkeeping call must never block or gate the screen's own
 * success state, same as web's `void recordMaintenanceDraftOpenedAction(...)
 * .catch(...)` precedent). A blocked/failed open — whether from
 * `linkFits: false` or a rejected `Linking.openURL` — calls `onOpened` zero
 * times, so a failed open is never recorded as one.
 */
export async function openMaintenanceDraft(
  transport: EmailTransport,
  prepared: PreparedMaintenanceEmail,
  onOpened: () => void,
): Promise<'opened' | 'blocked'> {
  const result = transport === 'outlook' ? await openOutlookDraft(prepared) : await openMailtoDraft(prepared);
  if (result === 'opened') onOpened();
  return result;
}

/** Brief section 21: never permanently block reopening, only warn. The
 *  FIRST open (openCount 0) never confirms; every reopen does. */
export function shouldConfirmBeforeOpening(openCount: number): boolean {
  return openCount > 0;
}

/**
 * Gates the "this was shortened" notice. Deliberately requires BOTH
 * `draft.condensed` AND `linkFits` — a condensed draft that STILL doesn't
 * fit is the oversized/blocked state (`OVERSIZED_MESSAGE` below owns that
 * copy, and no link is offered at all), never the condensed notice, which
 * promises the two email buttons are actually usable.
 */
export function shouldShowCondensedNotice(prepared: PreparedMaintenanceEmail): boolean {
  return prepared.draft.condensed && prepared.linkFits;
}

// ── Literal-pinned copy (brief sections 19–21, Task 14 spec line 6) ──────
// Named exports, not inline JSX strings, so the wording can be assigned
// ONE canonical source both the screen and this test file read from —
// mirrors web's own SUCCESS_MESSAGE/DUPLICATE_WARNING/BLOCKED_HEADLINE
// constants (maintenance-email-action.tsx) rather than re-typing the copy.

/** Task 14 spec line 6, verbatim. Shown only after a REAL, successful
 *  open — never speculatively, never on a blocked/failed attempt. */
export const SUCCESS_MESSAGE =
  'Outlook opened with your maintenance request. Review the information, attach any downloaded photos you want included directly, and click Send.';

/** Brief section 21, verbatim. */
export const DUPLICATE_WARNING =
  'A maintenance email draft was already opened for this request. Sending multiple copies may create duplicate Zendesk tickets.';

/** Brief section 19, verbatim — the ONLY headline for a blocked open. Never
 *  blame link length for an actual failed/refused open. */
export const BLOCKED_HEADLINE = 'Outlook could not be opened automatically.';

/** Shown when `!prepared.linkFits` — even the condensed pair is too long.
 *  The selectable copy box always carries the complete, uncondensed body,
 *  so it is the one honest transport left; neither email button is offered
 *  alongside this message. */
export const OVERSIZED_MESSAGE =
  'This request is too long for an email link, even shortened. Use Copy Email Details below — it always includes the full text.';

/** Shown when `shouldShowCondensedNotice` is true. */
export const CONDENSED_NOTICE =
  'This email will open with a shortened summary — the full request was too long for a compose link. The complete details are saved in this request, and Copy Email Details always includes everything.';

/** Helper line under the selectable-text copy fallback (audit Q9: no
 *  clipboard module in the binary, so there is no programmatic copy step
 *  to attempt first — this IS the copy affordance, not a failure fallback
 *  for one). */
export const COPY_HELPER_TEXT = 'Press and hold inside the box to select and copy.';
