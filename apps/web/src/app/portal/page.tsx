import Link from 'next/link';

import { ExternalShell, ExternalStatusCard } from '@/components/auth/external-shell';
import { PortalShop } from '@/components/portal/portal-shop';
import { Button } from '@/components/ui/button';
import { exchangeCreateEnabled } from '@/lib/returns/exchange-switch';
import {
  portalCatalog,
  portalOrders,
  portalReturnsEnabled,
  resolvePortalContext,
} from '@/server/services/portal';

export const dynamic = 'force-dynamic';

/**
 * B2B customer portal (P2/P3): the CUSTOMER-facing storefront. Renders only
 * for signed-in users mapped through customer_users; everything is
 * server-mediated with safe projections (see services/portal.ts).
 *
 * Redesign (P5.1 step B): both states sit on the shared external frame
 * (ExternalShell: no app shell, no session reads of its own). The signed-in
 * portal is the frame's column at the portal's own width (max-w-4xl, as
 * before) under the supplier's brand: logo, name, "Ordering portal ·
 * <customer>". No new reads; the header shows what it showed.
 */
export default async function PortalPage() {
  const ctx = await resolvePortalContext();

  if (!ctx) {
    // The not-a-portal-user prompt on the shared external frame (P5.1): one
    // status card with its own words and its one way in.
    return (
      <ExternalShell width="md">
        <ExternalStatusCard
          title="Supplier ordering portal"
          body={
            <>
              Sign in with the email address your supplier invited, and this page becomes your
              catalog. If you believe you should have access, contact your supplier for an invite.
            </>
          }
          action={
            <Button asChild className="h-11 px-5">
              <Link href="/signin?redirect=%2Fportal">Sign in</Link>
            </Button>
          }
        />
      </ExternalShell>
    );
  }

  const [catalog, orders, returnsEnabled] = await Promise.all([
    portalCatalog(ctx),
    portalOrders(ctx),
    portalReturnsEnabled(ctx),
  ]);

  return (
    <ExternalShell className="max-w-4xl">
      <header className="border-border mb-8 flex items-center gap-3 border-b pb-4">
        {ctx.orgLogoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- external org logo, sized fixed
          <img
            src={ctx.orgLogoUrl}
            alt=""
            className="border-border h-9 w-9 shrink-0 rounded-lg border object-cover"
          />
        ) : null}
        <div className="min-w-0">
          <h1 className="text-foreground font-display text-[22px] font-medium leading-[1.25] tracking-[-0.02em] [overflow-wrap:anywhere]">
            {ctx.orgName}
          </h1>
          <p className="text-muted-foreground text-[13.5px] leading-[20.25px]">
            Ordering portal · {ctx.customerName}
          </p>
        </div>
      </header>

      <PortalShop
        catalog={catalog}
        orders={orders}
        returnsEnabled={returnsEnabled}
        exchangesEnabled={exchangeCreateEnabled()}
        pricingMode={ctx.pricingMode}
      />
    </ExternalShell>
  );
}
