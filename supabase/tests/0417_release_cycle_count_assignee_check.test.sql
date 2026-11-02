-- supabase/tests/NNNN_release_cycle_count_assignee_check.test.sql (NNNN = the
-- migration's number, given in ship order; nothing in this file reads it)
-- pgTAP proof for the S42 migration (docket item S42): release_cycle_count
-- refuses everyone but a manager of the count's organization on a count with
-- no assignee, and refuses the assignee once they may no longer count in the
-- count's organization (has_permission stock:adjust). Written to fail against
-- the head before it (0414 when it was written) in R1, P2, A3-A7, U1, U3, U4,
-- M1 and M2; every other line passes there too.
--
-- The function's old check, `not (assigned_to = auth.uid() or manager)`, is
-- NULL for a count with no assignee, and an IF treats NULL as false, so it
-- refused no one there: any signed-in account of any organization that knew
-- the id released the count and got its whole row back past row level
-- security (U1, F3). And its assignee arm compared identity only (A3-A7).
--
-- Personas (organization A unless named):
--   asg       staff assigned to warehouse A, the assignee of cAsg
--   mgr       manager
--   mgrNoAdj  manager, stock:adjust revoked (a user override), the assignee
--             of cMgr
--   rmv       staff, the assignee of cRmv (and of the completed cDone), then
--             removed as TeamService.removeMember removes a member (the
--             membership row, then their warehouse assignments); still staff
--             of organization Z, so their session lives on
--   dis       staff, the assignee of cDis, then disabled (user_profiles
--             disabled_at, written by service_role as the disable service
--             does; the access token outlives it)
--   exp       a platform admin's "act as" seat (an owner row) whose
--             impersonation_expires_at has passed, the assignee of cExp
--   vwr       viewer, the assignee of cVwr
--   vwrAdj    viewer granted stock:adjust (a user override, as an admin may
--             grant it), the assignee of cVwrAdj
--   noAdj     staff, stock:adjust revoked, the assignee of cNoAdj
--   stf       staff assigned to warehouse A, assignee of nothing
--   outZ      a manager of organization Z
--   nobody    signed in, a member of no organization
-- S2's callers: rmvMgr (a manager removed from organization A, still staff
-- of Z) and disMgr (a manager whose account was disabled).
-- Counts of organization A, in progress: cUn (no assignee, a private note),
-- cAsg, cRmv, cDis, cExp, cVwr, cNoAdj, cMgr, cVwrAdj; cDone is completed,
-- assigned to rmv.
--
-- F.  The fixture is what the matrices assume: each persona's membership,
--     stock:adjust and manager rank in organization A (F1), each count's
--     status and assignee (F2), and row level security hiding organization
--     A's counts from everyone outside it (F3).
-- R.  One change: md5(prosrc) is the new body's, and removing the two blocks
--     tagged "S42" gives production's body exactly (a428c8f7, 0282's).
-- P.  The function keeps its posture (arguments, result, volatility,
--     SECURITY DEFINER, search_path, owner, EXECUTE), and its comment says
--     the rule in words, never a migration number.
-- A.  A count with an assignee: the assignee releases it while they hold
--     stock:adjust; a manager releases it, with or without stock:adjust;
--     the removed member, the disabled account, the expired seat, the viewer
--     and the revoked member are refused their own count; a non-assignee who
--     is not a manager is refused as before; the reason, not-found and
--     closed-count refusals come first, as before. A manager without
--     stock:adjust releases a count assigned to themself (the assignee
--     check's manager clause), and a viewer granted stock:adjust releases
--     their own count: the assignee's rule is the permission the app asks
--     before a release, not a rank (a rank rule would refuse an assignee
--     the app lets through).
-- U.  A count with no assignee: only a manager releases it; everyone else
--     is refused, the assignee whose count a manager just released (a stale
--     screen) included, and so is an assignee who sends their own release
--     again after it went through (the phone's retry when the first answer
--     was lost).
-- S.  The twin (release_picking, 0240) and the family (assign_cycle_count,
--     force_reassign_cycle_count) refuse the same callers, each beside a
--     manager it allows.
-- M.  Mutations: each block taken out of the live body (inside an undone
--     attempt) lets the refused calls through, so the U and A lines are not
--     tautological.
-- G.  The body names neither 40001 nor 40P01.
-- Z.  Every undone attempt changed nothing.
--
-- Two sessions (an assignee's release waiting on a manager's release of the
-- same count) need two connections: the race script for this migration in
-- scripts/db-concurrency/ (NNNN_release_race.sh).
--
-- Roles: fixtures as the test superuser. Every attempt runs through
-- pg_temp.attempt (always undone), which switches role and claims with
-- set_config inside a subtransaction (0387's helpers, as 0395 uses them), so
-- the pgTAP bookkeeping never runs as an API role. begin/rollback: nothing
-- leaks. Namespace 54200000; undo code XXS42.

begin;

select plan(24);

\set orgA     '\'54200000-0000-0000-0000-00000000000a\''
\set orgZ     '\'54200000-0000-0000-0000-00000000000b\''
\set asg      '\'54200000-0000-0000-0000-0000000000a1\''
\set mgr      '\'54200000-0000-0000-0000-0000000000a2\''
\set mgrNoAdj '\'54200000-0000-0000-0000-0000000000a3\''
\set rmv      '\'54200000-0000-0000-0000-0000000000a4\''
\set dis      '\'54200000-0000-0000-0000-0000000000a5\''
\set exp      '\'54200000-0000-0000-0000-0000000000a6\''
\set vwr      '\'54200000-0000-0000-0000-0000000000a7\''
\set noAdj    '\'54200000-0000-0000-0000-0000000000a8\''
\set stf      '\'54200000-0000-0000-0000-0000000000a9\''
\set rmvMgr   '\'54200000-0000-0000-0000-0000000000aa\''
\set disMgr   '\'54200000-0000-0000-0000-0000000000ab\''
\set vwrAdj   '\'54200000-0000-0000-0000-0000000000ac\''
\set outZ     '\'54200000-0000-0000-0000-0000000000b1\''
\set nobody   '\'54200000-0000-0000-0000-0000000000c1\''
\set whA      '\'54200000-0000-0000-0000-0000000000d1\''
\set whZ      '\'54200000-0000-0000-0000-0000000000d2\''
\set cUn      '\'54200000-0000-0000-0000-000000000101\''
\set cAsg     '\'54200000-0000-0000-0000-000000000102\''
\set cRmv     '\'54200000-0000-0000-0000-000000000103\''
\set cDis     '\'54200000-0000-0000-0000-000000000104\''
\set cExp     '\'54200000-0000-0000-0000-000000000105\''
\set cVwr     '\'54200000-0000-0000-0000-000000000106\''
\set cNoAdj   '\'54200000-0000-0000-0000-000000000107\''
\set cDone    '\'54200000-0000-0000-0000-000000000108\''
\set cMgr     '\'54200000-0000-0000-0000-000000000109\''
\set cVwrAdj  '\'54200000-0000-0000-0000-00000000010a\''
\set cNone    '\'54200000-0000-0000-0000-0000000001ff\''
\set oRmv     '\'54200000-0000-0000-0000-000000000201\''
\set oDis     '\'54200000-0000-0000-0000-000000000202\''
\set oNone    '\'54200000-0000-0000-0000-000000000203\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:asg,      's42-asg@s42.test',      '{}'::jsonb),
  (:mgr,      's42-mgr@s42.test',      '{}'::jsonb),
  (:mgrNoAdj, 's42-mgrnoadj@s42.test', '{}'::jsonb),
  (:rmv,      's42-rmv@s42.test',      '{}'::jsonb),
  (:dis,      's42-dis@s42.test',      '{}'::jsonb),
  (:exp,      's42-exp@s42.test',      '{}'::jsonb),
  (:vwr,      's42-vwr@s42.test',      '{}'::jsonb),
  (:noAdj,    's42-noadj@s42.test',    '{}'::jsonb),
  (:stf,      's42-stf@s42.test',      '{}'::jsonb),
  (:rmvMgr,   's42-rmvmgr@s42.test',   '{}'::jsonb),
  (:disMgr,   's42-dismgr@s42.test',   '{}'::jsonb),
  (:vwrAdj,   's42-vwradj@s42.test',   '{}'::jsonb),
  (:outZ,     's42-outz@s42.test',     '{}'::jsonb),
  (:nobody,   's42-nobody@s42.test',   '{}'::jsonb)
  on conflict (id) do nothing;
-- An org insert enables the default modules (cycle counts and orders among
-- them).
insert into public.organizations (id, name, slug) values
  (:orgA, 'S42 Count Org A', 's42-count-org-a'),
  (:orgZ, 'S42 Count Org Z', 's42-count-org-z');
-- exp is an act-as seat: an owner row whose impersonation_expires_at has
-- passed (an act-as seat lasts 45 minutes; the sweep that deletes expired
-- seats runs on the next start or by cron, so one can still be here).
insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at) values
  (:orgA, :asg,      'staff',   now(), null),
  (:orgA, :mgr,      'manager', now(), null),
  (:orgA, :mgrNoAdj, 'manager', now(), null),
  (:orgA, :rmv,      'staff',   now(), null),
  (:orgA, :dis,      'staff',   now(), null),
  (:orgA, :exp,      'owner',   now(), now() - interval '1 hour'),
  (:orgA, :vwr,      'viewer',  now(), null),
  (:orgA, :noAdj,    'staff',   now(), null),
  (:orgA, :stf,      'staff',   now(), null),
  (:orgA, :rmvMgr,   'manager', now(), null),
  (:orgA, :disMgr,   'manager', now(), null),
  (:orgA, :vwrAdj,   'viewer',  now(), null),
  (:orgZ, :rmv,      'staff',   now(), null),
  (:orgZ, :rmvMgr,   'staff',   now(), null),
  (:orgZ, :outZ,     'manager', now(), null);
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgA, 'S42 Main', 'WH-S42A', 'active'),
  (:whZ, :orgZ, 'S42 Zed',  'WH-S42Z', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :asg,    :whA, true),
  (:orgA, :rmv,    :whA, true),
  (:orgA, :dis,    :whA, true),
  (:orgA, :vwr,    :whA, true),
  (:orgA, :noAdj,  :whA, true),
  (:orgA, :stf,    :whA, true),
  (:orgA, :vwrAdj, :whA, true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :mgrNoAdj, 'stock:adjust', false),
  (:orgA, :noAdj,    'stock:adjust', false),
  (:orgA, :vwrAdj,   'stock:adjust', true);

-- The counts, inserted by the superuser (the status guard holds API roles
-- only; the assignment notice fires on UPDATE only). Each assigned count was
-- assigned by mgr (assignment_version 1); cUn was assigned and released once
-- before (assignment_version 2) and carries a note its organization's
-- members read.
insert into public.cycle_counts
  (id, organization_id, warehouse_id, status, started_by, notes, assigned_to, assignment_claimed_at,
   assignment_claimed_by, assignment_version, completed_at, completed_by) values
  (:cUn,     :orgA, :whA, 'in_progress', :mgr, 'S42 private note', null,      null,  null, 2, null,  null),
  (:cAsg,    :orgA, :whA, 'in_progress', :mgr, null,               :asg,      now(), :mgr, 1, null,  null),
  (:cRmv,    :orgA, :whA, 'in_progress', :mgr, null,               :rmv,      now(), :mgr, 1, null,  null),
  (:cDis,    :orgA, :whA, 'in_progress', :mgr, null,               :dis,      now(), :mgr, 1, null,  null),
  (:cExp,    :orgA, :whA, 'in_progress', :mgr, null,               :exp,      now(), :mgr, 1, null,  null),
  (:cVwr,    :orgA, :whA, 'in_progress', :mgr, null,               :vwr,      now(), :mgr, 1, null,  null),
  (:cNoAdj,  :orgA, :whA, 'in_progress', :mgr, null,               :noAdj,    now(), :mgr, 1, null,  null),
  (:cMgr,    :orgA, :whA, 'in_progress', :mgr, null,               :mgrNoAdj, now(), :mgr, 1, null,  null),
  (:cVwrAdj, :orgA, :whA, 'in_progress', :mgr, null,               :vwrAdj,   now(), :mgr, 1, null,  null),
  (:cDone,   :orgA, :whA, 'completed',   :mgr, null,               :rmv,      now(), :mgr, 1, now(), :mgr);

-- S1's orders (release_picking, the twin): rmv and dis are each the picker
-- of one; oNone has no picker.
insert into public.order_requests
  (id, organization_id, warehouse_id, status, requester_user_id, source, fulfillment_type, assigned_picker_id) values
  (:oRmv,  :orgA, :whA, 'pick_slip_generated', :mgr, 'internal', 'pickup', :rmv),
  (:oDis,  :orgA, :whA, 'pick_slip_generated', :mgr, 'internal', 'pickup', :dis),
  (:oNone, :orgA, :whA, 'pick_slip_generated', :mgr, 'internal', 'pickup', null);

-- Then rmv and rmvMgr leave organization A as TeamService.removeMember
-- removes a member (the membership row, then their assignments in the
-- organization's warehouses; their open counts and picks stay assigned),
-- and dis and disMgr are disabled as the account-disable service does it
-- (user_profiles disabled_at, written as service_role: 0309's pin reverts
-- an API role's write).
delete from public.organization_members where organization_id = :orgA and user_id in (:rmv, :rmvMgr);
delete from public.user_warehouse_assignments where organization_id = :orgA and user_id in (:rmv, :rmvMgr);
set local role to 'service_role';
update public.user_profiles set disabled_at = now(), disabled_reason = 'policy_violation' where id in (:dis, :disMgr);
reset role;

-- ══ Helpers (0387's, as 0395 uses them) ══════════════════════════════════
-- pg_temp.hint drops supautils' generic "Grant the required privileges ..."
-- hint on privilege errors, which depends on the image.
create function pg_temp.hint(p_hint text) returns text language sql immutable as $$
  select case when p_hint is null or p_hint = ''
                or p_hint like 'Grant the required privileges to the current role with:%'
              then '-' else p_hint end
$$;
-- One statement as p_as with p_sub's claims, then ALWAYS undone. 'ok:<rows>
-- [:<p_check>]' (p_check as the superuser, inside the undone subtransaction),
-- else '<sqlstate>:<hint or ->:<message>'. p_prep runs first, as the
-- superuser, inside the same undone subtransaction (the M-section's mutation).
create function pg_temp.attempt(p_as text, p_sub uuid, p_sql text, p_prep text default null, p_check text default null)
returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text; v_n bigint; v_seen text;
begin
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_as, true);
    perform set_config('role', p_as, true);
    execute p_sql;
    get diagnostics v_n = row_count;
    perform set_config('role', 'none', true);
    if p_check is not null then
      execute p_check into v_seen;
    end if;
    raise exception using errcode = 'XXS42', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XXS42' then
    return 'ok:' || v_n::text || coalesce(':' || v_seen, '');
  end if;
  return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
end $$;

create temp table persona (who text primary key, id uuid);
insert into persona (who, id) values
  ('asg', :asg), ('mgr', :mgr), ('mgrNoAdj', :mgrNoAdj), ('rmv', :rmv), ('dis', :dis), ('exp', :exp),
  ('vwr', :vwr), ('noAdj', :noAdj), ('stf', :stf), ('rmvMgr', :rmvMgr), ('disMgr', :disMgr),
  ('vwrAdj', :vwrAdj), ('outZ', :outZ), ('nobody', :nobody);
-- The same statement for each named persona, in the order given, each call
-- undone: 'who=<attempt>, who=<attempt>, ...'.
create function pg_temp.each(p_who text[], p_sql text, p_check text default null)
returns text language plpgsql as $$
declare v text := ''; w text;
begin
  foreach w in array p_who loop
    v := v || case when v = '' then '' else ', ' end || w || '='
           || pg_temp.attempt('authenticated', (select p.id from persona p where p.who = w), p_sql, null, p_check);
  end loop;
  return v;
end $$;
-- Each persona releases its own count (pairs of persona and count id), each
-- call undone, with p_prep run first inside the same undone subtransaction:
-- 'who=<attempt>, ...'.
create function pg_temp.own(p_pairs text[][], p_prep text default null)
returns text language plpgsql as $$
declare v text := ''; i int;
begin
  for i in 1 .. array_length(p_pairs, 1) loop
    v := v || case when v = '' then '' else ', ' end || p_pairs[i][1] || '='
           || pg_temp.attempt('authenticated', (select p.id from persona p where p.who = p_pairs[i][1]),
                              format($q$select public.release_cycle_count(%L, 'Shift ending')$q$, p_pairs[i][2]),
                              p_prep);
  end loop;
  return v;
end $$;
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
-- A count's assignment columns, '-' for null: assignee/claimed at/claimed by/
-- version (the A and U lines read it inside the undone attempt).
create function pg_temp.assignment(p_count uuid) returns text language sql stable as $$
  select coalesce((select p.who from persona p where p.id = c.assigned_to), '-')
         || '/' || case when c.assignment_claimed_at is null then '-' else 'set' end
         || '/' || coalesce((select p.who from persona p where p.id = c.assignment_claimed_by), '-')
         || '/' || c.assignment_version::text
    from public.cycle_counts c where c.id = p_count
$$;
-- A release by p_who, then the very same call again, as the phone sends it
-- when the first answer was lost (it gives up waiting, or the connection
-- drops, after the release went through), both as p_who inside one
-- subtransaction that is always undone: 'first=<outcome>, again=<outcome>,
-- after=<assignment>', each outcome 'ok' or '<sqlstate>:<hint or ->:<message>'.
-- Each call is its own inner block, so a refused second call keeps the first.
create function pg_temp.again(p_who text, p_count uuid) returns text language plpgsql as $$
declare v_sub text := (select p.id::text from persona p where p.who = p_who);
        v_out text[] := '{}'; v_after text; v_state text; v_msg text; v_hint text; i int;
begin
  begin
    perform set_config('request.jwt.claim.sub', v_sub, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    perform set_config('role', 'authenticated', true);
    for i in 1 .. 2 loop
      begin
        perform public.release_cycle_count(p_count, 'Shift ending');
        v_out := v_out || 'ok'::text;
      exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
        v_out := v_out || (v_state || ':'
                           || case when v_hint is null or v_hint = ''
                                     or v_hint like 'Grant the required privileges to the current role with:%'
                                   then '-' else v_hint end
                           || ':' || v_msg);
      end;
    end loop;
    perform set_config('role', 'none', true);
    v_after := pg_temp.assignment(p_count);
    raise exception using errcode = 'XXS42', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> 'XXS42' then
      return v_state || ':' || v_msg;
    end if;
  end;
  return 'first=' || v_out[1] || ', again=' || v_out[2] || ', after=' || v_after;
end $$;

-- ══ F. The fixture is what the matrices assume ═══════════════════════════
-- is_org_member / has_permission(stock:adjust) / has_org_role(manager) in
-- organization A, as each persona.
create function pg_temp.gates(p_who text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claim.sub', (select p.id::text from persona p where p.who = p_who), true);
  v := p_who || '=' || public.is_org_member('54200000-0000-0000-0000-00000000000a')::text
       || '/' || public.has_permission('54200000-0000-0000-0000-00000000000a', 'stock:adjust')::text
       || '/' || public.has_org_role('54200000-0000-0000-0000-00000000000a', 'manager')::text;
  perform set_config('request.jwt.claim.sub', '', true);
  return v;
end $$;
select is(
  (select string_agg(pg_temp.gates(u.w), ' ' order by u.o)
     from unnest(array['asg', 'mgr', 'mgrNoAdj', 'rmv', 'dis', 'exp', 'vwr', 'vwrAdj', 'noAdj', 'stf', 'outZ',
                       'nobody', 'rmvMgr', 'disMgr']) with ordinality u(w, o)),
  'asg=true/true/false mgr=true/true/true mgrNoAdj=true/false/true rmv=false/false/false dis=false/false/false '
  'exp=false/false/false vwr=true/false/false vwrAdj=true/true/false noAdj=true/false/false stf=true/true/false '
  'outZ=false/false/false nobody=false/false/false rmvMgr=false/false/false disMgr=false/false/false',
  'F1: membership / stock:adjust / manager in organization A: the assignee and plain staff are members holding stock:adjust (the role default); the managers are managers, one without stock:adjust; the viewer and the revoked member are members without it, and the viewer granted it holds it; the removed member, the disabled account, the expired seat, the removed and the disabled manager, the other organization''s manager and the member of no organization are none of the three');
select is(
  (select string_agg(k.label || '=' || c.status || '/' || coalesce(p.who, '-'), ', ' order by k.o)
     from (values (1, 'cUn', :cUn::uuid), (2, 'cAsg', :cAsg::uuid), (3, 'cRmv', :cRmv::uuid), (4, 'cDis', :cDis::uuid),
                  (5, 'cExp', :cExp::uuid), (6, 'cVwr', :cVwr::uuid), (7, 'cNoAdj', :cNoAdj::uuid),
                  (8, 'cDone', :cDone::uuid), (9, 'cMgr', :cMgr::uuid), (10, 'cVwrAdj', :cVwrAdj::uuid)) k(o, label, id)
     join public.cycle_counts c on c.id = k.id
     left join persona p on p.id = c.assigned_to),
  'cUn=in_progress/-, cAsg=in_progress/asg, cRmv=in_progress/rmv, cDis=in_progress/dis, cExp=in_progress/exp, '
  'cVwr=in_progress/vwr, cNoAdj=in_progress/noAdj, cDone=completed/rmv, cMgr=in_progress/mgrNoAdj, '
  'cVwrAdj=in_progress/vwrAdj',
  'F2: each count''s status and assignee: cUn has none; the removal and the disable left rmv''s and dis''s counts assigned to them');
select is(
  pg_temp.each(array['asg', 'stf', 'vwr', 'noAdj', 'rmv', 'dis', 'exp', 'outZ', 'nobody'],
               format('select 1 from public.cycle_counts where id = %L', :cUn)),
  'asg=ok:1, stf=ok:1, vwr=ok:1, noAdj=ok:1, rmv=ok:0, dis=ok:0, exp=ok:0, outZ=ok:0, nobody=ok:0',
  'F3: row level security (cycle_counts_select, is_org_member) shows cUn to organization A''s members and to no one else: a row release_cycle_count returns to an outsider is read past it');

-- Everything below must leave this unchanged (Z1): every attempt is undone.
create function pg_temp.state() returns text language sql stable as $$
  select (select md5(string_agg(c.id::text || c.status || coalesce(c.assigned_to::text, '-')
                                || coalesce(c.assignment_claimed_at::text, '-') || coalesce(c.assignment_claimed_by::text, '-')
                                || c.assignment_version::text || c.updated_at::text, ',' order by c.id))
            from public.cycle_counts c where c.organization_id = '54200000-0000-0000-0000-00000000000a')
      || '|' || (select md5(string_agg(o.id::text || o.status || coalesce(o.assigned_picker_id::text, '-')
                                       || coalesce(o.picking_claimed_at::text, '-'), ',' order by o.id))
                   from public.order_requests o where o.organization_id = '54200000-0000-0000-0000-00000000000a')
      || '|' || (select count(*) from public.notifications n where n.organization_id = '54200000-0000-0000-0000-00000000000a')
      || '|' || (select md5(string_agg(p.oid::text || md5(p.prosrc), ',' order by p.oid))
                   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public'
                    and p.proname in ('release_cycle_count', 'release_picking', 'assign_cycle_count',
                                      'force_reassign_cycle_count'))
$$;
create temp table snap as select pg_temp.state() as v;

-- ══ R. One change: the two S42 blocks ════════════════════════════════════
select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, $b0$  -- S42: a count nobody is assigned to is nobody's own. The check below
  -- compares assigned_to with the caller, which is NULL for such a count,
  -- and an IF treats NULL as false, so that check refused no one: any
  -- signed-in caller, of any organization, who knew the count's id could
  -- release it and read the whole row back past row level security. Only a
  -- manager of the count's organization releases an unassigned count, the
  -- rule release_picking has for an order with no picker. Decided on the
  -- row locked above, so someone whose count a manager released a moment
  -- earlier is refused too.
  if v_count.assigned_to is null
     and not public.has_org_role(v_count.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- S42: the assignee's release is for someone who may still count in the
  -- count's organization: has_permission 'stock:adjust', which the app asks
  -- before every release (CycleCountsService.release) and the line update
  -- policy asks before every count. It is false without an accepted
  -- membership that has not expired, of an account that is not disabled,
  -- and when stock:adjust is revoked or never held (a viewer). Without it,
  -- a member removed from the organization (removal keeps the account and
  -- the assignment), a disabled account (its access token outlives the
  -- disable), an expired "act as" seat, a viewer and a member whose
  -- stock:adjust was revoked could each release a count still assigned to
  -- them by calling this function. A manager without stock:adjust still
  -- releases as a manager (below).
  if v_count.assigned_to = v_user
     and not public.has_permission(v_count.organization_id, 'stock:adjust')
     and not public.has_org_role(v_count.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
$b0$, ''))
     from pg_proc p where p.oid = to_regprocedure('public.release_cycle_count(uuid, text)')),
  '168808f20dd326d3710e1900c7d029a4|a428c8f73f73ee31516dd186e47bc9f9',
  'R1: release_cycle_count has the S42 body (md5 168808f2), and removing the two S42 blocks gives production''s body exactly (a428c8f7, 0282''s): the blocks are the only change');

-- ══ P. Posture unchanged; the comment says the rule ═══════════════════════
select is(
  (select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' || '|'
                     || pg_get_function_result(p.oid) || '|' || p.provolatile::text || '|' || p.prosecdef::text || '|'
                     || coalesce(p.proconfig::text, '') || '|' || pg_get_userbyid(p.proowner) || '|'
                     || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '|'
                     || has_function_privilege('anon', p.oid, 'EXECUTE')::text || '|'
                     || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || '|'
                     || (not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))::text,
                     E'\n' order by p.oid)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'release_cycle_count'),
  'release_cycle_count(p_count_id uuid, p_reason text)|cycle_counts|v|true|{search_path=public}|postgres|true|false|true|true',
  'P1: release_cycle_count keeps its arguments, result, volatility, SECURITY DEFINER, search_path, owner and EXECUTE (authenticated and service_role, not anon, nothing to PUBLIC: production''s ACL, read 2026-10-31); one function of that name');
-- Keyed on the words the comment must carry, not on the migration's number,
-- so a push-time renumber cannot break it.
select is(
  (select (position('A manager of the count''s organization releases any count, assigned or not'
                    in coalesce(obj_description(p.oid, 'pg_proc'), '')) > 0)::text
          || '/' || (position('only a count assigned to them, and only while they may count in the count''s organization (has_permission stock:adjust'
                    in coalesce(obj_description(p.oid, 'pg_proc'), '')) > 0)::text
     from pg_proc p where p.oid = to_regprocedure('public.release_cycle_count(uuid, text)')),
  'true/true',
  'P2: the comment says the rule in words: a manager of the count''s organization releases any count, assigned or not; anyone else only a count assigned to them, and only while they may count there (has_permission stock:adjust)');

-- ══ A. A count with an assignee ═══════════════════════════════════════════
select is(
  pg_temp.attempt('authenticated', :asg, format($q$select public.release_cycle_count(%L, 'Shift ending')$q$, :cAsg), null,
                  format('select pg_temp.assignment(%L)', :cAsg)),
  'ok:1:-/-/-/2',
  'A1: the assignee, holding stock:adjust, releases their own count: the assignment clears (assignee, claimed at, claimed by) and assignment_version goes up by one, as before');
select is(
  pg_temp.attempt('authenticated', :mgr, format($q$select public.release_cycle_count(%L, 'Reassigning')$q$, :cAsg), null,
                  format('select pg_temp.assignment(%L)', :cAsg)),
  'ok:1:-/-/-/2',
  'A2: a manager releases someone else''s count, as before');
select is(
  pg_temp.own(array[array['rmv', :cRmv], array['dis', :cDis], array['exp', :cExp], array['vwr', :cVwr],
                    array['noAdj', :cNoAdj]]),
  'rmv=42501:-:forbidden, dis=42501:-:forbidden, exp=42501:-:forbidden, vwr=42501:-:forbidden, noAdj=42501:-:forbidden',
  'A3-A7: an assignee who may no longer count in the count''s organization is refused their own count (42501 forbidden, no hint): the member removed from it, the disabled account, the expired act-as seat, the viewer and the member whose stock:adjust was revoked. Before S42 each of them released it');
select is(
  pg_temp.attempt('authenticated', :mgrNoAdj, format($q$select public.release_cycle_count(%L, 'Reassigning')$q$, :cAsg), null,
                  format('select pg_temp.assignment(%L)', :cAsg)),
  'ok:1:-/-/-/2',
  'A8: a manager without stock:adjust still releases someone else''s count: the manager arm is unchanged (0282''s owner decision: managers may act as override)');
select is(
  pg_temp.each(array['stf', 'outZ', 'nobody'], format($q$select public.release_cycle_count(%L, 'Not mine')$q$, :cAsg)),
  'stf=42501:-:forbidden, outZ=42501:-:forbidden, nobody=42501:-:forbidden',
  'A9: on a count assigned to someone else, plain staff, another organization''s manager and a member of no organization are refused, as before (the old check)');
select is(
  pg_temp.attempt('authenticated', :rmv, format($q$select public.release_cycle_count(%L, '   ')$q$, :cRmv)) || ' / '
  || pg_temp.attempt('authenticated', :rmv, format($q$select public.release_cycle_count(%L, 'Shift ending')$q$, :cNone)) || ' / '
  || pg_temp.each(array['rmv', 'nobody'], format($q$select public.release_cycle_count(%L, 'Shift ending')$q$, :cDone)),
  'P0001:-:release_reason_required / P0002:-:cycle_count_not_found / '
  'rmv=P0001:-:invalid_status_transition, nobody=P0001:-:invalid_status_transition',
  'A10: the refusals ahead of the new checks come first, as before: a blank reason (P0001 release_reason_required), an unknown id (P0002 cycle_count_not_found), and a closed count (P0001 invalid_status_transition), for the removed assignee and for a member of no organization alike');
select is(
  pg_temp.attempt('authenticated', :mgrNoAdj, format($q$select public.release_cycle_count(%L, 'Shift ending')$q$, :cMgr), null,
                  format('select pg_temp.assignment(%L)', :cMgr)),
  'ok:1:-/-/-/2',
  'A11: a manager without stock:adjust releases a count assigned to themself, as before: the assignee check lets a manager through (its last clause); without that clause it would refuse a manager the old check allows');
select is(
  pg_temp.attempt('authenticated', :vwrAdj, format($q$select public.release_cycle_count(%L, 'Shift ending')$q$, :cVwrAdj), null,
                  format('select pg_temp.assignment(%L)', :cVwrAdj)),
  'ok:1:-/-/-/2',
  'A12: a viewer granted stock:adjust releases their own count: the assignee''s rule is has_permission stock:adjust, the permission the app asks before a release, not a rank (a rule that also asked for staff rank would refuse someone the app lets through)');

-- ══ U. A count with no assignee ═══════════════════════════════════════════
select is(
  pg_temp.each(array['nobody', 'outZ', 'rmv', 'dis', 'exp', 'vwr', 'noAdj', 'stf'],
               format($q$select r.notes from public.release_cycle_count(%L, 'Not mine') r where r.notes = 'S42 private note'$q$, :cUn)),
  'nobody=42501:-:forbidden, outZ=42501:-:forbidden, rmv=42501:-:forbidden, dis=42501:-:forbidden, '
  'exp=42501:-:forbidden, vwr=42501:-:forbidden, noAdj=42501:-:forbidden, stf=42501:-:forbidden',
  'U1: a count with no assignee is released by no one but a manager: a member of no organization, another organization''s manager, the removed member, the disabled account, the expired seat, the viewer, the revoked member and plain staff are refused (42501 forbidden). Before S42 each of them released it and got its row back, private note and all (ok:1)');
select is(
  pg_temp.each(array['mgr', 'mgrNoAdj'], format($q$select public.release_cycle_count(%L, 'Tidy up')$q$, :cUn),
               format('select pg_temp.assignment(%L)', :cUn)),
  'mgr=ok:1:-/-/-/3, mgrNoAdj=ok:1:-/-/-/3',
  'U2: a manager, with or without stock:adjust, still releases a count with no assignee (a no-op on the assignment that moves assignment_version), as before');
select is(
  pg_temp.attempt('authenticated', :asg, format($q$select public.release_cycle_count(%L, 'Shift ending')$q$, :cUn)),
  '42501:-:forbidden',
  'U3: the assignee of other counts, on a count no one is assigned to (a stale screen after a manager released it), is refused (42501 forbidden; through the app, S42b, this member of the count''s organization is told "This count was already released."). Before S42 the call succeeded as a no-op');
select is(
  pg_temp.again('asg', :cAsg),
  'first=ok, again=42501:-:forbidden, after=-/-/-/2',
  'U4: the assignee releases their own count, then sends the same release again (the phone''s retry when the first answer was lost): the first call releases it; the second finds no assignee and is refused (42501 forbidden; through the app, S42b, they are told "This count was already released." and no second audit row is written). Before S42 the second call succeeded as a no-op and moved assignment_version again (after=-/-/-/3)');

-- ══ S. The twin and the family ════════════════════════════════════════════
select is(
  pg_temp.attempt('authenticated', :rmv, format('select public.release_picking(%L)', :oRmv)) || ' / '
  || pg_temp.attempt('authenticated', :dis, format('select public.release_picking(%L)', :oDis)) || ' / '
  || pg_temp.each(array['stf', 'mgr'], format('select public.release_picking(%L)', :oNone)),
  '42501:-:forbidden / 42501:-:forbidden / stf=42501:-:forbidden, mgr=ok:1',
  'S1: the twin, release_picking (0240): the removed picker and the disabled picker are refused their own pick, and plain staff an order with no picker; a manager releases it');
select is(
  pg_temp.each(array['rmvMgr', 'disMgr', 'mgr'], format('select public.assign_cycle_count(%L, %L)', :cUn, :asg)) || ' / '
  || pg_temp.each(array['rmvMgr', 'disMgr', 'mgr'],
                  format($q$select public.force_reassign_cycle_count(%L, %L, 'Cover the shift')$q$, :cAsg, :stf)),
  'rmvMgr=42501:-:forbidden, disMgr=42501:-:forbidden, mgr=ok:1 / rmvMgr=42501:-:forbidden, disMgr=42501:-:forbidden, mgr=ok:1',
  'S2: the family: assign_cycle_count and force_reassign_cycle_count refuse a removed manager and a disabled manager (has_org_role); a manager assigns and reassigns');

-- ══ M. Mutations: each block taken out of the live body, inside an undone attempt ══
select is(
  (select string_agg(w || '=' || pg_temp.attempt('authenticated', (select p.id from persona p where p.who = w),
             format($q$select public.release_cycle_count(%L, 'Not mine')$q$, :cUn),
             format('select pg_temp.unpatch(%L, %L)', 'public.release_cycle_count(uuid, text)', $c$  -- S42: a count nobody is assigned to is nobody's own. The check below
  -- compares assigned_to with the caller, which is NULL for such a count,
  -- and an IF treats NULL as false, so that check refused no one: any
  -- signed-in caller, of any organization, who knew the count's id could
  -- release it and read the whole row back past row level security. Only a
  -- manager of the count's organization releases an unassigned count, the
  -- rule release_picking has for an order with no picker. Decided on the
  -- row locked above, so someone whose count a manager released a moment
  -- earlier is refused too.
  if v_count.assigned_to is null
     and not public.has_org_role(v_count.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
$c$)), ', ' order by u.o)
     from unnest(array['nobody', 'outZ', 'rmv', 'stf', 'asg']) with ordinality u(w, o)),
  'nobody=ok:1, outZ=ok:1, rmv=ok:1, stf=ok:1, asg=ok:1',
  'M1: release_cycle_count without the unassigned block lets a member of no organization, another organization''s manager, the removed member, plain staff and a stale assignee release a count with no assignee: U1 and U3 fail on it');
select is(
  pg_temp.own(array[array['rmv', :cRmv], array['dis', :cDis], array['exp', :cExp], array['vwr', :cVwr],
                    array['noAdj', :cNoAdj]],
              format('select pg_temp.unpatch(%L, %L)', 'public.release_cycle_count(uuid, text)', $c$  -- S42: the assignee's release is for someone who may still count in the
  -- count's organization: has_permission 'stock:adjust', which the app asks
  -- before every release (CycleCountsService.release) and the line update
  -- policy asks before every count. It is false without an accepted
  -- membership that has not expired, of an account that is not disabled,
  -- and when stock:adjust is revoked or never held (a viewer). Without it,
  -- a member removed from the organization (removal keeps the account and
  -- the assignment), a disabled account (its access token outlives the
  -- disable), an expired "act as" seat, a viewer and a member whose
  -- stock:adjust was revoked could each release a count still assigned to
  -- them by calling this function. A manager without stock:adjust still
  -- releases as a manager (below).
  if v_count.assigned_to = v_user
     and not public.has_permission(v_count.organization_id, 'stock:adjust')
     and not public.has_org_role(v_count.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
$c$)),
  'rmv=ok:1, dis=ok:1, exp=ok:1, vwr=ok:1, noAdj=ok:1',
  'M2: release_cycle_count without the assignee block lets the removed member, the disabled account, the expired seat, the viewer and the revoked member release their own count: A3-A7 fail on it');

-- ══ G. Never a retryable error ════════════════════════════════════════════
select is(
  (select (p.prosrc ~* '40001|40P01|serialization_failure|deadlock_detected')::text
     from pg_proc p where p.oid = to_regprocedure('public.release_cycle_count(uuid, text)')),
  'false',
  'G1: release_cycle_count names neither 40001 nor 40P01 (PostgREST retries those forever)');

-- ══ Z. Every undone attempt changed nothing ═══════════════════════════════
select is(pg_temp.state(), (select v from snap),
  'Z1: the undone attempts (the M-section''s mutations included) left organization A''s counts (assignment columns, assignment_version, updated_at), its orders'' pickers, its notifications and the bodies of release_cycle_count, release_picking, assign_cycle_count and force_reassign_cycle_count as they were');

select * from finish();
rollback;
