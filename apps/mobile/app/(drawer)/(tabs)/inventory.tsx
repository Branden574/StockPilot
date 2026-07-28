import { useFocusEffect, useNavigation, useRouter } from 'expo-router';
import {
  ArrowLeft,
  Barcode,
  BookMarked,
  Box,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Layers,
  ListChecks,
  Menu,
  Package,
  Plus,
  Search,
  type LucideIcon,
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
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';

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
import { Hair } from '@/components/ui/card';
import { Paginator } from '@/components/ui/paginator';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { ItemListSkeleton } from '@/components/ui/skeleton';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { Thumb } from '@/components/ui/thumb';
import { countSelection, useIsPicked } from '@/lib/use-count-selection';
import { listStatusPredicate, stockPill, stockPillFor } from '@/lib/expected-items';
import { signItemImages, THUMB_TRANSFORM } from '@/lib/image-cache';
import {
  buildGroupUnits,
  buildGroupedRows,
  type GroupedRow as InventoryGroupedRow,
} from '@/lib/inventory-grouping';
import {
  GROUPS_PER_PAGE,
  POSTGREST_MAX_ROWS,
  paginateGroups,
  readIsComplete,
} from '@/lib/inventory-paging';
import { supabase } from '@/lib/supabase';
import {
  countingUnitLabel,
  groupRollupLabel,
  type CountingUnit,
} from '@stockpilot/core';
import { ACCENT, FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';
import { useWarehouseScope, warehouseScopeMessage } from '@/lib/warehouse-scope';
import { useWorkspace } from '@/lib/use-workspace';
import { MobileTour } from '@/components/onboarding/mobile-tour';
import { useTourActive, useTourTarget } from '@/lib/tour-targets';
import { MOBILE_INVENTORY_TOUR } from '@/lib/onboarding';

interface Item {
  id: string;
  name: string;
  sku: string;
  quantity_on_hand: number;
  reorder_point: number;
  status: string;
  category_id: string | null;
  category_name: string | null;
  primary_location_id: string | null;
  charter_id: string | null;
  imageUrl: string | null;
  updated_at: string | null;
  /** True only when the SYSTEM auto-archived this item on zero stock
   *  (migration 0266) — drives the item detail "Auto-archived" badge.
   *  Meaningless unless status === 'archived'. */
  auto_archived: boolean;
  /** True while a PO-created item is awaiting its FIRST receipt
   *  (migration 0277; a DB trigger clears it when stock arrives). Flagged
   *  rows are hidden from the default list and only surface under the
   *  filter sheet's Expected option, where they wear an EXPECTED pill
   *  instead of the misleading OUT. */
  awaiting_first_receipt: boolean;
  /** Sports (0298). Stored product-group id — the primary grouping signal. */
  group_id: string | null;
  /** Sports (0298). Stored size, used to order a grouped run's members. */
  variant_size: string | null;
  /** The group's counting unit, read from the embedded product_groups row. */
  counting_unit: string | null;
}

/**
 * The counting unit off a to-one `product_groups` embed. PostgREST types a
 * to-one embed as an array but returns a single object at runtime, and it is
 * simply absent for an ungrouped item — handle all three shapes rather than
 * indexing blind.
 */
function readCountingUnit(embed: unknown): string | null {
  const row = Array.isArray(embed) ? embed[0] : embed;
  const unit = (row as { default_counting_unit?: unknown } | null | undefined)
    ?.default_counting_unit;
  return typeof unit === 'string' ? unit : null;
}

const PIPS = [ACCENT.pipOrange, ACCENT.pipAmber, ACCENT.pipTeal, undefined, undefined, undefined];

/** One FlatList entry: a size-run header, a same-SKU collapse header (Model B),
 *  or a plain item row (a standalone item, an expanded size-run member, or an
 *  expanded SKU-group placement). Shared shape + composition live in
 *  lib/inventory-grouping.ts so this list matches the web table exactly. */
type GroupedRow = InventoryGroupedRow<Item>;

// Stable, module-scoped helpers so the FlatList doesn't see a new
// keyExtractor / header element on every render — both are common
// causes of full-list re-renders during scroll.
const keyExtractor = (r: GroupedRow): string => r.key;
const listHeader = <View style={{ height: 6 }} />;

/** Columns the list read selects — deliberately lean: exactly what a row
 *  renders (plus the fields a collapsed header rolls up), because this read now
 *  returns the whole filtered set rather than a 50-row window. */
// `group_id` / `variant_size` (mig 0298) ride along so the size-run collapse
// uses STORED identity where it exists instead of a regex over the name — the
// same rule web applies, out of the same shared `groupBySizeRun`. Both are
// NULL for every ungrouped item in every org (there is no backfill), so a
// non-sports org's list is unchanged. The embedded product_groups row supplies
// the counting unit for the header; a to-one embed costs no extra round trip
// and resolves to nothing when group_id is null.
const ITEM_COLUMNS = `id, name, sku, quantity_on_hand, reorder_point, status, category_id,
           primary_location_id, charter_id, warehouse_id, updated_at, auto_archived,
           awaiting_first_receipt, group_id, variant_size,
           category:categories!category_id (name),
           product_group:product_groups!group_id (default_counting_unit)`;

export default function Inventory() {
  const router = useRouter();
  const navigation = useNavigation();
  const { c } = useTheme();
  // The bottom tab bar uses position: 'absolute' (see (tabs)/_layout.tsx),
  // so the FlatList content extends behind it. Use the navigator's
  // real height — covers the home-indicator inset on every iPhone form
  // factor — and add breathing room so the last row never feels glued
  // to the blur edge.
  const tabBarHeight = useBottomTabBarHeight();
  const openDrawer = () => (navigation as { openDrawer?: () => void }).openDrawer?.();
  const [orgId, setOrgId] = React.useState<string | null>(null);
  const { activeOrgId, activeWarehouseId } = useWorkspace();
  // The WHOLE filtered set, not a page of it (one request, capped at
  // POSTGREST_MAX_ROWS). Pagination happens below, over GROUPS, so a SKU's
  // placements can never land on two pages.
  const [items, setItems] = React.useState<Item[]>([]);
  const searchTargetRef = useTourTarget('inventory-search');
  const addTargetRef = useTourTarget('inventory-add');
  const tourActive = useTourActive('mobile-inventory');
  const [q, setQ] = React.useState('');
  const [page, setPage] = React.useState(1);
  // Size-run grouping (apparel): collapse a run of same-base sized items on this
  // page into one expandable header, keyed by the derived style base. Collapsed
  // by default. (Grouping is per loaded page here — the web run-aware pagination
  // is a heavier client-load refactor; PAGE_SIZE 50 keeps splits rare.)
  const [expandedGroups, setExpandedGroups] = React.useState<Set<string>>(new Set());
  // Model B: a single SKU can be MULTIPLE inventory_items rows (one per
  // charter/bin/warehouse placement — migration 0234). Collapse those into one
  // header row on this page, matching the web Items table. Tracks the expanded
  // SKUs; separate from the size-run set above so their keys never collide.
  const [expandedSkuGroups, setExpandedSkuGroups] = React.useState<Set<string>>(new Set());
  // True ONLY when the read hit PostgREST's cap, i.e. the rows in hand are a
  // prefix of the filtered set. At current volumes (257 items on the largest
  // org, cap 1000) this never fires; when it does it is disclosed above the
  // list AND on every collapsed header, never silently.
  const [truncated, setTruncated] = React.useState(false);
  /** A refused list read, disclosed above the list. Never a silent empty state
   *  — an error is not the same claim as "this org has no items". */
  const [loadError, setLoadError] = React.useState<string | null>(null);
  // Signed thumbnail URLs, resolved for the CURRENT PAGE's rows only and kept
  // across page flips. Keyed by item id; a null value means "resolved, has no
  // image", so a photoless item is never re-queried.
  //
  // CACHED PER LOAD, NOT PER SESSION. It is dropped by `load()` — pull-to-
  // refresh and every query/filter/warehouse change — because it caches a read
  // of item_images, and "resolved, no image" is exactly the entry a freshly
  // uploaded cover has to be able to overwrite. Held for the life of the screen
  // it froze the first answer, so a cover added in the app never appeared again
  // that session, a regression against the old per-load fetch. Page flips do
  // NOT clear it: that is the cross-page saving it exists for.
  const [images, setImages] = React.useState<ReadonlyMap<string, string | null>>(new Map());
  const listRef = React.useRef<FlatList<GroupedRow> | null>(null);
  const [filter, setFilter] = React.useState<FilterState>(EMPTY_FILTER_STATE);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  // Exact server count over the same predicates. Equal to items.length except
  // in the truncated case, where it is what the disclosure quotes.
  const [serverRowCount, setServerRowCount] = React.useState<number | null>(null);
  // Rows the SERVER returned, BEFORE the client-side 'low' pass. The truncation
  // disclosure has to compare like with like: `items.length` is post-'low'
  // while `serverRowCount` counts the pre-'low' predicate set, so quoting one
  // against the other printed a ratio between two different populations.
  const [loadedRowCount, setLoadedRowCount] = React.useState(0);
  // Cycle-count select mode: tapping a row toggles it into the shared
  // count-selection store instead of opening the item.
  const [selectMode, setSelectMode] = React.useState(false);
  // Warehouse-scoped users (staff/viewer): the loaded snapshot's scope drives
  // the same banner the web Items list shows, so a narrowed list reads as
  // intentional. undefined (not synced yet) renders nothing.
  const warehouseScope = useWarehouseScope();
  const scopeMessage = warehouseScopeMessage(warehouseScope);

  // Lookup tables for the filter sheet + the active-filter pill summary
  const [categories, setCategories] = React.useState<FilterOption[]>([]);
  const [locations, setLocations] = React.useState<FilterOption[]>([]);
  const [charters, setCharters] = React.useState<FilterOption[]>([]);

  const categoryMap = React.useMemo(
    () => new Map(categories.map((x) => [x.id, x.name] as const)),
    [categories],
  );
  const locationMap = React.useMemo(
    () => new Map(locations.map((x) => [x.id, x.name] as const)),
    [locations],
  );
  const charterMap = React.useMemo(
    () => new Map(charters.map((x) => [x.id, x.name] as const)),
    [charters],
  );

  const loadLookups = React.useCallback(async (orgIdParam: string) => {
    const [cats, locs, chts] = await Promise.all([
      supabase
        .from('categories')
        .select('id, name')
        .eq('organization_id', orgIdParam)
        .is('deleted_at', null)
        .order('name', { ascending: true }),
      supabase
        .from('locations')
        .select('id, name')
        .eq('organization_id', orgIdParam)
        .is('deleted_at', null)
        // Sites only — racks/shelves/crates and the staging/unplaced system
        // slots aren't stocking locations to filter or assign items by.
        .in('type', ['warehouse', 'room', 'vehicle', 'jobsite'])
        .order('name', { ascending: true }),
      supabase
        .from('charters')
        .select('id, name, code')
        .eq('organization_id', orgIdParam)
        .order('name', { ascending: true }),
    ]);
    setCategories(((cats.data ?? []) as Array<{ id: string; name: string }>) ?? []);
    setLocations(((locs.data ?? []) as Array<{ id: string; name: string }>) ?? []);
    setCharters(
      ((chts.data ?? []) as Array<{ id: string; name: string; code: string | null }>).map((c) => ({
        id: c.id,
        name: c.code ? `${c.name} · ${c.code}` : c.name,
      })),
    );
  }, []);

  const load = React.useCallback(
    async (
      orgIdParam: string,
      query: string,
      f: FilterState,
      warehouseScopeId: string | null,
    ) => {
      const sortMap: Record<typeof f.sort, { col: string; asc: boolean }> = {
        updated_desc: { col: 'updated_at', asc: false },
        name_asc: { col: 'name', asc: true },
        name_desc: { col: 'name', asc: false },
        qty_desc: { col: 'quantity_on_hand', asc: false },
        qty_asc: { col: 'quantity_on_hand', asc: true },
      };
      const ord = sortMap[f.sort];

      // 'low' has to be filtered client-side (reorder_point is a per-row
      // column we can't express in a PostgREST .filter). It now runs over the
      // COMPLETE set rather than a widened window, so it is an ordinary filter
      // like any other, not a source of missing siblings.
      const isLow = f.status === 'low';

      // The STOCK section's radio swaps which bucket this screen shows —
      // active items by default, Archived for the archive, and Expected
      // (mig 0277) for PO-created phantoms awaiting their first receipt.
      // Never combined with 'low'/'out': an archived item is definitionally
      // out of stock already, and a phantom has no stock to be low/out OF.
      // listStatusPredicate (pure, tested) owns the mapping; every default
      // view carries awaiting_first_receipt=false so phantoms never read
      // as "Out of stock" before anything was delivered.
      const pred = listStatusPredicate(f.status);

      let placedItemIds: string[] | null = null;
      if (f.locationIds.length > 0) {
        // The LOCATION filter lists racks/zones, but an item's real placement
        // lives in item_stock_levels — NOT primary_location_id (a home/zone
        // hint that's usually null or a zone, so filtering it by a rack matched
        // nothing). Resolve the items that physically hold stock at the
        // selected locations, then constrain the list to them. Resolved ONCE,
        // before the reads below, so both of them narrow identically.
        const { data: levelRows } = await supabase
          .from('item_stock_levels')
          .select('item_id')
          .eq('organization_id', orgIdParam)
          .in('location_id', f.locationIds)
          .gt('quantity', 0);
        const ids = Array.from(
          new Set((levelRows ?? []).map((r) => (r as { item_id: string }).item_id)),
        );
        // No items at those locations → match nothing (sentinel id) rather than
        // silently dropping the filter.
        placedItemIds = ids.length ? ids : ['00000000-0000-0000-0000-000000000000'];
      }

      // EVERY predicate lives in ONE place. It used to serve two reads (the
      // visible page and a per-SKU count) that had to see the identical
      // dataset; there is only one read now, but the builder stays — it is
      // what guarantees the row read and its exact count can never drift, and
      // it is the seam any future second read must go through. Generic over
      // the column list so PostgREST still infers row types from each literal
      // select. (Mirrors books.tsx.)
      const scoped = <Q extends string>(columns: Q, opts?: { count: 'exact' }) => {
        let r = supabase
          .from('inventory_items')
          .select(columns, opts)
          .eq('organization_id', orgIdParam)
          .eq('awaiting_first_receipt', pred.awaitingFirstReceipt)
          // Match web: the Items tab is products only. Books live on
          // their own tab; mixing them was masking the per-tab counts.
          .neq('item_type', 'book')
          .is('deleted_at', null);
        if (pred.lifecycle) {
          r = r.eq('status', pred.lifecycle);
        }
        // Active warehouse scoping — when the drawer's workspace switcher
        // narrows to a single warehouse, the list scopes to it. Mirrors
        // the web sidebar's per-warehouse filter.
        if (warehouseScopeId) {
          r = r.eq('warehouse_id', warehouseScopeId);
        }
        if (query.trim()) {
          // Match items containing EVERY word of the query (across name / sku /
          // barcode), so a multi-word search like "purple shirt" matches
          // "L4L Purple T-Shirt" — instead of a literal substring search for the
          // whole phrase, which matched nothing. Each .or() group is AND-ed with
          // the others by PostgREST. Double-quote each value so reserved chars
          // (, ( ) . — common in titles / model numbers / ISBNs) stay literal.
          const words = query.trim().split(/\s+/).filter(Boolean);
          for (const word of words) {
            const term = word.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            r = r.or(`name.ilike."%${term}%",sku.ilike."%${term}%",barcode.ilike."%${term}%"`);
          }
        }
        if (f.categoryIds.length > 0) {
          r = r.in('category_id', f.categoryIds);
        }
        if (placedItemIds) {
          r = r.in('id', placedItemIds);
        }
        if (f.charterIds.length > 0) {
          const wantsGeneric = f.charterIds.includes(FILTER_GENERIC_CHARTER_ID);
          const real = f.charterIds.filter((x) => x !== FILTER_GENERIC_CHARTER_ID);
          if (wantsGeneric && real.length > 0) {
            // PostgREST .or() — match items with no charter OR in selected charters
            r = r.or(`charter_id.is.null,charter_id.in.(${real.join(',')})`);
          } else if (wantsGeneric) {
            r = r.is('charter_id', null);
          } else {
            r = r.in('charter_id', real);
          }
        }
        // Stock status: 'out' is qty<=0; 'low' is qty<=reorder and reorder>0.
        // Reorder is per-row, so 'low' has to be a client-side pass below.
        if (f.status === 'out') r = r.lte('quantity_on_hand', 0);
        return r;
      };

      // ── ONE request for the WHOLE filtered set ───────────────────────────
      // Not a 50-row window. Server paging was the ONLY reason a SKU's
      // placements could land on two pages, and the datasets it was paging are
      // tiny: 257 active items on the largest production org, against
      // PostgREST's 1000-row cap. Holding the set lets the GROUP be the unit
      // of pagination (below), which is the requirement — a family whole on
      // exactly one page — and costs one round trip instead of one per page.
      //
      // `id` is a SECONDARY sort key: updated_at / name / quantity all tie
      // freely, and ties ordered differently between two fetches can put a row
      // in two groups or none.
      const { data, count, error } = await scoped(ITEM_COLUMNS, { count: 'exact' })
        .order(ord.col, { ascending: ord.asc })
        .order('id', { ascending: true })
        .limit(POSTGREST_MAX_ROWS);
      // FAIL LOUD (release-order rule). A console.warn is invisible on a phone,
      // so a refused read rendered "No items match." — a claim about the org's
      // inventory, made from an error. This read was WIDENED by the sports
      // branch with 0298's `group_id` / `variant_size` and a `product_groups`
      // embed, so against a database that has not taken 0294+ yet PostgREST
      // refuses the whole select and every item disappears. Say so instead.
      if (error) {
        console.warn('inventory list', error);
        setLoadError(error.message);
      } else {
        setLoadError(null);
      }
      let rows = (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        const cat = r.category as { name?: string } | { name?: string }[] | null;
        const catName = Array.isArray(cat) ? (cat[0]?.name ?? null) : (cat?.name ?? null);
        return {
          id: r.id as string,
          name: r.name as string,
          sku: r.sku as string,
          quantity_on_hand: Number(r.quantity_on_hand) || 0,
          reorder_point: Number(r.reorder_point) || 0,
          status: r.status as string,
          category_id: (r.category_id as string | null) ?? null,
          category_name: catName,
          primary_location_id: (r.primary_location_id as string | null) ?? null,
          charter_id: (r.charter_id as string | null) ?? null,
          updated_at: (r.updated_at as string | null) ?? null,
          auto_archived: Boolean(r.auto_archived),
          awaiting_first_receipt: Boolean(r.awaiting_first_receipt),
          group_id: (r.group_id as string | null) ?? null,
          variant_size: (r.variant_size as string | null) ?? null,
          counting_unit: readCountingUnit(r.product_group),
          imageUrl: null,
        } as Item;
      });

      const returned = rows.length;
      if (isLow) {
        rows = rows.filter(
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
      setItems(rows);
      setServerRowCount(count ?? null);
      setLoadedRowCount(returned);
      // A load is the one moment the underlying data may have changed, so the
      // thumbnail cache is invalidated HERE and only here — pull-to-refresh and
      // every query/filter/warehouse change run through this function, while a
      // page flip does not. Without this a cover uploaded in the app never
      // reappeared, because a "resolved, no image" entry was never re-asked.
      setImages(new Map());
      setLoading(false);
    },
    [],
  );

  // Source the org from the workspace switcher. This used to be a
  // standalone organization_members.limit(1) query that ignored the active
  // org — so a multi-org user who switched orgs kept seeing the FIRST org's
  // items while activeWarehouseId came from the *switched* org, producing a
  // permanently empty list (org A ∧ warehouse-of-org-B matches nothing).
  React.useEffect(() => {
    if (!activeOrgId) {
      setOrgId(null);
      return;
    }
    setOrgId(activeOrgId);
    // Only set the org + load lookups here. The debounced effect below owns
    // ALL list fetching (it depends on orgId/q/filter/warehouse/page). Calling
    // load() here too fired a SECOND identical full list+image fetch on every
    // mount / org switch, racing the debounced one — pure wasted work. Matches
    // books.tsx, which has only the debounced fetch. The 250ms first-paint
    // delay is masked by the loading skeleton.
    void loadLookups(activeOrgId);
  }, [activeOrgId, loadLookups]);

  // Whenever the query / filter / workspace changes, jump back to page 1.
  // Expansions are per-result-set display state, so drop them too — an
  // expansion carried over from another result set reads as a glitch. books.tsx
  // has always done this; Items did not, which was a visible difference on the
  // two screens the owner compares side by side. Both sets are cleared, exactly
  // as onPageChange below already clears both.
  React.useEffect(() => {
    setPage(1);
    setExpandedGroups(new Set());
    setExpandedSkuGroups(new Set());
  }, [q, filter, activeWarehouseId]);

  // NOT keyed on `page` any more: a page flip is a client-side slice of the
  // set already in memory, so it costs no request and no skeleton.
  React.useEffect(() => {
    if (!orgId) return;
    const t = setTimeout(() => load(orgId, q, filter, activeWarehouseId), 250);
    return () => clearTimeout(t);
  }, [q, filter, orgId, load, activeWarehouseId]);

  async function onRefresh() {
    if (!orgId) return;
    setRefreshing(true);
    await load(orgId, q, filter, activeWarehouseId);
    setRefreshing(false);
  }

  const onPageChange = React.useCallback((p: number) => {
    setPage(p);
    // Expansions are per-page display state; carrying one to another page
    // reads as a glitch. Matches books.tsx.
    setExpandedGroups(new Set());
    setExpandedSkuGroups(new Set());
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, []);

  // Dismiss any keyboard left open from a previous screen / tab switch.
  // Tabs preserve mount state, so a focused search bar carries over.
  useFocusEffect(
    React.useCallback(() => {
      Keyboard.dismiss();
    }, []),
  );

  const filterCount = activeFilterCount(filter);

  const onItemPress = React.useCallback(
    (id: string) => {
      Keyboard.dismiss();
      router.push({ pathname: '/item/[id]', params: { id } });
    },
    [router],
  );

  const onToggleSelect = React.useCallback((it: Item) => {
    countSelection.toggle({ id: it.id, sku: it.sku, name: it.name, itemType: 'product' });
  }, []);

  const toggleGroup = React.useCallback((styleKey: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(styleKey)) next.delete(styleKey);
      else next.add(styleKey);
      return next;
    });
  }, []);

  const toggleSkuGroup = React.useCallback((sku: string) => {
    setExpandedSkuGroups((prev) => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });
  }, []);

  // Secondary line for an expanded SKU-group placement — a charter or location
  // label so same-SKU placements read distinctly (the SKU itself is shared and
  // would be redundant). Placement bins aren't in this list's select, so this
  // uses the best available differentiator; null falls back to the SKU.
  const placementLabelFor = React.useCallback(
    (it: Item): string | null => {
      const charter = it.charter_id ? charterMap.get(it.charter_id) : null;
      const loc = it.primary_location_id ? locationMap.get(it.primary_location_id) : null;
      return charter ?? loc ?? null;
    },
    [charterMap, locationMap],
  );

  // ── GROUP FIRST, THEN PAGE ────────────────────────────────────────────────
  // The whole filtered set is grouped into display UNITS (one collapsed SKU
  // family, one size run, or one standalone item = one card), and the PAGE is
  // a slice of units. That is the requirement: three placements of one SKU are
  // one header on ONE page, all three behind the chevron, whatever the sort or
  // page size. Identical to books.tsx except that size runs stay ON here.
  const units = React.useMemo(() => buildGroupUnits(items), [items]);
  const pageView = React.useMemo(
    () => paginateGroups(units, { page, groupsPerPage: GROUPS_PER_PAGE }),
    [units, page],
  );
  // Rows in the filtered set. Exact from the rows themselves in the normal
  // case (we hold all of them); the server's count only when they are a prefix.
  //
  // The server count is over the PRE-'low' predicate set, so under the LOW view
  // adopting it put a different total in the eyebrow from the one the paginator
  // prints for the same screen. There the rows in hand are the only figure that
  // describes the population actually rendered.
  const datasetRowCount =
    truncated && filter.status !== 'low' ? serverRowCount ?? items.length : items.length;

  // Thumbnails are resolved for the PAGE's rows only. The set read can return
  // up to 1000 rows and signing a transformed URL costs one request per path
  // (image-cache.ts falls back to per-path signing whenever a transform is
  // asked for), so signing the whole set would trade a saved page fetch for
  // hundreds of storage calls. Resolved URLs are kept across page flips, and
  // the signed-URL cache means a revisit is free.
  const pageItems = pageView.pageItems;
  const unresolvedIds = React.useMemo(
    () => pageItems.filter((it) => !images.has(it.id)).map((it) => it.id),
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
      // Sign list thumbnails through the 200x200 transform preset, not the
      // full-resolution original. Web/PO-imported product + book-cover images
      // can be multi-megapixel; decoding originals into bitmaps for a 56px row
      // balloons resident image memory (jetsam risk on older iPhones) and
      // causes scroll decode jank. The transform serves ~12KB.
      const paths = Array.from(byItem.values());
      const urlByPath =
        paths.length > 0 ? await signItemImages(paths, THUMB_TRANSFORM) : new Map<string, string>();
      if (cancelled) return;
      setImages((prev) => {
        const next = new Map(prev);
        for (const id of unresolvedIds) {
          const p = byItem.get(id);
          // null records "resolved, no photo" so a photoless item is asked
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

  const pageRows = React.useMemo<Item[]>(
    () =>
      pageItems.map((it) => {
        const url = images.get(it.id) ?? null;
        return url === it.imageUrl ? it : { ...it, imageUrl: url };
      }),
    [pageItems, images],
  );

  // Two-level display grouping (mobile twin of the web inventory table): first
  // collapse same-SKU placements into one header (Model B), then apply apparel
  // size-run grouping on top of the remaining singles. Run over the PAGE, which
  // by construction holds every member of every group on it — so the units it
  // rebuilds are exactly the units it was sliced from. Pure + tested in
  // lib/inventory-grouping.ts.
  const groupedRows = React.useMemo<GroupedRow[]>(
    () =>
      buildGroupedRows<Item>(pageRows, {
        expandedSizeRuns: expandedGroups,
        expandedSkuGroups,
        placementLabelFor,
        datasetIsTruncated: truncated,
      }),
    [pageRows, expandedGroups, expandedSkuGroups, placementLabelFor, truncated],
  );

  const renderItem = React.useCallback(
    ({ item: row, index }: { item: GroupedRow; index: number }) => {
      if (row.kind === 'header') {
        return (
          <GroupHeaderRow
            baseName={row.baseName}
            total={row.total}
            sizeCount={row.sizeCount}
            groupId={row.groupId}
            countingUnit={row.countingUnit}
            expanded={expandedGroups.has(row.styleKey)}
            onToggle={() => toggleGroup(row.styleKey)}
            index={index}
            isLast={index === groupedRows.length - 1}
          />
        );
      }
      if (row.kind === 'sku-header') {
        return (
          <SkuGroupHeaderRow
            name={row.name}
            total={row.total}
            reorderPoint={row.reorderPoint}
            placementCount={row.placementCount}
            partial={row.partial}
            lifecycle={row.status}
            // Derived from the ROWS (every placement awaiting its first
            // receipt), not from filter.status: view state flips the instant
            // the filter is tapped while the rows lag a 250ms debounce plus a
            // fetch behind it, so a filter-derived pill badges the PREVIOUS
            // view's rows EXPECTED while their own children read OUT / OK.
            expected={row.expected}
            expanded={expandedSkuGroups.has(row.sku)}
            onToggle={() => toggleSkuGroup(row.sku)}
            index={index}
            isLast={index === groupedRows.length - 1}
          />
        );
      }
      const itemRow = (
        <ItemRow
          item={row.item}
          placementLabel={row.placementLabel}
          isLast={index === groupedRows.length - 1}
          index={index}
          onItemPress={onItemPress}
          selectMode={selectMode}
          onToggleSelect={onToggleSelect}
        />
      );
      // First visible row doubles as the tour's "tap an item" spotlight.
      return index === 0 ? (
        <TourRowAnchor>{itemRow}</TourRowAnchor>
      ) : (
        itemRow
      );
    },
    [
      groupedRows.length,
      expandedGroups,
      toggleGroup,
      expandedSkuGroups,
      toggleSkuGroup,
      onItemPress,
      selectMode,
      onToggleSelect,
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
                if (router.canGoBack()) router.back();
                else router.replace('/');
              }}
            />
            <IconChip icon={Menu} onPress={openDrawer} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <IconChip
              icon={selectMode ? Check : ListChecks}
              onPress={() => setSelectMode((v) => !v)}
            />
            <View ref={addTargetRef} collapsable={false}>
              <IconChip icon={Plus} onPress={() => router.push('/item/new')} />
            </View>
          </View>
        </View>
        <View style={styles.head}>
          {/* Counts inventory_items ROWS. It said "SKUS", which under Model B
              (mig 0234: one SKU is one row PER charter/bin) is a different and
              smaller number — the same misnaming the Books eyebrow already
              fixed. The list now holds the whole set, so this is an exact count
              of it; when truncated it quotes the server's count and the line
              below says the list is showing less than that. */}
          <Eyebrow>{`INVENTORY · ${datasetRowCount.toLocaleString()} ITEMS`}</Eyebrow>
          <Display size={34} style={{ marginTop: 12 }}>
            Items<Em>.</Em>
          </Display>
          <View style={{ marginTop: 10 }}>
            <MobileTour tour={MOBILE_INVENTORY_TOUR} />
          </View>
        </View>

        <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 }}>
          <View
            ref={searchTargetRef}
            collapsable={false}
            style={[styles.searchBox, { backgroundColor: c.card, borderColor: c.hair }]}
          >
            <Search size={16} color={c.ink4} strokeWidth={1.4} />
            <TextInput
              value={q}
              onChangeText={setQ}
              placeholder="Search SKU, name, or scan…"
              placeholderTextColor={c.ink4}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus={false}
              returnKeyType="search"
              onSubmitEditing={() => Keyboard.dismiss()}
              style={[styles.searchInput, { color: c.ink, fontFamily: FONT.displayRegular }]}
            />
            <FilterButton onPress={() => setSheetOpen(true)} count={filterCount} />
            <Pressable
              onPress={() => router.push('/scan')}
              hitSlop={8}
              style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
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

          {scopeMessage ? (
            <Body muted size={11.5} style={{ marginTop: 8 }}>
              {scopeMessage}
            </Body>
          ) : null}

          {/* Growth degrades HONESTLY. Past the server's row cap the set in
              hand is genuinely a prefix, so the list says so here and marks
              every collapsed header, instead of quietly showing short totals.
              Unreachable at today's volumes — it exists so it never becomes
              reachable silently.

              BOTH numbers describe the SAME population: the rows the server
              returned, against the exact count over the same predicates. This
              used to divide `items.length` — which the client-side 'low' pass
              has already narrowed — by that pre-'low' count, so under the LOW
              view the sentence stated a ratio between two different sets. */}
          {truncated ? (
            <Body muted size={11.5} style={{ marginTop: 8 }}>
              {`Showing the first ${loadedRowCount.toLocaleString()} of ${(serverRowCount ?? loadedRowCount).toLocaleString()} items. Search or filter to narrow — grouped totals below cover only the loaded rows.`}
            </Body>
          ) : null}

          {/* A READ that failed is not an empty inventory. Shown here rather
              than left to the list's own "No items match." so a refused
              select — the shape a mobile build takes when it is ahead of the
              database — is visible instead of looking like a clean org. */}
          {loadError ? (
            <Body size={11.5} color={ACCENT.warn} style={{ marginTop: 8 }}>
              {`Could not load items: ${loadError}. Pull to retry — if the app was just updated, the server may still be catching up.`}
            </Body>
          ) : null}
        </View>
      </SafeAreaView>

      {loading ? (
        <ItemListSkeleton count={8} />
      ) : (
        <FlatList
          ref={listRef}
          data={groupedRows}
          keyExtractor={keyExtractor}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: tabBarHeight + 24 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.ink} />
          }
          ListEmptyComponent={
            /* Ghost only for a genuinely empty org — an empty SEARCH result
               must not claim the org has no items yet. */
            tourActive && datasetRowCount === 0 && !q.trim() && filterCount === 0 ? (
              <SampleItemRow />
            ) : (
              <View style={styles.empty}>
                <Body color={c.ink}>No items match.</Body>
                <Body muted style={{ marginTop: 4, textAlign: 'center' }}>
                  Adjust filters or add items from the web app.
                </Body>
              </View>
            )
          }
          ListHeaderComponent={listHeader}
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
          renderItem={renderItem}
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
        categories={categories}
        locations={locations}
        charters={charters}
      />

      <CountSelectBar visible={selectMode} bottomInset={tabBarHeight} />
    </View>
  );
}

function glyphFromItem(item: Item): LucideIcon {
  const cat = (item.category_name ?? '').toLowerCase();
  if (cat.includes('book')) return BookMarked;
  if (cat.includes('equipment')) return Layers;
  if (cat.includes('supply') || cat.includes('supplies')) return Box;
  return Package;
}

/** Collapsible size-run header row — one per run of same-base sized items
 *  (e.g. "L4L - Pink Shirt", 3 sizes). Tapping toggles the run's member rows. */
const GroupHeaderRow = React.memo(function GroupHeaderRow({
  baseName,
  total,
  sizeCount,
  groupId,
  countingUnit,
  expanded,
  onToggle,
  index,
  isLast,
}: {
  baseName: string;
  total: number;
  sizeCount: number;
  groupId: string | null;
  countingUnit: string | null;
  expanded: boolean;
  onToggle: () => void;
  index: number;
  isLast: boolean;
}) {
  const { c } = useTheme();
  // A STORED group knows what it is and what it counts in: "3 variants · 18
  // pairs total". A name-derived run knows neither, so it keeps the weaker
  // "3 sizes" claim — every ungrouped org reads exactly as before.
  const subtitle =
    groupId && countingUnit
      ? groupRollupLabel(sizeCount, total, countingUnitLabel(countingUnit as CountingUnit, total))
      : groupId
        ? `${sizeCount} variant${sizeCount === 1 ? '' : 's'}`
        : `${sizeCount} size${sizeCount === 1 ? '' : 's'}`;
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} ${baseName}, ${subtitle}`}
      style={({ pressed }) => ({
        // Same continuous-card border model as ItemRow so headers sit flush in
        // the list (a distinct paper2 fill + chevron mark them as a group).
        backgroundColor: c.paper2,
        borderTopWidth: index === 0 ? 1 : 0,
        borderBottomWidth: 1,
        borderLeftWidth: 1,
        borderRightWidth: 1,
        borderColor: c.hair,
        borderTopLeftRadius: index === 0 ? 10 : 0,
        borderTopRightRadius: index === 0 ? 10 : 0,
        borderBottomLeftRadius: isLast ? 10 : 0,
        borderBottomRightRadius: isLast ? 10 : 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 15,
        paddingHorizontal: 14,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <ChevronRight
        size={18}
        color={c.ink4}
        strokeWidth={2}
        style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }}
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Mono
          color={c.ink}
          size={15.5}
          numberOfLines={1}
          style={{ fontFamily: FONT.display, letterSpacing: -0.19 }}
        >
          {baseName}
        </Mono>
        <Mono size={11} color={c.ink4} tracking={0.04} style={{ marginTop: 4 }}>
          {subtitle}
        </Mono>
      </View>
      <Mono size={17} color={c.ink} style={{ fontFamily: FONT.display }}>
        {total}
      </Mono>
    </Pressable>
  );
});

/**
 * Collapsible SKU-group header row — one per SKU that has MORE than one
 * placement (Model B: a single SKU can be several inventory_items rows, one per
 * charter/bin/warehouse). Shows the SKU's SUMMED on-hand and rolled-up status;
 * tapping expands the individual placement rows (each opens its own item).
 * DISPLAY ONLY — `total` is a read-time sum, never a written record.
 */
const SkuGroupHeaderRow = React.memo(function SkuGroupHeaderRow({
  name,
  total,
  reorderPoint,
  placementCount,
  partial,
  lifecycle,
  expected,
  expanded,
  onToggle,
  index,
  isLast,
}: {
  name: string;
  total: number;
  reorderPoint: number;
  placementCount: number;
  /** True when these figures cover the LOADED rows only — the Items list is
   *  page-replace paginated and the 'low' view narrows client-side, so a
   *  header's sum can be short. Disclosed on its face ("≥N", "N placements
   *  shown") rather than passed off as the SKU's stock. */
  partial: boolean;
  lifecycle: 'active' | 'archived' | 'discontinued';
  /** Expected view (mig 0277): header pill reads EXPECTED instead of OUT. */
  expected: boolean;
  expanded: boolean;
  onToggle: () => void;
  index: number;
  isLast: boolean;
}) {
  const { c } = useTheme();
  // The SAME ladder the rows below run (lib/expected-items.ts, shared with the
  // Books list) — the header's inputs are the group's rolled-up lifecycle and
  // summed quantity, so it can only differ from a child where the NUMBERS
  // differ, never because the two ran different rules.
  const badge = stockPill({ expected, lifecycle, quantity: total, reorderPoint });
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} ${name}, ${placementCount} placement${
        placementCount === 1 ? '' : 's'
      }${partial ? ` shown, at least ${total} on hand` : ''}`}
      style={({ pressed }) => ({
        backgroundColor: c.paper2,
        borderTopWidth: index === 0 ? 1 : 0,
        borderBottomWidth: 1,
        borderLeftWidth: 1,
        borderRightWidth: 1,
        borderColor: c.hair,
        borderTopLeftRadius: index === 0 ? 10 : 0,
        borderTopRightRadius: index === 0 ? 10 : 0,
        borderBottomLeftRadius: isLast ? 10 : 0,
        borderBottomRightRadius: isLast ? 10 : 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 15,
        paddingHorizontal: 14,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <ChevronRight
        size={18}
        color={c.ink4}
        strokeWidth={2}
        style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }}
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Mono
          color={c.ink}
          size={15.5}
          numberOfLines={1}
          style={{ fontFamily: FONT.display, letterSpacing: -0.19 }}
        >
          {name}
        </Mono>
        <Mono size={11} color={c.ink4} tracking={0.04} style={{ marginTop: 4 }}>
          {placementCount} placement{placementCount === 1 ? '' : 's'}
          {partial ? ' shown' : ''}
        </Mono>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 6 }}>
        <Mono size={17} color={c.ink} style={{ fontFamily: FONT.display, letterSpacing: -0.31 }}>
          {/* A sum over the loaded rows only is marked with a leading ≥
              rather than presented as the SKU's stock. */}
          {partial ? `≥${total}` : total}
        </Mono>
        <Pill status={badge.status}>{badge.label}</Pill>
      </View>
    </Pressable>
  );
});

const ItemRow = React.memo(function ItemRow({
  item,
  placementLabel,
  isLast,
  index,
  onItemPress,
  selectMode,
  onToggleSelect,
}: {
  item: Item;
  /** When set (an expanded SKU-group placement), replaces the SKU secondary
   *  line with a charter/location label so same-SKU placements read apart. */
  placementLabel?: string | null;
  isLast: boolean;
  index: number;
  onItemPress: (id: string) => void;
  selectMode: boolean;
  onToggleSelect: (item: Item) => void;
}) {
  const { c } = useTheme();
  const picked = useIsPicked(item.id);
  // EXPECTED (awaiting first receipt) replaces OUT for PO-created phantoms —
  // they were never delivered, so "Out of stock" is the exact misreading this
  // feature exists to prevent. Pure + tested in lib/expected-items.ts.
  const pill = stockPillFor(item);
  const Icon = glyphFromItem(item);
  const pip = PIPS[index % PIPS.length];
  return (
    <View
      style={{
        backgroundColor: picked ? c.paper2 : c.card,
        borderTopWidth: index === 0 ? 1 : 0,
        borderBottomWidth: 1,
        borderLeftWidth: 1,
        borderRightWidth: 1,
        borderColor: c.hair,
        borderTopLeftRadius: index === 0 ? 10 : 0,
        borderTopRightRadius: index === 0 ? 10 : 0,
        borderBottomLeftRadius: isLast ? 10 : 0,
        borderBottomRightRadius: isLast ? 10 : 0,
      }}
    >
      <Pressable
        onPress={() => (selectMode ? onToggleSelect(item) : onItemPress(item.id))}
        style={({ pressed }) => [rowStyles.row, { opacity: pressed ? 0.7 : 1 }]}
      >
        <Thumb
          size={56}
          icon={Icon}
          pip={pip}
          imageUrl={item.imageUrl ?? null}
          recyclingKey={item.id}
        />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Mono
            color={c.ink}
            size={15.5}
            tracking={0}
            style={{ fontFamily: FONT.display, letterSpacing: -0.19 }}
          >
            {item.name}
          </Mono>
          <Mono size={11} color={c.ink4} tracking={0.04} numberOfLines={1} style={{ marginTop: 4 }}>
            {placementLabel ?? item.sku}
          </Mono>
        </View>
        <View style={{ alignItems: 'flex-end', gap: 6 }}>
          <Mono
            size={17}
            tracking={0}
            style={{ fontFamily: FONT.display, letterSpacing: -0.31, color: c.ink }}
          >
            {item.quantity_on_hand}
          </Mono>
          <Pill status={pill.status}>{pill.label}</Pill>
        </View>
        {selectMode ? (
          <View style={{ marginLeft: 2 }}>
            {picked ? (
              <CheckCircle2 size={22} color={c.ink} strokeWidth={2} />
            ) : (
              <Circle size={22} color={c.ink4} strokeWidth={1.6} />
            )}
          </View>
        ) : null}
      </Pressable>
      {!isLast ? <Hair inset={86} /> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  root: { flex: 1 },
  topbar: {
    paddingHorizontal: 12,
    paddingTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  head: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 4,
  },
  searchBox: {
    height: 44,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 14.5,
    height: '100%',
    letterSpacing: -0.17,
  },
  empty: {
    padding: 32,
    alignItems: 'center',
  },
});

const rowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
});

/**
 * Measurable wrapper marking the first list row as the tour's
 * "tap an item" spotlight target (collapsable=false keeps the native
 * view alive for measureInWindow on Android).
 */
function TourRowAnchor({ children }: { children: React.ReactNode }) {
  const ref = useTourTarget('inventory-first-row');
  return (
    <View ref={ref} collapsable={false}>
      {children}
    </View>
  );
}

/**
 * Ghost row for brand-new orgs (owner request 2026-07-11): when the tour
 * runs on an EMPTY list, "tap an item" would point at nothing — so we show
 * a clearly-labeled sample row for the spotlight to land on. Client-side
 * only, never written to the database; it disappears with the tour.
 */
function SampleItemRow() {
  const { c } = useTheme();
  const ref = useTourTarget('inventory-first-row');
  return (
    <View ref={ref} collapsable={false}>
      <View
        style={{
          backgroundColor: c.card,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: c.hair,
          borderRadius: 10,
        }}
      >
        <View style={rowStyles.row}>
          <Thumb size={56} icon={Box} pip={ACCENT.pipTeal} imageUrl={null} recyclingKey="sample" />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Mono
              color={c.ink}
              size={15.5}
              tracking={0}
              style={{ fontFamily: FONT.display, letterSpacing: -0.19 }}
            >
              Acer Chromebook 511
            </Mono>
            <Mono size={11} color={c.ink4} tracking={0.04} numberOfLines={1} style={{ marginTop: 4 }}>
              SAMPLE-001 · example item
            </Mono>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 6 }}>
            <Mono
              size={17}
              tracking={0}
              style={{ fontFamily: FONT.display, letterSpacing: -0.31, color: c.ink }}
            >
              25
            </Mono>
            <Pill status="ok">SAMPLE</Pill>
          </View>
        </View>
      </View>
      <Body muted size={11.5} style={{ marginTop: 8, textAlign: 'center' }}>
        Example only — it disappears when the tour ends. Your real items will appear here.
      </Body>
    </View>
  );
}
