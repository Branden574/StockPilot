# Partial Order Fulfillment / Backorder — Design

**Status:** Approved (owner locked 4 decisions 2026-07-09)
**Goal:** When an order requests more units than are available (wants 100, only 50 on hand), let the warehouse ship the 50 it has and keep the *same* order open in a "Backordered — awaiting stock" state that owes the remaining 50, instead of cancelling or silently dropping the shortfall.

---

## 1. Owner decisions (binding)

1. **Model: one order, stays open.** The 50 ship now; the order moves to a new non-terminal `backordered` state and is fulfilled to completion across multiple batches on the *same* order. NOT a child/linked backorder order; NOT a close-and-forget short-ship.
2. **Two entry points:** the shortfall can be caught **at picking** (picker finds only 50) *and* **at approval** (a manager knowingly approves an order that's short).
3. **Close-out escape hatch:** a `backordered` order has three exits — **resume** (fulfill the rest), **close as delivered-partial** (end it keeping the record that 50 went out), or **cancel** (void it).
4. **Notify the requester:** in-app + the existing Resend email when an order is partially fulfilled, and again when the backordered remainder ships. The order also always displays its fulfilled/owed progress.

---

## 2. Current state (as-built, for grounding)

- **Order entity** is `order_requests` (+ `order_request_lines`). "Orders" in the UI are `order_requests`.
- **Status union (13), linear**, in `packages/core/src/order-state-machine.ts:11-24`:
  `pending_confirmation → pending_approval → approved → pick_slip_generated → picking_in_progress → picking_complete → packing_slip_generated → staged_for_pickup | staged_for_delivery → in_transit → completed` (+ `denied`, `cancelled`). `completed` is the single terminal success status (label "Delivered").
- The state machine is mirrored in **three places that must stay in lockstep**: the TS union + `ALLOWED_TRANSITIONS` (`order-state-machine.ts:33-47`), a Postgres check constraint + trigger `_validate_order_request_status_transition` (authoritative in `supabase/migrations/0120_drop_signature_requested_dead_state.sql:94-109`), and the presentation keys `ORDER_STATUS_META` (`packages/core/src/customization/order-status.ts:29-43,111-125`).
- **Line columns** (`order_request_lines`): `quantity_requested` (0044:83-92), `quantity_fulfilled` (cumulative shipped, default 0), `quantity_picked` / `picked_at` / `picked_by` (0109:50-56). No new columns are strictly required.
- **Partial line picking already works.** `partial_pick_line` (current in `0238`) accepts `0 ≤ p_qty ≤ quantity_requested`; under-pick is allowed, only over-pick rejected.
- **Single stock-hardening point:** `complete_picking` (current in `0238:80-172`) decrements `quantity_on_hand` via `adjust_stock(item, -picked, 'transfer', …)`, **sets** `quantity_fulfilled = picked`, releases reservations, → `picking_complete`. Today the shortfall (`requested − picked`) is discarded: the excess reservation is released and nothing records it.
- **Approval hard-blocks short orders:** `approve_order_request` (0111:64-71) raises `insufficient_stock` when `requested > on_hand − active_reservations`, and creates reservations for the full requested qty.
- **`completed` is reached only via `confirm_order_signature`** (`0120:292-303`), a service-role RPC on the public signature page; it flips `staged_for_pickup`/`in_transit` → `completed` and sets `completed_at`.
- **Cancel restores hardened stock:** `cancel_order_request` (`0137:41-122`) restocks lines with `quantity_fulfilled > 0` via `adjust_stock(+qty, 'return', …)`.
- **UI:** web order detail `apps/web/src/app/(dashboard)/dashboard/orders/[id]/page.tsx` (status badge, lines table shows Requested/Fulfilled/On-hand), `ManagerActionsPanel`, digital-pick workspace `…/[id]/pick/page.tsx` + `components/orders/digital-pick.tsx`; mobile `apps/mobile/app/order/[id].tsx` + `apps/mobile/src/components/digital-pick.tsx`. Transition API `apps/web/src/app/api/v1/orders/[id]/transition/route.ts` → `OrderRequestsService`.

There is **no** existing backorder concept for orders (the only `back_order` hit is `shipment_lines.qty_back_ordered`, an unrelated audit-only cross-warehouse field).

---

## 3. Architecture — a `backordered` rest state + fulfillment loop

Add **one** non-terminal status, `backordered`. The order flows the normal pipeline for each batch; at hand-over it forks on **owed = Σ(quantity_requested − quantity_fulfilled)**:

```
approved → pick slip → picking → picking_complete → packing → staged → (delivery) → hand-over
                                                                                       │
                                                    owed > 0 ─► BACKORDERED ◄──────────┘   owed = 0 ─► completed
                                                                  │  │  │
                                        Resume (restocked) ───────┘  │  └──── Cancel (void)
                                                                     │
                                                Close as delivered-partial ─► completed
```

**State-machine edits (all three mirrors, in one migration + the TS + presentation):**
- `ALLOWED_TRANSITIONS`: `staged_for_pickup` → add `backordered`; `in_transit` → add `backordered`; new `backordered` → `pick_slip_generated`, `completed`, `cancelled`.
- New `OrderAction`s: `approve_partial`, `resume_fulfillment`, `close_partial`. `availableOrderActions('backordered')` = `resume_fulfillment` (when fulfillable stock exists), `close_partial`, `cancel`, plus view actions.
- `ORDER_STATUS_META['backordered']`: label **"Backordered"**, amber; add to the status-keys array. Display context elsewhere as "Partially fulfilled · 50/100".
- DB: new migration mirrors the `0120` check constraint + trigger with `backordered` added and the new edges.

**Owed / fulfilled accounting (the one behavioral change to `complete_picking`):**
- `quantity_fulfilled` **accumulates**: `quantity_fulfilled = coalesce(quantity_fulfilled,0) + this_batch` (was: overwrite).
- After a batch completes, `quantity_picked` resets to NULL so the next cycle starts clean.
- Stock still hardens only here, by `quantity_picked` — a shortfall never touches stock it doesn't have.

**The fork lives in the completion path (`confirm_order_signature` + its handler):** after the signature that would complete the order, compute owed; if `owed > 0` set `backordered` (and fire the requester notification), else `completed`. Both `staged_for_pickup` and `in_transit` hand-overs go through this RPC, so one fork covers pickup and delivery.

---

## 4. Entry points

**A. Complete-short at picking (the miscount).** The order was approved normally (reserved full qty). The picker keys in 50 of 100 and completes. `complete_picking` hardens 50, accumulates `quantity_fulfilled += 50`, releases the batch's reservations. The batch flows pack → stage → hand-over; at hand-over `owed = 50 > 0` → `backordered`. The digital-pick UI (web + mobile) shows a confirm: *"This ships 50 and backorders 50 — continue?"* before completing short.

**B. Approve-partial at approval (knowingly short).** When `requested > available`, the manager gets an **"Approve partial"** action next to the normal (still-strict) "Approve". `approve_partial` reserves `min(available, requested)` per line, moves the order to `approved`, and lets it flow — pre-destined to backorder the unreservable remainder. Implemented as a new action/service method + a permissive variant of `approve_order_request` (keep the strict path intact for normal approve).

---

## 5. Exits from `backordered`

- **Resume fulfillment** → `pick_slip_generated`. Regenerate a pick slip for the still-owed lines, reset their `quantity_picked` to NULL, and reserve newly-available stock up to owed. Then the normal pick→pack→hand-over cycle runs again; on the final hand-over with `owed = 0` → `completed`. If a resume batch is *also* short (owed 50, restock only 30), it ships 30 and returns to `backordered` — the loop repeats naturally. Resume is available only when there is fulfillable stock for at least one owed line.
- **Close as delivered-partial** → `completed`. No stock change; keeps the record "50 of 100 delivered". Frees any reservation on the un-shipped remainder.
- **Cancel** → `cancelled`. Voids the order. **Does NOT restock the already-delivered `quantity_fulfilled`** (those goods physically left the building), unlike a mid-pipeline cancel; it only releases reservations on the un-shipped remainder. This diverges from `cancel_order_request`'s restock behavior *for the backordered state only* — implement a backorder-aware cancel branch.

---

## 6. Notifications

Use the existing `notifyUser` (in-app + push) + Resend email infra. Fire to the order's **requester**:
- On transition into `backordered`: "Order #N: 50 of 100 fulfilled, 50 backordered."
- On the final completion of a previously-backordered order: "Your backordered items on Order #N have shipped."
Best-effort (a failed notification must never fail the fulfillment transition), mirroring existing notification call-sites.

---

## 7. UI (web + mobile parity)

- **Order detail (web + mobile):** `Backordered` badge; per-line **Requested / Fulfilled / Owed**; an order-level "50 of 100 fulfilled" progress line. Manager panel gains **Resume fulfillment** and **Close as delivered-partial** (gated + status-aware) alongside cancel.
- **Digital pick (web + mobile):** already supports partial entry; add the "ships X, backorders Y" confirm on short completion.
- **Approval UI (web + mobile):** show **"Approve partial (50 now, 50 backorder)"** when stock < requested.
- All actions flow through the existing transition API (`/api/v1/orders/[id]/transition`) with the new actions, so mobile reaches them via the same route (Bearer). Add `revalidateInventoryList` for the stock-touching transitions.

---

## 8. Out of scope (YAGNI)

- Child/linked backorder orders (owner chose one order).
- Per-batch shipment sub-records — reuse the order pipeline; no new shipment entity.
- SLA / priority / allocation rules when stock is constrained.
- Auto-resume when stock arrives (resume is a manual action; auto-suggest can come later).
- Backorder at the packing/staging level — the fork is at hand-over only.

---

## 9. Global constraints

- **Web + mobile parity** — every surface ships to both (picking is mobile-first).
- **TDD**; **pgTAP for every migration** (RPC changes: complete_picking accumulation, the backordered fork, resume, close-partial, backorder-aware cancel, approve_partial); adversarial review each phase; **live demo-org verification** (StockPilot Demo Co) with the owner's real scenario (order 100, stock 50, ship 50, resume, complete).
- **State-machine drift:** any status/edge change edits all three mirrors together (TS union + `ALLOWED_TRANSITIONS`, DB constraint + trigger, `ORDER_STATUS_META`) — see the header comment in `order-state-machine.ts:1-7`.
- **Migrations** applied to prod by the implementer via `supabase db push --linked`.
- **No Claude/Anthropic co-author trailer** on commits.

---

## 10. Phasing (all ships; sequenced by visible value)

- **Phase 1 — the visible core:** `backordered` status (all three mirrors) + `complete_picking` accumulation + the hand-over fork + `resume_fulfillment` + `close_partial` + order-detail fulfilled/owed UI (web + mobile) + the short-completion confirm. Delivers the owner's stated scenario end-to-end.
- **Phase 2 — approve-partial:** the knowingly-short approval entry point (web + mobile).
- **Phase 3 — notifications:** requester in-app + email on partial and on backorder-shipped.

Each phase is independently testable and demo-verifiable.
