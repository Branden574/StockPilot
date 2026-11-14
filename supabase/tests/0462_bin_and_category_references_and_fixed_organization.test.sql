-- supabase/tests/NNNN_bin_and_category_references_and_fixed_organization.test.sql
-- (NNNN = the migration's number, given in ship order; nothing in this file
-- reads it)
-- pgTAP proof for the migration that holds these references to the row's
-- own organization, for every rank (a NULL reference passes), and keeps the
-- organization of a warehouse, a location, a bin and a category fixed:
--   * a stock row's bin and item and a put-away row's two bins and item:
--     inventory_stock_write and putaway_moves_write ask bin_in_org and
--     item_in_org of the new row;
--   * a category's parent: categories_insert and categories_update ask
--     category_in_org(parent_id, organization_id) of the new row;
--   * a category assignment's category: user_category_assignments_write asks
--     category_in_org(category_id, organization_id) of the new row, and
--     set_user_category_access asks it of every category it is given;
--   * the organization_id of a warehouse, a location, a bin and a category:
--     for the API roles it does not change on update
--     (tg_organization_id_fixed).
-- No stored row changes. Every line states what the database does with the
-- migration applied.
--
-- Personas (organization A unless named):
--   own     owner
--   adm     admin
--   mgr     manager
--   stf     staff assigned to whA
--   vwr     viewer assigned to whA
--   two     admin of A, and staff of B assigned to whB
--   both    admin of A and admin of B
--   mgrB    manager of B
-- Warehouses: whA and whS of A, whB of B. Bins binA and binA2 (whA) of A,
-- binB and binB2 (whB) of B. Items itA and itA2 of A, itB of B. Stock row
-- stkA (whA, binA, itA) and put-away row mvA (binA to binA2) of A; stkX (whA,
-- binB, itA2), a stock row of A naming B's bin written by the superuser past
-- the rules (the row B11 acts on). Categories catA and catA2 of A,
-- catB of B; assignment ucaA (vwr, catA) of A. Locations locA (whA) and
-- locSite (no warehouse, no parent) of A, locB of B.
--
-- F.  The fixture is what the matrices assume.
-- H.  bin_in_org: NULL-safe, true for a bin of the organization, false
--     otherwise; SECURITY DEFINER, stable, search_path public, owned by
--     postgres, executable by authenticated and service_role only, the
--     same posture and body shape as warehouse_in_org (H1, H2).
-- B.  Bins: a stock row of A naming B's bin, inserted (B1) or set by an
--     update (B2), by every rank and by members of both organizations:
--     refused 42501; anon has no rule (B1). A's own bins, insert and update,
--     for every rank, as before (B3). A put-away row of A naming B's bin as
--     its source or its destination, inserted or set by an update: refused
--     (B4); A's own bins, as before (B5). The service role writes past the
--     rules as before (B6). B's own bin with nothing of A naming it is
--     deleted by B's manager (B7). The two tables' rules are exactly the new
--     ones, USING unchanged (B8). Items: a stock or put-away row of A naming
--     B's item, inserted or set by an update: refused; A's other item, as
--     before (B9). Upserts: one that updates a stock row of A to B's bin, and
--     one whose insert names B's bin, are refused; one that changes the
--     quantity in A's own bin is as before (B10). A stored row naming B's bin
--     takes no quantity change, may be pointed back at A's bin, and may be
--     removed by staff (not by a viewer) (B11).
-- C.  Categories: a category of A whose parent is B's, inserted (C1) or set
--     by an update (C2): refused 42501. A's own parent and no parent, insert
--     and update, for every rank, as before (C3, C4). An assignment of A
--     naming B's category, inserted or set by an update: refused (C5); A's
--     own category, insert, update and delete, as before (C6).
--     set_user_category_access refuses B's category and writes nothing; A's
--     own and an empty list as before (C7). The service role writes past the
--     rules (C8). The rules and the function are exactly the new ones (C9).
-- O.  A warehouse's and a location's organization: moving one to B is
--     refused 42501 for an owner, an admin, a manager and a member of both,
--     by update (O1, O2) and by upsert (O3). Updates that keep the
--     organization (a rename, an archive, the same organization_id sent
--     again) and inserts are as before (O4, O5). The service role is not
--     held (O6). The guard is SECURITY INVOKER, search_path public, owned by
--     postgres, executable by no API role (O7), and bound once on each of
--     the four tables (O8). A bin's organization (with its warehouse, or
--     alone) and a category's: refused by update and by upsert (O9, O10);
--     renames, an archive, a soft delete and the same organization_id sent
--     again, as before (O11); the service role is not held (O12).
-- Z.  Nothing the refused writes and the undone attempts touched was left
--     changed.
--
-- Roles: fixtures as the test superuser. Every attempt runs through
-- pg_temp.attempt (always undone), which switches role and claims with
-- set_config inside a subtransaction (the 0387 helpers, as 0419 and 0423 use
-- them). begin/rollback: nothing leaks.
-- Namespace 04620000; undo code XX462.

begin;

select plan(38);

\set orgA    '\'04620000-0000-0000-0000-00000000000a\''
\set orgB    '\'04620000-0000-0000-0000-00000000000b\''
\set own     '\'04620000-0000-0000-0000-0000000000a1\''
\set adm     '\'04620000-0000-0000-0000-0000000000a2\''
\set mgr     '\'04620000-0000-0000-0000-0000000000a3\''
\set stf     '\'04620000-0000-0000-0000-0000000000a5\''
\set vwr     '\'04620000-0000-0000-0000-0000000000a6\''
\set two     '\'04620000-0000-0000-0000-0000000000a7\''
\set both    '\'04620000-0000-0000-0000-0000000000a9\''
\set mgrB    '\'04620000-0000-0000-0000-0000000000b1\''
\set whA     '\'04620000-0000-0000-0000-0000000000d1\''
\set whB     '\'04620000-0000-0000-0000-0000000000d3\''
\set whS     '\'04620000-0000-0000-0000-0000000000d4\''
\set itA     '\'04620000-0000-0000-0000-000000000101\''
\set itB     '\'04620000-0000-0000-0000-000000000105\''
\set locA    '\'04620000-0000-0000-0000-000000000201\''
\set locB    '\'04620000-0000-0000-0000-000000000203\''
\set locSite '\'04620000-0000-0000-0000-000000000204\''
\set catA    '\'04620000-0000-0000-0000-000000000301\''
\set catA2   '\'04620000-0000-0000-0000-000000000302\''
\set catB    '\'04620000-0000-0000-0000-000000000303\''
\set binA    '\'04620000-0000-0000-0000-000000000501\''
\set binA2   '\'04620000-0000-0000-0000-000000000502\''
\set binB    '\'04620000-0000-0000-0000-000000000503\''
\set binB2   '\'04620000-0000-0000-0000-000000000504\''
\set stkA    '\'04620000-0000-0000-0000-000000000601\''
\set mvA     '\'04620000-0000-0000-0000-000000000701\''
\set ucaA    '\'04620000-0000-0000-0000-000000000801\''
\set itA2    '\'04620000-0000-0000-0000-000000000102\''
\set stkX    '\'04620000-0000-0000-0000-000000000602\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,  'b462-own@b462.test',  '{}'::jsonb),
  (:adm,  'b462-adm@b462.test',  '{}'::jsonb),
  (:mgr,  'b462-mgr@b462.test',  '{}'::jsonb),
  (:stf,  'b462-stf@b462.test',  '{}'::jsonb),
  (:vwr,  'b462-vwr@b462.test',  '{}'::jsonb),
  (:two,  'b462-two@b462.test',  '{}'::jsonb),
  (:both, 'b462-both@b462.test', '{}'::jsonb),
  (:mgrB, 'b462-mgrb@b462.test', '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:orgA, 'B462 Stock Org A', 'b462-stock-org-a'),
  (:orgB, 'B462 Stock Org B', 'b462-stock-org-b');
insert into public.organization_members (organization_id, user_id, role, accepted_at, all_warehouses) values
  (:orgA, :own,  'owner',   now(), false),
  (:orgA, :adm,  'admin',   now(), false),
  (:orgA, :mgr,  'manager', now(), false),
  (:orgA, :stf,  'staff',   now(), false),
  (:orgA, :vwr,  'viewer',  now(), false),
  (:orgA, :two,  'admin',   now(), false),
  (:orgB, :two,  'staff',   now(), false),
  (:orgA, :both, 'admin',   now(), false),
  (:orgB, :both, 'admin',   now(), false),
  (:orgB, :mgrB, 'manager', now(), false);
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgA, 'B462 Main',   'WH-B462A', 'active'),
  (:whS, :orgA, 'B462 Spare',  'WH-B462S', 'active'),
  (:whB, :orgB, 'B462 Other',  'WH-B462B', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :stf, :whA, true),
  (:orgA, :vwr, :whA, true),
  (:orgB, :two, :whB, true);
insert into public.bins (id, organization_id, warehouse_id, code, name, bin_type) values
  (:binA,  :orgA, :whA, 'B462-A1', 'Aisle 1 shelf', 'storage'),
  (:binA2, :orgA, :whA, 'B462-A2', 'Aisle 2 shelf', 'storage'),
  (:binB,  :orgB, :whB, 'B462-B1', 'Dock shelf',    'storage'),
  (:binB2, :orgB, :whB, 'B462-B2', 'Spare shelf',   'storage');
insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type) values
  (:itA, :orgA, :whA, 'B462-A', 'Folding table', 0, 'active', 'asset'),
  (:itA2, :orgA, :whA, 'B462-A2', 'Stack chair', 0, 'active', 'asset'),
  (:itB, :orgB, :whB, 'B462-B', 'Floor lamp',    0, 'active', 'asset');
insert into public.inventory_stock (id, organization_id, warehouse_id, bin_id, item_id, qty_on_hand) values
  (:stkA, :orgA, :whA, :binA, :itA, 5),
  (:stkX, :orgA, :whA, :binB, :itA2, 3);
insert into public.putaway_moves (id, organization_id, warehouse_id, item_id, from_bin_id, to_bin_id, qty_base, movement_type, performed_by) values
  (:mvA, :orgA, :whA, :itA, :binA, :binA2, 2, 'putaway', :stf);
insert into public.categories (id, organization_id, name) values
  (:catA,  :orgA, 'B462 Furniture'),
  (:catA2, :orgA, 'B462 Seating'),
  (:catB,  :orgB, 'B462 Lighting');
insert into public.user_category_assignments (id, organization_id, user_id, category_id, assigned_by) values
  (:ucaA, :orgA, :vwr, :catA, :mgr);
insert into public.locations (id, organization_id, warehouse_id, name, type) values
  (:locA, :orgA, :whA, 'B462 Aisle 1', 'room'),
  (:locB, :orgB, :whB, 'B462 Aisle B', 'room');
insert into public.locations (id, organization_id, warehouse_id, name, type, parent_id) values
  (:locSite, :orgA, null, 'B462 Annex', null, null);

-- ══ Helpers (0387's, as 0419 and 0423 use them) ══════════════════════════
create function pg_temp.hint(p_hint text) returns text language sql immutable as $$
  select case when p_hint is null or p_hint = ''
                or p_hint like 'Grant the required privileges to the current role with:%'
              then '-' else p_hint end
$$;
-- One statement as p_as with p_sub's claims, then ALWAYS undone. 'ok:<rows>
-- [:<p_check>]' (p_check as the superuser, inside the undone subtransaction),
-- else '<sqlstate>:<hint or ->:<message>'.
create function pg_temp.attempt(p_as text, p_sub uuid, p_sql text, p_prep text default null, p_check text default null)
returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text; v_n bigint; v_seen text;
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
    raise exception using errcode = 'XX462', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XX462' then
    return 'ok:' || v_n::text || coalesce(':' || v_seen, '');
  end if;
  return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
end $$;

-- One query as the superuser, its single text value, or '<sqlstate>:<message>'
-- when it fails (the H lines read a function by name).
create function pg_temp.val(p_sql text) returns text language plpgsql as $$
declare v text; v_state text; v_msg text;
begin
  execute p_sql into v;
  return v;
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  return v_state || ':' || v_msg;
end $$;

create temp table persona (who text primary key, id uuid);
insert into persona (who, id) values
  ('own', :own), ('adm', :adm), ('mgr', :mgr), ('stf', :stf), ('vwr', :vwr),
  ('two', :two), ('both', :both), ('mgrB', :mgrB);

-- The same statement for each named persona, each call undone:
-- 'who=<attempt>, who=<attempt>, ...'. %1$s in p_sql is the persona's name.
create function pg_temp.each(p_who text[], p_sql text, p_check text default null)
returns text language plpgsql as $$
declare v text := ''; w text;
begin
  foreach w in array p_who loop
    v := v || case when v = '' then '' else ', ' end || w || '='
           || pg_temp.attempt('authenticated', (select p.id from persona p where p.who = w),
                              format(p_sql, w), null,
                              case when p_check is null then null else format(p_check, w) end);
  end loop;
  return v;
end $$;

-- A table's INSERT, UPDATE and ALL rules, deparsed with search_path pinned
-- (the migrations' form): one line per rule,
-- name|cmd|permissive|roles|USING|WITH CHECK.
create function pg_temp.rules(p_tbl regclass) returns text language sql stable set search_path = public, extensions as $$
  select string_agg(pol.polname || '|' || pol.polcmd::text || '|' || pol.polpermissive::text || '|'
                    || (select string_agg(case x when 0 then 'public' else x::regrole::text end, ',' order by 1)
                          from unnest(pol.polroles) x)
                    || '|' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '-')
                    || '|' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '-'), E'\n' order by pol.polname)
    from pg_policy pol
   where pol.polrelid = p_tbl and pol.polcmd in ('a', 'w', '*')
$$;
-- A rule's USING, deparsed the same way.
create function pg_temp.using_of(p_tbl regclass, p_name text) returns text language sql stable set search_path = public, extensions as $$
  select pg_get_expr(pol.polqual, pol.polrelid) from pg_policy pol where pol.polrelid = p_tbl and pol.polname = p_name
$$;

-- What the Z line compares: organization A's stock rows, put-away rows,
-- categories (name/parent), category assignments, and every warehouse,
-- location and bin of the two organizations with its organization.
create function pg_temp.state() returns text language sql stable as $$
  select coalesce((select string_agg(s.id::text || '/' || s.bin_id::text || '/' || s.qty_on_hand::text, ',' order by s.id)
                     from public.inventory_stock s
                    where s.organization_id = '04620000-0000-0000-0000-00000000000a'), '-')
      || ' # ' || coalesce((select string_agg(m.id::text || '/' || m.from_bin_id::text || '/' || m.to_bin_id::text || '/' || coalesce(m.notes, '-'), ',' order by m.id)
                     from public.putaway_moves m
                    where m.organization_id = '04620000-0000-0000-0000-00000000000a'), '-')
      || ' # ' || coalesce((select string_agg(c.name || '/' || coalesce(c.parent_id::text, '-'), ',' order by c.name collate "C")
                     from public.categories c
                    where c.organization_id in ('04620000-0000-0000-0000-00000000000a', '04620000-0000-0000-0000-00000000000b')), '-')
      || ' # ' || coalesce((select string_agg(u.user_id::text || '/' || u.category_id::text, ',' order by u.user_id, u.category_id)
                     from public.user_category_assignments u
                    where u.organization_id = '04620000-0000-0000-0000-00000000000a'), '-')
      || ' # ' || coalesce((select string_agg(w.code || '/' || w.organization_id::text || '/' || w.name || '/' || w.status, ',' order by w.code collate "C")
                     from public.warehouses w
                    where w.organization_id in ('04620000-0000-0000-0000-00000000000a', '04620000-0000-0000-0000-00000000000b')), '-')
      || ' # ' || coalesce((select string_agg(l.name || '/' || l.organization_id::text, ',' order by l.name collate "C")
                     from public.locations l
                    where l.organization_id in ('04620000-0000-0000-0000-00000000000a', '04620000-0000-0000-0000-00000000000b')), '-')
      || ' # ' || coalesce((select string_agg(b.code || '/' || b.organization_id::text, ',' order by b.code collate "C")
                     from public.bins b
                    where b.organization_id in ('04620000-0000-0000-0000-00000000000a', '04620000-0000-0000-0000-00000000000b')), '-')
$$;
create temp table snap as select pg_temp.state() as v;

-- ══ F. The fixture ════════════════════════════════════════════════════════
select is(
  (select string_agg(p.who || ':' || coalesce(ma.role, '-') || '/' || coalesce(mb.role, '-'), ' ' order by p.who collate "C")
     from persona p
     left join public.organization_members ma on ma.user_id = p.id and ma.organization_id = :orgA
     left join public.organization_members mb on mb.user_id = p.id and mb.organization_id = :orgB),
  'adm:admin/- both:admin/admin mgr:manager/- mgrB:-/manager own:owner/- stf:staff/- two:admin/staff vwr:viewer/-',
  'F1: each persona''s rank in organization A and in organization B');
select is(
  (select string_agg(b.code || ':' || (b.organization_id = :orgA)::text, ' ' order by b.code collate "C") from public.bins b
    where b.id in (:binA, :binA2, :binB, :binB2)),
  'B462-A1:true B462-A2:true B462-B1:false B462-B2:false',
  'F2: binA and binA2 are organization A''s, binB and binB2 organization B''s');

-- ══ H. bin_in_org ═════════════════════════════════════════════════════════
select is(
  pg_temp.val(format($q$select public.bin_in_org(null, %1$L)::text || '/' || public.bin_in_org(%2$L, %1$L)::text
          || '/' || public.bin_in_org(%3$L, %1$L)::text || '/' || public.bin_in_org(%2$L, %4$L)::text
          || '/' || public.bin_in_org('04620000-0000-0000-0000-0000000009ff', %1$L)::text$q$, :orgA, :binA, :binB, :orgB)),
  'true/true/false/false/false',
  'H1: bin_in_org is true for no bin and for a bin of the organization, false for another organization''s bin and for an id that is no bin');
select is(
  (select p.prosecdef::text || '|' || p.provolatile::text || '|' || coalesce(array_to_string(p.proconfig, ','), '-')
          || '|' || pg_get_userbyid(p.proowner) || '|' || l.lanname
          || '|' || has_function_privilege('anon', p.oid, 'execute')::text
          || '|' || has_function_privilege('authenticated', p.oid, 'execute')::text
          || '|' || has_function_privilege('service_role', p.oid, 'execute')::text
          || '|' || (p.proacl::text = w.proacl::text)::text
          || '|' || (replace(replace(p.prosrc, 'bins', 'X'), 'p_bin_id', 'p_x')
                     = replace(replace(w.prosrc, 'warehouses', 'X'), 'p_warehouse_id', 'p_x'))::text
     from pg_proc p join pg_language l on l.oid = p.prolang,
          pg_proc w
    where p.oid = to_regprocedure('public.bin_in_org(uuid,uuid)')
      and w.oid = to_regprocedure('public.warehouse_in_org(uuid,uuid)')),
  'true|s|search_path=public|postgres|sql|false|true|true|true|true',
  'H2: bin_in_org is SECURITY DEFINER, stable, search_path public, owned by postgres, sql, executable by authenticated and service_role only (warehouse_in_org''s ACL), and warehouse_in_org''s body with bins for warehouses');

-- ══ B. Bins ═══════════════════════════════════════════════════════════════
select is(
  pg_temp.each(array['own', 'adm', 'mgr', 'stf', 'vwr', 'two', 'both'],
    format($q$insert into public.inventory_stock (organization_id, warehouse_id, bin_id, item_id, qty_on_hand)
              values (%L, %L, %L, %L, 1)$q$, :orgA, :whA, :binB, :itA))
  || ', anon=' || pg_temp.attempt('anon', null,
    format($q$insert into public.inventory_stock (organization_id, warehouse_id, bin_id, item_id, qty_on_hand)
              values (%L, %L, %L, %L, 1)$q$, :orgA, :whA, :binB, :itA)),
  'own=42501:-:new row violates row-level security policy for table "inventory_stock", '
  || 'adm=42501:-:new row violates row-level security policy for table "inventory_stock", '
  || 'mgr=42501:-:new row violates row-level security policy for table "inventory_stock", '
  || 'stf=42501:-:new row violates row-level security policy for table "inventory_stock", '
  || 'vwr=42501:-:new row violates row-level security policy for table "inventory_stock", '
  || 'two=42501:-:new row violates row-level security policy for table "inventory_stock", '
  || 'both=42501:-:new row violates row-level security policy for table "inventory_stock", '
  || 'anon=42501:-:new row violates row-level security policy for table "inventory_stock"',
  'B1: a stock row of A naming B''s bin, inserted by each rank of A and by members of both: refused 42501 (anon: no rule at all)');
select is(
  pg_temp.each(array['own', 'adm', 'mgr', 'stf', 'two', 'both'],
    format('update public.inventory_stock set bin_id = %L where id = %L', :binB, :stkA)),
  'own=42501:-:new row violates row-level security policy for table "inventory_stock", '
  || 'adm=42501:-:new row violates row-level security policy for table "inventory_stock", '
  || 'mgr=42501:-:new row violates row-level security policy for table "inventory_stock", '
  || 'stf=42501:-:new row violates row-level security policy for table "inventory_stock", '
  || 'two=42501:-:new row violates row-level security policy for table "inventory_stock", '
  || 'both=42501:-:new row violates row-level security policy for table "inventory_stock"',
  'B2: B''s bin set on a stock row of A by an update, by each rank and by members of both: refused 42501');
select is(
  pg_temp.each(array['own', 'adm', 'mgr', 'stf', 'vwr', 'two'],
    format($q$insert into public.inventory_stock (organization_id, warehouse_id, bin_id, item_id, qty_on_hand)
              values (%L, %L, %L, %L, 1)$q$, :orgA, :whA, :binA2, :itA))
  || ' / ' || pg_temp.each(array['own', 'adm', 'mgr', 'stf', 'vwr', 'two'],
    format('update public.inventory_stock set bin_id = %L where id = %L', :binA2, :stkA))
  || ' / ' || pg_temp.each(array['mgr', 'stf'],
    format('update public.inventory_stock set qty_on_hand = 7 where id = %L', :stkA)),
  'own=ok:1, adm=ok:1, mgr=ok:1, stf=ok:1, vwr=42501:-:new row violates row-level security policy for table "inventory_stock", two=ok:1'
  || ' / own=ok:1, adm=ok:1, mgr=ok:1, stf=ok:1, vwr=ok:0, two=ok:1'
  || ' / mgr=ok:1, stf=ok:1',
  'B3: a stock row of A in A''s own bin, inserted, moved to another bin of A and its quantity changed, for each rank: as before');
select is(
  pg_temp.each(array['mgr', 'stf', 'two', 'both'],
    format($q$insert into public.putaway_moves (organization_id, warehouse_id, item_id, from_bin_id, to_bin_id, qty_base, movement_type, performed_by)
              values (%L, %L, %L, %L, %L, 1, 'putaway', auth.uid())$q$, :orgA, :whA, :itA, :binB, :binA2))
  || ' / ' || pg_temp.each(array['mgr', 'stf', 'two', 'both'],
    format($q$insert into public.putaway_moves (organization_id, warehouse_id, item_id, from_bin_id, to_bin_id, qty_base, movement_type, performed_by)
              values (%L, %L, %L, %L, %L, 1, 'putaway', auth.uid())$q$, :orgA, :whA, :itA, :binA, :binB))
  || ' / ' || pg_temp.each(array['mgr', 'both'],
    format('update public.putaway_moves set from_bin_id = %L where id = %L', :binB, :mvA))
  || ' / ' || pg_temp.each(array['mgr', 'both'],
    format('update public.putaway_moves set to_bin_id = %L where id = %L', :binB2, :mvA)),
  'mgr=42501:-:new row violates row-level security policy for table "putaway_moves", stf=42501:-:new row violates row-level security policy for table "putaway_moves", '
  || 'two=42501:-:new row violates row-level security policy for table "putaway_moves", both=42501:-:new row violates row-level security policy for table "putaway_moves"'
  || ' / mgr=42501:-:new row violates row-level security policy for table "putaway_moves", stf=42501:-:new row violates row-level security policy for table "putaway_moves", '
  || 'two=42501:-:new row violates row-level security policy for table "putaway_moves", both=42501:-:new row violates row-level security policy for table "putaway_moves"'
  || ' / mgr=42501:-:new row violates row-level security policy for table "putaway_moves", both=42501:-:new row violates row-level security policy for table "putaway_moves"'
  || ' / mgr=42501:-:new row violates row-level security policy for table "putaway_moves", both=42501:-:new row violates row-level security policy for table "putaway_moves"',
  'B4: a put-away row of A naming B''s bin as its source or its destination, inserted or set by an update: refused 42501');
select is(
  pg_temp.each(array['own', 'adm', 'mgr', 'stf', 'vwr', 'two'],
    format($q$insert into public.putaway_moves (organization_id, warehouse_id, item_id, from_bin_id, to_bin_id, qty_base, movement_type, performed_by)
              values (%L, %L, %L, %L, %L, 1, 'putaway', auth.uid())$q$, :orgA, :whA, :itA, :binA, :binA2))
  || ' / ' || pg_temp.each(array['mgr', 'stf'],
    format($q$update public.putaway_moves set from_bin_id = %L, to_bin_id = %L, notes = 'Moved back' where id = %L$q$, :binA2, :binA, :mvA)),
  'own=ok:1, adm=ok:1, mgr=ok:1, stf=ok:1, vwr=42501:-:new row violates row-level security policy for table "putaway_moves", two=ok:1'
  || ' / mgr=ok:1, stf=ok:1',
  'B5: a put-away row of A between A''s own bins, inserted and changed, for each rank: as before');
select is(
  pg_temp.attempt('service_role', null,
    format($q$insert into public.inventory_stock (organization_id, warehouse_id, bin_id, item_id, qty_on_hand)
              values (%L, %L, %L, %L, 1)$q$, :orgA, :whA, :binB, :itA))
  || ' / ' || pg_temp.attempt('service_role', null,
    format('update public.putaway_moves set to_bin_id = %L where id = %L', :binB, :mvA)),
  'ok:1 / ok:1',
  'B6: the service role writes past the rules, as before');
select is(
  pg_temp.attempt('authenticated', :mgrB, format('delete from public.bins where id = %L', :binB2)),
  'ok:1',
  'B7: B''s manager deletes a bin of B that nothing names');
select is(
  md5(pg_temp.rules('public.inventory_stock')) || '|' || md5(pg_temp.rules('public.putaway_moves'))
  || '|' || pg_temp.using_of('public.inventory_stock', 'inventory_stock_write')
  || '|' || pg_temp.using_of('public.putaway_moves', 'putaway_moves_write'),
  '4ee3d63a266f1d25' || 'b558709899cb029d' || '|' || 'a819d76e7bc5a30e' || '9188fa257e262366'
  || '|( SELECT has_org_role(inventory_stock.organization_id, ''staff''::text) AS has_org_role)'
  || '|( SELECT has_org_role(putaway_moves.organization_id, ''staff''::text) AS has_org_role)',
  'B8: the inventory_stock and putaway_moves INSERT, UPDATE and ALL rules are exactly the new ones, and their USING is unchanged');


select is(
  pg_temp.each(array['own', 'adm', 'mgr', 'stf', 'two', 'both'],
    format($q$insert into public.inventory_stock (organization_id, warehouse_id, bin_id, item_id, qty_on_hand)
              values (%L, %L, %L, %L, 1)$q$, :orgA, :whA, :binA2, :itB))
  || ' / ' || pg_temp.each(array['mgr', 'stf', 'both'],
    format('update public.inventory_stock set item_id = %L where id = %L', :itB, :stkA))
  || ' / ' || pg_temp.each(array['mgr', 'stf', 'both'],
    format($q$insert into public.putaway_moves (organization_id, warehouse_id, item_id, from_bin_id, to_bin_id, qty_base, movement_type, performed_by)
              values (%L, %L, %L, %L, %L, 1, 'putaway', auth.uid())$q$, :orgA, :whA, :itB, :binA, :binA2))
  || ' / ' || pg_temp.each(array['mgr', 'both'],
    format('update public.putaway_moves set item_id = %L where id = %L', :itB, :mvA))
  || ' // ' || pg_temp.each(array['mgr', 'stf'],
    format('update public.inventory_stock set item_id = %L where id = %L', :itA2, :stkA))
  || ' / ' || pg_temp.each(array['mgr', 'stf'],
    format($q$insert into public.putaway_moves (organization_id, warehouse_id, item_id, from_bin_id, to_bin_id, qty_base, movement_type, performed_by)
              values (%L, %L, %L, %L, %L, 1, 'putaway', auth.uid())$q$, :orgA, :whA, :itA2, :binA, :binA2))
  || ' / ' || pg_temp.each(array['mgr', 'stf'],
    format('update public.putaway_moves set item_id = %L where id = %L', :itA2, :mvA)),
  'own=42501:-:new row violates row-level security policy for table "inventory_stock", adm=42501:-:new row violates row-level security policy for table "inventory_stock", '
  || 'mgr=42501:-:new row violates row-level security policy for table "inventory_stock", stf=42501:-:new row violates row-level security policy for table "inventory_stock", '
  || 'two=42501:-:new row violates row-level security policy for table "inventory_stock", both=42501:-:new row violates row-level security policy for table "inventory_stock"'
  || ' / mgr=42501:-:new row violates row-level security policy for table "inventory_stock", stf=42501:-:new row violates row-level security policy for table "inventory_stock", both=42501:-:new row violates row-level security policy for table "inventory_stock"'
  || ' / mgr=42501:-:new row violates row-level security policy for table "putaway_moves", stf=42501:-:new row violates row-level security policy for table "putaway_moves", both=42501:-:new row violates row-level security policy for table "putaway_moves"'
  || ' / mgr=42501:-:new row violates row-level security policy for table "putaway_moves", both=42501:-:new row violates row-level security policy for table "putaway_moves"'
  || ' // mgr=ok:1, stf=ok:1 / mgr=ok:1, stf=ok:1 / mgr=ok:1, stf=ok:1',
  'B9: a stock or put-away row of A naming B''s item, inserted or set by an update, by each rank and by members of both: refused 42501; A''s other item, as before');
select is(
  pg_temp.each(array['stf', 'both'],
    format($q$insert into public.inventory_stock (id, organization_id, warehouse_id, bin_id, item_id, qty_on_hand)
              values (%L, %L, %L, %L, %L, 1)
              on conflict (id) do update set bin_id = %L$q$, :stkA, :orgA, :whA, :binA, :itA, :binB))
  || ' / ' || pg_temp.each(array['stf', 'both'],
    format($q$insert into public.inventory_stock (organization_id, warehouse_id, bin_id, item_id, qty_on_hand)
              values (%L, %L, %L, %L, 1)
              on conflict do nothing$q$, :orgA, :whA, :binB, :itA))
  || ' / ' || pg_temp.each(array['stf', 'both'],
    format($q$insert into public.inventory_stock (id, organization_id, warehouse_id, bin_id, item_id, qty_on_hand)
              values (%L, %L, %L, %L, %L, 1)
              on conflict (id) do update set qty_on_hand = 9$q$, :stkA, :orgA, :whA, :binA, :itA)),
  'stf=42501:-:new row violates row-level security policy for table "inventory_stock", both=42501:-:new row violates row-level security policy for table "inventory_stock"'
  || ' / stf=42501:-:new row violates row-level security policy for table "inventory_stock", both=42501:-:new row violates row-level security policy for table "inventory_stock"'
  || ' / stf=ok:1, both=ok:1',
  'B10: an upsert that updates a stock row of A to B''s bin, and one whose insert names B''s bin: refused 42501; an upsert of the quantity in A''s own bin, as before');
select is(
  pg_temp.each(array['stf'], format('update public.inventory_stock set qty_on_hand = 4 where id = %L', :stkX))
  || ' / ' || pg_temp.each(array['stf'],
    format('update public.inventory_stock set bin_id = %L where id = %L', :binA2, :stkX), $c$select (select bin_id::text from public.inventory_stock where id = '04620000-0000-0000-0000-000000000602')$c$)
  || ' / ' || pg_temp.each(array['stf', 'vwr'], format('delete from public.inventory_stock where id = %L', :stkX)),
  'stf=42501:-:new row violates row-level security policy for table "inventory_stock" / stf=ok:1:' || :binA2 || ' / stf=ok:1, vwr=ok:0',
  'B11: a stored stock row of A naming B''s bin takes no quantity change, may be pointed back at A''s bin, and may be removed by staff (a viewer removes nothing)');

-- ══ C. Categories ═════════════════════════════════════════════════════════
select is(
  pg_temp.each(array['own', 'adm', 'mgr', 'two', 'both'],
    format($q$insert into public.categories (organization_id, name, parent_id) values (%L, 'B462 Lamps %%1$s', %L)$q$, :orgA, :catB)),
  'own=42501:-:new row violates row-level security policy for table "categories", '
  || 'adm=42501:-:new row violates row-level security policy for table "categories", '
  || 'mgr=42501:-:new row violates row-level security policy for table "categories", '
  || 'two=42501:-:new row violates row-level security policy for table "categories", '
  || 'both=42501:-:new row violates row-level security policy for table "categories"',
  'C1: a category of A whose parent is B''s category, inserted by an owner, admin, manager and members of both: refused 42501');
select is(
  pg_temp.each(array['own', 'adm', 'mgr', 'both'],
    format('update public.categories set parent_id = %L where id = %L', :catB, :catA2)),
  'own=42501:-:new row violates row-level security policy for table "categories", '
  || 'adm=42501:-:new row violates row-level security policy for table "categories", '
  || 'mgr=42501:-:new row violates row-level security policy for table "categories", '
  || 'both=42501:-:new row violates row-level security policy for table "categories"',
  'C2: B''s category set as the parent of a category of A: refused 42501');
select is(
  pg_temp.each(array['own', 'adm', 'mgr', 'stf', 'vwr', 'both'],
    format($q$insert into public.categories (organization_id, name, parent_id) values (%L, 'B462 Chairs %%1$s', %L)$q$, :orgA, :catA))
  || ' / ' || pg_temp.each(array['own', 'adm', 'mgr', 'stf', 'vwr', 'both'],
    format($q$insert into public.categories (organization_id, name, parent_id) values (%L, 'B462 Desks %%1$s', null)$q$, :orgA)),
  'own=ok:1, adm=ok:1, mgr=ok:1, stf=42501:-:new row violates row-level security policy for table "categories", '
  || 'vwr=42501:-:new row violates row-level security policy for table "categories", both=ok:1'
  || ' / own=ok:1, adm=ok:1, mgr=ok:1, stf=42501:-:new row violates row-level security policy for table "categories", '
  || 'vwr=42501:-:new row violates row-level security policy for table "categories", both=ok:1',
  'C3: a category of A with A''s own parent and with no parent, for each rank: as before');
select is(
  pg_temp.each(array['mgr', 'stf'], format('update public.categories set parent_id = %L where id = %L', :catA, :catA2))
  || ' / ' || pg_temp.each(array['mgr', 'stf'], format('update public.categories set parent_id = null where id = %L', :catA2))
  || ' / ' || pg_temp.each(array['mgr', 'both'], format($q$update public.categories set name = 'B462 Seats' where id = %L$q$, :catA2)),
  'mgr=ok:1, stf=ok:0 / mgr=ok:1, stf=ok:0 / mgr=ok:1, both=ok:1',
  'C4: setting A''s own category as the parent, clearing it, and a rename: as before');
select is(
  pg_temp.each(array['own', 'adm', 'mgr', 'both'],
    format('insert into public.user_category_assignments (organization_id, user_id, category_id) values (%L, %L, %L)', :orgA, :vwr, :catB))
  || ' / ' || pg_temp.each(array['mgr', 'both'],
    format('update public.user_category_assignments set category_id = %L where id = %L', :catB, :ucaA)),
  'own=42501:-:new row violates row-level security policy for table "user_category_assignments", '
  || 'adm=42501:-:new row violates row-level security policy for table "user_category_assignments", '
  || 'mgr=42501:-:new row violates row-level security policy for table "user_category_assignments", '
  || 'both=42501:-:new row violates row-level security policy for table "user_category_assignments"'
  || ' / mgr=42501:-:new row violates row-level security policy for table "user_category_assignments", '
  || 'both=42501:-:new row violates row-level security policy for table "user_category_assignments"',
  'C5: an assignment of A naming B''s category, inserted or set by an update: refused 42501');
select is(
  pg_temp.each(array['own', 'adm', 'mgr', 'stf', 'both'],
    format('insert into public.user_category_assignments (organization_id, user_id, category_id) values (%L, %L, %L)', :orgA, :vwr, :catA2))
  || ' / ' || pg_temp.each(array['mgr', 'stf'],
    format('update public.user_category_assignments set category_id = %L where id = %L', :catA2, :ucaA))
  || ' / ' || pg_temp.each(array['mgr'],
    format('delete from public.user_category_assignments where id = %L', :ucaA)),
  'own=ok:1, adm=ok:1, mgr=ok:1, stf=42501:-:new row violates row-level security policy for table "user_category_assignments", both=ok:1'
  || ' / mgr=ok:1, stf=ok:0 / mgr=ok:1',
  'C6: an assignment of A''s own category, inserted, changed and removed, for each rank: as before');
select is(
  pg_temp.attempt('authenticated', :mgr,
    format('select public.set_user_category_access(%L, %L, %L, array[%L, %L]::uuid[])', :orgA, :vwr, :mgr, :catA, :catB), null,
    format('select count(*)::text from public.user_category_assignments where organization_id = %L and user_id = %L', :orgA, :vwr))
  || ' / ' || pg_temp.attempt('authenticated', :mgr,
    format('select public.set_user_category_access(%L, %L, %L, array[%L, %L]::uuid[])', :orgA, :vwr, :mgr, :catA, :catA2), null,
    format('select string_agg(category_id::text, %L order by category_id) from public.user_category_assignments where organization_id = %L and user_id = %L', ',', :orgA, :vwr))
  || ' / ' || pg_temp.attempt('authenticated', :mgr,
    format('select public.set_user_category_access(%L, %L, %L, array[]::uuid[])', :orgA, :vwr, :mgr), null,
    format('select count(*)::text from public.user_category_assignments where organization_id = %L and user_id = %L', :orgA, :vwr)),
  '42501:-:A category is not part of this organization. / ok:1:' || :catA || ',' || :catA2 || ' / ok:1:0',
  'C7: set_user_category_access refuses a list with B''s category and writes nothing; A''s own categories and an empty list, as before');
select is(
  pg_temp.attempt('service_role', null,
    format($q$insert into public.categories (organization_id, name, parent_id) values (%L, 'B462 Service', %L)$q$, :orgA, :catB))
  || ' / ' || pg_temp.attempt('service_role', null,
    format('update public.user_category_assignments set category_id = %L where id = %L', :catB, :ucaA)),
  'ok:1 / ok:1',
  'C8: the service role writes past the rules, as before');
select is(
  md5(pg_temp.rules('public.categories')) || '|' || md5(pg_temp.rules('public.user_category_assignments'))
  || '|' || pg_temp.using_of('public.categories', 'categories_update')
  || '|' || pg_temp.using_of('public.user_category_assignments', 'user_category_assignments_write'),
  '53417f61aae6901e' || 'e73c49968771246b' || '|' || 'f880915924e5bb22' || 'ea78cd91b2a8f206'
  || '|(( SELECT has_org_role(categories.organization_id, ''manager''::text) AS has_org_role)'
  || ' OR ( SELECT has_permission(categories.organization_id, ''categories:manage''::text) AS has_permission))'
  || '|( SELECT has_org_role(user_category_assignments.organization_id, ''manager''::text) AS has_org_role)',
  'C9: the categories and user_category_assignments INSERT, UPDATE and ALL rules are exactly the new ones, and their USING is unchanged');
select is(
  (select md5(p.prosrc) || '|' || p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ','), '-')
          || '|' || pg_get_userbyid(p.proowner)
          || '|' || has_function_privilege('anon', p.oid, 'execute')::text
          || '|' || has_function_privilege('authenticated', p.oid, 'execute')::text
     from pg_proc p where p.oid = to_regprocedure('public.set_user_category_access(uuid,uuid,uuid,uuid[])')),
  '4d01697e2783ac43' || '4c8e3183c693b47f' || '|true|search_path=public|postgres|false|true',
  'C10: set_user_category_access is the new body, SECURITY DEFINER with search_path public, owned by postgres, executable by authenticated and not by anon');

-- ══ O. A warehouse's and a location's organization ═══════════════════════
select is(
  pg_temp.each(array['own', 'adm', 'both'],
    format('update public.warehouses set organization_id = %L where id = %L', :orgB, :whA)),
  'own=42501:-:A warehouse cannot be moved to another organization., '
  || 'adm=42501:-:A warehouse cannot be moved to another organization., '
  || 'both=42501:-:A warehouse cannot be moved to another organization.',
  'O1: a warehouse of A moved to B by an owner, an admin and an admin of both: refused 42501');
select is(
  pg_temp.each(array['own', 'mgr', 'both'],
    format('update public.locations set organization_id = %L where id = %L', :orgB, :locSite))
  || ' / ' || pg_temp.each(array['both'],
    format('update public.locations set organization_id = %L, warehouse_id = %L where id = %L', :orgB, :whB, :locA)),
  'own=42501:-:A location cannot be moved to another organization., '
  || 'mgr=42501:-:A location cannot be moved to another organization., '
  || 'both=42501:-:A location cannot be moved to another organization.'
  || ' / both=42501:-:A location cannot be moved to another organization.',
  'O2: a location of A with no warehouse and no parent, and one moved with a warehouse of B, moved to B: refused 42501');
select is(
  pg_temp.attempt('authenticated', :both,
    format($q$insert into public.warehouses (id, organization_id, name, code, status) values (%L, %L, 'B462 Main', 'WH-B462A', 'active')
              on conflict (id) do update set organization_id = excluded.organization_id$q$, :whA, :orgB))
  || ' / ' || pg_temp.attempt('authenticated', :both,
    format($q$insert into public.locations (id, organization_id, warehouse_id, name, type) values (%L, %L, null, 'B462 Annex', null)
              on conflict (id) do update set organization_id = excluded.organization_id$q$, :locSite, :orgB)),
  '42501:-:A warehouse cannot be moved to another organization. / 42501:-:A location cannot be moved to another organization.',
  'O3: an upsert onto a warehouse or a location of A that proposes organization B, by an admin of both: refused 42501');
select is(
  pg_temp.each(array['own', 'adm', 'both'],
    format($q$update public.warehouses set name = 'B462 Main %%1$s', organization_id = %L where id = %L$q$, :orgA, :whA))
  || ' / ' || pg_temp.each(array['adm'], format($q$update public.warehouses set status = 'archived' where id = %L$q$, :whS))
  || ' / ' || pg_temp.each(array['own', 'mgr', 'both', 'stf'],
    format($q$update public.locations set name = 'B462 Aisle %%1$s', organization_id = %L where id = %L$q$, :orgA, :locA))
  || ' / ' || pg_temp.each(array['mgr'], format('update public.locations set parent_id = %L where id = %L', :locA, :locSite)),
  'own=ok:1, adm=ok:1, both=ok:1 / adm=ok:1 / own=ok:1, mgr=ok:1, both=ok:1, stf=ok:0 / mgr=ok:1',
  'O4: updates that keep the organization (a rename sending the same organization_id, an archive, a new parent of A): as before');
select is(
  pg_temp.each(array['adm', 'both'],
    format($q$insert into public.warehouses (organization_id, name, code, status) values (%L, 'B462 New %%1$s', 'WH-B462N-%%1$s', 'active')$q$, :orgA))
  || ' / ' || pg_temp.each(array['mgr', 'both'],
    format($q$insert into public.locations (organization_id, warehouse_id, name, type) values (%L, %L, 'B462 Bay %%1$s', 'room')$q$, :orgA, :whA)),
  'adm=ok:1, both=ok:1 / mgr=ok:1, both=ok:1',
  'O5: a new warehouse and a new location of A: as before');
select is(
  pg_temp.attempt('service_role', null, format('update public.warehouses set organization_id = %L where id = %L', :orgB, :whS))
  || ' / ' || pg_temp.attempt('service_role', null, format('update public.locations set organization_id = %L where id = %L', :orgB, :locSite)),
  'ok:1 / ok:1',
  'O6: the service role is not held by the guard');
select is(
  (select md5(p.prosrc) || '|' || p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ','), '-')
          || '|' || pg_get_userbyid(p.proowner)
          || '|' || has_function_privilege('anon', p.oid, 'execute')::text
          || '|' || has_function_privilege('authenticated', p.oid, 'execute')::text
          || '|' || has_function_privilege('service_role', p.oid, 'execute')::text
     from pg_proc p where p.oid = to_regprocedure('public.tg_organization_id_fixed()')),
  '9054291fa6f24646' || 'ece8de5570134e38' || '|false|search_path=public|postgres|false|false|false',
  'O7: tg_organization_id_fixed is the new body, SECURITY INVOKER with search_path public, owned by postgres, executable by no API role');
select is(
  (select string_agg(t.tgrelid::regclass::text || ':' || t.tgname || ':' || t.tgtype::text || ':' || t.tgenabled::text
                     || ':' || pg_get_triggerdef(t.oid), E'\n' order by t.tgrelid::regclass::text)
     from pg_trigger t where t.tgfoid = to_regprocedure('public.tg_organization_id_fixed()')),
  'bins:trg_zz_bins_organization_fixed:19:O:CREATE TRIGGER trg_zz_bins_organization_fixed'
  || ' BEFORE UPDATE ON public.bins FOR EACH ROW WHEN ((new.organization_id IS DISTINCT FROM old.organization_id))'
  || ' EXECUTE FUNCTION tg_organization_id_fixed(''bin'')' || E'\n'
  || 'categories:trg_zz_categories_organization_fixed:19:O:CREATE TRIGGER trg_zz_categories_organization_fixed'
  || ' BEFORE UPDATE ON public.categories FOR EACH ROW WHEN ((new.organization_id IS DISTINCT FROM old.organization_id))'
  || ' EXECUTE FUNCTION tg_organization_id_fixed(''category'')' || E'\n'
  || 'locations:trg_zz_locations_organization_fixed:19:O:CREATE TRIGGER trg_zz_locations_organization_fixed'
  || ' BEFORE UPDATE ON public.locations FOR EACH ROW WHEN ((new.organization_id IS DISTINCT FROM old.organization_id))'
  || ' EXECUTE FUNCTION tg_organization_id_fixed(''location'')' || E'\n'
  || 'warehouses:trg_zz_warehouses_organization_fixed:19:O:CREATE TRIGGER trg_zz_warehouses_organization_fixed'
  || ' BEFORE UPDATE ON public.warehouses FOR EACH ROW WHEN ((new.organization_id IS DISTINCT FROM old.organization_id))'
  || ' EXECUTE FUNCTION tg_organization_id_fixed(''warehouse'')',
  'O8: the guard is bound once on each of warehouses, locations, bins and categories, BEFORE UPDATE FOR EACH ROW, only when organization_id changes');


select is(
  pg_temp.each(array['own', 'adm', 'mgr', 'both'],
    format('update public.bins set organization_id = %L, warehouse_id = %L where id = %L', :orgB, :whB, :binA))
  || ' / ' || pg_temp.each(array['both'],
    format('update public.bins set organization_id = %L where id = %L', :orgB, :binA))
  || ' / ' || pg_temp.attempt('authenticated', :both,
    format($q$insert into public.bins (id, organization_id, warehouse_id, code, name, bin_type) values (%L, %L, %L, 'B462-A1', 'Aisle 1 shelf', 'storage')
              on conflict (id) do update set organization_id = excluded.organization_id, warehouse_id = excluded.warehouse_id$q$, :binA, :orgB, :whB)),
  'own=42501:-:A bin cannot be moved to another organization., adm=42501:-:A bin cannot be moved to another organization., '
  || 'mgr=42501:-:A bin cannot be moved to another organization., both=42501:-:A bin cannot be moved to another organization.'
  || ' / both=42501:-:A bin cannot be moved to another organization.'
  || ' / 42501:-:A bin cannot be moved to another organization.',
  'O9: a bin of A moved to B with B''s warehouse, or alone, by an owner, an admin, a manager and an admin of both, and by upsert: refused 42501');
select is(
  pg_temp.each(array['own', 'adm', 'mgr', 'both'],
    format('update public.categories set organization_id = %L where id = %L', :orgB, :catA))
  || ' / ' || pg_temp.attempt('authenticated', :both,
    format($q$insert into public.categories (id, organization_id, name) values (%L, %L, 'B462 Furniture')
              on conflict (id) do update set organization_id = excluded.organization_id$q$, :catA, :orgB)),
  'own=42501:-:A category cannot be moved to another organization., adm=42501:-:A category cannot be moved to another organization., '
  || 'mgr=42501:-:A category cannot be moved to another organization., both=42501:-:A category cannot be moved to another organization.'
  || ' / 42501:-:A category cannot be moved to another organization.',
  'O10: a category of A moved to B by an owner, an admin, a manager and an admin of both, and by upsert: refused 42501');
select is(
  pg_temp.each(array['mgr', 'both'],
    format($q$update public.bins set name = 'Aisle 1 shelf %%1$s', organization_id = %L where id = %L$q$, :orgA, :binA))
  || ' / ' || pg_temp.each(array['mgr'], format($q$update public.bins set status = 'archived' where id = %L$q$, :binA2))
  || ' / ' || pg_temp.each(array['mgr', 'both'],
    format($q$update public.categories set name = 'B462 Furniture %%1$s', organization_id = %L where id = %L$q$, :orgA, :catA))
  || ' / ' || pg_temp.each(array['mgr'], format('update public.categories set deleted_at = now() where id = %L', :catA2))
  || ' / ' || pg_temp.each(array['stf'], format($q$update public.bins set name = 'Aisle 1' where id = %L$q$, :binA)),
  'mgr=ok:1, both=ok:1 / mgr=ok:1 / mgr=ok:1, both=ok:1 / mgr=ok:1 / stf=ok:0',
  'O11: a bin''s rename sending the same organization_id, a bin''s archive, a category''s rename sending the same organization_id and its soft delete: as before');
select is(
  pg_temp.attempt('service_role', null, format('update public.bins set organization_id = %L, warehouse_id = %L where id = %L', :orgB, :whB, :binA2))
  || ' / ' || pg_temp.attempt('service_role', null, format('update public.categories set organization_id = %L where id = %L', :orgB, :catA2)),
  'ok:1 / ok:1',
  'O12: the service role is not held by the guard on bins and categories');

-- ══ Z. Nothing left changed ═══════════════════════════════════════════════
select is(pg_temp.state(), (select v from snap),
  'Z1: the refused writes and the undone attempts left A''s stock and put-away rows, both organizations'' categories, A''s assignments, and both organizations'' warehouses, locations and bins as they were');

select * from finish();
rollback;
