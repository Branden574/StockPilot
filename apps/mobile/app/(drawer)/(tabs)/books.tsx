import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import {
  ArrowLeft,
  Barcode,
  BookMarked,
  Check,
  ChevronRight,
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
  GROUP_COPY,
  formatPlacementLabel,
  resolvePlacement,
  type DisplayGroupRef,
} from '@stockpilot/core';

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
import { CheckboxMark } from '@/components/ui/checkbox';
import { Paginator } from '@/components/ui/paginator';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { BookListSkeleton } from '@/components/ui/skeleton';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { Thumb } from '@/components/ui/thumb';
import { onRecordsUngrouped } from '@/lib/ungroup-selected';
import { countSelection, useIsPicked } from '@/lib/use-count-selection';
import { showWriteCtaForRole } from '@/lib/cta-gating';
import {
  attachDisplayGroups,
  groupRowAccessibilityActions,
  groupSelectedHref,
  listIsNarrowed,
  onDisplayGroupsChanged,
  readDisplayGroups,
  runGroupRowAccessibilityAction,
} from '@/lib/display-groups';
import { TRAILING_COLUMN_MAX_WIDTH, shouldStackRow } from '@/lib/dynamic-type-layout';
import {
  listStatusPredicate,
  stockPill,
  stockPillFor,
  type LifecycleStatus,
} from '@/lib/expected-items';
import { signListThumbnails } from '@/lib/image-cache';
import { readErrorMessage, settleIdBatchRead } from '@/lib/id-batches';
import { NO_PLACEMENT_HOLDINGS, readPlacementHoldings, readPrimaryPhotos } from '@/lib/id-reads';
import { resolveListThumbnails } from '@/lib/list-thumbnails';
import { onlySiteLocations } from '@/lib/location-filter';
import { goBackFromReturn } from '@/lib/return-path';
import {
  buildGroupUnits,
  buildGroupedRows,
  firstCoverBySku,
  ungroupFactsByItem,
  type GroupedRow,
} from '@/lib/inventory-grouping';
import {
  GROUPS_PER_PAGE,
  POSTGREST_MAX_ROWS,
  paginateGroups,
  readIsComplete,
} from '@/lib/inventory-paging';
import { supabase } from '@/lib/supabase';
import { FONT, RADIUS } from '@/lib/theme';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { useRole } from '@/lib/use-role';
import { useTheme } from '@/lib/use-theme';
import { useWorkspace } from '@/lib/use-workspace';
import { inventoryViewPredicate } from '@stockpilot/core';

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
  /** Group selected (0400): the record's explicit display group, read from
   *  item_display_group_members next to the list and attached (never a column
   *  of the item). Display only. */
  display_group_id?: string | null;
  display_group_name?: string | null;
  display_group_version?: number | null;
}

/** One flattened Books-list entry: an explicit display group's header, a
 *  collapsed same-SKU header, or a book row. */
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

/** One definition of the Books tab, shared with the web list. */
const BOOKS_VIEW = inventoryViewPredicate('books');

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
  // Group selected (0400): the organization's explicit display groups by
  // record id, read under the member's RLS with every load (in parallel with
  // the rows) and again after a Save elsewhere; and the groups expanded here.
  const [displayGroups, setDisplayGroups] = React.useState<ReadonlyMap<string, DisplayGroupRef>>(
    new Map(),
  );
  const [expandedExplicitGroups, setExpandedExplicitGroups] = React.useState<Set<string>>(
    new Set(),
  );
  // "Add to group" is offered to someone who can edit items. Cosmetic only:
  // the review screen and POST /api/v1/items/grouping decide.
  const { role } = useRole();
  const permissions = useEffectivePermissions();
  const canEditItems = showWriteCtaForRole(role, permissions, 'items:update');
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
  // Rack/crate HOLDINGS for the loaded set, keyed by item id — WHERE THE STOCK
  // IS, as against what each row's custom_fields remember. Fetched in ONE
  // batched request per load (the list already holds the whole filtered set,
  // capped at POSTGREST_MAX_ROWS), because without `locations.kind` the card
  // cannot tell a book that has moved into a crate from one still on its rack,
  // and prints the departed rack. See placement-resolution.ts. The same read
  // carries every OTHER placed holding (`other`: a Site, an area), without
  // which a book whose stock all sits on the Site printed the rack it left
  // (B37).
  const [holdings, setHoldings] = React.useState(NO_PLACEMENT_HOLDINGS);
  // Why the holdings above are empty when they did not load. The cards then
  // fall back to the stored custom_fields rack label, which can be out of date,
  // so the screen says so instead of passing the stale label off as current.
  const [holdingsError, setHoldingsError] = React.useState<string | null>(null);
  // A list read that FAILED is not an empty shelf: shown above the list rather
  // than left to "No books match.".
  const [loadError, setLoadError] = React.useState<string | null>(null);
  // Load token: only the newest load may write state. The load is debounced
  // and pull-to-refresh can overlap it, so an older load finishing late could
  // otherwise put back its (possibly failed) answer over a newer one.
  const loadSeq = React.useRef(0);
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
  // The select bar's measured height (it grows when its actions wrap at large
  // text sizes). While it shows, the list's end clears it too, so the last
  // cards and the pager are never left under the bar. Identical to Items.
  const [selectBarHeight, setSelectBarHeight] = React.useState(0);

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
      // Sites only, as the web's filter offers them (core isSiteLocation, see
      // lib/location-filter.ts): never a rack, shelf, crate, bin or area, never
      // the Staging or Unplaced bucket.
      onlySiteLocations(
        supabase
          .from('locations')
          .select('id, name')
          .eq('organization_id', orgId)
          .is('deleted_at', null),
      ).order('name', { ascending: true }),
      supabase
        .from('charters')
        .select('id, name, code')
        .eq('organization_id', orgId)
        .order('name', { ascending: true }),
    ]);
    setBookCategories(((cats.data ?? []) as { id: string; name: string }[]) ?? []);
    setLocations(((locs.data ?? []) as { id: string; name: string }[]) ?? []);
    setCharters(
      ((chts.data ?? []) as { id: string; name: string; code: string | null }[]).map((c) => ({
        id: c.id,
        name: c.code ? `${c.name} · ${c.code}` : c.name,
      })),
    );
  }, [orgId]);

  const load = React.useCallback(
    async (query: string, f: FilterState, _allBookCatIds: string[]) => {
      if (!orgId) return;
      const seq = (loadSeq.current += 1);
      const isCurrent = () => seq === loadSeq.current;
      // Every error flag belongs to ONE load: a new load starts clean.
      setLoadError(null);
      setHoldingsError(null);

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
          .eq('item_type', BOOKS_VIEW.itemType)
          .eq('is_rental', BOOKS_VIEW.isRental)
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
          // in-list-bound: user-picked category filter chips
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
          // The record's LOCATION, as the web and the Items tab filter (see
          // lib/location-filter.ts).
          // in-list-bound: user-picked location filter chips
          r = r.in('primary_location_id', f.locationIds);
        }
        if (f.charterIds.length > 0) {
          const wantsGeneric = f.charterIds.includes(FILTER_GENERIC_CHARTER_ID);
          const real = f.charterIds.filter((x) => x !== FILTER_GENERIC_CHARTER_ID);
          if (wantsGeneric && real.length > 0) {
            // in-list-bound: user-picked charter filter chips
            r = r.or(`charter_id.is.null,charter_id.in.(${real.join(',')})`);
          } else if (wantsGeneric) {
            r = r.is('charter_id', null);
          } else {
            // in-list-bound: user-picked charter filter chips
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
      // Group selected (0400): the memberships, read beside the rows (never a
      // column of them). It never fails the list: a failed read groups
      // nothing, and the cards render as they always did.
      const groupsRead = readDisplayGroups(supabase as never, orgId);
      const { data, count, error, status: listStatus } = await scoped(BOOK_COLUMNS, { count: 'exact' })
        .order(ord.col, { ascending: ord.asc })
        .order('id', { ascending: true })
        .limit(POSTGREST_MAX_ROWS);
      if (!isCurrent()) return;
      const nextDisplayGroups = await groupsRead;
      if (!isCurrent()) return;
      // FAIL LOUD: a refused read used to be a console.warn and "No books
      // match.", a claim about the org's shelves made from an error.
      // readErrorMessage: never empty (an empty gateway error body would
      // otherwise hide the notice and leave "No books match.").
      if (error) {
        console.warn('books list', error);
        setLoadError(readErrorMessage(error, listStatus));
      }

      let bookRows: BookRow[] = (data ?? []).map(toBookRow);
      const returned = bookRows.length;

      // 'low' stays a client pass (reorder_point is per-row and cannot be
      // expressed in a PostgREST filter) — but it now runs over the COMPLETE
      // set rather than a widened window, so it is an ordinary filter like any
      // other, not a source of missing siblings.
      if (isLow) {
        bookRows = bookRows.filter(
          (r) =>
            r.reorder_point > 0 && r.quantity_on_hand <= r.reorder_point && r.quantity_on_hand > 0,
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
      setDisplayGroups(nextDisplayGroups);
      setServerRowCount(count ?? null);
      setLoadedRowCount(returned);

      // Holdings for exactly the rows just loaded, batched (the set can be
      // 1000 rows, far past what one `.in()` URL carries). A failure is
      // non-fatal but NOT silent: the cards fall back to the custom_fields
      // label, and the notice above the list says that label may be out of
      // date. Nothing is cached, so the next load reads again.
      const ids = bookRows.map((b) => b.id);
      if (ids.length > 0) {
        const holdingsRead = await settleIdBatchRead(readPlacementHoldings(supabase, orgId, ids));
        if (!isCurrent()) return;
        if (holdingsRead.ok) {
          setHoldings(holdingsRead.value);
        } else {
          console.warn('books holdings', holdingsRead.message);
          setHoldings(NO_PLACEMENT_HOLDINGS);
          setHoldingsError(holdingsRead.message);
        }
      } else {
        setHoldings(NO_PLACEMENT_HOLDINGS);
      }
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: every set is post-await; the effect synchronizes with the server
    void loadLookups();
  }, [orgId, loadLookups]);

  // Whenever the query / filter / workspace changes, jump back to page 1.
  // Expanded SKU groups are per-page display state, so drop them too — an
  // expansion carried over from another result set reads as a glitch.
  React.useEffect(() => {
    setPage(1); // eslint-disable-line react-hooks/set-state-in-effect -- result-set reset: page/expansion are per-result-set display state and must drop when q/filter/workspace change; one-shot synchronous resets, no cascade (trailing form: inventory-list-wiring.test.ts pins `{ setPage(1);` verbatim)
    setExpandedSkuGroups(new Set());
    setExpandedExplicitGroups(new Set());
  }, [q, filter, activeWarehouseId]);

  // A grouping saved elsewhere (the review screen, the item screen): re-read
  // the memberships only. A display group changes nothing on a record, so the
  // rows in hand stay right.
  React.useEffect(() => {
    if (!orgId) return;
    let live = true;
    const off = onDisplayGroupsChanged(() => {
      void readDisplayGroups(supabase as never, orgId).then((next) => {
        if (live) setDisplayGroups(next);
      });
    });
    return () => {
      live = false;
      off();
    };
  }, [orgId]);

  // NOT keyed on `page` any more: a page flip is a client-side slice of the
  // set already in memory, so it costs no request and no skeleton.
  React.useEffect(() => {
    if (!orgId) return;
    const t = setTimeout(() => void load(q, filter, bookCatIds), 250);
    return () => clearTimeout(t);
  }, [q, filter, bookCatIds, load, orgId, activeWarehouseId]);

  // An Ungroup saved on the review screen (owner 2026-10-12) can change a
  // record's SKU as well as its group: re-read the rows (and their
  // memberships with them), not the memberships alone.
  React.useEffect(() => {
    if (!orgId) return;
    return onRecordsUngrouped(() => void load(q, filter, bookCatIds));
  }, [q, filter, bookCatIds, load, orgId]);

  async function refresh() {
    setRefreshing(true);
    await load(q, filter, bookCatIds);
    setRefreshing(false);
  }

  const onPageChange = React.useCallback((p: number) => {
    setPage(p);
    setExpandedSkuGroups(new Set());
    setExpandedExplicitGroups(new Set());
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

  const toggleSkuGroup = React.useCallback((sku: string) => {
    setExpandedSkuGroups((prev) => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });
  }, []);

  const toggleExplicitGroup = React.useCallback((groupId: string) => {
    setExpandedExplicitGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  // "Add to group" on a book that shares a SKU with a group here: the review
  // opens on that group for this one book. Nothing joins a group by itself.
  const onAddToGroup = React.useCallback(
    (itemId: string, groupId: string) => {
      router.push(groupSelectedHref({ itemIds: [itemId], view: 'books', groupId }));
    },
    [router],
  );

  // Secondary line for an expanded placement. Books split by charter/rack
  // (mig 0234), so the PLACEMENT is the most concrete differentiator staff
  // physically walk to; charter and site are the fallbacks.
  //
  // The rack pair used to be read inline here — a fourth hand-rolled copy of
  // readBookStorage, and one that did not consult the holdings. It therefore
  // printed rack 38-A for a book whose stock had moved entirely into "Blue
  // Shelf". The decision is now resolvePlacement's; this callback only picks
  // the compact rendering the narrow card has room for (bare "38-A", not
  // "Rack 38-A · Crate Red 5"). A book whose stock all sits on the Site reads
  // the Site and its count ("DC4 ×7"), as one wholly in a crate reads the
  // crate (B37).
  //
  // `bin_location` is deliberately NOT fed in. It would rank ahead of charter
  // and site for a row with no holdings and no rack pair, which is a different
  // set of books from the ones this fix is about — and a pre-0335 free-text bin
  // is exactly as capable of being stale as the rack pair was, so promoting it
  // there trades one stale label for another. The card's fallback order stays
  // rack, then charter, then site.
  const placementLabelFor = React.useCallback(
    (b: BookRow): string | null => {
      const res = resolvePlacement({
        itemType: 'book',
        customFields: b.custom_fields,
        holdings: holdings.rack.get(b.id),
        otherHoldings: holdings.other.get(b.id),
      });
      const charter = b.charter_id ? (charterMap.get(b.charter_id) ?? null) : null;
      const loc = b.primary_location_id ? (locationMap.get(b.primary_location_id) ?? null) : null;
      switch (res.source) {
        case 'holdings':
          return formatPlacementLabel(res);
        case 'structured':
          return res.rackLabel ?? charter ?? loc;
        default:
          return charter ?? loc;
      }
    },
    [charterMap, locationMap, holdings],
  );

  // ── GROUP FIRST, THEN PAGE ────────────────────────────────────────────────
  // The whole filtered set is grouped into display UNITS (one collapsed SKU
  // family, or one standalone title = one card), and the PAGE is a slice of
  // units. That is the requirement: three placements of one SKU are one header
  // on ONE page, all three behind the chevron, whatever the sort or page size.
  // Size runs stay OFF — a book is never sized, which is why the web table
  // gates that pass behind `showBookFields`.
  // Each record wears its display group (0400) before grouping, so core's one
  // rule (explicit group, then same SKU) decides the units.
  const groupedBookRows = React.useMemo(
    () => attachDisplayGroups(rows, displayGroups),
    [rows, displayGroups],
  );
  const units = React.useMemo(
    () => buildGroupUnits(groupedBookRows, { enableSizeRuns: false }),
    [groupedBookRows],
  );
  // Ungroup anything (owner 2026-10-12): what each book would leave on
  // Ungroup (its group, a shared SKU, and the one it is shown under in these
  // units), kept with the pick when it is ticked.
  const ungroupFacts = React.useMemo(
    () => ungroupFactsByItem(groupedBookRows, { enableSizeRuns: false }),
    [groupedBookRows],
  );
  const onToggleSelect = React.useCallback(
    (b: BookRow) => {
      countSelection.toggle({
        id: b.id,
        sku: b.sku,
        name: b.name,
        itemType: 'book',
        grouping: ungroupFacts.get(b.id),
      });
    },
    [ungroupFacts],
  );
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
    truncated && filter.status !== 'low' ? (serverRowCount ?? rows.length) : rows.length;

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
    if (!orgId || unresolvedIds.length === 0) return;
    let cancelled = false;
    void (async () => {
      // Batched (a page can hold every placement of 50 titles), and a failed
      // read or signing round records NOTHING: the covers show the glyph for
      // now and the next page view or pull-to-refresh asks again. It used to
      // ignore the read's error and record every id as "no cover".
      //
      // Never the full-res original (huge bitmaps for a 56px row): the stored
      // thumbnail when the cover has one, the on-demand transform only when it
      // does not. See signListThumbnails and inventory.tsx.
      const round = await resolveListThumbnails(
        unresolvedIds,
        (ids) => readPrimaryPhotos(supabase, orgId, ids),
        signListThumbnails,
      );
      if (cancelled) return;
      if (!round.ok) {
        console.warn('book covers', round.message);
        return;
      }
      // null records "resolved, no cover" so a coverless book is asked about
      // exactly once; a cover that did not sign stays unresolved.
      setImages(round.value);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, unresolvedIds]);

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
        expandedExplicitGroups,
        placementLabelFor,
        enableSizeRuns: false,
        datasetIsTruncated: truncated,
      }),
    [pageRows, expandedSkuGroups, expandedExplicitGroups, placementLabelFor, truncated],
  );

  // A collapsed header shows the group's cover. A SKU is one product identity
  // under 0234, so every placement is the same title — but only one placement
  // may actually carry the uploaded image, so this takes the first NON-NULL
  // cover rather than the first placement's. GroupedRow deliberately carries
  // no image, so resolve it here.
  const firstImageBySku = React.useMemo(() => firstCoverBySku(pageRows), [pageRows]);

  // P5: an explicit header says "N matching" under a search or a filter.
  const narrowed = listIsNarrowed(q, filter);

  const renderBookItem = React.useCallback(
    ({ item: row }: { item: BookGroupedRow }) => {
      if (row.kind === 'explicit-header') {
        // Group selected (0400): a group with two or more of its books here.
        // Same card as a SKU group; it counts records, not placements. Its
        // cover is the first of its books, in the order it lists them, that
        // has one (owner 2026-10-12, overruling P5's "no cover"); none keeps
        // the placeholder.
        return (
          <BookGroupHeaderCard
            name={row.name}
            total={row.total}
            reorderPoint={row.reorderPoint}
            placementCount={row.recordCount}
            countLabel={GROUP_COPY.headerCount(row.recordCount, narrowed)}
            partial={row.partial}
            lifecycle={row.status}
            imageUrl={row.coverUrl}
            expected={row.expected}
            expanded={expandedExplicitGroups.has(row.groupId)}
            onToggle={() => toggleExplicitGroup(row.groupId)}
            stacked={stackRows}
          />
        );
      }
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
          groupChip={row.groupChip ?? null}
          addToGroupId={canEditItems && !selectMode ? (row.addToGroupId ?? null) : null}
          onAddToGroup={onAddToGroup}
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
      expandedExplicitGroups,
      toggleExplicitGroup,
      canEditItems,
      onAddToGroup,
      firstImageBySku,
      stackRows,
      narrowed,
    ],
  );

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            <IconChip
              icon={ArrowLeft}
              onPress={() => goBackFromReturn(router, returnPath)}
              accessibilityLabel="Back"
              minTap
            />
            <IconChip icon={Menu} onPress={openDrawer} accessibilityLabel="Open menu" minTap />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            <IconChip
              icon={selectMode ? Check : ListChecks}
              onPress={() => setSelectMode((v) => !v)}
              accessibilityLabel={selectMode ? 'Done selecting' : 'Select books'}
              minTap
            />
            <IconChip
              icon={Plus}
              onPress={() => router.push({ pathname: '/item/new', params: { type: 'book' } })}
              accessibilityLabel="New book"
              minTap
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
              line below says the list is showing less than that. A failed
              read holds no rows, so it quotes no count rather than "0". */}
          <Eyebrow>
            {loadError !== null
              ? 'INVENTORY · PLACEMENTS'
              : `INVENTORY · ${datasetRowCount.toLocaleString()} PLACEMENTS`}
          </Eyebrow>
          <Display size={34} style={{ marginTop: 12 }}>
            Book <Em>catalog.</Em>
          </Display>
        </View>

        <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 }}>
          {/* The Items twin's search box: the stronger border, the muted-ink
              icon and placeholder (the faint ink4 held it under AA). */}
          <View style={[styles.searchBox, { backgroundColor: c.card, borderColor: c.hair2 }]}>
            <Search size={16} color={c.ink3} strokeWidth={1.4} />
            <TextInput
              value={q}
              onChangeText={setQ}
              placeholder="Search title, ISBN, SKU…"
              placeholderTextColor={c.ink3}
              // The placeholder's words name the field only while it holds
              // text, so VoiceOver still says what the field is once something
              // is typed in it. An empty field takes no name: iOS reads its
              // placeholder there, and a name as well would say it twice.
              accessibilityLabel={q.length > 0 ? 'Search title, ISBN, SKU…' : undefined}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus={false}
              returnKeyType="search"
              onSubmitEditing={() => Keyboard.dismiss()}
              style={[styles.searchInput, { color: c.ink, fontFamily: FONT.displayRegular }]}
            />
            <FilterButton onPress={() => setSheetOpen(true)} count={filterCount} />
            {/* D29: the scan button had no name and no role, so VoiceOver
                found an unlabelled element. It takes the Items tab's words,
                and a 44pt frame for its 34pt target. */}
            <Pressable
              onPress={() => router.push('/scan')}
              style={({ pressed }) => [styles.scanFrame, { opacity: pressed ? 0.7 : 1 }]}
              accessibilityRole="button"
              accessibilityLabel="Open scanner"
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

          {/* A READ that failed is not an empty shelf. */}
          {loadError !== null ? (
            <Body size={11.5} color={c.warnText} style={{ marginTop: 8 }}>
              {`Could not load books: ${loadError}. Pull to retry.`}
            </Body>
          ) : null}

          {/* Holdings did not load, so each card shows its STORED rack label,
              which can be out of date. Say so rather than pass it off as
              where the book is now. */}
          {holdingsError ? (
            <Body size={11.5} color={c.warnText} style={{ marginTop: 8 }}>
              {"Rack locations did not load, so a book's rack label may be out of date. Pull down to try again."}
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
          contentContainerStyle={{
            paddingHorizontal: 20,
            // In select mode the list ends 12pt above the floating bar, so
            // the pager under the last card is never hidden behind it.
            paddingBottom: tabBarHeight + 24 + (selectMode ? selectBarHeight : 0),
            gap: 10,
          }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.ink} />
          }
          ListEmptyComponent={
            /* A failed read leaves no rows. Saying "No books match." under the
               failure notice would contradict it. */
            loadError !== null ? (
              <View style={styles.empty}>
                <Display size={18}>Books did not load.</Display>
                <Body muted style={{ marginTop: 6, textAlign: 'center' }}>
                  Pull down to try again.
                </Body>
              </View>
            ) : (
              <View style={styles.empty}>
                <Display size={18}>No books match.</Display>
                <Body muted style={{ marginTop: 6, textAlign: 'center' }}>
                  Scan a book on the Scan tab to add one, or import from the web.
                </Body>
              </View>
            )
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

      <CountSelectBar
        visible={selectMode}
        bottomInset={tabBarHeight}
        onHeight={setSelectBarHeight}
      />
    </View>
  );
}

const BookCard = React.memo(function BookCard({
  book,
  placementLabel,
  groupChip,
  addToGroupId,
  onAddToGroup,
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
  /** Group selected (0400): "In group <name>" (its group has only it here) or
   *  "Same SKU as records in <name>"; null otherwise. */
  groupChip?: string | null;
  /** With the second chip, for an editor: the group "Add to group" opens the
   *  review on. Null hides the button. */
  addToGroupId?: string | null;
  onAddToGroup?: (itemId: string, groupId: string) => void;
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
    (book.custom_fields?.book_author as string | undefined) ??
    (book.custom_fields?.author as string | undefined) ??
    null;
  const isbn = book.barcode ?? (book.custom_fields?.isbn as string | undefined) ?? null;
  // ONE precedence ladder with the collapsed header above it (expected →
  // lifecycle → stock), so a header reading ARCHIVED can never sit over rows
  // reading OUT. Pure + tested in lib/expected-items.ts.
  const pill = stockPillFor(book);
  return (
    <Pressable
      onPress={() => (selectMode ? onToggleSelect(book) : onBookPress(book.id))}
      // In select mode the whole card is the checkbox (D29): VoiceOver says
      // "checkbox" and whether it is ticked, from the same per-row
      // subscription that draws the box. Outside it the card opens the book,
      // so it is announced as a button (it had no role at all).
      accessibilityRole={selectMode ? 'checkbox' : 'button'}
      accessibilityState={selectMode ? { checked: picked } : undefined}
      // Add to group sits inside this Pressable, so VoiceOver cannot reach it
      // as its own element (P4): the card carries it as an action, and
      // 'activate' keeps a double tap doing what a tap does.
      accessibilityActions={groupRowAccessibilityActions(!!(addToGroupId && onAddToGroup))}
      onAccessibilityAction={(e) =>
        runGroupRowAccessibilityAction(e.nativeEvent.actionName, {
          activate: () => (selectMode ? onToggleSelect(book) : onBookPress(book.id)),
          addToGroup: () => {
            if (addToGroupId && onAddToGroup) onAddToGroup(book.id, addToGroupId);
          },
        })
      }
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      {/* A picked card takes the accent wash, as an Items row does (the
          web's selected row, DESIGN-SPEC 6.21); the ticked box is its cue
          beyond colour. Books cards had no picked fill at all. */}
      <Card padding={14} style={picked ? { backgroundColor: c.accentWash } : undefined}>
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
              {/* Author, ISBN and grade, and the placement: information, so
                  the muted ink (the faint ink4 held them under AA). */}
              {author ? (
                <Mono
                  size={11.5}
                  tracking={0.04}
                  color={c.ink3}
                  numberOfLines={1}
                  style={{ marginTop: 4 }}
                >
                  {author}
                </Mono>
              ) : null}
              {isbn ? (
                <Mono
                  size={11.5}
                  tracking={0.04}
                  color={c.ink3}
                  numberOfLines={1}
                  style={{ marginTop: 2 }}
                >
                  {isbn}
                  {book.grade ? ` · Grade ${book.grade}` : ''}
                </Mono>
              ) : null}
              {placementLabel ? (
                <Mono
                  size={11.5}
                  tracking={0.04}
                  color={c.ink3}
                  numberOfLines={1}
                  style={{ marginTop: 2 }}
                >
                  {placementLabel}
                </Mono>
              ) : null}
              {groupChip ? (
                // Content, so uncapped: it wraps under the title at any size.
                <View style={styles.chipLine}>
                  <Mono size={10.5} color={c.ink3} tracking={0.02}>
                    {groupChip}
                  </Mono>
                  {addToGroupId && onAddToGroup ? (
                    <Pressable
                      onPress={() => onAddToGroup(book.id, addToGroupId)}
                      accessibilityRole="button"
                      accessibilityLabel={`${GROUP_COPY.addToGroup}: ${book.name}`}
                      style={({ pressed }) => [
                        styles.addToGroupFrame,
                        { opacity: pressed ? 0.6 : 1 },
                      ]}
                    >
                      <View style={[styles.addToGroup, { borderColor: c.hair2 }]}>
                        <Mono size={10.5} color={c.ink} tracking={0.02}>
                          {GROUP_COPY.addToGroup}
                        </Mono>
                      </View>
                    </Pressable>
                  ) : null}
                </View>
              ) : null}
            </View>
            <View style={[styles.trailingCol, stacked && styles.trailingColStacked]}>
              <Mono size={15} color={c.ink} style={styles.quantity}>
                {book.quantity_on_hand}
              </Mono>
              <Pill status={pill.status}>{pill.label}</Pill>
            </View>
          </View>
          {/* Trailing slot, ALWAYS reserved — the collapsed header spends the
              same width on its chevron, and a column that only exists on one
              of the two shifts the quantities being compared out of line. The
              shared box (P2.5b) is 22pt, the slot's width, so it still lines
              up with the header's chevron. A mark, not a Checkbox: the card
              above is the one control. */}
          <View style={{ width: TRAILING_SLOT, alignItems: 'center' }}>
            {selectMode ? <CheckboxMark checked={picked} /> : null}
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
  countLabel,
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
  /** Group selected (0400): an explicit group's header counts RECORDS ("3
   *  records"), not placements. Absent: "N placement(s)". */
  countLabel?: string;
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
  const counted = countLabel ?? `${placementCount} placement${placementCount === 1 ? '' : 's'}`;
  const placements = partial ? `${counted} shown` : counted;
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} ${name}, ${placements}${
        partial ? `, at least ${total} on hand` : ''
      }`}
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      {/* The header recipe, as on the Items tab: the recessed fill (sunk)
          marks the card as a group over the white placement cards it opens
          to (DESIGN-SPEC 6.21). */}
      <Card padding={14} style={{ backgroundColor: c.sunk }}>
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
              <Mono
                size={11.5}
                tracking={0.04}
                color={c.ink3}
                numberOfLines={1}
                style={{ marginTop: 4 }}
              >
                {placements}
              </Mono>
            </View>
            <View style={[styles.trailingCol, stacked && styles.trailingColStacked]}>
              <Mono size={15} color={c.ink} style={styles.quantity}>
                {/* A page-only sum is marked with a leading ≥ rather than
                    presented as the title's stock. */}
                {partial ? `≥${total}` : total}
              </Mono>
              <Pill status={badge.status}>{badge.label}</Pill>
            </View>
          </View>
          {/* Muted ink: the chevron says open or closed (ink4 is under 3:1 on
              the recessed fill in light mode). */}
          <View style={{ width: TRAILING_SLOT, alignItems: 'center' }}>
            <ChevronRight
              size={18}
              color={c.ink3}
              strokeWidth={1.8}
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
  // The chips' 44pt frames (IconChip minTap) are 3pt wider than the 38pt chip
  // on every side, so the bar takes 3pt off its padding (12, 8) and what sits
  // under it 3pt off its top: the chips and the title sit where they did (gap between chips 8 -> 2).
  topbar: {
    paddingHorizontal: 9,
    paddingTop: 5,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  head: {
    paddingHorizontal: 20,
    paddingTop: 9,
    paddingBottom: 4,
  },
  // Dynamic Type: minHeight, not height, and no `height: '100%'` on the input
  // — see the identical twin in (tabs)/inventory.tsx. The fixed height plus a
  // 100%-tall input guillotines the typed text and the caret at AX sizes.
  searchBox: {
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 4,
    // The shared Field's corner (RADIUS.tile), so the phone's inputs match.
    borderRadius: RADIUS.tile,
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
  // Open scanner's target: a real 44pt frame around the 18pt icon (it was the
  // icon plus an 8pt slop, 34pt) — the twin of inventory.tsx `scanFrame`. The
  // frame takes the box's 4pt top and bottom padding and 13pt of its right
  // padding, so the icon stays where it was, and only 4pt of the gap before
  // it, which keeps it clear of the filter button's own 6pt slop.
  scanFrame: {
    minWidth: 44,
    minHeight: 44,
    marginVertical: -4,
    marginLeft: -4,
    marginRight: -13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: { padding: 32, alignItems: 'center' },
  // The on-hand figure: mono with tabular numerals, as on the Items tab, so
  // the figures line up down the list. Content, so uncapped.
  quantity: {
    letterSpacing: 0,
    fontVariant: ['tabular-nums'],
  },
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
  // Group selected (0400): the chip line under a book's details, wrapping.
  chipLine: {
    marginTop: 4,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
  },
  // Add to group's target: a 44pt frame around the 32pt pill (the Items
  // twin's addToGroupFrame). It was the pill plus a 6pt hitSlop, and a slop
  // never reaches past the chip line it sits in, so the target was 32pt.
  addToGroupFrame: {
    minHeight: 44,
    justifyContent: 'center',
  },
  // The pill: the stronger border, as for the app's other secondary controls.
  addToGroup: {
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: 10,
    borderWidth: 1,
    borderRadius: 999,
  },
});
