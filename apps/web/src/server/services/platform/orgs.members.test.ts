import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Users tab cannot show an account's status — or decide which of Disable /
 * Re-enable to offer — unless getOrgMembers actually carries it. These lock the
 * widened projection: the column is REQUESTED from the profile embed and the
 * mapper preserves both a live timestamp and an active account's null.
 */

const state: {
  rows: Array<Record<string, unknown>>;
  error: { message: string } | null;
  selected: string | null;
} = { rows: [], error: null, selected: null };

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = vi.fn((cols: string) => {
        state.selected = cols;
        return q;
      });
      q.eq = vi.fn(() => q);
      q.not = vi.fn(() => q);
      q.is = vi.fn(() => q);
      q.order = vi.fn(() => q);
      q.limit = vi.fn(() => Promise.resolve({ data: state.rows, error: state.error }));
      return q;
    },
  }),
}));

import { getOrgMembers } from './orgs';

const ORG = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  state.rows = [];
  state.error = null;
  state.selected = null;
});

describe('getOrgMembers — account status', () => {
  it('asks the profile embed for disabled_at', async () => {
    await getOrgMembers(ORG);
    expect(state.selected).toContain('disabled_at');
  });

  it('carries a disabled timestamp through to the row', async () => {
    state.rows = [
      {
        user_id: 'u-1',
        role: 'member',
        accepted_at: '2026-01-01T00:00:00Z',
        user_profiles: {
          email: 'a@example.com',
          full_name: 'Ada',
          disabled_at: '2026-07-30T12:00:00Z',
        },
      },
    ];
    const member = (await getOrgMembers(ORG))[0]!;
    expect(member.disabledAt).toBe('2026-07-30T12:00:00Z');
    expect(member.email).toBe('a@example.com');
  });

  it('reports an active account as null, including when the embed arrives as an array', async () => {
    state.rows = [
      {
        user_id: 'u-2',
        role: 'admin',
        accepted_at: '2026-01-02T00:00:00Z',
        user_profiles: [{ email: 'b@example.com', full_name: null, disabled_at: null }],
      },
      { user_id: 'u-3', role: 'member', accepted_at: null, user_profiles: null },
    ];
    const rows = await getOrgMembers(ORG);
    expect(rows[0]!.disabledAt).toBeNull();
    expect(rows[1]!.disabledAt).toBeNull();
    expect(rows[1]!.email).toBeNull();
  });
});
