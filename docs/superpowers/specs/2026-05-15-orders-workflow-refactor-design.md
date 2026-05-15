# Orders Workflow Refactor — Design

**Status:** Approved (sections 1–4 confirmed in chat 2026-05-15)
**Author:** branden + Claude
**Tracking:** Six-phase rollout, one DB migration per phase, manual confirmation required between phases.

## Goal

Replace the parallel `order_requests` / `shipments` system with a single unified **Orders** workflow that supports both pickup and delivery fulfillment for any item type (books or general inventory).

The eight legal user-facing states for a new order are:

```
pending_confirmation → pending_approval → approved
   → pick_slip_generated → picking_in_progress → picking_complete
   → packing_slip_generated → (staged_for_pickup | staged_for_delivery)
   → in_transit (delivery only) → signature_requested → completed
```

Plus the two terminal off-ramps `denied` and `cancelled`.

`shipments` is retired for new work. Existing shipment rows stay readable forever; the inventory-decrement RPC moves onto the order workflow.

## Out of scope

- Multi-warehouse split per order (existing single-warehouse model preserved)
- Driver-side native mobile app (web routes serve)
- "View on map" for in-transit orders (placeholder)
- Admin re-open of a completed order beyond `cancelled` (no full undo)
- Final drop of the `shipments` table — deferred 30 days after phase 6 ships, separate cleanup migration

## Locked decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | **Fold stock-decrement into orders; deprecate shipments** | Cleaner end state; `post_shipment_shipped` logic ports into the new `complete_picking` RPC |
| 2 | **Stock decrements at `picking_complete`** | Matches physical reality (items off shelf); reservations still happen at `approved` |
| 3 | **Auto-assign approver as picker, manager+ can reassign** | Handles "approver not on shift" case |
| 4 | **Public requesters always emailed; internal respects `notification_preferences`** | Granular team control, full external transparency |
| 5 | **Extend `order_requests` table — no rename** | Renaming a live multi-thousand-row table is high-risk; semantic name stays |
| 6 | **Keep snake_case statuses in DB; map to user-facing labels in UI** | Convention consistency |

## 1. Data model

### 1.1 New columns on `order_requests`

```sql
fulfillment_type                text check in ('pickup','delivery') default 'delivery'
delivery_address                jsonb     -- {line1, line2, city, region, postal, instructions}
pickup_location_notes           text
requester_phone                 text

assigned_picker_id              uuid -> user_profiles
pick_slip_generated_at          timestamptz
pick_slip_generated_by          uuid -> user_profiles
picking_completed_at            timestamptz
picking_completed_by            uuid -> user_profiles

packing_slip_generated_at       timestamptz
packing_slip_generated_by       uuid -> user_profiles

staged_at                       timestamptz
staged_by                       uuid -> user_profiles

assigned_delivery_user_id       uuid -> user_profiles
assigned_delivery_by            uuid -> user_profiles
assigned_delivery_at            timestamptz

in_transit_at                   timestamptz
in_transit_by                   uuid -> user_profiles

signature_token                 text unique
signature_token_expires_at      timestamptz
signed_by_name                  text
signed_by_email                 citext
signature_data_url              text     -- inlined PNG
signed_at                       timestamptz

completed_at                    timestamptz
completed_by                    uuid -> user_profiles    -- NULL for public signature
```

### 1.2 New columns on `order_request_lines`

```sql
quantity_picked      numeric(14,4)
picked_at            timestamptz
picked_by            uuid -> user_profiles
quantity_packed      numeric(14,4)
packed_at            timestamptz
packed_by            uuid -> user_profiles
```

### 1.3 Status enum (extended)

Existing values kept (`pending_confirmation`, `pending_approval`, `approved`, `denied`, `cancelled`).

New values added: `pick_slip_generated`, `picking_in_progress`, `picking_complete`, `packing_slip_generated`, `staged_for_pickup`, `staged_for_delivery`, `in_transit`, `signature_requested`, `completed`.

**One-time data rewrite (in migration 0109):**
- `packaging → packing_slip_generated`
- `ready_for_delivery → staged_for_delivery`
- `delivered → completed`

### 1.4 Centralized state machine

`packages/core/src/order-state-machine.ts` exports `ALLOWED_TRANSITIONS` and an `assertTransition(from, to, ctx)` helper that also enforces:

- Pickup orders cannot transition to `staged_for_delivery`
- Delivery orders cannot transition to `staged_for_pickup`
- `in_transit` requires `assigned_delivery_user_id IS NOT NULL`
- Terminal states (`denied`, `cancelled`, `completed`) have no outgoing transitions

The Postgres trigger `_validate_order_request_status_transition` (migration 0076 + 0108) gets rewritten to mirror this exactly in migration 0109.

### 1.5 Inventory decrement port

New SECURITY DEFINER function `complete_picking(p_order_id uuid, p_lines jsonb)`:

1. `FOR UPDATE` lock the order row
2. Assert status is `pick_slip_generated` or `picking_in_progress`
3. For each line in `p_lines`: write `quantity_picked`, `picked_at`, `picked_by`
4. Release `stock_reservations` for the order
5. Call `adjust_stock` per line with negative `quantity_change` and `movement_type='order_pick'`
6. Flip status to `picking_complete`
7. Whole sequence in one transaction; any failure rolls back

`post_shipment_shipped` stays callable for historical shipments but no longer invoked by the new flow.

## 2. Workflow surfaces

### 2.1 Public order form `/r/<token>`

Extends the existing form. New fields:
- Fulfillment type: required radio (Pickup | Delivery)
- Phone: optional text
- If Delivery: structured address block (line 1, line 2, city, region, postal, instructions)
- If Pickup: free-text pickup notes

Existing double opt-in (migration 0108) preserved: row lands as `pending_confirmation`; confirm-click email → `pending_approval`.

### 2.2 Internal order creation `/dashboard/orders/new`

Same field set as public form, plus:
- Manager+ can mark "created on behalf of" — captures requester name/email/phone, leaves `requester_user_id` NULL (treated as public for email purposes)
- Self-create stays available (`requester_user_id = self`)

The `source` column already distinguishes internal vs `public_link`.

### 2.3 Pick slip — PDF + digital pick page

**Trigger:** `generatePickSlipAction` — asserts status is `approved`, writes `pick_slip_generated_at` / `_by`, flips status to `pick_slip_generated`, returns URLs for the PDF + digital pick page.

**PDF route:** `/api/orders/[id]/pick-slip.pdf` — `@react-pdf/renderer`. Includes order number, requester, fulfillment type, lines (SKU + name + qty + bin), assigned picker, notes.

**Digital pick page:** `/dashboard/orders/[id]/pick` — mobile-optimized. Per-line check-off UI with quantity input. Each save calls `recordPickedLineAction(orderId, lineId, qty)`. First save flips status to `picking_in_progress`.

**Completion:** `completePickingAction` calls the `complete_picking` RPC, stock decrements, status → `picking_complete`.

### 2.4 Packing slips — two PDFs

**Trigger:** `generatePackingSlipsAction` — asserts status is `picking_complete`. Mints 256-bit hex `signature_token`, writes `packing_slip_generated_at` / `_by` and token columns, flips status to `packing_slip_generated`.

**Regeneration:** If a manager regenerates packing slips (re-running the action on a row that already has `signature_token` set), the previous token is overwritten with a fresh one. Any QR code on an old printed copy stops working. The action accepts re-run on `packing_slip_generated` status as a no-op-friendly idempotent rewrite.

**Customer copy** `/api/orders/[id]/packing-slip-customer.pdf` — minimal: order #, requester name, fulfillment type, items + quantities, packed date, warehouse name. Placed in box.

**Warehouse copy** `/api/orders/[id]/packing-slip-warehouse.pdf` — full: order #, requester contact, delivery address OR pickup notes, items with SKUs + bins, assigned delivery person, internal notes, **QR code** (top right) pointing at `${APP_URL}/orders/sign/${signature_token}`. Travels with driver.

QR via the `qrcode` npm dep (already used by `/api/shipments/[id]/pdf`).

### 2.5 Staging + delivery assignment

- "Mark staged for pickup" — pickup orders only; sets `staged_at` / `_by`, status → `staged_for_pickup`
- "Mark staged for delivery" — delivery orders only; sets `staged_at` / `_by`, status → `staged_for_delivery`
- "Assign delivery" (manager+ only, only on `staged_for_delivery`) — opens user picker dialog; writes `assigned_delivery_user_id`, `_by`, `_at`. Does NOT change status.

### 2.6 Transit + signature

- "Mark in transit" (assigned delivery user OR manager+, only on `staged_for_delivery` with `assigned_delivery_user_id IS NOT NULL`) — sets `in_transit_at` / `_by`, status → `in_transit`, fires in-transit email.

- **Public signature page** `/orders/sign/<token>` — mobile-first. Order summary read-only above signature pad. Captures: signature image, printed name (required), email (required, defaults to requester), submits.

- `submitOrderSignatureAction` — asserts status is `staged_for_pickup`, `in_transit`, or `signature_requested`; asserts token matches + not expired; writes signature columns and `completed_at`; flips status to `completed`; sends completion email with signed-PDF attachment.

- Old `/s/<token>` route stays alive for historical shipment signatures only.

### 2.7 Action layer

New server actions under `apps/web/src/server/actions/orders/`:

```
approve-order.ts             (existing logic + auto-assign picker)
deny-order.ts                (existing logic, requires reason)
reassign-picker.ts           (manager+)
generate-pick-slip.ts        NEW
record-picked-line.ts        NEW
complete-picking.ts          NEW (calls complete_picking RPC)
generate-packing-slips.ts    NEW
stage-order.ts               NEW (pickup | delivery dispatch)
assign-delivery.ts           NEW (manager+ gate)
mark-in-transit.ts           NEW
submit-order-signature.ts    NEW (replaces shipment-signature for orders)
```

Each action: validates the transition via the state machine, wraps mutation in a transaction, emits an audit event, calls `sendOrderEmail` (which is itself dedup-safe), revalidates `/dashboard/orders`.

## 3. UI

### 3.1 `/dashboard/orders` — Order list

Server-rendered, paginated, sticky filter bar.

Columns: Order # · Requester (name + email) · Type pill · Status pill · Picker · Delivery (only for delivery orders) · Created · Updated.

Status pill colors:
- `pending_approval` → amber
- `approved` / `pick_slip_generated` / `picking_in_progress` → blue
- `picking_complete` / `packing_slip_generated` → indigo
- `staged_for_pickup` / `staged_for_delivery` → purple
- `in_transit` → orange
- `completed` → emerald
- `denied` / `cancelled` → muted gray
- `pending_confirmation` → dashed amber outline

Filter bar: Status (with preset bundles), Type, Assigned-to-me cycle (off → picker-me → delivery-me), Date range, search.

Old `?status=` URL params still work.

### 3.2 `/dashboard/orders/[id]` — Order detail

Header strip (full width): `ORD-1234 · <type pill> <status pill> [actions ▾]`.

`[actions ▾]` computed by `availableOrderActions(order, viewer)` helper (lives next to the state machine). Conditional rules:

| Status | Actions |
|---|---|
| `pending_approval` | Approve · Deny (modal w/ reason) |
| `approved` | Generate pick slip · Reassign picker (manager+) |
| `pick_slip_generated` / `picking_in_progress` | Open digital pick · Print pick slip · Mark picking complete (enabled when all lines have qty) · Reassign picker (manager+) |
| `picking_complete` | Generate packing slips |
| `packing_slip_generated` | Print customer slip · Print warehouse slip · Mark staged (pickup or delivery) |
| `staged_for_pickup` | Collect pickup signature · Print warehouse slip |
| `staged_for_delivery` | Assign delivery (manager+) · Mark in transit (assigned user OR manager+, disabled if no assignment) |
| `in_transit` | Collect signature |
| `completed` | View signature record · Print receipt · View final packing slip |
| `denied` / `cancelled` | View denial reason (denied only) — terminal |

Cancel is available manager+ as a destructive secondary on every non-terminal status.

**Left column (60%)**: Requester · Fulfillment block · Lines table (qty / picked / packed / bin) · Notes (requester + internal_notes manager-visible).

**Right column (40%) sticky**: Status + assignments · Signature record (when relevant) · Email log (collapsed by default, sourced from `order_email_log`).

### 3.3 Timeline component

`<OrderTimeline order={...} />` pulls from `audit_logs` filtered to `entity_type='order_request' AND entity_id=order.id`. Renders vertical event list (timestamp + actor + metadata). Reuses the existing audit-rendering pattern from `/dashboard/admin/audit`.

### 3.4 Mobile

- Digital pick page (`/dashboard/orders/[id]/pick`) full-bleed, no sidebar, big tap targets, numeric keyboard.
- Signature page already mobile-first; order summary collapses to accordion.
- Order list collapses to requester + status only at <768px with expandable row.

### 3.5 Shipments deprecation

- `/dashboard/shipments` list stays online with yellow banner: *"Shipments are read-only — new outbound work is tracked under Orders."*
- `/dashboard/shipments/new` and `/dashboard/shipments/[id]` render but every action button is disabled with tooltip "Historical shipment — read only".
- "Create shipment" CTA removed from order detail entirely.
- `/s/<token>` public signature route stays alive (historical shipments retain working signature URLs).

## 4. Migration phasing

Six migrations, applied one at a time. Per the user's "pause after migration" rule, each phase is: commit + push, user applies migration, user confirms "Nxxx good", next phase begins.

### Phase 1 — `0109_orders_workflow_foundation.sql`

- `ALTER TABLE order_requests ADD COLUMN ...` for every field in §1.1
- `ALTER TABLE order_request_lines ADD COLUMN ...` for §1.2
- Extend `order_requests_status_check` constraint
- Backfill: `UPDATE order_requests SET fulfillment_type='delivery' WHERE fulfillment_type IS NULL`
- One-time status rewrite: `packaging → packing_slip_generated`, `ready_for_delivery → staged_for_delivery`, `delivered → completed`
- Rewrite `_validate_order_request_status_transition` with full new state machine
- Update `_notify_order_request_changes` for new requester-visible status transitions
- New audit event types in TS
- New permission key `orders:assign_delivery` (manager+) in `packages/core/src/constants/permissions.ts`
- `packages/core/src/order-state-machine.ts` exported

### Phase 2 — public + internal create UI

(No migration; slot 0110 reserved for any DB constraint discovered during phase 2.)

- Public form (`/r/<token>`) takes fulfillment type + address/pickup notes
- Internal `/dashboard/orders/new` rebuilt
- Public POST validator extended

### Phase 3 — `0111_complete_picking_rpc.sql`

- `complete_picking(p_order_id uuid, p_lines jsonb)` SECURITY DEFINER function
- `partial_pick_line(p_order_id, p_line_id, p_qty)` helper
- `order_email_log` table:
  ```sql
  id uuid pk, order_id uuid not null, email_type text not null,
  recipient_email citext not null, sent_at timestamptz default now(),
  message_id text,
  unique(order_id, email_type, recipient_email)
  ```
- Approve action auto-assigns picker
- Pick slip PDF route + digital pick UI

### Phase 4 — `0112_signature_token_index.sql`

- Partial unique index on `order_requests(signature_token) where signature_token is not null`
- `confirm_order_signature(p_id, p_token, p_signer_name, p_signer_email, p_signature_data_url)` SECURITY DEFINER function (atomically validates token, writes signature, flips status — assertion `signed_at IS NULL` inside the WHERE clause prevents replay)
- Two packing-slip PDFs with QR
- Stage actions (pickup, delivery)
- Manager-only delivery assignment dialog

### Phase 5 — transit + signature page

(No migration; everything table-driven from phase 4.)

- `markInTransitAction`
- `/orders/sign/<token>` public signature page
- `submitOrderSignatureAction`
- Completion email with signed-PDF attachment

### Phase 6 — `0113_notification_prefs_orders.sql` + `0114_shipments_deprecated_marker.sql`

- Add 5 columns to `notification_preferences`: `email_order_received`, `email_order_status_changed`, `email_order_in_transit`, `email_order_completed`, `push_order_assigned_to_me` (all default `true`)
- Update notifications settings UI to expose toggles
- `shipments.deprecated_at` column (informational)
- Yellow banner + disabled actions on `/dashboard/shipments`
- Order timeline component
- Test sweep

## 5. Email pipeline

Single helper `apps/web/src/lib/email/orders.ts`:

```ts
export async function sendOrderEmail(input: {
  orderId: string;
  kind: 'received' | 'approved' | 'denied' | 'pick_started'
      | 'staged_pickup' | 'staged_delivery' | 'in_transit' | 'completed';
}): Promise<{ sent: boolean; reason?: 'duplicate' | 'opted_out' | 'no_email' }>
```

Internal logic:
1. `INSERT INTO order_email_log ... ON CONFLICT DO NOTHING`. If `rowCount = 0`, return `{sent: false, reason: 'duplicate'}`.
2. If `requester_user_id IS NOT NULL`, check the relevant `notification_preferences` toggle; if off, return `{sent: false, reason: 'opted_out'}`.
3. Render React-Email template via existing helper; call `sendEmail` (Resend wrapper).
4. Best-effort backfill `order_email_log.message_id` from Resend response.

The unique constraint on `(order_id, email_type, recipient_email)` guarantees zero double-sends even if the action is retried mid-flight.

## 6. Tests

Target ≥30 new tests, distributed by phase:

- **Phase 1**: `order-state-machine.test.ts` — every legal transition, every illegal transition rejected, fulfillment-type guards
- **Phase 3**: `complete-picking.test.ts` (RPC integration), `record-picked-line.test.ts`, `pick-slip-pdf.test.ts` (smoke)
- **Phase 4**: `generate-packing-slips.test.ts`, `assign-delivery.test.ts` (rejects non-managers), `confirm_order_signature` RPC test (replay rejection)
- **Phase 5**: `submit-order-signature.test.ts` (valid token, expired, replay, wrong status), `mark-in-transit.test.ts` (rejects without assigned delivery)
- **Phase 6**: `order-email-log.test.ts` (dedup via unique constraint), `available-order-actions.test.ts` (every status × every role)

All passing before each phase's commit lands.

## 7. Risks + mitigations

| Risk | Mitigation |
|---|---|
| Stock-decrement port has a subtle bug → over/under-decrement | Phase 3 parity test: same input through `post_shipment_shipped` vs `complete_picking` produces identical `stock_movements` rows. Old RPC stays alive for historical rebuild. |
| Existing `delivered` rows broken on new list | Migration 0109's data rewrite runs *before* phases 2–6 ship; all deployed UI assumes the new enum. |
| Signature token format collision | New `signature_token` on orders uses same hex-64 format as 0108's confirm-token; different table from `shipments.signature_token`, no collision possible. |
| Two parallel models lingering forever | Phase 6 banner + removed "Create shipment" CTA + read-only routes makes cutover explicit. Final cleanup (drop shipment-write RLS) deferred 30 days, separate scope. |
| Phase 5 signature page allows replay | `confirm_order_signature` asserts `signed_at IS NULL` inside the WHERE clause; second click rolls back with no update. |
| Cross-phase tests break in CI between commits | Every phase's commit ships with typecheck + tests green; phases are individually shippable. |

## 8. Assumptions

1. Existing single-warehouse-per-order is fine; no multi-warehouse splits.
2. Inventory reservations at approval already work; phase 3 only changes the release/decrement side.
3. `audit_logs` is the source of truth for the timeline component — no new history table needed.
4. Push notifications via the live-toast pipeline (just shipped 2026-05-15) cover in-app real-time updates for the new actions.
5. PDF rendering reuses `@react-pdf/renderer` from `/api/shipments/[id]/pdf`; no new dep.
6. The `qrcode` npm package is already in `apps/web/package.json` (used by existing shipment slip route).

## 9. Manual acceptance test

After phase 6 ships, the following two scenarios must pass end-to-end:

### Delivery scenario

1. Public requester opens `/r/<token>`, selects Delivery, fills address, lines, submits.
2. Receives "Please confirm your order" email; clicks link.
3. Manager opens order in `/dashboard/orders`, approves.
4. Approver auto-assigned as picker.
5. Requester gets approval email.
6. Picker generates pick slip; prints PDF or opens digital pick page.
7. Picker marks each line picked; clicks "Mark picking complete". Stock decrements.
8. Picker generates packing slips; prints customer + warehouse copies.
9. Warehouse staff marks order staged for delivery.
10. Manager opens delivery-assignment dialog, picks a driver.
11. Driver marks order in-transit on their phone.
12. Requester gets in-transit email.
13. Driver scans QR on warehouse packing slip at delivery; recipient signs on phone.
14. Order auto-completes; requester gets completion email with signed PDF attached.
15. Internal order detail page shows full timeline + signature record.

### Pickup scenario

1. Internal staff creates order on behalf of walk-in customer, type Pickup.
2. Approves, generates pick slip, completes picking, generates packing slips.
3. Marks order staged for pickup.
4. Customer arrives at warehouse; staff opens `/orders/sign/<token>` on tablet.
5. Customer signs, prints name, confirms email.
6. Order completes; confirmation email goes out.
7. Timeline shows every step.

## 10. Deferred / explicitly NOT in scope

- Drop the `shipments` table (30+ days post-phase-6, separate migration)
- Reopen / undo a completed order
- "View on map" for in-transit
- Multi-warehouse order split
- Native driver mobile app
- SMS notifications
- Customer-portal self-service status page (the `/r/track` page already covers this)
