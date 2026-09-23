import * as Network from 'expo-network';
import { useFocusEffect, useNavigation, useRouter } from 'expo-router';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Menu,
  Plus,
  Search,
  WifiOff,
  X,
} from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  Pressable,
  RefreshControl,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useBottomTabBarHeight } from 'expo-router/js-tabs';

import {
  CYCLE_COUNT_REFERENCE_UNAVAILABLE,
  CYCLE_COUNT_SEARCH_MAX_LENGTH,
  CYCLE_COUNT_STATUS_LABELS,
  CYCLE_COUNT_STATUSES,
  cycleCountScopeLabel,
  formatCycleCountNumber,
  formatListFooter,
  formatOrgDateTime,
  type CycleCountStatusValue,
} from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { StockBar } from '@/components/ui/stock-bar';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import {
  dirtyLineCounts,
  listCachedCycleCounts,
  type CachedCycleCountHeader,
} from '@/lib/cycle-count-cache';
import {
  isCurrentListAnswer,
  recallListView,
  rememberListView,
  searchDownloadedCounts,
  type CycleCountListItem,
  type CycleCountListResponse,
  type CycleCountListSummary,
  type CycleCountListView,
} from '@/lib/cycle-count-history';
import { listCycleCounts } from '@/lib/cycle-counts-api';
import { showWriteCta } from '@/lib/cta-gating';
import { useSyncStatus } from '@/lib/cycle-count-sync';
import { createDebouncedScheduler, createSequenceGuard } from '@/lib/debounced-list-load';
import { shouldStackRow } from '@/lib/dynamic-type-layout';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { useOrg } from '@/lib/use-org';
import { ACCENT, FONT, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/** Typing settles for this long before the list is asked for again. */
const SEARCH_DEBOUNCE_MS = 250;

const NOUN = { one: 'cycle count', other: 'cycle counts' };

/** A row on screen: a server page row, or a downloaded count while offline. */
interface ListRow {
  id: string;
  countNumber: number | null;
  scopeLabel: string;
  status: string;
  notes: string | null;
  startedAt: string;
  completedAt: string | null;
  who: string | null;
  lineTotal: number;
  lineCounted: number;
  source: 'server' | 'downloaded';
}

function fromServer(item: CycleCountListItem): ListRow {
  return {
    id: item.id,
    countNumber: item.countNumber,
    scopeLabel: cycleCountScopeLabel(item),
    status: item.status,
    notes: item.notes,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
    who: item.assigneeName
      ? `Assigned: ${item.assigneeName}`
      : item.startedByName
        ? `Started by ${item.startedByName}`
        : null,
    lineTotal: item.lineTotal,
    lineCounted: item.lineCounted,
    source: 'server',
  };
}

function fromDownload(c: CachedCycleCountHeader): ListRow {
  return {
    id: c.id,
    countNumber: c.countNumber ?? null,
    // The download does not carry the count's scope, so a count with no
    // header warehouse is described as exactly that, never as "All warehouses".
    scopeLabel: c.warehouseName ?? (c.warehouseId ? 'Warehouse not downloaded' : 'No single warehouse'),
    status: c.status,
    notes: c.notes ?? null,
    startedAt: c.startedAt,
    completedAt: c.postedAt,
    who: null,
    lineTotal: 0,
    lineCounted: 0,
    source: 'downloaded',
  };
}

/** The downloaded (cached) counts, or null when the device store cannot be read. */
async function readDownloaded(): Promise<CachedCycleCountHeader[] | null> {
  try {
    return await listCachedCycleCounts();
  } catch {
    return null;
  }
}

function sameView(a: CycleCountListView, b: CycleCountListView): boolean {
  return a.q === b.q && a.status === b.status && a.page === b.page;
}

export default function CycleCounts() {
  const router = useRouter();
  const navigation = useNavigation();
  const { c } = useTheme();
  const tabBarHeight = useBottomTabBarHeight();
  const sync = useSyncStatus();
  // Live scale (re-renders when the user changes Larger Text mid-session);
  // threshold lives in the pure, unit-tested helper.
  const stackedSummary = shouldStackRow(useWindowDimensions().fontScale);
  const openDrawer = () => (navigation as { openDrawer?: () => void }).openDrawer?.();
  const { orgId } = useOrg();
  // Write-CTA gate: starting a count posts stock adjustments, so the "+"
  // follows stock:adjust. Cosmetic (the API enforces server-side); while the
  // effective set is loading (undefined) the CTA shows — today's behavior.
  const perms = useEffectivePermissions();
  const canStartCount = showWriteCta(perms, 'stock:adjust');

  // What the list shows (search, status, page), restored per workspace when
  // the screen comes back, so opening a count and returning keeps the view.
  const [view, setView] = React.useState<CycleCountListView>(() => recallListView(orgId));
  const [draftQ, setDraftQ] = React.useState(view.q);
  const [page, setPage] = React.useState<CycleCountListResponse | null>(null);
  const [summary, setSummary] = React.useState<CycleCountListSummary | null>(null);
  const [downloaded, setDownloaded] = React.useState<CachedCycleCountHeader[] | null>(null);
  const [offline, setOffline] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [pendingByCount, setPendingByCount] = React.useState<Map<string, number>>(new Map());

  const guard = React.useRef(createSequenceGuard());
  const debounce = React.useRef(createDebouncedScheduler(SEARCH_DEBOUNCE_MS));
  const inFlight = React.useRef<AbortController | null>(null);
  const orgRef = React.useRef(orgId);
  const viewRef = React.useRef(view);
  // Kept current for the async load (a layout effect runs before every effect
  // below that reads them).
  React.useLayoutEffect(() => {
    orgRef.current = orgId;
    viewRef.current = view;
  });
  // The view (and workspace) the last load was started for, so a view change
  // that only reconciles the page to what the server answered does not load
  // it a second time.
  const requested = React.useRef<{ orgId: string | null; view: CycleCountListView } | null>(null);

  const load = React.useCallback(
    async (target: CycleCountListView, opts: { withSummary: boolean }) => {
      const token = guard.current.next();
      inFlight.current?.abort();
      const ctrl = new AbortController();
      inFlight.current = ctrl;
      const activeOrg = orgRef.current;
      requested.current = { orgId: activeOrg, view: target };

      let online = true;
      try {
        const ns = await Network.getNetworkStateAsync();
        online = Boolean(ns.isConnected && ns.isInternetReachable !== false);
      } catch {
        online = true;
      }
      if (!guard.current.isCurrent(token)) return;
      setOffline(!online);
      void dirtyLineCounts().then((dirty) => {
        if (guard.current.isCurrent(token)) setPendingByCount(dirty);
      });

      if (!activeOrg) return; // the workspace is still resolving; its switch loads
      if (!online) {
        // Offline: only what this device downloaded. Read, never written back.
        const cached = await readDownloaded();
        if (!guard.current.isCurrent(token)) return;
        setDownloaded(cached ?? []);
        setError(cached ? null : 'Could not read the counts saved on this device.');
        setBusy(false);
        return;
      }

      setBusy(true);
      try {
        const res = await listCycleCounts(target, { summary: opts.withSummary, signal: ctrl.signal });
        if (!isCurrentListAnswer(res, orgRef.current, guard.current.isCurrent(token))) {
          // A newer request, or a workspace switch that has its own load, owns
          // the screen: drop this answer quietly. But an answer for another
          // workspace to the NEWEST request, with no switch since, means the
          // app and the server disagree about the workspace. Say so; never spin.
          if (guard.current.isCurrent(token) && orgRef.current === activeOrg) {
            setPage(null);
            setError('The server answered for a different workspace. Pull down to refresh, or switch workspace from the menu.');
          }
          return;
        }
        setPage(res);
        setDownloaded(null);
        setError(null);
        if (opts.withSummary) setSummary(res.summary ?? null);
        if (res.page !== target.page) {
          // The server answered a different page (the list shrank under a
          // filter, or a stale page ran past the end): show the page it gave.
          const reconciled = { ...target, page: res.page };
          requested.current = { orgId: activeOrg, view: reconciled };
          setView(reconciled);
        }
      } catch (e) {
        if (ctrl.signal.aborted || !guard.current.isCurrent(token)) return;
        // A failed read is an error on screen, never an empty history. The
        // counts already downloaded to this device stay reachable under it (a
        // weak warehouse connection is exactly when counting offline matters),
        // labelled as downloaded counts only.
        setPage(null);
        setError(e instanceof Error ? e.message : 'Could not load cycle counts.');
        const cached = await readDownloaded();
        if (guard.current.isCurrent(token)) setDownloaded(cached ?? []);
      } finally {
        if (guard.current.isCurrent(token)) setBusy(false);
      }
    },
    [],
  );

  // A workspace switch starts that workspace's own view.
  const lastOrg = React.useRef(orgId);
  React.useEffect(() => {
    if (lastOrg.current === orgId) return;
    lastOrg.current = orgId;
    const next = recallListView(orgId);
    debounce.current.cancel();
    setPage(null);
    setSummary(null);
    setDownloaded(null);
    setError(null);
    setDraftQ(next.q);
    setView(next);
    void load(next, { withSummary: true });
  }, [orgId, load]);

  React.useEffect(() => {
    rememberListView(orgId, view);
  }, [orgId, view]);

  // Every return to the screen reloads the SAME view (never page 1), with the
  // tile totals.
  useFocusEffect(
    React.useCallback(() => {
      void load(viewRef.current, { withSummary: true });
    }, [load]),
  );

  // Search, status and page changes load that view.
  React.useEffect(() => {
    const last = requested.current;
    if (last && last.orgId === orgRef.current && sameView(last.view, view)) return;
    void load(view, { withSummary: false });
  }, [view, load]);

  // Typing settles, then searches from page 1.
  React.useEffect(() => {
    const next = draftQ.trim();
    if (next === viewRef.current.q) {
      debounce.current.cancel();
      return;
    }
    debounce.current.schedule(() => setView((v) => ({ ...v, q: next, page: 1 })));
  }, [draftQ]);

  React.useEffect(() => {
    const d = debounce.current;
    return () => {
      d.cancel();
      inFlight.current?.abort();
    };
  }, []);

  React.useEffect(() => {
    void (async () => {
      const dirty = await dirtyLineCounts();
      setPendingByCount(dirty);
    })();
  }, [sync.pendingCount, sync.status]);

  function searchNow() {
    debounce.current.cancel();
    Keyboard.dismiss();
    const next = draftQ.trim();
    setView((v) => (v.q === next ? v : { ...v, q: next, page: 1 }));
  }

  function clearSearch() {
    debounce.current.cancel();
    setDraftQ('');
    setView((v) => (v.q === '' ? v : { ...v, q: '', page: 1 }));
  }

  function setStatus(status: CycleCountStatusValue | null) {
    setView((v) => (v.status === status ? v : { ...v, status, page: 1 }));
  }

  async function refresh() {
    setRefreshing(true);
    await load(viewRef.current, { withSummary: true });
    setRefreshing(false);
  }

  // Downloaded counts are shown offline, and under the error when an online
  // read failed; otherwise the server's page.
  const showingDownloaded = offline || (error !== null && downloaded !== null);
  const rows: ListRow[] = showingDownloaded
    ? searchDownloadedCounts(downloaded ?? [], view).map(fromDownload)
    : (page?.items ?? []).map(fromServer);
  const searching = view.q !== '' || view.status !== null;
  const pendingTotal = Array.from(pendingByCount.values()).reduce((a, b) => a + b, 0);
  const tz = summary?.timezone;
  const inProgressText = offline || !summary ? '—' : String(summary.inProgress);
  const todayText = offline || !summary ? '—' : String(summary.startedToday);

  const footerText = showingDownloaded
    ? `${view.q ? 'Searching downloaded counts only' : 'Showing downloaded counts only'} · ${rows.length} ${
        rows.length === 1 ? NOUN.one : NOUN.other
      }`
    : page
      ? formatListFooter({ ...page, itemCount: page.items.length }, NOUN)
      : '';

  const header = (
    <View>
      {offline ? (
        <View style={[styles.offlineBanner, { backgroundColor: c.paper2 }]}>
          <WifiOff size={14} color={c.ink3} strokeWidth={1.5} />
          <Mono size={11.5} tracking={0.04} color={c.ink3} style={{ flexShrink: 1 }}>
            Offline · searching downloaded counts only
          </Mono>
        </View>
      ) : null}

      {/* Dynamic Type: three tiles across a 402pt screen leave each one ~90pt
          of interior, which a 9pt tracked uppercase label outgrows on the
          first accessibility size — "ACTIVE" broke to "ACTIV/E" and the
          value's unit ("lists", "to sync") ran off the card entirely. Past
          the threshold the strip becomes one column and every tile reflows
          instead of clipping. TODAY and ACTIVE are server totals for
          everything you can see (a dash when offline or unread), never a
          count of the rows on this page. */}
      <View style={[styles.summaryGrid, stackedSummary && styles.summaryGridStacked]}>
        <SummaryTile label="TODAY" value={todayText} sub="started" stacked={stackedSummary} />
        <SummaryTile label="ACTIVE" value={inProgressText} sub="in progress" stacked={stackedSummary} />
        <SummaryTile
          label="PENDING"
          value={String(pendingTotal)}
          sub="to sync"
          kind="warn"
          stacked={stackedSummary}
        />
      </View>

      <View style={styles.searchWrap}>
        <View style={[styles.searchBox, { backgroundColor: c.card, borderColor: c.hair }]}>
          <Search size={16} color={c.ink4} strokeWidth={1.4} />
          <TextInput
            value={draftQ}
            onChangeText={setDraftQ}
            onSubmitEditing={searchNow}
            placeholder="Search count #, warehouse, or notes…"
            placeholderTextColor={c.ink4}
            accessibilityLabel="Search cycle counts"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            maxLength={CYCLE_COUNT_SEARCH_MAX_LENGTH}
            style={[styles.searchInput, { color: c.ink, fontFamily: FONT.displayRegular }]}
          />
          {busy && !refreshing ? <ActivityIndicator size="small" color={c.ink4} /> : null}
          {draftQ ? (
            <Pressable
              onPress={clearSearch}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, padding: 4 })}
            >
              <X size={16} color={c.ink3} strokeWidth={1.6} />
            </Pressable>
          ) : null}
        </View>
        <View style={styles.chips}>
          {[null, ...CYCLE_COUNT_STATUSES].map((s) => (
            <Chip
              key={s ?? 'all'}
              label={s ? CYCLE_COUNT_STATUS_LABELS[s] : 'All'}
              active={view.status === s}
              onPress={() => setStatus(s)}
            />
          ))}
        </View>
        {error ? (
          <Card padding={16} style={{ gap: 10 }}>
            <Body>Cycle counts did not load.</Body>
            <Body size={12.5} muted>
              {error}
            </Body>
            {offline ? null : (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onPress={() => void load(view, { withSummary: !summary })}
              >
                {busy ? 'Trying again…' : 'Try again'}
              </Button>
            )}
          </Card>
        ) : null}
      </View>
    </View>
  );

  const empty = error ? (
    <View style={{ paddingVertical: 12 }}>
      <Body muted>No counts are downloaded to this device{view.q || view.status ? ' that match' : ''}.</Body>
    </View>
  ) : searching ? (
    <View style={styles.empty}>
      <Display size={18}>No counts <Em>match.</Em></Display>
      <Body muted style={{ marginTop: 6, textAlign: 'center' }}>
        {offline
          ? 'Nothing downloaded to this device matches. Older counts are searchable when you are back online.'
          : 'No counts match your search.'}
      </Body>
      <View style={{ marginTop: 12 }}>
        <Button
          size="sm"
          variant="outline"
          onPress={() => {
            clearSearch();
            setStatus(null);
          }}
        >
          Clear search and filters
        </Button>
      </View>
    </View>
  ) : (
    <View style={styles.empty}>
      <Display size={18}>
        {offline ? 'No counts ' : 'No cycle counts '}
        <Em>{offline ? 'downloaded.' : 'yet.'}</Em>
      </Display>
      <Body muted style={{ marginTop: 6, textAlign: 'center' }}>
        {offline
          ? 'Open counts download when you are online. Connect to see your full history.'
          : canStartCount
            ? 'Tap ＋ to start a count — pick items or books, tap Select, then Review. Or start one from the web.'
            : 'Counts started from the web appear here for review.'}
      </Body>
    </View>
  );

  const footer =
    rows.length > 0 || (page && !error && !showingDownloaded) ? (
      <View style={styles.footer}>
        <Mono
          size={11}
          tracking={0.04}
          color={c.ink4}
          maxFontSizeMultiplier={capTo(11, TYPE_CEILING.chrome)}
          accessibilityLiveRegion="polite"
        >
          {footerText}
        </Mono>
        {!showingDownloaded && page && page.totalPages > 1 ? (
          <View style={styles.pager}>
            <PagerButton
              direction="prev"
              disabled={!page.hasPrevious || busy}
              onPress={() => setView((v) => ({ ...v, page: Math.max(1, page.page - 1) }))}
            />
            <PagerButton
              direction="next"
              disabled={!page.hasNext || busy}
              onPress={() => setView((v) => ({ ...v, page: page.page + 1 }))}
            />
          </View>
        ) : null}
      </View>
    ) : null;

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
          {canStartCount ? (
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
          ) : null}
        </View>
        <View style={styles.head}>
          <Eyebrow>
            {offline
              ? `OFFLINE · ${(downloaded ?? []).length} DOWNLOADED`
              : `${inProgressText} IN PROGRESS`}
          </Eyebrow>
          <Display size={34} style={{ marginTop: 12 }}>
            Cycle <Em>counts.</Em>
          </Display>
        </View>
      </SafeAreaView>

      {/* Nothing to show yet: a spinner, never an empty-history claim. */}
      {!page && !downloaded && !error ? (
        <ActivityIndicator color={c.ink} style={{ marginTop: 32 }} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={header}
          ListHeaderComponentStyle={{ marginHorizontal: -20 }}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: tabBarHeight + 24, gap: 10 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.ink} />}
          ListEmptyComponent={empty}
          ListFooterComponent={footer}
          renderItem={({ item }) => (
            <CountCard
              row={item}
              pending={pendingByCount.get(item.id) ?? 0}
              timeZone={tz}
              onPress={() => router.push(`/cycle-count/${item.id}`)}
            />
          )}
        />
      )}
    </View>
  );
}

/** 9pt tracked uppercase micro-marker against the chrome ceiling. */
const TILE_LABEL_CAP = capTo(9, TYPE_CEILING.chrome);

function SummaryTile({
  label,
  value,
  sub,
  kind = 'ink',
  stacked = false,
}: {
  label: string;
  value: string;
  sub: string;
  kind?: 'ink' | 'mint' | 'warn';
  stacked?: boolean;
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
    // `flex: 1` means "share this ROW's width". Once the strip stacks it would
    // instead be dividing an auto-height column, so it is dropped.
    <Card padding={12} style={{ flex: stacked ? undefined : 1, gap: 6 }}>
      <Mono size={9} tracking={0.18} upper color={c.ink4} maxFontSizeMultiplier={TILE_LABEL_CAP}>
        {label}
      </Mono>
      {/* The count itself is content and stays uncapped; wrap + shrink are
          what stop its unit from running past the card edge. */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', gap: 3 }}>
        <Mono
          size={22}
          tracking={-0.022}
          color={valueColor}
          style={{ fontFamily: FONT.display }}
        >
          {value}
        </Mono>
        <Mono size={11} color={c.ink4} tracking={0} style={{ flexShrink: 1 }}>
          {sub}
        </Mono>
      </View>
    </Card>
  );
}

function PagerButton({
  direction,
  disabled,
  onPress,
}: {
  direction: 'prev' | 'next';
  disabled: boolean;
  onPress: () => void;
}) {
  const { c } = useTheme();
  const Icon = direction === 'prev' ? ChevronLeft : ChevronRight;
  const label = direction === 'prev' ? 'Previous' : 'Next';
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`${label} page`}
      accessibilityState={{ disabled }}
      hitSlop={6}
      style={({ pressed }) => [
        styles.pagerButton,
        { borderColor: c.hair, opacity: disabled ? 0.35 : pressed ? 0.7 : 1 },
      ]}
    >
      {direction === 'prev' ? <Icon size={16} color={c.ink} strokeWidth={1.6} /> : null}
      <Mono size={13} color={c.ink} maxFontSizeMultiplier={capTo(13, TYPE_CEILING.chrome)}>
        {label}
      </Mono>
      {direction === 'next' ? <Icon size={16} color={c.ink} strokeWidth={1.6} /> : null}
    </Pressable>
  );
}

function formatStarted(iso: string, timeZone: string | undefined): string {
  if (!iso) return '';
  if (timeZone) return formatOrgDateTime(iso, { dateStyle: 'medium', timeStyle: 'short' }, timeZone);
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function CountCard({
  row,
  pending,
  timeZone,
  onPress,
}: {
  row: ListRow;
  pending: number;
  timeZone: string | undefined;
  onPress: () => void;
}) {
  const { c } = useTheme();
  const reference = formatCycleCountNumber(row.countNumber);
  const progress = row.lineTotal > 0 ? Math.round((row.lineCounted / row.lineTotal) * 100) : 0;
  const isCompleted = row.status === 'completed';
  const isCanceled = row.status === 'canceled';
  const syncStatus = row.source === 'downloaded' ? 'OFFLINE' : pending > 0 ? 'PENDING' : 'SYNCED';
  const statusPill = isCompleted ? (
    <Pill status="ok">POSTED</Pill>
  ) : isCanceled ? (
    <Pill>CANCELED</Pill>
  ) : pending > 0 ? (
    <Pill status="warn">PENDING</Pill>
  ) : syncStatus === 'OFFLINE' ? (
    <Pill>OFFLINE</Pill>
  ) : (
    <Pill status="ok">SYNCED</Pill>
  );
  const progressLabel = isCompleted
    ? row.completedAt
      ? `Posted · ${formatStarted(row.completedAt, timeZone)}`
      : 'Posted'
    : isCanceled
      ? 'Canceled'
      : progress === 100
        ? 'Ready to post · not finished'
        : `${progress}% counted`;
  const barKind: 'ok' | 'warn' = isCanceled ? 'warn' : isCompleted ? 'ok' : progress === 100 ? 'warn' : 'ok';
  const statusWord = isCompleted ? 'Posted' : isCanceled ? 'Canceled' : 'In progress';
  const started = formatStarted(row.startedAt, timeZone);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${reference ? `Cycle count ${reference}` : 'Cycle count, reference unavailable'}, ${row.scopeLabel}, ${statusWord}${started ? `, started ${started}` : ''}`}
      accessibilityHint="Opens the count"
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <Card padding={16}>
        <View style={countStyles.headerRow}>
          <View style={{ flex: 1 }}>
            {reference ? (
              <Mono size={15.5} tracking={0.01} color={c.ink} style={{ fontFamily: FONT.display }}>
                {reference}
              </Mono>
            ) : (
              <Mono size={12} tracking={0.02} color={c.ink4}>
                {CYCLE_COUNT_REFERENCE_UNAVAILABLE}
              </Mono>
            )}
            <Mono size={11.5} tracking={0.02} color={c.ink2} style={{ marginTop: 4 }}>
              {row.scopeLabel}
            </Mono>
            <Mono size={10.5} tracking={0.04} color={c.ink4} style={{ marginTop: 4 }}>
              {[row.who, started].filter(Boolean).join(' · ')}
            </Mono>
            {row.notes?.trim() ? (
              <Body size={12} muted numberOfLines={1} style={{ marginTop: 4 }}>
                {row.notes}
              </Body>
            ) : null}
          </View>
          {statusPill}
        </View>
        {row.source === 'server' ? (
          <View style={countStyles.progressRow}>
            <Mono size={22} tracking={-0.022} color={c.ink} style={{ fontFamily: FONT.display }}>
              {row.lineCounted}
              <Mono size={13} color={c.ink4} style={{ fontFamily: FONT.displayRegular }}>
                {' / '}
                {row.lineTotal}
              </Mono>
            </Mono>
            <View style={{ flex: 1, gap: 6 }}>
              <StockBar value={progress} max={100} kind={barKind} height={4} />
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
  summaryGridStacked: {
    flexDirection: 'column',
  },
  searchWrap: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 6,
    gap: 10,
  },
  searchBox: {
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 4,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    fontSize: 14.5,
    minHeight: 36,
    letterSpacing: -0.17,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  footer: {
    paddingTop: 12,
    paddingBottom: 8,
    gap: 12,
    alignItems: 'center',
  },
  pager: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 10,
  },
  pagerButton: {
    minHeight: 44,
    minWidth: 112,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
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
