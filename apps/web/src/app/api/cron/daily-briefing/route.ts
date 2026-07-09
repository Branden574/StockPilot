import { timingSafeEqual } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchAllRows } from '@/server/services/lib/paginate';
import { createNotification } from '@/server/services/notifications';
import { gatherInsightsForCtx, summarizeInsights } from '@/server/services/insights';
import type { ServiceContext } from '@/server/services/context';

import type { ModuleId } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Daily insights briefing — the proactive sibling of the on-demand
 * /dashboard/insights page. Weekday mornings, for every org with the `ai`
 * module enabled, gather the actionable signals (pending approvals, overdue
 * POs, low stock, open counts/POs) and push ONE in-app + push notification to
 * the org's owners/admins linking to the insights page. Quiet by design:
 *  - zero signals → no notification (no "all clear" noise),
 *  - one briefing per user per day (skips when today's already exists), so a
 *    cron re-fire never double-notifies.
 * CRON_SECRET-gated; FAIL-OPEN per org (one org's error never blocks the rest).
 */
export async function GET(req: NextRequest) {
  if (!env.CRON_SECRET) {
    return NextResponse.json({ error: 'cron_disabled' }, { status: 503 });
  }
  const auth = req.headers.get('authorization') ?? '';
  if (!secretsEqual(auth, `Bearer ${env.CRON_SECRET}`)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();
  let orgsProcessed = 0;
  let briefingsSent = 0;

  try {
    // Orgs with the ai module on — the same gate as the insights page.
    const modRows = await fetchAllRows<{ organization_id: string }>((from, to) =>
      admin
        .from('organization_modules')
        .select('organization_id')
        .eq('module_id', 'ai')
        .eq('enabled', true)
        .range(from, to),
    );

    for (const row of modRows) {
      const orgId = row.organization_id;
      try {
        const ctx = await buildSystemContext(admin, orgId);
        if (!ctx) continue;
        orgsProcessed += 1;

        const insights = await gatherInsightsForCtx(ctx);
        if (insights.signals.length === 0) continue; // quiet day — say nothing

        // Narrative is a graceful enhancement; the signal lines stand alone.
        const narrative = await summarizeInsights(insights);
        const top = insights.signals
          .slice(0, 3)
          .map((s) => `${s.count} ${s.label}`)
          .join(' · ');
        const title = `Morning briefing: ${insights.signals.length} thing${
          insights.signals.length === 1 ? '' : 's'
        } need${insights.signals.length === 1 ? 's' : ''} attention`;
        const body = narrative ?? top;

        const { data: admins } = await admin
          .from('organization_members')
          .select('user_id')
          .eq('organization_id', orgId)
          .in('role', ['owner', 'admin'])
          .not('accepted_at', 'is', null)
          .is('impersonation_expires_at', null);

        const startOfToday = new Date();
        startOfToday.setUTCHours(0, 0, 0, 0);

        for (const m of (admins ?? []) as Array<{ user_id: string }>) {
          // One briefing per user per day — idempotent across cron re-fires.
          const { data: existing } = await admin
            .from('notifications')
            .select('id')
            .eq('organization_id', orgId)
            .eq('user_id', m.user_id)
            .eq('type', 'insights.daily_briefing')
            .gte('created_at', startOfToday.toISOString())
            .limit(1)
            .maybeSingle();
          if (existing) continue;

          await createNotification({
            organizationId: orgId,
            userId: m.user_id,
            type: 'insights.daily_briefing',
            title,
            body,
            link: '/dashboard/insights',
            metadata: {
              signalKeys: insights.signals.map((s) => s.key),
              counts: Object.fromEntries(insights.signals.map((s) => [s.key, s.count])),
            },
          });
          briefingsSent += 1;
        }
      } catch (e) {
        void reportError(e, { tag: 'cron.daily-briefing.org', extra: { orgId } });
      }
    }

    return NextResponse.json({ orgsProcessed, briefingsSent });
  } catch (err) {
    void reportError(err, { tag: 'cron.daily-briefing' });
    return NextResponse.json(
      { error: 'internal_error', message: err instanceof Error ? err.message : 'Briefing failed' },
      { status: 500 },
    );
  }
}

/**
 * Owner-equivalent system context for one org (service-role client, org-scoped
 * queries, MFA satisfied, real enabled-module set). Mirrors the auto-reorder
 * cron. Null when the org has no accepted owner/admin to attribute to.
 */
async function buildSystemContext(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
): Promise<ServiceContext | null> {
  const [{ data: members }, { data: mods }] = await Promise.all([
    admin
      .from('organization_members')
      .select('user_id, role')
      .eq('organization_id', orgId)
      .in('role', ['owner', 'admin'])
      .not('accepted_at', 'is', null)
      .is('impersonation_expires_at', null)
      .limit(1),
    admin
      .from('organization_modules')
      .select('module_id')
      .eq('organization_id', orgId)
      .eq('enabled', true),
  ]);

  const actor = (members ?? [])[0] as { user_id: string; role: string } | undefined;
  if (!actor) return null;

  const enabledModules = new Set(
    ((mods ?? []) as Array<{ module_id: string }>).map((m) => m.module_id as ModuleId),
  );

  return {
    organizationId: orgId,
    userId: actor.user_id,
    role: 'owner',
    supabase: admin as unknown as ServiceContext['supabase'],
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules,
  };
}
