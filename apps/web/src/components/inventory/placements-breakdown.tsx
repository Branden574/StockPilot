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
 * item/book detail page.  Shows each location's quantity inline, separated by
 * mid-dots.  The staging location is visually distinguished with a muted badge
 * so operations staff can quickly see how much is pickable vs. still staged.
 * Renders nothing when no placement data exists (new items, no locations).
 */
export function PlacementsBreakdown({ placements }: PlacementsBreakdownProps) {
  const visible = placements.filter((p) => p.quantity > 0);
  if (visible.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
      {visible.map((p, i) => {
        const isStaging = p.kind === 'staging';
        return (
          <span key={p.locationId} className="inline-flex items-center gap-1">
            {i > 0 && (
              <span className="text-muted-foreground select-none" aria-hidden>
                ·
              </span>
            )}
            {isStaging ? (
              <span className="bg-muted text-muted-foreground inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium tabular-nums">
                {formatNumber(p.quantity)} staged
              </span>
            ) : (
              <span className="text-sm tabular-nums">
                <span className="font-medium">{formatNumber(p.quantity)}</span>
                <span className="text-muted-foreground"> in {p.name}</span>
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}
