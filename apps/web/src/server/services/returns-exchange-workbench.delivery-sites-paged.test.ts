import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ceiling, reportError } = vi.hoisted(() => ({
  // The shared LOOKUP_ROW_CEILING, lowered by the ceiling test.
  ceiling: { value: 10_000 },
  reportError: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock('./lib/fetch-by-ids', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/fetch-by-ids')>()),
  reportDegradedRead: vi.fn(),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
// A getter, so a test can lower the ceiling: the service reads the binding on
// every call.
vi.mock('@/server/services/lib/lookup-ceiling', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/lib/lookup-ceiling')>()),
  get LOOKUP_ROW_CEILING() {
    return ceiling.value;
  },
}));

import {
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
  type QueryResult,
  type SupabaseStub,
} from '@/test/supabase-mock';

import { reportDegradedRead } from './lib/fetch-by-ids';
import { readDeliverySites } from './returns-exchange-workbench';

/**
 * The returns exchange chooser offers a delivery replacement to the active
 * sites the return's warehouse serves, from its warehouse_charters links. That
 * read had no order and no range, and archived charters' links count too (the
 * active filter runs after the read), so past 1000 links on one warehouse
 * PostgREST answered an arbitrary 1000 with no error and the rest could not be
 * chosen (B47 part B). It is now read page by page, ordered by charter. A
 * failed page still answers [] with a degraded-read report, never a partial
 * list.
 */

const ORG = 'org-test';
const W = '00000000-0000-4000-8000-0000000000a1';
const OTHER_WH = '00000000-0000-4000-8000-0000000000a2';

const charterId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

function link(i: number, status: string, warehouseId = W, organizationId = ORG) {
  return {
    organization_id: organizationId,
    warehouse_id: warehouseId,
    charter_id: charterId(i),
    charter: { id: charterId(i), name: `Site ${String(i).padStart(4, '0')}`, status },
  };
}

// 1,200 active links on W stored after 30 archived ones, plus another
// warehouse's and another organization's links that are never listed.
const ACTIVE = Array.from({ length: 1200 }, (_, i) => link(i, 'active'));
const LINKS = [
  ...Array.from({ length: 30 }, (_, i) => link(5000 + i, 'archived')),
  ...ACTIVE,
  ...Array.from({ length: 5 }, (_, i) => link(8000 + i, 'active', OTHER_WH)),
  ...Array.from({ length: 3 }, (_, i) => link(9000 + i, 'active', W, 'org-other')),
];

function pageArgs(stub: SupabaseStub, page: number, method: string): unknown[][] {
  const methods = stub.chainsAll.get('warehouse_charters.select')?.[page] ?? [];
  const args = stub.chainArgsAll.get('warehouse_charters.select')?.[page] ?? [];
  return methods.flatMap((m, i) => (m === method ? [args[i]!] : []));
}

function stubWith(select: (call: MockCall) => QueryResult) {
  const stub = makeSupabaseStub({ 'warehouse_charters.select': select });
  return { stub, ctx: makeServiceContext(stub.client) as never };
}

beforeEach(() => {
  vi.mocked(reportDegradedRead).mockClear();
  reportError.mockClear();
  ceiling.value = 10_000;
});

describe('readDeliverySites: every active site of the warehouse, past 1000 links', () => {
  it('returns all 1,200 active sites sorted by name then id, in two pages ordered by charter', async () => {
    const { stub, ctx } = stubWith(servedLikePostgrest(LINKS));

    const sites = await readDeliverySites(ctx, W);

    expect(sites).toEqual(
      ACTIVE.map((l) => ({ id: l.charter.id, name: l.charter.name })).sort(
        (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
      ),
    );
    expect(stub.chainsAll.get('warehouse_charters.select')).toHaveLength(2);
    expect(pageArgs(stub, 0, 'order').map((a) => a[0])).toEqual(['charter_id']);
    expect(pageArgs(stub, 0, 'range')).toEqual([[0, 999]]);
    expect(pageArgs(stub, 1, 'range')).toEqual([[1000, 1999]]);
    // Every page keeps the organization and the warehouse.
    for (const page of [0, 1]) {
      expect(pageArgs(stub, page, 'eq')).toEqual(
        expect.arrayContaining([
          ['organization_id', ORG],
          ['warehouse_id', W],
        ]),
      );
    }
    expect(reportDegradedRead).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  /**
   * B47 decisions round (2026-11-01): the read stops at LOOKUP_ROW_CEILING
   * links, the first by charter, and reports it once with the warehouse only;
   * the chooser offers those links' active sites, by name.
   */
  it('stops at the ceiling: the active sites of the first links by charter, by name, reported once', async () => {
    ceiling.value = 1100;
    const { stub, ctx } = stubWith(servedLikePostgrest(LINKS));

    const sites = await readDeliverySites(ctx, W);

    expect(sites).toEqual(
      ACTIVE.slice(0, 1100)
        .map((l) => ({ id: l.charter.id, name: l.charter.name }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    );
    expect(pageArgs(stub, 1, 'range')).toEqual([[1000, 1099]]);
    expect(reportDegradedRead).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]?.[1]).toMatchObject({
      tag: 'lookup_ceiling.returns.workbench.delivery_sites',
      extra: { lookup: 'returns.workbench.delivery_sites', warehouseId: W },
    });
  });

  it('a failed second page answers [] with one degraded-read report, never a partial list', async () => {
    const served = servedLikePostgrest(LINKS);
    let calls = 0;
    const { ctx } = stubWith((call) => {
      calls += 1;
      return calls === 1 ? served(call) : { data: null, error: { message: 'statement timeout' } };
    });

    const sites = await readDeliverySites(ctx, W);

    expect(sites).toEqual([]);
    expect(calls).toBe(2);
    expect(reportDegradedRead).toHaveBeenCalledTimes(1);
    expect(reportDegradedRead).toHaveBeenCalledWith(
      'returns.workbench.delivery_sites',
      expect.anything(),
      {
        warehouseId: W,
      },
    );
  });

  it('no warehouse: [] with no read', async () => {
    const { stub, ctx } = stubWith(servedLikePostgrest(LINKS));

    await expect(readDeliverySites(ctx, null)).resolves.toEqual([]);
    expect(stub.fromCalls).toEqual([]);
  });
});
