import { ArrowLeftRight, Download } from 'lucide-react';
import { redirect } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { MovementsFilterBar } from '@/components/movements/movements-filter-bar';
import {
  MovementsInstantTable,
  type MovementDisplayRow,
} from '@/components/movements/movements-instant-table';
import { Pagination } from '@/components/ui/pagination';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { requireOrgContext } from '@/lib/auth/session';
import {
  buildMovementsQueryString,
  parseFromDateParam,
  parseMovementTypeParam,
  parseToDateParam,
} from '@/lib/movements-filters';
import { MovementsService } from '@/server/services/movements';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';
import { LocalDateTime } from '@/components/ui/local-datetime';
import { formatNumber, formatRelative } from '@/lib/utils';

import { can } from '@stockpilot/core';

const PAGE_SIZE = 50;

/**
 * Instant-search threshold. At or below this many movements (warehouse-scoped),
 * the whole ledger loads and search + paging run client-side (zero-latency,
 * matching Items/Books). Above it, server-side search + numbered pages hold —
 * the ledger can reach millions of rows and must not all cross the wire.
 */
const MOVEMENTS_INSTANT_CAP = 1000;

export default async function MovementsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string; type?: string; from?: string; to?: string }>;
}) {
  // Movements is the org-wide stock_movements ledger — viewer doesn't
  // have activity_logs:read, so they get bounced back to the dashboard
  // if they type the URL. Sidebar already hides this entry for them.
  const ctx = await requireOrgContext();
  if (!can(ctx, 'activity_logs:read')) {
    redirect('/dashboard');
  }

  const params = await searchParams;
  const page = clampPage(params.page);
  const offset = (page - 1) * PAGE_SIZE;
  const search = (params.q ?? '').trim();
  // Garbage type/date params are dropped (undefined) rather than thrown —
  // see lib/movements-filters. `rawType`/`rawFrom`/`rawTo` keep only the
  // values that actually parsed, so a mangled param never round-trips into
  // the filter bar or the export link.
  const typeFilter = parseMovementTypeParam(params.type);
  const since = parseFromDateParam(params.from);
  const until = parseToDateParam(params.to);
  const rawType = typeFilter ?? '';
  const rawFrom = since ? (params.from ?? '') : '';
  const rawTo = until ? (params.to ?? '') : '';
  // Any of the four filter dimensions actually parsed to something active.
  // Drives whether a zero result should read as "ledger's empty" vs "no
  // match for these filters" — see the empty-state branching below.
  const hasActiveFilters = Boolean(search || typeFilter || since || until);

  const [movementsSvc, warehouseFilter] = await Promise.all([
    MovementsService.forCurrentUser(),
    getActiveWarehouseFilter(),
  ]);
  const warehouseId = warehouseFilter ?? undefined;

  // Instant mode: when the whole warehouse-scoped ledger fits under the cap,
  // load it all and let the client filter + page with zero latency (like
  // Items/Books). Decided on the UNFILTERED count since instant mode ignores
  // the server ?q/?type/?from/?to (those are applied client-side there).
  const totalAll = await movementsSvc.count({ warehouseId }).catch(() => null);
  const instant = totalAll != null && totalAll <= MOVEMENTS_INSTANT_CAP;

  let instantRows: MovementDisplayRow[] = [];
  let visible: Awaited<ReturnType<typeof movementsSvc.list>> = [];
  let total: number | null = totalAll;
  let hasNext = false;
  let totalPages: number | undefined;

  if (instant) {
    const all = await movementsSvc.list({ limit: MOVEMENTS_INSTANT_CAP, offset: 0, warehouseId });
    instantRows = all.map((m) => ({
      id: m.id as string,
      movementType: m.movement_type as string,
      quantityChange: Number(m.quantity_change),
      newQuantity: Number(m.new_quantity),
      movedQuantity: m.moved_quantity == null ? null : Number(m.moved_quantity),
      reason: (m.reason as string | null) ?? (m.notes as string | null) ?? null,
      createdAt: m.created_at as string,
      itemName: m.item?.name ?? null,
      itemSku: m.item?.sku ?? null,
      actorLabel: m.actor?.fullName ?? m.actor?.email ?? (m.user_id ? 'Unknown' : 'System'),
      actorEmail: m.actor?.fullName && m.actor?.email ? m.actor.email : null,
    }));
  } else {
    // One extra row detects a next page even if the count is unavailable; the
    // count drives the numbered pager. Server-side search + type/date here.
    const [movements, cnt] = await Promise.all([
      movementsSvc.list({
        limit: PAGE_SIZE + 1,
        offset,
        warehouseId,
        search: search || undefined,
        types: typeFilter ? [typeFilter] : undefined,
        since,
        until,
      }),
      movementsSvc
        .count({
          warehouseId,
          search: search || undefined,
          types: typeFilter ? [typeFilter] : undefined,
          since,
          until,
        })
        .catch(() => null),
    ]);
    hasNext = movements.length > PAGE_SIZE;
    visible = hasNext ? movements.slice(0, PAGE_SIZE) : movements;
    total = cnt;
    totalPages = cnt != null ? Math.max(1, Math.ceil(cnt / PAGE_SIZE)) : undefined;
  }

  const activeFilters = { q: search, type: rawType, from: rawFrom, to: rawTo };

  // Preserve the active filters across (server-mode) page links.
  const hrefForPage = (n: number) => {
    const sp = new URLSearchParams(buildMovementsQueryString(activeFilters));
    if (n > 1) sp.set('page', String(n));
    const qs = sp.toString();
    return qs ? `/dashboard/movements?${qs}` : '/dashboard/movements';
  };

  const exportQs = buildMovementsQueryString(activeFilters);
  const exportHref = exportQs ? `/api/movements/export.csv?${exportQs}` : '/api/movements/export.csv';

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Stock movements</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every quantity change, audited. The ledger is append-only.
        </p>
      </div>
      {/* Controls get their own full-width row (filter bar left, export +
          pager right) so they never fight the heading for space — the same
          layout MovementsInstantTable renders in instant mode. */}
      {!instant && (total !== 0 || hasActiveFilters) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <MovementsFilterBar mode="server" initial={activeFilters} />
          <div className="flex items-center gap-3">
            <Button asChild variant="outline" size="sm">
              <a href={exportHref} download aria-label="Export movements to CSV">
                <Download className="mr-1.5 h-3.5 w-3.5" />
                Export CSV
              </a>
            </Button>
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={total}
              totalPages={totalPages}
              hasNext={hasNext}
              hrefForPage={hrefForPage}
            />
          </div>
        </div>
      )}

      {!instant && total === 0 && hasActiveFilters ? (
        // Server mode, filtered count is 0: a no-match filter must stay
        // visible (and clearable), not get swallowed by the "ledger's
        // truly empty" state below — otherwise the user can't tell why
        // nothing showed up or how to get back to an unfiltered view.
        <EmptyState
          icon={ArrowLeftRight}
          title="No movements match"
          description="Nothing found for the current filters. Try a different search, type, or date range."
          cta={{ label: 'Clear filters', href: '/dashboard/movements' }}
        />
      ) : total === 0 ? (
        <EmptyState
          icon={ArrowLeftRight}
          title="No movements yet"
          description="Every stock change gets recorded here — create an item, adjust quantity, or receive a PO and it'll show up."
          cta={{ label: 'Go to inventory', href: '/dashboard/inventory' }}
        />
      ) : instant ? (
        <MovementsInstantTable rows={instantRows} />
      ) : visible.length === 0 ? (
        hasActiveFilters ? (
          <EmptyState
            icon={ArrowLeftRight}
            title="No movements match"
            description="Nothing found for the current filters. Try a different search, type, or date range."
            cta={{ label: 'Clear filters', href: '/dashboard/movements' }}
          />
        ) : page === 1 ? (
          <EmptyState
            icon={ArrowLeftRight}
            title="No movements yet"
            description="Every stock change gets recorded here — create an item, adjust quantity, or receive a PO and it'll show up."
            cta={{ label: 'Go to inventory', href: '/dashboard/inventory' }}
          />
        ) : (
          <EmptyState
            icon={ArrowLeftRight}
            title="End of the ledger"
            description="You've scrolled past the oldest movement. Head back to page one to see recent activity."
            cta={{ label: 'Back to newest', href: '/dashboard/movements' }}
          />
        )
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Δ</TableHead>
                <TableHead className="text-right">After</TableHead>
                <TableHead>By</TableHead>
                <TableHead>Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((m) => {
                const itemName = m.item?.name;
                const change = Number(m.quantity_change);
                // Transfers are net-zero (quantity_change is ALWAYS 0 — the
                // ledger sums to on-hand); show the physical qty moved
                // (moved_quantity, mig 0231) neutrally instead. Pre-0231
                // transfer rows have none → em dash, never a misleading 0.
                const isTransfer = m.movement_type === 'transfer';
                const moved = m.moved_quantity == null ? null : Number(m.moved_quantity);
                const actorLabel =
                  m.actor?.fullName ?? m.actor?.email ?? (m.user_id ? 'Unknown' : 'System');
                return (
                  <TableRow key={m.id as string}>
                    <TableCell className="text-xs text-muted-foreground">
                      <div>{formatRelative(m.created_at as string)}</div>
                      <LocalDateTime
                        iso={m.created_at as string}
                        className="text-[11px] opacity-80"
                      />
                    </TableCell>
                    <TableCell className="font-medium">{itemName ?? '—'}</TableCell>
                    <TableCell className="text-xs uppercase tracking-wider text-muted-foreground">
                      {m.movement_type as string}
                    </TableCell>
                    <TableCell
                      className={
                        'text-right font-mono tabular-nums ' +
                        (isTransfer
                          ? ''
                          : change > 0
                            ? 'text-success'
                            : change < 0
                              ? 'text-destructive'
                              : '')
                      }
                    >
                      {isTransfer ? (
                        moved != null ? (
                          formatNumber(moved)
                        ) : (
                          '—'
                        )
                      ) : (
                        <>
                          {change > 0 ? '+' : ''}
                          {formatNumber(change)}
                        </>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(Number(m.new_quantity))}
                    </TableCell>
                    <TableCell className="text-xs">
                      <div className="font-medium">{actorLabel}</div>
                      {m.actor?.fullName && m.actor.email && (
                        <div className="text-muted-foreground text-[11px]">
                          {m.actor.email}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {(m.reason as string | null) ?? (m.notes as string | null) ?? '—'}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {visible.length > 0 && (
        <div className="mt-4 flex items-center justify-end">
          <Pagination
            page={page}
            totalPages={totalPages}
            hasNext={hasNext}
            hrefForPage={hrefForPage}
          />
        </div>
      )}
    </div>
  );
}

function clampPage(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(Math.max(Math.floor(n), 1), 10_000);
}
