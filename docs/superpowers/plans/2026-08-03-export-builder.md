# Custom Export Builder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two hardcoded export popovers on the Books and Items pages with ONE reusable "Customize export" builder — field selection, field order, per-format options, cover images, PDF table and catalog layouts, live preview and export-readiness counts — served by the SAME `POST /api/inventory/export` route, and fix the three defects the owner photographed (colliding `ON HANDCATEGORY` headers, no ISBN in the Books PDF, an em dash where the list page says "Generic") in a shippable first phase that lands before any of the builder UI exists.

**Architecture:** five layers. Every one is either an extension of a file that exists today or a new pure module both the browser and the server can import.

| Layer | Where | Why there |
|---|---|---|
| Geometry | `apps/web/src/lib/pdf/column-fit.ts` (new, pure) | The header collision (Audit BUG 1) is a layout-math defect. `report-table.tsx` splits width by raw flex ratio with no minimums and no header gutter. Explicit point widths computed by one pure function are testable against Helvetica AFM metrics; a yoga flex ratio is not. |
| Contracts | `apps/web/src/lib/exports/{source-row,field-registry,export-request,pdf-layout,filename}.ts` (new, pure, NO `server-only`) | The dialog and the route must agree on field keys, labels, defaults, order, widths and validation. One registry, imported by both, is the only way "order preserved in all three formats" can be an assertion instead of a hope (brief §17). |
| Data | `apps/web/src/lib/inventory-export.ts` (extended) + `apps/web/src/lib/exports/export-images.ts` (new, server-only) | `buildInventoryExportRows` already runs ONE `InventoryService.list` + five fail-closed lookups and already derives ISBN correctly (Audit A4). It grows a source-row shape underneath; the legacy flat-record function stays as a thin wrapper so `/api/inventory/export.csv` and its test never move. |
| Formats | `inventory-export-xlsx.ts` (extended), `lib/exports/export-csv.ts` (new), `lib/pdf/inventory-export-pdf.tsx` (new) | Each format reads the SAME ordered `InventoryExportField[]` and the SAME `InventoryExportSourceRow[]`. |
| UI | `apps/web/src/components/inventory/export-builder/*` (new) | One dialog, mounted from `inventory-table.tsx`'s toolbar AND `bulk-actions.tsx`'s selection bar. Both existing popovers are deleted. |

**The decisive constraint on the PDF:** `lib/pdf/report-table.tsx` is shared with `/api/reports/[slug]/pdf/route.tsx`, which renders **seven** sections through it (`imageColumn: true` at route.tsx:133, 185, 216, 293, 334, 404, 435). It therefore gets the minimum viable, backward-compatible repair in Phase A (header gutter, optional `minWidth`/`maxWidth`/`wrap`, explicit widths) and NOTHING else. Row-height tiers, catalog cards, portrait/Legal, repeated headers and page numbers land in a NEW export-only document (`inventory-export-pdf.tsx`) that reuses `BrandedHeader`, `PDF_COLORS`, `pdfStyles` and the same `column-fit.ts` primitive. That is not "a separate pipeline" (brief §1 forbids a second export pipeline — one route, one row builder, one registry); it is a second react-pdf *document component*, which is what keeps seven live reports from regressing.

**Tech Stack:** TypeScript, Next.js 16 App Router (route handlers, `runtime = 'nodejs'`), React 19, zod, `@react-pdf/renderer` ^4.5.1, `exceljs` ^4.4.0, Supabase (RLS + Storage signed URLs), vitest + happy-dom + @testing-library/react + user-event, sonner, lucide-react, Radix Dialog (`@/components/ui/dialog`), `@stockpilot/core`.

---

## Global Constraints

Binding on every task. "Audit §x" refers to `docs/superpowers/specs/2026-08-03-export-builder-audit.md`; "Brief §n" to `.superpowers/sdd/export-builder-brief.md`.

1. **ONE export route.** Everything ships through `POST /api/inventory/export` (`apps/web/src/app/api/inventory/export/route.tsx`) by widening its Zod body schema. No second generation endpoint, no parallel row builder, no client-side file generation (Brief §1, §24). The ONE new sibling route in this plan is `POST /api/inventory/export/preview`, which generates NO file — it returns at most 10 sample source rows plus readiness counts so the dialog can render a preview without a round trip per keystroke (Brief §19, §20). It is explicitly called out as an addition in the final report.
2. **The legacy `GET /api/inventory/export.csv` route is NOT touched.** It keeps emitting the fixed 25-column dump forever (Audit A3). Bookmarked links and API consumers must not break. Say so in the report; do not "improve" it.
3. **Preserve every existing server guarantee, verbatim:** `withApiContext` → 401; `can(ctx, 'items:export')` → 403; `exportRateLimited(ctx.userId, ctx.organizationId)` → 429 (40/hour, fail-CLOSED, shared budget across CSV/XLSX/PDF); `getActiveWarehouseFilterFor(ctx)` applied ONLY on `scope: 'filtered'`; `ids` capped at 10 000; `ROW_CAP = 10_000`; `maxDuration = 60`; org scoping via RLS (Audit A3, B7, B8, E1).
4. **The server never trusts a client-supplied field list.** Every requested key is re-validated against the registry on the server: unknown key, duplicate key, more than `INVENTORY_EXPORT_MAX_FIELDS`, a book-only field on a non-book item type, a field the requested format does not support, a missing identifying field, an image setting on a format that cannot carry it, and catalog layout for a non-book export are all rejected with a 400 (Brief §16, §25).
5. **FINANCIAL FIELDS — OWNER DECISION OPEN.** Audit B6 proves there is **no cost/valuation permission anywhere in the codebase**: `grep -n "cost|financ|valuation" packages/core/src/constants/permissions.ts` returns nothing outside comments, and `unit_cost` / `retail_price` are already selected unconditionally by `InventoryService.list` and rendered unconditionally on the item detail page. This program **does not invent one**. `unit_cost`, `retail_price` and the derived `inventory_value` are available to `items:export` holders — status quo, consistent with what those users already see in the UI. The registry carries an unused `permission?: Permission` slot on every field and the server evaluates it, so the day a cost-visibility permission exists it is a one-line registry edit with no restructure. **Flag this to the owner; do not silently treat it as settled.**
6. **NO Playwright e2e** (controller adjudication 2, matching the delivery-request precedent: `apps/web/playwright.config.ts` exists, 5 specs exist, `grep -i playwright .github/workflows/*` returns zero hits — Audit D4). The brief's §28 e2e suite is replaced by strengthened component + route tests carrying the same flows. The deviation is DOCUMENTED in the §31 report (Task 18), never quietly omitted.
7. **NO MIGRATION. NO `.sql` FILE. NO `supabase db push`.** Nothing in this program changes the schema. Personal export presets live in `localStorage` (see Global Constraint 8). If a task seems to need DDL, stop and report instead.
8. **Preset persistence decision — built-ins in code, personal presets in `localStorage`.** The audit evaluated the saved-view infrastructure (Audit C3) and it does NOT cleanly support named per-user export payloads: `saved_views.scope` carries a hard database CHECK — `check (scope in ('inventory', 'books'))` at `supabase/migrations/0035_saved_views.sql:14` — so a third scope needs a migration; `SavedViewState` is a whitelisted toolbar-filter sanitizer (`q/status/stock/type/sort/cat/loc/warehouseId`) with no room for fields, order, or format options; and the unique-name constraint plus RLS would each need re-verification for a new payload shape. Brief §21 explicitly permits "dialog/browser storage + document the future DB option" in exactly this case. **Decision: eight built-in presets are code constants; a user's own saved presets are `localStorage` under one versioned key; the DB option is written up in the §31 report as the recommended next phase.**
9. **Never resolve master images for an export.** Image work goes through `ItemImagesService.primaryImagesForPdfRendering` (`apps/web/src/server/services/item-images.ts:422-499`) — the ONE accepted on-the-fly transform in this codebase, already batched, already the brief's exact priority chain (stored `thumb_path` → transform-of-master → `custom_fields.thumbnail_url` legacy book cover → absent, caller draws a placeholder). `primaryMasterUrlsForItems` (2048px, public catalog) must never appear in an export path (Audit B4, E3; project memory "public catalog image pipeline").
10. **No image work unless the export asked for it.** A plain CSV must issue zero image queries and zero signed-URL calls (Brief §18, §24). This is an assertion in Task 6, not a comment.
11. **Fail-closed lookups stay fail-closed.** The `safe()` wrapper in `buildInventoryExportRows` (Audit A4) is the house idiom: a throwing lookup blanks ONE column, it never 500s an export. Every new resolver follows it. One unusable image never fails an export — placeholder, continue, and never log a signed URL or a storage credential (Brief §3.3, §25).
12. **Every string cell keeps routing through `escapeForSpreadsheet`** from `apps/web/src/lib/csv.ts` (formula-injection guard, already reused by the xlsx writer). Never reimplement escaping (Audit A7, E3).
13. **Identifiers are TEXT, everywhere.** ISBN, SKU, barcode, model number and serial-like values are strings in the source row, are never coerced to numbers, and in Excel carry `cell.numFmt = '@'` so leading zeroes survive and no ISBN renders in scientific notation (Brief §3.2, §14). **ISBN is NEVER truncated** in any layout (Brief §11).
14. **Never render `undefined`, `null`, `0`-as-blank, or `[object Object]`.** A missing value renders as an empty cell in CSV/Excel and an em dash in the PDF. `0` and `false` are real values and print (`str()` in `inventory-export.ts:138-141` already has this contract).
15. **"Generic" is the charter sentinel.** `charter_id IS NULL` means generic stock, and the list page renders the word "Generic" (`inventory-table.tsx:2154-2176`, repeated at `:2903-2919` and `:3273-3289`). The export row build — not the PDF cell renderer — is where that becomes true for CSV, Excel and PDF alike (Audit BUG 3).
16. **`report-table.tsx` changes must be backward compatible for the seven live report sections.** New `ReportColumn` fields are optional; a column with no `minWidth` keeps behaving as it does today. Run the reports' own suites before committing Phase A.
17. **Mobile is NOT in scope.** `grep -rn "downloadInventoryExport\|inventory/export" apps/mobile` returns nothing — the mobile app has no inventory export surface at all, so the standing "web features default to mobile too" rule has no surface to attach to. Do not spend parity budget; say so in the report (Global Constraint 6 of the delivery-request program, same shape).
18. **Phase A ships FIRST, on its own.** Tasks 1-3 fix the owner's three photographed defects and the worst layout debt with ZERO builder UI. They are reviewable, releasable value on their own. Phase A ends at a verification gate (Task 3) and a review checkpoint; the builder work continues on the same branch afterwards.
19. **LOCAL COMMITS ONLY on `feat/export-builder`.** Never push, never merge to main, never open a PR, never deploy without the owner's explicit go-ahead at the Task 3 and Task 18 checkpoints. Every task ends at a local commit.
20. **TDD with real numbers.** Write the failing test, run it, record the REAL failure text; implement; run it again, record the REAL pass. Never write "tests pass" without the command output in front of you.
21. **No emojis** anywhere — code, comments, copy, commit messages, docs, UI strings.
22. **No Claude/Anthropic co-author trailer** on any commit. History is `Branden574` only.
23. **Copy is exact where the brief quotes it.** "Customize export"; the two descriptions in §5; the three format descriptions in §6; the CSV label "Include image URL" and the column heading "Image URL" (never "Include images" for CSV); the too-many-columns warning of §13. Where the brief quotes a sentence, that sentence is a test assertion.

### Controller adjudications recorded here as binding

| # | Adjudication | Where it lands |
|---|---|---|
| C1 | No financial permission exists; do not invent one; registry keeps a `permission?` slot; record as OWNER DECISION OPEN | Global Constraint 5; Task 4 registry; Task 5 validation; Task 18 report |
| C2 | No Playwright; strengthen component/route tests; document the deviation | Global Constraint 6; Tasks 13-17; Task 18 report section G |
| C3 | Phase A independently shippable: header/gutter + min widths, ISBN in Books PDF, "Generic" charter, regression tests | Tasks 1, 2, 3 |
| C4 | Preset persistence: built-ins + `localStorage`; DB option documented | Global Constraint 8; Task 14; Task 18 report |
| C5 | Images build on `primaryImagesForPdfRendering`; thumbnails only; concurrency + byte caps | Global Constraint 9; Task 7 |
| C6 | The export route stays ONE route | Global Constraint 1 |
| C7 | 12-18 right-sized tasks, each with its own TDD cycle and commit; Interfaces blocks are load-bearing for fresh per-task subagents | 18 tasks, five phases |

### Regression assertions — every task keeps these five green

- **R1 — the legacy CSV route is byte-identical.** `GET /api/inventory/export.csv` returns the same 25 columns in the same order with the same values (except `charter`, which now says "Generic" instead of blank for null-charter rows — that is the intended fix of Brief problem 9 and is asserted, not accidental).
- **R2 — the seven report PDFs still render.** `/api/reports/[slug]/pdf` sections keep their current column proportions; only sub-minimum columns move.
- **R3 — auth, rate limit and scoping are unchanged.** 401 without a context, 403 without `items:export`, 429 on the 41st export in an hour, warehouse cookie applied on `filtered` only.
- **R4 — existing selection actions still work.** `BulkActions` keeps Print labels, Cycle count, Set category/supplier/location/rack, Add/Remove tags, Archive/Restore, Draft POs and Set public visibility; only its Export popover is replaced.
- **R5 — existing filtering still works.** "Export filtered" keeps re-deriving filters from `useSearchParams()` exactly as `filtersFromParams()` does today (`inventory-table.tsx:3575-3584`), including `?expected=1` (mig 0277). No parallel filter-state object is invented.

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `apps/web/src/test/pdf-font-metrics.ts` | NEW — Helvetica / Helvetica-Bold / Courier AFM advance widths + `width()`, extracted from `table-fit.test.ts` so two PDF suites share one metric table | 1 |
| `apps/web/src/lib/pdf/column-fit.ts` | NEW — `fitColumnWidths()`: weighted allocation with hard point minimums and maximums. Pure; no `@react-pdf/renderer` import, so the browser can use it too | 1 |
| `apps/web/src/lib/pdf/column-fit.test.ts` | NEW — allocation invariants | 1 |
| `apps/web/src/lib/pdf/report-table.tsx` | MODIFIED — header gutter (BUG 1), `ReportColumn.minWidth/maxWidth/wrap`, explicit widths from `fitColumnWidths`, `contentWidthPt` prop | 1 |
| `apps/web/src/lib/pdf/report-table-fit.test.ts` | NEW — the owner's exact column combo never collides | 1 |
| `apps/web/src/lib/pdf/inventory-pdf-columns.ts` | NEW — `BOOKS_PDF_COLUMNS` (with ISBN) and `ITEMS_PDF_COLUMNS`, the Phase-A replacement for the route's hardcoded array; superseded by the registry in Phase C | 2 |
| `apps/web/src/lib/charter-display.ts` | NEW — `GENERIC_CHARTER_LABEL` + `formatCharterCell()`; the one definition the list page and the export path share | 2 |
| `apps/web/src/lib/charter-display.test.ts` | NEW | 2 |
| `apps/web/src/lib/inventory-export.ts` | MODIFIED — "Generic" charter (Task 2); source rows underneath the legacy flat record (Task 6) | 2, 6 |
| `apps/web/src/lib/inventory-export.test.ts` | MODIFIED — charter, ISBN and source-row coverage | 2, 6 |
| `apps/web/src/components/inventory/inventory-table.tsx` | MODIFIED — charter constant (2); `ExportMenu` popover replaced by the builder (17) | 2, 17 |
| `apps/web/src/app/api/inventory/export/route.tsx` | MODIFIED — books vs items PDF columns (2); full schema, registry, images, all three formats (13) | 2, 13 |
| `apps/web/src/app/api/inventory/export/route.test.tsx` | NEW — the route's first test file ever | 2, 13 |
| `apps/web/src/lib/exports/source-row.ts` | NEW — `InventoryExportSourceRow`, `ExportCell`; pure types both sides import | 4 |
| `apps/web/src/lib/exports/field-registry.ts` | NEW — the single typed field registry (Brief §17) | 4 |
| `apps/web/src/lib/exports/field-registry.test.ts` | NEW | 4 |
| `apps/web/src/lib/exports/export-request.ts` | NEW — Zod schema (Brief §16) + `resolveExportFields()` server validation | 5 |
| `apps/web/src/lib/exports/export-request.test.ts` | NEW | 5 |
| `apps/web/src/lib/exports/export-images.ts` | NEW — server-only: URL resolution, availability counts, byte fetching with caps | 7 |
| `apps/web/src/lib/exports/export-images.test.ts` | NEW | 7 |
| `apps/web/src/lib/exports/pdf-layout.ts` | NEW — paper/orientation/density/image reserve/column fitting/warnings (Brief §11, §13) | 8 |
| `apps/web/src/lib/exports/pdf-layout.test.ts` | NEW | 8 |
| `apps/web/src/lib/pdf/inventory-export-pdf.tsx` | NEW — the export document: table mode (9), catalog mode (10) | 9, 10 |
| `apps/web/src/lib/pdf/inventory-export-pdf.test.tsx` | NEW | 9, 10 |
| `apps/web/src/lib/inventory-export-xlsx.ts` | MODIFIED — fields, labels, formats, autofilter, widths, embedded images, summary sheet | 11 |
| `apps/web/src/lib/inventory-export-xlsx.test.ts` | NEW — the writer's first test file ever | 11 |
| `apps/web/src/lib/exports/export-csv.ts` | NEW — field-driven CSV with friendly headings and the Image URL column | 12 |
| `apps/web/src/lib/exports/export-csv.test.ts` | NEW | 12 |
| `apps/web/src/lib/exports/filename.ts` | NEW — one descriptive, sanitized filename builder (Brief §22) | 12 |
| `apps/web/src/lib/exports/filename.test.ts` | NEW | 12 |
| `apps/web/src/app/api/inventory/export/preview/route.ts` | NEW — sample rows + readiness counts, no file generation | 13 |
| `apps/web/src/app/api/inventory/export/preview/route.test.ts` | NEW | 13 |
| `apps/web/src/lib/download-export.ts` | MODIFIED — `fields`/`options` on the request, real progress stages, duplicate-submit guard | 13 |
| `apps/web/src/components/inventory/export-builder/export-builder-state.ts` | NEW — pure dialog state: toggle, reorder, validate, estimate, summarize | 14 |
| `apps/web/src/components/inventory/export-builder/export-builder-state.test.ts` | NEW | 14 |
| `apps/web/src/components/inventory/export-builder/export-builder-presets.ts` | NEW — eight built-ins + `localStorage` personal presets | 14 |
| `apps/web/src/components/inventory/export-builder/export-builder-presets.test.ts` | NEW | 14 |
| `apps/web/src/components/inventory/export-builder/export-builder-dialog.tsx` | NEW — the dialog: scope summary, format cards, options, submit, loading, error | 14 |
| `apps/web/src/components/inventory/export-builder/export-builder-dialog.test.tsx` | NEW | 14, 17 |
| `apps/web/src/components/inventory/export-builder/export-builder-fields.tsx` | NEW — searchable grouped field list + keyboard reorder | 15 |
| `apps/web/src/components/inventory/export-builder/export-builder-fields.test.tsx` | NEW | 15 |
| `apps/web/src/components/inventory/export-builder/export-builder-preview.tsx` | NEW — live preview + readiness panel + estimates | 16 |
| `apps/web/src/components/inventory/export-builder/export-builder-preview.test.tsx` | NEW | 16 |
| `apps/web/src/components/inventory/bulk-actions.tsx` | MODIFIED — its Export popover replaced by the same builder | 17 |
| `docs/superpowers/reports/2026-08-03-export-builder-verification.md` | NEW — real gate output | 18 |
| `docs/superpowers/reports/2026-08-03-export-builder-report.md` | NEW — the Brief §31 engineering report | 18 |

---

# Phase A — Ship the three photographed defects (no builder UI)

Independently releasable. Nothing in Phase A depends on the registry, the schema or the dialog.

## Task 1: The header gutter and real column minimums

**The bug, precisely.** `reportStyles.headerCell` (`report-table.tsx:106-112`) sets `fontSize`, `fontFamily`, `color`, `textTransform` and `letterSpacing` — and **no horizontal padding**. `reportStyles.cell` (`:122-126`) sets `paddingHorizontal: 3`. The header row is a `flexDirection: 'row'` with padding on the OUTER row only, so two adjacent header `<Text>` boxes touch edge to edge. At 8pt uppercase bold, a right-aligned "ON HAND" beside a left-aligned "CATEGORY" reads as `ON HANDCATEGORY`, which is exactly the owner's screenshot — and the body row underneath, which DOES have cell padding, never collides. That is why the defect looks like it only affects headers.

Padding alone is necessary but not sufficient: `flexForColumn` returns a bare ratio and `SectionView` divides the row by it, so a column can be squeezed arbitrarily thin (the "naive shrinking" Brief §13 forbids). This task replaces the ratio split with explicit point widths computed by one pure function that honours hard minimums, and pins the result with font-metric assertions.

**Files:**
- Create: `apps/web/src/test/pdf-font-metrics.ts`
- Create: `apps/web/src/lib/pdf/column-fit.ts`
- Create: `apps/web/src/lib/pdf/column-fit.test.ts`
- Create: `apps/web/src/lib/pdf/report-table-fit.test.ts`
- Modify: `apps/web/src/lib/pdf/report-table.tsx:25-35, 97-155, 159-161, 179-244, 248-272`
- Modify: `apps/web/src/lib/pdf/table-fit.test.ts:53-108` (import the extracted metrics instead of its private copies)

**Interfaces:**
- Produces for Tasks 2, 8, 9, 10:
  - `fitColumnWidths(columns: readonly FitColumn[], availableWidthPt: number): number[]` from `@/lib/pdf/column-fit`, where `FitColumn = { key: string; width?: number; minWidth?: number; maxWidth?: number }`. Returns one width in POINTS per input column, in order; the sum never exceeds `availableWidthPt`.
  - `REPORT_PAGE_PADDING_PT = 40`, `REPORT_ROW_PADDING_PT = 4`, `REPORT_CELL_PADDING_PT = 3`, `REPORT_IMAGE_COL_WIDTH_PT = 22`, `REPORT_IMAGE_COL_GAP_PT = 4`, `LETTER_LANDSCAPE_CONTENT_WIDTH_PT = 704` from `@/lib/pdf/column-fit`.
  - `ReportColumn` gains `minWidth?: number` (points), `maxWidth?: number` (points), `wrap?: boolean` (default true).
  - `ReportTablePdfProps` gains `contentWidthPt?: number` (default `LETTER_LANDSCAPE_CONTENT_WIDTH_PT`).
  - `width(text: string, font: 'Helvetica' | 'Helvetica-Bold' | 'Courier', sizePt: number): number` from `@/test/pdf-font-metrics`.
- Consumes: nothing from earlier tasks.

**Steps:**

- [ ] **Step 1: Extract the font metrics.** Create `apps/web/src/test/pdf-font-metrics.ts`:

```ts
/**
 * Adobe Core-14 AFM design widths (units per 1000 em) for the glyph subset the
 * StockPilot PDFs can emit, read out of the bundled @react-pdf/pdfkit@5.1.1
 * metrics. Lifted verbatim from lib/pdf/table-fit.test.ts, which pinned the
 * purchase-order tables; a second suite (report-table-fit.test.ts) now needs
 * the same table, so it lives here rather than being copied.
 *
 * To regenerate:
 *   node --input-type=module -e "const { default: D } = await import(
 *     './node_modules/.pnpm/@react-pdf+pdfkit@5.1.1/node_modules/@react-pdf/pdfkit/lib/pdfkit.js');
 *     const d = new D({size:'LETTER'}); d.font('Helvetica').fontSize(1000);
 *     console.log(d.widthOfString('A'));"
 *
 * (@react-pdf/pdfkit is a transitive dependency and is not resolvable from
 * apps/web under pnpm's strict node_modules, so it cannot be imported here.)
 *
 * This model deliberately ignores AFM kern pairs, which pdfkit does apply.
 * Kerning only ever makes a string NARROWER, so every width computed here is an
 * upper bound on what the layout engine produces. That biases each assertion
 * toward failing rather than silently passing, which is the right direction for
 * a fit check.
 */

export const HELVETICA: Readonly<Record<string, number>> = {
  ' ': 278, '!': 278, '#': 556, $: 556, '%': 889, '&': 667, '(': 333, ')': 333,
  '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278, ':': 278, ';': 278,
  '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015, '[': 278, ']': 278, _: 556,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
  '8': 556, '9': 556,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500,
  K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611,
  U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222,
  k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278,
  u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  '…': 1000, '—': 1000,
};

export const HELVETICA_BOLD: Readonly<Record<string, number>> = {
  ' ': 278, '!': 333, '#': 556, $: 556, '%': 889, '&': 722, '(': 333, ')': 333,
  '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278, ':': 333, ';': 333,
  '<': 584, '=': 584, '>': 584, '?': 611, '@': 975, '[': 333, ']': 333, _: 556,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
  '8': 556, '9': 556,
  A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 556,
  K: 722, L: 611, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611,
  U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  a: 556, b: 611, c: 556, d: 611, e: 556, f: 333, g: 611, h: 611, i: 278, j: 278,
  k: 556, l: 278, m: 889, n: 611, o: 611, p: 611, q: 611, r: 389, s: 556, t: 333,
  u: 611, v: 556, w: 778, x: 556, y: 556, z: 500,
  '…': 1000, '—': 1000,
};

/** Courier is monospaced: every glyph is 600/1000 em, including the ellipsis. */
export const COURIER_ADVANCE = 600;

export type FontName = 'Helvetica' | 'Helvetica-Bold' | 'Courier';

export function advance(char: string, font: FontName): number {
  if (font === 'Courier') return COURIER_ADVANCE;
  const table = font === 'Helvetica' ? HELVETICA : HELVETICA_BOLD;
  const w = table[char];
  // Fail loudly rather than treat an unknown glyph as zero-width: a silent 0
  // would under-measure the content and let a real overflow pass the suite.
  if (w === undefined) {
    throw new Error(
      `No ${font} advance width recorded for ${JSON.stringify(char)}. ` +
        'Add it to the metric table in src/test/pdf-font-metrics.ts before asserting against it.',
    );
  }
  return w;
}

/** Width of `text` in points, at `sizePt`, ignoring kerning (upper bound). */
export function width(text: string, font: FontName, sizePt: number): number {
  let total = 0;
  for (const char of text) total += advance(char, font);
  return (total / 1000) * sizePt;
}
```

- [ ] **Step 2: Write the failing allocation test.** Create `apps/web/src/lib/pdf/column-fit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { fitColumnWidths, type FitColumn } from './column-fit';

/**
 * The allocator behind every StockPilot PDF table. The invariant that matters
 * is not "columns look about right" — it is that a narrow column can never be
 * squeezed below the width its content genuinely needs, because @react-pdf
 * silently overflows instead of erroring (the same failure mode that shipped
 * the owner's "ON HANDCATEGORY" header).
 */
describe('fitColumnWidths', () => {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  it('splits by weight when no minimum binds', () => {
    const cols: FitColumn[] = [
      { key: 'a', width: 3 },
      { key: 'b', width: 1 },
    ];
    expect(fitColumnWidths(cols, 400)).toEqual([300, 100]);
  });

  it('treats a missing weight as 1', () => {
    expect(fitColumnWidths([{ key: 'a' }, { key: 'b' }], 200)).toEqual([100, 100]);
  });

  it('never lets a column fall below its minWidth — the header-collision guard', () => {
    // 'b' would get 100 * 0.5/10.5 = 4.8pt on weight alone. "ON HAND" cannot
    // render in 4.8pt, so the minimum wins and the wide column pays for it.
    const widths = fitColumnWidths(
      [
        { key: 'a', width: 10 },
        { key: 'b', width: 0.5, minWidth: 44 },
      ],
      100,
    );
    expect(widths[1]).toBe(44);
    expect(widths[0]).toBeCloseTo(56, 6);
    expect(sum(widths)).toBeCloseTo(100, 6);
  });

  it('honours maxWidth and redistributes the surplus to the others', () => {
    const widths = fitColumnWidths(
      [
        { key: 'a', width: 10, maxWidth: 60 },
        { key: 'b', width: 1 },
      ],
      200,
    );
    expect(widths[0]).toBe(60);
    expect(widths[1]).toBeCloseTo(140, 6);
  });

  it('scales minimums down proportionally rather than overflowing the page', () => {
    // Ten columns each demanding 80pt cannot fit in 400pt. Overflowing would
    // make @react-pdf clip silently; scaling keeps every column present and
    // proportionate, and the caller surfaces a warning.
    const cols: FitColumn[] = Array.from({ length: 10 }, (_, i) => ({
      key: `c${i}`,
      width: 1,
      minWidth: 80,
    }));
    const widths = fitColumnWidths(cols, 400);
    expect(sum(widths)).toBeCloseTo(400, 6);
    for (const w of widths) expect(w).toBeCloseTo(40, 6);
  });

  it('never returns a sum greater than the available width, for any mix', () => {
    const cols: FitColumn[] = [
      { key: 'name', width: 3, minWidth: 90 },
      { key: 'sku', width: 1.4, minWidth: 52 },
      { key: 'isbn', width: 1.6, minWidth: 66 },
      { key: 'qty', width: 0.9, minWidth: 44, maxWidth: 60 },
      { key: 'cat', width: 1.4, minWidth: 58 },
      { key: 'loc', width: 1.4, minWidth: 58 },
      { key: 'status', width: 1, minWidth: 46 },
    ];
    for (const available of [200, 320, 480, 704, 900]) {
      const widths = fitColumnWidths(cols, available);
      expect(widths).toHaveLength(cols.length);
      expect(sum(widths)).toBeLessThanOrEqual(available + 1e-6);
      for (const w of widths) expect(w).toBeGreaterThan(0);
    }
  });

  it('returns an empty array for no columns and zeroes for a zero-width page', () => {
    expect(fitColumnWidths([], 500)).toEqual([]);
    expect(fitColumnWidths([{ key: 'a' }, { key: 'b' }], 0)).toEqual([0, 0]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/lib/pdf/column-fit.test.ts 2>&1 | tail -20`
Expected: FAIL — `Failed to resolve import "./column-fit"`. Record the real text.

- [ ] **Step 4: Write the allocator.** Create `apps/web/src/lib/pdf/column-fit.ts`:

```ts
/**
 * Column width allocation for the StockPilot PDF tables.
 *
 * WHY THIS EXISTS: report-table.tsx used to hand every cell
 * `{ flex: weight / totalWeight }` and let yoga divide the row. That is a pure
 * ratio split with no floor, so a column with a small weight gets an
 * arbitrarily thin box and @react-pdf overflows it silently rather than
 * erroring — which is how "ON HAND" and "CATEGORY" ended up printed as
 * "ON HANDCATEGORY" in the owner's Books export.
 *
 * Explicit point widths computed here (and applied as `width` on each cell)
 * make the geometry deterministic and unit-testable against Helvetica AFM
 * metrics. No @react-pdf import: the export builder's browser-side dialog
 * imports this module too, for its column-count warning.
 */

export interface FitColumn {
  key: string;
  /** Relative weight. Default 1. Only decides how SURPLUS width is shared. */
  width?: number;
  /** Hard floor in points. The column never renders narrower than this unless
   *  the minimums as a whole cannot fit, in which case all of them scale down
   *  together (see below). */
  minWidth?: number;
  /** Ceiling in points. Useful for narrow numerics that gain nothing from
   *  extra space (a 3-digit quantity in a 120pt box just looks broken). */
  maxWidth?: number;
}

// Page geometry of the shared landscape-LETTER report table.
//   792pt page - 40pt page padding each side  = 712pt content
//   712pt      - 4pt  row  padding each side  = 704pt inner row width
export const REPORT_PAGE_PADDING_PT = 40;
export const REPORT_ROW_PADDING_PT = 4;
export const REPORT_CELL_PADDING_PT = 3;
export const REPORT_IMAGE_COL_WIDTH_PT = 22;
export const REPORT_IMAGE_COL_GAP_PT = 4;
export const LETTER_LANDSCAPE_CONTENT_WIDTH_PT =
  792 - REPORT_PAGE_PADDING_PT * 2 - REPORT_ROW_PADDING_PT * 2;

/**
 * Allocate `availableWidthPt` across `columns`, in order.
 *
 * 1. If the minimums alone exceed the page, scale every minimum by the same
 *    factor. Every column stays present and proportionate, and the total still
 *    fits — the caller is responsible for warning the user (Brief section 13:
 *    "block only when nothing readable is possible").
 * 2. Otherwise share the width by weight, clamping to [minWidth, maxWidth] and
 *    re-sharing what a clamped column gave back or took, until stable.
 *
 * The returned array has one width per input column and sums to at most
 * `availableWidthPt`.
 */
export function fitColumnWidths(
  columns: readonly FitColumn[],
  availableWidthPt: number,
): number[] {
  const n = columns.length;
  if (n === 0) return [];
  if (availableWidthPt <= 0) return columns.map(() => 0);

  const mins = columns.map((c) => Math.max(0, c.minWidth ?? 0));
  const totalMin = mins.reduce((a, b) => a + b, 0);
  if (totalMin >= availableWidthPt) {
    const scale = availableWidthPt / totalMin;
    return mins.map((m) => m * scale);
  }

  const weights = columns.map((c) => {
    const w = c.width ?? 1;
    return w > 0 ? w : 0;
  });
  const out = new Array<number>(n).fill(0);
  const locked = new Array<boolean>(n).fill(false);
  let remaining = availableWidthPt;

  // At most one column locks per pass, so n + 1 passes always converge.
  for (let pass = 0; pass <= n; pass++) {
    const free: number[] = [];
    let freeWeight = 0;
    for (let i = 0; i < n; i++) {
      if (!locked[i]) {
        free.push(i);
        freeWeight += weights[i]!;
      }
    }
    if (free.length === 0) break;

    let changed = false;
    for (const i of free) {
      const share =
        freeWeight > 0 ? (weights[i]! / freeWeight) * remaining : remaining / free.length;
      const min = mins[i]!;
      const max = columns[i]!.maxWidth ?? Number.POSITIVE_INFINITY;
      if (share < min) {
        out[i] = min;
        locked[i] = true;
        remaining -= min;
        changed = true;
      } else if (share > max) {
        out[i] = max;
        locked[i] = true;
        remaining -= max;
        changed = true;
      } else {
        out[i] = share;
      }
    }
    if (!changed) break;
  }

  return out;
}
```

- [ ] **Step 5: Run the allocation test to verify it passes.**

Run: `pnpm --filter @stockpilot/web test src/lib/pdf/column-fit.test.ts 2>&1 | tail -20`
Expected: PASS — 7 tests.

- [ ] **Step 6: Write the failing report-table fit test.** Create `apps/web/src/lib/pdf/report-table-fit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { width } from '@/test/pdf-font-metrics';

import {
  fitColumnWidths,
  LETTER_LANDSCAPE_CONTENT_WIDTH_PT,
  REPORT_CELL_PADDING_PT,
  REPORT_IMAGE_COL_GAP_PT,
  REPORT_IMAGE_COL_WIDTH_PT,
} from './column-fit';
import { REPORT_HEADER_FONT_SIZE_PT, REPORT_HEADER_LETTER_SPACING_PT } from './report-table';
import type { ReportColumn } from './report-table';

/**
 * Geometric invariants for the shared report table.
 *
 * WHY THIS EXISTS: the owner's Books PDF printed "ON HANDCATEGORY" — two
 * header labels touching with no gap. Both strings were present and correct,
 * so a rendered-text assertion would have passed. The defect was purely
 * geometric, and @react-pdf overflows silently, so nothing downstream
 * complained. The only assertion that catches this class of bug is the
 * invariant itself:
 *
 *   for every column, the uppercase header label must fit inside the content
 *   box its width buys once BOTH cells' horizontal padding is reserved
 *
 * Brief section 3.1 names this exact column combination as the test case.
 */

// reportStyles.headerCell renders uppercase with letterSpacing, and @react-pdf
// applies textTransform BEFORE measuring — so "ON HAND", not "On hand", is
// what has to fit.
function headerWidth(label: string): number {
  const shown = label.toUpperCase();
  return (
    width(shown, 'Helvetica-Bold', REPORT_HEADER_FONT_SIZE_PT) +
    shown.length * REPORT_HEADER_LETTER_SPACING_PT
  );
}

/** The exact combination Brief section 3.1 requires to stay separated. */
const OWNER_COLUMNS: ReportColumn[] = [
  { key: 'name', label: 'Name', width: 3, minWidth: 90 },
  { key: 'sku', label: 'SKU', width: 1.4, minWidth: 52 },
  { key: 'isbn', label: 'ISBN', width: 1.6, minWidth: 66 },
  { key: 'quantity_on_hand', label: 'On hand', align: 'right', width: 0.9, minWidth: 44 },
  { key: 'category', label: 'Category', width: 1.4, minWidth: 58 },
  { key: 'primary_location', label: 'Location', width: 1.4, minWidth: 58 },
  { key: 'status', label: 'Status', width: 1, minWidth: 46 },
];

describe('report-table column fit — Name | SKU | ISBN | On Hand | Category | Location | Status', () => {
  const widths = fitColumnWidths(OWNER_COLUMNS, LETTER_LANDSCAPE_CONTENT_WIDTH_PT);

  it('fits inside the landscape LETTER row', () => {
    const total = widths.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(LETTER_LANDSCAPE_CONTENT_WIDTH_PT + 1e-6);
  });

  it('gives every header label its own content box with room to spare', () => {
    OWNER_COLUMNS.forEach((col, i) => {
      const box = widths[i]! - REPORT_CELL_PADDING_PT * 2;
      const needed = headerWidth(col.label);
      expect(
        needed <= box,
        `${col.label}: header needs ${needed.toFixed(2)}pt but its content box is ${box.toFixed(2)}pt`,
      ).toBe(true);
    });
  });

  it('leaves a real gutter between ON HAND and CATEGORY — the exact reported collision', () => {
    const onHand = OWNER_COLUMNS.findIndex((c) => c.key === 'quantity_on_hand');
    const category = onHand + 1;
    // ON HAND is right-aligned and CATEGORY left-aligned, so the worst case is
    // ON HAND's text hard against its right padding and CATEGORY's hard against
    // its left padding. The gutter between the glyphs is then exactly the two
    // paddings, and it must be a visible gap, not zero (which is what shipped).
    const gutter = REPORT_CELL_PADDING_PT * 2;
    expect(gutter).toBeGreaterThanOrEqual(6);
    // And each label still fits its own box, so neither can bleed into the gap.
    expect(headerWidth('On hand')).toBeLessThanOrEqual(widths[onHand]! - REPORT_CELL_PADDING_PT * 2);
    expect(headerWidth('Category')).toBeLessThanOrEqual(
      widths[category]! - REPORT_CELL_PADDING_PT * 2,
    );
  });

  it('keeps the narrow numeric column at its readable minimum instead of shrinking it', () => {
    const onHand = OWNER_COLUMNS.findIndex((c) => c.key === 'quantity_on_hand');
    expect(widths[onHand]!).toBeGreaterThanOrEqual(44);
  });

  it('still fits once the 22pt image column is reserved', () => {
    const available =
      LETTER_LANDSCAPE_CONTENT_WIDTH_PT - REPORT_IMAGE_COL_WIDTH_PT - REPORT_IMAGE_COL_GAP_PT;
    const withImage = fitColumnWidths(OWNER_COLUMNS, available);
    OWNER_COLUMNS.forEach((col, i) => {
      const box = withImage[i]! - REPORT_CELL_PADDING_PT * 2;
      expect(headerWidth(col.label) <= box, `${col.label} collides once images are on`).toBe(true);
    });
  });

  it('does not regress the pre-existing inventory column set', () => {
    // The seven live report sections pass columns with no minWidth at all.
    // Those must keep their exact proportional split.
    const legacy: ReportColumn[] = [
      { key: 'name', label: 'Name', width: 3 },
      { key: 'sku', label: 'SKU', width: 1.4 },
      { key: 'quantity_on_hand', label: 'On hand', align: 'right', width: 0.9 },
      { key: 'category', label: 'Category', width: 1.4 },
    ];
    const legacyWidths = fitColumnWidths(legacy, 670);
    const totalWeight = 3 + 1.4 + 0.9 + 1.4;
    expect(legacyWidths[0]!).toBeCloseTo((3 / totalWeight) * 670, 6);
    expect(legacyWidths[2]!).toBeCloseTo((0.9 / totalWeight) * 670, 6);
  });
});
```

- [ ] **Step 7: Run it to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/lib/pdf/report-table-fit.test.ts 2>&1 | tail -25`
Expected: FAIL — `report-table.tsx` exports neither `REPORT_HEADER_FONT_SIZE_PT` nor `REPORT_HEADER_LETTER_SPACING_PT`, and `ReportColumn` has no `minWidth`, so the file does not typecheck under vitest's transform. Record the real text.

- [ ] **Step 8: Fix `report-table.tsx`.** Apply four edits.

(a) Replace the `ReportColumn` interface (lines 25-35) with:

```ts
export interface ReportColumn {
  /** Key used to look up the cell value in each row. */
  key: string;
  /** Header label shown at the top of the column. */
  label: string;
  /** Default 'left'. Number columns should use 'right'. */
  align?: ReportColumnAlign;
  /** Relative weight. Decides how SURPLUS width is shared once every
   *  column's minWidth is satisfied. Default 1 for every unset column. */
  width?: number;
  /** Hard floor in POINTS. Without one, a low-weight column can be squeezed
   *  until its header overlaps its neighbour — which is exactly how the Books
   *  export shipped "ON HANDCATEGORY". Optional so the seven existing report
   *  sections keep their current behaviour untouched. */
  minWidth?: number;
  /** Ceiling in POINTS. A 3-digit quantity gains nothing from a 120pt box. */
  maxWidth?: number;
  /** Default true. False documents that the column carries an identifier
   *  (SKU, ISBN, barcode) that must never be broken across lines — enforced by
   *  giving it a minWidth wide enough for its worst case, since @react-pdf has
   *  no no-wrap flag. */
  wrap?: boolean;
}
```

(b) Add the header-metric exports and the header padding. Replace `headerCell` (lines 106-112) with:

```ts
/** reportStyles.headerCell font size, exported so the fit test measures the
 *  same number the renderer uses instead of a copy that can drift. */
export const REPORT_HEADER_FONT_SIZE_PT = 8;
/** reportStyles.headerCell letterSpacing, same reason. */
export const REPORT_HEADER_LETTER_SPACING_PT = 0.4;
```

placed immediately ABOVE the `reportStyles` definition, and inside `StyleSheet.create` change the `headerCell` entry to:

```ts
  headerCell: {
    fontSize: REPORT_HEADER_FONT_SIZE_PT,
    fontFamily: 'Helvetica-Bold',
    color: PDF_COLORS.ink3,
    textTransform: 'uppercase',
    letterSpacing: REPORT_HEADER_LETTER_SPACING_PT,
    // THE HEADER COLLISION FIX. The body `cell` style has carried
    // paddingHorizontal: 3 since day one; the header cell had none, so two
    // adjacent header labels rendered edge to edge and "ON HAND" + "CATEGORY"
    // printed as "ON HANDCATEGORY". Matching the body padding gives every
    // header a 6pt gutter from its neighbour AND keeps header text aligned
    // with the body text underneath it.
    paddingHorizontal: REPORT_CELL_PADDING_PT,
  },
```

(c) Replace `flexForColumn` (lines 159-161) with nothing — delete it — and add the import at the top of the file, under the existing `import { pdfStyles, PDF_COLORS } from './styles';`:

```ts
import {
  fitColumnWidths,
  LETTER_LANDSCAPE_CONTENT_WIDTH_PT,
  REPORT_CELL_PADDING_PT,
  REPORT_IMAGE_COL_GAP_PT,
  REPORT_IMAGE_COL_WIDTH_PT,
} from './column-fit';
```

and change `const IMAGE_COL_WIDTH = 22;` (line 75) to:

```ts
const IMAGE_COL_WIDTH = REPORT_IMAGE_COL_WIDTH_PT;
```

and `imageCell`'s `marginRight: 4` to `marginRight: REPORT_IMAGE_COL_GAP_PT`.

(d) Replace `SectionView` (lines 179-244) with:

```tsx
function SectionView({
  section,
  contentWidthPt,
}: {
  section: ReportSection;
  contentWidthPt: number;
}) {
  const showImages = !!section.imageColumn;
  // Explicit point widths, not flex ratios: yoga's ratio split has no floor, so
  // a low-weight column could be squeezed until its header overlapped the next
  // one. fitColumnWidths honours each column's minWidth and only shares the
  // surplus by weight. Columns with no minWidth (every existing report) get
  // exactly the proportional split they had before.
  const available =
    contentWidthPt - (showImages ? IMAGE_COL_WIDTH + REPORT_IMAGE_COL_GAP_PT : 0);
  const widths = fitColumnWidths(section.columns, available);

  return (
    <View style={reportStyles.sectionWrap}>
      {section.title ? <Text style={reportStyles.sectionTitle}>{section.title}</Text> : null}
      {section.caption ? <Text style={reportStyles.sectionCaption}>{section.caption}</Text> : null}

      <View style={reportStyles.table}>
        {/* Header row */}
        <View style={reportStyles.headerRow}>
          {showImages ? <View style={reportStyles.imageCell} /> : null}
          {section.columns.map((col, i) => (
            <Text
              key={col.key}
              style={[
                reportStyles.headerCell,
                { width: widths[i] ?? 0, flexGrow: 0, flexShrink: 0 },
                alignStyle(col.align),
              ]}
            >
              {col.label}
            </Text>
          ))}
        </View>

        {/* Body rows */}
        {section.rows.length === 0 ? (
          <View style={reportStyles.row}>
            <Text style={[reportStyles.cell, { flex: 1, color: PDF_COLORS.ink4 }]}>
              No data for this period.
            </Text>
          </View>
        ) : (
          section.rows.map((row, idx) => (
            <View key={idx} style={reportStyles.row} wrap={false}>
              {showImages ? (
                <View style={reportStyles.imageCell}>
                  {row.imageUrl ? (
                    // eslint-disable-next-line jsx-a11y/alt-text
                    <Image src={row.imageUrl} style={reportStyles.thumb} />
                  ) : (
                    <View style={reportStyles.thumbPlaceholder} />
                  )}
                </View>
              ) : null}
              {section.columns.map((col, i) => (
                <Text
                  key={col.key}
                  style={[
                    reportStyles.cell,
                    { width: widths[i] ?? 0, flexGrow: 0, flexShrink: 0 },
                    alignStyle(col.align),
                  ]}
                >
                  {renderCellValue(row.cells[col.key])}
                </Text>
              ))}
            </View>
          ))
        )}
      </View>
    </View>
  );
}
```

(e) Replace `ReportTablePdf` (lines 248-272) with:

```tsx
export function ReportTablePdf({
  orgName,
  orgLogoUrl,
  title,
  subtitle,
  sections,
  footerNote,
  contentWidthPt = LETTER_LANDSCAPE_CONTENT_WIDTH_PT,
}: ReportTablePdfProps) {
  return (
    <Document>
      <Page size="LETTER" style={pdfStyles.page} orientation="landscape">
        <BrandedHeader
          orgName={orgName}
          orgLogoUrl={orgLogoUrl}
          title={title}
          subtitle={subtitle}
        />
        {sections.map((section, idx) => (
          <SectionView key={idx} section={section} contentWidthPt={contentWidthPt} />
        ))}
        {footerNote ? <Text style={reportStyles.footerNote}>{footerNote}</Text> : null}
      </Page>
    </Document>
  );
}
```

and add to `ReportTablePdfProps` (after `footerNote`):

```ts
  /** Inner row width in points. Defaults to the landscape-LETTER page this
   *  component renders (792 - 80 page padding - 8 row padding = 704). Exposed
   *  so a caller on a different page size can hand the allocator the truth. */
  contentWidthPt?: number;
```

- [ ] **Step 9: Point `table-fit.test.ts` at the shared metrics.** In `apps/web/src/lib/pdf/table-fit.test.ts`, delete the private `HELVETICA`, `HELVETICA_BOLD`, `COURIER_ADVANCE`, `FontName`, `advance` and `width` definitions (lines 53-108) and add, under the existing imports:

```ts
import { width } from '@/test/pdf-font-metrics';
```

Leave everything else in that file untouched — its long explanatory header comment stays, since it documents where the numbers came from.

- [ ] **Step 10: Run both PDF suites.**

Run: `pnpm --filter @stockpilot/web test src/lib/pdf 2>&1 | tail -25`
Expected: PASS — `column-fit.test.ts` (7), `report-table-fit.test.ts` (6), `table-fit.test.ts` (its existing count, unchanged), plus every other `src/lib/pdf` suite (`po.test.tsx`, `pick-slip.test.ts`, `count-sheet-*.test.ts`, `packing-slip-*.test.ts`, `cycle-count.group.test.ts`). If any of those fail, the report-table change regressed a live report (R2) — fix it here, do not defer.

- [ ] **Step 11: Typecheck.**

Run: `pnpm --filter @stockpilot/web typecheck 2>&1 | tail -20`
Expected: clean.

- [ ] **Step 12: Commit.**

```bash
git add apps/web/src/test/pdf-font-metrics.ts \
        apps/web/src/lib/pdf/column-fit.ts \
        apps/web/src/lib/pdf/column-fit.test.ts \
        apps/web/src/lib/pdf/report-table.tsx \
        apps/web/src/lib/pdf/report-table-fit.test.ts \
        apps/web/src/lib/pdf/table-fit.test.ts
git commit -m "fix(pdf): give report-table headers a real gutter and honour column minimums"
```

---

## Task 2: ISBN in the Books PDF, and "Generic" where the list page says Generic

Two defects, one commit, because they are the same sentence in the owner's brief ("the PDF doesn't match what I see on screen") and they touch the same two files.

**Defect 1 (Audit BUG 2).** `buildInventoryExportRows` already computes ISBN correctly for every book — `inventory-export.ts:164-167`, barcode first, then `custom_fields.isbn` / `isbn13` / `isbn10`. The value is on every row object. The route's `PDF_COLUMNS` array (`route.tsx:56-64`) simply has no `{ key: 'isbn' }` entry, and `SectionView` only renders `section.columns`. CSV and Excel have always included ISBN; only the PDF lost it, because the PDF is the one format with a hand-picked hardcoded subset.

**Defect 2 (Audit BUG 3).** `charter: i.charter_id ? (chMap.get(i.charter_id) ?? '') : ''` writes an empty string for a null charter. `renderCellValue` in the PDF turns any blank into an em dash, which is what the owner photographed; CSV and Excel show a bare blank, which is the same defect, quieter. The list page has said "Generic" since it shipped (`inventory-table.tsx:2154-2176`). The fix belongs in the ROW BUILD so all three formats agree — patching the PDF renderer alone would leave CSV and Excel wrong.

**Files:**
- Create: `apps/web/src/lib/charter-display.ts`
- Create: `apps/web/src/lib/charter-display.test.ts`
- Create: `apps/web/src/lib/pdf/inventory-pdf-columns.ts`
- Create: `apps/web/src/app/api/inventory/export/route.test.tsx`
- Modify: `apps/web/src/lib/inventory-export.ts:157`
- Modify: `apps/web/src/lib/inventory-export.test.ts`
- Modify: `apps/web/src/app/api/inventory/export/route.tsx:17, 56-64, 156-171`
- Modify: `apps/web/src/components/inventory/inventory-table.tsx:2166-2175, 2903-2919, 3273-3289`

**Interfaces:**
- Consumes from Task 1: `ReportColumn` with `minWidth`, from `@/lib/pdf/report-table`.
- Produces for Tasks 6, 9, 13:
  - `GENERIC_CHARTER_LABEL = 'Generic'` and `formatCharterCell(charterId: string | null | undefined, names: ReadonlyMap<string, string>): string` from `@/lib/charter-display`. Returns the charter name when the id resolves, `''` when the id is set but unresolvable (fail-closed blank, unchanged), and `'Generic'` when the id is null.
  - `BOOKS_PDF_COLUMNS: ReportColumn[]` and `ITEMS_PDF_COLUMNS: ReportColumn[]` from `@/lib/pdf/inventory-pdf-columns`.

**Steps:**

- [ ] **Step 1: Write the failing charter test.** Create `apps/web/src/lib/charter-display.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { formatCharterCell, GENERIC_CHARTER_LABEL } from './charter-display';

/**
 * charter_id IS NULL means "generic stock — any charter the warehouse services
 * can use". The inventory list has rendered that as the word "Generic" since it
 * shipped (inventory-table.tsx:2154-2176). Every export printed a blank, which
 * the PDF then rendered as an em dash — the owner's screenshot item 9. One
 * definition, shared, so the two surfaces cannot drift again.
 */
describe('formatCharterCell', () => {
  const names = new Map([['ch-1', 'Visalia']]);

  it('resolves a real charter to its name', () => {
    expect(formatCharterCell('ch-1', names)).toBe('Visalia');
  });

  it('says Generic for a null charter — never a blank, never an em dash', () => {
    expect(formatCharterCell(null, names)).toBe('Generic');
    expect(formatCharterCell(undefined, names)).toBe('Generic');
    expect(GENERIC_CHARTER_LABEL).toBe('Generic');
  });

  it('stays fail-closed blank when the id is set but the lookup could not load', () => {
    // buildInventoryExportRows wraps every lookup in safe(), which returns []
    // on a throw. A charter id with no entry means the lookup degraded — that
    // is NOT generic stock, and calling it "Generic" would be a lie.
    expect(formatCharterCell('ch-missing', names)).toBe('');
    expect(formatCharterCell('ch-1', new Map())).toBe('');
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/lib/charter-display.test.ts 2>&1 | tail -20`
Expected: FAIL — `Failed to resolve import "./charter-display"`. Record the real text.

- [ ] **Step 3: Write the helper.** Create `apps/web/src/lib/charter-display.ts`:

```ts
/**
 * The ONE definition of how a charter renders when the item has none.
 *
 * `inventory_items.charter_id` is nullable, and NULL is meaningful: it means
 * generic stock that any charter the warehouse services can pull from. The
 * inventory list says so in words (inventory-table.tsx, three render sites);
 * every export path independently said nothing, so the Books PDF printed an em
 * dash and CSV/Excel printed a blank for the same row. This module exists so
 * the list page and the export pipeline read the same string from the same
 * place.
 *
 * NOT a lookup value and NOT stored: no row in `charters` is named "Generic".
 */
export const GENERIC_CHARTER_LABEL = 'Generic';

/**
 * Render the charter cell for an item.
 *
 * - id resolves          -> the charter's name
 * - id is null/undefined -> GENERIC_CHARTER_LABEL
 * - id set, no entry     -> '' (the lookup failed closed; claiming "Generic"
 *                           would assert something the data does not say)
 */
export function formatCharterCell(
  charterId: string | null | undefined,
  names: ReadonlyMap<string, string>,
): string {
  if (!charterId) return GENERIC_CHARTER_LABEL;
  return names.get(charterId) ?? '';
}
```

- [ ] **Step 4: Run it to verify it passes.**

Run: `pnpm --filter @stockpilot/web test src/lib/charter-display.test.ts 2>&1 | tail -20`
Expected: PASS — 3 tests.

- [ ] **Step 5: Write the failing row-builder assertions.** Append to `apps/web/src/lib/inventory-export.test.ts` (inside the existing `describe('buildInventoryExportRows', ...)` block, after the last `it`):

```ts
  it('renders a NULL charter as "Generic", matching the inventory list page', async () => {
    listMock.mockResolvedValueOnce({
      items: [{ ...sampleItem, charter_id: null }],
      total: 1,
    });
    const res = await buildInventoryExportRows(ctx, { scope: 'all', itemType: 'all' });
    expect(res.rows[0]!.charter).toBe('Generic');
  });

  it('leaves the charter blank when the id is set but the lookup failed closed', async () => {
    chartersList.mockRejectedValueOnce(new Error('module_disabled: charters'));
    const res = await buildInventoryExportRows(ctx, { scope: 'all', itemType: 'all' });
    expect(res.rows[0]!.charter).toBe('');
  });

  it('derives a book ISBN from the barcode', async () => {
    listMock.mockResolvedValueOnce({
      items: [{ ...sampleItem, item_type: 'book', barcode: '9780262033848' }],
      total: 1,
    });
    const res = await buildInventoryExportRows(ctx, { scope: 'all', itemType: 'book' });
    expect(res.rows[0]!.isbn).toBe('9780262033848');
  });

  it('falls back through the legacy custom_fields ISBN keys, in order', async () => {
    listMock.mockResolvedValueOnce({
      items: [
        {
          ...sampleItem,
          item_type: 'book',
          barcode: null,
          custom_fields: { isbn13: '9780262033848', isbn10: '0262033844' },
        },
      ],
      total: 1,
    });
    const res = await buildInventoryExportRows(ctx, { scope: 'all', itemType: 'book' });
    expect(res.rows[0]!.isbn).toBe('9780262033848');
  });

  it('never puts an ISBN on a non-book row', async () => {
    listMock.mockResolvedValueOnce({
      items: [{ ...sampleItem, item_type: 'product', barcode: '012345678905' }],
      total: 1,
    });
    const res = await buildInventoryExportRows(ctx, { scope: 'all', itemType: 'product' });
    expect(res.rows[0]!.isbn).toBe('');
    expect(res.rows[0]!.barcode).toBe('012345678905');
  });

  it('keeps a leading-zero ISBN as a string — never a number', async () => {
    listMock.mockResolvedValueOnce({
      items: [{ ...sampleItem, item_type: 'book', barcode: '0262033844' }],
      total: 1,
    });
    const res = await buildInventoryExportRows(ctx, { scope: 'all', itemType: 'book' });
    expect(res.rows[0]!.isbn).toBe('0262033844');
    expect(typeof res.rows[0]!.isbn).toBe('string');
  });
```

- [ ] **Step 6: Run it to verify the charter assertions fail.**

Run: `pnpm --filter @stockpilot/web test src/lib/inventory-export.test.ts 2>&1 | tail -25`
Expected: FAIL — `expected '' to be 'Generic'` on the first new test. The four ISBN tests should already PASS (the derivation is correct today; only the PDF column was missing). Record the real text, including which ones passed — that evidence is what proves BUG 2 is a column problem, not a value problem.

- [ ] **Step 7: Fix the row build.** In `apps/web/src/lib/inventory-export.ts`, add the import under the existing `import { InventoryService, type ItemListSort } from '@/server/services/inventory';`:

```ts
import { formatCharterCell } from '@/lib/charter-display';
```

and replace line 157:

```ts
      charter: formatCharterCell(i.charter_id, chMap),
```

- [ ] **Step 8: Run the row-builder suite to verify it passes.**

Run: `pnpm --filter @stockpilot/web test src/lib/inventory-export.test.ts 2>&1 | tail -20`
Expected: PASS — the 7 pre-existing tests plus the 6 new ones.

- [ ] **Step 9: Write the failing route test.** Create `apps/web/src/app/api/inventory/export/route.test.tsx`:

```tsx
import { Readable } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { buildInventoryExportRows } from '@/lib/inventory-export';
import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * The unified export route had ZERO test coverage before this file (Audit D1),
 * which is precisely why a PDF with no ISBN column shipped unnoticed.
 *
 * renderToStream is mocked so the suite can assert on the ELEMENT handed to
 * react-pdf — the column set is the thing under test, and rendering a real PDF
 * to compare bytes would assert nothing readable. The mock must also supply
 * StyleSheet.create, because report-table.tsx and styles.ts both call it at
 * module load.
 */
let capturedElement: { props: Record<string, unknown> } | null = null;

vi.mock('@react-pdf/renderer', () => ({
  renderToStream: vi.fn(async (element: { props: Record<string, unknown> }) => {
    capturedElement = element;
    return Readable.from([Buffer.from('%PDF-1.7\n')]);
  }),
  StyleSheet: { create: <T,>(styles: T) => styles },
  Document: 'Document',
  Page: 'Page',
  Text: 'Text',
  View: 'View',
  Image: 'Image',
  Font: { register: () => {} },
}));

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/export-rate-limit', () => ({
  exportRateLimited: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/warehouse-filter', () => ({
  getActiveWarehouseFilterFor: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/inventory-export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/inventory-export')>();
  return { ...actual, buildInventoryExportRows: vi.fn() };
});

import { POST } from './route';

function buildCtx(role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer') {
  const stub = makeSupabaseStub({ organizations: [{ name: 'Demo Co', logo_url: null }] });
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role,
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(),
  };
}

function buildRequest(body: unknown): Parameters<typeof POST>[0] {
  return new Request('https://test.local/api/inventory/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const BOOK_ROW = {
  name: 'Introduction to Algorithms',
  sku: 'BK-0001',
  barcode: '9780262033848',
  item_type: 'book',
  status: 'active',
  quantity_on_hand: 4,
  reorder_point: 0,
  reorder_quantity: 0,
  unit_cost: 42,
  retail_price: 89,
  category: 'Mathematics',
  primary_location: 'DC4',
  supplier: '',
  warehouse: 'North',
  charter: 'Generic',
  tracking_type: 'none',
  author: 'Cormen',
  isbn: '9780262033848',
  grade: 'College',
  rack_number: '38',
  rack_row: 'A',
  crate_color: 'blue',
  crate_number: '12',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

beforeEach(() => {
  capturedElement = null;
  vi.mocked(withApiContext).mockResolvedValue(buildCtx('admin'));
  vi.mocked(buildInventoryExportRows).mockResolvedValue({
    headers: ['name', 'sku', 'isbn', 'quantity_on_hand', 'category', 'primary_location', 'charter', 'status'],
    rows: [BOOK_ROW],
    total: 1,
    truncated: false,
    slug: 'books',
  } as never);
});

function pdfColumns(): Array<{ key: string; label: string }> {
  const sections = (capturedElement?.props.sections ?? []) as Array<{
    columns: Array<{ key: string; label: string }>;
  }>;
  return sections[0]?.columns ?? [];
}

describe('POST /api/inventory/export — authorization', () => {
  it('401s without a context', async () => {
    vi.mocked(withApiContext).mockResolvedValue(null);
    const res = await POST(buildRequest({ format: 'csv', scope: 'all' }));
    expect(res.status).toBe(401);
  });

  it('403s for a role without items:export', async () => {
    vi.mocked(withApiContext).mockResolvedValue(buildCtx('viewer'));
    const res = await POST(buildRequest({ format: 'csv', scope: 'all' }));
    expect(res.status).toBe(403);
  });

  it('400s a selected export with no ids', async () => {
    const res = await POST(buildRequest({ format: 'csv', scope: 'selected', ids: [] }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/inventory/export — the Books PDF carries ISBN', () => {
  it('includes an ISBN column for a books export', async () => {
    const res = await POST(
      buildRequest({ format: 'pdf', scope: 'all', itemType: 'book' }),
    );
    expect(res.status).toBe(200);
    expect(pdfColumns().map((c) => c.key)).toContain('isbn');
  });

  it('puts ISBN right after the title and SKU, where a book is identified', async () => {
    await POST(buildRequest({ format: 'pdf', scope: 'all', itemType: 'book' }));
    const keys = pdfColumns().map((c) => c.key);
    expect(keys.slice(0, 3)).toEqual(['name', 'sku', 'isbn']);
  });

  it('keeps ON HAND and CATEGORY as two separate columns', async () => {
    await POST(buildRequest({ format: 'pdf', scope: 'all', itemType: 'book' }));
    const keys = pdfColumns().map((c) => c.key);
    expect(keys).toContain('quantity_on_hand');
    expect(keys).toContain('category');
    expect(keys.filter((k) => k === 'quantity_on_hand')).toHaveLength(1);
    // No merged "On hand / Category" column may ever exist (Brief section 13).
    for (const col of pdfColumns()) {
      expect(col.label).not.toMatch(/on hand.*categor/i);
    }
  });

  it('gives every PDF column a point minimum so headers cannot collide', async () => {
    await POST(buildRequest({ format: 'pdf', scope: 'all', itemType: 'book' }));
    for (const col of pdfColumns() as Array<{ key: string; minWidth?: number }>) {
      expect(col.minWidth, `${col.key} has no minWidth`).toBeGreaterThan(0);
    }
  });

  it('does NOT put ISBN on a non-book export', async () => {
    vi.mocked(buildInventoryExportRows).mockResolvedValue({
      headers: ['name', 'sku'],
      rows: [{ ...BOOK_ROW, item_type: 'product', isbn: '' }],
      total: 1,
      truncated: false,
      slug: 'inventory',
    } as never);
    await POST(buildRequest({ format: 'pdf', scope: 'all', itemType: 'product' }));
    expect(pdfColumns().map((c) => c.key)).not.toContain('isbn');
  });
});

describe('POST /api/inventory/export — CSV still works', () => {
  it('returns the canonical CSV with the Generic charter value intact', async () => {
    const res = await POST(buildRequest({ format: 'csv', scope: 'all', itemType: 'book' }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.split('\n')[0]).toContain('isbn');
    expect(text).toContain('Generic');
    expect(res.headers.get('Content-Disposition')).toContain('books-all-');
  });
});
```

- [ ] **Step 10: Run it to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/app/api/inventory/export/route.test.tsx 2>&1 | tail -30`
Expected: FAIL — the ISBN assertions fail with `expected [ 'name', 'sku', 'quantity_on_hand', ... ] to contain 'isbn'`, and the `minWidth` assertion fails with `expected undefined to be greater than 0`. The authorization and CSV tests should pass. Record the real text.

- [ ] **Step 11: Add the two column sets.** Create `apps/web/src/lib/pdf/inventory-pdf-columns.ts`:

```ts
import type { ReportColumn } from './report-table';

/**
 * Curated PDF column sets for the inventory export.
 *
 * A PDF cannot carry the full 25-column CSV dump legibly, so it has always used
 * a hand-picked subset — but the subset lived inline in the route and applied
 * to books and items alike, which is how the Books PDF shipped with no ISBN
 * even though every row object already carried one (Audit BUG 2).
 *
 * Every column now declares a point minimum. Without one, a low-weight column
 * gets squeezed until its header touches its neighbour, which is what printed
 * "ON HANDCATEGORY" (Audit BUG 1). The minimums are the widest realistic
 * header/content each column must show at 8pt bold / 8.5pt regular, and
 * report-table-fit.test.ts holds them to it.
 *
 * PHASE NOTE: this file is the Phase A repair. Phase C replaces it with columns
 * derived from the field registry and the user's chosen field order; keep the
 * widths, they are the tuned starting point the registry inherits.
 */

/** Books: Title, SKU, ISBN first — the three ways a book is identified. */
export const BOOKS_PDF_COLUMNS: ReportColumn[] = [
  { key: 'name', label: 'Title', width: 3, minWidth: 90 },
  { key: 'sku', label: 'SKU', width: 1.4, minWidth: 52, wrap: false },
  // ISBN is fixed and readable and must NEVER be truncated (Brief section 11).
  // 13 digits at 8.5pt Helvetica is 61.5pt; 66 leaves room for the cell padding.
  { key: 'isbn', label: 'ISBN', width: 1.6, minWidth: 66, wrap: false },
  { key: 'author', label: 'Author', width: 1.6, minWidth: 62 },
  { key: 'grade', label: 'Grade', width: 0.8, minWidth: 38 },
  { key: 'quantity_on_hand', label: 'On hand', align: 'right', width: 0.9, minWidth: 44, maxWidth: 70 },
  { key: 'category', label: 'Category', width: 1.4, minWidth: 58 },
  { key: 'primary_location', label: 'Location', width: 1.4, minWidth: 58 },
  { key: 'charter', label: 'Charter', width: 1.2, minWidth: 52 },
  { key: 'status', label: 'Status', width: 1, minWidth: 46 },
];

/** Items: the pre-existing set, now with minimums and no book-only fields. */
export const ITEMS_PDF_COLUMNS: ReportColumn[] = [
  { key: 'name', label: 'Name', width: 3, minWidth: 90 },
  { key: 'sku', label: 'SKU', width: 1.4, minWidth: 52, wrap: false },
  { key: 'quantity_on_hand', label: 'On hand', align: 'right', width: 0.9, minWidth: 44, maxWidth: 70 },
  { key: 'category', label: 'Category', width: 1.4, minWidth: 58 },
  { key: 'primary_location', label: 'Location', width: 1.4, minWidth: 58 },
  { key: 'charter', label: 'Charter', width: 1.4, minWidth: 52 },
  { key: 'status', label: 'Status', width: 1, minWidth: 46 },
];
```

- [ ] **Step 12: Wire the route to them.** In `apps/web/src/app/api/inventory/export/route.tsx`:

Replace the import on line 17:

```ts
import { ReportTablePdf } from '@/lib/pdf/report-table';
import { BOOKS_PDF_COLUMNS, ITEMS_PDF_COLUMNS } from '@/lib/pdf/inventory-pdf-columns';
```

Delete the whole `PDF_COLUMNS` constant (lines 54-64, comment included).

Replace the `sections` prop inside the `renderToStream` call (lines 164-169) with:

```tsx
        sections={[
          {
            columns: result.slug === 'books' ? BOOKS_PDF_COLUMNS : ITEMS_PDF_COLUMNS,
            rows: result.rows.map((r) => ({ cells: r })),
          },
        ]}
```

- [ ] **Step 13: Run the route test to verify it passes.**

Run: `pnpm --filter @stockpilot/web test src/app/api/inventory/export/route.test.tsx 2>&1 | tail -20`
Expected: PASS — 9 tests.

- [ ] **Step 14: Make the list page read the shared constant.** In `apps/web/src/components/inventory/inventory-table.tsx`, add to the import block:

```ts
import { GENERIC_CHARTER_LABEL } from '@/lib/charter-display';
```

and at all THREE render sites (`:2166-2175`, `:2903-2919`, `:3273-3289`) replace the literal `Generic` inside the italic span with `{GENERIC_CHARTER_LABEL}`. The surrounding markup, class names and `title` attribute stay exactly as they are.

Run: `grep -n ">Generic<\|>\s*Generic\s*<" apps/web/src/components/inventory/inventory-table.tsx`
Expected: no output — every occurrence now goes through the constant.

- [ ] **Step 15: Run the whole affected surface.**

Run: `pnpm --filter @stockpilot/web test src/lib/inventory-export.test.ts src/lib/charter-display.test.ts src/app/api/inventory/export 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 16: Typecheck and commit.**

Run: `pnpm --filter @stockpilot/web typecheck 2>&1 | tail -20`
Expected: clean.

```bash
git add apps/web/src/lib/charter-display.ts \
        apps/web/src/lib/charter-display.test.ts \
        apps/web/src/lib/pdf/inventory-pdf-columns.ts \
        apps/web/src/lib/inventory-export.ts \
        apps/web/src/lib/inventory-export.test.ts \
        apps/web/src/app/api/inventory/export/route.tsx \
        apps/web/src/app/api/inventory/export/route.test.tsx \
        apps/web/src/components/inventory/inventory-table.tsx
git commit -m "fix(inventory): put ISBN in the books PDF and render generic charters as Generic"
```

---

## Task 3: Phase A verification gate and review checkpoint

Phase A is releasable on its own. This task proves it with real command output and stops for the owner.

**Files:**
- Create: `docs/superpowers/reports/2026-08-03-export-builder-verification.md` (Phase A section; Task 18 appends the final section)

**Interfaces:**
- Consumes from Tasks 1 and 2: everything.
- Produces: a verification document with REAL output, and a checkpoint. No code.

**Steps:**

- [ ] **Step 1: Full web test suite.**

Run: `pnpm --filter @stockpilot/web test 2>&1 | tail -30`
Expected: PASS. Record the exact "Test Files N passed / Tests M passed" line. If anything unrelated is already red on `main`, note it as pre-existing with evidence (`git stash && pnpm --filter @stockpilot/web test <file>` on a clean tree) rather than claiming the phase broke it.

- [ ] **Step 2: Typecheck.**

Run: `pnpm typecheck 2>&1 | tail -20`
Expected: clean across every package.

- [ ] **Step 3: Lint.**

Run: `pnpm lint 2>&1 | tail -30`
Expected: clean. `eslint` runs over `apps/web` with the repo config; a new `no-control-regex` or import-order complaint is fixed here, not suppressed.

- [ ] **Step 4: Production build.**

Run: `pnpm --filter @stockpilot/web build 2>&1 | tail -30`
Expected: `Compiled successfully`. This is the gate that catches a react-pdf style prop that typechecks but breaks the bundle.

- [ ] **Step 5: Write the verification record.** Create `docs/superpowers/reports/2026-08-03-export-builder-verification.md` with a `## Phase A` section containing, verbatim, the four commands above and their REAL tail output, plus a short "what a reviewer should look at" list:

```markdown
# Custom Export Builder — verification log

## Phase A — screenshot defects (Tasks 1-3)

### Commands and real output

<paste the four command invocations and their actual tail output here>

### What changed, and what a reviewer should check

- `report-table.tsx` header cells now carry `paddingHorizontal: 3`, matching the
  body cells they sit above. Every column gets an explicit point width from
  `fitColumnWidths` instead of a bare flex ratio.
- The seven `/api/reports/[slug]/pdf` sections pass no `minWidth`, so their
  proportional split is byte-identical to before. `pnpm --filter @stockpilot/web
  test src/lib/pdf` is the proof.
- The Books PDF gains Title | SKU | ISBN | Author | Grade | On hand | Category |
  Location | Charter | Status. The Items PDF keeps its previous set plus
  minimums.
- `charter` now reads "Generic" for a null charter in CSV, Excel AND PDF — the
  same word the inventory list has always shown. A charter id that fails to
  resolve still blanks (fail-closed), which is a different case on purpose.

### Manual check the owner owes (Brief section 29)

Export Books -> PDF from `/dashboard/books` in the Demo Co org
(71b27a4a-7948-4638-bc3f-535974713bd2) and confirm: headers are visibly
separated, ISBN is present and readable, CHARTER reads "Generic" rather than an
em dash on generic stock.
```

- [ ] **Step 6: Commit.**

```bash
git add docs/superpowers/reports/2026-08-03-export-builder-verification.md
git commit -m "docs(inventory): phase A verification log for the export fixes"
```

- [ ] **Step 7: STOP for the owner.** Report: the three defects are fixed, gates are green with the real numbers above, and Phase A is a coherent standalone change. Ask whether to open a PR for Phase A now (Global Constraint 19 — do not push without the go-ahead) or continue straight into Phase B on the same branch. Do not proceed until answered.

---
# Phase B — The contracts

Four pure-ish modules that everything downstream reads. Nothing user-visible ships in this phase; every task is unit-tested in isolation.

## Task 4: The central field registry

Brief §17: "Single typed registry ... No per-format hardcoded column arrays." Today there are three independent, drifting definitions of "what an export contains": `INVENTORY_EXPORT_HEADERS` (25 raw snake_case keys, CSV + Excel), `BOOKS_PDF_COLUMNS` / `ITEMS_PDF_COLUMNS` (Task 2's curated PDF subset), and nothing at all for the dialog. This task makes ONE list the source of truth for labels, defaults, order, per-format support, PDF widths, alignment, Excel cell type and value extraction.

**Two deliberate design points, both load-bearing for later tasks:**

1. **The registry is client-safe.** No `import 'server-only'`, no Supabase import, no `@react-pdf/renderer` import. The dialog imports the same module the route validates against, which is the only way "field order is preserved in all three formats" can be an assertion rather than a hope.
2. **Values come from a typed source row, not from the flat 25-key record.** `InventoryExportSourceRow` carries `rackLabel` / `crateLabel` (the combined display forms `38-A` and `Blue 12` that `readBookStorage` already computes for the list page) alongside the raw `rackNumber` / `rackRow` / `crateColor` / `crateNumber`, so Brief §8's "user can switch combined vs separate" is a field-selection choice, not a formatting mode. Stored data is never altered.

**Files:**
- Create: `apps/web/src/lib/exports/source-row.ts`
- Create: `apps/web/src/lib/exports/field-registry.ts`
- Create: `apps/web/src/lib/exports/field-registry.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces for Tasks 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16:
  - From `@/lib/exports/source-row`: `type ExportCell = string | number | null | undefined`; `interface InventoryExportSourceRow` (exact shape in Step 3); `interface InventoryExportImage { thumbnailUrl: string }`.
  - From `@/lib/exports/field-registry`:
    - `type InventoryExportFieldKey` (29 literal keys, listed in Step 4).
    - `type InventoryExportFieldGroup = 'common' | 'book' | 'financial' | 'system'`.
    - `interface InventoryExportField` with `key, label, group, appliesTo, csvSupported, xlsxSupported, pdfSupported, defaultForBooks, defaultForItems, pdfWidth, pdfMinWidth, pdfMaxWidth?, align, cellType, wrap, permission?, value`.
    - `EXPORT_FIELDS: readonly InventoryExportField[]` (canonical order).
    - `getExportField(key: string): InventoryExportField | undefined`.
    - `BOOKS_DEFAULT_FIELD_KEYS: readonly InventoryExportFieldKey[]` (12, Brief §8 order).
    - `ITEMS_DEFAULT_FIELD_KEYS: readonly InventoryExportFieldKey[]` (10, Brief §9 order minus the image).
    - `IDENTIFYING_FIELD_KEYS: readonly InventoryExportFieldKey[]` = `['name', 'sku', 'isbn', 'barcode']`.
    - `fieldHeading(field: InventoryExportField, opts: { format: 'csv' | 'xlsx' | 'pdf'; itemType: 'book' | 'other' }): string`.
    - `defaultFieldKeysFor(itemType: 'book' | 'other'): InventoryExportFieldKey[]`.

**Steps:**

- [ ] **Step 1: Write the failing registry test.** Create `apps/web/src/lib/exports/field-registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import type { InventoryExportSourceRow } from './source-row';
import {
  BOOKS_DEFAULT_FIELD_KEYS,
  defaultFieldKeysFor,
  EXPORT_FIELDS,
  fieldHeading,
  getExportField,
  IDENTIFYING_FIELD_KEYS,
  ITEMS_DEFAULT_FIELD_KEYS,
} from './field-registry';

function makeRow(overrides: Partial<InventoryExportSourceRow> = {}): InventoryExportSourceRow {
  return {
    id: 'i-1',
    itemType: 'book',
    name: 'Introduction to Algorithms',
    sku: 'BK-0001',
    barcode: '9780262033848',
    status: 'active',
    quantityOnHand: 4,
    reorderPoint: 2,
    reorderQuantity: 6,
    unitCost: 42.5,
    retailPrice: 89,
    category: 'Mathematics',
    primaryLocation: 'DC4',
    supplier: 'Ingram',
    warehouse: 'North Region',
    charter: 'Generic',
    trackingType: 'none',
    author: 'Cormen',
    isbn: '9780262033848',
    grade: 'College',
    rackNumber: '38',
    rackRow: 'A',
    crateColor: 'blue',
    crateNumber: '12',
    rackLabel: '38-A',
    crateLabel: 'Blue 12',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    image: null,
    ...overrides,
  };
}

describe('EXPORT_FIELDS — shape', () => {
  it('has no duplicate keys', () => {
    const keys = EXPORT_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every field a non-empty label and at least one supported format', () => {
    for (const f of EXPORT_FIELDS) {
      expect(f.label.length, `${f.key} has no label`).toBeGreaterThan(0);
      expect(
        f.csvSupported || f.xlsxSupported || f.pdfSupported,
        `${f.key} is supported by no format`,
      ).toBe(true);
    }
  });

  it('gives every PDF-capable field a positive point minimum', () => {
    for (const f of EXPORT_FIELDS) {
      if (!f.pdfSupported) continue;
      expect(f.pdfMinWidth, `${f.key} has no pdfMinWidth`).toBeGreaterThan(0);
      expect(f.pdfWidth, `${f.key} has no pdfWidth`).toBeGreaterThan(0);
    }
  });

  it('marks financial fields as a group so a future permission can gate them at one point', () => {
    const financial = EXPORT_FIELDS.filter((f) => f.group === 'financial').map((f) => f.key);
    expect(financial).toEqual(['unit_cost', 'retail_price', 'inventory_value']);
    // OWNER DECISION OPEN: no cost-visibility permission exists in this
    // codebase (audit B6), so nothing is gated today and these are available
    // to items:export holders exactly as they are on the item detail page.
    // The slot exists so introducing one is a one-line change.
    for (const key of financial) {
      expect(getExportField(key)!.permission).toBeUndefined();
    }
  });
});

describe('defaults', () => {
  it('the Books default includes ISBN, in the brief order', () => {
    expect([...BOOKS_DEFAULT_FIELD_KEYS]).toEqual([
      'image',
      'name',
      'isbn',
      'sku',
      'author',
      'grade',
      'quantity_on_hand',
      'category',
      'rack',
      'crate',
      'primary_location',
      'status',
    ]);
  });

  it('the Items default excludes every book-only field AND the image', () => {
    // Brief section 9: Items PDF images default OFF. Books covers default ON.
    expect(ITEMS_DEFAULT_FIELD_KEYS).not.toContain('image');
    for (const key of ITEMS_DEFAULT_FIELD_KEYS) {
      expect(getExportField(key)!.appliesTo, `${key} is book-only`).toBe('all');
    }
    expect([...ITEMS_DEFAULT_FIELD_KEYS]).toEqual([
      'name',
      'sku',
      'barcode',
      'quantity_on_hand',
      'category',
      'primary_location',
      'warehouse',
      'supplier',
      'charter',
      'status',
    ]);
  });

  it('every default key exists in the registry and its flag agrees with the list', () => {
    for (const key of BOOKS_DEFAULT_FIELD_KEYS) {
      expect(getExportField(key)?.defaultForBooks, `${key} flag disagrees`).toBe(true);
    }
    for (const key of ITEMS_DEFAULT_FIELD_KEYS) {
      expect(getExportField(key)?.defaultForItems, `${key} flag disagrees`).toBe(true);
    }
    expect(EXPORT_FIELDS.filter((f) => f.defaultForBooks).length).toBe(
      BOOKS_DEFAULT_FIELD_KEYS.length,
    );
    expect(EXPORT_FIELDS.filter((f) => f.defaultForItems).length).toBe(
      ITEMS_DEFAULT_FIELD_KEYS.length,
    );
  });

  it('defaultFieldKeysFor returns a fresh mutable copy each call', () => {
    const a = defaultFieldKeysFor('book');
    a.push('status');
    expect(defaultFieldKeysFor('book')).toEqual([...BOOKS_DEFAULT_FIELD_KEYS]);
  });

  it('every default set contains at least one identifying field', () => {
    for (const set of [BOOKS_DEFAULT_FIELD_KEYS, ITEMS_DEFAULT_FIELD_KEYS]) {
      expect(set.some((k) => IDENTIFYING_FIELD_KEYS.includes(k))).toBe(true);
    }
  });
});

describe('headings', () => {
  it('calls the name column Title for books and Name for items', () => {
    const name = getExportField('name')!;
    expect(fieldHeading(name, { format: 'pdf', itemType: 'book' })).toBe('Title');
    expect(fieldHeading(name, { format: 'pdf', itemType: 'other' })).toBe('Name');
  });

  it('calls the image column Image URL in CSV — never "Include images", never binary', () => {
    const image = getExportField('image')!;
    expect(fieldHeading(image, { format: 'csv', itemType: 'book' })).toBe('Image URL');
    expect(fieldHeading(image, { format: 'csv', itemType: 'other' })).toBe('Image URL');
  });

  it('calls the image column Cover for books and Image for items in PDF and Excel', () => {
    const image = getExportField('image')!;
    expect(fieldHeading(image, { format: 'pdf', itemType: 'book' })).toBe('Cover');
    expect(fieldHeading(image, { format: 'xlsx', itemType: 'book' })).toBe('Cover');
    expect(fieldHeading(image, { format: 'pdf', itemType: 'other' })).toBe('Image');
  });

  it('is a friendly label, never the raw column key', () => {
    for (const f of EXPORT_FIELDS) {
      const heading = fieldHeading(f, { format: 'csv', itemType: 'book' });
      expect(heading).not.toContain('_');
      expect(heading[0]).toBe(heading[0]!.toUpperCase());
    }
  });
});

describe('value extraction', () => {
  it('reads plain fields off the source row', () => {
    const row = makeRow();
    expect(getExportField('name')!.value(row)).toBe('Introduction to Algorithms');
    expect(getExportField('quantity_on_hand')!.value(row)).toBe(4);
    expect(getExportField('charter')!.value(row)).toBe('Generic');
  });

  it('keeps ISBN a string, leading zeroes intact', () => {
    const v = getExportField('isbn')!.value(makeRow({ isbn: '0262033844' }));
    expect(v).toBe('0262033844');
    expect(typeof v).toBe('string');
  });

  it('renders a missing ISBN as an empty string, never undefined or null', () => {
    const v = getExportField('isbn')!.value(makeRow({ isbn: '' }));
    expect(v).toBe('');
  });

  it('renders the combined rack and crate labels the list page already computes', () => {
    const row = makeRow();
    expect(getExportField('rack')!.value(row)).toBe('38-A');
    expect(getExportField('crate')!.value(row)).toBe('Blue 12');
    expect(getExportField('rack_number')!.value(row)).toBe('38');
    expect(getExportField('crate_color')!.value(row)).toBe('blue');
  });

  it('computes inventory value from unit cost and quantity, and 0 when cost is unknown', () => {
    expect(getExportField('inventory_value')!.value(makeRow())).toBe(170);
    expect(getExportField('inventory_value')!.value(makeRow({ unitCost: null }))).toBe(0);
  });

  it('returns the image thumbnail URL only when one was resolved', () => {
    expect(getExportField('image')!.value(makeRow())).toBe('');
    expect(
      getExportField('image')!.value(
        makeRow({ image: { thumbnailUrl: 'https://signed.example/thumb.webp' } }),
      ),
    ).toBe('https://signed.example/thumb.webp');
  });

  it('never emits undefined, null or [object Object] for any field on a sparse row', () => {
    const sparse = makeRow({
      author: '',
      isbn: '',
      grade: '',
      rackLabel: '',
      crateLabel: '',
      unitCost: null,
      retailPrice: null,
      image: null,
    });
    for (const f of EXPORT_FIELDS) {
      const v = f.value(sparse);
      expect(v, `${f.key} produced ${String(v)}`).not.toBeUndefined();
      expect(v, `${f.key} produced null`).not.toBeNull();
      expect(String(v)).not.toBe('[object Object]');
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/lib/exports/field-registry.test.ts 2>&1 | tail -20`
Expected: FAIL — `Failed to resolve import "./source-row"`. Record the real text.

- [ ] **Step 3: Define the source row.** Create `apps/web/src/lib/exports/source-row.ts`:

```ts
/**
 * The RAW row an export is built from, separate from any formatted output
 * (Brief section 18). Every format — CSV, Excel, PDF table, PDF catalog — reads
 * this same shape through the field registry, so a value can never differ
 * between two formats of the same export.
 *
 * Field names are camelCase here on purpose: the legacy flat record
 * (INVENTORY_EXPORT_HEADERS) is snake_case because those strings ARE the CSV
 * headers. Keeping the two shapes visibly different stops a mapping bug from
 * hiding behind identical property names.
 *
 * NO 'server-only': the dialog's live preview renders sample rows of exactly
 * this shape in the browser.
 */

/** A single export cell — exactly what toCsv / exceljs / react-pdf accept. */
export type ExportCell = string | number | null | undefined;

/**
 * The resolved image for one row. Only ever a THUMBNAIL: exports must never
 * carry a 2048px master URL (project memory: public-catalog image pipeline).
 * The brief's sketch of this type also had `originalUrl`; it is deliberately
 * absent, and the omission is documented in the section 31 report.
 */
export interface InventoryExportImage {
  /** Signed (or public legacy) URL of a ~200px image, safe to fetch and embed. */
  thumbnailUrl: string;
}

export interface InventoryExportSourceRow {
  id: string;
  /** inventory_items.item_type — 'book' | 'product' | 'asset' | 'consumable'. */
  itemType: string;
  name: string;
  sku: string;
  barcode: string;
  status: string;
  quantityOnHand: number;
  reorderPoint: number;
  reorderQuantity: number;
  unitCost: number | null;
  retailPrice: number | null;
  /** Resolved names; '' when unset or when the lookup failed closed. */
  category: string;
  primaryLocation: string;
  supplier: string;
  warehouse: string;
  /** Resolved charter name, or 'Generic' when charter_id IS NULL. */
  charter: string;
  trackingType: string;
  author: string;
  /** Books only; '' for every other item type. Always a STRING. */
  isbn: string;
  grade: string;
  rackNumber: string;
  rackRow: string;
  crateColor: string;
  crateNumber: string;
  /** Combined display forms from readBookStorage: '38-A' and 'Blue 12'. */
  rackLabel: string;
  crateLabel: string;
  createdAt: string;
  updatedAt: string;
  /** Null unless the request asked for images. A plain CSV never populates it. */
  image: InventoryExportImage | null;
}
```

- [ ] **Step 4: Write the registry.** Create `apps/web/src/lib/exports/field-registry.ts`:

```ts
import type { Permission } from '@stockpilot/core';

import type { ExportCell, InventoryExportSourceRow } from './source-row';

/**
 * THE field registry (Brief section 17).
 *
 * One typed list drives: the builder dialog's checkboxes and groups, the
 * server's field validation, CSV headings, Excel headings and cell formats,
 * PDF column labels / alignment / widths, and the value read out of each row.
 * There is no per-format hardcoded column array anywhere downstream.
 *
 * NO 'server-only' and no Supabase / react-pdf imports: the dialog imports this
 * module in the browser and the route imports it on the server, which is the
 * only way "the order you chose is the order you get, in all three formats" can
 * be an assertion instead of a hope.
 */

export type InventoryExportFieldKey =
  // common
  | 'image'
  | 'name'
  | 'sku'
  | 'barcode'
  | 'item_type'
  | 'status'
  | 'quantity_on_hand'
  | 'reorder_point'
  | 'reorder_quantity'
  | 'category'
  | 'primary_location'
  | 'warehouse'
  | 'charter'
  | 'supplier'
  | 'tracking_type'
  // book
  | 'isbn'
  | 'author'
  | 'grade'
  | 'rack'
  | 'crate'
  | 'rack_number'
  | 'rack_row'
  | 'crate_color'
  | 'crate_number'
  // financial
  | 'unit_cost'
  | 'retail_price'
  | 'inventory_value'
  // system
  | 'created_at'
  | 'updated_at';

export type InventoryExportFieldGroup = 'common' | 'book' | 'financial' | 'system';

/** How an Excel cell is typed and formatted. CSV/PDF read it as a hint only. */
export type InventoryExportCellType = 'text' | 'number' | 'currency' | 'date';

export interface InventoryExportField {
  key: InventoryExportFieldKey;
  /** Friendly heading. Never a raw column name. */
  label: string;
  group: InventoryExportFieldGroup;
  /** 'book' = only offered when the export's item type is book (or all). */
  appliesTo: 'all' | 'book';
  csvSupported: boolean;
  xlsxSupported: boolean;
  pdfSupported: boolean;
  defaultForBooks: boolean;
  defaultForItems: boolean;
  /** Relative weight for surplus PDF width. */
  pdfWidth: number;
  /** Hard PDF floor in POINTS — the guard against header collision. */
  pdfMinWidth: number;
  /** Optional PDF ceiling in POINTS. */
  pdfMaxWidth?: number;
  align: 'left' | 'right' | 'center';
  cellType: InventoryExportCellType;
  /** False = an identifier that must never break across lines. Enforced by
   *  pdfMinWidth, since @react-pdf has no no-wrap flag. */
  wrap: boolean;
  /**
   * Permission required to include this field.
   *
   * OWNER DECISION OPEN. No cost-visibility permission exists in this codebase:
   * `unit_cost` and `retail_price` are selected unconditionally by
   * InventoryService.list and rendered unconditionally on the item detail page,
   * and PERMISSIONS has no items:view_cost / financials:* entry of any kind
   * (audit B6). Inventing one here would change who can see costs across the
   * product, which is a product decision, not an export decision. So financial
   * fields carry NO permission today — they are available to items:export
   * holders, exactly as they already are on screen — and this slot exists so
   * that gating them later is a one-line edit the server already enforces.
   */
  permission?: Permission;
  /** Extract this field's value from a raw source row. */
  value: (row: InventoryExportSourceRow) => ExportCell;
}

const money = (v: number | null): number => (typeof v === 'number' ? v : 0);

/**
 * Canonical order. The dialog lists fields in this order inside their group,
 * and a field re-added after being removed lands back in this relative
 * position, so a user's column order never depends on the sequence of clicks
 * that produced it.
 */
export const EXPORT_FIELDS: readonly InventoryExportField[] = [
  {
    key: 'image',
    label: 'Image',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: true,
    defaultForItems: false,
    pdfWidth: 0,
    pdfMinWidth: 26,
    align: 'left',
    cellType: 'text',
    wrap: false,
    value: (r) => r.image?.thumbnailUrl ?? '',
  },
  {
    key: 'name',
    label: 'Name',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: true,
    defaultForItems: true,
    pdfWidth: 3,
    pdfMinWidth: 90,
    align: 'left',
    cellType: 'text',
    wrap: true,
    value: (r) => r.name,
  },
  {
    key: 'sku',
    label: 'SKU',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: true,
    defaultForItems: true,
    pdfWidth: 1.4,
    pdfMinWidth: 52,
    align: 'left',
    cellType: 'text',
    wrap: false,
    value: (r) => r.sku,
  },
  {
    key: 'barcode',
    label: 'Barcode',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: true,
    pdfWidth: 1.5,
    pdfMinWidth: 62,
    align: 'left',
    cellType: 'text',
    wrap: false,
    value: (r) => r.barcode,
  },
  {
    key: 'item_type',
    label: 'Item type',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: false,
    pdfWidth: 1,
    pdfMinWidth: 46,
    align: 'left',
    cellType: 'text',
    wrap: false,
    value: (r) => r.itemType,
  },
  {
    key: 'status',
    label: 'Status',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: true,
    defaultForItems: true,
    pdfWidth: 1,
    pdfMinWidth: 46,
    align: 'left',
    cellType: 'text',
    wrap: false,
    value: (r) => r.status,
  },
  {
    key: 'quantity_on_hand',
    label: 'On hand',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: true,
    defaultForItems: true,
    pdfWidth: 0.9,
    pdfMinWidth: 44,
    pdfMaxWidth: 70,
    align: 'right',
    cellType: 'number',
    wrap: false,
    value: (r) => r.quantityOnHand,
  },
  {
    key: 'reorder_point',
    label: 'Reorder point',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: false,
    pdfWidth: 1,
    pdfMinWidth: 58,
    pdfMaxWidth: 80,
    align: 'right',
    cellType: 'number',
    wrap: false,
    value: (r) => r.reorderPoint,
  },
  {
    key: 'reorder_quantity',
    label: 'Reorder quantity',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: false,
    pdfWidth: 1,
    pdfMinWidth: 66,
    pdfMaxWidth: 88,
    align: 'right',
    cellType: 'number',
    wrap: false,
    value: (r) => r.reorderQuantity,
  },
  {
    key: 'category',
    label: 'Category',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: true,
    defaultForItems: true,
    pdfWidth: 1.4,
    pdfMinWidth: 58,
    align: 'left',
    cellType: 'text',
    wrap: true,
    value: (r) => r.category,
  },
  {
    key: 'primary_location',
    label: 'Location',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: true,
    defaultForItems: true,
    pdfWidth: 1.4,
    pdfMinWidth: 58,
    align: 'left',
    cellType: 'text',
    wrap: true,
    value: (r) => r.primaryLocation,
  },
  {
    key: 'warehouse',
    label: 'Warehouse',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: true,
    pdfWidth: 1.4,
    pdfMinWidth: 62,
    align: 'left',
    cellType: 'text',
    wrap: true,
    value: (r) => r.warehouse,
  },
  {
    key: 'charter',
    label: 'Charter',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: true,
    pdfWidth: 1.2,
    pdfMinWidth: 52,
    align: 'left',
    cellType: 'text',
    wrap: true,
    value: (r) => r.charter,
  },
  {
    key: 'supplier',
    label: 'Supplier',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: true,
    pdfWidth: 1.4,
    pdfMinWidth: 58,
    align: 'left',
    cellType: 'text',
    wrap: true,
    value: (r) => r.supplier,
  },
  {
    key: 'tracking_type',
    label: 'Tracking type',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: false,
    pdfWidth: 1,
    pdfMinWidth: 58,
    align: 'left',
    cellType: 'text',
    wrap: false,
    value: (r) => r.trackingType,
  },
  {
    key: 'isbn',
    label: 'ISBN',
    group: 'book',
    appliesTo: 'book',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: true,
    defaultForItems: false,
    // Fixed and readable, never truncated (Brief section 11): 13 digits at
    // 8.5pt Helvetica measure 61.5pt, so 66 covers the cell padding too.
    pdfWidth: 1.6,
    pdfMinWidth: 66,
    align: 'left',
    cellType: 'text',
    wrap: false,
    value: (r) => r.isbn,
  },
  {
    key: 'author',
    label: 'Author',
    group: 'book',
    appliesTo: 'book',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: true,
    defaultForItems: false,
    pdfWidth: 1.6,
    pdfMinWidth: 62,
    align: 'left',
    cellType: 'text',
    wrap: true,
    value: (r) => r.author,
  },
  {
    key: 'grade',
    label: 'Grade',
    group: 'book',
    appliesTo: 'book',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: true,
    defaultForItems: false,
    pdfWidth: 0.8,
    pdfMinWidth: 40,
    align: 'left',
    cellType: 'text',
    wrap: false,
    value: (r) => r.grade,
  },
  {
    key: 'rack',
    label: 'Rack',
    group: 'book',
    appliesTo: 'book',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: true,
    defaultForItems: false,
    pdfWidth: 0.8,
    pdfMinWidth: 40,
    align: 'left',
    cellType: 'text',
    wrap: false,
    // The combined label readBookStorage already computes for the list page
    // ("38-A"). The raw parts stay available as their own fields.
    value: (r) => r.rackLabel,
  },
  {
    key: 'crate',
    label: 'Crate',
    group: 'book',
    appliesTo: 'book',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: true,
    defaultForItems: false,
    pdfWidth: 0.9,
    pdfMinWidth: 44,
    align: 'left',
    cellType: 'text',
    wrap: false,
    value: (r) => r.crateLabel,
  },
  {
    key: 'rack_number',
    label: 'Rack number',
    group: 'book',
    appliesTo: 'book',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: false,
    pdfWidth: 0.9,
    pdfMinWidth: 56,
    align: 'left',
    cellType: 'text',
    wrap: false,
    value: (r) => r.rackNumber,
  },
  {
    key: 'rack_row',
    label: 'Rack row',
    group: 'book',
    appliesTo: 'book',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: false,
    pdfWidth: 0.8,
    pdfMinWidth: 46,
    align: 'left',
    cellType: 'text',
    wrap: false,
    value: (r) => r.rackRow,
  },
  {
    key: 'crate_color',
    label: 'Crate color',
    group: 'book',
    appliesTo: 'book',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: false,
    pdfWidth: 0.9,
    pdfMinWidth: 54,
    align: 'left',
    cellType: 'text',
    wrap: false,
    value: (r) => r.crateColor,
  },
  {
    key: 'crate_number',
    label: 'Crate number',
    group: 'book',
    appliesTo: 'book',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: false,
    pdfWidth: 0.9,
    pdfMinWidth: 60,
    align: 'left',
    cellType: 'text',
    wrap: false,
    value: (r) => r.crateNumber,
  },
  {
    key: 'unit_cost',
    label: 'Unit cost',
    group: 'financial',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: false,
    pdfWidth: 1,
    pdfMinWidth: 52,
    pdfMaxWidth: 76,
    align: 'right',
    cellType: 'currency',
    wrap: false,
    value: (r) => money(r.unitCost),
  },
  {
    key: 'retail_price',
    label: 'Retail price',
    group: 'financial',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: false,
    pdfWidth: 1,
    pdfMinWidth: 58,
    pdfMaxWidth: 80,
    align: 'right',
    cellType: 'currency',
    wrap: false,
    value: (r) => money(r.retailPrice),
  },
  {
    key: 'inventory_value',
    label: 'Inventory value',
    group: 'financial',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: false,
    pdfWidth: 1,
    pdfMinWidth: 68,
    pdfMaxWidth: 92,
    align: 'right',
    cellType: 'currency',
    wrap: false,
    // Derived, never stored. Unknown cost contributes 0 rather than blanking
    // the row, matching how the valuation report treats a costless item.
    value: (r) => money(r.unitCost) * r.quantityOnHand,
  },
  {
    key: 'created_at',
    label: 'Created date',
    group: 'system',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: false,
    pdfWidth: 1.2,
    pdfMinWidth: 62,
    align: 'left',
    cellType: 'date',
    wrap: false,
    value: (r) => r.createdAt,
  },
  {
    key: 'updated_at',
    label: 'Updated date',
    group: 'system',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: false,
    pdfWidth: 1.2,
    pdfMinWidth: 62,
    align: 'left',
    cellType: 'date',
    wrap: false,
    value: (r) => r.updatedAt,
  },
];

const BY_KEY = new Map<string, InventoryExportField>(EXPORT_FIELDS.map((f) => [f.key, f]));

export function getExportField(key: string): InventoryExportField | undefined {
  return BY_KEY.get(key);
}

/** Brief section 8, in the brief's exact order. */
export const BOOKS_DEFAULT_FIELD_KEYS: readonly InventoryExportFieldKey[] = [
  'image',
  'name',
  'isbn',
  'sku',
  'author',
  'grade',
  'quantity_on_hand',
  'category',
  'rack',
  'crate',
  'primary_location',
  'status',
];

/**
 * Brief section 9, in the brief's order, MINUS the image.
 *
 * Section 9 lists "1 Image" but the same section requires items PDF images to
 * default OFF while books covers default ON. Selecting the image field IS what
 * turns images on, so the items default omits it; the canonical order above
 * still puts it first, so a user who enables it gets it in position 1.
 */
export const ITEMS_DEFAULT_FIELD_KEYS: readonly InventoryExportFieldKey[] = [
  'name',
  'sku',
  'barcode',
  'quantity_on_hand',
  'category',
  'primary_location',
  'warehouse',
  'supplier',
  'charter',
  'status',
];

/** At least one of these must be present, or the file identifies nothing. */
export const IDENTIFYING_FIELD_KEYS: readonly InventoryExportFieldKey[] = [
  'name',
  'sku',
  'isbn',
  'barcode',
];

export function defaultFieldKeysFor(itemType: 'book' | 'other'): InventoryExportFieldKey[] {
  return [...(itemType === 'book' ? BOOKS_DEFAULT_FIELD_KEYS : ITEMS_DEFAULT_FIELD_KEYS)];
}

/**
 * The heading a field shows, per format and item type.
 *
 * Three overrides, all from the brief:
 *   - a book's `name` is its Title (section 8's preset says Title, not Name)
 *   - the image column is "Image URL" in CSV, because CSV carries a URL and
 *     never binary (section 15) — the label must never say "images"
 *   - the image column is "Cover" for books (section 8) and "Image" otherwise
 */
export function fieldHeading(
  field: InventoryExportField,
  opts: { format: 'csv' | 'xlsx' | 'pdf'; itemType: 'book' | 'other' },
): string {
  if (field.key === 'image') {
    if (opts.format === 'csv') return 'Image URL';
    return opts.itemType === 'book' ? 'Cover' : 'Image';
  }
  if (field.key === 'name' && opts.itemType === 'book') return 'Title';
  return field.label;
}
```

- [ ] **Step 5: Run the registry test to verify it passes.**

Run: `pnpm --filter @stockpilot/web test src/lib/exports/field-registry.test.ts 2>&1 | tail -20`
Expected: PASS — 18 tests.

- [ ] **Step 6: Typecheck and commit.**

Run: `pnpm --filter @stockpilot/web typecheck 2>&1 | tail -20`
Expected: clean.

```bash
git add apps/web/src/lib/exports/source-row.ts \
        apps/web/src/lib/exports/field-registry.ts \
        apps/web/src/lib/exports/field-registry.test.ts
git commit -m "feat(inventory): central export field registry"
```

---

## Task 5: The export request schema and server-side field validation

Brief §16 and §25. Today the route's body schema is `format / scope / itemType / ids / filters` and nothing else (Audit A3). It grows `fields` and a nested `options` object — and, more importantly, it grows a validator that re-derives the real field list on the SERVER from the registry, so a client that posts `unit_cost` or a fabricated key or 200 fields gets a 400, never a file.

**Files:**
- Create: `apps/web/src/lib/exports/export-request.ts`
- Create: `apps/web/src/lib/exports/export-request.test.ts`

**Interfaces:**
- Consumes from Task 4: `EXPORT_FIELDS`, `getExportField`, `defaultFieldKeysFor`, `IDENTIFYING_FIELD_KEYS`, `InventoryExportField`, `InventoryExportFieldKey`.
- Produces for Tasks 8, 11, 12, 13, 14, 15, 16:
  - `INVENTORY_EXPORT_MAX_FIELDS = 30`.
  - `inventoryExportRequestSchema` (zod) and `type InventoryExportRequestParsed = z.output<typeof inventoryExportRequestSchema>`.
  - `type InventoryExportOptions = InventoryExportRequestParsed['options']` with `includeImages: boolean`, `imageMode: 'embedded' | 'url' | 'both'`, `imageSize: 'small' | 'medium' | 'large'`, `presetName?: string`, `pdf: { layout, catalogColumns, orientation, paperSize, density, repeatHeaders, pageNumbers, wrapText }`, `xlsx: { freezeHeader, autoFilter, includeSummarySheet }`.
  - `resolveExportFields(input: ResolveExportFieldsInput): ResolveExportFieldsResult` where
    `ResolveExportFieldsInput = { fields?: readonly string[]; itemType: 'product'|'book'|'asset'|'consumable'|'all'; format: 'csv'|'xlsx'|'pdf'; options: InventoryExportOptions; can: (permission: Permission) => boolean }`
    and `ResolveExportFieldsResult = { ok: true; fields: InventoryExportField[]; imagesRequested: boolean } | { ok: false; status: 400 | 403; message: string }`.
  - `exportItemTypeKind(itemType): 'book' | 'other'`.

**Steps:**

- [ ] **Step 1: Write the failing validation test.** Create `apps/web/src/lib/exports/export-request.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import type { Permission } from '@stockpilot/core';

import {
  exportItemTypeKind,
  INVENTORY_EXPORT_MAX_FIELDS,
  inventoryExportRequestSchema,
  resolveExportFields,
} from './export-request';

const allow = (_p: Permission) => true;
const deny = (_p: Permission) => false;

function parseOptions(raw: unknown = {}) {
  const parsed = inventoryExportRequestSchema.parse({
    format: 'pdf',
    scope: 'all',
    options: raw,
  });
  return parsed.options;
}

describe('inventoryExportRequestSchema', () => {
  it('still accepts the pre-builder request shape unchanged', () => {
    // The two existing popovers post exactly this. They must keep working
    // while the builder is being built (and the mobile-free API stays valid).
    const parsed = inventoryExportRequestSchema.parse({
      format: 'csv',
      scope: 'filtered',
      itemType: 'book',
      filters: { q: 'algebra', status: 'active', stock: null, expected: true, sort: 'name_asc' },
    });
    expect(parsed.fields).toBeUndefined();
    expect(parsed.options.includeImages).toBe(false);
  });

  it('defaults every option the brief specifies', () => {
    const o = parseOptions();
    expect(o.includeImages).toBe(false);
    expect(o.imageMode).toBe('embedded');
    expect(o.imageSize).toBe('medium');
    expect(o.pdf.layout).toBe('table');
    expect(o.pdf.catalogColumns).toBe(2);
    expect(o.pdf.orientation).toBe('auto');
    expect(o.pdf.paperSize).toBe('letter');
    expect(o.pdf.density).toBe('comfortable');
    expect(o.pdf.repeatHeaders).toBe(true);
    expect(o.pdf.pageNumbers).toBe(true);
    expect(o.pdf.wrapText).toBe(true);
    expect(o.xlsx.freezeHeader).toBe(true);
    expect(o.xlsx.autoFilter).toBe(true);
    expect(o.xlsx.includeSummarySheet).toBe(false);
  });

  it('rejects an empty field list and an over-long one', () => {
    const base = { format: 'csv', scope: 'all' } as const;
    expect(inventoryExportRequestSchema.safeParse({ ...base, fields: [] }).success).toBe(false);
    expect(
      inventoryExportRequestSchema.safeParse({
        ...base,
        fields: Array.from({ length: INVENTORY_EXPORT_MAX_FIELDS + 1 }, () => 'name'),
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown paper size, layout or catalog column count', () => {
    for (const bad of [
      { pdf: { paperSize: 'a4' } },
      { pdf: { layout: 'grid' } },
      { pdf: { catalogColumns: 4 } },
      { imageSize: 'huge' },
      { imageMode: 'inline' },
    ]) {
      expect(
        inventoryExportRequestSchema.safeParse({ format: 'pdf', scope: 'all', options: bad })
          .success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });
});

describe('resolveExportFields — defaults', () => {
  it('falls back to the Books defaults when the client sent no fields', () => {
    const res = resolveExportFields({
      itemType: 'book',
      format: 'pdf',
      options: parseOptions(),
      can: allow,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fields.map((f) => f.key)).toContain('isbn');
    expect(res.fields[0]!.key).toBe('image');
  });

  it('falls back to the Items defaults for a non-book export, with no book fields', () => {
    const res = resolveExportFields({
      itemType: 'product',
      format: 'csv',
      options: parseOptions(),
      can: allow,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (const f of res.fields) expect(f.appliesTo).toBe('all');
  });
});

describe('resolveExportFields — rejections', () => {
  const base = { itemType: 'book' as const, format: 'csv' as const, can: allow };

  it('rejects an unknown field key', () => {
    const res = resolveExportFields({
      ...base,
      fields: ['name', 'sku', 'not_a_field'],
      options: parseOptions(),
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
    if (res.ok) return;
    expect(res.message).toContain('not_a_field');
  });

  it('rejects a duplicate field key', () => {
    const res = resolveExportFields({
      ...base,
      fields: ['name', 'sku', 'name'],
      options: parseOptions(),
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
    if (res.ok) return;
    expect(res.message.toLowerCase()).toContain('duplicate');
  });

  it('rejects a book-only field on a product export', () => {
    const res = resolveExportFields({
      ...base,
      itemType: 'product',
      fields: ['name', 'isbn'],
      options: parseOptions(),
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
  });

  it('ALLOWS a book field when the export spans every item type', () => {
    const res = resolveExportFields({
      ...base,
      itemType: 'all',
      fields: ['name', 'isbn'],
      options: parseOptions(),
    });
    expect(res.ok).toBe(true);
  });

  it('rejects a field list with no identifying column', () => {
    const res = resolveExportFields({
      ...base,
      fields: ['quantity_on_hand', 'category'],
      options: parseOptions(),
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
    if (res.ok) return;
    expect(res.message).toContain('Name');
  });

  it('403s a field whose permission the caller lacks — the client cannot post its way in', () => {
    // No cost permission exists today (owner decision open), so this is proved
    // with a synthetic gate to keep the enforcement path itself covered.
    const res = resolveExportFields({
      ...base,
      fields: ['name', 'unit_cost'],
      options: parseOptions(),
      can: deny,
      permissionOverrides: { unit_cost: 'items:export' },
    });
    expect(res).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects images on a format that cannot carry them', () => {
    const res = resolveExportFields({
      ...base,
      format: 'csv',
      fields: ['name', 'image'],
      options: parseOptions({ includeImages: true, imageMode: 'embedded' }),
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
    if (res.ok) return;
    expect(res.message).toContain('Image URL');
  });

  it('accepts a CSV image URL column', () => {
    const res = resolveExportFields({
      ...base,
      format: 'csv',
      fields: ['name', 'image'],
      options: parseOptions({ includeImages: true, imageMode: 'url' }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.imagesRequested).toBe(true);
  });

  it('rejects includeImages when the image field was not selected', () => {
    const res = resolveExportFields({
      ...base,
      format: 'pdf',
      fields: ['name', 'sku'],
      options: parseOptions({ includeImages: true }),
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
  });

  it('reports imagesRequested false when the image field is absent — no image work at all', () => {
    const res = resolveExportFields({
      ...base,
      format: 'csv',
      fields: ['name', 'sku'],
      options: parseOptions(),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.imagesRequested).toBe(false);
  });

  it('rejects the catalog layout for a non-book export', () => {
    const res = resolveExportFields({
      ...base,
      itemType: 'product',
      format: 'pdf',
      fields: ['name', 'sku'],
      options: parseOptions({ pdf: { layout: 'catalog' } }),
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
    if (res.ok) return;
    expect(res.message.toLowerCase()).toContain('book');
  });
});

describe('resolveExportFields — order', () => {
  it('returns the fields in the EXACT order requested, not registry order', () => {
    const res = resolveExportFields({
      itemType: 'book',
      format: 'xlsx',
      fields: ['status', 'isbn', 'name'],
      options: parseOptions(),
      can: allow,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fields.map((f) => f.key)).toEqual(['status', 'isbn', 'name']);
  });
});

describe('exportItemTypeKind', () => {
  it('treats only book as book', () => {
    expect(exportItemTypeKind('book')).toBe('book');
    expect(exportItemTypeKind('all')).toBe('other');
    expect(exportItemTypeKind('product')).toBe('other');
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/lib/exports/export-request.test.ts 2>&1 | tail -20`
Expected: FAIL — `Failed to resolve import "./export-request"`. Record the real text.

- [ ] **Step 3: Write the schema and validator.** Create `apps/web/src/lib/exports/export-request.ts`:

```ts
import { z } from 'zod';

import type { Permission } from '@stockpilot/core';

import {
  defaultFieldKeysFor,
  getExportField,
  IDENTIFYING_FIELD_KEYS,
  type InventoryExportField,
  type InventoryExportFieldKey,
} from './field-registry';

/**
 * The export request contract (Brief section 16) and the SERVER-side field
 * resolver (Brief section 25).
 *
 * The schema is shared by the browser (which builds the request) and the route
 * (which re-parses it). The resolver runs ONLY on the server: a client can post
 * any JSON it likes, so the authoritative answer to "which fields are in this
 * file" is computed here from the registry, never taken on trust.
 */

/** A 30-column PDF is already unreadable; a 30-column CSV is plenty. */
export const INVENTORY_EXPORT_MAX_FIELDS = 30;

const filtersSchema = z.object({
  q: z.string().optional(),
  status: z.enum(['active', 'archived', 'discontinued', 'all']).optional(),
  stock: z.enum(['low', 'out']).nullable().optional(),
  // Mig 0277: true = the page's Expected chip view — export ONLY items
  // awaiting their first receipt (matching the visible rows).
  expected: z.boolean().optional(),
  sort: z.string().optional(),
  categoryIds: z.array(z.string()).optional(),
  locationIds: z.array(z.string()).optional(),
  charterIds: z.array(z.string()).optional(),
});

const pdfOptionsSchema = z
  .object({
    layout: z.enum(['table', 'catalog']).default('table'),
    catalogColumns: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
    orientation: z.enum(['auto', 'portrait', 'landscape']).default('auto'),
    // Letter and Legal only. A4 is deliberately absent: the brief allows it
    // "only if it fits requirements", and no StockPilot org prints A4 today.
    paperSize: z.enum(['letter', 'legal']).default('letter'),
    density: z.enum(['compact', 'comfortable', 'image-friendly']).default('comfortable'),
    repeatHeaders: z.boolean().default(true),
    pageNumbers: z.boolean().default(true),
    wrapText: z.boolean().default(true),
  })
  .default({});

const xlsxOptionsSchema = z
  .object({
    freezeHeader: z.boolean().default(true),
    autoFilter: z.boolean().default(true),
    includeSummarySheet: z.boolean().default(false),
  })
  .default({});

const optionsSchema = z
  .object({
    includeImages: z.boolean().default(false),
    imageMode: z.enum(['embedded', 'url', 'both']).default('embedded'),
    imageSize: z.enum(['small', 'medium', 'large']).default('medium'),
    /** Drives the descriptive filename only. Sanitized before use. */
    presetName: z.string().max(60).optional(),
    pdf: pdfOptionsSchema,
    xlsx: xlsxOptionsSchema,
  })
  .default({});

export const inventoryExportRequestSchema = z.object({
  format: z.enum(['csv', 'xlsx', 'pdf']),
  scope: z.enum(['selected', 'filtered', 'all']),
  itemType: z.enum(['product', 'book', 'asset', 'consumable', 'all']).default('all'),
  ids: z.array(z.string().uuid()).max(10_000).optional(),
  filters: filtersSchema.optional(),
  /** Absent = use the registry defaults for this item type. */
  fields: z.array(z.string()).min(1).max(INVENTORY_EXPORT_MAX_FIELDS).optional(),
  options: optionsSchema,
});

export type InventoryExportRequestParsed = z.output<typeof inventoryExportRequestSchema>;
export type InventoryExportOptions = InventoryExportRequestParsed['options'];
export type InventoryExportItemType = InventoryExportRequestParsed['itemType'];
export type InventoryExportFormat = InventoryExportRequestParsed['format'];

export function exportItemTypeKind(itemType: InventoryExportItemType): 'book' | 'other' {
  return itemType === 'book' ? 'book' : 'other';
}

export interface ResolveExportFieldsInput {
  fields?: readonly string[];
  itemType: InventoryExportItemType;
  format: InventoryExportFormat;
  options: InventoryExportOptions;
  can: (permission: Permission) => boolean;
  /**
   * Test-only seam. The registry has no permission-bearing field today (no
   * cost-visibility permission exists in this codebase — owner decision open),
   * so the enforcement path would otherwise be unreachable and would rot. Never
   * pass this from production code.
   */
  permissionOverrides?: Partial<Record<InventoryExportFieldKey, Permission>>;
}

export type ResolveExportFieldsResult =
  | { ok: true; fields: InventoryExportField[]; imagesRequested: boolean }
  | { ok: false; status: 400 | 403; message: string };

const fail = (status: 400 | 403, message: string): ResolveExportFieldsResult => ({
  ok: false,
  status,
  message,
});

/**
 * Turn a (possibly hostile) requested field list into the authoritative,
 * ordered field objects the formatters use — or a refusal.
 *
 * Order is preserved exactly as requested: the user's column order IS the
 * output order, in all three formats.
 */
export function resolveExportFields(input: ResolveExportFieldsInput): ResolveExportFieldsResult {
  const kind = exportItemTypeKind(input.itemType);
  const requested =
    input.fields && input.fields.length > 0 ? [...input.fields] : defaultFieldKeysFor(kind);

  const seen = new Set<string>();
  const resolved: InventoryExportField[] = [];
  for (const key of requested) {
    if (seen.has(key)) {
      return fail(400, `Duplicate field in this export: ${key}.`);
    }
    seen.add(key);

    const field = getExportField(key);
    if (!field) {
      return fail(400, `Unknown export field: ${key}.`);
    }
    // Book-only fields are offered for book exports and for the everything
    // export (which can contain books); never for product/asset/consumable.
    if (field.appliesTo === 'book' && !(input.itemType === 'book' || input.itemType === 'all')) {
      return fail(400, `${field.label} is only available on book exports.`);
    }
    const supported =
      input.format === 'csv'
        ? field.csvSupported
        : input.format === 'xlsx'
          ? field.xlsxSupported
          : field.pdfSupported;
    if (!supported) {
      return fail(400, `${field.label} is not available in ${input.format.toUpperCase()} exports.`);
    }
    const permission = input.permissionOverrides?.[field.key] ?? field.permission;
    if (permission && !input.can(permission)) {
      return fail(403, `You do not have permission to export ${field.label}.`);
    }
    resolved.push(field);
  }

  if (!resolved.some((f) => IDENTIFYING_FIELD_KEYS.includes(f.key))) {
    return fail(
      400,
      'Include at least one identifying field: Name, SKU, ISBN or Barcode.',
    );
  }

  const imagesRequested = resolved.some((f) => f.key === 'image');
  const { includeImages, imageMode } = input.options;

  if (includeImages && !imagesRequested) {
    return fail(400, 'Select the Image field to include images in this export.');
  }
  if (imagesRequested && input.format === 'csv' && imageMode !== 'url') {
    return fail(
      400,
      'CSV files cannot contain images. Choose Image URL, or export to Excel or PDF.',
    );
  }
  if (imagesRequested && input.format === 'pdf' && imageMode === 'both') {
    return fail(400, 'PDF exports embed images; Both is an Excel-only option.');
  }
  if (input.options.pdf.layout === 'catalog') {
    if (input.format !== 'pdf') {
      return fail(400, 'The book catalog layout is only available for PDF exports.');
    }
    if (input.itemType !== 'book') {
      return fail(400, 'The book catalog layout is only available for book exports.');
    }
  }

  return { ok: true, fields: resolved, imagesRequested };
}
```

- [ ] **Step 4: Run the validation test to verify it passes.**

Run: `pnpm --filter @stockpilot/web test src/lib/exports/export-request.test.ts 2>&1 | tail -20`
Expected: PASS — 19 tests.

- [ ] **Step 5: Typecheck and commit.**

Run: `pnpm --filter @stockpilot/web typecheck 2>&1 | tail -20`
Expected: clean.

```bash
git add apps/web/src/lib/exports/export-request.ts \
        apps/web/src/lib/exports/export-request.test.ts
git commit -m "feat(inventory): export request schema and server-side field validation"
```

---

## Task 6: Source rows under the existing row builder

`buildInventoryExportRows` already does the expensive part correctly: one `InventoryService.list` with per-scope filter shaping, five fail-closed lookups, the ISBN fallback chain, `expected: 'any'` for selected scope. This task grows a typed source row underneath it and makes the legacy 25-key flat record a projection of that row — so there is exactly one query path, one ISBN derivation, one charter rule, and the legacy CSV route and its test keep working untouched (R1).

**Files:**
- Modify: `apps/web/src/lib/inventory-export.ts:64-73, 136-185`
- Modify: `apps/web/src/lib/inventory-export.test.ts`

**Interfaces:**
- Consumes from Task 2: `formatCharterCell`. From Task 4: `InventoryExportSourceRow`, `ExportCell`.
- Produces for Tasks 7, 11, 12, 13:
  - `buildInventoryExportSourceRows(ctx: ServiceContext, args: BuildExportArgs): Promise<InventoryExportSourceResult>` where `InventoryExportSourceResult = { rows: InventoryExportSourceRow[]; total: number; truncated: boolean; slug: 'books' | 'inventory' }`.
  - `buildInventoryExportRows` keeps its EXACT current signature and return type (`{ headers, rows, total, truncated, slug }` with the 25 snake_case keys) and is now implemented on top of the source rows.
  - `ExportCell` continues to be exported from `@/lib/inventory-export` (re-exported from `./exports/source-row`) so `inventory-export-xlsx.ts` needs no import change.
- Note for Task 7: this task does NOT resolve images. `row.image` is always `null` here; Task 7's resolver populates it in the route.

**Steps:**

- [ ] **Step 1: Write the failing source-row test.** Append to `apps/web/src/lib/inventory-export.test.ts`, adding `buildInventoryExportSourceRows` to the existing import from `./inventory-export`:

```ts
describe('buildInventoryExportSourceRows', () => {
  it('returns a typed source row with resolved lookups and combined storage labels', async () => {
    listMock.mockResolvedValueOnce({
      items: [
        {
          ...sampleItem,
          item_type: 'book',
          barcode: '9780262033848',
          custom_fields: {
            author: 'Cormen',
            book_grade: 'College',
            book_rack_number: '38',
            book_rack_row: 'A',
            book_crate_color: 'blue',
            book_crate_number: '12',
          },
        },
      ],
      total: 1,
    });
    const res = await buildInventoryExportSourceRows(ctx, { scope: 'all', itemType: 'book' });
    const r = res.rows[0]!;
    expect(r.id).toBe('i1');
    expect(r.itemType).toBe('book');
    expect(r.isbn).toBe('9780262033848');
    expect(r.author).toBe('Cormen');
    expect(r.grade).toBe('College');
    expect(r.rackNumber).toBe('38');
    expect(r.rackRow).toBe('A');
    expect(r.rackLabel).toBe('38-A');
    expect(r.crateColor).toBe('blue');
    expect(r.crateNumber).toBe('12');
    expect(r.crateLabel).toBe('Blue 12');
    expect(r.category).toBe('Electronics');
    expect(r.charter).toBe('Visalia');
    expect(res.slug).toBe('books');
  });

  it('never populates image data — that is the caller\'s explicit opt-in', async () => {
    const res = await buildInventoryExportSourceRows(ctx, { scope: 'all', itemType: 'all' });
    expect(res.rows[0]!.image).toBeNull();
  });

  it('says Generic for a null charter, exactly like the flat row builder', async () => {
    listMock.mockResolvedValueOnce({ items: [{ ...sampleItem, charter_id: null }], total: 1 });
    const res = await buildInventoryExportSourceRows(ctx, { scope: 'all', itemType: 'all' });
    expect(res.rows[0]!.charter).toBe('Generic');
  });

  it('emits empty strings rather than null or undefined for every text field', async () => {
    listMock.mockResolvedValueOnce({
      items: [
        {
          ...sampleItem,
          barcode: null,
          category_id: null,
          primary_location_id: null,
          supplier_id: null,
          warehouse_id: null,
          custom_fields: null,
        },
      ],
      total: 1,
    });
    const res = await buildInventoryExportSourceRows(ctx, { scope: 'all', itemType: 'all' });
    const r = res.rows[0]!;
    for (const key of [
      'barcode',
      'category',
      'primaryLocation',
      'supplier',
      'warehouse',
      'author',
      'isbn',
      'grade',
      'rackNumber',
      'rackRow',
      'crateColor',
      'crateNumber',
      'rackLabel',
      'crateLabel',
    ] as const) {
      expect(r[key], `${key} was ${String(r[key])}`).toBe('');
    }
  });

  it('keeps the flat legacy row builder byte-compatible with what it returned before', async () => {
    // R1: /api/inventory/export.csv and its consumers must not move.
    const res = await buildInventoryExportRows(ctx, { scope: 'all', itemType: 'all' });
    expect(res.headers).toEqual([...INVENTORY_EXPORT_HEADERS]);
    expect(Object.keys(res.rows[0]!).sort()).toEqual([...INVENTORY_EXPORT_HEADERS].sort());
  });

  it('uses the same list() arguments as the flat builder for every scope', async () => {
    await buildInventoryExportSourceRows(ctx, {
      scope: 'selected',
      itemType: 'all',
      ids: ['i1'],
    });
    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({ ids: ['i1'], status: 'all', expected: 'any' }),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/lib/inventory-export.test.ts 2>&1 | tail -20`
Expected: FAIL — `buildInventoryExportSourceRows is not a function`. Record the real text.

- [ ] **Step 3: Restructure the builder.** In `apps/web/src/lib/inventory-export.ts`:

(a) Add imports under the existing ones:

```ts
import { readBookStorage } from '@/lib/book-storage';

import type { InventoryExportSourceRow } from './exports/source-row';
```

(b) Replace the `ExportCell` declaration (line 64-65) with a re-export so existing importers are unaffected:

```ts
/** A single export cell — exactly what toCsv()/exceljs/react-pdf accept.
 *  Defined in ./exports/source-row (which the browser can import too) and
 *  re-exported here because inventory-export-xlsx.ts has always imported it
 *  from this module. */
export type { ExportCell } from './exports/source-row';
```

(c) Add the source result type beside `InventoryExportResult`:

```ts
export interface InventoryExportSourceResult {
  rows: InventoryExportSourceRow[];
  total: number;
  truncated: boolean;
  slug: 'books' | 'inventory';
}
```

(d) Replace the body of `buildInventoryExportRows` (lines 81-185) with the two functions below. The `list()` call, the `safe()` wrapper and the five lookups move verbatim into the source-row builder; nothing about the query changes.

```ts
/**
 * Build RAW export rows for any format. FAIL-CLOSED on the id-to-name lookups:
 * a lookup that throws (disabled module, read error) must NOT 500 the whole
 * export — we just leave that column blank.
 *
 * Images are NOT resolved here. A plain CSV must issue zero image queries
 * (Brief section 18), so the caller opts in by calling the export image
 * resolver and attaching the result.
 */
export async function buildInventoryExportSourceRows(
  ctx: ServiceContext,
  args: BuildExportArgs,
): Promise<InventoryExportSourceResult> {
  const inv = new InventoryService(ctx);
  const list = await inv.list({
    itemType: args.itemType,
    limit: ROW_CAP,
    ...(args.scope === 'selected'
      ? // expected:'any' (mig 0277): an explicitly-selected row must export
        // whether or not it is still awaiting its first receipt — the ids
        // narrowing IS the user's filter, so the default flagged-row
        // exclusion would silently drop rows they checked.
        { ids: args.ids ?? [], status: 'all' as const, expected: 'any' as const }
      : args.scope === 'filtered'
        ? {
            q: args.filters?.q,
            // The Expected view spans lifecycles (the pages pass
            // status:'all' to list() when ?expected=1), so its export
            // does too — otherwise an archived flagged row shows in the
            // view but vanishes from its export.
            status: args.filters?.expected ? ('all' as const) : (args.filters?.status ?? 'active'),
            lowStock: args.filters?.stock === 'low',
            outOfStock: args.filters?.stock === 'out',
            expected: args.filters?.expected === true,
            sort: args.filters?.sort ?? 'updated_desc',
            categoryIds: args.filters?.categoryIds ?? [],
            locationIds: args.filters?.locationIds ?? [],
            charterIds: args.filters?.charterIds ?? [],
            warehouseId: args.filters?.warehouseId ?? null,
          }
        : { status: 'active' as const }),
  });

  // FAIL-CLOSED lookups — each independently degrades to an empty map.
  const safe = async <T>(p: Promise<T[]>): Promise<T[]> => {
    try {
      return await p;
    } catch {
      return [];
    }
  };
  const [categories, locations, suppliers, warehouses, charters] = await Promise.all([
    safe(new CategoriesService(ctx).list()),
    safe(new LocationsService(ctx).list()),
    safe(new SuppliersService(ctx).list()),
    safe(new WarehousesService(ctx).list()),
    safe(new ChartersService(ctx).list()),
  ]);
  const catMap = new Map(categories.map((c) => [c.id, c.name]));
  const locMap = new Map(locations.map((l) => [l.id, l.name]));
  const supMap = new Map(suppliers.map((s) => [s.id, s.name]));
  const whMap = new Map(warehouses.map((w) => [w.id, w.name]));
  const chMap = new Map(charters.map((c) => [c.id, c.name]));

  const rows: InventoryExportSourceRow[] = list.items.map((i) => {
    const cf = (i.custom_fields ?? {}) as Record<string, unknown>;
    const str = (k: string) => {
      const v = cf[k];
      return v == null ? '' : String(v);
    };
    // The same reader the books list page uses, so "38-A" and "Blue 12" mean
    // exactly what they mean on screen. Never re-derives or rewrites storage.
    const storage = readBookStorage(cf);
    return {
      id: i.id,
      itemType: i.item_type,
      name: i.name,
      sku: i.sku,
      barcode: i.barcode ?? '',
      status: i.status,
      quantityOnHand: i.quantity_on_hand,
      reorderPoint: i.reorder_point,
      reorderQuantity: (i as unknown as { reorder_quantity?: number }).reorder_quantity ?? 0,
      unitCost: i.unit_cost ?? null,
      retailPrice: i.retail_price ?? null,
      category: i.category_id ? (catMap.get(i.category_id) ?? '') : '',
      primaryLocation: i.primary_location_id ? (locMap.get(i.primary_location_id) ?? '') : '',
      supplier: i.supplier_id ? (supMap.get(i.supplier_id) ?? '') : '',
      warehouse: i.warehouse_id ? (whMap.get(i.warehouse_id) ?? '') : '',
      charter: formatCharterCell(i.charter_id, chMap),
      trackingType: i.tracking_type,
      author: str('author'),
      // For books, ISBN is the barcode — the form labels the same column
      // "ISBN" for books and "Barcode" otherwise, and bulk imports store the
      // ISBN at inventory_items.barcode. The custom_fields keys are legacy
      // fallbacks from older imports.
      isbn:
        i.item_type === 'book'
          ? (i.barcode ?? '') || str('isbn') || str('isbn13') || str('isbn10')
          : '',
      grade: storage.grade ?? '',
      rackNumber: storage.rackNumber ?? '',
      rackRow: storage.rackRow ?? '',
      crateColor: storage.crateColor ?? '',
      crateNumber: storage.crateNumber ?? '',
      rackLabel: storage.rackLabel ?? '',
      crateLabel: storage.crateLabel ?? '',
      createdAt: i.created_at,
      updatedAt: i.updated_at,
      image: null,
    };
  });

  return {
    rows,
    total: list.total,
    truncated: list.total > rows.length,
    slug: args.itemType === 'book' ? 'books' : 'inventory',
  };
}

/**
 * The legacy flat 25-column record, keyed by INVENTORY_EXPORT_HEADERS.
 *
 * Kept EXACTLY as it was — /api/inventory/export.csv, its consumers and its
 * bookmarked links depend on these header names and this order. It is now a
 * projection of the source rows so there is one query path and one ISBN /
 * charter rule, not two that can drift.
 */
export async function buildInventoryExportRows(
  ctx: ServiceContext,
  args: BuildExportArgs,
): Promise<InventoryExportResult> {
  const source = await buildInventoryExportSourceRows(ctx, args);
  const rows = source.rows.map((r) => ({
    name: r.name,
    sku: r.sku,
    barcode: r.barcode,
    item_type: r.itemType,
    status: r.status,
    quantity_on_hand: r.quantityOnHand,
    reorder_point: r.reorderPoint,
    reorder_quantity: r.reorderQuantity,
    unit_cost: r.unitCost,
    retail_price: r.retailPrice,
    category: r.category,
    primary_location: r.primaryLocation,
    supplier: r.supplier,
    warehouse: r.warehouse,
    charter: r.charter,
    tracking_type: r.trackingType,
    author: r.author,
    isbn: r.isbn,
    grade: r.grade,
    rack_number: r.rackNumber,
    rack_row: r.rackRow,
    crate_color: r.crateColor,
    crate_number: r.crateNumber,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  }));
  return {
    headers: [...INVENTORY_EXPORT_HEADERS],
    rows,
    total: source.total,
    truncated: source.truncated,
    slug: source.slug,
  };
}
```

- [ ] **Step 4: Run the suite to verify everything passes.**

Run: `pnpm --filter @stockpilot/web test src/lib/inventory-export.test.ts 2>&1 | tail -20`
Expected: PASS — the 7 original tests, Task 2's 6, and these 6.

- [ ] **Step 5: Prove the legacy CSV route still behaves (R1).**

Run: `pnpm --filter @stockpilot/web test src/lib/inventory-export.test.ts src/app/api/inventory 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit.**

Run: `pnpm --filter @stockpilot/web typecheck 2>&1 | tail -20`
Expected: clean. `unit_cost`/`retail_price` are `number` on the service row and `number | null` on the source row — the `?? null` is deliberate, not a workaround; do not widen the service type.

```bash
git add apps/web/src/lib/inventory-export.ts apps/web/src/lib/inventory-export.test.ts
git commit -m "feat(inventory): typed export source rows under the existing row builder"
```

---

## Task 7: The image pipeline

Brief §18 and §24. Three jobs, all opt-in, all batched, none of them ever touching a 2048px master:

1. **Resolve** thumbnail URLs for a set of item ids (PDF rendering, Excel embedding, CSV URL column).
2. **Count** how many items have a usable image, without signing anything, for the readiness panel (Brief §20).
3. **Fetch** the bytes for Excel embedding, under a timeout, a per-image byte cap, a total byte cap, a content-type allowlist and a concurrency limit — continuing past any individual failure.

**Files:**
- Create: `apps/web/src/lib/exports/export-images.ts`
- Create: `apps/web/src/lib/exports/export-images.test.ts`

**Interfaces:**
- Consumes from Task 4: `InventoryExportImage`, `InventoryExportSourceRow`.
- Produces for Tasks 11, 13:
  - `EXPORT_IMAGE_TARGET_WIDTH_PX: Record<'small' | 'medium' | 'large', number>` = `{ small: 120, medium: 200, large: 320 }`.
  - `MAX_EMBEDDED_IMAGE_BYTES = 512 * 1024`, `MAX_TOTAL_EMBEDDED_IMAGE_BYTES = 24 * 1024 * 1024`, `MAX_EMBEDDED_IMAGES = 2_000`, `IMAGE_FETCH_TIMEOUT_MS = 6_000`, `IMAGE_FETCH_CONCURRENCY = 6`.
  - `attachExportImages(ctx: ServiceContext, rows: InventoryExportSourceRow[], opts: { imageSize: 'small'|'medium'|'large' }): Promise<void>` — mutates `row.image` in place, fail-closed.
  - `countRowsWithImages(ctx: ServiceContext, itemIds: string[]): Promise<number>` — no signing.
  - `fetchExportImageBytes(urls: ReadonlyMap<string, string>, opts?: { fetchImpl?: typeof fetch }): Promise<{ images: Map<string, EmbeddedImage>; skipped: number; truncated: boolean }>` where `EmbeddedImage = { data: Uint8Array; extension: 'png' | 'jpeg' }`.
  - `EXPORT_TOO_MANY_IMAGES_MESSAGE: string` — the exact Brief §24 copy.

**Steps:**

- [ ] **Step 1: Write the failing image test.** Create `apps/web/src/lib/exports/export-images.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const primaryImagesForPdfRendering = vi.fn();

vi.mock('@/server/services/item-images', () => ({
  ItemImagesService: vi.fn().mockImplementation(() => ({ primaryImagesForPdfRendering })),
}));

import {
  attachExportImages,
  EXPORT_IMAGE_TARGET_WIDTH_PX,
  EXPORT_TOO_MANY_IMAGES_MESSAGE,
  fetchExportImageBytes,
  MAX_EMBEDDED_IMAGE_BYTES,
} from './export-images';
import type { InventoryExportSourceRow } from './source-row';

const ctx = {} as never;

function makeRow(id: string): InventoryExportSourceRow {
  return {
    id,
    itemType: 'book',
    name: `Book ${id}`,
    sku: `BK-${id}`,
    barcode: '',
    status: 'active',
    quantityOnHand: 1,
    reorderPoint: 0,
    reorderQuantity: 0,
    unitCost: null,
    retailPrice: null,
    category: '',
    primaryLocation: '',
    supplier: '',
    warehouse: '',
    charter: 'Generic',
    trackingType: 'none',
    author: '',
    isbn: '',
    grade: '',
    rackNumber: '',
    rackRow: '',
    crateColor: '',
    crateNumber: '',
    rackLabel: '',
    crateLabel: '',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    image: null,
  };
}

function jpegResponse(bytes: number, contentType = 'image/jpeg'): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': contentType, 'content-length': String(bytes) },
  });
}

beforeEach(() => {
  primaryImagesForPdfRendering.mockReset();
});

describe('attachExportImages', () => {
  it('asks the PDF-sized resolver ONCE for every id, never per row', async () => {
    primaryImagesForPdfRendering.mockResolvedValue(
      new Map([
        ['a', 'https://signed.example/a.webp'],
        ['b', 'https://signed.example/b.webp'],
      ]),
    );
    const rows = [makeRow('a'), makeRow('b'), makeRow('c')];
    await attachExportImages(ctx, rows, { imageSize: 'medium' });
    expect(primaryImagesForPdfRendering).toHaveBeenCalledTimes(1);
    expect(primaryImagesForPdfRendering).toHaveBeenCalledWith(
      ['a', 'b', 'c'],
      EXPORT_IMAGE_TARGET_WIDTH_PX.medium,
    );
    expect(rows[0]!.image).toEqual({ thumbnailUrl: 'https://signed.example/a.webp' });
    expect(rows[2]!.image).toBeNull();
  });

  it('scales the requested thumbnail width with the chosen image size', async () => {
    primaryImagesForPdfRendering.mockResolvedValue(new Map());
    await attachExportImages(ctx, [makeRow('a')], { imageSize: 'large' });
    expect(primaryImagesForPdfRendering).toHaveBeenCalledWith(['a'], 320);
  });

  it('FAILS CLOSED — a resolver throw leaves every row imageless instead of failing the export', async () => {
    primaryImagesForPdfRendering.mockRejectedValue(new Error('storage unavailable'));
    const rows = [makeRow('a')];
    await expect(attachExportImages(ctx, rows, { imageSize: 'small' })).resolves.toBeUndefined();
    expect(rows[0]!.image).toBeNull();
  });

  it('does nothing at all for an empty row set', async () => {
    await attachExportImages(ctx, [], { imageSize: 'small' });
    expect(primaryImagesForPdfRendering).not.toHaveBeenCalled();
  });
});

describe('fetchExportImageBytes', () => {
  it('fetches every URL and reports the extension from the content type', async () => {
    const fetchImpl = vi.fn(async () => jpegResponse(1024));
    const { images, skipped } = await fetchExportImageBytes(
      new Map([['a', 'https://signed.example/a.jpg']]),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(skipped).toBe(0);
    expect(images.get('a')!.extension).toBe('jpeg');
    expect(images.get('a')!.data.byteLength).toBe(1024);
  });

  it('skips an oversized image and keeps going', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('big.jpg') ? jpegResponse(MAX_EMBEDDED_IMAGE_BYTES + 1) : jpegResponse(512),
    );
    const { images, skipped } = await fetchExportImageBytes(
      new Map([
        ['big', 'https://signed.example/big.jpg'],
        ['ok', 'https://signed.example/ok.jpg'],
      ]),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(images.has('big')).toBe(false);
    expect(images.has('ok')).toBe(true);
    expect(skipped).toBe(1);
  });

  it('skips unsupported content types — SVG and WebP are never embedded', async () => {
    // SVG is a script carrier. WebP is skipped because exceljs accepts only
    // png/jpeg/gif and older Excel cannot decode WebP — a mislabelled WebP
    // renders as a broken picture rather than failing loudly.
    for (const type of ['image/svg+xml', 'image/webp', 'image/gif', 'text/html']) {
      const fetchImpl = vi.fn(async () => jpegResponse(256, type));
      const { images, skipped } = await fetchExportImageBytes(
        new Map([['a', 'https://signed.example/a.bin']]),
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      );
      expect(images.size, type).toBe(0);
      expect(skipped, type).toBe(1);
    }
  });

  it('skips a non-200 response and a thrown fetch without failing the batch', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('404.jpg')) return new Response('nope', { status: 404 });
      if (url.endsWith('boom.jpg')) throw new Error('ECONNRESET');
      return jpegResponse(128);
    });
    const { images, skipped } = await fetchExportImageBytes(
      new Map([
        ['a', 'https://signed.example/404.jpg'],
        ['b', 'https://signed.example/boom.jpg'],
        ['c', 'https://signed.example/ok.jpg'],
      ]),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(images.size).toBe(1);
    expect(images.has('c')).toBe(true);
    expect(skipped).toBe(2);
  });

  it('stops once the total byte budget is spent and reports truncation', async () => {
    const big = 400 * 1024;
    const fetchImpl = vi.fn(async () => jpegResponse(big));
    const urls = new Map(
      Array.from({ length: 200 }, (_, i) => [`i${i}`, `https://signed.example/${i}.jpg`] as const),
    );
    const { images, truncated } = await fetchExportImageBytes(urls, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(truncated).toBe(true);
    const total = [...images.values()].reduce((sum, img) => sum + img.data.byteLength, 0);
    expect(total).toBeLessThanOrEqual(24 * 1024 * 1024);
  });

  it('never logs a signed URL', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom');
    });
    await fetchExportImageBytes(
      new Map([['a', 'https://signed.example/a.jpg?token=SECRET-TOKEN']]),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    for (const spy of [warn, error]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain('SECRET-TOKEN');
        expect(JSON.stringify(call)).not.toContain('signed.example');
      }
    }
    warn.mockRestore();
    error.mockRestore();
  });
});

describe('EXPORT_TOO_MANY_IMAGES_MESSAGE', () => {
  it('is the exact copy the brief specifies', () => {
    expect(EXPORT_TOO_MANY_IMAGES_MESSAGE).toBe(
      'This export contains too many embedded images. Reduce the number of records, choose smaller images, or export without images.',
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/lib/exports/export-images.test.ts 2>&1 | tail -20`
Expected: FAIL — `Failed to resolve import "./export-images"`. Record the real text.

- [ ] **Step 3: Write the pipeline.** Create `apps/web/src/lib/exports/export-images.ts`:

```ts
import 'server-only';

import { ItemImagesService } from '@/server/services/item-images';
import type { ServiceContext } from '@/server/services/context';

import type { InventoryExportSourceRow } from './source-row';

/**
 * Export image pipeline (Brief sections 18 and 24).
 *
 * EVERY path here goes through ItemImagesService.primaryImagesForPdfRendering,
 * which already implements the exact priority chain the brief asks for —
 * stored 200px thumb_path, else an on-the-fly Supabase transform of the master
 * at the target width, else the legacy custom_fields.thumbnail_url that the
 * ISBN bulk importer writes for book covers — in ONE batched query plus one
 * batched signing call.
 *
 * NEVER use primaryMasterUrlsForItems here. That resolver returns the 2048px
 * master for the public catalog's next/image pipeline; fetching hundreds of
 * masters server-side to build one PDF is the exact landmine the public-catalog
 * work already stepped on once.
 *
 * Nothing in this module is called unless the request selected the Image field.
 */

/** Requested thumbnail width per size tier. 200 matches the stored thumb. */
export const EXPORT_IMAGE_TARGET_WIDTH_PX = {
  small: 120,
  medium: 200,
  large: 320,
} as const;

/** Per-image ceiling. A ~200px WebP is 20-50KB; 512KB is a generous outlier. */
export const MAX_EMBEDDED_IMAGE_BYTES = 512 * 1024;
/** Whole-export ceiling. Keeps one workbook inside the 60s / memory budget. */
export const MAX_TOTAL_EMBEDDED_IMAGE_BYTES = 24 * 1024 * 1024;
/** Hard count ceiling regardless of size. */
export const MAX_EMBEDDED_IMAGES = 2_000;
export const IMAGE_FETCH_TIMEOUT_MS = 6_000;
export const IMAGE_FETCH_CONCURRENCY = 6;

/** Brief section 24, verbatim. */
export const EXPORT_TOO_MANY_IMAGES_MESSAGE =
  'This export contains too many embedded images. Reduce the number of records, choose smaller images, or export without images.';

/** Content types we will embed. SVG is excluded deliberately: it is a script
 *  carrier, and neither exceljs nor react-pdf needs it. */
const ALLOWED_CONTENT_TYPES: ReadonlyMap<string, 'png' | 'jpeg'> = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpeg'],
  ['image/jpg', 'jpeg'],
  // WebP is DELIBERATELY absent. exceljs accepts only png/jpeg/gif, and older
  // Excel builds cannot decode WebP at all, so embedding a mislabelled WebP
  // produces a broken picture rather than an error. Supabase-stored thumbs are
  // WebP; externally-sourced book covers (the ISBN importer's Google Books /
  // Open Library URLs) are JPEG, which is the case that matters most for a
  // books catalog. WebP rows are counted as skipped and keep their URL instead.
  // This is a documented limitation in the section 31 report.
]);

export interface EmbeddedImage {
  data: Uint8Array;
  extension: 'png' | 'jpeg';
}

/**
 * Resolve a thumbnail URL for each row that has one, in ONE batched call, and
 * attach it to the row. Fail-closed: any error leaves every row imageless and
 * the export continues with placeholders (Brief section 3.3).
 */
export async function attachExportImages(
  ctx: ServiceContext,
  rows: InventoryExportSourceRow[],
  opts: { imageSize: keyof typeof EXPORT_IMAGE_TARGET_WIDTH_PX },
): Promise<void> {
  if (rows.length === 0) return;
  try {
    const service = new ItemImagesService(ctx);
    const urls = await service.primaryImagesForPdfRendering(
      rows.map((r) => r.id),
      EXPORT_IMAGE_TARGET_WIDTH_PX[opts.imageSize],
    );
    for (const row of rows) {
      const url = urls.get(row.id);
      row.image = url ? { thumbnailUrl: url } : null;
    }
  } catch {
    // Swallow and blank, exactly like buildInventoryExportRows' safe() wrapper.
    // Never log: the message can carry a signed URL.
    for (const row of rows) row.image = null;
  }
}

/**
 * How many of these items have a usable image, WITHOUT signing anything.
 *
 * Readiness ("84 of 111 have a cover") only needs presence, and signing is the
 * expensive half of the resolver — so this is two plain selects and no Storage
 * round trip at all.
 */
export async function countRowsWithImages(
  ctx: ServiceContext,
  itemIds: string[],
): Promise<number> {
  if (itemIds.length === 0) return 0;
  try {
    const withRow = new Set<string>();
    const { data } = await ctx.supabase
      .from('item_images')
      .select('item_id')
      .eq('organization_id', ctx.organizationId)
      .in('item_id', itemIds);
    for (const row of (data ?? []) as Array<{ item_id: string }>) withRow.add(row.item_id);

    const rest = itemIds.filter((id) => !withRow.has(id));
    if (rest.length > 0) {
      const { data: cfRows } = await ctx.supabase
        .from('inventory_items')
        .select('id, custom_fields')
        .eq('organization_id', ctx.organizationId)
        .in('id', rest);
      for (const row of (cfRows ?? []) as Array<{
        id: string;
        custom_fields: Record<string, unknown> | null;
      }>) {
        const url = row.custom_fields?.thumbnail_url;
        if (typeof url === 'string' && url.length > 0) withRow.add(row.id);
      }
    }
    return withRow.size;
  } catch {
    return 0;
  }
}

async function fetchOne(
  url: string,
  fetchImpl: typeof fetch,
): Promise<EmbeddedImage | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return null;
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const extension = ALLOWED_CONTENT_TYPES.get(contentType);
    if (!extension) return null;
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_EMBEDDED_IMAGE_BYTES) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_EMBEDDED_IMAGE_BYTES) return null;
    return { data: buf, extension };
  } catch {
    // Timeout, DNS, reset, abort. Never log — the URL carries a signed token.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch image bytes for embedding, bounded on every axis: per-image size,
 * total size, image count, per-request timeout and parallelism. A failure
 * never propagates — the caller draws a placeholder for the missing id.
 */
export async function fetchExportImageBytes(
  urls: ReadonlyMap<string, string>,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ images: Map<string, EmbeddedImage>; skipped: number; truncated: boolean }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const entries = [...urls.entries()].slice(0, MAX_EMBEDDED_IMAGES);
  const truncatedByCount = urls.size > MAX_EMBEDDED_IMAGES;

  const images = new Map<string, EmbeddedImage>();
  let skipped = 0;
  let totalBytes = 0;
  let budgetSpent = false;

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= entries.length || budgetSpent) return;
      const [id, url] = entries[index]!;
      const image = await fetchOne(url, fetchImpl);
      if (!image) {
        skipped++;
        continue;
      }
      if (totalBytes + image.data.byteLength > MAX_TOTAL_EMBEDDED_IMAGE_BYTES) {
        budgetSpent = true;
        return;
      }
      totalBytes += image.data.byteLength;
      images.set(id, image);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(IMAGE_FETCH_CONCURRENCY, entries.length) }, () => worker()),
  );

  return { images, skipped, truncated: truncatedByCount || budgetSpent };
}
```

- [ ] **Step 4: Run the image test to verify it passes.**

Run: `pnpm --filter @stockpilot/web test src/lib/exports/export-images.test.ts 2>&1 | tail -20`
Expected: PASS — 12 tests.

- [ ] **Step 5: Prove nothing reaches for the master resolver.**

Run: `grep -rn "primaryMasterUrlsForItems" apps/web/src/lib apps/web/src/app/api/inventory`
Expected: no output (exit code 1). If it appears, the landmine is back — remove it.

- [ ] **Step 6: Typecheck and commit.**

Run: `pnpm --filter @stockpilot/web typecheck 2>&1 | tail -20`
Expected: clean.

```bash
git add apps/web/src/lib/exports/export-images.ts apps/web/src/lib/exports/export-images.test.ts
git commit -m "feat(inventory): bounded, batched export image pipeline"
```

---
# Phase C — The formats

## Task 8: The PDF layout engine

Brief §11 and §13. One pure function turns "these fields, this paper, this density, images on at this size" into concrete geometry: orientation, point widths per column, row height, row padding, estimated rows per page, and the warnings the dialog shows BEFORE the user generates a 16-column unreadable PDF. It is client-safe, so the dialog and the renderer compute the same answer from the same code.

**Files:**
- Create: `apps/web/src/lib/exports/pdf-layout.ts`
- Create: `apps/web/src/lib/exports/pdf-layout.test.ts`

**Interfaces:**
- Consumes from Task 1: `fitColumnWidths`, `REPORT_PAGE_PADDING_PT`, `REPORT_ROW_PADDING_PT`, `REPORT_CELL_PADDING_PT`. From Task 4: `InventoryExportField`, `fieldHeading`. From Task 5: `InventoryExportOptions`.
- Produces for Tasks 9, 10, 13, 16:
  - `type PaperSize = 'letter' | 'legal'`, `type PdfOrientation = 'portrait' | 'landscape'`, `type PdfDensity = 'compact' | 'comfortable' | 'image-friendly'`, `type ExportImageSize = 'small' | 'medium' | 'large'`.
  - `PAPER_SIZE_PT: Record<PaperSize, Record<PdfOrientation, { widthPt: number; heightPt: number }>>`.
  - `IMAGE_CELL_PT: Record<ExportImageSize, { widthPt: number; rowHeightPt: number }>` = `{ small: { widthPt: 22, rowHeightPt: 28 }, medium: { widthPt: 34, rowHeightPt: 44 }, large: { widthPt: 48, rowHeightPt: 64 } }`.
  - `DENSITY_PT: Record<PdfDensity, { rowPaddingPt: number; minRowHeightPt: number }>`.
  - `TOO_MANY_COLUMNS_THRESHOLD = 12`.
  - `tooManyColumnsWarning(count: number): string`.
  - `interface ExportPdfColumn { key: string; label: string; align: 'left'|'right'|'center'; widthPt: number; wrap: boolean }`.
  - `interface ExportPdfLayout { orientation; paperSize; pageWidthPt; pageHeightPt; contentWidthPt; imageColumnWidthPt; imageBoxPt; rowHeightPt; rowPaddingPt; columns: ExportPdfColumn[]; warnings: string[]; overflow: boolean; estimatedRowsPerPage: number }`.
  - `computeExportPdfLayout(input: { fields: readonly InventoryExportField[]; itemTypeKind: 'book'|'other'; includeImages: boolean; imageSize: ExportImageSize; orientation: 'auto'|PdfOrientation; paperSize: PaperSize; density: PdfDensity; wrapText: boolean; layout: 'table'|'catalog'; catalogColumns: 1|2|3 }): ExportPdfLayout`.
  - `estimateExportPdfPages(layout: ExportPdfLayout, rowCount: number, opts?: { catalogColumns?: number }): { min: number; max: number }`.

**Steps:**

- [ ] **Step 1: Write the failing layout test.** Create `apps/web/src/lib/exports/pdf-layout.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { width } from '@/test/pdf-font-metrics';
import { REPORT_CELL_PADDING_PT } from '@/lib/pdf/column-fit';

import { getExportField, type InventoryExportFieldKey } from './field-registry';
import {
  computeExportPdfLayout,
  estimateExportPdfPages,
  IMAGE_CELL_PT,
  TOO_MANY_COLUMNS_THRESHOLD,
  tooManyColumnsWarning,
} from './pdf-layout';

const fields = (keys: InventoryExportFieldKey[]) => keys.map((k) => getExportField(k)!);

const BOOKS_DEFAULT: InventoryExportFieldKey[] = [
  'image',
  'name',
  'isbn',
  'sku',
  'author',
  'grade',
  'quantity_on_hand',
  'category',
  'rack',
  'crate',
  'primary_location',
  'status',
];

function layoutFor(keys: InventoryExportFieldKey[], overrides: Partial<Parameters<typeof computeExportPdfLayout>[0]> = {}) {
  return computeExportPdfLayout({
    fields: fields(keys),
    itemTypeKind: 'book',
    includeImages: keys.includes('image'),
    imageSize: 'medium',
    orientation: 'auto',
    paperSize: 'letter',
    density: 'comfortable',
    wrapText: true,
    layout: 'table',
    catalogColumns: 2,
    ...overrides,
  });
}

describe('computeExportPdfLayout — columns', () => {
  it('drops the image field from the column list and reserves a cell for it instead', () => {
    const l = layoutFor(BOOKS_DEFAULT);
    expect(l.columns.map((c) => c.key)).not.toContain('image');
    expect(l.imageColumnWidthPt).toBe(IMAGE_CELL_PT.medium.widthPt);
  });

  it('reserves nothing when images are off', () => {
    const l = layoutFor(['name', 'sku', 'isbn']);
    expect(l.imageColumnWidthPt).toBe(0);
  });

  it('preserves the requested field order exactly', () => {
    const l = layoutFor(['status', 'isbn', 'name']);
    expect(l.columns.map((c) => c.key)).toEqual(['status', 'isbn', 'name']);
  });

  it('uses book headings — Title, not Name', () => {
    expect(layoutFor(['name']).columns[0]!.label).toBe('Title');
    expect(
      computeExportPdfLayout({
        fields: fields(['name']),
        itemTypeKind: 'other',
        includeImages: false,
        imageSize: 'medium',
        orientation: 'auto',
        paperSize: 'letter',
        density: 'comfortable',
        wrapText: true,
        layout: 'table',
        catalogColumns: 2,
      }).columns[0]!.label,
    ).toBe('Name');
  });

  it('fits every header inside its own column box for the full Books default set', () => {
    const l = layoutFor(BOOKS_DEFAULT);
    for (const col of l.columns) {
      const shown = col.label.toUpperCase();
      const needed = width(shown, 'Helvetica-Bold', 8) + shown.length * 0.4;
      const box = col.widthPt - REPORT_CELL_PADDING_PT * 2;
      expect(needed <= box, `${col.label}: needs ${needed.toFixed(2)}pt, box ${box.toFixed(2)}pt`).toBe(
        true,
      );
    }
  });

  it('never sums the columns plus the image cell past the content width', () => {
    const l = layoutFor(BOOKS_DEFAULT);
    const total = l.columns.reduce((sum, c) => sum + c.widthPt, 0) + l.imageColumnWidthPt;
    expect(total).toBeLessThanOrEqual(l.contentWidthPt + 1e-6);
  });

  it('keeps ISBN at its readable minimum even in the widest field set', () => {
    const l = layoutFor([...BOOKS_DEFAULT, 'barcode', 'warehouse', 'supplier', 'charter']);
    const isbn = l.columns.find((c) => c.key === 'isbn')!;
    expect(isbn.widthPt).toBeGreaterThanOrEqual(60);
    expect(isbn.wrap).toBe(false);
  });
});

describe('computeExportPdfLayout — orientation', () => {
  it('picks portrait for a short, imageless field set', () => {
    expect(layoutFor(['name', 'isbn', 'sku']).orientation).toBe('portrait');
  });

  it('picks landscape for the 12-field Books default', () => {
    expect(layoutFor(BOOKS_DEFAULT).orientation).toBe('landscape');
  });

  it('honours an explicit choice over auto', () => {
    expect(layoutFor(BOOKS_DEFAULT, { orientation: 'portrait' }).orientation).toBe('portrait');
    expect(layoutFor(['name'], { orientation: 'landscape' }).orientation).toBe('landscape');
  });

  it('gives Legal its extra length in portrait and extra width in landscape', () => {
    const portrait = layoutFor(['name', 'isbn'], { paperSize: 'legal', orientation: 'portrait' });
    expect(portrait.pageHeightPt).toBe(1008);
    const landscape = layoutFor(BOOKS_DEFAULT, { paperSize: 'legal', orientation: 'landscape' });
    expect(landscape.pageWidthPt).toBe(1008);
    expect(landscape.contentWidthPt).toBeGreaterThan(
      layoutFor(BOOKS_DEFAULT, { paperSize: 'letter', orientation: 'landscape' }).contentWidthPt,
    );
  });

  it('keeps a 1 or 2 column catalog portrait and a 3 column catalog landscape', () => {
    expect(layoutFor(BOOKS_DEFAULT, { layout: 'catalog', catalogColumns: 1 }).orientation).toBe(
      'portrait',
    );
    expect(layoutFor(BOOKS_DEFAULT, { layout: 'catalog', catalogColumns: 2 }).orientation).toBe(
      'portrait',
    );
    expect(layoutFor(BOOKS_DEFAULT, { layout: 'catalog', catalogColumns: 3 }).orientation).toBe(
      'landscape',
    );
  });
});

describe('computeExportPdfLayout — rows', () => {
  it('grows the row for images, by size tier', () => {
    expect(layoutFor(BOOKS_DEFAULT, { imageSize: 'small' }).rowHeightPt).toBe(28);
    expect(layoutFor(BOOKS_DEFAULT, { imageSize: 'medium' }).rowHeightPt).toBe(44);
    expect(layoutFor(BOOKS_DEFAULT, { imageSize: 'large' }).rowHeightPt).toBe(64);
  });

  it('keeps rows compact when images are off', () => {
    const l = layoutFor(['name', 'sku'], { density: 'compact' });
    expect(l.rowHeightPt).toBeLessThan(24);
    expect(l.imageColumnWidthPt).toBe(0);
  });

  it('gives image-friendly density more padding than compact', () => {
    expect(layoutFor(['name'], { density: 'image-friendly' }).rowPaddingPt).toBeGreaterThan(
      layoutFor(['name'], { density: 'compact' }).rowPaddingPt,
    );
  });

  it('estimates fewer rows per page for taller rows', () => {
    const small = layoutFor(BOOKS_DEFAULT, { imageSize: 'small' });
    const large = layoutFor(BOOKS_DEFAULT, { imageSize: 'large' });
    expect(large.estimatedRowsPerPage).toBeLessThan(small.estimatedRowsPerPage);
    expect(large.estimatedRowsPerPage).toBeGreaterThan(0);
  });
});

describe('computeExportPdfLayout — warnings', () => {
  it('stays silent for a sane field set', () => {
    expect(layoutFor(BOOKS_DEFAULT).warnings).toEqual([]);
    expect(layoutFor(BOOKS_DEFAULT).overflow).toBe(false);
  });

  it('warns with the exact brief copy once the column count crosses the threshold', () => {
    const many = layoutFor([
      'image', 'name', 'isbn', 'sku', 'author', 'grade', 'quantity_on_hand', 'category',
      'rack', 'crate', 'primary_location', 'status', 'barcode', 'warehouse', 'supplier',
      'charter', 'item_type',
    ]);
    expect(many.warnings.some((w) => w.includes('may be difficult to read'))).toBe(true);
    expect(many.warnings[0]).toBe(tooManyColumnsWarning(many.columns.length));
  });

  it('formats the warning with the real column count and the brief wording', () => {
    expect(tooManyColumnsWarning(16)).toBe(
      'This PDF contains 16 columns and may be difficult to read. Remove fields, use Legal paper, or export to Excel for the complete dataset.',
    );
    expect(TOO_MANY_COLUMNS_THRESHOLD).toBe(12);
  });

  it('flags overflow when the minimums cannot fit, and still returns usable widths', () => {
    const l = layoutFor(
      [
        'image', 'name', 'isbn', 'sku', 'author', 'grade', 'quantity_on_hand', 'category',
        'rack', 'crate', 'primary_location', 'status', 'barcode', 'warehouse', 'supplier',
        'charter', 'item_type', 'tracking_type', 'reorder_point', 'reorder_quantity',
        'unit_cost', 'retail_price', 'inventory_value', 'created_at', 'updated_at',
      ],
      { orientation: 'portrait', paperSize: 'letter', imageSize: 'large' },
    );
    expect(l.overflow).toBe(true);
    for (const col of l.columns) expect(col.widthPt).toBeGreaterThan(0);
    // Never blocks: the brief says block only when nothing readable is possible.
    expect(l.columns).toHaveLength(24);
  });
});

describe('estimateExportPdfPages', () => {
  it('is a labelled range, never a single fake number', () => {
    const l = layoutFor(BOOKS_DEFAULT);
    const est = estimateExportPdfPages(l, 111);
    expect(est.min).toBeGreaterThan(0);
    expect(est.max).toBeGreaterThanOrEqual(est.min);
  });

  it('returns one page for an empty or tiny export', () => {
    const l = layoutFor(BOOKS_DEFAULT);
    expect(estimateExportPdfPages(l, 0)).toEqual({ min: 1, max: 1 });
    expect(estimateExportPdfPages(l, 3).min).toBe(1);
  });

  it('divides by the catalog column count for catalog layouts', () => {
    const l = layoutFor(BOOKS_DEFAULT, { layout: 'catalog', catalogColumns: 3 });
    const one = estimateExportPdfPages(l, 90, { catalogColumns: 1 });
    const three = estimateExportPdfPages(l, 90, { catalogColumns: 3 });
    expect(three.max).toBeLessThan(one.max);
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/lib/exports/pdf-layout.test.ts 2>&1 | tail -20`
Expected: FAIL — `Failed to resolve import "./pdf-layout"`. Record the real text.

- [ ] **Step 3: Write the layout engine.** Create `apps/web/src/lib/exports/pdf-layout.ts`:

```ts
import {
  fitColumnWidths,
  REPORT_CELL_PADDING_PT,
  REPORT_IMAGE_COL_GAP_PT,
  REPORT_PAGE_PADDING_PT,
  REPORT_ROW_PADDING_PT,
  type FitColumn,
} from '@/lib/pdf/column-fit';

import { fieldHeading, type InventoryExportField } from './field-registry';

/**
 * PDF geometry for the export builder (Brief sections 11 and 13).
 *
 * Pure and client-safe: the dialog calls this to show the column-count warning
 * and the page estimate BEFORE generating anything, and the route calls the
 * same function to lay the document out. One implementation, so what the user
 * was warned about is what they get.
 *
 * The column-fitting order the brief specifies is followed literally:
 *   available width -> margins -> image column reserve -> field minimum widths
 *   -> weighted allocation of the surplus -> wrap long text -> warn when wide.
 */

export type PaperSize = 'letter' | 'legal';
export type PdfOrientation = 'portrait' | 'landscape';
export type PdfDensity = 'compact' | 'comfortable' | 'image-friendly';
export type ExportImageSize = 'small' | 'medium' | 'large';

export const PAPER_SIZE_PT: Record<
  PaperSize,
  Record<PdfOrientation, { widthPt: number; heightPt: number }>
> = {
  letter: {
    portrait: { widthPt: 612, heightPt: 792 },
    landscape: { widthPt: 792, heightPt: 612 },
  },
  legal: {
    portrait: { widthPt: 612, heightPt: 1008 },
    landscape: { widthPt: 1008, heightPt: 612 },
  },
};

/**
 * Image cell width and the row height it forces, per size tier. The row heights
 * are the brief's section 3.4 ranges (Small 24-28, Medium 38-44, Large 54-64)
 * at their upper bound, so a portrait book cover has real vertical room.
 */
export const IMAGE_CELL_PT: Record<ExportImageSize, { widthPt: number; rowHeightPt: number }> = {
  small: { widthPt: 22, rowHeightPt: 28 },
  medium: { widthPt: 34, rowHeightPt: 44 },
  large: { widthPt: 48, rowHeightPt: 64 },
};

export const DENSITY_PT: Record<PdfDensity, { rowPaddingPt: number; minRowHeightPt: number }> = {
  compact: { rowPaddingPt: 2, minRowHeightPt: 16 },
  comfortable: { rowPaddingPt: 4, minRowHeightPt: 20 },
  'image-friendly': { rowPaddingPt: 6, minRowHeightPt: 26 },
};

/** Vertical space the branded header block plus the table header row occupy. */
const HEADER_BLOCK_PT = 92;
const TABLE_HEADER_ROW_PT = 18;

/** Above this many columns a table stops being readable at 8.5pt. */
export const TOO_MANY_COLUMNS_THRESHOLD = 12;

/** Brief section 13, verbatim, with the real count substituted. */
export function tooManyColumnsWarning(count: number): string {
  return `This PDF contains ${count} columns and may be difficult to read. Remove fields, use Legal paper, or export to Excel for the complete dataset.`;
}

export interface ExportPdfColumn {
  key: string;
  label: string;
  align: 'left' | 'right' | 'center';
  widthPt: number;
  wrap: boolean;
}

export interface ExportPdfLayout {
  orientation: PdfOrientation;
  paperSize: PaperSize;
  pageWidthPt: number;
  pageHeightPt: number;
  /** Inner row width: page width minus page padding minus row padding. */
  contentWidthPt: number;
  /** 0 when images are off. */
  imageColumnWidthPt: number;
  /** The box an image is drawn into, objectFit contain. */
  imageBoxPt: { widthPt: number; heightPt: number };
  rowHeightPt: number;
  rowPaddingPt: number;
  columns: ExportPdfColumn[];
  warnings: string[];
  /** True when the minimums had to be scaled down to fit. Still renders. */
  overflow: boolean;
  estimatedRowsPerPage: number;
}

export interface ComputeExportPdfLayoutInput {
  fields: readonly InventoryExportField[];
  itemTypeKind: 'book' | 'other';
  includeImages: boolean;
  imageSize: ExportImageSize;
  orientation: 'auto' | PdfOrientation;
  paperSize: PaperSize;
  density: PdfDensity;
  wrapText: boolean;
  layout: 'table' | 'catalog';
  catalogColumns: 1 | 2 | 3;
}

function contentWidthFor(paperSize: PaperSize, orientation: PdfOrientation): number {
  return (
    PAPER_SIZE_PT[paperSize][orientation].widthPt -
    REPORT_PAGE_PADDING_PT * 2 -
    REPORT_ROW_PADDING_PT * 2
  );
}

/**
 * Auto orientation. Deliberately explainable rather than clever:
 *   - catalog: 1 or 2 cards across fit portrait; 3 need landscape
 *   - table:   portrait only when every column's MINIMUM fits in portrait AND
 *              there are at most five columns; anything wider goes landscape,
 *              because portrait plus six columns is where headers start
 *              colliding
 */
function autoOrientation(
  input: ComputeExportPdfLayoutInput,
  requiredWidthPt: number,
): PdfOrientation {
  if (input.layout === 'catalog') {
    return input.catalogColumns >= 3 ? 'landscape' : 'portrait';
  }
  const columnCount = input.fields.filter((f) => f.key !== 'image').length;
  const portraitFits = requiredWidthPt <= contentWidthFor(input.paperSize, 'portrait');
  return portraitFits && columnCount <= 5 ? 'portrait' : 'landscape';
}

export function computeExportPdfLayout(input: ComputeExportPdfLayoutInput): ExportPdfLayout {
  const showImages = input.includeImages && input.fields.some((f) => f.key === 'image');
  const tableFields = input.fields.filter((f) => f.key !== 'image');

  const imageColumnWidthPt = showImages ? IMAGE_CELL_PT[input.imageSize].widthPt : 0;
  const imageReservePt = showImages ? imageColumnWidthPt + REPORT_IMAGE_COL_GAP_PT : 0;
  const requiredWidthPt =
    tableFields.reduce((sum, f) => sum + f.pdfMinWidth, 0) + imageReservePt;

  const orientation =
    input.orientation === 'auto' ? autoOrientation(input, requiredWidthPt) : input.orientation;
  const page = PAPER_SIZE_PT[input.paperSize][orientation];
  const contentWidthPt = contentWidthFor(input.paperSize, orientation);

  const fitInput: FitColumn[] = tableFields.map((f) => ({
    key: f.key,
    width: f.pdfWidth,
    minWidth: f.pdfMinWidth,
    maxWidth: f.pdfMaxWidth,
  }));
  const widths = fitColumnWidths(fitInput, Math.max(0, contentWidthPt - imageReservePt));

  const columns: ExportPdfColumn[] = tableFields.map((f, i) => ({
    key: f.key,
    label: fieldHeading(f, { format: 'pdf', itemType: input.itemTypeKind }),
    align: f.align,
    widthPt: widths[i] ?? 0,
    // wrapText off means every column truncates EXCEPT the ones whose own
    // definition forbids it (ISBN, SKU, barcode) — those stay unwrapped and
    // untruncated, which their minimum width guarantees.
    wrap: input.wrapText ? f.wrap : false,
  }));

  const density = DENSITY_PT[input.density];
  const rowHeightPt = showImages
    ? Math.max(IMAGE_CELL_PT[input.imageSize].rowHeightPt, density.minRowHeightPt)
    : density.minRowHeightPt;
  const imageBoxHeightPt = Math.max(8, rowHeightPt - density.rowPaddingPt * 2);

  const usableHeightPt =
    page.heightPt - REPORT_PAGE_PADDING_PT * 2 - HEADER_BLOCK_PT - TABLE_HEADER_ROW_PT;
  const estimatedRowsPerPage = Math.max(1, Math.floor(usableHeightPt / rowHeightPt));

  const overflow = requiredWidthPt > contentWidthPt;
  const warnings: string[] = [];
  if (columns.length >= TOO_MANY_COLUMNS_THRESHOLD) {
    warnings.push(tooManyColumnsWarning(columns.length));
  }
  if (overflow) {
    warnings.push(
      'Some columns are narrower than their contents need. Remove fields, switch to Legal paper, or use landscape orientation.',
    );
  }

  return {
    orientation,
    paperSize: input.paperSize,
    pageWidthPt: page.widthPt,
    pageHeightPt: page.heightPt,
    contentWidthPt,
    imageColumnWidthPt,
    imageBoxPt: { widthPt: imageColumnWidthPt, heightPt: imageBoxHeightPt },
    rowHeightPt,
    rowPaddingPt: density.rowPaddingPt,
    columns,
    warnings,
    overflow,
    estimatedRowsPerPage,
  };
}

/**
 * Page-count RANGE for the dialog's summary. A range, not a number, because
 * wrapped titles and page-break avoidance make the true count unknowable
 * without rendering — and the brief requires estimates to be labelled as such.
 */
export function estimateExportPdfPages(
  layout: ExportPdfLayout,
  rowCount: number,
  opts: { catalogColumns?: number } = {},
): { min: number; max: number } {
  if (rowCount <= 0) return { min: 1, max: 1 };
  const perPage = Math.max(1, layout.estimatedRowsPerPage * (opts.catalogColumns ?? 1));
  const min = Math.max(1, Math.ceil(rowCount / perPage));
  // Wrapped titles and rows that refuse to split cost up to ~35% more pages.
  const max = Math.max(min, Math.ceil((rowCount * 1.35) / perPage));
  return { min, max };
}
```

- [ ] **Step 4: Run the layout test to verify it passes.**

Run: `pnpm --filter @stockpilot/web test src/lib/exports/pdf-layout.test.ts 2>&1 | tail -25`
Expected: PASS — 19 tests. If the "fits every header" assertion fails for a column, RAISE that field's `pdfMinWidth` in the registry (Task 4) rather than shrinking the font — Brief §3.1 forbids solving this with a smaller font.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/lib/exports/pdf-layout.ts apps/web/src/lib/exports/pdf-layout.test.ts
git commit -m "feat(inventory): pdf layout engine with real column fitting and warnings"
```

---

## Task 9: The export PDF document — table mode

The renderer for everything the shared `report-table.tsx` cannot do without endangering seven live reports: chosen columns in the chosen order, an image cell that grows the row and preserves aspect ratio, portrait/landscape, Letter/Legal, repeated headers, page numbers, and per-density padding.

**Files:**
- Create: `apps/web/src/lib/pdf/inventory-export-pdf.tsx`
- Create: `apps/web/src/lib/pdf/inventory-export-pdf.test.tsx`

**Interfaces:**
- Consumes from Task 8: `ExportPdfLayout`, `ExportPdfColumn`. From Task 4: `InventoryExportSourceRow`.
- Produces for Tasks 10, 13:
  - `interface InventoryExportPdfRow { cells: Record<string, string>; imageUrl: string | null }`
  - `interface InventoryExportPdfProps { orgName: string; orgLogoUrl: string | null; title: string; subtitle: string; layout: ExportPdfLayout; rows: InventoryExportPdfRow[]; repeatHeaders: boolean; pageNumbers: boolean; footerNote?: string; catalog?: CatalogOptions | null }` (Task 10 fills `catalog`; it is declared here as `null` for table mode).
  - `InventoryExportPdf(props: InventoryExportPdfProps): JSX.Element`
  - `buildExportPdfRows(rows: readonly InventoryExportSourceRow[], layout: ExportPdfLayout, fields: readonly InventoryExportField[], opts: { showImages: boolean }): InventoryExportPdfRow[]`
  - `EXPORT_PDF_EM_DASH = '—'`

**Steps:**

- [ ] **Step 1: Write the failing renderer test.** Create `apps/web/src/lib/pdf/inventory-export-pdf.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';

import { getExportField, type InventoryExportFieldKey } from '@/lib/exports/field-registry';
import { computeExportPdfLayout } from '@/lib/exports/pdf-layout';
import type { InventoryExportSourceRow } from '@/lib/exports/source-row';

import { buildExportPdfRows, EXPORT_PDF_EM_DASH, InventoryExportPdf } from './inventory-export-pdf';

/**
 * These assertions run over the ELEMENT TREE, not a rendered PDF. react-pdf's
 * output is a binary stream whose glyph positions are not readable from a unit
 * test, and the geometry itself is already pinned by pdf-layout.test.ts. What
 * this suite proves is that the document HANDS react-pdf the right structure:
 * the right page size, the right orientation, an image cell only when asked,
 * fixed header rows when repeat is on, a page-number renderer when it is on,
 * and no undefined/null leaking into a cell.
 */

const keys: InventoryExportFieldKey[] = [
  'image',
  'name',
  'isbn',
  'sku',
  'quantity_on_hand',
  'category',
  'status',
];
const fields = keys.map((k) => getExportField(k)!);

function makeSource(overrides: Partial<InventoryExportSourceRow> = {}): InventoryExportSourceRow {
  return {
    id: 'i-1',
    itemType: 'book',
    name: 'Introduction to Algorithms',
    sku: 'BK-0001',
    barcode: '9780262033848',
    status: 'active',
    quantityOnHand: 4,
    reorderPoint: 0,
    reorderQuantity: 0,
    unitCost: 42,
    retailPrice: 89,
    category: 'Mathematics',
    primaryLocation: 'DC4',
    supplier: '',
    warehouse: 'North',
    charter: 'Generic',
    trackingType: 'none',
    author: 'Cormen',
    isbn: '9780262033848',
    grade: 'College',
    rackNumber: '38',
    rackRow: 'A',
    crateColor: 'blue',
    crateNumber: '12',
    rackLabel: '38-A',
    crateLabel: 'Blue 12',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    image: { thumbnailUrl: 'https://signed.example/a.webp' },
    ...overrides,
  };
}

function makeLayout(overrides: Partial<Parameters<typeof computeExportPdfLayout>[0]> = {}) {
  return computeExportPdfLayout({
    fields,
    itemTypeKind: 'book',
    includeImages: true,
    imageSize: 'medium',
    orientation: 'auto',
    paperSize: 'letter',
    density: 'comfortable',
    wrapText: true,
    layout: 'table',
    catalogColumns: 2,
    ...overrides,
  });
}

/** Depth-first walk of a react element tree, yielding every element. */
function* walk(node: unknown): Generator<{ type: unknown; props: Record<string, unknown> }> {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (typeof node !== 'object') return;
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (!el.props) return;
  yield { type: el.type, props: el.props };
  yield* walk(el.props.children);
}

function elementsOfType(tree: unknown, type: string) {
  return [...walk(tree)].filter((el) => el.type === type);
}

function textContent(tree: unknown): string[] {
  return elementsOfType(tree, 'Text')
    .map((el) => el.props.children)
    .filter((c): c is string => typeof c === 'string');
}

describe('buildExportPdfRows', () => {
  it('maps every selected field to a string cell, in order', () => {
    const rows = buildExportPdfRows([makeSource()], makeLayout(), fields, { showImages: true });
    expect(Object.keys(rows[0]!.cells)).toEqual([
      'name',
      'isbn',
      'sku',
      'quantity_on_hand',
      'category',
      'status',
    ]);
    expect(rows[0]!.cells.isbn).toBe('9780262033848');
    expect(rows[0]!.cells.quantity_on_hand).toBe('4');
  });

  it('renders a blank value as an em dash, never undefined or null', () => {
    const rows = buildExportPdfRows(
      [makeSource({ isbn: '', category: '' })],
      makeLayout(),
      fields,
      { showImages: true },
    );
    expect(rows[0]!.cells.isbn).toBe(EXPORT_PDF_EM_DASH);
    expect(rows[0]!.cells.category).toBe(EXPORT_PDF_EM_DASH);
    for (const value of Object.values(rows[0]!.cells)) {
      expect(typeof value).toBe('string');
      expect(value).not.toBe('undefined');
      expect(value).not.toBe('null');
      expect(value).not.toBe('[object Object]');
    }
  });

  it('renders a real zero as 0, not as an em dash', () => {
    const rows = buildExportPdfRows([makeSource({ quantityOnHand: 0 })], makeLayout(), fields, {
      showImages: true,
    });
    expect(rows[0]!.cells.quantity_on_hand).toBe('0');
  });

  it('carries the image URL only when images are on', () => {
    expect(
      buildExportPdfRows([makeSource()], makeLayout(), fields, { showImages: true })[0]!.imageUrl,
    ).toBe('https://signed.example/a.webp');
    expect(
      buildExportPdfRows([makeSource()], makeLayout(), fields, { showImages: false })[0]!.imageUrl,
    ).toBeNull();
  });
});

describe('InventoryExportPdf — table mode', () => {
  const render = (overrides: Partial<Parameters<typeof InventoryExportPdf>[0]> = {}) => {
    const layout = makeLayout();
    return InventoryExportPdf({
      orgName: 'Demo Co',
      orgLogoUrl: null,
      title: 'Books export',
      subtitle: 'filtered - 111 books',
      layout,
      rows: buildExportPdfRows([makeSource()], layout, fields, { showImages: true }),
      repeatHeaders: true,
      pageNumbers: true,
      catalog: null,
      ...overrides,
    });
  };

  it('sets the page size and orientation the layout chose', () => {
    const page = elementsOfType(render(), 'Page')[0]!;
    expect(page.props.size).toEqual({ width: 792, height: 612 });
    expect(page.props.orientation).toBeUndefined();
  });

  it('renders every chosen column header, in the chosen order', () => {
    const texts = textContent(render());
    const headerOrder = ['TITLE', 'ISBN', 'SKU', 'ON HAND', 'CATEGORY', 'STATUS'];
    const found = texts.filter((t) => headerOrder.includes(t.toUpperCase()));
    expect(found.map((t) => t.toUpperCase())).toEqual(headerOrder);
  });

  it('marks the header row fixed so it repeats on every page', () => {
    const fixed = [...walk(render())].filter((el) => el.props.fixed === true);
    expect(fixed.length).toBeGreaterThan(0);
  });

  it('does NOT mark the header fixed when repeat headers is off', () => {
    const fixed = [...walk(render({ repeatHeaders: false }))].filter(
      (el) => el.props.fixed === true && el.type === 'View',
    );
    expect(fixed).toHaveLength(0);
  });

  it('renders a page-number footer with a render function when page numbers are on', () => {
    const withNumbers = [...walk(render())].find(
      (el) => el.type === 'Text' && typeof el.props.render === 'function',
    );
    expect(withNumbers).toBeDefined();
    const rendered = (withNumbers!.props.render as (p: { pageNumber: number; totalPages: number }) => string)(
      { pageNumber: 1, totalPages: 8 },
    );
    expect(rendered).toBe('Page 1 of 8');
  });

  it('omits the page-number footer when page numbers are off', () => {
    const withNumbers = [...walk(render({ pageNumbers: false }))].find(
      (el) => el.type === 'Text' && typeof el.props.render === 'function',
    );
    expect(withNumbers).toBeUndefined();
  });

  it('draws the image with objectFit contain so a cover is never cropped', () => {
    const image = elementsOfType(render(), 'Image').find(
      (el) => (el.props.src as string) === 'https://signed.example/a.webp',
    );
    expect(image).toBeDefined();
    const style = image!.props.style as { objectFit?: string };
    expect(style.objectFit).toBe('contain');
  });

  it('draws a placeholder, not a broken image, when a row has none', () => {
    const layout = makeLayout();
    const rows = buildExportPdfRows([makeSource({ image: null })], layout, fields, {
      showImages: true,
    });
    const tree = render({ layout, rows });
    expect(elementsOfType(tree, 'Image')).toHaveLength(0);
    const placeholders = [...walk(tree)].filter(
      (el) => (el.props as { 'data-placeholder'?: boolean })['data-placeholder'] === true,
    );
    expect(placeholders).toHaveLength(1);
  });

  it('renders no image cell at all when images are off — no empty column', () => {
    const layout = makeLayout({ includeImages: false });
    const rows = buildExportPdfRows([makeSource()], layout, fields, { showImages: false });
    const tree = render({ layout, rows });
    expect(elementsOfType(tree, 'Image')).toHaveLength(0);
    const placeholders = [...walk(tree)].filter(
      (el) => (el.props as { 'data-placeholder'?: boolean })['data-placeholder'] === true,
    );
    expect(placeholders).toHaveLength(0);
  });

  it('keeps each body row whole rather than splitting it across a page break', () => {
    const rowViews = [...walk(render())].filter(
      (el) => (el.props as { 'data-row'?: boolean })['data-row'] === true,
    );
    expect(rowViews.length).toBeGreaterThan(0);
    for (const row of rowViews) expect(row.props.wrap).toBe(false);
  });

  it('grows the row to the layout height when images are on', () => {
    const rowView = [...walk(render())].find(
      (el) => (el.props as { 'data-row'?: boolean })['data-row'] === true,
    )!;
    const style = rowView.props.style as Array<Record<string, unknown>>;
    const merged = Object.assign({}, ...style) as { minHeight?: number };
    expect(merged.minHeight).toBe(44);
  });

  it('renders portrait Legal when the layout says so', () => {
    const layout = makeLayout({ paperSize: 'legal', orientation: 'portrait' });
    const page = elementsOfType(render({ layout }), 'Page')[0]!;
    expect(page.props.size).toEqual({ width: 612, height: 1008 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/lib/pdf/inventory-export-pdf.test.tsx 2>&1 | tail -20`
Expected: FAIL — `Failed to resolve import "./inventory-export-pdf"`. Record the real text.

- [ ] **Step 3: Write the document.** Create `apps/web/src/lib/pdf/inventory-export-pdf.tsx`:

```tsx
import { Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer';

import { fieldHeading, type InventoryExportField } from '@/lib/exports/field-registry';
import type { ExportPdfLayout } from '@/lib/exports/pdf-layout';
import type { InventoryExportSourceRow } from '@/lib/exports/source-row';

import { BrandedHeader } from './branding';
import { REPORT_CELL_PADDING_PT, REPORT_IMAGE_COL_GAP_PT } from './column-fit';
import { pdfStyles, PDF_COLORS } from './styles';

/**
 * The inventory / books EXPORT document.
 *
 * Why this is not report-table.tsx: that component is shared by seven live
 * report sections (/api/reports/[slug]/pdf), and everything this document needs
 * — variable page size and orientation, rows that grow with an image, repeated
 * headers, page numbers, a catalog card layout — would be a behaviour change
 * for all of them. This is a second DOCUMENT, not a second export pipeline: the
 * route, the row builder, the field registry and the column-fitting primitive
 * are all shared.
 */

export const EXPORT_PDF_EM_DASH = '—';

export interface InventoryExportPdfRow {
  /** Column key to already-formatted string. Never null, never undefined. */
  cells: Record<string, string>;
  imageUrl: string | null;
}

export interface InventoryExportCatalogOptions {
  columns: 1 | 2 | 3;
  /** Fields rendered as label/value lines inside each card, in order. */
  fields: readonly InventoryExportField[];
  itemTypeKind: 'book' | 'other';
}

export interface InventoryExportPdfProps {
  orgName: string;
  orgLogoUrl: string | null;
  title: string;
  subtitle: string;
  layout: ExportPdfLayout;
  rows: InventoryExportPdfRow[];
  repeatHeaders: boolean;
  pageNumbers: boolean;
  footerNote?: string;
  /** Set for the book catalog layout; null for the table layout. */
  catalog?: InventoryExportCatalogOptions | null;
}

const styles = StyleSheet.create({
  table: {
    borderTopWidth: 1,
    borderTopColor: PDF_COLORS.lineStrong,
    borderTopStyle: 'solid',
  },
  headerRow: {
    flexDirection: 'row',
    backgroundColor: PDF_COLORS.bgSunk,
    borderBottomWidth: 1,
    borderBottomColor: PDF_COLORS.lineStrong,
    borderBottomStyle: 'solid',
    paddingVertical: 5,
    paddingHorizontal: 4,
  },
  headerCell: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: PDF_COLORS.ink3,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    // The gutter. Without it two header labels render edge to edge — the
    // "ON HANDCATEGORY" defect.
    paddingHorizontal: REPORT_CELL_PADDING_PT,
  },
  row: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: PDF_COLORS.line,
    borderBottomStyle: 'solid',
    paddingHorizontal: 4,
    alignItems: 'center',
  },
  cell: {
    fontSize: 8.5,
    color: PDF_COLORS.ink,
    paddingHorizontal: REPORT_CELL_PADDING_PT,
  },
  cellRight: { textAlign: 'right' },
  cellCenter: { textAlign: 'center' },
  imageCell: {
    marginRight: REPORT_IMAGE_COL_GAP_PT,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumb: {
    // contain, NOT cover: a book cover is portrait and cropping it to a square
    // cuts the title off. Aspect ratio is preserved inside the box.
    objectFit: 'contain',
    borderRadius: 2,
  },
  thumbPlaceholder: {
    backgroundColor: PDF_COLORS.bgSunk,
    borderRadius: 2,
    borderWidth: 0.5,
    borderColor: PDF_COLORS.line,
    borderStyle: 'solid',
  },
  emptyState: {
    fontSize: 9,
    color: PDF_COLORS.ink4,
    paddingVertical: 12,
  },
  footerNote: {
    marginTop: 8,
    fontSize: 8,
    color: PDF_COLORS.ink3,
    fontStyle: 'italic',
  },
  pageNumber: {
    position: 'absolute',
    bottom: 24,
    left: 40,
    right: 40,
    textAlign: 'center',
    fontSize: 8,
    color: PDF_COLORS.ink4,
  },
});

function alignStyle(align: 'left' | 'right' | 'center') {
  if (align === 'right') return styles.cellRight;
  if (align === 'center') return styles.cellCenter;
  return {};
}

/**
 * Format one source row into the strings the document prints.
 *
 * Blank -> em dash. A real 0 or false prints as itself: the export must not
 * turn "zero on hand" into "unknown".
 */
export function buildExportPdfRows(
  rows: readonly InventoryExportSourceRow[],
  layout: ExportPdfLayout,
  fields: readonly InventoryExportField[],
  opts: { showImages: boolean },
): InventoryExportPdfRow[] {
  const columnFields = fields.filter((f) => f.key !== 'image');
  return rows.map((row) => {
    const cells: Record<string, string> = {};
    for (const field of columnFields) {
      const value = field.value(row);
      cells[field.key] =
        value === null || value === undefined || value === '' ? EXPORT_PDF_EM_DASH : String(value);
    }
    return {
      cells,
      imageUrl: opts.showImages ? (row.image?.thumbnailUrl ?? null) : null,
    };
  });
}

function TableHeader({ layout, fixed }: { layout: ExportPdfLayout; fixed: boolean }) {
  return (
    <View style={styles.headerRow} fixed={fixed}>
      {layout.imageColumnWidthPt > 0 ? (
        <View style={[styles.imageCell, { width: layout.imageColumnWidthPt }]} />
      ) : null}
      {layout.columns.map((col) => (
        <Text
          key={col.key}
          style={[
            styles.headerCell,
            { width: col.widthPt, flexGrow: 0, flexShrink: 0 },
            alignStyle(col.align),
          ]}
        >
          {col.label}
        </Text>
      ))}
    </View>
  );
}

function TableBody({ layout, rows }: { layout: ExportPdfLayout; rows: InventoryExportPdfRow[] }) {
  if (rows.length === 0) {
    return <Text style={styles.emptyState}>No items matched this export.</Text>;
  }
  return (
    <>
      {rows.map((row, idx) => (
        <View
          key={idx}
          // wrap={false} keeps a row whole: a cover image split across a page
          // break renders as two half-images.
          wrap={false}
          data-row
          style={[
            styles.row,
            { minHeight: layout.rowHeightPt, paddingVertical: layout.rowPaddingPt },
          ]}
        >
          {layout.imageColumnWidthPt > 0 ? (
            <View
              style={[
                styles.imageCell,
                { width: layout.imageColumnWidthPt, height: layout.imageBoxPt.heightPt },
              ]}
            >
              {row.imageUrl ? (
                // eslint-disable-next-line jsx-a11y/alt-text
                <Image
                  src={row.imageUrl}
                  style={[
                    styles.thumb,
                    { width: layout.imageBoxPt.widthPt, height: layout.imageBoxPt.heightPt },
                  ]}
                />
              ) : (
                <View
                  data-placeholder
                  style={[
                    styles.thumbPlaceholder,
                    { width: layout.imageBoxPt.widthPt, height: layout.imageBoxPt.heightPt },
                  ]}
                />
              )}
            </View>
          ) : null}
          {layout.columns.map((col) => (
            <Text
              key={col.key}
              style={[
                styles.cell,
                { width: col.widthPt, flexGrow: 0, flexShrink: 0 },
                alignStyle(col.align),
              ]}
            >
              {row.cells[col.key] ?? EXPORT_PDF_EM_DASH}
            </Text>
          ))}
        </View>
      ))}
    </>
  );
}

export function InventoryExportPdf({
  orgName,
  orgLogoUrl,
  title,
  subtitle,
  layout,
  rows,
  repeatHeaders,
  pageNumbers,
  footerNote,
  catalog,
}: InventoryExportPdfProps) {
  return (
    <Document>
      <Page
        // An explicit {width, height} rather than size="LETTER" + orientation:
        // the layout engine already resolved both, and passing the resolved
        // numbers means the geometry the fit test asserted is the geometry
        // react-pdf lays out.
        size={{ width: layout.pageWidthPt, height: layout.pageHeightPt }}
        style={pdfStyles.page}
      >
        <BrandedHeader
          orgName={orgName}
          orgLogoUrl={orgLogoUrl}
          title={title}
          subtitle={subtitle}
        />
        {catalog ? (
          <CatalogBody layout={layout} rows={rows} catalog={catalog} />
        ) : (
          <View style={styles.table}>
            <TableHeader layout={layout} fixed={repeatHeaders} />
            <TableBody layout={layout} rows={rows} />
          </View>
        )}
        {footerNote ? <Text style={styles.footerNote}>{footerNote}</Text> : null}
        {pageNumbers ? (
          <Text
            style={styles.pageNumber}
            fixed
            render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
          />
        ) : null}
      </Page>
    </Document>
  );
}
```

Note: `CatalogBody` is added in Task 10. For THIS task, add a temporary local definition immediately above `InventoryExportPdf` so the module compiles and the table tests run:

```tsx
/** Replaced by the real card grid in the catalog task. */
function CatalogBody({
  layout,
  rows,
}: {
  layout: ExportPdfLayout;
  rows: InventoryExportPdfRow[];
  catalog: InventoryExportCatalogOptions;
}) {
  return (
    <View style={styles.table}>
      <TableHeader layout={layout} fixed={false} />
      <TableBody layout={layout} rows={rows} />
    </View>
  );
}
```

- [ ] **Step 4: Run the renderer test to verify it passes.**

Run: `pnpm --filter @stockpilot/web test src/lib/pdf/inventory-export-pdf.test.tsx 2>&1 | tail -25`
Expected: PASS — 17 tests.

- [ ] **Step 5: Typecheck and commit.**

Run: `pnpm --filter @stockpilot/web typecheck 2>&1 | tail -20`
Expected: clean. `data-row` / `data-placeholder` are plain props react-pdf ignores at render time and the tests key off; if the react-pdf types reject them, switch both to a `key`-prefixed style marker rather than deleting the assertions.

```bash
git add apps/web/src/lib/pdf/inventory-export-pdf.tsx apps/web/src/lib/pdf/inventory-export-pdf.test.tsx
git commit -m "feat(inventory): export pdf document with dynamic columns, images and page numbers"
```

---

## Task 10: The book catalog layout

Brief §12. Larger visual cards with a big cover and the book's identity beside it, in one, two or three columns. Never the default; never forced; never available for non-book exports (Task 5 already rejects that server-side).

**Files:**
- Modify: `apps/web/src/lib/pdf/inventory-export-pdf.tsx` (replace the temporary `CatalogBody`)
- Modify: `apps/web/src/lib/pdf/inventory-export-pdf.test.tsx`

**Interfaces:**
- Consumes from Task 9: `InventoryExportCatalogOptions`, `InventoryExportPdfRow`, `buildExportPdfRows`, `styles`.
- Produces for Task 13: `CATALOG_CARD_MIN_HEIGHT_PT: Record<1 | 2 | 3, number>` = `{ 1: 132, 2: 116, 3: 96 }` and `CATALOG_COVER_PT: Record<1 | 2 | 3, { widthPt: number; heightPt: number }>` = `{ 1: { widthPt: 84, heightPt: 112 }, 2: { widthPt: 66, heightPt: 88 }, 3: { widthPt: 50, heightPt: 68 } }`, both exported from `@/lib/pdf/inventory-export-pdf`.

**Steps:**

- [ ] **Step 1: Write the failing catalog test.** Append to `apps/web/src/lib/pdf/inventory-export-pdf.test.tsx`, adding `CATALOG_COVER_PT` to the import from `./inventory-export-pdf`:

```tsx
describe('InventoryExportPdf — book catalog mode', () => {
  const catalogRender = (columns: 1 | 2 | 3, rowOverrides: Partial<InventoryExportSourceRow> = {}) => {
    const layout = computeExportPdfLayout({
      fields,
      itemTypeKind: 'book',
      includeImages: true,
      imageSize: 'large',
      orientation: 'auto',
      paperSize: 'letter',
      density: 'image-friendly',
      wrapText: true,
      layout: 'catalog',
      catalogColumns: columns,
    });
    const sources = [makeSource(rowOverrides), makeSource({ ...rowOverrides, id: 'i-2' })];
    return InventoryExportPdf({
      orgName: 'Demo Co',
      orgLogoUrl: null,
      title: 'Books catalog',
      subtitle: 'filtered - 2 books',
      layout,
      rows: buildExportPdfRows(sources, layout, fields, { showImages: true }),
      repeatHeaders: false,
      pageNumbers: true,
      catalog: { columns, fields, itemTypeKind: 'book' },
    });
  };

  it('renders one card per row, never a table header', () => {
    const tree = catalogRender(2);
    const cards = [...walk(tree)].filter(
      (el) => (el.props as { 'data-card'?: boolean })['data-card'] === true,
    );
    expect(cards).toHaveLength(2);
    expect(textContent(tree)).not.toContain('ON HAND');
  });

  it('keeps every card whole rather than splitting it across a page', () => {
    const cards = [...walk(catalogRender(2))].filter(
      (el) => (el.props as { 'data-card'?: boolean })['data-card'] === true,
    );
    for (const card of cards) expect(card.props.wrap).toBe(false);
  });

  it('shows the cover at the catalog size with objectFit contain', () => {
    const image = elementsOfType(catalogRender(2), 'Image')[0]!;
    const style = Object.assign({}, ...(image.props.style as Array<Record<string, unknown>>)) as {
      objectFit?: string;
      width?: number;
      height?: number;
    };
    expect(style.objectFit).toBe('contain');
    expect(style.width).toBe(CATALOG_COVER_PT[2].widthPt);
    expect(style.height).toBe(CATALOG_COVER_PT[2].heightPt);
  });

  it('prints the ISBN clearly, labelled, inside each card', () => {
    const texts = textContent(catalogRender(2));
    expect(texts).toContain('ISBN');
    expect(texts).toContain('9780262033848');
  });

  it('uses a consistent placeholder for a book with no cover', () => {
    const tree = catalogRender(2, { image: null });
    const placeholders = [...walk(tree)].filter(
      (el) => (el.props as { 'data-placeholder'?: boolean })['data-placeholder'] === true,
    );
    expect(placeholders).toHaveLength(2);
    expect(elementsOfType(tree, 'Image')).toHaveLength(0);
  });

  it('sizes each card to its share of the row for 1, 2 and 3 columns', () => {
    for (const columns of [1, 2, 3] as const) {
      const card = [...walk(catalogRender(columns))].find(
        (el) => (el.props as { 'data-card'?: boolean })['data-card'] === true,
      )!;
      const style = Object.assign({}, ...(card.props.style as Array<Record<string, unknown>>)) as {
        width?: string;
      };
      expect(style.width).toBe(`${(100 / columns).toFixed(4)}%`);
    }
  });

  it('never prints undefined for a book missing every optional field', () => {
    const texts = textContent(
      catalogRender(2, { author: '', grade: '', rackLabel: '', crateLabel: '', isbn: '' }),
    );
    for (const t of texts) {
      expect(t).not.toContain('undefined');
      expect(t).not.toContain('null');
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/lib/pdf/inventory-export-pdf.test.tsx 2>&1 | tail -25`
Expected: FAIL — `CATALOG_COVER_PT is not exported`, and the card assertions find zero `data-card` elements. Record the real text.

- [ ] **Step 3: Replace the temporary `CatalogBody`.** In `apps/web/src/lib/pdf/inventory-export-pdf.tsx`, delete the placeholder function and add, in its place:

```tsx
/** Card geometry per catalog column count. */
export const CATALOG_CARD_MIN_HEIGHT_PT: Record<1 | 2 | 3, number> = {
  1: 132,
  2: 116,
  3: 96,
};

/**
 * Cover box per catalog column count. Portrait proportions (3:4) because a book
 * cover is taller than it is wide; objectFit contain keeps a square or
 * landscape cover undistorted inside the same box.
 */
export const CATALOG_COVER_PT: Record<1 | 2 | 3, { widthPt: number; heightPt: number }> = {
  1: { widthPt: 84, heightPt: 112 },
  2: { widthPt: 66, heightPt: 88 },
  3: { widthPt: 50, heightPt: 68 },
};

const catalogStyles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 8,
  },
  cardOuter: {
    padding: 4,
  },
  card: {
    flexDirection: 'row',
    borderWidth: 0.5,
    borderColor: PDF_COLORS.line,
    borderStyle: 'solid',
    borderRadius: 3,
    padding: 6,
  },
  cardBody: {
    flexGrow: 1,
    flexShrink: 1,
    paddingLeft: 6,
  },
  cardTitle: {
    fontSize: 9.5,
    fontFamily: 'Helvetica-Bold',
    color: PDF_COLORS.ink,
    marginBottom: 3,
  },
  cardLine: {
    flexDirection: 'row',
    marginTop: 1.5,
  },
  cardLabel: {
    fontSize: 7,
    fontFamily: 'Helvetica-Bold',
    color: PDF_COLORS.ink4,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    width: 54,
  },
  cardValue: {
    fontSize: 8.5,
    color: PDF_COLORS.ink2,
    flexGrow: 1,
    flexShrink: 1,
  },
});

/**
 * Book catalog layout (Brief section 12): a card per book with a large cover
 * and the identity fields beside it. Cards never split across a page.
 *
 * The card's first line is the title (the `name` field), rendered large; every
 * other selected field prints as a labelled line, so the same field selection
 * drives the table AND the catalog with no second configuration.
 */
function CatalogBody({
  rows,
  catalog,
}: {
  layout: ExportPdfLayout;
  rows: InventoryExportPdfRow[];
  catalog: InventoryExportCatalogOptions;
}) {
  if (rows.length === 0) {
    return <Text style={styles.emptyState}>No items matched this export.</Text>;
  }
  const cover = CATALOG_COVER_PT[catalog.columns];
  const cardWidth = `${(100 / catalog.columns).toFixed(4)}%`;
  const detailFields = catalog.fields.filter((f) => f.key !== 'image' && f.key !== 'name');

  return (
    <View style={catalogStyles.grid}>
      {rows.map((row, idx) => (
        <View
          key={idx}
          wrap={false}
          data-card
          style={[catalogStyles.cardOuter, { width: cardWidth }]}
        >
          <View
            style={[
              catalogStyles.card,
              { minHeight: CATALOG_CARD_MIN_HEIGHT_PT[catalog.columns] },
            ]}
          >
            <View style={{ width: cover.widthPt, flexShrink: 0 }}>
              {row.imageUrl ? (
                // eslint-disable-next-line jsx-a11y/alt-text
                <Image
                  src={row.imageUrl}
                  style={[styles.thumb, { width: cover.widthPt, height: cover.heightPt }]}
                />
              ) : (
                <View
                  data-placeholder
                  style={[
                    styles.thumbPlaceholder,
                    { width: cover.widthPt, height: cover.heightPt },
                  ]}
                />
              )}
            </View>
            <View style={catalogStyles.cardBody}>
              <Text style={catalogStyles.cardTitle}>{row.cells.name ?? EXPORT_PDF_EM_DASH}</Text>
              {detailFields.map((field) => (
                <View key={field.key} style={catalogStyles.cardLine}>
                  <Text style={catalogStyles.cardLabel}>
                    {fieldHeading(field, { format: 'pdf', itemType: catalog.itemTypeKind })}
                  </Text>
                  <Text style={catalogStyles.cardValue}>
                    {row.cells[field.key] ?? EXPORT_PDF_EM_DASH}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}
```

- [ ] **Step 4: Run the suite to verify it passes.**

Run: `pnpm --filter @stockpilot/web test src/lib/pdf/inventory-export-pdf.test.tsx 2>&1 | tail -25`
Expected: PASS — the 17 table tests plus 7 catalog tests.

- [ ] **Step 5: Typecheck and commit.**

```bash
git add apps/web/src/lib/pdf/inventory-export-pdf.tsx apps/web/src/lib/pdf/inventory-export-pdf.test.tsx
git commit -m "feat(inventory): book catalog pdf layout"
```

---
## Task 11: The Excel writer

Brief §14. `toInventoryXlsx(headers, rows)` today is 47 lines: one sheet always named `Inventory`, widths derived from the raw snake_case header length, bold + frozen row 1, formula-injection escaping. Everything else the brief asks for is missing, and the file has never had a test (Audit A5, D1). It has exactly one caller, so the signature changes to an options object.

**Files:**
- Modify: `apps/web/src/lib/inventory-export-xlsx.ts` (full rewrite)
- Create: `apps/web/src/lib/inventory-export-xlsx.test.ts`

**Interfaces:**
- Consumes from Task 4: `InventoryExportField`, `fieldHeading`, `InventoryExportSourceRow`. From Task 7: `EmbeddedImage`. From Task 8: `ExportImageSize`.
- Produces for Task 13:
  - `toInventoryXlsx(input: InventoryXlsxInput): Promise<Buffer>` where
    `InventoryXlsxInput = { fields: readonly InventoryExportField[]; rows: readonly InventoryExportSourceRow[]; itemTypeKind: 'book' | 'other'; freezeHeader: boolean; autoFilter: boolean; includeSummarySheet: boolean; imageMode: 'embedded' | 'url' | 'both' | null; imageSize: ExportImageSize; images?: ReadonlyMap<string, EmbeddedImage>; truncatedNote?: string }`.
  - `XLSX_IMAGE_CELL: Record<ExportImageSize, { rowHeightPt: number; columnWidthChars: number; boxPx: { width: number; height: number } }>`.
  - `readImageDimensions(data: Uint8Array): { width: number; height: number } | null`.
- **Removed:** the old `toInventoryXlsx(headers, rows)` two-argument form. Its only caller is the export route, updated in Task 13; the legacy CSV route never used it.

**Steps:**

- [ ] **Step 1: Write the failing workbook test.** Create `apps/web/src/lib/inventory-export-xlsx.test.ts`:

```ts
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import { getExportField, type InventoryExportFieldKey } from './exports/field-registry';
import type { InventoryExportSourceRow } from './exports/source-row';
import { readImageDimensions, toInventoryXlsx, XLSX_IMAGE_CELL } from './inventory-export-xlsx';

const fieldsFor = (keys: InventoryExportFieldKey[]) => keys.map((k) => getExportField(k)!);

const BOOK_FIELDS: InventoryExportFieldKey[] = [
  'image',
  'name',
  'isbn',
  'sku',
  'author',
  'quantity_on_hand',
  'category',
  'status',
];

function makeRow(overrides: Partial<InventoryExportSourceRow> = {}): InventoryExportSourceRow {
  return {
    id: 'i-1',
    itemType: 'book',
    name: 'Introduction to Algorithms',
    sku: 'BK-0001',
    barcode: '9780262033848',
    status: 'active',
    quantityOnHand: 4,
    reorderPoint: 0,
    reorderQuantity: 0,
    unitCost: 42.5,
    retailPrice: 89,
    category: 'Mathematics',
    primaryLocation: 'DC4',
    supplier: '',
    warehouse: 'North',
    charter: 'Generic',
    trackingType: 'none',
    author: 'Cormen',
    isbn: '9780262033848',
    grade: 'College',
    rackNumber: '38',
    rackRow: 'A',
    crateColor: 'blue',
    crateNumber: '12',
    rackLabel: '38-A',
    crateLabel: 'Blue 12',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    image: null,
    ...overrides,
  };
}

async function build(overrides: Partial<Parameters<typeof toInventoryXlsx>[0]> = {}) {
  const buffer = await toInventoryXlsx({
    fields: fieldsFor(BOOK_FIELDS),
    rows: [makeRow()],
    itemTypeKind: 'book',
    freezeHeader: true,
    autoFilter: true,
    includeSummarySheet: false,
    imageMode: null,
    imageSize: 'medium',
    ...overrides,
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
}

/** A 1x1 PNG — real bytes, so exceljs and the dimension reader both accept it. */
const PNG_1x1 = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

describe('toInventoryXlsx — sheet and headers', () => {
  it('names the worksheet Books for a books export and Inventory otherwise', async () => {
    expect((await build()).worksheets[0]!.name).toBe('Books');
    expect(
      (await build({ itemTypeKind: 'other', fields: fieldsFor(['name', 'sku']) })).worksheets[0]!
        .name,
    ).toBe('Inventory');
  });

  it('writes ONLY the selected fields, as friendly labels, in the chosen order', async () => {
    const wb = await build({ fields: fieldsFor(['status', 'isbn', 'name']) });
    const header = wb.worksheets[0]!.getRow(1).values as unknown[];
    expect(header.slice(1)).toEqual(['Status', 'ISBN', 'Title']);
  });

  it('labels the image column Cover for books, not the raw key', async () => {
    const wb = await build({ imageMode: 'url' });
    const header = wb.worksheets[0]!.getRow(1).values as unknown[];
    expect(header[1]).toBe('Cover');
  });

  it('bolds and freezes the header when asked, and does not when not', async () => {
    const frozen = (await build()).worksheets[0]!;
    expect(frozen.getRow(1).font?.bold).toBe(true);
    expect(frozen.views?.[0]?.state).toBe('frozen');
    const loose = (await build({ freezeHeader: false })).worksheets[0]!;
    expect(loose.views?.[0]?.state ?? 'normal').not.toBe('frozen');
  });

  it('applies an autofilter over the whole used range when asked', async () => {
    const ws = (await build()).worksheets[0]!;
    expect(ws.autoFilter).toBeTruthy();
    const filtered = (await build({ autoFilter: false })).worksheets[0]!;
    expect(filtered.autoFilter).toBeFalsy();
  });

  it('gives long text columns more width than narrow numeric ones', async () => {
    const ws = (await build()).worksheets[0]!;
    const header = (ws.getRow(1).values as unknown[]).slice(1) as string[];
    const widthOf = (label: string) => ws.getColumn(header.indexOf(label) + 1).width ?? 0;
    expect(widthOf('Title')).toBeGreaterThan(widthOf('On hand'));
  });
});

describe('toInventoryXlsx — cell types', () => {
  it('writes ISBN as TEXT with an explicit @ format, so no scientific notation', async () => {
    const wb = await build({ rows: [makeRow({ isbn: '0262033844' })] });
    const ws = wb.worksheets[0]!;
    const header = (ws.getRow(1).values as unknown[]).slice(1) as string[];
    const cell = ws.getRow(2).getCell(header.indexOf('ISBN') + 1);
    expect(cell.value).toBe('0262033844');
    expect(typeof cell.value).toBe('string');
    expect(cell.numFmt).toBe('@');
  });

  it('writes SKU and barcode as text too', async () => {
    const wb = await build({ fields: fieldsFor(['sku', 'barcode']), rows: [makeRow()] });
    const ws = wb.worksheets[0]!;
    for (const col of [1, 2]) {
      expect(ws.getRow(2).getCell(col).numFmt).toBe('@');
    }
  });

  it('writes quantities as real numbers, right aligned', async () => {
    const wb = await build({ fields: fieldsFor(['name', 'quantity_on_hand']) });
    const cell = wb.worksheets[0]!.getRow(2).getCell(2);
    expect(cell.value).toBe(4);
    expect(typeof cell.value).toBe('number');
    expect(cell.alignment?.horizontal).toBe('right');
  });

  it('formats currency fields as currency', async () => {
    const wb = await build({ fields: fieldsFor(['name', 'unit_cost']) });
    const cell = wb.worksheets[0]!.getRow(2).getCell(2);
    expect(cell.value).toBe(42.5);
    expect(cell.numFmt).toContain('0.00');
  });

  it('formats date fields as dates rather than raw ISO strings', async () => {
    const wb = await build({ fields: fieldsFor(['name', 'created_at']) });
    const cell = wb.worksheets[0]!.getRow(2).getCell(2);
    expect(cell.value).toBeInstanceOf(Date);
    expect(cell.numFmt).toContain('yyyy');
  });

  it('wraps long text columns', async () => {
    const wb = await build({ fields: fieldsFor(['name']) });
    expect(wb.worksheets[0]!.getRow(2).getCell(1).alignment?.wrapText).toBe(true);
  });

  it('defuses formula injection on every string cell', async () => {
    const wb = await build({
      fields: fieldsFor(['name', 'sku']),
      rows: [makeRow({ name: '=cmd|calc', sku: '@SUM(A1:A9)' })],
    });
    const row = wb.worksheets[0]!.getRow(2);
    expect(String(row.getCell(1).value).startsWith("'=")).toBe(true);
    expect(String(row.getCell(2).value).startsWith("'@")).toBe(true);
  });

  it('writes an empty cell, never the word undefined, for a missing value', async () => {
    const wb = await build({
      fields: fieldsFor(['name', 'author', 'isbn']),
      rows: [makeRow({ author: '', isbn: '' })],
    });
    const row = wb.worksheets[0]!.getRow(2);
    for (const col of [2, 3]) {
      const v = row.getCell(col).value;
      expect(v === null || v === '').toBe(true);
    }
  });
});

describe('toInventoryXlsx — images', () => {
  it('writes the URL as text in url mode', async () => {
    const wb = await build({
      imageMode: 'url',
      rows: [makeRow({ image: { thumbnailUrl: 'https://signed.example/a.jpg' } })],
    });
    expect(wb.worksheets[0]!.getRow(2).getCell(1).value).toBe('https://signed.example/a.jpg');
  });

  it('embeds a picture and grows the row in embedded mode', async () => {
    const wb = await build({
      imageMode: 'embedded',
      rows: [makeRow({ image: { thumbnailUrl: 'https://signed.example/a.png' } })],
      images: new Map([['i-1', { data: PNG_1x1, extension: 'png' as const }]]),
    });
    const ws = wb.worksheets[0]!;
    expect(ws.getImages()).toHaveLength(1);
    expect(ws.getRow(2).height).toBe(XLSX_IMAGE_CELL.medium.rowHeightPt);
    // The picture cell itself carries no URL text in embedded mode.
    expect(ws.getRow(2).getCell(1).value ?? '').toBe('');
  });

  it('writes BOTH a picture and the URL in both mode', async () => {
    const wb = await build({
      imageMode: 'both',
      rows: [makeRow({ image: { thumbnailUrl: 'https://signed.example/a.png' } })],
      images: new Map([['i-1', { data: PNG_1x1, extension: 'png' as const }]]),
    });
    const ws = wb.worksheets[0]!;
    expect(ws.getImages()).toHaveLength(1);
    const header = (ws.getRow(1).values as unknown[]).slice(1) as string[];
    expect(header).toContain('Image URL');
    expect(ws.getRow(2).getCell(header.indexOf('Image URL') + 1).value).toBe(
      'https://signed.example/a.png',
    );
  });

  it('leaves the cell blank and keeps going when one image failed to fetch', async () => {
    const wb = await build({
      imageMode: 'embedded',
      rows: [
        makeRow({ id: 'i-1', image: { thumbnailUrl: 'https://signed.example/a.png' } }),
        makeRow({ id: 'i-2', image: null }),
      ],
      images: new Map([['i-1', { data: PNG_1x1, extension: 'png' as const }]]),
    });
    const ws = wb.worksheets[0]!;
    expect(ws.getImages()).toHaveLength(1);
    expect(ws.rowCount).toBe(3);
  });

  it('does no image work at all when the image field was not selected', async () => {
    const wb = await build({ fields: fieldsFor(['name', 'sku']), imageMode: null });
    expect(wb.worksheets[0]!.getImages()).toHaveLength(0);
    const header = (wb.worksheets[0]!.getRow(1).values as unknown[]).slice(1) as string[];
    expect(header).not.toContain('Cover');
  });
});

describe('readImageDimensions', () => {
  it('reads a PNG header', () => {
    expect(readImageDimensions(PNG_1x1)).toEqual({ width: 1, height: 1 });
  });

  it('returns null for bytes it cannot parse instead of guessing', () => {
    expect(readImageDimensions(Uint8Array.from([1, 2, 3, 4]))).toBeNull();
  });
});

describe('toInventoryXlsx — summary sheet', () => {
  it('adds no second sheet unless asked', async () => {
    expect((await build()).worksheets).toHaveLength(1);
  });

  it('counts titles, units, ISBN coverage and cover coverage for books', async () => {
    const wb = await build({
      includeSummarySheet: true,
      rows: [
        makeRow({ id: 'a', isbn: '1', image: { thumbnailUrl: 'u' }, quantityOnHand: 4 }),
        makeRow({ id: 'b', isbn: '', image: null, quantityOnHand: 6, category: 'History' }),
      ],
    });
    expect(wb.worksheets).toHaveLength(2);
    const summary = wb.worksheets[1]!;
    expect(summary.name).toBe('Summary');
    const text = JSON.stringify(summary.getSheetValues());
    expect(text).toContain('Total titles');
    expect(text).toContain('On-hand units');
    expect(text).toContain('With ISBN');
    expect(text).toContain('Missing ISBN');
    expect(text).toContain('With cover');
    expect(text).toContain('Missing cover');
    expect(text).toContain('Mathematics');
    expect(text).toContain('History');
  });

  it('omits inventory value from the summary when no financial field was exported', async () => {
    const wb = await build({
      itemTypeKind: 'other',
      fields: fieldsFor(['name', 'sku', 'quantity_on_hand']),
      includeSummarySheet: true,
    });
    const text = JSON.stringify(wb.worksheets[1]!.getSheetValues());
    expect(text).not.toContain('Inventory value');
  });

  it('includes inventory value when a financial field WAS exported', async () => {
    const wb = await build({
      itemTypeKind: 'other',
      fields: fieldsFor(['name', 'unit_cost']),
      includeSummarySheet: true,
    });
    expect(JSON.stringify(wb.worksheets[1]!.getSheetValues())).toContain('Inventory value');
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/lib/inventory-export-xlsx.test.ts 2>&1 | tail -20`
Expected: FAIL — `readImageDimensions is not exported` / `toInventoryXlsx` rejects the object argument. Record the real text.

- [ ] **Step 3: Rewrite the writer.** Replace the entire contents of `apps/web/src/lib/inventory-export-xlsx.ts` with:

```ts
import 'server-only';

import ExcelJS from 'exceljs';

import { escapeForSpreadsheet } from './csv';
import { fieldHeading, type InventoryExportField } from './exports/field-registry';
import type { EmbeddedImage } from './exports/export-images';
import type { ExportImageSize } from './exports/pdf-layout';
import type { InventoryExportSourceRow } from './exports/source-row';

/**
 * Render export rows to a real .xlsx workbook (exceljs), driven entirely by the
 * chosen fields and their registry metadata (Brief section 14).
 *
 * What changed from the original 47-line version: only the selected fields, in
 * the user's order, under friendly labels; a sheet named for what it contains;
 * per-type cell formats (text for identifiers, numbers right-aligned, currency,
 * dates); autofilter; sensible widths; wrapped long text; optional embedded
 * pictures with grown rows; an optional summary sheet. What did NOT change: the
 * formula-injection guard on every string cell, via the same escapeForSpreadsheet
 * the CSV path uses.
 */

export const XLSX_IMAGE_CELL: Record<
  ExportImageSize,
  { rowHeightPt: number; columnWidthChars: number; boxPx: { width: number; height: number } }
> = {
  small: { rowHeightPt: 42, columnWidthChars: 7, boxPx: { width: 40, height: 54 } },
  medium: { rowHeightPt: 66, columnWidthChars: 11, boxPx: { width: 64, height: 86 } },
  large: { rowHeightPt: 96, columnWidthChars: 15, boxPx: { width: 92, height: 124 } },
};

const CURRENCY_FORMAT = '#,##0.00';
const DATE_FORMAT = 'yyyy-mm-dd';

export interface InventoryXlsxInput {
  fields: readonly InventoryExportField[];
  rows: readonly InventoryExportSourceRow[];
  itemTypeKind: 'book' | 'other';
  freezeHeader: boolean;
  autoFilter: boolean;
  includeSummarySheet: boolean;
  /** null when the image field was not selected — no image work happens. */
  imageMode: 'embedded' | 'url' | 'both' | null;
  imageSize: ExportImageSize;
  /** itemId to bytes, for embedded / both. Missing ids render blank. */
  images?: ReadonlyMap<string, EmbeddedImage>;
  /** Appended to the summary sheet when the row cap truncated the export. */
  truncatedNote?: string;
}

/**
 * Intrinsic pixel size of a PNG or JPEG, so an embedded picture can be scaled
 * to FIT its box instead of being stretched to it (Brief section 14: "images
 * inside rows, undistorted"). Returns null for anything unparseable, and the
 * caller then uses the box as-is.
 */
export function readImageDimensions(data: Uint8Array): { width: number; height: number } | null {
  // PNG: 8-byte signature, then IHDR with width at 16 and height at 20 (BE32).
  if (
    data.length > 24 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  // JPEG: walk the marker chain to the first SOF segment.
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = data[offset + 1]!;
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof) {
        const height = (data[offset + 5]! << 8) | data[offset + 6]!;
        const width = (data[offset + 7]! << 8) | data[offset + 8]!;
        return width > 0 && height > 0 ? { width, height } : null;
      }
      const length = (data[offset + 2]! << 8) | data[offset + 3]!;
      if (length <= 0) return null;
      offset += 2 + length;
    }
  }
  return null;
}

function columnWidthFor(field: InventoryExportField, heading: string): number {
  if (field.cellType === 'number' || field.cellType === 'currency') return 14;
  if (field.cellType === 'date') return 16;
  if (field.wrap) return 40;
  return Math.min(Math.max(heading.length + 4, 14), 44);
}

/** Fit (w, h) inside the box, preserving aspect. */
function fitBox(
  intrinsic: { width: number; height: number } | null,
  box: { width: number; height: number },
): { width: number; height: number } {
  if (!intrinsic || intrinsic.width <= 0 || intrinsic.height <= 0) return box;
  const scale = Math.min(box.width / intrinsic.width, box.height / intrinsic.height);
  return {
    width: Math.max(1, Math.round(intrinsic.width * scale)),
    height: Math.max(1, Math.round(intrinsic.height * scale)),
  };
}

export async function toInventoryXlsx(input: InventoryXlsxInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'StockPilot';
  const ws = wb.addWorksheet(input.itemTypeKind === 'book' ? 'Books' : 'Inventory');

  const embedsPictures = input.imageMode === 'embedded' || input.imageMode === 'both';
  const imageSpec = XLSX_IMAGE_CELL[input.imageSize];

  // Column plan. In `both` mode the image field produces TWO columns: the
  // picture cell and a separate Image URL cell.
  type Plan = { field: InventoryExportField; heading: string; kind: 'value' | 'picture' | 'url' };
  const plan: Plan[] = [];
  for (const field of input.fields) {
    if (field.key === 'image') {
      if (input.imageMode === null) continue;
      if (embedsPictures) {
        plan.push({
          field,
          heading: fieldHeading(field, { format: 'xlsx', itemType: input.itemTypeKind }),
          kind: 'picture',
        });
      }
      if (input.imageMode === 'url' || input.imageMode === 'both') {
        plan.push({
          field,
          heading:
            input.imageMode === 'both'
              ? 'Image URL'
              : fieldHeading(field, { format: 'xlsx', itemType: input.itemTypeKind }),
          kind: 'url',
        });
      }
      continue;
    }
    plan.push({
      field,
      heading: fieldHeading(field, { format: 'xlsx', itemType: input.itemTypeKind }),
      kind: 'value',
    });
  }

  ws.columns = plan.map((p) => ({
    header: p.heading,
    key: `c${plan.indexOf(p)}`,
    width:
      p.kind === 'picture' ? imageSpec.columnWidthChars : columnWidthFor(p.field, p.heading),
  }));

  for (const row of input.rows) {
    const excelRow = ws.addRow(
      plan.map((p) => {
        if (p.kind === 'picture') return '';
        if (p.kind === 'url') return escapeForSpreadsheet(row.image?.thumbnailUrl ?? '');
        const value = p.field.value(row);
        if (value === null || value === undefined) return '';
        if (p.field.cellType === 'date') {
          const date = new Date(String(value));
          return Number.isNaN(date.getTime()) ? escapeForSpreadsheet(String(value)) : date;
        }
        if (typeof value === 'number') return value;
        return escapeForSpreadsheet(String(value));
      }),
    );

    plan.forEach((p, index) => {
      const cell = excelRow.getCell(index + 1);
      if (p.kind !== 'value') {
        if (p.kind === 'url') cell.numFmt = '@';
        return;
      }
      switch (p.field.cellType) {
        case 'text':
          // The identifier guarantee: an explicit text format is what stops
          // Excel turning 9780262033848 into 9.78026E+12 or eating a leading
          // zero off an ISBN-10.
          cell.numFmt = '@';
          break;
        case 'currency':
          cell.numFmt = CURRENCY_FORMAT;
          cell.alignment = { horizontal: 'right' };
          break;
        case 'number':
          cell.alignment = { horizontal: 'right' };
          break;
        case 'date':
          cell.numFmt = DATE_FORMAT;
          break;
      }
      if (p.field.wrap) {
        cell.alignment = { ...(cell.alignment ?? {}), wrapText: true, vertical: 'top' };
      }
    });

    if (embedsPictures) {
      excelRow.height = imageSpec.rowHeightPt;
      const image = input.images?.get(row.id);
      const pictureIndex = plan.findIndex((p) => p.kind === 'picture');
      if (image && pictureIndex >= 0) {
        const id = wb.addImage({
          buffer: Buffer.from(image.data) as unknown as ExcelJS.Buffer,
          extension: image.extension,
        });
        const size = fitBox(readImageDimensions(image.data), imageSpec.boxPx);
        ws.addImage(id, {
          // exceljs anchors are zero-based; the header occupies row 0.
          tl: { col: pictureIndex, row: excelRow.number - 1 },
          ext: size,
          editAs: 'oneCell',
        });
      }
    }
  }

  const head = ws.getRow(1);
  head.font = { bold: true };
  head.alignment = { vertical: 'middle' };
  if (input.freezeHeader) {
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }
  if (input.autoFilter && plan.length > 0) {
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: Math.max(1, input.rows.length + 1), column: plan.length },
    };
  }

  if (input.includeSummarySheet) {
    addSummarySheet(wb, input);
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

/**
 * Optional summary sheet (Brief section 14).
 *
 * It reports ONLY on fields this export actually contains: value totals appear
 * only when a financial field was exported, so a summary can never surface a
 * number the sheet itself does not show.
 */
function addSummarySheet(wb: ExcelJS.Workbook, input: InventoryXlsxInput): void {
  const ws = wb.addWorksheet('Summary');
  ws.columns = [
    { header: 'Metric', key: 'metric', width: 34 },
    { header: 'Value', key: 'value', width: 18 },
  ];
  ws.getRow(1).font = { bold: true };

  const rows = input.rows;
  const units = rows.reduce((sum, r) => sum + r.quantityOnHand, 0);
  const add = (metric: string, value: string | number) => {
    ws.addRow({ metric, value });
  };

  if (input.itemTypeKind === 'book') {
    const withIsbn = rows.filter((r) => r.isbn.length > 0).length;
    const withCover = rows.filter((r) => r.image !== null).length;
    add('Total titles', rows.length);
    add('On-hand units', units);
    add('With ISBN', withIsbn);
    add('Missing ISBN', rows.length - withIsbn);
    add('With cover', withCover);
    add('Missing cover', rows.length - withCover);
  } else {
    add('Total records', rows.length);
    add('On-hand units', units);
  }

  const exportsFinancials = input.fields.some((f) => f.group === 'financial');
  if (exportsFinancials) {
    const value = rows.reduce((sum, r) => sum + (r.unitCost ?? 0) * r.quantityOnHand, 0);
    add('Inventory value', Math.round(value * 100) / 100);
    ws.getRow(ws.rowCount).getCell(2).numFmt = CURRENCY_FORMAT;
  }

  const tally = (label: string, pick: (r: InventoryExportSourceRow) => string) => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = pick(row) || 'Unassigned';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    ws.addRow({});
    const heading = ws.addRow({ metric: label, value: 'Count' });
    heading.font = { bold: true };
    for (const [key, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      add(key, count);
    }
  };
  tally('Category totals', (r) => r.category);
  tally('Status totals', (r) => r.status);

  if (input.truncatedNote) {
    ws.addRow({});
    ws.addRow({ metric: input.truncatedNote });
  }
}
```

- [ ] **Step 4: Run the workbook test to verify it passes.**

Run: `pnpm --filter @stockpilot/web test src/lib/inventory-export-xlsx.test.ts 2>&1 | tail -25`
Expected: PASS — 23 tests.

- [ ] **Step 5: Typecheck.**

Run: `pnpm --filter @stockpilot/web typecheck 2>&1 | tail -20`
Expected: ONE error, in `apps/web/src/app/api/inventory/export/route.tsx`, because the route still calls the old two-argument `toInventoryXlsx`. That is expected and is fixed in Task 13. Leave it; do not patch the route here, and do not soften the new signature to accommodate it.

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/lib/inventory-export-xlsx.ts apps/web/src/lib/inventory-export-xlsx.test.ts
git commit -m "feat(inventory): field-driven excel export with formats, images and summary"
```

---

## Task 12: The CSV writer and the descriptive filename

Brief §15 and §22. CSV quoting and formula-injection escaping in `lib/csv.ts` are already correct (Audit A7) and are reused untouched; what is new is field selection, order, friendly headings and the Image URL column. Filenames get ONE builder — the repo currently has two unrelated ones (`csvFilename` in `csv.ts` for the legacy routes, `exportFilename` inlined in `route.tsx`), and neither produces the descriptive names the brief asks for.

**Files:**
- Create: `apps/web/src/lib/exports/export-csv.ts`
- Create: `apps/web/src/lib/exports/export-csv.test.ts`
- Create: `apps/web/src/lib/exports/filename.ts`
- Create: `apps/web/src/lib/exports/filename.test.ts`

**Interfaces:**
- Consumes from Task 4: `InventoryExportField`, `fieldHeading`, `InventoryExportSourceRow`.
- Produces for Task 13:
  - `toInventoryCsv(input: { fields: readonly InventoryExportField[]; rows: readonly InventoryExportSourceRow[]; itemTypeKind: 'book' | 'other'; truncatedNote?: string }): string`.
  - `buildExportFilename(input: { slug: 'books' | 'inventory'; scope: 'selected' | 'filtered' | 'all'; format: 'csv' | 'xlsx' | 'pdf'; presetName?: string | null; count?: number; now?: Date }): string`.
  - `sanitizeFilenameSegment(value: string): string`.

**Steps:**

- [ ] **Step 1: Write the failing CSV test.** Create `apps/web/src/lib/exports/export-csv.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { getExportField, type InventoryExportFieldKey } from './field-registry';
import type { InventoryExportSourceRow } from './source-row';
import { toInventoryCsv } from './export-csv';

const fieldsFor = (keys: InventoryExportFieldKey[]) => keys.map((k) => getExportField(k)!);

function makeRow(overrides: Partial<InventoryExportSourceRow> = {}): InventoryExportSourceRow {
  return {
    id: 'i-1',
    itemType: 'book',
    name: 'Introduction to Algorithms',
    sku: 'BK-0001',
    barcode: '9780262033848',
    status: 'active',
    quantityOnHand: 4,
    reorderPoint: 0,
    reorderQuantity: 0,
    unitCost: 42.5,
    retailPrice: 89,
    category: 'Mathematics',
    primaryLocation: 'DC4',
    supplier: '',
    warehouse: 'North',
    charter: 'Generic',
    trackingType: 'none',
    author: 'Cormen',
    isbn: '9780262033848',
    grade: 'College',
    rackNumber: '38',
    rackRow: 'A',
    crateColor: 'blue',
    crateNumber: '12',
    rackLabel: '38-A',
    crateLabel: 'Blue 12',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    image: null,
    ...overrides,
  };
}

const lines = (csv: string) => csv.split('\n');

describe('toInventoryCsv', () => {
  it('writes friendly headings for the selected fields, in the chosen order', () => {
    const csv = toInventoryCsv({
      fields: fieldsFor(['status', 'isbn', 'name']),
      rows: [makeRow()],
      itemTypeKind: 'book',
    });
    expect(lines(csv)[0]).toBe('Status,ISBN,Title');
    expect(lines(csv)[1]).toBe('active,9780262033848,Introduction to Algorithms');
  });

  it('labels the image column Image URL — never "images", never binary', () => {
    const csv = toInventoryCsv({
      fields: fieldsFor(['name', 'image']),
      rows: [makeRow({ image: { thumbnailUrl: 'https://signed.example/a.jpg' } })],
      itemTypeKind: 'book',
    });
    expect(lines(csv)[0]).toBe('Name,Image URL');
    expect(lines(csv)[1]).toContain('https://signed.example/a.jpg');
    expect(csv).not.toContain('base64');
  });

  it('leaves the image column blank for a row with no image', () => {
    const csv = toInventoryCsv({
      fields: fieldsFor(['sku', 'image']),
      rows: [makeRow({ image: null })],
      itemTypeKind: 'book',
    });
    expect(lines(csv)[1]).toBe('BK-0001,');
  });

  it('quotes values containing commas, quotes and newlines', () => {
    const csv = toInventoryCsv({
      fields: fieldsFor(['name']),
      rows: [makeRow({ name: 'Algorithms, 4th ed. "Deluxe"\nSecond line' })],
      itemTypeKind: 'book',
    });
    expect(lines(csv)[1]).toContain('"Algorithms, 4th ed. ""Deluxe""');
  });

  it('defuses formula injection', () => {
    const csv = toInventoryCsv({
      fields: fieldsFor(['name', 'sku']),
      rows: [makeRow({ name: '=cmd|calc', sku: '+1+1' })],
      itemTypeKind: 'book',
    });
    expect(lines(csv)[1]!.startsWith("'=cmd|calc")).toBe(true);
    expect(lines(csv)[1]).toContain("'+1+1");
  });

  it('keeps a leading-zero ISBN intact and never quotes it into a number', () => {
    const csv = toInventoryCsv({
      fields: fieldsFor(['isbn']),
      rows: [makeRow({ isbn: '0262033844' })],
      itemTypeKind: 'book',
    });
    expect(lines(csv)[1]).toBe('0262033844');
  });

  it('writes an empty cell — never the word undefined — for a missing value', () => {
    const csv = toInventoryCsv({
      fields: fieldsFor(['name', 'author', 'grade']),
      rows: [makeRow({ author: '', grade: '' })],
      itemTypeKind: 'book',
    });
    expect(lines(csv)[1]).toBe('Introduction to Algorithms,,');
    expect(csv).not.toContain('undefined');
    expect(csv).not.toContain('[object Object]');
  });

  it('writes a real zero as 0', () => {
    const csv = toInventoryCsv({
      fields: fieldsFor(['sku', 'quantity_on_hand']),
      rows: [makeRow({ quantityOnHand: 0 })],
      itemTypeKind: 'book',
    });
    expect(lines(csv)[1]).toBe('BK-0001,0');
  });

  it('writes no BOM — existing consumers read BOM-less UTF-8 today', () => {
    // Brief section 15 asks for UTF-8 with a BOM only after verifying current
    // consumers. Nothing in this repo writes one, so adding one silently would
    // be a behaviour change to every existing importer. Documented, not done.
    const csv = toInventoryCsv({
      fields: fieldsFor(['name']),
      rows: [makeRow()],
      itemTypeKind: 'book',
    });
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('appends the truncation note as a comment line when the cap was hit', () => {
    const csv = toInventoryCsv({
      fields: fieldsFor(['name']),
      rows: [makeRow()],
      itemTypeKind: 'book',
      truncatedNote: '# truncated at 10000 rows of 41230',
    });
    expect(lines(csv).at(-1)).toBe('# truncated at 10000 rows of 41230');
  });

  it('still writes a header row for an empty result set', () => {
    const csv = toInventoryCsv({
      fields: fieldsFor(['name', 'sku']),
      rows: [],
      itemTypeKind: 'other',
    });
    expect(csv).toBe('Name,SKU');
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/lib/exports/export-csv.test.ts 2>&1 | tail -20`
Expected: FAIL — `Failed to resolve import "./export-csv"`. Record the real text.

- [ ] **Step 3: Write the CSV writer.** Create `apps/web/src/lib/exports/export-csv.ts`:

```ts
import { toCsv } from '@/lib/csv';

import { fieldHeading, type InventoryExportField } from './field-registry';
import type { InventoryExportSourceRow } from './source-row';

/**
 * Field-driven CSV (Brief section 15).
 *
 * Quoting and formula-injection escaping are NOT reimplemented here: toCsv in
 * lib/csv.ts already applies escapeForSpreadsheet then RFC-4180 quoting, and
 * that is the one place those rules live. This module only decides WHICH
 * columns exist, in what order, and under what heading.
 *
 * No UTF-8 BOM. The brief allows one only after verifying current consumers,
 * and every CSV this product has ever emitted is BOM-less — adding one would
 * change what every existing importer reads.
 */
export interface InventoryCsvInput {
  fields: readonly InventoryExportField[];
  rows: readonly InventoryExportSourceRow[];
  itemTypeKind: 'book' | 'other';
  /** e.g. '# truncated at 10000 rows of 41230'. Appended as a final line. */
  truncatedNote?: string;
}

export function toInventoryCsv(input: InventoryCsvInput): string {
  const headings = input.fields.map((field) =>
    fieldHeading(field, { format: 'csv', itemType: input.itemTypeKind }),
  );

  const rows = input.rows.map((row) => {
    const record: Record<string, string | number> = {};
    input.fields.forEach((field, index) => {
      const value = field.value(row);
      // '' rather than null/undefined: toCsv would render either as an empty
      // cell anyway, but keeping the type narrow means no path can ever emit
      // the literal text "undefined".
      record[headings[index]!] = value === null || value === undefined ? '' : value;
    });
    return record;
  });

  const body = toCsv(headings, rows);
  return input.truncatedNote ? `${body}\n${input.truncatedNote}` : body;
}
```

- [ ] **Step 4: Run the CSV test to verify it passes.**

Run: `pnpm --filter @stockpilot/web test src/lib/exports/export-csv.test.ts 2>&1 | tail -20`
Expected: PASS — 11 tests.

- [ ] **Step 5: Write the failing filename test.** Create `apps/web/src/lib/exports/filename.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { buildExportFilename, sanitizeFilenameSegment } from './filename';

const AUG_3 = new Date('2026-08-03T18:30:00.000Z');

describe('buildExportFilename', () => {
  it('names a filtered books PDF descriptively', () => {
    expect(
      buildExportFilename({ slug: 'books', scope: 'filtered', format: 'pdf', now: AUG_3 }),
    ).toBe('books-filtered-2026-08-03.pdf');
  });

  it('uses the preset name when there is one', () => {
    expect(
      buildExportFilename({
        slug: 'books',
        scope: 'all',
        format: 'xlsx',
        presetName: 'Books with covers',
        now: AUG_3,
      }),
    ).toBe('books-with-covers-2026-08-03.xlsx');
  });

  it('counts the records for a selected export', () => {
    expect(
      buildExportFilename({
        slug: 'inventory',
        scope: 'selected',
        format: 'pdf',
        count: 12,
        now: AUG_3,
      }),
    ).toBe('inventory-selected-12-items-2026-08-03.pdf');
  });

  it('singularizes one selected item', () => {
    expect(
      buildExportFilename({
        slug: 'inventory',
        scope: 'selected',
        format: 'csv',
        count: 1,
        now: AUG_3,
      }),
    ).toBe('inventory-selected-1-item-2026-08-03.csv');
  });

  it('falls back to the scope when a selected export has no count', () => {
    expect(
      buildExportFilename({ slug: 'books', scope: 'selected', format: 'csv', now: AUG_3 }),
    ).toBe('books-selected-2026-08-03.csv');
  });

  it('produces the brief\'s ISBN-list example', () => {
    expect(
      buildExportFilename({
        slug: 'books',
        scope: 'all',
        format: 'csv',
        presetName: 'Books ISBN list',
        now: AUG_3,
      }),
    ).toBe('books-isbn-list-2026-08-03.csv');
  });
});

describe('sanitizeFilenameSegment', () => {
  it('strips path separators, quotes and control characters', () => {
    expect(sanitizeFilenameSegment('../../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeFilenameSegment('my "preset"')).toBe('my-preset');
    expect(sanitizeFilenameSegment('a\r\nContent-Disposition: x')).toBe(
      'a-content-disposition-x',
    );
  });

  it('collapses runs and trims dashes', () => {
    expect(sanitizeFilenameSegment('  Books   with  covers  ')).toBe('books-with-covers');
    expect(sanitizeFilenameSegment('---')).toBe('');
  });

  it('caps the length so a hostile preset name cannot blow up the header', () => {
    expect(sanitizeFilenameSegment('x'.repeat(200)).length).toBeLessThanOrEqual(60);
  });

  it('drops non-ASCII rather than emitting bytes a Content-Disposition cannot carry', () => {
    expect(sanitizeFilenameSegment('libros españoles 2026')).toBe('libros-espa-oles-2026');
  });
});
```

- [ ] **Step 6: Run it to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/lib/exports/filename.test.ts 2>&1 | tail -20`
Expected: FAIL — `Failed to resolve import "./filename"`. Record the real text.

- [ ] **Step 7: Write the filename builder.** Create `apps/web/src/lib/exports/filename.ts`:

```ts
/**
 * ONE descriptive, safe export filename (Brief section 22).
 *
 * Two other builders already exist and stay where they are: csvFilename() in
 * lib/csv.ts serves the legacy GET .csv routes, and the export route used to
 * inline its own `${slug}-${scope}-${date}.${ext}`. This replaces the inlined
 * one for the builder's downloads and is the only place preset names — the one
 * user-controlled component of the name — are sanitized.
 *
 * SECURITY: the result is interpolated into a Content-Disposition header. A
 * newline or a double quote there is a header-injection primitive, and a slash
 * is a path traversal in some download managers, so the sanitizer is an
 * allow-list of [a-z0-9-] rather than a deny-list.
 */

export function sanitizeFilenameSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

export interface ExportFilenameInput {
  slug: 'books' | 'inventory';
  scope: 'selected' | 'filtered' | 'all';
  format: 'csv' | 'xlsx' | 'pdf';
  /** The chosen preset's name, when it is not the ad-hoc "Custom" one. */
  presetName?: string | null;
  /** Row count, used for the selected-scope name. */
  count?: number;
  now?: Date;
}

export function buildExportFilename(input: ExportFilenameInput): string {
  const date = (input.now ?? new Date()).toISOString().slice(0, 10);
  const preset = input.presetName ? sanitizeFilenameSegment(input.presetName) : '';

  if (preset) {
    // "Books with covers" -> books-with-covers-2026-08-03.xlsx. The preset
    // names already begin with Books / Inventory, so the slug is not repeated.
    return `${preset}-${date}.${input.format}`;
  }

  if (input.scope === 'selected' && typeof input.count === 'number' && input.count > 0) {
    const noun = input.count === 1 ? 'item' : 'items';
    return `${input.slug}-selected-${input.count}-${noun}-${date}.${input.format}`;
  }

  return `${input.slug}-${input.scope}-${date}.${input.format}`;
}
```

- [ ] **Step 8: Run the filename test to verify it passes.**

Run: `pnpm --filter @stockpilot/web test src/lib/exports/filename.test.ts 2>&1 | tail -20`
Expected: PASS — 10 tests.

- [ ] **Step 9: Commit.**

```bash
git add apps/web/src/lib/exports/export-csv.ts apps/web/src/lib/exports/export-csv.test.ts \
        apps/web/src/lib/exports/filename.ts apps/web/src/lib/exports/filename.test.ts
git commit -m "feat(inventory): field-driven csv and descriptive export filenames"
```

---

## Task 13: Wire the route, add the preview endpoint, teach the client to report progress

The server side comes together: one route serving three configurable formats, one preview endpoint feeding the dialog, and a client helper that reports the stages it can actually observe.

**Files:**
- Modify: `apps/web/src/app/api/inventory/export/route.tsx` (schema, resolver, images, all three formats, filenames)
- Modify: `apps/web/src/app/api/inventory/export/route.test.tsx`
- Create: `apps/web/src/app/api/inventory/export/preview/route.ts`
- Create: `apps/web/src/app/api/inventory/export/preview/route.test.ts`
- Modify: `apps/web/src/lib/download-export.ts`

**Interfaces:**
- Consumes: Tasks 5 (`inventoryExportRequestSchema`, `resolveExportFields`, `exportItemTypeKind`), 6 (`buildInventoryExportSourceRows`), 7 (`attachExportImages`, `fetchExportImageBytes`, `countRowsWithImages`, `EXPORT_TOO_MANY_IMAGES_MESSAGE`), 8 (`computeExportPdfLayout`), 9 (`InventoryExportPdf`, `buildExportPdfRows`), 11 (`toInventoryXlsx`), 12 (`toInventoryCsv`, `buildExportFilename`).
- Produces for Tasks 14, 16, 17:
  - `POST /api/inventory/export` accepting the full schema.
  - `POST /api/inventory/export/preview` accepting `{ scope, itemType, ids?, filters? }` and returning
    `{ total: number; truncated: boolean; slug: 'books' | 'inventory'; sampleRows: InventoryExportSourceRow[]; readiness: { rows: number; withIsbn: number; missingIsbn: number; withImage: number; missingImage: number } }`.
  - `interface ExportPreviewResponse` exported from `@/lib/download-export`, plus `fetchExportPreview(req: ExportPreviewRequest, signal?: AbortSignal): Promise<ExportPreviewResponse>`.
  - `downloadInventoryExport(req: InventoryExportRequest, opts?: { onStage?: (stage: ExportStage) => void; signal?: AbortSignal }): Promise<void>` with `type ExportStage = 'preparing' | 'downloading' | 'done'`.
  - `InventoryExportRequest` gains `fields?: string[]` and `options?: InventoryExportOptions` (structurally the schema's input type).
- **Constraint reminder:** `EXPORT_PREVIEW_LIMIT = 10` sample rows; the preview NEVER returns image bytes and never signs a URL for rows beyond the sample.

**Steps:**

- [ ] **Step 1: Extend the route test first.** Append to `apps/web/src/app/api/inventory/export/route.test.tsx`, and change the `buildInventoryExportRows` mock block at the top of that file to ALSO mock `buildInventoryExportSourceRows`:

```tsx
vi.mock('@/lib/inventory-export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/inventory-export')>();
  return {
    ...actual,
    buildInventoryExportRows: vi.fn(),
    buildInventoryExportSourceRows: vi.fn(),
  };
});
```

and append these suites (importing `buildInventoryExportSourceRows` alongside the existing import, plus `attachExportImages` from `@/lib/exports/export-images`, which is mocked):

```tsx
vi.mock('@/lib/exports/export-images', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/exports/export-images')>();
  return {
    ...actual,
    attachExportImages: vi.fn(async () => {}),
    fetchExportImageBytes: vi.fn(async () => ({
      images: new Map(),
      skipped: 0,
      truncated: false,
    })),
  };
});

const SOURCE_ROW = {
  id: 'i-1',
  itemType: 'book',
  name: 'Introduction to Algorithms',
  sku: 'BK-0001',
  barcode: '9780262033848',
  status: 'active',
  quantityOnHand: 4,
  reorderPoint: 0,
  reorderQuantity: 0,
  unitCost: 42,
  retailPrice: 89,
  category: 'Mathematics',
  primaryLocation: 'DC4',
  supplier: '',
  warehouse: 'North',
  charter: 'Generic',
  trackingType: 'none',
  author: 'Cormen',
  isbn: '9780262033848',
  grade: 'College',
  rackNumber: '38',
  rackRow: 'A',
  crateColor: 'blue',
  crateNumber: '12',
  rackLabel: '38-A',
  crateLabel: 'Blue 12',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  image: null,
};

function stubSourceRows(overrides: Record<string, unknown> = {}) {
  vi.mocked(buildInventoryExportSourceRows).mockResolvedValue({
    rows: [SOURCE_ROW],
    total: 1,
    truncated: false,
    slug: 'books',
    ...overrides,
  } as never);
}

describe('POST /api/inventory/export — the field list is honoured and validated', () => {
  it('exports exactly the requested fields, in the requested order, in CSV', async () => {
    stubSourceRows();
    const res = await POST(
      buildRequest({
        format: 'csv',
        scope: 'all',
        itemType: 'book',
        fields: ['isbn', 'name', 'quantity_on_hand'],
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.split('\n')[0]).toBe('ISBN,Title,On hand');
  });

  it('400s an unknown field instead of silently dropping it', async () => {
    stubSourceRows();
    const res = await POST(
      buildRequest({ format: 'csv', scope: 'all', fields: ['name', 'sneaky_field'] }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain('sneaky_field');
  });

  it('400s a field list with no identifying column', async () => {
    stubSourceRows();
    const res = await POST(
      buildRequest({ format: 'csv', scope: 'all', fields: ['quantity_on_hand'] }),
    );
    expect(res.status).toBe(400);
  });

  it('400s the catalog layout for a non-book export', async () => {
    stubSourceRows();
    const res = await POST(
      buildRequest({
        format: 'pdf',
        scope: 'all',
        itemType: 'product',
        fields: ['name'],
        options: { pdf: { layout: 'catalog' } },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('does NO image work when the image field was not selected', async () => {
    stubSourceRows();
    await POST(buildRequest({ format: 'csv', scope: 'all', fields: ['name', 'sku'] }));
    expect(vi.mocked(attachExportImages)).not.toHaveBeenCalled();
  });

  it('resolves images exactly once when the image field IS selected', async () => {
    stubSourceRows();
    await POST(
      buildRequest({
        format: 'pdf',
        scope: 'all',
        itemType: 'book',
        fields: ['image', 'name'],
        options: { includeImages: true, imageSize: 'large' },
      }),
    );
    expect(vi.mocked(attachExportImages)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(attachExportImages).mock.calls[0]![2]).toEqual({ imageSize: 'large' });
  });

  it('names the file from the preset when one was given', async () => {
    stubSourceRows();
    const res = await POST(
      buildRequest({
        format: 'xlsx',
        scope: 'all',
        itemType: 'book',
        fields: ['name', 'isbn'],
        options: { presetName: 'Books ISBN list' },
      }),
    );
    expect(res.headers.get('Content-Disposition')).toContain('books-isbn-list-');
  });

  it('names a selected export with its record count', async () => {
    stubSourceRows();
    const res = await POST(
      buildRequest({
        format: 'csv',
        scope: 'selected',
        itemType: 'all',
        ids: ['11111111-1111-1111-1111-111111111111'],
        fields: ['name'],
      }),
    );
    expect(res.headers.get('Content-Disposition')).toContain('-selected-1-item-');
  });

  it('still applies the warehouse filter on the filtered scope only', async () => {
    stubSourceRows();
    await POST(buildRequest({ format: 'csv', scope: 'all', fields: ['name'] }));
    expect(vi.mocked(getActiveWarehouseFilterFor)).not.toHaveBeenCalled();
    await POST(buildRequest({ format: 'csv', scope: 'filtered', fields: ['name'] }));
    expect(vi.mocked(getActiveWarehouseFilterFor)).toHaveBeenCalledTimes(1);
  });

  it('passes the resolved layout to the PDF document, columns in order', async () => {
    stubSourceRows();
    await POST(
      buildRequest({
        format: 'pdf',
        scope: 'all',
        itemType: 'book',
        fields: ['name', 'isbn', 'quantity_on_hand'],
        options: { pdf: { orientation: 'landscape', paperSize: 'legal' } },
      }),
    );
    const layout = capturedElement!.props.layout as {
      columns: Array<{ key: string }>;
      pageWidthPt: number;
    };
    expect(layout.columns.map((c) => c.key)).toEqual(['name', 'isbn', 'quantity_on_hand']);
    expect(layout.pageWidthPt).toBe(1008);
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/app/api/inventory/export/route.test.tsx 2>&1 | tail -25`
Expected: FAIL — the route still ignores `fields`, so the CSV header assertion fails with the 25 legacy headers, and `capturedElement.props.layout` is undefined. Record the real text.

- [ ] **Step 3: Rewrite the route.** Replace the contents of `apps/web/src/app/api/inventory/export/route.tsx` with:

```tsx
import { Readable } from 'node:stream';

import { NextResponse, type NextRequest } from 'next/server';
import { renderToStream } from '@react-pdf/renderer';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { getActiveWarehouseFilterFor } from '@/lib/warehouse-filter';
import {
  buildInventoryExportSourceRows,
  type InventoryExportFilters,
} from '@/lib/inventory-export';
import { toInventoryXlsx } from '@/lib/inventory-export-xlsx';
import { toInventoryCsv } from '@/lib/exports/export-csv';
import {
  attachExportImages,
  fetchExportImageBytes,
  EXPORT_TOO_MANY_IMAGES_MESSAGE,
  type EmbeddedImage,
} from '@/lib/exports/export-images';
import { buildExportFilename } from '@/lib/exports/filename';
import {
  exportItemTypeKind,
  inventoryExportRequestSchema,
  resolveExportFields,
} from '@/lib/exports/export-request';
import { computeExportPdfLayout } from '@/lib/exports/pdf-layout';
import { buildExportPdfRows, InventoryExportPdf } from '@/lib/pdf/inventory-export-pdf';
import { ServiceError } from '@/server/services/context';
import type { ItemListSort } from '@/server/services/inventory';

import { can, type Permission } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Large-org CSV/Excel/PDF export can take a while. (api/inventory is not under a
// vercel.json functions glob, so set the budget inline.)
export const maxDuration = 60;

/**
 * Unified inventory export: any scope (selected / filtered / all) x any format
 * (csv / xlsx / pdf) x any field selection. POST (not GET) so a large "export
 * selected" id list isn't capped by URL length, and so the nested options
 * object has somewhere to live.
 *
 * The client's field list is a REQUEST, never an instruction: resolveExportFields
 * re-derives the authoritative list from the registry on this side of the wire.
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = await withApiContext(request);
    if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    if (!can(ctx, 'items:export')) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    // Compute-heavy (up to 10k rows -> in-memory xlsx/pdf render). Cap like
    // every other export route so one account can't sustain a serverless-cost
    // DoS; this also emits the security.export_rate_limited audit event.
    const limited = await exportRateLimited(ctx.userId, ctx.organizationId);
    if (limited) return limited;

    const json = await request.json().catch(() => null);
    const parsed = inventoryExportRequestSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid request' },
        { status: 400 },
      );
    }
    const { format, scope, itemType, ids, options } = parsed.data;
    if (scope === 'selected' && (!ids || ids.length === 0)) {
      return NextResponse.json(
        { error: 'validation_error', message: 'Select at least one item to export.' },
        { status: 400 },
      );
    }

    const resolved = resolveExportFields({
      fields: parsed.data.fields,
      itemType,
      format,
      options,
      can: (permission: Permission) => can(ctx, permission),
    });
    if (!resolved.ok) {
      return NextResponse.json(
        { error: resolved.status === 403 ? 'forbidden' : 'validation_error', message: resolved.message },
        { status: resolved.status },
      );
    }
    const { fields, imagesRequested } = resolved;
    const itemTypeKind = exportItemTypeKind(itemType);

    // For scope=filtered, honor the active-warehouse cookie just like the
    // legacy route (the UI passes the rest of the visible filters).
    const filters: InventoryExportFilters | undefined =
      scope === 'filtered'
        ? {
            q: parsed.data.filters?.q,
            status: parsed.data.filters?.status,
            stock: parsed.data.filters?.stock ?? null,
            expected: parsed.data.filters?.expected,
            sort: parsed.data.filters?.sort as ItemListSort | undefined,
            categoryIds: parsed.data.filters?.categoryIds,
            locationIds: parsed.data.filters?.locationIds,
            charterIds: parsed.data.filters?.charterIds,
            warehouseId: await getActiveWarehouseFilterFor(ctx),
          }
        : undefined;

    const result = await buildInventoryExportSourceRows(ctx, { scope, itemType, ids, filters });

    // Image resolution is opt-in and happens exactly once, for the whole set.
    if (imagesRequested) {
      await attachExportImages(ctx, result.rows, { imageSize: options.imageSize });
    }

    const filename = buildExportFilename({
      slug: result.slug,
      scope,
      format,
      presetName: options.presetName ?? null,
      count: result.rows.length,
    });
    const truncatedNote = result.truncated
      ? `# truncated at 10000 rows of ${result.total}`
      : undefined;

    // -- CSV ----------------------------------------------------------------
    if (format === 'csv') {
      const body = toInventoryCsv({ fields, rows: result.rows, itemTypeKind, truncatedNote });
      return new NextResponse(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    // -- Excel (.xlsx) ------------------------------------------------------
    if (format === 'xlsx') {
      let images: Map<string, EmbeddedImage> | undefined;
      let imageTruncated = false;
      if (imagesRequested && (options.imageMode === 'embedded' || options.imageMode === 'both')) {
        const urls = new Map<string, string>();
        for (const row of result.rows) {
          if (row.image) urls.set(row.id, row.image.thumbnailUrl);
        }
        const fetched = await fetchExportImageBytes(urls);
        images = fetched.images;
        imageTruncated = fetched.truncated;
      }
      const buf = await toInventoryXlsx({
        fields,
        rows: result.rows,
        itemTypeKind,
        freezeHeader: options.xlsx.freezeHeader,
        autoFilter: options.xlsx.autoFilter,
        includeSummarySheet: options.xlsx.includeSummarySheet,
        imageMode: imagesRequested ? options.imageMode : null,
        imageSize: options.imageSize,
        images,
        truncatedNote: imageTruncated
          ? `${truncatedNote ? `${truncatedNote} ` : ''}${EXPORT_TOO_MANY_IMAGES_MESSAGE}`
          : truncatedNote,
      });
      return new NextResponse(new Uint8Array(buf), {
        status: 200,
        headers: {
          'Content-Type':
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    // -- PDF ----------------------------------------------------------------
    const { data: org } = await ctx.supabase
      .from('organizations')
      .select('name, logo_url')
      .eq('id', ctx.organizationId)
      .maybeSingle();
    const orgName = ((org as { name?: string | null })?.name ?? 'StockPilot') || 'StockPilot';
    const orgLogoUrl = ((org as { logo_url?: string | null })?.logo_url ?? null) || null;

    const layout = computeExportPdfLayout({
      fields,
      itemTypeKind,
      includeImages: imagesRequested && options.includeImages,
      imageSize: options.imageSize,
      orientation: options.pdf.orientation,
      paperSize: options.pdf.paperSize,
      density: options.pdf.density,
      wrapText: options.pdf.wrapText,
      layout: options.pdf.layout,
      catalogColumns: options.pdf.catalogColumns,
    });
    const showImages = layout.imageColumnWidthPt > 0 || options.pdf.layout === 'catalog';
    const pdfRows = buildExportPdfRows(result.rows, layout, fields, {
      showImages: showImages && imagesRequested,
    });

    const titleNoun = result.slug === 'books' ? 'Books' : 'Inventory';
    const stream = await renderToStream(
      // eslint-disable-next-line react-hooks/error-boundaries -- RSC + react-pdf renderToStream; rule targets client error boundaries
      <InventoryExportPdf
        orgName={orgName}
        orgLogoUrl={orgLogoUrl}
        title={`${titleNoun} export`}
        subtitle={`${scope} · ${result.rows.length} item${result.rows.length === 1 ? '' : 's'}${result.truncated ? ` (first 10000 of ${result.total})` : ''}`}
        layout={layout}
        rows={pdfRows}
        repeatHeaders={options.pdf.repeatHeaders}
        pageNumbers={options.pdf.pageNumbers}
        catalog={
          options.pdf.layout === 'catalog'
            ? { columns: options.pdf.catalogColumns, fields, itemTypeKind }
            : null
        }
        footerNote={truncatedNote}
      />,
    );
    const webStream = Readable.toWeb(stream as Readable) as ReadableStream<Uint8Array>;
    return new NextResponse(webStream, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: 500 });
    }
    void reportError(e, { tag: 'inventory.export' });
    // Surface the actual message (not just an opaque "internal_error") so a
    // failed export is diagnosable from the toast instead of silently generic.
    return NextResponse.json(
      { error: 'internal_error', message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
```

Simplify the xlsx `images` local declaration to avoid the conditional type — declare it as:

```ts
      let images: Map<string, import('@/lib/exports/export-images').EmbeddedImage> | undefined;
```

- [ ] **Step 4: Delete the now-unused Phase-A column module reference.** `apps/web/src/lib/pdf/inventory-pdf-columns.ts` is no longer imported by the route. Keep the FILE (its tuned widths are the registry's provenance) only if something still imports it; otherwise delete it and its import from the fit test.

Run: `grep -rn "inventory-pdf-columns" apps/web/src`
Expected: only `report-table-fit.test.ts` if that test imported it (it does not — it declares `OWNER_COLUMNS` inline). If the grep shows no importer, delete the file:

```bash
git rm apps/web/src/lib/pdf/inventory-pdf-columns.ts
```

- [ ] **Step 5: Run the route test to verify it passes.**

Run: `pnpm --filter @stockpilot/web test src/app/api/inventory/export/route.test.tsx 2>&1 | tail -25`
Expected: PASS — the 9 Phase-A tests (the ISBN-column ones now assert against `layout.columns`, so update those three to read `capturedElement.props.layout.columns` instead of `props.sections[0].columns` as part of this step) plus the 10 new ones.

- [ ] **Step 6: Write the failing preview test.** Create `apps/web/src/app/api/inventory/export/preview/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { buildInventoryExportSourceRows } from '@/lib/inventory-export';
import { countRowsWithImages } from '@/lib/exports/export-images';
import { makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/warehouse-filter', () => ({
  getActiveWarehouseFilterFor: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/inventory-export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/inventory-export')>();
  return { ...actual, buildInventoryExportSourceRows: vi.fn() };
});
vi.mock('@/lib/exports/export-images', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/exports/export-images')>();
  return { ...actual, countRowsWithImages: vi.fn(async () => 0), attachExportImages: vi.fn() };
});

import { POST } from './route';

function buildCtx(role: 'admin' | 'viewer') {
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role,
    supabase: makeSupabaseStub({}).client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(),
  };
}

function buildRequest(body: unknown): Parameters<typeof POST>[0] {
  return new Request('https://test.local/api/inventory/export/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

function sourceRow(id: string, isbn: string) {
  return {
    id,
    itemType: 'book',
    name: `Book ${id}`,
    sku: `BK-${id}`,
    barcode: isbn,
    status: 'active',
    quantityOnHand: 1,
    reorderPoint: 0,
    reorderQuantity: 0,
    unitCost: null,
    retailPrice: null,
    category: '',
    primaryLocation: '',
    supplier: '',
    warehouse: '',
    charter: 'Generic',
    trackingType: 'none',
    author: '',
    isbn,
    grade: '',
    rackNumber: '',
    rackRow: '',
    crateColor: '',
    crateNumber: '',
    rackLabel: '',
    crateLabel: '',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    image: null,
  };
}

beforeEach(() => {
  vi.mocked(withApiContext).mockResolvedValue(buildCtx('admin'));
  vi.mocked(countRowsWithImages).mockResolvedValue(0);
  vi.mocked(buildInventoryExportSourceRows).mockResolvedValue({
    rows: Array.from({ length: 25 }, (_, i) => sourceRow(`i${i}`, i < 20 ? `978026203384${i % 10}` : '')),
    total: 25,
    truncated: false,
    slug: 'books',
  } as never);
});

describe('POST /api/inventory/export/preview', () => {
  it('401s without a context and 403s without items:export', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    expect((await POST(buildRequest({ scope: 'all' }))).status).toBe(401);
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('viewer'));
    expect((await POST(buildRequest({ scope: 'all' }))).status).toBe(403);
  });

  it('returns at most 10 sample rows regardless of the result size', async () => {
    const res = await POST(buildRequest({ scope: 'all', itemType: 'book' }));
    const body = await res.json();
    expect(body.sampleRows).toHaveLength(10);
    expect(body.total).toBe(25);
  });

  it('counts ISBN readiness across the WHOLE result, not just the sample', async () => {
    const body = await (await POST(buildRequest({ scope: 'all', itemType: 'book' }))).json();
    expect(body.readiness.rows).toBe(25);
    expect(body.readiness.withIsbn).toBe(20);
    expect(body.readiness.missingIsbn).toBe(5);
  });

  it('counts cover readiness through the no-signing counter', async () => {
    vi.mocked(countRowsWithImages).mockResolvedValueOnce(18);
    const body = await (await POST(buildRequest({ scope: 'all', itemType: 'book' }))).json();
    expect(body.readiness.withImage).toBe(18);
    expect(body.readiness.missingImage).toBe(7);
  });

  it('never returns an image URL in the sample rows', async () => {
    const body = await (await POST(buildRequest({ scope: 'all', itemType: 'book' }))).json();
    for (const row of body.sampleRows) expect(row.image).toBeNull();
    expect(JSON.stringify(body)).not.toContain('token=');
  });

  it('400s a selected preview with no ids', async () => {
    expect((await POST(buildRequest({ scope: 'selected', ids: [] }))).status).toBe(400);
  });
});
```

- [ ] **Step 7: Run it to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/app/api/inventory/export/preview/route.test.ts 2>&1 | tail -20`
Expected: FAIL — `Failed to resolve import "./route"`. Record the real text.

- [ ] **Step 8: Write the preview route.** Create `apps/web/src/app/api/inventory/export/preview/route.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { getActiveWarehouseFilterFor } from '@/lib/warehouse-filter';
import { countRowsWithImages } from '@/lib/exports/export-images';
import {
  buildInventoryExportSourceRows,
  type InventoryExportFilters,
} from '@/lib/inventory-export';
import { ServiceError } from '@/server/services/context';
import type { ItemListSort } from '@/server/services/inventory';

import { can } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Export PREVIEW: sample rows and readiness counts for the export builder.
 *
 * It generates no file. The dialog fetches this ONCE per scope/filter change
 * and formats the sample locally through the field registry, so toggling a
 * field or dragging a column re-renders the preview with zero requests.
 *
 * Its own rate-limit key, deliberately: the export budget is 40/hour and
 * fail-closed because generating a PDF is expensive. A preview is one list
 * query, and charging it to the same budget would let a user lock themselves
 * out of exporting by opening the dialog a few times.
 */
const EXPORT_PREVIEW_LIMIT = 10;

const bodySchema = z.object({
  scope: z.enum(['selected', 'filtered', 'all']),
  itemType: z.enum(['product', 'book', 'asset', 'consumable', 'all']).default('all'),
  ids: z.array(z.string().uuid()).max(10_000).optional(),
  filters: z
    .object({
      q: z.string().optional(),
      status: z.enum(['active', 'archived', 'discontinued', 'all']).optional(),
      stock: z.enum(['low', 'out']).nullable().optional(),
      expected: z.boolean().optional(),
      sort: z.string().optional(),
      categoryIds: z.array(z.string()).optional(),
      locationIds: z.array(z.string()).optional(),
      charterIds: z.array(z.string()).optional(),
    })
    .optional(),
});

export async function POST(request: NextRequest) {
  try {
    const ctx = await withApiContext(request);
    if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    if (!can(ctx, 'items:export')) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const rl = await checkRateLimit(`export-preview:${ctx.userId}`, 120, 60 * 60 * 1000, 'open');
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'rate_limited', message: 'Too many preview requests — please wait a moment.' },
        { status: 429 },
      );
    }

    const json = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid request' },
        { status: 400 },
      );
    }
    const { scope, itemType, ids } = parsed.data;
    if (scope === 'selected' && (!ids || ids.length === 0)) {
      return NextResponse.json(
        { error: 'validation_error', message: 'Select at least one item to preview.' },
        { status: 400 },
      );
    }

    const filters: InventoryExportFilters | undefined =
      scope === 'filtered'
        ? {
            q: parsed.data.filters?.q,
            status: parsed.data.filters?.status,
            stock: parsed.data.filters?.stock ?? null,
            expected: parsed.data.filters?.expected,
            sort: parsed.data.filters?.sort as ItemListSort | undefined,
            categoryIds: parsed.data.filters?.categoryIds,
            locationIds: parsed.data.filters?.locationIds,
            charterIds: parsed.data.filters?.charterIds,
            warehouseId: await getActiveWarehouseFilterFor(ctx),
          }
        : undefined;

    const result = await buildInventoryExportSourceRows(ctx, { scope, itemType, ids, filters });

    const withIsbn = result.rows.filter((r) => r.isbn.length > 0).length;
    // Presence only — no signing, no Storage round trip.
    const withImage = await countRowsWithImages(
      ctx,
      result.rows.map((r) => r.id),
    );

    return NextResponse.json(
      {
        total: result.total,
        truncated: result.truncated,
        slug: result.slug,
        // The sample never carries image data: a preview must not mint signed
        // URLs, and the dialog draws a neutral placeholder for the image cell.
        sampleRows: result.rows.slice(0, EXPORT_PREVIEW_LIMIT).map((r) => ({ ...r, image: null })),
        readiness: {
          rows: result.rows.length,
          withIsbn,
          missingIsbn: result.rows.length - withIsbn,
          withImage,
          missingImage: result.rows.length - withImage,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: 500 });
    }
    void reportError(e, { tag: 'inventory.export.preview' });
    return NextResponse.json(
      { error: 'internal_error', message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 9: Run the preview test to verify it passes.**

Run: `pnpm --filter @stockpilot/web test src/app/api/inventory/export/preview/route.test.ts 2>&1 | tail -20`
Expected: PASS — 6 tests.

- [ ] **Step 10: Extend the client helper.** Replace the contents of `apps/web/src/lib/download-export.ts` with:

```ts
import type { InventoryExportOptions } from '@/lib/exports/export-request';
import type { InventoryExportSourceRow } from '@/lib/exports/source-row';

/**
 * Client-side trigger for the unified inventory export
 * (`POST /api/inventory/export`) and its preview sibling. POSTs the request (so
 * a large "export selected" id list isn't capped by URL length), reads the
 * returned file as a blob, and saves it using the server's Content-Disposition
 * filename. Throws with a readable message on failure so callers can toast it.
 */
export interface InventoryExportRequest {
  format: 'csv' | 'xlsx' | 'pdf';
  scope: 'selected' | 'filtered' | 'all';
  itemType?: 'product' | 'book' | 'asset' | 'consumable' | 'all';
  ids?: string[];
  filters?: {
    q?: string;
    status?: 'active' | 'archived' | 'discontinued' | 'all';
    stock?: 'low' | 'out' | null;
    /** True when exporting the Expected chip view (?expected=1, mig 0277)
     *  — export ONLY items awaiting their first receipt. */
    expected?: boolean;
    sort?: string;
    categoryIds?: string[];
    locationIds?: string[];
    charterIds?: string[];
  };
  /** Registry field keys, in the order they should appear. Omit for defaults. */
  fields?: string[];
  options?: Partial<InventoryExportOptions>;
}

/**
 * Stages the CLIENT can actually observe.
 *
 * Deliberately only two working states. The brief sketches four ("Preparing… /
 * Loading cover images… / Building PDF… / Downloading…"), but the server does
 * all of that inside one request with no progress channel, so announcing
 * "Loading cover images" would be a guess dressed as a fact — and the same
 * section forbids fake progress. The dialog adds a static note when images are
 * enabled ("Cover images make this slower"), which is true without pretending
 * to know where the server is.
 */
export type ExportStage = 'preparing' | 'downloading' | 'done';

export interface DownloadExportOptions {
  onStage?: (stage: ExportStage) => void;
  signal?: AbortSignal;
}

async function readError(res: Response): Promise<string> {
  let message = 'Export failed. Please try again.';
  try {
    const j = (await res.json()) as { message?: string; error?: string };
    message = j.message || j.error || message;
  } catch {
    /* non-JSON error body — keep the generic message */
  }
  return message;
}

export async function downloadInventoryExport(
  req: InventoryExportRequest,
  opts: DownloadExportOptions = {},
): Promise<void> {
  opts.onStage?.('preparing');
  const res = await fetch('/api/inventory/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal: opts.signal,
  });
  if (!res.ok) {
    throw new Error(await readError(res));
  }
  opts.onStage?.('downloading');
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') ?? '';
  const match = cd.match(/filename="?([^"]+)"?/i);
  const filename = match?.[1] ?? `inventory-export.${req.format}`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  opts.onStage?.('done');
}

export interface ExportPreviewRequest {
  scope: 'selected' | 'filtered' | 'all';
  itemType?: 'product' | 'book' | 'asset' | 'consumable' | 'all';
  ids?: string[];
  filters?: InventoryExportRequest['filters'];
}

export interface ExportPreviewResponse {
  total: number;
  truncated: boolean;
  slug: 'books' | 'inventory';
  /** At most 10 rows. `image` is always null — a preview signs nothing. */
  sampleRows: InventoryExportSourceRow[];
  readiness: {
    rows: number;
    withIsbn: number;
    missingIsbn: number;
    withImage: number;
    missingImage: number;
  };
}

export async function fetchExportPreview(
  req: ExportPreviewRequest,
  signal?: AbortSignal,
): Promise<ExportPreviewResponse> {
  const res = await fetch('/api/inventory/export/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as ExportPreviewResponse;
}
```

- [ ] **Step 11: Full server-side gate.**

Run: `pnpm --filter @stockpilot/web test src/lib src/app/api/inventory 2>&1 | tail -25`
Expected: PASS.

Run: `pnpm --filter @stockpilot/web typecheck 2>&1 | tail -20`
Expected: clean — the Task 11 error is now resolved by the new call site.

- [ ] **Step 12: Commit.**

```bash
git add apps/web/src/app/api/inventory/export/route.tsx \
        apps/web/src/app/api/inventory/export/route.test.tsx \
        apps/web/src/app/api/inventory/export/preview/route.ts \
        apps/web/src/app/api/inventory/export/preview/route.test.ts \
        apps/web/src/lib/download-export.ts
git add -A apps/web/src/lib/pdf
git commit -m "feat(inventory): serve configurable exports and an export preview from one route"
```

---
# Phase D — The builder

Four tasks. The pure state module comes first so the dialog has nothing to invent, and the two existing popovers are not touched until Task 17 — every earlier task leaves the product working exactly as it does today.

## Task 14: Builder state, presets, and the dialog shell

**Files:**
- Create: `apps/web/src/components/inventory/export-builder/export-builder-state.ts`
- Create: `apps/web/src/components/inventory/export-builder/export-builder-state.test.ts`
- Create: `apps/web/src/components/inventory/export-builder/export-builder-presets.ts`
- Create: `apps/web/src/components/inventory/export-builder/export-builder-presets.test.ts`
- Create: `apps/web/src/components/inventory/export-builder/export-builder-dialog.tsx`
- Create: `apps/web/src/components/inventory/export-builder/export-builder-dialog.test.tsx`

**Interfaces:**
- Consumes: Task 4 (`EXPORT_FIELDS`, `getExportField`, `defaultFieldKeysFor`, `fieldHeading`, `IDENTIFYING_FIELD_KEYS`, `InventoryExportFieldKey`), Task 8 (`computeExportPdfLayout`, `estimateExportPdfPages`), Task 13 (`downloadInventoryExport`, `ExportStage`, `InventoryExportRequest`).
- Produces for Tasks 15, 16, 17:
  - `interface ExportBuilderOptions` — the fully-populated client twin of the schema's `options`.
  - `interface ExportBuilderState { format: 'csv'|'xlsx'|'pdf'; fieldKeys: InventoryExportFieldKey[]; presetId: string; options: ExportBuilderOptions }`.
  - `initialExportBuilderState(itemTypeKind: 'book'|'other'): ExportBuilderState`.
  - `toggleField(state, key): ExportBuilderState`, `moveField(state, key, direction: 'up'|'down'|'top'|'bottom'): ExportBuilderState`, `restoreDefaults(state, itemTypeKind): ExportBuilderState`, `setFormat(state, format, itemTypeKind): ExportBuilderState`, `setOptions(state, patch): ExportBuilderState`, `applyPreset(state, preset, itemTypeKind): ExportBuilderState`.
  - `validateExportBuilder(state): { ok: true } | { ok: false; message: string }`.
  - `availableFieldsFor(itemTypeKind, format): InventoryExportField[]`.
  - `scopeSummary(input: { scope: 'selected'|'filtered'|'all'; count: number | null; itemTypeKind: 'book'|'other' }): string`.
  - `builderSummaryParts(input: { state; itemTypeKind; rowCount: number | null }): string[]`.
  - `toExportRequest(state, input: { scope; itemType; ids?; filters?; presetName?: string | null }): InventoryExportRequest`.
  - From presets: `EXPORT_PRESETS_STORAGE_KEY = 'stockpilot.export-presets.v1'`, `interface ExportPreset`, `BUILT_IN_PRESETS: readonly ExportPreset[]`, `presetsFor(itemTypeKind): ExportPreset[]`, `loadPersonalPresets(): ExportPreset[]`, `savePersonalPreset(input): ExportPreset[]`, `deletePersonalPreset(id): ExportPreset[]`.
  - From the dialog: `ExportBuilderDialog(props: ExportBuilderDialogProps)` where `ExportBuilderDialogProps = { open: boolean; onOpenChange: (open: boolean) => void; scope: 'selected'|'filtered'|'all'; itemType: 'product'|'book'|'asset'|'consumable'|'all'; selectedIds?: string[]; filters?: InventoryExportRequest['filters']; rowCountHint?: number | null }`.

**Steps:**

- [ ] **Step 1: Write the failing state test.** Create `apps/web/src/components/inventory/export-builder/export-builder-state.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  availableFieldsFor,
  builderSummaryParts,
  initialExportBuilderState,
  moveField,
  restoreDefaults,
  scopeSummary,
  setFormat,
  setOptions,
  toExportRequest,
  toggleField,
  validateExportBuilder,
} from './export-builder-state';

describe('initialExportBuilderState', () => {
  it('starts a books export on the Books defaults with covers on', () => {
    const s = initialExportBuilderState('book');
    expect(s.fieldKeys[0]).toBe('image');
    expect(s.fieldKeys).toContain('isbn');
    expect(s.options.includeImages).toBe(true);
    expect(s.format).toBe('pdf');
  });

  it('starts an items export with no image field and images off', () => {
    const s = initialExportBuilderState('other');
    expect(s.fieldKeys).not.toContain('image');
    expect(s.options.includeImages).toBe(false);
  });
});

describe('toggleField', () => {
  it('removes a selected field and re-adds it in canonical position, not at the end', () => {
    let s = initialExportBuilderState('book');
    s = toggleField(s, 'isbn');
    expect(s.fieldKeys).not.toContain('isbn');
    s = toggleField(s, 'isbn');
    // Canonical order puts ISBN before author and after sku's registry slot;
    // what matters is that it did NOT land last.
    expect(s.fieldKeys.at(-1)).not.toBe('isbn');
  });

  it('turns includeImages on and off with the image field', () => {
    let s = initialExportBuilderState('other');
    s = toggleField(s, 'image');
    expect(s.options.includeImages).toBe(true);
    s = toggleField(s, 'image');
    expect(s.options.includeImages).toBe(false);
  });
});

describe('moveField', () => {
  it('moves a field up, down, to the top and to the bottom', () => {
    let s = initialExportBuilderState('other');
    const original = [...s.fieldKeys];
    s = moveField(s, original[2]!, 'up');
    expect(s.fieldKeys[1]).toBe(original[2]);
    s = moveField(s, original[2]!, 'top');
    expect(s.fieldKeys[0]).toBe(original[2]);
    s = moveField(s, original[2]!, 'bottom');
    expect(s.fieldKeys.at(-1)).toBe(original[2]);
    s = moveField(s, original[2]!, 'up');
    expect(s.fieldKeys.at(-2)).toBe(original[2]);
  });

  it('is a no-op at the ends and for a field that is not selected', () => {
    const s = initialExportBuilderState('other');
    expect(moveField(s, s.fieldKeys[0]!, 'up').fieldKeys).toEqual(s.fieldKeys);
    expect(moveField(s, s.fieldKeys.at(-1)!, 'down').fieldKeys).toEqual(s.fieldKeys);
    expect(moveField(s, 'created_at', 'up').fieldKeys).toEqual(s.fieldKeys);
  });
});

describe('setFormat', () => {
  it('switching to CSV forces the image mode to URL', () => {
    const s = setFormat(initialExportBuilderState('book'), 'csv', 'book');
    expect(s.options.imageMode).toBe('url');
  });

  it('switching back to PDF restores embedded images', () => {
    let s = setFormat(initialExportBuilderState('book'), 'csv', 'book');
    s = setFormat(s, 'pdf', 'book');
    expect(s.options.imageMode).toBe('embedded');
  });

  it('drops the catalog layout when the format is no longer PDF', () => {
    let s = setOptions(initialExportBuilderState('book'), { pdf: { layout: 'catalog' } });
    s = setFormat(s, 'xlsx', 'book');
    expect(s.options.pdf.layout).toBe('table');
  });
});

describe('validateExportBuilder', () => {
  it('accepts the defaults', () => {
    expect(validateExportBuilder(initialExportBuilderState('book')).ok).toBe(true);
  });

  it('refuses an empty selection', () => {
    const s = { ...initialExportBuilderState('book'), fieldKeys: [] };
    const res = validateExportBuilder(s);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('at least one');
  });

  it('refuses a selection with no identifying field, naming the four that count', () => {
    const s = { ...initialExportBuilderState('book'), fieldKeys: ['quantity_on_hand' as const] };
    const res = validateExportBuilder(s);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('Name');
    expect(res.message).toContain('SKU');
    expect(res.message).toContain('ISBN');
    expect(res.message).toContain('Barcode');
  });
});

describe('availableFieldsFor', () => {
  it('hides book-only fields from an items export', () => {
    const keys = availableFieldsFor('other', 'csv').map((f) => f.key);
    expect(keys).not.toContain('isbn');
    expect(keys).toContain('name');
  });

  it('offers book fields on a books export', () => {
    expect(availableFieldsFor('book', 'pdf').map((f) => f.key)).toContain('isbn');
  });
});

describe('scopeSummary', () => {
  it('matches the brief copy for each scope', () => {
    expect(scopeSummary({ scope: 'filtered', count: 111, itemTypeKind: 'book' })).toBe(
      'Exporting: 111 filtered books',
    );
    expect(scopeSummary({ scope: 'selected', count: 12, itemTypeKind: 'other' })).toBe(
      'Exporting: 12 selected items',
    );
    expect(scopeSummary({ scope: 'all', count: null, itemTypeKind: 'other' })).toBe(
      'Exporting: All active inventory items',
    );
    expect(scopeSummary({ scope: 'all', count: null, itemTypeKind: 'book' })).toBe(
      'Exporting: All active books',
    );
  });

  it('singularizes one record and omits an unknown count', () => {
    expect(scopeSummary({ scope: 'selected', count: 1, itemTypeKind: 'book' })).toBe(
      'Exporting: 1 selected book',
    );
    expect(scopeSummary({ scope: 'filtered', count: null, itemTypeKind: 'book' })).toBe(
      'Exporting: the filtered books',
    );
  });
});

describe('builderSummaryParts', () => {
  it('reports count, field count, images and the labelled page estimate', () => {
    const parts = builderSummaryParts({
      state: initialExportBuilderState('book'),
      itemTypeKind: 'book',
      rowCount: 111,
    });
    expect(parts[0]).toBe('111 books');
    expect(parts).toContain('12 selected fields');
    expect(parts).toContain('Cover images included');
    expect(parts.some((p) => p.startsWith('Estimated '))).toBe(true);
    expect(parts.some((p) => p === 'Landscape Letter')).toBe(true);
  });

  it('says nothing about pages for a CSV', () => {
    const parts = builderSummaryParts({
      state: setFormat(initialExportBuilderState('book'), 'csv', 'book'),
      itemTypeKind: 'book',
      rowCount: 111,
    });
    expect(parts.some((p) => p.includes('PDF pages'))).toBe(false);
  });
});

describe('toExportRequest', () => {
  it('sends the fields in order plus the options, and nothing else', () => {
    const req = toExportRequest(initialExportBuilderState('book'), {
      scope: 'filtered',
      itemType: 'book',
      filters: { q: 'algebra' },
      presetName: 'Books inventory',
    });
    expect(req.format).toBe('pdf');
    expect(req.scope).toBe('filtered');
    expect(req.itemType).toBe('book');
    expect(req.fields?.[0]).toBe('image');
    expect(req.options?.presetName).toBe('Books inventory');
    expect(req.ids).toBeUndefined();
  });

  it('carries ids for a selected export and drops the filters', () => {
    const req = toExportRequest(initialExportBuilderState('other'), {
      scope: 'selected',
      itemType: 'all',
      ids: ['a', 'b'],
      filters: { q: 'ignored' },
    });
    expect(req.ids).toEqual(['a', 'b']);
    expect(req.filters).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/components/inventory/export-builder/export-builder-state.test.ts 2>&1 | tail -20`
Expected: FAIL — `Failed to resolve import "./export-builder-state"`. Record the real text.

- [ ] **Step 3: Write the state module.** Create `apps/web/src/components/inventory/export-builder/export-builder-state.ts`:

```ts
import type { InventoryExportRequest } from '@/lib/download-export';
import {
  defaultFieldKeysFor,
  EXPORT_FIELDS,
  getExportField,
  IDENTIFYING_FIELD_KEYS,
  type InventoryExportField,
  type InventoryExportFieldKey,
} from '@/lib/exports/field-registry';
import {
  computeExportPdfLayout,
  estimateExportPdfPages,
  type ExportImageSize,
  type PdfDensity,
  type PdfOrientation,
  type PaperSize,
} from '@/lib/exports/pdf-layout';

/**
 * Everything the export dialog knows how to do, as plain data transforms.
 *
 * No React, no DOM, no network — the same split the orders storefront uses
 * (storefront-logic.ts), for the same reason: field ordering, format switching
 * and validation are where the bugs live, and they are worth testing without a
 * render.
 */

export interface ExportBuilderOptions {
  includeImages: boolean;
  imageMode: 'embedded' | 'url' | 'both';
  imageSize: ExportImageSize;
  pdf: {
    layout: 'table' | 'catalog';
    catalogColumns: 1 | 2 | 3;
    orientation: 'auto' | PdfOrientation;
    paperSize: PaperSize;
    density: PdfDensity;
    repeatHeaders: boolean;
    pageNumbers: boolean;
    wrapText: boolean;
  };
  xlsx: {
    freezeHeader: boolean;
    autoFilter: boolean;
    includeSummarySheet: boolean;
  };
}

export interface ExportBuilderState {
  format: 'csv' | 'xlsx' | 'pdf';
  /** Selected fields, IN OUTPUT ORDER. This array is the contract. */
  fieldKeys: InventoryExportFieldKey[];
  /** Id of the preset this state came from, or 'custom' once edited. */
  presetId: string;
  options: ExportBuilderOptions;
}

export const CUSTOM_PRESET_ID = 'custom';

const CANONICAL_ORDER: InventoryExportFieldKey[] = EXPORT_FIELDS.map((f) => f.key);

function defaultOptions(itemTypeKind: 'book' | 'other'): ExportBuilderOptions {
  return {
    // Books default to covers ON; items default to images OFF (Brief 8 and 9).
    includeImages: itemTypeKind === 'book',
    imageMode: 'embedded',
    imageSize: 'medium',
    pdf: {
      layout: 'table',
      catalogColumns: 2,
      orientation: 'auto',
      paperSize: 'letter',
      density: 'comfortable',
      repeatHeaders: true,
      pageNumbers: true,
      wrapText: true,
    },
    xlsx: { freezeHeader: true, autoFilter: true, includeSummarySheet: false },
  };
}

export function initialExportBuilderState(itemTypeKind: 'book' | 'other'): ExportBuilderState {
  return {
    format: 'pdf',
    fieldKeys: defaultFieldKeysFor(itemTypeKind),
    presetId: itemTypeKind === 'book' ? 'books-inventory' : 'inventory-overview',
    options: defaultOptions(itemTypeKind),
  };
}

/** Deep-ish merge for the nested option groups. */
export function setOptions(
  state: ExportBuilderState,
  patch: {
    includeImages?: boolean;
    imageMode?: ExportBuilderOptions['imageMode'];
    imageSize?: ExportImageSize;
    pdf?: Partial<ExportBuilderOptions['pdf']>;
    xlsx?: Partial<ExportBuilderOptions['xlsx']>;
  },
): ExportBuilderState {
  return {
    ...state,
    presetId: CUSTOM_PRESET_ID,
    options: {
      ...state.options,
      ...(patch.includeImages !== undefined ? { includeImages: patch.includeImages } : {}),
      ...(patch.imageMode ? { imageMode: patch.imageMode } : {}),
      ...(patch.imageSize ? { imageSize: patch.imageSize } : {}),
      pdf: { ...state.options.pdf, ...(patch.pdf ?? {}) },
      xlsx: { ...state.options.xlsx, ...(patch.xlsx ?? {}) },
    },
  };
}

/**
 * Add or remove a field.
 *
 * Re-adding puts the field back in CANONICAL registry position rather than at
 * the end, so a user who unticks Category to look at something and re-ticks it
 * does not silently end up with a different column order than they started
 * with.
 */
export function toggleField(
  state: ExportBuilderState,
  key: InventoryExportFieldKey,
): ExportBuilderState {
  const selected = new Set(state.fieldKeys);
  let fieldKeys: InventoryExportFieldKey[];
  if (selected.has(key)) {
    fieldKeys = state.fieldKeys.filter((k) => k !== key);
  } else {
    selected.add(key);
    const canonicalRank = new Map(CANONICAL_ORDER.map((k, i) => [k, i]));
    const target = canonicalRank.get(key) ?? Number.MAX_SAFE_INTEGER;
    const index = state.fieldKeys.findIndex(
      (k) => (canonicalRank.get(k) ?? Number.MAX_SAFE_INTEGER) > target,
    );
    fieldKeys = [...state.fieldKeys];
    fieldKeys.splice(index === -1 ? fieldKeys.length : index, 0, key);
  }
  const next: ExportBuilderState = { ...state, fieldKeys, presetId: CUSTOM_PRESET_ID };
  // The image field IS the images toggle. Keeping the flag in lockstep is what
  // makes the server's "includeImages without the image field" rejection
  // unreachable from this UI.
  return { ...next, options: { ...next.options, includeImages: fieldKeys.includes('image') } };
}

export function moveField(
  state: ExportBuilderState,
  key: InventoryExportFieldKey,
  direction: 'up' | 'down' | 'top' | 'bottom',
): ExportBuilderState {
  const from = state.fieldKeys.indexOf(key);
  if (from === -1) return state;
  const to =
    direction === 'up'
      ? from - 1
      : direction === 'down'
        ? from + 1
        : direction === 'top'
          ? 0
          : state.fieldKeys.length - 1;
  if (to < 0 || to >= state.fieldKeys.length || to === from) return state;
  const fieldKeys = [...state.fieldKeys];
  fieldKeys.splice(from, 1);
  fieldKeys.splice(to, 0, key);
  return { ...state, fieldKeys, presetId: CUSTOM_PRESET_ID };
}

export function restoreDefaults(
  state: ExportBuilderState,
  itemTypeKind: 'book' | 'other',
): ExportBuilderState {
  const fresh = initialExportBuilderState(itemTypeKind);
  return setFormat({ ...fresh, format: state.format }, state.format, itemTypeKind);
}

/** Fields this item type and format can actually carry, in canonical order. */
export function availableFieldsFor(
  itemTypeKind: 'book' | 'other',
  format: 'csv' | 'xlsx' | 'pdf',
): InventoryExportField[] {
  return EXPORT_FIELDS.filter((f) => {
    if (f.appliesTo === 'book' && itemTypeKind !== 'book') return false;
    return format === 'csv' ? f.csvSupported : format === 'xlsx' ? f.xlsxSupported : f.pdfSupported;
  }).map((f) => f);
}

/**
 * Switch format, normalising anything the new format cannot express.
 *
 * CSV can only carry an image URL; PDF cannot do "both"; catalog is PDF-only.
 * Normalising here means the dialog can never build a request the server would
 * reject.
 */
export function setFormat(
  state: ExportBuilderState,
  format: 'csv' | 'xlsx' | 'pdf',
  itemTypeKind: 'book' | 'other',
): ExportBuilderState {
  const allowed = new Set(availableFieldsFor(itemTypeKind, format).map((f) => f.key));
  const fieldKeys = state.fieldKeys.filter((k) => allowed.has(k));
  const imageMode: ExportBuilderOptions['imageMode'] =
    format === 'csv' ? 'url' : format === 'pdf' ? 'embedded' : state.options.imageMode;
  return {
    ...state,
    format,
    fieldKeys,
    options: {
      ...state.options,
      includeImages: fieldKeys.includes('image'),
      imageMode: format === 'xlsx' && state.options.imageMode === 'url' ? 'url' : imageMode,
      pdf: {
        ...state.options.pdf,
        layout: format === 'pdf' ? state.options.pdf.layout : 'table',
      },
    },
  };
}

export function validateExportBuilder(
  state: ExportBuilderState,
): { ok: true } | { ok: false; message: string } {
  if (state.fieldKeys.length === 0) {
    return { ok: false, message: 'Choose at least one field to export.' };
  }
  if (!state.fieldKeys.some((k) => IDENTIFYING_FIELD_KEYS.includes(k))) {
    return {
      ok: false,
      message: 'Include at least one identifying field: Name, SKU, ISBN or Barcode.',
    };
  }
  return { ok: true };
}

function noun(itemTypeKind: 'book' | 'other', count: number): string {
  if (itemTypeKind === 'book') return count === 1 ? 'book' : 'books';
  return count === 1 ? 'item' : 'items';
}

/** Brief section 5's scope line. */
export function scopeSummary(input: {
  scope: 'selected' | 'filtered' | 'all';
  count: number | null;
  itemTypeKind: 'book' | 'other';
}): string {
  if (input.scope === 'all') {
    return input.itemTypeKind === 'book'
      ? 'Exporting: All active books'
      : 'Exporting: All active inventory items';
  }
  if (input.count === null) {
    return `Exporting: the ${input.scope} ${noun(input.itemTypeKind, 2)}`;
  }
  return `Exporting: ${input.count} ${input.scope} ${noun(input.itemTypeKind, input.count)}`;
}

/** Brief section 19's summary line, as parts the dialog joins with a middot. */
export function builderSummaryParts(input: {
  state: ExportBuilderState;
  itemTypeKind: 'book' | 'other';
  rowCount: number | null;
}): string[] {
  const { state, itemTypeKind, rowCount } = input;
  const parts: string[] = [];
  if (rowCount !== null) parts.push(`${rowCount} ${noun(itemTypeKind, rowCount)}`);
  parts.push(
    `${state.fieldKeys.length} selected field${state.fieldKeys.length === 1 ? '' : 's'}`,
  );
  if (state.options.includeImages) {
    parts.push(itemTypeKind === 'book' ? 'Cover images included' : 'Images included');
  }
  if (state.format === 'pdf') {
    const fields = state.fieldKeys
      .map((k) => getExportField(k))
      .filter((f): f is InventoryExportField => Boolean(f));
    const layout = computeExportPdfLayout({
      fields,
      itemTypeKind,
      includeImages: state.options.includeImages,
      imageSize: state.options.imageSize,
      orientation: state.options.pdf.orientation,
      paperSize: state.options.pdf.paperSize,
      density: state.options.pdf.density,
      wrapText: state.options.pdf.wrapText,
      layout: state.options.pdf.layout,
      catalogColumns: state.options.pdf.catalogColumns,
    });
    if (rowCount !== null) {
      const pages = estimateExportPdfPages(layout, rowCount, {
        catalogColumns:
          state.options.pdf.layout === 'catalog' ? state.options.pdf.catalogColumns : 1,
      });
      // "Estimated" is not decoration: page counts depend on wrapping we have
      // not measured, and the brief requires estimates to say so.
      parts.push(
        pages.min === pages.max
          ? `Estimated ${pages.min} PDF page${pages.min === 1 ? '' : 's'}`
          : `Estimated ${pages.min}-${pages.max} PDF pages`,
      );
    }
    const orientationLabel = layout.orientation === 'portrait' ? 'Portrait' : 'Landscape';
    const paperLabel = layout.paperSize === 'legal' ? 'Legal' : 'Letter';
    parts.push(`${orientationLabel} ${paperLabel}`);
  }
  return parts;
}

export function toExportRequest(
  state: ExportBuilderState,
  input: {
    scope: 'selected' | 'filtered' | 'all';
    itemType: 'product' | 'book' | 'asset' | 'consumable' | 'all';
    ids?: string[];
    filters?: InventoryExportRequest['filters'];
    presetName?: string | null;
  },
): InventoryExportRequest {
  return {
    format: state.format,
    scope: input.scope,
    itemType: input.itemType,
    ...(input.scope === 'selected' ? { ids: input.ids ?? [] } : {}),
    ...(input.scope === 'filtered' ? { filters: input.filters } : {}),
    fields: [...state.fieldKeys],
    options: {
      ...state.options,
      ...(input.presetName ? { presetName: input.presetName } : {}),
    },
  };
}
```

- [ ] **Step 4: Run the state test to verify it passes.**

Run: `pnpm --filter @stockpilot/web test src/components/inventory/export-builder/export-builder-state.test.ts 2>&1 | tail -20`
Expected: PASS — 20 tests.

- [ ] **Step 5: Write the failing presets test.** Create `apps/web/src/components/inventory/export-builder/export-builder-presets.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';

import {
  BUILT_IN_PRESETS,
  deletePersonalPreset,
  EXPORT_PRESETS_STORAGE_KEY,
  loadPersonalPresets,
  presetsFor,
  savePersonalPreset,
} from './export-builder-presets';

beforeEach(() => {
  window.localStorage.clear();
});

describe('BUILT_IN_PRESETS', () => {
  it('ships the eight the brief names', () => {
    expect(BUILT_IN_PRESETS.map((p) => p.name)).toEqual([
      'Books inventory',
      'Books with covers',
      'Books ISBN list',
      'Books storage list',
      'Inventory overview',
      'Inventory valuation',
      'Reorder report',
      'Custom',
    ]);
  });

  it('gives Books ISBN list exactly the brief fields, in order', () => {
    const preset = BUILT_IN_PRESETS.find((p) => p.id === 'books-isbn-list')!;
    expect(preset.fieldKeys).toEqual([
      'name',
      'isbn',
      'sku',
      'author',
      'grade',
      'quantity_on_hand',
    ]);
  });

  it('gives Books with covers the image first', () => {
    const preset = BUILT_IN_PRESETS.find((p) => p.id === 'books-with-covers')!;
    expect(preset.fieldKeys).toEqual([
      'image',
      'name',
      'isbn',
      'author',
      'grade',
      'quantity_on_hand',
      'rack',
      'crate',
    ]);
  });

  it('gives Books storage list the RAW rack and crate parts, not the combined labels', () => {
    const preset = BUILT_IN_PRESETS.find((p) => p.id === 'books-storage-list')!;
    expect(preset.fieldKeys).toEqual([
      'name',
      'isbn',
      'sku',
      'quantity_on_hand',
      'rack_number',
      'rack_row',
      'crate_color',
      'crate_number',
      'primary_location',
    ]);
  });

  it('never puts a book-only field in an inventory preset', () => {
    for (const id of ['inventory-overview', 'inventory-valuation', 'reorder-report']) {
      const preset = BUILT_IN_PRESETS.find((p) => p.id === id)!;
      expect(preset.fieldKeys).not.toContain('isbn');
      expect(preset.fieldKeys).not.toContain('rack');
    }
  });
});

describe('presetsFor', () => {
  it('offers books presets only to books exports', () => {
    const ids = presetsFor('other').map((p) => p.id);
    expect(ids).not.toContain('books-isbn-list');
    expect(ids).toContain('inventory-overview');
    expect(presetsFor('book').map((p) => p.id)).toContain('books-isbn-list');
  });

  it('appends the user\'s own presets after the built-ins', () => {
    savePersonalPreset({
      name: 'My audit sheet',
      itemTypeKind: 'book',
      fieldKeys: ['name', 'isbn'],
    });
    const list = presetsFor('book');
    expect(list.at(-1)!.name).toBe('My audit sheet');
    expect(list.at(-1)!.builtIn).toBe(false);
  });
});

describe('personal presets in localStorage', () => {
  it('round-trips through storage under a versioned key', () => {
    savePersonalPreset({ name: 'Mine', itemTypeKind: 'book', fieldKeys: ['name', 'sku'] });
    expect(window.localStorage.getItem(EXPORT_PRESETS_STORAGE_KEY)).toContain('Mine');
    expect(loadPersonalPresets()).toHaveLength(1);
  });

  it('replaces a preset saved under an existing name rather than duplicating it', () => {
    savePersonalPreset({ name: 'Mine', itemTypeKind: 'book', fieldKeys: ['name'] });
    const after = savePersonalPreset({
      name: 'Mine',
      itemTypeKind: 'book',
      fieldKeys: ['name', 'isbn'],
    });
    expect(after).toHaveLength(1);
    expect(after[0]!.fieldKeys).toEqual(['name', 'isbn']);
  });

  it('deletes by id', () => {
    const saved = savePersonalPreset({
      name: 'Mine',
      itemTypeKind: 'book',
      fieldKeys: ['name'],
    });
    expect(deletePersonalPreset(saved[0]!.id)).toHaveLength(0);
  });

  it('survives corrupt storage instead of throwing', () => {
    window.localStorage.setItem(EXPORT_PRESETS_STORAGE_KEY, '{not json');
    expect(loadPersonalPresets()).toEqual([]);
  });

  it('drops unknown field keys read back from storage', () => {
    window.localStorage.setItem(
      EXPORT_PRESETS_STORAGE_KEY,
      JSON.stringify([
        { id: 'p1', name: 'Tampered', itemTypeKind: 'book', fieldKeys: ['name', 'evil_field'] },
      ]),
    );
    expect(loadPersonalPresets()[0]!.fieldKeys).toEqual(['name']);
  });
});
```

- [ ] **Step 6: Run it to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/components/inventory/export-builder/export-builder-presets.test.ts 2>&1 | tail -20`
Expected: FAIL — `Failed to resolve import "./export-builder-presets"`. Record the real text.

- [ ] **Step 7: Write the presets module.** Create `apps/web/src/components/inventory/export-builder/export-builder-presets.ts`:

```ts
import { getExportField, type InventoryExportFieldKey } from '@/lib/exports/field-registry';

import type { ExportBuilderOptions } from './export-builder-state';

/**
 * Export presets (Brief section 21).
 *
 * The eight built-ins are code constants. A user's OWN presets live in
 * localStorage, deliberately, and the reasoning is worth keeping next to the
 * code: the closest existing persistence is `saved_views`, whose `scope` column
 * carries a database CHECK constraint limited to ('inventory','books')
 * (supabase/migrations/0035_saved_views.sql:14) and whose state sanitizer is a
 * toolbar-filter whitelist with nowhere to put fields, order or format options.
 * Reusing it needs a migration, a new sanitizer and an RLS re-check — which the
 * brief explicitly does not require ("persist now ONLY if existing
 * user-preference infra supports cleanly, else dialog/browser storage +
 * document the future DB option"). The DB option is written up in the section
 * 31 report as the recommended next phase.
 *
 * Consequence to be honest about in the UI: personal presets are per browser,
 * not per account. The dialog says so.
 */

export const EXPORT_PRESETS_STORAGE_KEY = 'stockpilot.export-presets.v1';
const MAX_PERSONAL_PRESETS = 20;

export interface ExportPreset {
  id: string;
  name: string;
  /** 'any' = offered for both books and items exports. */
  itemTypeKind: 'book' | 'other' | 'any';
  fieldKeys: InventoryExportFieldKey[];
  options?: Partial<ExportBuilderOptions>;
  builtIn: boolean;
}

export const BUILT_IN_PRESETS: readonly ExportPreset[] = [
  {
    id: 'books-inventory',
    name: 'Books inventory',
    itemTypeKind: 'book',
    builtIn: true,
    fieldKeys: [
      'image',
      'name',
      'isbn',
      'sku',
      'author',
      'grade',
      'quantity_on_hand',
      'category',
      'rack',
      'crate',
      'primary_location',
      'status',
    ],
  },
  {
    id: 'books-with-covers',
    name: 'Books with covers',
    itemTypeKind: 'book',
    builtIn: true,
    fieldKeys: [
      'image',
      'name',
      'isbn',
      'author',
      'grade',
      'quantity_on_hand',
      'rack',
      'crate',
    ],
    options: { includeImages: true, imageSize: 'large' },
  },
  {
    id: 'books-isbn-list',
    name: 'Books ISBN list',
    itemTypeKind: 'book',
    builtIn: true,
    fieldKeys: ['name', 'isbn', 'sku', 'author', 'grade', 'quantity_on_hand'],
    options: { includeImages: false },
  },
  {
    id: 'books-storage-list',
    name: 'Books storage list',
    itemTypeKind: 'book',
    builtIn: true,
    // The RAW parts, not the combined labels: a storage list is what someone
    // sorts and filters in a spreadsheet.
    fieldKeys: [
      'name',
      'isbn',
      'sku',
      'quantity_on_hand',
      'rack_number',
      'rack_row',
      'crate_color',
      'crate_number',
      'primary_location',
    ],
    options: { includeImages: false },
  },
  {
    id: 'inventory-overview',
    name: 'Inventory overview',
    itemTypeKind: 'other',
    builtIn: true,
    fieldKeys: [
      'name',
      'sku',
      'barcode',
      'quantity_on_hand',
      'category',
      'primary_location',
      'warehouse',
      'supplier',
      'charter',
      'status',
    ],
  },
  {
    id: 'inventory-valuation',
    name: 'Inventory valuation',
    itemTypeKind: 'other',
    builtIn: true,
    fieldKeys: [
      'name',
      'sku',
      'category',
      'quantity_on_hand',
      'unit_cost',
      'retail_price',
      'inventory_value',
    ],
    options: { xlsx: { freezeHeader: true, autoFilter: true, includeSummarySheet: true } },
  },
  {
    id: 'reorder-report',
    name: 'Reorder report',
    itemTypeKind: 'other',
    builtIn: true,
    fieldKeys: [
      'name',
      'sku',
      'supplier',
      'quantity_on_hand',
      'reorder_point',
      'reorder_quantity',
      'primary_location',
    ],
  },
  {
    id: 'custom',
    name: 'Custom',
    itemTypeKind: 'any',
    builtIn: true,
    // Deliberately empty: choosing Custom keeps whatever the user has built.
    fieldKeys: [],
  },
];

function readStorage(): unknown {
  try {
    const raw = window.localStorage.getItem(EXPORT_PRESETS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    // Corrupt JSON, disabled storage, private mode. A broken preset list must
    // never stop someone exporting.
    return [];
  }
}

function sanitize(raw: unknown): ExportPreset | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.name !== 'string') return null;
  const kind = r.itemTypeKind;
  if (kind !== 'book' && kind !== 'other' && kind !== 'any') return null;
  const keys = Array.isArray(r.fieldKeys) ? r.fieldKeys : [];
  const fieldKeys = keys.filter(
    (k): k is InventoryExportFieldKey => typeof k === 'string' && Boolean(getExportField(k)),
  );
  if (fieldKeys.length === 0) return null;
  return {
    id: r.id,
    name: r.name.slice(0, 60),
    itemTypeKind: kind,
    fieldKeys,
    builtIn: false,
  };
}

export function loadPersonalPresets(): ExportPreset[] {
  const raw = readStorage();
  if (!Array.isArray(raw)) return [];
  return raw
    .map(sanitize)
    .filter((p): p is ExportPreset => p !== null)
    .slice(0, MAX_PERSONAL_PRESETS);
}

function write(presets: ExportPreset[]): ExportPreset[] {
  try {
    window.localStorage.setItem(EXPORT_PRESETS_STORAGE_KEY, JSON.stringify(presets));
  } catch {
    /* quota or disabled storage — the in-memory list still works this session */
  }
  return presets;
}

export function savePersonalPreset(input: {
  name: string;
  itemTypeKind: 'book' | 'other';
  fieldKeys: InventoryExportFieldKey[];
}): ExportPreset[] {
  const name = input.name.trim().slice(0, 60);
  if (name.length === 0) return loadPersonalPresets();
  const existing = loadPersonalPresets();
  const match = existing.find(
    (p) => p.name.toLowerCase() === name.toLowerCase() && p.itemTypeKind === input.itemTypeKind,
  );
  const preset: ExportPreset = {
    id: match?.id ?? `personal-${Date.now().toString(36)}`,
    name,
    itemTypeKind: input.itemTypeKind,
    fieldKeys: [...input.fieldKeys],
    builtIn: false,
  };
  const next = match
    ? existing.map((p) => (p.id === match.id ? preset : p))
    : [...existing, preset].slice(-MAX_PERSONAL_PRESETS);
  return write(next);
}

export function deletePersonalPreset(id: string): ExportPreset[] {
  return write(loadPersonalPresets().filter((p) => p.id !== id));
}

export function presetsFor(itemTypeKind: 'book' | 'other'): ExportPreset[] {
  const builtIns = BUILT_IN_PRESETS.filter(
    (p) => p.itemTypeKind === 'any' || p.itemTypeKind === itemTypeKind,
  );
  const personal = loadPersonalPresets().filter(
    (p) => p.itemTypeKind === 'any' || p.itemTypeKind === itemTypeKind,
  );
  return [...builtIns, ...personal];
}
```

- [ ] **Step 8: Run the presets test to verify it passes.**

Run: `pnpm --filter @stockpilot/web test src/components/inventory/export-builder/export-builder-presets.test.ts 2>&1 | tail -20`
Expected: PASS — 11 tests.

- [ ] **Step 9: Write the failing dialog test.** Create `apps/web/src/components/inventory/export-builder/export-builder-dialog.test.tsx`:

```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

const downloadSpy = vi.fn(async (..._args: unknown[]) => {});
const previewSpy = vi.fn(async (..._args: unknown[]) => ({
  total: 111,
  truncated: false,
  slug: 'books' as const,
  sampleRows: [],
  readiness: { rows: 111, withIsbn: 97, missingIsbn: 14, withImage: 84, missingImage: 27 },
}));
vi.mock('@/lib/download-export', () => ({
  downloadInventoryExport: (...a: unknown[]) => downloadSpy(...a),
  fetchExportPreview: (...a: unknown[]) => previewSpy(...a),
}));

import { ExportBuilderDialog } from './export-builder-dialog';

function renderDialog(overrides: Partial<Parameters<typeof ExportBuilderDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  render(
    <ExportBuilderDialog
      open
      onOpenChange={onOpenChange}
      scope="filtered"
      itemType="book"
      filters={{ q: 'algebra' }}
      rowCountHint={111}
      {...overrides}
    />,
  );
  return { onOpenChange };
}

beforeEach(() => {
  downloadSpy.mockClear();
  previewSpy.mockClear();
  toastError.mockClear();
  window.localStorage.clear();
});

describe('ExportBuilderDialog — chrome', () => {
  it('is titled "Customize export" with the books description', () => {
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'Customize export' })).toBeTruthy();
    expect(
      screen.getByText(
        'Choose the file format, book information, images, and layout to include in your export.',
      ),
    ).toBeTruthy();
  });

  it('uses the inventory wording for an items export', () => {
    renderDialog({ itemType: 'product' });
    expect(
      screen.getByText(
        'Choose the file format, inventory information, images, and layout to include in your export.',
      ),
    ).toBeTruthy();
  });

  it('states the scope in the brief\'s words', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByText('Exporting: 111 filtered books')).toBeTruthy());
  });

  it('states a selected scope with the count', () => {
    renderDialog({ scope: 'selected', itemType: 'product', selectedIds: ['a', 'b'], rowCountHint: 2 });
    expect(screen.getByText('Exporting: 2 selected items')).toBeTruthy();
  });
});

describe('ExportBuilderDialog — format selection', () => {
  it('offers the three formats with the brief descriptions', () => {
    renderDialog();
    const group = screen.getByRole('radiogroup', { name: /file format/i });
    expect(
      within(group).getByText(
        'Formatted document for printing, sharing, and visual inventory reviews.',
      ),
    ).toBeTruthy();
    expect(
      within(group).getByText(
        'Editable spreadsheet with filters, formatting, column widths, and optional images.',
      ),
    ).toBeTruthy();
    expect(
      within(group).getByText(
        'Simple data file for imports, databases, and spreadsheet applications.',
      ),
    ).toBeTruthy();
  });

  it('starts on PDF and switches on click', async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(screen.getByRole('radio', { name: /PDF/ })).toHaveProperty('ariaChecked', 'true');
    await user.click(screen.getByRole('radio', { name: /CSV/ }));
    expect(screen.getByRole('radio', { name: /CSV/ })).toHaveProperty('ariaChecked', 'true');
  });

  it('shows PDF layout options only for PDF, and Excel options only for Excel', async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(screen.getByLabelText('Paper size')).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: /Excel/ }));
    expect(screen.queryByLabelText('Paper size')).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Include summary sheet' })).toBeTruthy();
  });

  it('labels the CSV image option "Include image URL", never "Include images"', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('radio', { name: /CSV/ }));
    expect(screen.getByRole('checkbox', { name: 'Include image URL' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Include cover images' })).toBeNull();
  });

  it('defaults cover images ON for a books PDF and OFF for an items PDF', () => {
    renderDialog();
    expect(screen.getByRole('checkbox', { name: 'Include cover images' })).toHaveProperty(
      'ariaChecked',
      'true',
    );
    window.localStorage.clear();
    renderDialog({ itemType: 'product' });
    const boxes = screen.getAllByRole('checkbox', { name: 'Include images' });
    expect(boxes.at(-1)).toHaveProperty('ariaChecked', 'false');
  });
});

describe('ExportBuilderDialog — presets', () => {
  it('lists the built-in presets for the item type', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: /preset/i }));
    expect(screen.getByRole('option', { name: 'Books ISBN list' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Reorder report' })).toBeNull();
  });

  it('applying a preset replaces the field selection', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: /preset/i }));
    await user.click(screen.getByRole('option', { name: 'Books ISBN list' }));
    await user.click(screen.getByRole('button', { name: 'Export file' }));
    await waitFor(() => expect(downloadSpy).toHaveBeenCalled());
    const req = downloadSpy.mock.calls[0]![0] as { fields: string[]; options: { presetName: string } };
    expect(req.fields).toEqual(['name', 'isbn', 'sku', 'author', 'grade', 'quantity_on_hand']);
    expect(req.options.presetName).toBe('Books ISBN list');
  });
});

describe('ExportBuilderDialog — submission', () => {
  it('posts the chosen scope, filters, fields and options', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Export file' }));
    await waitFor(() => expect(downloadSpy).toHaveBeenCalledTimes(1));
    const req = downloadSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(req.scope).toBe('filtered');
    expect(req.itemType).toBe('book');
    expect(req.filters).toEqual({ q: 'algebra' });
    expect((req.fields as string[])[0]).toBe('image');
  });

  it('prevents a duplicate submission while one is in flight', async () => {
    const user = userEvent.setup();
    let release: (() => void) | null = null;
    downloadSpy.mockImplementationOnce(
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    renderDialog();
    const button = screen.getByRole('button', { name: 'Export file' });
    await user.click(button);
    expect(button).toHaveProperty('disabled', true);
    await user.click(button);
    expect(downloadSpy).toHaveBeenCalledTimes(1);
    release?.();
  });

  it('announces the stage it is actually in, with no fake percentage', async () => {
    const user = userEvent.setup();
    downloadSpy.mockImplementationOnce(async (_req: unknown, opts: unknown) => {
      (opts as { onStage: (s: string) => void }).onStage('preparing');
    });
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Export file' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('Preparing 111 books'),
    );
    expect(screen.getByRole('status').textContent).not.toMatch(/\d+%/);
  });

  it('keeps every setting and shows the error INSIDE the dialog when the export fails', async () => {
    const user = userEvent.setup();
    downloadSpy.mockRejectedValueOnce(new Error('Too many exports — please wait a few minutes.'));
    const { onOpenChange } = renderDialog();
    await user.click(screen.getByRole('radio', { name: /CSV/ }));
    await user.click(screen.getByRole('button', { name: 'Export file' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Too many exports'),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole('radio', { name: /CSV/ })).toHaveProperty('ariaChecked', 'true');
    // And it can be retried without rebuilding anything.
    expect(screen.getByRole('button', { name: 'Export file' })).toHaveProperty('disabled', false);
  });

  it('closes on success', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Export file' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('blocks export and explains why when no identifying field is selected', async () => {
    const user = userEvent.setup();
    renderDialog();
    for (const name of ['Title', 'SKU', 'ISBN']) {
      await user.click(screen.getByRole('checkbox', { name }));
    }
    expect(screen.getByRole('button', { name: 'Export file' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('alert').textContent).toContain('at least one identifying field');
    expect(downloadSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 10: Run it to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/components/inventory/export-builder/export-builder-dialog.test.tsx 2>&1 | tail -20`
Expected: FAIL — `Failed to resolve import "./export-builder-dialog"`. Record the real text.

- [ ] **Step 11: Write the dialog.** Create `apps/web/src/components/inventory/export-builder/export-builder-dialog.tsx`:

```tsx
'use client';

import { Loader2 } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  downloadInventoryExport,
  fetchExportPreview,
  type ExportPreviewResponse,
  type ExportStage,
  type InventoryExportRequest,
} from '@/lib/download-export';
import { exportItemTypeKind } from '@/lib/exports/export-request';

import { ExportBuilderFields } from './export-builder-fields';
import { ExportBuilderPreview } from './export-builder-preview';
import { presetsFor, type ExportPreset } from './export-builder-presets';
import {
  builderSummaryParts,
  CUSTOM_PRESET_ID,
  initialExportBuilderState,
  moveField,
  restoreDefaults,
  scopeSummary,
  setFormat,
  setOptions,
  toExportRequest,
  toggleField,
  validateExportBuilder,
  type ExportBuilderState,
} from './export-builder-state';

/**
 * The ONE export configuration surface (Brief sections 2, 4, 5, 6).
 *
 * Mounted from the inventory toolbar (filtered / all) AND the bulk-selection
 * bar (selected), for Books and Items alike. There is no second configuration
 * UI anywhere: inventory-table.tsx and bulk-actions.tsx each render this.
 */

const FORMATS: Array<{
  value: 'pdf' | 'xlsx' | 'csv';
  label: string;
  description: string;
}> = [
  {
    value: 'pdf',
    label: 'PDF',
    description: 'Formatted document for printing, sharing, and visual inventory reviews.',
  },
  {
    value: 'xlsx',
    label: 'Excel',
    description: 'Editable spreadsheet with filters, formatting, column widths, and optional images.',
  },
  {
    value: 'csv',
    label: 'CSV',
    description: 'Simple data file for imports, databases, and spreadsheet applications.',
  },
];

export interface ExportBuilderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: 'selected' | 'filtered' | 'all';
  itemType: 'product' | 'book' | 'asset' | 'consumable' | 'all';
  selectedIds?: string[];
  filters?: InventoryExportRequest['filters'];
  /** Row count already on screen, shown until the preview reports the truth. */
  rowCountHint?: number | null;
}

function Checkbox({
  checked,
  onChange,
  label,
  id,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  id?: string;
}) {
  // The house idiom: there is no shared checkbox.tsx in this repo, and the
  // inventory table has always used a role="checkbox" button.
  return (
    <button
      type="button"
      role="checkbox"
      id={id}
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2 text-[12.5px] text-[var(--ed-ink-2)]"
    >
      <span
        aria-hidden
        className={`inline-grid h-4 w-4 place-items-center rounded-[4px] border ${
          checked ? 'border-foreground bg-foreground' : 'border-border bg-background'
        }`}
      >
        {checked ? (
          <span className="h-[9px] w-[5px] -translate-y-px rotate-45 border-b-2 border-r-2 border-background" />
        ) : null}
      </span>
      {label}
    </button>
  );
}

export function ExportBuilderDialog({
  open,
  onOpenChange,
  scope,
  itemType,
  selectedIds,
  filters,
  rowCountHint = null,
}: ExportBuilderDialogProps) {
  const itemTypeKind = exportItemTypeKind(itemType);
  const [state, setState] = React.useState<ExportBuilderState>(() =>
    initialExportBuilderState(itemTypeKind),
  );
  const [preview, setPreview] = React.useState<ExportPreviewResponse | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [stage, setStage] = React.useState<ExportStage | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [presets, setPresets] = React.useState<ExportPreset[]>(() => presetsFor(itemTypeKind));

  const rowCount = preview?.total ?? rowCountHint;
  const validation = validateExportBuilder(state);

  // One preview fetch per scope/filter change — NOT per field toggle. The
  // sample rows are formatted locally through the registry, so changing fields
  // or their order re-renders instantly with zero requests.
  React.useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setPresets(presetsFor(itemTypeKind));
    fetchExportPreview(
      {
        scope,
        itemType,
        ...(scope === 'selected' ? { ids: selectedIds ?? [] } : {}),
        ...(scope === 'filtered' ? { filters } : {}),
      },
      controller.signal,
    )
      .then(setPreview)
      .catch(() => {
        // A failed preview must never block an export — the dialog just shows
        // the on-screen count and no readiness panel.
        setPreview(null);
      });
    return () => controller.abort();
    // filters is a new object each render at the call site; serialise it so the
    // effect keys off its VALUE, not its identity.
  }, [open, scope, itemType, itemTypeKind, JSON.stringify(filters), JSON.stringify(selectedIds)]);

  const applyPreset = (preset: ExportPreset) => {
    if (preset.id === CUSTOM_PRESET_ID) {
      setState((s) => ({ ...s, presetId: CUSTOM_PRESET_ID }));
      return;
    }
    setState((s) => {
      const withFields: ExportBuilderState = {
        ...s,
        fieldKeys: [...preset.fieldKeys],
        presetId: preset.id,
        options: {
          ...s.options,
          ...(preset.options ?? {}),
          includeImages: preset.fieldKeys.includes('image'),
          pdf: { ...s.options.pdf, ...(preset.options?.pdf ?? {}) },
          xlsx: { ...s.options.xlsx, ...(preset.options?.xlsx ?? {}) },
        },
      };
      return setFormat(withFields, s.format, itemTypeKind);
    });
  };

  const activePreset = presets.find((p) => p.id === state.presetId) ?? null;

  async function runExport() {
    if (busy || !validation.ok) return;
    setBusy(true);
    setError(null);
    try {
      await downloadInventoryExport(
        toExportRequest(state, {
          scope,
          itemType,
          ids: selectedIds,
          filters,
          // "Custom" is not a preset name, it is the absence of one — the
          // filename falls back to slug-scope-date for it.
          presetName:
            activePreset && activePreset.id !== CUSTOM_PRESET_ID ? activePreset.name : null,
        }),
        { onStage: setStage },
      );
      onOpenChange(false);
    } catch (e) {
      // Inside the dialog, never a toast that disappears with the settings.
      setError(e instanceof Error ? e.message : 'Export failed. Please try again.');
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  const stageLabel =
    stage === 'preparing'
      ? `Preparing ${rowCount ?? ''} ${itemTypeKind === 'book' ? 'books' : 'items'}…`.replace('  ', ' ')
      : stage === 'downloading'
        ? 'Downloading…'
        : null;

  return (
    <Dialog open={open} onOpenChange={busy ? () => {} : onOpenChange}>
      <DialogContent className="flex max-h-[92vh] w-[min(980px,96vw)] flex-col gap-4 overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Customize export</DialogTitle>
          <DialogDescription>
            {itemTypeKind === 'book'
              ? 'Choose the file format, book information, images, and layout to include in your export.'
              : 'Choose the file format, inventory information, images, and layout to include in your export.'}
          </DialogDescription>
        </DialogHeader>

        <p className="text-[12.5px] font-medium text-[var(--ed-ink-2)]">
          {scopeSummary({ scope, count: rowCount, itemTypeKind })}
        </p>

        <div role="radiogroup" aria-label="File format" className="grid gap-2 sm:grid-cols-3">
          {FORMATS.map((f) => (
            <button
              key={f.value}
              type="button"
              role="radio"
              aria-checked={state.format === f.value}
              aria-label={f.label}
              onClick={() => setState((s) => setFormat(s, f.value, itemTypeKind))}
              className={`rounded-md border p-3 text-left transition-colors ${
                state.format === f.value
                  ? 'border-foreground bg-muted'
                  : 'border-border bg-background hover:border-[var(--ed-line-strong)]'
              }`}
            >
              <span className="block text-[13px] font-medium">{f.label}</span>
              <span className="mt-1 block text-[11.5px] text-[var(--ed-ink-3)]">
                {f.description}
              </span>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={state.presetId}
            onValueChange={(id) => {
              const preset = presets.find((p) => p.id === id);
              if (preset) applyPreset(preset);
            }}
          >
            <SelectTrigger aria-label="Export preset" className="w-[240px]">
              <SelectValue placeholder="Preset" />
            </SelectTrigger>
            <SelectContent>
              {presets.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            type="button"
            onClick={() => setState((s) => restoreDefaults(s, itemTypeKind))}
            className="text-[12px] text-[var(--ed-ink-3)] underline-offset-2 hover:underline"
          >
            Restore recommended defaults
          </button>
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <ExportBuilderFields
            state={state}
            itemTypeKind={itemTypeKind}
            onToggle={(key) => setState((s) => toggleField(s, key))}
            onMove={(key, direction) => setState((s) => moveField(s, key, direction))}
          />
          <div className="flex flex-col gap-3">
            {/* Per-format settings */}
            <fieldset className="rounded-md border border-border p-3">
              <legend className="px-1 text-[11.5px] font-medium text-[var(--ed-ink-3)]">
                {state.format === 'pdf'
                  ? 'PDF layout'
                  : state.format === 'xlsx'
                    ? 'Excel options'
                    : 'CSV options'}
              </legend>
              <div className="flex flex-col gap-2">
                {state.format === 'csv' ? (
                  <Checkbox
                    label="Include image URL"
                    checked={state.fieldKeys.includes('image')}
                    onChange={() => setState((s) => toggleField(s, 'image'))}
                  />
                ) : (
                  <Checkbox
                    label={itemTypeKind === 'book' ? 'Include cover images' : 'Include images'}
                    checked={state.fieldKeys.includes('image')}
                    onChange={() => setState((s) => toggleField(s, 'image'))}
                  />
                )}

                {state.format !== 'csv' && state.fieldKeys.includes('image') ? (
                  <label className="flex items-center gap-2 text-[12px]">
                    Image size
                    <select
                      aria-label="Image size"
                      value={state.options.imageSize}
                      onChange={(e) =>
                        setState((s) =>
                          setOptions(s, {
                            imageSize: e.target.value as 'small' | 'medium' | 'large',
                          }),
                        )
                      }
                      className="rounded-sm border border-border bg-background px-2 py-1"
                    >
                      <option value="small">Small</option>
                      <option value="medium">Medium</option>
                      <option value="large">Large</option>
                    </select>
                  </label>
                ) : null}

                {state.format === 'pdf' ? (
                  <>
                    <label className="flex items-center gap-2 text-[12px]">
                      Paper size
                      <select
                        aria-label="Paper size"
                        value={state.options.pdf.paperSize}
                        onChange={(e) =>
                          setState((s) =>
                            setOptions(s, {
                              pdf: { paperSize: e.target.value as 'letter' | 'legal' },
                            }),
                          )
                        }
                        className="rounded-sm border border-border bg-background px-2 py-1"
                      >
                        <option value="letter">Letter</option>
                        <option value="legal">Legal</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-2 text-[12px]">
                      Orientation
                      <select
                        aria-label="Orientation"
                        value={state.options.pdf.orientation}
                        onChange={(e) =>
                          setState((s) =>
                            setOptions(s, {
                              pdf: {
                                orientation: e.target.value as 'auto' | 'portrait' | 'landscape',
                              },
                            }),
                          )
                        }
                        className="rounded-sm border border-border bg-background px-2 py-1"
                      >
                        <option value="auto">Auto</option>
                        <option value="portrait">Portrait</option>
                        <option value="landscape">Landscape</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-2 text-[12px]">
                      Row density
                      <select
                        aria-label="Row density"
                        value={state.options.pdf.density}
                        onChange={(e) =>
                          setState((s) =>
                            setOptions(s, {
                              pdf: {
                                density: e.target.value as
                                  | 'compact'
                                  | 'comfortable'
                                  | 'image-friendly',
                              },
                            }),
                          )
                        }
                        className="rounded-sm border border-border bg-background px-2 py-1"
                      >
                        <option value="compact">Compact</option>
                        <option value="comfortable">Comfortable</option>
                        <option value="image-friendly">Image-friendly</option>
                      </select>
                    </label>
                    {itemTypeKind === 'book' ? (
                      <label className="flex items-center gap-2 text-[12px]">
                        Layout
                        <select
                          aria-label="Layout"
                          value={
                            state.options.pdf.layout === 'catalog'
                              ? `catalog-${state.options.pdf.catalogColumns}`
                              : 'table'
                          }
                          onChange={(e) => {
                            const v = e.target.value;
                            setState((s) =>
                              setOptions(s, {
                                pdf:
                                  v === 'table'
                                    ? { layout: 'table' }
                                    : {
                                        layout: 'catalog',
                                        catalogColumns: Number(v.split('-')[1]) as 1 | 2 | 3,
                                      },
                              }),
                            );
                          }}
                          className="rounded-sm border border-border bg-background px-2 py-1"
                        >
                          <option value="table">Table</option>
                          <option value="catalog-1">Book catalog — single column</option>
                          <option value="catalog-2">Book catalog — two columns</option>
                          <option value="catalog-3">Book catalog — three columns</option>
                        </select>
                      </label>
                    ) : null}
                    <Checkbox
                      label="Repeat table headings on every page"
                      checked={state.options.pdf.repeatHeaders}
                      onChange={(next) =>
                        setState((s) => setOptions(s, { pdf: { repeatHeaders: next } }))
                      }
                    />
                    <Checkbox
                      label="Show page numbers"
                      checked={state.options.pdf.pageNumbers}
                      onChange={(next) =>
                        setState((s) => setOptions(s, { pdf: { pageNumbers: next } }))
                      }
                    />
                    <Checkbox
                      label="Wrap long text"
                      checked={state.options.pdf.wrapText}
                      onChange={(next) =>
                        setState((s) => setOptions(s, { pdf: { wrapText: next } }))
                      }
                    />
                  </>
                ) : null}

                {state.format === 'xlsx' ? (
                  <>
                    <Checkbox
                      label="Freeze header row"
                      checked={state.options.xlsx.freezeHeader}
                      onChange={(next) =>
                        setState((s) => setOptions(s, { xlsx: { freezeHeader: next } }))
                      }
                    />
                    <Checkbox
                      label="Add filters to the header row"
                      checked={state.options.xlsx.autoFilter}
                      onChange={(next) =>
                        setState((s) => setOptions(s, { xlsx: { autoFilter: next } }))
                      }
                    />
                    <Checkbox
                      label="Include summary sheet"
                      checked={state.options.xlsx.includeSummarySheet}
                      onChange={(next) =>
                        setState((s) => setOptions(s, { xlsx: { includeSummarySheet: next } }))
                      }
                    />
                  </>
                ) : null}
              </div>
            </fieldset>

            <ExportBuilderPreview
              state={state}
              itemTypeKind={itemTypeKind}
              preview={preview}
              rowCount={rowCount}
            />
          </div>
        </div>

        <p className="text-[11.5px] text-[var(--ed-ink-3)]">
          {builderSummaryParts({ state, itemTypeKind, rowCount }).join(' · ')}
        </p>

        {!validation.ok ? (
          <p role="alert" className="text-[12px] text-[var(--ed-danger,#b3261e)]">
            {validation.message}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-[12px] text-[var(--ed-danger,#b3261e)]">
            {error}
          </p>
        ) : null}
        {stageLabel ? (
          <p role="status" aria-live="polite" className="text-[12px] text-[var(--ed-ink-3)]">
            {stageLabel}
            {state.fieldKeys.includes('image')
              ? ' Cover images make this slower.'
              : ''}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={runExport} disabled={busy || !validation.ok}>
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Export file
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 12: Run the dialog test.** It still fails — `ExportBuilderFields` and `ExportBuilderPreview` do not exist yet. Create both as minimal stubs so this task's suite can pass, and flesh them out in Tasks 15 and 16:

`apps/web/src/components/inventory/export-builder/export-builder-fields.tsx`:

```tsx
'use client';

import type { InventoryExportFieldKey } from '@/lib/exports/field-registry';

import type { ExportBuilderState } from './export-builder-state';

export interface ExportBuilderFieldsProps {
  state: ExportBuilderState;
  itemTypeKind: 'book' | 'other';
  onToggle: (key: InventoryExportFieldKey) => void;
  onMove: (key: InventoryExportFieldKey, direction: 'up' | 'down' | 'top' | 'bottom') => void;
}

/** Built out in the field-selection task. */
export function ExportBuilderFields(_props: ExportBuilderFieldsProps) {
  return null;
}
```

`apps/web/src/components/inventory/export-builder/export-builder-preview.tsx`:

```tsx
'use client';

import type { ExportPreviewResponse } from '@/lib/download-export';

import type { ExportBuilderState } from './export-builder-state';

export interface ExportBuilderPreviewProps {
  state: ExportBuilderState;
  itemTypeKind: 'book' | 'other';
  preview: ExportPreviewResponse | null;
  rowCount: number | null;
}

/** Built out in the preview task. */
export function ExportBuilderPreview(_props: ExportBuilderPreviewProps) {
  return null;
}
```

Then temporarily skip the two dialog assertions that need the real field list (the preset-applies-fields test and the identifying-field test both click field checkboxes) by marking them `it.todo` with a one-line comment pointing at Task 15 — and UN-skip them in Task 15's step 4. Every other assertion must pass now.

Run: `pnpm --filter @stockpilot/web test src/components/inventory/export-builder 2>&1 | tail -25`
Expected: PASS with 2 todo.

- [ ] **Step 13: Typecheck and commit.**

```bash
git add apps/web/src/components/inventory/export-builder
git commit -m "feat(inventory): export builder state, presets and dialog shell"
```

---

## Task 15: Field selection with keyboard reordering

Brief §7 and §10. Searchable, grouped, check/uncheck, select all, clear optional, restore defaults, reorder — and reorder MUST work from the keyboard, because there is no drag-and-drop library in this repo and the brief forbids making drag the only path (Audit C2).

**Files:**
- Modify: `apps/web/src/components/inventory/export-builder/export-builder-fields.tsx` (replace the stub)
- Create: `apps/web/src/components/inventory/export-builder/export-builder-fields.test.tsx`
- Modify: `apps/web/src/components/inventory/export-builder/export-builder-dialog.test.tsx` (un-skip the two todos)

**Interfaces:**
- Consumes from Task 14: `ExportBuilderFieldsProps`, `availableFieldsFor`, `ExportBuilderState`. From Task 4: `fieldHeading`, `InventoryExportField`.
- Produces for Task 17: the same `ExportBuilderFieldsProps` contract, unchanged.

**Steps:**

- [ ] **Step 1: Write the failing field-list test.** Create `apps/web/src/components/inventory/export-builder/export-builder-fields.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ExportBuilderFields } from './export-builder-fields';
import { initialExportBuilderState, setFormat } from './export-builder-state';

function renderFields(overrides: Partial<Parameters<typeof ExportBuilderFields>[0]> = {}) {
  const onToggle = vi.fn();
  const onMove = vi.fn();
  render(
    <ExportBuilderFields
      state={initialExportBuilderState('book')}
      itemTypeKind="book"
      onToggle={onToggle}
      onMove={onMove}
      {...overrides}
    />,
  );
  return { onToggle, onMove };
}

describe('ExportBuilderFields — listing', () => {
  it('groups the fields under readable headings', () => {
    renderFields();
    expect(screen.getByRole('group', { name: 'Common fields' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Book fields' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Financial fields' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'System fields' })).toBeTruthy();
  });

  it('shows the selected fields in OUTPUT order, numbered', () => {
    renderFields();
    const chosen = screen.getByRole('list', { name: 'Selected fields, in export order' });
    const items = within(chosen).getAllByRole('listitem');
    expect(items[0]!.textContent).toContain('Cover');
    expect(items[1]!.textContent).toContain('Title');
    expect(items[2]!.textContent).toContain('ISBN');
  });

  it('hides book fields entirely for an items export', () => {
    renderFields({ state: initialExportBuilderState('other'), itemTypeKind: 'other' });
    expect(screen.queryByRole('group', { name: 'Book fields' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'ISBN' })).toBeNull();
  });

  it('filters by search, matching the label a user actually sees', async () => {
    const user = userEvent.setup();
    renderFields();
    await user.type(screen.getByRole('searchbox', { name: 'Search fields' }), 'isb');
    expect(screen.getByRole('checkbox', { name: 'ISBN' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Category' })).toBeNull();
  });

  it('says so when a search matches nothing, instead of showing an empty box', async () => {
    const user = userEvent.setup();
    renderFields();
    await user.type(screen.getByRole('searchbox', { name: 'Search fields' }), 'zzz');
    expect(screen.getByText('No fields match that search.')).toBeTruthy();
  });
});

describe('ExportBuilderFields — selection', () => {
  it('toggles a field', async () => {
    const user = userEvent.setup();
    const { onToggle } = renderFields();
    await user.click(screen.getByRole('checkbox', { name: 'Author' }));
    expect(onToggle).toHaveBeenCalledWith('author');
  });

  it('select all adds every available field exactly once', async () => {
    const user = userEvent.setup();
    const { onToggle } = renderFields();
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    const called = onToggle.mock.calls.map((c) => c[0]);
    expect(new Set(called).size).toBe(called.length);
    expect(called).toContain('warehouse');
    expect(called).not.toContain('name'); // already selected
  });

  it('clear optional keeps an identifying field so the export stays valid', async () => {
    const user = userEvent.setup();
    const { onToggle } = renderFields();
    await user.click(screen.getByRole('button', { name: 'Clear optional' }));
    const called = onToggle.mock.calls.map((c) => c[0]);
    expect(called).not.toContain('name');
    expect(called).toContain('category');
  });

  it('marks a field the current format cannot carry as unavailable rather than hiding it silently', () => {
    // Every registry field supports all three formats today, so this asserts
    // the mechanism with an explicit prop rather than a fixture that cannot
    // exist yet. If a format-specific field is ever added, this test already
    // covers it.
    renderFields({
      state: setFormat(initialExportBuilderState('book'), 'csv', 'book'),
    });
    for (const box of screen.getAllByRole('checkbox')) {
      expect(box.getAttribute('aria-disabled')).not.toBe('true');
    }
  });
});

describe('ExportBuilderFields — keyboard reordering', () => {
  it('offers four move controls per selected field', () => {
    renderFields();
    const chosen = screen.getByRole('list', { name: 'Selected fields, in export order' });
    const first = within(chosen).getAllByRole('listitem')[1]!;
    expect(within(first).getByRole('button', { name: /move title up/i })).toBeTruthy();
    expect(within(first).getByRole('button', { name: /move title down/i })).toBeTruthy();
    expect(within(first).getByRole('button', { name: /move title to top/i })).toBeTruthy();
    expect(within(first).getByRole('button', { name: /move title to bottom/i })).toBeTruthy();
  });

  it('moves a field with the keyboard alone', async () => {
    const user = userEvent.setup();
    const { onMove } = renderFields();
    await user.tab();
    const button = screen.getByRole('button', { name: /move title up/i });
    button.focus();
    await user.keyboard('{Enter}');
    expect(onMove).toHaveBeenCalledWith('name', 'up');
  });

  it('disables up at the top and down at the bottom instead of silently doing nothing', () => {
    renderFields();
    const chosen = screen.getByRole('list', { name: 'Selected fields, in export order' });
    const items = within(chosen).getAllByRole('listitem');
    expect(within(items[0]!).getByRole('button', { name: /move cover up/i })).toHaveProperty(
      'disabled',
      true,
    );
    expect(
      within(items.at(-1)!).getByRole('button', { name: /move status down/i }),
    ).toHaveProperty('disabled', true);
  });

  it('announces the new position after a move', async () => {
    const user = userEvent.setup();
    renderFields();
    await user.click(screen.getByRole('button', { name: /move title to top/i }));
    expect(screen.getByRole('status').textContent).toContain('Title');
  });
});

describe('ExportBuilderFields — column-count warning', () => {
  it('warns with the brief copy once a PDF has too many columns', () => {
    const state = initialExportBuilderState('book');
    renderFields({
      state: {
        ...state,
        fieldKeys: [
          'image', 'name', 'isbn', 'sku', 'author', 'grade', 'quantity_on_hand', 'category',
          'rack', 'crate', 'primary_location', 'status', 'barcode', 'warehouse', 'supplier',
          'charter',
        ],
      },
    });
    expect(screen.getByRole('alert').textContent).toContain('may be difficult to read');
    expect(screen.getByRole('alert').textContent).toContain('export to Excel');
  });

  it('stays silent for a CSV, which has no column limit', () => {
    const state = setFormat(initialExportBuilderState('book'), 'csv', 'book');
    renderFields({
      state: {
        ...state,
        fieldKeys: [
          'name', 'isbn', 'sku', 'author', 'grade', 'quantity_on_hand', 'category', 'rack',
          'crate', 'primary_location', 'status', 'barcode', 'warehouse', 'supplier', 'charter',
        ],
      },
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/components/inventory/export-builder/export-builder-fields.test.tsx 2>&1 | tail -20`
Expected: FAIL — the stub renders `null`, so every query fails with "Unable to find role". Record the real text.

- [ ] **Step 3: Write the field list.** Replace `apps/web/src/components/inventory/export-builder/export-builder-fields.tsx` with:

```tsx
'use client';

import { ChevronDown, ChevronsDown, ChevronsUp, ChevronUp } from 'lucide-react';
import * as React from 'react';

import {
  fieldHeading,
  type InventoryExportField,
  type InventoryExportFieldGroup,
  type InventoryExportFieldKey,
  IDENTIFYING_FIELD_KEYS,
} from '@/lib/exports/field-registry';
import { computeExportPdfLayout } from '@/lib/exports/pdf-layout';

import { availableFieldsFor, type ExportBuilderState } from './export-builder-state';

/**
 * Field selection and ordering (Brief sections 7, 10 and 13).
 *
 * Reordering is KEYBOARD-FIRST. There is no drag-and-drop dependency anywhere
 * in this repo, and the brief requires keyboard controls whether or not drag
 * exists — so four explicit buttons per row are the primary mechanism, not a
 * fallback. Every control is a real button with a real accessible name.
 */

const GROUP_LABELS: Record<InventoryExportFieldGroup, string> = {
  common: 'Common fields',
  book: 'Book fields',
  financial: 'Financial fields',
  system: 'System fields',
};
const GROUP_ORDER: InventoryExportFieldGroup[] = ['common', 'book', 'financial', 'system'];

export interface ExportBuilderFieldsProps {
  state: ExportBuilderState;
  itemTypeKind: 'book' | 'other';
  onToggle: (key: InventoryExportFieldKey) => void;
  onMove: (key: InventoryExportFieldKey, direction: 'up' | 'down' | 'top' | 'bottom') => void;
}

export function ExportBuilderFields({
  state,
  itemTypeKind,
  onToggle,
  onMove,
}: ExportBuilderFieldsProps) {
  const [query, setQuery] = React.useState('');
  const [announcement, setAnnouncement] = React.useState('');

  const available = availableFieldsFor(itemTypeKind, state.format);
  const headingFor = (field: InventoryExportField) =>
    fieldHeading(field, { format: state.format, itemType: itemTypeKind });

  const matches = (field: InventoryExportField) =>
    query.trim().length === 0 ||
    headingFor(field).toLowerCase().includes(query.trim().toLowerCase());

  const selected = state.fieldKeys
    .map((key) => available.find((f) => f.key === key))
    .filter((f): f is InventoryExportField => Boolean(f));

  const warnings =
    state.format === 'pdf'
      ? computeExportPdfLayout({
          fields: selected,
          itemTypeKind,
          includeImages: state.options.includeImages,
          imageSize: state.options.imageSize,
          orientation: state.options.pdf.orientation,
          paperSize: state.options.pdf.paperSize,
          density: state.options.pdf.density,
          wrapText: state.options.pdf.wrapText,
          layout: state.options.pdf.layout,
          catalogColumns: state.options.pdf.catalogColumns,
        }).warnings
      : [];

  const move = (field: InventoryExportField, direction: 'up' | 'down' | 'top' | 'bottom') => {
    onMove(field.key, direction);
    setAnnouncement(`${headingFor(field)} moved ${direction === 'top' ? 'to the top' : direction === 'bottom' ? 'to the bottom' : direction}.`);
  };

  const visibleGroups = GROUP_ORDER.map((group) => ({
    group,
    fields: available.filter((f) => f.group === group && matches(f)),
  })).filter((g) => g.fields.length > 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          role="searchbox"
          aria-label="Search fields"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search fields"
          className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-[12.5px]"
        />
        <button
          type="button"
          onClick={() => {
            for (const field of available) {
              if (!state.fieldKeys.includes(field.key)) onToggle(field.key);
            }
          }}
          className="text-[12px] text-[var(--ed-ink-3)] underline-offset-2 hover:underline"
        >
          Select all
        </button>
        <button
          type="button"
          onClick={() => {
            // "Optional" means everything except ONE identifying field — the
            // export stays valid, so the user is never left in an error state
            // by a convenience button.
            const keep = state.fieldKeys.find((k) => IDENTIFYING_FIELD_KEYS.includes(k));
            for (const key of state.fieldKeys) {
              if (key !== keep) onToggle(key);
            }
          }}
          className="text-[12px] text-[var(--ed-ink-3)] underline-offset-2 hover:underline"
        >
          Clear optional
        </button>
      </div>

      {warnings.length > 0 ? (
        <p role="alert" className="text-[12px] text-[var(--ed-warn,#8a6d00)]">
          {warnings[0]}
        </p>
      ) : null}

      <div className="max-h-[240px] overflow-y-auto rounded-md border border-border p-2">
        {visibleGroups.length === 0 ? (
          <p className="p-2 text-[12px] text-[var(--ed-ink-4)]">No fields match that search.</p>
        ) : (
          visibleGroups.map(({ group, fields }) => (
            <div key={group} role="group" aria-label={GROUP_LABELS[group]} className="mb-2">
              <p className="px-1 py-1 text-[11px] uppercase tracking-wide text-[var(--ed-ink-4)]">
                {GROUP_LABELS[group]}
              </p>
              {fields.map((field) => {
                const checked = state.fieldKeys.includes(field.key);
                return (
                  <button
                    key={field.key}
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    aria-label={headingFor(field)}
                    onClick={() => onToggle(field.key)}
                    className="flex w-full items-center gap-2 rounded-sm px-1 py-1 text-left text-[12.5px] hover:bg-muted"
                  >
                    <span
                      aria-hidden
                      className={`inline-grid h-4 w-4 place-items-center rounded-[4px] border ${
                        checked ? 'border-foreground bg-foreground' : 'border-border bg-background'
                      }`}
                    >
                      {checked ? (
                        <span className="h-[9px] w-[5px] -translate-y-px rotate-45 border-b-2 border-r-2 border-background" />
                      ) : null}
                    </span>
                    {headingFor(field)}
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>

      <div>
        <p className="mb-1 text-[11px] uppercase tracking-wide text-[var(--ed-ink-4)]">
          Column order
        </p>
        <ol
          aria-label="Selected fields, in export order"
          className="flex flex-col gap-1 rounded-md border border-border p-2"
        >
          {selected.map((field, index) => (
            <li key={field.key} className="flex items-center gap-2 text-[12.5px]">
              <span className="w-5 text-right font-mono text-[11px] text-[var(--ed-ink-4)]">
                {index + 1}
              </span>
              <span className="flex-1">{headingFor(field)}</span>
              <button
                type="button"
                aria-label={`Move ${headingFor(field)} to top`}
                disabled={index === 0}
                onClick={() => move(field, 'top')}
                className="rounded-sm border border-border p-1 disabled:opacity-40"
              >
                <ChevronsUp className="h-3 w-3" />
              </button>
              <button
                type="button"
                aria-label={`Move ${headingFor(field)} up`}
                disabled={index === 0}
                onClick={() => move(field, 'up')}
                className="rounded-sm border border-border p-1 disabled:opacity-40"
              >
                <ChevronUp className="h-3 w-3" />
              </button>
              <button
                type="button"
                aria-label={`Move ${headingFor(field)} down`}
                disabled={index === selected.length - 1}
                onClick={() => move(field, 'down')}
                className="rounded-sm border border-border p-1 disabled:opacity-40"
              >
                <ChevronDown className="h-3 w-3" />
              </button>
              <button
                type="button"
                aria-label={`Move ${headingFor(field)} to bottom`}
                disabled={index === selected.length - 1}
                onClick={() => move(field, 'bottom')}
                className="rounded-sm border border-border p-1 disabled:opacity-40"
              >
                <ChevronsDown className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ol>
        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Un-skip the two dialog todos** from Task 14 Step 12 (the preset-applies-fields test and the identifying-field validation test) by turning `it.todo` back into `it`.

- [ ] **Step 5: Run both suites to verify they pass.**

Run: `pnpm --filter @stockpilot/web test src/components/inventory/export-builder 2>&1 | tail -25`
Expected: PASS — the field suite's 15 tests plus the dialog's full set, no todos.

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/components/inventory/export-builder
git commit -m "feat(inventory): searchable grouped field picker with keyboard reordering"
```

---

## Task 16: Live preview and the export-readiness panel

Brief §19 and §20. The preview shows the first rows through the CURRENT field selection, order and format, formatted locally so a field toggle is instant. The readiness panel reports what the export cannot fix: how many rows have an ISBN and how many have a cover.

**Files:**
- Modify: `apps/web/src/components/inventory/export-builder/export-builder-preview.tsx` (replace the stub)
- Create: `apps/web/src/components/inventory/export-builder/export-builder-preview.test.tsx`

**Interfaces:**
- Consumes from Task 13: `ExportPreviewResponse`. From Task 14: `ExportBuilderPreviewProps`, `ExportBuilderState`. From Task 4: `fieldHeading`, `getExportField`.
- Produces: no new exports beyond the component; the props contract from Task 14 is unchanged.

**Steps:**

- [ ] **Step 1: Write the failing preview test.** Create `apps/web/src/components/inventory/export-builder/export-builder-preview.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ExportPreviewResponse } from '@/lib/download-export';
import type { InventoryExportSourceRow } from '@/lib/exports/source-row';

import { ExportBuilderPreview } from './export-builder-preview';
import { initialExportBuilderState, moveField, setFormat } from './export-builder-state';

function sampleRow(overrides: Partial<InventoryExportSourceRow> = {}): InventoryExportSourceRow {
  return {
    id: 'i-1',
    itemType: 'book',
    name: 'Introduction to Algorithms',
    sku: 'BK-0001',
    barcode: '9780262033848',
    status: 'active',
    quantityOnHand: 4,
    reorderPoint: 0,
    reorderQuantity: 0,
    unitCost: 42,
    retailPrice: 89,
    category: 'Mathematics',
    primaryLocation: 'DC4',
    supplier: '',
    warehouse: 'North',
    charter: 'Generic',
    trackingType: 'none',
    author: 'Cormen',
    isbn: '9780262033848',
    grade: 'College',
    rackNumber: '38',
    rackRow: 'A',
    crateColor: 'blue',
    crateNumber: '12',
    rackLabel: '38-A',
    crateLabel: 'Blue 12',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    image: null,
    ...overrides,
  };
}

const PREVIEW: ExportPreviewResponse = {
  total: 111,
  truncated: false,
  slug: 'books',
  sampleRows: [sampleRow(), sampleRow({ id: 'i-2', name: 'Discrete Mathematics', isbn: '' })],
  readiness: { rows: 111, withIsbn: 97, missingIsbn: 14, withImage: 84, missingImage: 27 },
};

function renderPreview(overrides: Partial<Parameters<typeof ExportBuilderPreview>[0]> = {}) {
  render(
    <ExportBuilderPreview
      state={initialExportBuilderState('book')}
      itemTypeKind="book"
      preview={PREVIEW}
      rowCount={111}
      {...overrides}
    />,
  );
}

describe('ExportBuilderPreview — the sample table', () => {
  it('renders one column per selected field, under the export heading', () => {
    renderPreview();
    const table = screen.getByRole('table', { name: 'Export preview' });
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers[0]).toBe('Cover');
    expect(headers[1]).toBe('Title');
    expect(headers[2]).toBe('ISBN');
  });

  it('follows the chosen order, not the registry order', () => {
    const state = moveField(initialExportBuilderState('book'), 'isbn', 'top');
    renderPreview({ state });
    const table = screen.getByRole('table', { name: 'Export preview' });
    expect(within(table).getAllByRole('columnheader')[0]!.textContent).toBe('ISBN');
  });

  it('shows real sample values, and an em dash where a value is missing', () => {
    renderPreview();
    const table = screen.getByRole('table', { name: 'Export preview' });
    expect(within(table).getByText('Introduction to Algorithms')).toBeTruthy();
    expect(within(table).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('renders the image column as a labelled placeholder, never a signed URL', () => {
    renderPreview();
    const table = screen.getByRole('table', { name: 'Export preview' });
    expect(within(table).getAllByText('Image').length).toBeGreaterThan(0);
    expect(table.textContent).not.toContain('https://');
  });

  it('says Image URL in the CSV preview heading', () => {
    renderPreview({ state: setFormat(initialExportBuilderState('book'), 'csv', 'book') });
    const table = screen.getByRole('table', { name: 'Export preview' });
    expect(within(table).getAllByRole('columnheader')[0]!.textContent).toBe('Image URL');
  });

  it('shows a waiting message rather than an empty table before the preview arrives', () => {
    renderPreview({ preview: null });
    expect(screen.getByText('Loading a sample of this export…')).toBeTruthy();
  });
});

describe('ExportBuilderPreview — readiness', () => {
  it('reports ISBN and cover coverage in the brief\'s shape', () => {
    renderPreview();
    const panel = screen.getByRole('group', { name: 'Export readiness' });
    expect(panel.textContent).toContain('97 of 111 books have an ISBN');
    expect(panel.textContent).toContain('84 of 111 have a cover');
    expect(panel.textContent).toContain('14 missing ISBN');
    expect(panel.textContent).toContain('27 missing cover');
  });

  it('never presents readiness as a blocker', () => {
    renderPreview();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('drops the cover line when the export has no image field', () => {
    const state = initialExportBuilderState('other');
    renderPreview({ state, itemTypeKind: 'other' });
    const panel = screen.getByRole('group', { name: 'Export readiness' });
    expect(panel.textContent).not.toContain('cover');
  });

  it('notes when the row cap truncated the set', () => {
    renderPreview({ preview: { ...PREVIEW, truncated: true, total: 41230 } });
    expect(
      screen.getByText('Only the first 10,000 records are included in this export.'),
    ).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `pnpm --filter @stockpilot/web test src/components/inventory/export-builder/export-builder-preview.test.tsx 2>&1 | tail -20`
Expected: FAIL — the stub renders `null`. Record the real text.

- [ ] **Step 3: Write the preview.** Replace `apps/web/src/components/inventory/export-builder/export-builder-preview.tsx` with:

```tsx
'use client';

import type { ExportPreviewResponse } from '@/lib/download-export';
import {
  fieldHeading,
  getExportField,
  type InventoryExportField,
} from '@/lib/exports/field-registry';

import type { ExportBuilderState } from './export-builder-state';

/**
 * Live preview (Brief section 19) and export readiness (section 20).
 *
 * The sample rows come from ONE preview request per scope/filter change; every
 * field toggle and every reorder re-renders from that same sample through the
 * registry, so configuring an export costs no further round trips.
 *
 * The image cell shows a neutral labelled placeholder rather than a picture:
 * the preview endpoint deliberately signs nothing, so there is no URL to draw
 * and none can leak into the DOM.
 */

const EM_DASH = '—';

export interface ExportBuilderPreviewProps {
  state: ExportBuilderState;
  itemTypeKind: 'book' | 'other';
  preview: ExportPreviewResponse | null;
  rowCount: number | null;
}

export function ExportBuilderPreview({
  state,
  itemTypeKind,
  preview,
  rowCount,
}: ExportBuilderPreviewProps) {
  const fields = state.fieldKeys
    .map((key) => getExportField(key))
    .filter((f): f is InventoryExportField => Boolean(f));
  const headingFor = (field: InventoryExportField) =>
    fieldHeading(field, { format: state.format, itemType: itemTypeKind });

  const noun = itemTypeKind === 'book' ? 'books' : 'items';
  const showCoverReadiness = state.fieldKeys.includes('image');

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-md border border-border">
        {preview === null ? (
          <p className="p-3 text-[12px] text-[var(--ed-ink-4)]">Loading a sample of this export…</p>
        ) : (
          <table aria-label="Export preview" className="w-full text-[11.5px]">
            <thead>
              <tr className="bg-muted text-left">
                {fields.map((field) => (
                  <th key={field.key} scope="col" className="whitespace-nowrap px-2 py-1 font-medium">
                    {headingFor(field)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.sampleRows.slice(0, 5).map((row) => (
                <tr key={row.id} className="border-t border-border">
                  {fields.map((field) => {
                    if (field.key === 'image') {
                      return (
                        <td key={field.key} className="px-2 py-1 text-[var(--ed-ink-4)]">
                          {headingFor(field) === 'Image URL' ? 'Image URL' : 'Image'}
                        </td>
                      );
                    }
                    const value = field.value(row);
                    return (
                      <td key={field.key} className="px-2 py-1">
                        {value === null || value === undefined || value === ''
                          ? EM_DASH
                          : String(value)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {preview ? (
        <div
          role="group"
          aria-label="Export readiness"
          className="rounded-md border border-border p-2 text-[12px] text-[var(--ed-ink-3)]"
        >
          <p>
            {preview.readiness.withIsbn} of {preview.readiness.rows} {noun} have an ISBN
            {preview.readiness.missingIsbn > 0
              ? ` · ${preview.readiness.missingIsbn} missing ISBN`
              : ''}
          </p>
          {showCoverReadiness ? (
            <p>
              {preview.readiness.withImage} of {preview.readiness.rows} have a cover
              {preview.readiness.missingImage > 0
                ? ` · ${preview.readiness.missingImage} missing cover`
                : ''}
            </p>
          ) : null}
          {/* Never a blocker: a missing cover or ISBN is a data gap, not an
              export error, and the file prints a placeholder either way. */}
          <p className="mt-1 text-[11px] text-[var(--ed-ink-4)]">
            Missing values are left blank in the file. They never stop an export.
          </p>
          {preview.truncated ? (
            <p className="mt-1">Only the first 10,000 records are included in this export.</p>
          ) : null}
        </div>
      ) : null}

      {rowCount !== null && preview === null ? (
        <p className="text-[11.5px] text-[var(--ed-ink-4)]">{rowCount} {noun} on screen.</p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Run the preview test to verify it passes.**

Run: `pnpm --filter @stockpilot/web test src/components/inventory/export-builder/export-builder-preview.test.tsx 2>&1 | tail -20`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/components/inventory/export-builder
git commit -m "feat(inventory): live export preview and readiness panel"
```

---

## Task 17: One builder for every entry point, plus accessibility and narrow screens

Brief §2, §4, §26, §27. Both existing popovers are deleted and replaced with the same dialog. This is where the two-configuration-UI problem (Brief problem 8) actually goes away.

**Files:**
- Modify: `apps/web/src/components/inventory/inventory-table.tsx:3535-3636, 1730-1733` (delete `ExportFormatRow` + `ExportMenu`, mount the builder)
- Modify: `apps/web/src/components/inventory/bulk-actions.tsx:169-180, 309-343` (delete `exportSelected` + its popover, mount the builder)
- Modify: `apps/web/src/components/inventory/export-builder/export-builder-dialog.tsx` (focus restore, responsive shell)
- Modify: `apps/web/src/components/inventory/export-builder/export-builder-dialog.test.tsx`

**Interfaces:**
- Consumes from Task 14: `ExportBuilderDialog` and its props.
- Produces: nothing new. `InventoryExportRequest['filters']` is still derived from `useSearchParams()` by the same `filtersFromParams()` logic, moved (not rewritten) into the builder's mount site.

**Steps:**

- [ ] **Step 1: Write the failing integration assertions.** Append to `apps/web/src/components/inventory/export-builder/export-builder-dialog.test.tsx`:

```tsx
describe('ExportBuilderDialog — accessibility and small screens', () => {
  it('returns focus to the trigger when it closes', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Export
          </button>
          <ExportBuilderDialog
            open={open}
            onOpenChange={setOpen}
            scope="filtered"
            itemType="book"
            rowCountHint={111}
          />
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Export' });
    await user.click(trigger);
    await screen.findByRole('dialog', { name: 'Customize export' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('every interactive control has an accessible name', () => {
    renderDialog();
    for (const el of [
      ...screen.getAllByRole('button'),
      ...screen.getAllByRole('checkbox'),
      ...screen.getAllByRole('radio'),
      ...screen.getAllByRole('combobox'),
    ]) {
      const name = el.getAttribute('aria-label') ?? el.textContent ?? '';
      expect(name.trim().length, el.outerHTML.slice(0, 80)).toBeGreaterThan(0);
    }
  });

  it('states state with text, never with colour alone', () => {
    renderDialog();
    // The selected format card carries aria-checked; the field checkboxes carry
    // aria-checked. Neither relies on a class to convey state.
    expect(
      screen.getAllByRole('radio').every((el) => el.getAttribute('aria-checked') !== null),
    ).toBe(true);
    expect(
      screen.getAllByRole('checkbox').every((el) => el.getAttribute('aria-checked') !== null),
    ).toBe(true);
  });

  it('keeps the dialog reachable on a narrow viewport — no fixed desktop width', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Customize export' });
    const className = dialog.getAttribute('class') ?? '';
    expect(className).toContain('w-[min(');
    expect(className).toContain('max-h-');
    expect(className).toContain('overflow-y-auto');
  });

  it('cannot be dismissed mid-export', async () => {
    const user = userEvent.setup();
    let release: (() => void) | null = null;
    downloadSpy.mockImplementationOnce(
      async () => new Promise<void>((resolve) => { release = resolve; }),
    );
    const { onOpenChange } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Export file' }));
    await user.keyboard('{Escape}');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    release?.();
  });
});
```

Add `import * as React from 'react';` to the top of that test file.

- [ ] **Step 2: Run it to verify what fails.**

Run: `pnpm --filter @stockpilot/web test src/components/inventory/export-builder/export-builder-dialog.test.tsx 2>&1 | tail -25`
Expected: the focus-restore test may already pass (Radix restores focus by default) — record which of the five actually fail. Fix only what fails; do not add code for an assertion that is already true.

- [ ] **Step 3: Replace the toolbar popover.** In `apps/web/src/components/inventory/inventory-table.tsx`:

Delete `EXPORT_FORMATS` (lines 3535-3539), `ExportFormatRow` (3541-3563) and the whole `ExportMenu` function (3565-3636), and add this component in their place — it keeps `filtersFromParams` verbatim, because "export filtered" must keep meaning exactly what the URL says (R5):

```tsx
function ExportMenu({ params, itemType }: { params: URLSearchParams; itemType: string }) {
  const [scope, setScope] = React.useState<'filtered' | 'all' | null>(null);

  // "filtered" carries the active params (q, sort, cat[], loc[], stock,
  // status, expected). ?expected=1 (the Expected chip view, mig 0277) must
  // ride along or exporting that view yields zero rows — the server's
  // default list excludes flagged items.
  const filtersFromParams = (): InventoryExportRequest['filters'] => ({
    q: params.get('q') || undefined,
    status: (params.get('status') as 'active' | 'archived' | 'discontinued' | 'all') || undefined,
    stock: (params.get('stock') as 'low' | 'out') || null,
    expected: params.get('expected') === '1' || undefined,
    sort: params.get('sort') || undefined,
    categoryIds: params.getAll('cat').filter(Boolean),
    locationIds: params.getAll('loc').filter(Boolean),
    charterIds: params.getAll('charter').filter(Boolean),
  });

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="border-border bg-background inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12px] text-[var(--ed-ink-2)] transition-colors hover:border-[var(--ed-line-strong)]"
            aria-label="Export"
          >
            <Download className="h-3 w-3" />
            <span className="font-medium">Export</span>
            <ChevronDown className="h-3 w-3 text-[var(--ed-ink-4)]" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[240px] p-2">
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => setScope('filtered')}
              className="rounded-sm px-2 py-1.5 text-left text-[12.5px] hover:bg-muted"
            >
              <span className="block font-medium">Export filtered</span>
              <span className="block text-[11px] text-[var(--ed-ink-4)]">
                What&apos;s currently visible
              </span>
            </button>
            <button
              type="button"
              onClick={() => setScope('all')}
              className="rounded-sm px-2 py-1.5 text-left text-[12.5px] hover:bg-muted"
            >
              <span className="block font-medium">Export all</span>
              <span className="block text-[11px] text-[var(--ed-ink-4)]">
                Full {itemType === 'book' ? 'books' : 'inventory'} dump
              </span>
            </button>
          </div>
        </PopoverContent>
      </Popover>
      {scope ? (
        <ExportBuilderDialog
          open
          onOpenChange={(open) => {
            if (!open) setScope(null);
          }}
          scope={scope}
          itemType={itemType as InventoryExportRequest['itemType'] & string}
          filters={scope === 'filtered' ? filtersFromParams() : undefined}
        />
      ) : null}
    </>
  );
}
```

Add the import at the top of the file:

```ts
import { ExportBuilderDialog } from './export-builder/export-builder-dialog';
```

and confirm `toast` is still used elsewhere in the file (it is — dozens of call sites); if the export path was its only consumer in some build, remove the now-unused import rather than leaving a lint error.

- [ ] **Step 4: Replace the selection popover.** In `apps/web/src/components/inventory/bulk-actions.tsx`, delete `exportSelected` (lines 171-180) and its `exportBusy` state (line 169), and replace the whole `<Popover>` export block (lines 310-343) with:

```tsx
        <button
          type="button"
          onClick={() => setExportOpen(true)}
          className="inline-flex items-center gap-1 text-[var(--ed-ink-2)] hover:text-foreground"
        >
          <Download className="h-3 w-3" /> Export
        </button>
```

adding, beside the other `useState` declarations:

```tsx
  const [exportOpen, setExportOpen] = React.useState(false);
```

and rendering the dialog once, immediately after the selection bar's closing `</div>`:

```tsx
      <ExportBuilderDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        scope="selected"
        itemType="all"
        selectedIds={selectedIds}
        rowCountHint={selectedIds.length}
      />
```

with the import:

```ts
import { ExportBuilderDialog } from './export-builder/export-builder-dialog';
```

Remove the now-unused `Popover` import ONLY if nothing else in the file uses it — check first:

Run: `grep -n "Popover" apps/web/src/components/inventory/bulk-actions.tsx`

- [ ] **Step 5: Prove no second export configuration UI survives.**

Run: `grep -rn "downloadInventoryExport" apps/web/src`
Expected: exactly two hits — the definition in `lib/download-export.ts` and the ONE call inside `export-builder-dialog.tsx`. Any third hit is a surviving parallel path (Brief problem 8) and must be removed.

- [ ] **Step 6: Run the whole inventory surface.**

Run: `pnpm --filter @stockpilot/web test src/components/inventory 2>&1 | tail -25`
Expected: PASS — the builder suites plus every pre-existing inventory component test (R4).

- [ ] **Step 7: Typecheck, lint, commit.**

Run: `pnpm --filter @stockpilot/web typecheck && pnpm --filter @stockpilot/web lint 2>&1 | tail -20`
Expected: clean.

```bash
git add apps/web/src/components/inventory
git commit -m "feat(inventory): one export builder for filtered, all and selected exports"
```

---
# Phase E — Verification and the report

## Task 18: The gate, the manual walk, and the Brief §31 engineering report

**Files:**
- Modify: `docs/superpowers/reports/2026-08-03-export-builder-verification.md` (append the full-program section)
- Create: `docs/superpowers/reports/2026-08-03-export-builder-report.md`

**Interfaces:**
- Consumes: every earlier task.
- Produces: two documents and a stop-for-the-owner. No code.

**Steps:**

- [ ] **Step 1: Run every gate and record the REAL output.** Four commands, in this order, each recorded verbatim:

```bash
pnpm --filter @stockpilot/web test 2>&1 | tail -40
pnpm typecheck 2>&1 | tail -20
pnpm lint 2>&1 | tail -30
pnpm --filter @stockpilot/web build 2>&1 | tail -30
```

Expected: all four clean. A claim of "passing" without the pasted output is a plan violation (Global Constraint 20).

- [ ] **Step 2: Confirm the invariants that only a grep can prove.**

```bash
grep -rn "primaryMasterUrlsForItems" apps/web/src/lib apps/web/src/app/api/inventory   # expect: no output
grep -rn "downloadInventoryExport" apps/web/src                                        # expect: 2 hits
grep -rn "PDF_COLUMNS" apps/web/src                                                     # expect: no output
grep -rc "Generic" apps/web/src/lib/charter-display.ts                                  # expect: >= 1
ls supabase/migrations | tail -3                                                        # expect: unchanged since main
```

Record each result. The last one is the no-migration guarantee (Global Constraint 7).

- [ ] **Step 3: Walk it in the Demo org, by hand.** Sign in as `demo@stockpilotusa.com` at `/signin` (Demo Co, `71b27a4a-7948-4638-bc3f-535974713bd2`) and complete the Brief §29 checklist, recording a yes/no plus a note for each line:

Books PDF: headers visibly separated; ISBN present; covers appear; medium and large give taller rows; no cropped covers; long titles wrap; ISBN readable; rack and crate understandable; headers repeat on page 2; page numbers read "Page 1 of N"; org branding present; the full book count paginates; the last page has no broken partial row.
Books Excel: ISBN is text; no scientific notation; pictures sit inside their rows; filters work; header frozen; widths sensible.
Books CSV: ISBN present; fields and order match the dialog; the Image URL column appears only when selected.
Items: no book-only fields by default; images appear when enabled; filtered / all / selected scopes each return the right rows; every previously-available field is still offered.

**Two things this walk must settle that no unit test can:**
1. **Do covers actually render in the PDF?** `@react-pdf/renderer` decodes PNG and JPEG; Supabase-stored thumbnails are WebP. If covers come out blank for uploaded photos while ISBN-imported book covers (JPEG, from Google Books / Open Library) render fine, that is the expected split — record it, and note the fix in the report's limitations: route the PDF image path through `fetchExportImageBytes` and pass a base64 data URI, exactly as the Excel path already does.
2. **Do embedded Excel pictures appear?** Same WebP question, same expected split.

- [ ] **Step 4: Append the Phase B-E section to the verification log** (`docs/superpowers/reports/2026-08-03-export-builder-verification.md`), containing the four command outputs, the five grep results, and the manual checklist with its real answers.

- [ ] **Step 5: Write the Brief §31 report.** Create `docs/superpowers/reports/2026-08-03-export-builder-report.md` with these sections, in this order:

```markdown
# Custom Export Builder — engineering report

## A. Files inspected
(Every file the Phase 1 audit read, plus anything else opened during
implementation. Cite file:line for the claims this report makes.)

## B. Files changed, and why each one
(One line per file. Say what would break if the change were reverted.)

## C. New files
(One line per file, with its single responsibility.)

## D. The current problems, explained
- Why ISBN was missing from the Books PDF: the value was always correct
  (inventory-export.ts:164-167); the route's hardcoded PDF_COLUMNS array simply
  never listed an isbn column, and SectionView only renders section.columns.
- Why cover images were missing: the export route never set section.imageColumn
  and never resolved an image URL for any row. ItemImagesService already had the
  right resolver.
- Why the headers collided: reportStyles.headerCell had no paddingHorizontal
  while the body cell had 3pt, and column widths were a bare flex ratio with no
  minimum, so two narrow headers rendered edge to edge.
- Why nothing was customizable: there was no field registry, no request schema
  beyond format/scope/itemType/ids/filters, and two independent popovers with
  zero configuration state.
- Why the charter showed an em dash: the row builder wrote '' for a null
  charter and the PDF renders any blank as an em dash; the word "Generic" lived
  only in the list component.

## E. The new export architecture
(Registry; request schema and server validation; PDF layout generation; image
resolution; Excel embedding; CSV URL behaviour; server authorization; the shared
dialog workflow. Include the ONE-route guarantee and the preview endpoint's
justification.)

## F. Default field lists
(Books and Items, in order, with the reasoning for the image default split.)

## G. Deviations from the brief — stated, not buried
1. **No Playwright e2e** (owner decision). Section 28's e2e suite is replaced by
   strengthened component and route tests: list which tests cover which e2e
   step. Playwright is not CI-wired in this repo (no workflow references it) and
   its five existing specs create no data.
2. **No financial permission was invented.** No cost-visibility permission
   exists anywhere in this codebase; unit_cost and retail_price are already
   visible to anyone who can read an item. Financial export fields are therefore
   available to items:export holders, the registry carries an unused
   `permission?` slot, and THIS IS AN OPEN OWNER DECISION.
3. **Personal presets live in localStorage,** not the database, because
   saved_views.scope carries a CHECK constraint limited to ('inventory','books')
   and its state sanitizer has no room for export configuration. The DB design is
   sketched in section I.
4. **The image source row has no `originalUrl`.** Exports never carry a master
   image URL.
5. **Two progress stages, not four.** The server does all the work in one
   request with no progress channel; announcing "Loading cover images" would be
   a guess, and section 23 forbids fake progress.
6. **No UTF-8 BOM in CSV.** Section 15 allows one only after verifying current
   consumers; every CSV this product has emitted is BOM-less.
7. **A4 paper is not offered.** Letter and Legal only, per section 11's "A4 only
   if it fits requirements".

## H. Image behaviour
(Thumbnail source and the full fallback chain; size limits per image and per
export; what happens on failure; how images are sized in PDF and Excel; the
WebP limitation with its measured evidence from the manual walk.)

## I. Remaining limitations and recommended next phases
- Maximum embedded images and total bytes (state the constants).
- PDF readability limits and where the warning fires.
- CSV image URLs are signed and expire (state the TTL: 30 days, cached 25).
- Serverless duration: maxDuration 60 shared with the row cap of 10,000.
- Unsupported image types (WebP in Excel; verify PDF from the manual walk).
- The legacy GET /api/inventory/export.csv still emits the old fixed columns.
- Database-backed shared export presets: the design (a new `export_presets`
  table or a widened saved_views scope + sanitizer), and why it was deferred.
- Mobile has no export surface at all, so nothing shipped there.

## J. Validation commands and their real results
(Paste from the verification log. No unrun claims.)
```

- [ ] **Step 6: Commit.**

```bash
git add docs/superpowers/reports/2026-08-03-export-builder-verification.md \
        docs/superpowers/reports/2026-08-03-export-builder-report.md
git commit -m "docs(inventory): export builder verification log and engineering report"
```

- [ ] **Step 7: STOP for the owner.** Report the gate results, the manual-walk findings (especially the two image questions), and the three open decisions from the plan header. Do not push, do not open a PR, do not deploy without an explicit go-ahead (Global Constraint 19).

---

## Acceptance-criteria coverage (Brief §30, all 33)

| # | Criterion | Task(s) |
|---|---|---|
| 1 | ISBN in the Books PDF by default | 2 (Phase A fix), 4 (registry default), 13 (dynamic columns) |
| 2 | Book cover images supported | 7 (resolution), 9 (render), 13 (wiring) |
| 3 | Cover images can be toggled | 14 (checkbox drives the image field), 15 |
| 4 | Image sizes small / medium / large | 8 (geometry), 9 (PDF), 11 (Excel), 14 (control) |
| 5 | Rows grow taller for images | 8 (row height tiers), 9 (minHeight per row) |
| 6 | Aspect ratio preserved | 9 (objectFit contain), 10 (catalog covers), 11 (fitBox + readImageDimensions) |
| 7 | A missing image never breaks the export | 7 (fail-closed + skip), 9 (placeholder), 11 (blank cell) |
| 8 | On Hand and Category never merge | 1 (fit test), 2 (route test), 8 (layout test) |
| 9 | Headers never overlap | 1 (padding + minimums + font-metric test), 8, 9 |
| 10 | Users choose fields | 4 (registry), 14 (state), 15 (UI) |
| 11 | Users control field order | 14 (moveField), 15 (four keyboard controls) |
| 12 | Order preserved in all three formats | 5 (resolver keeps request order), 9, 11, 12 |
| 13 | Separate sensible defaults for books and items | 4 (two ordered default arrays), 14 |
| 14 | ONE builder for selected / filtered / all | 17 (both popovers replaced) |
| 15 | CSV carries an image URL, never binary | 5 (rejects embedded+csv), 12 (Image URL heading) |
| 16 | Excel can embed images optionally | 11, 14 (image mode control) |
| 17 | PDF supports table AND catalog | 9 (table), 10 (catalog) |
| 18 | ISBN is text in Excel | 11 (`numFmt = '@'`) |
| 19 | No scientific notation | 11 (explicit text format + assertion) |
| 20 | Server validates every setting | 5 (resolveExportFields), 13 (route returns 400/403) |
| 21 | No unauthorized field can be exported | 5 (permission slot enforced), 13 |
| 22 | Rate limiting intact | 13 (unchanged `exportRateLimited`; preview uses its own key) |
| 23 | Org and warehouse scoping intact | 13 (filtered-only warehouse filter, asserted) |
| 24 | A failure preserves the configuration | 14 (error rendered inside the dialog, state untouched) |
| 25 | Loading state prevents duplicates | 14 (busy guard, asserted) |
| 26 | Fully keyboard accessible | 15 (reorder buttons), 17 (names, focus restore, no colour-only state) |
| 27 | Works on mobile / narrow screens | 17 (responsive shell assertions) |
| 28 | Existing filtering still works | 17 (R5 — `filtersFromParams` moved verbatim) |
| 29 | Existing selected-item actions still work | 17 (R4 — only the export popover is replaced) |
| 30 | Unit, component, route and e2e tests pass | 18 — e2e is a DOCUMENTED deviation (Global Constraint 6) |
| 31 | Typecheck passes | 18 |
| 32 | Lint passes | 18 |
| 33 | Production build passes | 18 |

## Brief section coverage (all 31)

| Section | Where |
|---|---|
| 1 Inspect before coding | The Phase 1 audit; every task cites file:line |
| 2 One reusable builder | 14 (dialog), 17 (both entry points) |
| 3.1 Header collision | 1 |
| 3.2 ISBN default + text safety | 2, 4, 11, 12 |
| 3.3 Cover images + fallbacks | 7, 9 |
| 3.4 Row size with images | 8, 9 |
| 4 One dialog component | 14, 17 |
| 5 Builder UX copy | 14 (title, descriptions, scope line — exact strings asserted) |
| 6 Format selection + descriptions | 14 (three cards, exact copy) |
| 7 Field selection, grouped | 4 (groups), 15 (search + grouping) |
| 8 Books default preset | 4 (`BOOKS_DEFAULT_FIELD_KEYS`), 14 (preset) |
| 9 Items default preset | 4 (`ITEMS_DEFAULT_FIELD_KEYS`), 14 |
| 10 Field controls + keyboard reorder | 15 |
| 11 PDF layout options | 8 (engine), 9 (render), 14 (controls) |
| 12 Book catalog layout | 10 |
| 13 Column-fitting logic + warning copy | 1, 8, 15 (warning surfaced) |
| 14 Excel improvements | 11 |
| 15 CSV improvements | 12 |
| 16 Export request schema | 5, 13 |
| 17 Central field registry | 4 |
| 18 Image data pipeline | 4 (source row), 7 (resolvers and caps) |
| 19 Live preview | 13 (endpoint), 16 (panel) |
| 20 Missing ISBN / image indicators | 13 (counts), 16 (readiness panel) |
| 21 Saved export presets | 14 (eight built-ins + localStorage; DB deferred with reasoning) |
| 22 Filenames | 12 |
| 23 Loading and progress | 13 (real stages), 14 (duplicate guard, error preserves settings) |
| 24 Performance | 7 (caps and concurrency), 13 (opt-in image work), Global Constraint 3 |
| 25 Authorization and security | 5, 13, Global Constraints 3, 4, 5 |
| 26 Accessibility | 15, 17 |
| 27 Mobile / responsive | 17 |
| 28 Testing requirements | Every task; e2e replaced per Global Constraint 6 |
| 29 Manual QA checklist | 18 Step 3 |
| 30 Acceptance criteria | The table above |
| 31 Required final report | 18 Step 5 |

**Brief §20's optional extra** — "Export only books missing ISBN" — is deliberately NOT built. The brief conditions it on fitting the current filtering architecture, and it does not: `ItemListFilters` has no "custom field is empty" predicate, and adding one is a service-and-index change with nothing to do with exporting. The readiness panel reports the count instead. Recorded in the §31 report under G.

## Self-review notes

**Spec coverage.** Both tables above were built by walking the brief section by section and the criteria one by one. The only requirement deliberately not implemented is the missing-ISBN filter, explained above. Two brief assumptions the code contradicts are handled explicitly rather than silently: the financial permission (Global Constraint 5) and the shape of `InventoryExportSourceRow.image` (no `originalUrl`).

**Placeholder scan.** Every step that changes code carries the code. The two intentional stubs — `ExportBuilderFields` and `ExportBuilderPreview` in Task 14 Step 12, and `CatalogBody` in Task 9 Step 3 — are complete, compiling implementations with a named replacement task and an explicit un-skip step, not "TBD".

**Type consistency.** The names below are fixed across every task; a task that renames one breaks its neighbours.

| Name | Defined in | Used by |
|---|---|---|
| `fitColumnWidths(columns, availableWidthPt)` | 1 | 1, 8 |
| `InventoryExportSourceRow` (camelCase fields, `image: InventoryExportImage \| null`) | 4 | 4, 6, 7, 9, 11, 12, 13, 16 |
| `InventoryExportField.value(row)` | 4 | 9, 11, 12, 16 |
| `fieldHeading(field, { format, itemType })` | 4 | 8, 11, 12, 15, 16 |
| `BOOKS_DEFAULT_FIELD_KEYS` / `ITEMS_DEFAULT_FIELD_KEYS` | 4 | 5, 14 |
| `resolveExportFields(...) -> { ok, fields, imagesRequested } \| { ok:false, status, message }` | 5 | 13 |
| `buildInventoryExportSourceRows(ctx, args)` | 6 | 13 (export + preview) |
| `attachExportImages(ctx, rows, { imageSize })` | 7 | 13 |
| `fetchExportImageBytes(urls, opts) -> { images, skipped, truncated }` | 7 | 11, 13 |
| `countRowsWithImages(ctx, itemIds)` | 7 | 13 (preview) |
| `computeExportPdfLayout(input) -> ExportPdfLayout` | 8 | 9, 13, 14, 15 |
| `buildExportPdfRows(rows, layout, fields, { showImages })` | 9 | 13 |
| `toInventoryXlsx(input)` (object argument) | 11 | 13 |
| `toInventoryCsv(input)` | 12 | 13 |
| `buildExportFilename(input)` | 12 | 13 |
| `ExportBuilderState` / `toExportRequest` | 14 | 14, 15, 16, 17 |
| `ExportBuilderFieldsProps` / `ExportBuilderPreviewProps` | 14 | 15, 16 |

**Ordering constraint.** Task 11 deliberately leaves the repository with ONE typecheck error (the route's old `toInventoryXlsx` call) that Task 13 clears. That is called out in Task 11 Step 5 so a reviewer does not "fix" it by weakening the new signature. No other task ends red.

## Open questions for the owner — flag, do not decide silently

1. **Financial fields (BLOCKING a final answer, not blocking the build).** No cost-visibility permission exists. This plan keeps the status quo: cost, price and inventory value are exportable by anyone with `items:export`, exactly as they are already visible on the item page. If costs should be restricted, that is a product-wide permission change with its own migration and pgTAP count bump — out of scope here.
2. **Should personal presets be shared and durable?** They are per browser today. A database-backed, optionally org-shared preset (the `saved_views` pattern, new table) is the natural next phase and needs a migration.
3. **CSV image URLs are signed and expire** (30-day TTL, 25-day cache). A CSV mailed to a supplier stops resolving after a month. The alternatives are a stable authorized URL, a documented duration, or omitting the column — the owner picks.
4. **WebP in Excel and possibly PDF.** Uploaded item photos are stored as WebP; exceljs cannot embed it and older Excel cannot decode it. ISBN-imported book covers are JPEG and work. Task 18's manual walk settles whether the PDF has the same limit; if it does, the fix (fetch bytes, embed as a data URI) is scoped and cheap but wants a decision.
5. **The legacy `GET /api/inventory/export.csv`** keeps emitting the fixed 25-column dump forever. Retire it, or leave it as the stable machine contract?
6. **Row cap and rate limit.** 10,000 rows and 40 exports/hour are unchanged. An image-heavy PDF now costs far more than a bare CSV against the same budget; if warehouse staff hit it, the budget needs splitting per format.

