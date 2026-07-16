import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';
import { ServiceError } from '@/server/services/context';
import { MovementsService, type MovementExportRow } from '@/server/services/movements';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { GET } from './route';

vi.mock('@/lib/auth/api-context', () => ({
  withApiContext: vi.fn(),
}));

vi.mock('@/server/services/movements', async (importOriginal) => {
  // Keep the real type exports but stub the class so we control
  // exportRows() per test — same pattern as orders/export.csv's suite.
  const actual = await importOriginal<typeof import('@/server/services/movements')>();
  return { ...actual, MovementsService: vi.fn() };
});

// Mock the export throttle to a no-op (allow). Without this it calls the real
// checkRateLimit, whose RPC fails in the no-DB test env and (fail-CLOSED)
// 429s before the handler logic this suite is actually testing.
vi.mock('@/lib/export-rate-limit', () => ({
  exportRateLimited: vi.fn().mockResolvedValue(null),
}));

// getActiveWarehouseFilter reads next/headers cookies() — real request scope
// only. Mock it so the route's warehouse-filter resolution is deterministic
// in tests, same as it would be via the cookie in a real request.
vi.mock('@/lib/warehouse-filter', () => ({
  getActiveWarehouseFilter: vi.fn().mockResolvedValue(null),
}));

function buildCtx(role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer') {
  const stub = makeSupabaseStub({});
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role,
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(),
  };
}

function buildRequest(query = ''): Parameters<typeof GET>[0] {
  return new Request(
    `https://test.local/api/movements/export.csv${query}`,
  ) as unknown as Parameters<typeof GET>[0];
}

const SAMPLE_ROW: MovementExportRow = {
  id: 'm-1',
  createdAt: '2026-05-01T10:00:00.000Z',
  itemSku: 'W-100',
  itemName: 'Widget',
  movementType: 'adjust',
  quantityChange: -5,
  previousQuantity: 10,
  newQuantity: 5,
  fromLocation: 'Rack A',
  toLocation: null,
  referenceType: 'order_request',
  referenceId: 'req-1',
  reason: 'Shrinkage',
  notes: 'counted short',
  actorEmail: 'jane@example.com',
};

function stubExportRows(rows: MovementExportRow[], total?: number) {
  const exportRows = vi.fn(async () => ({ rows, total: total ?? rows.length }));
  vi.mocked(MovementsService).mockImplementationOnce(
    () => ({ exportRows }) as unknown as InstanceType<typeof MovementsService>,
  );
  return exportRows;
}

describe('GET /api/movements/export.csv', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveWarehouseFilter).mockResolvedValue(null);
  });

  it('401s without an auth context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await GET(buildRequest());
    expect(res.status).toBe(401);
  });

  it('403s for a role lacking activity_logs:read (gated) — service never invoked', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('staff'));
    const exportRows = stubExportRows([SAMPLE_ROW]);
    const res = await GET(buildRequest());
    expect(res.status).toBe(403);
    expect(exportRows).not.toHaveBeenCalled();
  });

  it('returns text/csv with a filename and correct header + row shape', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager'));
    stubExportRows([SAMPLE_ROW]);

    const res = await GET(buildRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('Content-Disposition')).toMatch(
      /attachment; filename="movements-\d{4}-\d{2}-\d{2}\.csv"/,
    );

    const body = await res.text();
    const [header, firstRow] = body.split('\n');
    expect(header).toBe(
      'date,item_sku,item_name,movement_type,quantity_change,previous_quantity,new_quantity,' +
        'from_location,to_location,reference_type,reference_id,reason,notes,actor_email',
    );
    // quantity_change is a negative NUMBER — toCsv's formula-injection guard
    // treats a leading '-' as a possible formula and prefixes a single quote
    // (spreadsheet-safe text), same as every other export route using toCsv.
    expect(firstRow).toBe(
      "2026-05-01T10:00:00.000Z,W-100,Widget,adjust,'-5,10,5,Rack A,,order_request,req-1," +
        'Shrinkage,counted short,jane@example.com',
    );
  });

  it('passes q/type/from/to filters + the active warehouse filter through to the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager'));
    vi.mocked(getActiveWarehouseFilter).mockResolvedValueOnce('wh-9');
    const exportRows = stubExportRows([]);

    await GET(buildRequest('?q=widget&type=adjust&from=2026-01-01&to=2026-01-31'));

    expect(exportRows).toHaveBeenCalledTimes(1);
    expect(exportRows).toHaveBeenCalledWith({
      warehouseId: 'wh-9',
      search: 'widget',
      types: ['adjust'],
      since: '2026-01-01T00:00:00.000Z',
      // 'to' is exclusive-upper-bound — one full day past the given date so
      // filtering is inclusive of the whole 'to' day.
      until: '2026-02-01T00:00:00.000Z',
      cap: 10_000,
    });
  });

  it('ignores an invalid ?type= value rather than passing it through', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager'));
    const exportRows = stubExportRows([]);

    await GET(buildRequest('?type=not_a_real_movement_type'));

    expect(exportRows).toHaveBeenCalledWith(expect.objectContaining({ types: undefined }));
  });

  it('omits warehouseId when no active warehouse filter cookie is set', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager'));
    vi.mocked(getActiveWarehouseFilter).mockResolvedValueOnce(null);
    const exportRows = stubExportRows([]);

    await GET(buildRequest());

    expect(exportRows).toHaveBeenCalledWith(
      expect.objectContaining({ warehouseId: undefined }),
    );
  });

  it('appends a truncation sentinel reflecting the actual returned row count', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('owner'));
    // 1 row returned, 99999 matching — the sentinel must report what was
    // actually exported (1), not the intended ROW_CAP.
    stubExportRows([SAMPLE_ROW], 99_999);

    const res = await GET(buildRequest());
    const body = await res.text();
    expect(body).toContain('# truncated: exported 1 of 99999 rows');
  });

  it('omits the truncation sentinel when every matching row was returned', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('owner'));
    stubExportRows([SAMPLE_ROW], 1);

    const res = await GET(buildRequest());
    const body = await res.text();
    expect(body).not.toContain('# truncated');
  });

  it('maps a ServiceError to its status code', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager'));
    const exportRows = vi.fn(async () => {
      throw new ServiceError('internal_error', 'boom');
    });
    vi.mocked(MovementsService).mockImplementationOnce(
      () => ({ exportRows }) as unknown as InstanceType<typeof MovementsService>,
    );

    const res = await GET(buildRequest());
    expect(res.status).toBe(500);
  });
});
