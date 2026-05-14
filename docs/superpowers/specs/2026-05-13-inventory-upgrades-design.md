# Inventory upgrades — scan-to-search, rack filter, size variants

**Date:** 2026-05-13
**Author:** Branden + Claude (StockPilot)
**Scope:** Three feature additions to `/dashboard/inventory` and `/dashboard/books`. One spec, three sequential PRs.

---

## 1. Overview

Three independent-but-related features expand the inventory/books workflow:

1. **Scan-to-search (Books page)** — camera scan an ISBN → jump straight to the matching book detail page.
2. **Rack filter (Books + Items pages)** — dropdown filter by rack / bin location so a user can see "everything on rack 38-A" in one click.
3. **Size variants for clothing / merch (Items)** — when a selected category supports sizes, the item form reveals a sizes multi-select; saving creates one inventory row per selected size with name + SKU suffixes.

All three are additive to the existing `inventory_items` schema; the only schema changes are a new `supports_sizes` boolean on `categories` and three new indexes. No data migration of existing rows.

---

## 2. Feature 1 — Scan-to-search (Books page)

### Trigger
- Camera icon button rendered **inside** the existing search input on `/dashboard/books` header (right edge of the input, similar to the existing search box treatment elsewhere).
- Reuse the existing `IsbnScanner` component at [apps/web/src/components/inventory/isbn-scanner.tsx](apps/web/src/components/inventory/isbn-scanner.tsx).
- Stack: `@zxing/browser` + native `BarcodeDetector` fallback (already in `package.json`). Supported formats: `ean_13`, `ean_8`, `upc_a`, `upc_e`.

### Behavior on detect
The scanner returns the decoded barcode value. Books-page logic:

```
result = await InventoryService.list({
  barcode: <scanned isbn>,
  type: 'book',
  status: 'active',  // don't navigate to archived items
})
```

- **`result.total === 1`** → `router.push('/dashboard/books/{result.items[0].id}')`. Scanner closes automatically.
- **`result.total === 0`** → toast.error: `No book found for ISBN {isbn}`. Toast includes a `Create new book` action that routes to `/dashboard/books/new?isbn={isbn}` (the existing new-book form already auto-fills from `?isbn=`).
- **`result.total > 1`** (same ISBN on multiple rows — rare) → close scanner, set search input to the ISBN. The page's normal search filter takes over and the list narrows to those rows so the user can pick.

### Where it lives
- New client component: `apps/web/src/components/books/books-search-with-scan.tsx` — wraps the existing search input with the camera button. The current `<Input>` and any debounced search logic moves into this wrapper.
- Page mod: `/dashboard/books/page.tsx` swaps the bare search input for the new wrapper.

### No DB migration. No service change.

---

## 3. Feature 2 — Rack filter (Books + Items)

### UI
- New "Rack" dropdown in each page header, sitting alongside the existing Active/Archived toggle.
- Dropdown content is **per-page distinct**:
  - **Books page** sources distinct rack labels by aggregating `custom_fields->>'book_rack_number'` and `custom_fields->>'book_rack_row'` from all books in the org. Display format: `{number}-{row}` (e.g. `38-A`). When `book_rack_row` is null, just display the number.
  - **Items page** sources distinct `bin_location` values from all non-book inventory items in the org.
- First option always: `Any rack` — clears the filter.

### Query plumbing
- New URL param: `?rack={value}`.
- `InventoryService.list` accepts a new optional filter:
  ```ts
  rack?: string;  // applied per page:
                  //   books page → matches custom_fields->>'book_rack_number' || '-' || book_rack_row
                  //   items page → matches bin_location
  ```
- The pages already accept type-specific filters; rack matching dispatches off `type === 'book' ? rackMatchBook : rackMatchItem` in the service.
- Selecting a rack:
  - Adds `?rack={value}` to the URL via the existing toggle pattern.
  - Resets `?page=1` since counts won't line up across racks.
  - Other filters (search, status, category) carry across.

### Distinct-rack source
- New server util `listDistinctRacks({ scope: 'books' | 'items' })` exposed via the existing services:
  - `InventoryService.listDistinctRacks()` returns `string[]`.
  - For books, aggregates `book_rack_number / book_rack_row` from `custom_fields`.
  - For items, returns distinct `bin_location` (lowercased, non-null, non-empty).
- Called once per page render from the server component; passed into the dropdown.

### Migration: indexes
Two indexes for query perf (small data today, but the filter will hit these columns on every page load):

```sql
-- Items page rack filter
create index if not exists inventory_items_org_bin_idx
  on public.inventory_items (organization_id, lower(bin_location))
  where bin_location is not null;

-- Books page rack filter
create index if not exists inventory_items_org_book_rack_idx
  on public.inventory_items (organization_id, (custom_fields->>'book_rack_number'))
  where custom_fields->>'book_rack_number' is not null;
```

---

## 4. Feature 3 — Size variants on variant-bearing categories

### Concept
Sizes aren't a property of "clothing" hardcoded — they're a property of any **category** that has `supports_sizes = true`. The user toggles this flag on whichever categories need it (today: Swag).

### Schema migration
```sql
alter table public.categories
  add column if not exists supports_sizes boolean not null default false;
```

No backfill needed — every existing category stays at `false`.

### Categories admin UI
- `CategoriesManager` dialog (create + edit) gets a new field:
  - Checkbox labelled `Has size variants (S, M, L, XL, …)`
  - Hint text: `When on, items in this category get a Sizes selector in the item form, and saving creates one variant per chosen size.`
- New optional field on the category create/edit zod schema + the underlying service.

### Item form behavior
- New section in the Classification block, sitting **right after Supplier**, labelled:
  ```
  Sizes (optional)
  ```
- Visibility: only renders when `selectedCategory.supportsSizes === true`.
- Content:
  - Chip group with: `S` `M` `L` `XL` `XXL` `XXXL` `XXXXL`.
  - Multi-select — clicking a chip toggles it on/off.
  - For each selected chip, an inline `Qty` input renders below the chip group (one row per selected size, each row showing the size label and a numeric input).
- When at least one size is selected, the form's single existing Qty input hides (replaced by the per-size qty inputs).
- When no sizes are selected (or category doesn't support sizes), behavior is identical to today.

### Save flow
New service method: `InventoryService.bulkCreateSizedVariants(input)`.

Input shape (TypeScript):
```ts
interface BulkCreateSizedVariantsInput {
  baseName: string;        // "L4L Black T-Shirt"
  baseSku: string | null;  // null → auto-generate per variant
  baseBarcode: string | null;
  description: string | null;
  categoryId: string;
  supplierId: string | null;
  warehouseId: string;
  primaryLocationId: string | null;
  binLocation: string | null;
  retailPrice: number;
  unitCost: number;
  reorderPoint: number;
  reorderQuantity: number;
  variants: Array<{ size: SizeCode; quantity: number; }>;
}
type SizeCode = 'S' | 'M' | 'L' | 'XL' | 'XXL' | 'XXXL' | 'XXXXL';
```

Per variant the service:
1. Computes the final name: `{baseName} - {size}`.
2. Computes the final SKU:
   - If `baseSku` is set: `{baseSku}-{size}` (uppercase size, no spaces).
   - If `baseSku` is null: the auto SKU generator runs **once** for the design (producing a single base like `SP-XYZ12-ABC`), then each variant SKU is `{generated}-{size}`. So all variants share a common SKU prefix — never one auto-gen call per variant.
3. Writes `custom_fields.size = '{size}'`.
4. Sets `quantity_on_hand = variants[i].quantity` (the per-size qty input).
5. All other fields copied identically across variants.
6. Inserts all variants in a single transaction. Plan-limit check is run once for the total count (not per row) so a 7-size submit doesn't burn through the limit one row at a time.

Permission: `assertPermission(this.ctx, 'items:create')` — same gate as the existing single-row create.

### Edit flow
Out of scope for v1. Editing a variant just edits that single row (existing behavior). No "edit design across all sizes" surface yet — that's a v2 if the user asks.

### Validation
- At least 1 size must be selected when category supports sizes (form-level error: `Pick at least one size or change the category.`).
- Each selected size must have a non-negative integer qty (default 0 if blank).
- Duplicate prevention: SKU uniqueness within (organization, sku) is already enforced by an existing unique constraint — if `SP-OKX68-UAA-S` collides with an existing row, the transaction rolls back and the form surfaces the collision per-size.

---

## 5. Implementation order

Three sequential PRs from this spec, smallest → largest:

### PR 1 — Scan-to-search
- New component `books-search-with-scan.tsx`
- Wire on `/dashboard/books` page header
- No DB change, no service change
- Test: scan triggers IsbnScanner; mock list response covers 0 / 1 / >1 cases.

### PR 2 — Rack filter
- One migration: `00xx_rack_filter_indexes.sql` (two indexes)
- `InventoryService.list` extends to accept `rack?: string`
- `InventoryService.listDistinctRacks({ scope })` new method
- Books page + Items page render the dropdown in the header
- `ArchiveViewToggle`-style chip styling (reuse the existing convention)
- Test: distinct-rack endpoint returns deduped + sorted; filter narrows the list.

### PR 3 — Size variants
- Migrations:
  - `00xx_categories_supports_sizes.sql` — add the boolean column
- CategoriesManager dialog gets the `supports_sizes` checkbox
- `CategoriesService.create / update` accept `supportsSizes`
- ItemForm: conditional Sizes chip group + per-size qty inputs
- `InventoryService.bulkCreateSizedVariants` service method
- Server action: `bulkCreateSizedVariantsAction`
- Item form submission routes to bulk-create when sizes are selected; falls through to existing single create otherwise
- Test:
  - Categories supports-sizes toggle round-trips through create/edit.
  - ItemForm shows Sizes group only when supports_sizes is true.
  - bulkCreateSizedVariants creates N rows atomically with correct name / SKU / size custom field.
  - Single-create path unchanged when no sizes are picked.

---

## 6. Out of scope (v1)

- Design-level edit (editing one variant updating all sizes simultaneously)
- Variant grouping in the inventory table view (collapse 7 size rows into one expandable row)
- Size-aware reports / "out of size L" alerts
- Image sharing across variants — each variant has its own image upload today
- Cross-page rack filter (e.g. one search across both books and items)
- Custom size sets per category (always the fixed S/M/L/XL/XXL/XXXL/XXXXL list in v1)
- Bulk-edit sized variants (raise all qty by N, change supplier on all sizes, etc.)

---

## 7. Non-goals / decisions made

- **Not** adding `item_type = 'clothing'`. Trigger is category-based (`supports_sizes` flag) so non-clothing categories (shoes, totes, hats) can opt in later without code changes.
- **Not** generalizing the "Sizes" chip group to other dimensions (color, length, width). v1 is size-only with the fixed S–XXXXL set.
- **Not** building a v2 "designs" abstraction (one parent row + variants). Each sized row is independent in the DB; the visual grouping (if ever) happens in the UI.
- Plan-limit check runs **once** per bulk create on the total row count, not per row. A 7-variant submit consumes 7 of the org's plan slots (currently free-tier is 10,000 after the 2026-05-13 bump).
