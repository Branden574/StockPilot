/**
 * WHERE STOCK WITH NO WAREHOUSE IS PLACED (B38).
 *
 * The organization-level Staging and Unplaced buckets (migration 0194,
 * ensure_org_placement_locations) are locations with no warehouse. Stock lands
 * there when its item had no warehouse at the time. The Staging page lists a
 * holding only when its item is readable, and inventory_items_select reads an
 * item through its warehouse (a NULL warehouse matches none), so such a row is
 * in practice an item that has a warehouse now, whose units still sit in the
 * organization's bucket. Order readiness counts that Staging as "here" for
 * every order (0377: a location with no warehouse is never foreign) and offers
 * "Put away" for it, but the web table never offered Place for a row with no
 * warehouse: its destinations were the holding's own warehouse's racks, and it
 * had none. The put-away the order page sent people to was a dead end.
 *
 * A row with no warehouse now picks the warehouse first, then a rack or crate
 * in it, and places through the same actions as every other row
 * (placeStockAction, bulkPlaceStockAction, then transfer_stock). Nothing about
 * the move is new on the server: transfer_stock (0365) lets a member below
 * manager take stock out of a location with no warehouse
 * (caller_can_write_location answers true for one) and put it only into a
 * warehouse they write. A new rack or crate is checked before it exists: each
 * place action reads its warehouse under the caller's own access
 * (warehouses_select hides one a staff member is not assigned to), and the
 * placement mint refuses one they do not write
 * (LocationsService.mintPlacementDestination).
 *
 * Pure: the table and both dialogs import it.
 */

/** A warehouse the stock may be placed into. */
export interface PlaceWarehouseOption {
  id: string;
  name: string;
}

/**
 * The warehouses a row with no warehouse may be placed into, by name: the
 * page's warehouse names (WarehousesService.listNames, the active warehouses
 * the viewer can read under warehouses_select). For anyone who may place, that
 * is the warehouses they can write: managers and above read and write every
 * warehouse, and staff read and write exactly the ones assigned to them.
 */
export function placeWarehouseOptions(
  names: Readonly<Record<string, string>>,
): PlaceWarehouseOption[] {
  return Object.entries(names)
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * The warehouse the picker opens on: the preferred one (the item's own
 * warehouse, where readiness counts the stock once it is placed) when it is
 * offered, else the only one offered, else none ('').
 */
export function initialPlaceWarehouse(
  options: readonly PlaceWarehouseOption[],
  preferred: string | null | undefined,
): string {
  if (preferred && options.some((o) => o.id === preferred)) return preferred;
  return options.length === 1 ? options[0]!.id : '';
}

/**
 * Whether a row offers Place: the viewer may place (stock:transfer), and the
 * row has a warehouse or there is one to choose.
 */
export function stagingRowPlaceable(
  row: { warehouseId: string | null },
  canPlace: boolean,
  options: readonly PlaceWarehouseOption[],
): boolean {
  return canPlace && (row.warehouseId !== null || options.length > 0);
}

/** The disabled Place button's reason: a row with no warehouse, and no
 *  warehouse the viewer could place it into. */
export const NO_PLACE_WAREHOUSE_REASON = 'No warehouse to place it in';

/** Under the warehouse picker of a row with no warehouse. */
export const PLACE_WAREHOUSE_HINT =
  'This stock is not in any warehouse yet. Choose the warehouse it goes to, then its rack or crate.';

/**
 * Where a bulk placement lands, from the selected rows. A rack or crate belongs
 * to one warehouse, so one destination serves one warehouse:
 *  - `one`: every row that has a warehouse has this one; rows with none join it;
 *  - `choose`: no row has a warehouse, so the person picks one;
 *  - `several`: rows from more than one warehouse, which is refused.
 */
export type BulkPlaceWarehouseScope =
  { kind: 'one'; warehouseId: string } | { kind: 'choose' } | { kind: 'several' };

export function bulkPlaceWarehouseScope(
  rows: ReadonlyArray<{ warehouseId: string | null }>,
): BulkPlaceWarehouseScope {
  const ids = [...new Set(rows.map((r) => r.warehouseId).filter((w): w is string => w !== null))];
  if (ids.length > 1) return { kind: 'several' };
  if (ids.length === 1) return { kind: 'one', warehouseId: ids[0]! };
  return { kind: 'choose' };
}

/** The one item warehouse every row with no warehouse shares, or null (none
 *  of them, or not all the same). The bulk picker's preferred warehouse. */
export function sharedItemWarehouse(
  rows: ReadonlyArray<{ warehouseId: string | null; itemWarehouseId?: string | null }>,
): string | null {
  const ids = new Set(
    rows.filter((r) => r.warehouseId === null).map((r) => r.itemWarehouseId ?? null),
  );
  if (ids.size !== 1) return null;
  return [...ids][0] ?? null;
}

/** The bulk dialog's sentence when rows from several warehouses are selected. */
export const BULK_PLACE_SEVERAL_WAREHOUSES_COPY =
  'The selected items span multiple warehouses. Select items from a single warehouse to place them together.';

/** The bulk dialog's note when some selected rows have no warehouse and the
 *  others decide it: "2 selected rows are not in any warehouse yet and go to
 *  Main Warehouse too." */
export function bulkPlaceJoinWarehouseNote(count: number, warehouseName: string): string {
  return count === 1
    ? `1 selected row is not in any warehouse yet and goes to ${warehouseName} too.`
    : `${count} selected rows are not in any warehouse yet and go to ${warehouseName} too.`;
}
