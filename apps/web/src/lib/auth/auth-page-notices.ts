/**
 * What an auth page says when the app sent the person there with a reason in
 * the URL (docket B39).
 *
 * The auth routes answer a failed emailed link with a redirect: /auth/confirm
 * (an invite, a portal sign-in link, a refused post) and /auth/callback (no
 * code, or the exchange failed) to /signin?error=auth_callback_failed, and a
 * recovery link to /reset?error=link_expired. /signin never read its `error`,
 * so a person whose invite or sign-in link had expired landed on a plain
 * sign-in form with no word that the link did not work, and could think it had
 * or press the same dead link again.
 *
 * Every value is decided here, in one table per page: a notice, or `null` for
 * nothing on purpose (the reason is beside it). A value that is not in a table
 * shows nothing, and no page ever prints a URL value: the words are fixed, so
 * a crafted link cannot put its own sentence on the sign-in card.
 * auth-page-notices.guard.test.ts reads the source for every value the app
 * puts on /signin and /reset, and fails until a new one is decided here.
 *
 * Pure and dependency-free: the sign-in form (a client component) and the
 * /reset page (a server component) both import it.
 */

export type AuthNoticeTone = 'info' | 'danger';

export interface AuthNoticeCopy {
  /** `info` is a calm status; `danger` says something did not work. */
  readonly tone: AuthNoticeTone;
  readonly text: string;
}

/** An emailed sign-in, invite or confirmation link that did not work. */
export const LINK_FAILED_NOTICE: AuthNoticeCopy = {
  tone: 'danger',
  text: 'That link has expired or was already used. Sign in with your password, or ask whoever sent you the link for a new one.',
};

/** This device's session was ended elsewhere (revoked, or signed out everywhere). */
export const SESSION_ENDED_NOTICE: AuthNoticeCopy = {
  tone: 'info',
  text: 'You were signed out on this device. Sign in again to continue.',
};

/** A password reset link that did not work: the /reset form sends a new one. */
export const RESET_LINK_EXPIRED_NOTICE: AuthNoticeCopy = {
  tone: 'danger',
  text: "That reset link has expired or was already used. Enter your email below and we'll send a fresh one.",
};

type NoticeTable = Readonly<Record<string, Readonly<Record<string, AuthNoticeCopy | null>>>>;

/** Every query value the app puts on /signin, by parameter. */
export const SIGN_IN_QUERY_NOTICES = {
  error: {
    // app/auth/callback (no code, or the code exchange failed) and
    // app/auth/confirm (an invite or sign-in link that expired, was used, or
    // was posted from another site).
    auth_callback_failed: LINK_FAILED_NOTICE,
  },
  reason: {
    // app/auth/session-ended.
    session_ended: SESSION_ENDED_NOTICE,
  },
  reset: {
    // server/actions/auth.ts completePasswordResetAction. Nothing on purpose:
    // the reset form shows "Password updated." as it sends the person here. A
    // line on the card as well is an owner question (docket O4).
    success: null,
  },
} as const satisfies NoticeTable;

/** Every query value the app puts on /reset, by parameter. */
export const RESET_QUERY_NOTICES = {
  error: {
    // app/auth/confirm: a recovery link that expired, was used, or was posted
    // from another site.
    link_expired: RESET_LINK_EXPIRED_NOTICE,
  },
} as const satisfies NoticeTable;

/**
 * The notice a table holds for this value. Own keys only: `?error=constructor`
 * or `?reason=__proto__` must not reach an object's inherited members.
 */
function decided(
  values: Readonly<Record<string, AuthNoticeCopy | null>>,
  value: string | null | undefined,
): AuthNoticeCopy | null {
  if (value == null || !Object.hasOwn(values, value)) return null;
  return values[value] ?? null;
}

/**
 * What the URL fragment says about the link the browser arrived from. No
 * server sees a fragment, and a redirect keeps it, so a link Supabase verified
 * itself (its action_link, which this app no longer emails but an older email
 * or the Supabase dashboard can still hold) reaches /signin with its outcome
 * there:
 *   'failed'   Supabase refused the link: `error`, `error_code` or
 *              `error_description`, the keys auth-js reads as a failed redirect
 *              (it checks them before anything else, and so does this);
 *   'session'  the link worked and its session is in the fragment
 *              (`access_token`); RecoveryFragmentGuard forwards a recovery one
 *              to /reset/complete;
 *   'none'     anything else, including no fragment.
 */
export type LinkFragment = 'failed' | 'session' | 'none';

export function linkFragment(hash: string | null | undefined): LinkFragment {
  const raw = (hash ?? '').replace(/^#/, '');
  if (!raw) return 'none';
  const params = new URLSearchParams(raw);
  if (params.has('error') || params.has('error_code') || params.has('error_description')) {
    return 'failed';
  }
  return params.has('access_token') ? 'session' : 'none';
}

/** The search params as the page has them (URLSearchParams, Next's ReadonlyURLSearchParams). */
export interface QueryValues {
  get(name: string): string | null;
}

/**
 * The one notice the sign-in card shows, or null. A failed link outranks the
 * other reasons, since it is why the person is here. A session in the fragment
 * means the link worked whatever the query says (/auth/callback answers every
 * fragment link with ?error=auth_callback_failed, because it cannot see one).
 */
export function signInNotice(query: QueryValues, fragment: LinkFragment): AuthNoticeCopy | null {
  if (fragment === 'failed') return LINK_FAILED_NOTICE;
  const error =
    fragment === 'session' ? null : decided(SIGN_IN_QUERY_NOTICES.error, query.get('error'));
  return (
    error ??
    decided(SIGN_IN_QUERY_NOTICES.reason, query.get('reason')) ??
    decided(SIGN_IN_QUERY_NOTICES.reset, query.get('reset'))
  );
}

/**
 * The notice the /reset card shows for its `error` value, or null. A repeated
 * parameter reaches a page as an array; like URLSearchParams.get, the first
 * value is the one read.
 */
export function resetNotice(
  error: string | readonly string[] | null | undefined,
): AuthNoticeCopy | null {
  return decided(RESET_QUERY_NOTICES.error, typeof error === 'string' ? error : error?.[0]);
}
