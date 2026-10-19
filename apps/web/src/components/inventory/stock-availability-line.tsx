import { AlertTriangle } from 'lucide-react';

import { StatStripItem } from '@/components/patterns/stat-strip';
import { formatNumber } from '@/lib/utils';

import { formatStockQuantity, stockAvailability } from '@stockpilot/core';

/**
 * Reserved / Available, as two cells of the item page's figure strip, beside
 * On hand (the reference's "Allocated" and "Available", with the real words:
 * the reserved figure is stock promised to open orders, `stock_reservations`).
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * `stock_reservations` has been live since migration 0073 — 158 rows in
 * production — and is already read by the orders catalog, the rentals pages and
 * auto-archive. Until now there was nowhere an operator could SEE it. The item
 * page showed a single "on hand" figure, which is the number a person is least
 * able to act on: some of it is already promised to open orders.
 *
 * RENDERS NOTHING WHEN NOTHING IS RESERVED. An item with no open promises has
 * available == on hand, and printing "46 available, 0 reserved" beside "46 on
 * hand" is three ways of saying one number. The cells appear exactly when they
 * carry information the on-hand figure does not. On hand is never labelled
 * available: the Available cell is on hand minus what is reserved.
 *
 * The two cells are direct children of the page's StatStrip (they are its
 * cells), so this renders a fragment, never a wrapper.
 */
export function StockAvailabilityLine({
  onHand,
  reserved,
  unit,
}: {
  onHand: number;
  reserved: number;
  unit?: string | null;
}) {
  const a = stockAvailability({ onHand, reserved });
  if (a.reserved <= 0 && !a.overReserved) return null;

  return (
    <>
      <StatStripItem
        size="detail"
        data-testid="item-reserved"
        label="Reserved for open orders"
        value={<FigureWithUnit value={formatNumber(a.reserved)} unit={unit} />}
      />
      <StatStripItem
        size="detail"
        data-testid="item-available"
        label="Available"
        value={<FigureWithUnit value={formatNumber(a.available)} unit={unit} />}
        sub={
          a.overReserved ? (
            /* Not a styling flourish. Over-reserved means more units are
               promised than exist, so an order that looks fulfillable cannot
               be filled from stock — and clamped to "0 available" it is
               indistinguishable from being plainly sold out. Icon AND text,
               never colour alone. */
            <span className="inline-flex items-center gap-1 font-medium">
              <AlertTriangle className="size-3 shrink-0" aria-hidden />
              {formatStockQuantity(a.shortfall)} short of what is promised
            </span>
          ) : undefined
        }
        subTone="destructive"
      />
    </>
  );
}

/**
 * A strip figure with its unit of measure after it ("24 each"), the unit in the
 * quiet body face so the number reads first. The space between them is real
 * text, so the figure is read as "24 each" and never as one word. Shared with
 * the item page's On hand and Reorder at cells.
 */
export function FigureWithUnit({ value, unit }: { value: string; unit?: string | null }) {
  return (
    <>
      {value}
      {unit ? (
        <>
          {' '}
          <span className="text-muted-foreground font-sans text-[13px] font-normal tracking-normal">
            {unit}
          </span>
        </>
      ) : null}
    </>
  );
}
