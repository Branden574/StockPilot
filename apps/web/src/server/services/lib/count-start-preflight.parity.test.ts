import { describe, expect, it } from 'vitest';

import { countStartAllowed, ROLES, type Permission, type Role } from '@stockpilot/core';

import type { ServiceContext } from '../context';
import { canStartCount } from './count-start-preflight';

/**
 * ONE RULE FOR "MAY START A COUNT" (pattern #26). The server decides with
 * assertCountStartFloors (canStartCount is it as a yes/no); the phone hides
 * Recount and Count this item with core countStartAllowed. If the two drift,
 * the phone offers a button the server refuses, or hides one it would allow.
 * This walks every role, every combination of the two permissions and the
 * module, and requires the same answer from both.
 *
 * Mutation caught: dropping the manager role from either copy (staff with
 * both keys by override), or the module check from the core copy.
 */

const KEYS: Permission[] = ['cycle_counts:assign', 'stock:adjust'];

function ctxFor(role: Role, permissions: Set<Permission>, cycleCountsEnabled: boolean): ServiceContext {
  return {
    role,
    permissions,
    enabledModules: new Set(cycleCountsEnabled ? ['cycle_counts'] : []),
    mfaRequired: false,
    mfaSatisfied: true,
  } as unknown as ServiceContext;
}

describe('canStartCount (server) and countStartAllowed (core, phone) agree', () => {
  for (const role of ROLES) {
    for (let mask = 0; mask < 1 << KEYS.length; mask += 1) {
      const permissions = new Set(KEYS.filter((_, i) => mask & (1 << i)));
      for (const enabled of [true, false]) {
        it(`${role} with [${[...permissions].join(', ')}], module ${enabled ? 'on' : 'off'}`, () => {
          expect(countStartAllowed({ role, permissions, cycleCountsEnabled: enabled })).toBe(
            canStartCount(ctxFor(role, permissions, enabled)),
          );
        });
      }
    }
  }

  it('the matrix includes a yes and a no (so it cannot pass vacuously)', () => {
    const all = new Set(KEYS);
    expect(canStartCount(ctxFor('manager', all, true))).toBe(true);
    expect(canStartCount(ctxFor('staff', all, true))).toBe(false);
  });
});
