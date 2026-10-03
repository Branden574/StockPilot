import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

/**
 * Migration 0389: a request's own public track token and its requester return
 * token are written to the service-only order_request_secrets (the public
 * submit and order_return_token_ensure); tokens written earlier are still on
 * the order row until slice C moves them. The public tracker and its
 * live-location route read the side table first and the column second, so a
 * link emailed before or after 0389 keeps working, and the tracker's return
 * link is the side token when there is one.
 */

vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/lib/client-ip', () => ({ clientIpFromRequest: () => '203.0.113.9' }));
vi.mock('@/server/services/delivery-tracking', () => ({
  getPublicDriverLocation: vi.fn(async () => ({ available: true, lat: 1, lng: 2 })),
}));
const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminHolder.client }));

import { GET as LOCATION } from './location/route';
import { GET } from './route';

const ORDER_ID = '0a000000-0000-4000-8000-000000000393';
const EMAIL = 'reggie@example.com';
const SIDE_TRACK = 'a'.repeat(64);
const COLUMN_TRACK = 'b'.repeat(64);
const SIDE_RETURN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COLUMN_RETURN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function world(opts: {
  sideTrack?: string | null;
  columnTrack?: string | null;
  sideReturn?: string | null;
  columnReturn?: string | null;
  sideError?: boolean;
}) {
  const order = {
    id: ORDER_ID,
    status: 'completed',
    requester_email: EMAIL,
    requester_name: 'Reggie',
    notes: null,
    denied_reason: null,
    created_at: '2026-10-01T00:00:00Z',
    approved_at: null,
    packing_slip_generated_at: null,
    staged_at: null,
    in_transit_at: null,
    signed_at: null,
    completed_at: '2026-10-02T00:00:00Z',
    cancelled_at: null,
    organization_id: 'org-1',
    warehouse_id: 'wh-1',
    fulfillment_type: 'pickup',
    return_token: opts.columnReturn ?? null,
    public_track_token: opts.columnTrack ?? null,
  };
  const sideRow =
    opts.sideTrack || opts.sideReturn
      ? [{ order_request_id: ORDER_ID, public_track_token: opts.sideTrack ?? null, return_token: opts.sideReturn ?? null }]
      : [];
  const stub = makeSupabaseStub({
    'order_requests.select': servedLikePostgrest([order]),
    'order_request_secrets.select': opts.sideError
      ? { data: null, error: { message: 'down' } }
      : servedLikePostgrest(sideRow),
    'organizations.select': servedLikePostgrest([]),
    'public_request_links.select': servedLikePostgrest([]),
    'order_request_lines.select': {
      data: [{ id: 'l1', quantity_requested: 1, quantity_fulfilled: 1, returned_quantity: 0, item: { name: 'Polo' } }],
      error: null,
    },
    'warehouses.select': { data: { name: 'DC4' }, error: null },
    'organization_modules.select': { data: { module_id: 'returns' }, error: null },
  });
  adminHolder.client = stub.client;
  return stub;
}

async function track(token: string) {
  const res = await GET(
    new NextRequest(`https://test.local/api/v1/public/order-requests/${ORDER_ID}?email=${EMAIL}&token=${token}`),
    { params: Promise.resolve({ id: ORDER_ID }) },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function locate(token: string) {
  const res = await LOCATION(
    new NextRequest(`https://test.local/api/v1/public/order-requests/${ORDER_ID}/location?email=${EMAIL}&token=${token}`),
    { params: Promise.resolve({ id: ORDER_ID }) },
  );
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => vi.clearAllMocks());

describe('public tracker: the request track token, side table first', () => {
  it('a token written since 0389 (side table only) opens the tracker and the live location', async () => {
    world({ sideTrack: SIDE_TRACK });
    expect((await track(SIDE_TRACK)).status).toBe(200);
    expect((await locate(SIDE_TRACK)).available).toBe(true);
  });

  it('a token written before 0389 (the order column) still opens both, until slice C', async () => {
    world({ columnTrack: COLUMN_TRACK });
    expect((await track(COLUMN_TRACK)).status).toBe(200);
    expect((await locate(COLUMN_TRACK)).available).toBe(true);
  });

  it('a failed side read falls back to the column (what the route read before)', async () => {
    world({ columnTrack: COLUMN_TRACK, sideError: true });
    expect((await track(COLUMN_TRACK)).status).toBe(200);
  });

  it('a wrong token is the same 404 / unavailable', async () => {
    world({ sideTrack: SIDE_TRACK });
    expect(await track('c'.repeat(64))).toEqual({ status: 404, json: { error: 'not_found' } });
    expect(await locate('c'.repeat(64))).toEqual({ available: false });
  });
});

describe("public tracker: the requester's return link, side table first", () => {
  it('the side token when there is one, else the legacy column token', async () => {
    world({ sideTrack: SIDE_TRACK, sideReturn: SIDE_RETURN, columnReturn: COLUMN_RETURN });
    expect((await track(SIDE_TRACK)).json.returnPath).toBe(`/returns/request/${SIDE_RETURN}`);
    world({ sideTrack: SIDE_TRACK, columnReturn: COLUMN_RETURN });
    expect((await track(SIDE_TRACK)).json.returnPath).toBe(`/returns/request/${COLUMN_RETURN}`);
  });
});
