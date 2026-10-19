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
 * Supplier, Status, Placed, Expected and Lines need the room of a wide card.
 * Where the card is narrower (a phone, a narrow window beside the sidebar)
 * those columns fold into the reference's two-line row instead of scrolling
 * the table sideways: the status beside the PO number, the supplier and the
 * dates on a line under it, and the line count under the total. Every value
 * stays on screen and in the table for a screen reader: a hidden column is out
 * of both, a folded line is in both. The widths are the card's own (a
 * container query), not the window's, so the sidebar is allowed for.
 */
const WIDE = 'hidden @min-[640px]:table-cell';
/** The folded parts, shown only while the columns above are hidden. */
const NARROW = '@min-[640px]:hidden';

function linesLabel(count: number): string {
  return `${count} ${count === 1 ? 'line' : 'lines'}`;
}

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

  return (
    <div className="border-border bg-card @container min-w-0 overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>PO #</TableHead>
            <TableHead className={WIDE}>Supplier</TableHead>
            <TableHead className={WIDE}>Status</TableHead>
            <TableHead className={WIDE}>Placed</TableHead>
            <TableHead className={WIDE}>Expected</TableHead>
            <TableHead className={cn(WIDE, 'text-right')}>Lines</TableHead>
            <TableHead className="text-right">Total</TableHead>
            <TableHead className="w-8" aria-label="Open" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((po) => {
            // "Placed" = when the PO was sent to the supplier. Drafts haven't
            // been placed yet; imports lack ordered_at so fall back to
            // created_at.
            const placed = po.status === 'draft' ? null : (po.ordered_at ?? po.created_at);
            const placedText = placedDay(placed);
            const expectedText = expectedDay(po.expected_at);
            const supplier = supplierName(po.supplier_id);
            // One text, so it reads as one line; the Placed day joins it once
            // the viewer's zone is known, like the column.
            const folded = [
              supplier === '—' ? null : supplier,
              placed && placedText ? `Placed ${placedText}` : null,
              `Expected ${expectedText}`,
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <TableRow key={po.id} className="group">
                <TableCell>
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <Link
                      href={`/dashboard/purchase-orders/${po.id}`}
                      className="text-foreground whitespace-nowrap font-mono text-[13.5px] font-medium hover:underline"
                    >
                      {po.po_number}
                    </Link>
                    <span className={NARROW}>
                      <PoStatusBadge status={po.status} />
                    </span>
                  </div>
                  <p
                    className={cn(
                      NARROW,
                      'text-muted-foreground mt-0.5 text-[12.5px] leading-[18.75px]',
                    )}
                  >
                    {folded}
                  </p>
                </TableCell>
                <TableCell className={cn(WIDE, 'text-ink-2')}>{supplier}</TableCell>
                <TableCell className={WIDE}>
                  <PoStatusBadge status={po.status} />
                </TableCell>
                <TableCell
                  className={cn(
                    WIDE,
                    'text-muted-foreground whitespace-nowrap text-[12.5px] tabular-nums',
                  )}
                >
                  {placedText}
                </TableCell>
                <TableCell
                  className={cn(
                    WIDE,
                    'text-muted-foreground whitespace-nowrap text-[12.5px] tabular-nums',
                  )}
                >
                  {expectedText}
                </TableCell>
                <TableCell className={cn(WIDE, 'text-right tabular-nums')}>
                  {po.line_count}
                </TableCell>
                <TableCell className="whitespace-nowrap text-right align-middle">
                  <span className="text-foreground font-mono text-[13.5px] tabular-nums">
                    {formatCurrency(Number(po.total ?? 0))}
                  </span>
                  <span
                    className={cn(
                      NARROW,
                      'text-muted-foreground mt-0.5 block text-[12px] leading-[18px]',
                    )}
                  >
                    {linesLabel(po.line_count)}
                  </span>
                </TableCell>
                <TableCell className="w-8 pl-1 text-right">
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
