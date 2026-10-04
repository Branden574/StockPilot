'use client';

import * as React from 'react';

import { cartReducer, fitKitShares, initialCartState, isPristineCart } from '@stockpilot/core';

import type { CartAction, CartState } from './types';

// ═══ ONE DRAFT PER PAGE, NOT ONE PER WAREHOUSE ═══
//
// The New rental page reuses this cart, and it used to save under the Orders
// key. Both pages then read and wrote the SAME `order-draft:<warehouse>`
// draft: an Orders basket opened inside the rental cart, which drew only the
// lines it could find in its rental catalog and still submitted the rest, so
// checkout failed with "One or more items are not rental items." (Demo Co,
// 2026-09-24). The other direction put rental lines in the Orders basket, and
// a finished rental deleted the Orders draft. Each page now names its own
// prefix.
//
// ═══ THE ORDERS DRAFT BELONGS TO ONE ACCOUNT (phone ordering PO-2, judge X-1) ═══
//
// `order-draft:<warehouse>` belonged to no account: on a shared front-desk
// browser the next person to sign in opened the last person's cart, with that
// person's on-behalf name and email. The New order page now saves under
// `order-draft:v2:<userId>:<warehouse>` (orderDraftPrefixFor). A draft under
// the old key is adopted ONCE, by the first signed-in person who opens that
// warehouse, with its on-behalf name and email removed, and the old key is
// deleted (legacyDraftPrefix below), so nobody's unsent cart vanishes at the
// deploy. The public link (`public:`) and rentals keep their own prefixes.
export const ORDER_DRAFT_PREFIX = 'order-draft:';
export const RENTAL_DRAFT_PREFIX = 'rental-draft:';
/** The New order page's draft prefix for one account. */
export function orderDraftPrefixFor(userId: string): string {
  return `${ORDER_DRAFT_PREFIX}v2:${userId}:`;
}
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

// ═══ THE REDUCER LIVES IN CORE ═══
//
// initialCartState, fitKitShares, isPristineCart and cartReducer moved,
// unchanged, to @stockpilot/core (orders/storefront/cart.ts) so the phone runs
// the same cart rules as this page (phone ordering PO-1). They are re-exported
// under the names this module always exported. isPristineCart is used by the
// save effect below and, as before, is not exported from here. Storage stays
// here: the debounced localStorage draft is the web's own.
export { cartReducer, fitKitShares, initialCartState };

interface CartContextValue {
  state: CartState;
  dispatch: React.Dispatch<CartAction>;
  /**
   * True once the one-shot localStorage hydration has run. A one-shot prefill
   * (Start an order from Items) gates on this so its added lines land ON TOP of
   * a restored draft instead of being clobbered by a later hydrate dispatch.
   */
  hydrated: boolean;
  /**
   * True while an order request sent from this cart is not settled (phone
   * ordering PO-2): every change to the cart is ignored (`dispatch` drops all
   * but `hydrate` and `reset`), so the body sent under a submission key can
   * never differ from a resend's. Screens read it to disable their controls.
   */
  locked: boolean;
  /** Lock or unlock the cart. Takes effect at once (a ref), before the next
   *  render, so a tap in the same tick cannot change a cart being sent. */
  setLocked: (locked: boolean) => void;
}

/** The only cart actions a locked cart accepts. */
const LOCKED_CART_ACTIONS: ReadonlySet<CartAction['type']> = new Set(['hydrate', 'reset']);

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
  legacyDraftPrefix,
  children,
}: {
  initial: CartState;
  draftPrefix?: string;
  /**
   * A prefix this page used to save under (the New order page's account-less
   * `order-draft:`). When no draft exists under `draftPrefix`, a draft under
   * this one is adopted once, with its on-behalf name and email removed, and
   * the old key is deleted.
   */
  legacyDraftPrefix?: string;
  children: React.ReactNode;
}) {
  const [state, rawDispatch] = React.useReducer(cartReducer, initial);
  const [hydrated, setHydrated] = React.useState(false);
  const [locked, setLockedState] = React.useState(false);
  const lockedRef = React.useRef(false);
  const setLocked = React.useCallback((next: boolean) => {
    lockedRef.current = next;
    setLockedState(next);
  }, []);
  const dispatch = React.useCallback<React.Dispatch<CartAction>>((action) => {
    if (lockedRef.current && !LOCKED_CART_ACTIONS.has(action.type)) return;
    rawDispatch(action);
  }, []);

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
      } else if (legacyDraftPrefix !== undefined && legacyDraftPrefix !== draftPrefix) {
        const legacyKey = `${legacyDraftPrefix}${initial.warehouseId}`;
        const legacyRaw = localStorage.getItem(legacyKey);
        if (legacyRaw) {
          // Removed first: a draft that fails to parse is not adopted by the
          // next person either.
          localStorage.removeItem(legacyKey);
          const parsed = JSON.parse(legacyRaw) as CartState;
          if (parsed && parsed.warehouseId === initial.warehouseId) {
            // Nobody's on-behalf name or email passes to another account.
            dispatch({ type: 'hydrate', state: { ...parsed, onBehalfOf: null } });
          }
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
    <CartContext.Provider value={{ state, dispatch, hydrated, locked, setLocked }}>
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
