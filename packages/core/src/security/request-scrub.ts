/**
 * "What was asked for" (security tools part 5, stage 3): the path and the
 * query string of a request the site refused on a scanner path, made safe to
 * keep in public.security_event_samples (migration 0479).
 *
 * The text is chosen by whoever sent the request. Before it is kept it is
 * scrubbed here: anything that looks like an email address, an id, a long
 * number, a network address, a long value or a token is replaced by a fixed
 * marker, any other `@` reads `(at)`, the value of any query key that names a
 * secret is removed whole, and the text is cut to length. The database refuses what isStorableTarget and
 * isStorableSample refuse (the text rules below are the migration's own,
 * copied word for word), and the last step of each scrub function checks its
 * own output against them, so the writer never has to skip what this sends.
 *
 * WHAT IS KEPT IS WHAT WAS SENT. The rules read the text as it would be
 * decoded (percent escapes undone up to three times, invisible characters
 * taken out), so an encoded or broken-up value is found; what is kept is the
 * text as it was sent, with only the parts a rule found replaced. So
 * `/..%2f..%2fetc%2fpasswd` stays exactly that: the encoding is part of what
 * the scanner tried. Every kept character is printable ASCII.
 *
 * Pure: no imports, no I/O.
 */

// ── The text rules (CONTRACT.md of migration 0479, "The text rules", word for word) ──

export const SAMPLE_TARGET_MAX = 200;
export const SAMPLE_QUERY_MAX = 300;
export const SAMPLE_UNREADABLE_TARGET = '(unreadable)';
export const SAMPLE_OVERFLOW_TARGET = '(more than could be listed)';
const NOT_PRINTABLE_ASCII = /[^ -~]/;
const PERCENT_ENCODED_AT = /%(25)*40/; // %40, %2540, %252540, ...
const SIX_DIGITS = /[0-9]{6}/;
const IPV4 = /[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/; // not anchored: 1.2.3.4.5 is refused too
const LONG_VALUE = /[A-Za-z0-9+=]{24}/; // 24 or more in a row; '/', '-' and '_' break a run
const AN_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const AN_ID_WITHOUT_DASHES = /[0-9a-f]{32}/i;
function passesStoredTextRule(s: string): boolean {
  return (
    !NOT_PRINTABLE_ASCII.test(s) &&
    !s.includes('@') &&
    !PERCENT_ENCODED_AT.test(s) &&
    !SIX_DIGITS.test(s) &&
    !IPV4.test(s) &&
    !LONG_VALUE.test(s) &&
    !AN_ID.test(s) &&
    !AN_ID_WITHOUT_DASHES.test(s)
  );
}
/** A target the writer stores (the overflow word is the writer's own and is refused). */
export function isStorableTarget(t: string): boolean {
  return (
    t.length >= 1 &&
    t.length <= SAMPLE_TARGET_MAX &&
    passesStoredTextRule(t) &&
    (t.startsWith('/') || t === SAMPLE_UNREADABLE_TARGET)
  );
}
/** A query string the writer stores; '' and null are none. */
export function isStorableSample(q: string | null | undefined): boolean {
  if (q == null || q === '') return true;
  return q.length <= SAMPLE_QUERY_MAX && passesStoredTextRule(q);
}

// ── Constants for core (CONTRACT.md of migration 0479, word for word) ──

export const SAMPLE_BATCH_MAX = 50; // elements read from one call
export const SAMPLE_KIND_CAP_PER_HOUR = 50; // new listed rows an hour for one kind
export const SAMPLE_HOUR_CAP = 300; // new listed rows an hour in all
export const SAMPLE_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
export const SAMPLE_COUNT_MAX = 999_999; // a larger count is taken as 1: the recorder caps its own at this
export const SAMPLE_AT_MS_PAST_HOURS = 26;
export const SAMPLE_RETENTION_DAYS = 90;
export const SAMPLE_PURGE_BATCH = 5_000;
export const SAMPLE_READ_MAX_HOURS = 168;
export const SAMPLE_READ_DEFAULT_HOURS = 24;
export const SAMPLE_READ_DEFAULT_LIMIT = 10;
export const SAMPLE_READ_MAX_LIMIT = 50;
export const SAMPLE_READ_PAIRS_PER_TARGET = 5;
export const SAMPLE_READ_ROW_CEILING = 60_000;

export type SampleMethod = (typeof SAMPLE_METHODS)[number];

export function isSampleMethod(value: unknown): value is SampleMethod {
  return typeof value === 'string' && (SAMPLE_METHODS as readonly string[]).includes(value);
}

// ── The scrubber's own words ────────────────────────────────────────────────

/** The markers that stand where a rule took something out. Each passes every text rule. */
export const SAMPLE_MARKERS = {
  email: '<email>',
  id: '<id>',
  number: '<number>',
  longValue: '<long value>',
  token: '<token>',
  removed: '<removed>',
  address: '<address>',
  /** An `@` that is not part of an email address, in its place (`/@vite/env` reads `/(at)vite/env`). */
  at: '(at)',
} as const;

/** What a cut text ends in: three ASCII dots (the character for an ellipsis is not ASCII). */
export const SAMPLE_CUT_MARK = '...';

/**
 * The most characters of a path or a query string the scrubber reads at all
 * (review S1): the rest is cut off before any rule runs, so no rule ever reads
 * more than this, whatever was sent.
 */
export const SAMPLE_INPUT_MAX = 512;

/** How many times percent escapes are undone for the rules, at most (review S2). */
export const SAMPLE_DECODE_LEVELS = 3;

/**
 * A query part with no `=` (a value with no key) of this many characters or
 * more is removed whole (review S2): a short word is kept, a long one is not.
 */
export const SAMPLE_BARE_VALUE_MAX = 80;

/**
 * A query key (or a `;key=value` part of a path) whose name, decoded and in
 * lower case, CONTAINS one of these has its value removed whole. Design 2.2's
 * list, then review S2's.
 */
export const SAMPLE_SECRET_KEY_PARTS = [
  'pass',
  'pwd',
  'secret',
  'token',
  'key',
  'auth',
  'code',
  'otp',
  'session',
  'sig',
  'signature',
  'hash',
  'email',
  'user',
  'login',
  'card',
  'ssn',
  'pw',
  'phone',
  'tel',
  'name',
  'addr',
  'dob',
  'sid',
  'jwt',
  'bearer',
  'cred',
  'cookie',
  'nonce',
  'state',
  'saml',
  'assert',
  'cert',
  'private',
  'access',
  'refresh',
] as const;

/**
 * A query key that IS one of these (decoded, in lower case) has its value
 * removed whole: the one-letter names this app's own links carry a token or an
 * address in (the unsubscribe link's m, e and t, the sign-in alert's a, i and
 * t, the sign-in confirmation's r), so a scanner that reuses such a link's
 * query on a scanner path does not leave the token in a sample.
 */
export const SAMPLE_SECRET_KEY_NAMES = ['a', 'e', 'i', 'm', 'r', 't'] as const;

/** True when a query key of this (decoded) name has its value removed. */
export function isSecretQueryKey(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    (SAMPLE_SECRET_KEY_NAMES as readonly string[]).includes(lower) ||
    SAMPLE_SECRET_KEY_PARTS.some((part) => lower.includes(part))
  );
}

// ── Units: the text as sent, and as the rules read it ───────────────────────

/**
 * One character of the input, or a marker that replaced some.
 *   view: what the rules read: the decoded character when it is printable
 *     ASCII, '' when it is invisible (a control, format, zero-width, bidi or
 *     line separator character), '?' for any other; for a marker, its text.
 *   out: what is kept: the text as it was sent (an escape stays an escape),
 *     '?' for a literal character that is not printable ASCII, '' for a
 *     literal invisible one; for a marker, its text.
 *   literal: the character was sent as itself, not percent-encoded. The
 *     text is split at a literal `/`, `;`, `&` or `=` as a server splits it;
 *     the key rule then reads it a second time split at decoded ones too.
 */
interface Piece {
  view: string;
  out: string;
  literal: boolean;
  marker: boolean;
  /** The decoded code point (-1 when the bytes are not UTF-8); unused for a marker. */
  cp: number;
  /** A byte not yet grouped into a code point (an escape made by the last decode). */
  byte: number | null;
}

const INVISIBLE = /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]$/u;
const HEX_DIGIT = /^[0-9A-Fa-f]$/;

function isHexDigitCode(cp: number): boolean {
  return (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x46) || (cp >= 0x61 && cp <= 0x66);
}

function viewOf(cp: number): string {
  if (cp >= 0x20 && cp <= 0x7e) return String.fromCharCode(cp);
  if (cp >= 0 && cp <= 0x10ffff && INVISIBLE.test(String.fromCodePoint(cp))) return '';
  return '?';
}

/** Fills in view and out from cp, for a unit. */
function settle(p: Piece): Piece {
  p.view = viewOf(p.cp);
  // A literal character is kept as the rules read it: itself when printable
  // ASCII, '?' for any other, nothing for an invisible one.
  if (p.literal) p.out = p.view;
  return p;
}

function literalUnit(ch: string): Piece {
  return settle({
    view: '',
    out: '',
    literal: true,
    marker: false,
    cp: ch.codePointAt(0) ?? -1,
    byte: null,
  });
}

function byteUnit(byte: number, out: string): Piece {
  return { view: '', out, literal: false, marker: false, cp: -1, byte };
}

function markerPiece(marker: string): Piece {
  return { view: marker, out: marker, literal: false, marker: true, cp: -1, byte: null };
}

/** Groups the ungrouped bytes into code points (UTF-8); a byte that is not part of one is -1. */
function groupBytes(units: Piece[]): Piece[] {
  const out: Piece[] = [];
  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    if (u.byte === null) {
      out.push(u);
      continue;
    }
    const b = u.byte;
    const need =
      b >= 0xc2 && b <= 0xdf ? 1 : b >= 0xe0 && b <= 0xef ? 2 : b >= 0xf0 && b <= 0xf4 ? 3 : 0;
    let cp = b < 0x80 ? b : -1;
    let raw = u.out;
    let used = 0;
    if (need > 0) {
      let value = b & (need === 1 ? 0x1f : need === 2 ? 0x0f : 0x07);
      let ok = true;
      for (let k = 1; k <= need; k++) {
        const next = units[i + k];
        if (!next || next.byte === null || next.byte < 0x80 || next.byte > 0xbf) {
          ok = false;
          break;
        }
        value = (value << 6) | (next.byte & 0x3f);
      }
      if (ok) {
        cp = value;
        used = need;
        for (let k = 1; k <= need; k++) raw += units[i + k]!.out;
      }
    }
    out.push(settle({ view: '', out: raw, literal: false, marker: false, cp, byte: null }));
    i += used;
  }
  return out;
}

/** The text as units after one decode: every `%XX` is one byte, everything else itself. */
function firstDecode(raw: string): Piece[] {
  const units: Piece[] = [];
  const chars = [...raw];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (ch === '%' && HEX_DIGIT.test(chars[i + 1] ?? '') && HEX_DIGIT.test(chars[i + 2] ?? '')) {
      units.push(
        byteUnit(parseInt(chars[i + 1]! + chars[i + 2]!, 16), `%${chars[i + 1]}${chars[i + 2]}`),
      );
      i += 2;
    } else {
      units.push(literalUnit(ch));
    }
  }
  return groupBytes(units);
}

/** One more decode over the units: a decoded `%` and two decoded hex digits become one byte. */
function decodeAgain(units: Piece[]): { units: Piece[]; changed: boolean } {
  const out: Piece[] = [];
  let changed = false;
  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    const a = units[i + 1];
    const b = units[i + 2];
    if (u.cp === 0x25 && a && b && isHexDigitCode(a.cp) && isHexDigitCode(b.cp)) {
      out.push(byteUnit(parseInt(String.fromCharCode(a.cp, b.cp), 16), u.out + a.out + b.out));
      changed = true;
      i += 2;
    } else {
      out.push(u);
    }
  }
  return { units: changed ? groupBytes(out) : units, changed };
}

/** The input as units, decoded up to SAMPLE_DECODE_LEVELS times. */
function unitsOf(raw: string): Piece[] {
  let units = firstDecode(raw);
  for (let level = 2; level <= SAMPLE_DECODE_LEVELS; level++) {
    const next = decodeAgain(units);
    if (!next.changed) break;
    units = next.units;
  }
  return units;
}

/**
 * The input cut to SAMPLE_INPUT_MAX characters and still decodable, or null
 * when it cannot be decoded (a malformed escape, bytes that are not UTF-8). A
 * cut never leaves half an escape: what the cut broke is dropped.
 */
function readable(raw: string): { text: string; cut: boolean } | null {
  let text = raw;
  let cut = false;
  if ([...text].length > SAMPLE_INPUT_MAX) {
    text = [...text].slice(0, SAMPLE_INPUT_MAX).join('');
    cut = true;
    text = text.replace(/%[0-9A-Fa-f]?$/, '');
  }
  for (let tries = 0; ; tries++) {
    try {
      decodeURIComponent(text);
      return { text, cut };
    } catch {
      // Only a cut may be mended (it broke a character of up to four escapes).
      if (!cut || tries >= 3 || !/%[0-9A-Fa-f]{2}$/.test(text)) return null;
      text = text.slice(0, -3);
    }
  }
}

// ── The rules ───────────────────────────────────────────────────────────────

/** A part of a view to replace, [from, to), and with what. */
type Found = { from: number; to: number };

export interface ScrubRule {
  readonly name: string;
  readonly marker: string;
  /** The parts of `view` this rule replaces; in order, not overlapping. */
  readonly find: (view: string) => Found[];
  /** Run over a query string only (a path's `/` is a separator, not data). */
  readonly only?: 'query';
}

function all(re: RegExp, view: string, keep?: (text: string) => boolean): Found[] {
  const found: Found[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(view); m !== null; m = re.exec(view)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    if (!keep || keep(m[0])) found.push({ from: m.index, to: m.index + m[0].length });
  }
  return found;
}

/** The characters an address's local part and domain are made of (no URL separator). */
const EMAIL_WORD = /[A-Za-z0-9!$%'*+^_`{|}~.-]/;
const AT_SIGN = /@|%(?:25)*40/gi;

/**
 * What follows the `@` of an email address: a domain with a dot and a
 * top-level name of letters. Whatever is glued after it (`-old`, `1`, an
 * encoded `-`) goes with the address: the walk takes the whole word around
 * the `@` (review 3B, M1: a lookahead here once let such an address through).
 */
const EMAIL_DOMAIN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;

/**
 * An email address (something@something.tld, its `@` sent as itself or
 * encoded, still encoded after three decodes too), with the word around it.
 * An `@` that is not part of one is left to the at_sign rule.
 */
function findEmail(view: string): Found[] {
  const found: Found[] = [];
  AT_SIGN.lastIndex = 0;
  for (let m = AT_SIGN.exec(view); m !== null; m = AT_SIGN.exec(view)) {
    let from = m.index;
    let to = m.index + m[0].length;
    const last = found[found.length - 1];
    if (last && from < last.to) continue;
    const at = to;
    while (from > (last?.to ?? 0) && EMAIL_WORD.test(view[from - 1]!)) from--;
    while (to < view.length && EMAIL_WORD.test(view[to]!)) to++;
    const local = view.slice(from, m.index);
    if (!/[A-Za-z0-9]/.test(local) || !EMAIL_DOMAIN.test(view.slice(at))) {
      AT_SIGN.lastIndex = at;
      continue;
    }
    found.push({ from, to });
    AT_SIGN.lastIndex = to;
  }
  return found;
}

const IPV6_CANDIDATE = /(?<![0-9A-Za-z:])[0-9A-Fa-f:]{2,39}(?![0-9A-Za-z:])/g;
const IPV6_SHAPE = /^[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}$/;

function looksLikeIpv6(text: string): boolean {
  const colons = text.split(':').length - 1;
  return IPV6_SHAPE.test(text) && /[0-9A-Fa-f]/.test(text) && (text.includes('::') || colons === 7);
}

/** A long run of letters, digits, `+` and `=`; a short key and its `=` before it are kept. */
function findLongValue(view: string): Found[] {
  return all(/(?<![A-Za-z0-9+=])[A-Za-z0-9+=]{24,}/g, view).map(({ from, to }) => {
    const text = view.slice(from, to);
    const eq = text.indexOf('=');
    if (eq > 0 && eq < 24 && eq < text.length - 1 && text[eq + 1] !== '=') {
      return { from: from + eq + 1, to };
    }
    return { from, to };
  });
}

/** The shortest run of letters, digits, `-` and `_` that is looked at as a possible token. */
export const SAMPLE_TOKEN_RUN_MIN = 16;

const TOKEN_RUN = new RegExp(
  `(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{${SAMPLE_TOKEN_RUN_MIN},}(?![A-Za-z0-9_-])`,
  'g',
);

/** Vowels of a text, `y` counted with them. */
function vowelCount(text: string): number {
  let n = 0;
  for (const c of text) if ('aeiouyAEIOUY'.includes(c)) n++;
  return n;
}

/** The longest run of letters that are not vowels (`y` is a vowel here). */
function longestConsonantRun(text: string): number {
  let best = 0;
  let run = 0;
  for (const c of text) {
    if (/[A-Za-z]/.test(c) && !'aeiouyAEIOUY'.includes(c)) {
      run++;
      if (run > best) best = run;
    } else run = 0;
  }
  return best;
}

/** The most capitals an all-capital part, or the acronym at either end of a part, may have. */
const ACRONYM_MAX = 5;

/**
 * Whether one part of a run (the run split at `-` and `_`) reads as a name:
 *   - all digits (`2021`), or `v` or `x` and digits (`v2`, `x64`); or
 *   - letters, then digits or none (`ExchangeServer2019`), where the letters
 *     are all capitals of at most ACRONYM_MAX (`SEO`, `MSSQL`), or else read
 *     as words: capitals at most a third of the letters (an acronym of 2 to
 *     ACRONYM_MAX at the start or the end not counted: `PHPUnit`,
 *     `TinyMCE`), vowels (`y` counted) at least a fifth of them, and never
 *     more than four letters without a vowel in a row.
 */
function isNameLikePart(part: string): boolean {
  if (/^[0-9]+$/.test(part) || /^[vVxX][0-9]+$/.test(part)) return true;
  const letters = /^([A-Za-z]+)[0-9]*$/.exec(part)?.[1];
  if (letters === undefined) return false;
  const capitals = letters.replace(/[^A-Z]/g, '').length;
  if (capitals === letters.length) {
    if (letters.length <= ACRONYM_MAX) return true;
    return vowelCount(letters) * 4 >= letters.length && longestConsonantRun(letters) <= 4;
  }
  const lead = /^[A-Z]{2,3}(?=[A-Z][a-z]{3})/.exec(letters)?.[0].length ?? 0;
  const trail = /(?<=[a-z]{3})[A-Z]{2,3}$/.exec(letters)?.[0].length ?? 0;
  const acronym = Math.max(lead, trail);
  const counted = capitals - (acronym >= 2 && acronym <= ACRONYM_MAX ? acronym : 0);
  // Capitals together inside a part (not an acronym at its start or end) are a sign of a random value.
  const inner = letters.slice(lead, letters.length - trail);
  return (
    counted * 3 <= letters.length &&
    vowelCount(letters) * 5 >= letters.length &&
    longestConsonantRun(letters) <= 4 &&
    !/[A-Z]{2}/.test(inner.slice(1, -1))
  );
}

/**
 * Whether a run of letters, digits, `-` and `_` (one whole run, as TOKEN_RUN
 * finds it) is shaped like a token, such as this app's 22-character base64url
 * invite token, which the table's long-value rule lets through (it is under
 * 24 characters, and a `-` or `_` breaks a run). It is when the run is at
 * least SAMPLE_TOKEN_RUN_MIN long and, split at `-` and `_`, some part of four
 * characters or more does not read as a name (isNameLikePart). A `.` ends a
 * run, so each part of a dotted name is judged on its own. Measured on random
 * base64url values (see PROGRESS.md); the names it replaces and the names it
 * keeps are pinned in request-scrub.test.ts.
 */
export function looksLikeToken(run: string): boolean {
  if (run.length < SAMPLE_TOKEN_RUN_MIN) return false;
  return run.split(/[-_]+/).some((part) => part.length >= 4 && !isNameLikePart(part));
}

/** A standard base64 run: its alphabet, 32 characters or more, then up to two `=`. */
const BASE64_RUN = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/=])/g;

/**
 * Whether a BASE64_RUN with a `+` or a `/` in it is a value: split at them, some
 * part of four characters or more does not read as a name (isNameLikePart),
 * so a path in a query string (`/usr/local/share/applications`) is kept.
 */
function looksLikeBase64Value(run: string): boolean {
  if (!/[+/]/.test(run)) return false;
  return run
    .replace(/=+$/, '')
    .split(/[+/]+/)
    .some((part) => part.length >= 4 && !isNameLikePart(part));
}

/** The digits of a text. */
function countDigits(text: string): number {
  let n = 0;
  for (const ch of text) if (ch >= '0' && ch <= '9') n++;
  return n;
}

/**
 * The scrubber's rules, in the order they run over the decoded text. Each one
 * replaces what it finds with its marker. Exported for the tests (each rule's
 * cost on a long hostile text is pinned there).
 */
export const SCRUB_RULES: readonly ScrubRule[] = [
  {
    // A JWT: base64url parts with dots, the first one a JSON object's start.
    name: 'jwt',
    marker: SAMPLE_MARKERS.token,
    find: (view) =>
      all(/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}(?:\.[A-Za-z0-9_-]*)?/g, view),
  },
  {
    // Any three long base64url parts joined by dots.
    name: 'dotted_token',
    marker: SAMPLE_MARKERS.token,
    find: (view) =>
      all(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, view),
  },
  { name: 'email', marker: SAMPLE_MARKERS.email, find: findEmail },
  {
    // Any other `@` (the table refuses every one): `(at)` in its place, the words around it kept.
    name: 'at_sign',
    marker: SAMPLE_MARKERS.at,
    find: (view) => all(/@|%(?:25)*40/gi, view),
  },
  {
    name: 'id',
    marker: SAMPLE_MARKERS.id,
    find: (view) => all(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, view),
  },
  {
    name: 'ipv4',
    marker: SAMPLE_MARKERS.address,
    find: (view) => all(/[0-9]{1,3}(?:\.[0-9]{1,3}){3}/g, view),
  },
  {
    name: 'ipv6',
    marker: SAMPLE_MARKERS.address,
    find: (view) => all(IPV6_CANDIDATE, view, looksLikeIpv6),
  },
  {
    name: 'id_without_dashes',
    marker: SAMPLE_MARKERS.id,
    find: (view) => all(/(?<![0-9A-Fa-f])[0-9A-Fa-f]{32}(?![0-9A-Fa-f])/g, view),
  },
  {
    // In a query string only: a standard base64 value of 32 characters or
    // more with a `+` or `/` in it (which break every other run), judged part
    // by part between them as the token rule judges a run, and taken whole.
    // In a path a `/` separates segments, each judged on its own.
    name: 'base64_value',
    marker: SAMPLE_MARKERS.longValue,
    only: 'query',
    find: (view) => all(BASE64_RUN, view, looksLikeBase64Value),
  },
  {
    // A run shaped like a token (looksLikeToken), long or short, with `-` and `_` or without.
    name: 'token_shape',
    marker: SAMPLE_MARKERS.token,
    find: (view) => all(TOKEN_RUN, view, looksLikeToken),
  },
  { name: 'long_value', marker: SAMPLE_MARKERS.longValue, find: findLongValue },

  {
    name: 'digits',
    marker: SAMPLE_MARKERS.number,
    find: (view) => all(/[0-9]{6,}/g, view),
  },
  {
    // A phone number written with separators: groups of 2 to 4 digits, 9 digits or more.
    name: 'phone',
    marker: SAMPLE_MARKERS.number,
    find: (view) =>
      all(
        /(?<![0-9])\+?\(?[0-9]{2,4}\)?(?:[-. ]\(?[0-9]{2,4}\)?){2,5}(?![0-9])/g,
        view,
        (text) => countDigits(text) >= 9,
      ),
  },
];

/**
 * The table's own rules, run over the text as it will be KEPT (an escape's
 * own digits and letters count there, as they do in the database). What one
 * finds is replaced too, with the marker of its kind.
 */
const KEPT_TEXT_RULES: readonly ScrubRule[] = [
  { name: 'kept_at', marker: SAMPLE_MARKERS.at, find: (t) => all(/@|%(?:25)*40/g, t) },
  { name: 'kept_digits', marker: SAMPLE_MARKERS.number, find: (t) => all(/[0-9]{6,}/g, t) },
  {
    name: 'kept_ipv4',
    marker: SAMPLE_MARKERS.address,
    find: (t) => all(/[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/g, t),
  },
  {
    name: 'kept_long_value',
    marker: SAMPLE_MARKERS.longValue,
    find: (t) => all(/[A-Za-z0-9+=]{24,}/g, t),
  },
  {
    name: 'kept_id',
    marker: SAMPLE_MARKERS.id,
    find: (t) => all(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, t),
  },
  {
    name: 'kept_id_without_dashes',
    marker: SAMPLE_MARKERS.id,
    find: (t) => all(/[0-9a-f]{32,}/gi, t),
  },
];

/**
 * Replaces what `rule` finds in the pieces' text (their view, or what is kept)
 * with its marker. A find that covers part of a piece takes the whole piece.
 * True when anything was replaced.
 */
function applyRule(pieces: Piece[], rule: ScrubRule, side: 'view' | 'out'): boolean {
  let text = '';
  const owner: number[] = [];
  pieces.forEach((p, i) => {
    const s = side === 'view' ? p.view : p.out;
    text += s;
    for (let k = 0; k < s.length; k++) owner.push(i);
  });
  const found = rule.find(text);
  if (found.length === 0) return false;
  // Piece ranges, merged where two finds share a piece; replaced from the end.
  const ranges: Array<[number, number]> = [];
  for (const { from, to } of found) {
    if (to <= from) continue;
    const first = owner[from]!;
    const last = owner[to - 1]!;
    const prev = ranges[ranges.length - 1];
    if (prev && first <= prev[1]) prev[1] = Math.max(prev[1], last);
    else ranges.push([first, last]);
  }
  for (let r = ranges.length - 1; r >= 0; r--) {
    const [first, last] = ranges[r]!;
    pieces.splice(first, last - first + 1, markerPiece(rule.marker));
  }
  return ranges.length > 0;
}

/** Runs every rule, over the decoded text and over the kept text, until nothing changes. */
function applyTextRules(pieces: Piece[], where: 'target' | 'query'): void {
  for (let round = 0; round < 4; round++) {
    let changed = false;
    for (const rule of SCRUB_RULES) {
      if (rule.only === undefined || rule.only === where)
        changed = applyRule(pieces, rule, 'view') || changed;
    }
    for (const rule of KEPT_TEXT_RULES) changed = applyRule(pieces, rule, 'out') || changed;
    if (!changed) return;
  }
}

/** The view of a run of pieces, for reading a key. */
function viewText(pieces: readonly Piece[]): string {
  return pieces.map((p) => p.view).join('');
}

/** The literal separator `ch` at piece `p`. */
function isSeparator(p: Piece, chars: string): boolean {
  return p.literal && !p.marker && p.view.length === 1 && chars.includes(p.view);
}

/** A separator in `chars` at piece `p`, sent as itself or encoded (never a marker). */
function isDecodedSeparator(p: Piece, chars: string): boolean {
  return !p.marker && p.view.length === 1 && chars.includes(p.view);
}

/** How the key rule reads a text: split as a server splits it, or at decoded separators too. */
type Split = typeof isSeparator;

/** Splits [from, to) of `pieces` at the separators in `chars`: [start, end) ranges. */
function partsOf(
  pieces: readonly Piece[],
  from: number,
  to: number,
  chars: string,
  split: Split = isSeparator,
): Array<[number, number]> {
  const parts: Array<[number, number]> = [];
  let start = from;
  for (let i = from; i < to; i++) {
    if (split(pieces[i]!, chars)) {
      parts.push([start, i]);
      start = i + 1;
    }
  }
  parts.push([start, to]);
  return parts;
}

/**
 * The key rule over `key=value` parts: a secret-named key keeps its name and
 * loses its value. Returns the pieces with those values replaced. `bare`
 * decides what happens to a part with no `=`.
 */
function removeSecretValues(
  pieces: Piece[],
  parts: Array<[number, number]>,
  bare: (from: number, to: number) => boolean,
  split: Split = isSeparator,
): Piece[] {
  const replace: Array<[number, number]> = [];
  for (const [from, end] of parts) {
    // Three dots at the end of a part are not part of its value: they may be
    // the cut mark of an earlier scrub, and a second scrub must keep them.
    const to = endsInCutMark(pieces, from, end) ? end - SAMPLE_CUT_MARK.length : end;
    let eq = -1;
    for (let i = from; i < to; i++) {
      if (split(pieces[i]!, '=')) {
        eq = i;
        break;
      }
    }
    if (eq === -1) {
      if (to > from && bare(from, to)) replace.push([from, to]);
      continue;
    }
    if (eq + 1 < to && isSecretQueryKey(viewText(pieces.slice(from, eq))))
      replace.push([eq + 1, to]);
  }
  const out = pieces.slice();
  for (let r = replace.length - 1; r >= 0; r--) {
    const [from, to] = replace[r]!;
    out.splice(from, to - from, markerPiece(SAMPLE_MARKERS.removed));
  }
  return out;
}

function endsInCutMark(pieces: readonly Piece[], from: number, to: number): boolean {
  if (to - from < SAMPLE_CUT_MARK.length) return false;
  for (let i = to - SAMPLE_CUT_MARK.length; i < to; i++)
    if (!isSeparator(pieces[i]!, '.')) return false;
  return true;
}

/** The pieces' kept text cut to `max` characters on a piece boundary, ending in `...` when cut. */
function keptText(pieces: readonly Piece[], max: number, cut: boolean): string {
  const whole = pieces.map((p) => p.out).join('');
  if (!cut && whole.length <= max) return whole;
  let text = '';
  for (const p of pieces) {
    if (text.length + p.out.length > max - SAMPLE_CUT_MARK.length) break;
    text += p.out;
  }
  return text + SAMPLE_CUT_MARK;
}

// ── The two scrub functions ─────────────────────────────────────────────────

/**
 * The path of a request, scrubbed for keeping (design 2.2 as corrected by
 * review S2 and the 0479 contract): at most SAMPLE_TARGET_MAX printable ASCII
 * characters that always pass isStorableTarget. A path that cannot be decoded
 * is SAMPLE_UNREADABLE_TARGET.
 *
 * In order: the path is cut to SAMPLE_INPUT_MAX characters; a malformed
 * escape makes it unreadable; every rule in SCRUB_RULES runs over the decoded
 * text, and the table's own rules over the text as kept; the value of a
 * `;key=value` part of a segment whose key names a secret is removed (split
 * at literal separators, then at decoded ones too); the
 * result is cut to length with `...`. LAST, the result is checked with
 * isStorableTarget, and anything that still fails is SAMPLE_UNREADABLE_TARGET,
 * so the database never has to skip it.
 */
export function scrubRequestTarget(pathname: string): string {
  try {
    if (typeof pathname !== 'string') return SAMPLE_UNREADABLE_TARGET;
    const input = readable(pathname);
    if (input === null) return SAMPLE_UNREADABLE_TARGET;
    let pieces = unitsOf(input.text);
    applyTextRules(pieces, 'target');
    // `;key=value` parts of each segment: the key rule, as for a query. It
    // runs after the text rules, so a key reads the same here as it will in
    // the kept text (a marker in a key is part of its name).
    // Read twice: split as a server splits it, then at decoded `/`, `;` and
    // `=` too, so a `%3Bpassword%3D...` inside a segment loses its value.
    for (const split of [isSeparator, isDecodedSeparator]) {
      const params: Array<[number, number]> = [];
      for (const [from, to] of partsOf(pieces, 0, pieces.length, '/', split)) {
        params.push(...partsOf(pieces, from, to, ';', split).slice(1));
      }
      pieces = removeSecretValues(pieces, params, () => false, split);
    }
    const out = keptText(pieces, SAMPLE_TARGET_MAX, input.cut);
    return isStorableTarget(out) ? out : SAMPLE_UNREADABLE_TARGET;
  } catch {
    return SAMPLE_UNREADABLE_TARGET;
  }
}

/**
 * A query string (what follows the `?`), scrubbed for keeping (design 2.2 as
 * corrected by review S2 and the 0479 contract): null when there is none or
 * it cannot be decoded, otherwise at most SAMPLE_QUERY_MAX printable ASCII
 * characters that always pass isStorableSample.
 *
 * In order: cut to SAMPLE_INPUT_MAX characters; a malformed escape means no
 * sample; the text rules, as for a path; then the query is split at literal
 * `&` and `;`, and the value of each key that names a secret
 * (isSecretQueryKey) is removed whole, as is a part with no `=` of
 * SAMPLE_BARE_VALUE_MAX characters or more; then the key rule again with
 * decoded `&`, `;` and `=` splitting too; then the cut. LAST, the result is checked with isStorableSample,
 * and anything that still fails is the marker `<removed>`.
 */
export function scrubRequestSample(queryString: string | null | undefined): string | null {
  try {
    if (typeof queryString !== 'string' || queryString === '') return null;
    const input = readable(queryString);
    if (input === null) return null;
    let pieces = unitsOf(input.text);
    applyTextRules(pieces, 'query');
    // After the text rules, as for a path's `;key=value` parts. Split as a
    // server splits it (where the bare rule applies), then again at decoded
    // `&`, `;` and `=` too, so a value that is itself a query string
    // (`q=a%26token%3D...`) loses what a secret-named key inside it holds.
    const kept = pieces;
    pieces = removeSecretValues(
      kept,
      partsOf(kept, 0, kept.length, '&;'),
      (from, to) =>
        kept
          .slice(from, to)
          .map((p) => p.out)
          .join('').length >= SAMPLE_BARE_VALUE_MAX,
    );
    pieces = removeSecretValues(
      pieces,
      partsOf(pieces, 0, pieces.length, '&;', isDecodedSeparator),
      () => false,
      isDecodedSeparator,
    );
    const out = keptText(pieces, SAMPLE_QUERY_MAX, input.cut);
    if (out === '') return null;
    return isStorableSample(out) ? out : SAMPLE_MARKERS.removed;
  } catch {
    return SAMPLE_MARKERS.removed;
  }
}
