# Item Cost History Report — Design

- **Date:** 2026-06-21
- **Status:** Approved (owner said "go" on the proposal)
- **Surface:** Web dashboard, Reports section (desktop-admin surface, like the other reports). No mobile.

## Summary

Formalize the existing per-item cost-over-time capability into a first-class **report** in the Reports section: pick an item (+ optional date range) → see the cost-over-time **chart** + a **table** of every cost observation (date, supplier, source, unit cost) + last-paid/average stats → **export to CSV / PDF / Excel**. Investor/procurement-facing.

It **reuses the existing engine** `ReportsService.itemCostHistory()` (which already derives cost history from `purchase_order_items.unit_cost` [timestamped by PO order date] + `receipt_lines.unit_cost` [timestamped by receipt date], supplier-attributed). No new data model.

## Goals
- A "Item cost history" entry in the Reports list → its own page.
- Item picker (no item selected → picker; item selected via `?itemId=` → report).
- Optional **date-range** filter (since/until).
- Cost-over-time **chart** (reuse `CostTrendIsland`) + a **table** of all points + last-paid/average/count stats.
- **Export: CSV, PDF, Excel**, scoped to the selected item + range.

## Non-goals
- No new metrics beyond unit cost (quantity/value-over-time are a future, separate report — the engine is cost-specific). YAGNI.
- No mobile (web report surface).
- No new DB tables, migrations, permissions, or module gating.

## Design / components

**Reuse as-is:** `ReportsService.itemCostHistory()` (reports.ts:852), `CostTrendIsland` (charts/cost-trend-island.tsx), `ItemCombobox` (inventory/item-combobox.tsx), `PdfDownloadDropdown` (reports/pdf-download-dropdown.tsx). Return shape: `ItemCostHistory { itemId, series: SupplierCostSeries[], lastUnitCost, avgUnitCost, pointCount }` (reports.ts:171-180); `CostHistoryPoint { date, unitCost, source: 'purchase_order'|'receipt' }`.

**1. Service — add an OPTIONAL date range (backward-compatible).**
- `apps/web/src/server/services/reports.ts`: extend `itemCostHistory(itemId: string, opts?: { since?: string; until?: string })`. When `since`/`until` are provided, filter the PO query on `ordered_at` and the receipt query on `received_at` (gte/lte). **Default (no opts) = current behavior unchanged** — so the existing item-detail cost-trend chart caller (`itemCostHistory(itemId)`) is untouched. Add a unit test for the date-range filtering.

**2. Reports list entry.**
- `apps/web/src/app/(dashboard)/dashboard/reports/page.tsx`: add `{ slug: 'item-cost-history', name: 'Item cost history', desc: 'Unit cost over time by supplier — from PO + receipt history', icon: <a lucide icon e.g. TrendingUp> }` to the `REPORTS` array. No module gating.

**3. Report page (follow the lot-trace pattern).**
- Create `apps/web/src/app/(dashboard)/dashboard/reports/item-cost-history/page.tsx` (server component). `searchParams: { itemId?, since?, until? }`.
  - No `itemId` → render an item-picker client component (fetch org items `{id, sku, name}` server-side, pass to it).
  - `itemId` present → `ReportsService.forCurrentUser().itemCostHistory(itemId, { since, until })`, then render: title (item name/sku), the date-range inputs, summary stats (last paid / average / # observations), `<CostTrendIsland series={data.series} />`, a table (Supplier · Date · Source [PO/Receipt] · Unit cost), and the export buttons (CSV / PDF via PdfDownloadDropdown / Excel), each carrying `?itemId=…&since=…&until=…`.
- Create `apps/web/src/components/reports/item-cost-history-search.tsx` — the item picker using `ItemCombobox`; on select, `router.push('/dashboard/reports/item-cost-history?itemId=' + id)`.

**4. Exports.**
- **CSV:** `apps/web/src/app/api/reports/[slug]/csv/route.ts` — add an `item-cost-history` case: read `itemId` (400 if missing) + optional `since`/`until`, call the service, flatten series → rows (Supplier, Date, Source, Unit cost), `toCsv` + `csvResponse`. Keep the existing `reports:export` permission + `exportRateLimited` gating.
- **PDF:** `apps/web/src/app/api/reports/[slug]/pdf/route.tsx` — add the matching case building `ReportSection` columns (Supplier, Date, Unit cost [right], Source) + title/subtitle + footer note (latest/average), via the shared `ReportTablePdf`. Keep audit logging.
- **Excel:** add `.xlsx` export reusing the existing `exceljs` helper pattern (`apps/web/src/lib/inventory-export-xlsx.ts`). Cleanest path: a dedicated `apps/web/src/app/api/reports/item-cost-history/xlsx/route.ts` (or extend a `[slug]/xlsx` route implementing this slug) — same auth/permission/rate-limit gating as the CSV route, same columns. **If wiring Excel into the reports framework proves invasive, ship CSV+PDF and flag Excel as a fast-follow — do not block the report on it.**

## Money/data correctness
- Read-only report; no mutations. Org-scoped via `ctx.organizationId` (RLS) on every query, including the server-side item fetch for the picker and the PDF title.
- The service method already paginates PO/receipt reads (10k cap) — keep that; if date-range narrows it, fine.

## Testing
- `reports.ts` test: `itemCostHistory(itemId, { since, until })` filters points to the window; no-opts call returns all (unchanged).
- Export: a focused test that the CSV/PDF/xlsx item-cost-history branch returns rows for a seeded item (or at least 400 on missing itemId).
- `pnpm typecheck`, `pnpm lint`, full `pnpm test`, `pnpm build` green before commit.

## Rollout
No migration. Additive report — invisible until a user opens it. Reuses existing data (POs + receipts), so it shows real history immediately for any item that's been ordered/received.
