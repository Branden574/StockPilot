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
 * so what is stored is what is shown and what is hashed. Body, in order:
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
 * 120, a body 1 to 30,000 and at most 600 lines (599 line feeds). Characters that are refused, even in normal form
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
 * TIME. Every function here runs in time linear in the text's length (no
 * regular expression that can backtrack over a run: line ends and the ends of
 * the text are trimmed with loops). policy-text.time.test.ts holds it.
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

/* ───────────────────────────── the normal form ───────────────────────────── */

/**
 * The normal form of a body (steps 1 to 7 in the header). The regular
 * expressions left (/\r\n?/g, /\t/g, /\n{3,}/g) each match a fixed character
 * or one run, so none backtracks.
 */
export function normalizePolicyBody(raw: string): string {
  const s = raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .split('\n')
    .map(trimEndSpaces)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return trimLineFeeds(s).normalize('NFC');
}

/** The normal form of a title: one line, single spaces, trimmed. */
export function normalizePolicyTitle(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/[\r\n\t ]+/g, ' ')
    .replace(/^ /, '')
    .replace(/ $/, '')
    .normalize('NFC');
}

/** Why a stored text would be refused: the same words as the database's detail. */
export type PolicyTextProblem =
  'empty' | 'too_long' | 'too_many_lines' | 'forbidden_character' | 'not_normal_form';

/**
 * Why the database would refuse this title (hint policy_title_invalid, the
 * word in its detail), or null. It checks the text as given: normalise first.
 */
export function policyTitleProblem(title: string): PolicyTextProblem | null {
  if (title.length === 0) return 'empty';
  if (policyTextLength(title) > POLICY_TITLE_MAX) return 'too_long';
  if (findForbiddenPolicyCharacter(title)) return 'forbidden_character';
  if (normalizePolicyTitle(title) !== title) return 'not_normal_form';
  return null;
}

/** Why the database would refuse this body (hint policy_body_invalid), or null. */
export function policyBodyProblem(body: string): PolicyTextProblem | null {
  if (body.length === 0) return 'empty';
  if (policyTextLength(body) > POLICY_BODY_MAX) return 'too_long';
  if (policyLineCount(body) > POLICY_BODY_MAX_LINES) return 'too_many_lines';
  if (findForbiddenPolicyCharacter(body)) return 'forbidden_character';
  if (normalizePolicyBody(body) !== body) return 'not_normal_form';
  return null;
}

/* ───────────────────────────── the parser ───────────────────────────── */

export type PolicyBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'bullets'; items: string[] };

/**
 * The blocks of a body. The text is normalised first (a stored body is
 * already in normal form, so this changes nothing for it). Never throws.
 */
export function parsePolicyText(body: string): PolicyBlock[] {
  const lines = normalizePolicyBody(body).split('\n');
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
