-- supabase/tests/NNNN_cycle_count_assignment_member_lookup.test.sql (NNNN =
-- the migration's number, given in ship order; nothing in this file reads it)
-- pgTAP proof for the S87 migration: release_cycle_count, assign_cycle_count
-- and force_reassign_cycle_count look the count up in the organizations the
-- caller is an active member of first, and answer a count outside them as an
-- id that does not exist (P0002 cycle_count_not_found, no detail, no hint).
-- The status and permission checks come after that, and every answer a member
-- of the count's organization got is kept.
--
-- "Active member" is is_org_member (0310), the helper the three bodies use:
-- an accepted membership whose "act as" seat has not expired, of an account
-- that is not disabled. So a member removed from the organization, a disabled
-- account, an expired "act as" seat and an invitation not yet accepted are
-- outside, as are another organization's manager and an account with no
-- organization (F1 pins the helper for each).
--
-- Personas (organization A unless named):
--   mgr     manager
--   asg     staff assigned to warehouse A, the assignee of cAsg and cDone
--   stf     staff assigned to warehouse A, assignee of nothing
--   vwr     viewer assigned to warehouse A
--   outZ    a manager of organization Z
--   rmv     a manager of organization A, then removed (as Team removes a
--           member); still staff of organization Z
--   dis     a manager of organization A whose account is then disabled
--   exp     an "act as" seat in organization A (an owner row) that expired
--   pend    invited to organization A as a manager, not yet accepted
--   nobody  signed in, a member of no organization
-- Counts of organization A: cUn (in progress, no assignee), cAsg (in
-- progress, assigned to asg), cDone (completed, assigned to asg). cZ is an
-- in-progress count of organization Z with no assignee. cRnd is an id no
-- count has.
--
-- F.  The fixture is what the matrices assume.
-- O.  Outside the count's organization: every persona outside it gets one
--     and the same answer from each function for cUn, cAsg, cDone and cRnd
--     (P0002 cycle_count_not_found, no detail, no hint), and so does
--     organization A's manager for organization Z's count.
-- I.  Inside: the answers a member of the count's organization gets are
--     pinned (success, the permission refusal, the status refusal with its
--     detail, the assignee refusal, the reason refusals, not found for an
--     unknown id), and a signed-out call is refused first, as before.
-- R.  One change per function: md5(prosrc) is the new body's, and taking
--     the one block tagged "S87" out gives the body it replaced exactly.
-- C.  The block comes before the row lock and before every status or
--     permission check in each body.
-- P.  Each function keeps its posture (arguments, result, volatility,
--     SECURITY DEFINER, search_path, owner, EXECUTE), and release's comment
--     says the not-found rule in words.
-- M.  Mutation: each body with the S87 block taken out (inside an undone
--     attempt) gives callers outside the organization more than one answer,
--     so the O lines are not tautological.
-- Q.  The migration's preflight, replayed: it passes on the bodies it
--     replaced and stops (55000) on any other body (the new ones).
-- G.  No body names 40001 or 40P01.
-- Z.  Every undone attempt changed nothing.
--
-- Roles: fixtures as the test superuser. Every call runs through
-- pg_temp.attempt (always undone), which switches role and claims with
-- set_config inside a subtransaction, so the pgTAP bookkeeping never runs as
-- an API role. begin/rollback: nothing leaks. Namespace 58700000; undo code
-- XXS87.

begin;

select plan(22);

\set orgA   '\'58700000-0000-0000-0000-00000000000a\''
\set orgZ   '\'58700000-0000-0000-0000-00000000000b\''
\set mgr    '\'58700000-0000-0000-0000-0000000000a1\''
\set asg    '\'58700000-0000-0000-0000-0000000000a2\''
\set stf    '\'58700000-0000-0000-0000-0000000000a3\''
\set vwr    '\'58700000-0000-0000-0000-0000000000a4\''
\set outZ   '\'58700000-0000-0000-0000-0000000000b1\''
\set rmv    '\'58700000-0000-0000-0000-0000000000b2\''
\set dis    '\'58700000-0000-0000-0000-0000000000b3\''
\set exp    '\'58700000-0000-0000-0000-0000000000b4\''
\set pend   '\'58700000-0000-0000-0000-0000000000b5\''
\set nobody '\'58700000-0000-0000-0000-0000000000c1\''
\set whA    '\'58700000-0000-0000-0000-0000000000d1\''
\set whZ    '\'58700000-0000-0000-0000-0000000000d2\''
\set cUn    '\'58700000-0000-0000-0000-000000000101\''
\set cAsg   '\'58700000-0000-0000-0000-000000000102\''
\set cDone  '\'58700000-0000-0000-0000-000000000103\''
\set cZ     '\'58700000-0000-0000-0000-000000000104\''
\set cRnd   '\'58700000-0000-0000-0000-0000000001ff\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr,    's87-mgr@s87.test',    '{}'::jsonb),
  (:asg,    's87-asg@s87.test',    '{}'::jsonb),
  (:stf,    's87-stf@s87.test',    '{}'::jsonb),
  (:vwr,    's87-vwr@s87.test',    '{}'::jsonb),
  (:outZ,   's87-outz@s87.test',   '{}'::jsonb),
  (:rmv,    's87-rmv@s87.test',    '{}'::jsonb),
  (:dis,    's87-dis@s87.test',    '{}'::jsonb),
  (:exp,    's87-exp@s87.test',    '{}'::jsonb),
  (:pend,   's87-pend@s87.test',   '{}'::jsonb),
  (:nobody, 's87-nobody@s87.test', '{}'::jsonb)
  on conflict (id) do nothing;
-- An org insert enables the default modules (cycle counts among them).
insert into public.organizations (id, name, slug) values
  (:orgA, 'S87 Count Org A', 's87-count-org-a'),
  (:orgZ, 'S87 Count Org Z', 's87-count-org-z');
insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at) values
  (:orgA, :mgr,  'manager', now(), null),
  (:orgA, :asg,  'staff',   now(), null),
  (:orgA, :stf,  'staff',   now(), null),
  (:orgA, :vwr,  'viewer',  now(), null),
  (:orgA, :rmv,  'manager', now(), null),
  (:orgA, :dis,  'manager', now(), null),
  (:orgA, :exp,  'owner',   now(), now() - interval '1 hour'),
  (:orgA, :pend, 'manager', null,  null),
  (:orgZ, :outZ, 'manager', now(), null),
  (:orgZ, :rmv,  'staff',   now(), null);
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgA, 'S87 Main', 'WH-S87A', 'active'),
  (:whZ, :orgZ, 'S87 Zed',  'WH-S87Z', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :asg, :whA, true),
  (:orgA, :stf, :whA, true),
  (:orgA, :vwr, :whA, true);

-- The counts, inserted by the superuser (the status guard holds API roles
-- only; the assignment notice fires on UPDATE only).
insert into public.cycle_counts
  (id, organization_id, warehouse_id, status, started_by, assigned_to, assignment_claimed_at,
   assignment_claimed_by, assignment_version, completed_at, completed_by) values
  (:cUn,   :orgA, :whA, 'in_progress', :mgr,  null, null,  null,  0, null,  null),
  (:cAsg,  :orgA, :whA, 'in_progress', :mgr,  :asg, now(), :mgr,  1, null,  null),
  (:cDone, :orgA, :whA, 'completed',   :mgr,  :asg, now(), :mgr,  1, now(), :mgr),
  (:cZ,    :orgZ, :whZ, 'in_progress', :outZ, null, null,  null,  0, null,  null);

-- rmv leaves organization A as Team removes a member (the membership row);
-- dis is disabled as the account-disable service does it (user_profiles
-- disabled_at, written as service_role).
delete from public.organization_members where organization_id = :orgA and user_id = :rmv;
set local role to 'service_role';
update public.user_profiles set disabled_at = now(), disabled_reason = 'policy_violation' where id = :dis;
reset role;

-- ══ Helpers ═══════════════════════════════════════════════════════════════
create temp table persona (who text primary key, id uuid);
insert into persona (who, id) values
  ('mgr', :mgr), ('asg', :asg), ('stf', :stf), ('vwr', :vwr), ('outZ', :outZ), ('rmv', :rmv),
  ('dis', :dis), ('exp', :exp), ('pend', :pend), ('nobody', :nobody);
create temp table cc (label text primary key, id uuid);
insert into cc (label, id) values
  ('cUn', :cUn), ('cAsg', :cAsg), ('cDone', :cDone), ('cZ', :cZ), ('cRnd', :cRnd);

-- A count's assignment columns, '-' for null: assignee/claimed by/version.
create function pg_temp.assignment(p_count uuid) returns text language sql stable as $$
  select coalesce((select p.who from persona p where p.id = c.assigned_to), '-')
         || '/' || coalesce((select p.who from persona p where p.id = c.assignment_claimed_by), '-')
         || '/' || c.assignment_version::text
    from public.cycle_counts c where c.id = p_count
$$;
-- One statement as authenticated with p_sub's claims (null: no sub claim),
-- then ALWAYS undone. 'ok' (plus ':' and p_check's value, read as the
-- superuser inside the undone subtransaction), else
-- '<sqlstate>|<message>|<detail or ->|<hint or ->'. p_prep runs first, as
-- the superuser, inside the same undone subtransaction (the M-section's
-- mutation). supautils' generic privilege hint reads as '-'.
create function pg_temp.attempt(p_sub uuid, p_sql text, p_prep text default null, p_check text default null)
returns text language plpgsql as $$
declare v_state text; v_msg text; v_det text; v_hint text; v_seen text;
begin
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    perform set_config('role', 'authenticated', true);
    execute p_sql;
    perform set_config('role', 'none', true);
    if p_check is not null then
      execute p_check into v_seen;
    end if;
    raise exception using errcode = 'XXS87', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text,
                            v_det = pg_exception_detail, v_hint = pg_exception_hint;
  end;
  if v_state = 'XXS87' then
    return 'ok' || coalesce(':' || v_seen, '');
  end if;
  return v_state || '|' || v_msg || '|' || coalesce(nullif(v_det, ''), '-') || '|'
         || case when v_hint is null or v_hint = ''
                   or v_hint like 'Grant the required privileges to the current role with:%'
                 then '-' else v_hint end;
end $$;
-- The call each function gets in the matrices, for count p_count (the
-- assignee given to assign and force_reassign is stf, a member of
-- organization A, so a refusal is never about the assignee).
create function pg_temp.call(p_fn text, p_count uuid) returns text language sql immutable as $$
  select case p_fn
    when 'release' then format($q$select public.release_cycle_count(%L, 'Shift ending')$q$, p_count)
    when 'assign'  then format($q$select public.assign_cycle_count(%L, '58700000-0000-0000-0000-0000000000a3')$q$, p_count)
    when 'force'   then format($q$select public.force_reassign_cycle_count(%L, '58700000-0000-0000-0000-0000000000a3', 'Cover the shift')$q$, p_count)
  end
$$;
-- Every pair of the personas and counts named, through function p_fn, each
-- call undone, p_prep run first inside each: '<n> calls: <distinct answers>'.
create function pg_temp.matrix(p_fn text, p_who text[], p_counts text[], p_prep text default null)
returns text language sql as $$
  select count(*)::text || ' calls: ' || string_agg(distinct a.v, ' ; ')
    from unnest(p_who) w(who)
    cross join unnest(p_counts) k(label)
    cross join lateral (
      select pg_temp.attempt((select p.id from persona p where p.who = w.who),
                             pg_temp.call(p_fn, (select c.id from cc c where c.label = k.label)),
                             p_prep) as v
    ) a
$$;
-- The M-section's mutation: the live definition with p_cut taken out,
-- re-created (always inside an undone attempt). Refuses when the text is not
-- there, so a mutation can never pass by cutting nothing.
create function pg_temp.unpatch(p_sig text, p_cut text) returns void language plpgsql as $$
declare v_def text := pg_get_functiondef(to_regprocedure(p_sig));
begin
  if position(p_cut in v_def) = 0 then
    raise exception 'unpatch: the text to cut is not in %', p_sig;
  end if;
  execute replace(v_def, p_cut, '');
end $$;
-- The S87 block, as the migration adds it to each body.
create temp table blk (t text);
insert into blk (t) values ($blk$  -- S87: the count is looked up first in the organizations the caller is an
  -- active member of (is_org_member: an accepted membership, not an expired
  -- "act as" seat, of an account that is not disabled). A count outside
  -- them gets the answer an id that does not exist gets, with nothing
  -- locked; the status and permission checks below come after this one.
  if not exists (
    select 1
      from public.cycle_counts c
     where c.id = p_count_id
       and public.is_org_member(c.organization_id)
  ) then
    raise exception 'cycle_count_not_found' using errcode = 'P0002';
  end if;
$blk$);
create function pg_temp.cut_all() returns text language sql stable as $$
  select format('select pg_temp.unpatch(%L, %L); select pg_temp.unpatch(%L, %L); select pg_temp.unpatch(%L, %L)',
                'public.release_cycle_count(uuid, text)', b.t,
                'public.assign_cycle_count(uuid, uuid)', b.t,
                'public.force_reassign_cycle_count(uuid, uuid, text)', b.t)
    from blk b
$$;

-- ══ F. The fixture is what the matrices assume ═══════════════════════════
create function pg_temp.gates(p_who text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claim.sub', (select p.id::text from persona p where p.who = p_who), true);
  v := p_who || '=' || public.is_org_member('58700000-0000-0000-0000-00000000000a')::text
       || '/' || public.has_org_role('58700000-0000-0000-0000-00000000000a', 'manager')::text;
  perform set_config('request.jwt.claim.sub', '', true);
  return v;
end $$;
select is(
  (select string_agg(pg_temp.gates(u.w), ' ' order by u.o)
     from unnest(array['mgr', 'asg', 'stf', 'vwr', 'outZ', 'rmv', 'dis', 'exp', 'pend', 'nobody'])
          with ordinality u(w, o)),
  'mgr=true/true asg=true/false stf=true/false vwr=true/false outZ=false/false rmv=false/false '
  'dis=false/false exp=false/false pend=false/false nobody=false/false',
  'F1: is_org_member / has_org_role manager in organization A: mgr, asg, stf and vwr are active members (mgr the manager); the other organization''s manager, the removed member, the disabled account, the expired act-as seat, the invitation not yet accepted and the account with no organization are not');
select is(
  (select string_agg(c.label || '=' || coalesce(x.status, 'none') || '/' || coalesce(p.who, '-'), ', ' order by c.label)
     from cc c
     left join public.cycle_counts x on x.id = c.id
     left join persona p on p.id = x.assigned_to),
  'cAsg=in_progress/asg, cDone=completed/asg, cRnd=none/-, cUn=in_progress/-, cZ=in_progress/-',
  'F2: each count''s status and assignee; cRnd is no count');

-- Everything below must leave this unchanged (Z1): every attempt is undone.
create function pg_temp.state() returns text language sql stable as $$
  select (select md5(string_agg(c.id::text || c.status || coalesce(c.assigned_to::text, '-')
                                || coalesce(c.assignment_claimed_at::text, '-') || coalesce(c.assignment_claimed_by::text, '-')
                                || c.assignment_version::text || c.updated_at::text, ',' order by c.id))
            from public.cycle_counts c
           where c.organization_id in ('58700000-0000-0000-0000-00000000000a', '58700000-0000-0000-0000-00000000000b'))
      || '|' || (select count(*) from public.notifications n
                  where n.organization_id in ('58700000-0000-0000-0000-00000000000a', '58700000-0000-0000-0000-00000000000b'))
      || '|' || (select md5(string_agg(p.oid::text || md5(p.prosrc), ',' order by p.oid))
                   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public'
                    and p.proname in ('release_cycle_count', 'assign_cycle_count', 'force_reassign_cycle_count'))
$$;
create temp table snap as select pg_temp.state() as v;

-- ══ O. Outside the count's organization: one answer ══════════════════════
select is(
  pg_temp.matrix('release', array['outZ', 'rmv', 'dis', 'exp', 'pend', 'nobody'], array['cUn', 'cAsg', 'cDone', 'cRnd']),
  '24 calls: P0002|cycle_count_not_found|-|-',
  'O1: release_cycle_count answers every caller outside organization A (its other organization''s manager, the removed member, the disabled account, the expired act-as seat, the invitation not yet accepted, the account with no organization) the same for an unassigned, an assigned and a completed count of A and for an id no count has: P0002 cycle_count_not_found, no detail, no hint');
select is(
  pg_temp.matrix('assign', array['outZ', 'rmv', 'dis', 'exp', 'pend', 'nobody'], array['cUn', 'cAsg', 'cDone', 'cRnd']),
  '24 calls: P0002|cycle_count_not_found|-|-',
  'O2: assign_cycle_count answers every caller outside organization A the same for each count of A and for an id no count has: P0002 cycle_count_not_found, no detail, no hint');
select is(
  pg_temp.matrix('force', array['outZ', 'rmv', 'dis', 'exp', 'pend', 'nobody'], array['cUn', 'cAsg', 'cDone', 'cRnd']),
  '24 calls: P0002|cycle_count_not_found|-|-',
  'O3: force_reassign_cycle_count answers every caller outside organization A the same for each count of A and for an id no count has: P0002 cycle_count_not_found, no detail, no hint');
select is(
  pg_temp.matrix('release', array['mgr'], array['cZ', 'cRnd']) || ' / '
  || pg_temp.matrix('assign', array['mgr'], array['cZ', 'cRnd']) || ' / '
  || pg_temp.matrix('force', array['mgr'], array['cZ', 'cRnd']),
  '2 calls: P0002|cycle_count_not_found|-|- / 2 calls: P0002|cycle_count_not_found|-|- / 2 calls: P0002|cycle_count_not_found|-|-',
  'O4: organization A''s manager gets not found for organization Z''s count from each function, as for an id no count has');

-- ══ I. Inside the count's organization: every answer kept ════════════════
select is(
  pg_temp.attempt(:asg, pg_temp.call('release', :cAsg), null, format('select pg_temp.assignment(%L)', :cAsg)) || ' / '
  || pg_temp.attempt(:mgr, pg_temp.call('release', :cAsg), null, format('select pg_temp.assignment(%L)', :cAsg)) || ' / '
  || pg_temp.attempt(:mgr, pg_temp.call('release', :cUn), null, format('select pg_temp.assignment(%L)', :cUn)),
  'ok:-/-/2 / ok:-/-/2 / ok:-/-/1',
  'I1: release_cycle_count: the assignee releases their own count and a manager releases any count, assigned or not (assignment cleared, assignment_version up by one), as before');
select is(
  pg_temp.attempt(:stf, pg_temp.call('release', :cAsg)) || ' / '
  || pg_temp.attempt(:vwr, pg_temp.call('release', :cAsg)) || ' / '
  || pg_temp.attempt(:stf, pg_temp.call('release', :cUn)) || ' / '
  || pg_temp.attempt(:mgr, pg_temp.call('release', :cDone)) || ' / '
  || pg_temp.attempt(:asg, pg_temp.call('release', :cDone)) || ' / '
  || pg_temp.attempt(:mgr, pg_temp.call('release', :cRnd)) || ' / '
  || pg_temp.attempt(:mgr, format($q$select public.release_cycle_count(%L, '  ')$q$, :cAsg)),
  '42501|forbidden|-|- / 42501|forbidden|-|- / 42501|forbidden|-|- / '
  'P0001|invalid_status_transition|completed|- / P0001|invalid_status_transition|completed|- / '
  'P0002|cycle_count_not_found|-|- / P0001|release_reason_required|-|-',
  'I2: release_cycle_count refuses members of organization A as before: staff and a viewer on someone else''s count and staff on an unassigned one (42501 forbidden), a completed count for the manager and the assignee (P0001 invalid_status_transition, detail the status), an unknown id (P0002), a blank reason (P0001 release_reason_required)');
select is(
  pg_temp.attempt(:mgr, pg_temp.call('assign', :cUn), null, format('select pg_temp.assignment(%L)', :cUn)) || ' / '
  || pg_temp.attempt(:outZ, pg_temp.call('assign', :cZ), null, format('select pg_temp.assignment(%L)', :cZ))
       ,
  'ok:stf/mgr/1 / P0001|invalid_assignee|-|-',
  'I3: assign_cycle_count: a manager assigns an in-progress count of their organization to a member of it (assignee, claimed by, assignment_version up by one); organization Z''s manager reaches their own count and is refused an assignee from another organization (P0001 invalid_assignee), as before');
select is(
  pg_temp.attempt(:stf, pg_temp.call('assign', :cUn)) || ' / '
  || pg_temp.attempt(:vwr, pg_temp.call('assign', :cUn)) || ' / '
  || pg_temp.attempt(:mgr, pg_temp.call('assign', :cDone)) || ' / '
  || pg_temp.attempt(:mgr, format('select public.assign_cycle_count(%L, %L)', :cUn, :outZ)) || ' / '
  || pg_temp.attempt(:mgr, pg_temp.call('assign', :cRnd)),
  '42501|forbidden|-|- / 42501|forbidden|-|- / P0001|invalid_status_transition|completed|- / '
  'P0001|invalid_assignee|-|- / P0002|cycle_count_not_found|-|-',
  'I4: assign_cycle_count refuses members of organization A as before: staff and a viewer (42501 forbidden), a completed count (P0001 invalid_status_transition, detail the status), an assignee outside the organization (P0001 invalid_assignee), an unknown id (P0002)');
select is(
  pg_temp.attempt(:mgr, pg_temp.call('force', :cAsg), null, format('select pg_temp.assignment(%L)', :cAsg)),
  'ok:stf/mgr/2',
  'I5: force_reassign_cycle_count: a manager reassigns an assigned count to another member with a reason, as before');
select is(
  pg_temp.attempt(:stf, pg_temp.call('force', :cAsg)) || ' / '
  || pg_temp.attempt(:asg, pg_temp.call('force', :cAsg)) || ' / '
  || pg_temp.attempt(:mgr, pg_temp.call('force', :cDone)) || ' / '
  || pg_temp.attempt(:mgr, format($q$select public.force_reassign_cycle_count(%L, %L, 'Cover')$q$, :cAsg, :outZ)) || ' / '
  || pg_temp.attempt(:mgr, format($q$select public.force_reassign_cycle_count(%L, %L, ' ')$q$, :cAsg, :stf)) || ' / '
  || pg_temp.attempt(:mgr, pg_temp.call('force', :cRnd)),
  '42501|forbidden|-|- / 42501|forbidden|-|- / P0001|invalid_status_transition|completed|- / '
  'P0001|invalid_assignee|-|- / P0001|reassign_reason_required|-|- / P0002|cycle_count_not_found|-|-',
  'I6: force_reassign_cycle_count refuses members of organization A as before: staff, the assignee included (42501 forbidden), a completed count (P0001 invalid_status_transition, detail the status), an assignee outside the organization (P0001 invalid_assignee), a blank reason (P0001 reassign_reason_required), an unknown id (P0002)');
select is(
  (select count(*)::text || ' calls: ' || string_agg(distinct pg_temp.attempt(null, pg_temp.call(f.fn, c.id)), ' ; ')
     from unnest(array['release', 'assign', 'force']) f(fn)
     cross join cc c
    where c.label in ('cAsg', 'cDone', 'cRnd')),
  '9 calls: 42501|unauthenticated|-|-',
  'I7: a call with no signed-in user is refused first, as before: 42501 unauthenticated from each function, whatever the id');
select is(
  (select string_agg(distinct v, ' ; ')
     from (select pg_temp.attempt(p.id, format($q$select public.release_cycle_count(%L, ' ')$q$, c.id)) as v
             from persona p cross join cc c
            where p.who in ('mgr', 'outZ', 'nobody') and c.label in ('cAsg', 'cRnd')
           union all
           select pg_temp.attempt(p.id, format($q$select public.force_reassign_cycle_count(%L, %L, ' ')$q$, c.id, :stf))
             from persona p cross join cc c
            where p.who in ('mgr', 'outZ', 'nobody') and c.label in ('cAsg', 'cRnd')) s),
  'P0001|reassign_reason_required|-|- ; P0001|release_reason_required|-|-',
  'I8: a blank reason is refused before the lookup, for every caller and every id alike, as before (release_reason_required, reassign_reason_required)');

-- ══ R. One change per function: the S87 block ════════════════════════════
select is(
  (select string_agg(p.proname || '=' || md5(p.prosrc) || '|' || md5(replace(p.prosrc, (select t from blk), ''))
                     || '|' || ((length(p.prosrc) - length(replace(p.prosrc, (select t from blk), ''))) / length((select t from blk)))::text,
                     ', ' order by p.proname)
     from pg_proc p
    where p.oid in (to_regprocedure('public.release_cycle_count(uuid, text)'),
                    to_regprocedure('public.assign_cycle_count(uuid, uuid)'),
                    to_regprocedure('public.force_reassign_cycle_count(uuid, uuid, text)'))),
  'assign_cycle_count=eef39c210b77433fb1630dd5a8ee7674|21db42cd037f504513bf134b938b721a|1, '
  'force_reassign_cycle_count=05bab946f50f1e7e90dbcd023cc3b6a2|d887f4a5510a0cd438be17e744cff51d|1, '
  'release_cycle_count=bbbb2ddd68a6076be0dbd754d7ad38b8|168808f20dd326d3710e1900c7d029a4|1',
  'R1: each body is the new one, holds the S87 block once, and taking it out gives the body it replaced exactly (assign and force_reassign: 0282''s; release: 0419''s)');

-- ══ C. The lookup comes first ════════════════════════════════════════════
select is(
  (select string_agg(p.proname || '=' || (position((select t from blk) in p.prosrc) > 0
                       and position((select t from blk) in p.prosrc) < position('for update' in p.prosrc)
                       and position((select t from blk) in p.prosrc) < position('invalid_status_transition' in p.prosrc)
                       and position((select t from blk) in p.prosrc) < position('''forbidden''' in p.prosrc))::text,
                     ', ' order by p.proname)
     from pg_proc p
    where p.oid in (to_regprocedure('public.release_cycle_count(uuid, text)'),
                    to_regprocedure('public.assign_cycle_count(uuid, uuid)'),
                    to_regprocedure('public.force_reassign_cycle_count(uuid, uuid, text)'))),
  'assign_cycle_count=true, force_reassign_cycle_count=true, release_cycle_count=true',
  'C1: in each body the lookup in the caller''s organizations comes before the row lock (for update), the status check and the first permission check');

-- ══ P. Posture unchanged; release's comment says the rule ═════════════════
select is(
  (select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' || '|'
                     || pg_get_function_result(p.oid) || '|' || p.provolatile::text || '|' || p.prosecdef::text || '|'
                     || coalesce(p.proconfig::text, '') || '|' || pg_get_userbyid(p.proowner) || '|'
                     || (select string_agg(g.v, ',' order by g.v)
                           from (select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end
                                        || ':' || a.privilege_type as v
                                   from aclexplode(p.proacl) a) g),
                     E'\n' order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('release_cycle_count', 'assign_cycle_count', 'force_reassign_cycle_count')),
  'assign_cycle_count(p_count_id uuid, p_user_id uuid)|cycle_counts|v|true|{search_path=public}|postgres|authenticated:EXECUTE,postgres:EXECUTE,service_role:EXECUTE' || E'\n'
  || 'force_reassign_cycle_count(p_count_id uuid, p_user_id uuid, p_reason text)|cycle_counts|v|true|{search_path=public}|postgres|authenticated:EXECUTE,postgres:EXECUTE,service_role:EXECUTE' || E'\n'
  || 'release_cycle_count(p_count_id uuid, p_reason text)|cycle_counts|v|true|{search_path=public}|postgres|authenticated:EXECUTE,postgres:EXECUTE,service_role:EXECUTE',
  'P1: each function keeps its arguments, result, volatility, SECURITY DEFINER, search_path, owner and EXECUTE (authenticated, service_role and the owner; not anon, nothing to PUBLIC); one function of each name');
select is(
  (select (position('A manager of the count''s organization releases any count, assigned or not'
                    in coalesce(obj_description(p.oid, 'pg_proc'), '')) > 0)::text
          || '/' || (position('a count in an organization the caller is not an active member of'
                    in coalesce(obj_description(p.oid, 'pg_proc'), '')) > 0)::text
     from pg_proc p where p.oid = to_regprocedure('public.release_cycle_count(uuid, text)')),
  'true/true',
  'P2: release_cycle_count''s comment keeps the rule and says a count in an organization the caller is not an active member of is answered as not found');

-- ══ M. Mutation: the block taken out ═════════════════════════════════════
select is(
  (select (m.v not like '24 calls: % ; %')::text from (
     select pg_temp.matrix('release', array['outZ', 'rmv', 'dis', 'exp', 'pend', 'nobody'],
                           array['cUn', 'cAsg', 'cDone', 'cRnd'], pg_temp.cut_all()) as v) m)
  || '/' || (select (m.v not like '24 calls: % ; %')::text from (
     select pg_temp.matrix('assign', array['outZ', 'rmv', 'dis', 'exp', 'pend', 'nobody'],
                           array['cUn', 'cAsg', 'cDone', 'cRnd'], pg_temp.cut_all()) as v) m)
  || '/' || (select (m.v not like '24 calls: % ; %')::text from (
     select pg_temp.matrix('force', array['outZ', 'rmv', 'dis', 'exp', 'pend', 'nobody'],
                           array['cUn', 'cAsg', 'cDone', 'cRnd'], pg_temp.cut_all()) as v) m),
  'false/false/false',
  'M1: with the S87 block taken out of each body, callers outside organization A get more than one answer from each function: O1-O3 fail on it');

-- ══ Q. The preflight, replayed ═══════════════════════════════════════════
create function pg_temp.mig_pre() returns text language sql stable as $$
  select coalesce(string_agg(st, E';\n'), '')
    from supabase_migrations.schema_migrations m, unnest(m.statements) st
   where m.name = 'cycle_count_assignment_member_lookup' and position(E'\ndo $s87_pre$' in E'\n' || st) > 0
$$;
create function pg_temp.try_pre(p_prep text) returns text language plpgsql as $$
declare v_state text; v_hint text; v_pre text := pg_temp.mig_pre();
begin
  if v_pre = '' then
    return 'missing';
  end if;
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    execute v_pre;
    raise exception using errcode = 'XXS87', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
  end;
  if v_state = 'XXS87' then
    return 'ok';
  end if;
  return v_state || ':' || coalesce(v_hint, '-');
end $$;
select is(
  pg_temp.try_pre(pg_temp.cut_all()) || ' / ' || pg_temp.try_pre(null)
  || ' / ' || pg_temp.try_pre(pg_temp.cut_all() || '; revoke execute on function public.assign_cycle_count(uuid, uuid) from service_role'),
  'ok / 55000:s87_preflight / 55000:s87_preflight',
  'Q1: the migration''s preflight passes on the bodies and grants it replaced, and stops with 55000 (hint s87_preflight) on the new bodies (a second run) and on a grant that differs');

-- ══ G. Never a retryable error ════════════════════════════════════════════
select is(
  (select string_agg(p.proname || '=' || (p.prosrc ~* '40001|40P01|serialization_failure|deadlock_detected')::text,
                     ', ' order by p.proname)
     from pg_proc p
    where p.oid in (to_regprocedure('public.release_cycle_count(uuid, text)'),
                    to_regprocedure('public.assign_cycle_count(uuid, uuid)'),
                    to_regprocedure('public.force_reassign_cycle_count(uuid, uuid, text)'))),
  'assign_cycle_count=false, force_reassign_cycle_count=false, release_cycle_count=false',
  'G1: no body names 40001 or 40P01 (PostgREST retries those forever)');

-- ══ Z. Every undone attempt changed nothing ═══════════════════════════════
select is(pg_temp.state(), (select v from snap),
  'Z1: the undone attempts (the M-section''s mutations and the preflight replays included) left the counts of both organizations, their notifications and the three bodies as they were');

select * from finish();
rollback;
