import * as Network from 'expo-network';
import { useFocusEffect, useNavigation, useRouter } from 'expo-router';
import {
  ArrowLeft,
  Menu,
  Plus,
  WifiOff,
} from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';

import { Card } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { StockBar } from '@/components/ui/stock-bar';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import {
  dirtyLineCounts,
  listCachedCycleCounts,
  type CachedCycleCountHeader,
} from '@/lib/cycle-count-cache';
import { useSyncStatus } from '@/lib/cycle-count-sync';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/lib/use-org';
import { ACCENT, FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface OpenCount {
  id: string;
  warehouseName: string | null;
  startedAt: string;
  startedBy: string | null;
  /** Display name of the assignee, when the count is assigned to someone. */
  assigneeName: string | null;
  /** 'in_progress' | 'completed' | 'canceled'. */
  status: string;
  completedAt: string | null;
  totalLines: number;
  countedLines: number;
  source: 'server' | 'cache';
}

export default function CycleCounts() {
  const router = useRouter();
  const navigation = useNavigation();
  const { user } = useAuth();
  const { c } = useTheme();
  const tabBarHeight = useBottomTabBarHeight();
  const sync = useSyncStatus();
  const openDrawer = () => (navigation as { openDrawer?: () => void }).openDrawer?.();
  const { orgId } = useOrg();
  const [counts, setCounts] = React.useState<OpenCount[]>([]);
  const [pendingByCount, setPendingByCount] = React.useState<Map<string, number>>(new Map());
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [offline, setOffline] = React.useState(false);


  const load = React.useCallback(async () => {
    let online = true;
    try {
      const ns = await Network.getNetworkStateAsync();
      online = Boolean(ns.isConnected && ns.isInternetReachable !== false);
    } catch {
      online = true;
    }
    setOffline(!online);

    const cached = await listCachedCycleCounts();
    const cachedView: OpenCount[] = cached.map((c: CachedCycleCountHeader) => ({
      id: c.id,
      warehouseName: c.warehouseName,
      startedAt: c.startedAt,
      startedBy: null,
      assigneeName: null,
      status: 'in_progress',
      completedAt: null,
      totalLines: 0,
      countedLines: 0,
      source: 'cache',
    }));
    setCounts(cachedView);

    if (!online || !orgId) {
      const dirty = await dirtyLineCounts();
      setPendingByCount(dirty);
      return;
    }

    const { data, error } = await supabase
      .from('cycle_counts')
      .select(
        `id, started_at, started_by, assigned_to, status, completed_at,
         warehouse:warehouses!warehouse_id (name),
         starter:user_profiles!started_by (full_name, email),
         assignee:user_profiles!assigned_to (full_name, email),
         lines:cycle_count_lines (id, counted_quantity)`,
      )
      .eq('organization_id', orgId)
      // Load active + recent history (completed/canceled) so the floor can
      // review past counts, not just open ones.
      .order('started_at', { ascending: false })
      .limit(50);

    if (error || !data) {
      console.warn('cycle_counts list', error);
      const dirty = await dirtyLineCounts();
      setPendingByCount(dirty);
      return;
    }

    const flat: OpenCount[] = data.map((row) => {
      const r = row as Record<string, unknown>;
      const wh = r.warehouse as { name: string } | { name: string }[] | null;
      const whName = Array.isArray(wh) ? wh[0]?.name ?? null : wh?.name ?? null;
      const starterRow = r.starter as
        | { full_name: string | null; email: string | null }
        | { full_name: string | null; email: string | null }[]
        | null;
      const s = Array.isArray(starterRow) ? starterRow[0] : starterRow;
      const starter = s?.full_name ?? s?.email ?? null;
      const assigneeRow = r.assignee as
        | { full_name: string | null; email: string | null }
        | { full_name: string | null; email: string | null }[]
        | null;
      const a = Array.isArray(assigneeRow) ? assigneeRow[0] : assigneeRow;
      const assignee = a?.full_name ?? a?.email ?? null;
      const lines = (r.lines as Array<{ id: string; counted_quantity: number | null }> | null) ?? [];
      return {
        id: r.id as string,
        warehouseName: whName,
        startedAt: r.started_at as string,
        startedBy: starter,
        assigneeName: assignee,
        status: (r.status as string | null) ?? 'in_progress',
        completedAt: (r.completed_at as string | null) ?? null,
        totalLines: lines.length,
        countedLines: lines.filter((l) => l.counted_quantity !== null).length,
        source: 'server' as const,
      };
    });
    setCounts(flat);

    const dirty = await dirtyLineCounts();
    setPendingByCount(dirty);
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

  React.useEffect(() => {
    void (async () => {
      const dirty = await dirtyLineCounts();
      setPendingByCount(dirty);
    })();
  }, [sync.pendingCount, sync.status]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  // Active = still open (countable). History = posted/canceled, shown
  // read-only so the floor can review past counts.
  const active = counts.filter((c) => c.status === 'in_progress');
  const history = counts.filter((c) => c.status !== 'in_progress');
  const inProgress = active.length;
  const offlineCount = counts.filter((c) => c.source === 'cache').length;
  const pendingTotal = Array.from(pendingByCount.values()).reduce((a, b) => a + b, 0);
  // "Today" counts every count started today, regardless of status — so it
  // doesn't drop to 0 the moment a count is posted.
  const todayCount = counts.filter((c) => {
    if (!c.startedAt) return false;
    const d = new Date(c.startedAt);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  }).length;

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <IconChip
              icon={ArrowLeft}
              onPress={() => {
                if (router.canGoBack()) router.back();
                else router.replace('/');
              }}
            />
            <IconChip icon={Menu} onPress={openDrawer} />
          </View>
          <IconChip
            icon={Plus}
            onPress={() =>
              Alert.alert('Start a cycle count', 'Pick what you want to count, then tap Select.', [
                { text: 'Pick items', onPress: () => router.push('/inventory') },
                { text: 'Pick books', onPress: () => router.push('/books') },
                { text: 'Cancel', style: 'cancel' },
              ])
            }
          />
        </View>
        <View style={styles.head}>
          <Eyebrow>{`${inProgress} IN PROGRESS${offlineCount > 0 ? ` · ${offlineCount} OFFLINE` : ''}`}</Eyebrow>
          <Display size={34} style={{ marginTop: 12 }}>
            Cycle <Em>counts.</Em>
          </Display>
        </View>

        {offline ? (
          <View style={[styles.offlineBanner, { backgroundColor: c.paper2 }]}>
            <WifiOff size={14} color={c.ink3} strokeWidth={1.5} />
            <Mono size={11.5} tracking={0.04} color={c.ink3}>
              Offline · showing cached counts
            </Mono>
          </View>
        ) : null}

        <View style={styles.summaryGrid}>
          <SummaryTile label="TODAY" value={String(todayCount)} sub="counts" />
          <SummaryTile label="ACTIVE" value={String(inProgress)} sub="lists" />
          <SummaryTile label="PENDING" value={String(pendingTotal)} sub="to sync" kind="warn" />
        </View>

        <View style={styles.sectionHead}>
          <Eyebrow>ACTIVE COUNTS</Eyebrow>
          <Body size={12} muted>
            Filter
          </Body>
        </View>
      </SafeAreaView>

      {loading ? (
        <ActivityIndicator color={c.ink} style={{ marginTop: 32 }} />
      ) : (
        <FlatList
          data={active}
          keyExtractor={(c) => c.id}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: tabBarHeight + 24, gap: 10 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.ink} />
          }
          ListEmptyComponent={
            history.length > 0 ? (
              <View style={{ paddingVertical: 12 }}>
                <Body muted>No active counts. Tap ＋ to start one.</Body>
              </View>
            ) : (
              <View style={styles.empty}>
                <Display size={18}>No counts <Em>yet.</Em></Display>
                <Body muted style={{ marginTop: 6, textAlign: 'center' }}>
                  Tap ＋ to start a count — pick items or books, tap Select, then Review. Or start one from the web.
                </Body>
              </View>
            )
          }
          ListFooterComponent={
            history.length > 0 ? (
              <View style={{ marginTop: 22, gap: 10 }}>
                <Eyebrow>RECENT</Eyebrow>
                {history.map((h) => (
                  <CountCard
                    key={h.id}
                    count={h}
                    pending={pendingByCount.get(h.id) ?? 0}
                    onPress={() => router.push(`/cycle-count/${h.id}`)}
                  />
                ))}
              </View>
            ) : null
          }
          renderItem={({ item }) => {
            const pending = pendingByCount.get(item.id) ?? 0;
            return <CountCard count={item} pending={pending} onPress={() => router.push(`/cycle-count/${item.id}`)} />;
          }}
        />
      )}
    </View>
  );
}

function SummaryTile({
  label,
  value,
  sub,
  kind = 'ink',
}: {
  label: string;
  value: string;
  sub: string;
  kind?: 'ink' | 'mint' | 'warn';
}) {
  const { c, mode } = useTheme();
  const valueColor =
    kind === 'mint'
      ? mode === 'dark'
        ? ACCENT.mintInkDark
        : ACCENT.mintInk
      : kind === 'warn'
        ? ACCENT.warn
        : c.ink;
  return (
    <Card padding={12} style={{ flex: 1, gap: 6 }}>
      <Mono size={9} tracking={0.18} upper color={c.ink4}>
        {label}
      </Mono>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 3 }}>
        <Mono
          size={22}
          tracking={-0.022}
          color={valueColor}
          style={{ fontFamily: FONT.display }}
        >
          {value}
        </Mono>
        <Mono size={11} color={c.ink4} tracking={0}>
          {sub}
        </Mono>
      </View>
    </Card>
  );
}

function CountCard({
  count,
  pending,
  onPress,
}: {
  count: OpenCount;
  pending: number;
  onPress: () => void;
}) {
  const { c } = useTheme();
  const progress = count.totalLines > 0 ? Math.round((count.countedLines / count.totalLines) * 100) : 0;
  const isCompleted = count.status === 'completed';
  const isCanceled = count.status === 'canceled';
  const syncStatus = count.source === 'cache' ? 'OFFLINE' : pending > 0 ? 'PENDING' : 'SYNCED';
  const statusPill = isCompleted ? (
    <Pill status="ok">POSTED</Pill>
  ) : isCanceled ? (
    <Pill>CANCELED</Pill>
  ) : syncStatus === 'OFFLINE' ? (
    <Pill>OFFLINE</Pill>
  ) : syncStatus === 'PENDING' ? (
    <Pill status="warn">PENDING</Pill>
  ) : (
    <Pill status="ok">SYNCED</Pill>
  );
  const progressLabel = isCompleted
    ? count.completedAt
      ? `Posted · ${new Date(count.completedAt).toLocaleDateString()}`
      : 'Posted'
    : isCanceled
      ? 'Canceled'
      : progress === 100
        ? 'Ready to post · not finished'
        : `${progress}% counted`;
  const barKind: 'ok' | 'warn' = isCanceled
    ? 'warn'
    : isCompleted
      ? 'ok'
      : progress === 100
        ? 'warn'
        : 'ok';
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <Card padding={16}>
        <View style={countStyles.headerRow}>
          <View style={{ flex: 1 }}>
            <Mono
              size={15.5}
              tracking={-0.012}
              color={c.ink}
              style={{ fontFamily: FONT.display }}
            >
              {count.warehouseName ?? 'No warehouse'}
            </Mono>
            <Mono size={10.5} tracking={0.04} color={c.ink4} style={{ marginTop: 4 }}>
              {count.assigneeName
                ? `Assigned: ${count.assigneeName}`
                : count.startedBy ?? 'Unknown'}
              {count.startedAt ? ` · ${new Date(count.startedAt).toLocaleDateString()}` : ''}
            </Mono>
          </View>
          {statusPill}
        </View>
        {count.source === 'server' ? (
          <View style={countStyles.progressRow}>
            <Mono
              size={22}
              tracking={-0.022}
              color={c.ink}
              style={{ fontFamily: FONT.display }}
            >
              {count.countedLines}
              <Mono size={13} color={c.ink4} style={{ fontFamily: FONT.displayRegular }}>
                {' / '}{count.totalLines}
              </Mono>
            </Mono>
            <View style={{ flex: 1, gap: 6 }}>
              <StockBar
                value={progress}
                max={100}
                kind={barKind}
                height={4}
              />
              <Mono size={10} tracking={0.04} color={c.ink4}>
                {progressLabel}
              </Mono>
            </View>
          </View>
        ) : null}
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
  offlineBanner: {
    marginHorizontal: 20,
    marginTop: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  summaryGrid: {
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 6,
    flexDirection: 'row',
    gap: 10,
  },
  sectionHead: {
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  empty: { padding: 32, alignItems: 'center' },
});

const countStyles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  progressRow: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
});
