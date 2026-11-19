import { ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY, type ModuleId } from '@stockpilot/core';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withApiContext } from '@/lib/auth/api-context';
import { ForbiddenError } from '@/lib/auth/warehouse';
import { reportError } from '@/lib/error-reporter';
import { ConnectionsService } from '@/server/services/connections';
import { ServiceError } from '@/server/services/context';
import { CycleCountsService } from '@/server/services/cycle-counts';
import { DeliveryTrackingService } from '@/server/services/delivery-tracking';
import { InventoryService } from '@/server/services/inventory';
import { MaintenanceRequestsService } from '@/server/services/maintenance-requests';
import { getDashboardValueComparison } from '@/server/services/movements';
import { ProductGroupsService } from '@/server/services/product-groups';

import { POST as confirmAiScan } from './cycle-counts/[id]/ai-scan/[scanId]/confirm/route';
import { GET as valueSeries } from './dashboard/value-series/route';
import { GET as byWarehouse } from './inventory/by-warehouse/route';
import { GET as listCycleCounts, POST as startCycleCount } from './v1/cycle-counts/route';
import { POST as deliveryLocation } from './v1/delivery/location/route';
import { GET as listMaintenance } from './v1/maintenance-requests/route';
import { GET as listProductGroups } from './v1/product-groups/route';
import { POST as zendeskConnect } from './v1/zendesk/connect/route';
import { GET as zendeskConnection } from './v1/zendesk/connection/route';
import { POST as zendeskDisconnect } from './v1/zendesk/disconnect/route';

/**
 * Routes that answer their catch with serviceErrorResponse: every ServiceError
 * refusal keeps its own status and words, a warehouse refusal is a 403 (or the
 * retryable 503 when the caller's access could not be read), and a fault is
 * reported once under the route's tag and answered with the fixed sentence.
 * Each service method throws whatever the case names.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: 0 })),
}));
vi.mock('@/server/services/connections', () => ({ ConnectionsService: vi.fn() }));
vi.mock('@/server/services/cycle-counts', () => ({ CycleCountsService: vi.fn() }));
vi.mock('@/server/services/delivery-tracking', () => ({ DeliveryTrackingService: vi.fn() }));
vi.mock('@/server/services/inventory', () => ({ InventoryService: vi.fn() }));
vi.mock('@/server/services/item-images', () => ({ ItemImagesService: vi.fn() }));
vi.mock('@/server/services/maintenance-requests', () => ({ MaintenanceRequestsService: vi.fn() }));
vi.mock('@/server/services/movements', () => ({ getDashboardValueComparison: vi.fn() }));
vi.mock('@/server/services/product-groups', () => ({ ProductGroupsService: vi.fn() }));

const ID = '11111111-1111-4111-8111-111111111111';
const SCAN_ID = '22222222-2222-4222-8222-222222222222';
const FIXED_SENTENCE = 'Something went wrong. Please try again.';

let thrown: unknown;

/** A service whose every method throws `thrown`. */
function throwingService(): never {
  return new Proxy(
    {},
    {
      get: (_target, prop) =>
        prop === 'then'
          ? undefined
          : async () => {
              throw thrown;
            },
    },
  ) as never;
}

function ctx() {
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    role: 'admin' as const,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(),
  };
}

function req(path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
}

const ROUTES: Array<{ name: string; tag: string; call: () => Promise<Response> }> = [
  {
    name: 'GET /api/v1/zendesk/connection',
    tag: 'api.v1.zendesk.connection',
    call: () => zendeskConnection(req('/api/v1/zendesk/connection')),
  },
  {
    name: 'POST /api/v1/zendesk/disconnect',
    tag: 'api.v1.zendesk.disconnect',
    call: () => zendeskDisconnect(req('/api/v1/zendesk/disconnect', {})),
  },
  {
    name: 'POST /api/v1/zendesk/connect',
    tag: 'api.v1.zendesk.connect',
    call: () =>
      zendeskConnect(
        req('/api/v1/zendesk/connect', {
          subdomain: 'sample-co',
          email: 'agent@example.test',
          apiToken: 'tok',
        }),
      ),
  },
  {
    name: 'POST /api/v1/delivery/location',
    tag: 'api.v1.delivery.location',
    call: () => deliveryLocation(req('/api/v1/delivery/location', { orderId: ID, lat: 1, lng: 2 })),
  },
  {
    name: 'GET /api/dashboard/value-series',
    tag: 'dashboard.value-series',
    call: () => valueSeries(req('/api/dashboard/value-series?mode=previous&basis=cost&days=30')),
  },
  {
    name: 'GET /api/inventory/by-warehouse',
    tag: 'inventory.by-warehouse',
    call: () => byWarehouse(req(`/api/inventory/by-warehouse?warehouseId=${ID}`)),
  },
  {
    name: 'GET /api/v1/cycle-counts',
    tag: 'api.v1.cycle_counts.list',
    call: () => listCycleCounts(req('/api/v1/cycle-counts')),
  },
  {
    name: 'POST /api/v1/cycle-counts',
    tag: 'api.v1.cycle_counts.create',
    call: () => startCycleCount(req('/api/v1/cycle-counts', { scope: 'selection', itemIds: [ID] })),
  },
  {
    name: 'POST /api/cycle-counts/[id]/ai-scan/[scanId]/confirm',
    tag: 'cycle_counts.ai_scan.confirm',
    call: () =>
      confirmAiScan(req(`/api/cycle-counts/${ID}/ai-scan/${SCAN_ID}/confirm`, {}), {
        params: Promise.resolve({ id: ID, scanId: SCAN_ID }),
      }),
  },
  {
    name: 'GET /api/v1/maintenance-requests',
    tag: 'api.v1.maintenance-requests.list',
    call: () => listMaintenance(req('/api/v1/maintenance-requests')),
  },
  {
    name: 'GET /api/v1/product-groups',
    tag: 'api.v1.product-groups.list',
    call: () => listProductGroups(req('/api/v1/product-groups')),
  },
];

type Case = {
  name: string;
  error: () => unknown;
  status: number;
  body: Record<string, unknown>;
  report: false | 'error' | 'warning';
};

const CASES: Case[] = [
  {
    name: 'a conflict',
    error: () => new ServiceError('conflict', 'Made-up conflict.'),
    status: 409,
    body: { error: 'conflict', message: 'Made-up conflict.' },
    report: false,
  },
  {
    name: 'a plan limit',
    error: () => new ServiceError('plan_limit_exceeded', 'Made-up plan limit.'),
    status: 409,
    body: { error: 'plan_limit_exceeded', message: 'Made-up plan limit.' },
    report: false,
  },
  {
    name: 'a refusal from the service',
    error: () => new ServiceError('validation_error', 'Made-up refusal.', { reason: 'made_up' }),
    status: 400,
    body: {
      error: 'validation_error',
      message: 'Made-up refusal.',
      details: { reason: 'made_up' },
    },
    report: false,
  },
  {
    name: 'a missing record',
    error: () => new ServiceError('not_found', 'Made-up record not found.'),
    status: 404,
    body: { error: 'not_found', message: 'Made-up record not found.' },
    report: false,
  },
  {
    name: 'a session the service would not accept',
    error: () => new ServiceError('unauthenticated', 'Made-up sign-in sentence.'),
    status: 401,
    body: { error: 'unauthenticated', message: 'Made-up sign-in sentence.' },
    report: false,
  },
  {
    name: 'a warehouse refusal',
    error: () => new ForbiddenError('Made-up warehouse refusal.'),
    status: 403,
    body: { error: 'forbidden', message: 'Made-up warehouse refusal.' },
    report: false,
  },
  {
    name: 'a warehouse check that could not read the caller’s access',
    error: () => new ForbiddenError('Made-up warehouse refusal.', { accessUnreadable: true }),
    status: 503,
    body: { error: 'check_failed', message: ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY },
    report: 'warning',
  },
  {
    name: 'an internal_error',
    error: () =>
      new ServiceError('internal_error', 'relation "made_up_table" does not exist', {
        row: 'made-up value',
      }),
    status: 500,
    body: { error: 'internal_error', message: FIXED_SENTENCE },
    report: 'error',
  },
  {
    name: 'an unexpected throw',
    error: () => new TypeError('made-up fault at 10.0.0.1'),
    status: 500,
    body: { error: 'internal_error', message: FIXED_SENTENCE },
    report: 'error',
  },
];

const SERVICES = [
  ConnectionsService,
  CycleCountsService,
  DeliveryTrackingService,
  InventoryService,
  MaintenanceRequestsService,
  ProductGroupsService,
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(withApiContext).mockResolvedValue(ctx() as never);
  for (const service of SERVICES) {
    vi.mocked(service).mockImplementation(function () {
      return throwingService();
    });
  }
  vi.mocked(getDashboardValueComparison).mockImplementation(async () => {
    throw thrown;
  });
});

describe.each(ROUTES)('$name answers by serviceErrorResponse', ({ tag, call }) => {
  it.each(CASES)('$name', async ({ error, status, body, report }) => {
    thrown = error();
    const res = await call();
    expect(res.status).toBe(status);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(body);
    expect(text).not.toContain('made_up_table');
    expect(text).not.toContain('made-up value');
    expect(text).not.toContain('10.0.0.1');
    if (report === false) {
      expect(reportError).not.toHaveBeenCalled();
    } else {
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        thrown,
        expect.objectContaining(report === 'warning' ? { tag, level: 'warning' } : { tag }),
      );
    }
  });
});
