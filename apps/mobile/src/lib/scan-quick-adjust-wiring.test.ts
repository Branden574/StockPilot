import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * SCAN TAB QUICK ADJUST — WIRING PINS.
 *
 * The scan screen's ±1/+5/+25 buttons used to call the `adjust_stock` RPC
 * DIRECTLY (`supabase.rpc('adjust_stock', { ..., p_location_id: null })`). That
 * RPC checks only the staff-ROLE floor (0327) while every web adjustment runs
 * through InventoryService.adjustStock, which asserts the 'stock:adjust'
 * PERMISSION — so an admin who revoked stock:adjust from a staffer (a 0207
 * override) still had every phone tap succeed. The same direct call skipped the
 * service's archived-item refusal, its "a manual add must NOT land in Staging"
 * location resolution, its draw mode 'any' for null-location removals (the L4L
 * 2026-08-17 `insufficient_placed_stock` incident), its audit row and its
 * stock.low webhook.
 *
 * These are SOURCE-level assertions because the vitest config deliberately
 * excludes app/ screens from compilation (they import native modules at top
 * level), so there is no unit seam to call — same technique as
 * expected-exclusion-screens.test.ts.
 */

const scan = readFileSync(
  path.resolve(__dirname, '../../app/(drawer)/(tabs)/scan.tsx'),
  'utf8',
);

describe('scan tab — quick adjust goes through the API, not the RPC', () => {
  it('never calls the adjust_stock RPC directly', () => {
    expect(scan).not.toMatch(/rpc\(\s*'adjust_stock'/);
  });

  it('POSTs to the permission-enforcing /api/v1/items/<id>/adjust route', () => {
    expect(scan).toMatch(/\/api\/v1\/items\/\$\{item\.id\}\/adjust/);
    expect(scan).toMatch(/method:\s*'POST'/);
  });

  it('hides the quick-adjust buttons from a member without stock:adjust', () => {
    // Cosmetic gate only — the route enforces it server-side — but a button
    // that always 403s is a bug report waiting to happen.
    expect(scan).toMatch(/showWriteCta\(permissions,\s*'stock:adjust'\)/);
  });

  it('reads item status so an ARCHIVED item never offers an adjustment', () => {
    // The service refuses an archived item ("Unarchive it first"); the screen
    // must not offer the tap. That needs `status` in the detail select.
    expect(scan).toMatch(/quantity_on_hand[\s\S]{0,200}status/);
    expect(scan).toMatch(/status !== 'archived'/);
  });
});
