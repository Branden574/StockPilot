import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Neither client may restate what belongs on an inventory tab.
 *
 * On 2026-09-22 web listed `item_type = 'product' AND is_rental = false` and
 * mobile listed `item_type <> 'book'` with no rental filter. Two rental items
 * in one customer organization were on mobile's Items tab and absent from
 * web's. Nothing was wrong with the records; the two clients disagreed about
 * what an "item" is. `@stockpilot/core`'s `inventoryViewPredicate` is now the
 * only definition, and this fails if either side grows a private copy.
 */

const REPO = path.resolve(__dirname, '../../../../..');
const WEB_LOADER = path.join(REPO, 'apps/web/src/server/loaders/inventory-list.ts');
const MOBILE_ITEMS = path.join(REPO, 'apps/mobile/app/(drawer)/(tabs)/inventory.tsx');
const MOBILE_BOOKS = path.join(REPO, 'apps/mobile/app/(drawer)/(tabs)/books.tsx');

/** Comments may discuss the old predicates; code may not contain them. */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('one definition of what belongs on an inventory tab', () => {
  it('resolves all three files (the scans below would pass vacuously otherwise)', () => {
    for (const file of [WEB_LOADER, MOBILE_ITEMS, MOBILE_BOOKS]) {
      expect(existsSync(file), file).toBe(true);
    }
  });

  it.each([
    ['web inventory loader', WEB_LOADER],
    ['mobile Items tab', MOBILE_ITEMS],
    ['mobile Books tab', MOBILE_BOOKS],
  ])('%s takes BOTH axes of the predicate from @stockpilot/core', (_label, file) => {
    const code = codeOnly(readFileSync(file, 'utf8'));
    expect(code).toContain('inventoryViewPredicate');
    // Both axes, not just the import: dropping the rental filter is exactly the
    // drift that put two rentals on mobile's Items tab and not on web's, and it
    // leaves no literal behind for the scan below to catch.
    // Each query must FILTER on both axes, with a value that is not a literal
    // (the scan below bans literals, so what is left can only be the shared
    // predicate). Dropping the rental filter altogether is the drift that put
    // two rentals on mobile's Items tab and not on web's, and it leaves no
    // literal behind for that scan to catch.
    expect(code, 'filters item_type from the shared predicate').toMatch(
      /\.eq\(\s*['"]item_type['"]\s*,\s*(?!['"`])/,
    );
    expect(code, 'filters is_rental from the shared predicate').toMatch(
      /\.eq\(\s*['"]is_rental['"]\s*,\s*(?!true\b|false\b)/,
    );
  });

  it.each([
    ['web inventory loader', WEB_LOADER],
    ['mobile Items tab', MOBILE_ITEMS],
    ['mobile Books tab', MOBILE_BOOKS],
  ])('%s hard-codes neither the item type nor the rental flag', (_label, file) => {
    const code = codeOnly(readFileSync(file, 'utf8'));
    // The exact shapes that drifted: a literal type comparison, or a literal
    // rental filter, anywhere in a query.
    expect(code, 'a literal item_type filter').not.toMatch(
      /\.(eq|neq)\(\s*['"]item_type['"]\s*,\s*['"]/,
    );
    expect(code, 'a literal is_rental filter').not.toMatch(
      /\.(eq|neq)\(\s*['"]is_rental['"]\s*,\s*(true|false)\s*\)/,
    );
  });

  it('the shared module is the only place the tab rule is written down', async () => {
    const { inventoryViewPredicate } = await import('@stockpilot/core');
    // Pinned here too, so a change to the shared rule is a deliberate edit in
    // two places rather than a silent one in the module both clients trust.
    expect(inventoryViewPredicate('items')).toEqual({ itemType: 'product', isRental: false });
    expect(inventoryViewPredicate('books')).toEqual({ itemType: 'book', isRental: false });
  });
});
