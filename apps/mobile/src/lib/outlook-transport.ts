import * as Linking from 'expo-linking';

import { OUTLOOK_MOBILE_COMPOSE_BASE } from '@stockpilot/core';

/**
 * ONE Outlook transport decision for every mobile compose feature.
 *
 * EXTRACTED 2026-08-13 from `maintenance-email-actions.ts`, unchanged, when the
 * order screen gained a delivery request. Both features have the same shape of
 * problem — a prepared draft with a MANDATORY CC, three possible transports,
 * and an OS that may or may not have the native Outlook app — and the obvious
 * move (copy `planOutlookOpen` into a second file and retype it against a
 * second prepared shape) is recurring pattern #26: a fix applied to one copy of
 * a duplicated function is not a fix. The specific fix that would have been
 * lost is the one this module exists for — if a platform's native Outlook were
 * ever found to drop `cc=`, flipping `NATIVE_OUTLOOK_CC_TRUSTED` has to
 * reroute BOTH features, not whichever one someone remembered.
 *
 * So the planner is generic over WHAT was prepared. It reads only the three
 * URLs and the fits flag (`OutlookTransportUrls`), never the draft body, so
 * maintenance's `PreparedMaintenanceEmail` and orders'
 * `PreparedDeliveryRequest` both satisfy it structurally with no adapter and
 * no shared base type in core.
 */

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
 * The structural contract the planner needs: three composed transports of ONE
 * chosen draft, plus whether that draft is short enough to ride a URL at all.
 *
 * Deliberately NOT `draft`-aware. A planner that could read the body would
 * invite per-feature branching on message content, which is how the two
 * features would drift apart again. Both core prepared shapes
 * (`PreparedMaintenanceEmail`, `PreparedDeliveryRequest`) are supersets of
 * this and satisfy it structurally.
 *
 * INVARIANT: every one of the three URLs carries the mandatory CC. Core's
 * builders are what guarantee that; the tests here re-assert it at the actual
 * `openURL` call site for both features, because a composer that is right and
 * a call site that hands the OS a different string is still a dropped CC.
 */
export interface OutlookTransportUrls {
  /** OWA WEB compose deep link (https). Tenant-verified; the fallback when the
   *  native app is absent. */
  outlookUrl: string;
  /** NATIVE Outlook app deep link (`ms-outlook://compose`). */
  outlookMobileUrl: string;
  /** RFC 6068 `mailto:`, which carries cc as a plain parameter. */
  mailtoUrl: string;
  /** False means NEITHER link may be opened (silent truncation). */
  linkFits: boolean;
}

/**
 * Per-platform verdict on whether the NATIVE Outlook deep link is trusted to
 * carry `cc=`.
 *
 * Both features' whole point is that a fixed CC address receives a copy; if a
 * platform's Outlook build were ever found to drop the cc parameter, the
 * correct response is to stop using the Outlook brand on that platform and
 * send the employee to `mailto:` instead — the business invariant beats the
 * brand. Flipping an entry here is that entire remediation, now for BOTH the
 * maintenance and delivery flows at once: `planOutlookOpen` reroutes, the copy
 * follows, no redesign.
 *
 * Both currently true. Neither has been confirmed on a physical device by this
 * codebase — the simulator has no Outlook to install, and warm/cold start
 * behaviour is a property of Microsoft's shipping app, not of our code.
 * Owner-owned device verification is what can retire that caveat.
 */
export const NATIVE_OUTLOOK_CC_TRUSTED: Record<OutlookPlatform, boolean> = {
  ios: true,
  android: true,
};

/**
 * Pure transport decision for a tap on an "Open in Outlook"-style button.
 *
 *  - native app present, platform trusted -> `ms-outlook://compose` (THE FIX:
 *    an https URL here is handed to the browser, which is why the employee
 *    kept landing in Safari on Outlook Web).
 *  - native app absent -> the EXISTING, tenant-verified web compose URL. Not
 *    `mailto:` — falling through to a different mailbox would quietly change
 *    which account the message comes from.
 *  - native app present but its cc handling is not trusted on this platform
 *    -> `mailto:`, which carries the cc as a plain RFC 6068 parameter.
 *
 * Every branch returns a URL that carries the CC. That is the invariant, and
 * it is asserted per-branch, per-feature, in the tests.
 */
export function planOutlookOpen(
  prepared: OutlookTransportUrls,
  ctx: { nativeOutlookAvailable: boolean; platform: OutlookPlatform },
  ccTrusted: Record<OutlookPlatform, boolean> = NATIVE_OUTLOOK_CC_TRUSTED,
): OutlookOpenPlan {
  if (!ctx.nativeOutlookAvailable) return { transport: 'outlook-web', url: prepared.outlookUrl };
  if (!ccTrusted[ctx.platform]) return { transport: 'default-mail', url: prepared.mailtoUrl };
  return { transport: 'outlook-native', url: prepared.outlookMobileUrl };
}

export function mailtoPlan(prepared: OutlookTransportUrls): OutlookOpenPlan {
  return { transport: 'default-mail', url: prepared.mailtoUrl };
}

/**
 * Is the native Outlook app installed and reachable?
 *
 * `canOpenURL` only answers truthfully when the scheme is declared natively —
 * iOS `LSApplicationQueriesSchemes`, Android `<queries>` (both added in
 * app.config.ts / plugins/with-android-outlook-queries.js, and pinned as data
 * by app-config.native-contract.test.ts). It is a PROBE: it opens nothing, so
 * asking it costs no compose screen. Any throw (undeclared scheme, OS refusal)
 * is read as "not installed" and the caller falls back to the web URL — a
 * probe failure must never be an error the employee sees.
 */
export async function nativeOutlookAvailable(): Promise<boolean> {
  try {
    return await Linking.canOpenURL(OUTLOOK_MOBILE_COMPOSE_BASE);
  } catch {
    return false;
  }
}

/**
 * The ONLY place this codebase calls openURL for a compose link. Exactly one
 * invocation per tap: a rejected open is reported as blocked and nothing else
 * is attempted, ever. Auto-retrying (or cascading to a second transport on
 * failure) is what produced duplicate compose screens — and a duplicate
 * compose screen is a duplicate ticket, or a duplicate delivery request to
 * DC4. Re-opening is a decision only the employee makes, by pressing the
 * button again.
 *
 * NEVER log `plan.url`: across both features it carries requester name, email,
 * phone, site, the full description or the full item list, and any share URL.
 * Record id + platform + `transport` are the only safe things to report
 * anywhere, including Sentry.
 */
export async function runPlan(plan: OutlookOpenPlan): Promise<'opened' | 'blocked'> {
  try {
    await Linking.openURL(plan.url);
    return 'opened';
  } catch {
    return 'blocked';
  }
}

/**
 * Never permanently block reopening, only warn. The FIRST open (openCount 0)
 * never confirms; every reopen does.
 *
 * Shared by both features because the reasoning is identical: nothing here can
 * observe a send, so a repeat is warned about rather than blocked — blocking
 * would strand someone whose first draft was closed by accident, which is the
 * commoner case, while a duplicate is the noisier one and gets a visible
 * warning. What a duplicate COSTS differs per feature (a duplicate Zendesk
 * ticket; a duplicate delivery request to DC4), so the warning TEXT stays
 * per-feature — only this predicate is shared.
 */
export function shouldConfirmBeforeOpening(openCount: number): boolean {
  return openCount > 0;
}
