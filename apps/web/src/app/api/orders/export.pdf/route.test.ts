// @vitest-environment node
//
// Node, not happy-dom: this suite renders REAL PDF bytes through
// @react-pdf/renderer's node build (renderToStream), which a browser-flavored
// environment has no reason to resolve. No DOM is used anywhere below.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import { OrderRequestsService, type OrderExportRow } from '@/server/services/order-requests';
import { makeSupabaseStub } from '@/test/supabase-mock';

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

// Keep the REAL renderer (the suite asserts genuine PDF bytes) but wrap
// renderToStream in a recording spy so the same tests can also pin the
// document props the route composed (title, footer note, formatted cells).
vi.mock('@react-pdf/renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@react-pdf/renderer')>();
  return { ...actual, renderToStream: vi.fn(actual.renderToStream) };
});

import { renderToStream } from '@react-pdf/renderer';

import { GET } from './route';

function buildCtx(role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer') {
  const stub = makeSupabaseStub({
    // The route reads the org name for the branded header.
    'organizations.select': { data: { name: 'Demo Co', logo_url: null }, error: null },
  });
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
    `https://test.local/api/orders/export.pdf${query}`,
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
  approvedAt: null,
  completedAt: '2026-05-02T09:00:00.000Z',
};

function stubExportRows(rows: OrderExportRow[], total?: number) {
  const exportRows = vi.fn(async () => ({ rows, total: total ?? rows.length }));
  vi.mocked(OrderRequestsService).mockImplementationOnce(
    () => ({ exportRows }) as unknown as InstanceType<typeof OrderRequestsService>,
  );
  return exportRows;
}

/** Props of the <OrdersExportPdf/> element the route handed to react-pdf. */
function renderedDocProps(): {
  title: string;
  subtitle: string;
  orgName: string;
  footerNote?: string;
  rows: Array<Record<string, string>>;
} {
  const element = vi.mocked(renderToStream).mock.calls.at(-1)?.[0] as unknown as {
    props: ReturnType<typeof renderedDocProps>;
  };
  return element.props;
}

async function bodyBytes(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

describe('GET /api/orders/export.pdf', () => {
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

  it('returns real PDF bytes with an application/pdf content type and pinned filename', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager'));
    stubExportRows([SAMPLE_ROW]);

    const res = await GET(buildRequest('?status=completed'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    // buildExportFilename with presetName "orders completed".
    expect(res.headers.get('Content-Disposition')).toMatch(
      /^attachment; filename="orders-completed-\d{4}-\d{2}-\d{2}\.pdf"$/,
    );
    expect(res.headers.get('Cache-Control')).toBe('no-store');

    const bytes = await bodyBytes(res);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(1000);

    // Header composition + CSV-parity cell formatting, pinned literally:
    // order_number = first 8 hex chars uppercased; total_cost fixed to 2 dp;
    // charter wins over warehouse; blank approved_at prints as an em dash.
    const props = renderedDocProps();
    expect(props.title).toBe('Order requests — Completed');
    expect(props.orgName).toBe('Demo Co');
    expect(props.subtitle).toBe('1 order');
    expect(props.rows).toEqual([
      {
        order_number: 'ABCDEF12',
        requester: 'Jane Picker',
        requester_email: 'jane@example.com',
        charter_destination: 'North Charter (NCH)',
        warehouse: 'Main WH',
        status: 'completed',
        fulfillment_type: 'delivery',
        source: 'internal',
        line_count: '3',
        total_quantity: '12',
        total_cost: '145.50',
        created_at: '2026-05-01T10:00:00.000Z',
        approved_at: '—',
        completed_at: '2026-05-02T09:00:00.000Z',
      },
    ]);
  });

  it('expands a known status tab key into its status set (same TAB_FILTERS semantics as the CSV)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager'));
    const exportRows = stubExportRows([]);

    await GET(buildRequest('?status=picking'));

    expect(exportRows).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ['pick_slip_generated', 'picking_in_progress', 'picking_complete'],
        cap: 10_000,
      }),
    );
  });

  it('passes status tab + charter + fulfillment + date filters through to the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager'));
    const exportRows = stubExportRows([]);

    await GET(
      buildRequest(
        '?status=denied_cancelled&fulfillment_type=delivery&charter=charter-9&since=2026-01-01&until=2026-02-01',
      ),
    );

    expect(exportRows).toHaveBeenCalledTimes(1);
    expect(exportRows).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ['denied', 'cancelled'],
        fulfillmentType: 'delivery',
        deliveryCharterId: 'charter-9',
        since: '2026-01-01T00:00:00.000Z',
        until: '2026-02-01T00:00:00.000Z',
        cap: 10_000,
      }),
    );
  });

  it('ignores an explicit pending_confirmation status (public-submit limbo the list never shows)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager'));
    const exportRows = stubExportRows([]);

    await GET(buildRequest('?status=pending_confirmation'));

    expect(exportRows).toHaveBeenCalledWith(
      expect.objectContaining({ status: undefined }),
    );
  });

  it('renders a valid empty-state document for a tab with zero rows — never a 500', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('owner'));
    stubExportRows([]);

    const res = await GET(buildRequest('?status=backordered'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');

    const bytes = await bodyBytes(res);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(1000);

    const props = renderedDocProps();
    expect(props.rows).toEqual([]);
    expect(props.subtitle).toBe('0 orders');
    expect(props.title).toBe('Order requests — Backordered');
  });

  it('falls back to an unfiltered filename + "All orders" title when no status is given', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager'));
    stubExportRows([]);

    const res = await GET(buildRequest());
    expect(res.headers.get('Content-Disposition')).toMatch(
      /^attachment; filename="orders-\d{4}-\d{2}-\d{2}\.pdf"$/,
    );
    expect(renderedDocProps().title).toBe('Order requests — All orders');
  });

  it('reports truncation in the footer note, based on the actual returned row count', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('owner'));
    stubExportRows([SAMPLE_ROW], 99_999);

    const res = await GET(buildRequest());
    expect(res.status).toBe(200);
    const props = renderedDocProps();
    expect(props.footerNote).toBe('Truncated: exported 1 of 99999 rows');
    expect(props.subtitle).toBe('1 order (first 1 of 99999)');
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
