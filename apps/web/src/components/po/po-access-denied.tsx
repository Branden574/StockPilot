import { StatePanel } from '@/components/patterns/state-panel';

/**
 * Shown when a user lacks purchase_orders:read. Rendered by both the
 * /purchase-orders section layout AND each PO page directly — the page-level
 * guard is the authoritative one, because Next renders a page concurrently with
 * its layout, so a page that throws (e.g. a service assertPermission) would trip
 * the error boundary ("Something broke loading this page") BEFORE the layout's
 * gate could show this card. Gating in-page, before any throwing service call,
 * guarantees the clean denial.
 *
 * The look is P2.6's StatePanel (kind forbidden, page size, its title the
 * page's only h1), inside the page's gutters, as ModuleNotEnabled draws it.
 */
export function PoAccessDenied() {
  return (
    <div className="w-full px-4 py-16 sm:px-8 sm:py-24">
      <StatePanel
        kind="forbidden"
        size="page"
        headingLevel={1}
        title={<>You don&apos;t have access to purchase orders</>}
        description={
          <>
            Viewing purchase orders needs the &ldquo;View purchase orders&rdquo; permission, which
            isn&apos;t enabled for your account.
          </>
        }
        action={
          <p className="text-muted-foreground text-[13.5px]">
            Ask an owner or admin to enable it from Settings → Roles &amp; permissions.
          </p>
        }
      />
    </div>
  );
}
