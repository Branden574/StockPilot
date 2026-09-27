'use client';

import * as React from 'react';

import type { CartAction, CartKitShares, CartLineState, CartState } from './types';

// ═══ ONE DRAFT PER PAGE, NOT ONE PER WAREHOUSE ═══
//
// The New rental page reuses this cart, and it used to save under the Orders
// key. Both pages then read and wrote the SAME `order-draft:<warehouse>`
// draft: an Orders basket opened inside the rental cart, which drew only the
// lines it could find in its rental catalog and still submitted the rest, so
// checkout failed with "One or more items are not rental items." (Demo Co,
// 2026-09-24). The other direction put rental lines in the Orders basket, and
// a finished rental deleted the Orders draft. Each page now names its own
// prefix. Orders keeps the original one, so its saved drafts still restore.
export const ORDER_DRAFT_PREFIX = 'order-draft:';
export const RENTAL_DRAFT_PREFIX = 'rental-draft:';
const SAVE_DEBOUNCE_MS = 250;

// ═══ A CLEARED DRAFT STAYS CLEARED ═══
//
// Every cart change schedules a save SAVE_DEBOUNCE_MS later. A checkout that
// comes back inside that window (Add, then Check out at once) cleared the
// draft and then the save still waiting wrote the checked-out lines back, so
// the next New rental visit for that warehouse opened with them (web walk,
// 2026-09-25, `rental-draft:<warehouseId>`). The Orders page has the same
// window between placing an order and Done. The waiting save of each draft key
// is kept here, and clearCartDraft cancels it along with removing the key.
const pendingSaves = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Returns a clean cart state seeded for a given warehouse +
 * fulfillment type. Used as both the reducer's initial value and
 * the post-`clear` shape.
 */
export function initialCartState(
  init: Pick<CartState, 'warehouseId' | 'fulfillmentType'> &
    Partial<Pick<CartState, 'charterId' | 'onBehalfOf' | 'notes'>>,
): CartState {
  return {
    warehouseId: init.warehouseId,
    charterId: init.charterId ?? null,
    fulfillmentType: init.fulfillmentType,
    onBehalfOf: init.onBehalfOf ?? null,
    notes: init.notes ?? '',
    neededBy: '',
    lines: [],
    kits: {},
  };
}

/**
 * Every kit's record of its units (CartState.kits), cut down so that, line by
 * line, the kits together never claim more than the line holds. Kits keep their
 * claim in the order they were first added; a line that shrinks takes units
 * from the most recently added kit first. Anything that is not a whole number
 * of units above zero is dropped, which is also how a malformed saved draft is
 * cleaned on load.
 */
export function fitKitShares(
  kits: unknown,
  lines: readonly CartLineState[],
): Record<string, CartKitShares> {
  if (kits === null || typeof kits !== 'object' || Array.isArray(kits)) return {};
  const left = new Map<string, number>();
  for (const l of lines) left.set(l.itemId, (left.get(l.itemId) ?? 0) + l.quantity);
  const out: Record<string, CartKitShares> = {};
  for (const [bundleId, shares] of Object.entries(kits as Record<string, unknown>)) {
    if (shares === null || typeof shares !== 'object' || Array.isArray(shares)) continue;
    const kept: CartKitShares = {};
    for (const [itemId, units] of Object.entries(shares as Record<string, unknown>)) {
      if (typeof units !== 'number' || !Number.isInteger(units) || units <= 0) continue;
      const room = left.get(itemId) ?? 0;
      const claim = Math.min(units, room);
      if (claim <= 0) continue;
      kept[itemId] = claim;
      left.set(itemId, room - claim);
    }
    if (Object.keys(kept).length > 0) out[bundleId] = kept;
  }
  return out;
}

/** The kits' records refitted after a change to the lines by hand. */
function withLines(state: CartState, lines: CartLineState[]): CartState {
  return { ...state, lines, kits: fitKitShares(state.kits, lines) };
}

/**
 * Nothing worth restoring: no basket, and no setup answer a person typed.
 * `warehouseId` and `fulfillmentType` are excluded on purpose — they are seeded
 * on every page load, so a draft carrying only those restores nothing.
 */
function isPristineCart(state: CartState): boolean {
  return (
    state.lines.length === 0 &&
    state.onBehalfOf === null &&
    state.charterId === null &&
    state.notes === '' &&
    (state.neededBy ?? '') === ''
  );
}

export function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case 'hydrate':
      // Old persisted drafts predate neededBy and kits — default them in. A
      // kit record is only kept as far as the saved lines hold it.
      return {
        ...action.state,
        neededBy: action.state.neededBy ?? '',
        kits: fitKitShares(action.state.kits, action.state.lines ?? []),
      };
    case 'add': {
      const delta = action.quantity ?? 1;
      const existing = state.lines.find((l) => l.itemId === action.itemId);
      if (existing) {
        return {
          ...state,
          lines: state.lines.map((l) =>
            l.itemId === action.itemId
              ? { ...l, quantity: l.quantity + delta }
              : l,
          ),
        };
      }
      return {
        ...state,
        lines: [...state.lines, { itemId: action.itemId, quantity: delta }],
      };
    }
    case 'inc':
      return {
        ...state,
        lines: state.lines.map((l) =>
          l.itemId === action.itemId ? { ...l, quantity: l.quantity + 1 } : l,
        ),
      };
    // Lowering or removing a line by hand shrinks any kit's record of it
    // (withLines), so taking a kit out later never takes more than is there.
    case 'dec':
      return withLines(
        state,
        state.lines.flatMap((l) => {
          if (l.itemId !== action.itemId) return [l];
          if (l.quantity <= 1) return [];
          return [{ ...l, quantity: l.quantity - 1 }];
        }),
      );
    case 'set-qty': {
      // Quantity ≤ 0 drops the line so the same action covers
      // "clear by typing 0" and "set to N".
      if (action.quantity <= 0) {
        return withLines(
          state,
          state.lines.filter((l) => l.itemId !== action.itemId),
        );
      }
      const exists = state.lines.some((l) => l.itemId === action.itemId);
      if (!exists) {
        return {
          ...state,
          lines: [...state.lines, { itemId: action.itemId, quantity: action.quantity }],
        };
      }
      return withLines(
        state,
        state.lines.map((l) =>
          l.itemId === action.itemId ? { ...l, quantity: action.quantity } : l,
        ),
      );
    }
    case 'remove':
      return withLines(
        state,
        state.lines.filter((l) => l.itemId !== action.itemId),
      );
    case 'apply-kit': {
      // One step for the whole kit, so a kit is never half in the cart. Lines
      // are ordinary lines: an existing line grows or shrinks, a new one is
      // appended, one at 0 is removed.
      const valid = action.changes.filter(
        (c) => Number.isInteger(c.delta) && c.delta !== 0,
      );
      if (valid.length === 0) return state;
      const lines = state.lines.map((l) => ({ ...l }));
      // The kit's record as far as the lines hold it: where a record says more
      // than its line now holds, the record is what gives way, never the line.
      const fitted = fitKitShares(state.kits ?? {}, state.lines)[action.bundleId] ?? {};
      const shares: CartKitShares = { ...fitted };
      for (const c of valid) {
        const line = lines.find((l) => l.itemId === c.itemId);
        // A kit takes off a line only units it recorded there, so a plan made
        // against an older cart can never take units added by hand.
        const delta = c.delta < 0 ? Math.max(c.delta, -(shares[c.itemId] ?? 0)) : c.delta;
        if (delta === 0) continue;
        if (line) line.quantity += delta;
        else if (delta > 0) lines.push({ itemId: c.itemId, quantity: delta });
        shares[c.itemId] = (shares[c.itemId] ?? 0) + delta;
      }
      const kept = lines.filter((l) => l.quantity > 0);
      return {
        ...state,
        lines: kept,
        kits: fitKitShares({ ...(state.kits ?? {}), [action.bundleId]: shares }, kept),
      };
    }
    case 'clear':
      // BASKET ONLY. The setup answers (requester, charter, dates, notes) are
      // deliberately untouched — this is the "empty my basket" button, pressed
      // mid-order, and wiping who the order is for would be its own surprise.
      // The end-of-order wipe is `reset`.
      return { ...state, lines: [], kits: {} };
    case 'reset':
      // ═══ A NEW ORDER STARTS BLANK — owner report 2026-08-19 ═══
      //
      // `clear` was doing double duty as the end-of-order reset, so
      // `onBehalfOf` survived a completed order and the NEXT one opened
      // pre-filled with the last person's name and email. onBehalfOf becomes
      // `requestedFor` + `requesterEmail` on submit — who gets notified and who
      // the warehouse hands the goods to — so inheriting it silently addresses
      // one person's delivery to another. `neededBy` is the same hazard one
      // step on: it drives the schedule event created on approve.
      //
      // initialCartState has always described itself as "the post-`clear`
      // shape". This is the first code path that actually uses it that way.
      return initialCartState({
        warehouseId: state.warehouseId,
        fulfillmentType: state.fulfillmentType,
      });
    case 'set-setup':
      return { ...state, ...action.patch };
    case 'set-notes':
      return { ...state, notes: action.value };
    case 'set-needed-by':
      return { ...state, neededBy: action.value };
    default:
      return state;
  }
}

interface CartContextValue {
  state: CartState;
  dispatch: React.Dispatch<CartAction>;
  /**
   * True once the one-shot localStorage hydration has run. A one-shot prefill
   * (Start an order from Items) gates on this so its added lines land ON TOP of
   * a restored draft instead of being clobbered by a later hydrate dispatch.
   */
  hydrated: boolean;
}

const CartContext = React.createContext<CartContextValue | null>(null);

/**
 * Wraps the picker in cart state. Hydrates from localStorage on
 * mount (so SSR doesn't see device-specific cart data), then
 * debounce-saves on every change. localStorage key is scoped per
 * warehouseId so swapping warehouses doesn't trample the other
 * warehouse's draft, and per page by `draftPrefix` (see above).
 *
 * `initial` is read once, on mount. A page that changes warehouse without
 * remounting (a router.push that only changes ?warehouseId) must key this
 * provider by the warehouse, or the cart keeps the first one.
 */
export function CartProvider({
  initial,
  draftPrefix = ORDER_DRAFT_PREFIX,
  children,
}: {
  initial: CartState;
  draftPrefix?: string;
  children: React.ReactNode;
}) {
  const [state, dispatch] = React.useReducer(cartReducer, initial);
  const [hydrated, setHydrated] = React.useState(false);

  // Hydration is a one-shot on mount, for the warehouse this provider was
  // mounted with. That is enough because a cart never changes warehouse while
  // mounted: the New order and New rental pages key this provider by their
  // warehouse, and the public order link reloads the page, so a different
  // warehouse is always a new mount, and this effect runs again and restores
  // that warehouse's own draft. A provider that outlived a warehouse change
  // would keep the first warehouse's cart and save under its key (the New
  // order bug found on 2026-09-26).
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(`${draftPrefix}${initial.warehouseId}`);
      if (raw) {
        const parsed = JSON.parse(raw) as CartState;
        if (parsed && parsed.warehouseId === initial.warehouseId) {
          dispatch({ type: 'hydrate', state: parsed });
        }
      }
    } catch {
      /* corrupted draft = ignore */
    } finally {
      // Signal AFTER the hydrate dispatch is queued so a prefill effect that
      // waits on `hydrated` applies on top of the restored draft, never under it.
      setHydrated(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    const key = `${draftPrefix}${state.warehouseId}`;
    const t = setTimeout(() => {
      if (pendingSaves.get(key) === t) pendingSaves.delete(key);
      try {
        // ═══ THE SAVE THAT UNDID THE CLEAR ═══
        //
        // This effect runs on EVERY state change, so the dispatches inside
        // handleDone re-wrote the draft milliseconds after clearCartDraft()
        // deleted it — carrying the finished order's requester and needed-by
        // date straight back into localStorage, where the next visit hydrated
        // them. Clearing the key was never going to hold while the writer
        // immediately put it back.
        //
        // A pristine cart now REMOVES the key instead of persisting an empty
        // draft. Removing rather than skipping matters: skipping would leave a
        // stale draft on disk when a shopper empties their basket, which is the
        // resurrection bug pointed the other way.
        if (isPristineCart(state)) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(state));
      } catch {
        /* quota exceeded — silent fail; draft is best-effort. */
      }
    }, SAVE_DEBOUNCE_MS);
    pendingSaves.set(key, t);
    return () => {
      clearTimeout(t);
      if (pendingSaves.get(key) === t) pendingSaves.delete(key);
    };
  }, [state, draftPrefix]);

  return (
    <CartContext.Provider value={{ state, dispatch, hydrated }}>
      {children}
    </CartContext.Provider>
  );
}

export function useCart() {
  const ctx = React.useContext(CartContext);
  if (!ctx) {
    throw new Error('useCart must be used inside <CartProvider>');
  }
  return ctx;
}

/**
 * Call after a successful submit so the next visit to /orders/new
 * starts from a blank cart instead of resurrecting the just-placed
 * order. Safe to call even if no draft exists. Pass the same `draftPrefix`
 * the page's CartProvider uses. It also cancels that draft's save still
 * waiting on the debounce (see pendingSaves above); a change made to the cart
 * afterwards is saved as usual.
 */
export function clearCartDraft(warehouseId: string, draftPrefix: string = ORDER_DRAFT_PREFIX) {
  const key = `${draftPrefix}${warehouseId}`;
  const pending = pendingSaves.get(key);
  if (pending !== undefined) {
    clearTimeout(pending);
    pendingSaves.delete(key);
  }
  try {
    localStorage.removeItem(key);
  } catch {
    /* noop */
  }
}
