import { describe, expect, it, vi } from 'vitest';

import { createFieldRevealer, REVEAL_MARGIN, revealScrollOffset } from './sheet-field-reveal';

/**
 * THE FOCUSED NOTE STAYS IN VIEW WHEN THE KEYBOARD COMES UP (R1 walk,
 * 2026-09-29, iPhone 17 at AX5).
 *
 * The exception sheets size their body to the space the keyboard leaves
 * (exception-sheet-layout.ts). The keyboard comes up AFTER the note takes
 * focus, so iOS scrolls the note into the body as it is at that moment; then
 * the body loses about 190 pt from its bottom and keeps its scroll offset, and
 * the note falls out of view: 0 of 94 pt showed when the person tapped the
 * field as soon as it appeared, 84 of 94 when they had scrolled it fully into
 * view first. The numbers below are the simulator's.
 */

/** The Acknowledge sheet's body at AX5 on an iPhone 17 (402 x 874). */
const AX5 = {
  // The help runs about 1,400 pt; then the note: label 34, gap 6, field 94,
  // gap 6, counter 52.
  block: { top: 1412, height: 192 },
  fieldInBlock: { top: 40, height: 94 },
  content: 1604,
  viewportKeyboardDown: 393,
  viewportKeyboardUp: 202,
};
const fieldTop = AX5.block.top + AX5.fieldInBlock.top;
const fieldBottom = fieldTop + AX5.fieldInBlock.height;

function visible(offset: number, viewport: number, top: number, bottom: number): number {
  return Math.max(0, Math.min(bottom, offset + viewport) - Math.max(top, offset));
}

function laidOut(scrollTo: (y: number) => void) {
  const r = createFieldRevealer(scrollTo);
  r.contentChanged(AX5.content);
  r.blockLaid(AX5.block.top, AX5.block.height);
  r.fieldLaid(AX5.fieldInBlock.top, AX5.fieldInBlock.height);
  r.viewportChanged(AX5.viewportKeyboardDown);
  return r;
}

describe('revealScrollOffset', () => {
  it('scrolls down just enough to show the note with its label and counter when they fit', () => {
    // The field's top shows 30 pt above the window's bottom edge.
    const offset = fieldTop - 393 + 30;
    const y = revealScrollOffset({
      offset,
      viewport: 393,
      contentHeight: AX5.content,
      block: AX5.block,
      field: { top: fieldTop, height: 94 },
    });
    // The note is the body's last block, so the scroll stops at the content's
    // end (short of the margin below it).
    expect(y).toBe(Math.min(AX5.block.top + AX5.block.height + REVEAL_MARGIN, AX5.content) - 393);
    expect(visible(y!, 393, AX5.block.top, AX5.block.top + AX5.block.height)).toBe(AX5.block.height);
  });

  it('a window the note block only just fits (192 pt in 202): the whole block shows, the margin gives way', () => {
    const offset = fieldTop - 202 + 13; // 13 pt showing, as in the walk
    const y = revealScrollOffset({
      offset,
      viewport: 202,
      contentHeight: AX5.content + 40,
      block: AX5.block,
      field: { top: fieldTop, height: 94 },
    })!;
    expect(visible(y, 202, AX5.block.top, AX5.block.top + AX5.block.height)).toBe(AX5.block.height);
    expect(y).toBe(AX5.block.top + AX5.block.height + 5 - 202);
  });

  it('shows the field alone when the label and counter do not fit, and the field does', () => {
    const offset = fieldTop - 180 + 13;
    const y = revealScrollOffset({
      offset,
      viewport: 180,
      contentHeight: AX5.content,
      block: AX5.block,
      field: { top: fieldTop, height: 94 },
    })!;
    expect(visible(y, 180, fieldTop, fieldBottom)).toBe(94);
    expect(y).toBe(fieldBottom + REVEAL_MARGIN - 180);
  });

  it('scrolls up to a note above the window', () => {
    const y = revealScrollOffset({
      offset: fieldBottom + 50,
      viewport: 202,
      contentHeight: AX5.content,
      block: AX5.block,
      field: { top: fieldTop, height: 94 },
    })!;
    expect(visible(y, 202, fieldTop, fieldBottom)).toBe(94);
    expect(y).toBeLessThan(fieldBottom + 50);
  });

  it('does nothing when the note already shows', () => {
    const y = revealScrollOffset({
      offset: AX5.block.top - 20,
      viewport: 393,
      contentHeight: AX5.content,
      block: AX5.block,
      field: { top: fieldTop, height: 94 },
    });
    expect(y).toBeNull();
  });

  it('a window shorter than the field shows the field from its first line (where the caret starts)', () => {
    // A 375 x 667 iPhone SE at AX5 with the keyboard up leaves about 60 pt.
    const y = revealScrollOffset({
      offset: 0,
      viewport: 61,
      contentHeight: AX5.content,
      block: AX5.block,
      field: { top: fieldTop, height: 94 },
    });
    expect(y).toBe(fieldTop - REVEAL_MARGIN);
  });

  it('never scrolls past the content, and never above its top', () => {
    const bottom = revealScrollOffset({
      offset: 0,
      viewport: 300,
      contentHeight: 400,
      block: { top: 250, height: 150 },
      field: { top: 290, height: 94 },
    });
    expect(bottom).toBe(100);
    const top = revealScrollOffset({
      offset: 200,
      viewport: 300,
      contentHeight: 900,
      block: { top: 4, height: 150 },
      field: { top: 44, height: 94 },
    });
    expect(top).toBe(0);
  });

  it('an unknown content height is at least the note: it still scrolls to it', () => {
    const y = revealScrollOffset({
      offset: 0,
      viewport: 202,
      contentHeight: 0,
      block: AX5.block,
      field: { top: fieldTop, height: 94 },
    })!;
    expect(visible(y, 202, fieldTop, fieldBottom)).toBe(94);
  });

  it('whole points, never NaN; no window, no scroll', () => {
    const y = revealScrollOffset({
      offset: 10.4,
      viewport: 202.6,
      contentHeight: 1604.3,
      block: { top: 1412.2, height: 191.7 },
      field: { top: 1452.5, height: 94.1 },
    });
    expect(Number.isInteger(y)).toBe(true);
    expect(
      revealScrollOffset({ offset: 0, viewport: 0, contentHeight: 900, block: AX5.block, field: { top: fieldTop, height: 94 } }),
    ).toBeNull();
    expect(
      revealScrollOffset({ offset: 0, viewport: Number.NaN, contentHeight: 900, block: AX5.block, field: { top: fieldTop, height: 94 } }),
    ).toBeNull();
  });
});

describe('createFieldRevealer: the sheet as the keyboard comes up', () => {
  // THE FINDING. Mutation caught: not revealing when the body's window
  // shrinks after focus (only on focus), which is what left 0 of 94 pt.
  it('the body shrinks under the keyboard after the note took focus: the note is scrolled back into view', () => {
    const calls: number[] = [];
    const r = laidOut((y) => calls.push(y));
    // The person scrolled until the field's top showed 30 pt, and tapped it.
    let offset = fieldTop - AX5.viewportKeyboardDown + 30;
    r.scrolled(offset);
    r.focus();
    offset = calls.at(-1) ?? offset;
    expect(visible(offset, AX5.viewportKeyboardDown, fieldTop, fieldBottom)).toBe(94);
    // iOS scrolls the body when the note takes focus, too (scrollRectToVisible);
    // then the keyboard's space is measured and the body shrinks.
    r.scrolled(offset);
    r.viewportChanged(AX5.viewportKeyboardUp);
    const after = calls.at(-1)!;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(visible(after, AX5.viewportKeyboardUp, fieldTop, fieldBottom)).toBe(94);
  });

  it('the field fully in view before the tap (the walk\'s 84 of 94 run) ends wholly in view', () => {
    const calls: number[] = [];
    const r = laidOut((y) => calls.push(y));
    // The whole note block showing at the bottom of the keyboard-down window.
    const offset = AX5.block.top + AX5.block.height + 10 - AX5.viewportKeyboardDown;
    r.scrolled(offset);
    r.focus();
    expect(calls).toEqual([]); // already in view: no scroll on focus
    r.viewportChanged(AX5.viewportKeyboardUp);
    expect(visible(calls.at(-1)!, AX5.viewportKeyboardUp, fieldTop, fieldBottom)).toBe(94);
  });

  it('the keyboard has shown (a backup for a body that did not change size): reveals while focused', () => {
    const scrollTo = vi.fn();
    const r = laidOut(scrollTo);
    r.scrolled(0);
    r.focus();
    scrollTo.mockClear();
    r.scrolled(0); // something moved it away again
    r.keyboardShown();
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  // Mutation caught: revealing on every layout, which would fight the person
  // scrolling the help with the keyboard down, and iOS's own caret tracking.
  it('does nothing while the note is not focused, and after it loses focus', () => {
    const scrollTo = vi.fn();
    const r = laidOut(scrollTo);
    r.scrolled(0);
    r.viewportChanged(AX5.viewportKeyboardUp);
    r.keyboardShown();
    expect(scrollTo).not.toHaveBeenCalled();
    r.focus();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    r.blur();
    r.scrolled(0);
    r.viewportChanged(AX5.viewportKeyboardDown);
    r.keyboardShown();
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('typing that grows the field does not scroll the body (iOS keeps the caret in view)', () => {
    const scrollTo = vi.fn();
    const r = laidOut(scrollTo);
    r.scrolled(fieldTop - 20);
    r.focus();
    scrollTo.mockClear();
    r.fieldLaid(AX5.fieldInBlock.top, 300);
    r.blockLaid(AX5.block.top, 398);
    r.contentChanged(AX5.content + 206);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('a layout pass that does not change the window height does not scroll', () => {
    const scrollTo = vi.fn();
    const r = laidOut(scrollTo);
    r.scrolled(0);
    r.focus();
    scrollTo.mockClear();
    r.scrolled(0);
    r.viewportChanged(AX5.viewportKeyboardDown);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('before the note is laid out, it waits (no scroll to a guess)', () => {
    const scrollTo = vi.fn();
    const r = createFieldRevealer(scrollTo);
    r.viewportChanged(393);
    r.focus();
    r.viewportChanged(202);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
