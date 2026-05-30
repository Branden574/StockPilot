import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import type { ConnectionRef } from '@stockpilot/core';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { CONNECTORS } from '@/server/connectors';
import { runDrain } from '@/server/connectors/drainer';
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
 */
async function runMonthlyValuation(
  admin: ReturnType<typeof createAdminClient>,
  now: Date,
): Promise<void> {
  const { data: conns, error } = await admin
    .from('org_connections')
    .select('*')
    .eq('status', 'active')
    .eq('provider_id', 'quickbooks');
  if (error) {
    void reportError(new Error(`valuation org_connections select: ${error.message}`), {
      tag: 'cron.drain-outbox.valuation',
    });
    return;
  }

  for (const c of (conns ?? []) as Array<Record<string, any>>) {
    try {
      // An active connection without a Vault handle is malformed (the OAuth
      // callback must set secret_id). Skip rather than throwing the whole pass.
      if (!c.secret_id || !c.external_account_id) continue;

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
    const result = await runDrain(admin, CONNECTORS, now);
    // Monthly valuation runs AFTER the drain and must never fail the response —
    // runMonthlyValuation swallows + reports its own errors.
    await runMonthlyValuation(admin, now);
    return NextResponse.json(result);
  } catch (err) {
    void reportError(err, { tag: 'cron.drain-outbox' });
    return NextResponse.json(
      {
        error: 'internal_error',
        message: err instanceof Error ? err.message : 'Drain run failed',
      },
      { status: 500 },
    );
  }
}
