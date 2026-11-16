import { describe, expect, it } from 'vitest';

import {
  authenticatorSetUpOwed,
  enforcedMfaPolicy,
  UNREADABLE_ORG_MFA_POLICY,
  unwrapOrganizationEmbed,
} from './step-up';

/**
 * The policy a reader ENFORCES from an organization row as it was read, and
 * the organization row of a membership read through an embed. The website,
 * the API and the phone share both.
 */
describe('enforcedMfaPolicy', () => {
  it.each(['optional', 'admins_required', 'all_required'] as const)(
    "an organization's own %s policy is the one enforced",
    (policy) => {
      expect(enforcedMfaPolicy({ mfa_policy: policy })).toBe(policy);
    },
  );

  it('an unreadable row is held to the strictest policy, never optional', () => {
    expect(UNREADABLE_ORG_MFA_POLICY).toBe('all_required');
    expect(enforcedMfaPolicy(null)).toBe('all_required');
    expect(enforcedMfaPolicy(undefined)).toBe('all_required');
  });

  it('a value the column cannot hold is not trusted either', () => {
    for (const row of [
      { mfa_policy: null },
      {},
      { mfa_policy: 'OPTIONAL' },
      { mfa_policy: '' },
      { mfa_policy: 1 },
      { mfa_policy: ['optional'] },
    ]) {
      expect(enforcedMfaPolicy(row)).toBe('all_required');
    }
  });

  it('an array handed over without unwrapping reads as unreadable', () => {
    // The reason unwrapOrganizationEmbed exists: an array has no mfa_policy.
    expect(
      enforcedMfaPolicy([{ mfa_policy: 'optional' }] as unknown as { mfa_policy?: unknown }),
    ).toBe('all_required');
  });
});

describe('unwrapOrganizationEmbed', () => {
  const org = { name: 'Example Org', mfa_policy: 'optional' };

  it('an object is the row', () => {
    expect(unwrapOrganizationEmbed(org)).toBe(org);
  });

  it('an array answers its first element', () => {
    const other = { name: 'Other Org', mfa_policy: 'all_required' };
    expect(unwrapOrganizationEmbed([org])).toBe(org);
    expect(unwrapOrganizationEmbed([org, other])).toBe(org);
  });

  it('no row, an empty array, or something that is not an object answers null', () => {
    expect(unwrapOrganizationEmbed(null)).toBeNull();
    expect(unwrapOrganizationEmbed(undefined)).toBeNull();
    expect(unwrapOrganizationEmbed([])).toBeNull();
    expect(unwrapOrganizationEmbed([null] as unknown as object[])).toBeNull();
    expect(unwrapOrganizationEmbed('Example Org' as unknown as object)).toBeNull();
    expect(unwrapOrganizationEmbed(7 as unknown as object)).toBeNull();
    expect(unwrapOrganizationEmbed([[org]] as unknown as object[])).toBeNull();
  });

  it('both embed shapes give the same policy, and so the same set-up answer', () => {
    for (const shape of [org, [org]]) {
      const policy = enforcedMfaPolicy(unwrapOrganizationEmbed(shape));
      expect(policy).toBe('optional');
      expect(authenticatorSetUpOwed(policy, 'staff', [])).toBe(false);
    }
    const strict = { name: 'Example Org', mfa_policy: 'admins_required' };
    for (const shape of [strict, [strict]]) {
      const policy = enforcedMfaPolicy(unwrapOrganizationEmbed(shape));
      expect(policy).toBe('admins_required');
      expect(authenticatorSetUpOwed(policy, 'staff', [])).toBe(false);
      expect(authenticatorSetUpOwed(policy, 'admin', [])).toBe(true);
      expect(authenticatorSetUpOwed(policy, 'admin', [{ status: 'verified' }])).toBe(false);
    }
  });

  it('a row the reader could not see is held to the strictest policy', () => {
    for (const shape of [null, [], undefined]) {
      const policy = enforcedMfaPolicy(unwrapOrganizationEmbed(shape));
      expect(policy).toBe('all_required');
      expect(authenticatorSetUpOwed(policy, 'staff', null)).toBe(true);
    }
  });
});
