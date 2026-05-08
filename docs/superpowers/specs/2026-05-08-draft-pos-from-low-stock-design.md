# Draft POs from Low-Stock Selection

**Date:** 2026-05-08
**Status:** Approved (proceeding to implementation)
**Owner:** Branden Vincent-Walker

## Goal

Turn a selection of low-stock items into draft purchase orders in one click — auto-grouped by supplier, line quantities pre-filled from each item's `reorder_quantity`. Restock day stops being a manual exercise of opening the New PO form N times and copying SKUs.

## Scope

- **In:** new bulk action on the inventory + books tables, server action that creates one draft PO per supplier, toast feedback, redirect to the PO list
- **Out:** new pages or modals, "preview before create" step, AI tool, rollback on partial failure, "skip if pending PO already exists" check, email notifications, reorder-rule automation

## User-visible behavior

1. From `/dashboard/inventory?stock=low&type=all` (or any inventory / books view), check one or more rows
2. The existing `BulkActions` bar appears at the top of the table with the new **"Create draft POs"** button alongside the existing actions
3. Click it. Toast appears within ~1 second:
   - **All selected had suppliers**: `Created 3 draft POs across 3 suppliers`
   - **Some skipped**: `Created 2 draft POs · 1 item skipped (no supplier)`
   - **None had suppliers**: `No items had a supplier set. Assign suppliers and try again.` — no POs created
   - **Partial failure**: `Created 2 of 3 draft POs · 1 supplier errored: <name>`
4. On any successful create, browser navigates to `/dashboard/purchase-orders?status=draft` so the user sees the new drafts immediately

## Architecture

### Server action

`apps/web/src/server/actions/purchase-orders.ts` (extend existing file or create one if missing) gains:

```ts
export async function createDraftPosFromItemsAction(itemIds: string[]): Promise<{
  ok: true;
  data: { createdPoIds: string[]; skipped: number; supplierFailures: Array<{ supplierId: string; supplierName: string; error: string }> };
} | {
  ok: false;
  error: { code: string; message: string };
}>
```

Pipeline:
1. `withContext()` for auth/org scope
2. Validate `itemIds` is non-empty array of UUID strings; cap at 200 to bound the work
3. Fetch the items in one query, projecting `id, sku, name, supplier_id, reorder_quantity, reorder_point, quantity_on_hand, unit_cost, warehouse_id`. Filtered by `organization_id` + `id IN (...)`. RLS handles warehouse access.
4. Partition: `withSupplier` vs `noSupplier`. Track `skipped = noSupplier.length`.
5. If `withSupplier.length === 0` → return `{ ok: false, error: { code: 'no_supplier', message: 'No items had a supplier set...' } }`
6. Group `withSupplier` by `supplier_id` → `Map<supplierId, Item[]>`
7. For each entry, call `PurchaseOrdersService.create({ supplierId, items: [...] })` (status defaults to `draft` server-side). Each line:
   - `item_id`
   - `quantity_ordered = item.reorder_quantity > 0 ? item.reorder_quantity : Math.max(1, item.reorder_point - item.quantity_on_hand)`
   - `unit_cost = item.unit_cost`
8. Collect successes into `createdPoIds`. Catch per-supplier errors into `supplierFailures` (continue iterating; no rollback).
9. `revalidatePath('/dashboard/purchase-orders')` and `revalidatePath('/dashboard/inventory')` (low-stock counts may shift after).
10. Return success payload.

### `BulkActions` UI

`apps/web/src/components/inventory/bulk-actions.tsx` already renders the bar. Add a new variant button:

```
[Selected: 12 items] [Set category ▾] [Set supplier ▾] [Archive] [Create draft POs]
```

The new button:
- Always rendered (not gated on filter state — works for any selection)
- Disabled while submitting; shows `Loader2` spinner
- On click: calls `createDraftPosFromItemsAction(selectedIds)` → toast → on `ok && createdPoIds.length > 0`, `router.push('/dashboard/purchase-orders?status=draft')`

The `BulkActions` component receives `selectedIds: string[]` already, plus `onClear` so we can clear the selection before navigating. Add a new prop `onCreatePos?: () => void` if needed for testability, or call the action directly inline.

### What's saved per PO line

| Field | Source |
|---|---|
| `item_id` | selected item id |
| `quantity_ordered` | `reorder_quantity` if > 0, else `max(1, reorder_point - quantity_on_hand)` |
| `unit_cost` | item's current `unit_cost` |

`PurchaseOrdersService.create()` already computes `subtotal/tax/shipping/total` from lines — no changes to the service.

## Edge cases

- **Empty selection** → button is hidden because the BulkActions bar itself only shows when `selectedIds.length > 0`
- **All selected items lack suppliers** → no POs created; toast "No items had a supplier set..."
- **Item belongs to an inaccessible warehouse** → silently filtered by RLS at fetch step. If that drops some items, they're treated the same as "skipped".
- **One supplier's create() throws** (e.g., DB constraint, connection blip) → other suppliers' POs that succeeded earlier in the loop stay. Toast reports `Created 2 of 3 · 1 supplier errored: <name>`. User re-runs for the remaining items.
- **Bulk selection > 200 items** → action returns `{ ok: false, error: { code: 'too_many', message: 'Select 200 items or fewer per batch.' } }`. Internal-tool sizing — unlikely to hit.
- **Mixed products + books in selection** → fine; PO lines are item_id-keyed regardless of `item_type`. Books are inventory items.
- **Active warehouse filter is set** → the items are already scoped to that warehouse via `InventoryService.list`; the resulting POs inherit nothing about warehouse (PO doesn't have warehouse_id directly; line items reference inventory_items which do).
- **Two selected items share the same SKU at different warehouses** (rare) → both lines added to the same supplier's PO; user resolves on review.

## Testing

Manual:
- Select 3 items from 2 different suppliers → click → 2 drafts created, navigated to PO list, both visible
- Select 2 items where one has no supplier → 1 draft created, toast notes 1 skipped
- Select 2 items both with no supplier → no POs created, toast explains
- Select item with `reorder_quantity = 0` and `reorder_point = 5, quantity_on_hand = 2` → line shows qty 3 (the deficit + 1)
- Select item with `reorder_quantity = 10` → line shows qty 10 regardless of current stock

Automated: extend `apps/web/src/server/actions/inventory.test.ts` (or a new file) with a unit test that:
- Mocks `InventoryService.list` to return items with mixed supplier_ids
- Calls `createDraftPosFromItemsAction(['id1','id2','id3'])`
- Asserts `PurchaseOrdersService.create` called once per supplier with the right line set

## Out-of-scope follow-ups

- AI tool: `draftPos({ filter })` so Gemini can chat "draft restock POs for everything below reorder at L4L Fresno"
- Preview-and-edit modal before commit (skip-and-go is the v1 trade-off)
- "Skip if a draft PO already exists for this item from this supplier" idempotency
- Email confirmation when drafts are created
- Auto-promote draft → ordered when user clicks a "send" button (separate workflow)
- Reorder rules engine (recurring schedule, supplier preference, etc.)

## Decision log

| Decision | Why |
| --- | --- |
| Auto-split per supplier into N draft POs | User chose this; matches real restock-day workflow where one trip to procurement covers multiple vendors |
| Skip items with no supplier (don't block) | Forces good data hygiene without halting the whole batch; user fixes and re-runs |
| Pre-fill `reorder_quantity` (fallback: deficit + 1) | Matches operator intent; reorder_quantity is the canonical "how much we re-order each time" |
| No rollback on partial failure | Keeping successful drafts is more useful than blank slate; rollback would need a saga |
| Land on PO list filtered to drafts | Single navigation lets user verify the new drafts at a glance and edit any of them before sending |
| BulkActions bar entry point, not a new page | Reuses existing selection UX; ships smaller; works for any inventory view, not just `?stock=low` |
| Hard cap of 200 selected items | Bounds memory + server time; way more than internal-tool restock days hit |
