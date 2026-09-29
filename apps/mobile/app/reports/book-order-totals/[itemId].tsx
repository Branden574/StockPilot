import { useNetworkState } from 'expo-network';
import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  BOOK_REPORT_FULFILLED_NOTE,
  BOOK_REPORT_ORDERS_LOAD_ERROR,
  BOOK_REPORT_ORDER_LINK_HINT,
  bookCoverAlt,
  bookReportAsOfNote,
  bookReportDrawerHeader,
  bookReportRangeLine,
  bookReportRowBadges,
  bookReportStatusLabels,
  bookReportStatusLine,
  bookReportWarehouseLine,
  bookReportZoneLine,
  formatListFooter,
  fulfilledReturnedLine,
  isUuid,
  totalPagesFor,
  type BookOrderOrdersResponse,
  type BookReportStatusGroup,
  type OrderStatusKey,
} from '@stockpilot/core';

import { BookCover } from '@/components/book-cover';
import { PhotoViewer } from '@/components/photo-viewer';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Paginator } from '@/components/ui/paginator';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Eyebrow, Mono } from '@/components/ui/text';
import { accountEpoch } from '@/lib/account-epoch';
import { useAuth } from '@/lib/auth-context';
import {
  bookReportCoversKnown,
  bookReportFailure,
  bookReportOrdersKey,
  bookReportView,
  getBookOrderOrders,
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
  ORDER_NOUN,
  bookCoverCacheKey,
  bookReportIdentifiersLine,
  bookReportOrderRowPresentation,
  bookReportPlaceLine,
  bookReportQueryFromListParams,
  resolveBookReportRequest,
} from '@/lib/book-order-totals-view';
import { shouldStackRow } from '@/lib/dynamic-type-layout';
import { isOfflineState } from '@/lib/exceptions-api';
import { FONT, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';
import { useWorkspace } from '@/lib/use-workspace';

/**
 * The orders behind one book's total (plan 9.2): GET
 * /api/v1/reports/book-order-totals/items/[id]/orders with the SAME range,
 * statuses and concrete warehouse the list used (its params are the list's
 * resolved query), 25 orders a page, newest first.
 *
 *   - The header is the book's FULL total over every page ("Copies of this
 *     book requested: 30 in 3 orders"), never this page's.
 *   - Duplicate lines on one order are one row, "(2 lines)".
 *   - An order opens only when the server says `openable` (the caller
 *     approves orders or placed it). Otherwise the number is words, not a
 *     button, with the reason; no requester data is ever shown.
 *   - The list stays mounted underneath, so Back returns to the same
 *     filters and page.
 *   - Offline, only these exact orders (book, filters, page) are shown "as
 *     of" their time; otherwise the report needs a connection.
 */

type OrdersData = { answer: BookOrderOrdersResponse };

export default function BookOrdersScreen() {
  const router = useRouter();
  const params = useLocalSearchParams() as Record<string, string | string[] | undefined>;
  const rawItemId = typeof params.itemId === 'string' ? params.itemId : '';
  const itemId = isUuid(rawItemId) ? rawItemId.toLowerCase() : null;
  const { c } = useTheme();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const ws = useWorkspace();
  const orgId = ws.activeOrgId;
  const offline = isOfflineState(useNetworkState());
  const stacked = shouldStackRow(useWindowDimensions().fontScale);

  // The list's own resolved filters (a concrete warehouse). Read once.
  const [baseQuery] = React.useState(() => bookReportQueryFromListParams(params));
  const viewWarehouse = baseQuery.warehouse === 'default' ? ws.activeWarehouseId : null;
  const request = React.useMemo(
    () => resolveBookReportRequest(baseQuery, viewWarehouse),
    [baseQuery, viewWarehouse],
  );

  // The workspace and account this screen was opened for. A switch while it
  // is open does not re-ask under another workspace: these orders belong to
  // the report underneath.
  const [boundOrg, setBoundOrg] = React.useState<string | null>(orgId);
  const [boundUser, setBoundUser] = React.useState<string | null>(userId);
  if (boundOrg === null && orgId !== null) setBoundOrg(orgId);
  if (boundUser === null && userId !== null) setBoundUser(userId);
  const switched =
    (boundOrg !== null && orgId !== boundOrg) || (boundUser !== null && userId !== boundUser);

  const [page, setPage] = React.useState(1);
  const [stored, setStored] = React.useState<StoredBookReport<OrdersData> | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [viewer, setViewer] = React.useState<string | null>(null);
  const [coverUrl, setCoverUrl] = React.useState<string | null>(null);
  // The cover could not be loaded (a failed lookup), as distinct from none.
  const [coverFailed, setCoverFailed] = React.useState(false);

  const key = switched ? null : bookReportOrdersKey(userId, orgId, itemId, request, page);
  const view = bookReportView(stored, key, offline);

  const seq = React.useRef(0);
  const inFlight = React.useRef<AbortController | null>(null);
  const orgRef = React.useRef(orgId);
  React.useLayoutEffect(() => {
    orgRef.current = orgId;
  });
  const reconciled = React.useRef<string | null>(null);

  const load = React.useCallback(
    async (targetPage: number, targetKey: string, forOrg: string, forUser: string, book: string) => {
      const token = ++seq.current;
      inFlight.current?.abort();
      const ctrl = new AbortController();
      inFlight.current = ctrl;
      const epoch = accountEpoch();
      try {
        const answer = await getBookOrderOrders(forOrg, book, request, targetPage, ctrl.signal);
        if (
          !isCurrentBookReportAnswer(answer, {
            isNewestRequest: token === seq.current,
            activeOrgId: orgRef.current,
            epochAtRequest: epoch,
          })
        ) {
          return;
        }
        const servedKey =
          bookReportOrdersKey(forUser, forOrg, book, request, answer.page) ?? targetKey;
        rememberBookReport(servedKey, { answer });
        setStored({ key: servedKey, kind: 'ready', data: { answer }, banner: null });
        if (answer.page !== targetPage) {
          reconciled.current = servedKey;
          setPage(answer.page);
        }
      } catch (e) {
        if (ctrl.signal.aborted || token !== seq.current || epoch !== accountEpoch()) return;
        setStored((prev) => bookReportFailure(prev, targetKey, e, 'orders'));
      }
    },
    [request],
  );

  React.useEffect(() => {
    if (offline || !key || !orgId || !userId || !itemId) return;
    if (reconciled.current === key) {
      reconciled.current = null;
      return;
    }
    void load(page, key, orgId, userId, itemId);
  }, [offline, key, orgId, userId, itemId, page, load]);

  // Leaving the screen drops the request still out.
  React.useEffect(() => {
    const pending = inFlight;
    return () => pending.current?.abort();
  }, []);

  // The organization's status words (loaded once per session with the list).
  const [labels, setLabels] = React.useState(
    () => peekBookReportOptions(userId, orgId)?.statusLabels ?? null,
  );
  React.useEffect(() => {
    if (labels || !orgId || !userId || offline || switched) return;
    let live = true;
    loadBookReportOptions({ userId, orgId }).then(
      (o) => {
        if (live) setLabels(o.statusLabels);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [labels, orgId, userId, offline, switched]);
  const statusLabels = labels ?? bookReportStatusLabels(null);

  // The cover, after the numbers.
  React.useEffect(() => {
    if (!orgId || !itemId || offline || switched) return;
    if (bookReportCoversKnown(orgId, [itemId])) return;
    const ctrl = new AbortController();
    const epoch = accountEpoch();
    getBookReportCovers(orgId, [itemId], ctrl.signal).then(
      ({ urls, unresolved }) => {
        if (ctrl.signal.aborted || epoch !== accountEpoch() || orgRef.current !== orgId) return;
        rememberBookReportCovers(orgId, urls, [itemId], unresolved);
        const url = urls[itemId.toLowerCase()] ?? null;
        setCoverUrl(url);
        setCoverFailed(url === null && unresolved.includes(itemId.toLowerCase()));
      },
      () => {
        if (ctrl.signal.aborted || epoch !== accountEpoch() || orgRef.current !== orgId) return;
        setCoverFailed(true);
      },
    );
    return () => ctrl.abort();
  }, [orgId, itemId, offline, switched]);

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace('/reports/book-order-totals' as Href);
  }

  async function refresh() {
    if (offline || !key || !orgId || !userId || !itemId) return;
    setRefreshing(true);
    try {
      await load(page, key, orgId, userId, itemId);
    } finally {
      setRefreshing(false);
    }
  }

  let body: React.ReactNode;
  if (!itemId) {
    body = (
      <Card padding={16}>
        <Body size={15} accessibilityRole="alert">
          This link is not valid.
        </Body>
      </Card>
    );
  } else if (switched) {
    body = (
      <Card padding={16}>
        <Body size={15} accessibilityRole="alert">
          You switched workspace. These orders belong to the report you opened them from. Go back
          to see this workspace&apos;s report.
        </Body>
        <Button
          size="sm"
          variant="outline"
          onPress={goBack}
          style={{ alignSelf: 'flex-start', marginTop: 12, minHeight: 44 }}
        >
          Back
        </Button>
      </Card>
    );
  } else if (view.kind === 'loading') {
    body = (
      <ActivityIndicator
        color={c.ink}
        style={{ marginTop: 32 }}
        accessibilityLabel="Loading these orders"
      />
    );
  } else if (view.kind === 'error') {
    body = (
      <Card padding={16}>
        {view.error.notFound || view.offline ? (
          <Body size={15} accessibilityRole="alert" style={{ fontFamily: FONT.display }}>
            {view.error.detail}
          </Body>
        ) : (
          <>
            <Body size={15} accessibilityRole="alert" style={{ fontFamily: FONT.display }}>
              {BOOK_REPORT_ORDERS_LOAD_ERROR}
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
              style={{ minHeight: 44 }}
            >
              Try again
            </Button>
          ) : null}
          {page > 1 ? (
            <Button size="sm" variant="outline" onPress={() => setPage(1)} style={{ minHeight: 44 }}>
              First page
            </Button>
          ) : null}
        </View>
      </Card>
    );
  } else {
    body = (
      <OrdersBody
        answer={view.data.answer}
        banner={view.banner}
        cover={coverUrl ?? recallBookReportCover(orgId, view.data.answer.book?.itemId ?? '')}
        coverFailed={coverFailed}
        statusGroups={baseQuery.statusGroups}
        statusLabels={statusLabels}
        stacked={stacked}
        onViewCover={setViewer}
        onOpenOrder={(href) => router.push(href as Href)}
        onPage={setPage}
      />
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip icon={ChevronLeft} onPress={goBack} accessibilityLabel="Back" minTap />
        </View>
      </SafeAreaView>
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            enabled={!offline && !switched}
            tintColor={c.ink}
          />
        }
      >
        <Eyebrow>BOOK ORDER TOTALS · ORDERS</Eyebrow>
        {body}
      </ScrollView>
      <PhotoViewer
        uri={viewer ?? ''}
        cacheKey={viewer ? bookCoverCacheKey(viewer) : undefined}
        visible={viewer !== null}
        onClose={() => setViewer(null)}
        label={
          viewer && view.kind === 'ready' && view.data.answer.book
            ? bookCoverAlt(view.data.answer.book.name)
            : undefined
        }
      />
    </View>
  );
}

function OrdersBody({
  answer,
  banner,
  cover,
  coverFailed,
  statusGroups,
  statusLabels,
  stacked,
  onViewCover,
  onOpenOrder,
  onPage,
}: {
  answer: BookOrderOrdersResponse;
  banner: string | null;
  cover: string | null;
  coverFailed: boolean;
  statusGroups: readonly BookReportStatusGroup[];
  statusLabels: Readonly<Record<OrderStatusKey, string>>;
  stacked: boolean;
  onViewCover: (uri: string) => void;
  onOpenOrder: (href: string) => void;
  onPage: (page: number) => void;
}) {
  const { c } = useTheme();
  const book = answer.book;
  if (!book) return null;
  const ids = bookReportIdentifiersLine(book);
  const place = bookReportPlaceLine(book);
  const badges = bookReportRowBadges(book);
  const secondary = fulfilledReturnedLine(answer.totals);
  const pageSize = answer.pageSize;
  const totalPages = totalPagesFor(answer.totalCount, pageSize);
  const rows = answer.rows.map((row) => ({
    row,
    p: bookReportOrderRowPresentation(row, book, statusLabels),
  }));
  const someClosed = rows.some(({ p }) => p.href === null);
  const scope = [
    bookReportRangeLine(answer.range),
    bookReportZoneLine(answer.range),
    bookReportStatusLine(statusGroups, statusLabels),
    bookReportWarehouseLine(answer.filters.warehouse, answer.warehouse.source),
  ];

  return (
    <View style={{ gap: 14 }}>
      {banner ? (
        <Card padding={12}>
          <Body size={13.5} accessibilityRole="alert">
            {banner}
          </Body>
        </Card>
      ) : null}

      <View style={{ flexDirection: stacked ? 'column' : 'row', gap: 14, alignItems: 'flex-start' }}>
        <BookCover
          uri={cover}
          title={book.name}
          failed={coverFailed}
          width={72}
          height={108}
          onPress={cover ? () => onViewCover(cover) : undefined}
        />
        <View style={{ flex: stacked ? undefined : 1, minWidth: 0, gap: 4 }}>
          {/* The title is content: no Dynamic Type cap. */}
          <Display size={24} maxFontSizeMultiplier={0} accessibilityRole="header">
            {book.name}
          </Display>
          {ids ? (
            <Mono size={12} color={c.ink3}>
              {ids}
            </Mono>
          ) : null}
          {place ? (
            <Mono size={12} color={c.ink4}>
              {place}
            </Mono>
          ) : null}
          {badges.length > 0 ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
              {badges.map((b) => (
                <Pill key={b} dot={false}>
                  {b.toUpperCase()}
                </Pill>
              ))}
            </View>
          ) : null}
        </View>
      </View>

      <Card padding={14} style={{ gap: 6 }}>
        <Body size={16} style={{ fontFamily: FONT.display }}>
          {bookReportDrawerHeader(book, answer.totals)}
        </Body>
        {secondary ? (
          <>
            <Body size={13.5}>{secondary}</Body>
            <Body size={12.5} muted>
              {BOOK_REPORT_FULFILLED_NOTE}
            </Body>
          </>
        ) : null}
        {scope.map((line) => (
          <Body key={line} size={13} muted>
            {line}
          </Body>
        ))}
      </Card>

      {someClosed ? (
        <Body size={13} muted>
          {BOOK_REPORT_ORDER_LINK_HINT}
        </Body>
      ) : null}

      <View style={{ gap: 10 }}>
        {rows.map(({ row, p }) => (
          <OrderRow key={row.orderId} p={p} stacked={stacked} onOpen={onOpenOrder} />
        ))}
      </View>

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
            ORDER_NOUN,
          )}
        </Mono>
        <Paginator
          page={answer.page}
          pageCount={totalPages}
          rangeStart={(answer.page - 1) * pageSize + 1}
          rangeEnd={(answer.page - 1) * pageSize + answer.rows.length}
          total={answer.totalCount}
          onPageChange={onPage}
          hideRange
        />
        <Body size={12.5} muted style={{ textAlign: 'center' }}>
          {bookReportAsOfNote(answer.generatedAtLocal)}
        </Body>
      </View>
    </View>
  );
}

/**
 * One order. A button only when the server says it may be opened; otherwise
 * plain words (role text) with the reason as the hint: never a link to
 * someone else's order for a reader who cannot approve orders.
 */
function OrderRow({
  p,
  stacked,
  onOpen,
}: {
  p: ReturnType<typeof bookReportOrderRowPresentation>;
  stacked: boolean;
  onOpen: (href: string) => void;
}) {
  const { c } = useTheme();
  const content = (
    <Card padding={14}>
      <View
        style={{
          flexDirection: stacked ? 'column' : 'row',
          justifyContent: 'space-between',
          alignItems: stacked ? 'flex-start' : 'center',
          gap: stacked ? 2 : 12,
        }}
      >
        <Mono size={15} color={c.ink} style={{ fontFamily: FONT.display }}>
          {p.title}
        </Mono>
        <Mono size={13.5} color={c.ink}>
          {p.quantity}
        </Mono>
      </View>
      <Body size={13} muted style={{ marginTop: 4 }}>
        {p.details}
      </Body>
      {p.combined ? (
        <Body size={12.5} muted>
          {p.combined}
        </Body>
      ) : null}
      {p.href ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 }}>
          <Mono
            size={12}
            tracking={0.04}
            color={c.ink}
            maxFontSizeMultiplier={capTo(12, TYPE_CEILING.chrome)}
          >
            Open order
          </Mono>
          <ChevronRight size={14} color={c.ink} strokeWidth={1.6} />
        </View>
      ) : null}
    </Card>
  );
  if (p.href) {
    const href = p.href;
    return (
      <Pressable
        onPress={() => onOpen(href)}
        accessibilityRole="button"
        accessibilityLabel={p.accessibilityLabel}
        accessibilityHint={p.accessibilityHint}
        style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
      >
        {content}
      </Pressable>
    );
  }
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={p.accessibilityLabel}
      accessibilityHint={p.accessibilityHint}
    >
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topbar: { paddingHorizontal: 9, paddingTop: 5, flexDirection: 'row', alignItems: 'center' },
  body: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 48, gap: 14 },
  footer: { paddingTop: 6, gap: 8, alignItems: 'center' },
});
