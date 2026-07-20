import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Expected-items visibility (mig 0277) — WIRING PINS for the two summary
 * screens whose count queries live inline in the components (no lib seam to
 * unit-test, and the vitest config deliberately excludes app/ screens from
 * compilation). These source-level assertions pin the load-bearing
 * predicates so a refactor can't silently drop them:
 *
 *   1. HOME out-of-stock tile: a PO-created item awaiting its FIRST
 *      receipt was never in stock, so the head-count must carry
 *      eq('awaiting_first_receipt', false) — same predicate the Items
 *      list (inventory.tsx) and Reports out-of-stock count apply.
 *   2. HOME + REPORTS low-stock tiles: the low_stock_count RPC (0004)
 *      pre-dates the flag and cannot exclude phantoms, so both screens
 *      must run the flagged-slice count (flag=true, reorder_point>0 —
 *      mirroring the RPC's predicate) and subtract it client-side.
 */

const read = (rel: string): string =>
  readFileSync(path.resolve(__dirname, rel), 'utf8');

const home = read('../../app/(drawer)/(tabs)/index.tsx');
const reports = read('../screens/reports.tsx');

describe('mobile HOME dashboard — expected-items exclusion (mig 0277)', () => {
  it('the out-of-stock tile count excludes awaiting-first-receipt phantoms', () => {
    expect(home).toContain(".eq('awaiting_first_receipt', false)");
  });

  it('the low-stock tile subtracts the flagged slice from the low_stock_count RPC', () => {
    expect(home).toContain("supabase.rpc('low_stock_count'");
    expect(home).toContain(".eq('awaiting_first_receipt', true)");
    expect(home).toContain(".gt('reorder_point', 0)");
    expect(home).toMatch(/Math\.max\(\s*0,\s*\(typeof lowRpc\.data === 'number' \? lowRpc\.data : 0\) - \(flaggedLow\.count \?\? 0\)/);
  });
});

describe('mobile REPORTS screen — expected-items exclusion (mig 0277)', () => {
  it('the out-of-stock count excludes awaiting-first-receipt phantoms', () => {
    expect(reports).toContain(".eq('awaiting_first_receipt', false)");
  });

  it('the low-stock count subtracts the flagged slice from the low_stock_count RPC', () => {
    expect(reports).toContain("supabase.rpc('low_stock_count'");
    expect(reports).toContain(".eq('awaiting_first_receipt', true)");
    expect(reports).toContain(".gt('reorder_point', 0)");
    expect(reports).toMatch(/Math\.max\(\s*0,\s*\(typeof lowRpc\.data === 'number' \? lowRpc\.data : 0\) - \(flaggedLow\.count \?\? 0\)/);
  });
});
