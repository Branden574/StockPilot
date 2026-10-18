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

/** Where the read of the offline cache is: not answered yet, read, or failed. */
type CacheRead = 'pending' | 'ok' | 'failed';

/**
 * What the list's body shows besides its rows. A cache read that failed is
 * never "No bundles synced yet." (CONFLICTS D25): with no rows the failure is
 * said in their place, and rows from an earlier read stay under a note that
 * says they could not be refreshed. Before the first read answers, nothing is
 * claimed: the spinner shows. A pull shows its own spinner, so the body's
 * stays away and one refresh never shows two.
 */
function bundlesListBody(
  read: CacheRead,
  rowCount: number,
  refreshing: boolean,
  pulling: boolean,
): { spinner: boolean; words: 'empty' | 'failed' | null; staleNote: boolean } {
  const empty = rowCount === 0;
  return {
    spinner: empty && !pulling && (refreshing || read === 'pending'),
    words:
      empty && !refreshing && read !== 'pending' ? (read === 'failed' ? 'failed' : 'empty') : null,
    staleNote: !empty && read === 'failed',
  };
}

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
  const [read, setRead] = React.useState<CacheRead>('pending');
  const [refreshing, setRefreshing] = React.useState(false);
  // A pull's own spinner: the list's pull-to-refresh shows it, so the body's
  // spinner stays away and one refresh never shows two.
  const [pulling, setPulling] = React.useState(false);

  // A cache read that throws is caught here and said on screen
  // (bundlesListBody): it used to escape as an unhandled rejection from the
  // first load, Refresh and a pull, and leave "No bundles synced yet." over a
  // read that had failed. The rows already shown stay.
  const load = React.useCallback(async () => {
    try {
      const list = await listBundles();
      setRows(list);
      setRead('ok');
    } catch (e) {
      console.warn('[bundles] cache read failed:', e instanceof Error ? e.message : e);
      setRead('failed');
    }
  }, []);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: every set is post-await; the effect synchronizes with the server
    void load();
  }, [load]);

  // The refreshing state ends when this refresh ends, whatever happened: a
  // cache read that threw used to leave Refresh busy for good. Neither step
  // rejects (syncNow and load catch their own failures), so neither does
  // this, from the button or from a pull.
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

  const body = bundlesListBody(read, rows.length, refreshing, pulling);

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
        {body.spinner ? <ActivityIndicator color={c.ink} style={{ marginTop: space.xl }} /> : null}
        {body.words === 'failed' ? (
          <Body color={c.warnText} accessibilityRole="alert" style={styles.empty}>
            Could not read the bundles saved on this phone. Tap Refresh to try again.
          </Body>
        ) : body.words === 'empty' ? (
          <Body muted style={styles.empty}>
            No bundles synced yet. Pull-to-refresh or check back after the next sync.
          </Body>
        ) : null}
        {body.staleNote ? (
          <Body size={13} color={c.warnText} accessibilityRole="alert">
            Could not refresh the bundles. Tap Refresh to try again.
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
