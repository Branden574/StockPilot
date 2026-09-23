import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

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
    expect(src).toMatch(/<Redirect href=\{\{ pathname: '\/cycle-count\/\[id\]', params: \{ id \} \}\} \/>/);
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
    expect(detail.match(/router\.back\(\)/g) ?? []).toHaveLength(1);
    expect(detail.match(/onPress=\{leave\}/g) ?? []).toHaveLength(3);
    expect(detail.match(/\bleave\(\);/g) ?? []).toHaveLength(3);
  });
});
