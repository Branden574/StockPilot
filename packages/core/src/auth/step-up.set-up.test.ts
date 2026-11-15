import { describe, expect, it } from 'vitest';

import { ROLES } from '../constants/roles';
import { isAdminRole } from '../constants/terminology';

import {
  authenticatorSetUpOwed,
  policyRequiresAuthenticator,
  type OrganizationMfaPolicy,
} from './step-up';

/**
 * Who must set up an authenticator before anything else: the policy requires
 * one of their role, and they have no verified factor.
 */
describe('policyRequiresAuthenticator', () => {
  it.each(ROLES)('all_required requires one of a %s', (role) => {
    expect(policyRequiresAuthenticator('all_required', role)).toBe(true);
  });

  it.each(ROLES)(
    'admins_required requires one of a %s only when the role is an admin role',
    (role) => {
      expect(policyRequiresAuthenticator('admins_required', role)).toBe(isAdminRole(role));
    },
  );

  it('admins_required: owner and admin, and no one else', () => {
    expect(ROLES.filter((r) => policyRequiresAuthenticator('admins_required', r))).toEqual([
      'owner',
      'admin',
    ]);
  });

  it.each(ROLES)('optional requires none of a %s', (role) => {
    expect(policyRequiresAuthenticator('optional', role)).toBe(false);
  });

  it('an unknown role is not an admin role', () => {
    expect(policyRequiresAuthenticator('admins_required', 'auditor')).toBe(false);
  });
});

describe('authenticatorSetUpOwed', () => {
  const verified = { status: 'verified' };
  const unverified = { status: 'unverified' };
  const POLICIES: OrganizationMfaPolicy[] = ['optional', 'admins_required', 'all_required'];

  it.each(POLICIES.flatMap((p) => ROLES.map((r) => [p, r] as const)))(
    '%s, %s with no factor: owed exactly when the policy requires one',
    (policy, role) => {
      expect(authenticatorSetUpOwed(policy, role, [])).toBe(
        policyRequiresAuthenticator(policy, role),
      );
      expect(authenticatorSetUpOwed(policy, role, null)).toBe(
        policyRequiresAuthenticator(policy, role),
      );
    },
  );

  it.each(POLICIES.flatMap((p) => ROLES.map((r) => [p, r] as const)))(
    '%s, %s with a verified factor: never owed',
    (policy, role) => {
      expect(authenticatorSetUpOwed(policy, role, [verified])).toBe(false);
      expect(authenticatorSetUpOwed(policy, role, [unverified, verified])).toBe(false);
    },
  );

  it('an unverified factor alone does not count', () => {
    expect(authenticatorSetUpOwed('admins_required', 'admin', [unverified])).toBe(true);
    expect(authenticatorSetUpOwed('all_required', 'viewer', [unverified, null])).toBe(true);
  });
});
