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

interface OpenCount {
  id: string;
  warehouseName: string | null;
  startedAt: string;
  startedBy: string | null;
  totalLines: number;
  countedLines: number;
}

export default function CycleCounts() {
  const router = useRouter();
  const { user } = useAuth();
  const [orgId, setOrgId] = React.useState<string | null>(null);
  const [counts, setCounts] = React.useState<OpenCount[]>([]);
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
      .from('cycle_counts')
      .select(
        `id, started_at, started_by,
         warehouse:warehouses!warehouse_id (name),
         starter:user_profiles!started_by (full_name, email),
         lines:cycle_count_lines (id, counted_quantity)`,
      )
      .eq('organization_id', orgId)
      .eq('status', 'in_progress')
      .order('started_at', { ascending: false });
    if (error) {
      console.warn('cycle_counts list', error);
      setCounts([]);
      return;
    }
    const flat: OpenCount[] = (data ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      const wh = r.warehouse as { name: string } | { name: string }[] | null;
      const whName = Array.isArray(wh) ? wh[0]?.name ?? null : wh?.name ?? null;
      const starterRow = r.starter as
        | { full_name: string | null; email: string | null }
        | { full_name: string | null; email: string | null }[]
        | null;
      const s = Array.isArray(starterRow) ? starterRow[0] : starterRow;
      const starter = s?.full_name ?? s?.email ?? null;
      const lines = (r.lines as Array<{ id: string; counted_quantity: number | null }> | null) ?? [];
      return {
        id: r.id as string,
        warehouseName: whName,
        startedAt: r.started_at as string,
        startedBy: starter,
        totalLines: lines.length,
        countedLines: lines.filter((l) => l.counted_quantity !== null).length,
      };
    });
    setCounts(flat);
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

  function open(c: OpenCount) {
    router.push(`/cycle-count/${c.id}`);
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Cycle counts</Text>
        <Text style={styles.subtitle}>
          {counts.length} in progress
        </Text>
      </View>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.primary} />
        </View>
      ) : (
        <FlatList
          data={counts}
          keyExtractor={(c) => c.id}
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
              <Text style={styles.emptyTitle}>No counts in progress</Text>
              <Text style={styles.emptyText}>
                Start a cycle count from the web (Cycle counts → New) and pick
                it up here on the floor.
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() => open(item)}
              style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.lead}>
                  {item.warehouseName ?? 'No warehouse'}
                </Text>
                <Text style={styles.meta}>
                  {item.startedBy ?? 'Unknown'} ·{' '}
                  {new Date(item.startedAt).toLocaleDateString()}
                </Text>
              </View>
              <View style={styles.progressBox}>
                <Text style={styles.progressNum}>
                  {item.countedLines}/{item.totalLines}
                </Text>
                <Text style={styles.progressLabel}>counted</Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
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
  lead: { color: theme.text, fontSize: 15, fontWeight: '600' },
  meta: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  progressBox: { alignItems: 'flex-end' },
  progressNum: {
    color: theme.text,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    fontSize: 16,
  },
  progressLabel: { color: theme.textMuted, fontSize: 11, marginTop: 1 },
  empty: { padding: space.xl, alignItems: 'center' },
  emptyTitle: { color: theme.text, fontSize: 16, fontWeight: '600' },
  emptyText: {
    color: theme.textMuted,
    fontSize: 13,
    marginTop: space.sm,
    textAlign: 'center',
  },
});
