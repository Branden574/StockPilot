import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { sha256Hex } from '@/lib/token-hash';
import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

/**
 * POST /api/v1/orders/signature-lookup (migration 0389): the phone's scan tab
 * reads a scanned packing slip's order before the signature pad opens (the
 * F2-2 departure confirm). The order row holds the token's sha256 since 0389,
 * so the server hashes the scanned raw token. A raw column minted before 0389
 * still matches (until slice C). A DIGEST presented here matches nothing (it
 * is hashed again), and every miss is the same 404: unknown, another
 * organization, the orders module off, a malformed body. The order and lines
 * are read with the caller's own client (row level security).
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminHolder.client }));

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';

import { POST } from './route';

const RAW = '2d'.repeat(32);
const DIGEST = sha256Hex(RAW);
const LEGACY = 'e1'.repeat(32);
const ORDER_ID = '0a000000-0000-4000-8000-000000000392';
const ORG = 'org-l4l';

function world(column: string, side: string | null, org = ORG) {
  adminHolder.client = makeSupabaseStub({
    'order_requests.select': servedLikePostgrest([{ id: ORDER_ID, organization_id: org, signature_token: column }]),
    'order_request_secrets.select': servedLikePostgrest(
      side === null ? [] : [{ order_request_id: ORDER_ID, signature_token: side }],
    ),
  }).client;
}

function signIn(opts: { modules?: ModuleId[]; linesError?: boolean } = {}) {
  const user = makeSupabaseStub({
    'order_requests.select': servedLikePostgrest([
      { id: ORDER_ID, organization_id: ORG, status: 'staged_for_pickup' },
    ]),
    'order_request_lines.select': opts.linesError
      ? { data: null, error: { message: 'boom' } }
      : servedLikePostgrest([
          {
            id: 'l-pen',
            order_request_id: ORDER_ID,
            created_at: '2026-10-01T00:00:00Z',
            quantity_requested: 60,
            quantity_fulfilled: 0,
            quantity_picked: 0,
            item: { name: 'Pen' },
          },
          {
            id: 'l-hidden',
            order_request_id: ORDER_ID,
            created_at: '2026-10-02T00:00:00Z',
            quantity_requested: '3',
            quantity_fulfilled: null,
            quantity_picked: null,
            item: null,
          },
        ]),
  });
  vi.mocked(withApiContext).mockResolvedValue(
    makeServiceContext(user.client, {
      organizationId: ORG,
      role: 'staff',
      enabledModules: new Set<ModuleId>(opts.modules ?? DEFAULT_MODULE_IDS),
    }) as never,
  );
  return user;
}

async function lookup(body: unknown) {
  const res = await POST(
    new NextRequest('https://test.local/api/v1/orders/signature-lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  world(DIGEST, RAW);
});

describe('POST /api/v1/orders/signature-lookup', () => {
  it('401 without a session', async () => {
    vi.mocked(withApiContext).mockResolvedValue(null);
    expect((await lookup({ token: RAW })).status).toBe(401);
  });

  it("the scanned raw token answers the slip's order and its lines, in the shape the phone's readSignatureOrder returns", async () => {
    const user = signIn();
    const res = await lookup({ token: RAW });
    expect(res.status).toBe(200);
    expect(res.json.orderId).toBe(ORDER_ID);
    expect(res.json.status).toBe('staged_for_pickup');
    const lines = res.json.lines as Array<Record<string, unknown>>;
    expect(lines[0]).toEqual({ orderRequestLineId: 'l-pen', name: 'Pen', requested: 60, fulfilled: 0, picked: 0 });
    // A hidden item keeps core's label; nulls are 0.
    expect(lines[1]).toMatchObject({ orderRequestLineId: 'l-hidden', requested: 3, fulfilled: 0, picked: 0 });
    expect(typeof lines[1]!.name).toBe('string');
    expect((lines[1]!.name as string).length).toBeGreaterThan(0);
    // The order and lines come through the caller's own client, scoped to their org.
    expect(user.chainArgsAll.get('order_requests.select')?.[0]).toContainEqual(['organization_id', ORG]);
    // The answer never carries a token.
    expect(JSON.stringify(res.json)).not.toContain(RAW);
    expect(JSON.stringify(res.json)).not.toContain(DIGEST);
  });

  it('a QR printed before 0389 matches (0392 hashed its column in place)', async () => {
    signIn();
    world(sha256Hex(LEGACY), null);
    expect((await lookup({ token: LEGACY })).status).toBe(200);
  });

  it('0392: a value equal to the column (a digest, side row or not) is the same 404', async () => {
    signIn();
    world(LEGACY, null);
    expect(await lookup({ token: LEGACY })).toEqual({ status: 404, json: { error: 'not_found' } });
  });

  it('the DIGEST (what every member reads) matches nothing: the same 404', async () => {
    signIn();
    const res = await lookup({ token: DIGEST });
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'not_found' });
  });

  it("another organization's slip, an unknown token, the orders module off, a malformed body: the same 404", async () => {
    signIn();
    world(DIGEST, RAW, 'org-other');
    expect(await lookup({ token: RAW })).toEqual({ status: 404, json: { error: 'not_found' } });
    world(DIGEST, RAW);
    expect(await lookup({ token: '0'.repeat(64) })).toEqual({ status: 404, json: { error: 'not_found' } });
    expect(await lookup({ token: 'short' })).toEqual({ status: 404, json: { error: 'not_found' } });
    expect(await lookup('{not json')).toEqual({ status: 404, json: { error: 'not_found' } });
    signIn({ modules: DEFAULT_MODULE_IDS.filter((m) => m !== 'orders') });
    expect(await lookup({ token: RAW })).toEqual({ status: 404, json: { error: 'not_found' } });
  });

  it('a failed lines read is a reported 500 (the phone then opens the pad, never blocked)', async () => {
    signIn({ linesError: true });
    const res = await lookup({ token: RAW });
    expect(res.status).toBe(500);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
