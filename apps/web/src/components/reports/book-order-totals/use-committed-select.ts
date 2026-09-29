'use client';

import * as React from 'react';

/** A keyboard choice settles for this long after the last key before it
 *  counts (unless Enter or leaving the select commits it sooner). */
export const COMMITTED_SELECT_IDLE_MS = 400;

export interface CommittedSelectProps {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLSelectElement>) => void;
  onPointerDown: () => void;
  onBlur: () => void;
}

/**
 * ONE REQUEST PER CHOICE (plan D16). Every select in the report's filter bar
 * goes through this hook: Charter, Orders placed, Warehouse, Category and
 * Sort (a select added later must too; filter-bar.test.tsx sweeps them all).
 *
 * On Windows, Chrome and Edge fire `change` on a CLOSED select for every
 * arrow key, so arrowing past fifteen charters would be fifteen server
 * renders and fifteen reads, and the page would change under someone who is
 * still browsing (WCAG 3.2.2). So:
 *   - a pointer or touch choice commits at once (as before; so does a bare
 *     `change` with no key before it);
 *   - a keyboard change only moves the select's own draft, and commits on
 *     Enter, when focus leaves the select, or COMMITTED_SELECT_IDLE_MS after
 *     the last key: once, with the last value;
 *   - a draft equal to the committed value commits nothing.
 * On macOS the keyboard opens the menu and Enter there fires one `change`,
 * so that is one commit either way (at most the idle time later).
 *
 * The select shows the draft. When the committed value changes from outside
 * (an answer lands, Back, a chip), the draft follows it (derived state, reset
 * during render, as in report-navigation.tsx).
 *
 * `reset()` puts the draft back on the committed value (the date preset's
 * Cancel, after "Custom range" opened the calendar without navigating).
 */
export function useCommittedSelect<T extends string>(
  committed: T,
  onCommit: (value: T) => void,
): { props: CommittedSelectProps; reset: () => void } {
  const [draft, setDraft] = React.useState<string>(committed);
  const [seen, setSeen] = React.useState<string>(committed);
  if (seen !== committed) {
    setSeen(committed);
    setDraft(committed);
  }

  // What the handlers need, kept current after every render (never written
  // or read during render).
  const latest = React.useRef({ committed, onCommit, draft });
  React.useEffect(() => {
    latest.current = { committed, onCommit, draft };
  });

  const source = React.useRef<'pointer' | 'keyboard' | null>(null);
  const pending = React.useRef(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = React.useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  React.useEffect(() => clearTimer, [clearTimer]);

  const commit = React.useCallback(
    (value: string) => {
      clearTimer();
      pending.current = false;
      if (value === latest.current.committed) return;
      latest.current.onCommit(value as T);
    },
    [clearTimer],
  );

  const arm = React.useCallback(() => {
    clearTimer();
    timer.current = setTimeout(() => {
      timer.current = null;
      if (pending.current) commit(latest.current.draft);
    }, COMMITTED_SELECT_IDLE_MS);
  }, [clearTimer, commit]);

  const onChange = React.useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value;
      setDraft(value);
      latest.current = { ...latest.current, draft: value };
      if (source.current === 'keyboard') {
        pending.current = true;
        arm();
        return;
      }
      commit(value);
    },
    [arm, commit],
  );

  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLSelectElement>) => {
      source.current = 'keyboard';
      if (e.key === 'Enter') {
        if (pending.current) commit(latest.current.draft);
        return;
      }
      // "After the last key": a key that moves nothing still restarts the
      // wait for a draft that is already pending.
      if (pending.current) arm();
    },
    [arm, commit],
  );

  const onPointerDown = React.useCallback(() => {
    source.current = 'pointer';
  }, []);

  const onBlur = React.useCallback(() => {
    if (pending.current) commit(latest.current.draft);
  }, [commit]);

  const reset = React.useCallback(() => {
    clearTimer();
    pending.current = false;
    setDraft(latest.current.committed);
    latest.current = { ...latest.current, draft: latest.current.committed };
  }, [clearTimer]);

  return { props: { value: draft, onChange, onKeyDown, onPointerDown, onBlur }, reset };
}
