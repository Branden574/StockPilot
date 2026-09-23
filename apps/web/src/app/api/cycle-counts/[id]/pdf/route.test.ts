import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { CycleCountsService } from '@/server/services/cycle-counts';
import { ProductGroupsService } from '@/server/services/product-groups';
import { WarehousesService } from '@/server/services/warehouses';
import { makeSupabaseStub } from '@/test/supabase-mock';

import type { CycleCountPdfLine } from '@/lib/pdf/cycle-count';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/export-rate-limit', () => ({ exportRateLimited: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/server/services/cycle-counts', () => ({ CycleCountsService: vi.fn() }));
vi.mock('@/server/services/product-groups', () => ({ ProductGroupsService: vi.fn() }));
vi.mock('@/server/services/warehouses', () => ({ WarehousesService: vi.fn() }));
vi.mock('@/server/services/rack-holdings', () => ({
  fetchRackHoldingsByItem: vi.fn(async () => new Map()),
}));
vi.mock('@/server/services/audit', () => ({ audit: vi.fn() }));
vi.mock('@react-pdf/renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@react-pdf/renderer')>();
  return { ...actual, renderToStream: vi.fn(async () => ({}) as never) };
});

// Imported AFTER the mocks above so the route picks them up.
import { renderToStream } from '@react-pdf/renderer';
import { GET } from './route';

/**
 * Task 17 review fix (MINOR 3): `groupId` used to be set unconditionally on
 * each printed line while `groupName` was gated on the sports module. An item
 * can carry a non-null `group_id` even in a module-off org (the column isn't
 * cleared when sports is disabled), and `groupCountSheetLines()` (the PDF's
 * own grouping logic) only checks `groupId` to decide whether to print group
 * blocks — so a module-off org's count sheet printed a "Product group" header
 * (falling back on that literal string since groupName was null) instead of
 * the flat sheet it's supposed to render. Both fields must gate on the same
 * module check.
 *
 * These tests capture the props the route hands to <CycleCountSheetPdf/> by
 * mocking `renderToStream` — react-pdf never actually renders, so the real
 * PDF byte stream is never built; the element's `.props` are inspected
 * directly instead.
 */
function groupedLine(): {
  id: string;
  cycle_count_id: string;
  item_id: string;
  warehouse_id: string | null;
  expected_quantity: number;
  counted_quantity: number | null;
  reason: string | null;
  notes: string | null;
  counted_by: string | null;
  counted_at: string | null;
  item: {
    id: string;
    name: string;
    sku: string;
    unit_of_measure: string;
    barcode: string | null;
    group_id: string | null;
    variant_size: string | null;
    jersey_number: string | null;
  };
} {
  return {
    id: 'line-1',
    cycle_count_id: 'cc-1',
    item_id: 'item-1',
    warehouse_id: 'wh-a',
    expected_quantity: 6,
    counted_quantity: null,
    reason: null,
    notes: null,
    counted_by: null,
    counted_at: null,
    item: {
      id: 'item-1',
      name: 'Pegasus 41',
      sku: 'PEG-9',
      unit_of_measure: 'pair',
      barcode: null,
      group_id: 'grp-1',
      variant_size: '9',
      jersey_number: null,
    },
  };
}

function header() {
  return {
    id: 'cc-1',
    organization_id: 'org-1',
    warehouse_id: null,
    status: 'in_progress' as const,
    notes: null,
    started_by: 'user-1',
    started_at: '2026-07-01T00:00:00.000Z',
    completed_by: null,
    completed_at: null,
    canceled_by: null,
  };
}

function ctxWith(enabledModules: Set<ModuleId>) {
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    role: 'admin' as const,
    supabase: makeSupabaseStub({
      'inventory_items.select': { data: [], error: null },
      'organizations.select': { data: { name: 'Acme', logo_url: null }, error: null },
    }).client,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules,
  };
}

function req() {
  return new NextRequest('https://test.local/api/cycle-counts/cc-1/pdf');
}

async function paramsFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

function capturedLines(): CycleCountPdfLine[] {
  const call = vi.mocked(renderToStream).mock.calls[0];
  const element = call?.[0] as unknown as { props: { lines: CycleCountPdfLine[] } };
  return element.props.lines;
}

describe('GET /api/cycle-counts/[id]/pdf — group fields gated on the sports module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(exportRateLimited).mockResolvedValue(null as never);
    vi.mocked(CycleCountsService).mockImplementation(function () {
      return { get: async () => ({ header: header(), lines: [groupedLine()] }) } as never;
    });
    vi.mocked(WarehousesService).mockImplementation(function () {
      return { list: async () => [] } as never;
    });
  });

  it('a module-off org never sees groupId — the sheet renders flat, not "Product group"', async () => {
    vi.mocked(withApiContext).mockResolvedValue(
      ctxWith(new Set<ModuleId>([...DEFAULT_MODULE_IDS])) as never,
    );

    const res = await GET(req(), await paramsFor('cc-1'));

    expect(res.status).toBe(200);
    expect(ProductGroupsService).not.toHaveBeenCalled();
    const [line] = capturedLines();
    expect(line!.groupId).toBeNull();
    expect(line!.groupName).toBeNull();
  });

  it('a sports-enabled org resolves the real group name and id', async () => {
    const withSports = new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'sports']);
    vi.mocked(withApiContext).mockResolvedValue(ctxWith(withSports) as never);
    vi.mocked(ProductGroupsService).mockImplementation(function () {
      return {
        displayByIds: async () =>
          new Map([['grp-1', { name: 'Pegasus 41', countingUnit: 'pair', sizeOrder: {} }]]),
      } as never;
    });

    const res = await GET(req(), await paramsFor('cc-1'));

    expect(res.status).toBe(200);
    const [line] = capturedLines();
    expect(line!.groupId).toBe('grp-1');
    expect(line!.groupName).toBe('Pegasus 41');
  });
});

/**
 * The walk-to location lookup covers EVERY line of the count. One `.in('id')`
 * over a big count overflowed the URL (the local gateway refuses past ~215
 * uuids; production fails past ~395 after ~7 s of retries), and the old
 * chunks all went out at once. Now: 100 ids per request, at most 6 in flight,
 * and any failed batch is the route's 500, reported with its cause.
 */
describe('GET /api/cycle-counts/[id]/pdf — the location lookup batches', () => {
  const itemId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  function lineFor(i: number) {
    const l = groupedLine();
    return { ...l, id: `line-${i}`, item_id: itemId(i), item: { ...l.item, id: itemId(i), group_id: null } };
  }
  function ctxWithItems(answer: (ids: string[], n: number) => { data: unknown; error: unknown }) {
    let n = 0;
    const stub = makeSupabaseStub({
      'inventory_items.select': (call) => {
        n += 1;
        const ids = call.args[call.methods.indexOf('in')]![1] as string[];
        return answer(ids, n) as never;
      },
      'organizations.select': { data: { name: 'Acme', logo_url: null }, error: null },
    });
    return {
      stub,
      ctx: {
        organizationId: 'org-1',
        userId: 'user-1',
        role: 'admin' as const,
        supabase: stub.client,
        mfaRequired: false,
        mfaSatisfied: true,
        enabledModules: new Set<ModuleId>([...DEFAULT_MODULE_IDS]),
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(exportRateLimited).mockResolvedValue(null as never);
    vi.mocked(WarehousesService).mockImplementation(function () {
      return { list: async () => [] } as never;
    });
  });

  it('250 lines: three lookups of at most 100 ids, and the last batch still prints its location', async () => {
    const lines = Array.from({ length: 250 }, (_, i) => lineFor(i));
    vi.mocked(CycleCountsService).mockImplementation(function () {
      return { get: async () => ({ header: header(), lines }) } as never;
    });
    const { stub, ctx } = ctxWithItems((ids) => ({
      data: ids.map((id) => ({
        id,
        item_type: 'product',
        custom_fields: null,
        bin_location: `BIN-${id.slice(-3)}`,
        locations: null,
      })),
      error: null,
    }));
    vi.mocked(withApiContext).mockResolvedValue(ctx as never);

    const res = await GET(req(), await paramsFor('cc-1'));

    expect(res.status).toBe(200);
    const sent = (stub.chainArgsAll.get('inventory_items.select') ?? []).map(
      (args, i) =>
        args[stub.chainsAll.get('inventory_items.select')![i]!.indexOf('in')]![1] as string[],
    );
    expect(sent.map((l) => l.length)).toEqual([100, 100, 50]);
    const printed = capturedLines();
    expect(printed).toHaveLength(250);
    expect(printed[249]!.location).toContain('BIN-249');
  });

  it('a big count never has more than 6 lookups in flight', async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => lineFor(i));
    vi.mocked(CycleCountsService).mockImplementation(function () {
      return { get: async () => ({ header: header(), lines }) } as never;
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const { ctx } = ctxWithItems(() => ({ data: [], error: null }));
    const from = ctx.supabase.from;
    ctx.supabase.from = vi.fn((table: string) => {
      const builder = from(table);
      if (table !== 'inventory_items') return builder;
      const wrap = (b: Record<string, unknown>): unknown =>
        new Proxy(b, {
          get(target, prop) {
            if (prop === 'then') {
              return (resolve: (v: unknown) => void) => {
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                setTimeout(() => {
                  inFlight -= 1;
                  (target.then as (r: (v: unknown) => void) => void)(resolve);
                }, 2);
              };
            }
            const fn = target[prop as string] as (...a: unknown[]) => Record<string, unknown>;
            return (...args: unknown[]) => wrap(fn(...args));
          },
        });
      return wrap(builder);
    });
    vi.mocked(withApiContext).mockResolvedValue(ctx as never);

    const res = await GET(req(), await paramsFor('cc-1'));

    expect(res.status).toBe(200);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(6);
  });

  it('a failed batch is a 500 with the cause reported, never a sheet without locations', async () => {
    const lines = Array.from({ length: 250 }, (_, i) => lineFor(i));
    vi.mocked(CycleCountsService).mockImplementation(function () {
      return { get: async () => ({ header: header(), lines }) } as never;
    });
    const { ctx } = ctxWithItems((_ids, n) =>
      n === 2 ? { data: null, error: { message: 'fetch failed' } } : { data: [], error: null },
    );
    vi.mocked(withApiContext).mockResolvedValue(ctx as never);
    const { reportError } = await import('@/lib/error-reporter');

    const res = await GET(req(), await paramsFor('cc-1'));

    expect(res.status).toBe(500);
    expect(renderToStream).not.toHaveBeenCalled();
    expect(vi.mocked(reportError)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tag: 'pdf.cycle_count',
        extra: { detail: expect.stringContaining('fetch failed') },
      }),
    );
  });
});
