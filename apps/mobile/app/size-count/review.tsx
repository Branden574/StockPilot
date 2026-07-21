import { Stack, useRouter } from 'expo-router';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api } from '@/lib/api';
import { radius, space, theme } from '@/lib/theme';

const FILTERS = ['ALL', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL', 'XXXXXL', 'NONE'] as const;

interface Sample {
  id: string;
  sizeLabel: string;
  isNegative: boolean;
  capturedAt: string;
  url: string | null;
}

/**
 * Review captured training photos: a VIRTUALIZED thumbnail grid (only on-screen
 * cells mount — the old plain-ScrollView version mounted every image at once,
 * which blanked thumbnails and crashed the Fabric renderer on large sets).
 * Per-size filter + tap-to-delete a bad capture.
 */
// Fixed-pixel 3-column grid. `flex: 1/3 + aspectRatio + maxWidth` collapsed the
// cells to a sliver under the New Architecture renderer — computing an explicit
// square size from the screen width is the reliable way to lay out a FlatList
// grid.
const GRID_COLUMNS = 3;
const GRID_PAD = 8;
const GRID_GAP = 6;

export default function TrainingReviewScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const cellSize = Math.floor(
    (width - GRID_PAD * 2 - GRID_GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS,
  );
  const [filter, setFilter] = React.useState<(typeof FILTERS)[number]>('ALL');
  const [samples, setSamples] = React.useState<Sample[]>([]);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async (f: string) => {
    setLoading(true);
    try {
      const q = f === 'ALL' ? '' : `?size=${f}`;
      const res = await api<{ samples: Sample[] }>(`/api/v1/size-counts/training/samples${q}`);
      setSamples(res.samples ?? []);
    } catch {
      setSamples([]);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load(filter);
  }, [filter, load]);

  const confirmDelete = React.useCallback((s: Sample) => {
    Alert.alert(
      'Delete this photo?',
      `Remove this ${s.isNegative ? '"not a sticker"' : s.sizeLabel} capture. This can't be undone.`,
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setSamples((prev) => prev.filter((x) => x.id !== s.id));
            try {
              await api(`/api/v1/size-counts/training/samples/${s.id}`, { method: 'DELETE' });
            } catch (e) {
              setSamples((prev) => [s, ...prev]);
              Alert.alert(
                'Could not delete',
                e instanceof Error ? e.message.replace(/^API \d+:\s*/, '') : 'Try again.',
              );
            }
          },
        },
      ],
    );
  }, []);

  const renderItem = React.useCallback(
    ({ item }: { item: Sample }) => (
      <Pressable
        style={[styles.cell, { width: cellSize, height: cellSize }]}
        onPress={() => confirmDelete(item)}
      >
        {item.url ? (
          <Image source={{ uri: item.url }} style={styles.thumb} resizeMode="cover" />
        ) : (
          <View style={[styles.thumb, styles.thumbMissing]}>
            <Text style={styles.thumbMissingText}>no image</Text>
          </View>
        )}
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{item.isNegative ? '∅' : item.sizeLabel}</Text>
        </View>
      </Pressable>
    ),
    [confirmDelete, cellSize],
  );

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <Text style={styles.title}>Review captures</Text>
        <Text style={styles.subtitle}>
          {samples.length} {filter === 'ALL' ? 'total' : filter} · tap a photo to delete a bad one
        </Text>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterBar}
        contentContainerStyle={styles.filterRow}
      >
        {FILTERS.map((f) => {
          const active = filter === f;
          return (
            <Pressable key={f} onPress={() => setFilter(f)} style={[styles.chip, active && styles.chipActive]}>
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {f === 'NONE' ? 'Not sticker' : f}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : samples.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.empty}>No captures{filter !== 'ALL' ? ` for ${filter}` : ''} yet.</Text>
        </View>
      ) : (
        <FlatList
          data={samples}
          keyExtractor={(s) => s.id}
          numColumns={GRID_COLUMNS}
          renderItem={renderItem}
          columnWrapperStyle={styles.rowWrap}
          contentContainerStyle={styles.gridContent}
          // Virtualization tuning — keep the number of mounted images small so
          // the Fabric renderer isn't asked to commit hundreds of views at once.
          initialNumToRender={12}
          maxToRenderPerBatch={9}
          windowSize={5}
          removeClippedSubviews
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  empty: { color: theme.textMuted, fontSize: 14 },
  header: {
    paddingHorizontal: space.md, paddingBottom: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
  backBtn: { paddingVertical: space.xs },
  backText: { color: theme.primary, fontSize: 14 },
  title: { color: theme.text, fontSize: 22, fontWeight: '700', marginTop: 4 },
  subtitle: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  filterBar: { flexGrow: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  filterRow: { gap: space.xs, paddingHorizontal: space.md, paddingVertical: space.sm },
  chip: {
    minHeight: 34, paddingHorizontal: 14, borderRadius: 100, borderWidth: 1,
    borderColor: theme.border, alignItems: 'center', justifyContent: 'center',
  },
  chipActive: { backgroundColor: theme.primary, borderColor: theme.primary },
  chipText: { color: theme.text, fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: '#fff' },
  gridContent: { padding: GRID_PAD },
  rowWrap: { gap: GRID_GAP, marginBottom: GRID_GAP },
  cell: { borderRadius: radius.md, overflow: 'hidden' },
  thumb: { width: '100%', height: '100%', borderRadius: radius.md, backgroundColor: theme.card },
  thumbMissing: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: theme.border },
  thumbMissingText: { color: theme.textMuted, fontSize: 11 },
  badge: {
    position: 'absolute', bottom: 6, left: 6,
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2,
  },
  badgeText: { color: '#fff', fontSize: 12, fontWeight: '800' },
});
