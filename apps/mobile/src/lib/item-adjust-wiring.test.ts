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
  it('adjust() sends through submitItemAdjust (POST /api/v1/items/<id>/adjust) with the total on screen', () => {
    expect(screen).toMatch(/import \{ submitItemAdjust, type ItemAdjustOutcome \} from '@\/lib\/item-adjust';/);
    // shownTotal is what lets the unconfirmed-stock store recognise a read
    // that shows this write.
    expect(adjustBody()).toMatch(
      /await submitItemAdjust\(itemId, delta, \{\s*reason,\s*shownTotal: item\.quantity_on_hand,\s*offline: \{/,
    );
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
      /onConfirm=\{async \(delta, reason\) => \{\s*const kind = await adjust\(delta, reason\);/,
    );
  });

  // Review finding: a refused request closed the sheet and threw away the
  // typed change and reason. Only a refusal keeps it open: after an
  // unconfirmed write, a sheet still holding the change is one tap from
  // applying it twice.
  it('keeps the sheet open, with its input, when the request is refused', () => {
    const confirm = screen.slice(
      screen.indexOf('onConfirm={async (delta, reason) => {'),
      screen.indexOf('<MoveStockModal'),
    );
    expect(confirm).toMatch(/if \(kind !== 'refused'\) setAdjustOpen\(false\);/);
    // Exactly one close, and it is the conditional one.
    expect(confirm.match(/setAdjustOpen\(false\)/g)?.length).toBe(1);
    // adjust() hands the kind back on every path, so a refusal is told apart.
    expect(adjustBody()).toMatch(/Promise<ItemAdjustOutcome\['kind'\] \| null>/);
    expect(adjustBody().match(/return outcome\.kind;/g)?.length).toBe(4);
    // The sheet's draft survives because its content is keyed on `visible`
    // (reset-by-remount), which a refusal no longer flips.
    expect(screen).toMatch(/<AdjustModalContent\s*key=\{String\(visible\)\}/);
  });

  // OFFLINE (adjust-outbox.ts): with no connection at the tap the adjustment
  // is saved in the S4 outbox, stamped with its workspace and account by
  // queue.ts enqueue(), and sent later through the same route, at most once.
  it('queues an adjustment made with no connection, as outbox kind adjust_stock', () => {
    expect(screen).toMatch(/import \{ enqueue, pendingAdjustFor \} from '@\/lib\/queue';/);
    expect(screen).toMatch(/import \{ isOnline, syncNow \} from '@\/lib\/sync';/);
    const body = adjustBody();
    expect(body).toMatch(
      /offline: \{\s*isOnline,[\s\S]{0,120}enqueue: \(payload\) => enqueue\(ADJUST_STOCK_KIND, payload\),\s*itemLabel:/,
    );
    // A queued change is said, the note re-read and the badge refreshed; the
    // total on screen is not touched (nothing was sent).
    const queued = body.slice(body.indexOf("if (outcome.kind === 'queued')"));
    expect(queued).toMatch(
      /^if \(outcome\.kind === 'queued'\) \{[\s\S]{0,200}Alert\.alert\(outcome\.alert\.title, outcome\.alert\.message\);\s*void refreshQueuedAdjust\(\);[\s\S]{0,120}void cycleCountSync\.refreshPendingCount\(\);\s*return outcome\.kind;/,
    );
    expect(queued.slice(0, queued.indexOf('return outcome.kind;'))).not.toMatch(/setItem|refreshAfterAdjust/);
  });

  it('says beside ON HAND and in the sheet what is queued and not in the number yet', () => {
    expect(screen).toMatch(/\{queuedAdjust\.count > 0 \? \(/);
    expect(screen).toMatch(/\{queuedOnHandLabel\(queuedAdjust\)\}/);
    expect(screen).toMatch(/`Queued offline · \$\{what\} · sends when online`/);
    expect(screen).toMatch(/`\$\{q\.count\} changes, net \$\{formatQueuedNet\(q\.net\)\}`/);
    expect(screen).toMatch(/queuedNet=\{queuedAdjust\.count > 0 \? queuedAdjust\.net : null\}/);
    expect(screen).toMatch(/queued offline` : ''\}/);
  });

  it('re-reads the item when a queued change leaves the outbox, and sends queued changes once online', () => {
    expect(screen).toMatch(/const drained = next\.count < queuedCountSeen\.current;/);
    expect(screen).toMatch(/if \(drained\) load\(\)/);
    expect(screen).toMatch(
      /\}, \[syncStatus\.pendingCount, syncStatus\.status, refreshQueuedAdjust\]\);/,
    );
    expect(screen).toMatch(
      /next\.count === 0 \|\| syncStatus\.status === 'offline'\) return;\s*await syncNow\(\);/,
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
      /outcome\.kind === 'unconfirmed'[\s\S]{0,200}Alert\.alert\(outcome\.alert\.title, outcome\.alert\.message\);\s*refreshAfterAdjust\(\);/,
    );
  });

  it('labels an unconfirmed total from the app-wide store, card and sheet', () => {
    expect(screen).toMatch(/const unconfirmed = useUnconfirmedStock\(id\);/);
    expect(screen).toMatch(/\{unconfirmed \? \(/);
    expect(screen).toMatch(/\{unconfirmedOnHandLabel\(unconfirmed\)\}/);
    expect(screen).toMatch(/'Not confirmed · may still be saving'/);
    expect(screen).toMatch(/'Not confirmed · pull down to refresh'/);
    // ...and in the adjust sheet, whose NEW TOTAL preview is built on it.
    expect(screen).toMatch(/unconfirmed=\{unconfirmed\}/);
    expect(screen).toMatch(/\{unconfirmed \? ' · not confirmed' : ''\}/);
  });

  // Review finding: the automatic re-read after an unconfirmed outcome cleared
  // the label on ANY read, so a read that beat a still-running write painted
  // the pre-write total as current. load() now only REPORTS its read, with the
  // time it was sent; the store decides (unconfirmed-stock.test.ts).
  it('load() never clears the doubt by itself: it reports the read and when it was sent', () => {
    expect(screen).not.toMatch(/setQuantityUnconfirmed/);
    expect(screen).toMatch(
      /const reportRead = unconfirmedStock\.beginRead\(id\);\s*const \{ data, error \} = await supabase\s*\.from\('inventory_items'\)/,
    );
    expect(screen).toMatch(/reportRead\(Number\(r\.quantity_on_hand\) \|\| 0\);\s*setItem\(\{/);
  });

  it('re-reads once when the bound passes, so the label settles without a pull', () => {
    expect(screen).toMatch(
      /return unconfirmedStock\.onBoundPassed\(id, \(\) => \{\s*load\(\)\.catch/,
    );
  });

  it('load() lets only the newest read paint, so an older read cannot repaint a stale total', () => {
    expect(screen).toMatch(/const seq = \+\+loadSeq\.current;/);
    // After the item read, after the parallel reads, and before painting.
    expect(
      screen.match(/if \(seq !== loadSeq\.current\) return;/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(3);
  });

  // Review finding: replacing the photo repainted the item from the copy taken
  // when the upload started (setItem({ ...item, imageUrl })), so an adjustment
  // saved during a slow upload was painted back to the old on-hand total.
  it('a photo replace merges only the photo into the item as it is now', () => {
    expect(screen).toMatch(
      /setItem\(\(prev\) => \(prev && prev\.id === itemId \? \{ \.\.\.prev, imageUrl: signedUrl \} : prev\)\);/,
    );
    // No handler repaints the item from a copy it captured earlier; the only
    // whole-item paint is load()'s fresh read.
    expect(screen).not.toMatch(/setItem\(\{\s*\.\.\.item\b/);
    expect(screen.match(/setItem\(\{/g)?.length).toBe(1);
    expect(screen).toMatch(/reportRead\(Number\(r\.quantity_on_hand\) \|\| 0\);\s*setItem\(\{/);
  });

  it('restore merges its status flip into the item as it is now', () => {
    expect(screen).toMatch(
      /setItem\(\(prev\) =>\s*prev && prev\.id === itemId \? \{ \.\.\.prev, status: 'active', auto_archived: false \} : prev,?\s*\);/,
    );
  });

  it('a failed refresh is not reported as a deleted item', () => {
    expect(screen).toMatch(
      /const \{ data, error \} = await supabase\s*\.from\('inventory_items'\)/,
    );
    expect(screen).toMatch(
      /if \(error\) \{[\s\S]{0,600}if \(paintedItemId\.current === id\) return;/,
    );
  });

  // Review finding: two stock:adjust gates on one screen that disagreed (the
  // quick adjust on showWriteCta, "Remove from rack" on manager-or-role).
  it('derives every stock:adjust control on the screen from ONE gate', () => {
    expect(screen).toMatch(
      /const canAdjustStock = showWriteCtaForRole\(role, permissions, 'stock:adjust'\);/,
    );
    expect(screen).toMatch(/const canQuickAdjust = canAdjustStock && item\.status !== 'archived';/);
    expect(screen).toMatch(/\{canQuickAdjust \? \(\s*<>\s*<View style=\{styles\.quickAdjust\}>/);
    expect(screen).toMatch(
      /\{canAdjustStock && item\.status !== 'archived' && item\.quantity_on_hand > 0 \? \(/,
    );
    // No second derivation of the same permission anywhere in the code.
    const code = screen.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code.match(/'stock:adjust'/g)?.length).toBe(1);
  });
});
