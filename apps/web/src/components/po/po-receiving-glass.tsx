import { formatCalendarDate } from '@stockpilot/core';

import { liquidGlassRollout } from '@/components/theme/appearance-flag';
import { Badge } from '@/components/ui/badge';
import { TableCell, TableHead } from '@/components/ui/table';
import { formatNumber } from '@/lib/utils';

/**
 * What Liquid Glass adds to a purchase order (Purchase-Order.dc.html): the
 * receiving summary over the lines, and the board's line columns.
 *
 * Every part is glass-only (data-glass-only) and stateless: figures and words
 * from the lines (ordered, received) and the expected day the page already
 * loads, so nothing new is read, and no link, button or field. Hidden in
 * Classic by styles/liquid-glass/visibility.css and not rendered at all under
 * the `off` rollout, so the Classic page is today's (page.classic-dom
 * .test.tsx). Each goes BETWEEN two Classic siblings, where it changes no
 * Classic element's place (a hidden element still counts for :first-child
 * and :last-child): the card between Line items and Receipts (glass draws it
 * first, pages/po.css), the four cells between a line's Item cell and
 * Classic's "Received / ordered" cell, which carries data-classic-only and
 * which glass hides in their place. Allowlisted in
 * tests/e2e/appearance/glass-only-allowlist.json.
 *
 * Not drawn: the board's "Overdue by n days". A purchase order is overdue by
 * the organization's day (core calendar-date.ts, the owner's rule), and this
 * page does not read the organization's zone.
 */

/** The statuses whose goods are on their way or here: the board's open order. */
const RECEIVING = new Set(['ordered', 'expected_inbound', 'partially_received', 'received']);

export interface PoGlassLine {
  quantityOrdered: number;
  quantityReceived: number;
}

/** What is still to come on a line: never below nothing (an over-receipt). */
const outstandingOf = (l: PoGlassLine) => Math.max(0, l.quantityOrdered - l.quantityReceived);

/**
 * The board's "Receiving progress" card: Received x of y units, Still
 * expected, Expected (the day), and the 10 px bar of units received. Drawn
 * for an order whose goods are on their way or here, with something ordered.
 */
export function PoReceivingProgress({
  status,
  lines,
  expectedAt,
}: {
  status: string;
  lines: PoGlassLine[];
  expectedAt: string | null;
}) {
  if (liquidGlassRollout() === 'off' || !RECEIVING.has(status)) return null;
  const ordered = lines.reduce((sum, l) => sum + l.quantityOrdered, 0);
  if (!(ordered > 0)) return null;
  const received = lines.reduce((sum, l) => sum + l.quantityReceived, 0);
  const still = lines.reduce((sum, l) => sum + outstandingOf(l), 0);
  const shown = Math.min(received, ordered);
  return (
    <section data-glass-only="" data-glass="po-progress" aria-label="Receiving progress">
      <div data-glass="po-progress-figures">
        <div data-glass="po-progress-stat">
          <span>Received</span>
          <span>
            {formatNumber(received)}{' '}
            <span data-glass="po-progress-of">of {formatNumber(ordered)} units</span>
          </span>
        </div>
        <div data-glass="po-progress-stat">
          <span>Still expected</span>
          <span>{formatNumber(still)}</span>
        </div>
        <div data-glass="po-progress-stat">
          <span>Expected</span>
          <span data-glass="po-progress-day">
            {formatCalendarDate(expectedAt, { weekday: 'short', month: 'short', day: 'numeric' })}
          </span>
        </div>
      </div>
      <div
        data-glass="po-progress-bar"
        role="progressbar"
        aria-label="Units received"
        aria-valuemin={0}
        aria-valuemax={ordered}
        aria-valuenow={shown}
      >
        <span style={{ width: `${(shown / ordered) * 100}%` }} />
      </div>
    </section>
  );
}

/** The board's four line column heads, between Item and Classic's column. */
export function PoLineGlassHeads() {
  if (liquidGlassRollout() === 'off') return null;
  return (
    <>
      <TableHead data-glass-only="" data-glass="po-line-ordered" className="text-right">
        Ordered
      </TableHead>
      <TableHead data-glass-only="" data-glass="po-line-received" className="text-right">
        Received
      </TableHead>
      <TableHead data-glass-only="" data-glass="po-line-outstanding" className="text-right">
        Outstanding
      </TableHead>
      <TableHead data-glass-only="" data-glass="po-line-status">
        Status
      </TableHead>
    </>
  );
}

/**
 * A line's four board cells: ordered, received (strong), outstanding (the
 * warn ink while something is still to come) and its status: "n still to
 * come" or "Fully received", as the board words them. A draft or cancelled
 * order's open line has no status ("—"): nothing is on its way.
 */
export function PoLineGlassCells({ line, status }: { line: PoGlassLine; status: string }) {
  if (liquidGlassRollout() === 'off') return null;
  const outstanding = outstandingOf(line);
  return (
    <>
      <TableCell data-glass-only="" data-glass="po-line-ordered" className="text-right">
        {formatNumber(line.quantityOrdered)}
      </TableCell>
      <TableCell data-glass-only="" data-glass="po-line-received" className="text-right">
        {formatNumber(line.quantityReceived)}
      </TableCell>
      <TableCell
        data-glass-only=""
        data-glass="po-line-outstanding"
        data-state={outstanding > 0 ? 'due' : 'none'}
        className="text-right"
      >
        {formatNumber(outstanding)}
      </TableCell>
      <TableCell data-glass-only="" data-glass="po-line-status">
        {outstanding === 0 ? (
          <Badge variant="success">Fully received</Badge>
        ) : RECEIVING.has(status) ? (
          <Badge variant="warning">{formatNumber(outstanding)} still to come</Badge>
        ) : (
          '—'
        )}
      </TableCell>
    </>
  );
}
