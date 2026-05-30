import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { CONNECTORS } from '@/server/connectors';
import { runDrain } from '@/server/connectors/drainer';

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
    const result = await runDrain(createAdminClient(), CONNECTORS, new Date());
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
