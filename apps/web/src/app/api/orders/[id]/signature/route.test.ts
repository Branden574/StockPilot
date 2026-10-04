import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { GET } from './route';

vi.mock('@/lib/auth/api-context', () => ({
  withApiContext: vi.fn(),
}));

// Mock the export throttle to a no-op (allow) by default. Without this it calls
// the real checkRateLimit, whose RPC fails in the no-DB test env and (fail-
// CLOSED) 429s before the gate this suite is actually testing. Individual tests
// override it to prove the throttle is wired.
vi.mock('@/lib/export-rate-limit', () => ({
  exportRateLimited: vi.fn().mockResolvedValue(null),
}));

// The service-only side table (migration 0389), read with the admin client
// after the gate. Empty by default: the image is on the order row until slice C.
const adminHolder = { client: null as unknown, throws: false };
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    if (adminHolder.throws) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
    return adminHolder.client;
  },
}));
function sideImage(image: string | null, error = false) {
  adminHolder.client = makeSupabaseStub({
    'order_request_secrets.select': error
      ? { data: null, error: { message: 'down' } }
      : { data: image === null ? null : { signature_data_url: image }, error: null },
  }).client;
}

const ORDER_ID = 'abcdef12-3456-7890-abcd-ef1234567890';
const SIGNATURE = 'data:image/png;base64,iVBORw0KGgoAAAANS';

function buildCtx(opts: {
  role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';
  userId?: string;
  /** The row `order_requests` returns for this order (org-scoped read). */
  assignedDriverId?: string | null;
  signature?: string | null;
}) {
  const stub = makeSupabaseStub({
    'order_requests.select': {
      data: {
        signature_data_url: opts.signature ?? SIGNATURE,
        assigned_delivery_user_id: opts.assignedDriverId ?? null,
      },
      error: null,
    },
  });
  return {
    organizationId: 'org-1',
    userId: opts.userId ?? 'u-1',
    role: opts.role,
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(['orders']),
  };
}

function buildRequest(): Parameters<typeof GET>[0] {
  return new Request(
    `https://test.local/api/orders/${ORDER_ID}/signature`,
  ) as unknown as Parameters<typeof GET>[0];
}

const PARAMS = { params: Promise.resolve({ id: ORDER_ID }) };

describe('GET /api/orders/[id]/signature', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(exportRateLimited).mockResolvedValue(null);
    adminHolder.throws = false;
    sideImage(null);
  });

  it('401s without an auth context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await GET(buildRequest(), PARAMS);
    expect(res.status).toBe(401);
  });

  it('returns the signature for an approver (orders:approve)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx({ role: 'manager' }));
    const res = await GET(buildRequest(), PARAMS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { signatureDataUrl: string | null };
    expect(body.signatureDataUrl).toBe(SIGNATURE);
  });

  it('review 7: the image (a customer signature) is never stored by a cache, nor is an empty answer', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx({ role: 'manager' }));
    const res = await GET(buildRequest(), PARAMS);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    // No order row (another org's id): the empty answer is private too.
    const empty = makeSupabaseStub({ 'order_requests.select': { data: null, error: null } });
    vi.mocked(withApiContext).mockResolvedValueOnce({ ...buildCtx({ role: 'manager' }), supabase: empty.client as never });
    const res2 = await GET(buildRequest(), PARAMS);
    expect(res2.status).toBe(200);
    expect(res2.headers.get('cache-control')).toBe('private, no-store');
  });

  it('403s for a member who is neither an approver nor the assigned driver (PII gate)', async () => {
    // A staff/viewer role passes order_requests_select (member-level RLS) but
    // must NOT be able to harvest the signature PNG. This is the finding.
    vi.mocked(withApiContext).mockResolvedValueOnce(
      buildCtx({ role: 'staff', userId: 'bystander', assignedDriverId: 'someone-else' }),
    );
    const res = await GET(buildRequest(), PARAMS);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { signatureDataUrl?: string | null; error?: string };
    // The signature blob must never appear in a 403 body.
    expect(body.signatureDataUrl).toBeUndefined();
  });

  it('returns the signature for the assigned delivery driver (even without orders:approve)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(
      buildCtx({ role: 'staff', userId: 'driver-1', assignedDriverId: 'driver-1' }),
    );
    const res = await GET(buildRequest(), PARAMS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { signatureDataUrl: string | null };
    expect(body.signatureDataUrl).toBe(SIGNATURE);
  });

  it('reads the image from order_request_secrets first (slice C moves images there), then the order column', async () => {
    const SIDE = 'data:image/png;base64,c2lkZQ==';
    sideImage(SIDE);
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx({ role: 'manager' }));
    expect(((await (await GET(buildRequest(), PARAMS)).json()) as { signatureDataUrl: string }).signatureDataUrl).toBe(SIDE);
    // No side image: the column.
    sideImage(null);
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx({ role: 'manager' }));
    expect(((await (await GET(buildRequest(), PARAMS)).json()) as { signatureDataUrl: string }).signatureDataUrl).toBe(SIGNATURE);
    // A failed side read, or no service key: the column, never a 500.
    sideImage(null, true);
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx({ role: 'manager' }));
    expect((await GET(buildRequest(), PARAMS)).status).toBe(200);
    adminHolder.throws = true;
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx({ role: 'manager' }));
    const res = await GET(buildRequest(), PARAMS);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { signatureDataUrl: string }).signatureDataUrl).toBe(SIGNATURE);
  });

  it('a refused caller never reaches the side table', async () => {
    let touched = false;
    adminHolder.client = { from: () => ((touched = true), makeSupabaseStub().client.from('x')) };
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx({ role: 'viewer', userId: 'v', assignedDriverId: 'd' }));
    expect((await GET(buildRequest(), PARAMS)).status).toBe(403);
    expect(touched).toBe(false);
  });

  it('the phone reads it through /api/v1/orders/[id]/signature, the same handler', async () => {
    const alias = await import('../../../v1/orders/[id]/signature/route');
    expect(alias.GET).toBe(GET);
    expect(alias.runtime).toBe('nodejs');
    expect(alias.dynamic).toBe('force-dynamic');
  });

  it('honors the export throttle (429 short-circuits before any read)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx({ role: 'manager' }));
    vi.mocked(exportRateLimited).mockResolvedValueOnce(
      NextResponse.json({ error: 'rate_limited' }, { status: 429 }),
    );
    const res = await GET(buildRequest(), PARAMS);
    expect(res.status).toBe(429);
  });
});
