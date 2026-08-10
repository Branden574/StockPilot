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

  it('honors the export throttle (429 short-circuits before any read)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx({ role: 'manager' }));
    vi.mocked(exportRateLimited).mockResolvedValueOnce(
      NextResponse.json({ error: 'rate_limited' }, { status: 429 }),
    );
    const res = await GET(buildRequest(), PARAMS);
    expect(res.status).toBe(429);
  });
});
