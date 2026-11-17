import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { internalErrorResponse } from '@/server/lib/api-error-response';
import { newestPerKey, oldestFirst, sweepUntilDeadline } from '@/server/services/lib/cron-sweep';
import { fetchAllRows } from '@/server/services/lib/paginate';
import { createSnapshot } from '@/server/services/restore-points';
import type { ServiceContext } from '@/server/services/context';

import { planAllowsRestorePoints, type ModuleId, type OrgBillingState } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * The hard limit. 300, like daily-briefing and exception-occurrences, and
 * far above the soft deadline below: the deadline only stops organizations
 * from STARTING, and a snapshot already started (up to 50,000 items read a
 * page at a time, then one INSERT) gets the gap to finish.
 */
export const maxDuration = 300;

/** Stop STARTING snapshots after this long (see maxDuration). */
const RUN_DEADLINE_MS = 200_000;
/** Snapshots taken at once. Each organization's snapshot reads and writes
 *  only its own rows, so a few at once do not touch each other. */
const CONCURRENCY = 3;
/** How far back the ordering read looks for each organization's last
 *  automatic point. An organization with none in this window goes first. */
const LAST_POINT_LOOKBACK_MS = 3 * 24 * 60 * 60_000;

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
 *
 * Order: the organizations whose last automatic restore point is oldest go
 * first (none in the last three days: first of all, in id order). A run that
 * reaches its deadline stops starting snapshots, says how many organizations
 * it left (one log line, and a warning to the error reporter), and those go
 * first on the next run. A snapshot is written whole or not at all:
 * createSnapshot reads every item before its single INSERT, so a stop before
 * the INSERT writes nothing.
 */
export async function GET(req: Request) {
  if (!env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const auth = req.headers.get('authorization') ?? '';
  if (!secretsEqual(auth, `Bearer ${env.CRON_SECRET}`)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();
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

    // Ordering only: if this read fails, the run goes in id order.
    let lastPoint = new Map<string, number>();
    try {
      const since = new Date(startedAt - LAST_POINT_LOOKBACK_MS).toISOString();
      const rows = await fetchAllRows<{ id: string; organization_id: string; created_at: string }>(
        (from, to) =>
          admin
            .from('restore_points')
            .select('id, organization_id, created_at')
            .eq('kind', 'auto')
            .gte('created_at', since)
            .order('id', { ascending: true })
            .range(from, to),
      );
      lastPoint = newestPerKey(rows, (r) => r.organization_id, (r) => r.created_at);
    } catch (err) {
      void reportError(err, { tag: 'cron.restore-points.order', level: 'warning' });
    }
    const ordered = oldestFirst(
      eligible.map((o) => o.id),
      lastPoint,
    );

    const sweep = await sweepUntilDeadline(
      ordered,
      { concurrency: CONCURRENCY, deadlineAt: startedAt + RUN_DEADLINE_MS },
      async (orgId): Promise<'snapshotted' | 'no_owner' | 'failed'> => {
        try {
          const ctx = await buildSystemContext(admin, orgId);
          if (!ctx) return 'no_owner';
          await createSnapshot(ctx, { kind: 'auto', label: null });
          return 'snapshotted';
        } catch (e) {
          void reportError(e, { tag: 'cron.restore-points.org', extra: { orgId } });
          return 'failed';
        }
      },
    );
    const count = (status: string) =>
      sweep.entries.filter((e) => e.started && e.ok && e.value === status).length;
    const snapshotted = count('snapshotted');
    const noOwner = count('no_owner');
    const failed = count('failed');
    const leftForNextRun = sweep.leftForNextRun;

    if (leftForNextRun > 0) {
      void reportError(new Error('Restore points stopped at the run deadline'), {
        tag: 'cron.restore-points.deadline',
        level: 'warning',
        extra: { eligible: eligible.length, snapshotted, leftForNextRun },
      });
    }
    // One line per run, counts only (no org ids).
    console.info(
      '[cron.restore-points]',
      JSON.stringify({
        eligible: eligible.length,
        snapshotted,
        noOwner,
        failed,
        leftForNextRun,
        ms: Date.now() - startedAt,
      }),
    );

    return NextResponse.json({
      eligible: eligible.length,
      snapshotted,
      noOwner,
      failed,
      leftForNextRun,
    });
  } catch (err) {
    return internalErrorResponse(err, 'cron.restore-points');
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
    isSystem: true,
    enabledModules,
  };
}
