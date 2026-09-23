import { Box, Boxes, CalendarClock, DollarSign, Globe, GraduationCap, Hash, History, LineChart, MapPin, PackageCheck, Printer, Tag, Truck } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ItemActivityPanel } from '@/components/inventory/item-activity-panel';
import { PlacementsBreakdown } from '@/components/inventory/placements-breakdown';
import { StockAvailabilityLine } from '@/components/inventory/stock-availability-line';
import { BarcodeDisplay } from '@/components/inventory/barcode-display';
import { DuplicateItemDialog } from '@/components/inventory/duplicate-item-dialog';
// ImageUploader is heavy (canvas resize/transcode + lazy-loaded
// ImageLightbox) and only renders on the Photos tab — lazy-load
// the chunk so it stays out of the initial item-detail bundle.
// item-detail is a server component, so ssr:false isn't valid;
// the Photos tab is already conditionally rendered (activeTab ===
// 'photos') so the chunk only downloads when the user opens the
// tab regardless.
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
import {
  parseDetailTab,
  type DetailTabId,
} from '@/components/inventory/item-detail-tabs-shared';
import { ItemSerialsPanel } from '@/components/inventory/item-serials-panel';
import { PublicVisibilityControl } from '@/components/inventory/public-visibility-control';
import { MarketPricePanel } from '@/components/inventory/market-price-panel';
import { StockStatusBadge } from '@/components/inventory/stock-status-badge';
import { StockAdjustDialog } from '@/components/inventory/stock-adjust-dialog';
import { StockTransferDialog } from '@/components/inventory/stock-transfer-dialog';
import { ReportProblemButton } from '@/components/maintenance/report-problem-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { ActivityService, auditLimitFor, type ActivityEvent } from '@/server/services/activity';
import { isModuleEnabled, ServiceError, withContext } from '@/server/services/context';
import { CustomFieldsService } from '@/server/services/custom-fields';
import { InventoryService } from '@/server/services/inventory';
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
import { WarehousesService } from '@/server/services/warehouses';
import { ITEM_ACTIVITY_PAGE_SIZE, nextActivityCursor } from '@/lib/activity-pagination';
import { formatGrade, getCrateColor, readBookStorage } from '@/lib/book-storage';
import { isNextControlFlowError, reportError } from '@/lib/error-reporter';
import { formatCurrency, formatNumber, formatRelative } from '@/lib/utils';

import { can, holdingsContradictRack, isLikelyIsbn, type CustomFieldDefinition } from '@stockpilot/core';
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

export async function ItemDetail({ id, backHref, backLabel, editHref, tab, returnParam, reservedQuantity }: ItemDetailProps) {
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
  const itemRead = inventorySvc.get(id, { withUpdater: true });
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
  ]);

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
  const itemPublicVisibility =
    ((item as { public_visibility?: string | null }).public_visibility ?? 'internal_only') as
      | 'internal_only'
      | 'public'
      | 'hidden';
  const categoryIsInternalOnly =
    ((category as { public_visibility?: string | null } | null)?.public_visibility ??
      'public') === 'internal_only';
  // Public display-name override (0261): surfaced read-only next to the
  // visibility control so catalog managers can see at a glance that the
  // public label differs from the internal name. Edited on the item edit form.
  const itemPublicDisplayName =
    (item as { public_display_name?: string | null }).public_display_name?.trim() || null;

  // ── Serial numbers panel ───────────────────────────────────────────
  // (rule and warehouse-name read: see `serialsPanelShown` above)
  const showSerialsPanel = serialsPanelShown(serialsPage.total);

  return (
    <div className="container mx-auto max-w-5xl px-4 pb-6 sm:px-6 sm:pb-8">
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
          leaks through above the sticky. */}
      <div className="bg-card border-border sticky top-0 z-20 -mx-4 border-b px-4 py-4 sm:-mx-6 sm:px-6">
        <div className="mb-3">
          <Link
            href={backHref}
            className="text-muted-foreground hover:text-foreground inline-flex items-center text-sm"
          >
            ← {backLabel}
          </Link>
        </div>

        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="break-words text-xl font-semibold tracking-tight sm:text-2xl">
                {item.name as string}
              </h1>
              <StockStatusBadge
                quantity={item.quantity_on_hand as number}
                reorderPoint={item.reorder_point as number}
                itemStatus={item.status as 'active' | 'archived' | 'discontinued'}
                // Expected item (mig 0277) reached via search / direct
                // link: the verbose pill gives the context inline.
                awaitingFirstReceipt={
                  (item as { awaiting_first_receipt?: boolean }).awaiting_first_receipt === true
                }
                expectedVerbose
              />
              <PageTour tour={ITEM_DETAIL_TOUR} />
            </div>
            <p className="text-muted-foreground mt-1 break-all font-mono text-xs">
              {item.sku as string}
            </p>
          </div>
          {/*
            Action buttons: on small screens, scroll horizontally as a
            single row instead of wrapping into 2-3 stacked rows that
            push the rest of the page off the fold. Inner div uses
            `w-max` so children keep their natural width inside the
            scroll viewport.
          */}
          <div data-tour="item-actions" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <div className="flex w-max gap-2 sm:flex-wrap">
              {canEditItem && (() => {
                // Append the return param so editing → save still bounces
                // back to the same list URL the user came from.
                const editBase = editHref ?? `/dashboard/inventory/${id}/edit`;
                const href = returnParam
                  ? `${editBase}?return=${encodeURIComponent(returnParam)}`
                  : editBase;
                return (
                  <Button asChild variant="outline" size="sm" className="sm:size-auto">
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
              <Button asChild variant="outline" size="sm" className="sm:size-auto">
                <Link href={`/dashboard/inventory/labels?items=${id}`}>
                  <Printer className="h-4 w-4" /> Print label
                </Link>
              </Button>
              {canAdjustStock && (
                <StockAdjustDialog
                  itemId={id}
                  itemName={item.name as string}
                  currentQuantity={item.quantity_on_hand as number}
                />
              )}
              {canTransferStock && locations.length >= 2 && (
                <StockTransferDialog
                  itemId={id}
                  itemName={item.name as string}
                  currentQuantity={item.quantity_on_hand as number}
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
                  itemType={(item.item_type as string | null) ?? null}
                  // CONTEXT ONLY — the dialog never predicts or acknowledges a
                  // crate change from this snapshot; it confirms from the
                  // server's own refusal payload. See the prop's doc comment.
                  bookStorage={
                    item.item_type === 'book'
                      ? readBookStorage(item.custom_fields as Record<string, unknown> | null)
                      : null
                  }
                  canMintDestination={canMintDestination}
                />
              )}
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
        >
          <div className="mt-6 grid gap-4 sm:mt-8 sm:gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-base">Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <DetailRow icon={Boxes} label="On hand">
                  <span className="text-base font-semibold tabular-nums">
                    {formatNumber(item.quantity_on_hand as number)} {item.unit_of_measure as string}
                  </span>
                  <StockStatusBadge
                    quantity={item.quantity_on_hand as number}
                    reorderPoint={item.reorder_point as number}
                    itemStatus={item.status as 'active' | 'archived' | 'discontinued'}
                    awaitingFirstReceipt={
                      (item as { awaiting_first_receipt?: boolean }).awaiting_first_receipt === true
                    }
                  />
                  <StockAvailabilityLine
                    onHand={Number(item.quantity_on_hand ?? 0)}
                    reserved={reservedByItem.get(id) ?? 0}
                    unit={item.unit_of_measure as string}
                  />
                  <PlacementsBreakdown
                    placements={holdings}
                    itemId={id}
                    itemName={item.name as string}
                    // Rack-scoped write-off (2026-07-23): the tool to reach for
                    // instead of archiving a whole item to clear one rack. Gated
                    // on the same permission adjustStock asserts; archived items
                    // can't be adjusted, so hide it there too.
                    canRemoveStock={canAdjustStock && item.status !== 'archived'}
                  />
                  {(() => {
                    // Staged + Unplaced = on-hand that hasn't been put away
                    // yet (derivePlacement fields assigned by svc.get above).
                    const awaitingPutAway =
                      Number((item as { staged_quantity?: number }).staged_quantity ?? 0) +
                      Number((item as { unplaced_quantity?: number }).unplaced_quantity ?? 0);
                    if (awaitingPutAway <= 0) return null;
                    // The "On hand" number above INCLUDES this awaiting-put-away
                    // stock, but the placed-rack breakdown does NOT — so without
                    // this line the racks (e.g. 250 + 250 = 500) don't add up to
                    // On hand (600). Spell the split out so active vs. staged is
                    // never silently combined (owner report 2026-07-09): placed +
                    // awaiting put-away = on hand.
                    const onHand = Number(item.quantity_on_hand as number) || 0;
                    const placed = Math.max(0, onHand - awaitingPutAway);
                    return (
                      <p className="text-muted-foreground w-full text-xs">
                        <span className="text-foreground font-medium tabular-nums">
                          {formatNumber(placed)}
                        </span>{' '}
                        placed{' + '}
                        <span className="text-warning font-medium tabular-nums">
                          {formatNumber(awaitingPutAway)}
                        </span>{' '}
                        awaiting put-away{' = '}
                        <span className="text-foreground font-medium tabular-nums">
                          {formatNumber(onHand)}
                        </span>{' '}
                        on hand
                      </p>
                    );
                  })()}
                </DetailRow>
                {/* Rentals reservation surface — only the rentals item detail
                    page passes `reservedQuantity`. Checking out a rental
                    reserves stock instead of decrementing on-hand, so without
                    these rows a checkout looks invisible. Hidden entirely
                    when the prop is absent (inventory/books) or zero. */}
                {reservedQuantity !== undefined && reservedQuantity > 0 && (
                  <>
                    <DetailRow icon={CalendarClock} label="Out on rental">
                      <span className="text-base font-semibold tabular-nums">
                        {formatNumber(reservedQuantity)} {item.unit_of_measure as string}
                      </span>
                    </DetailRow>
                    <DetailRow icon={PackageCheck} label="Available">
                      <span className="text-base font-semibold tabular-nums">
                        {formatNumber(
                          Math.max(0, (item.quantity_on_hand as number) - reservedQuantity),
                        )}{' '}
                        {item.unit_of_measure as string}
                      </span>
                    </DetailRow>
                  </>
                )}
                <DetailRow icon={DollarSign} label="Value">
                  <span className="text-base tabular-nums">{formatCurrency(value)}</span>
                  <span className="text-muted-foreground text-xs">
                    @ {formatCurrency(item.unit_cost as number)} unit cost
                  </span>
                </DetailRow>
                <Separator />
                <DetailRow icon={Tag} label="Category">
                  {category ? (
                    <span>{category.name as string}</span>
                  ) : (
                    <span className="text-muted-foreground">Uncategorized</span>
                  )}
                </DetailRow>
                {canManagePublicVisibility && (
                  <DetailRow icon={Globe} label="Public visibility">
                    <PublicVisibilityControl
                      itemId={id}
                      value={itemPublicVisibility}
                      categoryIsInternalOnly={categoryIsInternalOnly}
                    />
                    {itemPublicDisplayName && (
                      <span className="text-muted-foreground basis-full text-xs">
                        Public name: {itemPublicDisplayName}
                      </span>
                    )}
                  </DetailRow>
                )}
                <DetailRow icon={MapPin} label="Location">
                  {location ? (
                    <span>{location.name as string}</span>
                  ) : (
                    <span className="text-muted-foreground">Not set</span>
                  )}
                  {item.bin_location && (
                    <span className="text-muted-foreground text-xs">
                      {item.bin_location as string}
                    </span>
                  )}
                </DetailRow>
                {item.item_type !== 'book' && item.model_number ? (
                  <DetailRow icon={Hash} label="Model #">
                    <span className="font-mono tabular-nums">
                      {item.model_number as string}
                    </span>
                  </DetailRow>
                ) : null}
                {(() => {
                  const storage = readBookStorage(
                    item.custom_fields as Record<string, unknown> | null,
                  );
                  const color = getCrateColor(storage.crateColor);
                  const cf = (item.custom_fields as Record<string, unknown> | null) ?? {};
                  const isBook = item.item_type === 'book';
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
                  // PlacementsBreakdown a few rows up already shows the truth,
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
                  // breakdown directly above.
                  const rackContradicted = holdingsContradictRack(
                    storage.rackLabel,
                    holdings
                      .filter((h) => h.kind === 'rack' || h.kind === 'crate')
                      .map((h) => ({ name: h.name, quantity: h.quantity, kind: h.kind })),
                  );
                  const showRack = !!storage.rackLabel && !rackContradicted;
                  const hasAny = isBook || storage.grade || showRack || storage.crateNumber || isbn;
                  if (!hasAny) return null;
                  return (
                    <>
                      {isBook && (
                        <DetailRow icon={Hash} label="ISBN">
                          {isbn ? (
                            <span className="font-mono tabular-nums">{isbn}</span>
                          ) : (
                            <span className="text-muted-foreground">Not set</span>
                          )}
                        </DetailRow>
                      )}
                      {storage.grade && (
                        <DetailRow icon={GraduationCap} label="Grade">
                          <span>{formatGrade(storage.grade)}</span>
                        </DetailRow>
                      )}
                      {showRack && (
                        <DetailRow icon={MapPin} label="Rack">
                          <span className="font-mono tabular-nums">{storage.rackLabel}</span>
                        </DetailRow>
                      )}
                      {storage.crateNumber && (
                        <DetailRow icon={Box} label="Crate">
                          <span className="inline-flex items-center gap-2">
                            <span
                              aria-hidden
                              title={color ? color.label : 'No color set'}
                              className="border-border inline-block h-3 w-3 rounded-full border"
                              style={color ? { backgroundColor: color.hex } : undefined}
                            />
                            <span>
                              {color ? `${color.label} ` : ''}
                              <span className="font-mono tabular-nums">{storage.crateNumber}</span>
                            </span>
                          </span>
                        </DetailRow>
                      )}
                    </>
                  );
                })()}
                <DetailRow icon={Truck} label="Supplier">
                  {supplier ? (
                    <span>{supplier.name as string}</span>
                  ) : (
                    <span className="text-muted-foreground">No supplier</span>
                  )}
                </DetailRow>
                {(item.description as string | null) && (
                  <>
                    <Separator />
                    <div className="space-y-1.5">
                      <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
                        Description
                      </p>
                      <p className="whitespace-pre-wrap text-sm">{item.description as string}</p>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Reorder</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <Stat
                  label="Reorder at"
                  value={`${formatNumber(item.reorder_point as number)} ${item.unit_of_measure as string}`}
                />
                <Stat
                  label="Reorder qty"
                  value={`${formatNumber(item.reorder_quantity as number)} ${item.unit_of_measure as string}`}
                />
                <Stat label="Retail price" value={formatCurrency(item.retail_price as number)} />
                <Stat
                  label="Status"
                  value={(item.status as string).replace(/^./, (s) => s.toUpperCase())}
                />
              </CardContent>
            </Card>

            {/* Per-org custom fields — only the org's DEFINED item fields that
                this item has a value for. Reserved/hardcoded keys are rendered
                by their own detail rows above and are never represented here. */}
            {definedCustomFields.length > 0 && (
              <Card className="sm:col-span-2">
                <CardHeader>
                  <CardTitle className="text-base">Additional fields</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {definedCustomFields.map(({ def, display }) => (
                    <Stat key={def.id} label={def.label} value={display as string} />
                  ))}
                </CardContent>
              </Card>
            )}
          </div>

          {/* Market price (Phase 6) — external Google Books list/retail by
              ISBN, gated behind the optional price_tracking module + an
              ISBN-ish barcode. Renders nothing (and loads nothing) when the
              module is off, keeping item detail byte-identical otherwise. */}
          {showMarketPrice && (
            <div className="mt-8">
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
            <Card className="mt-8">
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <LineChart className="h-4 w-4" /> Cost trend
                    </CardTitle>
                    <p className="text-muted-foreground mt-1 text-xs">
                      Unit cost paid over time, by supplier · from purchase orders &amp; receipts
                    </p>
                  </div>
                  <div className="flex gap-4 text-right">
                    {costHistory.lastUnitCost != null && (
                      <div>
                        <p className="text-muted-foreground text-[10.5px] font-semibold uppercase tracking-wider">
                          Last paid
                        </p>
                        <p className="text-sm font-semibold tabular-nums">
                          {formatCurrency(costHistory.lastUnitCost)}
                        </p>
                      </div>
                    )}
                    {costHistory.avgUnitCost != null && (
                      <div>
                        <p className="text-muted-foreground text-[10.5px] font-semibold uppercase tracking-wider">
                          Average
                        </p>
                        <p className="text-sm font-semibold tabular-nums">
                          {formatCurrency(costHistory.avgUnitCost)}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <CostTrendIsland series={costHistory.series} />
              </CardContent>
            </Card>
          )}

          {/* Serial numbers — manual registry management. Rendered for
              serial-tracked items or items that already have registry rows;
              first page + total are server-loaded, the panel paginates and
              mutates via server actions. */}
          {showSerialsPanel && (
            <ItemSerialsPanel
              itemId={id}
              canEditItems={canEditItem}
              warehouses={serialWarehouses}
              initialRows={serialsPage.rows}
              initialTotal={serialsPage.total}
            />
          )}

          <Card className="mt-8">
            <CardHeader>
              <CardTitle className="text-base">Images</CardTitle>
            </CardHeader>
            <CardContent>
              {/* Fallback: when there are no rows in item_images yet but the
                  ISBN-import pipeline stashed a cover URL on the row's
                  custom_fields, render it inline so the detail page shows
                  the cover the list page is already showing. The uploader
                  still works underneath — uploading saves to item_images
                  and supersedes this preview. */}
              {images.length === 0
                ? (() => {
                    const cf = (item as { custom_fields?: Record<string, unknown> | null })
                      .custom_fields;
                    const cfThumb =
                      cf && typeof cf === 'object' && typeof cf.thumbnail_url === 'string'
                        ? (cf.thumbnail_url as string)
                        : null;
                    return cfThumb ? (
                      <div className="mb-4 flex items-start gap-3 rounded-md border border-border bg-muted/40 p-3">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={cfThumb}
                          alt=""
                          width={64}
                          height={88}
                          loading="lazy"
                          decoding="async"
                          className="rounded-sm border border-border bg-background object-cover"
                          style={{ aspectRatio: '3/4' }}
                        />
                        <div className="text-muted-foreground text-[12px] leading-relaxed">
                          <div className="text-foreground mb-0.5 text-[12.5px] font-medium">
                            Cover from ISBN lookup
                          </div>
                          Imported from a third-party source (Google Books / Open Library / Library
                          of Congress). Upload a photo below to replace it with your own — the
                          uploaded image becomes the primary.
                        </div>
                      </div>
                    ) : null;
                  })()
                : null}
              <ImageUploader itemId={id} initialImages={images} />
            </CardContent>
          </Card>
        </div>
      )}

      {activeTab === 'movements' && (
        <div
          role="tabpanel"
          id="item-detail-panel-movements"
          aria-labelledby="item-detail-tab-movements"
        >
          <Card className="mt-6 sm:mt-8">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <History className="h-4 w-4" /> Stock movements
              </CardTitle>
            </CardHeader>
            <CardContent>
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
                />
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {activeTab === 'activity' && (
        <div
          role="tabpanel"
          id="item-detail-panel-activity"
          aria-labelledby="item-detail-tab-activity"
        >
          <Card className="mt-6 sm:mt-8">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <History className="h-4 w-4" /> Activity
              </CardTitle>
            </CardHeader>
            <CardContent>
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
                />
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Footer: last updated by ────────────────────────────────── */}
      {updatedAt && (
        <p className="text-muted-foreground mt-8 text-center text-xs">
          {updatedByName
            ? `Last updated by ${updatedByName} · ${formatRelative(updatedAt)}`
            : `Last updated ${formatRelative(updatedAt)}`}
        </p>
      )}
    </div>
  );
}

function DetailRow({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="text-muted-foreground mt-0.5 h-4 w-4" />
      <div className="flex-1 space-y-0.5">
        <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
          {label}
        </p>
        <div className="flex flex-wrap items-center gap-2">{children}</div>
      </div>
    </div>
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
    <div role="alert" className="text-muted-foreground py-10 text-center text-sm">
      <p>Could not load this item&rsquo;s {what}. The history itself is unchanged.</p>
      <Link
        href={retryHref}
        prefetch={false}
        className="text-foreground mt-2 inline-block font-medium underline underline-offset-4"
      >
        Try again
      </Link>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}
