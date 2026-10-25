import 'server-only';

import type { ExtractedPo } from './extract';

type ExtractedLine = ExtractedPo['lines'][number];

/**
 * Apparel size words a vendor prints, to the size token the size-run grouping
 * reads at the end of a name (`sizeRunStyleKey` / `extractSize` in
 * @stockpilot/core inventory/size-run.ts, whose alternation is XS..6XL).
 *
 * Keyed by the word lower-cased with hyphens and runs of spaces folded to one
 * space, so "X-Large", "x large" and "X  LARGE" are one key. Deliberately
 * adult alpha sizes only: "Youth Small" or a shoe's "10.5" is a different size
 * system, and folding it into an adult run would group two products as one.
 * apparel-names.test.ts checks that every token here reads back through the
 * core helpers. Read it through sizeTokenOf, never by indexing it with a word
 * from a document (see SIZE_TOKEN_BY_WORD).
 */
export const APPAREL_SIZE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  xs: 'XS',
  'x small': 'XS',
  xsmall: 'XS',
  'extra small': 'XS',
  s: 'S',
  sm: 'S',
  small: 'S',
  m: 'M',
  md: 'M',
  med: 'M',
  medium: 'M',
  l: 'L',
  lg: 'L',
  large: 'L',
  xl: 'XL',
  'x large': 'XL',
  xlarge: 'XL',
  'extra large': 'XL',
  xxl: '2XL',
  '2xl': '2XL',
  '2x': '2XL',
  'xx large': '2XL',
  '2x large': '2XL',
  '2xlarge': '2XL',
  xxxl: '3XL',
  '3xl': '3XL',
  '3x': '3XL',
  'xxx large': '3XL',
  '3x large': '3XL',
  '3xlarge': '3XL',
  xxxxl: '4XL',
  '4xl': '4XL',
  '4x': '4XL',
  '4x large': '4XL',
  '5xl': '5XL',
  '5x': '5XL',
  '5x large': '5XL',
  '6xl': '6XL',
  '6x': '6XL',
  '6x large': '6XL',
});

/** The tokens the size-run grouping reads (core size-run.ts, XS..6XL). */
const SIZE_TOKENS: ReadonlySet<string> = new Set([
  'XS',
  'S',
  'M',
  'L',
  'XL',
  '2XL',
  '3XL',
  '4XL',
  '5XL',
  '6XL',
]);

/** APPAREL_SIZE_WORDS as a Map, so a lookup reads the table's own words only.
 *  Indexing the object with a part of a scanned name read inherited members:
 *  "constructor" and "__proto__" came back as a function and an object, which
 *  counted as a size and ended the name in "function Object() { [native
 *  code] }" or "[object Object]". */
const SIZE_TOKEN_BY_WORD: ReadonlyMap<string, string> = new Map(Object.entries(APPAREL_SIZE_WORDS));

/** "<count> - " or "<count>: " at the very start of a description. A dash or a
 *  colon only: "3 Ring Binder" and "2 x 4 Lumber" start with numbers that are
 *  part of the name. */
const LEADING_COUNT = /^\s*(\d{1,6})\s*[-–—:]\s*/;

/** Where one part of a printed name ends and the next begins: a colon (spaces
 *  optional), or a dash, en dash, em dash or bar with a space on BOTH sides.
 *  A hyphen inside a word ("T-Shirt", "X-Large") never splits. The capture
 *  group keeps the separators in String.split's output. */
const PART_SEPARATOR = /(\s*:\s*|\s+[-–—|]\s+)/;

function sizeTokenOf(part: string): string | null {
  const key = part
    .toLowerCase()
    .replace(/[\s-]+/g, ' ')
    .trim()
    .replace(/^size /, '');
  const token = SIZE_TOKEN_BY_WORD.get(key);
  return token !== undefined && SIZE_TOKENS.has(token) ? token : null;
}

/**
 * A scanned line's description, made into a name the size-run grouping can
 * read: a leading count that is the line's own quantity is dropped, and an
 * apparel size printed as its own part of the name moves to the end as its
 * token ("25 - Small : Carolina Blue" -> "Carolina Blue - S").
 *
 * WHY. Some vendor invoices (seen 2026-08-20) print each size of
 * a garment as "<qty> - <size> : <colour>". The scan kept that verbatim as the
 * item's name, so the sizes of one shirt never grouped (sizeRunStyleKey only
 * reads a TRAILING size) and every order of the same shirt carried a different
 * count in its name. Until now the fix was renaming every item by hand before
 * receiving.
 *
 * CONSERVATIVE BY DESIGN: the count goes only when it equals the quantity the
 * line orders; the size moves only when it is a whole part of the name (not a
 * word inside a phrase such as "Large Format Paper"), when it is the only size
 * in the name, and when something other than the size is left. Anything else
 * returns the description as it was.
 */
export function normalizeApparelName(description: string, quantity: number): string {
  const original = description.trim();
  let name = original;

  const count = LEADING_COUNT.exec(name);
  if (count && quantity > 0 && Number(count[1]) === quantity) {
    const rest = name.slice(count[0].length).trim();
    if (rest) name = rest;
  }

  // [part, separator, part, separator, part, ...]
  const pieces = name.split(PART_SEPARATOR);
  const parts = pieces.filter((_, i) => i % 2 === 0).map((p) => p.trim());
  const separators = pieces.filter((_, i) => i % 2 === 1);
  const sized = parts.flatMap((p, i) => (sizeTokenOf(p) ? [i] : []));
  if (sized.length !== 1) return name;
  const at = sized[0]!;
  const token = sizeTokenOf(parts[at]!)!;

  // A "Size" label printed as its own part ("Size: Large") goes with it.
  const from = at > 0 && parts[at - 1]!.toLowerCase() === 'size' ? at - 1 : at;
  const keptParts = [...parts.slice(0, from), ...parts.slice(at + 1)];
  // Drop the separators that touched the removed parts: the ones before them,
  // or the ones after them when they opened the name.
  const keptSeparators =
    from > 0
      ? [...separators.slice(0, from - 1), ...separators.slice(at)]
      : separators.slice(at + 1);
  const base = keptParts
    .map((p, i) => p + (i < keptParts.length - 1 ? (keptSeparators[i] ?? ' - ') : ''))
    .join('')
    .replace(/[\s,:|–—-]+$/, '')
    .trim();
  if (!base) return original;
  return `${base} - ${token}`;
}

/**
 * Applies normalizeApparelName to every INVENTORY line of a scan. Tax, freight,
 * fee and service lines are left as printed, and so is every field other than
 * the description: the line's `size` stays what the document printed.
 *
 * `maxLength` is the scan's text bound (extract.ts MAX_SCAN_TEXT_LEN). Moving
 * a size to the end can add a few characters ("S:Blue" -> "Blue - S"), and a
 * cut name could end mid-token, so a line whose new name would be longer than
 * the bound keeps its printed description.
 */
export function normalizeApparelLineNames(
  lines: ExtractedLine[],
  maxLength: number,
): ExtractedLine[] {
  return lines.map((l) => {
    if (l.lineType !== 'inventory') return l;
    const description = normalizeApparelName(l.description, l.quantity);
    if (description === l.description || description.length > maxLength) return l;
    return { ...l, description };
  });
}
