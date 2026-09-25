'use client';

import * as React from 'react';

import { recountSelectedLabel, recountSelectionProblem } from '@stockpilot/core';

import { RecountDialog } from '@/components/exceptions/recount-dialog';
import { Button } from '@/components/ui/button';

/**
 * MULTI-SELECT RECOUNT ON THE EXCEPTIONS LIST (F1-2).
 *
 * The Open list is a server component; this client island holds only the
 * selection. `enabled` is the server's list-level canRecount (a manager with
 * the cycle_counts module, cycle_counts:assign and stock:adjust), and a row
 * offers a checkbox only when the SERVER said that row can be recounted
 * (an open count_variance or over_reserved exception). Everyone else sees the
 * list exactly as before. start_targeted_recount re-checks all of it.
 */
interface SelectionState {
  selected: ReadonlySet<string>;
  toggle: (id: string) => void;
}

const SelectionContext = React.createContext<SelectionState | null>(null);

export function RecountSelectionProvider({
  enabled,
  timeZone,
  children,
}: {
  enabled: boolean;
  timeZone: string;
  children: React.ReactNode;
}) {
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(() => new Set());
  const [open, setOpen] = React.useState(false);
  const toggle = React.useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const value = React.useMemo(() => ({ selected, toggle }), [selected, toggle]);

  if (!enabled) return <>{children}</>;

  const count = selected.size;
  const problem = count > 0 ? recountSelectionProblem(count) : null;
  return (
    <SelectionContext.Provider value={value}>
      {children}
      {count > 0 ? (
        <div
          className="bg-card border-border sticky bottom-4 z-10 mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 shadow-md"
          data-testid="recount-selection-bar"
        >
          <span className="text-sm tabular-nums">
            {count} selected
            {problem ? <span className="text-destructive ml-2 text-xs">{problem}</span> : null}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            <Button size="sm" onClick={() => setOpen(true)} disabled={problem !== null}>
              {recountSelectedLabel(count)}
            </Button>
          </div>
        </div>
      ) : null}
      <RecountDialog
        open={open}
        onOpenChange={setOpen}
        title={`Recount ${count} exception${count === 1 ? '' : 's'}`}
        occurrenceIds={[...selected]}
        timeZone={timeZone}
        onFinished={() => setSelected(new Set())}
      />
    </SelectionContext.Provider>
  );
}

/** A row's checkbox. Renders nothing outside an enabled selection. */
export function RecountCheckbox({ occurrenceId, label }: { occurrenceId: string; label: string }) {
  const ctx = React.useContext(SelectionContext);
  if (!ctx) return null;
  return (
    <input
      type="checkbox"
      className="accent-primary mt-3 size-4 shrink-0"
      checked={ctx.selected.has(occurrenceId)}
      onChange={() => ctx.toggle(occurrenceId)}
      aria-label={`Select ${label} to recount`}
      data-testid="recount-checkbox"
    />
  );
}

/** One exception's Recount button (its page). */
export function RecountButton({
  occurrenceId,
  reference,
  timeZone,
}: {
  occurrenceId: string;
  reference: string | null;
  timeZone: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="recount-button">
        Recount
      </Button>
      <RecountDialog
        open={open}
        onOpenChange={setOpen}
        title={reference ? `Recount for ${reference}` : 'Recount'}
        occurrenceIds={[occurrenceId]}
        timeZone={timeZone}
      />
    </>
  );
}
