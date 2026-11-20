import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { internalErrorResponse } from '@/server/lib/api-error-response';
import {
  parseAutoReorderSettings,
  type AutoReorderSettings,
} from '@/server/services/auto-reorder';
import { createNotification } from '@/server/services/notifications';
import { DAILY_CLAIM_HOLD_MS, sweepOrganizations } from '@/server/services/lib/cron-sweep';
import { fetchAllRows } from '@/server/services/lib/paginate';
import { systemContextLoader } from '@/server/services/lib/system-context';
import { PurchaseOrdersService } from '@/server/services/purchase-orders';

import { planAllowsAutoReorder, type OrgBillingState } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * 300, up from 60: the job runs once a day, so an organization a run does not
 * reach waits a whole day for its reorder. 300 is what the other daily
 * per-organization jobs use (daily-briefing, restore-points), and the soft
 * deadline below leaves the organization in flight a minute to finish.
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
 * Daily automatic-reordering cron. For every org that (a) has the
 * purchase_orders module enabled, (b) turned auto-reorder ON, and (c) is on a
 * Pro+ effective plan, run the dedup-aware reorder engine in a per-org system
 * context (service-role, owner-equivalent), then notify the org's admins.
 *
 * CRON_SECRET-gated like the other crons. FAIL-OPEN per org: one org's error is
 * reported and skipped, never blocking the rest.
 *
 * Order: the organizations this job reached longest ago first
 * (cron_sweep_attempts, job 'auto_reorder'), so a run cut by its deadline
 * leaves different organizations each day, and those go first the next day.
 * One log line per run says how many it left.
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
      const settings = parseAutoReorderSettings(autoReorderBucket(r));
      if (settings.enabled) candidates.push({ orgId: r.organization_id, settings });
    }

    let orgsProcessed = 0;
    let posCreated = 0;
    let posSent = 0;
    let noActor = 0;
    let contextUnread = 0;
    const loadContext = systemContextLoader(admin, 'cron.auto-reorder.context');
    let turnedOff = 0;

    // Least recently reached first, each organization claimed as it starts
    // (sweepOrganizations, job 'auto_reorder'): a second delivery of this
    // tick, or a manual run the same day, skips every organization this run
    // has started. The database's own re-check under the per-organization
    // reorder lock (createReorderDraft) still stands behind it.
    const sweep = await sweepOrganizations(
      admin,
      {
        job: 'auto_reorder',
        tag: 'cron.auto-reorder',
        orgIds: candidates.map((c) => c.orgId),
        deadlineAt: startedAt + RUN_DEADLINE_MS,
        slotMs: DAY_MS,
        holdMs: DAILY_CLAIM_HOLD_MS,
      },
      async (orgId): Promise<{ result: 'success' | 'failure' | 'neither'; value: null }> => {
        try {
          // The organization's settings as they are NOW: the list above was
          // read at the start of the run, up to minutes ago, and an admin who
          // has turned automatic reordering off since is respected.
          const { data: modRow, error: modErr } = await admin
            .from('organization_modules')
            .select('settings')
            .eq('organization_id', orgId)
            .eq('module_id', 'purchase_orders')
            .eq('enabled', true)
            .maybeSingle();
          if (modErr) throw new Error(modErr.message);
          const settings = parseAutoReorderSettings(autoReorderBucket(modRow));
          if (!settings.enabled) {
            turnedOff++;
            return { result: 'neither', value: null };
          }

          // Tier gate (Pro+ on the EFFECTIVE plan).
          const { data: orgRow } = await admin
            .from('organizations')
            .select(
              'plan, access_tier, billing_arrangement, stripe_subscription_id, trial_ends_at, trial_tier',
            )
            .eq('id', orgId)
            .maybeSingle();
          if (!orgRow || !planAllowsAutoReorder(orgRow as OrgBillingState)) {
            return { result: 'success', value: null };
          }

          const loaded = await loadContext(orgId);
          // A failed read of the owner/admin or the module set is a failure
          // (reported once per run), never "no owner" or "no modules". Only
          // an organization whose reads answered with no owner/admin to
          // attribute to is skipped, and that is not a failure: it would count
          // against the organization every day.
          if (!loaded.ok) {
            if (loaded.reason === 'read_failed') {
              contextUnread++;
              return { result: 'failure', value: null };
            }
            noActor++;
            return { result: 'neither', value: null };
          }
          const ctx = loaded.ctx;

          const summary = await new PurchaseOrdersService(ctx).runAutoReorder(settings);
          orgsProcessed++;
          posCreated += summary.created;
          posSent += summary.sent;

          if (summary.created > 0) {
            await notifyAdmins(admin, orgId, summary);
          }
          return { result: 'success', value: null };
        } catch (e) {
          void reportError(e, { tag: 'cron.auto-reorder.org', extra: { orgId } });
          return { result: 'failure', value: null };
        }
      },
    );

    // One line per run, counts only (no org ids).
    console.info(
      '[cron.auto-reorder]',
      JSON.stringify({
        candidates: candidates.length,
        orgsProcessed,
        posCreated,
        posSent,
        noActor,
        contextUnread,
        turnedOff,
        failed: sweep.failed,
        heldByAnotherRun: sweep.heldByAnotherRun,
        failingRepeatedly: sweep.failingRepeatedly,
        orderedBy: sweep.orderedBy,
        promoted: sweep.promoted,
        leftForNextRun: sweep.leftForNextRun,
        ms: Date.now() - startedAt,
      }),
    );

    return NextResponse.json({
      orgsProcessed,
      posCreated,
      posSent,
      candidates: candidates.length,
      heldByAnotherRun: sweep.heldByAnotherRun,
      leftForNextRun: sweep.leftForNextRun,
    });
  } catch (err) {
    return internalErrorResponse(err, 'cron.auto-reorder');
  }
}

/** The autoReorder part of an organization_modules row's settings. */
function autoReorderBucket(row: { settings?: unknown } | null | undefined): unknown {
  const settings = row?.settings;
  return settings && typeof settings === 'object'
    ? (settings as Record<string, unknown>).autoReorder
    : undefined;
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

  // What the run did to them: marked as ordered (runAutoReorder's
  // updateStatus 'ordered', the change the draft page's Mark as ordered
  // makes). Nothing is sent to the supplier, so it no longer says "sent"
  // (B105).
  const sentPart = summary.sent > 0 ? `, ${summary.sent} marked as ordered` : '';
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
