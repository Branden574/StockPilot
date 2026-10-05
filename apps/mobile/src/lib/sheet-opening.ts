/**
 * Which opening of a modal sheet this is (L101). A sheet whose content is
 * keyed on this count remounts once per opening (every opening starts blank)
 * and never while it closes or switches mode in place. Keying on
 * `${visible}:${mode}` remounted the content as the sheet slid out, which
 * showed another mode's form for a frame.
 *
 * Pure, so the component holds it in state and updates it while rendering
 * (React's "adjust state when a prop changes" pattern): the same object back
 * when nothing changed, so no update loops.
 */
export interface SheetOpening {
  visible: boolean;
  count: number;
}

export function sheetOpeningAfter(prev: SheetOpening, visible: boolean): SheetOpening {
  if (prev.visible === visible) return prev;
  return { visible, count: visible ? prev.count + 1 : prev.count };
}
