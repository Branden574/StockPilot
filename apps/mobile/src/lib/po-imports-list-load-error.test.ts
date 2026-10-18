import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The imports list screen binds its read's error. It used to destructure only
 * `data`, so a failed load rendered "No imports yet." for an org with imports.
 * Source-level pins, as the screen itself is not compiled by this suite.
 *
 * Re-pinned by the redesign (P5.8, 2026-10-18; CONFLICTS D25): the failure was
 * said by swapping its words into the empty state (`emptyTitle={loadFailed ?
 * 'Could not load imports.' : 'No imports yet.'}`); it is now DataListScreen's
 * `failed` panel with the same words, and the empty state says only "No
 * imports yet.". The screen's own settleList (keep this workspace's rows on a
 * failed refresh, never another's) is run in purchasing-lists-structure.test.ts.
 */

const screen = readFileSync(path.resolve(__dirname, '../screens/po-imports.tsx'), 'utf8');
/** Comments explain the rules; only the CODE can satisfy them. */
const code = screen
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
/** Collapse formatting so a prettier line-break cannot fail a pin. */
const flat = code.replace(/\s+/g, ' ');

describe('screens/po-imports.tsx: a failed load is not an empty history', () => {
  it('binds the error of the po_imports read', () => {
    expect(screen).toMatch(/const \{ data, error \} = await supabase\s*\.from\('po_imports'\)/);
    // The error ends the read as a failure (no rows), never as an empty list.
    expect(code).toContain('if (error) throw new Error(error.message);');
    expect(flat).toMatch(/setStored\(\(prev\) => settleList\(prev, orgId, rows\)\);/);
    expect(flat).not.toMatch(/error \? \[\] :/);
  });

  it('says the load failed instead of "No imports yet."', () => {
    expect(flat).toContain(
      "list?.failed ? { title: 'Could not load imports.', body: 'Check your connection and pull down to try again.',",
    );
    // The empty words are only the empty words: nothing swapped into them.
    expect(code).toContain('emptyTitle="No imports yet."');
    expect(code).not.toMatch(/emptyTitle=\{[^}]*Could not load/);
    expect(code).not.toContain('loadFailed');
  });
});
