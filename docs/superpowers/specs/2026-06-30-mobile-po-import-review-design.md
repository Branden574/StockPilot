# Mobile PO-Import Review & Approve — Design Spec

**Date:** 2026-06-30
**Status:** Approved direction (owner chose "write the plan, build later"); scope = **Lean MVP** (Phase 1) with a documented Phase 2.

## Problem
On mobile you can **scan** a PO (photo/library → `/api/po-imports/scan` → extracts vendor/lines/totals into `po_imports` + `po_import_lines`), but the screen punts you to the **web** to review and approve ("Review and approve on the web"). The mobile import-history screen (`app/(drawer)/po-imports.tsx`) lists imports but tapping one routes to `/scan-po`, not a detail/review. So the **review → edit → approve (which creates the PO)** step is **web-only**. (Receiving goods is NOT a gap — mobile already posts multi-line receipts via the `post_receipt_v2` RPC in `app/po/[id].tsx`.)

This violates the standing rule [[feedback_web_features_default_to_mobile]] (web features should ship on mobile too).

## Goal
Let a user **open a scanned import on mobile, review the extracted lines, pick vendor + warehouse, and approve → create the PO** — covering the common case, with a clean "finish on web" escape for the complex cases (new-item creation, advanced charter/bill-to).

## Scope

### Phase 1 (this plan) — Lean MVP
- Mobile **review screen** showing: extracted vendor (editable picker), warehouse picker, line list (description, qty, uom, vendor item #, the auto-matched item if any, per-line **skip**), totals, extraction-confidence hints.
- **Approve** → calls the existing `PoImportsService.approve` via a new Bearer endpoint → creates the PO → navigate to the mobile PO detail (`/po/[id]`).
- **Cancel** an import.
- **"Finish on web" escape:** if any line is unmatched AND would require creating a NEW item (i.e. can't be auto-matched or skipped), show a button deep-linking to the existing web review (`{APP_URL}/dashboard/purchase-orders/imports/{id}`). Mobile does NOT build the create-new-items flow in Phase 1.
- Fix `app/(drawer)/po-imports.tsx` to route a tapped import to the new review screen (not `/scan-po`).

### Phase 2 (deferred, documented only)
- Full per-line item search/mapping on mobile (mirror the web `ItemCombobox`).
- "Create these as new items" flow on mobile (`createItemsFromPoLinesAction` → a new `/api/v1/po-imports/[id]/create-items` endpoint).
- Advanced fields: item-ownership charter, bill-to charter (see [[project_charter_bill_to_vs_item_ownership]]), expected-delivery, destination location.

## Architecture

### Reuse (no new business logic)
The service logic already exists and is tested — the new endpoints are **thin Bearer wrappers**:
- `PoImportsService.list()` → `apps/web/src/server/services/po-imports.ts:83`
- `PoImportsService.get(id)` → `:99` returns `{ header, lines }`
- `PoImportsService.approve(input: ApprovePoImportInput)` → `:538` returns `{ poId }`
- `PoImportsService.cancel(id)` → `:751`
- Validation schema: `approvePoImportSchema` → `packages/core/src/schemas/po-imports.ts:86` (`{ poImportId, warehouseId, vendorId, locationId?, charterId?, expectedAt?, lineOverrides: [{ lineId, itemId?, lineType?, skip? }] }`).

### New API endpoints (Bearer `/api/v1`, mirror `apps/web/src/app/api/v1/po/[id]/receive-line/route.ts`)
| Endpoint | Method | Body / Query | → Service | Returns |
|---|---|---|---|---|
| `/api/v1/po-imports` | GET | `?status=&limit=&offset=` | `list()` | `{ data, limit, offset }` |
| `/api/v1/po-imports/[id]` | GET | — | `get(id)` | `{ header, lines }` |
| `/api/v1/po-imports/[id]/approve` | POST | `approvePoImportSchema` (minus `poImportId`, taken from the path) | `approve()` | `{ poId }` |
| `/api/v1/po-imports/[id]/cancel` | POST | — | `cancel(id)` | `{ ok: true }` |

Each: `withApiContext(req)` → 401 on null; wrap in try/catch mapping `ServiceError → serviceErrorStatus`; `reportError` on the unknown-500 branch (tag `po-imports.<route>`); `runtime='nodejs'`, `dynamic='force-dynamic'`.

### Authorization (RESOLVED — gate lives in the service)
`PoImportsService` enforces authorization **internally**, so the Bearer endpoints inherit it just by constructing the service with the authed ctx (no separate gate needed, and none can be accidentally weaker than web):
- `list()` (`po-imports.ts:83-84`): `assertModuleEnabled(ctx,'po_imports')`.
- `get(id)` (`:99-100`): `assertModuleEnabled(ctx,'po_imports')` (+ org-scoped reads).
- `approve(input)` (`:538-540`): `assertModuleEnabled(ctx,'po_imports')` + `assertPermission(ctx,'purchase_orders:manage')`. Also: throws `conflict` unless the import status is `parsed` or `needs_review` (`:543-548`).
- `cancel(id)` (`:751`): gates the same way (verify it asserts `purchase_orders:manage` during build; if not, that's a pre-existing gap to fix, not introduced here).
Because `ctx.supabase` is user-authenticated, RLS also applies (defense-in-depth). The endpoints still each call `withApiContext(req)` → 401 on null (authentication) before touching the service.

### Mobile screens
- **New:** `apps/mobile/app/po-imports/[id].tsx` — the review screen (consumes `GET /api/v1/po-imports/[id]`; vendor/warehouse pickers reuse the patterns in `AddItemCard`/`scan-po`; per-line list with skip; Approve → `POST .../approve`; Cancel; "Finish on web" when new-item creation is required).
- **Modify:** `apps/mobile/app/(drawer)/po-imports.tsx` — tap a card → `router.push('/po-imports/'+id)` instead of `/scan-po`; consider switching the list to `GET /api/v1/po-imports` for parity (optional — direct Supabase read is RLS-safe today).
- **Register** the new route in `apps/mobile/app/_layout.tsx` (the app lists screens explicitly).

## Error handling
- 401 → return to sign-in/connect state (mobile already handles `err.status`).
- Approve validation failures (unmapped non-skippable lines) → block + show "Finish on web."
- Network/timeout → inline retry (mirror `scan-po`).

## Testing
- **Endpoints:** vitest, mock `withApiContext` + `PoImportsService` (mirror `me-routes.test.ts` / `receive-line` tests): 401 unauth; get returns header+lines; approve passes the path id + body through to `approve()` and returns `{poId}`; approve maps `ServiceError`→status; cancel calls `cancel()`. Authorization test: a user without the PO-approve permission is rejected (once the gate is confirmed).
- **Mobile:** typecheck; a unit test for the approve-payload builder (line→`lineOverrides` mapping) if extracted to a pure function.

## Out of scope / non-goals
- New-item creation on mobile (Phase 2; "finish on web" covers it).
- Changing the web flow or the extraction/`scan` endpoint.
- Changing receiving (already works on mobile).
