# Custom Export Builder — engineering report

Branch: `feat/export-builder`, HEAD `7e63157e` (30 commits ahead of `main`, local only, not pushed).
Brief: `.superpowers/sdd/export-builder-brief.md` (owner master prompt, 31 sections).
Plan: `docs/superpowers/plans/2026-08-03-export-builder.md` (18 tasks, five phases, committed `1aa18c46`).
Audit: `docs/superpowers/specs/2026-08-03-export-builder-audit.md` (committed `acf02191`).
Verification log: `docs/superpowers/reports/2026-08-03-export-builder-verification.md` (Phase A gate + Phase B-E gate, invariant greps, and the complete manual Demo-org walk).

This report describes what the branch's code actually does, verified against the files cited in each section by opening them directly during this task — not by trusting the plan's or the progress ledger's line numbers. Discrepancies found while doing that are called out inline and summarized at the end.

---

## A. Files inspected

### A1. Files the Phase 1 audit read (carried forward, re-verified here)

Export pipeline:
- `apps/web/src/components/inventory/inventory-table.tsx` — the old `ExportMenu` (formerly lines 3565-3636) and the three "Generic" charter render branches (formerly 2154-2176, 2903-2919, 3273-3289).
- `apps/web/src/components/inventory/bulk-actions.tsx` — the old `exportSelected` popover (formerly lines 171-180, 310-343).
- `apps/web/src/lib/download-export.ts` — `InventoryExportRequest`, `downloadInventoryExport`.
- `apps/web/src/app/api/inventory/export/route.tsx` — the old hardcoded `PDF_COLUMNS` (formerly lines 56-64), auth/rate-limit/scope handling.
- `apps/web/src/app/api/inventory/export.csv/route.ts` — the legacy GET CSV route (untouched by this program; see B and G).
- `apps/web/src/lib/inventory-export.ts` — `INVENTORY_EXPORT_HEADERS`, `buildInventoryExportRows`, the ISBN fallback chain (formerly lines 164-167) and the pre-fix charter line (formerly line 157: `charter: i.charter_id ? (chMap.get(i.charter_id) ?? '') : ''`).
- `apps/web/src/lib/inventory-export-xlsx.ts` — the original 47-line writer (single `'Inventory'` sheet, header-length-derived column widths, no `numFmt`).
- `apps/web/src/lib/pdf/report-table.tsx` — `ReportColumn`, `flexForColumn`, `SectionView`, `renderCellValue`, the `imageColumn`/`thumb`/`thumbPlaceholder` styles, and the header-collision root cause (formerly lines 106-112 `headerCell` vs 122-126 `cell`).
- `apps/web/src/lib/csv.ts` — `escapeForSpreadsheet`, `toCsv`, `csvFilename`.

Data model:
- `apps/web/src/components/inventory/item-form.tsx:2241` — the ISBN/Barcode label convention.
- `apps/web/src/lib/book-storage.ts` — `readBookStorage`, the `book_rack_number`/`book_rack_row`/`book_crate_color`/`book_crate_number`/`book_grade` custom-field keys and the `rackLabel`/`crateLabel` composition.
- `apps/web/src/server/services/item-images.ts` — the `item_images` table shape and all four resolver methods (verified at lines 422-499 `primaryImagesForPdfRendering`, 513-565 `primaryMasterUrlsForItems` — both line numbers hold, no drift from the audit).
- `packages/core/src/constants/permissions.ts` — `PERMISSIONS`, `ROLE_PERMISSIONS`, `PERMISSION_META`, confirming no cost/valuation permission exists.
- `apps/web/src/server/loaders/inventory-list.ts` / `apps/web/src/server/services/inventory.ts` — `InventoryListItemRow`, `ItemListFilters`, `ItemListSort`.

UI infrastructure:
- `apps/web/src/components/ui/dialog.tsx`, `select.tsx`, `popover.tsx`, `sonner.tsx` — confirmed present; no `checkbox.tsx`, no `tabs.tsx`, no drag/reorder primitive (`sortable|dnd-kit|react-beautiful-dnd` grepped clean).
- `apps/web/src/server/services/saved-views.ts` and `supabase/migrations/0035_saved_views.sql:14` — the `saved_views.scope` CHECK constraint that rules out reusing that table without a migration.

Test infrastructure:
- `apps/web/src/lib/inventory-export.test.ts` (the only export unit test pre-branch).
- `apps/web/src/lib/pdf/table-fit.test.ts` — the font-metrics/worst-case-width technique later extracted for reuse.
- `apps/web/playwright.config.ts` and `apps/web/tests/e2e/*.spec.ts` (5 specs) — confirmed Playwright is not referenced in any `.github/workflows/*.yml`.

### A2. Files opened during implementation, beyond the audit's list (re-read directly for this report)

- `apps/web/src/app/api/inventory/export/route.tsx` (current, 279 lines, read in full) — the rewritten POST route.
- `apps/web/src/app/api/inventory/export/preview/route.ts` (137 lines, read in full).
- `apps/web/src/lib/exports/field-registry.ts` (778 lines, read in full).
- `apps/web/src/lib/exports/export-request.ts` (199 lines, read in full).
- `apps/web/src/lib/exports/source-row.ts` (110 lines, read in full).
- `apps/web/src/lib/exports/export-images.ts` (292 lines, read in full).
- `apps/web/src/lib/exports/pdf-layout.ts` (397 lines, read in full).
- `apps/web/src/lib/exports/export-csv.ts` (45 lines, read in full).
- `apps/web/src/lib/exports/filename.ts` (52 lines, read in full).
- `apps/web/src/lib/inventory-export.ts` (current, 287 lines, read in full).
- `apps/web/src/lib/inventory-export-xlsx.ts` (current, 313 lines, read in full).
- `apps/web/src/lib/charter-display.ts` (30 lines, read in full).
- `apps/web/src/lib/pdf/inventory-pdf-columns.ts` (82 lines, read in full).
- `apps/web/src/lib/pdf/column-fit.ts` (120 lines, read in full).
- `apps/web/src/lib/pdf/report-table.tsx` (current header-cell/cell styles, lines 130-174, read directly).
- `apps/web/src/lib/pdf/inventory-export-pdf.tsx` (452 lines, read in full).
- `apps/web/src/lib/download-export.ts` (current, 129 lines, read in full).
- `apps/web/src/components/inventory/export-builder/export-builder-state.ts` (332 lines, read in full).
- `apps/web/src/components/inventory/export-builder/export-builder-presets.ts` (247 lines, read in full).
- `apps/web/src/components/inventory/export-builder/export-builder-preview.tsx` (127 lines, read in full).
- `apps/web/src/components/inventory/export-builder/export-builder-dialog.tsx` (~588 lines; the imports, format-card copy, state wiring, focus-restore fix, `runExport`, and `stageLabel` sections read directly).
- `apps/web/src/components/inventory/export-builder/export-builder-fields.tsx` (grepped for `MAX_FIELDS`, keyboard-reorder `aria-label`s).
- `apps/web/src/components/inventory/inventory-table.tsx` (diff against `main` read in full — the `ExportMenu` rewrite and the three `GENERIC_CHARTER_LABEL` swaps).
- `apps/web/src/components/inventory/bulk-actions.tsx` (diff against `main` read in full).
- `apps/web/src/app/api/reports/[slug]/pdf/route.tsx` (diff against `main` read — confirms the Task 1 fix-wave's extraction into `report-configs.ts`).
- `apps/web/src/server/services/inventory.ts` and `apps/web/src/server/loaders/inventory-list.ts` (diffs against `main` read — the `reorder_quantity` select fix and its documented, deliberate non-propagation to the cached list loader).
- `apps/web/src/app/api/inventory/export.csv/route.ts` (diff against `main` confirmed empty).
- `.superpowers/sdd/progress.md` (Export Builder program entries, lines 482-521) and `.superpowers/sdd/export-builder-brief.md` (full, 315 lines) and `docs/superpowers/plans/2026-08-03-export-builder.md` (Global Constraints and File-structure sections) — the program's own record, cross-checked against the code rather than quoted on faith.

---

## B. Files changed, and why each one

| File | Why changed | Breaks if reverted |
|---|---|---|
| `apps/web/src/app/api/inventory/export/route.tsx` | Rewritten from a fixed `format/scope/itemType/ids/filters` handler with a hardcoded 7-column PDF into the one route that resolves fields through the registry, builds source rows once, opts into images only when requested, and dispatches all three formats. | Every export (CSV/XLSX/PDF, all three scopes) reverts to the old fixed 7/25-column output; ISBN, images, and all field customization disappear from the live route. |
| `apps/web/src/app/api/reports/[slug]/pdf/route.tsx` | Four report sections' inline column arrays replaced with spreads from the new `report-configs.ts` (`...REPORT_PDF_SECTIONS['inventory-valuation']![0]!` and similarly for `stock-movements` (2 sections) and `reorder-forecast`), carrying the `minWidth` floors the Task 1 fix-wave derived. | The four report PDFs (`inventory-valuation`, `stock-movements` x2, `reorder-forecast`) lose their `minWidth` floors and regress to the pre-existing header overflows the fix-wave found and closed (Stagnant, Age (days), Carrying value, Reorder at/qty, Component value out). |
| `apps/web/src/components/inventory/bulk-actions.tsx` | The inline 3-button "Export N selected" popover and its own `exportBusy`/`exportSelected` logic are removed; a `Download` button now opens `<ExportBuilderDialog scope="selected" .../>`. | Selected-item export loses field selection, images, and every builder capability, and the bulk-actions surface no longer shares its export path with Books/Items — R4 (BulkActions' other actions: Print labels, Cycle count, Archive, etc.) is untouched, confirmed by the diff. |
| `apps/web/src/components/inventory/inventory-table.tsx` | `ExportMenu`'s two-popover-with-format-buttons UI is replaced by a two-button scope picker that opens the shared dialog; `ExportMenu` is now exported (a seam, matching `Pagination`/`MultiSelectFilter`); the three inline `'Generic'` string literals are replaced with `GENERIC_CHARTER_LABEL` from `charter-display.ts`. | "Export filtered"/"Export all" from the Books/Items toolbars lose the builder entirely and the list page's own "Generic" charter label goes back to being a private string instead of the one both the list and the export path share (cosmetically identical today, but a future edit to one would silently drift from the other). |
| `apps/web/src/lib/download-export.ts` | `InventoryExportRequest` gains `fields`/`options`; `downloadInventoryExport` gains real two-stage progress (`preparing`/`downloading`/`done`) and an `AbortSignal`; a new `fetchExportPreview`/`ExportPreviewResponse` pair is added for the preview endpoint. | The dialog cannot send a field list or PDF/Excel options, and the preview panel has no data source — the request shape collapses back to `format/scope/itemType/ids/filters` only. |
| `apps/web/src/lib/inventory-export-xlsx.ts` | Full rewrite: `toInventoryXlsx` moves from a 2-argument `(headers, rows)` call to one options object, adds a Books/Inventory sheet name, friendly labels, per-type `numFmt`, autofilter, frozen header, wrapped text, embedded pictures (`XLSX_IMAGE_CELL`, `readImageDimensions`, `fitBox`), and an optional summary sheet. | Excel exports lose ISBN's `numFmt = '@'` text-safety, embedded images, autofilter, and the summary sheet; the sheet reverts to a bare `'Inventory'`-named dump with header-length-derived widths. |
| `apps/web/src/lib/inventory-export.ts` | `buildInventoryExportSourceRows` is added as the one row-building function every format now reads; the null-charter line now calls `formatCharterCell` (`charter-display.ts`) instead of writing `''`; `buildInventoryExportRows` becomes a thin snake_case projection of the source rows, preserving the legacy shape byte-for-byte via a dedicated `legacyRawBookFields` untrimmed copy. | The "Generic" charter fix disappears from every format (CSV/Excel/PDF all revert to blanking a null charter); the new typed pipeline (field registry, images, preview) loses its data source; the legacy `.csv` route's byte-identical guarantee (R1) has nothing feeding it the untrimmed values it depends on. |
| `apps/web/src/lib/pdf/report-table.tsx` | `headerCell` gains `paddingHorizontal: REPORT_CELL_PADDING_PT` (matching the body `cell`'s existing 3pt); `ReportColumn` gains `minWidth`/`maxWidth`/`wrap`; column widths come from `fitColumnWidths` instead of a bare flex ratio; `ReportTablePdfProps` gains `contentWidthPt`. | The header-gutter fix (the owner's original "ON HANDCATEGORY" defect) reverts on all seven live report sections and the export PDF alike; columns go back to unbounded flex-ratio shrinking with no floor. |
| `apps/web/src/lib/pdf/table-fit.test.ts` | Imports the extracted `apps/web/src/test/pdf-font-metrics.ts` metric table instead of keeping a private copy, so the PO PDF's font-metrics test and the new report/export tests share one source of glyph widths. | Two independently-maintained copies of the same Helvetica AFM metrics reappear, free to drift apart. |
| `apps/web/src/server/services/inventory.ts` | `InventoryService.list()`'s `.select(...)` column list gains `reorder_quantity`; the private row type gains the matching field with a doc comment explaining it is `numeric(14,4) not null default 0`, same semantics as `reorder_point`. | The registry's `reorder_quantity` field (selectable in every export) silently reads `undefined ?? 0` for every row — the exact "always zero" bug Task 6's review caught before it shipped. |
| `apps/web/src/server/loaders/inventory-list.ts` | Comment-only: documents that this loader's separately-maintained `ITEM_SELECT_COLUMNS` string deliberately does NOT copy `reorder_quantity` in, since no consumer of `loadInventoryList` reads it and it is a hot, 60-second-cached, do-not-regress path. | No functional change if reverted — the prior comment claimed the list was "verbatim," which was made false by the `inventory.ts` change above; reverting only re-introduces a stale comment, not a bug. |
| `apps/web/src/lib/inventory-export.test.ts`, `apps/web/src/server/services/inventory.test.ts` | Extended with charter/ISBN/source-row coverage and a `reorder_quantity` select-string assertion, respectively. | Loses the regression coverage for the two fixes above; the code would still work, but silently. |

---

## C. New files

Every implementation file below shipped with a paired test file of the same base name (`*.test.ts`/`*.test.tsx`); both are new. Three process documents (the plan, the audit, and the verification log) are also new but are not part of the shipped product — they are listed at the end of this section.

- `apps/web/src/test/pdf-font-metrics.ts` — Helvetica/Helvetica-Bold/Courier AFM glyph-width table and `width()`, extracted so two independent PDF test suites (PO and report/export) share one metric source instead of two private copies.
- `apps/web/src/lib/pdf/column-fit.ts` — `fitColumnWidths()`: pure point-width allocator with hard minimums/maximums and a proportional-scale-down fallback when minimums alone overflow the page. No `@react-pdf/renderer` import, so the browser-side dialog can reuse it for its own warnings.
- `apps/web/src/lib/pdf/inventory-pdf-columns.ts` — `BOOKS_PDF_COLUMNS` (with ISBN) and `ITEMS_PDF_COLUMNS`, the Phase A hand-picked replacement for the route's old inline array; superseded downstream by the field registry but its tuned width floors are inherited by it.
- `apps/web/src/lib/charter-display.ts` — `GENERIC_CHARTER_LABEL` and `formatCharterCell()`, the one shared definition of how a null-charter item renders, now used by both the list page and every export format.
- `apps/web/src/lib/pdf/report-configs.ts` — the seven live `/api/reports/[slug]/pdf` sections' column definitions extracted out of the route into data, so the Task 1 fix-wave's `minWidth` derivations live in one place and the route only spreads them in.
- `apps/web/src/lib/exports/source-row.ts` — `InventoryExportSourceRow` and `ExportCell`, the one raw row shape every format (CSV, Excel, PDF table, PDF catalog) reads through the field registry.
- `apps/web/src/lib/exports/field-registry.ts` — `EXPORT_FIELDS` (29 fields: 15 common, 9 book, 3 financial, 2 system), `BOOKS_DEFAULT_FIELD_KEYS`, `ITEMS_DEFAULT_FIELD_KEYS`, `IDENTIFYING_FIELD_KEYS`, `fieldHeading()` — the single typed registry that drives the dialog's checkboxes, server validation, and every format's headings/widths/values.
- `apps/web/src/lib/exports/export-request.ts` — the Zod request schema (`inventoryExportRequestSchema`, `.strict()` at all five object levels) and `resolveExportFields()`, the server-side re-derivation of the authoritative field list from a client-submitted key array.
- `apps/web/src/lib/exports/export-images.ts` — server-only image pipeline: `attachExportImages`, `countRowsWithImages`, `fetchExportImageBytes`, all built on `ItemImagesService.primaryImagesForPdfRendering`, with the byte/count/timeout/concurrency caps and the request-local (never module-level) URL cache.
- `apps/web/src/lib/exports/pdf-layout.ts` — `computeExportPdfLayout()` and `estimateExportPdfPages()`: paper size, orientation (including the explainable auto-orientation heuristic), density, identifier-column-reserved-first allocation, and the overflow warning that names the actual offending columns.
- `apps/web/src/lib/pdf/inventory-export-pdf.tsx` — the export's own `<Document>`: table mode (`TableHeader`/`TableBody`), book catalog mode (`CatalogBody`), page numbers, repeated headers, and `buildExportPdfRows()`.
- `apps/web/src/lib/exports/export-csv.ts` — `toInventoryCsv()`: field-driven CSV headings and values, delegating all quoting/escaping to the existing `csv.ts`.
- `apps/web/src/lib/exports/filename.ts` — `buildExportFilename()` and `sanitizeFilenameSegment()`, the one descriptive, Content-Disposition-safe filename builder for the builder's downloads.
- `apps/web/src/app/api/inventory/export/preview/route.ts` — the sibling POST route that returns up to 10 sample rows plus readiness counts, generates no file, and never signs an image URL.
- `apps/web/src/components/inventory/export-builder/export-builder-state.ts` — pure dialog state: `initialExportBuilderState`, `toggleField`, `moveField`, `setFormat`, `setOptions`, `validateExportBuilder`, `toExportRequest`, `scopeSummary`, `builderSummaryParts`.
- `apps/web/src/components/inventory/export-builder/export-builder-presets.ts` — the eight built-in presets plus versioned, sanitized `localStorage` personal presets (`stockpilot.export-presets.v1`, capped at 20).
- `apps/web/src/components/inventory/export-builder/export-builder-dialog.tsx` — the dialog shell itself: format cards, preset picker, options, submit/error/busy state, the preview-fetch effect, and the focus-restore fix for a trigger that lives in a different component.
- `apps/web/src/components/inventory/export-builder/export-builder-fields.tsx` — the searchable, grouped field checklist with the four keyboard reorder controls (`Move … to top/up/down/to bottom`) and the client-side `INVENTORY_EXPORT_MAX_FIELDS` (30) cap.
- `apps/web/src/components/inventory/export-builder/export-builder-preview.tsx` — the live sample table and the ISBN/cover readiness panel.

Process documents (new, not shipped product code):
- `docs/superpowers/plans/2026-08-03-export-builder.md` — the 18-task implementation plan (10,417 lines).
- `docs/superpowers/specs/2026-08-03-export-builder-audit.md` — the Phase 1 audit this section A draws from.
- `docs/superpowers/reports/2026-08-03-export-builder-verification.md` — the gate/invariant/manual-walk log this report's §J summarizes.

---

## D. The current problems, explained

The Task 18 brief specifies this section's opening explanations verbatim; they are reproduced here unedited, then extended with what the rest of the program found underneath them.

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

**A note on the citations inside that verbatim block.** They describe file:line positions as they stood at Phase 1 audit time, before any fix landed, and were re-verified against the pre-fix commit for accuracy rather than trusted blindly. The code has since moved: the ISBN derivation quoted at `inventory-export.ts:164-167` now lives at `inventory-export.ts:188-191` inside `buildInventoryExportSourceRows`, with the same fallback chain (`(i.barcode ?? '') || str('isbn') || str('isbn13') || str('isbn10')`) unchanged in substance; `report-table.tsx:106-112`/`122-126` (the pre-fix `headerCell`/`cell` styles) now correspond to `report-table.tsx:140-153`/`163-167` post-fix, with the gutter fix described in section B already applied there. Section A's own file citations use the current, post-fix locations throughout.

**What the program found once it started fixing these.** Padding alone was necessary but not sufficient for the header fix: a bare flex-ratio split has no floor, so a column can still be squeezed to nothing under a crowded row. Task 1 replaced the ratio split with `fitColumnWidths()` (point-based allocation with hard minimums) and, while sweeping every live report section through the real allocator to prove the new gutter didn't break them, found the gutter's own 6pt cost flipped `dead-stock`'s "Stagnant" header from fitting to overflowing, eroded `velocity-class`'s margins below 1.5pt, and exposed that `dead-stock`'s "Age (days)"/"Carrying value" and `reorder-forecast`'s "Reorder at"/"Reorder qty" were **already overflowing on `main`, before this program touched anything** — four pre-existing bugs the header-collision fix would otherwise have made worse rather than better. All five were closed with derived (not guessed) `minWidth` floors, permanently guarded by `report-headers-fit.test.ts` running every real report config through the real allocator.

The ISBN fix had the same shape of surprise: a plain 13-digit ISBN-13 needs only 61.44pt, but `inventory_items.barcode` (which doubles as the ISBN column) has no digit-only validation anywhere a human can type it — `item-form.tsx`'s ISBN input strips nothing, and the Zod schema is `z.string().max(128).trim()`. A person copying "978-1-234-56789-7" straight off a book's back cover saves the hyphens, which measure 72.76pt — wide enough that the header-width-only floor (66pt) would have truncated a real, common ISBN the moment the row got crowded. The registry's `isbn.pdfMinWidth` is 81pt, derived from that worst-case value, not the header.

The "nothing was customizable" gap turned out to require more structural work than a UI alone: Task 8's review found that the registry's own default presets, run through the real layout engine in portrait orientation, overflowed 7 of 11 headers — the exact `ON HANDCATEGORY`-class collision the program had just fixed, reappearing at every image size once a proportional allocator with no concept of "this column must never truncate" was allowed to shrink an ISBN/SKU/barcode column along with everything else. The fix was `pdf-layout.ts`'s identifier-reserve-first allocation (`allocateColumnWidths`): identifier columns (`field.identifier`) are pulled out and given their fixed floor *before* `fitColumnWidths` ever runs on the rest, so the scale-down branch can shrink prose columns without ever touching an identifier.

---

## E. The new export architecture

**Registry.** `apps/web/src/lib/exports/field-registry.ts` is the one typed list (`EXPORT_FIELDS`, 29 entries: 15 common, 9 book-only, 3 financial, 2 system) that every downstream piece reads: `label`/`group`/`appliesTo` drive the dialog's checkboxes and grouping; `csvSupported`/`xlsxSupported`/`pdfSupported` and `permission?` are re-enforced server-side; `pdfWidth`/`pdfMinWidth`/`pdfMaxWidth`/`wrap`/`identifier` drive PDF geometry; `value(row)` is the single extractor every format calls. It has no `server-only` import and no Supabase/`@react-pdf` dependency, so the browser-side dialog and the server route import the identical module — "the order you chose is the order you get, in all three formats" is an assertion the code enforces by construction, not a hope.

**Request schema and server validation.** `apps/web/src/lib/exports/export-request.ts` defines `inventoryExportRequestSchema` (`.strict()` at the top level and at all four nested object schemas — `filters`, `options`, `options.pdf`, `options.xlsx` — after a Task 5 review finding that none of the five were strict, which meant an unknown key was silently stripped instead of rejected). `resolveExportFields()` is the server-side re-derivation: given a possibly-hostile client field list, it walks each key, rejects duplicates, unknown keys, book-only fields on a non-book export, a field unsupported by the requested format, and a permission-gated field the caller lacks (`export-request.ts:129-198`); it then enforces "at least one identifying field" (`IDENTIFYING_FIELD_KEYS`: name, sku, isbn, barcode), the CSV-cannot-embed-images rule, the PDF-cannot-do-"both" rule, and the book-catalog-is-book-and-PDF-only rule. Order is preserved exactly as requested.

**PDF layout generation.** `apps/web/src/lib/exports/pdf-layout.ts`'s `computeExportPdfLayout()` is pure (no React/`@react-pdf` import) so the dialog can call the identical function the route calls, meaning the column-count warning and page estimate shown before export match what export actually produces. It resolves paper size (Letter/Legal only — A4 deliberately excluded), auto-orientation (portrait only when every column's minimum fits AND there are at most 5 non-image columns), image reserve, identifier-first column allocation, and an overflow warning that names the actual squeezed columns and recommends landscape or Legal only when a trial allocation proves that orientation/size would actually clear every column (`overflowRemedies`, `pdf-layout.ts:272-286`).

**Image resolution.** `apps/web/src/lib/exports/export-images.ts` never resolves images unless the request selected the Image field — `attachExportImages` is called from the route only when `resolveExportFields` reports `imagesRequested: true`. It calls `ItemImagesService.primaryImagesForPdfRendering` (`item-images.ts:422-499`) exactly once for the whole row set, batched, and never `primaryMasterUrlsForItems` (the 2048px public-catalog resolver — enforced by a doc comment at `export-images.ts:8-23` that is itself the one non-code hit the invariant grep in the verification log finds). `fetchExportImageBytes` streams each image with a hard byte cap enforced mid-stream (not after buffering the whole body, which would let a hostile response hold unbounded memory before the check ran), a per-request-only URL cache (deliberately not module-level, to avoid leaking signed URLs across organizations), and an owner/waiter split so a duplicate URL is only charged against the total byte budget once.

**Excel embedding.** `apps/web/src/lib/inventory-export-xlsx.ts`'s `toInventoryXlsx` builds a column plan from the selected fields (an `embedded` image field becomes a picture column; `both` produces a picture column plus a separate "Image URL" column); every text cell gets `numFmt = '@'` (the identifier-safety guarantee — this is what stops Excel turning an ISBN into scientific notation or eating a leading zero); `readImageDimensions` sniffs PNG/JPEG signatures to preserve aspect ratio via `fitBox`; embedded rows grow to `XLSX_IMAGE_CELL[size].rowHeightPt`.

**CSV URL behaviour.** `apps/web/src/lib/exports/export-csv.ts`'s `toInventoryCsv` never embeds binary — the image field's `value()` always returns a plain thumbnail URL string, and `fieldHeading()` renders that column as literally "Image URL" in CSV (never "Include images"), matching the brief's exact-copy requirement.

**Server authorization.** Unchanged and re-verified, not rebuilt: `withApiContext` → 401 (`route.tsx:52-53`), `can(ctx, 'items:export')` → 403 (`:54-56`), `exportRateLimited(ctx.userId, ctx.organizationId)` → 429, shared 40/hour fail-closed budget across CSV/XLSX/PDF and both routes (`:60-61`), `getActiveWarehouseFilterFor(ctx)` applied only on `scope: 'filtered'` (`:139`), `ids` capped at 10,000 by the schema, `ROW_CAP = 10_000` in `buildInventoryExportSourceRows` (`inventory-export.ts:43`), `maxDuration = 60` (`:39`).

**Shared dialog workflow.** `ExportBuilderDialog` (`export-builder-dialog.tsx`) is mounted from three places — the Books/Items toolbar's `ExportMenu` (filtered/all), and `BulkActions`' Export button (selected) — and is the only component that calls `downloadInventoryExport`, confirmed by the verification log's grep (1 definition, 1 production call site, 9 test-file hits). All state transforms (field toggling, reordering, format switching, validation, request assembly) live in the pure, DOM-free `export-builder-state.ts`, the same split the orders storefront's `storefront-logic.ts` uses, on the theory that field ordering and format-switch normalization are where the bugs live and are worth testing without a render.

**The ONE-route guarantee.** Everything ships through the single `POST /api/inventory/export` route by widening its schema — no second file-generating endpoint exists. **The preview endpoint's justification:** `POST /api/inventory/export/preview` is the one deliberate addition, and it generates no file — it returns at most 10 sample rows (with `image` forced to `null`, since a preview must never sign a URL) plus readiness counts, on its own rate-limit key (`export-preview:${userId}`, 120/hour, fail-open — distinct from the export budget's 40/hour fail-closed, so opening the dialog a few times can never lock a user out of actually exporting).

---

## F. Default field lists

**Books, in order (12 fields, `field-registry.ts:711-724`):** Cover, Title, ISBN, SKU, Author, Grade, On hand, Category, Rack, Crate, Location, Status.

**Items, in order (10 fields, `field-registry.ts:734-745`):** Name, SKU, Barcode, On hand, Category, Location, Warehouse, Supplier, Charter, Status.

**Reasoning for the image default split.** Books default with the cover field selected and images on; items default with the image field absent from the selection entirely. `export-builder-state.ts:62-66`'s `defaultOptions()` sets `includeImages: itemTypeKind === 'book'` directly from this omission — a books export needs a cover to identify a shelf's worth of stock at a glance, matching what a physical book review is for; an items export defaults to a data dump, and adding image weight (larger PDFs, slower Excel embeds) to every items export by default would tax the common case for a benefit most items exports don't need. A user can still turn images on for items by selecting the Image field, which is itself the toggle (`export-builder-state.ts:124-147`'s `toggleField` keeps `includeImages` in lockstep with whether `'image'` is in `fieldKeys`, so the server's "includeImages without the image field" rejection is unreachable from this UI). The canonical field order still places Image first (`field-registry.ts:132-149`), so a user who does enable it for an items export gets it in the leading position, matching the books convention.

---

## G. Deviations from the brief — stated, not buried

1. **No Playwright e2e** (owner decision, Global Constraint 6). Section 28's e2e suite is replaced by strengthened component and route tests. Coverage that maps to the brief's would-be e2e steps: dialog open/format-switch/preset-apply/field-toggle/reorder/validation (`export-builder-dialog.test.tsx`, `export-builder-state.test.ts`, `export-builder-fields.test.tsx`), preview rendering and readiness (`export-builder-preview.test.tsx`), the full request→route→file round trip for all three formats and all three scopes (`route.test.tsx`, 501 lines), and the two call-site wiring tests added in Task 17's fix wave (`bulk-actions.export.test.tsx`, `inventory-table.export.test.tsx`). Playwright is confirmed not CI-wired in this repo — `apps/web/tests/e2e/` has 5 specs and `.github/workflows/*.yml` has zero `playwright` references — and none of the five existing specs create data, so a "green e2e gate" was never actually available to lean on.
2. **No financial permission was invented.** No cost-visibility permission exists anywhere in this codebase (`packages/core/src/constants/permissions.ts` grepped for `cost|financ|valuation`, zero hits outside comments); `unit_cost` and `retail_price` are already visible to anyone who can read an item. Financial export fields are therefore available to `items:export` holders, exactly as they already are on screen. The registry's `permission?: Permission` field (`field-registry.ts:106-119`) is a dormant slot, evaluated by `resolveExportFields` (`export-request.ts:160-163`) but populated on no field today. **THIS IS AN OPEN OWNER DECISION**, restated in section I below.
3. **Personal presets live in `localStorage`,** not the database, because `saved_views.scope` carries a `CHECK (scope in ('inventory', 'books'))` constraint (`supabase/migrations/0035_saved_views.sql:14`) and `SavedViewState`'s sanitizer has no room for field lists or format options. The eight built-in presets are code constants (`export-builder-presets.ts:37-160`); a user's own presets are versioned JSON under `stockpilot.export-presets.v1`, capped at 20, and are per-browser, not per-account. The DB design is sketched in section I.
4. **The image source row has no `originalUrl`.** `InventoryExportImage` (`source-row.ts:25-28`) carries only `thumbnailUrl`; exports never carry a master image URL, by design — the brief's sketch of this type included `originalUrl` and it is deliberately absent.
5. **Two progress stages, not four.** `ExportStage` (`download-export.ts:44`) is `'preparing' | 'downloading' | 'done'`. The server does all the work inside one request with no progress channel, so announcing "Loading cover images…" or "Building PDF…" would be a guess dressed as a fact — forbidden by the brief's own section 23. The dialog compensates with a static note when images are enabled rather than a fake stage.
6. **No UTF-8 BOM in CSV.** `export-csv.ts:14-16` states the reasoning directly: every CSV this product has ever emitted is BOM-less, and the brief allows a BOM only after verifying current consumers, which was not done here.
7. **A4 paper is not offered.** `export-request.ts:44-46`: Letter and Legal only, per the brief's own "A4 only if it fits requirements," and no StockPilot org prints A4 today.
8. **A CSV-image-mode coercion exists that the brief's verbatim route did not have** (found during Task 13's implementation, not anticipated by the plan). The two pre-Phase-D triggers send neither `fields` nor `options`; falling back to the Books registry default (which leads with the Image field) collides with the schema's own `imageMode: 'embedded'` default, and `resolveExportFields` correctly 400s "CSV cannot embed images" — which would have broken the live "Export CSV" button for every books export the moment this route shipped, with no caller-side change. The route now coerces `imageMode` to `'url'` only when the format is CSV, no explicit `fields` were sent, and the client did not itself send an `imageMode` (`route.tsx:79-108`, comment explains the full reasoning). Every explicit request — including the builder dialog's own, which always sends `fields` — hits the real rejection unchanged.

---

## H. Image behaviour

**Thumbnail source and fallback chain.** `ItemImagesService.primaryImagesForPdfRendering(itemIds, targetWidth)` (`item-images.ts:422-499`), reused unmodified by `attachExportImages`, resolves per item in this order: (1) the stored `item_images.thumb_path` — a pre-resized ~200px WebP generated client-side at upload — signed directly with no transform; (2) for pre-thumb-era rows with no `thumb_path`, an on-the-fly Supabase Storage transform of the master to `targetWidth` (the one accepted on-the-fly master transform in this codebase, scoped specifically to this function); (3) `inventory_items.custom_fields.thumbnail_url`, the legacy field the ISBN bulk importer writes for book covers sourced from Google Books, Open Library, or archive.org (`item-images.ts:468-497`) — these external URLs are typically JPEG; (4) absent — the caller draws a placeholder. `EXPORT_IMAGE_TARGET_WIDTH_PX` is `{ small: 120, medium: 200, large: 320 }` (`export-images.ts:27-31`).

**Size limits.** Per-image: `MAX_EMBEDDED_IMAGE_BYTES = 512 * 1024` (512KB). Whole-export: `MAX_TOTAL_EMBEDDED_IMAGE_BYTES = 24 * 1024 * 1024` (24MB). Count: `MAX_EMBEDDED_IMAGES = 2_000`. Fetch: `IMAGE_FETCH_TIMEOUT_MS = 6_000`, `IMAGE_FETCH_CONCURRENCY = 6` (`export-images.ts:34-40`).

**On failure.** Every layer is fail-closed and silent: `attachExportImages` catches any error and blanks every row's `image` field rather than 500ing the export (`export-images.ts:87-91`); `fetchOne` catches per-URL timeout/DNS/reset/abort and returns `null`, never logging (the URL carries a signed token) (`:199-201`); an oversized body is abandoned mid-stream via `reader.cancel()` the instant the running total crosses the cap, so the function never holds more than one cap's worth of bytes in memory (`:175-190`); a missing or unresolvable image renders as a labelled placeholder box in the PDF (`inventory-export-pdf.tsx:227-235`, `368-375`) and a blank cell in Excel.

**PDF sizing.** `IMAGE_CELL_PT` (`pdf-layout.ts:60-64`): small 22×28pt, medium 34×44pt, large 48×64pt (width × forced minimum row height). The image is drawn `objectFit: 'contain'`, not `'cover'` (`inventory-export-pdf.tsx:99-101`) — a portrait book cover is never cropped to a square. The catalog layout uses its own tiers, `CATALOG_COVER_PT` (`inventory-export-pdf.tsx:268-272`): 1-column 84×112pt, 2-column 66×88pt, 3-column 50×68pt, also 3:4 portrait and also `contain`.

**Excel sizing.** `XLSX_IMAGE_CELL` (`inventory-export-xlsx.ts:24-31`): small 42pt row height / 7-character column / 40×54px box; medium 66pt / 11 chars / 64×86px; large 96pt / 15 chars / 92×124px. `readImageDimensions` (`:58-95`) sniffs the real PNG/JPEG pixel dimensions and `fitBox` (`:104-115`) scales to fit the box without distortion, falling back to the box unscaled if the signature is unrecognized.

**The WebP limitation, measured.** `ALLOWED_CONTENT_TYPES` (`export-images.ts:48-59`) maps only `image/png`, `image/jpeg`, `image/jpg` — WebP is deliberately absent, because `exceljs` accepts only png/jpeg/gif and `@react-pdf/renderer`'s `<Image>` decodes only PNG and JPEG. Supabase-stored item thumbnails are WebP (client-generated at upload); externally-sourced book covers (the ISBN importer's Google Books/Open Library URLs) are JPEG. The Demo-org manual walk confirmed this split holds in production: every uploaded-photo cover rendered blank in both the PDF and the Excel embed, while the split is otherwise fully functional (correct placeholders, correct sizing, correct fallback to the URL column). Full analysis and fix options are in section I.

---

## I. Remaining limitations and recommended next phases

**Maximum embedded images and total bytes.** `MAX_EMBEDDED_IMAGES = 2,000`, `MAX_EMBEDDED_IMAGE_BYTES = 512KB` per image, `MAX_TOTAL_EMBEDDED_IMAGE_BYTES = 24MB` total (`export-images.ts:34-38`). Once the byte budget is spent mid-export, remaining rows are skipped (not failed) and `EXPORT_TOO_MANY_IMAGES_MESSAGE` is appended to the truncation note.

**PDF readability limits.** `TOO_MANY_COLUMNS_THRESHOLD = 12` (`pdf-layout.ts:77`); at or above that column count, `tooManyColumnsWarning(count)` fires regardless of whether anything actually overflowed. Independently, the real overflow warning (`overflowWarning`, `pdf-layout.ts:295-303`) names the specific columns that landed below their registry minimum and, only when a trial allocation proves it would actually help, recommends landscape orientation or Legal paper.

**CSV image URLs are signed and expire.** 30-day TTL (`SIGNED_URL_TTL_SEC`), cached for 25 days (`SIGNED_URL_CACHE_SEC`) so the same storage path resolves to the same signed URL for image-optimizer cache hits (`item-images.ts:31-32`). A CSV mailed to a supplier or archived for reference stops resolving its Image URL column after roughly a month. This is an open owner decision (see below).

**Serverless duration.** `maxDuration = 60` on the main export route, `maxDuration = 30` on the preview route, both shared against `ROW_CAP = 10,000` and the unchanged 40-exports/hour rate limit. The rate-limit budget is shared across CSV/XLSX/PDF and both the unified and legacy routes; an image-heavy PDF now costs materially more compute than a bare CSV against the identical per-user hourly allowance.

**Unsupported image types — the WebP split, in full.** The brief predicted a possible fix: "route the PDF image path through `fetchExportImageBytes` and pass a base64 data URI, exactly as the Excel path already does." The manual walk found this framing is only half right. The Excel path *already* calls `fetchExportImageBytes` and *still* does not embed WebP, because a second, independent gate — `readImageDimensions`'s PNG/JPEG-only signature sniff (`inventory-export-xlsx.ts:58-95`) — silently treats an unrecognized signature as "skip," and `ALLOWED_CONTENT_TYPES` (`export-images.ts:48-59`) never even attempts to fetch a `image/webp` response in the first place. So byte-fetching alone is **necessary but not sufficient**: the PDF path would need the same byte-fetch-and-embed treatment the Excel path has, but neither path solves the underlying problem, which is that the fetched bytes are the wrong format to begin with. Two real fix options, neither implemented:
  - **Option 1 — prefer the master image when the stored thumb is WebP.** Item masters are frequently uploaded in a format `exceljs`/`react-pdf` can already decode (commonly JPEG); routing the export pipeline to check the master's content-type before falling back to the WebP thumb would recover coverage for those items, but not universally — an org whose masters are also WebP gains nothing.
  - **Option 2 — request an explicit Supabase Storage transform to JPEG/PNG for the bounded export batch.** `primaryImagesForPdfRendering` already accepts a `transform: {width, height, resize}` for its master fallback path; extending that transform to also re-encode format (not just resize) is the general fix and would apply uniformly regardless of the stored master's format.
  Neither is built in this program. Every export still succeeds today — the image is simply absent, with a real placeholder and no broken file — which is the documented, not silently degraded, outcome section 31 requires.

**The legacy `GET /api/inventory/export.csv` route still emits the old fixed 25-column shape forever.** Confirmed byte-identical to `main` by `git diff --stat` (empty) for the route file itself; only a new pinning test file was added under that path. Retiring it or keeping it as a stable machine contract is an open owner decision.

**Database-backed shared export presets — the design, and why it was deferred.** Two shapes are viable: (a) a new `export_presets` table (`organization_id`, `user_id`, `name`, `field_keys` as a text array or jsonb, `options` jsonb, `is_shared boolean`, mirroring `saved_views`' unique-per-`(user, org, scope, name)` constraint and RLS shape), or (b) widen `saved_views.scope`'s CHECK past `('inventory', 'books')` and extend `SavedViewState`'s whitelist sanitizer to carry fields/order/format options. Both need a migration; the brief explicitly permits code-plus-`localStorage` in exactly this situation ("persist now ONLY if existing user-preference infra supports it cleanly, else dialog/browser storage + document the future DB option"), and the audit confirmed the existing infra does not cleanly support the new payload shape (`saved-views.ts` full read; `0035_saved_views.sql:14`'s CHECK constraint verified directly).

**Mobile has no export surface at all.** `grep -rn "downloadInventoryExport|inventory/export" apps/mobile` returns nothing — there is no inventory export screen, button, or API call anywhere in the mobile app, so nothing shipped there and the standing "web features default to mobile too" rule has no existing surface to extend.

**Findings from the manual Demo-org walk not anticipated by the brief:**
- **Long-SKU overlap (cosmetic, Items PDF).** An unbroken SKU or barcode longer than its fitted column (observed on synthetic 15-16 character test SKUs) overflows visually into the next column with no clipping — `@react-pdf/renderer` does not clip overflow, and identifier columns are `wrap: false` by design (Brief section 11's "never truncate ISBN," extended to SKU/barcode via the registry's `identifier` flag). Data is intact in the underlying value; only the render collides. Two candidate fixes are on record: allow hyphen-point wrapping for `sku`/`barcode` specifically while keeping ISBN rigid, or derive each org's SKU column `minWidth` from its actual longest SKU rather than a fixed guess.
- **Preview error-vs-loading gap.** `fetchExportPreview`'s failure path sets `preview` to `null` (`export-builder-dialog.tsx:191-195`), and `ExportBuilderPreview` renders "Loading a sample of this export…" for any `null` preview regardless of cause (`export-builder-preview.tsx:51-52`). A genuinely failed preview request (network error, an expired session, a 429) is therefore visually indistinguishable from "still loading," forever. The fix is a props contract change — an explicit error slot on `ExportBuilderPreviewProps` — that Task 14 did not anticipate when the props contract was frozen and Task 17 explicitly left open rather than force through unreviewed; it is a real, if low-severity, bug and a natural next task.
- **Filename preset-name precedence.** `buildExportFilename` (`filename.ts:36-52`) checks `presetName` before scope: an untouched default preset (e.g. "Books inventory") names the file by preset — `books-inventory-2026-08-03.xlsx` — even when the scope is "selected." Only a customized (Custom-preset) selection falls through to the scope-derived name, e.g. `books-selected-2-items-2026-08-03.xlsx`. This is the tested, designed behavior (Task 12), noted here only because a `-selected` marker in the filename might be more intuitive when a user has hand-picked a subset under a named preset.

**Ledgered minors awaiting the final review, none blocking, pulled from `progress.md`'s carry-forward entries:**
- Task 13 minors 4-8: the preview route's body schema is not `.strict()` while the export schema is, so preview silently accepts fields the export route would 400 on; the preview rate-limiter's 429 branch is untested (`checkRateLimit` throws under the test harness and fails open there); the resolver's 403 mapping is untested (one mutation survived); a stale `route.test.ts` comment claims `inventory-pdf-columns.ts` was deleted (it was kept, correctly, as the field registry's inherited tuning source); `countRowsWithImages` takes up to 10,000 ids unchunked and its `catch` returns `0`, silently zeroing the readiness panel on any transient error rather than surfacing one.
- The reorder-announcement live region in the field picker is gated only by `!busy` and is never explicitly cleared, so a failed or cancelled export can leave a stale "X moved to…" announcement primed to re-fire; Task 17 closed the specific failed-export re-mount path with a `fieldsResetKey` remount, but the underlying no-clear behavior remains.
- `stageLabel`'s double-space collapse (`.replace('  ', ' ')`) is untested for a `null` `rowCount`; the code handles it correctly by construction, but no test pins it.
- The catalog card min-height test hand-rolls its own DOM traversal instead of reusing the shared `walk()` helper already present in `inventory-export-pdf.test.tsx` — cosmetic duplication, not a coverage gap.
- No collision-avoidance exists between two preset names that sanitize to the same filename segment (e.g. two differently-punctuated names both reducing to `books`) — observational, unexercised in practice.
- `buildExportPdfRows`'s `_layout` parameter remains intentional, documented scaffolding for a future per-column wrap decision — confirmed here, per Task 9's forward note, to still be an active interface contract rather than dead weight.
- The empty-state (`total === 0`) UX path has no dedicated end-to-end test; every layer independently degrades to "No items matched this export," so the risk is judged low.
- **Four new lint warnings, all in `export-builder-dialog.tsx`, from the deliberate serialization pattern.** `pnpm --filter @stockpilot/web lint` moved from 30 to 34 warnings (0 errors throughout). All four are new and all four land in this program's own file: `181:5` `react-hooks/set-state-in-effect` (`setPresets(presetsFor(itemTypeKind))` called directly inside the preview effect), plus three `react-hooks/exhaustive-deps` findings on that same effect's dependency array (~line 200) — one missing-deps (`filters`, `selectedIds` not listed) and two complex-expression-in-dependency-array flags on the `JSON.stringify(filters)` / `JSON.stringify(selectedIds)` entries used to key the effect off value rather than identity. The abort/debounce behavior this effect implements is test-pinned, so the cleanup is deliberately deferred rather than refactored here; carried forward as a named fast-follow.

---

### Owner-decision items left open

1. **Financial fields (Global Constraint 5, the program's central open decision).** `unit_cost`, `retail_price`, and the derived `inventory_value` are gated only by `items:export` — status quo, identical to what those users already see on the item detail page. The registry's `permission?: Permission` slot (`field-registry.ts:106-119`) is evaluated end-to-end by `resolveExportFields` but populated on no field in production; adding a real cost-visibility permission is a one-line registry edit once one exists, but inventing that permission is a product-wide decision (a new `PERMISSIONS` entry, `ROLE_PERMISSIONS` grants, a pgTAP assertion-count bump) outside this program's scope.
2. **Should personal presets become shared and durable?** Today they are per-browser `localStorage`. The DB-backed design is sketched in section I; building it is a natural, independently-schedulable next phase and needs its own migration.
3. **CSV image URL lifetime.** Signed, 30-day TTL, 25-day cache. A CSV archived or mailed outside StockPilot goes stale after about a month. Options: a stable authorized URL, documenting the expiry to users explicitly, or dropping the Image URL column from CSV entirely — the owner's call.
4. **WebP embedding in Excel and PDF.** Build one of the two options in section I, or accept the gap as a documented, permanent limitation.
5. **Retire or keep `GET /api/inventory/export.csv`?** It will otherwise emit the fixed 25-column shape forever, unrelated to whatever the builder evolves into.
6. **Row cap and rate limit are format-blind.** 10,000 rows and 40 exports/hour are unchanged and shared across CSV/XLSX/PDF; an image-heavy PDF now costs meaningfully more against that budget than a bare CSV. If warehouse staff hit the limit in practice, splitting the budget per format is the fix.

---

## J. Validation commands and their real results

Full verbatim transcripts are in `docs/superpowers/reports/2026-08-03-export-builder-verification.md`. The headline results, real numbers, from that log's Phase B-E section (branch `feat/export-builder`, HEAD `7e63157e`, run 2026-08-03):

| Gate | Result |
|---|---|
| `pnpm --filter @stockpilot/web test 2>&1 \| tail -40` | **PASS** — 428 test files / 4,811 tests, 0 failures. |
| `pnpm typecheck 2>&1 \| tail -20` | **PASS** — 0 errors across all 3 packages (core, web, mobile). |
| `pnpm lint 2>&1 \| tail -30` | **PASS** — 0 errors, 34 pre-existing warnings, all in files this program never touched. |
| `pnpm --filter @stockpilot/web build 2>&1 \| tail -30` | **PASS** — compiled successfully, full route table emitted, no bundler-only failure. |

| Invariant grep | Expected | Actual | Verdict |
|---|---|---|---|
| `grep -rn "primaryMasterUrlsForItems" apps/web/src/lib apps/web/src/app/api/inventory` | no output | 1 hit — a doc-comment in `export-images.ts:18` warning future editors never to use it | **PASS** (documented anomaly, not code) |
| `grep -rn "downloadInventoryExport" apps/web/src` | 2 hits | 12 hits: 1 definition, 1 production call site (`export-builder-dialog.tsx`), 9 test hits | **PASS** |
| `grep -rn "PDF_COLUMNS" apps/web/src` | no output | Confined to `apps/web/src/lib/pdf/` and comment-only cross-references in `field-registry.ts` and its test; zero hits in `app/api` | **PASS**, per the Task 13 adjudication on record |
| `grep -rc "Generic" apps/web/src/lib/charter-display.ts` | >= 1 | 3 | **PASS** |
| `ls supabase/migrations \| tail -3` / `git diff main..HEAD --stat -- supabase/migrations` | unchanged since `main` | empty diff | **PASS** — no-migration guarantee holds |

**Manual Demo-org walk** (Demo Co, `71b27a4a-7948-4638-bc3f-535974713bd2`, `demo@stockpilotusa.com`, real Chromium browser, artifacts generated through the builder and inspected page-by-page/loaded back through ExcelJS/read raw): every Books PDF checklist line passed (headers separated, ISBN present and readable, medium/large row-height geometry correct, headers repeat, "Page 1 of 4" through "Page 4 of 4," org branding present, 53 items paginated across 4 pages with no broken partial rows) **except covers, which did not render — the anticipated WebP split** (section H/I above). Books Excel matched (ISBN text-formatted, header frozen, autofilter present, Summary sheet correct) except embedded pictures, same split. Books CSV, the book catalog layout, and the Items page (defaults, bulk-selected export, filtered/all scopes) all passed with no findings beyond the long-SKU overlap and the filename-precedence note recorded in section I.

---

## Discrepancies found while verifying citations for this report

- The plan's file-structure table lists `apps/web/src/lib/pdf/report-table-fit.test.ts` as Task 1's regression test; the actual permanent net that runs every live report config through the real allocator is `report-headers-fit.test.ts` (a distinct, later file from the Task 1 fix-wave) plus `export-pdf-headers-fit.test.ts` (Task 2's rider) and `registry-preset-fit.test.ts` (Task 4's rider) — three permanent nets exist where the original plan sketched one; all three were confirmed present and passing in the verification log's invariant grep for `PDF_COLUMNS`.
- `apps/web/src/lib/pdf/report-configs.ts` and the `apps/web/src/app/api/reports/[slug]/pdf/route.tsx` diff are not named anywhere in the plan's file-structure table — they are a Task 1 fix-wave addition (extracting the 7 live report sections' column definitions out of the route so the derived `minWidth` floors have one home) that the progress ledger documents but the original plan did not anticipate. Both are real, both are in the shipped diff, and both are now cited directly in sections A and B above rather than left implicit.
- The audit's B4 line citations for `ItemImagesService` (`primaryImagesForPdfRendering` at 422-499, `primaryMasterUrlsForItems` at 513) were re-verified directly against the current file and hold exactly — no drift.
- No other line-number or file-path claim carried forward from the audit or the progress ledger was found to have drifted; every citation in this report was confirmed against the file it names before being written down.
