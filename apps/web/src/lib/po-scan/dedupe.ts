import 'server-only';

import type { ExtractedPo } from './extract';

type ExtractedLine = ExtractedPo['lines'][number];

/**
 * Normalize a line description for duplicate matching: drop a leading "(NEW)"
 * marker, lowercase, strip punctuation to spaces, collapse whitespace.
 */
function normalizeTitle(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/^\s*\(new\)\s*/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * True when two titles are the same product. Conservative: the shorter
 * normalized title must be a whole-word prefix (or equal, or a contained
 * run) of the longer, and be at least 4 chars — so "Persepolis" matches
 * "(NEW)PERSEPOLIS" and "Maus I, My Father Bleeds" matches
 * "(NEW)MAUS I, MY FATHER BLEEDS HISTO SPIEGELMAN", but two short unrelated
 * codes won't collide.
 */
function titlesMatch(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  if (shorter.length < 4) return false;
  return (
    longer === shorter ||
    longer.startsWith(`${shorter} `) ||
    longer.endsWith(` ${shorter}`) ||
    longer.includes(` ${shorter} `)
  );
}

function hasRealSku(sku: string | null | undefined): boolean {
  const s = (sku ?? '').trim();
  return s !== '' && s.toUpperCase() !== 'N/A';
}

/**
 * Some vendor PDFs print each product on TWO rows: a priced title row
 * (e.g. "Persepolis", $106.50, qty 40, no SKU) AND a "(NEW)…" row that carries
 * the ISBN/barcode at $0 with the same quantity. The vision extractor faithfully
 * returns both (its prompt is told never to merge rows), so the review screen
 * shows duplicate lines the user has to skip by hand.
 *
 * Owner decision 2026-07-21 ("just drop it"): when a $0 "(NEW)"+SKU inventory
 * line has a same-quantity priced twin whose title matches, copy the SKU onto
 * the priced line (so the ISBN isn't lost) and DROP the "(NEW)" duplicate.
 * Only ever drops on a confident twin match; an unmatched "(NEW)" line is left
 * intact because it may be a genuinely new item.
 */
export function dropDuplicateNewIsbnLines(lines: ExtractedLine[]): ExtractedLine[] {
  const isNewDupe = (l: ExtractedLine) =>
    l.lineType === 'inventory' &&
    (l.unitPrice ?? 0) === 0 &&
    hasRealSku(l.vendorSku) &&
    /^\s*\(new\)/i.test(l.description ?? '');

  const dropped = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const dupe = lines[i];
    if (!dupe || !isNewDupe(dupe)) continue;

    const twinIdx = lines.findIndex(
      (t, j) =>
        j !== i &&
        !dropped.has(j) &&
        t.lineType === 'inventory' &&
        (t.unitPrice ?? 0) > 0 &&
        t.quantity === dupe.quantity &&
        titlesMatch(t.description, dupe.description),
    );
    if (twinIdx === -1) continue;

    const twin = lines[twinIdx];
    if (!twin) continue;
    // Carry the ISBN/SKU onto the priced twin when it has none of its own.
    if (!hasRealSku(twin.vendorSku)) {
      twin.vendorSku = dupe.vendorSku;
    }
    dropped.add(i);
  }

  if (dropped.size === 0) return lines;
  return lines
    .filter((_, i) => !dropped.has(i))
    .map((l, i) => ({ ...l, lineNumber: i + 1 }));
}
