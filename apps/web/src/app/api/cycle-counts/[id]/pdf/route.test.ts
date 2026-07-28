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
    vi.mocked(CycleCountsService).mockImplementation(
      () => ({ get: async () => ({ header: header(), lines: [groupedLine()] }) }) as never,
    );
    vi.mocked(WarehousesService).mockImplementation(() => ({ list: async () => [] }) as never);
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
    vi.mocked(ProductGroupsService).mockImplementation(
      () =>
        ({
          displayByIds: async () =>
            new Map([['grp-1', { name: 'Pegasus 41', countingUnit: 'pair', sizeOrder: {} }]]),
        }) as never,
    );

    const res = await GET(req(), await paramsFor('cc-1'));

    expect(res.status).toBe(200);
    const [line] = capturedLines();
    expect(line!.groupId).toBe('grp-1');
    expect(line!.groupName).toBe('Pegasus 41');
  });
});
