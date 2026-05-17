import { useRouter } from 'expo-router';
import * as React from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import { radius, space, theme } from '@/lib/theme';

interface Item {
  id: string;
  name: string;
  sku: string;
  quantity_on_hand: number;
  reorder_point: number;
  status: string;
}

export default function Inventory() {
  const { user } = useAuth();
  const router = useRouter();
  const [orgId, setOrgId] = React.useState<string | null>(null);
  const [items, setItems] = React.useState<Item[]>([]);
  const [q, setQ] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(
    async (orgIdParam: string, query: string) => {
      let req = supabase
        .from('inventory_items')
        .select('id, name, sku, quantity_on_hand, reorder_point, status')
        .eq('organization_id', orgIdParam)
        .eq('status', 'active')
        .is('deleted_at', null)
        .order('updated_at', { ascending: false })
        .limit(100);
      if (query.trim()) {
        req = req.or(`name.ilike.%${query}%,sku.ilike.%${query}%,barcode.ilike.%${query}%`);
      }
      const { data } = await req;
      setItems((data ?? []) as Item[]);
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
      await load(id, '');
    })();
  }, [user, load]);

  React.useEffect(() => {
    if (!orgId) return;
    const t = setTimeout(() => load(orgId, q), 250);
    return () => clearTimeout(t);
  }, [q, orgId, load]);

  async function onRefresh() {
    if (!orgId) return;
    setRefreshing(true);
    await load(orgId, q);
    setRefreshing(false);
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Inventory</Text>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search name, SKU, barcode…"
          placeholderTextColor={theme.textMuted}
          style={styles.search}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      {loading ? (
        <ActivityIndicator color={theme.primary} style={{ marginTop: space.xl }} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.text} />}
          ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No items yet</Text>
              <Text style={styles.emptyBody}>Add items from the web app or import a CSV.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push({ pathname: '/item/[id]', params: { id: item.id } })}
              style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.rowName}>{item.name}</Text>
                <Text style={styles.rowSku}>{item.sku}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={[styles.rowQty, statusColor(item)]}>{item.quantity_on_hand}</Text>
                <Text style={styles.rowQtyLabel}>{statusLabel(item)}</Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}

function statusLabel(item: Item) {
  if (item.quantity_on_hand <= 0) return 'Out of stock';
  if (item.reorder_point > 0 && item.quantity_on_hand <= item.reorder_point) return 'Low stock';
  return 'In stock';
}

function statusColor(item: Item) {
  if (item.quantity_on_hand <= 0) return { color: theme.destructive };
  if (item.reorder_point > 0 && item.quantity_on_hand <= item.reorder_point) return { color: theme.warning };
  return { color: theme.success };
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  header: { padding: space.lg, paddingBottom: space.md, borderBottomWidth: 1, borderBottomColor: theme.border },
  title: { color: theme.text, fontSize: 24, fontWeight: '700' },
  search: {
    marginTop: space.md,
    backgroundColor: theme.bgElevated,
    borderRadius: radius.md,
    paddingVertical: 10,
    paddingHorizontal: 14,
    color: theme.text,
    fontSize: 14,
    borderWidth: 1,
    borderColor: theme.border,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.card,
    borderRadius: radius.lg,
    padding: space.md,
    borderWidth: 1,
    borderColor: theme.border,
  },
  rowName: { color: theme.text, fontSize: 15, fontWeight: '600' },
  rowSku: { color: theme.textMuted, fontSize: 11, marginTop: 2, fontFamily: 'Menlo' },
  rowQty: { fontSize: 18, fontWeight: '700' },
  rowQtyLabel: { color: theme.textMuted, fontSize: 10, marginTop: 2 },
  empty: { padding: space.xxl, alignItems: 'center' },
  emptyTitle: { color: theme.text, fontSize: 16, fontWeight: '600' },
  emptyBody: { color: theme.textMuted, fontSize: 13, marginTop: space.xs, textAlign: 'center' },
});
