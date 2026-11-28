/**
 * Policy sign-off: the small text format a policy is written in, its normal
 * form, its limits and the one parser the website and the phone both render.
 *
 * THE FORMAT. A policy's body is plain text. After normalising (below):
 *   - a line that starts with "# " is a heading (the rest of the line);
 *   - a line that starts with "- " is a bullet (the rest of the line), and
 *     bullet lines in a row make one list;
 *   - any other line is part of a paragraph; lines in a row make one
 *     paragraph, which keeps its line breaks;
 *   - an empty line ends a paragraph or a list.
 * Nothing else means anything: "##", "*", "1.", "[x](y)", "<b>", "**" are
 * plain characters. The parser never fails; every text has one block list.
 *
 * RENDERING (the contract for the website and the phone): each block becomes
 * text nodes only. Never HTML from the text (no dangerouslySetInnerHTML, no
 * markdown renderer), never a link made from the text (no autolinking, no
 * Linking.openURL of anything in it), never an image. A heading is a heading
 * element (web h2/h3; phone Text with accessibilityRole "header"); a
 * paragraph is one text block whose lines are joined by line breaks; a list
 * is a list (web ul/li; phone rows with a bullet glyph that is not part of
 * the text). The title is shown as plain text above the blocks.
 *
 * THE NORMAL FORM (normalizePolicyBody, normalizePolicyTitle). The database
 * stores only text already in normal form and refuses anything else
 * (migration 0482, _org_policy_body_problem and _org_policy_title_problem),
 * so what is stored is what is shown and what is hashed. A raw text that is
 * refused before normalising (RUNS OF MARKS AND TIME, below) is returned as
 * it came, never normalised. Body, in order:
 *   1. Unicode NFC;
 *   2. CR LF and a lone CR become LF;
 *   3. each tab becomes one space;
 *   4. spaces (U+0020) at the end of each line are removed;
 *   5. three or more line feeds in a row become two (one empty line);
 *   6. line feeds at the start and the end are removed;
 *   7. Unicode NFC again (a no-op, so the result is NFC by construction).
 * Title: NFC; every run of CR, LF, tab and space becomes one space; spaces at
 * both ends removed; NFC again.
 * Normalising is idempotent: the normal form of a normal form is itself.
 *
 * LIMITS. Counted in Unicode code points (Postgres char_length): a title 1 to
 * 120, a body 1 to 30,000 and at most 600 lines (599 line feeds), and in
 * either at most 30 combining marks in a row (POLICY_MARK_RUN_MAX, the
 * stream-safe limit of UAX #15, which no written language comes near; more is
 * too_many_marks: the text holds characters that cannot be shown).
 * Characters that are refused, even in normal form
 * (FORBIDDEN_POLICY_CODE_POINTS): control characters other than the line
 * feed (the tab is one; normalising turns it into a space), the soft hyphen,
 * the invisible and direction-changing format characters (zero-width
 * characters, bidirectional marks, embeddings, overrides and isolates, the
 * line and paragraph separators, word joiners), the byte order mark, the
 * interlinear annotation and replacement characters and U+FFFE/U+FFFF, the
 * tag characters and the supplementary variation selectors (used to hide
 * text), and in JavaScript a lone surrogate (it has no UTF-8 form). So the
 * words a member sees cannot be reordered or hidden by an invisible character.
 *
 * RUNS OF MARKS AND TIME. Every function here runs in time linear in the
 * text's length, on any input, a stored text included (no regular expression
 * that can backtrack over a run: line ends and the ends of the text are
 * trimmed with loops; policy-text.time.test.ts holds it). Unicode
 * normalisation is the one step that is not linear by itself: it puts
 * combining marks that are out of order back in order with an insertion sort,
 * so a long run of them costs the square of its length in every engine
 * (review 2026-11-27, M2: 30,000 characters 651 ms, 240,000 characters 41.6 s).
 * So nothing here normalises a run of more than POLICY_MARK_RUN_MAX marks or
 * an oversized text:
 *   - the writers' side checks the raw text FIRST, without normalising it: more
 *     than POLICY_TITLE_RAW_MAX or POLICY_BODY_RAW_MAX code points is too_long,
 *     a run of more than 30 marks is too_many_marks (preparePolicyTitle,
 *     preparePolicyBody; normalizePolicyTitle and normalizePolicyBody return
 *     such a text unchanged, and the Problem functions refuse it);
 *   - the reader (parsePolicyText) shows each run of more than 30 marks as one
 *     U+FFFD and normalises the rest, so no stored body can hold a server's or
 *     a phone's thread;
 *   - the hash (policy-hash.ts) never normalises.
 * A code point counts as a mark when it is in POLICY_COMBINING_MARK_RANGES
 * (every mark of Unicode 17.0: the database's list, the same ranges) or when
 * this engine's own tables call it a mark or unassigned (\p{M}, \p{Cn}). A
 * character's canonical combining class never changes once it is assigned, so
 * a code point that a newer normaliser reorders was unassigned in every older
 * table: the three together hold every code point any engine's normaliser can
 * reorder, whichever Unicode versions its regular expressions and its
 * normaliser have (policy-text.marks.test.ts checks this engine, code point by
 * code point). The database counts its list only: a run of more than 30 code
 * points that only the engine counts (unassigned in Unicode 17.0) is refused
 * here and accepted there, so a stored text holds one only when it was written
 * around the website's check, and the reader shows it as one U+FFFD.
 *
 * PURE: no I/O, no clock, no platform imports.
 */

/* ───────────────────────────── kinds, states, limits ───────────────────────────── */

/** The kinds of policy (the database's org_policies_kind check). */
export const POLICY_KINDS = ['acceptable_use', 'data_handling', 'other'] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];

/** A policy's state (org_policies_status): never published, in force, retired. */
export const POLICY_STATUSES = ['draft', 'published', 'retired'] as const;
export type PolicyStatus = (typeof POLICY_STATUSES)[number];

/**
 * How a published policy changes: "new_version" asks every member again;
 * "correction" (a typo, a broken sentence) asks nobody again, and the
 * acknowledgements of the version it corrects still count.
 */
export const POLICY_CHANGES = ['new_version', 'correction'] as const;
export type PolicyChange = (typeof POLICY_CHANGES)[number];

/** Where an acknowledgement was given (org_policy_acknowledgements_method). */
export const POLICY_ACK_METHODS = ['web', 'phone'] as const;
export type PolicyAckMethod = (typeof POLICY_ACK_METHODS)[number];

export const POLICY_TITLE_MAX = 120;
export const POLICY_BODY_MAX = 30000;
/** The most lines a body may have (the database's too_many_lines). */
export const POLICY_BODY_MAX_LINES = 600;
/** The most combining marks in a row a title or a body may hold (the database's too_many_marks). */
export const POLICY_MARK_RUN_MAX = 30;
/**
 * The most code points a posted title or body may have BEFORE it is normalised:
 * the limit and a margin (a title's runs of spaces; a body's CR LF line ends,
 * spaces at line ends, decomposed accents). Longer is refused as too_long
 * without normalising it.
 */
export const POLICY_TITLE_RAW_MAX = 240;
export const POLICY_BODY_RAW_MAX = 32000;

export function isPolicyKind(value: unknown): value is PolicyKind {
  return typeof value === 'string' && (POLICY_KINDS as readonly string[]).includes(value);
}
export function isPolicyStatus(value: unknown): value is PolicyStatus {
  return typeof value === 'string' && (POLICY_STATUSES as readonly string[]).includes(value);
}
export function isPolicyChange(value: unknown): value is PolicyChange {
  return typeof value === 'string' && (POLICY_CHANGES as readonly string[]).includes(value);
}
export function isPolicyAckMethod(value: unknown): value is PolicyAckMethod {
  return typeof value === 'string' && (POLICY_ACK_METHODS as readonly string[]).includes(value);
}

/* ───────────────────────────── refused characters ───────────────────────────── */

/**
 * The refused code points, as inclusive ranges. The database's rule is the
 * same list (0482, _org_policy_forbidden_re); policy-text.parity.test.ts
 * reads the migration and compares them.
 */
export const FORBIDDEN_POLICY_CODE_POINTS: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x0009], // NUL to TAB
  [0x000b, 0x001f], // VT to US (LF, 0x000A, is allowed)
  [0x007f, 0x009f], // DEL and the C1 controls
  [0x00ad, 0x00ad], // soft hyphen
  [0x061c, 0x061c], // Arabic letter mark
  [0x180e, 0x180e], // Mongolian vowel separator
  [0x200b, 0x200f], // zero-width space, non-joiner, joiner, LRM, RLM
  [0x2028, 0x202e], // line and paragraph separators, embeddings and overrides
  [0x2060, 0x2064], // word joiner and the invisible operators
  [0x2066, 0x206f], // isolates and the deprecated format characters
  [0xfeff, 0xfeff], // byte order mark, zero-width no-break space
  [0xfff9, 0xffff], // interlinear annotation, object replacement, replacement, U+FFFE, U+FFFF
  [0xe0000, 0xe007f], // tag characters
  [0xe0100, 0xe01ef], // supplementary variation selectors
];

function isForbiddenCodePoint(cp: number): boolean {
  if (cp >= 0xd800 && cp <= 0xdfff) return true; // a lone surrogate
  for (const [lo, hi] of FORBIDDEN_POLICY_CODE_POINTS) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

/** The first refused character of `text` (its code point and its index in code points), or null. */
export function findForbiddenPolicyCharacter(
  text: string,
): { codePoint: number; index: number } | null {
  let index = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (isForbiddenCodePoint(cp)) return { codePoint: cp, index };
    index += 1;
  }
  return null;
}

/** Code points, as Postgres char_length counts them (a lone surrogate counts as one). */
export function policyTextLength(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

/** Lines, as the database counts them: one more than the line feeds. */
export function policyLineCount(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 0x0a) n += 1;
  return n;
}

/** `line` without the spaces (U+0020) at its end. A loop: / +$/ is quadratic on a run of spaces. */
function trimEndSpaces(line: string): string {
  let e = line.length;
  while (e > 0 && line.charCodeAt(e - 1) === 0x20) e -= 1;
  return e === line.length ? line : line.slice(0, e);
}

/** `s` without line feeds at either end (loops, for the same reason). */
function trimLineFeeds(s: string): string {
  let b = 0;
  let e = s.length;
  while (b < e && s.charCodeAt(b) === 0x0a) b += 1;
  while (e > b && s.charCodeAt(e - 1) === 0x0a) e -= 1;
  return b === 0 && e === s.length ? s : s.slice(b, e);
}

/* ───────────────────────────── runs of combining marks ───────────────────────────── */

/**
 * Every combining mark of Unicode 17.0 (General_Category Mn, Mc and Me), as
 * inclusive ranges in hex: the five combining blocks (U+0300 to U+036F, U+1AB0
 * to U+1AFF, U+1DC0 to U+1DFF, U+20D0 to U+20FF, U+FE20 to U+FE2F: their
 * assigned part) and every script's own marks. Made from the Unicode data, not
 * picked by hand. The database's rule names the same ranges (0482,
 * _org_policy_title_problem and _org_policy_body_problem);
 * policy-text.parity.test.ts compares them and policy-text.marks.test.ts
 * checks them against this engine's tables.
 */
const COMBINING_MARKS_UNICODE_17 = `
0300-036F 0483-0489 0591-05BD 05BF 05C1-05C2 05C4-05C5 05C7 0610-061A 064B-065F 0670 06D6-06DC
06DF-06E4 06E7-06E8 06EA-06ED 0711 0730-074A 07A6-07B0 07EB-07F3 07FD 0816-0819 081B-0823
0825-0827 0829-082D 0859-085B 0897-089F 08CA-08E1 08E3-0903 093A-093C 093E-094F 0951-0957
0962-0963 0981-0983 09BC 09BE-09C4 09C7-09C8 09CB-09CD 09D7 09E2-09E3 09FE 0A01-0A03 0A3C
0A3E-0A42 0A47-0A48 0A4B-0A4D 0A51 0A70-0A71 0A75 0A81-0A83 0ABC 0ABE-0AC5 0AC7-0AC9 0ACB-0ACD
0AE2-0AE3 0AFA-0AFF 0B01-0B03 0B3C 0B3E-0B44 0B47-0B48 0B4B-0B4D 0B55-0B57 0B62-0B63 0B82
0BBE-0BC2 0BC6-0BC8 0BCA-0BCD 0BD7 0C00-0C04 0C3C 0C3E-0C44 0C46-0C48 0C4A-0C4D 0C55-0C56
0C62-0C63 0C81-0C83 0CBC 0CBE-0CC4 0CC6-0CC8 0CCA-0CCD 0CD5-0CD6 0CE2-0CE3 0CF3 0D00-0D03
0D3B-0D3C 0D3E-0D44 0D46-0D48 0D4A-0D4D 0D57 0D62-0D63 0D81-0D83 0DCA 0DCF-0DD4 0DD6 0DD8-0DDF
0DF2-0DF3 0E31 0E34-0E3A 0E47-0E4E 0EB1 0EB4-0EBC 0EC8-0ECE 0F18-0F19 0F35 0F37 0F39 0F3E-0F3F
0F71-0F84 0F86-0F87 0F8D-0F97 0F99-0FBC 0FC6 102B-103E 1056-1059 105E-1060 1062-1064 1067-106D
1071-1074 1082-108D 108F 109A-109D 135D-135F 1712-1715 1732-1734 1752-1753 1772-1773 17B4-17D3
17DD 180B-180D 180F 1885-1886 18A9 1920-192B 1930-193B 1A17-1A1B 1A55-1A5E 1A60-1A7C 1A7F
1AB0-1ADD 1AE0-1AEB 1B00-1B04 1B34-1B44 1B6B-1B73 1B80-1B82 1BA1-1BAD 1BE6-1BF3 1C24-1C37
1CD0-1CD2 1CD4-1CE8 1CED 1CF4 1CF7-1CF9 1DC0-1DFF 20D0-20F0 2CEF-2CF1 2D7F 2DE0-2DFF 302A-302F
3099-309A A66F-A672 A674-A67D A69E-A69F A6F0-A6F1 A802 A806 A80B A823-A827 A82C A880-A881
A8B4-A8C5 A8E0-A8F1 A8FF A926-A92D A947-A953 A980-A983 A9B3-A9C0 A9E5 AA29-AA36 AA43 AA4C-AA4D
AA7B-AA7D AAB0 AAB2-AAB4 AAB7-AAB8 AABE-AABF AAC1 AAEB-AAEF AAF5-AAF6 ABE3-ABEA ABEC-ABED FB1E
FE00-FE0F FE20-FE2F 101FD 102E0 10376-1037A 10A01-10A03 10A05-10A06 10A0C-10A0F 10A38-10A3A 10A3F
10AE5-10AE6 10D24-10D27 10D69-10D6D 10EAB-10EAC 10EFA-10EFF 10F46-10F50 10F82-10F85 11000-11002
11038-11046 11070 11073-11074 1107F-11082 110B0-110BA 110C2 11100-11102 11127-11134 11145-11146
11173 11180-11182 111B3-111C0 111C9-111CC 111CE-111CF 1122C-11237 1123E 11241 112DF-112EA
11300-11303 1133B-1133C 1133E-11344 11347-11348 1134B-1134D 11357 11362-11363 11366-1136C
11370-11374 113B8-113C0 113C2 113C5 113C7-113CA 113CC-113D0 113D2 113E1-113E2 11435-11446 1145E
114B0-114C3 115AF-115B5 115B8-115C0 115DC-115DD 11630-11640 116AB-116B7 1171D-1172B 1182C-1183A
11930-11935 11937-11938 1193B-1193E 11940 11942-11943 119D1-119D7 119DA-119E0 119E4 11A01-11A0A
11A33-11A39 11A3B-11A3E 11A47 11A51-11A5B 11A8A-11A99 11B60-11B67 11C2F-11C36 11C38-11C3F
11C92-11CA7 11CA9-11CB6 11D31-11D36 11D3A 11D3C-11D3D 11D3F-11D45 11D47 11D8A-11D8E 11D90-11D91
11D93-11D97 11EF3-11EF6 11F00-11F01 11F03 11F34-11F3A 11F3E-11F42 11F5A 13440 13447-13455
1611E-1612F 16AF0-16AF4 16B30-16B36 16F4F 16F51-16F87 16F8F-16F92 16FE4 16FF0-16FF1 1BC9D-1BC9E
1CF00-1CF2D 1CF30-1CF46 1D165-1D169 1D16D-1D172 1D17B-1D182 1D185-1D18B 1D1AA-1D1AD 1D242-1D244
1DA00-1DA36 1DA3B-1DA6C 1DA75 1DA84 1DA9B-1DA9F 1DAA1-1DAAF 1E000-1E006 1E008-1E018 1E01B-1E021
1E023-1E024 1E026-1E02A 1E08F 1E130-1E136 1E2AE 1E2EC-1E2EF 1E4EC-1E4EF 1E5EE-1E5EF 1E6E3 1E6E6
1E6EE-1E6EF 1E6F5 1E8D0-1E8D6 1E944-1E94A E0100-E01EF
`;

function parseRanges(text: string): Array<readonly [number, number]> {
  return text
    .trim()
    .split(/\s+/)
    .map((token) => {
      const [lo, hi] = token.split('-');
      const a = parseInt(lo!, 16);
      return [a, hi === undefined ? a : parseInt(hi, 16)] as const;
    });
}

/** The combining marks the database counts, as inclusive ranges (see COMBINING_MARKS_UNICODE_17). */
export const POLICY_COMBINING_MARK_RANGES: ReadonlyArray<readonly [number, number]> = parseRanges(
  COMBINING_MARKS_UNICODE_17,
);

const MARK_LO = Int32Array.from(POLICY_COMBINING_MARK_RANGES, ([lo]) => lo);
const MARK_HI = Int32Array.from(POLICY_COMBINING_MARK_RANGES, ([, hi]) => hi);

function inMarkList(cp: number): boolean {
  let a = 0;
  let b = MARK_LO.length - 1;
  while (a <= b) {
    const m = (a + b) >> 1;
    if (cp < MARK_LO[m]!) b = m - 1;
    else if (cp > MARK_HI[m]!) a = m + 1;
    else return true;
  }
  return false;
}

/**
 * This engine's own marks and unassigned code points, from its own tables
 * (made at run time, so no build step rewrites it). Null when the engine
 * cannot name them: the list alone counts then.
 */
const ENGINE_MARK_OR_UNASSIGNED: RegExp | null = (() => {
  for (const source of ['[\\p{M}\\p{Cn}]', '\\p{M}']) {
    try {
      return new RegExp(source, 'u');
    } catch {
      // This engine cannot name the property; try the next, then none.
    }
  }
  return null;
})();

/** Whether a code point (`ch` is the same code point as a string) counts toward a run of marks. */
function countsAsMark(cp: number, ch: string): boolean {
  // Below U+0300 every code point is assigned and none is a mark (policy-text.marks.test.ts).
  if (cp < 0x0300) return false;
  if (inMarkList(cp)) return true;
  return ENGINE_MARK_OR_UNASSIGNED !== null && ENGINE_MARK_OR_UNASSIGNED.test(ch);
}

/**
 * The first run of more than POLICY_MARK_RUN_MAX marks in a row in `text`
 * (counted as the header says): where it starts and how long it is, in code
 * points; or null. One pass; it never normalises.
 */
export function findPolicyMarkRun(text: string): { index: number; length: number } | null {
  let index = 0;
  let start = 0;
  let run = 0;
  for (const ch of text) {
    if (countsAsMark(ch.codePointAt(0)!, ch)) {
      if (run === 0) start = index;
      run += 1;
    } else if (run > POLICY_MARK_RUN_MAX) {
      return { index: start, length: run };
    } else {
      run = 0;
    }
    index += 1;
  }
  return run > POLICY_MARK_RUN_MAX ? { index: start, length: run } : null;
}

/** `text` with each run of more than POLICY_MARK_RUN_MAX marks shown as one U+FFFD (the reader's guard). One pass. */
function showLongMarkRunsAsReplacement(text: string): string {
  const parts: string[] = [];
  let copied = 0;
  let runStart = 0;
  let run = 0;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;
    if (countsAsMark(cp, text.slice(i, i + width))) {
      if (run === 0) runStart = i;
      run += 1;
    } else {
      if (run > POLICY_MARK_RUN_MAX) {
        parts.push(text.slice(copied, runStart), '\uFFFD');
        copied = i;
      }
      run = 0;
    }
    i += width;
  }
  if (run > POLICY_MARK_RUN_MAX) {
    parts.push(text.slice(copied, runStart), '\uFFFD');
    copied = text.length;
  }
  if (parts.length === 0) return text;
  parts.push(text.slice(copied));
  return parts.join('');
}

/** Whether `text` has more than `max` code points; it counts only when the UTF-16 length cannot tell. */
function longerThan(text: string, max: number): boolean {
  if (text.length <= max) return false; // a code point is at least one UTF-16 unit
  if (text.length > 2 * max) return true; // and at most two
  return policyTextLength(text) > max;
}

/** Why a raw text is refused before it may be normalised, or null. */
function rawProblem(raw: string, rawMax: number): 'too_long' | 'too_many_marks' | null {
  if (longerThan(raw, rawMax)) return 'too_long';
  if (findPolicyMarkRun(raw)) return 'too_many_marks';
  return null;
}

/* ───────────────────────────── the normal form ───────────────────────────── */

/**
 * Steps 1 to 7 of a body's normal form. Called only on a text with no run of
 * more than POLICY_MARK_RUN_MAX marks. The regular expressions left
 * (/\r\n?/g, /\t/g, /\n{3,}/g) each match a fixed character or one run, so
 * none backtracks.
 */
function bodySteps(s: string): string {
  const t = s
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .split('\n')
    .map(trimEndSpaces)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return trimLineFeeds(t).normalize('NFC');
}

/** A title's normal form, for a text with no run of more than POLICY_MARK_RUN_MAX marks. */
function titleSteps(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[\r\n\t ]+/g, ' ')
    .replace(/^ /, '')
    .replace(/ $/, '')
    .normalize('NFC');
}

/**
 * The normal form of a body (steps 1 to 7 in the header). A raw body over
 * POLICY_BODY_RAW_MAX code points, or with a run of more than
 * POLICY_MARK_RUN_MAX marks, is returned as it came, never normalised
 * (policyBodyProblem then refuses it).
 */
export function normalizePolicyBody(raw: string): string {
  return rawProblem(raw, POLICY_BODY_RAW_MAX) === null ? bodySteps(raw) : raw;
}

/**
 * The normal form of a title: one line, single spaces, trimmed. A raw title
 * over POLICY_TITLE_RAW_MAX code points, or with a run of more than
 * POLICY_MARK_RUN_MAX marks, is returned as it came, never normalised.
 */
export function normalizePolicyTitle(raw: string): string {
  return rawProblem(raw, POLICY_TITLE_RAW_MAX) === null ? titleSteps(raw) : raw;
}

/** Why a stored text would be refused: the same words as the database's detail. */
export type PolicyTextProblem =
  | 'empty'
  | 'too_long'
  | 'too_many_lines'
  | 'forbidden_character'
  | 'too_many_marks'
  | 'not_normal_form';

/**
 * Why the database would refuse this title (hint policy_title_invalid, the
 * word in its detail), or null. It checks the text as given: normalise first
 * (preparePolicyTitle does both). The same order as the database.
 */
export function policyTitleProblem(title: string): PolicyTextProblem | null {
  if (title.length === 0) return 'empty';
  if (longerThan(title, POLICY_TITLE_MAX)) return 'too_long';
  if (findForbiddenPolicyCharacter(title)) return 'forbidden_character';
  if (findPolicyMarkRun(title)) return 'too_many_marks';
  if (titleSteps(title) !== title) return 'not_normal_form';
  return null;
}

/** Why the database would refuse this body (hint policy_body_invalid), or null. The same order as the database. */
export function policyBodyProblem(body: string): PolicyTextProblem | null {
  if (body.length === 0) return 'empty';
  if (longerThan(body, POLICY_BODY_MAX)) return 'too_long';
  if (policyLineCount(body) > POLICY_BODY_MAX_LINES) return 'too_many_lines';
  if (findForbiddenPolicyCharacter(body)) return 'forbidden_character';
  if (findPolicyMarkRun(body)) return 'too_many_marks';
  if (bodySteps(body) !== body) return 'not_normal_form';
  return null;
}

/**
 * A posted title made ready to save: its normal form and why the database
 * would refuse it (null: send it). The raw size and the runs of marks are
 * checked FIRST, without normalising; a title refused there comes back as it
 * was posted. Then the normal form is made and checked. The server action
 * calls this on the posted title before anything else touches it.
 */
export function preparePolicyTitle(raw: string): {
  title: string;
  problem: PolicyTextProblem | null;
} {
  const early = rawProblem(raw, POLICY_TITLE_RAW_MAX);
  if (early !== null) return { title: raw, problem: early };
  const title = titleSteps(raw);
  return { title, problem: policyTitleProblem(title) };
}

/** A posted body made ready to save, as preparePolicyTitle (POLICY_BODY_RAW_MAX). */
export function preparePolicyBody(raw: string): {
  body: string;
  problem: PolicyTextProblem | null;
} {
  const early = rawProblem(raw, POLICY_BODY_RAW_MAX);
  if (early !== null) return { body: raw, problem: early };
  const body = bodySteps(raw);
  return { body, problem: policyBodyProblem(body) };
}

/* ───────────────────────────── the parser ───────────────────────────── */

export type PolicyBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'bullets'; items: string[] };

/**
 * The blocks of a body. Each run of more than POLICY_MARK_RUN_MAX marks is
 * shown as one U+FFFD (never normalised), then the text is normalised, whatever
 * its size (a stored body is already in normal form and holds no such run,
 * unless it was written around the website's check, so this changes nothing
 * for it). Never throws; linear in the text's length.
 */
export function parsePolicyText(body: string): PolicyBlock[] {
  const lines = bodySteps(showLongMarkRunsAsReplacement(body)).split('\n');
  const blocks: PolicyBlock[] = [];
  let paragraph: string[] | null = null;
  let bullets: string[] | null = null;
  const close = () => {
    if (paragraph) blocks.push({ kind: 'paragraph', lines: paragraph });
    if (bullets) blocks.push({ kind: 'bullets', items: bullets });
    paragraph = null;
    bullets = null;
  };
  for (const line of lines) {
    if (line === '') {
      close();
    } else if (line.startsWith('# ')) {
      close();
      blocks.push({ kind: 'heading', text: line.slice(2) });
    } else if (line.startsWith('- ')) {
      if (paragraph) close();
      bullets = bullets ?? [];
      bullets.push(line.slice(2));
    } else {
      if (bullets) close();
      paragraph = paragraph ?? [];
      paragraph.push(line);
    }
  }
  close();
  return blocks;
}

/**
 * The blocks as plain text, for a place that cannot show structure (an email's
 * text part, a screen reader summary): headings and paragraphs as they are,
 * bullets with "- ", blocks separated by an empty line. Reading it again
 * gives the same blocks.
 */
export function policyBlocksToText(blocks: readonly PolicyBlock[]): string {
  return blocks
    .map((b) =>
      b.kind === 'heading'
        ? `# ${b.text}`
        : b.kind === 'paragraph'
          ? b.lines.join('\n')
          : b.items.map((i) => `- ${i}`).join('\n'),
    )
    .join('\n\n');
}
