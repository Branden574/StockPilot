import Link from 'next/link';
import { redirect } from 'next/navigation';
import { RefreshCw } from 'lucide-react';

import type { RecurringLineLabel } from '@/components/po/recurring-templates-panel';
import { RecurringTemplatesSeedLoader } from '@/components/po/recurring-templates-seed-loader';
import { requireOrgContext } from '@/lib/auth/session';
import { purchaseOrderItemTypes } from '@/lib/purchase-orders/item-types';
import { InventoryService } from '@/server/services/inventory';
import { reportDegradedRead } from '@/server/services/lib/fetch-by-ids';
import { fetchAllRows } from '@/server/services/lib/paginate';
import { LocationsService } from '@/server/services/locations';
import { RecurringPoTemplatesService } from '@/server/services/recurring-pos';
import { SuppliersService } from '@/server/services/suppliers';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { createClient } from '@/lib/supabase/server';
import { withContext } from '@/server/services/context';

import { can, planAllowsRecurringPos, type OrgBillingState } from '@stockpilot/core';

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
 * only that PO's item ids, to label seeded lines the picker does not list.
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

  const [inventory, suppliers, locations, seedItemIds] = await Promise.all([
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
        (Array.isArray(t.line_items) ? (t.line_items as Array<{ itemId?: unknown }>) : []).map((l) =>
          typeof l?.itemId === 'string' ? l.itemId : '',
        ),
      ),
      ...seedItemIds,
    ]),
  ].filter((id) => UUID_RE.test(id) && !listedIds.has(id));
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
    <div className="container mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/purchase-orders"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Purchase orders
        </Link>
        <div className="mt-2 flex items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <RefreshCw className="h-6 w-6" /> Recurring purchase orders
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Templates that auto-create a purchase order on a schedule — weekly, monthly,
              quarterly, or custom.
            </p>
          </div>
        </div>
      </div>

      <RecurringTemplatesSeedLoader
        initial={templates}
        items={inventory.items.map((i) => ({
          id: i.id,
          name: i.name,
          sku: i.sku,
          unit_cost: i.unit_cost,
        }))}
        suppliers={suppliers.map((s) => ({ id: s.id as string, name: s.name as string }))}
        locations={locations.map((l) => ({ id: l.id as string, name: l.name as string }))}
        entitled={entitled}
        lineLabels={lineLabels}
      />
    </div>
  );
}
