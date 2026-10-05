import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { sheetOpeningAfter } from './sheet-opening';

/**
 * L101: closing the exception screen's Confirm (or Acknowledge) sheet showed,
 * for a frame, the "Add a note" form. The screen passed mode={sheet ?? 'note'},
 * so closing switched the mode to note while the Modal slid out, and the sheet
 * keyed its content on `${visible}:${mode}`, so the content remounted in note
 * mode for the closing animation. The screen now keeps the last opened mode
 * while the sheet closes, and the sheet keys its content on an opening count.
 */
describe('sheetOpeningAfter', () => {
  it('counts an opening when the sheet becomes visible, and nothing else', () => {
    const closed = { visible: false, count: 0 };
    const open1 = sheetOpeningAfter(closed, true);
    expect(open1).toEqual({ visible: true, count: 1 });
    // The same props again: the same object, so no state update.
    expect(sheetOpeningAfter(open1, true)).toBe(open1);
    // Closing keeps the count, so the content does not remount while it slides out.
    const closing = sheetOpeningAfter(open1, false);
    expect(closing).toEqual({ visible: false, count: 1 });
    // The next opening is a new one: the content starts blank.
    expect(sheetOpeningAfter(closing, true)).toEqual({ visible: true, count: 2 });
  });
});

const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const screen = codeOnly(readFileSync(path.resolve(__dirname, '../../app/exceptions/[id].tsx'), 'utf8'));
const sheet = codeOnly(readFileSync(path.resolve(__dirname, '../components/exception-note-sheet.tsx'), 'utf8'));

describe('the exception sheet keeps its mode while it closes (L101)', () => {
  // Mutation caught: the closing sheet falls back to 'note' again.
  it('the screen passes the last opened mode while the sheet closes', () => {
    expect(screen).toContain('mode={sheet ?? lastSheet}');
    expect(screen).not.toContain("mode={sheet ?? 'note'}");
    expect(screen).toMatch(/const openSheet = React\.useCallback\(\(mode: ExceptionSheetMode\) => \{\s*setLastSheet\(mode\);\s*setSheet\(mode\);\s*\}, \[\]\);/);
    expect(screen).toContain('onOpenSheet={openSheet}');
  });

  // Mutation caught: the content keyed on visible and mode again.
  it('the sheet remounts its content once per opening, never on a mode change', () => {
    expect(sheet).toContain('key={opening.count}');
    expect(sheet).not.toContain('key={`${String(visible)}:${mode}`}');
    expect(sheet).toMatch(/if \(opening\.visible !== visible\) setOpening\(sheetOpeningAfter\(opening, visible\)\);/);
  });
});
