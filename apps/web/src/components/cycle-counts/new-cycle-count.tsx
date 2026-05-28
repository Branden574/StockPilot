'use client';

import * as React from 'react';

import { SelectionConfirm, type CountMember } from '@/components/cycle-counts/selection-confirm';
import { StartCycleCountForm } from '@/components/cycle-counts/start-cycle-count-form';
import { useCountPicks } from '@/lib/cycle-counts/use-count-selection';
import { cn } from '@/lib/utils';

type Mode = 'selection' | 'warehouse';

/**
 * Client shell for the New cycle count screen. Two modes:
 *   • selection — count exactly the items picked from the Inventory/Books
 *     lists (read from the sessionStorage-backed count-selection store).
 *   • warehouse — the original "snapshot a whole warehouse / the org" form.
 *
 * Defaults to selection mode when the store has picks, otherwise warehouse.
 * A mounted gate avoids a hydration mismatch (the store rehydrates from
 * sessionStorage on the client, so picks are empty during SSR).
 */
export function NewCycleCount({
  warehouses,
  members,
  canAssign,
}: {
  warehouses: Array<{ id: string; name: string }>;
  members: CountMember[];
  canAssign: boolean;
}) {
  const picks = useCountPicks();
  const [mounted, setMounted] = React.useState(false);
  const [override, setOverride] = React.useState<Mode | null>(null);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- mount flag gates the sessionStorage-backed selection store past hydration
  React.useEffect(() => setMounted(true), []);

  if (!mounted) {
    // Stable placeholder so SSR and first client render agree.
    return <div className="text-muted-foreground text-sm">Loading…</div>;
  }

  const mode: Mode = override ?? (picks.length > 0 ? 'selection' : 'warehouse');

  return (
    <div className="space-y-4">
      <div className="bg-muted/50 inline-flex rounded-md p-0.5 text-sm">
        <TabButton active={mode === 'selection'} onClick={() => setOverride('selection')}>
          Selected items{picks.length > 0 ? ` (${picks.length})` : ''}
        </TabButton>
        <TabButton active={mode === 'warehouse'} onClick={() => setOverride('warehouse')}>
          Whole warehouse
        </TabButton>
      </div>

      {mode === 'selection' ? (
        <SelectionConfirm members={members} canAssign={canAssign} />
      ) : (
        <StartCycleCountForm warehouses={warehouses} />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded px-3 py-1.5 font-medium transition-colors',
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}
