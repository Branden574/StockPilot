import { poOutstanding, type PoRunLine } from '../../../../lib/po-size-run';

/**
 * The arithmetic of the PO receive screen's Liquid Glass parts (screens/po.tsx),
 * kept apart from the components so the node test runner can read it.
 */

/** The screen's draft: what is typed in each line's Received box (DraftLine.received). */
export type DraftReceived = Readonly<Record<string, { readonly received: string } | undefined>>;

/** The typed Received text of each of these lines ('' when nothing is typed). */
export function receivedOf(
  lines: readonly { id: string }[],
  draft: DraftReceived,
): Record<string, string> {
  const m: Record<string, string> = {};
  for (const l of lines) m[l.id] = draft[l.id]?.received ?? '';
  return m;
}

/** The sizes per grid block: the board draws five across a 390pt phone. */
export const SIZES_PER_BLOCK = 5;

/** A run's sizes in blocks of at most five, in the run's own size order. */
export function sizeBlocks<T>(lines: readonly T[], per = SIZES_PER_BLOCK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < lines.length; i += per) out.push(lines.slice(i, i + per));
  return out;
}

/**
 * What is left of a size after this receipt, as the board's Left row shows
 * it: the outstanding quantity less what is typed now; over the outstanding
 * quantity it reads "+N" in the danger tone. A box with nothing (or nothing
 * a receipt would take) typed leaves the outstanding quantity.
 */
export function sizeLeft(
  line: PoRunLine,
  typed: string | undefined,
): { text: string; tone: 'ok' | 'warn' | 'danger' } {
  const outstanding = poOutstanding(line);
  const n = Number(typed);
  const now = Number.isFinite(n) && n > 0 ? n : 0;
  const left = outstanding - now;
  if (left < 0) return { text: `+${-left}`, tone: 'danger' };
  return { text: String(left), tone: left === 0 ? 'ok' : 'warn' };
}

/** Units in this receipt and what is left after it, from the lines and the draft. */
export function receiptTotals(
  lines: readonly PoRunLine[],
  draft: DraftReceived,
): { units: number; stillToCome: number } {
  let units = 0;
  let stillToCome = 0;
  for (const l of lines) {
    const n = Number(draft[l.id]?.received);
    const now = Number.isFinite(n) && n > 0 ? n : 0;
    units += now;
    stillToCome += Math.max(0, poOutstanding(l) - now);
  }
  return { units, stillToCome };
}
