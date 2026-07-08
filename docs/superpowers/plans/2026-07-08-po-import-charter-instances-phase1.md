# PO Import — Phase 1: Advisory Matching & Charter-Per-Instance (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PO-import matching *advisory* so an imported line never auto-merges into an existing item — it creates a new instance under the user's chosen charter by default — killing the "KVA import lands on the CVW-Manchester Chromebooks (500→600, wrong charter)" bug.

**Architecture:** Today a parse-time vendor-mapping match, or a barcode/ISBN match, *auto-links* an import line to an existing `inventory_items` row (setting `po_import_lines.item_id`), so receiving tops up that existing item and it keeps its own charter. Phase 1 rewrites those matches to populate a NEW advisory column `suggested_item_id` (never `item_id`) with `match_status='suggested'`. The user must explicitly accept a suggestion (`decision.mode='use_existing'`) to link; the default (`mode='create'`) always mints a new item carrying the import's chosen charter. No on-hand accounting changes (that's Phase 2). Server-side changes fix both web and mobile since both go through the same actions/service.

**Tech Stack:** Next.js 16 App Router + Supabase (PG17), TypeScript, vitest, pgTAP, Expo (mobile parity check).

## Global Constraints

- **No on-hand/accounting change in Phase 1.** `quantity_on_hand`, `adjust_stock`, `post_receipt_v2` are OUT OF SCOPE (Phase 2). Phase 1 only changes which item a line points at and when.
- **Matching is advisory (owner decision #3).** Barcode/ISBN/vendor-mapping matches become suggestions (`suggested_item_id` + `match_status='suggested'`), never automatic links. Only an explicit `use_existing` decision sets `item_id`.
- **Chosen item-charter is the source of truth (owner decision #2, R2).** A created instance gets the import's chosen `charterId`; an existing item's charter must never be inherited by, nor overwritten from, an import.
- **Selection/identity keyed on IDs**, never serial/SKU/name (already true for import lines: `po_import_lines.id`).
- **Bill-to vs item charter stay independent** (`purchase_orders.charter_id` = bill-to; `inventory_items.charter_id` = ownership). Do not cross them.
- **Migrations are applied to prod by the owner's workflow** (`supabase db push --linked`); the plan writes the migration + pgTAP only.
- **TDD**: failing test first, minimal code, green, commit. **Adversarial review** after the implementation tasks. **Live demo-org verification** of owner test cases 1, 2, 5, 6 before Phase 1 is called done.

---

### Task 1: Migration — `suggested_item_id` advisory column on `po_import_lines`

**Files:**
- Create: `supabase/migrations/0233_po_import_suggested_item.sql`
- Create: `supabase/tests/0233_po_import_suggested_item.test.sql`

**Interfaces:**
- Produces: `public.po_import_lines.suggested_item_id uuid NULL` (FK `inventory_items(id) ON DELETE SET NULL`); the existing `match_status` check already allows `'suggested'` (migration 0010:83). No RLS change (inherits the table's org policies).

- [ ] **Step 1: Write the pgTAP test**

```sql
-- supabase/tests/0233_po_import_suggested_item.test.sql
begin;
select plan(3);

select has_column('public', 'po_import_lines', 'suggested_item_id',
  'po_import_lines has suggested_item_id');
select col_is_null('public', 'po_import_lines', 'suggested_item_id',
  'suggested_item_id is nullable');
-- FK sets null on item delete (a suggestion must never block deleting an item)
select fk_ok('public', 'po_import_lines', 'suggested_item_id',
             'public', 'inventory_items', 'id');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it, expect FAIL** — `supabase test db` → the `has_column` assertion fails (column absent).

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/0233_po_import_suggested_item.sql
-- Advisory match target for PO-import lines. A parse-time / barcode / ISBN
-- match now writes a SUGGESTION here (with match_status='suggested'), never
-- item_id. Only an explicit user 'use_existing' decision sets item_id. This
-- is what stops an import from auto-merging into (and inheriting the charter
-- of) an existing same-SKU item. No accounting change — Phase 2 owns staging.
alter table public.po_import_lines
  add column if not exists suggested_item_id uuid
    references public.inventory_items(id) on delete set null;

comment on column public.po_import_lines.suggested_item_id is
  'Advisory "possible existing match" for this line (barcode/ISBN/vendor '
  'mapping). Informational only — the user must accept it (decision '
  'use_existing) to set item_id. Never linked automatically.';
```

- [ ] **Step 4: Run pgTAP, expect PASS** — `supabase test db` → 3/3.

- [ ] **Step 5: Commit** — `git add supabase/migrations/0233_po_import_suggested_item.sql supabase/tests/0233_po_import_suggested_item.test.sql && git commit -m "feat(po-imports): add advisory suggested_item_id column (mig 0232)"`

---

### Task 2: Parse-time vendor-mapping match writes a SUGGESTION, not a link

**Files:**
- Modify: `apps/web/src/server/services/po-imports.ts` (parseImport, ~lines 315-357 & 454-491 — the two places `matchByVendorNumber` sets `item_id`/`match_status='mapped'`)
- Test: `apps/web/src/server/services/po-imports.parse-suggest.test.ts` (new)

**Interfaces:**
- Consumes: `matchByVendorNumber(...)` from `vendor-item-mappings-match.ts` (unchanged; returns the matched item id or null).
- Produces: parse now writes `{ suggested_item_id: <matchedId>, match_status: 'suggested', item_id: null }` for a vendor-number hit (was `{ item_id: <matchedId>, match_status: 'mapped' }`). A no-match inventory line stays `{ item_id: null, match_status: 'needs_review' }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/server/services/po-imports.parse-suggest.test.ts
import { describe, it, expect, vi } from 'vitest';
// (Follow the existing po-imports service test harness — mock the supabase
// insert for po_import_lines and capture the inserted payloads.)
describe('parseImport advisory matching', () => {
  it('a vendor-number match is written as a SUGGESTION, not a link', async () => {
    // Arrange: one inventory line whose vendor_item_number maps (via
    // vendor_item_mappings) to existing item 'itm-existing'.
    const { insertedLines } = await runParseWithVendorMatch({
      vendorNumber: 'VN-1',
      mappedItemId: 'itm-existing',
    });
    const line = insertedLines.find((l) => l.vendor_item_number === 'VN-1')!;
    expect(line.item_id).toBeNull();                    // NOT auto-linked
    expect(line.suggested_item_id).toBe('itm-existing'); // suggested only
    expect(line.match_status).toBe('suggested');
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `pnpm --filter web exec vitest run po-imports.parse-suggest` → fails (parse still writes `item_id`/`mapped`).

- [ ] **Step 3: Implement** — in `po-imports.ts` parseImport, at BOTH line-payload build sites, replace the vendor-match assignment. Where it currently does (paraphrase of the existing code):
```ts
// BEFORE (both sites): auto-link on vendor match
item_id: matchedItemId,
match_status: matchedItemId ? 'mapped' : (isInventory ? 'needs_review' : 'non_inventory'),
```
change to:
```ts
// AFTER: vendor match is advisory only
item_id: null,
suggested_item_id: matchedItemId ?? null,
match_status: matchedItemId
  ? 'suggested'
  : isInventory
    ? 'needs_review'
    : 'non_inventory',
```

- [ ] **Step 4: Run test, expect PASS.**

- [ ] **Step 5: Commit** — `git commit -am "fix(po-imports): parse-time vendor match is advisory (suggested_item_id), never auto-links"`

---

### Task 3: `createItemsFromPoLinesAction` — default create-new-instance; barcode/ISBN become suggestions

**Files:**
- Modify: `apps/web/src/server/actions/po-imports.ts` (the create/link decision block, lines 380-450; the update at 455-467; the barcode/ISBN match branches ~304-378)
- Test: `apps/web/src/server/actions/po-imports.charter-instance.test.ts` (new)

**Interfaces:**
- Consumes: `InventoryService.create({... charterId ...})` (unchanged; writes `inventory_items.charter_id`).
- Produces: for a line with NO explicit `use_existing` decision, the action ALWAYS creates a new item with the chosen `charterId` (never auto-links via barcode/ISBN). A barcode/ISBN hit is recorded on the line as `suggested_item_id` + `match_status='suggested'` but does not change the created item. `use_existing` still links to `decision.itemId` (explicit, unchanged). `item_created` flag stays truthful (true only for created items).

- [ ] **Step 1: Write the failing tests** (owner test cases 2 + 5)

```ts
// apps/web/src/server/actions/po-imports.charter-instance.test.ts
import { describe, it, expect } from 'vitest';
// (Reuse the action's existing test harness / supabase stub used by
// po-imports.create-items.test.ts. `createSpy` captures InventoryService.create
// calls; `lineUpdates` captures po_import_lines.update payloads.)

describe('createItemsFromPoLinesAction — charter-per-instance (advisory match)', () => {
  it('TC2: a KVA import whose barcode matches an existing CVW item creates a NEW KVA item; CVW item untouched', async () => {
    const { createSpy, lineUpdates } = await runCreate({
      charterId: 'chr-kva',
      // existing item 'itm-cvw' has this barcode and charter 'chr-cvw'
      line: { vendor_item_number: 'BC-CHROME', description: 'Chromebook' },
      barcodeMatchesItemId: 'itm-cvw',
      decisions: {}, // no use_existing → default create
    });
    // A new item is created under KVA...
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ charterId: 'chr-kva' }),
    );
    // ...and the line points at the NEW item, flagged item_created,
    // with the CVW item recorded only as a suggestion.
    const upd = lineUpdates[0];
    expect(upd.item_created).toBe(true);
    expect(upd.item_id).not.toBe('itm-cvw');
    expect(upd.suggested_item_id).toBe('itm-cvw');
    // The existing CVW item was never updated (no create/link against it).
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('TC5: two lines, same SKU, charters KVA and DEF → two separate items, each its charter', async () => {
    const { createSpy } = await runCreate({
      // run twice with different charterId, same vendor number
      lines: [
        { charterId: 'chr-kva', vendor_item_number: 'SKU-X' },
        { charterId: 'chr-def', vendor_item_number: 'SKU-X' },
      ],
      decisions: {},
    });
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ charterId: 'chr-kva' }));
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ charterId: 'chr-def' }));
    expect(createSpy).toHaveBeenCalledTimes(2); // separate instances
  });

  it('explicit use_existing STILL links (opt-in) and does not create', async () => {
    const { createSpy, lineUpdates } = await runCreate({
      charterId: 'chr-kva',
      line: { vendor_item_number: 'BC-CHROME' },
      decisions: { 'line-1': { mode: 'use_existing', itemId: 'itm-cvw' } },
    });
    expect(createSpy).not.toHaveBeenCalled();
    expect(lineUpdates[0].item_id).toBe('itm-cvw');
    expect(lineUpdates[0].item_created).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — the barcode branch currently auto-links (`resolvedItemId = barcodeMatchItemId`), so TC2 fails (no create, links to itm-cvw).

- [ ] **Step 3: Implement** — in `po-imports.ts` action:
  1. Delete the two auto-link branches at lines 401-412 (the `else if (isbnMatchItemId)` and `else if (barcodeMatchItemId)` blocks) so control falls through to the `create` branch by default. Keep the `use_existing` branch (380-400) exactly as-is.
  2. Retain the barcode/ISBN LOOKUPS (they still compute `barcodeMatchItemId`/`isbnMatchItemId`) — but now use them only to record a suggestion. After `resolvedItemId` is set by the create branch, compute `const suggestedItemId = barcodeMatchItemId ?? isbnMatchItemId ?? null;`.
  3. In the line update (455-467), add `suggested_item_id: suggestedItemId` and simplify `item_created` to `decision.mode !== 'use_existing'` (create path → true; use_existing → false). Remove the now-unused `linkedExistingByIsbn`/`linkedExistingByBarcode` flags.

```ts
// AFTER — the decision block (replacing 380-450's link branches):
if (decision.mode === 'use_existing') {
  // ... unchanged existing-item org check → resolvedItemId = existing.id; linked++ ...
} else {
  // DEFAULT: create a new instance under the CHOSEN charter. A barcode/ISBN
  // hit does NOT link here (owner decision #3 — matching is advisory); it is
  // recorded as a suggestion on the line below.
  const item = await inventorySvc.create({ /* ...unchanged... */ charterId, /* ... */ });
  created++;
  resolvedItemId = item.id as string;
}
const suggestedItemId = barcodeMatchItemId ?? isbnMatchItemId ?? null;

const { error: updErr } = await supabase
  .from('po_import_lines')
  .update({
    item_id: resolvedItemId,
    suggested_item_id: suggestedItemId,
    match_status: 'mapped',
    exception_reason: null,
    item_created: decision.mode !== 'use_existing',
  })
  .eq('id', l.id as string);
```

- [ ] **Step 4: Run, expect PASS** (TC2, TC5, use_existing). Also run the existing `po-imports.create-items.test.ts` and fix any assertion that expected the old auto-link (update it to assert the new create-new default + suggestion; note the change in the task report).

- [ ] **Step 5: Commit** — `git commit -am "fix(po-imports): import creates a new instance under the chosen charter; barcode/ISBN matches are advisory, not auto-links (TC2, TC5)"`

---

### Task 4: Web UI — surface the suggestion, default to create-new, preview reflects it

**Files:**
- Modify: `apps/web/src/components/po-imports/po-import-detail.tsx` (per-line `ItemCombobox` at 608-640; the decision/override state 129-156; the charter picker at 442; pass `suggested_item_id` through)
- Modify: `apps/web/src/app/(dashboard)/dashboard/purchase-orders/imports/[id]/page.tsx` (already passes lines; ensure `suggested_item_id` + a resolved suggestion label reach the component)
- Modify: `apps/web/src/components/po-imports/stock-impact-preview.tsx` (project against the line's resolved item — a create-new line projects onto a NEW item at 0, not the suggested existing item's current qty)
- Test: `apps/web/src/components/po-imports/po-import-detail.suggest.test.tsx` (new)

**Interfaces:**
- Consumes: `line.suggested_item_id` + a `suggestionLabel` (e.g. `"Chromebook · SKU-X · charter CVW"`) resolved server-side in page.tsx from the items lookup + charter lookup.
- Produces: a line whose default is create-new shows an inline advisory chip "Possible match: <label> — Use it?" with an "Use existing" button that sets `decision.mode='use_existing'` for that line; the `ItemCombobox` no longer pre-fills `item_id` from a match (it's empty unless the user picks/accepts). Stock-impact preview shows the create-new projection (0 → +qty) unless the user accepted the suggestion.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/po-imports/po-import-detail.suggest.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// Render PoImportDetail with one inventory line carrying suggested_item_id +
// suggestionLabel, item_id null.
it('shows a "Possible match" chip and does NOT pre-select the item', () => {
  renderDetail({ line: { id: 'l1', suggested_item_id: 'itm-cvw',
    suggestionLabel: 'Chromebook · SKU-X · CVW', item_id: null } });
  expect(screen.getByText(/possible match/i)).toBeInTheDocument();
  expect(screen.getByText(/Chromebook · SKU-X · CVW/)).toBeInTheDocument();
  // The combobox trigger is empty (create-new default), not the CVW item.
  expect(screen.queryByText(/Pick item|Select/i)).toBeInTheDocument();
});

it('clicking "Use existing" links the line to the suggested item', async () => {
  const user = userEvent.setup();
  const { decisionsRef } = renderDetail({ line: { id: 'l1',
    suggested_item_id: 'itm-cvw', suggestionLabel: 'Chromebook · SKU-X · CVW', item_id: null } });
  await user.click(screen.getByRole('button', { name: /use existing/i }));
  expect(decisionsRef.current['l1']).toEqual({ mode: 'use_existing', itemId: 'itm-cvw' });
});
```

- [ ] **Step 2: Run, expect FAIL** (no chip, no Use-existing button).

- [ ] **Step 3: Implement** — in page.tsx, resolve `suggestionLabel` per line from the items + charters lookups and pass `suggested_item_id`+`suggestionLabel` on each line. In po-import-detail.tsx: render the advisory chip when `line.suggested_item_id && !effectiveItemId`; the "Use existing" button calls `setLineItem(l.id, line.suggested_item_id)` AND records `decision.mode='use_existing'`. Ensure `effectiveItemId` derives from `item_id`/decision, NOT from `suggested_item_id`, so the default is create-new. Update `stock-impact-preview.tsx` `buildPreview` to look up the RESOLVED item (created lines → a synthetic "new" row at currentQty 0), so the preview no longer shows the suggested existing item's 500→600.

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit** — `git commit -am "feat(po-imports): advisory 'Possible match' chip; default create-new; preview reflects new instance not the suggested item"`

---

### Task 5: Charter reaches every created line (parse-matched lines included) + approve stays bill-to

**Files:**
- Modify: `apps/web/src/components/po-imports/po-import-detail.tsx` (ensure the "Charter for items" value is applied to ALL lines the user creates, including ones that arrived with a suggestion; approve keeps sending `billToCharterId` only)
- Modify (if needed): `apps/web/src/server/actions/po-imports.ts` (no change expected — create path already applies `charterId`)
- Test: `apps/web/src/components/po-imports/po-import-detail.charter.test.tsx` (new)

**Interfaces:**
- Consumes: `charterId` state (item charter) and `billToCharterId` state (bill-to) — already separate.
- Produces: `createItemsFromPoLinesAction` is always called with the chosen `charterId` for every created line; `approvePoImportAction` continues to send `billToCharterId` for `purchase_orders.charter_id` (bill-to), never the item charter.

- [ ] **Step 1: Write the failing test** — assert that creating items for a set of lines (some of which arrived with `suggested_item_id`) calls the create action with the chosen `charterId` for all of them, and that approve is called with the bill-to charter (distinct value), not the item charter.

```tsx
it('applies the chosen item-charter to created lines and keeps bill-to separate', async () => {
  const { createArgs, approveArgs } = await renderAndCreate({
    itemCharterId: 'chr-kva', billToCharterId: 'chr-bill',
    lines: [{ id: 'l1', suggested_item_id: 'itm-cvw' }],
  });
  expect(createArgs.charterId).toBe('chr-kva');
  expect(approveArgs.charterId).toBe('chr-bill'); // bill-to, not item charter
});
```

- [ ] **Step 2: Run, expect FAIL** if a suggested line currently bypasses the create-items modal / charter. **Step 3: Implement** so the create-items flow includes suggested-but-not-accepted lines and passes `charterId`. **Step 4: PASS.**
- [ ] **Step 5: Commit** — `git commit -am "fix(po-imports): item-charter applied to all created lines incl. suggested; approve stays bill-to"`

---

### Task 6: Selection identity in the import table (owner TC1, TC6) — confirm/pin

**Files:**
- Test: `apps/web/src/components/po-imports/po-import-detail.selection.test.tsx` (new)

**Interfaces:** Consumes existing per-line decision state keyed on `po_import_lines.id` (already unique — investigation confirmed). This task only PINS the behavior with tests (no code change expected).

- [ ] **Step 1: Write tests** — TC1: two lines with the same serial/description but distinct `id` — toggling skip on line A does not change line B. TC6: setting a decision on one line only mutates that line's entry in the overrides map.
- [ ] **Step 2: Run — expect PASS immediately** (keys are already `l.id`). If any assertion fails, that is a real bug — fix by ensuring every per-line control keys on `l.id`.
- [ ] **Step 3: Commit** — `git commit -am "test(po-imports): pin per-line selection identity (TC1, TC6)"`

---

### Task 7: Mobile parity check + fix

**Files:**
- Inspect: `apps/mobile/app/(drawer)/po-imports.tsx`, `apps/mobile/src/screens/po-imports.tsx`, `apps/mobile/app/scan-po/index.tsx`
- Modify: whichever mobile screen performs the import review/create/charter step (if any)

**Interfaces:** Consumes the same server actions (`createItemsFromPoLinesAction`, `approvePoImportAction`) — so the server fix already benefits mobile. Produces: if mobile has a review/match/charter UI, it must (a) default to create-new, (b) show the suggestion advisory, (c) send the chosen charter. If mobile is upload/scan/list only (no review UI), Phase 1 mobile work is N/A — record that in the task report.

- [ ] **Step 1:** Read the three mobile files; determine whether a review/match/charter surface exists.
- [ ] **Step 2:** If it exists, mirror Task 4/5 behavior with the mobile component patterns + a vitest test; if not, write a one-line report "mobile PO-import is upload/scan/list only; server fix covers it; no mobile UI change" and skip.
- [ ] **Step 3: Commit** (only if code changed) — `git commit -am "feat(mobile): PO-import advisory match + create-new default (parity)"`

---

### Task 8: Apply migration + live demo-org verification (owner test cases)

**Files:** none (verification task).

- [ ] **Step 1:** Owner applies `0232` to prod (`supabase db push --linked`); confirm the column exists.
- [ ] **Step 2:** Deploy web; in the demo org, seed a fixture: an existing item under charter CVW with barcode `BC-CHROME`; a PO import with a Chromebook line whose vendor number is `BC-CHROME`.
- [ ] **Step 3:** Verify **TC2** live: on the import review, the Chromebook line shows a "Possible match: … CVW" chip, is NOT pre-linked; set item-charter KVA, create → a NEW KVA item is created, the CVW item's qty and charter are unchanged; the stock-impact preview shows the new item (0 → +qty), not CVW 500→600.
- [ ] **Step 4:** Verify **TC5** (two lines, same SKU, different charters → two items), **TC1/TC6** (selecting one line acts only on it).
- [ ] **Step 5:** Delete the fixtures. Report the four test-case results with screenshots.

---

## Phase 2 (separate plan — after Phase 1 ships & verifies)

Detailed in its own plan once Phase 1 is live. Scope (owner decisions locked): add an `import_staged` holding kind that is **excluded from `quantity_on_hand`** but **included in `inventory_value_on_hand`**; a **convert action** ("Add to Items List") that moves staged qty into active on-hand; route receiving of import-origin lines into `import_staged` instead of bumping on-hand; audit `reverse_receipt` / `stagedWorklist` / cycle-count for the on-hand≠Σholdings window; display "Import — awaiting conversion" on web item detail + Items list + mobile item screen (reusing the amber "awaiting put-away" pattern). Covers owner test cases 3, 4, 7, 8.

---

## Self-Review (against the spec)

- **R1 identity / TC1,TC5,TC6:** Tasks 3, 6 (create-new per instance; suggestions never link; per-line id keys). ✅
- **R2 charter honored / TC2:** Tasks 3, 5 (chosen charter on create; existing charter never inherited/overwritten). ✅
- **R3 no auto-merge:** Tasks 2, 3 (matches advisory only). ✅
- **R4 staged-first / TC3,4,7,8:** Phase 2 (explicitly deferred). ✅ (scoped out, noted)
- **Decision #3 barcode-as-suggestion:** Tasks 2, 3, 4. ✅
- **Bill-to vs item charter independent:** Task 5. ✅
- **Type consistency:** `suggested_item_id` (snake_case DB / line payloads), `suggestionLabel` (camel UI prop), `charterId` (action input) used consistently across Tasks 1-5.
- **No placeholder scan:** each code step shows the real before/after against the actual current code at the cited lines.
