import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /api/v1 routes when the organization's module state cannot be read.
 *
 * The real withApiContext runs on its legacy reads (the one-round-trip context
 * read fails) and the real route runs behind it; only the database is a
 * double. When the module a route depends on cannot be read, the route
 * refuses with an answer the phone retries, never the 403 `module_disabled`
 * a module that is really off gets:
 *
 *   - the rental checkout, which the phone cannot send twice, answers the API
 *     context gate's 503 marked as refused before any write (core
 *     contextUnavailableBody), and reaches no table past the context reads;
 *   - a receipt line, which the phone's outbox sends, answers a 5xx: the
 *     outbox keeps it and sends it again (a 403 is final there);
 *   - the borrower list, a read, answers a 5xx: the phone says try again.
 *
 * A route that depends on no optional module still answers as before.
 */

const refs = vi.hoisted(() => ({
  client: null as unknown,
  /** Made-up values: the client double ignores both. */
  projectUrl: 'https://example.supabase.co',
  publicValue: 'test-public-value',
}));

vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: refs.projectUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: refs.publicValue,
  },
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => refs.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => refs.client }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: Date.now() + 60_000 })),
}));
vi.mock('@/server/loaders/inventory-list', () => ({ revalidateInventoryList: vi.fn() }));

import { contextUnavailableBody, isRefusedBeforeAnyWrite } from '@stockpilot/core';

import {
  legacyContextClient,
  legacyContextWorld,
  legacyPhoneHeaders,
  routeWork,
  type LegacyContextWorld,
} from '@/test/legacy-api-context';

import { POST as escalatePOST } from './exceptions/[id]/escalate/route';
import { GET as permissionsGET } from './me/permissions/route';
import { POST as receiveLinePOST } from './po/[id]/receive-line/route';
import { GET as borrowersGET } from './rentals/borrowers/route';
import { POST as rentalsPOST } from './rentals/route';

const WAREHOUSE = '11111111-0000-4000-8000-000000000003';
const ITEM = '22222222-0000-4000-8000-000000000004';
const PO = '33333333-0000-4000-8000-000000000005';
const PO_LINE = '44444444-0000-4000-8000-000000000006';
const KEY = '55555555-0000-4000-8000-000000000007';
const OCCURRENCE = '66666666-0000-4000-8000-000000000008';

let world: LegacyContextWorld;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  world = legacyContextWorld({ role: 'admin' });
  refs.client = legacyContextClient(world);
});

function post(path: string, body: unknown): NextRequest {
  return new NextRequest(`https://app.example.test${path}`, {
    method: 'POST',
    headers: legacyPhoneHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

function get(path: string): NextRequest {
  return new NextRequest(`https://app.example.test${path}`, { headers: legacyPhoneHeaders() });
}

/** The phone's ApiError, as apps/mobile/src/lib/api.ts builds it from a response. */
async function asPhoneError(res: Response) {
  const body = (await res.json()) as { error?: unknown; details?: unknown };
  return { status: res.status, code: body.error, details: body.details, body };
}

const checkout = () =>
  rentalsPOST(
    post('/api/v1/rentals', {
      warehouseId: WAREHOUSE,
      borrowerName: 'Sample Borrower',
      borrowerEmail: 'borrower@example.com',
      expectedReturnAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      lines: [{ itemId: ITEM, quantity: 1 }],
    }),
  );

const escalate = () =>
  escalatePOST(
    post(`/api/v1/exceptions/${OCCURRENCE}/escalate`, {
      subject: 'Shelf label missing',
      description: 'Made-up description for a test.',
    }),
    { params: Promise.resolve({ id: OCCURRENCE }) },
  );

const receiveLine = () => {
  world.singles.purchase_orders = {
    id: PO,
    status: 'ordered',
    destination_location_id: null,
    supplier_id: null,
  };
  world.lists.purchase_order_items = [
    { id: PO_LINE, item_id: ITEM, quantity_ordered: 5, quantity_received: 0, unit_cost: 2 },
  ];
  return receiveLinePOST(
    post(`/api/v1/po/${PO}/receive-line`, {
      itemId: ITEM,
      qty: 1,
      warehouseId: WAREHOUSE,
      idempotencyKey: KEY,
    }),
    { params: Promise.resolve({ id: PO }) },
  );
};

const borrowers = () => borrowersGET(get('/api/v1/rentals/borrowers'));

/** Each answer of the module rows read that leaves the module state unread. */
const UNREAD_ROWS: Array<[string, Partial<LegacyContextWorld>]> = [
  ['the rows read failed', { moduleRowsFail: true }],
  ['the rows read answered no list', { moduleRowsNoList: true }],
];

describe('a write the phone cannot send twice: POST /api/v1/rentals (checkout)', () => {
  it.each(UNREAD_ROWS)(
    'module state unreadable: the 503 marked as refused before any write, and no work (%s)',
    async (_shape, shape) => {
      Object.assign(world, shape);
      const res = await checkout();
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('5');
      expect(res.headers.get('cache-control')).toBe('no-store');
      const err = await asPhoneError(res);
      expect(err.body).toEqual(contextUnavailableBody());
      expect(isRefusedBeforeAnyWrite(err)).toBe(true);
      expect(routeWork(world)).toEqual([]);
    },
  );

  it('the module really off: the 403 module_disabled it always got', async () => {
    world.moduleRows = ['orders'];
    const res = await checkout();
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('module_disabled');
  });
});

describe('a write the phone cannot send twice: POST /api/v1/exceptions/[id]/escalate', () => {
  it.each(UNREAD_ROWS)(
    'module state unreadable: the 503 marked as refused before any write, and no work (%s)',
    async (_shape, shape) => {
      Object.assign(world, shape);
      const res = await escalate();
      expect(res.status).toBe(503);
      const err = await asPhoneError(res);
      expect(err.body).toEqual(contextUnavailableBody());
      expect(isRefusedBeforeAnyWrite(err)).toBe(true);
      expect(routeWork(world)).toEqual([]);
    },
  );
});

describe('a write the outbox sends: POST /api/v1/po/[id]/receive-line', () => {
  it.each(UNREAD_ROWS)(
    'module state unreadable: a 5xx the outbox sends again, never the final 403 (%s)',
    async (_shape, shape) => {
      Object.assign(world, shape);
      const res = await receiveLine();
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(((await res.json()) as { error: string }).error).toBe('internal_error');
    },
  );

  it('the module really off: the 403 module_disabled it always got', async () => {
    world.moduleRows = ['orders'];
    const res = await receiveLine();
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('module_disabled');
  });
});

describe('a read: GET /api/v1/rentals/borrowers', () => {
  it.each(UNREAD_ROWS)(
    'module state unreadable: a 5xx the phone retries, never module_disabled (%s)',
    async (_shape, shape) => {
      Object.assign(world, shape);
      const res = await borrowers();
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(((await res.json()) as { error: string }).error).not.toBe('module_disabled');
    },
  );

  it('the module really off: the 403 module_disabled it always got', async () => {
    world.moduleRows = ['orders'];
    const res = await borrowers();
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('module_disabled');
  });

  it('the module on: the list', async () => {
    world.moduleRows = ['rentals'];
    const res = await borrowers();
    expect(res.status).toBe(200);
  });
});

describe('a route that depends on no optional module: GET /api/v1/me/permissions', () => {
  it.each(UNREAD_ROWS)(
    'module state unreadable: still answers 200, as before (%s)',
    async (_shape, shape) => {
      Object.assign(world, shape);
      const res = await permissionsGET(get('/api/v1/me/permissions'));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { role: string }).role).toBe('admin');
    },
  );
});
