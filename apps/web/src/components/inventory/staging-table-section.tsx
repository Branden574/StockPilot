import {
  describeStagingItemFilter,
  resolveOrgTimezone,
  STAGING_FILTER_EMPTY_COPY,
  stagingFilterInvalidCopy,
  stagingRowsForOrderWarehouse,
  type StagingFilterParse,
} from '@stockpilot/core';

import { StagingTable } from '@/components/inventory/staging-table';
import { IntentLink } from '@/components/ui/intent-link';
import { getOrgRowForRequest } from '@/lib/dashboard/request-cache';
import { reportError } from '@/lib/error-reporter';
import {
  toDestinationOption,
  type DestinationLocationRow,
  type DestinationOption,
} from '@/lib/locations/destination-option';
import { isSiteLocation } from '@/lib/locations/groups';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';
import { InventoryService } from '@/server/services/inventory';
import { LocationsService } from '@/server/services/locations';
import { OrderRequestsService } from '@/server/services/order-requests';
import { WarehousesService } from '@/server/services/warehouses';

/** The chip's two links: the accent text link of a card header (DESIGN-SPEC 6.7). */
const CHIP_LINK =
  'text-accent hover:text-foreground text-[12.5px] font-medium underline-offset-2 transition-colors hover:underline';

type OrderLink = Awaited<ReturnType<OrderRequestsService['orderLinkLabel']>>;

/**
 * The Staging page's data and table: an async Server Component that streams
 * behind the page's <Suspense>. Fetches the staged worklist and the Place
 * destinations (racks, crates and Sites, grouped by warehouse_id), then passes
 * serializable props to the 'use client' <StagingTable>.
 *
 * PUT AWAY FROM AN ORDER (F2-3). `filter` is the page's `?item=` (repeatable)
 * and `?order=`, parsed by core parseStagingItemFilter. With a usable filter
 * the worklist is read for those items only (in the service's query, batched,
 * the active-warehouse cookie ignored), and a chip says so: "Showing items from
 * SO-000123 · Show all · Back to the order", with the note that only Staging
 * stops a pick (the items' Unplaced rows are listed too). The order's number
 * and warehouse are read BESIDE the worklist, never after it, and never fail
 * the page. The rows are then narrowed to the order's warehouse and to
 * locations with no warehouse (core stagingRowsForOrderWarehouse: what
 * readiness counts as "here"), since another warehouse's Staging never
 * unblocks this order's pick; the chip says when some were left out. A
 * filtered list with nothing in it says so once, in the chip (the table's own
 * "Nothing to place" is for the whole worklist). An unusable filter shows
 * every item and says why.
 *
 * ACCESS is not decided here: with a filter the warehouse cookie is not
 * applied, and the rows are bounded by RLS alone (item_stock_levels_select,
 * 0331 and 0371, and inventory_items' own policy), exactly as the unfiltered
 * list already is for a warehouse-scoped member (their cookie filter is null,
 * lib/warehouse-filter.ts). The narrowing above is a view of those rows.
 *
 * READ-ONLY PARAMS (pattern #18). Nothing here or in StagingTable rewrites
 * `?item` or `?order`: the chip is server-rendered links, and the type tabs
 * copy every other param when they push `?type=`. "Show all" is a plain link.
 * Both chip links are IntentLinks: they warm their route when the person
 * reaches for them, never on sight (a default <Link> prefetched the order page
 * and the whole list on every filtered view).
 */
export async function StagingTableSection({
  itemType,
  filter,
  canPlace,
  canMintDestination,
  organizationId,
}: {
  itemType: 'book' | 'non-book' | undefined;
  filter: StagingFilterParse;
  canPlace: boolean;
  canMintDestination: boolean;
  /** The page's org, for the zone the movement history prints in (L7). */
  organizationId: string;
}) {
  const itemFilter = filter.state === 'ok' ? filter.filter : null;
  const orderId = itemFilter?.orderId ?? null;

  const [inventorySvc, locationsSvc, warehousesSvc, warehouseFilter] = await Promise.all([
    InventoryService.forCurrentUser(),
    LocationsService.forCurrentUser(),
    WarehousesService.forCurrentUser(),
    // With an item filter the cookie is ignored (the ids already narrow the
    // list), so it is not even read.
    itemFilter ? Promise.resolve<string | null>(null) : getActiveWarehouseFilter(),
  ]);

  const [worklist, allLocations, warehouses, orderLink, orgRow] = await Promise.all([
    inventorySvc.stagedWorklist(
      itemFilter
        ? { itemType, itemIds: itemFilter.itemIds }
        : { itemType, warehouseId: warehouseFilter },
    ),
    locationsSvc.list(),
    warehousesSvc.listNames(),
    orderId
      ? OrderRequestsService.forCurrentUser()
          .then((svc) => svc.orderLinkLabel(orderId))
          .catch((): OrderLink => ({ state: 'failed' }))
      : Promise.resolve<OrderLink | null>(null),
    // The org's zone for the rows' movement history (L7: the organization's
    // zone, like counts and orders). Request-cached; a failed read never fails
    // the page, prints in core's documented default zone and is reported, as
    // the calendar's is.
    getOrgRowForRequest(organizationId).catch((e: unknown) => {
      void reportError(e, {
        tag: 'staging.history.org_timezone_failed',
        level: 'warning',
        organizationId,
      });
      return null;
    }),
  ]);
  const timeZone = resolveOrgTimezone(orgRow?.timezone);

  // The order's warehouse, when the order was read: the rows its pick can use.
  const narrowed =
    itemFilter && orderLink?.state === 'ok'
      ? stagingRowsForOrderWarehouse(worklist, orderLink.warehouseId)
      : { rows: worklist, elsewhere: 0 };
  const rows = narrowed.rows;

  // warehouse id → display name for the Warehouse column. list() returns only
  // active warehouses; any staged row pointing at an archived/inactive
  // warehouse simply falls back to the truncated UUID in the table.
  const warehouseNames: Record<string, string> = {};
  for (const w of warehouses) {
    warehouseNames[w.id] = w.name;
  }

  // Build a map of warehouseId → Place destinations for that warehouse: its
  // racks and crates, and its SITE(s).
  //
  // THE SITE (L121). A cancelled pick restocks to Staging, and a warehouse whose
  // stock sits on its Site (no racks: Demo's Main Distribution Center; L4L's
  // no-rack items on DC4) had no screen that could put it back. A Site is
  // kind NULL with a site-ish type — never backfill that kind — so the ONE
  // classifier decides (isSiteLocation): a NULL-kind row typed shelf/bin is a
  // legacy placement and stays out, as do the Staging/Unplaced buckets. Placing
  // onto a Site keeps the item's rack label (placeStockAction).
  //
  // SITES COME LAST, after the racks and crates (slice 3 review, F3). Put-away
  // means shelving: the owner's 2026-09-24 direction is that stock with no rack
  // lands in Unplaced and L4L's DC4 Site stays a label (67 items were moved off
  // it to rack 31-C). A Site at the top of the list would make "DC4 (site)" the
  // first of 87 options, and a mis-pick clears the worklist without shelving
  // anything. The phone's chips follow the same order (offeredDestinationOrder).
  //
  // Each destination carries its rack/crate COLUMNS (migration 0188), not just
  // {id, name, kind}: dropping them is why the put-away dialog could never show
  // which crate an existing destination already is, and why a user had to
  // re-type crate metadata that the location row already held. `name` alone is
  // not a substitute — "Blue #42" is a dedupe key, and parsing a crate back out
  // of it would break the moment someone renames a crate.
  const destinationsByWarehouse = new Map<string, DestinationOption[]>();
  const racksThenSites = [
    ...allLocations.filter((loc) => loc.kind === 'rack' || loc.kind === 'crate'),
    ...allLocations.filter((loc) => isSiteLocation(loc)),
  ];
  for (const loc of racksThenSites) {
    const wid = (loc.warehouse_id as string | null) ?? '__none__';
    if (!destinationsByWarehouse.has(wid)) {
      destinationsByWarehouse.set(wid, []);
    }
    destinationsByWarehouse.get(wid)!.push(toDestinationOption(loc as DestinationLocationRow));
  }

  // Flatten the Map to a plain object so it crosses the RSC → client boundary
  // as serializable JSON. Keys are warehouse IDs (or '__none__').
  const destinationsMap: Record<string, DestinationOption[]> = {};
  for (const [wid, dests] of destinationsByWarehouse) {
    destinationsMap[wid] = dests;
  }

  // The chip. An order that is not there (or Orders is off) has nothing to go
  // back to; one whose read failed keeps its link, without a number.
  const hasOrder = orderId !== null && orderLink !== null && orderLink.state !== 'not_found';
  const chip = itemFilter
    ? describeStagingItemFilter({
        orderNumber: orderLink?.state === 'ok' ? orderLink.orderNumber : null,
        hasOrder,
        itemCount: itemFilter.itemIds.length,
        elsewhere: narrowed.elsewhere,
      })
    : null;
  const showAllHref = itemType
    ? `/dashboard/inventory/staging?type=${itemType}`
    : '/dashboard/inventory/staging';
  const backHref = hasOrder && orderId ? `/dashboard/orders/${orderId}` : null;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {filter.state === 'invalid' && (
        <p
          role="status"
          className="border-border bg-sunk text-muted-foreground rounded-lg border px-4 py-2.5 text-[13px]"
          data-testid="staging-item-filter-invalid"
        >
          {stagingFilterInvalidCopy(filter.reason)}
        </p>
      )}
      {chip && (
        // The put-away-from-an-order notice: a quiet card above the toolbar.
        <div
          className="border-border bg-card rounded-lg border px-4 py-3 text-[13px]"
          data-testid="staging-item-filter"
        >
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className="text-foreground text-[13.5px] font-medium"
              data-testid="staging-item-filter-headline"
            >
              {chip.headline}
            </span>
            <span aria-hidden className="text-ink-4">
              ·
            </span>
            <IntentLink
              href={showAllHref}
              className={CHIP_LINK}
              data-testid="staging-item-filter-show-all"
            >
              {chip.showAllLabel}
            </IntentLink>
            {backHref && chip.backLabel && (
              <>
                <span aria-hidden className="text-ink-4">
                  ·
                </span>
                <IntentLink
                  href={backHref}
                  className={CHIP_LINK}
                  data-testid="staging-item-filter-back"
                >
                  {chip.backLabel}
                </IntentLink>
              </>
            )}
          </p>
          <p
            className="text-muted-foreground mt-1 text-[12px] leading-[18px]"
            data-testid="staging-item-filter-note"
          >
            {chip.note}
          </p>
          {chip.elsewhereNote && (
            <p
              className="text-muted-foreground mt-1 text-[12px] leading-[18px]"
              data-testid="staging-item-filter-elsewhere"
            >
              {chip.elsewhereNote}
            </p>
          )}
          {rows.length === 0 && (
            <p
              className="text-foreground mt-2 text-[12.5px]"
              role="status"
              data-testid="staging-item-filter-empty"
            >
              {STAGING_FILTER_EMPTY_COPY}
            </p>
          )}
        </div>
      )}
      <StagingTable
        rows={rows}
        destinationsMap={destinationsMap}
        warehouseNames={warehouseNames}
        canPlace={canPlace}
        canMintDestination={canMintDestination}
        activeItemType={itemType ?? 'all'}
        // A filtered list says it is empty once, in the chip above.
        hideEmptyState={chip !== null}
        timeZone={timeZone}
      />
    </div>
  );
}
