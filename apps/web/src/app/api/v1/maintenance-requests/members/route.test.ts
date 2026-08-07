import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { ModuleId, Permission } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { GET } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

/**
 * `fetchAcceptedMembers` (server/lib/maintenance-members.ts) is NOT mocked —
 * this route's whole job is that one real query, so the test exercises it
 * end to end against the supabase-mock stub, same posture as [id]/route.
 * test.ts keeping maintenanceShareLinksEnabled real.
 */
type MemberRow = {
  user_id: string;
  user: { id: string; full_name: string | null; email: string } | null;
};

function buildCtx(opts: { permissions?: Permission[]; membersData?: MemberRow[] } = {}) {
  const stub = makeSupabaseStub({
    'organization_members.select': { data: opts.membersData ?? [], error: null },
  });
  return {
    stub,
    ctx: {
      organizationId: 'org-1',
      userId: 'u-1',
      role: 'staff' as const,
      permissions: opts.permissions ? new Set(opts.permissions) : undefined,
      supabase: stub.client as never,
      mfaRequired: false,
      mfaSatisfied: true,
      enabledModules: new Set<ModuleId>(['maintenance_requests']),
    },
  };
}

function getReq() {
  return new NextRequest('http://localhost/api/v1/maintenance-requests/members');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/v1/maintenance-requests/members', () => {
  it('returns 401 with no context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await GET(getReq());
    expect(res.status).toBe(401);
  });

  it('returns 403 for a submit-only caller (manage-gated) and never queries the org roster', async () => {
    const { ctx, stub } = buildCtx({ permissions: ['maintenance_requests:submit'] });
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx as never);
    const res = await GET(getReq());
    expect(res.status).toBe(403);
    expect(stub.chains.has('organization_members.select')).toBe(false);
  });

  it('returns the accepted-members roster, sorted by name, as an allow-list projection of ONLY userId + name', async () => {
    const { ctx } = buildCtx({
      permissions: ['maintenance_requests:manage'],
      membersData: [
        { user_id: 'u-2', user: { id: 'u-2', full_name: 'Zoe Zephyr', email: 'zoe@example.com' } },
        { user_id: 'u-1', user: { id: 'u-1', full_name: 'Andrew Rosas', email: 'andrew@example.com' } },
        // No full_name — falls back to email, matching fetchAcceptedMembers.
        { user_id: 'u-3', user: { id: 'u-3', full_name: null, email: 'noname@example.com' } },
      ],
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx as never);
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      members: [
        { userId: 'u-1', name: 'Andrew Rosas' },
        { userId: 'u-3', name: 'noname@example.com' },
        { userId: 'u-2', name: 'Zoe Zephyr' },
      ],
    });
    // Allow-list pin (GC — cross-org leakage here would be a Critical): every
    // member object carries EXACTLY these two keys, never email/role/raw row.
    for (const m of body.members as Record<string, unknown>[]) {
      expect(Object.keys(m).sort()).toEqual(['name', 'userId']);
    }
  });

  it('scopes the roster query to this org and to accepted members only (chainArgs pin)', async () => {
    const { ctx, stub } = buildCtx({
      permissions: ['maintenance_requests:manage'],
      membersData: [{ user_id: 'u-1', user: { id: 'u-1', full_name: 'Andrew Rosas', email: 'andrew@example.com' } }],
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx as never);
    await GET(getReq());
    expect(stub.chainArgs.get('organization_members.select')).toContainEqual(['organization_id', 'org-1']);
    expect(stub.chainArgs.get('organization_members.select')).toContainEqual(['accepted_at', 'is', null]);
  });

  it('maps an unmapped thrown error to 500 and reports it', async () => {
    const { ctx, stub } = buildCtx({ permissions: ['maintenance_requests:manage'] });
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx as never);
    stub.client.from.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const res = await GET(getReq());
    expect(res.status).toBe(500);
    const { reportError } = await import('@/lib/error-reporter');
    expect(reportError).toHaveBeenCalled();
  });
});
