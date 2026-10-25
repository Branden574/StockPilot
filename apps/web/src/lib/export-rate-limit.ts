import 'server-only';

import { NextResponse } from 'next/server';

import { bearerTokenFrom, sentFromAnotherOrigin } from '@/lib/auth/cross-site-request';
import { createAdminClient } from '@/lib/supabase/admin';
import { reportError } from '@/lib/error-reporter';
import { dispatchEvent } from '@/server/services/integration-events';

import { checkRateLimit } from './rate-limit';

/** Exports are never cached anywhere, answers or refusals. */
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * The words for an export another origin's page asked for. The app's own
 * links never get it; a person who opens a copied link from another website
 * (webmail, a chat app in the browser) does, and starts it again from the app.
 */
export const CROSS_SITE_EXPORT_MESSAGE =
  "Start this download from StockPilot. A link on another website can't start it.";

/** One line per refused export: where it was going and what the browser said, never the query string, a cookie or who. */
function logRefusedExport(req: Request): void {
  let path = '(unreadable)';
  try {
    path = new URL(req.url).pathname;
  } catch {
    // Keep the placeholder.
  }
  const header = (name: string) => req.headers.get(name)?.slice(0, 32) ?? null;
  console.warn("[export] refused an export another origin's page asked for", {
    path,
    secFetchSite: header('sec-fetch-site'),
    secFetchMode: header('sec-fetch-mode'),
    secFetchDest: header('sec-fetch-dest'),
  });
}

/**
 * Shared throttle for expensive PDF/CSV export endpoints. One per-user budget
 * across ALL exports (40/hour, fail-CLOSED), so an authenticated user — or a
 * hijacked session — can't spam react-pdf rendering / large CSV generation to
 * exhaust serverless compute (DoS + cost). Security audit 2026-06-09.
 *
 * Usage in a route handler: AFTER the caller's session, permission and request
 * checks, BEFORE the data (see app/api/export-routes.limit-order.test.ts):
 *   if (!ctx) return 401;
 *   if (!can(ctx, '<the export permission>')) return 403;
 *   // ...validate the request (400)...
 *   const limited = await exportRateLimited(req, ctx.userId, ctx.organizationId);
 *   if (limited) return limited;
 * Never run it before the permission check: a refused caller would spend the
 * shared budget, write an audit row and trip the abuse alert, and after 40
 * refusals be told 429 instead of 403. Pass the request the handler was given,
 * never one built for the call: its Fetch Metadata is what the first check
 * reads.
 *
 * ANOTHER ORIGIN'S PAGE (docket S14 review). Exports are GETs, which the
 * cross-site write rule never judges, and the browser sends the session cookie
 * with a top-level navigation from any site (SameSite=Lax) and with an image or
 * script that a sibling subdomain loads (the same site). So another page could
 * spend this budget: lock the person out of every export for an hour, run real
 * exports, and past the limit write the audit row below in their name and send
 * the organization's alert with their email. A navigation that turns into a
 * download leaves that page where it was, so it can repeat. An export the
 * browser says another origin's page asked for (sentFromAnotherOrigin) is
 * therefore answered 403 before the budget is touched. The app's own pages
 * (same-origin), an address the person typed or bookmarked (`none`), the phone
 * (a Bearer token and no Fetch Metadata) and a server-side fetch (the PO zip
 * fetching the PO PDF sends no Sec-Fetch-Site) are judged by the budget as
 * before.
 *
 * Returns a ready 403 or 429 NextResponse to return early, or null to proceed.
 * 40/hr is far above a human generating reports but stops scripted abuse.
 *
 * SECURITY FEED: when the limit trips and `organizationId` is supplied, a
 * `security.export_rate_limited` event fans out to the org's subscribed
 * Slack/Teams/webhook channels — 40 exports in an hour reads like scripted
 * data exfiltration, which an admin wants to know about LIVE. The alert is
 * self-deduped to one per user per hour (a hammering script would otherwise
 * flood the channel on every blocked request), and is fully best-effort: it
 * can never affect the 429 itself.
 */
export async function exportRateLimited(
  req: Request,
  userId: string,
  organizationId?: string,
): Promise<NextResponse | null> {
  if (!bearerTokenFrom(req) && sentFromAnotherOrigin(req)) {
    logRefusedExport(req);
    return NextResponse.json(
      { error: 'cross_site_request', message: CROSS_SITE_EXPORT_MESSAGE },
      { status: 403, headers: NO_STORE },
    );
  }

  const rl = await checkRateLimit(`export:${userId}`, 40, 60 * 60 * 1000, 'closed');
  if (rl.allowed) return null;

  if (organizationId) {
    // Record EVERY trip (un-deduped) so the hourly audit-anomaly cron can detect
    // a sustained export-abuse pattern by counting trips per actor. The per-org
    // alert below stays dedup-gated (1/hour) so it doesn't spam the webhook.
    void createAdminClient()
      .from('audit_logs')
      .insert({ organization_id: organizationId, user_id: userId, event: 'security.export_rate_limited' })
      .then(({ error }) => {
        if (error) {
          void reportError(new Error(`export-rate-limit.audit: ${error.message}`), {
            tag: 'export-rate-limit.audit',
            level: 'warning',
          });
        }
      });

    try {
      // Fail OPEN here (unlike the export budget): this key only dedupes the
      // alert — if its read errors we'd rather send a duplicate alert than
      // drop a real exfiltration signal.
      const alertGate = await checkRateLimit(
        `export-alert:${userId}`,
        1,
        60 * 60 * 1000,
        'open',
      );
      if (alertGate.allowed) {
        const { data: profile } = await createAdminClient()
          .from('user_profiles')
          .select('email')
          .eq('id', userId)
          .maybeSingle();
        void dispatchEvent(organizationId, 'security.export_rate_limited', {
          email: (profile as { email?: string | null } | null)?.email ?? undefined,
        });
      }
    } catch (e) {
      void reportError(e, { tag: 'export-rate-limit.alert', level: 'warning' });
    }
  }

  return NextResponse.json(
    { error: 'rate_limited', message: 'Too many exports — please wait a few minutes.' },
    {
      status: 429,
      headers: {
        'retry-after': String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))),
        // Exports are never cached anywhere, answers or refusals.
        'Cache-Control': 'no-store',
      },
    },
  );
}
