import type { AdoptionHolds } from './controller';

/**
 * Holds for the appearance only (round 2, finding 10; item 32): a Design
 * adopted from the account (another device changed it, or the first read came
 * late) is not drawn while the person is scanning or counting. The Scan tab
 * and the cycle-count entry screens take a hold while they are focused
 * (use-adoption-hold.ts). Unlike the update pop-up's holds
 * (update-prompt-holds.ts), these hold nothing else: the pop-up may still
 * show over a focused Scan tab, as it always could.
 *
 * A count, not a flag: a count opened from the Scan tab is two holds.
 */
let holds = 0;
const listeners = new Set<() => void>();

function changed(): void {
  for (const fn of [...listeners]) fn();
}

/** Takes a hold. Returns its release, which is safe to call more than once. */
export function holdAppearanceAdoption(_reason: string): () => void {
  holds += 1;
  changed();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    changed();
  };
}

export function isAppearanceAdoptionHeld(): boolean {
  return holds > 0;
}

export function subscribeAppearanceAdoptionHolds(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Held while any source holds; a change in any source tells the subscriber. */
export function combineHolds(...sources: AdoptionHolds[]): AdoptionHolds {
  return {
    isHeld: () => sources.some((source) => source.isHeld()),
    subscribe(listener) {
      const unsubscribes = sources.map((source) => source.subscribe(listener));
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
  };
}
