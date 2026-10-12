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
 * consumer path below is scanned for the names, on the web and (fix round 1,
 * data review D2) on the phone, and each consumer file the brief names is
 * pinned to a pattern (restore points, the order storefront and the phone's
 * order catalog, the CSV exports, the exchange and returns routes).
 *
 * IF THIS FAILS: a consumer started treating a display group as an identity.
 * Use the product family (sports linking) for variant relationships, and the
 * record id for everything else. Do not add the file to an allowlist without
 * an owner decision.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
  /(^|\/)export[^/]*\//, // export directories: the export builder, /api/inventory/export.csv
  /(^|\/)export[^/]*\.(ts|tsx)$/, // export files (lib/orders/export.ts)
  /(^|\/)inventory-export[^/]*\.(ts|tsx)$/,
  /(^|\/)orders?-(new-|phone-)?catalog[^/]*\.(ts|tsx)$/, // the web and phone order catalogs
  /(^|\/)api\/v1\/orders\/catalog\//,
  /(^|\/)orders?-?storefront[^/]*/, // the order storefront (service, http, components)
  /(^|\/)order-replacement[^/]*\.(ts|tsx)$/, // exchange replacements
  /(^|\/)exchange-candidates\//,
  /(^|\/)api\/v1\/returns\//,
  /(^|\/)restore-points[^/]*\.(ts|tsx)$/, // restore points key on (SKU, bin)
  /(^|\/)recovery\.ts$/, // un-delete (restores a record's earlier membership: G2-NOTES)
  /(^|\/)public-catalog[^/]*/, // the public catalog
  /(^|\/)bundles?[^/]*\.(ts|tsx)$/, // kits
  /(^|\/)size-count[^/]*\.(ts|tsx)$/, // size count sessions
  /(^|\/)product-group[^/]*\.(ts|tsx)$/, // certified families
  /(^|\/)intacct[^/]*\.(ts|tsx)$/,
  /(^|\/)books-import[^/]*\.(ts|tsx)$/,
  /(^|\/)api\/v1\/items\/lookup\//, // scan lookup
];

/** The phone (apps/mobile), scanned for the same names (D2). */
const MOBILE = join(SRC, '..', '..', 'mobile');

/** Phone consumer paths (relative to apps/mobile): orders and the new-order
 *  storefront (the cart), returns and exchanges, scans, reports (Book Order
 *  Totals), kits and PO screens. */
const MOBILE_CONSUMERS: RegExp[] = [
  /^app\/order\//, // an order, and the new-order storefront (the cart)
  /^app\/returns\//,
  /^app\/reports\//,
  /^app\/bundles\//,
  /^app\/(scan-po|po|po-import)\//,
  /^app\/\(drawer\)\/(orders|returns|reports|bundles|po-imports|purchase-orders|rentals)\.tsx$/,
  /^src\/lib\/(order|orders|returns?|book-order-totals|bundle|po|report)-[^/]*\.(ts|tsx)$/,
  /^src\/lib\/order-storefront\//,
  /^src\/lib\/scan-resolve\.ts$/,
  /^src\/components\/order-storefront\//,
  /^src\/components\/[^/]*(order|return|po-)[^/]*\.(ts|tsx)$/,
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
    expect(consumers.some((f) => /restore-points/.test(f))).toBe(true);
    expect(consumers.some((f) => /order-storefront/.test(f))).toBe(true);
    const offenders = consumers.filter((rel) => NAMES.test(readFileSync(join(SRC, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });

  // Data review D2: the guard's patterns missed consumer paths the brief
  // names (restore points, the order storefront and phone catalog, the CSV
  // exports, the exchange and returns routes). Each is pinned here, so a
  // pattern that stops matching it fails.
  it('covers every consumer path the brief names, by file', () => {
    const named = [
      'server/services/order-storefront.ts',
      'server/lib/order-storefront-http.ts',
      'server/loaders/orders-phone-catalog.ts',
      'server/loaders/orders-new-catalog.ts',
      'app/api/v1/orders/catalog/route.ts',
      'server/services/restore-points.ts',
      'server/actions/restore-points.ts',
      'server/services/recovery.ts',
      'server/services/public-catalog.ts',
      'server/services/order-replacement.ts',
      'app/api/inventory/export.csv/route.ts',
      'lib/orders/export.ts',
      'app/api/v1/orders/[id]/exchange-candidates/route.ts',
      'app/api/v1/returns/route.ts',
      'app/api/v1/returns/[id]/candidates/route.ts',
    ];
    const missed = named.filter((rel) => !CONSUMERS.some((re) => re.test(rel)));
    expect(missed).toEqual([]);
    // Each still exists, so the list is not judging files that moved.
    expect(named.filter((rel) => !existsSync(join(SRC, rel)))).toEqual([]);
  });

  it("the phone's consumer paths (orders, cart, returns, exchanges, scans, reports, kits, PO) never read them either", () => {
    const files = sourceFiles(MOBILE).map((p) => relative(MOBILE, p).split('\\').join('/'));
    const consumers = files.filter((rel) => MOBILE_CONSUMERS.some((re) => re.test(rel)));
    // Vacuity control: real files on the main phone paths.
    expect(consumers.some((f) => f.startsWith('app/order/'))).toBe(true);
    expect(consumers.some((f) => f.startsWith('src/lib/order-storefront/'))).toBe(true);
    expect(consumers.some((f) => /returns/.test(f))).toBe(true);
    expect(consumers).toContain('src/lib/scan-resolve.ts');
    const offenders = consumers.filter((rel) =>
      NAMES.test(readFileSync(join(MOBILE, rel), 'utf8')),
    );
    expect(offenders).toEqual([]);
    // The phone's own grouping files are not consumers (they must match none).
    for (const own of [
      'app/group-selected.tsx',
      'src/lib/display-groups.ts',
      'src/lib/inventory-grouping.ts',
      'app/(drawer)/(tabs)/inventory.tsx',
      'app/(drawer)/(tabs)/books.tsx',
    ]) {
      expect(
        MOBILE_CONSUMERS.some((re) => re.test(own)),
        own,
      ).toBe(false);
    }
  });

  it('the scan catches a planted read', () => {
    expect(NAMES.test("supabase.from('item_display_group_members')")).toBe(true);
    expect(NAMES.test('row.display_group_id')).toBe(true);
    expect(NAMES.test('const group = row.group_id')).toBe(false);
  });
});
