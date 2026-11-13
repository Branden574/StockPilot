import type { AppearanceActionResult } from '@/server/actions/appearance';

/**
 * The browser's read of the signed-in person's own Design and Theme, as their
 * account holds them: ONE plain request to POST /api/appearance/account.
 *
 * NEVER A SERVER ACTION (measured in the lab 2026-11-11). The provider reads
 * the row a few milliseconds after the hydration commit of every signed-in
 * load. While a server action is pending, React holds the hydration of the
 * page's streamed content (1557 ms with the read held 1500 ms, against 67 ms),
 * the router holds a client redirect, and a link click can queue behind it. A
 * plain request holds none of them. The route answers what the read action
 * answers, from the same server function; the save stays an action, because it
 * only runs when a person chooses.
 * src/test/appearance-account-read.guard.test.ts holds this.
 *
 * The id goes in the body, never in the URL. The header is the one the Design
 * cookie route asks for: a plain form, link or image cannot send it.
 *
 * NEVER REJECTS, AND SAYS NOTHING. Anything that is not the route's answer
 * (another status, a body that is not the answer, a request that did not
 * finish, one torn down because the page is being left) is `error`, which the
 * reducer takes as "claim nothing, leave the status as it was": no notice to
 * the person, nothing logged, nothing reported.
 */

/** The route that reads the account row. */
export const ACCOUNT_APPEARANCE_ROUTE = '/api/appearance/account';

/** What the route answers: the read action's own answer. */
export type AccountAppearanceAnswer = AppearanceActionResult;

const FAILED: AccountAppearanceAnswer = { ok: false, reason: 'error' };

const REASONS: ReadonlySet<string> = new Set([
  'missing-table',
  'unauthenticated',
  'invalid',
  'error',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The route's answer out of a parsed body, or `error` when it is not one. */
function toAnswer(body: unknown): AccountAppearanceAnswer {
  if (!isRecord(body)) return FAILED;
  if (body.ok === true) {
    const { userId, row } = body;
    if (typeof userId !== 'string' || !(row === null || isRecord(row))) return FAILED;
    // The row's fields are checked where it is used (core's reducer parses it).
    return { ok: true, userId, row: row as Extract<AccountAppearanceAnswer, { ok: true }>['row'] };
  }
  if (body.ok === false && typeof body.reason === 'string' && REASONS.has(body.reason)) {
    return { ok: false, reason: body.reason } as AccountAppearanceAnswer;
  }
  return FAILED;
}

/** Read `userId`'s own row from their account. Never rejects. */
export async function readAccountAppearance(userId: string): Promise<AccountAppearanceAnswer> {
  try {
    const response = await fetch(ACCOUNT_APPEARANCE_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sp-appearance': '1' },
      body: JSON.stringify({ userId }),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (response.status !== 200) return FAILED;
    return toAnswer((await response.json()) as unknown);
  } catch {
    return FAILED;
  }
}
