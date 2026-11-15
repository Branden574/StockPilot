/**
 * Where a member who must set up an authenticator first is sent, and the
 * pages they may open before they have one.
 *
 * The rule itself (who owes set-up) is `authenticatorSetUpOwed` in
 * @stockpilot/core. requireOrgContext() (lib/auth/session.ts) applies it for
 * every dashboard page and every Server Action that builds on the member's
 * context, and the dashboard layout applies it to a full page load.
 */

/** The security settings page, where an authenticator is set up. */
export const AUTHENTICATOR_SET_UP_PAGE = '/dashboard/settings/security';

/**
 * The redirect target. `?enroll=1` is the parameter the security page reads to
 * show its "Enroll to continue" callout, and the one the banner's button uses.
 */
export const AUTHENTICATOR_SET_UP_URL = `${AUTHENTICATOR_SET_UP_PAGE}?enroll=1`;

/**
 * The pages a member who owes set-up may still open, each a personal page:
 *   - the security settings page: set up and verify an authenticator, and
 *     everything on its shell (sign out, switch organization);
 *   - the profile page: name, avatar, sign-in email, and deleting the account,
 *     which every member can do whatever their organization requires.
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
