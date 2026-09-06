import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { frameUrl, HI, LO } from './film';

/**
 * DISK GUARD for the film's footage.
 *
 * WHY THIS EXISTS. `app/(marketing)/page.tsx` documents the landing's history
 * with the line "Scrollytelling survives; the frame sequence does not", written
 * when `StockPilotLanding` replaced `ScrollyLanding`. That sentence is about the
 * COMPONENT's scroll-scrubbed canvas, but it reads as permission to delete the
 * frames — and it is wrong about the footage: `film.ts`'s HI/LO segments still
 * stream `/landing/frames-hi` (frames 1-420 and 421-546) and `/landing/frames-lo`
 * (1-281 and 282-366). Those directories are LIVE. The 14 dead pre-landing
 * marketing components (scrolly-landing.tsx and friends, all zero-importer) are
 * safe to delete; `public/landing/frames-*` is NOT, and a sweep that removes
 * both blanks the homepage film in production.
 *
 * The existing film.test.ts pins only the URL STRINGS frameUrl produces, so
 * deleting the JPEGs passes every test in the suite. This is the test that does
 * not: it asserts the bytes are on disk. Keep it in landing/ — it must outlive
 * the components whose deletion it guards against.
 */

const PUBLIC_DIR = path.join(process.cwd(), 'public');

describe('film footage exists on disk', () => {
  for (const [name, set] of [
    ['HI', HI],
    ['LO', LO],
  ] as const) {
    it(`${name}: every segment directory is present with enough frames`, () => {
      for (const seg of set.segments) {
        // seg.dir is a PUBLIC URL path ('/landing/frames-hi') — map it under public/.
        const dir = path.join(PUBLIC_DIR, seg.dir);
        expect(
          fs.existsSync(dir),
          `${seg.dir} is referenced by film.ts but missing from public/ — the homepage film would render blank frames`,
        ).toBe(true);

        // A segment reads frames [from .. from+count-1] out of its own directory,
        // so the directory must hold at least that many numbered frames.
        const highest = seg.from + seg.count - 1;
        const frames = fs.readdirSync(dir).filter((f) => /^f_\d{4}\.jpg$/.test(f));
        expect(
          frames.length,
          `${seg.dir} holds ${frames.length} frames but film.ts reads up to f_${String(highest).padStart(4, '0')}`,
        ).toBeGreaterThanOrEqual(highest);
      }
    });

    it(`${name}: the poster still exists`, () => {
      // The poster is the Save-Data / reduced-motion tier's ENTIRE experience.
      expect(fs.existsSync(path.join(PUBLIC_DIR, set.poster))).toBe(true);
    });
  }

  it('resolves every frame index to a file that is actually there', () => {
    // Spot-checks the boundaries rather than all 786+529 (a full stat sweep is
    // slow and adds nothing once the directory counts above are pinned).
    for (const set of [HI, LO]) {
      const probes = new Set<number>([0, set.count - 1]);
      let acc = 0;
      for (const seg of set.segments) {
        probes.add(acc);
        probes.add(acc + seg.count - 1);
        acc += seg.count;
      }
      for (const i of probes) {
        const url = frameUrl(set, i);
        expect(fs.existsSync(path.join(PUBLIC_DIR, url)), `${url} (index ${i}) is missing`).toBe(
          true,
        );
      }
    }
  });
});
