import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

import { ORG_TIMEZONE_INVALID_MESSAGE } from '@stockpilot/core';

/**
 * THE PLATFORM CONSOLE CHECKS A NEW ORGANIZATION'S ZONE TOO (B41).
 *
 * createOrgForCustomerAction's schema took any 1 to 64 characters (its form
 * offers 8 listed zones, but the action is what decides). A zone it cannot use
 * is refused before the invite is minted or anything is written; a valid zone
 * outside Settings' list is stored as given.
 *
 * The invite link is signed for the new owner's account (docket S25), and an
 * invite that cannot be signed is not sent, so the suite holds a signing value
 * (a dull one under a neutral name, set before @/lib/env reads the
 * environment) and GoTrue's shapes: a UUID for the new owner and a
 * 56-character hash.
 */
vi.hoisted(() => {
  const SIGNING_INPUT = 'test-only-signing-input';
  process.env.SUPABASE_SERVICE_ROLE_KEY = SIGNING_INPUT;
});

/** The new owner's auth user, as GoTrue's generateLink returns it. */
const NEW_OWNER_ID = '77777777-7777-4777-8777-777777777777';
/** GoTrue's hashed token is a sha224 in hex: 56 characters. */
const LINK_HASH = 'cd'.repeat(28);

const generateLink = vi.fn();
const sendEmail = vi.fn();

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock('@/server/services/platform/audit', () => ({
  recordPlatformAudit: vi.fn(async () => {}),
}));
vi.mock('@/lib/auth/platform-admin', () => ({
  checkPlatformAdmin: vi.fn(async () => ({
    ok: true,
    session: { userId: 'pa-1', email: 'operator@example.test' },
  })),
}));
vi.mock('@/lib/email/resend', () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));

const adminStub = makeSupabaseStub({
  // ensureUniqueSlug's probe: the slug is free.
  'organizations.select': { data: null, error: null },
  'organizations.insert': { data: { id: 'org-1', slug: 'example-co' }, error: null },
});
(adminStub.client.auth as { admin?: unknown }).admin = { generateLink };

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => adminStub.client,
}));

import { createOrgForCustomerAction } from './platform-admin';

beforeEach(() => {
  vi.clearAllMocks();
  adminStub.fromCalls.length = 0;
  adminStub.chainArgsAll.clear();
  sendEmail.mockResolvedValue({ ok: true, id: 'test' });
  generateLink.mockResolvedValue({
    data: {
      user: { id: NEW_OWNER_ID },
      properties: { hashed_token: LINK_HASH, action_link: 'https://auth.example.test/verify' },
    },
    error: null,
  });
});

describe('createOrgForCustomerAction: the zone', () => {
  it('refuses an unusable zone before the invite or any write', async () => {
    for (const timezone of ['Mars/Olympus', 'EST5EDT', 'UTC+5']) {
      const res = await createOrgForCustomerAction({
        email: 'owner@example.test',
        name: 'Example Co',
        timezone,
      });
      expect(res.ok, timezone).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('validation_error');
        expect(res.error.message).toBe(ORG_TIMEZONE_INVALID_MESSAGE);
      }
    }
    expect(generateLink).not.toHaveBeenCalled();
    expect(adminStub.fromCalls).toEqual([]);
  });

  it('stores a valid zone outside the settings list as given', async () => {
    const res = await createOrgForCustomerAction({
      email: 'owner@example.test',
      name: 'Example Co',
      timezone: 'America/Indiana/Indianapolis',
    });
    expect(res.ok).toBe(true);
    const row = adminStub.chainArgsAll.get('organizations.insert')?.[0]?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({ timezone: 'America/Indiana/Indianapolis' });
  });

  it('keeps Pacific as the default when no zone is sent', async () => {
    const res = await createOrgForCustomerAction({
      email: 'owner@example.test',
      name: 'Example Co',
    } as Parameters<typeof createOrgForCustomerAction>[0]);
    expect(res.ok).toBe(true);
    const row = adminStub.chainArgsAll.get('organizations.insert')?.[0]?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({ timezone: 'America/Los_Angeles' });
  });
});
