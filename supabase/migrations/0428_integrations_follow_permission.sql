-- 0428_integrations_follow_permission.sql
--
-- Integration connections follow the Manage integrations and Manage shipping
-- permissions in the database, as they do in the app, and a connection row's
-- Vault pointer and identity are written only through the app's checked path
-- (docket S27, part b). No row of any table changes, no table, view or
-- sequence is created, and no table grant changes.
--
-- ── WHY ────────────────────────────────────────────────────────────────────
-- The app gates every integration write on the member's effective key
-- (connections.ts, integration-events.ts): Manage shipping for EasyPost,
-- Manage integrations for every other provider and for the webhooks and
-- alerts, and either one for retrying a failed export. The policies on the
-- integration tables (0146, 0149, 0152, 0169) asked for a role instead
-- (admin, or manager for the mappings and the carrier shipments), so the
-- Roles page marked a grant of either key as still rolling out. After this
-- file the database asks the same keys the app asks, through has_permission's
-- hashed set helper, and the Roles page calls both grants fully effective
-- (core FULLY_GRANTABLE_PERMISSIONS).
--
-- A connection row's Vault pointer (secret_id) and its id, organization and
-- provider are the server's to write. Since S27a (#431) the app sets the
-- pointer only with the service role, after a write the database checks, and
-- a member's own writes only clear it (Disconnect); this file makes that the
-- rule in the database too.
--
-- ── WHAT ──────────────────────────────────────────────────────────────────
-- 0. Preflight: refuse (55000, hint s27b_preflight, nothing applied) unless
--    the policies on the six tables are exactly 0146/0149/0152/0169's
--    (deparsed under a pinned search_path), row security is on for all six,
--    has_permission is 0310's body (the md5 0413 pins) and
--    rls_orgs_with_permission is 0279's (definer, stable, owned by postgres,
--    executable by authenticated), role_default_permissions gives admins both
--    keys, org_connections.provider_id and connection_sync_log.status are NOT
--    NULL, org_connections carries exactly its three triggers, and the guard
--    function's name is free.
-- 1. The lock prelude (LOCKS below).
-- 2. The six old policies are dropped. With I = the organizations where the
--    caller holds integrations:manage and S = the same for shipping:manage
--    (rls_orgs_with_permission, evaluated once per statement), these replace
--    them:
--      org_connections_insert         INSERT, WITH CHECK: EasyPost rows in S,
--                                     every other provider in I;
--      org_connections_update         UPDATE, the same rule for the row
--                                     before and after (no DELETE policy:
--                                     nothing deletes a connection row);
--      connection_sync_log_replay     UPDATE of a failed row ('error' or
--                                     'dead') back to 'pending', in I or S;
--      integration_endpoints_manage   ALL, in I;
--      integration_deliveries_select  SELECT, in I.
--    connection_mappings and carrier_shipments keep only their member read
--    policies: only the service role writes them (the drainer, the shipping
--    service, the EasyPost webhook and the reap cron). The four select
--    policies are untouched. provider_id is NOT NULL, so `<> 'easypost'` is
--    exact (pattern 23b).
-- 3. public._guard_org_connections_client_writes(), SECURITY INVOKER so
--    current_user is the caller (the 0218 precedent), runs BEFORE INSERT OR
--    UPDATE on org_connections. For authenticated and anon only: an insert
--    may not set secret_id; an update may not change id, organization_id or
--    provider_id, and may only keep or clear secret_id. 42501 otherwise. The
--    service role and migrations are not affected. Every user-client write in
--    the app complies (beginConnect, the API-key connect's first step,
--    setZendeskSubdomain, the two settings saves, and Disconnect, which
--    clears the pointer).
-- 4. Comments on the five policies, the function and the trigger.
--
-- ── LOCKS ─────────────────────────────────────────────────────────────────
-- DROP POLICY and CREATE POLICY take ACCESS EXCLUSIVE on their table and,
-- through supautils 3.4.0 (image 17.6.1.166), on every existing table
-- supautils.policy_grants lists for this role (auth, storage and realtime:
-- auth.users and auth.sessions among them; 0390, 0395). CREATE TRIGGER
-- takes SHARE ROW EXCLUSIVE on org_connections. The preflight reads catalogs,
-- and reads role_default_permissions and deparses the policies in a block
-- that is always undone, so it ends holding no table lock; CREATE FUNCTION,
-- REVOKE and COMMENT take none. So the prelude takes the six tables and those
-- tables at once, NOWAIT, retrying up to 40 times with a 50 to 150 ms pause
-- that holds nothing (the 0390 and 0395 pattern), and no later statement
-- takes a new table lock: the file never waits while holding one, so it
-- cannot deadlock. From the prelude to the commit (milliseconds), integration
-- reads and writes, webhook dispatch (an integration_deliveries insert per
-- event), sign-ins, token refreshes, and storage and realtime requests wait
-- for the hold. lock_timeout 900ms bounds anything unforeseen.
-- scripts/db-concurrency/0428_migration_lock_footprint.sh measures it.
--
-- ── ERRORS ────────────────────────────────────────────────────────────────
-- 55000 hint s27b_preflight: drift, or a second run; nothing applied.
-- 55P03: busy after 40 attempts, or the 900 ms cap; nothing applied, run it
-- again. Afterwards a signed-in write the rules refuse is 42501 (an insert,
-- an upsert, a guarded column) or changes 0 rows (an update or delete of a
-- row the rule does not pass); the app reports both (S27a). Never 40001 or
-- 40P01 (PostgREST retries those, 0367).
--
-- ── ORDER ─────────────────────────────────────────────────────────────────
-- After every lower number, and after S27a (#431, live 2026-11-02): before
-- it, the API-key connect wrote secret_id with the member's own client, which
-- step 3 refuses. No queued migration restates, drops or pins any of the six
-- tables' policies, has_permission or rls_orgs_with_permission, or adds a
-- trigger to org_connections (checked on each queued branch's head; the PR
-- body lists them). docket S9's grants cleanup revokes TRUNCATE, REFERENCES,
-- TRIGGER and MAINTAIN on these six tables from anon and authenticated; this
-- file changes no table grant and pins none, so the two go in either order.
-- docket S36a's preflight pins has_permission at the same md5 as this one,
-- and neither changes it.

set lock_timeout = '900ms';

-- ═══ 0. Preflight ═══════════════════════════════════════════════════════════
do $pre_s27b$
declare
  v_bad text := '';
  v_got text;
  v_pol text;
  r     record;
begin
  -- The permission resolver and its hashed set helper, relied on unchanged:
  -- has_permission is 0310's body (md5 pinned by 0413), and
  -- rls_orgs_with_permission is 0279's, which the new policies call as the
  -- reader, so authenticated must keep EXECUTE on it (INV-C1).
  for r in
    select v.sig, v.want, v.need_auth, p.oid as poid, md5(p.prosrc) as got, p.prosecdef,
           p.provolatile::text as vol, pg_get_userbyid(p.proowner) as owner,
           case when p.oid is null then false else has_function_privilege('authenticated', p.oid, 'execute') end as auth_x
      from (values
        ('public.has_permission(uuid,text)',         'cc0accdad7e2fdf4f88aa82aa887e85f', false),
        ('public.rls_orgs_with_permission(text)',    'c346a5c3447b75be554030c0e505a497', true)
      ) v(sig, want, need_auth)
      left join pg_proc p on p.oid = to_regprocedure(v.sig)
  loop
    if r.poid is null then
      v_bad := v_bad || format(' %s missing;', r.sig);
    elsif r.got <> r.want or not r.prosecdef or r.vol <> 's' or r.owner <> 'postgres'
          or (r.need_auth and not r.auth_x) then
      v_bad := v_bad || format(' %s drifted (md5 %s, definer %s, volatility %s, owner %s, authenticated %s);',
                               r.sig, r.got, r.prosecdef, r.vol, r.owner, r.auth_x);
    end if;
  end loop;

  -- The columns the new rules compare are NOT NULL (pattern 23b).
  select string_agg(c.relname || '.' || a.attname || '=' || a.attnotnull::text, ',' order by c.relname)
    into v_got
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
   where (a.attrelid, a.attname) in (('public.org_connections'::regclass, 'provider_id'),
                                     ('public.connection_sync_log'::regclass, 'status'))
     and not a.attisdropped;
  if v_got is distinct from 'connection_sync_log.status=true,org_connections.provider_id=true' then
    v_bad := v_bad || format(' NOT NULL columns drifted (%s);', coalesce(v_got, 'none'));
  end if;

  -- Row security is on for all six tables (the rules below mean nothing
  -- without it).
  select string_agg(c.relname, ',' order by c.relname)
    into v_got
    from pg_class c
   where c.oid in ('public.org_connections'::regclass, 'public.connection_sync_log'::regclass,
                   'public.integration_endpoints'::regclass, 'public.integration_deliveries'::regclass,
                   'public.connection_mappings'::regclass, 'public.carrier_shipments'::regclass)
     and not c.relrowsecurity;
  if v_got is not null then
    v_bad := v_bad || format(' row security is off on %s;', v_got);
  end if;

  -- org_connections carries exactly 0146's and 0393's triggers, and the guard
  -- function's name is free.
  select string_agg(t.tgname, ',' order by t.tgname)
    into v_got
    from pg_trigger t
   where t.tgrelid = 'public.org_connections'::regclass and not t.tgisinternal;
  if v_got is distinct from 'org_connections_set_updated_at,zzz_deleted_users_ins,zzz_deleted_users_upd' then
    v_bad := v_bad || format(' org_connections triggers are not 0146''s and 0393''s (%s);', coalesce(v_got, 'none'));
  end if;
  if to_regprocedure('public._guard_org_connections_client_writes()') is not null then
    v_bad := v_bad || ' public._guard_org_connections_client_writes() already exists;';
  end if;

  -- Two checks run in a block that is always undone, so nothing they lock
  -- outlives it (variables keep their values when the block is undone):
  --  * admins hold both keys by default (0207), so the new rules keep every
  --    admin's access unless an override takes it away (a table read: its
  --    lock would otherwise last until the commit);
  --  * every policy on the six tables is the one 0146, 0149, 0152 or 0169
  --    created: name, command, permissive, roles, and the md5 of each
  --    expression, deparsed with search_path pinned inside the block (docket
  --    S9's method) so the text does not depend on the session's search_path.
  begin
    select string_agg(rdp.permission, ',' order by rdp.permission)
      into v_got
      from public.role_default_permissions rdp
     where rdp.role = 'admin' and rdp.permission in ('integrations:manage', 'shipping:manage');
    perform set_config('search_path', 'public, extensions', true);
    select string_agg(c.relname || '.' || pol.polname || '|' || pol.polcmd::text || '|' || pol.polpermissive::text || '|'
                      || (select string_agg(case x when 0 then 'public' else x::regrole::text end, ',' order by 1)
                            from unnest(pol.polroles) x)
                      || '|' || md5(coalesce(pg_get_expr(pol.polqual, pol.polrelid), '-'))
                      || '|' || md5(coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '-')), E'\n'
                      order by c.relname, pol.polname)
      into v_pol
      from pg_policy pol
      join pg_class c on c.oid = pol.polrelid
     where pol.polrelid in ('public.org_connections'::regclass, 'public.connection_sync_log'::regclass,
                            'public.integration_endpoints'::regclass, 'public.integration_deliveries'::regclass,
                            'public.connection_mappings'::regclass, 'public.carrier_shipments'::regclass);
    raise exception using errcode = 'XX527', message = 'undo';
  exception when sqlstate 'XX527' then
    null;
  end;
  if v_got is distinct from 'integrations:manage,shipping:manage' then
    v_bad := v_bad || format(' admin defaults are not both keys (%s);', coalesce(v_got, 'none'));
  end if;
  if v_pol is distinct from
     'carrier_shipments.carrier_shipments_select|r|true|authenticated|18c56f48bbf23a4726bac4b92133f24b|336d5ebc5436534e61d16e63ddfca327' || E'\n' ||
     'carrier_shipments.carrier_shipments_write|*|true|authenticated|5edfa0447ba758bd93b0b8a1baa3a7ea|5edfa0447ba758bd93b0b8a1baa3a7ea' || E'\n' ||
     'connection_mappings.connection_mappings_select|r|true|authenticated|02fc0f5839c8fc6706548f6c9b9338da|336d5ebc5436534e61d16e63ddfca327' || E'\n' ||
     'connection_mappings.connection_mappings_write|*|true|authenticated|2a50ae4969bf269722412ae0d8e73dcc|2a50ae4969bf269722412ae0d8e73dcc' || E'\n' ||
     'connection_sync_log.connection_sync_log_admin_replay|w|true|authenticated|24e1551beb732aed6c5618a1656f37ab|f503b168399c7f4c50735da008f6fa87' || E'\n' ||
     'connection_sync_log.connection_sync_log_select|r|true|authenticated|b185f37e459a86cfc01b71a1e5027213|336d5ebc5436534e61d16e63ddfca327' || E'\n' ||
     'integration_deliveries.integration_deliveries_admin_read|r|true|authenticated|2cec8246408af2550cbb87980a966533|336d5ebc5436534e61d16e63ddfca327' || E'\n' ||
     'integration_endpoints.integration_endpoints_admin_all|*|true|authenticated|2cec8246408af2550cbb87980a966533|2cec8246408af2550cbb87980a966533' || E'\n' ||
     'org_connections.org_connections_select|r|true|authenticated|a9fb1ec37f58a25b93d2b6efc128b107|336d5ebc5436534e61d16e63ddfca327' || E'\n' ||
     'org_connections.org_connections_write|*|true|authenticated|467ffeb90e8036eb840421bf558c558c|467ffeb90e8036eb840421bf558c558c' then
    v_bad := v_bad || format(' integration policies are not 0146/0149/0152/0169''s (%s);',
                             replace(coalesce(v_pol, 'none'), E'\n', ' / '));
  end if;

  if v_bad <> '' then
    raise exception 's27b_preflight:%', v_bad using errcode = '55000', hint = 's27b_preflight';
  end if;
end
$pre_s27b$;

-- ═══ 1. The lock prelude (see LOCKS above) ══════════════════════════════════
-- Inside DO because the CLI batch is not a transaction block (a top-level
-- LOCK TABLE refuses there, 0373); the locks last until the batch commits.
--   * the six integration tables: ACCESS EXCLUSIVE (their policy statements,
--     and the trigger on org_connections);
--   * every existing table supautils.policy_grants lists for this role, the
--     parent only of a partitioned one: ACCESS EXCLUSIVE (supautils takes it
--     whenever this role runs a policy statement).
-- A busy table fails the attempt at once; the rollback releases what it took
-- and the next attempt starts after 50 to 150 ms holding no table lock. After
-- the 40th busy attempt the 55P03 is raised as it is and nothing is applied.
do $lock_s27b$
declare
  v_grants text := nullif(current_setting('supautils.policy_grants', true), '');
  v_name   text;
  v_rel    regclass;
  v_try    integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.org_connections, public.connection_sync_log, public.integration_endpoints,
                      public.integration_deliveries, public.connection_mappings, public.carrier_shipments
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
end $lock_s27b$;

-- ═══ 2. The policies ════════════════════════════════════════════════════════
-- Dropped and created in this one transaction (never ALTER: pattern 24). The
-- set helper takes no row column, so each IN is a hashed set evaluated once
-- per statement, never a per-row has_permission (pattern 19).
drop policy org_connections_write on public.org_connections;
drop policy connection_sync_log_admin_replay on public.connection_sync_log;
drop policy integration_endpoints_admin_all on public.integration_endpoints;
drop policy integration_deliveries_admin_read on public.integration_deliveries;
drop policy connection_mappings_write on public.connection_mappings;
drop policy carrier_shipments_write on public.carrier_shipments;

create policy org_connections_insert on public.org_connections
  for insert to authenticated
  with check (
    (provider_id = 'easypost'
     and organization_id in (select public.rls_orgs_with_permission('shipping:manage')))
    or (provider_id <> 'easypost'
        and organization_id in (select public.rls_orgs_with_permission('integrations:manage')))
  );

create policy org_connections_update on public.org_connections
  for update to authenticated
  using (
    (provider_id = 'easypost'
     and organization_id in (select public.rls_orgs_with_permission('shipping:manage')))
    or (provider_id <> 'easypost'
        and organization_id in (select public.rls_orgs_with_permission('integrations:manage')))
  )
  with check (
    (provider_id = 'easypost'
     and organization_id in (select public.rls_orgs_with_permission('shipping:manage')))
    or (provider_id <> 'easypost'
        and organization_id in (select public.rls_orgs_with_permission('integrations:manage')))
  );

create policy connection_sync_log_replay on public.connection_sync_log
  for update to authenticated
  using (
    status in ('error', 'dead')
    and (organization_id in (select public.rls_orgs_with_permission('integrations:manage'))
         or organization_id in (select public.rls_orgs_with_permission('shipping:manage')))
  )
  with check (
    status = 'pending'
    and (organization_id in (select public.rls_orgs_with_permission('integrations:manage'))
         or organization_id in (select public.rls_orgs_with_permission('shipping:manage')))
  );

create policy integration_endpoints_manage on public.integration_endpoints
  for all to authenticated
  using (organization_id in (select public.rls_orgs_with_permission('integrations:manage')))
  with check (organization_id in (select public.rls_orgs_with_permission('integrations:manage')));

create policy integration_deliveries_select on public.integration_deliveries
  for select to authenticated
  using (organization_id in (select public.rls_orgs_with_permission('integrations:manage')));

-- ═══ 3. The connection row's pointer and identity ═══════════════════════════
create function public._guard_org_connections_client_writes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- SECURITY INVOKER on purpose: current_user is the caller's role, so the
  -- service role (the connect activation, the OAuth callbacks, the token
  -- refreshes) and migrations pass, and only the API's signed-in and
  -- anonymous roles are held to the rule.
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      if new.secret_id is not null then
        raise exception 'a connection''s secret is set by the server only'
          using errcode = 'insufficient_privilege';
      end if;
    elsif new.id is distinct from old.id
       or new.organization_id is distinct from old.organization_id
       or new.provider_id is distinct from old.provider_id
       or (new.secret_id is not null and new.secret_id is distinct from old.secret_id) then
      raise exception 'a connection''s secret, organization and provider are set by the server only'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public._guard_org_connections_client_writes() from public, anon, authenticated;

create trigger org_connections_client_guard
  before insert or update on public.org_connections
  for each row execute function public._guard_org_connections_client_writes();

-- ═══ 4. Comments ════════════════════════════════════════════════════════════
-- None of the texts names this file's number, so a rename leaves them (and
-- the md5s the test pins) alone.
comment on policy org_connections_insert on public.org_connections is
  'A signed-in member adds an EasyPost connection with Manage shipping, and any other provider''s with Manage '
  'integrations (docket S27), the keys the app checks. rls_orgs_with_permission resolves the member''s effective '
  'permission (owner, user override, role override, role default) and refuses disabled accounts and expired Act-as '
  'seats. The guard trigger keeps secret_id for the server.';

comment on policy org_connections_update on public.org_connections is
  'A signed-in member changes an EasyPost connection with Manage shipping, and any other provider''s with Manage '
  'integrations (docket S27), before and after the change. The guard trigger keeps id, organization_id and '
  'provider_id fixed and lets the member only keep or clear secret_id. No DELETE policy: nothing deletes a '
  'connection row (Disconnect clears it).';

comment on policy connection_sync_log_replay on public.connection_sync_log is
  'Replay: a signed-in member with Manage integrations or Manage shipping sets a failed export (error or dead) back '
  'to pending (docket S27), as the app''s Replay does. A pending or successful export cannot be changed.';

comment on policy integration_endpoints_manage on public.integration_endpoints is
  'Webhooks and alerts: read and written by a signed-in member with Manage integrations (docket S27), the key the '
  'app checks. Dispatch and the drain use the service role.';

comment on policy integration_deliveries_select on public.integration_deliveries is
  'Webhook and alert deliveries: read by a signed-in member with Manage integrations (docket S27). Written by the '
  'service role only.';

comment on function public._guard_org_connections_client_writes() is
  'BEFORE INSERT OR UPDATE on org_connections (docket S27). For the API''s signed-in and anonymous roles: an insert '
  'may not set secret_id; an update may not change id, organization_id or provider_id and may only keep or clear '
  'secret_id (42501). The service role sets the Vault pointer after a write the database checked, and migrations '
  'are not affected (SECURITY INVOKER, so current_user is the caller; 0218''s pattern).';

comment on trigger org_connections_client_guard on public.org_connections is
  'Keeps a connection''s Vault pointer, id, organization and provider for the server (docket S27); see '
  'public._guard_org_connections_client_writes().';

reset lock_timeout;
