import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  parseAutoReorderSettings,
  type AutoReorderSettings,
} from '@/server/services/auto-reorder';
import { createNotification } from '@/server/services/notifications';
import { fetchAllRows } from '@/server/services/lib/paginate';
import { PurchaseOrdersService } from '@/server/services/purchase-orders';
import type { ServiceContext } from '@/server/services/context';

import { planAllowsAutoReorder, type ModuleId, type OrgBillingState } from '@stockpilot/core';

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
 * Daily automatic-reordering cron. For every org that (a) has the
 * purchase_orders module enabled, (b) turned auto-reorder ON, and (c) is on a
 * Pro+ effective plan, run the dedup-aware reorder engine in a per-org system
 * context (service-role, owner-equivalent), then notify the org's admins.
 *
 * CRON_SECRET-gated like the other crons. FAIL-OPEN per org: one org's error is
 * reported and skipped, never blocking the rest.
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
    // Orgs with the purchase_orders module enabled — PAGINATED (a plain select
    // is silently capped at PostgREST's 1000-row max, which would skip orgs once
    // the platform has >1000 PO-enabled orgs). fetchAllRows throws on error
    // (fail-closed). Stable order by organization_id for range pagination.
    const modRows = await fetchAllRows<{ organization_id: string; settings: unknown }>((from, to) =>
      admin
        .from('organization_modules')
        .select('organization_id, settings')
        .eq('module_id', 'purchase_orders')
        .eq('enabled', true)
        .order('organization_id', { ascending: true })
        .range(from, to),
    );

    const candidates: Array<{ orgId: string; settings: AutoReorderSettings }> = [];
    for (const r of modRows) {
      const bucket =
        r.settings && typeof r.settings === 'object'
          ? (r.settings as Record<string, unknown>).autoReorder
          : undefined;
      const settings = parseAutoReorderSettings(bucket);
      if (settings.enabled) candidates.push({ orgId: r.organization_id, settings });
    }

    let orgsProcessed = 0;
    let posCreated = 0;
    let posSent = 0;

    for (const { orgId, settings } of candidates) {
      try {
        // Tier gate (Pro+ on the EFFECTIVE plan).
        const { data: orgRow } = await admin
          .from('organizations')
          .select(
            'plan, access_tier, billing_arrangement, stripe_subscription_id, trial_ends_at, trial_tier',
          )
          .eq('id', orgId)
          .maybeSingle();
        if (!orgRow || !planAllowsAutoReorder(orgRow as OrgBillingState)) continue;

        const ctx = await buildSystemContext(admin, orgId);
        if (!ctx) continue; // no owner/admin to attribute to → skip safely

        const summary = await new PurchaseOrdersService(ctx).runAutoReorder(settings);
        orgsProcessed++;
        posCreated += summary.created;
        posSent += summary.sent;

        if (summary.created > 0) {
          await notifyAdmins(admin, orgId, summary);
        }
      } catch (e) {
        void reportError(e, { tag: 'cron.auto-reorder.org', extra: { orgId } });
      }
    }

    return NextResponse.json({ orgsProcessed, posCreated, posSent, candidates: candidates.length });
  } catch (err) {
    void reportError(err, { tag: 'cron.auto-reorder' });
    return NextResponse.json(
      { error: 'internal_error', message: err instanceof Error ? err.message : 'Auto-reorder failed' },
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

/** Notify the org's owners/admins that auto-reorder ran. Best-effort. */
async function notifyAdmins(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  summary: { created: number; sent: number; heldForReview: number },
): Promise<void> {
  const { data: admins } = await admin
    .from('organization_members')
    .select('user_id')
    .eq('organization_id', orgId)
    .in('role', ['owner', 'admin'])
    .not('accepted_at', 'is', null)
    .is('impersonation_expires_at', null);

  const sentPart = summary.sent > 0 ? `, ${summary.sent} sent` : '';
  const heldPart = summary.heldForReview > 0 ? `, ${summary.heldForReview} held for review` : '';
  const body = `Auto-reorder created ${summary.created} purchase order${
    summary.created === 1 ? '' : 's'
  }${sentPart}${heldPart}.`;

  for (const m of (admins ?? []) as Array<{ user_id: string }>) {
    await createNotification({
      organizationId: orgId,
      userId: m.user_id,
      type: 'purchase_order.auto_reorder',
      title: 'Automatic reorder ran',
      body,
      link: '/dashboard/purchase-orders',
    });
  }
}
