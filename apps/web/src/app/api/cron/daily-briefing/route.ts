import { timingSafeEqual } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import {
  loadEffectivePermissions,
  PermissionsUnavailableError,
} from '@/lib/auth/effective-permissions';
import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { internalErrorResponse } from '@/server/lib/api-error-response';
import { DAILY_CLAIM_HOLD_MS, sweepOrganizations } from '@/server/services/lib/cron-sweep';
import { fetchAllRows } from '@/server/services/lib/paginate';
import { systemContextLoader } from '@/server/services/lib/system-context';
import { createNotification } from '@/server/services/notifications';
import { gatherInsightsForCtx, summarizeInsights } from '@/server/services/insights';
import { insightsVisibleTo, type InsightReader } from '@/server/services/insights-access';

import { can, type Role } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Stop STARTING organizations after this long: an organization in flight
 *  then has a minute (its summary is raced against 10 s) before maxDuration. */
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
 * Daily insights briefing — the proactive sibling of the on-demand
 * /dashboard/insights page. Weekday mornings, for every org with the `ai`
 * module enabled, gather the actionable signals (pending approvals, overdue
 * POs, low stock, open counts/POs) and push ONE in-app + push notification to
 * each of the org's owners/admins linking to the insights page. Each one reads
 * only the lines their own permissions let them open (docket S36: their
 * overrides apply, as on the page), and nobody who cannot open the page
 * (items:update) is told. Quiet by design:
 *  - zero signals, or zero lines for a reader → no notification for them,
 *  - one briefing per user per day (skips when today's already exists), so a
 *    cron re-fire never double-notifies.
 * CRON_SECRET-gated; FAIL-OPEN per org (one org's error never blocks the rest).
 *
 * The per-person check is a read, then an insert, so it is not atomic: two
 * runs at once could both pass it. What keeps them apart is the day's claim
 * on the organization below, and when that claim cannot be recorded the
 * organization is SKIPPED for this run (onClaimUnavailable 'skip'), never
 * worked unclaimed. It is counted in the log line (claimUnavailable),
 * reported once per run, and goes first on the next run.
 *
 * Order: the organizations this job reached longest ago first
 * (cron_sweep_attempts, job 'daily_briefing'), so a run cut by its deadline
 * leaves different organizations each day, and those go first the next run.
 * One log line per run says how many it left.
 *
 * ONE RUN PER ORGANIZATION PER 20 HOURS (DAILY_CLAIM_HOLD_MS). A manual run
 * does nothing for an organization another run started in the last 20 hours,
 * including one whose attempt failed (it waits for the next day's run), and a
 * manual run late in the day makes the next scheduled run skip the
 * organizations it started (they are reached the day after).
 */
export async function GET(req: NextRequest) {
  if (!env.CRON_SECRET) {
    return NextResponse.json({ error: 'cron_disabled' }, { status: 503 });
  }
  const auth = req.headers.get('authorization') ?? '';
  if (!secretsEqual(auth, `Bearer ${env.CRON_SECRET}`)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();
  const admin = createAdminClient();
  let orgsProcessed = 0;
  let briefingsSent = 0;
  let noActor = 0;
  let contextUnread = 0;
  let turnedOff = 0;
  const loadContext = systemContextLoader(admin, 'cron.daily-briefing.context');

  try {
    // Orgs with the ai module on — the same gate as the insights page.
    const modRows = await fetchAllRows<{ organization_id: string }>((from, to) =>
      admin
        .from('organization_modules')
        .select('organization_id')
        .eq('module_id', 'ai')
        .eq('enabled', true)
        .order('organization_id', { ascending: true })
        .range(from, to),
    );

    // Least recently reached first, each organization claimed as it starts
    // (sweepOrganizations, job 'daily_briefing'): a second delivery of this
    // tick, or a manual run the same day, skips every organization this run
    // has started, so the per-user check below (read, then insert) is not
    // raced by another run. An organization whose claim cannot be recorded
    // is skipped for this run ('skip'): run unclaimed, the per-user check
    // alone could let two runs at once both send.
    const sweep = await sweepOrganizations(
      admin,
      {
        job: 'daily_briefing',
        tag: 'cron.daily-briefing',
        orgIds: modRows.map((r) => r.organization_id),
        deadlineAt: startedAt + RUN_DEADLINE_MS,
        slotMs: DAY_MS,
        holdMs: DAILY_CLAIM_HOLD_MS,
        onClaimUnavailable: 'skip',
      },
      async (orgId): Promise<{ result: 'success' | 'failure' | 'neither'; value: null }> => {
        try {
          const loaded = await loadContext(orgId);
          // A failed read of the owner/admin or the module set is a failure
          // (reported once per run), never "no owner" or "no modules". Only
          // an organization whose reads answered with no owner/admin to
          // attribute to is skipped, and that is not a failure: it would count
          // against the organization every day.
          if (!loaded.ok) {
            if (loaded.reason === 'read_failed') {
              contextUnread += 1;
              return { result: 'failure', value: null };
            }
            noActor += 1;
            return { result: 'neither', value: null };
          }
          const ctx = loaded.ctx;
          // The organization was picked because its ai module is on, and its
          // module set was read just now (a failed read is a failure above),
          // so a set without ai means ai was turned off since the list was
          // read: skipped for this run like any organization with ai off, not
          // a failure.
          if (!ctx.enabledModules.has('ai')) {
            turnedOff += 1;
            return { result: 'neither', value: null };
          }
          orgsProcessed += 1;

          // Every line the counts produce, then the lines the organization can
          // open: the cron's context is the owner (loadSystemContext), so its
          // view is the module rules alone. A line whose module is off is counted
          // anyway (the counts ask no module) and no reader is ever shown it.
          const gathered = await gatherInsightsForCtx(ctx);
          const insights = insightsVisibleTo(gathered, ctx);
          if (insights.signals.length === 0) return { result: 'success', value: null }; // quiet day — say nothing

          // Who may be told: the accepted owners and admins, never an Act-as
          // seat, with their role (their permissions are read below). A failed
          // read is not "nobody": it is reported and the organization is
          // skipped for this run.
          const { data: recipients, error: recipientsError } = await admin
            .from('organization_members')
            .select('user_id, role')
            .eq('organization_id', orgId)
            .in('role', ['owner', 'admin'])
            .not('accepted_at', 'is', null)
            .is('impersonation_expires_at', null);
          if (recipientsError || !Array.isArray(recipients)) {
            void reportError(new Error('Daily briefing recipients could not be read'), {
              tag: 'cron.daily-briefing.recipients',
              organizationId: orgId,
              extra: { code: recipientsError?.code ?? 'unexpected' },
            });
            return { result: 'failure', value: null };
          }

          // Narrative is a graceful enhancement; the signal lines stand alone.
          // It is written from every line the organization can open, so it goes
          // only to a recipient who reads all of them, and only once per
          // organization, when the first such recipient needs it. 10s race so
          // one slow Gemini call can't eat the 300s budget across a multi-org
          // fan-out (summarizeInsights itself never throws).
          let narrative: Promise<string | null> | null = null;
          const fullNarrative = () =>
            (narrative ??= Promise.race([
              summarizeInsights(insights),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
            ]));

          const startOfToday = new Date();
          startOfToday.setUTCHours(0, 0, 0, 0);
          let skippedUnreadable = 0;

          for (const m of recipients as Array<{ user_id: string; role: Role }>) {
            // Each recipient's own permissions, overrides applied (the page reads
            // the same set). An admin's that cannot be read is skipped for this
            // run, never told with the role's defaults; the loader reports the
            // read and the count is reported once below. The owner's never throws.
            let permissions: InsightReader['permissions'];
            try {
              permissions = await loadEffectivePermissions(admin, orgId, m.user_id, m.role);
            } catch (e) {
              if (!(e instanceof PermissionsUnavailableError)) throw e;
              skippedUnreadable += 1;
              continue;
            }
            const reader: InsightReader = {
              role: m.role,
              permissions,
              enabledModules: ctx.enabledModules,
            };
            // The briefing page's own gate: nobody is told of a page they cannot open.
            if (!can(reader, 'items:update')) continue;
            const lines = insightsVisibleTo(insights, reader).signals;
            if (lines.length === 0) continue;

            // One briefing per user per day — idempotent across cron re-fires.
            // Read-then-insert (not atomic) on its own; two runs at once never
            // reach this for the same organization, because a run reaches it
            // only for an organization it has claimed for the day
            // (sweepOrganizations above). An organization whose claim cannot
            // be recorded is skipped for the run before this point.
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

            // Title, lines and metadata from this recipient's own lines.
            const top = lines
              .slice(0, 3)
              .map((s) => `${s.count} ${s.label}`)
              .join(' · ');
            const title = `Morning briefing: ${lines.length} thing${
              lines.length === 1 ? '' : 's'
            } need${lines.length === 1 ? 's' : ''} attention`;
            const seesEveryLine = lines.length === insights.signals.length;
            const body = (seesEveryLine ? await fullNarrative() : null) ?? top;

            await createNotification({
              organizationId: orgId,
              userId: m.user_id,
              type: 'insights.daily_briefing',
              title,
              body,
              link: '/dashboard/insights',
              metadata: {
                signalKeys: lines.map((s) => s.key),
                counts: Object.fromEntries(lines.map((s) => [s.key, s.count])),
              },
            });
            briefingsSent += 1;
          }

          if (skippedUnreadable > 0) {
            void reportError(
              new Error('Daily briefing skipped admins whose permissions could not be read'),
              {
                tag: 'cron.daily-briefing.overrides',
                level: 'warning',
                organizationId: orgId,
                extra: { skipped: skippedUnreadable },
              },
            );
          }
          return { result: 'success', value: null };
        } catch (e) {
          void reportError(e, { tag: 'cron.daily-briefing.org', extra: { orgId } });
          return { result: 'failure', value: null };
        }
      },
    );

    // One line per run, counts only (no org ids).
    console.info(
      '[cron.daily-briefing]',
      JSON.stringify({
        candidates: modRows.length,
        orgsProcessed,
        briefingsSent,
        noActor,
        contextUnread,
        turnedOff,
        failed: sweep.failed,
        heldByAnotherRun: sweep.heldByAnotherRun,
        claimUnavailable: sweep.claimUnavailable,
        failingRepeatedly: sweep.failingRepeatedly,
        orderedBy: sweep.orderedBy,
        promoted: sweep.promoted,
        leftForNextRun: sweep.leftForNextRun,
        ms: Date.now() - startedAt,
      }),
    );

    return NextResponse.json({
      orgsProcessed,
      briefingsSent,
      heldByAnotherRun: sweep.heldByAnotherRun,
      leftForNextRun: sweep.leftForNextRun,
    });
  } catch (err) {
    return internalErrorResponse(err, 'cron.daily-briefing');
  }
}
