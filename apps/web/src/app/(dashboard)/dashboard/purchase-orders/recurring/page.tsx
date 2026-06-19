import Link from 'next/link';
import { redirect } from 'next/navigation';
import { RefreshCw } from 'lucide-react';

import { RecurringTemplatesSeedLoader } from '@/components/po/recurring-templates-seed-loader';
import { requireOrgContext } from '@/lib/auth/session';
import { InventoryService } from '@/server/services/inventory';
import { LocationsService } from '@/server/services/locations';
import { RecurringPoTemplatesService } from '@/server/services/recurring-pos';
import { SuppliersService } from '@/server/services/suppliers';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { createClient } from '@/lib/supabase/server';
import { withContext } from '@/server/services/context';

import { hasPermission, planAllowsRecurringPos, type OrgBillingState } from '@stockpilot/core';

/**
 * Recurring purchase orders management page.
 * Pro+ gated; requires `purchase_orders` module + `purchase_orders:manage`.
 * Lists recurring PO templates and renders the create/edit panel.
 *
 * An optional `?seed=<poId>` query param is NOT used here — the "Make
 * recurring" button fetches the seed client-side and passes it as a prop
 * (see recurring-template-seed-button.tsx).
 */
export default async function RecurringPosPage() {
  const moduleAccess = await checkModuleAccess('purchase_orders');
  if (!moduleAccess.enabled) {
    return <ModuleNotEnabled moduleId="purchase_orders" canManage={moduleAccess.canManage} />;
  }

  const ctx = await requireOrgContext();
  if (!hasPermission(ctx.role, 'purchase_orders:manage')) {
    redirect('/dashboard/purchase-orders');
  }

  const supabase = await createClient();

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

  const [inventory, suppliers, locations] = await Promise.all([
    inventorySvc.list({ limit: 1000 }),
    suppliersSvc.list(),
    locationsSvc.list(),
  ]);

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
      />
    </div>
  );
}
