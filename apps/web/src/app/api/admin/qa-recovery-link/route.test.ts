// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NextRequest } from 'next/server';

/**
 * The QA recovery link (docket S25 review): the demo QA account's emailed-link
 * walk mints its link here, behind the admin bearer, and the link names the
 * account GoTrue made it for (`r`), as every emailed link does.
 *
 * Pinned here:
 *   - a link it cannot sign (GoTrue answered no usable account id) is never
 *     answered: 500 with a fixed sentence through S16's helper, reported
 *     under the route's own tag, so the post-deploy check sees why and the
 *     report is not lost;
 *   - a link it can sign names the id GoTrue returned, by the app's own
 *     checker;
 *   - GoTrue's own failure answers through the same helper;
 *   - no bearer, or an address outside the allowlist, mints nothing.
 * The signing and bearer values are dull ones under neutral names
 * (src/test/secret-shaped-fixtures.guard.test.ts); every id is synthetic.
 */

const envState = vi.hoisted(() => {
  const SIGNING_INPUT = 'test-only-signing-input';
  const ADMIN_VALUE = 'test-only-admin-value';
  return {
    NEXT_PUBLIC_APP_URL: 'https://app.example.com',
    SUPABASE_SERVICE_ROLE_KEY: SIGNING_INPUT,
    BACKFILL_ADMIN_SECRET: ADMIN_VALUE,
  };
});
vi.mock('@/lib/env', () => ({ env: envState }));

const generateLink = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ auth: { admin: { generateLink } } }),
}));
const reportError = vi.fn(async (..._args: unknown[]) => {});
vi.mock('@/lib/error-reporter', () => ({
  reportError: (...args: unknown[]) => reportError(...args),
}));

import { verifyConfirmRecipient } from '@/lib/auth/confirm-link';

import { POST } from './route';

/** The route's allowlist: the product's demo QA account (no person's address). */
const QA_ACCOUNT = 'demo@stockpilotusa.com';
const USER_A = '11111111-1111-4111-8111-111111111111';
/** GoTrue's hashed tokens are sha224 in hex: 56 characters. */
const HASH_A = 'ab'.repeat(28);

function qaRequest(body: unknown, bearer: string | null = envState.BACKFILL_ADMIN_SECRET) {
  return new NextRequest('https://app.example.com/api/admin/qa-recovery-link', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
    },
    body: JSON.stringify(body),
  });
}

function gotrueAnswers(user: { id: string } | null) {
  generateLink.mockResolvedValue({
    data: { properties: { hashed_token: HASH_A }, user },
    error: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/admin/qa-recovery-link', () => {
  it('a link it cannot sign (no usable account id from GoTrue): 500 with a fixed sentence and no link, reported under the route tag', async () => {
    gotrueAnswers({ id: 'not-a-uuid' });
    const res = await POST(qaRequest({ email: QA_ACCOUNT }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('confirmUrl');
    expect(body).toEqual({ error: 'internal_error', message: 'The link could not be signed.' });
    expect(reportError).toHaveBeenCalledTimes(1);
    const [reported, context] = reportError.mock.calls[0]!;
    expect(context).toMatchObject({ tag: 'admin.qa-recovery-link' });
    // The report says what failed, never the token, the id or the address.
    const text = String((reported as Error).message);
    expect(text).not.toContain(HASH_A);
    expect(text).not.toContain('not-a-uuid');
    expect(text).not.toContain(QA_ACCOUNT);
  });

  it('a link it can sign: 200, and its r names the account GoTrue returned', async () => {
    gotrueAnswers({ id: USER_A });
    const res = await POST(qaRequest({ email: QA_ACCOUNT }));
    expect(res.status).toBe(200);
    const { confirmUrl } = (await res.json()) as { confirmUrl: string };
    const url = new URL(confirmUrl);
    expect(`${url.origin}${url.pathname}`).toBe('https://app.example.com/auth/confirm');
    expect(url.searchParams.get('type')).toBe('recovery');
    expect(url.searchParams.get('next')).toBe('/reset/complete');
    expect(url.searchParams.get('token_hash')).toBe(HASH_A);
    const verdict = verifyConfirmRecipient({
      type: 'recovery',
      tokenHash: HASH_A,
      r: url.searchParams.get('r') ?? '',
    });
    expect(verdict).toMatchObject({ status: 'valid', userId: USER_A });
    expect(generateLink).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'recovery', email: QA_ACCOUNT }),
    );
    expect(reportError).not.toHaveBeenCalled();
  });

  it("GoTrue's own failure answers through the same helper, reported under the route tag", async () => {
    generateLink.mockResolvedValue({
      data: { properties: null, user: null },
      error: new Error('generate_link failed upstream'),
    });
    const res = await POST(qaRequest({ email: QA_ACCOUNT }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('confirmUrl');
    expect(body.error).toBe('internal_error');
    expect(String(body.message)).not.toContain('upstream');
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'admin.qa-recovery-link' }),
    );
  });

  it('no bearer, a wrong one, or an address outside the allowlist mints nothing', async () => {
    gotrueAnswers({ id: USER_A });
    expect((await POST(qaRequest({ email: QA_ACCOUNT }, null))).status).toBe(401);
    expect((await POST(qaRequest({ email: QA_ACCOUNT }, 'test-only-other-value'))).status).toBe(
      401,
    );
    expect((await POST(qaRequest({ email: 'person@example.com' }))).status).toBe(403);
    expect(generateLink).not.toHaveBeenCalled();
  });
});
