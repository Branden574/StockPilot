import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchAllRows } from '@/server/services/lib/paginate';
import { createSnapshot } from '@/server/services/restore-points';
import type { ServiceContext } from '@/server/services/context';

import { planAllowsRestorePoints, type ModuleId, type OrgBillingState } from '@stockpilot/core';

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
 * Daily automatic restore-point cron. Snapshots every Business+ org's inventory
 * (createSnapshot also prunes to the retention window). CRON_SECRET-gated;
 * FAIL-OPEN per org. Mirrors the auto-reorder cron's per-org system context.
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
    // All orgs (paginated) → keep the Business+ ones.
    const orgs = await fetchAllRows<
      OrgBillingState & { id: string }
    >((from, to) =>
      admin
        .from('organizations')
        .select(
          'id, plan, access_tier, billing_arrangement, stripe_subscription_id, trial_ends_at, trial_tier',
        )
        .order('id', { ascending: true })
        .range(from, to),
    );
    const eligible = orgs.filter((o) => planAllowsRestorePoints(o));

    let snapshotted = 0;
    for (const o of eligible) {
      try {
        const ctx = await buildSystemContext(admin, o.id);
        if (!ctx) continue;
        await createSnapshot(ctx, { kind: 'auto', label: null });
        snapshotted++;
      } catch (e) {
        void reportError(e, { tag: 'cron.restore-points.org', extra: { orgId: o.id } });
      }
    }

    return NextResponse.json({ eligible: eligible.length, snapshotted });
  } catch (err) {
    void reportError(err, { tag: 'cron.restore-points' });
    return NextResponse.json(
      { error: 'internal_error', message: err instanceof Error ? err.message : 'failed' },
      { status: 500 },
    );
  }
}

/** Owner-equivalent system context for the cron (service-role, org-scoped). */
async function buildSystemContext(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
): Promise<ServiceContext | null> {
  const [{ data: members }, { data: mods }] = await Promise.all([
    admin
      .from('organization_members')
      .select('user_id')
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
  const actor = (members ?? [])[0] as { user_id: string } | undefined;
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
