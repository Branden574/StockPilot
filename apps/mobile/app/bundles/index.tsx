import { Stack, useRouter } from 'expo-router';
import * as React from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { listBundles, type CachedBundle } from '@/lib/db-reads';
import { syncNow } from '@/lib/sync';
import { radius, space, theme } from '@/lib/theme';

export default function BundlesList() {
  const router = useRouter();
  const [rows, setRows] = React.useState<CachedBundle[]>([]);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async () => {
    const list = await listBundles();
    setRows(list);
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    await syncNow();
    await load();
    setRefreshing(false);
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <Text style={styles.title}>Bundles</Text>
        <Pressable onPress={refresh} style={styles.refreshBtn}>
          <Text style={styles.refreshLabel}>{refreshing ? '⟳' : 'Refresh'}</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: space.md, paddingBottom: 80 }}>
        {refreshing && rows.length === 0 ? (
          <ActivityIndicator color={theme.primary} style={{ marginTop: space.xl }} />
        ) : null}
        {rows.length === 0 && !refreshing ? (
          <Text style={styles.empty}>
            No bundles synced yet. Pull-to-refresh or check back after the next
            sync.
          </Text>
        ) : null}
        {rows.map((b) => (
          <Pressable
            key={b.id}
            style={styles.card}
            onPress={() => router.push(`/bundles/${b.id}`)}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{b.name}</Text>
              {b.sku ? <Text style={styles.sku}>{b.sku}</Text> : null}
              <Text style={styles.meta}>
                {b.preassemblyEnabled
                  ? `${b.phantomQty} pre-assembled`
                  : 'Virtual recipe'}
              </Text>
            </View>
            <Text style={styles.chev}>›</Text>
          </Pressable>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  backBtn: { paddingVertical: space.xs },
  backText: { color: theme.primary, fontSize: 14 },
  title: { color: theme.text, fontSize: 22, fontWeight: '700', flex: 1 },
  refreshBtn: { paddingVertical: space.xs, paddingHorizontal: space.sm },
  refreshLabel: { color: theme.primary, fontSize: 13, fontWeight: '600' },
  empty: { color: theme.textMuted, textAlign: 'center', marginTop: space.xl },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.card,
    padding: space.md,
    borderRadius: radius.md,
    marginBottom: space.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  name: { color: theme.text, fontSize: 15, fontWeight: '600' },
  sku: { color: theme.textMuted, fontFamily: 'Menlo', fontSize: 11, marginTop: 2 },
  meta: { color: theme.textMuted, fontSize: 12, marginTop: 4 },
  chev: { color: theme.textMuted, fontSize: 22, marginLeft: space.sm },
});
