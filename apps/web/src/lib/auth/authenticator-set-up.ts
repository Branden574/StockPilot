/**
 * Where a member who must set up an authenticator first is sent, and the
 * pages they may open before they have one.
 *
 * The rule itself (who owes set-up) is `authenticatorSetUpOwed` in
 * @stockpilot/core. requireOrgContext() (lib/auth/session.ts) applies it for
 * every dashboard page and every Server Action that builds on the member's
 * context. No layout redirects for it: the dashboard layout only shows the
 * banner, and a set-up prompt where the page would be for a session the
 * pages' check cannot see (see the layout; the page below still runs).
 */

import { AUTHENTICATOR_SET_UP_PAGE } from '@stockpilot/core';

/**
 * The security settings page, where an authenticator is set up, and the
 * redirect target (`?enroll=1`, the parameter the security page reads to show
 * its "Enroll to continue" callout, and the one the banner's button uses).
 * Both live in @stockpilot/core (auth/set-up-copy.ts), so the phone opens the
 * same address on the website.
 */
export { AUTHENTICATOR_SET_UP_PAGE, AUTHENTICATOR_SET_UP_URL } from '@stockpilot/core';

/**
 * The pages a member who owes set-up may still open, each a personal page:
 *   - the security settings page: set up and verify an authenticator, and
 *     everything on its shell (sign out, switch organization);
 *   - the profile page: it opens and its appearance setting works; its own
 *     actions (name, avatar, sign-in email) reach their own authenticator
 *     check, which answers that one is required. Deleting the account is
 *     confirmed by its own rule instead (the account's password or a code
 *     emailed to it, server/lib/account-deletion-credential), so a member can
 *     delete their account before setting one up.
 */
export const OPEN_BEFORE_AUTHENTICATOR_SET_UP: readonly string[] = [
  AUTHENTICATOR_SET_UP_PAGE,
  '/dashboard/settings/profile',
];

/**
 * Is `pathname` (the proxy-set `x-pathname`, the page a request or a Server
 * Action was made from) one of those pages? Exactly the path, or a path below
 * it after a slash: `/dashboard/settings/security-keys` is not the security
 * page. A missing path is none of them, so the member is sent to set-up.
 */
export function openBeforeAuthenticatorSetUp(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return OPEN_BEFORE_AUTHENTICATOR_SET_UP.some(
    (page) => pathname === page || pathname.startsWith(`${page}/`),
  );
}
