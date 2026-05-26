import { useFocusEffect, useRouter } from 'expo-router';
import * as React from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import { radius, space, theme } from '@/lib/theme';

interface OpenPo {
  id: string;
  po_number: string;
  status: string;
  supplier_name: string | null;
  total: number;
  destination_warehouse_id: string | null;
  expected_at: string | null;
  updated_at: string;
}

const RECEIVABLE_STATUSES = ['expected_inbound', 'ordered', 'partially_received'];

export default function Receive() {
  const router = useRouter();
  const { user } = useAuth();
  const [orgId, setOrgId] = React.useState<string | null>(null);
  const [pos, setPos] = React.useState<OpenPo[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  React.useEffect(() => {
    if (!user) return;
    supabase
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', user.id)
      .not('accepted_at', 'is', null)
      .limit(1)
      .maybeSingle()
      .then(({ data }) => setOrgId((data?.organization_id as string | undefined) ?? null));
  }, [user]);

  const load = React.useCallback(async () => {
    if (!orgId) return;
    const { data, error } = await supabase
      .from('purchase_orders')
      .select(
        `id, po_number, status, total, expected_at, updated_at,
         supplier:suppliers!supplier_id (name),
         destination:locations!destination_location_id (warehouse_id)`,
      )
      .eq('organization_id', orgId)
      .in('status', RECEIVABLE_STATUSES)
      .order('updated_at', { ascending: false });
    if (error) {
      console.warn('po list', error);
      setPos([]);
      return;
    }
    const flat: OpenPo[] = (data ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      const supplier = r.supplier as { name: string } | { name: string }[] | null;
      const dest = r.destination as { warehouse_id: string | null } | { warehouse_id: string | null }[] | null;
      const supplierObj = Array.isArray(supplier) ? supplier[0] : supplier;
      const destObj = Array.isArray(dest) ? dest[0] : dest;
      return {
        id: r.id as string,
        po_number: r.po_number as string,
        status: r.status as string,
        supplier_name: supplierObj?.name ?? null,
        total: Number(r.total) || 0,
        destination_warehouse_id: destObj?.warehouse_id ?? null,
        expected_at: (r.expected_at as string | null) ?? null,
        updated_at: r.updated_at as string,
      };
    });
    setPos(flat);
  }, [orgId]);

  useFocusEffect(
    React.useCallback(() => {
      let cancelled = false;
      (async () => {
        setLoading(true);
        await load();
        if (!cancelled) setLoading(false);
      })();
      return () => {
        cancelled = true;
      };
    }, [load]),
  );

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  function open(po: OpenPo) {
    if (!po.destination_warehouse_id) {
      // No destination set — sending the user to the web flow handles
      // the picker; the mobile UI is read-only for this case.
      return;
    }
    router.push(`/po/${po.id}`);
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Receive</Text>
        <Text style={styles.subtitle}>
          {pos.length} open purchase order{pos.length === 1 ? '' : 's'}
        </Text>
        <Pressable
          onPress={() => router.push('/scan-po')}
          style={({ pressed }) => [
            styles.scanCta,
            pressed && { opacity: 0.7 },
          ]}
        >
          <Text style={styles.scanCtaText}>📷  Scan a new PO with AI</Text>
        </Pressable>
      </View>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.primary} />
        </View>
      ) : (
        <FlatList
          data={pos}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{ padding: space.md, paddingBottom: space.xxl }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={refresh}
              tintColor={theme.primary}
            />
          }
          ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>Nothing to receive</Text>
              <Text style={styles.emptyText}>
                When a PO is approved on the web, it&apos;ll appear here ready to
                scan and receive.
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() => open(item)}
              style={({ pressed }) => [
                styles.row,
                pressed && { opacity: 0.7 },
                !item.destination_warehouse_id && { opacity: 0.55 },
              ]}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.poNumber}>{item.po_number}</Text>
                <Text style={styles.poMeta}>
                  {item.supplier_name ?? 'No supplier'}
                  {' · '}
                  {labelForStatus(item.status)}
                </Text>
                {!item.destination_warehouse_id && (
                  <Text style={styles.warning}>
                    Set destination on web before receiving
                  </Text>
                )}
              </View>
              <Text style={styles.poTotal}>${item.total.toFixed(2)}</Text>
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}

function labelForStatus(s: string): string {
  if (s === 'expected_inbound') return 'Expected';
  if (s === 'ordered') return 'Ordered';
  if (s === 'partially_received') return 'Partial';
  return s;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    paddingHorizontal: space.md,
    paddingVertical: space.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  title: { color: theme.text, fontSize: 24, fontWeight: '700' },
  subtitle: { color: theme.textMuted, fontSize: 13, marginTop: 2 },
  scanCta: {
    marginTop: space.md,
    backgroundColor: theme.primary,
    paddingVertical: space.sm + 2,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  scanCtaText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.card,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  poNumber: { color: theme.text, fontFamily: 'Menlo', fontSize: 14, fontWeight: '600' },
  poMeta: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  poTotal: { color: theme.text, fontVariant: ['tabular-nums'], fontWeight: '600' },
  warning: { color: theme.warning, fontSize: 11, marginTop: 4 },
  empty: { padding: space.xl, alignItems: 'center' },
  emptyTitle: { color: theme.text, fontSize: 16, fontWeight: '600' },
  emptyText: {
    color: theme.textMuted,
    fontSize: 13,
    marginTop: space.sm,
    textAlign: 'center',
  },
});
