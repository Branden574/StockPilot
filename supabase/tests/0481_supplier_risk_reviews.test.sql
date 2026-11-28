-- supabase/tests/0481_supplier_risk_reviews.test.sql
-- Proves migration 0481: public.supplier_risk_reviews and
-- public.supplier_risk_items, the admins' eight functions, the daily job's three
-- and the private helpers.
--
-- WHAT IS WORTH PINNING
--   1. Shape: the designed columns, the foreign keys (organizations cascade,
--      the four person links SET NULL, the items to their review in the same
--      organization; none to suppliers), the unique keys "one per supplier of
--      an organization" (the organization first in each), the two triggers,
--      RLS on and no policy, nothing DEFERRABLE.
--   2. Privileges, for anon, authenticated and service_role on every object:
--      no table privilege for any of them and none to PUBLIC; the eight admin
--      functions EXECUTE to authenticated only, the three job functions to
--      service_role only, the eighteen helpers to nobody; SECURITY DEFINER
--      exactly for the eleven; search_path pinned on all; reads STABLE; the
--      security invariants' INV-25 finds every authenticated function gated.
--   3. The question list (the core list's twin) and the rules: the case table
--      between the VENDOR RISK CASES markers, run here against the database's
--      rules and in vendor-risk.parity.test.ts against core's, both judged on
--      the review day the block names (every hard stop, every boundary, Not
--      shown never a pass, a dated Yes out of date); the default next review
--      dates between the VENDOR RISK DATES markers, the same way.
--   4. The answers check: each refusal by its word (the answer-problem table
--      between the VENDOR RISK ANSWER PROBLEMS markers, run here and in
--      vendor-risk.parity.test.ts), through the function and through the
--      table's CHECK on a write by the table's owner; a result that is not
--      the rules' is refused by the CHECK.
--   5. Who: an owner and an admin may; a live act-as seat may read and never
--      write; a manager, a staff
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
--  11. More holes, in the reads, the reminders and names: due soon is 30
--      days, not 31; only open items counted; closed items left out unless
--      asked for; an act-as seat is not a current owner in either read; a
--      due date before none; a deleted supplier's newest name; the current
--      review, never the draft; a page of at most 500; no claim of an
--      unknown kind; the email when there is no full name; a final's
--      status alone refused by the guard.
--  12. The review of e70d270a5 (REVIEW-0481.md in the notes): M1 one supplier
--      id in two organizations, both ways; M2 a deleted owner's name kept
--      through a status change; S1 the name as reviewed and whether it
--      changed; S2 who changed an item last and who accepted a risk, and why;
--      S4 an item's owner an owner or admin; S6 a support seat reads and never
--      writes; Q4 the thresholds and the dates beside the answers; Q7 the due
--      reminder's second chance and its confirmation.
--  13. The review of ccbf4d094 (round 2): R2-S1 no stored text holds a hidden
--      character (one list, checked at every code point that holds one), a
--      reason counts what can be seen (spaces collapsed, 20 and 5 different),
--      the names the functions copy are plain text, and an account deletion
--      succeeds for rows holding texts at the edges of the rules; R2-S2 a Yes
--      on the security report or the insurance needs its date, never one
--      later than tomorrow in UTC (the dated cases table, run by core too).
--
-- Every vendor, person and organization below is made up. Namespace
-- a0481000. Wrapped in begin/rollback: nothing leaks. Run via `supabase test
-- db` after `supabase db reset`.

begin;

select plan(170);

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
-- A function's json answer, or {"err": <the refusal>} when it refused: a refusal where an answer is
-- expected fails its own test instead of stopping the file at the cast.
create function pg_temp.j(p text) returns jsonb language sql as $f$
  select case when p like 'ERR %' then jsonb_build_object('err', p) else p::jsonb end
$f$;

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
-- overrides ({key: no | not_shown | yes | missing}, any of the first three
-- with "@YYYY-MM-DD" for the date beside it, or a bare "@" for none; missing
-- leaves it out). A Yes to a question whose date is judged (the security
-- report, insurance) given without "@" has the date p_dated_on beside it, as
-- a finished review needs (by default today in UTC; null: none).
create function pg_temp.answers(p_level text, p_over jsonb default '{}', p_dated_on date default current_date)
returns jsonb language sql as $f$
  select coalesce(jsonb_object_agg(k.key, jsonb_build_object('answer', split_part(k.a, '@', 1))
                                          || case when k.a like '%@_%' then jsonb_build_object('date', split_part(k.a, '@', 2))
                                                  when k.a = 'yes' and k.judged and p_dated_on is not null
                                                    then jsonb_build_object('date', p_dated_on::text)
                                                  else '{}'::jsonb end), '{}'::jsonb)
    from (select q.key, coalesce(p_over ->> q.key, 'yes') as a, q.date_max_months is not null as judged
            from public._supplier_risk_questions() q
           where p_level <> 'none' and (not q.student_only or p_level = 'student')
          union all
          select o.key, o.value #>> '{}',
                 coalesce((select q.date_max_months is not null from public._supplier_risk_questions() q where q.key = o.key), false)
            from jsonb_each(p_over) o
           where not exists (select 1 from public._supplier_risk_questions() q
                              where q.key = o.key and p_level <> 'none'
                                and (not q.student_only or p_level = 'student'))) k
   where k.a <> 'missing';
$f$;

-- The items for a finish: one for each gap, with made-up words. A gap: No
-- or Not shown, or (given the review day) a dated Yes more than its months
-- before it.
create function pg_temp.items(p_level text, p_over jsonb default '{}', p_owner uuid default null, p_due date default null,
                              p_review_on date default null)
returns jsonb language sql as $f$
  select coalesce(jsonb_agg(jsonb_build_object('question_key', q.key, 'finding', 'Finding about ' || q.key,
                                               'action', 'Action for ' || q.key, 'owner_user_id', p_owner,
                                               'due_on', p_due) order by q.ord), '[]'::jsonb)
    from public._supplier_risk_questions() q
   where p_level <> 'none' and (not q.student_only or p_level = 'student')
     and (split_part(coalesce(p_over ->> q.key, 'yes'), '@', 1) in ('no', 'not_shown')
          or (split_part(coalesce(p_over ->> q.key, 'yes'), '@', 1) = 'yes' and q.date_max_months is not null
              and p_review_on is not null
              and case when split_part(coalesce(p_over ->> q.key, ''), '@', 2) <> ''
                       then split_part(p_over ->> q.key, '@', 2)::date end
                  < (p_review_on - make_interval(months => q.date_max_months))::date));
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
     reviewed_at, reviewed_on, next_review_on, reminded_30_at, reminded_due_at)
  select p_id, p_org, p_supplier, 'Reminder fixture', p_version, 'final', p_current, 'staff', a.ans,
         e ->> 'starting_risk', e ->> 'evidence', e ->> 'residual_risk',
         array(select jsonb_array_elements_text(e -> 'hard_stops')), e ->> 'result',
         null, 'Made-up Reviewer', p_reviewed, a.day, p_next, p_r30, p_rdue
    from (select d.day, pg_temp.answers('staff', '{"insurance": "no"}', d.day) as ans
            from (select (p_reviewed at time zone public._supplier_risk_org_zone(p_org))::date as day) d) a,
         lateral public._supplier_risk_evaluate(1::smallint, 'staff', a.ans, a.day) e;
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
        'reviewed_at', 'reviewed_on', 'next_review_on', 'reminded_30_at', 'reminded_due_at', 'reminded_due_retry_at',
        'reminded_due_sent_at', 'created_at', 'updated_at'],
  '0481/3: the reviews have exactly the designed columns');
select is(
  (select array_agg(a.attname::text order by a.attnum) from pg_attribute a
    where a.attrelid = 'public.supplier_risk_items'::regclass and a.attnum > 0 and not a.attisdropped),
  array['id', 'organization_id', 'review_id', 'question_key', 'answer', 'severity', 'finding', 'action',
        'owner_user_id', 'owner_name', 'due_on', 'status', 'closed_at', 'changed_by', 'changed_by_name', 'changed_at',
        'accepted_by', 'accepted_by_name', 'accepted_reason', 'created_at', 'updated_at'],
  '0481/4: the items have exactly the designed columns');
select is(
  (select string_agg(c.conrelid::regclass::text || '.' || c.conname || '>' || c.confrelid::regclass::text
                     || ':' || c.confdeltype::text || ':' || c.condeferrable::text, ',' order by c.conrelid::regclass::text, c.conname)
     from pg_constraint c
    where c.contype = 'f' and c.conrelid in ('public.supplier_risk_reviews'::regclass, 'public.supplier_risk_items'::regclass)),
  'supplier_risk_items.supplier_risk_items_accepted_by_fkey>user_profiles:n:false,'
  'supplier_risk_items.supplier_risk_items_changed_by_fkey>user_profiles:n:false,'
  'supplier_risk_items.supplier_risk_items_owner_user_id_fkey>user_profiles:n:false,'
  'supplier_risk_items.supplier_risk_items_review_fkey>supplier_risk_reviews:c:false,'
  'supplier_risk_reviews.supplier_risk_reviews_organization_id_fkey>organizations:c:false,'
  'supplier_risk_reviews.supplier_risk_reviews_reviewer_id_fkey>user_profiles:n:false',
  '0481/5: the foreign keys are exactly: the organization (cascade), the four person links (SET NULL) and the item''s review (cascade); none to suppliers, none deferrable');
select is(
  (select array_agg(a.attname::text order by k.n)
     from pg_constraint c, unnest(c.conkey) with ordinality k(attnum, n)
     join pg_attribute a on a.attnum = k.attnum
    where c.conname = 'supplier_risk_items_review_fkey' and a.attrelid = c.conrelid),
  array['organization_id', 'review_id'],
  '0481/6: an item''s review key includes the organization, so an item cannot point at another organization''s review');
select is(
  (select string_agg(i.relname || ':' || x.indisunique::text || ':'
                     || (select string_agg(a.attname::text, ',' order by k.n)
                           from unnest(x.indkey::int2[]) with ordinality k(attnum, n)
                           join pg_attribute a on a.attrelid = x.indrelid and a.attnum = k.attnum)
                     || ':' || coalesce(pg_get_expr(x.indpred, x.indrelid), '-'), ' | ' order by i.relname)
     from pg_index x join pg_class i on i.oid = x.indexrelid
    where x.indrelid = 'public.supplier_risk_reviews'::regclass
      and i.relname in ('supplier_risk_reviews_one_current', 'supplier_risk_reviews_one_draft', 'supplier_risk_reviews_version_key')),
  'supplier_risk_reviews_one_current:true:organization_id,supplier_id:is_current'
  || ' | supplier_risk_reviews_one_draft:true:organization_id,supplier_id:(status = ''draft''::text)'
  || ' | supplier_risk_reviews_version_key:true:organization_id,supplier_id,version:-',
  '0481/7: one current review and one draft per supplier of an organization, and each version once, by unique keys that start with the organization (a supplier id is never taken alone)');
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
  ('public.supplier_risk_item_update(uuid, uuid, text, uuid, date, text, text)', 'admin_write'),
  ('public.supplier_risk_reminders_due(integer)', 'job_read'),
  ('public.supplier_risk_reminder_claim(uuid, text)', 'job_write'),
  ('public.supplier_risk_due_reminder_sent(uuid)', 'job_write'),
  ('public._supplier_risk_questions()', 'private'),
  ('public._supplier_risk_question_key_ok(text)', 'private'),
  ('public._supplier_risk_hidden_chars()', 'private'),
  ('public._supplier_risk_space_chars()', 'private'),
  ('public._supplier_risk_text_ok(text, integer, integer)', 'private'),
  ('public._supplier_risk_reason_ok(text)', 'private'),
  ('public._supplier_risk_plain_name(text, integer)', 'private'),
  ('public._supplier_risk_answers_problem(smallint, text, jsonb, boolean, date)', 'private'),
  ('public._supplier_risk_evaluate(smallint, text, jsonb, date)', 'private'),
  ('public._supplier_risk_computed_ok(smallint, text, jsonb, date, text, text, text, text[], text)', 'private'),
  ('public._supplier_risk_default_next_review(text, date)', 'private'),
  ('public._supplier_risk_org_zone(uuid)', 'private'),
  ('public._supplier_risk_reviews_guard()', 'private'),
  ('public._supplier_risk_items_guard()', 'private'),
  ('public._supplier_risk_item_json(public.supplier_risk_items)', 'private'),
  ('public._supplier_risk_person_name(uuid)', 'private'),
  ('public._supplier_risk_is_current_admin(uuid, uuid)', 'private'),
  ('public._supplier_risk_caller_is_act_as(uuid)', 'private');

select is(
  (select array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text) from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and (p.proname like 'supplier\_risk\_%' or p.proname like '\_supplier\_risk\_%')),
  (select array_agg(f.fn::text order by f.fn::text) from vr_fns f),
  '0481/19: the file makes exactly these twenty-nine functions');
select is(
  (select string_agg(f.fn::text || '=' || pg_temp.grants_of(f.fn), ' ; ' order by f.fn::text)
     from vr_fns f where pg_temp.grants_of(f.fn) <> case f.kind when 'admin_read' then 'authenticated:EXECUTE'
                                                                when 'admin_write' then 'authenticated:EXECUTE'
                                                                when 'job_read' then 'service_role:EXECUTE'
                                                                when 'job_write' then 'service_role:EXECUTE'
                                                                else '' end),
  null,
  '0481/20: the eight admin functions have exactly one grant, EXECUTE to authenticated; the three job functions exactly EXECUTE to service_role; the eighteen helpers none (nothing to PUBLIC)');
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
  '0481/22: every one of the twenty-nine, for each of anon, authenticated and service_role, has exactly the EXECUTE its kind says');
select is(
  (select string_agg(p.proname, ',' order by p.proname) from pg_proc p join vr_fns f on f.fn = p.oid where p.prosecdef),
  'supplier_risk_draft_discard,supplier_risk_draft_save,supplier_risk_due_reminder_sent,supplier_risk_finalise,supplier_risk_history,'
  'supplier_risk_item_update,supplier_risk_items_for_organization,supplier_risk_register,supplier_risk_reminder_claim,'
  'supplier_risk_reminders_due,supplier_risk_review',
  '0481/23: exactly the eleven functions an API role may call are SECURITY DEFINER; every helper runs as its caller');
select is(
  (select count(*)::int from pg_proc p join vr_fns f on f.fn = p.oid
    where not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c = 'search_path=""')),
  0,
  '0481/24: every function pins an empty search_path');
select is(
  (select string_agg(p.proname || ':' || p.provolatile::text, ',' order by p.proname) from pg_proc p join vr_fns f on f.fn = p.oid
    where f.kind not like 'private'),
  'supplier_risk_draft_discard:v,supplier_risk_draft_save:v,supplier_risk_due_reminder_sent:v,supplier_risk_finalise:v,supplier_risk_history:s,'
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
  || ' | ' || (select string_agg(q.key || coalesce(':' || q.date_max_months, ''), ',' order by q.ord)
                 from public._supplier_risk_questions() q where q.has_date),
  'data_agreement>student_data_no_agreement,breach_notice>student_data_no_breach_notice,'
  'direct_control>student_data_no_direct_control,purpose_only>student_data_no_purpose_limit,'
  'no_redisclosure>student_data_redisclosure,no_sale_or_ads>student_data_sale_or_ads,no_ai_training>student_data_ai_training'
  ' | data_agreement,breach_notice,security_report | data_agreement,security_report:12,insurance:12',
  '0481/32: the seven hard stops (the three school-official conditions among them), the three key papers, the three questions that take a date and the two whose date is judged (12 months)');
select is(
  (select count(*)::int from public._supplier_risk_questions() q
    where q.severity_student is null or (q.student_only = (q.severity_staff is not null))
       or (q.hard_stop is not null and q.severity_student <> 'critical')),
  0,
  '0481/33: every question has a severity for student data, one for staff exactly when it is asked for staff, and a hard stop is critical');

-- The case table: vendor-risk.parity.test.ts reads these same rows and runs
-- core's rules on them, judged on the review day the block names. answers:
-- the overrides on "every asked question Yes" ("@YYYY-MM-DD" adds the date
-- beside the answer; missing: left unanswered, it counts as Not shown).
-- hard_stops and out_of_date in question order.
create temporary table vr_cases (n integer primary key, level text, answers jsonb, starting_risk text,
  evidence text, residual_risk text, hard_stops text, out_of_date text, result text) on commit drop;
-- VENDOR RISK CASES BEGIN
-- reviewed on 2026-06-30
insert into vr_cases (n, level, answers, starting_risk, evidence, residual_risk, hard_stops, out_of_date, result) values
  (1, 'none', '{}', 'low', 'not_needed', 'low', '', '', 'approve'),
  (2, 'staff', '{}', 'moderate', 'strong', 'low', '', '', 'approve'),
  (3, 'staff', '{"insurance": "no"}', 'moderate', 'adequate', 'low', '', '', 'approve_with_conditions'),
  (4, 'staff', '{"insurance": "not_shown"}', 'moderate', 'adequate', 'low', '', '', 'approve_with_conditions'),
  (5, 'staff', '{"insurance": "no", "hosting_known": "not_shown"}', 'moderate', 'adequate', 'low', '', '', 'approve_with_conditions'),
  (6, 'staff', '{"insurance": "no", "hosting_known": "not_shown", "data_listed": "no"}', 'moderate', 'weak', 'moderate', '', '', 'approve_with_conditions'),
  (7, 'staff', '{"data_agreement": "no"}', 'moderate', 'weak', 'moderate', '', '', 'approve_with_conditions'),
  (8, 'staff', '{"breach_notice": "no"}', 'moderate', 'weak', 'moderate', '', '', 'approve_with_conditions'),
  (9, 'staff', '{"security_report": "no"}', 'moderate', 'weak', 'moderate', '', '', 'approve_with_conditions'),
  (10, 'staff', '{"data_agreement": "not_shown"}', 'moderate', 'insufficient', 'moderate', '', '', 'more_information'),
  (11, 'staff', '{"breach_notice": "not_shown"}', 'moderate', 'insufficient', 'moderate', '', '', 'more_information'),
  (12, 'staff', '{"security_report": "not_shown"}', 'moderate', 'insufficient', 'moderate', '', '', 'more_information'),
  (13, 'staff', '{"data_listed": "not_shown", "data_we_send": "not_shown", "hosting_known": "not_shown", "return_or_delete": "not_shown"}', 'moderate', 'weak', 'moderate', '', '', 'more_information'),
  (14, 'staff', '{"data_listed": "not_shown", "data_we_send": "not_shown", "hosting_known": "not_shown", "return_or_delete": "not_shown", "subvendors_named": "not_shown"}', 'moderate', 'insufficient', 'moderate', '', '', 'more_information'),
  (15, 'staff', '{"data_listed": "no", "data_we_send": "no", "hosting_known": "no", "data_agreement": "no", "breach_notice": "no", "return_or_delete": "no", "subvendors_named": "no", "security_report": "no", "insurance": "no"}', 'moderate', 'weak', 'moderate', '', '', 'more_information'),
  (16, 'staff', '{"data_listed": "missing"}', 'moderate', 'adequate', 'low', '', '', 'approve_with_conditions'),
  (17, 'staff', '{"security_report": "no", "insurance": "no"}', 'moderate', 'weak', 'moderate', '', '', 'approve_with_conditions'),
  (18, 'staff', '{"direct_control": "no", "no_sale_or_ads": "no"}', 'moderate', 'strong', 'low', '', '', 'approve'),
  (19, 'student', '{}', 'high', 'strong', 'low', '', '', 'approve'),
  (20, 'student', '{"insurance": "no"}', 'high', 'adequate', 'moderate', '', '', 'approve_with_conditions'),
  (21, 'student', '{"insurance": "no", "data_listed": "not_shown"}', 'high', 'adequate', 'moderate', '', '', 'approve_with_conditions'),
  (22, 'student', '{"insurance": "no", "data_listed": "not_shown", "direct_control": "no"}', 'high', 'weak', 'high', 'student_data_no_direct_control', '', 'do_not_use'),
  (23, 'student', '{"direct_control": "no", "purpose_only": "no"}', 'high', 'adequate', 'high', 'student_data_no_direct_control,student_data_no_purpose_limit', '', 'do_not_use'),
  (24, 'student', '{"data_agreement": "no"}', 'high', 'weak', 'high', 'student_data_no_agreement', '', 'do_not_use'),
  (25, 'student', '{"breach_notice": "no"}', 'high', 'weak', 'high', 'student_data_no_breach_notice', '', 'do_not_use'),
  (26, 'student', '{"no_sale_or_ads": "no"}', 'high', 'adequate', 'high', 'student_data_sale_or_ads', '', 'do_not_use'),
  (27, 'student', '{"no_ai_training": "no"}', 'high', 'adequate', 'high', 'student_data_ai_training', '', 'do_not_use'),
  (28, 'student', '{"no_sale_or_ads": "not_shown"}', 'high', 'adequate', 'moderate', '', '', 'more_information'),
  (29, 'student', '{"no_ai_training": "not_shown"}', 'high', 'adequate', 'moderate', '', '', 'more_information'),
  (30, 'student', '{"data_agreement": "not_shown"}', 'high', 'insufficient', 'high', '', '', 'more_information'),
  (31, 'student', '{"breach_notice": "not_shown"}', 'high', 'insufficient', 'high', '', '', 'more_information'),
  (32, 'student', '{"data_agreement": "no", "no_sale_or_ads": "not_shown"}', 'high', 'weak', 'high', 'student_data_no_agreement', '', 'do_not_use'),
  (33, 'student', '{"no_ai_training": "no", "data_agreement": "no", "no_sale_or_ads": "no", "breach_notice": "no"}', 'high', 'weak', 'high', 'student_data_no_agreement,student_data_no_breach_notice,student_data_sale_or_ads,student_data_ai_training', '', 'do_not_use'),
  (34, 'student', '{"data_listed": "not_shown", "data_we_send": "not_shown", "hosting_known": "not_shown", "return_or_delete": "not_shown", "subvendors_named": "not_shown", "insurance": "not_shown", "direct_control": "not_shown"}', 'high', 'weak', 'high', '', '', 'more_information'),
  (35, 'student', '{"data_listed": "not_shown", "data_we_send": "not_shown", "hosting_known": "not_shown", "return_or_delete": "not_shown", "subvendors_named": "not_shown", "insurance": "not_shown", "direct_control": "not_shown", "purpose_only": "not_shown"}', 'high', 'insufficient', 'high', '', '', 'more_information'),
  (36, 'student', '{"security_report": "no"}', 'high', 'weak', 'high', '', '', 'approve_with_conditions'),
  (37, 'student', '{"security_report": "not_shown"}', 'high', 'insufficient', 'high', '', '', 'more_information'),
  (38, 'student', '{"no_ai_training": "missing"}', 'high', 'adequate', 'moderate', '', '', 'more_information'),
  (39, 'student', '{"no_sale_or_ads": "no", "insurance": "not_shown", "hosting_known": "not_shown"}', 'high', 'weak', 'high', 'student_data_sale_or_ads', '', 'do_not_use'),
  (40, 'none', '{"insurance": "no"}', 'low', 'not_needed', 'low', '', '', 'approve'),
  (41, 'student', '{"no_redisclosure": "no"}', 'high', 'adequate', 'high', 'student_data_redisclosure', '', 'do_not_use'),
  (42, 'student', '{"direct_control": "not_shown"}', 'high', 'adequate', 'moderate', '', '', 'more_information'),
  (43, 'student', '{"purpose_only": "not_shown"}', 'high', 'adequate', 'moderate', '', '', 'more_information'),
  (44, 'student', '{"no_redisclosure": "not_shown"}', 'high', 'adequate', 'moderate', '', '', 'more_information'),
  (45, 'staff', '{"data_listed": "no", "data_we_send": "no", "hosting_known": "no", "insurance": "no"}', 'moderate', 'weak', 'moderate', '', '', 'more_information'),
  (46, 'student', '{"data_listed": "no", "data_we_send": "no", "hosting_known": "no", "insurance": "no"}', 'high', 'weak', 'high', '', '', 'more_information'),
  (47, 'student', '{"data_listed": "no", "data_we_send": "no", "insurance": "no"}', 'high', 'weak', 'high', '', '', 'approve_with_conditions'),
  (48, 'student', '{"data_listed": "no", "data_we_send": "no", "insurance": "no", "purpose_only": "no"}', 'high', 'weak', 'high', 'student_data_no_purpose_limit', '', 'do_not_use'),
  (49, 'staff', '{"security_report": "yes@2025-06-29"}', 'moderate', 'insufficient', 'moderate', '', 'security_report', 'more_information'),
  (50, 'staff', '{"security_report": "yes@2025-06-30"}', 'moderate', 'strong', 'low', '', '', 'approve'),
  (51, 'staff', '{"insurance": "yes@2025-06-29"}', 'moderate', 'adequate', 'low', '', 'insurance', 'approve_with_conditions'),
  (52, 'staff', '{"insurance": "yes@2025-06-30"}', 'moderate', 'strong', 'low', '', '', 'approve'),
  (53, 'staff', '{"data_agreement": "yes@2001-01-01"}', 'moderate', 'strong', 'low', '', '', 'approve'),
  (54, 'staff', '{"insurance": "no@2001-01-01"}', 'moderate', 'adequate', 'low', '', '', 'approve_with_conditions'),
  (55, 'student', '{"security_report": "yes@2024-02-29", "insurance": "yes@2025-01-15"}', 'high', 'insufficient', 'high', '', 'security_report,insurance', 'more_information'),
  (56, 'staff', '{"insurance": "yes@2026-12-31"}', 'moderate', 'strong', 'low', '', '', 'approve'),
  (57, 'staff', '{"insurance": "not_shown@2020-01-01"}', 'moderate', 'adequate', 'low', '', '', 'approve_with_conditions'),
  (58, 'none', '{"security_report": "yes@2001-01-01"}', 'low', 'not_needed', 'low', '', '', 'approve');
-- VENDOR RISK CASES END

select is(
  (select string_agg(c.n || ': ' || coalesce(e::text, 'null'), ' ; ' order by c.n)
     from vr_cases c,
          lateral (select public._supplier_risk_evaluate(1::smallint, c.level, pg_temp.answers(c.level, c.answers, null), date '2026-06-30')
                          - 'pending_hard_stops' - 'gaps') x(e)
    where e is distinct from jsonb_build_object(
            'starting_risk', c.starting_risk, 'evidence', c.evidence, 'residual_risk', c.residual_risk,
            'hard_stops', to_jsonb(coalesce(string_to_array(nullif(c.hard_stops, ''), ','), '{}'::text[])),
            'out_of_date', to_jsonb(coalesce(string_to_array(nullif(c.out_of_date, ''), ','), '{}'::text[])),
            'result', c.result)),
  null,
  '0481/34: the database''s rules give every row of the case table (58 cases judged on 2026-06-30: every hard stop, every boundary, the dates)');
select is((select count(*)::int from vr_cases), 58, '0481/35: the case table has its 58 rows');
-- Not shown is never a pass: for every question asked at each level, one
-- Not shown among Yes answers is a gap, never Approve, never strong.
select is(
  (select coalesce(string_agg(l.level || '/' || q.key, ',' order by l.level, q.ord), '')
     from unnest(array['staff', 'student']) l(level)
     join public._supplier_risk_questions() q on (not q.student_only or l.level = 'student'),
          lateral (select public._supplier_risk_evaluate(1::smallint, l.level,
                     pg_temp.answers(l.level, jsonb_build_object(q.key, 'not_shown')), null)) x(e)
    where x.e ->> 'result' = 'approve' or x.e ->> 'evidence' = 'strong'),
  '',
  '0481/36: one Not shown on any asked question, at either level, is never Approve and never strong evidence');
select is(
  (select coalesce(string_agg(q.key || ':' || (x.e ->> 'pending_hard_stops'), ',' order by q.ord), '')
     from public._supplier_risk_questions() q,
          lateral (select public._supplier_risk_evaluate(1::smallint, 'student',
                     pg_temp.answers('student', jsonb_build_object(q.key, 'not_shown')), null)) x(e)
    where q.hard_stop is not null),
  'data_agreement:["student_data_no_agreement"],breach_notice:["student_data_no_breach_notice"],'
  'direct_control:["student_data_no_direct_control"],purpose_only:["student_data_no_purpose_limit"],'
  'no_redisclosure:["student_data_redisclosure"],'
  'no_sale_or_ads:["student_data_sale_or_ads"],no_ai_training:["student_data_ai_training"]',
  '0481/37: a hard-stop question Not shown is a hard stop not yet ruled out');
select is(
  array[public._supplier_risk_evaluate(2::smallint, 'staff', '{}', null),
        public._supplier_risk_evaluate(1::smallint, 'everyone', '{}', null),
        public._supplier_risk_evaluate(1::smallint, null, '{}', null)]::text,
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
  array[public._supplier_risk_answers_problem(1::smallint, 'staff', pg_temp.answers('staff'), true, current_date),
        public._supplier_risk_answers_problem(1::smallint, 'student', pg_temp.answers('student'), true, current_date),
        public._supplier_risk_answers_problem(1::smallint, 'none', '{}', true, current_date),
        public._supplier_risk_answers_problem(1::smallint, 'staff', '{}', false, current_date),
        public._supplier_risk_answers_problem(1::smallint, 'student',
          '{"data_agreement": {"answer": "yes", "note": "Signed by both sides.\nOn file.", "date": "2026-03-01"},'
          ' "insurance": {"answer": "not_shown", "note": null, "date": null}}', false, current_date)],
  array[null, null, null, null, null]::text[],
  '0481/40: complete answers at each level (a Yes on the security report and the insurance with its date), an empty draft, and notes and dates where they belong are taken');
-- The answer-problem table: vendor-risk.parity.test.ts reads these same rows
-- and runs core's vendorRiskAnswersProblem on them (null: taken), with today
-- in UTC as the row gives it (null: no date judged as in the future). Where
-- an object has two wrong keys, the shorter key is read first (jsonb's
-- order; core sorts the same way): rows 32, 35, 48 and 49.
create temporary table vr_problems (n integer primary key, level text, answers text, final boolean, today date, problem text) on commit drop;
-- VENDOR RISK ANSWER PROBLEMS BEGIN
insert into vr_problems (n, level, answers, final, today, problem) values
  (1, 'staff', null, false, null, 'answers_not_an_object'),
  (2, 'staff', '[]', false, null, 'answers_not_an_object'),
  (3, 'staff', '"yes"', false, null, 'answers_not_an_object'),
  (4, 'staff', '{"data_listd": {"answer": "yes"}}', false, null, 'answer_unknown_question'),
  (5, 'staff', '{"direct_control": {"answer": "yes"}}', false, null, 'answer_not_applicable'),
  (6, 'none', '{"insurance": {"answer": "yes"}}', false, null, 'answer_not_applicable'),
  (7, 'staff', '{"insurance": "yes"}', false, null, 'answer_bad_shape'),
  (8, 'staff', '{"insurance": {"answer": "yes", "source": "web"}}', false, null, 'answer_bad_shape'),
  (9, 'staff', '{"insurance": {"note": "no answer"}}', false, null, 'answer_bad_value'),
  (10, 'staff', '{"insurance": {"answer": "maybe"}}', false, null, 'answer_bad_value'),
  (11, 'staff', '{"insurance": {"answer": "YES"}}', false, null, 'answer_bad_value'),
  (12, 'staff', '{"insurance": {"answer": true}}', false, null, 'answer_bad_value'),
  (13, 'staff', '{"insurance": {"answer": "yes", "note": ""}}', false, null, 'answer_bad_note'),
  (14, 'staff', '{"insurance": {"answer": "yes", "note": "   "}}', false, null, 'answer_bad_note'),
  (15, 'staff', '{"insurance": {"answer": "yes", "note": 5}}', false, null, 'answer_bad_note'),
  (16, 'staff', '{"hosting_known": {"answer": "yes", "date": "2026-01-01"}}', false, null, 'answer_date_not_allowed'),
  (17, 'staff', '{"insurance": {"answer": "yes", "date": "2026-02-30"}}', false, null, 'answer_bad_date'),
  (18, 'staff', '{"insurance": {"answer": "yes", "date": "26-01-01"}}', false, null, 'answer_bad_date'),
  (19, 'staff', '{"insurance": {"answer": "yes", "date": "1999-12-31"}}', false, null, 'answer_bad_date'),
  (20, 'staff', '{"insurance": {"answer": "yes", "date": "2101-01-01"}}', false, null, 'answer_bad_date'),
  (21, 'staff', '{"insurance": {"answer": "yes", "date": 20260101}}', false, null, 'answer_bad_date'),
  (22, 'staff', '{"insurance": {"answer": "yes", "date": "2026-01-01"}}', true, null, 'answers_incomplete'),
  (23, 'everyone', '{}', false, null, 'bad_data_level'),
  (24, 'staff', '{}', false, null, null),
  (25, 'none', '{}', true, null, null),
  (26, 'student', '{"data_agreement": {"answer": "yes", "note": "Signed by both sides.\nOn file.", "date": "2026-03-01"}, "insurance": {"answer": "not_shown", "note": null, "date": null}}', false, null, null),
  (27, 'staff', '{"insurance": {"answer": "no", "date": "2000-01-01"}, "security_report": {"answer": "yes", "date": "2100-12-31"}}', false, null, null),
  (28, 'staff', '{"insurance": {"answer": "yes", "date": "2028-02-29"}}', false, null, null),
  (29, 'staff', '{"insurance": {"answer": "yes", "date": "2027-02-29"}}', false, null, 'answer_bad_date'),
  (30, 'student', '{"direct_control": {"answer": "yes", "note": null}}', false, null, null),
  (31, 'staff', '{"insurance": {"answer": "yes", "note": null, "date": null, "extra": null}}', false, null, 'answer_bad_shape'),
  (32, 'staff', '{"data_listd": {"answer": "maybe"}, "insurance": {"answer": "yes"}}', false, null, 'answer_unknown_question'),
  (33, 'student', '{"insurance": {"answer": "yes", "note": "nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn"}}', false, null, null),
  (34, 'student', '{"insurance": {"answer": "yes", "note": "nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn"}}', false, null, 'answer_bad_note'),
  (35, 'staff', '{"insurance": {"answer": "maybe"}, "data_listd": {"answer": "yes"}}', false, null, 'answer_bad_value'),
  (36, 'staff', '{"security_report": {"answer": "yes"}}', true, null, 'answer_date_missing'),
  (37, 'staff', '{"insurance": {"answer": "yes", "date": null}}', true, '2026-06-30', 'answer_date_missing'),
  (38, 'staff', '{"security_report": {"answer": "yes"}}', false, '2026-06-30', null),
  (39, 'staff', '{"security_report": {"answer": "no"}, "insurance": {"answer": "not_shown"}}', true, '2026-06-30', 'answers_incomplete'),
  (40, 'staff', '{"data_agreement": {"answer": "yes"}}', true, '2026-06-30', 'answers_incomplete'),
  (41, 'staff', '{"insurance": {"answer": "yes", "date": "2026-07-01"}}', false, '2026-06-30', null),
  (42, 'staff', '{"insurance": {"answer": "yes", "date": "2026-07-02"}}', false, '2026-06-30', 'answer_date_in_future'),
  (43, 'staff', '{"security_report": {"answer": "no", "date": "2030-01-01"}}', false, '2026-06-30', 'answer_date_in_future'),
  (44, 'staff', '{"data_agreement": {"answer": "yes", "date": "2030-01-01"}}', false, '2026-06-30', null),
  (45, 'staff', '{"insurance": {"answer": "yes", "date": "2028-02-29"}}', false, '2028-02-28', null),
  (46, 'staff', '{"insurance": {"answer": "yes", "date": "2028-03-01"}}', false, '2028-02-28', 'answer_date_in_future'),
  (47, 'staff', '{"insurance": {"answer": "yes", "date": "2030-01-01"}}', false, null, null),
  (48, 'staff', '{"security_report": {"answer": "yes"}, "insurance": {"answer": "yes", "date": "2026-07-02"}}', true, '2026-06-30', 'answer_date_in_future'),
  (49, 'staff', '{"security_report": {"answer": "yes", "date": "2026-07-02"}, "insurance": {"answer": "yes"}}', true, '2026-06-30', 'answer_date_missing'),
  (50, 'student', '{"insurance": {"answer": "yes", "note": "Seen", "date": "2026-02-30"}}', true, '2026-06-30', 'answer_bad_date');
-- VENDOR RISK ANSWER PROBLEMS END
select is(
  (select string_agg(p.n || ': ' || coalesce(x.problem, 'null'), ' ; ' order by p.n)
     from vr_problems p,
          lateral (select public._supplier_risk_answers_problem(1::smallint, p.level, p.answers::jsonb, p.final, p.today)) x(problem)
    where x.problem is distinct from p.problem),
  null,
  '0481/41: each kind of wrong answer is refused by its own word, and the right ones are taken (the answer-problem table, 50 rows)');
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
  array[public._supplier_risk_reason_ok('The vendor fixed it.'), public._supplier_risk_reason_ok('The vendor fixed it'),
        public._supplier_risk_reason_ok('   The vendor fixed it   '),
        public._supplier_risk_reason_ok(chr(9) || 'The vendor fixed it.' || chr(10)),
        public._supplier_risk_reason_ok(repeat('y', 25)), public._supplier_risk_reason_ok('yyyyy yyyyy yyyyy yyyyy'),
        public._supplier_risk_reason_ok(repeat('abcde', 400)), public._supplier_risk_reason_ok(repeat('abcde', 400) || 'y'),
        public._supplier_risk_reason_ok(null), public._supplier_risk_reason_ok(repeat('yz', 1000))],
  array[true, false, false, true, false, false, true, false, false, false],
  '0481/43: a reason is 20 to 2000 characters, counted after trimming the ends, with at least 5 different characters (spaces, tabs and line breaks aside)');

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
          reviewer_name, reviewed_at, reviewed_on, next_review_on)
          values (%L, %L, 'X', 1, 'final', true, 'student', %L, 'high', 'weak', 'high', '{}', 'approve', 'X', now(), current_date, current_date + 30)$$,
          :'orgA', :'supA5', pg_temp.answers('student', '{"data_agreement": "no"}'))),
        pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version,
          status, is_current, data_level, answers, starting_risk, evidence, residual_risk, hard_stops, computed_result,
          reviewer_name, reviewed_at, reviewed_on, next_review_on)
          values (%L, %L, 'X', 1, 'final', true, 'student', %L, 'high', 'weak', 'high', '{student_data_no_agreement}',
                  'do_not_use', 'X', now(), current_date, current_date + 30)$$,
          :'orgA', :'supA5', pg_temp.answers('student', '{"data_agreement": "no"}'))),
        pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version,
          status, is_current, data_level, answers, starting_risk, evidence, residual_risk, hard_stops, computed_result,
          reviewer_name, reviewed_at, reviewed_on, next_review_on)
          values (%L, %L, 'X', 1, 'final', true, 'student', %L, 'high', 'weak', 'high', '{student_data_no_agreement}',
                  'do_not_use', 'X', now(), current_date, null)$$,
          :'orgA', :'supA5', pg_temp.answers('student', '{"data_agreement": "no"}'))),
        pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version,
          data_level, answers, reviewer_name, computed_result) values (%L, %L, 'X', 1, 'staff', '{}', 'X', 'approve')$$,
          :'orgA', :'supA5'))],
  array['23514:supplier_risk_reviews_computed', 'ok', '23514:supplier_risk_reviews_computed', '23514:supplier_risk_reviews_computed'],
  '0481/45: a final whose result is not the rules'' is refused, the rules'' own is taken, a final with no next date and a draft with a result are refused');
select is(
  (select array_agg(pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version,
          status, is_current, data_level, answers, starting_risk, evidence, residual_risk, hard_stops, computed_result,
          override_result, override_reason, reviewer_name, reviewed_at, reviewed_on, next_review_on)
          values (%L, %L, 'X', 1, 'final', true, 'staff', %L, 'moderate', 'strong', 'low', '{}', 'approve',
                  %L, %L, 'X', now(), current_date, current_date + 30)$$,
          :'orgA', :'supA5', pg_temp.answers('staff'), t.r, t.why)) order by t.n)
     from (values (1, 'do_not_use', null), (2, null, 'A reason with no result.'), (3, 'approve', 'The same result as the rules.'),
                  (4, 'refuse', 'Not one of the four results.'), (5, 'do_not_use', 'short'),
                  (6, 'do_not_use', 'The vendor lost our trust last term.'), (7, 'do_not_use', 'Nineteen characters'),
                  (8, 'do_not_use', repeat('z', 40))) t(n, r, why)),
  array['23514:supplier_risk_reviews_override', '23514:supplier_risk_reviews_override', '23514:supplier_risk_reviews_override',
        '23514:supplier_risk_reviews_override', '23514:supplier_risk_reviews_override', 'ok',
        '23514:supplier_risk_reviews_override', '23514:supplier_risk_reviews_override'],
  '0481/46: an override needs another of the four results and a reason by the reason rule (20 characters or more, not one character repeated); both or neither');
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
  array['12', '0', 'none', '0', 'false', '12', '0', 'none', '0', 'false',
        '12', '0', 'none', '0', 'ERR 42501 supplier_risk_act_as_read_only hint=supplier_risk_act_as_read_only'],
  '0481/53: an owner and an admin of the organization may read (the register lists its 12 active suppliers) and discard; a live act-as seat may read and not discard');
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
  (pg_temp.j(pg_temp.as_user(:'adminA', format($$select public.supplier_risk_draft_save(%L, %L, 'staff', '{"insurance": {"answer": "no", "note": "None on file."}}')::text$$,
     :'orgA', :'supA1'))) ->> 'version'),
  '1',
  '0481/55: an admin''s first draft for a supplier is version 1');
select is(
  (pg_temp.j(pg_temp.as_user(:'ownerA', format($$select public.supplier_risk_draft_save(%L, %L, 'staff', '{"insurance": {"answer": "yes"}}')::text$$,
     :'orgA', :'supA1'))) ->> 'version'),
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
     from (select pg_temp.j(pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb, null, null, null, %L::jsonb)::text$$,
             :'orgA', :'supA1', pg_temp.answers('staff', '{"insurance": "no", "hosting_known": "not_shown"}'),
             pg_temp.items('staff', '{"insurance": "no", "hosting_known": "not_shown"}', :'adminA', pg_temp.today(:'orgA') + 10)))) j) x),
  '{"items": 2, "result": "approve_with_conditions", "version": 1, "evidence": "adequate", "hard_stops": [], "out_of_date": [], "residual_risk": "low", "starting_risk": "moderate", "computed_result": "approve_with_conditions", "override_result": null, "pending_hard_stops": [], "superseded_review_id": null} | true | true',
  '0481/60: finishing gives the rules'' answer, finishes the open draft in place, and sets the next review 12 months from the organization''s today');
select is(
  (select array[r.status, r.is_current::text, r.result, r.reviewer_name, (r.reviewed_at = now())::text,
                (select string_agg(i.question_key || ':' || i.answer || ':' || i.severity || ':' || i.status || ':'
                                   || i.owner_name || ':' || (i.due_on - pg_temp.today(:'orgA'))::text, ',' order by i.question_key)
                   from public.supplier_risk_items i where i.review_id = r.id)]
     from public.supplier_risk_reviews r where r.id = :'rev_a1_v1'),
  array['final', 'true', 'approve_with_conditions', 'Made-up Admin A', 'true',
        'hosting_known:not_shown:low:open:Made-up Admin A:10,insurance:no:low:open:Made-up Admin A:10'],
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
              pg_temp.items('staff', '{"insurance": "no"}', :'staffB')), 'item_owner_not_an_admin'),
  (23, format('%L, %L, %L, %L::jsonb, null, null, null, %L::jsonb', :'orgA', :'supA2', 'staff', pg_temp.answers('staff', '{"insurance": "no"}'),
              pg_temp.items('staff', '{"insurance": "no"}', :'invitedAdmin')), 'item_owner_not_an_admin'),
  (24, format('%L, %L, %L, %L::jsonb, null, null, null, %L::jsonb', :'orgA', :'supA2', 'staff', pg_temp.answers('staff', '{"insurance": "no"}'),
              pg_temp.items('staff', '{"insurance": "no"}', :'actas')), 'item_owner_not_an_admin'),
  (25, format('%L, %L, %L, %L::jsonb, null, null, null, %L::jsonb', :'orgA', :'supA2', 'staff', pg_temp.answers('staff', '{"insurance": "no"}'),
              pg_temp.items('staff', '{"insurance": "no"}', :'disabledAdmin')), 'item_owner_not_an_admin'),
  (26, format('%L, %L, %L, %L::jsonb, null, null, null, %L::jsonb', :'orgA', :'supA2', 'staff', pg_temp.answers('staff', '{"insurance": "no"}'),
              pg_temp.items('staff', '{"insurance": "no"}', null, pg_temp.today(:'orgA') - 1)), 'bad_item_due_on'),
  (27, format('%L, %L, %L, %L::jsonb, null, null, null, %L::jsonb', :'orgA', :'supA2', 'staff', pg_temp.answers('staff', '{"insurance": "no"}'),
              pg_temp.items('staff', '{"insurance": "no"}', null, (pg_temp.today(:'orgA') + interval '3 years' + interval '1 day')::date)), 'bad_item_due_on'),
  (28, format('%L, %L, %L, %L::jsonb, null, null, null, %L::jsonb', :'orgA', :'supA2', 'staff', pg_temp.answers('staff', '{"insurance": "no"}'),
              '[{"question_key": "insurance", "finding": "F", "action": "A", "due_on": "2027-02-30"}]'), 'bad_item_due_on'),
  (29, format('%L, %L, %L, %L::jsonb', :'orgA', :'supA3', 'staff', pg_temp.answers('staff')), 'supplier_archived'),
  (30, format('%L, %L, %L, %L::jsonb', :'orgA', :'supB1', 'staff', pg_temp.answers('staff')), 'supplier_not_found'),
  (31, format('%L, %L, %L, %L::jsonb, null, null, null, %L::jsonb', :'orgA', :'supA2', 'staff', pg_temp.answers('staff', '{"insurance": "no"}'),
              pg_temp.items('staff', '{"insurance": "no"}', :'staffA')), 'item_owner_not_an_admin'),
  (32, format('%L, %L, %L, %L::jsonb, null, %L, %L', :'orgA', :'supA2', 'staff', pg_temp.answers('staff'), 'do_not_use', repeat('x', 40)), 'bad_override_reason'),
  (33, format('%L, %L, %L, %L::jsonb, null, %L, %L', :'orgA', :'supA2', 'staff', pg_temp.answers('staff'), 'do_not_use', 'Nineteen characters'), 'bad_override_reason');
select is(
  (select count(*) || ':' || coalesce(string_agg(f.n || ': ' || x.got, ' ; ' order by f.n)
                                      filter (where x.got is distinct from 'ERR 22023 ' || f.want || ' hint=' || f.want), '')
     from vr_finish f,
          lateral (select pg_temp.as_user(:'adminA', 'select public.supplier_risk_finalise(' || f.args || ')::text')) x(got)),
  '33:',
  '0481/62: every wrong finish is refused by its word (33 cases: answers, next date, override and its reason, items, owners who are not current owners or admins, due dates, supplier)');
select is(
  (select count(*)::int from public.supplier_risk_reviews r where r.supplier_id in (:'supA2', :'supA3', :'supB1')),
  0,
  '0481/63: and none of them wrote anything');

-- A second finish of A1: a new version, current; the first becomes history.
select is(
  (select array[x.j ->> 'version', (x.j ->> 'superseded_review_id' = :'rev_a1_v1')::text, x.j ->> 'computed_result',
                x.j ->> 'result', x.j ->> 'items', ((x.j ->> 'next_review_on')::date - pg_temp.today(:'orgA'))::text]
     from (select pg_temp.j(pg_temp.as_user(:'ownerA', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb, %L::date, 'do_not_use', 'The vendor changed owners; we stop for now.', '[]')::text$$,
             :'orgA', :'supA1', pg_temp.answers('staff'), pg_temp.today(:'orgA') + 100))) j) x),
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
     from (select pg_temp.j(pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'student', %L::jsonb, null, null, null, %L::jsonb)::text$$,
             :'orgA', :'supA2', pg_temp.answers('student', '{"data_agreement": "no"}'),
             pg_temp.items('student', '{"data_agreement": "no"}', :'ownerA')))) j) x),
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
  array[(pg_temp.j(pg_temp.as_user(:'adminA', format($$select public.supplier_risk_draft_save(%L, %L, 'staff', '{}')::text$$, :'orgA', :'supA1'))) ->> 'version'),
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
                (select string_agg(e ->> 'question_key' || ':' || (e ->> 'owner_is_admin'), ',') from jsonb_array_elements(x.j -> 'items') e),
                (select string_agg(k, ',' order by k) from jsonb_object_keys(x.j) k)]
     from (select pg_temp.j(pg_temp.as_user(:'adminA', format($$select public.supplier_risk_review(%L, %L)::text$$, :'orgA', :'rev_a1_v1'))) j) x),
  array['final', 'false', 'active', 'Example Paper Co', 'hosting_known:true,insurance:true',
        'answers,computed_result,created_at,data_level,evidence,hard_stops,id,is_current,items,next_review_on,organization_id,'
        'override_reason,override_result,reminded_30_at,reminded_due_at,reminded_due_retry_at,reminded_due_sent_at,'
        'residual_risk,result,reviewed_at,reviewed_on,reviewer_id,'
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
                (x.j ->> 'owner_is_admin')]
     from (select pg_temp.j(pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'done', %L, null, 'Signed agreement received.')::text$$,
             :'orgA', :'item_a2', :'ownerA'))) j) x),
  array['done', 'true', 'Made-up Owner A', 'Signed agreement received.', 'true'],
  '0481/74: an item marked done is closed, with its new owner''s name and action');
select closed_at as item_a2_closed from public.supplier_risk_items where id = :'item_a2' \gset
select is(
  (select array[x.j ->> 'status', ((x.j ->> 'closed_at')::timestamptz = :'item_a2_closed'::timestamptz)::text, x.j ->> 'action']
     from (select pg_temp.j(pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'accepted', %L, null, null, %L)::text$$,
             :'orgA', :'item_a2', :'ownerA', 'We accept this until the next renewal.'))) j) x),
  array['accepted', 'true', 'Signed agreement received.'],
  '0481/75: done to accepted (with its reason) keeps the closing time; a null action keeps the action');
select is(
  (select array[x.j ->> 'status', coalesce(x.j ->> 'closed_at', 'none'), coalesce(x.j ->> 'owner_name', 'none'),
                ((x.j ->> 'due_on')::date - pg_temp.today(:'orgA'))::text]
     from (select pg_temp.j(pg_temp.as_user(:'ownerA', format($$select public.supplier_risk_item_update(%L, %L, 'open', null, %L::date, null)::text$$,
             :'orgA', :'item_a2', pg_temp.today(:'orgA') + 7))) j) x),
  array['open', 'none', 'none', '7'],
  '0481/76: back to open clears the closing time; no owner, and a due date a week ahead');
select is(
  array[pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'closed', null, null, null)::text$$, :'orgA', :'item_a2')),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, null, null, null, null)::text$$, :'orgA', :'item_a2')),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'open', %L, null, null)::text$$, :'orgA', :'item_a2', :'staffB')),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'open', %L, null, null)::text$$, :'orgA', :'item_a2', :'staffA')),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'open', %L, null, null)::text$$, :'orgA', :'item_a2', :'actas')),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'open', null, %L::date, null)::text$$, :'orgA', :'item_a2', pg_temp.today(:'orgA') - 1)),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'open', null, null, '')::text$$, :'orgA', :'item_a2')),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'open', null, null, null)::text$$, :'orgA', :'item_a1_old')),
        pg_temp.as_user(:'adminB', format($$select public.supplier_risk_item_update(%L, %L, 'open', null, null, null)::text$$, :'orgB', :'item_a2')),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, null, 'open', null, null, null)::text$$, :'orgA'))],
  array['ERR 22023 bad_item_status hint=bad_item_status', 'ERR 22023 bad_item_status hint=bad_item_status',
        'ERR 22023 item_owner_not_an_admin hint=item_owner_not_an_admin', 'ERR 22023 item_owner_not_an_admin hint=item_owner_not_an_admin',
        'ERR 22023 item_owner_not_an_admin hint=item_owner_not_an_admin',
        'ERR 22023 bad_item_due_on hint=bad_item_due_on', 'ERR 22023 bad_item_text hint=bad_item_text',
        'ERR 22023 item_not_current hint=item_not_current', 'ERR 22023 item_not_found hint=item_not_found',
        'ERR 22023 item_not_found hint=item_not_found'],
  '0481/77: an item change is refused for a wrong status, an owner who is not a current owner or admin (another organization''s member, a staff member, an act-as seat), a past due date, an empty action, an earlier version''s item and another organization''s');
-- The same owner stays after they stop being a member; a due date already
-- set stays even once it is past.
update public.supplier_risk_items set owner_user_id = :'managerA', owner_name = 'Made-up Manager A', due_on = current_date - 30
 where id = :'item_a2';
update public.organization_members set role = 'staff', accepted_at = null where organization_id = :'orgA' and user_id = :'managerA';
select is(
  (select array[x.j ->> 'status', x.j ->> 'owner_name', x.j ->> 'owner_is_admin', ((x.j ->> 'due_on')::date = current_date - 30)::text]::text
     from (select pg_temp.j(pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'in_progress', %L, %L::date, null)::text$$,
             :'orgA', :'item_a2', :'managerA', current_date - 30))) j) x),
  '{in_progress,"Made-up Manager A",false,true}',
  '0481/78: an owner who left and a due date already past stay when only the status changes');
update public.organization_members set role = 'manager', accepted_at = now() where organization_id = :'orgA' and user_id = :'managerA';

-- Archived and deleted suppliers keep their reviews, marked.
select is(
  array[(pg_temp.j(pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'none', '{}')::text$$, :'orgA', :'supA4'))) ->> 'result'),
        (pg_temp.j(pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb)::text$$, :'orgA', :'supA5', pg_temp.answers('staff')))) ->> 'result')],
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
        (pg_temp.j(pg_temp.as_user(:'adminA', format($$select public.supplier_risk_review(%L, %L)::text$$, :'orgA',
           (select r.id from public.supplier_risk_reviews r where r.supplier_id = :'supA5')))) ->> 'supplier_state'),
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
        pg_temp.try(format($$insert into public.supplier_risk_items (organization_id, review_id, question_key, answer, severity, finding, action,
                              changed_by_name) values (%L, %L, 'insurance', 'no', 'low', 'F', 'A', 'X')$$, :'orgB', :'rev_a1_v2')),
        pg_temp.try(format($$insert into public.supplier_risk_items (organization_id, review_id, question_key, answer, severity, finding, action,
                              changed_by_name) values (%L, %L, 'no_such_question', 'no', 'low', 'F', 'A', 'X')$$, :'orgA', :'rev_a1_v2')),
        pg_temp.try(format($$insert into public.supplier_risk_items (organization_id, review_id, question_key, answer, severity, finding, action,
                              changed_by_name) values (%L, %L, 'insurance', 'yes', 'low', 'F', 'A', 'X')$$, :'orgA', :'rev_a1_v2'))],
  array['55000:supplier_risk_final_is_kept', '55000:supplier_risk_final_is_kept', '55000:supplier_risk_final_is_kept',
        '55000:supplier_risk_final_is_kept', 'ok', '23514:supplier_risk_items_closed', '23503:supplier_risk_items_review_fkey',
        '23514:supplier_risk_items_question_key', '23514:supplier_risk_items_answer'],
  '0481/85: an item''s finding, severity, question, answer and review never change; an item of another organization''s review, of no question or for a Yes is refused');

-- ── 8. An account deleted; an organization deleted ──────────────────────────
insert into public.suppliers (id, organization_id, name) values ('a0481000-0000-0000-0000-0000000000fb', :'orgA', 'Leaver Review Co');
select is(
  (pg_temp.j(pg_temp.as_user(:'leaver', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb, null, null, null, %L::jsonb)::text$$,
     :'orgA', 'a0481000-0000-0000-0000-0000000000fb', pg_temp.answers('staff', '{"insurance": "no"}'),
     pg_temp.items('staff', '{"insurance": "no"}', :'leaver')))) ->> 'items'),
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
  (pg_temp.j(pg_temp.as_user(:'ownerD', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb, null, null, null, %L::jsonb)::text$$,
     :'orgD', :'supD1', pg_temp.answers('staff', '{"insurance": "no"}'), pg_temp.items('staff', '{"insurance": "no"}')))) ->> 'items'),
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
-- Owners of the open items: an admin, a staff member of A (since an item's
-- owner is named an owner or admin, a member who lost the role) and a staff
-- member of B; and of the closed items, a manager (done) and an owner (done,
-- and accepted): an owner or admin who owns only closed items gets no reminder
-- as an item owner.
insert into public.supplier_risk_items (organization_id, review_id, question_key, answer, severity, finding, action, owner_user_id, owner_name,
                                        status, closed_at, changed_by_name)
values (:'orgA', 'a0481000-0000-0000-0000-000000000101', 'insurance', 'no', 'low', 'F', 'A', :'adminA', 'Made-up Admin A', 'open', null, 'Made-up Reviewer'),
       (:'orgA', 'a0481000-0000-0000-0000-000000000101', 'hosting_known', 'no', 'low', 'F', 'A', :'staffA', 'Made-up Staff A', 'open', null, 'Made-up Reviewer'),
       (:'orgA', 'a0481000-0000-0000-0000-000000000101', 'data_we_send', 'no', 'low', 'F', 'A', :'staffB', 'Made-up Staff B', 'open', null, 'Made-up Reviewer'),
       (:'orgA', 'a0481000-0000-0000-0000-000000000101', 'data_listed', 'no', 'low', 'F', 'A', :'managerA', 'Made-up Manager A', 'done', now(), 'Made-up Reviewer'),
       (:'orgA', 'a0481000-0000-0000-0000-000000000101', 'security_report', 'no', 'low', 'F', 'A', :'ownerA', 'Made-up Owner A', 'done', now(), 'Made-up Reviewer');
insert into public.supplier_risk_items (organization_id, review_id, question_key, answer, severity, finding, action, owner_user_id, owner_name,
                                        status, closed_at, changed_by_name, accepted_by, accepted_by_name, accepted_reason)
values (:'orgA', 'a0481000-0000-0000-0000-000000000101', 'subvendors_named', 'no', 'low', 'F', 'A', :'ownerA', 'Made-up Owner A', 'accepted', now(),
        'Made-up Owner A', :'ownerA', 'Made-up Owner A', 'The school accepts this for one term only.');

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
  '{' || :'ownerA' || ',' || :'adminA' || '} {' || :'adminA' || '}',
  '0481/95: the recipients: current owners and admins (not a disabled admin, an invitation, an act-as seat), and owners of open items who are current owners or admins (not a staff member, not a member of another organization, not the owner of done and accepted items only): only people who can open the page');
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
        split_part(pg_temp.run_as('anon', null, $$select public.supplier_risk_reminder_claim('a0481000-0000-0000-0000-000000000102', 'due')::text$$), ' for function', 1),
        split_part(pg_temp.as_user(:'adminA', $$select public.supplier_risk_due_reminder_sent('a0481000-0000-0000-0000-000000000101')::text$$), ' for function', 1),
        split_part(pg_temp.run_as('anon', null, $$select public.supplier_risk_due_reminder_sent('a0481000-0000-0000-0000-000000000101')::text$$), ' for function', 1)],
  array['ERR 42501 permission denied', 'ERR 42501 permission denied', 'ERR 42501 permission denied',
        'ERR 42501 permission denied', 'ERR 42501 permission denied'],
  '0481/99: a member and anon may not call the job''s three functions');
-- The second lock: even with EXECUTE granted (inside a block that is undone),
-- a signed-in member is refused by the body.
create function pg_temp.granted_as(p_sub uuid, p_sql text) returns text language plpgsql as $f$
declare
  v text;
begin
  begin
    grant execute on function public.supplier_risk_reminders_due(integer) to authenticated;
    grant execute on function public.supplier_risk_reminder_claim(uuid, text) to authenticated;
    grant execute on function public.supplier_risk_due_reminder_sent(uuid) to authenticated;
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
        pg_temp.granted_as(:'adminA', $$select public.supplier_risk_due_reminder_sent('a0481000-0000-0000-0000-000000000101')::text$$),
        pg_temp.grants_of('public.supplier_risk_reminder_claim(uuid, text)'),
        pg_temp.grants_of('public.supplier_risk_due_reminder_sent(uuid)'),
        (select coalesce(reminded_due_at::text, 'none') from public.supplier_risk_reviews where id = 'a0481000-0000-0000-0000-000000000102'),
        (select coalesce(reminded_due_sent_at::text, 'none') from public.supplier_risk_reviews where id = 'a0481000-0000-0000-0000-000000000101')],
  array['ERR 42501 supplier_risk_not_allowed hint=supplier_risk_not_allowed', 'ERR 42501 supplier_risk_not_allowed hint=supplier_risk_not_allowed',
        'ERR 42501 supplier_risk_not_allowed hint=supplier_risk_not_allowed',
        'service_role:EXECUTE', 'service_role:EXECUTE', 'none', 'none'],
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
  array[pg_temp.try(format($$insert into public.supplier_risk_items (organization_id, review_id, question_key, answer, severity, finding, action,
          changed_by_name) values (%L, %L, 'hosting_known', 'no', 'low', 'F', 'A', 'X'), (%L, %L, 'hosting_known', 'not_shown', 'low', 'F', 'A', 'X')$$,
          :'orgA', :'revH1', :'orgA', :'revH1')),
        pg_temp.try(format($$insert into public.supplier_risk_items (organization_id, review_id, question_key, answer, severity, finding, action,
          changed_by_name, owner_user_id) values (%L, %L, 'hosting_known', 'no', 'low', 'F', 'A', 'X', %L)$$, :'orgA', :'revH1', :'adminA')),
        pg_temp.try(format($$insert into public.supplier_risk_items (organization_id, review_id, question_key, answer, severity, finding, action,
          changed_by_name) values (%L, %L, 'hosting_known', 'no', 'low', repeat('f', 501), 'A', 'X')$$, :'orgA', :'revH1')),
        pg_temp.try(format($$insert into public.supplier_risk_items (organization_id, review_id, question_key, answer, severity, finding, action,
          changed_by_name) values (%L, %L, 'hosting_known', 'no', 'low', 'F', repeat('a', 1001), 'X')$$, :'orgA', :'revH1')),
        pg_temp.try(format($$insert into public.supplier_risk_items (organization_id, review_id, question_key, answer, severity, finding, action,
          changed_by_name, status) values (%L, %L, 'hosting_known', 'no', 'low', 'F', 'A', 'X', 'closed')$$, :'orgA', :'revH1')),
        pg_temp.try(format($$insert into public.supplier_risk_items (organization_id, review_id, question_key, answer, severity, finding, action,
          changed_by_name, owner_user_id, owner_name) values (%L, %L, 'hosting_known', 'no', 'low', repeat('f', 500), repeat('a', 1000), 'X', %L,
          'Made-up Admin A')$$,
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
     from (select pg_temp.j(pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'accepted', null, null, null, %L)::text$$,
                                                    :'orgA', :'item_h2', 'Accepted until the vendor renews in May.'))) as j) x),
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
                    'public.supplier_risk_item_update(uuid, uuid, text, uuid, date, text, text)'::regprocedure)),
  'supplier_risk_draft_discard:true,supplier_risk_draft_save:true,supplier_risk_finalise:true,supplier_risk_item_update:true',
  '0481/115: each of the four writes takes the supplier''s lock before it reads the supplier or the item for writing (the two-session proof is the race script)');

-- ── 11. Holes the final red-check run found (the reads, the reminders, names) ─
\set orgV 'a0481000-0000-0000-0000-0000000000a8'
\set noName 'a0481000-0000-0000-0000-0000000000d5'
\set supS2 'a0481000-0000-0000-0000-000000000302'
\set supS3 'a0481000-0000-0000-0000-000000000303'
\set revS3 'a0481000-0000-0000-0000-000000000313'
-- A final review written straight into the table under a given supplier name.
create function pg_temp.named_final(p_id uuid, p_org uuid, p_supplier uuid, p_name text, p_version integer,
                                    p_current boolean, p_next date)
returns void language sql as $f$
  insert into public.supplier_risk_reviews
    (id, organization_id, supplier_id, supplier_name, version, status, is_current, data_level, answers,
     starting_risk, evidence, residual_risk, hard_stops, computed_result, reviewer_id, reviewer_name,
     reviewed_at, reviewed_on, next_review_on)
  select p_id, p_org, p_supplier, p_name, p_version, 'final', p_current, 'none', '{}'::jsonb,
         e ->> 'starting_risk', e ->> 'evidence', e ->> 'residual_risk',
         array(select jsonb_array_elements_text(e -> 'hard_stops')), e ->> 'result',
         null, 'Made-up Reviewer', now() - interval '1 year', (now() - interval '1 year')::date, p_next
    from public._supplier_risk_evaluate(1::smallint, 'none', '{}'::jsonb, (now() - interval '1 year')::date) e;
$f$;

select is(
  pg_temp.as_user(:'adminA', format($$select string_agg(g.supplier_name || ':' || g.review_due, ',' order by g.supplier_name)
                                        from public.supplier_risk_register(%L) g where g.supplier_id in (%L, %L)$$,
                                     :'orgA', :'supR3', :'supR4')),
  'Reminder In Thirty:due_soon,Reminder In Thirty One:scheduled',
  '0481/116: the register says due soon 30 days ahead, not 31');
select is(
  pg_temp.as_user(:'adminA', format($$select g.open_items || ':' || g.top_open_severity from public.supplier_risk_register(%L) g where g.supplier_id = %L$$,
                                     :'orgA', :'supR1')),
  '3:low',
  '0481/117: the register counts open and in-progress items only (three open; two done and one accepted)');
select is(
  array[pg_temp.as_user(:'adminA', format($$select string_agg(distinct x.status, ',' order by x.status) from public.supplier_risk_items_for_organization(%L) x$$, :'orgA')),
        pg_temp.as_user(:'adminA', format($$select string_agg(distinct x.status, ',' order by x.status) from public.supplier_risk_items_for_organization(%L, false) x$$, :'orgA'))],
  array['in_progress,open', 'accepted,done,in_progress,open'],
  '0481/118: the items list leaves closed items out unless asked for them');

-- An item owned by a live act-as seat, due in ten days, and one owned by an
-- admin with no due date, both low, on the current review of Holes Table Co.
insert into public.supplier_risk_items (organization_id, review_id, question_key, answer, severity, finding, action, owner_user_id, owner_name, due_on,
                                        changed_by_name)
values (:'orgA', :'revH1', 'hosting_known', 'no', 'low', 'F', 'A', :'adminA', 'Made-up Admin A', null, 'Made-up Reviewer'),
       (:'orgA', :'revH1', 'insurance', 'no', 'low', 'F', 'A', :'actas', 'Made-up Act As', current_date + 10, 'Made-up Reviewer');
select is(
  (select string_agg(e ->> 'question_key' || ':' || (e ->> 'owner_is_admin'), ',')
     from jsonb_array_elements((pg_temp.j(pg_temp.as_user(:'adminA', format($$select public.supplier_risk_review(%L, %L)::text$$, :'orgA', :'revH1')))) -> 'items') e),
  'hosting_known:true,insurance:false',
  '0481/119: a review''s items say an act-as seat is not a current owner or admin');
select is(
  pg_temp.as_user(:'adminA', format($$select string_agg(x.question_key || ':' || x.owner_is_admin, ',' order by x.question_key)
                                        from public.supplier_risk_items_for_organization(%L) x where x.supplier_id = %L$$, :'orgA', :'supH1')),
  'hosting_known:true,insurance:false',
  '0481/120: so does the items list');
select is(
  pg_temp.as_user(:'adminA', format($$select string_agg(x.question_key, ',' order by x.ordinality)
                                        from public.supplier_risk_items_for_organization(%L) with ordinality x where x.supplier_id = %L$$, :'orgA', :'supH1')),
  'insurance,hosting_known',
  '0481/121: within a severity the items list puts a due date before none (none last)');

insert into public.suppliers (id, organization_id, name, deleted_at) values (:'supS2', :'orgA', 'Holes New Name Co', null);
select pg_temp.named_final('a0481000-0000-0000-0000-000000000311', :'orgA', :'supS2', 'Holes Old Name Co', 1, false, pg_temp.today(:'orgA') + 100);
select pg_temp.named_final('a0481000-0000-0000-0000-000000000312', :'orgA', :'supS2', 'Holes New Name Co', 2, true, pg_temp.today(:'orgA') + 200);
delete from public.suppliers where id = :'supS2';
select is(
  pg_temp.as_user(:'adminA', format($$select g.supplier_name || ':' || g.supplier_state || ':' || g.version from public.supplier_risk_register(%L) g where g.supplier_id = %L$$,
                                     :'orgA', :'supS2')),
  'Holes New Name Co:deleted:2',
  '0481/122: the register names a deleted supplier by its newest review''s name');

select pg_temp.as_user(:'adminA', format($$select public.supplier_risk_draft_save(%L, %L, 'staff', '{}')::text$$, :'orgA', :'supH1')) as draft_h1 \gset
select is(
  array[pg_temp.as_user(:'adminA', format($$select count(*) || ':' || max(g.version) || ':' || bool_and(g.review_id = %L) || ':' || bool_and(g.draft_review_id is not null)
                                              from public.supplier_risk_register(%L) g where g.supplier_id = %L$$, :'revH1', :'orgA', :'supH1')),
        pg_temp.as_user(:'adminA', format($$select coalesce(g.review_id::text, 'none') || ':' || g.review_due || ':' || (g.draft_review_id is not null)
                                              from public.supplier_risk_register(%L) g where g.supplier_id = %L$$, :'orgA', :'supH3'))],
  array['1:1:true:true', 'none:not_reviewed:true'],
  '0481/123: the register shows the current final review and the draft beside it, never the draft as the review');

-- Organization V has 501 reviews due today.
insert into public.organizations (id, name, slug, mfa_policy, timezone) values
  (:'orgV', 'Vendor Risk Org V', 'a0481000-org-v', 'optional', 'UTC');
insert into public.suppliers (id, organization_id, name, deleted_at)
select format('a0481000-0000-0000-0001-%s', lpad(g::text, 12, '0'))::uuid, :'orgV', 'Many Co ' || g, null
  from generate_series(1, 501) g;
select count(*) as many_v from (
  select pg_temp.final_row(format('a0481000-0000-0000-0002-%s', lpad(g::text, 12, '0'))::uuid, :'orgV',
                           format('a0481000-0000-0000-0001-%s', lpad(g::text, 12, '0'))::uuid, 1, true,
                           pg_temp.today(:'orgV'), now() - interval '1 year')
    from generate_series(1, 501) g) x \gset
select is(
  array[pg_temp.run_as('service_role', null, $$select count(*)::text from public.supplier_risk_reminders_due(5000)$$),
        pg_temp.run_as('service_role', null, $$select count(*)::text from public.supplier_risk_reminders_due(501)$$)],
  array['500', '500'],
  '0481/124: a page of the reminder read is at most 500 rows, whatever limit is asked (more than 500 are due)');

insert into public.suppliers (id, organization_id, name, deleted_at) values (:'supS3', :'orgA', 'Holes Soon Co', null);
select pg_temp.final_row(:'revS3', :'orgA', :'supS3', 1, true, pg_temp.today(:'orgA') + 10, now() - interval '1 year');
select is(
  array[pg_temp.run_as('service_role', null, format($$select public.supplier_risk_reminder_claim(%L, 'weekly')::text$$, :'revS3')),
        pg_temp.run_as('service_role', null, format($$select public.supplier_risk_reminder_claim(%L, null)::text$$, :'revS3')),
        (select (reminded_30_at is null)::text from public.supplier_risk_reviews where id = :'revS3'),
        pg_temp.run_as('service_role', null, format($$select public.supplier_risk_reminder_claim(%L, 'due')::text$$, :'revS3')),
        pg_temp.run_as('service_role', null, format($$select public.supplier_risk_reminder_claim(%L, 'due_soon')::text$$, :'revS3'))],
  array['false', 'false', 'true', 'false', 'true'],
  '0481/125: a claim of another kind, or of none, claims nothing, even for a review whose 30-day reminder is due');

insert into auth.users (id, email, raw_user_meta_data) values (:'noName', 'vr-no-name@test.local', '{}'::jsonb);
update public.user_profiles set full_name = '   ' where id = :'noName';
select is(
  array[public._supplier_risk_person_name(:'noName'), public._supplier_risk_person_name(:'adminA'),
        public._supplier_risk_person_name('a0481000-0000-0000-0000-00000000dead')],
  array['vr-no-name@test.local', 'Made-up Admin A', 'Unknown'],
  '0481/126: a name kept on a review or an item is the full name, else the email, else Unknown');

-- 0481/83 sends a final back to draft with its results cleared, which the
-- guard refuses for the cleared columns too; the status alone must be refused
-- by the guard as well, not only by the table's check of a draft's columns.
select is(
  array[pg_temp.try(format($$update public.supplier_risk_reviews set status = 'draft' where id = %L$$, :'rev_a1_v1')),
        pg_temp.try(format($$update public.supplier_risk_reviews set status = 'draft', is_current = false where id = %L$$, :'rev_a1_v2'))],
  array['55000:supplier_risk_final_is_kept', '55000:supplier_risk_final_is_kept'],
  '0481/127: a final review''s status alone cannot go back to draft (the guard refuses it, not only the check)');

-- ── 12. The review of e70d270a5: its must and should fixes ─────────────────
-- REVIEW-0481.md in the notes names them: M1, M2, S1, S2, S4, S6, and the
-- answers to Q4 and Q7. Each test below fails on e70d270a5's migration.
\set acceptor 'a0481000-0000-0000-0000-0000000000d6'
\set demoted 'a0481000-0000-0000-0000-0000000000d7'
\set supM1 'a0481000-0000-0000-0000-000000000401'
\set supM2 'a0481000-0000-0000-0000-000000000402'
\set supM3 'a0481000-0000-0000-0000-000000000403'
\set supM4 'a0481000-0000-0000-0000-000000000404'
\set supN1 'a0481000-0000-0000-0000-000000000411'
\set supN2 'a0481000-0000-0000-0000-000000000412'
\set supU1 'a0481000-0000-0000-0000-000000000421'
\set supO1 'a0481000-0000-0000-0000-000000000422'
\set supS6 'a0481000-0000-0000-0000-000000000431'
\set supT1 'a0481000-0000-0000-0000-000000000441'
\set supQ1 'a0481000-0000-0000-0000-000000000451'
\set supQ2 'a0481000-0000-0000-0000-000000000452'
\set supQ3 'a0481000-0000-0000-0000-000000000453'
\set supQ4 'a0481000-0000-0000-0000-000000000454'
\set supQ5 'a0481000-0000-0000-0000-000000000455'
\set supQ6 'a0481000-0000-0000-0000-000000000456'
\set supQ7 'a0481000-0000-0000-0000-000000000457'
\set revQ1 'a0481000-0000-0000-0000-000000000461'
\set revQ2 'a0481000-0000-0000-0000-000000000462'
\set revQ3 'a0481000-0000-0000-0000-000000000463'
\set revQ4 'a0481000-0000-0000-0000-000000000464'
\set revQ5 'a0481000-0000-0000-0000-000000000465'
\set revQ6 'a0481000-0000-0000-0000-000000000466'
\set revQ7 'a0481000-0000-0000-0000-000000000467'
\set revQ6b 'a0481000-0000-0000-0000-000000000468'
-- Organization V's 501 reviews due today have done their work (0481/124).
delete from public.organizations where id = :'orgV';
insert into auth.users (id, email, raw_user_meta_data) values
  (:'acceptor', 'vr-acceptor@test.local', '{"full_name": "Made-up Acceptor"}'::jsonb),
  (:'demoted',  'vr-demoted@test.local',  '{"full_name": "Made-up Demoted Admin"}'::jsonb);
insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at) values
  (:'orgA', :'acceptor', 'admin', now(), null),
  (:'orgA', :'demoted',  'admin', now(), null);
insert into public.suppliers (id, organization_id, name, deleted_at) values
  (:'supM1', :'orgA', 'Reused Id One A', null),   (:'supM2', :'orgA', 'Reused Id Two A', null),
  (:'supM3', :'orgB', 'Reused Id Three B', null), (:'supM4', :'orgB', 'Reused Id Four B', null),
  (:'supN1', :'orgA', 'Name Before Co', null),    (:'supN2', :'orgA', 'Name Kept Co', null),
  (:'supU1', :'orgA', 'Accepted Risk Co', null),  (:'supO1', :'orgA', 'Demoted Owner Co', null),
  (:'supS6', :'orgA', 'Support Seat Co', null),   (:'supT1', :'orgA', 'Old Report Co', null),
  (:'supQ1', :'orgA', 'Second Chance Old', null), (:'supQ2', :'orgA', 'Second Chance Recent', null),
  (:'supQ3', :'orgA', 'Second Chance Never', null), (:'supQ4', :'orgA', 'Second Chance Confirmed', null),
  (:'supQ5', :'orgA', 'Second Chance Spent', null), (:'supQ6', :'orgA', 'Second Chance Superseded', null),
  (:'supQ7', :'orgA', 'Second Chance Archived', null);

-- M1. A has a final of M1 and a draft for M2; B a final of M3 and a draft for
-- M4. Each deletes its two suppliers, and the other organization then makes
-- suppliers with the same ids (the id column is the caller's to send).
select pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'none', '{}')::text$$, :'orgA', :'supM1')) as m_a1 \gset
select pg_temp.as_user(:'adminA', format($$select public.supplier_risk_draft_save(%L, %L, 'none', '{}')::text$$, :'orgA', :'supM2')) as m_a2 \gset
select pg_temp.as_user(:'adminB', format($$select public.supplier_risk_finalise(%L, %L, 'none', '{}')::text$$, :'orgB', :'supM3')) as m_b3 \gset
select pg_temp.as_user(:'adminB', format($$select public.supplier_risk_draft_save(%L, %L, 'none', '{}')::text$$, :'orgB', :'supM4')) as m_b4 \gset
delete from public.suppliers where id in (:'supM1', :'supM2', :'supM3', :'supM4');
insert into public.suppliers (id, organization_id, name, deleted_at) values
  (:'supM1', :'orgB', 'Reused Id One B', null),   (:'supM2', :'orgB', 'Reused Id Two B', null),
  (:'supM3', :'orgA', 'Reused Id Three A', null), (:'supM4', :'orgA', 'Reused Id Four A', null);
select pg_temp.as_user(:'adminB', format($$select public.supplier_risk_finalise(%L, %L, 'none', '{}')::text$$, :'orgB', :'supM1')) as m_b1 \gset
select pg_temp.as_user(:'adminB', format($$select public.supplier_risk_draft_save(%L, %L, 'none', '{}')::text$$, :'orgB', :'supM2')) as m_b2 \gset
select pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'none', '{}')::text$$, :'orgA', :'supM3')) as m_a3 \gset
select pg_temp.as_user(:'adminA', format($$select public.supplier_risk_draft_save(%L, %L, 'none', '{}')::text$$, :'orgA', :'supM4')) as m_a4 \gset
select is(
  array[coalesce(pg_temp.j(:'m_b1') ->> 'version', pg_temp.j(:'m_b1') ->> 'err'),
        coalesce(pg_temp.j(:'m_b1') ->> 'superseded_review_id', 'none'),
        coalesce(pg_temp.j(:'m_b2') ->> 'version', pg_temp.j(:'m_b2') ->> 'err'),
        (select r.is_current::text from public.supplier_risk_reviews r where r.id = (pg_temp.j(:'m_a1') ->> 'review_id')::uuid),
        (select r.status || ':' || r.version from public.supplier_risk_reviews r where r.id = (pg_temp.j(:'m_a2') ->> 'review_id')::uuid)],
  array['1', 'none', '1', 'true', 'draft:1'],
  '0481/128: M1, A first: B''s first review of a supplier id A reviewed before is version 1 and supersedes nothing, B may save a draft beside A''s, and A''s final stays current');
select is(
  array[coalesce(pg_temp.j(:'m_a3') ->> 'version', pg_temp.j(:'m_a3') ->> 'err'),
        coalesce(pg_temp.j(:'m_a3') ->> 'superseded_review_id', 'none'),
        coalesce(pg_temp.j(:'m_a4') ->> 'version', pg_temp.j(:'m_a4') ->> 'err'),
        (select r.is_current::text from public.supplier_risk_reviews r where r.id = (pg_temp.j(:'m_b3') ->> 'review_id')::uuid),
        (select r.status || ':' || r.version from public.supplier_risk_reviews r where r.id = (pg_temp.j(:'m_b4') ->> 'review_id')::uuid)],
  array['1', 'none', '1', 'true', 'draft:1'],
  '0481/129: M1, B first: the same the other way round');
-- A write and the read that checks it are two statements: a plain read in the
-- statement that called the write reads that statement's snapshot, from
-- before the write.
select pg_temp.as_user(:'adminB', format($$select public.supplier_risk_draft_discard(%L, %L)::text$$, :'orgB', :'supM2')) as m_b2_gone \gset
select is(
  array[pg_temp.as_user(:'adminA', format($$select string_agg(g.supplier_name || ':' || g.supplier_state || ':' || coalesce(g.version::text, '-') || ':'
                                                              || g.review_due || ':' || (g.draft_review_id is not null), ',' order by g.supplier_name)
                                              from public.supplier_risk_register(%L) g where g.supplier_id in (%L, %L)$$, :'orgA', :'supM1', :'supM2')),
        pg_temp.as_user(:'adminB', format($$select string_agg(g.supplier_name || ':' || g.supplier_state || ':' || coalesce(g.version::text, '-') || ':'
                                                              || g.review_due || ':' || (g.draft_review_id is not null), ',' order by g.supplier_name)
                                              from public.supplier_risk_register(%L) g where g.supplier_id in (%L, %L)$$, :'orgB', :'supM1', :'supM2')),
        pg_temp.as_user(:'adminA', format($$select string_agg(h.version || ':' || h.status, ',') from public.supplier_risk_history(%L, %L) h$$, :'orgA', :'supM1')),
        pg_temp.as_user(:'adminB', format($$select string_agg(h.version || ':' || h.status, ',') from public.supplier_risk_history(%L, %L) h$$, :'orgB', :'supM1')),
        :'m_b2_gone',
        (select string_agg((r.organization_id = :'orgA')::text || ':' || r.status, ',') from public.supplier_risk_reviews r where r.supplier_id = :'supM2')],
  array['Reused Id One A:deleted:1:scheduled:false,Reused Id Two A:deleted:-:not_reviewed:true',
        'Reused Id One B:active:1:scheduled:false,Reused Id Two B:active:-:not_reviewed:false',
        '1:final', '1:final', 'true', 'true:draft'],
  '0481/130: M1: each organization''s register and history show its own reviews of the id only, and B discarding its own draft leaves A''s');
select is(
  (select string_agg(p.proname || ':' || (strpos(p.prosrc, 'pg_advisory_xact_lock(4810001, pg_catalog.hashtext(p_organization_id::text || '':'' || ') > 0)::text,
                     ',' order by p.proname)
     from pg_proc p
    where p.oid in ('public.supplier_risk_draft_save(uuid, uuid, text, jsonb)'::regprocedure,
                    'public.supplier_risk_finalise(uuid, uuid, text, jsonb, date, text, text, jsonb)'::regprocedure,
                    'public.supplier_risk_draft_discard(uuid, uuid)'::regprocedure,
                    'public.supplier_risk_item_update(uuid, uuid, text, uuid, date, text, text)'::regprocedure)),
  'supplier_risk_draft_discard:true,supplier_risk_draft_save:true,supplier_risk_finalise:true,supplier_risk_item_update:true',
  '0481/131: M1: the supplier''s lock is keyed by the organization and the supplier id, never the id alone');

-- M2. The leaver's item (0481/86 to 0481/88): its owner's account is gone,
-- its owner's name kept.
select i.id as item_leaver from public.supplier_risk_items i join public.supplier_risk_reviews r on r.id = i.review_id
 where r.supplier_id = 'a0481000-0000-0000-0000-0000000000fb' \gset
create function pg_temp.owner_after(p text) returns text language sql as $f$
  select case when p like 'ERR %' then p
              else (p::jsonb ->> 'status') || ':' || coalesce(p::jsonb ->> 'owner_user_id', 'none') || ':' || coalesce(p::jsonb ->> 'owner_name', 'none') end
$f$;
select is(
  array[pg_temp.owner_after(pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'in_progress', null, null, null)::text$$,
          :'orgA', :'item_leaver'))),
        pg_temp.owner_after(pg_temp.as_user(:'ownerA', format($$select public.supplier_risk_item_update(%L, %L, 'done', null, null, 'Moved to the new owner.')::text$$,
          :'orgA', :'item_leaver'))),
        pg_temp.owner_after(pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'open', %L, null, null)::text$$,
          :'orgA', :'item_leaver', :'adminA'))),
        pg_temp.owner_after(pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'open', null, null, null)::text$$,
          :'orgA', :'item_leaver')))],
  array['in_progress:none:Made-up Leaver', 'done:none:Made-up Leaver', 'open:' || :'adminA' || ':Made-up Admin A', 'open:none:none'],
  '0481/132: M2: the name kept for an owner whose account was deleted stays through changes of status and action, until a new owner is named; an owner taken off takes the name');

-- S1. The name as reviewed, and whether today's differs.
select pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb, null, null, null, %L::jsonb)::text$$,
  :'orgA', :'supN1', pg_temp.answers('staff', '{"insurance": "no"}'), pg_temp.items('staff', '{"insurance": "no"}', :'adminA'))) as fin_n1 \gset
select pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb)::text$$,
  :'orgA', :'supN2', pg_temp.answers('staff'))) as fin_n2 \gset
update public.suppliers set name = 'Name After Co' where id = :'supN1';
select is(
  array[pg_temp.as_user(:'adminA', format($$select g.supplier_name || ':' || g.reviewed_as_name || ':' || g.name_changed
                                              from public.supplier_risk_register(%L) g where g.supplier_id = %L$$, :'orgA', :'supN1')),
        pg_temp.as_user(:'adminA', format($$select g.supplier_name || ':' || g.reviewed_as_name || ':' || g.name_changed
                                              from public.supplier_risk_register(%L) g where g.supplier_id = %L$$, :'orgA', :'supN2')),
        pg_temp.as_user(:'adminA', format($$select x.supplier_name || ':' || x.reviewed_as_name || ':' || x.name_changed
                                              from public.supplier_risk_items_for_organization(%L) x where x.supplier_id = %L$$, :'orgA', :'supN1')),
        pg_temp.as_user(:'adminA', format($$select coalesce(g.reviewed_as_name, 'none') || ':' || g.name_changed
                                              from public.supplier_risk_register(%L) g where g.supplier_id = %L$$, :'orgA', :'supH3')),
        pg_temp.as_user(:'adminA', format($$select g.supplier_name || ':' || g.reviewed_as_name || ':' || g.name_changed
                                              from public.supplier_risk_register(%L) g where g.supplier_id = %L$$, :'orgA', :'supS2'))],
  array['Name After Co:Name Before Co:true', 'Name Kept Co:Name Kept Co:false', 'Name After Co:Name Before Co:true', 'none:false',
        'Holes New Name Co:Holes New Name Co:false'],
  '0481/133: S1: the register and the items list give the supplier''s name as reviewed beside today''s and say when it changed (not for a supplier with only a draft, or a deleted one)');

-- S2. Who changed an item last, and who accepted a risk and why.
select pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb, null, null, null, %L::jsonb)::text$$,
  :'orgA', :'supU1', pg_temp.answers('staff', '{"insurance": "no", "hosting_known": "no"}'),
  pg_temp.items('staff', '{"insurance": "no", "hosting_known": "no"}', :'adminA'))) as fin_u1 \gset
select i.id as item_u1 from public.supplier_risk_items i
 where i.review_id = (pg_temp.j(:'fin_u1') ->> 'review_id')::uuid and i.question_key = 'insurance' \gset
select is(
  (select string_agg(i.question_key || ':' || i.changed_by::text || ':' || i.changed_by_name || ':' || (i.changed_at = now())::text
                     || ':' || coalesce(i.accepted_by_name, 'none') || ':' || coalesce(i.accepted_reason, 'none'), ',' order by i.question_key)
     from public.supplier_risk_items i where i.review_id = (pg_temp.j(:'fin_u1') ->> 'review_id')::uuid),
  'hosting_known:' || :'adminA' || ':Made-up Admin A:true:none:none,insurance:' || :'adminA' || ':Made-up Admin A:true:none:none',
  '0481/134: S2: an item written with its review names who finished it as who changed it last, and when');
select (select array_agg(pg_temp.as_user(:'ownerA', format($$select public.supplier_risk_item_update(%L, %L, %L, %L, null, null, %L)::text$$,
                                                          :'orgA', :'item_u1', t.st, :'adminA', t.why)) order by t.n)
           from (values (1, 'accepted', null::text), (2, 'accepted', 'Too short to count'), (3, 'accepted', repeat('z', 40)),
                        (4, 'accepted', '                         '), (5, 'done', 'The vendor sent the certificate today.'),
                        (6, 'in_progress', 'The vendor sent the certificate today.')) t(n, st, why))::text as u1_refused \gset
select is(
  array[:'u1_refused',
        (select i.status || ':' || i.changed_by_name from public.supplier_risk_items i where i.id = :'item_u1')],
  array[array_fill('ERR 22023 bad_item_reason hint=bad_item_reason'::text, array[6])::text, 'open:Made-up Admin A'],
  '0481/135: S2: accepting a risk needs a reason by the reason rule (20 characters or more, not one character repeated, not blank); a reason with any other status is refused; nothing changes');
-- The last change a day ago, so a change that kept the time would show.
update public.supplier_risk_items set changed_at = now() - interval '1 day' where id = :'item_u1';
select pg_temp.as_user(:'acceptor', format($$select public.supplier_risk_item_update(%L, %L, 'accepted', %L, null, null, %L)::text$$,
  :'orgA', :'item_u1', :'adminA', 'Cover renews in May; we accept the gap until then.')) as acc_u1 \gset
select is(
  array[pg_temp.j(:'acc_u1') ->> 'status', pg_temp.j(:'acc_u1') ->> 'accepted_by', pg_temp.j(:'acc_u1') ->> 'accepted_by_name',
        pg_temp.j(:'acc_u1') ->> 'accepted_reason', pg_temp.j(:'acc_u1') ->> 'changed_by', pg_temp.j(:'acc_u1') ->> 'changed_by_name',
        ((pg_temp.j(:'acc_u1') ->> 'changed_at')::timestamptz = now())::text],
  array['accepted', :'acceptor', 'Made-up Acceptor', 'Cover renews in May; we accept the gap until then.', :'acceptor', 'Made-up Acceptor', 'true'],
  '0481/136: S2: a risk accepted records who accepted it (the account and the name) and why, and who changed the item last');
delete from auth.users where id = :'acceptor';
select is(
  array[(select coalesce(i.accepted_by::text, 'none') || ':' || i.accepted_by_name || ':' || coalesce(i.changed_by::text, 'none') || ':' || i.changed_by_name
           from public.supplier_risk_items i where i.id = :'item_u1'),
        (select (x.j ->> 'status') || ':' || coalesce(x.j ->> 'accepted_by', 'none') || ':' || (x.j ->> 'accepted_by_name') || ':'
                || (x.j ->> 'accepted_reason') || ':' || (x.j ->> 'changed_by_name') || ':' || ((x.j ->> 'due_on')::date - pg_temp.today(:'orgA'))
           from (select pg_temp.j(pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'accepted', %L, %L::date, null)::text$$,
                   :'orgA', :'item_u1', :'adminA', pg_temp.today(:'orgA') + 20))) j) x),
        (select (x.j ->> 'status') || ':' || (x.j ->> 'accepted_by') || ':' || (x.j ->> 'accepted_by_name') || ':' || (x.j ->> 'accepted_reason')
           from (select pg_temp.j(pg_temp.as_user(:'ownerA', format($$select public.supplier_risk_item_update(%L, %L, 'accepted', %L, null, null, %L)::text$$,
                   :'orgA', :'item_u1', :'adminA', 'Accepted again: the vendor moved the renewal to June.'))) j) x),
        (select (x.j ->> 'status') || ':' || coalesce(x.j ->> 'accepted_by', 'none') || ':' || coalesce(x.j ->> 'accepted_by_name', 'none') || ':'
                || coalesce(x.j ->> 'accepted_reason', 'none') || ':' || (x.j ->> 'closed_at' is not null)::text
           from (select pg_temp.j(pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'done', %L, null, null)::text$$,
                   :'orgA', :'item_u1', :'adminA'))) j) x)],
  array['none:Made-up Acceptor:none:Made-up Acceptor',
        'accepted:none:Made-up Acceptor:Cover renews in May; we accept the gap until then.:Made-up Admin A:20',
        'accepted:' || :'ownerA' || ':Made-up Owner A:Accepted again: the vendor moved the renewal to June.',
        'done:none:none:none:true'],
  '0481/137: S2: an account deleted keeps the names of who accepted and who changed; another change while accepted keeps who accepted and why; a new reason names its giver; leaving accepted clears them');
select is(
  array[pg_temp.try(format($$update public.supplier_risk_items set status = 'accepted', closed_at = now() where id = %L$$, :'item_u1')),
        pg_temp.try(format($$update public.supplier_risk_items set status = 'accepted', closed_at = now(),
                                     accepted_reason = 'A reason long enough to keep.' where id = %L$$, :'item_u1')),
        pg_temp.try(format($$update public.supplier_risk_items set status = 'accepted', closed_at = now(), accepted_by_name = 'X',
                                     accepted_reason = 'Too short' where id = %L$$, :'item_u1')),
        pg_temp.try(format($$update public.supplier_risk_items set accepted_by_name = 'X', accepted_reason = 'A reason long enough to keep.' where id = %L$$, :'item_u1')),
        pg_temp.try(format($$update public.supplier_risk_items set accepted_by = %L where id = %L$$, :'adminA', :'item_u1')),
        pg_temp.try(format($$update public.supplier_risk_items set status = 'accepted', closed_at = now(), accepted_by_name = 'X',
                                     accepted_reason = 'A reason long enough to keep.' where id = %L$$, :'item_u1')),
        (select string_agg(a.attname::text, ',' order by a.attnum) from pg_attribute a
          where a.attrelid = 'public.supplier_risk_items'::regclass and a.attnotnull
            and a.attname in ('changed_by', 'changed_by_name', 'changed_at', 'accepted_by', 'accepted_by_name', 'accepted_reason'))],
  array['23514:supplier_risk_items_accepted', '23514:supplier_risk_items_accepted', '23514:supplier_risk_items_accepted',
        '23514:supplier_risk_items_accepted', '23514:supplier_risk_items_accepted', 'ok', 'changed_by_name,changed_at'],
  '0481/138: S2: the items table holds it on its own: accepted exactly with a reason (the reason rule) and a name of who accepted it, a link only with the name, and who changed it last always named, with when');
select is(
  array[pg_temp.as_user(:'adminA', format($$select string_agg(x.question_key || ':' || x.changed_by_name || ':' || (x.changed_at = now())::text || ':'
                                                              || coalesce(x.accepted_by_name, 'none'), ',' order by x.question_key)
                                              from public.supplier_risk_items_for_organization(%L, false) x where x.supplier_id = %L$$, :'orgA', :'supU1')),
        (select string_agg(k, ',' order by k)
           from jsonb_object_keys((pg_temp.j(pg_temp.as_user(:'adminA', format($$select public.supplier_risk_review(%L, %L)::text$$,
                  :'orgA', pg_temp.j(:'fin_u1') ->> 'review_id'))) -> 'items') -> 0) k)],
  array['hosting_known:Made-up Admin A:true:none,insurance:Made-up Admin A:true:none',
        'accepted_by,accepted_by_name,accepted_reason,action,answer,changed_at,changed_by,changed_by_name,closed_at,created_at,due_on,'
        'finding,id,owner_is_admin,owner_name,owner_user_id,question_key,review_id,severity,status,updated_at'],
  '0481/139: S2: the reads give who changed each item last and when, and who accepted it and why');

-- S4. An item's owner is an owner or admin when named; the reads say when an
-- owner no longer is.
select pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb, null, null, null, %L::jsonb)::text$$,
  :'orgA', :'supO1', pg_temp.answers('staff', '{"insurance": "no"}'), pg_temp.items('staff', '{"insurance": "no"}', :'demoted'))) as fin_o1 \gset
select i.id as item_o1 from public.supplier_risk_items i where i.review_id = (pg_temp.j(:'fin_o1') ->> 'review_id')::uuid \gset
update public.organization_members set role = 'manager' where organization_id = :'orgA' and user_id = :'demoted';
select is(
  array[pg_temp.j(:'fin_o1') ->> 'items',
        (select string_agg((e ->> 'owner_name') || ':' || (e ->> 'owner_is_admin'), ',')
           from jsonb_array_elements((pg_temp.j(pg_temp.as_user(:'adminA', format($$select public.supplier_risk_review(%L, %L)::text$$,
                  :'orgA', pg_temp.j(:'fin_o1') ->> 'review_id')))) -> 'items') e),
        pg_temp.as_user(:'adminA', format($$select x.owner_name || ':' || x.owner_is_admin from public.supplier_risk_items_for_organization(%L) x where x.supplier_id = %L$$,
          :'orgA', :'supO1')),
        (select (x.j ->> 'status') || ':' || (x.j ->> 'owner_name') || ':' || (x.j ->> 'owner_is_admin')
           from (select pg_temp.j(pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'in_progress', %L, null, null)::text$$,
                   :'orgA', :'item_o1', :'demoted'))) j) x),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'in_progress', %L, null, null)::text$$, :'orgA', :'item_o1', :'managerA'))],
  array['1', 'Made-up Demoted Admin:false', 'Made-up Demoted Admin:false', 'in_progress:Made-up Demoted Admin:false',
        'ERR 22023 item_owner_not_an_admin hint=item_owner_not_an_admin'],
  '0481/140: S4: an admin named owner who becomes a manager is shown as no longer an owner or admin, may stay owner while the status changes, and a manager may not be named');

-- S6. A live support (act-as) seat reads, and never writes.
select array[pg_temp.as_user(:'actas', format($$select public.supplier_risk_draft_save(%L, %L, 'none', '{}')::text$$, :'orgA', :'supS6')),
        pg_temp.as_user(:'actas', format($$select public.supplier_risk_finalise(%L, %L, 'student', %L::jsonb, null, 'approve', %L, %L::jsonb)::text$$,
          :'orgA', :'supS6', pg_temp.answers('student', '{"data_agreement": "no"}'), 'Support says this vendor is fine for now.',
          pg_temp.items('student', '{"data_agreement": "no"}'))),
        pg_temp.as_user(:'actas', format($$select public.supplier_risk_draft_discard(%L, %L)::text$$, :'orgA', :'supH3')),
        pg_temp.as_user(:'actas', format($$select public.supplier_risk_item_update(%L, %L, 'accepted', %L, null, null, %L)::text$$,
          :'orgA', :'item_o1', :'demoted', 'Support accepts this risk for the school.'))]::text as s6_writes \gset
select is(
  array[:'s6_writes',
        (select count(*)::text from public.supplier_risk_reviews r where r.supplier_id = :'supS6'),
        (select count(*)::text from public.supplier_risk_reviews r where r.supplier_id = :'supH3' and r.status = 'draft'),
        (select i.status from public.supplier_risk_items i where i.id = :'item_o1'),
        (pg_temp.j(pg_temp.as_user(:'actas', format($$select public.supplier_risk_review(%L, %L)::text$$, :'orgA', pg_temp.j(:'fin_o1') ->> 'review_id'))) ->> 'status')],
  array[array_fill('ERR 42501 supplier_risk_act_as_read_only hint=supplier_risk_act_as_read_only'::text, array[4])::text,
        '0', '1', 'in_progress', 'final'],
  '0481/141: S6: a live support seat may not save or discard a draft, finish a review, override a result or accept a risk (each refused, nothing changed), and may read');
select is(
  (select string_agg(p.proname || ':' || (strpos(p.prosrc, 'if public._supplier_risk_caller_is_act_as(p_organization_id) then') > 0
            and strpos(p.prosrc, 'if public._supplier_risk_caller_is_act_as(p_organization_id) then')
                > strpos(p.prosrc, 'perform public.security_events_reader_check(p_organization_id)')
            and strpos(p.prosrc, 'if public._supplier_risk_caller_is_act_as(p_organization_id) then')
                < coalesce(nullif(strpos(p.prosrc, 'pg_advisory_xact_lock'), 0), 0))::text, ',' order by p.proname)
     from pg_proc p join vr_fns f on f.fn = p.oid
    where f.kind in ('admin_read', 'admin_write')),
  'supplier_risk_draft_discard:true,supplier_risk_draft_save:true,supplier_risk_finalise:true,supplier_risk_history:false,'
  'supplier_risk_item_update:true,supplier_risk_items_for_organization:false,supplier_risk_register:false,supplier_risk_review:false',
  '0481/142: S6: each of the four writes refuses a support seat right after the authenticator check, before it takes the supplier''s lock; no read does');

-- Q4. The thresholds and the dates.
select is(
  array[(select count(*)::int from public._supplier_risk_questions() q where q.student_only and q.hard_stop is null),
        (select count(*)::int from public._supplier_risk_questions() q where q.hard_stop is not null)],
  array[0, 7],
  '0481/143: Q4: every Student data question is a hard-stop question (so Not shown on any of them is More information needed), seven in all');
select is(
  (with q as (select key, ord from public._supplier_risk_questions() where not student_only),
        a as (select x, jsonb_object_agg(q.key, jsonb_build_object('answer', (array['yes', 'no', 'not_shown'])[((x / power(3, q.ord - 1)::int) % 3) + 1])) as ans
                from generate_series(0, 19682) x cross join q group by x)
   select count(*)::text || ':' || count(*) filter (
            where (jsonb_array_length(e -> 'gaps') > 3 and e ->> 'result' <> 'more_information')
               or ((jsonb_array_length(e -> 'gaps') = 0) <> (e ->> 'result' = 'approve'))
               or (e ->> 'result' = 'approve_with_conditions' and jsonb_array_length(e -> 'gaps') not between 1 and 3))::text
     from a, lateral public._supplier_risk_evaluate(1::smallint, 'staff', a.ans, null) e),
  '19683:0',
  '0481/144: Q4: of all 19,683 staff answer sets, Approve is exactly the ones with no gap, and more than three gaps is never Approve with conditions (More information needed)');
select is(
  (select count(*)::text || ':' || count(*) filter (
            where e ->> 'result' is distinct from case when a.has_no then 'do_not_use' when a.has_ns then 'more_information' else 'approve' end)::text
     from (select x, jsonb_object_agg(q.key, (array['yes', 'no', 'not_shown'])[((x / power(3, q.n - 1)::int) % 3) + 1]) as over,
                  bool_or(((x / power(3, q.n - 1)::int) % 3) = 1) as has_no, bool_or(((x / power(3, q.n - 1)::int) % 3) = 2) as has_ns
             from generate_series(0, 2186) x
            cross join (select q.key, (row_number() over (order by q.ord))::int as n
                          from public._supplier_risk_questions() q where q.hard_stop is not null) q
            group by x) a,
          lateral public._supplier_risk_evaluate(1::smallint, 'student', pg_temp.answers('student', a.over), null) e),
  '2187:0',
  '0481/145: Q4: with student data, every mix of the seven hard-stop answers (the rest Yes): a No is Do not use, else a Not shown is More information needed, else Approve');
select is(
  array[public._supplier_risk_evaluate(1::smallint, 'staff', pg_temp.answers('staff', '{"insurance": "yes@2023-02-28"}', date '2024-02-29'), date '2024-02-29') ->> 'result',
        public._supplier_risk_evaluate(1::smallint, 'staff', pg_temp.answers('staff', '{"insurance": "yes@2023-02-27"}', date '2024-02-29'), date '2024-02-29') ->> 'out_of_date',
        public._supplier_risk_evaluate(1::smallint, 'staff', pg_temp.answers('staff', '{"insurance": "yes@2001-01-01"}', null), null) ->> 'result',
        public._supplier_risk_evaluate(1::smallint, 'staff', pg_temp.answers('staff', '{"security_report": "yes@2025-03-31"}', date '2026-03-31'), date '2026-03-31') ->> 'result',
        public._supplier_risk_evaluate(1::smallint, 'staff', pg_temp.answers('staff', '{"security_report": "yes@2025-03-30"}', date '2026-03-31'), date '2026-03-31') ->> 'evidence'],
  array['approve', '["insurance"]', 'approve', 'approve', 'insufficient'],
  '0481/146: Q4: a dated Yes is out of date when it is more than 12 months before the review day (a month''s last day where the day does not exist); with no review day nothing is judged');
select jsonb_build_object('security_report', 'yes@' || to_char(pg_temp.today(:'orgA') - 800, 'YYYY-MM-DD'))::text as over_t1 \gset
select pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb, null, null, null, '[]')::text$$,
  :'orgA', :'supT1', pg_temp.answers('staff', :'over_t1'::jsonb))) as fin_t1_bad \gset
select pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb, null, null, null, %L::jsonb)::text$$,
  :'orgA', :'supT1', pg_temp.answers('staff', :'over_t1'::jsonb),
  pg_temp.items('staff', :'over_t1'::jsonb, :'adminA', null, pg_temp.today(:'orgA')))) as fin_t1 \gset
select is(
  array[:'fin_t1_bad',
        (pg_temp.j(:'fin_t1') ->> 'result') || ':' || (pg_temp.j(:'fin_t1') ->> 'evidence') || ':' || (pg_temp.j(:'fin_t1') ->> 'out_of_date')
        || ':' || (pg_temp.j(:'fin_t1') ->> 'items'),
        (select string_agg(i.question_key || ':' || i.answer || ':' || i.severity, ',') from public.supplier_risk_items i
           join public.supplier_risk_reviews r on r.id = i.review_id where r.supplier_id = :'supT1'),
        (select (r.reviewed_on = pg_temp.today(:'orgA'))::text || ':' || r.rules_version from public.supplier_risk_reviews r where r.supplier_id = :'supT1'),
        (select string_agg((r.reviewed_on = pg_temp.today(r.organization_id))::text, ',' order by r.supplier_id)
           from public.supplier_risk_reviews r where r.supplier_id in (:'supZ3', :'supW3') and r.status = 'final')],
  array['ERR 22023 items_do_not_match_answers hint=items_do_not_match_answers', 'more_information:insufficient:["security_report"]:1',
        'security_report:out_of_date:medium', 'true:1', 'true,true'],
  '0481/147: Q4: a security report dated more than 12 months before the review counts as Not shown: the finish needs its item, which says it is out of date, and the review keeps its day (the organization''s own: Z and W of 0481/111 too) and rules version');
select is(
  (select array_agg(pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version, status,
          is_current, data_level, answers, starting_risk, evidence, residual_risk, hard_stops, computed_result, reviewer_name, reviewed_at,
          reviewed_on, next_review_on)
          values (%L, %L, 'X', 1, 'final', true, 'staff', %L, 'moderate', %L, %L, '{}', %L, 'X', %L, %L, %L)$$,
          :'orgA', gen_random_uuid(), pg_temp.answers('staff', '{"security_report": "yes@2020-01-01", "insurance": "yes@2020-01-01"}'), t.ev, t.left_risk, t.res,
          t.day::timestamptz, t.day, t.day + 365)) order by t.n)
     from (values (1, date '2020-06-01', 'strong', 'low', 'approve'), (2, date '2021-06-01', 'strong', 'low', 'approve'),
                  (3, date '2021-06-01', 'insufficient', 'moderate', 'more_information')) t(n, day, ev, left_risk, res)),
  array['ok', '23514:supplier_risk_reviews_computed', 'ok'],
  '0481/148: Q4: a stored result is the rules (its version) applied on its own review day: the same dated answers are Approve on one day and More information needed a year on');

-- Q7. The due reminder's second chance. All five are due today or past;
-- one first claimed 25 hours ago, one 23 hours ago, one never, one 30 hours
-- ago (it will be confirmed), one claimed twice already.
select pg_temp.final_row(:'revQ1', :'orgA', :'supQ1', 1, true, pg_temp.today(:'orgA'), now() - interval '1 year', null, now() - interval '25 hours');
select pg_temp.final_row(:'revQ2', :'orgA', :'supQ2', 1, true, pg_temp.today(:'orgA'), now() - interval '1 year', null, now() - interval '23 hours');
select pg_temp.final_row(:'revQ3', :'orgA', :'supQ3', 1, true, pg_temp.today(:'orgA') - 2, now() - interval '1 year');
select pg_temp.final_row(:'revQ4', :'orgA', :'supQ4', 1, true, pg_temp.today(:'orgA'), now() - interval '1 year', null, now() - interval '30 hours');
select pg_temp.final_row(:'revQ5', :'orgA', :'supQ5', 1, true, pg_temp.today(:'orgA'), now() - interval '1 year', null, now() - interval '50 hours');
update public.supplier_risk_reviews set reminded_due_retry_at = now() - interval '25 hours' where id = :'revQ5';
-- And two first claimed 25 hours ago that are no longer to be reminded: an
-- earlier version (superseded), and the review of a supplier since archived.
select pg_temp.final_row(:'revQ6', :'orgA', :'supQ6', 1, false, pg_temp.today(:'orgA'), now() - interval '2 years', null, now() - interval '25 hours');
select pg_temp.final_row(:'revQ6b', :'orgA', :'supQ6', 2, true, pg_temp.today(:'orgA') + 200, now() - interval '1 year');
select pg_temp.final_row(:'revQ7', :'orgA', :'supQ7', 1, true, pg_temp.today(:'orgA'), now() - interval '1 year', null, now() - interval '25 hours');
update public.suppliers set deleted_at = now() where id = :'supQ7';
select array[pg_temp.run_as('service_role', null, format($$select public.supplier_risk_due_reminder_sent(%L)::text$$, :'revQ4')),
        pg_temp.run_as('service_role', null, format($$select public.supplier_risk_due_reminder_sent(%L)::text$$, :'revQ4')),
        pg_temp.run_as('service_role', null, format($$select public.supplier_risk_due_reminder_sent(%L)::text$$, :'revQ3')),
        pg_temp.run_as('service_role', null, $$select public.supplier_risk_due_reminder_sent(null)::text$$),
        pg_temp.run_as('service_role', null, $$select public.supplier_risk_due_reminder_sent('a0481000-0000-0000-0000-00000000dead')::text$$)]::text
  as q7_sent \gset
select is(
  array[:'q7_sent',
        (select (reminded_due_sent_at = now())::text from public.supplier_risk_reviews where id = :'revQ4'),
        (select coalesce(reminded_due_sent_at::text, 'none') from public.supplier_risk_reviews where id = :'revQ3')],
  array['{true,false,false,false,false}', 'true', 'none'],
  '0481/149: Q7: the job confirms a due reminder it sent, once (true once); never one not claimed, none or an unknown review');
select is(
  pg_temp.run_as('service_role', null, format($$select string_agg(d.supplier_name || ':' || d.kind || ':' || d.attempt, ',' order by d.supplier_name)
                                                  from public.supplier_risk_reminders_due(500) d where d.supplier_id in (%L, %L, %L, %L, %L, %L, %L)$$,
                                              :'supQ1', :'supQ2', :'supQ3', :'supQ4', :'supQ5', :'supQ6', :'supQ7')),
  'Second Chance Never:due:1,Second Chance Old:due:2',
  '0481/150: Q7: a due reminder claimed more than 24 hours ago and never confirmed is offered once more (attempt 2); not one claimed 23 hours ago, one confirmed, one offered twice already, an earlier version or an archived supplier''s');
select array[pg_temp.run_as('service_role', null, format($$select public.supplier_risk_reminder_claim(%L, 'due')::text$$, :'revQ1')),
        pg_temp.run_as('service_role', null, format($$select public.supplier_risk_reminder_claim(%L, 'due')::text$$, :'revQ1')),
        pg_temp.run_as('service_role', null, format($$select public.supplier_risk_reminder_claim(%L, 'due')::text$$, :'revQ2')),
        pg_temp.run_as('service_role', null, format($$select public.supplier_risk_reminder_claim(%L, 'due')::text$$, :'revQ4')),
        pg_temp.run_as('service_role', null, format($$select public.supplier_risk_reminder_claim(%L, 'due')::text$$, :'revQ5')),
        pg_temp.run_as('service_role', null, format($$select public.supplier_risk_reminder_claim(%L, 'due')::text$$, :'revQ3')),
        pg_temp.run_as('service_role', null, format($$select public.supplier_risk_reminder_claim(%L, 'due')::text$$, :'revQ6')),
        pg_temp.run_as('service_role', null, format($$select public.supplier_risk_reminder_claim(%L, 'due')::text$$, :'revQ7'))]::text
  as q7_claims \gset
select is(
  array[:'q7_claims',
        (select (reminded_due_retry_at = now())::text || ':' || (reminded_due_at = now() - interval '25 hours')::text
           from public.supplier_risk_reviews where id = :'revQ1'),
        (select (reminded_due_at = now())::text || ':' || coalesce(reminded_due_retry_at::text, 'none') from public.supplier_risk_reviews where id = :'revQ3'),
        pg_temp.run_as('service_role', null, format($$select coalesce(string_agg(d.supplier_name, ','), 'none')
                                                         from public.supplier_risk_reminders_due(500) d where d.supplier_id in (%L, %L, %L, %L, %L)$$,
                                                     :'supQ1', :'supQ2', :'supQ3', :'supQ4', :'supQ5'))],
  array['{true,false,false,false,false,true,false,false}', 'true:true', 'true:none', 'none'],
  '0481/151: Q7: the second claim stamps once beside the first claim''s time, and is false for one claimed 23 hours ago, one confirmed, one claimed twice, an earlier version and an archived supplier''s; then none is offered');
select is(
  pg_temp.as_user(:'adminA', format($$select string_agg(g.supplier_name || ':' || coalesce(g.due_reminder, 'none'), ',' order by g.supplier_name)
                                        from public.supplier_risk_register(%L) g where g.supplier_id in (%L, %L, %L, %L, %L, %L, %L)$$,
                                     :'orgA', :'supQ1', :'supQ2', :'supQ3', :'supQ4', :'supQ5', :'supR4', :'supS6')),
  'Reminder In Thirty One:none,Second Chance Confirmed:sent,Second Chance Never:claimed,Second Chance Old:claimed,'
  'Second Chance Recent:claimed,Second Chance Spent:not_sent,Support Seat Co:none',
  '0481/152: Q7: the register shows the due reminder: none yet, claimed, sent, or not sent (claimed twice and not confirmed 24 hours after the second claim)');
select is(
  array[pg_temp.run_as('service_role', null, format($$select public.supplier_risk_due_reminder_sent(%L)::text$$, :'revQ1')),
        pg_temp.as_user(:'adminA', format($$select g.due_reminder from public.supplier_risk_register(%L) g where g.supplier_id = %L$$, :'orgA', :'supQ1')),
        pg_temp.try(format($$update public.supplier_risk_reviews set reminded_due_retry_at = now() where id = %L$$, :'revQ5')),
        pg_temp.try(format($$update public.supplier_risk_reviews set reminded_due_retry_at = null where id = %L$$, :'revQ5')),
        pg_temp.try(format($$update public.supplier_risk_reviews set reminded_due_sent_at = null where id = %L$$, :'revQ4')),
        pg_temp.try(format($$update public.supplier_risk_reviews set reminded_due_sent_at = now() + interval '1 hour' where id = %L$$, :'revQ4')),
        pg_temp.try($$update public.supplier_risk_reviews set reminded_due_sent_at = now() where id = 'a0481000-0000-0000-0000-000000000104'$$),
        pg_temp.try($$update public.supplier_risk_reviews set reminded_due_retry_at = now() where id = 'a0481000-0000-0000-0000-000000000104'$$)],
  array['true', 'sent', '55000:supplier_risk_final_is_kept', '55000:supplier_risk_final_is_kept', '55000:supplier_risk_final_is_kept',
        '55000:supplier_risk_final_is_kept', '23514:supplier_risk_reviews_due_reminder', '23514:supplier_risk_reviews_due_reminder'],
  '0481/153: Q7: a reminder confirmed after its second claim shows as sent; the second claim and the confirmation are each stamped once, never moved or cleared, and only after a claim');
select is(
  (select count(*)::int from pg_proc p
    where p.oid = 'public.supplier_risk_reminder_claim(uuid, text)'::regprocedure
      and p.prosrc ~ 'reminded_due_retry_at = pg_catalog\.now\(\)\s+where r\.id = p_review_id\s+and r\.is_current\s+and r\.reminded_due_retry_at is null\s+and r\.reminded_due_sent_at is null\s+and r\.reminded_due_at < pg_catalog\.now\(\) - interval ''24 hours''')
  + (select count(*)::int from pg_proc p
      where p.oid = 'public.supplier_risk_due_reminder_sent(uuid)'::regprocedure
        and p.prosrc ~ 'reminded_due_sent_at = pg_catalog\.now\(\)\s+where r\.id = p_review_id\s+and r\.reminded_due_at is not null\s+and r\.reminded_due_sent_at is null'
        and 'lock_timeout=2s' = any (p.proconfig)),
  2,
  '0481/154: Q7: the second claim and the confirmation are each one guarded update (the stamp still empty when the row lock is had), with a 2 s lock wait');

-- M1, the finish both ways (0481/155): B finishes M2 while A still holds a
-- draft of that id, and A finishes its own draft of M4 while B still holds one.
select pg_temp.as_user(:'adminB', format($$select public.supplier_risk_finalise(%L, %L, 'none', '{}')::text$$, :'orgB', :'supM2')) as m_b2_fin \gset
select pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'none', '{}')::text$$, :'orgA', :'supM4')) as m_a4_fin \gset
select is(
  array[coalesce(pg_temp.j(:'m_b2_fin') ->> 'version', pg_temp.j(:'m_b2_fin') ->> 'err'),
        coalesce(pg_temp.j(:'m_a4_fin') ->> 'version', pg_temp.j(:'m_a4_fin') ->> 'err'),
        ((pg_temp.j(:'m_a4_fin') ->> 'review_id') = (pg_temp.j(:'m_a4') ->> 'review_id'))::text,
        (select string_agg((r.organization_id = :'orgA')::text || ':' || r.status || ':' || r.is_current::text, ','
                           order by r.organization_id = :'orgA', r.status)
           from public.supplier_risk_reviews r where r.supplier_id = :'supM2'),
        (select string_agg((r.organization_id = :'orgA')::text || ':' || r.status || ':' || r.is_current::text, ','
                           order by r.organization_id = :'orgA', r.status)
           from public.supplier_risk_reviews r where r.supplier_id = :'supM4')],
  array['1', '1', 'true', 'false:final:true,true:draft:false', 'false:draft:false,true:final:true'],
  '0481/155: M1, the finish both ways: B finishing an id that A holds a draft of makes B''s own version 1 and leaves A''s draft; A finishing its own draft of an id that B holds a draft of finishes A''s alone and leaves B''s');

-- ── 13. The review of ccbf4d094 (round 2): R2-S1 and R2-S2 ──────────────────
-- R2-S1: no stored text holds a hidden character (one list, the same as
-- core's), a reason is counted over what can be seen, the names the
-- functions copy are kept as plain text, and an account deletion (whose SET
-- NULL runs the tables' checks again) succeeds for rows holding texts at the
-- edges of the rules. R2-S2: a Yes on the security report or the insurance
-- needs its date, and a date there later than tomorrow in UTC is refused.
\set ownerHid 'a0481000-0000-0000-0000-0000000000d8'
\set onlyHid 'a0481000-0000-0000-0000-0000000000d9'
\set supV1 'a0481000-0000-0000-0000-000000000501'
\set supV2 'a0481000-0000-0000-0000-000000000502'
\set supV3 'a0481000-0000-0000-0000-000000000503'
\set supV4 'a0481000-0000-0000-0000-000000000504'
\set supV5 'a0481000-0000-0000-0000-000000000505'
\set supV6 'a0481000-0000-0000-0000-000000000506'
\set supZ4 'a0481000-0000-0000-0000-000000000507'
\set supW4 'a0481000-0000-0000-0000-000000000508'
-- A made-up admin whose full name holds hidden characters and runs of
-- spaces, and one whose full name is nothing but hidden characters.
insert into auth.users (id, email, raw_user_meta_data) values
  (:'ownerHid', 'vr-hidden-owner@test.local',
   jsonb_build_object('full_name', 'Made-up' || chr(173) || '   Hidden' || chr(8288) || ' ' || chr(9) || 'Owner')),
  (:'onlyHid', 'vr-only-hidden@test.local', jsonb_build_object('full_name', chr(12644) || chr(8203) || chr(12644)));
insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at) values
  (:'orgA', :'ownerHid', 'admin', now(), null),
  (:'orgA', :'onlyHid', 'admin', now(), null);
insert into public.suppliers (id, organization_id, name, deleted_at) values
  (:'supV1', :'orgA', 'Example' || chr(8203) || '  Ink' || chr(9) || chr(9) || 'Co' || chr(8238), null),
  (:'supV2', :'orgA', chr(12644) || chr(8203), null),
  (:'supV3', :'orgA', 'Deletion Edge Co',  null),
  (:'supV4', :'orgA', 'Refused Finish Co', null),
  (:'supV5', :'orgA', 'Edge Notes Co',     null),
  (:'supV6', :'orgA', 'Dated Finish Co',   null),
  (:'supZ4', :'orgZ', 'Island Dated Co',   null),
  (:'supW4', :'orgW', 'Western Dated Co',  null);

-- The two lists, as code point ranges (hexadecimal): vendor-risk.parity.test.ts
-- reads these same rows and holds core's VENDOR_RISK_HIDDEN_CHARACTERS and
-- VENDOR_RISK_SPACE_CHARACTERS, and the migration's two classes, to them.
create temporary table vr_chars (kind text, lo text, hi text) on commit drop;
-- VENDOR RISK CHARACTERS BEGIN
insert into vr_chars (kind, lo, hi) values
  ('hidden', '0001', '0008'),
  ('hidden', '000B', '000C'),
  ('hidden', '000E', '001F'),
  ('hidden', '007F', '009F'),
  ('hidden', '00AD', '00AD'),
  ('hidden', '034F', '034F'),
  ('hidden', '0600', '0605'),
  ('hidden', '061C', '061C'),
  ('hidden', '06DD', '06DD'),
  ('hidden', '070F', '070F'),
  ('hidden', '0890', '0891'),
  ('hidden', '08E2', '08E2'),
  ('hidden', '115F', '1160'),
  ('hidden', '17B4', '17B5'),
  ('hidden', '180B', '180F'),
  ('hidden', '200B', '200F'),
  ('hidden', '2028', '202E'),
  ('hidden', '2060', '206F'),
  ('hidden', '3164', '3164'),
  ('hidden', 'FE00', 'FE0F'),
  ('hidden', 'FEFF', 'FEFF'),
  ('hidden', 'FFA0', 'FFA0'),
  ('hidden', 'FFF0', 'FFFB'),
  ('hidden', '110BD', '110BD'),
  ('hidden', '110CD', '110CD'),
  ('hidden', '13430', '1343F'),
  ('hidden', '1BCA0', '1BCA3'),
  ('hidden', '1D173', '1D17A'),
  ('hidden', 'E0000', 'E0FFF'),
  ('space', '0009', '0009'),
  ('space', '000A', '000A'),
  ('space', '000D', '000D'),
  ('space', '0020', '0020'),
  ('space', '00A0', '00A0'),
  ('space', '1680', '1680'),
  ('space', '2000', '200A'),
  ('space', '202F', '202F'),
  ('space', '205F', '205F'),
  ('space', '3000', '3000');
-- VENDOR RISK CHARACTERS END
select is(
  (with tested as (select n from generate_series(1, 131071) n where n not between 55296 and 57343
                   union all select n from generate_series(917504, 983039) n
                   union all select p * 65536 + o from generate_series(2, 16) p, unnest(array[0, 65533]) o where p <> 14),
        listed as (select c.kind, generate_series(('x' || lpad(c.lo, 8, '0'))::bit(32)::int, ('x' || lpad(c.hi, 8, '0'))::bit(32)::int) as n
                     from vr_chars c),
        matched as (select 'hidden' as kind, t.n from tested t where chr(t.n) ~ public._supplier_risk_hidden_chars()
                    union all select 'space', t.n from tested t where chr(t.n) ~ public._supplier_risk_space_chars())
   select coalesce(string_agg(x.side || x.kind || ':' || to_hex(x.n), ',' order by x.kind, x.n), '')
     from ((select '+' as side, m.kind, m.n from matched m except select '+', l.kind, l.n from listed l)
           union all
           (select '-', l.kind, l.n from listed l except select '-', m.kind, m.n from matched m)) x),
  '',
  '0481/156: R2-S1: the hidden characters and the spaces are exactly the listed ranges, at every code point of planes 0, 1 and 14 (the only ones that hold them) and at the ends of every other plane');
select is(
  (select array_agg(public._supplier_risk_text_ok('Ab' || chr(c), 1, 20) order by c)
     from unnest(array[173, 847, 4447, 4448, 6158, 8288, 8289, 8290, 8291, 8292, 12644, 65440, 917504, 917505, 917569, 917631]) c),
  array_fill(false, array[16]),
  '0481/157: R2-S1: the text rule refuses each character the review found let through: U+00AD, U+034F, U+115F, U+1160, U+180E, U+2060 to U+2064, U+3164, U+FFA0, and the tag characters U+E0000, U+E0001, U+E0041, U+E007F');
select is(
  array[public._supplier_risk_text_ok(repeat(chr(160), 3), 1, 20), public._supplier_risk_text_ok(chr(12288) || chr(8239) || chr(9), 1, 20),
        public._supplier_risk_text_ok('a' || chr(160) || 'b', 1, 20), public._supplier_risk_text_ok('a' || chr(12288) || 'b', 1, 20)],
  array[false, false, true, true],
  '0481/158: R2-S1: a text of spaces of any kind (no-break, ideographic, narrow, tab) is blank; between words they are taken');
select is(
  (select array_agg(public._supplier_risk_reason_ok(t.s) order by t.n)
     from (values
       (1, 'a' || repeat(chr(8288), 19)),
       (2, 'a' || repeat(chr(173), 19)),
       (3, 'a' || repeat(chr(12644), 19)),
       (4, 'a' || repeat(chr(160), 19)),
       (5, 'abcde' || repeat(' ', 30)),
       (6, 'abcde fghij klmno pq'),
       (7, 'abcde fghij klmno p'),
       (8, 'abcde   fghij' || chr(9) || chr(9) || 'klmno' || chr(10) || chr(10) || 'p'),
       (9, 'abcde' || repeat(chr(160), 3) || 'fghij' || chr(9) || chr(9) || 'klmno' || chr(10) || chr(10) || 'pqrs'),
       (10, ' ' || chr(12288) || 'abcde fghij klmno pq' || chr(12288) || ' '),
       (11, 'ab   cd   ef   gh   ij'),
       (12, repeat('abcd', 5)),
       (13, repeat('abcde', 4)),
       (14, 'aaaaa bbbbb ccccc ddddd'),
       (15, 'aaaaa bbbbb ccccc ddddd e'),
       (16, repeat(chr(66560) || chr(66561) || chr(66562) || chr(66563) || chr(66564), 4)),
       (17, repeat('abcde', 400)),
       (18, repeat('abcde', 400) || 'f'),
       (19, 'The vendor fixed it all' || chr(12644))) t(n, s)),
  array[false, false, false, false, false, true, false, false, true, true, false, false, true, false, true, true, true, false, false],
  '0481/159: R2-S1: a reason counts what can be seen: one letter and 19 invisible characters or spaces is refused (the review''s P6a); each run of spaces is one before counting to 20; at least 5 different characters that are not spaces');
select is(
  array[pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'student', %L::jsonb, null, 'approve', %L, %L::jsonb)::text$$,
          :'orgA', :'supV4', pg_temp.answers('student', '{"data_agreement": "no"}'), 'a' || repeat(chr(8288), 19),
          pg_temp.items('student', '{"data_agreement": "no"}'))),
        pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version, status,
          is_current, data_level, answers, starting_risk, evidence, residual_risk, hard_stops, computed_result, override_result,
          override_reason, reviewer_name, reviewed_at, reviewed_on, next_review_on)
          values (%L, %L, 'X', 1, 'final', true, 'staff', %L, 'moderate', 'strong', 'low', '{}', 'approve', 'do_not_use', %L, 'X',
                  now(), current_date, current_date + 30)$$,
          :'orgA', :'supV4', pg_temp.answers('staff'), 'a' || repeat(chr(8288), 19))),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'accepted', null, null, null, %L)::text$$,
          :'orgA', :'item_h2', 'a' || repeat(chr(8288), 19))),
        pg_temp.try(format($$update public.supplier_risk_items set accepted_reason = %L where id = %L$$, 'a' || repeat(chr(8288), 19), :'item_h2')),
        (select count(*)::text from public.supplier_risk_reviews where supplier_id = :'supV4')],
  array['ERR 22023 bad_override_reason hint=bad_override_reason', '23514:supplier_risk_reviews_override',
        'ERR 22023 bad_item_reason hint=bad_item_reason', '23514:supplier_risk_items_accepted', '0'],
  '0481/160: R2-S1: one letter and 19 word joiners no longer turns student data with no signed agreement into Approve (the review''s P6b), nor accepts a risk: the functions refuse it, and so do the tables'' own checks');
select is(
  array[public._supplier_risk_answers_problem(1::smallint, 'staff',
          jsonb_build_object('insurance', jsonb_build_object('answer', 'no', 'note', 'On' || chr(173) || 'file')), false, null),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb, null, null, null, %L::jsonb)::text$$,
          :'orgA', :'supV4', pg_temp.answers('staff', '{"insurance": "no"}'),
          jsonb_build_array(jsonb_build_object('question_key', 'insurance', 'finding', 'No proof' || chr(917569), 'action', 'Ask again.')))),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb, null, null, null, %L::jsonb)::text$$,
          :'orgA', :'supV4', pg_temp.answers('staff', '{"insurance": "no"}'),
          jsonb_build_array(jsonb_build_object('question_key', 'insurance', 'finding', 'No proof.', 'action', 'Ask' || chr(8203) || ' again.')))),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_item_update(%L, %L, 'accepted', null, null, %L)::text$$,
          :'orgA', :'item_h2', 'Ask' || chr(6158) || ' again.')),
        pg_temp.try(format($$update public.supplier_risk_items set action = %L where id = %L$$, 'Ask' || chr(65279) || ' again.', :'item_h2')),
        pg_temp.try(format($$update public.supplier_risk_items set finding = finding where id = %L$$, :'item_h2')),
        pg_temp.try(format($$insert into public.supplier_risk_items (organization_id, review_id, question_key, answer, severity, finding,
                              action, changed_by_name)
                            select organization_id, review_id, question_key, answer, severity, %L, action, changed_by_name
                              from public.supplier_risk_items where id = %L$$, 'No' || chr(8288) || ' proof', :'item_h2'))],
  array['answer_bad_note', 'ERR 22023 bad_item_text hint=bad_item_text', 'ERR 22023 bad_item_text hint=bad_item_text',
        'ERR 22023 bad_item_text hint=bad_item_text', '23514:supplier_risk_items_action', 'ok', '23514:supplier_risk_items_finding'],
  '0481/161: R2-S1: a note, a finding and an action with a hidden character are refused, by the functions and by the table');
select is(
  array[pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version, data_level, answers,
          reviewer_name) values (%L, %L, %L, 1, 'staff', '{}', 'X')$$, :'orgA', :'supV4', 'Name' || chr(8206))),
        pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version, data_level, answers,
          reviewer_name) values (%L, %L, 'X', 1, 'staff', '{}', %L)$$, :'orgA', :'supV4', chr(12644))),
        pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version, data_level, answers,
          reviewer_name) values (%L, %L, %L, 1, 'staff', '{}', 'X')$$, :'orgA', :'supV4', repeat(chr(160), 3))),
        pg_temp.try(format($$update public.supplier_risk_items set owner_name = %L where id = %L$$, 'Owner' || chr(8203), :'item_h2')),
        pg_temp.try(format($$update public.supplier_risk_items set changed_by_name = %L where id = %L$$, chr(917505) || 'Changer', :'item_h2')),
        pg_temp.try(format($$update public.supplier_risk_items set accepted_by_name = %L where id = %L$$, 'Acceptor' || chr(173), :'item_h2'))],
  array['23514:supplier_risk_reviews_supplier_name', '23514:supplier_risk_reviews_reviewer_name', '23514:supplier_risk_reviews_supplier_name',
        '23514:supplier_risk_items_owner_name', '23514:supplier_risk_items_changed_by_name', '23514:supplier_risk_items_accepted'],
  '0481/162: R2-S1: the tables hold every name they keep to the text rule on their own: no hidden character, not only spaces');

-- The names the functions copy, as plain text.
select pg_temp.as_user(:'ownerHid', format($$select public.supplier_risk_finalise(%L, %L, 'none', '{}')::text$$, :'orgA', :'supV1')) as fin_v1 \gset
select pg_temp.as_user(:'onlyHid', format($$select public.supplier_risk_draft_save(%L, %L, 'none', '{}')::text$$, :'orgA', :'supV2')) as draft_v2 \gset
select is(
  array[pg_temp.j(:'fin_v1') ->> 'result',
        (select r.supplier_name || '|' || r.reviewer_name from public.supplier_risk_reviews r where r.supplier_id = :'supV1'),
        (select r.supplier_name || '|' || r.reviewer_name from public.supplier_risk_reviews r where r.supplier_id = :'supV2'),
        pg_temp.as_user(:'adminA', format($$select g.reviewed_as_name || '|' || g.name_changed from public.supplier_risk_register(%L) g where g.supplier_id = %L$$,
          :'orgA', :'supV1')),
        public._supplier_risk_plain_name(repeat('x', 199) || '  y', 200),
        coalesce(public._supplier_risk_plain_name(chr(8203) || ' ' || chr(160), 200), 'none')],
  array['approve', 'Example Ink Co|Made-up Hidden Owner', '(no name)|vr-only-hidden@test.local', 'Example Ink Co|false', repeat('x', 199), 'none'],
  '0481/163: R2-S1: the names the functions copy are kept as plain text (hidden characters out, each run of spaces one, the ends trimmed; nothing left falls back to the email or ''(no name)''), and the register compares today''s name the same way');

-- An account deletion empties the person links with an update, so the tables'
-- checks run again on every row it touches. The rows below hold texts at the
-- edges of the rules: a reason of exactly 20 once its spaces are collapsed
-- and trimmed, a note of 1000 characters of four-byte letters and no-break
-- spaces, a finding of 500 two-byte letters, an action of 1000 four-byte
-- letters and one of tabs, a reason of five four-byte letters, a name cleaned
-- of hidden characters, and the insurance dated tomorrow in UTC.
create function pg_temp.delete_account(p uuid) returns text language plpgsql as $f$
begin
  delete from auth.users where id = p;
  return case when found then 'deleted' else 'none' end;
exception when others then
  return 'ERR ' || sqlstate || ' ' || sqlerrm;
end $f$;
create function pg_temp.v_texts() returns text language sql as $f$
  select md5(coalesce((select string_agg(r.answers::text || coalesce(r.override_reason, '-') || r.supplier_name || r.reviewer_name, '|' order by r.id)
                         from public.supplier_risk_reviews r
                        where r.supplier_id in ('a0481000-0000-0000-0000-000000000501', 'a0481000-0000-0000-0000-000000000503',
                                                'a0481000-0000-0000-0000-000000000505')), '')
             || coalesce((select string_agg(i.finding || i.action || coalesce(i.owner_name, '-') || i.changed_by_name
                                            || coalesce(i.accepted_by_name, '-') || coalesce(i.accepted_reason, '-'), '|' order by i.id)
                            from public.supplier_risk_items i join public.supplier_risk_reviews r on r.id = i.review_id
                           where r.supplier_id = 'a0481000-0000-0000-0000-000000000503'), ''))
$f$;
select pg_temp.as_user(:'ownerHid', format($$select public.supplier_risk_finalise(%L, %L, 'student', %L::jsonb, null, 'more_information', %L, %L::jsonb)::text$$,
  :'orgA', :'supV3',
  pg_temp.answers('student', jsonb_build_object('security_report', 'yes@' || (pg_temp.today(:'orgA') - interval '12 months')::date,
                                                'insurance', 'yes@' || (current_date + 1)))
    || jsonb_build_object('data_agreement', jsonb_build_object('answer', 'no', 'note', repeat(chr(66560) || chr(160), 500)),
                          'hosting_known', jsonb_build_object('answer', 'no', 'note', 'Two' || chr(10) || 'lines,' || chr(9) || 'and a tab')),
  ' ' || chr(12288) || 'abcde fghij klmno pq' || chr(12288) || ' ',
  jsonb_build_array(
    jsonb_build_object('question_key', 'data_agreement', 'finding', repeat(chr(233), 500), 'action', repeat('a' || chr(9), 500),
                       'owner_user_id', :'ownerHid', 'due_on', pg_temp.today(:'orgA') + 5),
    jsonb_build_object('question_key', 'hosting_known', 'finding', 'Kept' || repeat(chr(160), 5) || 'apart',
                       'action', repeat(chr(66560), 1000), 'owner_user_id', :'ownerHid')))) as fin_v3 \gset
select i.id as item_v3_host from public.supplier_risk_items i join public.supplier_risk_reviews r on r.id = i.review_id
 where r.supplier_id = :'supV3' and i.question_key = 'hosting_known' \gset
select i.id as item_v3_agr from public.supplier_risk_items i join public.supplier_risk_reviews r on r.id = i.review_id
 where r.supplier_id = :'supV3' and i.question_key = 'data_agreement' \gset
select pg_temp.as_user(:'ownerHid', format($$select public.supplier_risk_item_update(%L, %L, 'accepted', %L, null, null, %L)::text$$,
  :'orgA', :'item_v3_host', :'ownerHid', repeat(chr(66560) || chr(66561) || chr(66562) || chr(66563) || chr(66564), 4))) as acc_v3 \gset
select pg_temp.as_user(:'ownerHid', format($$select public.supplier_risk_item_update(%L, %L, 'in_progress', %L, %L::date, %L)::text$$,
  :'orgA', :'item_v3_agr', :'ownerHid', pg_temp.today(:'orgA') + 5, 'Ask' || repeat(chr(12288), 4) || 'again, in writing.')) as upd_v3 \gset
select pg_temp.as_user(:'ownerHid', format($$select public.supplier_risk_draft_save(%L, %L, 'staff', %L::jsonb)::text$$,
  :'orgA', :'supV5', jsonb_build_object('insurance', jsonb_build_object('answer', 'no', 'note', repeat(chr(233) || chr(66560), 500)),
                                        'hosting_known', jsonb_build_object('answer', 'yes', 'note', 'x')))) as draft_v5 \gset
select pg_temp.v_texts() as texts_before \gset
select pg_temp.delete_account(:'ownerHid') as del_hid \gset
update public.suppliers set name = 'Deletion' || chr(8203) || '  Edge ' || chr(160) || 'Co' || chr(65279) where id = :'supV3';
select is(
  array[(pg_temp.j(:'fin_v3') ->> 'computed_result') || '>' || (pg_temp.j(:'fin_v3') ->> 'result') || ':' || (pg_temp.j(:'fin_v3') ->> 'items'),
        pg_temp.j(:'acc_v3') ->> 'status', pg_temp.j(:'upd_v3') ->> 'status', pg_temp.j(:'draft_v5') ->> 'version',
        :'del_hid', (pg_temp.v_texts() = :'texts_before')::text,
        (select count(*) filter (where r.reviewer_id is null)::text || '/' || count(*)::text
           from public.supplier_risk_reviews r where r.supplier_id in (:'supV1', :'supV3', :'supV5')),
        (select string_agg(i.question_key || ':' || i.status || ':' || coalesce(i.owner_user_id::text, 'none') || ':' || i.owner_name || ':'
                           || coalesce(i.changed_by::text, 'none') || ':' || i.changed_by_name || ':' || coalesce(i.accepted_by::text, 'none') || ':'
                           || coalesce(i.accepted_by_name, '-'), ',' order by i.question_key)
           from public.supplier_risk_items i join public.supplier_risk_reviews r on r.id = i.review_id where r.supplier_id = :'supV3'),
        pg_temp.as_user(:'adminA', format($$select string_agg(g.question_key || ':' || g.reviewed_as_name || ':' || g.name_changed, ',' order by g.question_key)
                                              from public.supplier_risk_items_for_organization(%L, false) g where g.supplier_id = %L$$, :'orgA', :'supV3')),
        pg_temp.as_user(:'adminA', format($$select g.reviewed_as_name || ':' || g.name_changed from public.supplier_risk_register(%L) g where g.supplier_id = %L$$,
          :'orgA', :'supV3'))],
  array['do_not_use>more_information:2', 'accepted', 'in_progress', '1', 'deleted', 'true', '3/3',
        'data_agreement:in_progress:none:Made-up Hidden Owner:none:Made-up Hidden Owner:none:-,'
        'hosting_known:accepted:none:Made-up Hidden Owner:none:Made-up Hidden Owner:none:Made-up Hidden Owner',
        'data_agreement:Deletion Edge Co:false,hosting_known:Deletion Edge Co:false', 'Deletion Edge Co:false'],
  '0481/164: R2-S1: an account deletion runs the tables'' checks again on every row it empties a link of, and still succeeds for rows holding texts at the edges of the new rules (reasons, notes, findings, actions, names, a date tomorrow in UTC); every text stays as written; today''s name with hidden characters and doubled spaces is still the name reviewed, in the open items list and the register');

-- R2-S2: the dated cases. vendor-risk.parity.test.ts reads these same rows
-- and runs core's answers check and rules on them: (n, question, its answer
-- and date ("@" alone: none), finished or a draft, the review day, today in
-- UTC, what it counts as (yes, no, not_shown, out_of_date) or the refusal).
-- Every other question Yes, the other judged date on the review day.
create temporary table vr_dated (n integer primary key, q text, given text, final boolean, reviewed_on date, utc_today date, expect text) on commit drop;
-- VENDOR RISK DATED CASES BEGIN
insert into vr_dated (n, q, given, final, reviewed_on, utc_today, expect) values
  (1, 'security_report', 'yes@2026-06-30', true, '2026-06-30', '2026-06-30', 'yes'),
  (2, 'insurance', 'yes@2026-06-30', true, '2026-06-30', '2026-06-30', 'yes'),
  (3, 'security_report', 'yes@2025-06-30', true, '2026-06-30', '2026-06-30', 'yes'),
  (4, 'security_report', 'yes@2025-06-29', true, '2026-06-30', '2026-06-30', 'out_of_date'),
  (5, 'insurance', 'yes@2025-06-29', true, '2026-06-30', '2026-06-30', 'out_of_date'),
  (6, 'security_report', 'yes@2027-02-28', true, '2028-02-29', '2028-02-29', 'yes'),
  (7, 'security_report', 'yes@2027-02-27', true, '2028-02-29', '2028-02-29', 'out_of_date'),
  (8, 'insurance', 'yes@2028-02-29', true, '2028-02-29', '2028-02-29', 'yes'),
  (9, 'insurance', 'yes@2028-02-28', true, '2029-02-28', '2029-02-28', 'yes'),
  (10, 'insurance', 'yes@2028-02-27', true, '2029-02-28', '2029-02-28', 'out_of_date'),
  (11, 'insurance', 'yes@2028-02-29', true, '2029-02-28', '2029-02-28', 'yes'),
  (12, 'security_report', 'yes@', true, '2026-06-30', '2026-06-30', 'answer_date_missing'),
  (13, 'insurance', 'yes@', true, '2026-06-30', '2026-06-30', 'answer_date_missing'),
  (14, 'security_report', 'yes@', false, '2026-06-30', '2026-06-30', 'yes'),
  (15, 'insurance', 'yes@', false, '2028-02-29', '2028-02-29', 'yes'),
  (16, 'security_report', 'yes@2026-07-01', true, '2026-06-30', '2026-06-30', 'yes'),
  (17, 'security_report', 'yes@2026-07-02', true, '2026-06-30', '2026-06-30', 'answer_date_in_future'),
  (18, 'insurance', 'yes@2026-07-02', false, '2026-06-30', '2026-06-30', 'answer_date_in_future'),
  (19, 'insurance', 'yes@2026-07-01', true, '2026-07-01', '2026-06-30', 'yes'),
  (20, 'insurance', 'yes@2028-02-29', true, '2028-02-28', '2028-02-28', 'yes'),
  (21, 'insurance', 'yes@2028-03-01', true, '2028-02-28', '2028-02-28', 'answer_date_in_future'),
  (22, 'security_report', 'yes@2027-01-01', true, '2026-12-31', '2026-12-31', 'yes'),
  (23, 'security_report', 'yes@2027-01-02', true, '2026-12-31', '2026-12-31', 'answer_date_in_future'),
  (24, 'insurance', 'no@2030-01-01', false, '2026-06-30', '2026-06-30', 'answer_date_in_future'),
  (25, 'insurance', 'no@', true, '2026-06-30', '2026-06-30', 'no'),
  (26, 'security_report', 'not_shown@', true, '2026-06-30', '2026-06-30', 'not_shown'),
  (27, 'data_agreement', 'yes@', true, '2026-06-30', '2026-06-30', 'yes'),
  (28, 'data_agreement', 'yes@2030-01-01', true, '2026-06-30', '2026-06-30', 'yes');
-- VENDOR RISK DATED CASES END
select is((select count(*)::int from vr_dated), 28, '0481/165: R2-S2: the dated cases table has its 28 rows');
select is(
  (select string_agg(d.n || ': ' || x.got, ' ; ' order by d.n)
     from vr_dated d,
          lateral (select pg_temp.answers('staff', jsonb_build_object(d.q, d.given), d.reviewed_on) as ans) a,
          lateral (select coalesce(public._supplier_risk_answers_problem(1::smallint, 'staff', a.ans, d.final, d.utc_today),
                                   (select case when e -> 'out_of_date' ? d.q then 'out_of_date'
                                                when e -> 'gaps' ? d.q then a.ans -> d.q ->> 'answer'
                                                else 'yes' end
                                      from public._supplier_risk_evaluate(1::smallint, 'staff', a.ans, d.reviewed_on) e)) as got) x
    where x.got is distinct from d.expect),
  null,
  '0481/166: R2-S2: the database gives every dated case (the review day itself, a leap day, a date missing, a date in the future, on the security report and the insurance; the data agreement''s date neither needed nor judged)');
select is(
  array[pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb)::text$$,
          :'orgA', :'supV6', pg_temp.answers('staff', '{"security_report": "yes@"}'))),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb)::text$$,
          :'orgA', :'supV6', pg_temp.answers('staff', '{"insurance": "yes@"}'))),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb)::text$$,
          :'orgA', :'supV6', pg_temp.answers('staff', jsonb_build_object('insurance', 'yes@' || (current_date + 2))))),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb, null, null, null, %L::jsonb)::text$$,
          :'orgA', :'supV6', pg_temp.answers('staff', jsonb_build_object('security_report', 'no@' || (current_date + 2))),
          pg_temp.items('staff', '{"security_report": "no"}'))),
        pg_temp.as_user(:'adminA', format($$select public.supplier_risk_draft_save(%L, %L, 'staff', %L::jsonb)::text$$,
          :'orgA', :'supV6', jsonb_build_object('insurance', jsonb_build_object('answer', 'yes', 'date', current_date + 2)))),
        (select count(*)::text from public.supplier_risk_reviews r where r.supplier_id = :'supV6')],
  array['ERR 22023 answer_date_missing hint=answer_date_missing', 'ERR 22023 answer_date_missing hint=answer_date_missing',
        'ERR 22023 answer_date_in_future hint=answer_date_in_future', 'ERR 22023 answer_date_in_future hint=answer_date_in_future',
        'ERR 22023 answer_date_in_future hint=answer_date_in_future', '0'],
  '0481/167: R2-S2: a finish refuses a Yes on the security report or the insurance without its date, and a date there later than tomorrow in UTC (whatever the answer); a draft refuses that date too; nothing is written');
select pg_temp.as_user(:'adminA', format($$select public.supplier_risk_draft_save(%L, %L, 'staff', %L::jsonb)::text$$,
  :'orgA', :'supV6', pg_temp.answers('staff', '{"security_report": "yes@", "insurance": "yes@"}'))) as draft_v6 \gset
select pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb)::text$$,
  :'orgA', :'supV6', pg_temp.answers('staff', '{"security_report": "yes@", "insurance": "yes@"}'))) as fin_v6_bad \gset
select pg_temp.as_user(:'adminA', format($$select public.supplier_risk_finalise(%L, %L, 'staff', %L::jsonb)::text$$,
  :'orgA', :'supV6', pg_temp.answers('staff', jsonb_build_object('security_report', 'yes@' || current_date,
                                                                 'insurance', 'yes@' || (current_date + 1))))) as fin_v6 \gset
select is(
  array[pg_temp.j(:'draft_v6') ->> 'version', :'fin_v6_bad',
        (pg_temp.j(:'fin_v6') ->> 'result') || ':' || (pg_temp.j(:'fin_v6') ->> 'version'),
        (select string_agg(r.status || ':' || (r.answers -> 'insurance' ->> 'date'), ',') from public.supplier_risk_reviews r where r.supplier_id = :'supV6')],
  array['1', 'ERR 22023 answer_date_missing hint=answer_date_missing', 'approve:1', 'final:' || (current_date + 1)::text],
  '0481/168: R2-S2: a draft may keep a Yes whose date is still to come; finishing it without the date is refused and keeps the draft; with the date on the document (tomorrow in UTC at the latest) the draft is finished');
select is(
  array[pg_temp.as_user(:'ownerZ', format($$select public.supplier_risk_draft_save(%L, %L, 'staff', %L::jsonb)::text$$,
          :'orgZ', :'supZ4', jsonb_build_object('insurance', jsonb_build_object('answer', 'yes', 'date', current_date + 2)))),
        pg_temp.j(pg_temp.as_user(:'ownerZ', format($$select public.supplier_risk_draft_save(%L, %L, 'staff', %L::jsonb)::text$$,
          :'orgZ', :'supZ4', jsonb_build_object('insurance', jsonb_build_object('answer', 'yes', 'date', current_date + 1))))) ->> 'version',
        pg_temp.j(pg_temp.as_user(:'ownerW', format($$select public.supplier_risk_draft_save(%L, %L, 'staff', %L::jsonb)::text$$,
          :'orgW', :'supW4', jsonb_build_object('insurance', jsonb_build_object('answer', 'yes', 'date', current_date + 1))))) ->> 'version',
        pg_temp.as_user(:'ownerW', format($$select public.supplier_risk_draft_save(%L, %L, 'staff', %L::jsonb)::text$$,
          :'orgW', :'supW4', jsonb_build_object('insurance', jsonb_build_object('answer', 'yes', 'date', current_date + 2))))],
  array['ERR 22023 answer_date_in_future hint=answer_date_in_future', '1', '1', 'ERR 22023 answer_date_in_future hint=answer_date_in_future'],
  '0481/169: R2-S2: the future is today in UTC plus one day, whatever the organization''s zone: refused at UTC''s day after tomorrow even where that is Z''s tomorrow, taken at UTC''s tomorrow even where that is W''s day after tomorrow');
select is(
  (select array_agg(pg_temp.try(format($$insert into public.supplier_risk_reviews (organization_id, supplier_id, supplier_name, version, status,
          is_current, data_level, answers, starting_risk, evidence, residual_risk, hard_stops, computed_result, reviewer_name, reviewed_at,
          reviewed_on, next_review_on)
          values (%L, %L, 'X', 1, %L, %L, 'staff', %L, %s, %s, %s, %s, %s, 'X', %L, %L, %L)$$,
          :'orgA', :'supV4', t.st, t.st = 'final', pg_temp.answers('staff', t.over::jsonb, date '2026-06-30'),
          case when t.st = 'final' then '''moderate''' else 'null' end, case when t.st = 'final' then '''strong''' else 'null' end,
          case when t.st = 'final' then '''low''' else 'null' end, case when t.st = 'final' then '''{}''' else 'null' end,
          case when t.st = 'final' then '''approve''' else 'null' end,
          case when t.st = 'final' then t.at end, case when t.st = 'final' then date '2026-06-30' end,
          case when t.st = 'final' then date '2027-06-30' end)) order by t.n)
     from (values (1, 'final', '{"insurance": "yes@"}', timestamptz '2026-06-30 12:00+00'),
                  (2, 'final', '{"insurance": "yes@2026-07-02"}', timestamptz '2026-06-30 12:00+00'),
                  (3, 'final', '{"insurance": "yes@2026-07-01"}', timestamptz '2026-06-30 12:00+00'),
                  (4, 'final', '{"insurance": "yes@2026-07-02"}', timestamptz '2026-07-01 05:00+00'),
                  (5, 'draft', '{"insurance": "yes@"}', null)) t(n, st, over, at)),
  array['23514:supplier_risk_reviews_answers', '23514:supplier_risk_reviews_answers', 'ok', 'ok', 'ok'],
  '0481/170: R2-S2: the reviews table holds it on its own: a final with a Yes on the insurance and no date, or a date later than the day after reviewed_at in UTC, is refused (not the organization''s review day: a review finished late on 30 June in Los Angeles is 1 July in UTC); a draft may wait for the date');

select * from finish();
rollback;
