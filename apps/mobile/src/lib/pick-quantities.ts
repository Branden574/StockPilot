/**
 * Pure quantity bookkeeping for the native digital-pick workspace
 * (components/digital-pick.tsx). Kept out of the component so the merge rule —
 * the part that decides whether a picker's typed work survives — is unit-tested
 * without a React Native renderer, exactly like count-picker.ts.
 */

/** The fields of an order line these helpers care about. */
export interface PickLineLike {
  id: string;
  /** order_request_lines.quantity_picked — null until the line is saved. */
  quantity_picked: number | null;
}

/**
 * Rebuild the per-line input map after lines are (re)loaded.
 *
 * `preserveTyped` is the whole point. The workspace holds each line's entered
 * quantity in local state and only persists it on Save or on Complete, so a
 * refresh that re-seeds every line from the server silently destroys work in
 * progress — and because Complete flushes only lines it considers DIRTY, a
 * wiped input then ships that line at zero rather than at what the picker
 * counted. When items are added to the order mid-pick we therefore keep every
 * value the picker has already entered and seed ONLY the lines that are new.
 *
 * A line that has disappeared from the order drops out of the map; its typed
 * value has nowhere to go and keeping it would leak across reloads.
 */
export function mergePickQuantities(
  typed: Readonly<Record<string, string>>,
  lines: readonly PickLineLike[],
  preserveTyped: boolean,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const line of lines) {
    const persisted = line.quantity_picked != null ? Number(line.quantity_picked) : 0;
    const entered = typed[line.id];
    next[line.id] = preserveTyped && entered !== undefined ? entered : String(persisted);
  }
  return next;
}

/**
 * The last-persisted quantity per line. Always taken from the server: it is the
 * baseline `isDirty` compares the typed value against, so preserving a stale
 * copy of it would mark a saved line dirty (or a dirty line saved).
 */
export function seedSavedQuantities(lines: readonly PickLineLike[]): Record<string, number> {
  const saved: Record<string, number> = {};
  for (const line of lines) {
    saved[line.id] = line.quantity_picked != null ? Number(line.quantity_picked) : 0;
  }
  return saved;
}
