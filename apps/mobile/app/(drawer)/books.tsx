import { useRouter } from 'expo-router';
import { Barcode, BookMarked, BookOpen, Search } from 'lucide-react-native';
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
import { useNavigation } from 'expo-router';
import { Menu, Plus } from 'lucide-react-native';

import { Card } from '@/components/ui/card';
import { FilterChip } from '@/components/ui/chip';
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
  imageUrl: string | null;
  grade: string | null;
}

interface BookCategory {
  id: string;
  name: string;
}

export default function BooksScreen() {
  const router = useRouter();
  const { orgId } = useOrg();
  const navigation = useNavigation();
  const { c } = useTheme();
  const [rows, setRows] = React.useState<BookRow[]>([]);
  const [categories, setCategories] = React.useState<BookCategory[]>([]);
  const [filter, setFilter] = React.useState<string>('ALL');
  const [q, setQ] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const openDrawer = () => (navigation as { openDrawer?: () => void }).openDrawer?.();

  const load = React.useCallback(
    async (query: string, kind: string) => {
      if (!orgId) return;

      // Resolve book category ids. We treat any category with "book" in
      // the name as a book category so renames don't break the filter.
      const { data: cats } = await supabase
        .from('categories')
        .select('id, name')
        .eq('organization_id', orgId)
        .is('deleted_at', null)
        .ilike('name', '%book%');
      const bookCats = (cats ?? []) as BookCategory[];
      setCategories(bookCats);
      const catIds = bookCats.map((c) => c.id);
      if (catIds.length === 0) {
        setRows([]);
        setLoading(false);
        return;
      }

      const filterIds =
        kind === 'ALL'
          ? catIds
          : bookCats.filter((c) => c.name === kind).map((c) => c.id);

      let req = supabase
        .from('inventory_items')
        .select(
          'id, name, sku, barcode, quantity_on_hand, reorder_point, custom_fields, category_id',
        )
        .eq('organization_id', orgId)
        .in('category_id', filterIds.length ? filterIds : catIds)
        .is('deleted_at', null)
        .order('name', { ascending: true })
        .limit(200);
      if (query.trim()) {
        req = req.or(
          `name.ilike.%${query}%,sku.ilike.%${query}%,barcode.ilike.%${query}%`,
        );
      }
      const { data } = await req;

      const bookRows: BookRow[] = (data ?? []).map((row) => {
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
          imageUrl: null,
          grade: (cf?.book_grade as string | undefined) ?? null,
        };
      });

      // Same image-batching pattern as inventory.tsx
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
    void load('', 'ALL');
  }, [load]);

  React.useEffect(() => {
    const t = setTimeout(() => void load(q, filter), 250);
    return () => clearTimeout(t);
  }, [q, filter, load]);

  async function refresh() {
    setRefreshing(true);
    await load(q, filter);
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
            <Pressable
              hitSlop={8}
              onPress={() => router.push('/scan')}
              style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
            >
              <Barcode size={18} color={c.ink} strokeWidth={1.6} />
            </Pressable>
          </View>

          {categories.length > 1 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chips}
            >
              <FilterChip active={filter === 'ALL'} onPress={() => setFilter('ALL')}>
                ALL
              </FilterChip>
              {categories.map((cat) => (
                <FilterChip
                  key={cat.id}
                  active={filter === cat.name}
                  onPress={() => setFilter(cat.name)}
                >
                  {cat.name.toUpperCase()}
                </FilterChip>
              ))}
            </ScrollView>
          ) : null}
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
  chips: {
    paddingTop: 12,
    gap: 8,
  },
  empty: { padding: 32, alignItems: 'center' },
});
