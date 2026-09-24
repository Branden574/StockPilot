-- 0361_rental_rpcs.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Stock-ledger lockdown, rentals (prepare step). Adds the three rental
-- transitions as single-transaction functions. Nothing is revoked from the
-- rental tables here: RentalsService moves onto these functions in the same
-- release, and the enforcement migration closes direct rentals / rental_lines
-- writes once the web deploy is verified.
--
-- THE PROBLEM. RentalsService wrote a checkout as three requests (header,
-- lines, then the stock_reservations holds through the service role) and
-- "rolled back" a failure by deleting the header through the user client.
-- The table grants behind that also let a signed-in user:
--   * delete a rental, which cascades its holds away (stock that is out with a
--     borrower becomes available again);
--   * change a line's quantity, or move lines between rentals;
--   * insert a rental under another org's id (rentals_insert checks warehouse
--     access only, never organization_id).
-- And the availability check ran before the writes with nothing held, so two
-- checkouts at once could both claim the last unit.
--
-- THE FIX. create_rental checks availability with the items locked
-- (SELECT ... FOR UPDATE, in id order) and writes the header, lines and holds
-- in one transaction. return_rental and cancel_rental flip the status from
-- 'out' and release the holds in the same transaction. All three are SECURITY
-- DEFINER, so they apply the service's own gates explicitly: module enabled,
-- the permission, and write access to the rental's warehouse.
--
-- VISIBILITY. The old checkout read the items through the caller's client, so
-- inventory_items_select applied: a charter- or category-scoped member could
-- not rent (or even learn the stock of) an item outside their scope, and got
-- "not found". A SECURITY DEFINER function reads past RLS, so create_rental
-- applies the same predicate itself (inventory_items_read_scope below, the
-- policy's own helpers) before any item-specific check or message.
--
-- stock_reservations is already write-locked by policy (USING / WITH CHECK
-- false); its grants are closed here too. The writers are SECURITY DEFINER
-- functions and the service role; FK cascades run as the table owner.

set lock_timeout = '5s';

-- The inventory_items_select predicate, for SECURITY DEFINER callers that must
-- see exactly what the caller's own client would. Keep in step with that
-- policy (its current shape is 0229's hashed-set form).
create or replace function public.caller_can_read_item(p_item_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- Nobody unauthenticated reads through this (the scope helpers below would
  -- return nothing for them anyway; this states it where INV-25 can see it).
  select (select auth.uid()) is not null and exists (
    select 1
      from public.inventory_items it
     where it.id = p_item_id
       and (it.warehouse_id in (select public.rls_inv_read_full_warehouse_ids())
            or (it.charter_id is null
                and it.warehouse_id in (select public.rls_inv_read_assigned_warehouse_ids()))
            or (it.warehouse_id, it.charter_id) in
               (select r.warehouse_id, r.charter_id from public.rls_inv_read_warehouse_charter_ids() r))
       and (it.organization_id in (select public.rls_cat_unrestricted_org_ids())
            or (it.organization_id, it.category_id) in
               (select c.organization_id, c.category_id from public.rls_cat_allowed_category_ids() c))
  );
$$;

comment on function public.caller_can_read_item(uuid) is
  'True when inventory_items_select would show the caller this item (0361). '
  'For SECURITY DEFINER paths that must not read past the caller''s scope.';

revoke all on function public.caller_can_read_item(uuid) from public, anon;
grant execute on function public.caller_can_read_item(uuid) to authenticated, service_role;

-- ── create_rental ───────────────────────────────────────────────────────────
-- p_lines: [{ "item_id": uuid, "quantity": number, "notes": text|null }]

create or replace function public.create_rental(
  p_warehouse_id uuid,
  p_borrower_user_id uuid,
  p_borrower_name text,
  p_borrower_email text,
  p_expected_return_at timestamptz,
  p_notes text,
  p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_org       uuid;
  v_rental    uuid;
  v_item      record;
  v_reserved  numeric;
  v_available numeric;
begin
  if v_uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select w.organization_id into v_org from public.warehouses w where w.id = p_warehouse_id;
  if v_org is null or not public.is_org_member(v_org) then
    raise exception 'warehouse_not_found' using errcode = 'P0002';
  end if;
  if not public.module_enabled(v_org, 'rentals')
     or not public.has_permission(v_org, 'rentals:create')
     or not public.user_can_access_warehouse(v_uid, p_warehouse_id, 'write') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_borrower_name is null or btrim(p_borrower_name) = '' then
    raise exception 'borrower_required' using errcode = '22023';
  end if;
  if p_borrower_user_id is not null and not exists (
       select 1 from public.organization_members m
        where m.organization_id = v_org and m.user_id = p_borrower_user_id
          and m.accepted_at is not null) then
    raise exception 'borrower_not_member' using errcode = '22023';
  end if;
  if p_expected_return_at is null or p_expected_return_at < now() - interval '1 hour' then
    raise exception 'Expected return date must be in the future.'
      using errcode = '22023', hint = 'rental_invalid';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'lines_required' using errcode = '22023';
  end if;
  if exists (
       select 1 from jsonb_array_elements(p_lines) e
        where nullif(e.value ->> 'item_id', '') is null
           or jsonb_typeof(e.value -> 'quantity') <> 'number'
           or (e.value ->> 'quantity')::numeric <= 0
           or (e.value ->> 'quantity')::numeric > 10000) then
    raise exception 'lines_invalid' using errcode = '22023';
  end if;

  -- An item outside the caller's read scope is "not found", exactly as the
  -- old user-client read reported it, before its name or stock is read.
  if exists (
       select 1 from jsonb_array_elements(p_lines) e
        where not exists (select 1 from public.inventory_items it
                           where it.id = (e.value ->> 'item_id')::uuid
                             and it.organization_id = v_org
                             and it.deleted_at is null)
           or not public.caller_can_read_item((e.value ->> 'item_id')::uuid)) then
    raise exception 'One or more items were not found.'
      using errcode = 'P0002', hint = 'rental_invalid';
  end if;

  -- Lock the requested items in a fixed order, then check each one. Two
  -- checkouts of the same item now queue here instead of both passing.
  for v_item in
    select it.id, it.name, it.is_rental, it.warehouse_id, it.quantity_on_hand, req.requested
      from (select (e.value ->> 'item_id')::uuid as item_id,
                   sum((e.value ->> 'quantity')::numeric) as requested
              from jsonb_array_elements(p_lines) e
             group by 1) req
      join public.inventory_items it
        on it.id = req.item_id and it.organization_id = v_org
     order by it.id
       for update of it
  loop
    if not v_item.is_rental then
      raise exception 'One or more items are not rental items.'
        using errcode = '22023', hint = 'rental_invalid';
    end if;
    if v_item.warehouse_id is distinct from p_warehouse_id then
      raise exception 'All items must be in the rental warehouse.'
        using errcode = '22023', hint = 'rental_invalid';
    end if;
    v_reserved := coalesce((
      select sum(r.quantity) from public.stock_reservations r
       where r.item_id = v_item.id and r.organization_id = v_org and r.released_at is null), 0);
    v_available := greatest(0, coalesce(v_item.quantity_on_hand, 0) - v_reserved);
    if v_item.requested > v_available then
      raise exception '%: only % available to rent (% on hand, % already reserved) — % requested.',
        coalesce(v_item.name, 'Item'),
        trim_scale(v_available),
        trim_scale(coalesce(v_item.quantity_on_hand, 0)),
        trim_scale(v_reserved),
        trim_scale(v_item.requested)
        using errcode = '22023', hint = 'rental_invalid';
    end if;
  end loop;

  insert into public.rentals (
    organization_id, warehouse_id, borrower_user_id, borrower_name, borrower_email,
    expected_return_at, notes, created_by, status)
  values (
    v_org, p_warehouse_id, p_borrower_user_id, btrim(p_borrower_name), p_borrower_email,
    p_expected_return_at, p_notes, v_uid, 'out')
  returning id into v_rental;

  insert into public.rental_lines (rental_id, item_id, quantity, notes)
  select v_rental, (e.value ->> 'item_id')::uuid, (e.value ->> 'quantity')::numeric,
         nullif(e.value ->> 'notes', '')
    from jsonb_array_elements(p_lines) with ordinality e(value, ord)
   order by e.ord;

  insert into public.stock_reservations (organization_id, item_id, warehouse_id, quantity, rental_id)
  select v_org, (e.value ->> 'item_id')::uuid, p_warehouse_id, (e.value ->> 'quantity')::numeric, v_rental
    from jsonb_array_elements(p_lines) with ordinality e(value, ord)
   order by e.ord;

  return v_rental;
end;
$$;

comment on function public.create_rental(uuid, uuid, text, text, timestamptz, text, jsonb) is
  'Rental checkout in one transaction (0361): locks the items, checks '
  'on-hand minus active holds, writes header, lines and holds.';

-- ── return_rental / cancel_rental ───────────────────────────────────────────
-- Both return 'noop' when the rental is no longer out (already returned or
-- cancelled, including by a concurrent call), else the new status.

create or replace function public.return_rental(p_rental_id uuid, p_return_notes text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_org    uuid;
  v_wh     uuid;
  v_status text;
begin
  if v_uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select r.organization_id, r.warehouse_id, r.status into v_org, v_wh, v_status
    from public.rentals r where r.id = p_rental_id
     for update;
  if v_org is null or not public.is_org_member(v_org) then
    raise exception 'rental_not_found' using errcode = 'P0002';
  end if;
  if not public.module_enabled(v_org, 'rentals')
     or not public.has_permission(v_org, 'rentals:create')
     or not public.user_can_access_warehouse(v_uid, v_wh, 'write') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_status <> 'out' then
    return 'noop';
  end if;

  update public.rentals
     set status = 'returned', returned_at = now(), returned_by = v_uid,
         return_notes = p_return_notes
   where id = p_rental_id;
  update public.stock_reservations
     set released_at = now(), released_reason = 'rental_returned'
   where rental_id = p_rental_id and released_at is null;
  return 'returned';
end;
$$;

create or replace function public.cancel_rental(p_rental_id uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_org    uuid;
  v_wh     uuid;
  v_status text;
begin
  if v_uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select r.organization_id, r.warehouse_id, r.status into v_org, v_wh, v_status
    from public.rentals r where r.id = p_rental_id
     for update;
  if v_org is null or not public.is_org_member(v_org) then
    raise exception 'rental_not_found' using errcode = 'P0002';
  end if;
  if not public.module_enabled(v_org, 'rentals')
     or not public.has_permission(v_org, 'rentals:manage')
     or not public.user_can_access_warehouse(v_uid, v_wh, 'write') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_status <> 'out' then
    return 'noop';
  end if;

  update public.rentals
     set status = 'cancelled', cancelled_at = now(), cancelled_by = v_uid,
         cancellation_reason = p_reason
   where id = p_rental_id;
  update public.stock_reservations
     set released_at = now(), released_reason = 'rental_cancelled'
   where rental_id = p_rental_id and released_at is null;
  return 'cancelled';
end;
$$;

comment on function public.return_rental(uuid, text) is
  'Rental return (0361): out -> returned and its holds released, in one transaction.';
comment on function public.cancel_rental(uuid, text) is
  'Rental cancel (0361): out -> cancelled and its holds released, in one '
  'transaction. Needs rentals:manage.';

-- ── Grants ──────────────────────────────────────────────────────────────────

revoke all on function public.create_rental(uuid, uuid, text, text, timestamptz, text, jsonb) from public, anon;
grant execute on function public.create_rental(uuid, uuid, text, text, timestamptz, text, jsonb) to authenticated, service_role;
revoke all on function public.return_rental(uuid, text) from public, anon;
grant execute on function public.return_rental(uuid, text) to authenticated, service_role;
revoke all on function public.cancel_rental(uuid, text) from public, anon;
grant execute on function public.cancel_rental(uuid, text) to authenticated, service_role;

-- stock_reservations: every write policy is already false; close the grants.
revoke insert, update, delete, truncate, trigger, references
  on public.stock_reservations from authenticated, anon;
-- rentals / rental_lines: hygiene now; their DML closes with the enforcement
-- migration.
revoke truncate, trigger, references on public.rentals, public.rental_lines from authenticated, anon;
revoke insert, update, delete on public.rentals, public.rental_lines from anon;

reset lock_timeout;
