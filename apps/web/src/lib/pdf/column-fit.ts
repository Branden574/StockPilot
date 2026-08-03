/**
 * Column width allocation for the StockPilot PDF tables.
 *
 * WHY THIS EXISTS: report-table.tsx used to hand every cell
 * `{ flex: weight / totalWeight }` and let yoga divide the row. That is a pure
 * ratio split with no floor, so a column with a small weight gets an
 * arbitrarily thin box and @react-pdf overflows it silently rather than
 * erroring — which is how "ON HAND" and "CATEGORY" ended up printed as
 * "ON HANDCATEGORY" in the owner's Books export.
 *
 * Explicit point widths computed here (and applied as `width` on each cell)
 * make the geometry deterministic and unit-testable against Helvetica AFM
 * metrics. No @react-pdf import: the export builder's browser-side dialog
 * imports this module too, for its column-count warning.
 */

export interface FitColumn {
  key: string;
  /** Relative weight. Default 1. Only decides how SURPLUS width is shared. */
  width?: number;
  /** Hard floor in points. The column never renders narrower than this unless
   *  the minimums as a whole cannot fit, in which case all of them scale down
   *  together (see below). */
  minWidth?: number;
  /** Ceiling in points. Useful for narrow numerics that gain nothing from
   *  extra space (a 3-digit quantity in a 120pt box just looks broken). */
  maxWidth?: number;
}

// Page geometry of the shared landscape-LETTER report table.
//   792pt page - 40pt page padding each side  = 712pt content
//   712pt      - 4pt  row  padding each side  = 704pt inner row width
export const REPORT_PAGE_PADDING_PT = 40;
export const REPORT_ROW_PADDING_PT = 4;
export const REPORT_CELL_PADDING_PT = 3;
export const REPORT_IMAGE_COL_WIDTH_PT = 22;
export const REPORT_IMAGE_COL_GAP_PT = 4;
export const LETTER_LANDSCAPE_CONTENT_WIDTH_PT =
  792 - REPORT_PAGE_PADDING_PT * 2 - REPORT_ROW_PADDING_PT * 2;

/**
 * Allocate `availableWidthPt` across `columns`, in order.
 *
 * 1. If the minimums alone exceed the page, scale every minimum by the same
 *    factor. Every column stays present and proportionate, and the total still
 *    fits — the caller is responsible for warning the user (Brief section 13:
 *    "block only when nothing readable is possible").
 * 2. Otherwise share the width by weight, clamping to [minWidth, maxWidth] and
 *    re-sharing what a clamped column gave back or took, until stable.
 *
 * The returned array has one width per input column and sums to at most
 * `availableWidthPt`.
 */
export function fitColumnWidths(
  columns: readonly FitColumn[],
  availableWidthPt: number,
): number[] {
  const n = columns.length;
  if (n === 0) return [];
  if (availableWidthPt <= 0) return columns.map(() => 0);

  const mins = columns.map((c) => Math.max(0, c.minWidth ?? 0));
  const totalMin = mins.reduce((a, b) => a + b, 0);
  if (totalMin >= availableWidthPt) {
    const scale = availableWidthPt / totalMin;
    return mins.map((m) => m * scale);
  }

  const weights = columns.map((c) => {
    const w = c.width ?? 1;
    return w > 0 ? w : 0;
  });
  const out = new Array<number>(n).fill(0);
  const locked = new Array<boolean>(n).fill(false);
  let remaining = availableWidthPt;

  // A pass can lock more than one column at once (every free column whose
  // share misses its clamp in the same pass locks together, before
  // freeWeight/remaining are recomputed) — this loop does not lock exactly
  // one per iteration. The n + 1 bound still holds worst-case: each pass
  // that makes progress locks at least one previously-free column, and
  // there are only n columns to lock, so at most n passes can change
  // anything before the (n+1)th pass finds nothing left to do and exits via
  // `if (!changed) break`.
  for (let pass = 0; pass <= n; pass++) {
    const free: number[] = [];
    let freeWeight = 0;
    for (let i = 0; i < n; i++) {
      if (!locked[i]) {
        free.push(i);
        freeWeight += weights[i]!;
      }
    }
    if (free.length === 0) break;

    let changed = false;
    for (const i of free) {
      const share =
        freeWeight > 0 ? (weights[i]! / freeWeight) * remaining : remaining / free.length;
      const min = mins[i]!;
      const max = columns[i]!.maxWidth ?? Number.POSITIVE_INFINITY;
      if (share < min) {
        out[i] = min;
        locked[i] = true;
        remaining -= min;
        changed = true;
      } else if (share > max) {
        out[i] = max;
        locked[i] = true;
        remaining -= max;
        changed = true;
      } else {
        out[i] = share;
      }
    }
    if (!changed) break;
  }

  return out;
}
