-- 0481_supplier_risk_reviews.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Vendor risk reviews for an organization's owners and admins (security tools,
-- part 7). Vendors are the app's suppliers. An admin answers a short, fixed
-- list of questions about one supplier (what of ours they hold, what the
-- contract and the data agreement say, which reports they have shown us, and
-- the student-data conditions); the database works out the result by fixed
-- rules, keeps every finished review as a version, keeps a register of the
-- items each gap makes (with an owner, a due date and a status), and has a
-- next review date with two reminders a future daily job sends. Nothing reads
-- or writes these objects until the app code that follows this migration.
-- The question list and the rules are core's (packages/core/src/vendor-risk/):
-- the same list and the same rules are written here, and the case table in
-- this file's test is run against both (vendor-risk.parity.test.ts). The
-- advisory lock key below (4810001) carries this file's number.
--
-- WHAT IT ADDS (tier A: two new tables with their keys, checks and indexes,
-- two triggers on the new tables, twenty-four functions (ten the API roles
-- may run: eight for signed-in admins, two for the daily job; fourteen
-- private) and their grants. No stored row; no existing table, column,
-- function, policy, trigger or grant changes. The existing objects touched
-- are public.organizations and public.user_profiles, which gain the internal
-- triggers of the new foreign keys: deleting an organization deletes its
-- reviews and items; deleting a profile, which deleting an account does,
-- empties the link to that person and keeps the name written beside it.)
--   1. public.supplier_risk_reviews. One row per version of a supplier's
--      review. A version is a draft (being written; at most one per supplier)
--      or final (finished; never changed again, but for the marks below). The
--      newest final is the CURRENT review: exactly one per supplier that has a
--      final one (a unique index holds "at most one"; the one function that
--      clears the mark sets it on the new final in the same transaction, and
--      no function deletes a final).
--      Each row holds: the organization and the supplier (a plain uuid, with
--      the supplier's name as it was at the last save, so a review outlives
--      its supplier: see SUPPLIERS ARCHIVED OR DELETED); the version number;
--      the rules version (1); the data level (none, staff, student); the
--      answers (jsonb: question key to {answer, note, date}; keys and values
--      are checked against the fixed list by a CHECK of the table); for a
--      final, what the rules give (starting risk, evidence, risk left, the
--      hard stops, the computed result: a CHECK holds them equal to the rules
--      applied to the answers, so no caller can store another) and an
--      optional override of the result with its reason (the reason is
--      required, and kept); the result in force (a generated column); the
--      reviewer (a link that empties when the account is deleted, and a name
--      snapshot that stays); when it was finished; the next review date; and
--      when each of the two reminders was claimed.
--   2. public.supplier_risk_items. The register: one row for each gap (an
--      asked question answered No or Not shown to us) of a final review: the
--      question, the answer, the severity (the rules'), the finding and the
--      action (the admin's words, suggested by core), an owner (a member,
--      with a name snapshot), a due date, a status (open, in_progress, done,
--      accepted) and when it was closed. Exactly one per gap, written with
--      the final review. A trigger keeps the finding, the answer and the
--      severity as written.
--   3. The admins' functions (EXECUTE to authenticated; each opens with
--      has_org_role(organization, 'admin') in its own body and then
--      security_events_reader_check, 0472's authenticator rule):
--        supplier_risk_register(org): every active supplier of the
--          organization, and every archived or deleted one that has a review,
--          with its current review's summary and its open draft;
--        supplier_risk_history(org, supplier): every version, newest first;
--        supplier_risk_review(org, review): one version whole, with its items;
--        supplier_risk_items_for_organization(org, open_only): the items of
--          the current reviews;
--        supplier_risk_draft_save(org, supplier, level, answers): writes the
--          supplier's one draft;
--        supplier_risk_finalise(org, supplier, level, answers, next review,
--          override, reason, items): finishes a review in one transaction;
--        supplier_risk_draft_discard(org, supplier): deletes the draft;
--        supplier_risk_item_update(org, item, status, owner, due, action).
--   4. The future daily job's functions (EXECUTE to service_role only):
--        supplier_risk_reminders_due(limit): current reviews of active
--          suppliers due in 30 days or less, or due today or before, whose
--          reminder was not claimed;
--        supplier_risk_reminder_claim(review, kind): stamps the reminder
--          before it is sent (the schedule-reminders pattern: a crash loses
--          a reminder rather than repeating it); true for exactly one of any
--          number of overlapping calls.
--   5. Private helpers (no API role may call them): the question list, the
--      answers check, the rules, the text rule, the default next review
--      date, the organization's zone, the two trigger functions.
--
-- WHO CAN READ AND WRITE
--   - RLS is on with NO policy on both tables, and anon, authenticated and
--     service_role have no privilege on either: no API role reads or writes a
--     row directly. In particular the suppliers table's own policies are not
--     reused: every member reads suppliers (0003) and managers write them,
--     while a review is for owners and admins only. (No policy is created, so
--     this file takes none of the locks a CREATE POLICY takes: 0418's note.)
--   - Why functions and not policies (the 0474 way): the database must
--     compute the result, check the answers against the fixed list, keep one
--     current version and write the items in the same transaction as the
--     review, which a policy cannot do; a refused caller gets a clear 42501
--     instead of an empty list; the authenticator rule (0472's check) answers
--     with its own hint, as the sign-in alerts read does.
--   - Each admin function refuses with 42501 (supplier_risk_not_allowed)
--     unless the caller is an admin or owner of the organization
--     (has_org_role: an accepted membership, not disabled; a live act-as seat
--     is an owner seat, as everywhere else); then 0472's check applies the
--     authenticator rule (hint mfa_required or aal2_required). A manager, a
--     staff member, a viewer and another organization's admin are refused,
--     for every read and every write. A supplier, a review or an item of
--     another organization is "not found", as one that does not exist.
--   - The two job functions: the grant is the gate (service_role only), and
--     a second lock in each body reads the role setting (0413's form) and
--     refuses with 42501 when it is authenticated or anon.
--   Explicit for all three API roles and PUBLIC (apps/web/src/test/
--   migration-grants.ts), the same with and without Supabase's default
--   grants.
--
-- SUPPLIERS ARCHIVED OR DELETED. supplier_id has no foreign key, so nothing
-- that happens to a supplier touches a review: an archived supplier
-- (deleted_at set, the app's archive) and a deleted one (the row gone) keep
-- every version and item. Every read marks each row with supplier_state
-- (active, archived, deleted) from the suppliers table as it is now; a
-- deleted supplier is named by the newest snapshot. A new draft or a
-- finished review is refused for an archived supplier (supplier_archived)
-- and for a missing one (supplier_not_found); a draft can still be
-- discarded. No reminder is sent for an archived or deleted supplier. The
-- supplier's organization is checked in every write: a supplier of another
-- organization is supplier_not_found.
--
-- ACCOUNTS DELETED. reviewer_id and owner_user_id are keys to user_profiles
-- with ON DELETE SET NULL: the row stays, the link empties, and the name
-- written beside it (reviewer_name, owner_name) stays.
--
-- ERRORS: 42501 (not allowed; mfa_required, aal2_required); 22023 with the
-- code as message and hint for every refused argument (listed in each
-- function's comment); 55000 (supplier_risk_final_is_kept, a final review or
-- an item's written fields changed by any path); 55P03 (a lock wait past the
-- function's own lock_timeout). No function raises 40001 or 40P01.
-- ─────────────────────────────────────────────────────────────────────────────

-- LOCKS: the three foreign keys to existing tables take SHARE ROW EXCLUSIVE on
-- public.organizations and public.user_profiles (and ACCESS SHARE), held to
-- commit. Those are the only existing tables this file locks: it creates no
-- policy and drops nothing, so supautils takes nothing on the auth, storage
-- and realtime tables; the function bodies are plpgsql or SQL that Postgres
-- does not run when they are created; the preflight reads the catalogs only.
-- Every write of an organization or a profile row waits while the file holds
-- the locks (sign-up, profile edits, workspace creation and settings, act-as,
-- an account disabled, enabled or deleted), and while the file waits for
-- them, since they queue behind its request: that wait is at most 900 ms.
-- Reads of both tables do not wait. lock_timeout 900ms ends the file's own
-- wait with 55P03 and nothing applied, and the push can be run again. It is
-- not reset at the end of the file, so the push's own last write, made in
-- the same transaction, has the same limit.
set lock_timeout = '900ms';

-- ── Preflight ────────────────────────────────────────────────────────────────
-- Reads the catalogs only. Refuses to run (55000, hint
-- supplier_risk_preflight, nothing applied) when a name this file creates is
-- taken (the file already ran, or was half applied by hand), when another
-- function names the advisory lock key, or when something the functions read
-- is not there as they read it.
do $preflight$
declare
  v_bad text := '';
begin
  if exists (select 1 from pg_catalog.pg_class c
              where c.relnamespace = 'public'::regnamespace
                and c.relname like 'supplier\_risk\_%')
     or exists (select 1 from pg_catalog.pg_type t
                 where t.typnamespace = 'public'::regnamespace
                   and (t.typname like 'supplier\_risk\_%' or t.typname like '\_supplier\_risk\_%')) then
    v_bad := v_bad || ' a table, index or type name this file creates is taken (or this file already ran);';
  end if;

  if exists (select 1 from pg_catalog.pg_proc p
              where p.pronamespace = 'public'::regnamespace
                and (p.proname like 'supplier\_risk\_%' or p.proname like '\_supplier\_risk\_%')) then
    v_bad := v_bad || ' a function name this file creates is taken (or this file already ran);';
  end if;

  if exists (select 1 from pg_catalog.pg_proc p where p.prosrc like '%4810001%') then
    v_bad := v_bad || ' another function already names the advisory lock key 4810001;';
  end if;

  if to_regprocedure('public.has_org_role(uuid, text)') is null
     or to_regprocedure('public.security_events_reader_check(uuid)') is null then
    v_bad := v_bad || ' has_org_role(uuid, text) or security_events_reader_check(uuid) is missing;';
  end if;

  if (select count(*) from pg_catalog.pg_attribute a
       where not a.attisdropped and a.attnum > 0
         and ((a.attrelid = to_regclass('public.suppliers')
               and a.attname in ('id', 'organization_id', 'name', 'deleted_at'))
           or (a.attrelid = to_regclass('public.organizations')
               and a.attname in ('id', 'timezone'))
           or (a.attrelid = to_regclass('public.user_profiles')
               and a.attname in ('id', 'full_name', 'email', 'disabled_at'))
           or (a.attrelid = to_regclass('public.organization_members')
               and a.attname in ('organization_id', 'user_id', 'role', 'accepted_at', 'impersonation_expires_at')))) <> 15 then
    v_bad := v_bad || ' a column the functions read (suppliers, organizations, user_profiles, organization_members) is missing;';
  end if;

  if v_bad <> '' then
    raise exception 'supplier_risk_preflight:%', v_bad
      using errcode = '55000', hint = 'supplier_risk_preflight';
  end if;
end
$preflight$;

-- ── The question list ────────────────────────────────────────────────────────
-- Rules version 1. The same list as core's VENDOR_RISK_QUESTIONS (key, group,
-- order, whether a date applies, asked only with student data, a key paper,
-- the hard stop a No makes with student data, and the severity of its item
-- with staff contact details and with student data); vendor-risk.parity.test.ts
-- reads the block between the markers and holds the two equal. Every
-- question needs some data of ours: none is asked at the level 'none'.
create function public._supplier_risk_questions()
returns table (
  key               text,
  grp               text,
  ord               integer,
  has_date          boolean,
  student_only      boolean,
  key_evidence      boolean,
  hard_stop         text,
  severity_staff    text,
  severity_student  text
)
language sql
immutable
set search_path = ''
as $$
  select q.key, q.grp, q.ord, q.has_date, q.student_only, q.key_evidence, q.hard_stop,
         q.severity_staff, q.severity_student
    from (values
      -- vendor-risk-questions:begin
      ('data_listed',      'holds',    1, false, false, false, null,                            'low',    'medium'),
      ('data_we_send',     'holds',    2, false, false, false, null,                            'low',    'medium'),
      ('hosting_known',    'holds',    3, false, false, false, null,                            'low',    'medium'),
      ('data_agreement',   'paper',    4, true,  false, true,  'student_data_no_agreement',     'medium', 'critical'),
      ('breach_notice',    'paper',    5, false, false, true,  'student_data_no_breach_notice', 'medium', 'critical'),
      ('return_or_delete', 'paper',    6, false, false, false, null,                            'low',    'high'),
      ('subvendors_named', 'paper',    7, false, false, false, null,                            'low',    'high'),
      ('security_report',  'proof',    8, true,  false, true,  null,                            'medium', 'high'),
      ('insurance',        'proof',    9, true,  false, false, null,                            'low',    'medium'),
      ('direct_control',   'student', 10, false, true,  false, null,                            null,     'high'),
      ('purpose_only',     'student', 11, false, true,  false, null,                            null,     'high'),
      ('no_redisclosure',  'student', 12, false, true,  false, null,                            null,     'high'),
      ('no_sale_or_ads',   'student', 13, false, true,  false, 'student_data_sale_or_ads',      null,     'critical'),
      ('no_ai_training',   'student', 14, false, true,  false, 'student_data_ai_training',      null,     'critical')
      -- vendor-risk-questions:end
    ) as q(key, grp, ord, has_date, student_only, key_evidence, hard_stop, severity_staff, severity_student);
$$;

revoke all on function public._supplier_risk_questions() from public, anon, authenticated, service_role;

comment on function public._supplier_risk_questions() is
  'Private (0481). The vendor risk question list of rules version 1, the same as core''s VENDOR_RISK_QUESTIONS: key, group (holds, paper, proof, student), order, whether a date applies, asked only with student data, a key paper, the hard stop a No makes with student data, the item severity with staff contact details and with student data. No question is asked at the level none. No API role may call it.';

create function public._supplier_risk_question_key_ok(p_key text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select exists (select 1 from public._supplier_risk_questions() q where q.key = p_key);
$$;

revoke all on function public._supplier_risk_question_key_ok(text) from public, anon, authenticated, service_role;

comment on function public._supplier_risk_question_key_ok(text) is
  'Private (0481). Is this a key of the vendor risk question list. Used by the items table''s CHECK. No API role may call it.';

-- ── The text rule ────────────────────────────────────────────────────────────
-- Every text this file stores from a caller (a note, a reason, a finding, an
-- action): p_min to p_max characters, at least one that is not a space, tab
-- or line break, no control character but tab and line breaks, and none of
-- the invisible or direction-changing characters. Core's vendorRiskTextOk is
-- the same rule.
create function public._supplier_risk_text_ok(p_text text, p_min integer, p_max integer)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
           pg_catalog.char_length(p_text) between p_min and p_max
           and p_text ~ '[^ \t\r\n]'
           and p_text !~ '[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069\uFEFF]',
           false);
$$;

revoke all on function public._supplier_risk_text_ok(text, integer, integer) from public, anon, authenticated, service_role;

comment on function public._supplier_risk_text_ok(text, integer, integer) is
  'Private (0481). The text rule for what a caller writes (a note, a reason, a finding, an action): p_min to p_max characters, at least one that is not a space, tab or line break, no control character but tab and line breaks, none of U+200B to U+200F, U+2028 to U+202E, U+2066 to U+2069, U+FEFF. False for null. No API role may call it.';

-- The override reason: the text rule (1 to 2000), and at least 10 characters
-- once spaces, tabs and line breaks at the ends are trimmed.
create function public._supplier_risk_reason_ok(p_text text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select public._supplier_risk_text_ok(p_text, 1, 2000)
         and pg_catalog.char_length(pg_catalog.btrim(p_text, E' \t\r\n')) >= 10;
$$;

revoke all on function public._supplier_risk_reason_ok(text) from public, anon, authenticated, service_role;

comment on function public._supplier_risk_reason_ok(text) is
  'Private (0481). The override reason rule: the text rule with 1 to 2000 characters, and at least 10 once spaces, tabs and line breaks at the ends are trimmed. False for null. No API role may call it.';

-- ── The answers check ────────────────────────────────────────────────────────
-- What is wrong with these answers, as a fixed word, or null when nothing is.
-- An object of question key to {"answer": yes|no|not_shown, "note": text or
-- null, "date": 'YYYY-MM-DD' or null} and no other field; only keys of
-- questions asked at the level; a date only where the question takes one,
-- a real date from 2000-01-01 to 2100-12-31; a note by the text rule, 1 to
-- 1000 characters. p_final: every question asked at the level is answered.
-- Core's vendorRiskAnswersProblem gives the same words. Used by the reviews
-- table's CHECK, so every row on every path is held to it.
create function public._supplier_risk_answers_problem(
  p_rules_version smallint,
  p_level text,
  p_answers jsonb,
  p_final boolean
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key   text;
  v_val   jsonb;
  v_q     record;
  v_date  text;
  v_d     date;
begin
  if p_rules_version is distinct from 1 then
    return 'bad_rules_version';
  end if;
  if p_level is null or p_level not in ('none', 'staff', 'student') then
    return 'bad_data_level';
  end if;
  if p_answers is null or pg_catalog.jsonb_typeof(p_answers) <> 'object' then
    return 'answers_not_an_object';
  end if;

  for v_key, v_val in select e.key, e.value from pg_catalog.jsonb_each(p_answers) e loop
    select q.* into v_q from public._supplier_risk_questions() q where q.key = v_key;
    if not found then
      return 'answer_unknown_question';
    end if;
    if p_level = 'none' or (v_q.student_only and p_level <> 'student') then
      return 'answer_not_applicable';
    end if;
    if pg_catalog.jsonb_typeof(v_val) <> 'object'
       or exists (select 1 from pg_catalog.jsonb_object_keys(v_val) f
                   where f not in ('answer', 'note', 'date')) then
      return 'answer_bad_shape';
    end if;
    if coalesce(pg_catalog.jsonb_typeof(v_val -> 'answer'), '') <> 'string'
       or (v_val ->> 'answer') not in ('yes', 'no', 'not_shown') then
      return 'answer_bad_value';
    end if;
    if coalesce(pg_catalog.jsonb_typeof(v_val -> 'note'), 'null') <> 'null'
       and (pg_catalog.jsonb_typeof(v_val -> 'note') <> 'string'
            or not public._supplier_risk_text_ok(v_val ->> 'note', 1, 1000)) then
      return 'answer_bad_note';
    end if;
    if coalesce(pg_catalog.jsonb_typeof(v_val -> 'date'), 'null') <> 'null' then
      if not v_q.has_date then
        return 'answer_date_not_allowed';
      end if;
      if pg_catalog.jsonb_typeof(v_val -> 'date') <> 'string' then
        return 'answer_bad_date';
      end if;
      v_date := v_val ->> 'date';
      if v_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        return 'answer_bad_date';
      end if;
      begin
        v_d := pg_catalog.make_date(substr(v_date, 1, 4)::integer, substr(v_date, 6, 2)::integer,
                                    substr(v_date, 9, 2)::integer);
      exception when others then
        return 'answer_bad_date';
      end;
      if v_d < date '2000-01-01' or v_d > date '2100-12-31' then
        return 'answer_bad_date';
      end if;
    end if;
  end loop;

  if p_final and exists (
       select 1 from public._supplier_risk_questions() q
        where p_level <> 'none' and (not q.student_only or p_level = 'student')
          and not (p_answers ? q.key)) then
    return 'answers_incomplete';
  end if;

  return null;
end;
$$;

revoke all on function public._supplier_risk_answers_problem(smallint, text, jsonb, boolean) from public, anon, authenticated, service_role;

comment on function public._supplier_risk_answers_problem(smallint, text, jsonb, boolean) is
  'Private (0481). What is wrong with a review''s answers, as a fixed word, or null: bad_rules_version, bad_data_level, answers_not_an_object, answer_unknown_question, answer_not_applicable, answer_bad_shape, answer_bad_value, answer_bad_note, answer_date_not_allowed, answer_bad_date, answers_incomplete (p_final, an asked question unanswered). The same words as core''s vendorRiskAnswersProblem. Used by the reviews table''s CHECK. No API role may call it.';

-- ── The rules ────────────────────────────────────────────────────────────────
-- Core's evaluateVendorRisk, the same rules (rules.ts has them in words):
-- starting risk from the level; a gap is an asked question answered No or
-- Not shown (an unanswered one counts as Not shown); evidence not_needed
-- (nothing asked), insufficient (a key paper Not shown, or more than half Not
-- shown), weak (a key paper No, or three gaps or more), adequate (one or two
-- gaps), strong (none); with student data a hard stop for each hard-stop
-- question answered No, pending when it is Not shown; risk left high with a
-- hard stop, low when strong or not needed, one step down when adequate, the
-- starting risk otherwise; result do_not_use (a hard stop), more_information
-- (a pending hard stop, or insufficient), approve (no gap),
-- approve_with_conditions. Null for another rules version or level.
create function public._supplier_risk_evaluate(p_rules_version smallint, p_level text, p_answers jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_q        record;
  v_a        text;
  v_n        integer := 0;
  v_gaps     integer := 0;
  v_ns       integer := 0;
  v_key_ns   boolean := false;
  v_key_no   boolean := false;
  v_hard     text[] := '{}';
  v_pending  text[] := '{}';
  v_start    text;
  v_evidence text;
  v_left     text;
  v_result   text;
begin
  if p_rules_version is distinct from 1 or p_level is null or p_level not in ('none', 'staff', 'student') then
    return null;
  end if;

  for v_q in select q.* from public._supplier_risk_questions() q order by q.ord loop
    continue when p_level = 'none' or (v_q.student_only and p_level <> 'student');
    v_n := v_n + 1;
    v_a := case when pg_catalog.jsonb_typeof(p_answers -> v_q.key) = 'object'
                 and pg_catalog.jsonb_typeof(p_answers -> v_q.key -> 'answer') = 'string'
                then p_answers -> v_q.key ->> 'answer' end;
    -- Not answered counts as Not shown: never as a pass.
    if v_a is null or v_a not in ('yes', 'no', 'not_shown') then
      v_a := 'not_shown';
    end if;
    continue when v_a = 'yes';
    v_gaps := v_gaps + 1;
    if v_a = 'not_shown' then
      v_ns := v_ns + 1;
      if v_q.key_evidence then
        v_key_ns := true;
      end if;
    elsif v_q.key_evidence then
      v_key_no := true;
    end if;
    if p_level = 'student' and v_q.hard_stop is not null then
      if v_a = 'no' then
        v_hard := v_hard || v_q.hard_stop;
      else
        v_pending := v_pending || v_q.hard_stop;
      end if;
    end if;
  end loop;

  v_start := case p_level when 'none' then 'low' when 'staff' then 'moderate' else 'high' end;

  if v_n = 0 then
    v_evidence := 'not_needed';
  elsif v_key_ns or v_ns * 2 > v_n then
    v_evidence := 'insufficient';
  elsif v_key_no or v_gaps > 2 then
    v_evidence := 'weak';
  elsif v_gaps > 0 then
    v_evidence := 'adequate';
  else
    v_evidence := 'strong';
  end if;

  if pg_catalog.cardinality(v_hard) > 0 then
    v_left := 'high';
  elsif v_evidence in ('strong', 'not_needed') then
    v_left := 'low';
  elsif v_evidence = 'adequate' then
    v_left := case v_start when 'high' then 'moderate' else 'low' end;
  else
    v_left := v_start;
  end if;

  if pg_catalog.cardinality(v_hard) > 0 then
    v_result := 'do_not_use';
  elsif pg_catalog.cardinality(v_pending) > 0 or v_evidence = 'insufficient' then
    v_result := 'more_information';
  elsif v_gaps = 0 then
    v_result := 'approve';
  else
    v_result := 'approve_with_conditions';
  end if;

  return pg_catalog.jsonb_build_object(
    'starting_risk', v_start,
    'evidence', v_evidence,
    'residual_risk', v_left,
    'hard_stops', pg_catalog.to_jsonb(v_hard),
    'pending_hard_stops', pg_catalog.to_jsonb(v_pending),
    'result', v_result);
end;
$$;

revoke all on function public._supplier_risk_evaluate(smallint, text, jsonb) from public, anon, authenticated, service_role;

comment on function public._supplier_risk_evaluate(smallint, text, jsonb) is
  'Private (0481). The vendor risk rules of version 1, the same as core''s evaluateVendorRisk: {starting_risk (low, moderate, high), evidence (not_needed, strong, adequate, weak, insufficient), residual_risk, hard_stops and pending_hard_stops (arrays in question order), result (approve, approve_with_conditions, more_information, do_not_use)}. An unanswered asked question counts as Not shown. Null for another rules version or level. No API role may call it.';

-- The stored result equals the rules applied to the stored answers. Used by
-- the reviews table's CHECK.
create function public._supplier_risk_computed_ok(
  p_rules_version smallint,
  p_level text,
  p_answers jsonb,
  p_starting_risk text,
  p_evidence text,
  p_residual_risk text,
  p_hard_stops text[],
  p_result text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
           (public._supplier_risk_evaluate(p_rules_version, p_level, p_answers) - 'pending_hard_stops')
             = pg_catalog.jsonb_build_object('starting_risk', p_starting_risk, 'evidence', p_evidence,
                                             'residual_risk', p_residual_risk,
                                             'hard_stops', pg_catalog.to_jsonb(p_hard_stops), 'result', p_result),
           false);
$$;

revoke all on function public._supplier_risk_computed_ok(smallint, text, jsonb, text, text, text, text[], text) from public, anon, authenticated, service_role;

comment on function public._supplier_risk_computed_ok(smallint, text, jsonb, text, text, text, text[], text) is
  'Private (0481). True when the stored starting risk, evidence, risk left, hard stops and computed result are what _supplier_risk_evaluate gives for the stored answers; false otherwise (null included). Used by the reviews table''s CHECK. No API role may call it.';

-- The default next review date: 12 months after p_from, 6 with student data
-- (a month's last day where the day does not exist: 2026-08-31 + 6 months is
-- 2027-02-28, as core's addVendorRiskMonths).
create function public._supplier_risk_default_next_review(p_level text, p_from date)
returns date
language sql
immutable
set search_path = ''
as $$
  select (p_from + pg_catalog.make_interval(months => case p_level when 'student' then 6
                                                                    when 'staff' then 12
                                                                    when 'none' then 12 end))::date;
$$;

revoke all on function public._supplier_risk_default_next_review(text, date) from public, anon, authenticated, service_role;

comment on function public._supplier_risk_default_next_review(text, date) is
  'Private (0481). The default next review date: p_from plus 12 months (none, staff) or 6 months (student), the month''s last day where the day does not exist; null for another level. The same as core''s vendorRiskDefaultNextReview. No API role may call it.';

-- The organization's zone: organizations.timezone when it is an IANA name the
-- server knows (or UTC, GMT), else America/Los_Angeles, core's
-- ORG_TIMEZONE_DEFAULT (0379's reading, the same text). Dates of this file
-- (today, the next review date, an item's due date) are days in this zone.
create function public._supplier_risk_org_zone(p_organization_id uuid)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_raw text;
begin
  select nullif(pg_catalog.btrim(o.timezone), '') into v_raw
    from public.organizations o
   where o.id = p_organization_id;
  if v_raw is not null
     and (v_raw in ('UTC', 'GMT') or v_raw ~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+){1,2}$') then
    begin
      perform pg_catalog.now() at time zone v_raw;
      return v_raw;
    exception when invalid_parameter_value then
      null;  -- the fallback below
    end;
  end if;
  return 'America/Los_Angeles';
end;
$$;

revoke all on function public._supplier_risk_org_zone(uuid) from public, anon, authenticated, service_role;

comment on function public._supplier_risk_org_zone(uuid) is
  'Private (0481). The organization''s zone: organizations.timezone when it is an IANA Area/Location name (or UTC, GMT) the server knows, else America/Los_Angeles (core''s ORG_TIMEZONE_DEFAULT). SECURITY INVOKER: its callers run as their owner. No API role may call it.';

-- ── The reviews ──────────────────────────────────────────────────────────────
create table public.supplier_risk_reviews (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  uuid        not null references public.organizations(id) on delete cascade,
  -- No foreign key: a review outlives its supplier (see the header).
  supplier_id      uuid        not null,
  -- The supplier's name as it was at the last save of this version.
  supplier_name    text        not null,
  version          integer     not null,
  status           text        not null default 'draft',
  is_current       boolean     not null default false,
  rules_version    smallint    not null default 1,
  data_level       text        not null,
  answers          jsonb       not null default '{}'::jsonb,
  -- What the rules give, for a final review (a CHECK holds them to the rules).
  starting_risk    text,
  evidence         text,
  residual_risk    text,
  hard_stops       text[],
  computed_result  text,
  -- The admin's override of the result, with its reason (both or neither).
  override_result  text,
  override_reason  text,
  result           text        generated always as (coalesce(override_result, computed_result)) stored,
  -- Who wrote the draft last, or finished the review; the link empties when
  -- the account is deleted, the name stays.
  reviewer_id      uuid        references public.user_profiles(id) on delete set null,
  reviewer_name    text        not null,
  reviewed_at      timestamptz,
  next_review_on   date,
  -- When the daily job claimed each reminder (stamped before sending).
  reminded_30_at   timestamptz,
  reminded_due_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint supplier_risk_reviews_org_id_key unique (organization_id, id),
  constraint supplier_risk_reviews_version_key unique (supplier_id, version),
  constraint supplier_risk_reviews_status
    check (status in ('draft', 'final')),
  constraint supplier_risk_reviews_version
    check (version between 1 and 100000),
  constraint supplier_risk_reviews_rules_version
    check (rules_version = 1),
  constraint supplier_risk_reviews_data_level
    check (data_level in ('none', 'staff', 'student')),
  constraint supplier_risk_reviews_current_is_final
    check (not is_current or status = 'final'),
  -- The answers, against the fixed list: every row, every path.
  constraint supplier_risk_reviews_answers
    check (public._supplier_risk_answers_problem(rules_version, data_level, answers, status = 'final') is null),
  -- A draft has no result, review time, next date, override or reminder; a
  -- final has all that the rules give, equal to the rules applied to its
  -- answers, and its time and next date.
  constraint supplier_risk_reviews_computed
    check ((status = 'draft'
            and pg_catalog.num_nulls(starting_risk, evidence, residual_risk, hard_stops, computed_result,
                                     override_result, override_reason, reviewed_at, next_review_on,
                                     reminded_30_at, reminded_due_at) = 11)
        or (status = 'final'
            and pg_catalog.num_nonnulls(starting_risk, evidence, residual_risk, hard_stops, computed_result,
                                        reviewed_at, next_review_on) = 7
            and public._supplier_risk_computed_ok(rules_version, data_level, answers, starting_risk, evidence,
                                                  residual_risk, hard_stops, computed_result))),
  -- An override names another result and has its reason; none has neither.
  -- Every term is spelled out so the check is never unknown (an unknown
  -- CHECK passes): a reason with no result is false here, not null.
  constraint supplier_risk_reviews_override
    check ((override_result is null and override_reason is null)
        or (override_result is not null and override_reason is not null
            and override_result in ('approve', 'approve_with_conditions', 'more_information', 'do_not_use')
            and override_result is distinct from computed_result
            and public._supplier_risk_reason_ok(override_reason))),
  constraint supplier_risk_reviews_supplier_name
    check (char_length(supplier_name) between 1 and 300),
  constraint supplier_risk_reviews_reviewer_name
    check (char_length(reviewer_name) between 1 and 200),
  constraint supplier_risk_reviews_next_review_on
    check (next_review_on is null or next_review_on between date '2000-01-01' and date '2200-12-31')
);

-- At most one current review and one draft per supplier.
create unique index supplier_risk_reviews_one_current
  on public.supplier_risk_reviews (supplier_id)
  where is_current;
create unique index supplier_risk_reviews_one_draft
  on public.supplier_risk_reviews (supplier_id)
  where status = 'draft';
-- The register and the history (and the cascade from organizations).
create index supplier_risk_reviews_org_supplier_idx
  on public.supplier_risk_reviews (organization_id, supplier_id, version desc);
-- The reminder read.
create index supplier_risk_reviews_next_review_idx
  on public.supplier_risk_reviews (next_review_on)
  where is_current;
-- An account deleted empties its links without a scan.
create index supplier_risk_reviews_reviewer_idx
  on public.supplier_risk_reviews (reviewer_id)
  where reviewer_id is not null;

comment on table public.supplier_risk_reviews is
  'Vendor risk reviews (0481): one row per version of a supplier''s review, draft (at most one per supplier) or final (kept as it was: a trigger refuses any change but the marks). The newest final is current: one per supplier that has a final. The answers are checked against the fixed question list, and a final''s result equals the rules applied to its answers, both by CHECK. supplier_id has no foreign key: a review outlives its supplier. RLS on, no policy, no privilege to any API role: read and written only through the supplier_risk_* functions, for an organization''s owners and admins (and the daily job''s two reminder functions).';
comment on column public.supplier_risk_reviews.supplier_id is
  'The supplier reviewed. A plain uuid with no foreign key, so archiving or deleting the supplier changes nothing here; the reads mark the row active, archived or deleted from the suppliers table as it is now.';
comment on column public.supplier_risk_reviews.answers is
  'Question key to {"answer": "yes" | "no" | "not_shown", "note": text or null, "date": "YYYY-MM-DD" or null}, only for questions asked at the data level; a final answers every one of them. Checked by _supplier_risk_answers_problem.';
comment on column public.supplier_risk_reviews.result is
  'The result in force: the override when there is one, else the computed result. Generated.';
comment on column public.supplier_risk_reviews.reviewer_name is
  'The reviewer''s name (or email) as it was when they saved: kept when the account is deleted and reviewer_id empties.';
comment on column public.supplier_risk_reviews.next_review_on is
  'The next review date, a day in the organization''s zone (_supplier_risk_org_zone). The brief''s next_review_at: a date, not a moment.';
comment on column public.supplier_risk_reviews.reminded_30_at is
  'When the daily job claimed the reminder 30 days before the next review date (stamped before sending; a crash loses the reminder rather than repeating it).';
comment on column public.supplier_risk_reviews.reminded_due_at is
  'When the daily job claimed the reminder on (or after) the next review date (stamped before sending).';

-- ── The items ────────────────────────────────────────────────────────────────
create table public.supplier_risk_items (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  uuid        not null,
  review_id        uuid        not null,
  question_key     text        not null,
  answer           text        not null,
  severity         text        not null,
  finding          text        not null,
  action           text        not null,
  owner_user_id    uuid        references public.user_profiles(id) on delete set null,
  owner_name       text,
  due_on           date,
  status           text        not null default 'open',
  closed_at        timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- The review, in the same organization.
  constraint supplier_risk_items_review_fkey foreign key (organization_id, review_id)
    references public.supplier_risk_reviews (organization_id, id) on delete cascade,
  constraint supplier_risk_items_one_per_question unique (review_id, question_key),
  constraint supplier_risk_items_question_key
    check (public._supplier_risk_question_key_ok(question_key)),
  constraint supplier_risk_items_answer
    check (answer in ('no', 'not_shown')),
  constraint supplier_risk_items_severity
    check (severity in ('low', 'medium', 'high', 'critical')),
  constraint supplier_risk_items_status
    check (status in ('open', 'in_progress', 'done', 'accepted')),
  -- Done and accepted close an item; open and in_progress do not.
  constraint supplier_risk_items_closed
    check ((status in ('done', 'accepted')) = (closed_at is not null)),
  constraint supplier_risk_items_finding
    check (public._supplier_risk_text_ok(finding, 1, 500)),
  constraint supplier_risk_items_action
    check (public._supplier_risk_text_ok(action, 1, 1000)),
  constraint supplier_risk_items_owner_name
    check (owner_name is null or char_length(owner_name) between 1 and 200),
  -- An owner is always named; a name with no link is an owner whose account
  -- was deleted.
  constraint supplier_risk_items_owner_named
    check (owner_user_id is null or owner_name is not null),
  constraint supplier_risk_items_due_on
    check (due_on is null or due_on between date '2000-01-01' and date '2200-12-31')
);

create index supplier_risk_items_owner_idx
  on public.supplier_risk_items (owner_user_id)
  where owner_user_id is not null;

comment on table public.supplier_risk_items is
  'The vendor risk register (0481): one row for each gap (an asked question answered No or Not shown to us) of a final review, written with it: the answer, the rules'' severity, the finding and action, an owner (a member, with a name snapshot), a due date, a status (open, in_progress, done, accepted) and when it was closed. The question, answer, severity and finding stay as written (a trigger). RLS on, no policy, no privilege to any API role: read and written only through the supplier_risk_* functions.';
comment on column public.supplier_risk_items.owner_name is
  'The owner''s name (or email) when they were made the owner: kept when the account is deleted and owner_user_id empties.';

-- RLS on and no policy: no API role reads or writes a row directly.
alter table public.supplier_risk_reviews enable row level security;
alter table public.supplier_risk_items enable row level security;

-- Supabase's default privileges give anon, authenticated and service_role
-- every privilege on a new public table; the change Supabase set for
-- 2026-10-30 (0402's note) takes SELECT, INSERT, UPDATE and DELETE out of
-- them. Everything is revoked from all of them here and nothing is granted,
-- so both tables end the same under either set of defaults.
revoke all on table public.supplier_risk_reviews from public, anon, authenticated, service_role;
revoke all on table public.supplier_risk_items from public, anon, authenticated, service_role;

-- ── What is kept as written ──────────────────────────────────────────────────
-- A final review is evidence: on any path (the owner, a future function), an
-- update of a final may only clear is_current, stamp a reminder once, empty
-- the reviewer link (an account deleted) and move updated_at. It may never
-- go back to draft, become current again, or change anything it says.
create function public._supplier_risk_reviews_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'final'
     and (new.status <> 'final'
          or (new.id, new.organization_id, new.supplier_id, new.supplier_name, new.version, new.rules_version,
              new.data_level, new.answers, new.starting_risk, new.evidence, new.residual_risk, new.hard_stops,
              new.computed_result, new.override_result, new.override_reason, new.reviewer_name, new.reviewed_at,
              new.next_review_on, new.created_at)
             is distinct from
             (old.id, old.organization_id, old.supplier_id, old.supplier_name, old.version, old.rules_version,
              old.data_level, old.answers, old.starting_risk, old.evidence, old.residual_risk, old.hard_stops,
              old.computed_result, old.override_result, old.override_reason, old.reviewer_name, old.reviewed_at,
              old.next_review_on, old.created_at)
          or (new.reviewer_id is distinct from old.reviewer_id and new.reviewer_id is not null)
          or (new.is_current and not old.is_current)
          or (old.reminded_30_at is not null and new.reminded_30_at is distinct from old.reminded_30_at)
          or (old.reminded_due_at is not null and new.reminded_due_at is distinct from old.reminded_due_at)) then
    raise exception 'supplier_risk_final_is_kept' using errcode = '55000', hint = 'supplier_risk_final_is_kept';
  end if;
  return new;
end;
$$;

revoke all on function public._supplier_risk_reviews_guard() from public, anon, authenticated, service_role;

comment on function public._supplier_risk_reviews_guard() is
  'Private (0481), the trigger function of supplier_risk_reviews_kept: an update of a final review may only clear is_current, stamp each reminder once, empty reviewer_id (an account deleted) and move updated_at; anything else raises 55000 supplier_risk_final_is_kept. A draft may change freely. No API role may call it.';

create trigger supplier_risk_reviews_kept
  before update on public.supplier_risk_reviews
  for each row execute function public._supplier_risk_reviews_guard();

-- An item's question, answer, severity and finding stay as written, and it
-- stays with its review; the owner, due date, status, closing time, action
-- and updated_at may change (the owner link also empties when the account is
-- deleted).
create function public._supplier_risk_items_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.organization_id, new.review_id, new.question_key, new.answer, new.severity, new.finding,
      new.created_at)
     is distinct from
     (old.id, old.organization_id, old.review_id, old.question_key, old.answer, old.severity, old.finding,
      old.created_at) then
    raise exception 'supplier_risk_final_is_kept' using errcode = '55000', hint = 'supplier_risk_final_is_kept';
  end if;
  return new;
end;
$$;

revoke all on function public._supplier_risk_items_guard() from public, anon, authenticated, service_role;

comment on function public._supplier_risk_items_guard() is
  'Private (0481), the trigger function of supplier_risk_items_kept: an item''s id, organization, review, question, answer, severity, finding and creation time never change (55000 supplier_risk_final_is_kept). No API role may call it.';

create trigger supplier_risk_items_kept
  before update on public.supplier_risk_items
  for each row execute function public._supplier_risk_items_guard();

-- ── The admins' reads ────────────────────────────────────────────────────────
-- Every admin function opens the same way, in its own body (security
-- invariants INV-25 reads it there): 42501 supplier_risk_not_allowed unless
-- the caller is an admin or owner of the organization; then 0472's check,
-- which makes the same role check and applies the authenticator rule (hint
-- mfa_required or aal2_required).

create function public.supplier_risk_register(p_organization_id uuid)
returns table (
  supplier_id               uuid,
  supplier_name             text,
  supplier_state            text,
  supplier_archived_at      timestamptz,
  review_id                 uuid,
  version                   integer,
  data_level                text,
  result                    text,
  computed_result           text,
  overridden                boolean,
  starting_risk             text,
  evidence                  text,
  residual_risk             text,
  hard_stops                text[],
  reviewed_at               timestamptz,
  reviewer_name             text,
  reviewer_account_deleted  boolean,
  next_review_on            date,
  review_due                text,
  open_items                integer,
  top_open_severity         text,
  draft_review_id           uuid,
  draft_updated_at          timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date;
begin
  if p_organization_id is null
     or not coalesce(public.has_org_role(p_organization_id, 'admin'), false) then
    raise exception 'supplier_risk_not_allowed' using errcode = '42501', hint = 'supplier_risk_not_allowed';
  end if;
  perform public.security_events_reader_check(p_organization_id);

  v_today := (pg_catalog.now() at time zone public._supplier_risk_org_zone(p_organization_id))::date;

  return query
    with sup as (
      select s.id, s.name, s.deleted_at
        from public.suppliers s
       where s.organization_id = p_organization_id
    ),
    revs as (
      select r.*
        from public.supplier_risk_reviews r
       where r.organization_id = p_organization_id
    ),
    ids as (
      select s.id from sup s where s.deleted_at is null
      union
      select r.supplier_id from revs r
    ),
    latest_name as (
      select distinct on (r.supplier_id) r.supplier_id, r.supplier_name
        from revs r
       order by r.supplier_id, r.version desc
    ),
    cur as (
      select r.* from revs r where r.is_current
    ),
    dft as (
      select r.supplier_id, r.id, r.updated_at from revs r where r.status = 'draft'
    ),
    its as (
      select i.review_id,
             pg_catalog.count(*) filter (where i.status in ('open', 'in_progress'))::integer as open_n,
             pg_catalog.max(case i.severity when 'critical' then 4 when 'high' then 3 when 'medium' then 2 else 1 end)
               filter (where i.status in ('open', 'in_progress')) as top
        from public.supplier_risk_items i
        join cur c on c.id = i.review_id
       group by i.review_id
    )
    select ids.id,
           coalesce(s.name, ln.supplier_name),
           case when s.id is null then 'deleted' when s.deleted_at is not null then 'archived' else 'active' end,
           s.deleted_at,
           c.id, c.version, c.data_level, c.result, c.computed_result, (c.override_result is not null),
           c.starting_risk, c.evidence, c.residual_risk, c.hard_stops,
           c.reviewed_at, c.reviewer_name, (c.id is not null and c.reviewer_id is null),
           c.next_review_on,
           case when c.id is null then 'not_reviewed'
                when c.next_review_on < v_today then 'overdue'
                when c.next_review_on = v_today then 'due_today'
                when c.next_review_on <= v_today + 30 then 'due_soon'
                else 'scheduled' end,
           coalesce(it.open_n, 0),
           case it.top when 4 then 'critical' when 3 then 'high' when 2 then 'medium' when 1 then 'low' end,
           d.id, d.updated_at
      from ids
      left join sup s on s.id = ids.id
      left join latest_name ln on ln.supplier_id = ids.id
      left join cur c on c.supplier_id = ids.id
      left join dft d on d.supplier_id = ids.id
      left join its it on it.review_id = c.id
     order by pg_catalog.lower(coalesce(s.name, ln.supplier_name)), ids.id;
end;
$$;

revoke all on function public.supplier_risk_register(uuid) from public, anon, authenticated, service_role;
grant execute on function public.supplier_risk_register(uuid) to authenticated;

comment on function public.supplier_risk_register(uuid) is
  'The vendor risk register of an organization (0481), for its owners and admins: every active supplier, and every archived or deleted one that has a review, by name: supplier_state (active, archived, deleted) and archived time; the current review''s id, version, data level, result in force, computed result, overridden, starting risk, evidence, risk left, hard stops, when and by whom (reviewer_account_deleted when the link emptied), next review date and review_due (not_reviewed, overdue, due_today, due_soon within 30 days, scheduled; days in the organization''s zone); its open items (open and in_progress) and the highest severity among them; the open draft''s id and time. 42501 supplier_risk_not_allowed for anyone else; 42501 mfa_required or aal2_required where the second step is owed. Read-only.';

create function public.supplier_risk_history(p_organization_id uuid, p_supplier_id uuid)
returns table (
  review_id        uuid,
  version          integer,
  status           text,
  is_current       boolean,
  data_level       text,
  result           text,
  computed_result  text,
  overridden       boolean,
  residual_risk    text,
  reviewed_at      timestamptz,
  reviewer_name    text,
  next_review_on   date,
  created_at       timestamptz,
  updated_at       timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_organization_id is null
     or not coalesce(public.has_org_role(p_organization_id, 'admin'), false) then
    raise exception 'supplier_risk_not_allowed' using errcode = '42501', hint = 'supplier_risk_not_allowed';
  end if;
  perform public.security_events_reader_check(p_organization_id);

  return query
    select r.id, r.version, r.status, r.is_current, r.data_level, r.result, r.computed_result,
           (r.override_result is not null), r.residual_risk, r.reviewed_at, r.reviewer_name, r.next_review_on,
           r.created_at, r.updated_at
      from public.supplier_risk_reviews r
     where r.organization_id = p_organization_id
       and r.supplier_id = p_supplier_id
     order by r.version desc;
end;
$$;

revoke all on function public.supplier_risk_history(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.supplier_risk_history(uuid, uuid) to authenticated;

comment on function public.supplier_risk_history(uuid, uuid) is
  'Every version of one supplier''s review in an organization (0481), newest first: id, version, status (draft, final), is_current, data level, result in force, computed result, overridden, risk left, when and by whom, next review date, created and updated times. None for a supplier of another organization. For its owners and admins only: 42501 as supplier_risk_register. Read-only.';

-- One item as the reads give it.
create function public._supplier_risk_item_json(p_item public.supplier_risk_items)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'id', p_item.id,
    'review_id', p_item.review_id,
    'question_key', p_item.question_key,
    'answer', p_item.answer,
    'severity', p_item.severity,
    'finding', p_item.finding,
    'action', p_item.action,
    'owner_user_id', p_item.owner_user_id,
    'owner_name', p_item.owner_name,
    'owner_is_member', p_item.owner_user_id is not null and exists (
        select 1 from public.organization_members m
         where m.organization_id = p_item.organization_id and m.user_id = p_item.owner_user_id
           and m.accepted_at is not null and m.impersonation_expires_at is null
           and not exists (select 1 from public.user_profiles up
                            where up.id = m.user_id and up.disabled_at is not null)),
    'due_on', p_item.due_on,
    'status', p_item.status,
    'closed_at', p_item.closed_at,
    'created_at', p_item.created_at,
    'updated_at', p_item.updated_at);
$$;

revoke all on function public._supplier_risk_item_json(public.supplier_risk_items) from public, anon, authenticated, service_role;

comment on function public._supplier_risk_item_json(public.supplier_risk_items) is
  'Private (0481). One item as the reads give it, with owner_is_member (the owner is still a current member: accepted, not an act-as seat, account not disabled). SECURITY INVOKER: its callers run as their owner. No API role may call it.';

create function public.supplier_risk_review(p_organization_id uuid, p_review_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_r      public.supplier_risk_reviews;
  v_state  text;
  v_items  jsonb;
begin
  if p_organization_id is null
     or not coalesce(public.has_org_role(p_organization_id, 'admin'), false) then
    raise exception 'supplier_risk_not_allowed' using errcode = '42501', hint = 'supplier_risk_not_allowed';
  end if;
  perform public.security_events_reader_check(p_organization_id);

  select r.* into v_r
    from public.supplier_risk_reviews r
   where r.id = p_review_id and r.organization_id = p_organization_id;
  if not found then
    return null;
  end if;

  select case when s.id is null then 'deleted' when s.deleted_at is not null then 'archived' else 'active' end
    into v_state
    from (select 1) one
    left join public.suppliers s on s.id = v_r.supplier_id and s.organization_id = v_r.organization_id;

  select coalesce(pg_catalog.jsonb_agg(public._supplier_risk_item_json(i) order by q.ord), '[]'::jsonb)
    into v_items
    from public.supplier_risk_items i
    join public._supplier_risk_questions() q on q.key = i.question_key
   where i.review_id = v_r.id;

  return pg_catalog.jsonb_build_object(
    'id', v_r.id,
    'organization_id', v_r.organization_id,
    'supplier_id', v_r.supplier_id,
    'supplier_name', v_r.supplier_name,
    'supplier_state', v_state,
    'version', v_r.version,
    'status', v_r.status,
    'is_current', v_r.is_current,
    'rules_version', v_r.rules_version,
    'data_level', v_r.data_level,
    'answers', v_r.answers,
    'starting_risk', v_r.starting_risk,
    'evidence', v_r.evidence,
    'residual_risk', v_r.residual_risk,
    'hard_stops', pg_catalog.to_jsonb(v_r.hard_stops),
    'computed_result', v_r.computed_result,
    'override_result', v_r.override_result,
    'override_reason', v_r.override_reason,
    'result', v_r.result,
    'reviewer_id', v_r.reviewer_id,
    'reviewer_name', v_r.reviewer_name,
    'reviewed_at', v_r.reviewed_at,
    'next_review_on', v_r.next_review_on,
    'reminded_30_at', v_r.reminded_30_at,
    'reminded_due_at', v_r.reminded_due_at,
    'created_at', v_r.created_at,
    'updated_at', v_r.updated_at,
    'items', v_items);
end;
$$;

revoke all on function public.supplier_risk_review(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.supplier_risk_review(uuid, uuid) to authenticated;

comment on function public.supplier_risk_review(uuid, uuid) is
  'One version of a review, whole (0481): id, organization_id, supplier_id, supplier_name (the snapshot), supplier_state (active, archived, deleted), version, status, is_current, rules_version, data_level, answers, starting_risk, evidence, residual_risk, hard_stops, computed_result, override_result, override_reason, result, reviewer_id, reviewer_name, reviewed_at, next_review_on, reminded_30_at, reminded_due_at, created_at, updated_at, and items (in question order: id, review_id, question_key, answer, severity, finding, action, owner_user_id, owner_name, owner_is_member, due_on, status, closed_at, created_at, updated_at). Null when there is no such review in the organization. For its owners and admins only: 42501 as supplier_risk_register. Read-only.';

create function public.supplier_risk_items_for_organization(p_organization_id uuid, p_open_only boolean default true)
returns table (
  item_id          uuid,
  review_id        uuid,
  supplier_id      uuid,
  supplier_name    text,
  supplier_state   text,
  question_key     text,
  answer           text,
  severity         text,
  finding          text,
  action           text,
  owner_user_id    uuid,
  owner_name       text,
  owner_is_member  boolean,
  due_on           date,
  status           text,
  closed_at        timestamptz,
  created_at       timestamptz,
  updated_at       timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_organization_id is null
     or not coalesce(public.has_org_role(p_organization_id, 'admin'), false) then
    raise exception 'supplier_risk_not_allowed' using errcode = '42501', hint = 'supplier_risk_not_allowed';
  end if;
  perform public.security_events_reader_check(p_organization_id);

  return query
    select i.id, i.review_id, r.supplier_id, coalesce(s.name, r.supplier_name),
           case when s.id is null then 'deleted' when s.deleted_at is not null then 'archived' else 'active' end,
           i.question_key, i.answer, i.severity, i.finding, i.action, i.owner_user_id, i.owner_name,
           (i.owner_user_id is not null and exists (
              select 1 from public.organization_members m
               where m.organization_id = i.organization_id and m.user_id = i.owner_user_id
                 and m.accepted_at is not null and m.impersonation_expires_at is null
                 and not exists (select 1 from public.user_profiles up
                                  where up.id = m.user_id and up.disabled_at is not null))),
           i.due_on, i.status, i.closed_at, i.created_at, i.updated_at
      from public.supplier_risk_reviews r
      join public.supplier_risk_items i on i.review_id = r.id and i.organization_id = r.organization_id
      join public._supplier_risk_questions() q on q.key = i.question_key
      left join public.suppliers s on s.id = r.supplier_id and s.organization_id = r.organization_id
     where r.organization_id = p_organization_id
       and r.is_current
       and (not coalesce(p_open_only, true) or i.status in ('open', 'in_progress'))
     order by case i.severity when 'critical' then 1 when 'high' then 2 when 'medium' then 3 else 4 end,
              i.due_on nulls last,
              pg_catalog.lower(coalesce(s.name, r.supplier_name)),
              r.supplier_id,
              q.ord;
end;
$$;

revoke all on function public.supplier_risk_items_for_organization(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.supplier_risk_items_for_organization(uuid, boolean) to authenticated;

comment on function public.supplier_risk_items_for_organization(uuid, boolean) is
  'The items of an organization''s current reviews (0481), open and in_progress only unless p_open_only is false: item_id, review_id, supplier_id, supplier_name, supplier_state, question_key, answer, severity, finding, action, owner_user_id, owner_name, owner_is_member, due_on, status, closed_at, created_at, updated_at; most severe first, then by due date (none last), supplier and question. For its owners and admins only: 42501 as supplier_risk_register. Read-only.';

-- ── The admins' writes ───────────────────────────────────────────────────────
-- Each write takes this file's advisory lock for the supplier (4810001 and
-- the supplier id's hash), so two writes for one supplier run one after the
-- other; a wait ends after 5 s (55P03).

-- The caller's name as a review or an item keeps it.
create function public._supplier_risk_person_name(p_user_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select pg_catalog.left(coalesce(
           (select coalesce(nullif(pg_catalog.btrim(p.full_name), ''), nullif(pg_catalog.btrim(p.email::text), ''))
              from public.user_profiles p where p.id = p_user_id),
           'Unknown'), 200);
$$;

revoke all on function public._supplier_risk_person_name(uuid) from public, anon, authenticated, service_role;

comment on function public._supplier_risk_person_name(uuid) is
  'Private (0481). A person''s name for a snapshot: their full name, else their email, else Unknown, at most 200 characters. SECURITY INVOKER: its callers run as their owner. No API role may call it.';

-- Is this person a current member of the organization: an accepted
-- membership that is not an act-as seat, on an account that is not disabled
-- (0422's rule, the same text as _notify_is_current_member's).
create function public._supplier_risk_is_current_member(p_organization_id uuid, p_user_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.organization_members m
     where m.organization_id = p_organization_id
       and m.user_id = p_user_id
       and m.accepted_at is not null
       and m.impersonation_expires_at is null
       and not exists (select 1 from public.user_profiles up
                        where up.id = m.user_id and up.disabled_at is not null));
$$;

revoke all on function public._supplier_risk_is_current_member(uuid, uuid) from public, anon, authenticated, service_role;

comment on function public._supplier_risk_is_current_member(uuid, uuid) is
  'Private (0481). Is this person a current member of the organization: accepted, not an act-as seat, account not disabled (0422''s rule). False for a null person. SECURITY INVOKER: its callers run as their owner. No API role may call it.';

create function public.supplier_risk_draft_save(
  p_organization_id uuid,
  p_supplier_id uuid,
  p_data_level text,
  p_answers jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_uid      uuid := auth.uid();
  v_name     text;
  v_archived timestamptz;
  v_problem  text;
  v_id       uuid;
  v_version  integer;
  v_updated  timestamptz;
begin
  if p_organization_id is null
     or not coalesce(public.has_org_role(p_organization_id, 'admin'), false) then
    raise exception 'supplier_risk_not_allowed' using errcode = '42501', hint = 'supplier_risk_not_allowed';
  end if;
  perform public.security_events_reader_check(p_organization_id);

  if p_supplier_id is null then
    raise exception 'supplier_not_found' using errcode = '22023', hint = 'supplier_not_found';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(4810001, pg_catalog.hashtext(p_supplier_id::text));

  -- The supplier's own organization, not only its id.
  select s.name, s.deleted_at into v_name, v_archived
    from public.suppliers s
   where s.id = p_supplier_id and s.organization_id = p_organization_id;
  if not found then
    raise exception 'supplier_not_found' using errcode = '22023', hint = 'supplier_not_found';
  end if;
  if v_archived is not null then
    raise exception 'supplier_archived' using errcode = '22023', hint = 'supplier_archived';
  end if;

  v_problem := public._supplier_risk_answers_problem(1::smallint, p_data_level, p_answers, false);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = '22023', hint = v_problem;
  end if;

  v_name := pg_catalog.left(coalesce(nullif(pg_catalog.btrim(v_name), ''), '(no name)'), 300);

  update public.supplier_risk_reviews r
     set data_level = p_data_level,
         answers = p_answers,
         supplier_name = v_name,
         reviewer_id = v_uid,
         reviewer_name = public._supplier_risk_person_name(v_uid),
         updated_at = pg_catalog.now()
   where r.supplier_id = p_supplier_id
     and r.organization_id = p_organization_id
     and r.status = 'draft'
  returning r.id, r.version, r.updated_at into v_id, v_version, v_updated;

  if v_id is null then
    insert into public.supplier_risk_reviews
      (organization_id, supplier_id, supplier_name, version, status, data_level, answers, reviewer_id, reviewer_name)
    values
      (p_organization_id, p_supplier_id, v_name,
       coalesce((select pg_catalog.max(r.version) from public.supplier_risk_reviews r
                  where r.supplier_id = p_supplier_id), 0) + 1,
       'draft', p_data_level, p_answers, v_uid, public._supplier_risk_person_name(v_uid))
    returning id, version, updated_at into v_id, v_version, v_updated;
  end if;

  return pg_catalog.jsonb_build_object('review_id', v_id, 'version', v_version, 'updated_at', v_updated);
end;
$$;

revoke all on function public.supplier_risk_draft_save(uuid, uuid, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.supplier_risk_draft_save(uuid, uuid, text, jsonb) to authenticated;

comment on function public.supplier_risk_draft_save(uuid, uuid, text, jsonb) is
  'Writes the one draft review of a supplier (0481): updates it when there is one, else makes version max + 1; keeps the caller as the reviewer and the supplier''s name. Answers may be partial (every given key must be asked at the level). Returns {review_id, version, updated_at}. 42501 supplier_risk_not_allowed (not an admin or owner of the organization), mfa_required, aal2_required; 22023 supplier_not_found (none, or of another organization), supplier_archived, and the answer words of _supplier_risk_answers_problem (bad_data_level, answers_not_an_object, answer_unknown_question, answer_not_applicable, answer_bad_shape, answer_bad_value, answer_bad_note, answer_date_not_allowed, answer_bad_date). Takes the supplier''s lock (4810001); a wait ends after 5 s (55P03).';

create function public.supplier_risk_finalise(
  p_organization_id uuid,
  p_supplier_id uuid,
  p_data_level text,
  p_answers jsonb,
  p_next_review_on date default null,
  p_override_result text default null,
  p_override_reason text default null,
  p_items jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_uid        uuid := auth.uid();
  v_name       text;
  v_archived   timestamptz;
  v_problem    text;
  v_eval       jsonb;
  v_zone       text;
  v_today      date;
  v_next       date;
  v_items      jsonb := coalesce(p_items, '[]'::jsonb);
  v_gaps       text[];
  v_given      text[] := '{}';
  v_el         jsonb;
  v_key        text;
  v_owner      uuid;
  v_due        date;
  v_text       text;
  v_id         uuid;
  v_version    integer;
  v_old        uuid;
  v_hard       text[];
begin
  if p_organization_id is null
     or not coalesce(public.has_org_role(p_organization_id, 'admin'), false) then
    raise exception 'supplier_risk_not_allowed' using errcode = '42501', hint = 'supplier_risk_not_allowed';
  end if;
  perform public.security_events_reader_check(p_organization_id);

  if p_supplier_id is null then
    raise exception 'supplier_not_found' using errcode = '22023', hint = 'supplier_not_found';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(4810001, pg_catalog.hashtext(p_supplier_id::text));

  select s.name, s.deleted_at into v_name, v_archived
    from public.suppliers s
   where s.id = p_supplier_id and s.organization_id = p_organization_id;
  if not found then
    raise exception 'supplier_not_found' using errcode = '22023', hint = 'supplier_not_found';
  end if;
  if v_archived is not null then
    raise exception 'supplier_archived' using errcode = '22023', hint = 'supplier_archived';
  end if;
  v_name := pg_catalog.left(coalesce(nullif(pg_catalog.btrim(v_name), ''), '(no name)'), 300);

  v_problem := public._supplier_risk_answers_problem(1::smallint, p_data_level, p_answers, true);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = '22023', hint = v_problem;
  end if;
  v_eval := public._supplier_risk_evaluate(1::smallint, p_data_level, p_answers);

  v_zone := public._supplier_risk_org_zone(p_organization_id);
  v_today := (pg_catalog.now() at time zone v_zone)::date;

  -- The next review: after today and at most three years ahead, or the
  -- default for the level.
  if p_next_review_on is null then
    v_next := public._supplier_risk_default_next_review(p_data_level, v_today);
  elsif p_next_review_on <= v_today or p_next_review_on > (v_today + interval '3 years')::date then
    raise exception 'bad_next_review_on' using errcode = '22023', hint = 'bad_next_review_on';
  else
    v_next := p_next_review_on;
  end if;

  -- The override: another of the four results, with its reason; or neither.
  if p_override_result is not null or p_override_reason is not null then
    if p_override_result is null
       or p_override_result not in ('approve', 'approve_with_conditions', 'more_information', 'do_not_use')
       or p_override_result = (v_eval ->> 'result') then
      raise exception 'bad_override' using errcode = '22023', hint = 'bad_override';
    end if;
    if not public._supplier_risk_reason_ok(p_override_reason) then
      raise exception 'bad_override_reason' using errcode = '22023', hint = 'bad_override_reason';
    end if;
  end if;

  -- The items: exactly one for each gap, by question key.
  select coalesce(pg_catalog.array_agg(q.key order by q.ord), '{}')
    into v_gaps
    from public._supplier_risk_questions() q
   where p_data_level <> 'none' and (not q.student_only or p_data_level = 'student')
     and (p_answers -> q.key ->> 'answer') in ('no', 'not_shown');
  if pg_catalog.jsonb_typeof(v_items) <> 'array' then
    raise exception 'items_not_an_array' using errcode = '22023', hint = 'items_not_an_array';
  end if;
  if pg_catalog.jsonb_array_length(v_items) <> pg_catalog.cardinality(v_gaps) then
    raise exception 'items_do_not_match_answers' using errcode = '22023', hint = 'items_do_not_match_answers';
  end if;
  for v_el in select e.value from pg_catalog.jsonb_array_elements(v_items) e loop
    if pg_catalog.jsonb_typeof(v_el) <> 'object'
       or exists (select 1 from pg_catalog.jsonb_object_keys(v_el) f
                   where f not in ('question_key', 'finding', 'action', 'owner_user_id', 'due_on'))
       or coalesce(pg_catalog.jsonb_typeof(v_el -> 'question_key'), '') <> 'string'
       or coalesce(pg_catalog.jsonb_typeof(v_el -> 'finding'), '') <> 'string'
       or coalesce(pg_catalog.jsonb_typeof(v_el -> 'action'), '') <> 'string'
       or coalesce(pg_catalog.jsonb_typeof(v_el -> 'owner_user_id'), 'null') not in ('null', 'string')
       or coalesce(pg_catalog.jsonb_typeof(v_el -> 'due_on'), 'null') not in ('null', 'string')
       or (v_el ->> 'owner_user_id') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       or (v_el ->> 'due_on') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'bad_item' using errcode = '22023', hint = 'bad_item';
    end if;
    v_key := v_el ->> 'question_key';
    if not (v_key = any (v_gaps)) or v_key = any (v_given) then
      raise exception 'items_do_not_match_answers' using errcode = '22023', hint = 'items_do_not_match_answers';
    end if;
    v_given := v_given || v_key;
    if not public._supplier_risk_text_ok(v_el ->> 'finding', 1, 500)
       or not public._supplier_risk_text_ok(v_el ->> 'action', 1, 1000) then
      raise exception 'bad_item_text' using errcode = '22023', hint = 'bad_item_text';
    end if;
    v_owner := (v_el ->> 'owner_user_id')::uuid;
    if v_owner is not null and not public._supplier_risk_is_current_member(p_organization_id, v_owner) then
      raise exception 'item_owner_not_a_member' using errcode = '22023', hint = 'item_owner_not_a_member';
    end if;
    begin
      v_due := (v_el ->> 'due_on')::date;
    exception when others then
      raise exception 'bad_item_due_on' using errcode = '22023', hint = 'bad_item_due_on';
    end;
    if v_due is not null and (v_due < v_today or v_due > (v_today + interval '3 years')::date) then
      raise exception 'bad_item_due_on' using errcode = '22023', hint = 'bad_item_due_on';
    end if;
  end loop;

  v_hard := array(select pg_catalog.jsonb_array_elements_text(v_eval -> 'hard_stops'));

  -- The current review becomes history first (the unique index allows one),
  -- then this version becomes current, in this transaction.
  update public.supplier_risk_reviews r
     set is_current = false
   where r.supplier_id = p_supplier_id and r.is_current
  returning r.id into v_old;

  update public.supplier_risk_reviews r
     set status = 'final',
         is_current = true,
         data_level = p_data_level,
         answers = p_answers,
         supplier_name = v_name,
         starting_risk = v_eval ->> 'starting_risk',
         evidence = v_eval ->> 'evidence',
         residual_risk = v_eval ->> 'residual_risk',
         hard_stops = v_hard,
         computed_result = v_eval ->> 'result',
         override_result = p_override_result,
         override_reason = p_override_reason,
         reviewer_id = v_uid,
         reviewer_name = public._supplier_risk_person_name(v_uid),
         reviewed_at = pg_catalog.now(),
         next_review_on = v_next,
         updated_at = pg_catalog.now()
   where r.supplier_id = p_supplier_id
     and r.organization_id = p_organization_id
     and r.status = 'draft'
  returning r.id, r.version into v_id, v_version;

  if v_id is null then
    insert into public.supplier_risk_reviews
      (organization_id, supplier_id, supplier_name, version, status, is_current, data_level, answers,
       starting_risk, evidence, residual_risk, hard_stops, computed_result, override_result, override_reason,
       reviewer_id, reviewer_name, reviewed_at, next_review_on)
    values
      (p_organization_id, p_supplier_id, v_name,
       coalesce((select pg_catalog.max(r.version) from public.supplier_risk_reviews r
                  where r.supplier_id = p_supplier_id), 0) + 1,
       'final', true, p_data_level, p_answers,
       v_eval ->> 'starting_risk', v_eval ->> 'evidence', v_eval ->> 'residual_risk', v_hard,
       v_eval ->> 'result', p_override_result, p_override_reason,
       v_uid, public._supplier_risk_person_name(v_uid), pg_catalog.now(), v_next)
    returning id, version into v_id, v_version;
  end if;

  insert into public.supplier_risk_items
    (organization_id, review_id, question_key, answer, severity, finding, action, owner_user_id, owner_name, due_on)
  select p_organization_id, v_id, q.key, p_answers -> q.key ->> 'answer',
         case when p_data_level = 'student' then q.severity_student else q.severity_staff end,
         e.value ->> 'finding', e.value ->> 'action',
         (e.value ->> 'owner_user_id')::uuid,
         case when e.value ->> 'owner_user_id' is not null
              then public._supplier_risk_person_name((e.value ->> 'owner_user_id')::uuid) end,
         (e.value ->> 'due_on')::date
    from pg_catalog.jsonb_array_elements(v_items) e
    join public._supplier_risk_questions() q on q.key = e.value ->> 'question_key';

  return pg_catalog.jsonb_build_object(
    'review_id', v_id,
    'version', v_version,
    'superseded_review_id', v_old,
    'starting_risk', v_eval ->> 'starting_risk',
    'evidence', v_eval ->> 'evidence',
    'residual_risk', v_eval ->> 'residual_risk',
    'hard_stops', v_eval -> 'hard_stops',
    'pending_hard_stops', v_eval -> 'pending_hard_stops',
    'computed_result', v_eval ->> 'result',
    'override_result', p_override_result,
    'result', coalesce(p_override_result, v_eval ->> 'result'),
    'next_review_on', v_next,
    'items', pg_catalog.cardinality(v_gaps));
end;
$$;

revoke all on function public.supplier_risk_finalise(uuid, uuid, text, jsonb, date, text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.supplier_risk_finalise(uuid, uuid, text, jsonb, date, text, text, jsonb) to authenticated;

comment on function public.supplier_risk_finalise(uuid, uuid, text, jsonb, date, text, text, jsonb) is
  'Finishes a supplier''s review in one transaction (0481): the open draft (or a new version) becomes final and current with these answers (every question asked at the level answered), what the database''s rules give (never a result sent to it), the override and its reason if any, the caller as the reviewer, now, and the next review date (p_next_review_on after today and at most 3 years ahead, days in the organization''s zone; null: 12 months, 6 with student data); the review that was current becomes history; one item is written for each gap from p_items, an array of {question_key, finding, action, owner_user_id (a current member, or null), due_on (today to 3 years ahead, or null)} with exactly one element for each question answered No or Not shown and no other field (the severity is the rules''). Returns {review_id, version, superseded_review_id, starting_risk, evidence, residual_risk, hard_stops, pending_hard_stops, computed_result, override_result, result, next_review_on, items}. 42501 supplier_risk_not_allowed, mfa_required, aal2_required; 22023 supplier_not_found, supplier_archived, the answer words (answers_incomplete included), bad_next_review_on, bad_override (no result, not one of the four, or the computed one; or a reason with no result), bad_override_reason (10 to 2000 characters of plain text), items_not_an_array, items_do_not_match_answers, bad_item, bad_item_text (finding 1 to 500, action 1 to 1000), item_owner_not_a_member, bad_item_due_on. Takes the supplier''s lock (4810001); a wait ends after 5 s (55P03).';

create function public.supplier_risk_draft_discard(p_organization_id uuid, p_supplier_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_n integer;
begin
  if p_organization_id is null
     or not coalesce(public.has_org_role(p_organization_id, 'admin'), false) then
    raise exception 'supplier_risk_not_allowed' using errcode = '42501', hint = 'supplier_risk_not_allowed';
  end if;
  perform public.security_events_reader_check(p_organization_id);

  if p_supplier_id is null then
    return false;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(4810001, pg_catalog.hashtext(p_supplier_id::text));

  -- A draft is not evidence and has no items: it may go. A final never does.
  delete from public.supplier_risk_reviews r
   where r.supplier_id = p_supplier_id
     and r.organization_id = p_organization_id
     and r.status = 'draft';
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

revoke all on function public.supplier_risk_draft_discard(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.supplier_risk_draft_discard(uuid, uuid) to authenticated;

comment on function public.supplier_risk_draft_discard(uuid, uuid) is
  'Deletes the open draft review of a supplier (0481), also when the supplier is archived or deleted; true when there was one, false when there was none (or it is another organization''s). Never deletes a final review. 42501 supplier_risk_not_allowed, mfa_required, aal2_required. Takes the supplier''s lock (4810001); a wait ends after 5 s (55P03).';

create function public.supplier_risk_item_update(
  p_organization_id uuid,
  p_item_id uuid,
  p_status text,
  p_owner_user_id uuid,
  p_due_on date,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_supplier  uuid;
  v_i         public.supplier_risk_items;
  v_current   boolean;
  v_today     date;
  v_owner_nm  text;
begin
  if p_organization_id is null
     or not coalesce(public.has_org_role(p_organization_id, 'admin'), false) then
    raise exception 'supplier_risk_not_allowed' using errcode = '42501', hint = 'supplier_risk_not_allowed';
  end if;
  perform public.security_events_reader_check(p_organization_id);

  select r.supplier_id into v_supplier
    from public.supplier_risk_items i
    join public.supplier_risk_reviews r on r.id = i.review_id
   where i.id = p_item_id and i.organization_id = p_organization_id;
  if not found then
    raise exception 'item_not_found' using errcode = '22023', hint = 'item_not_found';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(4810001, pg_catalog.hashtext(v_supplier::text));

  -- Read again under the lock: a review finished meanwhile makes this one
  -- history.
  select i.* into v_i
    from public.supplier_risk_items i
   where i.id = p_item_id and i.organization_id = p_organization_id
     for update;
  select r.is_current into v_current
    from public.supplier_risk_reviews r
   where r.id = v_i.review_id;
  if not coalesce(v_current, false) then
    raise exception 'item_not_current' using errcode = '22023', hint = 'item_not_current';
  end if;

  if p_status is null or p_status not in ('open', 'in_progress', 'done', 'accepted') then
    raise exception 'bad_item_status' using errcode = '22023', hint = 'bad_item_status';
  end if;

  -- A new owner must be a current member; the same owner stays even after
  -- they leave, so the status can still be changed.
  if p_owner_user_id is not null and p_owner_user_id is distinct from v_i.owner_user_id then
    if not public._supplier_risk_is_current_member(p_organization_id, p_owner_user_id) then
      raise exception 'item_owner_not_a_member' using errcode = '22023', hint = 'item_owner_not_a_member';
    end if;
    v_owner_nm := public._supplier_risk_person_name(p_owner_user_id);
  elsif p_owner_user_id is not null then
    v_owner_nm := v_i.owner_name;
  end if;

  -- A new due date: today to three years ahead; the same one stays.
  if p_due_on is not null and p_due_on is distinct from v_i.due_on then
    v_today := (pg_catalog.now() at time zone public._supplier_risk_org_zone(p_organization_id))::date;
    if p_due_on < v_today or p_due_on > (v_today + interval '3 years')::date then
      raise exception 'bad_item_due_on' using errcode = '22023', hint = 'bad_item_due_on';
    end if;
  end if;

  if p_action is not null and not public._supplier_risk_text_ok(p_action, 1, 1000) then
    raise exception 'bad_item_text' using errcode = '22023', hint = 'bad_item_text';
  end if;

  update public.supplier_risk_items i
     set status = p_status,
         owner_user_id = p_owner_user_id,
         owner_name = v_owner_nm,
         due_on = p_due_on,
         action = coalesce(p_action, i.action),
         closed_at = case when p_status in ('done', 'accepted')
                          then case when i.status in ('done', 'accepted') then i.closed_at else pg_catalog.now() end
                     end,
         updated_at = pg_catalog.now()
   where i.id = p_item_id
  returning i.* into v_i;

  return public._supplier_risk_item_json(v_i);
end;
$$;

revoke all on function public.supplier_risk_item_update(uuid, uuid, text, uuid, date, text) from public, anon, authenticated, service_role;
grant execute on function public.supplier_risk_item_update(uuid, uuid, text, uuid, date, text) to authenticated;

comment on function public.supplier_risk_item_update(uuid, uuid, text, uuid, date, text) is
  'Changes one item of a current review (0481): its status (open, in_progress, done, accepted; done and accepted stamp closed_at, kept while it stays closed; open and in_progress clear it), owner (null for none; a new owner must be a current member, the same owner stays after leaving), due date (null for none; a new one today to 3 years ahead, days in the organization''s zone) and action (null keeps it). The finding, answer and severity never change. Returns the item as supplier_risk_review gives it. 42501 supplier_risk_not_allowed, mfa_required, aal2_required; 22023 item_not_found (none, or another organization''s), item_not_current (an earlier version''s), bad_item_status, item_owner_not_a_member, bad_item_due_on, bad_item_text. Takes the supplier''s lock (4810001); a wait ends after 5 s (55P03).';

-- ── The daily job's reminders ────────────────────────────────────────────────
-- Two reminders for the current review of an active supplier: 'due_soon'
-- when the next review date is 1 to 30 days away and the review was
-- finished before that window opened (a review made inside it is not
-- reminded at once), and 'due' on the date or after it. Each is claimed once,
-- stamped before it is sent. Days are in the organization's zone.

create function public.supplier_risk_reminders_due(p_limit integer default 100)
returns table (
  review_id            uuid,
  organization_id      uuid,
  supplier_id          uuid,
  supplier_name        text,
  kind                 text,
  next_review_on       date,
  org_today            date,
  data_level           text,
  result               text,
  admin_user_ids       uuid[],
  item_owner_user_ids  uuid[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
begin
  -- The grant is the gate: service_role only. This second lock names no
  -- gate: the role setting names the caller inside this body too (0413).
  if coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon') then
    raise exception 'supplier_risk_not_allowed' using errcode = '42501', hint = 'supplier_risk_not_allowed';
  end if;

  return query
    with cand as (
      -- Every zone's today is within a day of UTC's, so this is a superset.
      select r.id, r.organization_id, r.supplier_id, r.next_review_on, r.reviewed_at, r.data_level, r.result,
             r.reminded_30_at, r.reminded_due_at
        from public.supplier_risk_reviews r
       where r.is_current
         and r.next_review_on <= (pg_catalog.now() at time zone 'UTC')::date + 32
         and (r.reminded_30_at is null or r.reminded_due_at is null)
    ),
    zones as (
      select o.id, public._supplier_risk_org_zone(o.id) as zone
        from (select distinct c.organization_id as id from cand c) o
    ),
    k as (
      select c.*, z.zone, (pg_catalog.now() at time zone z.zone)::date as today
        from cand c join zones z on z.id = c.organization_id
    ),
    due as (
      select k.*,
             case when k.reminded_due_at is null and k.next_review_on <= k.today then 'due'
                  when k.reminded_30_at is null
                       and k.next_review_on > k.today and k.next_review_on <= k.today + 30
                       and (k.reviewed_at at time zone k.zone)::date < k.next_review_on - 30 then 'due_soon'
             end as kind
        from k
    )
    select d.id, d.organization_id, d.supplier_id, s.name, d.kind, d.next_review_on, d.today, d.data_level, d.result,
           array(select m.user_id from public.organization_members m
                  where m.organization_id = d.organization_id and m.role in ('owner', 'admin')
                    and public._supplier_risk_is_current_member(d.organization_id, m.user_id)
                  order by m.user_id),
           array(select distinct i.owner_user_id from public.supplier_risk_items i
                  where i.review_id = d.id and i.status in ('open', 'in_progress') and i.owner_user_id is not null
                    and public._supplier_risk_is_current_member(d.organization_id, i.owner_user_id)
                  order by i.owner_user_id)
      from due d
      join public.suppliers s on s.id = d.supplier_id and s.organization_id = d.organization_id
     where d.kind is not null
       and s.deleted_at is null
     order by d.next_review_on, d.id
     limit v_limit;
end;
$$;

revoke all on function public.supplier_risk_reminders_due(integer) from public, anon, authenticated, service_role;
grant execute on function public.supplier_risk_reminders_due(integer) to service_role;

comment on function public.supplier_risk_reminders_due(integer) is
  'For the daily reminder job (0481): current reviews of active suppliers with a reminder to send, at most p_limit (1 to 500, default 100), soonest first: review_id, organization_id, supplier_id, supplier_name, kind (due: the next review date is today or past and the due reminder was not claimed; due_soon: it is 1 to 30 days away, the review was finished before that window opened, and the 30-day reminder was not claimed), next_review_on, org_today (days in the organization''s zone), data_level, result, admin_user_ids (current owners and admins) and item_owner_user_ids (owners of open items who are current members). Archived and deleted suppliers are left out. Claim each with supplier_risk_reminder_claim before sending; a claimed row leaves this list. Read-only. service_role only: the grant is the whole control; called as authenticated or anon it raises 42501.';

create function public.supplier_risk_reminder_claim(p_review_id uuid, p_kind text)
returns boolean
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_org   uuid;
  v_zone  text;
  v_today date;
  v_n     integer;
begin
  -- The grant is the gate: service_role only (the second lock, as above).
  if coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon') then
    raise exception 'supplier_risk_not_allowed' using errcode = '42501', hint = 'supplier_risk_not_allowed';
  end if;
  if p_review_id is null or p_kind is null or p_kind not in ('due_soon', 'due') then
    return false;
  end if;

  select r.organization_id into v_org from public.supplier_risk_reviews r where r.id = p_review_id;
  if not found then
    return false;
  end if;
  v_zone := public._supplier_risk_org_zone(v_org);
  v_today := (pg_catalog.now() at time zone v_zone)::date;

  -- Stamp first, and only when the reminder is still due and unclaimed. Two
  -- overlapping calls: the second waits for the first's row lock, then reads
  -- the row again (READ COMMITTED) and finds the stamp: it updates nothing.
  if p_kind = 'due' then
    update public.supplier_risk_reviews r
       set reminded_due_at = pg_catalog.now()
     where r.id = p_review_id
       and r.is_current
       and r.reminded_due_at is null
       and r.next_review_on <= v_today
       and exists (select 1 from public.suppliers s
                    where s.id = r.supplier_id and s.organization_id = r.organization_id and s.deleted_at is null);
  else
    update public.supplier_risk_reviews r
       set reminded_30_at = pg_catalog.now()
     where r.id = p_review_id
       and r.is_current
       and r.reminded_30_at is null
       and r.next_review_on > v_today
       and r.next_review_on <= v_today + 30
       and (r.reviewed_at at time zone v_zone)::date < r.next_review_on - 30
       and exists (select 1 from public.suppliers s
                    where s.id = r.supplier_id and s.organization_id = r.organization_id and s.deleted_at is null);
  end if;
  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;

revoke all on function public.supplier_risk_reminder_claim(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.supplier_risk_reminder_claim(uuid, text) to service_role;

comment on function public.supplier_risk_reminder_claim(uuid, text) is
  'For the daily reminder job (0481): claims one reminder before it is sent, by stamping reminded_due_at (kind due) or reminded_30_at (kind due_soon) when the review is still current, the supplier still active, the reminder still due by the rules of supplier_risk_reminders_due and not claimed. True when this call stamped it; false otherwise (claimed already, by an overlapping call too; no longer due; a null or unknown review or kind). Never raises for an argument. A lock wait ends after 2 s (55P03). Run it under READ COMMITTED (PostgREST''s own). service_role only: the grant is the whole control; called as authenticated or anon it raises 42501.';

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- Nothing depends on these objects but the app code that follows this
-- migration. To remove them (ACCESS EXCLUSIVE on the two new tables; the two
-- tables' foreign keys take their triggers off public.organizations and
-- public.user_profiles, which takes SHARE ROW EXCLUSIVE on both until commit,
-- as the apply did; the rows go with them). In this order: the functions
-- first (one takes the items' row type), then the tables (with their
-- triggers), then the trigger functions and the helpers their CHECKs use.
--   drop function if exists public.supplier_risk_reminder_claim(uuid, text);
--   drop function if exists public.supplier_risk_reminders_due(integer);
--   drop function if exists public.supplier_risk_item_update(uuid, uuid, text, uuid, date, text);
--   drop function if exists public.supplier_risk_draft_discard(uuid, uuid);
--   drop function if exists public.supplier_risk_finalise(uuid, uuid, text, jsonb, date, text, text, jsonb);
--   drop function if exists public.supplier_risk_draft_save(uuid, uuid, text, jsonb);
--   drop function if exists public.supplier_risk_items_for_organization(uuid, boolean);
--   drop function if exists public.supplier_risk_review(uuid, uuid);
--   drop function if exists public.supplier_risk_history(uuid, uuid);
--   drop function if exists public.supplier_risk_register(uuid);
--   drop function if exists public._supplier_risk_item_json(public.supplier_risk_items);
--   drop function if exists public._supplier_risk_is_current_member(uuid, uuid);
--   drop function if exists public._supplier_risk_person_name(uuid);
--   drop function if exists public._supplier_risk_org_zone(uuid);
--   drop function if exists public._supplier_risk_default_next_review(text, date);
--   drop table if exists public.supplier_risk_items;
--   drop table if exists public.supplier_risk_reviews;
--   drop function if exists public._supplier_risk_items_guard();
--   drop function if exists public._supplier_risk_reviews_guard();
--   drop function if exists public._supplier_risk_computed_ok(smallint, text, jsonb, text, text, text, text[], text);
--   drop function if exists public._supplier_risk_evaluate(smallint, text, jsonb);
--   drop function if exists public._supplier_risk_answers_problem(smallint, text, jsonb, boolean);
--   drop function if exists public._supplier_risk_reason_ok(text);
--   drop function if exists public._supplier_risk_text_ok(text, integer, integer);
--   drop function if exists public._supplier_risk_question_key_ok(text);
--   drop function if exists public._supplier_risk_questions();
