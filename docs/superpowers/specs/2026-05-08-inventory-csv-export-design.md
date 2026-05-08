# Inventory CSV Export — Manual Buttons + Gemini Tool

**Date:** 2026-05-08
**Status:** Approved (proceeding to implementation)
**Owner:** Branden Vincent-Walker

## Goal

Let users download a CSV of inventory and books, both manually (toolbar button) and via the AI assistant (`/dashboard/ai`). Two surfaces share one API route and one CSV builder.

## Scope

- **In:** `/dashboard/inventory` and `/dashboard/books` toolbars; AI tool surface in `apps/web/src/lib/ai/tools.ts`
- **Out:** XLSX export, async/emailed exports for huge datasets, user-selectable columns, saved export templates, exports of movements / POs / cycle counts (separate features)

## User-visible behavior

### Manual export

The toolbar above the inventory or books table gains an **Export ▾** dropdown next to the "Clear" filter pill:

- **Export filtered** — downloads exactly what the current filters + sort + warehouse selector are showing
- **Export all** — ignores filters, dumps every item of the active item-type (`product` or `book`) the user has access to

Click → CSV downloads with filename like `inventory-filtered-2026-05-08.csv` or `books-all-2026-05-08.csv`.

### AI export

Inside the AI assistant chat, users can type things like *"give me a CSV of low-stock books"* or *"export everything in the Fiction category"*. Gemini calls the new `exportInventory` tool, which returns a markdown link:

> Found **47** matching items. [Download as CSV](https://stockpilotusa.com/api/inventory/export.csv?stock=low&type=book&scope=filtered)

User clicks → CSV downloads. Same API endpoint as the toolbar buttons.

## Architecture

### New API route: `GET /api/inventory/export.csv`

`apps/web/src/app/api/inventory/export.csv/route.ts`

- Wrapped in `withApiContext()` so org/role context is resolved without hitting the NEXT_REDIRECT trap on /api/* routes (per `feedback_api_route_auth.md`).
- Query params (all optional):
  - `q` — search string (matches list page)
  - `status` — `active` | `archived` | `discontinued` | `all`
  - `stock` — `low` | `out`
  - `type` — `product` | `book` | `asset` | `consumable` | `all`
  - `sort` — same `ItemListSort` keys as the list page
  - `cat` — repeated, one per selected category id
  - `loc` — repeated, one per selected location id
  - `scope` — `filtered` (default) or `all`. When `all`, ignores `q/status/stock/sort/cat/loc` (keeps `type` so books-tab "Export all" doesn't dump products)
- Pipeline:
  1. `InventoryService.list({ ...filters, limit: 10000 })`
  2. Fetch categories, locations, suppliers, warehouses (4 small queries) for name lookups
  3. Build rows; map id→name for category, location, supplier, warehouse, charter
  4. Read book-only fields from `custom_fields` — `author`, `isbn`, `book_grade`, `book_rack_number`, `book_rack_row`, `book_crate_color`, `book_crate_number`
  5. `toCsv(headers, rows)` from `lib/csv`
  6. Return `text/csv` with `Content-Disposition: attachment; filename="..."`
- 10,000-row cap: if `inventory.total > rows.length`, append a final row `# truncated at 10000 rows of <total>`. User can narrow filters and re-export.

### Column set (full)

Headers in this order:
```
name, sku, barcode, item_type, status, quantity_on_hand,
reorder_point, reorder_quantity, unit_cost, retail_price,
category, primary_location, supplier, warehouse, charter,
tracking_type, author, isbn, grade, rack_number, rack_row,
crate_color, crate_number, created_at, updated_at
```

For non-book items, the seven book-only columns are blank. Single column set across both tabs keeps the schema stable.

### Toolbar UI

`apps/web/src/components/inventory/inventory-table.tsx` toolbar gains an `<ExportMenu>` button rendered next to the existing "Clear" pill. Built on Radix Popover (same primitive as the filter dropdowns shipped earlier today).

Each menu item is a plain `<a href download>` — no JS, no client-side fetch. Browser does the download via standard navigation.

`href` for "Export filtered" mirrors current `URLSearchParams` from `useSearchParams()`, plus `scope=filtered`.
`href` for "Export all" sends only `type=<active>&scope=all`.

### AI tool: `exportInventory`

`apps/web/src/lib/ai/tools.ts` — new tool wired into the existing tool list. Description tuned for Gemini to reach for it whenever the user asks to export, download, or save items as a spreadsheet.

Param schema mirrors `searchInventory`:
- `query`, `categoryId`, `status`, `itemType`, `lowStock`, `outOfStock`, `warehouseId`

Execute step:
1. Call `InventoryService.list({ ...filters, limit: 1 })` to get the count without paying the full materialization
2. Build the CSV URL from filter params
3. Return `{ count, url }` to the model
4. Gemini's response template formats it as the markdown link the chat surface renders

No actual CSV bytes flow through the LLM — just URL + count. Lightweight.

## Edge cases

- **No matches**: returns a CSV with just headers and one row `# no items match`. Manual button still works (downloads empty CSV); AI tool surfaces "No items match" instead of a link.
- **User has no warehouse access**: `InventoryService.list` already returns empty when `access.readableIds.length === 0` — CSV gets the empty-results behavior.
- **Auth missing**: `withApiContext()` returns a 401 JSON error which the browser would render as broken download. Acceptable — only authenticated dashboard users hit this.
- **CSV injection**: `toCsv` already escapes `"`, `,`, `\n`. Defensive prefix `'` for cells starting with `=`/`+`/`-`/`@` would block Excel formula injection — verify `lib/csv` does this; if not, add it as part of this work.
- **Very large org > 10k items**: cap kicks in. Future: stream + paginate when someone actually hits this.

## Testing

Manual:
- Items tab — apply filters, click Export filtered, verify CSV matches what's on screen
- Items tab — Export all, verify count matches the org total minus archived
- Books tab — verify book-only fields populate (author, ISBN, etc.) and product fields stay
- AI chat — ask "export low-stock books", click the link, verify CSV
- Edge: no matches, archived included, warehouse-scoped user

Automated:
- Add a small test to `inventory.test.ts` or a new `csv-export.test.ts` covering the URL → CSV transform end-to-end with a mocked Supabase client
- Verify CSV-injection escaping (single quote prefix on dangerous cells)

## Out-of-scope follow-ups

- XLSX format (with formatting, multiple sheets, etc.)
- Email a CSV to the user when the export exceeds the row cap
- Stored export templates ("nightly low-stock report")
- Exports for movements, POs, cycle counts (each its own feature with its own filters)
- User-customizable column selection
- Streaming export for org-wide dumps > 10k

## Decision log

| Decision | Why |
| --- | --- |
| One API route, two surfaces consume it | Single source of truth for what gets exported; UI button = `<a href>`, AI tool = URL string returned to model |
| 10k-row cap | Sync HTTP response, gives a predictable upper bound on memory + bandwidth; way more than internal-tool sizes today |
| Full column set, not customizable | Matches user choice; column-picker UI is a follow-up if needed |
| Manual + AI both ship in one PR | Same API + builder serves both; testing one tests the other |
| Gemini tool returns URL not CSV bytes | LLM context stays tiny; no risk of huge tool-result blowing up the chat |
| `<a href download>` instead of fetch + Blob | Simpler, no JS, browser handles streaming for free |
