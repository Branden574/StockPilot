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
    <div className="mb-4">
      {/* The list's own table look (DESIGN-SPEC 6.9), so the example reads as
          a row of it: the SKU on its own mono line under the name, as the list
          shows it (owner decision 2026-10-19). */}
      <div className="border-border bg-card overflow-x-auto rounded-lg border">
        <table className="w-full text-[13.5px]">
          <thead>
            <tr className="border-border text-muted-foreground border-b text-left text-[11px] uppercase tracking-[0.06em]">
              <th className="px-4 py-2.5 font-medium">Item</th>
              <th className="px-3 py-2.5 text-right font-medium">On hand</th>
              <th className="py-2.5 pl-3 pr-4 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="px-4 py-[var(--row-py)]">
                <span className="flex items-center gap-3">
                  <span className="bg-sunk text-muted-foreground border-border grid size-[34px] shrink-0 place-items-center rounded-md border">
                    <Package className="size-4" aria-hidden />
                  </span>
                  <span className="min-w-0">
                    <span className="block font-medium">Acer Chromebook 511</span>
                    <span className="text-muted-foreground block font-mono text-[11.5px] leading-[17.25px]">
                      SAMPLE-001
                    </span>
                  </span>
                </span>
              </td>
              <td className="px-3 py-[var(--row-py)] text-right font-mono font-medium tabular-nums">
                25
              </td>
              <td className="py-[var(--row-py)] pl-3 pr-4">
                <Badge variant="outline">Sample</Badge>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-muted-foreground mt-2 text-center text-[12.5px]">
        Example only — it disappears when the tour ends. Your real items will appear here.
      </p>
    </div>
  );
}
