import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The three cached storefront loaders (phone ordering PO-2, plan section 1:
 * frozen). unstable_cache's implicit key hashes the wrapped callback, so
 * editing a callback's text rotates its cache key on deploy and every warm
 * catalog goes cold (memory reference_orders_storefront_perf). Phone ordering
 * reads through them and must never edit them: this pins each initializer's
 * exact source text (the unstable_cache call: callback, key parts, options).
 * A deliberate change updates the pin in the same commit, with the reason.
 */

const FILE = path.resolve(__dirname, 'orders-new-catalog.ts');

const PINS: Record<string, string> = {
  loadCatalogItemsCached: '5978161bb4be4bf7721ba6f162e9c9d312a689416c894d176fac332f7b626589',
  loadCatalogThumbMapCached: '0ee26062232644ab2e21a3379c154d2333b751409951bc58cc1bff90218a3708',
  loadChartersForWarehouseCached:
    'fa6e125852a2258d819a6fe9fdd72b9179eb76afcca4adf82d0044379e1d512b',
};

function initializerHashes(): Record<string, string> {
  const src = readFileSync(FILE, 'utf8');
  const sf = ts.createSourceFile(FILE, src, ts.ScriptTarget.Latest, true);
  const out: Record<string, string> = {};
  const visit = (n: ts.Node) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text in PINS &&
      n.initializer
    ) {
      out[n.name.text] = createHash('sha256').update(n.initializer.getText(sf)).digest('hex');
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('the cached storefront loaders are unedited', () => {
  it('each cached callback has the source text its cache key was built from', () => {
    expect(initializerHashes()).toEqual(PINS);
  });

  it('control: an edit to a callback changes its hash', () => {
    const edited = "unstable_cache(async () => 1, ['k'])";
    const hash = createHash('sha256').update(edited).digest('hex');
    expect(Object.values(PINS)).not.toContain(hash);
  });
});
