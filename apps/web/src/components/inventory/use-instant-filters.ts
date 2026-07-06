'use client';

// Instant, coalesced multi-select filter navigation for the inventory /
// books list tables.
//
// THE PROBLEM THIS SOLVES (owner report 2026-07-06): filter checkboxes
// derived their checked state from URL searchParams, and each change
// rode a router.replace → full server round-trip (~3s at 251 SKUs).
// The user got zero feedback until the RSC payload landed, clicked
// repeatedly, and rapid toggles queued stale intermediate navigations.
//
// THE MODEL:
//   • The CONTROL's source of truth is local: `visible` flips
//     synchronously on every set/navigate call (optimistic).
//   • Navigation is COALESCED: edits within `debounceMs` collapse into
//     ONE router.replace carrying the final filter set. The commit
//     always reads the latest desired state from a ref, so
//     last-click-wins by construction — there is no queue of stale
//     intermediate URLs to flap through.
//   • RECONCILIATION: while an edit is unflushed or a navigation is in
//     flight, `visible` keeps showing the user's intent (no snap-back
//     if an older navigation is superseded). Only once idle — no timer,
//     transition settled, and the URL demonstrably moved (or already
//     matches) — does the hook fall back to mirroring searchParams, so
//     the settled URL always equals the visible checkbox state.
//   • isPending (React useTransition) is exposed so the table can show
//     a subtle "updating" treatment instead of freezing, while the
//     current rows stay visible AND interactive.
//
// Kept UI-free and dependency-light so the coalescing/reconciliation
// logic is unit-testable with a plain mock `replace` — see
// use-instant-filters.test.tsx.

import * as React from 'react';

/** The three multi-value filter params the list tables own. */
export type MultiFilterKey = 'cat' | 'loc' | 'charter';

export interface MultiFilterState {
  cat: string[];
  loc: string[];
  charter: string[];
}

export const EMPTY_MULTI_FILTER_STATE: MultiFilterState = {
  cat: [],
  loc: [],
  charter: [],
};

/** Minimal read surface shared by URLSearchParams and Next's
 *  ReadonlyURLSearchParams (what useSearchParams returns). */
export interface SearchParamsLike {
  toString(): string;
  getAll(name: string): string[];
}

const KEYS: readonly MultiFilterKey[] = ['cat', 'loc', 'charter'];

export function readMultiFilterState(params: SearchParamsLike): MultiFilterState {
  return {
    cat: params.getAll('cat').filter(Boolean),
    loc: params.getAll('loc').filter(Boolean),
    charter: params.getAll('charter').filter(Boolean),
  };
}

/** Order-insensitive, duplicate-insensitive (set semantics) equality
 *  across all three keys. */
export function multiFilterStatesEqual(a: MultiFilterState, b: MultiFilterState): boolean {
  return KEYS.every((k) => {
    const as = new Set(a[k]);
    const bs = new Set(b[k]);
    if (as.size !== bs.size) return false;
    for (const id of as) if (!bs.has(id)) return false;
    return true;
  });
}

/** Rewrites `search` in place so its cat/loc/charter params equal `state`. */
export function applyMultiFilterState(search: URLSearchParams, state: MultiFilterState): void {
  for (const k of KEYS) {
    search.delete(k);
    for (const id of state[k]) search.append(k, id);
  }
}

export interface InstantFilters {
  /** What the checkboxes/pills should show RIGHT NOW: the user's
   *  latest intent while edits are pending, the URL state once settled. */
  visible: { cat: Set<string>; loc: Set<string>; charter: Set<string> };
  /** Flip one filter key to a new id set. Instant visually; the
   *  navigation is debounced so rapid toggles coalesce into one. */
  setFilter: (key: MultiFilterKey, ids: Iterable<string>) => void;
  /** Immediate navigation (sort change, clear-all…). Cancels the
   *  debounce timer and FOLDS any unflushed filter edits into the same
   *  single URL so the two intents can't race each other. Pass
   *  `override` to also rewrite the filter state (e.g. clear-all). */
  navigate: (mutate?: (next: URLSearchParams) => void, override?: MultiFilterState) => void;
  /** True while a coalesced navigation's server round-trip is in
   *  flight. Drive the subtle pending treatment off this. */
  isPending: boolean;
}

export function useInstantFilters({
  params,
  basePath,
  replace,
  debounceMs = 300,
}: {
  params: SearchParamsLike;
  basePath: string;
  replace: (url: string) => void;
  debounceMs?: number;
}): InstantFilters {
  const [isPending, startTransition] = React.useTransition();
  // The user's un-settled intent. null = mirror the URL.
  const [desired, setDesiredState] = React.useState<MultiFilterState | null>(null);

  // Latest-value refs so the debounced commit (a timer callback) always
  // reads the CURRENT params/desired state — last-click-wins.
  const desiredRef = React.useRef<MultiFilterState | null>(desired);
  const paramsRef = React.useRef(params);
  const replaceRef = React.useRef(replace);
  const basePathRef = React.useRef(basePath);
  React.useEffect(() => {
    paramsRef.current = params;
    replaceRef.current = replace;
    basePathRef.current = basePath;
  });

  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // params.toString() snapshot taken when a replace() is issued. The
  // settle effect uses it to tell "our navigation landed / something
  // else navigated" (params moved) apart from "still waiting" — without
  // it, a superseded navigation would snap the controls back to the
  // pre-click URL state for a beat.
  const committedFromRef = React.useRef<string | null>(null);

  const setDesired = React.useCallback((next: MultiFilterState | null) => {
    desiredRef.current = next;
    setDesiredState(next);
  }, []);

  const commitNow = React.useCallback(
    (mutate?: (next: URLSearchParams) => void) => {
      const state = desiredRef.current;
      if (!state) return;
      const next = new URLSearchParams(paramsRef.current.toString());
      applyMultiFilterState(next, state);
      mutate?.(next);
      // Filter / sort changes always reset to page 1 — staying on page 5
      // would be wrong if the new result set is shorter.
      next.delete('page');
      const qs = next.toString();
      committedFromRef.current = paramsRef.current.toString();
      startTransition(() => {
        replaceRef.current(qs ? `${basePathRef.current}?${qs}` : basePathRef.current);
      });
    },
    [startTransition],
  );

  const flushDebounced = React.useCallback(() => {
    timerRef.current = null;
    const state = desiredRef.current;
    if (!state) return;
    // Net no-op within the window (A→on→off): skip navigating entirely.
    // This also preserves ?page — the user never actually changed the
    // filter set, so don't yank them back to page 1.
    if (multiFilterStatesEqual(state, readMultiFilterState(paramsRef.current))) {
      setDesired(null);
      return;
    }
    commitNow();
  }, [commitNow, setDesired]);

  const setFilter = React.useCallback(
    (key: MultiFilterKey, ids: Iterable<string>) => {
      const base = desiredRef.current ?? readMultiFilterState(paramsRef.current);
      setDesired({ ...base, [key]: [...ids] });
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flushDebounced, debounceMs);
    },
    [debounceMs, flushDebounced, setDesired],
  );

  const navigate = React.useCallback(
    (mutate?: (next: URLSearchParams) => void, override?: MultiFilterState) => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const state =
        override ?? desiredRef.current ?? readMultiFilterState(paramsRef.current);
      setDesired(state);
      commitNow(mutate);
    },
    [commitNow, setDesired],
  );

  // Clean up the debounce timer on unmount.
  React.useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  // RECONCILE: mirror-from-URL only when idle. While a debounce timer or
  // transition is live, `desired` (the user's intent) keeps driving the
  // controls, so a superseded navigation can never snap them back.
  const paramsString = params.toString();
  React.useEffect(() => {
    if (desired === null) return;
    if (timerRef.current !== null) return; // an edit is still waiting to flush
    if (isPending) return; // our navigation is in flight
    const landed =
      multiFilterStatesEqual(desired, readMultiFilterState(params)) ||
      (committedFromRef.current !== null && committedFromRef.current !== paramsString);
    if (!landed) return; // replace() hasn't moved the URL yet — keep showing intent
    committedFromRef.current = null;
    setDesired(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- params is read via paramsString identity
  }, [desired, isPending, paramsString, setDesired]);

  const urlState = React.useMemo(() => readMultiFilterState(params), [params]);
  const effective = desired ?? urlState;
  const visible = React.useMemo(
    () => ({
      cat: new Set(effective.cat),
      loc: new Set(effective.loc),
      charter: new Set(effective.charter),
    }),
    [effective],
  );

  return { visible, setFilter, navigate, isPending };
}
