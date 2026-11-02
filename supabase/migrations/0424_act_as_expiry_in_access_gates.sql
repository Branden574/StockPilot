-- Act-as seat expiry in the access gates, and the maintenance write rule
-- (docket item S47).
--
-- An expired "act as" seat no longer passes the two subject-scoped access
-- gates or their two sibling helpers, ledger._seal's warehouse arm agrees
-- with them, the maintenance guard's cancel check gives a definite answer
-- when the request's requester was deleted, and a maintenance request and
-- its photo rows change, through the Data API, only for a holder of
-- maintenance_requests:manage or the request's own requester. DB-only: no
-- row is written, and no table, view, sequence or policy is created or
-- changed. One function and its trigger are new (the photo guard, 5), with
-- EXECUTE for service_role only.
--
-- ── WHAT WAS WRONG ─────────────────────────────────────────────────────────
--   1. An act-as seat is a platform admin's temporary owner membership: an
--      organization_members row whose impersonation_expires_at is 45 minutes
--      after it started. 0177 made its expiry a database rule ("the sweep
--      becomes pure cleanup, not the security boundary"), and 0310 restated
--      the fifteen membership helpers with the disable check; eleven of them
--      also test the expiry. Four did not: user_can_access_warehouse and
--      user_can_access_inventory (their member CTEs tested accepted_at and
--      disabled_at only), my_warehouse_ids and user_can_see_item_category.
--      So from the moment a seat expired until the sweep deleted its row
--      (the drain cron, every 10 minutes, skips the sweep when the drain
--      throws, and a failed delete is never retried), the admin's own
--      still-valid token, sent straight to the Data API, could:
--        - read the organization's rentals and rental lines, borrower names
--          and emails included (rentals_select and rental_lines_select gate
--          on user_can_access_warehouse alone; rentals is in the realtime
--          publication, so a subscription got the same rows);
--        - claim an unclaimed pick (claim_picking's only gate is
--          user_can_access_inventory), record picked quantities on an
--          unclaimed or self-claimed order, and release its own claim;
--        - complete a pick that draws nothing (its own claim with every line
--          picked 0, or a one-click completion of an order whose item has
--          none): complete_picking's only membership gate is the same
--          helper, so the order moved to picking_complete stamped with the
--          seat and every stock hold of the order was released. A
--          completion that draws stock was refused (ledger.adjust_stock's
--          staff floor), so no stock moved.
--      A real approver could also assign a pick to the expired seat
--      (assign_picking checks its target with user_can_access_inventory).
--      The app was never affected: it drops a workspace the moment its seat
--      expires (is_org_member, get_request_context and withApiContext all
--      refuse it).
--   2. ledger._seal restates user_can_access_warehouse for a draw's
--      warehouse arm (0373: "accepted, not disabled, no impersonation
--      filter"); its manager and organization arms test the expiry. Changing
--      the helper alone would make _seal record in_scope where the live
--      predicate (caller_can_write_location) says out_of_scope (pgTAP 0373
--      S3).
--   3. tg_maintenance_requests_guard's cancel arm was
--        if not (v_manage or old.requester_user_id = v_uid) then
--      requester_user_id is set null when the requester deletes their
--      account (ON DELETE SET NULL, 0314), and v_manage (has_permission) is
--      never null, so for a caller without maintenance_requests:manage the
--      condition was NULL and the IF did not raise. An admin or manager whose
--      manage permission is switched off, who still reads every request
--      (read_all) and passes the update policy by role, could cancel such a
--      request for good with a direct Data API call (the app refuses them
--      before it writes).
--   4. The same admin or manager could change every other part of any open
--      request, and add or delete photo rows on it. maintenance_requests_update
--      and maintenance_request_attachments_insert/_delete (0317) admit a
--      manager by role, `or (select public.has_org_role(organization_id,
--      'manager'))`, whatever the permission says, and the guard limited only
--      resolving, cancelling, archiving and the local owner to the
--      permission, so the subject, description, priority, category, place
--      fields and links of another member's request, or of one whose
--      requester was deleted, stayed open. The app's rule is manage or the
--      request's own requester: MaintenanceRequestsService.update and
--      recordDraftOpened refuse anyone else ("Not your request."), and so does
--      the photo upload (MaintenanceAttachmentsService.assertParentOwnedAndOpen).
--      Its photo remove() has no check of its own and relies on the delete
--      policy, so such a manager's Remove went through in the app too. A
--      role_permission_overrides row switching manage off for the whole
--      manager role left every manager in that state.
--
-- ── WHAT THIS MIGRATION DOES ───────────────────────────────────────────────
--   Six CREATE OR REPLACE FUNCTION statements, each copied byte for byte
--   from the function's live definition with ONE line added or changed,
--   tagged '-- S47' (the guard has one changed line and one added block of
--   four, every line tagged). The tag names the docket item, never this
--   file's number, so a renumber at push time moves no body pin, and taking
--   the tagged lines out (in the guard, putting the old cancel condition
--   back) gives production's body exactly (pgTAP R1).
--   1. public.user_can_access_warehouse and public.user_can_access_inventory
--      (0310): the member CTE also requires
--        (m.impersonation_expires_at is null or m.impersonation_expires_at > now())
--      the term the eleven other helpers carry. Both answer about the
--      SUBJECT, so the answer is the same whoever asks.
--   2. public.my_warehouse_ids and public.user_can_see_item_category (0310):
--      the same term in their membership lookup. No caller reaches them
--      alone today (each also asks an expiry-aware helper), but 0310's rule
--      is that a function whose own body reads a membership table is guarded
--      itself, and recurring pattern 26 is to fix every copy
--      (rls_exc_holding_location_ids follows my_warehouse_ids).
--   3. ledger._seal (0373; "create function" becomes "create or replace
--      function", still SECURITY INVOKER with no SET clause): the warehouse
--      arm gets the term, with pg_catalog.now() like its other two arms.
--   4. public.tg_maintenance_requests_guard (0362): the cancel arm becomes
--        if not (v_manage or coalesce(old.requester_user_id = v_uid, false)) then
--      a definite answer whichever side is null. (The explicit
--      "old.requester_user_id is not null and old.requester_user_id = v_uid"
--      is still NULL when v_uid is null.) And the UPDATE path ends with the
--      same condition for every change, refused with 42501 'Only the
--      requester or a maintenance manager can change a request.': after the
--      arms above, so the resolve, cancel, archive and local owner refusals
--      keep their own words. Every API writer already meets it (the service
--      checks manage or the requester before each write); the service role,
--      SECURITY DEFINER callers and foreign key actions are not API roles
--      and skip the guard as before.
--   5. A new BEFORE INSERT OR DELETE trigger on
--      public.maintenance_request_attachments,
--      trg_maintenance_request_attachments_guard, and its SECURITY INVOKER
--      function public.tg_maintenance_request_attachments_guard(): an API
--      role adds or deletes a photo row only with maintenance_requests:manage
--      or as the request's own requester, else 42501. The policies stay as
--      they are: they hold every other condition (the request open, the
--      uploader the caller, the module on, 'resolution' photos for manage),
--      and a policy statement would take ACCESS EXCLUSIVE on the table and,
--      through supautils' policy_grants, on every table that setting lists
--      (on the local stack: auth.users, auth.sessions, storage.objects and
--      20 more auth, storage and realtime tables, held to commit, so sign-ins
--      and file reads would wait). EXECUTE is revoked from public, anon and
--      authenticated and granted to service_role, as on the guard (a trigger
--      function is never an RPC). Docket S9's migration (open when this was
--      written) revokes INSERT on the table from anon and authenticated and
--      drops the insert policy; once it is applied the privilege refuses a
--      member's insert before this trigger runs, and the delete arm is what
--      still answers maintenance_request_attachments_delete's role arm.
--   Five COMMENT ON FUNCTION statements: the two helpers say they are
--   expiry-aware since S47 (and user_can_access_inventory's no longer says
--   the picking functions are its only callers), the guard's adds the new
--   rule, the photo guard's is new, and _seal's pin clause names this file's
--   preflight. my_warehouse_ids keeps 0322's comment and
--   user_can_see_item_category has none.
--   Signature, result, volatility, SECURITY mode, SET clause, owner and
--   EXECUTE are unchanged for the six restated functions (CREATE OR REPLACE
--   keeps the owner and the grants), and nothing else changes.
--
-- Only an expired seat's answers change. A live seat keeps its owner access
-- for its 45 minutes, by design, and every real membership has
-- impersonation_expires_at null, so all six functions answer real members as
-- before. now() is the transaction's start time, as in the other helpers: a
-- request that began before the expiry finishes on the old answer. _seal's
-- per-transaction cache needs no change (the forget trigger on
-- organization_members clears it, and now() is fixed within a transaction).
--
-- ORDER: push AFTER 0418 (docket S36a, PR #440), never before it. Its
-- preflight pins user_can_access_warehouse's md5(prosrc) 76b4170f and
-- refuses (55000, nothing applied) once that body has changed. This file's
-- preflight pins the same pre-S47 body, so it also refuses to run anywhere
-- the six functions are not exactly production's. The number is
-- provisional: it is assigned when this migration's kit starts (never below
-- 0419), and the three COMMENT texts that name it change with the rename.
--
-- WHO CHANGES TODAY: platform admins only, through the Data API or a
-- realtime subscription in the minutes between a seat's expiry and the
-- sweep; and an admin or manager whose maintenance_requests:manage is
-- switched off (a user or a role override), who can no longer cancel,
-- change, or add or delete photos on a maintenance request that is not
-- their own (the app already refuses all of it but the photo Remove). In
-- the app, choosing an expired, unswept seat as a picker now gets the app's
-- existing "That user is not an active member of this organization.", and
-- such a manager's Remove on another member's photo now ends in the photo
-- panel's existing "Could not remove the photo." (the route answers 500
-- internal_error with its generic text). The release steps count,
-- read-only, before the push: seats past expiry, orphaned seats, picks
-- claimed or completed by a seat, open requests with no requester, manage
-- overrides switched off (user and role).
--
-- ── LOCKS ──────────────────────────────────────────────────────────────────
-- The preflight reads catalogs only. The three SQL-language bodies
-- (user_can_access_warehouse, user_can_access_inventory, my_warehouse_ids)
-- are parsed when created, which takes AccessShareLock on public.warehouses,
-- organization_members, user_profiles and user_warehouse_assignments until
-- commit. AccessShareLock conflicts only with ACCESS EXCLUSIVE: no read,
-- write, row lock or autovacuum waits for it. The four plpgsql bodies are
-- checked for syntax only and lock no table. CREATE TRIGGER holds SHARE ROW
-- EXCLUSIVE on public.maintenance_request_attachments to commit: reads go
-- on, a photo row insert or delete waits for the few milliseconds left of
-- the file, and the file waits for one already running (a single-row
-- statement). Each COMMENT holds a ShareUpdateExclusiveLock on its function
-- to commit (only other DDL on the same function waits), and the photo
-- guard's REVOKE and GRANT hold AccessShareLock on the roles they name
-- (anon, authenticated, service_role, and postgres as the grantor), so only
-- DDL on those roles would wait. A call already
-- running finishes on the body it started with, and a call takes no lock on
-- the function. Only an ACCESS EXCLUSIVE on one of the four tables, or a
-- write lock on maintenance_request_attachments, held or queued, makes the
-- file wait; lock_timeout 900ms then ends it with 55P03 and nothing
-- applied, and the push can simply be run again. The lock footprint script
-- that carries this migration's number in scripts/db-concurrency/ checks
-- each of these.
--
-- DATA SAFETY: no row changes. The CLI applies the file as one transaction.
--
-- ERRORS: the push raises 55000 (hint s47_preflight: drift, nothing applied)
-- or 55P03 (busy: nothing applied). An expired seat meets the refusals a
-- non-member already meets (42501 from the picking functions, P0001
-- invalid_picker from assign_picking). The guard's refusals are 42501: its
-- 'Only the requester or a maintenance manager can cancel a request.' and
-- the new 'Only the requester or a maintenance manager can change a
-- request.'; the photo guard's is 42501 'Only the requester or a
-- maintenance manager can add or remove a request's photos.' Never 40001
-- or 40P01 (PostgREST retries those forever, 0367).
--
-- ROLLBACK (the owner's call only): a forward migration restoring the six
-- pre-S47 bodies (removing the S47 lines gives them exactly, pgTAP R1),
-- the 0312, 0362 and 0373 comments, and dropping
-- trg_maintenance_request_attachments_guard and its function.

set lock_timeout = '900ms';

-- ═══ 0. Preflight ══════════════════════════════════════════════════════════
-- Each restated body must be the exact live text and header it was built
-- from, the three predicates ledger._seal mirrors and this file leaves alone
-- must be the ones it was proven against, organization_members must still be
-- unique on (organization_id, user_id) (the 0373 preflight's check:
-- has_org_role's `limit 1` row is the only row), and the photo guard's
-- function and trigger names must be free. Anything else is drift, or a
-- second run: stop before changing anything. The result type is compared by
-- type, not by its printed name, so the session's search_path cannot change
-- the answer.
do $pre_s47$
declare
  v_bad text := '';
  r record;
begin
  for r in
    select v.sig, v.want_src, v.want_secdef, v.want_vol, v.want_cfg, p.oid as poid,
           md5(p.prosrc) as got_src, p.prosecdef as got_secdef, p.provolatile::text as got_vol,
           coalesce(array_to_string(p.proconfig, ';'), '') as got_cfg,
           (p.prorettype = to_regtype(v.want_ret) and p.proretset = v.want_set) as got_ret_ok,
           format_type(p.prorettype, null) || case when p.proretset then ' (set)' else '' end as got_ret,
           pg_get_userbyid(p.proowner) as got_owner,
           p.proisstrict as got_strict, p.proleakproof as got_leak, p.proparallel::text as got_par
      from (values
        ('public.user_can_access_warehouse(uuid,uuid,text)',                     '76b4170f3d393e8a1f293ca3d4895955', true,  's', 'search_path=public', 'boolean',           false),
        ('public.user_can_access_inventory(uuid,uuid,uuid,text)',                '8a214b77e32a052ca3bf07a2be39a8ae', true,  's', 'search_path=public', 'boolean',           false),
        ('public.my_warehouse_ids()',                                            '7129bb768bce52a1ec1271be95afdffc', true,  's', 'search_path=public', 'uuid',              true),
        ('public.user_can_see_item_category(uuid,uuid,uuid)',                    'e6d071a182bc309168347d7c7127379e', true,  's', 'search_path=public', 'boolean',           false),
        ('ledger._seal(uuid,uuid,uuid,text,public.stock_draw_holding[],uuid[])', '1e6756966568825045ba05805e87d395', false, 'v', '',                   'public.stock_draw', false),
        ('public.tg_maintenance_requests_guard()',                               '6605c3607f283e2c3ab025d044da04c0', false, 'v', 'search_path=public', 'trigger',           false),
        ('public.has_org_role(uuid,text)',                                       '10422b29a6e15acd003d4f11ed28e90c', true,  's', 'search_path=public', 'boolean',           false),
        ('public.is_org_member(uuid)',                                           '76492a6556e9f6a7c33d942aa9726f9f', true,  's', 'search_path=public', 'boolean',           false),
        ('public.caller_can_write_location(uuid)',                               '188634bf8552a0064bfbf1ebfecf814f', true,  's', 'search_path=public', 'boolean',           false)
      ) v(sig, want_src, want_secdef, want_vol, want_cfg, want_ret, want_set)
      left join pg_proc p on p.oid = to_regprocedure(v.sig)
  loop
    if r.poid is null then
      v_bad := v_bad || format(' %s missing;', r.sig);
    elsif r.got_src <> r.want_src or r.got_secdef <> r.want_secdef or r.got_vol <> r.want_vol
          or r.got_cfg <> r.want_cfg or not r.got_ret_ok or r.got_owner <> 'postgres'
          or r.got_strict or r.got_leak or r.got_par <> 'u' then
      v_bad := v_bad || format(' %s drifted (md5 %s, definer %s, volatility %s, %s, returns %s, owner %s, strict %s, leakproof %s, parallel %s);',
                               r.sig, r.got_src, r.got_secdef, r.got_vol, r.got_cfg, r.got_ret, r.got_owner,
                               r.got_strict, r.got_leak, r.got_par);
    end if;
  end loop;
  if not exists (select 1 from pg_constraint c
                  where c.conrelid = 'public.organization_members'::regclass and c.contype in ('u', 'p')
                    and (select array_agg(a.attname::text order by a.attname) from unnest(c.conkey) k(attnum)
                           join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum)
                        = array['organization_id', 'user_id']) then
    v_bad := v_bad || ' organization_members is no longer unique on (organization_id, user_id);';
  end if;
  -- The two names section 5 creates must be free.
  if to_regprocedure('public.tg_maintenance_request_attachments_guard()') is not null then
    v_bad := v_bad || ' public.tg_maintenance_request_attachments_guard() exists;';
  end if;
  if exists (select 1 from pg_trigger t
              where t.tgrelid = 'public.maintenance_request_attachments'::regclass
                and t.tgname = 'trg_maintenance_request_attachments_guard') then
    v_bad := v_bad || ' trg_maintenance_request_attachments_guard exists;';
  end if;
  if v_bad <> '' then
    raise exception 's47_preflight:%', v_bad
      using errcode = '55000', hint = 's47_preflight';
  end if;
end
$pre_s47$;

-- ═══ 1. The two subject-scoped gates ══════════════════════════════════════
-- 1a. user_can_access_warehouse: restated from 0310_rls_blocks_disabled_accounts.sql;
-- md5(prosrc) 76b4170f3d393e8a1f293ca3d4895955 -> c3e618bb3c05d227e1f61686e5a1848f.
-- The sole gate of rentals_select and rental_lines_select.
create or replace function public.user_can_access_warehouse(
  p_user_id uuid,
  p_warehouse_id uuid,
  p_op text default 'read'
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with wh as (
    select organization_id from public.warehouses where id = p_warehouse_id
  ),
  member as (
    select m.role
    from public.organization_members m, wh
    where m.user_id = p_user_id
      and m.organization_id = wh.organization_id
      and m.accepted_at is not null
      and (m.impersonation_expires_at is null or m.impersonation_expires_at > now())  -- S47
      and not exists (
        select 1 from public.user_profiles up
        where up.id = p_user_id and up.disabled_at is not null
      )
    limit 1
  )
  select case
    -- super admin + manager: full access
    when (select role from member) in ('owner', 'admin', 'manager') then true
    -- staff/viewer: must be assigned, and viewer can only read
    when (select role from member) = 'staff' and exists (
      select 1 from public.user_warehouse_assignments
      where user_id = p_user_id and warehouse_id = p_warehouse_id
    ) then true
    when (select role from member) = 'viewer' and p_op = 'read' and exists (
      select 1 from public.user_warehouse_assignments
      where user_id = p_user_id and warehouse_id = p_warehouse_id
    ) then true
    else false
  end;
$$;

-- 1b. user_can_access_inventory: restated from 0310_rls_blocks_disabled_accounts.sql;
-- md5(prosrc) 8a214b77e32a052ca3bf07a2be39a8ae -> f80f6ad98ba24e160661117f2c146091.
-- The first gate of claim_picking, partial_pick_line, release_picking and
-- complete_picking, and assign_picking's check of its target.
create or replace function public.user_can_access_inventory(
  p_user_id      uuid,
  p_warehouse_id uuid,
  p_charter_id   uuid,
  p_op           text default 'read'
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with wh as (
    select organization_id from public.warehouses where id = p_warehouse_id
  ),
  member as (
    select m.role
    from public.organization_members m
    join wh on wh.organization_id = m.organization_id
    where m.user_id = p_user_id
      and m.accepted_at is not null
      and (m.impersonation_expires_at is null or m.impersonation_expires_at > now())  -- S47
      and not exists (
        select 1 from public.user_profiles up
        where up.id = p_user_id and up.disabled_at is not null
      )
  )
  select
    -- Manager+ has full access
    exists (select 1 from member where role in ('owner', 'admin', 'manager'))
    or exists (
      select 1
      from public.user_warehouse_assignments uwa
      join member on true
      where uwa.user_id = p_user_id
        and uwa.warehouse_id = p_warehouse_id
        and (
              uwa.charter_id is null
           or p_charter_id is null
           or uwa.charter_id = p_charter_id
        )
        and (p_op = 'read' or member.role <> 'viewer')
    );
$$;

-- ═══ 2. The two sibling helpers ═══════════════════════════════════════════
-- 2a. my_warehouse_ids: restated from 0310_rls_blocks_disabled_accounts.sql;
-- md5(prosrc) 7129bb768bce52a1ec1271be95afdffc -> eacc28d3bd2d1ebd09242f61b8a094ad.
create or replace function public.my_warehouse_ids()
returns table(warehouse_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  with my_role as (
    select organization_id, role
    from public.organization_members
    where user_id = auth.uid()
      and accepted_at is not null
      and (impersonation_expires_at is null or impersonation_expires_at > now())  -- S47
      and not public.account_is_disabled(auth.uid())
  )
  -- super_admin / manager: every warehouse in their org(s)
  select w.id
  from public.warehouses w
  join my_role mr on mr.organization_id = w.organization_id
  where mr.role in ('owner', 'admin', 'manager')
  union
  -- staff / viewer: only assigned warehouses
  select uwa.warehouse_id
  from public.user_warehouse_assignments uwa
  join my_role mr on mr.organization_id = uwa.organization_id
  where uwa.user_id = auth.uid()
    and mr.role in ('staff', 'viewer');
$$;

-- 2b. user_can_see_item_category: restated from 0310_rls_blocks_disabled_accounts.sql;
-- md5(prosrc) e6d071a182bc309168347d7c7127379e -> e7ba372ee91b3785afe872c685cc583e.
create or replace function public.user_can_see_item_category(
  p_user_id uuid,
  p_org_id uuid,
  p_category_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  -- Resolve the user's role IN THIS SPECIFIC ORG.
  -- accepted_at IS NOT NULL excludes pending invites — same gate
  -- has_org_role uses (migration 0001).
  select role::text into v_role
  from public.organization_members
  where user_id = p_user_id
    and organization_id = p_org_id
    and accepted_at is not null
    and (impersonation_expires_at is null or impersonation_expires_at > now())  -- S47
    and not exists (
      select 1 from public.user_profiles up
      where up.id = p_user_id and up.disabled_at is not null
    )
  limit 1;

  if v_role is null then
    return false;
  end if;

  if v_role in ('owner','admin','manager','staff') then
    return true;
  end if;

  -- viewer branch
  if v_role = 'viewer' then
    -- Unrestricted if zero assignments IN THIS ORG.
    if not exists (
      select 1 from public.user_category_assignments
      where user_id = p_user_id
        and organization_id = p_org_id
    ) then
      return true;
    end if;

    -- Restricted: null-category items are never visible.
    if p_category_id is null then
      return false;
    end if;

    return exists (
      select 1 from public.user_category_assignments
      where user_id = p_user_id
        and organization_id = p_org_id
        and category_id = p_category_id
    );
  end if;

  return false;
end;
$$;

-- ═══ 3. ledger._seal's warehouse arm ══════════════════════════════════════
-- Restated from 0373_draw_provenance.sql; md5(prosrc)
-- 1e6756966568825045ba05805e87d395 -> fc7686f95039a82b840c43372f01f850. The warehouse arm
-- restates user_can_access_warehouse(drawer, warehouse, 'write') and now
-- tests the expiry as the helper does; the manager and organization arms
-- already did. The ACL (0373: no role but its owner) is kept.
create or replace function ledger._seal(
  p_uid  uuid,
  p_org  uuid,
  p_wh   uuid,
  p_mode text,
  p_h    public.stock_draw_holding[],
  p_o    uuid[]
)
returns public.stock_draw
language plpgsql
security invoker
as $function$
declare
  v_head pg_catalog.text;
  v_c    pg_catalog.text;
  v_key  pg_catalog.text;
  v_p    pg_catalog.int4;
  v_a    pg_catalog.text;
  v_lorg pg_catalog.uuid;
  v_lwh  pg_catalog.uuid;
  i      pg_catalog.int4;
begin
  if p_uid is null then
    return row(p_mode, p_wh, 'service', p_h)::public.stock_draw;
  end if;
  v_head := pg_catalog.pg_current_xact_id()::pg_catalog.text || '/' || p_uid::pg_catalog.text || '/'
            || coalesce(p_org::pg_catalog.text, '-') || '|';
  v_c := pg_catalog.current_setting('stockpilot.draw_scope', true);
  if v_c is null or not pg_catalog.starts_with(v_c, v_head) then
    select v_head
           || case when exists (
                select 1 from public.organization_members m
                 where m.organization_id = p_org and m.user_id = p_uid
                   and m.accepted_at is not null
                   and (m.impersonation_expires_at is null or m.impersonation_expires_at > pg_catalog.now())
                   and m.role in ('owner', 'admin', 'manager')
                   and not exists (select 1 from public.user_profiles up
                                    where up.id = m.user_id and up.disabled_at is not null))
              then 'M' else 'S' end
           || '|'
      into v_c;
    perform pg_catalog.set_config('stockpilot.draw_scope', v_c, true);
  end if;
  if pg_catalog.substr(v_c, pg_catalog.length(v_head) + 1, 1) = 'M' then
    return row(p_mode, p_wh, 'manager', p_h)::public.stock_draw;
  end if;

  for i in 1 .. pg_catalog.cardinality(p_h) loop
    if p_o[i] is null then
      v_key := '|l:' || coalesce(p_h[i].location_id::pg_catalog.text, '-') || '=';
    else
      v_key := '|p:' || p_o[i]::pg_catalog.text || '/'
               || coalesce(p_h[i].location_warehouse_id::pg_catalog.text, '-') || '=';
    end if;
    v_p := pg_catalog.strpos(v_c, v_key);
    if v_p = 0 then
      if p_o[i] is null then
        select l.organization_id, l.warehouse_id into v_lorg, v_lwh
          from public.locations l where l.id = p_h[i].location_id;
      else
        v_lorg := p_o[i];
        v_lwh  := p_h[i].location_warehouse_id;
      end if;
      select case
               when v_lorg is null then 'O'
               when not exists (
                 select 1 from public.organization_members m
                  where m.organization_id = v_lorg and m.user_id = p_uid
                    and m.accepted_at is not null
                    and (m.impersonation_expires_at is null or m.impersonation_expires_at > pg_catalog.now())
                    and not exists (select 1 from public.user_profiles up
                                     where up.id = m.user_id and up.disabled_at is not null)) then 'O'
               when v_lwh is null then 'I'
               when exists (
                 select 1 from public.warehouses w
                   join public.organization_members m on m.organization_id = w.organization_id
                  where w.id = v_lwh and m.user_id = p_uid
                    and m.accepted_at is not null
                    and (m.impersonation_expires_at is null or m.impersonation_expires_at > pg_catalog.now())  -- S47
                    and not exists (select 1 from public.user_profiles up
                                     where up.id = p_uid and up.disabled_at is not null)
                    and (m.role in ('owner', 'admin', 'manager')
                         or (m.role = 'staff'
                             and exists (select 1 from public.user_warehouse_assignments a
                                          where a.user_id = p_uid and a.warehouse_id = v_lwh)))) then 'I'
               else 'O'
             end
        into v_a;
      v_c := v_c || pg_catalog.substr(v_key, 2) || v_a || '|';
      perform pg_catalog.set_config('stockpilot.draw_scope', v_c, true);
    else
      v_a := pg_catalog.substr(v_c, v_p + pg_catalog.length(v_key), 1);
    end if;
    p_h[i].actor_scope := case v_a when 'I' then 'in_scope' else 'out_of_scope' end;
  end loop;
  return row(p_mode, p_wh, null, p_h)::public.stock_draw;
end;
$function$;

-- ═══ 4. The maintenance guard: the cancel arm and the write rule ══════════
-- Restated from 0362_maintenance_request_guard.sql; md5(prosrc)
-- 6605c3607f283e2c3ab025d044da04c0 -> 276cf27bfc1f122b7604a17b4555b357. The cancel arm's
-- condition changes, and four tagged lines at the end of the UPDATE path
-- refuse any other change by an API role that holds neither
-- maintenance_requests:manage nor the request (the service's rule for update
-- and draft-open). The trigger (trg_aa_maintenance_requests_guard, BEFORE
-- INSERT OR UPDATE FOR EACH ROW) is untouched.
create or replace function public.tg_maintenance_requests_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_manage   boolean;
  v_name     text;
  v_email    text;
  v_resolving  boolean;
  v_cancelling boolean;
  v_archiving  boolean;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.request_number is not null then
      raise exception 'Request numbers are assigned by the database.'
        using errcode = '42501';
    end if;
    if new.status is distinct from 'saved'
       or new.resolved_at is not null or new.resolved_by is not null
       or new.resolved_by_name_snapshot is not null or new.resolution_note is not null
       or new.cancelled_at is not null or new.archived_at is not null
       or new.local_owner_user_id is not null
       or new.outlook_draft_opened_at is not null
       or coalesce(new.outlook_draft_open_count, 0) <> 0
       or new.resolution_email_sent_at is not null or new.draft_reminder_sent_at is not null then
      raise exception 'A new maintenance request starts open and unassigned.'
        using errcode = '42501';
    end if;
    select c.full_name, c.email into v_name, v_email from public.caller_profile_name_email() c;
    new.requester_name_snapshot := coalesce(v_name, v_email, 'Unknown requester');
    new.requester_email_snapshot := v_email;
    -- When it was submitted is the database's to say (the MR-YYYY handle, the
    -- email's "Submitted" line and list order all read it).
    new.created_at := now();
    new.updated_at := now();
    if not (public.charter_in_org(new.charter_id, new.organization_id)
            and public.warehouse_in_org(new.warehouse_id, new.organization_id)
            and public.item_in_org(new.related_item_id, new.organization_id)
            and public.location_in_org(new.related_location_id, new.organization_id)
            and public.order_request_in_org(new.related_order_request_id, new.organization_id)
            and public.rental_in_org(new.related_rental_id, new.organization_id)) then
      raise exception 'A linked record is not part of this organization.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- UPDATE ------------------------------------------------------------------
  if new.organization_id is distinct from old.organization_id
     or new.request_number is distinct from old.request_number
     or new.requester_user_id is distinct from old.requester_user_id
     or new.created_at is distinct from old.created_at
     or new.requester_name_snapshot is distinct from old.requester_name_snapshot
     or new.requester_email_snapshot is distinct from old.requester_email_snapshot
     or new.resolution_email_sent_at is distinct from old.resolution_email_sent_at
     or new.draft_reminder_sent_at is distinct from old.draft_reminder_sent_at then
    raise exception 'That part of a maintenance request cannot be changed.'
      using errcode = '42501';
  end if;

  -- Only references this update CHANGES are checked, so a row that predates
  -- the guard can still be resolved, cancelled or archived as it stands.
  if (new.charter_id is distinct from old.charter_id
        and not public.charter_in_org(new.charter_id, new.organization_id))
     or (new.warehouse_id is distinct from old.warehouse_id
        and not public.warehouse_in_org(new.warehouse_id, new.organization_id))
     or (new.related_item_id is distinct from old.related_item_id
        and not public.item_in_org(new.related_item_id, new.organization_id))
     or (new.related_location_id is distinct from old.related_location_id
        and not public.location_in_org(new.related_location_id, new.organization_id))
     or (new.related_order_request_id is distinct from old.related_order_request_id
        and not public.order_request_in_org(new.related_order_request_id, new.organization_id))
     or (new.related_rental_id is distinct from old.related_rental_id
        and not public.rental_in_org(new.related_rental_id, new.organization_id)) then
    raise exception 'A linked record is not part of this organization.'
      using errcode = '42501';
  end if;

  v_manage := public.has_permission(new.organization_id, 'maintenance_requests:manage');

  -- Closed-state stamps are history: set once, never cleared or rewritten.
  if (old.resolved_at is not null
      and (new.resolved_at, new.resolved_by, new.resolved_by_name_snapshot, new.resolution_note)
          is distinct from (old.resolved_at, old.resolved_by, old.resolved_by_name_snapshot, old.resolution_note))
     or (old.cancelled_at is not null and new.cancelled_at is distinct from old.cancelled_at)
     or (old.archived_at is not null and new.archived_at is distinct from old.archived_at) then
    raise exception 'A resolved, cancelled or archived request keeps that record.'
      using errcode = '42501';
  end if;

  v_resolving  := old.resolved_at is null and new.resolved_at is not null;
  v_cancelling := old.cancelled_at is null and new.cancelled_at is not null;
  v_archiving  := old.archived_at is null and new.archived_at is not null;

  if not v_resolving and old.resolved_at is null
     and (new.resolved_by, new.resolved_by_name_snapshot, new.resolution_note)
         is distinct from (old.resolved_by, old.resolved_by_name_snapshot, old.resolution_note) then
    raise exception 'Resolution details are recorded by resolving the request.'
      using errcode = '42501';
  end if;

  if v_resolving then
    if not v_manage then
      raise exception 'Only a maintenance manager can resolve a request.'
        using errcode = '42501';
    end if;
    if old.cancelled_at is not null or old.archived_at is not null or v_cancelling or v_archiving then
      raise exception 'Only an open request can be resolved.'
        using errcode = '42501';
    end if;
    select c.full_name, c.email into v_name, v_email from public.caller_profile_name_email() c;
    new.resolved_at := now();
    new.resolved_by := v_uid;
    new.resolved_by_name_snapshot := left(coalesce(v_name, v_email, 'Unknown'), 200);
  end if;

  if v_cancelling then
    if not (v_manage or coalesce(old.requester_user_id = v_uid, false)) then  -- S47
      raise exception 'Only the requester or a maintenance manager can cancel a request.'
        using errcode = '42501';
    end if;
    if old.resolved_at is not null or old.archived_at is not null or v_resolving or v_archiving then
      raise exception 'Only an open request can be cancelled.'
        using errcode = '42501';
    end if;
    new.cancelled_at := now();
  end if;

  if v_archiving then
    if not v_manage then
      raise exception 'Only a maintenance manager can archive a request.'
        using errcode = '42501';
    end if;
    new.archived_at := now();
  end if;

  if new.local_owner_user_id is distinct from old.local_owner_user_id then
    if not v_manage then
      raise exception 'Only a maintenance manager can assign a local owner.'
        using errcode = '42501';
    end if;
    if new.local_owner_user_id is not null and not exists (
         select 1 from public.organization_members m
          where m.organization_id = new.organization_id
            and m.user_id = new.local_owner_user_id
            and m.accepted_at is not null) then
      raise exception 'That user is not an active member of this organization.'
        using errcode = '42501';
    end if;
  end if;

  if new.outlook_draft_opened_at is distinct from old.outlook_draft_opened_at
     and old.outlook_draft_opened_at is not null then
    raise exception 'The first draft-open time is kept.'
      using errcode = '42501';
  end if;
  if new.outlook_draft_open_count is distinct from old.outlook_draft_open_count
     and new.outlook_draft_open_count is distinct from coalesce(old.outlook_draft_open_count, 0) + 1 then
    raise exception 'Draft opens are counted one at a time.'
      using errcode = '42501';
  end if;

  -- Status follows the stamps.
  if new.status is distinct from old.status then
    if not (
         (new.status = 'resolved'     and v_resolving)
      or (new.status = 'cancelled'    and v_cancelling)
      or (new.status = 'archived'     and v_archiving)
      or (new.status = 'draft_opened' and old.status = 'saved')
    ) then
      raise exception 'That status change is not allowed.'
        using errcode = '42501';
    end if;
  elsif v_resolving or v_cancelling or v_archiving then
    raise exception 'That status change is not allowed.'
      using errcode = '42501';
  end if;
  if not (v_manage or coalesce(old.requester_user_id = v_uid, false)) then  -- S47
    raise exception 'Only the requester or a maintenance manager can change a request.'  -- S47
      using errcode = '42501';  -- S47
  end if;  -- S47

  return new;
end;
$$;

-- ═══ 5. The maintenance photo guard ══════════════════════════════════════
-- maintenance_request_attachments_insert and _delete (0317) admit a manager
-- by role whatever maintenance_requests:manage says. This BEFORE INSERT OR
-- DELETE trigger asks the app's rule of an API role: manage, or the
-- request's own requester (false, never NULL, when the requester was
-- deleted). The request is read as the caller, under its RLS, as the
-- policies read it. The service role, SECURITY DEFINER callers and
-- foreign key actions (a request or organization deleted) are not API roles
-- and pass. The policies keep every other condition.
create function public.tg_maintenance_request_attachments_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_org uuid;
  v_request uuid;
begin
  if current_user not in ('authenticated', 'anon') then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    v_org := old.organization_id;
    v_request := old.maintenance_request_id;
  else
    v_org := new.organization_id;
    v_request := new.maintenance_request_id;
  end if;
  if not (public.has_permission(v_org, 'maintenance_requests:manage')
          or exists (select 1 from public.maintenance_requests r
                      where r.id = v_request
                        and r.organization_id = v_org
                        and r.requester_user_id = auth.uid())) then
    raise exception 'Only the requester or a maintenance manager can add or remove a request''s photos.'
      using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function public.tg_maintenance_request_attachments_guard() from public, anon, authenticated;
grant execute on function public.tg_maintenance_request_attachments_guard() to service_role;

create trigger trg_maintenance_request_attachments_guard
  before insert or delete on public.maintenance_request_attachments
  for each row execute function public.tg_maintenance_request_attachments_guard();

-- ═══ 6. Comments ══════════════════════════════════════════════════════════
-- ledger._seal's stays the file's last statement (the footprint script's
-- check 7 holds its lock elsewhere to stop the file there).
comment on function public.user_can_access_warehouse(uuid, uuid, text) is
  'SUBJECT-scoped warehouse access gate (0007), disabled-subject-aware since '
  '0310 and expired-Act-as-seat-aware since S47 (0424). EXECUTE revoked from '
  'public/anon by 0312 to close an unauthenticated per-uuid disable oracle — '
  'every live policy that calls it is already scoped to `to authenticated`, so '
  'anon never reached these predicates through RLS either way. ledger._seal '
  'restates it for a draw''s warehouse arm (0373, with the same S47 term): '
  'change both together (pgTAP 0373 S1, S3).';

comment on function public.user_can_access_inventory(uuid, uuid, uuid, text) is
  'SUBJECT-scoped inventory access gate (0008), disabled-subject-aware since '
  '0310 and expired-Act-as-seat-aware since S47 (0424). EXECUTE revoked from '
  'public/anon by 0312 to close an unauthenticated per-uuid disable oracle — '
  'its callers (the picking, order, returns and cycle count functions, the '
  'returns API guard triggers and the returns policies, which are scoped to `to '
  'authenticated`) reach it as their definer, as authenticated or as '
  'service_role, which all keep EXECUTE, so none of them is affected.';

comment on function public.tg_maintenance_requests_guard() is
  'BEFORE INSERT OR UPDATE guard (0362): API-role maintenance requests start '
  'open and unnumbered with a profile-sourced requester snapshot; resolve, '
  'cancel, archive and owner changes follow the service''s gates; closed-state '
  'stamps are never cleared; references stay in the org. Since S47 (0424) any '
  'other change also needs maintenance_requests:manage or the request''s own '
  'requester, as in the service, whatever role the update policy admits.';

comment on function public.tg_maintenance_request_attachments_guard() is
  'BEFORE INSERT OR DELETE guard on maintenance_request_attachments (S47, '
  '0424): an API role adds or deletes a photo row only with '
  'maintenance_requests:manage or as the request''s own requester, the rule '
  'the app''s photo upload follows. The insert and delete policies (0317) also '
  'admit a manager by role whatever the permission says; this refuses that '
  'arm, and the policies keep every other condition.';

comment on function ledger._seal(uuid, uuid, uuid, text, public.stock_draw_holding[], uuid[]) is
  '0373: builds the draw a null-location stock change returns, with the '
  'drawer''s scope: service (p_uid NULL), manager (has_org_role(org, manager)) '
  'for the whole draw, else in_scope / out_of_scope per holding '
  '(caller_can_write_location of its location). Each answer is asked once per '
  'transaction per drawer and organization (and per location organization and '
  'warehouse, or per Staging location for an increment) and kept in the '
  'transaction-local setting stockpilot.draw_scope, keyed by '
  'pg_current_xact_id(); the forget triggers clear it when the transaction '
  'changes an input. A miss runs one statement restating the pinned predicates '
  '(0373 preflight, re-pinned by S47''s 0424 preflight; pgTAP 0373 S1-S4). '
  'Called only by ledger.apply_level_delta_for (SECURITY DEFINER); no API role '
  'can execute it.';

reset lock_timeout;
