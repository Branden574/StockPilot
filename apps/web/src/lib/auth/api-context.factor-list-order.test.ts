import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  },
}));

import { cookieSessionMfaState } from './api-context';

/**
 * The order of the authenticator state's reads: the user's factor list is
 * read first, and a list that cannot be read throws before the organization's
 * policy is read. A well-formed list reads the policy once.
 */

const USER_ID = '12121212-3434-5656-7878-909090909090';
const ORG_ID = '45454545-6767-8989-0101-232323232323';

function recordingClient(policy: string) {
  const from = vi.fn((_table: string) => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: { mfa_policy: policy }, error: null }),
      }),
    }),
  }));
  return { from, auth: { getSession: vi.fn(), getClaims: vi.fn(), getUser: vi.fn() } };
}

describe('the factor list is read before the organization policy', () => {
  it.each([
    ['a list with a null entry', [null]],
    ['a value that is not a list', { status: 'verified' }],
  ])('%s throws, and no organization read happens', async (_label, factors) => {
    const client = recordingClient('optional');
    await expect(
      cookieSessionMfaState(
        client,
        { id: USER_ID, factors: factors as unknown as Array<{ status?: string }> },
        ORG_ID,
        'staff',
      ),
    ).rejects.toThrow(TypeError);
    expect(client.from).not.toHaveBeenCalled();
  });

  it('a well-formed list reads the policy once, and answers by it', async () => {
    const client = recordingClient('all_required');
    await expect(
      cookieSessionMfaState(client, { id: USER_ID, factors: [] }, ORG_ID, 'staff'),
    ).resolves.toEqual({ mfaRequired: true, mfaSatisfied: false, mfaEnrolled: false });
    expect(client.from).toHaveBeenCalledTimes(1);
    expect(client.from).toHaveBeenCalledWith('organizations');
  });
});
