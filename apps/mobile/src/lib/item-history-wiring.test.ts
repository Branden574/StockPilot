import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Item history sheet — WIRING PINS for src/components/item-history-sheet.tsx
 * and its entry point on app/(drawer)/staging.tsx.
 *
 * The display logic is pure + tested in item-history.test.ts and, above that,
 * in @stockpilot/core's movement-history.test.ts. Neither the sheet nor the
 * screen can be rendered here (the vitest config deliberately excludes app/
 * screens — they import native modules at load), so these source-level
 * assertions pin the load-bearing wiring a refactor could otherwise drop
 * silently. Every one of them encodes a specific past failure:
 *
 *   1. rows come from the SHARED service via GET /api/v1/items/[id]/history —
 *      never a second Supabase query, which is exactly the web/mobile
 *      divergence this whole feature exists to end;
 *   2. every word on a movement comes from @stockpilot/core's
 *      formatHistoryMovement, so the phone and the browser read identically;
 *   3. the timestamp is formatted in the VIEWER's timezone;
 *   4. paging is driven by the SERVER's hasMore, never by a client-side guess
 *      at how much data exists — three defects in this codebase have come from
 *      a constant that guessed the server's row cap;
 *   5. the staging row's own cells (source PO/receipt, received, age, Stale)
 *      are untouched: this feature adds a view, it does not re-derive the list.
 */

const sheet = readFileSync(
  path.resolve(__dirname, '../components/item-history-sheet.tsx'),
  'utf8',
);
const screen = readFileSync(path.resolve(__dirname, '../../app/(drawer)/staging.tsx'), 'utf8');

/**
 * Source with comments stripped. The negative assertions below are about what
 * these files DO; their own doc-comments explain in prose why they avoid those
 * things, and that prose must not trip its own pins.
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const sheetCode = codeOnly(sheet);
const screenCode = codeOnly(screen);

describe('item history sheet wiring', () => {
  it('reads the ledger from the shared endpoint, never a second query', () => {
    expect(sheet).toContain('itemHistoryPath(itemId');
    expect(sheet).toContain('parseItemHistoryPage(res)');
    expect(sheetCode).not.toContain("from('stock_movements')");
    expect(sheetCode).not.toContain("from('receipts')");
    expect(sheetCode).not.toContain("from('locations')");
    expect(sheetCode).not.toContain('supabase');
  });

  it('words every movement through the ONE shared formatter', () => {
    expect(sheet).toContain("from '@stockpilot/core'");
    expect(sheet).toContain('formatHistoryMovement(row)');
    // No movement may be worded in this file: an inline conditional string is
    // how two surfaces drift apart one row state at a time.
    expect(sheetCode).not.toContain("'Stock received'");
    expect(sheetCode).not.toContain("'Stock added'");
    expect(sheetCode).not.toContain("'Reversed later");
    expect(sheetCode).not.toContain("'Customer return");
  });

  it('renders the timestamp in the viewer’s timezone', () => {
    expect(sheet).toContain('formatHistoryWhen(f.whenIso)');
    // The formatter deliberately does no date formatting — a hand-rolled
    // toLocaleString here would drift from web's <LocalDateTime>.
    expect(sheetCode).not.toContain('toLocaleString(');
    expect(sheetCode).not.toContain('toLocaleDateString(');
  });

  it('never dresses an absent fact up as a fact', () => {
    // A null from the formatter means "we have nothing to say here", and the
    // line is omitted. No em dash, no "System" standing in for an actor.
    expect(sheet).toContain('if (!value) return null;');
    // Both numbers a movement can carry are rendered; `??` between them would
    // silently drop one.
    expect(sheet).toContain('historyAmountLines(f)');
    expect(sheetCode).not.toContain('f.deltaLabel ?? f.movedLabel');
    expect(sheetCode).not.toContain("'System'");
    expect(sheetCode).not.toContain("'—'");
    expect(sheetCode).not.toContain('Invalid Date');
  });

  it('pages on the server’s word, not on a client-side guess', () => {
    expect(sheet).toContain('setHasMore(page.hasMore)');
    expect(sheet).toContain('setOffset(nextHistoryOffset(page))');
    expect(sheet).toContain('appendHistoryMovements(prev, page.rows)');
    // Inferring "there must be more" from a page looking full is how a paging
    // loop asks forever.
    expect(sheetCode).not.toMatch(/rows\.length\s*[=><]==?\s*ITEM_HISTORY_PAGE_SIZE/);
  });

  it('does not call a failed request an empty ledger', () => {
    expect(sheet).toContain('Try again.');
    expect(sheet).toContain('No stock movements recorded for this item.');
    // D3: the same rule applies to the HEADER counter, which renders as soon as
    // `loading` clears. Passing the read's outcome is what stops it printing
    // "0 movements" for a page that never arrived.
    expect(sheet).toContain('historyProgressLabel(rows.length, total, error !== null)');
  });

  it('drops a stale response when the sheet is reopened on another row', () => {
    expect(sheet).toContain('const seq = ++seqRef.current;');
    expect(sheet).toContain('if (seq !== seqRef.current) return;');
  });
});

describe('the staging row opens it', () => {
  it('offers History on every row and opens the sheet for that item', () => {
    expect(screen).toContain('onOpenHistory={() => setViewingHistory(item)}');
    expect(screen).toContain('<ItemHistorySheet');
    expect(screen).toContain('itemId={viewingHistory.itemId}');
    // Outside the canPlace/disabledReason branch — a row that cannot be placed
    // is precisely the row whose provenance is being questioned.
    expect(screen).toMatch(/onPress=\{onOpenHistory\}[\s\S]{0,200}History\s*<\/Button>/);
  });

  it('leaves the worklist row itself completely untouched', () => {
    // The safety property of this approach: a history VIEW cannot regress the
    // PO attribution or reset the row date and delete the Stale badge, because
    // it does not touch either. Both still come from stagedWorklist().
    expect(screen).toContain('stagingSourceLabel(row.sourcePoNumber, row.receiptNumber)');
    expect(screen).toContain('stagingReceivedLabel(row.receivedAt)');
    expect(screen).toContain('stagingAgeLabel(row.ageDays)');
    expect(screen).toContain('{STAGING_STALE_LABEL}');
    // Nothing on this screen may recompute an age or a received date from
    // movement rows — that is exactly what the second reverted attempt did.
    expect(screenCode).not.toContain('itemHistoryPath');
    expect(screenCode).not.toContain('formatHistoryMovement');
  });
});
