'use client';

import { ChevronRight, Search, X } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { PoStatusBadge } from '@/components/po/po-status-badge';
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
import { ClipboardList } from 'lucide-react';
import { formatCurrency, formatDateShort } from '@/lib/utils';

export interface PoInstantRow {
  id: string;
  po_number: string;
  supplier_id: string | null;
  status: string;
  ordered_at: string | null;
  created_at: string;
  expected_at: string | null;
  line_count: number;
  total: number | null;
}

/**
 * Instant, zero-latency PO search — the Items/Books instant-mode pattern.
 * The server hands us the whole (warehouse + tab) PO set when it's small
 * enough (see the page's INSTANT_CAP), and this filters it client-side as the
 * user types across PO number + supplier name. No round-trip, no Enter.
 */
export function PoInstantTable({
  rows,
  supplierNames,
}: {
  rows: PoInstantRow[];
  supplierNames: Record<string, string>;
}) {
  const [q, setQ] = React.useState('');

  const supplierName = React.useCallback(
    (id: string | null) => (id ? (supplierNames[id] ?? '—') : '—'),
    [supplierNames],
  );

  const filtered = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (po) =>
        po.po_number.toLowerCase().includes(needle) ||
        supplierName(po.supplier_id).toLowerCase().includes(needle),
    );
  }, [q, rows, supplierName]);

  return (
    <>
      <div className="mb-4 flex justify-end">
        <div className="relative min-w-[220px] max-w-xs flex-1 sm:flex-none">
          <Search className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
          <Input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search PO #, supplier…"
            aria-label="Search purchase orders"
            className="h-9 pl-8 pr-8 text-[13px]"
          />
          {q && (
            <button
              type="button"
              onClick={() => setQ('')}
              aria-label="Clear search"
              className="text-muted-foreground hover:text-foreground absolute right-2 top-1/2 -translate-y-1/2"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title={`No POs match “${q}”`}
          description="Try a different PO number or supplier, or clear the search."
        />
      ) : (
        <div className="bg-card overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>PO #</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Placed</TableHead>
                <TableHead>Expected</TableHead>
                <TableHead className="text-right">Lines</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="w-8" aria-label="Open" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((po) => {
                const placed = po.status === 'draft' ? null : (po.ordered_at ?? po.created_at);
                return (
                  <TableRow key={po.id} className="group">
                    <TableCell>
                      <Link
                        href={`/dashboard/purchase-orders/${po.id}`}
                        className="font-mono text-sm font-medium hover:underline"
                      >
                        {po.po_number}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {supplierName(po.supplier_id)}
                    </TableCell>
                    <TableCell>
                      <PoStatusBadge status={po.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm tabular-nums">
                      {formatDateShort(placed)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm tabular-nums">
                      {formatDateShort(po.expected_at)}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {po.line_count}
                    </TableCell>
                    <TableCell className="text-right text-sm font-medium tabular-nums">
                      {formatCurrency(Number(po.total ?? 0))}
                    </TableCell>
                    <TableCell className="text-muted-foreground w-8 text-right">
                      <Link
                        href={`/dashboard/purchase-orders/${po.id}`}
                        aria-label={`Open ${po.po_number}`}
                      >
                        <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
                      </Link>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
