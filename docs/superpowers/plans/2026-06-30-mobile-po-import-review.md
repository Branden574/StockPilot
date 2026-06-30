# Mobile PO-Import Review & Approve — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a mobile user open a scanned PO import, review the extracted lines, pick vendor + warehouse, and approve → create the PO (Lean MVP), with a "finish on web" escape for new-item creation.

**Architecture:** Thin Bearer `/api/v1/po-imports*` route handlers wrapping the existing, already-gated `PoImportsService` (no new business logic) + one new mobile review screen. Spec: `docs/superpowers/specs/2026-06-30-mobile-po-import-review-design.md`.

**Tech Stack:** Next.js 16 route handlers + vitest (web); Expo/expo-router + React Native (mobile); the mobile `api()` Bearer client.

## Global Constraints

- The endpoints are **thin wrappers**: construct `new PoImportsService(ctx)` and call its methods — do NOT re-implement logic. The service already enforces `assertModuleEnabled(ctx,'po_imports')` + (for approve/cancel) `assertPermission(ctx,'purchase_orders:manage')`, so the endpoints inherit authorization.
- Every route: `const ctx = await withApiContext(req); if (!ctx) return NextResponse.json({error:'unauthenticated'},{status:401});` then `try { … } catch (e) { if (e instanceof ServiceError) return NextResponse.json({error:e.code,message:e.message},{status:serviceErrorStatus(e.code)}); void reportError(e instanceof Error ? e : new Error(String(e)), {tag:'po-imports.<route>'}); return NextResponse.json({error:'internal_error',message:'Unexpected error'},{status:500}); }`. Set `export const runtime='nodejs'; export const dynamic='force-dynamic';`. Mirror `apps/web/src/app/api/v1/po/[id]/receive-line/route.ts`.
- Tests mock `withApiContext` + `PoImportsService` (mirror `apps/web/src/app/api/v1/zendesk/me/me-routes.test.ts`). NO real network/Supabase.
- Mobile `api()` calls use the FULL path (e.g. `api('/api/v1/po-imports/'+id)`), matching the existing `api('/api/v1/...')` convention.
- Approve only succeeds when the import status is `parsed` or `needs_review` (the service throws `conflict` otherwise) — the mobile screen must handle that.
- Phase 1 does NOT build mobile new-item creation; when a line needs a brand-new item, the screen shows "Finish on web".

---

### Task 1: List + Detail endpoints

**Files:**

- Create: `apps/web/src/app/api/v1/po-imports/route.ts` (GET list)
- Create: `apps/web/src/app/api/v1/po-imports/[id]/route.ts` (GET detail)
- Test: `apps/web/src/app/api/v1/po-imports/po-imports-routes.test.ts`

**Interfaces:**

- Consumes: `withApiContext(req): Promise<ServiceContext|null>` (`@/lib/auth/api-context`); `PoImportsService` (`@/server/services/po-imports`) — `list(): Promise<PoImportRow[]>`, `get(id): Promise<{header, lines}>`; `ServiceError` + `serviceErrorStatus` (`@/server/services/context`); `reportError` (`@/lib/error-reporter`).
- Produces: `GET /api/v1/po-imports` → `{ data: PoImportRow[] }`; `GET /api/v1/po-imports/{id}` → `{ header, lines }`.

- [ ] **Step 1: Failing test** — in `po-imports-routes.test.ts`, mock `withApiContext` + `PoImportsService` (constructor returns `{ list, get }` mocks). Cases: list 401 when ctx null; list returns `{data}` from `list()`; detail 401 when null; detail returns `{header,lines}` from `get(id)`; detail maps a `ServiceError('not_found')` → 404 via `serviceErrorStatus`.
- [ ] **Step 2: Run → FAIL** — `cd apps/web && pnpm vitest run src/app/api/v1/po-imports/po-imports-routes.test.ts`.
- [ ] **Step 3: Implement** both GET handlers per the Global Constraints (list → `new PoImportsService(ctx).list()`; detail reads `id` from the awaited params — `{ params }: { params: Promise<{ id: string }> }` per Next 16 — then `…get(id)`).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(po-imports): mobile list + detail API`.

---

### Task 2: Approve + Cancel endpoints

**Files:**

- Create: `apps/web/src/app/api/v1/po-imports/[id]/approve/route.ts` (POST)
- Create: `apps/web/src/app/api/v1/po-imports/[id]/cancel/route.ts` (POST)
- Test: add cases to `po-imports-routes.test.ts`

**Interfaces:**

- Consumes: `PoImportsService.approve(input): Promise<{poId}>`, `cancel(id): Promise<void>`; `approvePoImportSchema` (`@stockpilot/core` / `packages/core/src/schemas/po-imports.ts:86`) = `{ poImportId, warehouseId, vendorId, locationId?, charterId?, expectedAt?, lineOverrides: [{lineId, itemId?, lineType?, skip?}] }`.
- Produces: `POST .../{id}/approve` → `{ poId }`; `POST .../{id}/cancel` → `{ ok: true }`.

- [ ] **Step 1: Failing test** — approve: 401 when null; parses body with `approvePoImportSchema` using `poImportId` from the PATH (`{ ...body, poImportId: id }`) → calls `approve()` → returns `{poId}`; a `ZodError`/invalid body → 400; a `ServiceError('conflict')` (wrong status) → 409. cancel: 401 when null; calls `cancel(id)` → `{ok:true}`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** approve: read awaited `id`, `const body = await req.json()`, `const parsed = approvePoImportSchema.parse({ ...body, poImportId: id })` (wrap parse so a ZodError → 400 `{error:'validation_error'}`), `const { poId } = await new PoImportsService(ctx).approve(parsed)`, return `{poId}`. cancel: `await new PoImportsService(ctx).cancel(id); return { ok: true }`.
- [ ] **Step 4: Run → PASS** (whole `po-imports-routes.test.ts` green).
- [ ] **Step 5: Commit** — `feat(po-imports): mobile approve + cancel API`.

---

### Task 3: Mobile review screen + history routing

**Files:**

- Create: `apps/mobile/app/po-imports/[id].tsx` (the review screen)
- Modify: `apps/mobile/app/(drawer)/po-imports.tsx` (tap a card → push `/po-imports/{id}` instead of `/scan-po`)
- Modify: `apps/mobile/app/_layout.tsx` (register `<Stack.Screen name="po-imports/[id]" options={{ presentation: 'card' }} />`)

**Interfaces:**

- Consumes: `api<T>(path)` (`@/lib/api`); the endpoints from Tasks 1–2. Reuse the warehouse/vendor picker pattern from `apps/mobile/src/components/AddItemCard.tsx` (warehouse chips) + a vendor picker (fetch via existing vendors API or Supabase, mirror how `scan-po` / other screens load vendors).

**Screen behavior (Lean MVP):**

1. On mount: `api('/api/v1/po-imports/'+id)` → `{ header, lines }`. Show a loading state; 401 → return to sign-in.
2. Header: file name + status pill; **vendor** picker (default `header.vendor_id`); **warehouse** picker (required).
3. Lines list: each line shows `description`, `qty_ordered_original`, `uom_original`, `vendor_item_number`, and its `match_status` / `item_id` (the auto-matched item name if matched). A per-line **Skip** toggle. Read-only otherwise in Phase 1 (no item search).
4. **"Finish on web" escape:** if any non-skipped line has `match_status` indicating it needs a NEW item (e.g. unmatched and not mappable on mobile), show a banner + button: `Linking.openURL(API_BASE + '/dashboard/purchase-orders/imports/' + id)` and do NOT enable Approve. (Determine the exact `match_status` values from `get()`'s line shape during build.)
5. **Approve** (enabled when vendor + warehouse set AND no line needs a new item): build the payload —
   `{ warehouseId, vendorId, lineOverrides: lines.map(l => ({ lineId: l.id, itemId: l.item_id ?? undefined, skip: skipState[l.id] === true })) }` — `POST /api/v1/po-imports/{id}/approve`. On `{poId}` → `router.replace('/po/'+poId)`. On 409/`conflict` → toast "Already approved or not ready." Extract the payload-builder into a pure function for a unit test.
6. **Cancel:** `POST /api/v1/po-imports/{id}/cancel` → back to history.
7. Use the app's existing UI components (Card/Button/Pill/Body/Field) + theme; RN-only.

- [ ] **Step 1:** Write a unit test for the approve-payload builder (`buildApprovePayload(lines, skipState, vendorId, warehouseId)` → expected `lineOverrides`); run → FAIL.
- [ ] **Step 2:** Implement the builder + screen; wire the history-screen tap + register the route.
- [ ] **Step 3:** `cd apps/mobile && pnpm exec tsc --noEmit` (clean) + run the builder test (PASS).
- [ ] **Step 4: Commit** — `feat(po-imports): mobile review + approve screen`.

---

## Out of scope (Phase 2 — separate plan)

Per-line item **search/mapping** on mobile; **create-new-items** flow (+ a `POST /api/v1/po-imports/[id]/create-items` endpoint wrapping `createItemsFromPoLinesAction`); charter / bill-to / expected-date / destination-location fields. Until then, "Finish on web" covers those imports.

## Self-review notes

- Spec coverage: list/detail/approve/cancel endpoints (Tasks 1–2) + review screen (Task 3) = the full Lean MVP. ✓
- Type consistency: `approvePoImportSchema` fields match `PoImportsService.approve`'s `ApprovePoImportInput`; `poImportId` is injected from the path, not the body. ✓
- Auth: inherited from the service (no endpoint-level gate needed); each route still does `withApiContext` 401. ✓
- Verify during build: the exact `po_import_lines` shape returned by `get()` (field names for `match_status` / `item_id` / `description` / `qty_ordered_original`) and `cancel()`'s permission assert.
