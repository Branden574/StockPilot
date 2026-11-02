import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import type { ConnectionRef } from '@stockpilot/core';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { CONNECTORS } from '@/server/connectors';
import {
  CONNECTOR_START_RESERVE_MS,
  DRAIN_OUTBOX_DEADLINE_MS,
  enabledIntegrationOrgIds,
  runDrain,
} from '@/server/connectors/drainer';
import { internalErrorResponse } from '@/server/lib/api-error-response';
import {
  drainIntegrationDeliveries,
  WEBHOOK_DRAIN_SHARE_MS,
} from '@/server/services/integration-events';
import { sweepExpiredImpersonations } from '@/server/services/platform/impersonation';
import { quickbooksConnector } from '@/server/connectors/quickbooks';
import { QboClient, type QboEnv } from '@/server/connectors/quickbooks/client';
import { maybePostMonthlyValuation } from '@/server/connectors/quickbooks/valuation';
import { getConnectionSecret, putConnectionSecret } from '@/server/connectors/secret-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Vercel default function timeout is 10s for Hobby. The drainer iterates every
// active connection × its candidate outbox events and dispatches over the
// network; bump generously like cron/weekly-digest.
export const maxDuration = 60;

/**
 * Constant-time string compare. A naive `a !== b` short-circuits at the
 * first differing byte and leaks the length of the matching prefix
 * through timing. timingSafeEqual compares every byte regardless of
 * mismatch position. Copied from cron/weekly-digest.
 */
function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Monthly inventory-valuation pass, run AFTER the outbox drain on the same
 * every-5-min cron (month-gated inside maybePostMonthlyValuation — no second
 * cron, per spec open-item 3). For each active QuickBooks connection: refresh
 * the access token if it's near expiry (re-persisting the rotated secret to
 * Vault, reusing the same secret-store helpers the drainer uses), build a
 * QboClient, and post the month's valuation JE.
 *
 * FAIL-OPEN: any failure here is reported and swallowed — it must NEVER fail the
 * drain response. The drain already did the load-bearing work; a valuation hiccup
 * shouldn't 500 the cron.
 *
 * No connection is started with less than CONNECTOR_START_RESERVE_MS left before
 * the run's `deadlineAt` (docket B81). The pass is month-gated and posts with a
 * fixed requestid, so a connection skipped now is posted at a later tick.
 * Answers true when the deadline left a connection to post for the next tick.
 */
async function runMonthlyValuation(
  admin: ReturnType<typeof createAdminClient>,
  now: Date,
  deadlineAt: number,
): Promise<boolean> {
  const { data: conns, error } = await admin
    .from('org_connections')
    .select('*')
    .eq('status', 'active')
    .eq('provider_id', 'quickbooks');
  if (error) {
    void reportError(new Error(`valuation org_connections select: ${error.message}`), {
      tag: 'cron.drain-outbox.valuation',
    });
    return false;
  }

  // Module-enabled gate (same as runDrain): an org that disabled the
  // 'integrations' module must get ZERO valuation JEs posted. FAIL-CLOSED — if
  // the gate query errors, report and treat every org as disabled (post
  // nothing) rather than pushing a JE against a possibly-disabled module.
  const orgIds = Array.from(new Set((conns ?? []).map((c) => c.organization_id as string)));
  let enabledOrgIds: Set<string>;
  try {
    enabledOrgIds = await enabledIntegrationOrgIds(admin, orgIds);
  } catch (gateErr) {
    void reportError(gateErr, { tag: 'cron.drain-outbox.valuation.module-gate' });
    return false;
  }

  for (const c of (conns ?? []) as Array<Record<string, any>>) {
    // Skip orgs whose integrations module is disabled — no JournalEntry post.
    if (!enabledOrgIds.has(c.organization_id)) continue;
    // An active connection without a Vault handle is malformed (the OAuth
    // callback must set secret_id). Skip rather than throwing the whole pass.
    if (!c.secret_id || !c.external_account_id) continue;
    // A connection left for time is posted at a later tick.
    if (deadlineAt - Date.now() < CONNECTOR_START_RESERVE_MS) return true;
    try {
      const conn: ConnectionRef = {
        id: c.id,
        organizationId: c.organization_id,
        providerId: c.provider_id,
        status: c.status,
        externalAccountId: c.external_account_id,
        settings: c.settings ?? {},
      };

      // Refresh-if-expiring then re-persist, mirroring the drainer's token logic
      // (the secret-store helpers take the service-role rpc seam — same `as any`
      // cast the drainer uses).
      let secrets = await getConnectionSecret(admin as any, c.secret_id);
      if (
        quickbooksConnector.refreshAuth &&
        new Date(secrets.expiresAt).getTime() < now.getTime() + 5 * 60 * 1000
      ) {
        secrets = await quickbooksConnector.refreshAuth(conn, secrets);
        const newSecretId = await putConnectionSecret(admin as any, `connector:${conn.id}`, secrets);
        if (newSecretId && newSecretId !== c.secret_id) {
          await admin
            .from('org_connections')
            .update({ secret_id: newSecretId, updated_at: now.toISOString() })
            .eq('id', conn.id);
        }
      }

      const qboEnv: QboEnv = (conn.settings as { env?: QboEnv }).env ?? env.QBO_ENV;
      const client = new QboClient(c.external_account_id, secrets, qboEnv);
      await maybePostMonthlyValuation(admin, conn, client, now);
    } catch (err) {
      // Per-connection isolation: one org's valuation failure can't block others
      // or the drain response.
      void reportError(err, {
        tag: 'cron.drain-outbox.valuation',
        extra: { connectionId: c.id },
      });
    }
  }
  return false;
}

type WebhookDrainResult = Awaited<ReturnType<typeof drainIntegrationDeliveries>>;

/**
 * The webhook drain's second pass, to the run's deadline, after its share
 * left due deliveries unstarted. Its counts add to the share's, and whether
 * it left any decides the answer's `skipped`. Never throws: should the drain
 * ever reject, the rows the share left are counted as still waiting.
 */
async function drainRest(
  admin: ReturnType<typeof createAdminClient>,
  now: Date,
  deadlineAt: number,
  share: WebhookDrainResult,
): Promise<WebhookDrainResult> {
  const rest: WebhookDrainResult = await drainIntegrationDeliveries(admin, now, undefined, {
    deadlineAt,
  }).catch(() => ({ attempted: 0, delivered: 0, skipped: 'deadline' as const }));
  return {
    attempted: share.attempted + rest.attempted,
    delivered: share.delivered + rest.delivered,
    ...(rest.skipped ? { skipped: rest.skipped } : {}),
  };
}

/**
 * Outbox drainer. Wired to Vercel Cron via vercel.json (every 5 minutes).
 * Uses the service-role client to span all orgs and fan each outbox event out
 * to every active connector. One-way export only — connectors never write back
 * into StockPilot.
 *
 * Auth: same Bearer ${CRON_SECRET} pattern as cron/weekly-digest.
 *
 * Spec: docs/superpowers/specs/2026-05-30-warehouse-os-phase3a-connector-framework-quickbooks-design.md
 */
export async function GET(req: Request) {
  // Fail-closed when CRON_SECRET is unset/empty so an unauthenticated GET can't
  // trigger an org-wide export run. Matches cron/weekly-digest.
  if (!env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const auth = req.headers.get('authorization') ?? '';
  if (!secretsEqual(auth, `Bearer ${env.CRON_SECRET}`)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const admin = createAdminClient();
    const now = new Date();
    // One deadline for this run (docket B81): no stage starts anything it
    // could not finish before it, inside maxDuration. The webhook drain's
    // share ends earlier.
    const deadlineAt = now.getTime() + DRAIN_OUTBOX_DEADLINE_MS;
    // Retry any pending webhook/Slack/Teams deliveries with backoff. FIRST, and
    // inside its own share of the run: run last, it was left no time whenever
    // the exports used the run (docket B81). Self-contained + never throws
    // (mirrors the valuation fail-open posture).
    const share: WebhookDrainResult = await drainIntegrationDeliveries(admin, now, undefined, {
      deadlineAt: now.getTime() + WEBHOOK_DRAIN_SHARE_MS,
    }).catch(() => ({ attempted: 0, delivered: 0 }));
    const result = await runDrain(admin, CONNECTORS, now, { deadlineAt });
    // Monthly valuation runs AFTER the drain and must never fail the response —
    // runMonthlyValuation swallows + reports its own errors.
    const valuationSkipped = await runMonthlyValuation(admin, now, deadlineAt);
    // Safety net: revoke any expired platform-admin "act as" grants globally,
    // so an impersonation that was never explicitly exited still auto-expires.
    // Fail-open — never blocks the drain response. Before the webhook drain's
    // second pass, so it never waits on deliveries.
    await sweepExpiredImpersonations(now.getTime()).catch((e) =>
      reportError(e, { tag: 'cron.impersonation-sweep' }),
    );
    // The webhook drain takes back the time the exports and the valuation left
    // (docket B81 review). Its share starts deliveries for its first 7 s only:
    // ten to a host that hangs to the 8 s timeout fill it, so drained only
    // once, every other due alert would wait a tick even when the exports had
    // nothing to do (run last, the drain had 30 s of its own). When the share
    // left due deliveries unstarted, it drains again to the run's deadline,
    // from the same `now`: the rows the share started are leased or backed off
    // by now, so this pass reads only the ones left. It starts nothing with
    // less than CLAIM_LEASE_MS left (and reads nothing then), so it ends inside
    // the run.
    const webhooks = share.skipped ? await drainRest(admin, now, deadlineAt, share) : share;
    // NO SILENT CUTS: a stage the deadline cut short says so, in the answer
    // (skipped: 'deadline') and in one log line, never as an empty success.
    const cut = [
      webhooks.skipped ? 'webhooks' : null,
      result.skipped ? 'exports' : null,
      valuationSkipped ? 'valuation' : null,
    ].filter((stage) => stage !== null);
    if (cut.length > 0) {
      console.warn(
        `[drain-outbox] stopped at the run deadline, the rest waits for the next tick: ${cut.join(', ')}`,
      );
    }
    return NextResponse.json({
      ...result,
      webhooks,
      ...(valuationSkipped ? { valuation: { skipped: 'deadline' } } : {}),
    });
  } catch (err) {
    return internalErrorResponse(err, 'cron.drain-outbox');
  }
}
