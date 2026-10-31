import type { Href } from 'expo-router';

/**
 * The one check on a `?return=` Back target (docket T14).
 *
 * Drawer-to-drawer pushes build no back stack in expo-router, so a screen
 * that needs a specific Back target is opened with `?return=/path` (Settings
 * opens Locations and Notifications with `?return=/settings`). Five Back
 * buttons honour it: Settings, Support, the AI screen, the Books tab and
 * DataListScreen (the header of every drawer list).
 *
 * The value comes from the link that opened the screen, and anyone can make
 * one: `stockpilot://notifications?return=https%3A%2F%2Fphish.example`. Each
 * Back passed it unchecked to router.replace, and expo-router's linkTo hands
 * any href with a scheme or a leading `//` (https:, tel:, sms:, mailto:,
 * otherapp://) to Linking.openURL instead of navigating. So the app's own
 * Back opened whatever website or app the link named.
 *
 * inAppReturnPath accepts only a path inside this app, and goBackFromReturn
 * falls back to the screen's normal Back (back, else Home) for anything else.
 * The web has the same rule for its own redirects (safeRedirectPath).
 */

/** Longer than any route the app writes; a longer value is not a Back target. */
const MAX_RETURN_PATH_LENGTH = 512;

/** Percent-decoding rounds checked; a value still changing after them is refused. */
const MAX_DECODE_ROUNDS = 4;

/**
 * One form of the value (as given, or after a round of percent-decoding) is
 * an in-app path: printable ASCII with no spaces (so no control characters,
 * whitespace or look-alike slashes), a single leading `/`, no backslash
 * anywhere, and a path part (before `?` or `#`) with no `:` (no scheme), no
 * empty segment (so no `//` host) and no `.` or `..` segment (which URL
 * parsing collapses into one).
 */
function isInAppPathForm(value: string): boolean {
  if (!/^[\x21-\x7E]+$/.test(value)) return false;
  if (value[0] !== '/') return false;
  if (value.includes('\\')) return false;
  const pathPart = value.split(/[?#]/, 1)[0] ?? '';
  if (pathPart.includes(':')) return false;
  if (pathPart.includes('//')) return false;
  return !pathPart.split('/').some((segment) => segment === '.' || segment === '..');
}

/**
 * The `?return=` value when it is a path inside this app, else null.
 *
 * The value as given and every percent-decoded form of it must pass
 * (`/%2F%2Fhost` decodes to `//host`, `/%5Chost` to `/\host`); a malformed
 * escape is refused rather than guessed at. A repeated param (an array), an
 * absent one or an empty one is null. The value is returned unchanged, as
 * the router decodes it itself.
 */
export function inAppReturnPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > MAX_RETURN_PATH_LENGTH) return null;
  let form = raw;
  for (let round = 0; ; round += 1) {
    if (!isInAppPathForm(form)) return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(form);
    } catch {
      return null;
    }
    if (decoded === form) return raw;
    if (round >= MAX_DECODE_ROUNDS) return null;
    form = decoded;
  }
}

/** What a Back button needs of expo-router's router (a fake in tests). */
export type ReturnBackRouter = {
  replace: (href: Href) => void;
  back: () => void;
  canGoBack: () => boolean;
};

/**
 * Back for a screen that honours `?return=`: the return path when it is an
 * in-app path, else back when there is a screen to go back to, else Home.
 */
export function goBackFromReturn(router: ReturnBackRouter, rawReturn: unknown): void {
  const target = inAppReturnPath(rawReturn);
  if (target !== null) {
    router.replace(target as Href);
    return;
  }
  if (router.canGoBack()) router.back();
  else router.replace('/');
}
