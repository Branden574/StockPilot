-- supabase/tests/NNNN_item_warehouse_and_location_parent_in_own_organization.test.sql (NNNN =
-- the migration's number, given in ship order; nothing in this file reads it)
-- pgTAP proof for the migration that holds an item's warehouse to the item's
-- organization: inventory_items_insert and inventory_items_update ask
-- warehouse_in_org(warehouse_id, organization_id) of the new row for every
-- rank, and tg_inventory_items_guard refuses an insert whose warehouse is not
-- the item's organization's, in the words its update branch uses. A NULL
-- warehouse passes as before. And locations_insert and locations_update ask
-- location_in_org(parent_id, organization_id) of the new row for every rank;
-- a NULL parent passes as before. No stored row changes. Written to fail
-- against the head before it in I1, I2, U2, U3, D2, M1, M2, P1, P3, L1, L2,
-- L7, Z1 and Z2; every other line passes there too.
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
-- Warehouses: whA and whA2 of A, whB of B. Items of A: itA (whA, the
-- update target), itDup (whA, the copy source), itX (stored with whB by the
-- superuser: a row the rules now refuse, written past them), rA (whA, for
-- rent); of B: rB (whB, for rent).
--
-- F.  The fixture is what the matrices assume.
-- I.  An insert of (organization A, warehouse of B) with no read-back, as a
--     manager, admin, owner, all-warehouses member and both two-organization
--     members acting in A: refused 42501 with the guard's words, and no item,
--     holding or movement row is written.
-- S.  Inserts with the organization's own warehouses and with no warehouse,
--     for every persona: each answer is what it was before (matrix pinned).
-- U.  Updates: moving an item to B's warehouse is refused by the guard as
--     before (U1); the rule refuses it on its own too (U2, the guard's check
--     cut inside an undone attempt, as a member of both organizations, who
--     may see the row in B's warehouse); a stored item whose warehouse is
--     B's is not seen by a manager of A alone, as before, and takes no other
--     change from a member of both until it is moved back to one of A's
--     warehouses, which that member may do (U3).
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
-- Z.  Nothing the refused writes and the undone attempts touched was left
--     changed.
--
-- Roles: fixtures as the test superuser. Every attempt runs through
-- pg_temp.attempt (always undone) or pg_temp.kept (kept when it succeeds),
-- which switch role and claims with set_config inside a subtransaction (the
-- 0387 helpers, as 0419 uses them). begin/rollback: nothing leaks.
-- Namespace 04610000; undo code XX461.

begin;

select plan(34);

\set orgA    '\'04610000-0000-0000-0000-00000000000a\''
\set orgB    '\'04610000-0000-0000-0000-00000000000b\''
\set own     '\'04610000-0000-0000-0000-0000000000a1\''
\set adm     '\'04610000-0000-0000-0000-0000000000a2\''
\set mgr     '\'04610000-0000-0000-0000-0000000000a3\''
\set allwh   '\'04610000-0000-0000-0000-0000000000a4\''
\set stf     '\'04610000-0000-0000-0000-0000000000a5\''
\set vwr     '\'04610000-0000-0000-0000-0000000000a6\''
\set two     '\'04610000-0000-0000-0000-0000000000a7\''
\set twoStf  '\'04610000-0000-0000-0000-0000000000a8\''
\set mgrB    '\'04610000-0000-0000-0000-0000000000b1\''
\set whA     '\'04610000-0000-0000-0000-0000000000d1\''
\set whA2    '\'04610000-0000-0000-0000-0000000000d2\''
\set whB     '\'04610000-0000-0000-0000-0000000000d3\''
\set itA     '\'04610000-0000-0000-0000-000000000101\''
\set itDup   '\'04610000-0000-0000-0000-000000000102\''
\set itX     '\'04610000-0000-0000-0000-000000000103\''
\set rA      '\'04610000-0000-0000-0000-000000000104\''
\set rB      '\'04610000-0000-0000-0000-000000000105\''
\set locA    '\'04610000-0000-0000-0000-000000000201\''
\set locA2   '\'04610000-0000-0000-0000-000000000202\''
\set locB    '\'04610000-0000-0000-0000-000000000203\''
\set whNew   '\'04610000-0000-0000-0000-0000000000d9\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,    'i461-own@i461.test',    '{}'::jsonb),
  (:adm,    'i461-adm@i461.test',    '{}'::jsonb),
  (:mgr,    'i461-mgr@i461.test',    '{}'::jsonb),
  (:allwh,  'i461-allwh@i461.test',  '{}'::jsonb),
  (:stf,    'i461-stf@i461.test',    '{}'::jsonb),
  (:vwr,    'i461-vwr@i461.test',    '{}'::jsonb),
  (:two,    'i461-two@i461.test',    '{}'::jsonb),
  (:twoStf, 'i461-twostf@i461.test', '{}'::jsonb),
  (:mgrB,   'i461-mgrb@i461.test',   '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:orgA, 'I461 Item Org A', 'i461-item-org-a'),
  (:orgB, 'I461 Item Org B', 'i461-item-org-b');
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
  (:orgB, :mgrB,   'manager', now(), false);
insert into public.organization_modules (organization_id, module_id, enabled, tier) values
  (:orgA, 'rentals', true, 'optional'),
  (:orgB, 'rentals', true, 'optional')
  on conflict (organization_id, module_id) do update set enabled = true;
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA,  :orgA, 'I461 Main',   'WH-I461A',  'active'),
  (:whA2, :orgA, 'I461 Second', 'WH-I461A2', 'active'),
  (:whB,  :orgB, 'I461 Other',  'WH-I461B',  'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :stf,    :whA, true),
  (:orgA, :vwr,    :whA, true),
  (:orgA, :twoStf, :whA, true),
  (:orgB, :two,    :whB, true);
-- Items, by the superuser (the guard holds the API roles only). itX is the
-- row the rules now refuse, written past them.
insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, is_rental, status, item_type) values
  (:itA,   :orgA, :whA, 'I461-A',   'Folding table', 0, false, 'active', 'asset'),
  (:itDup, :orgA, :whA, 'I461-DUP', 'Stack chair',   0, false, 'active', 'asset'),
  (:itX,   :orgA, :whB, 'I461-X',   'Floor lamp',    0, false, 'active', 'asset'),
  (:rA,    :orgA, :whA, 'I461-RA',  'Projector A',   5, true,  'active', 'asset'),
  (:rB,    :orgB, :whB, 'I461-RB',  'Projector B',   5, true,  'active', 'asset');

insert into public.locations (id, organization_id, warehouse_id, name, type) values
  (:locA,  :orgA, :whA, 'I461 Aisle 1', 'room'),
  (:locA2, :orgA, :whA, 'I461 Shelf 1', 'shelf'),
  (:locB,  :orgB, :whB, 'I461 Aisle B', 'room');

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
    raise exception using errcode = 'XX461', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XX461' then
    return 'ok:' || v_n::text || coalesce(':' || v_seen, '');
  end if;
  return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
end $$;

create temp table persona (who text primary key, id uuid);
insert into persona (who, id) values
  ('own', :own), ('adm', :adm), ('mgr', :mgr), ('allwh', :allwh), ('stf', :stf), ('vwr', :vwr),
  ('two', :two), ('twoStf', :twoStf), ('mgrB', :mgrB);

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

-- An item insert of (organization A, p_wh) with five on hand and NO
-- read-back (no RETURNING), as p_who, KEPT when it succeeds (the row then
-- stays for the rest of this transaction, as a Data API insert with
-- return=minimal would): '<outcome> | <rows_of(sku)>', the rows read after
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
                   '04610000-0000-0000-0000-00000000000a', p_wh, p_sku);
    perform set_config('role', 'none', true);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
    v_out := v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
  end;
  perform set_config('role', 'none', true);
  return v_out || ' | ' || pg_temp.rows_of(p_sku);
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
    -- warehouse passes, as before).
    if not public.warehouse_in_org(new.warehouse_id, new.organization_id) then
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
                     from public.inventory_items i where i.organization_id = '04610000-0000-0000-0000-00000000000a'), '-')
      || ' # ' || (select count(*) from public.item_stock_levels l
                    join public.inventory_items i on i.id = l.item_id
                   where i.organization_id = '04610000-0000-0000-0000-00000000000a')::text
      || ' # ' || (select count(*) from public.locations where organization_id = '04610000-0000-0000-0000-00000000000b')::text
      || ' # ' || (select count(*) from public.stock_movements
                   where organization_id in ('04610000-0000-0000-0000-00000000000a', '04610000-0000-0000-0000-00000000000b'))::text
      || ' # ' || (select count(*) from public.rentals
                   where organization_id in ('04610000-0000-0000-0000-00000000000a', '04610000-0000-0000-0000-00000000000b'))::text
      || ' # ' || (select string_agg(l.name || '/' || coalesce(l.parent_id::text, '-'), ',' order by l.name collate "C")
                     from public.locations l where l.organization_id = '04610000-0000-0000-0000-00000000000a')
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
  'adm:admin/- allwh:staff/- mgr:manager/- mgrB:-/manager own:owner/- stf:staff/- two:admin/staff twoStf:staff/manager vwr:viewer/-',
  'F1: each persona''s rank in organization A and in organization B');
select is(
  (select string_agg(p.who || ':' || (select string_agg(w.code, '+' order by w.code collate "C")
                                        from public.user_warehouse_assignments u join public.warehouses w on w.id = u.warehouse_id
                                       where u.user_id = p.id), ' ' order by p.who collate "C")
     from persona p where p.who in ('allwh', 'stf', 'vwr', 'two', 'twoStf')),
  'allwh:WH-I461A+WH-I461A2 stf:WH-I461A two:WH-I461B twoStf:WH-I461A vwr:WH-I461A',
  'F2: the warehouse assignments (allwh holds both of A''s through the all-warehouses trigger)');
select is(
  (select count(*)::int from public.locations l where l.warehouse_id = :whB and l.kind = 'unplaced' and l.organization_id = :orgB),
  1,
  'F3: B''s warehouse has its Unplaced location, in organization B');

-- ══ I. Another organization's warehouse on insert ═════════════════════════
select is(
  'mgr=' || pg_temp.kept('mgr', :whB, 'I461-I-MGR') || '; adm=' || pg_temp.kept('adm', :whB, 'I461-I-ADM')
  || '; own=' || pg_temp.kept('own', :whB, 'I461-I-OWN') || '; allwh=' || pg_temp.kept('allwh', :whB, 'I461-I-ALL'),
  'mgr=42501:-:That warehouse is not part of this organization. | items=0 levels=0 moves=0; '
  || 'adm=42501:-:That warehouse is not part of this organization. | items=0 levels=0 moves=0; '
  || 'own=42501:-:That warehouse is not part of this organization. | items=0 levels=0 moves=0; '
  || 'allwh=42501:-:That warehouse is not part of this organization. | items=0 levels=0 moves=0',
  'I1: a manager, an admin, an owner and an all-warehouses member of A inserting an item of A in B''s warehouse, no read-back: refused 42501, and no item, holding or movement row is written');
select is(
  'two=' || pg_temp.kept('two', :whB, 'I461-I-TWO') || '; twoStf=' || pg_temp.kept('twoStf', :whB, 'I461-I-TWOSTF'),
  'two=42501:-:That warehouse is not part of this organization. | items=0 levels=0 moves=0; '
  || 'twoStf=42501:-:That warehouse is not part of this organization. | items=0 levels=0 moves=0',
  'I2: a member of both organizations acting in A (an admin of A who is staff of B, a staff member of A who is a manager of B): refused 42501, nothing written');

-- ══ S. Own warehouses and no warehouse, as before ═════════════════════════
select is(
  pg_temp.each(array['own', 'adm', 'mgr', 'allwh', 'stf', 'vwr', 'two', 'twoStf'],
    $q$insert into public.inventory_items (organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type)
       values ('04610000-0000-0000-0000-00000000000a', '04610000-0000-0000-0000-0000000000d1', 'I461-S-%1$s', 'Banquet table', 5, 'active', 'asset')$q$,
    $q$select pg_temp.rows_of('I461-S-%1$s')$q$),
  'own=ok:1:items=1 levels=1 moves=0, adm=ok:1:items=1 levels=1 moves=0, mgr=ok:1:items=1 levels=1 moves=0, '
  || 'allwh=ok:1:items=1 levels=1 moves=0, stf=ok:1:items=1 levels=1 moves=0, '
  || 'vwr=42501:-:new row violates row-level security policy for table "inventory_items", '
  || 'two=ok:1:items=1 levels=1 moves=0, twoStf=ok:1:items=1 levels=1 moves=0',
  'S1: an insert in A''s warehouse whA, for every persona: as before');
select is(
  pg_temp.each(array['own', 'adm', 'mgr', 'allwh', 'stf', 'vwr', 'two', 'twoStf'],
    $q$insert into public.inventory_items (organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type)
       values ('04610000-0000-0000-0000-00000000000a', '04610000-0000-0000-0000-0000000000d2', 'I461-S2-%1$s', 'Banquet table', 5, 'active', 'asset')$q$),
  'own=ok:1, adm=ok:1, mgr=ok:1, allwh=ok:1, '
  || 'stf=42501:-:new row violates row-level security policy for table "inventory_items", '
  || 'vwr=42501:-:new row violates row-level security policy for table "inventory_items", two=ok:1, '
  || 'twoStf=42501:-:new row violates row-level security policy for table "inventory_items"',
  'S2: an insert in A''s warehouse whA2 (stf, vwr and twoStf are not assigned to it), for every persona: as before');
select is(
  pg_temp.each(array['own', 'adm', 'mgr', 'allwh', 'stf', 'vwr', 'two', 'twoStf'],
    $q$insert into public.inventory_items (organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type)
       values ('04610000-0000-0000-0000-00000000000a', null, 'I461-S3-%1$s', 'Banquet table', 0, 'active', 'asset')$q$),
  'own=ok:1, adm=ok:1, mgr=ok:1, allwh=ok:1, stf=ok:1, '
  || 'vwr=42501:-:new row violates row-level security policy for table "inventory_items", two=ok:1, twoStf=ok:1',
  'S3: an insert with no warehouse, for every persona: as before');
select is(
  pg_temp.attempt('authenticated', :mgr,
    $q$insert into public.inventory_items (organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type)
       values ('04610000-0000-0000-0000-00000000000a', '04610000-0000-0000-0000-0000000000d1', 'I461-S4', 'Banquet table', 5, 'active', 'asset')$q$,
    null,
    $q$select pg_temp.rows_of('I461-S4') || ' at ' || (select l.kind || '/' || (l.warehouse_id = '04610000-0000-0000-0000-0000000000d1')::text
                                                         from public.item_stock_levels s join public.locations l on l.id = s.location_id
                                                         join public.inventory_items i on i.id = s.item_id where i.sku = 'I461-S4')$q$),
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

-- ══ D. duplicate_inventory_item ═══════════════════════════════════════════
select is(
  pg_temp.attempt('authenticated', :mgr,
    format($q$select public.duplicate_inventory_item(%L, '{"sku": "I461-DUP-2", "quantity": 2}'::jsonb)$q$, :itDup), null,
    $q$select pg_temp.rows_of('I461-DUP-2') || ' ' || (select (warehouse_id = '04610000-0000-0000-0000-0000000000d1')::text from public.inventory_items where sku = 'I461-DUP-2')$q$),
  'ok:1:items=1 levels=1 moves=1 true',
  'D1: a manager copies an item of A in whA, as before (the copy is in whA, with its two on hand and their movement)');
select is(
  pg_temp.attempt('authenticated', :mgr,
    format($q$select public.duplicate_inventory_item(%L, '{"sku": "I461-X-2"}'::jsonb)$q$, :itX))
  || ' / ' || pg_temp.attempt('authenticated', :two,
    format($q$select public.duplicate_inventory_item(%L, '{"sku": "I461-X-2"}'::jsonb)$q$, :itX)),
  'P0002:-:original_not_found / 42501:-:That warehouse is not part of this organization.',
  'D2: a copy of the stored item whose warehouse is B''s: not found for a manager of A alone (as before), refused for a member of both who sees it');

-- ══ R. create_rental ══════════════════════════════════════════════════════
select is(
  pg_temp.attempt('authenticated', :mgr,
    format($q$select public.create_rental(%L, null, 'Borrower One', null, now() + interval '3 days', null,
                jsonb_build_array(jsonb_build_object('item_id', %L, 'quantity', 1)))$q$, :whB, :rB), null,
    $q$select (select count(*) from public.rentals where organization_id in ('04610000-0000-0000-0000-00000000000a', '04610000-0000-0000-0000-00000000000b'))::text$q$),
  'P0002:-:warehouse_not_found',
  'R1: a manager of A alone names B''s warehouse: refused, nothing written');
select is(
  pg_temp.attempt('authenticated', :two,
    format($q$select public.create_rental(%L, null, 'Borrower One', null, now() + interval '3 days', null,
                jsonb_build_array(jsonb_build_object('item_id', %L, 'quantity', 1)))$q$, :whB, :rB), null,
    $q$select string_agg(r.organization_id::text || '/' || r.warehouse_id::text, ',') from public.rentals r
        where r.organization_id in ('04610000-0000-0000-0000-00000000000a', '04610000-0000-0000-0000-00000000000b')$q$),
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
        where r.organization_id in ('04610000-0000-0000-0000-00000000000a', '04610000-0000-0000-0000-00000000000b')$q$),
  'ok:1:' || :orgA || '/' || :whA,
  'R4: a manager of A rents A''s item from A''s warehouse, as before');

-- ══ M. Each layer alone ═══════════════════════════════════════════════════
select is(
  pg_temp.attempt('authenticated', :mgr,
    $q$insert into public.inventory_items (organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type)
       values ('04610000-0000-0000-0000-00000000000a', '04610000-0000-0000-0000-0000000000d3', 'I461-M1', 'Banquet table', 5, 'active', 'asset')$q$,
    format('select pg_temp.unpatch(%L, %L)', 'public.tg_inventory_items_guard()', pg_temp.guard_block())),
  '42501:-:new row violates row-level security policy for table "inventory_items"',
  'M1: with the guard''s new block cut, the INSERT rule alone refuses B''s warehouse');
select is(
  pg_temp.attempt('authenticated', :mgr,
    $q$insert into public.inventory_items (organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type)
       values ('04610000-0000-0000-0000-00000000000a', '04610000-0000-0000-0000-0000000000d3', 'I461-M2', 'Banquet table', 5, 'active', 'asset')$q$,
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
  'c894f0fc447a3275' || '451423d4d2ad2036' || '|' || '0b41f8f3e41197d7' || '9b0af640e4dacf04',
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
  'c0df4f6f9d96fc02' || '9ebb29d70e5438a0',
  'P3: the table''s INSERT, UPDATE and ALL rules are exactly the two new ones');
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
       values ('04610000-0000-0000-0000-00000000000a', '04610000-0000-0000-0000-0000000000d1', 'I461 L1 %1$s', 'shelf',
               '04610000-0000-0000-0000-000000000203')$q$),
  'own=42501:-:new row violates row-level security policy for table "locations", '
  || 'adm=42501:-:new row violates row-level security policy for table "locations", '
  || 'mgr=42501:-:new row violates row-level security policy for table "locations", '
  || 'two=42501:-:new row violates row-level security policy for table "locations"',
  'L1: an owner, an admin, a manager of A and a member of both adding a location of A whose parent is B''s location, no read-back: refused 42501');
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
       values ('04610000-0000-0000-0000-00000000000a', '04610000-0000-0000-0000-0000000000d1', 'I461 L3 %1$s', 'shelf',
               '04610000-0000-0000-0000-000000000201')$q$)
  || ' / ' || pg_temp.each(array['own', 'adm', 'mgr', 'stf', 'two'],
    $q$insert into public.locations (organization_id, warehouse_id, name, type, parent_id)
       values ('04610000-0000-0000-0000-00000000000a', '04610000-0000-0000-0000-0000000000d1', 'I461 L3n %1$s', 'shelf', null)$q$),
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
    format($q$select * from public.mint_placement_location(%L, %L, 'rack', 'I461 Rack 9', 'shelf', %L, null, '9', null, null, null)$q$,
           :orgA, :whA, :locA), null,
    $q$select (select parent_id::text from public.locations where name = 'I461 Rack 9')$q$)
  || ' / ' || pg_temp.attempt('authenticated', :mgr,
    format($q$select * from public.mint_placement_location(%L, %L, 'rack', 'I461 Rack 8', 'shelf', %L, null, '8', null, null, null)$q$,
           :orgA, :whA, :locB)),
  'ok:1:' || :locA || ' / 42501:The parent location does not belong to this organization.:insufficient_privilege',
  'L5: mint_placement_location makes a rack under A''s own location, and refuses B''s location as the parent (its own check), as before');
select is(
  pg_temp.attempt('authenticated', :adm,
    format($q$insert into public.warehouses (id, organization_id, name, code, status) values (%L, %L, 'I461 New', 'WH-I461N', 'active')$q$, :whNew, :orgA),
    null,
    format($q$select string_agg(coalesce(kind, '-'), ',' order by kind collate "C") from public.locations where warehouse_id = %L$q$, :whNew))
  || ' / ' || pg_temp.attempt('authenticated', :mgr,
    $q$insert into public.inventory_items (organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type)
       values ('04610000-0000-0000-0000-00000000000a', null, 'I461-L6', 'Banquet table', 5, 'active', 'asset')$q$,
    null,
    $q$select count(*)::text from public.locations where organization_id = '04610000-0000-0000-0000-00000000000a'
                                                    and warehouse_id is null and kind = 'unplaced' and parent_id is null$q$)
  || ' / ' || pg_temp.attempt('service_role', null,
    $q$insert into public.locations (organization_id, name, type) values ('04610000-0000-0000-0000-00000000000a', 'I461 Main Warehouse', 'warehouse')$q$),
  'ok:1:staging,unplaced / ok:1:1 / ok:1',
  'L6: the writers past the rules: a new warehouse''s default locations, the organization''s Unplaced bucket for an item with no warehouse, and a service-role location with no parent');
select is(
  md5(pg_temp.loc_rules()),
  'df4952ad189fda0e' || 'defaec0f4d25c67c',
  'L7: the locations INSERT, UPDATE and ALL rules are exactly the two new ones');

-- ══ Z. Nothing left changed ═══════════════════════════════════════════════
select is(pg_temp.state(), (select v from snap),
  'Z1: the refused inserts and the undone attempts left organization A''s items, their holdings, organization B''s locations, both organizations'' movements and rentals, and organization A''s locations and their parents as they were');
select is(
  (select count(*)::int from public.inventory_items where sku like 'I461-I-%'),
  0,
  'Z2: no item of the I section exists');

select * from finish();
rollback;
