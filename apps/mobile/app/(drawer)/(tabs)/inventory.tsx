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
import { listStatusPredicate, stockPillFor } from '@/lib/expected-items';
import { signItemImages, THUMB_TRANSFORM } from '@/lib/image-cache';
import {
  buildGroupedRows,
  type GroupedRow as InventoryGroupedRow,
} from '@/lib/inventory-grouping';
import { supabase } from '@/lib/supabase';
import { ACCENT, FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';
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

const PAGE_SIZE = 50;

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
  const listRef = React.useRef<FlatList<GroupedRow> | null>(null);
  const [filter, setFilter] = React.useState<FilterState>(EMPTY_FILTER_STATE);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [total, setTotal] = React.useState(0);
  // Cycle-count select mode: tapping a row toggles it into the shared
  // count-selection store instead of opening the item.
  const [selectMode, setSelectMode] = React.useState(false);

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
      pageParam: number,
    ) => {
      const sortMap: Record<typeof f.sort, { col: string; asc: boolean }> = {
        updated_desc: { col: 'updated_at', asc: false },
        name_asc: { col: 'name', asc: true },
        name_desc: { col: 'name', asc: false },
        qty_desc: { col: 'quantity_on_hand', asc: false },
        qty_asc: { col: 'quantity_on_hand', asc: true },
      };
      const ord = sortMap[f.sort];

      // 'low' has to be filtered client-side (reorder_point is a
      // per-row column we can't express in a PostgREST .filter), so
      // when it's selected we fetch a wider window and skip paging.
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

      let req = supabase
        .from('inventory_items')
        .select(
          `id, name, sku, quantity_on_hand, reorder_point, status, category_id,
           primary_location_id, charter_id, warehouse_id, updated_at, auto_archived,
           awaiting_first_receipt,
           category:categories!category_id (name)`,
          { count: 'exact' },
        )
        .eq('organization_id', orgIdParam)
        .eq('awaiting_first_receipt', pred.awaitingFirstReceipt)
        // Match web: the Items tab is products only. Books live on
        // their own tab; mixing them was masking the per-tab counts.
        .neq('item_type', 'book')
        .is('deleted_at', null)
        .order(ord.col, { ascending: ord.asc });
      if (pred.lifecycle) {
        req = req.eq('status', pred.lifecycle);
      }

      if (isLow) {
        req = req.limit(200);
      } else {
        const start = (pageParam - 1) * PAGE_SIZE;
        const end = start + PAGE_SIZE - 1;
        req = req.range(start, end);
      }

      // Active warehouse scoping — when the drawer's workspace switcher
      // narrows to a single warehouse, the list scopes to it. Mirrors
      // the web sidebar's per-warehouse filter.
      if (warehouseScopeId) {
        req = req.eq('warehouse_id', warehouseScopeId);
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
          req = req.or(`name.ilike."%${term}%",sku.ilike."%${term}%",barcode.ilike."%${term}%"`);
        }
      }

      if (f.categoryIds.length > 0) {
        req = req.in('category_id', f.categoryIds);
      }
      if (f.locationIds.length > 0) {
        // The LOCATION filter lists racks/zones, but an item's real placement
        // lives in item_stock_levels — NOT primary_location_id (a home/zone
        // hint that's usually null or a zone, so filtering it by a rack matched
        // nothing). Resolve the items that physically hold stock at the
        // selected locations, then constrain the list to them.
        const { data: levelRows } = await supabase
          .from('item_stock_levels')
          .select('item_id')
          .eq('organization_id', orgIdParam)
          .in('location_id', f.locationIds)
          .gt('quantity', 0);
        const placedItemIds = Array.from(
          new Set((levelRows ?? []).map((r) => (r as { item_id: string }).item_id)),
        );
        // No items at those locations → match nothing (sentinel id) rather than
        // silently dropping the filter.
        req = req.in(
          'id',
          placedItemIds.length ? placedItemIds : ['00000000-0000-0000-0000-000000000000'],
        );
      }
      if (f.charterIds.length > 0) {
        const wantsGeneric = f.charterIds.includes(FILTER_GENERIC_CHARTER_ID);
        const real = f.charterIds.filter((x) => x !== FILTER_GENERIC_CHARTER_ID);
        if (wantsGeneric && real.length > 0) {
          // PostgREST .or() — match items with no charter OR in selected charters
          req = req.or(`charter_id.is.null,charter_id.in.(${real.join(',')})`);
        } else if (wantsGeneric) {
          req = req.is('charter_id', null);
        } else {
          req = req.in('charter_id', real);
        }
      }
      // Stock status: 'out' is qty<=0; 'low' is qty<=reorder and reorder>0.
      // Reorder is per-row, so 'low' has to be a client-side pass below.
      if (f.status === 'out') req = req.lte('quantity_on_hand', 0);

      const { data, count, error } = await req;
      if (error) {
        console.warn('inventory list', error);
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
          imageUrl: null,
        } as Item;
      });

      if (isLow) {
        rows = rows.filter(
          (r) =>
            r.reorder_point > 0 && r.quantity_on_hand <= r.reorder_point && r.quantity_on_hand > 0,
        );
      }

      // Batch-fetch primary photos for the visible items. Signed URLs
      // are cached + reused across screens (see image-cache) so repeat
      // loads skip the round-trip and the bitmaps come from disk.
      const ids = rows.map((r) => r.id);
      if (ids.length > 0) {
        const { data: imgs } = await supabase
          .from('item_images')
          .select('item_id, storage_path, is_primary, sort_order')
          .in('item_id', ids)
          .order('is_primary', { ascending: false })
          .order('sort_order', { ascending: true });
        const byItem = new Map<string, string>();
        for (const row of (imgs ?? []) as Array<{ item_id: string; storage_path: string }>) {
          if (!byItem.has(row.item_id)) byItem.set(row.item_id, row.storage_path);
        }
        const paths = Array.from(byItem.values());
        if (paths.length > 0) {
          // Sign list thumbnails through the 200x200 transform preset, not the
          // full-resolution original. Web/PO-imported product + book-cover
          // images can be multi-megapixel; decoding originals into bitmaps for
          // a 56px row balloons resident image memory (jetsam risk on older
          // iPhones) and causes scroll decode jank. The transform serves ~12KB.
          const urlByPath = await signItemImages(paths, THUMB_TRANSFORM);
          for (const r of rows) {
            const p = byItem.get(r.id);
            if (p) r.imageUrl = urlByPath.get(p) ?? null;
          }
        }
      }

      setItems(rows);
      // When 'low' is on, the server count is the un-filtered total so
      // it's misleading — use the client-filtered length instead. For
      // every other query the server count is the authoritative total
      // used by the Paginator footer.
      setTotal(isLow ? rows.length : (count ?? rows.length));
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
  React.useEffect(() => {
    setPage(1);
  }, [q, filter, activeWarehouseId]);

  React.useEffect(() => {
    if (!orgId) return;
    const t = setTimeout(() => load(orgId, q, filter, activeWarehouseId, page), 250);
    return () => clearTimeout(t);
  }, [q, filter, orgId, load, activeWarehouseId, page]);

  async function onRefresh() {
    if (!orgId) return;
    setRefreshing(true);
    await load(orgId, q, filter, activeWarehouseId, page);
    setRefreshing(false);
  }

  const onPageChange = React.useCallback((p: number) => {
    // Re-trigger the loading skeleton so the page transition feels
    // immediate instead of staring at the previous page until the
    // network fetch lands. load() will flip this back to false.
    setLoading(true);
    setPage(p);
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

  // Two-level display grouping (mobile twin of the web inventory table): first
  // collapse same-SKU placements into one header (Model B), then apply apparel
  // size-run grouping on top of the remaining singles. Pure + tested in
  // lib/inventory-grouping.ts.
  const groupedRows = React.useMemo<GroupedRow[]>(
    () =>
      buildGroupedRows<Item>(items, {
        expandedSizeRuns: expandedGroups,
        expandedSkuGroups,
        placementLabelFor,
      }),
    [items, expandedGroups, expandedSkuGroups, placementLabelFor],
  );

  const renderItem = React.useCallback(
    ({ item: row, index }: { item: GroupedRow; index: number }) => {
      if (row.kind === 'header') {
        return (
          <GroupHeaderRow
            baseName={row.baseName}
            total={row.total}
            sizeCount={row.sizeCount}
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
            lifecycle={row.status}
            // In the Expected view every fetched row is flagged by
            // construction (the query is awaiting_first_receipt = true),
            // so the collapsed header inherits the EXPECTED badge.
            expected={filter.status === 'expected'}
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
      filter.status,
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
          <Eyebrow>{`INVENTORY · ${total.toLocaleString()} SKUS`}</Eyebrow>
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
            tourActive && total === 0 && !q.trim() && filterCount === 0 ? (
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
            <Paginator page={page} total={total} pageSize={PAGE_SIZE} onPageChange={onPageChange} />
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
  expanded,
  onToggle,
  index,
  isLast,
}: {
  baseName: string;
  total: number;
  sizeCount: number;
  expanded: boolean;
  onToggle: () => void;
  index: number;
  isLast: boolean;
}) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} ${baseName}, ${sizeCount} sizes`}
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
          {sizeCount} size{sizeCount === 1 ? '' : 's'}
        </Mono>
      </View>
      <Mono size={17} color={c.ink} style={{ fontFamily: FONT.display }}>
        {total}
      </Mono>
    </Pressable>
  );
});

/**
 * Collapsed status for a SKU-group header — mirrors the web StockStatusBadge
 * precedence: a non-active lifecycle (archived/discontinued) wins over stock,
 * otherwise OUT/LOW/OK derives from the SUMMED total vs the representative
 * reorder point (see stock-status-badge.tsx + group-by-sku's rollupStatus).
 */
function skuHeaderStatus(
  total: number,
  reorderPoint: number,
  lifecycle: 'active' | 'archived' | 'discontinued',
  /** True when the list is showing the Expected view (mig 0277) — every row
   *  is then an awaiting-first-receipt phantom, so a collapsed header must
   *  read EXPECTED, not OUT (its summed total is legitimately 0). */
  expected = false,
): { status: 'ok' | 'warn' | 'crit' | 'default'; label: string } {
  if (expected) return { status: 'warn', label: 'EXPECTED' };
  if (lifecycle === 'archived') return { status: 'default', label: 'ARCHIVED' };
  if (lifecycle === 'discontinued') return { status: 'crit', label: 'DISC' };
  if (total <= 0) return { status: 'crit', label: 'OUT' };
  if (reorderPoint > 0 && total <= reorderPoint) return { status: 'warn', label: 'LOW' };
  return { status: 'ok', label: 'OK' };
}

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
  lifecycle: 'active' | 'archived' | 'discontinued';
  /** Expected view (mig 0277): header pill reads EXPECTED instead of OUT. */
  expected: boolean;
  expanded: boolean;
  onToggle: () => void;
  index: number;
  isLast: boolean;
}) {
  const { c } = useTheme();
  const badge = skuHeaderStatus(total, reorderPoint, lifecycle, expected);
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} ${name}, ${placementCount} placements`}
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
        </Mono>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 6 }}>
        <Mono size={17} color={c.ink} style={{ fontFamily: FONT.display, letterSpacing: -0.31 }}>
          {total}
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
