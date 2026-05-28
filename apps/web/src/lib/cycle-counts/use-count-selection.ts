'use client';

import * as React from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * The minimal shape we keep about a picked item so the confirm screen can
 * render it (sku / name / type) without re-fetching. The actual snapshot of
 * quantity_on_hand happens server-side at start() time, not here.
 */
export interface CountPick {
  id: string;
  sku: string;
  name: string;
  itemType: 'book' | 'product' | string;
}

interface CountSelectionState {
  picks: Record<string, CountPick>;
  add: (items: CountPick[]) => void;
  remove: (id: string) => void;
  clear: () => void;
}

/**
 * Cross-route selection store for "cycle count by selection". Persisted to
 * sessionStorage so picks survive navigation between the Inventory and Books
 * tabs (and a refresh) — that's what lets one count mix products + books.
 * Cleared once a count is started.
 */
export const useCountSelection = create<CountSelectionState>()(
  persist(
    (set) => ({
      picks: {},
      add: (items) =>
        set((s) => {
          const next = { ...s.picks };
          for (const it of items) next[it.id] = it;
          return { picks: next };
        }),
      remove: (id) =>
        set((s) => {
          const next = { ...s.picks };
          delete next[id];
          return { picks: next };
        }),
      clear: () => set({ picks: {} }),
    }),
    {
      name: 'sp-count-selection',
      storage: createJSONStorage(() => sessionStorage),
    },
  ),
);

/**
 * Picks as an array. Selects the stable `s.picks` reference (it only
 * changes when the store mutates) and derives the array via useMemo.
 *
 * Do NOT inline `useCountSelection((s) => Object.values(s.picks))` — under
 * zustand v5 a selector that returns a fresh array every call produces an
 * uncached useSyncExternalStore snapshot, which React turns into an
 * infinite render loop (minified error #185).
 */
export function useCountPicks(): CountPick[] {
  const picks = useCountSelection((s) => s.picks);
  return React.useMemo(() => Object.values(picks), [picks]);
}
