'use client';

import { ArrowLeftRight, Download } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Pagination } from '@/components/ui/pagination';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { LocalDateTime } from '@/components/ui/local-datetime';
import { formatNumber, formatRelative } from '@/lib/utils';
import { buildMovementsQueryString, type MovementsFilterQuery } from '@/lib/movements-filters';

import { EditableMovementNote } from './editable-movement-note';
import { MovementsFilterBar } from './movements-filter-bar';

export interface MovementDisplayRow {
  id: string;
  movementType: string;
  quantityChange: number;
  newQuantity: number;
  movedQuantity: number | null;
  /** Read-only "why" (stock_movements.reason), shown as the note fallback. */
  reason: string | null;
  /** Where that reason points (an order), or null for "plain text". */
  reasonHref: string | null;
  /** Editable free-text note (stock_movements.notes). null when unset. */
  note: string | null;
  /**
   * Per-row gate: false for pre-0231 'receipt_line' rows whose note is a
   * system-managed machine reference (the RPC rejects editing it). Combined
   * with the table-wide `canEditNotes` permission to decide the affordance.
   */
  noteEditable: boolean;
  createdAt: string;
  itemName: string | null;
  itemSku: string | null;
  actorLabel: string;
  actorEmail: string | null;
}

const PAGE_SIZE = 50;
const EMPTY_FILTERS: MovementsFilterQuery = { q: '', type: '', from: '', to: '' };

/**
 * Instant, zero-latency movements ledger — the Items/Books pattern. The
 * server hands us the whole (warehouse-scoped) ledger when it's small enough
 * (see the page's MOVEMENTS_INSTANT_CAP); this filters by item name/SKU,
 * movement type, and date range as the user picks them, plus paginates,
 * entirely client-side, so every change is instant. The CSV export link
 * still re-queries the server with the SAME filter values (via
 * buildMovementsQueryString) rather than dumping what's already in memory,
 * so a single export code path (the route + MovementsService.exportRows)
 * stays the source of truth for both page modes.
 */
export function MovementsInstantTable({
  rows,
  canEditNotes = false,
}: {
  rows: MovementDisplayRow[];
  /** Managers+/granted users get the add/edit-note affordance on each row. */
  canEditNotes?: boolean;
}) {
  const [filters, setFilters] = React.useState<MovementsFilterQuery>(EMPTY_FILTERS);
  const [page, setPage] = React.useState(1);

  const filtered = React.useMemo(() => {
    const needle = filters.q.trim().toLowerCase();
    const type = filters.type || null;
    // Same inclusive-of-whole-day semantics as the server path
    // (lib/movements-filters parseFromDateParam/parseToDateParam).
    const sinceMs = filters.from ? Date.parse(`${filters.from}T00:00:00.000Z`) : null;
    const untilMs = filters.to
      ? Date.parse(`${filters.to}T00:00:00.000Z`) + 24 * 60 * 60 * 1000
      : null;
    return rows.filter((m) => {
      if (
        needle &&
        !(m.itemName ?? '').toLowerCase().includes(needle) &&
        !(m.itemSku ?? '').toLowerCase().includes(needle)
      ) {
        return false;
      }
      if (type && m.movementType !== type) return false;
      if (sinceMs != null || untilMs != null) {
        const createdMs = Date.parse(m.createdAt);
        if (sinceMs != null && createdMs < sinceMs) return false;
        if (untilMs != null && createdMs >= untilMs) return false;
      }
      return true;
    });
  }, [filters, rows]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const visible = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // Reset to page 1 on any filter change.
  function updateFilters(next: MovementsFilterQuery) {
    setFilters(next);
    setPage(1);
  }

  const exportQs = buildMovementsQueryString(filters);
  const exportHref = exportQs ? `/api/movements/export.csv?${exportQs}` : '/api/movements/export.csv';

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <MovementsFilterBar mode="client" initial={EMPTY_FILTERS} onChange={updateFilters} />
        <div className="flex items-center gap-3">
          <Button asChild variant="outline" size="sm">
            <a href={exportHref} download aria-label="Export movements to CSV">
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Export CSV
            </a>
          </Button>
          <Pagination
            page={safePage}
            pageSize={PAGE_SIZE}
            total={filtered.length}
            onPageChange={setPage}
          />
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={ArrowLeftRight}
          title="No movements match"
          description="Nothing found for the current filters. Try a different search, type, or date range."
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
                      <div>{formatRelative(m.createdAt)}</div>
                      <LocalDateTime iso={m.createdAt} className="text-[11px] opacity-80" />
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
                    <TableCell className="text-muted-foreground text-xs">
                      <EditableMovementNote
                        movementId={m.id}
                        note={m.note}
                        reason={m.reason}
                        reasonHref={m.reasonHref}
                        // receipt_line rows are system-managed (RPC rejects the
                        // edit) — read-only regardless of the caller's perm.
                        canEdit={canEditNotes && m.noteEditable}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Bottom pager. The server-mode page (dashboard/movements/page.tsx)
          renders one above AND below the table; instant mode only had the top
          one, so on any ledger under MOVEMENTS_INSTANT_CAP — i.e. most of the
          time — you scrolled to the end of a full page and had to go back up to
          advance. Same props as the top instance so both stay in lockstep. */}
      {visible.length > 0 && (
        <div className="mt-4 flex items-center justify-end">
          <Pagination
            page={safePage}
            pageSize={PAGE_SIZE}
            total={filtered.length}
            onPageChange={setPage}
          />
        </div>
      )}
    </div>
  );
}
