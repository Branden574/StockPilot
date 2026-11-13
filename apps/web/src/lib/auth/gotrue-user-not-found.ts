/**
 * Whether a GoTrue admin call failed because the user does not exist: a 404
 * that carries code `user_not_found`, and nothing else.
 *
 * GoTrue v2 loads the user for every /admin/users/<id> route before the route
 * runs (its loadUser middleware), so GET and DELETE /admin/users/<id> and the
 * factor list, GET /admin/users/<id>/factors, all answer that 404 once the
 * account is gone. auth-js hands it back as an AuthApiError with `status` 404
 * and `code` 'user_not_found'. A 404 without that code (a proxy, a route this
 * build does not know) is no proof: the account may still be there.
 *
 * Account deletion reads it as "another request deleted the account a moment
 * ago" (review R7): server/lib/account-deletion.ts and the last check before
 * the delete (server/services/step-up-held.ts). The confirmation page reads
 * it as "the account this link is for is gone" and answers as for an expired
 * link (lib/auth/confirm-link.ts).
 */
export function isUserNotFound(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const o = e as { status?: unknown; code?: unknown };
  return o.status === 404 && o.code === 'user_not_found';
}
