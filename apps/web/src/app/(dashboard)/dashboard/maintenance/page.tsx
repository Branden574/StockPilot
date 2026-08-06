import { Wrench } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { MaintenanceSearch } from '@/components/maintenance/maintenance-search';
import { MaintenanceStatusBadge } from '@/components/maintenance/maintenance-status-badge';
import { PageTour } from '@/components/onboarding/page-tour';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
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

/** Builds a `/dashboard/maintenance` URL preserving the list page's query
 *  contract (`scope`/`status`/`q`, plus an additive `page`) — the same
 *  four params every filter pill, the search box, and the pager write. */
function buildMaintenanceHref(params: {
  scope: 'mine' | 'all';
  status?: MaintenanceStatus | 'active';
  q?: string;
  page?: number;
}): string {
  const usp = new URLSearchParams();
  if (params.scope === 'all') usp.set('scope', 'all');
  if (params.status) usp.set('status', params.status);
  if (params.q) usp.set('q', params.q);
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

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {scope === 'all' ? 'All maintenance requests' : 'My maintenance requests'}
          </h1>
          {/* Verbatim, brief section 22 — the list must never imply it
              reflects current Zendesk/Outlook ticket status. Kept on one
              source line deliberately: the test suite literal-pins this
              exact sentence and JSX text spanning multiple lines is a
              needless risk against that pin. */}
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
            Ticket updates and replies are handled through the Outlook/Zendesk email conversation and are not synchronized into StockPilot.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PageTour tour={MAINTENANCE_REQUESTS_TOUR} />
          {canSubmit && (
            <Button asChild variant="gradient">
              <Link href="/dashboard/maintenance/new">New maintenance request</Link>
            </Button>
          )}
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap items-center gap-2 text-sm" aria-label="Filter maintenance requests">
          <Link
            href={buildMaintenanceHref({ scope: 'mine', status, q })}
            aria-current={scope === 'mine' ? 'page' : undefined}
            className={
              scope === 'mine' ? 'font-medium underline' : 'text-muted-foreground hover:text-foreground'
            }
          >
            My requests
          </Link>
          {canReadAll && (
            <Link
              href={buildMaintenanceHref({ scope: 'all', status, q })}
              aria-current={scope === 'all' ? 'page' : undefined}
              className={
                scope === 'all' ? 'font-medium underline' : 'text-muted-foreground hover:text-foreground'
              }
            >
              All requests
            </Link>
          )}
          <span className="text-muted-foreground/50" aria-hidden="true">
            ·
          </span>
          <Link
            href={buildMaintenanceHref({ scope, q })}
            aria-current={!status ? 'page' : undefined}
            className={!status ? 'font-medium underline' : 'text-muted-foreground hover:text-foreground'}
          >
            All statuses
          </Link>
          {STATUS_FILTERS.map((f) => (
            <Link
              key={f.value}
              href={buildMaintenanceHref({ scope, status: f.value, q })}
              aria-current={status === f.value ? 'page' : undefined}
              className={
                status === f.value ? 'font-medium underline' : 'text-muted-foreground hover:text-foreground'
              }
            >
              {f.label}
            </Link>
          ))}
        </nav>

        {/* Search is a read_all/manage affordance only (brief section 22:
            filtering + search belong to the "All maintenance requests"
            view — the plain "My requests" list has no search box). The
            placeholder names exactly what MaintenanceRequestsService.list()
            searches (subject/description/requester + request number) —
            never claims site/SKU/order-number matching the service does
            not implement. */}
        {scope === 'all' && (
          <MaintenanceSearch key={`${scope}:${status ?? ''}:${q}`} scope={scope} status={status} initialQuery={q} />
        )}
      </div>

      <div className="mt-4">
        {visible.length === 0 ? (
          hasActiveFilters ? (
            <EmptyState
              icon={Wrench}
              title="No matches"
              description="Nothing found for the current filters. Try a different search or status, or clear filters."
              cta={{ label: 'Clear filters', href: buildMaintenanceHref({ scope }) }}
            />
          ) : page > 1 ? (
            <EmptyState
              icon={Wrench}
              title="Nothing on this page"
              description="You've paged past the end of the list."
              cta={{ label: 'Back to page 1', href: buildMaintenanceHref({ scope }) }}
            />
          ) : (
            <EmptyState
              icon={Wrench}
              title="No maintenance requests"
              description="Report a facilities or equipment issue and StockPilot will prepare the email for you."
              cta={
                canSubmit
                  ? { label: 'Create your first maintenance request', href: '/dashboard/maintenance/new' }
                  : undefined
              }
            />
          )
        ) : (
          <div className="bg-card overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
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
                    <TableCell>
                      <Link
                        className="font-medium underline-offset-2 hover:underline"
                        href={`/dashboard/maintenance/${r.id}`}
                      >
                        {formatMaintenanceRequestNumber(r.requestNumber, r.createdAt) ?? r.requestNumber}
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-[28ch] truncate">{r.subject}</TableCell>
                    <TableCell>
                      <MaintenanceStatusBadge status={r.status} />
                    </TableCell>
                    <TableCell className="capitalize">{r.priority}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">{r.siteName ?? '—'}</TableCell>
                    {scope === 'all' ? (
                      <TableCell className="text-sm">{r.requesterName}</TableCell>
                    ) : null}
                    <TableCell className="text-right tabular-nums">{r.photoCount || '—'}</TableCell>
                    <TableCell className="text-muted-foreground text-right text-xs">
                      {formatRelative(r.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {visible.length > 0 && (
          <div className="mt-4 flex items-center justify-end">
            <Pagination
              page={page}
              hasNext={hasNext}
              hrefForPage={(n) => buildMaintenanceHref({ scope, status, q, page: n })}
            />
          </div>
        )}
      </div>
    </div>
  );
}
