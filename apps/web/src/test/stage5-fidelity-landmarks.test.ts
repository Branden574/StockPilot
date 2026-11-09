import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BOARD_TARGETS,
  boxProblems,
  exportTargets,
  selectorDrift,
  styleProblems,
  variantsOf,
  type BoardLandmarksFile,
  type BoardRecord,
} from '../../tests/e2e/appearance/fidelity-landmarks';

/**
 * Plan 8.1-1 / 8.1-2: the landmark rules fidelity-geometry.spec.ts applies on
 * the lab, and the contract with the board exporter
 * (liquid-glass/verify/stage5/export-board-landmarks.mjs reads the "targets"
 * copy in fixtures/board-landmarks.json; this test keeps that copy equal to
 * fidelity-landmarks.ts, so the exporter and the spec never measure
 * different things).
 */

const FILE = join(__dirname, '..', '..', 'tests/e2e/appearance/fixtures/board-landmarks.json');

describe('geometry tolerance (position 2 px, size 1 px)', () => {
  const board = { x: 266, y: 0, w: 1174, h: 68 };
  it('passes within tolerance', () => {
    expect(boxProblems('topbar', board, { x: 268, y: -2, w: 1175, h: 67 }, true)).toEqual([]);
  });
  it('FAILS a 3 px move and a 2 px size change', () => {
    expect(boxProblems('topbar', board, { x: 269, y: 0, w: 1174, h: 68 }, true)).toHaveLength(1);
    expect(boxProblems('topbar', board, { x: 266, y: 0, w: 1176, h: 68 }, true)).toHaveLength(1);
    expect(boxProblems('topbar', board, { x: 266, y: 0, w: 1174, h: 70 }, true)).toHaveLength(1);
  });
  it('a landmark that follows the data is not held to its height', () => {
    expect(boxProblems('card-1', board, { x: 266, y: 0, w: 1174, h: 400 }, false)).toEqual([]);
  });
});

describe('style comparison', () => {
  it('passes equal styles and treats letter-spacing normal as 0px', () => {
    const s = {
      fontSize: '13px',
      fontWeight: '600',
      letterSpacing: 'normal',
      backgroundColor: 'rgb(255, 255, 255)',
    };
    expect(styleProblems('h1', s, { ...s, letterSpacing: '0px' })).toEqual({ fail: [], gaps: [] });
  });
  it('compares opaque colours by delta E 2000 below 1 and FAILS a visible change', () => {
    const b = { backgroundColor: 'rgb(11, 122, 92)' };
    expect(styleProblems('x', b, { backgroundColor: 'rgb(11, 123, 92)' }).fail).toEqual([]);
    expect(styleProblems('x', b, { backgroundColor: 'rgb(11, 140, 92)' }).fail).toHaveLength(1);
  });
  it('FAILS a different size, weight or radius', () => {
    const r = styleProblems(
      'h1',
      { fontSize: '26px', borderTopLeftRadius: '18px' },
      { fontSize: '24px', borderTopLeftRadius: '12px' },
    );
    expect(r.fail).toHaveLength(2);
  });
  it('reports a font family difference as a known gap, not a failure', () => {
    const r = styleProblems(
      'h1',
      { fontFamily: 'Inter, sans-serif' },
      { fontFamily: '-apple-system, sans-serif' },
    );
    expect(r.fail).toEqual([]);
    expect(r.gaps).toHaveLength(1);
  });
});

describe('the exporter contract', () => {
  const file = JSON.parse(readFileSync(FILE, 'utf8')) as BoardLandmarksFile;
  it('board-landmarks.json carries exactly exportTargets() of fidelity-landmarks.ts', () => {
    expect(file.format).toBe(1);
    expect(file.targets).toEqual(exportTargets());
  });
  it('FAILS when the copy drifts from the definitions', () => {
    const drifted = structuredClone(file.targets);
    drifted[0]!.landmarks[0]!.board = 'h2';
    expect(drifted).not.toEqual(exportTargets());
  });
  it("every export record used this file's selectors (selectorDrift)", () => {
    for (const record of file.boards) {
      const target = BOARD_TARGETS.find(
        (t) => t.board === record.board && variantsOf(t).includes(record.variant),
      );
      expect(target, `${record.board} ${record.variant} is a target`).toBeDefined();
      // Only the target's own landmarks are compared (a board in two states has one record).
      const own = BOARD_TARGETS.filter((t) => t.board === record.board);
      for (const t of own) expect(selectorDrift(t, record)).toEqual([]);
    }
  });
  it('selectorDrift FAILS a record made with another selector', () => {
    const t = BOARD_TARGETS.find((x) => x.board === 'Items')!;
    const record: BoardRecord = {
      board: 'Items',
      variant: 'reduced',
      viewport: { w: 1440, h: 1000 },
      selectors: Object.fromEntries(t.landmarks.map((l) => [l.name, l.board])),
      landmarks: {},
      missing: [],
    };
    expect(selectorDrift(t, record)).toEqual([]);
    record.selectors.sidebar = 'nav';
    expect(selectorDrift(t, record)).toHaveLength(1);
  });
  it('holds boxes and styles only: no board text reaches the public repo', () => {
    for (const record of file.boards)
      for (const m of Object.values(record.landmarks))
        expect(Object.keys(m).sort()).toEqual(['h', 'style', 'w', 'x', 'y']);
  });
});
