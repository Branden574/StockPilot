// The storefront cart: its state, its actions and its reducer. Pure, no React.
// Moved from apps/web/src/components/orders/v2/cart-context.tsx (the reducer
// half) and v2/types.ts (the cart types) for phone ordering PO-1. The web
// module re-exports every name it exported before; storage (the debounced
// localStorage draft) stays per surface.

export interface CartLineState {
  itemId: string;
  quantity: number;
}

/**
 * Units one kit put on each cart line: itemId → units. A kit's lines are
 * ordinary lines; this only remembers how much of each line came from the kit,
 * so taking the kit out never takes units added by hand (kits.ts).
 */
export type CartKitShares = Record<string, number>;

export interface CartState {
  warehouseId: string;
  charterId: string | null;
  fulfillmentType: 'pickup' | 'delivery';
  onBehalfOf: { name: string; email: string } | null;
  notes: string;
  /** "Needed by" datetime-local value ('YYYY-MM-DDTHH:mm') or ''. Optional;
   *  drives the auto-created schedule event at approval (mig 0255). */
  neededBy: string;
  lines: CartLineState[];
  /**
   * bundleId → the units that kit put on each line. Never more than a line
   * holds: every change to a line by hand shrinks it to fit. A draft saved
   * before kits existed has none and loads with `{}`.
   */
  kits: Record<string, CartKitShares>;
}

export type CartAction =
  | { type: 'hydrate'; state: CartState }
  | { type: 'add'; itemId: string; quantity?: number }
  | { type: 'inc'; itemId: string }
  | { type: 'dec'; itemId: string }
  /** Set exact qty for a line. Quantity <= 0 removes the line entirely
   *  so the same action handles "type 0 to clear" + "type 5 to set". */
  | { type: 'set-qty'; itemId: string; quantity: number }
  | { type: 'remove'; itemId: string }
  /**
   * A kit's planned line changes (kits.ts planKitChange), applied
   * as one step: each line moves by `delta` (a line at 0 or less is removed)
   * and the kit's record of its units moves with it.
   */
  | { type: 'apply-kit'; bundleId: string; changes: Array<{ itemId: string; delta: number }> }
  | { type: 'clear' }
  /**
   * Back to a blank order, keeping only the warehouse and the pickup/delivery
   * mode. Distinct from `clear`, which empties the BASKET mid-order and must
   * leave the setup answers alone. Dispatch this when an order is finished —
   * see handleDone in orders-storefront.tsx.
   */
  | { type: 'reset' }
  | {
      type: 'set-setup';
      patch: Partial<Pick<CartState, 'charterId' | 'fulfillmentType' | 'onBehalfOf'>>;
    }
  | { type: 'set-notes'; value: string }
  | { type: 'set-needed-by'; value: string };

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
export function isPristineCart(state: CartState): boolean {
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
