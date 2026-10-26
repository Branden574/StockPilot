'use client';

import { ChevronRight, Search, X } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { FilterBar } from '@/components/patterns/filter-bar';
import { StatePanel } from '@/components/patterns/state-panel';
import { touchTargetClass } from '@/components/patterns/touch-target';
import { PoStatusBadge } from '@/components/po/po-status-badge';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useHydrated } from '@/lib/use-hydrated';
import { cn, formatCurrency, formatDateShort } from '@/lib/utils';

import { formatCalendarDate } from '@stockpilot/core';

import './po-list.css';

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

/*
 * Supplier, Status, Placed, Expected and Lines need the room of a wide card.
 * Where the card is narrower (a phone, a narrow window beside the sidebar)
 * the row folds into the reference's two-line row instead of scrolling the
 * table sideways: the status beside the PO number, the supplier and the dates
 * on a line under it, and the line count under the total. The widths are the
 * card's own (a container query), not the window's, so the sidebar is
 * allowed for.
 *
 * ONE COPY OF EACH VALUE (P69-1). The fold was a second copy of the status,
 * the supplier, the dates and the line count, hidden in the wide table as the
 * wide cells were hidden in the fold: at 800 rows, 7,116 more elements,
 * 1.3 MB more document and 16 ms more for each letter typed in the search.
 * Now every value is drawn once, in its own cell, and under 640px the
 * container query lays those same cells out as the fold: the rules are in
 * po-list.css under table[data-slot='po-list'], so a row carries no classes
 * for the fold and the wide table no hidden copy. A row tells the rules only
 * what CSS cannot see: `data-none` on a part the fold leaves out (no
 * supplier, a draft's Placed, a Placed day not printed yet), `data-one` on a
 * line count of 1 ("1 line") and, on the table, `--po-total-ch`, the
 * right-hand column's width. The words only the fold shows, "Placed",
 * "Expected", "line" or "lines" and each "·", are generated content there.
 *
 * A table, row or cell drawn as a block or a flex box loses its table
 * semantics in Chromium and WebKit, so the table, its row groups, rows,
 * headers and cells carry their ARIA roles, and under 640px the headers of
 * the folded columns are visually hidden, never removed: every cell keeps
 * its column's name.
 */
const FOLD_LEFT_OUT = { 'data-none': '' } as const;

/**
 * The purchase orders list (DESIGN-SPEC 6.9 table in M4's quiet row style:
 * mono PO number and total, the small status label, quiet dates). Both list
 * modes draw this same table: the instant table below with the rows it
 * filtered, and the server-paged page with its 30 rows and its pager as
 * `footer`.
 *
 * Each row keeps its two links to the PO (the number and the open chevron)
 * and nothing else is clickable, as before.
 */
export function PoListTable({
  rows,
  supplierNames,
  footer,
}: {
  rows: readonly PoInstantRow[];
  supplierNames: Record<string, string>;
  /** Under the rows, inside the card (the server-paged list's pager). */
  footer?: React.ReactNode;
}) {
  // Placed is an instant, shown as a day in the VIEWER's zone, which the server
  // (UTC on Vercel) does not have: an evening order is the next day there, and
  // hydrating that day threw React error #418. So it is printed once hydrated;
  // a missing date is a dash at once. The server-paged list printed the
  // server's day (CONFLICTS D12: a day late for an evening order west of UTC);
  // it draws this table now, so it waits for the viewer's zone too.
  const hydrated = useHydrated();
  const placedDay = (iso: string | null) => (iso && !hydrated ? null : formatDateShort(iso));
  // Expected is a DAY the buyer picked, stored as that day's UTC midnight
  // (po-form sends new Date('YYYY-MM-DD')). Read in UTC it is the picked day on
  // the server and in every browser, as on the PO's page, its PDF
  // (lib/pdf/po.tsx) and the phone: core's formatCalendarDate is that one rule.
  // Read in the viewer's zone it was the day before.
  const expectedDay = (iso: string | null) => formatCalendarDate(iso);
  const supplierName = (id: string | null) => (id ? (supplierNames[id] ?? '—') : '—');
  // Each total once, and the fold's right-hand column in characters of the
  // total's face: the longest total, as a table column is as wide as its
  // widest total, or a line count's "N lines" where that is wider (its
  // smaller type is never wider than its digits and four characters more).
  const totals = rows.map((po) => formatCurrency(Number(po.total ?? 0)));
  const totalCh = rows.reduce(
    (most, po, index) =>
      Math.max(most, totals[index]?.length ?? 0, String(po.line_count).length + 4),
    0,
  );

  return (
    <div className="border-border bg-card @container min-w-0 overflow-hidden rounded-lg border">
      <Table
        role="table"
        data-slot="po-list"
        style={{ '--po-total-ch': totalCh } as React.CSSProperties}
      >
        <TableHeader role="rowgroup">
          <TableRow role="row" className="hover:bg-transparent">
            <TableHead role="columnheader">PO #</TableHead>
            <TableHead role="columnheader">Supplier</TableHead>
            <TableHead role="columnheader">Status</TableHead>
            <TableHead role="columnheader">Placed</TableHead>
            <TableHead role="columnheader">Expected</TableHead>
            <TableHead role="columnheader" className="text-right">
              Lines
            </TableHead>
            <TableHead role="columnheader" className="text-right">
              Total
            </TableHead>
            <TableHead role="columnheader" className="w-8" aria-label="Open" />
          </TableRow>
        </TableHeader>
        <TableBody role="rowgroup">
          {rows.map((po, index) => {
            // "Placed" = when the PO was sent to the supplier. Drafts haven't
            // been placed yet; imports lack ordered_at so fall back to
            // created_at.
            const placed = po.status === 'draft' ? null : (po.ordered_at ?? po.created_at);
            const placedText = placedDay(placed);
            const supplier = supplierName(po.supplier_id);
            // What the fold leaves out: no supplier, and Placed for a draft
            // or until the viewer's zone is known (like the column). Expected
            // is always drawn, last.
            const foldsSupplier = supplier !== '—';
            const foldsPlaced = Boolean(placed && placedText);
            return (
              <TableRow key={po.id} role="row" className="group">
                <TableCell role="cell">
                  {/* Top-aligned, the mono number sets its own line as it did as
                      a flex item, rather than sitting on the sans face's
                      baseline a pixel lower. */}
                  <Link
                    href={`/dashboard/purchase-orders/${po.id}`}
                    className="text-foreground whitespace-nowrap align-top font-mono text-[13.5px] font-medium hover:underline"
                  >
                    {po.po_number}
                  </Link>
                </TableCell>
                <TableCell
                  role="cell"
                  className="text-ink-2"
                  {...(foldsSupplier ? null : FOLD_LEFT_OUT)}
                >
                  {supplier}
                </TableCell>
                <TableCell role="cell">
                  <PoStatusBadge status={po.status} />
                </TableCell>
                <TableCell
                  role="cell"
                  className="text-muted-foreground whitespace-nowrap text-[12.5px] tabular-nums"
                  {...(foldsPlaced ? null : FOLD_LEFT_OUT)}
                >
                  {placedText}
                </TableCell>
                <TableCell
                  role="cell"
                  className="text-muted-foreground whitespace-nowrap text-[12.5px] tabular-nums"
                >
                  {expectedDay(po.expected_at)}
                </TableCell>
                <TableCell
                  role="cell"
                  className="text-right tabular-nums"
                  data-one={po.line_count === 1 ? '' : undefined}
                >
                  {po.line_count}
                </TableCell>
                <TableCell role="cell" className="whitespace-nowrap text-right align-middle">
                  <span className="text-foreground font-mono text-[13.5px] tabular-nums">
                    {totals[index]}
                  </span>
                </TableCell>
                <TableCell role="cell" className="w-8 pl-1 text-right">
                  <Link
                    href={`/dashboard/purchase-orders/${po.id}`}
                    aria-label={`Open ${po.po_number}`}
                    className={cn(
                      'text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring inline-flex size-8 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2',
                      touchTargetClass,
                    )}
                  >
                    <ChevronRight
                      aria-hidden
                      className="h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5"
                    />
                  </Link>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {footer}
    </div>
  );
}

/**
 * Instant, zero-latency PO search — the Items/Books instant-mode pattern.
 * The server hands us the whole (warehouse + tab) PO set when it's small
 * enough (see the page's INSTANT_CAP), and this filters it client-side as the
 * user types across PO number + supplier name. No round-trip, no Enter.
 *
 * It draws the list's filter row itself, with the page's status tabs as
 * `leading`, so the search sits beside the tabs as the server-paged search
 * does.
 */
export function PoInstantTable({
  rows,
  supplierNames,
  leading,
}: {
  rows: PoInstantRow[];
  supplierNames: Record<string, string>;
  /** The status tabs, left of the search in the filter row. */
  leading?: React.ReactNode;
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
      {/* On a phone each group of the row takes the whole width, so the
          search field spans it under the tabs. */}
      <FilterBar leading={leading} className="max-sm:[&>div]:w-full">
        <div className="relative w-full sm:w-60">
          <Search
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
          />
          <Input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search PO #, supplier…"
            aria-label="Search purchase orders"
            className="pl-8 pr-9 [&::-webkit-search-cancel-button]:appearance-none"
          />
          {q && (
            <button
              type="button"
              onClick={() => setQ('')}
              aria-label="Clear search"
              className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring absolute right-1 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 max-sm:size-9"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </FilterBar>

      {filtered.length === 0 ? (
        <StatePanel
          kind="no-match"
          title={`No POs match “${q}”`}
          description="Try a different PO number or supplier, or clear the search."
        />
      ) : (
        <PoListTable rows={filtered} supplierNames={supplierNames} />
      )}
    </>
  );
}
