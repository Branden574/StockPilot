/**
 * THE CITY A ROW STORES: the one check the app applies before it writes a
 * city to public.sign_in_alerts (migration sign_in_alerts) or hands one to
 * public.security_events (migration security_events). Both tables refuse a
 * city with the same check, written in the same words: 1 to 80 characters,
 * and none of the five patterns below. The check refuses the usual shapes of
 * other things (an address, an email, a path, a query, markup, an id); it is
 * not a proof that the text is a place.
 *
 * WHY. Vercel's city header is read by lib/client-ip.ts (cityOf), which
 * decodes it and refuses control characters, but lets through names the
 * tables refuse, such as one with parentheses or a slash. An insert with such
 * a city is refused whole, so an alert would be lost for its city. The writer
 * empties the city first, with this function, and the alert keeps its
 * country.
 *
 * CITY_CHECK_PATTERNS are the migration's own texts, character for character
 * (place-name.test.ts compares them with the migration when it is in the
 * tree). Each becomes a JavaScript pattern below. `[[:cntrl:]]` has no
 * JavaScript form, so it is read as every C0 and C1 control character and
 * DEL, which is at least what the database refuses: emptying one more city
 * than needed costs a place name, never a row.
 *
 * Pure: no imports, no server-only, usable anywhere. Never throws.
 */

/** The most characters a stored city may have, counted as the database counts (code points). */
export const CITY_MAX_CHARACTERS = 80;

/** The five patterns a stored city must not match, as the migration writes them. */
export const CITY_CHECK_PATTERNS: readonly string[] = Object.freeze([
  '[[:cntrl:]]',
  '[\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]',
  '[@/\\\\:;<>(){}\\[\\]=?&%#"|$*+^~`]',
  '[0-9].*[0-9].*[0-9].*[0-9]',
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-',
]);

/** Every C0 and C1 control character and DEL: what `[[:cntrl:]]` refuses, at least. */
const CONTROL_CHARACTERS = '[\\u0000-\\u001F\\u007F-\\u009F]';

const CITY_CHECKS: readonly RegExp[] = CITY_CHECK_PATTERNS.map(
  (pattern) => new RegExp(pattern === '[[:cntrl:]]' ? CONTROL_CHARACTERS : pattern),
);

/**
 * The city as a row may store it, trimmed, or null when the table would
 * refuse it (or there is none).
 */
export function cityForRecord(city: string | null | undefined): string | null {
  try {
    if (typeof city !== 'string') return null;
    const trimmed = city.trim();
    const characters = [...trimmed].length;
    if (characters < 1 || characters > CITY_MAX_CHARACTERS) return null;
    if (CITY_CHECKS.some((check) => check.test(trimmed))) return null;
    return trimmed;
  } catch {
    return null;
  }
}
