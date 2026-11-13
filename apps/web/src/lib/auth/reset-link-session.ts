/**
 * Whether a session came from an emailed link that lets the reset page set a
 * new password (server/actions/auth.ts completePasswordResetAction): its
 * VERIFIED `amr` claim (lib/auth/verified-claims; never the stored cookie
 * decoded unchecked) holds an entry for such a link, made within the window.
 *
 * HOW A PERSON REACHES THE RESET PAGE. Every way is an emailed link that
 * /auth/confirm verifies (verifyOtp) before it lands on /reset/complete
 * (lib/auth/confirm-landing.ts):
 *   - a password reset link (type recovery): Forgot? on the sign-in page, the
 *     phone's Forgot? (api/v1/auth/password-reset sends the same email, which
 *     opens in a browser), Team's Send password reset, the platform console's
 *     Send password reset, and the QA recovery link;
 *   - the invite of a new organization's owner (type invite, from the
 *     platform console), whose account has no password yet.
 * The Auth server records the verify's method on the session it makes, with
 * the time of the verify, and keeps that entry for the life of the session: a
 * refresh does not move it, and an authenticator code entered afterwards adds
 * its own entry ('totp') beside it.
 *
 * THE METHOD NAMES. 'otp' is what /auth/confirm's verify writes for every
 * emailed link: a reset, an invite, a sign-in link and an emailed code alike.
 * 'recovery' and 'invite' can appear only on a code-exchange path. So the rule
 * is any emailed link opened within the hour. A session made with a password
 * alone, or a password and an authenticator code, holds only 'password' and
 * 'totp', and does not count. The list is this one constant.
 *
 * THE WINDOW. One hour from the verify, the life of the access token the
 * link's press mints (jwt_expiry 3600 s) and the hour the link itself is
 * honoured (mailer_otp_exp 3600 s; confirm-recipient.ts). Up to five minutes
 * of the Auth server's clock running ahead of this one is allowed, as for the
 * link's own issue time (CONFIRM_RECIPIENT_FUTURE_SKEW_S). Past the hour the
 * person asks for a new link.
 *
 * Pure: no session read here.
 */

/** The `amr` methods of an emailed link that lands on the reset page. */
export const RESET_LINK_METHODS = ['otp', 'recovery', 'invite'] as const;

/** How long after the link's verify its session may set a new password. */
export const RESET_LINK_WINDOW_S = 60 * 60;

/** How far ahead of this clock the Auth server's time may be. */
export const RESET_LINK_CLOCK_SKEW_S = 5 * 60;

const METHODS: ReadonlySet<string> = new Set(RESET_LINK_METHODS);

/**
 * True when `amr` (a verified token's claim) holds an entry of one of
 * RESET_LINK_METHODS whose time is within the window of `nowSec`. Entries
 * without a numeric time (the bare-string form a custom token hook can write)
 * do not count: their age cannot be known.
 */
export function openedFromResetLink(amr: unknown, nowSec: number): boolean {
  if (!Array.isArray(amr)) return false;
  return amr.some((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return false;
    const { method, timestamp } = entry as { method?: unknown; timestamp?: unknown };
    if (typeof method !== 'string' || !METHODS.has(method)) return false;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return false;
    const age = nowSec - timestamp;
    return age <= RESET_LINK_WINDOW_S && age >= -RESET_LINK_CLOCK_SKEW_S;
  });
}
