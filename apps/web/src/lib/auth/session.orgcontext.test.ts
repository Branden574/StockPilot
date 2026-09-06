import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * requireOrgContext must derive the organization from a MEMBERSHIP, never from
 * the raw `user_profiles.default_organization_id` preference.
 *
 * THE HOLE THIS PINS: nothing cleared that column when a member was removed,
 * and the resolver read it directly. A user removed from org A while still a
 * member of org B got `organizationId: 'org-A'` carrying org B's role, name
 * and permissions. RLS blocks a non-member's ordinary reads, but every
 * service-role path scopes by `ctx.organizationId` — so writes were aimed at
 * an org the user had been removed from, with authority borrowed from another.
 */

const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers({ 'x-stockpilot-user-id': 'u1', 'x-stockpilot-user-email': 'u1@example.com' })),
  cookies: vi.fn(async () => ({ get: () => undefined, set: () => {}, delete: () => {} })),
}));
vi.mock('@/lib/auth/effective-permissions', () => ({
  loadEffectivePermissions: vi.fn(async () => new Set<string>()),
}));

const profileRow = {
  id: 'u1',
  email: 'u1@example.com',
  full_name: 'Removed User',
  avatar_url: null,
  default_organization_id: 'org-A', // STALE: no longer a member of A
  disabled_at: null,
  deleted_at: null,
};
const memberRows = [
  { organization_id: 'org-B', role: 'staff', organizations: { id: 'org-B', name: 'Org B' } },
];

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'u1@example.com' } }, error: null }) },
    from: (table: string) => {
      const result =
        table === 'user_profiles'
          ? { data: profileRow, error: null }
          : { data: memberRows, error: null };
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'not', 'is', 'order', 'limit']) {
        builder[m] = () => builder;
      }
      builder.maybeSingle = async () => ({ data: result.data, error: null });
      builder.single = async () => ({ data: result.data, error: null });
      builder.then = (res: (v: unknown) => unknown) => res(result);
      return builder;
    },
  }),
}));

beforeEach(() => vi.clearAllMocks());

describe('requireOrgContext — a stale default org never becomes the context', () => {
  it('uses the resolved membership org, not the removed org in the profile column', async () => {
    const { requireOrgContext } = await import('./session');
    const ctx = await requireOrgContext();
    // Before the fix this was 'org-A' — an org the user is not a member of —
    // while role/name came from org B.
    expect(ctx.organizationId).toBe('org-B');
    expect(ctx.organizationName).toBe('Org B');
    expect(ctx.role).toBe('staff');
  });

  it('never returns an organizationId that has no matching membership', async () => {
    const { requireOrgContext } = await import('./session');
    const ctx = await requireOrgContext();
    expect(memberRows.map((m) => m.organization_id)).toContain(ctx.organizationId);
  });
});
