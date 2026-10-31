import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /api/v1/me/permissions answers the caller's EFFECTIVE permission set:
 * the phone gates its drawer, its count footer and its role-change offer on it
 * and keeps it until the next good answer.
 *
 * Docket S19: it never answers with the role's static defaults. That fallback
 * would hand back every permission the organization took away, plus
 * orders:manage_catalog_visibility, a platform-managed key StockPilot may have
 * denied this member. A context without an effective set is refused as a
 * server error the phone retries, never as a 401 or 403, which it words as
 * "You do not have access to that."
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

import { ROLE_PERMISSIONS, type ModuleId, type Permission, type Role } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { PermissionsUnavailableError } from '@/lib/auth/effective-permissions';
import type { ServiceContext } from '@/server/services/context';

import { GET } from './route';

const KEY: Permission = 'orders:manage_catalog_visibility';
const UNAVAILABLE = { name: 'PermissionsUnavailableError', code: 'PERMISSIONS_UNAVAILABLE' };

const request = () =>
  new Request('https://app.test/api/v1/me/permissions', {
    headers: { authorization: 'Bearer token' },
  });

function context(role: Role, permissions?: Set<Permission>): ServiceContext {
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    role,
    ...(permissions ? { permissions } : {}),
    supabase: {} as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/v1/me/permissions', () => {
  it('a context with no effective set is refused as unavailable, never answered with the role defaults', async () => {
    // What the old fallback answered, platform-managed key included.
    expect(ROLE_PERMISSIONS.manager).toContain(KEY);
    vi.mocked(withApiContext).mockResolvedValue(context('manager'));
    const answer = await GET(request()).catch((e: unknown) => e);
    expect(answer).toMatchObject(UNAVAILABLE);
  });

  it('answers exactly the effective set, and never lets it be cached', async () => {
    const permissions = new Set<Permission>(['items:read', 'orders:request']);
    vi.mocked(withApiContext).mockResolvedValue(context('staff', permissions));
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      role: 'staff',
      permissions: ['items:read', 'orders:request'],
    });
  });

  it('a permission set the context could not read escapes as a server error, never a 401 or 403', async () => {
    vi.mocked(withApiContext).mockRejectedValue(new PermissionsUnavailableError());
    const answer = await GET(request()).catch((e: unknown) => e);
    expect(answer).toBeInstanceOf(PermissionsUnavailableError);
  });

  it('a caller with no session is still a 401', async () => {
    vi.mocked(withApiContext).mockResolvedValue(null);
    const res = await GET(request());
    expect(res.status).toBe(401);
  });
});
