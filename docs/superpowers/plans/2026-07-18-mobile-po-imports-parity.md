# Mobile PO-imports parity (scan entry + review/approve with full fields)

> Execute via parallel worktree agents (Unit A web API, Unit B mobile UI) + opus whole-branch review. Base: main @ ab4436b9.

**Owner report (2026-07-18, screenshot of mobile "PO List" tab):** no way to import/scan POs from the PO List section like on web, and no way to "enter all the info like you would on the web — the charter stuff and all that."

**Verified ground truth:**
- Mobile HAS `/scan-po` (camera/photos/PDF → POST `/api/po-imports/scan`, Bearer via withApiContext, AI parse) — reachable only from the Receive tab; PO List screen (`apps/mobile/src/screens/po-imports.tsx`) is a read-only list whose card tap incorrectly routes to `/scan-po` (no detail screen exists).
- Mobile LACKS: entry point on PO List; an import DETAIL/review screen; approve/cancel/re-parse; per-line matching; charter/warehouse/location/vendor entry. NO `/api/v1/po-imports/*` Bearer endpoints exist.
- Web approve contract (`approvePoImportAction` → `PoImportsService.approve`): `{ poImportId, warehouseId, vendorId, locationId (REQUIRED — receives-against location), charterId?, expectedAt?, lineOverrides?: [{lineId, itemId?, lineType?, skip?}] }` → `{ poId }`. Supporting web actions: `parsePoImportAction`, `cancelPoImportAction`, `findDuplicatesForPoLinesAction`, `createItemsFromPoLinesAction` (`{poImportId, lineIds, vendorId, warehouseId...}` with per-line decisions create/use_existing/skip).

## Global constraints
- Reads on mobile via Supabase under RLS (existing convention); WRITES via Bearer `/api/v1` (withApiContext + rate limit + permission gate) — mirror `/api/po-imports/scan` and `items/[id]/transfer` patterns. NO migration.
- Permission: mirror whatever the web imports surface gates (`purchase_orders:manage` via service/assertPermission — verify in PoImportsService and mirror EXACTLY; UI affordances gated with the same `can()` the app uses elsewhere).
- Charter semantics: charterId on approve = the PO's BILL-TO charter (purchase_orders.charter_id), NOT item ownership (decided at receive) — mirror the web service exactly, invent nothing.
- Location picker: SITES-ONLY per app convention (lib/locations groups / LocationsService {sitesOnly} equivalent on mobile — reuse the existing mobile picker used by transfer/put-away if suitable).
- NO Claude/Anthropic co-author trailer. OTA after merge (`pnpm release:ota`).

## PINNED API CONTRACT (Unit B builds against this exactly)
1. `POST /api/v1/po-imports/[id]/approve` — body `{ warehouseId, vendorId, locationId, charterId?, expectedAt?, lineOverrides? }` (same zod as web) → `{ ok: true, poId }`. Errors: 401/403/404/400 (+422 service validation pass-through), 429 rate-limited (60/min per user).
2. `POST /api/v1/po-imports/[id]/cancel` → `{ ok: true }`.
3. `POST /api/v1/po-imports/[id]/parse` → `{ ok: true }` (re-run parse; same states web allows).
4. `POST /api/v1/po-imports/[id]/line-matches` — body `{ lineIds?: string[] }` → `{ ok, matches: [...] }` wrapping `findDuplicatesForPoLines` result verbatim.
5. `POST /api/v1/po-imports/[id]/create-items` — body mirrors `createItemsFromPoLinesAction` input minus poImportId (taken from path) → `{ ok, created: [...] }` verbatim result.
All: withApiContext → 401; same permission assert as web service; org-scoped via ctx; each route reuses the SERVICE (PoImportsService), never re-implements logic.

## Unit A (web): the 5 Bearer routes + tests
Route tests mirror `items/[id]/restore/route.test.ts` style: 401 unauth; 403 wrong-perm; 404 foreign-org id (RLS/org scope); happy path calls service with right args; body validation 400; rate limit wired. Typecheck+lint+tests green.

## Unit B (mobile): screens + wiring
1. **PO List screen** (`src/screens/po-imports.tsx`): header gains a Scan/Import button (routes `/scan-po`) gated by the same permission; empty-state copy updated (scan reachable HERE now, not only Receive); card tap → NEW detail route `/po-import/[id]` (fixes the bounce-to-scanner).
2. **NEW detail screen** `app/po-import/[id].tsx`: reads po_imports + po_import_lines via Supabase (RLS); shows status/vendor/ETA/totals + parsed lines (desc, qty, unit cost, vendor item #, matched item or UNMATCHED, line type); pull-to-refresh; actions by status: parse-retry (failed/uploaded), cancel (non-terminal), APPROVE (parsed/needs_review).
3. **Approve flow** (sheet or section, match app's modal conventions): warehouse picker (existing hook), supplier/vendor picker (Supabase list), location picker (sites-only, required), charter picker (optional — bill-to), expectedAt date, THEN per-line handling: unmatched lines get suggestions via line-matches endpoint → per-line decision use-existing (pick suggestion) / create (batched via create-items) / skip; matched lines pass through; finally POST approve with lineOverrides. Success → toast + route to created PO (`/po/[poId]`) + list refresh.
4. Reuse existing UI primitives (Card/Pill/Body/Mono, AdjustModal-style sheets, existing pickers). Inline errors; no crashes on weird parse payloads (defensive rendering).
5. Tests: pure helpers (status→actions map, lineOverrides builder from decisions) unit-tested; screen-level where feasible per app convention.

## After both land
Integrate branches → full gate (core/web/mobile typecheck + touched tests) → opus whole-branch review (focus: permission parity, org-scope on all 5 routes, service reuse not reimplementation, charter semantics, approve-flow correctness incl. lineOverrides building, no eager perf regressions) → fix loop → merge → push (deploy) → `pnpm release:ota` → sim boot-check + owner confirm.
