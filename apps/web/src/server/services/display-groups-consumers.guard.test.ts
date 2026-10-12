/**
 * RECURRENCE GUARD (Group selected, migration 0400; design-merged.md section
 * 8): an explicit display group is DISPLAY ONLY. It is never a certified
 * product family, a kit, a substitute, or an identity for exchange
 * eligibility, PO matching, Book Order Totals, reports or exports. Nothing on
 * those paths may read item_display_groups / item_display_group_members or a
 * row's display_group_* fields; they keep keying on item_id, the SKU, the
 * barcode/ISBN or the product family (group_id, variant_key).
 *
 * The database side is pinned by 0400's pgTAP G7 (only 0400's own functions
 * name the tables). This is the TypeScript side: every source file on a
 * consumer path below is scanned for the names.
 *
 * IF THIS FAILS: a consumer started treating a display group as an identity.
 * Use the product family (sports linking) for variant relationships, and the
 * record id for everything else. Do not add the file to an allowlist without
 * an owner decision.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..');

/** Consumer paths (relative to apps/web/src) that must never read display groups. */
const CONSUMERS: RegExp[] = [
  /(^|\/)returns?[^/]*\.(ts|tsx)$/, // returns, exchanges, the replacement picker
  /(^|\/)components\/returns\//,
  /(^|\/)exchange[^/]*\.(ts|tsx)$/,
  /(^|\/)po-imports?[^/]*\.(ts|tsx)$/, // PO import matchers (barcode, SKU, vendor, variant)
  /(^|\/)reports?\//, // Book Order Totals and the report screens
  /(^|\/)book-order-totals[^/]*\.(ts|tsx)$/,
  /(^|\/)exports?\//, // the export builder
  /(^|\/)inventory-export[^/]*\.(ts|tsx)$/,
  /(^|\/)orders-new-catalog[^/]*\.(ts|tsx)$/, // the order catalog
  /(^|\/)orders-storefront[^/]*\.(ts|tsx)$/,
  /(^|\/)bundles?[^/]*\.(ts|tsx)$/, // kits
  /(^|\/)size-count[^/]*\.(ts|tsx)$/, // size count sessions
  /(^|\/)product-group[^/]*\.(ts|tsx)$/, // certified families
  /(^|\/)intacct[^/]*\.(ts|tsx)$/,
  /(^|\/)books-import[^/]*\.(ts|tsx)$/,
  /(^|\/)api\/v1\/items\/lookup\//, // scan lookup
];

const NAMES = /item_display_group|display_group_(id|name|version)|displayGroup/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__' || path === join(SRC, 'test')) continue;
      sourceFiles(path, out);
    } else if (
      /\.(ts|tsx)$/.test(name) &&
      !/\.test\.(ts|tsx)$/.test(name) &&
      !name.endsWith('.d.ts')
    ) {
      out.push(path);
    }
  }
  return out;
}

describe('display groups stay display only', () => {
  it('no consumer path (exchange, PO import, reports, exports, order catalog, kits, families, scan) reads them', () => {
    const files = sourceFiles(SRC).map((p) => relative(SRC, p).split('\\').join('/'));
    const consumers = files.filter((rel) => CONSUMERS.some((re) => re.test(rel)));
    // Vacuity control: the scan has real files to judge on each main path.
    expect(consumers.some((f) => /returns/.test(f))).toBe(true);
    expect(consumers.some((f) => /po-import/.test(f))).toBe(true);
    expect(consumers.some((f) => /orders-new-catalog/.test(f))).toBe(true);
    const offenders = consumers.filter((rel) => NAMES.test(readFileSync(join(SRC, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the scan catches a planted read', () => {
    expect(NAMES.test("supabase.from('item_display_group_members')")).toBe(true);
    expect(NAMES.test('row.display_group_id')).toBe(true);
    expect(NAMES.test('const group = row.group_id')).toBe(false);
  });
});
