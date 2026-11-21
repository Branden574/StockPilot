import type { OrganizationMfaPolicy } from './step-up';

/**
 * Where a member who must set up an authenticator first is sent, and the words
 * they read, shared by the website, the API and the phone.
 *
 * The rule itself (who owes set-up) is `authenticatorSetUpOwed` in
 * ./step-up.ts. Set-up happens on the website: the phone opens these
 * addresses there.
 *
 * PURE: strings and one string builder, no platform imports.
 */

/** The website's security settings page, where an authenticator is set up. */
export const AUTHENTICATOR_SET_UP_PAGE = '/dashboard/settings/security';

/**
 * The set-up address. `?enroll=1` is the parameter the security page reads to
 * show its "Enroll to continue" callout, and the one the banner's button uses.
 */
export const AUTHENTICATOR_SET_UP_URL = `${AUTHENTICATOR_SET_UP_PAGE}?enroll=1`;

/** The heading where the app would be, for a member who must set one up first. */
export const AUTHENTICATOR_SET_UP_TITLE = 'Set up an authenticator to continue';

/**
 * The answer to a request a member may not make until they set up an
 * authenticator: their organization's policy requires one of their role and
 * their account has none. A plain sentence for the `message` of a refusal
 * whose `details.reason` is 'mfa_required'; callers decide by that reason,
 * never by this text.
 */
export const AUTHENTICATOR_SET_UP_OWED_COPY =
  'Your organization requires an authenticator for your account. Set one up on the website, then try again.';

/**
 * The body of the phone's holding screen for a member who must set one up
 * first, for a policy that was READ (never for a row that could not be read:
 * that is "could not check", CONTEXT_UNAVAILABLE_COPY in ./context-unavailable.ts).
 * Names the organization when its name is known.
 */
export function authenticatorSetUpHoldBody(
  organizationName: string | null | undefined,
  policy: Exclude<OrganizationMfaPolicy, 'optional'>,
): string {
  const name = organizationName?.trim() || 'Your organization';
  const who = policy === 'all_required' ? 'everyone' : 'owners and admins';
  return `${name} asks ${who} to use an authenticator app. Set one up on the website, then come back to this app.`;
}

/**
 * The phone's holding screen when a check answered and could not tell whether
 * an authenticator is owed (the organization's row could not be read, or its
 * policy is not one the app knows). Claims nothing about the member.
 */
export const AUTHENTICATOR_CHECK_UNAVAILABLE_COPY = {
  title: 'Your access could not be checked',
  body: 'Your access could not be checked just now. Try again in a moment.',
} as const;

/** The line under the holding screen's body after Check again. */
export const AUTHENTICATOR_CHECK_RESULT_COPY = {
  /** An answer came and the screen stays. */
  checked: 'Checked just now.',
  /** No answer came (no connection, no answer in time, or an error). */
  noAnswer: 'Could not check. Try again.',
} as const;

/** The phone's holding screen: its actions, and the hint on the one that leaves the app. */
export const AUTHENTICATOR_SET_UP_HOLD_COPY = {
  setUpOnWebsite: 'Set up on the website',
  setUpOnWebsiteHint: 'Opens the website',
  checkAgain: 'Check again',
  switchWorkspace: 'Switch workspace',
  /** An organization in the holding screen's list whose name could not be read. */
  unnamedWorkspace: 'Workspace',
  signOut: 'Sign out',
  deleteAccount: 'Delete my account',
} as const;
