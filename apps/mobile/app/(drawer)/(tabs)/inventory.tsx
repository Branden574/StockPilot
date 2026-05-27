import { useNavigation, useRouter } from 'expo-router';
import {
  Barcode,
  BookMarked,
  Box,
  Layers,
  Menu,
  Package,
  Plus,
  Search,
  type LucideIcon,
} from 'lucide-react-native';
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
import { Hair } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { Thumb } from '@/components/ui/thumb';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import { ACCENT, FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

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
}

const PIPS = [ACCENT.pipOrange, ACCENT.pipAmber, ACCENT.pipTeal, undefined, undefined, undefined];

export default function Inventory() {
  const { user } = useAuth();
  const router = useRouter();
  const navigation = useNavigation();
  const { c } = useTheme();
  const openDrawer = () => (navigation as { openDrawer?: () => void }).openDrawer?.();
  const [orgId, setOrgId] = React.useState<string | null>(null);
  const [items, setItems] = React.useState<Item[]>([]);
  const [q, setQ] = React.useState('');
  const [filter, setFilter] = React.useState<FilterState>(EMPTY_FILTER_STATE);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [total, setTotal] = React.useState(0);

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
    async (orgIdParam: string, query: string, f: FilterState) => {
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
          `id, name, sku, quantity_on_hand, reorder_point, status, category_id,
           primary_location_id, charter_id, updated_at,
           category:categories!category_id (name)`,
          { count: 'exact' },
        )
        .eq('organization_id', orgIdParam)
        .eq('status', 'active')
        .is('deleted_at', null)
        .order(ord.col, { ascending: ord.asc })
        .limit(200);

      if (query.trim()) {
        req = req.or(`name.ilike.%${query}%,sku.ilike.%${query}%,barcode.ilike.%${query}%`);
      }

      if (f.categoryIds.length > 0) {
        req = req.in('category_id', f.categoryIds);
      }
      if (f.locationIds.length > 0) {
        req = req.in('primary_location_id', f.locationIds);
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
        const catName = Array.isArray(cat) ? cat[0]?.name ?? null : cat?.name ?? null;
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
          imageUrl: null,
        } as Item;
      });

      if (f.status === 'low') {
        rows = rows.filter(
          (r) =>
            r.reorder_point > 0
            && r.quantity_on_hand <= r.reorder_point
            && r.quantity_on_hand > 0,
        );
      }

      // Batch-fetch primary photos for the visible items
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
          const { data: signed } = await supabase.storage
            .from('item-images')
            .createSignedUrls(paths, 60 * 60);
          const urlByPath = new Map<string, string>();
          for (const s of (signed ?? []) as Array<{ path: string | null; signedUrl: string }>) {
            if (s.path && s.signedUrl) urlByPath.set(s.path, s.signedUrl);
          }
          for (const r of rows) {
            const p = byItem.get(r.id);
            if (p) r.imageUrl = urlByPath.get(p) ?? null;
          }
        }
      }

      setItems(rows);
      setTotal(count ?? rows.length);
      setLoading(false);
    },
    [],
  );

  React.useEffect(() => {
    if (!user) return;
    (async () => {
      const { data: member } = await supabase
        .from('organization_members')
        .select('organization_id')
        .eq('user_id', user.id)
        .not('accepted_at', 'is', null)
        .limit(1)
        .maybeSingle();
      if (!member) return;
      const id = member.organization_id as string;
      setOrgId(id);
      await Promise.all([loadLookups(id), load(id, '', EMPTY_FILTER_STATE)]);
    })();
  }, [user, load, loadLookups]);

  React.useEffect(() => {
    if (!orgId) return;
    const t = setTimeout(() => load(orgId, q, filter), 250);
    return () => clearTimeout(t);
  }, [q, filter, orgId, load]);

  async function onRefresh() {
    if (!orgId) return;
    setRefreshing(true);
    await load(orgId, q, filter);
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
          <Eyebrow>{`INVENTORY · ${total.toLocaleString()} SKUS`}</Eyebrow>
          <Display size={34} style={{ marginTop: 12 }}>
            Items <Em>&amp; Books</Em>
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
              placeholder="Search SKU, name, or scan…"
              placeholderTextColor={c.ink4}
              autoCapitalize="none"
              autoCorrect={false}
              style={[
                styles.searchInput,
                { color: c.ink, fontFamily: FONT.displayRegular },
              ]}
            />
            <FilterButton onPress={() => setSheetOpen(true)} count={filterCount} />
            <Barcode size={18} color={c.ink} strokeWidth={1.6} />
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
          data={items}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.ink} />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Body color={c.ink}>No items match.</Body>
              <Body muted style={{ marginTop: 4, textAlign: 'center' }}>
                Adjust filters or add items from the web app.
              </Body>
            </View>
          }
          ListHeaderComponent={<View style={{ height: 6 }} />}
          renderItem={({ item, index }) => (
            <ItemRow
              item={item}
              isLast={index === items.length - 1}
              index={index}
              onPress={() =>
                router.push({ pathname: '/item/[id]', params: { id: item.id } })
              }
            />
          )}
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
    </View>
  );
}

function statusFromItem(item: Item): 'ok' | 'warn' | 'crit' {
  if (item.quantity_on_hand <= 0) return 'crit';
  if (item.reorder_point > 0 && item.quantity_on_hand <= item.reorder_point) return 'warn';
  return 'ok';
}

function glyphFromItem(item: Item): LucideIcon {
  const cat = (item.category_name ?? '').toLowerCase();
  if (cat.includes('book')) return BookMarked;
  if (cat.includes('equipment')) return Layers;
  if (cat.includes('supply') || cat.includes('supplies')) return Box;
  return Package;
}

function ItemRow({
  item,
  isLast,
  index,
  onPress,
}: {
  item: Item;
  isLast: boolean;
  index: number;
  onPress: () => void;
}) {
  const { c } = useTheme();
  const status = statusFromItem(item);
  const Icon = glyphFromItem(item);
  const pip = PIPS[index % PIPS.length];
  return (
    <View
      style={{
        backgroundColor: c.card,
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
        onPress={onPress}
        style={({ pressed }) => [
          rowStyles.row,
          { opacity: pressed ? 0.7 : 1 },
        ]}
      >
        <Thumb size={56} icon={Icon} pip={pip} imageUrl={item.imageUrl ?? null} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Mono
            color={c.ink}
            size={15.5}
            tracking={0}
            style={{ fontFamily: FONT.display, letterSpacing: -0.19 }}
          >
            {item.name}
          </Mono>
          <Mono size={11} color={c.ink4} tracking={0.04} style={{ marginTop: 4 }}>
            {item.sku}
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
          {status === 'ok' ? <Pill status="ok">OK</Pill> : null}
          {status === 'warn' ? <Pill status="warn">LOW</Pill> : null}
          {status === 'crit' ? <Pill status="crit">OUT</Pill> : null}
        </View>
      </Pressable>
      {!isLast ? <Hair inset={86} /> : null}
    </View>
  );
}

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
