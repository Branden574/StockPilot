import {
  ORDER_NEEDS_CONNECTION_COPY,
  STOREFRONT_CART_LOCKED_COPY,
  STOREFRONT_SHIP_FROM_LOCKED_COPY,
  buildQtyMap,
  cartReducer,
  clampQty,
  availableOf,
  componentItem,
  initialCartState,
  kitNotEnoughCopy,
  mintOrderSubmissionKey,
  orderSubmissionLocked,
  pendingOrderSubmissionOf,
  planKitChange,
  prepareCatalog,
  type CartAction,
  type CartState,
  type KitOffer,
  type OrderCatalogAnswer,
  type OrderCreateRequestInput,
  type OrderStorefrontAnswer,
  type OrderSubmissionState,
  type OrderSummary,
  type PreparedCatalog,
  type StorefrontItem,
} from '@stockpilot/core';

import {
  storefrontReadFailure,
  type OrderCallScope,
  type OrderStorefrontApi,
} from './api';
import {
  buildOrderCreateBody,
  linesNotInCatalog,
  recheckRestoredCart,
  refusedItemIds,
  stockChangedNotice,
  submitBlockedBy,
} from './checkout';
import { catalogIsStale, catalogItems, initialShipFrom, photosNeedRefresh } from './setup';
import {
  LEAVE_DRAFT,
  createDraftWriter,
  isEmptyDraft,
  orderCatalogKey,
  orderDraftKey,
  orderPhotosKey,
  orderPrefsKey,
  parseOrderPrefs,
  parseStoredCatalog,
  parseStoredOrderDraft,
  parseStoredPhotos,
  restoredDraft,
  serializeCatalog,
  serializeOrderDraft,
  serializeOrderPrefs,
  serializePhotos,
  storedLiveKey,
  unsettledSubmissions,
  type DraftScope,
  type DraftWriter,
  type KeyValueStore,
} from './store';
import { createSubmitEngine, type SubmitEngine, type SubmitEngineSnapshot } from './submit';

/**
 * ONE ACCOUNT'S STOREFRONT IN ONE ORGANIZATION (phone ordering PO-4): what
 * the four storefront screens (home, browse, checkout, placed) share, kept
 * outside React so a screen change never loses it and every rule is tested
 * here with fakes (session.test.ts). The app wires it to api(), AsyncStorage
 * and the account epoch (runtime.ts), and the screens read it with
 * useSyncExternalStore.
 *
 * What it holds: the storefront answer (read once on open), Ship from, the
 * catalog of that warehouse (shown from the device at once, then read
 * fresh), its photo map, the cart and the submission engine of that
 * warehouse (each warehouse keeps its own cart, saved under its own key).
 *
 * The rules it keeps (plan 3.4, 3.6, PO-4):
 *   - a locked cart (a send not settled) refuses every change, the warehouse
 *     switch and Clear included, with core's words;
 *   - every call names the organization and the account (api.ts);
 *   - an answer for another organization is dropped; a scope change (another
 *     account or organization) starts over and nothing of the old one shows;
 *   - a restored unlocked cart is checked against the fresh catalog and one
 *     sentence says what changed; a restored LOCKED cart is never changed, it
 *     is settled first (its status is read on its own, never resent);
 *   - nothing about an order is queued offline: Submit needs a connection;
 *   - EVERY WRITE IS BOUND TO THE ORGANIZATION, ACCOUNT AND WAREHOUSE IT WAS
 *     MADE FOR (desk check F1). An engine writes only while it is the one
 *     shown: an answer that lands after a workspace switch writes nothing,
 *     so its key keeps the record written before the send (its own cart and
 *     key), which that organization's next open settles by the key (a
 *     status read, never a resend). The shown engine's writes are
 *     compare-and-set: a live key only over no live key or its own, a
 *     settled key's record only over its own. A debounced save carries the
 *     scope, the cart and the engine it was made for, never what is shown
 *     when it fires.
 */

export interface SessionStore extends KeyValueStore {
  getAllKeys(): Promise<readonly string[]>;
  multiGet(keys: readonly string[]): Promise<readonly (readonly [string, string | null])[]>;
}

export interface SessionDeps {
  api: OrderStorefrontApi;
  store: SessionStore;
  epoch(): number;
  now(): number;
  mintKey?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface SessionScope {
  userId: string;
  orgId: string;
  /** The workspace's active warehouse (a Ship from default). */
  activeWarehouseId: string | null;
}

export type SetupState =
  | { status: 'loading' }
  | { status: 'ready'; answer: Extract<OrderStorefrontAnswer, { enabled: true }> }
  /** The kill switch, or an old server: say it, offer nothing to submit. */
  | { status: 'off'; message: string }
  /** Refused (signed out, no permission, the module off). */
  | { status: 'refused'; message: string }
  /** No answer: pull to read it again. */
  | { status: 'failed'; message: string };

export interface CatalogState {
  status: 'idle' | 'loading' | 'ready' | 'failed';
  answer: OrderCatalogAnswer | null;
  /** When the answer shown was read (ms), null before any. */
  readAt: number | null;
  /** The answer shown came from the device, not this session's read. */
  fromDevice: boolean;
  /** Why the last read failed (the answer shown, if any, is older). */
  message: string | null;
  refreshing: boolean;
}

export interface PlacedContext {
  order: OrderSummary;
  replay: boolean;
  viaWithdraw: boolean;
  /** The body that placed it (null when an earlier build wrote a record this
   *  one cannot read: then no email draft is offered). */
  body: OrderCreateRequestInput | null;
}

export interface StorefrontSnapshot {
  scope: { userId: string; orgId: string } | null;
  setup: SetupState;
  warehouseId: string | null;
  catalog: CatalogState;
  items: readonly StorefrontItem[];
  itemMap: ReadonlyMap<string, StorefrontItem>;
  prepared: PreparedCatalog<StorefrontItem>;
  kits: readonly KitOffer[] | null;
  photos: Readonly<Record<string, string>>;
  /** null until the warehouse's draft has been read. */
  cart: CartState | null;
  submission: SubmitEngineSnapshot;
  locked: boolean;
  /** Lines that cannot be ordered from here: gone from the catalog, or
   *  refused by the server's item check. */
  notOrderable: ReadonlySet<string>;
  /** One sentence about a restored cart, or the stock that moved before
   *  checkout. Cleared by the next change to the cart. */
  notice: string | null;
  /** The last change the session refused (a locked cart, the warehouse
   *  switch), to say in place. */
  refusal: string | null;
  /** The order just placed, for the success screen. */
  placed: PlacedContext | null;
  /** Warehouses of this organization with a send not settled. */
  lockedWarehouseIds: readonly string[];
  /** The server's clock less this phone's, from the storefront answer's
   *  serverNow: the needed-by picker's "now" (a phone with a wrong clock
   *  never offers a past slot). 0 until read. */
  serverSkewMs: number;
}

const EMPTY_SUBMISSION: SubmitEngineSnapshot = {
  state: { phase: 'open' },
  busy: false,
  deviceError: null,
  sent: false,
};

const EMPTY_PREPARED = prepareCatalog<StorefrontItem>([]);

export interface StorefrontSession {
  getSnapshot(): StorefrontSnapshot;
  subscribe(listener: () => void): () => void;
  /** Open (or keep) the storefront for this account and organization. */
  open(scope: SessionScope): Promise<void>;
  /** Pull to refresh: the storefront, the catalog and the photos. */
  refresh(): Promise<void>;
  /** The screen came into focus, or the app came to the foreground, or the
   *  connection came back: read what is stale, and the status of a send that
   *  is not confirmed. Never sends. */
  focus(): Promise<void>;
  selectWarehouse(warehouseId: string): Promise<string | null>;
  /** A cart change. Returns core's refusal sentence while locked. */
  dispatch(action: CartAction): string | null;
  /** A typed quantity, clamped to what is available (0 removes the line). */
  setQuantity(itemId: string, value: number): string | null;
  /** A kit to `target` kits in the cart, all or nothing (core
   *  planKitChange); core's words when it does not fit. */
  changeKit(bundleId: string, target: number): string | null;
  /** Checkout opened: read the catalog again and say what moved. */
  openCheckout(): Promise<void>;
  /** Why Submit cannot be pressed (offline: true when not connected). */
  submitBlockedBy(offline: boolean): string | null;
  /** "Submit order request". */
  submit(offline: boolean): Promise<void>;
  checkAndFinish(): Promise<void>;
  dontSend(): Promise<void>;
  /** The refusal, withdrawn notice or device error is done with. */
  dismissOutcome(): void;
  /** Leaving the success screen ("Place another order", "Done"). */
  finishPlaced(): void;
  /** An item photo failed to load: read the map again (once). */
  photoFailed(): void;
  /** The account or organization ended: forget everything shown. */
  close(): void;
}

export function createStorefrontSession(deps: SessionDeps): StorefrontSession {
  const listeners = new Set<() => void>();
  let scope: SessionScope | null = null;
  let scopeGen = 0;
  let warehouseGen = 0;

  let setup: SetupState = { status: 'loading' };
  let warehouseId: string | null = null;
  let catalog: CatalogState = blankCatalog();
  let items: StorefrontItem[] = [];
  let itemMap: Map<string, StorefrontItem> = new Map();
  let prepared: PreparedCatalog<StorefrontItem> = EMPTY_PREPARED;
  let photos: { answer: { photos: Record<string, string>; signedAt: string; expiresAt: string } | null; failed: boolean } = {
    answer: null,
    failed: false,
  };
  let cart: CartState | null = null;
  let engine: SubmitEngine | null = null;
  let engineUnsub: (() => void) | null = null;
  let writer: DraftWriter | null = null;
  /** Every key the shown engine has held (sent or restored): the records it
   *  may replace once they are settled. */
  let engineKeys = new Set<string>();
  let refusedItems = new Set<string>();
  let restoredNotOrderable = new Set<string>();
  let recheckPending = false;
  let notice: string | null = null;
  let refusal: string | null = null;
  let placed: PlacedContext | null = null;
  let sentBody: OrderCreateRequestInput | null = null;
  let lockedWarehouseIds: string[] = [];
  let serverSkewMs = 0;
  let snapshot: StorefrontSnapshot = build();

  function blankCatalog(): CatalogState {
    return { status: 'idle', answer: null, readAt: null, fromDevice: false, message: null, refreshing: false };
  }

  function draftScope(): DraftScope | null {
    return scope && warehouseId ? { userId: scope.userId, orgId: scope.orgId, warehouseId } : null;
  }

  function callScope(): OrderCallScope | null {
    return scope ? { userId: scope.userId, orgId: scope.orgId } : null;
  }

  function build(): StorefrontSnapshot {
    const submission = engine?.getSnapshot() ?? EMPTY_SUBMISSION;
    const notOrderable = new Set<string>();
    if (cart && catalog.answer) for (const id of linesNotInCatalog(cart, itemMap)) notOrderable.add(id);
    for (const id of refusedItems) if (cart?.lines.some((l) => l.itemId === id)) notOrderable.add(id);
    for (const id of restoredNotOrderable) if (cart?.lines.some((l) => l.itemId === id)) notOrderable.add(id);
    const kitsPart = catalog.answer?.kits;
    return {
      scope: scope ? { userId: scope.userId, orgId: scope.orgId } : null,
      setup,
      warehouseId,
      catalog,
      items,
      itemMap,
      prepared,
      kits: kitsPart ? (kitsPart.status === 'ok' ? kitsPart.kits : null) : [],
      photos: photos.answer?.photos ?? {},
      cart,
      submission,
      locked: orderSubmissionLocked(submission.state),
      notOrderable,
      notice,
      refusal,
      placed,
      lockedWarehouseIds,
      serverSkewMs,
    };
  }

  function publish() {
    snapshot = build();
    for (const l of listeners) l();
  }

  function setCatalogAnswer(answer: OrderCatalogAnswer, readAt: number, fromDevice: boolean) {
    const before = itemMap;
    items = catalogItems(answer);
    itemMap = new Map(items.map((i) => [i.id, i]));
    prepared = prepareCatalog(items);
    catalog = { status: 'ready', answer, readAt, fromDevice, message: null, refreshing: false };
    if (recheckPending && cart && !engineLocked()) {
      recheckPending = false;
      const r = recheckRestoredCart(cart, itemMap);
      cart = r.cart;
      restoredNotOrderable = r.notOrderable;
      notice = r.notice;
    }
    return before;
  }

  function engineLocked(): boolean {
    return engine ? orderSubmissionLocked(engine.getSnapshot().state) : false;
  }

  /** The cart's save, 250 ms after the last change. It is bound now to this
   *  warehouse's key, this cart and this engine (a switch before it fires
   *  never puts another cart under this key), and it never replaces a live
   *  key's record: a locked cart is written by its engine only. */
  function saveCart() {
    const ds = draftScope();
    const w = writer;
    const e = engine;
    const keys = engineKeys;
    const saved = cart;
    if (!ds || !w || !saved) return;
    w.schedule((stored) => {
      if (e && orderSubmissionLocked(e.getSnapshot().state)) return LEAVE_DRAFT;
      const held = storedLiveKey(stored, ds);
      if (held !== null && !keys.has(held)) return LEAVE_DRAFT;
      const draft = { cart: saved, submission: null };
      return isEmptyDraft(draft) ? null : serializeOrderDraft(ds, draft, new Date(deps.now()));
    });
  }

  async function refreshLocked() {
    const s = scope;
    if (!s) return;
    const gen = scopeGen;
    try {
      const keys = (await deps.store.getAllKeys()).filter((k) =>
        k.startsWith(`workspace.orderDraft.v1.${s.userId}.${s.orgId}.`),
      );
      const entries = keys.length > 0 ? await deps.store.multiGet(keys) : [];
      if (gen !== scopeGen) return;
      lockedWarehouseIds = unsettledSubmissions(entries, s.userId, s.orgId).map((u) => u.warehouseId);
    } catch {
      // Unknown: keep what was known.
    }
  }

  function attachEngine(ds: DraftScope) {
    engineUnsub?.();
    engine?.dispose();
    const cs = { userId: ds.userId, orgId: ds.orgId };
    const draftWriter = createDraftWriter({
      store: deps.store,
      key: orderDraftKey(ds),
      epoch: deps.epoch,
      setTimer: deps.setTimer,
      clearTimer: deps.clearTimer,
    });
    writer = draftWriter;
    const keys = new Set<string>();
    engineKeys = keys;
    const next: SubmitEngine = createSubmitEngine({
      organizationId: ds.orgId,
      persist: (state: OrderSubmissionState) => {
        // The record this state needs: the pending send beside the cart, or
        // (placed) a cleared cart, so a relaunch never shows the placed cart
        // again. The cart is this engine's, taken now, while it is shown;
        // an engine no longer shown (a workspace switch) writes nothing, so
        // its key keeps the record written before its send.
        const pending = pendingOrderSubmissionOf(state);
        const own = engine === next ? cart : null;
        return draftWriter.writeNow((stored) => {
          if (engine !== next || own === null) return LEAVE_DRAFT;
          const held = storedLiveKey(stored, ds);
          if (held !== null && (pending ? held !== pending.key : !keys.has(held))) return LEAVE_DRAFT;
          if (pending) keys.add(pending.key);
          const recordCart = state.phase === 'placed' ? cartReducer(own, { type: 'reset' }) : own;
          const draft = { cart: recordCart, submission: pending };
          return isEmptyDraft(draft) ? null : serializeOrderDraft(ds, draft, new Date(deps.now()));
        });
      },
      place: (body, onSend) => deps.api.place(cs, body, onSend),
      status: (key) => deps.api.status(cs, key),
      withdraw: (key) => deps.api.withdraw(cs, key),
      now: () => new Date(deps.now()),
    });
    let lastPhase = next.getSnapshot().state.phase;
    engineUnsub = next.subscribe(() => {
      const snap = next.getSnapshot();
      const phase = snap.state.phase;
      if (phase !== lastPhase) {
        lastPhase = phase;
        if (snap.state.phase === 'placed') {
          placed = {
            order: snap.state.order,
            replay: snap.state.replay,
            viaWithdraw: snap.state.viaWithdraw,
            body: sentBody,
          };
          if (cart) cart = cartReducer(cart, { type: 'reset' });
          refusedItems = new Set();
          restoredNotOrderable = new Set();
          notice = null;
        } else if (snap.state.phase === 'refused') {
          refusedItems = refusedItemIds(snap.state.details);
        }
        // Which warehouses hold a send not settled (Ship from, the banner).
        void refreshLocked().then(publish);
      }
      publish();
    });
    engine = next;
  }

  /**
   * With no storefront to show (the kill switch, an old server, a refusal or
   * no answer), a cart locked by a send that is not settled must still settle
   * (plan 3.1: create and settle stay up): its draft is restored, which reads
   * the key's status on its own, and the unconfirmed panel is offered. No
   * catalog or photo is read.
   */
  async function restoreLockedOnly() {
    if (warehouseId !== null) return;
    await refreshLocked();
    const id = lockedWarehouseIds[0];
    if (id) await loadWarehouse(id, { reads: false });
  }

  async function loadWarehouse(id: string, opts: { reads: boolean } = { reads: true }) {
    const s = scope;
    if (!s) return;
    const gen = ++warehouseGen;
    const sGen = scopeGen;
    warehouseId = id;
    const ds: DraftScope = { userId: s.userId, orgId: s.orgId, warehouseId: id };
    cart = null;
    catalog = { ...blankCatalog(), status: 'loading' };
    items = [];
    itemMap = new Map();
    prepared = EMPTY_PREPARED;
    photos = { answer: null, failed: false };
    refusedItems = new Set();
    restoredNotOrderable = new Set();
    notice = null;
    refusal = null;
    placed = null;
    sentBody = null;
    attachEngine(ds);
    publish();

    // The device first: the draft, the last catalog and photos (shown at once).
    const [rawDraft, rawCatalog, rawPhotos] = await Promise.all([
      deps.store.getItem(orderDraftKey(ds)).catch(() => null),
      deps.store.getItem(orderCatalogKey(ds)).catch(() => null),
      deps.store.getItem(orderPhotosKey(ds)).catch(() => null),
    ]);
    if (gen !== warehouseGen || sGen !== scopeGen) return;
    const stored = parseStoredOrderDraft(rawDraft, ds);
    const restored = stored ? restoredDraft(stored, id) : null;
    cart = restored?.cart ?? initialCartState({ warehouseId: id, fulfillmentType: 'pickup' });
    if (restored?.submission) {
      sentBody = restored.submission.bodyUnreadable ? null : restored.submission.body;
      engineKeys.add(restored.submission.key);
      engine?.restore(restored.submission);
    } else if (stored && cart.lines.length > 0) {
      recheckPending = true;
    }
    const storedCatalog = parseStoredCatalog(rawCatalog, ds);
    if (storedCatalog) setCatalogAnswer(storedCatalog.answer, storedCatalog.readAt, true);
    const storedPhotos = parseStoredPhotos(rawPhotos, ds);
    if (storedPhotos) photos = { answer: storedPhotos, failed: false };
    publish();
    void deps.store
      .setItem(orderPrefsKey(s), serializeOrderPrefs({ lastWarehouseId: id }))
      .catch(() => undefined);

    if (opts.reads) await Promise.all([readCatalog(gen), readPhotos(gen, false)]);
  }

  let catalogRead: { gen: number; promise: Promise<ReadonlyMap<string, StorefrontItem> | null> } | null = null;

  /** One catalog read at a time per warehouse: a second ask joins it. */
  function readCatalog(gen: number): Promise<ReadonlyMap<string, StorefrontItem> | null> {
    if (catalogRead && catalogRead.gen === gen) return catalogRead.promise;
    const promise = readCatalogNow(gen).finally(() => {
      if (catalogRead?.promise === promise) catalogRead = null;
    });
    catalogRead = { gen, promise };
    return promise;
  }

  async function readCatalogNow(gen: number): Promise<ReadonlyMap<string, StorefrontItem> | null> {
    const cs = callScope();
    const ds = draftScope();
    if (!cs || !ds) return null;
    catalog = { ...catalog, refreshing: true, status: catalog.answer ? catalog.status : 'loading' };
    publish();
    try {
      const answer = await deps.api.catalog(cs, ds.warehouseId);
      if (gen !== warehouseGen) return null;
      const readAt = deps.now();
      const before = setCatalogAnswer(answer, readAt, false);
      void deps.store.setItem(orderCatalogKey(ds), serializeCatalog(answer, readAt)).catch(() => undefined);
      publish();
      return before;
    } catch (e) {
      if (gen !== warehouseGen) return null;
      const failure = storefrontReadFailure(e);
      if (failure.kind === 'other_organization') {
        catalog = { ...catalog, refreshing: false };
      } else {
        catalog = {
          ...catalog,
          status: catalog.answer ? 'ready' : 'failed',
          message: failure.message,
          refreshing: false,
        };
      }
      publish();
      return null;
    }
  }

  async function readPhotos(gen: number, force: boolean) {
    const cs = callScope();
    const ds = draftScope();
    if (!cs || !ds) return;
    if (!force && !photosNeedRefresh(photos.answer, deps.now(), photos.failed)) return;
    try {
      const answer = await deps.api.photos(cs, ds.warehouseId);
      if (gen !== warehouseGen) return;
      photos = { answer, failed: false };
      void deps.store.setItem(orderPhotosKey(ds), serializePhotos(answer)).catch(() => undefined);
      publish();
    } catch {
      // Photos are optional: the rows show their glyph.
    }
  }

  async function readStorefront(gen: number) {
    const cs = callScope();
    const s = scope;
    if (!cs || !s) return;
    try {
      const answer = await deps.api.storefront(cs);
      if (gen !== scopeGen) return;
      if (!answer.enabled) {
        setup = { status: 'off', message: answer.message };
        publish();
        await restoreLockedOnly();
        return;
      }
      setup = { status: 'ready', answer };
      const server = Date.parse(answer.serverNow);
      serverSkewMs = Number.isFinite(server) ? server - deps.now() : 0;
      await refreshLocked();
      if (gen !== scopeGen) return;
      // A locked cart's warehouse is kept even when it is no longer listed:
      // its send must still be settled (status and withdraw need only
      // membership).
      const keep =
        warehouseId !== null &&
        (answer.warehouses.some((w) => w.id === warehouseId) || lockedWarehouseIds.includes(warehouseId));
      if (!keep) {
        const prefs = parseOrderPrefs(await deps.store.getItem(orderPrefsKey(s)).catch(() => null));
        if (gen !== scopeGen) return;
        const id = initialShipFrom({
          warehouses: answer.warehouses,
          lockedWarehouseIds,
          lastUsedId: prefs.lastWarehouseId,
          activeWarehouseId: s.activeWarehouseId,
        });
        publish();
        if (id) await loadWarehouse(id);
        else publish();
      } else {
        publish();
      }
    } catch (e) {
      if (gen !== scopeGen) return;
      const failure = storefrontReadFailure(e);
      if (failure.kind === 'other_organization') return;
      if (setup.status === 'ready' && failure.kind === 'failed') {
        // A refresh that failed keeps the storefront already shown.
        publish();
        return;
      }
      setup =
        failure.kind === 'turned_off' || failure.kind === 'unavailable'
          ? { status: 'off', message: failure.message }
          : failure.kind === 'refused'
            ? { status: 'refused', message: failure.message }
            : { status: 'failed', message: failure.message };
      publish();
      await restoreLockedOnly();
    }
  }

  /** Forget the scope shown. `sameAccount`: a workspace switch, whose waiting
   *  save still lands under its own key with its own cart; otherwise (the
   *  account ended) it is dropped. */
  function resetScope(sameAccount: boolean) {
    scopeGen += 1;
    warehouseGen += 1;
    engineUnsub?.();
    engine?.dispose();
    engine = null;
    engineUnsub = null;
    if (!sameAccount) writer?.dispose();
    writer = null;
    engineKeys = new Set();
    setup = { status: 'loading' };
    warehouseId = null;
    catalog = blankCatalog();
    items = [];
    itemMap = new Map();
    prepared = EMPTY_PREPARED;
    photos = { answer: null, failed: false };
    cart = null;
    refusedItems = new Set();
    restoredNotOrderable = new Set();
    recheckPending = false;
    notice = null;
    refusal = null;
    placed = null;
    sentBody = null;
    lockedWarehouseIds = [];
    serverSkewMs = 0;
  }

  const session: StorefrontSession = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async open(next) {
      const same = scope !== null && scope.userId === next.userId && scope.orgId === next.orgId;
      if (same) {
        scope = { ...scope!, activeWarehouseId: next.activeWarehouseId };
        if (setup.status !== 'ready') await readStorefront(scopeGen);
        return;
      }
      resetScope(scope !== null && scope.userId === next.userId);
      scope = { ...next };
      publish();
      await readStorefront(scopeGen);
    },

    async refresh() {
      if (!scope) return;
      const gen = warehouseGen;
      await Promise.all([
        readStorefront(scopeGen),
        warehouseId ? readCatalog(gen) : Promise.resolve(null),
        warehouseId ? readPhotos(gen, true) : Promise.resolve(),
      ]);
      void engine?.readStatus();
    },

    async focus() {
      if (!scope) return;
      if (setup.status === 'failed') await readStorefront(scopeGen);
      if (warehouseId && catalogIsStale(catalog.readAt, deps.now(), catalog.answer?.staleAfterSeconds)) {
        await readCatalog(warehouseGen);
      }
      if (warehouseId) void readPhotos(warehouseGen, false);
      void engine?.readStatus();
    },

    async selectWarehouse(id) {
      if (!scope || id === warehouseId) return null;
      if (setup.status !== 'ready' || !setup.answer.warehouses.some((w) => w.id === id)) return null;
      if (engineLocked()) {
        refusal = STOREFRONT_SHIP_FROM_LOCKED_COPY;
        publish();
        return STOREFRONT_SHIP_FROM_LOCKED_COPY;
      }
      await loadWarehouse(id);
      return null;
    },

    dispatch(action) {
      if (!cart) return null;
      const locked = engine?.refuseChange() ?? null;
      if (locked !== null) {
        refusal = action.type === 'add' || action.type === 'apply-kit' ? locked : STOREFRONT_CART_LOCKED_COPY;
        publish();
        return refusal;
      }
      const next = cartReducer(cart, action);
      if (next === cart) return null;
      cart = next;
      notice = null;
      refusal = null;
      // A line taken out takes its marks with it.
      const ids = new Set(next.lines.map((l) => l.itemId));
      refusedItems = new Set([...refusedItems].filter((id) => ids.has(id)));
      restoredNotOrderable = new Set([...restoredNotOrderable].filter((id) => ids.has(id)));
      const s = engine?.getSnapshot().state;
      if (s && (s.phase === 'refused' || s.phase === 'withdrawn')) engine?.dismiss();
      saveCart();
      publish();
      return null;
    },

    setQuantity(itemId, value) {
      const item = itemMap.get(itemId);
      const qty = item ? clampQty(value, availableOf(item)) : Math.max(0, Math.floor(value) || 0);
      return session.dispatch({ type: 'set-qty', itemId, quantity: qty });
    },

    changeKit(bundleId, target) {
      if (!cart) return null;
      const kitsPart = catalog.answer?.kits;
      const kit = kitsPart?.status === 'ok' ? kitsPart.kits.find((k) => k.bundleId === bundleId) : undefined;
      if (!kit) return null;
      const plan = planKitChange(kit, target, itemMap, cart.kits[bundleId], buildQtyMap(cart.lines));
      if (!plan.ok) {
        const name = componentItem(plan.short, itemMap)?.name ?? kit.name;
        refusal = kitNotEnoughCopy(name);
        publish();
        return refusal;
      }
      if (plan.changes.length === 0) return null;
      return session.dispatch({ type: 'apply-kit', bundleId, changes: plan.changes });
    },

    async openCheckout() {
      if (!warehouseId) return;
      const before = itemMap;
      const result = await readCatalog(warehouseGen);
      if (!result || !cart || engineLocked()) return;
      const n = stockChangedNotice(cart, before, itemMap);
      if (n !== null) {
        notice = n;
        publish();
      }
    },

    submitBlockedBy(offline) {
      if (!cart) return ORDER_NEEDS_CONNECTION_COPY;
      const sites = catalog.answer?.sites;
      const siteKnown =
        cart.charterId === null ||
        sites === undefined ||
        sites.status === 'error' ||
        sites.sites.some((x) => x.id === cart!.charterId);
      return submitBlockedBy({ cart, offline, unorderable: snapshot.notOrderable, siteKnown });
    },

    async submit(offline) {
      if (!cart || !scope || !engine) return;
      if (setup.status !== 'ready') return;
      if (session.submitBlockedBy(offline) !== null) return;
      const kitsPart = catalog.answer?.kits;
      const body = buildOrderCreateBody({
        cart,
        userId: scope.userId,
        key: (deps.mintKey ?? mintOrderSubmissionKey)(),
        kits: kitsPart && kitsPart.status === 'ok' ? kitsPart.kits : [],
      });
      sentBody = body;
      refusal = null;
      writer?.cancel();
      await engine.submit(body);
    },

    async checkAndFinish() {
      await engine?.checkAndFinish();
    },

    async dontSend() {
      await engine?.dontSend();
    },

    dismissOutcome() {
      const s = engine?.getSnapshot().state;
      if (s && s.phase !== 'placed') engine?.dismiss();
      else if (engine?.getSnapshot().deviceError) engine.dismiss();
      refusal = null;
      publish();
    },

    finishPlaced() {
      if (engine?.getSnapshot().state.phase === 'placed') engine.dismiss();
      placed = null;
      sentBody = null;
      publish();
    },

    photoFailed() {
      if (photos.failed) return;
      photos = { ...photos, failed: true };
      void readPhotos(warehouseGen, false);
    },

    close() {
      resetScope(false);
      scope = null;
      publish();
    },
  };
  return session;
}
