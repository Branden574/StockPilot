import { createFieldRevealer, REVEAL_MARGIN, type RevealSpan } from './sheet-field-reveal';

/**
 * KEEP THE FOCUSED FIELD IN VIEW WHEN A SHEET HAS SEVERAL (the F2-5 draft
 * sheet: one quantity field per short item).
 *
 * The exception sheets have one note field, and lib/sheet-field-reveal.ts
 * keeps it in view as the keyboard takes the body's space (see there for the
 * walk that found it). This is the same revealer, told which field has focus:
 * each row (a block directly in the body's content, holding the item's
 * checkbox, its quantity field and the field's problem) reports where it sits
 * and where its field sits inside it, keyed by the item; when a field takes
 * focus, its row's measurements are the ones the revealer uses, so it is that
 * row that is scrolled back into view whenever the body's window changes, once
 * the keyboard has shown, and on focus. A row that lays out again while its
 * field has focus updates the revealer; the others are only remembered.
 *
 * Pure, so it is tested without a device; lib/use-sheet-keyboard-fields.ts
 * wires it to a ScrollView.
 */
export function createFieldsRevealer(scrollTo: (y: number) => void, margin: number = REVEAL_MARGIN) {
  const revealer = createFieldRevealer(scrollTo, margin);
  const blocks = new Map<string, RevealSpan>();
  const fields = new Map<string, RevealSpan>();
  let focused: string | null = null;

  function finite(n: number): boolean {
    return typeof n === 'number' && Number.isFinite(n);
  }

  return {
    /** The body scrolled (by the person, or by a reveal). */
    scrolled(y: number): void {
      revealer.scrolled(y);
    },
    /** The body's visible height; a change while a field has focus reveals it. */
    viewportChanged(height: number): void {
      revealer.viewportChanged(height);
    },
    /** The body's content height. Never scrolls by itself. */
    contentChanged(height: number): void {
      revealer.contentChanged(height);
    },
    /** Where a row sits in the body's content. Never scrolls by itself. */
    blockLaid(key: string, top: number, height: number): void {
      if (!finite(top) || !finite(height)) return;
      blocks.set(key, { top, height });
      if (focused === key) revealer.blockLaid(top, height);
    },
    /** Where a row's field sits in the row. Never scrolls by itself. */
    fieldLaid(key: string, top: number, height: number): void {
      if (!finite(top) || !finite(height)) return;
      fields.set(key, { top, height });
      if (focused === key) revealer.fieldLaid(top, height);
    },
    /** A row's field took focus: its row is the one kept in view. */
    focus(key: string): void {
      focused = key;
      const b = blocks.get(key);
      const f = fields.get(key);
      if (b) revealer.blockLaid(b.top, b.height);
      if (f) revealer.fieldLaid(f.top, f.height);
      revealer.focus();
    },
    /** A row's field lost focus. Another field's focus is left alone (iOS
     *  may report the next field's focus before this one's blur). */
    blur(key: string): void {
      if (focused !== key) return;
      focused = null;
      revealer.blur();
    },
    /** The keyboard has finished showing: a backup for a body whose size did not change. */
    keyboardShown(): void {
      revealer.keyboardShown();
    },
  };
}

export type FieldsRevealer = ReturnType<typeof createFieldsRevealer>;
