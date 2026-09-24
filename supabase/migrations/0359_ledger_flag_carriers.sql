-- 0359_ledger_flag_carriers.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Stock-ledger lockdown, part 1 of 2 ("prepare"). Everything here is safe to
-- apply BEFORE the matching web deploy: no path the app uses today changes
-- behaviour. The enforcement that does depend on the deploy (the
-- quantity_on_hand rule on inventory_items and the item_stock_levels guard)
-- ships in a later migration, after the deploy is verified.
--
-- THE PROBLEM. A signed-in user can write the stock ledger's tables straight
-- through PostgREST and skip every rule the stock RPCs enforce:
--   * inventory_items: staff UPDATE quantity_on_hand, unit_cost, charter_id,
--     warehouse_id with no guard (the item-edit form is the only thing that
--     checks items:update, the cost floor or warehouse scope);
--   * item_stock_levels, receipts, receipt_lines, receipt_line_lots: FOR ALL
--     for staff, so a posted receipt can be edited, flipped to 'reversed' or
--     deleted, and holdings can be minted;
--   * apply_level_delta / apply_cycle_count_location_delta: SECURITY DEFINER
--     helpers with EXECUTE for authenticated, callable directly to move
--     holdings with no movement row.
--
-- THE MECHANISM: a transaction-local flag, stockpilot.ledger = 'on', raised
-- ONLY by the eight ledger RPCs for the duration of their own body. Guards
-- (triggers on the tables, a check inside the SECDEF helpers) refuse ledger
-- writes by the API roles when the flag is not on.
--
-- WHY WRAPPERS, NOT A SET CLAUSE. `ALTER FUNCTION ... SET stockpilot.ledger =
-- 'on'` would be the idiomatic carrier (restored by Postgres on every exit),
-- but Supabase's postgres role is not a superuser and Postgres refuses a
-- custom placeholder in a function SET clause ("permission denied to set
-- parameter"). So each ledger function moves, unchanged, into the private
-- `ledger` schema, and a thin wrapper with the IDENTICAL name, signature,
-- defaults, return type, SECURITY mode and grants takes its place in public:
--
--     v_prev := current_setting('stockpilot.ledger', true);
--     perform set_config('stockpilot.ledger', 'on', true);
--     <call ledger.<same name>(...)>
--     perform set_config('stockpilot.ledger', coalesce(v_prev, ''), true);
--
-- Properties, each covered by 0359's pgTAP file:
--   * Nests: post_receipt_v2 (on) calls adjust_stock (on) and is still on after
--     it returns, because the inner wrapper restores the value it found.
--   * Never leaks past the call: the flag is back to its previous value
--     before the wrapper returns, so the rest of the same PostgREST statement
--     (embeds, computed columns) and later statements in the transaction run
--     without it.
--   * On an error nothing is restored by the wrapper, and nothing needs to be:
--     a caught error rolls back the subtransaction, which reverts set_config
--     (verified), and an uncaught one aborts the transaction.
--   * Cannot be forged: PostgREST exposes neither pg_catalog.set_config nor
--     the `ledger` schema, authenticated and anon are NOLOGIN, and no
--     exposed function passes caller text to set_config (pgTAP census).
--
-- INSTALLED PHONES. The only direct stock call any installed mobile build
-- makes is supabase.rpc('adjust_stock', {7 named args}) from item/[id].tsx.
-- Its wrapper keeps the exact name, argument names, defaults, return type,
-- SECURITY INVOKER and EXECUTE grant, so it keeps working unchanged. Bundles
-- older than #185 also call post_receipt_v2 and post_cycle_count directly;
-- same guarantee.
--
-- WHY THE IMPLEMENTATIONS MOVE SCHEMA, NOT JUST NAME. A renamed function left
-- in public would still be callable at /rest/v1/rpc/<name>, and it would run
-- without the flag. The guards refuse that, but only once the enforcement
-- migration lands; until then the old body would be reachable unflagged. The
-- `ledger` schema is not in PostgREST's exposed schemas, so the bodies are not
-- reachable at all. authenticated keeps USAGE on it and EXECUTE on the bodies,
-- because the wrappers are SECURITY INVOKER and call them as the user.
--
-- Sections:
--   1. The `ledger` schema and the shared guard trigger function.
--   2. The eight ledger RPCs: move the body, add the wrapper.
--   3. The SECDEF helpers refuse direct calls without the flag.
--   4. receipts, receipt_lines, receipt_line_lots: ledger-only.
--   5. recompute_po_status: count only the PO's own org's lines; no anon.
--   6. inventory_items: organization_id immutable; cost, charter and
--      warehouse edits held to the item-edit rules.
--   7. compensate_opening_stock: the failed-create rollback, as one SECDEF call.
--   8. Grant hygiene on the five tables.

-- ── 1. Schema and shared guard ──────────────────────────────────────────────

create schema if not exists ledger;
revoke all on schema ledger from public;
grant usage on schema ledger to authenticated, service_role;
comment on schema ledger is
  'Stock-ledger RPC bodies (0359). NOT exposed through PostgREST: the public '
  'wrappers of the same name raise stockpilot.ledger and call these.';

create or replace function public.tg_ledger_only_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Only the API roles are held to the ledger. SECURITY DEFINER bodies run as
  -- postgres, service_role is the server's own client, and FK referential
  -- actions run as the table owner, so none of them is 'authenticated' or
  -- 'anon' here. Never key this on auth.uid() or JWT claims: a SECDEF body
  -- and a cascade still carry the caller's JWT.
  if current_user in ('authenticated', 'anon')
     and coalesce(current_setting('stockpilot.ledger', true), '') <> 'on' then
    raise exception 'ledger_only'
      using errcode = '42501',
            detail = format('%s rows change only through the stock ledger RPCs.', tg_table_name),
            hint = 'Post or reverse a receipt, adjust, transfer or count instead of writing the table.';
  end if;
  return coalesce(new, old);
end;
$$;

comment on function public.tg_ledger_only_guard() is
  'BEFORE row guard (0359): API-role writes need stockpilot.ledger = ''on'', '
  'which only the ledger RPC wrappers raise. SECURITY INVOKER on purpose: a '
  'DEFINER trigger always sees postgres and would never enforce.';

revoke all on function public.tg_ledger_only_guard() from public, anon, authenticated;

-- ── 2. The eight ledger RPCs ────────────────────────────────────────────────
-- Each: move the body into `ledger` (ALTER ... SET SCHEMA keeps its OID,
-- owner, grants, config and comment), then create the public wrapper.

-- adjust_stock ---------------------------------------------------------------
alter function public.adjust_stock(uuid, numeric, text, uuid, text, text, text)
  set schema ledger;

create function public.adjust_stock(
  p_item_id uuid,
  p_quantity_change numeric,
  p_movement_type text,
  p_location_id uuid default null,
  p_reason text default null,
  p_notes text default null,
  p_mode text default 'placed'
)
returns public.inventory_items
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_prev text := current_setting('stockpilot.ledger', true);
  v_row  public.inventory_items;
begin
  perform set_config('stockpilot.ledger', 'on', true);
  v_row := ledger.adjust_stock(
    p_item_id, p_quantity_change, p_movement_type, p_location_id, p_reason, p_notes, p_mode);
  perform set_config('stockpilot.ledger', coalesce(v_prev, ''), true);
  return v_row;
end;
$$;

-- transfer_stock -------------------------------------------------------------
alter function public.transfer_stock(uuid, uuid, uuid, numeric, text)
  set schema ledger;

create function public.transfer_stock(
  p_item_id uuid,
  p_from_location_id uuid,
  p_to_location_id uuid,
  p_quantity numeric,
  p_notes text default null
)
returns public.inventory_items
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_prev text := current_setting('stockpilot.ledger', true);
  v_row  public.inventory_items;
begin
  perform set_config('stockpilot.ledger', 'on', true);
  v_row := ledger.transfer_stock(
    p_item_id, p_from_location_id, p_to_location_id, p_quantity, p_notes);
  perform set_config('stockpilot.ledger', coalesce(v_prev, ''), true);
  return v_row;
end;
$$;

-- post_cycle_count -----------------------------------------------------------
alter function public.post_cycle_count(uuid)
  set schema ledger;

create function public.post_cycle_count(p_cycle_count_id uuid)
returns public.cycle_counts
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_prev text := current_setting('stockpilot.ledger', true);
  v_row  public.cycle_counts;
begin
  perform set_config('stockpilot.ledger', 'on', true);
  v_row := ledger.post_cycle_count(p_cycle_count_id);
  perform set_config('stockpilot.ledger', coalesce(v_prev, ''), true);
  return v_row;
end;
$$;

-- assemble_bundle ------------------------------------------------------------
alter function public.assemble_bundle(uuid, numeric, uuid, text)
  set schema ledger;

create function public.assemble_bundle(
  p_bundle_id uuid,
  p_quantity numeric,
  p_warehouse_id uuid,
  p_notes text default null
)
returns table(phantom_item_id uuid, phantom_qty numeric)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_prev text := current_setting('stockpilot.ledger', true);
begin
  perform set_config('stockpilot.ledger', 'on', true);
  -- RETURN QUERY runs the body to completion before the next line, so the
  -- flag is restored only after every write inside it has happened.
  return query
    select b.phantom_item_id, b.phantom_qty
      from ledger.assemble_bundle(p_bundle_id, p_quantity, p_warehouse_id, p_notes) b;
  perform set_config('stockpilot.ledger', coalesce(v_prev, ''), true);
  return;
end;
$$;

-- distribute_bundle ----------------------------------------------------------
alter function public.distribute_bundle(uuid, numeric, uuid, boolean, uuid, text, text)
  set schema ledger;

create function public.distribute_bundle(
  p_bundle_id uuid,
  p_quantity numeric,
  p_warehouse_id uuid,
  p_allow_shortage boolean,
  p_schedule_event_id uuid default null,
  p_notes text default null,
  p_idempotency_key text default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_prev text := current_setting('stockpilot.ledger', true);
  v_id   uuid;
begin
  perform set_config('stockpilot.ledger', 'on', true);
  v_id := ledger.distribute_bundle(
    p_bundle_id, p_quantity, p_warehouse_id, p_allow_shortage,
    p_schedule_event_id, p_notes, p_idempotency_key);
  perform set_config('stockpilot.ledger', coalesce(v_prev, ''), true);
  return v_id;
end;
$$;

-- process_return_disposition (the body is SECURITY DEFINER; the wrapper is
-- INVOKER, so calling through it is exactly calling the body directly) -------
alter function public.process_return_disposition(uuid)
  set schema ledger;

create function public.process_return_disposition(p_return_id uuid)
returns public.returns
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_prev text := current_setting('stockpilot.ledger', true);
  v_row  public.returns;
begin
  perform set_config('stockpilot.ledger', 'on', true);
  v_row := ledger.process_return_disposition(p_return_id);
  perform set_config('stockpilot.ledger', coalesce(v_prev, ''), true);
  return v_row;
end;
$$;

-- post_receipt_v2 ------------------------------------------------------------
alter function public.post_receipt_v2(uuid, uuid, jsonb, text, text, text)
  set schema ledger;

create function public.post_receipt_v2(
  p_purchase_order_id uuid,
  p_warehouse_id uuid,
  p_lines jsonb,
  p_idempotency_key text,
  p_request_hash text,
  p_notes text default null
)
returns public.receipts
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_prev text := current_setting('stockpilot.ledger', true);
  v_row  public.receipts;
begin
  perform set_config('stockpilot.ledger', 'on', true);
  v_row := ledger.post_receipt_v2(
    p_purchase_order_id, p_warehouse_id, p_lines, p_idempotency_key, p_request_hash, p_notes);
  perform set_config('stockpilot.ledger', coalesce(v_prev, ''), true);
  return v_row;
end;
$$;

-- reverse_receipt ------------------------------------------------------------
alter function public.reverse_receipt(uuid, text)
  set schema ledger;

create function public.reverse_receipt(p_receipt_id uuid, p_reason text)
returns public.receipts
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_prev text := current_setting('stockpilot.ledger', true);
  v_row  public.receipts;
begin
  perform set_config('stockpilot.ledger', 'on', true);
  v_row := ledger.reverse_receipt(p_receipt_id, p_reason);
  perform set_config('stockpilot.ledger', coalesce(v_prev, ''), true);
  return v_row;
end;
$$;

-- Grants: the wrappers get exactly the ACL the bodies carried on the 0358
-- head ({postgres, authenticated, service_role}). A new function starts with
-- PUBLIC EXECUTE plus Supabase's default grants, so close those first.
do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'public.adjust_stock(uuid, numeric, text, uuid, text, text, text)',
    'public.transfer_stock(uuid, uuid, uuid, numeric, text)',
    'public.post_cycle_count(uuid)',
    'public.assemble_bundle(uuid, numeric, uuid, text)',
    'public.distribute_bundle(uuid, numeric, uuid, boolean, uuid, text, text)',
    'public.process_return_disposition(uuid)',
    'public.post_receipt_v2(uuid, uuid, jsonb, text, text, text)',
    'public.reverse_receipt(uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', v_sig);
    execute format('grant execute on function %s to authenticated, service_role', v_sig);
    execute format(
      'comment on function %s is %L', v_sig,
      'Stock-ledger RPC (0359 wrapper): raises stockpilot.ledger for the call, '
      'runs ledger.' || split_part(split_part(v_sig, '.', 2), '(', 1)
      || ' as the caller, then restores the previous value. Name, signature, '
      'return type, INVOKER and grants are frozen: installed phones call it.');
  end loop;
end $$;

-- The moved bodies keep their ACLs; make sure anon and PUBLIC hold nothing.
revoke all on function ledger.adjust_stock(uuid, numeric, text, uuid, text, text, text) from public, anon;
revoke all on function ledger.transfer_stock(uuid, uuid, uuid, numeric, text) from public, anon;
revoke all on function ledger.post_cycle_count(uuid) from public, anon;
revoke all on function ledger.assemble_bundle(uuid, numeric, uuid, text) from public, anon;
revoke all on function ledger.distribute_bundle(uuid, numeric, uuid, boolean, uuid, text, text) from public, anon;
revoke all on function ledger.process_return_disposition(uuid) from public, anon;
revoke all on function ledger.post_receipt_v2(uuid, uuid, jsonb, text, text, text) from public, anon;
revoke all on function ledger.reverse_receipt(uuid, text) from public, anon;

-- ── 3. The SECDEF helpers refuse direct calls without the flag ──────────────
-- Bodies are the live 0346 / 0341 definitions, unchanged except for the one
-- flag check each, placed AFTER the existing role gate so a non-member still
-- sees 'forbidden' first. auth.uid() IS NULL means a service_role or postgres
-- connection, which the gate already exempts. EXECUTE stays with
-- authenticated: the INVOKER ledger bodies reach these helpers as the user.

create or replace function public.apply_level_delta(p_item_id uuid, p_qty numeric, p_mode text default 'placed')
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_org    uuid;
  v_wh     uuid;
  v_loc    uuid;
  v_need   numeric;
  v_take   numeric;
  v_lvl    record;
begin
  if p_qty = 0 or p_qty is null then return; end if;
  select organization_id, warehouse_id into v_org, v_wh
    from public.inventory_items where id = p_item_id;

  -- *** 0331 authorization gate — see that migration's header. auth.uid() IS
  -- NULL means a service_role/postgres connection (anon and PUBLIC hold no
  -- EXECUTE; every authenticated request carries a sub claim). Everyone else
  -- must be an accepted, non-disabled, unexpired staff+ member of the org that
  -- OWNS the item (v_org comes from the item row above, never from the caller).
  -- The gate runs BEFORE the not-found early-return on purpose (existence
  -- probing). ***
  if auth.uid() is not null then
    if v_org is null or not public.has_org_role(v_org, 'staff') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    -- *** 0359: only from inside a ledger RPC. A direct call would move
    -- holdings with no movement row and no on-hand change. ***
    if coalesce(current_setting('stockpilot.ledger', true), '') <> 'on' then
      raise exception 'ledger_only' using errcode = '42501';
    end if;
  end if;
  if v_org is null then return; end if;

  -- ---- INCREMENT: land in Staging ----------------------------------------
  if p_qty > 0 then
    if v_wh is not null then
      perform public.ensure_warehouse_placement_locations(v_wh);
      select id into v_loc from public.locations
        where warehouse_id = v_wh and kind = 'staging' and deleted_at is null limit 1;
    else
      perform public.ensure_org_placement_locations(v_org);
      select id into v_loc from public.locations
        where organization_id = v_org and warehouse_id is null
          and kind = 'staging' and deleted_at is null limit 1;
    end if;
    insert into public.item_stock_levels(organization_id, item_id, location_id, quantity)
    values (v_org, p_item_id, v_loc, p_qty)
    on conflict (item_id, location_id) do update
      set quantity = public.item_stock_levels.quantity + excluded.quantity,
          updated_at = now();
    return;
  end if;

  -- ---- DECREMENT: draw down by mode --------------------------------------
  v_need := -p_qty;  -- positive amount to remove

  -- staging_first: drain the Staging level(s) before placed.
  if p_mode = 'staging_first' then
    for v_lvl in
      select s.location_id, s.quantity
        from public.item_stock_levels s
        join public.locations l on l.id = s.location_id
       where s.item_id = p_item_id and s.quantity > 0 and l.kind = 'staging'
       order by s.quantity desc
    loop
      exit when v_need <= 0;
      v_take := least(v_lvl.quantity, v_need);
      update public.item_stock_levels set quantity = quantity - v_take, updated_at = now()
        where item_id = p_item_id and location_id = v_lvl.location_id;
      v_need := v_need - v_take;
    end loop;
  end if;

  -- placed draw-down (racks/areas/crates first, Unplaced last; never Staging).
  -- IS DISTINCT FROM, not <>: locations.kind is nullable (0292).
  for v_lvl in
    select s.location_id, s.quantity
      from public.item_stock_levels s
      join public.locations l on l.id = s.location_id
     where s.item_id = p_item_id and s.quantity > 0 and l.kind is distinct from 'staging'
     order by (case when l.kind = 'unplaced' then 1 else 0 end), l.created_at
  loop
    exit when v_need <= 0;
    v_take := least(v_lvl.quantity, v_need);
    update public.item_stock_levels set quantity = quantity - v_take, updated_at = now()
      where item_id = p_item_id and location_id = v_lvl.location_id;
    v_need := v_need - v_take;
  end loop;

  -- *** 0341: 'any' — the placed holdings did not cover a MANUAL removal;
  -- continue into Staging (largest level first, like staging_first). Reached
  -- only in this mode and only when v_need is still positive, so 'placed'
  -- callers keep never touching Staging. ***
  if p_mode = 'any' and v_need > 0 then
    for v_lvl in
      select s.location_id, s.quantity
        from public.item_stock_levels s
        join public.locations l on l.id = s.location_id
       where s.item_id = p_item_id and s.quantity > 0 and l.kind = 'staging'
       order by s.quantity desc
    loop
      exit when v_need <= 0;
      v_take := least(v_lvl.quantity, v_need);
      update public.item_stock_levels set quantity = quantity - v_take, updated_at = now()
        where item_id = p_item_id and location_id = v_lvl.location_id;
      v_need := v_need - v_take;
    end loop;
  end if;

  if v_need > 0 then
    raise exception 'insufficient_placed_stock' using errcode = 'P0001';
  end if;
end;
$function$;

create or replace function public.apply_cycle_count_location_delta(
  p_item_id uuid, p_location_id uuid, p_org_id uuid, p_delta numeric)
returns numeric
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_have numeric;
  v_take numeric;
begin
  -- A zero delta or a null location writes nothing — the caller routes it.
  -- Kept ahead of the gate so this contract (0342 tests) is unchanged.
  if p_delta = 0 or p_delta is null or p_location_id is null then
    return coalesce(p_delta, 0);
  end if;

  -- *** 0346 authorization gate — see header. ***
  if auth.uid() is not null then
    if p_org_id is null or p_item_id is null
       or not public.has_org_role(p_org_id, 'manager') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    -- *** 0359: only from inside post_cycle_count. ***
    if coalesce(current_setting('stockpilot.ledger', true), '') <> 'on' then
      raise exception 'ledger_only' using errcode = '42501';
    end if;
  end if;
  -- item_in_org / location_in_org are null-tolerant by design (FK-guard
  -- semantics), which is why p_item_id null is refused above for users.
  if not public.item_in_org(p_item_id, p_org_id)
     or not public.location_in_org(p_location_id, p_org_id) then
    raise exception 'cross_org' using errcode = '42501';
  end if;

  if p_delta > 0 then
    insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
    values (p_org_id, p_item_id, p_location_id, p_delta)
    on conflict (item_id, location_id) do update
      set quantity = public.item_stock_levels.quantity + excluded.quantity,
          updated_at = now();
    return 0;
  end if;

  select quantity into v_have
    from public.item_stock_levels
   where item_id = p_item_id and location_id = p_location_id
   for update;
  if not found or coalesce(v_have, 0) <= 0 then
    return p_delta;                       -- nothing here; caller handles it all
  end if;

  v_take := least(v_have, -p_delta);      -- never below zero at this location
  update public.item_stock_levels
     set quantity = quantity - v_take, updated_at = now()
   where item_id = p_item_id and location_id = p_location_id;

  return p_delta + v_take;                -- 0 when fully absorbed
end;
$function$;

-- CREATE OR REPLACE keeps the existing ACLs; restate the intended ones.
revoke all on function public.apply_level_delta(uuid, numeric, text) from public, anon;
grant execute on function public.apply_level_delta(uuid, numeric, text) to authenticated, service_role;
revoke all on function public.apply_cycle_count_location_delta(uuid, uuid, uuid, numeric) from public, anon;
grant execute on function public.apply_cycle_count_location_delta(uuid, uuid, uuid, numeric) to authenticated, service_role;

-- ── 4. receipts, receipt_lines, receipt_line_lots: ledger-only ──────────────
-- The only writers are post_receipt_v2 and reverse_receipt (live pg_proc
-- census and an app grep, 2026-09-24); both are wrappers now. serial_registry
-- is deliberately NOT guarded: SerialsService writes it directly.
-- The receipts_write / receipt_lines / receipt_line_lots write policies and
-- the authenticated DML grants STAY: the INVOKER receipt bodies write these
-- tables as the user.

drop trigger if exists trg_zz_receipts_guard on public.receipts;
create trigger trg_zz_receipts_guard
  before insert or update or delete on public.receipts
  for each row execute function public.tg_ledger_only_guard();

drop trigger if exists trg_zz_receipt_lines_guard on public.receipt_lines;
create trigger trg_zz_receipt_lines_guard
  before insert or update or delete on public.receipt_lines
  for each row execute function public.tg_ledger_only_guard();

drop trigger if exists trg_zz_receipt_line_lots_guard on public.receipt_line_lots;
create trigger trg_zz_receipt_line_lots_guard
  before insert or update or delete on public.receipt_line_lots
  for each row execute function public.tg_ledger_only_guard();

-- ── 5. recompute_po_status ──────────────────────────────────────────────────
-- Same body, except the line sums count only lines that belong to the PO's
-- own organization: purchase_order_items_write checks organization_id alone,
-- so a line injected under another org's PO id must never move that PO's
-- status. It stays INVOKER (it runs as the caller inside the receipt RPCs).
-- EXECUTE had been granted to PUBLIC and anon.

create or replace function public.recompute_po_status(p_po_id uuid)
returns text
language plpgsql
set search_path = public
as $function$
declare
  v_total_ordered  numeric;
  v_total_received numeric;
  v_status         text;
begin
  select coalesce(sum(i.quantity_ordered), 0),
         coalesce(sum(i.quantity_received), 0)
    into v_total_ordered, v_total_received
    from public.purchase_order_items i
    join public.purchase_orders p on p.id = i.purchase_order_id
    where i.purchase_order_id = p_po_id
      and i.organization_id = p.organization_id;

  if v_total_received <= 0 then
    -- Nothing received (or fully reversed): roll back to the OPEN state this
    -- PO had before the receipt — 'expected_inbound' for a never-ordered
    -- import-created PO (0349), 'ordered' for everything else — and clear
    -- received_at so the PO can accept fresh receipts again. Never touch
    -- draft/cancelled POs.
    update public.purchase_orders p
      set status = case
                     when p.ordered_at is null
                      and exists (
                        select 1 from public.po_imports i
                         where i.approved_po_id = p.id
                      ) then 'expected_inbound'
                     else 'ordered'
                   end,
          received_at = null
      where p.id = p_po_id and p.status not in ('draft', 'cancelled')
      returning p.status into v_status;
    -- No row matched (draft/cancelled/missing): report the same constant the
    -- pre-0349 function did, so callers see no new shape.
    return coalesce(v_status, 'ordered');
  elsif v_total_received >= v_total_ordered then
    update public.purchase_orders
      set status = 'received', received_at = coalesce(received_at, now())
      where id = p_po_id and status not in ('cancelled');
    return 'received';
  else
    -- Partially received: clear any stale full-receipt timestamp (e.g. after a
    -- reversal dropped it below complete).
    update public.purchase_orders
      set status = 'partially_received', received_at = null
      where id = p_po_id and status not in ('cancelled');
    return 'partially_received';
  end if;
end$function$;

revoke all on function public.recompute_po_status(uuid) from public, anon;
grant execute on function public.recompute_po_status(uuid) to authenticated, service_role;

-- ── 6. inventory_items: org immutable; cost, charter, warehouse edit rules ──
-- A direct PATCH of these three columns skipped every rule the item-edit
-- service applies. Rather than force them through a separate RPC (which would
-- split one item edit into two writes that can half-apply), the guard applies
-- the SAME rules to the single UPDATE the service already sends:
--   * items:update (has_permission honours user and role overrides; the RLS
--     policy's staff arm does not). One carve-out: PO-import approval
--     re-charters an item it just created, as a purchase_orders:manage holder,
--     at zero on hand, touching nothing else.
--   * unit_cost >= 0 (the schema's numericMoney floor; the table has no CHECK).
--   * warehouse_id stays set and stays in the item's org (the UPDATE policy's
--     WITH CHECK does not check the org, and the (warehouse, charter) FK is not
--     checked when charter_id is null).
--   * a warehouse-scoped caller (staff/viewer without the 0280 all-warehouses
--     flag) cannot move an item: the SQL twin of forcedWarehouseId().
-- charter_in_org and the (warehouse_id, charter_id) pair are already enforced
-- by the policy's WITH CHECK and inventory_items_warehouse_charter_fk.
-- Moving an item that holds stock stays allowed here, as it is in the app
-- today; the holdings that stay behind are a separate fix.
-- The quantity_on_hand rule lands with the enforcement migration, after the
-- failed-create rollback has moved onto compensate_opening_stock (section 7).

create or replace function public.caller_is_warehouse_scoped(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not public.has_org_role(p_org_id, 'manager')
     and not coalesce((
       select m.all_warehouses
         from public.organization_members m
        where m.organization_id = p_org_id
          and m.user_id = auth.uid()
          and m.accepted_at is not null
        limit 1
     ), false);
$$;

comment on function public.caller_is_warehouse_scoped(uuid) is
  'True when the caller is below manager and not an all-warehouses member '
  '(0280): the SQL twin of forcedWarehouseId() returning a warehouse.';

revoke all on function public.caller_is_warehouse_scoped(uuid) from public, anon;
grant execute on function public.caller_is_warehouse_scoped(uuid) to authenticated, service_role;

create or replace function public.tg_inventory_items_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_cost_changed      boolean := new.unit_cost is distinct from old.unit_cost;
  v_charter_changed   boolean := new.charter_id is distinct from old.charter_id;
  v_warehouse_changed boolean := new.warehouse_id is distinct from old.warehouse_id;
begin
  -- See tg_ledger_only_guard for why only the API roles are checked.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if new.organization_id is distinct from old.organization_id then
    raise exception 'An item cannot be moved to another organization.'
      using errcode = '42501';
  end if;

  if not (v_cost_changed or v_charter_changed or v_warehouse_changed) then
    return new;
  end if;

  if not public.has_permission(new.organization_id, 'items:update') then
    if not (v_charter_changed
            and not v_cost_changed
            and not v_warehouse_changed
            and old.quantity_on_hand = 0
            and public.has_permission(new.organization_id, 'purchase_orders:manage')) then
      raise exception 'You do not have permission to change this item''s cost, charter or warehouse.'
        using errcode = '42501';
    end if;
  end if;

  if v_cost_changed and new.unit_cost < 0 then
    raise exception 'Unit cost must be 0 or more.'
      using errcode = '23514';
  end if;

  if v_warehouse_changed then
    if new.warehouse_id is null then
      raise exception 'Item must remain assigned to a warehouse.'
        using errcode = '23514';
    end if;
    if not public.warehouse_in_org(new.warehouse_id, new.organization_id) then
      raise exception 'That warehouse is not part of this organization.'
        using errcode = '42501';
    end if;
    if public.caller_is_warehouse_scoped(new.organization_id) then
      raise exception 'Warehouse-scoped users cannot move items to another warehouse.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.tg_inventory_items_guard() is
  'BEFORE UPDATE guard (0359): API-role updates cannot change organization_id, '
  'and cost/charter/warehouse changes follow the item-edit rules. SECURITY '
  'INVOKER on purpose (a DEFINER trigger sees postgres and never enforces).';

revoke all on function public.tg_inventory_items_guard() from public, anon, authenticated;

drop trigger if exists trg_zz_inventory_items_guard on public.inventory_items;
-- No column list: a change made by an earlier BEFORE trigger is still seen,
-- and 'zz' sorts it after the existing BEFORE triggers.
create trigger trg_zz_inventory_items_guard
  before update on public.inventory_items
  for each row execute function public.tg_inventory_items_guard();

-- ── 7. compensate_opening_stock ─────────────────────────────────────────────
-- The failed-create rollback. When an item insert commits with opening stock
-- but its 'initial' movement insert fails, InventoryService and
-- BooksImportService zero the placements the 0199 seed trigger wrote and then
-- quantity_on_hand, so no stock exists that no movement explains. They did it
-- with two direct user-client UPDATEs, which the enforcement migration will
-- refuse. This does both in ONE transaction (levels first is no longer an
-- ordering concern) and is deliberately narrow: only the caller's own items,
-- created in the last 15 minutes, never deleted, with NO movement row at all.
-- An item with any ledger history is never touched, so this cannot be used to
-- zero established stock. SECURITY DEFINER: it runs as postgres, so the
-- ledger guards exempt it. Returns the ids it compensated; the service still
-- re-reads the levels to prove nothing survived.

create or replace function public.compensate_opening_stock(p_org_id uuid, p_item_ids uuid[])
returns setof uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_ids uuid[];
begin
  if v_uid is null
     or p_org_id is null
     or not (public.has_org_role(p_org_id, 'staff')
             or public.has_permission(p_org_id, 'items:create')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_item_ids is null or cardinality(p_item_ids) = 0 then
    return;
  end if;
  if cardinality(p_item_ids) > 1000 then
    raise exception 'too_many_items' using errcode = '22023';
  end if;

  select coalesce(array_agg(i.id order by i.id), '{}')
    into v_ids
    from (
      select it.id
        from public.inventory_items it
       where it.organization_id = p_org_id
         and it.id = any(p_item_ids)
         and it.created_by = v_uid
         and it.created_at > now() - interval '15 minutes'
         and it.deleted_at is null
         and not exists (select 1 from public.stock_movements m where m.item_id = it.id)
       order by it.id
         for update
    ) i;

  if cardinality(v_ids) = 0 then
    return;
  end if;

  update public.item_stock_levels
     set quantity = 0, updated_at = now()
   where organization_id = p_org_id
     and item_id = any(v_ids)
     and quantity <> 0;

  update public.inventory_items
     set quantity_on_hand = 0, updated_by = v_uid
   where id = any(v_ids)
     and quantity_on_hand <> 0;

  return query select unnest(v_ids);
end;
$$;

comment on function public.compensate_opening_stock(uuid, uuid[]) is
  'Failed-create rollback (0359): zeroes the placements and on-hand of the '
  'caller''s own items created in the last 15 minutes that have no movement '
  'row. Returns the ids compensated.';

revoke all on function public.compensate_opening_stock(uuid, uuid[]) from public, anon;
grant execute on function public.compensate_opening_stock(uuid, uuid[]) to authenticated, service_role;

-- ── 8. Grant hygiene ────────────────────────────────────────────────────────
-- Nothing legitimate runs TRUNCATE, TRIGGER or REFERENCES as an API role, and
-- anon (signed-out requests) writes none of these tables. inventory_items
-- DELETE: nothing in the app hard-deletes an item (soft delete everywhere),
-- and a hard delete would cascade its movements, holdings and reservations.
-- Org deletion cascades run as the table owner and are unaffected.

revoke truncate, trigger, references on
  public.inventory_items, public.item_stock_levels,
  public.receipts, public.receipt_lines, public.receipt_line_lots
  from authenticated, anon;
revoke insert, update, delete on
  public.inventory_items, public.item_stock_levels,
  public.receipts, public.receipt_lines, public.receipt_line_lots
  from anon;
revoke delete on public.inventory_items from authenticated;
