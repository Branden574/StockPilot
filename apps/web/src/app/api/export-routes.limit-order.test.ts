import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

/**
 * Security invariant (2026-09-29, review of fix/reports-scope): every export
 * route checks the caller (session, permission, the thing asked for) BEFORE
 * it spends the shared export budget.
 *
 * exportRateLimited is one budget per user across ALL exports (40/hour), and
 * every trip writes a security.export_rate_limited audit row and fires the
 * org's Slack/Teams/webhook alert. These routes ran it first
 * (`const limited = ctx && (await exportRateLimited(...))`), so a member
 * without the permission spent the budget on refused requests, tripped the
 * abuse alert, and after 40 refusals was told 429 instead of 403, locking
 * themselves out of the exports they may use. The report routes were fixed
 * first (0380); this pins the same order everywhere and polices itself: a new
 * route that calls the limiter must be listed here.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/export-rate-limit', () => ({ exportRateLimited: vi.fn(async () => null) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/lib/warehouse-filter', () => ({ getActiveWarehouseFilterFor: vi.fn(async () => null) }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    throw new Error('not expected on these paths');
  },
}));

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { ServiceError } from '@/server/services/context';
import { CycleCountsService } from '@/server/services/cycle-counts';
import { MovementsService } from '@/server/services/movements';
import { OrderRequestsService } from '@/server/services/order-requests';
import { PurchaseOrdersService } from '@/server/services/purchase-orders';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Overrides = Parameters<typeof makeServiceContext>[1];

const ORDER_ID = '0a000000-0000-4000-8000-000000000201';
const PO_ID = '0a000000-0000-4000-8000-0000000000f1';

/** A member holding none of the export permissions below. */
const BARE_VIEWER: Overrides = { role: 'viewer', permissions: new Set(['items:read', 'reports:read']) };
/** The owner holds every permission. */
const OWNER: Overrides = { role: 'owner' };

function signIn(overrides: Overrides) {
  const s = makeSupabaseStub({
    'order_requests.select': {
      data: { signature_data_url: 'data:image/png;base64,AAAA', assigned_delivery_user_id: 'someone-else' },
      error: null,
    },
    'organizations.select': { data: { name: 'Acme', logo_url: null, timezone: 'UTC' }, error: null },
  });
  vi.mocked(withApiContext).mockResolvedValue(makeServiceContext(s.client, overrides) as never);
  return s;
}

async function call(load: () => Promise<Record<string, unknown>>, method: 'GET' | 'POST', path: string, params: Record<string, string> = {}, body?: unknown) {
  const mod = await load();
  const handler = mod[method] as Handler;
  const req = new NextRequest(`https://test.local${path}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  const res = await handler(req, { params: Promise.resolve(params) });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.clone().json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** A pick-slip-ready order for the slip routes' permitted path. */
function readyOrder(status: string) {
  return {
    request: { id: ORDER_ID, status, warehouse_id: 'wh-1', delivery_charter_id: null, signature_token: null },
    lines: [],
  } as never;
}

interface RouteCase {
  name: string;
  file: string;
  load: () => Promise<Record<string, unknown>>;
  method: 'GET' | 'POST';
  path: string;
  /** The path the permitted caller asks for, when it differs from `path`. */
  permitPath?: string;
  params?: Record<string, string>;
  body?: unknown;
  /** Arrange a caller the route must refuse, and the status it must answer. */
  refuse: () => void;
  refusedStatus: number;
  /** Arrange a caller the route serves (the limiter then answers 429). */
  permit: () => void;
}

const ROUTES: RouteCase[] = [
  {
    name: 'purchase orders CSV (purchase_orders:read)',
    file: 'purchase-orders/export.csv/route.ts',
    load: () => import('./purchase-orders/export.csv/route'),
    method: 'GET',
    path: '/api/purchase-orders/export.csv',
    refuse: () => signIn({ ...BARE_VIEWER }),
    refusedStatus: 403,
    permit: () => signIn(OWNER),
  },
  {
    name: 'purchase order PDF (purchase_orders:read)',
    file: 'purchase-orders/[id]/pdf/route.tsx',
    load: () => import('./purchase-orders/[id]/pdf/route'),
    method: 'GET',
    path: `/api/purchase-orders/${PO_ID}/pdf`,
    params: { id: PO_ID },
    refuse: () => signIn({ ...BARE_VIEWER }),
    refusedStatus: 403,
    permit: () => signIn(OWNER),
  },
  {
    name: 'purchase order attachments zip (purchase_orders:read)',
    file: 'purchase-orders/[id]/attachments.zip/route.ts',
    load: () => import('./purchase-orders/[id]/attachments.zip/route'),
    method: 'GET',
    path: `/api/purchase-orders/${PO_ID}/attachments.zip`,
    params: { id: PO_ID },
    refuse: () => signIn({ ...BARE_VIEWER }),
    refusedStatus: 403,
    permit: () => signIn(OWNER),
  },
  {
    name: 'movements CSV (activity_logs:read)',
    file: 'movements/export.csv/route.ts',
    load: () => import('./movements/export.csv/route'),
    method: 'GET',
    path: '/api/movements/export.csv',
    refuse: () => signIn({ ...BARE_VIEWER }),
    refusedStatus: 403,
    permit: () => signIn(OWNER),
  },
  {
    name: 'inventory CSV (items:export)',
    file: 'inventory/export.csv/route.ts',
    load: () => import('./inventory/export.csv/route'),
    method: 'GET',
    path: '/api/inventory/export.csv',
    refuse: () => signIn({ ...BARE_VIEWER }),
    refusedStatus: 403,
    permit: () => signIn(OWNER),
  },
  {
    name: 'inventory CSV with a malformed warehouseId (the request)',
    file: 'inventory/export.csv/route.ts',
    load: () => import('./inventory/export.csv/route'),
    method: 'GET',
    path: '/api/inventory/export.csv?warehouseId=not-a-uuid',
    permitPath: '/api/inventory/export.csv',
    refuse: () => signIn(OWNER),
    refusedStatus: 400,
    permit: () => signIn(OWNER),
  },
  {
    name: 'inventory export builder (items:export)',
    file: 'inventory/export/route.tsx',
    load: () => import('./inventory/export/route'),
    method: 'POST',
    path: '/api/inventory/export',
    body: { format: 'csv', scope: 'all' },
    refuse: () => signIn({ ...BARE_VIEWER }),
    refusedStatus: 403,
    permit: () => signIn(OWNER),
  },
  {
    name: 'orders CSV (orders:approve)',
    file: 'orders/export.csv/route.ts',
    load: () => import('./orders/export.csv/route'),
    method: 'GET',
    path: '/api/orders/export.csv',
    refuse: () => signIn({ ...BARE_VIEWER }),
    refusedStatus: 403,
    permit: () => signIn(OWNER),
  },
  {
    name: 'orders PDF (orders:approve)',
    file: 'orders/export.pdf/route.tsx',
    load: () => import('./orders/export.pdf/route'),
    method: 'GET',
    path: '/api/orders/export.pdf',
    refuse: () => signIn({ ...BARE_VIEWER }),
    refusedStatus: 403,
    permit: () => signIn(OWNER),
  },
  {
    name: 'order signature (orders:approve or the assigned driver)',
    file: 'orders/[id]/signature/route.ts',
    load: () => import('./orders/[id]/signature/route'),
    method: 'GET',
    path: `/api/orders/${ORDER_ID}/signature`,
    params: { id: ORDER_ID },
    refuse: () => signIn({ ...BARE_VIEWER }),
    refusedStatus: 403,
    permit: () => signIn(OWNER),
  },
  {
    name: 'customer packing slip (an order the caller cannot open)',
    file: 'orders/[id]/packing-slip-customer.pdf/route.tsx',
    load: () => import('./orders/[id]/packing-slip-customer.pdf/route'),
    method: 'GET',
    path: `/api/orders/${ORDER_ID}/packing-slip-customer.pdf`,
    params: { id: ORDER_ID },
    refuse: () => {
      signIn(OWNER);
      vi.spyOn(OrderRequestsService.prototype, 'get').mockRejectedValue(new ServiceError('not_found', 'Order request not found'));
    },
    refusedStatus: 404,
    permit: () => {
      signIn(OWNER);
      vi.spyOn(OrderRequestsService.prototype, 'get').mockResolvedValue(readyOrder('packing_slip_generated'));
    },
  },
  {
    name: 'warehouse packing slip (an order the caller cannot open)',
    file: 'orders/[id]/packing-slip-warehouse.pdf/route.tsx',
    load: () => import('./orders/[id]/packing-slip-warehouse.pdf/route'),
    method: 'GET',
    path: `/api/orders/${ORDER_ID}/packing-slip-warehouse.pdf`,
    params: { id: ORDER_ID },
    refuse: () => {
      signIn(OWNER);
      vi.spyOn(OrderRequestsService.prototype, 'get').mockRejectedValue(new ServiceError('not_found', 'Order request not found'));
    },
    refusedStatus: 404,
    permit: () => {
      signIn(OWNER);
      vi.spyOn(OrderRequestsService.prototype, 'get').mockResolvedValue(readyOrder('packing_slip_generated'));
    },
  },
  {
    name: 'pick slip (the orders module off)',
    file: 'orders/[id]/pick-slip.pdf/route.tsx',
    load: () => import('./orders/[id]/pick-slip.pdf/route'),
    method: 'GET',
    path: `/api/orders/${ORDER_ID}/pick-slip.pdf`,
    params: { id: ORDER_ID },
    refuse: () => {
      signIn({ ...OWNER, enabledModules: new Set<ModuleId>(DEFAULT_MODULE_IDS.filter((m) => m !== 'orders')) });
    },
    refusedStatus: 403,
    permit: () => {
      signIn(OWNER);
      vi.spyOn(OrderRequestsService.prototype, 'get').mockResolvedValue(readyOrder('pick_slip_generated'));
    },
  },
  {
    name: 'cycle count PDF (cycle_counts:read or stock:adjust)',
    file: 'cycle-counts/[id]/pdf/route.tsx',
    load: () => import('./cycle-counts/[id]/pdf/route'),
    method: 'GET',
    path: '/api/cycle-counts/cc-1/pdf',
    params: { id: 'cc-1' },
    refuse: () => signIn({ ...BARE_VIEWER }),
    refusedStatus: 403,
    permit: () => signIn(OWNER),
  },
  {
    name: 'PO import CSV (purchase_orders:manage)',
    file: 'po-imports/[id]/export.csv/route.ts',
    load: () => import('./po-imports/[id]/export.csv/route'),
    method: 'GET',
    path: '/api/po-imports/imp-1/export.csv',
    params: { id: 'imp-1' },
    refuse: () => signIn({ ...BARE_VIEWER }),
    refusedStatus: 403,
    permit: () => signIn(OWNER),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.mocked(exportRateLimited).mockResolvedValue(null);
});

describe('export routes check the caller before the shared export budget', () => {
  it.each(ROUTES.map((r) => [r.name, r] as const))('%s: refused, and the budget is untouched', async (_n, r) => {
    r.refuse();
    const res = await call(r.load, r.method, r.path, r.params, r.body);
    expect(res.status).toBe(r.refusedStatus);
    expect(exportRateLimited).not.toHaveBeenCalled();
  });

  it.each(ROUTES.map((r) => [r.name, r] as const))('%s: a permitted caller over the limit still gets 429', async (_n, r) => {
    r.permit();
    vi.mocked(exportRateLimited).mockResolvedValue(
      new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 }) as never,
    );
    const res = await call(r.load, r.method, r.permitPath ?? r.path, r.params, r.body);
    expect(res.status).toBe(429);
    expect(exportRateLimited).toHaveBeenCalledTimes(1);
  });

  it('no session: 401 on every route, the budget untouched', async () => {
    for (const r of ROUTES) {
      vi.mocked(withApiContext).mockResolvedValue(null);
      const res = await call(r.load, r.method, r.path, r.params, r.body);
      expect([r.name, res.status]).toEqual([r.name, 401]);
    }
    expect(exportRateLimited).not.toHaveBeenCalled();
  });
});

// The slip routes answered EVERY error 500 with the raw message (a
// not_found or a module that is off read as an outage, and a thrown Error's
// own text reached the client). A ServiceError now keeps its real status.
describe('order slip PDFs answer a ServiceError with its real status', () => {
  const SLIPS = ROUTES.filter((r) => r.file.startsWith('orders/[id]/') && r.file.includes('slip'));

  it.each(SLIPS.map((r) => [r.name, r] as const))('%s: not_found 404, module_disabled 403', async (_n, r) => {
    signIn(OWNER);
    const get = vi.spyOn(OrderRequestsService.prototype, 'get');
    get.mockRejectedValueOnce(new ServiceError('not_found', 'Order request not found'));
    expect((await call(r.load, r.method, r.path, r.params)).status).toBe(404);
    get.mockRejectedValueOnce(new ServiceError('module_disabled', 'Orders is not enabled.'));
    expect((await call(r.load, r.method, r.path, r.params)).status).toBe(403);
  });

  it.each(SLIPS.map((r) => [r.name, r] as const))('%s: an unexpected error is a generic 500, reported', async (_n, r) => {
    signIn(OWNER);
    vi.spyOn(OrderRequestsService.prototype, 'get').mockRejectedValue(new Error('relation "order_requests" secret detail'));
    const res = await call(r.load, r.method, r.path, r.params);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.json)).not.toMatch(/secret detail|order_requests/);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});

// Review follow-up (2026-09-29): these routes flattened some ServiceErrors to
// 500 (the PO CSV every error, as export_failed; the PO PDF and the cycle
// count PDF module_disabled and validation_error; the movements and orders
// exports not_found and conflict). A permanent refusal read as an outage and
// fired 5xx alerting. Each now answers with serviceErrorStatus.
describe('a ServiceError from the data keeps its real status', () => {
  const DATA_CALLS: Array<[string, () => void]> = [
    ['purchase orders CSV (purchase_orders:read)', () => void vi.spyOn(PurchaseOrdersService.prototype, 'list')],
    ['purchase order PDF (purchase_orders:read)', () => void vi.spyOn(PurchaseOrdersService.prototype, 'get')],
    ['movements CSV (activity_logs:read)', () => void vi.spyOn(MovementsService.prototype, 'exportRows')],
    ['orders CSV (orders:approve)', () => void vi.spyOn(OrderRequestsService.prototype, 'exportRows')],
    ['orders PDF (orders:approve)', () => void vi.spyOn(OrderRequestsService.prototype, 'exportRows')],
    ['cycle count PDF (cycle_counts:read or stock:adjust)', () => void vi.spyOn(CycleCountsService.prototype, 'get')],
  ];
  const TARGET: Record<string, () => { mockRejectedValue: (e: unknown) => unknown }> = {
    'purchase orders CSV (purchase_orders:read)': () => vi.mocked(PurchaseOrdersService.prototype.list),
    'purchase order PDF (purchase_orders:read)': () => vi.mocked(PurchaseOrdersService.prototype.get),
    'movements CSV (activity_logs:read)': () => vi.mocked(MovementsService.prototype.exportRows),
    'orders CSV (orders:approve)': () => vi.mocked(OrderRequestsService.prototype.exportRows),
    'orders PDF (orders:approve)': () => vi.mocked(OrderRequestsService.prototype.exportRows),
    'cycle count PDF (cycle_counts:read or stock:adjust)': () => vi.mocked(CycleCountsService.prototype.get),
  };
  const cases = DATA_CALLS.flatMap(([name, spy]) =>
    ([
      ['not_found', 404],
      ['module_disabled', 403],
      ['validation_error', 400],
      ['conflict', 409],
    ] as const).map(([code, status]) => [name, code, status, spy] as const),
  );

  it.each(cases)('%s: %s -> %i', async (name, code, status, spy) => {
    const r = ROUTES.find((x) => x.name === name)!;
    signIn(OWNER);
    spy();
    TARGET[name]!().mockRejectedValue(new ServiceError(code, `refused: ${code}`));
    const res = await call(r.load, r.method, r.path, r.params, r.body);
    expect(res.status).toBe(status);
    expect(res.json).toMatchObject({ error: code, message: `refused: ${code}` });
  });

  it.each(DATA_CALLS)('%s: an internal error is a generic 500, reported', async (name, spy) => {
    const r = ROUTES.find((x) => x.name === name)!;
    signIn(OWNER);
    spy();
    TARGET[name]!().mockRejectedValue(new Error('relation "secret_table" detail'));
    const res = await call(r.load, r.method, r.path, r.params, r.body);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.json)).not.toMatch(/secret_table/);
    expect(reportError).toHaveBeenCalled();
  });
});

// Self-policing: a route that calls the export limiter must be covered here
// (or by its own report-route test), and never with the limiter-first idiom.
describe('every route that calls the export limiter is covered', () => {
  const API = join(__dirname);
  const REPORT_ROUTES_WITH_OWN_TESTS = [
    'reports/[slug]/csv/route.ts',
    'reports/[slug]/pdf/route.tsx',
    'reports/inventory-snapshot/pdf/route.tsx',
    'reports/item-cost-history/xlsx/route.ts',
    'v1/reports/book-order-totals/export/route.tsx',
  ];

  function routeFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...routeFiles(full));
      else if (/^route\.tsx?$/.test(name)) out.push(full);
    }
    return out;
  }

  const limiterRoutes = routeFiles(API)
    .filter((f) => readFileSync(f, 'utf8').includes('exportRateLimited('))
    .map((f) => relative(API, f))
    .sort();

  it('lists exactly the routes that call it', () => {
    const covered = [...new Set([...ROUTES.map((r) => r.file), ...REPORT_ROUTES_WITH_OWN_TESTS])].sort();
    expect(limiterRoutes).toEqual(covered);
  });

  it('no route runs the limiter before it knows the caller', () => {
    for (const rel of limiterRoutes) {
      const src = readFileSync(join(API, rel), 'utf8');
      expect([rel, /ctx\s*&&\s*\(\s*await\s+exportRateLimited\(/.test(src)]).toEqual([rel, false]);
    }
  });
});
