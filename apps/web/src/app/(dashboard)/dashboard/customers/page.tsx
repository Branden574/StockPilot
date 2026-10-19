import { redirect } from 'next/navigation';
import { TriangleAlert } from 'lucide-react';

import { CustomersPanel } from '@/components/customers/customers-panel';
import { PortalPricingModePanel } from '@/components/customers/portal-pricing-mode-panel';
import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { PageHeader } from '@/components/patterns/page-header';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { requireOrgContext } from '@/lib/auth/session';
import { effectiveNavLabel } from '@/lib/nav-labels';
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
  const [orgBillingRes, portalModuleRes, svcCtx, inventorySvc, title] = await Promise.all([
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
    // The heading follows a Settings > Navigation rename of Accounts (PLAN
    // rule 10), from the request-cached org row the layout already holds;
    // an unreadable row keeps the page's own heading.
    effectiveNavLabel('/dashboard/customers', 'Accounts').catch(() => 'Accounts'),
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

  // Per-customer detail (users + catalog) and per-list prices, loaded up front
  // with ONE batched read each. This used to be one request per customer (twice)
  // and one per price list, all started at once: up to 500 × 2 + 200 = 1,200
  // requests for one page view, the shape that drove 190 of 443 requests to 502
  // on the lab org.
  const customerIds = customers.map((c) => c.id);
  const [usersByCustomer, catalogByCustomer, pricesByList] = await Promise.all([
    svc.listUsersByCustomer(customerIds),
    svc.listCatalogByCustomer(customerIds),
    svc.listPricesByList(priceLists.map((pl) => pl.id)),
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
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
      <PageHeader
        title={title}
        subline="B2B accounts that order through your portal — each with its own users, price list, and catalog. The catalog alone decides what an account can see and order."
      />

      {!entitled && (
        <div
          data-slot="plan-notice"
          className="border-warning/40 bg-warning-wash text-foreground flex items-start gap-2.5 rounded-lg border px-[18px] py-3.5 text-[13.5px]"
        >
          <TriangleAlert aria-hidden className="text-warning mt-0.5 h-4 w-4 shrink-0" />
          <p>
            The B2B customer portal is a <strong className="font-medium">Business</strong> feature.
            You can review existing data, but creating customers and inviting portal users needs a
            Business or Enterprise plan.
          </p>
        </div>
      )}

      {canSetPricingMode && <PortalPricingModePanel initial={pricingMode} />}

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
