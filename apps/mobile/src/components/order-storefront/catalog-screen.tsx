import { type Href, useFocusEffect, useIsFocused, useRouter } from 'expo-router';
import { ArrowLeft, ChevronRight, SlidersHorizontal } from 'lucide-react-native';
import * as React from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
  type ListRenderItemInfo,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  AVAILABILITY_LABELS,
  CART_ALL_STOCK_IN_CART_COPY,
  CART_CHECK_OUT_COPY,
  CART_TITLE_COPY,
  FREQUENTLY_ORDERED_SUBTITLE_COPY,
  FREQUENTLY_ORDERED_TITLE_COPY,
  KIT_ADD_COPY,
  KITS_ROW_SUB_COPY,
  KITS_TITLE_COPY,
  STOREFRONT_ADD_COPY,
  STOREFRONT_ALL_ITEMS_COPY,
  STOREFRONT_BROWSE_CATEGORIES_COPY,
  STOREFRONT_CLEAR_FILTERS_COPY,
  STOREFRONT_CLEAR_SEARCH_AND_FILTERS_COPY,
  STOREFRONT_NO_WAREHOUSES_COPY,
  STOREFRONT_NOTHING_MATCHES_HINT_COPY,
  STOREFRONT_NOTHING_ORDERABLE_COPY,
  STOREFRONT_OFFLINE_COPY,
  STOREFRONT_SEARCH_LABEL_COPY,
  STOREFRONT_SEARCH_PLACEHOLDER_COPY,
  STOREFRONT_SHIP_FROM_COPY,
  STOREFRONT_SHIP_FROM_LOCKED_COPY,
  STOREFRONT_SORT_AND_FILTER_COPY,
  STOREFRONT_TITLE_COPY,
  STOREFRONT_TRUNCATED_COPY,
  availableOf,
  buildQtyMap,
  kitAvailability,
  kitsInCart,
  kitsLoadFailedCopy,
  maxKits,
  orderItemRefusalCopy,
  storefrontItemCountCopy,
  storefrontNothingMatchesCopy,
  storefrontSeeAllCopy,
  storefrontUpdatedAtCopy,
  type KitOffer,
  type StorefrontItem,
} from '@stockpilot/core';

import { IconChip } from '@/components/ui/row';
import { Body, Display, Eyebrow, Mono } from '@/components/ui/text';
import {
  addBlockedHint,
  addItemLabel,
  addedAnnouncement,
  changeLockedHint,
  kitAddBlockedHint,
  decreaseLabel,
  filterChipLabel,
  increaseBlockedHint,
  increaseLabel,
  kitAnnouncement,
  lineChangeAnnouncement,
  quantityAnnouncement,
  quantityButtonLabel,
  sortChipLabel,
} from '@/lib/order-storefront/a11y';
import { itemNameFrom } from '@/lib/order-storefront/checkout';
import { MIN_TAP, STOREFRONT_GUTTER, catalogTitleInList, storefrontLayout } from '@/lib/order-storefront/layout';
import { storefrontOutcome } from '@/lib/order-storefront/outcome';
import { storefrontSession, useOffline, useStorefront, useStorefrontScope } from '@/lib/order-storefront/runtime';
import {
  EMPTY_FILTER,
  activeFilterCount,
  aisleCategory,
  availabilityCounts,
  browseHref,
  browseTitle,
  filterActive,
  frequentRows,
  homeRows,
  matchingRows,
  phoneSortOptions,
  storefrontRowKey,
  toggleAvailability,
  type BrowseTarget,
  type CatalogView,
  type StorefrontFilter,
  type StorefrontRow,
} from '@/lib/order-storefront/sections';
import { clockLabel } from '@/lib/order-storefront/setup';
import { placedOnStorefrontFocus } from '@/lib/order-storefront/success';
import { FONT, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

import { CartBar, CartPanel } from './cart-panel';
import { SetupRow, SmallAction, Stepper } from './controls';
import { ItemRow } from './item-row';
import { KitRow } from './kit-row';
import { KitDetailsSheet, QuantitySheet, QuickViewSheet, SortFilterSheet, WarehouseSheet } from './sheets';
import { StorefrontSheet } from './storefront-sheet';
import { StorefrontState } from './storefront-state';
import { UnconfirmedPanel } from './unconfirmed-panel';

type OpenSheet =
  | { kind: 'cart' }
  | { kind: 'quantity'; itemId: string }
  | { kind: 'quick'; itemId: string }
  | { kind: 'kit'; bundleId: string }
  | { kind: 'sort' }
  | { kind: 'warehouse' }
  | null;

/**
 * THE STOREFRONT'S CATALOG (phone ordering PO-4): the home (app/order/new)
 * and a browse view (app/order/new/browse) are this one screen. The home
 * lists Frequently ordered, Kits and the categories; anything typed in the
 * pinned search (never focused on open) or any filter lists the matching
 * items, searched on the phone over every row (lib/order-storefront/
 * sections.ts). ONE virtualized FlatList with build #23's settings, a
 * module-scope key extractor, memoized rows with stable id-taking callbacks,
 * and the quantity passed as a scalar from a Map. On a phone the cart is a
 * bar at the bottom and a sheet; on an iPad wide enough (and not at an
 * accessibility text size) it is a 360 pt column (layout.ts).
 */
export function CatalogScreen({ target }: { target: BrowseTarget | null }) {
  useStorefrontScope();
  const snap = useStorefront();
  const session = storefrontSession();
  const offline = useOffline();
  const router = useRouter();
  const { c } = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const layout = storefrontLayout({ width, fontScale });
  const [filter, setFilter] = React.useState<StorefrontFilter>(EMPTY_FILTER);
  // The search box is uncontrolled (a busy JS thread never drops a keystroke
  // from it), and the rows follow a deferred copy of what is typed, so typing
  // stays ahead of the filtering.
  const searchRef = React.useRef<TextInput | null>(null);
  const deferredSearch = React.useDeferredValue(filter.search);
  const shownFilter = React.useMemo(() => ({ ...filter, search: deferredSearch }), [filter, deferredSearch]);
  const clearAll = React.useCallback(() => {
    searchRef.current?.clear();
    setFilter(EMPTY_FILTER);
  }, []);
  const [sheet, setSheet] = React.useState<OpenSheet>(null);
  const [refreshing, setRefreshing] = React.useState(false);

  useFocusEffect(
    React.useCallback(() => {
      void session.focus();
      // Leaving this screen: what it said has been read (a placed order and
      // the lock itself are never dismissed here).
      return () => session.dismissOutcome();
    }, [session]),
  );

  // An order this storefront's key turned out to have placed (a status read
  // on its own, or "Don't send it" finding it placed): the success screen,
  // once. One the success screen already showed is cleared here instead
  // (the person left it by View order and on; desk check F10).
  const focused = useIsFocused();
  const placedId = snap?.placed?.order.id ?? null;
  React.useEffect(() => {
    if (!placedId || !focused) return;
    const next = placedOnStorefrontFocus(session.getSnapshot().placed);
    if (next === 'show') router.push('/order/new/placed' as Href);
    else if (next === 'finish') session.finishPlaced();
  }, [placedId, focused, router, session]);

  // How a send ended, or a change refused, is said here too: a send can end
  // away from checkout (Don't send it on this screen's panel, a status read
  // on open or on focus, the turned-off screen's panel). Announced while this
  // screen is the one shown (iOS gives a Text no live region).
  const outcomeItemName = React.useMemo(() => itemNameFrom(snap?.itemMap ?? new Map()), [snap?.itemMap]);
  const outcomeWarehouse =
    snap?.setup.status === 'ready' ? (snap.setup.answer.warehouses.find((w) => w.id === snap.warehouseId)?.name ?? null) : null;
  const outcome = snap ? storefrontOutcome(snap, { itemName: outcomeItemName, warehouseName: outcomeWarehouse }) : null;
  const outcomeText = outcome?.text ?? null;
  React.useEffect(() => {
    if (outcomeText && focused) AccessibilityInfo.announceForAccessibility(outcomeText);
  }, [outcomeText, focused]);
  // The one notice (a restored cart checked against the fresh catalog), said
  // while this screen is in view (PO-4 review).
  const noticeText = snap?.notice ?? null;
  React.useEffect(() => {
    if (noticeText && focused) AccessibilityInfo.announceForAccessibility(noticeText);
  }, [noticeText, focused]);

  const say = React.useCallback((message: string) => AccessibilityInfo.announceForAccessibility(message), []);

  // Stable, id-taking callbacks for the memoized rows.
  const onAdd = React.useCallback(
    (itemId: string) => {
      const refused = session.dispatch({ type: 'add', itemId, quantity: 1 });
      if (refused) return;
      const s = session.getSnapshot();
      const name = s.itemMap.get(itemId)?.name ?? '';
      say(addedAnnouncement(name, s.cart?.lines.find((l) => l.itemId === itemId)?.quantity ?? 1));
    },
    [session, say],
  );
  const onInc = React.useCallback(
    (itemId: string) => {
      const s = session.getSnapshot();
      const item = s.itemMap.get(itemId);
      const qty = s.cart?.lines.find((l) => l.itemId === itemId)?.quantity ?? 0;
      if (!item || qty >= availableOf(item)) return;
      if (session.dispatch({ type: 'inc', itemId })) return;
      say(quantityAnnouncement(item.name, qty + 1));
    },
    [session, say],
  );
  const onDec = React.useCallback(
    (itemId: string) => {
      const s = session.getSnapshot();
      const qty = s.cart?.lines.find((l) => l.itemId === itemId)?.quantity ?? 0;
      if (session.dispatch({ type: 'dec', itemId })) return;
      say(quantityAnnouncement(s.itemMap.get(itemId)?.name ?? '', Math.max(0, qty - 1)));
    },
    [session, say],
  );
  const onQuantity = React.useCallback((itemId: string) => setSheet({ kind: 'quantity', itemId }), []);
  const onOpen = React.useCallback((itemId: string) => setSheet({ kind: 'quick', itemId }), []);
  const onPhotoError = React.useCallback(() => session.photoFailed(), [session]);
  const onKit = React.useCallback(
    (bundleId: string, next: number) => {
      const refused = session.changeKit(bundleId, next);
      if (refused) return;
      const s = session.getSnapshot();
      const kit = s.kits?.find((k) => k.bundleId === bundleId);
      if (kit && s.cart) say(kitAnnouncement(kit.name, kitsInCart(kit, s.cart.kits[bundleId], buildQtyMap(s.cart.lines))));
    },
    [session, say],
  );
  const onKitDetails = React.useCallback((bundleId: string) => setSheet({ kind: 'kit', bundleId }), []);

  const qtyMap = React.useMemo(() => buildQtyMap(snap?.cart?.lines ?? []), [snap?.cart?.lines]);
  const answer = snap?.catalog.answer ?? null;
  const prepared = snap?.prepared;
  const catalogItemMap = snap?.itemMap;
  const kits = snap?.kits ?? null;
  const kitsEnabled = snap?.setup.status === 'ready' && snap.setup.answer.kitsEnabled;
  // Rebuilt only when the catalog itself changes, never on a cart change.
  const view: CatalogView | null = React.useMemo(
    () =>
      prepared && catalogItemMap && answer
        ? {
            prepared,
            itemMap: catalogItemMap,
            aisles: answer.aisles,
            frequent: answer.frequentlyOrdered.status === 'ok' ? answer.frequentlyOrdered.items : null,
            kits,
            kitsEnabled,
          }
        : null,
    [prepared, catalogItemMap, answer, kits, kitsEnabled],
  );

  const rows: StorefrontRow[] = React.useMemo(() => {
    if (!view) return [];
    if (target === null && !filterActive(shownFilter)) {
      return homeRows(view, {
        frequentTitle: FREQUENTLY_ORDERED_TITLE_COPY,
        frequentSubtitle: FREQUENTLY_ORDERED_SUBTITLE_COPY,
        kitsTitle: KITS_TITLE_COPY,
        kitsSubtitle: KITS_ROW_SUB_COPY,
        kitsFailed: kitsLoadFailedCopy('phone'),
        categoriesTitle: STOREFRONT_BROWSE_CATEGORIES_COPY,
        nothingOrderable: STOREFRONT_NOTHING_ORDERABLE_COPY,
      });
    }
    return matchingRows(view, target ?? { kind: 'all' }, shownFilter);
  }, [view, target, shownFilter]);

  const locked = snap?.locked ?? false;
  const photos = snap?.photos;
  const notOrderable = snap?.notOrderable;
  const refusals = snap?.refusals;
  // Why the server refused an item, in core's words (PO-4 review).
  const refusalFor = React.useCallback(
    (item: StorefrontItem): string | null => {
      const reason = refusals?.get(item.id);
      return reason ? orderItemRefusalCopy(reason, item.name) : null;
    },
    [refusals],
  );
  const cartKits = snap?.cart?.kits;
  const itemMap = snap?.itemMap;

  const renderRow = React.useCallback(
    ({ item: row }: ListRenderItemInfo<StorefrontRow>) => {
      switch (row.kind) {
        case 'header':
          return (
            <View style={{ paddingTop: 10, gap: 2 }}>
              <Eyebrow accessibilityRole="header">{row.title}</Eyebrow>
              {row.subtitle ? (
                <Body size={12.5} color={c.ink3}>
                  {row.subtitle}
                </Body>
              ) : null}
            </View>
          );
        case 'item':
          return (
            <ItemRow
              item={row.item}
              quantity={qtyMap.get(row.item.id) ?? 0}
              photoUrl={photos?.[row.item.id] ?? null}
              rank={row.rank}
              notOrderable={notOrderable?.has(row.item.id) ?? false}
              refusal={refusalFor(row.item)}
              locked={locked}
              onOpen={onOpen}
              onAdd={onAdd}
              onInc={onInc}
              onDec={onDec}
              onQuantity={onQuantity}
              onPhotoError={onPhotoError}
            />
          );
        case 'kit':
          return itemMap ? (
            <KitRow
              kit={row.kit}
              itemMap={itemMap}
              inCart={kitsInCart(row.kit, cartKits?.[row.kit.bundleId], qtyMap)}
              maxInCart={maxKits(row.kit, itemMap, cartKits?.[row.kit.bundleId], qtyMap)}
              locked={locked}
              onChange={onKit}
              onDetails={onKitDetails}
            />
          ) : null;
        case 'category':
          return (
            <LinkRow
              title={row.aisle.name}
              detail={storefrontItemCountCopy(row.aisle.itemCount)}
              onPress={() => router.push(browseHref({ kind: 'category', category: aisleCategory(row.aisle) }) as Href)}
            />
          );
        case 'all-items':
          return (
            <LinkRow
              title={STOREFRONT_ALL_ITEMS_COPY}
              detail={storefrontItemCountCopy(row.count)}
              onPress={() => router.push(browseHref({ kind: 'all' }) as Href)}
            />
          );
        case 'see-all':
          return (
            <LinkRow title={storefrontSeeAllCopy(row.count)} onPress={() => router.push(browseHref(row.target) as Href)} />
          );
        case 'note':
          return (
            <Body size={13.5} color={c.ink3}>
              {row.text}
            </Body>
          );
        case 'empty':
          return (
            <View style={{ gap: 8, paddingTop: 12 }}>
              <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>
                {storefrontNothingMatchesCopy(shownFilter.search.trim())}
              </Body>
              <Body size={13} color={c.ink3}>
                {STOREFRONT_NOTHING_MATCHES_HINT_COPY}
              </Body>
              <SmallAction label={STOREFRONT_CLEAR_SEARCH_AND_FILTERS_COPY} onPress={clearAll} />
            </View>
          );
      }
    },
    [c, qtyMap, photos, notOrderable, refusalFor, locked, cartKits, itemMap, onOpen, onAdd, onInc, onDec, onQuantity, onPhotoError, onKit, onKitDetails, router, shownFilter.search, clearAll],
  );

  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/orders' as Href);
  };

  async function refresh() {
    setRefreshing(true);
    try {
      await session.refresh();
    } finally {
      setRefreshing(false);
    }
  }

  const title =
    target === null
      ? STOREFRONT_TITLE_COPY
      : browseTitle(target, answer?.aisles ?? [], {
          frequent: FREQUENTLY_ORDERED_TITLE_COPY,
          kits: KITS_TITLE_COPY,
          all: STOREFRONT_ALL_ITEMS_COPY,
        });

  const topBar = (
    <View style={styles.topbar}>
      <IconChip icon={ArrowLeft} onPress={leave} accessibilityLabel="Back" minTap />
    </View>
  );
  // Past the row threshold the title scrolls with the list, so the search and
  // the keyboard leave room for results (F8.4, PO-4 review).
  const titleInList = catalogTitleInList(fontScale);
  const titleNode = (
    <Display size={30} accessibilityRole="header">
      {title}
    </Display>
  );

  if (!snap || snap.setup.status !== 'ready') {
    return (
      <StorefrontState
        topBar={topBar}
        title={STOREFRONT_TITLE_COPY}
        setup={snap && snap.setup.status !== 'ready' ? snap.setup : { status: 'loading' }}
        refreshing={refreshing}
        onRefresh={() => void refresh()}
        outcome={outcome}
        panel={
          snap ? (
            <UnconfirmedPanel
              state={snap.submission.state}
              busy={snap.submission.busy}
              offline={offline}
              warehouseName={null}
              itemName={() => null}
              onCheckAndFinish={() => void session.checkAndFinish()}
              onDontSend={() => void session.dontSend()}
              onSeeOrders={() => router.push('/orders' as Href)}
            />
          ) : null
        }
      />
    );
  }

  const ready = snap.setup.answer;
  const warehouse = ready.warehouses.find((w) => w.id === snap.warehouseId) ?? null;
  const cart = snap.cart;
  const sortOptions = phoneSortOptions(answer?.frequentlyOrdered.status === 'ok');
  const usuals: StorefrontItem[] = view ? frequentRows(view).slice(0, 3).map((f) => f.item) : [];
  const itemName = itemNameFrom(snap.itemMap);

  const header = (
    <View style={{ gap: 12, paddingBottom: 8 }}>
      {titleInList ? titleNode : null}
      {target === null ? (
        // One warehouse and nothing locked: a row that shows it, not a
        // dimmed button with no reason (PO-4 review).
        <SetupRow
          label={STOREFRONT_SHIP_FROM_COPY}
          value={warehouse?.name ?? '—'}
          hint={locked ? STOREFRONT_SHIP_FROM_LOCKED_COPY : undefined}
          onPress={ready.warehouses.length < 2 && !locked ? undefined : () => setSheet({ kind: 'warehouse' })}
        />
      ) : null}
      <UnconfirmedPanel
        state={snap.submission.state}
        busy={snap.submission.busy}
        offline={offline}
        warehouseName={warehouse?.name ?? null}
        itemName={itemName}
        onCheckAndFinish={() => void session.checkAndFinish()}
        onDontSend={() => void session.dontSend()}
        onSeeOrders={() => router.push('/orders' as Href)}
      />
      {outcome ? (
        <Body size={13.5} color={outcome.tone === 'calm' ? c.ink : c.critText} accessibilityRole="alert">
          {outcome.text}
        </Body>
      ) : null}
      {snap.notice ? (
        <Body size={13.5} color={c.warnText} accessibilityRole="alert">
          {snap.notice}
        </Body>
      ) : null}
      {offline ? (
        <Body size={13} color={c.ink3}>
          {STOREFRONT_OFFLINE_COPY}
        </Body>
      ) : null}
      {snap.catalog.readAt !== null && (offline || snap.catalog.fromDevice) ? (
        <Mono size={11.5} color={c.ink3}>
          {storefrontUpdatedAtCopy(clockLabel(snap.catalog.readAt))}
        </Mono>
      ) : null}
      {snap.catalog.status === 'loading' && !answer ? <ActivityIndicator color={c.ink} /> : null}
      {snap.catalog.message ? (
        <Body size={13} color={c.warnText}>
          {snap.catalog.message}
        </Body>
      ) : null}
      {answer?.truncated ? (
        <Body size={13} color={c.warnText}>
          {STOREFRONT_TRUNCATED_COPY}
        </Body>
      ) : null}
      {ready.warehouses.length === 0 ? (
        <Body size={14} color={c.ink3}>
          {STOREFRONT_NO_WAREHOUSES_COPY}
        </Body>
      ) : null}
    </View>
  );

  const searchBar = (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <TextInput
          ref={searchRef}
          onChangeText={(text) => setFilter((f) => ({ ...f, search: text }))}
          placeholder={STOREFRONT_SEARCH_PLACEHOLDER_COPY}
          placeholderTextColor={c.ink4}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          clearButtonMode="while-editing"
          accessibilityLabel={STOREFRONT_SEARCH_LABEL_COPY}
          maxFontSizeMultiplier={INPUT_CAP}
          style={[styles.search, { borderColor: c.hair, backgroundColor: c.card, color: c.ink }]}
        />
        <Pressable
          onPress={() => setSheet({ kind: 'sort' })}
          accessibilityRole="button"
          accessibilityLabel={
            activeFilterCount(filter) > 0
              ? `${STOREFRONT_SORT_AND_FILTER_COPY}, ${activeFilterCount(filter)} on`
              : STOREFRONT_SORT_AND_FILTER_COPY
          }
          style={[styles.filterButton, { borderColor: c.hair, backgroundColor: c.card }]}
        >
          <SlidersHorizontal size={18} color={c.ink} strokeWidth={1.5} />
        </Pressable>
      </View>
      {activeFilterCount(filter) > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {[...filter.availability].map((s) => (
            <SmallAction
              key={s}
              label={AVAILABILITY_LABELS[s]}
              accessibilityLabel={filterChipLabel(AVAILABILITY_LABELS[s])}
              onPress={() => setFilter((f) => toggleAvailability(f, s))}
            />
          ))}
          {filter.sort !== EMPTY_FILTER.sort ? (
            <SmallAction
              label={sortOptions.find((o) => o.id === filter.sort)?.label ?? ''}
              accessibilityLabel={sortChipLabel(sortOptions.find((o) => o.id === filter.sort)?.label ?? '')}
              onPress={() => setFilter((f) => ({ ...f, sort: EMPTY_FILTER.sort }))}
            />
          ) : null}
          <SmallAction
            label={STOREFRONT_CLEAR_FILTERS_COPY}
            variant="ghost"
            onPress={() => setFilter((f) => ({ ...EMPTY_FILTER, search: f.search }))}
          />
        </View>
      ) : null}
    </View>
  );

  const list = (
    <FlatList
      data={rows}
      keyExtractor={storefrontRowKey}
      renderItem={renderRow}
      ListHeaderComponent={header}
      initialNumToRender={12}
      maxToRenderPerBatch={8}
      windowSize={9}
      removeClippedSubviews={Platform.OS === 'android'}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingHorizontal: STOREFRONT_GUTTER, paddingBottom: 24, gap: 10 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={c.ink} />}
    />
  );

  const checkOut = () => router.push('/order/new/checkout' as Href);
  /** The stock allows a kit, but the cart's own lines already hold every
   *  one it allows (Add kit is dimmed for that). */
  const kitFull = (kit: KitOffer) =>
    kitAvailability(kit, snap.itemMap).kits >= 1 &&
    maxKits(kit, snap.itemMap, cartKits?.[kit.bundleId], qtyMap) <= kitsInCart(kit, cartKits?.[kit.bundleId], qtyMap);
  const sheetItem = sheet && (sheet.kind === 'quantity' || sheet.kind === 'quick') ? snap.itemMap.get(sheet.itemId) : undefined;
  const sheetKit = sheet?.kind === 'kit' ? snap.kits?.find((k) => k.bundleId === sheet.bundleId) : undefined;
  const cartPanel = cart ? (
    <CartPanel
      cart={cart}
      itemMap={snap.itemMap}
      notOrderable={snap.notOrderable}
      refusals={snap.refusals}
      locked={locked}
      usuals={usuals}
      onInc={onInc}
      onDec={onDec}
      onQuantity={onQuantity}
      onRemove={(itemId) => {
        if (session.dispatch({ type: 'remove', itemId }) !== null) return;
        const said = lineChangeAnnouncement(session.getSnapshot(), itemId);
        if (said) say(said);
      }}
      onAdd={onAdd}
      onClear={() => session.dispatch({ type: 'clear' })}
    />
  ) : null;

  return (
    <View style={{ flex: 1, backgroundColor: c.paper }}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        {topBar}
        <View style={{ paddingHorizontal: STOREFRONT_GUTTER, paddingBottom: 10, gap: 12 }}>
          {titleInList ? null : titleNode}
          {searchBar}
        </View>
      </SafeAreaView>
      {layout.kind === 'split' ? (
        <View style={{ flex: 1, flexDirection: 'row' }}>
          <View style={{ flex: 1, minWidth: 0 }}>{list}</View>
          <View style={[styles.cartColumn, { width: layout.cartColumnWidth, borderColor: c.hair, backgroundColor: c.card }]}>
            <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>{cartPanel}</ScrollView>
            {cart && cart.lines.length > 0 ? (
              <SafeAreaView edges={['bottom']} style={{ padding: 16 }}>
                <SmallAction label={CART_CHECK_OUT_COPY} variant="primary" onPress={checkOut} />
              </SafeAreaView>
            ) : null}
          </View>
        </View>
      ) : (
        <>
          <View style={{ flex: 1 }}>{list}</View>
          {cart ? (
            <SafeAreaView edges={['bottom']} style={{ backgroundColor: c.card }}>
              <CartBar cart={cart} onOpenCart={() => setSheet({ kind: 'cart' })} onCheckOut={checkOut} />
            </SafeAreaView>
          ) : null}
        </>
      )}

      {sheet?.kind === 'cart' && cartPanel ? (
        <StorefrontSheet
          visible
          title={CART_TITLE_COPY}
          onClose={() => setSheet(null)}
          footer={
            cart && cart.lines.length > 0 ? (
              <SmallAction
                label={CART_CHECK_OUT_COPY}
                variant="primary"
                onPress={() => {
                  setSheet(null);
                  checkOut();
                }}
              />
            ) : null
          }
        >
          {cartPanel}
        </StorefrontSheet>
      ) : null}
      {sheet?.kind === 'quantity' && sheetItem ? (
        <QuantitySheet
          item={sheetItem}
          quantity={qtyMap.get(sheetItem.id) ?? 0}
          onClose={() => setSheet(null)}
          onSave={(value) => {
            const refused = session.setQuantity(sheetItem.id, value);
            setSheet(null);
            if (!refused) say(quantityAnnouncement(sheetItem.name, value));
          }}
        />
      ) : null}
      {sheet?.kind === 'quick' && sheetItem ? (
        <QuickViewSheet
          item={sheetItem}
          photoUrl={snap.photos[sheetItem.id] ?? null}
          inCart={qtyMap.get(sheetItem.id) ?? 0}
          onClose={() => setSheet(null)}
          onPhotoError={onPhotoError}
          control={
            (qtyMap.get(sheetItem.id) ?? 0) > 0 ? (
              <Stepper
                quantity={qtyMap.get(sheetItem.id) ?? 0}
                available={availableOf(sheetItem)}
                atMax={(qtyMap.get(sheetItem.id) ?? 0) >= availableOf(sheetItem)}
                disabled={locked}
                decLabel={decreaseLabel(sheetItem.name, qtyMap.get(sheetItem.id) ?? 0)}
                incLabel={increaseLabel(sheetItem.name)}
                countLabel={quantityButtonLabel(sheetItem.name, qtyMap.get(sheetItem.id) ?? 0)}
                incHint={increaseBlockedHint((qtyMap.get(sheetItem.id) ?? 0) >= availableOf(sheetItem))}
                lockHint={changeLockedHint(locked)}
                onDec={() => onDec(sheetItem.id)}
                onInc={() => onInc(sheetItem.id)}
                onCount={() => setSheet({ kind: 'quantity', itemId: sheetItem.id })}
              />
            ) : (
              <SmallAction
                label={STOREFRONT_ADD_COPY}
                accessibilityLabel={addItemLabel(sheetItem.name)}
                variant="primary"
                disabled={locked || availableOf(sheetItem) < 1 || snap.notOrderable.has(sheetItem.id)}
                hint={addBlockedHint({ locked, notOrderable: snap.notOrderable.has(sheetItem.id) })}
                onPress={() => onAdd(sheetItem.id)}
              />
            )
          }
        />
      ) : null}
      {sheet?.kind === 'kit' && sheetKit ? (
        <KitDetailsSheet
          kit={sheetKit}
          itemMap={snap.itemMap}
          onClose={() => setSheet(null)}
          control={
            <View style={{ gap: 8 }}>
              {/* Every kit the stock allows is already in the cart: said on
                  screen, not only in the hint (PO-4 review). */}
              {kitFull(sheetKit) ? (
                <Body size={12.5} color={c.ink3}>
                  {CART_ALL_STOCK_IN_CART_COPY}
                </Body>
              ) : null}
              <SmallAction
                label={KIT_ADD_COPY}
                variant="primary"
                hint={kitAddBlockedHint({ locked, out: kitAvailability(sheetKit, snap.itemMap).kits < 1, full: maxKits(sheetKit, snap.itemMap, cartKits?.[sheetKit.bundleId], qtyMap) <= kitsInCart(sheetKit, cartKits?.[sheetKit.bundleId], qtyMap) })}
                disabled={locked || maxKits(sheetKit, snap.itemMap, cartKits?.[sheetKit.bundleId], qtyMap) <= kitsInCart(sheetKit, cartKits?.[sheetKit.bundleId], qtyMap)}
                onPress={() => onKit(sheetKit.bundleId, kitsInCart(sheetKit, cartKits?.[sheetKit.bundleId], qtyMap) + 1)}
              />
            </View>
          }
        />
      ) : null}
      {sheet?.kind === 'sort' && view ? (
        <SortFilterSheet
          sort={filter.sort}
          sortOptions={sortOptions}
          availability={filter.availability}
          counts={availabilityCounts(view, target ?? { kind: 'all' }, shownFilter.search)}
          onSort={(sort) => setFilter((f) => ({ ...f, sort }))}
          onToggle={(s) => setFilter((f) => toggleAvailability(f, s))}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet?.kind === 'warehouse' ? (
        <WarehouseSheet
          warehouses={ready.warehouses}
          current={snap.warehouseId}
          onClose={() => setSheet(null)}
          onPick={(id) => {
            setSheet(null);
            void session.selectWarehouse(id);
          }}
        />
      ) : null}
    </View>
  );
}

/** A row that opens a browse view: a category, All items, See all. */
function LinkRow({ title, detail, onPress }: { title: string; detail?: string; onPress: () => void }) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={detail ? `${title}, ${detail}` : title}
      style={({ pressed }) => [styles.link, { borderColor: c.hair, backgroundColor: c.card, opacity: pressed ? 0.85 : 1 }]}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Body size={15} color={c.ink}>
          {title}
        </Body>
        {detail ? (
          <Mono size={11.5} color={c.ink3}>
            {detail}
          </Mono>
        ) : null}
      </View>
      <ChevronRight size={16} color={c.ink4} strokeWidth={1.5} />
    </Pressable>
  );
}

/** The search box stops growing at the input ceiling (a bordered box). */
const INPUT_CAP = capTo(15, TYPE_CEILING.input);

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
    alignItems: 'center',
    justifyContent: 'center',
  },
  link: {
    minHeight: MIN_TAP,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  cartColumn: { borderLeftWidth: 1 },
});
