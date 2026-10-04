import {
  DEFAULT_SORT,
  SORT_OPTIONS,
  filterKits,
  filterPreparedCatalog,
  sortCatalog,
  type AisleSummary,
  type AvailabilityFilter,
  type CategoryFilter,
  type KitOffer,
  type PreparedCatalog,
  type SortKey,
  type StorefrontItem,
  type StorefrontItemStatus,
} from '@stockpilot/core';

/**
 * WHAT THE STOREFRONT LISTS (phone ordering PO-4): the home sections and a
 * browse view, as ONE flat list of rows, so a single virtualized FlatList
 * renders all of it (never a ScrollView .map over the catalog; memory
 * reference_mobile_items_perf_solved). Pure.
 *
 * Home, browsing everything with no search and no filter:
 *   - Frequently ordered (the top rows, "See all N" when there are more);
 *   - Kits, when the Bundles module is on (or "Kits could not be loaded");
 *   - Browse by category: one row per aisle with its count, then All items.
 * Anything typed in search, or any filter or sort: the matching items (and
 * kits), searched on the device over EVERY row of the catalog (core
 * filterPreparedCatalog: every word in the name, the SKU or the category).
 * A browse view: one category, Frequently ordered, Kits, or All items.
 */

/** How many rows a home section shows before "See all". */
export const HOME_SECTION_ROWS = 5;

/** Sorts offered on the phone: the web's list (core SORT_OPTIONS) without
 *  "Featured", which is name order, and with "Most ordered here" only when
 *  Frequently ordered loaded. */
export function phoneSortOptions(frequentLoaded: boolean): readonly { id: SortKey; label: string }[] {
  return SORT_OPTIONS.filter((o) => o.id !== 'featured' && (o.id !== 'freq' || frequentLoaded));
}

export type BrowseTarget =
  | { kind: 'category'; category: string }
  | { kind: 'frequent' }
  | { kind: 'kits' }
  | { kind: 'all' };

/** A browse target from route params (`?category=` or `?section=`); All
 *  items when neither names one. */
export function browseTargetFromParams(params: { category?: unknown; section?: unknown }): BrowseTarget {
  const category = typeof params.category === 'string' ? params.category : '';
  if (category !== '') return { kind: 'category', category };
  if (params.section === 'frequent') return { kind: 'frequent' };
  if (params.section === 'kits') return { kind: 'kits' };
  return { kind: 'all' };
}

export function browseHref(target: BrowseTarget): string {
  switch (target.kind) {
    case 'category':
      return `/order/new/browse?category=${encodeURIComponent(target.category)}`;
    case 'frequent':
      return '/order/new/browse?section=frequent';
    case 'kits':
      return '/order/new/browse?section=kits';
    case 'all':
      return '/order/new/browse?section=all';
  }
}

export interface StorefrontFilter {
  search: string;
  availability: AvailabilityFilter;
  sort: SortKey;
}

export const EMPTY_FILTER: StorefrontFilter = { search: '', availability: new Set(), sort: DEFAULT_SORT };

/** The filter is narrowing or re-ordering what is shown. */
export function filterActive(f: StorefrontFilter): boolean {
  return f.search.trim() !== '' || f.availability.size > 0 || f.sort !== DEFAULT_SORT;
}

/** How many filters the Sort & filter button counts (search is its own field). */
export function activeFilterCount(f: StorefrontFilter): number {
  return f.availability.size + (f.sort !== DEFAULT_SORT ? 1 : 0);
}

export function toggleAvailability(f: StorefrontFilter, status: StorefrontItemStatus): StorefrontFilter {
  const next = new Set(f.availability);
  if (next.has(status)) next.delete(status);
  else next.add(status);
  return { ...f, availability: next };
}

export type StorefrontRow =
  | { kind: 'header'; key: string; title: string; subtitle?: string }
  | { kind: 'item'; key: string; item: StorefrontItem; rank?: { place: number; orders: number } }
  | { kind: 'kit'; key: string; kit: KitOffer }
  | { kind: 'category'; key: string; aisle: AisleSummary }
  | { kind: 'all-items'; key: string; count: number }
  | { kind: 'see-all'; key: string; target: BrowseTarget; count: number }
  | { kind: 'note'; key: string; text: string }
  | { kind: 'empty'; key: string };

export interface CatalogView {
  prepared: PreparedCatalog<StorefrontItem>;
  itemMap: ReadonlyMap<string, StorefrontItem>;
  aisles: readonly AisleSummary[];
  /** null when Frequently ordered failed to load. */
  frequent: readonly { itemId: string; orders: number }[] | null;
  /** null when the kits failed to load; [] when there are none or the
   *  module is off (`kitsEnabled` decides whether the section shows). */
  kits: readonly KitOffer[] | null;
  kitsEnabled: boolean;
}

export interface SectionWords {
  frequentTitle: string;
  frequentSubtitle: string;
  kitsTitle: string;
  kitsSubtitle: string;
  kitsFailed: string;
  categoriesTitle: string;
  nothingOrderable: string;
}

/** Frequently ordered as catalog rows, in rank order, only items in the
 *  caller's catalog (the server already filters; this never trusts it). */
export function frequentRows(view: CatalogView): { item: StorefrontItem; place: number; orders: number }[] {
  if (!view.frequent) return [];
  const out: { item: StorefrontItem; place: number; orders: number }[] = [];
  for (const f of view.frequent) {
    const item = view.itemMap.get(f.itemId);
    if (item) out.push({ item, place: out.length + 1, orders: f.orders });
  }
  return out;
}

function freqMap(view: CatalogView): Map<string, number> {
  return new Map((view.frequent ?? []).map((f) => [f.itemId, f.orders]));
}

/** The home rows (nothing typed, no filter). */
export function homeRows(view: CatalogView, words: SectionWords): StorefrontRow[] {
  const rows: StorefrontRow[] = [];
  if (view.prepared.items.length === 0) {
    rows.push({ kind: 'note', key: 'nothing', text: words.nothingOrderable });
    return rows;
  }
  const frequent = frequentRows(view);
  if (frequent.length > 0) {
    rows.push({ kind: 'header', key: 'h-frequent', title: words.frequentTitle, subtitle: words.frequentSubtitle });
    for (const f of frequent.slice(0, HOME_SECTION_ROWS)) {
      rows.push({ kind: 'item', key: `f-${f.item.id}`, item: f.item, rank: { place: f.place, orders: f.orders } });
    }
    if (frequent.length > HOME_SECTION_ROWS) {
      rows.push({ kind: 'see-all', key: 'all-frequent', target: { kind: 'frequent' }, count: frequent.length });
    }
  }
  if (view.kitsEnabled) {
    if (view.kits === null) {
      rows.push({ kind: 'header', key: 'h-kits', title: words.kitsTitle });
      rows.push({ kind: 'note', key: 'kits-failed', text: words.kitsFailed });
    } else if (view.kits.length > 0) {
      rows.push({ kind: 'header', key: 'h-kits', title: words.kitsTitle, subtitle: words.kitsSubtitle });
      for (const kit of view.kits.slice(0, HOME_SECTION_ROWS)) rows.push({ kind: 'kit', key: `k-${kit.bundleId}`, kit });
      if (view.kits.length > HOME_SECTION_ROWS) {
        rows.push({ kind: 'see-all', key: 'all-kits', target: { kind: 'kits' }, count: view.kits.length });
      }
    }
  }
  rows.push({ kind: 'header', key: 'h-categories', title: words.categoriesTitle });
  for (const aisle of view.aisles) {
    rows.push({ kind: 'category', key: `c-${aisle.id ?? 'uncategorized'}`, aisle });
  }
  rows.push({ kind: 'all-items', key: 'all-items', count: view.prepared.items.length });
  return rows;
}

/** The category key core's filters take for an aisle. */
export function aisleCategory(aisle: AisleSummary): CategoryFilter {
  return aisle.id ?? 'uncategorized';
}

/**
 * The matching rows of one view: kits first (when the view shows kits), then
 * items, searched and filtered over every row, then sorted. An empty result
 * is one `empty` row (the screen says core's "Nothing matches").
 */
export function matchingRows(view: CatalogView, target: BrowseTarget, filter: StorefrontFilter): StorefrontRow[] {
  const rows: StorefrontRow[] = [];
  const category: CategoryFilter = target.kind === 'category' ? target.category : 'all';
  const coreFilter = { category, search: filter.search, availability: filter.availability };
  const showKits = view.kitsEnabled && view.kits !== null && (target.kind === 'kits' || target.kind === 'all' || target.kind === 'category');
  if (showKits && view.kits) {
    for (const kit of filterKits(view.kits, view.itemMap, coreFilter)) {
      rows.push({ kind: 'kit', key: `k-${kit.bundleId}`, kit });
    }
  }
  if (target.kind !== 'kits') {
    let items: StorefrontItem[];
    if (target.kind === 'frequent') {
      const ranked = frequentRows(view).map((f) => f.item);
      const matching = new Set(filterPreparedCatalog(view.prepared, coreFilter).map((i) => i.id));
      items = ranked.filter((i) => matching.has(i.id));
      if (filter.sort !== DEFAULT_SORT) items = sortCatalog(items, filter.sort, freqMap(view));
    } else {
      items = sortCatalog(filterPreparedCatalog(view.prepared, coreFilter), filter.sort, freqMap(view));
    }
    const ranks = new Map(frequentRows(view).map((f) => [f.item.id, f]));
    for (const item of items) {
      const r = target.kind === 'frequent' ? ranks.get(item.id) : undefined;
      rows.push({ kind: 'item', key: `i-${item.id}`, item, ...(r ? { rank: { place: r.place, orders: r.orders } } : {}) });
    }
  }
  if (rows.length === 0) rows.push({ kind: 'empty', key: 'empty' });
  return rows;
}

/** The FlatList's key extractor, at module scope (never inline). */
export function storefrontRowKey(row: StorefrontRow): string {
  return row.key;
}
