-- supabase/tests/0453_invite_resend_and_live_location_rules.test.sql
-- pgTAP proof for migration 0453 (docket S11, slice S11-A; the number is
-- provisional): Resend renews an open invite, a delivery's live point is
-- written by its assigned driver, and the module helper the later S11 slices
-- call. No row of any table changes.
--
-- S.  Structure: organization_invites has one rule per command, its UPDATE
--     rule's text is pinned and the other three are unchanged (S1-S3); the
--     pin trigger and its function (S4); delivery_locations has one rule per
--     command, no FOR ALL rule, the SELECT rule unchanged and the three write
--     rules pinned (S5, S6); the helper's shape and privileges (S7); the
--     helpers the rules call stay executable by authenticated (S8).
-- I.  Invites. An admin's Resend renews an open invite (I1); the owner too
--     (I2); the rule asks the admin role, like the table's other rules (I3).
--     A manager, a manager granted members:invite, staff, a viewer, another
--     organization's admin and anon change nothing (I4-I8). A revoked or an
--     accepted invite stays as it is (I9, I10); an expired open one is
--     renewed (I11). Only the expiry may change, within 7 days (I12-I17).
--     The service role marks an invite used (I18). Account deletion still
--     revokes, run by GoTrue's role or postgres while a member's claims are
--     set (I19, I20), and so does a SECURITY DEFINER function called by an
--     admin (I21). Sending, revoking and listing invites are unchanged (I22,
--     I23). An upsert and a MERGE change only the expiry too (I24-I27), and
--     the pin compares the row in stored form: a JSON null where SQL null was
--     and a change of letter case count as changes (I28, I29).
-- L.  Live points. A staff member who is not the assigned driver, holding
--     orders:approve and orders:assign_delivery by grant, moves and creates
--     nothing (L1, L2). The assigned driver overwrites the earlier driver's
--     point in the app's upsert shape (L3), but cannot name someone else as
--     driver or write for an order not in transit (L4, L5). The earlier
--     driver, a manager, an admin and the owner change nothing (L6, L7). A
--     viewer assigned as driver is refused, as before (L8). With
--     live_tracking off nothing is written, and a comped organization counts
--     as on (L9, L10). Another organization's staff member writes only their
--     own organization's point (L11, L12). A manager whose orders:approve is
--     restricted still records the point of the delivery assigned to them
--     (L13). Staff and managers still delete a point (the cancel clean-ups);
--     a viewer, another organization and anon do not (L14, L15). anon writes
--     nothing (L16). The service role writes and deletes (L17). Reads are
--     unchanged (L18). A member of two organizations who is the assigned
--     driver of a delivery in one cannot file its point under the other
--     (L19; M5 shows the order's organization term is what decides it).
-- H.  rls_orgs_with_module: the caller's organizations with the module on
--     (H1), never another organization (H2), not a module that is off or has
--     no row (H3), a comped organization (H4); nothing for a non-member, an
--     expired Act-as seat, a disabled account or a membership not accepted
--     yet (H5); anon and the service role cannot call it (H6).
-- X.  The plan's other two breaking drafts, as controls this slice must
--     leave working: a receipt by a manager whose items:update is restricted
--     still writes its serials (the ledger flag on, as post_receipt_v2 sets
--     it; plan C0), and a member who may create items but not edit them
--     still duplicates a tagged item (duplicate_inventory_item copies the
--     tags as the caller; plan C6a). S11-A changes neither rule. X1 stands
--     in for the receipt: it writes the serial row directly with the ledger
--     flag set the way post_receipt_v2 sets it, rather than posting one.
-- M.  Mutation: each control swaps one of this file's rules or its trigger
--     for another text inside an undone block, and the matching case answers
--     differently (L1, I1, I9, I12, L19). So those cases measure this file's
--     terms, not the fixture.
-- A.  The migration's own preflight and lock prelude, replayed from the
--     statements the CLI recorded: the preflight refuses a second run,
--     passes on the earlier state under any search_path, and names a planted
--     drift; the prelude takes ACCESS EXCLUSIVE on the two tables and on the
--     supautils.policy_grants tables and ACCESS SHARE on the two tables read.
--
-- Roles: fixtures as the test superuser. Every write as an API role runs
-- inside a subtransaction that is always undone (the role and claims are set
-- with set_config there), so every case starts from the fixture and pgTAP's
-- own statements never run as an API role. begin/rollback: nothing leaks.
-- Namespace 511a0000. Made-up data only.

begin;

select plan(74);

\set orgA '\'511a0000-0000-0000-0000-00000000000a\''
\set orgC '\'511a0000-0000-0000-0000-00000000000c\''
\set whA  '\'511a0000-0000-0000-0000-0000000000a1\''
\set whC  '\'511a0000-0000-0000-0000-0000000000c1\''
\set chA  '\'511a0000-0000-0000-0000-0000000000a2\''
\set chC  '\'511a0000-0000-0000-0000-0000000000c2\''

-- Personas, by the last two digits of their ids:
--   01 owner of A
--   02 admin of A
--   03 admin of A, members:invite restricted for them
--   04 manager of A
--   05 manager of A, members:invite granted to them
--   06 staff of A, the driver of deliveries 1 and 3
--   07 staff of A, the earlier driver of delivery 1, the driver of delivery 2
--   08 staff of A, orders:approve and orders:assign_delivery granted to them
--   09 viewer of A, the driver of delivery 5
--   10 staff of C, the driver of C's delivery
--   11 manager of A, orders:approve restricted for them, the driver of delivery 6
--   12 admin of C
--   13 no membership
--   14 staff of A, account disabled
--   15 staff of A on an expired Act-as seat
--   16 staff of A, membership not accepted
--   17 admin of A, the sender of an invite, whose account is deleted in I19/I20
--   18 viewer of A and staff of C, the driver of delivery 7 (in A)
\set p01 '\'511a0000-0000-0000-0000-000000000101\''
\set p02 '\'511a0000-0000-0000-0000-000000000102\''
\set p03 '\'511a0000-0000-0000-0000-000000000103\''
\set p04 '\'511a0000-0000-0000-0000-000000000104\''
\set p05 '\'511a0000-0000-0000-0000-000000000105\''
\set p06 '\'511a0000-0000-0000-0000-000000000106\''
\set p07 '\'511a0000-0000-0000-0000-000000000107\''
\set p08 '\'511a0000-0000-0000-0000-000000000108\''
\set p09 '\'511a0000-0000-0000-0000-000000000109\''
\set p10 '\'511a0000-0000-0000-0000-000000000110\''
\set p11 '\'511a0000-0000-0000-0000-000000000111\''
\set p12 '\'511a0000-0000-0000-0000-000000000112\''
\set p13 '\'511a0000-0000-0000-0000-000000000113\''
\set p14 '\'511a0000-0000-0000-0000-000000000114\''
\set p15 '\'511a0000-0000-0000-0000-000000000115\''
\set p16 '\'511a0000-0000-0000-0000-000000000116\''
\set p17 '\'511a0000-0000-0000-0000-000000000117\''
\set p18 '\'511a0000-0000-0000-0000-000000000118\''

-- Orders (deliveries): 1 in transit (driver 06, point by 07), 2 in transit
-- (driver 07), 3 staged (driver 06), 5 in transit (driver 09, a viewer),
-- 6 in transit (driver 11), 7 in transit (driver 18), C1 in transit in
-- organization C (driver 10).
\set o1  '\'511a0000-0000-0000-0000-0000000002a1\''
\set o2  '\'511a0000-0000-0000-0000-0000000002a2\''
\set o3  '\'511a0000-0000-0000-0000-0000000002a3\''
\set o5  '\'511a0000-0000-0000-0000-0000000002a5\''
\set o6  '\'511a0000-0000-0000-0000-0000000002a6\''
\set o7  '\'511a0000-0000-0000-0000-0000000002a7\''
\set oC1 '\'511a0000-0000-0000-0000-0000000002c1\''

-- Invites of A: open (sent by 02), revoked, accepted, expired but open, open
-- (sent by 17); one of C.
\set iOpen '\'511a0000-0000-0000-0000-0000000003a1\''
\set iRev  '\'511a0000-0000-0000-0000-0000000003a2\''
\set iAcc  '\'511a0000-0000-0000-0000-0000000003a3\''
\set iExp  '\'511a0000-0000-0000-0000-0000000003a4\''
\set iDel  '\'511a0000-0000-0000-0000-0000000003a5\''
\set iC    '\'511a0000-0000-0000-0000-0000000003c1\''

insert into auth.users (id, email, raw_user_meta_data)
  select ('511a0000-0000-0000-0000-0000000001' || lpad(g::text, 2, '0'))::uuid,
         'person' || g || '@s11a.test', '{}'::jsonb
    from generate_series(1, 18) g;
insert into public.organizations (id, name, slug) values
  (:orgA, 'S11A Org A', 's11a-org-a'),
  (:orgC, 'S11A Org C', 's11a-org-c');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :p01, 'owner',   now()),
  (:orgA, :p02, 'admin',   now()),
  (:orgA, :p03, 'admin',   now()),
  (:orgA, :p04, 'manager', now()),
  (:orgA, :p05, 'manager', now()),
  (:orgA, :p06, 'staff',   now()),
  (:orgA, :p07, 'staff',   now()),
  (:orgA, :p08, 'staff',   now()),
  (:orgA, :p09, 'viewer',  now()),
  (:orgC, :p10, 'staff',   now()),
  (:orgA, :p11, 'manager', now()),
  (:orgC, :p12, 'admin',   now()),
  (:orgA, :p18, 'viewer',  now()),
  (:orgC, :p18, 'staff',   now()),
  (:orgA, :p14, 'staff',   now()),
  (:orgA, :p16, 'staff',   null),
  (:orgA, :p17, 'admin',   now());
insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at) values
  (:orgA, :p15, 'staff', now() - interval '2 hours', now() - interval '1 hour');
update public.user_profiles set disabled_at = now() where id = :p14;
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :p03, 'members:invite',          false),
  (:orgA, :p05, 'members:invite',          true),
  (:orgA, :p08, 'orders:approve',          true),
  (:orgA, :p08, 'orders:assign_delivery',  true),
  (:orgA, :p11, 'orders:approve',          false),
  (:orgA, :p11, 'items:update',            false),
  (:orgA, :p07, 'items:update',            false);
insert into public.organization_modules (organization_id, module_id, enabled, tier) values
  (:orgA, 'live_tracking', true, 'optional'),
  (:orgA, 'orders',        true, 'optional'),
  (:orgC, 'live_tracking', true, 'optional'),
  (:orgC, 'orders',        true, 'optional')
on conflict (organization_id, module_id) do update set enabled = excluded.enabled;
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgA, 'S11A WH A', 'S11A-WHA', 'active'),
  (:whC, :orgC, 'S11A WH C', 'S11A-WHC', 'active');
insert into public.charters (id, organization_id, name, code, status) values
  (:chA, :orgA, 'S11A Site A', 'S11A-CHA', 'active'),
  (:chC, :orgC, 'S11A Site C', 'S11A-CHC', 'active');
insert into public.order_requests (id, organization_id, warehouse_id, source, requester_user_id, fulfillment_type,
                                   delivery_charter_id, status, assigned_delivery_user_id) values
  (:o1,  :orgA, :whA, 'internal', :p06, 'delivery', :chA, 'in_transit',          :p06),
  (:o2,  :orgA, :whA, 'internal', :p06, 'delivery', :chA, 'in_transit',          :p07),
  (:o3,  :orgA, :whA, 'internal', :p06, 'delivery', :chA, 'staged_for_delivery', :p06),
  (:o5,  :orgA, :whA, 'internal', :p06, 'delivery', :chA, 'in_transit',          :p09),
  (:o6,  :orgA, :whA, 'internal', :p06, 'delivery', :chA, 'in_transit',          :p11),
  (:o7,  :orgA, :whA, 'internal', :p06, 'delivery', :chA, 'in_transit',          :p18),
  (:oC1, :orgC, :whC, 'internal', :p10, 'delivery', :chC, 'in_transit',          :p10);
insert into public.delivery_locations (organization_id, order_request_id, driver_user_id, lat, lng)
  values (:orgA, :o1, :p07, 36.5, -119.5);
-- Staff member 07 works in warehouse A (X2 reads and copies an item there).
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id) values
  (:orgA, :p07, :whA);
insert into public.categories (id, organization_id, name) values
  ('511a0000-0000-0000-0000-0000000004a1', :orgA, 'S11A Category');
insert into public.inventory_items (id, organization_id, warehouse_id, category_id, sku, name, status, item_type) values
  ('511a0000-0000-0000-0000-0000000004a2', :orgA, :whA, '511a0000-0000-0000-0000-0000000004a1', 'S11A-IT-1', 'S11A item', 'active', 'product');
insert into public.tags (id, organization_id, name) values
  ('511a0000-0000-0000-0000-0000000004a3', :orgA, 'S11A tag');
insert into public.item_tags (item_id, tag_id) values
  ('511a0000-0000-0000-0000-0000000004a2', '511a0000-0000-0000-0000-0000000004a3');
insert into public.organization_invites (id, organization_id, email, role, token, expires_at, invited_by, revoked_at, accepted_at) values
  (:iOpen, :orgA, 'invitee1@s11a.test', 'staff',  's11a-token-open', now() + interval '1 day',  :p02, null, null),
  (:iRev,  :orgA, 'invitee2@s11a.test', 'staff',  's11a-token-rev',  now() - interval '1 minute', :p02, now(), null),
  (:iAcc,  :orgA, 'invitee3@s11a.test', 'staff',  's11a-token-acc',  now() + interval '1 day',  :p02, null, now()),
  (:iExp,  :orgA, 'invitee4@s11a.test', 'viewer', 's11a-token-exp',  now() - interval '1 day',  :p02, null, null),
  (:iDel,  :orgA, 'invitee5@s11a.test', 'staff',  's11a-token-del',  now() + interval '2 days', :p17, null, null),
  (:iC,    :orgC, 'invitee6@s11a.test', 'staff',  's11a-token-c',    now() + interval '1 day',  :p12, null, null);

-- ══ Helpers ═══════════════════════════════════════════════════════════════
-- p_sql run as p_role with p_sub's claims (null: no user), ALWAYS undone: the
-- number of rows it wrote (a write whose USING refuses a row writes 0), or
-- 'ERR:<SQLSTATE>'. p_prep runs first, as the superuser. p_after runs last,
-- as the superuser with p_sub's claims still set; its value follows ' / '.
-- Every statement goes through EXECUTE, so it is planned and
-- permission-checked on each call.
create function pg_temp.try(p_role text, p_sub uuid, p_sql text, p_after text default null, p_prep text default null)
returns text language plpgsql as $$
declare v text; v_after text; v_rows bigint; v_state text;
begin
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_role, true);
    perform set_config('role', p_role, true);
    begin
      execute p_sql;
      get diagnostics v_rows = row_count;
      v := v_rows::text;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate;
      v := 'ERR:' || v_state;
    end;
    perform set_config('role', 'none', true);
    if p_after is not null then
      execute p_after into v_after;
      v := v || ' / ' || coalesce(v_after, 'null');
    end if;
    raise exception using errcode = 'XX511', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> 'XX511' then
      v := 'helper ERR:' || v_state;
    end if;
  end;
  return v;
end $$;
-- p_sql (one value) as p_role with p_sub's claims, ALWAYS undone.
create function pg_temp.ask(p_role text, p_sub uuid, p_sql text, p_prep text default null)
returns text language plpgsql as $$
declare v text; v_state text;
begin
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_role, true);
    perform set_config('role', p_role, true);
    execute p_sql into v;
    raise exception using errcode = 'XX511', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  return case when v_state = 'XX511' then coalesce(v, 'null') else 'ERR:' || v_state end;
end $$;
-- TeamService.resendInvite's write, as PostgREST runs it.
create function pg_temp.resend(p_org uuid, p_id uuid, p_expires text default 'now() + interval ''7 days''')
returns text language sql immutable as $$
  select format('update public.organization_invites set expires_at = %s where organization_id = %L and id = %L',
                p_expires, p_org, p_id)
$$;
-- An invite's state as the superuser: open|renewed (expiry more than 6 days
-- out)|revoked|accepted|expired, then its role.
create function pg_temp.inv(p_id uuid) returns text language sql stable as $$
  select case when i.accepted_at is not null then 'accepted'
              when i.revoked_at is not null then 'revoked'
              when i.expires_at <= now() then 'expired'
              when i.expires_at > now() + interval '6 days' then 'renewed'
              else 'open' end || ',' || i.role
    from public.organization_invites i where i.id = p_id
$$;
-- DeliveryTrackingService.shareLocation's write, as PostgREST runs
-- supabase-js's upsert on order_request_id: one INSERT whose ON CONFLICT
-- branch sets every column sent.
create function pg_temp.share(p_org uuid, p_order uuid, p_driver uuid, p_lat double precision)
returns text language sql immutable as $$
  select format($q$insert into public.delivery_locations
      (organization_id, order_request_id, driver_user_id, lat, lng, heading, accuracy, recorded_at)
    values (%L, %L, %L, %s, -119.75, null, 5, now())
    on conflict (order_request_id) do update
      set organization_id = excluded.organization_id, order_request_id = excluded.order_request_id,
          driver_user_id = excluded.driver_user_id, lat = excluded.lat, lng = excluded.lng,
          heading = excluded.heading, accuracy = excluded.accuracy, recorded_at = excluded.recorded_at$q$,
    p_org, p_order, p_driver, p_lat)
$$;
-- A point as the superuser: '<driver id digits>|<lat>' or 'none'.
create function pg_temp.pt(p_order uuid) returns text language sql stable as $$
  select coalesce((select coalesce(right(l.driver_user_id::text, 2), 'null') || '|' || l.lat::text
                     from public.delivery_locations l where l.order_request_id = p_order), 'none')
$$;
-- A rule as text, deparsed with search_path pinned: command|permissive|roles|USING|CHECK.
create function pg_temp.policy_text(p_table regclass, p_name text) returns text language sql stable
  set search_path = public, extensions
as $$
  select pol.polcmd::text || '|' || pol.polpermissive::text || '|'
         || (select string_agg(case x when 0 then 'public' else x::regrole::text end, ',' order by 1)
               from unnest(pol.polroles) x)
         || '|' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '-')
         || '|' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '-')
    from pg_policy pol
   where pol.polrelid = p_table and pol.polname = p_name
$$;
-- The rules of a table: name:command, sorted.
create function pg_temp.rules(p_table regclass) returns text language sql stable as $$
  select string_agg(pol.polname || ':' || pol.polcmd::text, ', ' order by pol.polname)
    from pg_policy pol where pol.polrelid = p_table
$$;

-- The live point rules' shared WITH CHECK, as deparsed (S6).
\set dl_check '\'((driver_user_id = ( SELECT auth.uid() AS uid)) AND ( SELECT has_org_role(delivery_locations.organization_id, \'\'staff\'\'::text) AS has_org_role) AND (organization_id IN ( SELECT rls_orgs_with_module(\'\'live_tracking\'\'::text) AS rls_orgs_with_module)) AND (EXISTS ( SELECT 1\n   FROM order_requests o\n  WHERE ((o.id = delivery_locations.order_request_id) AND (o.organization_id = delivery_locations.organization_id) AND (o.fulfillment_type = \'\'delivery\'\'::text) AND (o.status = \'\'in_transit\'\'::text) AND (o.assigned_delivery_user_id = ( SELECT auth.uid() AS uid))))))\''
\set dl_using '\'(EXISTS ( SELECT 1\n   FROM order_requests o\n  WHERE ((o.id = delivery_locations.order_request_id) AND (o.organization_id = delivery_locations.organization_id) AND (o.fulfillment_type = \'\'delivery\'\'::text) AND (o.status = \'\'in_transit\'\'::text) AND (o.assigned_delivery_user_id = ( SELECT auth.uid() AS uid)))))\''

-- ══ S. Structure ══════════════════════════════════════════════════════════
select is(
  pg_temp.rules('public.organization_invites'),
  'organization_invites_delete:d, organization_invites_insert:a, organization_invites_select:r, organization_invites_update:w',
  'S1: organization_invites has one rule per command, an UPDATE rule among them');

select is(
  pg_temp.policy_text('public.organization_invites', 'organization_invites_update'),
  'w|true|authenticated'
  || '|(( SELECT has_org_role(organization_invites.organization_id, ''admin''::text) AS has_org_role) AND (accepted_at IS NULL) AND (revoked_at IS NULL))'
  || '|(( SELECT has_org_role(organization_invites.organization_id, ''admin''::text) AS has_org_role) AND (accepted_at IS NULL) AND (revoked_at IS NULL)'
  || ' AND ( SELECT warehouse_in_org(organization_invites.warehouse_id, organization_invites.organization_id) AS warehouse_in_org)'
  || ' AND ( SELECT charter_in_org(organization_invites.charter_id, organization_invites.organization_id) AS charter_in_org))',
  'S2: the invite UPDATE rule: an admin, an open invite; WITH CHECK adds the INSERT rule''s two guards');

select is(
  pg_temp.policy_text('public.organization_invites', 'organization_invites_select') || E'\n'
  || pg_temp.policy_text('public.organization_invites', 'organization_invites_insert') || E'\n'
  || pg_temp.policy_text('public.organization_invites', 'organization_invites_delete'),
  'r|true|authenticated|( SELECT has_org_role(organization_invites.organization_id, ''admin''::text) AS has_org_role)|-' || E'\n'
  || 'a|true|authenticated|-|(( SELECT has_org_role(organization_invites.organization_id, ''admin''::text) AS has_org_role)'
  || ' AND ( SELECT warehouse_in_org(organization_invites.warehouse_id, organization_invites.organization_id) AS warehouse_in_org)'
  || ' AND ( SELECT charter_in_org(organization_invites.charter_id, organization_invites.organization_id) AS charter_in_org))' || E'\n'
  || 'd|true|authenticated|( SELECT has_org_role(organization_invites.organization_id, ''admin''::text) AS has_org_role)|-',
  'S3: the invite SELECT, INSERT and DELETE rules are unchanged');

select is(
  (select string_agg(t.tgname || '|' || pg_get_triggerdef(t.oid) || '|' || t.tgenabled::text, E'\n' order by t.tgname)
     from pg_trigger t where t.tgrelid = 'public.organization_invites'::regclass and not t.tgisinternal
      and t.tgname like 'trg_%')
  || E'\n' ||
  (select p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ';'), '-') || '|' || pg_get_userbyid(p.proowner)
          || '|' || has_function_privilege('authenticated', p.oid, 'execute')::text
          || '|' || has_function_privilege('anon', p.oid, 'execute')::text
          || '|' || has_function_privilege('service_role', p.oid, 'execute')::text
          || '|' || coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a), false)::text
     from pg_proc p where p.oid = to_regprocedure('public.tg_organization_invites_update_pin()'))
  || E'\n' ||
  (select string_agg(t.tgname, ',' order by t.tgname)
     from pg_trigger t where t.tgrelid = 'public.organization_invites'::regclass and not t.tgisinternal
      and t.tgtype & 16 = 16 and t.tgtype & 2 = 2),
  'trg_zz_organization_invites_update_pin|CREATE TRIGGER trg_zz_organization_invites_update_pin BEFORE UPDATE ON public.organization_invites FOR EACH ROW EXECUTE FUNCTION tg_organization_invites_update_pin()|O'
  || E'\n' || 'false|search_path=""|postgres|false|false|false|false'
  || E'\n' || 'trg_zz_organization_invites_update_pin,zzz_deleted_users_upd',
  'S4: the pin trigger is BEFORE UPDATE per row and enabled; its function is INVOKER, search_path empty, nobody may call it; it fires before 0393''s zzz_deleted_users_upd');

select is(
  pg_temp.rules('public.delivery_locations') || E'\n'
  || pg_temp.policy_text('public.delivery_locations', 'delivery_locations_select'),
  'delivery_locations_delete:d, delivery_locations_insert:a, delivery_locations_select:r, delivery_locations_update:w' || E'\n'
  || 'r|true|public|(EXISTS ( SELECT 1' || E'\n' || '   FROM organization_members m' || E'\n'
  || '  WHERE ((m.user_id = auth.uid()) AND (m.organization_id = delivery_locations.organization_id) AND (m.accepted_at IS NOT NULL))))|-',
  'S5: delivery_locations has one rule per command and no FOR ALL rule; its SELECT rule is 0164''s, unchanged');

select is(
  pg_temp.policy_text('public.delivery_locations', 'delivery_locations_insert') || E'\n'
  || pg_temp.policy_text('public.delivery_locations', 'delivery_locations_update') || E'\n'
  || pg_temp.policy_text('public.delivery_locations', 'delivery_locations_delete'),
  'a|true|authenticated|-|' || :dl_check || E'\n'
  || 'w|true|authenticated|' || :dl_using || '|' || :dl_check || E'\n'
  || 'd|true|authenticated|( SELECT has_org_role(delivery_locations.organization_id, ''staff''::text) AS has_org_role)|-',
  'S6: the live point rules: INSERT and UPDATE CHECK (the caller, staff, live_tracking, the delivery in transit assigned to the caller); UPDATE USING (assigned to the caller); DELETE (staff)');

select is(
  (select l.lanname || '|' || p.provolatile::text || '|' || p.prosecdef::text || '|' || p.proretset::text
          || '|' || format_type(p.prorettype, null) || '|' || pg_get_function_arguments(p.oid)
          || '|' || coalesce(array_to_string(p.proconfig, ';'), '-')
          || '|' || pg_get_userbyid(p.proowner)
          || '|' || has_function_privilege('authenticated', p.oid, 'execute')::text
          || '|' || has_function_privilege('anon', p.oid, 'execute')::text
          || '|' || has_function_privilege('service_role', p.oid, 'execute')::text
          || '|' || coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a), false)::text
     from pg_proc p join pg_language l on l.oid = p.prolang
    where p.oid = to_regprocedure('public.rls_orgs_with_module(text)')),
  'sql|s|true|true|uuid|p_module text|search_path=""|postgres|true|false|false|false',
  'S7: rls_orgs_with_module is SQL, STABLE, SECURITY DEFINER, returns setof uuid, search_path empty, owned by postgres, and only authenticated may call it');

select is(
  has_function_privilege('authenticated', 'public.has_org_role(uuid,text)', 'execute')::text || ','
  || has_function_privilege('authenticated', 'public.is_org_member(uuid)', 'execute')::text || ','
  || has_function_privilege('authenticated', 'public.module_enabled(uuid,text)', 'execute')::text || ','
  || has_function_privilege('authenticated', 'public.warehouse_in_org(uuid,uuid)', 'execute')::text || ','
  || has_function_privilege('authenticated', 'public.charter_in_org(uuid,uuid)', 'execute')::text,
  'true,true,true,true,true',
  'S8: authenticated keeps EXECUTE on the helpers the rules call (the rules run as the writer, INV-C1)');

-- ══ I. Invites ════════════════════════════════════════════════════════════
select is(
  pg_temp.try('authenticated', :p02, pg_temp.resend(:orgA, :iOpen), format('select pg_temp.inv(%L)', :iOpen)),
  '1 / renewed,staff',
  'I1: an admin''s Resend renews an open invite to 7 days from now');

select is(
  pg_temp.try('authenticated', :p01, pg_temp.resend(:orgA, :iOpen), format('select pg_temp.inv(%L)', :iOpen)),
  '1 / renewed,staff',
  'I2: the owner''s Resend renews it too');

select is(
  pg_temp.try('authenticated', :p03, pg_temp.resend(:orgA, :iOpen),
    format($q$select pg_temp.inv(%L) || ',' || public.has_permission(%L, 'members:invite')::text$q$, :iOpen, :orgA)),
  '1 / renewed,staff,false',
  'I3: the rule asks the admin role, like the table''s other rules');

select is(
  pg_temp.try('authenticated', :p04, pg_temp.resend(:orgA, :iOpen), format('select pg_temp.inv(%L)', :iOpen)),
  '0 / open,staff',
  'I4: a manager changes nothing');

select is(
  pg_temp.try('authenticated', :p05, pg_temp.resend(:orgA, :iOpen),
    format($q$select pg_temp.inv(%L) || ',' || public.has_permission(%L, 'members:invite')::text$q$, :iOpen, :orgA)),
  '0 / open,staff,true',
  'I5: a manager granted members:invite changes nothing (invites stay admin-only in the database)');

select is(
  pg_temp.try('authenticated', :p06, pg_temp.resend(:orgA, :iOpen), format('select pg_temp.inv(%L)', :iOpen))
  || ' | ' || pg_temp.try('authenticated', :p09, pg_temp.resend(:orgA, :iOpen), format('select pg_temp.inv(%L)', :iOpen)),
  '0 / open,staff | 0 / open,staff',
  'I6: staff and a viewer change nothing');

select is(
  pg_temp.try('authenticated', :p12, pg_temp.resend(:orgA, :iOpen), format('select pg_temp.inv(%L)', :iOpen))
  || ' | ' || pg_temp.try('authenticated', :p12, pg_temp.resend(:orgC, :iC), format('select pg_temp.inv(%L)', :iC)),
  '0 / open,staff | 1 / renewed,staff',
  'I7: another organization''s admin changes nothing here, and renews their own organization''s invite');

select is(
  pg_temp.try('anon', null, pg_temp.resend(:orgA, :iOpen), format('select pg_temp.inv(%L)', :iOpen)),
  '0 / open,staff',
  'I8: anon changes nothing');

select is(
  pg_temp.try('authenticated', :p02, pg_temp.resend(:orgA, :iRev),
    format($q$select pg_temp.inv(%1$L) || ',' || (expires_at < now())::text from public.organization_invites where id = %1$L$q$, :iRev)),
  '0 / revoked,staff,true',
  'I9: a revoked invite stays revoked and expired');

select is(
  pg_temp.try('authenticated', :p02, pg_temp.resend(:orgA, :iAcc), format('select pg_temp.inv(%L)', :iAcc)),
  '0 / accepted,staff',
  'I10: an accepted invite is left as it is');

select is(
  pg_temp.try('authenticated', :p02, pg_temp.resend(:orgA, :iExp), format('select pg_temp.inv(%L)', :iExp)),
  '1 / renewed,viewer',
  'I11: an open invite past its expiry is renewed');

select is(
  pg_temp.try('authenticated', :p02, format($q$update public.organization_invites set role = 'admin' where id = %L$q$, :iOpen),
    format('select pg_temp.inv(%L)', :iOpen)),
  'ERR:42501 / open,staff',
  'I12: an admin cannot change an invite''s role (42501)');

select is(
  (select string_agg(pg_temp.try('authenticated', :p02,
                       format('update public.organization_invites set %s where id = %L', s, :iOpen)), ',' order by n)
     from (values (1, $s$invited_by = '511a0000-0000-0000-0000-000000000101'$s$),
                  (2, $s$token = 's11a-token-other'$s$),
                  (3, $s$email = 'someone-else@s11a.test'$s$),
                  (4, $s$warehouse_id = '511a0000-0000-0000-0000-0000000000a1'$s$),
                  (5, $s$all_warehouses = true$s$),
                  (6, $s$message = 'changed'$s$),
                  (7, $s$revoked_at = now()$s$),
                  (8, $s$accepted_at = now()$s$),
                  (9, $s$organization_id = '511a0000-0000-0000-0000-00000000000c'$s$),
                  (10, $s$expires_at = now() + interval '7 days', role = 'manager'$s$)) v(n, s)),
  'ERR:42501,ERR:42501,ERR:42501,ERR:42501,ERR:42501,ERR:42501,ERR:42501,ERR:42501,ERR:42501,ERR:42501',
  'I13: nor who sent it, its token, email, warehouse, all-warehouse access, message, revoked or accepted time, organization, nor anything else beside its expiry (42501)');

select is(
  pg_temp.try('authenticated', :p02, pg_temp.resend(:orgA, :iOpen, $e$now() + interval '30 days'$e$),
    format('select pg_temp.inv(%L)', :iOpen)),
  'ERR:22023 / open,staff',
  'I14: an admin cannot push an invite more than 7 days out (22023)');

select is(
  pg_temp.try('authenticated', :p02, pg_temp.resend(:orgA, :iOpen, $e$now() - interval '1 minute'$e$))
  || ',' || pg_temp.try('authenticated', :p02, pg_temp.resend(:orgA, :iOpen, 'now()')),
  'ERR:22023,ERR:22023',
  'I15: nor set an expiry in the past or at this moment (22023)');

select is(
  pg_temp.try('authenticated', :p02, pg_temp.resend(:orgA, :iOpen, $e$now() + interval '7 days 1 hour'$e$))
  || ',' || pg_temp.try('authenticated', :p02, pg_temp.resend(:orgA, :iOpen, $e$now() + interval '7 days 1 hour 1 second'$e$)),
  '1,ERR:22023',
  'I16: the limit is now plus 7 days and 1 hour, inclusive');

select is(
  pg_temp.try('authenticated', :p02, pg_temp.resend(:orgA, :iOpen, 'null')),
  'ERR:23502',
  'I17: an expiry cannot be cleared (the column''s NOT NULL)');

select is(
  pg_temp.try('service_role', null, format('update public.organization_invites set accepted_at = now() where id = %L', :iOpen),
    format('select pg_temp.inv(%L)', :iOpen)),
  '1 / accepted,staff',
  'I18: the service role marks an invite used, as acceptance does (not pinned)');

select case when pg_has_role('supabase_auth_admin', 'SET')
            then is(
              pg_temp.try('supabase_auth_admin', :p02, format('delete from auth.users where id = %L', :p17),
                format($q$select pg_temp.inv(%1$L) || ',' || (expires_at < now())::text || ',' || coalesce(invited_by::text, 'null')
                            from public.organization_invites where id = %1$L$q$, :iDel)),
              '1 / revoked,staff,true,null',
              'I19: deleting an account (GoTrue''s role) still revokes the invites it sent and clears their sender, while a member''s claims are set')
            else skip('I19: this test role may not act as supabase_auth_admin; I20 runs the same deletion as postgres, and the pin keys on current_user, which is postgres for the definer trigger and the foreign key action under either role', 1)
       end;

select is(
  pg_temp.try('postgres', :p02, format('delete from auth.users where id = %L', :p17),
    format($q$select pg_temp.inv(%1$L) || ',' || (expires_at < now())::text || ',' || coalesce(invited_by::text, 'null')
                from public.organization_invites where id = %1$L$q$, :iDel)),
  '1 / revoked,staff,true,null',
  'I20: the same, run as postgres');

select is(
  pg_temp.try('authenticated', :p02, format('select public.s11a_t_withdraw(%L)', :iOpen),
    format($q$select pg_temp.inv(%1$L) || ',' || (expires_at < now())::text from public.organization_invites where id = %1$L$q$, :iOpen),
    $p$create function public.s11a_t_withdraw(p_id uuid) returns void language plpgsql security definer set search_path = '' as $f$
       begin
         update public.organization_invites
            set revoked_at = now(), expires_at = least(expires_at, now() - interval '1 minute')
          where id = p_id and accepted_at is null and revoked_at is null;
       end $f$;
       grant execute on function public.s11a_t_withdraw(uuid) to authenticated$p$),
  '1 / revoked,staff,true',
  'I21: a SECURITY DEFINER function an admin calls still withdraws an invite (it runs as the table owner, so the pin leaves it alone)');

select is(
  pg_temp.try('authenticated', :p02,
    format($q$insert into public.organization_invites (organization_id, email, role, token, expires_at, invited_by, warehouse_id)
              values (%L, 'invitee7@s11a.test', 'staff', 's11a-token-new', now() + interval '7 days', %L, %L)$q$, :orgA, :p02, :whA))
  || ',' || pg_temp.try('authenticated', :p02, format('delete from public.organization_invites where id = %L', :iOpen))
  || ',' || pg_temp.ask('authenticated', :p02, format('select count(*)::text from public.organization_invites where organization_id = %L', :orgA)),
  '1,1,5',
  'I22: an admin still sends, revokes and lists invites (the INSERT, DELETE and SELECT rules are unchanged)');

select is(
  pg_temp.try('authenticated', :p04,
    format($q$insert into public.organization_invites (organization_id, email, role, token, expires_at, invited_by, warehouse_id)
              values (%L, 'invitee8@s11a.test', 'staff', 's11a-token-mgr', now() + interval '7 days', %L, %L)$q$, :orgA, :p04, :whA))
  || ',' || pg_temp.ask('authenticated', :p04, format('select count(*)::text from public.organization_invites where organization_id = %L', :orgA)),
  'ERR:42501,0',
  'I23: a manager still neither sends nor sees invites (control)');

-- PostgREST's upsert of an invite, and MERGE: only the expiry may change.
create function pg_temp.upsert_invite(p_conflict text, p_set text, p_role text) returns text language sql immutable as $$
  select format($q$insert into public.organization_invites (organization_id, email, role, token, expires_at, invited_by)
                  values ('511a0000-0000-0000-0000-00000000000a', 'invitee1@s11a.test', %L, 's11a-token-open',
                          now() + interval '7 days', '511a0000-0000-0000-0000-000000000102')
                  on conflict (%s) do update set %s$q$, p_role, p_conflict, p_set)
$$;

select is(
  pg_temp.try('authenticated', :p02, pg_temp.upsert_invite('token', 'role = excluded.role', 'admin'),
    format('select pg_temp.inv(%L)', :iOpen)),
  'ERR:42501 / open,staff',
  'I24: an upsert that changes an invite''s role is refused (42501)');

select is(
  pg_temp.try('authenticated', :p02,
    pg_temp.upsert_invite('token', 'organization_id = excluded.organization_id, email = excluded.email, role = excluded.role, '
                                   'token = excluded.token, expires_at = excluded.expires_at, invited_by = excluded.invited_by', 'admin'),
    format('select pg_temp.inv(%L)', :iOpen)),
  'ERR:42501 / open,staff',
  'I25: so is the upsert that sets every column sent, when one of them changes beside the expiry (42501)');

select is(
  pg_temp.try('authenticated', :p02, pg_temp.upsert_invite('token', 'expires_at = excluded.expires_at', 'staff'),
    format('select pg_temp.inv(%L)', :iOpen)),
  '1 / renewed,staff',
  'I26: an upsert that changes only the expiry renews the invite');

select is(
  pg_temp.try('authenticated', :p02,
    format($q$merge into public.organization_invites i using (select 1) s on i.id = %L
              when matched then update set role = 'admin'$q$, :iOpen),
    format('select pg_temp.inv(%L)', :iOpen))
  || ' | ' || pg_temp.try('authenticated', :p02,
    format($q$merge into public.organization_invites i using (select 1) s on i.id = %L
              when matched then update set expires_at = now() + interval '7 days'$q$, :iOpen),
    format('select pg_temp.inv(%L)', :iOpen)),
  'ERR:42501 / open,staff | 1 / renewed,staff',
  'I27: a MERGE that changes an invite''s role is refused (42501); one that changes only the expiry renews it');

select is(
  pg_temp.try('authenticated', :p02,
    format($q$update public.organization_invites set deleted_users = 'null'::jsonb where id = %L$q$, :iOpen),
    format($q$select coalesce(deleted_users::text, 'SQL null') from public.organization_invites where id = %L$q$, :iOpen)),
  'ERR:42501 / SQL null',
  'I28: a JSON null written where the row holds SQL null is a change (the pin compares stored values, 42501)');

select is(
  pg_temp.try('authenticated', :p02,
    format($q$update public.organization_invites set email = 'INVITEE1@s11a.test' where id = %L$q$, :iOpen),
    format('select email::text from public.organization_invites where id = %L', :iOpen)),
  'ERR:42501 / invitee1@s11a.test',
  'I29: so is an email that compares equal but is written with other letter case (42501)');

-- ══ L. Live points ═════════════════════════════════════════════════════════
select is(
  pg_temp.try('authenticated', :p08, format('update public.delivery_locations set lat = 1 where order_request_id = %L', :o1),
    format('select pg_temp.pt(%L)', :o1)),
  '0 / 07|36.5',
  'L1: a staff member who is not the assigned driver, granted orders:approve and orders:assign_delivery, moves no point');

select is(
  pg_temp.try('authenticated', :p08, pg_temp.share(:orgA, :o2, :p08, 2), format('select pg_temp.pt(%L)', :o2)),
  'ERR:42501 / none',
  'L2: ... and creates none for a delivery assigned to someone else (42501)');

select is(
  pg_temp.try('authenticated', :p06, pg_temp.share(:orgA, :o1, :p06, 3), format('select pg_temp.pt(%L)', :o1)),
  '1 / 06|3',
  'L3: the assigned driver''s upsert overwrites the earlier driver''s point (the app''s shareLocation)');

select is(
  pg_temp.try('authenticated', :p06, pg_temp.share(:orgA, :o1, :p07, 4), format('select pg_temp.pt(%L)', :o1)),
  'ERR:42501 / 07|36.5',
  'L4: the assigned driver cannot name someone else as the driver (42501)');

select is(
  pg_temp.try('authenticated', :p06, pg_temp.share(:orgA, :o3, :p06, 5), format('select pg_temp.pt(%L)', :o3)),
  'ERR:42501 / none',
  'L5: nor record a point for a delivery that is not in transit (42501)');

select is(
  pg_temp.try('authenticated', :p07, format('update public.delivery_locations set lat = 6 where order_request_id = %L', :o1),
    format('select pg_temp.pt(%L)', :o1))
  || ' | ' || pg_temp.try('authenticated', :p07, pg_temp.share(:orgA, :o1, :p07, 6), format('select pg_temp.pt(%L)', :o1)),
  '0 / 07|36.5 | ERR:42501 / 07|36.5',
  'L6: the earlier driver no longer moves the point once the delivery is someone else''s');

select is(
  pg_temp.try('authenticated', :p04, format('update public.delivery_locations set lat = 7 where order_request_id = %L', :o1),
    format('select pg_temp.pt(%L)', :o1))
  || ' | ' || pg_temp.try('authenticated', :p02, format('update public.delivery_locations set lat = 7 where order_request_id = %L', :o1),
    format('select pg_temp.pt(%L)', :o1))
  || ' | ' || pg_temp.try('authenticated', :p01, format('update public.delivery_locations set lat = 7 where order_request_id = %L', :o1),
    format('select pg_temp.pt(%L)', :o1)),
  '0 / 07|36.5 | 0 / 07|36.5 | 0 / 07|36.5',
  'L7: a manager, an admin and the owner who are not the driver move no point');

select is(
  pg_temp.try('authenticated', :p09, pg_temp.share(:orgA, :o5, :p09, 8), format('select pg_temp.pt(%L)', :o5)),
  'ERR:42501 / none',
  'L8: a viewer assigned as driver records no point (0164''s staff floor, kept)');

select is(
  pg_temp.try('authenticated', :p06, pg_temp.share(:orgA, :o1, :p06, 9), format('select pg_temp.pt(%L)', :o1),
    format($q$update public.organization_modules set enabled = false where organization_id = %L and module_id = 'live_tracking'$q$, :orgA)),
  'ERR:42501 / 07|36.5',
  'L9: with live_tracking off, the assigned driver records nothing (42501)');

select is(
  pg_temp.try('authenticated', :p06, pg_temp.share(:orgA, :o1, :p06, 10), format('select pg_temp.pt(%L)', :o1),
    format($q$update public.organization_modules set enabled = false where organization_id = %1$L and module_id = 'live_tracking';
              update public.organizations set all_modules_comp = true where id = %1$L$q$, :orgA)),
  '1 / 06|10',
  'L10: a comped organization counts as having live_tracking on, as module_enabled says (0354)');

select is(
  pg_temp.try('authenticated', :p10, pg_temp.share(:orgA, :o1, :p10, 11), format('select pg_temp.pt(%L)', :o1))
  || ' | ' || pg_temp.try('authenticated', :p10, format('update public.delivery_locations set lat = 11 where order_request_id = %L', :o1),
    format('select pg_temp.pt(%L)', :o1)),
  'ERR:42501 / 07|36.5 | 0 / 07|36.5',
  'L11: another organization''s staff member writes no point here');

select is(
  pg_temp.try('authenticated', :p10, pg_temp.share(:orgC, :oC1, :p10, 12), format('select pg_temp.pt(%L)', :oC1)),
  '1 / 10|12',
  'L12: ... and records the point of the delivery assigned to them in their own organization');

select is(
  pg_temp.try('authenticated', :p11, pg_temp.share(:orgA, :o6, :p11, 13),
    format($q$select pg_temp.pt(%L) || ',' || public.has_permission(%L, 'orders:approve')::text$q$, :o6, :orgA)),
  '1 / 11|13,false',
  'L13: a manager whose orders:approve is restricted still records the point of the delivery assigned to them');

select is(
  pg_temp.try('authenticated', :p08, format('delete from public.delivery_locations where order_request_id = %L', :o1),
    format('select pg_temp.pt(%L)', :o1))
  || ' | ' || pg_temp.try('authenticated', :p04, format('delete from public.delivery_locations where order_request_id = %L', :o1),
    format('select pg_temp.pt(%L)', :o1)),
  '1 / none | 1 / none',
  'L14: staff and managers still drop a point (the cancel and return clean-ups run as the member acting on the order)');

select is(
  pg_temp.try('authenticated', :p09, format('delete from public.delivery_locations where order_request_id = %L', :o1),
    format('select pg_temp.pt(%L)', :o1))
  || ' | ' || pg_temp.try('authenticated', :p10, format('delete from public.delivery_locations where order_request_id = %L', :o1),
    format('select pg_temp.pt(%L)', :o1))
  || ' | ' || pg_temp.try('anon', null, format('delete from public.delivery_locations where order_request_id = %L', :o1),
    format('select pg_temp.pt(%L)', :o1)),
  '0 / 07|36.5 | 0 / 07|36.5 | 0 / 07|36.5',
  'L15: a viewer, another organization''s staff member and anon drop nothing');

select is(
  pg_temp.try('anon', null, pg_temp.share(:orgA, :o2, :p07, 16), format('select pg_temp.pt(%L)', :o2))
  || ' | ' || pg_temp.try('anon', null, format('update public.delivery_locations set lat = 16 where order_request_id = %L', :o1),
    format('select pg_temp.pt(%L)', :o1)),
  'ERR:42501 / none | 0 / 07|36.5',
  'L16: anon writes no point');

select is(
  pg_temp.try('service_role', null, pg_temp.share(:orgA, :o2, :p07, 17), format('select pg_temp.pt(%L)', :o2))
  || ' | ' || pg_temp.try('service_role', null, format('delete from public.delivery_locations where order_request_id = %L', :o1),
    format('select pg_temp.pt(%L)', :o1)),
  '1 / 07|17 | 1 / none',
  'L17: the service role still writes and drops a point (the signature route''s clean-up)');

select is(
  pg_temp.ask('authenticated', :p09, format('select count(*)::text from public.delivery_locations where organization_id = %L', :orgA))
  || ',' || pg_temp.ask('authenticated', :p08, format('select count(*)::text from public.delivery_locations where organization_id = %L', :orgA))
  || ',' || pg_temp.ask('authenticated', :p10, format('select count(*)::text from public.delivery_locations where organization_id = %L', :orgA))
  || ',' || pg_temp.ask('anon', null, format('select count(*)::text from public.delivery_locations where organization_id = %L', :orgA)),
  '1,1,0,0',
  'L18: reads are unchanged: every accepted member reads the point, another organization and anon read none');

select is(
  pg_temp.try('authenticated', :p18, pg_temp.share(:orgC, :o7, :p18, 19), format('select pg_temp.pt(%L)', :o7))
  || ' | ' || pg_temp.ask('authenticated', :p18,
       format($q$select public.has_org_role(%L, 'staff')::text || ',' || public.has_org_role(%L, 'staff')::text$q$, :orgC, :orgA)),
  'ERR:42501 / none | true,false',
  'L19: a member of two organizations, staff in C and assigned driver of a delivery in A, cannot file its point under C (42501)');

-- ══ H. rls_orgs_with_module ═══════════════════════════════════════════════
create function pg_temp.mods(p_role text, p_sub uuid, p_module text, p_prep text default null) returns text language sql as $$
  select pg_temp.ask(p_role, p_sub,
    format($q$select string_agg(right(o::text, 1), ',' order by o) from public.rls_orgs_with_module(%L) o$q$, p_module), p_prep)
$$;

select is(
  pg_temp.mods('authenticated', :p06, 'live_tracking') || ' | ' || pg_temp.mods('authenticated', :p10, 'live_tracking'),
  'a | c',
  'H1: the helper answers an enabled module for the caller''s organization only');

select is(
  pg_temp.mods('authenticated', :p06, 'live_tracking',
    format($q$update public.organization_modules set enabled = true where organization_id = %L and module_id = 'live_tracking'$q$, :orgC)),
  'a',
  'H2: never another organization, even one where the module is on');

select is(
  pg_temp.mods('authenticated', :p06, 'live_tracking',
    format($q$update public.organization_modules set enabled = false where organization_id = %L and module_id = 'live_tracking'$q$, :orgA))
  || ' | ' || pg_temp.mods('authenticated', :p06, 's11a_no_such_module'),
  'null | null',
  'H3: a module that is off, or has no row, is not answered');

select is(
  pg_temp.mods('authenticated', :p06, 'live_tracking',
    format($q$update public.organization_modules set enabled = false where organization_id = %1$L and module_id = 'live_tracking';
              update public.organizations set all_modules_comp = true where id = %1$L$q$, :orgA)),
  'a',
  'H4: a comped organization gets the module even over an explicit off row (0354)');

select is(
  pg_temp.mods('authenticated', :p13, 'live_tracking') || ' | ' || pg_temp.mods('authenticated', :p15, 'live_tracking')
  || ' | ' || pg_temp.mods('authenticated', :p14, 'live_tracking') || ' | ' || pg_temp.mods('authenticated', :p16, 'live_tracking'),
  'null | null | null | null',
  'H5: nothing for a non-member, an expired Act-as seat, a disabled account or a membership not accepted yet');

select is(
  pg_temp.mods('anon', null, 'live_tracking') || ' | ' || pg_temp.mods('service_role', null, 'live_tracking'),
  'ERR:42501 | ERR:42501',
  'H6: anon and the service role cannot call it');

-- ══ X. The plan's other breaking drafts, as controls ══════════════════════
select is(
  pg_temp.try('authenticated', :p11,
    format($q$insert into public.serial_registry (organization_id, item_id, warehouse_id, serial_number)
              values (%L, '511a0000-0000-0000-0000-0000000004a2', %L, 'S11A-SN-1')$q$, :orgA, :whA),
    format($q$select count(*)::text || ',' || public.has_permission(%L, 'items:update')::text
                from public.serial_registry where serial_number = 'S11A-SN-1'$q$, :orgA),
    $p$select set_config('stockpilot.ledger', pg_current_xact_id()::text, true)$p$),
  '1 / 1,false',
  'X1 (plan C0, a stand-in for the receipt): a serial write with the ledger flag on, by a manager whose items:update is restricted, still lands');

select is(
  pg_temp.try('authenticated', :p07,
    $q$select public.duplicate_inventory_item('511a0000-0000-0000-0000-0000000004a2', '{"sku":"S11A-DUP-1"}'::jsonb)$q$,
    format($q$select count(*)::text || ',' || public.has_permission(%L, 'items:update')::text
                from public.item_tags g join public.inventory_items i on i.id = g.item_id
               where i.sku = 'S11A-DUP-1' and i.organization_id = %L$q$, :orgA, :orgA)),
  '1 / 1,false',
  'X2 (plan C6a): a member who may create items but not edit them duplicates a tagged item, tag and all');

-- ══ M. Mutation controls ══════════════════════════════════════════════════
select is(
  pg_temp.try('authenticated', :p08, format('update public.delivery_locations set lat = 1 where order_request_id = %L', :o1),
    format('select pg_temp.pt(%L)', :o1),
    $p$drop policy delivery_locations_insert on public.delivery_locations;
       drop policy delivery_locations_update on public.delivery_locations;
       drop policy delivery_locations_delete on public.delivery_locations;
       create policy delivery_locations_write on public.delivery_locations
         for all using (public.has_org_role(organization_id, 'staff'))$p$),
  '1 / 07|1',
  'M1: L1''s answer comes from the live point rules (with 0164''s rule in their place it differs)');

select is(
  pg_temp.try('authenticated', :p02, pg_temp.resend(:orgA, :iOpen), format('select pg_temp.inv(%L)', :iOpen),
    'drop policy organization_invites_update on public.organization_invites'),
  '0 / open,staff',
  'M2: I1''s answer comes from the invite UPDATE rule (without it, it differs)');

select is(
  pg_temp.try('authenticated', :p02, pg_temp.resend(:orgA, :iRev),
    format($q$select (expires_at > now() + interval '6 days')::text from public.organization_invites where id = %L$q$, :iRev),
    $p$drop trigger trg_zz_organization_invites_update_pin on public.organization_invites;
       drop policy organization_invites_update on public.organization_invites;
       create policy s11a_admin_only_update on public.organization_invites for update to authenticated
         using ((select public.has_org_role(organization_id, 'admin')))
         with check ((select public.has_org_role(organization_id, 'admin')))$p$),
  '1 / true',
  'M3: I9''s answer comes from the rule''s accepted and revoked terms (an UPDATE rule without them, and no pin, answers differently)');

select is(
  pg_temp.try('authenticated', :p02, format($q$update public.organization_invites set role = 'admin' where id = %L$q$, :iOpen),
    format('select pg_temp.inv(%L)', :iOpen),
    'drop trigger trg_zz_organization_invites_update_pin on public.organization_invites'),
  '1 / open,admin',
  'M4: I12''s answer comes from the pin trigger (without it, it differs)');

select is(
  pg_temp.try('authenticated', :p18, pg_temp.share(:orgC, :o7, :p18, 19), format('select pg_temp.pt(%L)', :o7),
    $p$drop policy delivery_locations_insert on public.delivery_locations;
       create policy delivery_locations_insert on public.delivery_locations for insert to authenticated
         with check (
           delivery_locations.driver_user_id = ( select auth.uid() )
           and ( select public.has_org_role(delivery_locations.organization_id, 'staff') )
           and delivery_locations.organization_id in ( select public.rls_orgs_with_module('live_tracking') )
           and exists (select 1 from public.order_requests o
                        where o.id = delivery_locations.order_request_id
                          and o.fulfillment_type = 'delivery' and o.status = 'in_transit'
                          and o.assigned_delivery_user_id = ( select auth.uid() )))$p$),
  '1 / 18|19',
  'M5: L19''s answer comes from the order''s organization term (without it, it differs)');

-- ══ A. The migration's own preflight and lock prelude ══════════════════════
-- The statements the CLI recorded for this file that contain p_tag, found by
-- the file's name so a renumbering does not change this section.
create function pg_temp.mig(p_tag text) returns text language sql stable as $$
  select coalesce(string_agg(st, E';\n'), '')
    from supabase_migrations.schema_migrations m, unnest(m.statements) st
   where m.name = 'invite_resend_and_live_location_rules' and position(p_tag in st) > 0
$$;
create function pg_temp.mig_count(p_tag text) returns bigint language sql stable as $$
  select count(*)
    from supabase_migrations.schema_migrations m, unnest(m.statements) st
   where m.name = 'invite_resend_and_live_location_rules' and position(p_tag in st) > 0
$$;
-- The state before this file: no helper, no pin, no invite UPDATE rule, and
-- 0164's FOR ALL rule.
create function pg_temp.pre_0453() returns text language sql immutable as $$
  select $p$drop trigger trg_zz_organization_invites_update_pin on public.organization_invites;
drop function public.tg_organization_invites_update_pin();
drop policy organization_invites_update on public.organization_invites;
drop policy delivery_locations_insert on public.delivery_locations;
drop policy delivery_locations_update on public.delivery_locations;
drop policy delivery_locations_delete on public.delivery_locations;
create policy delivery_locations_write on public.delivery_locations
  for all using (public.has_org_role(organization_id, 'staff'));
drop function public.rls_orgs_with_module(text)$p$
$$;
-- The preflight run again after p_prep, ALWAYS undone: 'ok', or
-- '<sqlstate>:<hint>:' and the checks its message reports, sorted; 'missing'
-- when the CLI recorded no preflight.
create function pg_temp.try_pre(p_prep text) returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text;
begin
  if pg_temp.mig('$pre_s11a$') = '' then
    return 'missing';
  end if;
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    execute pg_temp.mig('$pre_s11a$');
    raise exception using errcode = 'XX511', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XX511' then
    return 'ok';
  end if;
  return v_state || ':' || coalesce(nullif(v_hint, ''), '-') || ':'
         || coalesce((select string_agg(m[1], ', ' order by m[1] collate "C")
                        from regexp_matches(v_msg, '(\S+ drifted|\S+ missing|\S+ rules are not|already exists)', 'g') m),
                     v_msg);
end $$;
-- The tables (outside the catalogs) this backend holds in p_mode after p_sql,
-- ALWAYS undone (the locks go with the subtransaction); 'missing' for an
-- empty p_sql.
create function pg_temp.locks(p_sql text, p_mode text) returns text language plpgsql as $$
declare v text;
begin
  if p_sql = '' then
    return 'missing';
  end if;
  begin
    execute p_sql;
    select string_agg(distinct n.nspname || '.' || c.relname, ',' order by n.nspname || '.' || c.relname) into v
      from pg_locks l
      join pg_class c on c.oid = l.relation
      join pg_namespace n on n.oid = c.relnamespace
     where l.pid = pg_backend_pid() and l.locktype = 'relation' and l.granted
       and l.mode = p_mode and c.relpersistence = 'p' and c.relkind in ('r', 'p')
       and n.nspname not in ('pg_catalog', 'pg_toast', 'information_schema');
    raise exception using errcode = 'XX511', message = 'undo';
  exception when sqlstate 'XX511' then
    null;
  end;
  return coalesce(v, 'none');
end $$;

select is(
  pg_temp.mig_count('$pre_s11a$')::text || '/' || pg_temp.mig_count('$lock_s11a$')::text,
  '1/1',
  'A1: the CLI recorded the preflight and the lock prelude exactly once each (this section runs that text)');

select is(
  pg_temp.try_pre(null),
  '55000:s11a_preflight:already exists, public.delivery_locations rules are not, public.organization_invites rules are not',
  'A2: run again after the migration, the preflight stops before changing anything (55000) and names what it found');

select is(
  pg_temp.try_pre(pg_temp.pre_0453()) || ' / ' || pg_temp.try_pre(pg_temp.pre_0453() || $p$;set local search_path = ''$p$)
  || ' / ' || pg_temp.try_pre(pg_temp.pre_0453() || $p$;set local search_path = pg_catalog$p$),
  'ok / ok / ok',
  'A3: on the state before the migration the preflight passes, under the session''s search_path, an empty one and pg_catalog alone');

select is(
  pg_temp.try_pre(pg_temp.pre_0453() || $p$;
create or replace function public.has_org_role(org_id uuid, min_role text) returns boolean
language sql stable security definer set search_path = public as $f$ select true $f$$p$)
  || ' / ' || pg_temp.try_pre(pg_temp.pre_0453() || $p$;
revoke execute on function public.module_enabled(uuid, text) from authenticated$p$)
  || ' / ' || pg_temp.try_pre(pg_temp.pre_0453() || $p$;
create policy s11a_extra on public.delivery_locations for update to authenticated using (true)$p$)
  || ' / ' || pg_temp.try_pre(pg_temp.pre_0453() || $p$;
create function public.rls_orgs_with_module(p text) returns setof uuid language sql as $f$ select null::uuid $f$$p$),
  '55000:s11a_preflight:public.has_org_role(uuid,text) drifted / 55000:s11a_preflight:public.module_enabled(uuid,text) drifted'
  || ' / 55000:s11a_preflight:public.delivery_locations rules are not / 55000:s11a_preflight:already exists',
  'A4: the preflight names a changed helper body, a helper authenticated cannot call, an extra rule and a name already taken');

select is(
  pg_temp.locks(pg_temp.mig('$lock_s11a$'), 'AccessExclusiveLock'),
  (select string_agg(x, ',' order by x) from (
     select 'public.delivery_locations' as x
     union select 'public.organization_invites'
     union select n.nspname || '.' || c.relname
       from jsonb_array_elements_text(coalesce(nullif(current_setting('supautils.policy_grants', true), '')::jsonb -> current_user::text, '[]'::jsonb)) t(name)
       join pg_class c on c.oid = to_regclass(t.name) join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p')) e),
  'A5: the lock prelude takes ACCESS EXCLUSIVE on the two tables and on every supautils.policy_grants table, and on nothing else');

select * from finish();
rollback;
