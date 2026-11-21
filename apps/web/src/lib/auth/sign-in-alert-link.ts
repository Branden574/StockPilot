import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The "This was not me" link of a sign-in alert email (part 3 of the security
 * tools): `/sign-in-alert?a=<alert id>&i=<issue day>&t=<tag>`. Pure: node:crypto
 * only, no env, no `server-only`. The app signs and checks through
 * lib/auth/sign-in-alert-url.ts, which supplies the key.
 *
 * THE VALUES:
 *   - a: the sign_in_alerts row's id, a lowercase UUID;
 *   - i: the UTC day the link was made, eight digits (YYYYMMDD);
 *   - t: base64url without padding (43 characters) of HMAC-SHA256 under the
 *     link key, over `v1:<alert id>:<user id>:<issue day>`. The user id is
 *     signed but not carried: the route reads the alert's own account and
 *     checks the tag against it, so a tag made for one account never opens
 *     another account's alert. No part can hold `:` (UUIDs and digits), so no
 *     two inputs share a signed text.
 *   - the link key: HMAC-SHA256 keyed with the trimmed service key, over the
 *     fixed label `stockpilot:sign-in-alert-link-key:v1`. Derived rather than
 *     a new setting, as lib/auth/confirm-recipient.ts does: the service key
 *     already exists wherever an alert is written, and the derived key is
 *     never the service key itself.
 *
 * THE WINDOW: SIGN_IN_ALERT_LINK_DAYS days after the issue day (so between 7
 * and 8 days, by the hour it was sent), and one day ahead of this clock for a
 * server whose clock is just past midnight. Outside it a link is expired.
 *
 * Fail closed: with no key nothing is signed and nothing verifies. The tag is
 * compared in constant time, and only the one spelling the signer writes
 * passes. Nothing here throws, whatever it is handed.
 */

/** How many days after its issue day a link still works. */
export const SIGN_IN_ALERT_LINK_DAYS = 7;
/** How many days ahead of this clock an issue day may be. */
const FUTURE_DAYS = 1;

const KEY_LABEL = 'stockpilot:sign-in-alert-link-key:v1';
const VERSION = 'v1';
const DAY_MS = 24 * 60 * 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^[0-9]{8}$/;
/** 32 bytes of HMAC-SHA256 in base64url without padding. */
const TAG_RE = /^[A-Za-z0-9_-]{43}$/;

/** What a link is, for one alert and its account, at a time. */
export type SignInAlertLinkVerdict = 'valid' | 'expired' | 'invalid';

/** The three values of a link, each in its shape. */
export interface SignInAlertLinkParams {
  alertId: string;
  issuedDay: string;
  tag: string;
}

/** The UTC day of `now`, as the link carries it (YYYYMMDD). */
export function issuedDayOf(now: Date): string {
  return now.toISOString().slice(0, 10).replace(/-/g, '');
}

/** Midnight UTC of a YYYYMMDD day, in ms, or null when it is not a real date. */
function dayStartMs(day: string): number | null {
  if (typeof day !== 'string' || !DAY_RE.test(day)) return null;
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(4, 6));
  const d = Number(day.slice(6, 8));
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return ms;
}

function linkKey(serviceRoleKey: unknown): Buffer | null {
  const key = typeof serviceRoleKey === 'string' ? serviceRoleKey.trim() : '';
  if (!key) return null;
  return createHmac('sha256', key).update(KEY_LABEL).digest();
}

function tagFor(key: Buffer, alertId: string, userId: string, issuedDay: string): Buffer {
  return createHmac('sha256', key).update(`${VERSION}:${alertId}:${userId}:${issuedDay}`).digest();
}

/**
 * The tag for one alert, or null when it cannot be signed: no key, an alert
 * or user id that is not a UUID, or an issue day that is not a real date. A
 * caller that gets null sends the email without the link.
 */
export function signSignInAlertLink(
  serviceRoleKey: string,
  claim: { alertId: string; userId: string; issuedDay: string },
): string | null {
  try {
    const key = linkKey(serviceRoleKey);
    if (!key || !claim || typeof claim !== 'object') return null;
    const alertId = typeof claim.alertId === 'string' ? claim.alertId.toLowerCase() : '';
    const userId = typeof claim.userId === 'string' ? claim.userId.toLowerCase() : '';
    if (!UUID_RE.test(alertId) || !UUID_RE.test(userId) || dayStartMs(claim.issuedDay) === null) {
      return null;
    }
    return tagFor(key, alertId, userId, claim.issuedDay).toString('base64url');
  } catch {
    return null;
  }
}

/**
 * The link's three values from a request (the query of GET, the form of
 * POST), or null when any is missing or out of its shape. Pure: nothing is
 * read. The alert id is lower-cased, as it is signed.
 */
export function readSignInAlertLink(params: {
  a: string | null | undefined;
  i: string | null | undefined;
  t: string | null | undefined;
}): SignInAlertLinkParams | null {
  try {
    const { a, i, t } = params ?? {};
    if (typeof a !== 'string' || typeof i !== 'string' || typeof t !== 'string') return null;
    if (a.length > 36 || i.length > 8 || t.length > 43) return null;
    if (!UUID_RE.test(a) || dayStartMs(i) === null || !TAG_RE.test(t)) return null;
    return { alertId: a.toLowerCase(), issuedDay: i, tag: t };
  } catch {
    return null;
  }
}

/**
 * Whether a link issued on `issuedDay` still works at `now`: from one day
 * ahead of this clock to SIGN_IN_ALERT_LINK_DAYS days after. Pure, so a route
 * can turn away an old link before it reads anything.
 */
export function signInAlertLinkInWindow(issuedDay: string, now: Date): boolean {
  const issued = dayStartMs(issuedDay);
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (issued === null || !Number.isFinite(nowMs)) return false;
  const today = dayStartMs(issuedDayOf(new Date(nowMs)));
  if (today === null) return false;
  const age = Math.round((today - issued) / DAY_MS);
  return age >= -FUTURE_DAYS && age <= SIGN_IN_ALERT_LINK_DAYS;
}

/**
 * Checks a link's tag against the alert and the account the alert belongs to
 * (`userId`, read from the alert row, never from the request), at `now`. In
 * order, all pure computation: the shapes, the key, the tag in constant time
 * (and its one spelling), then the window. Only a link whose tag checks out
 * is ever called expired. Never throws.
 */
export function checkSignInAlertLink(
  serviceRoleKey: string,
  args: { alertId: string; userId: string; issuedDay: string; tag: string; now: Date },
): SignInAlertLinkVerdict {
  try {
    const { alertId, userId, issuedDay, tag, now } = args ?? ({} as typeof args);
    if (typeof alertId !== 'string' || typeof userId !== 'string' || typeof tag !== 'string') {
      return 'invalid';
    }
    const alert = alertId.toLowerCase();
    const user = userId.toLowerCase();
    if (!UUID_RE.test(alert) || !UUID_RE.test(user) || !TAG_RE.test(tag)) return 'invalid';
    if (dayStartMs(issuedDay) === null) return 'invalid';
    const key = linkKey(serviceRoleKey);
    if (!key) return 'invalid';
    const expected = tagFor(key, alert, user, issuedDay);
    const provided = Buffer.from(tag, 'base64url');
    // TAG_RE admits 43 characters whose last one carries 2 spare bits, so the
    // text is compared too: only the one spelling the signer writes passes.
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(expected, provided) ||
      expected.toString('base64url') !== tag
    ) {
      return 'invalid';
    }
    return signInAlertLinkInWindow(issuedDay, now) ? 'valid' : 'expired';
  } catch {
    return 'invalid';
  }
}
