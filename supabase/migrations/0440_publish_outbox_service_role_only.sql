-- publish_outbox is for the service role only, and the export queue has no
-- member write rule (docket S67, second of two releases).
--
-- outbox_events is the queue the connector drain reads (QuickBooks, Sage
-- Intacct, Zendesk). The web app records every export event through its
-- service client, from one helper (apps/web/src/server/lib/outbox-events.ts),
-- after the action that causes it and the permission check of that action
-- (the previous release, S67a). The database now says the same:
--
--   1. publish_outbox executes for the service role only. EXECUTE is revoked
--      from PUBLIC, anon and authenticated and granted to service_role.
--   2. Its body, before anything else, refuses with 42501 'forbidden' every
--      caller that is not the service role: a signed-in subject (auth.uid()
--      is not null), and any role claim other than service_role (auth.role()
--      reads request.jwt.claim.role, or the role in request.jwt.claims). So
--      the anon key, a member's session and a session that carries no claim
--      at all (a direct database session, a scheduled job, another function
--      called without the service role's claim) are refused, and the
--      function stays the service role's even if EXECUTE were granted again.
--      Through the Data API the service client's request carries the role
--      claim service_role and no subject; PostgREST switches to the role that
--      claim names, and only service_role holds EXECUTE. Then, as before: a
--      null organization is 22004 org_required, and the insert is idempotent
--      on (organization_id, dedupe_key).
--   3. outbox_events keeps its manager read rule (outbox_events_select) and
--      loses its admin write rule (outbox_events_write), which no app code
--      used. Every privilege on the table is revoked from anon and
--      authenticated, and authenticated is given back SELECT alone, which the
--      manager read rule needs; anon holds nothing. service_role's privileges
--      are stated: SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES,
--      TRIGGER and MAINTAIN, as it held them. The drain reads through
--      connector_drain_candidates, which is service role only.
--
-- Signature, result, volatility, SECURITY DEFINER, search_path and owner are
-- unchanged (CREATE OR REPLACE keeps the owner). The insert is the earlier
-- body's word for word; the only change to the body is the refusal of every
-- caller but the service role, which now comes first, where the earlier body
-- asked a signed-in caller for a staff membership of the organization. Nothing here names this file's
-- number, so the number it takes in ship order is a rename only.
--
-- -- WHO CHANGES TODAY ----------------------------------------------------
-- Nobody the apps serve. Every export event the app records goes through the
-- service client (no signed-in subject) since the previous release; no app
-- code reads or writes outbox_events with a member's client; the phone never
-- called publish_outbox (it reaches the same services through /api/v1). No
-- database function, trigger or scheduled job calls publish_outbox, and no
-- setup, repair or seed file does. A signed-in or anonymous call to
-- /rest/v1/rpc/publish_outbox, and a member's direct write on outbox_events,
-- is now refused with 42501.
--
-- ORDER: push this only after the release that moves every caller to the
-- service client is live (and pinned browser tabs of older deployments can
-- no longer reach the server); before it, a member-client call is refused
-- and its event is not recorded. For the same reason, once this is live no
-- deployment older than that release may be promoted or rolled back to.
--
--   0. Preflight: refuse (55000, hint s67_preflight, nothing applied) unless
--      publish_outbox is the earlier definition (body md5, definer, owner
--      postgres, search_path public, volatile; executable by authenticated
--      and service_role, not by anon), outbox_events has row security on and
--      exactly its two earlier rules, and its privileges are as 0402 left
--      them: service_role holds all eight; anon and authenticated hold
--      SELECT, INSERT, UPDATE and DELETE and either all of TRUNCATE,
--      REFERENCES, TRIGGER and MAINTAIN (0402) or none of them (the queued
--      grants cleanup revokes those four, so the two may ship in either
--      order); no other role holds any. A second run is refused here too.
--   1. The lock prelude (LOCKS below).
--   2. The function, its comment and its grants.
--   3. The table's write rule and write privileges.
--
-- -- LOCKS ----------------------------------------------------------------
-- DROP POLICY takes ACCESS EXCLUSIVE on outbox_events and, through supautils
-- (image 17.6.1.166), on every existing table supautils.policy_grants lists
-- for this role (auth, storage and realtime tables, auth.users and
-- auth.sessions among them). The preflight reads catalogs and deparses the
-- rules in a block that is always undone, so it ends holding no table lock.
-- So the prelude takes all of those tables at once, NOWAIT, retrying up to
-- 40 times with a 50 to 150 ms pause that holds nothing (the 0390, 0395,
-- 0400 and 0415 pattern), and no later statement takes a new table lock:
-- the file never waits while holding one, so it cannot deadlock. The
-- function statements open no table (the body declares no row type), and
-- COMMENT, GRANT and REVOKE on the function lock only the function, and
-- GRANT and REVOKE on the table add nothing to the prelude's lock. From the
-- prelude to the commit (ms) the service role's publishes and the drain's
-- candidate read wait, and so do sign-ins, token refreshes, and storage and
-- realtime requests. A call already running finishes on the body it started
-- with. lock_timeout 900ms bounds anything unforeseen. The lock footprint
-- script for this file in scripts/db-concurrency/ measures all of this.
--
-- -- DATA SAFETY ----------------------------------------------------------
-- No row of any table is written, changed or deleted, and no column or
-- table is dropped or changed. Rows already queued stay and drain as before.
--
-- -- ERRORS ---------------------------------------------------------------
-- 55000 hint s67_preflight: drift, or a second run; nothing applied.
-- 55P03: busy after 40 attempts, or the 900 ms cap; nothing applied, run it
-- again. Never 40001 or 40P01 (PostgREST retries those, 0367).

set lock_timeout = '900ms';

-- === 0. Preflight ===========================================================
do $pre_s67$
declare
  v_bad text := '';
  v_pol text;
  v_priv text;
  r     record;
begin
  -- publish_outbox is the earlier definition, with the earlier grants.
  select p.oid as poid, md5(p.prosrc) as got, p.prosecdef, p.provolatile::text as vol,
         pg_get_userbyid(p.proowner) as owner, p.proconfig,
         has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
         has_function_privilege('anon', p.oid, 'execute') as anon_x,
         has_function_privilege('service_role', p.oid, 'execute') as svc_x
    into r
    from pg_proc p
   where p.oid = to_regprocedure('public.publish_outbox(uuid,text,text,uuid,jsonb,text)');
  if r.poid is null then
    v_bad := v_bad || ' public.publish_outbox missing;';
  elsif r.got <> 'dcb4d2b1558f2bf5c8654a36157931c5' or not r.prosecdef or r.vol <> 'v'
     or r.owner <> 'postgres' or r.proconfig is distinct from array['search_path=public']
     or not r.auth_x or r.anon_x or not r.svc_x then
    v_bad := v_bad || format(' public.publish_outbox drifted (md5 %s, definer %s, volatile %s, owner %s, config %s, authenticated %s, anon %s, service_role %s);',
                             r.got, r.prosecdef, r.vol, r.owner, r.proconfig, r.auth_x, r.anon_x, r.svc_x);
  end if;

  -- outbox_events: row security on, and its rules are exactly the manager
  -- read rule and the admin write rule. Deparsed in a block that is always
  -- undone, with search_path pinned inside it, so the text does not depend
  -- on the session's search_path and nothing the deparse locks outlives the
  -- block. Variables keep their values when the block is undone.
  begin
    perform set_config('search_path', 'public, extensions', true);
    select string_agg(pol.polname || '|' || pol.polcmd::text || '|' || pol.polpermissive::text || '|'
                      || (select string_agg(case x when 0 then 'public' else x::regrole::text end, ',' order by 1)
                            from unnest(pol.polroles) x)
                      || '|' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '-')
                      || '|' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '-'), E'\n' order by pol.polname)
      into v_pol
      from pg_policy pol
     where pol.polrelid = to_regclass('public.outbox_events');
    raise exception using errcode = 'XX567', message = 'undo';
  exception when sqlstate 'XX567' then
    null;
  end;
  if v_pol is distinct from
       'outbox_events_select|r|true|authenticated'
       '|( SELECT has_org_role(outbox_events.organization_id, ''manager''::text) AS has_org_role)|-' || E'\n' ||
       'outbox_events_write|*|true|authenticated'
       '|( SELECT has_org_role(outbox_events.organization_id, ''admin''::text) AS has_org_role)'
       '|( SELECT has_org_role(outbox_events.organization_id, ''admin''::text) AS has_org_role)' then
    v_bad := v_bad || format(' public.outbox_events rules differ from the manager read rule and the admin write rule (%s);',
                             coalesce(v_pol, 'none'));
  end if;
  if not coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.outbox_events')), false) then
    v_bad := v_bad || ' public.outbox_events row security is off, or the table is gone;';
  end if;

  -- The table's privileges, all eight per role, and no other grantee than
  -- the owner and the three API roles.
  if to_regclass('public.outbox_events') is not null then
    select string_agg(g.r || ':' || coalesce((select string_agg(x.p, ',' order by x.n)
                                                 from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
                                                                   'REFERENCES', 'TRIGGER', 'MAINTAIN']) with ordinality x(p, n)
                                                where has_table_privilege(g.r, 'public.outbox_events', x.p)), '-'),
                      ' ' order by g.r)
      into v_priv
      from unnest(array['anon', 'authenticated', 'service_role']) g(r);
    if v_priv not in (
         'anon:SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
         ' authenticated:SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
         ' service_role:SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN',
         'anon:SELECT,INSERT,UPDATE,DELETE'
         ' authenticated:SELECT,INSERT,UPDATE,DELETE'
         ' service_role:SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') then
      v_bad := v_bad || format(' public.outbox_events privileges changed (%s);', v_priv);
    end if;
    if exists (select 1
                 from pg_class c, aclexplode(c.relacl) a
                where c.oid = 'public.outbox_events'::regclass
                  and a.grantee not in (c.relowner, 'anon'::regrole, 'authenticated'::regrole, 'service_role'::regrole)) then
      v_bad := v_bad || ' public.outbox_events privileges held by another grantee;';
    end if;
  end if;

  if v_bad <> '' then
    raise exception 's67_preflight:%', v_bad using errcode = '55000', hint = 's67_preflight';
  end if;
end
$pre_s67$;

-- === 1. The lock prelude (see LOCKS above) ==================================
-- Inside DO because the CLI batch is not a transaction block (a top-level
-- LOCK TABLE refuses there, 0373); the locks last until the batch commits.
--   * public.outbox_events: ACCESS EXCLUSIVE (its rule statement);
--   * every existing table supautils.policy_grants lists for this role, the
--     parent only of a partitioned one: ACCESS EXCLUSIVE (supautils takes it
--     whenever this role runs a rule statement).
-- A busy table fails the attempt at once; the rollback releases what it took
-- and the next attempt starts after 50 to 150 ms holding no table lock. After
-- the 40th busy attempt the 55P03 is raised as it is and nothing is applied.
do $lock_s67$
declare
  v_grants text := nullif(current_setting('supautils.policy_grants', true), '');
  v_name   text;
  v_rel    regclass;
  v_try    integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.outbox_events in access exclusive mode nowait;
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
end $lock_s67$;

-- === 2. The function ========================================================
create or replace function public.publish_outbox(
  p_org_id         uuid,
  p_topic          text,
  p_aggregate_type text,
  p_aggregate_id   uuid,
  p_payload        jsonb,
  p_dedupe_key     text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- Only the service role records export events (the web app's service
  -- client, after the action that causes them). Every other caller is
  -- refused: a signed-in subject, the anon key, and a session without the
  -- service role's claim.
  if auth.uid() is not null or coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_org_id is null then
    raise exception 'org_required' using errcode = '22004';
  end if;

  insert into public.outbox_events(
    organization_id, topic, aggregate_type, aggregate_id, dedupe_key, payload
  ) values (
    p_org_id, p_topic, p_aggregate_type, p_aggregate_id, p_dedupe_key, p_payload
  )
  on conflict (organization_id, dedupe_key) where dedupe_key is not null do nothing
  returning id into v_id;
  return v_id;
end;
$$;

comment on function public.publish_outbox(uuid, text, text, uuid, jsonb, text) is
  'Appends one event to outbox_events for the connector drain. Service role only: the web app records each event '
  'through its service client after the action that causes it (purchase order ordered, receipt posted, return '
  'created or closed, order denied, public request submitted). Any other caller, a signed-in subject, the anon '
  'key or a session without the service_role claim, is refused (42501 forbidden); a null organization is 22004 '
  'org_required. Idempotent on (organization_id, dedupe_key).';

revoke all on function public.publish_outbox(uuid, text, text, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.publish_outbox(uuid, text, text, uuid, jsonb, text) to service_role;

-- === 3. The table ===========================================================
-- outbox_events_select (manager read) stays; authenticated keeps SELECT for
-- it and nothing else, anon holds nothing, and service_role's privileges are
-- stated as it held them.
drop policy if exists outbox_events_write on public.outbox_events;
revoke all on table public.outbox_events from anon, authenticated;
grant select on table public.outbox_events to authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.outbox_events to service_role;

reset lock_timeout;
