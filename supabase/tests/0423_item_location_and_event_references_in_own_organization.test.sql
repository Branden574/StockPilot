-- supabase/tests/NNNN_item_location_and_event_references_in_own_organization.test.sql
-- (NNNN = the migration's number, given in ship order; nothing in this file
-- reads it)
-- pgTAP proof for the migration that holds these references to the row's
-- own organization, for every rank (a NULL reference passes):
--   * an item's warehouse and category: inventory_items_insert and
--     inventory_items_update ask warehouse_in_org and category_in_org of the
--     new row, and tg_inventory_items_guard refuses an insert by a member
--     whose warehouse is not the item's organization's, in the words its
--     update branch uses;
--   * a location's parent: locations_insert and locations_update ask
--     location_in_org(parent_id, organization_id) of the new row;
--   * an event's warehouse: schedule_events_insert asks
--     warehouse_in_org(warehouse_id, organization_id) of the new row.
-- No stored row changes. Every line states what the database does with the
-- migration applied.
--
-- Personas (organization A unless named):
--   own     owner
--   adm     admin
--   mgr     manager
--   allwh   staff with "all warehouses" (assignments to whA and whA2 by the
--           0280 trigger)
--   stf     staff assigned to whA
--   vwr     viewer assigned to whA
--   two     admin of A, and staff of B assigned to whB
--   twoStf  staff of A assigned to whA, and manager of B
--   mgrB    manager of B
--   both    admin of A and admin of B
-- Warehouses: whA and whA2 of A, whB of B. Items of A: itA (whA, the
-- update target), itDup (whA, the copy source), itX (whB, written by the
-- superuser past the rules: the row the U and D sections act on), rA (whA,
-- for rent); of B: rB (whB, for rent). Categories catA of A, catB of B.
-- Locations of A: locA, locA2 (whA), locA3 (no warehouse, parent locA); of
-- B: locB. Event evA of A in whA.
--
-- F.  The fixture is what the matrices assume.
-- I.  An insert of (organization A, warehouse of B), as a manager, admin,
--     owner, all-warehouses member, scoped staff, viewer and both
--     two-organization members acting in A: refused 42501 with the guard's
--     words, and no item, holding or movement row is written (I1, I2). An
--     account in neither organization gets the ordinary row level security
--     answer whichever warehouse it names, and anon has no INSERT (I3). A
--     two-row insert with one such row writes neither (I4); an upsert onto
--     an item of A that proposes B's warehouse is refused (I5).
-- S.  Inserts with the organization's own warehouses and with no warehouse,
--     for every persona: each answer is what it was before (matrix pinned).
-- U.  Updates: moving an item to B's warehouse is refused by the guard as
--     before (U1); the rule refuses it on its own too (U2, the guard's check
--     cut inside an undone attempt, as a member of both organizations, who
--     may see the row in B's warehouse); a stored item whose warehouse is
--     B's is not seen by a manager of A alone, as before, and takes no other
--     change from a member of both until it is moved back to one of A's
--     warehouses, which that member may do (U3). A plain rename of a
--     healthy item, for every persona, is as before (U4).
-- C.  Categories: an item of A with B's category, inserted for every rank
--     (C1), set on many items at once (C3) or on one (C4): refused 42501.
--     A's own category and no category, as before (C2, C3).
-- D.  duplicate_inventory_item copies an item of A in whA as before (D1); a
--     copy of the stored itX is not found for a manager of A alone, as
--     before, and refused for a member of both (D2). ledger.assemble_bundle's kit
--     item insert is covered by the bundle suite's X5 (an insert of a new kit
--     item in the kit's own warehouse, which still passes).
-- R.  create_rental: the rental's organization is the warehouse's; a member
--     of A alone is refused B's warehouse and nothing is written (R1); a
--     member of both rents B's item in B (R2) and cannot rent A's item from
--     B's warehouse (R3); A's own rental is as before (R4).
-- M.  Each layer alone refuses: the guard's new block cut leaves the rule's
--     refusal (M1); the rule's new term taken out leaves the guard's (M2).
-- P.  Posture: the guard's body is the new one, and cutting the new block
--     gives the previous body exactly (P1); SECURITY INVOKER, search_path,
--     owner and no EXECUTE for the API roles are kept (P2); the table's
--     INSERT, UPDATE and ALL rules are exactly the two new ones (P3), and
--     the UPDATE rule's USING is unchanged (P4).
-- L.  Locations: a location of A with B's location as its parent, inserted
--     (L1) or set by an update (L2) by an owner, admin, manager or a member
--     of both: refused 42501. Own parent and no parent, insert and update,
--     as before (L3, L4). The writers that make locations past the rules
--     still do: mint_placement_location with its own parent check (L5), a
--     new warehouse's default locations, the organization's Unplaced bucket
--     seeded by an item with no warehouse, and a service-role location with
--     no parent (L6). The locations rules are exactly the two new ones (L7).
--     An upsert that proposes B's location as the parent is refused (L8); a
--     location of A moved to B while it keeps a parent of A is refused (L9).
-- E.  Events: an event of A naming B's warehouse, filed by a member of both
--     organizations: refused 42501 (E1). A's own warehouse and no warehouse,
--     for each rank, as before (E2). Moving an event to B's warehouse is
--     refused by its UPDATE rule, as before (E3). The server's writers (an
--     order's event, a reminder stamp) still write (E4). The table's rules
--     are exactly the new INSERT rule and the unchanged UPDATE rule (E5).
-- Z.  Nothing the refused writes and the undone attempts touched was left
--     changed.
--
-- Roles: fixtures as the test superuser. Every attempt runs through
-- pg_temp.attempt (always undone) or pg_temp.kept / pg_temp.kept_sql (kept
-- when it succeeds),
-- which switch role and claims with set_config inside a subtransaction (the
-- 0387 helpers, as 0419 uses them). begin/rollback: nothing leaks.
-- Namespace 04230000; undo code XX423.

begin;

select plan(49);

\set orgA    '\'04230000-0000-0000-0000-00000000000a\''
\set orgB    '\'04230000-0000-0000-0000-00000000000b\''
\set own     '\'04230000-0000-0000-0000-0000000000a1\''
\set adm     '\'04230000-0000-0000-0000-0000000000a2\''
\set mgr     '\'04230000-0000-0000-0000-0000000000a3\''
\set allwh   '\'04230000-0000-0000-0000-0000000000a4\''
\set stf     '\'04230000-0000-0000-0000-0000000000a5\''
\set vwr     '\'04230000-0000-0000-0000-0000000000a6\''
\set two     '\'04230000-0000-0000-0000-0000000000a7\''
\set twoStf  '\'04230000-0000-0000-0000-0000000000a8\''
\set mgrB    '\'04230000-0000-0000-0000-0000000000b1\''
\set whA     '\'04230000-0000-0000-0000-0000000000d1\''
\set whA2    '\'04230000-0000-0000-0000-0000000000d2\''
\set whB     '\'04230000-0000-0000-0000-0000000000d3\''
\set itA     '\'04230000-0000-0000-0000-000000000101\''
\set itDup   '\'04230000-0000-0000-0000-000000000102\''
\set itX     '\'04230000-0000-0000-0000-000000000103\''
\set rA      '\'04230000-0000-0000-0000-000000000104\''
\set rB      '\'04230000-0000-0000-0000-000000000105\''
\set locA    '\'04230000-0000-0000-0000-000000000201\''
\set locA2   '\'04230000-0000-0000-0000-000000000202\''
\set locB    '\'04230000-0000-0000-0000-000000000203\''
\set whNew   '\'04230000-0000-0000-0000-0000000000d9\''
\set both    '\'04230000-0000-0000-0000-0000000000a9\''
\set catA    '\'04230000-0000-0000-0000-000000000301\''
\set catB    '\'04230000-0000-0000-0000-000000000302\''
\set locA3   '\'04230000-0000-0000-0000-000000000204\''
\set evA     '\'04230000-0000-0000-0000-000000000401\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,    'i423-own@i423.test',    '{}'::jsonb),
  (:adm,    'i423-adm@i423.test',    '{}'::jsonb),
  (:mgr,    'i423-mgr@i423.test',    '{}'::jsonb),
  (:allwh,  'i423-allwh@i423.test',  '{}'::jsonb),
  (:stf,    'i423-stf@i423.test',    '{}'::jsonb),
  (:vwr,    'i423-vwr@i423.test',    '{}'::jsonb),
  (:two,    'i423-two@i423.test',    '{}'::jsonb),
  (:twoStf, 'i423-twostf@i423.test', '{}'::jsonb),
  (:mgrB,   'i423-mgrb@i423.test',   '{}'::jsonb),
  (:both,   'i423-both@i423.test',   '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:orgA, 'I423 Item Org A', 'i423-item-org-a'),
  (:orgB, 'I423 Item Org B', 'i423-item-org-b');
insert into public.organization_members (organization_id, user_id, role, accepted_at, all_warehouses) values
  (:orgA, :own,    'owner',   now(), false),
  (:orgA, :adm,    'admin',   now(), false),
  (:orgA, :mgr,    'manager', now(), false),
  (:orgA, :allwh,  'staff',   now(), true),
  (:orgA, :stf,    'staff',   now(), false),
  (:orgA, :vwr,    'viewer',  now(), false),
  (:orgA, :two,    'admin',   now(), false),
  (:orgA, :twoStf, 'staff',   now(), false),
  (:orgB, :two,    'staff',   now(), false),
  (:orgB, :twoStf, 'manager', now(), false),
  (:orgB, :mgrB,   'manager', now(), false),
  (:orgA, :both,   'admin',   now(), false),
  (:orgB, :both,   'admin',   now(), false);
insert into public.organization_modules (organization_id, module_id, enabled, tier) values
  (:orgA, 'rentals', true, 'optional'),
  (:orgB, 'rentals', true, 'optional')
  on conflict (organization_id, module_id) do update set enabled = true;
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA,  :orgA, 'I423 Main',   'WH-I423A',  'active'),
  (:whA2, :orgA, 'I423 Second', 'WH-I423A2', 'active'),
  (:whB,  :orgB, 'I423 Other',  'WH-I423B',  'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :stf,    :whA, true),
  (:orgA, :vwr,    :whA, true),
  (:orgA, :twoStf, :whA, true),
  (:orgB, :two,    :whB, true);
insert into public.categories (id, organization_id, name) values
  (:catA, :orgA, 'I423 Furniture'),
  (:catB, :orgB, 'I423 Lighting');
-- Items, by the superuser (the guard holds the API roles only). itX is
-- written past the rules (see the header).
insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, is_rental, status, item_type) values
  (:itA,   :orgA, :whA, 'I423-A',   'Folding table', 0, false, 'active', 'asset'),
  (:itDup, :orgA, :whA, 'I423-DUP', 'Stack chair',   0, false, 'active', 'asset'),
  (:itX,   :orgA, :whB, 'I423-X',   'Floor lamp',    0, false, 'active', 'asset'),
  (:rA,    :orgA, :whA, 'I423-RA',  'Projector A',   5, true,  'active', 'asset'),
  (:rB,    :orgB, :whB, 'I423-RB',  'Projector B',   5, true,  'active', 'asset');

insert into public.locations (id, organization_id, warehouse_id, name, type) values
  (:locA,  :orgA, :whA, 'I423 Aisle 1', 'room'),
  (:locA2, :orgA, :whA, 'I423 Shelf 1', 'shelf'),
  (:locB,  :orgB, :whB, 'I423 Aisle B', 'room');
insert into public.locations (id, organization_id, warehouse_id, name, type, parent_id) values
  (:locA3, :orgA, null, 'I423 Annex', 'room', :locA);
insert into public.schedule_events (id, organization_id, title, starts_at, ends_at, warehouse_id, created_by) values
  (:evA, :orgA, 'I423 Delivery', now() + interval '1 day', now() + interval '1 day 1 hour', :whA, :mgr);

-- ══ Helpers (0387's, as 0419 uses them) ══════════════════════════════════
create function pg_temp.hint(p_hint text) returns text language sql immutable as $$
  select case when p_hint is null or p_hint = ''
                or p_hint like 'Grant the required privileges to the current role with:%'
              then '-' else p_hint end
$$;
-- One statement as p_as with p_sub's claims, then ALWAYS undone. 'ok:<rows>
-- [:<p_check>]' (p_check as the superuser, inside the undone subtransaction),
-- else '<sqlstate>:<hint or ->:<message>'. p_prep runs first, as the
-- superuser, inside the same undone subtransaction (the M-section's cuts).
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
    raise exception using errcode = 'XX423', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XX423' then
    return 'ok:' || v_n::text || coalesce(':' || v_seen, '');
  end if;
  return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
end $$;

create temp table persona (who text primary key, id uuid);
insert into persona (who, id) values
  ('own', :own), ('adm', :adm), ('mgr', :mgr), ('allwh', :allwh), ('stf', :stf), ('vwr', :vwr),
  ('two', :two), ('twoStf', :twoStf), ('mgrB', :mgrB), ('both', :both);

-- The same statement for each named persona, each call undone:
-- 'who=<attempt>, who=<attempt>, ...'. %1$s in p_sql is the persona's name.
create function pg_temp.each(p_who text[], p_sql text, p_check text default null, p_prep text default null)
returns text language plpgsql as $$
declare v text := ''; w text;
begin
  foreach w in array p_who loop
    v := v || case when v = '' then '' else ', ' end || w || '='
           || pg_temp.attempt('authenticated', (select p.id from persona p where p.who = w),
                              format(p_sql, w), p_prep,
                              case when p_check is null then null else format(p_check, w) end);
  end loop;
  return v;
end $$;

-- The rows an item of SKU p_sku has: 'items=<n> levels=<n> moves=<n>', read
-- as the superuser (holdings and movements by item id).
create function pg_temp.rows_of(p_sku text) returns text language sql stable as $$
  select 'items=' || (select count(*) from public.inventory_items where sku = p_sku)::text
      || ' levels=' || (select count(*) from public.item_stock_levels l
                          join public.inventory_items i on i.id = l.item_id where i.sku = p_sku)::text
      || ' moves=' || (select count(*) from public.stock_movements m
                         join public.inventory_items i on i.id = m.item_id where i.sku = p_sku)::text
$$;

-- An item insert of (organization A, p_wh) with five on hand, without
-- RETURNING, as p_who, KEPT when it succeeds (the row then stays for the
-- rest of this transaction): '<outcome> | <rows_of(sku)>', the rows read after
-- the attempt.
create function pg_temp.kept(p_who text, p_wh uuid, p_sku text) returns text language plpgsql as $$
declare v_out text := 'ok'; v_state text; v_msg text; v_hint text;
begin
  begin
    perform set_config('request.jwt.claim.sub', (select p.id::text from persona p where p.who = p_who), true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    perform set_config('role', 'authenticated', true);
    execute format($q$insert into public.inventory_items (organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type)
                      values (%L, %L, %L, 'Banquet table', 5, 'active', 'asset')$q$,
                   '04230000-0000-0000-0000-00000000000a', p_wh, p_sku);
    perform set_config('role', 'none', true);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
    v_out := v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
  end;
  perform set_config('role', 'none', true);
  return v_out || ' | ' || pg_temp.rows_of(p_sku);
end $$;

-- Any statement as p_who (or anon when p_who is null), KEPT when it
-- succeeds: '<outcome> | items=<n>', n the items whose SKU is like p_sku.
create function pg_temp.kept_sql(p_who text, p_sql text, p_sku text) returns text language plpgsql as $$
declare v_out text := 'ok'; v_state text; v_msg text; v_hint text;
begin
  begin
    perform set_config('request.jwt.claim.sub', coalesce((select p.id::text from persona p where p.who = p_who), ''), true);
    perform set_config('request.jwt.claim.role', case when p_who is null then 'anon' else 'authenticated' end, true);
    perform set_config('role', case when p_who is null then 'anon' else 'authenticated' end, true);
    execute p_sql;
    perform set_config('role', 'none', true);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
    v_out := v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
  end;
  perform set_config('role', 'none', true);
  return v_out || ' | items=' || (select count(*) from public.inventory_items where sku like p_sku)::text;
end $$;

-- The M-section's cut: the live definition with p_cut taken out, re-created
-- (always inside an undone attempt). Refuses when the text is not there, so
-- a cut can never pass by cutting nothing.
create function pg_temp.unpatch(p_sig text, p_cut text) returns void language plpgsql as $$
declare v_def text := pg_get_functiondef(to_regprocedure(p_sig));
begin
  if position(p_cut in v_def) = 0 then
    raise exception 'unpatch: the text to cut is not in %', p_sig;
  end if;
  execute replace(v_def, p_cut, '');
end $$;

-- The guard's new insert block, as the migration writes it.
create function pg_temp.guard_block() returns text language sql immutable as $$
  select $b$
    -- An item's warehouse belongs to the item's organization (a NULL
    -- warehouse passes, as before). Asked of a member of that organization
    -- only: anyone else is answered by the INSERT rule.
    if public.is_org_member(new.organization_id)
       and not public.warehouse_in_org(new.warehouse_id, new.organization_id) then
      raise exception 'That warehouse is not part of this organization.'
        using errcode = '42501';
    end if;$b$
$$;

-- The table's INSERT, UPDATE and ALL rules, deparsed with search_path
-- pinned (the migrations' form): one line per rule,
-- name|cmd|permissive|roles|USING|WITH CHECK.
create function pg_temp.rules() returns text language sql stable set search_path = public, extensions as $$
  select string_agg(pol.polname || '|' || pol.polcmd::text || '|' || pol.polpermissive::text || '|'
                    || (select string_agg(case x when 0 then 'public' else x::regrole::text end, ',' order by 1)
                          from unnest(pol.polroles) x)
                    || '|' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '-')
                    || '|' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '-'), E'\n' order by pol.polname)
    from pg_policy pol
   where pol.polrelid = 'public.inventory_items'::regclass and pol.polcmd in ('a', 'w', '*')
$$;

-- The UPDATE rule's USING, deparsed the same way.
create function pg_temp.update_using() returns text language sql stable set search_path = public, extensions as $$
  select pg_get_expr(pol.polqual, pol.polrelid) from pg_policy pol
   where pol.polrelid = 'public.inventory_items'::regclass and pol.polname = 'inventory_items_update'
$$;

-- What the Z line compares: organization A's items (id, warehouse, on hand),
-- every holding of organization A's items, every location of organization B,
-- and every movement of the two organizations' items.
create function pg_temp.state() returns text language sql stable as $$
  select coalesce((select string_agg(i.sku || '/' || coalesce(i.warehouse_id::text, '-') || '/' || i.quantity_on_hand::text, ',' order by i.sku collate "C")
                     from public.inventory_items i where i.organization_id = '04230000-0000-0000-0000-00000000000a'), '-')
      || ' # ' || (select count(*) from public.item_stock_levels l
                    join public.inventory_items i on i.id = l.item_id
                   where i.organization_id = '04230000-0000-0000-0000-00000000000a')::text
      || ' # ' || (select count(*) from public.locations where organization_id = '04230000-0000-0000-0000-00000000000b')::text
      || ' # ' || (select count(*) from public.stock_movements
                   where organization_id in ('04230000-0000-0000-0000-00000000000a', '04230000-0000-0000-0000-00000000000b'))::text
      || ' # ' || (select count(*) from public.rentals
                   where organization_id in ('04230000-0000-0000-0000-00000000000a', '04230000-0000-0000-0000-00000000000b'))::text
      || ' # ' || (select string_agg(l.name || '/' || coalesce(l.parent_id::text, '-'), ',' order by l.name collate "C")
                     from public.locations l where l.organization_id = '04230000-0000-0000-0000-00000000000a')
      || ' # ' || (select string_agg(i.sku || '/' || coalesce(i.category_id::text, '-'), ',' order by i.sku collate "C")
                     from public.inventory_items i where i.organization_id = '04230000-0000-0000-0000-00000000000a')
      || ' # ' || (select string_agg(e.title || '/' || coalesce(e.warehouse_id::text, '-'), ',' order by e.title collate "C")
                     from public.schedule_events e where e.organization_id in ('04230000-0000-0000-0000-00000000000a', '04230000-0000-0000-0000-00000000000b'))
$$;
-- The schedule_events rules, deparsed the same way.
create function pg_temp.event_rules() returns text language sql stable set search_path = public, extensions as $$
  select string_agg(pol.polname || '|' || pol.polcmd::text || '|' || pol.polpermissive::text || '|'
                    || (select string_agg(case x when 0 then 'public' else x::regrole::text end, ',' order by 1)
                          from unnest(pol.polroles) x)
                    || '|' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '-')
                    || '|' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '-'), E'\n' order by pol.polname)
    from pg_policy pol
   where pol.polrelid = 'public.schedule_events'::regclass and pol.polcmd in ('a', 'w', '*')
$$;
-- The locations rules, deparsed as pg_temp.rules() deparses the item rules.
create function pg_temp.loc_rules() returns text language sql stable set search_path = public, extensions as $$
  select string_agg(pol.polname || '|' || pol.polcmd::text || '|' || pol.polpermissive::text || '|'
                    || (select string_agg(case x when 0 then 'public' else x::regrole::text end, ',' order by 1)
                          from unnest(pol.polroles) x)
                    || '|' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '-')
                    || '|' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '-'), E'\n' order by pol.polname)
    from pg_policy pol
   where pol.polrelid = 'public.locations'::regclass and pol.polcmd in ('a', 'w', '*')
$$;
create temp table snap as select pg_temp.state() as v;

-- ══ F. The fixture ════════════════════════════════════════════════════════
select is(
  (select string_agg(p.who || ':' || coalesce(ma.role, '-') || '/' || coalesce(mb.role, '-'), ' ' order by p.who collate "C")
     from persona p
     left join public.organization_members ma on ma.user_id = p.id and ma.organization_id = :orgA
     left join public.organization_members mb on mb.user_id = p.id and mb.organization_id = :orgB),
  'adm:admin/- allwh:staff/- both:admin/admin mgr:manager/- mgrB:-/manager own:owner/- stf:staff/- two:admin/staff twoStf:staff/manager vwr:viewer/-',
  'F1: each persona''s rank in organization A and in organization B');
select is(
  (select string_agg(p.who || ':' || (select string_agg(w.code, '+' order by w.code collate "C")
                                        from public.user_warehouse_assignments u join public.warehouses w on w.id = u.warehouse_id
                                       where u.user_id = p.id), ' ' order by p.who collate "C")
     from persona p where p.who in ('allwh', 'stf', 'vwr', 'two', 'twoStf')),
  'allwh:WH-I423A+WH-I423A2 stf:WH-I423A two:WH-I423B twoStf:WH-I423A vwr:WH-I423A',
  'F2: the warehouse assignments (allwh holds both of A''s through the all-warehouses trigger)');
select is(
  (select count(*)::int from public.locations l where l.warehouse_id = :whB and l.kind = 'unplaced' and l.organization_id = :orgB),
  1,
  'F3: B''s warehouse has its Unplaced location, in organization B');

-- ══ I. Another organization's warehouse on insert ═════════════════════════
select is(
  'mgr=' || pg_temp.kept('mgr', :whB, 'I423-I-MGR') || '; adm=' || pg_temp.kept('adm', :whB, 'I423-I-ADM')
  || '; own=' || pg_temp.kept('own', :whB, 'I423-I-OWN') || '; allwh=' || pg_temp.kept('allwh', :whB, 'I423-I-ALL')
  || '; stf=' || pg_temp.kept('stf', :whB, 'I423-I-STF') || '; vwr=' || pg_temp.kept('vwr', :whB, 'I423-I-VWR'),
  'mgr=42501:-:That warehouse is not part of this organization. | items=0 levels=0 moves=0; '
  || 'adm=42501:-:That warehouse is not part of this organization. | items=0 levels=0 moves=0; '
  || 'own=42501:-:That warehouse is not part of this organization. | items=0 levels=0 moves=0; '
  || 'allwh=42501:-:That warehouse is not part of this organization. | items=0 levels=0 moves=0; '
  || 'stf=42501:-:That warehouse is not part of this organization. | items=0 levels=0 moves=0; '
  || 'vwr=42501:-:That warehouse is not part of this organization. | items=0 levels=0 moves=0',
  'I1: an owner, admin, manager, all-warehouses member, scoped staff member and viewer of A inserting an item of A in B''s warehouse: refused 42501, and no item, holding or movement row is written');
select is(
  'two=' || pg_temp.kept('two', :whB, 'I423-I-TWO') || '; twoStf=' || pg_temp.kept('twoStf', :whB, 'I423-I-TWOSTF'),
  'two=42501:-:That warehouse is not part of this organization. | items=0 levels=0 moves=0; '
  || 'twoStf=42501:-:That warehouse is not part of this organization. | items=0 levels=0 moves=0',
  'I2: a member of both organizations acting in A (an admin of A who is staff of B, a staff member of A who is a manager of B): refused 42501, nothing written');

select is(
  'own=' || pg_temp.kept_sql('mgrB', $q$insert into public.inventory_items (organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type)
       values ('04230000-0000-0000-0000-00000000000a', '04230000-0000-0000-0000-0000000000d1', 'I423-I3-A', 'Banquet table', 5, 'active', 'asset')$q$, 'I423-I3-%')
  || '; other=' || pg_temp.kept_sql('mgrB', $q$insert into public.inventory_items (organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type)
       values ('04230000-0000-0000-0000-00000000000a', '04230000-0000-0000-0000-0000000000d3', 'I423-I3-B', 'Banquet table', 5, 'active', 'asset')$q$, 'I423-I3-%')
  || '; anon=' || pg_temp.kept_sql(null, $q$insert into public.inventory_items (organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type)
       values ('04230000-0000-0000-0000-00000000000a', '04230000-0000-0000-0000-0000000000d1', 'I423-I3-N', 'Banquet table', 5, 'active', 'asset')$q$, 'I423-I3-%'),
  'own=42501:-:new row violates row-level security policy for table "inventory_items" | items=0; '
  || 'other=42501:-:new row violates row-level security policy for table "inventory_items" | items=0; '
  || 'anon=42501:-:permission denied for table inventory_items | items=0',
  'I3: a manager of B alone gets the same row level security answer for an item of A in A''s warehouse and in B''s; anon holds no INSERT');
select is(
  pg_temp.kept_sql('mgr',
    $q$insert into public.inventory_items (organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type) values
       ('04230000-0000-0000-0000-00000000000a', '04230000-0000-0000-0000-0000000000d1', 'I423-I4-1', 'Banquet table', 5, 'active', 'asset'),
       ('04230000-0000-0000-0000-00000000000a', '04230000-0000-0000-0000-0000000000d3', 'I423-I4-2', 'Banquet table', 5, 'active', 'asset')$q$,
    'I423-I4-%'),
  '42501:-:That warehouse is not part of this organization. | items=0',
  'I4: a two-row insert by a manager, one row in A''s warehouse and one in B''s: refused, neither row written');
select is(
  pg_temp.attempt('authenticated', :mgr,
    format($q$insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, status, item_type)
              values (%L, %L, %L, 'I423-A', 'Folding table', 'active', 'asset')
              on conflict (id) do update set warehouse_id = excluded.warehouse_id$q$, :itA, :orgA, :whB)),
  '42501:-:That warehouse is not part of this organization.',
  'I5: an upsert onto an item of A that proposes B''s warehouse is refused');

-- ══ S. Own warehouses and no warehouse, as before ═════════════════════════
select is(
  pg_temp.each(array['own', 'adm', 'mgr', 'allwh', 'stf', 'vwr', 'two', 'twoStf'],
    $q$insert into public.inventory_items (organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type)
       values ('04230000-0000-0000-0000-00000000000a', '04230000-0000-0000-0000-0000000000d1', 'I423-S-%1$s', 'Banquet table', 5, 'active', 'asset')$q$,
    $q$select pg_temp.rows_of('I423-S-%1$s')$q$),
  'own=ok:1:items=1 levels=1 moves=0, adm=ok:1:items=1 levels=1 moves=0, mgr=ok:1:items=1 levels=1 moves=0, '
  || 'allwh=ok:1:items=1 levels=1 moves=0, stf=ok:1:items=1 levels=1 moves=0, '
  || 'vwr=42501:-:new row violates row-level security policy for table "inventory_items", '
  || 'two=ok:1:items=1 levels=1 moves=0, twoStf=ok:1:items=1 levels=1 moves=0',
  'S1: an insert in A''s warehouse whA, for every persona: as before');
select is(
  pg_temp.each(array['own', 'adm', 'mgr', 'allwh', 'stf', 'vwr', 'two', 'twoStf'],
    $q$insert into public.inventory_items (organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type)
       values ('04230000-0000-0000-0000-00000000000a', '04230000-0000-0000-0000-0000000000d2', 'I423-S2-%1$s', 'Banquet table', 5, 'active', 'asset')$q$),
  'own=ok:1, adm=ok:1, mgr=ok:1, allwh=ok:1, '
  || 'stf=42501:-:new row violates row-level security policy for table "inventory_items", '
  || 'vwr=42501:-:new row violates row-level security policy for table "inventory_items", two=ok:1, '
  || 'twoStf=42501:-:new row violates row-level security policy for table "inventory_items"',
  'S2: an insert in A''s warehouse whA2 (stf, vwr and twoStf are not assigned to it), for every persona: as before');
select is(
  pg_temp.each(array['own', 'adm', 'mgr', 'allwh', 'stf', 'vwr', 'two', 'twoStf'],
    $q$insert into public.inventory_items (organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type)
       values ('04230000-0000-0000-0000-00000000000a', null, 'I423-S3-%1$s', 'Banquet table', 0, 'active', 'asset')$q$),
  'own=ok:1, adm=ok:1, mgr=ok:1, allwh=ok:1, stf=ok:1, '
  || 'vwr=42501:-:new row violates row-level security policy for table "inventory_items", two=ok:1, twoStf=ok:1',
  'S3: an insert with no warehouse, for every persona: as before');
select is(
  pg_temp.attempt('authenticated', :mgr,
    $q$insert into public.inventory_items (organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type)
       values ('04230000-0000-0000-0000-00000000000a', '04230000-0000-0000-0000-0000000000d1', 'I423-S4', 'Banquet table', 5, 'active', 'asset')$q$,
    null,
    $q$select pg_temp.rows_of('I423-S4') || ' at ' || (select l.kind || '/' || (l.warehouse_id = '04230000-0000-0000-0000-0000000000d1')::text
                                                         from public.item_stock_levels s join public.locations l on l.id = s.location_id
                                                         join public.inventory_items i on i.id = s.item_id where i.sku = 'I423-S4')$q$),
  'ok:1:items=1 levels=1 moves=0 at unplaced/true',
  'S4: a manager''s insert in A''s own warehouse still seeds its five at that warehouse''s Unplaced location');

-- ══ U. Updates ════════════════════════════════════════════════════════════
select is(
  pg_temp.each(array['own', 'adm', 'mgr', 'two'],
    format('update public.inventory_items set warehouse_id = %L where id = %L', :whB, :itA)),
  'own=42501:-:That warehouse is not part of this organization., adm=42501:-:That warehouse is not part of this organization., '
  || 'mgr=42501:-:That warehouse is not part of this organization., two=42501:-:That warehouse is not part of this organization.',
  'U1: moving an item of A to B''s warehouse is refused by the guard, as before');
select is(
  pg_temp.attempt('authenticated', :two,
    format('update public.inventory_items set warehouse_id = %L where id = %L', :whB, :itA),
    $p$select pg_temp.unpatch('public.tg_inventory_items_guard()',
         E'    if not public.warehouse_in_org(new.warehouse_id, new.organization_id) then\n'
         || E'      raise exception ''That warehouse is not part of this organization.''\n'
         || E'        using errcode = ''42501'';\n'
         || E'    end if;\n')$p$),
  '42501:-:new row violates row-level security policy for table "inventory_items"',
  'U2: with the guard''s update check cut, the UPDATE rule itself refuses B''s warehouse to a member of both organizations (who may see the row there)');
select is(
  pg_temp.attempt('authenticated', :mgr, format($q$update public.inventory_items set name = 'Floor lamp, tall' where id = %L$q$, :itX))
  || ' / ' || pg_temp.attempt('authenticated', :two, format($q$update public.inventory_items set name = 'Floor lamp, tall' where id = %L$q$, :itX))
  || ' / ' || pg_temp.attempt('authenticated', :two, format('update public.inventory_items set warehouse_id = %L where id = %L', :whA, :itX),
                              null, format('select warehouse_id::text from public.inventory_items where id = %L', :itX)),
  'ok:0 / 42501:-:new row violates row-level security policy for table "inventory_items" / ok:1:' || :whA,
  'U3: a stored item of A whose warehouse is B''s: a manager of A alone does not see it (0 rows, as before); a member of both may change nothing else on it, and may move it to A''s warehouse');
select is(
  pg_temp.each(array['own', 'adm', 'mgr', 'allwh', 'stf', 'vwr', 'two', 'twoStf'],
    format($q$update public.inventory_items set name = 'Folding table, %%1$s' where id = %L$q$, :itA)),
  'own=ok:1, adm=ok:1, mgr=ok:1, allwh=ok:1, stf=ok:1, vwr=ok:0, two=ok:1, twoStf=ok:1',
  'U4: a plain rename of a healthy item of A, for every persona: as before');

-- ══ C. An item's category ═════════════════════════════════════════════════
select is(
  pg_temp.each(array['own', 'adm', 'mgr', 'stf', 'two', 'both'],
    $q$insert into public.inventory_items (organization_id, warehouse_id, category_id, sku, name, status, item_type)
       values ('04230000-0000-0000-0000-00000000000a', '04230000-0000-0000-0000-0000000000d1', '04230000-0000-0000-0000-000000000302', 'I423-C1-%1$s', 'Desk lamp', 'active', 'asset')$q$),
  'own=42501:-:new row violates row-level security policy for table "inventory_items", adm=42501:-:new row violates row-level security policy for table "inventory_items", mgr=42501:-:new row violates row-level security policy for table "inventory_items", '
  || 'stf=42501:-:new row violates row-level security policy for table "inventory_items", two=42501:-:new row violates row-level security policy for table "inventory_items", both=42501:-:new row violates row-level security policy for table "inventory_items"',
  'C1: an item of A with B''s category, inserted by each rank and by members of both: refused 42501');
select is(
  pg_temp.each(array['own', 'adm', 'mgr', 'stf', 'vwr', 'two'],
    $q$insert into public.inventory_items (organization_id, warehouse_id, category_id, sku, name, status, item_type)
       values ('04230000-0000-0000-0000-00000000000a', '04230000-0000-0000-0000-0000000000d1', '04230000-0000-0000-0000-000000000301', 'I423-C2-%1$s', 'Desk lamp', 'active', 'asset')$q$)
  || ' / ' || pg_temp.each(array['own', 'adm', 'mgr', 'stf', 'vwr', 'two'],
    $q$insert into public.inventory_items (organization_id, warehouse_id, category_id, sku, name, status, item_type)
       values ('04230000-0000-0000-0000-00000000000a', '04230000-0000-0000-0000-0000000000d1', null, 'I423-C2n-%1$s', 'Desk lamp', 'active', 'asset')$q$),
  'own=ok:1, adm=ok:1, mgr=ok:1, stf=ok:1, vwr=42501:-:new row violates row-level security policy for table "inventory_items", two=ok:1'
  || ' / own=ok:1, adm=ok:1, mgr=ok:1, stf=ok:1, vwr=42501:-:new row violates row-level security policy for table "inventory_items", two=ok:1',
  'C2: A''s own category and no category, for each rank: as before');
select is(
  pg_temp.attempt('authenticated', :mgr, format('update public.inventory_items set category_id = %L where id in (%L, %L)', :catB, :itA, :itDup))
  || ' / ' || pg_temp.attempt('authenticated', :mgr, format('update public.inventory_items set category_id = %L where id in (%L, %L)', :catA, :itA, :itDup))
  || ' / ' || pg_temp.attempt('authenticated', :mgr, format('update public.inventory_items set category_id = null where id in (%L, %L)', :itA, :itDup)),
  '42501:-:new row violates row-level security policy for table "inventory_items" / ok:2 / ok:2',
  'C3: setting a category on two items at once (the bulk Set category): B''s refused, A''s own and none as before');
select is(
  pg_temp.each(array['stf', 'two', 'both'], format('update public.inventory_items set category_id = %L where id = %L', :catB, :itA)),
  'stf=42501:-:new row violates row-level security policy for table "inventory_items", two=42501:-:new row violates row-level security policy for table "inventory_items", both=42501:-:new row violates row-level security policy for table "inventory_items"',
  'C4: B''s category set on one item of A by scoped staff and by members of both: refused 42501');

-- ══ D. duplicate_inventory_item ═══════════════════════════════════════════
select is(
  pg_temp.attempt('authenticated', :mgr,
    format($q$select public.duplicate_inventory_item(%L, '{"sku": "I423-DUP-2", "quantity": 2}'::jsonb)$q$, :itDup), null,
    $q$select pg_temp.rows_of('I423-DUP-2') || ' ' || (select (warehouse_id = '04230000-0000-0000-0000-0000000000d1')::text from public.inventory_items where sku = 'I423-DUP-2')$q$),
  'ok:1:items=1 levels=1 moves=1 true',
  'D1: a manager copies an item of A in whA, as before (the copy is in whA, with its two on hand and their movement)');
select is(
  pg_temp.attempt('authenticated', :mgr,
    format($q$select public.duplicate_inventory_item(%L, '{"sku": "I423-X-2"}'::jsonb)$q$, :itX))
  || ' / ' || pg_temp.attempt('authenticated', :two,
    format($q$select public.duplicate_inventory_item(%L, '{"sku": "I423-X-2"}'::jsonb)$q$, :itX)),
  'P0002:-:original_not_found / 42501:-:That warehouse is not part of this organization.',
  'D2: a copy of the stored item whose warehouse is B''s: not found for a manager of A alone (as before), refused for a member of both who sees it');

-- ══ R. create_rental ══════════════════════════════════════════════════════
select is(
  pg_temp.attempt('authenticated', :mgr,
    format($q$select public.create_rental(%L, null, 'Borrower One', null, now() + interval '3 days', null,
                jsonb_build_array(jsonb_build_object('item_id', %L, 'quantity', 1)))$q$, :whB, :rB), null,
    $q$select (select count(*) from public.rentals where organization_id in ('04230000-0000-0000-0000-00000000000a', '04230000-0000-0000-0000-00000000000b'))::text$q$),
  'P0002:-:warehouse_not_found',
  'R1: a manager of A alone names B''s warehouse: refused, nothing written');
select is(
  pg_temp.attempt('authenticated', :two,
    format($q$select public.create_rental(%L, null, 'Borrower One', null, now() + interval '3 days', null,
                jsonb_build_array(jsonb_build_object('item_id', %L, 'quantity', 1)))$q$, :whB, :rB), null,
    $q$select string_agg(r.organization_id::text || '/' || r.warehouse_id::text, ',') from public.rentals r
        where r.organization_id in ('04230000-0000-0000-0000-00000000000a', '04230000-0000-0000-0000-00000000000b')$q$),
  'ok:1:' || :orgB || '/' || :whB,
  'R2: a member of both rents B''s item from B''s warehouse: the rental is B''s, the warehouse''s own organization');
select is(
  pg_temp.attempt('authenticated', :two,
    format($q$select public.create_rental(%L, null, 'Borrower One', null, now() + interval '3 days', null,
                jsonb_build_array(jsonb_build_object('item_id', %L, 'quantity', 1)))$q$, :whB, :rA)),
  'P0002:rental_invalid:One or more items were not found.',
  'R3: the same member cannot rent A''s item from B''s warehouse');
select is(
  pg_temp.attempt('authenticated', :mgr,
    format($q$select public.create_rental(%L, null, 'Borrower One', null, now() + interval '3 days', null,
                jsonb_build_array(jsonb_build_object('item_id', %L, 'quantity', 1)))$q$, :whA, :rA), null,
    $q$select string_agg(r.organization_id::text || '/' || r.warehouse_id::text, ',') from public.rentals r
        where r.organization_id in ('04230000-0000-0000-0000-00000000000a', '04230000-0000-0000-0000-00000000000b')$q$),
  'ok:1:' || :orgA || '/' || :whA,
  'R4: a manager of A rents A''s item from A''s warehouse, as before');

-- ══ M. Each layer alone ═══════════════════════════════════════════════════
select is(
  pg_temp.attempt('authenticated', :mgr,
    $q$insert into public.inventory_items (organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type)
       values ('04230000-0000-0000-0000-00000000000a', '04230000-0000-0000-0000-0000000000d3', 'I423-M1', 'Banquet table', 5, 'active', 'asset')$q$,
    format('select pg_temp.unpatch(%L, %L)', 'public.tg_inventory_items_guard()', pg_temp.guard_block())),
  '42501:-:new row violates row-level security policy for table "inventory_items"',
  'M1: with the guard''s new block cut, the INSERT rule alone refuses B''s warehouse');
select is(
  pg_temp.attempt('authenticated', :mgr,
    $q$insert into public.inventory_items (organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type)
       values ('04230000-0000-0000-0000-00000000000a', '04230000-0000-0000-0000-0000000000d3', 'I423-M2', 'Banquet table', 5, 'active', 'asset')$q$,
    $p$
      drop policy inventory_items_insert on public.inventory_items;
      create policy inventory_items_insert on public.inventory_items for insert to authenticated
        with check (
          (( SELECT has_org_role(inventory_items.organization_id, 'staff'::text) AS has_org_role) OR ( SELECT has_permission(inventory_items.organization_id, 'items:create'::text) AS has_permission))
          AND (( SELECT has_org_role(inventory_items.organization_id, 'manager'::text) AS has_org_role) OR (warehouse_id IS NULL) OR user_can_access_warehouse(auth.uid(), warehouse_id, 'write'::text))
          AND ( SELECT location_in_org(inventory_items.primary_location_id, inventory_items.organization_id) AS location_in_org)
          AND ( SELECT charter_in_org(inventory_items.charter_id, inventory_items.organization_id) AS charter_in_org)
          AND ( SELECT supplier_in_org(inventory_items.supplier_id, inventory_items.organization_id) AS supplier_in_org)
          AND ( SELECT product_group_in_org(inventory_items.group_id, inventory_items.organization_id) AS product_group_in_org));
    $p$),
  '42501:-:That warehouse is not part of this organization.',
  'M2: with the INSERT rule put back without its warehouse term, the guard alone refuses B''s warehouse');

-- ══ P. Posture ════════════════════════════════════════════════════════════
select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, pg_temp.guard_block(), ''))
     from pg_proc p where p.oid = to_regprocedure('public.tg_inventory_items_guard()')),
  '4737d3598864d9a7' || 'aad542ad19a9632e' || '|' || '0b41f8f3e41197d7' || '9b0af640e4dacf04',
  'P1: the guard''s body is the new one, and without its new block it is the previous body exactly');
select is(
  (select p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ','), '-') || '|' || pg_get_userbyid(p.proowner)
          || '|' || has_function_privilege('authenticated', p.oid, 'execute')::text
          || '|' || has_function_privilege('anon', p.oid, 'execute')::text
     from pg_proc p where p.oid = to_regprocedure('public.tg_inventory_items_guard()')),
  'false|search_path=public|postgres|false|false',
  'P2: the guard stays SECURITY INVOKER with search_path public, owned by postgres, not executable by the API roles');
select is(
  md5(pg_temp.rules()),
  '860b53b2fc60ced5' || '04eb35dc86e70152',
  'P3: the item table''s INSERT, UPDATE and ALL rules are exactly the two new ones (warehouse and category terms)');
select is(
  pg_temp.update_using(),
  '((( SELECT has_org_role(inventory_items.organization_id, ''staff''::text) AS has_org_role)'
  || ' OR ( SELECT has_permission(inventory_items.organization_id, ''items:update''::text) AS has_permission))'
  || ' AND (( SELECT has_org_role(inventory_items.organization_id, ''manager''::text) AS has_org_role)'
  || ' OR (warehouse_id IS NULL) OR user_can_access_warehouse(auth.uid(), warehouse_id, ''write''::text)))',
  'P4: the UPDATE rule''s USING (which rows a member may change) is unchanged');
select is(
  (select string_agg(t.tgname || ':' || t.tgenabled::text, ',' order by t.tgname)
     from pg_trigger t where t.tgrelid = 'public.inventory_items'::regclass and t.tgfoid = to_regprocedure('public.tg_inventory_items_guard()')),
  'trg_zz_inventory_items_guard:O',
  'P5: the guard is still bound once, enabled');

-- ══ L. A location's parent ═══════════════════════════════════════════════
select is(
  pg_temp.each(array['own', 'adm', 'mgr', 'two'],
    $q$insert into public.locations (organization_id, warehouse_id, name, type, parent_id)
       values ('04230000-0000-0000-0000-00000000000a', '04230000-0000-0000-0000-0000000000d1', 'I423 L1 %1$s', 'shelf',
               '04230000-0000-0000-0000-000000000203')$q$),
  'own=42501:-:new row violates row-level security policy for table "locations", '
  || 'adm=42501:-:new row violates row-level security policy for table "locations", '
  || 'mgr=42501:-:new row violates row-level security policy for table "locations", '
  || 'two=42501:-:new row violates row-level security policy for table "locations"',
  'L1: an owner, an admin, a manager of A and a member of both adding a location of A whose parent is B''s location: refused 42501');
select is(
  pg_temp.each(array['own', 'adm', 'mgr', 'two'],
    format('update public.locations set parent_id = %L where id = %L', :locB, :locA2)),
  'own=42501:-:new row violates row-level security policy for table "locations", '
  || 'adm=42501:-:new row violates row-level security policy for table "locations", '
  || 'mgr=42501:-:new row violates row-level security policy for table "locations", '
  || 'two=42501:-:new row violates row-level security policy for table "locations"',
  'L2: the same four setting B''s location as the parent of a location of A: refused 42501');
select is(
  pg_temp.each(array['own', 'adm', 'mgr', 'stf', 'two'],
    $q$insert into public.locations (organization_id, warehouse_id, name, type, parent_id)
       values ('04230000-0000-0000-0000-00000000000a', '04230000-0000-0000-0000-0000000000d1', 'I423 L3 %1$s', 'shelf',
               '04230000-0000-0000-0000-000000000201')$q$)
  || ' / ' || pg_temp.each(array['own', 'adm', 'mgr', 'stf', 'two'],
    $q$insert into public.locations (organization_id, warehouse_id, name, type, parent_id)
       values ('04230000-0000-0000-0000-00000000000a', '04230000-0000-0000-0000-0000000000d1', 'I423 L3n %1$s', 'shelf', null)$q$),
  'own=ok:1, adm=ok:1, mgr=ok:1, stf=42501:-:new row violates row-level security policy for table "locations", two=ok:1'
  || ' / own=ok:1, adm=ok:1, mgr=ok:1, stf=42501:-:new row violates row-level security policy for table "locations", two=ok:1',
  'L3: adding a location of A with A''s own location as its parent, and with no parent, for each rank: as before');
select is(
  pg_temp.each(array['mgr', 'stf'], format('update public.locations set parent_id = %L where id = %L', :locA, :locA2))
  || ' / ' || pg_temp.each(array['mgr', 'stf'], format('update public.locations set parent_id = null where id = %L', :locA2)),
  'mgr=ok:1, stf=ok:0 / mgr=ok:1, stf=ok:0',
  'L4: setting A''s own location as the parent, and clearing the parent: as before');
select is(
  pg_temp.attempt('authenticated', :mgr,
    format($q$select * from public.mint_placement_location(%L, %L, 'rack', 'I423 Rack 9', 'shelf', %L, null, '9', null, null, null)$q$,
           :orgA, :whA, :locA), null,
    $q$select (select parent_id::text from public.locations where name = 'I423 Rack 9')$q$)
  || ' / ' || pg_temp.attempt('authenticated', :mgr,
    format($q$select * from public.mint_placement_location(%L, %L, 'rack', 'I423 Rack 8', 'shelf', %L, null, '8', null, null, null)$q$,
           :orgA, :whA, :locB)),
  'ok:1:' || :locA || ' / 42501:The parent location does not belong to this organization.:insufficient_privilege',
  'L5: mint_placement_location makes a rack under A''s own location, and refuses B''s location as the parent (its own check), as before');
select is(
  pg_temp.attempt('authenticated', :adm,
    format($q$insert into public.warehouses (id, organization_id, name, code, status) values (%L, %L, 'I423 New', 'WH-I423N', 'active')$q$, :whNew, :orgA),
    null,
    format($q$select string_agg(coalesce(kind, '-'), ',' order by kind collate "C") from public.locations where warehouse_id = %L$q$, :whNew))
  || ' / ' || pg_temp.attempt('authenticated', :mgr,
    $q$insert into public.inventory_items (organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type)
       values ('04230000-0000-0000-0000-00000000000a', null, 'I423-L6', 'Banquet table', 5, 'active', 'asset')$q$,
    null,
    $q$select count(*)::text from public.locations where organization_id = '04230000-0000-0000-0000-00000000000a'
                                                    and warehouse_id is null and kind = 'unplaced' and parent_id is null$q$)
  || ' / ' || pg_temp.attempt('service_role', null,
    $q$insert into public.locations (organization_id, name, type) values ('04230000-0000-0000-0000-00000000000a', 'I423 Main Warehouse', 'warehouse')$q$),
  'ok:1:staging,unplaced / ok:1:1 / ok:1',
  'L6: the writers past the rules: a new warehouse''s default locations, the organization''s Unplaced bucket for an item with no warehouse, and a service-role location with no parent');
select is(
  md5(pg_temp.loc_rules()),
  'df4952ad189fda0e' || 'defaec0f4d25c67c',
  'L7: the locations INSERT, UPDATE and ALL rules are exactly the two new ones');

select is(
  pg_temp.attempt('authenticated', :mgr,
    format($q$insert into public.locations (id, organization_id, warehouse_id, name, type, parent_id)
              values (%L, %L, %L, 'I423 Shelf 1', 'shelf', %L)
              on conflict (id) do update set parent_id = excluded.parent_id$q$, :locA2, :orgA, :whA, :locB)),
  '42501:-:new row violates row-level security policy for table "locations"',
  'L8: an upsert onto a location of A that proposes B''s location as its parent is refused');
select is(
  pg_temp.attempt('authenticated', :both, format('update public.locations set organization_id = %L where id = %L', :orgB, :locA3)),
  '42501:-:new row violates row-level security policy for table "locations"',
  'L9: an admin of both moving a location of A (no warehouse) to B while it keeps its parent of A: refused');

-- ══ E. An event's warehouse ═══════════════════════════════════════════════
select is(
  pg_temp.each(array['two', 'both'],
    $q$insert into public.schedule_events (organization_id, title, starts_at, ends_at, warehouse_id, created_by)
       values ('04230000-0000-0000-0000-00000000000a', 'I423 E1 %1$s', now() + interval '2 days', now() + interval '2 days 1 hour',
               '04230000-0000-0000-0000-0000000000d3', auth.uid())$q$),
  'two=42501:-:new row violates row-level security policy for table "schedule_events", both=42501:-:new row violates row-level security policy for table "schedule_events"',
  'E1: an event of A naming B''s warehouse, filed by members of both organizations (who may write that warehouse in B): refused 42501');
select is(
  pg_temp.each(array['own', 'adm', 'mgr', 'stf', 'vwr', 'two'],
    $q$insert into public.schedule_events (organization_id, title, starts_at, ends_at, warehouse_id, created_by)
       values ('04230000-0000-0000-0000-00000000000a', 'I423 E2 %1$s', now() + interval '2 days', now() + interval '2 days 1 hour',
               '04230000-0000-0000-0000-0000000000d1', auth.uid())$q$)
  || ' / ' || pg_temp.each(array['own', 'adm', 'mgr', 'stf', 'vwr', 'two'],
    $q$insert into public.schedule_events (organization_id, title, starts_at, ends_at, warehouse_id, created_by)
       values ('04230000-0000-0000-0000-00000000000a', 'I423 E2n %1$s', now() + interval '2 days', now() + interval '2 days 1 hour',
               null, auth.uid())$q$),
  'own=ok:1, adm=ok:1, mgr=ok:1, stf=ok:1, vwr=42501:-:new row violates row-level security policy for table "schedule_events", two=ok:1'
  || ' / own=ok:1, adm=ok:1, mgr=ok:1, stf=ok:1, vwr=ok:1, two=ok:1',
  'E2: an event in A''s own warehouse and one with no warehouse, for each rank: as before');
select is(
  pg_temp.each(array['mgr', 'both'], format('update public.schedule_events set warehouse_id = %L where id = %L', :whB, :evA)),
  'mgr=42501:-:new row violates row-level security policy for table "schedule_events", both=42501:-:new row violates row-level security policy for table "schedule_events"',
  'E3: moving an event of A to B''s warehouse is refused by its UPDATE rule, as before');
select is(
  pg_temp.attempt('service_role', null,
    format($q$insert into public.schedule_events (organization_id, title, starts_at, ends_at, warehouse_id, created_by)
              values (%L, 'I423 Order pickup', now() + interval '3 days', now() + interval '3 days 1 hour', %L, %L)$q$, :orgA, :whA, :mgr))
  || ' / ' || pg_temp.attempt('service_role', null,
    format('update public.schedule_events set reminded_24h_at = now() where id = %L', :evA)),
  'ok:1 / ok:1',
  'E4: the server''s writers (an order''s event, a reminder stamp, service role) still write');
select is(
  md5(pg_temp.event_rules()),
  'f534d605adee75dd' || '47f6bb3ceb779ca3',
  'E5: the schedule_events INSERT, UPDATE and ALL rules are exactly the new INSERT rule and the unchanged UPDATE rule');

-- ══ Z. Nothing left changed ═══════════════════════════════════════════════
select is(pg_temp.state(), (select v from snap),
  'Z1: the refused inserts and the undone attempts left organization A''s items, their holdings and categories, organization B''s locations, both organizations'' movements, rentals and events, and organization A''s locations and their parents as they were');
select is(
  (select count(*)::int from public.inventory_items where sku like 'I423-I%'),
  0,
  'Z2: no item of the I section exists');

select * from finish();
rollback;
