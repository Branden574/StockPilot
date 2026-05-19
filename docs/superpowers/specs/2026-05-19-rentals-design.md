# Rentals — Design

**Date:** 2026-05-19
**Status:** Draft (awaiting user review)
**Owner:** Branden

## Problem

L4L Fresno (a charter school) lends out physical items — canopies, supplies, equipment — to employees and vendors for school events. Today there's no system of record for "who has the canopy"; it's a Google Sheet at best. The team needs a checkout/return tracker so:

- Anyone can see what's currently out and when it's due back.
- Rented-out items are unavailable for ordering (so the same canopy can't be promised to two events).
- A clean audit trail exists ("who's had this thing", "what's Karen taken").

**No money is involved.** This is purely accountability.

## Goals

- One rental record = one borrower + many items + a checkout date + an expected return date.
- Status states: `out` (currently with borrower) → `returned` (back) → `cancelled` (never picked up).
- Overdue is derived (not stored): `status='out' AND expected_return_at < now()`.
- Rented items reduce available-to-promise on the orders/new picker (same hold mechanism as `stock_reservations`).
- Staff+ create rentals; manager+ can edit/cancel/delete after the fact.
- Strictly internal — no student-facing surface, no public link.

## Non-goals

- Money / deposits / fees / late fees.
- Self-service portal for borrowers (always staff-mediated checkout).
- Photo evidence at checkout/return (defer to follow-up).
- Multi-warehouse rentals (each rental is from a single warehouse).
- Recurring rentals.
- Calendar / availability view (defer; v1 is list + per-rental detail).
- Pre-bookings / future-dated rentals (v1 = "out right now"; future-start is out of scope).

## Borrower model

Locked decision: borrowers can be EITHER a team member from `organization_members` OR a free-text name (since most renters don't have system accounts).

Schema (simplified):

```sql
rental.borrower_user_id  uuid null references user_profiles  -- when a member
rental.borrower_name     text not null                       -- always populated; either the member's name or the typed name
rental.borrower_email    text null                           -- optional, useful for reminders
```

Rule: exactly one of `borrower_user_id` OR `borrower_name`-only — if `borrower_user_id` is set, `borrower_name` is auto-filled with the member's display name on create. UI shows "Karen Smith (member)" vs "Karen Smith" so it's clear which is which.

## Data model

```sql
-- 0131_rentals.sql
create table public.rentals (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references organizations(id) on delete cascade,
  warehouse_id         uuid not null references warehouses(id) on delete restrict,
  borrower_user_id     uuid references user_profiles(id) on delete set null,
  borrower_name        text not null,         -- always populated
  borrower_email       text,                  -- optional
  checked_out_at       timestamptz not null default now(),
  expected_return_at   timestamptz not null,  -- required; you have to say when it's coming back
  returned_at          timestamptz,           -- null until checked back in
  status               text not null
                       check (status in ('out','returned','cancelled'))
                       default 'out',
  notes                text,
  created_by           uuid references user_profiles(id) on delete set null,
  cancelled_by         uuid references user_profiles(id) on delete set null,
  cancelled_at         timestamptz,
  cancellation_reason  text,
  returned_by          uuid references user_profiles(id) on delete set null,
  return_notes         text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table public.rental_lines (
  id           uuid primary key default gen_random_uuid(),
  rental_id    uuid not null references rentals(id) on delete cascade,
  item_id      uuid not null references inventory_items(id) on delete restrict,
  quantity     numeric(14,4) not null check (quantity > 0),
  notes        text,
  created_at   timestamptz not null default now()
);

create index rentals_org_status_idx       on rentals(organization_id, status);
create index rentals_warehouse_idx         on rentals(warehouse_id);
create index rentals_borrower_user_idx     on rentals(borrower_user_id) where borrower_user_id is not null;
create index rentals_expected_return_idx   on rentals(expected_return_at) where status = 'out';
create index rental_lines_rental_idx       on rental_lines(rental_id);
create index rental_lines_item_idx         on rental_lines(item_id);

alter table public.rentals enable row level security;
alter table public.rental_lines enable row level security;

-- RLS: read for any org member with warehouse access; write gated by service-layer permissions
create policy rentals_select on rentals for select to authenticated
  using (
    public.user_can_access_warehouse(auth.uid(), warehouse_id, 'read')
  );

create policy rentals_write on rentals for all to authenticated
  using (public.user_can_access_warehouse(auth.uid(), warehouse_id, 'write'))
  with check (public.user_can_access_warehouse(auth.uid(), warehouse_id, 'write'));

create policy rental_lines_select on rental_lines for select to authenticated
  using (
    exists (
      select 1 from public.rentals r where r.id = rental_id
        and public.user_can_access_warehouse(auth.uid(), r.warehouse_id, 'read')
    )
  );

create policy rental_lines_write on rental_lines for all to authenticated
  using (
    exists (
      select 1 from public.rentals r where r.id = rental_id
        and public.user_can_access_warehouse(auth.uid(), r.warehouse_id, 'write')
    )
  );

grant select, insert, update, delete on rentals to authenticated;
grant select, insert, update, delete on rental_lines to authenticated;
```

## Stock impact (available-to-promise)

Rented-out lines reduce the available stock for ordering. Two implementation paths:

**Option A — write into `stock_reservations`** (the existing table that `/dashboard/orders/new` already subtracts from `quantity_on_hand`). On rental create: insert a stock_reservation row per line with `reference_type='rental'`, `reference_id=<rental_id>`. On rental return/cancel: set `released_at = now()` on those rows.

**Option B — extend the available-to-promise calculation to also subtract rented quantities.** Requires changing every read path that computes availability.

**Decision: Option A.** Reuses the proven reservation mechanism, no new math to thread through 12 surfaces. The reservations table already has `reference_type` and `reference_id` columns; rentals fit cleanly. Pickers, AI tools, reports, and the order-new picker all already subtract reservations.

## Lifecycle

```
[create] → status='out'  →  [return] → status='returned'
                          → [cancel] → status='cancelled'
```

- **Create** (staff+): pick warehouse, borrower (member OR typed name), items + qty, expected_return_at, optional notes. Action: insert rental + lines + reservations.
- **Return** (staff+): mark rental.status='returned', set returned_at, returned_by, optional return_notes. Action: release reservations.
- **Cancel** (manager+ only): never picked up. Same as return but status='cancelled' + cancellation_reason required. Releases reservations.
- **Edit lines** (manager+ only): add/remove items from an active rental. Mirrors line-add to a `stock_reservation` swap. Out of scope for v1 unless trivially fits — defer if it adds complexity.

Overdue is **derived**: any row with `status='out' AND expected_return_at < now()` is overdue. No state column; a sort/filter computes it. Avoids cron-job staleness.

## Permissions

Two new permission constants:
- `rentals:create` — granted to staff, manager, admin, owner. Required for creating rentals + marking returned.
- `rentals:manage` — granted to manager, admin, owner. Required for cancel + edit-lines + delete.

Viewer reads `rentals:read` (implicit — any org member with warehouse access can see the list via RLS).

## UI surface

New nav entry **"Rentals"** in the Inventory section of the dashboard sidebar (between Movements and Bundles, since it's a stock-flow concept).

### Pages

- `/dashboard/rentals` — list view: tabs for **Out** (default, badge with count) · **Overdue** (red badge) · **Returned** · **All**. Columns: borrower · items (1-line truncate) · checkout date · expected return · status pill. Search by borrower or item name. Per-row: View / Mark returned (staff+) / Cancel (manager+, only when status='out').
- `/dashboard/rentals/new` — create form: setup strip (warehouse, borrower, expected_return_at) + item picker (reuses ItemCard / CatalogGrid from orders v2) + line list + Notes + Submit.
- `/dashboard/rentals/[id]` — detail page: header (borrower, dates, status), lines table, audit timeline (created / returned / cancelled), actions panel (Mark returned · Cancel · Print rental slip — defer slip to follow-up).

### Components

Reuse `ItemCard`, `AisleBar`, `Toolbar`, `CatalogGrid`, `CartProvider`, `useCart` from `apps/web/src/components/orders/v2/` for the rental-create picker. Cart state is identical shape (line items + warehouse + notes); we just swap the submit endpoint.

New components:
- `RentalsListTable` (list page)
- `RentalCreateForm` (wraps the v2 picker + adds borrower/dates row)
- `RentalDetailHeader` + `RentalActionsPanel`
- `BorrowerPicker` — combobox: members from org_members AS suggestions, but free text always allowed. Same component reused on edit.

## Files to add

### DB
- `supabase/migrations/0131_rentals.sql` — tables + RLS + grants

### Server
- `apps/web/src/server/services/rentals.ts` — `RentalsService`: list / get / create / markReturned / cancel
- `apps/web/src/server/services/rentals.test.ts` — service tests
- `apps/web/src/server/actions/rentals.ts` — create / markReturned / cancel actions
- `packages/core/src/schemas/rentals.ts` — zod schemas
- `packages/core/src/constants/permissions.ts` — add `rentals:create`, `rentals:manage`
- `apps/web/src/server/services/audit.ts` — add `rental.created`, `rental.returned`, `rental.cancelled`

### Pages
- `apps/web/src/app/(dashboard)/dashboard/rentals/page.tsx` (list)
- `apps/web/src/app/(dashboard)/dashboard/rentals/new/page.tsx` (create form)
- `apps/web/src/app/(dashboard)/dashboard/rentals/[id]/page.tsx` (detail)

### Components
- `apps/web/src/components/rentals/rentals-list-table.tsx`
- `apps/web/src/components/rentals/rental-create-form.tsx`
- `apps/web/src/components/rentals/rental-detail-header.tsx`
- `apps/web/src/components/rentals/rental-actions-panel.tsx`
- `apps/web/src/components/rentals/borrower-picker.tsx`

### Modify
- `apps/web/src/components/dashboard/nav.ts` — add Rentals nav item
- `apps/web/src/server/services/inventory.ts` — `availableToPromise` already subtracts reservations; no change needed (reservation rows with `reference_type='rental'` are transparent to the existing math).

## Acceptance criteria

1. Staff member creates a rental from `/dashboard/rentals/new`, picks 3 items + a borrower + a return date 3 days from now → rental appears in the **Out** tab. Items show as reduced-availability on `/dashboard/orders/new`.
2. The list shows the borrower's name (with "(member)" suffix when linked) and a relative due date ("Due in 3 days" / "Overdue by 2 days").
3. Marking a rental returned moves it to **Returned** tab + releases reservations + items reappear as available on the order picker.
4. Cancelling (manager+) works the same as return but lands in **Cancelled** tab + requires a reason.
5. A viewer (read-only) can see the list but NO Create / Return / Cancel buttons appear for them.
6. The nav entry **"Rentals"** is visible to anyone with `rentals:create` (i.e. staff+).

## Edge cases

| Case | Behavior |
| --- | --- |
| Borrower is both a member AND types a different name | Member selection wins; the typed name field becomes read-only displaying the member's name. |
| Trying to rent more than `available` quantity | Form blocks at submit with toast "Not enough available — X already reserved." |
| Item is rented, then archived in inventory | Existing rental stays valid (FK references the row). Item just can't be added to NEW rentals. |
| Returning when the rental is already returned | Idempotent — service no-ops with "already returned" toast. |
| Bulk return: multiple rentals returned at once | v1 = one at a time. Bulk-return defer. |
| Borrower lookup search | Combobox: typing filters members by name + email; "Use as typed: '{input}'" always at the bottom for non-system names. |
| Rental crosses warehouse: items from W1 rented but viewer only has W2 | Warehouse-scope RLS hides it. Matches existing inventory behavior. |
| Expected return date in the past on create | Validation block: must be today or later. |

## Audit events

- `rental.created` — extra: `{ borrower, line_count, expected_return_at }`
- `rental.returned` — extra: `{ on_time: boolean, days_overdue?: number }`
- `rental.cancelled` — extra: `{ reason }`

## Realtime

The dashboard layout's `InventoryRealtime` subscription already covers `inventory_items` + `stock_movements`. Add `rentals` to the tables list so live updates propagate (someone marks something returned on mobile → list view refreshes on web within ~250ms).

## Out of scope (v1, defer to follow-ups)

- Rental slip PDF (printed receipt of what's out)
- Calendar/availability view
- Photo at checkout / return
- Bulk return
- Future-dated reservations (book a canopy for next Saturday)
- Recurring rentals
- SMS/email reminders for overdue items
- Borrower self-service ("see my rentals" page)
- Multi-warehouse rentals

These all build cleanly on top of the v1 schema.
