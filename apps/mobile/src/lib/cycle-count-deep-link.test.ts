import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { printClassic } from './__fixtures__/classic-projection';

/**
 * The cycle-count assignment notification links the WEB path
 * /dashboard/cycle-counts/{id}. A cold-start tap reaches the router without
 * +native-intent, so the path must be a real route that redirects to the native
 * screen (owner rule: every notification link resolves on mobile).
 */
const shim = path.join(__dirname, '../../app/dashboard/cycle-counts/[id].tsx');

describe('cycle-count deep-link shim', () => {
  it('exists and redirects to the native count screen by id', () => {
    expect(existsSync(shim)).toBe(true);
    const src = readFileSync(shim, 'utf8');
    expect(src).toMatch(
      /<Redirect href=\{\{ pathname: '\/cycle-count\/\[id\]', params: \{ id \} \}\} \/>/,
    );
  });
});

describe('cycle-count detail leaves safely after a cold-start link', () => {
  const detail = readFileSync(path.join(__dirname, '../../app/cycle-count/[id].tsx'), 'utf8');

  it('falls back to the list when there is no screen to go back to', () => {
    expect(detail).toMatch(
      /const leave = React\.useCallback\(\(\) => \{\s+if \(router\.canGoBack\(\)\) router\.back\(\);\s+else router\.replace\('\/cycle-counts'\);/,
    );
  });

  it('never calls router.back() directly (Back, post, release and reassign all use leave)', () => {
    // Classic's code (every Liquid Glass branch folded to Classic) leaves the
    // same three ways; Liquid Glass draws Back in its nav, and every Back it
    // draws is `leave` too, so the source as a whole still never goes back
    // on its own.
    const classic = printClassic(detail, 'app/cycle-count/[id].tsx');
    expect(detail.match(/router\.back\(\)/g) ?? []).toHaveLength(1);
    expect(classic.match(/onPress=\{leave\}/g) ?? []).toHaveLength(3);
    // S75 added a fourth: leaving a count no longer on this phone after a
    // count could not be stored (reloadAfterLineGone).
    expect(classic.match(/\bleave\(\);/g) ?? []).toHaveLength(4);
    expect(detail.match(/\bleave\(\);/g) ?? []).toHaveLength(4);
    expect(detail.match(/onPress=\{(?!leave\})[^}]*router\.back/g) ?? []).toHaveLength(0);
  });
});
