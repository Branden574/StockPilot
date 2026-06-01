import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { ShippingService, type CarrierShipmentRow } from '@/server/services/shipping';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The reaper iterates stuck shipments and makes one EasyPost GET per row over
// the network; bump generously like cron/weekly-digest and cron/drain-outbox.
export const maxDuration = 60;

// Rows stuck in 'purchasing' longer than this are presumed stranded by a crash
// or serverless timeout between the buy claim and the finalize. A live buy
// completes in seconds, so 30 minutes is a generous safety margin that can
// never reap a normal in-flight purchase.
const STALE_MINUTES = 30;

/**
 * Constant-time string compare. A naive `a !== b` short-circuits at the
 * first differing byte and leaks the length of the matching prefix
 * through timing. timingSafeEqual compares every byte regardless of
 * mismatch position. Copied from cron/drain-outbox.
 */
function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Stuck-shipment reaper. Wired to Vercel Cron via vercel.json (hourly). Uses the
 * service-role client to span all orgs and find every carrier_shipments row
 * stranded in 'purchasing' (a crash / serverless timeout between buyLabel's
 * claim and its finalize). For each stale row, reconcile against EasyPost: a
 * completed (charged) buy is finalized to 'purchased'; a buy that never
 * completed is reset to 'draft' so the order can be re-bought. WITHOUT this, the
 * 0150 partial unique index permanently blocks every future buy for the order.
 *
 * NEVER re-buys: reapStuckShipment only GETs the EasyPost shipment and copies an
 * already-charged label or reopens a row that definitively never got one.
 *
 * Auth: same Bearer ${CRON_SECRET} pattern as cron/drain-outbox — fail-closed
 * when CRON_SECRET is unset/empty so an unauthenticated GET can't trigger an
 * org-wide reconcile run.
 */
export async function GET(req: Request) {
  if (!env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const auth = req.headers.get('authorization') ?? '';
  if (!secretsEqual(auth, `Bearer ${env.CRON_SECRET}`)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let finalized = 0;
  let reopened = 0;
  let skipped = 0;
  let failed = 0;

  try {
    const admin = createAdminClient();
    const staleBefore = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString();

    // Only rows that have been 'purchasing' for at least STALE_MINUTES — a live
    // buy that's mid-flight (claim just fired) must never be reaped.
    const { data: stuck, error } = await admin
      .from('carrier_shipments')
      .select('*')
      .eq('status', 'purchasing')
      .lt('updated_at', staleBefore);
    if (error) throw new Error(error.message);

    for (const row of (stuck ?? []) as CarrierShipmentRow[]) {
      try {
        const outcome = await ShippingService.reapStuckShipment(admin, row);
        if (outcome === 'purchased') finalized += 1;
        else if (outcome === 'draft') reopened += 1;
        else skipped += 1;
      } catch (rowErr) {
        // Per-row isolation: one org's reconcile failure (EasyPost down, missing
        // key) can't block the rest. The row stays 'purchasing' and is retried
        // next run.
        failed += 1;
        void reportError(rowErr, {
          tag: 'cron.reap-stuck-shipments.row',
          extra: { shipmentId: row.id, organizationId: row.organization_id },
        });
      }
    }

    return NextResponse.json({ ok: true, finalized, reopened, skipped, failed });
  } catch (err) {
    void reportError(err, { tag: 'cron.reap-stuck-shipments' });
    return NextResponse.json(
      {
        error: 'internal_error',
        message: err instanceof Error ? err.message : 'Reap run failed',
        finalized,
        reopened,
        skipped,
        failed,
      },
      { status: 500 },
    );
  }
}
