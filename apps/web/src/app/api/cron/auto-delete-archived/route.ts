import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { internalErrorResponse } from '@/server/lib/api-error-response';
import {
  parseAutoDeleteArchivedSettings,
  purgeExpiredArchivedItems,
  type AutoDeleteArchivedSettings,
} from '@/server/services/archive-cleanup';
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
 * Daily archived-item cleanup cron. For every org that (a) has the inventory
 * module enabled and (b) turned auto-delete-archived ON, soft-delete the items
 * that have sat archived longer than the org's retention window. Runs in a
 * per-org system context (service-role, owner-equivalent).
 *
 * CRON_SECRET-gated like the other crons. FAIL-OPEN per org: one org's error is
 * reported and skipped, never blocking the rest.
 *
 * Order: the organizations this job reached longest ago first
 * (cron_sweep_attempts, job 'auto_delete_archived'), so a run cut by its
 * deadline leaves different organizations each day, and those go first the
 * next day. Each organization is claimed as it starts: a second delivery of
 * the tick skips it (the row-level guards of purgeExpiredArchivedItems stand
 * behind that).
 *
 * ONE RUN PER ORGANIZATION PER 20 HOURS (DAILY_CLAIM_HOLD_MS). A manual run
 * does nothing for an organization another run started in the last 20 hours,
 * including one whose attempt failed (it waits for the next day's run), and a
 * manual run late in the day makes the next scheduled run skip the
 * organizations it started (they are reached the day after).
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
    // settings action writes autoDeleteArchived into this same row — so the row
    // always exists for any org that opted in, and the parsed `enabled` flag
    // below is the real opt-in signal (not the module row's enabled bool).
    const modRows = await fetchAllRows<{ organization_id: string; settings: unknown }>((from, to) =>
      admin
        .from('organization_modules')
        .select('organization_id, settings')
        .eq('module_id', 'inventory')
        .order('organization_id', { ascending: true })
        .range(from, to),
    );

    const candidates: Array<{ orgId: string; settings: AutoDeleteArchivedSettings }> = [];
    for (const r of modRows) {
      const settings = parseAutoDeleteArchivedSettings(settingsBucket(r));
      if (settings.enabled) candidates.push({ orgId: r.organization_id, settings });
    }

    let orgsProcessed = 0;
    let itemsDeleted = 0;
    // Past retention but kept because they still hold stock (L15).
    let itemsSkipped = 0;
    let orgsTruncated = 0; // hit the per-run cap → backlog drains next run

    let noActor = 0;
    let turnedOff = 0;
    const sweep = await sweepOrganizations(
      admin,
      {
        job: 'auto_delete_archived',
        tag: 'cron.auto-delete-archived',
        orgIds: candidates.map((c) => c.orgId),
        deadlineAt: startedAt + RUN_DEADLINE_MS,
        slotMs: DAY_MS,
        holdMs: DAILY_CLAIM_HOLD_MS,
      },
      async (orgId): Promise<{ result: 'success' | 'failure' | 'neither'; value: null }> => {
        try {
          // The organization's settings as they are NOW: the list above was
          // read at the start of the run, up to minutes ago, and an admin who
          // has turned auto-delete off, or changed its days, since is respected.
          const { data: modRow, error: modErr } = await admin
            .from('organization_modules')
            .select('settings')
            .eq('organization_id', orgId)
            .eq('module_id', 'inventory')
            .maybeSingle();
          if (modErr) throw new Error(modErr.message);
          const settings = parseAutoDeleteArchivedSettings(settingsBucket(modRow));
          if (!settings.enabled) {
            turnedOff++;
            return { result: 'neither', value: null };
          }

          const ctx = await buildSystemContext(admin, orgId);
          // No owner/admin to attribute the deletions to → skip. Not a failure:
          // it would count against the organization every day.
          if (!ctx) {
            noActor++;
            return { result: 'neither', value: null };
          }
          const { deleted, truncated, skipped } = await purgeExpiredArchivedItems(
            ctx,
            settings.days,
          );
          orgsProcessed++;
          itemsDeleted += deleted;
          itemsSkipped += skipped;
          // Soft-deleted items vanish from the cached Items/Books default views.
          if (deleted > 0) revalidateInventoryList(orgId);
          if (truncated) {
            orgsTruncated++;
            // Disclose the silent cap (recurring-bug-patterns rule) so a backlogged
            // org is visible to operators rather than quietly under-deleting.
            void reportError(new Error('archived-item purge hit per-run cap'), {
              tag: 'cron.auto-delete-archived.truncated',
              extra: { orgId, deleted },
            });
          }
          return { result: 'success', value: null };
        } catch (e) {
          void reportError(e, { tag: 'cron.auto-delete-archived.org', extra: { orgId } });
          return { result: 'failure', value: null };
        }
      },
    );

    const summary = {
      orgsProcessed,
      itemsDeleted,
      itemsSkipped,
      orgsTruncated,
      candidates: candidates.length,
      heldByAnotherRun: sweep.heldByAnotherRun,
      leftForNextRun: sweep.leftForNextRun,
    };
    // One line per run, counts only (no ids, names or org ids).
    console.info(
      '[cron.auto-delete-archived]',
      JSON.stringify({
        ...summary,
        noActor,
        turnedOff,
        failed: sweep.failed,
        failingRepeatedly: sweep.failingRepeatedly,
        orderedBy: sweep.orderedBy,
        ms: Date.now() - startedAt,
      }),
    );
    return NextResponse.json(summary);
  } catch (err) {
    return internalErrorResponse(err, 'cron.auto-delete-archived');
  }
}

/** The autoDeleteArchived part of an organization_modules row's settings. */
function settingsBucket(row: { settings?: unknown } | null | undefined): unknown {
  const settings = row?.settings;
  return settings && typeof settings === 'object'
    ? (settings as Record<string, unknown>).autoDeleteArchived
    : undefined;
}

/**
 * Owner-equivalent system ServiceContext for the cron: service-role client
 * (bypasses RLS; queries stay org-scoped by organization_id), role 'owner', MFA
 * satisfied, and the org's enabled modules. Null when the org has no
 * owner/admin to attribute the soft-deletes to.
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
