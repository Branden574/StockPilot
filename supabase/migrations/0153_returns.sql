-- ============================================================================
-- 0153_returns.sql — Returns/RMA foundation (Phase A).
--
-- Adds the RMA header + line tables and the disposition RPC that pushes
-- inventory back (restock) or writes it off (scrap) when a return is received.
--
-- Inventory correctness is paramount:
--   • NEVER restock more than was fulfilled — the service layer validates
--     quantity <= order_request_lines.quantity_fulfilled at create time; this
--     migration enforces quantity > 0 and a per-line uniqueness constraint so a
--     line can't be doubled up inside one return.
--   • NEVER apply a disposition twice — return_lines.applied is a one-way latch
--     flipped inside process_return_disposition; the RPC skips already-applied
--     lines, so re-running it (idempotent) is a no-op for settled lines.
--
-- Stock semantics (confirmed seam):
--   RESTOCK = +quantity, movement_type 'return'
--   SCRAP   = -quantity, movement_type 'loss'
--   Every movement is stamped reference_type='return', reference_id=<return id>.
--
-- process_return_disposition mirrors cancel_order_request (0137): SECURITY
-- DEFINER, locks the header row, loops lines in a stable order, performs the
-- atomic on-hand change + ledger write inline (so it can stamp the reference
-- columns — adjust_stock takes no reference args), and is callable by any
-- authenticated user whose org-role passes the in-function manager check. The
-- service layer additionally gates on the 'returns' module + 'returns:manage'
-- permission.
--
-- search_path = public, extensions: the inline stock write lives in the same
-- transaction as the rest of the order/inventory RPCs which rely on pgcrypto in
-- `extensions` (same trap called out in 0022 / 0134 / 0137).
--
-- RLS / convention re-use (verbatim from 0146):
--   is_org_member(org_id) / has_org_role(org_id, min_role) wrapped in (SELECT …)
--   per the InitPlan convention (0140); `drop policy if exists` idempotency
--   guard (0144); tg_set_updated_at trigger (0001). return_lines carries its own
--   organization_id so it is gated directly, same as the header.
--
-- The 'returns' module is grandfathered OFF for every existing org (mirrors the
-- 0147 'integrations' seed): brand-new functionality, explicit opt-in.
-- ============================================================================

-- 1. returns — RMA header. ---------------------------------------------------
create table if not exists public.returns (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  order_request_id  uuid not null references public.order_requests(id) on delete cascade,
  return_number     text,
  status            text not null default 'requested'
                      check (status in ('requested','approved','received','closed','denied','cancelled')),
  source            text not null default 'internal'
                      check (source in ('internal','requester')),
  reason_code       text
                      check (reason_code in ('damaged','wrong_item','end_of_year','overage','other')),
  notes             text,
  requested_by      uuid references public.user_profiles(id),
  requester_email   citext,
  requester_name    text,
  approved_by       uuid references public.user_profiles(id),
  approved_at       timestamptz,
  received_by       uuid references public.user_profiles(id),
  received_at       timestamptz,
  closed_by         uuid references public.user_profiles(id),
  closed_at         timestamptz,
  denied_by         uuid references public.user_profiles(id),
  denied_at         timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists returns_org_order_idx
  on public.returns (organization_id, order_request_id);
create index if not exists returns_org_status_idx
  on public.returns (organization_id, status);

drop trigger if exists returns_set_updated_at on public.returns;
create trigger returns_set_updated_at
  before update on public.returns
  for each row execute function public.tg_set_updated_at();

-- 2. return_lines — one per returned order line. -----------------------------
-- Carries organization_id so RLS gates it directly (same as the header) rather
-- than joining through the parent return.
create table if not exists public.return_lines (
  id                    uuid primary key default gen_random_uuid(),
  return_id             uuid not null references public.returns(id) on delete cascade,
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  order_request_line_id uuid not null references public.order_request_lines(id),
  item_id               uuid not null references public.inventory_items(id),
  quantity              numeric not null check (quantity > 0),
  disposition           text not null check (disposition in ('restock','scrap')),
  applied               boolean not null default false,
  created_at            timestamptz not null default now(),
  unique (return_id, order_request_line_id)
);

create index if not exists return_lines_return_idx
  on public.return_lines (return_id);

-- RLS -----------------------------------------------------------------------
alter table public.returns      enable row level security;
alter table public.return_lines enable row level security;

-- returns: member read, manager write.
drop policy if exists returns_select on public.returns;
create policy returns_select on public.returns
  for select to authenticated using ((select public.is_org_member(organization_id)));

drop policy if exists returns_write on public.returns;
create policy returns_write on public.returns
  for all to authenticated
  using ((select public.has_org_role(organization_id, 'manager')))
  with check ((select public.has_org_role(organization_id, 'manager')));

-- return_lines: member read, manager write (gated by its own organization_id).
drop policy if exists return_lines_select on public.return_lines;
create policy return_lines_select on public.return_lines
  for select to authenticated using ((select public.is_org_member(organization_id)));

drop policy if exists return_lines_write on public.return_lines;
create policy return_lines_write on public.return_lines
  for all to authenticated
  using ((select public.has_org_role(organization_id, 'manager')))
  with check ((select public.has_org_role(organization_id, 'manager')));

grant select, insert, update, delete on public.returns      to authenticated;
grant select, insert, update, delete on public.return_lines to authenticated;

-- 3. process_return_disposition — apply restock/scrap per line. --------------
-- Mirrors cancel_order_request (0137): lock the header, authorize against the
-- header org, loop unapplied lines in a stable order, mutate inventory + ledger
-- inline (stamping the reference columns adjust_stock can't), latch applied.
-- Idempotent: already-applied lines are skipped, so a re-run is a no-op.
create or replace function public.process_return_disposition(p_return_id uuid)
returns public.returns
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_return  public.returns%rowtype;
  v_user    uuid := auth.uid();
  v_line    record;
  v_item    public.inventory_items%rowtype;
  v_prev    numeric;
  v_new     numeric;
  v_delta   numeric;
  v_movement text;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  -- Lock the header so concurrent receive/close calls on the same return
  -- serialize; the applied latch on each line is the per-line guard.
  select * into v_return from public.returns where id = p_return_id for update;
  if not found then
    raise exception 'return_not_found' using errcode = 'P0002';
  end if;

  if not public.has_org_role(v_return.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- order by item_id keeps the per-item row-lock order stable across concurrent
  -- calls touching the same item (matches complete_picking / cancel_order_request).
  for v_line in
    select rl.id as line_id, rl.item_id, rl.quantity, rl.disposition
    from public.return_lines rl
    where rl.return_id = p_return_id
      and rl.applied = false
    order by rl.item_id
  loop
    -- RESTOCK = +qty 'return'; SCRAP = -qty 'loss'.
    if v_line.disposition = 'restock' then
      v_delta    := v_line.quantity;
      v_movement := 'return';
    else
      v_delta    := -v_line.quantity;
      v_movement := 'loss';
    end if;

    -- Atomic on-hand change (mirrors adjust_stock's body so we can also stamp
    -- reference_type/reference_id on the ledger row).
    select * into v_item
    from public.inventory_items
    where id = v_line.item_id
    for update;
    if not found then
      raise exception 'item_not_found' using errcode = 'P0002';
    end if;

    -- Defence in depth: the line's item must belong to the return's org.
    if v_item.organization_id <> v_return.organization_id then
      raise exception 'cross_org_item' using errcode = '42501';
    end if;

    v_prev := v_item.quantity_on_hand;
    v_new  := v_prev + v_delta;
    if v_new < 0 then
      raise exception 'insufficient_stock' using errcode = 'P0001';
    end if;

    update public.inventory_items
      set quantity_on_hand = v_new,
          updated_at       = now(),
          updated_by       = v_user
    where id = v_line.item_id;

    insert into public.stock_movements (
      organization_id, item_id, movement_type,
      quantity_change, previous_quantity, new_quantity,
      reason, reference_type, reference_id, user_id
    ) values (
      v_return.organization_id, v_line.item_id, v_movement,
      v_delta, v_prev, v_new,
      'Return ' || v_line.disposition || ' (return ' || p_return_id::text || ')',
      'return', p_return_id, v_user
    );

    -- One-way latch: never apply a disposition twice.
    update public.return_lines
      set applied = true
      where id = v_line.line_id;
  end loop;

  select * into v_return from public.returns where id = p_return_id;
  return v_return;
end;
$$;

-- The in-function manager check is the real gate (mirrors cancel_order_request,
-- granted to authenticated). Defensively strip the implicit PUBLIC grant + anon
-- per the SECURITY DEFINER hardening convention (0146).
revoke all on function public.process_return_disposition(uuid) from public, anon;
grant execute on function public.process_return_disposition(uuid) to authenticated;

-- 4. Grandfather: 'returns' module OFF for every existing org (mirrors 0147). -
insert into public.organization_modules (organization_id, module_id, enabled, tier, enabled_at)
select o.id, 'returns', false, 'optional', now()
from public.organizations o
on conflict (organization_id, module_id) do nothing;
