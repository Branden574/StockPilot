# Picking Assignment / Claim / Lock — Design Spec

**Date:** 2026-07-08
**Goal:** Prevent two warehouse users from picking the same order at once. An order in the picking phase can be **claimed** by a staff picker or **assigned** by an admin; once claimed it is **locked** to that picker; the next workflow steps stay locked until picking completes. Enforced on the **backend** (race-safe), reflected **live** on web + mobile, with a **push notification** to the assigned picker and **activity-log** entries.

## Owner decisions (locked 2026-07-08)
1. **"Admin" = Manager or above** (owner/admin/manager). Staff = claim + pick own only. Viewer = read-only.
2. **Must Claim before picking.** The order is read-only for a non-admin until they claim it (or an admin assigns them). An admin may pick directly (override).
3. **A picker may release their own claim** (back to Unassigned). Non-admins can never touch someone else's; admins can release/reassign anyone's.

## Existing foundation (reuse — do NOT rebuild)
- `order_requests.assigned_picker_id` (uuid FK user_profiles, INDEXED, mig 0109), `picking_completed_at/by`, `pick_slip_generated_at` already exist.
- `packages/core/src/order-state-machine.ts` → `availableOrderActions({status, viewerRole, viewerUserId, assignedPickerId, …})` is the SHARED (web+mobile) single source of truth for order actions. Already has a `reassign_picker` action + takes `assignedPickerId`. Roles: `MANAGER_OR_ABOVE = [owner, admin, manager]`.
- Pick RPCs `partial_pick_line` / `complete_picking` (mig 0121, warehouse-scoped as of 0236) already stamp `assigned_picker_id = coalesce(assigned_picker_id, auth.uid())` on first pick.
- `notifyUser({userId, title, body, link})` (server/services/push.ts) → push + in-app bell; existing `OrderRequestsService.notifyAssignment()` pattern (used for delivery assignment) to mirror.
- `broadcastToChannel()` (lib/realtime/broadcast.ts) → live push (same as permission changes).
- `audit()` (server/services/audit.ts) + `activity_logs` → history entries.
- Status flow already gates later steps: can't `generate_packing_slips` until `picking_complete`.

## Data model (migration)
Additive columns on `order_requests`:
- `picking_claimed_at timestamptz` — when the current assignment was made.
- `picking_claimed_by uuid references user_profiles(id) on delete set null` — WHO performed the claim/assign (self for a claim, the admin for an assign).

`assigned_picker_id` stays the single "who is picking" field. **`picking_status` is DERIVED** (not stored, to avoid drift): `unassigned` (picking phase, `assigned_picker_id` null) · `assigned` (picker set, no picks yet) · `in_progress` (picker set + ≥1 line picked) · `completed` (`picking_complete`). Exposed by the service + state machine.

## Backend (race-safe RPCs, SECURITY DEFINER)
All warehouse-scoped via `user_can_access_inventory(auth.uid(), warehouse_id, null, 'write')` (as 0236).
- **`claim_picking(p_order_id)`** — atomic: `UPDATE … SET assigned_picker_id = auth.uid(), picking_claimed_at = now(), picking_claimed_by = auth.uid() WHERE id = p_order_id AND assigned_picker_id IS NULL AND status IN ('pick_slip_generated','picking_in_progress')`. If 0 rows (already claimed / wrong status) → raise `already_claimed` with the current picker's id in DETAIL. **The WHERE `assigned_picker_id IS NULL` is the race guard — two simultaneous claims: the DB serializes the row update, first wins, second updates 0 rows → already_claimed.** Requires warehouse write.
- **`assign_picking(p_order_id, p_user_id)`** — MANAGER+ only. Sets `assigned_picker_id = p_user_id`, `picking_claimed_at = now()`, `picking_claimed_by = auth.uid()`. Serves assign AND reassign (overwrites any current picker). `p_user_id` must be an accepted member of the org with warehouse write access.
- **`release_picking(p_order_id)`** — caller is the assigned picker (self-release) OR manager+. Clears `assigned_picker_id`/`picking_claimed_at`/`picking_claimed_by` to null. Already-picked quantities are PRESERVED (work stays; a new claimant continues) — status unchanged.
- **MODIFY `partial_pick_line` + `complete_picking`** — add the picker-LOCK after the warehouse check: if the caller is NOT manager+ AND (`assigned_picker_id IS NULL` OR `assigned_picker_id <> auth.uid()`) → raise `not_assigned_picker` (42501). Managers bypass (override). The existing `coalesce(assigned_picker_id, auth.uid())` still auto-stamps a manager who picks an unclaimed order.

Service wrappers in `OrderRequestsService`: `claimPicking`, `assignPicking(userId)`, `releasePicking` — each `assertModuleEnabled('orders')` + map the RPC errors to ServiceError (`conflict` for already_claimed, `forbidden` for not_assigned_picker / manager-only). REST: extend the `/api/v1/orders/[id]/transition` dispatcher (or dedicated routes) so mobile can call them.

## State machine (packages/core — drives BOTH platforms)
New actions: `claim_picking`, `release_picking` (keep `reassign_picker` for admin assign/reassign). At `pick_slip_generated` / `picking_in_progress`:
- **Manager+**: `open_digital_pick`, `print_pick_slip`, `mark_picking_complete`, `reassign_picker`, `cancel`; `release_picking` when a picker is set.
- **Staff, unassigned** (`assignedPickerId == null`): `claim_picking`, `print_pick_slip`. **No** `open_digital_pick` / `mark_picking_complete` (claim first).
- **Staff, assigned to me** (`assignedPickerId == viewerUserId`): `open_digital_pick`, `print_pick_slip`, `mark_picking_complete`, `release_picking`.
- **Staff, assigned to someone else**: `print_pick_slip` only (view "Being picked by X"); no claim, no pick.

## Notifications, realtime, activity
- On claim/assign/reassign: `notifyUser({userId: newPicker, title, body, link: /orders/<id>})` (push + bell), gated by the user's push pref (mirror `notifyAssignment`). Self-claim: no self-push (or a light confirmation toast only).
- On any claim/assign/reassign/release/complete: `broadcastToChannel('orders:<org>', 'order_changed', {orderId})` → web + mobile order list/detail subscribe and refetch. (Also revalidate the web order paths.)
- `audit()` entries: `order.picking_claimed`, `order.picker_assigned` (from→to), `order.picking_released`, plus existing `order.picking_complete` — surfaced on the order-detail history.

## UI (web + mobile, both from the state machine)
Picker chip near status: **"Unassigned"** or **"Being picked by [Name]"** (+ claimed-at). Buttons per the state-machine actions: **Claim Picking / Assign Picker (dropdown) / Reassign / Release / Complete Picking**. Web: `ManagerActionsPanel` + orders list card + `digital-pick.tsx` (block picking UI unless I'm the assigned picker or admin). Mobile: `app/order/[id].tsx` MANAGER ACTIONS + the `DigitalPick` component (only render the pick section when I'm the assigned picker or admin; otherwise show the "being picked by X" chip + Claim button).

## Acceptance criteria (from owner)
Maps 1:1 to the owner's 16-point list: claim/assign on entering picking; lock to one picker; others can't claim/complete; UI shows the picker; admin assign/reassign/remove/self-assign; non-admin can't reassign/override; next steps locked until complete; only assigned picker or admin completes; race → first backend write wins, second gets "already claimed by X"; persists across refresh; shows on list + detail; activity log entries; **push to the assigned picker**.

## Phasing (SDD)
1. **Backend core**: migration (columns + 3 new RPCs + lock in the 2 pick RPCs) + pgTAP (race, lock, self-release, manager override) + `OrderRequestsService` wrappers + REST + service tests.
2. **State machine + shared types**: new actions + derived picking_status + unit tests (all role×assignment combos).
3. **Web UI**: picker chip + claim/assign/reassign/release buttons + digital-pick gating + orders-list chip.
4. **Mobile UI**: same via the DigitalPick component + order screen + orders list.
5. **Notify + realtime + activity**: notifyUser push, broadcast subscribe/refetch on both platforms, audit entries.

## Constraints
- Backend is the final authority (frontend only shows/hides). Race-safe via the `WHERE assigned_picker_id IS NULL` guard.
- Must not break: pickup/delivery/internal/external-link/admin-created/warehouse-created orders. All go through the same status flow + state machine.
- Web + mobile parity (shared state machine). TDD; pgTAP for the migration; adversarial review per phase (fulfillment = crucial surface). No Claude co-author trailer.
