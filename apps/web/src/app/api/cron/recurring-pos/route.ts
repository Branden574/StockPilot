import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { internalErrorResponse } from '@/server/lib/api-error-response';
import { createNotification } from '@/server/services/notifications';
import { fetchAllRows } from '@/server/services/lib/paginate';
import {
  RecurringPoTemplatesService,
  recurringRunNotice,
  type RecurringRunSummary,
} from '@/server/services/recurring-pos';
import type { ServiceContext } from '@/server/services/context';

import {
  effectivePermissions,
  planAllowsRecurringPos,
  type ModuleId,
  type OrgBillingState,
  type PermissionOverride,
  type Role,
} from '@stockpilot/core';

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
        // A skipped template's creator is told too, while they can still
        // edit templates: whoever set the template up is the one who fixes
        // it, and may be a manager.
        if (recurringRunNotice(summary)) {
          await notifyAdmins(admin, orgId, summary);
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
    return internalErrorResponse(e, 'cron.recurring-pos');
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
    isSystem: true,
    enabledModules,
  };
}

/** The permission every recurring template action and the Recurring page check. */
const EDITS_TEMPLATES = 'purchase_orders:manage';

/**
 * Notify the org's owners/admins about a recurring-PO run, and the creators
 * of the templates the run skipped who are still accepted members of the
 * org and can still edit templates. Each person once, with the notice for
 * them (recurringRunNotice with `recipientId`: the templates they created
 * named first, every one). Best-effort.
 */
async function notifyAdmins(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  summary: RecurringRunSummary,
): Promise<void> {
  const creators = summary.templatesSkipped.map((s) => s.createdBy);
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
    for (const userId of await creatorsWhoEditTemplates(admin, orgId, creatorIds)) {
      recipients.add(userId);
    }
  }

  for (const userId of recipients) {
    const notice = recurringRunNotice(summary, { recipientId: userId });
    if (!notice) continue;
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

/**
 * Of `creatorIds`, the accepted members (not impersonation sessions) who can
 * still edit recurring templates: the effective purchase_orders:manage, as
 * the gate resolves it (role defaults, then the organization's role
 * overrides, then the member's own; the owner always; core
 * effectivePermissions). A creator later moved to staff or viewer, or whose
 * permission was taken away, cannot open the template the notice tells them
 * to edit, and the notice names the organization's other skipped templates
 * too, so they are not told (slice 8 review).
 *
 * FAILS CLOSED. When the read of the creators' memberships or either override
 * read fails, the failure is reported once and no creator is told this run
 * (an empty list). A creator's notice is optional, and without the overrides
 * the answer is unknown: the role's defaults would tell a manager whose
 * permission an override took away. The owners and admins are told as
 * always; notifyAdmins reads them by role before this. The request gate
 * (loadEffectivePermissions) refuses on the same failure (docket S19); here
 * the notice is optional, so it is skipped rather than failing the run.
 */
async function creatorsWhoEditTemplates(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  creatorIds: string[],
): Promise<string[]> {
  const [membersRes, roleOvRes, userOvRes] = await Promise.all([
    admin
      .from('organization_members')
      .select('user_id, role')
      .eq('organization_id', orgId)
      // in-list-bound: the distinct creators of this run's skipped templates, at most the org's members
      .in('user_id', creatorIds)
      .not('accepted_at', 'is', null)
      .is('impersonation_expires_at', null),
    admin
      .from('role_permission_overrides')
      .select('role, permission, granted')
      .eq('organization_id', orgId)
      .eq('permission', EDITS_TEMPLATES),
    admin
      .from('user_permission_overrides')
      .select('user_id, permission, granted')
      .eq('organization_id', orgId)
      .eq('permission', EDITS_TEMPLATES)
      // in-list-bound: the same creators
      .in('user_id', creatorIds),
  ]);
  const readError = membersRes.error ?? roleOvRes.error ?? userOvRes.error;
  if (readError) {
    void reportError(new Error(readError.message), {
      tag: 'cron.recurring-pos.creator_permissions',
      level: 'warning',
      extra: { orgId },
    });
    return [];
  }
  const members = (membersRes.data ?? []) as Array<{ user_id: string; role: Role }>;
  const roleOv = (roleOvRes.data ?? []) as Array<PermissionOverride & { role: Role }>;
  const userOv = (userOvRes.data ?? []) as Array<PermissionOverride & { user_id: string }>;
  return members
    .filter((m) =>
      effectivePermissions(
        m.role,
        roleOv
          .filter((o) => o.role === m.role)
          .map(({ permission, granted }) => ({ permission, granted })),
        userOv
          .filter((o) => o.user_id === m.user_id)
          .map(({ permission, granted }) => ({ permission, granted })),
      ).has(EDITS_TEMPLATES),
    )
    .map((m) => m.user_id);
}
