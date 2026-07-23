import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveSurface } from '@stockpilot/core';

/**
 * Staging screen — WIRING PINS for app/(drawer)/staging.tsx.
 *
 * The display logic is pure + tested in staging-worklist.test.ts, but the
 * screen itself cannot be rendered here (the vitest config deliberately
 * excludes app/ screens — they import native modules at load). These
 * source-level assertions pin the load-bearing wiring that a refactor could
 * otherwise drop silently, all of which encodes a specific past failure:
 *
 *   1. the worklist comes from the SHARED service via
 *      GET /api/v1/inventory/staging — never a second Supabase query, which is
 *      exactly the web/mobile divergence this screen exists to avoid;
 *   2. the Place action goes through MoveStockModal → POST /api/v1/items/[id]/
 *      transfer (the raw transfer_stock RPC only checks the staff-role floor,
 *      so it would let a member without 'stock:transfer' move stock);
 *   3. Place is gated on the server's own canPlace, so the button is never
 *      shown to someone whose action would always 403;
 *   4. the modal opens in PUT-AWAY mode with the source FIXED to the tapped
 *      row — no source picker, exactly like the web dialog, which is why a
 *      cross-warehouse "put-away" is not something either surface can express;
 *   5. every cell's words come from the shared formatters, so the phone and
 *      the browser read identically for the same row.
 *
 * Pins 4 and 5 replace this file's earlier provenance pins: the provenance
 * union was reverted, so the screen now renders the same PO/receipt, received
 * and age fields the web table renders. The parity requirement did not change,
 * only where the words come from.
 */

const screen = readFileSync(
  path.resolve(__dirname, '../../app/(drawer)/staging.tsx'),
  'utf8',
);

const drawerLayout = readFileSync(
  path.resolve(__dirname, '../../app/(drawer)/_layout.tsx'),
  'utf8',
);

/**
 * Source with comments stripped. The negative assertions below ("no RPC", "no
 * hand-rolled wording") are about what the screen DOES; the file's own header
 * explains in prose why it avoids those things, and that prose must not trip
 * its own pins.
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const screenCode = codeOnly(screen);

describe('staging screen wiring', () => {
  it('reads the ROWS from the shared endpoint, never a second stock query', () => {
    expect(screen).toContain('stagingWorklistPath(filter, activeWarehouseId)');
    expect(screen).toContain('parseStagingWorklist(res)');
    // The whole point: one query, in the service, behind the Bearer route.
    // (The screen does read `warehouses` directly for the id → name map, which
    // is display-only and mirrors web's own listNames() predicate — see the
    // warehouse-naming test below. No stock is read here.)
    expect(screenCode).not.toContain("from('item_stock_levels')");
    expect(screenCode).not.toContain("from('stock_movements')");
    expect(screenCode).not.toContain("from('locations')");
  });

  it('places through the transfer route, not the RPC', () => {
    expect(screen).toContain('MoveStockModal');
    expect(screenCode).not.toContain('transfer_stock');
    expect(screenCode).not.toContain('.rpc(');
  });

  it('gates Place on the server-reported permission', () => {
    expect(screen).toContain('canPlace={canPlaceStagingRow(item, canPlace)}');
    expect(screen).toContain('setCanPlace(parsed.canPlace)');
    // A failed load must not leave a stale "you can place" state behind.
    expect(screen).toContain('setCanPlace(false)');
  });

  it('opens the move sheet with the source FIXED to the tapped row', () => {
    // Rewritten from an earlier "preselect + scope + whole-holding" trio: those
    // three props were defaults on a general-purpose move modal, and a default
    // is changeable. Put-away is now a mode with no source picker at all (like
    // web's PlaceFromStagingDialog), so the one prop below IS the mode.
    expect(screen).toContain('putAwaySourceLocationId={placing.sourceLocationId}');
    // The warehouse is read off the holding inside the sheet. Passing it here
    // again is what let the scope and the actual source disagree.
    expect(screenCode).not.toContain('restrictToWarehouseId');
    expect(screenCode).not.toContain('initialFromLocationId');
    expect(screenCode).not.toContain('defaultWholeHolding');
  });

  it('shows web\'s disabled Place + reason for a row with no warehouse', () => {
    expect(screen).toContain('disabledReason={stagingPlaceDisabledReason(item, canPlace)}');
    expect(screen).toContain('<Button size="sm" variant="outline" disabled>');
    // The words themselves come from the shared constant, never re-typed here.
    expect(screen).toContain('{disabledReason}');
    expect(screenCode).not.toContain("'No warehouse");
  });

  it('names warehouses from the same active-only population web uses', () => {
    // The drawer switcher's list keeps INACTIVE warehouses; web's listNames()
    // does not. Using the switcher list here printed a name on the phone and a
    // truncated UUID in the browser for the same row.
    expect(screen).toContain('stagingWarehouseNameMap(');
    expect(screen).toContain(".eq('status', 'active')");
    expect(screenCode).not.toContain('warehouses.map((w) => [w.id, w.name])');
  });

  it('renders every cell through the shared formatters, so web and phone agree', () => {
    expect(screen).toContain('stagingSourceLabel(row.sourcePoNumber, row.receiptNumber)');
    expect(screen).toContain('stagingReceivedLabel(row.receivedAt)');
    expect(screen).toContain('stagingWarehouseLabel(row.warehouseId, warehouseNames)');
    expect(screen).toContain('stagingSourceKindLabel(row.sourceKind)');
    expect(screen).toContain('stagingAgeLabel(row.ageDays)');
    expect(screen).toContain('{STAGING_STALE_LABEL}');
    // No cell may be worded in this file: an inline conditional string is how
    // the two surfaces drift apart one row state at a time.
    expect(screenCode).not.toContain("'UNPLACED'");
    expect(screenCode).not.toContain("'STAGED'");
    expect(screenCode).not.toContain("'STALE'");
  });

  it('offers the Items / Books filter the web page has', () => {
    expect(screen).toContain('STAGING_TYPE_OPTIONS');
    expect(screen).toContain('setFilter(opt.value)');
  });

  it('narrows to the drawer switcher\'s active warehouse, like every other list screen', () => {
    // The web page narrows by the active-warehouse cookie. If the phone ignores
    // the switcher, the same user sees a different row set in each surface.
    expect(screen).toContain('stagingWorklistPath(filter, activeWarehouseId)');
    // …and switching warehouse has to re-fetch, or the list is a stale answer
    // to a question the user has already changed.
    expect(screen).toMatch(/\}, \[filter, activeWarehouseId, orgId\]\);/);
  });

  it('keeps the filter toolbar on screen while a filter change is loading', () => {
    // A full-screen spinner in place of the list would unmount the Items/Books
    // toolbar on every tap, so the user could not see which filter is active or
    // correct a mistap. The list stays mounted; only its BODY empties.
    expect(screen).toContain('data={loading ? [] : rows}');
    expect(screenCode).not.toMatch(/\{loading \? \(\s*<ActivityIndicator/);
  });

  it('does not call a failed load an empty worklist', () => {
    // "Nothing to place" over a failed request is a lie about the data.
    expect(screen).toContain('Pull down to try again.');
  });

  it('drops a stale response when the filter changes mid-flight', () => {
    expect(screen).toContain('const seq = ++seqRef.current;');
    expect(screen).toContain('if (seq !== seqRef.current) return;');
  });
});

// The drawer itself is built by drawerSectionsFor(), but importing that here
// pulls in lucide-react-native, which cannot load under the node test env. So
// these assert the two things it is composed of: the shared registry placement
// (resolveSurface is pure) and the icon-name → component mapping (source pin).
const navIcons = readFileSync(path.resolve(__dirname, './nav-icons.ts'), 'utf8');

describe('staging is registered in the app navigation', () => {
  it('has a drawer screen entry so the route is a real destination', () => {
    expect(drawerLayout).toContain('<Drawer.Screen name="staging"');
  });

  it('appears in the drawer for a role that can read items, right after Items', () => {
    const hrefs = resolveSurface('mobile_drawer', {
      role: 'staff',
      enabledModules: new Set(['inventory']),
    }).flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toContain('/staging');
    expect(hrefs.indexOf('/staging')).toBe(hrefs.indexOf('/inventory') + 1);
  });

  it('resolves a real icon rather than falling back to the generic box', () => {
    const item = resolveSurface('mobile_drawer', {
      role: 'staff',
      enabledModules: new Set(['inventory']),
    })
      .flatMap((s) => s.items)
      .find((i) => i.href === '/staging');
    expect(item?.label).toBe('Staging');
    expect(item?.iconName).toBe('LayoutList');
    // NAV_ICONS must carry that name or the drawer silently falls back to Box.
    expect(navIcons).toContain('LayoutList,');
  });

  it('is hidden from a role without items:read', () => {
    // Permission overrides can strip items:read; the nav must follow.
    const hrefs = resolveSurface('mobile_drawer', {
      role: 'viewer',
      enabledModules: new Set(['inventory']),
      permissions: new Set(),
    }).flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).not.toContain('/staging');
  });
});
