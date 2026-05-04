-- 0012_receipts.sql
-- ─────────────────────────────────────────────────────────────────────
-- First-class receipts model. A purchase_order may have N receipts over
-- time; this is what supports partial receiving + reversal cleanly.
--
-- Replaces the old single-shot receive_purchase_order RPC with
-- post_receipt_v2, which is idempotency-aware (see migration 0013) and
-- breaks down received qty into accepted vs rejected so damaged stock
-- never becomes available inventory.
-- ─────────────────────────────────────────────────────────────────────

set check_function_bodies = off;

-- ─────────────────────────────────────────────────────────────────────
-- receipts (header)
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.receipts (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  purchase_order_id   uuid not null references public.purchase_orders(id) on delete restrict,
  warehouse_id        uuid not null references public.warehouses(id) on delete restrict,
  receipt_number      text not null,
  status              text not null default 'posted'
                        check (status in ('draft','posted','reversed','reversal','canceled')),
  reversed_receipt_id uuid references public.receipts(id) on delete restrict,
  reversal_reason     text,
  notes               text,
  received_by         uuid not null references public.user_profiles(id) on delete restrict,
  received_at         timestamptz not null default now(),
  idempotency_key     text,
  immutable_hash      text not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (organization_id, receipt_number)
);

create index if not exists receipts_po_idx
  on public.receipts(purchase_order_id, received_at desc);
create index if not exists receipts_warehouse_idx
  on public.receipts(warehouse_id, received_at desc);

create trigger receipts_updated_at
  before update on public.receipts
  for each row execute function public.tg_set_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- receipt_lines
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.receipt_lines (
  id                       uuid primary key default gen_random_uuid(),
  receipt_id               uuid not null references public.receipts(id) on delete cascade,
  purchase_order_line_id   uuid not null references public.purchase_order_items(id) on delete restrict,
  item_id                  uuid not null references public.inventory_items(id) on delete restrict,
  qty_received_base        numeric(18,4) not null check (qty_received_base >= 0),
  qty_accepted_base        numeric(18,4) not null check (qty_accepted_base >= 0),
  qty_rejected_base        numeric(18,4) not null default 0 check (qty_rejected_base >= 0),
  base_uom                 text not null default 'EA',
  unit_cost                numeric(18,4) not null default 0,
  notes                    text,
  created_at               timestamptz not null default now(),
  -- accepted + rejected must equal received (1bp tolerance for float drift)
  check (qty_accepted_base + qty_rejected_base <= qty_received_base + 0.0001)
);

create index if not exists receipt_lines_receipt_idx
  on public.receipt_lines(receipt_id);
create index if not exists receipt_lines_po_line_idx
  on public.receipt_lines(purchase_order_line_id);

-- ─────────────────────────────────────────────────────────────────────
-- RLS — same access shape as purchase_orders
-- ─────────────────────────────────────────────────────────────────────
alter table public.receipts enable row level security;
alter table public.receipt_lines enable row level security;

drop policy if exists receipts_select on public.receipts;
create policy receipts_select on public.receipts
  for select using (
    exists (
      select 1 from public.organization_members m
      where m.user_id = auth.uid()
        and m.organization_id = receipts.organization_id
        and m.accepted_at is not null
    )
  );

drop policy if exists receipts_write on public.receipts;
create policy receipts_write on public.receipts
  for all using (public.has_org_role(organization_id, 'manager'));

drop policy if exists receipt_lines_select on public.receipt_lines;
create policy receipt_lines_select on public.receipt_lines
  for select using (
    exists (
      select 1 from public.receipts r
      where r.id = receipt_lines.receipt_id
        and exists (
          select 1 from public.organization_members m
          where m.user_id = auth.uid()
            and m.organization_id = r.organization_id
            and m.accepted_at is not null
        )
    )
  );

drop policy if exists receipt_lines_write on public.receipt_lines;
create policy receipt_lines_write on public.receipt_lines
  for all using (
    exists (
      select 1 from public.receipts r
      where r.id = receipt_lines.receipt_id
        and public.has_org_role(r.organization_id, 'manager')
    )
  );

-- ─────────────────────────────────────────────────────────────────────
-- recompute_po_status — idempotent helper to roll a PO's status forward
-- after receipt activity. partially_received when any line short of
-- ordered, received when all lines fully received.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.recompute_po_status(p_po_id uuid)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_total_ordered  numeric;
  v_total_received numeric;
  v_status         text;
begin
  select coalesce(sum(quantity_ordered), 0),
         coalesce(sum(quantity_received), 0)
    into v_total_ordered, v_total_received
    from public.purchase_order_items
    where purchase_order_id = p_po_id;

  if v_total_received <= 0 then
    -- No receipts yet — leave whatever the PO is currently in.
    select status into v_status from public.purchase_orders where id = p_po_id;
    return v_status;
  elsif v_total_received >= v_total_ordered then
    update public.purchase_orders
      set status = 'received', received_at = coalesce(received_at, now())
      where id = p_po_id;
    return 'received';
  else
    update public.purchase_orders
      set status = 'partially_received'
      where id = p_po_id and status not in ('cancelled');
    return 'partially_received';
  end if;
end$$;

grant execute on function public.recompute_po_status(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- Drop the old single-shot RPC. The new flow is service-driven and uses
-- the post_receipt_v2 RPC (introduced after idempotency_keys lands in 0013).
-- ─────────────────────────────────────────────────────────────────────
drop function if exists public.receive_purchase_order(uuid, jsonb, text);
