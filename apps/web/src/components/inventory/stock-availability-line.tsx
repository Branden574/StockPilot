import { AlertTriangle } from 'lucide-react';

import { formatNumber } from '@/lib/utils';

import { formatStockQuantity, stockAvailability } from '@stockpilot/core';

/**
 * On hand / Reserved / Available, rendered under the on-hand figure.
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
 * available == on hand, and printing "46 available, 0 reserved" under "46 on
 * hand" is three ways of saying one number. The line appears exactly when it
 * carries information the figure above it does not.
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

  const u = unit ? ` ${unit}` : '';
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
      <span className="tabular-nums">
        <span className="font-medium">{formatNumber(a.available)}</span>
        <span className="text-muted-foreground"> available{u}</span>
      </span>
      <span className="text-muted-foreground select-none" aria-hidden>
        ·
      </span>
      <span className="text-muted-foreground tabular-nums">
        {formatNumber(a.reserved)} reserved for open orders
      </span>
      {a.overReserved && (
        /* Not a styling flourish. Over-reserved means more units are promised
           than exist, so an order that looks fulfillable cannot be filled from
           stock — and clamped to "0 available" it is indistinguishable from
           being plainly sold out. Icon AND text, never colour alone. */
        <span className="text-destructive inline-flex items-center gap-1 font-medium">
          <AlertTriangle className="size-3" aria-hidden />
          {formatStockQuantity(a.shortfall)} short of what is promised
        </span>
      )}
    </div>
  );
}
