import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import {
  ArrowLeft,
  Barcode,
  BookMarked,
  Check,
  CheckCircle2,
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
import { Card } from '@/components/ui/card';
import { Paginator } from '@/components/ui/paginator';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { BookListSkeleton } from '@/components/ui/skeleton';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { Thumb } from '@/components/ui/thumb';
import { countSelection, useIsPicked } from '@/lib/use-count-selection';
import { listStatusPredicate, stockPillFor } from '@/lib/expected-items';
import { signItemImages, THUMB_TRANSFORM } from '@/lib/image-cache';
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

const bookKeyExtractor = (b: BookRow): string => b.id;

const PAGE_SIZE = 50;

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
  const { return: returnPath } = useLocalSearchParams<{ return?: string }>();
  const [rows, setRows] = React.useState<BookRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const listRef = React.useRef<FlatList<BookRow> | null>(null);
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
    async (query: string, f: FilterState, _allBookCatIds: string[], pageParam: number) => {
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
      let req = supabase
        .from('inventory_items')
        .select(
          `id, name, sku, barcode, quantity_on_hand, reorder_point, custom_fields,
           category_id, primary_location_id, charter_id, warehouse_id, updated_at, auto_archived,
           awaiting_first_receipt`,
          { count: 'exact' },
        )
        .eq('organization_id', orgId)
        .eq('item_type', 'book')
        .eq('awaiting_first_receipt', pred.awaitingFirstReceipt)
        .is('deleted_at', null)
        .order(ord.col, { ascending: ord.asc });
      if (pred.lifecycle) {
        req = req.eq('status', pred.lifecycle);
      }

      if (isLow) {
        // 'low' is a per-row client filter; widen the window and skip
        // server-side paging.
        req = req.limit(500);
      } else {
        const start = (pageParam - 1) * PAGE_SIZE;
        const end = start + PAGE_SIZE - 1;
        req = req.range(start, end);
      }

      // Honor the drawer workspace's active warehouse so book lookups
      // scope the same way as Items.
      if (activeWarehouseId) {
        req = req.eq('warehouse_id', activeWarehouseId);
      }

      if (f.categoryIds.length > 0) {
        req = req.in('category_id', f.categoryIds);
      }

      if (query.trim()) {
        // Quote the value so PostgREST-reserved chars (, ( ) .) in a book
        // title or pasted ISBN stay literal instead of corrupting the
        // or-expression. See inventory.tsx for the full rationale.
        const term = query.trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        req = req.or(
          `name.ilike."%${term}%",sku.ilike."%${term}%",barcode.ilike."%${term}%"`,
        );
      }

      if (f.locationIds.length > 0) {
        req = req.in('primary_location_id', f.locationIds);
      }
      if (f.charterIds.length > 0) {
        const wantsGeneric = f.charterIds.includes(FILTER_GENERIC_CHARTER_ID);
        const real = f.charterIds.filter((x) => x !== FILTER_GENERIC_CHARTER_ID);
        if (wantsGeneric && real.length > 0) {
          req = req.or(`charter_id.is.null,charter_id.in.(${real.join(',')})`);
        } else if (wantsGeneric) {
          req = req.is('charter_id', null);
        } else {
          req = req.in('charter_id', real);
        }
      }
      if (f.status === 'out') req = req.lte('quantity_on_hand', 0);

      const { data, count, error } = await req;
      if (error) console.warn('books list', error);

      let bookRows: BookRow[] = (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        const cf = (r.custom_fields as Record<string, unknown> | null) ?? null;
        return {
          id: r.id as string,
          name: r.name as string,
          sku: r.sku as string,
          barcode: (r.barcode as string | null) ?? null,
          quantity_on_hand: Number(r.quantity_on_hand) || 0,
          reorder_point: Number(r.reorder_point) || 0,
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
      });

      if (isLow) {
        bookRows = bookRows.filter(
          (r) =>
            r.reorder_point > 0
            && r.quantity_on_hand <= r.reorder_point
            && r.quantity_on_hand > 0,
        );
      }

      const ids = bookRows.map((b) => b.id);
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
          // Thumbnail transform, not the full-res original — book covers
          // (often web/PO-imported, multi-megapixel, no thumb variant) would
          // otherwise decode huge bitmaps for a 56px row. See inventory.tsx.
          const urlByPath = await signItemImages(paths, THUMB_TRANSFORM);
          for (const b of bookRows) {
            const p = byItem.get(b.id);
            if (p) b.imageUrl = urlByPath.get(p) ?? null;
          }
        }
      }

      setRows(bookRows);
      setTotal(isLow ? bookRows.length : count ?? bookRows.length);
      setLoading(false);
    },
    [orgId, activeWarehouseId],
  );

  React.useEffect(() => {
    if (!orgId) return;
    void loadLookups();
  }, [orgId, loadLookups]);

  // Whenever the query / filter / workspace changes, jump back to page 1.
  React.useEffect(() => {
    setPage(1);
  }, [q, filter, activeWarehouseId]);

  React.useEffect(() => {
    if (!orgId) return;
    const t = setTimeout(() => void load(q, filter, bookCatIds, page), 250);
    return () => clearTimeout(t);
  }, [q, filter, bookCatIds, load, orgId, activeWarehouseId, page]);

  async function refresh() {
    setRefreshing(true);
    await load(q, filter, bookCatIds, page);
    setRefreshing(false);
  }

  const onPageChange = React.useCallback((p: number) => {
    // Show skeleton during the transition so page changes feel
    // immediate instead of staring at the prior page until the fetch
    // lands. load() flips loading back to false when done.
    setLoading(true);
    setPage(p);
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

  const renderBookItem = React.useCallback(
    ({ item }: { item: BookRow }) => (
      <BookCard
        book={item}
        onBookPress={onBookPress}
        selectMode={selectMode}
        onToggleSelect={onToggleSelect}
      />
    ),
    [onBookPress, selectMode, onToggleSelect],
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
          <Eyebrow>{`INVENTORY · ${total.toLocaleString()} BOOKS`}</Eyebrow>
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
        </View>
      </SafeAreaView>

      {loading ? (
        <BookListSkeleton count={6} />
      ) : (
        <FlatList
          ref={listRef}
          data={rows}
          keyExtractor={bookKeyExtractor}
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
            <Paginator
              page={page}
              total={total}
              pageSize={PAGE_SIZE}
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
  onBookPress,
  selectMode,
  onToggleSelect,
}: {
  book: BookRow;
  onBookPress: (id: string) => void;
  selectMode: boolean;
  onToggleSelect: (book: BookRow) => void;
}) {
  const { c } = useTheme();
  const picked = useIsPicked(book.id);
  const author =
    (book.custom_fields?.book_author as string | undefined)
    ?? (book.custom_fields?.author as string | undefined)
    ?? null;
  const isbn = book.barcode ?? (book.custom_fields?.isbn as string | undefined) ?? null;
  // EXPECTED (awaiting first receipt) replaces OUT for PO-created phantoms —
  // never delivered, so "Out of stock" would be the exact misreading this
  // feature prevents. Pure + tested in lib/expected-items.ts.
  const pill = stockPillFor(book);
  return (
    <Pressable
      onPress={() => (selectMode ? onToggleSelect(book) : onBookPress(book.id))}
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <Card padding={14}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <Thumb size={56} icon={BookMarked} imageUrl={book.imageUrl} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Body
              size={15.5}
              color={c.ink}
              style={{ fontFamily: FONT.display }}
              numberOfLines={2}
            >
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
          </View>
          <View style={{ alignItems: 'flex-end', gap: 6 }}>
            <Mono size={17} tracking={-0.018} color={c.ink} style={{ fontFamily: FONT.display }}>
              {book.quantity_on_hand}
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
  empty: { padding: 32, alignItems: 'center' },
});
