-- 0453_invite_resend_and_live_location_rules.sql
--
-- Write rules follow the app's checks, part A (docket S11, slice S11-A; the
-- number is provisional and is renumbered when its turn in the queue comes).
-- Three changes, all rules, functions, one trigger and privileges. No row of
-- any table changes, and no column or table is dropped or retyped.
--
-- ── WHAT ──────────────────────────────────────────────────────────────────
-- 1. public.rls_orgs_with_module(p_module text) returns setof uuid: the
--    caller's organizations where the membership is accepted, not an expired
--    Act-as seat, is_org_member holds (0310: the account is not disabled) and
--    module_enabled holds (0354: an enabled module row, or a comped
--    organization). STABLE, SECURITY DEFINER, search_path ''. EXECUTE for
--    authenticated only. It is rls_orgs_with_permission (0279) with the
--    permission swapped for the module, so a rule asks it once per statement
--    in the hashed `organization_id in (select ...)` form. Later S11 slices
--    call it too.
-- 2. Resend on the Team page renews an open invite. TeamService.resendInvite
--    writes expires_at with the admin's own client, and organization_invites
--    had SELECT, INSERT and DELETE rules only. It now has an UPDATE rule:
--      USING      an admin of the invite's organization (the role the table's
--                 other three rules ask), and the invite is neither accepted
--                 nor revoked
--      WITH CHECK the same three terms, and the INSERT rule's two guards
--                 (warehouse_in_org, 0203; charter_in_org, 0204).
--    A revoked invite stays revoked and expired (0393 revokes the open
--    invites of a deleted account; the revoked_at term keeps an UPDATE from
--    renewing one).
--    The trigger trg_zz_organization_invites_update_pin (BEFORE UPDATE, per
--    row) pins what an UPDATE from an API member role may change: when
--    current_user is authenticated or anon, only expires_at may differ
--    (otherwise 42501; the row is compared with its expiry put back, column
--    by column in stored form, *=, so a value that compares equal but is
--    stored differently counts as a change too), and only to a time after
--    now() and no later than
--    now() + 7 days 1 hour (otherwise 22023). It keys on current_user, never
--    on auth.uid(), so the writers that run as the table owner keep working
--    while a member's claims are set: the account-deletion trigger
--    (0393:366-371, SECURITY DEFINER), the invited_by foreign key action
--    (0393), and any SECURITY DEFINER function that revokes invites. The
--    service role (acceptance marks the invite used) is not pinned. The name
--    sorts before 0393's zzz_deleted_users_upd, so it reads the row as the
--    writer sent it.
-- 3. A delivery's live point (delivery_locations) is written by the driver
--    assigned to it. The FOR ALL rule delivery_locations_write (0164) becomes
--    three rules; delivery_locations_select (0164) is unchanged and remains
--    the table's only SELECT rule (it admits every accepted member, which
--    covers everyone the staff floor of the FOR ALL rule admitted).
--      INSERT  WITH CHECK: driver_user_id is the caller; the caller is staff
--              or above in the point's organization (0164's floor, kept); the
--              live_tracking module is on there (rls_orgs_with_module); and
--              the order is a delivery of that organization, in transit,
--              assigned to the caller.
--      UPDATE  USING: the order is a delivery of the point's organization, in
--              transit and assigned to the caller, so a newly assigned driver
--              overwrites the earlier driver's point (the app's upsert on
--              order_request_id). WITH CHECK: the INSERT rule's terms.
--      DELETE  USING: staff or above in the point's organization (0164's
--              floor). The clean-ups that drop the point when an order is
--              cancelled or a return's replacement is cancelled run as the
--              member acting on the order (order-requests.ts, returns.ts);
--              the signature route uses the service client.
--    DeliveryTrackingService.shareLocation already checks the module, the
--    assigned driver and an in-transit delivery before it upserts, so no app
--    path changes.
--
--   0. Preflight: refuse (55000, hint s11a_preflight, nothing applied) unless
--      the helpers the rules call are the bodies this file was written
--      against (md5 of prosrc), SECURITY DEFINER, owned by postgres and
--      executable by authenticated (INV-C1: the rules run as the writer);
--      unless each table's rules are exactly the ones this file replaces or
--      keeps; and unless every name this file creates is free.
--   1. The lock prelude (LOCKS below).
--   2. The helper, the trigger function, the invite rule and trigger, and
--      the three live point rules, in one transaction. Every column of a
--      rule's own table is qualified (pattern 25); rules are dropped and
--      created, never altered (pattern 24).
--
-- ── LOCKS ─────────────────────────────────────────────────────────────────
-- CREATE POLICY, DROP POLICY and CREATE TRIGGER take ACCESS EXCLUSIVE (the
-- trigger SHARE ROW EXCLUSIVE) on public.organization_invites and
-- public.delivery_locations, and through supautils 3.4.0 (image 17.6.1.166)
-- ACCESS EXCLUSIVE on every existing table supautils.policy_grants lists for
-- this role: auth, storage and realtime tables, auth.users and
-- auth.sessions among them (0390, 0395, 0400, 0415, 0420). Two more tables
-- are read while the file runs, ACCESS SHARE (only a schema change conflicts
-- with it): public.organization_members, when the SQL helper's body is
-- checked, and public.order_requests, when the live point rules are parsed.
-- The preflight reads catalogs and deparses rules in a block that is always
-- undone, so it ends holding no table lock. So the prelude takes all of
-- those tables at once, NOWAIT, retrying up to 40 times with a 50 to 150 ms
-- pause that holds nothing (the 0390 to 0420 pattern), and no later
-- statement takes a new table lock: the file never waits while holding one,
-- so it cannot deadlock. From the prelude to the commit (ms), invite reads,
-- live point reads and writes, sign-ins, token refreshes, and storage and
-- realtime requests wait for the hold; order and membership reads and writes
-- do not. lock_timeout 900ms bounds anything unforeseen.
-- scripts/db-concurrency/0453_migration_lock_footprint.sh measures all of
-- this.
--
-- ── ERRORS ────────────────────────────────────────────────────────────────
-- 55000 hint s11a_preflight: drift, or a second run; nothing applied.
-- 55P03: busy after 40 attempts, or the 900 ms cap; nothing applied, run it
-- again. Never 40001 or 40P01 (PostgREST retries those, 0367).
--
-- ── ORDER ─────────────────────────────────────────────────────────────────
-- After every lower number and after the queued drafts ahead of it. None of
-- them restates, drops or pins a rule or trigger of organization_invites or
-- delivery_locations, or the body of has_org_role, is_org_member,
-- module_enabled, warehouse_in_org or charter_in_org. One queued migration
-- revokes invites from a SECURITY DEFINER trigger (member removal): it runs
-- as the table owner, so the pin leaves it alone. One revokes TRUNCATE,
-- REFERENCES, TRIGGER and MAINTAIN from the API roles on both tables; it
-- touches no rule and no trigger, so the two may go in either order.

set lock_timeout = '900ms';

-- ═══ 0. Preflight ═══════════════════════════════════════════════════════════
do $pre_s11a$
declare
  v_bad text := '';
  v_pol text;
  r     record;
begin
  -- The helpers the rules call: the bodies this file was written against,
  -- definer, owned by postgres, and executable by authenticated.
  for r in
    select v.sig, v.want, p.oid as poid, md5(p.prosrc) as got, p.prosecdef,
           pg_get_userbyid(p.proowner) as owner,
           case when p.oid is null then false else has_function_privilege('authenticated', p.oid, 'execute') end as auth_x
      from (values
        ('public.has_org_role(uuid,text)',      '10422b29a6e15acd003d4f11ed28e90c'),
        ('public.is_org_member(uuid)',          '76492a6556e9f6a7c33d942aa9726f9f'),
        ('public.module_enabled(uuid,text)',    'df3260cbcd15f986798e5377d1e95dce'),
        ('public.warehouse_in_org(uuid,uuid)',  'f2be5534bb6d64be28a9ee2dacc3d46d'),
        ('public.charter_in_org(uuid,uuid)',    'f2ac9dee2f52aa361065e07494deb83e')
      ) v(sig, want)
      left join pg_proc p on p.oid = to_regprocedure(v.sig)
  loop
    if r.poid is null then
      v_bad := v_bad || format(' %s missing;', r.sig);
    elsif r.got <> r.want or not r.prosecdef or r.owner <> 'postgres' or not r.auth_x then
      v_bad := v_bad || format(' %s drifted (md5 %s, definer %s, owner %s, authenticated %s);',
                               r.sig, r.got, r.prosecdef, r.owner, r.auth_x);
    end if;
  end loop;

  -- Every name this file creates is free (a second run stops here).
  if to_regprocedure('public.rls_orgs_with_module(text)') is not null
     or to_regprocedure('public.tg_organization_invites_update_pin()') is not null
     or exists (select 1 from pg_trigger t
                 where t.tgrelid = 'public.organization_invites'::regclass
                   and t.tgname = 'trg_zz_organization_invites_update_pin') then
    v_bad := v_bad || ' the helper, the pin function or the pin trigger already exists;';
  end if;

  -- Each table's rules are exactly the ones this file keeps or replaces.
  -- Deparsed in a block that is always undone, with search_path pinned
  -- inside it, so the text does not depend on the session's search_path and
  -- nothing the deparse locks outlives the block. Variables keep their
  -- values when the block is undone.
  for r in
    select v.tbl, v.want
      from (values
        ('public.organization_invites',
         'organization_invites_delete|d|true|authenticated'
         '|( SELECT has_org_role(organization_invites.organization_id, ''admin''::text) AS has_org_role)|-'
         || E'\n' ||
         'organization_invites_insert|a|true|authenticated|-'
         '|(( SELECT has_org_role(organization_invites.organization_id, ''admin''::text) AS has_org_role)'
         ' AND ( SELECT warehouse_in_org(organization_invites.warehouse_id, organization_invites.organization_id) AS warehouse_in_org)'
         ' AND ( SELECT charter_in_org(organization_invites.charter_id, organization_invites.organization_id) AS charter_in_org))'
         || E'\n' ||
         'organization_invites_select|r|true|authenticated'
         '|( SELECT has_org_role(organization_invites.organization_id, ''admin''::text) AS has_org_role)|-'),
        ('public.delivery_locations',
         'delivery_locations_select|r|true|public'
         '|(EXISTS ( SELECT 1' || E'\n' ||
         '   FROM organization_members m' || E'\n' ||
         '  WHERE ((m.user_id = auth.uid()) AND (m.organization_id = delivery_locations.organization_id) AND (m.accepted_at IS NOT NULL))))|-'
         || E'\n' ||
         'delivery_locations_write|*|true|public'
         '|has_org_role(organization_id, ''staff''::text)|-')
      ) v(tbl, want)
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
       where pol.polrelid = to_regclass(r.tbl);
      raise exception using errcode = 'XX511', message = 'undo';
    exception when sqlstate 'XX511' then
      null;
    end;
    if v_pol is distinct from r.want then
      v_bad := v_bad || format(' %s rules are not the ones this file was written against (%s);', r.tbl, coalesce(v_pol, 'none'));
    end if;
  end loop;

  if v_bad <> '' then
    raise exception 's11a_preflight:%', v_bad using errcode = '55000', hint = 's11a_preflight';
  end if;
end
$pre_s11a$;

-- ═══ 1. The lock prelude (see LOCKS above) ══════════════════════════════════
-- Inside DO because the CLI batch is not a transaction block (a top-level
-- LOCK TABLE refuses there, 0373); the locks last until the batch commits.
--   * organization_invites and delivery_locations: ACCESS EXCLUSIVE (their
--     rule and trigger statements);
--   * organization_members and order_requests: ACCESS SHARE (read when the
--     helper's body is checked and when the live point rules are parsed);
--   * every existing table supautils.policy_grants lists for this role, the
--     parent only of a partitioned one: ACCESS EXCLUSIVE (supautils takes it
--     whenever this role runs a rule statement).
-- A busy table fails the attempt at once; the rollback releases what it took
-- and the next attempt starts after 50 to 150 ms holding no table lock. After
-- the 40th busy attempt the 55P03 is raised as it is and nothing is applied.
do $lock_s11a$
declare
  v_grants text := nullif(current_setting('supautils.policy_grants', true), '');
  v_name   text;
  v_rel    regclass;
  v_try    integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.organization_invites, public.delivery_locations
        in access exclusive mode nowait;
      lock table only public.organization_members, public.order_requests
        in access share mode nowait;
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
end $lock_s11a$;

-- ═══ 2a. The module helper ══════════════════════════════════════════════════
create function public.rls_orgs_with_module(p_module text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.organization_id
    from public.organization_members m
   where m.user_id = (select auth.uid())
     and m.accepted_at is not null
     and (m.impersonation_expires_at is null or m.impersonation_expires_at > now())
     and public.is_org_member(m.organization_id)
     and public.module_enabled(m.organization_id, p_module)
$$;

comment on function public.rls_orgs_with_module(text) is
  'RLS helper (S11-A): every organization where auth.uid() is an accepted member, not on an expired Act-as seat, '
  'is_org_member holds (not disabled) and module_enabled(org, p_module) holds (an enabled module row, or a comped '
  'organization, 0354). rls_orgs_with_permission (0279) with the permission swapped for the module, for hashed IN '
  'probes in write rules. Answers only for the caller''s own organizations; empty with no end user.';

revoke all on function public.rls_orgs_with_module(text) from public, anon, service_role;
grant execute on function public.rls_orgs_with_module(text) to authenticated;

-- ═══ 2b. The invite pin ═════════════════════════════════════════════════════
create function public.tg_organization_invites_update_pin()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_rest public.organization_invites;
begin
  if current_user in ('authenticated', 'anon') then
    -- The new row with the old expiry put back must be the old row, compared
    -- in stored form (*=): every column, a null against a value, and a
    -- citext or jsonb value that compares equal but is written differently.
    v_rest := new;
    v_rest.expires_at := old.expires_at;
    if not (v_rest *= old) then
      raise exception 'invite_update_expiry_only'
        using errcode = '42501',
              detail = 'An invite''s expiry is the only thing that can change.';
    end if;
    if new.expires_at <= now() or new.expires_at > now() + interval '7 days 1 hour' then
      raise exception 'invite_expiry_out_of_range'
        using errcode = '22023',
              detail = 'An invite expires after now and at most 7 days from now.';
    end if;
  end if;
  return new;
end;
$$;

comment on function public.tg_organization_invites_update_pin() is
  'BEFORE UPDATE trigger on organization_invites (S11-A): when current_user is authenticated or anon, only '
  'expires_at may change (42501), and only to a time after now() and no later than now() + 7 days 1 hour (22023). '
  'Keyed on current_user, so writers running as the table owner (0393''s account-deletion trigger, the invited_by '
  'foreign key action, SECURITY DEFINER functions) and the service role are not pinned.';

revoke all on function public.tg_organization_invites_update_pin() from public, anon, authenticated, service_role;

-- ═══ 2c. The invite UPDATE rule and the pin trigger ═════════════════════════
create policy organization_invites_update on public.organization_invites
  for update to authenticated
  using (
    -- CONJUNCT 1 of 3: an admin of the invite's organization, the role the
    -- table's SELECT, INSERT and DELETE rules ask.
    ( select public.has_org_role(organization_invites.organization_id, 'admin') )
    -- CONJUNCTS 2 and 3: the invite is still open.
    and organization_invites.accepted_at is null
    and organization_invites.revoked_at is null
  )
  with check (
    ( select public.has_org_role(organization_invites.organization_id, 'admin') )
    and organization_invites.accepted_at is null
    and organization_invites.revoked_at is null
    -- The INSERT rule's guards (0203, 0204), word for word.
    and ( select public.warehouse_in_org(organization_invites.warehouse_id, organization_invites.organization_id) )
    and ( select public.charter_in_org(organization_invites.charter_id, organization_invites.organization_id) )
  );

comment on policy organization_invites_update on public.organization_invites is
  'S11-A: an admin of the organization renews an open invite (Resend). Not accepted, not revoked. The trigger '
  'trg_zz_organization_invites_update_pin limits what an API member role may change to expires_at.';

create trigger trg_zz_organization_invites_update_pin
  before update on public.organization_invites
  for each row execute function public.tg_organization_invites_update_pin();

-- ═══ 2d. The live point rules ═══════════════════════════════════════════════
drop policy if exists delivery_locations_write on public.delivery_locations;

create policy delivery_locations_insert on public.delivery_locations
  for insert to authenticated
  with check (
    -- CONJUNCT 1 of 4: the point names the caller as its driver.
    delivery_locations.driver_user_id = ( select auth.uid() )
    -- CONJUNCT 2 of 4: 0164's floor, kept.
    and ( select public.has_org_role(delivery_locations.organization_id, 'staff') )
    -- CONJUNCT 3 of 4: the live_tracking module is on in the organization.
    and delivery_locations.organization_id in ( select public.rls_orgs_with_module('live_tracking') )
    -- CONJUNCT 4 of 4: the order is a delivery of the same organization, in
    -- transit, assigned to the caller.
    and exists (
      select 1
        from public.order_requests o
       where o.id = delivery_locations.order_request_id
         and o.organization_id = delivery_locations.organization_id
         and o.fulfillment_type = 'delivery'
         and o.status = 'in_transit'
         and o.assigned_delivery_user_id = ( select auth.uid() )
    )
  );

create policy delivery_locations_update on public.delivery_locations
  for update to authenticated
  using (
    -- The order the point belongs to is assigned to the caller now, so a
    -- newly assigned driver overwrites the earlier driver's point.
    exists (
      select 1
        from public.order_requests o
       where o.id = delivery_locations.order_request_id
         and o.organization_id = delivery_locations.organization_id
         and o.fulfillment_type = 'delivery'
         and o.status = 'in_transit'
         and o.assigned_delivery_user_id = ( select auth.uid() )
    )
  )
  with check (
    delivery_locations.driver_user_id = ( select auth.uid() )
    and ( select public.has_org_role(delivery_locations.organization_id, 'staff') )
    and delivery_locations.organization_id in ( select public.rls_orgs_with_module('live_tracking') )
    and exists (
      select 1
        from public.order_requests o
       where o.id = delivery_locations.order_request_id
         and o.organization_id = delivery_locations.organization_id
         and o.fulfillment_type = 'delivery'
         and o.status = 'in_transit'
         and o.assigned_delivery_user_id = ( select auth.uid() )
    )
  );

create policy delivery_locations_delete on public.delivery_locations
  for delete to authenticated
  using (
    -- 0164's floor, kept: the clean-ups run as the member acting on the order.
    ( select public.has_org_role(delivery_locations.organization_id, 'staff') )
  );

comment on policy delivery_locations_insert on public.delivery_locations is
  'S11-A: the assigned driver (staff or above) records the live point of an in-transit delivery of their '
  'organization, with live_tracking on.';
comment on policy delivery_locations_update on public.delivery_locations is
  'S11-A: the driver assigned now overwrites the point of an in-transit delivery; the new row meets the INSERT rule.';
comment on policy delivery_locations_delete on public.delivery_locations is
  'S11-A: staff or above drop the point (order cancel and return clean-ups), as 0164 allowed.';

reset lock_timeout;
