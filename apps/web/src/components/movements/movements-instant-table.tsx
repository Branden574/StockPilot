'use client';

import { ArrowLeftRight, Search, X } from 'lucide-react';
import * as React from 'react';

import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatNumber, formatRelative } from '@/lib/utils';

export interface MovementDisplayRow {
  id: string;
  movementType: string;
  quantityChange: number;
  newQuantity: number;
  movedQuantity: number | null;
  reason: string | null;
  createdAt: string;
  itemName: string | null;
  itemSku: string | null;
  actorLabel: string;
  actorEmail: string | null;
}

const PAGE_SIZE = 50;

/**
 * Instant, zero-latency movements ledger — the Items/Books pattern. The server
 * hands us the whole (warehouse-scoped) ledger when it's small enough (see the
 * page's MOVEMENTS_INSTANT_CAP); this filters by item name/SKU as you type AND
 * paginates entirely client-side, so both search and page changes are instant.
 */
export function MovementsInstantTable({ rows }: { rows: MovementDisplayRow[] }) {
  const [q, setQ] = React.useState('');
  const [page, setPage] = React.useState(1);

  const filtered = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (m) =>
        (m.itemName ?? '').toLowerCase().includes(needle) ||
        (m.itemSku ?? '').toLowerCase().includes(needle),
    );
  }, [q, rows]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const visible = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // Reset to page 1 on any query change (done in the handlers, not an effect).
  const setQuery = (value: string) => {
    setQ(value);
    setPage(1);
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-end gap-3">
        <div className="relative min-w-[220px] max-w-xs flex-1 sm:flex-none">
          <Search className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
          <Input
            type="search"
            value={q}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by item name or SKU…"
            aria-label="Search stock movements"
            className="h-9 pl-8 pr-8 text-[13px]"
          />
          {q && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="text-muted-foreground hover:text-foreground absolute right-2 top-1/2 -translate-y-1/2"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <Pagination
          page={safePage}
          pageSize={PAGE_SIZE}
          total={filtered.length}
          onPageChange={setPage}
        />
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={ArrowLeftRight}
          title="No movements match"
          description={`Nothing found for "${q}". Try a different item name or SKU.`}
        />
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
                const isTransfer = m.movementType === 'transfer';
                const change = m.quantityChange;
                return (
                  <TableRow key={m.id}>
                    <TableCell className="text-muted-foreground text-xs">
                      {formatRelative(m.createdAt)}
                    </TableCell>
                    <TableCell className="font-medium">{m.itemName ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground text-xs uppercase tracking-wider">
                      {m.movementType}
                    </TableCell>
                    <TableCell
                      className={
                        'text-right font-mono tabular-nums ' +
                        (isTransfer ? '' : change > 0 ? 'text-success' : change < 0 ? 'text-destructive' : '')
                      }
                    >
                      {isTransfer ? (
                        m.movedQuantity != null ? formatNumber(m.movedQuantity) : '—'
                      ) : (
                        <>
                          {change > 0 ? '+' : ''}
                          {formatNumber(change)}
                        </>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(m.newQuantity)}
                    </TableCell>
                    <TableCell className="text-xs">
                      <div className="font-medium">{m.actorLabel}</div>
                      {m.actorEmail && (
                        <div className="text-muted-foreground text-[11px]">{m.actorEmail}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">{m.reason ?? '—'}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
