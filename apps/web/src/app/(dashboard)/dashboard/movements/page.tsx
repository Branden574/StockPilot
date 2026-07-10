import { ArrowLeftRight } from 'lucide-react';
import { redirect } from 'next/navigation';

import { EmptyState } from '@/components/ui/empty-state';
import { MovementsSearch } from '@/components/movements/movements-search';
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
import { MovementsService } from '@/server/services/movements';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';
import { formatNumber, formatRelative } from '@/lib/utils';

import { can } from '@stockpilot/core';

const PAGE_SIZE = 50;

export default async function MovementsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string }>;
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

  const [movementsSvc, warehouseFilter] = await Promise.all([
    MovementsService.forCurrentUser(),
    getActiveWarehouseFilter(),
  ]);
  // One extra row detects a next page even if the count is unavailable; the
  // count drives the numbered pager.
  const [movements, total] = await Promise.all([
    movementsSvc.list({
      limit: PAGE_SIZE + 1,
      offset,
      warehouseId: warehouseFilter ?? undefined,
      search: search || undefined,
    }),
    movementsSvc
      .count({ warehouseId: warehouseFilter ?? undefined, search: search || undefined })
      .catch(() => null),
  ]);
  const hasNext = movements.length > PAGE_SIZE;
  const visible = hasNext ? movements.slice(0, PAGE_SIZE) : movements;
  const totalPages = total != null ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : undefined;

  // Preserve the active search across page links.
  const hrefForPage = (n: number) => {
    const sp = new URLSearchParams();
    if (search) sp.set('q', search);
    if (n > 1) sp.set('page', String(n));
    const qs = sp.toString();
    return qs ? `/dashboard/movements?${qs}` : '/dashboard/movements';
  };

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Stock movements</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every quantity change, audited. The ledger is append-only.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <MovementsSearch initialQuery={search} />
          <p className="text-muted-foreground text-xs tabular-nums">
            {total != null
              ? `${formatNumber(total)} movement${total === 1 ? '' : 's'}`
              : `Page ${page}`}
          </p>
          <Pagination
            page={page}
            totalPages={totalPages}
            hasNext={hasNext}
            hrefForPage={hrefForPage}
          />
        </div>
      </div>

      {visible.length === 0 ? (
        search ? (
          <EmptyState
            icon={ArrowLeftRight}
            title="No movements match"
            description={`Nothing found for "${search}". Try a different item name or SKU, or clear the search.`}
            cta={{ label: 'Clear search', href: '/dashboard/movements' }}
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
                      {formatRelative(m.created_at as string)}
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
