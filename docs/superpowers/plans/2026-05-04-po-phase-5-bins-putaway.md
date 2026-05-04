# Phase 5 — Bins + Putaway + QA Hold Implementation Plan

> **For agentic workers:** Architecture-level. Expand each task to TDD step-by-step detail before execution.

**Goal:** Replace the current free-text `inventory_items.bin_location` with a first-class `bins` entity, support a two-step receive flow (receive into a "Receiving" bin → putaway to final bin), add an optional QA-hold workflow for items requiring inspection before becoming available, and expose stock by (item, bin) granularity.

**Architecture:**
- New `bins` table per warehouse. Bin types: `receiving | storage | qa_hold | damaged | rejected | shipping`.
- New `inventory_stock` table — pre-existing `inventory_items.quantity_on_hand` is the warehouse-total; `inventory_stock` is the per-bin breakdown. Both kept in sync transactionally (a `stock_movements` entry now also writes the per-bin delta).
- New `putaway_moves` table tracks "moved 5 units from receiving bin A to storage bin B". Phase 2 ledger pattern: append-only.
- Receiving form expands: pick a destination bin per receipt line. Default: warehouse's primary `receiving` bin.
- Putaway screen: list items currently in `receiving` bins, let warehouse user move to storage bins. Calls `transfer_stock` RPC (already exists from earlier migrations) with bin-aware deltas.
- QA hold: items flagged `requires_qa=true` (new column on inventory_items) land in a `qa_hold` bin on receive. Manager+ releases via a "QA release" action; this calls `transfer_stock` with a movement_type=`qa_release`.

**Tech Stack:** Same as Phases 1-4. Adds: bin selector UI primitive (combobox per warehouse).

---

## File structure

### New files

```
supabase/migrations/
  0018_bins.sql                   # bins + inventory_stock per-bin breakdown
  0019_putaway.sql                # putaway_moves + RPC putaway_transfer + qa_release_transfer

packages/core/src/schemas/
  bins.ts                         # createBinSchema, putawayMoveSchema, qaReleaseSchema

apps/web/src/server/services/
  bins.ts                         # BinsService: list, create, update, archive (warehouse-scoped)
  bins.test.ts
  putaway.ts                      # PutawayService: listPending, move, release (qa)
  putaway.test.ts

apps/web/src/server/actions/
  bins.ts
  putaway.ts

apps/web/src/components/bins/
  bin-picker.tsx                  # combobox; filters by warehouse + bin_type
  bins-manager.tsx                # admin CRUD per warehouse

apps/web/src/components/receiving/
  receipt-line-bin-row.tsx        # per-line bin selector with default = receiving bin

apps/web/src/components/putaway/
  putaway-list.tsx                # warehouse user view of receiving-bin stock
  putaway-move-dialog.tsx         # source bin → dest bin + qty form

apps/web/src/components/qa/
  qa-hold-list.tsx
  qa-release-dialog.tsx

apps/web/src/app/(dashboard)/dashboard/
  putaway/
    page.tsx                      # warehouse user dashboard
  qa/
    page.tsx                      # manager+ QA queue
  admin/
    bins/
      page.tsx                    # bins admin (per warehouse)
```

### Modified files

```
supabase/setup/full-schema.sql                                                # bundle 0018 + 0019
apps/web/src/server/services/audit.ts                                         # +stock.putaway, stock.qa_release, bin.created/updated/archived
apps/web/src/server/services/receiving.ts                                     # accept bin_id per line; default = warehouse receiving bin
apps/web/src/components/receiving/receipt-form.tsx                            # render BinPicker per line
apps/web/src/components/inventory/item-form.tsx                               # +requires_qa toggle (admin-only)
packages/core/src/schemas/inventory.ts                                        # +requiresQa boolean
apps/web/src/components/dashboard/nav.ts                                      # +Putaway, +QA, +Bins admin links
```

---

## Task list

### Task 1: Migration 0018 — `bins` + `inventory_stock`

```sql
create table if not exists public.bins (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  warehouse_id    uuid not null references public.warehouses(id) on delete cascade,
  code            text not null,
  name            text not null,
  bin_type        text not null check (bin_type in (
                    'receiving','storage','qa_hold','damaged','rejected','shipping')),
  is_default      boolean not null default false,  -- one default per (warehouse, bin_type)
  pick_sequence   integer,
  putaway_sequence integer,
  status          text not null default 'active'
                    check (status in ('active','inactive','archived')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (warehouse_id, code)
);
create unique index if not exists bins_default_per_type
  on public.bins(warehouse_id, bin_type)
  where is_default;

create table if not exists public.inventory_stock (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  warehouse_id    uuid not null references public.warehouses(id) on delete restrict,
  bin_id          uuid not null references public.bins(id) on delete restrict,
  item_id         uuid not null references public.inventory_items(id) on delete restrict,
  qty_on_hand     numeric(18,4) not null default 0 check (qty_on_hand >= 0),
  updated_at      timestamptz not null default now(),
  version         integer not null default 0,    -- optimistic lock
  unique (warehouse_id, bin_id, item_id)
);
create index if not exists inventory_stock_item_idx
  on public.inventory_stock(item_id, warehouse_id);
```

Add a default `Receiving` bin auto-created for each existing warehouse (data migration).

```sql
do $$
declare
  w record;
begin
  for w in select id, organization_id from public.warehouses where status <> 'archived' loop
    insert into public.bins(organization_id, warehouse_id, code, name, bin_type, is_default)
    values (w.organization_id, w.id, 'RECEIVING', 'Receiving Dock', 'receiving', true)
    on conflict do nothing;
  end loop;
end$$;
```

### Task 2: Migration 0019 — putaway_moves + RPCs

```sql
create table if not exists public.putaway_moves (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  warehouse_id    uuid not null references public.warehouses(id) on delete restrict,
  item_id         uuid not null references public.inventory_items(id) on delete restrict,
  from_bin_id     uuid not null references public.bins(id) on delete restrict,
  to_bin_id       uuid not null references public.bins(id) on delete restrict,
  qty_base        numeric(18,4) not null check (qty_base > 0),
  movement_type   text not null check (movement_type in ('putaway','qa_release','transfer','correction')),
  performed_by    uuid not null references public.user_profiles(id),
  notes           text,
  created_at      timestamptz not null default now()
);
```

RPC `putaway_transfer(p_warehouse uuid, p_item uuid, p_from_bin uuid, p_to_bin uuid, p_qty numeric, p_movement_type text, p_notes text)` — does both `inventory_stock` updates atomically with optimistic-lock retry.

### Task 3: `BinsService` + admin UI

Standard CRUD scoped per warehouse. Admin → Bins page renders a tab per warehouse with a table of bins and a "New bin" dialog.

### Task 4: Receive into bin

Modify the receiving form (Phase 2 work) to include a per-line `BinPicker`. Default: warehouse's primary `receiving` bin. If item has `requires_qa=true`, force default to `qa_hold` bin (warning shown).

`post_receipt_v2` RPC extended:
- For each line, additionally insert/update an `inventory_stock` row at `(warehouse, bin, item)` += qty_accepted.
- Validate bin_type matches what we expect (receiving or qa_hold for first landing).

### Task 5: Putaway page

`/dashboard/putaway` (warehouse user can access for their own warehouses):
- Table grouped by warehouse: items currently in any bin where `bin_type='receiving'`
- Per row: item, current bin, qty in receiving, "Move" button → opens dialog
- Dialog: pick destination bin (`storage` types only), qty (≤ current), submit
- Server action calls `putaway_transfer` RPC with `movement_type='putaway'`
- On success: stock is now in storage bin; item shows up in inventory list as available

### Task 6: QA hold workflow

If `inventory_items.requires_qa=true`, receiving lands the stock in `qa_hold` instead of `receiving`. The QA queue at `/dashboard/qa` (manager+) shows items in `qa_hold` bins org-wide with:
- "Release to storage" → calls `putaway_transfer` with `movement_type='qa_release'`, dest = warehouse's primary storage bin
- "Reject" → `putaway_transfer` to `rejected` bin

### Task 7: Inventory list — show by-bin breakdown

Inventory detail page already exists. Add a "Stock by bin" section that queries `inventory_stock` for the item across all warehouses the user can access.

### Task 8: Tests

1. Creating a warehouse auto-creates a `Receiving` bin marked `is_default`
2. Receiving without specifying a bin lands in the warehouse's default receiving bin
3. `inventory_stock` row gets the increment in addition to `inventory_items.quantity_on_hand`
4. Putaway from receiving → storage decrements receiving bin and increments storage bin (sum across bins == `inventory_items.quantity_on_hand`)
5. Item with `requires_qa=true` lands in `qa_hold` automatically
6. QA release moves stock to default storage bin + audits `stock.qa_release`
7. Warehouse user cannot move stock between two bins in a different warehouse (403)
8. Optimistic-lock retry: two concurrent putaway calls don't lose a unit

### Task 9: Done criteria

- [ ] Migrations 0018 + 0019 applied
- [ ] Existing warehouses each got a `Receiving` bin
- [ ] Receiving the AA batteries from Staples lands them in the warehouse's receiving bin
- [ ] Putaway moves them to a storage bin; inventory total unchanged, breakdown shifts
- [ ] An item flagged `requires_qa` lands in `qa_hold`; can only be released by manager+
- [ ] Inventory detail page shows stock-by-bin breakdown for items with multi-bin presence
