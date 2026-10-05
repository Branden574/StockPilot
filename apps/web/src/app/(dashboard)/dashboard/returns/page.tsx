import { Undo2 } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { ReturnStatusBadge } from '@/components/returns/return-status-badge';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { requireOrgContext } from '@/lib/auth/session';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { formatRelative } from '@/lib/utils';
import { RMAService } from '@/server/services/returns';

import {
  availableReturnListFilters,
  can,
  formatOrderNumber,
  parseReturnListFilter,
  RETURN_WAITING_PROMPT_DAYS,
  RETURNS_COPY,
  type ReturnListFilterId,
} from '@stockpilot/core';

/**
 * The returns list (returns RX-1, plan 3.10 and graft G5): the filters RX-1
 * offers (All, Awaiting approval, Waiting for returned item, Received, not
 * processed, Closed), a search over the RMA number, SO number and requester,
 * and keyset pages of 25. Three round trips per page whatever its size: the
 * `return_overview` page, the items of the shown lines in chunks of 100, one
 * signing call for the thumbnails. No per-row request.
 *
 * Visibility follows returns:read (or manage); the lifecycle actions live on
 * the workbench and in the database functions.
 */
export default async function ReturnsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; q?: string; cursor?: string }>;
}) {
  const moduleAccess = await checkModuleAccess('returns');
  if (!moduleAccess.enabled) {
    return <ModuleNotEnabled moduleId="returns" canManage={moduleAccess.canManage} />;
  }
  const ctx = await requireOrgContext();
  if (!can(ctx, 'returns:read') && !can(ctx, 'returns:manage')) {
    redirect('/dashboard');
  }

  const sp = await searchParams;
  const filter = parseReturnListFilter(sp.filter);
  const svc = await RMAService.forCurrentUser();
  const page = await svc.listPage({ filter, q: sp.q ?? null, cursor: sp.cursor ?? null });
  const filters = availableReturnListFilters({ exchanges: false });

  const hrefFor = (next: { filter?: ReturnListFilterId; cursor?: string | null }) => {
    const params = new URLSearchParams();
    const f = next.filter ?? filter;
    if (f !== 'all') params.set('filter', f);
    if (page.q) params.set('q', page.q);
    if (next.cursor) params.set('cursor', next.cursor);
    const qs = params.toString();
    return qs ? `/dashboard/returns?${qs}` : '/dashboard/returns';
  };

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Returns</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            RMAs against handed-over orders. Approving moves nothing; processing a received return puts the
            item back on the rack it was picked from, into Staging, or scraps it.
          </p>
        </div>
        <form action="/dashboard/returns" method="get" className="w-full sm:w-72" role="search">
          {filter !== 'all' ? <input type="hidden" name="filter" value={filter} /> : null}
          <Input
            type="search"
            name="q"
            defaultValue={page.q}
            placeholder={RETURNS_COPY.listSearchPlaceholder}
            aria-label={RETURNS_COPY.listSearchPlaceholder}
          />
        </form>
      </div>

      <nav className="mt-6 flex flex-wrap gap-2" aria-label="Return filters">
        {filters.map((f) => {
          const isActive = filter === f.id;
          return (
            <Link
              key={f.id}
              href={hrefFor({ filter: f.id, cursor: null })}
              aria-current={isActive ? 'page' : undefined}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                isActive
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              {f.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-6">
        {page.rows.length === 0 ? (
          <EmptyState
            icon={Undo2}
            title={page.q || filter !== 'all' || sp.cursor ? RETURNS_COPY.listEmpty : 'No returns yet'}
            description="Open a handed-over order and create a return. Returns requested from a return link or the customer portal show up here too."
          />
        ) : (
          <div className="bg-card overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>RMA</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Requester</TableHead>
                  <TableHead>Returning</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link href={`/dashboard/returns/${r.id}`} className="font-mono text-xs font-medium hover:underline">
                        {r.returnNumber ?? r.id.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link href={`/dashboard/orders/${r.orderRequestId}`} className="text-muted-foreground text-xs hover:underline">
                        {formatOrderNumber(r.orderNumber) ?? r.orderRequestId.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{RETURNS_COPY.typeReturn}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {r.requesterName ?? r.requesterEmail ?? (
                        <span className="text-muted-foreground">{r.source === 'requester' ? 'Requester' : 'Staff'}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {r.items.map((it) => (
                          <span key={it.itemId} className="flex min-w-0 items-center gap-1.5">
                            <span className="bg-muted block h-8 w-8 shrink-0 overflow-hidden rounded">
                              {it.thumbUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element -- signed thumbnail URL
                                <img src={it.thumbUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                              ) : null}
                            </span>
                            <span className="max-w-[10rem] truncate text-xs">
                              {it.name ?? 'Item'}
                              {it.variant ? <span className="text-muted-foreground"> · {it.variant}</span> : null}
                              <span className="text-muted-foreground"> ×{it.quantity}</span>
                            </span>
                          </span>
                        ))}
                        {r.moreItems > 0 ? (
                          <span className="text-muted-foreground text-xs">{RETURNS_COPY.moreItems(r.moreItems)}</span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <ReturnStatusBadge status={r.status as never} />
                        {r.status === 'approved' && r.waitingDays !== null ? (
                          <span
                            className={`text-xs ${r.waitingDays >= RETURN_WAITING_PROMPT_DAYS ? 'text-warning font-medium' : 'text-muted-foreground'}`}
                          >
                            {RETURNS_COPY.waitingDays(r.waitingDays)}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right text-xs">{formatRelative(r.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <nav className="mt-4 flex items-center justify-between gap-2 text-sm" aria-label="Pages">
        {sp.cursor ? (
          <Link href={hrefFor({ cursor: null })} className="text-muted-foreground hover:text-foreground">
            ← First page
          </Link>
        ) : (
          <span />
        )}
        {page.nextCursor ? (
          <Link href={hrefFor({ cursor: page.nextCursor })} className="font-medium hover:underline">
            Next {page.pageSize} →
          </Link>
        ) : null}
      </nav>
    </div>
  );
}
