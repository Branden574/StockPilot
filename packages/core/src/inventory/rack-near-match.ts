/**
 * "Did you mean 10-A?" — the guard against a slipped keystroke minting a rack.
 *
 * THE INCIDENT (2026-07-23): a manager typed a destination in put-away and the
 * flow SILENTLY created a brand-new rack "100-A" and moved 242 units into it.
 * Nobody meant to. It is the ONLY rack in the 100 range in that org — every
 * other rack is 1-A, 10-something, 22-B, 35, 42-B and so on — so a lone "100-A"
 * appearing once reads like a fat-fingered "10-A" or "1-A". The cost was not the
 * typo; it was that nothing ASKED before stock went somewhere real.
 *
 * This module answers two questions a confirmation step needs, and nothing more:
 *   1. Does a rack with this label already exist here? (case-insensitive,
 *      whitespace-tolerant — "22-b " and "22-B" are the same rack to a human)
 *   2. If not, which existing labels most plausibly explain a typo?
 *
 * It is DELIBERATELY not a fuzzy-search engine. A rack label decomposes into a
 * number and a row (see rack-label.ts), and a typo is almost always one of a
 * few shapes: an extra/missing digit ("100" for "10"/"1"), a transposed digit
 * ("21" for "12"), a wrong digit, or a wrong row letter ("22-C" for "22-B").
 * So it compares the NUMBER and the ROW separately with a small edit distance
 * that treats an adjacent transposition as a single edit, and applies one extra
 * rule for the extra/missing-digit case the incident actually was.
 */

import { formatRackLabel, parseRackLabel } from './rack-label';

/**
 * Optimal String Alignment distance (Damerau-Levenshtein restricted to adjacent
 * transpositions). Transpositions count as ONE edit so "12" ↔ "21" is distance
 * 1 — a single slipped keystroke, the way a human reads it — instead of the 2
 * that plain Levenshtein would charge.
 */
function osaDistance(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;

  // rows: previous-previous, previous, current — enough for OSA's one-back look.
  let prevPrev = new Array<number>(bl + 1).fill(0);
  let prev = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;

  for (let i = 1; i <= al; i++) {
    const curr = new Array<number>(bl + 1);
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        curr[j - 1]! + 1, // insertion
        prev[j]! + 1, // deletion
        prev[j - 1]! + cost, // substitution
      );
      // adjacent transposition
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, prevPrev[j - 2]! + 1);
      }
      curr[j] = best;
    }
    prevPrev = prev;
    prev = curr;
  }
  return prev[bl]!;
}

/** True when `short` can be read off `long` in order — a pure insertion typo. */
function isSubsequence(short: string, long: string): boolean {
  if (short.length > long.length) return false;
  let i = 0;
  for (let j = 0; j < long.length && i < short.length; j++) {
    if (short[i] === long[j]) i++;
  }
  return i === short.length;
}

/**
 * The canonical key for a rack label: decomposed the ONE way (rack-label.ts),
 * re-joined, and lowercased. This is what makes existence checks case- and
 * whitespace-insensitive — "22-b ", " 22 - B" and "22-B" all key to "22-b".
 */
function rackKey(label: string | null | undefined): string {
  return formatRackLabel(parseRackLabel(label)).toLowerCase();
}

export interface RackNearMatchResult {
  /** The typed label recomposed for display (casing preserved), e.g. "100-A". */
  normalized: string;
  /** True when a rack with this label already exists (case/whitespace-insensitive). */
  exists: boolean;
  /** The existing label the typed one matches, when `exists`; else null. */
  matchedLabel: string | null;
  /** Closest existing labels that could explain a typo, ranked, at most `limit`. */
  suggestions: string[];
}

interface Candidate {
  label: string;
  total: number;
  numberDistance: number;
  /** 0 when the number differs by a pure insertion/deletion of digits, else 1. */
  indelRank: number;
  index: number;
}

/**
 * Given a typed rack label and the existing rack labels in ONE warehouse, report
 * whether it already exists and, if not, the closest existing labels.
 *
 * A candidate qualifies as a plausible typo when EXACTLY one of these holds
 * (each is a single slip a warehouse worker actually makes):
 *   • same number, wrong row letter        — numberDistance 0, rowDistance 1
 *   • one off in the number                — numberDistance 1, rowDistance ≤ 1
 *   • an extra/missing run of digits        — numberDistance 2, same row, and the
 *     shorter number is a subsequence of the longer ("1"/"10" ↔ "100")
 *
 * That last rule is the incident itself: "100-A" surfaces "10-A" and "1-A" but
 * not "40-A" or "20-A", which share no digit run and are not a single edit.
 * Suggestions are ranked closest-first and capped (default 3).
 */
export function findRackNearMatches(
  typedLabel: string | null | undefined,
  existingLabels: readonly string[],
  opts: { limit?: number } = {},
): RackNearMatchResult {
  const limit = opts.limit ?? 3;
  const typedParts = parseRackLabel(typedLabel);
  const normalized = formatRackLabel(typedParts);
  const typedKey = normalized.toLowerCase();

  const empty: RackNearMatchResult = {
    normalized,
    exists: false,
    matchedLabel: null,
    suggestions: [],
  };
  if (!typedKey) return empty;

  const typedNumber = typedParts.number.toLowerCase();
  const typedRow = (typedParts.row ?? '').toLowerCase();

  // First existing label per canonical key — so a duplicate name (the same rack
  // present in two warehouses upstream, say) is never suggested twice, and the
  // exact match is found regardless of the caller's casing.
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  let matchedLabel: string | null = null;

  existingLabels.forEach((raw, index) => {
    const key = rackKey(raw);
    if (!key || seen.has(key)) return;
    seen.add(key);

    if (key === typedKey) {
      matchedLabel = raw;
      return;
    }

    const parts = parseRackLabel(raw);
    const number = parts.number.toLowerCase();
    const row = (parts.row ?? '').toLowerCase();
    const numberDistance = osaDistance(typedNumber, number);
    const rowDistance = osaDistance(typedRow, row);
    const total = numberDistance + rowDistance;

    // Every qualifying shape is ONE slip. A number typo AND a row typo at once
    // is two mistakes, not a fat-fingered keystroke, so whenever the number
    // differs the row must match exactly — otherwise "88-Z" would "helpfully"
    // dredge up "18-A", which the worker plainly did not mean.
    let qualifies = false;
    let indelRank = 1;
    if (numberDistance === 0 && rowDistance === 1) {
      // wrong row letter on an existing number
      qualifies = true;
      indelRank = 0;
    } else if (numberDistance === 1 && rowDistance === 0) {
      // one slipped digit (wrong or transposed); an inserted/deleted digit ranks
      // ahead of a plain substitution as the more literal fat-finger.
      qualifies = true;
      indelRank = typedNumber.length !== number.length ? 0 : 1;
    } else if (numberDistance === 2 && rowDistance === 0) {
      // extra/missing digits — ONLY when it is a pure insertion (the incident)
      const [shorter, longer] =
        typedNumber.length <= number.length ? [typedNumber, number] : [number, typedNumber];
      if (isSubsequence(shorter, longer)) {
        qualifies = true;
        indelRank = 0;
      }
    }

    if (qualifies) candidates.push({ label: raw, total, numberDistance, indelRank, index });
  });

  if (matchedLabel !== null) {
    return { normalized, exists: true, matchedLabel, suggestions: [] };
  }

  candidates.sort(
    (a, b) =>
      a.total - b.total ||
      a.indelRank - b.indelRank ||
      a.numberDistance - b.numberDistance ||
      a.index - b.index,
  );

  return {
    normalized,
    exists: false,
    matchedLabel: null,
    suggestions: candidates.slice(0, limit).map((c) => c.label),
  };
}

/** Join a few labels into "A", "A or B", "A, B or C" for plain-prose copy. */
function joinOr(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

export interface NewRackPlacementDecision {
  /** True when the destination already exists — the caller must NOT confirm. */
  exists: boolean;
  /** The existing label matched when `exists`; else null. */
  matchedLabel: string | null;
  /** The destination label for display, casing preserved. */
  label: string;
  /** Confirmation title, e.g. "Create new rack 100-A?". */
  title: string;
  /** One plain-prose sentence stating exactly what happens. Empty when `exists`. */
  message: string;
  /** Ranked one-tap alternatives to offer ("Did you mean 10-A?"). */
  suggestions: string[];
}

/**
 * The SINGLE source of the confirmation words, so web and mobile show identical
 * copy for the identical situation (constraint: "Both platforms show the same
 * words for the same situation"). Given the label a put-away is about to create,
 * the warehouse, how many units are about to go into it, and the warehouse's
 * existing labels, it returns whether the label already exists and, if not, the
 * exact sentence to show plus the near-match alternatives.
 */
export function describeNewRackPlacement(input: {
  label: string;
  warehouseName?: string | null;
  quantity: number;
  existingLabels: readonly string[];
  /** 'rack' (default) or 'crate' — only the noun in the copy changes. */
  noun?: 'rack' | 'crate';
  suggestLimit?: number;
}): NewRackPlacementDecision {
  const noun = input.noun ?? 'rack';
  const nm = findRackNearMatches(input.label, input.existingLabels, {
    limit: input.suggestLimit ?? 3,
  });
  const label = nm.normalized || input.label.trim();

  if (nm.exists) {
    return {
      exists: true,
      matchedLabel: nm.matchedLabel,
      label,
      title: '',
      message: '',
      suggestions: [],
    };
  }

  const where = input.warehouseName?.trim() ? ` in ${input.warehouseName.trim()}` : '';
  const units = input.quantity === 1 ? '1 unit' : `${input.quantity} units`;
  const title = `Create new ${noun} ${label}?`;
  let message = `${label} does not exist${where} yet. Continuing creates it and moves ${units} into it.`;
  if (nm.suggestions.length > 0) {
    message += ` Did you mean ${joinOr(nm.suggestions)}?`;
  }

  return {
    exists: false,
    matchedLabel: null,
    label,
    title,
    message,
    suggestions: nm.suggestions,
  };
}
