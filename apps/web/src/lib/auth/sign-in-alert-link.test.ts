import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  checkSignInAlertLink,
  issuedDayOf,
  readSignInAlertLink,
  SIGN_IN_ALERT_LINK_DAYS,
  signInAlertLinkInWindow,
  signSignInAlertLink,
} from './sign-in-alert-link';

/**
 * The "This was not me" link of a sign-in alert email (part 3):
 * /sign-in-alert?a=<alert id>&i=<issue day>&t=<tag>. The tag is an HMAC over
 * `v1:<alert id>:<user id>:<issue day>` under a key derived from the service
 * key with its own label, valid 7 days, compared in constant time, and
 * nothing verifies without a key.
 */

// A dull value under a neutral name (src/test/secret-shaped-fixtures.guard.test.ts).
const SIGNING_INPUT = 'test-only-signing-input';
const OTHER_INPUT = 'another-test-only-signing-input';

const ALERT = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const OTHER_ALERT = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';

const ISSUED = new Date('2026-11-20T15:30:00Z');
const DAY = '20261120';
const daysLater = (n: number) => new Date(ISSUED.getTime() + n * 24 * 60 * 60_000);

function sign(overrides: Partial<{ alertId: string; userId: string; issuedDay: string }> = {}) {
  const tag = signSignInAlertLink(SIGNING_INPUT, {
    alertId: ALERT,
    userId: USER,
    issuedDay: DAY,
    ...overrides,
  });
  if (!tag) throw new Error('the test could not sign');
  return tag;
}

describe('the issue day', () => {
  it('is the UTC day, as eight digits', () => {
    expect(issuedDayOf(ISSUED)).toBe(DAY);
    expect(issuedDayOf(new Date('2026-01-02T23:59:59Z'))).toBe('20260102');
    expect(issuedDayOf(new Date('2026-01-03T00:00:00Z'))).toBe('20260103');
  });
});

describe('signing', () => {
  it('the tag is HMAC-SHA256 over v1:<alert>:<user>:<day>, under a key derived from the service key with its own label', () => {
    const key = createHmac('sha256', SIGNING_INPUT)
      .update('stockpilot:sign-in-alert-link-key:v1')
      .digest();
    const expected = createHmac('sha256', key)
      .update(`v1:${ALERT}:${USER}:${DAY}`)
      .digest('base64url');
    expect(sign()).toBe(expected);
    expect(sign()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('a different key, alert, user or day gives a different tag', () => {
    const base = sign();
    expect(
      signSignInAlertLink(OTHER_INPUT, { alertId: ALERT, userId: USER, issuedDay: DAY }),
    ).not.toBe(base);
    expect(sign({ alertId: OTHER_ALERT })).not.toBe(base);
    expect(sign({ userId: OTHER_USER })).not.toBe(base);
    expect(sign({ issuedDay: '20261121' })).not.toBe(base);
  });

  it('signs nothing without a key, or for values outside their shape', () => {
    for (const key of ['', '   ', undefined, null]) {
      expect(
        signSignInAlertLink(key as unknown as string, {
          alertId: ALERT,
          userId: USER,
          issuedDay: DAY,
        }),
      ).toBeNull();
    }
    expect(signSignInAlertLink(SIGNING_INPUT, { alertId: 'nope', userId: USER, issuedDay: DAY })).toBeNull();
    expect(signSignInAlertLink(SIGNING_INPUT, { alertId: ALERT, userId: 'nope', issuedDay: DAY })).toBeNull();
    expect(signSignInAlertLink(SIGNING_INPUT, { alertId: ALERT, userId: USER, issuedDay: '2026-11-20' })).toBeNull();
    expect(signSignInAlertLink(SIGNING_INPUT, { alertId: ALERT, userId: USER, issuedDay: '20261340' })).toBeNull();
  });

  it('upper-case ids are signed as lower case, so the link reads one way', () => {
    expect(sign({ alertId: ALERT.toUpperCase(), userId: USER.toUpperCase() })).toBe(sign());
  });
});

describe('reading the link from a request', () => {
  it('reads the three values when each has its shape', () => {
    expect(readSignInAlertLink({ a: ALERT, i: DAY, t: sign() })).toEqual({
      alertId: ALERT,
      issuedDay: DAY,
      tag: sign(),
    });
  });

  it.each([
    ['no alert', { a: null, i: DAY, t: 'x'.repeat(43) }],
    ['an alert that is not an id', { a: 'abc', i: DAY, t: 'x'.repeat(43) }],
    ['a day that is not eight digits', { a: ALERT, i: '2026112', t: 'x'.repeat(43) }],
    ['a day that is not a date', { a: ALERT, i: '20261332', t: 'x'.repeat(43) }],
    ['a short tag', { a: ALERT, i: DAY, t: 'x'.repeat(42) }],
    ['a tag with other characters', { a: ALERT, i: DAY, t: `${'x'.repeat(42)}=` }],
    ['no tag', { a: ALERT, i: DAY, t: null }],
    ['a very long value', { a: ALERT.repeat(40), i: DAY, t: 'x'.repeat(43) }],
  ])('refuses %s', (_what, params) => {
    expect(readSignInAlertLink(params)).toBeNull();
  });
});

describe('the time window: 7 days from the issue day', () => {
  it('is 7 days', () => {
    expect(SIGN_IN_ALERT_LINK_DAYS).toBe(7);
  });

  it('open on the issue day and up to 7 days after it; closed after that', () => {
    expect(signInAlertLinkInWindow(DAY, ISSUED)).toBe(true);
    expect(signInAlertLinkInWindow(DAY, daysLater(7))).toBe(true);
    expect(signInAlertLinkInWindow(DAY, daysLater(8))).toBe(false);
    expect(signInAlertLinkInWindow(DAY, daysLater(400))).toBe(false);
  });

  it('a day one ahead of this clock (another server near midnight) is open; further ahead is closed', () => {
    expect(signInAlertLinkInWindow('20261121', ISSUED)).toBe(true);
    expect(signInAlertLinkInWindow('20261122', ISSUED)).toBe(false);
  });

  it('a day that is not a date, or a clock that is not a time, is closed', () => {
    expect(signInAlertLinkInWindow('20261340', ISSUED)).toBe(false);
    expect(signInAlertLinkInWindow(DAY, new Date('nope'))).toBe(false);
  });
});

describe('checking a link against the alert’s own account', () => {
  const check = (args: Partial<Parameters<typeof checkSignInAlertLink>[1]> = {}, key = SIGNING_INPUT) =>
    checkSignInAlertLink(key, {
      alertId: ALERT,
      userId: USER,
      issuedDay: DAY,
      tag: sign(),
      now: ISSUED,
      ...args,
    });

  it('valid: signed by us, for this alert and this account, within 7 days', () => {
    expect(check()).toBe('valid');
    expect(check({ now: daysLater(7) })).toBe('valid');
  });

  it('expired: signed by us, past its 7 days', () => {
    expect(check({ now: daysLater(8) })).toBe('expired');
  });

  it('forged: a changed tag, or one made with another key, is invalid', () => {
    const tag = sign();
    const changed = `${tag.slice(0, 10)}${tag[10] === 'A' ? 'B' : 'A'}${tag.slice(11)}`;
    expect(check({ tag: changed })).toBe('invalid');
    const other = signSignInAlertLink(OTHER_INPUT, { alertId: ALERT, userId: USER, issuedDay: DAY })!;
    expect(check({ tag: other })).toBe('invalid');
  });

  it('wrong user: a tag signed for another account does not open this alert', () => {
    expect(check({ tag: sign({ userId: OTHER_USER }) })).toBe('invalid');
    // and the account this alert belongs to is what the route checks it against
    expect(check({ userId: OTHER_USER })).toBe('invalid');
  });

  it('another alert or another day: invalid', () => {
    expect(check({ alertId: OTHER_ALERT })).toBe('invalid');
    expect(check({ issuedDay: '20261119' })).toBe('invalid');
  });

  it('only the one spelling our signer writes passes (the last character’s spare bits)', () => {
    const tag = sign();
    const last = tag[42]!;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const index = alphabet.indexOf(last);
    // The same top four bits, different spare bits: decodes to the same bytes.
    const sibling = alphabet[(index & ~3) | ((index + 1) & 3)]!;
    expect(sibling).not.toBe(last);
    expect(check({ tag: `${tag.slice(0, 42)}${sibling}` })).toBe('invalid');
  });

  it('fails closed with no key: nothing verifies', () => {
    expect(check({}, '')).toBe('invalid');
    expect(check({}, '   ')).toBe('invalid');
    expect(
      checkSignInAlertLink(undefined as unknown as string, {
        alertId: ALERT,
        userId: USER,
        issuedDay: DAY,
        tag: sign(),
        now: ISSUED,
      }),
    ).toBe('invalid');
  });

  it('never throws, whatever it is handed', () => {
    expect(checkSignInAlertLink(SIGNING_INPUT, null as never)).toBe('invalid');
    expect(check({ tag: 42 as unknown as string })).toBe('invalid');
    expect(check({ userId: null as unknown as string })).toBe('invalid');
  });
});
