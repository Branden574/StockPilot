import { type PreparedMaintenanceEmail } from '@stockpilot/core';

// `OpenedTransport` and `OutlookPlatform` are IMPORTED as well as re-exported
// below: a bare `export { type X } from './y'` forwards the name to this
// module's consumers without binding it in local scope, and both are used in
// this file's own signatures (`MaintenanceOpenResult.used`, every `platform`
// parameter).
import {
  mailtoPlan,
  nativeOutlookAvailable,
  planOutlookOpen,
  runPlan,
  type OpenedTransport,
  type OutlookPlatform,
} from './outlook-transport';

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

/** Which BUTTON the employee pressed. Not the same thing as the transport
 *  that ends up carrying the draft — see `OpenedTransport`. */
export type EmailTransport = 'outlook' | 'mailto';

/**
 * The transport decision itself now lives in `./outlook-transport`, shared
 * with the order screen's delivery request (extracted 2026-08-13, unchanged).
 * Re-exported here so this module's public surface — and every existing
 * import of it, including this file's own test — is byte-for-byte what it was.
 *
 * `planOutlookOpen` is generic over the prepared shape; `PreparedMaintenanceEmail`
 * satisfies its `OutlookTransportUrls` contract structurally, so the calls
 * below are unchanged and still type-check against the maintenance draft.
 */
export {
  NATIVE_OUTLOOK_CC_TRUSTED,
  planOutlookOpen,
  type OpenedTransport,
  type OutlookOpenPlan,
  type OutlookPlatform,
} from './outlook-transport';

/** Both refuse to open ANYTHING when linkFits is false — silent mail-client
 *  truncation is the failure these guards exist for. The selectable-text
 *  copy panel (screen-side) is the honest transport in that case. */
export async function openOutlookDraft(
  prepared: PreparedMaintenanceEmail,
  platform: OutlookPlatform,
): Promise<'opened' | 'blocked'> {
  if (!prepared.linkFits) return 'blocked';
  const plan = planOutlookOpen(prepared, {
    nativeOutlookAvailable: await nativeOutlookAvailable(),
    platform,
  });
  return runPlan(plan);
}

export async function openMailtoDraft(prepared: PreparedMaintenanceEmail): Promise<'opened' | 'blocked'> {
  if (!prepared.linkFits) return 'blocked';
  return runPlan(mailtoPlan(prepared));
}

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
  platform: OutlookPlatform,
  onOpened: () => void,
): Promise<MaintenanceOpenResult> {
  if (!prepared.linkFits) return { outcome: 'blocked', used: null };
  const plan =
    transport === 'outlook'
      ? planOutlookOpen(prepared, {
          nativeOutlookAvailable: await nativeOutlookAvailable(),
          platform,
        })
      : mailtoPlan(prepared);
  const outcome = await runPlan(plan);
  if (outcome === 'opened') onOpened();
  return { outcome, used: outcome === 'opened' ? plan.transport : null };
}

/** `used` is the transport that actually carried the draft, and is null for
 *  anything that did not open — so no caller can report a blocked attempt as
 *  a particular app having opened. */
export interface MaintenanceOpenResult {
  outcome: 'opened' | 'blocked';
  used: OpenedTransport | null;
}

/** Brief section 21: never permanently block reopening, only warn. Shared with
 *  the order screen's delivery request — see `./outlook-transport`. */
export { shouldConfirmBeforeOpening } from './outlook-transport';

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

/**
 * The same promise as SUCCESS_MESSAGE for the case where the draft opened in
 * the device's default mail app rather than Outlook — the `mailto:` button,
 * and the cc-safety fallback in `planOutlookOpen`. Naming Outlook there would
 * be a plain untruth, and this screen's honesty rule (open a draft, never
 * claim it sent, never claim a ticket exists) covers WHICH app opened too.
 */
export const MAIL_APP_SUCCESS_MESSAGE =
  'Your email app opened with your maintenance request. Review the information, attach any downloaded photos you want included directly, and click Send.';

/** Picks the honest confirmation for the transport that actually ran. A null
 *  transport (nothing opened) never reaches the success card; it falls back
 *  to the Outlook wording only so the type is total. */
export function successMessageFor(used: OpenedTransport | null): string {
  return used === 'default-mail' ? MAIL_APP_SUCCESS_MESSAGE : SUCCESS_MESSAGE;
}

/** Brief section 21, verbatim. */
export const DUPLICATE_WARNING =
  'A maintenance email draft was already opened for this request. Sending multiple copies may create duplicate Zendesk tickets.';

/** Brief section 19, verbatim — the ONLY headline for a blocked open. Never
 *  blame link length for an actual failed/refused open. */
export const BLOCKED_HEADLINE = 'Outlook could not be opened automatically.';

/**
 * Sub-line shown under BLOCKED_HEADLINE (fast-follow fix, 2026-08-06). This
 * used to be an inline literal in app/maintenance/[id].tsx that said "...or
 * use Copy Email Details below" — wrong on this screen, where the Copy
 * Email Details button renders ABOVE the blocked-state card, not below it
 * (unlike web's equivalent, maintenance-email-action.tsx, where the retry
 * button genuinely IS below its own copy of this message — that's why the
 * two platforms' wording differs on purpose, not by drift). Deliberately
 * DIRECTION-FREE so a future layout reorder can't silently make this wrong
 * again the way "below" did.
 */
export const BLOCKED_RETRY_MESSAGE = 'Your request is saved — try again, or use Copy Email Details instead.';

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

// ── Share link (mig 0330: hashed at rest → show-once) ────────────────────

/**
 * Folds a share URL generated THIS session into the email input the compose
 * builder sees. Mig 0330 hashes share tokens at rest, so the detail GET can
 * never carry `shareUrl` anymore (it is always null there); the ONLY source
 * of a URL is `issueMaintenanceShareLink`'s response, held in screen state.
 * Pure and null-transparent so the screen's `prepared` memo stays a
 * deterministic function of its inputs: with no generated URL the input
 * passes through untouched — the same body the builder already produces
 * for orgs with share links disabled.
 */
export function withShareUrl<T extends { shareUrl: string | null }>(
  emailInput: T,
  generatedUrl: string | null,
): T {
  return generatedUrl ? { ...emailInput, shareUrl: generatedUrl } : emailInput;
}

/** Shown above the selectable share-URL box right after generating. The
 *  "only this once" claim is literal: the token is hashed at rest, so the
 *  URL is unrecoverable after this screen state is gone. */
export const SHARE_LINK_SHOW_ONCE_NOTICE =
  'Link generated — copy or share it now. For security it is shown only this once; generating again replaces it.';

/** Shown when the server reports an active link whose URL this device does
 *  not hold (generated elsewhere, or before an app restart). */
export const SHARE_LINK_EXISTS_NOTICE =
  'An active share link exists, but its URL cannot be shown again. Generate a new link to get one — the current link stops working.';
