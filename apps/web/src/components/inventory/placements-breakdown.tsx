'use client';

import { formatNumber } from '@/lib/utils';

interface Placement {
  locationId: string;
  name: string;
  kind: string | null;
  quantity: number;
}

interface PlacementsBreakdownProps {
  placements: Placement[];
}

/**
 * Compact per-location stock breakdown rendered below the "On hand" row on the
 * item/book detail page.  Shows each PLACED location's quantity inline,
 * separated by mid-dots.  Staging and unplaced holdings are deliberately
 * excluded here — they're summarized by the amber "N awaiting put-away" line
 * that sits alongside this component, so showing them twice (once as a badge,
 * once in that line) read as redundant and inconsistent. Renders nothing when
 * there is no PLACED stock (all on-hand still awaiting put-away, or new item).
 */
export function PlacementsBreakdown({ placements }: PlacementsBreakdownProps) {
  const visible = placements.filter(
    (p) => p.quantity > 0 && p.kind !== 'staging' && p.kind !== 'unplaced',
  );
  if (visible.length === 0) return null;

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
        </span>
      ))}
    </div>
  );
}
