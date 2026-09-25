'use client';

import { PackageMinus } from 'lucide-react';

import { formatElsewhereNote } from '@stockpilot/core';

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
 * Compact per-location stock breakdown rendered below the "On hand" row on the
 * item/book detail page.  Shows each PLACED location's quantity inline,
 * separated by mid-dots.  Staging and unplaced holdings are deliberately
 * excluded here — they're summarized by the amber "N awaiting put-away" line
 * that sits alongside this component, so showing them twice (once as a badge,
 * once in that line) read as redundant and inconsistent. Renders nothing when
 * there is no PLACED stock (all on-hand still awaiting put-away, or new item).
 *
 * When `canRemoveStock` is set, each placed holding also carries a small
 * "remove from this rack" affordance (the 2026-07-23 write-off tool) — a rack-
 * scoped removal that leaves stock in every other rack alone, unlike archive.
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
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
      {visible.map((p, i) => (
        <span key={p.locationId} className="inline-flex items-center gap-1">
          {i > 0 && (
            <span className="text-muted-foreground select-none" aria-hidden>
              ·
            </span>
          )}
          <span className="text-sm tabular-nums">
            <span className="font-medium">{formatNumber(p.quantity)}</span>
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
                  className="text-muted-foreground hover:text-destructive size-6"
                  aria-label={`Remove stock from ${p.name}`}
                >
                  <PackageMinus className="size-3.5" />
                </Button>
              }
            />
          )}
        </span>
      ))}
      {elsewhereShown && (
        <span className="inline-flex items-center gap-1" data-testid="placements-elsewhere">
          {visible.length > 0 && (
            <span className="text-muted-foreground select-none" aria-hidden>
              ·
            </span>
          )}
          <span className="text-muted-foreground text-sm tabular-nums">
            {formatElsewhereNote(elsewhereShown.quantity, elsewhereShown.locationCount)}
          </span>
        </span>
      )}
    </div>
  );
}
