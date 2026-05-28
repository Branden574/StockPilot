'use client';

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

/** Selector: picks as an array (stable enough for list rendering). */
export const selectCountList = (s: CountSelectionState): CountPick[] => Object.values(s.picks);
