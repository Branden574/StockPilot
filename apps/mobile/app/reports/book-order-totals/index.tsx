import { useNetworkState } from 'expo-network';
import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  RefreshCw,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  BOOK_REPORT_AS_SAVED,
  BOOK_REPORT_EMPTY,
  BOOK_REPORT_EMPTY_DEFAULT_STATUS,
  BOOK_REPORT_EMPTY_SEARCH,
  BOOK_REPORT_EXPORT_ANDROID,
  BOOK_REPORT_FILTERS_RESET,
  BOOK_REPORT_HOW_COUNTED,
  BOOK_REPORT_LOAD_ERROR,
  BOOK_REPORT_METRICS,
  BOOK_REPORT_OPEN_ON_WEB,
  BOOK_REPORT_OPTIONS_ERROR,
  BOOK_REPORT_PAGE_SIZE,
  BOOK_REPORT_RESTRICTED,
  BOOK_REPORT_SEARCH_MAX,
  BOOK_REPORT_TITLE,
  BOOK_REPORT_VIEW_ORDERS,
  DEFAULT_BOOK_REPORT_QUERY,
  DEFAULT_BOOK_REPORT_STATUS_GROUPS,
  bookCoverAlt,
  bookReportCategoryLine,
  bookReportGeneratedLine,
  bookReportGrandTotalLine,
  bookReportRangeLine,
  bookReportRowBadges,
  bookReportSearchLine,
  bookReportStatusLabels,
  bookReportStatusLine,
  bookReportWarehouseLine,
  bookReportZoneLine,
  formatListFooter,
  latestOrderText,
  ordersCountText,
  rowQuantityText,
  totalPagesFor,
  unresolvedUnitsNote,
  type BookOrderOptionsResponse,
  type BookOrderTotalsResponse,
  type BookReportQuery,
  type BookReportRow,
  type OrderStatusKey,
} from '@stockpilot/core';

import { BookCover } from '@/components/book-cover';
import { BookOrderExportSheet } from '@/components/book-order-export-sheet';
import { BookOrderFiltersSheet } from '@/components/book-order-filters-sheet';
import { PhotoViewer } from '@/components/photo-viewer';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Paginator } from '@/components/ui/paginator';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Eyebrow, Mono } from '@/components/ui/text';
import { accountEpoch } from '@/lib/account-epoch';
import { API_BASE } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import {
  bookReportAnswerKey,
  bookReportExportPath,
  bookReportFailure,
  bookReportView,
  bookReportCoversKnown,
  describeBookReportError,
  getBookOrderTotals,
  getBookReportCovers,
  isCurrentBookReportAnswer,
  loadBookReportOptions,
  peekBookReportOptions,
  recallBookReportCover,
  rememberBookReport,
  rememberBookReportCovers,
  type StoredBookReport,
} from '@/lib/book-order-totals-api';
import {
  BOOK_ENTRY_NOUN,
  bookCoverCacheKey,
  bookReportCategoryChip,
  bookReportDateChip,
  bookReportDrillDownHref,
  bookReportExportMode,
  bookReportIdentifiersLine,
  bookReportPlaceLine,
  bookReportQueryFromParams,
  bookReportRowAccessibilityLabel,
  bookReportSortChip,
  bookReportStatusChip,
  bookReportUnreadableFilter,
  bookReportWarehouseChip,
  bookReportWebUrl,
  bookReportWithoutUnreadableFilter,
  copiesMetric,
  isRole,
  resolveBookReportRequest,
  type BookReportExportChoice,
  type BookReportExportChoiceId,
} from '@/lib/book-order-totals-view';
import { showWriteCtaForRole } from '@/lib/cta-gating';
import { createDebouncedScheduler } from '@/lib/debounced-list-load';
import { shouldStackRow } from '@/lib/dynamic-type-layout';
import { isOfflineState } from '@/lib/exceptions-api';
import { exportAndShareReport } from '@/lib/report-export-download';
import { FONT, TYPE_CEILING, capTo } from '@/lib/theme';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { useTheme } from '@/lib/use-theme';
import { retryWorkspace, useWorkspace } from '@/lib/use-workspace';

/**
 * BOOK ORDER TOTALS on the phone (plan 9.2): the native twin of
 * /dashboard/reports/book-order-totals, opened from the shared Reports
 * screen (drawer and the optional Reports tab alike).
 *
 * Every figure is the API's (GET /api/v1/reports/book-order-totals, the same
 * service and SQL as the web): the summary is for the WHOLE filtered result,
 * never this page; the phone adds nothing up. 25 books a page, Previous and
 * Next with the result count and the grand total. Covers load after the
 * numbers and never block or change them.
 *
 * The warehouse follows the drawer header's warehouse view (labelled "your
 * warehouse view") until one is picked in the filters; each request carries
 * the concrete warehouse, and a row's orders and the exported file use the
 * query of the answer on screen, so all three agree.
 *
 * Offline, only an answer for exactly these filters and page is shown, with
 * its time; otherwise the report says it needs a connection. A workspace
 * switch resets the filters and drops any answer still on its way.
 */

type ListData = { answer: BookOrderTotalsResponse; query: BookReportQuery };

const SEARCH_DEBOUNCE_MS = 250;
const MIN_TAP = 44;

function defaultQuery(): BookReportQuery {
  return { ...DEFAULT_BOOK_REPORT_QUERY, statusGroups: [...DEFAULT_BOOK_REPORT_STATUS_GROUPS] };
}

export default function BookOrderTotalsScreen() {
  const router = useRouter();
  const params = useLocalSearchParams() as Record<string, string | string[] | undefined>;
  const { c } = useTheme();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const ws = useWorkspace();
  const orgId = ws.activeOrgId;
  const perms = useEffectivePermissions();
  const role = isRole(ws.activeRole) ? ws.activeRole : null;
  const canExport = showWriteCtaForRole(role, perms, 'reports:export');
  const exportMode = bookReportExportMode(Platform.OS);
  const offline = isOfflineState(useNetworkState());
  const stacked = shouldStackRow(useWindowDimensions().fontScale);

  const [initial] = React.useState(() => bookReportQueryFromParams(params));
  const [query, setQuery] = React.useState<BookReportQuery>(initial.query);
  const [linkWasReset, setLinkWasReset] = React.useState(initial.invalid.length > 0);
  const [draftQ, setDraftQ] = React.useState(initial.query.q);
  const [stored, setStored] = React.useState<StoredBookReport<ListData> | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [exportOpen, setExportOpen] = React.useState(false);
  const [exporting, setExporting] = React.useState<BookReportExportChoiceId | null>(null);
  const [exportError, setExportError] = React.useState<string | null>(null);
  const [howOpen, setHowOpen] = React.useState(false);
  const [viewer, setViewer] = React.useState<{ uri: string; title: string } | null>(null);
  // Covers that arrived while this screen is open (state, so a row re-renders
  // with its picture); the session memo fills in the rest, offline included.
  const [covers, setCovers] = React.useState<{
    orgId: string | null;
    urls: Record<string, string>;
    /** Books whose cover could not be loaded (never "No cover"). */
    failed: Record<string, true>;
  }>({
    orgId: null,
    urls: {},
    failed: {},
  });
  const [options, setOptions] = React.useState<{ orgId: string; data: BookOrderOptionsResponse } | null>(
    () => {
      const known = peekBookReportOptions(userId, orgId);
      return known && orgId ? { orgId, data: known } : null;
    },
  );
  const [optionsFailedFor, setOptionsFailedFor] = React.useState<string | null>(null);
  const [optionsAttempt, setOptionsAttempt] = React.useState(0);

  // A workspace (or account) switch starts that workspace's own report: the
  // filters reset and what is on screen goes. The first workspace to arrive
  // after a cold start is not a switch, so a link's filters survive it.
  const [shownFor, setShownFor] = React.useState({ orgId, userId });
  if (shownFor.orgId !== orgId || shownFor.userId !== userId) {
    const switched =
      (shownFor.orgId !== null && shownFor.orgId !== orgId) ||
      (shownFor.userId !== null && shownFor.userId !== userId);
    setShownFor({ orgId, userId });
    if (switched) {
      setQuery(defaultQuery());
      setDraftQ('');
      setStored(null);
      setLinkWasReset(false);
      setFiltersOpen(false);
      setExportOpen(false);
      setExportError(null);
      setViewer(null);
    }
  }

  // The query a request is built from: always a concrete warehouse. The
  // warehouse view matters only while it is followed; after an explicit
  // choice a change of view neither moves nor reloads the report.
  const viewWarehouse = query.warehouse === 'default' ? ws.activeWarehouseId : null;
  const request = React.useMemo(
    () => resolveBookReportRequest(query, viewWarehouse),
    [query, viewWarehouse],
  );
  const key = bookReportAnswerKey(userId, orgId, request);
  const view = bookReportView(stored, key, offline);
  const data = view.kind === 'ready' ? view.data : null;

  const seq = React.useRef(0);
  const inFlight = React.useRef<AbortController | null>(null);
  const listRef = React.useRef<FlatList<BookReportRow>>(null);
  const orgRef = React.useRef(orgId);
  React.useLayoutEffect(() => {
    orgRef.current = orgId;
  });
  // The key an answer was stored under after the server served another page
  // (a filter shrank the result): its query change must not load it again.
  const reconciled = React.useRef<string | null>(null);

  const load = React.useCallback(
    async (target: BookReportQuery, targetKey: string, forOrg: string, forUser: string) => {
      const token = ++seq.current;
      inFlight.current?.abort();
      const ctrl = new AbortController();
      inFlight.current = ctrl;
      const epoch = accountEpoch();
      try {
        const answer = await getBookOrderTotals(forOrg, target, ctrl.signal);
        if (
          !isCurrentBookReportAnswer(answer, {
            isNewestRequest: token === seq.current,
            activeOrgId: orgRef.current,
            epochAtRequest: epoch,
          })
        ) {
          return;
        }
        const served = answer.page === target.page ? target : { ...target, page: answer.page };
        const servedKey = bookReportAnswerKey(forUser, forOrg, served) ?? targetKey;
        const next: ListData = { answer, query: served };
        rememberBookReport(servedKey, next);
        setStored({ key: servedKey, kind: 'ready', data: next, banner: null });
        if (served.page !== target.page) {
          reconciled.current = servedKey;
          setQuery((q) => ({ ...q, page: answer.page }));
        }
      } catch (e) {
        if (ctrl.signal.aborted || token !== seq.current || epoch !== accountEpoch()) return;
        // A warehouse or category this reader cannot see (a link's, or the
        // view's): drop it, say the link's filters were reset, and read
        // again, as the web page does. Nothing left to drop: the refusal.
        const unreadable = bookReportUnreadableFilter(e);
        if (unreadable && bookReportWithoutUnreadableFilter(target, unreadable)) {
          setLinkWasReset(true);
          setQuery((q) => bookReportWithoutUnreadableFilter(q, unreadable) ?? q);
          return;
        }
        setStored((prev) => bookReportFailure(prev, targetKey, e, 'report'));
      }
    },
    [],
  );

  // Every change of filters, page, warehouse view, workspace or connection
  // asks for exactly that answer.
  React.useEffect(() => {
    if (offline || !key || !orgId || !userId) return;
    if (reconciled.current === key) {
      reconciled.current = null;
      return;
    }
    void load(request, key, orgId, userId);
  }, [offline, key, orgId, userId, request, load]);

  // Leaving the screen, or the workspace, drops the request still out.
  React.useEffect(() => {
    const pending = inFlight;
    return () => pending.current?.abort();
  }, [orgId]);

  // Typing settles, then searches from page 1.
  const debounce = React.useRef(createDebouncedScheduler(SEARCH_DEBOUNCE_MS));
  React.useEffect(() => {
    const next = draftQ.trim().slice(0, BOOK_REPORT_SEARCH_MAX);
    const scheduler = debounce.current;
    if (next === query.q) {
      scheduler.cancel();
      return;
    }
    scheduler.schedule(() => setQuery((q) => (q.q === next ? q : { ...q, q: next, page: 1 })));
  }, [draftQ, query.q]);
  React.useEffect(() => {
    const scheduler = debounce.current;
    return () => scheduler.cancel();
  }, []);

  // The warehouse and category lists and the status labels: once per
  // session, never awaited with the numbers.
  React.useEffect(() => {
    if (!orgId || !userId || offline) return;
    if (options?.orgId === orgId) return;
    let live = true;
    loadBookReportOptions({ userId, orgId }).then(
      (answer) => {
        if (!live || orgRef.current !== orgId) return;
        setOptions({ orgId, data: answer });
        setOptionsFailedFor(null);
      },
      () => {
        if (live && orgRef.current === orgId) setOptionsFailedFor(orgId);
      },
    );
    return () => {
      live = false;
    };
  }, [orgId, userId, offline, options, optionsAttempt]);
  const optionsForOrg = options?.orgId === orgId ? options.data : null;
  const optionsFailed = optionsFailedFor !== null && optionsFailedFor === orgId && !optionsForOrg;
  const statusLabels = optionsForOrg?.statusLabels ?? bookReportStatusLabels(null);

  // Covers for the page on screen, after the numbers. A failure leaves the
  // placeholders; it never blocks or changes a figure.
  const rows = data?.answer.rows ?? [];
  const coverIds = rows.map((r) => r.itemId).join(',');
  React.useEffect(() => {
    if (!orgId || offline || !coverIds) return;
    const ids = coverIds.split(',');
    if (bookReportCoversKnown(orgId, ids)) return;
    const ctrl = new AbortController();
    const epoch = accountEpoch();
    const markFailed = (failedIds: readonly string[]) => (prev: typeof covers) => {
      const failed: Record<string, true> = { ...(prev.orgId === orgId ? prev.failed : {}) };
      for (const id of failedIds) failed[id.toLowerCase()] = true;
      return failed;
    };
    getBookReportCovers(orgId, ids, ctrl.signal).then(
      ({ urls, unresolved }) => {
        if (ctrl.signal.aborted || epoch !== accountEpoch() || orgRef.current !== orgId) return;
        rememberBookReportCovers(orgId, urls, ids, unresolved);
        setCovers((prev) => ({
          orgId,
          urls: { ...(prev.orgId === orgId ? prev.urls : {}), ...urls },
          failed: markFailed(unresolved)(prev),
        }));
      },
      () => {
        // The lookup itself failed: every cover on the page could not be
        // loaded (never "No cover"). Nothing is remembered, so a later visit
        // asks again.
        if (ctrl.signal.aborted || epoch !== accountEpoch() || orgRef.current !== orgId) return;
        setCovers((prev) => ({
          orgId,
          urls: prev.orgId === orgId ? prev.urls : {},
          failed: markFailed(ids)(prev),
        }));
      },
    );
    return () => ctrl.abort();
  }, [orgId, offline, coverIds]);

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace('/reports' as Href);
  }

  async function refresh() {
    if (offline || !key || !orgId || !userId) return;
    setRefreshing(true);
    try {
      await load(request, key, orgId, userId);
    } finally {
      setRefreshing(false);
    }
  }

  function applyFilters(next: BookReportQuery) {
    setFiltersOpen(false);
    setLinkWasReset(false);
    setDraftQ(next.q);
    setQuery(next);
  }

  function searchNow() {
    debounce.current.cancel();
    Keyboard.dismiss();
    const next = draftQ.trim().slice(0, BOOK_REPORT_SEARCH_MAX);
    setQuery((q) => (q.q === next ? q : { ...q, q: next, page: 1 }));
  }

  function clearSearch() {
    debounce.current.cancel();
    setDraftQ('');
    setQuery((q) => (q.q === '' ? q : { ...q, q: '', page: 1 }));
  }

  async function runExport(choice: BookReportExportChoice, source: ListData) {
    if (!orgId) return;
    setExporting(choice.id);
    setExportError(null);
    try {
      // The query of the answer ON SCREEN: the file matches what was read.
      await exportAndShareReport({
        orgId,
        path: bookReportExportPath(choice.format, choice.photos, source.query),
        format: choice.format,
        fallbackName: 'book-order-totals',
        title: BOOK_REPORT_TITLE,
      });
      setExportOpen(false);
    } catch (e) {
      setExportError(describeBookReportError(e, 'export').detail);
    } finally {
      setExporting(null);
    }
  }

  if (!orgId && !ws.loading) {
    return (
      <View style={[styles.root, { backgroundColor: c.paper }]}>
        <TopBar onBack={goBack} />
        <View style={styles.pad}>
          <Card padding={16}>
            <Body size={14.5} accessibilityRole="alert">
              Your workspace could not be loaded, so this report cannot be shown. Check your
              connection and try again.
            </Body>
            <Button
              size="sm"
              variant="outline"
              onPress={() => void retryWorkspace()}
              style={{ alignSelf: 'flex-start', marginTop: 12, minHeight: MIN_TAP }}
            >
              Try again
            </Button>
          </Card>
        </View>
      </View>
    );
  }

  const answer = data?.answer ?? null;
  const pageSize = answer?.pageSize ?? BOOK_REPORT_PAGE_SIZE;
  const totalPages = answer ? totalPagesFor(answer.totalCount, pageSize) : 1;
  const warehouseChip = bookReportWarehouseChip({
    query,
    activeWarehouseId: ws.activeWarehouseId,
    activeWarehouseName: ws.activeWarehouseName,
    warehouses: optionsForOrg?.warehouses ?? [],
    echoName: answer?.filters.warehouse?.name ?? null,
  });
  const categoryChip = bookReportCategoryChip(
    query,
    optionsForOrg?.categories ?? [],
    answer?.filters.category?.name ?? null,
  );

  const header = (
    <View style={{ gap: 14 }}>
      {linkWasReset ? (
        <Card padding={12}>
          <Body size={13.5} accessibilityRole="alert">
            {BOOK_REPORT_FILTERS_RESET}
          </Body>
        </Card>
      ) : null}

      <View style={[styles.searchBox, { backgroundColor: c.card, borderColor: c.hair }]}>
        <Search size={16} color={c.ink4} strokeWidth={1.4} />
        <TextInput
          value={draftQ}
          onChangeText={setDraftQ}
          onSubmitEditing={searchNow}
          placeholder="Title, SKU or ISBN"
          placeholderTextColor={c.ink4}
          accessibilityLabel="Search books"
          accessibilityHint="Searches title, SKU and ISBN across the whole report"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          maxLength={BOOK_REPORT_SEARCH_MAX}
          maxFontSizeMultiplier={capTo(14.5, TYPE_CEILING.input)}
          style={[styles.searchInput, { color: c.ink, fontFamily: FONT.displayRegular }]}
        />
        {draftQ ? (
          <Pressable
            onPress={clearSearch}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            style={({ pressed }) => [styles.clear, { opacity: pressed ? 0.5 : 1 }]}
          >
            <X size={16} color={c.ink3} strokeWidth={1.6} />
          </Pressable>
        ) : null}
      </View>

      <View style={styles.chips}>
        {[
          bookReportDateChip(query),
          bookReportStatusChip(query.statusGroups),
          warehouseChip,
          categoryChip,
          bookReportSortChip(query),
        ].map((label) => (
          <FilterChip key={label} label={label} onPress={() => setFiltersOpen(true)} />
        ))}
      </View>
      {optionsFailed ? (
        <View style={{ gap: 8 }}>
          <Body size={13} muted accessibilityRole="alert">
            {BOOK_REPORT_OPTIONS_ERROR.replace(/\s*Retry$/, '')}
          </Body>
          <Button
            size="sm"
            variant="outline"
            onPress={() => {
              setOptionsFailedFor(null);
              setOptionsAttempt((n) => n + 1);
            }}
            style={{ alignSelf: 'flex-start', minHeight: MIN_TAP }}
          >
            Retry
          </Button>
        </View>
      ) : null}

      {view.kind === 'ready' && view.banner ? (
        <Card padding={12}>
          <Body size={13.5} accessibilityRole="alert">
            {view.banner}
          </Body>
        </Card>
      ) : null}

      {data && answer ? (
        <Summary
          data={data}
          stacked={stacked}
          statusLabels={statusLabels}
          howOpen={howOpen}
          onToggleHow={() => setHowOpen((v) => !v)}
        />
      ) : null}
    </View>
  );

  const empty =
    view.kind === 'loading' ? (
      <ActivityIndicator
        color={c.ink}
        style={{ marginTop: 32 }}
        accessibilityLabel="Loading Book Order Totals"
      />
    ) : view.kind === 'error' ? (
      <Card padding={16}>
        {view.offline ? (
          <Body size={15} accessibilityRole="alert" style={{ fontFamily: FONT.display }}>
            {view.error.detail}
          </Body>
        ) : (
          <>
            <Body size={15} accessibilityRole="alert" style={{ fontFamily: FONT.display }}>
              {BOOK_REPORT_LOAD_ERROR}
            </Body>
            <Body size={13.5} muted style={{ marginTop: 6 }}>
              {view.error.detail}
            </Body>
          </>
        )}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
          {view.error.retry && !view.offline ? (
            <Button
              size="sm"
              variant="outline"
              disabled={refreshing}
              onPress={() => void refresh()}
              style={{ minHeight: MIN_TAP }}
            >
              Try again
            </Button>
          ) : null}
          {query.page > 1 ? (
            <Button
              size="sm"
              variant="outline"
              onPress={() => setQuery((q) => ({ ...q, page: 1 }))}
              style={{ minHeight: MIN_TAP }}
            >
              First page
            </Button>
          ) : null}
        </View>
      </Card>
    ) : answer && answer.totalCount === 0 ? (
      <Card padding={16}>
        <Body size={15} style={{ fontFamily: FONT.display }}>
          {BOOK_REPORT_EMPTY}
        </Body>
        {data && sameGroups(data.query.statusGroups) ? (
          <Body size={13.5} muted style={{ marginTop: 6 }}>
            {BOOK_REPORT_EMPTY_DEFAULT_STATUS}
          </Body>
        ) : null}
        {answer.scope.restricted ? (
          <Body size={13.5} muted style={{ marginTop: 6 }}>
            {BOOK_REPORT_RESTRICTED}
          </Body>
        ) : null}
        {data?.query.q ? (
          <Body size={13.5} muted style={{ marginTop: 6 }}>
            {BOOK_REPORT_EMPTY_SEARCH}
          </Body>
        ) : null}
      </Card>
    ) : null;

  const footer =
    data && answer && answer.totalCount > 0 ? (
      <View style={styles.footer}>
        <Mono
          size={11.5}
          tracking={0.02}
          color={c.ink3}
          maxFontSizeMultiplier={capTo(11.5, TYPE_CEILING.chrome)}
          accessibilityLiveRegion="polite"
          style={{ textAlign: 'center' }}
        >
          {formatListFooter(
            {
              page: answer.page,
              pageSize,
              total: answer.totalCount,
              totalPages,
              itemCount: answer.rows.length,
            },
            BOOK_ENTRY_NOUN,
          )}
        </Mono>
        <Body size={14} style={{ textAlign: 'center', fontFamily: FONT.display }}>
          {bookReportGrandTotalLine(answer.summary, totalPages)}
        </Body>
        <Paginator
          page={answer.page}
          pageCount={totalPages}
          rangeStart={(answer.page - 1) * pageSize + 1}
          rangeEnd={(answer.page - 1) * pageSize + answer.rows.length}
          total={answer.totalCount}
          onPageChange={(p) => {
            // A new page starts at the top, as a new web page does.
            listRef.current?.scrollToOffset({ offset: 0, animated: false });
            setQuery((q) => ({ ...q, page: p }));
          }}
          hideRange
        />
        {canExport && exportMode === 'web_only' ? (
          <Card padding={14} style={{ alignSelf: 'stretch' }}>
            <Body size={13.5}>{BOOK_REPORT_EXPORT_ANDROID}</Body>
            <Button
              size="sm"
              variant="outline"
              onPress={() =>
                void Linking.openURL(bookReportWebUrl(API_BASE, data.query)).catch(() => undefined)
              }
              style={{ alignSelf: 'flex-start', marginTop: 10, minHeight: MIN_TAP }}
            >
              {BOOK_REPORT_OPEN_ON_WEB}
            </Button>
          </Card>
        ) : null}
      </View>
    ) : null;

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <TopBar
        onBack={goBack}
        onRefresh={offline ? undefined : () => void refresh()}
        onExport={
          canExport && exportMode === 'share' && data
            ? () => {
                setExportError(null);
                setExportOpen(true);
              }
            : undefined
        }
      />
      <View style={styles.head}>
        <Eyebrow>REPORTS</Eyebrow>
        <Display size={30} style={{ marginTop: 10 }} accessibilityRole="header">
          {BOOK_REPORT_TITLE}
        </Display>
      </View>

      <FlatList
        ref={listRef}
        data={view.kind === 'ready' ? rows : []}
        keyExtractor={(r) => r.itemId}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        ListFooterComponent={footer}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            enabled={!offline}
            tintColor={c.ink}
          />
        }
        renderItem={({ item }) => (
          <BookRow
            row={item}
            cover={
              (covers.orgId === orgId ? covers.urls[item.itemId.toLowerCase()] : undefined) ??
              recallBookReportCover(orgId, item.itemId)
            }
            coverFailed={
              covers.orgId === orgId && covers.failed[item.itemId.toLowerCase()] === true
            }
            stacked={stacked}
            onOpen={() => {
              if (data) router.push(bookReportDrillDownHref(item.itemId, data.query) as Href);
            }}
            onViewCover={(uri) => setViewer({ uri, title: item.name })}
          />
        )}
      />

      {filtersOpen ? (
        <BookOrderFiltersSheet
          visible
          onClose={() => setFiltersOpen(false)}
          value={query}
          onApply={applyFilters}
          statusLabels={statusLabels}
          options={optionsForOrg}
          optionsFailed={optionsFailed}
          onRetryOptions={() => {
            setOptionsFailedFor(null);
            setOptionsAttempt((n) => n + 1);
          }}
          activeWarehouseId={ws.activeWarehouseId}
          activeWarehouseName={ws.activeWarehouseName}
          echoWarehouseName={answer?.filters.warehouse?.name ?? null}
          echoCategoryName={answer?.filters.category?.name ?? null}
        />
      ) : null}

      {exportOpen && data ? (
        <BookOrderExportSheet
          visible
          onClose={() => setExportOpen(false)}
          totalCount={data.answer.totalCount}
          offline={offline}
          busy={exporting}
          error={exportError}
          onChoose={(choice) => void runExport(choice, data)}
        />
      ) : null}

      <PhotoViewer
        uri={viewer?.uri ?? ''}
        cacheKey={viewer ? bookCoverCacheKey(viewer.uri) : undefined}
        visible={viewer !== null}
        onClose={() => setViewer(null)}
        label={viewer ? bookCoverAlt(viewer.title) : undefined}
      />
    </View>
  );
}

function sameGroups(groups: readonly string[]): boolean {
  return (
    groups.length === DEFAULT_BOOK_REPORT_STATUS_GROUPS.length &&
    DEFAULT_BOOK_REPORT_STATUS_GROUPS.every((g) => groups.includes(g))
  );
}

function TopBar({
  onBack,
  onRefresh,
  onExport,
}: {
  onBack: () => void;
  onRefresh?: () => void;
  onExport?: () => void;
}) {
  const { c } = useTheme();
  return (
    <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
      <View style={styles.topbar}>
        <IconChip icon={ChevronLeft} onPress={onBack} accessibilityLabel="Back" minTap />
        <View style={{ flexDirection: 'row', gap: 4 }}>
          {onRefresh ? (
            <IconChip icon={RefreshCw} onPress={onRefresh} accessibilityLabel="Refresh" minTap />
          ) : null}
          {onExport ? (
            <IconChip icon={Download} onPress={onExport} accessibilityLabel="Export" minTap />
          ) : null}
        </View>
      </View>
    </SafeAreaView>
  );
}

function FilterChip({ label, onPress }: { label: string; onPress: () => void }) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Opens the filters"
      style={({ pressed }) => [
        styles.chip,
        { borderColor: c.hair, backgroundColor: c.paper2, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <SlidersHorizontal size={13} color={c.ink3} strokeWidth={1.6} />
      <Mono
        size={12.5}
        tracking={0.01}
        color={c.ink}
        maxFontSizeMultiplier={capTo(12.5, TYPE_CEILING.chrome)}
        style={{ flexShrink: 1 }}
      >
        {label}
      </Mono>
    </Pressable>
  );
}

function Summary({
  data,
  stacked,
  statusLabels,
  howOpen,
  onToggleHow,
}: {
  data: ListData;
  stacked: boolean;
  statusLabels: Readonly<Record<OrderStatusKey, string>>;
  howOpen: boolean;
  onToggleHow: () => void;
}) {
  const { c } = useTheme();
  const { answer, query } = data;
  const s = answer.summary;
  const copies = copiesMetric(s.copies);
  const otherUnit = answer.rows.find((r) => !r.countsAsCopies);
  const unresolved = unresolvedUnitsNote(
    s.unresolved,
    s.unresolved.entries === 1 && otherUnit ? otherUnit.unit : undefined,
  );
  const scope = [
    bookReportRangeLine(answer.range, s),
    bookReportZoneLine(answer.range),
    bookReportStatusLine(query.statusGroups, statusLabels),
    bookReportWarehouseLine(answer.filters.warehouse, answer.warehouse.source),
    bookReportCategoryLine(answer.filters.category, answer.filters.uncategorized),
    bookReportSearchLine(query.q),
    answer.scope.restricted ? BOOK_REPORT_RESTRICTED : null,
    BOOK_REPORT_AS_SAVED,
    bookReportGeneratedLine(answer.generatedAtLocal),
  ].filter((line): line is string => Boolean(line));

  return (
    <View style={{ gap: 10 }}>
      <Metric
        label={BOOK_REPORT_METRICS.copies.label}
        value={copies.value}
        unit={copies.unit}
        definition={BOOK_REPORT_METRICS.copies.definition}
        note={unresolved}
        stacked={stacked}
      />
      <Metric
        label={BOOK_REPORT_METRICS.entries.label}
        value={s.entries.toLocaleString('en-US')}
        unit={s.entries === 1 ? 'book entry' : 'book entries'}
        definition={BOOK_REPORT_METRICS.entries.definition}
        stacked={stacked}
      />
      <Metric
        label={BOOK_REPORT_METRICS.orders.label}
        value={s.orders.toLocaleString('en-US')}
        unit={s.orders === 1 ? 'order' : 'orders'}
        definition={BOOK_REPORT_METRICS.orders.definition}
        stacked={stacked}
      />

      <Card padding={14} style={{ gap: 4 }}>
        {scope.map((line) => (
          <Body key={line} size={13} muted>
            {line}
          </Body>
        ))}
        <Pressable
          onPress={onToggleHow}
          accessibilityRole="button"
          accessibilityState={{ expanded: howOpen }}
          accessibilityLabel="How this is counted"
          style={({ pressed }) => [styles.howToggle, { opacity: pressed ? 0.6 : 1 }]}
        >
          <Mono
            size={12}
            tracking={0.04}
            color={c.ink}
            maxFontSizeMultiplier={capTo(12, TYPE_CEILING.chrome)}
          >
            {howOpen ? 'Hide how this is counted' : 'How this is counted'}
          </Mono>
        </Pressable>
        {howOpen ? (
          <View style={{ gap: 6 }}>
            {BOOK_REPORT_HOW_COUNTED.map((line) => (
              <Body key={line} size={13} muted>
                {`• ${line}`}
              </Body>
            ))}
          </View>
        ) : null}
      </Card>
    </View>
  );
}

function Metric({
  label,
  value,
  unit,
  definition,
  note,
  stacked,
}: {
  label: string;
  value: string;
  unit: string;
  definition: string;
  note?: string | null;
  stacked: boolean;
}) {
  const { c } = useTheme();
  return (
    <Card padding={14}>
      {/* One VoiceOver element: "Total books ordered: 642 copies requested.
          Copies requested through Orders; ..." (no control inside). */}
      <View
        accessible
        accessibilityLabel={`${label}: ${value} ${unit}. ${definition}${note ? ` ${note}` : ''}`}
      >
        <Eyebrow>{label.toUpperCase()}</Eyebrow>
        <View
          style={{
            flexDirection: stacked ? 'column' : 'row',
            alignItems: stacked ? 'flex-start' : 'baseline',
            flexWrap: 'wrap',
            gap: stacked ? 0 : 8,
            marginTop: 8,
          }}
        >
          <Mono size={30} tracking={-0.02} color={c.ink} style={{ fontFamily: FONT.display }}>
            {value}
          </Mono>
          <Mono size={12.5} color={c.ink3}>
            {unit}
          </Mono>
        </View>
        <Body size={13} muted style={{ marginTop: 4 }}>
          {definition}
        </Body>
        {note ? (
          <Body size={13} style={{ marginTop: 4 }}>
            {note}
          </Body>
        ) : null}
      </View>
    </Card>
  );
}

/**
 * One book. The cover and the rest of the row are SIBLING buttons (a
 * touchable inside a touchable is unreachable with VoiceOver): the cover
 * opens it larger, the row opens the orders behind its total.
 */
function BookRow({
  row,
  cover,
  coverFailed,
  stacked,
  onOpen,
  onViewCover,
}: {
  row: BookReportRow;
  cover: string | null;
  coverFailed: boolean;
  stacked: boolean;
  onOpen: () => void;
  onViewCover: (uri: string) => void;
}) {
  const { c } = useTheme();
  const ids = bookReportIdentifiersLine(row);
  const place = bookReportPlaceLine(row);
  const badges = bookReportRowBadges(row);
  const secondary = [ordersCountText(row.orders), latestOrderText(row.latestOrderDate)]
    .filter(Boolean)
    .join(' · ');
  return (
    <Card padding={12}>
      <View
        style={{
          flexDirection: stacked ? 'column' : 'row',
          alignItems: 'flex-start',
          gap: 12,
        }}
      >
        <BookCover
          uri={cover}
          title={row.name}
          failed={coverFailed}
          onPress={cover ? () => onViewCover(cover) : undefined}
        />
        <Pressable
          onPress={onOpen}
          accessibilityRole="button"
          accessibilityLabel={bookReportRowAccessibilityLabel(row)}
          accessibilityHint="Opens the orders behind this total"
          style={({ pressed }) => [
            { flex: stacked ? undefined : 1, minWidth: 0, minHeight: 72, alignSelf: 'stretch' },
            { opacity: pressed ? 0.8 : 1 },
          ]}
        >
          <Body
            size={15.5}
            color={c.ink}
            numberOfLines={stacked ? undefined : 2}
            style={{ fontFamily: FONT.display }}
          >
            {row.name}
          </Body>
          {ids ? (
            <Mono size={11.5} color={c.ink3} style={{ marginTop: 2 }}>
              {ids}
            </Mono>
          ) : null}
          {place ? (
            <Mono size={11.5} color={c.ink4} style={{ marginTop: 2 }}>
              {place}
            </Mono>
          ) : null}
          <Mono size={15} color={c.ink} style={{ marginTop: 8, fontFamily: FONT.display }}>
            {rowQuantityText(row)}
          </Mono>
          {secondary ? (
            <Body size={13} muted>
              {secondary}
            </Body>
          ) : null}
          {badges.length > 0 ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
              {badges.map((b) => (
                <Pill key={b} dot={false}>
                  {b.toUpperCase()}
                </Pill>
              ))}
            </View>
          ) : null}
          <View style={styles.viewOrders}>
            <Mono
              size={12}
              tracking={0.04}
              color={c.ink}
              maxFontSizeMultiplier={capTo(12, TYPE_CEILING.chrome)}
            >
              {BOOK_REPORT_VIEW_ORDERS}
            </Mono>
            <ChevronRight size={14} color={c.ink} strokeWidth={1.6} />
          </View>
        </Pressable>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topbar: {
    paddingHorizontal: 9,
    paddingTop: 5,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  head: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 6 },
  pad: { paddingHorizontal: 20, marginTop: 12 },
  list: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 48, gap: 10 },
  searchBox: {
    minHeight: MIN_TAP,
    paddingHorizontal: 14,
    paddingVertical: 2,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  searchInput: { flex: 1, minWidth: 0, fontSize: 14.5, minHeight: 40 },
  clear: { minWidth: MIN_TAP, minHeight: MIN_TAP, alignItems: 'center', justifyContent: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    minHeight: MIN_TAP,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '100%',
  },
  howToggle: { minHeight: MIN_TAP, justifyContent: 'center', alignSelf: 'flex-start' },
  viewOrders: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  footer: { paddingTop: 14, gap: 10, alignItems: 'center' },
});
