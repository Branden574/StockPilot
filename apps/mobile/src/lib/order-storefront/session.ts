import {
  ORDER_NEEDS_CONNECTION_COPY,
  STOREFRONT_CART_LOCKED_COPY,
  STOREFRONT_LINE_NOT_ORDERABLE_COPY,
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
  raisesNotOrderable,
  recheckRestoredCart,
  refusedItemReasons,
  stockChangedNotice,
  storefrontNeededByZone,
  submitBlockedBy,
} from './checkout';
import { catalogIsStale, catalogItems, initialShipFrom, photosNeedRefresh } from './setup';
import {
  LEAVE_DRAFT,
  cartFromPendingBody,
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
import { successContextFrom, type SuccessContext } from './success';

/**
 * ONE ACCOUNT'S STOREFRONT IN ONE ORGANIZATION (phone ordering PO-4): what
 * the four storefront screens (home, browse, checkout, placed) share, kept
 * outside React so a screen change never loses it and every rule is tested
 * here with fakes (session.test.ts). The app wires it to api(), AsyncStorage
 * and the account epoch (runtime.ts), and the screens read it with
 * useSyncExternalStore.
 *
 * What it holds: the storefront answer (read on open, again when checkout
 * opens, and on a focus once it is older than STOREFRONT_ANSWER_STALE_MS, so
 * a permission changed while the app stays open is followed before Submit),
 * Ship from, the
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
 *   - a restored unlocked cart is checked against the fresh catalog (never
 *     the device's copy, which describes old stock) and one sentence says
 *     what changed; a restored LOCKED cart is never changed, it
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
  /** How old the storefront answer may get before a focus reads it again
   *  (default STOREFRONT_ANSWER_STALE_MS). */
  storefrontStaleMs?: number;
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
  /** The success screen has shown it (desk check F10): a storefront that
   *  comes into focus afterwards clears it instead of showing it again. */
  shown: boolean;
  /** What the success screen shows beside the order, taken from the answer
   *  and the catalog when it was placed (PO-4 review), so a later read that
   *  comes back turned off or refused never changes that screen. Null when
   *  there was no answer to take it from (a settle while the storefront was
   *  turned off or refused): the screen then uses the answer shown. */
  context: SuccessContext | null;
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
  /** The server's reason for each refused line still in the cart (a rental,
   *  not received yet...), so the line says why (PO-4 review). */
  refusals: ReadonlyMap<string, string>;
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
  /** The storefront answer is being read again (checkout opening, a stale
   *  focus): a cart for someone else waits for it before Submit, so it is
   *  judged by what the server says now (PO-4 review). */
  checkingAnswer: boolean;
}

/** How a warehouse's send ended, kept for the same account across a
 *  workspace switch when no screen showed it (PO-4 review). */
interface CarriedOutcome {
  state: OrderSubmissionState;
  placed: PlacedContext | null;
}

const EMPTY_SUBMISSION: SubmitEngineSnapshot = {
  state: { phase: 'open' },
  busy: false,
  deviceError: null,
  sent: false,
};

const EMPTY_PREPARED = prepareCatalog<StorefrontItem>([]);

/** One empty photo map and one empty mark set for every snapshot that has
 *  none: a publish that changes neither keeps the same objects, so the
 *  catalog's memoized rows do not redraw on a keystroke (desk check F8.1). */
const EMPTY_PHOTOS: Readonly<Record<string, string>> = Object.freeze({});
const NO_MARKS: ReadonlySet<string> = new Set<string>();
const NO_REFUSALS: ReadonlyMap<string, string> = new Map<string, string>();

/** A photo that fails reads the photo map again at most once in this long,
 *  per warehouse (desk check F8.2): a fresh map that still holds a broken
 *  photo must not read the map again on every later error. */
export const PHOTO_RETRY_MS = 5 * 60_000;

/** The storefront answer (who may order on behalf, the warehouses, the kill
 *  switch) is read again on a focus once it is this old, and always when
 *  checkout opens: a permission revoked while the app stays open is followed
 *  before Submit, not only after a pull or a relaunch (PO-4 re-check). */
export const STOREFRONT_ANSWER_STALE_MS = 60_000;

/** A final refusal for one of these reasons means the answer shown is out of
 *  date: it is read again at once, so Submit says why before another key is
 *  spent on the same refusal. */
const ANSWER_REFUSAL_REASONS: ReadonlySet<string> = new Set(['on_behalf_not_permitted', 'permission', 'module_disabled']);

function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function sameEntries(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

export interface StorefrontSession {
  getSnapshot(): StorefrontSnapshot;
  subscribe(listener: () => void): () => void;
  /** Open (or keep) the storefront for this account and organization. */
  open(scope: SessionScope): Promise<void>;
  /** Pull to refresh: the storefront, the catalog and the photos. */
  refresh(): Promise<void>;
  /** The screen came into focus, or the app came to the foreground, or the
   *  connection came back: read what is stale (the storefront answer, the
   *  catalog, the photos), and the status of a send that is not confirmed.
   *  Never sends. */
  focus(): Promise<void>;
  selectWarehouse(warehouseId: string): Promise<string | null>;
  /** A cart change. Returns core's refusal sentence while locked. */
  dispatch(action: CartAction): string | null;
  /** A typed quantity, clamped to what is available (0 removes the line). */
  setQuantity(itemId: string, value: number): string | null;
  /** A kit to `target` kits in the cart, all or nothing (core
   *  planKitChange); core's words when it does not fit. */
  changeKit(bundleId: string, target: number): string | null;
  /** Checkout opened: read the catalog and the storefront answer again, and
   *  say what moved. */
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
  /** The success screen is showing the order placed. */
  placedShown(): void;
  /** An item photo failed to load: read the map again (at most once in
   *  PHOTO_RETRY_MS for this warehouse). */
  photoFailed(): void;
  /** The account or organization ended: forget everything shown. */
  close(): void;
}

export function createStorefrontSession(deps: SessionDeps): StorefrontSession {
  const listeners = new Set<() => void>();
  let scope: SessionScope | null = null;
  /** The account epoch the scope was opened in: a sign-out ends it, and the
   *  same account signing back in starts over (simulator walk D4). */
  let scopeEpoch: number | null = null;
  let scopeGen = 0;
  let warehouseGen = 0;

  let setup: SetupState = { status: 'loading' };
  /** When the storefront last answered (ready, off or refused), null before
   *  any; a read with no answer leaves it, so the next focus tries again. */
  let setupReadAt: number | null = null;
  const storefrontStaleMs = deps.storefrontStaleMs ?? STOREFRONT_ANSWER_STALE_MS;
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
  /** The server's refused lines and their reasons (item_not_orderable). */
  let refusedItems = new Map<string, string>();
  /** A cart restored from the device waits for the FRESH catalog to be
   *  checked against (desk check F9): the device's copy describes old
   *  stock. Its marks are never kept apart: the live catalog marks a line
   *  that is gone (build()). */
  let recheckPending = false;
  let notice: string | null = null;
  let refusal: string | null = null;
  let placed: PlacedContext | null = null;
  let sentBody: OrderCreateRequestInput | null = null;
  let lockedWarehouseIds: string[] = [];
  let serverSkewMs = 0;
  /** When this warehouse's photo map was last read again for a failed
   *  photo (null: not yet). */
  let photoRetryAt: number | null = null;
  let lastMarks: ReadonlySet<string> = NO_MARKS;
  let lastRefusals: ReadonlyMap<string, string> = NO_REFUSALS;
  /** A storefront read is out (see checkingAnswer). */
  let answerReading = false;
  /** How a send ended that no screen showed before a workspace switch, by
   *  its draft key, for this account only (PO-4 review, probe P6): shown
   *  when that warehouse opens again, then forgotten. */
  const carried = new Map<string, CarriedOutcome>();
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
    const refusals = new Map<string, string>();
    for (const [id, reason] of refusedItems) {
      if (!cart?.lines.some((l) => l.itemId === id)) continue;
      notOrderable.add(id);
      refusals.set(id, reason);
    }
    // The same marks keep the same set (the rows' memo depends on it).
    if (!sameMembers(notOrderable, lastMarks)) lastMarks = notOrderable.size === 0 ? NO_MARKS : notOrderable;
    if (!sameEntries(refusals, lastRefusals)) lastRefusals = refusals.size === 0 ? NO_REFUSALS : refusals;
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
      photos: photos.answer?.photos ?? EMPTY_PHOTOS,
      cart,
      submission,
      locked: orderSubmissionLocked(submission.state),
      notOrderable: lastMarks,
      refusals: lastRefusals,
      notice,
      refusal,
      placed,
      lockedWarehouseIds,
      serverSkewMs,
      checkingAnswer: answerReading,
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
    if (recheckPending && !fromDevice && cart && !engineLocked()) {
      recheckPending = false;
      const r = recheckRestoredCart(cart, itemMap);
      cart = r.cart;
      notice = r.notice;
    }
    return before;
  }

  /** The zone and the server's now a needed-by is checked against, or
   *  undefined when the zone cannot be used on this phone. */
  function neededByCheck(): { zone: string; now: number } | undefined {
    if (setup.status !== 'ready') return undefined;
    const z = storefrontNeededByZone(setup.answer.orgTimezone);
    return z.ok ? { zone: z.zone, now: deps.now() + serverSkewMs } : undefined;
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
          // A locked record holds the cart the body was built from, as a
          // relaunch restores it (store.ts restoredDraft): a locked cart
          // always shows exactly what was sent (PO-4 review).
          const recordCart =
            state.phase === 'placed'
              ? cartReducer(own, { type: 'reset' })
              : pending && pending.bodyUnreadable !== true
                ? cartFromPendingBody(pending.body, ds.warehouseId)
                : own;
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
    let lastLocked = orderSubmissionLocked(next.getSnapshot().state);
    engineUnsub = next.subscribe(() => {
      const snap = next.getSnapshot();
      const phase = snap.state.phase;
      if (phase !== lastPhase) {
        lastPhase = phase;
        // The lock's words go with the lock (the Ship from, add and change
        // refusals): the outcome sentence says what happened instead.
        const nowLocked = orderSubmissionLocked(snap.state);
        if (lastLocked && !nowLocked) refusal = null;
        lastLocked = nowLocked;
        if (snap.state.phase === 'placed') {
          const sites = catalog.answer?.sites;
          placed = {
            order: snap.state.order,
            replay: snap.state.replay,
            viaWithdraw: snap.state.viaWithdraw,
            body: sentBody,
            shown: false,
            context:
              setup.status === 'ready'
                ? successContextFrom({
                    answer: setup.answer,
                    warehouseId: snap.state.order.warehouseId,
                    sites: sites?.status === 'ok' ? sites.sites : [],
                    itemMap,
                    lines: sentBody?.lines ?? [],
                  })
                : null,
          };
          if (cart) cart = cartReducer(cart, { type: 'reset' });
          refusedItems = new Map();
          notice = null;
        } else if (snap.state.phase === 'refused') {
          refusedItems = refusedItemReasons(snap.state.details);
          if (ANSWER_REFUSAL_REASONS.has(snap.state.reason)) void readStorefront(scopeGen);
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
    photoRetryAt = null;
    refusedItems = new Map();
    recheckPending = false;
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
    const carriedHere = carried.get(orderDraftKey(ds));
    carried.delete(orderDraftKey(ds));
    if (restored?.submission) {
      sentBody = restored.submission.bodyUnreadable ? null : restored.submission.body;
      engineKeys.add(restored.submission.key);
      engine?.restore(restored.submission);
    } else if (carriedHere) {
      // Its key settled while no screen showed it, and the person switched
      // workspaces before coming back: say how it ended now (PO-4 review).
      sentBody = carriedHere.placed?.body ?? null;
      engine?.adopt(carriedHere.state);
      if (carriedHere.placed) placed = carriedHere.placed;
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

  let storefrontRead: { gen: number; promise: Promise<void> } | null = null;

  /** One storefront read at a time per scope: a second ask joins it. While
   *  it is out, a cart for someone else waits before Submit (PO-4 review). */
  function readStorefront(gen: number): Promise<void> {
    if (storefrontRead && storefrontRead.gen === gen) return storefrontRead.promise;
    const promise = readStorefrontNow(gen).finally(() => {
      if (storefrontRead?.promise === promise) storefrontRead = null;
      answerReading = storefrontRead !== null;
      publish();
    });
    storefrontRead = { gen, promise };
    answerReading = true;
    publish();
    return promise;
  }

  /** The answer shown is older than the staleness (or there is none). */
  function storefrontStale(): boolean {
    return setupReadAt === null || deps.now() - setupReadAt >= storefrontStaleMs;
  }

  async function readStorefrontNow(gen: number) {
    const cs = callScope();
    const s = scope;
    if (!cs || !s) return;
    try {
      const answer = await deps.api.storefront(cs);
      if (gen !== scopeGen) return;
      setupReadAt = deps.now();
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
      if (failure.kind !== 'failed') setupReadAt = deps.now();
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

  /** The shown engine's final outcome that no screen has shown (a refusal or
   *  withdrawn not dismissed, a placed order whose success screen did not
   *  open), kept by its draft key. */
  function carryOutcome() {
    const ds = draftScope();
    const state = engine?.getSnapshot().state;
    if (!ds || !state) return;
    if (state.phase === 'refused' || state.phase === 'withdrawn') {
      carried.set(orderDraftKey(ds), { state, placed: null });
    } else if (state.phase === 'placed' && placed && !placed.shown) {
      carried.set(orderDraftKey(ds), { state, placed });
    }
  }

  /** Forget the scope shown. `sameAccount`: a workspace switch, whose waiting
   *  save still lands under its own key with its own cart; otherwise (the
   *  account ended) it is dropped. */
  function resetScope(sameAccount: boolean) {
    // How the shown send ended, if no screen showed it yet, goes with this
    // account to that warehouse's next open; another account never sees it.
    if (sameAccount) carryOutcome();
    else carried.clear();
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
    setupReadAt = null;
    warehouseId = null;
    catalog = blankCatalog();
    items = [];
    itemMap = new Map();
    prepared = EMPTY_PREPARED;
    photos = { answer: null, failed: false };
    photoRetryAt = null;
    cart = null;
    refusedItems = new Map();
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
      // The same account and organization, in the same account epoch. A
      // sign-out ends the epoch even when no storefront screen was mounted to
      // close the session, and the account's storage was cleared: everything
      // kept here belongs to that ended session (its writer refuses every
      // save), so the same account signing back in starts over.
      const same =
        scope !== null &&
        scope.userId === next.userId &&
        scope.orgId === next.orgId &&
        scopeEpoch === deps.epoch();
      if (same) {
        // A screen opening again: read the answer again when it failed, or
        // once it is stale (never on every mount).
        scope = { ...scope!, activeWarehouseId: next.activeWarehouseId };
        if (setup.status === 'failed' || (setup.status !== 'loading' && storefrontStale())) {
          await readStorefront(scopeGen);
        }
        return;
      }
      resetScope(scope !== null && scope.userId === next.userId && scopeEpoch === deps.epoch());
      scope = { ...next };
      scopeEpoch = deps.epoch();
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
      if (setup.status === 'failed' || (setup.status !== 'loading' && storefrontStale())) {
        await readStorefront(scopeGen);
      }
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
      // A line marked as not orderable can be lowered or removed, never
      // raised (simulator walk D9).
      if (raisesNotOrderable(action, cart, snapshot.notOrderable)) {
        refusal = STOREFRONT_LINE_NOT_ORDERABLE_COPY;
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
      refusedItems = new Map([...refusedItems].filter(([id]) => ids.has(id)));
      // A change to the cart is the person moving on: a refusal, the withdrawn
      // notice and a device error are done with.
      const e = engine?.getSnapshot();
      if (e && (e.state.phase === 'refused' || e.state.phase === 'withdrawn' || e.deviceError !== null)) engine?.dismiss();
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
      const gen = warehouseGen;
      // The answer too, however fresh: who may order on behalf is checked
      // against what the server says now, before Submit (PO-4 re-check).
      const [result] = await Promise.all([readCatalog(gen), scope ? readStorefront(scopeGen) : Promise.resolve()]);
      if (!result || !cart || engineLocked() || gen !== warehouseGen) return;
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
      return submitBlockedBy({
        cart,
        offline,
        unorderable: snapshot.notOrderable,
        siteKnown,
        // The answer shown, read again when checkout opens, on a focus once
        // stale and after a final refusal for permission: never a value kept
        // from an earlier read.
        canOrderOnBehalf: setup.status === 'ready' && setup.answer.viewer.canOrderOnBehalf,
        // A needed-by already past (a restored draft) is refused here, on
        // the server's clock in the organization's zone (desk check F11).
        neededBy: neededByCheck(),
      });
    },

    async submit(offline) {
      if (!cart || !scope || !engine) return;
      if (setup.status !== 'ready') return;
      if (session.submitBlockedBy(offline) !== null) return;
      // A cart for someone else is judged by the answer being read, never
      // the one before it: the server's refusal would be final (PO-4 review).
      if (cart.onBehalfOf && answerReading) return;
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

    placedShown() {
      if (!placed || placed.shown) return;
      placed = { ...placed, shown: true };
      publish();
    },

    photoFailed() {
      if (photos.failed) return;
      const at = deps.now();
      if (photoRetryAt !== null && at - photoRetryAt < PHOTO_RETRY_MS) return;
      photoRetryAt = at;
      photos = { ...photos, failed: true };
      void readPhotos(warehouseGen, false);
    },

    close() {
      resetScope(false);
      scope = null;
      scopeEpoch = null;
      publish();
    },
  };
  return session;
}
