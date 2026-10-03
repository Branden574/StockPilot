-- 0388_order_number_and_requester_deletion.sql
--
-- Two older bugs found by the slice A review (sec-orders plan section 10,
-- items 15 and 16), and the check the server makes before it deletes an
-- account.
--
-- 1. Any accepted member could INSERT their own pending order with any
--    order_number (bigint max included); assign_order_request_number passes
--    an explicit number through, so every later order in that organization
--    failed 22003. authenticated also set id, updated_at, internal_notes and
--    requester_org_label on insert, which the insert guard (0365) does not
--    check. authenticated now may INSERT only the 13 columns
--    create_order_request names (the 0384 pattern). service_role and the
--    order RPCs are unchanged. create_order_request,
--    tg_order_requests_insert_guard and assign_order_request_number are not
--    touched.
--
-- 2. Deleting the account of anyone who placed an internal order without an
--    email on the row (or any portal order) failed: the user_profiles FK
--    nulls requester_user_id and order_requests_identity_chk refused the row
--    (23514), so auth.admin.deleteUser failed on the web, the phone and the
--    platform console. When the FK action nulls the requester because the
--    profile is gone, trg_order_requests_requester_deleted stamps
--    requester_deleted_at, and identity_chk accepts that stamp in place of an
--    identity. Nothing about the person is copied onto the order.
--
-- 3. account_deletion_check(uuid): the server asks, before it changes
--    anything, whether an account can be deleted. It tries the delete inside
--    a subtransaction that always ends by raising, so nothing is kept. Its
--    lock_timeout (900ms) is below deadlock_timeout (1s), so a row lock held
--    by an order write ends the check (55P03, "try again") before its wait
--    can make that write a deadlock victim.
--
-- LOCKS: the functions and grants take no lock on order_requests. The one
-- ALTER TABLE takes ACCESS EXCLUSIVE on order_requests (column add and the
-- CHECK swap, validated under the same lock), held to commit together with
-- the trigger's SHARE ROW EXCLUSIVE. lock_timeout 2s: behind a long
-- transaction the file fails 55P03 and is re-run; it writes no row.
--
-- ERRORS: a refused insert column is 42501 (privilege); a CHECK is 23514;
-- account_deletion_check raises only 42501 for an API-role caller and P0001
-- internally (caught). Never 40001 or 40P01.

set lock_timeout = '2s';

create or replace function public.account_deletion_check(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '900ms'
as $$
declare
  v_state  text;
  v_msg    text;
  v_constr text;
  v_schema text;
  v_table  text;
begin
  if coalesce(auth.role(), '') in ('authenticated', 'anon') then
    raise exception 'account_deletion_check_service_only' using errcode = '42501';
  end if;
  if p_user_id is null then
    return jsonb_build_object('deletable', false, 'reason', 'no_user');
  end if;
  begin
    delete from auth.users where id = p_user_id;
    if not found then
      return jsonb_build_object('deletable', false, 'reason', 'not_found');
    end if;
    raise exception using errcode = 'P0001', message = 'account_deletion_check_undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text,
                            v_constr = constraint_name, v_schema = schema_name, v_table = table_name;
    if v_state = 'P0001' and v_msg = 'account_deletion_check_undo' then
      return jsonb_build_object('deletable', true);
    end if;
    return jsonb_build_object('deletable', false, 'reason', 'blocked', 'sqlstate', v_state,
                              'constraint', nullif(v_constr, ''),
                              'table', nullif(v_schema || '.' || v_table, '.'));
  end;
end;
$$;

comment on function public.account_deletion_check(uuid) is
  'Whether an account can be deleted (0388). Tries delete from auth.users inside a subtransaction that '
  'always ends by raising, so every cascade, SET NULL and refusal runs and is undone. Returns '
  '{deletable} or {deletable:false, reason, sqlstate, constraint, table} for the first refusal. '
  'service_role only; refuses an authenticated or anon JWT. Never raises 40001/40P01.';

revoke all on function public.account_deletion_check(uuid) from public, anon, authenticated;
grant execute on function public.account_deletion_check(uuid) to service_role;

create or replace function public.tg_order_requests_requester_deleted()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.requester_user_id is not null
     and new.requester_user_id is null
     and current_user not in ('authenticated', 'anon')
     and not exists (select 1 from public.user_profiles p where p.id = old.requester_user_id) then
    new.requester_deleted_at := now();
  end if;
  return new;
end;
$$;

comment on function public.tg_order_requests_requester_deleted() is
  'BEFORE UPDATE OF requester_user_id (0388): when the requester''s profile is gone and a non-API role '
  '(the user_profiles FK action runs as the table owner) nulls requester_user_id, stamp '
  'requester_deleted_at. SECURITY INVOKER: under an API role RLS can hide a live profile, so API roles '
  'never stamp. Copies nothing about the person.';

revoke all on function public.tg_order_requests_requester_deleted() from public, anon, authenticated;

revoke insert on table public.order_requests from authenticated;
grant insert (organization_id, warehouse_id, requester_user_id, requester_name, requester_email,
              notes, needed_by, fulfillment_type, requester_phone, delivery_charter_id,
              pickup_location_notes, source, status)
  on table public.order_requests to authenticated;

alter table public.order_requests
  add column requester_deleted_at timestamptz,
  drop constraint order_requests_identity_chk,
  add constraint order_requests_identity_chk check (
    case source
      when 'internal'    then (requester_user_id is not null or requester_email is not null or requester_deleted_at is not null)
      when 'public_link' then (requester_email is not null)
      when 'portal'      then (requester_user_id is not null or requester_deleted_at is not null)
      else false
    end),
  add constraint order_requests_requester_deleted_chk
    check (requester_deleted_at is null or requester_user_id is null);

create or replace trigger trg_order_requests_requester_deleted
  before update of requester_user_id on public.order_requests
  for each row execute function public.tg_order_requests_requester_deleted();

comment on column public.order_requests.requester_deleted_at is
  'When the requester''s account was deleted (0388). Stamped only by trg_order_requests_requester_deleted '
  'when the user_profiles FK nulls requester_user_id; nothing about the person is copied. authenticated '
  'may read it and may not insert or update it.';

comment on constraint order_requests_identity_chk on public.order_requests is
  'Every order names who asked (0044, 0116, 0251), or records that the requester''s account was deleted '
  '(0388, requester_deleted_at).';

comment on constraint order_requests_requester_deleted_chk on public.order_requests is
  'requester_deleted_at is set only on an order that has no requester_user_id (0388).';

reset lock_timeout;
