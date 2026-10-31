import { type Href, useFocusEffect, useRouter } from 'expo-router';
import { ArrowLeft, SlidersHorizontal } from 'lucide-react-native';
import * as React from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  AppState,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
  type ListRenderItemInfo,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  ORDER_CATALOG_MANAGE_MAX_QUERY,
  ORDER_CATALOG_VISIBILITY_PERMISSION,
  parseOrderCatalogManageQuery,
  type OrderCatalogFamilyAnswer,
  type OrderCatalogManageQuery,
  type OrderCatalogManageRow,
  type OrderCatalogTypeFilter,
  type OrderCatalogVisibilityFilter,
} from '@stockpilot/core';

import { BookCover } from '@/components/book-cover';
import { RadioRow, Segmented, SmallAction } from '@/components/order-storefront/controls';
import { StorefrontSheet } from '@/components/order-storefront/storefront-sheet';
import { Card } from '@/components/ui/card';
import { Checkbox, CheckboxMark } from '@/components/ui/checkbox';
import { Paginator } from '@/components/ui/paginator';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Thumb } from '@/components/ui/thumb';
import { Body, Display, Eyebrow, Mono } from '@/components/ui/text';
import { accountEpoch } from '@/lib/account-epoch';
import { useAuth } from '@/lib/auth-context';
import { manageFailure, type ManageFailure } from '@/lib/order-catalog-visibility/api';
import {
  EMPTY_SELECTION,
  manageScopeKey,
  orderCatalogSelection,
  type ManageScope,
} from '@/lib/order-catalog-visibility/selection';
import { orderCatalogManageApi } from '@/lib/order-catalog-visibility/services';
import {
  manageActiveFilterCount,
  manageAnswerKey,
  manageListView,
  managePaging,
  manageRowDetail,
  manageRowHiddenSince,
  manageRowIdentifier,
  manageRowSpokenLabel,
  manageRowStatePill,
  offerRetry,
  pageBeyondEnd,
  pageSelectState,
  recordFromRow,
  rowsAfterWrite,
  savedOutcome,
  type StoredList,
} from '@/lib/order-catalog-visibility/view';
import {
  ORDER_ITEMS_CLEAR_SELECTION_COPY,
  ORDER_ITEMS_HIDE_ACTION_COPY,
  ORDER_ITEMS_HIDE_CONFIRM_BODY_COPY,
  ORDER_ITEMS_HIDE_SELECTED_COPY,
  ORDER_ITEMS_KITS_NOTE_COPY,
  ORDER_ITEMS_MANAGE_BUTTON_COPY,
  ORDER_ITEMS_MANAGE_SUBLINE_COPY,
  ORDER_ITEMS_PHONE_ALL_CATEGORIES_COPY,
  ORDER_ITEMS_PHONE_ALL_WAREHOUSES_COPY,
  ORDER_ITEMS_PHONE_BACK_COPY,
  ORDER_ITEMS_PHONE_CANCEL_COPY,
  ORDER_ITEMS_PHONE_CATEGORY_COPY,
  ORDER_ITEMS_PHONE_CLEAR_FILTERS_COPY,
  ORDER_ITEMS_PHONE_CLEAR_PAGE_COPY,
  ORDER_ITEMS_PHONE_DONE_COPY,
  ORDER_ITEMS_PHONE_FAMILY_EMPTY_COPY,
  ORDER_ITEMS_PHONE_FAMILY_LOAD_FAILED_COPY,
  ORDER_ITEMS_PHONE_FAMILY_TRUNCATED_COPY,
  ORDER_ITEMS_PHONE_FILTERS_COPY,
  ORDER_ITEMS_PHONE_HIDE_COPY,
  ORDER_ITEMS_PHONE_RELOAD_COPY,
  ORDER_ITEMS_PHONE_REMOVE_COPY,
  ORDER_ITEMS_PHONE_REVIEW_EMPTY_COPY,
  ORDER_ITEMS_PHONE_SEARCH_LABEL_COPY,
  ORDER_ITEMS_PHONE_SELECT_PAGE_COPY,
  ORDER_ITEMS_PHONE_SHOW_COPY,
  ORDER_ITEMS_PHONE_TRY_AGAIN_COPY,
  ORDER_ITEMS_PHONE_TYPE_COPY,
  ORDER_ITEMS_PHONE_VISIBILITY_GROUP_COPY,
  ORDER_ITEMS_PHONE_VISIBILITY_LABELS,
  ORDER_ITEMS_PHONE_WAREHOUSE_COPY,
  ORDER_ITEMS_REVIEW_SELECTION_COPY,
  ORDER_ITEMS_SEARCH_PLACEHOLDER_COPY,
  ORDER_ITEMS_SELECT_FAMILY_COPY,
  ORDER_ITEMS_SHOW_ACTION_COPY,
  ORDER_ITEMS_SHOW_CONFIRM_BODY_COPY,
  ORDER_ITEMS_SHOW_SELECTED_COPY,
  ORDER_ITEMS_STATE_EXPECTED_COPY,
  ORDER_ITEMS_TYPE_FILTER_LABELS,
  orderItemsFamilyAddCopy,
  orderItemsFiltersLabel,
  orderItemsHideConfirmTitle,
  orderItemsRangeCopy,
  orderItemsRemoveFromSelectionLabel,
  orderItemsRowActionLabel,
  orderItemsSelectFamilyLabel,
  orderItemsSelectedCopy,
  orderItemsShowConfirmTitle,
} from '@/lib/order-catalog-visibility/words';
import {
  keyedVisibilityBody,
  sendVisibility,
  visibilityDraft,
  visibilityWriteBlockedBy,
} from '@/lib/order-catalog-visibility/write';
import { MIN_TAP, STOREFRONT_GUTTER } from '@/lib/order-storefront/layout';
import { storefrontSession, useOffline } from '@/lib/order-storefront/runtime';
import { supabase } from '@/lib/supabase';
import { FONT, SHADOW, TYPE_CEILING, capTo } from '@/lib/theme';
import { fetchEffectivePermissions, useEffectivePermissions } from '@/lib/use-effective-permissions';
import { useTheme } from '@/lib/use-theme';
import { useWorkspace } from '@/lib/use-workspace';

/**
 * MANAGE ORDER ITEMS (ordering visibility, migration 0413; design 3.7, 8.6).
 * A native screen, never a WebView: which items and books appear in Place an
 * Order. It lists every record the person can READ (Inventory's row level
 * security decides, on the server), hidden ones included so they can be
 * shown again, 25 a page over the full dataset, searched and filtered on the
 * server.
 *
 * Every decision is in a tested module (lib/order-catalog-visibility: the
 * calls, the selection, the keyed write, the words and what the list shows);
 * this file wires them, and manage-items-wiring.test.ts pins the wiring:
 *
 *   - the screen belongs to one (account, organization, account epoch): the
 *     body is keyed by it, so a workspace switch starts it over, and the
 *     selection store forgets the old scope's records;
 *   - a Show or Hide sends exactly the explicit ids, once confirmed in core's
 *     words, ONLINE ONLY (Confirm is disabled offline with the reason) and
 *     never queued; one request at a time; a retry resends the same
 *     operationId;
 *   - a final refusal (no capability any more, the switch off, Orders off)
 *     locks every control, keeps the list readable and reads the capability
 *     again: no repeated failed taps (design 3.7). A change to the effective
 *     permission set (the drawer's realtime listener refetches it) reads the
 *     list again, so a denial reaches an open screen;
 *   - outcomes are said in place (role alert, announced): the phone has no
 *     toast library.
 */

/** A change waiting for Confirm (or for Try again). */
interface WriteDraft {
  ids: string[];
  visible: boolean;
  /** Bulk changes clear the selection when they are saved; a row's does not. */
  source: 'bulk' | 'row';
  /** The record's name for a row change (said in the confirm sheet). */
  name: string | null;
}

interface Status {
  tone: 'ok' | 'warn';
  message: string;
  retry: WriteDraft | null;
}

interface FamilySheet {
  groupId: string;
  name: string | null;
  status: 'loading' | 'ready' | 'failed';
  answer: OrderCatalogFamilyAnswer | null;
  checked: ReadonlySet<string>;
  refusal: string | null;
}

interface Option {
  id: string;
  name: string;
}

const DEFAULT_QUERY: OrderCatalogManageQuery = parseOrderCatalogManageQuery({});

export default function ManageOrderItemsScreen() {
  const { user } = useAuth();
  const { activeOrgId } = useWorkspace();
  const userId = user?.id ?? null;
  // The account epoch ends with the account (a sign-out, another account), and
  // every such change also changes `user`, so reading it here is current.
  const epoch = accountEpoch();
  const scope = React.useMemo<ManageScope | null>(
    () => (userId && activeOrgId ? { userId, orgId: activeOrgId, epoch } : null),
    [userId, activeOrgId, epoch],
  );
  const scopeKey = scope ? manageScopeKey(scope) : null;

  // Bind on mount and on every focus: any other scope's selection, review
  // sheet and kept operation are forgotten before anything is shown.
  React.useEffect(() => {
    if (scope) orderCatalogSelection.bindScope(scope);
  }, [scope]);
  useFocusEffect(
    React.useCallback(() => {
      if (scope) orderCatalogSelection.bindScope(scope);
    }, [scope]),
  );

  if (!scope || !scopeKey) return <SignedOutFrame />;
  // Keyed by the scope: another account or workspace starts the screen over
  // (its filters, its rows, its sheets and its saved words).
  return <ManageItemsBody key={scopeKey} scope={scope} scopeKey={scopeKey} />;
}

function SignedOutFrame() {
  const { c } = useTheme();
  return <View style={{ flex: 1, backgroundColor: c.paper }} />;
}

function ManageItemsBody({ scope, scopeKey }: { scope: ManageScope; scopeKey: string }) {
  const router = useRouter();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const offline = useOffline();
  const permissions = useEffectivePermissions();
  const { warehouses } = useWorkspace();
  const callScope = React.useMemo(() => ({ orgId: scope.orgId, userId: scope.userId }), [scope]);

  const store = React.useSyncExternalStore(orderCatalogSelection.subscribe, orderCatalogSelection.getSnapshot);
  const selection = store.scopeKey === scopeKey ? store : EMPTY_SELECTION;

  // ── The query ─────────────────────────────────────────────────────────────
  const [query, setQuery] = React.useState<OrderCatalogManageQuery>(DEFAULT_QUERY);
  const [typed, setTyped] = React.useState('');
  // Searched on the server, 300 ms after the last keystroke; a new search
  // starts at page 1.
  React.useEffect(() => {
    const next = typed.trim().slice(0, ORDER_CATALOG_MANAGE_MAX_QUERY);
    const t = setTimeout(() => setQuery((q) => (q.q === next ? q : { ...q, q: next, page: 1 })), 300);
    return () => clearTimeout(t);
  }, [typed]);
  const key = manageAnswerKey(scopeKey, query);

  // ── The list ──────────────────────────────────────────────────────────────
  const [stored, setStored] = React.useState<StoredList | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  /** A final refusal's words: every control is off until a read succeeds. */
  const [locked, setLocked] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<Status | null>(null);
  const seq = React.useRef(0);
  const inFlight = React.useRef<AbortController | null>(null);

  const say = React.useCallback((next: Status) => {
    setStatus(next);
    if (next.message) AccessibilityInfo.announceForAccessibility(next.message);
  }, []);

  const lockScreen = React.useCallback((message: string) => {
    setLocked(message);
    // Read the capability again, so the entries that open this screen follow.
    void fetchEffectivePermissions();
  }, []);

  const load = React.useCallback(async () => {
    // Nothing is asked offline: the list shows what it has, labelled.
    if (offline) return;
    const mine = ++seq.current;
    inFlight.current?.abort();
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    try {
      const answer = await orderCatalogManageApi.list(callScope, query, ctrl.signal);
      if (mine !== seq.current) return;
      // A page past the end (records changed since): read the last page.
      const last = pageBeyondEnd(answer);
      if (last !== null) {
        setQuery((q) => ({ ...q, page: last }));
        return;
      }
      setStored({ key, answer, failure: null });
      setLocked(null);
    } catch (e) {
      if (mine !== seq.current || ctrl.signal.aborted) return;
      const failure = manageFailure(e, 'read');
      // An answer for a workspace this screen has left says nothing.
      if (failure.reason === 'other_organization') return;
      setStored((prev) => ({ key, answer: prev && prev.key === key ? prev.answer : null, failure }));
      if (failure.final) lockScreen(failure.message);
    }
  }, [offline, callScope, query, key, lockScreen]);
  const loadRef = React.useRef(load);
  React.useLayoutEffect(() => {
    loadRef.current = load;
  });

  // Read on every focus, on a query change and when the connection returns.
  useFocusEffect(
    React.useCallback(() => {
      void load();
    }, [load]),
  );
  React.useEffect(() => () => inFlight.current?.abort(), []);
  // And when the app returns to the foreground.
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void loadRef.current();
    });
    return () => sub.remove();
  }, []);
  // A change of the capability in the effective set (StockPilot allowed,
  // denied or reset it; the drawer's realtime listener refetches the set):
  // read the list again, which answers forbidden once it is gone (design 3.7).
  const holdsKey = permissions === undefined ? null : permissions.has(ORDER_CATALOG_VISIBILITY_PERMISSION);
  const firstHolds = React.useRef(true);
  React.useEffect(() => {
    if (firstHolds.current) {
      firstHolds.current = false;
      return;
    }
    void loadRef.current();
  }, [holdsKey]);

  async function refresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  const view = manageListView(stored, key, offline, query);
  const answer = view.kind === 'rows' ? view.answer : null;
  const rows = answer?.rows ?? [];

  // ── Filters ───────────────────────────────────────────────────────────────
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [categories, setCategories] = React.useState<Option[]>([]);
  // The organization's categories for the filter, read once, under the
  // person's own access (row level security). A failed read offers only "All".
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from('categories')
        .select('id, name')
        .eq('organization_id', scope.orgId)
        .is('deleted_at', null)
        .order('name', { ascending: true });
      if (cancelled || error) return;
      setCategories(((data ?? []) as Option[]).filter((o) => typeof o.id === 'string' && typeof o.name === 'string'));
    })();
    return () => {
      cancelled = true;
    };
  }, [scope.orgId]);
  const setFilter = (patch: Partial<OrderCatalogManageQuery>) => setQuery((q) => ({ ...q, ...patch, page: 1 }));
  const activeFilters = manageActiveFilterCount(query);

  // ── Writes ────────────────────────────────────────────────────────────────
  const [confirm, setConfirm] = React.useState<WriteDraft | null>(null);
  const [saving, setSaving] = React.useState(false);
  const savingRef = React.useRef(false);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const blockedFor = (count: number) => visibilityWriteBlockedBy({ offline, count, locked });

  async function send(draft: WriteDraft) {
    // One request at a time; never offline, never past the cap, never locked.
    if (savingRef.current || blockedFor(draft.ids.length) !== null) return;
    const pending = keyedVisibilityBody(
      orderCatalogSelection.forScope(scope).pending,
      visibilityDraft(draft.ids, draft.visible),
    );
    orderCatalogSelection.setPending(scope, pending);
    savingRef.current = true;
    setSaving(true);
    setStatus(null);
    const result = await sendVisibility(orderCatalogManageApi, callScope, pending);
    savingRef.current = false;
    // Another account or workspace now (this body was unmounted): its
    // selection is gone and nothing is said here.
    if (!mounted.current) return;
    setSaving(false);
    setConfirm(null);
    if (result.ok) {
      const { answer: saved } = result;
      orderCatalogSelection.setPending(scope, null);
      orderCatalogSelection.markVisible(scope, [...saved.changed, ...saved.unchanged], saved.visible);
      if (draft.source === 'bulk') orderCatalogSelection.clear(scope);
      setStored((prev) =>
        prev && prev.answer ? { ...prev, answer: { ...prev.answer, rows: rowsAfterWrite(prev.answer.rows, saved) } } : prev,
      );
      say({ tone: 'ok', message: savedOutcome(saved), retry: null });
      // The dates and the filter's members are the server's: read again.
      void loadRef.current();
      if (saved.changed.length > 0) refreshOpenStorefront(scope);
      return;
    }
    const failure: ManageFailure = result.failure;
    if (failure.reason === 'other_organization') return;
    if (!failure.retrySame) orderCatalogSelection.setPending(scope, null);
    // Nothing was changed; the records named are no longer the caller's to
    // manage, so they leave the selection.
    if (failure.reason === 'items_unavailable') orderCatalogSelection.remove(scope, failure.itemIds);
    if (failure.final) lockScreen(failure.message);
    say({ tone: 'warn', message: failure.message, retry: offerRetry(failure) ? draft : null });
    if (failure.reason === 'items_unavailable' || failure.reason === 'internal' || failure.reason === 'no_answer') {
      void loadRef.current();
    }
  }

  const askRow = React.useCallback(
    (row: OrderCatalogManageRow) => setConfirm({ ids: [row.id], visible: !row.visible, source: 'row', name: row.name }),
    [setConfirm],
  );
  const askBulk = (visible: boolean) =>
    setConfirm({ ids: selection.records.map((r) => r.id), visible, source: 'bulk', name: null });

  // ── Selection ─────────────────────────────────────────────────────────────
  const toggleRow = React.useCallback(
    (row: OrderCatalogManageRow) => {
      const refusal = orderCatalogSelection.toggle(scope, recordFromRow(row));
      if (refusal) say({ tone: 'warn', message: refusal, retry: null });
    },
    [scope, say],
  );
  const pageState = pageSelectState(rows, selection.ids);
  const togglePage = () => {
    if (pageState === true) {
      orderCatalogSelection.remove(scope, rows.map((r) => r.id));
      return;
    }
    const refusal = orderCatalogSelection.add(scope, rows.map(recordFromRow));
    if (refusal) say({ tone: 'warn', message: refusal, retry: null });
  };

  // ── Family disclosure ─────────────────────────────────────────────────────
  const [family, setFamily] = React.useState<FamilySheet | null>(null);
  const familySeq = React.useRef(0);
  const openFamily = React.useCallback(
    async (groupId: string, name: string | null) => {
      const mine = ++familySeq.current;
      setFamily({ groupId, name, status: 'loading', answer: null, checked: new Set(), refusal: null });
      try {
        const got = await orderCatalogManageApi.family(callScope, groupId);
        if (mine !== familySeq.current || !mounted.current) return;
        // Every member the person can read, each ticked: Confirm adds exactly
        // the ticked ones, nothing else of the family.
        setFamily({
          groupId,
          name: got.familyName ?? name,
          status: 'ready',
          answer: got,
          checked: new Set(got.rows.map((r) => r.id.toLowerCase())),
          refusal: null,
        });
      } catch (e) {
        if (mine !== familySeq.current || !mounted.current) return;
        const failure = manageFailure(e, 'read');
        if (failure.reason === 'other_organization') return;
        if (failure.final) {
          setFamily(null);
          lockScreen(failure.message);
          return;
        }
        setFamily((f) => (f && f.groupId === groupId ? { ...f, status: 'failed', refusal: null } : f));
      }
    },
    [callScope, lockScreen, setFamily],
  );
  const closeFamily = () => {
    familySeq.current += 1;
    setFamily(null);
  };
  const addFamily = () => {
    if (!family?.answer) return;
    const picked = family.answer.rows.filter((r) => family.checked.has(r.id.toLowerCase())).map(recordFromRow);
    const refusal = orderCatalogSelection.add(scope, picked);
    if (refusal) {
      setFamily({ ...family, refusal });
      return;
    }
    closeFamily();
  };

  // ── Rows ──────────────────────────────────────────────────────────────────
  const controlsOff = locked !== null || saving;
  const writeBlocked = blockedFor(1);
  const renderItem = React.useCallback(
    ({ item }: ListRenderItemInfo<OrderCatalogManageRow>) => (
      <ManageRow
        row={item}
        selected={selection.ids.has(item.id.toLowerCase())}
        disabled={controlsOff}
        writeBlocked={writeBlocked}
        onToggle={toggleRow}
        onAct={askRow}
        onFamily={openFamily}
      />
    ),
    [selection.ids, controlsOff, writeBlocked, toggleRow, askRow, openFamily],
  );

  const paging = answer ? managePaging(answer) : null;
  const [barHeight, setBarHeight] = React.useState(0);
  const count = selection.records.length;
  const bulkBlocked = blockedFor(count);

  const header = (
    <View style={{ gap: 12, paddingBottom: 8 }}>
      <Display size={30} accessibilityRole="header">
        {ORDER_ITEMS_MANAGE_BUTTON_COPY}
      </Display>
      <Body size={14} color={c.ink3}>
        {ORDER_ITEMS_MANAGE_SUBLINE_COPY}
      </Body>
      {view.kind === 'refused' ? null : (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <TextInput
            value={typed}
            onChangeText={setTyped}
            placeholder={ORDER_ITEMS_SEARCH_PLACEHOLDER_COPY}
            placeholderTextColor={c.ink3}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            clearButtonMode="while-editing"
            accessibilityLabel={ORDER_ITEMS_PHONE_SEARCH_LABEL_COPY}
            maxFontSizeMultiplier={INPUT_CAP}
            style={[styles.search, { borderColor: c.hair2, backgroundColor: c.card, color: c.ink }]}
          />
          <Pressable
            onPress={() => setFiltersOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={orderItemsFiltersLabel(activeFilters)}
            style={[styles.filterButton, { borderColor: c.hair2, backgroundColor: c.card }]}
          >
            <SlidersHorizontal size={18} color={c.ink} strokeWidth={1.5} />
            {activeFilters > 0 ? (
              <Mono size={11} color={c.ink} maxFontSizeMultiplier={CHROME_CAP}>
                {activeFilters}
              </Mono>
            ) : null}
          </Pressable>
        </View>
      )}
      {view.kind === 'refused' ? null : (
        <Segmented<OrderCatalogVisibilityFilter>
          label={ORDER_ITEMS_PHONE_VISIBILITY_GROUP_COPY}
          options={(['all', 'shown', 'hidden'] as const).map((v) => ({ value: v, label: ORDER_ITEMS_PHONE_VISIBILITY_LABELS[v] }))}
          value={query.visibility}
          disabled={false}
          onChange={(visibility) => setFilter({ visibility })}
        />
      )}
      {locked && view.kind === 'rows' ? (
        <Card padding={12}>
          <Body size={13.5} color={c.ink} accessibilityRole="alert">
            {locked}
          </Body>
        </Card>
      ) : null}
      {status ? (
        <View accessibilityRole="alert" style={[styles.status, { borderColor: status.tone === 'ok' ? c.hair2 : c.ink3, backgroundColor: c.card }]}>
          <Body size={13.5} color={c.ink}>
            {status.message}
          </Body>
          {status.retry && !locked ? (
            <SmallAction
              label={ORDER_ITEMS_PHONE_TRY_AGAIN_COPY}
              onPress={() => {
                if (status.retry) void send(status.retry);
              }}
              disabled={saving || offline}
              busy={saving}
              hint={offline ? (writeBlocked ?? undefined) : undefined}
            />
          ) : null}
        </View>
      ) : null}
      {view.kind === 'rows' && view.note ? (
        <Body size={13} color={c.ink3}>
          {view.note}
        </Body>
      ) : null}
      {rows.length > 0 ? (
        <Checkbox
          checked={pageState}
          onChange={togglePage}
          label={pageState === true ? ORDER_ITEMS_PHONE_CLEAR_PAGE_COPY : ORDER_ITEMS_PHONE_SELECT_PAGE_COPY}
          disabled={controlsOff}
        />
      ) : null}
    </View>
  );

  const footer =
    answer && paging && paging.total > 0 ? (
      <View style={{ alignItems: 'center', paddingTop: 12 }}>
        <Mono size={11} color={c.ink3} maxFontSizeMultiplier={CHROME_CAP}>
          {orderItemsRangeCopy(paging.rangeStart, paging.rangeEnd, paging.total)}
        </Mono>
        <Paginator
          page={answer.page}
          pageCount={paging.pageCount}
          rangeStart={paging.rangeStart}
          rangeEnd={paging.rangeEnd}
          total={paging.total}
          onPageChange={(page) => setQuery((q) => ({ ...q, page }))}
          hideRange
        />
      </View>
    ) : null;

  const empty =
    view.kind === 'loading' ? (
      <View style={styles.center}>
        <ActivityIndicator color={c.ink3} accessibilityLabel={ORDER_ITEMS_MANAGE_BUTTON_COPY} />
      </View>
    ) : view.kind === 'rows' ? null : (
      <View style={[styles.center, { gap: 12 }]}>
        <Body size={14.5} color={c.ink} accessibilityRole={view.kind === 'empty' ? undefined : 'alert'} style={{ textAlign: 'center' }}>
          {view.message}
        </Body>
        {view.kind === 'failed' ? (
          <SmallAction label={ORDER_ITEMS_PHONE_RELOAD_COPY} onPress={() => void refresh()} disabled={offline} />
        ) : null}
      </View>
    );

  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/orders' as Href);
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.paper }}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip icon={ArrowLeft} onPress={leave} accessibilityLabel={ORDER_ITEMS_PHONE_BACK_COPY} minTap />
        </View>
      </SafeAreaView>
      <FlatList
        data={rows}
        keyExtractor={rowKey}
        renderItem={renderItem}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        ListEmptyComponent={empty}
        ItemSeparatorComponent={RowGap}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={c.ink3} />}
        contentContainerStyle={{
          paddingHorizontal: STOREFRONT_GUTTER,
          paddingTop: 8,
          // The last rows and the pager stay clear of the selection bar.
          paddingBottom: (count > 0 ? barHeight + 24 : 24) + insets.bottom,
        }}
      />

      {count > 0 ? (
        <View
          onLayout={(e) => setBarHeight(e.nativeEvent.layout.height)}
          style={[styles.bar, SHADOW.fab, { bottom: insets.bottom + 12, backgroundColor: c.card, borderColor: c.hair2 }]}
        >
          <Mono size={13} color={c.ink} style={{ flexShrink: 1, minWidth: 0 }} maxFontSizeMultiplier={CHROME_CAP}>
            {orderItemsSelectedCopy(count)}
          </Mono>
          <View style={styles.barActions}>
            <SmallAction
              label={ORDER_ITEMS_REVIEW_SELECTION_COPY}
              variant="ghost"
              onPress={() => orderCatalogSelection.setReviewOpen(scope, true)}
            />
            <SmallAction
              label={ORDER_ITEMS_SHOW_SELECTED_COPY}
              onPress={() => askBulk(true)}
              disabled={controlsOff || bulkBlocked !== null}
              hint={bulkBlocked ?? undefined}
            />
            <SmallAction
              label={ORDER_ITEMS_HIDE_SELECTED_COPY}
              variant="primary"
              onPress={() => askBulk(false)}
              disabled={controlsOff || bulkBlocked !== null}
              hint={bulkBlocked ?? undefined}
            />
            <SmallAction
              label={ORDER_ITEMS_CLEAR_SELECTION_COPY}
              variant="ghost"
              onPress={() => orderCatalogSelection.clear(scope)}
              disabled={saving}
            />
          </View>
        </View>
      ) : null}

      {/* Confirm: core's words; it cannot be closed while saving, and
          Confirm is disabled offline with the reason. */}
      <StorefrontSheet
        visible={confirm !== null}
        title={
          confirm
            ? confirm.visible
              ? orderItemsShowConfirmTitle(confirm.ids.length)
              : orderItemsHideConfirmTitle(confirm.ids.length)
            : ''
        }
        onClose={() => setConfirm(null)}
        busy={saving}
        footer={
          confirm ? (
            <>
              <SmallAction
                label={confirm.visible ? ORDER_ITEMS_SHOW_ACTION_COPY : ORDER_ITEMS_HIDE_ACTION_COPY}
                variant="primary"
                busy={saving}
                disabled={blockedFor(confirm.ids.length) !== null}
                hint={blockedFor(confirm.ids.length) ?? undefined}
                onPress={() => void send(confirm)}
              />
              <SmallAction label={ORDER_ITEMS_PHONE_CANCEL_COPY} variant="ghost" disabled={saving} onPress={() => setConfirm(null)} />
            </>
          ) : null
        }
      >
        {confirm?.name ? (
          <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>
            {confirm.name}
          </Body>
        ) : null}
        <Body size={14.5} color={c.ink}>
          {confirm?.visible ? ORDER_ITEMS_SHOW_CONFIRM_BODY_COPY : ORDER_ITEMS_HIDE_CONFIRM_BODY_COPY}
        </Body>
        {confirm && blockedFor(confirm.ids.length) ? (
          <Body size={13.5} color={c.ink3} accessibilityRole="alert">
            {blockedFor(confirm.ids.length)}
          </Body>
        ) : null}
      </StorefrontSheet>

      {/* Review selection: every selected record, off-page ones included, so
          nothing is silently included. */}
      <StorefrontSheet
        visible={selection.reviewOpen}
        title={`${ORDER_ITEMS_REVIEW_SELECTION_COPY} (${count.toLocaleString('en-US')})`}
        onClose={() => orderCatalogSelection.setReviewOpen(scope, false)}
        footer={
          <>
            <SmallAction
              label={ORDER_ITEMS_CLEAR_SELECTION_COPY}
              variant="ghost"
              disabled={count === 0 || saving}
              onPress={() => orderCatalogSelection.clear(scope)}
            />
            <SmallAction label={ORDER_ITEMS_PHONE_DONE_COPY} onPress={() => orderCatalogSelection.setReviewOpen(scope, false)} />
          </>
        }
      >
        {count === 0 ? (
          <Body size={14} color={c.ink3}>
            {ORDER_ITEMS_PHONE_REVIEW_EMPTY_COPY}
          </Body>
        ) : (
          selection.records.map((r) => (
            <View key={r.id} style={[styles.reviewRow, { borderColor: c.hair }]}>
              <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                <Body size={14.5} color={c.ink}>
                  {r.name}
                </Body>
                {r.identifier ? (
                  <Mono size={11.5} color={c.ink3}>
                    {r.identifier}
                  </Mono>
                ) : null}
                <View style={{ flexDirection: 'row' }}>
                  <Pill status={manageRowStatePill(r).status}>{manageRowStatePill(r).label}</Pill>
                </View>
              </View>
              <SmallAction
                label={ORDER_ITEMS_PHONE_REMOVE_COPY}
                accessibilityLabel={orderItemsRemoveFromSelectionLabel(r.name)}
                variant="ghost"
                disabled={saving}
                onPress={() => orderCatalogSelection.remove(scope, [r.id])}
              />
            </View>
          ))
        )}
      </StorefrontSheet>

      {/* Select family: exactly the members the person can read, each ticked;
          Add takes exactly the ticked ones. */}
      <StorefrontSheet
        visible={family !== null}
        title={ORDER_ITEMS_SELECT_FAMILY_COPY}
        onClose={closeFamily}
        footer={
          family ? (
            <>
              <SmallAction
                label={orderItemsFamilyAddCopy(family.checked.size)}
                variant="primary"
                disabled={family.status !== 'ready' || family.checked.size === 0 || controlsOff}
                onPress={addFamily}
              />
              <SmallAction label={ORDER_ITEMS_PHONE_CANCEL_COPY} variant="ghost" onPress={closeFamily} />
            </>
          ) : null
        }
      >
        {family?.name ? (
          <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>
            {family.name}
          </Body>
        ) : null}
        {family?.status === 'loading' ? <ActivityIndicator color={c.ink3} /> : null}
        {family?.status === 'failed' ? (
          <View style={{ gap: 8 }}>
            <Body size={14} color={c.ink} accessibilityRole="alert">
              {ORDER_ITEMS_PHONE_FAMILY_LOAD_FAILED_COPY}
            </Body>
            <SmallAction label={ORDER_ITEMS_PHONE_TRY_AGAIN_COPY} onPress={() => void openFamily(family.groupId, family.name)} />
          </View>
        ) : null}
        {family?.status === 'ready' && family.answer ? (
          family.answer.rows.length === 0 ? (
            <Body size={14} color={c.ink3}>
              {ORDER_ITEMS_PHONE_FAMILY_EMPTY_COPY}
            </Body>
          ) : (
            <>
              {family.answer.rows.map((r) => {
                const id = r.id.toLowerCase();
                const on = family.checked.has(id);
                return (
                  <Pressable
                    key={id}
                    onPress={() => {
                      const next = new Set(family.checked);
                      if (on) next.delete(id);
                      else next.add(id);
                      setFamily({ ...family, checked: next, refusal: null });
                    }}
                    accessibilityRole="checkbox"
                    accessibilityLabel={manageRowSpokenLabel(r)}
                    accessibilityState={{ checked: on }}
                    style={({ pressed }) => [styles.familyRow, { borderColor: c.hair, opacity: pressed ? 0.85 : 1 }]}
                  >
                    <CheckboxMark checked={on} />
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                      <Body size={14.5} color={c.ink}>
                        {r.name}
                      </Body>
                      <Body size={12.5} color={c.ink3}>
                        {[manageRowDetail(r), r.warehouseName, manageRowStatePill(r).label].filter(Boolean).join(' · ')}
                      </Body>
                    </View>
                  </Pressable>
                );
              })}
              {family.answer.truncated ? (
                <Body size={13} color={c.ink3}>
                  {ORDER_ITEMS_PHONE_FAMILY_TRUNCATED_COPY}
                </Body>
              ) : null}
            </>
          )
        ) : null}
        {family?.refusal ? (
          <Body size={13.5} color={c.ink} accessibilityRole="alert">
            {family.refusal}
          </Body>
        ) : null}
      </StorefrontSheet>

      {/* Filters: type, warehouse and category, one choice each, and the
          kits note (the web page says it under its filters). */}
      <StorefrontSheet
        visible={filtersOpen}
        title={ORDER_ITEMS_PHONE_FILTERS_COPY}
        onClose={() => setFiltersOpen(false)}
        footer={
          <>
            <SmallAction
              label={ORDER_ITEMS_PHONE_CLEAR_FILTERS_COPY}
              variant="ghost"
              disabled={activeFilters === 0}
              onPress={() => setFilter({ type: 'all', warehouseId: null, categoryId: null })}
            />
            <SmallAction label={ORDER_ITEMS_PHONE_DONE_COPY} onPress={() => setFiltersOpen(false)} />
          </>
        }
      >
        <Eyebrow>{ORDER_ITEMS_PHONE_TYPE_COPY}</Eyebrow>
        {(['all', 'items', 'books'] as const satisfies readonly OrderCatalogTypeFilter[]).map((t) => (
          <RadioRow key={t} label={ORDER_ITEMS_TYPE_FILTER_LABELS[t]} checked={query.type === t} onPress={() => setFilter({ type: t })} />
        ))}
        <Eyebrow>{ORDER_ITEMS_PHONE_WAREHOUSE_COPY}</Eyebrow>
        <RadioRow
          label={ORDER_ITEMS_PHONE_ALL_WAREHOUSES_COPY}
          checked={query.warehouseId === null}
          onPress={() => setFilter({ warehouseId: null })}
        />
        {warehouses.map((w) => (
          <RadioRow
            key={w.id}
            label={w.name}
            checked={query.warehouseId === w.id.toLowerCase()}
            onPress={() => setFilter({ warehouseId: w.id.toLowerCase() })}
          />
        ))}
        <Eyebrow>{ORDER_ITEMS_PHONE_CATEGORY_COPY}</Eyebrow>
        <RadioRow
          label={ORDER_ITEMS_PHONE_ALL_CATEGORIES_COPY}
          checked={query.categoryId === null}
          onPress={() => setFilter({ categoryId: null })}
        />
        {categories.map((cat) => (
          <RadioRow
            key={cat.id}
            label={cat.name}
            checked={query.categoryId === cat.id.toLowerCase()}
            onPress={() => setFilter({ categoryId: cat.id.toLowerCase() })}
          />
        ))}
        <Body size={13} color={c.ink3}>
          {ORDER_ITEMS_KITS_NOTE_COPY}
        </Body>
      </StorefrontSheet>
    </View>
  );
}

/** After a saved change, an open storefront of the same account and
 *  workspace reads its catalog again, so a hidden record leaves it now rather
 *  than at its next stale read (checkout re-reads it anyway). */
function refreshOpenStorefront(scope: ManageScope) {
  const session = storefrontSession();
  const shown = session.getSnapshot().scope;
  if (shown && shown.userId === scope.userId && shown.orgId === scope.orgId) void session.refresh();
}

const rowKey = (r: OrderCatalogManageRow) => r.id;

function RowGap() {
  return <View style={{ height: 10 }} />;
}

/**
 * One record: the row is its checkbox (one VoiceOver element naming the
 * record and its state), and its actions are siblings, never inside it (a
 * touchable inside a touchable is unreachable with VoiceOver).
 */
const ManageRow = React.memo(function ManageRow({
  row,
  selected,
  disabled,
  writeBlocked,
  onToggle,
  onAct,
  onFamily,
}: {
  row: OrderCatalogManageRow;
  selected: boolean;
  disabled: boolean;
  /** Why a Show or Hide cannot be sent now (offline, locked), or null. */
  writeBlocked: string | null;
  onToggle: (row: OrderCatalogManageRow) => void;
  onAct: (row: OrderCatalogManageRow) => void;
  onFamily: (groupId: string, name: string | null) => void;
}) {
  const { c } = useTheme();
  const { fontScale } = useWindowDimensions();
  const pill = manageRowStatePill(row);
  const detail = manageRowDetail(row);
  const identifier = manageRowIdentifier(row);
  const since = manageRowHiddenSince(row);
  const thumbSize = fontScale > 1.4 ? 40 : 48;
  return (
    <View style={[styles.row, { borderColor: c.hair, backgroundColor: c.card }]}>
      <Pressable
        onPress={disabled ? undefined : () => onToggle(row)}
        disabled={disabled}
        accessibilityRole="checkbox"
        accessibilityLabel={manageRowSpokenLabel(row)}
        accessibilityState={{ checked: selected, disabled }}
        style={({ pressed }) => [styles.rowMain, { opacity: pressed ? 0.85 : 1 }]}
      >
        <View style={{ paddingTop: 2 }}>
          <CheckboxMark checked={selected} disabled={disabled} />
        </View>
        {row.itemType === 'book' ? (
          <BookCover uri={row.thumbUrl} title={row.name} width={thumbSize} height={Math.round(thumbSize * 1.4)} />
        ) : (
          <Thumb size={thumbSize} imageUrl={row.thumbUrl} recyclingKey={row.id} />
        )}
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>
            {row.name}
          </Body>
          {detail ? (
            <Body size={12.5} color={c.ink3}>
              {detail}
            </Body>
          ) : null}
          {identifier ? (
            <Mono size={11.5} color={c.ink3}>
              {identifier}
            </Mono>
          ) : null}
          {row.warehouseName ? (
            <Body size={12.5} color={c.ink3}>
              {row.warehouseName}
            </Body>
          ) : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
            <Pill status={pill.status}>{pill.label}</Pill>
            {row.expected ? <Pill dot={false}>{ORDER_ITEMS_STATE_EXPECTED_COPY}</Pill> : null}
          </View>
          {since ? (
            <Body size={12.5} color={c.ink3}>
              {since}
            </Body>
          ) : null}
        </View>
      </Pressable>
      <View style={styles.rowActions}>
        <SmallAction
          label={row.visible ? ORDER_ITEMS_PHONE_HIDE_COPY : ORDER_ITEMS_PHONE_SHOW_COPY}
          accessibilityLabel={orderItemsRowActionLabel(row.visible, row.name)}
          variant={row.visible ? 'outline' : 'primary'}
          disabled={disabled || writeBlocked !== null}
          hint={writeBlocked ?? undefined}
          onPress={() => onAct(row)}
        />
        {row.familyId ? (
          <SmallAction
            label={ORDER_ITEMS_SELECT_FAMILY_COPY}
            accessibilityLabel={orderItemsSelectFamilyLabel(row.familyName)}
            variant="ghost"
            disabled={disabled}
            onPress={() => onFamily(row.familyId!, row.familyName)}
          />
        ) : null}
      </View>
    </View>
  );
});

const INPUT_CAP = capTo(15, TYPE_CEILING.input);
const CHROME_CAP = capTo(13, TYPE_CEILING.chrome);

const styles = StyleSheet.create({
  topbar: { paddingHorizontal: 9, paddingTop: 5, flexDirection: 'row', alignItems: 'center' },
  search: {
    flex: 1,
    minHeight: MIN_TAP,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: FONT.displayRegular,
    fontSize: 15,
  },
  filterButton: {
    minWidth: MIN_TAP,
    minHeight: MIN_TAP,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 8,
    flexDirection: 'row',
    gap: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  status: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 8,
  },
  center: { paddingVertical: 32, alignItems: 'center', justifyContent: 'center' },
  row: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 8 },
  rowMain: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, minHeight: MIN_TAP },
  rowActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' },
  reviewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  familyRow: {
    minHeight: MIN_TAP,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  bar: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
    borderWidth: 1,
  },
  barActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
    maxWidth: '100%',
  },
});
