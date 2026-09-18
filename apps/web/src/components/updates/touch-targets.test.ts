// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { TOUCH_TARGET, TOUCH_TARGET_ICON } from './constants';

/**
 * About 44px wherever a finger is the pointer. The first version shipped 36px
 * buttons and a 32px dismiss, including the "Keep working / Refresh anyway" pair
 * that sits 8px apart: the one place a mis-tap reloads over unsaved work. Nothing
 * measured it, so nothing caught it. This pins the rule and that it is USED.
 */

const DIR = __dirname;
const SURFACES = [DIR, join(DIR, '..', '..', 'app', '(dashboard)', 'dashboard', 'whats-new')];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return sources(full);
    return /\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name) ? [full] : [];
  });
}

describe("What's New touch targets", () => {
  it('is 44px below sm AND on any coarse pointer, compact only for a mouse', () => {
    for (const rule of [TOUCH_TARGET, TOUCH_TARGET_ICON[8], TOUCH_TARGET_ICON[10]]) {
      const classes = rule.split(' ');
      expect(classes[0]).toMatch(/^(min-h|size)-11$/);
      expect(classes.some((c) => /^\[@media\(pointer:coarse\)\]:(min-h|size)-11$/.test(c))).toBe(
        true,
      );
    }
  });

  it('beats the sm: rule with an ARBITRARY variant, which Tailwind emits after named ones', () => {
    expect(TOUCH_TARGET).not.toMatch(/\bpointer-coarse:/);
  });

  it('never sizes a control by hand: a bare min-h-9 is how the 36px buttons got in', () => {
    const offenders = SURFACES.flatMap(sources).filter((file) =>
      /\bmin-h-(8|9|10)\b/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('is applied to every button and link in the notice and the drawer', () => {
    const count = (file: string) =>
      (readFileSync(join(DIR, file), 'utf8').match(/TOUCH_TARGET(_ICON)?\b/g) ?? []).length;
    // import + uses. Card: What's New, Refresh, Keep working, Refresh anyway, dismiss.
    expect(count('update-card.tsx')).toBeGreaterThanOrEqual(6);
    // Drawer: close, Try again, Keep working, Refresh anyway, history link, Refresh.
    expect(count('release-drawer.tsx')).toBeGreaterThanOrEqual(7);
    // Entry card: the disclosure toggle and the feature link.
    expect(count('release-entry-card.tsx')).toBeGreaterThanOrEqual(3);
  });
});
