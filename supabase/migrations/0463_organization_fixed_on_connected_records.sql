-- 0463_organization_fixed_on_connected_records.sql
--
-- A customer, a stored API key, a connection with its mappings and its sync
-- log entries, a notification endpoint, a public request link, a queued
-- event, a supplier and a charter stay in their organization: for the API
-- roles an update that changes organization_id is refused (42501). The guard
-- is 0462's tg_organization_id_fixed, unchanged, bound on each of these tables.
-- No row of any table changes, and no rule changes.
--
-- ── WHAT ──────────────────────────────────────────────────────────────────
-- One BEFORE UPDATE FOR EACH ROW trigger per table, bound with WHEN
-- (new.organization_id is distinct from old.organization_id), so an ordinary
-- update (a rename, an archive, the same organization_id sent again) never
-- enters the function. TG_ARGV[0] names the row in the message "A <label>
-- cannot be moved to another organization.":
--   public.customers              trg_zz_customers_organization_fixed              'customer'
--   public.api_keys               trg_zz_api_keys_organization_fixed               'stored API key'
--   public.org_connections        trg_zz_org_connections_organization_fixed        'connection'
--   public.connection_mappings    trg_zz_connection_mappings_organization_fixed    'connection mapping'
--   public.connection_sync_log    trg_zz_connection_sync_log_organization_fixed    'sync log entry'
--   public.integration_endpoints  trg_zz_integration_endpoints_organization_fixed  'notification endpoint'
--   public.public_request_links   trg_zz_public_request_links_organization_fixed   'public request link'
--   public.outbox_events          trg_zz_outbox_events_organization_fixed          'queued event'
--   public.suppliers              trg_zz_suppliers_organization_fixed              'supplier'
--   public.charters               trg_zz_charters_organization_fixed               'charter'
-- tg_organization_id_fixed (0462) raises only for authenticated and anon;
-- service_role, SECURITY DEFINER bodies owned by postgres and foreign key
-- actions are not held. No application code and no SQL function sends a
-- changed organization_id for any of these tables: the web's and the phone's
-- saves name the row in the active organization and leave organization_id
-- out, the connector upserts (organization_id, provider_id) and the drainer
-- (service role) writes rows of the connection's own organization, and an
-- organization is removed by delete (ON DELETE CASCADE), never by moving
-- its rows.
--
-- No column list: a change made by an earlier BEFORE trigger is still seen
-- (the WHEN is evaluated just before the function would run). The tables'
-- other BEFORE UPDATE triggers (tg_set_updated_at, and tg_mark_deleted_users
-- on org_connections) never change organization_id, so their order with
-- this one does not matter.
--
--   0. Preflight: refuse (55000, hint organization_fixed_preflight, nothing
--      applied) unless tg_organization_id_fixed is 0462's body (SECURITY
--      INVOKER, search_path public, owned by postgres, executable by no API
--      role) and none of the ten triggers exists, and no other trigger binds
--      the function on these tables.
--   1. The lock prelude (LOCKS below).
--   2. The ten triggers.
--
-- ── LOCKS ─────────────────────────────────────────────────────────────────
-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on its table and no other table
-- lock: no rule statement runs, so supautils takes nothing. SHARE ROW
-- EXCLUSIVE lets reads (ACCESS SHARE), SELECT ... FOR UPDATE / FOR SHARE
-- and the foreign key checks a child row's write takes on its parent (ROW
-- SHARE) go on; it waits for, and holds back, writes (ROW EXCLUSIVE) on the
-- ten tables. The preflight reads only catalogs. So the prelude takes the
-- ten tables at once, SHARE ROW EXCLUSIVE NOWAIT, parents before the tables
-- that name them (org_connections and outbox_events, then
-- connection_mappings and connection_sync_log), retrying up to 40 times with
-- a 50 to 150 ms pause that holds nothing (the 0390, 0395, 0420, 0421, 0423
-- and 0462 pattern), and no later statement takes a new table lock. A busy
-- table fails the whole attempt at once and its subtransaction releases what
-- it took, so the file never waits while holding a lock and cannot deadlock
-- (the order is for reading, not for safety). From the prelude to the
-- commit (milliseconds), writes to the ten tables wait for the hold; reads,
-- sign-ins, and storage and realtime requests do not. lock_timeout 900ms
-- bounds anything unforeseen.
--
-- ── ERRORS ────────────────────────────────────────────────────────────────
-- 55000 hint organization_fixed_preflight: drift, or a second run; nothing
-- applied. 55P03: busy after 40 attempts, or the 900 ms cap; nothing
-- applied, run it again. Afterwards an API-role update that changes the
-- organization of a row of these tables gets 42501. Never 40001 or 40P01
-- (PostgREST retries those, 0367).
--
-- ── ORDER ─────────────────────────────────────────────────────────────────
-- After 0462 (it creates tg_organization_id_fixed) and every lower number.

set lock_timeout = '900ms';

-- ═══ 0. Preflight ═══════════════════════════════════════════════════════════
do $pre_org_fixed$
declare
  v_bad text := '';
  v_fn  oid := to_regprocedure('public.tg_organization_id_fixed()');
  r     record;
begin
  -- md5(prosrc) of 0462's tg_organization_id_fixed, written in two halves.
  if v_fn is null then
    v_bad := v_bad || ' public.tg_organization_id_fixed() missing;';
  else
    select md5(p.prosrc) as got, p.prosecdef, pg_get_userbyid(p.proowner) as owner,
           coalesce(array_to_string(p.proconfig, ','), '-') as cfg,
           has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
           has_function_privilege('anon', p.oid, 'execute') as anon_x,
           has_function_privilege('service_role', p.oid, 'execute') as svc_x
      into r
      from pg_proc p where p.oid = v_fn;
    if r.got <> ('9054291fa6f24646' || 'ece8de5570134e38') or r.prosecdef or r.owner <> 'postgres'
       or r.cfg <> 'search_path=public' or r.auth_x or r.anon_x or r.svc_x then
      v_bad := v_bad || format(' public.tg_organization_id_fixed() drifted (md5 %s, definer %s, owner %s, config %s, authenticated %s, anon %s, service_role %s);',
                               r.got, r.prosecdef, r.owner, r.cfg, r.auth_x, r.anon_x, r.svc_x);
    end if;
  end if;

  -- None of the ten triggers exists yet, and the function is bound on none
  -- of the ten tables (a second run stops here).
  for r in
    select v.tbl, v.trg, c.oid as relid
      from (values
        ('public.customers',             'trg_zz_customers_organization_fixed'),
        ('public.api_keys',              'trg_zz_api_keys_organization_fixed'),
        ('public.org_connections',       'trg_zz_org_connections_organization_fixed'),
        ('public.connection_mappings',   'trg_zz_connection_mappings_organization_fixed'),
        ('public.connection_sync_log',   'trg_zz_connection_sync_log_organization_fixed'),
        ('public.integration_endpoints', 'trg_zz_integration_endpoints_organization_fixed'),
        ('public.public_request_links',  'trg_zz_public_request_links_organization_fixed'),
        ('public.outbox_events',         'trg_zz_outbox_events_organization_fixed'),
        ('public.suppliers',             'trg_zz_suppliers_organization_fixed'),
        ('public.charters',              'trg_zz_charters_organization_fixed')
      ) v(tbl, trg)
      left join pg_class c on c.oid = to_regclass(v.tbl)
  loop
    if r.relid is null then
      v_bad := v_bad || format(' %s missing;', r.tbl);
    else
      if exists (select 1 from pg_trigger t where t.tgrelid = r.relid and t.tgname = r.trg) then
        v_bad := v_bad || format(' %s already exists on %s;', r.trg, r.tbl);
      end if;
      if v_fn is not null and exists (select 1 from pg_trigger t where t.tgrelid = r.relid and t.tgfoid = v_fn) then
        v_bad := v_bad || format(' tg_organization_id_fixed is already bound on %s;', r.tbl);
      end if;
    end if;
  end loop;

  if v_bad <> '' then
    raise exception 'organization_fixed_preflight:%', v_bad using errcode = '55000', hint = 'organization_fixed_preflight';
  end if;
end
$pre_org_fixed$;

-- ═══ 1. The lock prelude (see LOCKS above) ══════════════════════════════════
-- Inside DO because the CLI batch is not a transaction block (a top-level
-- LOCK TABLE refuses there, 0373); the locks last until the batch commits.
-- A busy table fails the attempt at once; the rollback releases what it took
-- and the next attempt starts after 50 to 150 ms holding no table lock. After
-- the 40th busy attempt the 55P03 is raised as it is and nothing is applied.
do $lock_org_fixed$
declare
  v_try integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.customers, public.api_keys, public.org_connections, public.outbox_events,
                      public.connection_mappings, public.connection_sync_log, public.integration_endpoints,
                      public.public_request_links, public.suppliers, public.charters
        in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if v_try >= 40 then
        raise;
      end if;
    end;
    perform pg_sleep(0.05 + random() * 0.1);
  end loop;
end $lock_org_fixed$;

-- ═══ 2. The ten triggers ════════════════════════════════════════════════════
create trigger trg_zz_customers_organization_fixed
  before update on public.customers
  for each row
  when (new.organization_id is distinct from old.organization_id)
  execute function public.tg_organization_id_fixed('customer');

create trigger trg_zz_api_keys_organization_fixed
  before update on public.api_keys
  for each row
  when (new.organization_id is distinct from old.organization_id)
  execute function public.tg_organization_id_fixed('stored API key');

create trigger trg_zz_org_connections_organization_fixed
  before update on public.org_connections
  for each row
  when (new.organization_id is distinct from old.organization_id)
  execute function public.tg_organization_id_fixed('connection');

create trigger trg_zz_connection_mappings_organization_fixed
  before update on public.connection_mappings
  for each row
  when (new.organization_id is distinct from old.organization_id)
  execute function public.tg_organization_id_fixed('connection mapping');

create trigger trg_zz_connection_sync_log_organization_fixed
  before update on public.connection_sync_log
  for each row
  when (new.organization_id is distinct from old.organization_id)
  execute function public.tg_organization_id_fixed('sync log entry');

create trigger trg_zz_integration_endpoints_organization_fixed
  before update on public.integration_endpoints
  for each row
  when (new.organization_id is distinct from old.organization_id)
  execute function public.tg_organization_id_fixed('notification endpoint');

create trigger trg_zz_public_request_links_organization_fixed
  before update on public.public_request_links
  for each row
  when (new.organization_id is distinct from old.organization_id)
  execute function public.tg_organization_id_fixed('public request link');

create trigger trg_zz_outbox_events_organization_fixed
  before update on public.outbox_events
  for each row
  when (new.organization_id is distinct from old.organization_id)
  execute function public.tg_organization_id_fixed('queued event');

create trigger trg_zz_suppliers_organization_fixed
  before update on public.suppliers
  for each row
  when (new.organization_id is distinct from old.organization_id)
  execute function public.tg_organization_id_fixed('supplier');

create trigger trg_zz_charters_organization_fixed
  before update on public.charters
  for each row
  when (new.organization_id is distinct from old.organization_id)
  execute function public.tg_organization_id_fixed('charter');

reset lock_timeout;
