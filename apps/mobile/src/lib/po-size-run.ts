/**
 * Size-run layout for the native PO receive screen — the mobile half of Task
 * 16, kept as a pure module so it is unit-testable without Expo.
 *
 * The GROUPING RULE and the SIZE ORDER both come from `@stockpilot/core`, the
 * same two functions the web receive dialog calls. That is the point: web and
 * Expo must not be able to disagree about what a size run is or what order its
 * sizes go in.
 *
 * Nothing here touches quantities on the way to the server. Each size still
 * posts as its own `p_lines` entry, so `post_receipt_v2` sees exactly the
 * recordset it sees today.
 */

import {
  buildSizeOrder,
  countingUnitLabel,
  splitIntoSizeRuns,
  type CountingUnit,
  type SizeRunBlock,
  type SizeScaleValueOrder,
} from '@stockpilot/core';

/** A PO line as the native screen holds it, plus the two 0298 variant columns. */
export interface PoRunLine {
  id: string;
  quantity_ordered: number;
  quantity_received: number;
  groupId: string | null;
  variantSize: string | null;
}

/** Display metadata for one product group, read off `product_groups`. */
export interface PoRunGroup {
  name: string;
  /**
   * `product_groups.default_counting_unit`. READ, never inferred — PAIR is a
   * display convention with no conversion behind it.
   */
  countingUnit: CountingUnit;
  /** The group's `size_scale_values` rows, when its category carries a scale. */
  sizeValues?: SizeScaleValueOrder[];
}

export type PoBlock<T extends PoRunLine = PoRunLine> = SizeRunBlock<T>;

/**
 * Lay the PO's lines out as runs and loose rows.
 *
 * Generic over the line type so the screen keeps its own richer `PoLine`
 * (item embed, unit cost) all the way through the blocks — the loose branch
 * still renders the full card.
 *
 * A group whose metadata did NOT resolve degrades to loose rows: without the
 * group we cannot name its counting unit, and inventing "each" would print a
 * number that means something different from what the group says it means.
 */
export function buildPoBlocks<T extends PoRunLine>(
  lines: readonly T[],
  groups: Readonly<Record<string, PoRunGroup>>,
): PoBlock<T>[] {
  const orderCache = new Map<string, ReturnType<typeof buildSizeOrder>>();
  const blocks = splitIntoSizeRuns(lines, (groupId) => {
    const cached = orderCache.get(groupId);
    if (cached) return cached;
    const built = buildSizeOrder(groups[groupId]?.sizeValues ?? []);
    orderCache.set(groupId, built);
    return built;
  });

  const out: PoBlock<T>[] = [];
  for (const b of blocks) {
    if (b.kind === 'run' && !groups[b.groupId]) {
      for (const l of b.lines) out.push({ kind: 'loose', groupId: null, lines: [l] });
      continue;
    }
    out.push(b);
  }
  return out;
}

/** How much of a run is being received right now, and across how many sizes. */
export function poRunSubtotal(
  lines: readonly PoRunLine[],
  received: Readonly<Record<string, string | undefined>>,
): { quantity: number; sizes: number } {
  let quantity = 0;
  let sizes = 0;
  for (const l of lines) {
    // The draft holds raw text straight off a TextInput: '' and 'abc' are both
    // "nothing entered", and a negative can never be part of a receipt.
    const n = Number(received[l.id]);
    if (!Number.isFinite(n) || n <= 0) continue;
    quantity += n;
    sizes += 1;
  }
  return { quantity, sizes };
}

/** The run footer, in the group's own counting unit. */
export function poRunSubtotalLabel(
  subtotal: { quantity: number; sizes: number },
  countingUnit: CountingUnit,
): string {
  if (subtotal.sizes === 0) return 'Nothing entered yet for this run.';
  const unit = countingUnitLabel(countingUnit, subtotal.quantity);
  const sizeWord = subtotal.sizes === 1 ? 'size' : 'sizes';
  return `Receiving ${subtotal.quantity} ${unit} across ${subtotal.sizes} ${sizeWord}`;
}

/** The size cell. A variant with no size gets a label, never a blank. */
export function poSizeLabel(variantSize: string | null | undefined): string {
  const s = variantSize?.trim();
  return s && s.length > 0 ? s : 'No size';
}

/** Outstanding quantity for one line. Never negative. */
export function poOutstanding(line: PoRunLine): number {
  return Math.max(0, line.quantity_ordered - line.quantity_received);
}
