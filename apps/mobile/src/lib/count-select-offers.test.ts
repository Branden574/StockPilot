import { describe, expect, it } from 'vitest';

import {
  COUNT_START_MANAGER_ONLY_COPY,
  DEFAULT_MODULE_IDS,
  type Permission,
  type Role,
} from '@stockpilot/core';

import { countSelectOffers, countStartFailureMessage } from './count-select-offers';

/**
 * WHAT THE ITEMS AND BOOKS SELECT BAR OFFERS, AND TO WHOM (B42).
 *
 * Review opens New count, which only a manager with cycle_counts:assign and
 * stock:adjust may start (the server's assertCountStartFloors; core
 * countStartAllowed is its yes/no). It was drawn for everyone in select mode,
 * so staff picked items, pressed Start count and read "Missing permission:
 * cycle_counts:assign". Group and Ungroup keep their own rules, and Select
 * itself is offered only when the bar would have something to offer.
 */

/** The phone's module set before the first snapshot (enabled-modules.ts). */
const ALL_MODULES: ReadonlySet<string> = new Set(DEFAULT_MODULE_IDS);
const NO_CYCLE_COUNTS: ReadonlySet<string> = new Set(
  DEFAULT_MODULE_IDS.filter((m) => m !== 'cycle_counts'),
);
/** Sports is off by default everywhere (registry.ts), on per organization. */
const WITH_SPORTS: ReadonlySet<string> = new Set([...DEFAULT_MODULE_IDS, 'sports']);

function offers(
  role: Role | null,
  permissions?: Permission[],
  enabledModules: ReadonlySet<string> = ALL_MODULES,
) {
  return countSelectOffers({
    role,
    permissions: permissions ? new Set(permissions) : undefined,
    enabledModules,
  });
}

describe('countSelectOffers', () => {
  it('the default module set has Cycle Counts on (a cold start offers it to a known manager)', () => {
    expect(ALL_MODULES.has('cycle_counts')).toBe(true);
  });

  it('staff defaults: Group, but no Review', () => {
    expect(offers('staff')).toMatchObject({ review: false, group: true, any: true });
  });

  it('a viewer gets nothing, so no Select', () => {
    expect(offers('viewer')).toEqual({
      review: false,
      group: false,
      unlinkFamilies: false,
      any: false,
    });
  });

  it('a manager gets Review', () => {
    expect(offers('manager')).toMatchObject({ review: true, group: true, any: true });
    expect(offers('owner')).toMatchObject({ review: true });
  });

  it('a manager with Cycle Counts off gets no Review', () => {
    expect(offers('manager', undefined, NO_CYCLE_COUNTS)).toMatchObject({ review: false });
  });

  it('staff with both keys by override get no Review (the role floor)', () => {
    expect(offers('staff', ['cycle_counts:assign', 'stock:adjust', 'items:update'])).toMatchObject({
      review: false,
      group: true,
    });
  });

  it('a manager whose cycle_counts:assign was taken away gets no Review', () => {
    expect(offers('manager', ['stock:adjust', 'items:update'])).toMatchObject({
      review: false,
      group: true,
    });
  });

  it('an unknown role gets no Review, and keeps Select for Group while the reads arrive', () => {
    expect(offers(null)).toMatchObject({ review: false, group: true, any: true });
  });

  it('families: sports:manage with the sports module on', () => {
    expect(offers('manager', undefined, WITH_SPORTS).unlinkFamilies).toBe(true);
    expect(offers('manager').unlinkFamilies).toBe(false);
  });

  // Ungroup is offered only with items:update (phoneUngroupOffer refuses
  // without it), so sports:manage alone gives the bar nothing to offer.
  it('sports:manage without items:update offers nothing', () => {
    expect(offers('staff', ['sports:manage'], WITH_SPORTS)).toMatchObject({
      review: false,
      group: false,
      unlinkFamilies: true,
      any: false,
    });
  });
});

describe('countStartFailureMessage', () => {
  const failure = (status: number, message: string) =>
    Object.assign(new Error(message), { status, code: status === 403 ? 'forbidden' : 'x' });

  it("an older server's raw permission refusal reads as the plain sentence", () => {
    expect(countStartFailureMessage(failure(403, 'Missing permission: cycle_counts:assign'))).toBe(
      COUNT_START_MANAGER_ONLY_COPY,
    );
    expect(countStartFailureMessage(failure(403, 'Missing permission: stock:adjust'))).toBe(
      COUNT_START_MANAGER_ONLY_COPY,
    );
  });

  it("every other refusal keeps the server's own words (the module, the MFA check, a warehouse)", () => {
    for (const message of [
      COUNT_START_MANAGER_ONLY_COPY,
      'Module not enabled for this organization: cycle_counts',
      'Re-authenticate with MFA before performing this action.',
      'You cannot count items that have no warehouse.',
    ]) {
      expect(countStartFailureMessage(failure(403, message))).toBe(message);
    }
    expect(countStartFailureMessage(failure(400, 'Pick at least one item to count.'))).toBe(
      'Pick at least one item to count.',
    );
  });

  it('something that is not an error says to try again', () => {
    expect(countStartFailureMessage('boom')).toBe('Please try again.');
    expect(countStartFailureMessage(undefined)).toBe('Please try again.');
  });
});
