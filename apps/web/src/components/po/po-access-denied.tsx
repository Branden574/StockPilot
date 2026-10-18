import { AccessStateCard } from '@/components/dashboard/module-not-enabled';

/**
 * Shown when a user lacks purchase_orders:read. Rendered by both the
 * /purchase-orders section layout AND each PO page directly — the page-level
 * guard is the authoritative one, because Next renders a page concurrently with
 * its layout, so a page that throws (e.g. a service assertPermission) would trip
 * the error boundary ("Something broke loading this page") BEFORE the layout's
 * gate could show this card. Gating in-page, before any throwing service call,
 * guarantees the clean denial.
 */
export function PoAccessDenied() {
  return (
    <AccessStateCard
      title={<>You don&apos;t have access to purchase orders</>}
      description={
        <>
          Viewing purchase orders needs the &ldquo;View purchase orders&rdquo; permission, which
          isn&apos;t enabled for your account.
        </>
      }
    >
      <p className="text-muted-foreground text-[13.5px]">
        Ask an owner or admin to enable it from Settings → Roles &amp; permissions.
      </p>
    </AccessStateCard>
  );
}
