import type { Metadata } from 'next';
import { Package, ShoppingCart, Truck } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { formatOrderNumber, ORDER_ITEMS_MANAGE_BUTTON_COPY, RETURNS_COPY } from '@stockpilot/core';

export const metadata: Metadata = { title: 'Orders' };

import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ModuleUnavailable } from '@/components/dashboard/module-unavailable';
import { OrderStatusBadge } from '@/components/orders/status-badge';
import { OrdersExportMenu } from '@/components/orders/orders-export-menu';
import { summaryRequesterLabel } from '@/components/orders/requester-label';
import { PageHeader } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
import { StatStrip, StatStripLink } from '@/components/patterns/stat-strip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { can } from '@stockpilot/core';
import { requireOrgContext } from '@/lib/auth/session';
import { withContext } from '@/server/services/context';
import { canManageOrderItems } from '@/server/services/order-catalog-visibility';
import { OrderRequestsService, type OrderRequestSummary } from '@/server/services/order-requests';
import { formatNumber, formatRelative } from '@/lib/utils';
import { PageTour } from '@/components/onboarding/page-tour';
import { PerfUseful } from '@/components/perf/perf-useful';
import { ORDERS_TOUR } from '@/lib/onboarding/tours';
import {
  ORDER_EXPORT_STATUS_TABS as TAB_FILTERS,
  ORDER_EXPORT_TAB_LABELS as TAB_LABELS,
  isOrderStatusTab,
  type OrderStatusTab as StatusTab,
} from '@/lib/orders/export';

const PAGE_SIZE = 50;

const TAB_ORDER: StatusTab[] = [
  'all_active',
  'needs_approval',
  'picking',
  'packing',
  'staged',
  'in_transit',
  'backordered',
  'completed',
  'denied_cancelled',
];

// Vocabulary lives in lib/orders/export.ts (single source for the page tabs
// and BOTH export formats); TAB_ORDER stays here — it is UI presentation
// order, not vocabulary.

/**
 * The page box every redesigned dashboard page shares (DESIGN-SPEC 4 and 5.3:
 * max 1320, 28 / 32 / 64 padding, 16 px gutters on a phone, 16 px between
 * blocks). The late skeleton this route shows while it loads draws the same
 * box (components/dashboard/skeletons.tsx), so the reveal does not jump.
 */
const PAGE_BOX =
  'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  // The service context starts beside the module gate, not after it (the same
  // change as the Books page). The list below is read through withContext,
  // which asks GoTrue for the MFA factors while the context RPC runs; started
  // only after the gate had answered, that request waited for the gate's own
  // round trip, one Supabase level more on every soft navigation to Orders
  // (lab 2026-09-22: page data complete 186 ms vs 141 ms for Items). It reads
  // no order, so the gate still decides before any order is read.
  // Request-cached; observed here because a closed gate never awaits it.
  const contextStarted = withContext();
  contextStarted.catch(() => {});
  const [moduleAccess, params] = await Promise.all([checkModuleAccess('orders'), searchParams]);
  if (!moduleAccess.enabled) {
    return <ModuleUnavailable moduleId="orders" access={moduleAccess} />;
  }
  const ctx = await requireOrgContext();
  const canApprove = can(ctx, 'orders:approve');

  const tab: StatusTab = isOrderStatusTab(params.status) ? params.status : 'needs_approval';
  const page = clampPage(params.page);
  const offset = (page - 1) * PAGE_SIZE;

  let rows: OrderRequestSummary[] = [];
  let loadFailed = false;
  try {
    const svc = await OrderRequestsService.forCurrentUser();
    if (canApprove) {
      rows = await svc.list({
        status: TAB_FILTERS[tab],
        limit: PAGE_SIZE + 1,
        offset,
      });
    } else {
      rows = await svc.myRequests();
    }
  } catch (error) {
    // Fail CLOSED: a read error must NEVER crash the whole orders page
    // (recurring bug pattern #1 — a thrown RSC read trips the dashboard
    // error boundary). Log the real error server-side (visible in Vercel
    // runtime logs, keyed near the digest) and degrade to an inline retry
    // banner so the rest of the page (tabs, export, "Place order") still works.
    console.error('[dashboard/orders] failed to load orders', {
      tab,
      page,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    loadFailed = true;
  }

  // Ordering visibility (design 8.1): Manage order items, beside Place order,
  // for whoever holds the EFFECTIVE orders:manage_catalog_visibility where the
  // Orders module and the rollout switch are on. Decided from the service
  // context the list read already resolved (request-cached: no extra round
  // trip). A context that failed offers nothing; the page still renders.
  let manageOrderItems = false;
  try {
    manageOrderItems = canManageOrderItems(await contextStarted);
  } catch {
    manageOrderItems = false;
  }

  const hasNext = canApprove && rows.length > PAGE_SIZE;
  const visible = hasNext ? rows.slice(0, PAGE_SIZE) : rows;
  const showTable = !loadFailed && visible.length > 0;

  // Newer / Older (approvers only). Under the rows it is the table card's
  // footer (DESIGN-SPEC 6.9); with no table (an empty stage, a failed read)
  // it stands on its own under the state, so a later page can still go back.
  const pager = canApprove ? <OrdersPager tab={tab} page={page} hasNext={hasNext} /> : null;

  return (
    <div className={PAGE_BOX}>
      {/* Performance marker. This page has no Suspense split: by the time any
          of it renders, the order rows above have been awaited, so the page
          itself IS the real data (its skeleton is drawn elsewhere and never
          renders this: the late skeleton on a slow navigation, the
          (dashboard) group's loading.tsx on a hard load). An empty tab is a
          finished page and counts; the "couldn't load" banner is a failure,
          not useful content, and does not. */}
      {!loadFailed && <PerfUseful />}
      <PageHeader
        title={canApprove ? 'Order requests' : 'My requests'}
        titleId="orders-title"
        subline={
          canApprove
            ? 'Review incoming requests and move them through approval, packaging, and delivery.'
            : 'Track the orders you have placed.'
        }
        tour={<PageTour tour={ORDERS_TOUR} />}
        actions={
          <>
            {/* Export the org-wide order history (CSV or PDF). Gated on
                orders:approve (manager+) — the same permission that lets this
                page show every org order; requesters without it only see
                their own requests and have nothing org-wide to export. Both
                links carry the active status tab so the file matches what's
                on screen. */}
            {canApprove ? <OrdersExportMenu tab={tab} /> : null}
            {manageOrderItems ? (
              <Button asChild variant="outline">
                <Link href="/dashboard/orders/manage-items">{ORDER_ITEMS_MANAGE_BUTTON_COPY}</Link>
              </Button>
            ) : null}
          </>
        }
        primaryAction={
          <Button asChild variant="gradient">
            <Link href="/dashboard/orders/new">+ Place order</Link>
          </Button>
        }
      />

      {/* The status tabs as the stage strip (DESIGN-SPEC 6.8, CONFLICTS R1):
          the same nine links, URLs and default, a navigation landmark named
          "Status" (the tour's target) with aria-current on the open stage.
          No figures: the app has no per-stage count here, and this page reads
          none (CONFLICTS R2 / O2). With no figure in the tile, the open
          stage's label takes the ink and weight the figure would have. */}
      {canApprove && (
        <StatStrip as="nav" variant="stages" aria-label="Status">
          {TAB_ORDER.map((t) => {
            const isActive = t === tab;
            return (
              <StatStripLink
                key={t}
                href={`/dashboard/orders?status=${t}`}
                active={isActive}
                label={
                  <span className={isActive ? 'text-foreground font-medium' : undefined}>
                    {TAB_LABELS[t]}
                  </span>
                }
              />
            );
          })}
        </StatStrip>
      )}
      {/* A filter that is not a tab (the dashboard's "waiting for signature"
          card, L88): say what the list shows, and the way back. */}
      {canApprove && !TAB_ORDER.includes(tab) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
          <span className="border-line-strong bg-sunk text-foreground inline-flex h-7 items-center whitespace-nowrap rounded-full border px-2.5 text-[12.5px] font-medium">
            {TAB_LABELS[tab]}
          </span>
          <Link
            href="/dashboard/orders?status=all_active"
            className="text-accent hover:text-foreground inline-flex items-center underline-offset-4 hover:underline max-sm:min-h-11"
          >
            Show all active orders
          </Link>
        </div>
      )}

      {loadFailed ? (
        <StatePanel
          kind="failed"
          title="We couldn't load orders"
          description="Something went wrong loading this list. This is usually temporary — try again in a moment, and switch tabs above to view other stages."
          action={
            <Button asChild variant="outline">
              <Link href={`/dashboard/orders?status=${tab}`}>Try again</Link>
            </Button>
          }
        />
      ) : !showTable ? (
        canApprove ? (
          <StatePanel
            kind="empty"
            icon={ShoppingCart}
            title={
              tab === 'awaiting_signature'
                ? 'No orders waiting for signature'
                : `Nothing in ${TAB_LABELS[tab].toLowerCase()}`
            }
            description="No requests are sitting in this stage. Switch tabs above to see other stages of the queue."
          />
        ) : (
          <StatePanel
            kind="empty"
            icon={ShoppingCart}
            title="No requests yet"
            description="Place your first order request and we'll route it to the right approver."
            action={
              <Button asChild variant="gradient">
                <Link href="/dashboard/orders/new">Place an order</Link>
              </Button>
            }
          />
        )
      ) : (
        // The table card (DESIGN-SPEC 6.9): every column kept, the table at
        // least 860 px wide (the reference's Orders minimum) and scrolling
        // sideways inside the card, never the page, when the content area is
        // narrower than its columns. At 1440 every column fits (DESIGN-SPEC
        // 8): picker and driver names wrap, the requester's floor is 8rem and
        // an exchange's state wraps beside its pill. With those on one line
        // the table needed 1320 px of the 1146 px card on All active (FX3).
        <div className="border-border bg-card overflow-hidden rounded-lg border">
          <Table scrollLabelledBy="orders-title" className="min-w-[860px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="whitespace-nowrap">Order #</TableHead>
                <TableHead>Requester</TableHead>
                <TableHead>Warehouse</TableHead>
                <TableHead className="text-right">Lines</TableHead>
                <TableHead className="whitespace-nowrap text-right">Total qty</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Picker</TableHead>
                <TableHead>Driver</TableHead>
                <TableHead>Requested</TableHead>
                <TableHead className="whitespace-nowrap text-right">Last update</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap">
                    <Link
                      href={`/dashboard/orders/${r.id}`}
                      className="text-foreground font-mono text-[13.5px] font-medium tabular-nums underline-offset-2 hover:underline"
                    >
                      {formatOrderNumber(r.orderNumber) ?? '—'}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div className="flex min-w-32 items-start gap-2">
                      <Link
                        href={`/dashboard/orders/${r.id}`}
                        className="text-foreground min-w-0 underline-offset-2 hover:underline"
                      >
                        <RequesterLabel row={r} />
                      </Link>
                      {r.source === 'public_link' && (
                        <Badge variant="outline" className="shrink-0">
                          Public
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-ink-2">{r.warehouseName ?? '—'}</TableCell>
                  <TableCell className="text-right font-mono text-[13.5px] tabular-nums">
                    {formatNumber(r.lineCount)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-[13.5px] tabular-nums">
                    {formatNumber(r.totalQuantity)}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <OrderStatusBadge status={r.status} fulfillmentType={r.fulfillmentType} />
                      {/* Returns RX-2: the Exchange chip from the order's own
                          column; the gate's words from the page's one batched
                          return_overview read (no read per row). The pill
                          holds "Exchange" and the state follows it as text
                          that may wrap, so the words still read "Exchange ·
                          Waiting for return" without one 183 px pill setting
                          the Status column's width (FX3). The separator is for
                          the text and screen readers only: the state usually
                          wraps under the pill, where a leading dot read as a
                          list bullet. */}
                      {r.replacementForReturnId ? (
                        <div
                          data-testid="order-exchange-chip"
                          className="inline-flex min-w-0 flex-wrap items-center gap-x-1"
                        >
                          <Badge variant="outline">{RETURNS_COPY.typeExchange}</Badge>
                          {r.exchange?.state ? (
                            <span className="text-muted-foreground text-[12px]">
                              <span className="sr-only">{' · '}</span>
                              {r.exchange.state}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <span className="text-ink-2 inline-flex items-center gap-1.5">
                      {r.fulfillmentType === 'pickup' ? (
                        <>
                          <Package className="text-muted-foreground size-3.5 shrink-0" />
                          Pickup
                        </>
                      ) : (
                        <>
                          <Truck className="text-muted-foreground size-3.5 shrink-0" />
                          Delivery
                        </>
                      )}
                    </span>
                  </TableCell>
                  {/* Picker and driver names wrap (FX3). */}
                  <TableCell>
                    <PersonName name={r.assignedPickerName} />
                  </TableCell>
                  <TableCell>
                    <PersonName
                      name={r.fulfillmentType === 'delivery' ? r.assignedDeliveryUserName : null}
                    />
                  </TableCell>
                  <TableCell className="text-muted-foreground whitespace-nowrap text-[12.5px]">
                    {formatRelative(r.createdAt)}
                  </TableCell>
                  <TableCell className="text-muted-foreground whitespace-nowrap text-right text-[12.5px]">
                    {formatRelative(r.updatedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {pager ? <div className="border-border border-t px-4 py-2.5">{pager}</div> : null}
        </div>
      )}
      {!showTable && pager}
    </div>
  );
}

/**
 * The requester as the reference draws it (DESIGN-SPEC 7.6): the name, then
 * the requester's organisation on a quieter 12 px line. The words are
 * summaryRequesterLabel's own, so the row link's text and name stay exactly
 * the label ("Pat Lee · Ridge PTA"): the separator is kept for screen readers
 * and copying, and only the line break is visual. Any other label (an email,
 * "Team member", a deleted or external requester) is one line, as before.
 */
function RequesterLabel({ row }: { row: OrderRequestSummary }) {
  const label = summaryRequesterLabel(row);
  const name = row.requesterName;
  const org = row.requesterOrgLabel;
  if (!name || !org || label !== `${name} · ${org}`) return <>{label}</>;
  return (
    <>
      <span className="block">{name}</span>
      <span className="sr-only"> · </span>
      <span className="text-muted-foreground block text-[12px] leading-[18px]">{org}</span>
    </>
  );
}

/** A picker or driver: the name in the secondary ink, "—" quiet when unset. */
function PersonName({ name }: { name: string | null }) {
  return name ? (
    <span className="text-ink-2">{name}</span>
  ) : (
    <span className="text-muted-foreground">—</span>
  );
}

/**
 * The disabled pager control, quiet rather than faded (the shared pager's
 * recipe, components/ui/pagination.tsx): the plain hairline, no fill and the
 * glyph ink. It is a real disabled button, so it is out of the Tab order;
 * it used to be a link to "#" that a keyboard could still follow.
 */
const PAGER_DISABLED =
  'disabled:opacity-100 disabled:border-border disabled:bg-transparent disabled:text-ink-4';

/**
 * Newer / Older for the approvers' queue: 50 orders per page, "Older" only
 * when the read found a 51st. Same words and URLs as before; the controls
 * take the pager recipe (DESIGN-SPEC 6.2: 28 px secondary buttons, "Page N"
 * between them).
 */
function OrdersPager({ tab, page, hasNext }: { tab: StatusTab; page: number; hasNext: boolean }) {
  return (
    <div className="text-muted-foreground flex items-center justify-end gap-2 text-[12.5px]">
      <PagerControl href={page <= 1 ? null : `/dashboard/orders?status=${tab}&page=${page - 1}`}>
        ← Newer
      </PagerControl>
      <p className="px-2 tabular-nums">Page {page}</p>
      <PagerControl href={hasNext ? `/dashboard/orders?status=${tab}&page=${page + 1}` : null}>
        Older →
      </PagerControl>
    </div>
  );
}

function PagerControl({ href, children }: { href: string | null; children: ReactNode }) {
  if (href === null) {
    return (
      <Button variant="outline" size="sm" disabled className={PAGER_DISABLED}>
        {children}
      </Button>
    );
  }
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={href}>{children}</Link>
    </Button>
  );
}

function clampPage(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(Math.max(Math.floor(n), 1), 10_000);
}
