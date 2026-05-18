# Duplicate Item / Book — Design

**Date:** 2026-05-18
**Status:** Draft (awaiting user review)
**Owner:** Branden

## Problem

Warehouse staff frequently store the same SKU on multiple racks. Today the only way to represent that in StockPilot is to manually create a second `inventory_item` row from scratch — re-typing the name, description, supplier, category, tags, photo, cost, reorder point, custom fields, etc. This is slow and error-prone, and small differences between the two rows (typos, mismatched categories) cause downstream confusion in reports and order picking.

We want a one-click **Duplicate** affordance: copy everything, prompt only for the new physical location, write one new row, and have orders/picking/reports treat the duplicate as a normal item from there.

## Goals

- One-click duplicate from the item detail view
- Prompt only for the fields that *must* differ at the new location (rack number, rack row, quantity at this rack; books additionally pick crate color + crate number)
- Atomic create — no half-duplicated rows
- New row is fully usable in orders, picking, cycle counts, AI shelf scan, reports, and bundles immediately

## Non-goals

- Auto-pooling stock across duplicates of the same SKU (v1 keeps them as fully independent rows; the order picker chooses which rack to pull from)
- Bulk-duplicate (multiple at once) — single item per click
- Duplicating *across* warehouses — RLS-scoped to the original's warehouse
- Cross-org duplicate

## UX

### Entry point

- New **Duplicate** button on the item detail toolbar, sitting next to **Edit**.
- Same visibility/permission gate as the **New Item** form: requires `inventory:create`.
- Tooltip: "Create another row of this item at a different rack."

### Modal

Opens a dialog. Pre-fills a small subset of fields visibly so the user understands the new row inherits everything else from the original. Two field sets:

**Items (non-book) modal fields**
| Field | Behavior |
| --- | --- |
| Warehouse | Read-only, mirrors original |
| Rack number | Required, free text (matches existing rack picker pattern) |
| Rack row | Optional, free text |
| Quantity at this rack | Defaults to `0`, integer ≥ 0 |

**Books (item_type = 'book') modal fields**
| Field | Behavior |
| --- | --- |
| Warehouse | Read-only, mirrors original |
| Book rack number | Required |
| Book rack row | Optional |
| Book crate color | Required (matches the existing crate-color enum used elsewhere) |
| Book crate number | Required |
| Quantity at this rack | Defaults to `0`, integer ≥ 0 |

### Confirm / cancel

- **Confirm** posts the duplicate; on success, redirect to the new item's detail page so the user sees what was created (no toast-and-stay; the redirect is the confirmation).
- **Cancel** closes without changes.

### Soft warning

If the chosen rack/row (items) or rack/row/crate combo (books) is *already* occupied by another row of the same SKU, show a yellow inline warning: "This rack already has SKU X — duplicate anyway?" The user can still proceed. (Real workflow: occasionally users do split a single rack into two rows on purpose.)

## Data model

Single new RPC: `duplicate_inventory_item(p_original_id uuid, p_overrides jsonb) returns uuid`. Runs in a transaction. Returns the new item's id.

### Column-by-column copy plan

| Column | Behavior |
| --- | --- |
| `id` | New `gen_random_uuid()` |
| `organization_id` | Copy |
| `warehouse_id` | Copy (modal warehouse is read-only) |
| `item_type` | Copy |
| `sku` | Auto-suffix: original `SP-ABC` → try `SP-ABC-2`, `-3`, … up to `-99`. Block at 99 with `too_many_duplicates` error. |
| `name` | Copy |
| `description` | Copy |
| `category_id` | Copy |
| `supplier_id` | Copy |
| `unit_cost` | Copy |
| `reorder_point` | Copy |
| `reorder_qty` | Copy |
| `quantity_on_hand` | From modal (default 0) |
| `primary_location_id` | Copy (matches warehouse) |
| `bin_location` | Re-derive from new rack/crate fields, do **not** copy stale value |
| `custom_fields` | Copy whole JSONB blob, then overwrite: items → `rack_number`, `rack_row`; books → `book_rack_number`, `book_rack_row`, `book_crate_color`, `book_crate_number`. Any other keys (legacy fields, custom keys) are preserved verbatim. |
| `created_at` / `updated_at` | New `now()` |
| `created_by` | Current user |
| `deleted_at` | NULL |

### Child-table copy

- **`item_tags`**: For every `(item_id = original)` row, insert a parallel row with `(item_id = new)`. Same tag references, no tag rows duplicated.
- **`item_images`**: For every row pointing at the original, insert a parallel row pointing at the **same `storage_path`** (and `thumb_path`, `lqip`). We do NOT copy bytes in storage — both items share the underlying image. Display order copied verbatim; the new row's `is_primary` mirrors the original's primary image.
- **Stock movements**: Not copied. The new row starts at `quantity_on_hand` from the modal with no movement history. If the user enters a non-zero quantity, the RPC writes a single `stock_movement` row of type `adjustment_in` with reason `duplicate_initial_count` so audit trail is intact.

### Atomicity

The whole sequence (item insert → tags insert → images insert → optional adjustment movement) runs inside the RPC's implicit transaction. Any failure (RLS deny, FK violation, SKU collision exhaustion) rolls back fully. No half-duplicated rows possible.

### Permissions / audit

- Permission: `inventory:create` (already exists, same as New Item form). No new permission.
- Audit: emit `inventory_item.duplicated` with extra `{ source_item_id, new_item_id, sku_suffix_used }`.

## Order + picker integration

### Item picker on `/orders/new`

The picker autocomplete already lists items. Update the row renderer to display:

```
{name}
{sku} · Rack {rack_label} · {quantity_on_hand} on hand
```

Where `rack_label` is the existing `bin_location` derivation (items: `R{rack_number}-{row}`, books: `R{rack}-{row} · {crate_color}{crate_number}`). Duplicates of the same SKU appear as separate rows so the picker can see and choose deliberately.

### Order lines

Each `order_request_line` already FKs to `inventory_items.id`, not to SKU. Duplicates therefore render as separate lines naturally. No schema change.

### Pick slip / packing slip

Both PDFs already render `bin_location` per line (see `apps/web/src/lib/pdf/packing-slip-shared.tsx`). No change needed — picker reads the per-line rack label and walks to that exact rack.

### Stock reservation

Reservations already happen per-line against the line's `item_id`. Duplicates reserve independently. No pooling across duplicates in v1.

### Cycle counts

Cycle counts are per `item_id`. Duplicates count independently. The Counts page lists them as separate rows because they have separate `bin_location` labels — which is what the counter wants on the floor.

### AI Shelf Scan

The scan resolves matches by SKU, but writes the count against the cycle-count *line* (which already has a specific `item_id`). So if a user scans a shelf that contains a duplicate, the line for that exact `item_id` gets the count — the original at a different rack is unaffected. This is the correct behavior; no scan-side changes.

### Reports

All reports already operate per-`item_id`. Duplicates appear as separate rows in valuation, dead-stock, velocity, etc. Group-by-SKU isn't currently a report option; we'll add it later if the user finds the duplicates noisy.

### Bundles

Bundle components FK to a specific `inventory_item.id`. If the user later wants a bundle to draw from the duplicate instead of the original, they re-point the bundle line. No automatic re-pointing.

## Edge cases

| Case | Behavior |
| --- | --- |
| Original deleted while modal is open | RPC FK-fails on read; UI shows "Original no longer exists, refresh" toast |
| SKU collision past `-99` | RPC returns `too_many_duplicates` error; UI shows "Too many duplicates of this SKU, please rename the original" |
| Same rack chosen as original | Soft inline warning, user can still confirm |
| Book duplicate where original has no crate fields | Modal still requires crate color + number; we don't backfill the original |
| User without `inventory:create` | Duplicate button hidden, RPC also denies |
| RLS deny (different warehouse) | Can't happen — warehouse is read-only in modal — but RPC double-checks scope anyway |

## Testing

### Unit tests
- SKU-suffix algorithm: `SP-ABC` → `-2`. If `-2` taken → `-3`. All `-2` through `-99` taken → throw `too_many_duplicates`.
- Custom_fields merge: arbitrary extra keys preserved verbatim; only `rack_*` / `book_*` / `bin_location` overwritten.

### Integration tests (against real Supabase)
- Duplicate item: new row exists, all column copies match, tags + item_images copied, audit row emitted, stock movement row written when quantity > 0.
- Duplicate book: same + crate fields populated, `bin_location` re-derived correctly.
- RLS: user from a different warehouse can't duplicate; user without `inventory:create` can't duplicate.
- Transaction rollback: simulate item_images insert failure → no item row left behind.

### E2E (manual)
1. Open a book on `/inventory/[id]`, click Duplicate, fill rack + crate, confirm
2. Land on new item page; verify rack label correct, photo shows, tags preserved
3. Place an order line against the duplicate, confirm packing slip shows new rack
4. Complete picking; verify the duplicate (not the original) is what dec'd

## Files to add / modify

### Add
- `supabase/migrations/0125_duplicate_inventory_item.sql` — RPC `duplicate_inventory_item(uuid, jsonb)` + explicit `grant execute` to `authenticated`
- `apps/web/src/components/inventory/duplicate-item-dialog.tsx` — modal component
- `apps/web/src/server/actions/duplicate-item.ts` — server action wrapping the RPC
- `packages/core/src/schemas/duplicate-item.ts` — zod schemas for the overrides payload (items vs books)
- `apps/web/src/server/services/items.duplicate.test.ts` — integration test for the service path

### Modify
- `apps/web/src/server/services/items.ts` — add `duplicateItem(originalId, overrides)` calling the RPC + audit emit
- `apps/web/src/app/(dashboard)/dashboard/inventory/[id]/page.tsx` — add Duplicate button next to Edit
- `apps/web/src/components/orders/item-picker.tsx` (or wherever the order item autocomplete lives) — show `Rack X · N on hand` suffix in option label

## Open questions

None. All design decisions locked during brainstorming.

## Out of scope (future)

- Bulk duplicate (select N items, duplicate all)
- Group-by-SKU report option to collapse duplicates in valuation/velocity views
- Auto-pooling stock across duplicates (single virtual quantity, picker decides at pick time)
- Cross-warehouse duplicate
