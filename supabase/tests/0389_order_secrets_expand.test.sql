-- supabase/tests/0389_order_secrets_expand.test.sql
--
-- Proves migration 0389 (slice B, order secrets expand): a newly minted order
-- signature token is stored as its sha256 on the order row every member
-- reads, the raw token lives only in the service-only order_request_secrets,
-- and the return token is minted there once and never rotated.
--
-- S. The side table's posture:
--    S1  RLS on, no policy;
--    S2  anon and authenticated hold none of SELECT, INSERT, UPDATE, DELETE,
--        TRUNCATE, REFERENCES, TRIGGER, MAINTAIN; service_role holds exactly
--        SELECT, INSERT, UPDATE, DELETE; no PUBLIC entry in the ACL;
--    S3  not in supabase_realtime (and the publication is not FOR ALL TABLES);
--    S4  its columns, keys, CHECKs (64 lowercase hex for the two text
--        tokens, the image length cap) and the two ON DELETE CASCADE keys,
--        neither DEFERRABLE; S4c the CHECKs refuse a bad token;
--    S5  an order delete cascades to its side row;
--    S6  as an API role (rolled back) it cannot be read or written: 42501.
-- G. generate_order_packing_slips gates (each always undone):
--    G1 unauthenticated 42501; G2 a member of another organization P0002, an
--    unknown order P0002 (the same answer); G3 the orders module off P0001
--    module_disabled; G4 staff without orders:approve and a viewer 42501
--    orders_approve; G5 an approver with no write access to the order's
--    warehouse 42501 warehouse_write; G6 an approved order P0001
--    packing_slips_not_ready (detail approved); G7 a signed order P0001
--    order_already_signed; G8 anon cannot execute it.
-- M. The mint (kept):
--    M1 a manager mints a picking-complete order: status, stamps, a 30-day
--       expiry; M2 the order column is encode(digest(side, 'sha256'), 'hex'),
--       64 lowercase hex, never the raw token; the side row carries the
--       order's organization; M3 the returned row carries the digest; M4 a
--       staff approver (orders:approve override) mints too; M5 regenerating
--       changes both values and the old raw token no longer hashes to the
--       column; M6 the 'abc' vector (Node's sha256Hex pins the same);
--    M7 the mint pinged nobody (no notification row for the org).
-- C. Completing the hand-over:
--    C1 confirm_order_signature (frozen, service_role) with the RAW token
--       records nothing (the column holds the digest: the sign route must
--       hash); C2 with the digest it completes the order.
-- V. A viewer (rolled-back claims) reads the digest from the column, never
--    the raw token, and cannot read the side table (42501).
-- R. reopen_picking (frozen) clears the column after a mint; the side token
--    is then stale (its digest is not the column) and the mint refuses the
--    reopened order (packing_slips_not_ready).
-- E. order_return_token_ensure: E1 service_role only (authenticated and anon
--    42501); E2 mints a uuid for an order with none; E3 is idempotent; E4
--    reuses a legacy order-column token (already emailed); E5 never rotates
--    a side token, even when the column holds another; E6 keeps an existing
--    side row's signature token; E7 null for an unknown order; E8 writes
--    nothing to the order row.
-- P. Posture and frozen pins: P1 both functions SECURITY DEFINER, owned by
--    postgres, search_path and lock_timeout pinned, their grants; P2 the
--    comments name 0389; P3 confirm_order_signature, reopen_picking,
--    resume_fulfillment, the transition trigger, the insert guard and the
--    0387 guard keep their md5; P4 authenticated's UPDATE columns on
--    order_requests are unchanged (19, signature_token among them until
--    slice C); P5 no 40001/40P01 in either body; P6 0389 adds no
--    non-internal trigger to order_requests and none to the side table.
--
-- Roles: fixtures as the test superuser. Attempts run through pg_temp.attempt
-- (always undone) or pg_temp.call_as (kept), the 0387 helpers. begin/rollback:
-- nothing leaks. Namespace 03890000.

begin;

select plan(61);

\set orgA   '\'03890000-0000-0000-0000-00000000000a\''
\set orgZ   '\'03890000-0000-0000-0000-00000000000b\''
\set own    '\'03890000-0000-0000-0000-0000000000a0\''
\set mgr    '\'03890000-0000-0000-0000-0000000000a1\''
\set req    '\'03890000-0000-0000-0000-0000000000a2\''
\set stf    '\'03890000-0000-0000-0000-0000000000a3\''
\set stfAp  '\'03890000-0000-0000-0000-0000000000a4\''
\set stfAp2 '\'03890000-0000-0000-0000-0000000000a5\''
\set vwr    '\'03890000-0000-0000-0000-0000000000a6\''
\set mgrZ   '\'03890000-0000-0000-0000-0000000000b1\''
\set whA    '\'03890000-0000-0000-0000-0000000000d1\''
\set whB    '\'03890000-0000-0000-0000-0000000000d2\''
\set whZ    '\'03890000-0000-0000-0000-0000000000d3\''
\set itG    '\'03890000-0000-0000-0000-0000000000f0\''
-- Orders.
\set oM1    '\'03890000-0000-0000-0000-000000000101\''
\set oM4    '\'03890000-0000-0000-0000-000000000104\''
\set oApr   '\'03890000-0000-0000-0000-000000000110\''
\set oSig   '\'03890000-0000-0000-0000-000000000111\''
\set oSign  '\'03890000-0000-0000-0000-000000000120\''
\set oReo   '\'03890000-0000-0000-0000-000000000130\''
\set oDel   '\'03890000-0000-0000-0000-000000000140\''
\set oE2    '\'03890000-0000-0000-0000-000000000152\''
\set oE4    '\'03890000-0000-0000-0000-000000000154\''
\set oE5    '\'03890000-0000-0000-0000-000000000155\''
\set oE6    '\'03890000-0000-0000-0000-000000000156\''
\set lSign  '\'03890000-0000-0000-0000-000000000320\''
\set lReo   '\'03890000-0000-0000-0000-000000000330\''
\set retLeg '\'03890000-0000-4000-8000-0000000004a4\''
\set retSide '\'03890000-0000-4000-8000-0000000004a5\''
\set retCol  '\'03890000-0000-4000-8000-0000000004c5\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,    '0389-own@test.local',    '{}'::jsonb),
  (:mgr,    '0389-mgr@test.local',    '{}'::jsonb),
  (:req,    '0389-req@test.local',    '{}'::jsonb),
  (:stf,    '0389-stf@test.local',    '{}'::jsonb),
  (:stfAp,  '0389-stfap@test.local',  '{}'::jsonb),
  (:stfAp2, '0389-stfap2@test.local', '{}'::jsonb),
  (:vwr,    '0389-vwr@test.local',    '{}'::jsonb),
  (:mgrZ,   '0389-mgrz@test.local',   '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:orgA, '0389 Secrets A', '0389-secrets-a'),
  (:orgZ, '0389 Secrets Z', '0389-secrets-z');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :own,    'owner',   now()),
  (:orgA, :mgr,    'manager', now()),
  (:orgA, :req,    'staff',   now()),
  (:orgA, :stf,    'staff',   now()),
  (:orgA, :stfAp,  'staff',   now()),
  (:orgA, :stfAp2, 'staff',   now()),
  (:orgA, :vwr,    'viewer',  now()),
  (:orgZ, :mgrZ,   'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgA, '0389 Main',  'WH-0389A', 'active'),
  (:whB, :orgA, '0389 Other', 'WH-0389B', 'active'),
  (:whZ, :orgZ, '0389 Zed',   'WH-0389Z', 'active');
-- stfAp2 holds orders:approve but writes only warehouse B (G5).
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :req,    :whA, true),
  (:orgA, :stf,    :whA, true),
  (:orgA, :stfAp,  :whA, true),
  (:orgA, :stfAp2, :whB, true),
  (:orgA, :vwr,    :whA, true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :stfAp,  'orders:approve', true),
  (:orgA, :stfAp2, 'orders:approve', true);
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type) values
  (:itG, :orgA, :whA, '0389-G', 'Secrets general', 100, 'active', 'none');

-- Orders at their status, inserted by the superuser (the insert guard holds
-- API roles only; the transition trigger fires on UPDATE only).
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type,
   approved_by, approved_at, signed_at, return_token) values
  (:oM1,   :orgA, :whA, 'picking_complete',       'internal', :req, 'pickup', :mgr, now(), null,  null),
  (:oM4,   :orgA, :whA, 'picking_complete',       'internal', :req, 'pickup', :mgr, now(), null,  null),
  (:oApr,  :orgA, :whA, 'approved',               'internal', :req, 'pickup', :mgr, now(), null,  null),
  (:oSig,  :orgA, :whA, 'packing_slip_generated', 'internal', :req, 'pickup', :mgr, now(), now(), null),
  (:oSign, :orgA, :whA, 'picking_complete',       'internal', :req, 'pickup', :mgr, now(), null,  null),
  (:oReo,  :orgA, :whA, 'picking_complete',       'internal', :req, 'pickup', :mgr, now(), null,  null),
  (:oDel,  :orgA, :whA, 'picking_complete',       'internal', :req, 'pickup', :mgr, now(), null,  null),
  (:oE2,   :orgA, :whA, 'completed',              'internal', :req, 'pickup', :mgr, now(), now(), null),
  (:oE4,   :orgA, :whA, 'completed',              'internal', :req, 'pickup', :mgr, now(), now(), :retLeg),
  (:oE5,   :orgA, :whA, 'completed',              'internal', :req, 'pickup', :mgr, now(), now(), :retCol),
  (:oE6,   :orgA, :whA, 'completed',              'internal', :req, 'pickup', :mgr, now(), now(), null);
insert into public.order_request_lines
  (id, order_request_id, item_id, quantity_requested, quantity_fulfilled, quantity_picked) values
  (:lSign, :oSign, :itG, 5, 0, 5),
  (:lReo,  :oReo,  :itG, 5, 0, null);
-- E5: a side token already issued, while the column holds another value.
insert into public.order_request_secrets (order_request_id, organization_id, return_token) values
  (:oE5, :orgA, :retSide);
-- E6: a side row that already carries a signature token.
insert into public.order_request_secrets (order_request_id, organization_id, signature_token) values
  (:oE6, :orgA, repeat('e', 64));

-- ══ Helpers (the 0387 shapes) ═════════════════════════════════════════════
create function pg_temp.hint(p_hint text) returns text language sql immutable as $$
  select case when p_hint is null or p_hint = ''
                or p_hint like 'Grant the required privileges to the current role with:%'
              then '-' else p_hint end
$$;
-- One statement as p_as with p_sub's claims, then ALWAYS undone.
-- 'ok:<rows>[:<p_check>]', else '<sqlstate>:<hint or ->:<message>[:<P0001 detail>]'.
create function pg_temp.attempt(p_as text, p_sub uuid, p_sql text, p_prep text default null, p_check text default null)
returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text; v_detail text; v_n bigint; v_seen text;
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
    if p_check is not null then
      execute p_check into v_seen;
    end if;
    raise exception using errcode = 'XX389', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint,
                            v_detail = pg_exception_detail;
  end;
  if v_state = 'XX389' then
    return 'ok:' || v_n::text || coalesce(':' || v_seen, '');
  end if;
  -- The detail only for this suite's own P0001 raises (it carries the status);
  -- a constraint violation's detail quotes the failing row.
  return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg
         || case when v_state = 'P0001' and coalesce(v_detail, '') <> '' then ':' || v_detail else '' end;
end $$;
-- One statement that returns a value, as p_as, KEPT when it succeeds.
create function pg_temp.call_as(p_as text, p_sub uuid, p_sql text, p_check text default null)
returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text; v text; v_seen text;
begin
  begin
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_as, true);
    perform set_config('role', p_as, true);
    execute p_sql into v;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claim.role', '', true);
    if p_check is not null then
      execute p_check into v_seen;
    end if;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
    return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
  end;
  return coalesce(v, 'null') || coalesce('|' || v_seen, '');
end $$;
-- The side token of an order, read as the superuser.
create function pg_temp.side_raw(p_id uuid) returns text language sql as $$
  select s.signature_token from public.order_request_secrets s where s.order_request_id = p_id
$$;
create function pg_temp.col(p_id uuid) returns text language sql as $$
  select o.signature_token from public.order_requests o where o.id = p_id
$$;
create function pg_temp.sha(p text) returns text language sql immutable as $$
  select encode(extensions.digest(p, 'sha256'), 'hex')
$$;

-- ══ S. The side table ═════════════════════════════════════════════════════
select is(
  (select c.relrowsecurity::text || '|' || (select count(*) from pg_policy p where p.polrelid = c.oid)::text
     from pg_class c where c.oid = 'public.order_request_secrets'::regclass),
  'true|0',
  'S1: order_request_secrets has RLS on and no policy (shaped like order_email_log)');
select is(
  (select string_agg(r || ':' || p || '=' || has_table_privilege(r, 'public.order_request_secrets', p)::text, ',' order by r, p)
     from unnest(array['anon', 'authenticated']) r,
          unnest(array['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']) p
    where has_table_privilege(r, 'public.order_request_secrets', p)),
  null,
  'S2a: anon and authenticated hold no privilege at all on order_request_secrets');
select is(
  (select string_agg(p || '=' || has_table_privilege('service_role', 'public.order_request_secrets', p)::text, ',' order by p)
     from unnest(array['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']) p),
  'DELETE=true,INSERT=true,MAINTAIN=false,REFERENCES=false,SELECT=true,TRIGGER=false,TRUNCATE=false,UPDATE=true',
  'S2b: service_role (the admin client) holds exactly SELECT, INSERT, UPDATE and DELETE');
select is(
  (select coalesce(bool_or(a.grantee = 0), false)::text
     from pg_class c, aclexplode(c.relacl) a where c.oid = 'public.order_request_secrets'::regclass),
  'false',
  'S2c: no PUBLIC entry survives in the ACL');
select is(
  (select count(*)::text from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'order_request_secrets')
  || '|' || coalesce((select puballtables::text from pg_publication where pubname = 'supabase_realtime'), 'none'),
  '0|false',
  'S3: order_request_secrets is not in supabase_realtime, which is not FOR ALL TABLES');
select is(
  (select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text, ',' order by a.attnum)
     from pg_attribute a where a.attrelid = 'public.order_request_secrets'::regclass and a.attnum > 0 and not a.attisdropped),
  'order_request_id:uuid:true,organization_id:uuid:true,signature_token:text:false,return_token:uuid:false,'
  'public_track_token:text:false,signature_data_url:text:false,created_at:timestamp with time zone:true,'
  'updated_at:timestamp with time zone:true',
  'S4a: the columns, their types and NOT NULLs');
select is(
  (select string_agg(x, E'\n' order by x collate "C") from (
     select c.contype::text || ':'
            || (select string_agg(a.attname, ',' order by a.attnum) from pg_attribute a
                 where a.attrelid = c.conrelid and a.attnum = any (c.conkey)) || ':'
            || coalesce((select r.relname from pg_class r where r.oid = c.confrelid), '-') || ':'
            || case when c.contype = 'f' then c.confdeltype::text else '-' end || ':'
            || c.condeferrable::text as x
       from pg_constraint c
      where c.conrelid = 'public.order_request_secrets'::regclass and c.contype in ('f', 'p', 'u')) t),
  E'f:order_request_id:order_requests:c:false\n'
  'f:organization_id:organizations:c:false\n'
  'p:order_request_id:-:-:false\n'
  'u:public_track_token:-:-:false\n'
  'u:return_token:-:-:false\n'
  'u:signature_token:-:-:false',
  'S4b: one row per order; the three tokens unique; both foreign keys cascade on delete and none is DEFERRABLE');
select is(
  pg_temp.attempt('postgres', null,
                  format($q$insert into public.order_request_secrets (order_request_id, organization_id, signature_token) values (%L, %L, %L)$q$,
                         :oDel, :orgA, upper(repeat('a', 64)))),
  '23514:-:new row for relation "order_request_secrets" violates check constraint "order_request_secrets_signature_token_check"',
  'S4c: the signature token CHECK refuses anything but 64 lowercase hex');
select is(
  pg_temp.attempt('postgres', null,
                  format($q$insert into public.order_request_secrets (order_request_id, organization_id, public_track_token) values (%L, %L, 'not-hex')$q$,
                         :oDel, :orgA)),
  '23514:-:new row for relation "order_request_secrets" violates check constraint "order_request_secrets_public_track_token_check"',
  'S4d: the track token CHECK refuses anything but 64 lowercase hex');
select is(
  pg_temp.attempt('postgres', null,
                  format($q$insert into public.order_request_secrets (order_request_id, organization_id, signature_data_url) values (%L, %L, repeat('x', 524289))$q$,
                         :oDel, :orgA)),
  '23514:-:new row for relation "order_request_secrets" violates check constraint "order_request_secrets_signature_data_url_check"',
  'S4e: the image CHECK caps a stored signature at 524288 characters, as the order column does');
select is(
  pg_temp.attempt('postgres', null,
                  format($q$delete from public.order_requests where id = %L$q$, :oDel),
                  format($q$insert into public.order_request_secrets (order_request_id, organization_id, signature_token) values (%L, %L, repeat('c', 64))$q$, :oDel, :orgA),
                  format('select count(*)::text from public.order_request_secrets where order_request_id = %L', :oDel)),
  'ok:1:0',
  'S5: deleting an order (the unconfirmed cleanup, a submit rollback) deletes its side row');
select is(
  pg_temp.attempt('authenticated', :mgr, 'select count(*) from public.order_request_secrets'),
  '42501:-:permission denied for table order_request_secrets',
  'S6a: a manager cannot read order_request_secrets through PostgREST');
select is(
  pg_temp.attempt('authenticated', :mgr,
                  format($q$insert into public.order_request_secrets (order_request_id, organization_id, signature_token) values (%L, %L, repeat('c', 64))$q$, :oM4, :orgA)),
  '42501:-:permission denied for table order_request_secrets',
  'S6b: nor write it');
select is(
  pg_temp.attempt('anon', null, 'select count(*) from public.order_request_secrets'),
  '42501:-:permission denied for table order_request_secrets',
  'S6c: nor can anon');

-- Notifications for the organization before any mint (the fixture inserts
-- may have pinged someone; M7 compares against this).
create temp table n0 as
  select count(*) as n from public.notifications where organization_id = :orgA;

-- ══ G. The mint's gates (each undone) ═════════════════════════════════════
select is(
  pg_temp.attempt('authenticated', null, format('select public.generate_order_packing_slips(%L)', :oM1)),
  '42501:-:unauthenticated',
  'G1: no signed-in user: 42501 unauthenticated');
select is(
  pg_temp.attempt('authenticated', :mgrZ, format('select public.generate_order_packing_slips(%L)', :oM1)),
  'P0002:-:order_request_not_found',
  'G2a: a manager of another organization: P0002, the same answer as an unknown order');
select is(
  pg_temp.attempt('authenticated', :mgr, $q$select public.generate_order_packing_slips('03890000-0000-0000-0000-00000000dead')$q$),
  'P0002:-:order_request_not_found',
  'G2b: an unknown order: P0002');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select public.generate_order_packing_slips(%L)', :oM1),
                  format($q$update public.organization_modules set enabled = false where organization_id = %L and module_id = 'orders'$q$, :orgA)),
  'P0001:module_disabled:module_disabled',
  'G3: the orders module off: P0001 module_disabled');
select is(
  pg_temp.attempt('authenticated', :stf, format('select public.generate_order_packing_slips(%L)', :oM1)),
  '42501:orders_approve:forbidden',
  'G4a: staff without orders:approve: 42501 orders_approve');
select is(
  pg_temp.attempt('authenticated', :vwr, format('select public.generate_order_packing_slips(%L)', :oM1)),
  '42501:orders_approve:forbidden',
  'G4b: a viewer: 42501 orders_approve');
select is(
  pg_temp.attempt('authenticated', :stfAp2, format('select public.generate_order_packing_slips(%L)', :oM1)),
  '42501:warehouse_write:forbidden',
  'G5: an approver who cannot write the order''s warehouse: 42501 warehouse_write');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select public.generate_order_packing_slips(%L)', :oApr)),
  'P0001:packing_slips_not_ready:packing_slips_not_ready:approved',
  'G6: an approved order (picking not complete): P0001 packing_slips_not_ready, detail the status');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select public.generate_order_packing_slips(%L)', :oSig)),
  'P0001:order_already_signed:order_already_signed',
  'G7: a signed order: P0001 order_already_signed (re-minting would orphan the signed record)');
select is(
  pg_temp.attempt('anon', null, format('select public.generate_order_packing_slips(%L)', :oM1)),
  '42501:-:permission denied for function generate_order_packing_slips',
  'G8: anon cannot execute the mint');
select is(
  pg_temp.col(:oM1) is null and pg_temp.side_raw(:oM1) is null,
  true,
  'G9: no refused attempt left a token on the order or a side row');

-- ══ M. The mint (kept) ════════════════════════════════════════════════════
select is(
  pg_temp.call_as('authenticated', :mgr,
                  format('select r.status || ''/'' || (r.signature_token = encode(extensions.digest(%L, ''sha256''), ''hex''))::text from public.generate_order_packing_slips(%L) r',
                         'never-the-raw', :oM1),
                  format($q$select o.status || '/' || (o.packing_slip_generated_by = %L)::text || '/'
                                   || (o.packing_slip_generated_at > now() - interval '1 minute')::text || '/'
                                   || (o.signature_token_expires_at between now() + interval '29 days 23 hours' and now() + interval '30 days 1 hour')::text
                              from public.order_requests o where o.id = %L$q$, :mgr, :oM1)),
  'packing_slip_generated/false|packing_slip_generated/true/true/true',
  'M1: a manager mints a picking-complete order: packing_slip_generated, stamped by them now, the token valid 30 days');
select is(
  (select (o.signature_token = pg_temp.sha(s.signature_token))::text || '|'
          || (o.signature_token ~ '^[0-9a-f]{64}$')::text || '|' || (s.signature_token ~ '^[0-9a-f]{64}$')::text || '|'
          || (o.signature_token <> s.signature_token)::text || '|' || (s.organization_id = o.organization_id)::text
     from public.order_requests o join public.order_request_secrets s on s.order_request_id = o.id where o.id = :oM1),
  'true|true|true|true|true',
  'M2: the order column is sha256(side token) as 64 lowercase hex, never the raw token; the side row carries the order''s organization');
create temp table m3 as select null::text as returned;
update m3 set returned = pg_temp.call_as('authenticated', :mgr,
                                         format('select r.signature_token from public.generate_order_packing_slips(%L) r', :oM4));
select is(
  (select returned from m3),
  pg_temp.col(:oM4),
  'M3: the row the mint returns is the stored row, carrying the digest');
select is(
  (select (pg_temp.col(:oM4) = pg_temp.sha(pg_temp.side_raw(:oM4)))::text || '|'
          || (pg_temp.col(:oM4) <> pg_temp.side_raw(:oM4))::text),
  'true|true',
  'M3b: and that value is sha256(side token), not the token');
create temp table m5_before as
  select pg_temp.col(:oM1) as col, pg_temp.side_raw(:oM1) as raw;
select is(
  pg_temp.call_as('authenticated', :stfAp, format('select r.status from public.generate_order_packing_slips(%L) r', :oM1)),
  'packing_slip_generated',
  'M4: a staff member granted orders:approve regenerates (packing_slip_generated -> packing_slip_generated)');
select is(
  (select (b.col <> pg_temp.col(:oM1))::text || '|' || (b.raw <> pg_temp.side_raw(:oM1))::text || '|'
          || (pg_temp.sha(b.raw) = pg_temp.col(:oM1))::text || '|' || (pg_temp.sha(pg_temp.side_raw(:oM1)) = pg_temp.col(:oM1))::text
          || '|' || (select (packing_slip_generated_by = :stfAp)::text from public.order_requests where id = :oM1)
     from m5_before b),
  'true|true|false|true|true',
  'M5: regenerating replaces both values: the old raw token (a printed QR) no longer hashes to the column, the new one does');
select is(
  pg_temp.sha('abc'),
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  'M6: the digest vector Node''s sha256Hex pins too (Postgres and the app agree)');
select is(
  (select (count(*) - (select n from n0))::text from public.notifications where organization_id = :orgA),
  '0',
  'M7: moving picking_complete -> packing_slip_generated (and regenerating) pinged nobody');

-- ══ C. Completing the hand-over with the digest ═══════════════════════════
select is(
  pg_temp.call_as('authenticated', :mgr, format('select r.status from public.generate_order_packing_slips(%L) r', :oSign)),
  'packing_slip_generated',
  'C0: oSign minted');
update public.order_requests set status = 'staged_for_pickup' where id = :oSign;
select is(
  pg_temp.call_as('service_role', null,
                  format($q$select coalesce(public.confirm_order_signature(%L, %L, 'Pat Signer', 'pat@example.com', 'data:image/png;base64,AAAA')::text, 'null')$q$,
                         :oSign, pg_temp.side_raw(:oSign))),
  'null',
  'C1: confirm_order_signature (frozen) with the RAW token records nothing: the column holds its digest, so the sign route hashes first');
select is(
  pg_temp.call_as('service_role', null,
                  format($q$select (public.confirm_order_signature(%L, %L, 'Pat Signer', 'pat@example.com', 'data:image/png;base64,AAAA') = %L)::text$q$,
                         :oSign, pg_temp.col(:oSign), :orgA),
                  format('select status || ''/'' || signature_method from public.order_requests where id = %L', :oSign)),
  'true|completed/digital',
  'C2: with the digest it completes the hand-over');

-- ══ V. What a viewer reads ════════════════════════════════════════════════
select is(
  pg_temp.call_as('authenticated', :vwr,
                  format($q$select (o.signature_token = %L)::text || '/' || (o.signature_token = %L)::text from public.order_requests o where o.id = %L$q$,
                         pg_temp.col(:oM1), pg_temp.side_raw(:oM1), :oM1)),
  'true/false',
  'V1: a viewer reads the digest from the order column, never the raw token');
select is(
  pg_temp.attempt('authenticated', :vwr, format('select signature_token from public.order_request_secrets where order_request_id = %L', :oM1)),
  '42501:-:permission denied for table order_request_secrets',
  'V2: and cannot read the side table');

-- ══ R. A reopen clears the column; the side token is stale ════════════════
select is(
  pg_temp.call_as('authenticated', :mgr, format('select r.status from public.generate_order_packing_slips(%L) r', :oReo)),
  'packing_slip_generated',
  'R0: oReo minted');
select is(
  pg_temp.call_as('authenticated', :mgr, format($q$select r.status from public.reopen_picking(%L, 'Miscount') r$q$, :oReo),
                  format('select coalesce(signature_token, ''null'') from public.order_requests where id = %L', :oReo)),
  'picking_in_progress|null',
  'R1: reopen_picking (frozen) still clears the order''s token');
select is(
  (select (pg_temp.side_raw(:oReo) is not null)::text || '|'
          || coalesce((pg_temp.sha(pg_temp.side_raw(:oReo)) = pg_temp.col(:oReo))::text, 'null')),
  'true|null',
  'R2: the side token is left behind, and is stale: its digest matches no column (every reader ignores it)');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select public.generate_order_packing_slips(%L)', :oReo)),
  'P0001:packing_slips_not_ready:packing_slips_not_ready:picking_in_progress',
  'R3: the reopened order cannot be minted until picking completes again');

-- ══ E. order_return_token_ensure ══════════════════════════════════════════
select is(
  pg_temp.attempt('authenticated', :mgr, format('select public.order_return_token_ensure(%L)', :oE2)),
  '42501:-:permission denied for function order_return_token_ensure',
  'E1a: authenticated cannot mint a return token');
select is(
  pg_temp.attempt('anon', null, format('select public.order_return_token_ensure(%L)', :oE2)),
  '42501:-:permission denied for function order_return_token_ensure',
  'E1b: nor can anon');
create temp table e2 as select null::text as tok;
update e2 set tok = pg_temp.call_as('service_role', null, format('select public.order_return_token_ensure(%L)::text', :oE2));
select is(
  (select (tok ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')::text || '|'
          || ((select s.return_token::text from public.order_request_secrets s where s.order_request_id = :oE2) = tok)::text
     from e2),
  'true|true',
  'E2: service_role mints a uuid for an order with none, into the side table');
select is(
  (select (pg_temp.call_as('service_role', null, format('select public.order_return_token_ensure(%L)::text', :oE2)) = tok)::text from e2),
  'true',
  'E3: a second call returns the same token (idempotent)');
select is(
  pg_temp.call_as('service_role', null, format('select public.order_return_token_ensure(%L)::text', :oE4),
                  format('select s.return_token::text from public.order_request_secrets s where s.order_request_id = %L', :oE4)),
  :retLeg || '|' || :retLeg,
  'E4: an order whose token is in the order column (emailed before 0389) keeps that token, now in the side table');
select is(
  pg_temp.call_as('service_role', null, format('select public.order_return_token_ensure(%L)::text', :oE5)),
  :retSide,
  'E5: never rotates: an issued side token wins over a different column value');
select is(
  pg_temp.call_as('service_role', null, format('select (public.order_return_token_ensure(%L) is not null)::text', :oE6),
                  format('select s.signature_token from public.order_request_secrets s where s.order_request_id = %L', :oE6)),
  'true|' || repeat('e', 64),
  'E6: an existing side row keeps its signature token when the return token is added');
select is(
  pg_temp.call_as('service_role', null, $q$select coalesce(public.order_return_token_ensure('03890000-0000-0000-0000-00000000dead')::text, 'null')$q$,
                  $q$select count(*)::text from public.order_request_secrets where order_request_id = '03890000-0000-0000-0000-00000000dead'$q$),
  'null|0',
  'E7: null for an unknown order, and no side row is made');
select is(
  coalesce((select o.return_token::text from public.order_requests o where o.id = :oE4), 'null') || '|'
  || coalesce((select o.return_token::text from public.order_requests o where o.id = :oE2), 'null'),
  :retLeg || '|null',
  'E8: the ensure writes nothing to the order row (the legacy column is left for slice C; a new token never reaches it)');

-- ══ P. Posture and frozen pins ════════════════════════════════════════════
select is(
  (select string_agg(p.proname || '|' || p.prosecdef::text || '|' || pg_get_userbyid(p.proowner) || '|' || coalesce(array_to_string(p.proconfig, ';'), ''),
                     E'\n' order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('generate_order_packing_slips', 'order_return_token_ensure')),
  E'generate_order_packing_slips|true|postgres|search_path=public, extensions, pg_temp;lock_timeout=5s\n'
  'order_return_token_ensure|true|postgres|search_path=public, pg_temp;lock_timeout=5s',
  'P1a: both functions are SECURITY DEFINER, owned by postgres, with search_path and lock_timeout pinned');
select is(
  (select string_agg(f || ':' || r || '=' || has_function_privilege(r, f, 'EXECUTE')::text, ',' order by f, r)
     from unnest(array['public.generate_order_packing_slips(uuid)', 'public.order_return_token_ensure(uuid)']) f,
          unnest(array['anon', 'authenticated', 'service_role']) r),
  'public.generate_order_packing_slips(uuid):anon=false,public.generate_order_packing_slips(uuid):authenticated=true,'
  'public.generate_order_packing_slips(uuid):service_role=false,'
  'public.order_return_token_ensure(uuid):anon=false,public.order_return_token_ensure(uuid):authenticated=false,'
  'public.order_return_token_ensure(uuid):service_role=true',
  'P1b: the mint is for signed-in callers only (its body gates them); the return-token mint is for the admin client only');
select is(
  (select coalesce(bool_or(a.grantee = 0), false)::text
     from pg_proc p, aclexplode(p.proacl) a
    where p.oid in ('public.generate_order_packing_slips(uuid)'::regprocedure, 'public.order_return_token_ensure(uuid)'::regprocedure)),
  'false',
  'P1c: no PUBLIC EXECUTE survives on either');
select is(
  (coalesce(obj_description('public.order_request_secrets'::regclass, 'pg_class'), '') ~ '0389')::text || ','
  || (coalesce(obj_description('public.generate_order_packing_slips(uuid)'::regprocedure, 'pg_proc'), '') ~ '0389')::text || ','
  || (coalesce(obj_description('public.order_return_token_ensure(uuid)'::regprocedure, 'pg_proc'), '') ~ '0389')::text || ','
  || (coalesce(col_description('public.order_requests'::regclass,
                 (select a.attnum from pg_attribute a where a.attrelid = 'public.order_requests'::regclass and a.attname = 'signature_token')), '')
      ~ 'sha256')::text,
  'true,true,true,true',
  'P2: the table, both functions and order_requests.signature_token say in their comments what 0389 does');
select is(
  (select string_agg(p.oid::regprocedure::text || '|' || md5(p.prosrc), E'\n' order by p.oid::regprocedure::text collate "C")
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('confirm_order_signature', 'reopen_picking', 'resume_fulfillment',
                        '_validate_order_request_status_transition', 'tg_order_requests_insert_guard',
                        'tg_order_requests_workflow_guard', 'confirm_physical_signature')),
  E'_validate_order_request_status_transition()|dee8cd4782ec83abdb31a2b48fcd4ef2\n'
  'confirm_order_signature(uuid,text,text,text,text)|8afdbb68f11dd4e8dcff3283b42f3b13\n'
  'confirm_physical_signature(uuid,text)|f7a14a46d2c70f635c3da844c786ce67\n'
  -- Re-pinned by 0390 (was a7fabd5fb3d07467135006b56581e46c and
  -- e0f2ae5d7d3564cdad3b36ba4cf5aa8c): slice D removes the manager-by-role
  -- term from each gate and nothing else (0390 R8, R9, R11); the secret
  -- clears this suite cares about are untouched.
  'reopen_picking(uuid,text)|293ce0e76d195bb13105cfd1c067de82\n'
  'resume_fulfillment(uuid)|2e2d5aab1db5392250879bfa9ff4bccd\n'
  'tg_order_requests_insert_guard()|1b109d535811e9a21c43d01dcc344892\n'
  'tg_order_requests_workflow_guard()|59481b7651dca818a2266a39868db4f0',
  'P3: the frozen bodies keep their md5 (confirm_order_signature 8afdbb68, the clears as 0390 left them, the transition trigger, the insert guard, the 0387 guard)');
select is(
  (select string_agg(column_name, ',' order by column_name)
     from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'order_requests' and grantee = 'authenticated' and privilege_type = 'UPDATE'),
  'assigned_delivery_at,assigned_delivery_by,assigned_delivery_user_id,created_at,delivery_charter_id,denied_reason,'
  'in_transit_at,in_transit_by,internal_notes,packing_slip_generated_at,packing_slip_generated_by,pick_slip_generated_at,'
  'pick_slip_generated_by,signature_token,signature_token_expires_at,staged_at,staged_by,status,warehouse_id',
  'P4: 0389 changes no grant on order_requests: authenticated keeps its 19 UPDATE columns (pins current behaviour: the token columns are revoked in slice C, after the 12-hour skew window)');
select is(
  (select count(*)::text from pg_proc p
    where p.oid in ('public.generate_order_packing_slips(uuid)'::regprocedure, 'public.order_return_token_ensure(uuid)'::regprocedure)
      and (p.prosrc ~ '40001' or p.prosrc ~* '40P01' or p.prosrc ~* 'serialization_failure|deadlock_detected')),
  '0',
  'P5: neither body raises 40001 or 40P01 (PostgREST retries 40001 forever; 0367)');
select is(
  (select count(*)::text from pg_trigger t
    where not t.tgisinternal
      and (t.tgrelid = 'public.order_request_secrets'::regclass
           or t.tgfoid in ('public.generate_order_packing_slips(uuid)'::regprocedure, 'public.order_return_token_ensure(uuid)'::regprocedure)))
  || '|' || (select count(*)::text from pg_trigger t
              where t.tgrelid = 'public.order_requests'::regclass and t.tgisinternal
                and t.tgconstrrelid = 'public.order_request_secrets'::regclass),
  '0|2',
  'P6: 0389 adds no trigger to order_requests or the side table; the side table''s key adds only the two internal RI triggers on order_requests');

-- ══ The writer census keeps naming the mint (0387 AL9c, re-pinned by 0389) ══
select is(
  (select string_agg(p.proname, ',' order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and p.proname in ('generate_order_packing_slips', 'order_return_token_ensure')
      and p.prosrc ~* $re$(update|merge\s+into)\s+(only\s+)?("?public"?\s*\.\s*)?"?order_requests\M"?$re$),
  'generate_order_packing_slips',
  'W1: the mint is a SECURITY DEFINER writer of order_requests (added to 0387 AL9c on purpose); the return-token mint writes only the side table');
select is(
  (select count(*)::text
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('generate_order_packing_slips', 'order_return_token_ensure')
      and p.prosrc ~* $re$(insert\s+into|merge\s+into(\s+only)?|delete\s+from(\s+only)?)\s+("?public"?\s*\.\s*)?"?order_requests\M$re$),
  '0',
  'W2: neither inserts, merges or deletes order rows (0387 AL9d is unchanged)');

select * from finish();
rollback;
