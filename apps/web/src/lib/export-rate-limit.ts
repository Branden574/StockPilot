import 'server-only';

import { NextResponse } from 'next/server';

import { createAdminClient } from '@/lib/supabase/admin';
import { reportError } from '@/lib/error-reporter';
import { insertAuditRowReported } from '@/server/services/audit';
import { dispatchEvent } from '@/server/services/integration-events';

import { checkRateLimit } from './rate-limit';

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
 *   const limited = await exportRateLimited(ctx.userId, ctx.organizationId);
 *   if (limited) return limited;
 * Never run it before the permission check: a refused caller would spend the
 * shared budget, write an audit row and trip the abuse alert, and after 40
 * refusals be told 429 instead of 403.
 *
 * Returns a ready 429 NextResponse to return early, or null to proceed. 40/hr
 * is far above a human generating reports but stops scripted abuse.
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
  userId: string,
  organizationId?: string,
): Promise<NextResponse | null> {
  const rl = await checkRateLimit(`export:${userId}`, 40, 60 * 60 * 1000, 'closed');
  if (rl.allowed) return null;

  if (organizationId) {
    // Record EVERY trip (un-deduped) so the hourly audit-anomaly cron can detect
    // a sustained export-abuse pattern by counting trips per actor. The per-org
    // alert below stays dedup-gated (1/hour) so it doesn't spam the webhook.
    //
    // Through insertAuditRowReported, which keeps the INSERT alive past the
    // 429 (the route answers the moment this returns), gives it the audit
    // deadline and reports a lost row. The bare `void createAdminClient()...`
    // it replaces held nothing once the 429 was sent, and a throw from
    // createAdminClient() itself escaped this function and turned the 429
    // into a 500.
    void insertAuditRowReported({
      organization_id: organizationId,
      user_id: userId,
      event: 'security.export_rate_limited',
      metadata: {},
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
