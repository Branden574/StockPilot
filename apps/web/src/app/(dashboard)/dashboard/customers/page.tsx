import { redirect } from 'next/navigation';
import { Handshake } from 'lucide-react';

import { CustomersPanel } from '@/components/customers/customers-panel';
import { PortalPricingModePanel } from '@/components/customers/portal-pricing-mode-panel';
import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { withContext } from '@/server/services/context';
import { CustomersService } from '@/server/services/customers';
import { InventoryService } from '@/server/services/inventory';

import { can, planAllowsB2bPortal, resolvePortalPricingMode, type OrgBillingState } from '@stockpilot/core';

/**
 * B2B customers management (b2b_portal module, Phase 1). Business+ gated;
 * requires customers:manage. Customers, portal users, price lists, catalogs,
 * and the org-level pricing mode (does this org charge its customers?).
 */
export default async function CustomersPage() {
  const moduleAccess = await checkModuleAccess('b2b_portal');
  if (!moduleAccess.enabled) {
    return <ModuleNotEnabled moduleId="b2b_portal" canManage={moduleAccess.canManage} />;
  }

  const ctx = await requireOrgContext();
  if (!can(ctx, 'customers:manage')) {
    redirect('/dashboard');
  }

  const supabase = await createClient();
  const [orgBillingRes, portalModuleRes, svcCtx, inventorySvc] = await Promise.all([
    supabase
      .from('organizations')
      .select(
        'plan, access_tier, billing_arrangement, stripe_subscription_id, trial_ends_at, trial_tier',
      )
      .eq('id', ctx.organizationId)
      .maybeSingle(),
    supabase
      .from('organization_modules')
      .select('settings')
      .eq('organization_id', ctx.organizationId)
      .eq('module_id', 'b2b_portal')
      .maybeSingle(),
    withContext(),
    InventoryService.forCurrentUser(),
  ]);
  const pricingMode = resolvePortalPricingMode(
    (portalModuleRes.data as { settings?: unknown } | null)?.settings,
  );
  // Owner/admin only, matching the writer (CustomersService.setPricingMode)
  // and the RLS floor on organization_modules (mig 0219). customers:manage is
  // manager-and-above, so showing the panel to everyone on this page would
  // hand a manager a Save button that can only ever fail.
  const canSetPricingMode = ctx.role === 'owner' || ctx.role === 'admin';

  const svc = new CustomersService(svcCtx);
  const [customers, priceLists, inventory] = await Promise.all([
    svc.list(),
    svc.listPriceLists(),
    inventorySvc.list({ limit: 1000 }),
  ]);

  // Per-customer detail (users + catalog) and per-list prices, loaded up front —
  // customer counts are small at this stage; revisit with lazy loads at scale.
  const [usersByCustomer, catalogByCustomer, pricesByList] = await Promise.all([
    Promise.all(customers.map((c) => svc.listUsers(c.id))).then((r) =>
      Object.fromEntries(customers.map((c, i) => [c.id, r[i] ?? []])),
    ),
    Promise.all(customers.map((c) => svc.listCatalog(c.id))).then((r) =>
      Object.fromEntries(customers.map((c, i) => [c.id, r[i] ?? []])),
    ),
    Promise.all(priceLists.map((pl) => svc.listPrices(pl.id))).then((r) =>
      Object.fromEntries(priceLists.map((pl, i) => [pl.id, r[i] ?? []])),
    ),
  ]);

  const entitled = planAllowsB2bPortal(
    ((orgBillingRes.data as OrgBillingState | null) ?? { plan: null }) as OrgBillingState,
  );

  const items = inventory.items.map((i) => ({
    id: i.id as string,
    name: (i.name as string) ?? '',
    sku: (i.sku as string | null) ?? null,
  }));

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Handshake className="h-6 w-6" /> Accounts
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          B2B accounts that order through your portal — each with its own users,
          price list, and catalog. The catalog alone decides what an account can
          see and order.
        </p>
      </div>

      {!entitled && (
        <div className="border-warning/40 bg-warning/10 mb-6 rounded-xl border p-4 text-sm">
          The B2B customer portal is a <strong>Business</strong> feature. You can
          review existing data, but creating customers and inviting portal users
          needs a Business or Enterprise plan.
        </div>
      )}

      {canSetPricingMode && (
        <div className="mb-6">
          <PortalPricingModePanel initial={pricingMode} />
        </div>
      )}

      <CustomersPanel
        customers={customers}
        priceLists={priceLists}
        items={items}
        usersByCustomer={usersByCustomer}
        catalogByCustomer={catalogByCustomer}
        pricesByList={pricesByList}
        entitled={entitled}
      />
    </div>
  );
}
