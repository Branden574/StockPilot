// Kits on the New order page: pure logic, no React.
//
// A kit is a bundle (Bundles module) offered on the order page. "Add kit" puts
// the bundle's items into the cart as ORDINARY LINES, one per item row, so
// approval, stock holds, picking, returns and emails work exactly as they do
// for an order built by hand (owner decision 2026-09-27, Option A). Nothing
// after Submit knows a kit was used, apart from an audit note.
//
// ═══ ONE COMPONENT, EVERY RACK OF ITS SKU ═══
//
// A bundle component names ONE item row (bundle_components.item_id), and an
// item row sits on one rack. DC4 keeps the New Hire backpack (SKU SP-X6IN2-E84)
// as two rows: 16-B with 134 and 18-A with 60, and the bundle names 18-A. The
// owner's rule (2026-09-27): inside the kit, a component counts the TOTAL of
// every orderable row with the same SKU at this warehouse, the way a person
// ordering Chromebooks thinks of "all the Chromebooks", so the backpack counts
// 194, not 60. Outside the kit card nothing changes: one card per row.
//
// The rows a component may use are resolved on the server
// (server/loaders/orders-kits.ts) from the viewer's own catalog, so a row the
// viewer cannot order is never a candidate.
//
// ═══ WHERE A KIT'S UNITS GO (the allocation rule) ═══
//
// Raising the kit count needs `need` more units of a component. They go:
//   1. To ONE row that can take all of them (one line, one rack to pick). When
//      several can, the row the bundle names wins; otherwise the row with the
//      most left.
//   2. Otherwise they are split across rows, the row with the most left first
//      (the bundle's row first on a tie), so the cart may show two lines for one
//      component, one per rack.
// "Left" is available (on hand minus open reservations) minus what the cart
// already holds on that row, from any source.
//
// Lowering the kit count takes the kit's OWN units back off. What the kit keeps
// is placed by the same rule, within the units it already holds on each row: so
// 150 kits (134 on 16-B, 16 on 18-A) lowered to 3 keeps 3 on 18-A, the row a
// fresh 3 would have used, and lowered to 130 keeps one line of 130 on 16-B.
// Units added by hand are never taken: the cart records how many units each kit
// put on each row (CartState.kits), and a line changed by hand shrinks that
// record with it (cart-context.tsx). THE LIMIT: the cart cannot tell a unit
// added by the kit from one added by hand once both sit on one line; it only
// knows the kit's count, so after hand edits the kit gives back at most what it
// put there and never more than the line holds.
//
// ═══ ALL OR NOTHING ═══
//
// A change either fits every component or changes nothing. The old "Add full
// kit" button quietly skipped short items; a kit must never go into the cart
// with a piece missing.

import type { CartKitShares, CartLineState, CatalogItem } from '../v2/types';

import { availableOf, type CategoryFilter, type ItemStatus } from './storefront-logic';

/** One required component of a kit, resolved for this viewer at this warehouse. */
export interface KitComponent {
  /** The row the bundle names (bundle_components.item_id). */
  anchorItemId: string;
  /**
   * Every row of the viewer's catalog at this warehouse with the anchor's SKU
   * (and ownership charter): the anchor first when it is orderable, then by
   * rack. Never empty.
   */
  itemIds: string[];
  /** Units of this component in one kit: a whole number, 1 or more. */
  perKit: number;
}

/** A bundle offered as a kit on the New order page. */
export interface KitOffer {
  bundleId: string;
  name: string;
  sku: string | null;
  /** Required components only. Never empty. */
  components: KitComponent[];
}

/**
 * What the kits loader answered. `error` is a read that failed: the page says
 * kits could not be loaded, and never shows it as "no kits".
 */
export type KitsResult = { status: 'ok'; kits: KitOffer[] } | { status: 'error' };

/** One cart change a kit plan makes: `delta` units on `itemId` (negative takes off). */
export interface KitLineChange {
  itemId: string;
  delta: number;
}

export type KitPlan =
  | { ok: true; changes: KitLineChange[] }
  | {
      ok: false;
      /** The first component that cannot supply its share. */
      short: KitComponent;
    };

type ItemLookup = ReadonlyMap<string, CatalogItem>;
type QtyLookup = ReadonlyMap<string, number>;

/** The catalog rows of a component that the page actually holds, in its order. */
export function componentRows(component: KitComponent, itemMap: ItemLookup): CatalogItem[] {
  return component.itemIds.flatMap((id) => {
    const item = itemMap.get(id);
    return item ? [item] : [];
  });
}

/** The component's display row: the first row the page holds (anchor first). */
export function componentItem(component: KitComponent, itemMap: ItemLookup): CatalogItem | null {
  return componentRows(component, itemMap)[0] ?? null;
}

/** Units of a component available across every row of its SKU. */
export function componentAvailable(component: KitComponent, itemMap: ItemLookup): number {
  return componentRows(component, itemMap).reduce((sum, row) => sum + availableOf(row), 0);
}

export interface KitAvailability {
  /** Whole kits the rows can supply, ignoring the cart. */
  kits: number;
  /** The component with the fewest kits' worth (the first on a tie), with its units. */
  limiting: { component: KitComponent; available: number } | null;
  /** Components that cannot supply even one kit. */
  short: KitComponent[];
}

/**
 * Kits available = the smallest, across components, of (units available ÷ units
 * per kit), rounded down. The same available figure the item cards show.
 */
export function kitAvailability(kit: KitOffer, itemMap: ItemLookup): KitAvailability {
  let kits = Number.POSITIVE_INFINITY;
  let limiting: KitAvailability['limiting'] = null;
  const short: KitComponent[] = [];
  for (const component of kit.components) {
    const available = componentAvailable(component, itemMap);
    const worth = Math.floor(available / component.perKit);
    if (worth < 1) short.push(component);
    if (worth < kits) {
      kits = worth;
      limiting = { component, available };
    }
  }
  // A kit with no components is never offered (the loader drops it), and must
  // never read as unlimited if one slips through.
  return { kits: Number.isFinite(kits) ? kits : 0, limiting, short };
}

/** The kit's recorded units on a row, never more than the cart line holds. */
function heldOn(itemId: string, shares: CartKitShares | undefined, qty: QtyLookup): number {
  const share = shares?.[itemId] ?? 0;
  return Math.max(0, Math.min(share, qty.get(itemId) ?? 0));
}

/** Units of a component this kit holds in the cart, across its rows. */
function componentHeld(
  component: KitComponent,
  shares: CartKitShares | undefined,
  qty: QtyLookup,
): number {
  return component.itemIds.reduce((sum, id) => sum + heldOn(id, shares, qty), 0);
}

/**
 * Kits in the cart = the smallest, across components, of (units the kit put in
 * the cart ÷ units per kit), rounded down. Only units added through the kit
 * count; the same items added by hand do not make a kit.
 */
export function kitsInCart(
  kit: KitOffer,
  shares: CartKitShares | undefined,
  qty: QtyLookup,
): number {
  if (kit.components.length === 0) return 0;
  let kits = Number.POSITIVE_INFINITY;
  for (const component of kit.components) {
    kits = Math.min(kits, Math.floor(componentHeld(component, shares, qty) / component.perKit));
  }
  return Number.isFinite(kits) ? kits : 0;
}

/** Units still free on a row: available minus everything the cart holds on it. */
function leftOn(row: CatalogItem, qty: QtyLookup): number {
  return Math.max(0, availableOf(row) - (qty.get(row.id) ?? 0));
}

/**
 * The most kits the cart can hold right now: for each component, what the kit
 * already holds plus what is still free on its rows.
 */
export function maxKits(
  kit: KitOffer,
  itemMap: ItemLookup,
  shares: CartKitShares | undefined,
  qty: QtyLookup,
): number {
  if (kit.components.length === 0) return 0;
  let kits = Number.POSITIVE_INFINITY;
  for (const component of kit.components) {
    const held = componentHeld(component, shares, qty);
    const free = componentRows(component, itemMap).reduce((sum, row) => sum + leftOn(row, qty), 0);
    kits = Math.min(kits, Math.floor((held + free) / component.perKit));
  }
  return Number.isFinite(kits) ? kits : 0;
}

/**
 * Where `need` more units of one component go (see the header). null when the
 * rows cannot supply them all.
 */
export function allocateUnits(
  need: number,
  rows: ReadonlyArray<{ itemId: string; left: number }>,
  anchorItemId: string,
): KitLineChange[] | null {
  if (need <= 0) return [];
  const usable = rows.filter((r) => r.left > 0);
  const covering = usable.filter((r) => r.left >= need);
  if (covering.length > 0) {
    const anchor = covering.find((r) => r.itemId === anchorItemId);
    const pick =
      anchor ??
      [...covering].sort((a, b) => b.left - a.left || compareIds(a.itemId, b.itemId))[0]!;
    return [{ itemId: pick.itemId, delta: need }];
  }
  const total = usable.reduce((sum, r) => sum + r.left, 0);
  if (total < need) return null;
  const ordered = [...usable].sort(
    (a, b) =>
      b.left - a.left ||
      Number(b.itemId === anchorItemId) - Number(a.itemId === anchorItemId) ||
      compareIds(a.itemId, b.itemId),
  );
  const out: KitLineChange[] = [];
  let remaining = need;
  for (const r of ordered) {
    if (remaining === 0) break;
    const take = Math.min(r.left, remaining);
    out.push({ itemId: r.itemId, delta: take });
    remaining -= take;
  }
  return out;
}

/**
 * Takes `excess` of the kit's own units back off a component's rows. What stays
 * is placed by allocateUnits over the units the kit holds on each row, so the
 * kit ends on the rows a fresh add of that many would choose, as far as its
 * current rows allow (one row that can hold it all, the bundle's row first,
 * otherwise the rows holding the most). Never takes more than the kit holds on
 * a row.
 */
export function releaseUnits(
  excess: number,
  held: ReadonlyArray<{ itemId: string; held: number }>,
  anchorItemId: string,
): KitLineChange[] {
  if (excess <= 0) return [];
  const holding = held.filter((h) => h.held > 0);
  const total = holding.reduce((sum, h) => sum + h.held, 0);
  const keep =
    allocateUnits(
      Math.max(0, total - excess),
      holding.map((h) => ({ itemId: h.itemId, left: h.held })),
      anchorItemId,
    ) ?? [];
  const kept = new Map(keep.map((k) => [k.itemId, k.delta]));
  return holding.flatMap((h) => {
    const give = h.held - (kept.get(h.itemId) ?? 0);
    return give > 0 ? [{ itemId: h.itemId, delta: -give }] : [];
  });
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The cart changes that make the kit count `target`: every component tops up
 * to (target × per kit) or gives back its excess. All or nothing: if any
 * component cannot supply its units, nothing changes and `short` names it.
 */
export function planKitChange(
  kit: KitOffer,
  target: number,
  itemMap: ItemLookup,
  shares: CartKitShares | undefined,
  qty: QtyLookup,
): KitPlan {
  const goal = Number.isFinite(target) ? Math.max(0, Math.floor(target)) : 0;
  const changes: KitLineChange[] = [];
  for (const component of kit.components) {
    const want = goal * component.perKit;
    const held = componentHeld(component, shares, qty);
    if (want > held) {
      const rows = componentRows(component, itemMap).map((row) => ({
        itemId: row.id,
        left: leftOn(row, qty),
      }));
      const adds = allocateUnits(want - held, rows, component.anchorItemId);
      if (adds === null) return { ok: false, short: component };
      changes.push(...adds);
    } else if (want < held) {
      changes.push(
        ...releaseUnits(
          held - want,
          component.itemIds.map((id) => ({ itemId: id, held: heldOn(id, shares, qty) })),
          component.anchorItemId,
        ),
      );
    }
  }
  return { ok: true, changes };
}

/** The kits used, for the order's audit entry: only kits with at least one in the cart. */
export function kitsForAudit(
  kits: readonly KitOffer[],
  cartKits: Readonly<Record<string, CartKitShares>>,
  lines: readonly CartLineState[],
): Array<{ bundleId: string; count: number }> {
  const qty = new Map(lines.map((l) => [l.itemId, l.quantity]));
  return kits.flatMap((kit) => {
    const count = kitsInCart(kit, cartKits[kit.bundleId], qty);
    return count > 0 ? [{ bundleId: kit.bundleId, count }] : [];
  });
}

/** 'out' when not one kit is available, otherwise 'ok'. Kits have no reorder point. */
export function kitStatus(kit: KitOffer, itemMap: ItemLookup): ItemStatus {
  return kitAvailability(kit, itemMap).kits > 0 ? 'ok' : 'out';
}

/** Category keys ('uncategorized' for none) of every row the kit can use. */
export function kitCategoryKeys(kit: KitOffer, itemMap: ItemLookup): Set<string> {
  const keys = new Set<string>();
  for (const component of kit.components) {
    for (const row of componentRows(component, itemMap)) {
      keys.add(row.categoryId ?? 'uncategorized');
    }
  }
  return keys;
}

/**
 * The kits a catalog view shows, the same three filters the item grid applies:
 * a category view shows every kit with an item in that category; search matches
 * every token against the kit's name and SKU; an availability filter keeps kits
 * whose status it names.
 */
export function filterKits(
  kits: readonly KitOffer[],
  itemMap: ItemLookup,
  filter: { category: CategoryFilter; search: string; availability: ReadonlySet<ItemStatus> },
): KitOffer[] {
  const tokens = filter.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return kits.filter((kit) => {
    if (filter.category !== 'all' && !kitCategoryKeys(kit, itemMap).has(filter.category)) {
      return false;
    }
    if (tokens.length > 0) {
      const hay = `${kit.name} ${kit.sku ?? ''}`.toLowerCase();
      if (!tokens.every((t) => hay.includes(t))) return false;
    }
    if (filter.availability.size > 0 && !filter.availability.has(kitStatus(kit, itemMap))) {
      return false;
    }
    return true;
  });
}

const PREFIX_BREAK = /[\s\-–—:·/|,]$/;

/**
 * Short names for a kit's item list: the words every name starts with are
 * dropped ("L4L - New Hire - Backpack", "L4L - New Hire - Planner" read
 * "Backpack", "Planner"). Only a prefix ending at a separator is dropped, and
 * only when every name keeps some text; one name, or names with nothing in
 * common, stay whole.
 */
export function shortComponentNames(names: readonly string[]): string[] {
  if (names.length < 2) return [...names];
  let prefix = names[0]!;
  for (const name of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i += 1;
    prefix = prefix.slice(0, i);
  }
  // Back off to the last separator so no word is cut in half.
  while (prefix.length > 0 && !PREFIX_BREAK.test(prefix)) prefix = prefix.slice(0, -1);
  if (prefix.trim() === '') return [...names];
  const short = names.map((n) => n.slice(prefix.length).replace(/^[\s\-–—:·/|,]+/, ''));
  return short.some((s) => s.trim() === '') ? [...names] : short;
}
