import { beforeEach, describe, expect, it, vi } from 'vitest';

// server-only is a compile-time marker; inert under vitest's node env.
vi.mock('server-only', () => ({}));

const dbState: {
  row: { email_routing?: unknown } | null;
  error: { code: string; message: string } | null;
} = { row: null, error: null };

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table !== 'organizations') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: dbState.row, error: dbState.error }),
          }),
        }),
      };
    },
  }),
}));

import { getOrgEmailRouting } from './cached-org';

beforeEach(() => {
  dbState.row = null;
  dbState.error = null;
});

/**
 * The read half of the fallback matrix (per-org email routing, migration
 * 0337). The one non-negotiable pair of cells: 42703 — and ONLY 42703 — is
 * the deploy window that fails OPEN to 'fallback'; everything else that is
 * not a valid stored value resolves to a hidden or failed-closed state.
 */
describe('getOrgEmailRouting', () => {
  it("DEPLOY WINDOW: a missing column (42703) is 'fallback' — the only fail-open state", async () => {
    dbState.error = { code: '42703', message: 'column organizations.email_routing does not exist' };
    await expect(getOrgEmailRouting('org-1', 'delivery_request')).resolves.toEqual({
      state: 'fallback',
    });
  });

  it("MUTATION KILL: any OTHER read error is 'unset' (hidden), never 'fallback' — a transient error must not mail L4L", async () => {
    dbState.error = { code: 'XX000', message: 'boom' };
    await expect(getOrgEmailRouting('org-1', 'delivery_request')).resolves.toEqual({
      state: 'unset',
    });
  });

  it("a missing org row is 'unset'", async () => {
    await expect(getOrgEmailRouting('org-1', 'delivery_request')).resolves.toEqual({
      state: 'unset',
    });
  });

  it("a NULL column is 'unset'; an absent feature key is 'unset' for that feature only", async () => {
    dbState.row = { email_routing: null };
    await expect(getOrgEmailRouting('org-1', 'maintenance_request')).resolves.toEqual({
      state: 'unset',
    });

    dbState.row = {
      email_routing: { delivery_request: { to: 'a@b.invalid', cc: 'c@d.invalid' } },
    };
    await expect(getOrgEmailRouting('org-1', 'maintenance_request')).resolves.toEqual({
      state: 'unset',
    });
    await expect(getOrgEmailRouting('org-1', 'delivery_request')).resolves.toEqual({
      state: 'valid',
      recipients: { to: 'a@b.invalid', cc: 'c@d.invalid' },
    });
  });

  it("an invalid stored value is 'invalid' with the guard's reason — fail closed, never the constants", async () => {
    dbState.row = {
      email_routing: { delivery_request: { to: 'a?cc=attacker@evil.test', cc: 'c@d.invalid' } },
    };
    const result = await getOrgEmailRouting('org-1', 'delivery_request');
    expect(result.state).toBe('invalid');
    if (result.state !== 'invalid') throw new Error('expected invalid');
    expect(result.reason).toMatch(/must be exactly one plain email address/);
    expect(JSON.stringify(result)).not.toContain('learn4life');
  });
});
