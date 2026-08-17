-- 0341: (1) apply_level_delta gains draw-down mode 'any' — placed first, then
--           Staging — for MANUAL adjustments, so a full write-off of an item
--           that has a unit sitting in Staging no longer refuses.
--       (2) publish_outbox becomes SECURITY DEFINER with self-authorization, so
--           managers' and staff's returns / receipts / order events actually
--           reach the outbox instead of being silently dropped by RLS.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- (1) Why: L4L, 2026-08-17 22:44–22:53 UTC. "L4L - New Hire - Women's Polo - S"
--     held on_hand 3 = 2 on rack 17-A + 1 in Staging (a return restock lands in
--     Staging by design — returned goods await put-away). A manager tried to
--     remove all 3 (out of stock, retire the item). adjust_stock with a null
--     location and a negative delta draws in mode 'placed', which by contract
--     NEVER touches Staging (staged stock is not pickable). It found 2, raised
--     insufficient_placed_stock, and the web mapped that to "Something went
--     wrong" — four times.
--
--     'placed' stays exactly as it is: picks, ships and every existing caller
--     that passes no mode keep the invariant that Staging is never drawn.
--     'staging_first' stays exactly as it is (reversals / scrap write-offs).
--     The new 'any' mode is opt-in: placed loop first (racks/areas/crates, then
--     Unplaced — the same order as 'placed'), and only if the placed holdings
--     do not cover the delta does it continue into Staging. A partial manual
--     removal therefore still comes off the shelf; only a removal larger than
--     the shelf reaches the staged units. If even that is short, it raises the
--     same insufficient_placed_stock the callers already know (the holdings do
--     not reconcile with on-hand — real drift, worth surfacing, not papering
--     over).
--
--     Every other statement in the function is the 0331 version unchanged:
--     SECURITY DEFINER, the 0331 authorization gate, the increment path, the
--     IS DISTINCT FROM guard from 0292, the grants.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.apply_level_delta(
  p_item_id uuid,
  p_qty     numeric,
  p_mode    text default 'placed'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
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
$$;

comment on function public.apply_level_delta(uuid, numeric, text) is
  'Shared item_stock_levels maintenance tail of adjust_stock, post_receipt_v2, reverse_receipt, post_cycle_count, assemble/distribute_bundle and process_return_disposition. Modes: placed (default; racks/areas/crates then Unplaced, NEVER Staging — picks/ships), staging_first (Staging then placed — reversals/scrap), any (0341: placed then Staging — manual adjustments/write-offs). SECURITY DEFINER since 0331; self-authorizes at the item''s org with the staff floor; anon holds no EXECUTE.';

-- Grants: unchanged from 0331, restated so this file is self-describing.
revoke execute on function public.apply_level_delta(uuid, numeric, text) from public, anon;
grant  execute on function public.apply_level_delta(uuid, numeric, text) to authenticated;
grant  execute on function public.apply_level_delta(uuid, numeric, text) to service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- (2) publish_outbox — SECURITY DEFINER with self-authorization.
--
-- Why: publish_outbox (0016) is SECURITY INVOKER and outbox_events_write
-- (0140) requires ADMIN. Every service call site — returns.ts (return.created,
-- return.closed), receiving.ts (receipt.posted), order-requests.ts,
-- purchase-orders.ts — invokes it through the USER-authed client and wraps it
-- in a best-effort try/catch. So when a manager or staff member creates a
-- return, posts a receipt or approves an order, RLS refuses the insert
-- ("new row violates row-level security policy for table outbox_events" —
-- five occurrences in prod on 2026-08-17 alone, e.g. 17:12:59 for the very
-- return above), the catch swallows it, and the connectors (Zendesk shell,
-- webhooks, order tracking) simply never hear about it. Only admins' events
-- were ever published.
--
-- Fix: as definer, the insert bypasses the table policy; the function itself
-- authorizes: a null-subject (service_role / postgres) connection may publish
-- for any org (the public order-requests route already does this through the
-- admin client); an authenticated caller must be an accepted, non-disabled
-- member of p_org_id at the STAFF floor — the same floor receipts_write and the
-- stock RPCs enforce, and the lowest role that can perform any of the actions
-- that publish. Viewers cannot publish (they cannot perform those actions
-- either). The org id in the row is p_org_id itself, so a member can only ever
-- publish INTO an org they belong to. Table policies are untouched (admin
-- still governs direct reads/writes; the drainer runs as service role).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.publish_outbox(
  p_org_id         uuid,
  p_topic          text,
  p_aggregate_type text,
  p_aggregate_id   uuid,
  p_payload        jsonb,
  p_dedupe_key     text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_org_id is null then
    raise exception 'org_required' using errcode = '22004';
  end if;
  if auth.uid() is not null and not public.has_org_role(p_org_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into public.outbox_events(
    organization_id, topic, aggregate_type, aggregate_id, dedupe_key, payload
  ) values (
    p_org_id, p_topic, p_aggregate_type, p_aggregate_id, p_dedupe_key, p_payload
  )
  on conflict (organization_id, dedupe_key) where dedupe_key is not null do nothing
  returning id into v_id;
  return v_id;
end;
$$;

comment on function public.publish_outbox(uuid, text, text, uuid, jsonb, text) is
  'Append one event to outbox_events for the connector drainer. SECURITY DEFINER since 0341 (0016 was invoker and the admin-only write policy silently dropped every manager/staff event); self-authorizes: null subject (service_role) may publish for any org, an authenticated caller must be a staff+ member of p_org_id. Idempotent on (organization_id, dedupe_key).';

revoke execute on function public.publish_outbox(uuid, text, text, uuid, jsonb, text) from public, anon;
grant  execute on function public.publish_outbox(uuid, text, text, uuid, jsonb, text) to authenticated;
grant  execute on function public.publish_outbox(uuid, text, text, uuid, jsonb, text) to service_role;
