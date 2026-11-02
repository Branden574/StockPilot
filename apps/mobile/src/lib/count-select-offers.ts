import {
  COUNT_START_MANAGER_ONLY_COPY,
  countStartAllowed,
  type Permission,
  type Role,
} from '@stockpilot/core';

import { showWriteCtaForRole } from './cta-gating';

/**
 * What the Items and Books select bar offers, and to whom (B42).
 *
 * Review opens New count, which only a manager with cycle_counts:assign and
 * stock:adjust may start (the server's assertCountStartFloors). It was drawn
 * for everyone in select mode, and Select was offered to everyone, so staff
 * picked items, pressed Start count and read the server's raw refusal.
 */
export interface CountSelectOffers {
  /** Review: core countStartAllowed (the cycle_counts module, both keys, the
   *  manager role). No while the role is unknown, as for Distribute. */
  review: boolean;
  /** Group selected: items:update (showWriteCtaForRole, so it shows while
   *  the role and the permissions are still unknown; the route refuses on its
   *  own). Ungroup is offered on the same key. */
  group: boolean;
  /** Ungroup may also take a record out of a size family: sports:manage
   *  with the sports module on. */
  unlinkFamilies: boolean;
  /** Select is worth offering: the bar would draw Review or Group. Ungroup
   *  needs items:update too (phoneUngroupOffer refuses without it), so
   *  sports:manage alone gives the bar nothing to offer. */
  any: boolean;
}

export function countSelectOffers(input: {
  role: Role | null;
  permissions: ReadonlySet<Permission> | undefined;
  enabledModules: ReadonlySet<string>;
}): CountSelectOffers {
  const { role, permissions, enabledModules } = input;
  const review = countStartAllowed({
    role,
    permissions,
    cycleCountsEnabled: enabledModules.has('cycle_counts'),
  });
  const group = showWriteCtaForRole(role, permissions, 'items:update');
  const unlinkFamilies =
    showWriteCtaForRole(role, permissions, 'sports:manage') && enabledModules.has('sports');
  return { review, group, unlinkFamilies, any: review || group };
}

/**
 * What New count's alert says when a start fails (B42). A server from before
 * this change refuses with assertPermission's raw words ("Missing permission:
 * cycle_counts:assign"); those read as the plain sentence. Every other
 * refusal keeps the server's own words (the module, the MFA check, a
 * warehouse, an empty selection), and anything that is not an error says to
 * try again.
 */
export function countStartFailureMessage(e: unknown): string {
  if (!(e instanceof Error)) return 'Please try again.';
  const status = (e as { status?: unknown }).status;
  if (status === 403 && e.message.startsWith('Missing permission:')) {
    return COUNT_START_MANAGER_ONLY_COPY;
  }
  return e.message;
}
