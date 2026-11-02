/**
 * Does this session still owe its authenticator code?
 *
 * The one copy of the rule (docket S43a). The web's API context refuses such a
 * session before it reads anything (apps/web/src/lib/auth/api-context.ts), and
 * the phone's code gate and its push registration check read the same rule.
 *
 * Owed when the account has a VERIFIED factor of any type and the session is
 * not at aal2. A level that is missing or unreadable counts as not aal2 (fail
 * closed). An account with no verified factor never owes it here: whether an
 * organization's policy requires one is a different question, answered where
 * the policy is read.
 *
 * PURE: no platform imports, so the server and the Expo app share it. The
 * factors are GoTrue's (the user `getUser()` returns, or the copy a stored
 * session carries); only `status` is read.
 */
export function stepUpOwed(
  factors: ReadonlyArray<{ readonly status?: string | null } | null | undefined> | null | undefined,
  aal: string | null | undefined,
): boolean {
  const enrolled = (factors ?? []).some((factor) => factor?.status === 'verified');
  return enrolled && aal !== 'aal2';
}
