import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * WIRING PINS for the PO import review screen and the PO receive screen. Both
 * import native modules, so vitest cannot render them; the reads live in
 * lib/id-reads.ts and the wording in lib/po-import-approve.ts (tested there),
 * and these pins keep the screens wired to them and to a VISIBLE failure.
 */

const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');
const importScreen = read('../../app/po-import/[id].tsx');
const poScreen = read('../../app/po/[id].tsx');

/** The text between `start` and the next `end` after it. */
function between(src: string, start: string, end: string): string {
  const a = src.indexOf(start);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(end, a + start.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('PO import review: item names', () => {
  const load = () => between(importScreen, 'const load = React.useCallback(async () => {', '}, [id, orgId, loadLineage]);');

  it('reads the names batched through readItemRefs, never an unbatched in()', () => {
    expect(load()).toContain('await settleIdBatchRead(readItemRefs(supabase, orgId, refIds));');
    expect(importScreen).not.toContain(".from('inventory_items')");
  });

  it('a failed lookup sets the flag and an empty map; a good one clears it', () => {
    expect(load()).toMatch(
      /if \(refs\.ok\) \{\s*setItemsById\(refs\.value\);\s*setItemNamesError\(null\);\s*\} else \{[\s\S]*?setItemsById\(\{\}\);\s*setItemNamesError\(refs\.message\);/,
    );
  });

  it('a clean load clears an earlier refresh failure, and a refresh failure over a loaded import is shown', () => {
    expect(load()).toMatch(/if \(hErr \|\| lErr\) \{[\s\S]*?return;\s*\}[\s\S]*?setLoadError\(null\);/);
    // `||`, not `??`: an empty gateway error body is an empty message, which
    // would render a blank screen instead of the failure.
    expect(load()).toContain(
      "setLoadError(hErr?.message || lErr?.message || 'Could not load this import.');",
    );
    expect(importScreen).toContain('Could not refresh this import: {loadError}. Pull down to try again.');
  });

  it('says the names did not load, and each line card uses lineMatchLabel', () => {
    expect(importScreen).toContain('Item names did not load. Pull down to try again.');
    expect(importScreen).toContain('const match = lineMatchLabel(line, itemsById, namesFailed);');
    expect(importScreen).toContain('namesFailed={itemNamesError !== null}');
  });

  it('Approve is refused while the names have failed: the button, its handler and the sheet', () => {
    expect(importScreen).toContain('disabled={actionBusy !== null || itemNamesError !== null}');
    expect(importScreen).toMatch(/onPress=\{\(\) => \{\s*if \(itemNamesError !== null\) return;\s*setActionError\(null\);\s*setApproveOpen\(true\);/);
    expect(importScreen).toContain(
      'Approve is unavailable until item names load, so every line can be checked',
    );
    expect(importScreen).toMatch(/const canSubmit =[\s\S]*?!namesFailed &&[\s\S]*?;/);
  });
});

describe('PO import approve sheet: vendor, charter and location choices', () => {
  it('binds all three read errors instead of showing "No suppliers yet" / "No charters configured"', () => {
    expect(importScreen).toContain(
      'vendorsRes.error?.message ?? chartersRes.error?.message ?? locationsRes.error?.message ?? null;',
    );
    expect(importScreen).toContain('setPickersError(pickerFailure);');
  });

  it('a failure withholds the choices and refuses Approve', () => {
    expect(importScreen).toMatch(/\) : pickersError !== null \? \(\s*<View[^>]*>\s*<Body[^>]*>\s*Could not load the vendor, charter and location choices\./);
    expect(importScreen).toMatch(/const canSubmit =[\s\S]*?pickersError === null;/);
  });
});

describe('PO receive: size runs', () => {
  const loader = () => between(poScreen, 'const loadRunGroups = React.useCallback(', '[orgId],');

  it('reads groups and their sizes through readPoRunGroups (batched, both errors checked)', () => {
    expect(loader()).toContain('await settleIdBatchRead(readPoRunGroups(supabase, orgId, groupIds));');
    expect(poScreen).not.toContain(".from('product_groups')");
    expect(poScreen).not.toContain(".from('size_scale_values')");
  });

  it('a failure degrades to flat cards WITH the notice flag; a good read clears it', () => {
    expect(loader()).toMatch(
      /if \(read\.ok\) \{\s*setGroups\(read\.value\);\s*setGroupsDegraded\(false\);\s*\} else \{[\s\S]*?setGroups\(\{\}\);\s*setGroupsDegraded\(true\);/,
    );
    // No groups to read also clears it.
    expect(loader()).toMatch(/setGroups\(\{\}\);\s*setGroupsDegraded\(false\);\s*return;/);
  });

  it('shows the notice with a guarded Try again', () => {
    expect(poScreen).toContain('Size runs did not load, so lines are shown one by one. Receiving still works.');
    expect(poScreen).toMatch(/onPress=\{\(\) => void retryPart\('groups'\)\}\s*disabled=\{retryingPart !== null\}/);
  });
});

describe('PO receive: receipt history', () => {
  const loader = () => between(poScreen, 'const loadReceiptHistory = React.useCallback(async () => {', '}, [id, orgId]);');

  it('totals are paged and batched through readReceiptTotals; the clamped .limit(5000) read is gone', () => {
    expect(loader()).toContain('await settleIdBatchRead(readReceiptTotals(supabase, receiptIds));');
    expect(poScreen).not.toContain(".from('receipt_lines')");
    // (The comment explaining the old cap may mention it; code may not.)
    expect(poScreen).not.toMatch(/^\s*\.limit\(5000\)/m);
  });

  it('a failed receipts OR totals read says so instead of zero totals; a good one clears it', () => {
    const body = loader();
    expect(body).toContain('const { data: receiptRows, error: receiptsErr } = await supabase');
    expect(body).toMatch(/if \(receiptsErr\) \{[\s\S]*?setReceipts\(\[\]\);\s*setReceiptsError\(receiptsErr\.message\);\s*return;/);
    expect(body).toMatch(/if \(!totals\.ok\) \{[\s\S]*?setReceipts\(\[\]\);\s*setReceiptsError\(totals\.message\);\s*return;/);
    expect(body).toMatch(/setReceiptsError\(null\);\s*$/);
  });

  it('renders the failure in place of the history, with a guarded Try again', () => {
    expect(poScreen).toContain('Receipt history did not load, so past receipts and their totals are not shown.');
    expect(poScreen).toMatch(/onPress=\{\(\) => void retryPart\('history'\)\}\s*disabled=\{retryingPart !== null\}/);
    expect(poScreen).toContain('{receiptsError === null && receipts.length > 0 && (');
    expect(poScreen).toMatch(/async function retryPart\(part: 'groups' \| 'history'\) \{\s*if \(retryingPart !== null\) return;/);
  });
});
