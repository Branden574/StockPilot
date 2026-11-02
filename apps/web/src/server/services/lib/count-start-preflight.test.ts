import { describe, expect, it } from 'vitest';

import {
  COUNT_START_MANAGER_ONLY_COPY,
  countStartManagerOnly,
  ROLES,
  type ModuleId,
  type Permission,
  type Role,
} from '@stockpilot/core';

import { ServiceError, type ServiceContext } from '../context';
import { assertCountStartFloors, countStartBlock } from './count-start-preflight';

/**
 * A REFUSED START SAYS WHY IN PLAIN WORDS (B42).
 *
 * Staff hold stock:adjust but not cycle_counts:assign, so the start screens
 * offered them a count and the server answered with assertPermission's raw
 * words, "Missing permission: cycle_counts:assign", which the web form toasted
 * and the phone put in its alert. Every refusal of the role and permission
 * floors now says COUNT_START_MANAGER_ONLY_COPY. The module and the MFA
 * step-up keep their own errors: the step-up modal reads details.reason.
 */

const KEYS: Permission[] = ['cycle_counts:assign', 'stock:adjust'];

function ctxFor(
  role: Role,
  permissions: Set<Permission> | undefined,
  extra: Partial<{
    modules: ModuleId[];
    mfaRequired: boolean;
    mfaSatisfied: boolean;
    mfaEnrolled: boolean;
  }> = {},
): ServiceContext {
  return {
    role,
    ...(permissions ? { permissions } : {}),
    enabledModules: new Set(extra.modules ?? ['cycle_counts']),
    mfaRequired: extra.mfaRequired ?? false,
    mfaSatisfied: extra.mfaSatisfied ?? true,
    mfaEnrolled: extra.mfaEnrolled ?? false,
  } as unknown as ServiceContext;
}

function refusal(ctx: ServiceContext): ServiceError {
  try {
    assertCountStartFloors(ctx);
  } catch (e) {
    if (e instanceof ServiceError) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

describe('assertCountStartFloors: the refusal', () => {
  it('a refusal says COUNT_START_MANAGER_ONLY_COPY, never the permission name', () => {
    for (const ctx of [
      // Staff by default: stock:adjust, no cycle_counts:assign.
      ctxFor('staff', undefined),
      // A manager whose cycle_counts:assign was taken away (0207 override).
      ctxFor('manager', new Set<Permission>(['stock:adjust'])),
      // A manager whose stock:adjust was taken away.
      ctxFor('manager', new Set<Permission>(['cycle_counts:assign'])),
      // Staff granted both keys by override still stop at the role.
      ctxFor('staff', new Set<Permission>(KEYS)),
      ctxFor('viewer', undefined),
    ]) {
      const e = refusal(ctx);
      expect(e.code).toBe('forbidden');
      expect(e.message).toBe(COUNT_START_MANAGER_ONLY_COPY);
      expect(e.message).not.toMatch(/Missing permission/);
    }
  });

  it('the module keeps its own error', () => {
    const e = refusal(ctxFor('manager', undefined, { modules: [] }));
    expect(e.code).toBe('module_disabled');
  });

  it('the MFA step-up keeps its own error and reason, before the role is judged', () => {
    const enrolled = refusal(
      ctxFor('manager', undefined, { mfaRequired: true, mfaSatisfied: false, mfaEnrolled: true }),
    );
    expect(enrolled.code).toBe('forbidden');
    expect(enrolled.details).toEqual({ reason: 'aal2_required' });

    const unenrolled = refusal(
      ctxFor('admin', undefined, { mfaRequired: true, mfaSatisfied: false, mfaEnrolled: false }),
    );
    expect(unenrolled.details).toEqual({ reason: 'mfa_required' });

    // Staff at AAL1 under a required check are asked to step up first, as
    // assertPermission did.
    const staff = refusal(
      ctxFor('staff', undefined, { mfaRequired: true, mfaSatisfied: false, mfaEnrolled: true }),
    );
    expect(staff.details).toEqual({ reason: 'aal2_required' });
  });

  it('a manager with both keys and the module passes', () => {
    expect(() => assertCountStartFloors(ctxFor('manager', undefined))).not.toThrow();
    expect(() => assertCountStartFloors(ctxFor('owner', new Set<Permission>(KEYS)))).not.toThrow();
  });

  it('countStartBlock keeps its reasons', () => {
    expect(countStartBlock(ctxFor('staff', undefined))).toBe('not_permitted');
    expect(countStartBlock(ctxFor('manager', undefined, { modules: [] }))).toBe('module_disabled');
    expect(countStartBlock(ctxFor('manager', undefined))).toBeNull();
  });
});

describe('the Start a count screens say the sentence exactly when the server would refuse with it', () => {
  // Module on, no MFA check owed: the role and permission floors decide.
  for (const role of ROLES) {
    for (let mask = 0; mask < 1 << KEYS.length; mask += 1) {
      const permissions = new Set(KEYS.filter((_, i) => mask & (1 << i)));
      it(`${role} with [${[...permissions].join(', ')}]`, () => {
        let refusedWithCopy = false;
        try {
          assertCountStartFloors(ctxFor(role, permissions));
        } catch (e) {
          refusedWithCopy =
            e instanceof ServiceError && e.message === COUNT_START_MANAGER_ONLY_COPY;
        }
        expect(countStartManagerOnly({ role, permissions })).toBe(refusedWithCopy);
      });
    }
  }
});
