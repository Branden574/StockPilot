/**
 * The words of a sign-in alert (part 3), in one place, so the alert email,
 * Active sessions and the organization's list say the same thing. Pure: no
 * imports, usable on the server and in the browser. Never throws.
 */

let regionNames: Intl.DisplayNames | null | undefined;

function names(): Intl.DisplayNames | null {
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
    } catch {
      regionNames = null;
    }
  }
  return regionNames;
}

/** A country's English name ("Mexico"), its two letters when it has none, or null. */
export function countryName(code: string | null | undefined): string | null {
  if (typeof code !== 'string' || !/^[A-Z]{2}$/.test(code)) return null;
  try {
    return names()?.of(code) || code;
  } catch {
    return code;
  }
}

/**
 * Where a sign-in came from, in words: "Tijuana, Mexico", or "Mexico" alone,
 * or null when the country is not known (a city is never shown without its
 * country). Approximate: it is where the network says the sign-in was.
 */
export function signInAlertPlaceWords(
  country: string | null | undefined,
  city: string | null | undefined,
): string | null {
  const name = countryName(country);
  if (!name) return null;
  const town = typeof city === 'string' ? city.trim() : '';
  return town ? `${town}, ${name}` : name;
}

/** Which kind of alert it was, in two or three words. */
export function signInAlertKindWords(kind: { newDevice: boolean; newCountry: boolean }): string {
  if (kind.newDevice && kind.newCountry) return 'New device and new country';
  if (kind.newCountry) return 'New country';
  return 'New device';
}

/** The short badges a session row shows: "New device", "New country: Mexico". */
export function signInAlertBadges(alert: {
  newDevice: boolean;
  newCountry: boolean;
  country: string | null;
}): string[] {
  const badges: string[] = [];
  if (alert.newDevice) badges.push('New device');
  if (alert.newCountry) {
    const name = countryName(alert.country);
    badges.push(name ? `New country: ${name}` : 'New country');
  }
  return badges;
}

const ANSWER_WORDS: Readonly<Record<string, string>> = {
  open: 'No answer yet',
  was_me: 'Member confirmed',
  not_me: 'Reported: not them',
};

/** The member's answer, as the organization's list shows it. */
export function signInAlertAnswerWords(status: string | null | undefined): string {
  return typeof status === 'string' && Object.prototype.hasOwnProperty.call(ANSWER_WORDS, status)
    ? ANSWER_WORDS[status]!
    : 'Unknown';
}

/**
 * WHAT A "THIS WAS NOT ME" DOES, in the words every page, notice and email
 * uses (review 1, finding 1). They promise what happens and no more:
 *   - every session of the account is ended on the server, so no device can
 *     renew its sign-in;
 *   - a device that is already open and does not listen for the sign-out keeps
 *     the pass it already holds until that pass expires (about an hour at
 *     most), so nothing here says "signed out everywhere" or "right away";
 *   - a password someone else knows still signs in, so the reset is what
 *     closes the door.
 * Plain text with no character a page or an email has to escape.
 */
export const NOT_ME_WORDS = {
  /** After the press, to the member. */
  sessionsEnded: 'Every session of your account has been ended.',
  openDevice:
    'A device that is already open can keep working for a short while, until its current pass expires. That is about an hour at most.',
  resetNow:
    'Reset your password now. That is what closes the door: until you do, anyone who knows it can sign in again.',
  /** Before the press: what the button does. */
  whatItDoes: 'It ends every session of your account.',
  thenReset: 'Then reset your password. That is what closes the door.',
  /** To the owners and admins of the member's organization. */
  theirSessionsEnded: 'Every session of their account has been ended.',
  askThemToReset: 'Ask them to reset their password now. That is what closes the door.',
  /**
   * An alert already reported (one alert, one sign-out: a reported alert
   * ends no session again). Completing a password reset ends every session of
   * the account (completePasswordResetAction in server/actions/auth.ts), so
   * that is how to end them again.
   */
  endedThen: 'Every session of your account was ended when you reported it.',
  endAgain:
    'To end them again now, reset your password. Completing the reset ends every session of your account, and it is what closes the door.',
  /** Said only when at least one owner or admin was told (finding 8). */
  adminsTold: 'The owners and admins of your organization were told, so they can help.',
} as const;

/** The fixed words that lead a notice, a push and an email about a reported sign-in (finding 7). */
export const SIGN_IN_REPORTED_TITLE = 'A member reported a sign-in they did not make';

/** The most characters of a member's own name a notice or an email carries. */
export const REPORTED_MEMBER_NAME_MAX = 80;

// A line break, a tab and their kind: where one stood, one space stands.
const NAME_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]+/g;
// Control, format (zero-width, direction marks and overrides, soft hyphen),
// private-use and half-of-a-pair characters, and the letters and marks that
// print as nothing (the Hangul fillers, the blank braille cell, the combining
// grapheme joiner, the Mongolian and the plain variation selectors).
const NAME_UNSEEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\u034F\u115F\u1160\u180B-\u180F\u2800\u3164\uFE00-\uFE0F\uFFA0]/gu;

/**
 * A member's own name, as the BODY of a notice or an email to other people
 * may carry it (finding 7): the member chooses it, so it never leads a
 * subject or a title, it is cut to REPORTED_MEMBER_NAME_MAX characters, and
 * its control and invisible characters are removed. Null when nothing is
 * left; the caller then names the member by the sign-in address alone.
 * Never throws.
 */
export function reportedMemberName(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  const clean = name.replace(NAME_BREAKS, ' ').replace(NAME_UNSEEN, '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const chars = [...clean];
  if (chars.length <= REPORTED_MEMBER_NAME_MAX) return clean;
  return chars.slice(0, REPORTED_MEMBER_NAME_MAX).join('').trimEnd();
}
