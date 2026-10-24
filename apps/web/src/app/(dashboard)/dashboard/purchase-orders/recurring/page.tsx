import { redirect } from 'next/navigation';

import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';

import type {
  RecurringLineLabel,
  RecurringSeedDestination,
} from '@/components/po/recurring-templates-panel';
import { RecurringTemplatesSeedLoader } from '@/components/po/recurring-templates-seed-loader';
import { requireOrgContext } from '@/lib/auth/session';
import { purchaseOrderItemTypes } from '@/lib/purchase-orders/item-types';
import { InventoryService } from '@/server/services/inventory';
import { reportDegradedRead } from '@/server/services/lib/fetch-by-ids';
import { fetchAllRows } from '@/server/services/lib/paginate';
import { readUnofferedDestinations, readUnofferedSuppliers } from '@/server/services/lib/unoffered-choices';
import { LocationsService } from '@/server/services/locations';
import { RecurringPoTemplatesService } from '@/server/services/recurring-pos';
import { SuppliersService } from '@/server/services/suppliers';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { createClient } from '@/lib/supabase/server';
import { withContext } from '@/server/services/context';

import { can, planAllowsRecurringPos, type OrgBillingState } from '@stockpilot/core';

/** The page area (DESIGN-SPEC 5.3 and 4): max 1320, 16 px gutters on a phone. */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Recurring purchase orders management page.
 * Pro+ gated; requires `purchase_orders` module + `purchase_orders:manage`.
 * Lists recurring PO templates and renders the create/edit panel.
 *
 * "Make recurring" on a PO opens this page as `?from=<poId>`. The button
 * fetched the seed and stored it in the tab's sessionStorage, and
 * RecurringTemplatesSeedLoader opens the create form with it, only for the PO
 * that `from` names (lib/purchase-orders/recurring-seed.ts). The server reads
 * only that PO's item ids, to label seeded lines the picker does not list,
 * and its destination, so the form never keeps one it does not offer.
 */
export default async function RecurringPosPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string | string[] }>;
}) {
  const moduleAccess = await checkModuleAccess('purchase_orders');
  if (!moduleAccess.enabled) {
    return <ModuleNotEnabled moduleId="purchase_orders" canManage={moduleAccess.canManage} />;
  }

  const ctx = await requireOrgContext();
  if (!can(ctx, 'purchase_orders:manage')) {
    redirect('/dashboard/purchase-orders');
  }

  const supabase = await createClient();

  const fromParam = (await searchParams).from;
  const fromPoId = typeof fromParam === 'string' && UUID_RE.test(fromParam) ? fromParam : null;

  const [orgBillingRes, svcCtx, inventorySvc, suppliersSvc, locationsSvc] = await Promise.all([
    supabase
      .from('organizations')
      .select(
        'plan, access_tier, billing_arrangement, stripe_subscription_id, trial_ends_at, trial_tier',
      )
      .eq('id', ctx.organizationId)
      .maybeSingle(),
    withContext(),
    InventoryService.forCurrentUser(),
    SuppliersService.forCurrentUser(),
    LocationsService.forCurrentUser(),
  ]);

  const templates = await new RecurringPoTemplatesService(svcCtx).list();

  const entitled = planAllowsRecurringPos(
    ((orgBillingRes.data as OrgBillingState | null) ?? { plan: null }) as OrgBillingState,
  );

  // "Make recurring" fills the form in the browser from the PO that `from`
  // names, and its lines can point at items the picker below does not list: a
  // rental (the picker never lists rentals, while a PO may hold them, as the
  // PO form shows), an archived item, one past the picker's 1000. Read that
  // PO's item ids so those lines are labelled too (production 2026-10-06:
  // PO-DEMO-002's rental lines read "Item not available"). A label is a
  // convenience: a failed read leaves them unlabelled, never an error page.
  const fromPoItemIds = async (): Promise<string[]> => {
    if (!fromPoId) return [];
    try {
      const rows = await fetchAllRows<{ id: string; item_id: string }>((from, to) =>
        supabase
          .from('purchase_order_items')
          .select('id, item_id')
          .eq('organization_id', ctx.organizationId)
          .eq('purchase_order_id', fromPoId)
          .order('id', { ascending: true })
          .range(from, to),
      );
      return rows.map((r) => r.item_id);
    } catch (err) {
      reportDegradedRead('recurring_pos.page.seed_line_labels', err, { from: true });
      return [];
    }
  };

  // Where that purchase order went. The form offers only the sites below, and
  // a purchase order can go elsewhere: a staging area (four Demo Co purchase
  // orders, production 2026-10-06) or a location deleted since (three of
  // Learn4Life's). The form showed such a destination blank and saved it
  // anyway, so every purchase order the template created would have gone
  // there. Read here (the caller's organization, through RLS), not taken from
  // the seed, which sat in the browser: the form then opens with no
  // destination and says where the purchase order went. A failed read means
  // no name, never an error page. The same read gives its supplier, which the
  // form may not offer either (archived since; small fixes slice 8): it is
  // read with the templates' suppliers below.
  const fromPoDestination = async (): Promise<{
    destination: RecurringSeedDestination | null;
    supplierId: string | null;
  }> => {
    if (!fromPoId) return { destination: null, supplierId: null };
    try {
      const { data, error } = await supabase
        .from('purchase_orders')
        .select(
          'destination_location_id, supplier_id, destination:locations!destination_location_id (name, deleted_at)',
        )
        .eq('organization_id', ctx.organizationId)
        .eq('id', fromPoId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return { destination: null, supplierId: null };
      const supplierId = (data as { supplier_id?: string | null }).supplier_id ?? null;
      const locationId = (data as { destination_location_id: string | null }).destination_location_id;
      if (!locationId) return { destination: { locationId: null, name: null, deleted: false }, supplierId };
      // A many-to-one embed: one row (typed as a list), as PurchaseOrdersService.get reads it.
      const embedded = (data as { destination?: unknown }).destination;
      const location = (Array.isArray(embedded) ? embedded[0] : embedded) as
        { name?: string | null; deleted_at?: string | null } | null | undefined;
      return {
        destination: {
          locationId,
          name: location?.name?.trim() || null,
          deleted: location?.deleted_at != null,
        },
        supplierId,
      };
    } catch (err) {
      reportDegradedRead('recurring_pos.page.seed_destination', err, { from: true });
      return { destination: null, supplierId: null };
    }
  };

  const [inventory, suppliers, locations, seedItemIds, fromPo] = await Promise.all([
    // expected:'any' (mig 0277): recurring-PO templates are inbound
    // ordering — the picker must offer items still awaiting their first
    // receipt so a template can reference them instead of inviting a
    // duplicate item (same rule as the PO create/edit pickers).
    //
    // itemTypes (PURCHASE_ORDER_ITEM_TYPES): the SAME constant the PO
    // create/edit pages pass, so a recurring template can order every type a
    // one-off PO can. Without it list() falls back to `item_type = 'product'`
    // and books are invisible here too.
    //
    // excludeBundles: a kit's pre-assembled stock is never ordered, and a
    // template holding one is refused on save (0366 rule), so the picker
    // never offers it.
    inventorySvc.list({
      limit: 1000,
      expected: 'any',
      itemTypes: purchaseOrderItemTypes(),
      excludeBundles: true,
    }),
    suppliersSvc.listForLookups(),
    locationsSvc.list({ sitesOnly: true }),
    fromPoItemIds(),
    fromPoDestination(),
  ]);

  // Saved template lines, and the lines Make recurring seeds from `from`, can
  // point at items the picker above does not list: deleted since, a kit's
  // pre-assembled stock, archived, a rental. Resolve those by id so each line
  // says what it is. Saving a template that holds a deleted item or a kit is
  // refused by that item's name, and this is how the buyer finds the line to
  // remove. A label is a convenience: a failed read shows the page without
  // it (recurring pattern #1), never an error page.
  const listedIds = new Set(inventory.items.map((i) => i.id as string));
  const unlistedIds = [
    ...new Set([
      ...templates.flatMap((t) =>
        (Array.isArray(t.line_items) ? (t.line_items as Array<{ itemId?: unknown }>) : []).map(
          (l) => (typeof l?.itemId === 'string' ? l.itemId : ''),
        ),
      ),
      ...seedItemIds,
    ]),
  ].filter((id) => UUID_RE.test(id) && !listedIds.has(id));
  // What the form offers: sites linked to a warehouse, and the active
  // suppliers. Every purchase order a template creates is saved like a
  // hand-made one, and that save refuses a location linked to no warehouse
  // (so does the template save).
  const locationOptions = locations
    .filter((l) => Boolean((l as { warehouse_id?: string | null }).warehouse_id))
    .map((l) => ({ id: l.id as string, name: l.name as string }));
  const offeredLocationIds = new Set(locationOptions.map((l) => l.id));
  const offeredSupplierIds = new Set(suppliers.map((s) => s.id as string));

  // Templates can hold a destination or supplier the form does not offer: a
  // destination deleted after the template was saved (its save is refused by
  // that name since #334, and the daily run now skips it), or an archived
  // supplier, and so can the purchase order Make recurring starts from. The
  // form showed those blank; it now keeps none of them and names each (small
  // fixes slice 8, items B and D), so read what they are, in this
  // organization through RLS. Labels only: a failed read names nothing,
  // never an error page.
  const unofferedDestinationIds = templates
    .map((t) => t.destination_location_id)
    .filter((id): id is string => Boolean(id) && !offeredLocationIds.has(id as string));
  const seedDestination = fromPo.destination;
  const unofferedSupplierIds = [...templates.map((t) => t.supplier_id), fromPo.supplierId].filter(
    (id): id is string => Boolean(id) && !offeredSupplierIds.has(id as string),
  );
  const [unofferedDestinations, unofferedSuppliers] = await Promise.all([
    readUnofferedDestinations(
      supabase,
      ctx.organizationId,
      unofferedDestinationIds,
      'recurring_pos.page.unoffered_destinations',
    ),
    readUnofferedSuppliers(
      (ids) => suppliersSvc.namesByIds(ids),
      unofferedSupplierIds,
      'recurring_pos.page.unoffered_suppliers',
    ),
  ]);

  let lineLabels: RecurringLineLabel[] = [];
  if (unlistedIds.length > 0) {
    try {
      const rows = await inventorySvc.lineLabelsByIds(unlistedIds, { itemType: 'all' });
      lineLabels = rows.map((r) => ({
        id: r.id,
        name: r.name,
        sku: r.sku,
        deleted: r.deleted_at != null,
        kitStock: r.is_bundle === true,
      }));
    } catch (err) {
      reportDegradedRead('recurring_pos.page.line_labels', err, { ids: unlistedIds.length });
    }
  }

  return (
    <div className={PAGE}>
      <PageHeader
        back={
          <PageHeaderBackLink href="/dashboard/purchase-orders">
            ← Purchase orders
          </PageHeaderBackLink>
        }
        title="Recurring purchase orders"
        subline="Templates that auto-create a purchase order on a schedule — weekly, monthly, quarterly, or custom."
      />

      <RecurringTemplatesSeedLoader
        initial={templates}
        items={inventory.items.map((i) => ({
          id: i.id,
          name: i.name,
          sku: i.sku,
          unit_cost: i.unit_cost,
        }))}
        // A supplier still active that the list lacks only because the
        // Suppliers module is off is offered after all, so a template keeps it.
        suppliers={[
          ...suppliers.map((s) => ({ id: s.id as string, name: s.name as string })),
          ...unofferedSuppliers.fold,
        ]}
        locations={locationOptions}
        entitled={entitled}
        lineLabels={lineLabels}
        seedDestination={seedDestination}
        unofferedDestinations={Object.fromEntries(unofferedDestinations)}
        unofferedSuppliers={Object.fromEntries(unofferedSuppliers.unoffered)}
      />
    </div>
  );
}
