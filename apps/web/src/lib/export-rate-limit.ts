import 'server-only';

import { NextResponse } from 'next/server';

import { createAdminClient } from '@/lib/supabase/admin';
import { reportError } from '@/lib/error-reporter';
import { dispatchEvent } from '@/server/services/integration-events';

import { checkRateLimit } from './rate-limit';

/**
 * Shared throttle for expensive PDF/CSV export endpoints. One per-user budget
 * across ALL exports (40/hour, fail-CLOSED), so an authenticated user — or a
 * hijacked session — can't spam react-pdf rendering / large CSV generation to
 * exhaust serverless compute (DoS + cost). Security audit 2026-06-09.
 *
 * Usage in a route handler, right after resolving the auth context:
 *   const limited = ctx && (await exportRateLimited(ctx.userId, ctx.organizationId));
 *   if (limited) return limited;
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
      headers: { 'retry-after': String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))) },
    },
  );
}
