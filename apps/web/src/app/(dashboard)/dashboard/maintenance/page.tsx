import { Wrench } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { MaintenanceSearch } from '@/components/maintenance/maintenance-search';
import { MaintenanceStatusBadge } from '@/components/maintenance/maintenance-status-badge';
import { PageTour } from '@/components/onboarding/page-tour';
import { PageHeader } from '@/components/patterns/page-header';
import { SegmentedTabs } from '@/components/patterns/segmented-tabs';
import { StatePanel } from '@/components/patterns/state-panel';
import { StatStrip, StatStripLink } from '@/components/patterns/stat-strip';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/pagination';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { MAINTENANCE_REQUESTS_TOUR } from '@/lib/onboarding/tours';
import { formatRelative } from '@/lib/utils';
import { withContext } from '@/server/services/context';
import { MaintenanceRequestsService } from '@/server/services/maintenance-requests';

import { can, formatMaintenanceRequestNumber, MAINTENANCE_STATUS_LABELS, type MaintenanceStatus } from '@stockpilot/core';

export const dynamic = 'force-dynamic';

/**
 * Rows per page. `MaintenanceRequestsService.list()` supports `limit`/
 * `offset` (default 50, max 100 — server/services/maintenance-requests.ts)
 * but has no `count()` sibling, so pagination here follows the
 * movements/purchase-orders "fetch one extra row" idiom (see hasNext below)
 * instead of a numbered "Page N of M" pager backed by a COUNT query.
 */
const PAGE_SIZE = 25;

/**
 * The page box every redesigned dashboard page shares (DESIGN-SPEC 4 and 5.3:
 * max 1320, 28 / 32 / 64 padding, 16 px gutters on a phone, 16 px between
 * blocks), the same box as the Orders list this page follows.
 */
const PAGE_BOX =
  'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

const STATUS_FILTERS: Array<{ value: MaintenanceStatus | 'active'; label: string }> = [
  // 'active' is a synthetic filter (saved + draft_opened) with no matching
  // database status value — the only legitimate hand-typed label exception.
  { value: 'active', label: 'Active' },
  // All other labels derive from MAINTENANCE_STATUS_LABELS to prevent drift
  // (brief section 20 — the sole source of truth for status vocabulary).
  ...(Object.entries(MAINTENANCE_STATUS_LABELS).map(([status, label]) => ({
    value: status as MaintenanceStatus,
    label,
  })) as Array<{ value: MaintenanceStatus; label: string }>),
];
const VALID_STATUSES = STATUS_FILTERS.map((f) => f.value);

function clampPage(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(Math.max(Math.floor(n), 1), 10_000);
}

/** The list page's query contract (`scope`/`status`/`q`) as a plain params
 *  record — the ONE definition both the filter-pill hrefs and the pager's
 *  serializable `baseParams` prop derive from, so they cannot drift. */
function maintenanceListParams(params: {
  scope: 'mine' | 'all';
  status?: MaintenanceStatus | 'active';
  q?: string;
}): Record<string, string> {
  const p: Record<string, string> = {};
  if (params.scope === 'all') p.scope = 'all';
  if (params.status) p.status = params.status;
  if (params.q) p.q = params.q;
  return p;
}

/** Builds a `/dashboard/maintenance` URL preserving the list page's query
 *  contract (`scope`/`status`/`q`, plus an additive `page`) — the same
 *  four params every filter pill, the search box, and the pager write. */
function buildMaintenanceHref(params: {
  scope: 'mine' | 'all';
  status?: MaintenanceStatus | 'active';
  q?: string;
  page?: number;
}): string {
  const usp = new URLSearchParams(maintenanceListParams(params));
  if (params.page && params.page > 1) usp.set('page', String(params.page));
  const qs = usp.toString();
  return qs ? `/dashboard/maintenance?${qs}` : '/dashboard/maintenance';
}

export default async function MaintenancePage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string; status?: string; q?: string; page?: string }>;
}) {
  const access = await checkModuleAccess('maintenance_requests');
  if (!access.enabled) return <ModuleNotEnabled moduleId="maintenance_requests" canManage={access.canManage} />;

  // withContext() resolves requireOrgContext() internally (React-cached, so
  // this costs no extra round trip beyond checkModuleAccess's own call) and
  // is the shape MaintenanceRequestsService needs (ctx.supabase). `can` comes
  // from @stockpilot/core directly — server/services/context.ts does not
  // re-export it (confirmed against every sibling module page: zendesk,
  // customers, product-groups).
  const ctx = await withContext();
  const canSubmit = can(ctx, 'maintenance_requests:submit');
  const canReadAll = can(ctx, 'maintenance_requests:read_all') || can(ctx, 'maintenance_requests:manage');
  if (!canSubmit && !canReadAll) {
    redirect('/dashboard');
  }

  const sp = await searchParams;
  // Server decides the scope, not the URL: a plain-submit member requesting
  // ?scope=all still gets 'mine' — matches list()'s own read_all check
  // (which would otherwise throw a 'forbidden' ServiceError for this exact
  // caller), and keeps this the ONE place the permission boundary is drawn.
  const scope: 'mine' | 'all' = sp.scope === 'all' && canReadAll ? 'all' : 'mine';
  const status = VALID_STATUSES.find((s) => s === sp.status);
  const q = (sp.q ?? '').trim();
  const page = clampPage(sp.page);
  const offset = (page - 1) * PAGE_SIZE;

  const svc = new MaintenanceRequestsService(ctx);
  // Search restriction: only pass q to the service if the caller may use it
  // (read_all/manage holders only — brief section 22).
  const rows = await svc.list({
    scope,
    q: canReadAll ? (q || undefined) : undefined,
    status,
    limit: PAGE_SIZE + 1,
    offset,
  });
  const hasNext = rows.length > PAGE_SIZE;
  const visible = hasNext ? rows.slice(0, PAGE_SIZE) : rows;
  const hasActiveFilters = Boolean(q || status);

  const statusTiles: Array<{ id: string; label: string; status?: MaintenanceStatus | 'active' }> = [
    { id: 'all', label: 'All statuses' },
    ...STATUS_FILTERS.map((f) => ({ id: f.value, label: f.label, status: f.value })),
  ];

  return (
    <div className={PAGE_BOX}>
      <PageHeader
        title={scope === 'all' ? 'All maintenance requests' : 'My maintenance requests'}
        subline={
          // Verbatim, brief section 22 — the list must never imply it
          // reflects current Zendesk/Outlook ticket status. Kept on one
          // source line deliberately: the test suite literal-pins this exact
          // sentence and JSX text spanning multiple lines is a needless risk
          // against that pin.
          <span className="block max-w-2xl">
            Ticket updates and replies are handled through the Outlook/Zendesk email conversation and are not synchronized into StockPilot.
          </span>
        }
        tour={<PageTour tour={MAINTENANCE_REQUESTS_TOUR} />}
        primaryAction={
          canSubmit ? (
            <Button asChild variant="gradient">
              <Link href="/dashboard/maintenance/new">New maintenance request</Link>
            </Button>
          ) : null
        }
      />

      {/* One navigation landmark holds every filter link, as before: the
          scope switch (drawn as the segmented view tabs, DESIGN-SPEC 6.5)
          and the status links (drawn as the Orders stage strip, 6.8). Every
          link keeps its URL (scope, status and q carried over) and
          aria-current on the open one. The tiles carry no figures: the list
          service has no count, and this page reads none (owner decision
          O2). With no figure in a tile, the open stage's label takes the ink
          and weight the figure would have. */}
      <nav aria-label="Filter maintenance requests" className="flex min-w-0 flex-col gap-3">
        <SegmentedTabs
          semantics="nav"
          aria-label="Request scope"
          activeId={scope}
          items={[
            {
              id: 'mine',
              label: 'My requests',
              href: buildMaintenanceHref({ scope: 'mine', status, q }),
            },
            ...(canReadAll
              ? [
                  {
                    id: 'all',
                    label: 'All requests',
                    href: buildMaintenanceHref({ scope: 'all', status, q }),
                  },
                ]
              : []),
          ]}
        />
        <StatStrip variant="stages">
          {statusTiles.map((t) => {
            const isActive = t.status === status;
            return (
              <StatStripLink
                key={t.id}
                href={buildMaintenanceHref({ scope, status: t.status, q })}
                active={isActive}
                label={
                  <span className={isActive ? 'text-foreground font-medium' : undefined}>
                    {t.label}
                  </span>
                }
              />
            );
          })}
        </StatStrip>
      </nav>

      {/* Search is a read_all/manage affordance only (brief section 22:
          filtering + search belong to the "All maintenance requests" view —
          the plain "My requests" list has no search box). The placeholder
          names exactly what MaintenanceRequestsService.list() searches
          (subject/description/requester + request number) — never claims
          site/SKU/order-number matching the service does not implement. */}
      {scope === 'all' && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <MaintenanceSearch key={`${scope}:${status ?? ''}:${q}`} scope={scope} status={status} initialQuery={q} />
        </div>
      )}

      {visible.length === 0 ? (
        hasActiveFilters ? (
          <StatePanel
            kind="no-match"
            icon={Wrench}
            title="No matches"
            description="Nothing found for the current filters. Try a different search or status, or clear filters."
            action={
              <Button asChild variant="outline">
                <Link href={buildMaintenanceHref({ scope })}>Clear filters</Link>
              </Button>
            }
          />
        ) : page > 1 ? (
          <StatePanel
            kind="empty"
            icon={Wrench}
            title="Nothing on this page"
            description="You've paged past the end of the list."
            action={
              <Button asChild variant="outline">
                <Link href={buildMaintenanceHref({ scope })}>Back to page 1</Link>
              </Button>
            }
          />
        ) : (
          <StatePanel
            kind="empty"
            icon={Wrench}
            title="No maintenance requests"
            description="Report a facilities or equipment issue and StockPilot will prepare the email for you."
            action={
              canSubmit ? (
                <Button asChild variant="gradient">
                  <Link href="/dashboard/maintenance/new">
                    Create your first maintenance request
                  </Link>
                </Button>
              ) : undefined
            }
          />
        )
      ) : (
        // The table card (DESIGN-SPEC 6.9): every column kept, at least
        // 760 px wide and scrolling sideways inside the card, never the page,
        // when the content area is narrower. It stays a real table: the tour
        // spotlights its first body row (`table tbody tr`).
        <div className="border-border bg-card overflow-hidden rounded-lg border">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Request</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Site</TableHead>
                {scope === 'all' ? <TableHead>Requester</TableHead> : null}
                <TableHead className="text-right">Photos</TableHead>
                <TableHead className="text-right">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap">
                    <Link
                      className="text-foreground font-mono text-[13px] font-medium tabular-nums underline-offset-2 hover:underline"
                      href={`/dashboard/maintenance/${r.id}`}
                    >
                      {formatMaintenanceRequestNumber(r.requestNumber, r.createdAt) ??
                        r.requestNumber}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-[28ch] truncate">{r.subject}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    <MaintenanceStatusBadge status={r.status} />
                  </TableCell>
                  <TableCell className="text-ink-2 capitalize">{r.priority}</TableCell>
                  <TableCell className="text-ink-2">{r.siteName ?? '—'}</TableCell>
                  {scope === 'all' ? (
                    <TableCell className="text-ink-2">{r.requesterName}</TableCell>
                  ) : null}
                  <TableCell className="text-right font-mono text-[13px] tabular-nums">
                    {r.photoCount || '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground whitespace-nowrap text-right text-[12.5px]">
                    {formatRelative(r.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {/* The pager is the table card's footer (DESIGN-SPEC 6.9).
              SERIALIZABLE props only: this is a server component rendering a
              'use client' pager, and a function prop (hrefForPage) crashes
              any non-empty list at runtime — RSC refuses to serialize
              functions (digest 3969804129; 2026-08-05 walk, BUG 1). The
              pager rebuilds buildMaintenanceHref's exact URL shape from
              basePath + baseParams (page param appended, omitted on page 1). */}
          <div className="border-border flex justify-end border-t px-4 py-2.5">
            <Pagination
              page={page}
              hasNext={hasNext}
              basePath="/dashboard/maintenance"
              baseParams={maintenanceListParams({ scope, status, q })}
            />
          </div>
        </div>
      )}
    </div>
  );
}
