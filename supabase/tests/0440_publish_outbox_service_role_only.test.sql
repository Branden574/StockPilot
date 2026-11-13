-- supabase/tests/0440_publish_outbox_service_role_only.test.sql
-- pgTAP proof for the migration publish_outbox_service_role_only (docket
-- S67, second release): publish_outbox executes for the service role only
-- and its body refuses every other caller (a signed-in subject, the anon
-- claim, no claim at all); outbox_events keeps its manager read rule, has no
-- member write rule, anon holds no privilege on it and authenticated SELECT
-- alone. The web app records
-- every export event through its service client
-- (apps/web/src/server/lib/outbox-events.ts). No row of any table changes.
--
-- F.  The function's contract: only the service role executes it (F1, F2);
--     definer, search_path, owner, volatility, arguments and result as before
--     (F3); its comment says so (F4).
-- R.  Signed-in callers are refused: staff, manager, admin and owner of the
--     organization (R1-R4); a viewer, another organization's member and anon
--     (R5, as before); the body alone, run by the table owner with a member's
--     subject set, refuses before anything else, a null organization too
--     (R6); with EXECUTE granted back to authenticated (undone), staff,
--     manager, admin and owner are still refused by the body (R7); with
--     EXECUTE granted back to anon (undone), the anon claim is refused by
--     the body (R8); a session with no claim at all is refused (R9).
-- V.  The service role records each topic the app sends, with the key and
--     payload shape the web helper builds: one id each (V1), a repeated key
--     records nothing (V2), one row each as sent (V3), a null organization is
--     22004 (V4), and the drain's candidate read returns the six (V5).
-- T.  The table: an admin or owner inserts nothing, an admin updates and
--     deletes nothing (T1-T3); the manager read rule still reads, staff read
--     nothing (T4); no write rule for anon, authenticated or PUBLIC (T5); the
--     read rule's text and row security as before (T6); the table privileges,
--     all eight per role (T7); an admin's TRUNCATE is refused (T8).
-- A.  The migration's own preflight and lock prelude, replayed from the
--     statements the CLI recorded (0415's and 0420's method): recorded once
--     each (A1); a second run is refused before changing anything (A2); on
--     the earlier state the preflight passes under any search_path (A3); each
--     planted drift stops it and is named (A4); the prelude takes ACCESS
--     EXCLUSIVE on outbox_events and on every table supautils.policy_grants
--     lists for this role, and on nothing else (A5).
--
-- Roles: fixtures as the test superuser. Every call as an API role runs
-- inside a subtransaction (the role and claims are set with set_config
-- there) that is undone, except the service role's V1 writes, which are kept
-- and reset the role and claims themselves; pgTAP's own statements never run
-- as an API role. begin/rollback: nothing leaks. Made-up data only.
-- Namespace 567b0000.

begin;

select plan(31);

\set orgA '\'567b0000-0000-0000-0000-00000000000a\''
\set orgB '\'567b0000-0000-0000-0000-00000000000b\''

-- Personas, by the last two digits of their ids:
--   01 owner of A     02 admin of A     03 manager of A
--   04 staff of A     05 viewer of A    06 manager of B
\set p01 '\'567b0000-0000-0000-0000-000000000101\''
\set p02 '\'567b0000-0000-0000-0000-000000000102\''
\set p03 '\'567b0000-0000-0000-0000-000000000103\''
\set p04 '\'567b0000-0000-0000-0000-000000000104\''
\set p05 '\'567b0000-0000-0000-0000-000000000105\''
\set p06 '\'567b0000-0000-0000-0000-000000000106\''

insert into auth.users (id, email, raw_user_meta_data)
  select ('567b0000-0000-0000-0000-0000000001' || lpad(g::text, 2, '0'))::uuid,
         'person' || g || '@s67.example.com', '{}'::jsonb
    from generate_series(1, 6) g;
insert into public.organizations (id, name, slug) values
  (:orgA, 'S67 Org A', 's67-org-a'),
  (:orgB, 'S67 Org B', 's67-org-b');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :p01, 'owner',   now()),
  (:orgA, :p02, 'admin',   now()),
  (:orgA, :p03, 'manager', now()),
  (:orgA, :p04, 'staff',   now()),
  (:orgA, :p05, 'viewer',  now()),
  (:orgB, :p06, 'manager', now());

-- == Helpers ===============================================================
-- p_sql (one value) run as p_role with p_sub as the signed-in subject (null:
-- none, as PostgREST sends the service role's key), or as the superuser
-- itself when p_role is null (with no claim at all when p_sub is null too). Returns the value ('null' for none), or
-- 'ERR:<SQLSTATE>' ('ERR:<SQLSTATE>:<message>' when p_msg); 'done' for a
-- statement that returns no rows (p_rowless). p_prep runs
-- first, as the superuser. Undone unless p_keep; when kept, the role and the
-- claims are reset before returning.
create function pg_temp.call(p_role text, p_sub uuid, p_sql text, p_keep boolean default false,
                             p_msg boolean default false, p_prep text default null, p_rowless boolean default false)
returns text language plpgsql as $$
declare v text; v_state text; v_text text; v_out text;
begin
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    perform set_config('request.jwt.claims',
                       case when p_sub is null and p_role is null then ''
                            when p_sub is null then json_build_object('role', p_role)::text
                            else json_build_object('sub', p_sub, 'role', coalesce(p_role, 'authenticated'))::text end,
                       true);
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', coalesce(p_role, ''), true);
    if p_role is not null then
      perform set_config('role', p_role, true);
    end if;
    begin
      if p_rowless then
        execute p_sql;
        v := 'done';
      else
        execute p_sql into v;
      end if;
      v_out := coalesce(v, 'null');
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_text = message_text;
      v_out := 'ERR:' || v_state || case when p_msg then ':' || v_text else '' end;
    end;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claim.role', '', true);
    if not p_keep then
      raise exception using errcode = 'XX567', message = 'undo';
    end if;
  exception when sqlstate 'XX567' then
    null;
  end;
  return v_out;
end $$;

-- A publish call with the web helper's argument names, for one topic.
create function pg_temp.pub(p_org text, p_topic text, p_type text, p_id uuid, p_payload jsonb)
returns text language sql immutable as $$
  select format('select public.publish_outbox(p_org_id => %s, p_topic => %L, p_aggregate_type => %L, '
                'p_aggregate_id => %L, p_payload => %L::jsonb, p_dedupe_key => %L)::text',
                coalesce(quote_literal(p_org) || '::uuid', 'null::uuid'), p_topic, p_type, p_id, p_payload,
                p_topic || ':' || p_id::text)
$$;

-- The six topics the app records, each with the payload shape its caller
-- sends today (purchase-orders.ts, receiving.ts, returns.ts twice,
-- order-requests.ts, api/v1/public/order-requests/route.ts) and a made-up id.
create temporary table s67_topics (topic text, agg_type text, agg_id uuid, payload jsonb) on commit drop;
insert into s67_topics values
  ('purchase_order.ordered', 'purchase_order', '567b0000-0000-0000-0000-0000000e0001',
   '{"poId": "567b0000-0000-0000-0000-0000000e0001"}'),
  ('receipt.posted', 'receipt', '567b0000-0000-0000-0000-0000000e0002',
   '{"purchaseOrderId": "567b0000-0000-0000-0000-0000000e0001", "warehouseId": "567b0000-0000-0000-0000-0000000e0009",
     "receiptNumber": "RCV-0001", "lineCount": 2, "totalAccepted": 5, "totalRejected": 1}'),
  ('return.created', 'return', '567b0000-0000-0000-0000-0000000e0003',
   '{"returnId": "567b0000-0000-0000-0000-0000000e0003", "returnNumber": "RMA-0001",
     "orderRequestId": "567b0000-0000-0000-0000-0000000e0004"}'),
  ('return.closed', 'return', '567b0000-0000-0000-0000-0000000e0005',
   '{"orderRequestId": "567b0000-0000-0000-0000-0000000e0004", "returnNumber": "RMA-0002", "lineCount": 1, "total": 12.5}'),
  ('order.problem', 'order_request', '567b0000-0000-0000-0000-0000000e0004',
   '{"orderRequestId": "567b0000-0000-0000-0000-0000000e0004", "requesterEmail": "requester@example.com",
     "requesterName": "Example Requester", "reason": "Out of stock"}'),
  ('public_request.created', 'order_request', '567b0000-0000-0000-0000-0000000e0006',
   '{"orderRequestId": "567b0000-0000-0000-0000-0000000e0006", "requesterEmail": "public@example.com",
     "requesterName": "Example Public", "status": "pending_confirmation"}');

-- A publish into A in the shape a member's request would send, used by every
-- refusal case.
create function pg_temp.sc() returns text language sql immutable as $$
  select pg_temp.pub('567b0000-0000-0000-0000-00000000000a', 'purchase_order.ordered', 'purchase_order',
                     '567b0000-0000-0000-0000-0000000e0007', '{}')
$$;

-- == F. The function's contract =============================================
select is(
  'anon=' || has_function_privilege('anon', 'public.publish_outbox(uuid,text,text,uuid,jsonb,text)', 'execute')
  || ' authenticated=' || has_function_privilege('authenticated', 'public.publish_outbox(uuid,text,text,uuid,jsonb,text)', 'execute')
  || ' public=' || exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                            where p.oid = 'public.publish_outbox(uuid,text,text,uuid,jsonb,text)'::regprocedure
                              and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  'anon=false authenticated=false public=false',
  'F1: anon, authenticated and PUBLIC cannot execute publish_outbox');

select ok(
  has_function_privilege('service_role', 'public.publish_outbox(uuid,text,text,uuid,jsonb,text)', 'execute'),
  'F2: the service role executes publish_outbox');

select is(
  (select p.prosecdef::text || '|' || array_to_string(p.proconfig, ',') || '|' || pg_get_userbyid(p.proowner)
          || '|' || p.provolatile::text || '|' || pg_get_function_identity_arguments(p.oid)
          || '|' || pg_get_function_result(p.oid)
     from pg_proc p where p.oid = 'public.publish_outbox(uuid,text,text,uuid,jsonb,text)'::regprocedure),
  'true|search_path=public|postgres|v|p_org_id uuid, p_topic text, p_aggregate_type text, p_aggregate_id uuid, p_payload jsonb, p_dedupe_key text|uuid',
  'F3: definer, search_path public, owner postgres, volatile, same arguments and result');

select ok(
  obj_description('public.publish_outbox(uuid,text,text,uuid,jsonb,text)'::regprocedure, 'pg_proc')
    like '%Service role only%signed-in subject, the anon key or a session without the service_role claim, is refused%',
  'F4: the function''s comment says only the service role records events and every other caller is refused');

-- == R. Signed-in callers are refused =======================================
select is(pg_temp.call('authenticated', :p04, pg_temp.sc()), 'ERR:42501',
  'R1: a staff member of the organization is refused (42501)');
select is(pg_temp.call('authenticated', :p03, pg_temp.sc()), 'ERR:42501',
  'R2: a manager of the organization is refused (42501)');
select is(pg_temp.call('authenticated', :p02, pg_temp.sc()), 'ERR:42501',
  'R3: an admin of the organization is refused (42501)');
select is(pg_temp.call('authenticated', :p01, pg_temp.sc()), 'ERR:42501',
  'R4: an owner of the organization is refused (42501)');

select is(
  pg_temp.call('authenticated', :p05, pg_temp.sc()) || ' / ' || pg_temp.call('authenticated', :p06, pg_temp.sc())
  || ' / ' || pg_temp.call('anon', null, pg_temp.sc()),
  'ERR:42501 / ERR:42501 / ERR:42501',
  'R5: a viewer, a member of another organization and anon are refused (42501)');

select is(
  pg_temp.call(null, :p04, pg_temp.sc(), p_msg => true) || ' / ' || pg_temp.call(null, :p01, pg_temp.sc(), p_msg => true)
  || ' / ' || pg_temp.call(null, :p04, pg_temp.pub(null, 'purchase_order.ordered', 'purchase_order',
                                                    '567b0000-0000-0000-0000-0000000e0007', '{}'), p_msg => true),
  'ERR:42501:forbidden / ERR:42501:forbidden / ERR:42501:forbidden',
  'R6: the body itself refuses a signed-in subject before anything else (staff, owner, and a null organization)');

select is(
  (select string_agg(pg_temp.call('authenticated', u::uuid, pg_temp.sc(), p_msg => true,
                                  p_prep => 'grant execute on function public.publish_outbox(uuid, text, text, uuid, jsonb, text) to authenticated'),
                     ' / ' order by o)
     from unnest(array[:p04, :p03, :p02, :p01]) with ordinality t(u, o)),
  'ERR:42501:forbidden / ERR:42501:forbidden / ERR:42501:forbidden / ERR:42501:forbidden',
  'R7: with EXECUTE granted back to authenticated (undone), staff, manager, admin and owner are still refused by the body');

select is(
  pg_temp.call('anon', null, pg_temp.sc(), p_msg => true,
               p_prep => 'grant execute on function public.publish_outbox(uuid, text, text, uuid, jsonb, text) to anon'),
  'ERR:42501:forbidden',
  'R8: with EXECUTE granted back to anon (undone), the anon claim is refused by the body');

select is(
  pg_temp.call(null, null, pg_temp.sc(), p_msg => true),
  'ERR:42501:forbidden',
  'R9: a session with no claim at all (a direct database session, a scheduled job) is refused');

-- == V. The service role records each topic =================================
select is(
  (select string_agg(case when pg_temp.call('service_role', null, pg_temp.pub(:orgA, t.topic, t.agg_type, t.agg_id, t.payload),
                                            p_keep => true) ~ '^[0-9a-f-]{36}$'
                          then 'id' else 'no' end, ',' order by t.topic)
     from s67_topics t),
  'id,id,id,id,id,id',
  'V1: the service role records each of the six topics with the helper''s key and payload, and gets an id');

select is(
  (select string_agg(pg_temp.call('service_role', null, pg_temp.pub(:orgA, t.topic, t.agg_type, t.agg_id, t.payload)),
                     ',' order by t.topic)
     from s67_topics t),
  'null,null,null,null,null,null',
  'V2: the same key again records nothing (no id)');

select is(
  (select count(*)::int from public.outbox_events e join s67_topics t
       on e.topic = t.topic and e.aggregate_type = t.agg_type and e.aggregate_id = t.agg_id
      and e.dedupe_key = t.topic || ':' || t.agg_id::text and e.payload = t.payload and e.published_at is null
    where e.organization_id = :orgA)
  || '/' || (select count(*)::int from public.outbox_events where organization_id = :orgA),
  '6/6',
  'V3: one row per topic in the organization, exactly as sent');

select is(
  pg_temp.call('service_role', null, pg_temp.pub(null, 'purchase_order.ordered', 'purchase_order',
                                                 '567b0000-0000-0000-0000-0000000e0008', '{}'), p_msg => true),
  'ERR:22004:org_required',
  'V4: the service role with a null organization is refused 22004 org_required');

select is(
  pg_temp.call('service_role', null,
    format($q$select string_agg(topic, ',' order by topic) from public.connector_drain_candidates(
               '567b0000-0000-0000-0000-0000000c0001'::uuid, %L::uuid,
               array['purchase_order.ordered', 'receipt.posted', 'return.created', 'return.closed',
                     'order.problem', 'public_request.created'], now(), 200)$q$, :orgA)),
  'order.problem,public_request.created,purchase_order.ordered,receipt.posted,return.closed,return.created',
  'V5: the drain''s candidate read (service role) returns the six rows');

-- == T. The table ===========================================================
select is(
  pg_temp.call('authenticated', :p02, format($q$insert into public.outbox_events
      (organization_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
      values (%L, 'return.closed', 'return', '567b0000-0000-0000-0000-0000000e000a',
              'return.closed:567b0000-0000-0000-0000-0000000e000a', '{}') returning id::text$q$, :orgA))
  || ' / ' ||
  pg_temp.call('authenticated', :p01, format($q$insert into public.outbox_events
      (organization_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
      values (%L, 'return.closed', 'return', '567b0000-0000-0000-0000-0000000e000b',
              'return.closed:567b0000-0000-0000-0000-0000000e000b', '{}') returning id::text$q$, :orgA)),
  'ERR:42501 / ERR:42501',
  'T1: an admin and an owner insert no queue row (42501)');

select is(
  pg_temp.call('authenticated', :p02, format($q$with w as (update public.outbox_events set payload = '{}'::jsonb
      where organization_id = %L returning 1) select count(*)::text from w$q$, :orgA)),
  'ERR:42501',
  'T2: an admin updates no queue row (42501)');

select is(
  pg_temp.call('authenticated', :p02, format($q$with w as (delete from public.outbox_events
      where organization_id = %L returning 1) select count(*)::text from w$q$, :orgA)),
  'ERR:42501',
  'T3: an admin deletes no queue row (42501)');

select is(
  pg_temp.call('authenticated', :p03, format('select count(*)::text from public.outbox_events where organization_id = %L', :orgA))
  || ' / ' ||
  pg_temp.call('authenticated', :p04, format('select count(*)::text from public.outbox_events where organization_id = %L', :orgA))
  || ' / ' ||
  pg_temp.call('authenticated', :p06, format('select count(*)::text from public.outbox_events where organization_id = %L', :orgA)),
  '6 / 0 / 0',
  'T4: a manager still reads the organization''s queue; staff and another organization''s manager read nothing');

select is(
  (select coalesce(string_agg(pol.polname, ','), 'none') from pg_policy pol
    where pol.polrelid = 'public.outbox_events'::regclass and pol.polcmd in ('a', 'w', 'd', '*')
      and pol.polroles && array[0::oid, 'anon'::regrole::oid, 'authenticated'::regrole::oid]),
  'none',
  'T5: outbox_events has no INSERT, UPDATE, DELETE or ALL rule for anon, authenticated or PUBLIC');

create function pg_temp.rules(p_tbl text) returns text language plpgsql as $$
declare v text;
begin
  begin
    perform set_config('search_path', 'public, extensions', true);
    select string_agg(pol.polname || '|' || pol.polcmd::text || '|' || pol.polpermissive::text || '|'
                      || (select string_agg(case x when 0 then 'public' else x::regrole::text end, ',' order by 1)
                            from unnest(pol.polroles) x)
                      || '|' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '-')
                      || '|' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '-'), E'\n' order by pol.polname)
      into v
      from pg_policy pol
     where pol.polrelid = to_regclass(p_tbl);
    raise exception using errcode = 'XX567', message = 'undo';
  exception when sqlstate 'XX567' then
    null;
  end;
  return coalesce(v, 'none');
end $$;

select is(
  pg_temp.rules('public.outbox_events') || E'\nrls=' || (select relrowsecurity from pg_class where oid = 'public.outbox_events'::regclass),
  'outbox_events_select|r|true|authenticated|( SELECT has_org_role(outbox_events.organization_id, ''manager''::text) AS has_org_role)|-'
  || E'\nrls=true',
  'T6: the manager read rule is the table''s only rule, as written before, and row security is on');

select is(
  (select string_agg(g.r || ':' || coalesce((select string_agg(x.p, ',' order by x.n)
                                                from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
                                                                  'REFERENCES', 'TRIGGER', 'MAINTAIN']) with ordinality x(p, n)
                                               where has_table_privilege(g.r, 'public.outbox_events', x.p)), '-'),
                     ' ' order by g.r)
     from unnest(array['anon', 'authenticated', 'service_role']) g(r)),
  'anon:- authenticated:SELECT service_role:SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN',
  'T7: anon holds no privilege on outbox_events, authenticated SELECT alone (for the read rule), the service role all eight');

select is(
  pg_temp.call('authenticated', :p02, 'truncate public.outbox_events cascade', p_rowless => true),
  'ERR:42501',
  'T8: an admin''s TRUNCATE of the queue is refused (42501)');

-- == A. The migration's own preflight and lock prelude ======================
-- The statements the CLI recorded for this file that contain p_tag, found by
-- the file's name so a renumbering does not change this section. The tags
-- are the file's own, $pre_s67$ and $lock_s67$.
create function pg_temp.mig(p_tag text) returns text language sql stable as $$
  select coalesce(string_agg(st, E';\n'), '')
    from supabase_migrations.schema_migrations m, unnest(m.statements) st
   where m.name = 'publish_outbox_service_role_only' and position(p_tag in st) > 0
$$;
create function pg_temp.mig_count(p_tag text) returns bigint language sql stable as $$
  select count(*)
    from supabase_migrations.schema_migrations m, unnest(m.statements) st
   where m.name = 'publish_outbox_service_role_only' and position(p_tag in st) > 0
$$;
-- The earlier state: 0341's publish_outbox (its body word for word) and
-- grants, 0140's write rule, and 0402's table grants for anon and
-- authenticated.
create function pg_temp.pre_s67() returns text language sql immutable as $p$
  select $s$create or replace function public.publish_outbox(
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
grant execute on function public.publish_outbox(uuid, text, text, uuid, jsonb, text) to authenticated;
create policy outbox_events_write on public.outbox_events
  for all to authenticated
  using ((SELECT public.has_org_role(organization_id, 'admin')))
  with check ((SELECT public.has_org_role(organization_id, 'admin')));
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.outbox_events to anon, authenticated$s$
$p$;
-- The preflight run again after p_prep, ALWAYS undone: 'ok', or
-- '<sqlstate>:<hint>:' and the checks its message reports, sorted; 'missing'
-- when the CLI recorded no preflight (an empty EXECUTE would read as 'ok').
create function pg_temp.try_pre(p_prep text) returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text;
begin
  if pg_temp.mig('$pre_s67$') = '' then
    return 'missing';
  end if;
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    execute pg_temp.mig('$pre_s67$');
    raise exception using errcode = 'XXT67', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XXT67' then
    return 'ok';
  end if;
  return v_state || ':' || coalesce(nullif(v_hint, ''), '-') || ':'
         || coalesce((select string_agg(m[1], ', ' order by m[1] collate "C")
                        from regexp_matches(v_msg, '(\S+ drifted|\S+ missing|\S+ rules|\S+ row security|\S+ privileges)', 'g') m),
                     v_msg);
end $$;
-- The tables (outside the catalogs) this backend holds in ACCESS EXCLUSIVE
-- mode after p_sql, ALWAYS undone (the locks go with the subtransaction);
-- 'missing' for an empty p_sql.
create function pg_temp.ae_locks(p_sql text) returns text language plpgsql as $$
declare v text;
begin
  if p_sql = '' then
    return 'missing';
  end if;
  begin
    if p_sql is not null then
      execute p_sql;
    end if;
    select string_agg(distinct n.nspname || '.' || c.relname, ',' order by n.nspname || '.' || c.relname) into v
      from pg_locks l
      join pg_class c on c.oid = l.relation
      join pg_namespace n on n.oid = c.relnamespace
     where l.pid = pg_backend_pid() and l.locktype = 'relation' and l.granted
       and l.mode = 'AccessExclusiveLock' and c.relpersistence = 'p'
       and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema');
    raise exception using errcode = 'XXT67', message = 'undo';
  exception when sqlstate 'XXT67' then
    null;
  end;
  return coalesce(v, 'none');
end $$;

select is(
  pg_temp.mig_count('$pre_s67$')::text || '/' || pg_temp.mig_count('$lock_s67$')::text,
  '1/1',
  'A1: the CLI recorded the preflight and the lock prelude exactly once each (this section runs that text)');

select is(
  pg_temp.try_pre(null),
  '55000:s67_preflight:public.outbox_events privileges, public.outbox_events rules, public.publish_outbox drifted',
  'A2: run again after the migration, the preflight stops before changing anything (55000) and names the function, the rules and the privileges');

select is(
  pg_temp.try_pre(pg_temp.pre_s67()) || ' / ' || pg_temp.try_pre(pg_temp.pre_s67() || $p$;set local search_path = ''$p$)
  || ' / ' || pg_temp.try_pre(pg_temp.pre_s67() || $p$;set local search_path = pg_catalog$p$),
  'ok / ok / ok',
  'A3: on the earlier state the preflight passes, under the session''s search_path, an empty one and pg_catalog alone');

select is(
  pg_temp.try_pre(pg_temp.pre_s67() || $p$;
create or replace function public.publish_outbox(p_org_id uuid, p_topic text, p_aggregate_type text, p_aggregate_id uuid,
  p_payload jsonb, p_dedupe_key text default null) returns uuid
language plpgsql security definer set search_path = public as $f$ begin return null; end $f$$p$)
  || ' / ' || pg_temp.try_pre(pg_temp.pre_s67() || $p$;
revoke execute on function public.publish_outbox(uuid, text, text, uuid, jsonb, text) from authenticated$p$)
  || ' / ' || pg_temp.try_pre(pg_temp.pre_s67() || $p$;
create policy s67_extra_insert on public.outbox_events for insert to authenticated with check (true)$p$)
  || ' / ' || pg_temp.try_pre(pg_temp.pre_s67() || $p$;
alter table public.outbox_events disable row level security$p$)
  || ' / ' || pg_temp.try_pre(pg_temp.pre_s67() || $p$;
revoke insert on table public.outbox_events from anon$p$)
  || ' / ' || pg_temp.try_pre(pg_temp.pre_s67() || $p$;
grant select on table public.outbox_events to public$p$)
  || ' / ' || pg_temp.try_pre(pg_temp.pre_s67() || $p$;
revoke truncate, references, trigger, maintain on table public.outbox_events from anon, authenticated$p$),
  '55000:s67_preflight:public.publish_outbox drifted / '
  '55000:s67_preflight:public.publish_outbox drifted / '
  '55000:s67_preflight:public.outbox_events rules / '
  '55000:s67_preflight:public.outbox_events row security / '
  '55000:s67_preflight:public.outbox_events privileges / '
  '55000:s67_preflight:public.outbox_events privileges / '
  'ok',
  'A4: on that state each planted drift stops it and is named: another body, authenticated without EXECUTE, a third rule, row security off, a table privilege gone, a grant to PUBLIC; the queued grants cleanup''s state passes');

select is(
  pg_temp.ae_locks(null) || ' / ' || pg_temp.ae_locks(pg_temp.mig('$lock_s67$')),
  'none / ' || (select string_agg(x, ',' order by x) from (
                  select 'public.outbox_events' as x
                  union
                  select n.nspname || '.' || c.relname
                    from jsonb_array_elements_text(coalesce(nullif(current_setting('supautils.policy_grants', true), '')::jsonb
                                                            -> current_user::text, '[]'::jsonb)) g(name)
                    join pg_class c on c.oid = to_regclass(g.name)
                    join pg_namespace n on n.oid = c.relnamespace) s),
  'A5: the lock prelude takes ACCESS EXCLUSIVE on outbox_events and on every table supautils.policy_grants lists for this role, at once, and on nothing else');

select * from finish();
rollback;
