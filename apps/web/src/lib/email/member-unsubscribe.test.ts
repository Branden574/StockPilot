import { createHmac } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The signed one-click link in the weekly digest and the schedule reminders.
 * The link is the only thing standing between the public /unsubscribe page
 * and "anyone can switch off anyone's emails", so this pins the signer and the
 * verifier:
 *   - a link names one member, one organization and one email kind, and every
 *     one of the three is covered by the signature;
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

/** The link with one of its four parts replaced. */
function withPart(link: string, index: number, value: string): string {
  const parts = link.split('.');
  parts[index] = value;
  return parts.join('.');
}

beforeEach(() => {
  Object.assign(envState, INITIAL_ENV);
});

describe('member unsubscribe link: mint and verify', () => {
  it.each(MEMBER_EMAIL_KINDS)(
    'verifies a %s link it minted, back to the same member, organization and kind',
    (kind) => {
      const link = mintMemberUnsubscribeToken({ userId: MEMBER, organizationId: ORG, kind });
      expect(link).toMatch(new RegExp(`^${kind}\\.${MEMBER}\\.${ORG}\\.[0-9a-f]{64}$`));
      expect(verifyMemberUnsubscribeToken(link!)).toEqual({
        userId: MEMBER,
        organizationId: ORG,
        kind,
      });
    },
  );

  it('covers exactly the two member emails the Notifications page has switches for', () => {
    expect([...MEMBER_EMAIL_KINDS]).toEqual(['weekly_digest', 'schedule_reminders']);
  });

  it('refuses a link whose signature was changed', () => {
    const link = mintMemberUnsubscribeToken(DIGEST)!;
    const flipped = link.slice(0, -1) + (link.endsWith('0') ? '1' : '0');
    expect(verifyMemberUnsubscribeToken(flipped)).toBeNull();
  });

  it("refuses one member's link edited to name another member, another organization or another email", () => {
    const link = mintMemberUnsubscribeToken(DIGEST)!;
    expect(verifyMemberUnsubscribeToken(withPart(link, 1, OTHER_MEMBER))).toBeNull();
    expect(verifyMemberUnsubscribeToken(withPart(link, 2, OTHER_ORG))).toBeNull();
    expect(verifyMemberUnsubscribeToken(withPart(link, 0, 'schedule_reminders'))).toBeNull();
    // And the other member's own link is a different link.
    const theirs = mintMemberUnsubscribeToken({ ...DIGEST, userId: OTHER_MEMBER })!;
    expect(theirs).not.toBe(link);
    expect(verifyMemberUnsubscribeToken(theirs)?.userId).toBe(OTHER_MEMBER);
  });

  it('refuses an unknown email kind, even one signed with the real signing value', () => {
    const unknown = 'rental_reminders' as MemberEmailKind;
    expect(mintMemberUnsubscribeToken({ ...DIGEST, kind: unknown })).toBeNull();
    // A correctly computed signature over an unknown kind still fails: the
    // kind list is checked on its own, not only through the signature.
    const mac = createHmac('sha256', envState.UNSUBSCRIBE_SECRET)
      .update(`unsubscribe:member:v1:rental_reminders:${MEMBER}:${ORG}`)
      .digest('hex');
    expect(verifyMemberUnsubscribeToken(`rental_reminders.${MEMBER}.${ORG}.${mac}`)).toBeNull();
  });

  it('refuses malformed links without throwing', () => {
    const link = mintMemberUnsubscribeToken(DIGEST)!;
    for (const bad of [
      '',
      'weekly_digest',
      `weekly_digest.${MEMBER}.${ORG}`,
      `${link}.extra`,
      withPart(link, 1, 'not-a-uuid'),
      withPart(link, 2, `${ORG}0`),
      withPart(link, 3, 'ab'.repeat(16)),
      withPart(link, 3, 'zz'.repeat(32)),
      link + 'a'.repeat(300),
    ]) {
      expect(verifyMemberUnsubscribeToken(bad)).toBeNull();
    }
    expect(verifyMemberUnsubscribeToken(undefined as unknown as string)).toBeNull();
    expect(mintMemberUnsubscribeToken({ ...DIGEST, userId: 'user-1' })).toBeNull();
    expect(mintMemberUnsubscribeToken({ ...DIGEST, organizationId: '' })).toBeNull();
  });

  it("is a different signature from the order emails' address link, so neither opens the other", () => {
    const addressLink = mintUnsubscribeToken('member@example.test')!;
    const link = mintMemberUnsubscribeToken(DIGEST)!;
    expect(verifyMemberUnsubscribeToken(withPart(link, 3, addressLink))).toBeNull();
  });

  it('survives a mail client that upper-cases the link', () => {
    const link = mintMemberUnsubscribeToken(DIGEST)!;
    expect(verifyMemberUnsubscribeToken(link.toUpperCase())).toEqual(DIGEST);
    expect(mintMemberUnsubscribeToken({ ...DIGEST, userId: MEMBER.toUpperCase() })).toBe(link);
  });

  it('fails closed when UNSUBSCRIBE_SECRET is unset: nothing is minted and an earlier link stops working', () => {
    const minted = mintMemberUnsubscribeToken(DIGEST)!;
    envState.UNSUBSCRIBE_SECRET = '';
    expect(mintMemberUnsubscribeToken(DIGEST)).toBeNull();
    expect(buildMemberUnsubscribeUrl('https://app.test', DIGEST)).toBeNull();
    expect(verifyMemberUnsubscribeToken(minted)).toBeNull();
  });
});

describe('member unsubscribe link: what an email carries', () => {
  const SETTINGS = 'https://app.test/dashboard/settings/notifications';

  it('builds the public /unsubscribe URL on the app origin', () => {
    expect(buildMemberUnsubscribeUrl('https://app.test/', DIGEST)).toBe(
      `https://app.test/unsubscribe?m=${mintMemberUnsubscribeToken(DIGEST)}`,
    );
  });

  it('advertises RFC 8058 one-click with the signed link', () => {
    const url = buildMemberUnsubscribeUrl('https://app.test', DIGEST)!;
    expect(
      memberUnsubscribeDelivery({
        appUrl: 'https://app.test',
        settingsUrl: SETTINGS,
        claim: DIGEST,
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
    envState.UNSUBSCRIBE_SECRET = '';
    expect(
      memberUnsubscribeDelivery({
        appUrl: 'https://app.test',
        settingsUrl: SETTINGS,
        claim: DIGEST,
      }),
    ).toEqual({
      url: SETTINGS,
      oneClick: false,
      headers: { 'List-Unsubscribe': `<${SETTINGS}>` },
    });
  });
});
