/**
 * KEEP THE FOCUSED NOTE IN VIEW IN A SHEET'S SCROLLING BODY (R1 walk,
 * 2026-09-29, iPhone 17 at AX5).
 *
 * The exception sheets size their body to the space the keyboard leaves
 * (exception-sheet-layout.ts), so the title, Close and the buttons stay on
 * screen. But the keyboard comes up AFTER the note takes focus: iOS scrolls
 * the note into the body as it is at that moment, then the body loses about
 * 190 pt from its bottom and keeps its scroll offset, and the note falls out
 * of view (0 of 94 pt when the person tapped the field as soon as it showed,
 * 84 of 94 after scrolling it fully into view first). React Native's own
 * keyboard inset adjustment (automaticallyAdjustKeyboardInsets) is worked out
 * against the body's frame from before that re-layout, so it cannot help.
 *
 * So, while the note has focus, the body is scrolled to show it whenever its
 * window changes size (the keyboard's space measured), when the keyboard has
 * finished showing, and when the note takes focus:
 *   - the whole note block (label, field, counter) when it fits, else the
 *     field alone, moving no further than needed, with an 8 pt margin that
 *     gives way first when the room is tight;
 *   - a window shorter than the field shows the field from its first line,
 *     where the caret of a new note is;
 *   - never on a layout that only moves the content (typing that grows the
 *     field): iOS keeps the caret in view while the person types, and a
 *     second scroller would fight it.
 * Pure, so it is tested without a device; lib/use-sheet-keyboard.ts wires it
 * to a ScrollView.
 */

/** Space kept between the note and the body's edge, in points. */
export const REVEAL_MARGIN = 8;

export interface RevealSpan {
  /** From the top of the body's content, in points. */
  top: number;
  height: number;
}

function finite(n: number): boolean {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * The scroll offset that shows the note, or null when it already shows (or
 * there is no window to show it in).
 */
export function revealScrollOffset(input: {
  /** The body's scroll offset now. */
  offset: number;
  /** The body's visible height. */
  viewport: number;
  /** The body's content height (0 when not reported yet). */
  contentHeight: number;
  /** The note's block: its label, the field and its counter. */
  block: RevealSpan;
  /** The field itself. */
  field: RevealSpan;
  margin?: number;
}): number | null {
  const { viewport, block, field } = input;
  const m = input.margin ?? REVEAL_MARGIN;
  if (!finite(viewport) || viewport <= 0) return null;
  if (![block.top, block.height, field.top, field.height].every(finite)) return null;
  const offset = finite(input.offset) ? input.offset : 0;
  // The note is inside the content, so the content is at least that tall.
  const content = Math.max(
    finite(input.contentHeight) ? input.contentHeight : 0,
    block.top + block.height,
    field.top + field.height,
  );
  const maxOffset = Math.max(0, content - viewport);
  const fits = (s: RevealSpan) => s.height <= viewport;
  const target = fits(block) ? block : fits(field) ? field : null;
  let y: number;
  if (target) {
    // The margin gives way before the note does: a block that fits only
    // just (192 pt in 202 at AX5) shows whole, with what room is left.
    const gap = Math.min(m, (viewport - target.height) / 2);
    const top = target.top - gap;
    const bottom = target.top + target.height + gap;
    if (top < offset) y = top;
    else if (bottom > offset + viewport) y = bottom - viewport;
    else return null;
  } else {
    y = field.top - m;
  }
  y = Math.round(Math.min(maxOffset, Math.max(0, y)));
  return Math.abs(y - offset) < 1 ? null : y;
}

/**
 * The measurements a sheet's body reports, and when to scroll. `scrollTo`
 * moves the body (the hook passes the ScrollView's animated scrollTo).
 */
export function createFieldRevealer(scrollTo: (y: number) => void, margin: number = REVEAL_MARGIN) {
  let focused = false;
  let offset = 0;
  let viewport = 0;
  let content = 0;
  let block: RevealSpan | null = null;
  // The field's place inside its block (onLayout reports it relative to the
  // block, which sits directly in the body's content).
  let fieldInBlock: RevealSpan | null = null;

  function reveal(): void {
    if (!focused || !block || !fieldInBlock) return;
    const y = revealScrollOffset({
      offset,
      viewport,
      contentHeight: content,
      block,
      field: { top: block.top + fieldInBlock.top, height: fieldInBlock.height },
      margin,
    });
    if (y === null) return;
    offset = y;
    scrollTo(y);
  }

  return {
    /** The note took focus. */
    focus(): void {
      focused = true;
      reveal();
    },
    /** The note lost focus (the keyboard was put away, or the sheet sent). */
    blur(): void {
      focused = false;
    },
    /** The body scrolled (by the person, or by reveal). */
    scrolled(y: number): void {
      if (finite(y)) offset = y;
    },
    /** The body's visible height; a change while the note has focus reveals it. */
    viewportChanged(height: number): void {
      if (!finite(height)) return;
      const changed = Math.abs(height - viewport) >= 0.5;
      viewport = height;
      if (changed) reveal();
    },
    /** The body's content height. Never scrolls by itself. */
    contentChanged(height: number): void {
      if (finite(height)) content = height;
    },
    /** Where the note's block sits in the body's content. Never scrolls by itself. */
    blockLaid(top: number, height: number): void {
      if (finite(top) && finite(height)) block = { top, height };
    },
    /** Where the field sits in its block. Never scrolls by itself. */
    fieldLaid(top: number, height: number): void {
      if (finite(top) && finite(height)) fieldInBlock = { top, height };
    },
    /** The keyboard has finished showing: a backup for a body whose size did not change. */
    keyboardShown(): void {
      reveal();
    },
  };
}

export type FieldRevealer = ReturnType<typeof createFieldRevealer>;
