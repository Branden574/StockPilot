-- 0461_item_location_and_event_references_in_own_organization.sql
--
-- These references belong to the row's own organization, for every rank (a
-- NULL reference passes, as before):
--   * an item's warehouse and category: the INSERT and UPDATE rules of
--     public.inventory_items ask warehouse_in_org(warehouse_id,
--     organization_id) and category_in_org(category_id, organization_id) of
--     the new row, and tg_inventory_items_guard refuses an insert by a member
--     of the item's organization whose warehouse is not that organization's,
--     in the words its update branch already uses;
--   * a location's parent: the INSERT and UPDATE rules of public.locations
--     ask location_in_org(parent_id, organization_id) of the new row;
--   * an event's warehouse: the INSERT rule of public.schedule_events asks
--     warehouse_in_org(warehouse_id, organization_id) of the new row (its
--     UPDATE rule has asked it since 0203).
-- No row of any table changes.
--
-- ── WHAT ──────────────────────────────────────────────────────────────────
-- The rules (0298) ask, of a new or changed item: a member who may create
-- (or change) items; a manager, or no warehouse, or write on the warehouse
-- (user_can_access_warehouse, which reads the organization from the
-- warehouse itself); and a primary location, charter, supplier and product
-- group of the item's organization. They ask the same of the warehouse and
-- the category, in the form they use for the location, charter, supplier and
-- product group:
--   INSERT WITH CHECK   0298's, AND warehouse_in_org(warehouse_id, organization_id)
--                               AND category_in_org(category_id, organization_id)
--   UPDATE WITH CHECK   0298's, AND the same two terms
--   UPDATE USING        0212's, unchanged (which rows a member may change)
-- tg_inventory_items_guard (0364) asks the warehouse question of an insert
-- by an API role who is a member of the item's organization (its update
-- branch has asked it of a changed warehouse since 0359), so a member's
-- refusal reads "That warehouse is not part of this organization." (42501);
-- anyone else is answered by the INSERT rule, with the row level security
-- message whatever warehouse they name. warehouse_in_org (0203),
-- category_in_org (0298) and is_org_member are SECURITY DEFINER and
-- executable by authenticated, so they answer inside the rules and inside
-- the guard (SECURITY INVOKER) alike; the two *_in_org helpers are
-- NULL-safe.
--
-- Every writer of inventory_items already names a warehouse of the item's
-- organization or none: the web app's item creates (single, bulk, sized
-- variants, book imports, purchase-order and import lines) insert the active
-- organization's chosen warehouse through the signed-in user's client;
-- ledger.assemble_bundle (INVOKER) checks its warehouse against the kit's
-- organization before it inserts the kit item; duplicate_inventory_item
-- (INVOKER) copies the source row's organization, warehouse and category.
-- Categories are chosen from the organization's own list (the item forms,
-- Set category, imports, product groups, whose own rules ask
-- category_in_org since 0298). The UPDATE rule asks it of the whole new
-- row, whichever columns change.
--
-- The locations rules (0212) ask a manager or locations:manage, and a
-- warehouse of the location's organization. They ask the same of the parent:
--   INSERT WITH CHECK   0212's, AND location_in_org(parent_id, organization_id)
--   UPDATE WITH CHECK   0212's, AND location_in_org(parent_id, organization_id)
--   UPDATE USING        0212's, unchanged
-- location_in_org (0203) is NULL-safe, SECURITY DEFINER and executable by
-- authenticated. The writers that set a parent already name one of the
-- location's organization: the Locations page (LocationsService create and
-- update, the signed-in user's client) and mint_placement_location (0340,
-- which checks location_in_org on its parent itself). The definer and
-- service-role writers (a warehouse's default locations, the Unplaced and
-- staging buckets, a new organization's first location) set no parent and
-- run past the rules as before.
--
-- The schedule_events INSERT rule (0384) asks: a member of the event's
-- organization, filing their own event, with no warehouse or one they may
-- write (user_can_access_warehouse), a bundle source warehouse and an order
-- of the event's organization. It now asks warehouse_in_org of the warehouse
-- too, as the UPDATE rule does; every other term is restated as it was. The
-- event writers name the active organization's warehouse or none: the
-- Schedule page (ScheduleService, the signed-in user's client), the phone's
-- New event screen (its warehouse list is the active organization's), and
-- the server's order-to-schedule and reminder writes (service role, past
-- the rules, from the order's own warehouse).
--
--   0. Preflight: refuse (55000, hint item_warehouse_preflight, nothing
--      applied) unless inventory_items' INSERT, UPDATE and ALL rules are
--      exactly 0298's two, locations' are exactly 0212's two and
--      schedule_events' are exactly 0384's two, tg_inventory_items_guard is
--      0364's body (SECURITY INVOKER, search_path public, owned by postgres,
--      no EXECUTE for the API roles), and warehouse_in_org, location_in_org,
--      category_in_org and is_org_member are the bodies the rules and the
--      guard expect (SECURITY DEFINER, stable, owned by postgres, executable
--      by authenticated: INV-C1, the rules run as the writer).
--   1. The lock prelude (LOCKS below).
--   2. The five rules are dropped and created in this one transaction (never
--      ALTER: pattern 24, INV-F1), every conjunct restated and every column
--      of the rule's own table qualified (pattern 25).
--   3. tg_inventory_items_guard: 0364's body with the insert check added;
--      SECURITY INVOKER, search_path, owner and the trigger binding as they
--      are; EXECUTE revoked from PUBLIC, anon and authenticated again (0364).
--   4. Comments on the five rules and the guard.
--
-- ── LOCKS ─────────────────────────────────────────────────────────────────
-- DROP POLICY and CREATE POLICY take ACCESS EXCLUSIVE on
-- public.inventory_items, public.locations and public.schedule_events and, through supautils 3.4.0 (image 17.6.1.166), on
-- every existing table supautils.policy_grants lists for this role: 23 auth,
-- storage and realtime tables, auth.users and auth.sessions among them (0390,
-- 0395, 0400, 0420, 0421). The preflight reads catalogs and deparses the
-- rules in a block that is always undone, so it ends holding no table lock.
-- CREATE OR REPLACE FUNCTION, REVOKE and COMMENT ON FUNCTION take no table
-- lock. So the prelude takes all of those tables at once, NOWAIT, retrying up
-- to 40 times with a 50 to 150 ms pause that holds nothing (the 0390, 0395,
-- 0420 and 0421 pattern), and no later statement takes a new table lock: the
-- file never waits while holding one, so it cannot deadlock. From the
-- prelude to the commit (milliseconds), item, location and event reads and writes, sign-ins,
-- token refreshes, and storage and realtime requests wait for the hold.
-- lock_timeout 900ms bounds anything unforeseen.
--
-- ── ERRORS ────────────────────────────────────────────────────────────────
-- 55000 hint item_warehouse_preflight: drift, or a second run; nothing
-- applied. 55P03: busy after 40 attempts, or the 900 ms cap; nothing applied,
-- run it again. Afterwards an item insert or update that names another
-- organization's warehouse or category, a location insert or update that
-- names another organization's location as its parent, and an event insert
-- that names another organization's warehouse get 42501. Never 40001 or 40P01 (PostgREST
-- retries those, 0367).
--
-- ── ORDER ─────────────────────────────────────────────────────────────────
-- After every lower number. No queued migration restates, drops or pins the
-- five rules or tg_inventory_items_guard's body. Queued migrations that pin
-- the bodies of has_org_role, has_permission, is_org_member or the *_in_org
-- helpers leave them alone, as this file does.

set lock_timeout = '900ms';

-- ═══ 0. Preflight ═══════════════════════════════════════════════════════════
do $pre_item_wh$
declare
  v_bad text := '';
  v_pol text;
  r     record;
begin
  -- md5(prosrc) of the bodies this file replaces or calls, by short alias:
  --   g = public.tg_inventory_items_guard() (0364), w = public.warehouse_in_org(uuid,uuid) (0203),
  --   l = public.location_in_org(uuid,uuid) (0203), c = public.category_in_org(uuid,uuid) (0298),
  --   m = public.is_org_member(uuid).
  -- Each md5 is written in two halves.
  for r in
    select v.alias, v.sig, v.want, v.definer, v.vol, v.api_x,
           p.oid as poid, md5(p.prosrc) as got, p.prosecdef, p.provolatile::text as pvol,
           pg_get_userbyid(p.proowner) as owner,
           coalesce(array_to_string(p.proconfig, ','), '-') as cfg,
           case when p.oid is null then false else has_function_privilege('authenticated', p.oid, 'execute') end as auth_x,
           case when p.oid is null then false else has_function_privilege('anon', p.oid, 'execute') end as anon_x
      from (values
        ('g', 'public.tg_inventory_items_guard()', '0b41f8f3e41197d7' || '9b0af640e4dacf04', false, 'v', false),
        ('w', 'public.warehouse_in_org(uuid,uuid)', 'f2be5534bb6d64be' || '28a9ee2dacc3d46d', true, 's', true),
        ('l', 'public.location_in_org(uuid,uuid)', 'b39dcfeb29d7083d' || '049882e18d6b2a8f', true, 's', true),
        ('c', 'public.category_in_org(uuid,uuid)', '1c17782ea6605997' || 'adecfd33cac0d05a', true, 's', true),
        ('m', 'public.is_org_member(uuid)', '76492a6556e9f6a7' || 'c33d942aa9726f9f', true, 's', true)
      ) v(alias, sig, want, definer, vol, api_x)
      left join pg_proc p on p.oid = to_regprocedure(v.sig)
  loop
    if r.poid is null then
      v_bad := v_bad || format(' %s missing;', r.sig);
    elsif r.got <> r.want or r.prosecdef <> r.definer or r.pvol <> r.vol or r.owner <> 'postgres'
          or r.cfg <> 'search_path=public' or r.auth_x <> r.api_x or (r.alias = 'g' and r.anon_x) then
      v_bad := v_bad || format(' %s drifted (md5 %s, definer %s, volatility %s, owner %s, config %s, authenticated %s, anon %s);',
                               r.sig, r.got, r.prosecdef, r.pvol, r.owner, r.cfg, r.auth_x, r.anon_x);
    end if;
  end loop;

  -- The guard is bound once, BEFORE INSERT OR UPDATE FOR EACH ROW, enabled.
  select string_agg(t.tgname || ':' || t.tgtype::text || ':' || t.tgenabled::text, ',' order by t.tgname)
    into v_pol
    from pg_trigger t
   where t.tgrelid = 'public.inventory_items'::regclass
     and t.tgfoid = to_regprocedure('public.tg_inventory_items_guard()');
  if v_pol is distinct from 'trg_zz_inventory_items_guard:23:O' then
    v_bad := v_bad || format(' the guard''s trigger is not 0359''s (%s);', coalesce(v_pol, 'none'));
  end if;

  -- Each table's INSERT, UPDATE and ALL rules, compared by md5 of their
  -- deparse (the lines joined): inventory_items' are 0298's two (i =
  -- 4e642b7f...), locations' are 0212's two (c = 819fc381...), schedule_events'
  -- are 0384's two (e = 66f115a1...). Deparsed in a
  -- block that is always undone, with search_path pinned inside it (0420's
  -- method), so the text does not depend on the session's search_path and
  -- nothing the deparse locks outlives the block. Variables keep their values
  -- when the block is undone.
  for r in
    select v.alias, v.tbl, v.want
      from (values
        ('i', 'public.inventory_items', '4e642b7fd704a1e3' || 'e0e910561b9b8502'),
        ('c', 'public.locations',       '819fc381290bb4cf' || '7019610886c07e3c'),
        ('e', 'public.schedule_events', '66f115a156c058ec' || '433c00cf1da30dcd')
      ) v(alias, tbl, want)
  loop
    v_pol := null;
    begin
      perform set_config('search_path', 'public, extensions', true);
      select string_agg(pol.polname || '|' || pol.polcmd::text || '|' || pol.polpermissive::text || '|'
                        || (select string_agg(case x when 0 then 'public' else x::regrole::text end, ',' order by 1)
                              from unnest(pol.polroles) x)
                        || '|' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '-')
                        || '|' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '-'), E'\n' order by pol.polname)
        into v_pol
        from pg_policy pol
       where pol.polrelid = to_regclass(r.tbl) and pol.polcmd in ('a', 'w', '*');
      raise exception using errcode = 'XX461', message = 'undo';
    exception when sqlstate 'XX461' then
      null;
    end;
    if md5(coalesce(v_pol, '')) is distinct from r.want then
      v_bad := v_bad || format(' %s INSERT/UPDATE rules are not the expected ones (md5 %s);', r.tbl, md5(coalesce(v_pol, '')));
    end if;
  end loop;

  if v_bad <> '' then
    raise exception 'item_warehouse_preflight:%', v_bad using errcode = '55000', hint = 'item_warehouse_preflight';
  end if;
end
$pre_item_wh$;

-- ═══ 1. The lock prelude (see LOCKS above) ══════════════════════════════════
-- Inside DO because the CLI batch is not a transaction block (a top-level
-- LOCK TABLE refuses there, 0373); the locks last until the batch commits.
--   * public.inventory_items, public.locations and public.schedule_events:
--     ACCESS EXCLUSIVE (their rule statements);
--   * every existing table supautils.policy_grants lists for this role, the
--     parent only of a partitioned one: ACCESS EXCLUSIVE (supautils takes it
--     whenever this role runs a rule statement).
-- A busy table fails the attempt at once; the rollback releases what it took
-- and the next attempt starts after 50 to 150 ms holding no table lock. After
-- the 40th busy attempt the 55P03 is raised as it is and nothing is applied.
do $lock_item_wh$
declare
  v_grants text := nullif(current_setting('supautils.policy_grants', true), '');
  v_name   text;
  v_rel    regclass;
  v_try    integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.inventory_items, public.locations, public.schedule_events
        in access exclusive mode nowait;
      if v_grants is not null then
        for v_name in
          select jsonb_array_elements_text(coalesce(v_grants::jsonb -> current_user::text, '[]'::jsonb))
        loop
          v_rel := to_regclass(v_name);
          if v_rel is not null then
            execute format('lock table only %s in access exclusive mode nowait', v_rel);
          end if;
        end loop;
      end if;
      exit;
    exception when lock_not_available then
      if v_try >= 40 then
        raise;
      end if;
    end;
    perform pg_sleep(0.05 + random() * 0.1);
  end loop;
end $lock_item_wh$;

-- ═══ 2. The five rules ══════════════════════════════════════════════════════
drop policy if exists inventory_items_insert on public.inventory_items;
create policy inventory_items_insert on public.inventory_items
  for insert to authenticated
  with check (
    -- CONJUNCT 1 of 8: a member who may create items (0212).
    ( ( select public.has_org_role(inventory_items.organization_id, 'staff') )
      or ( select public.has_permission(inventory_items.organization_id, 'items:create') ) )

    -- CONJUNCT 2 of 8: a manager, or no warehouse, or write on the warehouse
    -- (0007, 0140).
    and ( ( select public.has_org_role(inventory_items.organization_id, 'manager') )
          or inventory_items.warehouse_id is null
          or public.user_can_access_warehouse(auth.uid(), inventory_items.warehouse_id, 'write') )

    -- CONJUNCTS 3 to 6 of 8: the primary location, charter, supplier and
    -- product group are the item's organization's (0203 to 0205, 0298).
    and ( select public.location_in_org(inventory_items.primary_location_id, inventory_items.organization_id) )
    and ( select public.charter_in_org(inventory_items.charter_id, inventory_items.organization_id) )
    and ( select public.supplier_in_org(inventory_items.supplier_id, inventory_items.organization_id) )
    and ( select public.product_group_in_org(inventory_items.group_id, inventory_items.organization_id) )

    -- CONJUNCTS 7 and 8 of 8: and so are the warehouse and the category, for
    -- every rank.
    and ( select public.warehouse_in_org(inventory_items.warehouse_id, inventory_items.organization_id) )
    and ( select public.category_in_org(inventory_items.category_id, inventory_items.organization_id) )
  );

drop policy if exists inventory_items_update on public.inventory_items;
create policy inventory_items_update on public.inventory_items
  for update to authenticated
  using (
    -- Which rows a member may change: 0212's, unchanged.
    ( ( select public.has_org_role(inventory_items.organization_id, 'staff') )
      or ( select public.has_permission(inventory_items.organization_id, 'items:update') ) )
    and ( ( select public.has_org_role(inventory_items.organization_id, 'manager') )
          or inventory_items.warehouse_id is null
          or public.user_can_access_warehouse(auth.uid(), inventory_items.warehouse_id, 'write') )
  )
  with check (
    -- CONJUNCT 1 of 8: a member who may change items (0212).
    ( ( select public.has_org_role(inventory_items.organization_id, 'staff') )
      or ( select public.has_permission(inventory_items.organization_id, 'items:update') ) )

    -- CONJUNCT 2 of 8: a manager, or no warehouse, or write on the warehouse
    -- (0007, 0140).
    and ( ( select public.has_org_role(inventory_items.organization_id, 'manager') )
          or inventory_items.warehouse_id is null
          or public.user_can_access_warehouse(auth.uid(), inventory_items.warehouse_id, 'write') )

    -- CONJUNCTS 3 to 6 of 8: the primary location, charter, supplier and
    -- product group are the item's organization's (0203 to 0205, 0298).
    and ( select public.location_in_org(inventory_items.primary_location_id, inventory_items.organization_id) )
    and ( select public.charter_in_org(inventory_items.charter_id, inventory_items.organization_id) )
    and ( select public.supplier_in_org(inventory_items.supplier_id, inventory_items.organization_id) )
    and ( select public.product_group_in_org(inventory_items.group_id, inventory_items.organization_id) )

    -- CONJUNCTS 7 and 8 of 8: and so are the warehouse and the category, for
    -- every rank.
    and ( select public.warehouse_in_org(inventory_items.warehouse_id, inventory_items.organization_id) )
    and ( select public.category_in_org(inventory_items.category_id, inventory_items.organization_id) )
  );

drop policy if exists locations_insert on public.locations;
create policy locations_insert on public.locations
  for insert to authenticated
  with check (
    -- CONJUNCT 1 of 3: a manager, or locations:manage (0212).
    ( ( select public.has_org_role(locations.organization_id, 'manager') )
      or ( select public.has_permission(locations.organization_id, 'locations:manage') ) )

    -- CONJUNCT 2 of 3: the warehouse is the location's organization's (0203).
    and ( select public.warehouse_in_org(locations.warehouse_id, locations.organization_id) )

    -- CONJUNCT 3 of 3: and so is the parent, for every rank.
    and ( select public.location_in_org(locations.parent_id, locations.organization_id) )
  );

drop policy if exists locations_update on public.locations;
create policy locations_update on public.locations
  for update to authenticated
  using (
    -- Which rows a member may change: 0212's, unchanged.
    ( select public.has_org_role(locations.organization_id, 'manager') )
    or ( select public.has_permission(locations.organization_id, 'locations:manage') )
  )
  with check (
    -- CONJUNCT 1 of 3: a manager, or locations:manage (0212).
    ( ( select public.has_org_role(locations.organization_id, 'manager') )
      or ( select public.has_permission(locations.organization_id, 'locations:manage') ) )

    -- CONJUNCT 2 of 3: the warehouse is the location's organization's (0203).
    and ( select public.warehouse_in_org(locations.warehouse_id, locations.organization_id) )

    -- CONJUNCT 3 of 3: and so is the parent, for every rank.
    and ( select public.location_in_org(locations.parent_id, locations.organization_id) )
  );

drop policy if exists schedule_events_insert on public.schedule_events;
create policy schedule_events_insert on public.schedule_events
  for insert to authenticated
  with check (
    -- CONJUNCT 1 of 6: a member of the event's organization (0032, 0140).
    ( select public.is_org_member(schedule_events.organization_id) )

    -- CONJUNCT 2 of 6: filing their own event (0032).
    and schedule_events.created_by = auth.uid()

    -- CONJUNCT 3 of 6: no warehouse, or one they may write (0033).
    and ( schedule_events.warehouse_id is null
          or public.user_can_access_warehouse(auth.uid(), schedule_events.warehouse_id, 'write') )

    -- CONJUNCTS 4 and 5 of 6: the bundle source warehouse and the order are
    -- the event's organization's (0203, 0384).
    and ( select public.warehouse_in_org(schedule_events.bundle_warehouse_id, schedule_events.organization_id) )
    and ( select public.order_request_in_org(schedule_events.order_request_id, schedule_events.organization_id) )

    -- CONJUNCT 6 of 6: and so is the warehouse, for every rank.
    and ( select public.warehouse_in_org(schedule_events.warehouse_id, schedule_events.organization_id) )
  );

-- ═══ 3. tg_inventory_items_guard ════════════════════════════════════════════
-- 0364's body, with the insert check added after the two stamps.
create or replace function public.tg_inventory_items_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_cost_changed      boolean := new.unit_cost is distinct from old.unit_cost;
  v_charter_changed   boolean := new.charter_id is distinct from old.charter_id;
  v_warehouse_changed boolean := new.warehouse_id is distinct from old.warehouse_id;
begin
  -- See tg_ledger_only_guard for why only the API roles are checked.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  -- Who created an item and when are the database's to record. The
  -- failed-create rollback (compensate_opening_stock) trusts both.
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
    -- An item's warehouse belongs to the item's organization (a NULL
    -- warehouse passes, as before). Asked of a member of that organization
    -- only: anyone else is answered by the INSERT rule.
    if public.is_org_member(new.organization_id)
       and not public.warehouse_in_org(new.warehouse_id, new.organization_id) then
      raise exception 'That warehouse is not part of this organization.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.organization_id is distinct from old.organization_id then
    raise exception 'An item cannot be moved to another organization.'
      using errcode = '42501';
  end if;
  if new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'An item''s creator and creation time cannot be changed.'
      using errcode = '42501';
  end if;

  -- On-hand moves only with its movement (0364).
  if new.quantity_on_hand is distinct from old.quantity_on_hand and not ledger.active() then
    raise exception 'On-hand changes only through a stock movement: adjust, transfer, receive or count.'
      using errcode = '42501';
  end if;

  if not (v_cost_changed or v_charter_changed or v_warehouse_changed) then
    return new;
  end if;

  if not public.has_permission(new.organization_id, 'items:update') then
    if not (v_charter_changed
            and not v_cost_changed
            and not v_warehouse_changed
            and old.quantity_on_hand = 0
            and public.has_permission(new.organization_id, 'purchase_orders:manage')) then
      raise exception 'You do not have permission to change this item''s cost, charter or warehouse.'
        using errcode = '42501';
    end if;
  end if;

  if v_cost_changed and new.unit_cost < 0 then
    raise exception 'Unit cost must be 0 or more.'
      using errcode = '23514';
  end if;

  if v_warehouse_changed then
    if new.warehouse_id is null then
      raise exception 'Item must remain assigned to a warehouse.'
        using errcode = '23514';
    end if;
    if not public.warehouse_in_org(new.warehouse_id, new.organization_id) then
      raise exception 'That warehouse is not part of this organization.'
        using errcode = '42501';
    end if;
    if public.caller_is_warehouse_scoped(new.organization_id) then
      raise exception 'Warehouse-scoped users cannot move items to another warehouse.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.tg_inventory_items_guard() from public, anon, authenticated;

-- ═══ 4. Comments ════════════════════════════════════════════════════════════
-- None of the texts names this file's number, so a rename leaves them (and
-- the md5s the test pins) alone.
comment on policy inventory_items_insert on public.inventory_items is
  'A member who may create items (staff, or items:create) adds an item of their organization: a manager, an item '
  'with no warehouse, or a warehouse they may write to; its warehouse, category, primary location, charter, '
  'supplier and product group are its own organization''s (the *_in_org checks, for every rank).';

comment on policy inventory_items_update on public.inventory_items is
  'A member who may change items (staff, or items:update) changes an item of their organization: a manager, an '
  'item with no warehouse, or one in a warehouse they may write to. The changed item keeps a warehouse, category, '
  'primary location, charter, supplier and product group of its own organization (the *_in_org checks, for every '
  'rank).';

comment on policy locations_insert on public.locations is
  'A manager, or a member with locations:manage, adds a location of their organization; its warehouse and its '
  'parent location are its own organization''s (warehouse_in_org and location_in_org, for every rank).';

comment on policy locations_update on public.locations is
  'A manager, or a member with locations:manage, changes a location of their organization; the changed location '
  'keeps a warehouse and a parent location of its own organization (warehouse_in_org and location_in_org, for '
  'every rank).';

comment on policy schedule_events_insert on public.schedule_events is
  'Any accepted member inserts their own event (created_by = the caller), with no warehouse or one they may write, '
  'and its warehouse, bundle source warehouse and order are its own organization''s (warehouse_in_org and '
  'order_request_in_org, for every rank; authenticated cannot write order_request_id at all, the admin client '
  'links events).';

comment on function public.tg_inventory_items_guard() is
  'BEFORE INSERT OR UPDATE guard: API-role inserts get created_by and created_at from the database, and a member''s '
  'insert names a warehouse of the item''s organization or none; updates cannot change organization_id or the creator, change '
  'quantity_on_hand only inside a ledger RPC, and change cost/charter/warehouse by the item-edit rules (a changed '
  'warehouse is the item''s organization''s). SECURITY INVOKER on purpose (a DEFINER trigger sees postgres and '
  'never enforces).';

reset lock_timeout;
