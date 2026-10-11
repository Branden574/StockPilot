import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { createNotification } from '@/server/services/notifications';
import { fetchAllRows } from '@/server/services/lib/paginate';
import { RecurringPoTemplatesService, recurringRunNotice } from '@/server/services/recurring-pos';
import type { ServiceContext } from '@/server/services/context';

import { planAllowsRecurringPos, type ModuleId, type OrgBillingState } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Daily recurring-PO cron. For every org that (a) has the purchase_orders
 * module enabled, and (b) is on a Pro+ effective plan, create POs from all
 * templates whose next_run_at <= now, optionally auto-send within the
 * configured cap + approval threshold, advance the schedule, and notify admins.
 *
 * CRON_SECRET-gated. FAIL-OPEN per org: one org's error is reported and
 * skipped, never blocking the rest.
 */
export async function GET(req: Request) {
  if (!env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const auth = req.headers.get('authorization') ?? '';
  if (!secretsEqual(auth, `Bearer ${env.CRON_SECRET}`)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();

  try {
    // Paginate orgs with the purchase_orders module enabled — a plain select
    // is silently capped at PostgREST's 1000-row max once the platform scales.
    const modRows = await fetchAllRows<{ organization_id: string }>((from, to) =>
      admin
        .from('organization_modules')
        .select('organization_id')
        .eq('module_id', 'purchase_orders')
        .eq('enabled', true)
        .order('organization_id', { ascending: true })
        .range(from, to),
    );

    let orgsProcessed = 0;
    let posCreated = 0;
    let posSent = 0;
    let posHeld = 0;
    let linesLeftOff = 0;
    let failures = 0;
    let templatesSkipped = 0;

    for (const { organization_id: orgId } of modRows) {
      try {
        // Tier gate (Pro+ on the EFFECTIVE plan) — filter here so a downgraded
        // org stops auto-creating POs immediately on the next cron run.
        const { data: orgRow } = await admin
          .from('organizations')
          .select(
            'plan, access_tier, billing_arrangement, stripe_subscription_id, trial_ends_at, trial_tier',
          )
          .eq('id', orgId)
          .maybeSingle();
        if (!orgRow || !planAllowsRecurringPos(orgRow as OrgBillingState)) continue;

        const ctx = await buildSystemContext(admin, orgId);
        if (!ctx) continue; // no owner/admin to attribute to → skip safely

        const summary = await new RecurringPoTemplatesService(ctx).runDueTemplates(new Date());
        orgsProcessed++;
        posCreated += summary.created;
        posSent += summary.sent;
        posHeld += summary.heldForReview;
        linesLeftOff += summary.linesLeftOff;
        failures += summary.failures;
        templatesSkipped += summary.templatesSkipped.length;

        // Admins hear about every run that created a PO, about every run
        // that left template lines off (a deleted item, a kit), including one
        // that created nothing because no line could be ordered, and about
        // every template whose purchase order the save refused or could not
        // make (its destination deleted after it was saved, ...), with why.
        // A skipped template's creator is told too: whoever set the template
        // up is the one who fixes it, and may be a manager.
        const notice = recurringRunNotice(summary);
        if (notice) {
          await notifyAdmins(
            admin,
            orgId,
            notice,
            summary.templatesSkipped.map((s) => s.createdBy),
          );
        }
      } catch (e) {
        void reportError(e, { tag: 'cron.recurring-pos.org', extra: { orgId } });
      }
    }

    return NextResponse.json({
      orgsProcessed,
      posCreated,
      posSent,
      posHeld,
      linesLeftOff,
      failures,
      templatesSkipped,
      candidates: modRows.length,
    });
  } catch (e) {
    void reportError(e, { tag: 'cron.recurring-pos' });
    return NextResponse.json(
      {
        error: 'internal_error',
        message: e instanceof Error ? e.message : 'Recurring-PO cron failed',
      },
      { status: 500 },
    );
  }
}

/**
 * Builds an owner-equivalent system ServiceContext for the cron: service-role
 * client (bypasses RLS, queries stay org-scoped by organization_id), role
 * 'owner', MFA satisfied, and the org's actually-enabled modules. Returns null
 * when the org has no owner/admin to attribute created POs to.
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

/**
 * Notify the org's owners/admins about a recurring-PO run, and `creators`
 * (the creators of the templates the run skipped) who are still accepted
 * members of the org. Each person once. Best-effort.
 */
async function notifyAdmins(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  notice: { title: string; body: string },
  creators: ReadonlyArray<string | null> = [],
): Promise<void> {
  const { data: admins } = await admin
    .from('organization_members')
    .select('user_id')
    .eq('organization_id', orgId)
    .in('role', ['owner', 'admin'])
    .not('accepted_at', 'is', null)
    .is('impersonation_expires_at', null);
  const recipients = new Set(((admins ?? []) as Array<{ user_id: string }>).map((m) => m.user_id));

  const creatorIds = [...new Set(creators.filter((id): id is string => Boolean(id)))].filter(
    (id) => !recipients.has(id),
  );
  if (creatorIds.length > 0) {
    const { data: members } = await admin
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', orgId)
      // in-list-bound: the distinct creators of this run's skipped templates, at most the org's members
      .in('user_id', creatorIds)
      .not('accepted_at', 'is', null)
      .is('impersonation_expires_at', null);
    for (const m of (members ?? []) as Array<{ user_id: string }>) recipients.add(m.user_id);
  }

  for (const userId of recipients) {
    await createNotification({
      organizationId: orgId,
      userId,
      type: 'purchase_order.auto_reorder',
      title: notice.title,
      body: notice.body,
      link: '/dashboard/purchase-orders',
    });
  }
}
