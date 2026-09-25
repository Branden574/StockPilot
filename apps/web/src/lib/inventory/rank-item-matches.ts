/**
 * Relevance order for search-as-you-type item pickers.
 *
 * The item list's search (`InventoryService.list`, `q`) filters by a
 * case-insensitive substring over name, SKU, barcode and model number and
 * then sorts by a column, so an exact SKU typed in full can sit below twenty
 * items that merely contain it. A picker wants the item the person meant at
 * the top. This ranks the rows a search already matched, best first:
 *
 *   1. exact    the SKU or barcode IS the search (any case), or the barcode is
 *               one of the extra exact codes (the ISBN-10/13 forms of a typed
 *               ISBN)
 *   2. prefix   the name or the SKU starts with the search
 *   3. word     a word inside the name starts with the search ("pen" finds
 *               "Blue Pen" before "Open-ended notebook")
 *   4. contains the name, SKU, barcode or model number contains the search
 *   5. words    every word of the search appears, but not as one phrase
 *               ("red pen" finds "Pen, red")
 *
 * Ties go to name order (numbers compared as numbers, so "Grade 2" comes
 * before "Grade 10"), then SKU, then id so the order is stable.
 *
 * Pure and shared: the server ranks with it (searchForPicker), and nothing in
 * it touches the network.
 */

export type ItemMatchTier = 'exact' | 'prefix' | 'word' | 'contains' | 'words';

const TIER_ORDER: Record<ItemMatchTier, number> = {
  exact: 0,
  prefix: 1,
  word: 2,
  contains: 3,
  words: 4,
};

export interface RankableItem {
  id: string;
  name: string;
  sku: string;
  barcode?: string | null;
  model_number?: string | null;
}

/** Lower-case, trimmed, inner whitespace collapsed. */
export function normalizeItemSearch(term: string): string {
  return term.trim().replace(/\s+/g, ' ').toLowerCase();
}

function lower(v: string | null | undefined): string {
  return (v ?? '').toLowerCase();
}

const ALNUM = /[\p{L}\p{N}]/u;

/** True when `needle` occurs in `hay` at the start of a word (not at 0). */
function startsAWord(hay: string, needle: string): boolean {
  let from = 1;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) return false;
    if (!ALNUM.test(hay.charAt(at - 1))) return true;
    from = at + 1;
  }
}

/**
 * The tier of one row for a search. `exactCodes` are extra barcodes that count
 * as an exact match (compared case-insensitively).
 */
export function itemMatchTier(
  item: RankableItem,
  search: string,
  exactCodes: readonly string[] = [],
): ItemMatchTier {
  const term = normalizeItemSearch(search);
  const name = lower(item.name);
  const sku = lower(item.sku);
  const barcode = lower(item.barcode);
  if (term.length > 0 && (sku === term || barcode === term)) return 'exact';
  if (barcode && exactCodes.some((c) => c.toLowerCase() === barcode)) return 'exact';
  if (term.length === 0) return 'words';
  if (name.startsWith(term) || sku.startsWith(term)) return 'prefix';
  if (startsAWord(name, term)) return 'word';
  if (
    name.includes(term) ||
    sku.includes(term) ||
    barcode.includes(term) ||
    lower(item.model_number).includes(term)
  ) {
    return 'contains';
  }
  return 'words';
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/**
 * Rows best match first, each carrying its tier. Does not filter: every row
 * passed in comes back once.
 */
export function rankItemMatches<T extends RankableItem>(
  rows: readonly T[],
  search: string,
  exactCodes: readonly string[] = [],
): Array<T & { match: ItemMatchTier }> {
  return rows
    .map((row) => ({ ...row, match: itemMatchTier(row, search, exactCodes) }))
    .sort(
      (a, b) =>
        TIER_ORDER[a.match] - TIER_ORDER[b.match] ||
        collator.compare(a.name ?? '', b.name ?? '') ||
        collator.compare(a.sku ?? '', b.sku ?? '') ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}
