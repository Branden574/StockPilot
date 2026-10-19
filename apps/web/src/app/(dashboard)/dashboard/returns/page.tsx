import { Search, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { FilterChipLink } from '@/components/patterns/chip';
import { FilterBar } from '@/components/patterns/filter-bar';
import { PageHeader } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
import { Thumb } from '@/components/patterns/thumb';
import { ReturnStatusBadge } from '@/components/returns/return-status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { cn, formatRelative } from '@/lib/utils';
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
 * The page box every redesigned dashboard page shares (DESIGN-SPEC 4 and 5.3:
 * max 1320, 28 / 32 / 64 padding, 16 px gutters on a phone, 16 px between
 * blocks), the same box as the Orders list.
 */
const PAGE_BOX =
  'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

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
 *
 * Redesign (P4.B3): the shared page header, the nine filters as filter chips
 * beside the search in one wrapping row, and the table drawn as the Orders
 * and Movements tables are (a card that scrolls sideways inside itself, the
 * pager in its footer). Every filter, URL, word and gate is the same.
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
  // RX-2: the exchange filters (returns only, exchanges, replacement
  // unavailable, replacement ready) are on.
  const filter = parseReturnListFilter(sp.filter, { exchanges: true });
  const svc = await RMAService.forCurrentUser();
  const page = await svc.listPage({ filter, q: sp.q ?? null, cursor: sp.cursor ?? null });
  const filters = availableReturnListFilters({ exchanges: true });

  const hrefFor = (next: { filter?: ReturnListFilterId; cursor?: string | null }) => {
    const params = new URLSearchParams();
    const f = next.filter ?? filter;
    if (f !== 'all') params.set('filter', f);
    if (page.q) params.set('q', page.q);
    if (next.cursor) params.set('cursor', next.cursor);
    const qs = params.toString();
    return qs ? `/dashboard/returns?${qs}` : '/dashboard/returns';
  };

  const filtered = Boolean(page.q || filter !== 'all' || sp.cursor);
  const showTable = page.rows.length > 0;
  // The pager is always there, as before; under rows that it pages it is the
  // table card's footer (DESIGN-SPEC 6.9), otherwise it stands under the state.
  const hasPages = Boolean(sp.cursor || page.nextCursor);
  const pager = (
    <ReturnsPager
      first={sp.cursor ? hrefFor({ cursor: null }) : null}
      next={page.nextCursor ? hrefFor({ cursor: page.nextCursor }) : null}
      pageSize={page.pageSize}
    />
  );

  return (
    <div className={PAGE_BOX}>
      <PageHeader
        title="Returns"
        subline={
          <p className="max-w-3xl">
            RMAs against handed-over orders. Approving moves nothing; processing a received return
            puts the item back on the rack it was picked from, into Staging, or scraps it.
          </p>
        }
      />

      {/* The nine filters as filter chips (DESIGN-SPEC 6.6, the Movements
          type chips) and the search beside them: one row that wraps. The
          chips stay links in a navigation landmark named "Return filters"
          with aria-current on the open one; the search is the same GET form,
          so it works without script and keeps the open filter. */}
      <FilterBar
        leading={
          <nav className="flex min-w-0 flex-wrap gap-2" aria-label="Return filters">
            {filters.map((f) => {
              const isActive = filter === f.id;
              return (
                <FilterChipLink
                  key={f.id}
                  href={hrefFor({ filter: f.id, cursor: null })}
                  aria-current={isActive ? 'page' : undefined}
                  active={isActive}
                  size="md"
                >
                  {f.label}
                </FilterChipLink>
              );
            })}
          </nav>
        }
      >
        <form
          action="/dashboard/returns"
          method="get"
          className="relative w-full sm:w-72"
          role="search"
        >
          {filter !== 'all' ? <input type="hidden" name="filter" value={filter} /> : null}
          <Search
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
          />
          <Input
            type="search"
            name="q"
            defaultValue={page.q}
            placeholder={RETURNS_COPY.listSearchPlaceholder}
            aria-label={RETURNS_COPY.listSearchPlaceholder}
            className="pl-8"
          />
        </form>
      </FilterBar>

      {!showTable ? (
        <StatePanel
          kind={filtered ? 'no-match' : 'empty'}
          icon={Undo2}
          title={filtered ? RETURNS_COPY.listEmpty : 'No returns yet'}
          description={
            <p>
              Open a handed-over order and create a return. Returns requested from a return link or
              the customer portal show up here too.
            </p>
          }
        />
      ) : (
        // The table card (DESIGN-SPEC 6.9): every column kept, the table at
        // least 860 px wide (the reference's Orders and Movements minimum)
        // and scrolling sideways inside the card, never the page.
        <div className="border-border bg-card overflow-hidden rounded-lg border">
          <Table className="min-w-[860px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
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
                  <TableCell className="whitespace-nowrap">
                    <Link
                      href={`/dashboard/returns/${r.id}`}
                      className="text-foreground font-mono text-[13px] font-medium tabular-nums underline-offset-2 hover:underline"
                    >
                      {r.returnNumber ?? r.id.slice(0, 8)}
                    </Link>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <Link
                      href={`/dashboard/orders/${r.orderRequestId}`}
                      className="text-ink-2 font-mono text-[12.5px] tabular-nums underline-offset-2 hover:underline"
                    >
                      {formatOrderNumber(r.orderNumber) ?? r.orderRequestId.slice(0, 8)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <Badge variant="outline">
                        {r.type === 'exchange'
                          ? RETURNS_COPY.typeExchange
                          : RETURNS_COPY.typeReturn}
                      </Badge>
                      {r.type === 'exchange' && r.exchangeStatusLabel ? (
                        <span
                          className="text-muted-foreground max-w-[14rem] text-[12px] leading-[18px]"
                          data-testid="return-row-exchange-status"
                        >
                          {r.exchangeStatusLabel}
                          {r.replacementOrderNumber
                            ? ` · ${formatOrderNumber(r.replacementOrderNumber)}`
                            : ''}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    {r.requesterName ?? r.requesterEmail ?? (
                      <span className="text-muted-foreground">
                        {r.source === 'requester' ? 'Requester' : 'Staff'}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      {r.items.map((it) => (
                        <span key={it.itemId} className="flex min-w-0 items-center gap-2">
                          {/* The signed ~200 px thumbnail in the 32 px frame,
                              the hatch when there is none (DESIGN-SPEC 6.14). */}
                          <Thumb size={32} src={it.thumbUrl} alt="" />
                          <span className="max-w-[10rem] truncate text-[12.5px]">
                            {it.name ?? 'Item'}
                            {it.variant ? (
                              <span className="text-muted-foreground"> · {it.variant}</span>
                            ) : null}
                            <span className="text-muted-foreground tabular-nums">
                              {' '}
                              ×{it.quantity}
                            </span>
                          </span>
                        </span>
                      ))}
                      {r.moreItems > 0 ? (
                        <span className="text-muted-foreground text-[12px]">
                          {RETURNS_COPY.moreItems(r.moreItems)}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <ReturnStatusBadge status={r.status as never} />
                      {r.status === 'approved' && r.waitingDays !== null ? (
                        <span
                          className={cn(
                            'whitespace-nowrap text-[12px]',
                            r.waitingDays >= RETURN_WAITING_PROMPT_DAYS
                              ? 'text-warning font-medium'
                              : 'text-muted-foreground',
                          )}
                        >
                          {RETURNS_COPY.waitingDays(r.waitingDays)}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground whitespace-nowrap text-right text-[12.5px]">
                    {formatRelative(r.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {hasPages ? <div className="border-border border-t px-4 py-2.5">{pager}</div> : null}
        </div>
      )}
      {showTable && hasPages ? null : pager}
    </div>
  );
}

/**
 * "← First page" (when on a cursor) and "Next 25 →" (when the read found more):
 * the same words and keyset URLs as before, as the pager recipe (DESIGN-SPEC
 * 6.2: 28 px secondary buttons). "First page" sits on the left, "Next" on the
 * right, as they always have.
 */
function ReturnsPager({
  first,
  next,
  pageSize,
}: {
  first: string | null;
  next: string | null;
  pageSize: number;
}) {
  return (
    <nav className="flex items-center justify-between gap-2 text-[12.5px]" aria-label="Pages">
      {first ? <PagerLink href={first}>← First page</PagerLink> : <span />}
      {next ? <PagerLink href={next}>Next {pageSize} →</PagerLink> : null}
    </nav>
  );
}

function PagerLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={href}>{children}</Link>
    </Button>
  );
}
