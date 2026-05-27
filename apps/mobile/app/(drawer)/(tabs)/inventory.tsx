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
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card, Hair } from '@/components/ui/card';
import { FilterChip } from '@/components/ui/chip';
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
  category_id?: string | null;
  category_name?: string | null;
  imageUrl?: string | null;
}

type FilterId = 'ALL' | 'BOOKS' | 'EQUIPMENT' | 'SWAG' | 'SUPPLIES';
const FILTERS: FilterId[] = ['ALL', 'BOOKS', 'EQUIPMENT', 'SWAG', 'SUPPLIES'];

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
  const [filter, setFilter] = React.useState<FilterId>('ALL');
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [total, setTotal] = React.useState(0);

  const load = React.useCallback(
    async (orgIdParam: string, query: string, kind: FilterId) => {
      let req = supabase
        .from('inventory_items')
        .select(
          `id, name, sku, quantity_on_hand, reorder_point, status, category_id,
           category:categories!category_id (name)`,
          { count: 'exact' },
        )
        .eq('organization_id', orgIdParam)
        .eq('status', 'active')
        .is('deleted_at', null)
        .order('updated_at', { ascending: false })
        .limit(100);
      if (query.trim()) {
        req = req.or(`name.ilike.%${query}%,sku.ilike.%${query}%,barcode.ilike.%${query}%`);
      }
      const { data, count, error } = await req;
      if (error) {
        console.warn('inventory list', error);
      }
      const rows = (data ?? []).map((row) => {
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
          imageUrl: null,
        } as Item;
      });
      // Client-side filter on category name — keeps the FilterChip UX
      // responsive without a separate query when the user toggles.
      const filtered =
        kind === 'ALL'
          ? rows
          : rows.filter((r) =>
              (r.category_name ?? '').toLowerCase().includes(kind.toLowerCase()),
            );

      // Batch-fetch primary photos for the visible items in one query,
      // sign each path, and stamp the URLs onto each row. Same data
      // source as the web — `item_images.storage_path` → signed URL
      // from the `item-images` bucket. Signed URLs are valid 1h which
      // is plenty for a single mobile session.
      const ids = filtered.map((r) => r.id);
      if (ids.length > 0) {
        const { data: imgs } = await supabase
          .from('item_images')
          .select('item_id, storage_path, is_primary, sort_order')
          .in('item_id', ids)
          .order('is_primary', { ascending: false })
          .order('sort_order', { ascending: true });
        const byItem = new Map<string, string>();
        for (const row of (imgs ?? []) as Array<{
          item_id: string;
          storage_path: string;
        }>) {
          if (!byItem.has(row.item_id)) {
            byItem.set(row.item_id, row.storage_path);
          }
        }
        const paths = Array.from(byItem.values());
        if (paths.length > 0) {
          const { data: signed } = await supabase.storage
            .from('item-images')
            .createSignedUrls(paths, 60 * 60);
          const urlByPath = new Map<string, string>();
          for (const s of (signed ?? []) as Array<{
            path: string | null;
            signedUrl: string;
          }>) {
            if (s.path && s.signedUrl) urlByPath.set(s.path, s.signedUrl);
          }
          for (const r of filtered) {
            const p = byItem.get(r.id);
            if (p) r.imageUrl = urlByPath.get(p) ?? null;
          }
        }
      }

      setItems(filtered);
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
      await load(id, '', 'ALL');
    })();
  }, [user, load]);

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
            <Barcode size={18} color={c.ink} strokeWidth={1.6} />
          </View>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chips}
          >
            {FILTERS.map((f) => (
              <FilterChip
                key={f}
                active={f === filter}
                onPress={() => setFilter(f)}
              >
                {f}
              </FilterChip>
            ))}
          </ScrollView>
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
  chips: {
    paddingTop: 12,
    gap: 8,
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
