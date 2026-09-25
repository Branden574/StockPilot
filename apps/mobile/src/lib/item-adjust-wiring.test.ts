import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ITEM SCREEN MANUAL ADJUST — WIRING PINS for app/item/[id].tsx.
 *
 * SOURCE-level, like scan-quick-adjust-wiring.test.ts: the vitest config
 * excludes app/ screens (they import native modules at top level), so there is
 * no seam to render. The behaviour behind these call sites — payload, error
 * classification, never-rejects — is unit-tested in item-adjust.test.ts; this
 * file pins that the screen actually uses it.
 */

const screen = readFileSync(path.resolve(__dirname, '../../app/item/[id].tsx'), 'utf8');

/** The body of `async function adjust(...)`, up to the next top-level helper. */
function adjustBody(): string {
  const start = screen.indexOf('async function adjust(');
  const end = screen.indexOf('function refreshAfterAdjust()', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return screen.slice(start, end);
}

describe('item screen — manual adjust goes through the server route', () => {
  it('adjust() sends through submitItemAdjust (POST /api/v1/items/<id>/adjust)', () => {
    expect(screen).toMatch(/import \{ submitItemAdjust \} from '@\/lib\/item-adjust';/);
    expect(adjustBody()).toMatch(/await submitItemAdjust\(itemId, delta, reason\)/);
  });

  it('the four quick buttons send -5, -1, +1 and +5', () => {
    for (const [label, delta] of [
      ['−5', '-5'],
      ['−1', '-1'],
      ['\\+1', '1'],
      ['\\+5', '5'],
    ]) {
      expect(screen).toMatch(
        new RegExp(`<QuickBtn label="${label}" onPress=\\{\\(\\) => void adjust\\(${delta}\\)\\}`),
      );
    }
  });

  it('the "Adjust with reason" sheet sends its delta AND its reason', () => {
    expect(screen).toMatch(
      /onConfirm=\{async \(delta, reason\) => \{\s*await adjust\(delta, reason\);/,
    );
  });

  it('shows the total from the server answer, never the old total plus the delta', () => {
    const body = adjustBody();
    expect(body).not.toMatch(/quantity_on_hand\s*\+\s*delta/);
    expect(body).toMatch(/const q = outcome\.quantityOnHand;/);
    expect(body).toMatch(/quantity_on_hand: q/);
  });

  it('surfaces a refusal and an unconfirmed write to the operator', () => {
    const body = adjustBody();
    expect(body).toMatch(
      /outcome\.kind === 'refused'[\s\S]{0,200}Alert\.alert\(outcome\.alert\.title, outcome\.alert\.message\)/,
    );
    expect(body).toMatch(
      /outcome\.kind === 'unconfirmed'[\s\S]{0,120}setQuantityUnconfirmed\(true\)[\s\S]{0,80}Alert\.alert/,
    );
  });

  it('labels an unconfirmed total on screen until a server read replaces it', () => {
    expect(screen).toMatch(/\{quantityUnconfirmed \? \(/);
    expect(screen).toMatch(/Not confirmed · pull down to refresh/);
    // ...and in the adjust sheet, whose NEW TOTAL preview is built on it.
    expect(screen).toMatch(/quantityUnconfirmed=\{quantityUnconfirmed\}/);
    expect(screen).toMatch(/\{quantityUnconfirmed \? ' · not confirmed' : ''\}/);
    // Cleared only by a server number: load() right before it paints, or the
    // total a saved write returned (asserted in the adjust() pins above).
    expect(screen).toMatch(/setQuantityUnconfirmed\(false\);\s*setItem\(\{/);
  });

  it('load() lets only the newest read paint, so an older read cannot repaint a stale total', () => {
    expect(screen).toMatch(/const seq = \+\+loadSeq\.current;/);
    // After the item read, after the parallel reads, and before painting.
    expect(
      screen.match(/if \(seq !== loadSeq\.current\) return;/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(3);
  });

  it('a failed refresh is not reported as a deleted item', () => {
    expect(screen).toMatch(
      /const \{ data, error \} = await supabase\s*\.from\('inventory_items'\)/,
    );
    expect(screen).toMatch(
      /if \(error\) \{[\s\S]{0,600}if \(paintedItemId\.current === id\) return;/,
    );
  });

  it('hides the adjust controls where the route would refuse them (same gate as the scan tab)', () => {
    expect(screen).toMatch(
      /const canQuickAdjust = showWriteCta\(permissions, 'stock:adjust'\) && item\.status !== 'archived';/,
    );
    expect(screen).toMatch(/\{canQuickAdjust \? \(\s*<>\s*<View style=\{styles\.quickAdjust\}>/);
  });
});
