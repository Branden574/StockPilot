'use client';

import * as React from 'react';

import { SelectionConfirm, type CountMember } from '@/components/cycle-counts/selection-confirm';
import { StartCycleCountForm } from '@/components/cycle-counts/start-cycle-count-form';
import { SegmentedTabs } from '@/components/patterns/segmented-tabs';
import { useCountPicks } from '@/lib/cycle-counts/use-count-selection';

type Mode = 'selection' | 'warehouse';

/**
 * Client shell for the New cycle count screen. Two modes:
 *   • selection — pick the exact items to count with the embedded
 *     Inventory/Books picker (searches in place; also reads any picks
 *     made via the Items/Books pages' select-mode from the shared
 *     sessionStorage-backed count-selection store).
 *   • warehouse — the original "snapshot a whole warehouse / the org" form.
 *
 * Defaults to selection mode when the store has picks, otherwise warehouse.
 * A mounted gate avoids a hydration mismatch (the store rehydrates from
 * sessionStorage on the client, so picks are empty during SSR).
 *
 * The two modes are a segmented switch (DESIGN-SPEC 6.5): two buttons that
 * say which one is chosen (aria-pressed), the same two words as always.
 */
export function NewCycleCount({
  warehouses,
  members,
  canAssign,
  sportsEnabled = false,
}: {
  warehouses: Array<{ id: string; name: string }>;
  members: CountMember[];
  canAssign: boolean;
  /** Org has the sports module — unlocks counting by product group. */
  sportsEnabled?: boolean;
}) {
  const picks = useCountPicks();
  const [mounted, setMounted] = React.useState(false);
  const [override, setOverride] = React.useState<Mode | null>(null);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- mount flag gates the sessionStorage-backed selection store past hydration
  React.useEffect(() => setMounted(true), []);

  if (!mounted) {
    // Stable placeholder so SSR and first client render agree.
    return <div className="text-muted-foreground text-[13px]">Loading…</div>;
  }

  const mode: Mode = override ?? (picks.length > 0 ? 'selection' : 'warehouse');

  return (
    <div className="flex flex-col gap-4">
      <SegmentedTabs
        semantics="nav"
        aria-label="Scope"
        activeId={mode}
        items={[
          {
            id: 'selection',
            label: `Selected items${picks.length > 0 ? ` (${picks.length})` : ''}`,
          },
          { id: 'warehouse', label: 'Whole warehouse' },
        ]}
        onSelect={(id) => setOverride(id === 'selection' ? 'selection' : 'warehouse')}
      />

      {mode === 'selection' ? (
        <SelectionConfirm
          members={members}
          canAssign={canAssign}
          warehouses={warehouses}
          sportsEnabled={sportsEnabled}
        />
      ) : (
        <StartCycleCountForm warehouses={warehouses} />
      )}
    </div>
  );
}
