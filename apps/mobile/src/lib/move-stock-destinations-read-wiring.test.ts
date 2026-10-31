import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SHEET_DESTINATIONS_UNREADABLE_NOTE } from './move-stock-form';

/**
 * WIRING PINS for the move sheet's read of the racks and crates to move INTO
 * (2026-10-24).
 *
 * That read ignored its error: `destRes.data ?? []` turned a failed read into
 * "this warehouse has no racks". The sheet then called every typed rack new
 * ("Create new rack 17-B?" for a rack that exists, which trains people to say
 * yes to the question that guards the 2026-09-24 incident), dropped Unplaced
 * from the list, and told a member who may not create racks that there was
 * nothing to move into. Now the failure is said, and no move is offered.
 *
 * The sheet cannot be rendered under vitest (it imports native modules at
 * load), so this pins what it does in its source, as the holdings read's own
 * pins do (holdings-elsewhere-wiring.test.ts).
 */

const read = (rel: string): string => readFileSync(path.resolve(__dirname, rel), 'utf8');
/** Source with comments stripped: the pins are about what the code DOES. */
const codeOnly = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const moveModal = codeOnly(read('../components/move-stock-modal.tsx'));

/** The source between `start` and the first `end` after it. */
function between(src: string, start: string, end: string): string {
  const at = src.indexOf(start);
  expect(at, `${start} not found`).toBeGreaterThan(-1);
  const stop = src.indexOf(end, at + start.length);
  expect(stop, `${end} not found after ${start}`).toBeGreaterThan(-1);
  return src.slice(at, stop);
}

describe('Move stock: a failed read of the places to move into', () => {
  it('is checked before the rows are read, and stops the open there', () => {
    const afterRead = between(
      moveModal,
      "const destRes = await destQuery.order('name', { ascending: true });",
      'const str = ',
    );
    expect(afterRead).toContain('if (destRes.error) {');
    const stop = between(afterRead, 'if (destRes.error) {', '}');
    expect(stop).toContain('setDestinationsUnreadable(true);');
    expect(stop).toContain('setLoading(false);');
    expect(stop).toContain('return;');
  });

  it('stops before the open stores a source or a destination list', () => {
    const check = moveModal.indexOf('if (destRes.error) {');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(moveModal.indexOf('setDestinations(ds);'));
    expect(check).toBeLessThan(moveModal.indexOf('setSource(resolved);'));
  });

  it('is said in the sheet, before any empty state can describe the warehouse', () => {
    expect(between(moveModal, ') : destinationsUnreadable ? (', ') : sourceMissing ? (')).toContain(
      '{SHEET_DESTINATIONS_UNREADABLE_NOTE}',
    );
    expect(moveModal.indexOf(') : destinationsUnreadable ? (')).toBeLessThan(
      moveModal.indexOf(') : holdings.length === 0 ? ('),
    );
    expect(moveModal.indexOf(') : destinationsUnreadable ? (')).toBeLessThan(
      moveModal.indexOf(') : destChoices.length === 0 && !canCreateLocation ? ('),
    );
  });

  it('offers no move while it stands', () => {
    expect(between(moveModal, 'const canSubmit =', ';')).toContain('!destinationsUnreadable');
  });

  it('is forgotten on every open, so one failed open never blocks the next', () => {
    expect(between(moveModal, 'setHoldingsUnreadable(false);', 'void (async')).toContain(
      'setDestinationsUnreadable(false);',
    );
  });

  it('says what failed and what to do, as the sheet says its other failed reads', () => {
    expect(SHEET_DESTINATIONS_UNREADABLE_NOTE).toBe(
      'Could not load the racks and crates to move into. Close this and try again.',
    );
  });
});
