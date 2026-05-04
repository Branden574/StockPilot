-- 0019_putaway.sql
-- ─────────────────────────────────────────────────────────────────────
-- Putaway moves: log of items moving between bins within a warehouse.
-- Used by the warehouse-user putaway screen and the manager QA-release flow.
-- ─────────────────────────────────────────────────────────────────────

set check_function_bodies = off;

create table if not exists public.putaway_moves (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  warehouse_id    uuid not null references public.warehouses(id) on delete restrict,
  item_id         uuid not null references public.inventory_items(id) on delete restrict,
  from_bin_id     uuid not null references public.bins(id) on delete restrict,
  to_bin_id       uuid not null references public.bins(id) on delete restrict,
  qty_base        numeric(18,4) not null check (qty_base > 0),
  movement_type   text not null check (movement_type in (
    'putaway','qa_release','transfer','correction'
  )),
  performed_by    uuid not null references public.user_profiles(id) on delete restrict,
  notes           text,
  created_at      timestamptz not null default now()
);

create index if not exists putaway_moves_warehouse_idx
  on public.putaway_moves(warehouse_id, created_at desc);
create index if not exists putaway_moves_item_idx
  on public.putaway_moves(item_id, created_at desc);

alter table public.putaway_moves enable row level security;

drop policy if exists putaway_moves_select on public.putaway_moves;
create policy putaway_moves_select on public.putaway_moves
  for select using (
    exists (
      select 1 from public.organization_members m
      where m.user_id = auth.uid()
        and m.organization_id = putaway_moves.organization_id
        and m.accepted_at is not null
    )
  );

drop policy if exists putaway_moves_write on public.putaway_moves;
create policy putaway_moves_write on public.putaway_moves
  for all using (public.has_org_role(organization_id, 'manager'));

-- ─────────────────────────────────────────────────────────────────────
-- putaway_transfer — atomically move qty between two bins of the same
-- warehouse. Updates inventory_stock rows + appends a putaway_moves row.
-- inventory_items.quantity_on_hand is unchanged (it's a warehouse-total
-- and bin moves are intra-warehouse).
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.putaway_transfer(
  p_warehouse_id  uuid,
  p_item_id       uuid,
  p_from_bin_id   uuid,
  p_to_bin_id     uuid,
  p_qty           numeric,
  p_movement_type text default 'putaway',
  p_notes         text default null
)
returns public.putaway_moves
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_org   uuid;
  v_from  public.inventory_stock%rowtype;
  v_move  public.putaway_moves%rowtype;
begin
  if p_qty is null or p_qty <= 0 then
    raise exception 'invalid_qty' using errcode = '22023';
  end if;
  if p_from_bin_id = p_to_bin_id then
    raise exception 'same_bin' using errcode = '22023';
  end if;

  select organization_id into v_org from public.warehouses where id = p_warehouse_id;
  if v_org is null then raise exception 'warehouse_not_found' using errcode = 'P0002'; end if;

  if not public.has_org_role(v_org, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Lock the source row, ensure enough qty.
  select * into v_from from public.inventory_stock
   where warehouse_id = p_warehouse_id
     and bin_id = p_from_bin_id
     and item_id = p_item_id
   for update;
  if not found or v_from.qty_on_hand < p_qty then
    raise exception 'insufficient_stock' using errcode = '22023';
  end if;

  -- Decrement source.
  update public.inventory_stock
    set qty_on_hand = qty_on_hand - p_qty,
        version = version + 1
   where id = v_from.id;

  -- Increment destination (insert if missing).
  insert into public.inventory_stock(
    organization_id, warehouse_id, bin_id, item_id, qty_on_hand
  ) values (
    v_org, p_warehouse_id, p_to_bin_id, p_item_id, p_qty
  )
  on conflict (warehouse_id, bin_id, item_id)
  do update set qty_on_hand = public.inventory_stock.qty_on_hand + excluded.qty_on_hand,
                version = public.inventory_stock.version + 1;

  -- Log the move.
  insert into public.putaway_moves(
    organization_id, warehouse_id, item_id, from_bin_id, to_bin_id,
    qty_base, movement_type, performed_by, notes
  ) values (
    v_org, p_warehouse_id, p_item_id, p_from_bin_id, p_to_bin_id,
    p_qty, p_movement_type, auth.uid(), p_notes
  ) returning * into v_move;

  return v_move;
end$$;

grant execute on function public.putaway_transfer(uuid, uuid, uuid, uuid, numeric, text, text)
  to authenticated;
