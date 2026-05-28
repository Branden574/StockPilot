import * as React from 'react';

/**
 * Cross-screen "cycle count cart" for mobile. A tiny module-level store
 * (no extra dep) backing select-mode on the Items + Books tabs: tapping a
 * row in select mode toggles it here, and the confirm screen reads the
 * accumulated picks. Mirrors the web `useCountSelection` zustand store.
 *
 * Per-id subscription (`useIsPicked`) keeps row re-renders minimal — only
 * the row whose membership changed re-renders, not the whole list.
 */
export interface CountPick {
  id: string;
  sku: string;
  name: string;
  itemType: 'book' | 'product' | string;
}

let picks: Record<string, CountPick> = {};
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const countSelection = {
  toggle(item: CountPick): void {
    const next = { ...picks };
    if (next[item.id]) delete next[item.id];
    else next[item.id] = item;
    picks = next;
    emit();
  },
  add(items: CountPick[]): void {
    const next = { ...picks };
    for (const it of items) next[it.id] = it;
    picks = next;
    emit();
  },
  remove(id: string): void {
    if (!picks[id]) return;
    const next = { ...picks };
    delete next[id];
    picks = next;
    emit();
  },
  clear(): void {
    if (Object.keys(picks).length === 0) return;
    picks = {};
    emit();
  },
  has(id: string): boolean {
    return Boolean(picks[id]);
  },
};

/** All picks as an array. Stable ref between mutations (no render loop). */
export function useCountPicks(): CountPick[] {
  const map = React.useSyncExternalStore(
    subscribe,
    () => picks,
    () => picks,
  );
  return React.useMemo(() => Object.values(map), [map]);
}

/** Just the count — for badges / the select bar. */
export function useCountSelectionCount(): number {
  return React.useSyncExternalStore(
    subscribe,
    () => Object.keys(picks).length,
    () => Object.keys(picks).length,
  );
}

/** Whether a single id is picked — subscribe per-row to avoid list-wide re-renders. */
export function useIsPicked(id: string): boolean {
  const getSnapshot = React.useCallback(() => Boolean(picks[id]), [id]);
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
