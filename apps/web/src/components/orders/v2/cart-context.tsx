'use client';

import * as React from 'react';

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
// prefix. Orders keeps the original one, so its saved drafts still restore.
export const ORDER_DRAFT_PREFIX = 'order-draft:';
export const RENTAL_DRAFT_PREFIX = 'rental-draft:';
const SAVE_DEBOUNCE_MS = 250;

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
  };
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
      // Old persisted drafts predate neededBy — default it in.
      return { ...action.state, neededBy: action.state.neededBy ?? '' };
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
    case 'dec':
      return {
        ...state,
        lines: state.lines.flatMap((l) => {
          if (l.itemId !== action.itemId) return [l];
          if (l.quantity <= 1) return [];
          return [{ ...l, quantity: l.quantity - 1 }];
        }),
      };
    case 'set-qty': {
      // Quantity ≤ 0 drops the line so the same action covers
      // "clear by typing 0" and "set to N".
      if (action.quantity <= 0) {
        return {
          ...state,
          lines: state.lines.filter((l) => l.itemId !== action.itemId),
        };
      }
      const exists = state.lines.some((l) => l.itemId === action.itemId);
      if (!exists) {
        return {
          ...state,
          lines: [...state.lines, { itemId: action.itemId, quantity: action.quantity }],
        };
      }
      return {
        ...state,
        lines: state.lines.map((l) =>
          l.itemId === action.itemId ? { ...l, quantity: action.quantity } : l,
        ),
      };
    }
    case 'remove':
      return {
        ...state,
        lines: state.lines.filter((l) => l.itemId !== action.itemId),
      };
    case 'clear':
      // BASKET ONLY. The setup answers (requester, charter, dates, notes) are
      // deliberately untouched — this is the "empty my basket" button, pressed
      // mid-order, and wiping who the order is for would be its own surprise.
      // The end-of-order wipe is `reset`.
      return { ...state, lines: [] };
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
    case 'set-warehouse':
      return { ...state, warehouseId: action.warehouseId, lines: [] };
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

  // Hydration is a one-shot on mount — re-running it on warehouseId
  // change would clobber the `set-warehouse` action's deliberate cart
  // clear with the previous warehouse's draft.
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
    const t = setTimeout(() => {
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
        const key = `${draftPrefix}${state.warehouseId}`;
        if (isPristineCart(state)) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(state));
      } catch {
        /* quota exceeded — silent fail; draft is best-effort. */
      }
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
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
 * the page's CartProvider uses.
 */
export function clearCartDraft(warehouseId: string, draftPrefix: string = ORDER_DRAFT_PREFIX) {
  try {
    localStorage.removeItem(`${draftPrefix}${warehouseId}`);
  } catch {
    /* noop */
  }
}
