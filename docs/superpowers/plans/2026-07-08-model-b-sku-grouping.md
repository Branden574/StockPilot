# Model B — One Item per SKU (Non-Destructive Grouping) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Present the same SKU (spread across charters/racks) as ONE product with a summed total and an expandable per-placement breakdown, and keep product attributes consistent across those placements — WITHOUT merging or deleting any records.

**Architecture:** The existing per-(sku, charter, rack) `inventory_items` rows are KEPT and treated as *placements* of a shared SKU. The Items list groups rows by `(organization_id, sku)` into one row with the summed on-hand, expandable to placements. Editing a *shared* product field (name, sku, unit_cost, retail_price, description, category, barcode, reorder settings) on any placement fans out to all rows with the same org+sku; *per-placement* fields (charter, rack/location, quantity) stay local. Import/scan/fulfillment resolve to the SKU group then act on a chosen placement. On-hand per row stays the maintained scalar — dashboards/valuation/reorder/snapshots are untouched; the SKU total is a read-time SUM for display/preview.

**Tech Stack:** Next.js 16 App Router, Supabase (PG17), TypeScript, vitest, React Testing Library, Expo (mobile), pgTAP (only if an index/migration is needed).

## Global Constraints

- **NON-DESTRUCTIVE.** No record merge/delete, no charter-to-holdings migration, no RLS charter redesign, no on-hand-derivation rewrite, no FK remap. (Spec §8b supersedes §3.3/§4.)
- **Charter stays on the `inventory_items` row** (per placement). Do NOT move it to `item_stock_levels`.
- **On-hand scalar per row is unchanged.** Do NOT touch `adjust_stock`, `post_receipt_v2`, dashboards, valuation (0227), reorder, snapshots (0224-0230), or mobile on-hand reads. The SKU total is a read-time `SUM(quantity_on_hand)` over same-org+sku rows, for display/preview ONLY.
- **Shared vs per-placement fields (exact lists):** SHARED (propagate by SKU) = `name, sku, unit_cost, retail_price, description, category_id, barcode, reorder_point, reorder_quantity, item_type`. PER-PLACEMENT (local) = `charter_id, warehouse_id, primary_location_id, bin_location, rack (custom_fields rack keys), quantity_on_hand, status`.
- **Propagation key = `(organization_id, sku)`** over `deleted_at IS NULL` rows. Editing `sku` re-keys the WHOLE group (every placement of the old sku moves to the new sku together) and must not collide with an existing different-product group at the same location.
- **Repeated rack numbers across charters are intentional** — a placement is unique by (sku, charter, rack); never dedupe them away.
- **Value stays whole**; per-charter value/breakdown is an OPTIONAL report filter only.
- **Per-company configurability of propagation is DEFERRED (YAGNI)** — hardcode propagate-by-SKU.
- **Web + mobile parity. TDD. Adversarial review each phase. Live demo-org verification** (StockPilot Demo Co, org 71b27a4a…; seed a parallel Chromebook-across-charters fixture — L4L is the owner's real org, do not mutate it in tests). **NO Claude/Anthropic co-author trailers.**
- Phase 1 (advisory matching) stays LIVE as the interim throughout.

---

## Phase 1 — Items-list SKU grouping + shared-field propagation (the visible core)

### Task 1: `groupBySku` pure helper (aggregate placements → one SKU row + breakdown)

**Files:**
- Create: `apps/web/src/lib/inventory/group-by-sku.ts`
- Test: `apps/web/src/lib/inventory/group-by-sku.test.ts`

**Interfaces:**
- Produces: `groupPlacementsBySku(rows: PlacementRow[]): SkuGroup[]` where
  `PlacementRow = { id: string; sku: string; name: string; charterId: string | null; charterName: string | null; placementLabel: string | null; lineQuantity: number; /* passthrough of the existing row */ [k: string]: unknown }`
  and `SkuGroup = { sku: string; name: string; total: number; placements: PlacementRow[] }`.
- Consumed by Task 2 (the Items list render) and Task 6 (import preview aggregate).

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/inventory/group-by-sku.test.ts
import { describe, it, expect } from 'vitest';
import { groupPlacementsBySku } from './group-by-sku';

const row = (o: Partial<{ id: string; sku: string; name: string; lineQuantity: number; charterName: string | null }>) => ({
  id: o.id ?? 'i1', sku: o.sku ?? 'SKU-A', name: o.name ?? 'Chromebook',
  charterId: null, charterName: o.charterName ?? null, placementLabel: null,
  lineQuantity: o.lineQuantity ?? 0,
});

describe('groupPlacementsBySku', () => {
  it('sums placements of one SKU into a single group total, preserving each placement', () => {
    const groups = groupPlacementsBySku([
      row({ id: 'a', sku: 'SP-G69UU-05H', lineQuantity: 75, charterName: 'CVW-Manchester' }),
      row({ id: 'b', sku: 'SP-G69UU-05H', lineQuantity: 100, charterName: 'CVLYII-Visalia' }),
      row({ id: 'c', sku: 'SP-G69UU-05H', lineQuantity: 106, charterName: 'CVSII-Madera' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].sku).toBe('SP-G69UU-05H');
    expect(groups[0].total).toBe(281);
    expect(groups[0].placements).toHaveLength(3);
  });

  it('keeps different SKUs as separate groups, first-seen order', () => {
    const groups = groupPlacementsBySku([
      row({ id: 'a', sku: 'SKU-A', lineQuantity: 5 }),
      row({ id: 'b', sku: 'SKU-B', lineQuantity: 7 }),
      row({ id: 'c', sku: 'SKU-A', lineQuantity: 3 }),
    ]);
    expect(groups.map((g) => g.sku)).toEqual(['SKU-A', 'SKU-B']);
    expect(groups[0].total).toBe(8);
  });

  it('treats a null/empty sku as its own ungrouped placement (never merges blank SKUs)', () => {
    const groups = groupPlacementsBySku([
      row({ id: 'a', sku: '', lineQuantity: 1 }),
      row({ id: 'b', sku: '', lineQuantity: 2 }),
    ]);
    expect(groups).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter web exec vitest run group-by-sku` → "groupPlacementsBySku is not a function".

- [ ] **Step 3: Implement**

```ts
// apps/web/src/lib/inventory/group-by-sku.ts
export interface PlacementRow {
  id: string;
  sku: string;
  name: string;
  charterId: string | null;
  charterName: string | null;
  placementLabel: string | null;
  lineQuantity: number;
  [k: string]: unknown;
}
export interface SkuGroup {
  sku: string;
  name: string;
  total: number;
  placements: PlacementRow[];
}

/**
 * Group placement rows (one per sku×charter×rack inventory_items row) into one
 * group per non-empty SKU, first-seen order, summing lineQuantity into total.
 * A blank/whitespace SKU is never grouped — each blank row is its own group
 * (blank SKUs are not a shared product identity).
 */
export function groupPlacementsBySku(rows: PlacementRow[]): SkuGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, SkuGroup>();
  for (const r of rows) {
    const key = r.sku.trim() ? `sku:${r.sku}` : `blank:${r.id}`;
    let g = byKey.get(key);
    if (!g) {
      g = { sku: r.sku, name: r.name, total: 0, placements: [] };
      byKey.set(key, g);
      order.push(key);
    }
    g.total += r.lineQuantity;
    g.placements.push(r);
  }
  return order.map((k) => byKey.get(k)!);
}
```

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `git add apps/web/src/lib/inventory/group-by-sku.ts apps/web/src/lib/inventory/group-by-sku.test.ts && git commit -m "feat(inventory): groupPlacementsBySku helper for SKU-grouped list"`

---

### Task 2: Items list renders one row per SKU, expandable to placements

**Files:**
- Modify: `apps/web/src/components/inventory/inventory-table.tsx` (the row-render loop that today emits one `<tr>` per placement row; wrap in SKU groups with an expand/collapse)
- Modify: `apps/web/src/app/(dashboard)/dashboard/inventory/page.tsx` (pass `charterName` per placement row so the breakdown can label it — the charter lookup map already exists at `lookups.charters`)
- Test: extend `apps/web/src/components/inventory/inventory-table.instant.test.tsx`

**Interfaces:**
- Consumes: `groupPlacementsBySku` (Task 1); the existing `placementRows` shape (`rowKey`, `line_quantity`, `placement_label`, `placement_kind`, `charter_id`).
- Produces: a grouped table — a SKU header row (name, sku, **summed on-hand**, status rollup) with a chevron; expanding shows the placement rows (charter · rack · qty) already built today. Collapsed by default; the summed total is the headline number.

- [ ] **Step 1: Write the failing test** (assert one visible SKU row with total 281; expand reveals 3 placements)

```tsx
// in inventory-table.instant.test.tsx
it('groups placements of one SKU into a single row showing the summed total, expandable', async () => {
  const user = userEvent.setup();
  getSearchParams(''); window.history.replaceState(null, '', '/dashboard/inventory');
  const rows = [item({ id: 'g', name: 'Acer Chromebook', sku: 'SP-G69UU-05H', quantity_on_hand: 281 })];
  render(
    <InventoryTable items={rows} lookups={EMPTY_LOOKUPS} total={1} pageSize={30}
      instant={{ items: rows, view: 'items', placement: { g: [
        { locationId: 'L1', label: 'CVW-Manchester · 1-A', kind: 'rack', quantity: 75 },
        { locationId: 'L2', label: 'CVLYII-Visalia · 1-C', kind: 'rack', quantity: 100 },
        { locationId: 'L3', label: 'CVSII-Madera · 2-A', kind: 'rack', quantity: 106 },
      ] } }} />,
  );
  // ONE SKU row, headline total 281 (not three separate rows by default)
  expect(screen.getByText('281')).toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: 'Acer Chromebook' })).toHaveLength(1);
  // Expand → placements visible
  await user.click(screen.getByRole('button', { name: /expand|show placements|SP-G69UU-05H/i }));
  expect(screen.getByText('CVW-Manchester · 1-A')).toBeInTheDocument();
  expect(screen.getByText('CVSII-Madera · 2-A')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run, expect FAIL** (today it renders three rows, no group header, no expand control).
- [ ] **Step 3: Implement** — feed the page's placement rows through `groupPlacementsBySku`; render a group header row per SKU with the summed `total`, a chevron toggling a `Set<string>` of expanded SKUs; when expanded, render the existing placement `<tr>`s beneath. Keep the row-level selection keyed on `rowKey` (from the earlier co-select fix) — group headers are not selectable; placement rows remain individually selectable. Pass `charterName` from `lookups.charters` on each placement row in page.tsx. Preserve the per-rack split mode for the placement sub-rows.
- [ ] **Step 4: Run, expect PASS.** Also run the full instant test file + fix any assertion that expected the old flat one-row-per-placement layout (note changes).
- [ ] **Step 5: Commit** — `git commit -am "feat(inventory): Items list groups placements into one row per SKU (expandable, summed total)"`

---

### Task 3: Shared-field propagation in `InventoryService.update` (the core behavior)

**Files:**
- Modify: `apps/web/src/server/services/inventory.ts` (`update()`, ~1708-1806)
- Test: `apps/web/src/server/services/inventory.shared-field-propagation.test.ts`

**Interfaces:**
- Consumes: existing `UpdateItemInput`, `assertPermission`, the org-scoped supabase client.
- Produces: after updating the target row, when the patch changed ANY SHARED field (`name, sku, unit_cost, retail_price, description, category_id, barcode, reorder_point, reorder_quantity, item_type`), the SAME shared values are written to ALL OTHER non-deleted rows sharing the target's ORIGINAL `(organization_id, sku)`. Per-placement fields (`charter_id, warehouse_id, primary_location_id, bin_location, quantity_on_hand, status`, custom_fields rack keys) are NEVER propagated. When `sku` changes, the propagation targets the ORIGINAL sku group (so all placements re-key to the new sku together); a `23505` from re-keying into an existing different group surfaces as the friendly `conflict` (already handled).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/src/server/services/inventory.shared-field-propagation.test.ts
// (mock context + a supabase stub capturing per-call update payloads + filters.
//  Two sibling rows share (org, sku 'SP-X'): 'row-a' (target) and 'row-b'.)
describe('InventoryService.update — shared-field propagation by SKU', () => {
  it('propagates unit_cost to all same-sku siblings, but NOT charter', async () => {
    const { svc, updates } = harness({ targetSku: 'SP-X' });
    await svc.update('row-a', { unitCost: 469.95, charterId: 'chr-1' });
    // target row got both; siblings got ONLY unit_cost (shared), NOT charter (per-placement)
    const sibling = updates.find((u) => u.scope === 'siblings');
    expect(sibling.payload.unit_cost).toBe(469.95);
    expect(sibling.payload).not.toHaveProperty('charter_id');
  });

  it('editing sku re-keys the whole group (all placements move to the new sku)', async () => {
    const { svc, updates } = harness({ targetSku: 'SP-X' });
    await svc.update('row-a', { sku: 'SP-Y' });
    const sibling = updates.find((u) => u.scope === 'siblings');
    // siblings selected by the ORIGINAL sku, set to the NEW sku
    expect(sibling.filterSku).toBe('SP-X');
    expect(sibling.payload.sku).toBe('SP-Y');
  });

  it('a per-placement-only edit (charter/qty) does NOT touch siblings', async () => {
    const { svc, updates } = harness({ targetSku: 'SP-X' });
    await svc.update('row-a', { charterId: 'chr-2' });
    expect(updates.some((u) => u.scope === 'siblings')).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (no propagation exists yet).
- [ ] **Step 3: Implement** — in `update()`, BEFORE the target update, capture `originalSku` from the loaded `current`. Build the target `updates` as today. Compute `sharedUpdates` = the subset of `updates` limited to the SHARED columns. After the target row updates successfully AND `sharedUpdates` is non-empty, run a second update:
```ts
// Fan out shared product fields to every OTHER placement of this SKU.
// Keyed on the ORIGINAL sku so a sku change re-keys the whole group.
if (Object.keys(sharedUpdates).length > 0) {
  const { error: sibErr } = await this.ctx.supabase
    .from('inventory_items')
    .update({ ...sharedUpdates, updated_by: this.ctx.userId })
    .eq('organization_id', this.ctx.organizationId)
    .eq('sku', originalSku)
    .is('deleted_at', null)
    .neq('id', id);
  if (sibErr) {
    if (sibErr.code === '23505') {
      throw new ServiceError('conflict', 'Another item at a shared location already uses that SKU. Change the SKU or resolve the conflict first.');
    }
    throw new ServiceError('internal_error', sibErr.message);
  }
}
```
Define `const SHARED_ITEM_FIELDS = ['name','sku','unit_cost','retail_price','description','category_id','barcode','reorder_point','reorder_quantity','item_type'] as const;` near the top of the service and build `sharedUpdates` by picking those keys from `updates`. Audit: extend the existing `inventory.item.updated` audit with `extra.propagated_to_sku` when siblings were touched.
- [ ] **Step 4: Run, expect PASS.** Run the full inventory service suite; fix fallout.
- [ ] **Step 5: Commit** — `git commit -am "feat(inventory): shared product-field edits propagate across a SKU's placements (charter/qty stay local)"`

---

### Task 4: Item edit form — label shared vs per-placement fields; mobile parity

**Files:**
- Modify: `apps/web/src/components/inventory/item-form.tsx` (group the shared fields under a "Product details (shared across all placements of this SKU)" note; keep charter/rack/qty under a "This placement" note)
- Modify: `apps/mobile/app/item/[id].tsx` (same labeling; mobile edits go through the same server action, so propagation is automatic — this is copy/UX parity only)
- Test: `apps/web/src/components/inventory/item-form.test.tsx` (assert the shared-vs-placement helper copy renders; a render/interaction test that saving a shared field calls the update action)

- [ ] **Step 1: Write the failing test** (form shows the "shared across all placements" note next to name/cost; "this placement only" next to charter/rack).
- [ ] **Step 2: FAIL.** **Step 3:** add the two grouping notes + helper text; no logic change (propagation is server-side, Task 3). **Step 4: PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(inventory): edit form clarifies shared product fields vs per-placement fields (web+mobile)"`

---

## Phase 2 — Import preview shows SKU aggregate + target placement

### Task 5: Stock-impact preview projects both the SKU total and the specific placement

**Files:**
- Modify: `apps/web/src/components/po-imports/stock-impact-preview.tsx` (`buildPreview`)
- Modify: `apps/web/src/components/po-imports/po-import-detail.tsx` (pass the SKU-aggregate on-hand alongside the matched/created placement)
- Test: `apps/web/src/components/po-imports/stock-impact-preview.test.ts`

**Interfaces:**
- Consumes: `groupPlacementsBySku` (Task 1) OR a passed-in `skuTotalBySku: Map<string, number>` computed in the page from the full items list.
- Produces: each preview row shows `SKU total: 281 → 381` as the headline AND `Placement (CVW-Manchester · 1-A): 100 → 200` as the sub-line for the specific target. A create-new placement shows placement `0 → qty`; the SKU total still rises by qty.

- [ ] **Step 1: Write the failing test** — a line landing in one placement of a SKU that totals 281 shows both "281 → 381" and the placement "100 → 200" (or "new placement 0 → 100").
- [ ] **Step 2: FAIL.** **Step 3:** compute the SKU aggregate (sum of same-sku placements' current qty) in the page and thread it in; render both lines in `buildPreview`/the component. Keep it a pure projection (no writes). **Step 4: PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(po-imports): preview shows SKU total AND the target placement (fixes 281-vs-100 confusion)"`

---

## Phase 3 — Scan & fulfillment resolve to SKU, then pick a placement

### Task 6: Scan-to-adjust disambiguates same-SKU placements (mobile + shared lookup)

**Files:**
- Modify: `apps/web/src/app/api/v1/items/lookup/route.ts` (return ALL matches for a scanned code, not `.limit(1)`)
- Modify: `apps/mobile/app/(drawer)/(tabs)/scan.tsx` (`loadItemByValue` ~192 — resolve all matches; if >1, present a placement/charter picker before adjust)
- Modify: `apps/web/src/server/services/restore-points.ts` (`itemKey` include `charter_id`; snapshot select + SnapshotItem gain `charter_id`; snapshot format `version` bump)
- Test: `apps/web/src/app/api/v1/items/lookup/route.test.ts` + a mobile helper test for the multi-match branch

**Interfaces:**
- Produces: `GET /api/v1/items/lookup?code=X` → `{ matches: Array<{ id, sku, name, charterId, charterName, placementLabel, quantityOnHand }> }` (was a single item). Mobile: on `matches.length > 1`, show a picker; on 1, proceed as today; on 0, "not found".

- [ ] **Step 1: Write failing tests** — lookup returns 2 matches for a code that two same-SKU placements share (was arbitrary single); restore-points `itemKey` differs for two same-(sku,bin) rows under different charters (no collapse).
- [ ] **Step 2: FAIL.** **Step 3:** implement the multi-match resolver + mobile picker + restore-points charter-aware key. **Step 4: PASS.** Run mobile + web suites.
- [ ] **Step 5: Commit** — `git commit -am "fix(scan): resolve a scanned code to all same-SKU placements, pick before adjust; restore-points charter-aware key"`

### Task 7: Order fulfillment picks a specific placement for a same-SKU item

**Files:**
- Inspect + Modify: the pick/fulfillment flow (`apps/web/src/server/services/*orders*`, pick RPC `0111`, and the pick UI) so that when the ordered item has >1 placement, the picker chooses which charter/rack the units come from; that placement decrements.
- Test: the fulfillment service test for the multi-placement branch.

- [ ] **Step 1:** Inspect how fulfillment currently resolves the source of stock (by item id → its holdings). Write a failing test: fulfilling from a multi-placement SKU decrements the CHOSEN placement, not an arbitrary one. **Step 2: FAIL.** **Step 3:** thread the chosen placement/holding into the pick. **Step 4: PASS.** **Step 5: Commit.**
  (If fulfillment already operates on a specific holding/location and is unambiguous, this becomes a verify-and-pin task — note that in the report and pin it with a test.)

---

## Phase 4 — Optional per-charter value in reports

### Task 8: Valuation report gains an optional "by charter" filter

**Files:**
- Modify: `apps/web/src/server/services/reports.ts` (valuation) + the report UI + the CSV/PDF export routes
- Test: `apps/web/src/server/services/reports.*.test.ts`

**Interfaces:**
- Produces: valuation accepts an optional `charterId`; when set, value/units are summed only over placements with that charter (placement.charter_id); default (unset) = whole-org value, UNCHANGED.

- [ ] **Step 1: Write the failing test** — valuation with `charterId` = X returns only X's placements' value; without it, the total is unchanged from today. **Step 2: FAIL.** **Step 3:** add the optional filter (does NOT alter the default path). **Step 4: PASS.** **Step 5: Commit.**

---

## Phase 5 — Live verification + finish

### Task 9: Live demo-org verification

- [ ] Seed in StockPilot Demo Co (org 71b27a4a…): one Chromebook SKU as THREE placement rows under three real demo charters (South Campus / North Campus etc. — demo charters, NOT L4L's) with distinct racks + quantities summing to a known total; ensure each row shares the SKU.
- [ ] Verify live: (a) Items list shows ONE Chromebook row = the summed total, expandable to the 3 placements with charter·rack·qty; (b) editing the unit cost on one placement updates all three (shared), editing one placement's charter changes only that row (local); (c) editing the SKU on one re-keys all three; (d) an import into one charter/rack shows the preview "total → total+qty" AND the target placement; (e) a scan of the shared code offers the placement picker. Screenshots each.
- [ ] Delete the demo fixtures. Report PASS/FAIL per check.

---

## Self-Review

- **Spec §8b coverage:** grouping (T1/T2), shared-field propagation incl. sku re-key (T3), edit-form clarity + mobile parity (T4), import aggregate+placement preview (T5), scan disambiguation + restore-points (T6), fulfillment placement-pick (T7), per-charter report option (T8), value-stays-whole default (T8 default path), on-hand-untouched (global constraint honored — no task edits adjust_stock/snapshots). ✅
- **Non-destructive:** no task merges/deletes rows, moves charter to holdings, changes RLS, or rewrites on-hand. ✅
- **Placeholder scan:** T1/T3 carry full code; T5-T8 are inspect-then-TDD with concrete assertions (T5-T8 touch existing complex flows where the exact current code must be read first — each names the file + the assertion that matters; the implementer reads the cited file and writes real code, not a placeholder).
- **Type consistency:** `PlacementRow`/`SkuGroup` (T1) reused in T2/T5; `SHARED_ITEM_FIELDS` (T3) is the single source for shared-vs-local; `matches[]` shape (T6) consistent.
- **Migration:** likely NONE (grouping is read-time; propagation is app-layer; charter already on the row). T6's restore-points snapshot-format version bump is a code constant, not a DB migration. If Task 3's sibling-update reveals a needed index for performance, flag at implementation — not assumed here.
