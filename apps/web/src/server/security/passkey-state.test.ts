import { describe, expect, it } from 'vitest';

import {
  compareTimes,
  judgePasskeyAccount,
  passkeyFactsOf,
  timeNanos,
  type AuthFactorFact,
  type PasskeyRowFact,
} from './passkey-state';

/**
 * Plan 2.1 rule 23 (stage 1 review 2 N6): the server judges one account by
 * the database's rule. The accounts below are the ones pgTAP builds for
 * 0475/164 and 0475/166 (supabase/tests/0475_passkeys.test.sql, section 10),
 * with the same ids, sites, removals and factor times, written as the times
 * PostgREST and Auth send. The answers expected are the database's own:
 * 0475/164's list (healthy and finished accounts are left out there; here
 * they read `healthy` and `nothing`) and 0475/166's four.
 */

const SITE = 'stockpilotusa.com';
// now() in the pgTAP run, at microsecond precision; the removal is 120 days
// before it, the passkeys were added 200 days before it.
const NOW = '2026-11-21T09:00:00.654321+00:00';
const REMOVED = '2026-07-24T09:00:00.654321+00:00';
const ADDED = '2026-05-05T09:00:00.654321+00:00';
const ONE_MICROSECOND_AFTER = '2026-07-24T09:00:00.654322Z';
const NINETY_DAYS_AFTER = '2026-10-22T09:00:00.654321Z';

const id = (tail: string) => `a0475000-0000-0000-0000-00000000${tail}`;
const reserved = (tail: string, status: string, created_at = NOW): AuthFactorFact => ({
  id: id(tail),
  factor_type: 'totp',
  status,
  friendly_name: `sp-passkey-bridge-${id(tail).replace(/-/g, '')}`,
  created_at,
});
const row = (rp: string, removed: boolean): PasskeyRowFact => ({
  rp_id: rp,
  removed_at: removed ? REMOVED : null,
});

interface Account {
  rows: PasskeyRowFact[];
  bridge: string | null;
  factors: AuthFactorFact[];
}

const ACCOUNTS: Record<string, Account> = {
  e1: {
    rows: [row(SITE, false)],
    bridge: id('fe10'),
    factors: [
      reserved('fe10', 'verified'),
      // The member's own app beside a healthy bridge.
      { id: id('fe1a'), factor_type: 'totp', status: 'verified', friendly_name: 'e1 app', created_at: NOW },
    ],
  },
  e2: { rows: [row(SITE, false)], bridge: null, factors: [] },
  e3: { rows: [row(SITE, false)], bridge: id('fe30'), factors: [] },
  e4: { rows: [row(SITE, false)], bridge: id('fe40'), factors: [reserved('fe40', 'unverified')] },
  e5: {
    rows: [row(SITE, false)],
    bridge: id('fe50'),
    factors: [reserved('fe50', 'verified'), reserved('fe51', 'verified')],
  },
  e6: { rows: [row(SITE, true)], bridge: null, factors: [reserved('fe60', 'verified', REMOVED)] },
  e7: { rows: [], bridge: null, factors: [reserved('fe70', 'verified')] },
  e8: { rows: [row(SITE, true)], bridge: id('fe80'), factors: [reserved('fe80', 'verified', REMOVED)] },
  e9: { rows: [row('localhost', false)], bridge: null, factors: [] },
  ea: {
    rows: [row(SITE, false)],
    bridge: id('fea0'),
    factors: [reserved('fea0', 'verified'), reserved('fea1', 'unverified')],
  },
  eb: { rows: [row(SITE, true)], bridge: null, factors: [] },
  ec: {
    rows: [row(SITE, true)],
    bridge: null,
    factors: [reserved('fec0', 'verified', ONE_MICROSECOND_AFTER)],
  },
  ed: {
    rows: [row(SITE, true)],
    bridge: id('fed0'),
    factors: [reserved('fed0', 'verified', NINETY_DAYS_AFTER)],
  },
  ee: { rows: [row(SITE, false)], bridge: id('fee0'), factors: [reserved('fee1', 'verified')] },
};

// Every account's rows were added at ADDED; the state reads only site and removal.
void ADDED;

const stateOf = (name: string) => {
  const a = ACCOUNTS[name]!;
  return judgePasskeyAccount(passkeyFactsOf(a.rows, a.bridge, a.factors, SITE));
};

describe('one account judged by the database rule (rule 23, N6)', () => {
  it('0475/166: the four accounts at the removal and just after it get the database answers', () => {
    expect(['e6', 'e8', 'ec', 'ed'].map((n) => `${n} ${stateOf(n)}`)).toEqual([
      'e6 removal_unfinished',
      'e8 bridge_row_without_passkey',
      'ec bridge_newer_than_removal',
      'ed bridge_newer_than_removal',
    ]);
  });

  it('0475/164: every account of the health list gets the same word', () => {
    const listed = Object.keys(ACCOUNTS)
      .map((n) => [n, stateOf(n)] as const)
      .filter(([, s]) => s !== 'healthy' && s !== 'nothing')
      .map(([n, s]) => `${n} ${s}`);
    expect(listed).toEqual([
      'e2 no_bridge',
      'e3 bridge_factor_missing',
      'e4 bridge_factor_unverified',
      'e5 reserved_factor_without_row',
      'e6 removal_unfinished',
      'e7 bridge_without_passkey',
      'e8 bridge_row_without_passkey',
      'e9 other_site_only',
      'ea unverified_reserved_factor',
      'ec bridge_newer_than_removal',
      'ed bridge_newer_than_removal',
      'ee reserved_factor_without_row',
    ]);
    // Left out of the database's list: a healthy account and a finished removal.
    expect(stateOf('e1')).toBe('healthy');
    expect(stateOf('eb')).toBe('nothing');
  });

  it('0475/165: the facts tell the two reserved_factor_without_row cases apart', () => {
    const e5 = passkeyFactsOf(ACCOUNTS.e5!.rows, ACCOUNTS.e5!.bridge, ACCOUNTS.e5!.factors, SITE);
    const ee = passkeyFactsOf(ACCOUNTS.ee!.rows, ACCOUNTS.ee!.bridge, ACCOUNTS.ee!.factors, SITE);
    expect([e5.bridgeFactorId, e5.bridgeStatus]).toEqual([id('fe50'), 'verified']);
    expect([ee.bridgeFactorId, ee.bridgeStatus]).toEqual([id('fee0'), null]);
  });

  it('a microsecond is told apart: a millisecond Date would call ec a removal not finished', () => {
    expect(new Date(ONE_MICROSECOND_AFTER).getTime()).toBe(new Date(REMOVED).getTime());
    expect(compareTimes(ONE_MICROSECOND_AFTER, REMOVED)).toBe(1);
    expect(compareTimes(REMOVED, '2026-07-24T09:00:00.654321Z')).toBe(0);
    expect(timeNanos('2026-07-24T02:00:00.654321-07:00')).toBe(timeNanos(REMOVED));
  });

  it('N5: a verified reserved factor with no time, or one this code cannot read, is newer (closed)', () => {
    for (const created_at of [null, 'not a time']) {
      const facts = passkeyFactsOf(
        [row(SITE, true)],
        null,
        [{ ...reserved('fe60', 'verified'), created_at }],
        SITE,
      );
      expect(facts.hasOtherVerified).toBe(true);
      expect(facts.newestOtherVerified).toBeNull();
      expect(judgePasskeyAccount(facts)).toBe('bridge_newer_than_removal');
    }
    // The row's own verified factor with no time: closed too.
    const rowFactor = passkeyFactsOf(
      [row(SITE, true)],
      id('fe80'),
      [{ ...reserved('fe80', 'verified'), created_at: null }],
      SITE,
    );
    expect(judgePasskeyAccount(rowFactor)).toBe('bridge_newer_than_removal');
  });

  it('a removal time this code cannot read is closed, never a removal to finish', () => {
    const facts = passkeyFactsOf(
      [{ rp_id: SITE, removed_at: 'garbled' }],
      null,
      [reserved('fe60', 'verified', REMOVED)],
      SITE,
    );
    expect(judgePasskeyAccount(facts)).toBe('bridge_newer_than_removal');
  });

  it('only a TOTP factor whose name starts with the 18 reserved characters counts', () => {
    const notReserved: AuthFactorFact[] = [
      { id: id('ff01'), factor_type: 'totp', status: 'verified', friendly_name: 'sp-passkey-bridge', created_at: NOW },
      { id: id('ff02'), factor_type: 'phone', status: 'verified', friendly_name: 'sp-passkey-bridge-x', created_at: NOW },
      { id: id('ff03'), factor_type: 'totp', status: 'verified', friendly_name: null, created_at: NOW },
    ];
    expect(judgePasskeyAccount(passkeyFactsOf([], null, notReserved, SITE))).toBe('nothing');
    // The row naming a factor that is not reserved-name: missing, as the database reads it.
    const facts = passkeyFactsOf([row(SITE, false)], id('ff01'), notReserved, SITE);
    expect(facts.bridgeStatus).toBeNull();
    expect(judgePasskeyAccount(facts)).toBe('bridge_factor_missing');
  });
});
