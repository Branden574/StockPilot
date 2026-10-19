'use client';

import { PackageMinus } from 'lucide-react';

import { formatElsewherePlacedNote } from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { RemoveFromRackDialog } from '@/components/inventory/remove-from-rack-dialog';
import { formatNumber } from '@/lib/utils';

interface Placement {
  locationId: string;
  name: string;
  kind: string | null;
  quantity: number;
}

interface PlacementsBreakdownProps {
  placements: Placement[];
  /** Enables the per-rack "remove stock" write-off. Pass only when the viewer
   *  has stock:adjust — the action re-asserts it, this just gates the control. */
  itemId?: string;
  itemName?: string;
  canRemoveStock?: boolean;
  /**
   * PLACED stock in warehouses the viewer cannot see (item_holdings_elsewhere,
   * 0371), as one entry after the visible racks: "7 in other warehouses
   * (1 location)". A total and a count of places, never which place (with
   * one place the total is that unnamed place's quantity), and never a
   * write-off target (the viewer cannot act on it). Null or absent: nothing
   * placed out of view (always, for managers and above).
   */
  elsewhere?: { quantity: number; locationCount: number } | null;
}

/**
 * The per-location stock breakdown of the item/book page's "By location" card:
 * one row per PLACED location, "24 in 12-A". Staging and unplaced holdings are
 * deliberately excluded here — they're summarized by the amber "N awaiting
 * put-away" line that sits under these rows, so showing them twice (once as a
 * row, once in that line) read as redundant and inconsistent. Renders nothing
 * when there is no PLACED stock (all on-hand still awaiting put-away, or new
 * item).
 *
 * When `canRemoveStock` is set, each placed holding also carries a small
 * "remove from this rack" affordance (the 2026-07-23 write-off tool) — a rack-
 * scoped removal that leaves stock in every other rack alone, unlike archive.
 *
 * Rows are the redesign's list rows (DESIGN-SPEC 6.7: 9 x 18, a hairline
 * between them), so the card reads like the reference's "By location".
 */
export function PlacementsBreakdown({
  placements,
  itemId,
  itemName,
  canRemoveStock,
  elsewhere,
}: PlacementsBreakdownProps) {
  const visible = placements.filter(
    (p) => p.quantity > 0 && p.kind !== 'staging' && p.kind !== 'unplaced',
  );
  const elsewhereShown = elsewhere && elsewhere.quantity > 0 ? elsewhere : null;
  if (visible.length === 0 && !elsewhereShown) return null;

  const showRemove = canRemoveStock === true && !!itemId && !!itemName;

  return (
    <ul data-slot="placements-breakdown" className="divide-border divide-y">
      {visible.map((p) => (
        <li
          key={p.locationId}
          className="flex min-w-0 items-center justify-between gap-3 px-[18px] py-[9px] text-[13.5px] leading-[20.25px]"
        >
          <span className="min-w-0 tabular-nums [overflow-wrap:anywhere]">
            <span className="text-foreground font-medium">{formatNumber(p.quantity)}</span>
            <span className="text-muted-foreground"> in {p.name}</span>
          </span>
          {showRemove && (
            <RemoveFromRackDialog
              itemId={itemId!}
              itemName={itemName!}
              locationId={p.locationId}
              locationName={p.name}
              holdingQuantity={p.quantity}
              trigger={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive -my-1 size-6 shrink-0"
                  aria-label={`Remove stock from ${p.name}`}
                >
                  <PackageMinus className="size-3.5" />
                </Button>
              }
            />
          )}
        </li>
      ))}
      {elsewhereShown && (
        <li
          className="px-[18px] py-[9px] text-[13.5px] leading-[20.25px]"
          data-testid="placements-elsewhere"
        >
          <span className="text-muted-foreground tabular-nums">
            {formatElsewherePlacedNote(elsewhereShown.quantity, elsewhereShown.locationCount)}
          </span>
        </li>
      )}
    </ul>
  );
}
