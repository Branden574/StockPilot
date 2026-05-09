# Order Requests — Design Spec

**Date:** 2026-05-08
**Status:** Approved, ready for implementation plan
**Branch target:** `main`

## 1. Problem

Today, anyone who needs items from L4L Fresno's inventory has to ask a manager out-of-band (text, call, in person). Read-only "viewer" accounts can browse the catalog but can't trigger any kind of request. External partners (schools, community orgs) have no way to ask for books at all without a human handoff.

This spec adds a first-class **internal order-request workflow**:

1. Read-only and staff users get a "Place order" button inside the dashboard.
2. External partners get a persistent public link that lets them request books from a curated catalog.
3. Managers see a queue of pending requests, approve or deny each one, and track fulfillment through a clear status pipeline.
4. Inventory reflects reality: stock is *reserved* on approval, *deducted* on delivery — preventing overselling and matching how every real warehouse works.
5. Requesters get email updates as the order moves through stages; managers get in-app + push pings on new requests.

This is distinct from `purchase_orders` (which are orders sent **to suppliers**). Order requests are orders received **from internal users + partners**.

## 2. Goals

- Every signed-in role — including viewer — can submit an order request via dashboard UI.
- One persistent public link per org lets external requesters submit requests with email + name + optional school label.
- Manager approval flow with reserve-on-approve, deduct-on-deliver semantics.
- Status pipeline: `pending_approval → approved → packaging → ready_for_delivery → delivered`, plus terminal `denied` / `cancelled`.
- Email notifications for every status change reaching the requester.
- In-app bell + Expo push for managers when new requests arrive.
- Anyone can cancel their own request at any stage (with auto-release of reservations).
- AI assistant can list + summarize requests via two new tools.

## 3. Non-goals (v1)

- Per-warehouse public links (one token per org; warehouse toggle is on the org settings page)
- One-shot / expiring public links
- Multi-warehouse requests (one warehouse per request)
- Captcha on public form (rate limit + Resend's caps are enough for v1; hCaptcha is a 30-min add later)
- Editing line quantities post-submission by the requester (managers can edit; requesters cancel and resubmit)
- Bulk approve UI (single-request approval is fine for L4L Fresno's volume)
- Pricing/payment flow — these are internal/donation requests, no money changes hands
- SMS notifications

## 4. Architecture

### 4.1 Data model

Migration `0044_order_requests.sql`:

```sql
create table order_requests (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references organizations(id) on delete cascade,
  warehouse_id       uuid not null references warehouses(id) on delete restrict,
  status             text not null default 'pending_approval'
                       check (status in (
                         'pending_approval','approved','packaging',
                         'ready_for_delivery','delivered',
                         'denied','cancelled'
                       )),
  requester_user_id    uuid references user_profiles(id) on delete set null,
  requester_email      text,
  requester_name       text,
  requester_org_label  text,
  approved_by          uuid references user_profiles(id) on delete set null,
  approved_at          timestamptz,
  denied_reason        text,
  packaging_at         timestamptz,
  ready_at             timestamptz,
  delivered_at         timestamptz,
  cancelled_at         timestamptz,
  cancelled_by         uuid references user_profiles(id) on delete set null,
  notes                text,
  internal_notes       text,
  source               text not null default 'internal'
                         check (source in ('internal','public_link')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- Exactly one identity path is set
  check (
    (requester_user_id is not null and source = 'internal') or
    (requester_email is not null and source = 'public_link')
  )
);
create index order_requests_org_status_idx
  on order_requests(organization_id, status, created_at desc);
create index order_requests_requester_idx
  on order_requests(requester_user_id) where requester_user_id is not null;
create index order_requests_pending_idx
  on order_requests(organization_id) where status = 'pending_approval';

create table order_request_lines (
  id                  uuid primary key default gen_random_uuid(),
  order_request_id    uuid not null references order_requests(id) on delete cascade,
  item_id             uuid not null references inventory_items(id) on delete restrict,
  quantity_requested  numeric(14,4) not null check (quantity_requested > 0),
  quantity_fulfilled  numeric(14,4) not null default 0,
  unit_cost_at_request numeric(14,4) not null default 0,
  notes               text
);
create index order_request_lines_order_idx on order_request_lines(order_request_id);
create index order_request_lines_item_idx  on order_request_lines(item_id);

create table stock_reservations (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references organizations(id) on delete cascade,
  item_id             uuid not null references inventory_items(id) on delete cascade,
  warehouse_id        uuid not null references warehouses(id) on delete cascade,
  order_request_id    uuid references order_requests(id) on delete cascade,
  quantity            numeric(14,4) not null check (quantity > 0),
  released_at         timestamptz,
  released_reason     text,
  created_at          timestamptz not null default now()
);
create index stock_reservations_active_idx
  on stock_reservations(organization_id, item_id) where released_at is null;

alter table organizations
  add column if not exists public_request_token text,
  add column if not exists public_request_token_rotated_at timestamptz,
  add column if not exists public_request_blurb text;
create unique index if not exists organizations_public_request_token_idx
  on organizations(public_request_token) where public_request_token is not null;

alter table warehouses
  add column if not exists is_public_orderable boolean not null default false;

-- stock_movements gets two new reason values used by this feature.
-- (movement_type column already accepts 'remove' / 'adjust' which we
-- reuse here.)
-- New conventional `reason` values: 'order_delivered', 'order_cancelled'.
```

### 4.2 RLS

```sql
alter table order_requests enable row level security;
alter table order_request_lines enable row level security;
alter table stock_reservations enable row level security;

-- Read: any org member.
create policy order_requests_select on order_requests
  for select to authenticated using (is_org_member(organization_id));
create policy order_request_lines_select on order_request_lines
  for select to authenticated using (
    exists (select 1 from order_requests r
            where r.id = order_request_lines.order_request_id
              and is_org_member(r.organization_id)));
create policy stock_reservations_select on stock_reservations
  for select to authenticated using (is_org_member(organization_id));

-- Insert (request creation): any org member with orders:request.
-- The role check happens via has_org_role hierarchy; viewer is the
-- floor for orders:request so we hand-roll a role-list policy.
create policy order_requests_insert on order_requests
  for insert to authenticated with check (
    is_org_member(organization_id)
    and (requester_user_id = auth.uid() or source = 'public_link')
  );
create policy order_request_lines_insert on order_request_lines
  for insert to authenticated with check (
    exists (select 1 from order_requests r
            where r.id = order_request_lines.order_request_id
              and r.requester_user_id = auth.uid())
  );

-- Update: managers+ for status flow; requesters can only cancel.
-- The service layer enforces field-level permissions; the policy is
-- a coarse gate that a row is touchable by an org member.
create policy order_requests_update on order_requests
  for update to authenticated using (is_org_member(organization_id));

-- stock_reservations are written by SECURITY DEFINER functions only —
-- no INSERT/UPDATE policies for end users.
```

### 4.3 SQL functions

```sql
create or replace function approve_order_request(p_id uuid)
returns order_requests
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_req order_requests;
  v_line record;
  v_available numeric;
begin
  select * into v_req from order_requests where id = p_id for update;
  if not found then raise exception 'order_request_not_found'; end if;
  if not has_org_role(v_req.organization_id, 'manager') then
    raise exception 'forbidden';
  end if;
  if v_req.status <> 'pending_approval' then
    raise exception 'invalid_status_transition' using detail = v_req.status;
  end if;

  -- Lock items + check availability (qty_on_hand minus active reservations)
  for v_line in
    select l.item_id, l.quantity_requested, ii.quantity_on_hand
    from order_request_lines l
    join inventory_items ii on ii.id = l.item_id
    where l.order_request_id = p_id
    order by l.item_id  -- deterministic to avoid deadlocks
    for update of ii
  loop
    select coalesce(sum(quantity), 0) into v_available
    from stock_reservations
    where item_id = v_line.item_id and released_at is null;
    if v_line.quantity_requested > v_line.quantity_on_hand - v_available then
      raise exception 'insufficient_stock' using detail = v_line.item_id::text;
    end if;
  end loop;

  -- Insert reservations
  insert into stock_reservations (
    organization_id, item_id, warehouse_id, order_request_id, quantity
  )
  select v_req.organization_id, l.item_id, v_req.warehouse_id, p_id, l.quantity_requested
  from order_request_lines l where l.order_request_id = p_id;

  update order_requests
    set status='approved', approved_by=auth.uid(), approved_at=now(), updated_at=now()
    where id = p_id;

  return (select * from order_requests where id = p_id);
end;
$$;
```

`deliver_order_request(p_id)` — same lock pattern; for each line: emits one `stock_movements` row (`movement_type='remove'`, `reason='order_delivered'`, `reference_type='order_request'`, `reference_id=p_id`), updates `inventory_items.quantity_on_hand`, sets `quantity_fulfilled=quantity_requested`, releases the matching reservation. Sets status='delivered', delivered_at.

`cancel_order_request(p_id)` — caller-aware: requester can cancel their own at any stage; manager+ can cancel anyone's. Releases active reservations with `released_reason='cancelled'`. If status was post-approval, also writes a notification row addressed to managers.

### 4.4 Notification writers

Single trigger `_notify_order_request_changes()` fires on INSERT and UPDATE. Branches on the status transition:

- INSERT → notify managers (bell + push via 0028 chain)
- approved/denied → notify requester (bell if signed-in)
- packaging/ready_for_delivery/delivered → notify requester (bell if signed-in)
- cancelled by requester after approval → notify managers

Email side runs in TypeScript via the service: each transition method calls `notifyStatusChange()` which sends a Resend email built from `apps/web/src/emails/order-request-*.tsx` templates. Two paths (DB notification + TS email) run in parallel; either failing doesn't block the other.

## 5. Service layer

`apps/web/src/server/services/order-requests.ts`:

```ts
export class OrderRequestsService {
  // Read
  list(filters: ListFilters): Promise<OrderRequestSummary[]>
  get(id: string): Promise<OrderRequestDetail>
  myRequests(): Promise<OrderRequestSummary[]>
  pendingCount(): Promise<number>

  // Requester writes
  create(input: CreateOrderRequestInput): Promise<OrderRequestRow>
  cancel(id: string, reason?: string): Promise<void>

  // Manager writes
  approve(id: string, internalNotes?: string): Promise<OrderRequestRow>
  deny(id: string, reason: string): Promise<OrderRequestRow>
  setStatus(
    id: string,
    next: 'packaging' | 'ready_for_delivery',
  ): Promise<OrderRequestRow>
  markDelivered(id: string): Promise<OrderRequestRow>

  // Org admin
  rotatePublicToken(): Promise<{ token: string }>
  setBlurb(blurb: string | null): Promise<void>
  setWarehousePublicOrderable(warehouseId: string, on: boolean): Promise<void>
}
```

All write methods call `assertPermission()` first, then delegate atomic work to the SQL function (when one exists). Email send runs in `void` background after the write commits.

## 6. Server actions

`apps/web/src/server/actions/order-requests.ts` — zod-validated wrappers around each method, returning `ActionResult`. Standard pattern matching `bundles.ts`.

## 7. Public submit endpoint

`apps/web/src/app/api/v1/public/order-requests/route.ts` (POST):

- Body: `{ token, warehouseId, lines, requesterEmail, requesterName, requesterOrgLabel?, notes? }`
- Looks up `organizations` by `public_request_token = body.token` (using the service-role admin client)
- Validates `warehouses.is_public_orderable=true` for the chosen warehouse
- Enforces every line.item_id has `item_type='book'` AND belongs to the chosen warehouse
- Rate limited via a `rate_limit_buckets` table (org_id, key, count, window_started_at) — atomic upsert per submit. 10 req/IP/hour, 30 req/token/day. Beats in-memory which doesn't survive Vercel's serverless cold starts.
- Inserts the request with `source='public_link'`, then inserts the lines
- Sends a confirmation email to `requesterEmail`
- Returns `{ id, trackUrl: '/r/<token>/track?id=<id>&email=<email>' }`

A companion `GET /api/v1/public/order-requests/[id]` accepts `?token=&email=` and returns a redacted status payload (no internal_notes, no requester PII other than the matching email).

## 8. UI surfaces

### 8.1 `/dashboard/orders`
- Manager view: status tabs, queue table, default tab = Pending approval
- Requester view: "My requests" only, with prominent "+ Place order" button

### 8.2 `/dashboard/orders/new`
- Warehouse picker → item search filtered to that warehouse, available-to-promise visible per row
- Sticky cart panel right side
- Submit → detail page

### 8.3 `/dashboard/orders/[id]`
- Status timeline + lines table
- Manager actions panel (approve/deny/status flips/internal notes)
- Requester action: cancel (any stage)
- Active reservations strip (when approved+)

### 8.4 `/r/<token>` — public landing page
- Name + email + school label inputs
- Warehouse picker (filtered to `is_public_orderable=true`)
- Book grid with covers (filtered to `item_type='book'`)
- Sticky cart, submit, confirmation card
- "Track an order" link → `/r/<token>/track`

### 8.5 `/dashboard/settings/public-requests`
- Token URL + Regenerate
- Per-warehouse public-orderable toggles
- Org blurb textarea
- 30-day request counter

### 8.6 `/dashboard/orders/[id]/print`
- Print-ready pick list with bin locations + barcodes

### 8.7 Existing-page tweaks
- Sidebar: new "Orders" link with pending-count badge for managers
- Item detail: "Reserved" stat next to "On hand" when active reservations exist

## 9. AI tools

Two new read-only AI tools:
- `listOrderRequests({ status?, requesterEmail?, limit? })`
- `getOrderRequestSummary()` — pending count + overdue (>3 days unactioned)

Chat system prompt addition: "What orders are waiting / pending requests / show me Maria's orders" → `listOrderRequests`. "Anything overdue?" → `getOrderRequestSummary`.

## 10. Permissions

```
viewer:  +orders:request                 (NEW; main feature gate)
staff:    orders:request                 (carried forward)
manager: +orders:approve                 (NEW)
admin/owner: inherit
```

Public-link submits authenticate via the token, not via per-user permissions.

## 11. Audit events

- `order_request.created`
- `order_request.approved`
- `order_request.denied`
- `order_request.status_changed`
- `order_request.cancelled`
- `order_request.delivered`
- `order_request.public_link_rotated`

## 12. Edge cases

| Case | Behavior |
|---|---|
| Two managers approve simultaneously | SQL function holds row locks; second caller gets `validation_error: already_approved` |
| Requester cancels post-approval | Reservations released, status='cancelled', managers pinged via bell + push |
| Manager marks delivered with insufficient stock | `deliver_order_request()` errors `insufficient_stock`; manager edits qtys to actual delivered amounts and retries |
| Item deleted between request and approval | Approve fails with `item_not_found`; manager removes the line and retries |
| Public token rotated mid-fill | Page polls `/r/<token>/health`; shows "Link expired" banner |
| Public rate limit hit | 429 with friendly retry message |
| Org has no public-orderable warehouses | `/r/<token>` page shows "This org isn't accepting public requests right now" |
| Requester signs in mid-form | We don't auto-link; submit goes through public flow as anonymous |
| Public requester wants to track | Email + request-id form on `/r/<token>/track` returns redacted status |

## 13. Migration footprint

Single migration: **`0044_order_requests.sql`**
- 3 new tables (order_requests, order_request_lines, stock_reservations)
- 3 columns on `organizations` (public_request_token, public_request_token_rotated_at, public_request_blurb)
- 1 column on `warehouses` (is_public_orderable)
- 3 SQL functions (approve_order_request, deliver_order_request, cancel_order_request)
- 1 notification writer trigger
- RLS policies

## 14. Implementation file list

**Server**
- `apps/web/src/server/services/order-requests.ts`
- `apps/web/src/server/actions/order-requests.ts`
- `apps/web/src/lib/email/send.ts` (existing — adds new sender wrappers)
- `apps/web/src/emails/order-request-submitted.tsx`
- `apps/web/src/emails/order-request-approved.tsx`
- `apps/web/src/emails/order-request-denied.tsx`
- `apps/web/src/emails/order-request-status.tsx`
- `apps/web/src/lib/ai/tools.ts` (add 2 tools, update system prompt)
- `apps/web/src/server/services/audit.ts` (extend AuditEvent union)
- `packages/core/src/constants/permissions.ts` (add 2 permissions, wire roles)
- `apps/web/src/app/api/v1/public/order-requests/route.ts`
- `apps/web/src/app/api/v1/public/order-requests/[id]/route.ts`

**Pages**
- `apps/web/src/app/(dashboard)/dashboard/orders/page.tsx`
- `apps/web/src/app/(dashboard)/dashboard/orders/new/page.tsx`
- `apps/web/src/app/(dashboard)/dashboard/orders/[id]/page.tsx`
- `apps/web/src/app/(dashboard)/dashboard/orders/[id]/print/page.tsx`
- `apps/web/src/app/(dashboard)/dashboard/settings/public-requests/page.tsx`
- `apps/web/src/app/r/[token]/page.tsx`
- `apps/web/src/app/r/[token]/track/page.tsx`

**Components**
- `apps/web/src/components/orders/order-request-form.tsx`
- `apps/web/src/components/orders/order-request-table.tsx`
- `apps/web/src/components/orders/manager-actions-panel.tsx`
- `apps/web/src/components/orders/cancel-order-button.tsx`
- `apps/web/src/components/orders/public-order-form.tsx`
- `apps/web/src/components/orders/public-token-controls.tsx`
- `apps/web/src/components/dashboard/nav.ts` (add "Orders" link)
- `apps/web/src/components/dashboard/topbar.tsx` (breadcrumb entries)

## 15. Testing

- Unit: state machine transitions (every illegal transition errors), reservation math, available-to-promise calc
- Unit: rate-limit token bucket
- Integration: full flow on a fixture org (request → approve → reserve → packaging → ready → deliver → stock_movements). Concurrent-approve via two simultaneous calls verifies the row lock.
- Integration: public link submit + email delivery (mock Resend)
- E2E (Playwright): viewer signs in, places an order, manager approves on a second browser, requester sees status update without refresh (realtime publication on `order_requests` already covered if we add the table to `supabase_realtime`)

## 16. Rollout

Two-step ship:

1. **Migration 0044** (tables + functions + RLS + writer trigger). Apply, then push the migration commit. No UI yet — no behavior change for existing users.
2. **Service + actions + UI + email + AI tools** in one commit. New "Orders" link surfaces in the sidebar; viewer accounts unlock the "+ Place order" button.

Public link feature is a bonus inside step 2 — settings page + `/r/<token>` ship together but are off by default (no warehouses are `is_public_orderable=true` until the org admin flips a toggle).

## 17. Open questions / future work

- hCaptcha on the public form if abuse appears
- Per-warehouse public links (decided against for v1)
- Bulk approve UI for high-volume orgs
- Auto-fulfillment (skip manager approval for trusted requesters)
- Request templates ("the usual school visit pack" → preselected lines)
- SMS notifications via Twilio
