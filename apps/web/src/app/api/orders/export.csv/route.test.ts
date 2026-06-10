import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import { OrderRequestsService, type OrderExportRow } from '@/server/services/order-requests';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { GET } from './route';

vi.mock('@/lib/auth/api-context', () => ({
  withApiContext: vi.fn(),
}));

vi.mock('@/server/services/order-requests', async (importOriginal) => {
  // Keep the real type exports (OrderExportRow etc.) but stub the class so
  // we control exportRows() per test.
  const actual = await importOriginal<typeof import('@/server/services/order-requests')>();
  return { ...actual, OrderRequestsService: vi.fn() };
});

// Mock the export throttle to a no-op (allow). Without this it calls the real
// checkRateLimit, whose RPC fails in the no-DB test env and (fail-CLOSED) 429s
// before the handler logic this suite is actually testing.
vi.mock('@/lib/export-rate-limit', () => ({
  exportRateLimited: vi.fn().mockResolvedValue(null),
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
    enabledModules: new Set<ModuleId>(['orders']),
  };
}

function buildRequest(query = ''): Parameters<typeof GET>[0] {
  return new Request(
    `https://test.local/api/orders/export.csv${query}`,
  ) as unknown as Parameters<typeof GET>[0];
}

const SAMPLE_ROW: OrderExportRow = {
  id: 'abcdef12-3456-7890-abcd-ef1234567890',
  status: 'completed',
  requesterName: 'Jane Picker',
  requesterEmail: 'jane@example.com',
  requesterOrgLabel: 'Site A',
  warehouseName: 'Main WH',
  charterLabel: 'North Charter (NCH)',
  fulfillmentType: 'delivery',
  source: 'internal',
  lineCount: 3,
  totalQuantity: 12,
  totalCost: 145.5,
  notes: null,
  createdAt: '2026-05-01T10:00:00.000Z',
  approvedAt: '2026-05-01T11:00:00.000Z',
  completedAt: '2026-05-02T09:00:00.000Z',
};

function stubExportRows(rows: OrderExportRow[], total?: number) {
  const exportRows = vi.fn(async () => ({ rows, total: total ?? rows.length }));
  vi.mocked(OrderRequestsService).mockImplementationOnce(
    () => ({ exportRows }) as unknown as InstanceType<typeof OrderRequestsService>,
  );
  return exportRows;
}

describe('GET /api/orders/export.csv', () => {
  beforeEach(() => vi.clearAllMocks());

  it('401s without an auth context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await GET(buildRequest());
    expect(res.status).toBe(401);
  });

  it('403s for a role lacking orders:approve (gated)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('staff'));
    const exportRows = stubExportRows([SAMPLE_ROW]);
    const res = await GET(buildRequest());
    expect(res.status).toBe(403);
    // The service must never be invoked when the permission gate fails.
    expect(exportRows).not.toHaveBeenCalled();
  });

  it('returns text/csv with a filename and correct header + row shape', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager'));
    stubExportRows([SAMPLE_ROW]);

    const res = await GET(buildRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('Content-Disposition')).toMatch(
      /attachment; filename="orders-\d{4}-\d{2}-\d{2}\.csv"/,
    );

    const body = await res.text();
    const [header, firstRow] = body.split('\n');
    expect(header).toBe(
      'order_number,requester,requester_email,charter_destination,warehouse,status,' +
        'fulfillment_type,source,line_count,total_quantity,total_cost,created_at,' +
        'approved_at,completed_at',
    );
    // order_number = first 8 hex chars uppercased; charter wins over warehouse;
    // total_cost is fixed to 2 dp.
    expect(firstRow).toBe(
      'ABCDEF12,Jane Picker,jane@example.com,North Charter (NCH),Main WH,completed,' +
        'delivery,internal,3,12,145.50,2026-05-01T10:00:00.000Z,' +
        '2026-05-01T11:00:00.000Z,2026-05-02T09:00:00.000Z',
    );
  });

  it('passes status tab + charter + fulfillment + date filters through to the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager'));
    const exportRows = stubExportRows([]);

    await GET(
      buildRequest(
        '?status=completed&fulfillment_type=delivery&charter=charter-9&since=2026-01-01&until=2026-02-01',
      ),
    );

    expect(exportRows).toHaveBeenCalledTimes(1);
    expect(exportRows).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'completed',
        fulfillmentType: 'delivery',
        deliveryCharterId: 'charter-9',
        since: '2026-01-01T00:00:00.000Z',
        until: '2026-02-01T00:00:00.000Z',
        cap: 10_000,
      }),
    );
  });

  it('expands a known status tab key into its status set', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager'));
    const exportRows = stubExportRows([]);

    await GET(buildRequest('?status=denied_cancelled'));

    expect(exportRows).toHaveBeenCalledWith(
      expect.objectContaining({ status: ['denied', 'cancelled'] }),
    );
  });

  it('appends a truncation sentinel reflecting the actual returned row count', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('owner'));
    // 1 row returned, 99999 matching — the sentinel must report what was
    // actually exported (1), not the intended ROW_CAP, so it can't claim
    // completeness it doesn't have.
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

  it('ignores an explicit pending_confirmation status (public-submit limbo the list never shows)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager'));
    const exportRows = stubExportRows([]);

    await GET(buildRequest('?status=pending_confirmation'));

    // resolveStatusFilter drops pending_confirmation, so the route passes
    // no status and the service applies its default limbo exclusion.
    expect(exportRows).toHaveBeenCalledWith(
      expect.objectContaining({ status: undefined }),
    );
  });

  it('passes an explicit selectable status through to the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager'));
    const exportRows = stubExportRows([]);

    await GET(buildRequest('?status=approved'));

    expect(exportRows).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved' }),
    );
  });

  it('maps a module_disabled ServiceError to 403', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager'));
    const exportRows = vi.fn(async () => {
      throw new ServiceError('module_disabled', 'Orders module off');
    });
    vi.mocked(OrderRequestsService).mockImplementationOnce(
      () => ({ exportRows }) as unknown as InstanceType<typeof OrderRequestsService>,
    );

    const res = await GET(buildRequest());
    expect(res.status).toBe(403);
  });
});
