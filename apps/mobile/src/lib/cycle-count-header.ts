import { cycleCountScopeLabel, formatCycleCountNumber } from '@stockpilot/core';

/**
 * The count screen's header (app/cycle-count/[id].tsx), decided here so it
 * is tested.
 *
 * NOTHING ABOUT A COUNT BEFORE IT IS KNOWN. The screen used to render its
 * header from a count it had not read yet: "Cycle count / Reference
 * unavailable / No single warehouse · 0/0 counted", with a Reassign button,
 * for 1 to 2 seconds before a posted count loaded as CC-000001, 4/4 counted
 * (simulator walk 2026-09-27, opened from the verification card). Those were
 * unknown facts shown as if true, and an open count's action on a closed one.
 * Until the count is known, the header says it is loading and nothing else.
 */

export const CYCLE_COUNT_LOADING_COPY = 'Loading this count...';

/** The header facts the screen holds (the phone's cache row). */
export interface CycleCountHeaderFacts {
  countNumber?: number | null;
  warehouseId: string | null;
  warehouseName: string | null;
  status: string;
}

export type CycleCountHeaderView =
  /** Not read yet: say so, state nothing about the count. */
  | { kind: 'loading'; text: string }
  /** The read ended without a count: still nothing made up. */
  | { kind: 'unknown' }
  | {
      kind: 'known';
      /** "CC-000042", or null for a row cached before the number arrived
       *  (the screen says "Reference unavailable"). */
      reference: string | null;
      place: string;
      progress: string;
    };

export function cycleCountHeaderView(
  header: CycleCountHeaderFacts | null,
  o: { loading: boolean; scope: string | null; countedCount: number; lineTotal: number },
): CycleCountHeaderView {
  if (!header) {
    return o.loading ? { kind: 'loading', text: CYCLE_COUNT_LOADING_COPY } : { kind: 'unknown' };
  }
  // The scope arrives with the server read; from the cache alone, the
  // header's own warehouse.
  const place = o.scope
    ? cycleCountScopeLabel({
        warehouseId: header.warehouseId,
        warehouseName: header.warehouseName,
        scope: o.scope,
      })
    : (header.warehouseName ?? (header.warehouseId ? '—' : 'No single warehouse'));
  return {
    kind: 'known',
    reference: formatCycleCountNumber(header.countNumber),
    place,
    progress: `${o.countedCount}/${o.lineTotal} counted`,
  };
}

/** Only a count known to be in progress is open (editable, postable,
 *  releasable, reassignable). A count still loading is not. */
export function cycleCountIsOpen(header: Pick<CycleCountHeaderFacts, 'status'> | null): boolean {
  return header !== null && header.status === 'in_progress';
}
