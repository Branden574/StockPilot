import { useNavigation, useRouter } from 'expo-router';
import { Barcode, BookMarked, Menu, Plus, Search } from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

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
import { Card } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { Thumb } from '@/components/ui/thumb';
import { useOrg } from '@/lib/use-org';
import { supabase } from '@/lib/supabase';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

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
}

export default function BooksScreen() {
  const router = useRouter();
  const { orgId } = useOrg();
  const navigation = useNavigation();
  const { c } = useTheme();
  const [rows, setRows] = React.useState<BookRow[]>([]);
  const [bookCategories, setBookCategories] = React.useState<FilterOption[]>([]);
  const [locations, setLocations] = React.useState<FilterOption[]>([]);
  const [charters, setCharters] = React.useState<FilterOption[]>([]);
  const [filter, setFilter] = React.useState<FilterState>(EMPTY_FILTER_STATE);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [q, setQ] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

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
    async (query: string, f: FilterState, allBookCatIds: string[]) => {
      if (!orgId) return;
      if (allBookCatIds.length === 0) {
        setRows([]);
        setLoading(false);
        return;
      }

      // If user picked specific book categories, narrow to those. Otherwise
      // include every book category in the org.
      const catFilter = f.categoryIds.length > 0 ? f.categoryIds : allBookCatIds;

      const sortMap: Record<typeof f.sort, { col: string; asc: boolean }> = {
        updated_desc: { col: 'updated_at', asc: false },
        name_asc: { col: 'name', asc: true },
        name_desc: { col: 'name', asc: false },
        qty_desc: { col: 'quantity_on_hand', asc: false },
        qty_asc: { col: 'quantity_on_hand', asc: true },
      };
      const ord = sortMap[f.sort];

      let req = supabase
        .from('inventory_items')
        .select(
          `id, name, sku, barcode, quantity_on_hand, reorder_point, custom_fields,
           category_id, primary_location_id, charter_id, updated_at`,
        )
        .eq('organization_id', orgId)
        .in('category_id', catFilter)
        .is('deleted_at', null)
        .order(ord.col, { ascending: ord.asc })
        .limit(200);

      if (query.trim()) {
        req = req.or(
          `name.ilike.%${query}%,sku.ilike.%${query}%,barcode.ilike.%${query}%`,
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

      const { data, error } = await req;
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
        };
      });

      if (f.status === 'low') {
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
          const { data: signed } = await supabase.storage
            .from('item-images')
            .createSignedUrls(paths, 60 * 60);
          const urlByPath = new Map<string, string>();
          for (const s of (signed ?? []) as Array<{ path: string | null; signedUrl: string }>) {
            if (s.path && s.signedUrl) urlByPath.set(s.path, s.signedUrl);
          }
          for (const b of bookRows) {
            const p = byItem.get(b.id);
            if (p) b.imageUrl = urlByPath.get(p) ?? null;
          }
        }
      }

      setRows(bookRows);
      setLoading(false);
    },
    [orgId],
  );

  React.useEffect(() => {
    if (!orgId) return;
    void loadLookups();
  }, [orgId, loadLookups]);

  React.useEffect(() => {
    if (!orgId) return;
    const t = setTimeout(() => void load(q, filter, bookCatIds), 250);
    return () => clearTimeout(t);
  }, [q, filter, bookCatIds, load, orgId]);

  async function refresh() {
    setRefreshing(true);
    await load(q, filter, bookCatIds);
    setRefreshing(false);
  }

  const filterCount = activeFilterCount(filter);

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip icon={Menu} onPress={openDrawer} />
          <IconChip icon={Plus} onPress={() => router.push('/scan')} />
        </View>
        <View style={styles.head}>
          <Eyebrow>{`INVENTORY · ${rows.length} BOOKS`}</Eyebrow>
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
        <ActivityIndicator color={c.ink} style={{ marginTop: 32 }} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(b) => b.id}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24, gap: 10 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.ink} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Display size={18}>No books match.</Display>
              <Body muted style={{ marginTop: 6, textAlign: 'center' }}>
                Scan a book on the Scan tab to add one, or import from the web.
              </Body>
            </View>
          }
          renderItem={({ item }) => (
            <BookCard
              book={item}
              onPress={() => router.push({ pathname: '/item/[id]', params: { id: item.id } })}
            />
          )}
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
    </View>
  );
}

function BookCard({ book, onPress }: { book: BookRow; onPress: () => void }) {
  const { c } = useTheme();
  const author =
    (book.custom_fields?.book_author as string | undefined)
    ?? (book.custom_fields?.author as string | undefined)
    ?? null;
  const isbn = book.barcode ?? (book.custom_fields?.isbn as string | undefined) ?? null;
  const lowStock = book.reorder_point > 0 && book.quantity_on_hand <= book.reorder_point;
  const status: 'ok' | 'warn' | 'crit' =
    book.quantity_on_hand <= 0 ? 'crit' : lowStock ? 'warn' : 'ok';
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
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
              <Mono size={11.5} tracking={0.04} color={c.ink4} style={{ marginTop: 4 }}>
                {author}
              </Mono>
            ) : null}
            {isbn ? (
              <Mono size={11} tracking={0.04} color={c.ink4} style={{ marginTop: 2 }}>
                {isbn}
                {book.grade ? ` · Grade ${book.grade}` : ''}
              </Mono>
            ) : null}
          </View>
          <View style={{ alignItems: 'flex-end', gap: 6 }}>
            <Mono size={17} tracking={-0.018} color={c.ink} style={{ fontFamily: FONT.display }}>
              {book.quantity_on_hand}
            </Mono>
            {status === 'ok' ? <Pill status="ok">OK</Pill> : null}
            {status === 'warn' ? <Pill status="warn">LOW</Pill> : null}
            {status === 'crit' ? <Pill status="crit">OUT</Pill> : null}
          </View>
        </View>
      </Card>
    </Pressable>
  );
}

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
