import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

/**
 * The "last seen" beacon (migration 0352). The browser and the mobile app call
 * this on person-driven moments so the platform console can tell when someone
 * last had StockPilot open, even if they only read and then signed out.
 *
 * What matters here:
 *   - It stamps the CALLER in the CALLER'S active organization. Nothing the
 *     client sends chooses the user or the organization: a body is ignored.
 *   - It is fire-and-forget telemetry. A failure must never surface as an
 *     error the client has to handle, and must never be silent on the server
 *     (`Database = any`, so a typo in the rpc name would compile, fail, and be
 *     swallowed forever).
 */

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const rpc = vi.fn();

function buildCtx() {
  return {
    organizationId: ORG_ID,
    userId: 'u-1',
    role: 'viewer' as const,
    permissions: undefined,
    supabase: { rpc: (...a: unknown[]) => rpc(...a) } as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(),
  };
}

function req(body?: unknown) {
  return new Request('http://localhost/api/v1/me/seen', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: null, error: null });
  vi.mocked(withApiContext).mockResolvedValue(buildCtx());
});

describe('POST /api/v1/me/seen', () => {
  it('stamps the caller in their active organization, as the caller', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    // JSON on purpose: the mobile api() client parses every 2xx body.
    expect(await res.json()).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('touch_member_last_seen', { p_org_id: ORG_ID });
  });

  it('ignores anything the client sends: the body cannot choose a user or an organization', async () => {
    await POST(
      req({ organizationId: '99999999-9999-4999-8999-999999999999', userId: 'someone-else' }),
    );
    expect(rpc).toHaveBeenCalledWith('touch_member_last_seen', { p_org_id: ORG_ID });
  });

  it('answers 401 and writes nothing when there is no session', async () => {
    vi.mocked(withApiContext).mockResolvedValue(null);
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('never fails the client when the stamp fails, and reports it', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'function does not exist', code: 'PGRST202' },
    });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportError).mock.calls[0]![1]).toMatchObject({
      tag: 'activity.touch-last-seen',
    });
  });

  it('does the same when the rpc throws', async () => {
    rpc.mockRejectedValue(new Error('fetch failed'));
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('is never cached', async () => {
    const res = await POST(req());
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
