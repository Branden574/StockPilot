/**
 * RECURRENCE GUARD (Group selected, migration 0400; design-merged.md section
 * 8): an explicit display group is DISPLAY ONLY. It is never a certified
 * product family, a kit, a substitute, or an identity for exchange
 * eligibility, PO matching, Book Order Totals, reports or exports. Nothing on
 * those paths may read item_display_groups / item_display_group_members, a
 * row's display_group_* fields, or the grouping preview; they keep keying on
 * the record id, the SKU, the barcode/ISBN or the product family (group_id,
 * variant_key).
 *
 * The database side is pinned by 0400's pgTAP G7 (only 0400's own functions
 * name the tables). This is the TypeScript side, as an ALLOWLIST (fix round 2,
 * recheck R2-3: patterns keyed on file-name prefixes missed every route.ts
 * and component under a consumer directory, the phone's requester exchange
 * client and its scan screen). Every non-test source file of the web app
 * (apps/web/src), the phone (apps/mobile) and core (packages/core/src) is
 * scanned for the display-group names, and the files that name them must be
 * exactly the ones in ALLOWED: the grouping feature's own files and the
 * screens that show groups (the Items and Books lists, the item page, the
 * select bar, Activity, What's New). No allowed file may lie on a consumer
 * path (CONSUMERS, matched by directory as well as by file name), and each
 * consumer file the brief or a review named is pinned: it exists, it is
 * scanned, and it is on a consumer path.
 *
 * IF THIS FAILS:
 * - A file names display groups but is not in ALLOWED. If it is a screen that
 *   shows records on the Items or Books list, the item page or Activity, add
 *   it to ALLOWED with the reason. If it is on an order, cart, return,
 *   exchange, PO, report, export, kit, catalog, scan or restore path, it must
 *   not read display groups: key on the record id, the SKU, the barcode/ISBN
 *   or the product family instead. Making a display group an identity
 *   anywhere is an owner decision, not an allowlist edit.
 * - A file is in ALLOWED but names nothing: take it out, so the list stays
 *   exactly the readers.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const WEB = join(__dirname, '..', '..');
const MOBILE = join(WEB, '..', '..', 'mobile');
const CORE = join(WEB, '..', '..', '..', 'packages', 'core', 'src');

/** The names of a display group in code: its tables, a row's fields, the
 *  preview and apply functions, and the screens' calls to them. A word in a
 *  comment ("a display group") is not a read and does not match. */
const NAMES =
  /item_display_group|display[_-]?group|item_grouping_preview|apply_item_grouping|previewGroupingAction|applyGroupingAction|\bpreviewGrouping\b|\bpostGrouping\b/i;

/** The only files that may name display groups, with the reason. */
const ALLOWED: Record<'web' | 'mobile' | 'core', Record<string, string>> = {
  web: {
    'app/(dashboard)/dashboard/books/page.tsx': 'the Books list reads memberships beside its rows',
    'app/(dashboard)/dashboard/inventory/page.tsx':
      'the Items list reads memberships beside its rows',
    'app/api/items/search/route.ts':
      "the Items and Books tables' server search attaches each hit's group",
    'app/api/v1/items/grouping/route.ts': "the phone's Save (apply_item_grouping)",
    'app/api/v1/items/grouping/preview/route.ts': "the phone's review (item_grouping_preview)",
    'app/api/v1/items/ungroup-selected/route.ts':
      "the phone's Ungroup Save (a record leaves its display group, among the steps)",
    'app/api/v1/items/ungroup-selected/preview/route.ts':
      "the phone's Ungroup review (item_grouping_preview names each record's group)",
    'components/inventory/activity-feed.tsx': 'Activity labels for grouping events',
    'components/inventory/bulk-actions.tsx': 'the bulk bar opens Group selected',
    'components/inventory/display-group-dialogs.tsx': 'the review, Remove and Rename dialogs',
    'components/inventory/group-membership-control.tsx': "the item page's group line",
    'components/inventory/inventory-table.tsx': 'group headers and chips on the list',
    'components/inventory/item-detail.tsx': "the item page names the record's group",
    'components/inventory/item-form.tsx': 'Group them on a SKU already taken',
    'lib/inventory/instant-mode.ts': 'the list rows carry their group',
    'lib/releases/registry.ts': "What's New for Group selected",
    'server/actions/item-grouping.ts': "the web review's and Save's actions",
    'server/loaders/inventory-list.ts': "the list loaders' membership reads",
    'server/services/audit.ts': 'Activity for grouping events',
    'server/services/item-grouping.ts': 'the grouping service',
    'server/services/ungroup-selected.ts':
      'Ungroup anything: a record leaves its display group through apply_item_grouping',
    'server/services/lib/display-groups.ts': 'the membership readers',
  },
  mobile: {
    'app/(drawer)/(tabs)/books.tsx': 'the Books list shows groups',
    'app/(drawer)/(tabs)/inventory.tsx': 'the Items list shows groups',
    'app/group-selected.tsx': 'the review screen',
    'app/item/[id].tsx': "the item screen's group line and Remove from group",
    'src/components/count-select-bar.tsx': 'the select bar offers Group',
    'src/lib/display-groups.ts': "the phone's membership reads and grouping client",
    'src/lib/inventory-grouping.ts': "the lists' display rule",
  },
  core: {
    'inventory/display-units.ts': 'the one display rule (headers and chips)',
    'inventory/display-units.fixture.ts': "the display rule's shared parity fixture",
    'inventory/grouping-contract.ts': 'the grouping contract and words',
  },
};

/** Consumer paths (relative to each app's root): matched by DIRECTORY (every
 *  file under it: route handlers, http helpers and components included) and
 *  by file name. */
const CONSUMERS: RegExp[] = [
  // Directories.
  /(^|\/)(orders?|order-storefront|storefront|cart)\//,
  /(^|\/)(returns?|return-request|exchange[^/]*)\//,
  /(^|\/)(po|po-imports?|po-parser|po-scan|purchase-orders?|receive-line|line-matches)\//,
  /(^|\/)(reports?|book-order-totals)\//,
  /(^|\/)(exports?|export-builder|export\.(csv|pdf))\//,
  /(^|\/)(bundles?|kits?)\//,
  /(^|\/)(catalog[^/]*|[^/]*-catalog[^/]*|public)\//,
  /(^|\/)(scan|scan-[^/]+|ai-scan|lookup|[^/]+-lookup|sized-variants|size-counts?)\//,
  /(^|\/)(restore-points?|restore|rentals?|cycle-counts?)\//,
  // File names, wherever they live.
  /(^|\/)(orders?|order-[^/]*|returns?|returns?-[^/]*|requester-returns?[^/]*|use-requester-return[^/]*|exchange[^/]*)\.(ts|tsx)$/,
  /(^|\/)(po-[^/]*|purchase-orders?[^/]*|receiv[^/]*|reports?[^/]*|book-order-totals[^/]*)\.(ts|tsx)$/,
  /(^|\/)(export[^/]*|inventory-export[^/]*|bundles?[^/]*|[^/]*-catalog[^/]*|[^/]*storefront[^/]*)\.(ts|tsx)$/,
  /(^|\/)(restore-points?[^/]*|recovery|scan[^/]*|size-count[^/]*|product-group[^/]*|rentals?[^/]*|intacct[^/]*|books-import[^/]*)\.(ts|tsx)$/,
  // The phone's tab screens for those paths.
  /(^|\/)(orders|po-imports|purchase-orders|rentals|reports)-tab\.tsx$/,
];

/** Consumer files the brief or a review named (data review D2, recheck
 *  R2-3), each pinned so a pattern that stops matching it fails. */
const NAMED_CONSUMERS: Record<'web' | 'mobile' | 'core', string[]> = {
  web: [
    // D2: restore points, the order storefront and catalogs, the CSV exports,
    // the exchange and returns routes.
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
    // R2-3: route handlers and components under consumer directories.
    'app/api/v1/orders/[id]/return-request/route.ts',
    'app/api/v1/orders/[id]/return-request/http.ts',
    'app/api/v1/orders/[id]/return-request/options/route.ts',
    'app/api/v1/public/returns/route.ts',
    'app/api/v1/po-imports/[id]/line-matches/route.ts',
    'app/api/v1/orders/storefront/route.ts',
    'app/api/v1/items/sized-variants/route.ts',
    'app/api/v1/po/[id]/receive-line/route.ts',
    'components/orders/add-items-dialog.tsx',
    'components/po/po-form.tsx',
  ],
  mobile: [
    // D2: the scan lookup.
    'src/lib/scan-resolve.ts',
    // R2-3: the RX-3 requester exchange client, the scan screen, and the
    // order, report and PO screens.
    'src/lib/requester-returns.ts',
    'src/lib/requester-returns-api.ts',
    'src/lib/use-requester-return.ts',
    'app/(drawer)/(tabs)/scan.tsx',
    'src/screens/orders.tsx',
    'src/screens/reports.tsx',
    'src/screens/purchase-orders.tsx',
    'src/screens/po-imports.tsx',
    'app/(drawer)/(tabs)/orders-tab.tsx',
    'app/dashboard/orders/[id].tsx',
  ],
  core: ['orders/place-order.ts', 'returns/returns-copy.ts', 'reports/book-order-totals-copy.ts'],
};

const ROOTS = { web: WEB, mobile: MOBILE, core: CORE } as const;

/** Directories never scanned: dependencies, build output, test-only trees. */
const SKIP_DIRS = new Set(['node_modules', '__tests__', 'dist', '.expo', '.next', '.turbo']);

/** Every non-test source file under a root, relative and with forward slashes. */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (SKIP_DIRS.has(name) || path === join(WEB, 'test')) continue;
        walk(path);
      } else if (
        /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name) &&
        !/\.test\.(ts|tsx|js|jsx)$/.test(name) &&
        !name.endsWith('.d.ts')
      ) {
        out.push(relative(root, path).split('\\').join('/'));
      }
    }
  };
  walk(root);
  return out;
}

const scanned = {
  web: sourceFiles(WEB),
  mobile: sourceFiles(MOBILE),
  core: sourceFiles(CORE),
};

describe('display groups stay display only', () => {
  it('only the allowed files name display groups, on the web, the phone and in core', () => {
    for (const app of ['web', 'mobile', 'core'] as const) {
      const readers = scanned[app].filter((rel) =>
        NAMES.test(readFileSync(join(ROOTS[app], rel), 'utf8')),
      );
      const allowed = Object.keys(ALLOWED[app]);
      // A file that names display groups but is not allowed.
      expect(
        readers.filter((rel) => !allowed.includes(rel)),
        `${app}: names display groups but is not in ALLOWED`,
      ).toEqual([]);
      // An allowed file that names nothing (the list stays exactly the readers).
      expect(
        allowed.filter((rel) => !readers.includes(rel)),
        `${app}: in ALLOWED but names no display group`,
      ).toEqual([]);
    }
  });

  it('no allowed file lies on a consumer path', () => {
    for (const app of ['web', 'mobile', 'core'] as const) {
      const onConsumerPath = Object.keys(ALLOWED[app]).filter((rel) =>
        CONSUMERS.some((re) => re.test(rel)),
      );
      expect(onConsumerPath, app).toEqual([]);
    }
  });

  // Vacuity: the scan reads real trees, and every consumer file the brief or
  // a review named exists, is scanned and is on a consumer path.
  it('scans every app whole, and each named consumer file is scanned and on a consumer path', () => {
    expect(scanned.web.length).toBeGreaterThan(1000);
    expect(scanned.mobile.length).toBeGreaterThan(300);
    expect(scanned.core.length).toBeGreaterThan(100);
    for (const app of ['web', 'mobile', 'core'] as const) {
      for (const rel of NAMED_CONSUMERS[app]) {
        expect(existsSync(join(ROOTS[app], rel)), `${app}: ${rel} exists`).toBe(true);
        expect(scanned[app], `${app}: ${rel} is scanned`).toContain(rel);
        expect(
          CONSUMERS.some((re) => re.test(rel)),
          `${app}: ${rel} is on a consumer path`,
        ).toBe(true);
      }
    }
    // Every web route handler and component under a consumer directory counts,
    // not only files named after it.
    const underOrders = scanned.web.filter((rel) => rel.startsWith('components/orders/'));
    expect(underOrders.length).toBeGreaterThan(10);
    expect(underOrders.every((rel) => CONSUMERS.some((re) => re.test(rel)))).toBe(true);
    const routes = scanned.web.filter(
      (rel) =>
        /^app\/api\/v1\/(orders|returns|po|po-imports|reports)\//.test(rel) &&
        rel.endsWith('/route.ts'),
    );
    expect(routes.length).toBeGreaterThan(10);
    expect(routes.every((rel) => CONSUMERS.some((re) => re.test(rel)))).toBe(true);
  });

  it('the scan catches a planted read, and not a word in a comment', () => {
    expect(NAMES.test("supabase.from('item_display_group_members')")).toBe(true);
    expect(NAMES.test('row.display_group_id')).toBe(true);
    expect(NAMES.test('record.displayGroup?.id')).toBe(true);
    expect(NAMES.test("rpc('item_grouping_preview', body)")).toBe(true);
    expect(NAMES.test("import { readDisplayGroups } from '@/lib/display-groups'")).toBe(true);
    expect(NAMES.test('await previewGrouping({ itemIds })')).toBe(true);
    expect(NAMES.test('const group = row.group_id')).toBe(false);
    expect(NAMES.test('// never reads a display group')).toBe(false);
  });
});
