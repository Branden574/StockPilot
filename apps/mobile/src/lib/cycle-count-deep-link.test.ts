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
