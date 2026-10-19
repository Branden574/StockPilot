'use client';

import * as React from 'react';

import { recountSelectedLabel, recountSelectionProblem } from '@stockpilot/core';

import { RecountDialog } from '@/components/exceptions/recount-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';

/**
 * MULTI-SELECT RECOUNT ON THE EXCEPTIONS LIST (F1-2).
 *
 * The Open list is a server component; this client island holds only the
 * selection. `enabled` is the server's list-level canRecount (a manager with
 * the cycle_counts module, cycle_counts:assign and stock:adjust), and a row
 * offers a checkbox only when the SERVER said that row can be recounted
 * (an open count_variance or over_reserved exception). Everyone else sees the
 * list exactly as before. start_targeted_recount re-checks all of it.
 *
 * Look (DESIGN-SPEC 6.21): each row's box is the shared Checkbox (20 x 20,
 * ink when ticked), and the bar is the bulk bar's card strip, kept in view at
 * the bottom of the list while anything is ticked: "N selected" in mono, the
 * reason it cannot start beside it, Clear and the ink-filled recount button
 * on the right.
 */
/**
 * The selection as a small store, so a tick re-renders only the row whose box
 * changed (and the bar), not every row on the list: the rows read it through
 * useSyncExternalStore with their own yes / no, and the context value never
 * changes. With a context holding the Set, every tick re-rendered every
 * checkbox (201 rows took 30 s in the test; the Open list can hold 1,000).
 */
interface SelectionStore {
  has: (id: string) => boolean;
  toggle: (id: string) => void;
  subscribe: (listener: () => void) => () => void;
}

const SelectionContext = React.createContext<SelectionStore | null>(null);

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
  // The store's own copy, written before the rows are told, so a row reads
  // the new value when it re-renders.
  const current = React.useRef<ReadonlySet<string>>(selected);
  const listeners = React.useRef(new Set<() => void>());
  const commit = React.useCallback((next: ReadonlySet<string>) => {
    current.current = next;
    setSelected(next);
    for (const listener of listeners.current) listener();
  }, []);
  const store = React.useMemo<SelectionStore>(
    () => ({
      has: (id) => current.current.has(id),
      toggle: (id) => {
        const next = new Set(current.current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        commit(next);
      },
      subscribe: (listener) => {
        listeners.current.add(listener);
        return () => {
          listeners.current.delete(listener);
        };
      },
    }),
    [commit],
  );

  if (!enabled) return <>{children}</>;

  const count = selected.size;
  const problem = count > 0 ? recountSelectionProblem(count) : null;
  return (
    <SelectionContext.Provider value={store}>
      {children}
      {count > 0 ? (
        <div
          className="bg-card border-border sticky bottom-4 z-10 mt-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border px-3 py-2 shadow-md sm:px-[18px]"
          data-testid="recount-selection-bar"
        >
          <span className="text-foreground min-w-0 font-mono text-[12.5px] tabular-nums">
            {count} selected
            {problem ? (
              <span className="text-destructive ml-2 font-sans text-xs">{problem}</span>
            ) : null}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" onClick={() => commit(new Set())}>
              Clear
            </Button>
            <Button onClick={() => setOpen(true)} disabled={problem !== null}>
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
        onFinished={() => commit(new Set())}
      />
    </SelectionContext.Provider>
  );
}

/** A row's checkbox. Renders nothing outside an enabled selection. */
export function RecountCheckbox({ occurrenceId, label }: { occurrenceId: string; label: string }) {
  const store = React.useContext(SelectionContext);
  if (!store) return null;
  return <RecountCheckboxBox store={store} occurrenceId={occurrenceId} label={label} />;
}

function RecountCheckboxBox({
  store,
  occurrenceId,
  label,
}: {
  store: SelectionStore;
  occurrenceId: string;
  label: string;
}) {
  const checked = React.useSyncExternalStore(
    store.subscribe,
    () => store.has(occurrenceId),
    () => false,
  );
  return (
    <Checkbox
      checked={checked}
      onCheckedChange={() => store.toggle(occurrenceId)}
      label={`Select ${label} to recount`}
      data-testid="recount-checkbox"
    />
  );
}

/** One exception's Recount button (its page). */
export function RecountButton({
  occurrenceId,
  reference,
  timeZone,
  variant = 'outline',
  size = 'sm',
  className,
}: {
  occurrenceId: string;
  reference: string | null;
  timeZone: string;
  /** Filled where it is the one action that closes the exception (a count
   *  difference's "What clears this" card with no Confirm offered). */
  variant?: 'default' | 'outline';
  size?: 'sm' | 'default';
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={className}
        onClick={() => setOpen(true)}
        data-testid="recount-button"
        data-variant={variant}
      >
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
