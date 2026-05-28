# Cycle Count by Selection — Design

**Date:** 2026-05-28
**Status:** Approved (brainstorming) → ready for implementation plan
**Author:** Branden + Claude

## Problem

Today a cycle count snapshots **every active item** in a warehouse (or org-wide).
To count a few specific items/books you must start a giant count and then search
through hundreds of lines on the detail page. Users want to **pick the exact
items and/or books** up front and count only those.

## Decisions (locked in brainstorming)

1. **Picker UX:** select from the existing **Inventory** and **Books** lists
   (checkboxes), then "start cycle count from selection." Reuses existing
   search/filter/pagination.
2. **Start flow:** a **confirm screen** first — review picked items, add notes,
   optionally assign to a teammate, then Start.
3. **Mix types:** one count may contain **products + books together**; selection
   persists across the two tabs.
4. **Platform:** **web + mobile** in this change. (Mobile ships via a new
   EAS/TestFlight build.)

## Non-goals (v1)

- Filter-based scoping ("count all of Rack 3" / by category). Future.
- A floating cross-page selection tray. The confirm screen's "Add more items"
  loop covers mixing.
- Changes to AI Shelf Scan, posting math, offline sync.

## Architecture

### Data model (1 migration)

`cycle_counts.scope text not null default 'warehouse'` with
`check (scope in ('warehouse','selection'))`. Existing rows default to
`'warehouse'` → zero behavior change.

- A **selection** count: header `warehouse_id = null`, `scope = 'selection'`, and
  each `cycle_count_lines` row snapshots its item's own `warehouse_id`.
- `post_cycle_count` is **unchanged**: it computes variance and the
  "moved-warehouse" guard per line off `cycle_count_lines.warehouse_id`, never
  off the header. A selection count spanning warehouses posts correctly.

### Server — `CycleCountsService.start()`

Extend the input to `{ scope: 'warehouse' | 'selection', warehouseId: string | null,
itemIds?: string[], notes?, assignedTo?: string | null }`.

- `scope === 'warehouse'` → existing behavior (snapshot all active items in
  scope), write `scope = 'warehouse'`.
- `scope === 'selection'`:
  - Validate `itemIds`: belong to org, `status='active'`, `deleted_at is null`.
    Drop any that don't match; error if zero remain.
  - **Security:** assert **write** access to every distinct `warehouse_id` among
    the validated items (`assertWarehouseAccess(wh, 'write', ctx)`); require
    `hasAllAccess` if any picked item has a null warehouse. A warehouse-scoped
    staffer cannot include items from a warehouse they can't write to.
  - Insert the count (`scope='selection'`, `warehouse_id=null`) + lines (each with
    item's `warehouse_id` + `expected_quantity` snapshot).
  - If `assignedTo` provided: run the existing `assign()` path as a **separate
    update** so the `trg_cycle_counts_assigned` trigger fires and the assignee
    gets the in-app + push notification. (Direct insert-with-assignee would NOT
    notify — the trigger is `AFTER UPDATE OF assigned_to`.)
- `itemsInScopeCount()` returns `0` for `scope='selection'` (no "new items added
  mid-count" concept), so the detail page never false-warns.
- Cap selection at a sane max (e.g. 1000 ids) in the Zod schema.

### API for mobile (new)

`POST /api/v1/cycle-counts` — Bearer auth via `withApiContext(req)`, body
`{ scope, warehouseId, itemIds?, notes?, assignedTo? }`, returns `{ id, lineCount }`.
Thin wrapper over `start()`. This is the create-path mobile lacks today.

### Web UI

- **Count-selection store** (`useCountSelection`, zustand + `sessionStorage`):
  `Map<itemId, { id, sku, name, itemType, warehouseId }>`; `add(items)`,
  `remove(id)`, `clear()`, `count`. Persists across the Inventory ↔ Books routes.
- **Inventory table:** add one entry to the existing `BulkActions` bar →
  **"Cycle count selected"** → pushes checked rows into the store, navigates to
  `/dashboard/cycle-counts/new`.
- **Books table:** add checkbox selection + a minimal bulk bar with the same
  action (no selection exists there today).
- **`/dashboard/cycle-counts/new` (reworked, client):** two modes —
  - **Selected items (N):** reads the store, grouped products/books, remove rows,
    **"Add more items"** link back to lists, notes, optional assignee (shown only
    to `cycle_counts:assign` roles). "Start count" →
    `startCycleCountAction({ scope:'selection', itemIds, notes, assignedTo })` →
    clear store → push to live count.
  - **Whole warehouse:** the existing `StartCycleCountForm`.

### Mobile UI (needs EAS build)

- **Count-selection store** (lightweight context/module store, no new dep):
  same shape as web.
- **Items + Books tabs:** a select mode (long-press or a "Select" toolbar button)
  with checkboxes feeding the store.
- **Confirm screen:** picked items, notes, optional assignee → `POST
  /api/v1/cycle-counts` (Bearer) → navigate to `/cycle-count/[id]`.
- Wire the currently-dead **`＋`** button on the Cycle counts tab to open this
  flow (pick items / whole warehouse).

## Error handling

- Empty selection after validation → `validation_error` toast.
- Items archived/deleted between pick and start → silently dropped; surface
  "Started count with N of M items (M−N were archived/removed)".
- Warehouse write denied → `forbidden` toast (existing `ForbiddenError` mapping).
- Mobile offline at create time → block with a clear message (creating a count
  requires the server RPC; offline create is out of scope for v1).

## Testing

- **Service unit tests** (`inventory`/cycle-count style): selection snapshot only
  picks active/in-org items; spans-warehouse write-gate; assignee notification
  path; `itemsInScopeCount` returns 0 for selection.
- **Posting:** existing `post_cycle_count` tests still green; add one asserting a
  selection count with mixed warehouses posts per-line.
- **API route:** `POST /api/v1/cycle-counts` 401 without bearer, creates with.
- **Web component:** Books table selection toggles; BulkActions "Cycle count
  selected" routes with store populated.

## Already shipped

- **PDF/search/barcode auth fix** (`withApiContext(req)`) — commit `c280a2c`,
  independent of this feature.

## Acceptance criteria (v1)

1. From the web Inventory list I can tick items, tick books on the Books list,
   land on one confirm screen showing both, and start a count of exactly those.
2. The confirm screen lets me add notes and (as manager+) assign it; the assignee
   gets a notification.
3. The count detail page and the count-sheet PDF show only the selected lines and
   don't warn about "items added mid-count."
4. Posting the count adjusts only the selected items, correctly, even when they
   span warehouses.
5. On mobile I can select items/books and start a scoped count that appears in the
   Cycle counts list and is countable on the floor.
6. Whole-warehouse counts still work exactly as before.
