import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import {
  ArrowLeft,
  Barcode,
  BookMarked,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  ListChecks,
  Menu,
  Plus,
  Search,
} from 'lucide-react-native';
import * as React from 'react';
import {
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useBottomTabBarHeight } from 'expo-router/js-tabs';

import {
  ActiveFilterPill,
  FILTER_GENERIC_CHARTER_ID,
  FilterButton,
  FilterSheet,
  EMPTY_FILTER_STATE,
  activeFilterCount,
  type FilterOption,
  type FilterState,
} from '@/components/filter-sheet';
import { CountSelectBar } from '@/components/count-select-bar';
import { Card } from '@/components/ui/card';
import { Paginator } from '@/components/ui/paginator';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { BookListSkeleton } from '@/components/ui/skeleton';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { Thumb } from '@/components/ui/thumb';
import { countSelection, useIsPicked } from '@/lib/use-count-selection';
import { TRAILING_COLUMN_MAX_WIDTH, shouldStackRow } from '@/lib/dynamic-type-layout';
import {
  listStatusPredicate,
  stockPill,
  stockPillFor,
  type LifecycleStatus,
} from '@/lib/expected-items';
import { signItemImages, THUMB_TRANSFORM } from '@/lib/image-cache';
import {
  buildGroupUnits,
  buildGroupedRows,
  firstCoverBySku,
  type GroupedRow,
} from '@/lib/inventory-grouping';
import {
  GROUPS_PER_PAGE,
  POSTGREST_MAX_ROWS,
  paginateGroups,
  readIsComplete,
} from '@/lib/inventory-paging';
import { supabase } from '@/lib/supabase';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';
import { useWorkspace } from '@/lib/use-workspace';

interface BookRow {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  quantity_on_hand: number;
  reorder_point: number;
  /** Lifecycle (active / archived / discontinued). The list FILTERS on status
   *  but also has to CARRY it: a collapsed SKU-group header rolls lifecycle up
   *  conservatively (discontinued > archived > active) so a discontinued
   *  placement can never hide behind a healthy badge. */
  status: string;
  custom_fields: Record<string, unknown> | null;
  category_id: string | null;
  primary_location_id: string | null;
  charter_id: string | null;
  updated_at: string | null;
  imageUrl: string | null;
  grade: string | null;
  /** True only when the SYSTEM auto-archived this item on zero stock
   *  (migration 0266) — drives the item detail "Auto-archived" badge.
   *  Meaningless unless status === 'archived'. */
  auto_archived: boolean;
  /** True while a PO-created book is awaiting its FIRST receipt
   *  (migration 0277; a DB trigger clears it when stock arrives). Flagged
   *  rows are hidden from the default catalog and only surface under the
   *  filter sheet's Expected option, where they wear an EXPECTED pill
   *  instead of the misleading OUT. */
  awaiting_first_receipt: boolean;
}

/** One flattened Books-list entry: a collapsed same-SKU header or a book row. */
type BookGroupedRow = GroupedRow<BookRow>;

const groupedKeyExtractor = (r: BookGroupedRow): string => r.key;

/** Stable empty set — books never size-run group, but the option is required. */
const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/** Width reserved at the trailing edge of EVERY list card, so the quantity /
 *  pill column lands in the same place on a collapsed header (which carries a
 *  disclosure chevron there) as on the rows it expands to (which carry the
 *  select-mode checkbox, or nothing). Without the reservation the header's
 *  numbers sat ~32px left of the numbers they are meant to summarise. */
const TRAILING_SLOT = 22;

/** Row → BookRow for the list read. */
function toBookRow(row: unknown): BookRow {
  const r = row as Record<string, unknown>;
  const cf = (r.custom_fields as Record<string, unknown> | null) ?? null;
  return {
    id: r.id as string,
    name: r.name as string,
    sku: r.sku as string,
    barcode: (r.barcode as string | null) ?? null,
    quantity_on_hand: Number(r.quantity_on_hand) || 0,
    reorder_point: Number(r.reorder_point) || 0,
    status: (r.status as string | null) ?? 'active',
    custom_fields: cf,
    category_id: (r.category_id as string | null) ?? null,
    primary_location_id: (r.primary_location_id as string | null) ?? null,
    charter_id: (r.charter_id as string | null) ?? null,
    updated_at: (r.updated_at as string | null) ?? null,
    imageUrl: null,
    grade: (cf?.book_grade as string | undefined) ?? null,
    auto_archived: Boolean(r.auto_archived),
    awaiting_first_receipt: Boolean(r.awaiting_first_receipt),
  };
}

/** Columns the list read selects — deliberately lean: exactly what a card
 *  renders (plus the fields the collapsed header rolls up), because this read
 *  now returns the whole filtered set rather than a 50-row window. */
const BOOK_COLUMNS = `id, name, sku, barcode, quantity_on_hand, reorder_point, status, custom_fields,
           category_id, primary_location_id, charter_id, warehouse_id, updated_at, auto_archived,
           awaiting_first_receipt`;

export default function BooksScreen() {
  const router = useRouter();
  // Org + warehouse both come from the workspace switcher so they stay in
  // sync. (Sourcing orgId from useOrg's .limit(1) while taking the warehouse
  // from the active workspace mismatched on org switch → empty list.)
  const { activeOrgId: orgId, activeWarehouseId } = useWorkspace();
  const navigation = useNavigation();
  const { c } = useTheme();
  // Bottom tab bar is absolute-positioned and overlays content — use
  // the navigator-reported height so the last book row clears the blur.
  const tabBarHeight = useBottomTabBarHeight();
  // Dynamic Type: read ONCE here and pass down, rather than subscribing every
  // memoised card to window dimensions — this list is a do-not-regress perf
  // surface. A boolean prop is memo-stable, so nothing re-renders until the
  // user actually changes Larger Text.
  const { fontScale } = useWindowDimensions();
  const stackRows = shouldStackRow(fontScale);
  const { return: returnPath } = useLocalSearchParams<{ return?: string }>();
  // The WHOLE filtered set, not a page of it (one request, capped at
  // POSTGREST_MAX_ROWS). Pagination happens below, over GROUPS, so a title's
  // placements can never land on two pages.
  const [rows, setRows] = React.useState<BookRow[]>([]);
  // Exact server count over the same predicates. Equal to rows.length except
  // in the truncated case, where it is what the disclosure quotes.
  const [serverRowCount, setServerRowCount] = React.useState<number | null>(null);
  // Rows the SERVER returned, before the client-side LOW pass. The truncation
  // sentence must divide this by serverRowCount — dividing the post-LOW list by
  // a pre-LOW count states a ratio over two different populations.
  const [loadedRowCount, setLoadedRowCount] = React.useState(0);
  const [page, setPage] = React.useState(1);
  // Model B: one book SKU can be MULTIPLE inventory_items rows (one per
  // charter/rack — migration 0234's (org, sku, charter, bin) uniqueness), so a
  // title splits into several rows exactly like a Chromebook does on Items.
  // Collapse those into one header and track which are expanded.
  const [expandedSkuGroups, setExpandedSkuGroups] = React.useState<Set<string>>(new Set());
  // True ONLY when the read hit PostgREST's cap, i.e. the rows in hand are a
  // prefix of the filtered set. At current volumes (111 books on the largest
  // org, cap 1000) this never fires; when it does it is disclosed above the
  // list AND on every collapsed header, never silently.
  const [truncated, setTruncated] = React.useState(false);
  // Signed thumbnail URLs, resolved for the CURRENT PAGE's rows only and kept
  // across page flips. Keyed by item id; a null value means "resolved, has no
  // image", so a coverless book is never re-queried.
  //
  // CACHED PER LOAD, NOT PER SESSION. It is dropped by `load()` — pull-to-
  // refresh and every query/filter/warehouse change — because it caches a read
  // of item_images, and "resolved, no cover" is exactly the entry a freshly
  // uploaded cover has to be able to overwrite. Held for the life of the screen
  // it froze the first answer, so a cover added in the app never appeared again
  // that session, a regression against the old per-load fetch. Page flips do
  // NOT clear it: that is the cross-page saving it exists for. Identical to
  // inventory.tsx.
  const [images, setImages] = React.useState<ReadonlyMap<string, string | null>>(new Map());
  const listRef = React.useRef<FlatList<BookGroupedRow> | null>(null);
  const [bookCategories, setBookCategories] = React.useState<FilterOption[]>([]);
  const [locations, setLocations] = React.useState<FilterOption[]>([]);
  const [charters, setCharters] = React.useState<FilterOption[]>([]);
  const [filter, setFilter] = React.useState<FilterState>(EMPTY_FILTER_STATE);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [q, setQ] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  // Cycle-count select mode: tapping a card toggles it into the shared
  // count-selection store instead of opening the book.
  const [selectMode, setSelectMode] = React.useState(false);

  const openDrawer = () => (navigation as { openDrawer?: () => void }).openDrawer?.();

  const bookCatIds = React.useMemo(() => bookCategories.map((b) => b.id), [bookCategories]);

  const categoryMap = React.useMemo(
    () => new Map(bookCategories.map((x) => [x.id, x.name] as const)),
    [bookCategories],
  );
  const locationMap = React.useMemo(
    () => new Map(locations.map((x) => [x.id, x.name] as const)),
    [locations],
  );
  const charterMap = React.useMemo(
    () => new Map(charters.map((x) => [x.id, x.name] as const)),
    [charters],
  );

  const loadLookups = React.useCallback(async () => {
    if (!orgId) return;
    const [cats, locs, chts] = await Promise.all([
      supabase
        .from('categories')
        .select('id, name')
        .eq('organization_id', orgId)
        .is('deleted_at', null)
        .ilike('name', '%book%')
        .order('name', { ascending: true }),
      supabase
        .from('locations')
        .select('id, name')
        .eq('organization_id', orgId)
        .is('deleted_at', null)
        // Sites only — racks/shelves/crates and the staging/unplaced system
        // slots aren't stocking locations to filter or assign items by.
        .in('type', ['warehouse', 'room', 'vehicle', 'jobsite'])
        .order('name', { ascending: true }),
      supabase
        .from('charters')
        .select('id, name, code')
        .eq('organization_id', orgId)
        .order('name', { ascending: true }),
    ]);
    setBookCategories(((cats.data ?? []) as Array<{ id: string; name: string }>) ?? []);
    setLocations(((locs.data ?? []) as Array<{ id: string; name: string }>) ?? []);
    setCharters(
      ((chts.data ?? []) as Array<{ id: string; name: string; code: string | null }>).map((c) => ({
        id: c.id,
        name: c.code ? `${c.name} · ${c.code}` : c.name,
      })),
    );
  }, [orgId]);

  const load = React.useCallback(
    async (query: string, f: FilterState, _allBookCatIds: string[]) => {
      if (!orgId) return;

      const sortMap: Record<typeof f.sort, { col: string; asc: boolean }> = {
        updated_desc: { col: 'updated_at', asc: false },
        name_asc: { col: 'name', asc: true },
        name_desc: { col: 'name', asc: false },
        qty_desc: { col: 'quantity_on_hand', asc: false },
        qty_asc: { col: 'quantity_on_hand', asc: true },
      };
      const ord = sortMap[f.sort];
      const isLow = f.status === 'low';
      // Same STOCK radio as Items (FilterSheet): Archived flips this screen
      // from active books to archived ones, and Expected (mig 0277) shows
      // PO-created phantoms awaiting their first receipt. Every default view
      // carries awaiting_first_receipt=false so a never-received book can't
      // read as "Out of stock". listStatusPredicate (pure, tested) owns the
      // mapping — identical to the Items list so the tabs never drift.
      const pred = listStatusPredicate(f.status);

      // Match web: books are identified by `item_type='book'` directly.
      // The previous category-name LIKE '%book%' filter missed every
      // book whose category didn't happen to contain the word "book"
      // (47 of 93 records on this org). Web mirrors this filter in
      // InventoryService.list({ itemType: 'book' }).
      //
      // Every predicate lives in ONE place. It used to serve two reads (the
      // visible page and a per-SKU count) that had to see the identical
      // dataset; there is only one read now, but the builder stays — it is
      // what guarantees the row read and its exact count can never drift, and
      // it is the seam any future second read must go through. Generic over
      // the column list so PostgREST still infers row types from each literal
      // select.
      const scoped = <Q extends string>(columns: Q, opts?: { count: 'exact' }) => {
        let r = supabase
          .from('inventory_items')
          .select(columns, opts)
          .eq('organization_id', orgId)
          .eq('item_type', 'book')
          .eq('awaiting_first_receipt', pred.awaitingFirstReceipt)
          .is('deleted_at', null);
        if (pred.lifecycle) {
          r = r.eq('status', pred.lifecycle);
        }
        // Honor the drawer workspace's active warehouse so book lookups
        // scope the same way as Items.
        if (activeWarehouseId) {
          r = r.eq('warehouse_id', activeWarehouseId);
        }
        if (f.categoryIds.length > 0) {
          r = r.in('category_id', f.categoryIds);
        }
        if (query.trim()) {
          // Quote the value so PostgREST-reserved chars (, ( ) .) in a book
          // title or pasted ISBN stay literal instead of corrupting the
          // or-expression. See inventory.tsx for the full rationale.
          const term = query.trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          r = r.or(`name.ilike."%${term}%",sku.ilike."%${term}%",barcode.ilike."%${term}%"`);
        }
        if (f.locationIds.length > 0) {
          r = r.in('primary_location_id', f.locationIds);
        }
        if (f.charterIds.length > 0) {
          const wantsGeneric = f.charterIds.includes(FILTER_GENERIC_CHARTER_ID);
          const real = f.charterIds.filter((x) => x !== FILTER_GENERIC_CHARTER_ID);
          if (wantsGeneric && real.length > 0) {
            r = r.or(`charter_id.is.null,charter_id.in.(${real.join(',')})`);
          } else if (wantsGeneric) {
            r = r.is('charter_id', null);
          } else {
            r = r.in('charter_id', real);
          }
        }
        if (f.status === 'out') r = r.lte('quantity_on_hand', 0);
        return r;
      };

      // `status` is SELECTED as well as filtered on: the collapsed SKU-group
      // header rolls lifecycle up across placements, so the per-row value has
      // to actually be fetched.
      //
      // `id` is a SECONDARY sort key: updated_at / name / quantity all tie
      // freely, and ties ordered differently between two fetches can put a row
      // on two pages or none.
      // ── ONE request for the WHOLE filtered set ───────────────────────────
      // Not a 50-row window. Server paging was the ONLY reason a title's
      // placements could land on two pages, and the datasets it was paging are
      // tiny: 111 active books on the largest production org, against
      // PostgREST's 1000-row cap. Holding the set lets the GROUP be the unit
      // of pagination (below), which is the requirement — a family whole on
      // exactly one page — and costs one round trip instead of one per page.
      //
      // `id` is a SECONDARY sort key: updated_at / name / quantity all tie
      // freely, and ties ordered differently between two fetches can put a row
      // in two groups or none.
      const { data, count, error } = await scoped(BOOK_COLUMNS, { count: 'exact' })
        .order(ord.col, { ascending: ord.asc })
        .order('id', { ascending: true })
        .limit(POSTGREST_MAX_ROWS);
      if (error) console.warn('books list', error);

      let bookRows: BookRow[] = (data ?? []).map(toBookRow);
      const returned = bookRows.length;

      // 'low' stays a client pass (reorder_point is per-row and cannot be
      // expressed in a PostgREST filter) — but it now runs over the COMPLETE
      // set rather than a widened window, so it is an ordinary filter like any
      // other, not a source of missing siblings.
      if (isLow) {
        bookRows = bookRows.filter(
          (r) =>
            r.reorder_point > 0
            && r.quantity_on_hand <= r.reorder_point
            && r.quantity_on_hand > 0,
        );
      }

      // The ONE way the rows in hand can still be short: an org whose filtered
      // set exceeds the server's cap. Detected from the RESPONSE against the
      // exact count over the same predicates — never from a local constant,
      // which is how a previous round shipped a guard comparing against 2000
      // while the real cap was 1000, so it could never fire.
      setTruncated(
        !readIsComplete({ returned, serverCount: count ?? null, limit: POSTGREST_MAX_ROWS }),
      );
      setRows(bookRows);
      setServerRowCount(count ?? null);
      setLoadedRowCount(returned);
      // A load is the one moment the underlying data may have changed, so the
      // thumbnail cache is invalidated HERE and only here — pull-to-refresh and
      // every query/filter/warehouse change run through this function, while a
      // page flip does not. Without this a cover uploaded in the app never
      // reappeared, because a "resolved, no cover" entry was never re-asked.
      setImages(new Map());
      setLoading(false);
    },
    [orgId, activeWarehouseId],
  );

  React.useEffect(() => {
    if (!orgId) return;
    void loadLookups();
  }, [orgId, loadLookups]);

  // Whenever the query / filter / workspace changes, jump back to page 1.
  // Expanded SKU groups are per-page display state, so drop them too — an
  // expansion carried over from another result set reads as a glitch.
  React.useEffect(() => {
    setPage(1);
    setExpandedSkuGroups(new Set());
  }, [q, filter, activeWarehouseId]);

  // NOT keyed on `page` any more: a page flip is a client-side slice of the
  // set already in memory, so it costs no request and no skeleton.
  React.useEffect(() => {
    if (!orgId) return;
    const t = setTimeout(() => void load(q, filter, bookCatIds), 250);
    return () => clearTimeout(t);
  }, [q, filter, bookCatIds, load, orgId, activeWarehouseId]);

  async function refresh() {
    setRefreshing(true);
    await load(q, filter, bookCatIds);
    setRefreshing(false);
  }

  const onPageChange = React.useCallback((p: number) => {
    setPage(p);
    setExpandedSkuGroups(new Set());
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, []);

  // Dismiss any keyboard left open from a previous screen / tab switch.
  useFocusEffect(
    React.useCallback(() => {
      Keyboard.dismiss();
    }, []),
  );

  const filterCount = activeFilterCount(filter);

  const onBookPress = React.useCallback(
    (id: string) => {
      Keyboard.dismiss();
      router.push({ pathname: '/item/[id]', params: { id } });
    },
    [router],
  );

  const onToggleSelect = React.useCallback((b: BookRow) => {
    countSelection.toggle({ id: b.id, sku: b.sku, name: b.name, itemType: 'book' });
  }, []);

  const toggleSkuGroup = React.useCallback((sku: string) => {
    setExpandedSkuGroups((prev) => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });
  }, []);

  // Secondary line for an expanded placement. Books split by charter/rack
  // (mig 0234), so the rack label is the most concrete differentiator staff
  // physically walk to; charter and site are the fallbacks. The two flat
  // custom_fields keys are the same ones web's readBookStorage() reads
  // (see apps/web/src/lib/book-storage.ts) — mobile reads them directly
  // rather than importing a web-only module.
  const placementLabelFor = React.useCallback(
    (b: BookRow): string | null => {
      const cf = b.custom_fields ?? {};
      const n = typeof cf.book_rack_number === 'string' ? cf.book_rack_number.trim() : '';
      const row = typeof cf.book_rack_row === 'string' ? cf.book_rack_row.trim() : '';
      const rack = n || row ? [n, row].filter(Boolean).join('-') : null;
      const charter = b.charter_id ? charterMap.get(b.charter_id) ?? null : null;
      const loc = b.primary_location_id ? locationMap.get(b.primary_location_id) ?? null : null;
      return rack ?? charter ?? loc;
    },
    [charterMap, locationMap],
  );

  // ── GROUP FIRST, THEN PAGE ────────────────────────────────────────────────
  // The whole filtered set is grouped into display UNITS (one collapsed SKU
  // family, or one standalone title = one card), and the PAGE is a slice of
  // units. That is the requirement: three placements of one SKU are one header
  // on ONE page, all three behind the chevron, whatever the sort or page size.
  // Size runs stay OFF — a book is never sized, which is why the web table
  // gates that pass behind `showBookFields`.
  const units = React.useMemo(() => buildGroupUnits(rows, { enableSizeRuns: false }), [rows]);
  const pageView = React.useMemo(
    () => paginateGroups(units, { page, groupsPerPage: GROUPS_PER_PAGE }),
    [units, page],
  );
  // Rows in the filtered set. Exact from the rows themselves in the normal
  // case (we hold all of them); the server's count only when they are a prefix.
  // Mirrors inventory.tsx: under LOW the server count describes the pre-filter
  // population, so adopting it would make the eyebrow and the paginator quote
  // different totals on one screen.
  const datasetRowCount =
    truncated && filter.status !== 'low' ? serverRowCount ?? rows.length : rows.length;

  // Thumbnails are resolved for the PAGE's rows only. The set read can return
  // up to 1000 rows and signing a transformed URL costs one request per path
  // (image-cache.ts falls back to per-path signing whenever a transform is
  // asked for), so signing the whole set would trade a saved page fetch for
  // hundreds of storage calls. Resolved URLs are kept across page flips.
  const pageItems = pageView.pageItems;
  const unresolvedIds = React.useMemo(
    () => pageItems.filter((b) => !images.has(b.id)).map((b) => b.id),
    [pageItems, images],
  );
  React.useEffect(() => {
    if (unresolvedIds.length === 0) return;
    let cancelled = false;
    void (async () => {
      const { data: imgs } = await supabase
        .from('item_images')
        .select('item_id, storage_path, is_primary, sort_order')
        .in('item_id', unresolvedIds)
        .order('is_primary', { ascending: false })
        .order('sort_order', { ascending: true });
      const byItem = new Map<string, string>();
      for (const row of (imgs ?? []) as Array<{ item_id: string; storage_path: string }>) {
        if (!byItem.has(row.item_id)) byItem.set(row.item_id, row.storage_path);
      }
      // Thumbnail transform, not the full-res original — book covers (often
      // web/PO-imported, multi-megapixel, no thumb variant) would otherwise
      // decode huge bitmaps for a 56px row. See inventory.tsx.
      const paths = Array.from(byItem.values());
      const urlByPath =
        paths.length > 0 ? await signItemImages(paths, THUMB_TRANSFORM) : new Map<string, string>();
      if (cancelled) return;
      setImages((prev) => {
        const next = new Map(prev);
        for (const id of unresolvedIds) {
          const p = byItem.get(id);
          // null records "resolved, no cover" so a coverless book is asked
          // about exactly once.
          next.set(id, (p ? urlByPath.get(p) : null) ?? null);
        }
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [unresolvedIds]);

  const pageRows = React.useMemo<BookRow[]>(
    () =>
      pageItems.map((b) => {
        const url = images.get(b.id) ?? null;
        return url === b.imageUrl ? b : { ...b, imageUrl: url };
      }),
    [pageItems, images],
  );

  // Same-SKU collapse (Model B), the mobile twin of the web Books table. Run
  // over the PAGE, which by construction holds every placement of every SKU on
  // it — so the units it rebuilds are exactly the units it was sliced from.
  // Pure + tested in lib/inventory-grouping.ts. DISPLAY ONLY — totals are
  // read-time sums of the rows the chevron reveals.
  const groupedRows = React.useMemo<BookGroupedRow[]>(
    () =>
      buildGroupedRows<BookRow>(pageRows, {
        expandedSizeRuns: EMPTY_SET,
        expandedSkuGroups,
        placementLabelFor,
        enableSizeRuns: false,
        datasetIsTruncated: truncated,
      }),
    [pageRows, expandedSkuGroups, placementLabelFor, truncated],
  );

  // A collapsed header shows the group's cover. A SKU is one product identity
  // under 0234, so every placement is the same title — but only one placement
  // may actually carry the uploaded image, so this takes the first NON-NULL
  // cover rather than the first placement's. GroupedRow deliberately carries
  // no image, so resolve it here.
  const firstImageBySku = React.useMemo(() => firstCoverBySku(pageRows), [pageRows]);

  const renderBookItem = React.useCallback(
    ({ item: row }: { item: BookGroupedRow }) => {
      if (row.kind === 'sku-header') {
        return (
          <BookGroupHeaderCard
            name={row.name}
            total={row.total}
            reorderPoint={row.reorderPoint}
            placementCount={row.placementCount}
            partial={row.partial}
            lifecycle={row.status}
            imageUrl={firstImageBySku.get(row.sku) ?? null}
            // Derived from the ROWS (every placement awaiting its first
            // receipt), not from filter.status: view state changes the instant
            // the filter is tapped while the rows lag a 250ms debounce plus a
            // fetch behind it, so a filter-derived pill badges the PREVIOUS
            // view's rows with something their own children contradict.
            expected={row.expected}
            expanded={expandedSkuGroups.has(row.sku)}
            onToggle={() => toggleSkuGroup(row.sku)}
            stacked={stackRows}
          />
        );
      }
      // Size runs are disabled for books, so a 'header' row is unreachable —
      // handled rather than cast so a future option flip can't crash the list.
      if (row.kind !== 'row') return null;
      return (
        <BookCard
          book={row.item}
          placementLabel={row.placementLabel}
          onBookPress={onBookPress}
          selectMode={selectMode}
          onToggleSelect={onToggleSelect}
          stacked={stackRows}
        />
      );
    },
    [
      onBookPress,
      selectMode,
      onToggleSelect,
      expandedSkuGroups,
      toggleSkuGroup,
      firstImageBySku,
      stackRows,
    ],
  );

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <IconChip
              icon={ArrowLeft}
              onPress={() => {
                if (typeof returnPath === 'string' && returnPath.length > 0) {
                  router.replace(returnPath as never);
                } else if (router.canGoBack()) {
                  router.back();
                } else {
                  router.replace('/');
                }
              }}
            />
            <IconChip icon={Menu} onPress={openDrawer} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <IconChip
              icon={selectMode ? Check : ListChecks}
              onPress={() => setSelectMode((v) => !v)}
            />
            <IconChip
              icon={Plus}
              onPress={() => router.push({ pathname: '/item/new', params: { type: 'book' } })}
            />
          </View>
        </View>
        <View style={styles.head}>
          {/* Counts inventory_items ROWS, and under Model B one title is one
              row PER charter/rack — so calling it "BOOKS" claimed a title
              count the list itself contradicts the moment a collapse happens
              (47 rows rendering as 19 cards on the owner org). Same word the
              collapsed headers use, so the two read as one vocabulary. The
              list now holds the whole set, so this is an exact count of it —
              except when truncated, where it quotes the server's count and the
              line below says the list is showing less than that. */}
          <Eyebrow>{`INVENTORY · ${datasetRowCount.toLocaleString()} PLACEMENTS`}</Eyebrow>
          <Display size={34} style={{ marginTop: 12 }}>
            Book <Em>catalog.</Em>
          </Display>
        </View>

        <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 }}>
          <View
            style={[
              styles.searchBox,
              { backgroundColor: c.card, borderColor: c.hair },
            ]}
          >
            <Search size={16} color={c.ink4} strokeWidth={1.4} />
            <TextInput
              value={q}
              onChangeText={setQ}
              placeholder="Search title, ISBN, SKU…"
              placeholderTextColor={c.ink4}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus={false}
              returnKeyType="search"
              onSubmitEditing={() => Keyboard.dismiss()}
              style={[
                styles.searchInput,
                { color: c.ink, fontFamily: FONT.displayRegular },
              ]}
            />
            <FilterButton onPress={() => setSheetOpen(true)} count={filterCount} />
            <Pressable
              hitSlop={8}
              onPress={() => router.push('/scan')}
              style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
            >
              <Barcode size={18} color={c.ink} strokeWidth={1.6} />
            </Pressable>
          </View>

          <ActiveFilterPill
            state={filter}
            onClear={() => setFilter(EMPTY_FILTER_STATE)}
            lookups={{ categories: categoryMap, locations: locationMap, charters: charterMap }}
          />

          {/* Growth degrades HONESTLY. Past the server's row cap the set in
              hand is genuinely a prefix, so the list says so here and marks
              every collapsed header, instead of quietly showing short totals.
              Unreachable at today's volumes — it exists so it never becomes
              reachable silently. */}
          {truncated ? (
            <Body muted size={11.5} style={{ marginTop: 8 }}>
              {`Showing the first ${loadedRowCount.toLocaleString()} of ${(serverRowCount ?? loadedRowCount).toLocaleString()} placements. Search or filter to narrow — grouped totals below cover only the loaded rows.`}
            </Body>
          ) : null}
        </View>
      </SafeAreaView>

      {loading ? (
        <BookListSkeleton count={6} />
      ) : (
        <FlatList
          ref={listRef}
          data={groupedRows}
          keyExtractor={groupedKeyExtractor}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: tabBarHeight + 24, gap: 10 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.ink} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Display size={18}>No books match.</Display>
              <Body muted style={{ marginTop: 6, textAlign: 'center' }}>
                Scan a book on the Scan tab to add one, or import from the web.
              </Body>
            </View>
          }
          ListFooterComponent={
            /* Every number here describes what this page ACTUALLY renders:
               pages are counted in GROUPS and the row range comes from the
               slice, because group-whole pages hold a variable number of
               rows and `page × pageSize` would be a fiction. */
            <Paginator
              page={pageView.page}
              pageCount={pageView.pageCount}
              rangeStart={pageView.rangeStart}
              rangeEnd={pageView.rangeEnd}
              total={pageView.totalRows}
              onPageChange={onPageChange}
            />
          }
          renderItem={renderBookItem}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          initialNumToRender={12}
          maxToRenderPerBatch={8}
          windowSize={9}
          removeClippedSubviews={Platform.OS === 'android'}
        />
      )}

      <FilterSheet
        visible={sheetOpen}
        onDismiss={() => setSheetOpen(false)}
        state={filter}
        onChange={setFilter}
        categories={bookCategories}
        locations={locations}
        charters={charters}
      />

      <CountSelectBar visible={selectMode} bottomInset={tabBarHeight} />
    </View>
  );
}

const BookCard = React.memo(function BookCard({
  book,
  placementLabel,
  onBookPress,
  selectMode,
  onToggleSelect,
  stacked,
}: {
  book: BookRow;
  /** Set only when this row is an expanded placement of a multi-row SKU —
   *  the rack/charter/site that tells the three "Into Algebra 1" rows apart.
   *  null for every standalone book, which renders exactly as before. */
  placementLabel?: string | null;
  onBookPress: (id: string) => void;
  selectMode: boolean;
  onToggleSelect: (book: BookRow) => void;
  /** Dynamic Type: past the shared stack threshold the title takes its own
   *  full-width line above the quantity + pill. See `styles.bodyStacked`. */
  stacked: boolean;
}) {
  const { c } = useTheme();
  const picked = useIsPicked(book.id);
  const author =
    (book.custom_fields?.book_author as string | undefined)
    ?? (book.custom_fields?.author as string | undefined)
    ?? null;
  const isbn = book.barcode ?? (book.custom_fields?.isbn as string | undefined) ?? null;
  // ONE precedence ladder with the collapsed header above it (expected →
  // lifecycle → stock), so a header reading ARCHIVED can never sit over rows
  // reading OUT. Pure + tested in lib/expected-items.ts.
  const pill = stockPillFor(book);
  return (
    <Pressable
      onPress={() => (selectMode ? onToggleSelect(book) : onBookPress(book.id))}
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <Card padding={14}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <Thumb size={56} icon={BookMarked} imageUrl={book.imageUrl} />
          <View style={stacked ? styles.bodyStacked : styles.bodyRow}>
            <View style={stacked ? styles.nameColStacked : styles.nameCol}>
              {/* Unbounded, matching ItemRow's name in the Items twin: a line
                  ceiling here truncated the very title the stacked layout
                  above hands the card's full width. The card is padding-based
                  and grows for free, and a title is content (plan §3). */}
              <Body size={15.5} color={c.ink} style={{ fontFamily: FONT.display }}>
                {book.name}
              </Body>
              {author ? (
                <Mono size={11.5} tracking={0.04} color={c.ink4} numberOfLines={1} style={{ marginTop: 4 }}>
                  {author}
                </Mono>
              ) : null}
              {isbn ? (
                <Mono size={11} tracking={0.04} color={c.ink4} numberOfLines={1} style={{ marginTop: 2 }}>
                  {isbn}
                  {book.grade ? ` · Grade ${book.grade}` : ''}
                </Mono>
              ) : null}
              {placementLabel ? (
                <Mono size={11} tracking={0.04} color={c.ink4} numberOfLines={1} style={{ marginTop: 2 }}>
                  {placementLabel}
                </Mono>
              ) : null}
            </View>
            <View style={[styles.trailingCol, stacked && styles.trailingColStacked]}>
              <Mono size={17} tracking={-0.018} color={c.ink} style={{ fontFamily: FONT.display }}>
                {book.quantity_on_hand}
              </Mono>
              <Pill status={pill.status}>{pill.label}</Pill>
            </View>
          </View>
          {/* Trailing slot, ALWAYS reserved — the collapsed header spends the
              same width on its chevron, and a column that only exists on one
              of the two shifts the quantities being compared out of line. */}
          <View style={{ width: TRAILING_SLOT, alignItems: 'center' }}>
            {selectMode ? (
              picked ? (
                <CheckCircle2 size={22} color={c.ink} strokeWidth={2} />
              ) : (
                <Circle size={22} color={c.ink4} strokeWidth={1.6} />
              )
            ) : null}
          </View>
        </View>
      </Card>
    </Pressable>
  );
});

/**
 * Collapsible SKU-group header — one per book SKU with MORE than one
 * placement (Model B: a title legitimately exists once per charter/rack under
 * migration 0234). Shows the SUMMED on-hand and the rolled-up lifecycle;
 * tapping expands the individual placement rows, each of which opens its own
 * item. DISPLAY ONLY — `total` is a read-time sum, never a written record.
 *
 * Deliberately shows NO author / ISBN / grade / rack: those are per-placement
 * and can genuinely differ, so rendering the first placement's value would
 * assert it for the whole group. The chevron reveals each row instead.
 *
 * In select mode this stays expand-only — a header has no item id behind it,
 * so it can never be added to a cycle count. Placements become selectable the
 * moment they are expanded, matching the Items list.
 */
const BookGroupHeaderCard = React.memo(function BookGroupHeaderCard({
  name,
  total,
  reorderPoint,
  placementCount,
  partial,
  lifecycle,
  imageUrl,
  expected,
  expanded,
  onToggle,
  stacked,
}: {
  name: string;
  total: number;
  reorderPoint: number;
  /** Placements in the group — i.e. exactly the rows the chevron reveals. */
  placementCount: number;
  /** True when the figures cover the loaded rows only — disclosed, never hidden. */
  partial: boolean;
  lifecycle: LifecycleStatus;
  imageUrl: string | null;
  /** Every placement is an awaiting-first-receipt phantom (derived from rows). */
  expected: boolean;
  expanded: boolean;
  onToggle: () => void;
  /** Dynamic Type: stacks with BookCard, or the header's title would fracture
   *  while the placement rows it expands to read whole. */
  stacked: boolean;
}) {
  const { c } = useTheme();
  // Same ladder the rows below run (lib/expected-items.ts) — the header's
  // inputs are the group's rolled-up lifecycle and summed quantity, so it can
  // only differ from a child where the NUMBERS differ, never the rules.
  const badge = stockPill({
    expected,
    lifecycle,
    quantity: total,
    reorderPoint,
  });
  // Two honest shapes: exact ("3 placements"), and page-local, where the
  // count covers only the rows loaded here.
  const placements = partial
    ? `${placementCount} placement${placementCount === 1 ? '' : 's'} shown`
    : `${placementCount} placement${placementCount === 1 ? '' : 's'}`;
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} ${name}, ${placements}${
        partial ? `, at least ${total} on hand` : ''
      }`}
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <Card padding={14}>
        {/* Same padding + gap + 56px thumb as BookCard so the header's thumb
            and title share the exact left edge with the placement rows it
            expands to. The disclosure chevron therefore sits at the TRAILING
            edge: leading it would push the header 28px right of its own
            children, which read as a broken hierarchy. It lives in the SAME
            fixed-width slot BookCard reserves, so aligning the left edge does
            not cost the alignment of the numbers being compared. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <Thumb size={56} icon={BookMarked} imageUrl={imageUrl} />
          <View style={stacked ? styles.bodyStacked : styles.bodyRow}>
            <View style={stacked ? styles.nameColStacked : styles.nameCol}>
              {/* Unbounded, matching the placement cards this header expands
                  to and the SKU-group header in the Items twin. */}
              <Body size={15.5} color={c.ink} style={{ fontFamily: FONT.display }}>
                {name}
              </Body>
              <Mono size={11} tracking={0.04} color={c.ink4} numberOfLines={1} style={{ marginTop: 4 }}>
                {placements}
              </Mono>
            </View>
            <View style={[styles.trailingCol, stacked && styles.trailingColStacked]}>
              <Mono size={17} tracking={-0.018} color={c.ink} style={{ fontFamily: FONT.display }}>
                {/* A page-only sum is marked with a leading ≥ rather than
                    presented as the title's stock. */}
                {partial ? `≥${total}` : total}
              </Mono>
              <Pill status={badge.status}>{badge.label}</Pill>
            </View>
          </View>
          <View style={{ width: TRAILING_SLOT, alignItems: 'center' }}>
            <ChevronRight
              size={18}
              color={c.ink4}
              strokeWidth={2}
              style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }}
            />
          </View>
        </View>
      </Card>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  root: { flex: 1 },
  topbar: {
    paddingHorizontal: 12,
    paddingTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  head: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 4,
  },
  // Dynamic Type: minHeight, not height, and no `height: '100%'` on the input
  // — see the identical twin in (tabs)/inventory.tsx. The fixed height plus a
  // 100%-tall input guillotines the typed text and the caret at AX sizes.
  searchBox: {
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 4,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    fontSize: 14.5,
    minHeight: 36,
    letterSpacing: -0.17,
  },
  empty: { padding: 32, alignItems: 'center' },
  /**
   * Dynamic Type: trailing quantity + status-pill column. RN's default
   * `flexShrink: 0` lets it claim full intrinsic width, collapsing the
   * `flex: 1, minWidth: 0` title column beside it to a few characters a line.
   *
   * The ceiling is a POINT value, never a percentage — the twin of
   * `rowStyles.trailingCol` in (tabs)/inventory.tsx, and for the same reason.
   * `'40%'` resolved against the ROW while this column was a direct child of
   * it; nesting it inside `bodyRow` re-based the SAME literal on a box that
   * excludes the thumb, the trailing slot and the gaps, taking the ceiling
   * from 129pt to 87pt on a 393pt screen and from 122pt to 80pt on a 375pt
   * one. An 8-character `ARCHIVED` / `EXPECTED` pill needs 85.6pt at DEFAULT
   * size, so 80 clamped it — and `Pill`'s label shrinks rather than overflows,
   * with no space in the word to wrap at. See `TRAILING_COLUMN_MAX_WIDTH`.
   */
  trailingCol: {
    alignItems: 'flex-end',
    gap: 6,
    maxWidth: TRAILING_COLUMN_MAX_WIDTH,
    flexShrink: 1,
  },
  /**
   * Dynamic Type: the title and the trailing column, side by side then stacked.
   * The twin of `rowStyles.bodyRow` in (tabs)/inventory.tsx — same threshold,
   * same shape; keep the two in step.
   *
   * `Sunglasse/s` is a WIDTH defect, not a text one: iOS breaks inside a word
   * only when the word cannot fit its container at any break opportunity, and
   * React Native exposes no `overflow-wrap`. Measured on a 393pt screen, this
   * list is tighter than the Items one — 20pt of list padding a side leaves a
   * 353pt card, whose 1pt border and 14pt padding a side leave 323pt of
   * interior, and the 56pt thumb, the 22pt trailing slot and two 14pt gaps
   * take 106pt of that. So the title and the trailing column share 217pt, and
   * held side by side at AX3 the trailing column would take its full 106pt
   * ceiling, leaving the title ~97pt — against the ~177pt a 10-character title
   * needs at 15.5 x 2.286. It cannot fit, so iOS breaks the glyph run. Select
   * mode costs nothing here: the trailing slot is reserved either way.
   *
   * Past the shared `shouldStackRow` threshold the two become a column and the
   * title gets the whole 217pt. No cap, no truncation, and no soft hyphens or
   * zero-width spaces in the name — those would corrupt the very string users
   * search and copy. Just the width the word needs.
   */
  bodyRow: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  bodyStacked: {
    flex: 1,
    minWidth: 0,
    gap: 8,
  },
  nameCol: { flex: 1, minWidth: 0 },
  // No flex: in a column parent `flex: 1` divides HEIGHT, not width. The
  // default `alignItems: 'stretch'` on bodyStacked is what hands over the width.
  nameColStacked: { minWidth: 0 },
  // Once stacked, the quantity + pill read left-to-right on their own line and
  // must NOT keep the 40% ceiling (they own the full width now). `flexWrap`
  // lets a long pill label drop below the quantity rather than squeeze it.
  trailingColStacked: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
    maxWidth: '100%',
  },
});
