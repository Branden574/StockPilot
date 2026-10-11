-- supabase/tests/0398_returns_contract.test.sql
-- pgTAP proof for migration 0398 (returns and exchanges, slice RX-4, part 2:
-- the contract; plan 3.8 and 4 RX-4; brief 31, 42). Written at the RX-4 desk
-- stage (2026-10-11) and RUN AT THE TEST STAGE (no local stack was available
-- to the author); the offline parse (rx-tools/pgtap_parse.py) is the only
-- check it has had so far.
--
--   K1  authenticated holds SELECT only on returns and return_lines: no
--       INSERT, UPDATE (table or any column), DELETE, TRUNCATE, TRIGGER,
--       REFERENCES or MAINTAIN, and no column ACL is left; anon nothing; the
--       service role everything.
--   K2  A manager with returns:manage and warehouse write (the person the old
--       raw paths admitted) is refused every direct PostgREST write by
--       privilege: insert, status update, line insert, line update, delete.
--   K3  SELECT is unchanged: members read both tables as before.
--   K4  Every function path still passes: create, approve, receive, close
--       (stock moved once, holdings equal stock on record); deny; cancel; the
--       requester create (service role); the decision log written by each.
--   K5  Defence in depth: with the old grants put back by mistake (inside an
--       undone attempt) the guards still refuse an insert at a later status,
--       a forged stamp and a raw close.
--   K6  The guards and the four write policies are still installed.
--   K7  Recorded on purpose (RX4-NOTES B3): the frozen wrapper
--       public.process_return_disposition keeps EXECUTE for authenticated
--       (plan 1.5, P30). If a later slice revokes it, this line changes with
--       it.
--
-- MUTATION TABLE (each must fail the named lines; the test stage's
-- mutate-0398.py):
--   M1  the INSERT revoke dropped                         -> K1, K2
--   M2  the column UPDATE revoke dropped                  -> K1, K2
--   M3  the guards dropped as "no longer needed"          -> K5, K6
--
-- Namespace 03988000. begin/rollback: nothing leaks.

begin;

select plan(9);

\set org     '\'03988000-0000-0000-0000-00000000000a\''
\set own     '\'03988000-0000-0000-0000-0000000000a0\''
\set mgr     '\'03988000-0000-0000-0000-0000000000a1\''
\set vwr     '\'03988000-0000-0000-0000-0000000000a2\''
\set wh      '\'03988000-0000-0000-0000-0000000000d1\''
\set rack    '\'03988000-0000-0000-0000-000000000c11\''
\set item    '\'03988000-0000-0000-0000-000000000e01\''
\set ord     '\'03988000-0000-0000-0000-000000000101\''
\set line    '\'03988000-0000-0000-0000-000000000201\''
\set rRaw    '\'03988000-0000-0000-0000-000000000301\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own, '0398-own@test.local', '{}'::jsonb),
  (:mgr, '0398-mgr@test.local', '{}'::jsonb),
  (:vwr, '0398-vwr@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values (:org, '0398 Contract', '0398-contract');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :own, 'owner',   now()),
  (:org, :mgr, 'manager', now()),
  (:org, :vwr, 'viewer',  now());
insert into public.organization_modules (organization_id, module_id, enabled, tier, settings) values
  (:org, 'returns', true, 'optional', '{}'::jsonb)
on conflict (organization_id, module_id) do update set enabled = true;
insert into public.warehouses (id, organization_id, name, code, status) values (:wh, :org, '0398 Main', 'WH-0398', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary, charter_id) values
  (:org, :vwr, :wh, true, null);
insert into public.locations (id, organization_id, warehouse_id, name, type, kind, created_at) values
  (:rack, :org, :wh, '11-A', 'shelf', 'rack', now() - interval '1 hour');
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, unit_cost, status, tracking_type, primary_location_id) values
  (:item, :org, :wh, '0398-ITEM', 'Contract Shirt', 5, 7, 'active', 'none', :rack);
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, requester_name, fulfillment_type)
values (:ord, :org, :wh, 'completed', 'internal', :mgr, 'Mgr Person', 'pickup');
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested, quantity_fulfilled)
values (:line, :ord, :item, 5, 5);
-- One RMA written as the superuser, for the read and update cases.
insert into public.returns (id, organization_id, order_request_id, return_number, status, source, requested_by)
values (:rRaw, :org, :ord, 'RMA-0398-RAW', 'requested', 'internal', :mgr);
insert into public.return_lines (return_id, organization_id, order_request_line_id, item_id, quantity, disposition)
values (:rRaw, :org, :line, :item, 1, 'restock');

-- ══ Helpers (the 0387 attempt shape) ══════════════════════════════════════
create function pg_temp.hint(p_hint text) returns text language sql immutable as $$
  select case when p_hint is null or p_hint = ''
                or p_hint like 'Grant the required privileges to the current role with:%'
              then '-' else p_hint end
$$;
-- One statement as p_as with p_sub's claims, then ALWAYS undone; p_prep runs
-- first, as the superuser, inside the undone subtransaction.
create function pg_temp.attempt(p_as text, p_sub uuid, p_sql text, p_prep text default null)
returns text language plpgsql as $$
declare v_state text; v_hint text; v_n bigint;
begin
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_as, true);
    perform set_config('role', p_as, true);
    execute p_sql;
    get diagnostics v_n = row_count;
    perform set_config('role', 'none', true);
    raise exception using errcode = 'XX398', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
  end;
  if v_state = 'XX398' then
    return 'ok:' || v_n::text;
  end if;
  return v_state || ':' || pg_temp.hint(v_hint);
end $$;
-- One statement returning jsonb as p_as, KEPT when it succeeds.
create function pg_temp.rpc(p_as text, p_sub uuid, p_sql text)
returns jsonb language plpgsql as $$
declare v jsonb; v_state text; v_hint text;
begin
  begin
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_as, true);
    perform set_config('role', p_as, true);
    execute p_sql into v;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claim.role', '', true);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    return jsonb_build_object('error', v_state, 'hint', pg_temp.hint(v_hint));
  end;
  return coalesce(v, 'null'::jsonb);
end $$;
create function pg_temp.err(j jsonb) returns text language sql immutable as $$
  select case when j ? 'error' then (j->>'error') || ':' || coalesce(j->>'hint', '-') else 'ok' end
$$;
create function pg_temp.rev(p_rma uuid) returns integer language sql as $$
  select coalesce(max(d.revision), 0)::integer from public.return_decisions d
   where d.return_id = p_rma and d.kind in ('approved', 'replacement_changed', 'replacement_cancelled', 'cancelled')
$$;
create function pg_temp.body(p_qty numeric) returns jsonb language sql immutable as $$
  select jsonb_build_object('reasonCode', 'other',
           'lines', jsonb_build_array(jsonb_build_object('orderRequestLineId', '03988000-0000-0000-0000-000000000201',
                                                         'quantity', p_qty, 'disposition', 'restock')))
$$;
create function pg_temp.decision(p_rma uuid) returns jsonb language sql as $$
  select jsonb_build_object('lines', (select jsonb_agg(jsonb_build_object('returnLineId', rl.id, 'disposition', 'restock',
                                                                          'restock', jsonb_build_object('target', 'staging')))
                                        from public.return_lines rl where rl.return_id = p_rma))
$$;

-- ══ K1. The grants ════════════════════════════════════════════════════════
select is(
  (select string_agg(t.rel || ':' || p.priv || '=' || has_table_privilege('authenticated', t.rel, p.priv)::text, ','
                     order by t.rel collate "C", p.priv collate "C")
     from unnest(array['public.return_lines', 'public.returns']) t(rel),
          unnest(array['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']) p(priv))
  || '|' || has_any_column_privilege('authenticated', 'public.returns', 'INSERT, UPDATE, REFERENCES')::text
  || '|' || has_any_column_privilege('authenticated', 'public.return_lines', 'INSERT, UPDATE, REFERENCES')::text
  || '|' || (select count(*) from pg_attribute a
              where a.attrelid in ('public.returns'::regclass, 'public.return_lines'::regclass)
                and a.attnum > 0 and not a.attisdropped and a.attacl is not null)::text,
  'public.return_lines:DELETE=false,public.return_lines:INSERT=false,public.return_lines:MAINTAIN=false,'
  || 'public.return_lines:REFERENCES=false,public.return_lines:SELECT=true,public.return_lines:TRIGGER=false,'
  || 'public.return_lines:TRUNCATE=false,public.return_lines:UPDATE=false,'
  || 'public.returns:DELETE=false,public.returns:INSERT=false,public.returns:MAINTAIN=false,'
  || 'public.returns:REFERENCES=false,public.returns:SELECT=true,public.returns:TRIGGER=false,'
  || 'public.returns:TRUNCATE=false,public.returns:UPDATE=false|false|false|0',
  'K1a: authenticated holds SELECT only on returns and return_lines: no table or column write privilege and no column ACL left (plan 3.8 contract; Mutations M1, M2)');
select is(
  (select count(*)::int
     from unnest(array['public.returns', 'public.return_lines']) t(rel),
          unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) p(priv)
    where has_table_privilege('anon', t.rel, p.priv)
       or (p.priv in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') and has_any_column_privilege('anon', t.rel, p.priv)))
  || '|' || (has_table_privilege('service_role', 'public.returns', 'SELECT, INSERT, UPDATE, DELETE')
             and has_table_privilege('service_role', 'public.return_lines', 'SELECT, INSERT, UPDATE, DELETE'))::text,
  '0|true',
  'K1b: anon holds nothing on either table (since 0394); the service role keeps every privilege');

-- ══ K2. Direct PostgREST writes (brief 42) ═════════════════════════════════
select is(
  pg_temp.attempt('authenticated', :mgr,
    format($q$insert into public.returns (organization_id, order_request_id, status, source, requested_by)
              values (%L, %L, 'requested', 'internal', %L)$q$, :org, :ord, :mgr))
  || ',' || pg_temp.attempt('authenticated', :mgr,
    format($q$update public.returns set status = 'approved', approved_by = %L, approved_at = now() where id = %L$q$, :mgr, :rRaw))
  || ',' || pg_temp.attempt('authenticated', :mgr,
    format($q$update public.returns set status = 'cancelled' where id = %L$q$, :rRaw))
  || ',' || pg_temp.attempt('authenticated', :mgr,
    format($q$insert into public.return_lines (return_id, organization_id, order_request_line_id, item_id, quantity, disposition)
              values (%L, %L, %L, %L, 1, 'restock')$q$, :rRaw, :org, :line, :item))
  || ',' || pg_temp.attempt('authenticated', :mgr,
    format($q$update public.return_lines set disposition = 'scrap' where return_id = %L$q$, :rRaw))
  || ',' || pg_temp.attempt('authenticated', :mgr, format('delete from public.returns where id = %L', :rRaw)),
  '42501:-,42501:-,42501:-,42501:-,42501:-,42501:-',
  'K2: a manager (returns:manage, warehouse write) is refused by privilege on every direct write: the RMA insert, the approve and cancel edges the old tabs used, a line insert, a line update and a delete (Mutations M1, M2)');

-- ══ K3. Reads unchanged ═══════════════════════════════════════════════════
select is(
  (select string_agg(x.who || '=' || x.n, ',' order by x.who)
     from (select 'mgr' as who, pg_temp.err(pg_temp.rpc('authenticated', :mgr,
                    format('select to_jsonb((select count(*) from public.returns where id = %L) + (select count(*) from public.return_lines where return_id = %L))', :rRaw, :rRaw)))
                    || '/' || (pg_temp.rpc('authenticated', :mgr,
                    format('select to_jsonb((select count(*) from public.returns where id = %L) + (select count(*) from public.return_lines where return_id = %L))', :rRaw, :rRaw)))::text as n
           union all
           select 'vwr', pg_temp.err(pg_temp.rpc('authenticated', :vwr,
                    format('select to_jsonb((select count(*) from public.returns where id = %L) + (select count(*) from public.return_lines where return_id = %L))', :rRaw, :rRaw)))
                    || '/' || (pg_temp.rpc('authenticated', :vwr,
                    format('select to_jsonb((select count(*) from public.returns where id = %L) + (select count(*) from public.return_lines where return_id = %L))', :rRaw, :rRaw)))::text) x),
  'mgr=ok/2,vwr=ok/2',
  'K3: SELECT is unchanged: a manager and a viewer still read the RMA and its line (returns_select and return_lines_select, every member)');

-- ══ K4. Every function path still passes ══════════════════════════════════
select pg_temp.rpc('authenticated', :mgr,
         format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :ord, pg_temp.body(1))) as "jC" \gset
select coalesce((:'jC'::jsonb)->>'returnId', '00000000-0000-0000-0000-000000000000') as "rC" \gset
select pg_temp.rpc('authenticated', :mgr,
         format('select public.approve_return(%L, %s, %L::jsonb, false)', :'rC', pg_temp.rev(:'rC'), pg_temp.decision(:'rC'))) as "jA" \gset
select pg_temp.rpc('authenticated', :mgr, format('select public.receive_return(%L)', :'rC')) as "jR" \gset
select (select quantity_on_hand from public.inventory_items where id = :item) as "onHandBefore" \gset
select pg_temp.rpc('authenticated', :mgr, format('select public.close_return(%L)', :'rC')) as "jX" \gset
select is(
  pg_temp.err(:'jC'::jsonb) || ':' || pg_temp.err(:'jA'::jsonb) || ':' || pg_temp.err(:'jR'::jsonb) || ':' || pg_temp.err(:'jX'::jsonb)
  || ' | ' || (select status from public.returns where id = :'rC')
  || ':' || (select trim_scale(quantity_on_hand - :'onHandBefore'::numeric)::text from public.inventory_items where id = :item)
  || ':' || ((select quantity_on_hand from public.inventory_items where id = :item)
             = (select coalesce(sum(quantity), 0) from public.item_stock_levels where item_id = :item))::text
  || ':' || (select string_agg(d.kind, ',' order by d.seq) from public.return_decisions d
              where d.return_id = :'rC' and d.kind in ('created', 'approved', 'received', 'closed')),
  'ok:ok:ok:ok | closed:1:true:created,approved,received,closed',
  'K4a: the function path still runs end to end after the contract: create, approve, receive and close; the unit comes back once and holdings equal stock on record; each step is in the decision log');
select pg_temp.rpc('authenticated', :mgr,
         format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :ord, pg_temp.body(1))) as "jD" \gset
select pg_temp.rpc('authenticated', :mgr,
         format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :ord, pg_temp.body(1))) as "jE" \gset
select pg_temp.rpc('service_role', null,
         format($q$select public.create_requester_return_request(%L, %L::jsonb, gen_random_uuid(), '{"channel":"token"}'::jsonb)$q$,
                :ord, pg_temp.body(1))) as "jQ" \gset
select is(
  pg_temp.err(pg_temp.rpc('authenticated', :mgr,
    format($q$select public.deny_return(%L, 'Not ours')$q$, coalesce((:'jD'::jsonb)->>'returnId', '00000000-0000-0000-0000-000000000000'))))
  || ':' || pg_temp.err(pg_temp.rpc('authenticated', :mgr,
    format($q$select public.cancel_return(%L, 0, null)$q$, coalesce((:'jE'::jsonb)->>'returnId', '00000000-0000-0000-0000-000000000000'))))
  || ':' || pg_temp.err(:'jQ'::jsonb)
  || ' | ' || (select string_agg(r.status || '/' || r.source, ',' order by r.status)
                from public.returns r
               where r.id::text in ((:'jD'::jsonb)->>'returnId', (:'jE'::jsonb)->>'returnId', (:'jQ'::jsonb)->>'returnId')),
  'ok:ok:ok | cancelled/internal,denied/internal,requested/requester',
  'K4b: deny, cancel and the requester create (service role) still pass');

-- ══ K5. Defence in depth: a grant restored by mistake still meets the guards
select is(
  pg_temp.attempt('authenticated', :mgr,
    format($q$insert into public.returns (organization_id, order_request_id, status, source, requested_by)
              values (%L, %L, 'received', 'internal', %L)$q$, :org, :ord, :mgr),
    'grant insert on public.returns to authenticated')
  || ',' || pg_temp.attempt('authenticated', :mgr,
    format($q$insert into public.returns (organization_id, order_request_id, status, source, requested_by)
              values (%L, %L, 'requested', 'internal', %L)$q$, :org, :ord, :own),
    'grant insert on public.returns to authenticated')
  || ',' || pg_temp.attempt('authenticated', :mgr,
    format($q$update public.returns set status = 'closed' where id = %L$q$, :rRaw),
    $p$update public.returns set status = 'approved', approved_by = '03988000-0000-0000-0000-0000000000a1', approved_at = now()
        where id = '03988000-0000-0000-0000-000000000301';
       update public.returns set status = 'received', received_by = '03988000-0000-0000-0000-0000000000a1', received_at = now()
        where id = '03988000-0000-0000-0000-000000000301';
       grant update (status, approved_by, approved_at, received_by, received_at, denied_by, denied_at, denial_reason)
         on public.returns to authenticated$p$),
  '42501:return_insert_through_rpc,42501:return_stamp_forged,42501:return_close_through_rpc',
  'K5: with the old grants put back by mistake the guards still refuse an insert at a later status, a forged requester and a raw close (they stay as defence in depth; Mutation M3)');

-- ══ K6. The guards and policies are still installed ═══════════════════════
select is(
  (select string_agg(c.relname || '.' || t.tgname, ',' order by c.relname collate "C", t.tgname collate "C")
     from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where t.tgname in ('trg_returns_zz_api_guard', 'trg_return_lines_zz_api_guard') and not t.tgisinternal)
  || '|' || (select string_agg(p.tablename || '.' || p.policyname, ',' order by p.tablename collate "C", p.policyname collate "C")
               from pg_policies p
              where p.schemaname = 'public' and p.policyname in ('returns_insert', 'returns_update', 'return_lines_insert', 'return_lines_update')),
  'return_lines.trg_return_lines_zz_api_guard,returns.trg_returns_zz_api_guard|'
  || 'return_lines.return_lines_insert,return_lines.return_lines_update,returns.returns_insert,returns.returns_update',
  'K6: both API guards and the four write policies stay installed (defence in depth; Mutation M3)');

-- ══ K7. Recorded on purpose: the frozen wrapper's grants ══════════════════
select is(
  has_function_privilege('authenticated', 'public.process_return_disposition(uuid)', 'EXECUTE')::text
  || ':' || has_function_privilege('anon', 'public.process_return_disposition(uuid)', 'EXECUTE')::text,
  'true:false',
  'K7: the frozen 0359 wrapper keeps EXECUTE for authenticated (plan 1.5 P30; RX-4 records it as an accepted residual in INV-C6) and none for anon');

select * from finish();
rollback;
