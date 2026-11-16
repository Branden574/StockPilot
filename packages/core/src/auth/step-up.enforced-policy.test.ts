import { describe, expect, it } from 'vitest';

import {
  authenticatorSetUpOwed,
  enforcedMfaPolicy,
  readOrganizationMfaPolicy,
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

describe('readOrganizationMfaPolicy: the policy as read, or null when it was not read', () => {
  type Field = Parameters<typeof readOrganizationMfaPolicy>[0];

  it.each(['optional', 'admins_required', 'all_required'] as const)(
    '%s read from an object or an array of one',
    (policy) => {
      expect(readOrganizationMfaPolicy({ name: 'Example Org', mfa_policy: policy } as Field)).toBe(
        policy,
      );
      expect(readOrganizationMfaPolicy([{ mfa_policy: policy }])).toBe(policy);
    },
  );

  it('an array answers its first element only', () => {
    expect(
      readOrganizationMfaPolicy([{ mfa_policy: 'optional' }, { mfa_policy: 'all_required' }]),
    ).toBe('optional');
    expect(readOrganizationMfaPolicy([null, { mfa_policy: 'all_required' }])).toBeNull();
  });

  it('not read: no row, an empty array, a value that is not an object', () => {
    expect(readOrganizationMfaPolicy(null)).toBeNull();
    expect(readOrganizationMfaPolicy(undefined)).toBeNull();
    expect(readOrganizationMfaPolicy([])).toBeNull();
    for (const odd of ['all_required', 7, true, [['all_required']]]) {
      expect(readOrganizationMfaPolicy(odd as unknown as Field)).toBeNull();
    }
  });

  it('not read: a policy value the column cannot hold', () => {
    for (const mfa_policy of [
      'ALL_REQUIRED',
      ' all_required',
      '',
      'required',
      null,
      1,
      undefined,
    ]) {
      expect(readOrganizationMfaPolicy({ mfa_policy })).toBeNull();
      expect(readOrganizationMfaPolicy([{ mfa_policy }])).toBeNull();
    }
    expect(readOrganizationMfaPolicy({})).toBeNull();
  });

  it('a real all_required is told apart from a row that was not read', () => {
    expect(readOrganizationMfaPolicy({ mfa_policy: 'all_required' })).toBe('all_required');
    expect(readOrganizationMfaPolicy(null)).toBeNull();
    // Both are ENFORCED the same way.
    expect(enforcedMfaPolicy({ mfa_policy: 'all_required' })).toBe('all_required');
    expect(enforcedMfaPolicy(null)).toBe('all_required');
  });

  it('what is enforced is the policy as read, or the strictest when not read', () => {
    const shapes: unknown[] = [
      null,
      undefined,
      [],
      {},
      'optional',
      { mfa_policy: 'optional' },
      { mfa_policy: 'admins_required' },
      { mfa_policy: 'all_required' },
      { mfa_policy: 'OPTIONAL' },
      [{ mfa_policy: 'optional' }],
      [{ mfa_policy: 'admins_required' }, { mfa_policy: 'all_required' }],
      [null],
    ];
    for (const shape of shapes) {
      expect(enforcedMfaPolicy(unwrapOrganizationEmbed(shape as object))).toBe(
        readOrganizationMfaPolicy(shape as Field) ?? UNREADABLE_ORG_MFA_POLICY,
      );
    }
  });
});
