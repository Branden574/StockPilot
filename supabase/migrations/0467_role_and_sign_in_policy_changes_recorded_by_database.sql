-- 0467_role_and_sign_in_policy_changes_recorded_by_database.sql
--
-- The database writes the audit row for two changes itself, in the
-- transaction of the change:
--   * an organization's sign-in policy (organizations.mfa_policy): one row,
--     event organization.mfa_policy.changed;
--   * a member's role (organization_members.role): one row, event
--     user.role.changed.
-- The app's own row for a change the database recorded is accepted and not
-- stored a second time. No stored row of any table changes, by this file or
-- by the functions it creates: none of them holds an UPDATE or a DELETE.
--
-- ── WHAT ──────────────────────────────────────────────────────────────────
-- 1. The two recorders.
--      public.tg_record_mfa_policy_change(), run by
--        trg_zz_record_mfa_policy_change AFTER UPDATE ON public.organizations
--        FOR EACH ROW WHEN (old.mfa_policy is distinct from new.mfa_policy);
--      public.tg_record_member_role_change(), run by
--        trg_zz_record_member_role_change AFTER UPDATE ON
--        public.organization_members
--        FOR EACH ROW WHEN (old.role is distinct from new.role).
--    Row triggers with no column list: the WHEN compares the stored value
--    with the new one, so a value set by any statement, or by an earlier
--    trigger, is recorded, and a save of the same value writes nothing. One
--    row per changed row.
--
--    The row carries the keys the app's audit rows carry (entity_type,
--    entity_id, warehouse_id, before, after, reason), so the audit pages and
--    the role monitor read it as they read the app's:
--      organization_id    the organization
--      user_id            the token's subject when it is an account
--                         (auth.uid(), looked up in user_profiles), else null
--      ip, user_agent     null: the database is called by the Data API
--                         server, not by the person's device
--      entity_type / id   organization / its id;
--                         organization_member / the membership's id
--      before / after     {"mfa_policy": ...}; {"role": ...}
--      source             'database'
--      made_as            the caller's role: 'authenticated', 'service_role',
--                         or 'direct' for anything else (a migration,
--                         support SQL). Read from the role setting, which
--                         names the caller inside a SECURITY DEFINER body
--                         too (0413)
--      aal                the token's aal claim, or null
--      target_user_id     (roles only) the member whose role changed
--      created_at         the table default: the time of the change's
--                         transaction
--
--    SECURITY DEFINER, owned by postgres: audit_logs has row level security
--    with a SELECT rule only, so no API role inserts there, and the recorder
--    writes as the table's owner (the shape of 0345's email-change
--    recorder). search_path is empty and every name is schema-qualified.
--    EXECUTE is revoked from PUBLIC, anon, authenticated and service_role:
--    the functions run only as triggers. If the audit row cannot be written
--    the change is refused: the change and its record are one transaction.
--
--    Rows with no actor come from the service role and from direct SQL.
--    transfer_org_ownership leaves two (the previous owner's and the new
--    owner's), beside the app's own ownership-transfer row, which names the
--    people. An invitation accepted onto an existing membership leaves one
--    when the role differs. A migration that changes either column leaves
--    one per changed row, made_as 'direct'.
--
-- 2. The app's row.
--      public.tg_audit_logs_fold_app_copy(), run by zz_fold_app_copy BEFORE
--        INSERT ON public.audit_logs FOR EACH ROW
--        WHEN (new.event in ('user.role.changed',
--                            'organization.mfa_policy.changed')).
--    The app writes an audit row of its own after it changes a role or the
--    policy. One change is one row (the role monitor counts rows), so for a
--    row inserted as service_role (the app's audit writer) the trigger looks
--    for a row the database recorded for the same change:
--      the same organization and event;
--      the same entity id, the app's compared in lower case;
--      source 'database';
--      the same before and the same after;
--      the same actor (IS NOT DISTINCT FROM);
--      recorded within the last ten minutes (longer than the app's writer
--      keeps trying).
--    When there is one, the trigger returns NULL: the app's row is not
--    stored, and the insert reports success, on a first try and on every
--    later try (INSERT ... ON CONFLICT (id) DO NOTHING) alike. Otherwise the
--    row is stored exactly as it was sent, so a row the database did not
--    record is never dropped. Rows of other events never reach the function;
--    rows inserted by any other role (the recorders, a restore, support SQL)
--    pass through it.
--
--    The function reads audit_logs and writes nothing: no stored audit row
--    is ever updated or deleted. SECURITY INVOKER on purpose, so that
--    current_user is the role that sends the row (the 0218 form);
--    search_path empty; EXECUTE revoked from the same four roles (a trigger
--    function needs none). The lookup is served by
--    audit_logs_org_entity_created_idx (0272).
--
--    The recorded row has no address and no browser (see 1), so an audit
--    row for one of these two changes no longer shows them.
--
--    THE NAME. zzz_deleted_users_ins (0393) stays the last BEFORE INSERT
--    row trigger on audit_logs by name; 0393's test K7 pins that.
--    zz_fold_app_copy sorts before it ('_' is below 'z' in "C"). A new name
--    must sort before zzz_ as well.
--
-- 3. One transaction. The push sends this file as one batch, so the three
--    triggers appear together; the rollback drops them together. A later
--    migration that changes zz_fold_app_copy's events drops and creates it
--    in one transaction as well. (The recorders without zz_fold_app_copy
--    would store two rows for a change made in the app.)
--
--   0. Preflight: refuse (55000, hint recorded_changes_preflight, nothing
--      applied) unless the three function names and the three trigger names
--      are free; audit_logs is owned by postgres, the role running this file,
--      with row level security on, not forced, and no rule other than
--      SELECT; the columns the functions name exist; auth.uid() and
--      auth.jwt() exist and this role may call them; service_role may
--      insert into and read audit_logs past row level security; and
--      audit_logs_org_entity_created_idx is there and valid.
--   1. The lock prelude (LOCKS below).
--   2. The three functions, each with its REVOKE.
--   3. The three triggers.
--   4. Comments on each function and each trigger.
--
-- ── LOCKS ─────────────────────────────────────────────────────────────────
-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on its table: writers of
-- public.organizations, public.organization_members and public.audit_logs
-- wait for the hold, readers do not (the membership reads inside row rules
-- among them). There is no rule statement, so supautils takes nothing. The
-- preflight reads catalogs only. CREATE FUNCTION, REVOKE and COMMENT ON
-- FUNCTION take no table lock; COMMENT ON TRIGGER takes a weaker lock on a
-- table the prelude already holds. So the prelude takes the three tables at
-- once, NOWAIT, retrying up to 40 times with a 50 to 150 ms pause that holds
-- nothing (the 0390, 0395, 0420, 0421 and 0423 pattern), and no later
-- statement takes a new table lock: the file never waits while holding one,
-- so it cannot deadlock. From the prelude to the commit (milliseconds),
-- writes to the three tables wait for the hold; an audit write that waits is
-- sent again by the app's writer. A running ANALYZE or autovacuum on one of
-- the three tables conflicts with the lock and NOWAIT never cancels it: the
-- file then ends 55P03 with nothing applied. lock_timeout 900ms bounds
-- anything unforeseen.
--
-- ── ERRORS ────────────────────────────────────────────────────────────────
-- 55000 hint recorded_changes_preflight: drift, or a second run; nothing
-- applied. 55P03: busy after 40 attempts, or the 900 ms cap; nothing applied,
-- run it again. Afterwards no caller gets a new error. Never 40001 or 40P01
-- (PostgREST retries those, 0367).
--
-- ── ORDER ─────────────────────────────────────────────────────────────────
-- After every lower number. No queued migration creates a function or a
-- trigger with one of these six names, or changes audit_logs' rules, owner
-- or row level security.

set lock_timeout = '900ms';

-- ═══ 0. Preflight ═══════════════════════════════════════════════════════════
do $pre_rec$
declare
  v_bad text := '';
  v_n   integer;
  r     record;
begin
  -- The three function names are free, whatever the arguments.
  for r in
    select p.oid::regprocedure::text as sig
      from pg_proc p
     where p.pronamespace = to_regnamespace('public')
       and p.proname in ('tg_record_mfa_policy_change', 'tg_record_member_role_change', 'tg_audit_logs_fold_app_copy')
  loop
    v_bad := v_bad || format(' function %s exists already;', r.sig);
  end loop;

  -- The three trigger names are free on their tables.
  for r in
    select v.tbl, v.trg
      from (values
        ('public.organizations',        'trg_zz_record_mfa_policy_change'),
        ('public.organization_members', 'trg_zz_record_member_role_change'),
        ('public.audit_logs',           'zz_fold_app_copy')
      ) v(tbl, trg)
      join pg_trigger t on t.tgrelid = to_regclass(v.tbl) and t.tgname = v.trg and not t.tgisinternal
  loop
    v_bad := v_bad || format(' trigger %s on %s exists already;', r.trg, r.tbl);
  end loop;

  -- The columns the functions name.
  for r in
    select v.tbl, v.col
      from (values
        ('public.audit_logs', 'organization_id'), ('public.audit_logs', 'user_id'), ('public.audit_logs', 'event'),
        ('public.audit_logs', 'metadata'), ('public.audit_logs', 'created_at'),
        ('public.organizations', 'id'), ('public.organizations', 'mfa_policy'),
        ('public.organization_members', 'id'), ('public.organization_members', 'organization_id'),
        ('public.organization_members', 'user_id'), ('public.organization_members', 'role'),
        ('public.user_profiles', 'id')
      ) v(tbl, col)
     where not exists (select 1 from pg_attribute a
                        where a.attrelid = to_regclass(v.tbl) and a.attname = v.col
                          and a.attnum > 0 and not a.attisdropped)
  loop
    v_bad := v_bad || format(' column %s.%s is missing;', r.tbl, r.col);
  end loop;

  -- audit_logs: owned by postgres, which is the role running this file (the
  -- recorders write as their owner, the table's owner); row level security
  -- on and not forced; no rule other than SELECT.
  select c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner)::text as owner
    into r
    from pg_class c
   where c.oid = to_regclass('public.audit_logs');
  if not found then
    v_bad := v_bad || ' public.audit_logs is missing;';
  elsif r.owner <> 'postgres' or r.owner <> current_user::text or not r.relrowsecurity or r.relforcerowsecurity then
    v_bad := v_bad || format(' public.audit_logs is not as expected (owner %s, this role %s, row level security %s, forced %s);',
                             r.owner, current_user::text, r.relrowsecurity, r.relforcerowsecurity);
  end if;
  select count(*) into v_n
    from pg_policy pol
   where pol.polrelid = to_regclass('public.audit_logs') and pol.polcmd <> 'r';
  if v_n <> 0 then
    v_bad := v_bad || format(' public.audit_logs has %s rule(s) other than SELECT;', v_n);
  end if;

  -- auth.uid() and auth.jwt(), callable by this role.
  if to_regprocedure('auth.uid()') is null or to_regprocedure('auth.jwt()') is null then
    v_bad := v_bad || ' auth.uid() or auth.jwt() is missing;';
  elsif not has_function_privilege(current_user, to_regprocedure('auth.uid()'), 'execute')
        or not has_function_privilege(current_user, to_regprocedure('auth.jwt()'), 'execute') then
    v_bad := v_bad || ' this role may not call auth.uid() or auth.jwt();';
  end if;

  -- service_role (the app's audit writer) inserts into audit_logs and reads
  -- it past row level security.
  select ro.rolbypassrls,
         coalesce(has_table_privilege(ro.oid, to_regclass('public.audit_logs'), 'insert'), false) as can_insert,
         coalesce(has_table_privilege(ro.oid, to_regclass('public.audit_logs'), 'select'), false) as can_select
    into r
    from pg_roles ro
   where ro.rolname = 'service_role';
  if not found then
    v_bad := v_bad || ' role service_role is missing;';
  elsif not r.rolbypassrls or not r.can_insert or not r.can_select then
    v_bad := v_bad || format(' service_role is not as expected on public.audit_logs (bypasses row level security %s, insert %s, select %s);',
                             r.rolbypassrls, r.can_insert, r.can_select);
  end if;

  -- The index the lookup uses.
  if not exists (select 1 from pg_index i
                  where i.indexrelid = to_regclass('public.audit_logs_org_entity_created_idx')
                    and i.indrelid = to_regclass('public.audit_logs')
                    and i.indisvalid and i.indisready) then
    v_bad := v_bad || ' index public.audit_logs_org_entity_created_idx is missing or not valid;';
  end if;

  if v_bad <> '' then
    raise exception 'recorded_changes_preflight:%', v_bad using errcode = '55000', hint = 'recorded_changes_preflight';
  end if;
end
$pre_rec$;

-- ═══ 1. The lock prelude (see LOCKS above) ══════════════════════════════════
-- Inside DO because the CLI batch is not a transaction block (a top-level
-- LOCK TABLE refuses there, 0373); the locks last until the batch commits.
-- SHARE ROW EXCLUSIVE on the three tables, the mode CREATE TRIGGER takes. A
-- busy table fails the attempt at once; the rollback releases what it took
-- and the next attempt starts after 50 to 150 ms holding no table lock. After
-- the 40th busy attempt the 55P03 is raised as it is and nothing is applied.
do $lock_rec$
declare
  v_try integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.organizations, public.organization_members, public.audit_logs
        in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if v_try >= 40 then
        raise;
      end if;
    end;
    perform pg_sleep(0.05 + random() * 0.1);
  end loop;
end $lock_rec$;

-- ═══ 2. The functions ═══════════════════════════════════════════════════════
create function public.tg_record_mfa_policy_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- The caller's role. The role setting names it here too, where
  -- current_user is this function's owner.
  v_role text := coalesce(nullif(current_setting('role', true), ''), 'none');
begin
  -- The audit row of this change, in the change's own transaction. The
  -- actor is the token's subject when it is an account, else null.
  insert into public.audit_logs (organization_id, user_id, event, metadata)
  values (
    new.id,
    (select p.id from public.user_profiles p where p.id = auth.uid()),
    'organization.mfa_policy.changed',
    jsonb_build_object(
      'entity_type',  'organization',
      'entity_id',    new.id,
      'warehouse_id', null,
      'before',       jsonb_build_object('mfa_policy', old.mfa_policy),
      'after',        jsonb_build_object('mfa_policy', new.mfa_policy),
      'reason',       null,
      'source',       'database',
      'made_as',      case when v_role in ('authenticated', 'service_role') then v_role else 'direct' end,
      'aal',          auth.jwt() ->> 'aal'
    )
  );
  return null;
end;
$$;

revoke all on function public.tg_record_mfa_policy_change() from public, anon, authenticated, service_role;

create function public.tg_record_member_role_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- The caller's role. The role setting names it here too, where
  -- current_user is this function's owner.
  v_role text := coalesce(nullif(current_setting('role', true), ''), 'none');
begin
  -- The audit row of this change, in the change's own transaction. The
  -- actor is the token's subject when it is an account, else null; the
  -- member whose role changed is target_user_id.
  insert into public.audit_logs (organization_id, user_id, event, metadata)
  values (
    new.organization_id,
    (select p.id from public.user_profiles p where p.id = auth.uid()),
    'user.role.changed',
    jsonb_build_object(
      'entity_type',    'organization_member',
      'entity_id',      new.id,
      'warehouse_id',   null,
      'before',         jsonb_build_object('role', old.role),
      'after',          jsonb_build_object('role', new.role),
      'reason',         null,
      'source',         'database',
      'made_as',        case when v_role in ('authenticated', 'service_role') then v_role else 'direct' end,
      'aal',            auth.jwt() ->> 'aal',
      'target_user_id', new.user_id
    )
  );
  return null;
end;
$$;

revoke all on function public.tg_record_member_role_change() from public, anon, authenticated, service_role;

create function public.tg_audit_logs_fold_app_copy()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Only a row sent as service_role (the app's audit writer) is judged.
  -- SECURITY INVOKER on purpose: current_user is the role that sends the
  -- row. The recorders write as their owner and pass here.
  if current_user <> 'service_role' then
    return new;
  end if;

  -- A row the database recorded for the same change: the same organization,
  -- event, entity id (the app's in lower case), before, after and actor,
  -- within the last ten minutes.
  if exists (
    select 1
      from public.audit_logs a
     where a.organization_id = new.organization_id
       and a.event = new.event
       and (a.metadata ->> 'entity_id') = lower(new.metadata ->> 'entity_id')
       and (a.metadata ->> 'source') = 'database'
       and (a.metadata -> 'before') = (new.metadata -> 'before')
       and (a.metadata -> 'after') = (new.metadata -> 'after')
       and a.user_id is not distinct from new.user_id
       and a.created_at >= now() - interval '10 minutes'
  ) then
    -- Recorded already: this row is not stored. No stored row changes.
    return null;
  end if;

  -- Not recorded by the database: stored as it was sent.
  return new;
end;
$$;

revoke all on function public.tg_audit_logs_fold_app_copy() from public, anon, authenticated, service_role;

-- ═══ 3. The triggers ════════════════════════════════════════════════════════
create trigger trg_zz_record_mfa_policy_change
  after update on public.organizations
  for each row
  when (old.mfa_policy is distinct from new.mfa_policy)
  execute function public.tg_record_mfa_policy_change();

create trigger trg_zz_record_member_role_change
  after update on public.organization_members
  for each row
  when (old.role is distinct from new.role)
  execute function public.tg_record_member_role_change();

-- The name sorts before zzz_deleted_users_ins (see THE NAME above).
create trigger zz_fold_app_copy
  before insert on public.audit_logs
  for each row
  when (new.event in ('user.role.changed', 'organization.mfa_policy.changed'))
  execute function public.tg_audit_logs_fold_app_copy();

-- ═══ 4. Comments ════════════════════════════════════════════════════════════
-- None of the texts names this file's number, so a rename leaves them alone.
comment on function public.tg_record_mfa_policy_change() is
  'AFTER UPDATE row trigger on organizations: when mfa_policy changes, writes the audit row '
  '(organization.mfa_policy.changed) in the same transaction: actor from the token (null for the service role and '
  'direct SQL), before, after, source database, made_as, aal; no address or browser. SECURITY DEFINER (audit_logs '
  'takes inserts from its owner only); runs only as a trigger.';

comment on function public.tg_record_member_role_change() is
  'AFTER UPDATE row trigger on organization_members: when role changes, writes the audit row (user.role.changed) in '
  'the same transaction: actor from the token (null for the service role and direct SQL), the membership as the '
  'entity, target_user_id, before, after, source database, made_as, aal; no address or browser. SECURITY DEFINER '
  '(audit_logs takes inserts from its owner only); runs only as a trigger.';

comment on function public.tg_audit_logs_fold_app_copy() is
  'BEFORE INSERT row trigger on audit_logs for user.role.changed and organization.mfa_policy.changed: a row sent as '
  'service_role is not stored when the database recorded the same change (organization, event, entity id without '
  'regard to case, before, after, actor) within the last ten minutes; any other row is stored as sent. Reads '
  'audit_logs and writes nothing: no stored row is updated or deleted. SECURITY INVOKER on purpose (current_user is '
  'the sender).';

comment on trigger trg_zz_record_mfa_policy_change on public.organizations is
  'Records a change of mfa_policy in audit_logs, in the transaction of the change. No column list: the WHEN compares '
  'the stored value with the new one, whichever statement or trigger set it.';

comment on trigger trg_zz_record_member_role_change on public.organization_members is
  'Records a change of role in audit_logs, in the transaction of the change. No column list: the WHEN compares the '
  'stored value with the new one, whichever statement or trigger set it.';

comment on trigger zz_fold_app_copy on public.audit_logs is
  'Keeps one audit row per role or sign-in policy change: the app''s row for a change the database recorded is not '
  'stored. Created and dropped together with the two recording triggers. The name sorts before '
  'zzz_deleted_users_ins, which stays the last BEFORE INSERT row trigger by name.';

reset lock_timeout;
