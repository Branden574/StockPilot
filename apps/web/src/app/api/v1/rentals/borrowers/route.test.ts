import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

/**
 * GET /api/v1/rentals/borrowers: the phone's New rental member search.
 *
 * Driven through the REAL RentalsService.listBorrowerMembers with a stub for
 * the caller's own client, so these pin the whole path:
 *   - rentals:create and the Rentals module, the web New rental page's gate;
 *   - the read goes through the CALLER's client (user_profiles RLS decides
 *     which emails come back) and never the service-role client;
 *   - accepted members only, since create_rental refuses anyone else;
 *   - the answer carries id, name and email, nothing else from the row.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/auth/warehouse', () => ({
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class ForbiddenError extends Error {},
}));
vi.mock('@/lib/email/rentals', () => ({
  sendRentalCheckoutEmail: vi.fn(async () => undefined),
  sendRentalReturnedEmail: vi.fn(async () => undefined),
}));
// A service-role read here would show the caller emails RLS hides from them.
const adminCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    adminCalls.count += 1;
    throw new Error('service-role client used on a user path');
  },
}));

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { callArgs, makeServiceContext, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

import { GET } from './route';

type Role = 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';

function request() {
  return new Request('https://test.local/api/v1/rentals/borrowers', {
    headers: { authorization: 'Bearer t' },
  }) as unknown as Parameters<typeof GET>[0];
}

function arrange(opts: {
  role?: Role;
  permissions?: string[];
  modules?: ModuleId[];
  members?: { data: unknown; error: { message: string } | null };
}) {
  const stub = makeSupabaseStub({
    'organization_members.select': opts.members ?? {
      data: [
        {
          user_id: 'u-2',
          user: { id: 'u-2', full_name: 'Zoe Park', email: 'zoe@school.org' },
          role: 'admin',
        },
        { user_id: 'u-1', user: { id: 'u-1', full_name: null, email: ' ana@school.org ' } },
        // A profile this caller may not read (RLS returns no embed).
        { user_id: 'u-3', user: null },
        { user_id: 'u-4', user: [{ id: 'u-4', full_name: '  Bo Diaz ', email: null }] },
      ],
      error: null,
    },
  });
  const ctx = makeServiceContext(stub.client, {
    role: opts.role ?? 'staff',
    ...(opts.permissions ? { permissions: new Set(opts.permissions) } : {}),
    enabledModules: new Set<ModuleId>(opts.modules ?? ['rentals']),
  });
  vi.mocked(withApiContext).mockResolvedValue(ctx as never);
  return stub;
}

beforeEach(() => {
  vi.clearAllMocks();
  adminCalls.count = 0;
});

describe('GET /api/v1/rentals/borrowers', () => {
  it('401 without a session', async () => {
    vi.mocked(withApiContext).mockResolvedValue(null as never);
    const res = await GET(request());
    expect(res.status).toBe(401);
  });

  it('lists accepted members by name, with their email, and nothing else', async () => {
    const stub = arrange({});
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      members: [
        { userId: 'u-1', displayName: 'ana@school.org', email: 'ana@school.org' },
        { userId: 'u-4', displayName: 'Bo Diaz', email: null },
        { userId: 'u-2', displayName: 'Zoe Park', email: 'zoe@school.org' },
      ],
    });

    const methods = stub.chainsAll.get('organization_members.select')?.[0] ?? [];
    const args = stub.chainArgsAll.get('organization_members.select')?.[0] ?? [];
    const read: MockCall = { table: 'organization_members', op: 'select', methods, args };
    expect(callArgs(read, 'select')?.[0]).toBe('user_id, user:user_profiles!user_id (id, full_name, email)');
    expect(callArgs(read, 'eq')).toEqual(['organization_id', 'org-test']);
    // Accepted only: create_rental refuses any other borrower_user_id.
    expect(callArgs(read, 'not')).toEqual(['accepted_at', 'is', null]);
    // Paged (a team has no size cap).
    expect(methods).toContain('range');
    expect(adminCalls.count).toBe(0);
  });

  it('403 for a member without rentals:create, and nothing is read', async () => {
    const stub = arrange({ role: 'viewer' });
    const res = await GET(request());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('forbidden');
    expect(stub.fromCalls).not.toContain('organization_members');
  });

  it('403 when the organization has Rentals off', async () => {
    const stub = arrange({ modules: [] });
    const res = await GET(request());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('module_disabled');
    expect(stub.fromCalls).not.toContain('organization_members');
  });

  it('a granted rentals:create is enough (configurable permissions)', async () => {
    arrange({ role: 'viewer', permissions: ['rentals:create'] });
    const res = await GET(request());
    expect(res.status).toBe(200);
  });

  it('a failed read is a fixed 500 sentence, never the database text, and is reported', async () => {
    arrange({ members: { data: null, error: { message: 'relation "organization_members" timed out' } } });
    const res = await GET(request());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      error: 'internal_error',
      message: 'Could not load team members. Please try again.',
    });
    expect(JSON.stringify(body)).not.toMatch(/relation/);
    expect(vi.mocked(reportError)).toHaveBeenCalledTimes(1);
  });
});
