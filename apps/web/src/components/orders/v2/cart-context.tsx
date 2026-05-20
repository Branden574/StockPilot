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
    lines: [],
  };
}

export function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case 'hydrate':
      return action.state;
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
      return { ...state, lines: [] };
    case 'set-setup':
      return { ...state, ...action.patch };
    case 'set-notes':
      return { ...state, notes: action.value };
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
        localStorage.setItem(
          `${STORAGE_PREFIX}${state.warehouseId}`,
          JSON.stringify(state),
        );
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
