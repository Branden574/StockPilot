'use client';

import { Package } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { useTourActive } from '@/lib/onboarding/tour-broadcast';

/**
 * Ghost sample row for brand-new orgs (owner request 2026-07-12, parity
 * with mobile's SampleItemRow): the Items tour's "here's a row" step
 * targets `table tbody tr`, which doesn't exist when the org has no items
 * yet. While that tour runs, this renders a clearly-labeled example row
 * for the spotlight to land on. Client-side only — nothing is written to
 * the database — and it disappears the moment the tour ends. The caller
 * (inventoryEmptyState's no-items branch) mounts it ONLY for a genuinely
 * empty org, never for an empty search/filter result.
 */
export function TourSampleItem() {
  const active = useTourActive('items-page');
  if (!active) return null;

  return (
    <div className="mb-6">
      <div className="bg-card overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-border text-muted-foreground border-b text-left text-xs uppercase tracking-wide">
              <th className="px-4 py-2.5 font-medium">Item</th>
              <th className="px-4 py-2.5 font-medium">SKU</th>
              <th className="px-4 py-2.5 text-right font-medium">On hand</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="px-4 py-3">
                <span className="flex items-center gap-2 font-medium">
                  <span className="bg-muted grid size-8 shrink-0 place-items-center rounded-md">
                    <Package className="size-4" aria-hidden />
                  </span>
                  Acer Chromebook 511
                </span>
              </td>
              <td className="text-muted-foreground px-4 py-3 font-mono text-xs">SAMPLE-001</td>
              <td className="px-4 py-3 text-right tabular-nums">25</td>
              <td className="px-4 py-3">
                <Badge variant="outline">Sample</Badge>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-muted-foreground mt-2 text-center text-xs">
        Example only — it disappears when the tour ends. Your real items will appear here.
      </p>
    </div>
  );
}
