-- 0023_cycle_counts.sql
-- ============================================================================
-- CYCLE COUNTS — periodic recount of physical stock against the system.
-- A count session snapshots expected quantities for a set of items, the
-- counter records actual qtys, and approving the session posts adjustments
-- for every variance into stock_movements (movement_type='adjust') so
-- inventory_items.quantity_on_hand matches what was counted.
-- ============================================================================

create table if not exists public.cycle_counts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  warehouse_id    uuid references public.warehouses(id) on delete set null,
  status          text not null default 'in_progress' check (status in (
                    'in_progress','completed','canceled')),
  notes           text,
  started_by      uuid references public.user_profiles(id) on delete set null,
  started_at      timestamptz not null default now(),
  completed_by    uuid references public.user_profiles(id) on delete set null,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists cycle_counts_org_status_idx
  on public.cycle_counts(organization_id, status, started_at desc);
create trigger cycle_counts_updated_at
  before update on public.cycle_counts
  for each row execute function public.tg_set_updated_at();

create table if not exists public.cycle_count_lines (
  id                  uuid primary key default gen_random_uuid(),
  cycle_count_id      uuid not null references public.cycle_counts(id) on delete cascade,
  item_id             uuid not null references public.inventory_items(id) on delete cascade,
  -- Snapshot of inventory_items.quantity_on_hand at the moment the count
  -- session started. Doesn't change after that — drives variance math.
  expected_quantity   numeric(14,4) not null,
  -- Null until the counter records a number. variance only makes sense
  -- once counted_quantity is set.
  counted_quantity    numeric(14,4),
  reason              text,
  notes               text,
  counted_by          uuid references public.user_profiles(id) on delete set null,
  counted_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (cycle_count_id, item_id)
);
create index if not exists cycle_count_lines_cc_idx
  on public.cycle_count_lines(cycle_count_id);
create trigger cycle_count_lines_updated_at
  before update on public.cycle_count_lines
  for each row execute function public.tg_set_updated_at();

-- ============================================================================
-- RLS: managers+ can write, any org member can read.
-- ============================================================================
alter table public.cycle_counts        enable row level security;
alter table public.cycle_count_lines   enable row level security;

drop policy if exists cycle_counts_select on public.cycle_counts;
create policy cycle_counts_select on public.cycle_counts
  for select using (public.is_org_member(organization_id));

drop policy if exists cycle_counts_insert on public.cycle_counts;
create policy cycle_counts_insert on public.cycle_counts
  for insert with check (public.has_org_role(organization_id, 'manager'));

drop policy if exists cycle_counts_update on public.cycle_counts;
create policy cycle_counts_update on public.cycle_counts
  for update
  using (public.has_org_role(organization_id, 'manager'))
  with check (public.has_org_role(organization_id, 'manager'));

drop policy if exists cycle_count_lines_select on public.cycle_count_lines;
create policy cycle_count_lines_select on public.cycle_count_lines
  for select using (
    exists (
      select 1 from public.cycle_counts cc
      where cc.id = cycle_count_lines.cycle_count_id
        and public.is_org_member(cc.organization_id)
    )
  );

drop policy if exists cycle_count_lines_write on public.cycle_count_lines;
create policy cycle_count_lines_write on public.cycle_count_lines
  for all using (
    exists (
      select 1 from public.cycle_counts cc
      where cc.id = cycle_count_lines.cycle_count_id
        and public.has_org_role(cc.organization_id, 'manager')
    )
  ) with check (
    exists (
      select 1 from public.cycle_counts cc
      where cc.id = cycle_count_lines.cycle_count_id
        and public.has_org_role(cc.organization_id, 'manager')
    )
  );

-- ============================================================================
-- post_cycle_count: atomically applies counted_quantity to every line that
-- has been counted (counted_quantity IS NOT NULL), inserts adjust-type
-- stock_movements for the variance, sets quantity_on_hand to match the
-- count, and flips the session to 'completed'.
-- ============================================================================
create or replace function public.post_cycle_count(p_cycle_count_id uuid)
returns public.cycle_counts
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_cc      public.cycle_counts%rowtype;
  v_line    record;
  v_prev    numeric(14,4);
  v_diff    numeric(14,4);
begin
  select * into v_cc from public.cycle_counts where id = p_cycle_count_id for update;
  if not found then raise exception 'cycle_count_not_found' using errcode = 'P0002'; end if;
  if v_cc.status <> 'in_progress' then
    raise exception 'cycle_count_not_open' using errcode = '22023';
  end if;
  if not public.has_org_role(v_cc.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  for v_line in
    select * from public.cycle_count_lines
    where cycle_count_id = p_cycle_count_id
      and counted_quantity is not null
  loop
    -- Lock the item row, read prev qty, compute variance.
    select quantity_on_hand into v_prev
      from public.inventory_items
      where id = v_line.item_id
      for update;
    if not found then continue; end if;

    v_diff := v_line.counted_quantity - v_prev;
    if v_diff = 0 then continue; end if;

    insert into public.stock_movements(
      organization_id, item_id, movement_type,
      quantity_change, previous_quantity, new_quantity,
      reason, notes, user_id
    ) values (
      v_cc.organization_id, v_line.item_id, 'adjust',
      v_diff, v_prev, v_line.counted_quantity,
      coalesce(v_line.reason, 'Cycle count adjustment'),
      v_line.notes,
      auth.uid()
    );

    update public.inventory_items
      set quantity_on_hand = v_line.counted_quantity,
          updated_by = auth.uid()
      where id = v_line.item_id;
  end loop;

  update public.cycle_counts
    set status = 'completed',
        completed_at = now(),
        completed_by = auth.uid()
    where id = p_cycle_count_id
    returning * into v_cc;

  return v_cc;
end;
$$;

grant execute on function public.post_cycle_count(uuid) to authenticated;
