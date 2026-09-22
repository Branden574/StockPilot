import { describe, expect, it } from 'vitest';

import { enforcedMfaPolicy, UNREADABLE_ORG_MFA_POLICY } from './mfa-policy';

describe('enforcedMfaPolicy', () => {
  it.each(['optional', 'admins_required', 'all_required'] as const)(
    "an organization's own %s policy is the one enforced",
    (policy) => {
      expect(enforcedMfaPolicy({ mfa_policy: policy })).toBe(policy);
    },
  );

  it('an unreadable row is held to the STRICTEST policy, never optional', () => {
    expect(UNREADABLE_ORG_MFA_POLICY).toBe('all_required');
    // Zero rows: row level security hid the organization from this session.
    expect(enforcedMfaPolicy(null)).toBe('all_required');
    expect(enforcedMfaPolicy(undefined)).toBe('all_required');
  });

  it('a value the column cannot hold is not trusted either', () => {
    // NOT NULL with a CHECK on three values: anything else did not come from
    // the organization, so it is treated like no answer at all.
    expect(enforcedMfaPolicy({ mfa_policy: null })).toBe('all_required');
    expect(enforcedMfaPolicy({})).toBe('all_required');
    expect(enforcedMfaPolicy({ mfa_policy: 'OPTIONAL' })).toBe('all_required');
    expect(enforcedMfaPolicy({ mfa_policy: '' })).toBe('all_required');
    expect(enforcedMfaPolicy({ mfa_policy: 1 })).toBe('all_required');
  });
});
