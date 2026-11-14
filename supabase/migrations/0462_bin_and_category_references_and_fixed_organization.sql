-- 0462_bin_and_category_references_and_fixed_organization.sql
--
-- These references belong to the row's own organization, for every rank (a
-- NULL reference passes):
--   * a stock row's bin and item and a put-away row's item and source and
--     destination bins: inventory_stock_write and putaway_moves_write ask the
--     new bin_in_org(bin_id, organization_id) and item_in_org(item_id,
--     organization_id) of the new row;
--   * a category's parent: categories_insert and categories_update ask
--     category_in_org(parent_id, organization_id) of the new row;
--   * a category assignment's category: user_category_assignments_write asks
--     category_in_org(category_id, organization_id) of the new row, and
--     set_user_category_access asks it of every category it is given.
-- And the organization_id of a warehouse, a location, a bin and a category
-- stays what it is: for the API roles an update that changes it is refused
-- (the new tg_organization_id_fixed, bound on public.warehouses,
-- public.locations, public.bins and public.categories).
-- No row of any table changes.
--
-- ── WHAT ──────────────────────────────────────────────────────────────────
-- bin_in_org(p_bin_id, p_org_id) is warehouse_in_org's body for bins: NULL
-- passes, otherwise the bin row must carry that organization. SECURITY
-- DEFINER, stable, search_path public, owned by postgres, executable by
-- authenticated and service_role only (the *_in_org posture of 0203 and
-- 0318), so it answers inside a rule whatever bins the writer may read.
-- item_in_org (0261, 0318) is the same shape for items.
--
-- The stock and put-away rules (0046, 0140, 0203) are FOR ALL: USING asks a
-- staff member of the row's organization (which rows a member may change or
-- remove), WITH CHECK asks that and a warehouse of the row's organization.
--   inventory_stock_write   WITH CHECK  0203's, AND bin_in_org(bin_id, organization_id)
--                                              AND item_in_org(item_id, organization_id)
--   putaway_moves_write     WITH CHECK  0203's, AND bin_in_org(from_bin_id, organization_id)
--                                              AND bin_in_org(to_bin_id, organization_id)
--                                              AND item_in_org(item_id, organization_id)
--   USING of both                       0140's, unchanged
-- The bin and item columns are NOT NULL. No application code writes either
-- table; putaway_transfer (0019), their one SQL writer, is executable by
-- service_role only (0356).
--
-- The category rules (0140, 0212) ask a manager or categories:manage.
--   categories_insert       WITH CHECK  0212's, AND category_in_org(parent_id, organization_id)
--   categories_update       WITH CHECK  0212's, AND the same term
--                           USING       0212's, unchanged
--   user_category_assignments_write (FOR ALL)
--                           WITH CHECK  0140's, AND category_in_org(category_id, organization_id)
--                           USING       0140's, unchanged
-- category_in_org (0298) is NULL-safe, SECURITY DEFINER and executable by
-- authenticated. The Categories page (CategoriesService, the signed-in
-- user's client) picks a parent from the organization's own list and checks
-- it itself; the phone's category access screen inserts an assignment of a
-- category from the organization's own list. set_user_category_access
-- (0129, SECURITY DEFINER, the web's category access save) runs past the
-- rules, so it asks category_in_org of each category itself, before it
-- changes anything, and refuses the whole list (42501) when one is another
-- organization's; the rest of its body is 0129's.
--
-- tg_organization_id_fixed: BEFORE UPDATE FOR EACH ROW, bound with WHEN
-- (new.organization_id is distinct from old.organization_id), so an
-- ordinary update never enters it. For authenticated and anon it raises
-- 42501 "A warehouse (location, bin, category) cannot be moved to another
-- organization."; every other role (service_role, SECURITY DEFINER bodies
-- owned by postgres, foreign key actions) returns the row as it is, as
-- tg_inventory_items_guard and tg_bundles_guard do. SECURITY INVOKER on
-- purpose (a DEFINER trigger sees postgres and never enforces). No
-- application code sends a changed organization_id for any of the four
-- tables; the web's warehouse, location, bin and category saves name the row
-- in the active organization and leave organization_id out.
--
--   0. Preflight: refuse (55000, hint organization_reference_preflight,
--      nothing applied) unless 0423 is applied in its own form (the item
--      guard's body and the item, location and event rules), the four
--      tables' INSERT, UPDATE and ALL rules are exactly the ones above,
--      set_user_category_access is 0129's body (SECURITY DEFINER,
--      search_path public, owned by postgres, executable by authenticated),
--      warehouse_in_org, category_in_org and item_in_org are the bodies the
--      rules expect, and bin_in_org and tg_organization_id_fixed do not
--      exist yet.
--   1. The lock prelude (LOCKS below).
--   2. bin_in_org, with its EXECUTE decided here.
--   3. The five rules are dropped and created in this one transaction
--      (never ALTER: pattern 24, INV-F1), every conjunct restated and every
--      column of the rule's own table qualified (pattern 25).
--   4. set_user_category_access: 0129's body with the category check added;
--      SECURITY DEFINER, search_path, owner and EXECUTE as they are.
--   5. tg_organization_id_fixed and its four triggers.
--   6. Comments on the five rules and the three functions.
--
-- ── LOCKS ─────────────────────────────────────────────────────────────────
-- DROP POLICY and CREATE POLICY take ACCESS EXCLUSIVE on
-- public.inventory_stock, public.putaway_moves, public.categories and
-- public.user_category_assignments and, through supautils, on every existing
-- table supautils.policy_grants lists for this role (auth, storage and
-- realtime tables, auth.users and auth.sessions among them; 0390, 0395,
-- 0400, 0420, 0421, 0423). CREATE TRIGGER takes SHARE ROW EXCLUSIVE on
-- public.warehouses, public.locations and public.bins, which lets their
-- reads go on (categories is already held). CREATE FUNCTION bin_in_org
-- checks its body and takes ACCESS SHARE on public.bins, which the prelude
-- already holds; CREATE OR REPLACE FUNCTION, REVOKE, GRANT and COMMENT ON
-- FUNCTION take no table lock. The preflight reads catalogs and deparses the
-- rules in a block that is always undone, so it ends holding no table lock.
-- So the prelude takes all of those tables at once, NOWAIT, retrying up to
-- 40 times with a 50 to 150 ms pause that holds nothing (the 0390, 0395,
-- 0420, 0421 and 0423 pattern), and no later statement takes a new table
-- lock: the file never waits while holding one, so it cannot deadlock. From
-- the prelude to the commit (milliseconds), stock, put-away, category and
-- category assignment reads and writes, warehouse, location and bin writes,
-- sign-ins, token refreshes, and storage and realtime requests wait for the
-- hold. lock_timeout 900ms bounds anything unforeseen.
--
-- ── ERRORS ────────────────────────────────────────────────────────────────
-- 55000 hint organization_reference_preflight: drift, 0423 not applied, or a
-- second run; nothing applied. 55P03: busy after 40 attempts, or the 900 ms
-- cap; nothing applied, run it again. Afterwards a stock or put-away write
-- that names another organization's bin or item, a category write that
-- names another organization's category as the parent, an assignment that
-- names another organization's category, a set_user_category_access call
-- with another organization's category, and an API-role update that changes
-- a warehouse's, a location's, a bin's or a category's organization get
-- 42501. Never 40001 or 40P01 (PostgREST retries those, 0367).
--
-- ── ORDER ─────────────────────────────────────────────────────────────────
-- After every lower number, 0423 among them (the preflight asks it). No
-- queued migration restates, drops or pins the five rules or
-- set_user_category_access. Queued migrations that pin the bodies of
-- has_org_role, has_permission or the *_in_org helpers leave them alone, as
-- this file does (it adds bin_in_org).

set lock_timeout = '900ms';

-- ═══ 0. Preflight ═══════════════════════════════════════════════════════════
do $pre_org_ref$
declare
  v_bad text := '';
  v_pol text;
  r     record;
begin
  -- md5(prosrc) of the bodies this file replaces or calls, by short alias:
  --   w = public.warehouse_in_org(uuid,uuid) (0203), c = public.category_in_org(uuid,uuid) (0298),
  --   s = public.set_user_category_access(uuid,uuid,uuid,uuid[]) (0129), i = public.item_in_org(uuid,uuid) (0261).
  -- Each md5 is written in two halves.
  for r in
    select v.alias, v.sig, v.want, v.definer, v.vol,
           p.oid as poid, md5(p.prosrc) as got, p.prosecdef, p.provolatile::text as pvol,
           pg_get_userbyid(p.proowner) as owner,
           coalesce(array_to_string(p.proconfig, ','), '-') as cfg,
           case when p.oid is null then false else has_function_privilege('authenticated', p.oid, 'execute') end as auth_x,
           case when p.oid is null then false else has_function_privilege('anon', p.oid, 'execute') end as anon_x
      from (values
        ('w', 'public.warehouse_in_org(uuid,uuid)', 'f2be5534bb6d64be' || '28a9ee2dacc3d46d', true, 's'),
        ('c', 'public.category_in_org(uuid,uuid)', '1c17782ea6605997' || 'adecfd33cac0d05a', true, 's'),
        ('s', 'public.set_user_category_access(uuid,uuid,uuid,uuid[])', '1b6c5d0ca4e8f37c' || '3774c3c22a02252e', true, 'v'),
        ('i', 'public.item_in_org(uuid,uuid)', '28a1ed8cd1c2adec' || '840215fd94ed5db1', true, 's')
      ) v(alias, sig, want, definer, vol)
      left join pg_proc p on p.oid = to_regprocedure(v.sig)
  loop
    if r.poid is null then
      v_bad := v_bad || format(' %s missing;', r.sig);
    elsif r.got <> r.want or r.prosecdef <> r.definer or r.pvol <> r.vol or r.owner <> 'postgres'
          or r.cfg <> 'search_path=public' or not r.auth_x or r.anon_x then
      v_bad := v_bad || format(' %s drifted (md5 %s, definer %s, volatility %s, owner %s, config %s, authenticated %s, anon %s);',
                               r.sig, r.got, r.prosecdef, r.pvol, r.owner, r.cfg, r.auth_x, r.anon_x);
    end if;
  end loop;

  -- 0423 is applied in its own form: this file's terms sit beside its item,
  -- location and event terms, and its locations trigger runs ahead of 0423's
  -- locations rules. 0423's item guard body (4737d359...) is read here; its
  -- three tables' rules in the loop below.
  if md5(coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.tg_inventory_items_guard()')), ''))
     is distinct from ('4737d3598864d9a7' || 'aad542ad19a9632e') then
    v_bad := v_bad || ' 0423 is not applied in its own form (public.tg_inventory_items_guard() is not 0423''s body);';
  end if;

  -- The two new functions do not exist yet (a second run stops here).
  if to_regprocedure('public.bin_in_org(uuid,uuid)') is not null then
    v_bad := v_bad || ' public.bin_in_org(uuid,uuid) already exists;';
  end if;
  if to_regprocedure('public.tg_organization_id_fixed()') is not null then
    v_bad := v_bad || ' public.tg_organization_id_fixed() already exists;';
  end if;

  -- Each table's INSERT, UPDATE and ALL rules, compared by md5 of their
  -- deparse (the lines joined): inventory_stock's and putaway_moves' are
  -- 0203's (k = b838eaae..., p = d34b5ee0...), categories' are 0212's two
  -- (g = 61345a5f...), user_category_assignments' is 0140's (u = fea176c3...);
  -- and 0423's three: inventory_items' (860b53b2...), locations' (df4952ad...)
  -- and schedule_events' (f534d605...).
  -- Deparsed in a block that is always undone, with search_path pinned
  -- inside it (0420's method), so the text does not depend on the session's
  -- search_path and nothing the deparse locks outlives the block. Variables
  -- keep their values when the block is undone.
  for r in
    select v.alias, v.tbl, v.want
      from (values
        ('k', 'public.inventory_stock',           'b838eaaedbf3078b' || 'e5ffdf0388d933c1'),
        ('p', 'public.putaway_moves',             'd34b5ee0fefab391' || '641282258baa66a4'),
        ('g', 'public.categories',                '61345a5faa6e4191' || '66f81bc0b7fd7047'),
        ('u', 'public.user_category_assignments', 'fea176c320914529' || '62946e8bacb908a4'),
        ('0423', 'public.inventory_items',        '860b53b2fc60ced5' || '04eb35dc86e70152'),
        ('0423', 'public.locations',              'df4952ad189fda0e' || 'defaec0f4d25c67c'),
        ('0423', 'public.schedule_events',        'f534d605adee75dd' || '47f6bb3ceb779ca3')
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
      raise exception using errcode = 'XX462', message = 'undo';
    exception when sqlstate 'XX462' then
      null;
    end;
    if md5(coalesce(v_pol, '')) is distinct from r.want then
      if r.alias = '0423' then
        v_bad := v_bad || format(' 0423 is not applied in its own form (%s INSERT/UPDATE rules md5 %s);', r.tbl, md5(coalesce(v_pol, '')));
      else
        v_bad := v_bad || format(' %s INSERT/UPDATE rules are not the expected ones (md5 %s);', r.tbl, md5(coalesce(v_pol, '')));
      end if;
    end if;
  end loop;

  if v_bad <> '' then
    raise exception 'organization_reference_preflight:%', v_bad using errcode = '55000', hint = 'organization_reference_preflight';
  end if;
end
$pre_org_ref$;

-- ═══ 1. The lock prelude (see LOCKS above) ══════════════════════════════════
-- Inside DO because the CLI batch is not a transaction block (a top-level
-- LOCK TABLE refuses there, 0373); the locks last until the batch commits.
--   * public.inventory_stock, public.putaway_moves, public.categories and
--     public.user_category_assignments: ACCESS EXCLUSIVE (their rule
--     statements);
--   * public.warehouses, public.locations and public.bins: SHARE ROW
--     EXCLUSIVE (CREATE TRIGGER; bins also covers CREATE FUNCTION
--     bin_in_org's ACCESS SHARE);
--   * every existing table supautils.policy_grants lists for this role, the
--     parent only of a partitioned one: ACCESS EXCLUSIVE (supautils takes it
--     whenever this role runs a rule statement).
-- A busy table fails the attempt at once; the rollback releases what it took
-- and the next attempt starts after 50 to 150 ms holding no table lock. After
-- the 40th busy attempt the 55P03 is raised as it is and nothing is applied.
do $lock_org_ref$
declare
  v_grants text := nullif(current_setting('supautils.policy_grants', true), '');
  v_name   text;
  v_rel    regclass;
  v_try    integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.inventory_stock, public.putaway_moves, public.categories, public.user_category_assignments
        in access exclusive mode nowait;
      lock table only public.warehouses, public.locations, public.bins
        in share row exclusive mode nowait;
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
end $lock_org_ref$;

-- ═══ 2. bin_in_org ══════════════════════════════════════════════════════════
-- warehouse_in_org's form (0203) for bins.
create function public.bin_in_org(p_bin_id uuid, p_org_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select p_bin_id is null or exists (
    select 1 from public.bins
    where id = p_bin_id and organization_id = p_org_id
  );
$$;

-- EXECUTE as the other *_in_org helpers hold it (0318): authenticated (the
-- rules run as the writer) and service_role; not PUBLIC or anon. Decided
-- here for all three API roles, whatever the default privileges give.
revoke all on function public.bin_in_org(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.bin_in_org(uuid, uuid) to authenticated, service_role;

-- ═══ 3. The five rules ══════════════════════════════════════════════════════
drop policy if exists inventory_stock_write on public.inventory_stock;
create policy inventory_stock_write on public.inventory_stock
  for all to authenticated
  using (
    -- Which rows a member may change or remove: 0140's, unchanged.
    ( select public.has_org_role(inventory_stock.organization_id, 'staff') )
  )
  with check (
    -- CONJUNCT 1 of 4: a staff member of the row's organization (0046, 0140).
    ( select public.has_org_role(inventory_stock.organization_id, 'staff') )

    -- CONJUNCT 2 of 4: the warehouse is the row's organization's (0203).
    and ( select public.warehouse_in_org(inventory_stock.warehouse_id, inventory_stock.organization_id) )

    -- CONJUNCTS 3 and 4 of 4: and so are the bin and the item, for every
    -- rank.
    and ( select public.bin_in_org(inventory_stock.bin_id, inventory_stock.organization_id) )
    and ( select public.item_in_org(inventory_stock.item_id, inventory_stock.organization_id) )
  );

drop policy if exists putaway_moves_write on public.putaway_moves;
create policy putaway_moves_write on public.putaway_moves
  for all to authenticated
  using (
    -- Which rows a member may change or remove: 0140's, unchanged.
    ( select public.has_org_role(putaway_moves.organization_id, 'staff') )
  )
  with check (
    -- CONJUNCT 1 of 5: a staff member of the row's organization (0046, 0140).
    ( select public.has_org_role(putaway_moves.organization_id, 'staff') )

    -- CONJUNCT 2 of 5: the warehouse is the row's organization's (0203).
    and ( select public.warehouse_in_org(putaway_moves.warehouse_id, putaway_moves.organization_id) )

    -- CONJUNCTS 3 to 5 of 5: and so are the source and destination bins and
    -- the item, for every rank.
    and ( select public.bin_in_org(putaway_moves.from_bin_id, putaway_moves.organization_id) )
    and ( select public.bin_in_org(putaway_moves.to_bin_id, putaway_moves.organization_id) )
    and ( select public.item_in_org(putaway_moves.item_id, putaway_moves.organization_id) )
  );

drop policy if exists categories_insert on public.categories;
create policy categories_insert on public.categories
  for insert to authenticated
  with check (
    -- CONJUNCT 1 of 2: a manager, or categories:manage (0140, 0212).
    ( ( select public.has_org_role(categories.organization_id, 'manager') )
      or ( select public.has_permission(categories.organization_id, 'categories:manage') ) )

    -- CONJUNCT 2 of 2: the parent is the category's organization's, for
    -- every rank.
    and ( select public.category_in_org(categories.parent_id, categories.organization_id) )
  );

drop policy if exists categories_update on public.categories;
create policy categories_update on public.categories
  for update to authenticated
  using (
    -- Which rows a member may change: 0212's, unchanged.
    ( select public.has_org_role(categories.organization_id, 'manager') )
    or ( select public.has_permission(categories.organization_id, 'categories:manage') )
  )
  with check (
    -- CONJUNCT 1 of 2: a manager, or categories:manage (0140, 0212).
    ( ( select public.has_org_role(categories.organization_id, 'manager') )
      or ( select public.has_permission(categories.organization_id, 'categories:manage') ) )

    -- CONJUNCT 2 of 2: the parent is the category's organization's, for
    -- every rank.
    and ( select public.category_in_org(categories.parent_id, categories.organization_id) )
  );

drop policy if exists user_category_assignments_write on public.user_category_assignments;
create policy user_category_assignments_write on public.user_category_assignments
  for all to authenticated
  using (
    -- Which rows a member may change or remove: 0140's, unchanged.
    ( select public.has_org_role(user_category_assignments.organization_id, 'manager') )
  )
  with check (
    -- CONJUNCT 1 of 2: a manager of the assignment's organization (0140).
    ( select public.has_org_role(user_category_assignments.organization_id, 'manager') )

    -- CONJUNCT 2 of 2: the category is the assignment's organization's, for
    -- every rank.
    and ( select public.category_in_org(user_category_assignments.category_id, user_category_assignments.organization_id) )
  );

-- ═══ 4. set_user_category_access ═══════════════════════════════════════════
-- 0129's body, with the category check added before anything changes.
create or replace function public.set_user_category_access(
  p_org_id        uuid,
  p_user_id       uuid,
  p_caller_id     uuid,
  p_category_ids  uuid[]
) returns void
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  -- Authorization is enforced at the service layer (assertPermission),
  -- but defense in depth: caller must be manager+ in THIS org.
  if not public.has_org_role(p_org_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Target user must be a member of THIS org.
  if not exists (
    select 1 from public.organization_members
    where user_id = p_user_id
      and organization_id = p_org_id
  ) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  -- Every category given is THIS org's (the rule's category_in_org term;
  -- this body runs past the rules).
  if exists (
    select 1 from unnest(p_category_ids) as c(id)
    where not public.category_in_org(c.id, p_org_id)
  ) then
    raise exception 'A category is not part of this organization.' using errcode = '42501';
  end if;

  -- Atomic replace.
  delete from public.user_category_assignments
  where user_id = p_user_id and organization_id = p_org_id;

  if p_category_ids is not null and array_length(p_category_ids, 1) > 0 then
    insert into public.user_category_assignments
      (organization_id, user_id, category_id, assigned_by)
    select p_org_id, p_user_id, unnest(p_category_ids), p_caller_id;
  end if;
end;
$$;

-- EXECUTE as 0129 left it (authenticated, service_role; not PUBLIC or anon).
revoke all on function public.set_user_category_access(uuid, uuid, uuid, uuid[]) from public, anon;
grant execute on function public.set_user_category_access(uuid, uuid, uuid, uuid[]) to authenticated, service_role;

-- ═══ 5. tg_organization_id_fixed ════════════════════════════════════════════
-- Modelled on tg_bundles_guard (0415) and tg_pin_product_group_org (0300).
-- TG_ARGV[0] names the row in the message ('warehouse', 'location', 'bin',
-- 'category').
create function public.tg_organization_id_fixed()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- See tg_ledger_only_guard for why only the API roles are checked.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if new.organization_id is distinct from old.organization_id then
    raise exception 'A % cannot be moved to another organization.', tg_argv[0]
      using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Grants: no role needs EXECUTE. A trigger function fires without it, and
-- none of the API roles may call it.
revoke all on function public.tg_organization_id_fixed() from public, anon, authenticated, service_role;

-- No column list: a change made by an earlier BEFORE trigger is still seen
-- (the WHEN is evaluated just before the function would run). The tables'
-- other BEFORE UPDATE triggers (tg_set_updated_at) never change
-- organization_id, so their order with this one does not matter.
create trigger trg_zz_warehouses_organization_fixed
  before update on public.warehouses
  for each row
  when (new.organization_id is distinct from old.organization_id)
  execute function public.tg_organization_id_fixed('warehouse');

create trigger trg_zz_locations_organization_fixed
  before update on public.locations
  for each row
  when (new.organization_id is distinct from old.organization_id)
  execute function public.tg_organization_id_fixed('location');

create trigger trg_zz_bins_organization_fixed
  before update on public.bins
  for each row
  when (new.organization_id is distinct from old.organization_id)
  execute function public.tg_organization_id_fixed('bin');

create trigger trg_zz_categories_organization_fixed
  before update on public.categories
  for each row
  when (new.organization_id is distinct from old.organization_id)
  execute function public.tg_organization_id_fixed('category');

-- ═══ 6. Comments ════════════════════════════════════════════════════════════
-- None of the texts names this file's number, so a rename leaves them (and
-- the md5s the test pins) alone.
comment on policy inventory_stock_write on public.inventory_stock is
  'A staff member of the row''s organization writes its per-bin stock rows; the row''s warehouse, bin and item are its '
  'own organization''s (warehouse_in_org, bin_in_org and item_in_org, for every rank).';

comment on policy putaway_moves_write on public.putaway_moves is
  'A staff member of the row''s organization writes its put-away rows; the row''s warehouse, item and source and '
  'destination bins are its own organization''s (warehouse_in_org, item_in_org and bin_in_org, for every rank).';

comment on policy categories_insert on public.categories is
  'A manager, or a member with categories:manage, adds a category of their organization; its parent category is its '
  'own organization''s or none (category_in_org, for every rank).';

comment on policy categories_update on public.categories is
  'A manager, or a member with categories:manage, changes a category of their organization; the changed category keeps '
  'a parent of its own organization or none (category_in_org, for every rank).';

comment on policy user_category_assignments_write on public.user_category_assignments is
  'A manager of the assignment''s organization adds, changes and removes category assignments; the category is the '
  'assignment''s own organization''s (category_in_org, for every rank).';

comment on function public.bin_in_org(uuid, uuid) is
  'NULL-safe: true when p_bin_id is NULL or names a bin of p_org_id. SECURITY DEFINER so a write rule can ask it '
  'whatever bins the writer may read; executable by authenticated and service_role.';

comment on function public.set_user_category_access(uuid, uuid, uuid, uuid[]) is
  'Replaces a member''s category assignments in one transaction (delete then insert). The caller is a manager of '
  'p_org_id, the member belongs to it, and every category given is its own (42501 "A category is not part of this '
  'organization." otherwise, nothing changed).';

comment on function public.tg_organization_id_fixed() is
  'BEFORE UPDATE guard on warehouses, locations, bins and categories (WHEN organization_id changes): for an API role '
  'the row''s organization never changes (42501). service_role, SECURITY DEFINER bodies and foreign key actions are not held. '
  'SECURITY INVOKER on purpose (a DEFINER trigger sees postgres and never enforces).';

reset lock_timeout;
