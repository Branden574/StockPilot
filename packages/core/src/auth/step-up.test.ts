import { describe, expect, it } from 'vitest';

import { stepUpOwed } from './step-up';

/**
 * Security invariant (docket S43a): the one rule for "this session still owes
 * its authenticator code". The web's API context refuses such a session, and
 * the phone's code gate and S5a's registration check will read the same rule,
 * so the truth table is pinned here once.
 */
describe('stepUpOwed', () => {
  const verified = { status: 'verified' };
  const unverified = { status: 'unverified' };

  it('a verified factor and an aal1 session owe the code', () => {
    expect(stepUpOwed([verified], 'aal1')).toBe(true);
  });

  it('a missing level counts as not aal2 (fail closed)', () => {
    expect(stepUpOwed([verified], null)).toBe(true);
    expect(stepUpOwed([verified], undefined)).toBe(true);
    expect(stepUpOwed([verified], '')).toBe(true);
    // Anything that is not exactly 'aal2' is not aal2.
    expect(stepUpOwed([verified], 'AAL2')).toBe(true);
    expect(stepUpOwed([verified], 'aal3')).toBe(true);
  });

  it('an aal2 session owes nothing', () => {
    expect(stepUpOwed([verified], 'aal2')).toBe(false);
  });

  it('an account with no factor owes nothing, at any level', () => {
    for (const aal of ['aal1', 'aal2', null, undefined]) {
      expect(stepUpOwed([], aal)).toBe(false);
      expect(stepUpOwed(null, aal)).toBe(false);
      expect(stepUpOwed(undefined, aal)).toBe(false);
    }
  });

  it('an unverified factor is not an enrollment', () => {
    expect(stepUpOwed([unverified], 'aal1')).toBe(false);
    expect(stepUpOwed([unverified], null)).toBe(false);
  });

  it('any verified factor counts, whatever its type, and one is enough', () => {
    // GoTrue's factor objects carry more fields than the rule reads.
    const phone = { id: 'factor-1', factor_type: 'phone', status: 'verified' };
    const webauthn = { id: 'factor-2', factor_type: 'webauthn', status: 'verified' };
    expect(stepUpOwed([phone], 'aal1')).toBe(true);
    expect(stepUpOwed([webauthn], 'aal1')).toBe(true);
    expect(stepUpOwed([unverified, verified], 'aal1')).toBe(true);
    expect(stepUpOwed([unverified, verified], 'aal2')).toBe(false);
  });

  it('reads a stored or partial factor list without throwing', () => {
    expect(stepUpOwed([null, undefined, {}, { status: null }], 'aal1')).toBe(false);
    expect(stepUpOwed([null, verified], 'aal1')).toBe(true);
  });
});
