# Reopen Picking (manager override) — Design

**Status:** approved (design), pending spec review
**Date:** 2026-07-23
**Author:** Branden Vincent-Walker

## Goal

Let a **manager** send an order that has finished picking — but has **not yet been signed for / handed over** — back into picking, so a miscount can be corrected. The action is **reason-required** and **audited**. It is the pre-signature counterpart to the existing `backordered → pick_slip_generated` reopen (`resume_fulfillment`).

## Why "without a signature"

The signature is captured only at hand-over, in the staging phase, downstream of picking. It is *not* what blocks reopening — the order lifecycle is simply **forward-only** and no backward edge into picking exists before backorder. "Reopen picking without a signature" therefore means: **reopen an order that is still in-house (unsigned)**, and **hard-refuse once it has been signed** (keyed on `signed_at`, never `signature_data_url` — physical signatures leave the data-url NULL).

## Current flow (verified against the live DB, not just migrations)

Order statuses are forward-only through 14 states. The picking phase is `pick_slip_generated → picking_in_progress → picking_complete`, then `packing_slip_generated`, then staging, then signature.

- **Picking closes** at `complete_picking(p_order_id)` (SECURITY DEFINER RPC; live body verified). Per line it **draws stock down** via `adjust_stock(item_id, -quantity_picked, 'transfer', null, 'Order pick (order_request …)', null)`, sets `quantity_picked = v_batch`, then **releases the order's reservations** (`stock_reservations.released_at = now()`), and flips `status='picking_complete'` + `picking_completed_at/by`. It does **not** touch `quantity_fulfilled`.
  - Service wrapper: `OrderRequestsService.completePicking` — `apps/web/src/server/services/order-requests.ts:2088`.
- **Packing:** `generatePackingSlips` (`order-requests.ts:2507`) flips `picking_complete → packing_slip_generated`, stamps `packing_slip_generated_at/by`, and mints a 256-bit `signature_token` (+ `signature_token_expires_at`). It **refuses regeneration once `signed_at IS NOT NULL`** (`:2539`).
- **Signature (hand-over):** `confirm_order_signature` (digital) / `confirm_physical_signature` (paper) — `supabase/migrations/0248_physical_signature.sql`. Guard `status IN ('staged_for_pickup','in_transit') AND signed_at IS NULL`; then `quantity_fulfilled += quantity_picked`, `quantity_picked = NULL`, stamp `signed_at`/`signature_*`, fork `status` to `completed` (owed==0) or `backordered`. **No stock movement here** — the stock was already drawn at `complete_picking`.
- **Existing backward edge:** `resume_fulfillment` (`supabase/migrations/0245_backorder_resume_close_partial.sql`, service `order-requests.ts:2163`) reopens `backordered → pick_slip_generated`, re-reserving only the **owed** remainder. It does **not** un-draw stock, because at `backordered` the goods already shipped. Our case is the opposite: pre-signature, nothing shipped, so the draw must be reversed.
- **State machine (shared web+mobile):** `packages/core/src/order-state-machine.ts` — `ALLOWED_TRANSITIONS.picking_complete = ['packing_slip_generated','cancelled']` (:45), `packing_slip_generated → ['staged_for_pickup','staged_for_delivery','cancelled']` (:46). `completed` is terminal (:57). `derivePickingStatus` (:322-349) treats `picking_complete`+ as "picking done", so the picking UI zone disappears at completion on both surfaces.
- **DB transition guard:** trigger `_validate_order_request_status_transition` (`supabase/migrations/0243_order_backordered_status.sql:53-70`) independently rejects any edge the TS table doesn't allow. **Both layers must be edited together** or the DB rejects what TS accepts (header warning at `order-state-machine.ts:1-7`).

## Behavior specification

### Scope (decided)
- **Reopenable from:** `picking_complete` **and** `packing_slip_generated`.
- **Always refused when** `signed_at IS NOT NULL` (defense-in-depth; not reachable at these two statuses today, but the guard is explicit and keyed on `signed_at`).
- **Out of scope (separate later feature):** reopening from `completed`/signed — that punches through two terminal-state guards and must reverse completion side-effects (return-token mint, `order.completed` event, completion email, `completed_at`/`delivered_at` triggers). Not built now.

### What reopen does (decided: keep the picked counts, resume mid-pick)
Target status: **`picking_in_progress`**. The reopen RPC, in one transaction, must return the order to the exact state it was in *just before* `complete_picking` ran:

1. **Reverse the pick draw.** For each line with `quantity_picked > 0`: `adjust_stock(item_id, +quantity_picked, 'transfer', null, 'Reopen picking (order_request …)', null)`. This re-increments on-hand and writes a visible, auditable movement — the inverse of the "Order pick" movement.
2. **Restore reservations.** Re-activate the reservations `complete_picking` released for this order: `UPDATE stock_reservations SET released_at = NULL WHERE order_request_id = p_id AND released_at IS NOT NULL`. (At these statuses the only released reservations are the ones `complete_picking` released, so this is the exact inverse. The pgTAP round-trip test is the guardrail.)
3. **Preserve** `quantity_picked` (the manager sees what was picked and edits only the miscounted line) and `assigned_picker_id`. `quantity_fulfilled` is untouched (still 0 pre-signature).
4. **Reset lifecycle fields:** `status='picking_in_progress'`, `picking_completed_at=NULL`, `picking_completed_by=NULL`.
5. **If reopening from `packing_slip_generated`, void the packing slip:** clear `signature_token`, `signature_token_expires_at`, `packing_slip_generated_at`, `packing_slip_generated_by`. (Manager regenerates the packing slip after re-completing.) Signature fields (`signed_at`, `signature_*`, `completed_*`) are already NULL at these statuses; leave them.

### Guards (in the RPC, defense-in-depth with the service)
- `FOR UPDATE` row lock on the order.
- `has_org_role(organization_id, 'manager')` → `forbidden` (42501).
- `status IN ('picking_complete','packing_slip_generated')` → `invalid_status_transition` (P0001, detail = current status).
- `signed_at IS NOT NULL` → `already_signed` (P0001).
- `trim(p_reason) = ''` or NULL → `reopen_reason_required` (P0001).

## Architecture (each layer mirrors an established precedent)

| Layer | File (anchor) | Change |
|---|---|---|
| Shared state machine | `packages/core/src/order-state-machine.ts` (:45, :46, action union ~:151/166, `availableOrderActions` :274/:278) | Add edges `picking_complete → picking_in_progress` and `packing_slip_generated → picking_in_progress`; add `reopen_picking` to the `OrderAction` union; surface it for `isManagerOrAbove` in those two states' cases. Drives both surfaces. |
| DB migration — trigger | new migration re-defining `_validate_order_request_status_transition` (current at `0243:53-70`) | Permit the two new backward edges. Ships in the **same migration** as the RPC. |
| DB migration — RPC | new migration, `reopen_picking(p_id uuid, p_reason text)` | SECURITY DEFINER, modeled on `resume_fulfillment` (0245) + `release_cycle_count` (0282). Implements the guards + the 5 reopen steps above. `pgTAP` for every guard and the stock round-trip. |
| Service | `apps/web/src/server/services/order-requests.ts` (new `reopenPicking(id, reason)`, mirroring `resumeFulfillment` :2163 + cycle-count `release()` `cycle-counts.ts:311`) | `assertModuleEnabled('orders')`, `assertPermission(ctx,'orders:approve')` (also enforces org MFA/AAL2 — `context.ts:166`), non-blank reason, `requireWarehouseAccess(id,'write')`, `rpc('reopen_picking')`, error-code map, then `audit({ event:'order.picking_reopened', entityType:'order_request', entityId:id, reason })`. |
| Audit | `apps/web/src/server/services/audit.ts` (`AuditEvent` union, order.* block ~:124-141, beside `order.fulfillment_resumed` :138) | Add `order.picking_reopened`. Surfaces in `/dashboard/audit` via `AuditLogService.list`; `reason` flows through `metadata.reason`. |
| Action | `apps/web/src/server/actions/order-requests.ts` (new `reopenPickingAction`, mirroring `resumeFulfillmentAction` :500) | Zod schema with `reason`; `revalidatePath('/dashboard/orders')` + `/dashboard/orders/${id}` + `revalidateOrdersCatalog()`. |
| Web UI | `apps/web/src/components/orders/manager-actions-panel.tsx` (:782-787 terminal message; deny-reason modal pattern :227-268) | "Reopen picking" button in the `picking_complete` and `packing_slip_generated` branches, with an in-component reason modal (iOS-webview-safe — copy the deny-reason flow, not a native `prompt`). |
| Bearer route | `apps/web/src/app/api/v1/orders/[id]/transition` | Handle `{ action:'reopen_picking', reason }` so mobile uses the existing single transition endpoint. |
| Mobile | `apps/mobile/src/lib/orders-api.ts` (`OrderAction` union :20-45; `transitionOrder` :48) + `apps/mobile/app/order/[id].tsx` (actionBtn in `picking_complete` branch :1354-1358; `hasPipelineActions` :768-778 already fires) | Add `{ action:'reopen_picking', reason }` variant; "Reopen picking" actionBtn + reason modal in both branches. Refresh `STATUS_META` pills in `orders.tsx:36-44` if needed. No new endpoint/gate. |

## Error handling (RPC raise → user-facing message)
- `already_signed` → "This order has been signed for and can't be reopened."
- `reopen_reason_required` → "Enter a reason for reopening picking."
- `invalid_status_transition` → "This order isn't at a stage that can be reopened."
- `forbidden` / not-manager → 403 "Only a manager can reopen picking."

## Testing
- **pgTAP (the correctness core):** each guard (manager-gate, status-guard, `already_signed`, `reopen_reason_required`); field-clearing (status, timestamps, packing-slip/token fields when from `packing_slip_generated`); `quantity_picked`/`assigned_picker_id` preserved. **Round-trip stock test:** create order → pick N → `complete_picking` (assert on-hand −N, reservation released) → `reopen_picking` (assert on-hand back to original, reservation active, status `picking_in_progress`, `quantity_picked` intact) → edit a line → `complete_picking` again (assert on-hand −corrected, **no double-decrement**). This is the single riskiest invariant.
- **Service unit tests:** reason-required, permission assertion, error-code mapping, audit emitted.
- **Web:** component test for the reason modal + action wiring (mirror the deny-reason test if one exists).
- **Mobile:** iOS simulator hand-test (idb) of the reopen actionBtn + reason modal, DB-verified, in Demo Co — same rigor as the rack write-off.
- **Live Demo Co (org 71b27a4a-7948-4638-bc3f-535974713bd2):** web + mobile walk-through of reopen from `picking_complete` and from `packing_slip_generated`; verify the audit-log row and the stock movements.

## Risks / must-verify during implementation
1. **Reservation restoration semantics** — un-releasing (`released_at = NULL`) assumes the only released reservations at these statuses are the ones `complete_picking` released. Verify against the reservation lifecycle; the round-trip pgTAP is the guardrail. If the assumption is unsafe, fall back to re-creating reservations like `resume_fulfillment` does.
2. **`adjust_stock` reversal signature** — confirm the exact `adjust_stock` argument order/types against the live function before writing the `+quantity_picked` reversal (it must mirror `complete_picking`'s call exactly, opposite sign).
3. **Both transition layers in one change-set** — the TS `ALLOWED_TRANSITIONS` edit and the DB trigger edit must ship together, or one rejects the other.
4. **`derivePickingStatus`** — confirm that landing on `picking_in_progress` correctly re-shows the picking UI zone on web and mobile (it should, by :322-349).

## Global constraints
- Migrations applied to prod via `supabase db push --linked` **before** deploying web that reads the new behavior; pgTAP required.
- Web + mobile parity ships together (state machine is shared).
- `signed_at` is the only correct "is signed" predicate (never `signature_data_url`).
- No emojis in any copy/commit/PR; no Claude co-author trailer.
- Live Demo Co verification, web + mobile, before calling it done.

## Out of scope
- Reopening from `completed`/signed (a separate, riskier feature).
- Full re-pick reset to `pick_slip_generated` (the rejected alternative; `resume_fulfillment` already covers reset semantics for backorders).
