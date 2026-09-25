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

/** The body of the scan tab's `async function adjust(...)`. */
function adjustBody(): string {
  const start = scan.indexOf('async function adjust(delta: number)');
  const end = scan.indexOf('const unconfirmed = useUnconfirmedStock', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return scan.slice(start, end);
}

describe('scan tab — quick adjust goes through the API, not the RPC', () => {
  it('never calls the adjust_stock RPC directly', () => {
    expect(scan).not.toMatch(/rpc\(\s*'adjust_stock'/);
  });

  it("sends through the item screen's sender (POST /api/v1/items/<id>/adjust)", () => {
    // submitItemAdjust -> adjustItemStock -> the permission-enforcing route;
    // its payload and status handling are unit-tested in item-adjust.test.ts.
    expect(scan).toMatch(/import \{ SCAN_ADJUST_REASON, submitItemAdjust \} from '@\/lib\/item-adjust';/);
    expect(adjustBody()).toMatch(
      /await submitItemAdjust\(itemId, delta, \{\s*defaultReason: SCAN_ADJUST_REASON,\s*shownTotal: item\.quantity_on_hand,\s*\}\)/,
    );
  });

  // Review finding: every error, a timeout or 5xx included, was reported as
  // "Could not adjust", which reads as "nothing happened, tap again" on a
  // write that may have committed.
  it('reports a timeout or 5xx as unconfirmed, never as "Could not adjust"', () => {
    const body = adjustBody();
    expect(body).not.toMatch(/Could not adjust/);
    expect(body).not.toMatch(/catch \(/);
    expect(body).toMatch(
      /outcome\.kind === 'refused'[\s\S]{0,120}Alert\.alert\(outcome\.alert\.title, outcome\.alert\.message\)/,
    );
    expect(body).toMatch(
      /outcome\.kind === 'unconfirmed'[\s\S]{0,120}Alert\.alert\(outcome\.alert\.title, outcome\.alert\.message\);\s*void rereadShownItem\(itemId\);/,
    );
  });

  it('paints only the total the server returned, never the old total plus the delta', () => {
    const body = adjustBody();
    expect(body).not.toMatch(/quantity_on_hand\s*\+\s*delta/);
    expect(body).toMatch(/quantity_on_hand: q \}/);
  });

  it('labels an unconfirmed on-hand and settles it only through the store', () => {
    expect(scan).toMatch(/const unconfirmed = useUnconfirmedStock\(item\?\.id\);/);
    expect(scan).toMatch(/\{unconfirmedScanLabel\(unconfirmed\)\}/);
    // Every read of the card's item reports its total and when it was sent.
    expect(scan).toMatch(
      /const reportRead = unconfirmedStock\.beginRead\(id\);\s*const \{ data: row \} = await supabase/,
    );
    expect(scan).toMatch(/if \(!row\) return null;[\s\S]{0,500}reportRead\(Number\(/);
    // ...and it re-reads once when the bound passes.
    expect(scan).toMatch(/unconfirmedStock\.onBoundPassed\(shownItemId, \(\) => onBoundPassed\(shownItemId\)\)/);
  });

  it('a re-read cannot repaint over a newer answer or onto another item', () => {
    expect(adjustBody()).toMatch(/rereadSeq\.current\+\+;/);
    expect(scan).toMatch(/if \(seq !== rereadSeq\.current \|\| !found\) return;/);
    expect(scan).toMatch(/setItem\(\(prev\) => \(prev && prev\.id === itemId \? found : prev\)\);/);
  });

  // Review finding: the fresh-scan paths painted with a bare setItem(found),
  // which never bumped the re-read guard. Scan an item, adjust it with no
  // answer, tap "Scan next" and scan it again: the first card's re-read could
  // land after the new scan and repaint its older on-hand total over it.
  it('every fresh scan paints through showScannedItem, which supersedes a re-read in flight', () => {
    expect(scan).toMatch(
      /function showScannedItem\(found: FoundItem\) \{\s*rereadSeq\.current\+\+;\s*setItem\(found\);\s*\}/,
    );
    const code = scan.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // The helper's own call is the only bare paint of a looked-up item...
    expect(code.match(/setItem\(found\)/g)?.length).toBe(1);
    // ...and the barcode scan, the placement pick and both "just created"
    // cards all go through it.
    expect(code.match(/showScannedItem\(found\)/g)?.length).toBe(4);
    expect(code).toMatch(/const found = await loadItemById\(candidate\.id\);[\s\S]{0,80}if \(found\) showScannedItem\(found\);/);
  });

  // Same class as the item screen's photo replace: a spread of the copy taken
  // when the upload started repainted any on-hand total painted meanwhile.
  it('the photo upload merges only the photo into the card as it is now', () => {
    expect(scan).not.toMatch(/setItem\(\{\s*\.\.\.item\b/);
    expect(scan).toMatch(
      /setItem\(\(prev\) => \(prev && prev\.id === itemId \? \{ \.\.\.prev, image_url: signedUrl \} : prev\)\);/,
    );
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
