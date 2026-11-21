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
