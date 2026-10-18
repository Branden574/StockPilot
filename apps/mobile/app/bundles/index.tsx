import { Stack, useRouter } from 'expo-router';
import { ChevronRight, RefreshCw } from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card } from '@/components/ui/card';
import { Body, Display, Mono } from '@/components/ui/text';
import { listBundles, type CachedBundle } from '@/lib/db-reads';
import { syncNow } from '@/lib/sync';
import { FONT, space } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * Bundles: the kits this phone holds in its offline cache (the sync
 * snapshot, RLS-scoped), each opening its bundle. Refresh (the button, or a
 * pull on the list) syncs and reads the cache again.
 *
 * Look (redesign P5.9): the device's mode on the per-mode palette (it was
 * drawn from the light-only legacy theme and stayed light in dark mode), the
 * reference's cards, and icons in place of the text glyphs (the refresh
 * arrow, the row chevron). "← Back" and "Refresh" keep their words, names
 * and 44pt frames.
 */
export default function BundlesList() {
  const { c } = useTheme();
  const router = useRouter();
  const [rows, setRows] = React.useState<CachedBundle[]>([]);
  const [refreshing, setRefreshing] = React.useState(false);
  // A pull's own spinner: the list's pull-to-refresh shows it, so the body's
  // spinner stays away and one refresh never shows two.
  const [pulling, setPulling] = React.useState(false);

  const load = React.useCallback(async () => {
    const list = await listBundles();
    setRows(list);
  }, []);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: every set is post-await; the effect synchronizes with the server
    void load();
  }, [load]);

  // The refreshing state ends when this refresh ends, whatever happened: a
  // cache read that threw used to leave Refresh busy for good.
  async function refresh() {
    setRefreshing(true);
    try {
      await syncNow();
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  // The empty words say "Pull-to-refresh": the list now has the pull it
  // promises (before, only the Refresh button refreshed).
  async function pull() {
    setPulling(true);
    try {
      await refresh();
    } finally {
      setPulling(false);
    }
  }

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: c.paper }]} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.header, { borderBottomColor: c.hair }]}>
        <Pressable
          onPress={() => router.back()}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Text style={[styles.backText, { color: c.ink }]}>← Back</Text>
        </Pressable>
        <Display size={24} style={styles.title}>
          Bundles
        </Display>
        <Pressable
          onPress={refresh}
          style={styles.refreshBtn}
          accessibilityRole="button"
          accessibilityLabel="Refresh"
          accessibilityState={{ busy: refreshing }}
        >
          {/* While it syncs, a spinner stands in for the arrow; the word
              stays, so the button keeps its name on screen. */}
          {refreshing ? (
            <ActivityIndicator size="small" color={c.ink} />
          ) : (
            <RefreshCw size={14} color={c.ink} strokeWidth={1.75} />
          )}
          <Text style={[styles.refreshLabel, { color: c.ink }]}>Refresh</Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={
          <RefreshControl refreshing={pulling} onRefresh={() => void pull()} tintColor={c.ink} />
        }
      >
        {refreshing && !pulling && rows.length === 0 ? (
          <ActivityIndicator color={c.ink} style={{ marginTop: space.xl }} />
        ) : null}
        {rows.length === 0 && !refreshing ? (
          <Body muted style={styles.empty}>
            No bundles synced yet. Pull-to-refresh or check back after the next sync.
          </Body>
        ) : null}
        {rows.map((b) => (
          <Pressable
            key={b.id}
            onPress={() => router.push(`/bundles/${b.id}`)}
            // A button to VoiceOver (it read the row's words with no trait).
            accessibilityRole="button"
            accessibilityHint="Opens the bundle"
            style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
          >
            <Card padding={14}>
              <View style={styles.row}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>
                    {b.name}
                  </Body>
                  {b.sku ? (
                    <Mono size={11.5} color={c.ink3} style={{ marginTop: 3 }}>
                      {b.sku}
                    </Mono>
                  ) : null}
                  <Body size={12.5} muted style={{ marginTop: 4 }}>
                    {b.preassemblyEnabled ? `${b.phantomQty} pre-assembled` : 'Virtual recipe'}
                  </Body>
                </View>
                <ChevronRight size={16} color={c.ink4} strokeWidth={1.5} />
              </View>
            </Card>
          </Pressable>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  // "← Back" and Refresh are buttons in frames at least 44pt tall (they were
  // the ~25pt text). -9 top and bottom leaves each a 26pt slot, the title's
  // line, so the row keeps its height; the frames reach into the header's
  // padding above and below.
  backBtn: { minHeight: 44, minWidth: 44, justifyContent: 'center', marginVertical: -9 },
  backText: { fontFamily: FONT.display, fontSize: 14 },
  title: { flex: 1 },
  refreshBtn: {
    minHeight: 44,
    minWidth: 44,
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    alignItems: 'center',
    marginVertical: -9,
    paddingHorizontal: space.sm,
  },
  refreshLabel: { fontFamily: FONT.display, fontSize: 13 },
  body: { padding: space.md, paddingBottom: 80, gap: space.sm },
  empty: { textAlign: 'center', marginTop: space.xl },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
});
