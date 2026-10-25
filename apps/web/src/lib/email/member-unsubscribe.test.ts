import { createHmac } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The signed one-click link in the weekly digest and the schedule reminders.
 * The link is the only thing standing between the public /unsubscribe page
 * and "anyone can switch off anyone's emails", so this pins the signer and the
 * verifier:
 *   - a link names one member, one organization, one email kind and the UTC
 *     day its email was built, and every one of the four is covered by the
 *     signature;
 *   - a link works for 90 days after that day and is then "expired"; a day
 *     that is missing, malformed, not a real date or after today is refused
 *     like a forged link;
 *   - an unknown kind, a malformed link and a changed character are refused
 *     without throwing;
 *   - with no signing value configured nothing is minted and nothing verifies.
 */

// vi.hoisted: the factory runs during hoisted imports, before top-level consts.
// The signing value is typed once, a dull value under a neutral name (see
// src/test/secret-shaped-fixtures.guard.test.ts), and restored from a copy.
const envState = vi.hoisted(() => {
  const SIGNING_TEST_VALUE = 'member-link-' + 'v'.repeat(22);
  return { UNSUBSCRIBE_SECRET: SIGNING_TEST_VALUE };
});
vi.mock('@/lib/env', () => ({ env: envState }));
const INITIAL_ENV = { ...envState };

import {
  MEMBER_EMAIL_KINDS,
  MEMBER_UNSUBSCRIBE_MAX_AGE_DAYS,
  buildMemberUnsubscribeUrl,
  memberUnsubscribeDelivery,
  mintMemberUnsubscribeToken,
  verifyMemberUnsubscribeToken,
  type MemberEmailKind,
} from './member-unsubscribe';
import { mintUnsubscribeToken } from './unsubscribe';

const MEMBER = '00000000-0000-4000-8000-0000000000a1';
const OTHER_MEMBER = '00000000-0000-4000-8000-0000000000b2';
const ORG = '00000000-0000-4000-8000-00000000c0c0';
const OTHER_ORG = '00000000-0000-4000-8000-00000000d0d0';

const DIGEST = { userId: MEMBER, organizationId: ORG, kind: 'weekly_digest' as const };

/** When the email is built, and the UTC day the link carries. */
const BUILT = new Date('2026-10-25T12:00:00.000Z');
const BUILT_DAY = '20261025';
const DAY_MS = 24 * 60 * 60 * 1000;
/** `days` whole days after BUILT, same time of day. */
const daysAfter = (days: number) => new Date(BUILT.getTime() + days * DAY_MS);

const INVALID = { status: 'invalid' };

/** The link with one of its five parts replaced. */
function withPart(link: string, index: number, value: string): string {
  const parts = link.split('.');
  parts[index] = value;
  return parts.join('.');
}

/** A link for any day string, signed with the real signing value (v2 domain). */
function signedFor(kind: string, day: string): string {
  const mac = createHmac('sha256', envState.UNSUBSCRIBE_SECRET)
    .update(`unsubscribe:member:v2:${kind}:${MEMBER}:${ORG}:${day}`)
    .digest('hex');
  return `${kind}.${MEMBER}.${ORG}.${day}.${mac}`;
}

beforeEach(() => {
  Object.assign(envState, INITIAL_ENV);
});

describe('member unsubscribe link: mint and verify', () => {
  it.each(MEMBER_EMAIL_KINDS)(
    'verifies a %s link it minted, back to the same member, organization and kind',
    (kind) => {
      const link = mintMemberUnsubscribeToken({ userId: MEMBER, organizationId: ORG, kind }, BUILT);
      expect(link).toMatch(
        new RegExp(`^${kind}\\.${MEMBER}\\.${ORG}\\.${BUILT_DAY}\\.[0-9a-f]{64}$`),
      );
      expect(verifyMemberUnsubscribeToken(link!, BUILT)).toEqual({
        status: 'valid',
        claim: { userId: MEMBER, organizationId: ORG, kind },
      });
    },
  );

  it('covers exactly the two member emails the Notifications page has switches for', () => {
    expect([...MEMBER_EMAIL_KINDS]).toEqual(['weekly_digest', 'schedule_reminders']);
  });

  it('refuses a link whose signature was changed', () => {
    const link = mintMemberUnsubscribeToken(DIGEST, BUILT)!;
    const flipped = link.slice(0, -1) + (link.endsWith('0') ? '1' : '0');
    expect(verifyMemberUnsubscribeToken(flipped, BUILT)).toEqual(INVALID);
  });

  it("refuses one member's link edited to name another member, another organization or another email", () => {
    const link = mintMemberUnsubscribeToken(DIGEST, BUILT)!;
    expect(verifyMemberUnsubscribeToken(withPart(link, 1, OTHER_MEMBER), BUILT)).toEqual(INVALID);
    expect(verifyMemberUnsubscribeToken(withPart(link, 2, OTHER_ORG), BUILT)).toEqual(INVALID);
    expect(verifyMemberUnsubscribeToken(withPart(link, 0, 'schedule_reminders'), BUILT)).toEqual(
      INVALID,
    );
    // And the other member's own link is a different link.
    const theirs = mintMemberUnsubscribeToken({ ...DIGEST, userId: OTHER_MEMBER }, BUILT)!;
    expect(theirs).not.toBe(link);
    expect(verifyMemberUnsubscribeToken(theirs, BUILT)).toMatchObject({
      status: 'valid',
      claim: { userId: OTHER_MEMBER },
    });
  });

  it('refuses an unknown email kind, even one signed with the real signing value', () => {
    const unknown = 'rental_reminders' as MemberEmailKind;
    expect(mintMemberUnsubscribeToken({ ...DIGEST, kind: unknown }, BUILT)).toBeNull();
    // A correctly computed signature over an unknown kind still fails: the
    // kind list is checked on its own, not only through the signature.
    expect(verifyMemberUnsubscribeToken(signedFor('rental_reminders', BUILT_DAY), BUILT)).toEqual(
      INVALID,
    );
  });

  it('refuses malformed links without throwing', () => {
    const link = mintMemberUnsubscribeToken(DIGEST, BUILT)!;
    for (const bad of [
      '',
      'weekly_digest',
      `weekly_digest.${MEMBER}.${ORG}.${BUILT_DAY}`,
      `${link}.extra`,
      withPart(link, 1, 'not-a-uuid'),
      withPart(link, 2, `${ORG}0`),
      withPart(link, 4, 'ab'.repeat(16)),
      withPart(link, 4, 'zz'.repeat(32)),
      link + 'a'.repeat(300),
    ]) {
      expect(verifyMemberUnsubscribeToken(bad, BUILT)).toEqual(INVALID);
    }
    expect(verifyMemberUnsubscribeToken(undefined as unknown as string, BUILT)).toEqual(INVALID);
    expect(mintMemberUnsubscribeToken({ ...DIGEST, userId: 'user-1' }, BUILT)).toBeNull();
    expect(mintMemberUnsubscribeToken({ ...DIGEST, organizationId: '' }, BUILT)).toBeNull();
  });

  it("is a different signature from the order emails' address link, so neither opens the other", () => {
    const addressLink = mintUnsubscribeToken('member@example.test')!;
    const link = mintMemberUnsubscribeToken(DIGEST, BUILT)!;
    expect(verifyMemberUnsubscribeToken(withPart(link, 4, addressLink), BUILT)).toEqual(INVALID);
  });

  it('survives a mail client that upper-cases the link', () => {
    const link = mintMemberUnsubscribeToken(DIGEST, BUILT)!;
    expect(verifyMemberUnsubscribeToken(link.toUpperCase(), BUILT)).toEqual({
      status: 'valid',
      claim: DIGEST,
    });
    expect(mintMemberUnsubscribeToken({ ...DIGEST, userId: MEMBER.toUpperCase() }, BUILT)).toBe(
      link,
    );
  });

  it('fails closed when UNSUBSCRIBE_SECRET is unset: nothing is minted and an earlier link stops working', () => {
    const minted = mintMemberUnsubscribeToken(DIGEST, BUILT)!;
    envState.UNSUBSCRIBE_SECRET = '';
    expect(mintMemberUnsubscribeToken(DIGEST, BUILT)).toBeNull();
    expect(buildMemberUnsubscribeUrl('https://app.test', DIGEST, BUILT)).toBeNull();
    expect(verifyMemberUnsubscribeToken(minted, BUILT)).toEqual(INVALID);
  });
});

/**
 * Integrator decision 1 (B15): the UTC day the email was built is signed into
 * the link, and a link older than 90 days is refused, so a link that leaked
 * (a forwarded email, a mail gateway's link store, browser history, a request
 * log) stops working instead of switching the member's email off forever.
 */
describe('member unsubscribe link: the issue day and the 90-day limit', () => {
  it('allows 90 days, the US CAN-SPAM 30 with margin', () => {
    expect(MEMBER_UNSUBSCRIBE_MAX_AGE_DAYS).toBe(90);
  });

  it('signs the UTC calendar day the email was built, whatever the zone of the clock', () => {
    // 23:30 on Oct 25 in Los Angeles is already Oct 26 in UTC.
    const lateInLa = new Date('2026-10-25T23:30:00-07:00');
    expect(mintMemberUnsubscribeToken(DIGEST, lateInLa)!.split('.')[3]).toBe('20261026');
    // 08:30 on Oct 26 in Tokyo is still Oct 25 in UTC.
    const earlyInTokyo = new Date('2026-10-26T08:30:00+09:00');
    expect(mintMemberUnsubscribeToken(DIGEST, earlyInTokyo)!.split('.')[3]).toBe('20261025');
  });

  it.each(MEMBER_EMAIL_KINDS)('a %s link works on its issue day and 90 days later', (kind) => {
    const link = mintMemberUnsubscribeToken({ userId: MEMBER, organizationId: ORG, kind }, BUILT)!;
    const valid = { status: 'valid', claim: { userId: MEMBER, organizationId: ORG, kind } };
    expect(verifyMemberUnsubscribeToken(link, BUILT)).toEqual(valid);
    expect(verifyMemberUnsubscribeToken(link, daysAfter(30))).toEqual(valid);
    expect(verifyMemberUnsubscribeToken(link, daysAfter(90))).toEqual(valid);
  });

  it.each(MEMBER_EMAIL_KINDS)('a %s link is expired from day 91, naming only its kind', (kind) => {
    const link = mintMemberUnsubscribeToken({ userId: MEMBER, organizationId: ORG, kind }, BUILT)!;
    expect(verifyMemberUnsubscribeToken(link, daysAfter(91))).toEqual({ status: 'expired', kind });
    expect(verifyMemberUnsubscribeToken(link, daysAfter(400))).toEqual({ status: 'expired', kind });
  });

  it('counts whole UTC calendar days, not 24-hour periods', () => {
    // Built a minute before UTC midnight on Jan 1; Apr 1 is 90 days later.
    const link = mintMemberUnsubscribeToken(DIGEST, new Date('2026-01-01T23:59:00.000Z'))!;
    expect(verifyMemberUnsubscribeToken(link, new Date('2026-04-01T23:59:59.000Z'))).toMatchObject({
      status: 'valid',
    });
    expect(verifyMemberUnsubscribeToken(link, new Date('2026-04-02T00:00:00.000Z'))).toEqual({
      status: 'expired',
      kind: 'weekly_digest',
    });
  });

  it('refuses a day after today like a forged link, even with a correct signature', () => {
    const tomorrow = mintMemberUnsubscribeToken(DIGEST, daysAfter(1))!;
    expect(verifyMemberUnsubscribeToken(tomorrow, BUILT)).toEqual(INVALID);
    // Still refused at the last moment of the issue day before it.
    expect(
      verifyMemberUnsubscribeToken(
        mintMemberUnsubscribeToken(DIGEST, new Date('2026-10-26T00:00:00.000Z'))!,
        new Date('2026-10-25T23:59:59.999Z'),
      ),
    ).toEqual(INVALID);
  });

  it('refuses a link with no day: the earlier four-part format, even signed with the real value', () => {
    const v1Mac = createHmac('sha256', envState.UNSUBSCRIBE_SECRET)
      .update(`unsubscribe:member:v1:weekly_digest:${MEMBER}:${ORG}`)
      .digest('hex');
    expect(verifyMemberUnsubscribeToken(`weekly_digest.${MEMBER}.${ORG}.${v1Mac}`, BUILT)).toEqual(
      INVALID,
    );
  });

  it('refuses a malformed or impossible day, even with a correct signature over it', () => {
    for (const day of [
      '2026102', // seven digits
      '202610250', // nine digits
      '2026-10-2', // not digits
      'abcdefgh',
      '20260230', // Feb 30
      '20261301', // month 13
      '20261000', // day 0
      '00991231', // a two-digit year in disguise
      '09991231', // before year 1000
    ]) {
      expect(verifyMemberUnsubscribeToken(signedFor('weekly_digest', day), BUILT)).toEqual(INVALID);
    }
    // The same construction over the real day verifies, so the refusals
    // above are about the day alone.
    expect(
      verifyMemberUnsubscribeToken(signedFor('weekly_digest', BUILT_DAY), BUILT),
    ).toMatchObject({ status: 'valid' });
  });

  it('refuses an edited day: the signature covers it', () => {
    const link = mintMemberUnsubscribeToken(DIGEST, daysAfter(-100))!;
    expect(verifyMemberUnsubscribeToken(link, BUILT)).toMatchObject({ status: 'expired' });
    // Moving an expired link's day forward does not revive it.
    expect(verifyMemberUnsubscribeToken(withPart(link, 3, BUILT_DAY), BUILT)).toEqual(INVALID);
    expect(verifyMemberUnsubscribeToken(withPart(link, 3, '20261024'), BUILT)).toEqual(INVALID);
  });

  it('fails closed on an unusable clock: nothing is minted, nothing verifies', () => {
    const link = mintMemberUnsubscribeToken(DIGEST, BUILT)!;
    expect(mintMemberUnsubscribeToken(DIGEST, new Date(Number.NaN))).toBeNull();
    expect(mintMemberUnsubscribeToken(DIGEST, undefined as unknown as Date)).toBeNull();
    expect(mintMemberUnsubscribeToken(DIGEST, new Date('+010000-01-01T00:00:00.000Z'))).toBeNull();
    expect(verifyMemberUnsubscribeToken(link, new Date(Number.NaN))).toEqual(INVALID);
  });

  it('verifies against the current time when no clock is passed', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(daysAfter(90));
      const link = mintMemberUnsubscribeToken(DIGEST, BUILT)!;
      expect(verifyMemberUnsubscribeToken(link)).toMatchObject({ status: 'valid' });
      vi.setSystemTime(daysAfter(91));
      expect(verifyMemberUnsubscribeToken(link)).toEqual({
        status: 'expired',
        kind: 'weekly_digest',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('member unsubscribe link: what an email carries', () => {
  const SETTINGS = 'https://app.test/dashboard/settings/notifications';

  it('builds the public /unsubscribe URL on the app origin', () => {
    expect(buildMemberUnsubscribeUrl('https://app.test/', DIGEST, BUILT)).toBe(
      `https://app.test/unsubscribe?m=${mintMemberUnsubscribeToken(DIGEST, BUILT)}`,
    );
  });

  it('advertises RFC 8058 one-click with the signed link, dated the day the email is built', () => {
    const url = buildMemberUnsubscribeUrl('https://app.test', DIGEST, BUILT)!;
    expect(url).toContain(`.${BUILT_DAY}.`);
    expect(
      memberUnsubscribeDelivery({
        appUrl: 'https://app.test',
        settingsUrl: SETTINGS,
        claim: DIGEST,
        issuedAt: BUILT,
      }),
    ).toEqual({
      url,
      oneClick: true,
      headers: {
        'List-Unsubscribe': `<${url}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
  });

  it('falls back to the settings page, with no one-click header, when no link can be signed', () => {
    const fallback = {
      url: SETTINGS,
      oneClick: false,
      headers: { 'List-Unsubscribe': `<${SETTINGS}>` },
    };
    // An unusable clock.
    expect(
      memberUnsubscribeDelivery({
        appUrl: 'https://app.test',
        settingsUrl: SETTINGS,
        claim: DIGEST,
        issuedAt: new Date(Number.NaN),
      }),
    ).toEqual(fallback);
    // No signing value.
    envState.UNSUBSCRIBE_SECRET = '';
    expect(
      memberUnsubscribeDelivery({
        appUrl: 'https://app.test',
        settingsUrl: SETTINGS,
        claim: DIGEST,
        issuedAt: BUILT,
      }),
    ).toEqual(fallback);
  });
});
