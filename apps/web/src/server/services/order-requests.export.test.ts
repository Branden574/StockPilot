import { describe, expect, it } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

import { OrderRequestsService } from './order-requests';

/**
 * Service-layer coverage for exportRows() pagination.
 *
 * The Supabase Data API caps any single response at [api] max_rows = 1000
 * (supabase/config.toml). exportRows() must therefore loop with .range()
 * in <=1000-row pages until it has assembled every matching row up to the
 * cap — a single `.range(0, cap-1)` would silently return only the newest
 * 1000 rows. These tests drive the stub to hand out successive pages and
 * assert the assembled result + reported total.
 */

function makeRow(i: number): Record<string, unknown> {
  return {
    id: `order-${i.toString().padStart(8, '0')}`,
    status: 'completed',
    requester_user_id: null,
    requester_email: null,
    requester_name: `Req ${i}`,
    requester_org_label: null,
    source: 'internal',
    notes: null,
    created_at: '2026-05-01T10:00:00.000Z',
    updated_at: '2026-05-01T10:00:00.000Z',
    approved_at: null,
    delivered_at: null,
    completed_at: '2026-05-02T09:00:00.000Z',
    fulfillment_type: 'pickup',
    delivery_charter_id: null,
    warehouse: { name: 'Main WH' },
    charter: null,
    lines: [{ quantity_requested: 2, unit_cost_at_request: 5 }],
    requester: null,
  };
}

/**
 * A stub whose order_requests.select returns successive pages of size
 * PAGE_SIZE (1000) drawn from a synthetic dataset of `dataSize` rows.
 * Mirrors PostgREST: the exact `count` is always the full dataset size;
 * each page returns at most PAGE_SIZE rows for the requested range.
 */
function pagedStub(dataSize: number) {
  const PAGE = 1000;
  let pageIndex = 0;
  const result = (): QueryResult => {
    const start = pageIndex * PAGE;
    const slice: Record<string, unknown>[] = [];
    for (let i = start; i < Math.min(start + PAGE, dataSize); i += 1) {
      slice.push(makeRow(i));
    }
    pageIndex += 1;
    return { data: slice, error: null, count: dataSize };
  };
  return makeSupabaseStub({ 'order_requests.select': result });
}

function svc(stub: ReturnType<typeof makeSupabaseStub>) {
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, {
      enabledModules: new Set<ModuleId>(['orders']),
    }),
  );
}

describe('OrderRequestsService.exportRows pagination', () => {
  it('returns a single page unchanged when the dataset fits in one batch', async () => {
    const stub = pagedStub(250);
    const { rows, total } = await svc(stub).exportRows({ cap: 10_000 });
    expect(rows).toHaveLength(250);
    expect(total).toBe(250);
    // One page was enough — short page stops the loop without a second query.
    const ranges = stub.chainArgsAll.get('order_requests.select') ?? [];
    expect(ranges).toHaveLength(1);
  });

  it('loops across multiple pages and assembles every row past the 1000 cap', async () => {
    const stub = pagedStub(2300);
    const { rows, total } = await svc(stub).exportRows({ cap: 10_000 });
    // 1000 + 1000 + 300 — the naive single-range version would return 1000.
    expect(rows).toHaveLength(2300);
    expect(total).toBe(2300);
    // First id from page 1 and last id from page 3 both present (ordering preserved).
    expect(rows[0]?.id).toBe('order-00000000');
    expect(rows[2299]?.id).toBe('order-00002299');
    const ranges = stub.chainArgsAll.get('order_requests.select') ?? [];
    expect(ranges.length).toBeGreaterThanOrEqual(3);
  });

  it('stops at the cap and reports the true (larger) total for the truncation sentinel', async () => {
    const stub = pagedStub(5000);
    const { rows, total } = await svc(stub).exportRows({ cap: 2000 });
    expect(rows).toHaveLength(2000);
    // total is the real count, so the route prints "exported 2000 of 5000".
    expect(total).toBe(5000);
  });
});
