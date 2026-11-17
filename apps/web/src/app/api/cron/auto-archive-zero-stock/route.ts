import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { internalErrorResponse } from '@/server/lib/api-error-response';
import {
  archiveExpiredZeroStockItems,
  notifyAutoArchived,
  parseAutoArchiveSettings,
  type AutoArchiveSettings,
} from '@/server/services/auto-archive';
import { revalidateInventoryList } from '@/server/loaders/inventory-list';
import { DAILY_CLAIM_HOLD_MS, sweepOrganizations } from '@/server/services/lib/cron-sweep';
import { fetchAllRows } from '@/server/services/lib/paginate';
import type { ServiceContext } from '@/server/services/context';

import type { ModuleId } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * 300, up from 60: the job runs once a day, so an organization a run does not
 * reach waits a whole day. 300 is what the other daily per-organization jobs
 * use (daily-briefing, restore-points), and the soft deadline below leaves the
 * organization in flight a minute to finish.
 */
export const maxDuration = 300;

/** Stop STARTING organizations after this long (see maxDuration). */
const RUN_DEADLINE_MS = 240_000;
/** The job's cadence: the slot of the fallback order (rotateByClock). */
const DAY_MS = 24 * 60 * 60_000;

function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Daily zero-stock auto-archive cron. For every org that (a) has the
 * inventory module enabled and (b) turned auto-archive-on-zero-stock ON,
 * archives items that have sat at/below zero stock longer than the org's
 * dwell window (mig 0266's zero_since + auto_archived columns). Runs in a
 * per-org system context (service-role, owner-equivalent).
 *
 * CRON_SECRET-gated like the other crons. FAIL-OPEN per org: one org's error
 * is reported and skipped, never blocking the rest.
 *
 * Order: the organizations this job reached longest ago first
 * (cron_sweep_attempts, job 'auto_archive_zero_stock'), so a run cut by its
 * deadline leaves different organizations each day, and those go first the
 * next day. Each organization is claimed as it starts: a second delivery of
 * the tick skips it (the row-level guards of archiveExpiredZeroStockItems,
 * and a notice only for the rows this run changed, stand behind that).
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
    // Orgs with an inventory module row — PAGINATED (a plain select is silently
    // capped at PostgREST's 1000-row max). fetchAllRows throws on error
    // (fail-closed). Stable order for range pagination.
    //
    // We deliberately do NOT filter `.eq('enabled', true)`: `inventory` is a
    // tier:'core' module treated as always-on app-side (resolve.ts), and the
    // settings action writes autoArchiveOnZeroStock into this same row — so the
    // row always exists for any org that opted in, and the parsed `enabled`
    // flag below is the real opt-in signal (not the module row's enabled bool).
    const modRows = await fetchAllRows<{ organization_id: string; settings: unknown }>((from, to) =>
      admin
        .from('organization_modules')
        .select('organization_id, settings')
        .eq('module_id', 'inventory')
        .order('organization_id', { ascending: true })
        .range(from, to),
    );

    const candidates: Array<{ orgId: string; settings: AutoArchiveSettings }> = [];
    for (const r of modRows) {
      const bucket =
        r.settings && typeof r.settings === 'object'
          ? (r.settings as Record<string, unknown>).autoArchiveOnZeroStock
          : undefined;
      const settings = parseAutoArchiveSettings(bucket);
      if (settings.enabled) candidates.push({ orgId: r.organization_id, settings });
    }

    let orgsProcessed = 0;
    let itemsArchived = 0;
    let orgsTruncated = 0; // hit the per-run cap → backlog drains next run

    const settingsByOrg = new Map(candidates.map((c) => [c.orgId, c.settings]));
    const sweep = await sweepOrganizations(
      admin,
      {
        job: 'auto_archive_zero_stock',
        tag: 'cron.auto-archive-zero-stock',
        orgIds: candidates.map((c) => c.orgId),
        deadlineAt: startedAt + RUN_DEADLINE_MS,
        slotMs: DAY_MS,
        holdMs: DAILY_CLAIM_HOLD_MS,
      },
      async (orgId): Promise<{ result: 'success' | 'failure'; value: null }> => {
        const settings = settingsByOrg.get(orgId)!;
        try {
          const ctx = await buildSystemContext(admin, orgId);
          // no owner/admin to attribute the archives to → skip
          if (!ctx) return { result: 'failure', value: null };
          const { archived, items, truncated } = await archiveExpiredZeroStockItems(
            ctx,
            settings.dwellDays,
          );
          orgsProcessed++;
          itemsArchived += archived;
          if (archived > 0) {
            // Archived items vanish from the cached Items/Books default views.
            revalidateInventoryList(orgId);
            await notifyAutoArchived(admin, orgId, items);
          }
          if (truncated) {
            orgsTruncated++;
            // Disclose the silent cap (recurring-bug-patterns rule) so a backlogged
            // org is visible to operators rather than quietly under-archiving.
            void reportError(new Error('auto-archive zero-stock hit per-run cap'), {
              tag: 'cron.auto-archive-zero-stock.truncated',
              extra: { orgId, archived },
            });
          }
          return { result: 'success', value: null };
        } catch (e) {
          void reportError(e, { tag: 'cron.auto-archive-zero-stock.org', extra: { orgId } });
          return { result: 'failure', value: null };
        }
      },
    );

    const summary = {
      orgsProcessed,
      itemsArchived,
      orgsTruncated,
      candidates: candidates.length,
      heldByAnotherRun: sweep.heldByAnotherRun,
      leftForNextRun: sweep.leftForNextRun,
    };
    // One line per run, counts only (no ids, names or org ids).
    console.info(
      '[cron.auto-archive-zero-stock]',
      JSON.stringify({
        ...summary,
        failed: sweep.failed,
        failingRepeatedly: sweep.failingRepeatedly,
        orderedBy: sweep.orderedBy,
        ms: Date.now() - startedAt,
      }),
    );
    return NextResponse.json(summary);
  } catch (err) {
    return internalErrorResponse(err, 'cron.auto-archive-zero-stock');
  }
}

/**
 * Owner-equivalent system ServiceContext for the cron: service-role client
 * (bypasses RLS; queries stay org-scoped by organization_id), role 'owner', MFA
 * satisfied, and the org's enabled modules. Null when the org has no
 * owner/admin to attribute the archives to.
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
