import * as Network from 'expo-network';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SyncStatusBadge } from '@/components/SyncStatusBadge';
import { useAuth } from '@/lib/auth-context';
import {
  cacheCycleCount,
  getCycleCount,
  pendingCountFor,
  updateLocalLine,
  type CachedCycleCountHeader,
  type CachedCycleCountLine,
} from '@/lib/cycle-count-cache';
import { cycleCountSync, useSyncStatus } from '@/lib/cycle-count-sync';
import { supabase } from '@/lib/supabase';
import { radius, space, theme } from '@/lib/theme';

interface UiLine {
  id: string;
  itemId: string;
  itemName: string;
  itemSku: string;
  itemBarcode: string | null;
  expected: number;
  counted: number | null;
  localDirty: boolean;
}

const SAVE_DEBOUNCE_MS = 300;

export default function CycleCountDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const syncSnapshot = useSyncStatus();

  const [orgId, setOrgId] = React.useState<string | null>(null);
  const [header, setHeader] = React.useState<CachedCycleCountHeader | null>(null);
  const [lines, setLines] = React.useState<UiLine[]>([]);
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [loading, setLoading] = React.useState(true);
  const [posting, setPosting] = React.useState(false);
  const [pendingForThis, setPendingForThis] = React.useState(0);
  const [emptyState, setEmptyState] = React.useState<'none' | 'offline-uncached'>('none');
  const [conflictBanner, setConflictBanner] = React.useState<string | null>(null);

  const debounceRefs = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Resolve the user's org once — needed to scope server fetches.
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

  /**
   * Load order:
   *   1. Read SQLite cache → if hit, render immediately.
   *   2. If we're online, ALSO fetch fresh from Supabase and merge
   *      (server-wins for clean lines, local-wins for dirty).
   *   3. If cache missed AND offline → show empty state.
   */
  const load = React.useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setEmptyState('none');

    const cached = await getCycleCount(id);
    if (cached) {
      hydrateFromSnapshot(cached);
      setLoading(false);
    }

    let online = false;
    try {
      const ns = await Network.getNetworkStateAsync();
      online = Boolean(ns.isConnected && ns.isInternetReachable !== false);
    } catch {
      online = true;
    }

    if (!online) {
      if (!cached) {
        setEmptyState('offline-uncached');
        setLoading(false);
      }
      return;
    }
    if (!orgId) return;

    // Network fetch — populates / refreshes the cache.
    const [{ data: cc, error: ccErr }, { data: lineRows, error: lErr }] = await Promise.all([
      supabase
        .from('cycle_counts')
        .select(
          `id, organization_id, status, started_at, posted_at, warehouse_id,
           warehouse:warehouses!warehouse_id (name)`,
        )
        .eq('organization_id', orgId)
        .eq('id', id)
        .maybeSingle(),
      supabase
        .from('cycle_count_lines')
        .select(
          `id, expected_quantity, counted_quantity, counted_at, updated_at,
           item:inventory_items!item_id (id, name, sku, barcode)`,
        )
        .eq('cycle_count_id', id),
    ]);

    if (ccErr || lErr || !cc) {
      // Couldn't fetch — if we already have a cache hit, just show it.
      if (!cached) {
        setLoading(false);
      }
      return;
    }

    const ccRow = cc as Record<string, unknown>;
    const wh = ccRow.warehouse as { name: string } | { name: string }[] | null;
    const whName = Array.isArray(wh) ? wh[0]?.name ?? null : wh?.name ?? null;

    const fetchedHeader = {
      id: ccRow.id as string,
      organizationId: (ccRow.organization_id as string | null) ?? null,
      warehouseId: (ccRow.warehouse_id as string | null) ?? null,
      warehouseName: whName,
      status: (ccRow.status as string | null) ?? 'in_progress',
      startedAt: (ccRow.started_at as string | null) ?? new Date().toISOString(),
      postedAt: (ccRow.posted_at as string | null) ?? null,
    };

    const fetchedLines = ((lineRows ?? []) as Array<Record<string, unknown>>).map((r) => {
      const itm = r.item as
        | { id: string; name: string; sku: string; barcode: string | null }
        | { id: string; name: string; sku: string; barcode: string | null }[]
        | null;
      const item = Array.isArray(itm) ? itm[0] : itm;
      const updatedAt =
        (r.updated_at as string | null | undefined) ??
        (r.counted_at as string | null | undefined) ??
        null;
      return {
        id: r.id as string,
        itemId: item?.id ?? '',
        itemName: item?.name ?? 'Unknown',
        itemSku: item?.sku ?? '',
        itemBarcode: item?.barcode ?? null,
        expected: Number(r.expected_quantity),
        counted:
          r.counted_quantity === null || r.counted_quantity === undefined
            ? null
            : Number(r.counted_quantity),
        updatedAt,
      };
    });

    // Conflict detection: any line we have a pending edit for whose
    // server-side counted_quantity is newer than what we cached AND
    // differs from the value we're about to push? Surface a banner.
    if (cached) {
      const conflicts = fetchedLines.filter((s) => {
        const local = cached.lines.find((c) => c.id === s.id);
        if (!local || !local.localDirty) return false;
        if (s.counted === null) return false;
        if (s.counted === local.counted) return false;
        return true;
      });
      if (conflicts.length > 0) {
        setConflictBanner(
          `${conflicts.length} line${conflicts.length === 1 ? '' : 's'} updated on the server while you were offline — your local edits will overwrite when synced.`,
        );
      }
    }

    await cacheCycleCount(fetchedHeader, fetchedLines);
    const fresh = await getCycleCount(id);
    if (fresh) hydrateFromSnapshot(fresh);
    setLoading(false);
  }, [id, orgId]);

  function hydrateFromSnapshot(snap: { header: CachedCycleCountHeader; lines: CachedCycleCountLine[] }) {
    setHeader(snap.header);
    const ui: UiLine[] = snap.lines
      .map((l) => ({
        id: l.id,
        itemId: l.itemId,
        itemName: l.itemName,
        itemSku: l.itemSku,
        itemBarcode: l.itemBarcode,
        expected: l.expected,
        counted: l.counted,
        localDirty: l.localDirty,
      }))
      .sort((a, b) => a.itemName.localeCompare(b.itemName));
    setLines(ui);
  }

  React.useEffect(() => {
    void load();
  }, [load]);

  // Refresh per-cycle pending count whenever the global sync state changes.
  React.useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void (async () => {
      const n = await pendingCountFor(id);
      if (!cancelled) setPendingForThis(n);
    })();
    return () => {
      cancelled = true;
    };
  }, [id, syncSnapshot.pendingCount, syncSnapshot.status]);

  // Cancel pending debounce timers on unmount so state-after-unmount
  // writes don't leak.
  React.useEffect(() => {
    return () => {
      for (const k of Object.keys(debounceRefs.current)) {
        clearTimeout(debounceRefs.current[k]);
      }
    };
  }, []);

  function setDraftValue(lineId: string, v: string) {
    setDraft((d) => ({ ...d, [lineId]: v }));

    // Debounced persist + outbox enqueue. Local-only, no network.
    if (debounceRefs.current[lineId]) clearTimeout(debounceRefs.current[lineId]);
    debounceRefs.current[lineId] = setTimeout(() => {
      void persistLine(lineId, v);
    }, SAVE_DEBOUNCE_MS);
  }

  async function persistLine(lineId: string, raw: string) {
    if (raw.trim() === '') return; // empty input — don't persist a clear here
    const num = Number.parseFloat(raw);
    if (!Number.isFinite(num) || num < 0) return;

    await updateLocalLine(lineId, num);
    setLines((curr) =>
      curr.map((l) =>
        l.id === lineId ? { ...l, counted: num, localDirty: true } : l,
      ),
    );
    setDraft((d) => {
      const { [lineId]: _drop, ...rest } = d;
      return rest;
    });

    await cycleCountSync.refreshPendingCount();
    void cycleCountSync.forceSync();
  }

  async function postCount() {
    if (!header) return;
    if (syncSnapshot.status === 'offline') {
      Alert.alert(
        'Offline',
        'Reconnect to post this cycle count. Your counts are saved locally and will sync first.',
      );
      return;
    }
    if (syncSnapshot.pendingCount > 0 || pendingForThis > 0) {
      Alert.alert(
        'Sync first',
        'There are unsynced edits. Wait for sync to finish (or tap the badge to retry) before posting.',
      );
      return;
    }

    const uncounted = lines.filter((l) => l.counted === null && draft[l.id] === undefined);
    const proceed = await new Promise<boolean>((resolve) => {
      Alert.alert(
        'Post cycle count?',
        uncounted.length > 0
          ? `${uncounted.length} line${uncounted.length === 1 ? '' : 's'} not counted will be skipped (no variance applied).`
          : 'All lines will be applied as adjustments to inventory.',
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Post', style: 'destructive', onPress: () => resolve(true) },
        ],
      );
    });
    if (!proceed) return;

    setPosting(true);
    const { error } = await supabase.rpc('post_cycle_count', {
      p_cycle_count_id: header.id,
    });
    setPosting(false);
    if (error) {
      Alert.alert('Could not post', error.message);
      return;
    }
    Alert.alert('Posted', 'Variance adjustments applied.');
    router.back();
  }

  const countedCount = lines.filter((l) => l.counted !== null).length;
  const allCounted = countedCount === lines.length && lines.length > 0;
  const offline = syncSnapshot.status === 'offline';
  const hasPending = syncSnapshot.pendingCount > 0 || pendingForThis > 0;
  const postDisabled = posting || countedCount === 0 || offline || hasPending;

  if (emptyState === 'offline-uncached') {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <Text style={styles.backText}>← Back</Text>
          </Pressable>
        </View>
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>Not cached for offline use</Text>
          <Text style={styles.emptyBody}>
            Open this cycle count once while online to use it offline next time.
          </Text>
          <Pressable
            style={styles.retryBtn}
            onPress={() => {
              setEmptyState('none');
              void load();
            }}
          >
            <Text style={styles.retryLabel}>Retry</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Cycle count</Text>
            <Text style={styles.subtitle}>
              {header?.warehouseName ?? '—'} · {countedCount}/{lines.length} counted
            </Text>
          </View>
          {header && (
            <View style={{ flexDirection: 'row', gap: space.xs }}>
              <Pressable
                onPress={() => router.push(`/cycle-count/ai-scan/${header.id}`)}
                style={[styles.scanBtn, styles.aiScanBtn]}
              >
                <Text style={styles.scanBtnLabel}>AI Scan</Text>
              </Pressable>
              <Pressable
                onPress={() => router.push(`/cycle-count/scan/${header.id}`)}
                style={styles.scanBtn}
              >
                <Text style={styles.scanBtnLabel}>Scan</Text>
              </Pressable>
            </View>
          )}
        </View>
        <View style={styles.badgeRow}>
          <SyncStatusBadge />
        </View>
      </View>

      {conflictBanner && (
        <View style={styles.conflictBanner}>
          <Text style={styles.conflictText}>{conflictBanner}</Text>
          <Pressable onPress={() => setConflictBanner(null)}>
            <Text style={styles.conflictDismiss}>Dismiss</Text>
          </Pressable>
        </View>
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.primary} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: space.md, paddingBottom: 140 }}>
          {lines.map((l) => {
            const draftVal = draft[l.id];
            const isDrafting = draftVal !== undefined;
            const display = isDrafting
              ? draftVal
              : l.counted !== null
                ? String(l.counted)
                : '';
            const variance =
              l.counted !== null ? l.counted - l.expected : null;
            return (
              <View key={l.id} style={styles.card}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemName} numberOfLines={2}>
                    {l.itemName}
                  </Text>
                  <Text style={styles.itemSku}>{l.itemSku}</Text>
                  <Text style={styles.expected}>
                    Expected: {l.expected}
                    {variance !== null && variance !== 0 && (
                      <Text
                        style={
                          variance > 0
                            ? { color: theme.success }
                            : { color: theme.destructive }
                        }
                      >
                        {' · Δ '}
                        {variance > 0 ? '+' : ''}
                        {variance}
                      </Text>
                    )}
                    {l.localDirty && (
                      <Text style={{ color: theme.warning }}> · unsynced</Text>
                    )}
                  </Text>
                </View>
                <View style={styles.countBox}>
                  <TextInput
                    style={styles.countInput}
                    value={display}
                    onChangeText={(v) => setDraftValue(l.id, v)}
                    keyboardType="numeric"
                    placeholder="—"
                    placeholderTextColor={theme.textMuted}
                  />
                </View>
              </View>
            );
          })}

          {lines.length === 0 && (
            <Text style={styles.emptyText}>
              This count has no lines yet. Add lines from the web first.
            </Text>
          )}
        </ScrollView>
      )}

      {!loading && lines.length > 0 && (
        <View style={styles.footer}>
          <Pressable
            onPress={postCount}
            disabled={postDisabled}
            style={({ pressed }) => [
              styles.postBtn,
              !allCounted && { backgroundColor: theme.warning },
              (pressed || postDisabled) && { opacity: 0.6 },
            ]}
          >
            <Text style={styles.postBtnText}>
              {posting
                ? 'Posting…'
                : offline
                  ? 'Reconnect to post'
                  : hasPending
                    ? 'Sync pending edits to post'
                    : allCounted
                      ? 'Post cycle count'
                      : `Post (${countedCount}/${lines.length} counted)`}
            </Text>
          </Pressable>
        </View>
      )}
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
  },
  backBtn: { paddingVertical: space.xs },
  backText: { color: theme.primary, fontSize: 14 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: 4 },
  title: { color: theme.text, fontSize: 22, fontWeight: '700' },
  subtitle: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  badgeRow: { marginTop: space.sm, flexDirection: 'row', alignItems: 'center' },
  scanBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    backgroundColor: theme.primary,
  },
  aiScanBtn: {
    // Slight purple tint so the AI button is visually distinct from
    // the regular Scan button — same hierarchy, different affordance.
    backgroundColor: '#7c3aed',
  },
  scanBtnLabel: { color: '#fff', fontSize: 13, fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  card: {
    flexDirection: 'row',
    backgroundColor: theme.card,
    padding: space.md,
    borderRadius: radius.md,
    marginBottom: space.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  itemName: { color: theme.text, fontSize: 14, fontWeight: '600' },
  itemSku: {
    color: theme.textMuted,
    fontFamily: 'Menlo',
    fontSize: 11,
    marginTop: 2,
  },
  expected: { color: theme.textMuted, fontSize: 12, marginTop: 4 },
  countBox: { alignItems: 'flex-end', justifyContent: 'center', minWidth: 110 },
  countInput: {
    color: theme.text,
    fontSize: 18,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    backgroundColor: theme.bg,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    minWidth: 80,
    textAlign: 'right',
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: space.md,
    backgroundColor: theme.bgElevated,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
  },
  postBtn: {
    backgroundColor: theme.primary,
    paddingVertical: space.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  postBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  emptyText: {
    color: theme.textMuted,
    fontSize: 14,
    textAlign: 'center',
    padding: space.xl,
  },
  emptyTitle: { color: theme.text, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  emptyBody: {
    color: theme.textMuted,
    fontSize: 14,
    textAlign: 'center',
    marginTop: space.sm,
  },
  retryBtn: {
    marginTop: space.lg,
    backgroundColor: theme.primary,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
    borderRadius: radius.md,
  },
  retryLabel: { color: '#fff', fontWeight: '600' },
  conflictBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    borderColor: theme.warning,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  conflictText: { color: theme.text, fontSize: 12, flex: 1 },
  conflictDismiss: { color: theme.warning, fontWeight: '700', fontSize: 12 },
});
