import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * CLASS GUARD: no shipped mobile source calls the adjust-stock RPC directly.
 *
 * Every manual stock adjustment from the phone must go through
 * POST /api/v1/items/<id>/adjust (InventoryService.adjustStock). The raw RPC
 * checks only the staff-role floor (0327), so calling it from the phone skips
 * the 'stock:adjust' permission and the MFA gate, the warehouse write scope,
 * the archived-item refusal, the audit row, the stock.low webhook, the
 * no-Staging rule for a manual add, and the invalidation of the web's cached
 * Items view. The scan tab was moved off it on 2026-09-05 and the item screen
 * on 2026-09-22 (five adjustments in the 30 days before took that path, the
 * only stock writes that skipped the invalidation). This fails the NEXT screen
 * that reaches for it, not just those two (recurring pattern #26).
 *
 * Test files are skipped: they quote the old call shape to explain it. Comments
 * in shipped code are NOT skipped, which is why the explanations in scan.tsx
 * and item-adjust.ts spell the call out in words instead.
 *
 * Known blind spot: an RPC name passed through a variable. Review catches that;
 * a regex cannot.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const SCANNED_DIRS = ['app', 'src'].map((d) => path.join(MOBILE_ROOT, d));

/** `.rpc('adjust_stock'` in any quoting, spacing or line break. */
const DIRECT_ADJUST_RPC = /\brpc\s*\(\s*['"`]adjust_stock['"`]/;

function shippedSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...shippedSourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('no direct adjust-stock RPC anywhere in apps/mobile', () => {
  const files = SCANNED_DIRS.flatMap((d) => shippedSourceFiles(d));
  const rel = (f: string) => path.relative(MOBILE_ROOT, f);

  it('scans the screens that used to call it (vacuity control)', () => {
    const scanned = files.map(rel);
    expect(scanned).toContain(path.join('app', 'item', '[id].tsx'));
    expect(scanned).toContain(path.join('app', '(drawer)', '(tabs)', 'scan.tsx'));
    expect(files.length).toBeGreaterThan(100);
  });

  it('the pattern recognises every shape the old call took', () => {
    expect(DIRECT_ADJUST_RPC.test(`await supabase.rpc('adjust_stock', {`)).toBe(true);
    expect(DIRECT_ADJUST_RPC.test(`supabase.rpc(\n  "adjust_stock",\n {`)).toBe(true);
    expect(DIRECT_ADJUST_RPC.test('supabase.rpc(`adjust_stock`)')).toBe(true);
    // ...and not the outbox kind, the label map, or the route path.
    expect(DIRECT_ADJUST_RPC.test(`case 'adjust_stock': {`)).toBe(false);
    expect(DIRECT_ADJUST_RPC.test(`adjust_stock: 'Stock adjustment',`)).toBe(false);
    expect(DIRECT_ADJUST_RPC.test('`/api/v1/items/${id}/adjust`')).toBe(false);
  });

  it('finds no file that calls it', () => {
    const offenders = files.filter((f) => DIRECT_ADJUST_RPC.test(readFileSync(f, 'utf8'))).map(rel);
    expect(offenders, 'route the write through /api/v1/items/<id>/adjust instead').toEqual([]);
  });
});
