import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Two changes the phone queues and sends again, when their module is off:
 *
 *   - POST /api/v1/bundles/[id]/distribute (a kit hand-out, bundles module);
 *   - POST /api/v1/cycle-counts/[id]/lines/[lineId]/record (a counted line,
 *     cycle counts module).
 *
 * The count's reassign and release routes (cycle counts module) answer the
 * same way.
 *
 * A module that is really off answers 403 module_disabled, which the phone's
 * outbox treats as final (it stops sending the row and lists it as not sent),
 * as the clear, receive and size-count routes answer. A module state that
 * could not be read answers a 5xx the outbox sends again, never that 403.
 * Neither reaches any table past the context reads.
 *
 * The real withApiContext runs on its legacy reads and the real route runs
 * behind it; only the database is a double.
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
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() + 60_000 })),
}));
vi.mock('@/server/loaders/inventory-list', () => ({ revalidateInventoryList: vi.fn() }));

import {
  legacyContextClient,
  legacyContextWorld,
  legacyPhoneHeaders,
  routeWork,
  type LegacyContextWorld,
} from '@/test/legacy-api-context';

import { POST as distributePOST } from './bundles/[id]/distribute/route';
import { POST as recordPOST } from './cycle-counts/[id]/lines/[lineId]/record/route';
import { POST as reassignPOST } from './cycle-counts/[id]/reassign/route';
import { POST as releasePOST } from './cycle-counts/[id]/release/route';

const BUNDLE = '11111111-0000-4000-8000-000000000201';
const WAREHOUSE = '22222222-0000-4000-8000-000000000202';
const KEY = '33333333-0000-4000-8000-000000000203';
const COUNT = '44444444-0000-4000-8000-000000000204';
const LINE = '55555555-0000-4000-8000-000000000205';
const MEMBER = '66666666-0000-4000-8000-000000000206';

let world: LegacyContextWorld;

beforeEach(() => {
  vi.clearAllMocks();
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

const distribute = () =>
  distributePOST(
    post(`/api/v1/bundles/${BUNDLE}/distribute`, {
      quantity: 2,
      warehouseId: WAREHOUSE,
      idempotencyKey: KEY,
    }),
    { params: Promise.resolve({ id: BUNDLE }) },
  );

const record = () =>
  recordPOST(post(`/api/v1/cycle-counts/${COUNT}/lines/${LINE}/record`, { countedQuantity: 4 }), {
    params: Promise.resolve({ id: COUNT, lineId: LINE }),
  });

const reassign = () =>
  reassignPOST(
    post(`/api/v1/cycle-counts/${COUNT}/reassign`, {
      assignedTo: MEMBER,
      reason: 'Counter is out today',
    }),
    { params: Promise.resolve({ id: COUNT }) },
  );

const release = () =>
  releasePOST(post(`/api/v1/cycle-counts/${COUNT}/release`, { reason: 'Counter is out today' }), {
    params: Promise.resolve({ id: COUNT }),
  });

const ROUTES: Array<[string, string, () => Promise<Response>]> = [
  ['POST /api/v1/bundles/[id]/distribute', 'bundles', distribute],
  ['POST /api/v1/cycle-counts/[id]/lines/[lineId]/record', 'cycle_counts', record],
  // The count's manager actions answer the same way.
  ['POST /api/v1/cycle-counts/[id]/reassign', 'cycle_counts', reassign],
  ['POST /api/v1/cycle-counts/[id]/release', 'cycle_counts', release],
];

/** Each answer of the module rows read that leaves the module state unread. */
const UNREAD_ROWS: Array<[string, Partial<LegacyContextWorld>]> = [
  ['the rows read failed', { moduleRowsFail: true }],
  ['the rows read answered no list', { moduleRowsNoList: true }],
];

describe.each(ROUTES)('%s', (_route, moduleId, send) => {
  it('the module really off: 403 module_disabled, final on the phone, and no work', async () => {
    // Another optional module on, this one off.
    world.moduleRows = ['orders'];
    const res = await send();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'module_disabled',
      message: `Module not enabled for this organization: ${moduleId}`,
    });
    expect(routeWork(world)).toEqual([]);
  });

  it.each(UNREAD_ROWS)(
    'module state unreadable: a 5xx the outbox sends again, never module_disabled (%s)',
    async (_shape, shape) => {
      Object.assign(world, shape);
      const res = await send();
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(res.status).toBeLessThan(600);
      const body = (await res.json()) as { error?: unknown };
      expect(body.error).toBe('internal_error');
      expect(routeWork(world)).toEqual([]);
    },
  );
});
