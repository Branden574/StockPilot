import * as Linking from 'expo-linking';

import { OUTLOOK_MOBILE_COMPOSE_BASE, type PreparedMaintenanceEmail } from '@stockpilot/core';

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

/** Only what this decision actually depends on. Passed in (never read from
 *  react-native here) so the whole decision stays a pure, node-testable
 *  function — `Platform.OS` is read once, at the screen. */
export type OutlookPlatform = 'ios' | 'android';

/** What ACTUALLY opened. The screen's success copy is chosen from this, so it
 *  can never say "Outlook opened" about a mail app that isn't Outlook. */
export type OpenedTransport = 'outlook-native' | 'outlook-web' | 'default-mail';

export interface OutlookOpenPlan {
  transport: OpenedTransport;
  url: string;
}

/**
 * Per-platform verdict on whether the NATIVE Outlook deep link is trusted to
 * carry `cc=`.
 *
 * The maintenance workflow's whole point is that a fixed CC address receives
 * a copy; if a platform's Outlook build were ever found to drop the cc
 * parameter, the correct response is to stop using the Outlook brand on that
 * platform and send the employee to `mailto:` instead — the business
 * invariant beats the brand. Flipping an entry here is that entire
 * remediation: `planOutlookOpen` reroutes, the copy follows, no redesign.
 *
 * Both currently true. Neither has been confirmed on a physical device by
 * this codebase — the simulator has no Outlook to install, and warm/cold
 * start behaviour is a property of Microsoft's shipping app, not of our code.
 * Owner-owned device verification is what can retire that caveat.
 */
export const NATIVE_OUTLOOK_CC_TRUSTED: Record<OutlookPlatform, boolean> = {
  ios: true,
  android: true,
};

/**
 * Pure transport decision for a tap on "Open in Outlook".
 *
 *  - native app present, platform trusted -> `ms-outlook://compose` (THE FIX:
 *    an https URL here is handed to the browser, which is why the employee
 *    kept landing in Safari on Outlook Web).
 *  - native app absent -> the EXISTING, tenant-verified web compose URL. Not
 *    `mailto:` — falling through to a different mailbox would quietly change
 *    which account the ticket comes from. This is exactly today's behaviour.
 *  - native app present but its cc handling is not trusted on this platform
 *    -> `mailto:`, which carries the cc as a plain RFC 6068 parameter.
 *
 * Every branch returns a URL that carries the CC. That is the invariant, and
 * it is asserted per-branch in the tests.
 */
export function planOutlookOpen(
  prepared: PreparedMaintenanceEmail,
  ctx: { nativeOutlookAvailable: boolean; platform: OutlookPlatform },
  ccTrusted: Record<OutlookPlatform, boolean> = NATIVE_OUTLOOK_CC_TRUSTED,
): OutlookOpenPlan {
  if (!ctx.nativeOutlookAvailable) return { transport: 'outlook-web', url: prepared.outlookUrl };
  if (!ccTrusted[ctx.platform]) return { transport: 'default-mail', url: prepared.mailtoUrl };
  return { transport: 'outlook-native', url: prepared.outlookMobileUrl };
}

/**
 * Is the native Outlook app installed and reachable?
 *
 * `canOpenURL` only answers truthfully when the scheme is declared natively —
 * iOS `LSApplicationQueriesSchemes`, Android `<queries>` (both added in
 * app.config.ts / plugins/with-android-outlook-queries.js). It is a PROBE: it
 * opens nothing, so asking it costs no compose screen. Any throw (undeclared
 * scheme, OS refusal) is read as "not installed" and the caller falls back to
 * the web URL — a probe failure must never be an error the employee sees.
 */
async function nativeOutlookAvailable(): Promise<boolean> {
  try {
    return await Linking.canOpenURL(OUTLOOK_MOBILE_COMPOSE_BASE);
  } catch {
    return false;
  }
}

/**
 * The ONLY place this module calls openURL. Exactly one invocation per tap:
 * a rejected open is reported as blocked and nothing else is attempted, ever.
 * Auto-retrying (or cascading to a second transport on failure) is what
 * produced duplicate compose screens — and a duplicate compose screen is a
 * duplicate Zendesk ticket. Re-opening is a decision only the employee makes,
 * by pressing the button again.
 *
 * NEVER log `plan.url`: it carries requester name, email, phone, site, the
 * full description and any share URL. Request id + platform + `transport` are
 * the only safe things to report anywhere, including Sentry.
 */
async function runPlan(plan: OutlookOpenPlan): Promise<'opened' | 'blocked'> {
  try {
    await Linking.openURL(plan.url);
    return 'opened';
  } catch {
    return 'blocked';
  }
}

function mailtoPlan(prepared: PreparedMaintenanceEmail): OutlookOpenPlan {
  return { transport: 'default-mail', url: prepared.mailtoUrl };
}

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
