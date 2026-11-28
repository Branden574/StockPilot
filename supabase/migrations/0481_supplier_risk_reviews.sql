-- 0481_supplier_risk_reviews.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Vendor risk reviews for an organization's owners and admins (security tools,
-- part 7). Vendors are the app's suppliers. An admin answers a short, fixed
-- list of questions about one supplier (what of ours they hold, what the
-- contract and the data agreement say, which reports they have shown us, and
-- the student-data conditions); the database works out the result by fixed
-- rules, keeps every finished review as a version, keeps a register of the
-- items each gap makes (with an owner, a due date and a status), and has a
-- next review date with the reminders a future daily job sends. Nothing reads
-- or writes these objects until the app code that follows this migration.
-- The question list and the rules are core's (packages/core/src/vendor-risk/):
-- the same list and the same rules are written here, and the case table in
-- this file's test is run against both (vendor-risk.parity.test.ts). The
-- advisory lock key below (4810001) carries this file's number.
--
-- WHAT IT ADDS (tier A: two new tables with their keys, checks and indexes,
-- two triggers on the new tables, twenty-nine functions (eleven the API roles
-- may run: eight for signed-in admins, three for the daily job; eighteen
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
--      A supplier is always named with its organization: every key, unique
--      rule, lookup and update is by (organization_id, supplier_id), never
--      by the supplier id alone, so a supplier id that comes back in another
--      organization (after a hard delete) never reaches this one's reviews.
--      Each row holds: the organization and the supplier (a plain uuid, with
--      the supplier's name as it was at the last save: the name it was
--      reviewed as, so a review outlives its supplier and a rename shows; see
--      SUPPLIERS ARCHIVED OR DELETED; kept as plain text, see TEXT); the
--      version number; the rules version
--      (1: a stored review keeps the rules version it was judged under); the
--      data level (none, staff, student); the
--      answers (jsonb: question key to {answer, note, date}; keys and values
--      are checked against the fixed list by a CHECK of the table); for a
--      final, what the rules give (starting risk, evidence, risk left, the
--      hard stops, the computed result: a CHECK holds them equal to the rules
--      applied to the answers, so no caller can store another) and an
--      optional override of the result with its reason (the reason is
--      required, and kept); the result in force (a generated column); the
--      reviewer (a link that empties when the account is deleted, and a name
--      snapshot that stays); when it was finished, and that day in the
--      organization's zone (the dates beside the answers are judged against
--      it); the next review date; when the 30-day reminder was claimed; and
--      for the due reminder, when it was claimed, claimed again (a second
--      chance, 24 hours after a claim the job did not confirm) and confirmed
--      sent.
--   2. public.supplier_risk_items. The register: one row for each gap (an
--      asked question answered No or Not shown to us, or a Yes out of date)
--      of a final review: the question, the answer (no, not_shown,
--      out_of_date), the severity (the rules'), the finding and the action
--      (the admin's words, suggested by core), an owner (an owner or admin of
--      the organization when named, with a name snapshot), a due date, a
--      status (open, in_progress, done, accepted), when it was closed, who
--      changed it last and when (a link and a name snapshot), and for a risk
--      accepted who accepted it and why (always both). Exactly one per gap,
--      written with the final review. A trigger keeps the finding, the answer
--      and the severity as written.
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
--        supplier_risk_item_update(org, item, status, owner, due, action,
--          reason).
--   4. The future daily job's functions (EXECUTE to service_role only):
--        supplier_risk_reminders_due(limit): current reviews of active
--          suppliers due in 30 days or less, or due today or before, whose
--          reminder was not claimed (or whose due reminder was claimed more
--          than 24 hours ago and never confirmed: offered once more);
--        supplier_risk_reminder_claim(review, kind): stamps the reminder
--          before it is sent (the schedule-reminders pattern); true for
--          exactly one of any number of overlapping calls;
--        supplier_risk_due_reminder_sent(review): the job confirms the due
--          reminder went. A due reminder claimed and not confirmed within 24
--          hours is offered once more; one claimed twice and still not
--          confirmed 24 hours later shows as not sent on the register.
--   5. Private helpers (no API role may call them): the question list, the
--      answers check, the rules, the hidden characters and the spaces, the
--      text rule, the reason rule, a name as plain text, the default next
--      review date, the organization's zone, the two trigger functions.
--
-- TEXT. No text these tables store (a note, a reason, a finding, an action,
-- a name kept beside a link) holds a hidden character: a control character
-- but tab and line breaks, a zero-width or joiner character, a direction
-- control, a tag character, or another default-ignorable or format
-- character of Unicode. The set is ONE list (_supplier_risk_hidden_chars(),
-- the same ranges as core's VENDOR_RISK_HIDDEN_CHARACTERS). A reason (an
-- override's, a risk accepted) is counted over what can be seen: at least
-- 20 characters once each run of spaces is one space and the ends are
-- trimmed, at least 5 different characters that are not spaces. The names
-- the functions copy (the supplier's, a person's) are stored as plain text:
-- hidden characters taken out, each run of spaces one space.
--
-- DATES BESIDE THE ANSWERS. A Yes to the security report or to insurance
-- needs the date on the document (a finished review without it is refused,
-- answer_date_missing); a date there later than today in UTC plus one day
-- is refused (answer_date_in_future), on every save and by the reviews
-- table's CHECK for a final (against the UTC day of reviewed_at); a Yes
-- dated more than 12 months before the review counts as Not shown to us.
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
--   - A support (act-as) seat may read, and never writes: the four writes
--     refuse it with 42501 supplier_risk_act_as_read_only (no draft, no
--     finish, no override, no item change, so no risk accepted by it).
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
-- ACCOUNTS DELETED. reviewer_id, owner_user_id, changed_by and accepted_by
-- are keys to user_profiles with ON DELETE SET NULL: the row stays, the link
-- empties, and the name written beside it (reviewer_name, owner_name,
-- changed_by_name, accepted_by_name) stays, also through later changes of
-- the item. The SET NULL is an update, so the tables' CHECKs run again on
-- every row it touches: their functions are never changed in place (see
-- the text rule), so a row stored once passes them again and the deletion
-- is never refused by it.
--
-- ERRORS: 42501 (not allowed; mfa_required, aal2_required); 22023 with the
-- code as message and hint for every refused argument (listed in each
-- function's comment); 55000 (supplier_risk_final_is_kept, a final review or
-- an item's written fields changed by any path); 55P03 (a lock wait past the
-- function's own lock_timeout). No function raises 40001 or 40P01.
-- ─────────────────────────────────────────────────────────────────────────────

-- LOCKS: the five foreign keys to existing tables take SHARE ROW EXCLUSIVE on
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
-- order, whether a date applies, the age in months past which a dated Yes is
-- out of date, asked only with student data, a key paper, the hard stop a No
-- makes with student data, and the severity of its item with staff contact
-- details and with student data); vendor-risk.parity.test.ts reads the block
-- between the markers and holds the two equal. Every question needs some data
-- of ours: none is asked at the level 'none'.
-- NEVER CHANGE THIS LIST IN PLACE once a review is finished anywhere: it
-- takes no rules version, and the reviews table's CHECKs hold every stored
-- review to it, so a changed list would make stored finals fail their CHECK
-- at their next update (an account deletion's SET NULL among them, which
-- would then be refused). A new list is rules version 2, kept beside this
-- one.
create function public._supplier_risk_questions()
returns table (
  key               text,
  grp               text,
  ord               integer,
  has_date          boolean,
  date_max_months   integer,
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
  select q.key, q.grp, q.ord, q.has_date, q.date_max_months, q.student_only, q.key_evidence, q.hard_stop,
         q.severity_staff, q.severity_student
    from (values
      -- vendor-risk-questions:begin
      ('data_listed',      'holds',    1, false, null, false, false, null,                             'low',    'medium'),
      ('data_we_send',     'holds',    2, false, null, false, false, null,                             'low',    'medium'),
      ('hosting_known',    'holds',    3, false, null, false, false, null,                             'low',    'medium'),
      ('data_agreement',   'paper',    4, true,  null, false, true,  'student_data_no_agreement',      'medium', 'critical'),
      ('breach_notice',    'paper',    5, false, null, false, true,  'student_data_no_breach_notice',  'medium', 'critical'),
      ('return_or_delete', 'paper',    6, false, null, false, false, null,                             'low',    'high'),
      ('subvendors_named', 'paper',    7, false, null, false, false, null,                             'low',    'high'),
      ('security_report',  'proof',    8, true,  12,   false, true,  null,                             'medium', 'high'),
      ('insurance',        'proof',    9, true,  12,   false, false, null,                             'low',    'medium'),
      ('direct_control',   'student', 10, false, null, true,  false, 'student_data_no_direct_control', null,     'critical'),
      ('purpose_only',     'student', 11, false, null, true,  false, 'student_data_no_purpose_limit',  null,     'critical'),
      ('no_redisclosure',  'student', 12, false, null, true,  false, 'student_data_redisclosure',      null,     'critical'),
      ('no_sale_or_ads',   'student', 13, false, null, true,  false, 'student_data_sale_or_ads',       null,     'critical'),
      ('no_ai_training',   'student', 14, false, null, true,  false, 'student_data_ai_training',       null,     'critical')
      -- vendor-risk-questions:end
    ) as q(key, grp, ord, has_date, date_max_months, student_only, key_evidence, hard_stop, severity_staff, severity_student);
$$;

revoke all on function public._supplier_risk_questions() from public, anon, authenticated, service_role;

comment on function public._supplier_risk_questions() is
  'Private (0481). The vendor risk question list of rules version 1, the same as core''s VENDOR_RISK_QUESTIONS: key, group (holds, paper, proof, student), order, whether a date applies, the age in months past which a dated Yes is out of date (null: not judged), asked only with student data, a key paper, the hard stop a No makes with student data, the item severity with staff contact details and with student data. No question is asked at the level none. Never change it in place once a review is finished: a new list is a new rules version. No API role may call it.';

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
-- NEVER CHANGE THE FOUR FUNCTIONS BELOW IN PLACE once a row is stored
-- anywhere (the hidden characters, the spaces, the text rule, the reason
-- rule): the tables' CHECKs call them, and a CHECK runs again at every
-- update of a row, an account deletion's SET NULL among them. A stricter
-- rule written over these by create or replace would make stored rows fail
-- their CHECK at that update, and the account deletion would be refused. A
-- new rule is new functions, used by new rows only.
--
-- The hidden characters: no stored text may hold one. ONE list of ranges, in
-- order (core's VENDOR_RISK_HIDDEN_CHARACTERS is the same list; the parity
-- test compares them range by range): the controls but tab, line feed and
-- carriage return (U+0001 to U+0008, U+000B, U+000C, U+000E to U+001F,
-- U+007F to U+009F); soft hyphen U+00AD; combining grapheme joiner U+034F;
-- the Arabic number signs U+0600 to U+0605, letter mark U+061C and end of
-- ayah U+06DD; Syriac abbreviation mark U+070F; U+0890, U+0891, U+08E2; the
-- Hangul fillers U+115F, U+1160, U+3164, U+FFA0; Khmer inherent vowels
-- U+17B4, U+17B5; Mongolian variation selectors and vowel separator U+180B
-- to U+180F; zero width space, non-joiner, joiner and the direction marks
-- U+200B to U+200F; line and paragraph separators and direction embeddings
-- and overrides U+2028 to U+202E; word joiner, invisible operators,
-- direction isolates and deprecated format characters U+2060 to U+206F;
-- variation selectors U+FE00 to U+FE0F; byte order mark U+FEFF; U+FFF0 to
-- U+FFFB (default-ignorable, interlinear annotation); Kaithi number signs
-- U+110BD, U+110CD; Egyptian hieroglyph format controls U+13430 to U+1343F;
-- shorthand format controls U+1BCA0 to U+1BCA3; musical symbol format
-- controls U+1D173 to U+1D17A; tag characters and the variation selectors
-- supplement, the whole block U+E0000 to U+E0FFF.
create function public._supplier_risk_hidden_chars()
returns text
language sql
immutable
set search_path = ''
as $$
  select '[\u0001-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u0600-\u0605\u061C\u06DD\u070F\u0890-\u0891\u08E2\u115F-\u1160\u17B4-\u17B5\u180B-\u180F\u200B-\u200F\u2028-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFFB\U000110BD\U000110CD\U00013430-\U0001343F\U0001BCA0-\U0001BCA3\U0001D173-\U0001D17A\U000E0000-\U000E0FFF]'::text;
$$;

revoke all on function public._supplier_risk_hidden_chars() from public, anon, authenticated, service_role;

comment on function public._supplier_risk_hidden_chars() is
  'Private (0481). The hidden characters, as one regular expression bracket: the controls but tab and line breaks, the zero-width and joiner characters, the direction controls, the tag characters and the other default-ignorable and format characters of Unicode (the migration names every range). The same ranges as core''s VENDOR_RISK_HIDDEN_CHARACTERS. Used by the text rule (so by the tables'' CHECKs) and the plain names. Never change it in place once a row is stored. No API role may call it.';

-- The spaces: Unicode's white space that the list above leaves (tab, line
-- feed, carriage return, space, no-break space, Ogham space mark, U+2000 to
-- U+200A, narrow no-break space, medium mathematical space, ideographic
-- space). Core's VENDOR_RISK_SPACE_CHARACTERS is the same list.
create function public._supplier_risk_space_chars()
returns text
language sql
immutable
set search_path = ''
as $$
  select '[\u0009\u000A\u000D\u0020\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]'::text;
$$;

revoke all on function public._supplier_risk_space_chars() from public, anon, authenticated, service_role;

comment on function public._supplier_risk_space_chars() is
  'Private (0481). The spaces, as one regular expression bracket: tab, line feed, carriage return, space, U+00A0, U+1680, U+2000 to U+200A, U+202F, U+205F, U+3000. The same ranges as core''s VENDOR_RISK_SPACE_CHARACTERS. A text must hold something else; a reason counts each run of them as one. Never change it in place once a row is stored. No API role may call it.';

-- Every text this file stores (a note, a reason, a finding, an action, a
-- name): p_min to p_max characters, at least one that is not a space, and no
-- hidden character. Core's vendorRiskTextOk is the same rule.
create function public._supplier_risk_text_ok(p_text text, p_min integer, p_max integer)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
           pg_catalog.char_length(p_text) between p_min and p_max
           and pg_catalog.regexp_replace(p_text, public._supplier_risk_space_chars(), '', 'g') <> ''
           and p_text !~ public._supplier_risk_hidden_chars(),
           false);
$$;

revoke all on function public._supplier_risk_text_ok(text, integer, integer) from public, anon, authenticated, service_role;

comment on function public._supplier_risk_text_ok(text, integer, integer) is
  'Private (0481). The text rule for everything these tables store (a note, a reason, a finding, an action, a name): p_min to p_max characters, at least one that is not a space (_supplier_risk_space_chars), no hidden character (_supplier_risk_hidden_chars). False for null. The same as core''s vendorRiskTextOk. Never change it in place once a row is stored. No API role may call it.';

-- A reason (an override's, or a risk accepted), counted over what can be
-- seen: the text rule (1 to 2000, so no hidden character), at least 20
-- characters once each run of spaces is one space and the ends are trimmed,
-- and at least 5 different characters that are not spaces. Core's
-- vendorRiskOverrideReasonOk is the same rule.
create function public._supplier_risk_reason_ok(p_text text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select public._supplier_risk_text_ok(p_text, 1, 2000)
         and pg_catalog.char_length(pg_catalog.btrim(pg_catalog.regexp_replace(p_text, public._supplier_risk_space_chars() || '+', ' ', 'g'), ' ')) >= 20
         and (select pg_catalog.count(distinct c) from pg_catalog.regexp_split_to_table(p_text, '') c
               where c !~ public._supplier_risk_space_chars()) >= 5;
$$;

revoke all on function public._supplier_risk_reason_ok(text) from public, anon, authenticated, service_role;

comment on function public._supplier_risk_reason_ok(text) is
  'Private (0481). The reason rule (an override''s, a risk accepted): the text rule with 1 to 2000 characters (no hidden character), at least 20 once each run of spaces is one space and the ends are trimmed, and at least 5 different characters that are not spaces. False for null. The same as core''s vendorRiskOverrideReasonOk. Never change it in place once a row is stored. No API role may call it.';

-- A name these functions copy into a row (the supplier's, a person's), as
-- plain text: the hidden characters taken out, each run of spaces one space,
-- the ends trimmed, at most p_max characters; null when nothing is left.
create function public._supplier_risk_plain_name(p_text text, p_max integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(pg_catalog.rtrim(pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(
           pg_catalog.regexp_replace(p_text, public._supplier_risk_hidden_chars(), '', 'g'),
           public._supplier_risk_space_chars() || '+', ' ', 'g'), ' '), p_max), ' '), '');
$$;

revoke all on function public._supplier_risk_plain_name(text, integer) from public, anon, authenticated, service_role;

comment on function public._supplier_risk_plain_name(text, integer) is
  'Private (0481). A name as plain text for a row of these tables: the hidden characters taken out, each run of spaces one space, the ends trimmed, at most p_max characters; null when nothing is left (or for null). What it gives always passes the text rule. No API role may call it.';

-- ── The answers check ────────────────────────────────────────────────────────
-- What is wrong with these answers, as a fixed word, or null when nothing is.
-- An object of question key to {"answer": yes|no|not_shown, "note": text or
-- null, "date": 'YYYY-MM-DD' or null} and no other field; only keys of
-- questions asked at the level; a date only where the question takes one,
-- a real date from 2000-01-01 to 2100-12-31; a note by the text rule, 1 to
-- 1000 characters. Beside a question whose date is judged (the security
-- report, insurance): a date later than p_utc_today plus one day is refused
-- (answer_date_in_future, whatever the answer; null p_utc_today: not judged),
-- and with p_final a Yes needs its date (answer_date_missing). p_final:
-- every question asked at the level is answered. Core's
-- vendorRiskAnswersProblem gives the same words, in the same order. Used by
-- the reviews table's CHECK (p_utc_today: the UTC day of reviewed_at, so a
-- draft's dates are judged at its saves only), so every row on every path is
-- held to it. NEVER CHANGE IT IN PLACE once a review is stored: the CHECK
-- runs again at every update (see the text rule).
create function public._supplier_risk_answers_problem(
  p_rules_version smallint,
  p_level text,
  p_answers jsonb,
  p_final boolean,
  p_utc_today date
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
      -- A judged date later than tomorrow in UTC (whatever the answer).
      if v_q.date_max_months is not null and p_utc_today is not null and v_d > p_utc_today + 1 then
        return 'answer_date_in_future';
      end if;
    end if;
    -- A finished Yes to a question whose date is judged needs its date.
    if p_final and v_q.date_max_months is not null and (v_val ->> 'answer') = 'yes'
       and coalesce(pg_catalog.jsonb_typeof(v_val -> 'date'), 'null') = 'null' then
      return 'answer_date_missing';
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

revoke all on function public._supplier_risk_answers_problem(smallint, text, jsonb, boolean, date) from public, anon, authenticated, service_role;

comment on function public._supplier_risk_answers_problem(smallint, text, jsonb, boolean, date) is
  'Private (0481). What is wrong with a review''s answers, as a fixed word, or null: bad_rules_version, bad_data_level, answers_not_an_object, answer_unknown_question, answer_not_applicable, answer_bad_shape, answer_bad_value, answer_bad_note, answer_date_not_allowed, answer_bad_date, answer_date_in_future (a date beside the security report or insurance later than p_utc_today plus one day), answer_date_missing (p_final, a Yes to the security report or insurance with no date), answers_incomplete (p_final, an asked question unanswered). The same words as core''s vendorRiskAnswersProblem. Used by the reviews table''s CHECK. Never change it in place once a review is stored. No API role may call it.';

-- ── The rules ────────────────────────────────────────────────────────────────
-- Core's evaluateVendorRisk, the same rules (rules.ts has them in words),
-- version 1: starting risk from the level; a Yes to a question whose date is
-- judged (the security report, insurance), dated more than its months
-- before p_review_on, counts as Not shown and is listed as out of date (no
-- p_review_on: not judged; no date: not judged here, and never in a stored
-- final, which the answers check holds to have it); a gap is an asked
-- question answered No or Not shown (an unanswered one counts as Not
-- shown); evidence
-- not_needed (nothing asked), insufficient (a key paper Not shown, or more
-- than half Not shown), weak (a key paper No, or three gaps or more),
-- adequate (one or two gaps), strong (none); with student data a hard stop
-- for each hard-stop question answered No, pending when it is Not shown
-- (every Student data question is one, so Not shown on any of them is
-- pending); risk left high with a hard stop, low when strong or not needed,
-- one step down when adequate, the starting risk otherwise; result
-- do_not_use (a hard stop), more_information (a pending hard stop,
-- insufficient, or more than three gaps), approve (no gap),
-- approve_with_conditions. Null for another rules version or level.
create function public._supplier_risk_evaluate(p_rules_version smallint, p_level text, p_answers jsonb,
                                               p_review_on date)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_q        record;
  v_a        text;
  v_ds       text;
  v_d        date;
  v_n        integer := 0;
  v_gaps     text[] := '{}';
  v_ns       integer := 0;
  v_key_ns   boolean := false;
  v_key_no   boolean := false;
  v_hard     text[] := '{}';
  v_pending  text[] := '{}';
  v_stale    text[] := '{}';
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
    -- A Yes dated too long before the review is out of date: Not shown.
    if v_a = 'yes' and v_q.date_max_months is not null and p_review_on is not null then
      v_ds := case when pg_catalog.jsonb_typeof(p_answers -> v_q.key -> 'date') = 'string'
                   then p_answers -> v_q.key ->> 'date' end;
      v_d := null;
      if v_ds ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        begin
          v_d := pg_catalog.make_date(substr(v_ds, 1, 4)::integer, substr(v_ds, 6, 2)::integer,
                                      substr(v_ds, 9, 2)::integer);
        exception when others then
          v_d := null;
        end;
      end if;
      if v_d is not null
         and v_d < (p_review_on - pg_catalog.make_interval(months => v_q.date_max_months))::date then
        v_a := 'not_shown';
        v_stale := v_stale || v_q.key;
      end if;
    end if;
    continue when v_a = 'yes';
    v_gaps := v_gaps || v_q.key;
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
  elsif v_key_no or pg_catalog.cardinality(v_gaps) > 2 then
    v_evidence := 'weak';
  elsif pg_catalog.cardinality(v_gaps) > 0 then
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
  elsif pg_catalog.cardinality(v_pending) > 0 or v_evidence = 'insufficient'
        or pg_catalog.cardinality(v_gaps) > 3 then
    v_result := 'more_information';
  elsif pg_catalog.cardinality(v_gaps) = 0 then
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
    'gaps', pg_catalog.to_jsonb(v_gaps),
    'out_of_date', pg_catalog.to_jsonb(v_stale),
    'result', v_result);
end;
$$;

revoke all on function public._supplier_risk_evaluate(smallint, text, jsonb, date) from public, anon, authenticated, service_role;

comment on function public._supplier_risk_evaluate(smallint, text, jsonb, date) is
  'Private (0481). The vendor risk rules of version 1, the same as core''s evaluateVendorRisk: {starting_risk (low, moderate, high), evidence (not_needed, strong, adequate, weak, insufficient), residual_risk, hard_stops and pending_hard_stops (arrays in question order), gaps (the question keys, in order), out_of_date (the keys of a Yes dated too long before p_review_on, counted as Not shown), result (approve, approve_with_conditions, more_information, do_not_use)}. An unanswered asked question counts as Not shown. p_review_on null: no date is judged. Null for another rules version or level. No API role may call it.';

-- The stored result equals the rules applied to the stored answers on the
-- day of the review. Used by the reviews table's CHECK.
create function public._supplier_risk_computed_ok(
  p_rules_version smallint,
  p_level text,
  p_answers jsonb,
  p_reviewed_on date,
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
           (public._supplier_risk_evaluate(p_rules_version, p_level, p_answers, p_reviewed_on)
              - 'pending_hard_stops' - 'gaps' - 'out_of_date')
             = pg_catalog.jsonb_build_object('starting_risk', p_starting_risk, 'evidence', p_evidence,
                                             'residual_risk', p_residual_risk,
                                             'hard_stops', pg_catalog.to_jsonb(p_hard_stops), 'result', p_result),
           false);
$$;

revoke all on function public._supplier_risk_computed_ok(smallint, text, jsonb, date, text, text, text, text[], text) from public, anon, authenticated, service_role;

comment on function public._supplier_risk_computed_ok(smallint, text, jsonb, date, text, text, text, text[], text) is
  'Private (0481). True when the stored starting risk, evidence, risk left, hard stops and computed result are what _supplier_risk_evaluate gives for the stored answers on the stored day of the review; false otherwise (null included). Used by the reviews table''s CHECK. No API role may call it.';

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
  -- The supplier's name as it was at the last save of this version: for a
  -- final, the name it was reviewed as (the reads show it beside today's).
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
  -- The day it was finished in the organization's zone: the dates beside
  -- the answers are judged against it (a CHECK holds the result to it).
  reviewed_on      date,
  next_review_on   date,
  -- When the daily job claimed each reminder (stamped before sending), and
  -- for the due reminder, its second claim and the job's confirmation.
  reminded_30_at   timestamptz,
  reminded_due_at  timestamptz,
  reminded_due_retry_at timestamptz,
  reminded_due_sent_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint supplier_risk_reviews_org_id_key unique (organization_id, id),
  constraint supplier_risk_reviews_version_key unique (organization_id, supplier_id, version),
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
  -- The answers, against the fixed list: every row, every path; a final's
  -- dates against the UTC day it was finished on (a draft has none).
  constraint supplier_risk_reviews_answers
    check (public._supplier_risk_answers_problem(rules_version, data_level, answers, status = 'final',
                                                 (reviewed_at at time zone 'UTC')::date) is null),
  -- A draft has no result, review time, next date, override or reminder; a
  -- final has all that the rules give, equal to the rules applied to its
  -- answers, and its time and next date.
  constraint supplier_risk_reviews_computed
    check ((status = 'draft'
            and pg_catalog.num_nulls(starting_risk, evidence, residual_risk, hard_stops, computed_result,
                                     override_result, override_reason, reviewed_at, reviewed_on, next_review_on,
                                     reminded_30_at, reminded_due_at, reminded_due_retry_at,
                                     reminded_due_sent_at) = 14)
        or (status = 'final'
            and pg_catalog.num_nonnulls(starting_risk, evidence, residual_risk, hard_stops, computed_result,
                                        reviewed_at, reviewed_on, next_review_on) = 8
            and public._supplier_risk_computed_ok(rules_version, data_level, answers, reviewed_on, starting_risk,
                                                  evidence, residual_risk, hard_stops, computed_result))),
  -- The due reminder's second claim and its confirmation follow a claim.
  constraint supplier_risk_reviews_due_reminder
    check ((reminded_due_retry_at is null or reminded_due_at is not null)
       and (reminded_due_sent_at is null or reminded_due_at is not null)),
  -- An override names another result and has its reason; none has neither.
  -- Every term is spelled out so the check is never unknown (an unknown
  -- CHECK passes): a reason with no result is false here, not null.
  constraint supplier_risk_reviews_override
    check ((override_result is null and override_reason is null)
        or (override_result is not null and override_reason is not null
            and override_result in ('approve', 'approve_with_conditions', 'more_information', 'do_not_use')
            and override_result is distinct from computed_result
            and public._supplier_risk_reason_ok(override_reason))),
  -- The names kept beside a link: plain text by the text rule.
  constraint supplier_risk_reviews_supplier_name
    check (public._supplier_risk_text_ok(supplier_name, 1, 300)),
  constraint supplier_risk_reviews_reviewer_name
    check (public._supplier_risk_text_ok(reviewer_name, 1, 200)),
  constraint supplier_risk_reviews_next_review_on
    check (next_review_on is null or next_review_on between date '2000-01-01' and date '2200-12-31')
);

-- At most one current review and one draft per supplier of an organization
-- (the organization first: a supplier id is never taken alone).
create unique index supplier_risk_reviews_one_current
  on public.supplier_risk_reviews (organization_id, supplier_id)
  where is_current;
create unique index supplier_risk_reviews_one_draft
  on public.supplier_risk_reviews (organization_id, supplier_id)
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
  'Vendor risk reviews (0481): one row per version of a supplier''s review, draft (at most one per supplier of an organization) or final (kept as it was: a trigger refuses any change but the marks). The newest final is current: one per supplier of an organization that has a final. Every key and lookup takes the organization with the supplier id. The answers are checked against the fixed question list, and a final''s result equals the rules applied to its answers on its day, both by CHECK. supplier_id has no foreign key: a review outlives its supplier. RLS on, no policy, no privilege to any API role: read and written only through the supplier_risk_* functions, for an organization''s owners and admins (and the daily job''s three reminder functions).';
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
  'When the daily job first claimed the reminder on (or after) the next review date (stamped before sending).';
comment on column public.supplier_risk_reviews.reminded_due_retry_at is
  'When the daily job claimed the due reminder a second time: a claim not confirmed within 24 hours is offered once more.';
comment on column public.supplier_risk_reviews.reminded_due_sent_at is
  'When the daily job confirmed the due reminder was sent (supplier_risk_due_reminder_sent). A second claim not confirmed within 24 hours shows as not sent on the register.';
comment on column public.supplier_risk_reviews.reviewed_on is
  'The day a final review was finished, in the organization''s zone: the dates beside the answers are judged against it.';

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
  -- Who changed the item last (or wrote it, with its review) and when: the
  -- link empties when the account is deleted, the name stays.
  changed_by       uuid        references public.user_profiles(id) on delete set null,
  changed_by_name  text        not null,
  changed_at       timestamptz not null default now(),
  -- A risk accepted always says who accepted it and why.
  accepted_by      uuid        references public.user_profiles(id) on delete set null,
  accepted_by_name text,
  accepted_reason  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- The review, in the same organization.
  constraint supplier_risk_items_review_fkey foreign key (organization_id, review_id)
    references public.supplier_risk_reviews (organization_id, id) on delete cascade,
  constraint supplier_risk_items_one_per_question unique (review_id, question_key),
  constraint supplier_risk_items_question_key
    check (public._supplier_risk_question_key_ok(question_key)),
  constraint supplier_risk_items_answer
    check (answer in ('no', 'not_shown', 'out_of_date')),
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
    check (owner_name is null or public._supplier_risk_text_ok(owner_name, 1, 200)),
  -- An owner is always named; a name with no link is an owner whose account
  -- was deleted.
  constraint supplier_risk_items_owner_named
    check (owner_user_id is null or owner_name is not null),
  constraint supplier_risk_items_due_on
    check (due_on is null or due_on between date '2000-01-01' and date '2200-12-31'),
  constraint supplier_risk_items_changed_by_name
    check (public._supplier_risk_text_ok(changed_by_name, 1, 200)),
  -- Accepted exactly when there is a reason and the name of who accepted it.
  constraint supplier_risk_items_accepted
    check ((status = 'accepted') = (accepted_reason is not null and accepted_by_name is not null)
       and (accepted_by is null or accepted_by_name is not null)
       and (accepted_by_name is null or public._supplier_risk_text_ok(accepted_by_name, 1, 200))
       and (accepted_reason is null or public._supplier_risk_reason_ok(accepted_reason)))
);

create index supplier_risk_items_owner_idx
  on public.supplier_risk_items (owner_user_id)
  where owner_user_id is not null;
create index supplier_risk_items_changed_by_idx
  on public.supplier_risk_items (changed_by)
  where changed_by is not null;
create index supplier_risk_items_accepted_by_idx
  on public.supplier_risk_items (accepted_by)
  where accepted_by is not null;

comment on table public.supplier_risk_items is
  'The vendor risk register (0481): one row for each gap (an asked question answered No or Not shown to us, or a Yes out of date) of a final review, written with it: the answer, the rules'' severity, the finding and action, an owner (an owner or admin when named, with a name snapshot), a due date, a status (open, in_progress, done, accepted), when it was closed, who changed it last and when, and for a risk accepted who accepted it and why. The question, answer, severity and finding stay as written (a trigger). RLS on, no policy, no privilege to any API role: read and written only through the supplier_risk_* functions.';
comment on column public.supplier_risk_items.owner_name is
  'The owner''s name (or email) when they were made the owner: kept when the account is deleted and owner_user_id empties, and through later changes of the item until a new owner is named.';
comment on column public.supplier_risk_items.changed_by_name is
  'Who changed the item last (at first, who finished its review), as their name (or email) was then: kept when the account is deleted.';
comment on column public.supplier_risk_items.accepted_reason is
  'Why the risk was accepted (the reason rule: at most 2000 characters with no hidden character, at least 20 once each run of spaces is one, at least 5 different). Present exactly when the status is accepted, with accepted_by_name.';

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
-- update of a final may only clear is_current, stamp each reminder mark once
-- (the 30-day claim, the due claim, its second claim, its confirmation),
-- empty the reviewer link (an account deleted) and move updated_at. It may
-- never go back to draft, become current again, or change anything it says.
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
              new.reviewed_on, new.next_review_on, new.created_at)
             is distinct from
             (old.id, old.organization_id, old.supplier_id, old.supplier_name, old.version, old.rules_version,
              old.data_level, old.answers, old.starting_risk, old.evidence, old.residual_risk, old.hard_stops,
              old.computed_result, old.override_result, old.override_reason, old.reviewer_name, old.reviewed_at,
              old.reviewed_on, old.next_review_on, old.created_at)
          or (new.reviewer_id is distinct from old.reviewer_id and new.reviewer_id is not null)
          or (new.is_current and not old.is_current)
          or (old.reminded_30_at is not null and new.reminded_30_at is distinct from old.reminded_30_at)
          or (old.reminded_due_at is not null and new.reminded_due_at is distinct from old.reminded_due_at)
          or (old.reminded_due_retry_at is not null
              and new.reminded_due_retry_at is distinct from old.reminded_due_retry_at)
          or (old.reminded_due_sent_at is not null
              and new.reminded_due_sent_at is distinct from old.reminded_due_sent_at)) then
    raise exception 'supplier_risk_final_is_kept' using errcode = '55000', hint = 'supplier_risk_final_is_kept';
  end if;
  return new;
end;
$$;

revoke all on function public._supplier_risk_reviews_guard() from public, anon, authenticated, service_role;

comment on function public._supplier_risk_reviews_guard() is
  'Private (0481), the trigger function of supplier_risk_reviews_kept: an update of a final review may only clear is_current, stamp each reminder mark once (reminded_30_at, reminded_due_at, reminded_due_retry_at, reminded_due_sent_at), empty reviewer_id (an account deleted) and move updated_at; anything else raises 55000 supplier_risk_final_is_kept. A draft may change freely. No API role may call it.';

create trigger supplier_risk_reviews_kept
  before update on public.supplier_risk_reviews
  for each row execute function public._supplier_risk_reviews_guard();

-- An item's question, answer, severity and finding stay as written, and it
-- stays with its review; the owner, due date, status, closing time, action,
-- who changed it last, the acceptance and updated_at may change (the person
-- links also empty when an account is deleted).
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

-- ── People ───────────────────────────────────────────────────────────────────
-- A person's name as a review or an item keeps it, as plain text.
create function public._supplier_risk_person_name(p_user_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
           (select coalesce(public._supplier_risk_plain_name(p.full_name, 200),
                            public._supplier_risk_plain_name(p.email::text, 200))
              from public.user_profiles p where p.id = p_user_id),
           'Unknown');
$$;

revoke all on function public._supplier_risk_person_name(uuid) from public, anon, authenticated, service_role;

comment on function public._supplier_risk_person_name(uuid) is
  'Private (0481). A person''s name for a snapshot, as plain text (_supplier_risk_plain_name): their full name, else their email, else Unknown, at most 200 characters. SECURITY INVOKER: its callers run as their owner. No API role may call it.';

-- Is this person a current owner or admin of the organization: an accepted
-- membership with the role owner or admin that is not an act-as seat, on an
-- account that is not disabled (0422's rule for a current member, and the
-- role). Only they can open the review pages, so only they may own an item
-- and be reminded.
create function public._supplier_risk_is_current_admin(p_organization_id uuid, p_user_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.organization_members m
     where m.organization_id = p_organization_id
       and m.user_id = p_user_id
       and m.role in ('owner', 'admin')
       and m.accepted_at is not null
       and m.impersonation_expires_at is null
       and not exists (select 1 from public.user_profiles up
                        where up.id = m.user_id and up.disabled_at is not null));
$$;

revoke all on function public._supplier_risk_is_current_admin(uuid, uuid) from public, anon, authenticated, service_role;

comment on function public._supplier_risk_is_current_admin(uuid, uuid) is
  'Private (0481). Is this person a current owner or admin of the organization: role owner or admin, accepted, not an act-as seat, account not disabled. False for a null person. SECURITY INVOKER: its callers run as their owner. No API role may call it.';

-- Is the caller in this organization on a support (act-as) seat (0413's
-- reading: a membership with impersonation_expires_at set). Such a seat may
-- read the reviews and never write one.
create function public._supplier_risk_caller_is_act_as(p_organization_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.organization_members m
     where m.organization_id = p_organization_id
       and m.user_id = auth.uid()
       and m.impersonation_expires_at is not null);
$$;

revoke all on function public._supplier_risk_caller_is_act_as(uuid) from public, anon, authenticated, service_role;

comment on function public._supplier_risk_caller_is_act_as(uuid) is
  'Private (0481). Is the caller (auth.uid()) on an act-as seat in the organization: its membership has impersonation_expires_at set. The four writes refuse such a caller (42501 supplier_risk_act_as_read_only). SECURITY INVOKER: its callers run as their owner. No API role may call it.';

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
  reviewed_as_name          text,
  name_changed              boolean,
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
  due_reminder              text,
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
           c.supplier_name,
           coalesce(s.id is not null and c.id is not null
                    and coalesce(public._supplier_risk_plain_name(s.name, 300), '(no name)')
                        is distinct from c.supplier_name, false),
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
           case when c.id is null or c.reminded_due_at is null then null
                when c.reminded_due_sent_at is not null then 'sent'
                when c.reminded_due_retry_at is not null
                     and c.reminded_due_retry_at < pg_catalog.now() - interval '24 hours' then 'not_sent'
                else 'claimed' end,
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
  'The vendor risk register of an organization (0481), for its owners and admins: every active supplier, and every archived or deleted one that has a review, by name (today''s, or a deleted supplier''s newest snapshot); reviewed_as_name (the current review''s name as reviewed) and name_changed (the supplier is still there and its name today is not the name reviewed); supplier_state (active, archived, deleted) and archived time; the current review''s id, version, data level, result in force, computed result, overridden, starting risk, evidence, risk left, hard stops, when and by whom (reviewer_account_deleted when the link emptied), next review date and review_due (not_reviewed, overdue, due_today, due_soon within 30 days, scheduled; days in the organization''s zone); due_reminder (null: not claimed; claimed; sent: confirmed by the job; not_sent: claimed twice and still not confirmed 24 hours after the second claim); its open items (open and in_progress) and the highest severity among them; the open draft''s id and time. 42501 supplier_risk_not_allowed for anyone else; 42501 mfa_required or aal2_required where the second step is owed. Read-only.';

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
    'owner_is_admin', public._supplier_risk_is_current_admin(p_item.organization_id, p_item.owner_user_id),
    'due_on', p_item.due_on,
    'status', p_item.status,
    'closed_at', p_item.closed_at,
    'changed_by', p_item.changed_by,
    'changed_by_name', p_item.changed_by_name,
    'changed_at', p_item.changed_at,
    'accepted_by', p_item.accepted_by,
    'accepted_by_name', p_item.accepted_by_name,
    'accepted_reason', p_item.accepted_reason,
    'created_at', p_item.created_at,
    'updated_at', p_item.updated_at);
$$;

revoke all on function public._supplier_risk_item_json(public.supplier_risk_items) from public, anon, authenticated, service_role;

comment on function public._supplier_risk_item_json(public.supplier_risk_items) is
  'Private (0481). One item as the reads give it, with owner_is_admin (the owner is still a current owner or admin: accepted, not an act-as seat, account not disabled), who changed it last and when, and for a risk accepted who accepted it and why. SECURITY INVOKER: its callers run as their owner. No API role may call it.';

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
    'reviewed_on', v_r.reviewed_on,
    'next_review_on', v_r.next_review_on,
    'reminded_30_at', v_r.reminded_30_at,
    'reminded_due_at', v_r.reminded_due_at,
    'reminded_due_retry_at', v_r.reminded_due_retry_at,
    'reminded_due_sent_at', v_r.reminded_due_sent_at,
    'created_at', v_r.created_at,
    'updated_at', v_r.updated_at,
    'items', v_items);
end;
$$;

revoke all on function public.supplier_risk_review(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.supplier_risk_review(uuid, uuid) to authenticated;

comment on function public.supplier_risk_review(uuid, uuid) is
  'One version of a review, whole (0481): id, organization_id, supplier_id, supplier_name (the snapshot), supplier_state (active, archived, deleted), version, status, is_current, rules_version, data_level, answers, starting_risk, evidence, residual_risk, hard_stops, computed_result, override_result, override_reason, result, reviewer_id, reviewer_name, reviewed_at, reviewed_on, next_review_on, reminded_30_at, reminded_due_at, reminded_due_retry_at, reminded_due_sent_at, created_at, updated_at, and items (in question order: id, review_id, question_key, answer, severity, finding, action, owner_user_id, owner_name, owner_is_admin, due_on, status, closed_at, changed_by, changed_by_name, changed_at, accepted_by, accepted_by_name, accepted_reason, created_at, updated_at). Null when there is no such review in the organization. For its owners and admins only: 42501 as supplier_risk_register. Read-only.';

create function public.supplier_risk_items_for_organization(p_organization_id uuid, p_open_only boolean default true)
returns table (
  item_id          uuid,
  review_id        uuid,
  supplier_id      uuid,
  supplier_name    text,
  reviewed_as_name text,
  name_changed     boolean,
  supplier_state   text,
  question_key     text,
  answer           text,
  severity         text,
  finding          text,
  action           text,
  owner_user_id    uuid,
  owner_name       text,
  owner_is_admin   boolean,
  due_on           date,
  status           text,
  closed_at        timestamptz,
  changed_by_name  text,
  changed_at       timestamptz,
  accepted_by_name text,
  accepted_reason  text,
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
    select i.id, i.review_id, r.supplier_id, coalesce(s.name, r.supplier_name), r.supplier_name,
           coalesce(s.id is not null
                    and coalesce(public._supplier_risk_plain_name(s.name, 300), '(no name)')
                        is distinct from r.supplier_name, false),
           case when s.id is null then 'deleted' when s.deleted_at is not null then 'archived' else 'active' end,
           i.question_key, i.answer, i.severity, i.finding, i.action, i.owner_user_id, i.owner_name,
           public._supplier_risk_is_current_admin(i.organization_id, i.owner_user_id),
           i.due_on, i.status, i.closed_at, i.changed_by_name, i.changed_at, i.accepted_by_name, i.accepted_reason,
           i.created_at, i.updated_at
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
  'The items of an organization''s current reviews (0481), open and in_progress only unless p_open_only is false: item_id, review_id, supplier_id, supplier_name (today''s), reviewed_as_name, name_changed, supplier_state, question_key, answer (no, not_shown, out_of_date), severity, finding, action, owner_user_id, owner_name, owner_is_admin, due_on, status, closed_at, changed_by_name, changed_at, accepted_by_name, accepted_reason, created_at, updated_at; most severe first, then by due date (none last), supplier and question. For its owners and admins only: 42501 as supplier_risk_register. Read-only.';

-- ── The admins' writes ───────────────────────────────────────────────────────
-- Each write takes this file's advisory lock for the supplier (4810001 and
-- the hash of the organization and supplier ids), so two writes for one
-- supplier run one after the other; a wait ends after 5 s (55P03). Each
-- refuses a support (act-as) seat after the opening checks.

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
  if public._supplier_risk_caller_is_act_as(p_organization_id) then
    raise exception 'supplier_risk_act_as_read_only' using errcode = '42501', hint = 'supplier_risk_act_as_read_only';
  end if;

  if p_supplier_id is null then
    raise exception 'supplier_not_found' using errcode = '22023', hint = 'supplier_not_found';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(4810001, pg_catalog.hashtext(p_organization_id::text || ':' || p_supplier_id::text));

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

  v_problem := public._supplier_risk_answers_problem(1::smallint, p_data_level, p_answers, false, (pg_catalog.now() at time zone 'UTC')::date);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = '22023', hint = v_problem;
  end if;

  v_name := coalesce(public._supplier_risk_plain_name(v_name, 300), '(no name)');

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
                  where r.organization_id = p_organization_id and r.supplier_id = p_supplier_id), 0) + 1,
       'draft', p_data_level, p_answers, v_uid, public._supplier_risk_person_name(v_uid))
    returning id, version, updated_at into v_id, v_version, v_updated;
  end if;

  return pg_catalog.jsonb_build_object('review_id', v_id, 'version', v_version, 'updated_at', v_updated);
end;
$$;

revoke all on function public.supplier_risk_draft_save(uuid, uuid, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.supplier_risk_draft_save(uuid, uuid, text, jsonb) to authenticated;

comment on function public.supplier_risk_draft_save(uuid, uuid, text, jsonb) is
  'Writes the one draft review of a supplier (0481): updates it when there is one, else makes version max + 1; keeps the caller as the reviewer and the supplier''s name (as plain text: hidden characters out, each run of spaces one space). Answers may be partial (every given key must be asked at the level; a Yes may wait for its date), and a date beside the security report or insurance may be at most one day after today in UTC. Returns {review_id, version, updated_at}. 42501 supplier_risk_not_allowed (not an admin or owner of the organization), mfa_required, aal2_required, supplier_risk_act_as_read_only (a support seat); 22023 supplier_not_found (none, or of another organization), supplier_archived, and the answer words of _supplier_risk_answers_problem (bad_data_level, answers_not_an_object, answer_unknown_question, answer_not_applicable, answer_bad_shape, answer_bad_value, answer_bad_note, answer_date_not_allowed, answer_bad_date, answer_date_in_future). Takes the supplier''s lock (4810001); a wait ends after 5 s (55P03).';

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
  v_stale      text[];
  v_me         text;
begin
  if p_organization_id is null
     or not coalesce(public.has_org_role(p_organization_id, 'admin'), false) then
    raise exception 'supplier_risk_not_allowed' using errcode = '42501', hint = 'supplier_risk_not_allowed';
  end if;
  perform public.security_events_reader_check(p_organization_id);
  if public._supplier_risk_caller_is_act_as(p_organization_id) then
    raise exception 'supplier_risk_act_as_read_only' using errcode = '42501', hint = 'supplier_risk_act_as_read_only';
  end if;

  if p_supplier_id is null then
    raise exception 'supplier_not_found' using errcode = '22023', hint = 'supplier_not_found';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(4810001, pg_catalog.hashtext(p_organization_id::text || ':' || p_supplier_id::text));

  select s.name, s.deleted_at into v_name, v_archived
    from public.suppliers s
   where s.id = p_supplier_id and s.organization_id = p_organization_id;
  if not found then
    raise exception 'supplier_not_found' using errcode = '22023', hint = 'supplier_not_found';
  end if;
  if v_archived is not null then
    raise exception 'supplier_archived' using errcode = '22023', hint = 'supplier_archived';
  end if;
  v_name := coalesce(public._supplier_risk_plain_name(v_name, 300), '(no name)');

  v_problem := public._supplier_risk_answers_problem(1::smallint, p_data_level, p_answers, true, (pg_catalog.now() at time zone 'UTC')::date);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = '22023', hint = v_problem;
  end if;

  v_zone := public._supplier_risk_org_zone(p_organization_id);
  v_today := (pg_catalog.now() at time zone v_zone)::date;
  -- The rules on the day of the review (the dates beside the answers are
  -- judged against it).
  v_eval := public._supplier_risk_evaluate(1::smallint, p_data_level, p_answers, v_today);

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

  -- The items: exactly one for each gap the rules found, by question key (a
  -- Yes out of date is a gap).
  v_gaps := array(select pg_catalog.jsonb_array_elements_text(v_eval -> 'gaps'));
  v_stale := array(select pg_catalog.jsonb_array_elements_text(v_eval -> 'out_of_date'));
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
    if v_owner is not null and not public._supplier_risk_is_current_admin(p_organization_id, v_owner) then
      raise exception 'item_owner_not_an_admin' using errcode = '22023', hint = 'item_owner_not_an_admin';
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
   where r.organization_id = p_organization_id and r.supplier_id = p_supplier_id and r.is_current
  returning r.id into v_old;

  v_me := public._supplier_risk_person_name(v_uid);

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
         reviewer_name = v_me,
         reviewed_at = pg_catalog.now(),
         reviewed_on = v_today,
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
       reviewer_id, reviewer_name, reviewed_at, reviewed_on, next_review_on)
    values
      (p_organization_id, p_supplier_id, v_name,
       coalesce((select pg_catalog.max(r.version) from public.supplier_risk_reviews r
                  where r.organization_id = p_organization_id and r.supplier_id = p_supplier_id), 0) + 1,
       'final', true, p_data_level, p_answers,
       v_eval ->> 'starting_risk', v_eval ->> 'evidence', v_eval ->> 'residual_risk', v_hard,
       v_eval ->> 'result', p_override_result, p_override_reason,
       v_uid, v_me, pg_catalog.now(), v_today, v_next)
    returning id, version into v_id, v_version;
  end if;

  insert into public.supplier_risk_items
    (organization_id, review_id, question_key, answer, severity, finding, action, owner_user_id, owner_name, due_on,
     changed_by, changed_by_name, changed_at)
  select p_organization_id, v_id, q.key,
         case when q.key = any (v_stale) then 'out_of_date' else p_answers -> q.key ->> 'answer' end,
         case when p_data_level = 'student' then q.severity_student else q.severity_staff end,
         e.value ->> 'finding', e.value ->> 'action',
         (e.value ->> 'owner_user_id')::uuid,
         case when e.value ->> 'owner_user_id' is not null
              then public._supplier_risk_person_name((e.value ->> 'owner_user_id')::uuid) end,
         (e.value ->> 'due_on')::date,
         v_uid, v_me, pg_catalog.now()
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
    'out_of_date', v_eval -> 'out_of_date',
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
  'Finishes a supplier''s review in one transaction (0481): the open draft (or a new version) becomes final and current with these answers (every question asked at the level answered; a Yes to the security report or insurance with the date on the document, at most one day after today in UTC), what the database''s rules give on the organization''s today (never a result sent to it; a security report or insurance dated more than 12 months before today counts as Not shown, out of date), the override and its reason if any, the caller as the reviewer, now, and the next review date (p_next_review_on after today and at most 3 years ahead, days in the organization''s zone; null: 12 months, 6 with student data); the review that was current becomes history; one item is written for each gap from p_items, an array of {question_key, finding, action, owner_user_id (a current owner or admin, or null), due_on (today to 3 years ahead, or null)} with exactly one element for each gap the rules found (No, Not shown, or out of date) and no other field (the severity and the answer are the rules''; the caller is written as who changed each item last). Returns {review_id, version, superseded_review_id, starting_risk, evidence, residual_risk, hard_stops, pending_hard_stops, out_of_date, computed_result, override_result, result, next_review_on, items}. 42501 supplier_risk_not_allowed, mfa_required, aal2_required, supplier_risk_act_as_read_only; 22023 supplier_not_found, supplier_archived, the answer words (answer_date_in_future, answer_date_missing and answers_incomplete included), bad_next_review_on, bad_override (no result, not one of the four, or the computed one; or a reason with no result), bad_override_reason (the reason rule: 1 to 2000 characters with no hidden character, at least 20 once each run of spaces is one, at least 5 different), items_not_an_array, items_do_not_match_answers, bad_item, bad_item_text (finding 1 to 500, action 1 to 1000), item_owner_not_an_admin, bad_item_due_on. Takes the supplier''s lock (4810001); a wait ends after 5 s (55P03).';

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
  if public._supplier_risk_caller_is_act_as(p_organization_id) then
    raise exception 'supplier_risk_act_as_read_only' using errcode = '42501', hint = 'supplier_risk_act_as_read_only';
  end if;

  if p_supplier_id is null then
    return false;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(4810001, pg_catalog.hashtext(p_organization_id::text || ':' || p_supplier_id::text));

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
  'Deletes the open draft review of a supplier (0481), also when the supplier is archived or deleted; true when there was one, false when there was none (or it is another organization''s). Never deletes a final review. 42501 supplier_risk_not_allowed, mfa_required, aal2_required, supplier_risk_act_as_read_only. Takes the supplier''s lock (4810001); a wait ends after 5 s (55P03).';

create function public.supplier_risk_item_update(
  p_organization_id uuid,
  p_item_id uuid,
  p_status text,
  p_owner_user_id uuid,
  p_due_on date,
  p_action text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_uid        uuid := auth.uid();
  v_supplier   uuid;
  v_i          public.supplier_risk_items;
  v_current    boolean;
  v_today      date;
  v_owner_nm   text;
  v_me         text;
  v_acc_by     uuid;
  v_acc_name   text;
  v_acc_reason text;
begin
  if p_organization_id is null
     or not coalesce(public.has_org_role(p_organization_id, 'admin'), false) then
    raise exception 'supplier_risk_not_allowed' using errcode = '42501', hint = 'supplier_risk_not_allowed';
  end if;
  perform public.security_events_reader_check(p_organization_id);
  if public._supplier_risk_caller_is_act_as(p_organization_id) then
    raise exception 'supplier_risk_act_as_read_only' using errcode = '42501', hint = 'supplier_risk_act_as_read_only';
  end if;

  select r.supplier_id into v_supplier
    from public.supplier_risk_items i
    join public.supplier_risk_reviews r on r.id = i.review_id and r.organization_id = i.organization_id
   where i.id = p_item_id and i.organization_id = p_organization_id;
  if not found then
    raise exception 'item_not_found' using errcode = '22023', hint = 'item_not_found';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(4810001, pg_catalog.hashtext(p_organization_id::text || ':' || v_supplier::text));

  -- Read again under the lock: a review finished meanwhile makes this one
  -- history.
  select i.* into v_i
    from public.supplier_risk_items i
   where i.id = p_item_id and i.organization_id = p_organization_id
     for update;
  select r.is_current into v_current
    from public.supplier_risk_reviews r
   where r.id = v_i.review_id and r.organization_id = p_organization_id;
  if not coalesce(v_current, false) then
    raise exception 'item_not_current' using errcode = '22023', hint = 'item_not_current';
  end if;

  if p_status is null or p_status not in ('open', 'in_progress', 'done', 'accepted') then
    raise exception 'bad_item_status' using errcode = '22023', hint = 'bad_item_status';
  end if;

  -- A new owner must be a current owner or admin (only they can open the
  -- page); the same owner stays even after they leave or lose the role, so
  -- the status can still be changed. The name kept for an owner whose
  -- account was deleted (the link already empty) stays too, until a new
  -- owner is named.
  if p_owner_user_id is not null and p_owner_user_id is distinct from v_i.owner_user_id then
    if not public._supplier_risk_is_current_admin(p_organization_id, p_owner_user_id) then
      raise exception 'item_owner_not_an_admin' using errcode = '22023', hint = 'item_owner_not_an_admin';
    end if;
    v_owner_nm := public._supplier_risk_person_name(p_owner_user_id);
  elsif p_owner_user_id is not null or v_i.owner_user_id is null then
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

  v_me := public._supplier_risk_person_name(v_uid);
  -- A risk accepted always carries who accepted it and why: accepting needs
  -- a reason (the reason rule); a reason given again while it stays accepted
  -- replaces both; leaving accepted clears both; a reason goes with nothing
  -- else.
  if p_status = 'accepted' then
    if p_reason is not null then
      if not public._supplier_risk_reason_ok(p_reason) then
        raise exception 'bad_item_reason' using errcode = '22023', hint = 'bad_item_reason';
      end if;
      v_acc_by := v_uid;
      v_acc_name := v_me;
      v_acc_reason := p_reason;
    elsif v_i.status = 'accepted' then
      v_acc_by := v_i.accepted_by;
      v_acc_name := v_i.accepted_by_name;
      v_acc_reason := v_i.accepted_reason;
    else
      raise exception 'bad_item_reason' using errcode = '22023', hint = 'bad_item_reason';
    end if;
  elsif p_reason is not null then
    raise exception 'bad_item_reason' using errcode = '22023', hint = 'bad_item_reason';
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
         accepted_by = v_acc_by,
         accepted_by_name = v_acc_name,
         accepted_reason = v_acc_reason,
         changed_by = v_uid,
         changed_by_name = v_me,
         changed_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   where i.id = p_item_id
  returning i.* into v_i;

  return public._supplier_risk_item_json(v_i);
end;
$$;

revoke all on function public.supplier_risk_item_update(uuid, uuid, text, uuid, date, text, text) from public, anon, authenticated, service_role;
grant execute on function public.supplier_risk_item_update(uuid, uuid, text, uuid, date, text, text) to authenticated;

comment on function public.supplier_risk_item_update(uuid, uuid, text, uuid, date, text, text) is
  'Changes one item of a current review (0481): its status (open, in_progress, done, accepted; done and accepted stamp closed_at, kept while it stays closed; open and in_progress clear it), owner (null for none; a new owner must be a current owner or admin, the same owner stays after leaving; a name kept for a deleted account stays until a new owner is named), due date (null for none; a new one today to 3 years ahead, days in the organization''s zone), action (null keeps it) and, for accepted, the reason (required to accept, by the reason rule; null keeps it while it stays accepted; refused with any other status). Writes the caller as who changed it last, and as who accepted it with the reason. The finding, answer and severity never change. Returns the item as supplier_risk_review gives it. 42501 supplier_risk_not_allowed, mfa_required, aal2_required, supplier_risk_act_as_read_only; 22023 item_not_found (none, or another organization''s), item_not_current (an earlier version''s), bad_item_status, item_owner_not_an_admin, bad_item_due_on, bad_item_text, bad_item_reason. Takes the supplier''s lock (4810001); a wait ends after 5 s (55P03).';

-- ── The daily job's reminders ────────────────────────────────────────────────
-- Two reminders for the current review of an active supplier: 'due_soon'
-- when the next review date is 1 to 30 days away and the review was
-- finished before that window opened (a review made inside it is not
-- reminded at once), and 'due' on the date or after it. Each is claimed,
-- stamped before it is sent. The due reminder has a second chance: the job
-- confirms it sent it (supplier_risk_due_reminder_sent); a claim not
-- confirmed within 24 hours is offered once more (attempt 2), and one not
-- confirmed 24 hours after that shows as not sent on the register. Days are
-- in the organization's zone. The people reminded are the organization's
-- current owners and admins (the only people who can open the page), and
-- the owners of open items among them.

create function public.supplier_risk_reminders_due(p_limit integer default 100)
returns table (
  review_id            uuid,
  organization_id      uuid,
  supplier_id          uuid,
  supplier_name        text,
  kind                 text,
  attempt              integer,
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
             r.reminded_30_at, r.reminded_due_at, r.reminded_due_retry_at, r.reminded_due_sent_at
        from public.supplier_risk_reviews r
       where r.is_current
         and r.next_review_on <= (pg_catalog.now() at time zone 'UTC')::date + 32
         and (r.reminded_30_at is null or r.reminded_due_at is null
              or (r.reminded_due_sent_at is null and r.reminded_due_retry_at is null))
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
                  when k.reminded_due_at is not null and k.reminded_due_sent_at is null
                       and k.reminded_due_retry_at is null
                       and k.reminded_due_at < pg_catalog.now() - interval '24 hours'
                       and k.next_review_on <= k.today then 'due'
                  when k.reminded_30_at is null
                       and k.next_review_on > k.today and k.next_review_on <= k.today + 30
                       and (k.reviewed_at at time zone k.zone)::date < k.next_review_on - 30 then 'due_soon'
             end as kind
        from k
    )
    select d.id, d.organization_id, d.supplier_id, s.name, d.kind,
           case when d.kind = 'due' and d.reminded_due_at is not null then 2 else 1 end,
           d.next_review_on, d.today, d.data_level, d.result,
           array(select m.user_id from public.organization_members m
                  where m.organization_id = d.organization_id
                    and public._supplier_risk_is_current_admin(d.organization_id, m.user_id)
                  order by m.user_id),
           array(select distinct i.owner_user_id from public.supplier_risk_items i
                  where i.review_id = d.id and i.status in ('open', 'in_progress') and i.owner_user_id is not null
                    and public._supplier_risk_is_current_admin(d.organization_id, i.owner_user_id)
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
  'For the daily reminder job (0481): current reviews of active suppliers with a reminder to send, at most p_limit (1 to 500, default 100), soonest first: review_id, organization_id, supplier_id, supplier_name, kind (due: the next review date is today or past and the due reminder was not claimed, or was claimed more than 24 hours ago, never confirmed and not yet claimed again; due_soon: it is 1 to 30 days away, the review was finished before that window opened, and the 30-day reminder was not claimed), attempt (2 for the due reminder''s second chance, else 1), next_review_on, org_today (days in the organization''s zone), data_level, result, admin_user_ids (current owners and admins) and item_owner_user_ids (owners of open items who are current owners or admins). Archived and deleted suppliers are left out. Claim each with supplier_risk_reminder_claim before sending, and confirm a due reminder with supplier_risk_due_reminder_sent after; a claimed row leaves this list. Read-only. service_role only: the grant is the whole control; called as authenticated or anon it raises 42501.';

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
    get diagnostics v_n = row_count;
    -- The second chance: a first claim more than 24 hours old that the job
    -- never confirmed, not claimed again yet.
    if v_n = 0 then
      update public.supplier_risk_reviews r
         set reminded_due_retry_at = pg_catalog.now()
       where r.id = p_review_id
         and r.is_current
         and r.reminded_due_retry_at is null
         and r.reminded_due_sent_at is null
         and r.reminded_due_at < pg_catalog.now() - interval '24 hours'
         and r.next_review_on <= v_today
         and exists (select 1 from public.suppliers s
                      where s.id = r.supplier_id and s.organization_id = r.organization_id and s.deleted_at is null);
      get diagnostics v_n = row_count;
    end if;
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
    get diagnostics v_n = row_count;
  end if;
  return v_n = 1;
end;
$$;

revoke all on function public.supplier_risk_reminder_claim(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.supplier_risk_reminder_claim(uuid, text) to service_role;

comment on function public.supplier_risk_reminder_claim(uuid, text) is
  'For the daily reminder job (0481): claims one reminder before it is sent, by stamping reminded_due_at (kind due), reminded_due_retry_at (kind due, the second chance: a first claim more than 24 hours old, never confirmed) or reminded_30_at (kind due_soon) when the review is still current, the supplier still active, the reminder still due by the rules of supplier_risk_reminders_due and not claimed. True when this call stamped it; false otherwise (claimed already, by an overlapping call too; no longer due; a null or unknown review or kind). Never raises for an argument. A lock wait ends after 2 s (55P03). Run it under READ COMMITTED (PostgREST''s own). service_role only: the grant is the whole control; called as authenticated or anon it raises 42501.';

create function public.supplier_risk_due_reminder_sent(p_review_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_n integer;
begin
  -- The grant is the gate: service_role only (the second lock, as above).
  if coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon') then
    raise exception 'supplier_risk_not_allowed' using errcode = '42501', hint = 'supplier_risk_not_allowed';
  end if;
  if p_review_id is null then
    return false;
  end if;

  update public.supplier_risk_reviews r
     set reminded_due_sent_at = pg_catalog.now()
   where r.id = p_review_id
     and r.reminded_due_at is not null
     and r.reminded_due_sent_at is null;
  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;

revoke all on function public.supplier_risk_due_reminder_sent(uuid) from public, anon, authenticated, service_role;
grant execute on function public.supplier_risk_due_reminder_sent(uuid) to service_role;

comment on function public.supplier_risk_due_reminder_sent(uuid) is
  'For the daily reminder job (0481): confirms the due reminder of a review was sent, by stamping reminded_due_sent_at once (after either claim). True when this call stamped it; false otherwise (never claimed, confirmed already, a null or unknown review). A confirmed reminder is never offered again; one claimed twice and not confirmed 24 hours after the second claim shows as not_sent on the register. A lock wait ends after 2 s (55P03). service_role only: the grant is the whole control; called as authenticated or anon it raises 42501.';

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- Nothing depends on these objects but the app code that follows this
-- migration. Leave them in place. If they ever have to go, know that each
-- drop table also removes its foreign keys' triggers from
-- public.organizations and public.user_profiles, which takes ACCESS
-- EXCLUSIVE on both until commit (the apply took SHARE ROW EXCLUSIVE): every
-- read of an organization or a profile, so every signed-in request and every
-- row security check that reads them, waits behind it. Run it in a quiet
-- minute, as one transaction with a short lock_timeout; if it gives up
-- (55P03) nothing is dropped, and it can be run again as it is. The rows go
-- with the tables. In this order: the functions first (one takes the items'
-- row type), then the tables (with their triggers), then the trigger
-- functions and the helpers their CHECKs use.
--   begin;
--   set local lock_timeout = '900ms';
--   drop function if exists public.supplier_risk_due_reminder_sent(uuid);
--   drop function if exists public.supplier_risk_reminder_claim(uuid, text);
--   drop function if exists public.supplier_risk_reminders_due(integer);
--   drop function if exists public.supplier_risk_item_update(uuid, uuid, text, uuid, date, text, text);
--   drop function if exists public.supplier_risk_draft_discard(uuid, uuid);
--   drop function if exists public.supplier_risk_finalise(uuid, uuid, text, jsonb, date, text, text, jsonb);
--   drop function if exists public.supplier_risk_draft_save(uuid, uuid, text, jsonb);
--   drop function if exists public.supplier_risk_items_for_organization(uuid, boolean);
--   drop function if exists public.supplier_risk_review(uuid, uuid);
--   drop function if exists public.supplier_risk_history(uuid, uuid);
--   drop function if exists public.supplier_risk_register(uuid);
--   drop function if exists public._supplier_risk_item_json(public.supplier_risk_items);
--   drop function if exists public._supplier_risk_caller_is_act_as(uuid);
--   drop function if exists public._supplier_risk_is_current_admin(uuid, uuid);
--   drop function if exists public._supplier_risk_person_name(uuid);
--   drop function if exists public._supplier_risk_plain_name(text, integer);
--   drop function if exists public._supplier_risk_org_zone(uuid);
--   drop function if exists public._supplier_risk_default_next_review(text, date);
--   drop table if exists public.supplier_risk_items;
--   drop table if exists public.supplier_risk_reviews;
--   drop function if exists public._supplier_risk_items_guard();
--   drop function if exists public._supplier_risk_reviews_guard();
--   drop function if exists public._supplier_risk_computed_ok(smallint, text, jsonb, date, text, text, text, text[], text);
--   drop function if exists public._supplier_risk_evaluate(smallint, text, jsonb, date);
--   drop function if exists public._supplier_risk_answers_problem(smallint, text, jsonb, boolean, date);
--   drop function if exists public._supplier_risk_reason_ok(text);
--   drop function if exists public._supplier_risk_text_ok(text, integer, integer);
--   drop function if exists public._supplier_risk_space_chars();
--   drop function if exists public._supplier_risk_hidden_chars();
--   drop function if exists public._supplier_risk_question_key_ok(text);
--   drop function if exists public._supplier_risk_questions();
--   commit;
