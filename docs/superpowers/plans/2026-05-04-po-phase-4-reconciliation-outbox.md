# Phase 4 — Reconciliation + Outbox + Over-Receipt Approval Implementation Plan

> **For agentic workers:** Architecture-level. Expand each task to TDD step-by-step detail before execution.

**Goal:** Give admins/managers a single dashboard view of "what was ordered vs what was received vs what's still open" by warehouse + charter + vendor; let the system emit asynchronous outbox events for downstream consumers; add an approval workflow for over-receipts that exceed configured tolerance.

**Architecture:**
- New `outbox_events` table written **inside the same transaction** as receipt posting (and other state transitions). A future worker (out of scope for Phase 4) drains it. For now: insert + leave; `published_at` stays null.
- Three new SQL views (no tables needed): `vw_po_reconciliation`, `vw_warehouse_inbound`, `vw_vendor_performance`. Materialized? No — keep them as regular views, refresh-free. Performance acceptable on org sizes <100k PO lines.
- New `approvals` table for over-receipt approvals. State machine: `requested → approved | denied → resolved`.
- New `tolerance_profiles` table per vendor (or org default) defining over-receipt percent allowed without approval.
- `post_receipt_v2` RPC checks tolerance before posting. If over by `> tolerance_pct`:
  - if requester is admin → post + audit `over_receipt.allowed`
  - else → reject with `over_receipt_requires_approval`, write an `approvals` row with status `requested`
- Approval flow: admin opens `/dashboard/admin/approvals`, reviews, approves/denies. Approval triggers a new `post_receipt_v2` call with a flag bypassing the tolerance check.

**Tech Stack:** Same as Phases 1-3. SQL views; one new RPC `request_over_receipt_approval`.

---

## File structure

### New files

```
supabase/migrations/
  0016_outbox.sql                  # outbox_events table + insert helper
  0017_reconciliation_views.sql    # 3 views + tolerance_profiles + approvals

packages/core/src/schemas/
  approvals.ts                     # request/decide schemas

apps/web/src/server/services/
  outbox.ts                        # OutboxService.publish (inserts row in current tx; future worker dispatches)
  approvals.ts                     # ApprovalsService: request, decide, listOpen, listForUser
  approvals.test.ts
  reconciliation.ts                # ReconciliationService.summary({warehouseId?, charterId?, vendorId?})

apps/web/src/server/actions/
  approvals.ts                     # decideApprovalAction

apps/web/src/components/admin/
  approvals-list.tsx               # admin queue
  reconciliation-table.tsx
  reconciliation-filters.tsx

apps/web/src/app/(dashboard)/dashboard/admin/
  approvals/
    page.tsx
  reconciliation/
    page.tsx
```

### Modified files

```
supabase/setup/full-schema.sql                             # bundle 0016 + 0017
apps/web/src/server/services/audit.ts                      # +over_receipt.requested, .approved, .denied, .allowed
apps/web/src/server/services/receiving.ts                  # publish outbox 'receipt.posted' after success
apps/web/src/components/dashboard/nav.ts                   # +Reconciliation, +Approvals admin links
apps/web/src/server/services/receiving.ts                  # call new RPC `post_receipt_v2_with_tolerance` (tolerance check)
```

---

## Task list

### Task 1: Migration 0016 — outbox_events

```sql
create table if not exists public.outbox_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  topic           text not null,             -- e.g. 'receipt.posted', 'po_import.approved'
  aggregate_type  text not null,
  aggregate_id    uuid,
  dedupe_key      text,
  payload         jsonb not null,
  published_at    timestamptz,
  created_at      timestamptz not null default now(),
  unique (organization_id, dedupe_key) where dedupe_key is not null
);
create index if not exists outbox_unpublished_idx
  on public.outbox_events(organization_id, created_at)
  where published_at is null;
```

RPC `publish_outbox(p_topic text, p_aggregate_type text, p_aggregate_id uuid, p_payload jsonb, p_dedupe_key text default null)` — convenience inserter usable from inside other RPCs.

### Task 2: Migration 0017 — tolerance + approvals + reconciliation views

```sql
create table if not exists public.tolerance_profiles (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  vendor_id       uuid references public.suppliers(id) on delete cascade,  -- null = org default
  over_receipt_pct numeric(6,4) not null default 0.05,  -- 5%
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, vendor_id)
);

create table if not exists public.approvals (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  type            text not null check (type in ('over_receipt','manual_adjustment','receipt_reversal')),
  related_type    text not null,
  related_id      uuid not null,
  requested_by    uuid not null references public.user_profiles(id),
  reason          text,
  payload         jsonb not null,           -- snapshot of what they want to do
  status          text not null default 'requested'
                    check (status in ('requested','approved','denied','expired','superseded')),
  decided_by      uuid references public.user_profiles(id),
  decided_at      timestamptz,
  decision_notes  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create or replace view public.vw_po_reconciliation as
  select
    po.organization_id,
    po.id            as purchase_order_id,
    po.po_number,
    po.status,
    po.supplier_id,
    s.name           as supplier_name,
    po.destination_location_id,
    sum(pol.quantity_ordered)  as qty_ordered_total,
    sum(pol.quantity_received) as qty_received_total,
    sum(pol.quantity_ordered - pol.quantity_received) as qty_open_total,
    sum(pol.quantity_ordered * pol.unit_cost) as cost_ordered_total,
    sum(pol.quantity_received * pol.unit_cost) as cost_received_total,
    po.created_at,
    po.updated_at
  from public.purchase_orders po
  join public.purchase_order_items pol on pol.purchase_order_id = po.id
  left join public.suppliers s on s.id = po.supplier_id
  group by po.id, po.po_number, po.status, po.supplier_id, s.name,
           po.destination_location_id, po.created_at, po.updated_at, po.organization_id;

create or replace view public.vw_warehouse_inbound as
  select
    po.organization_id,
    loc.warehouse_id,
    count(distinct po.id) filter (where po.status in ('expected_inbound','ordered','partially_received'))
      as open_po_count,
    sum(pol.quantity_ordered - pol.quantity_received)
      filter (where po.status in ('expected_inbound','ordered','partially_received'))
      as qty_open_total
  from public.purchase_orders po
  join public.purchase_order_items pol on pol.purchase_order_id = po.id
  left join public.locations loc on loc.id = po.destination_location_id
  group by po.organization_id, loc.warehouse_id;

create or replace view public.vw_vendor_performance as
  select
    po.organization_id,
    po.supplier_id,
    s.name as supplier_name,
    count(distinct po.id) as po_count,
    sum(pol.quantity_ordered) as qty_ordered,
    sum(pol.quantity_received) as qty_received,
    case when sum(pol.quantity_ordered) > 0
      then round(sum(pol.quantity_received) * 100.0 / sum(pol.quantity_ordered), 2)
      else null
    end as fill_rate_pct
  from public.purchase_orders po
  join public.purchase_order_items pol on pol.purchase_order_id = po.id
  left join public.suppliers s on s.id = po.supplier_id
  group by po.organization_id, po.supplier_id, s.name;
```

### Task 3: `OutboxService.publish` + wiring receipt.posted

`receiving.ts` (after a successful `post_receipt_v2` call):

```typescript
await OutboxService.publish({
  topic: 'receipt.posted',
  aggregateType: 'receipt',
  aggregateId: receipt.id,
  payload: { poId, warehouseId, lineCount, totalAccepted },
  dedupeKey: `receipt.posted:${receipt.id}`,
});
```

> Note: this insert lives inside the same supabase transaction as the receipt — currently we use individual queries; revisit when we move to true Postgres transactions in Phase 2. For now, best-effort same-batch.

### Task 4: `ApprovalsService.request(input)` + over-receipt detection

**Approach:** Extend Phase 2's `post_receipt_v2` RPC in-place by adding a new optional parameter `p_bypass_tolerance boolean default false`. Do **not** create a separate `post_receipt_v2_with_tolerance` function. The migration that adds tolerance/approval lives in `0017_reconciliation_views.sql` and uses `create or replace function public.post_receipt_v2(...)` with the new signature.

Logic added inside the RPC, before the existing line-loop:

1. Compute `over_pct` per line: `(quantity_received_after_this_post - quantity_ordered) / quantity_ordered`
2. Look up `tolerance_profiles` for the PO's vendor (fall back to org default 5%)
3. If any line's `over_pct > tolerance_pct` AND `p_bypass_tolerance = false`:
   - if `has_org_role(org_id, 'admin')` → audit `over_receipt.allowed` and proceed
   - else → raise `over_receipt_requires_approval` with errcode `P0003`. Caller (the service) catches and writes an `approvals` row with `payload = {receiptInput}`, `status='requested'`, `type='over_receipt'`
4. The submitting user gets a 409 + "Pending approval" message
5. Admin sees the pending approval at `/dashboard/admin/approvals`, can approve or deny
6. On approve: server re-calls `post_receipt_v2` with the original input plus `p_bypass_tolerance = true`

### Task 5: `ApprovalsService.decide(approvalId, decision, notes)`

- Loads approval row, checks status='requested'
- If approve + type='over_receipt': re-runs `post_receipt_v2` with bypass=true using `payload`
- If deny: status='denied' + decision_notes
- Audit `over_receipt.approved` or `over_receipt.denied`

### Task 6: `ReconciliationService.summary(filters)`

```typescript
async summary(filters: {
  warehouseId?: string;
  charterId?: string;
  vendorId?: string;
  status?: 'open' | 'closed' | 'all';
}): Promise<{
  rows: ReconciliationRow[];   // straight from vw_po_reconciliation, filtered
  totals: { qtyOrdered: number; qtyReceived: number; qtyOpen: number };
  byVendor: VendorPerformanceRow[];   // straight from vw_vendor_performance
}>
```

Warehouse-scope: staff/viewer → forced; manager/admin → optional.

### Task 7: Reconciliation UI

Page at `/dashboard/admin/reconciliation` (admin-only):
- Filters: warehouse, charter, vendor, status (open/closed/all), date range
- Top-line numbers: orders open, qty open, fill rate
- Vendor performance table: each vendor with PO count, fill rate, qty
- PO table: po_number, supplier, status, ordered, received, open, cost ordered, cost received

CSV export button (admin-only). Audit `report.exported`.

### Task 8: Approvals queue UI

Page at `/dashboard/admin/approvals`:
- Tabs: Pending / Decided
- Each pending row: type, requester, requested_at, related entity link, summary of payload, **Approve** / **Deny** buttons (popover for notes)

### Task 9: Tolerance profiles admin UI

Add a small section to the existing `/dashboard/admin/vendor-mappings` page or a new `/dashboard/admin/tolerance` page: per-vendor `over_receipt_pct` slider; org default at top.

### Task 10: Tests

1. Receiving exactly the ordered qty → no approval needed
2. Receiving 5% over (≤ tolerance) → no approval; audit `over_receipt.allowed`
3. Receiving 10% over (> 5% tolerance) → 409 conflict, approval row created with status=requested
4. Admin approves → original receipt now posts; stock bumps by full amount
5. Admin denies → no stock change; approval status=denied with notes
6. Outbox row inserted for every successful `receipt.posted`
7. Reconciliation view returns correct totals after partial receipt
8. Reconciliation excludes `cancelled` POs from open totals

### Task 11: Done criteria

- [ ] Migrations 0016 + 0017 applied
- [ ] `outbox_events` table has rows after each receipt
- [ ] `/dashboard/admin/reconciliation` shows real numbers from your live POs
- [ ] Over-receipt of 10% triggers approval flow; approve unblocks; deny blocks
- [ ] CSV export button works and audits the export
