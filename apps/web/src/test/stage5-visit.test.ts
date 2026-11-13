import { describe, expect, it } from 'vitest';

import {
  coverageProblems,
  requiredLooks,
  visitOutcome,
} from '../../tests/e2e/appearance/stage5-visit';

/**
 * What a stage 5 accessibility spec may conclude from opening a page
 * (stage5-pages.ts visit) and how much a look loop must have measured. The
 * defect these rules close: a page answering 500 read as "does not open for
 * this role", so signed in its test skipped and signed out it measured
 * nothing and passed; a glass build that crashed a route was green.
 */

describe('visitOutcome', () => {
  it('a page that drew', () => {
    expect(visitOutcome('/dashboard', 200, '/dashboard', false)).toEqual({ kind: 'drawn' });
    expect(visitOutcome('/', 200, '/', true)).toEqual({ kind: 'drawn' });
    // A page that opens one of its own sub-pages still drew.
    expect(visitOutcome('/dashboard/settings', 200, '/dashboard/settings/profile', false)).toEqual({
      kind: 'drawn',
    });
  });

  it('FAILS a server error, signed in or out (it used to skip or pass)', () => {
    for (const status of [500, 502, 503]) {
      expect(visitOutcome('/dashboard/inventory', status, '/dashboard/inventory', false).kind).toBe(
        'failure',
      );
      expect(visitOutcome('/pricing', status, '/pricing', true).kind).toBe('failure');
    }
    expect(visitOutcome('/dashboard', null, '/dashboard', false).kind).toBe('failure');
  });

  it('a signed-in route answering 401, 403 or 404 is one this role may not open (a skip)', () => {
    for (const status of [401, 403, 404])
      expect(visitOutcome('/dashboard/team', status, '/dashboard/team', false)).toEqual({
        kind: 'no-access',
        reason: `/dashboard/team answered ${status} for this role`,
      });
    expect(visitOutcome('/dashboard/team', 200, '/dashboard', false).kind).toBe('no-access');
  });

  it('FAILS any other 4xx, and any 4xx on a page every visitor may open', () => {
    expect(visitOutcome('/dashboard/team', 400, '/dashboard/team', false).kind).toBe('failure');
    expect(visitOutcome('/dashboard/team', 429, '/dashboard/team', false).kind).toBe('failure');
    expect(visitOutcome('/pricing', 404, '/pricing', true).kind).toBe('failure');
    expect(visitOutcome('/signin', 403, '/signin', true).kind).toBe('failure');
  });

  it('FAILS a signed-in page that lands on /signin (the session was lost)', () => {
    expect(visitOutcome('/dashboard', 200, '/signin', false)).toEqual({
      kind: 'failure',
      reason: '/dashboard: sent to /signin (the session was lost)',
    });
    expect(visitOutcome('/dashboard/books', 200, '/signin/mfa', false).kind).toBe('failure');
  });
});

describe('coverage of a look loop', () => {
  it('requires both Classic looks, and both glass looks on a glass build', () => {
    expect(requiredLooks(false)).toEqual(['Dark', 'Light']);
    expect(requiredLooks(true)).toEqual(['Dark', 'Light', 'Day glass', 'Night glass']);
    expect(requiredLooks(true, false)).toEqual(['Day glass', 'Night glass']);
  });
  it('FAILS a loop that measured nothing, or missed a required look', () => {
    expect(coverageProblems('/pricing', [], requiredLooks(true))).toEqual([
      '/pricing: no look was measured',
    ]);
    expect(coverageProblems('/pricing', ['Dark', 'Light'], requiredLooks(true))).toEqual([
      '/pricing: Day glass was not measured',
      '/pricing: Night glass was not measured',
    ]);
    expect(coverageProblems('/pricing', ['Dark', 'Light'], requiredLooks(false))).toEqual([]);
  });
});
