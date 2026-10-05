/**
 * The "Make recurring" hand-off: a purchase order's supplier, destination and
 * lines, carried from the PO's page to Recurring purchase orders, where the
 * create form opens filled in with them.
 *
 * TIED TO ONE NAVIGATION. MakeRecurringButton stores the seed under the PO's
 * id (sessionStorage, this tab only) and opens
 * /dashboard/purchase-orders/recurring?from=<that id>. The recurring page takes
 * the seed exactly once (read, then removed) and opens the form only with the
 * seed stored for the PO its address names. So a seed left behind by a
 * Make recurring that never arrived (a click elsewhere mid-navigation, an error
 * page) is removed on the next visit and never opens a form, and one PO's seed
 * never fills in another's. A seed that is there but cannot be used (another
 * PO's, or not a seed) is reported on the page, never dropped in silence.
 *
 * The seed is not trusted: the form is a starting point the buyer reviews, and
 * the template save re-checks every line, supplier and destination on the
 * server.
 */

/** The sessionStorage key. One seed at a time: a newer Make recurring replaces it. */
export const RECURRING_PO_SEED_KEY = 'recurring-po-seed';

/** The search parameter naming the PO a Make recurring navigation came from. */
export const RECURRING_PO_SEED_PARAM = 'from';

export interface RecurringPoSeedLine {
  itemId: string;
  quantityOrdered: number;
  unitCost: number;
}

export interface RecurringPoSeed {
  supplierId: string | null;
  destinationLocationId: string | null;
  lineItems: RecurringPoSeedLine[];
}

export type TakenRecurringPoSeed =
  /** Nothing was stored (or this browser keeps no session storage). */
  | { kind: 'none' }
  | { kind: 'seed'; poId: string; seed: RecurringPoSeed }
  /** Something was stored under the key that is not a seed. */
  | { kind: 'unreadable' };

/** Where Make recurring on purchase order `poId` goes. */
export function recurringPoSeedHref(
  poId: string,
): `/dashboard/purchase-orders/recurring?${string}` {
  return `/dashboard/purchase-orders/recurring?${RECURRING_PO_SEED_PARAM}=${encodeURIComponent(poId)}`;
}

/**
 * Stores the seed of purchase order `poId`, replacing any earlier one. False
 * when the browser refused (site data blocked, storage full): the caller says
 * so and does not navigate, since the page would open without the seed.
 */
export function storeRecurringPoSeed(poId: string, seed: RecurringPoSeed): boolean {
  try {
    sessionStorage.setItem(RECURRING_PO_SEED_KEY, JSON.stringify({ poId, ...seed }));
    return true;
  } catch {
    return false;
  }
}

/** Reads the stored seed and removes it, so it is used at most once. */
export function takeRecurringPoSeed(): TakenRecurringPoSeed {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(RECURRING_PO_SEED_KEY);
    sessionStorage.removeItem(RECURRING_PO_SEED_KEY);
  } catch {
    return { kind: 'none' };
  }
  if (raw === null) return { kind: 'none' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'unreadable' };
  }
  return parseStoredSeed(parsed);
}

function isNullableId(v: unknown): v is string | null {
  return v === null || (typeof v === 'string' && v.length > 0);
}

function isLine(v: unknown): v is RecurringPoSeedLine {
  if (typeof v !== 'object' || v === null) return false;
  const l = v as Record<string, unknown>;
  return (
    typeof l.itemId === 'string' &&
    l.itemId.length > 0 &&
    typeof l.quantityOrdered === 'number' &&
    Number.isFinite(l.quantityOrdered) &&
    typeof l.unitCost === 'number' &&
    Number.isFinite(l.unitCost)
  );
}

function parseStoredSeed(v: unknown): TakenRecurringPoSeed {
  if (typeof v !== 'object' || v === null) return { kind: 'unreadable' };
  const s = v as Record<string, unknown>;
  if (
    typeof s.poId !== 'string' ||
    s.poId.length === 0 ||
    !isNullableId(s.supplierId) ||
    !isNullableId(s.destinationLocationId) ||
    !Array.isArray(s.lineItems) ||
    !s.lineItems.every(isLine)
  ) {
    return { kind: 'unreadable' };
  }
  return {
    kind: 'seed',
    poId: s.poId,
    seed: {
      supplierId: s.supplierId,
      destinationLocationId: s.destinationLocationId,
      lineItems: s.lineItems.map((l) => ({
        itemId: l.itemId,
        quantityOrdered: l.quantityOrdered,
        unitCost: l.unitCost,
      })),
    },
  };
}
