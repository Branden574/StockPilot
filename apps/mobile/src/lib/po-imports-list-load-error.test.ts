import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The imports list screen binds its read's error. It used to destructure only
 * `data`, so a failed load rendered "No imports yet." for an org with imports.
 * Source-level pins, as the screen itself is not compiled by this suite.
 */

const screen = readFileSync(path.resolve(__dirname, '../screens/po-imports.tsx'), 'utf8');

describe('screens/po-imports.tsx: a failed load is not an empty history', () => {
  it('binds the error of the po_imports read', () => {
    expect(screen).toMatch(/const \{ data, error \} = await supabase\s*\.from\('po_imports'\)/);
    expect(screen).toContain('setLoadFailed(Boolean(error));');
  });

  it('says the load failed instead of "No imports yet."', () => {
    expect(screen).toContain("emptyTitle={loadFailed ? 'Could not load imports.' : 'No imports yet.'}");
    expect(screen).toContain('Check your connection and pull down to try again.');
  });
});
