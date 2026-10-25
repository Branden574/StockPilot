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
 * there. Both outcomes are a link that did not sign the person in:
 *   - Supabase refused it: `error`, `error_code` or `error_description`, the
 *     keys auth-js reads as a failed redirect;
 *   - Supabase accepted it and put a session in the fragment (`access_token`,
 *     `refresh_token`). The app cannot use that session. Its browser client
 *     (lib/supabase/client.ts) is @supabase/ssr's, which forces the PKCE flow,
 *     and auth-js refuses an implicit-grant fragment under PKCE; with the
 *     ?error=auth_callback_failed that /auth/callback adds, it refuses even
 *     earlier (lib/supabase/client.test.ts pins both). GoTrue has spent the
 *     link, and the person is not signed in.
 * Never adopt a session from the fragment (setSession, or a client in the
 * implicit flow): any page could then sign a signed-out browser in to another
 * account by linking to /signin#access_token=<theirs> (login CSRF, docket S14).
 * 'none' is anything else, including no fragment.
 */
export type LinkFragment = 'failed' | 'none';

/** The fragment keys auth-js reads as a failed redirect. */
const FRAGMENT_ERROR_KEYS = ['error', 'error_code', 'error_description'] as const;

/** The fragment keys that carry a session's credentials. */
const FRAGMENT_SESSION_KEYS = [
  'access_token',
  'refresh_token',
  'provider_token',
  'provider_refresh_token',
] as const;

function fragmentParams(hash: string | null | undefined): URLSearchParams | null {
  const raw = (hash ?? '').replace(/^#/, '');
  return raw ? new URLSearchParams(raw) : null;
}

function holdsSession(params: URLSearchParams): boolean {
  return FRAGMENT_SESSION_KEYS.some((key) => params.has(key));
}

export function linkFragment(hash: string | null | undefined): LinkFragment {
  const params = fragmentParams(hash);
  if (!params) return 'none';
  return FRAGMENT_ERROR_KEYS.some((key) => params.has(key)) || holdsSession(params)
    ? 'failed'
    : 'none';
}

/**
 * What stays in the address bar once a session fragment's tokens are taken
 * out (components/auth/session-fragment-scrub.tsx): no credential, and still a
 * failed link to linkFragment, so the note stays on every render and after a
 * reload.
 */
export const SPENT_SESSION_FRAGMENT = '#error=unusable_link';

/**
 * The fragment to put in place of this one when it carries a session, or null
 * when it carries none. The whole fragment goes: everything in it came from
 * the same answer, and its access and refresh tokens are live.
 */
export function fragmentWithoutSession(hash: string | null | undefined): string | null {
  const params = fragmentParams(hash);
  return params && holdsSession(params) ? SPENT_SESSION_FRAGMENT : null;
}

/** The search params as the page has them (URLSearchParams, Next's ReadonlyURLSearchParams). */
export interface QueryValues {
  get(name: string): string | null;
}

/**
 * The one notice the sign-in card shows, or null. A failed link, in the
 * fragment or the query, outranks the other reasons, since it is why the
 * person is here.
 */
export function signInNotice(query: QueryValues, fragment: LinkFragment): AuthNoticeCopy | null {
  if (fragment === 'failed') return LINK_FAILED_NOTICE;
  return (
    decided(SIGN_IN_QUERY_NOTICES.error, query.get('error')) ??
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
