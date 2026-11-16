-- 0465_connection_records_in_their_organization.sql
--
-- A connection's mappings and sync log entries belong to its organization,
-- and a connection names only the stored secret the server created for it:
--   * a mapping names a connection of its own organization: the write rule
--     connection_mappings_write asks the new connection_in_org(connection_id,
--     organization_id) of the new row, for every rank;
--   * a sync log entry names a connection and a queued event of its own
--     organization: the replay rule connection_sync_log_admin_replay asks
--     connection_in_org(connection_id, organization_id) and the new
--     outbox_event_in_org(outbox_event_id, organization_id) of the new row;
--   * a connection's secret_id is set by the server only: for the API roles
--     an insert that names a secret, or an update that changes secret_id to
--     a secret, is refused (42501); clearing it (disconnect) is as before.
--     For every other role the secret named must be the Vault secret stored
--     for this connection (the new tg_org_connection_secret_set, bound
--     BEFORE INSERT and BEFORE UPDATE on public.org_connections);
--   * connector_secret_get decrypts a connector secret only while every
--     connection that names it is the one it was stored for, and
--     connector_secret_delete removes a connector secret only once no
--     connection names it.
-- No row of any table changes.
--
-- ── WHAT ──────────────────────────────────────────────────────────────────
-- connection_in_org(p_connection_id, p_org_id) and
-- outbox_event_in_org(p_event_id, p_org_id) are bin_in_org's body (0462)
-- for public.org_connections and public.outbox_events: NULL passes,
-- otherwise the row must carry that organization. SECURITY DEFINER, stable,
-- search_path public, owned by postgres, executable by authenticated and
-- service_role only (the *_in_org posture), so they answer inside a rule
-- whatever connections and events the writer may read.
--
-- The stored secret of a connection is the Vault secret named
-- 'connector:<connection id>' (every writer today: the QuickBooks and
-- Intacct callbacks, the API-key and Zendesk connects and the token
-- refreshes, all through connector_secret_put as the service role), or
-- 'connector:<organization id>:<provider>' (the name the API-key and
-- Zendesk connects gave a first secret before the row existed). Vault names
-- are unique. connection_secret_is_own(p_secret_id, p_connection_id,
-- p_org_id, p_provider_id) answers that: NULL passes, otherwise the Vault
-- secret with that id carries one of the two names. SECURITY DEFINER (it
-- reads vault.secrets' names, never a value), stable, search_path public,
-- owned by postgres, executable by service_role only (the trigger asks it
-- only for roles other than authenticated and anon).
--
--   connection_mappings_write (FOR ALL)
--                     WITH CHECK  0146's, AND connection_in_org(connection_id, organization_id)
--                     USING       0146's, unchanged
--   connection_sync_log_admin_replay (FOR UPDATE)
--                     WITH CHECK  0152's, AND connection_in_org(connection_id, organization_id)
--                                         AND outbox_event_in_org(outbox_event_id, organization_id)
--                     USING       0152's, unchanged
-- Both columns are NOT NULL. No application code writes a mapping through
-- a member's client (the drainer writes them as the service role); the
-- sync log replay sets status, attempts, next_attempt_at, last_error and
-- updated_at of a row of the active organization.
--
-- tg_org_connection_secret_set: BEFORE INSERT bound WHEN (new.secret_id IS
-- NOT NULL), and BEFORE UPDATE bound WHEN (new.secret_id IS DISTINCT FROM
-- old.secret_id AND new.secret_id IS NOT NULL), so an insert or update that
-- leaves secret_id alone or clears it never enters it. For authenticated
-- and anon it raises 42501 "A connection's stored secret is set by the
-- server only."; for every other role it raises 42501 "A connection names
-- only a secret stored for it." unless connection_secret_is_own holds.
-- SECURITY INVOKER on purpose (a DEFINER trigger sees postgres), as
-- tg_organization_id_fixed. The members' writes of org_connections (the
-- OAuth connect upsert, the API-key and Zendesk row write, the Zendesk
-- subdomain save, the account mapping and settings saves) never send
-- secret_id, and disconnect sets it to NULL; the service role writes it
-- after connector_secret_put named the secret for the row.
--
-- connector_secret_get and connector_secret_delete keep 0146's signature,
-- language, SECURITY DEFINER, search_path (public, vault), owner and
-- EXECUTE (service_role only). get returns NULL (the callers report
-- "connector secret not found") for a secret that is not a connector
-- secret, or that a connection names without being the one it was stored
-- for. delete removes nothing while a connection still names the secret
-- (disconnect clears the row's secret_id first), or when it is not a
-- connector secret.
--
--   0. Preflight: refuse (55000, hint connection_reference_preflight,
--      nothing applied) unless tg_organization_id_fixed is 0462's body
--      bound on exactly its fourteen tables (0463), the two rules are
--      0146's and 0152's, connector_secret_get and connector_secret_delete
--      are 0146's bodies (SECURITY DEFINER, search_path public, vault,
--      owned by postgres, executable by service_role only),
--      bin_in_org is 0462's body (the helpers' model), and the new
--      functions and triggers do not exist yet.
--   1. The lock prelude (LOCKS below).
--   2. connection_in_org, outbox_event_in_org and connection_secret_is_own,
--      with their EXECUTE decided here.
--   3. The two rules are dropped and created in this one transaction
--      (never ALTER: pattern 24), every conjunct restated and every column
--      of the rule's own table qualified (pattern 25).
--   4. tg_org_connection_secret_set and its two triggers.
--   5. connector_secret_get and connector_secret_delete.
--   6. Comments.
--
-- ── LOCKS ─────────────────────────────────────────────────────────────────
-- DROP POLICY and CREATE POLICY take ACCESS EXCLUSIVE on
-- public.connection_mappings and public.connection_sync_log and, through
-- supautils, on every existing table supautils.policy_grants lists for this
-- role (auth, storage and realtime tables; 0390, 0395, 0420, 0421, 0423,
-- 0462). CREATE TRIGGER takes SHARE ROW EXCLUSIVE on public.org_connections,
-- which lets its reads go on. CREATE FUNCTION checks a SQL body and takes
-- ACCESS SHARE on the relations it names (public.org_connections,
-- public.outbox_events, vault.secrets and vault.decrypted_secrets), and ROW
-- EXCLUSIVE on the table a DELETE body names (vault.secrets, for
-- connector_secret_delete), which waits only for DDL on it. CREATE
-- FUNCTION of a plpgsql body, REVOKE, GRANT and COMMENT take no table
-- lock. The preflight reads catalogs and deparses the rules
-- in a block that is always undone, so it ends holding no table lock. So
-- the prelude takes all of those at once, NOWAIT, retrying up to 40 times
-- with a 50 to 150 ms pause that holds nothing (the 0390, 0395, 0420, 0421,
-- 0423, 0462 and 0463 pattern), and no later statement takes a new table
-- lock: the file never waits while holding one, so it cannot deadlock. From
-- the prelude to the commit (milliseconds), mapping and sync log reads and
-- writes, connection writes, sign-ins, token refreshes, and storage and
-- realtime requests wait for the hold; connection and queued event reads
-- and queued event writes do not. lock_timeout 900ms bounds anything
-- unforeseen.
--
-- ── ERRORS ────────────────────────────────────────────────────────────────
-- 55000 hint connection_reference_preflight: drift, 0463 not applied, or a
-- second run; nothing applied. 55P03: busy after 40 attempts, or the 900 ms
-- cap; nothing applied, run it again. Afterwards a mapping that names
-- another organization's connection, a sync log replay that names another
-- organization's connection or queued event, an API-role write that names a
-- stored secret, and a service-role write that names a secret not stored
-- for the connection get 42501. Never 40001 or 40P01 (PostgREST retries
-- those, 0367).
--
-- ── ORDER ─────────────────────────────────────────────────────────────────
-- After 0463 (the preflight asks its fourteen bindings) and every lower
-- number.

set lock_timeout = '900ms';

-- ═══ 0. Preflight ═══════════════════════════════════════════════════════════
do $pre_conn_ref$
declare
  v_bad text := '';
  v_pol text;
  v_got text;
  r     record;
begin
  -- md5(prosrc) of the bodies this file replaces or models, by short alias:
  --   g = public.connector_secret_get(uuid) (0146), d = public.connector_secret_delete(uuid) (0146),
  --   b = public.bin_in_org(uuid,uuid) (0462), f = public.tg_organization_id_fixed() (0462).
  -- Each md5 is written in two halves.
  for r in
    select v.alias, v.sig, v.want, v.definer, v.cfg_want, v.auth_want, v.svc_want,
           p.oid as poid, md5(p.prosrc) as got, p.prosecdef,
           pg_get_userbyid(p.proowner) as owner,
           coalesce(array_to_string(p.proconfig, ','), '-') as cfg,
           case when p.oid is null then false else has_function_privilege('authenticated', p.oid, 'execute') end as auth_x,
           case when p.oid is null then false else has_function_privilege('anon', p.oid, 'execute') end as anon_x,
           case when p.oid is null then false else has_function_privilege('service_role', p.oid, 'execute') end as svc_x
      from (values
        ('g', 'public.connector_secret_get(uuid)',    '68c6ac2ea1e0850b' || '2ca1c344749c159d', true,  'search_path=public, vault', false, true),
        ('d', 'public.connector_secret_delete(uuid)', 'f4360c9ce9f4420a' || 'fac0a90723619dbb', true,  'search_path=public, vault', false, true),
        ('b', 'public.bin_in_org(uuid,uuid)',         'f572bc9d2cccd121' || 'a83bf4a8fdb97336', true,  'search_path=public',        true,  true),
        ('f', 'public.tg_organization_id_fixed()',    '9054291fa6f24646' || 'ece8de5570134e38', false, 'search_path=public',        false, false)
      ) v(alias, sig, want, definer, cfg_want, auth_want, svc_want)
      left join pg_proc p on p.oid = to_regprocedure(v.sig)
  loop
    if r.poid is null then
      v_bad := v_bad || format(' %s missing;', r.sig);
    elsif r.got <> r.want or r.prosecdef <> r.definer or r.owner <> 'postgres' or r.cfg <> r.cfg_want
          or r.auth_x <> r.auth_want or r.anon_x or r.svc_x <> r.svc_want then
      v_bad := v_bad || format(' %s drifted (md5 %s, definer %s, owner %s, config %s, authenticated %s, anon %s, service_role %s);',
                               r.sig, r.got, r.prosecdef, r.owner, r.cfg, r.auth_x, r.anon_x, r.svc_x);
    end if;
  end loop;

  -- 0463 is applied: the guard is bound on exactly its fourteen tables.
  select string_agg(t.tgrelid::regclass::text, ',' order by t.tgrelid::regclass::text collate "C") into v_got
    from pg_trigger t where t.tgfoid = to_regprocedure('public.tg_organization_id_fixed()');
  if v_got is distinct from 'api_keys,bins,categories,charters,connection_mappings,connection_sync_log,customers,'
                            || 'integration_endpoints,locations,org_connections,outbox_events,public_request_links,suppliers,warehouses' then
    v_bad := v_bad || format(' 0463 is not applied in its own form (the guard is bound on %s);', coalesce(v_got, 'nothing'));
  end if;

  -- The new functions and triggers do not exist yet (a second run stops here).
  for r in
    select v.sig from (values
      ('public.connection_in_org(uuid,uuid)'),
      ('public.outbox_event_in_org(uuid,uuid)'),
      ('public.connection_secret_is_own(uuid,uuid,uuid,text)'),
      ('public.tg_org_connection_secret_set()')
    ) v(sig)
  loop
    if to_regprocedure(r.sig) is not null then
      v_bad := v_bad || format(' %s already exists;', r.sig);
    end if;
  end loop;
  if exists (select 1 from pg_trigger t
              where t.tgrelid = 'public.org_connections'::regclass
                and t.tgname in ('trg_zz_org_connections_secret_insert', 'trg_zz_org_connections_secret_update')) then
    v_bad := v_bad || ' a secret trigger already exists on public.org_connections;';
  end if;

  -- Each table's INSERT, UPDATE and ALL rules, compared by md5 of their
  -- deparse (the lines joined): connection_mappings' is 0146's
  -- (m = 232df9ef...), connection_sync_log's is 0152's (l = f1ef962d...).
  -- Deparsed in a block that is always undone, with search_path pinned
  -- inside it (0420's method).
  for r in
    select v.alias, v.tbl, v.want
      from (values
        ('m', 'public.connection_mappings', '232df9efb0790abb' || '7260979b2b33297a'),
        ('l', 'public.connection_sync_log', 'f1ef962d0b169797' || '83d49517e74ac1c3')
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
      raise exception using errcode = 'XX465', message = 'undo';
    exception when sqlstate 'XX465' then
      null;
    end;
    if md5(coalesce(v_pol, '')) is distinct from r.want then
      v_bad := v_bad || format(' %s INSERT/UPDATE rules are not the expected ones (md5 %s);', r.tbl, md5(coalesce(v_pol, '')));
    end if;
  end loop;

  if v_bad <> '' then
    raise exception 'connection_reference_preflight:%', v_bad using errcode = '55000', hint = 'connection_reference_preflight';
  end if;
end
$pre_conn_ref$;

-- ═══ 1. The lock prelude (see LOCKS above) ══════════════════════════════════
-- Inside DO because the CLI batch is not a transaction block (a top-level
-- LOCK TABLE refuses there, 0373); the locks last until the batch commits.
--   * public.connection_mappings and public.connection_sync_log: ACCESS
--     EXCLUSIVE (their rule statements);
--   * public.org_connections: SHARE ROW EXCLUSIVE (CREATE TRIGGER; it also
--     covers the SQL bodies' ACCESS SHARE);
--   * public.outbox_events and vault.decrypted_secrets: ACCESS SHARE, and
--     vault.secrets: ROW EXCLUSIVE (the SQL bodies that name them);
--   * every existing table supautils.policy_grants lists for this role, the
--     parent only of a partitioned one: ACCESS EXCLUSIVE (supautils takes it
--     whenever this role runs a rule statement).
-- A busy table fails the attempt at once; the rollback releases what it took
-- and the next attempt starts after 50 to 150 ms holding no table lock. After
-- the 40th busy attempt the 55P03 is raised as it is and nothing is applied.
do $lock_conn_ref$
declare
  v_grants text := nullif(current_setting('supautils.policy_grants', true), '');
  v_name   text;
  v_rel    regclass;
  v_try    integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.connection_mappings, public.connection_sync_log
        in access exclusive mode nowait;
      lock table only public.org_connections
        in share row exclusive mode nowait;
      lock table only public.outbox_events, vault.decrypted_secrets
        in access share mode nowait;
      lock table only vault.secrets
        in row exclusive mode nowait;
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
end $lock_conn_ref$;

-- ═══ 2. The helpers ═════════════════════════════════════════════════════════
-- bin_in_org's form (0462) for connections and queued events.
create function public.connection_in_org(p_connection_id uuid, p_org_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select p_connection_id is null or exists (
    select 1 from public.org_connections
    where id = p_connection_id and organization_id = p_org_id
  );
$$;

create function public.outbox_event_in_org(p_event_id uuid, p_org_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select p_event_id is null or exists (
    select 1 from public.outbox_events
    where id = p_event_id and organization_id = p_org_id
  );
$$;

-- EXECUTE as the other *_in_org helpers hold it (0318, 0462): authenticated
-- (the rules run as the writer) and service_role; not PUBLIC or anon.
-- Decided here for all three API roles, whatever the default privileges give.
revoke all on function public.connection_in_org(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.connection_in_org(uuid, uuid) to authenticated, service_role;
revoke all on function public.outbox_event_in_org(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.outbox_event_in_org(uuid, uuid) to authenticated, service_role;

-- The Vault secret stored for a connection: named for its id, or (a first
-- API-key or Zendesk secret written before the row existed) for its
-- organization and provider. Reads names only, never a value.
create function public.connection_secret_is_own(p_secret_id uuid, p_connection_id uuid, p_org_id uuid, p_provider_id text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select p_secret_id is null or exists (
    select 1 from vault.secrets s
    where s.id = p_secret_id
      and s.name in ('connector:' || p_connection_id::text,
                     'connector:' || p_org_id::text || ':' || p_provider_id)
  );
$$;

-- EXECUTE for service_role only: the trigger asks it for roles other than
-- authenticated and anon (whom it refuses first); no member calls it.
revoke all on function public.connection_secret_is_own(uuid, uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.connection_secret_is_own(uuid, uuid, uuid, text) to service_role;

-- ═══ 3. The two rules ═══════════════════════════════════════════════════════
drop policy if exists connection_mappings_write on public.connection_mappings;
create policy connection_mappings_write on public.connection_mappings
  for all to authenticated
  using (
    -- Which rows a member may change or remove: 0146's, unchanged.
    ( select public.has_org_role(connection_mappings.organization_id, 'manager') )
  )
  with check (
    -- CONJUNCT 1 of 2: a manager of the mapping's organization (0146).
    ( select public.has_org_role(connection_mappings.organization_id, 'manager') )

    -- CONJUNCT 2 of 2: the connection is the mapping's organization's, for
    -- every rank.
    and ( select public.connection_in_org(connection_mappings.connection_id, connection_mappings.organization_id) )
  );

drop policy if exists connection_sync_log_admin_replay on public.connection_sync_log;
create policy connection_sync_log_admin_replay on public.connection_sync_log
  for update to authenticated
  using (
    -- Which rows an admin may re-queue: 0152's, unchanged.
    ( select public.has_org_role(connection_sync_log.organization_id, 'admin') )
  )
  with check (
    -- CONJUNCT 1 of 4: an admin of the entry's organization (0152).
    ( select public.has_org_role(connection_sync_log.organization_id, 'admin') )

    -- CONJUNCT 2 of 4: the row is re-queued, nothing else (0152).
    and connection_sync_log.status = 'pending'

    -- CONJUNCTS 3 and 4 of 4: the connection and the queued event are the
    -- entry's organization's, for every rank.
    and ( select public.connection_in_org(connection_sync_log.connection_id, connection_sync_log.organization_id) )
    and ( select public.outbox_event_in_org(connection_sync_log.outbox_event_id, connection_sync_log.organization_id) )
  );

-- ═══ 4. tg_org_connection_secret_set ═══════════════════════════════════════
-- tg_organization_id_fixed's form (0462).
create function public.tg_org_connection_secret_set()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- See tg_ledger_only_guard for why the API roles are told apart this way.
  if current_user in ('authenticated', 'anon') then
    raise exception 'A connection''s stored secret is set by the server only.'
      using errcode = '42501';
  end if;

  if not public.connection_secret_is_own(new.secret_id, new.id, new.organization_id, new.provider_id) then
    raise exception 'A connection names only a secret stored for it.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Grants: no role needs EXECUTE. A trigger function fires without it, and
-- none of the API roles may call it.
revoke all on function public.tg_org_connection_secret_set() from public, anon, authenticated, service_role;

-- Named after 0463's trg_zz_org_connections_organization_fixed, so they run
-- after it and before 0393's zzz_deleted_users_* (which never change
-- secret_id). No column list: a change made by an earlier BEFORE trigger is
-- still seen.
create trigger trg_zz_org_connections_secret_insert
  before insert on public.org_connections
  for each row
  when (new.secret_id is not null)
  execute function public.tg_org_connection_secret_set();

create trigger trg_zz_org_connections_secret_update
  before update on public.org_connections
  for each row
  when (new.secret_id is distinct from old.secret_id and new.secret_id is not null)
  execute function public.tg_org_connection_secret_set();

-- ═══ 5. The Vault secret reads ══════════════════════════════════════════════
-- 0146's signature, language, SECURITY DEFINER and search_path; owner and
-- EXECUTE are kept by CREATE OR REPLACE and restated below.
create or replace function public.connector_secret_get(p_secret_id uuid)
returns jsonb language sql security definer set search_path = public, vault as $$
  select s.decrypted_secret::jsonb
    from vault.decrypted_secrets s
   where s.id = p_secret_id
     and s.name like 'connector:%'
     and not exists (
       select 1 from public.org_connections c
        where c.secret_id = s.id
          and s.name not in ('connector:' || c.id::text,
                             'connector:' || c.organization_id::text || ':' || c.provider_id)
     );
$$;

create or replace function public.connector_secret_delete(p_secret_id uuid)
returns void language sql security definer set search_path = public, vault as $$
  delete from vault.secrets s
   where s.id = p_secret_id
     and s.name like 'connector:%'
     and not exists (select 1 from public.org_connections c where c.secret_id = s.id);
$$;

-- EXECUTE as 0146 left it: service_role only.
revoke all on function public.connector_secret_get(uuid) from public, anon, authenticated;
grant execute on function public.connector_secret_get(uuid) to service_role;
revoke all on function public.connector_secret_delete(uuid) from public, anon, authenticated;
grant execute on function public.connector_secret_delete(uuid) to service_role;

-- ═══ 6. Comments ════════════════════════════════════════════════════════════
-- None of the texts names this file's number, so a rename leaves them (and
-- the md5s the test pins) alone.
comment on policy connection_mappings_write on public.connection_mappings is
  'A manager of the mapping''s organization adds, changes and removes its connection mappings; the connection is the '
  'mapping''s own organization''s (connection_in_org, for every rank).';

comment on policy connection_sync_log_admin_replay on public.connection_sync_log is
  'An admin of the entry''s organization re-queues a sync log entry (status pending only); its connection and queued '
  'event are the entry''s own organization''s (connection_in_org and outbox_event_in_org, for every rank).';

comment on function public.connection_in_org(uuid, uuid) is
  'NULL-safe: true when p_connection_id is NULL or names a connection of p_org_id. SECURITY DEFINER so a write rule can '
  'ask it whatever connections the writer may read; executable by authenticated and service_role.';

comment on function public.outbox_event_in_org(uuid, uuid) is
  'NULL-safe: true when p_event_id is NULL or names a queued event of p_org_id. SECURITY DEFINER so a write rule can '
  'ask it whatever events the writer may read; executable by authenticated and service_role.';

comment on function public.connection_secret_is_own(uuid, uuid, uuid, text) is
  'NULL-safe: true when p_secret_id is NULL or names the Vault secret stored for the connection (named '
  '''connector:<connection id>'', or ''connector:<organization id>:<provider>''). Reads names only. Executable by '
  'service_role only.';

comment on function public.tg_org_connection_secret_set() is
  'BEFORE INSERT and BEFORE UPDATE guard on org_connections (bound when secret_id is set to a secret): authenticated '
  'and anon never set it (42501); every other role sets only the Vault secret stored for the connection (42501). '
  'Clearing secret_id is not held. SECURITY INVOKER on purpose (a DEFINER trigger sees postgres).';

comment on function public.connector_secret_get(uuid) is
  'Service role only: the decrypted connector secret, or NULL when it is not a connector secret or a connection names '
  'it that it was not stored for.';

comment on function public.connector_secret_delete(uuid) is
  'Service role only: removes a connector secret once no connection names it (disconnect clears the row first).';

reset lock_timeout;
