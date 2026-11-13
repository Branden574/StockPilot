// @vitest-environment node
import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NextRequest } from 'next/server';

/**
 * Security invariant (docket S25 review, INV-E5): the confirmation page shows
 * an email-change link's addresses only while GoTrue still holds the change
 * the link was sent for.
 *
 * The page looks the account up when it is opened, so it prints GoTrue's
 * addresses of that moment. GoTrue keeps one pending change per account, and
 * every new request (or resend) mints new links and kills the earlier ones.
 * Without this check, a link sent to a mistyped address showed its holder the
 * address the person corrected the change to, or, once that change was done,
 * the account's new sign-in address.
 *
 * This runs the REAL link builder (mintEmailChangeLinks, which signs `r`) and
 * the REAL route; only GoTrue is faked, as an account with one pending change
 * that every mint replaces and stamps with its time, which is how GoTrue
 * answers (server/services/email-change.ts). Synthetic addresses on reserved
 * domains; the signing value is a dull one under a neutral name
 * (src/test/secret-shaped-fixtures.guard.test.ts).
 */

const envState = vi.hoisted(() => {
  const SIGNING_INPUT = 'test-only-signing-input';
  return {
    NEXT_PUBLIC_APP_URL: 'https://app.example.com',
    SUPABASE_SERVICE_ROLE_KEY: SIGNING_INPUT,
  };
});
vi.mock('@/lib/env', () => ({ env: envState }));

const getUser = vi.fn(async () => ({ data: { user: null }, error: null }));
const verifyOtp = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { verifyOtp, getUser, signOut: vi.fn() } }),
}));
const generateLink = vi.fn();
const getUserById = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ auth: { admin: { generateLink, getUserById } } }),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

import { mintEmailChangeLinks } from '@/server/services/email-change';

import { GET } from './route';

const USER = '11111111-1111-4111-8111-111111111111';
const CURRENT = 'person@example.com';
/** The new address as first typed: someone else's inbox. */
const TYPO = 'persn@example.org';
/** The address the person meant. */
const CORRECTED = 'person.new@example.net';
const T0 = new Date('2026-11-01T12:00:00Z');

/** GoTrue's account: one pending change, replaced and timed by every mint. */
const gotrue = {
  email: CURRENT,
  newEmail: '',
  sentAt: null as string | null,
  otp: 0,
};

function sha224(s: string): string {
  return createHash('sha224').update(s).digest('hex');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  Object.assign(gotrue, { email: CURRENT, newEmail: '', sentAt: null, otp: 0 });
  generateLink.mockImplementation(async (args: { newEmail: string }) => {
    gotrue.otp += 1;
    const otp = String(100000 + gotrue.otp);
    gotrue.newEmail = args.newEmail;
    gotrue.sentAt = new Date().toISOString();
    return {
      data: {
        properties: { hashed_token: sha224(`${gotrue.email}${otp}`), email_otp: otp },
        user: { id: USER, email: gotrue.email, new_email: gotrue.newEmail },
      },
      error: null,
    };
  });
  getUserById.mockImplementation(async () => ({
    data: {
      user: {
        id: USER,
        email: gotrue.email,
        ...(gotrue.newEmail ? { new_email: gotrue.newEmail } : {}),
        ...(gotrue.sentAt ? { email_change_sent_at: gotrue.sentAt } : {}),
      },
    },
    error: null,
  }));
});

afterEach(() => {
  vi.useRealTimers();
});

async function open(url: string): Promise<{ status: number; html: string }> {
  const res = await GET(new NextRequest(url));
  return { status: res.status, html: await res.text() };
}

function expectExpired(page: { status: number; html: string }) {
  expect(page.status).toBe(200);
  expect(page.html).toContain('This link has expired or was already used');
  expect(page.html).not.toContain('<form');
  for (const address of [CURRENT, TYPO, CORRECTED]) expect(page.html).not.toContain(address);
}

describe('an email-change link GoTrue no longer holds shows no address', () => {
  it('a link sent to a mistyped address, opened after the person corrected the change: expired, with neither address', async () => {
    const toTypo = await mintEmailChangeLinks(CURRENT, TYPO, USER);
    // The person sees the mistake and asks again, to the address they meant.
    vi.setSystemTime(new Date(T0.getTime() + 45_000));
    const corrected = await mintEmailChangeLinks(CURRENT, CORRECTED, USER);
    // The stranger at the mistyped address opens their link within the hour.
    vi.setSystemTime(new Date(T0.getTime() + 10 * 60_000));
    expectExpired(await open(toTypo.newUrl));
    expectExpired(await open(toTypo.currentUrl));
    // The corrected change's own links name both of its addresses.
    for (const url of [corrected.currentUrl, corrected.newUrl]) {
      const page = await open(url);
      expect(page.status).toBe(200);
      expect(page.html).toMatch(
        /This link changes the sign-in email of <span class="addr"[^>]*>person@example\.com<\/span> to <span class="addr"[^>]*>person\.new@example\.net<\/span>\./,
      );
      expect(page.html).toContain('form method="post"');
      expect(page.html).not.toContain(TYPO);
    }
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('the same link once the corrected change is done: expired, without the new sign-in address', async () => {
    const toTypo = await mintEmailChangeLinks(CURRENT, TYPO, USER);
    vi.setSystemTime(new Date(T0.getTime() + 45_000));
    await mintEmailChangeLinks(CURRENT, CORRECTED, USER);
    // Both of the corrected links were used: GoTrue applied the change.
    Object.assign(gotrue, { email: CORRECTED, newEmail: '' });
    vi.setSystemTime(new Date(T0.getTime() + 20 * 60_000));
    expectExpired(await open(toTypo.newUrl));
  });

  it('a link whose change was done, with no newer request: expired', async () => {
    const links = await mintEmailChangeLinks(CURRENT, CORRECTED, USER);
    Object.assign(gotrue, { email: CORRECTED, newEmail: '' });
    vi.setSystemTime(new Date(T0.getTime() + 5 * 60_000));
    expectExpired(await open(links.currentUrl));
  });

  it('a resend replaces the links too: the earlier ones are expired, the resent ones name both addresses', async () => {
    const first = await mintEmailChangeLinks(CURRENT, CORRECTED, USER);
    vi.setSystemTime(new Date(T0.getTime() + 2 * 60_000));
    const resent = await mintEmailChangeLinks(CURRENT, CORRECTED, USER);
    vi.setSystemTime(new Date(T0.getTime() + 3 * 60_000));
    expectExpired(await open(first.newUrl));
    const page = await open(resent.newUrl);
    expect(page.html).toContain(CORRECTED);
    expect(page.html).toContain('form method="post"');
  });
});
