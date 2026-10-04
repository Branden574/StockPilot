import {
  fitKitShares,
  initialCartState,
  parsePendingOrderSubmission,
  type CartLineState,
  type CartState,
  type OrderCatalogAnswer,
  type OrderCatalogPhotosAnswer,
  type OrderCreateRequestInput,
  type PendingOrderSubmission,
} from '@stockpilot/core';

import { parseCatalogAnswer, parsePhotosAnswer } from './api';

/**
 * WHAT THE PHONE KEEPS FOR ORDERING, AND WHERE (phone ordering PO-4, plan 3.6).
 *
 * Every key is under the account-scoped `workspace.` prefix, which a sign-out
 * and an account eviction remove (account-eviction.ts
 * ACCOUNT_SCOPED_STORAGE_PREFIXES), and names the account and the
 * organization, so one account's cart is never shown to another and a
 * workspace switch keeps each organization's carts apart:
 *
 *   workspace.orderDraft.v1.<user>.<org>.<warehouse>    the cart AND the pending send
 *   workspace.orderCatalog.v1.<user>.<org>.<warehouse>  the last catalog answer
 *   workspace.orderPhotos.v1.<user>.<org>.<warehouse>   the photo map
 *   workspace.orderPrefs.v1.<user>.<org>                the last Ship from, the sort
 *
 * THE PENDING SEND IS WRITTEN BEFORE THE REQUEST LEAVES. It lives in the
 * draft record beside the cart (`submission`), written and awaited by
 * `writeNow` (the write-ahead) already counting the send that is about to
 * leave (plan 3.4 rule 2). If that write fails nothing is sent.
 *
 * A CLEARED DRAFT STAYS CLEARED. Cart edits are saved 250 ms after the last
 * change. A save still waiting when the cart is reset, or when the account
 * ends, is cancelled, never flushed (the web's cart-context rule; the shared
 * draft-debouncer flushes, so it is not used here). Every write checks the
 * account epoch AT WRITE TIME (account-epoch.ts): a write for an account that
 * has ended is dropped (a debounced save) or refused (the write-ahead, so
 * nothing is sent).
 *
 * Pure apart from the injected storage, epoch and timers, so vitest drives it.
 */

export const ORDER_DRAFT_PREFIX = 'workspace.orderDraft.v1.';
export const ORDER_CATALOG_PREFIX = 'workspace.orderCatalog.v1.';
export const ORDER_PHOTOS_PREFIX = 'workspace.orderPhotos.v1.';
export const ORDER_PREFS_PREFIX = 'workspace.orderPrefs.v1.';

/** Cart edits are saved this long after the last one. */
export const ORDER_DRAFT_SAVE_DEBOUNCE_MS = 250;

export interface DraftScope {
  userId: string;
  orgId: string;
  warehouseId: string;
}

export function orderDraftKey(s: DraftScope): string {
  return `${ORDER_DRAFT_PREFIX}${s.userId}.${s.orgId}.${s.warehouseId}`;
}
export function orderCatalogKey(s: DraftScope): string {
  return `${ORDER_CATALOG_PREFIX}${s.userId}.${s.orgId}.${s.warehouseId}`;
}
export function orderPhotosKey(s: DraftScope): string {
  return `${ORDER_PHOTOS_PREFIX}${s.userId}.${s.orgId}.${s.warehouseId}`;
}
export function orderPrefsKey(s: { userId: string; orgId: string }): string {
  return `${ORDER_PREFS_PREFIX}${s.userId}.${s.orgId}`;
}

/** The storage this module writes through (AsyncStorage in the app). */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── The draft ───────────────────────────────────────────────────────────────

export interface OrderDraft {
  cart: CartState;
  /** The live key's record, or null when no send is unsettled. */
  submission: PendingOrderSubmission | null;
}

export interface StoredOrderDraft extends OrderDraft {
  v: 1;
  userId: string;
  orgId: string;
  warehouseId: string;
  savedAt: string;
}

const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** A saved cart as far as it can be read. Anything that is not a cart line
 *  (an id and a whole quantity above zero) is not one; the kits' records are
 *  refitted to the lines (core fitKitShares). */
export function readStoredCart(raw: unknown, warehouseId: string): CartState {
  const blank = initialCartState({ warehouseId, fulfillmentType: 'pickup' });
  if (!isRecord(raw)) return blank;
  const lines: CartLineState[] = [];
  if (Array.isArray(raw.lines)) {
    for (const l of raw.lines) {
      if (!isRecord(l) || typeof l.itemId !== 'string' || l.itemId === '') continue;
      const q = l.quantity;
      if (typeof q !== 'number' || !Number.isInteger(q) || q < 1) continue;
      if (lines.some((x) => x.itemId === l.itemId)) continue;
      lines.push({ itemId: l.itemId, quantity: q });
    }
  }
  const method = raw.fulfillmentType === 'delivery' ? 'delivery' : 'pickup';
  const ob = raw.onBehalfOf;
  const onBehalfOf =
    isRecord(ob) && typeof ob.name === 'string' && typeof ob.email === 'string'
      ? { name: ob.name, email: ob.email }
      : null;
  return {
    warehouseId,
    fulfillmentType: method,
    charterId: method === 'delivery' && typeof raw.charterId === 'string' ? raw.charterId : null,
    onBehalfOf,
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    neededBy: typeof raw.neededBy === 'string' && WALL_CLOCK.test(raw.neededBy) ? raw.neededBy : '',
    lines,
    kits: fitKitShares(raw.kits, lines),
  };
}

/**
 * Reads a stored draft for exactly this account, organization and warehouse.
 * Null when there is none, or it names anyone or anywhere else (a draft is
 * never shown across accounts). The pending send is read by core
 * (parsePendingOrderSubmission: a record of another placer is never kept; a
 * record of this account whose body today's schema cannot read is kept,
 * flagged, and stays locked). A cart that cannot be read never costs the
 * pending send: they are read apart.
 */
export function parseStoredOrderDraft(raw: string | null, scope: DraftScope): OrderDraft | null {
  const v = parseJson(raw);
  if (!isRecord(v) || v.v !== 1) return null;
  if (v.userId !== scope.userId || v.orgId !== scope.orgId || v.warehouseId !== scope.warehouseId) {
    return null;
  }
  return {
    cart: readStoredCart(v.cart, scope.warehouseId),
    submission: v.submission === null || v.submission === undefined
      ? null
      : parsePendingOrderSubmission(v.submission, scope.userId),
  };
}

export function serializeOrderDraft(scope: DraftScope, draft: OrderDraft, savedAt: Date): string {
  const stored: StoredOrderDraft = {
    v: 1,
    userId: scope.userId,
    orgId: scope.orgId,
    warehouseId: scope.warehouseId,
    cart: draft.cart,
    submission: draft.submission,
    savedAt: savedAt.toISOString(),
  };
  return JSON.stringify(stored);
}

/** Nothing worth keeping: no lines, no setup typed, no pending send. */
export function isEmptyDraft(draft: OrderDraft): boolean {
  const c = draft.cart;
  return (
    draft.submission === null &&
    c.lines.length === 0 &&
    c.onBehalfOf === null &&
    c.charterId === null &&
    c.notes === '' &&
    c.neededBy === ''
  );
}

/**
 * The cart a pending body was built from. A locked cart always shows exactly
 * what was sent (kit records are not in the body and start empty), as the web
 * does (order-submission.ts cartStateFromPendingBody).
 */
export function cartFromPendingBody(body: OrderCreateRequestInput, warehouseId: string): CartState {
  const qty = new Map<string, number>();
  for (const l of body.lines) qty.set(l.itemId, (qty.get(l.itemId) ?? 0) + l.quantity);
  return {
    warehouseId,
    charterId: body.fulfillmentType === 'delivery' ? (body.deliveryCharterId ?? null) : null,
    fulfillmentType: body.fulfillmentType,
    onBehalfOf: body.onBehalfOf ?? null,
    notes: body.notes ?? '',
    neededBy: body.neededByLocal ?? '',
    lines: [...qty].map(([itemId, quantity]) => ({ itemId, quantity })),
    kits: {},
  };
}

/** The draft as restored: a pending send whose body is readable shows the
 *  body it sent, never a cart edited since. */
export function restoredDraft(draft: OrderDraft, warehouseId: string): OrderDraft {
  const s = draft.submission;
  if (s && s.bodyUnreadable !== true) {
    return { cart: cartFromPendingBody(s.body, warehouseId), submission: s };
  }
  return draft;
}

/** Every unsettled send of this account in this organization, from the
 *  device's draft keys (the Orders list banner, the storefront's Ship from,
 *  sign-out). `orgId` null: every organization. */
export function unsettledSubmissions(
  entries: readonly (readonly [string, string | null])[],
  userId: string,
  orgId: string | null,
): { orgId: string; warehouseId: string; pending: PendingOrderSubmission }[] {
  const out: { orgId: string; warehouseId: string; pending: PendingOrderSubmission }[] = [];
  const prefix = `${ORDER_DRAFT_PREFIX}${userId}.`;
  for (const [key, raw] of entries) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length).split('.');
    if (rest.length !== 2) continue;
    const [org, warehouse] = rest as [string, string];
    if (orgId !== null && org !== orgId) continue;
    const draft = parseStoredOrderDraft(raw, { userId, orgId: org, warehouseId: warehouse });
    if (draft?.submission) out.push({ orgId: org, warehouseId: warehouse, pending: draft.submission });
  }
  return out;
}

// ── Writing it ──────────────────────────────────────────────────────────────

export class OrderDraftWriteRefused extends Error {
  constructor() {
    super('The account changed, so the order draft was not written.');
    this.name = 'OrderDraftWriteRefused';
  }
}

export interface DraftWriter {
  /** Save `read()` (evaluated at write time) 250 ms after the last call. */
  schedule(read: () => string | null): void;
  /** Write `read()` now, after any write already running, and wait for it.
   *  Rejects when the device refused it or the account has ended: the caller
   *  then sends nothing. */
  writeNow(read: () => string | null): Promise<void>;
  /** Drop a save still waiting: it is never written. */
  cancel(): void;
  /** No write after this one. */
  dispose(): void;
  /** A save is waiting. */
  pending(): boolean;
}

/**
 * One draft key's writer. Writes run one at a time, in order, so a debounced
 * save started before a write-ahead can never land after it. `null` from
 * `read()` removes the key.
 */
export function createDraftWriter(opts: {
  store: KeyValueStore;
  key: string;
  epoch: () => number;
  debounceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): DraftWriter {
  const startEpoch = opts.epoch();
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let timer: unknown = null;
  let disposed = false;
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (read: () => string | null, strict: boolean): Promise<void> => {
    const run = chain.then(async () => {
      if (disposed || opts.epoch() !== startEpoch) {
        if (strict) throw new OrderDraftWriteRefused();
        return;
      }
      const value = read();
      if (value === null) await opts.store.removeItem(opts.key);
      else await opts.store.setItem(opts.key, value);
    });
    chain = run.catch(() => undefined);
    return run;
  };

  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  return {
    schedule(read) {
      if (disposed) return;
      cancel();
      timer = setTimer(() => {
        timer = null;
        void enqueue(read, false).catch(() => undefined);
      }, opts.debounceMs ?? ORDER_DRAFT_SAVE_DEBOUNCE_MS);
    },
    writeNow(read) {
      cancel();
      return enqueue(read, true);
    },
    cancel,
    dispose() {
      cancel();
      disposed = true;
    },
    pending() {
      return timer !== null;
    },
  };
}

// ── The catalog and the photos kept on the device ───────────────────────────

export interface StoredCatalog {
  answer: OrderCatalogAnswer;
  /** When the phone read it (ms). */
  readAt: number;
}

export function serializeCatalog(answer: OrderCatalogAnswer, readAt: number): string {
  return JSON.stringify({ v: 1, readAt, answer });
}

/** The last catalog answer this account read for this warehouse, or null. */
export function parseStoredCatalog(raw: string | null, scope: DraftScope): StoredCatalog | null {
  const v = parseJson(raw);
  if (!isRecord(v) || v.v !== 1 || typeof v.readAt !== 'number') return null;
  try {
    const answer = parseCatalogAnswer(v.answer);
    if (answer.organizationId !== scope.orgId || answer.warehouseId !== scope.warehouseId) return null;
    return { answer, readAt: v.readAt };
  } catch {
    return null;
  }
}

export function serializePhotos(answer: OrderCatalogPhotosAnswer): string {
  return JSON.stringify({ v: 1, answer });
}

export function parseStoredPhotos(raw: string | null, scope: DraftScope): OrderCatalogPhotosAnswer | null {
  const v = parseJson(raw);
  if (!isRecord(v) || v.v !== 1) return null;
  try {
    const answer = parsePhotosAnswer(v.answer);
    if (answer.organizationId !== scope.orgId || answer.warehouseId !== scope.warehouseId) return null;
    return answer;
  } catch {
    return null;
  }
}

// ── Preferences ─────────────────────────────────────────────────────────────

export interface OrderPrefs {
  /** The warehouse last used for ordering on this phone. */
  lastWarehouseId: string | null;
}

export function parseOrderPrefs(raw: string | null): OrderPrefs {
  const v = parseJson(raw);
  if (!isRecord(v)) return { lastWarehouseId: null };
  return { lastWarehouseId: typeof v.lastWarehouseId === 'string' ? v.lastWarehouseId : null };
}

export function serializeOrderPrefs(prefs: OrderPrefs): string {
  return JSON.stringify(prefs);
}
