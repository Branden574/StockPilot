'use client';

import * as React from 'react';

/** A `change` this soon after a key is that key's doing: Chrome and Edge on
 *  Windows move a CLOSED select's value on an arrow or a letter and fire
 *  `change` in the same task. A change later than this came from a list the
 *  browser drew (macOS, a screen reader, a phone), where the choice is made. */
export const KEY_CHANGE_WINDOW_MS = 100;

/** How a choice was committed: picked in a list, by pointer or touch
 *  ('choice'), by Enter, or by leaving the select with a keyboard draft
 *  ('blur'). */
export type CommitHow = 'choice' | 'enter' | 'blur';

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
 * still browsing (WCAG 3.2.2: no change of context on input). So:
 *   - a keyboard change (a `change` right after an arrow or a letter) only
 *     moves the select's own draft. Nothing is committed while the person,
 *     or a screen reader reading the options aloud, stays on the select,
 *     however long they pause (there is no timer);
 *   - Enter commits the draft, and so does leaving the select: once, with
 *     the last value;
 *   - a choice made in the browser's own list (macOS, where the keyboard
 *     opens the list; a screen reader's list; a phone's picker), a pointer
 *     or touch choice, and a bare `change` commit at once;
 *   - a draft equal to the committed value commits nothing.
 * `onCommit` is told how ('choice', 'enter' or 'blur'), so a choice that
 * opens something (the date preset's Custom range opens the calendar) can
 * refuse to do so merely because focus left the select: returning `false`
 * refuses the choice, and the select goes back to the committed value.
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
  onCommit: (value: T, how: CommitHow) => boolean | void,
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

  // The last key pressed on the select, and when; cleared by a pointer.
  const lastKey = React.useRef<{ key: string; at: number } | null>(null);
  const pending = React.useRef(false);

  const commit = React.useCallback((value: string, how: CommitHow) => {
    pending.current = false;
    const { committed: current } = latest.current;
    if (value === current) return;
    if (latest.current.onCommit(value as T, how) === false) {
      // Refused: the select shows the committed value again.
      setDraft(current);
      latest.current = { ...latest.current, draft: current };
    }
  }, []);

  const onChange = React.useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value;
      setDraft(value);
      latest.current = { ...latest.current, draft: value };
      const key = lastKey.current;
      const byKey = key !== null && performance.now() - key.at < KEY_CHANGE_WINDOW_MS;
      if (byKey && key.key !== 'Enter') {
        // Browsing a closed select: a draft, never a request.
        pending.current = true;
        return;
      }
      commit(value, byKey ? 'enter' : 'choice');
    },
    [commit],
  );

  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLSelectElement>) => {
      lastKey.current = { key: e.key, at: performance.now() };
      if (e.key === 'Enter' && pending.current) commit(latest.current.draft, 'enter');
    },
    [commit],
  );

  const onPointerDown = React.useCallback(() => {
    lastKey.current = null;
  }, []);

  const onBlur = React.useCallback(() => {
    if (pending.current) commit(latest.current.draft, 'blur');
  }, [commit]);

  const reset = React.useCallback(() => {
    pending.current = false;
    setDraft(latest.current.committed);
    latest.current = { ...latest.current, draft: latest.current.committed };
  }, []);

  return { props: { value: draft, onChange, onKeyDown, onPointerDown, onBlur }, reset };
}
