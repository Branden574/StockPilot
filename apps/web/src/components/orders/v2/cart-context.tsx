'use client';

import * as React from 'react';

import type { CartAction, CartState } from './types';

const STORAGE_PREFIX = 'order-draft:';
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
}

const CartContext = React.createContext<CartContextValue | null>(null);

/**
 * Wraps the picker in cart state. Hydrates from localStorage on
 * mount (so SSR doesn't see device-specific cart data), then
 * debounce-saves on every change. localStorage key is scoped per
 * warehouseId so swapping warehouses doesn't trample the other
 * warehouse's draft.
 */
export function CartProvider({
  initial,
  children,
}: {
  initial: CartState;
  children: React.ReactNode;
}) {
  const [state, dispatch] = React.useReducer(cartReducer, initial);

  // Hydration is a one-shot on mount — re-running it on warehouseId
  // change would clobber the `set-warehouse` action's deliberate cart
  // clear with the previous warehouse's draft.
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(`${STORAGE_PREFIX}${initial.warehouseId}`);
      if (!raw) return;
      const parsed = JSON.parse(raw) as CartState;
      if (parsed && parsed.warehouseId === initial.warehouseId) {
        dispatch({ type: 'hydrate', state: parsed });
      }
    } catch {
      /* corrupted draft = ignore */
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
        const key = `${STORAGE_PREFIX}${state.warehouseId}`;
        if (isPristineCart(state)) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(state));
      } catch {
        /* quota exceeded — silent fail; draft is best-effort. */
      }
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [state]);

  return (
    <CartContext.Provider value={{ state, dispatch }}>
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
 * order. Safe to call even if no draft exists.
 */
export function clearCartDraft(warehouseId: string) {
  try {
    localStorage.removeItem(`${STORAGE_PREFIX}${warehouseId}`);
  } catch {
    /* noop */
  }
}
