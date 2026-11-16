import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as core from '@stockpilot/core';

import * as webCopy from '@/components/settings/delete-account-copy';
import * as codeModule from '@/lib/auth/account-delete-code';
import * as setUp from '@/lib/auth/authenticator-set-up';
import * as mfaPolicy from '@/lib/auth/mfa-policy';
import * as deletion from '@/server/lib/account-deletion';
import * as credential from '@/server/lib/account-deletion-credential';

/**
 * The words and the policy rule the website and the API use are core's own
 * values (one copy, shared with the phone), and core's reading of the delete
 * routes' answers has a row for every answer those routes give.
 */

const WEB_SRC = resolve(__dirname, '../../../../..');
const source = (rel: string) => readFileSync(resolve(WEB_SRC, rel), 'utf8');

/** Every `error: '<code>'` in a route with the first `status: <n>` after it. */
function answeredPairs(text: string): Array<{ status: number; error: string }> {
  const pairs: Array<{ status: number; error: string }> = [];
  for (const m of text.matchAll(/error:\s*'([a-z0-9_]+)'/g)) {
    const after = text.slice(m.index! + m[0].length);
    const status = after.match(/status:\s*(\d{3})/);
    expect(status, `a status after error '${m[1]}'`).not.toBeNull();
    pairs.push({ status: Number(status![1]), error: m[1]! });
  }
  return pairs;
}

const key = (p: { status: number; error: string }) => `${p.status} ${p.error}`;

describe("the web's names are core's values", () => {
  const shared: Array<[string, Record<string, unknown>, string[]]> = [
    [
      'components/settings/delete-account-copy',
      webCopy,
      [
        'DELETE_ACCOUNT_CARD_COPY',
        'DELETE_ACCOUNT_CODE_SEND_PAUSED_COPY',
        'DELETE_ACCOUNT_CONFIRM_COPY',
        'DELETE_ACCOUNT_DIALOG_COPY',
        'DELETE_ACCOUNT_NEWEST_CODE_ONLY_COPY',
      ],
    ],
    [
      'server/lib/account-deletion-credential',
      credential,
      [
        'ACCOUNT_DELETE_AAL2_COPY',
        'ACCOUNT_DELETE_CODE_NOT_OFFERED_COPY',
        'ACCOUNT_DELETE_CODE_REFUSED_COPY',
        'ACCOUNT_DELETE_CODE_SEND_FAILED_COPY',
        'ACCOUNT_DELETE_CODE_SEND_PAUSED_COPY',
        'ACCOUNT_DELETE_CODE_SENT_COPY',
        'ACCOUNT_DELETE_CREDENTIAL_CHECK_FAILED_COPY',
        'ACCOUNT_DELETE_CREDENTIAL_PAUSED_COPY',
        'ACCOUNT_DELETE_CREDENTIAL_REQUIRED_COPY',
        'ACCOUNT_DELETE_PASSWORD_REFUSED_COPY',
      ],
    ],
    [
      'server/lib/account-deletion',
      deletion,
      [
        'ACCOUNT_DELETE_BLOCKED_COPY',
        'ACCOUNT_DELETE_LAST_OWNER_COPY',
        'ACCOUNT_DELETE_LAST_OWNER_COPY_MOBILE',
        'ACCOUNT_DELETE_OWNER_CHECK_FAILED_COPY',
        'ACCOUNT_DELETE_PLATFORM_ADMIN_COPY',
        'ACCOUNT_DELETE_RETRY_COPY',
        'ACCOUNT_DELETE_SIGNED_OUT_COPY',
      ],
    ],
    ['lib/auth/account-delete-code', codeModule, ['ACCOUNT_DELETE_CODE_RE']],
    ['lib/auth/mfa-policy', mfaPolicy, ['enforcedMfaPolicy', 'UNREADABLE_ORG_MFA_POLICY']],
    [
      'lib/auth/authenticator-set-up',
      setUp,
      ['AUTHENTICATOR_SET_UP_PAGE', 'AUTHENTICATOR_SET_UP_URL'],
    ],
  ];

  it.each(shared)('%s', (_where, mod, names) => {
    for (const name of names) {
      expect(mod[name], name).toBeDefined();
      expect(mod[name], name).toBe((core as Record<string, unknown>)[name]);
    }
  });

  it("the delete route answers a body without the typed word with core's sentence", () => {
    expect(source('app/api/v1/account/delete/route.ts')).toContain(
      "{ error: 'validation_error', message: ACCOUNT_DELETE_TYPE_DELETE_COPY }",
    );
    expect(core.ACCOUNT_DELETE_TYPE_DELETE_COPY).toBe('Type DELETE to confirm.');
  });

  it("the dashboard's set-up panel takes its title from core", () => {
    expect(source('components/dashboard/authenticator-set-up-panel.tsx')).toContain(
      'title={AUTHENTICATOR_SET_UP_TITLE}',
    );
  });
});

describe("core's reading of the delete routes' answers covers every answer they give", () => {
  it('POST /api/v1/account/delete: each answer is a row, and each row is an answer', () => {
    const text = source('app/api/v1/account/delete/route.ts');
    const pairs = answeredPairs(text).filter((p) => p.status !== 401);
    // The route's catch answers 500 internal_error (internalErrorResponse).
    expect(text).toContain("internalErrorResponse(e, 'api.v1.account.delete'");
    const answered = new Set([...pairs.map(key), '500 internal_error']);
    expect([...answered].sort()).toEqual(core.ACCOUNT_DELETE_ROUTE_ANSWERS.map(key).sort());
    // 401 is read by its status alone.
    expect(
      answeredPairs(text)
        .filter((p) => p.status === 401)
        .map((p) => p.error),
    ).toEqual(['unauthenticated']);
    expect(core.accountDeleteAnswer({ status: 401, error: 'unauthenticated' }).next).toBe(
      'sign_in',
    );
  });

  it('POST /api/v1/account/delete/code: each answer is a row, and each row is an answer', () => {
    const text = source('app/api/v1/account/delete/code/route.ts');
    const pairs = answeredPairs(text).filter((p) => p.status !== 401);
    expect(text).toContain("internalErrorResponse(e, 'api.v1.account.delete.code'");
    const answered = new Set([...pairs.map(key), '500 internal_error']);
    expect([...answered].sort()).toEqual(core.ACCOUNT_DELETE_CODE_ROUTE_ANSWERS.map(key).sort());
    expect(
      core.accountDeleteAnswer({ route: 'code', status: 401, error: 'unauthenticated' }).next,
    ).toBe('sign_in');
  });

  it('the plants: a code the table does not hold, or a row no route gives, is seen', () => {
    const planted = `NextResponse.json({ error: 'brand_new_code', message: X }, { status: 403 });`;
    expect(answeredPairs(planted)).toEqual([{ status: 403, error: 'brand_new_code' }]);
    expect(core.ACCOUNT_DELETE_ROUTE_ANSWERS.map(key)).not.toContain('403 brand_new_code');
    const ternary = `NextResponse.json(x ? { error: 'a_one', message: A } : { error: 'b_two', message: B }, { status: 403 });`;
    expect(answeredPairs(ternary).map(key)).toEqual(['403 a_one', '403 b_two']);
  });
});
