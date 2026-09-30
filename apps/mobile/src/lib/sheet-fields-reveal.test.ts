import { describe, expect, it, vi } from 'vitest';

import { REVEAL_MARGIN } from './sheet-field-reveal';
import { createFieldsRevealer } from './sheet-fields-reveal';

/**
 * THE FOCUSED QUANTITY STAYS IN VIEW (F2-5 draft sheet: one field per short
 * item). The same revealer as the exception sheets' note
 * (sheet-field-reveal.test.ts), told which row's field has focus.
 *
 * A body 400 pt tall (keyboard down) that loses 190 pt to the keyboard; three
 * rows of 150 pt, each with its field 70 pt down, 44 pt tall.
 */
const ROWS = {
  a: { top: 0, height: 150 },
  b: { top: 162, height: 150 },
  c: { top: 324, height: 150 },
};
const FIELD = { top: 70, height: 44 };
const CONTENT = 520;

function laidOut() {
  const scrollTo = vi.fn();
  const r = createFieldsRevealer(scrollTo);
  r.contentChanged(CONTENT);
  for (const [key, span] of Object.entries(ROWS)) {
    r.blockLaid(key, span.top, span.height);
    r.fieldLaid(key, FIELD.top, FIELD.height);
  }
  r.viewportChanged(400);
  return { r, scrollTo };
}

describe('createFieldsRevealer', () => {
  it('lays out and scrolls nothing until a field has focus', () => {
    const { r, scrollTo } = laidOut();
    r.viewportChanged(210);
    r.keyboardShown();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  // Mutation caught: the revealer keeping the first row's measurements, so the
  // third row's field stays under the keyboard.
  it('the keyboard takes the body’s space: the FOCUSED row is scrolled back into view', () => {
    const { r, scrollTo } = laidOut();
    r.focus('c');
    // Row c (324 to 474) runs past the 400 pt window: shown whole on focus.
    expect(scrollTo).toHaveBeenLastCalledWith(324 + 150 + REVEAL_MARGIN - 400);
    r.viewportChanged(210);
    // The window is 210 pt: row c shows whole, with the margin below it.
    expect(scrollTo).toHaveBeenLastCalledWith(324 + 150 + REVEAL_MARGIN - 210);
  });

  it('moving focus to another row reveals that row', () => {
    const { r, scrollTo } = laidOut();
    r.viewportChanged(210);
    r.focus('c');
    const afterC = scrollTo.mock.calls.at(-1)![0] as number;
    r.scrolled(afterC);
    r.focus('a');
    expect(scrollTo).toHaveBeenLastCalledWith(0);
  });

  // iOS may report the next field's focus before the previous one's blur.
  it('the previous field’s blur, after the next one’s focus, leaves the next one in charge', () => {
    const { r, scrollTo } = laidOut();
    r.focus('b');
    r.focus('c');
    r.blur('b');
    r.viewportChanged(210);
    expect(scrollTo).toHaveBeenLastCalledWith(324 + 150 + REVEAL_MARGIN - 210);
  });

  it('after its own blur nothing is kept in view', () => {
    const { r, scrollTo } = laidOut();
    r.focus('a');
    r.blur('a');
    r.viewportChanged(120);
    r.keyboardShown();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('a row that lays out again while its field has focus is the one used; others are only remembered', () => {
    const { r, scrollTo } = laidOut();
    r.focus('b');
    // Row a grows (a problem line appeared under its field): b moves down.
    r.blockLaid('a', 0, 190);
    r.blockLaid('b', 202, 150);
    r.contentChanged(560);
    expect(scrollTo).not.toHaveBeenCalled();
    r.viewportChanged(210);
    expect(scrollTo).toHaveBeenLastCalledWith(202 + 150 + REVEAL_MARGIN - 210);
  });

  it('ignores measurements that are not numbers', () => {
    const { r, scrollTo } = laidOut();
    r.blockLaid('c', Number.NaN, 10);
    r.fieldLaid('c', 1, Number.POSITIVE_INFINITY);
    r.focus('c');
    r.viewportChanged(210);
    expect(scrollTo).toHaveBeenLastCalledWith(324 + 150 + REVEAL_MARGIN - 210);
  });
});
