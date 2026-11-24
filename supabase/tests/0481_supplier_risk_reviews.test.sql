-- supabase/tests/0481_supplier_risk_reviews.test.sql
-- Proves migration 0481: public.supplier_risk_reviews and
-- public.supplier_risk_items, the admins' eight functions, the daily job's two
-- and the private helpers.
--
-- WHAT IS WORTH PINNING
--   1. Shape: the designed columns, the foreign keys (organizations cascade,
--      the two person links SET NULL, the items to their review in the same
--      organization; none to suppliers), the two unique "one per supplier"
--      indexes, the two triggers, RLS on and no policy, nothing DEFERRABLE.
--   2. Privileges, for anon, authenticated and service_role on every object:
--      no table privilege for any of them and none to PUBLIC; the eight admin
--      functions EXECUTE to authenticated only, the two job functions to
--      service_role only, the fourteen helpers to nobody; SECURITY DEFINER
--      exactly for the ten; search_path pinned on all; reads STABLE; the
--      security invariants' INV-25 finds every authenticated function gated.
--   3. The question list (the core list's twin) and the rules: the case table
--      between the VENDOR RISK CASES markers, run here against the database's
--      rules and in vendor-risk.parity.test.ts against core's (every hard
--      stop, every boundary, Not shown never a pass); the default next review
--      dates between the VENDOR RISK DATES markers, the same way.
--   4. The answers check: each refusal by its word (the answer-problem table
--      between the VENDOR RISK ANSWER PROBLEMS markers, run here and in
--      vendor-risk.parity.test.ts), through the function and through the
--      table's CHECK on a write by the table's owner; a result that is not
--      the rules' is refused by the CHECK.
--   5. Who: an owner, an admin and a live act-as seat may; a manager, a staff
--      member, a viewer, an admin of another organization, a disabled admin,
--      an invitation not accepted, an expired act-as seat, an outsider and
--      nobody signed in are refused every read and every write (42501); anon
--      has no EXECUTE; the authenticator rule (0472's check) applies.
--   6. Drafts, finishing (one current per supplier, versions, the override
--      and its reason, the next review date, exactly one item per gap),
--      discarding, the items' changes, the history and the register (an
--      archived and a deleted supplier kept and marked; a supplier of another
--      organization never reviewed).
--   7. Kept as written: a final review and an item's finding by any path.
--   8. An account deleted: the link empties, the name stays. An
--      organization deleted: its reviews and items go.
--   9. The reminders: what is due in 30 days or today, in the organization's
--      zone, and the stamp-first claim (true once; the two-session proof is
--      scripts/db-concurrency/0481_supplier_risk_reminder_race.sh).
--  10. Holes the red checks found: the text rule counts characters; the
--      tables' own checks of a version, names, an item per question, an
--      owner's name, text lengths and a fifth status; the 30-day stamp kept;
--      the first closing time kept; another organization's draft and items
--      out of reach; a renamed supplier's name on the final; every today in
--      the organization's zone at any hour (W behind UTC, Z ahead); each
--      write's lock before its reads.
--
-- Every vendor, person and organization below is made up. Namespace
-- a0481000. Wrapped in begin/rollback: nothing leaks. Run via `supabase test
-- db` after `supabase db reset`.

begin;

select plan(115);

set local timezone = 'UTC';

\set orgA 'a0481000-0000-0000-0000-0000000000a1'
\set orgB 'a0481000-0000-0000-0000-0000000000a2'
\set orgC 'a0481000-0000-0000-0000-0000000000a3'
\set orgD 'a0481000-0000-0000-0000-0000000000a4'
\set orgZ 'a0481000-0000-0000-0000-0000000000a5'
\set orgY 'a0481000-0000-0000-0000-0000000000a6'
\set ownerA 'a0481000-0000-0000-0000-0000000000c1'
\set adminA 'a0481000-0000-0000-0000-0000000000c2'
\set managerA 'a0481000-0000-0000-0000-0000000000c3'
\set staffA 'a0481000-0000-0000-0000-0000000000c4'
\set viewerA 'a0481000-0000-0000-0000-0000000000c5'
\set adminB 'a0481000-0000-0000-0000-0000000000c6'
\set actas 'a0481000-0000-0000-0000-0000000000c7'
\set actasOld 'a0481000-0000-0000-0000-0000000000c8'
\set disabledAdmin 'a0481000-0000-0000-0000-0000000000c9'
\set invitedAdmin 'a0481000-0000-0000-0000-0000000000ca'
\set outsider 'a0481000-0000-0000-0000-0000000000cb'
\set leaver 'a0481000-0000-0000-0000-0000000000cc'
\set adminC 'a0481000-0000-0000-0000-0000000000cd'
\set adminC2 'a0481000-0000-0000-0000-0000000000ce'
\set ownerD 'a0481000-0000-0000-0000-0000000000cf'
\set ownerZ 'a0481000-0000-0000-0000-0000000000d1'
\set ownerY 'a0481000-0000-0000-0000-0000000000d2'
\set staffB 'a0481000-0000-0000-0000-0000000000d3'
\set supA1 'a0481000-0000-0000-0000-0000000000e1'
\set supA2 'a0481000-0000-0000-0000-0000000000e2'
\set supA3 'a0481000-0000-0000-0000-0000000000e3'
\set supA4 'a0481000-0000-0000-0000-0000000000e4'
\set supA5 'a0481000-0000-0000-0000-0000000000e5'
\set supB1 'a0481000-0000-0000-0000-0000000000e6'
\set supC1 'a0481000-0000-0000-0000-0000000000e7'
\set supD1 'a0481000-0000-0000-0000-0000000000e8'
\set supZ1 'a0481000-0000-0000-0000-0000000000e9'
\set supY1 'a0481000-0000-0000-0000-0000000000ea'
\set supR1 'a0481000-0000-0000-0000-0000000000f1'
\set supR2 'a0481000-0000-0000-0000-0000000000f2'
\set supR3 'a0481000-0000-0000-0000-0000000000f3'
\set supR4 'a0481000-0000-0000-0000-0000000000f4'
\set supR5 'a0481000-0000-0000-0000-0000000000f5'
\set supR6 'a0481000-0000-0000-0000-0000000000f6'
\set supR7 'a0481000-0000-0000-0000-0000000000f7'
\set supR8 'a0481000-0000-0000-0000-0000000000f8'

-- First, before any helper names the tables.
select has_table('public', 'supplier_risk_reviews', '0481/1: the reviews table exists');
select has_table('public', 'supplier_risk_items', '0481/2: the items table exists');

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- Runs p_sql (one SELECT giving one value) as p_role with the claims of p_sub
-- at p_aal. Kept when it succeeds; on an error undone, and the answer is
-- 'ERR <sqlstate> <message>' with ' hint=<hint>' when there is one.
create function pg_temp.run_as(p_role text, p_sub uuid, p_sql text, p_aal text default 'aal1')
returns text language plpgsql as $f$
declare
  v_out   text;
  v_state text;
  v_msg   text;
  v_hint  text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_sub, 'role', p_role, 'aal', p_aal)::text, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
  begin
    perform set_config('role', p_role, true);
    execute p_sql into v_out;
    perform set_config('role', 'none', true);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
    v_out := 'ERR ' || v_state || ' ' || v_msg || coalesce(' hint=' || nullif(v_hint, ''), '');
  end;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  return v_out;
end $f$;

create function pg_temp.as_user(p_sub uuid, p_sql text, p_aal text default 'aal1')
returns text language sql as $f$ select pg_temp.run_as('authenticated', p_sub, p_sql, p_aal) $f$;

-- Runs p_sql as the table's owner and undoes it: 'ok', or the SQLSTATE and
-- the constraint (or the message) that refused it.
create function pg_temp.try(p_sql text) returns text language plpgsql as $f$
declare
  v_c text;
  v_m text;
begin
  begin
    execute p_sql;
    raise exception 'pg_temp.try: undone';
  exception when others then
    if sqlerrm = 'pg_temp.try: undone' then
      return 'ok';
    end if;
    get stacked diagnostics v_c = constraint_name, v_m = message_text;
    return sqlstate || ':' || coalesce(nullif(v_c, ''), v_m);
  end;
end $f$;

-- Every grant on a function other than its owner's, as role:privilege.
create function pg_temp.grants_of(p regprocedure) returns text language sql as $f$
  select coalesce(string_agg(case when x.grantee = 0 then 'PUBLIC' else x.grantee::regrole::text end
                             || ':' || x.privilege_type, ' ' order by 1), '')
    from pg_proc pr, aclexplode(coalesce(pr.proacl, acldefault('f', pr.proowner))) x
   where pr.oid = p and x.grantee <> pr.proowner;
$f$;
-- Every grant on a table other than its owner's.
create function pg_temp.table_grants(p regclass) returns text language sql as $f$
  select coalesce(string_agg(case when x.grantee = 0 then 'PUBLIC' else x.grantee::regrole::text end
                             || ':' || x.privilege_type, ' ' order by 1), '')
    from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x
   where c.oid = p and x.grantee <> c.relowner;
$f$;

-- The answers of a review: every question asked at the level Yes, then the
-- overrides ({key: no | not_shown | yes | missing}; missing leaves it out).
create function pg_temp.answers(p_level text, p_over jsonb default '{}') returns jsonb language sql as $f$
  select coalesce(jsonb_object_agg(k.key, jsonb_build_object('answer', k.a)), '{}'::jsonb)
    from (select q.key, coalesce(p_over ->> q.key, 'yes') as a
            from public._supplier_risk_questions() q
           where p_level <> 'none' and (not q.student_only or p_level = 'student')
          union all
          select o.key, o.value #>> '{}'
            from jsonb_each(p_over) o
           where not exists (select 1 from public._supplier_risk_questions() q
                              where q.key = o.key and p_level <> 'none'
                                and (not q.student_only or p_level = 'student'))) k
   where k.a <> 'missing';
$f$;

-- The items for a finish: one for each gap, with made-up words.
create function pg_temp.items(p_level text, p_over jsonb default '{}', p_owner uuid default null, p_due date default null)
returns jsonb language sql as $f$
  select coalesce(jsonb_agg(jsonb_build_object('question_key', q.key, 'finding', 'Finding about ' || q.key,
                                               'action', 'Action for ' || q.key, 'owner_user_id', p_owner,
                                               'due_on', p_due) order by q.ord), '[]'::jsonb)
    from public._supplier_risk_questions() q
   where p_level <> 'none' and (not q.student_only or p_level = 'student')
     and coalesce(p_over ->> q.key, 'yes') in ('no', 'not_shown');
$f$;

-- The organization's today, as the functions compute it.
create function pg_temp.today(p_org uuid) returns date language sql as $f$
  select (now() at time zone public._supplier_risk_org_zone(p_org))::date;
$f$;

-- A final review written straight into the table as its owner (for the
-- reminders, whose dates the functions would not take).
create function pg_temp.final_row(p_id uuid, p_org uuid, p_supplier uuid, p_version integer, p_current boolean,
                                  p_next date, p_reviewed timestamptz, p_r30 timestamptz default null,
                                  p_rdue timestamptz default null)
returns void language sql as $f$
  insert into public.supplier_risk_reviews
    (id, organization_id, supplier_id, supplier_name, version, status, is_current, data_level, answers,
     starting_risk, evidence, residual_risk, hard_stops, computed_result, reviewer_id, reviewer_name,
     reviewed_at, next_review_on, reminded_30_at, reminded_due_at)
  select p_id, p_org, p_supplier, 'Reminder fixture', p_version, 'final', p_current, 'staff', a.ans,
         e ->> 'starting_risk', e ->> 'evidence', e ->> 'residual_risk',
         array(select jsonb_array_elements_text(e -> 'hard_stops')), e ->> 'result',
         null, 'Made-up Reviewer', p_reviewed, p_next, p_r30, p_rdue
    from (select pg_temp.answers('staff', '{"insurance": "no"}') as ans) a,
         lateral public._supplier_risk_evaluate(1::smallint, 'staff', a.ans) e;
$f$;

-- ── Fixtures ────────────────────────────────────────────────────────────────
insert into auth.users (id, email, raw_user_meta_data) values
  (:'ownerA',        'vr-owner-a@test.local',          '{"full_name": "Made-up Owner A"}'::jsonb),
  (:'adminA',        'vr-admin-a@test.local',          '{"full_name": "Made-up Admin A"}'::jsonb),
  (:'managerA',      'vr-manager-a@test.local',        '{"full_name": "Made-up Manager A"}'::jsonb),
  (:'staffA',        'vr-staff-a@test.local',          '{"full_name": "Made-up Staff A"}'::jsonb),
  (:'viewerA',       'vr-viewer-a@test.local',         '{"full_name": "Made-up Viewer A"}'::jsonb),
  (:'adminB',        'vr-admin-b@test.local',          '{"full_name": "Made-up Admin B"}'::jsonb),
  (:'actas',         'vr-act-as@test.local',           '{"full_name": "Made-up Act As"}'::jsonb),
  (:'actasOld',      'vr-act-as-old@test.local',       '{"full_name": "Made-up Act As Old"}'::jsonb),
  (:'disabledAdmin', 'vr-disabled-admin@test.local',   '{"full_name": "Made-up Disabled Admin"}'::jsonb),
  (:'invitedAdmin',  'vr-invited-admin@test.local',    '{"full_name": "Made-up Invited Admin"}'::jsonb),
  (:'outsider',      'vr-outsider@test.local',         '{"full_name": "Made-up Outsider"}'::jsonb),
  (:'leaver',        'vr-leaver@test.local',           '{"full_name": "Made-up Leaver"}'::jsonb),
  (:'adminC',        'vr-admin-c@test.local',          '{"full_name": "Made-up Admin C"}'::jsonb),
  (:'adminC2',       'vr-admin-c2@test.local',         '{"full_name": "Made-up Admin C Two"}'::jsonb),
  (:'ownerD',        'vr-owner-d@test.local',          '{"full_name": "Made-up Owner D"}'::jsonb),
  (:'ownerZ',        'vr-owner-z@test.local',          '{"full_name": "Made-up Owner Z"}'::jsonb),
  (:'ownerY',        'vr-owner-y@test.local',          '{}'::jsonb),
  (:'staffB',        'vr-staff-b@test.local',          '{"full_name": "Made-up Staff B"}'::jsonb);
update public.user_profiles set disabled_at = now() where id = :'disabledAdmin';
-- Admin C Two has a verified authenticator.
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
values ('a0481000-0000-0000-0000-0000000000fa', :'adminC2', 'made-up phone', 'totp', 'verified', now(), now());

insert into public.organizations (id, name, slug, mfa_policy, timezone) values
  (:'orgA', 'Vendor Risk Org A', 'a0481000-org-a', 'optional', 'America/Los_Angeles'),
  (:'orgB', 'Vendor Risk Org B', 'a0481000-org-b', 'optional', 'America/New_York'),
  (:'orgC', 'Vendor Risk Org C', 'a0481000-org-c', 'admins_required', 'UTC'),
  (:'orgD', 'Vendor Risk Org D', 'a0481000-org-d', 'optional', 'UTC'),
  (:'orgZ', 'Vendor Risk Org Z', 'a0481000-org-z', 'optional', 'Pacific/Kiritimati'),
  (:'orgY', 'Vendor Risk Org Y', 'a0481000-org-y', 'optional', 'PST');
insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at) values
  (:'orgA', :'ownerA',        'owner',   now(), null),
  (:'orgA', :'adminA',        'admin',   now(), null),
  (:'orgA', :'managerA',      'manager', now(), null),
  (:'orgA', :'staffA',        'staff',   now(), null),
  (:'orgA', :'viewerA',       'viewer',  now(), null),
  (:'orgA', :'actas',         'owner',   now(), now() + interval '1 hour'),
  (:'orgA', :'actasOld',      'owner',   now(), now() - interval '1 hour'),
  (:'orgA', :'disabledAdmin', 'admin',   now(), null),
  (:'orgA', :'invitedAdmin',  'admin',   null,  null),
  (:'orgA', :'leaver',        'admin',   now(), null),
  (:'orgB', :'adminB',        'owner',   now(), null),
  (:'orgB', :'staffB',        'staff',   now(), null),
  (:'orgC', :'adminC',        'owner',   now(), null),
  (:'orgC', :'adminC2',       'admin',   now(), null),
  (:'orgD', :'ownerD',        'owner',   now(), null),
  (:'orgZ', :'ownerZ',        'owner',   now(), null),
  (:'orgY', :'ownerY',        'owner',   now(), null);

insert into public.suppliers (id, organization_id, name, deleted_at) values
  (:'supA1', :'orgA', 'Example Paper Co',        null),
  (:'supA2', :'orgA', 'Sample Learning Apps',    null),
  (:'supA3', :'orgA', 'Demo Furniture Works',    now() - interval '3 days'),
  (:'supA4', :'orgA', 'Placeholder Snacks',      null),
  (:'supA5', :'orgA', 'Test Printing Ltd',       null),
  (:'supB1', :'orgB', 'Example Paper Co',        null),
  (:'supC1', :'orgC', 'Fictional Bus Lines',     null),
  (:'supD1', :'orgD', 'Imaginary Uniforms',      null),
  (:'supZ1', :'orgZ', 'Island Time Supplies',    null),
  (:'supY1', :'orgY', 'Pretend Pencils',         null),
  (:'supR1', :'orgA', 'Reminder Due Today',      null),
  (:'supR2', :'orgA', 'Reminder Overdue',        null),
  (:'supR3', :'orgA', 'Reminder In Thirty',      null),
  (:'supR4', :'orgA', 'Reminder In Thirty One',  null),
  (:'supR5', :'orgA', 'Reminder Made Late',      null),
  (:'supR6', :'orgA', 'Reminder Already Sent',   null),
  (:'supR7', :'orgA', 'Reminder Archived',       null),
  (:'supR8', :'orgA', 'Reminder Superseded',     null);

-- ── 1. Shape ────────────────────────────────────────────────────────────────
select is(
  (select array_agg(a.attname::text order by a.attnum) from pg_attribute a
    where a.attrelid = 'public.supplier_risk_reviews'::regclass and a.attnum > 0 and not a.attisdropped),
  array['id', 'organization_id', 'supplier_id', 'supplier_name', 'version', 'status', 'is_current',
        'rules_version', 'data_level', 'answers', 'starting_risk', 'evidence', 'residual_risk', 'hard_stops',
        'computed_result', 'override_result', 'override_reason', 'result', 'reviewer_id', 'reviewer_name',
        'reviewed_at', 'next_review_on', 'reminded_30_at', 'reminded_due_at', 'created_at', 'updated_at'],
  '0481/3: the reviews have exactly the designed columns');
select is(
  (select array_agg(a.attname::text order by a.attnum) from pg_attribute a
    where a.attrelid = 'public.supplier_risk_items'::regclass and a.attnum > 0 and not a.attisdropped),
  array['id', 'organization_id', 'review_id', 'question_key', 'answer', 'severity', 'finding', 'action',
        'owner_user_id', 'owner_name', 'due_on', 'status', 'closed_at', 'created_at', 'updated_at'],
  '0481/4: the items have exactly the designed columns');
select is(
  (select string_agg(c.conrelid::regclass::text || '.' || c.conname || '>' || c.confrelid::regclass::text
                     || ':' || c.confdeltype::text || ':' || c.condeferrable::text, ',' order by c.conrelid::regclass::text, c.conname)
     from pg_constraint c
    where c.contype = 'f' and c.conrelid in ('public.supplier_risk_reviews'::regclass, 'public.supplier_risk_items'::regclass)),
  'supplier_risk_items.supplier_risk_items_owner_user_id_fkey>user_profiles:n:false,'
  'supplier_risk_items.supplier_risk_items_review_fkey>supplier_risk_reviews:c:false,'
  'supplier_risk_reviews.supplier_risk_reviews_organization_id_fkey>organizations:c:false,'
  'supplier_risk_reviews.supplier_risk_reviews_reviewer_id_fkey>user_profiles:n:false',
  '0481/5: the foreign keys are exactly: the organization (cascade), the two person links (SET NULL) and the item''s review (cascade); none to suppliers, none deferrable');
select is(
  (select array_agg(a.attname::text order by k.n)
     from pg_constraint c, unnest(c.conkey) with ordinality k(attnum, n)
     join pg_attribute a on a.attnum = k.attnum
    where c.conname = 'supplier_risk_items_review_fkey' and a.attrelid = c.conrelid),
  array['organization_id', 'review_id'],
  '0481/6: an item''s review key includes the organization, so an item cannot point at another organization''s review');
select is(
  (select string_agg(i.relname || ':' || x.indisunique::text || ':' || coalesce(pg_get_expr(x.indpred, x.indrelid), '-'), ' | ' order by i.relname)
     from pg_index x join pg_class i on i.oid = x.indexrelid
    where x.indrelid = 'public.supplier_risk_reviews'::regclass
      and i.relname in ('supplier_risk_reviews_one_current', 'supplier_risk_reviews_one_draft')),
  'supplier_risk_reviews_one_current:true:is_current | supplier_risk_reviews_one_draft:true:(status = ''draft''::text)',
  '0481/7: one current review and one draft per supplier, each by a unique index');
select is(
  (select string_agg(t.tgrelid::regclass::text || '.' || t.tgname || ':' || t.tgfoid::regproc::text, ',' order by t.tgname)
     from pg_trigger t
    where t.tgrelid in ('public.supplier_risk_reviews'::regclass, 'public.supplier_risk_items'::regclass)
      and not t.tgisinternal),
  'supplier_risk_items.supplier_risk_items_kept:_supplier_risk_items_guard,supplier_risk_reviews.supplier_risk_reviews_kept:_supplier_risk_reviews_guard',
  '0481/8: each table has exactly one trigger of its own, the guard of what is kept');
select is(
  (select array[c.relrowsecurity, c.relforcerowsecurity]::text from pg_class c where c.oid = 'public.supplier_risk_reviews'::regclass)
  || (select array[c.relrowsecurity, c.relforcerowsecurity]::text from pg_class c where c.oid = 'public.supplier_risk_items'::regclass)
  || (select count(*)::text from pg_policy p
       where p.polrelid in ('public.supplier_risk_reviews'::regclass, 'public.supplier_risk_items'::regclass)),
  '{t,f}{t,f}0',
  '0481/9: RLS is on for both tables and neither has a policy');
select is(
  (select count(*)::int from pg_constraint c
    where c.conrelid in ('public.supplier_risk_reviews'::regclass, 'public.supplier_risk_items'::regclass)
      and (c.condeferrable or c.condeferred)),
  0,
  '0481/10: nothing here is DEFERRABLE (0393 K13: every check of an account deletion fires at once)');

-- ── 2. Privileges ───────────────────────────────────────────────────────────
select table_privs_are('public', 'supplier_risk_reviews', 'anon', array[]::text[], '0481/11: anon has no privilege on the reviews');
select table_privs_are('public', 'supplier_risk_reviews', 'authenticated', array[]::text[], '0481/12: authenticated has no privilege on the reviews');
select table_privs_are('public', 'supplier_risk_reviews', 'service_role', array[]::text[], '0481/13: service_role has no privilege on the reviews');
select table_privs_are('public', 'supplier_risk_items', 'anon', array[]::text[], '0481/14: anon has no privilege on the items');
select table_privs_are('public', 'supplier_risk_items', 'authenticated', array[]::text[], '0481/15: authenticated has no privilege on the items');
select table_privs_are('public', 'supplier_risk_items', 'service_role', array[]::text[], '0481/16: service_role has no privilege on the items');
select is(
  array[pg_temp.table_grants('public.supplier_risk_reviews'), pg_temp.table_grants('public.supplier_risk_items'),
        (select count(*)::text from pg_attribute a
          where a.attrelid in ('public.supplier_risk_reviews'::regclass, 'public.supplier_risk_items'::regclass)
            and a.attnum > 0 and a.attacl is not null)],
  array['', '', '0'],
  '0481/17: neither table has a grant beside its owner''s (none to PUBLIC), and no column has a grant of its own');

-- And by trying: every direct read and write of either table, as each of the
-- three API roles, is refused by the grant before row security is asked.
select is(
  (select array_agg(split_part(pg_temp.run_as(r.role, :'ownerA', format(q.sql, t.tbl)), ' for table', 1) order by r.n, t.n, q.n)
     from unnest(array['anon', 'authenticated', 'service_role']) with ordinality r(role, n),
          unnest(array['public.supplier_risk_reviews', 'public.supplier_risk_items']) with ordinality t(tbl, n),
          unnest(array['select count(*)::text from %s',
                       'with x as (insert into %s default values returning 1) select count(*)::text from x',
                       'with x as (update %s set updated_at = now() returning 1) select count(*)::text from x',
                       'with x as (delete from %s returning 1) select count(*)::text from x']) with ordinality q(sql, n)),
  array_fill('ERR 42501 permission denied'::text, array[24]),
  '0481/18: anon, authenticated and service_role may not select, insert, update or delete either table directly');

-- The functions of this file, by kind.
create temporary table vr_fns (fn regprocedure primary key, kind text not null) on commit drop;
insert into vr_fns values
  ('public.supplier_risk_register(uuid)', 'admin_read'),
  ('public.supplier_risk_history(uuid, uuid)', 'admin_read'),
  ('public.supplier_risk_review(uuid, uuid)', 'admin_read'),
  ('public.supplier_risk_items_for_organization(uuid, boolean)', 'admin_read'),
  ('public.supplier_risk_draft_save(uuid, uuid, text, jsonb)', 'admin_write'),
  ('public.supplier_risk_finalise(uuid, uuid, text, jsonb, date, text, text, jsonb)', 'admin_write'),
  ('public.supplier_risk_draft_discard(uuid, uuid)', 'admin_write'),
  ('public.supplier_risk_item_update(uuid, uuid, text, uuid, date, text)', 'admin_write'),
  ('public.supplier_risk_reminders_due(integer)', 'job_read'),
  ('public.supplier_risk_reminder_claim(uuid, text)', 'job_write'),
  ('public._supplier_risk_questions()', 'private'),
  ('public._supplier_risk_question_key_ok(text)', 'private'),
  ('public._supplier_risk_text_ok(text, integer, integer)', 'private'),
  ('public._supplier_risk_reason_ok(text)', 'private'),
  ('public._supplier_risk_answers_problem(smallint, text, jsonb, boolean)', 'private'),
  ('public._supplier_risk_evaluate(smallint, text, jsonb)', 'private'),
  ('public._supplier_risk_computed_ok(smallint, text, jsonb, text, text, text, text[], text)', 'private'),
  ('public._supplier_risk_default_next_review(text, date)', 'private'),
  ('public._supplier_risk_org_zone(uuid)', 'private'),
  ('public._supplier_risk_reviews_guard()', 'private'),
  ('public._supplier_risk_items_guard()', 'private'),
  ('public._supplier_risk_item_json(public.supplier_risk_items)', 'private'),
  ('public._supplier_risk_person_name(uuid)', 'private'),
  ('public._supplier_risk_is_current_member(uuid, uuid)', 'private');

select is(
  (select array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text) from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and (p.proname like 'supplier\_risk\_%' or p.proname like '\_supplier\_risk\_%')),
  (select array_agg(f.fn::text order by f.fn::text) from vr_fns f),
  '0481/19: the file makes exactly these twenty-four functions');
select is(
  (select string_agg(f.fn::text || '=' || pg_temp.grants_of(f.fn), ' ; ' order by f.fn::text)
     from vr_fns f where pg_temp.grants_of(f.fn) <> case f.kind when 'admin_read' then 'authenticated:EXECUTE'
                                                                when 'admin_write' then 'authenticated:EXECUTE'
                                                                when 'job_read' then 'service_role:EXECUTE'
                                                                when 'job_write' then 'service_role:EXECUTE'
                                                                else '' end),
  null,
  '0481/20: the eight admin functions have exactly one grant, EXECUTE to authenticated; the two job functions exactly EXECUTE to service_role; the fourteen helpers none (nothing to PUBLIC)');
select is(
  (select array_agg(f.kind || ':' || has_function_privilege(r.role, f.fn, 'execute')::text order by f.kind, r.n)
     from (select distinct on (kind) kind, fn from vr_fns order by kind, fn::text) f,
          unnest(array['anon', 'authenticated', 'service_role']) with ordinality as r(role, n)),
  array['admin_read:false', 'admin_read:true', 'admin_read:false',
        'admin_write:false', 'admin_write:true', 'admin_write:false',
        'job_read:false', 'job_read:false', 'job_read:true',
        'job_write:false', 'job_write:false', 'job_write:true',
        'private:false', 'private:false', 'private:false'],
  '0481/21: anon may execute none; authenticated only the admin functions; service_role only the job functions');
select is(
  (select count(*)::int from vr_fns f
    where (select count(*) from vr_fns g where g.kind = f.kind) > 0
      and exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r(role)
                   where has_function_privilege(r.role, f.fn, 'execute')
                         <> (case f.kind when 'admin_read' then r.role = 'authenticated'
                                         when 'admin_write' then r.role = 'authenticated'
                                         when 'job_read' then r.role = 'service_role'
                                         when 'job_write' then r.role = 'service_role'
                                         else false end))),
  0,
  '0481/22: every one of the twenty-four, for each of anon, authenticated and service_role, has exactly the EXECUTE its kind says');
select is(
  (select string_agg(p.proname, ',' order by p.proname) from pg_proc p join vr_fns f on f.fn = p.oid where p.prosecdef),
  'supplier_risk_draft_discard,supplier_risk_draft_save,supplier_risk_finalise,supplier_risk_history,supplier_risk_item_update,'
  'supplier_risk_items_for_organization,supplier_risk_register,supplier_risk_reminder_claim,supplier_risk_reminders_due,supplier_risk_review',
  '0481/23: exactly the ten functions an API role may call are SECURITY DEFINER; every helper runs as its caller');
select is(
  (select count(*)::int from pg_proc p join vr_fns f on f.fn = p.oid
    where not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c = 'search_path=""')),
  0,
  '0481/24: every function pins an empty search_path');
select is(
  (select string_agg(p.proname || ':' || p.provolatile::text, ',' order by p.proname) from pg_proc p join vr_fns f on f.fn = p.oid
    where f.kind not like 'private'),
  'supplier_risk_draft_discard:v,supplier_risk_draft_save:v,supplier_risk_finalise:v,supplier_risk_history:s,'
  'supplier_risk_item_update:v,supplier_risk_items_for_organization:s,supplier_risk_register:s,'
  'supplier_risk_reminder_claim:v,supplier_risk_reminders_due:s,supplier_risk_review:s',
  '0481/25: the reads are STABLE and the writes VOLATILE (the authenticator guards read a STABLE function as a read)');
-- security_invariants INV-25 over this file's functions: its conditions, its
-- strip pass and its gate words, word for word.
select is(
  (select coalesce(string_agg(p.proname, ', ' order by p.proname), '')
     from pg_proc p join vr_fns f on f.fn = p.oid
    where p.prosecdef and p.prorettype <> 'trigger'::regtype
      and has_function_privilege('authenticated', p.oid, 'execute')
      and regexp_replace(p.prosrc, $re$/\*(?:[^*]|\*+[^*/])*\*+/|--[^\n\r]*|(')(?:[^']|'')*(')|("(?:[^"]|"")*")$re$, ' \1\2\3 ', 'g')
          !~* $re$\m(auth\.uid|has_org_role|has_permission|is_org_member)\M$re$),
  '',
  '0481/26: INV-25: every SECURITY DEFINER function authenticated may call gates in its own body');
select is(
  (select count(*)::int from pg_proc p join vr_fns f on f.fn = p.oid
    where f.kind in ('admin_read', 'admin_write')
      and (p.prosrc !~ 'has_org_role\(p_organization_id, ''admin''\)'
           or p.prosrc !~ 'perform public\.security_events_reader_check\(p_organization_id\)'
           or position('has_org_role(p_organization_id, ''admin'')' in p.prosrc)
              > position('security_events_reader_check' in p.prosrc))),
  0,
  '0481/27: each admin function asks has_org_role(organization, ''admin'') first, then 0472''s authenticator check');
select is(
  (select count(*)::int from pg_proc p join vr_fns f on f.fn = p.oid
    where f.kind like 'job%'
      and p.prosrc !~ 'current_setting\(''role'', true\), ''none''\) in \(''authenticated'', ''anon''\)'),
  0,
  '0481/28: each job function reads the role setting as its second lock');
select is(
  (select count(*)::int from vr_fns f
    where coalesce(obj_description(f.fn::oid, 'pg_proc'), '') !~ '0481')
  + (select count(*)::int from unnest(array['public.supplier_risk_reviews', 'public.supplier_risk_items']) t(n)
      where coalesce(obj_description(t.n::regclass, 'pg_class'), '') !~ '0481'),
  0,
  '0481/29: every function and both tables have a comment that names 0481');

-- ── 3. The question list and the rules ──────────────────────────────────────
select is(
  (select string_agg(q.key || ':' || q.grp, ',' order by q.ord) from public._supplier_risk_questions() q),
  'data_listed:holds,data_we_send:holds,hosting_known:holds,data_agreement:paper,breach_notice:paper,'
  'return_or_delete:paper,subvendors_named:paper,security_report:proof,insurance:proof,direct_control:student,'
  'purpose_only:student,no_redisclosure:student,no_sale_or_ads:student,no_ai_training:student',
  '0481/30: fourteen questions in four groups, in order');
select is(
  array[(select count(*)::int from public._supplier_risk_questions() q where false),
        (select count(*)::int from public._supplier_risk_questions() q where not q.student_only),
        (select count(*)::int from public._supplier_risk_questions() q)],
  array[0, 9, 14],
  '0481/31: none is asked with no data of ours, nine with staff contact details, fourteen with student data');
select is(
  (select string_agg(q.key || '>' || q.hard_stop, ',' order by q.ord) from public._supplier_risk_questions() q where q.hard_stop is not null)
  || ' | ' || (select string_agg(q.key, ',' order by q.ord) from public._supplier_risk_questions() q where q.key_evidence)
  || ' | ' || (select string_agg(q.key, ',' order by q.ord) from public._supplier_risk_questions() q where q.has_date),
  'data_agreement>student_data_no_agreement,breach_notice>student_data_no_breach_notice,'
  'no_sale_or_ads>student_data_sale_or_ads,no_ai_training>student_data_ai_training'
  ' | data_agreement,breach_notice,security_report | data_agreement,security_report,insurance',
  '0481/32: the four hard stops, the three key papers and the three questions that take a date');
select is(
  (select count(*)::int from public._supplier_risk_questions() q
    where q.severity_student is null or (q.student_only = (q.severity_staff is not null))
       or (q.hard_stop is not null and q.severity_student <> 'critical')),
  0,
  '0481/33: every question has a severity for student data, one for staff exactly when it is asked for staff, and a hard stop is critical');

-- The case table: vendor-risk.parity.test.ts reads these same rows and runs
-- core's rules on them. answers: the overrides on "every asked question Yes"
-- (missing: left unanswered; it counts as Not shown). hard_stops in question
-- order.
create temporary table vr_cases (n integer primary key, level text, answers jsonb, starting_risk text,
  evidence text, residual_risk text, hard_stops text, result text) on commit drop;
-- VENDOR RISK CASES BEGIN
insert into vr_cases (n, level, answers, starting_risk, evidence, residual_risk, hard_stops, result) values
  (1, 'none', '{}', 'low', 'not_needed', 'low', '', 'approve'),
  (2, 'staff', '{}', 'moderate', 'strong', 'low', '', 'approve'),
  (3, 'staff', '{"insurance": "no"}', 'moderate', 'adequate', 'low', '', 'approve_with_conditions'),
  (4, 'staff', '{"insurance": "not_shown"}', 'moderate', 'adequate', 'low', '', 'approve_with_conditions'),
  (5, 'staff', '{"insurance": "no", "hosting_known": "not_shown"}', 'moderate', 'adequate', 'low', '', 'approve_with_conditions'),
  (6, 'staff', '{"insurance": "no", "hosting_known": "not_shown", "data_listed": "no"}', 'moderate', 'weak', 'moderate', '', 'approve_with_conditions'),
  (7, 'staff', '{"data_agreement": "no"}', 'moderate', 'weak', 'moderate', '', 'approve_with_conditions'),
  (8, 'staff', '{"breach_notice": "no"}', 'moderate', 'weak', 'moderate', '', 'approve_with_conditions'),
  (9, 'staff', '{"security_report": "no"}', 'moderate', 'weak', 'moderate', '', 'approve_with_conditions'),
  (10, 'staff', '{"data_agreement": "not_shown"}', 'moderate', 'insufficient', 'moderate', '', 'more_information'),
  (11, 'staff', '{"breach_notice": "not_shown"}', 'moderate', 'insufficient', 'moderate', '', 'more_information'),
  (12, 'staff', '{"security_report": "not_shown"}', 'moderate', 'insufficient', 'moderate', '', 'more_information'),
  (13, 'staff', '{"data_listed": "not_shown", "data_we_send": "not_shown", "hosting_known": "not_shown", "return_or_delete": "not_shown"}', 'moderate', 'weak', 'moderate', '', 'approve_with_conditions'),
  (14, 'staff', '{"data_listed": "not_shown", "data_we_send": "not_shown", "hosting_known": "not_shown", "return_or_delete": "not_shown", "subvendors_named": "not_shown"}', 'moderate', 'insufficient', 'moderate', '', 'more_information'),
  (15, 'staff', '{"data_listed": "no", "data_we_send": "no", "hosting_known": "no", "data_agreement": "no", "breach_notice": "no", "return_or_delete": "no", "subvendors_named": "no", "security_report": "no", "insurance": "no"}', 'moderate', 'weak', 'moderate', '', 'approve_with_conditions'),
  (16, 'staff', '{"data_listed": "missing"}', 'moderate', 'adequate', 'low', '', 'approve_with_conditions'),
  (17, 'staff', '{"security_report": "no", "insurance": "no"}', 'moderate', 'weak', 'moderate', '', 'approve_with_conditions'),
  (18, 'staff', '{"direct_control": "no", "no_sale_or_ads": "no"}', 'moderate', 'strong', 'low', '', 'approve'),
  (19, 'student', '{}', 'high', 'strong', 'low', '', 'approve'),
  (20, 'student', '{"insurance": "no"}', 'high', 'adequate', 'moderate', '', 'approve_with_conditions'),
  (21, 'student', '{"insurance": "no", "data_listed": "not_shown"}', 'high', 'adequate', 'moderate', '', 'approve_with_conditions'),
  (22, 'student', '{"insurance": "no", "data_listed": "not_shown", "direct_control": "no"}', 'high', 'weak', 'high', '', 'approve_with_conditions'),
  (23, 'student', '{"direct_control": "no", "purpose_only": "no"}', 'high', 'adequate', 'moderate', '', 'approve_with_conditions'),
  (24, 'student', '{"data_agreement": "no"}', 'high', 'weak', 'high', 'student_data_no_agreement', 'do_not_use'),
  (25, 'student', '{"breach_notice": "no"}', 'high', 'weak', 'high', 'student_data_no_breach_notice', 'do_not_use'),
  (26, 'student', '{"no_sale_or_ads": "no"}', 'high', 'adequate', 'high', 'student_data_sale_or_ads', 'do_not_use'),
  (27, 'student', '{"no_ai_training": "no"}', 'high', 'adequate', 'high', 'student_data_ai_training', 'do_not_use'),
  (28, 'student', '{"no_sale_or_ads": "not_shown"}', 'high', 'adequate', 'moderate', '', 'more_information'),
  (29, 'student', '{"no_ai_training": "not_shown"}', 'high', 'adequate', 'moderate', '', 'more_information'),
  (30, 'student', '{"data_agreement": "not_shown"}', 'high', 'insufficient', 'high', '', 'more_information'),
  (31, 'student', '{"breach_notice": "not_shown"}', 'high', 'insufficient', 'high', '', 'more_information'),
  (32, 'student', '{"data_agreement": "no", "no_sale_or_ads": "not_shown"}', 'high', 'weak', 'high', 'student_data_no_agreement', 'do_not_use'),
  (33, 'student', '{"no_ai_training": "no", "data_agreement": "no", "no_sale_or_ads": "no", "breach_notice": "no"}', 'high', 'weak', 'high', 'student_data_no_agreement,student_data_no_breach_notice,student_data_sale_or_ads,student_data_ai_training', 'do_not_use'),
  (34, 'student', '{"data_listed": "not_shown", "data_we_send": "not_shown", "hosting_known": "not_shown", "return_or_delete": "not_shown", "subvendors_named": "not_shown", "insurance": "not_shown", "direct_control": "not_shown"}', 'high', 'weak', 'high', '', 'approve_with_conditions'),
  (35, 'student', '{"data_listed": "not_shown", "data_we_send": "not_shown", "hosting_known": "not_shown", "return_or_delete": "not_shown", "subvendors_named": "not_shown", "insurance": "not_shown", "direct_control": "not_shown", "purpose_only": "not_shown"}', 'high', 'insufficient', 'high', '', 'more_information'),
  (36, 'student', '{"security_report": "no"}', 'high', 'weak', 'high', '', 'approve_with_conditions'),
  (37, 'student', '{"security_report": "not_shown"}', 'high', 'insufficient', 'high', '', 'more_information'),
  (38, 'student', '{"no_ai_training": "missing"}', 'high', 'adequate', 'moderate', '', 'more_information'),
  (39, 'student', '{"no_sale_or_ads": "no", "insurance": "not_shown", "hosting_known": "not_shown"}', 'high', 'weak', 'high', 'student_data_sale_or_ads', 'do_not_use'),
  (40, 'none', '{"insurance": "no"}', 'low', 'not_needed', 'low', '', 'approve');
-- VENDOR RISK CASES END

select is(
  (select string_agg(c.n || ': ' || coalesce(e::text, 'null'), ' ; ' order by c.n)
     from vr_cases c,
          lateral (select public._supplier_risk_evaluate(1::smallint, c.level, pg_temp.answers(c.level, c.answers)) - 'pending_hard_stops') x(e)
    where e is distinct from jsonb_build_object(
            'starting_risk', c.starting_risk, 'evidence', c.evidence, 'residual_risk', c.residual_risk,
            'hard_stops', to_jsonb(coalesce(string_to_array(nullif(c.hard_stops, ''), ','), '{}'::text[])),
            'result', c.result)),
  null,
  '0481/34: the database''s rules give every row of the case table (40 cases: every hard stop, every boundary)');
select is((select count(*)::int from vr_cases), 40, '0481/35: the case table has its 40 rows');
-- Not shown is never a pass: for every question asked at each level, one
-- Not shown among Yes answers is a gap, never Approve, never strong.
select is(
  (select coalesce(string_agg(l.level || '/' || q.key, ',' order by l.level, q.ord), '')
     from unnest(array['staff', 'student']) l(level)
     join public._supplier_risk_questions() q on (not q.student_only or l.level = 'student'),
          lateral (select public._supplier_risk_evaluate(1::smallint, l.level,
                     pg_temp.answers(l.level, jsonb_build_object(q.key, 'not_shown')))) x(e)
    where x.e ->> 'result' = 'approve' or x.e ->> 'evidence' = 'strong'),
  '',
  '0481/36: one Not shown on any asked question, at either level, is never Approve and never strong evidence');
select is(
  (select coalesce(string_agg(q.key || ':' || (x.e ->> 'pending_hard_stops'), ',' order by q.ord), '')
     from public._supplier_risk_questions() q,
          lateral (select public._supplier_risk_evaluate(1::smallint, 'student',
                     pg_temp.answers('student', jsonb_build_object(q.key, 'not_shown')))) x(e)
    where q.hard_stop is not null),
  'data_agreement:["student_data_no_agreement"],breach_notice:["student_data_no_breach_notice"],'
  'no_sale_or_ads:["student_data_sale_or_ads"],no_ai_training:["student_data_ai_training"]',
  '0481/37: a hard-stop question Not shown is a hard stop not yet ruled out');
select is(
  array[public._supplier_risk_evaluate(2::smallint, 'staff', '{}'),
        public._supplier_risk_evaluate(1::smallint, 'everyone', '{}'),
        public._supplier_risk_evaluate(1::smallint, null, '{}')]::text,
  '{NULL,NULL,NULL}',
  '0481/38: the rules answer nothing for another rules version or level');

create temporary table vr_dates (n integer primary key, level text, from_on date, next_on date) on commit drop;
-- VENDOR RISK DATES BEGIN
insert into vr_dates (n, level, from_on, next_on) values
  (1, 'none', '2026-01-15', '2027-01-15'),
  (2, 'staff', '2026-01-15', '2027-01-15'),
  (3, 'student', '2026-01-15', '2026-07-15'),
  (4, 'student', '2026-08-31', '2027-02-28'),
  (5, 'staff', '2028-02-29', '2029-02-28'),
  (6, 'student', '2027-08-29', '2028-02-29'),
  (7, 'student', '2026-12-31', '2027-06-30'),
  (8, 'student', '2026-03-31', '2026-09-30'),
  (9, 'staff', '2026-11-24', '2027-11-24');
-- VENDOR RISK DATES END
select is(
  (select string_agg(d.n::text, ',' order by d.n) from vr_dates d
    where public._supplier_risk_default_next_review(d.level, d.from_on) is distinct from d.next_on),
  null,
  '0481/39: the default next review date: 12 months, 6 with student data, a month''s last day where the day does not exist');

-- ── 4. The answers check and the text rule ──────────────────────────────────
select is(
  array[public._supplier_risk_answers_problem(1::smallint, 'staff', pg_temp.answers('staff'), true),
        public._supplier_risk_answers_problem(1::smallint, 'student', pg_temp.answers('student'), true),
        public._supplier_risk_answers_problem(1::smallint, 'none', '{}', true),
        public._supplier_risk_answers_problem(1::smallint, 'staff', '{}', false),
        public._supplier_risk_answers_problem(1::smallint, 'student',
          '{"data_agreement": {"answer": "yes", "note": "Signed by both sides.\nOn file.", "date": "2026-03-01"},'
          ' "insurance": {"answer": "not_shown", "note": null, "date": null}}', false)],
  array[null, null, null, null, null]::text[],
  '0481/40: complete answers at each level, an empty draft, and notes and dates where they belong are taken');
-- The answer-problem table: vendor-risk.parity.test.ts reads these same rows
-- and runs core's vendorRiskAnswersProblem on them (null: taken). Where an
-- object has two wrong keys, the shorter key is read first (jsonb's order;
-- core sorts the same way): rows 32 and 35.
create temporary table vr_problems (n integer primary key, level text, answers text, final boolean, problem text) on commit drop;
-- VENDOR RISK ANSWER PROBLEMS BEGIN
insert into vr_problems (n, level, answers, final, problem) values
  (1, 'staff', null, false, 'answers_not_an_object'),
  (2, 'staff', '[]', false, 'answers_not_an_object'),
  (3, 'staff', '"yes"', false, 'answers_not_an_object'),
  (4, 'staff', '{"data_listd": {"answer": "yes"}}', false, 'answer_unknown_question'),
  (5, 'staff', '{"direct_control": {"answer": "yes"}}', false, 'answer_not_applicable'),
  (6, 'none', '{"insurance": {"answer": "yes"}}', false, 'answer_not_applicable'),
  (7, 'staff', '{"insurance": "yes"}', false, 'answer_bad_shape'),
  (8, 'staff', '{"insurance": {"answer": "yes", "source": "web"}}', false, 'answer_bad_shape'),
  (9, 'staff', '{"insurance": {"note": "no answer"}}', false, 'answer_bad_value'),
  (10, 'staff', '{"insurance": {"answer": "maybe"}}', false, 'answer_bad_value'),
  (11, 'staff', '{"insurance": {"answer": "YES"}}', false, 'answer_bad_value'),
  (12, 'staff', '{"insurance": {"answer": true}}', false, 'answer_bad_value'),
  (13, 'staff', '{"insurance": {"answer": "yes", "note": ""}}', false, 'answer_bad_note'),
  (14, 'staff', '{"insurance": {"answer": "yes", "note": "   "}}', false, 'answer_bad_note'),
  (15, 'staff', '{"insurance": {"answer": "yes", "note": 5}}', false, 'answer_bad_note'),
  (16, 'staff', '{"hosting_known": {"answer": "yes", "date": "2026-01-01"}}', false, 'answer_date_not_allowed'),
  (17, 'staff', '{"insurance": {"answer": "yes", "date": "2026-02-30"}}', false, 'answer_bad_date'),
  (18, 'staff', '{"insurance": {"answer": "yes", "date": "26-01-01"}}', false, 'answer_bad_date'),
  (19, 'staff', '{"insurance": {"answer": "yes", "date": "1999-12-31"}}', false, 'answer_bad_date'),
  (20, 'staff', '{"insurance": {"answer": "yes", "date": "2101-01-01"}}', false, 'answer_bad_date'),
  (21, 'staff', '{"insurance": {"answer": "yes", "date": 20260101}}', false, 'answer_bad_date'),
  (22, 'staff', '{"insurance": {"answer": "yes"}}', true, 'answers_incomplete'),
  (23, 'everyone', '{}', false, 'bad_data_level'),
  (24, 'staff', '{}', false, null),
  (25, 'none', '{}', true, null),
  (26, 'student', '{"data_agreement": {"answer": "yes", "note": "Signed by both sides.\nOn file.", "date": "2026-03-01"}, "insurance": {"answer": "not_shown", "note": null, "date": null}}', false, null),
  (27, 'staff', '{"insurance": {"answer": "no", "date": "2000-01-01"}, "security_report": {"answer": "yes", "date": "2100-12-31"}}', false, null),
  (28, 'staff', '{"insurance": {"answer": "yes", "date": "2028-02-29"}}', false, null),
  (29, 'staff', '{"insurance": {"answer": "yes", "date": "2027-02-29"}}', false, 'answer_bad_date'),
  (30, 'student', '{"direct_control": {"answer": "yes", "note": null}}', false, null),
  (31, 'staff', '{"insurance": {"answer": "yes", "note": null, "date": null, "extra": null}}', false, 'answer_bad_shape'),
  (32, 'staff', '{"data_listd": {"answer": "maybe"}, "insurance": {"answer": "yes"}}', false, 'answer_unknown_question'),
  (33, 'student', '{"insurance": {"answer": "yes", "note": "nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn"}}', false, null),
  (34, 'student', '{"insurance": {"answer": "yes", "note": "nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn"}}', false, 'answer_bad_note'),
  (35, 'staff', '{"insurance": {"answer": "maybe"}, "data_listd": {"answer": "yes"}}', false, 'answer_bad_value');
-- VENDOR RISK ANSWER PROBLEMS END
select is(
  (select string_agg(p.n || ': ' || coalesce(x.problem, 'null'), ' ; ' order by p.n)
     from vr_problems p,
          lateral (select public._supplier_risk_answers_problem(1::smallint, p.level, p.answers::jsonb, p.final)) x(problem)
    where x.problem is distinct from p.problem),
  null,
  '0481/41: each kind of wrong answer is refused by its own word, and the right ones are taken (the answer-problem table, 35 rows)');
select is(
  (select array_agg(public._supplier_risk_text_ok(t.s, 1, 20) order by t.n)
     from unnest(array['Plain words.', 'Two' || chr(10) || 'lines' || chr(13) || chr(10) || 'and a' || chr(9) || 'tab',
                       repeat('x', 20), repeat('x', 21), '', ' ' || chr(10) || chr(9), 'Bell' || chr(7),
                       'Esc' || chr(27), 'Del' || chr(127), 'C1' || chr(133), 'Zero' || chr(8203) || 'width',
                       'Right' || chr(8238) || 'left', 'Iso' || chr(8294) || 'late', 'Bom' || chr(65279),
                       'Line' || chr(8232) || 'sep', null]) with ordinality t(s, n)),
  array[true, true, true, false, false, false, false, false, false, false, false, false, false, false, false, false],
  '0481/42: the text rule takes plain words, line breaks and tabs, and refuses empty, blank, too long, control, invisible and direction characters');
select is(
  array[public._supplier_risk_reason_ok('Vendor fixed it.'), public._supplier_risk_reason_ok('Too short'),
        public._supplier_risk_reason_ok('   Too short   '), public._supplier_risk_reason_ok(repeat('y', 2000)),
        public._supplier_risk_reason_ok(repeat('y', 2001)), public._supplier_risk_reason_ok(null)],
  array[true, false, false, true, false, false],
  '0481/43: a reason is 10 to 2000 characters, counted after trimming the ends');

-- The table holds the same rules on its own, for its owner too.
select is(
  array[pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version,
          data_level, answers, reviewer_name) values (%L, %L, 'X', 1, 'staff', '{"direct_control": {"answer": "yes"}}', 'X')$$,
          :'orgA', :'supA5')),
        pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version,
          data_level, answers, reviewer_name) values (%L, %L, 'X', 1, 'staff', '{"insurance": {"answer": "maybe"}}', 'X')$$,
          :'orgA', :'supA5')),
        pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version,
          data_level, answers, reviewer_name) values (%L, %L, 'X', 1, 'staff', '{}', 'X')$$, :'orgA', :'supA5'))],
  array['23514:supplier_risk_reviews_answers', '23514:supplier_risk_reviews_answers', 'ok'],
  '0481/44: a draft written straight into the table is held to the answers check');
select is(
  array[pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version,
          status, is_current, data_level, answers, starting_risk, evidence, residual_risk, hard_stops, computed_result,
          reviewer_name, reviewed_at, next_review_on)
          values (%L, %L, 'X', 1, 'final', true, 'student', %L, 'high', 'weak', 'high', '{}', 'approve', 'X', now(), current_date + 30)$$,
          :'orgA', :'supA5', pg_temp.answers('student', '{"data_agreement": "no"}'))),
        pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version,
          status, is_current, data_level, answers, starting_risk, evidence, residual_risk, hard_stops, computed_result,
          reviewer_name, reviewed_at, next_review_on)
          values (%L, %L, 'X', 1, 'final', true, 'student', %L, 'high', 'weak', 'high', '{student_data_no_agreement}',
                  'do_not_use', 'X', now(), current_date + 30)$$,
          :'orgA', :'supA5', pg_temp.answers('student', '{"data_agreement": "no"}'))),
        pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version,
          status, is_current, data_level, answers, starting_risk, evidence, residual_risk, hard_stops, computed_result,
          reviewer_name, reviewed_at, next_review_on)
          values (%L, %L, 'X', 1, 'final', true, 'student', %L, 'high', 'weak', 'high', '{student_data_no_agreement}',
                  'do_not_use', 'X', now(), null)$$,
          :'orgA', :'supA5', pg_temp.answers('student', '{"data_agreement": "no"}'))),
        pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version,
          data_level, answers, reviewer_name, computed_result) values (%L, %L, 'X', 1, 'staff', '{}', 'X', 'approve')$$,
          :'orgA', :'supA5'))],
  array['23514:supplier_risk_reviews_computed', 'ok', '23514:supplier_risk_reviews_computed', '23514:supplier_risk_reviews_computed'],
  '0481/45: a final whose result is not the rules'' is refused, the rules'' own is taken, a final with no next date and a draft with a result are refused');
select is(
  (select array_agg(pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version,
          status, is_current, data_level, answers, starting_risk, evidence, residual_risk, hard_stops, computed_result,
          override_result, override_reason, reviewer_name, reviewed_at, next_review_on)
          values (%L, %L, 'X', 1, 'final', true, 'staff', %L, 'moderate', 'strong', 'low', '{}', 'approve',
                  %L, %L, 'X', now(), current_date + 30)$$,
          :'orgA', :'supA5', pg_temp.answers('staff'), t.r, t.why)) order by t.n)
     from (values (1, 'do_not_use', null), (2, null, 'A reason with no result.'), (3, 'approve', 'The same result as the rules.'),
                  (4, 'refuse', 'Not one of the four results.'), (5, 'do_not_use', 'short'),
                  (6, 'do_not_use', 'The vendor lost our trust last term.')) t(n, r, why)),
  array['23514:supplier_risk_reviews_override', '23514:supplier_risk_reviews_override', '23514:supplier_risk_reviews_override',
        '23514:supplier_risk_reviews_override', '23514:supplier_risk_reviews_override', 'ok'],
  '0481/46: an override needs another of the four results and a reason of 10 characters or more; both or neither');
select is(
  array[pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version,
          data_level, answers, reviewer_name, rules_version) values (%L, %L, 'X', 1, 'staff', '{}', 'X', 2)$$, :'orgA', :'supA5')),
        pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version,
          data_level, answers, reviewer_name, status) values (%L, %L, 'X', 1, 'staff', '{}', 'X', 'archived')$$, :'orgA', :'supA5')),
        pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version,
          data_level, answers, reviewer_name, is_current) values (%L, %L, 'X', 1, 'staff', '{}', 'X', true)$$, :'orgA', :'supA5')),
        pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version,
          data_level, answers, reviewer_name) values (%L, %L, 'X', 1, 'parents', '{}', 'X')$$, :'orgA', :'supA5')),
        pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version,
          data_level, answers, reviewer_name) values (%L, %L, '', 1, 'staff', '{}', 'X')$$, :'orgA', :'supA5')),
        pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version,
          data_level, answers, reviewer_name) values (%L, %L, 'X', 0, 'staff', '{}', 'X')$$, :'orgA', :'supA5')),
        pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version,
          data_level, answers, reviewer_name) values (%L, %L, 'X', 1, 'staff', '{}', 'X'), (%L, %L, 'X', 2, 'staff', '{}', 'X')$$,
          :'orgA', :'supA5', :'orgA', :'supA5')),
        pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version,
          data_level, answers, reviewer_name) values (%L, %L, 'X', 1, 'staff', '{}', 'X'), (%L, %L, 'X', 1, 'staff', '{}', 'X')$$,
          :'orgA', :'supA5', :'orgA', :'supA1'))],
  array['23514:supplier_risk_reviews_answers', '23514:supplier_risk_reviews_computed',
        '23514:supplier_risk_reviews_current_is_final', '23514:supplier_risk_reviews_answers',
        '23514:supplier_risk_reviews_supplier_name', '23514:supplier_risk_reviews_version',
        '23505:supplier_risk_reviews_one_draft', 'ok'],
  '0481/47: the table refuses another rules version, status, a current draft, another level, an empty name, version 0 and two drafts for one supplier (Postgres names the first failing check by name)');
select is(
  (select string_agg(c.conname || ' ' || pg_get_constraintdef(c.oid), ' | ' order by c.conname)
     from pg_constraint c
    where c.conrelid = 'public.supplier_risk_reviews'::regclass and c.contype = 'c'
      and c.conname in ('supplier_risk_reviews_status', 'supplier_risk_reviews_data_level', 'supplier_risk_reviews_rules_version',
                        'supplier_risk_reviews_current_is_final')),
  'supplier_risk_reviews_current_is_final CHECK (((NOT is_current) OR (status = ''final''::text)))'
  || ' | supplier_risk_reviews_data_level CHECK ((data_level = ANY (ARRAY[''none''::text, ''staff''::text, ''student''::text])))'
  || ' | supplier_risk_reviews_rules_version CHECK ((rules_version = 1))'
  || ' | supplier_risk_reviews_status CHECK ((status = ANY (ARRAY[''draft''::text, ''final''::text])))',
  '0481/48: the status, level and rules version checks stand on their own too (the answers check runs first by name)');

-- ── 5. Who may ──────────────────────────────────────────────────────────────
-- One call of each of the eight admin functions, for organization A.
create temporary table vr_calls (n integer primary key, sql text) on commit drop;
insert into vr_calls values
  (1, format($$select count(*)::text from public.supplier_risk_register(%L)$$, :'orgA')),
  (2, format($$select count(*)::text from public.supplier_risk_history(%L, %L)$$, :'orgA', :'supA1')),
  (3, format($$select coalesce(public.supplier_risk_review(%L, %L)::text, 'none')$$, :'orgA', 'a0481000-0000-0000-0000-00000000dead')),
  (4, format($$select count(*)::text from public.supplier_risk_items_for_organization(%L, false)$$, :'orgA')),
  (5, format($$select public.supplier_risk_draft_save(%L, %L, 'staff', '{}')::text$$, :'orgA', :'supA2')),
  (6, format($$select public.supplier_risk_finalise(%L, %L, 'none', '{}')::text$$, :'orgA', :'supA2')),
  (7, format($$select public.supplier_risk_draft_discard(%L, %L)::text$$, :'orgA', :'supA2')),
  (8, format($$select public.supplier_risk_item_update(%L, %L, 'open', null, null, null)::text$$, :'orgA', 'a0481000-0000-0000-0000-00000000dead'));

select is(
  (select array_agg(pg_temp.as_user(u.id, c.sql) order by u.n, c.n)
     from vr_calls c,
          unnest(array[:'managerA', :'staffA', :'viewerA', :'adminB', :'disabledAdmin', :'invitedAdmin',
                       :'actasOld', :'outsider']::uuid[]) with ordinality u(id, n)),
  array_fill('ERR 42501 supplier_risk_not_allowed hint=supplier_risk_not_allowed'::text, array[64]),
  '0481/49: a manager, a staff member, a viewer, an admin of another organization, a disabled admin, an invitation not accepted, an expired act-as seat and an outsider are refused all eight');
select is(
  (select array_agg(pg_temp.run_as('authenticated', null, c.sql) order by c.n) from vr_calls c),
  array_fill('ERR 42501 supplier_risk_not_allowed hint=supplier_risk_not_allowed'::text, array[8]),
  '0481/50: a session with no account is refused all eight');
select is(
  (select array_agg(split_part(pg_temp.run_as('anon', null, c.sql), ' for function', 1) order by c.n) from vr_calls c),
  array_fill('ERR 42501 permission denied'::text, array[8]),
  '0481/51: anon may not call any of the eight (no EXECUTE)');
select is(
  (select array_agg(pg_temp.run_as('authenticated', null, format(t.sql, :'orgA')) order by t.n)
     from (values (1, $$select public.supplier_risk_register(null)::text$$),
                  (2, $$select public.supplier_risk_draft_save(null, null, null, null)::text$$)) t(n, sql)),
  array_fill('ERR 42501 supplier_risk_not_allowed hint=supplier_risk_not_allowed'::text, array[2]),
  '0481/52: no organization is refused as not allowed, before any other check');
select is(
  (select array_agg(pg_temp.as_user(u.id, c.sql) order by u.n, c.n)
     from vr_calls c,
          unnest(array[:'ownerA', :'adminA', :'actas']::uuid[]) with ordinality u(id, n)
    where c.n in (1, 2, 3, 4, 7)),
  array['12', '0', 'none', '0', 'false', '12', '0', 'none', '0', 'false', '12', '0', 'none', '0', 'false'],
  '0481/53: an owner, an admin and a live act-as seat of the organization may read (the register lists its 12 active suppliers) and discard');
-- Organization C asks its owners and admins for an authenticator (0472's
-- check): Admin C has none, Admin C Two has one.
select is(
  array[pg_temp.as_user(:'adminC', format($$select count(*)::text from public.supplier_risk_register(%L)$$, :'orgC')),
        pg_temp.as_user(:'adminC', format($$select public.supplier_risk_draft_save(%L, %L, 'none', '{}')::text$$, :'orgC', :'supC1')),
        pg_temp.as_user(:'adminC2', format($$select count(*)::text from public.supplier_risk_register(%L)$$, :'orgC'), 'aal1'),
        pg_temp.as_user(:'adminC2', format($$select (public.supplier_risk_draft_discard(%L, %L))::text$$, :'orgC', :'supC1'), 'aal1'),
        pg_temp.as_user(:'adminC2', format($$select count(*)::text from public.supplier_risk_register(%L)$$, :'orgC'), 'aal2')],
  array['ERR 42501 mfa_required hint=mfa_required', 'ERR 42501 mfa_required hint=mfa_required',
        'ERR 42501 aal2_required hint=aal2_required', 'ERR 42501 aal2_required hint=aal2_required', '1'],
  '0481/54: where the second step is owed, reads and writes are refused with mfa_required or aal2_required, and taken with it');

-- ── 6. Drafts, finishing, the register ──────────────────────────────────────
select is(
  (pg_temp.as_user(:'adminA', format($$select public.supplier_risk_draft_save(%L, %L, 'staff', '{"insurance": {"answer": "no", "note": "None on file."}}')::text$$,
     :'orgA', :'supA1'))::jsonb ->> 'version'),
  '1',
  '0481/55: an admin''s first draft for a supplier is version 1');
select is(
  (pg_temp.as_user(:'ownerA', format($$select public.supplier_risk_draft_save(%L, %L, 'staff', '{"insurance": {"answer": "yes"}}')::text$$,
     :'orgA', :'supA1'))::jsonb ->> 'version'),
  '1',
  '0481/56: a second save writes the same draft');
select is(
  (select array[count(*)::text, min(r.status), min(r.reviewer_id::text), min(r.reviewer_name), min(r.supplier_name),
                min(r.answers::text), bool_or(r.is_current)::text]
     from public.supplier_risk_reviews r where r.supplier_id = :'supA1'),
  array['1', 'draft', :'ownerA', 'Made-up Owner A', 'Example Paper Co', '{"insurance": {"answer": "yes"}}', 'false'],
  '0481/57: one draft row: the last writer is the reviewer, the supplier''s name is kept, a draft is never current');
select is(
  array[pg_temp.as_user(:'adminA', format($$select public.supplier_risk_draft_save(%L, %L, 'staff', '{}')::text$$, :'orgA', :'supB1')),
        pg_temp.as_user(:'adminB', format($$select public.supplier_risk_draft_save(%L, %L, 'staff', '{}')::text$$, :'orgB', :'supA1')),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_draft_save(%L, %L, 'staff', '{}')::text$$, :'orgA', 'a0481000-0000-0000-0000-00000000dead')),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_draft_save(%L, null, 'staff', '{}')::text$$, :'orgA')),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_draft_save(%L, %L, 'staff', '{}')::text$$, :'orgA', :'supA3')),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_draft_save(%L, %L, 'staff', '{"no_ai_training": {"answer": "yes"}}')::text$$, :'orgA', :'supA2')),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_draft_save(%L, %L, 'students', '{}')::text$$, :'orgA', :'supA2')),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_draft_save(%L, %L, 'staff', null)::text$$, :'orgA', :'supA2'))],
  array['ERR 22023 supplier_not_found hint=supplier_not_found', 'ERR 22023 supplier_not_found hint=supplier_not_found',
        'ERR 22023 supplier_not_found hint=supplier_not_found', 'ERR 22023 supplier_not_found hint=supplier_not_found',
        'ERR 22023 supplier_archived hint=supplier_archived', 'ERR 22023 answer_not_applicable hint=answer_not_applicable',
        'ERR 22023 bad_data_level hint=bad_data_level', 'ERR 22023 answers_not_an_object hint=answers_not_an_object'],
  '0481/58: a supplier of another organization (either way round), none, an archived one and wrong answers are refused, by their words');
select is(
  (select count(*)::int from public.supplier_risk_reviews r where r.supplier_id in (:'supB1', :'supA2', :'supA3')),
  0,
  '0481/59: and nothing was written for them');

select id as rev_a1_v1 from public.supplier_risk_reviews where supplier_id = :'supA1' and version = 1 \gset
select is(
  (select (x.j - 'review_id' - 'next_review_on')::text || ' | ' || (x.j ->> 'review_id' = :'rev_a1_v1')::text
          || ' | ' || ((x.j ->> 'next_review_on')::date = (pg_temp.today(:'orgA') + interval '12 months')::date)::text
     from (select pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb, null, null, null, %L::jsonb)::text$$,
             :'orgA', :'supA1', pg_temp.answers('staff', '{"insurance": "no", "hosting_known": "not_shown"}'),
             pg_temp.items('staff', '{"insurance": "no", "hosting_known": "not_shown"}', :'staffA', pg_temp.today(:'orgA') + 10)))::jsonb j) x),
  '{"items": 2, "result": "approve_with_conditions", "version": 1, "evidence": "adequate", "hard_stops": [], "residual_risk": "low", "starting_risk": "moderate", "computed_result": "approve_with_conditions", "override_result": null, "pending_hard_stops": [], "superseded_review_id": null} | true | true',
  '0481/60: finishing gives the rules'' answer, finishes the open draft in place, and sets the next review 12 months from the organization''s today');
select is(
  (select array[r.status, r.is_current::text, r.result, r.reviewer_name, (r.reviewed_at = now())::text,
                (select string_agg(i.question_key || ':' || i.answer || ':' || i.severity || ':' || i.status || ':'
                                   || i.owner_name || ':' || (i.due_on - pg_temp.today(:'orgA'))::text, ',' order by i.question_key)
                   from public.supplier_risk_items i where i.review_id = r.id)]
     from public.supplier_risk_reviews r where r.id = :'rev_a1_v1'),
  array['final', 'true', 'approve_with_conditions', 'Made-up Admin A', 'true',
        'hosting_known:not_shown:low:open:Made-up Staff A:10,insurance:no:low:open:Made-up Staff A:10'],
  '0481/61: the final is current, by its finisher, now; one item for each gap with the rules'' severity, the owner''s name and the due date');

-- Every refusal of a finish, each undone. Supplier A2 has no review.
create temporary table vr_finish (n integer primary key, args text, want text) on commit drop;
insert into vr_finish values
  (1, format('%L, %L, %L, %L::jsonb', :'orgA', :'supA2', 'staff', pg_temp.answers('staff', '{"insurance": "missing"}'))
      || ', null, null, null, ''[]''', 'answers_incomplete'),
  (2, format('%L, %L, %L, %L::jsonb, %L::date', :'orgA', :'supA2', 'staff', pg_temp.answers('staff'), pg_temp.today(:'orgA')), 'bad_next_review_on'),
  (3, format('%L, %L, %L, %L::jsonb, %L::date', :'orgA', :'supA2', 'staff', pg_temp.answers('staff'), pg_temp.today(:'orgA') - 1), 'bad_next_review_on'),
  (4, format('%L, %L, %L, %L::jsonb, %L::date', :'orgA', :'supA2', 'staff', pg_temp.answers('staff'),
             (pg_temp.today(:'orgA') + interval '3 years' + interval '1 day')::date), 'bad_next_review_on'),
  (5, format('%L, %L, %L, %L::jsonb, null, %L, %L', :'orgA', :'supA2', 'staff', pg_temp.answers('staff'), 'approve', 'The same as the rules give.'), 'bad_override'),
  (6, format('%L, %L, %L, %L::jsonb, null, %L, %L', :'orgA', :'supA2', 'staff', pg_temp.answers('staff'), 'reject', 'Not one of the four results.'), 'bad_override'),
  (7, format('%L, %L, %L, %L::jsonb, null, null, %L', :'orgA', :'supA2', 'staff', pg_temp.answers('staff'), 'A reason with no result given.'), 'bad_override'),
  (8, format('%L, %L, %L, %L::jsonb, null, %L, null', :'orgA', :'supA2', 'staff', pg_temp.answers('staff'), 'do_not_use'), 'bad_override_reason'),
  (9, format('%L, %L, %L, %L::jsonb, null, %L, %L', :'orgA', :'supA2', 'staff', pg_temp.answers('staff'), 'do_not_use', 'Too short'), 'bad_override_reason'),
  (10, format('%L, %L, %L, %L::jsonb, null, null, null, %L::jsonb', :'orgA', :'supA2', 'staff', pg_temp.answers('staff', '{"insurance": "no"}'), '{}'), 'items_not_an_array'),
  (11, format('%L, %L, %L, %L::jsonb, null, null, null, %L::jsonb', :'orgA', :'supA2', 'staff', pg_temp.answers('staff', '{"insurance": "no"}'), '[]'), 'items_do_not_match_answers'),
  (12, format('%L, %L, %L, %L::jsonb', :'orgA', :'supA2', 'staff', pg_temp.answers('staff', '{"insurance": "no"}')), 'items_do_not_match_answers'),
  (13, format('%L, %L, %L, %L::jsonb, null, null, null, %L::jsonb', :'orgA', :'supA2', 'staff', pg_temp.answers('staff', '{"insurance": "no", "hosting_known": "no"}'),
              '[{"question_key": "insurance", "finding": "F", "action": "A"}, {"question_key": "insurance", "finding": "F", "action": "A"}]'), 'items_do_not_match_answers'),
  (14, format('%L, %L, %L, %L::jsonb, null, null, null, %L::jsonb', :'orgA', :'supA2', 'staff', pg_temp.answers('staff', '{"insurance": "no"}'),
              '[{"question_key": "data_listed", "finding": "F", "action": "A"}]'), 'items_do_not_match_answers'),
  (15, format('%L, %L, %L, %L::jsonb, null, null, null, %L::jsonb', :'orgA', :'supA2', 'staff', pg_temp.answers('staff'),
              '[{"question_key": "insurance", "finding": "F", "action": "A"}]'), 'items_do_not_match_answers'),
  (16, format('%L, %L, %L, %L::jsonb, null, null, null, %L::jsonb', :'orgA', :'supA2', 'staff', pg_temp.answers('staff', '{"insurance": "no"}'),
              '[{"question_key": "insurance", "finding": "F", "action": "A", "severity": "low"}]'), 'bad_item'),
  (17, format('%L, %L, %L, %L::jsonb, null, null, null, %L::jsonb', :'orgA', :'supA2', 'staff', pg_temp.answers('staff', '{"insurance": "no"}'),
              '[{"question_key": "insurance", "finding": 5, "action": "A"}]'), 'bad_item'),
  (18, format('%L, %L, %L, %L::jsonb, null, null, null, %L::jsonb', :'orgA', :'supA2', 'staff', pg_temp.answers('staff', '{"insurance": "no"}'),
              '[{"question_key": "insurance", "finding": "F", "action": "A", "owner_user_id": "someone"}]'), 'bad_item'),
  (19, format('%L, %L, %L, %L::jsonb, null, null, null, %L::jsonb', :'orgA', :'supA2', 'staff', pg_temp.answers('staff', '{"insurance": "no"}'),
              '["insurance"]'), 'bad_item'),
  (20, format('%L, %L, %L, %L::jsonb, null, null, null, %L::jsonb', :'orgA', :'supA2', 'staff', pg_temp.answers('staff', '{"insurance": "no"}'),
              '[{"question_key": "insurance", "finding": "", "action": "A"}]'), 'bad_item_text'),
  (21, format('%L, %L, %L, %L::jsonb, null, null, null, %L::jsonb', :'orgA', :'supA2', 'staff', pg_temp.answers('staff', '{"insurance": "no"}'),
              jsonb_build_array(jsonb_build_object('question_key', 'insurance', 'finding', 'F', 'action', repeat('a', 1001)))), 'bad_item_text'),
  (22, format('%L, %L, %L, %L::jsonb, null, null, null, %L::jsonb', :'orgA', :'supA2', 'staff', pg_temp.answers('staff', '{"insurance": "no"}'),
              pg_temp.items('staff', '{"insurance": "no"}', :'staffB')), 'item_owner_not_a_member'),
  (23, format('%L, %L, %L, %L::jsonb, null, null, null, %L::jsonb', :'orgA', :'supA2', 'staff', pg_temp.answers('staff', '{"insurance": "no"}'),
              pg_temp.items('staff', '{"insurance": "no"}', :'invitedAdmin')), 'item_owner_not_a_member'),
  (24, format('%L, %L, %L, %L::jsonb, null, null, null, %L::jsonb', :'orgA', :'supA2', 'staff', pg_temp.answers('staff', '{"insurance": "no"}'),
              pg_temp.items('staff', '{"insurance": "no"}', :'actas')), 'item_owner_not_a_member'),
  (25, format('%L, %L, %L, %L::jsonb, null, null, null, %L::jsonb', :'orgA', :'supA2', 'staff', pg_temp.answers('staff', '{"insurance": "no"}'),
              pg_temp.items('staff', '{"insurance": "no"}', :'disabledAdmin')), 'item_owner_not_a_member'),
  (26, format('%L, %L, %L, %L::jsonb, null, null, null, %L::jsonb', :'orgA', :'supA2', 'staff', pg_temp.answers('staff', '{"insurance": "no"}'),
              pg_temp.items('staff', '{"insurance": "no"}', null, pg_temp.today(:'orgA') - 1)), 'bad_item_due_on'),
  (27, format('%L, %L, %L, %L::jsonb, null, null, null, %L::jsonb', :'orgA', :'supA2', 'staff', pg_temp.answers('staff', '{"insurance": "no"}'),
              pg_temp.items('staff', '{"insurance": "no"}', null, (pg_temp.today(:'orgA') + interval '3 years' + interval '1 day')::date)), 'bad_item_due_on'),
  (28, format('%L, %L, %L, %L::jsonb, null, null, null, %L::jsonb', :'orgA', :'supA2', 'staff', pg_temp.answers('staff', '{"insurance": "no"}'),
              '[{"question_key": "insurance", "finding": "F", "action": "A", "due_on": "2027-02-30"}]'), 'bad_item_due_on'),
  (29, format('%L, %L, %L, %L::jsonb', :'orgA', :'supA3', 'staff', pg_temp.answers('staff')), 'supplier_archived'),
  (30, format('%L, %L, %L, %L::jsonb', :'orgA', :'supB1', 'staff', pg_temp.answers('staff')), 'supplier_not_found');
select is(
  (select coalesce(string_agg(f.n || ': ' || x.got, ' ; ' order by f.n), '')
     from vr_finish f,
          lateral (select pg_temp.as_user(:'adminA', 'select public.supplier_risk_finalise(' || f.args || ')::text')) x(got)
    where x.got is distinct from 'ERR 22023 ' || f.want || ' hint=' || f.want),
  '',
  '0481/62: every wrong finish is refused by its word (30 cases: answers, next date, override, items, owners, due dates, supplier)');
select is(
  (select count(*)::int from public.supplier_risk_reviews r where r.supplier_id in (:'supA2', :'supA3', :'supB1')),
  0,
  '0481/63: and none of them wrote anything');

-- A second finish of A1: a new version, current; the first becomes history.
select is(
  (select array[x.j ->> 'version', (x.j ->> 'superseded_review_id' = :'rev_a1_v1')::text, x.j ->> 'computed_result',
                x.j ->> 'result', x.j ->> 'items', ((x.j ->> 'next_review_on')::date - pg_temp.today(:'orgA'))::text]
     from (select pg_temp.as_user(:'ownerA', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb, %L::date, 'do_not_use', 'The vendor changed owners; we stop for now.', '[]')::text$$,
             :'orgA', :'supA1', pg_temp.answers('staff'), pg_temp.today(:'orgA') + 100))::jsonb j) x),
  array['2', 'true', 'approve', 'do_not_use', '0', '100'],
  '0481/64: a second finish makes version 2, current, with the override in force and the next date asked for');
select id as rev_a1_v2 from public.supplier_risk_reviews where supplier_id = :'supA1' and version = 2 \gset
select is(
  (select string_agg(r.version || ':' || r.status || ':' || r.is_current || ':' || r.result || ':'
                     || coalesce(r.override_reason, '-') || ':'
                     || (select count(*) from public.supplier_risk_items i where i.review_id = r.id), ',' order by r.version)
     from public.supplier_risk_reviews r where r.supplier_id = :'supA1'),
  '1:final:false:approve_with_conditions:-:2,2:final:true:do_not_use:The vendor changed owners; we stop for now.:0',
  '0481/65: version 1 is kept as it was, with its items, and is no longer current; the override''s reason is kept');
-- A2 with student data and a hard stop: the default next review is 6 months.
select is(
  (select array[x.j ->> 'result', x.j ->> 'hard_stops', x.j ->> 'evidence',
                ((x.j ->> 'next_review_on')::date = (pg_temp.today(:'orgA') + interval '6 months')::date)::text]
     from (select pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'student', %L::jsonb, null, null, null, %L::jsonb)::text$$,
             :'orgA', :'supA2', pg_temp.answers('student', '{"data_agreement": "no"}'),
             pg_temp.items('student', '{"data_agreement": "no"}', :'managerA')))::jsonb j) x),
  array['do_not_use', '["student_data_no_agreement"]', 'weak', 'true'],
  '0481/66: student data with no signed data agreement is Do not use, and the next review is 6 months away');
select is(
  (select string_agg(i.question_key || ':' || i.severity, ',') from public.supplier_risk_items i
     join public.supplier_risk_reviews r on r.id = i.review_id where r.supplier_id = :'supA2'),
  'data_agreement:critical',
  '0481/67: its item is critical (the student-data severity)');
select is(
  (select count(*)::int from (select r.supplier_id from public.supplier_risk_reviews r
                               group by r.supplier_id
                              having count(*) filter (where r.status = 'final') > 0
                                 and count(*) filter (where r.is_current) <> 1) x),
  0,
  '0481/68: every supplier with a final review has exactly one current review');

-- A draft is discarded; a final never is.
select is(
  array[(pg_temp.as_user(:'adminA', format($$select public.supplier_risk_draft_save(%L, %L, 'staff', '{}')::text$$, :'orgA', :'supA1'))::jsonb ->> 'version'),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_draft_discard(%L, %L)::text$$, :'orgA', :'supA1')),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_draft_discard(%L, %L)::text$$, :'orgA', :'supA1')),
        pg_temp.as_user(:'adminB', format($$select public.supplier_risk_draft_discard(%L, %L)::text$$, :'orgB', :'supA2')),
        (select string_agg(r.version || r.status, ',' order by r.version) from public.supplier_risk_reviews r where r.supplier_id = :'supA1')],
  array['3', 'true', 'false', 'false', '1final,2final'],
  '0481/69: a new draft is version 3; discarding it answers true, then false; another organization discards nothing; both finals stay');

select is(
  pg_temp.as_user(:'adminA', format($$select string_agg(h.version || ':' || h.status || ':' || h.is_current || ':' || h.result || ':' || h.overridden, ',')
                                        from public.supplier_risk_history(%L, %L) h$$, :'orgA', :'supA1')),
  '2:final:true:do_not_use:true,1:final:false:approve_with_conditions:false',
  '0481/70: the history lists every version, newest first');
select is(
  array[pg_temp.as_user(:'adminB', format($$select count(*)::text from public.supplier_risk_history(%L, %L)$$, :'orgB', :'supA1')),
        pg_temp.as_user(:'adminB', format($$select coalesce(public.supplier_risk_review(%L, %L)::text, 'none')$$, :'orgB', :'rev_a1_v1'))],
  array['0', 'none'],
  '0481/71: another organization''s admin sees no version and no review of it');
select is(
  (select array[(x.j ->> 'status'), (x.j ->> 'is_current'), (x.j ->> 'supplier_state'), (x.j ->> 'supplier_name'),
                (select string_agg(e ->> 'question_key' || ':' || (e ->> 'owner_is_member'), ',') from jsonb_array_elements(x.j -> 'items') e),
                (select string_agg(k, ',' order by k) from jsonb_object_keys(x.j) k)]
     from (select pg_temp.as_user(:'adminA', format($$select public.supplier_risk_review(%L, %L)::text$$, :'orgA', :'rev_a1_v1'))::jsonb j) x),
  array['final', 'false', 'active', 'Example Paper Co', 'hosting_known:true,insurance:true',
        'answers,computed_result,created_at,data_level,evidence,hard_stops,id,is_current,items,next_review_on,organization_id,'
        'override_reason,override_result,reminded_30_at,reminded_due_at,residual_risk,result,reviewed_at,reviewer_id,'
        'reviewer_name,rules_version,starting_risk,status,supplier_id,supplier_name,supplier_state,updated_at,version'],
  '0481/72: one review, whole, with its items in question order');
select is(
  pg_temp.as_user(:'adminA', format($$select string_agg(x.supplier_name || ':' || x.question_key || ':' || x.severity, ',')
                                        from public.supplier_risk_items_for_organization(%L) x$$, :'orgA')),
  'Sample Learning Apps:data_agreement:critical',
  '0481/73: the open items are those of the current reviews only (version 1''s are history)');

-- The items' changes.
select i.id as item_a2 from public.supplier_risk_items i join public.supplier_risk_reviews r on r.id = i.review_id
 where r.supplier_id = :'supA2' and i.question_key = 'data_agreement' \gset
select i.id as item_a1_old from public.supplier_risk_items i where i.review_id = :'rev_a1_v1' and i.question_key = 'insurance' \gset
select is(
  (select array[x.j ->> 'status', (x.j ->> 'closed_at' is not null)::text, x.j ->> 'owner_name', x.j ->> 'action',
                (x.j ->> 'owner_is_member')]
     from (select pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'done', %L, null, 'Signed agreement received.')::text$$,
             :'orgA', :'item_a2', :'ownerA'))::jsonb j) x),
  array['done', 'true', 'Made-up Owner A', 'Signed agreement received.', 'true'],
  '0481/74: an item marked done is closed, with its new owner''s name and action');
select closed_at as item_a2_closed from public.supplier_risk_items where id = :'item_a2' \gset
select is(
  (select array[x.j ->> 'status', ((x.j ->> 'closed_at')::timestamptz = :'item_a2_closed'::timestamptz)::text, x.j ->> 'action']
     from (select pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'accepted', %L, null, null)::text$$,
             :'orgA', :'item_a2', :'ownerA'))::jsonb j) x),
  array['accepted', 'true', 'Signed agreement received.'],
  '0481/75: done to accepted keeps the closing time; a null action keeps the action');
select is(
  (select array[x.j ->> 'status', coalesce(x.j ->> 'closed_at', 'none'), coalesce(x.j ->> 'owner_name', 'none'),
                ((x.j ->> 'due_on')::date - pg_temp.today(:'orgA'))::text]
     from (select pg_temp.as_user(:'ownerA', format($$select public.supplier_risk_item_update(%L, %L, 'open', null, %L::date, null)::text$$,
             :'orgA', :'item_a2', pg_temp.today(:'orgA') + 7))::jsonb j) x),
  array['open', 'none', 'none', '7'],
  '0481/76: back to open clears the closing time; no owner, and a due date a week ahead');
select is(
  array[pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'closed', null, null, null)::text$$, :'orgA', :'item_a2')),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, null, null, null, null)::text$$, :'orgA', :'item_a2')),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'open', %L, null, null)::text$$, :'orgA', :'item_a2', :'staffB')),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'open', %L, null, null)::text$$, :'orgA', :'item_a2', :'actas')),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'open', null, %L::date, null)::text$$, :'orgA', :'item_a2', pg_temp.today(:'orgA') - 1)),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'open', null, null, '')::text$$, :'orgA', :'item_a2')),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'open', null, null, null)::text$$, :'orgA', :'item_a1_old')),
        pg_temp.as_user(:'adminB', format($$select public.supplier_risk_item_update(%L, %L, 'open', null, null, null)::text$$, :'orgB', :'item_a2')),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, null, 'open', null, null, null)::text$$, :'orgA'))],
  array['ERR 22023 bad_item_status hint=bad_item_status', 'ERR 22023 bad_item_status hint=bad_item_status',
        'ERR 22023 item_owner_not_a_member hint=item_owner_not_a_member', 'ERR 22023 item_owner_not_a_member hint=item_owner_not_a_member',
        'ERR 22023 bad_item_due_on hint=bad_item_due_on', 'ERR 22023 bad_item_text hint=bad_item_text',
        'ERR 22023 item_not_current hint=item_not_current', 'ERR 22023 item_not_found hint=item_not_found',
        'ERR 22023 item_not_found hint=item_not_found'],
  '0481/77: an item change is refused for a wrong status, an owner who is not a current member, a past due date, an empty action, an earlier version''s item and another organization''s');
-- The same owner stays after they stop being a member; a due date already
-- set stays even once it is past.
update public.supplier_risk_items set owner_user_id = :'managerA', owner_name = 'Made-up Manager A', due_on = current_date - 30
 where id = :'item_a2';
update public.organization_members set role = 'staff', accepted_at = null where organization_id = :'orgA' and user_id = :'managerA';
select is(
  (select array[x.j ->> 'status', x.j ->> 'owner_name', x.j ->> 'owner_is_member', ((x.j ->> 'due_on')::date = current_date - 30)::text]::text
     from (select pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'in_progress', %L, %L::date, null)::text$$,
             :'orgA', :'item_a2', :'managerA', current_date - 30))::jsonb j) x),
  '{in_progress,"Made-up Manager A",false,true}',
  '0481/78: an owner who left and a due date already past stay when only the status changes');
update public.organization_members set role = 'manager', accepted_at = now() where organization_id = :'orgA' and user_id = :'managerA';

-- Archived and deleted suppliers keep their reviews, marked.
select is(
  array[(pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'none', '{}')::text$$, :'orgA', :'supA4'))::jsonb ->> 'result'),
        (pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb)::text$$, :'orgA', :'supA5', pg_temp.answers('staff')))::jsonb ->> 'result')],
  array['approve', 'approve'],
  '0481/79: a supplier that holds no data of ours, and one with every answer Yes, are approved');
update public.suppliers set deleted_at = now() where id = :'supA4';
delete from public.suppliers where id = :'supA5';
select is(
  pg_temp.as_user(:'adminA', format($$select string_agg(g.supplier_name || ':' || g.supplier_state || ':' || coalesce(g.result, '-') || ':' || g.review_due
                                                        || ':' || g.open_items || ':' || coalesce(g.top_open_severity, '-'), ',')
                                        from public.supplier_risk_register(%L) g
                                       where g.supplier_id in (%L, %L, %L, %L, %L, %L)$$,
                                     :'orgA', :'supA1', :'supA2', :'supA3', :'supA4', :'supA5', :'supB1')),
  'Example Paper Co:active:do_not_use:scheduled:0:-,Placeholder Snacks:archived:approve:scheduled:0:-,'
  'Sample Learning Apps:active:do_not_use:scheduled:1:critical,Test Printing Ltd:deleted:approve:scheduled:0:-',
  '0481/80: the register keeps an archived and a deleted supplier''s reviews, marked (the deleted one by its last name), leaves out an archived supplier never reviewed and never lists another organization''s');
select is(
  array[pg_temp.as_user(:'adminA', format($$select public.supplier_risk_draft_save(%L, %L, 'none', '{}')::text$$, :'orgA', :'supA4')),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'none', '{}')::text$$, :'orgA', :'supA5')),
        pg_temp.as_user(:'adminA', format($$select count(*)::text from public.supplier_risk_history(%L, %L)$$, :'orgA', :'supA5')),
        (pg_temp.as_user(:'adminA', format($$select public.supplier_risk_review(%L, %L)::text$$, :'orgA',
           (select r.id from public.supplier_risk_reviews r where r.supplier_id = :'supA5')))::jsonb ->> 'supplier_state'),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_draft_discard(%L, %L)::text$$, :'orgA', :'supA4'))],
  array['ERR 22023 supplier_archived hint=supplier_archived', 'ERR 22023 supplier_not_found hint=supplier_not_found', '1', 'deleted', 'false'],
  '0481/81: no new review for an archived or a deleted supplier; the deleted one''s history and review are still read, marked deleted');
select is(
  (select count(*)::int from public.supplier_risk_reviews r where r.supplier_id in (:'supA4', :'supA5') and r.status = 'final'),
  2,
  '0481/82: neither review was touched by the archive or the delete');

-- ── 7. Kept as written ──────────────────────────────────────────────────────
select is(
  array[pg_temp.try(format($$update public.supplier_risk_reviews set answers = '{}' where id = %L$$, :'rev_a1_v1')),
        pg_temp.try(format($$update public.supplier_risk_reviews set status = 'draft', starting_risk = null, evidence = null, residual_risk = null,
                              hard_stops = null, computed_result = null, reviewed_at = null, next_review_on = null where id = %L$$, :'rev_a1_v1')),
        pg_temp.try(format($$update public.supplier_risk_reviews set is_current = true where id = %L$$, :'rev_a1_v1')),
        pg_temp.try(format($$update public.supplier_risk_reviews set next_review_on = next_review_on + 1 where id = %L$$, :'rev_a1_v2')),
        pg_temp.try(format($$update public.supplier_risk_reviews set override_reason = 'A different reason now.' where id = %L$$, :'rev_a1_v2')),
        pg_temp.try(format($$update public.supplier_risk_reviews set supplier_name = 'Renamed' where id = %L$$, :'rev_a1_v2')),
        pg_temp.try(format($$update public.supplier_risk_reviews set reviewer_id = %L where id = %L$$, :'staffA', :'rev_a1_v2')),
        pg_temp.try(format($$update public.supplier_risk_reviews set reviewer_id = null where id = %L$$, :'rev_a1_v2')),
        pg_temp.try(format($$update public.supplier_risk_reviews set is_current = false where id = %L$$, :'rev_a1_v2')),
        pg_temp.try(format($$update public.supplier_risk_reviews set reminded_due_at = now(), reminded_30_at = now(), updated_at = now() where id = %L$$, :'rev_a1_v2'))],
  array['55000:supplier_risk_final_is_kept', '55000:supplier_risk_final_is_kept', '55000:supplier_risk_final_is_kept',
        '55000:supplier_risk_final_is_kept', '55000:supplier_risk_final_is_kept', '55000:supplier_risk_final_is_kept',
        '55000:supplier_risk_final_is_kept', 'ok', 'ok', 'ok'],
  '0481/83: a final review cannot change what it says, go back to draft or become current again, even for the table''s owner; it may lose its reviewer link, its current mark and get its reminder stamps');
update public.supplier_risk_reviews set reminded_due_at = now() where id = :'rev_a1_v2';
select is(
  array[pg_temp.try(format($$update public.supplier_risk_reviews set reminded_due_at = now() + interval '1 hour' where id = %L$$, :'rev_a1_v2')),
        pg_temp.try(format($$update public.supplier_risk_reviews set reminded_due_at = null where id = %L$$, :'rev_a1_v2'))],
  array['55000:supplier_risk_final_is_kept', '55000:supplier_risk_final_is_kept'],
  '0481/84: a reminder stamp is set once and never moved or cleared');
update public.supplier_risk_reviews set reminded_due_at = null where id = :'rev_a1_v1' and false;
select is(
  array[pg_temp.try(format($$update public.supplier_risk_items set finding = 'Rewritten' where id = %L$$, :'item_a2')),
        pg_temp.try(format($$update public.supplier_risk_items set severity = 'low' where id = %L$$, :'item_a2')),
        pg_temp.try(format($$update public.supplier_risk_items set answer = 'no', question_key = 'insurance' where id = %L$$, :'item_a2')),
        pg_temp.try(format($$update public.supplier_risk_items set review_id = %L where id = %L$$, :'rev_a1_v2', :'item_a2')),
        pg_temp.try(format($$update public.supplier_risk_items set status = 'done', closed_at = now(), action = 'Other words.' where id = %L$$, :'item_a2')),
        pg_temp.try(format($$update public.supplier_risk_items set status = 'done' where id = %L$$, :'item_a2')),
        pg_temp.try(format($$insert into public.supplier_risk_items (organization_id, review_id, question_key, answer, severity, finding, action)
                              values (%L, %L, 'insurance', 'no', 'low', 'F', 'A')$$, :'orgB', :'rev_a1_v2')),
        pg_temp.try(format($$insert into public.supplier_risk_items (organization_id, review_id, question_key, answer, severity, finding, action)
                              values (%L, %L, 'no_such_question', 'no', 'low', 'F', 'A')$$, :'orgA', :'rev_a1_v2')),
        pg_temp.try(format($$insert into public.supplier_risk_items (organization_id, review_id, question_key, answer, severity, finding, action)
                              values (%L, %L, 'insurance', 'yes', 'low', 'F', 'A')$$, :'orgA', :'rev_a1_v2'))],
  array['55000:supplier_risk_final_is_kept', '55000:supplier_risk_final_is_kept', '55000:supplier_risk_final_is_kept',
        '55000:supplier_risk_final_is_kept', 'ok', '23514:supplier_risk_items_closed', '23503:supplier_risk_items_review_fkey',
        '23514:supplier_risk_items_question_key', '23514:supplier_risk_items_answer'],
  '0481/85: an item''s finding, severity, question, answer and review never change; an item of another organization''s review, of no question or for a Yes is refused');

-- ── 8. An account deleted; an organization deleted ──────────────────────────
insert into public.suppliers (id, organization_id, name) values ('a0481000-0000-0000-0000-0000000000fb', :'orgA', 'Leaver Review Co');
select is(
  (pg_temp.as_user(:'leaver', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb, null, null, null, %L::jsonb)::text$$,
     :'orgA', 'a0481000-0000-0000-0000-0000000000fb', pg_temp.answers('staff', '{"insurance": "no"}'),
     pg_temp.items('staff', '{"insurance": "no"}', :'leaver')))::jsonb ->> 'items'),
  '1',
  '0481/86: an admin who will leave finishes a review and owns its item');
delete from auth.users where id = :'leaver';
select is(
  (select array[coalesce(r.reviewer_id::text, 'none'), r.reviewer_name, coalesce(i.owner_user_id::text, 'none'), i.owner_name, i.status]
     from public.supplier_risk_reviews r join public.supplier_risk_items i on i.review_id = r.id
    where r.supplier_id = 'a0481000-0000-0000-0000-0000000000fb'),
  array['none', 'Made-up Leaver', 'none', 'Made-up Leaver', 'open'],
  '0481/87: when the account is deleted the review and the item keep the name and lose the link');
select is(
  pg_temp.as_user(:'adminA', format($$select g.reviewer_name || ':' || g.reviewer_account_deleted from public.supplier_risk_register(%L) g where g.supplier_id = %L$$,
    :'orgA', 'a0481000-0000-0000-0000-0000000000fb')),
  'Made-up Leaver:true',
  '0481/88: the register says the reviewer''s account was deleted');
select is(
  (pg_temp.as_user(:'ownerD', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb, null, null, null, %L::jsonb)::text$$,
     :'orgD', :'supD1', pg_temp.answers('staff', '{"insurance": "no"}'), pg_temp.items('staff', '{"insurance": "no"}')))::jsonb ->> 'items'),
  '1',
  '0481/89: organization D has a review with an item');
delete from public.organizations where id = :'orgD';
select is(
  (select count(*)::int from public.supplier_risk_reviews where organization_id = :'orgD')
  + (select count(*)::int from public.supplier_risk_items where organization_id = :'orgD'),
  0,
  '0481/90: deleting an organization deletes its reviews and items');

-- ── 9. The reminders ────────────────────────────────────────────────────────
select pg_temp.final_row('a0481000-0000-0000-0000-000000000101', :'orgA', :'supR1', 1, true, pg_temp.today(:'orgA'), now() - interval '1 year');
select pg_temp.final_row('a0481000-0000-0000-0000-000000000102', :'orgA', :'supR2', 1, true, pg_temp.today(:'orgA') - 5, now() - interval '1 year');
select pg_temp.final_row('a0481000-0000-0000-0000-000000000103', :'orgA', :'supR3', 1, true, pg_temp.today(:'orgA') + 30, now() - interval '1 year');
select pg_temp.final_row('a0481000-0000-0000-0000-000000000104', :'orgA', :'supR4', 1, true, pg_temp.today(:'orgA') + 31, now() - interval '1 year');
select pg_temp.final_row('a0481000-0000-0000-0000-000000000105', :'orgA', :'supR5', 1, true, pg_temp.today(:'orgA') + 10, now() - interval '5 days');
select pg_temp.final_row('a0481000-0000-0000-0000-000000000106', :'orgA', :'supR6', 1, true, pg_temp.today(:'orgA'), now() - interval '1 year', now() - interval '30 days', now() - interval '1 hour');
select pg_temp.final_row('a0481000-0000-0000-0000-000000000107', :'orgA', :'supR7', 1, true, pg_temp.today(:'orgA'), now() - interval '1 year');
select pg_temp.final_row('a0481000-0000-0000-0000-000000000108', :'orgA', :'supR8', 1, false, pg_temp.today(:'orgA'), now() - interval '2 years');
select pg_temp.final_row('a0481000-0000-0000-0000-000000000109', :'orgA', :'supR8', 2, true, pg_temp.today(:'orgA') + 200, now() - interval '1 year');
select pg_temp.final_row('a0481000-0000-0000-0000-00000000010a', :'orgZ', :'supZ1', 1, true, pg_temp.today(:'orgZ'), now() - interval '1 year');
select pg_temp.final_row('a0481000-0000-0000-0000-00000000010b', :'orgY', :'supY1', 1, true, pg_temp.today(:'orgY') + 40, now() - interval '1 year');
update public.suppliers set deleted_at = now() where id = :'supR7';
insert into public.supplier_risk_items (organization_id, review_id, question_key, answer, severity, finding, action, owner_user_id, owner_name, status, closed_at)
values (:'orgA', 'a0481000-0000-0000-0000-000000000101', 'insurance', 'no', 'low', 'F', 'A', :'staffA', 'Made-up Staff A', 'open', null),
       (:'orgA', 'a0481000-0000-0000-0000-000000000101', 'hosting_known', 'no', 'low', 'F', 'A', :'staffB', 'Made-up Staff B', 'open', null),
       (:'orgA', 'a0481000-0000-0000-0000-000000000101', 'data_listed', 'no', 'low', 'F', 'A', :'managerA', 'Made-up Manager A', 'done', now());

select is(
  array[public._supplier_risk_org_zone(:'orgA'), public._supplier_risk_org_zone(:'orgZ'), public._supplier_risk_org_zone(:'orgY'),
        public._supplier_risk_org_zone(:'orgC'), coalesce(public._supplier_risk_org_zone('a0481000-0000-0000-0000-00000000dead'), 'null')],
  array['America/Los_Angeles', 'Pacific/Kiritimati', 'America/Los_Angeles', 'UTC', 'America/Los_Angeles'],
  '0481/91: an organization''s zone is its own when the server knows it, else America/Los_Angeles (a zone abbreviation, no organization)');
select is(
  pg_temp.run_as('service_role', null, $$select string_agg(d.supplier_name || ':' || d.kind, ',' order by d.supplier_name) from public.supplier_risk_reminders_due(100) d$$),
  'Island Time Supplies:due,Reminder Due Today:due,Reminder In Thirty:due_soon,Reminder Overdue:due',
  '0481/92: due today or past, and due in 30 days for a review made before the window: not 31 days, not one made inside the window, not one already reminded, not an archived supplier, not an earlier version, not a draft');
select is(
  pg_temp.run_as('service_role', null, format($$select string_agg(d.supplier_name || ':' || (d.org_today = %L::date)::text || ':' || (d.next_review_on - d.org_today), ',' order by d.supplier_name)
                                                  from public.supplier_risk_reminders_due(100) d where d.organization_id in (%L, %L)$$,
                                              pg_temp.today(:'orgA'), :'orgA', :'orgZ')),
  'Island Time Supplies:' || (pg_temp.today(:'orgZ') = pg_temp.today(:'orgA'))::text || ':0,Reminder Due Today:true:0,Reminder In Thirty:true:30,Reminder Overdue:true:-5',
  '0481/93: each organization''s today is in its own zone (Pacific/Kiritimati for Z)');
select is(
  pg_temp.run_as('service_role', null, $$select string_agg(to_char(d.next_review_on, 'YYYY-MM-DD'), ',') from public.supplier_risk_reminders_due(2) d$$),
  to_char(pg_temp.today(:'orgA') - 5, 'YYYY-MM-DD') || ',' || to_char(least(pg_temp.today(:'orgA'), pg_temp.today(:'orgZ')), 'YYYY-MM-DD'),
  '0481/94: soonest first, at most the limit');
select is(
  pg_temp.run_as('service_role', null, format($$select d.admin_user_ids::text || ' ' || d.item_owner_user_ids::text from public.supplier_risk_reminders_due(100) d where d.supplier_id = %L$$, :'supR1')),
  '{' || :'ownerA' || ',' || :'adminA' || '} {' || :'staffA' || '}',
  '0481/95: the recipients: current owners and admins (not a disabled admin, an invitation, an act-as seat), and owners of open items who are current members');
select is(
  array[pg_temp.run_as('service_role', null, $$select public.supplier_risk_reminder_claim('a0481000-0000-0000-0000-000000000101', 'due')::text$$),
        pg_temp.run_as('service_role', null, $$select public.supplier_risk_reminder_claim('a0481000-0000-0000-0000-000000000101', 'due')::text$$),
        pg_temp.run_as('service_role', null, $$select public.supplier_risk_reminder_claim('a0481000-0000-0000-0000-000000000103', 'due')::text$$),
        pg_temp.run_as('service_role', null, $$select public.supplier_risk_reminder_claim('a0481000-0000-0000-0000-000000000103', 'due_soon')::text$$),
        pg_temp.run_as('service_role', null, $$select public.supplier_risk_reminder_claim('a0481000-0000-0000-0000-000000000103', 'due_soon')::text$$),
        pg_temp.run_as('service_role', null, $$select public.supplier_risk_reminder_claim('a0481000-0000-0000-0000-000000000104', 'due_soon')::text$$),
        pg_temp.run_as('service_role', null, $$select public.supplier_risk_reminder_claim('a0481000-0000-0000-0000-000000000105', 'due_soon')::text$$),
        pg_temp.run_as('service_role', null, $$select public.supplier_risk_reminder_claim('a0481000-0000-0000-0000-000000000106', 'due')::text$$),
        pg_temp.run_as('service_role', null, $$select public.supplier_risk_reminder_claim('a0481000-0000-0000-0000-000000000107', 'due')::text$$),
        pg_temp.run_as('service_role', null, $$select public.supplier_risk_reminder_claim('a0481000-0000-0000-0000-000000000108', 'due')::text$$)],
  array['true', 'false', 'false', 'true', 'false', 'false', 'false', 'false', 'false', 'false'],
  '0481/96: a claim stamps once (a second claim, as an overlapping run makes, is false), and never for a review not due, already reminded, of an archived supplier or not current');
select is(
  array[pg_temp.run_as('service_role', null, $$select public.supplier_risk_reminder_claim(null, 'due')::text$$),
        pg_temp.run_as('service_role', null, $$select public.supplier_risk_reminder_claim('a0481000-0000-0000-0000-000000000102', null)::text$$),
        pg_temp.run_as('service_role', null, $$select public.supplier_risk_reminder_claim('a0481000-0000-0000-0000-000000000102', 'soon')::text$$),
        pg_temp.run_as('service_role', null, $$select public.supplier_risk_reminder_claim('a0481000-0000-0000-0000-00000000dead', 'due')::text$$)],
  array['false', 'false', 'false', 'false'],
  '0481/97: no review, no kind, an unknown kind and an unknown review are false, never an error');
select is(
  array[(select (reminded_due_at = now())::text || ':' || coalesce(reminded_30_at::text, 'none') from public.supplier_risk_reviews where id = 'a0481000-0000-0000-0000-000000000101'),
        (select coalesce(reminded_due_at::text, 'none') || ':' || (reminded_30_at = now())::text from public.supplier_risk_reviews where id = 'a0481000-0000-0000-0000-000000000103'),
        pg_temp.run_as('service_role', null, $$select string_agg(d.supplier_name || ':' || d.kind, ',' order by d.supplier_name) from public.supplier_risk_reminders_due(100) d$$)],
  array['true:none', 'none:true', 'Island Time Supplies:due,Reminder Overdue:due'],
  '0481/98: the claimed reminders are stamped and leave the list');
select is(
  array[split_part(pg_temp.as_user(:'adminA', $$select count(*)::text from public.supplier_risk_reminders_due(100)$$), ' for function', 1),
        split_part(pg_temp.as_user(:'adminA', $$select public.supplier_risk_reminder_claim('a0481000-0000-0000-0000-000000000102', 'due')::text$$), ' for function', 1),
        split_part(pg_temp.run_as('anon', null, $$select public.supplier_risk_reminder_claim('a0481000-0000-0000-0000-000000000102', 'due')::text$$), ' for function', 1)],
  array['ERR 42501 permission denied', 'ERR 42501 permission denied', 'ERR 42501 permission denied'],
  '0481/99: a member and anon may not call the job''s functions');
-- The second lock: even with EXECUTE granted (inside a block that is undone),
-- a signed-in member is refused by the body.
create function pg_temp.granted_as(p_sub uuid, p_sql text) returns text language plpgsql as $f$
declare
  v text;
begin
  begin
    grant execute on function public.supplier_risk_reminders_due(integer) to authenticated;
    grant execute on function public.supplier_risk_reminder_claim(uuid, text) to authenticated;
    v := pg_temp.run_as('authenticated', p_sub, p_sql);
    raise exception 'pg_temp.granted_as: undone';
  exception when others then
    if sqlerrm <> 'pg_temp.granted_as: undone' then
      raise;
    end if;
  end;
  return v;
end $f$;
select is(
  array[pg_temp.granted_as(:'adminA', $$select count(*)::text from public.supplier_risk_reminders_due(100)$$),
        pg_temp.granted_as(:'adminA', $$select public.supplier_risk_reminder_claim('a0481000-0000-0000-0000-000000000102', 'due')::text$$),
        pg_temp.grants_of('public.supplier_risk_reminder_claim(uuid, text)'),
        (select coalesce(reminded_due_at::text, 'none') from public.supplier_risk_reviews where id = 'a0481000-0000-0000-0000-000000000102')],
  array['ERR 42501 supplier_risk_not_allowed hint=supplier_risk_not_allowed', 'ERR 42501 supplier_risk_not_allowed hint=supplier_risk_not_allowed',
        'service_role:EXECUTE', 'none'],
  '0481/100: with EXECUTE granted, a signed-in member is still refused by the job functions'' own second lock, and nothing is stamped');
select is(
  (select count(*)::int from pg_proc p
    where p.oid = 'public.supplier_risk_reminder_claim(uuid, text)'::regprocedure
      and p.prosrc ~ 'reminded_due_at = pg_catalog\.now\(\)\s+where r\.id = p_review_id\s+and r\.is_current\s+and r\.reminded_due_at is null'
      and p.prosrc ~ 'reminded_30_at = pg_catalog\.now\(\)\s+where r\.id = p_review_id\s+and r\.is_current\s+and r\.reminded_30_at is null'
      and 'lock_timeout=2s' = any (p.proconfig)),
  1,
  '0481/101: the claim is one guarded update (the stamp must still be empty when the row lock is had), with a 2 s lock wait');

-- ── 10. Holes the red checks found ──────────────────────────────────────────
-- Each test below fails for a mutant of the migration that the tests above
-- let through (red-checks/RED-CHECKS.md in the notes names them).
\set orgW 'a0481000-0000-0000-0000-0000000000a7'
\set ownerW 'a0481000-0000-0000-0000-0000000000d4'
\set supH1 'a0481000-0000-0000-0000-000000000201'
\set supH2 'a0481000-0000-0000-0000-000000000202'
\set supH3 'a0481000-0000-0000-0000-000000000203'
\set supH4 'a0481000-0000-0000-0000-000000000204'
\set supZ2 'a0481000-0000-0000-0000-000000000211'
\set supZ3 'a0481000-0000-0000-0000-000000000212'
\set supW1 'a0481000-0000-0000-0000-000000000221'
\set supW3 'a0481000-0000-0000-0000-000000000223'
\set revH1 'a0481000-0000-0000-0000-000000000231'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'ownerW', 'vr-owner-w@test.local', '{"full_name": "Made-up Owner W"}'::jsonb);
-- Organization W is twelve hours behind UTC, Z fourteen ahead: at any hour
-- one of them is on another day than UTC, so a function that reads UTC's
-- today instead of the organization's fails one of the tests below.
insert into public.organizations (id, name, slug, mfa_policy, timezone) values
  (:'orgW', 'Vendor Risk Org W', 'a0481000-org-w', 'optional', 'Etc/GMT+12');
insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at) values
  (:'orgW', :'ownerW', 'owner', now(), null);
insert into public.suppliers (id, organization_id, name, deleted_at) values
  (:'supH1', :'orgA', 'Holes Table Co',        null),
  (:'supH2', :'orgA', 'Holes Closing Co',      null),
  (:'supH3', :'orgA', 'Holes Draft Co',        null),
  (:'supH4', :'orgA', 'Holes Before Rename Co', null),
  (:'supZ2', :'orgZ', 'Island Due Co',         null),
  (:'supZ3', :'orgZ', 'Island Finish Co',      null),
  (:'supW1', :'orgW', 'Western Soon Co',       null),
  (:'supW3', :'orgW', 'Western Finish Co',     null);
-- The next review date a finish answers, or the refusal's word.
create function pg_temp.next_or_err(p text) returns text language sql as $f$
  select case when p like 'ERR %' then split_part(p, ' hint=', 1) else p::jsonb ->> 'next_review_on' end
$f$;

select is(
  array[public._supplier_risk_text_ok(repeat(chr(233), 20), 1, 20), public._supplier_risk_text_ok(repeat(chr(233), 21), 1, 20),
        public._supplier_risk_text_ok(repeat(chr(66560), 20), 1, 20)],
  array[true, false, true],
  '0481/102: the text rule counts characters, not bytes (a two-byte letter, and a four-byte one outside the basic plane)');

select pg_temp.final_row(:'revH1', :'orgA', :'supH1', 1, true, current_date + 30, now() - interval '1 year');
select is(
  array[pg_temp.try(format($$select pg_temp.final_row(gen_random_uuid(), %L, %L, 1, false, current_date + 30, now())$$, :'orgA', :'supH1')),
        pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version,
          data_level, answers, reviewer_name) values (%L, %L, repeat('n', 301), 2, 'staff', '{}', 'X')$$, :'orgA', :'supH1')),
        pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version,
          data_level, answers, reviewer_name) values (%L, %L, repeat('n', 300), 2, 'staff', '{}', repeat('r', 201))$$, :'orgA', :'supH1')),
        pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version,
          data_level, answers, reviewer_name) values (%L, %L, repeat('n', 300), 2, 'staff', '{}', repeat('r', 200))$$, :'orgA', :'supH1'))],
  array['23505:supplier_risk_reviews_version_key', '23514:supplier_risk_reviews_supplier_name',
        '23514:supplier_risk_reviews_reviewer_name', 'ok'],
  '0481/103: the reviews table refuses a version twice for one supplier, a supplier name over 300 characters and a reviewer name over 200');
select is(
  array[pg_temp.try(format($$insert into public.supplier_risk_items (organization_id, review_id, question_key, answer, severity, finding, action)
          values (%L, %L, 'hosting_known', 'no', 'low', 'F', 'A'), (%L, %L, 'hosting_known', 'not_shown', 'low', 'F', 'A')$$,
          :'orgA', :'revH1', :'orgA', :'revH1')),
        pg_temp.try(format($$insert into public.supplier_risk_items (organization_id, review_id, question_key, answer, severity, finding, action,
          owner_user_id) values (%L, %L, 'hosting_known', 'no', 'low', 'F', 'A', %L)$$, :'orgA', :'revH1', :'adminA')),
        pg_temp.try(format($$insert into public.supplier_risk_items (organization_id, review_id, question_key, answer, severity, finding, action)
          values (%L, %L, 'hosting_known', 'no', 'low', repeat('f', 501), 'A')$$, :'orgA', :'revH1')),
        pg_temp.try(format($$insert into public.supplier_risk_items (organization_id, review_id, question_key, answer, severity, finding, action)
          values (%L, %L, 'hosting_known', 'no', 'low', 'F', repeat('a', 1001))$$, :'orgA', :'revH1')),
        pg_temp.try(format($$insert into public.supplier_risk_items (organization_id, review_id, question_key, answer, severity, finding, action,
          status) values (%L, %L, 'hosting_known', 'no', 'low', 'F', 'A', 'closed')$$, :'orgA', :'revH1')),
        pg_temp.try(format($$insert into public.supplier_risk_items (organization_id, review_id, question_key, answer, severity, finding, action,
          owner_user_id, owner_name) values (%L, %L, 'hosting_known', 'no', 'low', repeat('f', 500), repeat('a', 1000), %L, 'Made-up Admin A')$$,
          :'orgA', :'revH1', :'adminA'))],
  array['23505:supplier_risk_items_one_per_question', '23514:supplier_risk_items_owner_named', '23514:supplier_risk_items_finding',
        '23514:supplier_risk_items_action', '23514:supplier_risk_items_status', 'ok'],
  '0481/104: the items table refuses a second item for one question, an owner with no name, a finding over 500 characters, an action over 1000 and a fifth status');
update public.supplier_risk_reviews set reminded_30_at = now() where id = :'revH1';
select is(
  array[pg_temp.try(format($$update public.supplier_risk_reviews set reminded_30_at = now() + interval '1 hour' where id = %L$$, :'revH1')),
        pg_temp.try(format($$update public.supplier_risk_reviews set reminded_30_at = null where id = %L$$, :'revH1'))],
  array['55000:supplier_risk_final_is_kept', '55000:supplier_risk_final_is_kept'],
  '0481/105: the 30-day stamp too is set once and never moved or cleared');

select pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb, null, null, null, %L::jsonb)::text$$,
  :'orgA', :'supH2', pg_temp.answers('staff', '{"insurance": "no"}'), pg_temp.items('staff', '{"insurance": "no"}'))) as fin_h2 \gset
select i.id as item_h2 from public.supplier_risk_items i join public.supplier_risk_reviews r on r.id = i.review_id
 where r.supplier_id = :'supH2' and r.is_current \gset
update public.supplier_risk_items set status = 'done', closed_at = now() - interval '1 day' where id = :'item_h2';
select is(
  (select (x.j ->> 'status') || ':' || ((x.j ->> 'closed_at')::timestamptz = now() - interval '1 day')::text
     from (select pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'accepted', null, null, null)::text$$,
                                                    :'orgA', :'item_h2'))::jsonb as j) x),
  'accepted:true',
  '0481/106: an item closed and closed again (done, then accepted) keeps the time it was first closed');

select pg_temp.as_user(:'adminA', format($$select public.supplier_risk_draft_save(%L, %L, 'staff', '{}')::text$$, :'orgA', :'supH3')) as draft_h3 \gset
select is(
  pg_temp.as_user(:'adminB', format($$select public.supplier_risk_draft_discard(%L, %L)::text$$, :'orgB', :'supH3')),
  'false',
  '0481/107: an admin of B, in B, cannot discard the draft of A''s supplier (there is none in B)');
select is(
  (select count(*)::int from public.supplier_risk_reviews where supplier_id = :'supH3' and status = 'draft'),
  1,
  '0481/108: and A''s draft is still there');
select is(
  pg_temp.as_user(:'adminB', format($$select count(*)::text from public.supplier_risk_items_for_organization(%L, false) i where i.supplier_id = any (%L::uuid[])$$,
    :'orgB', (select array_agg(s.id) from public.suppliers s where s.organization_id = :'orgA'))),
  '0',
  '0481/109: the items list of B has none of A''s items (A has items on its current reviews)');

select pg_temp.as_user(:'adminA', format($$select public.supplier_risk_draft_save(%L, %L, 'staff', '{}')::text$$, :'orgA', :'supH4')) as draft_h4 \gset
update public.suppliers set name = 'Holes Renamed Co' where id = :'supH4';
select pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb)::text$$,
  :'orgA', :'supH4', pg_temp.answers('staff'))) as fin_h4 \gset
select is(
  (select string_agg(r.version || ':' || r.status || ':' || r.supplier_name, ',') from public.supplier_risk_reviews r where r.supplier_id = :'supH4'),
  '1:final:Holes Renamed Co',
  '0481/110: a draft finished after its supplier was renamed becomes the final under the new name');

select is(
  array[pg_temp.next_or_err(pg_temp.as_user(:'ownerZ', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb, %L::date)::text$$,
          :'orgZ', :'supZ3', pg_temp.answers('staff'), pg_temp.today(:'orgZ')))),
        pg_temp.next_or_err(pg_temp.as_user(:'ownerZ', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb, %L::date)::text$$,
          :'orgZ', :'supZ3', pg_temp.answers('staff'), pg_temp.today(:'orgZ') + 1))),
        pg_temp.next_or_err(pg_temp.as_user(:'ownerW', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb, %L::date)::text$$,
          :'orgW', :'supW3', pg_temp.answers('staff'), pg_temp.today(:'orgW')))),
        pg_temp.next_or_err(pg_temp.as_user(:'ownerW', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb, %L::date)::text$$,
          :'orgW', :'supW3', pg_temp.answers('staff'), pg_temp.today(:'orgW') + 1)))],
  array['ERR 22023 bad_next_review_on', (pg_temp.today(:'orgZ') + 1)::text, 'ERR 22023 bad_next_review_on', (pg_temp.today(:'orgW') + 1)::text],
  '0481/111: the next review must be after the organization''s own today (Z fourteen hours ahead of UTC, W twelve behind)');

select pg_temp.final_row('a0481000-0000-0000-0000-000000000241', :'orgZ', :'supZ2', 1, true, pg_temp.today(:'orgZ'), now() - interval '1 year');
select pg_temp.final_row('a0481000-0000-0000-0000-000000000242', :'orgW', :'supW1', 1, true, pg_temp.today(:'orgW') + 1, now() - interval '1 year');
select is(
  pg_temp.run_as('service_role', null, format($$select string_agg(d.supplier_name || ':' || d.kind || ':'
      || (d.org_today = case d.organization_id when %L::uuid then %L::date else %L::date end)::text, ',' order by d.supplier_name)
     from public.supplier_risk_reminders_due(500) d where d.supplier_id in (%L, %L)$$,
    :'orgZ', pg_temp.today(:'orgZ'), pg_temp.today(:'orgW'), :'supZ2', :'supW1')),
  'Island Due Co:due:true,Western Soon Co:due_soon:true',
  '0481/112: the reminder read takes each organization''s own today: due on Z''s today, due soon on the day after W''s');
select is(
  array[pg_temp.as_user(:'ownerZ', format($$select g.review_due from public.supplier_risk_register(%L) g where g.supplier_id = %L$$, :'orgZ', :'supZ2')),
        pg_temp.as_user(:'ownerW', format($$select g.review_due from public.supplier_risk_register(%L) g where g.supplier_id = %L$$, :'orgW', :'supW1'))],
  array['due_today', 'due_soon'],
  '0481/113: the register takes the organization''s own today too');
select is(
  array[pg_temp.run_as('service_role', null, $$select public.supplier_risk_reminder_claim('a0481000-0000-0000-0000-000000000242', 'due')::text$$),
        pg_temp.run_as('service_role', null, $$select public.supplier_risk_reminder_claim('a0481000-0000-0000-0000-000000000241', 'due')::text$$),
        pg_temp.run_as('service_role', null, $$select public.supplier_risk_reminder_claim('a0481000-0000-0000-0000-000000000242', 'due_soon')::text$$)],
  array['false', 'true', 'true'],
  '0481/114: and so does the claim: not yet due the day before W''s date, due on Z''s');
select is(
  (select string_agg(p.proname || ':' || (strpos(p.prosrc, 'pg_advisory_xact_lock(4810001, pg_catalog.hashtext(') > 0
            and strpos(p.prosrc, 'pg_advisory_xact_lock(4810001')
                < coalesce(nullif(strpos(p.prosrc, 'for update'), 0), nullif(strpos(p.prosrc, 'from public.suppliers s'), 0),
                           nullif(strpos(p.prosrc, 'delete from'), 0)))::text, ',' order by p.proname)
     from pg_proc p
    where p.oid in ('public.supplier_risk_draft_save(uuid, uuid, text, jsonb)'::regprocedure,
                    'public.supplier_risk_finalise(uuid, uuid, text, jsonb, date, text, text, jsonb)'::regprocedure,
                    'public.supplier_risk_draft_discard(uuid, uuid)'::regprocedure,
                    'public.supplier_risk_item_update(uuid, uuid, text, uuid, date, text)'::regprocedure)),
  'supplier_risk_draft_discard:true,supplier_risk_draft_save:true,supplier_risk_finalise:true,supplier_risk_item_update:true',
  '0481/115: each of the four writes takes the supplier''s lock before it reads the supplier or the item for writing (the two-session proof is the race script)');

select * from finish();
rollback;
