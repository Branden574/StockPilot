# Custom Export Builder — Phase 1 pre-implementation audit

**Date:** 2026-08-03
**Status:** READ-ONLY audit. No branches, no edits, no commits, no DDL/DML.
**Audience:** the implementation planner. Every claim below carries `file:line`.
**Brief:** `.superpowers/sdd/export-builder-brief.md`

---

## A. The current export pipeline, end to end

### A1. Two independent export menus (confirms brief problem #8)

There is **no shared export-config UI**. Two separate small popovers exist:

- **Page-level (filtered/all):** `ExportMenu` function, defined and rendered *inside*
  `apps/web/src/components/inventory/inventory-table.tsx:3565-3636`, mounted at
  `inventory-table.tsx:1730-1733`. Because `BooksInventoryTable`
  (`apps/web/src/components/books/books-inventory-table.tsx:14-23`) is a thin wrapper that renders
  `<InventoryTable {...props} onScanRequest={...} />`, **Books and Items already share this one
  component** — `showBookFields` is the only prop that changes behavior, and `itemType` is derived
  at the call site as `showBookFields ? 'book' : (params.get('type') ?? 'product')`
  (`inventory-table.tsx:1732`). `ExportMenu` reads `params` (the URL) to build
  `InventoryExportRequest.filters` (`inventory-table.tsx:3575-3584`) and calls
  `downloadInventoryExport({ format, scope: 'filtered'|'all', itemType, filters })`
  (`inventory-table.tsx:3589-3594`). Two `<Popover>` sections, "Export filtered" / "Export all", each
  with an Excel/PDF/CSV button row (`ExportFormatRow`, `inventory-table.tsx:3541-3563`).
- **Selected-item export:** a *completely separate* implementation in
  `apps/web/src/components/inventory/bulk-actions.tsx:171-180` (`exportSelected`) +
  `bulk-actions.tsx:310-343` (its own `<Popover>` with an inline 3-button row, not `ExportFormatRow`).
  It calls the same `downloadInventoryExport` helper but has its own local `exportBusy` state, its
  own JSX, and no `filters` (selected scope carries only `ids`).

Both call sites hold **zero configuration state** today — no field selection, no field order, no
image toggle, no layout options. The only per-call inputs are `format`, `scope`, `itemType`, `ids`,
and `filters`.

### A2. `apps/web/src/lib/download-export.ts` (full file, 57 lines)

`InventoryExportRequest` shape (lines 8-25):
```ts
export interface InventoryExportRequest {
  format: 'csv' | 'xlsx' | 'pdf';
  scope: 'selected' | 'filtered' | 'all';
  itemType?: 'product' | 'book' | 'asset' | 'consumable' | 'all';
  ids?: string[];
  filters?: {
    q?: string;
    status?: 'active' | 'archived' | 'discontinued' | 'all';
    stock?: 'low' | 'out' | null;
    expected?: boolean;
    sort?: string;
    categoryIds?: string[];
    locationIds?: string[];
    charterIds?: string[];
  };
}
```
`downloadInventoryExport` (lines 27-57) POSTs JSON to `/api/inventory/export`, reads the blob,
parses the filename out of `Content-Disposition`, and triggers a synthetic `<a download>` click. No
retry, no progress reporting, no abort — every acceptance-criteria "loading stages" / "prevent
duplicate submissions" requirement (brief §23) has to be built new here or in the dialog.

### A3. `apps/web/src/app/api/inventory/export/route.tsx` (194 lines, read in full)

- **Auth:** `withApiContext(request)` → 401 if absent (line 74); `can(ctx, 'items:export')` → 403
  otherwise (line 75-77). Quoted exactly:
  ```ts
  if (!can(ctx, 'items:export')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  ```
- **Rate limiting:** `exportRateLimited(ctx.userId, ctx.organizationId)` (line 81-82) — see E1 below
  for the exact policy. Emits `security.export_rate_limited` audit + a Slack/Teams dispatch on trip.
- **Body schema (Zod, lines 33-52):** `format` enum csv/xlsx/pdf; `scope` enum
  selected/filtered/all; `itemType` enum product/book/asset/consumable/all (default `'all'`); `ids`
  `.array(z.string().uuid()).max(10_000)`; `filters` object mirroring the client shape. **This is the
  schema the brief's §16 "Extend InventoryExportRequest" must widen** — today it has no `fields`, no
  `options`, nothing image/layout-related.
- **Scope handling:** `scope === 'selected'` requires non-empty `ids` (line 93-98, 400 otherwise).
  `scope === 'filtered'` builds an `InventoryExportFilters` that additionally resolves
  `getActiveWarehouseFilterFor(ctx)` (line 100-115) — **this is the warehouse scoping**: the active
  org-cookie warehouse is applied only on the `filtered` path, matching what the visible list would
  show; `all` and `selected` intentionally bypass it (an explicit "export everything"/"export exactly
  these ids" contract).
- **Row build:** one call, `buildInventoryExportRows(ctx, { scope, itemType, ids, filters })`
  (line 117) — shared by every format.
- **Format dispatch:** CSV → `toCsv(result.headers, result.rows)` + a truncation comment row
  (line 120-131); XLSX → `toInventoryXlsx(result.headers, result.rows)` (line 134-145); PDF →
  fetches `organizations.name, logo_url` for branding (line 148-154), then
  `renderToStream(<ReportTablePdf ... sections={[{ columns: PDF_COLUMNS, rows: ... }]} />)`
  (line 157-171), converted to a web `ReadableStream` (line 172).
- **`PDF_COLUMNS` — the hardcoded array the brief demands be replaced (quoted verbatim, lines
  56-64):**
  ```ts
  const PDF_COLUMNS: ReportColumn[] = [
    { key: 'name', label: 'Name', width: 3 },
    { key: 'sku', label: 'SKU', width: 1.4 },
    { key: 'quantity_on_hand', label: 'On hand', align: 'right', width: 0.9 },
    { key: 'category', label: 'Category', width: 1.4 },
    { key: 'primary_location', label: 'Location', width: 1.4 },
    { key: 'charter', label: 'Charter', width: 1.4 },
    { key: 'status', label: 'Status', width: 1 },
  ];
  ```
  This is IDENTICAL to the owner's screenshot column order (`NAME | SKU | ON HAND | CATEGORY |
  LOCATION | CHARTER | STATUS`) — confirms the screenshot came straight from this route with zero
  customization. There is no ISBN column, no image column (`imageColumn` is never set on the section
  object), and this is the ONLY place PDF columns are chosen — the format has no other config path.
- `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`, **`maxDuration = 60`** set inline (comment: "api/inventory is not under a vercel.json functions glob, so set the budget inline").
- A **legacy sibling route**, `apps/web/src/app/api/inventory/export.csv/route.ts` (130 lines, read in
  full), is CSV-only, GET-based (query-string filters), same `items:export` gate, same
  `exportRateLimited`, same `maxDuration = 60`, and calls the SAME `buildInventoryExportRows`. It
  predates the unified POST route and is presumably kept for existing bookmarked links / API
  consumers — the new builder should not need to touch it, but it will keep emitting the OLD
  fixed-column shape forever unless it's deliberately left alone (worth flagging to the plan, not a
  blocker).

### A4. `apps/web/src/lib/inventory-export.ts` (185 lines, read in full)

`INVENTORY_EXPORT_HEADERS` — the canonical CSV/Excel column set today (lines 11-37), 25 columns:
```
name, sku, barcode, item_type, status, quantity_on_hand, reorder_point, reorder_quantity,
unit_cost, retail_price, category, primary_location, supplier, warehouse, charter,
tracking_type, author, isbn, grade, rack_number, rack_row, crate_color, crate_number,
created_at, updated_at
```
`ROW_CAP = 10_000` (line 39). `buildInventoryExportRows` (lines 81-185):
- Calls `InventoryService.list(...)` with per-scope filter shaping (lines 86-113) — `selected` uses
  `expected: 'any'` so an explicitly-checked flagged row is never silently dropped (mig 0277 note,
  lines 90-94).
- **Fail-closed lookups**: categories/locations/suppliers/warehouses/charters are each wrapped in a
  `safe()` helper (lines 116-122) that swallows a throw and returns `[]` — a disabled module or RLS
  error blanks that one column instead of 500ing the whole export.
- **Row shape** (lines 136-176) — exact fields, verbatim:
  ```ts
  {
    name: i.name, sku: i.sku, barcode: i.barcode ?? '', item_type: i.item_type, status: i.status,
    quantity_on_hand: i.quantity_on_hand, reorder_point: i.reorder_point,
    reorder_quantity: (i as unknown as { reorder_quantity?: number }).reorder_quantity ?? 0,
    unit_cost: i.unit_cost, retail_price: i.retail_price,
    category: i.category_id ? (catMap.get(i.category_id) ?? '') : '',
    primary_location: i.primary_location_id ? (locMap.get(i.primary_location_id) ?? '') : '',
    supplier: i.supplier_id ? (supMap.get(i.supplier_id) ?? '') : '',
    warehouse: i.warehouse_id ? (whMap.get(i.warehouse_id) ?? '') : '',
    charter: i.charter_id ? (chMap.get(i.charter_id) ?? '') : '',      // <-- see BUG 3
    tracking_type: i.tracking_type, author: str('author'),
    isbn: i.item_type === 'book'
      ? (i.barcode ?? '') || str('isbn') || str('isbn13') || str('isbn10')
      : '',
    grade: str('book_grade'), rack_number: str('book_rack_number'),
    rack_row: str('book_rack_row'), crate_color: str('book_crate_color'),
    crate_number: str('book_crate_number'),
    created_at: i.created_at, updated_at: i.updated_at,
  }
  ```
  `str(k)` (lines 138-141) reads `custom_fields[k]`, returns `''` for `null`/`undefined`, else
  `String(v)` — so `0` and `false` DO render (not treated as empty), only `null`/`undefined` do.
- **No permission gate on `unit_cost`/`retail_price` here or anywhere else in this file** — see B6.
- Returns `{ headers, rows, total, truncated: total > rows.length, slug: itemType==='book'?'books':'inventory' }`.

**The ISBN derivation is already exactly what the brief's REUSE note describes** — `barcode` when
the item is a book, else the three custom_fields fallbacks, else `''`. The brief's priority order
(barcode → `custom_fields.isbn` → `isbn13` → `isbn10` → blank) is IMPLEMENTED, not missing. The bug
is elsewhere (see BUG 2 below): `PDF_COLUMNS` in the route just never lists `isbn` as a column.

### A5. `apps/web/src/lib/inventory-export-xlsx.ts` (47 lines, read in full)

`toInventoryXlsx(headers, rows)`:
- One worksheet named **`'Inventory'`** always (line 19) — never `'Books'`, contradicting brief §14
  ("worksheet named Books/Inventory").
- Column width: `Math.min(Math.max(h.length + 2, 12), 44)` (line 24) — derived from the **raw header
  key length** (e.g. `"quantity_on_hand"` → 18), not a friendly label; there is no header→label
  mapping layer at all today.
- Every string cell passed through `escapeForSpreadsheet` (formula-injection guard) before insertion
  (lines 31-35); numbers pass through unwrapped as real numbers — **`isbn` is a string field already
  (see A4), but nothing sets `cell.numFmt = '@'`** on it, so Excel's automatic type-sniffing can still
  render a numeric-looking ISBN as a number (leading-zero loss / scientific notation risk) even
  though the underlying value survived formula-escaping. This is a real (if narrower than feared)
  version of brief problem — worth confirming, but note the *cell value* is a string already; the gap
  is purely the missing explicit number format.
- Header row: bold, frozen (`ws.views = [{ state: 'frozen', ySplit: 1 }]`, line 43). No autofilter, no
  alternating rows, no right-aligned numerics, no currency/date formats, no embedded images, no
  summary sheet. Every one of these is a genuine gap (see GAPS).

### A6. `apps/web/src/lib/pdf/report-table.tsx` (273 lines, read in full) — see BUG 1 below for the header-collision root cause

- `ReportColumn` (lines 25-35) today has exactly: `key`, `label`, `align?`, `width?` (a bare relative
  flex-weight number, default `1`). **No `minWidth`, `maxWidth`, or `wrap`** — the brief's §3.1
  "Consider ReportColumn layout props (key,label,align,width,minWidth,maxWidth,wrap)" names fields
  that don't exist yet.
- `flexForColumn(col)` (lines 159-161) just returns `col.width ?? 1`; `SectionView` (lines 179-244)
  computes `totalFlex = sum(flexForColumn)` once and every header/body cell gets
  `{ flex: flexForColumn(col) / totalFlex }` — a pure ratio split of whatever width `@react-pdf`
  gives the row. No minimum pixel/point width is ever enforced, so a column can be squeezed
  arbitrarily thin (this is the "naive shrinking" the brief explicitly forbids reproducing).
- **Optional image column** (§ existing support, brief asks how it sizes rows): `section.imageColumn`
  (boolean, default false) reserves a **fixed `IMAGE_COL_WIDTH = 22` pt** cell (line 75, used at
  lines 129-133, 190, 216-224) on the LEFT of every row. The image is `objectFit: 'cover'` (not
  `'contain'` — brief §3.4 wants `contain` to preserve aspect ratio without cropping) at a fixed
  22×22pt (`thumb` style, lines 134-139); a missing `row.imageUrl` renders `thumbPlaceholder`, a plain
  gray box (lines 140-148, 221-223) — the row height itself is **never adjusted** for the image; body
  rows use a fixed `paddingVertical: 4` (line 118-121) regardless of density or image size. There is
  no Small/Medium/Large size concept, no per-row-height computation of any kind, and `wrap={false}` on
  every row (line 215) so nothing can span pages that grows tall — a genuinely tall image row today
  would just overflow the fixed 22pt cell height (nothing observed enforces it) but the ROW ITSELF has
  no mechanism to grow.
- Fixed `Page size="LETTER" ... orientation="landscape"` (line 258) — no portrait, no Legal, no Auto,
  no per-request choice at all.
- One `<Document><Page>...<Page>` per call — no repeated-header-per-page config (react-pdf repeats
  header rows on page breaks automatically only if you re-render them inside a `fixed` wrapper, which
  this component doesn't use), no explicit page-number footer, no "Page X of Y", no generated-date
  stamp beyond whatever `BrandedHeader` renders (not audited here — out of scope for the export path,
  but reusable — see REUSE MAP).

### A7. CSV utilities — `apps/web/src/lib/csv.ts` (129 lines, read in full)

- `escapeForSpreadsheet(value)` (lines 92-108): prefixes a leading `= + - @ \t \r` with a single
  quote `'` — the formula-injection guard, covering the OWASP CSV-injection variants including
  leading-tab/CR.
- `toCsv(header, rows)` (lines 110-128): applies `escapeForSpreadsheet` first, then standard
  RFC-4180-style quoting whenever the (already-escaped) value contains `"`, `,`, or `\n` — doubles
  embedded quotes. **No UTF-8 BOM is written** — brief §15 flags this as something to verify before
  changing (current consumers presumably tolerate BOM-less UTF-8; adding a BOM is a behavior change
  that needs explicit sign-off, not an assumed win).
- `csvFilename(slug, suffix)` (lines 74-79) — the ONLY existing filename-building helper, used by the
  legacy `.csv` routes, not by the new POST route (which inlines `exportFilename` in
  `route.tsx:66-69`, format `${slug}-${scope}-${date}.${ext}`). Two independent filename builders
  exist today; the brief's descriptive-preset filenames (`books-with-covers-2026-08-03.xlsx`) need a
  single new one that both can converge on, or the builder owns filename generation exclusively for
  its own downloads.

---

## B. The data model facts the brief depends on

### B1. ISBN storage — confirmed, exact code already quoted in A4

`inventory_items.barcode` is the ISBN for books (form-level convention: the same input is labeled
"ISBN" for books / "Barcode" otherwise — `apps/web/src/components/inventory/item-form.tsx:2241`,
`mode={isBook ? 'isbn' : 'barcode'}`). Legacy fallbacks `custom_fields.isbn` / `isbn13` / `isbn10`
exist ONLY as export-time fallbacks (`inventory-export.ts:164-167`) — no current item-creation form
writes those three keys; they're read-only compatibility for old imported data. `grep` across
`item-form.tsx` confirms no `isbn13`/`isbn10` field is rendered anywhere in the current UI.

### B2. Book custom_fields — exact keys, from `apps/web/src/lib/book-storage.ts` (full file read)

```
book_rack_number   -- e.g. "38"
book_rack_row      -- e.g. "A"
book_crate_color   -- slug from CRATE_COLORS (@stockpilot/core)
book_crate_number  -- "1".."9" (CRATE_NUMBERS)
book_grade         -- one of GRADES: Pre-K, K, 1-12, College, Adult
author             -- (read directly by inventory-export.ts's str('author'), not in book-storage.ts)
```
`readBookStorage(customFields)` returns `{ rackNumber, rackRow, crateColor, crateNumber, grade,
rackLabel, crateLabel }` where `rackLabel` = `"{number}-{row}"` (e.g. `"38-A"`) and `crateLabel` =
`"{ColorLabel} {number}"` or bare `{number}` (e.g. `"Red 5"` / `"5"`) — **this is the exact
combined-display logic the brief's §8 "PDF may combine storage fields for display (Rack: 38-A /
Crate: Blue 12)" is asking to reuse**, already built and already used by the list page.
No book-specific field dictionary doc exists under `docs/superpowers/specs/` — only the sports one
(`2026-07-27-sports-field-dictionary.md`, unrelated module). Book fields are documented only in this
source file's header comment.

### B3. Charter — the exact "Generic" bug (see BUG 3 below for the full chain)

`inventory_items.charter_id` is nullable. NULL means "generic stock — any charter the warehouse
services can use." The list page's render logic
(`apps/web/src/components/inventory/inventory-table.tsx:2154-2176`, quoted verbatim):
```tsx
const charter = item.charter_id
  ? (lookups.charters?.get(item.charter_id) ?? null)
  : null;
if (charter) {
  return <span ...>{charter.code ?? charter.name}</span>;
}
// charter_id IS NULL = generic stock (any charter serviced by the warehouse can use it).
return (
  <span className="text-[11px] italic text-[var(--ed-ink-4)]" title="Generic stock — ...">
    Generic
  </span>
);
```
The identical pattern repeats at `inventory-table.tsx:2903-2919` and `:3273-3289` (grouped-row
variants). **This "Generic" sentinel exists ONLY in the list-rendering components** — it is not a
stored value, not a lookup-table row, and not reproduced anywhere in the export pipeline.

### B4. Item images — `item_images` table columns (from `apps/web/src/server/services/item-images.ts`, full file read)

Confirmed columns via the service's `.select(...)` calls: `id, storage_path, alt, sort_order,
is_primary, thumb_path, lqip, item_id, organization_id`. Ordering for "the primary image" is always
`.order('is_primary', { ascending: false }).order('sort_order', { ascending: true })` — i.e. `is_primary`
wins, ties broken by `sort_order` (first-inserted first). No dedicated `is_primary=true` unique
constraint is visible from this file (not verified against the migration directly, but every read
path defensively takes the first row after that ordering, which implies the code doesn't trust a
DB-level uniqueness guarantee).

**Thumbnail generation**: `thumb_path` is a **pre-resized ~200px WebP**, uploaded client-side at
upload time (`createUploadUrl`, lines 683-725: mints a signed upload URL for the master AND a sister
`{uuid}-thumb.webp` path in the same call — the thumbnail is generated by the CLIENT before upload,
not server-side post-processing). `lqip` is a base64 16×16 WebP blur placeholder, also client-supplied
(`record(itemId, storagePath, isFirst, { thumbPath, lqip })`, lines 567-646).

**Signed URL generation**: bucket is **`item-images`** (Supabase Storage). `SIGNED_URL_TTL_SEC = 30 *
24 * 60 * 60` (30 days, line 31); the URL itself is additionally cached via Next's `unstable_cache` for
`SIGNED_URL_CACHE_SEC = 25 * 24 * 60 * 60` (25 days, line 32) so the SAME path always resolves to the
SAME signed URL for ~25 days (deliberate, per the file's header comment, for image-optimizer cache
hits). Signing goes through `createAdminClient()` (service-role) — never the user's RLS client — because
signing is org-agnostic once the caller already proved read access to the `item_images` row.

**Four resolver methods exist, already purpose-built for different consumers** — this is the
biggest single reuse win for the image pipeline (brief §18):
- `primaryImagesForItems(itemIds)` (lines 304-333) → `Map<itemId, masterUrl>` — generic.
- `primaryImagesWithThumbsForItems(itemIds)` (lines 351-399) → `Map<itemId, {url, thumbUrl, lqip}>` —
  what the LIST PAGES use (master + thumb + blur placeholder in one batched call).
- **`primaryImagesForPdfRendering(itemIds, targetWidth = 200)` (lines 422-499)** — already exists,
  already exactly what the brief's cover-image feature needs: prefers the stored `thumb_path`
  (signed directly, no transform) and falls back to a Supabase Storage on-the-fly `transform: {width,
  height, resize: 'cover'}` of the master for pre-0122 rows with no thumb. **Then a second fallback
  phase (lines 468-497) reads `inventory_items.custom_fields.thumbnail_url`** for items with NO
  `item_images` row at all — this is the "bulk-imported books store the cover URL in custom_fields
  instead of creating an item_images row" case the code comment names explicitly
  (`books-bulk-import.ts:79`). **This exact function is the brief's required priority chain**
  ("generated thumbnail → primary image → verified legacy book thumbnail → placeholder") already
  implemented, already returning small (~20-50KB) images sized for embedding, already resilient (a
  per-item resolution failure just leaves that id out of the map — the caller renders a placeholder).
- `primaryMasterUrlsForItems(itemIds)` (lines 513-565) — sharp 2048px master, used by the public
  catalog (per the file's doc comment and the project memory on the public-catalog image pipeline) —
  **NOT what a PDF/Excel export should use** (would balloon export size); the memory's landmine
  ("never on-demand Supabase master transforms") is about a DIFFERENT, already-reverted code path
  (noted in the file at lines 211-217) — `primaryImagesForPdfRendering`'s on-the-fly transform is the
  one exception the codebase already accepted, scoped to PDF thumbnails only, and is safe to keep
  reusing.

### B5. Inventory list item types

`InventoryListItemRow` and `InventoryListLookups` are defined/exported from
`apps/web/src/server/loaders/inventory-list.ts` (imported at `books/page.tsx:33-34`) — the shape the
Books/Items pages pass into `InventoryTable`. The table's own `Item` interface
(`inventory-table.tsx:77-167`) is the row shape actually rendered; it carries `charter_id`,
`category_id`, `primary_location_id`, `unit_cost`, `retail_price`, `custom_fields`, plus the
image/placement/instant-mode fields documented inline (image_url, image_thumb_url, image_lqip,
placed_racks, rackHoldingsCount, etc. — see the full interface, lines 77-167, for the complete list).
`ItemListFilters` (service-level query filters) is defined at
`apps/web/src/server/services/inventory.ts:225-330+` and `ItemListSort` at lines 211-223 (ten values,
matches the export route's sort enum).

### B6. Financial fields + permission — **no dedicated gate exists** (contradicts a brief assumption — see below)

`unit_cost` and `retail_price` are selected unconditionally by `InventoryService.list()`
(`inventory.ts:502`, part of the base `.select(...)` column list) and rendered unconditionally in
`item-detail.tsx` (`@ {formatCurrency(item.unit_cost)}` line 538, `<Stat label="Retail price" .../>`
line 684) and exported unconditionally by `buildInventoryExportRows` (A4 above) — **gated by nothing
other than `items:read` (to see the item at all) and `items:export` (to export it)**. A full read of
`packages/core/src/constants/permissions.ts` (`PERMISSIONS` array, `ROLE_PERMISSIONS`,
`PERMISSION_META`) turns up **no `items:view_cost`, no `financials:*`, no cost/valuation-specific
permission of any kind** — grepped for `cost|financ|valuation` across the file, zero hits outside
comments about unrelated features. `items:export`'s own metadata (`permissions.ts:427-431`):
```ts
'items:export': {
  group: 'Items',
  label: 'Export CSV',
  description: 'Download the inventory list as a CSV file.',
},
```
(Label/description are stale — the route already supports xlsx/pdf too.)

### B7. `items:export` permission — confirmed location

Defined in `PERMISSIONS` (`permissions.ts:23`), granted to `owner`/`admin` (via `ALL_PERMISSIONS`,
line 123-124) and explicitly to `manager` (line 132); NOT listed under staff/viewer role blocks
(not fully re-verified past line 150, but the manager block is the highest non-admin tier and it's
present there). Checked at both export routes via `can(ctx, 'items:export')`.

### B8. Warehouse scoping in exports

Only the `scope: 'filtered'` path applies warehouse scoping, via `getActiveWarehouseFilterFor(ctx)`
(`route.tsx:113`, reads the active-warehouse cookie the same way the list pages do). `scope: 'all'`
and `scope: 'selected'` do not apply it — `all` means every org row regardless of warehouse-cookie
state, and `selected` is scoped by the explicit id list instead (the ids themselves came from an
already-warehouse-filtered view, but the export doesn't re-check that).

---

## C. UI infrastructure inventory

### C1. Dialog / Select / Popover / Toast — all present; **Checkbox and Tabs do NOT exist as shared components**

- `apps/web/src/components/ui/dialog.tsx` — Radix-based, exports `Dialog, DialogTrigger,
  DialogPortal, DialogClose, DialogOverlay, DialogContent, DialogHeader` (+ `DialogFooter`,
  `DialogTitle`, `DialogDescription`, not re-quoted here but present per usage in bulk-actions.tsx).
  Deliberately has **no `backdrop-blur`** (perf note in the file: CPU-rendered full-viewport blur was
  measured as visible lag) — worth respecting in the new dialog.
- `apps/web/src/components/ui/select.tsx` exists (`Select, SelectTrigger, SelectValue, SelectContent,
  SelectItem` — used throughout bulk-actions.tsx).
- `apps/web/src/components/ui/popover.tsx` exists (`Popover, PopoverTrigger, PopoverContent`).
- `apps/web/src/components/ui/sonner.tsx` — `sonner`'s `Toaster`, theme-aware, `richColors`,
  `closeButton`, positioned `bottom-right`. `toast.success/.error` from `'sonner'` is the house
  pattern (used identically in both `inventory-table.tsx` and `bulk-actions.tsx`).
- **`ls apps/web/src/components/ui/*.tsx`** (full listing) contains: `archive-view-toggle, avatar,
  badge, blank-zero-number-input, button, card, chart, destructive-confirm, dialog, dropdown-menu,
  empty-state, icon-mark, image-hover-preview, input, label, local-datetime, password-input,
  pagination, popover, select, separator, sheet, signature-pad, skeleton, sonner, sparkline,
  stock-bar, table, textarea`. **No `checkbox.tsx`, no `tabs.tsx`.**
- Checkboxes today are hand-rolled `<button role="checkbox" aria-checked=... />` elements (e.g.
  `inventory-table.tsx:3348`, `:3504`; the same pattern in `bulk-actions.tsx:283-296` for "unselect
  all"). The brief's field-selection checklist and format-selection "tabs" will need either a new
  shared `Checkbox`/`Tabs` primitive or the same hand-rolled button pattern extended — a genuine gap,
  not a reuse.
- `sheet.tsx` exists (a side-drawer) — a plausible reuse for the brief's §27 "narrow screens:
  full-screen-ish dialog" mobile treatment, worth the planner's evaluation.

### C2. No sortable/reorderable list component exists

Grepped for `sortable|SortableList|dnd-kit|react-beautiful-dnd|reorder` across
`apps/web/src` and `apps/web/package.json` — every hit was either a Sports `reorder_point` field
name or a "reorder" report route name, not a drag/reorder UI primitive. **No dnd-kit, no
react-beautiful-dnd, no existing sortable-list component anywhere in the web app.** The brief already
anticipates this (§10: "Accessible reordering: drag-and-drop optional but MUST have keyboard
controls") — build the keyboard-controls version first; do not treat drag-and-drop as a reuse.

### C3. Saved-view infrastructure — exists, but is scoped to list-toolbar STATE, not export config

`apps/web/src/server/services/saved-views.ts` (full file read): `SavedViewsService` backed by a
`saved_views` table (`id, organization_id, user_id, scope, name, state, sort_order, created_at,
is_shared`). `SavedViewState` (lines 17-26) is a **whitelisted, sanitized subset**: `q, status, stock,
type, sort, cat[], loc[], warehouseId` — it has NOTHING about export fields/format/images/layout.
`scope` is `'inventory' | 'books'` only — it's the Books/Items TOOLBAR filter state, unrelated to
export presets. `create()` enforces a 1-80 char name and a unique-per-(user,org,scope,name)
constraint (23505 → friendly error). **This IS the pattern to imitate for the brief's §21 "Saved
export presets," but it is NOT directly reusable as-is** — a new table/service (or a new `state`
shape/scope value on this same table) is needed; "persist now ONLY if existing infra supports it
cleanly" (brief) reads as: extending this table's `scope` enum + `state` shape is plausible LOW-risk
reuse, but the sanitizer, RLS policy, and unique-name constraint all need re-verification for the
export-preset shape before assuming it fits unchanged.

### C4. Books page vs Items page

- Both pages render the **same `InventoryTable`** component (Books via the `BooksInventoryTable`
  wrapper, `showBookFields` always true; Items directly, `showBookFields` defaults false). Route:
  Books = `apps/web/src/app/(dashboard)/dashboard/books/page.tsx` (656 lines, read in full); Items =
  `apps/web/src/app/(dashboard)/dashboard/inventory/page.tsx` (not fully read — same architecture
  confirmed via the shared `InventoryListItemRow`/`loadInventoryList`/`loadInventoryDataset` imports
  and the identical `SortParam`/`VALID_SORTS` set in both).
- Books forces `itemType: 'book'` server-side and `showBookFields` client-side; Items defaults to
  `product` (or the type param). Both share the exact same URL filter vocabulary: `q, status, stock,
  auto, expected, page, sort, cat[], loc[], charter[], rack`.
- **"Filtered" scope = whatever the CURRENT URL search params encode** — `ExportMenu`'s
  `filtersFromParams()` (`inventory-table.tsx:3575-3584`) reads `params.get('q'|'status'|'stock'|
  'expected'|'sort')` and `params.getAll('cat'|'loc'|'charter')` directly off `useSearchParams()`.
  This means "export filtered" is **always a re-derivation from the URL**, not from any client-side
  filter-state object — the export builder's "filtered" scope should keep reading the same
  `URLSearchParams`, not invent a parallel filter-state representation.
- Both pages support **Instant Mode** (client-side full-dataset derivation for orgs at/under a row cap,
  manager+ only) — this is orthogonal to export (exports always go server-side through
  `InventoryService.list`), but worth the planner knowing the "filtered" view on screen may be
  locally-derived while the export of that same view re-queries the server — the two must agree on
  filter semantics, which they already do because both read the same URL params.

---

## D. Test infrastructure

### D1. Existing export/PDF/Excel/CSV tests

- **`apps/web/src/lib/inventory-export.test.ts`** (147 lines, read in full) — the only export unit
  test today. Covers: canonical headers + resolved lookup names; fail-closed lookup blanking; `ids`
  passthrough for `scope=selected`; `expected:'any'` for selected scope (mig 0277); `expected`
  forwarding + lifecycle-spanning for filtered scope; truncation flag. **No test asserts on `isbn`,
  `charter`'s Generic-vs-blank behavior, or any PDF/Excel-specific transform** — all gaps a new test
  suite must cover (the brief's §28 registry/export-builder/PDF/Excel/CSV test lists are effectively
  ALL new).
- **No `inventory-export-xlsx.test.ts` exists** — zero unit coverage of `toInventoryXlsx` today
  (confirmed by file search; only the implementation file exists).
- **No `route.test.ts` for `/api/inventory/export`** — the POST route has zero test coverage
  (confirmed by directory listing: only `route.tsx` exists in that folder). The GET
  `/api/inventory/export.csv` sibling also has no test file. Compare: `movements/export.csv`,
  `orders/export.csv`, and `po-imports/[id]/export.csv` DO each have a `route.test.ts` — the
  inventory export routes are the outlier with no coverage.
- **`apps/web/src/lib/pdf/report-table.tsx` has no dedicated test file** either — zero assertions on
  header/body alignment, image-column sizing, or column-fit today. This directly explains why the
  header-collision bug shipped unnoticed (see D2).
- Other PDF tests exist for *different* PDF surfaces and ARE a strong reuse pattern: `po.test.tsx`,
  `cycle-count.group.test.ts`, `pick-slip.test.ts`, `count-sheet-location.test.ts`,
  `packing-slip-shared.test.ts`, `packing-slip-warehouse.test.ts`, `count-sheet-cap.test.ts`,
  `po-parser/pdf.test.ts`, `cycle-counts/[id]/pdf/route.test.ts` — none of these touch
  `report-table.tsx`; they test unrelated hand-built PDF layouts.

### D2. `apps/web/src/lib/pdf/table-fit.test.ts` — the reuse pattern that would have caught BUG 1

423 lines, tests `./po` (the **purchase-order** PDF, `apps/web/src/lib/pdf/po.tsx`), NOT
`report-table.tsx`. Its own header comment explains its existence precisely: the owner once reported
a receipts row rendering as `"R-20260721-223330-e7a08bJul 21, 2026"` — text touching text with no
gap, because `@react-pdf` silently overflows columns rather than erroring. The test hard-codes
Helvetica AFM glyph-width metrics and asserts, **for every column, that the widest content it can
ever hold fits inside the content box its flex weight buys once each cell's gutter (`CELL_GUTTER =
6`, `po.tsx:50`) is reserved.** This is EXACTLY the class of invariant that would have caught the
Books PDF's `ON HAND`/`CATEGORY` collision — and it is exactly what does not exist for
`report-table.tsx`. **This is the single strongest reuse pattern for the new PDF layout's test
suite** — port the technique (font-metrics-based worst-case-width assertions), not the PO-specific
code.

### D3. Component-test idiom — `delivery-request-action.test.tsx` (house style, read in full for the stub section)

Pattern to imitate for the new `ExportBuilderDialog` tests:
```ts
vi.mock('sonner', () => ({ toast: { success: (...a) => toastSuccess(...a), error: (...a) => toastError(...a) } }));
const someActionSpy = vi.fn(async (..._args: unknown[]) => {});
vi.mock('@/server/actions/...', () => ({ someAction: (...a) => someActionSpy(...a) }));
```
Rest-param spies (`(...a: unknown[]) => {}`) rather than zero-arg mocks, specifically so
`mock.calls[0]![0]` typechecks under `noUncheckedIndexedAccess`. `@testing-library/react` +
`@testing-library/user-event` + `render/screen/waitFor/within` is the standard stack. Test data is
built via a `makeInput(overrides)` factory function — the same shape the new dialog's tests should
use for a `makeExportRequest(overrides)`-style factory.

### D4. Playwright status — confirmed NOT wired into CI, unchanged from the delivery-request-assistant program's finding

`apps/web/playwright.config.ts` exists. `apps/web/tests/e2e/` contains exactly 5 specs:
`inventory.spec.ts, settings.spec.ts, dashboard.spec.ts, landing-intro.spec.ts, movements.spec.ts`.
`.github/workflows/` contains `ci.yml, prewarm-on-deploy.yml, security-scan.yml` — **grepped for
"playwright" across all three workflow files: zero hits.** Playwright is not invoked by CI today; the
brief's §28 "E2E (12-step Books PDF flow...)" tests would run locally/manually only unless CI wiring
is added as part of this program (out of scope per the brief's own framing, but the planner should
not assume a green E2E gate exists).

---

## E. Constraints and risks the plan must honor

### E1. Row caps and rate limits — exact values

- **Export row cap: `ROW_CAP = 10_000`** (`inventory-export.ts:39`, duplicated as a local constant in
  the legacy `export.csv/route.ts:24` — two independent copies of the same number, not shared from
  one source).
- **Rate limit: 40 exports/hour per user, fail-CLOSED** (`export-rate-limit.ts:36`,
  `checkRateLimit(\`export:${userId}\`, 40, 60*60*1000, 'closed')`). Trip → 429 with `retry-after`
  header + a `security.export_rate_limited` audit row + a deduped (1/hr) Slack/Teams alert dispatch.
  This budget is **shared across CSV/Excel/PDF and both the legacy and unified routes** (same
  `export:${userId}` key) — a new image-heavy PDF export counts against the same 40/hr budget as a
  bare CSV.
- **`maxDuration = 60`** (seconds) set inline on both `/api/inventory/export/route.tsx` and
  `/api/inventory/export.csv/route.ts` (each has its own explicit constant + comment, not shared).
  The sibling `/api/reports/[slug]/pdf/route.tsx` sets **no `maxDuration`** at all (falls back to the
  platform/`vercel.json` default) — worth the planner confirming what that default actually is before
  assuming 60s is the ceiling everywhere image-heavy PDF rendering might run.

### E2. Package versions (from `apps/web/package.json`)

`@react-pdf/renderer: ^4.5.1`; `exceljs: ^4.4.0`; `react: ^19.0.0`; `next: ^16.2.7`. Both PDF/Excel
libraries are already installed — no new dependency needed for the format engines themselves.

### E3. Recurring-bug-pattern / perf-memory constraints that bind this work

- **Never on-demand Supabase MASTER transforms** (public-catalog image pipeline memory) — the ONE
  accepted on-the-fly transform in this codebase is `primaryImagesForPdfRendering`'s
  master-with-`transform:{width,height,resize:'cover'}` fallback (B4 above), explicitly scoped to
  PDF-sized thumbnails for rows with no pre-generated `thumb_path`. The new Excel/PDF image embedding
  must reuse THIS function (or its pattern) — never resolve `primaryMasterUrlsForItems` (the
  2048px-master resolver meant for the public catalog / next/image) for export rendering; that would
  reintroduce the landmine at export scale (hundreds of full 2048px fetches server-side for one PDF).
- **Bulk metadata, never N+1**: every existing `ItemImagesService` resolver is already batched (one
  `item_images` query + one `signedUrls` batch call for the whole item-id list) — the new image-data
  pipeline (brief §18, `InventoryExportSourceRow`) must call these batched resolvers ONCE per export,
  not per-row.
- **Fail-closed lookups, not fail-open**: `buildInventoryExportRows`'s `safe()` wrapper (A4) is the
  established idiom — any new per-field resolver (e.g. resolving image URLs only when requested)
  should follow the same "swallow and blank" contract rather than let one bad row 500 the whole
  export.
- **Formula-injection escaping is centralized in `csv.ts`** (`escapeForSpreadsheet`) and already reused
  by the xlsx writer (A5) — any new cell-producing path (embedded images excepted — they're binary,
  not string cells) must keep routing string values through this same function, not reimplement
  escaping ad hoc.
- **Recurring bug pattern #22** (from the org's own pattern list): `.update().eq()` fail-open and
  `void supabaseBuilder` — not directly triggered by this read-only export path, but worth the
  implementation plan re-checking if any new preset-save/update path is added (C3).

---

## THE THREE BUGS EXPLAINED

### BUG 1 — "ON HAND" and "CATEGORY" headers visually run together

**Root cause: `headerCell` has zero horizontal padding; `cell` (body) does.**

`apps/web/src/lib/pdf/report-table.tsx:106-112`:
```ts
headerCell: {
  fontSize: 8,
  fontFamily: 'Helvetica-Bold',
  color: PDF_COLORS.ink3,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
},
```
Compare the body-cell style, `report-table.tsx:122-126`:
```ts
cell: {
  fontSize: 8.5,
  color: PDF_COLORS.ink,
  paddingHorizontal: 3,
},
```
`SectionView`'s header row (`report-table.tsx:190-204`) renders each `<Text style={[reportStyles.headerCell, {flex: ...}, alignStyle(...)]}>{col.label}</Text>` back-to-back inside a `flexDirection: 'row'` container with **no `gap`, no `marginHorizontal`, no `paddingHorizontal` on the header cell style, and no explicit column-gap prop anywhere on `reportStyles.headerRow`** (`report-table.tsx:97-105`, which only sets `paddingVertical/paddingHorizontal` on the OUTER row, not between inner cells). Two adjacent narrow-flex header labels ("ON HAND" right-aligned, "CATEGORY" left-aligned next to it) therefore render edge-to-edge with zero reserved gutter between them — at 8pt uppercase bold, that reads as `ON HANDCATEGORY`. The body row underneath, using `cell` (which DOES carry `paddingHorizontal: 3`), never exhibits the same collision — which is exactly why the owner's screenshot shows collided headers over correctly-separated body cells. This is a plain missing-padding bug in one style object, not a fundamental layout-math flaw — but the fix cannot be "make the font smaller" (brief explicitly forbids that); it needs real reserved gutter + (per the brief) minimum column widths, which `ReportColumn` doesn't have a field for today (A6).

### BUG 2 — ISBN numbers missing from the Books PDF

**Root cause: the ISBN value is already computed correctly; `PDF_COLUMNS` in the route just never lists it.**

`buildInventoryExportRows` already puts a correct ISBN string on every row (`inventory-export.ts:164-167`, quoted in A4) with the exact fallback chain the brief asks for (barcode → `custom_fields.isbn` → `isbn13` → `isbn10` → `''`). But `PDF_COLUMNS` — the hardcoded array in `apps/web/src/app/api/inventory/export/route.tsx:56-64` — is:
```ts
const PDF_COLUMNS: ReportColumn[] = [
  { key: 'name', ... }, { key: 'sku', ... }, { key: 'quantity_on_hand', ... },
  { key: 'category', ... }, { key: 'primary_location', ... }, { key: 'charter', ... },
  { key: 'status', ... },
];
```
There is no `{ key: 'isbn', ... }` entry. `SectionView` only ever renders `section.columns.map(col => ...row.cells[col.key])` (`report-table.tsx:226-237`) — a field that exists on every row object but has no matching `ReportColumn` entry is simply never looked up, never rendered, and produces no error. The CSV and Excel exports already include `isbn` (it's in `INVENTORY_EXPORT_HEADERS`, A4) — **only the PDF is missing it**, because the PDF is the one format with a hand-picked, hardcoded column subset instead of using the full header list.

### BUG 3 — CHARTER column shows an em dash instead of "Generic"

**Root cause: the export row stores `''` for a null charter; the PDF's blank-cell renderer converts `''` to `'—'`; the "Generic" label is a list-page-only UI decision that was never carried into the export pipeline.**

Three links in the chain:
1. **Export row build** (`inventory-export.ts:157`): `charter: i.charter_id ? (chMap.get(i.charter_id) ?? '') : ''` — a null `charter_id` produces the bare empty string `''`. There is no branch that writes `'Generic'`.
2. **PDF cell renderer** (`report-table.tsx:172-175`):
   ```ts
   function renderCellValue(value: string | number | null | undefined): string {
     if (value === null || value === undefined || value === '') return '—';
     return String(value);
   }
   ```
   Any falsy/blank cell — for ANY column, not charter-specific — renders as an em dash. This is a generic "blank cell" convention, and it is what turns the empty-string charter into the em dash the owner saw. (CSV/Excel don't have this masking layer — they'd show a bare empty cell for the same row today, which is a *different*, quieter version of the same underlying gap: the row data itself never says "Generic," in any format.)
3. **The ONLY place "Generic" is spelled out** is the list-page render branch (`inventory-table.tsx:2154-2176`, quoted in B3) — a `charter_id === null` renders a specific italic "Generic" span with an explanatory `title`. This logic lives in a React component, not in `buildInventoryExportRows` or any shared charter-formatting helper — so every export path (CSV/Excel/PDF alike) independently lacks it. The fix belongs in the export ROW BUILD (or a shared `formatCharter(charterId, chMap)` helper both the list page and the export path call), not in the PDF renderer — patching `renderCellValue` alone would only fix the PDF and leave CSV/Excel showing a bare blank cell instead of "Generic" (still wrong, just differently wrong).

---

## REUSE MAP

| Brief section | Builds on |
| --- | --- |
| §1 Inspect existing impl | This document. |
| §2 One reusable Export Builder | `ExportMenu` (`inventory-table.tsx:3565-3636`) + `BulkActions.exportSelected` (`bulk-actions.tsx:171-180`) are the two call sites to CONSOLIDATE into one dialog component; `downloadInventoryExport` (`download-export.ts`) stays the transport. |
| §3.1 Header collision fix | `ReportColumn`/`SectionView` in `report-table.tsx` — extend the type, fix `headerCell` padding, add real gutters (BUG 1). |
| §3.2 ISBN default | `buildInventoryExportRows`'s existing `isbn` derivation (A4/BUG 2) — just needs a `ReportColumn` entry and a registry default; the VALUE logic needs zero changes. |
| §3.3 Cover images | `ItemImagesService.primaryImagesForPdfRendering` (B4) — already the exact priority chain (thumb → transform-of-master → `custom_fields.thumbnail_url` fallback → nothing) the brief describes; wire it into the PDF/Excel row-build path instead of writing a new resolver. |
| §3.4 Row sizing w/ images | `report-table.tsx`'s `imageColumn`/`thumb`/`thumbPlaceholder` styles (A6) are the starting point but need real row-height + `objectFit: contain` + size-tier changes — no size-tier concept exists today. |
| §4 One dialog component | `apps/web/src/components/ui/dialog.tsx` (Radix wrapper, C1) is the base; no existing multi-step/wizard dialog pattern to copy — build fresh on top of `Dialog`. |
| §6 Format selection tabs | No `tabs.tsx` exists (C1) — either add a Radix Tabs wrapper or reuse the hand-rolled button-row pattern (`ExportFormatRow`, `inventory-table.tsx:3541-3563`) as the visual model. |
| §7 Field selection (checkboxes, search) | No `checkbox.tsx` exists (C1) — the hand-rolled `role="checkbox"` button pattern (`inventory-table.tsx:3348`, `bulk-actions.tsx:283-296`) is the house idiom to extend. |
| §10 Keyboard reorder | Nothing exists (C2) — build new; no dnd-kit/sortable dependency in the repo today. |
| §13 Column-fitting logic | `table-fit.test.ts`'s font-metrics-based worst-case-width TECHNIQUE (D2) — port the approach (not the PO-specific code) to validate the new `report-table.tsx` layout engine. |
| §14 Excel improvements | `toInventoryXlsx` (A5) is the base to extend — frozen header + formula-injection guard already reused via `escapeForSpreadsheet` (`csv.ts`); autofilter/summary-sheet/embedded-images/per-column formats are all new. |
| §15 CSV improvements | `toCsv`/`escapeForSpreadsheet` (`csv.ts`, A7) already correct for quoting + injection; only "friendly headings" and "image URL column" are new. |
| §17 Central field registry | No registry exists — `INVENTORY_EXPORT_HEADERS` (A4) is the closest analog (a flat header-name array) but carries none of the per-field metadata (group/appliesTo/pdfWidth/etc.) the brief wants; build new, informed by this array + `PDF_COLUMNS`' existing width choices as the PDF-width starting point. |
| §18 Image data pipeline | `ItemImagesService`'s four batched resolver methods (B4) are the entire pipeline — no new Supabase Storage code should be needed, only a new orchestration layer that calls the right resolver conditionally. |
| §21 Saved export presets | `SavedViewsService` (C3) is the closest existing pattern (per-user + org-shared, sanitized JSON state, unique-name constraint) — evaluate extending its `scope` enum/table rather than building an unrelated new persistence layer. |
| §25 Auth/security | `items:export` permission check + `exportRateLimited` + warehouse scoping (A3, B7, B8, E1) all already correctly enforced server-side — preserve them verbatim; add field-level (financial) validation as NEW server logic since no such gate exists today (B6). |
| §28 Testing | `delivery-request-action.test.tsx` (D3) for component-test idiom; `table-fit.test.ts` (D2) for PDF-layout-invariant idiom; `inventory-export.test.ts` (D1) for the row-builder-test idiom to extend. |

---

## GAPS

Things the brief assumes or requests that genuinely do not exist in the codebase today:

1. **No shared `Checkbox` or `Tabs` UI component** (C1) — must be built or the hand-rolled
   button-based pattern extended.
2. **No drag/sortable/reorder infrastructure of any kind** (C2) — the keyboard-controls reorder UI is
   100% new work, not an extension of an existing primitive.
3. **No financial-field visibility permission** (B6) — the brief's "Financial (permission-gated): Unit
   Cost, Retail Price, Inventory Value... use current permission model" assumes a gate that does not
   exist. `unit_cost`/`retail_price` are visible today to anyone who can read/export items at all.
   **This is a brief assumption the code contradicts** — the plan must decide whether to (a) gate
   these fields behind the existing `items:export` permission only (status quo, no new gate), (b)
   introduce a genuinely new permission, or (c) leave financial fields ungated in the export builder
   exactly as they are ungated everywhere else today. This is a product decision, not a code-reading
   one, and the brief's phrasing presupposes an answer the codebase doesn't currently give.
4. **No `ReportColumn.minWidth`/`maxWidth`/`wrap`** (A6) — the brief names these as fields to
   "consider adding"; they must be added, plus real column-fit math (replacing the pure flex-ratio
   split), to fix BUG 1 properly (not just patch the missing padding).
5. **No row-height-grows-with-image mechanism in `report-table.tsx`** (A6) — image rows are fixed at
   22×22pt with `wrap={false}`; Small/Medium/Large sizing and non-splitting tall rows are new layout
   engine work.
6. **No portrait/Legal/Auto-orientation support** — PDF is hardcoded `LETTER` + `landscape`
   (`report-table.tsx:258`).
7. **No PDF page-number footer, no repeated-header-per-page wiring, no catalog/card layout** — none of
   §11/§12's PDF layout options exist in any form today.
8. **No Excel autofilter, alternating rows, currency/date formats, embedded images, or summary sheet**
   (A5) — `toInventoryXlsx` today is bold-header + frozen-row-1 only.
9. **No central field registry** — closest existing analog is the flat `INVENTORY_EXPORT_HEADERS`
   array + the route's hardcoded `PDF_COLUMNS`; the brief's typed registry (key/label/group/
   appliesTo/csvSupported/xlsxSupported/pdfSupported/defaults/pdfWidth/align/value()) is wholly new.
10. **No export-builder Zod schema beyond today's flat `format/scope/itemType/ids/filters`** — the
    brief's nested `fields`/`options`/`pdf`/`xlsx` schema (§16) must be designed from scratch;
    "reject unknown/duplicate field keys" etc. has no precedent to extend.
11. **No live-preview mechanism** of any kind for any export format today.
12. **No "export readiness" (missing ISBN / missing cover count) computation exists** — would need a
    new aggregate query or client-side pass over `InventoryExportSourceRow`s.
13. **No unit test coverage for `report-table.tsx`, `inventory-export-xlsx.ts`, or the
    `/api/inventory/export` route at all** (D1) — the new test suite is close to 100% new, not an
    extension of thin existing coverage.
14. **Two independent filename-generation implementations already exist**
    (`csv.ts:csvFilename` vs. `route.tsx:exportFilename`) with different formats — the brief's
    descriptive-preset filenames need ONE new implementation; do not extend either blindly without
    reconciling scope/date/slug conventions between them first.
15. **Two independent `ROW_CAP = 10_000` constants** (`inventory-export.ts:39` and
    `export.csv/route.ts:24`) — not shared from one source; a future row-cap change needs both
    updated (or, better, consolidated).
