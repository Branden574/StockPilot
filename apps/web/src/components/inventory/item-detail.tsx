import { History, LineChart, Printer } from 'lucide-react';
import dynamic from 'next/dynamic';
import { getImageProps } from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Suspense, type CSSProperties, type ReactNode } from 'react';

import { ItemActivityPanel } from '@/components/inventory/item-activity-panel';
import {
  ItemVerificationCard,
  ItemVerificationCardSkeleton,
} from '@/components/inventory/item-verification-card';
import { PlacementsBreakdown } from '@/components/inventory/placements-breakdown';
import {
  FigureWithUnit,
  StockAvailabilityLine,
} from '@/components/inventory/stock-availability-line';
import { BarcodeDisplay } from '@/components/inventory/barcode-display';
import { DuplicateItemDialog } from '@/components/inventory/duplicate-item-dialog';
import { GroupMembershipControl } from '@/components/inventory/group-membership-control';
import { MakeOwnItemButton } from '@/components/inventory/make-own-item-button';
// ImageUploader is heavy (canvas resize/transcode + lazy-loaded
// ImageLightbox) and only renders on the Overview tab's Images card —
// lazy-load the chunk so it stays out of the initial item-detail bundle.
// item-detail is a server component, so ssr:false isn't valid; the Images
// card is already conditionally rendered (activeTab === 'overview') so the
// chunk only downloads when the user is on that tab regardless.
const ImageUploader = dynamic(() =>
  import('@/components/inventory/image-uploader').then((m) => ({
    default: m.ImageUploader,
  })),
);
// CostTrendIsland lazy-loads Recharts as a client island (ssr:false) so the
// server shell never pulls Recharts onto the item-detail critical path — the
// chart hydrates after the page paints. item-detail is a server component, so
// importing the client island (which holds the next/dynamic call) is the safe
// boundary here.
import { CostTrendIsland } from '@/components/dashboard/charts/cost-trend-island';
import { ItemDetailTabs } from '@/components/inventory/item-detail-tabs';
import { parseDetailTab, type DetailTabId } from '@/components/inventory/item-detail-tabs-shared';
import { ItemSerialsPanel } from '@/components/inventory/item-serials-panel';
import { PublicVisibilityControl } from '@/components/inventory/public-visibility-control';
import { MarketPricePanel } from '@/components/inventory/market-price-panel';
import { StockStatusBadge } from '@/components/inventory/stock-status-badge';
import { StockAdjustDialog } from '@/components/inventory/stock-adjust-dialog';
import { StockTransferDialog } from '@/components/inventory/stock-transfer-dialog';
import { ReportProblemButton } from '@/components/maintenance/report-problem-button';
import { CountThisItemButton } from '@/components/exceptions/count-this-item-button';
import { DetailSection } from '@/components/patterns/detail-section';
import { KeyValueList, KeyValueRow } from '@/components/patterns/key-value-row';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
import { StatStrip, StatStripItem } from '@/components/patterns/stat-strip';
import { Thumb } from '@/components/patterns/thumb';
import { Button } from '@/components/ui/button';
import { ActivityService, auditLimitFor, type ActivityEvent } from '@/server/services/activity';
import { isModuleEnabled, ServiceError, withContext } from '@/server/services/context';
import { CustomFieldsService } from '@/server/services/custom-fields';
import { InventoryService } from '@/server/services/inventory';
import { ItemGroupingService } from '@/server/services/item-grouping';
import { readDisplayGroupsByItemIds } from '@/server/services/lib/display-groups';
import { ItemImagesService } from '@/server/services/item-images';
import {
  toDestinationOption,
  type DestinationLocationRow,
} from '@/lib/locations/destination-option';
import { canMintPlacementDestination } from '@/lib/locations/placement-destination';
import { LocationsService } from '@/server/services/locations';
import { PriceTrackingService } from '@/server/services/price-tracking';
import { ReportsService, type ItemCostHistory } from '@/server/services/reports';
import { SerialsService, type SerialsPage } from '@/server/services/serials';
import { canStartCount } from '@/server/services/lib/count-start-preflight';
import { WarehousesService } from '@/server/services/warehouses';
import { ITEM_ACTIVITY_PAGE_SIZE, nextActivityCursor } from '@/lib/activity-pagination';
import { formatGrade, getCrateColor, readBookStorage } from '@/lib/book-storage';
import { isNextControlFlowError, reportError } from '@/lib/error-reporter';
import { formatCurrency, formatNumber, formatRelative } from '@/lib/utils';

import {
  can,
  DISPLAY_GROUP_FALLBACK_NAME,
  GROUPING_ERROR_WORDS,
  holdingsContradictRack,
  isCountableItem,
  isLikelyIsbn,
  isManagerOrAbove,
  resolveOrgTimezone,
  sharedSkuNoteCopy,
  type CustomFieldDefinition,
  type ItemElsewhere,
  type Role,
} from '@stockpilot/core';
import { getWarehouseAccess } from '@/lib/auth/warehouse';
import { getOrgRowForRequest } from '@/lib/dashboard/request-cache';
import { placementSummary, transferableHoldings } from '@/lib/placements';
import { PageTour } from '@/components/onboarding/page-tour';
import { PerfUseful } from '@/components/perf/perf-useful';
import { ITEM_DETAIL_TOUR } from '@/lib/onboarding/tours';

interface ItemDetailProps {
  id: string;
  backHref: string;
  backLabel: string;
  /**
   * Where the "Edit" button links. Defaults to the items-tab edit route
   * (/dashboard/inventory/[id]/edit). The Books tab passes a books-tab
   * edit route so the book-specific form (ISBN, grade, rack, crate,
   * author) is shown instead of the generic product form.
   */
  editHref?: string;
  /**
   * Selected tab, from `?tab=overview|movements|activity`. Defaults to
   * `overview` when missing or unknown. The page passes this through
   * from its own `searchParams`.
   */
  tab?: string;
  /**
   * Pre-validated list URL the user came from (decoded — safeReturnPath
   * runs on the page before this prop is set). Threaded into the
   * "Edit" link so the edit page can offer the same round-trip back.
   */
  returnParam?: string;
  /**
   * Sum of ACTIVE stock_reservations against this item (rentals model:
   * checking out a rental reserves stock instead of decrementing on-hand,
   * so available = quantity_on_hand − reserved). ONLY the rentals item
   * detail page passes this; when provided AND > 0, two extra rows
   * ("Out on rental" + "Available") render under "On hand". Inventory and
   * Books detail pages leave it undefined → nothing extra renders, byte-
   * identical to before.
   */
  reservedQuantity?: number;
}

export async function ItemDetail({
  id,
  backHref,
  backLabel,
  editHref,
  tab,
  returnParam,
  reservedQuantity,
}: ItemDetailProps) {
  const activeTab: DetailTabId = parseDetailTab(tab);

  const [ctx, inventorySvc, activitySvc, imagesSvc, locationsSvc, reportsSvc, customFieldsSvc] =
    await Promise.all([
      withContext(),
      InventoryService.forCurrentUser(),
      ActivityService.forCurrentUser(),
      ItemImagesService.forCurrentUser(),
      LocationsService.forCurrentUser(),
      ReportsService.forCurrentUser(),
      CustomFieldsService.forCurrentUser(),
    ]);

  // ── Reads, grouped by what they NEED ─────────────────────────────────
  // Production logs (2026-09-22, Movements/Activity renders of this page)
  // showed about ten Supabase levels in SERIES: request context, the item row,
  // its warehouse access, its holdings, then this fan-out, then the actor
  // lookup inside the activity feed, then the updated-by profile, then two
  // module_enabled RPCs. Postgres answered every one quickly; the time was the
  // gateway, where 3-5% of calls from Vercel stall 1-8 s on weekday daytimes.
  // Renders that met a stall took 6.6 s and 3.6 s against 0.53-0.65 s healthy.
  // In a chain every level pays its own round trip and every stall adds to the
  // next; in parallel they overlap, and a call that is not made cannot stall.
  // So the page now waits on three levels and makes up to three fewer calls
  // (the actor lookup and both RPCs): the context above, then everything that
  // needs only this item's id (the item row among them), then the few reads
  // that need a field OFF the row. The activity feed's own reference-label
  // lookups (only when its rows carry references) overlap that third level.
  //
  // Starting the id-only reads before the row is known changes nothing about
  // WHO may see WHAT. Every one runs on the caller's own RLS client, and none
  // of their results is used until `inventorySvc.get` has returned the row,
  // which is where not-found and the warehouse-access check live: when it
  // throws, the page is notFound() (or the error) and those results are
  // dropped unread. The dependent reads further down (category, supplier,
  // profile, signed photo URLs, market price) only start after it returns.
  // `withElsewhere` (0371): the item's stock in warehouses the caller cannot
  // see, asked alongside the row (managers and above make no call). The page's
  // "placed + awaiting put-away = on hand" line, the placement breakdown and
  // the transfer dialog's empty state all need it, or a staff member's page
  // presents part of the stock as all of it.
  const itemRead = inventorySvc.get(id, { withUpdater: true, withElsewhere: true });
  // TRANSFER DESTINATIONS for a scoped member (owner decision Q4, 0371): only
  // warehouses they can write, plus locations with no warehouse. Offering any
  // other destination can only end in the server's 403 (0365). Null =
  // unrestricted. Manager+ never read it; for a staff member it is the same
  // request-cached access read get() makes for this context, so it costs no
  // extra call. A failed read narrows to no warehouse at all (fail closed; the
  // server still decides).
  const canTransferStockEarly = can(ctx, 'stock:transfer');
  const destinationScopeRead: Promise<string[] | null> =
    canTransferStockEarly && !isManagerOrAbove(ctx.role as Role)
      ? getWarehouseAccess(ctx)
          .then((access) => (access.hasAllAccess ? null : access.writableIds))
          .catch(() => [] as string[])
      : Promise.resolve(null);
  const serialsSvc = new SerialsService(ctx);
  // OVERVIEW-ONLY READS STAY ON OVERVIEW. A Movements or Activity click is a
  // query-only navigation, and Next re-renders this whole page for it (the page
  // segment is keyed with its query: segment.js PAGE_SEGMENT_KEY + '?' + query).
  // That render used to wait on every read the Overview panel shows: photos and
  // their signing, cost history, custom field definitions, serials (and warehouse
  // names), reservations, category, supplier, market price. About nineteen
  // Supabase calls where the tab needs about ten, and each extra call is another
  // chance to meet a gateway stall (3-5% of calls from Vercel on weekday
  // daytimes, 1-8 s each). Worse, a failed photo or cost read failed the TAB,
  // which never shows either. The header and footer (name, stock, the adjust
  // and transfer dialogs, "last updated by") read the same things on every tab,
  // so only what the Overview panel alone renders is skipped. The mirror image
  // of `activityRead` below, which Overview skips.
  const isOverview = activeTab === 'overview';
  const locationsRead = locationsSvc.list();
  // Per-location stock levels for the transfer dialog — keeps the dialog's
  // source list accurate after mig 0192 moved stock out of primary_location_id.
  const holdingsRead = inventorySvc.placements(id);
  // Deferred to the Movements/Activity tabs: ActivityService.forItem runs
  // two base queries plus batched lookups (receipt→PO, reference labels) —
  // real cost the Overview tab was paying on every load even though it never
  // renders the feed. Mirrors mobile's item/[id].tsx, which only calls
  // loadMovements() when its Movements tab is active.
  //
  // A failed feed read is the tab's to report, not the page's: null here, and
  // the panel says it could not load (with a retry) instead of the whole item
  // page failing, or an empty feed that reads as "no history".
  const activityRead: Promise<ActivityEvent[] | null> =
    activeTab === 'movements' || activeTab === 'activity'
      ? activitySvc.forItem(id, ITEM_ACTIVITY_PAGE_SIZE).catch((e: unknown) => {
          if (isNextControlFlowError(e)) throw e;
          void reportError(e, { tag: 'item-detail.activity', organizationId: ctx.organizationId });
          return null;
        })
      : Promise.resolve<ActivityEvent[]>([]);
  // THE FEED'S ZONE (L7, owner decision Q1; slice 3 review F2). Both feed tabs
  // print every row's date and time in the ORGANIZATION's zone, like the
  // Movements page, counts and orders. Read beside the feed, never after it:
  // request-cached and normally already in hand from the request context, so
  // it is not another round trip. A failed read never fails the tab; it prints
  // in core's documented default zone. Overview shows no feed and never asks.
  const feedTimeZoneRead: Promise<string> =
    activeTab === 'movements' || activeTab === 'activity'
      ? getOrgRowForRequest(ctx.organizationId)
          .then((row) => resolveOrgTimezone(row?.timezone))
          .catch(() => resolveOrgTimezone(null))
      : Promise.resolve(resolveOrgTimezone(null));
  const imageRowsRead = isOverview
    ? imagesSvc.list(id)
    : Promise.resolve<Awaited<ReturnType<ItemImagesService['list']>>>([]);
  // Per-supplier unit-cost trend from our own PO + receipt data, rendered as a
  // lazy Recharts island so the server shell never imports Recharts.
  const costHistoryRead = isOverview
    ? reportsSvc.itemCostHistory(id)
    : Promise.resolve<ItemCostHistory>({
        itemId: id,
        series: [],
        lastUnitCost: null,
        avgUnitCost: null,
        pointCount: 0,
      });
  // Org's ACTIVE item custom field definitions — used to render the
  // defined extra fields with their human labels (not raw jsonb keys).
  const customFieldDefsRead = isOverview
    ? customFieldsSvc.listDefinitions('item')
    : Promise.resolve<CustomFieldDefinition[]>([]);
  // First page of registered serials (+ total). Fail-closed read: an
  // empty page on error, so the panel degrades instead of the page.
  const serialsPageRead = isOverview
    ? serialsSvc.list(id, { page: 1 })
    : Promise.resolve<SerialsPage>({ rows: [], total: 0, page: 1, pageSize: 0 });
  // RESERVED, through the accessor that already owns this truth. The audit
  // found `stock_reservations` live since mig 0073 and read by the orders
  // catalog, rentals and auto-archive — but nowhere an operator could see
  // the three numbers together. Reusing reservedQuantityByItemIds rather
  // than querying here is the point: availability is derived from two
  // existing facts, and a second query is how the two drift.
  const reservedRead = isOverview
    ? inventorySvc.reservedQuantityByItemIds([id])
    : Promise.resolve(new Map<string, number>());
  // When the item row is missing or forbidden, notFound() throws before any
  // of these is awaited. Mark every rejection observed first, so a read that
  // fails in that window can never become an unhandled rejection (which takes
  // the whole function down) instead of the not-found page.
  for (const read of [
    locationsRead,
    holdingsRead,
    destinationScopeRead,
    activityRead,
    imageRowsRead,
    costHistoryRead,
    customFieldDefsRead,
    serialsPageRead,
    reservedRead,
  ]) {
    read.catch(() => {});
  }

  let item;
  try {
    item = await itemRead;
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') notFound();
    throw e;
  }

  // ── Reads keyed by the row ─────────────────────────────────────────────
  // Targeted by-id fetches for the single category + supplier this item
  // belongs to (used only by .find() lookups below). Locations stays as a
  // full list (above) because the StockTransferDialog needs every location
  // for its destination dropdown.
  // Category and supplier are shown on the Overview panel only.
  const categoryIdForFetch = isOverview ? ((item.category_id as string | null) ?? null) : null;
  const supplierIdForFetch = isOverview ? ((item.supplier_id as string | null) ?? null) : null;
  // Last-updated-by footer: the user who last touched the row (if any), read
  // WITH the row (`withUpdater`). It used to be read on its own after the row
  // arrived: a level of its own on every tab, and the only row-keyed read the
  // Movements and Activity tabs made.
  const updatedByProfile =
    (item as { updater?: { full_name?: string | null; email?: string | null } | null }).updater ??
    null;
  const canEditItem = can(ctx, 'items:update');
  // Serial numbers panel: shown for serial-tracked items, or any item that
  // already has registry rows (e.g. serials were captured before tracking was
  // switched off). 'serial_optional' (0295) joins 'serial' here: the item may
  // legitimately carry serials for only part of its quantity, and the panel
  // is the only place staff can see or add them.
  const serialsPanelShown = (serialTotal: number) =>
    ['serial', 'serial_optional'].includes(
      (item as { tracking_type?: string | null }).tracking_type ?? 'none',
    ) || serialTotal > 0;

  // ── Market price panel (Phase 6) ───────────────────────────────────
  // Fully gated + isolated: only loads/renders when the optional
  // `price_tracking` module is enabled AND the item is a book with an
  // ISBN-ish barcode. The latest observation read is wrapped in .catch
  // so a transient read failure never breaks the detail page. When the
  // module is off, both `priceTrackingEnabled` is false and `marketPriceObs`
  // stays null, so nothing renders and behavior is identical to before.
  //
  // The module answer comes from the context this render already holds.
  // `ctx.enabledModules` is the ACCESS rule of lib/modules/effective-modules
  // (an enabled organization_modules row, or the all-modules comp), which is
  // exactly what module_enabled() answers since migration 0354 for a member's
  // own organization, and it is what the sidebar already shows. It used to
  // cost two module_enabled RPCs here, each one more serial trip. On a failed
  // modules read the set holds core modules only, so the answer fails closed
  // exactly as the RPC's did.
  const itemBarcode = (item.barcode as string | null) ?? null;
  const priceTrackingEnabled = isModuleEnabled(ctx, 'price_tracking');
  const showMarketPrice = isOverview && priceTrackingEnabled && isLikelyIsbn(itemBarcode);

  const [
    categoryRow,
    supplierRow,
    locations,
    holdings,
    activityResult,
    images,
    costHistory,
    customFieldDefs,
    serialsPage,
    reservedByItem,
    serialWarehouses,
    marketPriceObs,
    writableWarehouseIds,
    skuSiblings,
    displayGroups,
    feedTimeZone,
  ] = await Promise.all([
    categoryIdForFetch
      ? ctx.supabase
          .from('categories')
          .select('id, name, color, public_visibility')
          .eq('organization_id', ctx.organizationId)
          .eq('id', categoryIdForFetch)
          .maybeSingle()
          .then((r) => r.data)
      : Promise.resolve(null),
    supplierIdForFetch
      ? ctx.supabase
          .from('suppliers')
          .select('id, name')
          .eq('organization_id', ctx.organizationId)
          .eq('id', supplierIdForFetch)
          .maybeSingle()
          .then((r) => r.data)
      : Promise.resolve(null),
    locationsRead,
    holdingsRead,
    activityRead,
    // Photo URLs are signed only once the row has cleared its access check
    // (this runs after `get` returned), never for an item the caller may not
    // see. The rows themselves were read alongside the item.
    imageRowsRead.then(async (imageRows) => {
      // No photos (an item without any, or a tab, which reads none): no signing.
      if (imageRows.length === 0) return [];
      const signed = await imagesSvc.signedUrls(imageRows.map((r) => r.storage_path as string));
      return imageRows.map((r) => ({
        id: r.id as string,
        url: signed.get(r.storage_path as string) ?? '',
        isPrimary: Boolean(r.is_primary),
      }));
    }),
    costHistoryRead,
    customFieldDefsRead,
    serialsPageRead,
    reservedRead,
    // Warehouse names (for the serials Add dialog's destination select) load
    // only when the panel renders AND the user can edit — a dropdown-weight
    // query, skipped entirely on non-serial items.
    serialsPageRead.then((page) =>
      serialsPanelShown(page.total) && canEditItem
        ? new WarehousesService(ctx).listNames().catch(() => [])
        : [],
    ),
    showMarketPrice
      ? PriceTrackingService.forCurrentUser()
          .then((s) => s.getLatestObservation(item.id as string))
          .catch(() => null)
      : Promise.resolve(null),
    destinationScopeRead,
    // Ungroup (0399): how many OTHER records the viewer can see carry this SKU,
    // for the note under the SKU and Make this its own item. Needs the row's
    // SKU, so it starts with the other row-keyed reads; the header shows it on
    // every tab. A failed read says nothing (null), never fails the page.
    new ItemGroupingService(ctx)
      .countSkuSiblings(id, (item.sku as string | null) ?? null)
      .catch(() => null),
    // Group selected (0400): the record's display group, read as the viewer
    // (RLS). Never fails the page: a failed read shows no group line.
    readDisplayGroupsByItemIds(ctx.supabase, ctx.organizationId, [id]),
    feedTimeZoneRead,
  ]);

  // ── Stock in warehouses the caller cannot see (0371) ────────────────
  // 'none' for managers and above. See InventoryService.get's withElsewhere.
  const elsewhere: ItemElsewhere = (item as { elsewhere?: ItemElsewhere }).elsewhere ?? {
    status: 'none',
  };
  const hiddenHoldings = elsewhere.status === 'some' ? elsewhere : null;
  const placementLine = placementSummary({
    onHand: Number(item.quantity_on_hand ?? 0),
    stagedAll: Number((item as { staged_quantity?: number }).staged_quantity ?? 0),
    unplacedAll: Number((item as { unplaced_quantity?: number }).unplaced_quantity ?? 0),
    elsewhere,
  });

  // Resolve the org's defined custom fields against this item's stored
  // custom_fields. Only fields with a stored, non-empty value are shown so the
  // section stays empty on items that never set them.
  const itemCustomFields =
    (item as { custom_fields?: Record<string, unknown> | null }).custom_fields ?? {};
  const definedCustomFields = customFieldDefs
    .filter((d) => !d.archived)
    .map((d) => {
      const raw = itemCustomFields[d.fieldKey];
      let display: string | null = null;
      if (d.fieldType === 'checkbox') {
        display = raw === true ? 'Yes' : raw === false ? 'No' : null;
      } else if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
        if (d.fieldType === 'select') {
          const opt = (d.options ?? []).find((o) => o.value === raw);
          display = opt ? opt.label : String(raw);
        } else {
          display = String(raw);
        }
      }
      return { def: d, display };
    })
    .filter((f) => f.display !== null);

  const category = categoryRow ?? null;
  const location = locations.find((l) => l.id === item.primary_location_id);
  const supplier = supplierRow ?? null;

  const value = (item.quantity_on_hand as number) * (item.unit_cost as number);

  // ── Last-updated-by footer ──────────────────────────────────────────
  // The profile came with the row (see `updatedByProfile` above).
  const updatedAt = (item as { updated_at?: string | null }).updated_at ?? null;
  const updatedByName: string | null =
    (updatedByProfile?.full_name?.trim() || updatedByProfile?.email?.trim()) ?? null;

  // null: the feed could not be read (see activityRead). Both tabs then show
  // that state instead of a feed, and the counts below see no events.
  const activityFailed = activityResult === null;
  const activity = activityResult ?? [];
  // Relative, so it keeps this page's path: the same tab, and the validated
  // return target the page was opened with.
  const activityRetryHref = `?${new URLSearchParams({
    tab: activeTab,
    ...(returnParam ? { return: returnParam } : {}),
  }).toString()}`;
  // The verification card's "N recorded stock movements since" opens the
  // Movements tab of this same page, keeping the validated return target.
  const movementsTabHref = `?${new URLSearchParams({
    tab: 'movements',
    ...(returnParam ? { return: returnParam } : {}),
  }).toString()}`;

  // Filter for the Movements tab — kind === 'movement' from the unified
  // ActivityService feed is exactly the stock_movements rows.
  const movementEvents = activity.filter((e) => e.kind === 'movement');
  const auditEventsCount = activity.length - movementEvents.length;

  // "Load older" pagination (Movement/Activity P4 Task 2): both tabs share
  // one initial cursor, derived from the SAME first-page `activity` array —
  // the client wrapper's `kindFilter` prop handles the display-only
  // difference between the two tabs. `nextActivityCursor` returns null when
  // `activity` is empty (e.g. the Overview tab, which never fetches
  // activity at all), so the button correctly starts hidden there too.
  const activityInitialCursor = nextActivityCursor(activity);
  // The feed panel keeps its rows in client state (for "Load older"), seeded
  // from these props on mount. A re-render of this page (the adjust or
  // transfer action's own response, a live update) hands it NEW first-page
  // rows, which a mounted panel ignored: the header showed the new quantity
  // while the Movements tab kept the old list. Keyed on the first page, the
  // panel starts over whenever that page changes, and only then.
  const feedKey = `${activity[0]?.id ?? 'none'}:${activity.length}`;

  // Per-kind initial exhaustion (P4 review fix): the Movements tab only
  // ever displays movement events, so ITS "Load older" button must hide
  // based on whether MOVEMENTS under-filled their own cap — not the merged
  // tab's AND-across-both-kinds check. Passing the combined
  // `activityInitialExhausted` to the Movements panel was a bug: audits
  // hitting their (smaller) cap while movements still had room would keep
  // the combined flag `false` (correctly, for the Activity tab) but the
  // Movements-only panel would inherit that same `false` and show a "Load
  // older" button that fetches a page containing zero new movements
  // forever, since movements were ALREADY exhausted on their own.
  const movementsInitialExhausted = movementEvents.length < ITEM_ACTIVITY_PAGE_SIZE;
  const auditsInitialExhausted = auditEventsCount < auditLimitFor(ITEM_ACTIVITY_PAGE_SIZE);
  // The merged Activity tab shows BOTH kinds, so it still needs the AND —
  // more of either kind means the tab has more to load.
  const activityInitialExhausted = movementsInitialExhausted && auditsInitialExhausted;

  // Location id → name map for the activity feed's transfer route line
  // ("A → B"). Free: the full location list is already fetched above for
  // the transfer dialog's destination dropdown.
  const locationNames = Object.fromEntries(
    locations.map((l) => [l.id as string, l.name as string]),
  );

  // Permission gates for the sticky-header action row. Viewers see the
  // detail page (read-only) but no Edit / Adjust / Transfer buttons.
  // Server-layer assertPermission still throws if a request somehow
  // bypasses this — these flags just hide the UI surfaces. `canEditItem` is
  // derived above, where the serials panel's warehouse read needs it.
  const canDuplicateItem = can(ctx, 'items:create');
  const canAdjustStock = can(ctx, 'stock:adjust');
  const canTransferStock = can(ctx, 'stock:transfer');
  // "Report a problem" launch point (Task 17, master brief §8). Permission
  // first, then the module: a viewer who could not use the button is
  // reported the module as off. The module answer is `ctx.enabledModules`,
  // like price_tracking above (it used to be a module_enabled RPC). This route
  // covers items, books, AND rental-items (all three wrapping pages render
  // this same ItemDetail), so the button always prefills relatedItemId.
  const canReportProblem = can(ctx, 'maintenance_requests:submit');
  const maintenanceRequestsEnabled =
    canReportProblem && isModuleEnabled(ctx, 'maintenance_requests');
  // Add/edit the free-text note on a movement row in the Movements/Activity
  // feed (managers+, or anyone granted the FULLY_GRANTABLE permission). The
  // server action + SECURITY DEFINER RPC re-gate; this only shows the affordance.
  const canEditNotes = can(ctx, 'movements:edit_notes');
  // "Count this item" (F1-2): a manager who can start a count (the same
  // floors the recount runs), on an item a count can include (active, not
  // rental equipment, not a kit: start_cycle_count's own predicate). The
  // recount service and the database re-check both.
  const showCountThisItem =
    canStartCount(ctx) &&
    isCountableItem({
      status: (item.status as string | null) ?? null,
      deleted_at: (item as { deleted_at?: string | null }).deleted_at ?? null,
      is_rental: (item as { is_rental?: boolean | null }).is_rental ?? null,
      is_bundle: (item as { is_bundle?: boolean | null }).is_bundle ?? null,
    });
  // Gates the transfer dialog's inline "New location…" destination and, for a
  // book, its default path (placing into the recorded crate, minting the row
  // when none exists). The server does that under 'stock:transfer' (or
  // 'locations:manage') through the placement path only
  // (mint_placement_location, 0340; owner decision D1) and re-asserts it, so
  // this only hides the UI affordance. ONE derivation, shared with Staging.
  const canMintDestination = canMintPlacementDestination(ctx);
  // Public-catalog visibility (P3): the row + select only render for
  // public_links:manage holders; the server action re-asserts.
  const canManagePublicVisibility = can(ctx, 'public_links:manage');
  const itemPublicVisibility = ((item as { public_visibility?: string | null }).public_visibility ??
    'internal_only') as 'internal_only' | 'public' | 'hidden';
  const categoryIsInternalOnly =
    ((category as { public_visibility?: string | null } | null)?.public_visibility ?? 'public') ===
    'internal_only';
  // Public display-name override (0261): surfaced read-only next to the
  // visibility control so catalog managers can see at a glance that the
  // public label differs from the internal name. Edited on the item edit form.
  const itemPublicDisplayName =
    (item as { public_display_name?: string | null }).public_display_name?.trim() || null;

  // ── Serial numbers panel ───────────────────────────────────────────
  // (rule and warehouse-name read: see `serialsPanelShown` above)
  const showSerialsPanel = serialsPanelShown(serialsPage.total);

  // ── The redesigned layout's derived values (no reads) ──────────────
  const isBook = item.item_type === 'book';
  const unit = item.unit_of_measure as string;
  const onHand = item.quantity_on_hand as number;
  const itemStatus = item.status as 'active' | 'archived' | 'discontinued';
  const awaitingFirstReceipt =
    (item as { awaiting_first_receipt?: boolean }).awaiting_first_receipt === true;
  // The ISBN-import pipeline's cover, stashed on the row's custom_fields (no
  // read: it came with the row). Shown when the record has no uploaded photo.
  const rowCustomFields = (item as { custom_fields?: Record<string, unknown> | null })
    .custom_fields;
  const coverThumbUrl =
    rowCustomFields &&
    typeof rowCustomFields === 'object' &&
    typeof rowCustomFields.thumbnail_url === 'string'
      ? (rowCustomFields.thumbnail_url as string)
      : null;

  // ── The header photo: OVERVIEW ONLY ─────────────────────────────────
  // Photos are read (and signed) on the Overview tab only; a photo in the
  // header of the Movements and Activity tabs would add that read to every
  // tab (CONFLICTS D7), so there the header has no photo. On Overview it is the
  // primary upload the gallery below already shows, at 64 px through the image
  // optimizer (a small rendition, never the master), or the ISBN cover the
  // list shows, or the missing-photo hatch when the record has neither.
  const primaryImage =
    images.find((img) => img.isPrimary && img.url) ?? images.find((img) => img.url) ?? null;
  const headerPhotoSrc = primaryImage
    ? getImageProps({ src: primaryImage.url, alt: '', width: 64, height: 64 }).props.src
    : images.length === 0
      ? coverThumbUrl
      : null;

  // ── "By location": the placed holdings and the "= on hand" line ─────
  // Shown when there is something to say: a placed holding the viewer can see
  // (the breakdown's own rule), placed stock elsewhere, or the line.
  const showByLocation =
    transferableHoldings(holdings).length > 0 ||
    (hiddenHoldings?.placed ?? 0) > 0 ||
    placementLine.kind !== 'none';

  // The Overview grid's left column, counted so the right column (By
  // location, Reorder, the physical count) can span exactly its rows on a wide
  // content area (see the grid below).
  const leftCardCount =
    2 + // Details and Images
    (definedCustomFields.length > 0 ? 1 : 0) +
    (showMarketPrice ? 1 : 0) +
    (costHistory.pointCount > 0 ? 1 : 0) +
    (showSerialsPanel ? 1 : 0);

  return (
    <div className="mx-auto flex w-full max-w-[1320px] flex-col px-4 pb-16 pt-2 sm:px-8">
      {/* Performance marker. This server component awaits the item (and
          notFound()s without one) before it returns anything, so reaching
          this markup means the real record is what renders. Shared by the
          Items, Books and Rentals detail routes, which all render ItemDetail. */}
      <PerfUseful />
      {/* ── Sticky header ─────────────────────────────────────────────
          Pins to top-0 of the scrolling <main> in DashboardShell.
          The dashboard Topbar lives OUTSIDE that scroll container
          (sibling above <main>), so the sticky should pin flush
          against main's top edge — which is already right under the
          topbar visually. Using top-14 here would double-count the
          topbar height and produce a 56px gap where scrolled content
          leaks through above the sticky. Its last row is the tab strip,
          whose hairline is the header's bottom edge. */}
      <div
        data-testid="item-detail-header"
        data-item-detail-header=""
        className="bg-card sticky top-0 z-20 -mx-4 px-4 pt-4 sm:-mx-8 sm:px-8 sm:pt-5"
      >
        <div className="mb-2">
          <PageHeaderBackLink href={backHref}>← {backLabel}</PageHeaderBackLink>
        </div>

        {/* The title block and the actions share a line when they fit; the
            actions wrap under the title otherwise (the title asks for 18rem
            before they may share its line, so they never squeeze it). */}
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <PageHeader
            variant="item"
            className="min-w-0 flex-1 basis-72"
            media={isOverview ? <Thumb size={64} src={headerPhotoSrc} alt="" /> : undefined}
            title={item.name as string}
            titleAside={<PageTour tour={ITEM_DETAIL_TOUR} />}
            meta={
              <>
                <span className="break-all font-mono">{item.sku as string}</span>
                <span aria-hidden className="text-ink-4">
                  ·
                </span>
                <StockStatusBadge
                  quantity={onHand}
                  reorderPoint={item.reorder_point as number}
                  itemStatus={itemStatus}
                  // Expected item (mig 0277) reached via search / direct
                  // link: the verbose pill gives the context inline.
                  awaitingFirstReceipt={awaitingFirstReceipt}
                  expectedVerbose
                />
              </>
            }
          >
            {(() => {
              // Ungroup (0399): an honest note when other records the viewer
              // can see share this SKU (edits of the shared fields change them
              // all), and the way to change this record alone.
              //
              // The host of Make this its own item is mounted for EVERY editor
              // of a record that can be ungrouped, offered or not, at the same
              // place in the tree: a split makes the SKU the record's own, the
              // action's refresh then renders no note, and a host mounted only
              // with the note would unmount its open dialog and the split's
              // result with it (fix round 1, P1).
              const note = skuSiblings ? sharedSkuNoteCopy(skuSiblings, item.sku as string) : null;
              const isKit = (item as { is_bundle?: boolean | null }).is_bundle === true;
              const inFamily = (item as { group_id?: string | null }).group_id != null;
              const host = canEditItem && !isKit && !inFamily;
              if (!note && !host) return null;
              return (
                <div
                  className={
                    note
                      ? 'mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px] leading-[18px]'
                      : 'contents'
                  }
                >
                  {note ? <p className="text-muted-foreground max-w-prose">{note}</p> : null}
                  {note && canEditItem && isKit ? (
                    <p className="text-muted-foreground">{GROUPING_ERROR_WORDS.kit}</p>
                  ) : null}
                  {note && canEditItem && !isKit && inFamily ? (
                    <p className="text-muted-foreground">{GROUPING_ERROR_WORDS.family}</p>
                  ) : null}
                  {host ? <MakeOwnItemButton itemId={id} offer={note !== null} /> : null}
                </div>
              );
            })()}
            {(() => {
              // Group selected (0400): the record's explicit display group and,
              // for an editor, Remove from group. Mounted for every editor at
              // this place (see GroupMembershipControl), shown when in a group.
              const group = displayGroups.get(id) ?? null;
              const groupName = group ? (group.name ?? DISPLAY_GROUP_FALLBACK_NAME) : null;
              if (!groupName && !canEditItem) return null;
              return (
                <div className={groupName ? 'mt-2' : 'contents'}>
                  <GroupMembershipControl
                    itemId={id}
                    groupName={groupName}
                    canEdit={canEditItem}
                    view={isBook ? 'books' : 'items'}
                  />
                </div>
              );
            })()}
          </PageHeader>

          {/*
            Action buttons: on small screens, scroll horizontally as a
            single row instead of wrapping into 2-3 stacked rows that
            push the rest of the page off the fold (the row bleeds to the
            screen edges, with room above and below for the focus ring).
            From sm up the row wraps. Every action keeps its own gate and
            name; the row sizes them alike (32 px), whatever size the
            shared components draw on their own.
          */}
          <div
            data-tour="item-actions"
            className="-mx-4 -my-1 w-[calc(100%+2rem)] overflow-x-auto px-4 py-1 sm:mx-0 sm:w-auto sm:overflow-visible sm:px-0"
          >
            <div className="flex w-max gap-2 sm:w-auto sm:flex-wrap [&>a]:h-8 [&>a]:px-3 [&>a]:text-[13px] [&>button]:h-8 [&>button]:px-3 [&>button]:text-[13px]">
              {canEditItem &&
                (() => {
                  // Append the return param so editing → save still bounces
                  // back to the same list URL the user came from.
                  const editBase = editHref ?? `/dashboard/inventory/${id}/edit`;
                  const href = returnParam
                    ? `${editBase}?return=${encodeURIComponent(returnParam)}`
                    : editBase;
                  return (
                    <Button asChild variant="outline">
                      <Link href={href}>Edit</Link>
                    </Button>
                  );
                })()}
              {canDuplicateItem && (
                <DuplicateItemDialog
                  itemId={id}
                  itemName={item.name as string}
                  itemType={(item.item_type as string | null) ?? null}
                />
              )}
              <BarcodeDisplay
                itemId={id}
                itemName={item.name as string}
                sku={item.sku as string}
                barcode={(item.barcode as string | null) ?? null}
              />
              <Button asChild variant="outline">
                <Link href={`/dashboard/inventory/labels?items=${id}`}>
                  <Printer className="h-4 w-4" /> Print label
                </Link>
              </Button>
              {canAdjustStock && (
                <StockAdjustDialog
                  itemId={id}
                  itemName={item.name as string}
                  currentQuantity={onHand}
                />
              )}
              {canTransferStock && locations.length >= 2 && (
                <StockTransferDialog
                  itemId={id}
                  itemName={item.name as string}
                  currentQuantity={onHand}
                  currentLocationId={(item.primary_location_id as string | null) ?? null}
                  locations={locations.map((l) => ({
                    // Through the ONE mapper, so the row's own rack/crate
                    // columns (0188) travel in the put-away dialogs' shape and
                    // a BOOK's "To location" pick can FILL the four destination
                    // fields instead of only naming a row.
                    ...toDestinationOption(l as DestinationLocationRow),
                    kind: (l.kind as string | null) ?? null,
                    warehouse_id: (l.warehouse_id as string | null) ?? null,
                  }))}
                  holdings={holdings}
                  elsewhere={elsewhere}
                  writableWarehouseIds={writableWarehouseIds}
                  itemType={(item.item_type as string | null) ?? null}
                  // CONTEXT ONLY — the dialog never predicts or acknowledges a
                  // crate change from this snapshot; it confirms from the
                  // server's own refusal payload. See the prop's doc comment.
                  bookStorage={
                    isBook
                      ? readBookStorage(item.custom_fields as Record<string, unknown> | null)
                      : null
                  }
                  canMintDestination={canMintDestination}
                />
              )}
              {showCountThisItem && <CountThisItemButton itemId={id} />}
              <ReportProblemButton
                moduleEnabled={maintenanceRequestsEnabled}
                canSubmit={canReportProblem}
                prefill={{ itemId: id }}
              />
            </div>
          </div>
        </div>

        <div className="mt-4">
          <ItemDetailTabs activeTab={activeTab} />
        </div>
      </div>

      {/* ── Tab panels ────────────────────────────────────────────── */}
      {activeTab === 'overview' && (
        <div
          role="tabpanel"
          id="item-detail-panel-overview"
          aria-labelledby="item-detail-tab-overview"
          className="@container mt-4 flex flex-col gap-4 sm:mt-5"
        >
          {/* The figures (DESIGN-SPEC 6.8, the record's stat strip), REAL ones
              only: on hand; reserved for open orders and available, only when
              something is reserved; value; reorder at. No Allocated, On order,
              coverage days or chart the product does not compute (CONFLICTS
              D3, O2), and on hand is never labelled available. */}
          <StatStrip variant="detail" data-testid="item-figures">
            <StatStripItem
              size="detail"
              data-testid="item-on-hand"
              label="On hand"
              value={<FigureWithUnit value={formatNumber(onHand)} unit={unit} />}
            />
            <StockAvailabilityLine
              onHand={Number(item.quantity_on_hand ?? 0)}
              reserved={reservedByItem.get(id) ?? 0}
              unit={unit}
            />
            <StatStripItem
              size="detail"
              data-testid="item-value"
              label="Value"
              value={formatCurrency(value)}
              sub={`@ ${formatCurrency(item.unit_cost as number)} unit cost`}
            />
            <StatStripItem
              size="detail"
              data-testid="item-reorder-at"
              label="Reorder at"
              value={
                <FigureWithUnit value={formatNumber(item.reorder_point as number)} unit={unit} />
              }
            />
          </StatStrip>

          {/* The panels: two columns on a wide content area (the reference's
              1.7 : 1 split with a 280 px floor for the right one), one column
              below about 2 x 420 + 16 px of content (DESIGN-SPEC 8), measured
              on the panel itself, not the window, so the sidebar counts.
              In one column the cards follow the source order: Details, the
              right column's cards, then the rest. In two, the right column
              spans every row of the left one (its last row takes the slack),
              so the two stack independently. */}
          <div
            className="@min-[856px]:grid-cols-[minmax(0,1.7fr)_minmax(280px,1fr)] @min-[856px]:grid-rows-[repeat(var(--item-detail-left-rows),auto)_1fr] @min-[856px]:items-start grid gap-4"
            style={{ '--item-detail-left-rows': leftCardCount - 1 } as CSSProperties}
          >
            <DetailSection title="Details" flush className="@min-[856px]:col-start-1">
              <KeyValueList>
                {/* Rentals reservation surface — only the rentals item detail
                    page passes `reservedQuantity`. Checking out a rental
                    reserves stock instead of decrementing on-hand, so without
                    these rows a checkout looks invisible. Hidden entirely
                    when the prop is absent (inventory/books) or zero. */}
                {reservedQuantity !== undefined && reservedQuantity > 0 && (
                  <>
                    <KeyValueRow label="Out on rental">
                      {formatNumber(reservedQuantity)} {unit}
                    </KeyValueRow>
                    <KeyValueRow label="Available">
                      {formatNumber(Math.max(0, onHand - reservedQuantity))} {unit}
                    </KeyValueRow>
                  </>
                )}
                <KeyValueRow label="Category">
                  {category ? (
                    (category.name as string)
                  ) : (
                    <span className="text-muted-foreground">Uncategorized</span>
                  )}
                </KeyValueRow>
                {canManagePublicVisibility && (
                  <KeyValueRow
                    label="Public visibility"
                    className="flex-col items-stretch gap-2"
                    valueClassName="text-left"
                  >
                    <PublicVisibilityControl
                      itemId={id}
                      value={itemPublicVisibility}
                      categoryIsInternalOnly={categoryIsInternalOnly}
                    />
                    {itemPublicDisplayName && (
                      <span className="text-muted-foreground mt-1.5 block text-[12px]">
                        Public name: {itemPublicDisplayName}
                      </span>
                    )}
                  </KeyValueRow>
                )}
                <KeyValueRow label="Location">
                  {location ? (
                    (location.name as string)
                  ) : (
                    <span className="text-muted-foreground">Not set</span>
                  )}
                  {item.bin_location && (
                    <span className="text-muted-foreground ml-2 text-[12px]">
                      {item.bin_location as string}
                    </span>
                  )}
                </KeyValueRow>
                {!isBook && item.model_number ? (
                  <KeyValueRow label="Model #" valueClassName="font-mono text-[12.5px]">
                    {item.model_number as string}
                  </KeyValueRow>
                ) : null}
                {(() => {
                  const storage = readBookStorage(
                    item.custom_fields as Record<string, unknown> | null,
                  );
                  const color = getCrateColor(storage.crateColor);
                  const cf = (item.custom_fields as Record<string, unknown> | null) ?? {};
                  // For books, ISBN is stored in inventory_items.barcode — the
                  // edit form's "ISBN" label binds to the same field as
                  // "Barcode" for non-books, and bulk-ISBN import also writes
                  // the ISBN to `barcode` (services/books-import.ts:85).
                  // custom_fields.isbn / .isbn13 / .isbn10 are legacy fallbacks
                  // from older import paths.
                  const isbnRaw = isBook
                    ? ((item.barcode as string | null) ?? '') ||
                      (typeof cf.isbn === 'string' && cf.isbn) ||
                      (typeof cf.isbn13 === 'string' && cf.isbn13) ||
                      (typeof cf.isbn10 === 'string' && cf.isbn10) ||
                      ''
                    : '';
                  const isbn = isbnRaw.trim();
                  // WHERE THE STOCK IS vs what the item REMEMBERS. `storage`
                  // above is the custom_fields SUMMARY; a put-away into a
                  // position-less crate preserves it on purpose (mig 0335), so
                  // it can name a rack the stock has entirely left. The live
                  // breakdown in the By location card already shows the truth,
                  // which made this card CONTRADICT ITSELF rather than merely
                  // mislead — so a rack the holdings REFUTE stands down and
                  // points at the breakdown instead.
                  //
                  // ONLY the Rack row, and only on a real contradiction. The
                  // first cut of this gate hid BOTH rows whenever the holdings
                  // were authoritative at all, which swept in every SPLIT item:
                  // a book split across two racks lost its crate summary ("Red
                  // 5") entirely, a row main has always shown. The crate
                  // summary is a human's note about which box, refuted by
                  // nothing here — the split is described in full by the
                  // breakdown.
                  //
                  // 0371: the holdings here are the caller's own warehouses'.
                  // A rack in ANOTHER warehouse can hold the labelled stock, so
                  // hidden placed locations count as evidence FOR the label
                  // (named from the org-wide location list; their quantities
                  // are unknown, and the rule reads names only). When the
                  // hidden stock could not be read, or a hidden location
                  // cannot be named, the holdings are not known in full and
                  // the label is never called false.
                  const hiddenPlacedIds = hiddenHoldings?.placedLocationIds ?? [];
                  const hiddenPlaced = hiddenPlacedIds.map((locId) =>
                    locations.find((l) => (l.id as string) === locId),
                  );
                  const holdingsKnownInFull =
                    elsewhere.status !== 'unavailable' && hiddenPlaced.every((l) => !!l);
                  const rackContradicted =
                    holdingsKnownInFull &&
                    holdingsContradictRack(storage.rackLabel, [
                      ...holdings
                        .filter((h) => h.kind === 'rack' || h.kind === 'crate')
                        .map((h) => ({ name: h.name, quantity: h.quantity, kind: h.kind })),
                      ...hiddenPlaced
                        .filter((l) => l!.kind === 'rack' || l!.kind === 'crate')
                        .map((l) => ({
                          name: l!.name as string,
                          quantity: 0,
                          kind: l!.kind as string,
                        })),
                    ]);
                  const showRack = !!storage.rackLabel && !rackContradicted;
                  const hasAny = isBook || storage.grade || showRack || storage.crateNumber || isbn;
                  if (!hasAny) return null;
                  return (
                    <>
                      {isBook && (
                        <KeyValueRow
                          label="ISBN"
                          valueClassName={isbn ? 'font-mono text-[12.5px]' : undefined}
                        >
                          {isbn ? isbn : <span className="text-muted-foreground">Not set</span>}
                        </KeyValueRow>
                      )}
                      {storage.grade && (
                        <KeyValueRow label="Grade">{formatGrade(storage.grade)}</KeyValueRow>
                      )}
                      {showRack && (
                        <KeyValueRow label="Rack" valueClassName="font-mono text-[12.5px]">
                          {storage.rackLabel}
                        </KeyValueRow>
                      )}
                      {storage.crateNumber && (
                        <KeyValueRow label="Crate">
                          <span className="inline-flex items-center gap-2">
                            <span
                              aria-hidden
                              title={color ? color.label : 'No color set'}
                              className="inline-block h-3 w-3 shrink-0 rounded-full border border-[var(--ed-line-strong)]"
                              style={color ? { backgroundColor: color.hex } : undefined}
                            />
                            <span>
                              {color ? `${color.label} ` : ''}
                              <span className="font-mono tabular-nums">{storage.crateNumber}</span>
                            </span>
                          </span>
                        </KeyValueRow>
                      )}
                    </>
                  );
                })()}
                <KeyValueRow label="Supplier">
                  {supplier ? (
                    (supplier.name as string)
                  ) : (
                    <span className="text-muted-foreground">No supplier</span>
                  )}
                </KeyValueRow>
                {(item.description as string | null) && (
                  <KeyValueRow
                    label="Description"
                    className="flex-col items-stretch gap-1"
                    valueClassName="text-left whitespace-pre-wrap"
                  >
                    {item.description as string}
                  </KeyValueRow>
                )}
              </KeyValueList>
            </DetailSection>

            {/* The right column: where the stock is, the reorder settings and
                the last physical count. */}
            <div className="@min-[856px]:col-start-2 @min-[856px]:row-span-full flex min-w-0 flex-col gap-4">
              {showByLocation && (
                <DetailSection title="By location" flush>
                  <div className="divide-border divide-y">
                    <PlacementsBreakdown
                      placements={holdings}
                      itemId={id}
                      itemName={item.name as string}
                      // Rack-scoped write-off (2026-07-23): the tool to reach for
                      // instead of archiving a whole item to clear one rack. Gated
                      // on the same permission adjustStock asserts; archived items
                      // can't be adjusted, so hide it there too.
                      canRemoveStock={canAdjustStock && item.status !== 'archived'}
                      // Placed stock in warehouses the caller cannot see (0371),
                      // as one count: "7 placed in other warehouses (1 location)".
                      elsewhere={
                        hiddenHoldings && hiddenHoldings.placed > 0
                          ? {
                              quantity: hiddenHoldings.placed,
                              locationCount: hiddenHoldings.placedLocationIds.length,
                            }
                          : null
                      }
                    />
                    {(() => {
                      // The "On hand" figure INCLUDES awaiting-put-away stock
                      // (Staging + Unplaced), but the placed-rack breakdown
                      // does NOT — so without this line the racks (e.g. 250 +
                      // 250 = 500) don't add up to On hand (600). Spell the
                      // split out so active vs. staged is never silently
                      // combined (owner report 2026-07-09): placed + awaiting
                      // put-away = on hand.
                      //
                      // 0371: for a staff member or viewer, part of the stock
                      // can sit in warehouses they cannot see. That part is its
                      // own term ("+ 12 in other warehouses"), so the sum still
                      // holds; and when it could not be read, the page says so
                      // instead of printing a sum that may be missing a part.
                      if (placementLine.kind === 'none') return null;
                      if (placementLine.kind === 'unavailable') {
                        return (
                          <p
                            role="status"
                            className="text-muted-foreground px-[18px] py-2.5 text-[12px] leading-[18px]"
                          >
                            {placementLine.note}
                          </p>
                        );
                      }
                      return (
                        <p className="text-muted-foreground px-[18px] py-2.5 text-[12px] leading-[18px]">
                          <span className="text-foreground font-medium tabular-nums">
                            {formatNumber(placementLine.placed)}
                          </span>{' '}
                          placed
                          {placementLine.awaiting > 0 && (
                            <>
                              {' + '}
                              <span className="text-warning font-medium tabular-nums">
                                {formatNumber(placementLine.awaiting)}
                              </span>{' '}
                              awaiting put-away
                            </>
                          )}
                          {placementLine.elsewhere > 0 && (
                            <>
                              {' + '}
                              <span className="text-foreground font-medium tabular-nums">
                                {formatNumber(placementLine.elsewhere)}
                              </span>{' '}
                              in other warehouses
                            </>
                          )}
                          {' = '}
                          <span className="text-foreground font-medium tabular-nums">
                            {formatNumber(placementLine.onHand)}
                          </span>{' '}
                          on hand
                        </p>
                      );
                    })()}
                  </div>
                </DetailSection>
              )}

              <DetailSection title="Reorder" flush>
                <KeyValueList>
                  <KeyValueRow label="Reorder at">
                    {formatNumber(item.reorder_point as number)} {unit}
                  </KeyValueRow>
                  <KeyValueRow label="Reorder qty">
                    {formatNumber(item.reorder_quantity as number)} {unit}
                  </KeyValueRow>
                  <KeyValueRow label="Retail price">
                    {formatCurrency(item.retail_price as number)}
                  </KeyValueRow>
                  <KeyValueRow label="Status">
                    {(item.status as string).replace(/^./, (s) => s.toUpperCase())}
                  </KeyValueRow>
                </KeyValueList>
              </DetailSection>

              {/* Last physical count (F1-3). OFF THE CRITICAL PATH: the card
                  reads item_verification_summaries itself, under its own
                  Suspense boundary, so nothing above waits for it and a slow
                  or failed read never holds or fails the item page (it says
                  "Couldn't load verification" in its own place). Overview
                  only, like the other panels only Overview shows. */}
              <Suspense fallback={<ItemVerificationCardSkeleton />}>
                <ItemVerificationCard itemId={id} movementsHref={movementsTabHref} />
              </Suspense>
            </div>

            {/* Per-org custom fields — only the org's DEFINED item fields that
                this item has a value for. Reserved/hardcoded keys are rendered
                by their own detail rows above and are never represented here. */}
            {definedCustomFields.length > 0 && (
              <DetailSection title="Additional fields" flush className="@min-[856px]:col-start-1">
                <KeyValueList>
                  {definedCustomFields.map(({ def, display }) => (
                    <KeyValueRow key={def.id} label={def.label}>
                      {display}
                    </KeyValueRow>
                  ))}
                </KeyValueList>
              </DetailSection>
            )}

            {/* Market price (Phase 6) — external Google Books list/retail by
                ISBN, gated behind the optional price_tracking module + an
                ISBN-ish barcode. Renders nothing (and loads nothing) when the
                module is off, keeping item detail byte-identical otherwise. */}
            {showMarketPrice && (
              <div className="@min-[856px]:col-start-1 min-w-0">
                <MarketPricePanel
                  itemId={item.id as string}
                  initial={marketPriceObs}
                  ourRetail={(item.retail_price as number | null) ?? null}
                  ourCost={(item.unit_cost as number | null) ?? null}
                />
              </div>
            )}

            {/* Supplier cost trend — what we've paid for this item over time,
                one line per supplier, built from our own PO + receipt unit_cost
                (no external pricing). Hidden entirely when there's no history
                so it never shows an empty card on freshly-created items. */}
            {costHistory.pointCount > 0 && (
              <DetailSection
                className="@min-[856px]:col-start-1"
                title={
                  <span className="inline-flex items-center gap-2">
                    <LineChart className="text-muted-foreground h-4 w-4" aria-hidden /> Cost trend
                  </span>
                }
              >
                <div className="mb-3 flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
                  <p className="text-muted-foreground text-[12.5px]">
                    Unit cost paid over time, by supplier · from purchase orders &amp; receipts
                  </p>
                  <div className="flex gap-6 text-right">
                    {costHistory.lastUnitCost != null && (
                      <div>
                        <p className="text-muted-foreground text-[12px]">Last paid</p>
                        <p className="font-mono text-[13.5px] font-medium tabular-nums">
                          {formatCurrency(costHistory.lastUnitCost)}
                        </p>
                      </div>
                    )}
                    {costHistory.avgUnitCost != null && (
                      <div>
                        <p className="text-muted-foreground text-[12px]">Average</p>
                        <p className="font-mono text-[13.5px] font-medium tabular-nums">
                          {formatCurrency(costHistory.avgUnitCost)}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
                <CostTrendIsland series={costHistory.series} />
              </DetailSection>
            )}

            {/* Serial numbers — manual registry management. Rendered for
                serial-tracked items or items that already have registry rows;
                first page + total are server-loaded, the panel paginates and
                mutates via server actions. */}
            {showSerialsPanel && (
              <div className="@min-[856px]:col-start-1 min-w-0">
                <ItemSerialsPanel
                  itemId={id}
                  canEditItems={canEditItem}
                  warehouses={serialWarehouses}
                  initialRows={serialsPage.rows}
                  initialTotal={serialsPage.total}
                />
              </div>
            )}

            <DetailSection title="Images" className="@min-[856px]:col-start-1">
              {/* Fallback: when there are no rows in item_images yet but the
                  ISBN-import pipeline stashed a cover URL on the row's
                  custom_fields, render it inline so the detail page shows
                  the cover the list page is already showing. The uploader
                  still works underneath — uploading saves to item_images
                  and supersedes this preview. */}
              {images.length === 0 && coverThumbUrl ? (
                <div className="bg-sunk border-border mb-4 flex items-start gap-3 rounded-md border p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={coverThumbUrl}
                    alt=""
                    width={64}
                    height={88}
                    loading="lazy"
                    decoding="async"
                    className="border-border rounded-sm border bg-white object-cover"
                    style={{ aspectRatio: '3/4' }}
                  />
                  <div className="text-muted-foreground text-[12.5px] leading-relaxed">
                    <div className="text-foreground mb-0.5 text-[13px] font-medium">
                      Cover from ISBN lookup
                    </div>
                    Imported from a third-party source (Google Books / Open Library / Library of
                    Congress). Upload a photo below to replace it with your own — the uploaded image
                    becomes the primary.
                  </div>
                </div>
              ) : null}
              <ImageUploader itemId={id} initialImages={images} />
            </DetailSection>
          </div>
        </div>
      )}

      {activeTab === 'movements' && (
        <div
          role="tabpanel"
          id="item-detail-panel-movements"
          aria-labelledby="item-detail-tab-movements"
          className="mt-4 sm:mt-5"
        >
          <DetailSection title={<FeedTitle>Stock movements</FeedTitle>}>
            {activityFailed ? (
              <ActivityUnavailable what="stock movements" retryHref={activityRetryHref} />
            ) : (
              <ItemActivityPanel
                key={feedKey}
                itemId={id}
                initialEvents={movementEvents}
                initialLocationNames={locationNames}
                initialCursor={activityInitialCursor}
                initialExhausted={movementsInitialExhausted}
                kindFilter="movement"
                canEditNotes={canEditNotes}
                timeZone={feedTimeZone}
              />
            )}
          </DetailSection>
        </div>
      )}

      {activeTab === 'activity' && (
        <div
          role="tabpanel"
          id="item-detail-panel-activity"
          aria-labelledby="item-detail-tab-activity"
          className="mt-4 sm:mt-5"
        >
          <DetailSection title={<FeedTitle>Activity</FeedTitle>}>
            {activityFailed ? (
              <ActivityUnavailable what="activity" retryHref={activityRetryHref} />
            ) : (
              <ItemActivityPanel
                key={feedKey}
                itemId={id}
                initialEvents={activity}
                initialLocationNames={locationNames}
                initialCursor={activityInitialCursor}
                initialExhausted={activityInitialExhausted}
                canEditNotes={canEditNotes}
                timeZone={feedTimeZone}
              />
            )}
          </DetailSection>
        </div>
      )}

      {/* ── Footer: last updated by ────────────────────────────────── */}
      {updatedAt && (
        <p className="text-muted-foreground mt-8 text-center text-[12px]">
          {updatedByName
            ? `Last updated by ${updatedByName} · ${formatRelative(updatedAt)}`
            : `Last updated ${formatRelative(updatedAt)}`}
        </p>
      )}
    </div>
  );
}

/** A feed card's title: the history icon, then the tab's own words. */
function FeedTitle({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <History className="text-muted-foreground h-4 w-4" aria-hidden /> {children}
    </span>
  );
}

/**
 * The Movements/Activity panel when the feed could not be read. Says so rather
 * than showing an empty feed, which would read as "nothing ever happened".
 * The retry links back to this tab, which renders the page on the server again
 * (a link to the current URL is a refresh in Next).
 */
function ActivityUnavailable({ what, retryHref }: { what: string; retryHref: string }) {
  return (
    <StatePanel
      kind="failed"
      surface="plain"
      live="assertive"
      headingLevel={null}
      title={<>Could not load this item&rsquo;s {what}. The history itself is unchanged.</>}
      action={
        <Link
          href={retryHref}
          prefetch={false}
          className="text-foreground text-[13.5px] font-medium underline underline-offset-4"
        >
          Try again
        </Link>
      }
    />
  );
}
