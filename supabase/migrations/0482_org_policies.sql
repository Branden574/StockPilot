-- 0482_org_policies.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Policy sign-off: an organization's owners and admins publish a written
-- policy (acceptable use, data handling, other); its members acknowledge it
-- on the website or the phone; each acknowledgement is kept as evidence.
-- This is the database half; the pages, the phone screen, the API route and
-- the reminder job follow it. Nothing reads or writes these objects until
-- then. This file's number is in its name, its test's name and labels, the
-- advisory lock keys below (4820001, 4820002) and the manifest entry in
-- scripts/security-test.sh.
--
-- WHAT IT ADDS (tier A: four new tables with their keys, checks and indexes,
-- four trigger functions and their triggers on the new tables, four
-- private helpers, fourteen functions and their grants. No stored row. No
-- existing table, column, function, policy, trigger or grant changes. Two
-- existing tables gain the internal triggers of the foreign keys that point
-- at them, as 0472, 0474 and 0475 did: public.organizations (deleting an
-- organization also deletes its policies and their records) and
-- public.user_profiles (deleting an account empties the person column of
-- its acknowledgements and of the versions it published, and deletes its
-- reminder rows). As with most of the SET NULL person keys in public, and
-- unlike 0393's narrow scope, the two person columns that are kept carry no
-- deleted_users marker: each is empty only after its account's deletion
-- (the guards allow nothing else), and the kept name says who it was.)
--   1. public.org_policies. One row per policy: its organization, kind,
--      title, state (draft: never published; published; retired) and the
--      number of its current version.
--   2. public.org_policy_versions. The words. A draft is a row with no
--      version number (at most one per policy), changed by saving the draft.
--      Publishing gives it the next number, says whether it asks members
--      again ("a new version") or not ("a correction"), and the round it
--      belongs to, who published it (and their name as it was) and when,
--      and the policy's kind (a correction keeps the title and the kind: a
--      change of either is a new version).
--      From then on the row never changes and is never deleted (a trigger
--      on this table; no API role has any write privilege): a correction is
--      another row. text_hash is SHA-256 of the title, two line feeds and
--      the body; a check holds it to the stored words. The title and body
--      must already be in the normal form of packages/core
--      src/policies/policy-text.ts (NFC; LF line ends; no tab; no space at a
--      line's end; at most one empty line in a row; none at either end; a
--      title on one line with single spaces), 1 to 120 and 1 to 30,000
--      characters (a body at most 600 lines), without the refused characters (controls other than the
--      line feed, invisible and direction-changing characters, the byte
--      order mark, U+FFF9 to U+FFFF, tags, supplementary variation
--      selectors), and with at most 30 combining marks in a row.
--   3. public.org_policy_acknowledgements. APPEND ONLY. One row per member
--      and version: the version (and its number, round and text hash, as
--      they were), the account (and its name as it was: the profile's full
--      name, never an email; none when the name is empty or holds an '@'),
--      when the membership began (member_since), when, and web or phone. Written only by org_policy_acknowledge, for
--      the caller's own account. Never changed and never deleted: no API
--      role has any write privilege, and a trigger refuses every UPDATE and
--      DELETE from anyone (the table's owner too) but two: deleting an
--      account empties user_id (the only way it is ever empty, so the page
--      shows "Deleted user" with the kept name; an account that had no name
--      keeps 'Former member, no name on the account' and
--      member_since, a row that proves less), and deleting the
--      organization removes its records with it. TRUNCATE is refused by a
--      trigger as well. No job purges a row.
--   4. public.org_policy_reminders. One row per asking version (the round)
--      and member: how many automatic reminders were sent (at most 6) and
--      when, how many "Remind now" reached them, and the last reminder of
--      either kind; and the last correction a member who acknowledged was
--      told of (correction_notice_number). Written by the claims and by
--      Remind now, stamp first.
--   5. The reads and writes, all SECURITY DEFINER, all through functions:
--      members: org_policies_for_member, org_policy_text,
--      org_policy_acknowledge; owners and admins: org_policies_for_admin,
--      org_policy_draft, org_policy_status,
--      org_policy_acknowledgement_record, org_policy_save_draft,
--      org_policy_discard_draft, org_policy_publish, org_policy_retire,
--      org_policy_remind_now; the reminder job (service_role):
--      org_policy_reminders_claim and org_policy_correction_notices_claim.
--
-- WHO CAN READ AND WRITE
--   - RLS is on with NO policy on the four tables, anon and authenticated
--     have no privilege on them, and service_role has SELECT only. So no
--     API role writes a row except through the functions, and no member
--     reads one except through them. (No policy is created, so this file
--     takes none of the locks a CREATE POLICY takes on this platform: 0418's
--     note.)
--   - "A member" is an accepted member of the organization whose account is
--     not disabled (public.is_org_member, 0310: a live act-as seat counts,
--     as it does everywhere else). Members read the published policies of
--     their organization (the current version's words) and, at any time,
--     every version they acknowledged, also after a correction or a
--     retirement. They never read a draft.
--   - "A current member" is the codebase's rule for the people a record is
--     about: an accepted membership that is not an act-as seat, on an
--     account that is not disabled. It is public._notify_is_current_member
--     (0422), the database twin of apps/web/src/server/lib/current-member.ts,
--     and this file calls it wherever it decides who is asked: only a
--     current member may acknowledge, is owed an acknowledgement, is listed
--     as not having acknowledged, is reminded or is counted. Invitations not
--     yet accepted are listed apart. A support act-as seat is never asked
--     and never listed.
--   - Owners and admins (public.has_org_role(org, 'admin'), 0310) read every
--     policy, draft and acknowledgement of their organization and the list
--     of who has not acknowledged, and write drafts, publish, retire and
--     remind. Every admin function checks the role, then the app's
--     authenticator rule through public.security_events_reader_check (0472,
--     as 0474 calls it): where the organization's policy asks owners and
--     admins for an authenticator, or the caller has one, the session must
--     hold the second step (42501 mfa_required, aal2_required). A member's
--     own reads and acknowledgement are not admin functions.
--   - A support (act-as) seat reads what an owner or admin of that
--     organization reads, and never writes: save, discard, publish (a new
--     version or a correction), retire and Remind now refuse it with 42501
--     policy_act_as_read_only, right after the authenticator rule, as
--     0481's writes refuse it (a seat is a membership with
--     impersonation_expires_at set; an expired one is no member at all and
--     gets policy_admins_only). A support person who is a real member of the
--     organization has no seat there (act-as writes none for a real member),
--     so a real owner or admin membership writes as before. A seat never
--     acknowledges (it is not a current member).
--   - An acknowledgement is for the caller's own account only (auth.uid();
--     the function has no account argument), of a version that is the
--     current version of a published policy of an organization the caller is
--     a current member of, with the hash of the words the caller was shown.
--     A repeat answers with the first row and writes nothing. An account
--     with a verified authenticator acknowledges only from a session that
--     holds the second step (0474's account rule).
--   - The two claims are service_role only: the grant is the gate, and
--     each body refuses authenticated and anon as a second lock (0479's
--     form).
--   - The limit of all of it: the tables' owner (the role migrations run
--     as) can switch a trigger off or set session_replication_role, and then
--     no guard here holds. The evidence is as strong as access to the
--     database is controlled.
--   Explicit for anon, authenticated, service_role and PUBLIC on every
--   object (apps/web/src/test/migration-grants.ts), the same with and
--   without Supabase's default grants.
--
-- ERRORS (SQLSTATE, then the hint; the message is the same word)
--   42501 policy_not_allowed (a member function: nobody signed in, not a
--         member, no such policy or version, or a version the caller may not
--         read or acknowledge: one answer, so another organization's ids
--         reveal nothing), policy_admins_only (an admin function),
--         policy_act_as_read_only (an admin write, on a support seat),
--         aal2_required (acknowledge, and every admin function) and
--         mfa_required (an admin function, where an authenticator is asked
--         for and the caller has none).
--   22023 policy_kind_invalid, policy_title_invalid and policy_body_invalid
--         (detail: empty, too_long, too_many_lines, forbidden_character,
--         too_many_marks or not_normal_form),
--         policy_change_invalid, policy_hash_invalid, policy_method_invalid.
--   P0001 policy_no_draft, policy_draft_changed, policy_draft_unchanged,
--         policy_correction_needs_a_version, policy_correction_changes_title,
--         policy_correction_changes_kind, policy_retired,
--         policy_not_published, policy_version_not_found,
--         policy_version_not_current, policy_text_changed.
--   55P03 a lock waited 2 s (the writers' own lock_timeout).
--   55000 org_policy_kept, org_policy_version_kept, org_policy_version_frozen,
--         org_policy_acknowledgement_append_only, org_policy_truncate_refused,
--         org_policy_changed_wrongly (the triggers: only a direct write by
--         the tables' owner can reach them).
--   No function here raises 40001 or 40P01 (PostgREST retries those forever;
--   0367).
--
-- LOCKS: see the prelude below. ROLLBACK: the block at the end of the file;
-- it refuses while any acknowledgement exists.
-- ─────────────────────────────────────────────────────────────────────────────

-- The foreign keys take SHARE ROW EXCLUSIVE on public.organizations and on
-- public.user_profiles, held to commit. The prelude takes both at once,
-- NOWAIT, in a bounded retry (0400's pattern), so the file never waits for
-- one while it holds the other: a busy table fails the attempt at once, the
-- subtransaction gives back what it took, and the next attempt starts 50 to
-- 150 ms later holding nothing; after 40 busy attempts the file raises 55P03
-- and applies nothing. Every write of an organization or a profile (sign-up,
-- profile edits, workspace switching, an account disabled or deleted) waits
-- while the file holds them, until the commit (milliseconds). Reads of both
-- tables do not wait. No policy is created, so supautils takes nothing on
-- the auth, storage and realtime tables, and the functions are plpgsql or
-- SQL that Postgres does not run when it creates them (the two CHECK helpers
-- are created before the tables and read no table). lock_timeout 900ms
-- bounds anything unforeseen; it is not reset at the end of the file, so the
-- push's own last write, made in the same transaction, has the same limit.
set lock_timeout = '900ms';

-- ── Preflight ────────────────────────────────────────────────────────────────
-- Reads the catalogs only. Refuses to run (55000, hint org_policies_preflight,
-- nothing applied) when a name this file creates is taken (the file already
-- ran, or was half applied by hand), when another function already names the
-- advisory lock key, or when a rule this file relies on is not the body it was
-- written against (head 0480, read 2026-11-24): the membership predicates
-- (0310), the current-member rule (0422) and the admins' authenticator check
-- (0472).
do $preflight$
declare
  v_bad text := '';
  r record;
begin
  if exists (select 1 from pg_catalog.pg_class c
              where c.relnamespace = 'public'::regnamespace
                and (c.relname like 'org\_policies%' or c.relname like 'org\_policy\_%'))
     or exists (select 1 from pg_catalog.pg_type t
                 where t.typnamespace = 'public'::regnamespace
                   and (t.typname like 'org\_policies%' or t.typname like 'org\_policy\_%'
                        or t.typname like '\_org\_policies%' or t.typname like '\_org\_policy\_%')) then
    v_bad := v_bad || ' a table, index or type name this file creates is taken (or this file already ran);';
  end if;

  if exists (select 1 from pg_catalog.pg_proc p
              where p.pronamespace = 'public'::regnamespace
                and (p.proname like 'org\_policies\_%' or p.proname like 'org\_policy\_%'
                     or p.proname like '\_org\_policies\_%' or p.proname like '\_org\_policy\_%')) then
    v_bad := v_bad || ' a function name this file creates is taken (or this file already ran);';
  end if;

  if exists (select 1 from pg_catalog.pg_proc p where p.prosrc like '%4820001%') then
    v_bad := v_bad || ' another function already names the advisory lock key 4820001;';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p where p.prosrc like '%4820002%') then
    v_bad := v_bad || ' another function already names the advisory lock key 4820002;';
  end if;

  for r in
    select v.sig, v.want_src, v.want_secdef, p.oid as poid, pg_catalog.md5(p.prosrc) as got_src,
           p.prosecdef as got_secdef, pg_catalog.pg_get_userbyid(p.proowner) as got_owner
      from (values
        ('public.has_org_role(uuid,text)',              '10422b29a6e15acd003d4f11ed28e90c', true),
        ('public.is_org_member(uuid)',                  '76492a6556e9f6a7c33d942aa9726f9f', true),
        ('public._notify_is_current_member(uuid,uuid)', '9b13426ef2beeb9511c8c0fe6f325741', true),
        ('public.security_events_reader_check(uuid)',   'c19c9c68f5e04751b75d14836f69801b', true)
      ) v(sig, want_src, want_secdef)
      left join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(v.sig)
  loop
    if r.poid is null then
      v_bad := v_bad || pg_catalog.format(' %s missing;', r.sig);
    elsif r.got_src <> r.want_src or r.got_secdef <> r.want_secdef or r.got_owner <> 'postgres' then
      v_bad := v_bad || pg_catalog.format(' %s drifted (md5 %s, definer %s, owner %s);',
                                          r.sig, r.got_src, r.got_secdef, r.got_owner);
    end if;
  end loop;

  -- The columns the functions read.
  for r in
    select v.tbl, v.col
      from (values
        ('public.organization_members', 'organization_id'), ('public.organization_members', 'user_id'),
        ('public.organization_members', 'role'), ('public.organization_members', 'accepted_at'),
        ('public.organization_members', 'impersonation_expires_at'),
        ('public.organizations', 'mfa_policy'),
        ('public.user_profiles', 'full_name'), ('public.user_profiles', 'email'),
        ('public.user_profiles', 'disabled_at'),
        ('public.organization_invites', 'organization_id'), ('public.organization_invites', 'email'),
        ('public.organization_invites', 'role'), ('public.organization_invites', 'accepted_at'),
        ('public.organization_invites', 'revoked_at'), ('public.organization_invites', 'expires_at'),
        ('public.organization_invites', 'created_at'),
        ('auth.mfa_factors', 'user_id'), ('auth.mfa_factors', 'status')
      ) v(tbl, col)
     where not exists (select 1 from pg_catalog.pg_attribute a
                        where a.attrelid = pg_catalog.to_regclass(v.tbl) and a.attname = v.col
                          and a.attnum > 0 and not a.attisdropped)
  loop
    v_bad := v_bad || pg_catalog.format(' %s.%s missing;', r.tbl, r.col);
  end loop;

  if v_bad <> '' then
    raise exception 'org_policies_preflight:%', v_bad
      using errcode = '55000', hint = 'org_policies_preflight';
  end if;
end
$preflight$;

-- ── The lock prelude (see LOCKS above) ───────────────────────────────────────
-- Inside DO because the CLI batch is not a transaction block (a top-level
-- LOCK TABLE refuses there, as 0373 found); the locks last until the batch
-- commits.
do $lock$
declare
  v_try integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.organizations, public.user_profiles in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if v_try >= 40 then
        raise;
      end if;
    end;
    perform pg_catalog.pg_sleep(0.05 + pg_catalog.random() * 0.1);
  end loop;
end
$lock$;

-- ── The text rules (packages/core src/policies/policy-text.ts) ───────────────
-- Why a title or a body would be refused, in the core's words (empty,
-- too_long, too_many_lines for a body, forbidden_character, too_many_marks,
-- not_normal_form, checked in that order), or null. Used by the tables'
-- checks and, for the refusal's detail, by the writers. The refused
-- characters are one bracket expression, the same in both
-- (policy-text.parity.test.ts compares it with FORBIDDEN_POLICY_CODE_POINTS).
-- A title's line feed is not refused, it is not normal form (the core turns
-- it into a space); a carriage return and a tab are refused characters in
-- both.
-- too_many_marks: more than 30 combining marks in a row (the stream-safe
-- limit of UAX #15; no written language comes near it). Unicode
-- normalisation puts marks that are out of order back in order with an
-- insertion sort, so a long run costs a client's normaliser the square of its
-- length every time a page or the phone shows the text (review of
-- 2026-11-27, M2); a text holding one is refused. The marks are every
-- combining mark of Unicode 17.0 (General_Category Mn, Mc, Me), named by
-- code point because Postgres cannot name a Unicode property: one bracket
-- expression, the same in both functions and the same ranges as the core's
-- POLICY_COMBINING_MARK_RANGES (policy-text.parity.test.ts compares them).
-- Postgres matches it in time linear in the text. What the two cannot agree
-- on, and why it is safe: (1) the core also counts what its engine's own
-- tables call a mark or unassigned (a mark added to Unicode after 17.0), so
-- it refuses a run of those that this rule accepts: the core is the stricter
-- side, and its reader shows such a run as one U+FFFD; (2) Unicode
-- normalisation itself: Postgres 17 does not know the marks of the Unicode
-- versions after its tables, so a short run (at most 30) of those, out of
-- order, is normal form here and not in a newer core (it refuses it); such a
-- run costs a reader at most 30 squared steps.
create function public._org_policy_title_problem(p_title text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_title is null or p_title = '' then 'empty'
    when pg_catalog.char_length(p_title) > 120 then 'too_long'
    when p_title ~ '[\u0001-\u0009\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFF\U000E0000-\U000E007F\U000E0100-\U000E01EF]'
      then 'forbidden_character'
    when p_title ~ ('[\u0300-\u036F\u0483-\u0489\u0591-\u05BD\u05BF\u05C1-\u05C2\u05C4-\u05C5\u05C7'
                    '\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7-\u06E8\u06EA-\u06ED'
                    '\u0711\u0730-\u074A\u07A6-\u07B0\u07EB-\u07F3\u07FD\u0816-\u0819\u081B-\u0823'
                    '\u0825-\u0827\u0829-\u082D\u0859-\u085B\u0897-\u089F\u08CA-\u08E1\u08E3-\u0903'
                    '\u093A-\u093C\u093E-\u094F\u0951-\u0957\u0962-\u0963\u0981-\u0983\u09BC\u09BE-\u09C4'
                    '\u09C7-\u09C8\u09CB-\u09CD\u09D7\u09E2-\u09E3\u09FE\u0A01-\u0A03\u0A3C\u0A3E-\u0A42'
                    '\u0A47-\u0A48\u0A4B-\u0A4D\u0A51\u0A70-\u0A71\u0A75\u0A81-\u0A83\u0ABC\u0ABE-\u0AC5'
                    '\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AE2-\u0AE3\u0AFA-\u0AFF\u0B01-\u0B03\u0B3C\u0B3E-\u0B44'
                    '\u0B47-\u0B48\u0B4B-\u0B4D\u0B55-\u0B57\u0B62-\u0B63\u0B82\u0BBE-\u0BC2\u0BC6-\u0BC8'
                    '\u0BCA-\u0BCD\u0BD7\u0C00-\u0C04\u0C3C\u0C3E-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D'
                    '\u0C55-\u0C56\u0C62-\u0C63\u0C81-\u0C83\u0CBC\u0CBE-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD'
                    '\u0CD5-\u0CD6\u0CE2-\u0CE3\u0CF3\u0D00-\u0D03\u0D3B-\u0D3C\u0D3E-\u0D44\u0D46-\u0D48'
                    '\u0D4A-\u0D4D\u0D57\u0D62-\u0D63\u0D81-\u0D83\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF'
                    '\u0DF2-\u0DF3\u0E31\u0E34-\u0E3A\u0E47-\u0E4E\u0EB1\u0EB4-\u0EBC\u0EC8-\u0ECE'
                    '\u0F18-\u0F19\u0F35\u0F37\u0F39\u0F3E-\u0F3F\u0F71-\u0F84\u0F86-\u0F87\u0F8D-\u0F97'
                    '\u0F99-\u0FBC\u0FC6\u102B-\u103E\u1056-\u1059\u105E-\u1060\u1062-\u1064\u1067-\u106D'
                    '\u1071-\u1074\u1082-\u108D\u108F\u109A-\u109D\u135D-\u135F\u1712-\u1715\u1732-\u1734'
                    '\u1752-\u1753\u1772-\u1773\u17B4-\u17D3\u17DD\u180B-\u180D\u180F\u1885-\u1886\u18A9'
                    '\u1920-\u192B\u1930-\u193B\u1A17-\u1A1B\u1A55-\u1A5E\u1A60-\u1A7C\u1A7F\u1AB0-\u1ADD'
                    '\u1AE0-\u1AEB\u1B00-\u1B04\u1B34-\u1B44\u1B6B-\u1B73\u1B80-\u1B82\u1BA1-\u1BAD'
                    '\u1BE6-\u1BF3\u1C24-\u1C37\u1CD0-\u1CD2\u1CD4-\u1CE8\u1CED\u1CF4\u1CF7-\u1CF9'
                    '\u1DC0-\u1DFF\u20D0-\u20F0\u2CEF-\u2CF1\u2D7F\u2DE0-\u2DFF\u302A-\u302F\u3099-\u309A'
                    '\uA66F-\uA672\uA674-\uA67D\uA69E-\uA69F\uA6F0-\uA6F1\uA802\uA806\uA80B\uA823-\uA827'
                    '\uA82C\uA880-\uA881\uA8B4-\uA8C5\uA8E0-\uA8F1\uA8FF\uA926-\uA92D\uA947-\uA953'
                    '\uA980-\uA983\uA9B3-\uA9C0\uA9E5\uAA29-\uAA36\uAA43\uAA4C-\uAA4D\uAA7B-\uAA7D\uAAB0'
                    '\uAAB2-\uAAB4\uAAB7-\uAAB8\uAABE-\uAABF\uAAC1\uAAEB-\uAAEF\uAAF5-\uAAF6\uABE3-\uABEA'
                    '\uABEC-\uABED\uFB1E\uFE00-\uFE0F\uFE20-\uFE2F\U000101FD\U000102E0\U00010376-\U0001037A'
                    '\U00010A01-\U00010A03\U00010A05-\U00010A06\U00010A0C-\U00010A0F\U00010A38-\U00010A3A'
                    '\U00010A3F\U00010AE5-\U00010AE6\U00010D24-\U00010D27\U00010D69-\U00010D6D'
                    '\U00010EAB-\U00010EAC\U00010EFA-\U00010EFF\U00010F46-\U00010F50\U00010F82-\U00010F85'
                    '\U00011000-\U00011002\U00011038-\U00011046\U00011070\U00011073-\U00011074'
                    '\U0001107F-\U00011082\U000110B0-\U000110BA\U000110C2\U00011100-\U00011102'
                    '\U00011127-\U00011134\U00011145-\U00011146\U00011173\U00011180-\U00011182'
                    '\U000111B3-\U000111C0\U000111C9-\U000111CC\U000111CE-\U000111CF\U0001122C-\U00011237'
                    '\U0001123E\U00011241\U000112DF-\U000112EA\U00011300-\U00011303\U0001133B-\U0001133C'
                    '\U0001133E-\U00011344\U00011347-\U00011348\U0001134B-\U0001134D\U00011357'
                    '\U00011362-\U00011363\U00011366-\U0001136C\U00011370-\U00011374\U000113B8-\U000113C0'
                    '\U000113C2\U000113C5\U000113C7-\U000113CA\U000113CC-\U000113D0\U000113D2'
                    '\U000113E1-\U000113E2\U00011435-\U00011446\U0001145E\U000114B0-\U000114C3'
                    '\U000115AF-\U000115B5\U000115B8-\U000115C0\U000115DC-\U000115DD\U00011630-\U00011640'
                    '\U000116AB-\U000116B7\U0001171D-\U0001172B\U0001182C-\U0001183A\U00011930-\U00011935'
                    '\U00011937-\U00011938\U0001193B-\U0001193E\U00011940\U00011942-\U00011943'
                    '\U000119D1-\U000119D7\U000119DA-\U000119E0\U000119E4\U00011A01-\U00011A0A'
                    '\U00011A33-\U00011A39\U00011A3B-\U00011A3E\U00011A47\U00011A51-\U00011A5B'
                    '\U00011A8A-\U00011A99\U00011B60-\U00011B67\U00011C2F-\U00011C36\U00011C38-\U00011C3F'
                    '\U00011C92-\U00011CA7\U00011CA9-\U00011CB6\U00011D31-\U00011D36\U00011D3A'
                    '\U00011D3C-\U00011D3D\U00011D3F-\U00011D45\U00011D47\U00011D8A-\U00011D8E'
                    '\U00011D90-\U00011D91\U00011D93-\U00011D97\U00011EF3-\U00011EF6\U00011F00-\U00011F01'
                    '\U00011F03\U00011F34-\U00011F3A\U00011F3E-\U00011F42\U00011F5A\U00013440'
                    '\U00013447-\U00013455\U0001611E-\U0001612F\U00016AF0-\U00016AF4\U00016B30-\U00016B36'
                    '\U00016F4F\U00016F51-\U00016F87\U00016F8F-\U00016F92\U00016FE4\U00016FF0-\U00016FF1'
                    '\U0001BC9D-\U0001BC9E\U0001CF00-\U0001CF2D\U0001CF30-\U0001CF46\U0001D165-\U0001D169'
                    '\U0001D16D-\U0001D172\U0001D17B-\U0001D182\U0001D185-\U0001D18B\U0001D1AA-\U0001D1AD'
                    '\U0001D242-\U0001D244\U0001DA00-\U0001DA36\U0001DA3B-\U0001DA6C\U0001DA75\U0001DA84'
                    '\U0001DA9B-\U0001DA9F\U0001DAA1-\U0001DAAF\U0001E000-\U0001E006\U0001E008-\U0001E018'
                    '\U0001E01B-\U0001E021\U0001E023-\U0001E024\U0001E026-\U0001E02A\U0001E08F'
                    '\U0001E130-\U0001E136\U0001E2AE\U0001E2EC-\U0001E2EF\U0001E4EC-\U0001E4EF'
                    '\U0001E5EE-\U0001E5EF\U0001E6E3\U0001E6E6\U0001E6EE-\U0001E6EF\U0001E6F5'
                    '\U0001E8D0-\U0001E8D6\U0001E944-\U0001E94A\U000E0100-\U000E01EF]{31}')
      then 'too_many_marks'
    when not (p_title is nfc normalized)
      or pg_catalog.strpos(p_title, E'\n') > 0
      or pg_catalog.strpos(p_title, '  ') > 0
      or p_title like ' %' or p_title like '% '
      then 'not_normal_form'
  end
$$;

create function public._org_policy_body_problem(p_body text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_body is null or p_body = '' then 'empty'
    when pg_catalog.char_length(p_body) > 30000 then 'too_long'
    when pg_catalog.char_length(p_body) - pg_catalog.char_length(pg_catalog.replace(p_body, E'\n', '')) + 1 > 600
      then 'too_many_lines'
    when p_body ~ '[\u0001-\u0009\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFF\U000E0000-\U000E007F\U000E0100-\U000E01EF]'
      then 'forbidden_character'
    when p_body ~ ('[\u0300-\u036F\u0483-\u0489\u0591-\u05BD\u05BF\u05C1-\u05C2\u05C4-\u05C5\u05C7'
                   '\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7-\u06E8\u06EA-\u06ED'
                   '\u0711\u0730-\u074A\u07A6-\u07B0\u07EB-\u07F3\u07FD\u0816-\u0819\u081B-\u0823'
                   '\u0825-\u0827\u0829-\u082D\u0859-\u085B\u0897-\u089F\u08CA-\u08E1\u08E3-\u0903'
                   '\u093A-\u093C\u093E-\u094F\u0951-\u0957\u0962-\u0963\u0981-\u0983\u09BC\u09BE-\u09C4'
                   '\u09C7-\u09C8\u09CB-\u09CD\u09D7\u09E2-\u09E3\u09FE\u0A01-\u0A03\u0A3C\u0A3E-\u0A42'
                   '\u0A47-\u0A48\u0A4B-\u0A4D\u0A51\u0A70-\u0A71\u0A75\u0A81-\u0A83\u0ABC\u0ABE-\u0AC5'
                   '\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AE2-\u0AE3\u0AFA-\u0AFF\u0B01-\u0B03\u0B3C\u0B3E-\u0B44'
                   '\u0B47-\u0B48\u0B4B-\u0B4D\u0B55-\u0B57\u0B62-\u0B63\u0B82\u0BBE-\u0BC2\u0BC6-\u0BC8'
                   '\u0BCA-\u0BCD\u0BD7\u0C00-\u0C04\u0C3C\u0C3E-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D'
                   '\u0C55-\u0C56\u0C62-\u0C63\u0C81-\u0C83\u0CBC\u0CBE-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD'
                   '\u0CD5-\u0CD6\u0CE2-\u0CE3\u0CF3\u0D00-\u0D03\u0D3B-\u0D3C\u0D3E-\u0D44\u0D46-\u0D48'
                   '\u0D4A-\u0D4D\u0D57\u0D62-\u0D63\u0D81-\u0D83\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF'
                   '\u0DF2-\u0DF3\u0E31\u0E34-\u0E3A\u0E47-\u0E4E\u0EB1\u0EB4-\u0EBC\u0EC8-\u0ECE'
                   '\u0F18-\u0F19\u0F35\u0F37\u0F39\u0F3E-\u0F3F\u0F71-\u0F84\u0F86-\u0F87\u0F8D-\u0F97'
                   '\u0F99-\u0FBC\u0FC6\u102B-\u103E\u1056-\u1059\u105E-\u1060\u1062-\u1064\u1067-\u106D'
                   '\u1071-\u1074\u1082-\u108D\u108F\u109A-\u109D\u135D-\u135F\u1712-\u1715\u1732-\u1734'
                   '\u1752-\u1753\u1772-\u1773\u17B4-\u17D3\u17DD\u180B-\u180D\u180F\u1885-\u1886\u18A9'
                   '\u1920-\u192B\u1930-\u193B\u1A17-\u1A1B\u1A55-\u1A5E\u1A60-\u1A7C\u1A7F\u1AB0-\u1ADD'
                   '\u1AE0-\u1AEB\u1B00-\u1B04\u1B34-\u1B44\u1B6B-\u1B73\u1B80-\u1B82\u1BA1-\u1BAD'
                   '\u1BE6-\u1BF3\u1C24-\u1C37\u1CD0-\u1CD2\u1CD4-\u1CE8\u1CED\u1CF4\u1CF7-\u1CF9'
                   '\u1DC0-\u1DFF\u20D0-\u20F0\u2CEF-\u2CF1\u2D7F\u2DE0-\u2DFF\u302A-\u302F\u3099-\u309A'
                   '\uA66F-\uA672\uA674-\uA67D\uA69E-\uA69F\uA6F0-\uA6F1\uA802\uA806\uA80B\uA823-\uA827'
                   '\uA82C\uA880-\uA881\uA8B4-\uA8C5\uA8E0-\uA8F1\uA8FF\uA926-\uA92D\uA947-\uA953'
                   '\uA980-\uA983\uA9B3-\uA9C0\uA9E5\uAA29-\uAA36\uAA43\uAA4C-\uAA4D\uAA7B-\uAA7D\uAAB0'
                   '\uAAB2-\uAAB4\uAAB7-\uAAB8\uAABE-\uAABF\uAAC1\uAAEB-\uAAEF\uAAF5-\uAAF6\uABE3-\uABEA'
                   '\uABEC-\uABED\uFB1E\uFE00-\uFE0F\uFE20-\uFE2F\U000101FD\U000102E0\U00010376-\U0001037A'
                   '\U00010A01-\U00010A03\U00010A05-\U00010A06\U00010A0C-\U00010A0F\U00010A38-\U00010A3A'
                   '\U00010A3F\U00010AE5-\U00010AE6\U00010D24-\U00010D27\U00010D69-\U00010D6D'
                   '\U00010EAB-\U00010EAC\U00010EFA-\U00010EFF\U00010F46-\U00010F50\U00010F82-\U00010F85'
                   '\U00011000-\U00011002\U00011038-\U00011046\U00011070\U00011073-\U00011074'
                   '\U0001107F-\U00011082\U000110B0-\U000110BA\U000110C2\U00011100-\U00011102'
                   '\U00011127-\U00011134\U00011145-\U00011146\U00011173\U00011180-\U00011182'
                   '\U000111B3-\U000111C0\U000111C9-\U000111CC\U000111CE-\U000111CF\U0001122C-\U00011237'
                   '\U0001123E\U00011241\U000112DF-\U000112EA\U00011300-\U00011303\U0001133B-\U0001133C'
                   '\U0001133E-\U00011344\U00011347-\U00011348\U0001134B-\U0001134D\U00011357'
                   '\U00011362-\U00011363\U00011366-\U0001136C\U00011370-\U00011374\U000113B8-\U000113C0'
                   '\U000113C2\U000113C5\U000113C7-\U000113CA\U000113CC-\U000113D0\U000113D2'
                   '\U000113E1-\U000113E2\U00011435-\U00011446\U0001145E\U000114B0-\U000114C3'
                   '\U000115AF-\U000115B5\U000115B8-\U000115C0\U000115DC-\U000115DD\U00011630-\U00011640'
                   '\U000116AB-\U000116B7\U0001171D-\U0001172B\U0001182C-\U0001183A\U00011930-\U00011935'
                   '\U00011937-\U00011938\U0001193B-\U0001193E\U00011940\U00011942-\U00011943'
                   '\U000119D1-\U000119D7\U000119DA-\U000119E0\U000119E4\U00011A01-\U00011A0A'
                   '\U00011A33-\U00011A39\U00011A3B-\U00011A3E\U00011A47\U00011A51-\U00011A5B'
                   '\U00011A8A-\U00011A99\U00011B60-\U00011B67\U00011C2F-\U00011C36\U00011C38-\U00011C3F'
                   '\U00011C92-\U00011CA7\U00011CA9-\U00011CB6\U00011D31-\U00011D36\U00011D3A'
                   '\U00011D3C-\U00011D3D\U00011D3F-\U00011D45\U00011D47\U00011D8A-\U00011D8E'
                   '\U00011D90-\U00011D91\U00011D93-\U00011D97\U00011EF3-\U00011EF6\U00011F00-\U00011F01'
                   '\U00011F03\U00011F34-\U00011F3A\U00011F3E-\U00011F42\U00011F5A\U00013440'
                   '\U00013447-\U00013455\U0001611E-\U0001612F\U00016AF0-\U00016AF4\U00016B30-\U00016B36'
                   '\U00016F4F\U00016F51-\U00016F87\U00016F8F-\U00016F92\U00016FE4\U00016FF0-\U00016FF1'
                   '\U0001BC9D-\U0001BC9E\U0001CF00-\U0001CF2D\U0001CF30-\U0001CF46\U0001D165-\U0001D169'
                   '\U0001D16D-\U0001D172\U0001D17B-\U0001D182\U0001D185-\U0001D18B\U0001D1AA-\U0001D1AD'
                   '\U0001D242-\U0001D244\U0001DA00-\U0001DA36\U0001DA3B-\U0001DA6C\U0001DA75\U0001DA84'
                   '\U0001DA9B-\U0001DA9F\U0001DAA1-\U0001DAAF\U0001E000-\U0001E006\U0001E008-\U0001E018'
                   '\U0001E01B-\U0001E021\U0001E023-\U0001E024\U0001E026-\U0001E02A\U0001E08F'
                   '\U0001E130-\U0001E136\U0001E2AE\U0001E2EC-\U0001E2EF\U0001E4EC-\U0001E4EF'
                   '\U0001E5EE-\U0001E5EF\U0001E6E3\U0001E6E6\U0001E6EE-\U0001E6EF\U0001E6F5'
                   '\U0001E8D0-\U0001E8D6\U0001E944-\U0001E94A\U000E0100-\U000E01EF]{31}')
      then 'too_many_marks'
    when not (p_body is nfc normalized)
      or pg_catalog.strpos(p_body, E' \n') > 0
      or p_body like '% '
      or pg_catalog.strpos(p_body, E'\n\n\n') > 0
      or pg_catalog.left(p_body, 1) = E'\n'
      or pg_catalog.right(p_body, 1) = E'\n'
      then 'not_normal_form'
  end
$$;

-- A person's name as a record keeps it: the profile's full name, trimmed, at
-- most 200 characters; none when it is empty or holds an '@' (so the record
-- never keeps an email address). Read by the SECURITY DEFINER writers only.
create function public._org_policy_person_name(p_user_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when pg_catalog.btrim(up.full_name) <> '' and pg_catalog.strpos(up.full_name, '@') = 0
      then pg_catalog.btrim(pg_catalog.left(pg_catalog.btrim(up.full_name), 200))
  end
    from public.user_profiles up
   where up.id = p_user_id
$$;

revoke all on function public._org_policy_title_problem(text) from public, anon, authenticated, service_role;
revoke all on function public._org_policy_body_problem(text) from public, anon, authenticated, service_role;
revoke all on function public._org_policy_person_name(uuid) from public, anon, authenticated, service_role;

comment on function public._org_policy_title_problem(text) is
  'Why a policy title would be refused (0482): empty, too_long (over 120 characters), forbidden_character, too_many_marks (more than 30 combining marks of Unicode 17.0 in a row), not_normal_form (not NFC, a line feed, two spaces in a row, a space at either end), or null. The rule of packages/core policyTitleProblem. Used by the checks of org_policies and org_policy_versions. No API role may execute it.';
comment on function public._org_policy_body_problem(text) is
  'Why a policy body would be refused (0482): empty, too_long (over 30,000 characters), too_many_lines (over 600 lines), forbidden_character, too_many_marks (more than 30 combining marks of Unicode 17.0 in a row), not_normal_form (not NFC, a space at a line''s end, three line feeds in a row, a line feed at either end), or null. The rule of packages/core policyBodyProblem. Used by the check of org_policy_versions. No API role may execute it.';
comment on function public._org_policy_person_name(uuid) is
  'The name a policy record keeps for an account (0482): its full name, trimmed, at most 200 characters, or null when the name is empty or holds an ''@'' (never an email). No API role may execute it.';

-- Is the caller in this organization on a support (act-as) seat (0413's
-- reading: a membership with impersonation_expires_at set; 0481's
-- _supplier_risk_caller_is_act_as, the same body). Such a seat reads the
-- policies and never writes them.
create function public._org_policy_caller_is_act_as(p_organization_id uuid)
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

revoke all on function public._org_policy_caller_is_act_as(uuid) from public, anon, authenticated, service_role;

comment on function public._org_policy_caller_is_act_as(uuid) is
  'Private (0482). Is the caller (auth.uid()) on an act-as seat in the organization: its membership has impersonation_expires_at set. The five admin writes refuse such a caller (42501 policy_act_as_read_only). SECURITY INVOKER: its callers run as their owner. No API role may execute it.';

-- ── 1. The policies ──────────────────────────────────────────────────────────
create table public.org_policies (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null references public.organizations(id) on delete cascade,
  kind                text        not null,
  -- The current version's title; the draft's while it was never published.
  title               text        not null,
  status              text        not null default 'draft',
  current_version     integer,
  first_published_at  timestamptz,
  retired_at          timestamptz,
  last_remind_now_at  timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- For the versions' key to name the organization with the policy.
  constraint org_policies_id_organization_key unique (id, organization_id),
  constraint org_policies_kind
    check (kind in ('acceptable_use', 'data_handling', 'other')),
  constraint org_policies_title
    check (public._org_policy_title_problem(title) is null),
  constraint org_policies_status
    check (status in ('draft', 'published', 'retired')),
  -- A draft has no version; a published or retired policy has one.
  constraint org_policies_current_version
    check ((status = 'draft') = (current_version is null) and (current_version is null or current_version >= 1)),
  constraint org_policies_first_published
    check ((status = 'draft') = (first_published_at is null)),
  constraint org_policies_retired
    check ((status = 'retired') = (retired_at is not null)),
  constraint org_policies_remind_now
    check (last_remind_now_at is null or status <> 'draft')
);

create index org_policies_organization_idx on public.org_policies (organization_id, status);

comment on table public.org_policies is
  'A written policy of an organization (0482): kind (acceptable_use, data_handling, other), the current version''s title, state (draft: never published; published; retired) and the number of its current version. Written by the org_policy_* functions only; a published or retired policy is never deleted (it goes only with its organization), and a retired one never changes.';

-- ── 2. The versions ──────────────────────────────────────────────────────────
create table public.org_policy_versions (
  id                     uuid        primary key default gen_random_uuid(),
  organization_id        uuid        not null,
  policy_id              uuid        not null,
  -- The policy's kind with these words: the draft's until it is published
  -- (publishing makes it the policy's), frozen with the version after.
  kind                   text        not null,
  title                  text        not null,
  body                   text        not null,
  text_hash              text        not null,
  -- Set together when the draft is published; never changed after.
  version_number         integer,
  needs_acknowledgement  boolean,
  acknowledgement_round  integer,
  published_at           timestamptz,
  published_by           uuid        references public.user_profiles(id) on delete set null,
  published_by_name      text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint org_policy_versions_policy_fkey foreign key (policy_id, organization_id)
    references public.org_policies (id, organization_id) on delete cascade,
  -- For the acknowledgements' and reminders' key.
  constraint org_policy_versions_key unique (id, policy_id, organization_id),
  constraint org_policy_versions_number_key unique (policy_id, version_number),
  constraint org_policy_versions_kind
    check (kind in ('acceptable_use', 'data_handling', 'other')),
  constraint org_policy_versions_title
    check (public._org_policy_title_problem(title) is null),
  constraint org_policy_versions_body
    check (public._org_policy_body_problem(body) is null),
  -- The hash is of the stored words: the title, two line feeds, the body.
  constraint org_policy_versions_text_hash
    check (text_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(title || E'\n\n' || body, 'UTF8')), 'hex')),
  constraint org_policy_versions_published
    check ((published_at is null) = (version_number is null)
           and (published_at is null) = (needs_acknowledgement is null)
           and (published_at is null) = (acknowledgement_round is null)),
  constraint org_policy_versions_number
    check (version_number is null or version_number >= 1),
  -- A version that asks opens its own round; a correction stays in an earlier
  -- one. Version 1 always asks.
  constraint org_policy_versions_round
    check (version_number is null
           or (needs_acknowledgement and acknowledgement_round = version_number)
           or (not needs_acknowledgement and acknowledgement_round between 1 and version_number - 1)),
  -- A draft names no publisher. A version is published with its publisher
  -- (org_policy_versions_guard), whose column is empty only after that
  -- account's deletion (and then the name is kept, or the label for an
  -- account that had none).
  constraint org_policy_versions_publisher
    check (published_at is not null or (published_by is null and published_by_name is null)),
  constraint org_policy_versions_publisher_name
    check (published_by_name is null
           or (pg_catalog.char_length(published_by_name) between 1 and 200
               and pg_catalog.strpos(published_by_name, '@') = 0
               and published_by_name = pg_catalog.btrim(published_by_name)))
);

-- At most one draft per policy.
create unique index org_policy_versions_one_draft
  on public.org_policy_versions (policy_id)
  where published_at is null;
-- The account deletion's SET NULL finds the publisher's versions.
create index org_policy_versions_published_by_idx
  on public.org_policy_versions (published_by)
  where published_by is not null;

comment on table public.org_policy_versions is
  'The words of a policy (0482). A row with no version number is the policy''s draft (at most one), changed by saving the draft. Publishing gives it the next number, needs_acknowledgement (true: a new version that asks every member again; false: a correction that asks nobody again), acknowledgement_round (the number of the version that asked), published_at, published_by and published_by_name (never an email); from then on the row is never changed and never deleted (trigger org_policy_versions_guard), except that deleting the publisher''s account empties published_by (the only way it is ever empty; published_by_name keeps who it was, or ''Former member, no name on the account'' when the account had no name). kind is the policy''s kind with these words; a correction keeps the corrected version''s title and kind. A version is inserted only as a draft. text_hash is SHA-256 (hex) of title, two line feeds and body, held to the words by a check. Title and body are in the normal form of packages/core src/policies/policy-text.ts.';
comment on column public.org_policy_versions.text_hash is
  'SHA-256, 64 lower-case hex digits, of the UTF-8 bytes of title || E''\n\n'' || body (both in normal form): packages/core policyTextHash. Held to the stored words by org_policy_versions_text_hash.';

-- ── 3. The acknowledgements (append only) ────────────────────────────────────
create table public.org_policy_acknowledgements (
  id                     uuid        primary key default gen_random_uuid(),
  organization_id        uuid        not null,
  policy_id              uuid        not null,
  version_id             uuid        not null,
  -- The version's number, round and hash as they were (a check of the
  -- insert holds them to the version).
  version_number         integer     not null,
  acknowledgement_round  integer     not null,
  text_hash              text        not null,
  user_id                uuid        references public.user_profiles(id) on delete set null,
  user_name              text,
  -- When the membership began (organization_members.accepted_at), as it was.
  member_since           timestamptz not null,
  method                 text        not null,
  acknowledged_at        timestamptz not null default now(),
  constraint org_policy_acknowledgements_version_fkey foreign key (version_id, policy_id, organization_id)
    references public.org_policy_versions (id, policy_id, organization_id) on delete cascade,
  -- One row per member and version: a repeat writes nothing.
  constraint org_policy_acknowledgements_once unique (version_id, user_id),
  constraint org_policy_acknowledgements_name
    check (user_name is null
           or (pg_catalog.char_length(user_name) between 1 and 200
               and pg_catalog.strpos(user_name, '@') = 0
               and user_name = pg_catalog.btrim(user_name))),
  constraint org_policy_acknowledgements_text_hash
    check (text_hash ~ '^[0-9a-f]{64}$'),
  constraint org_policy_acknowledgements_method
    check (method in ('web', 'phone')),
  constraint org_policy_acknowledgements_numbers
    check (version_number >= 1 and acknowledgement_round between 1 and version_number)
);

-- Who acknowledged a policy's round (every read and the claim).
create index org_policy_acknowledgements_round_idx
  on public.org_policy_acknowledgements (policy_id, acknowledgement_round, user_id);
-- A member's own records; the account deletion's SET NULL.
create index org_policy_acknowledgements_user_idx
  on public.org_policy_acknowledgements (user_id)
  where user_id is not null;

comment on table public.org_policy_acknowledgements is
  'Evidence that a member pressed "I have read and agree" for a policy version while signed in as themselves (0482): the version, its number, round and text hash as they were, the account and its name as it was (never an email), when, and web or phone. APPEND ONLY: written by org_policy_acknowledge only, for the caller''s own account; never changed or deleted (trigger org_policy_acknowledgements_guard; no API role has a write privilege), except that deleting the account empties user_id (the only way it is ever empty; user_name keeps who it was, or ''Former member, no name on the account'' when the account had no name, a row that proves less: it says only when that member joined, member_since), and deleting the organization removes its records. TRUNCATE is refused. Never purged by a job.';

-- ── 4. The reminders ─────────────────────────────────────────────────────────
create table public.org_policy_reminders (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   uuid        not null,
  policy_id         uuid        not null,
  -- The version that asked (the round): a correction keeps the count, a new
  -- version starts a new one.
  round_version_id  uuid        not null,
  user_id           uuid        not null references public.user_profiles(id) on delete cascade,
  sent_count        integer     not null default 0,
  last_sent_at      timestamptz,
  manual_count      integer     not null default 0,
  last_reminded_at  timestamptz,
  -- The last correction (its version number) this member, who acknowledged
  -- an earlier text of the round, was told of; stamped first by
  -- org_policy_correction_notices_claim.
  correction_notice_number  integer,
  correction_noticed_at     timestamptz,
  constraint org_policy_reminders_version_fkey foreign key (round_version_id, policy_id, organization_id)
    references public.org_policy_versions (id, policy_id, organization_id) on delete cascade,
  constraint org_policy_reminders_once unique (round_version_id, user_id),
  constraint org_policy_reminders_sent
    check (sent_count between 0 and 6 and (sent_count = 0) = (last_sent_at is null)),
  constraint org_policy_reminders_manual
    check (manual_count >= 0),
  constraint org_policy_reminders_correction_notice
    check ((correction_notice_number is null) = (correction_noticed_at is null)
           and (correction_notice_number is null or correction_notice_number >= 2)),
  constraint org_policy_reminders_last
    check ((last_reminded_at is null) = (sent_count = 0 and manual_count = 0)
           and (last_sent_at is null or last_reminded_at >= last_sent_at))
);

-- The account deletion's cascade.
create index org_policy_reminders_user_idx on public.org_policy_reminders (user_id);

comment on table public.org_policy_reminders is
  'Reminders of a policy (0482), one row per asking version (round) and member: sent_count automatic reminders (at most 6) and the last one, manual_count "Remind now" reminders, and last_reminded_at (either kind); correction_notice_number and correction_noticed_at, the last correction a member who acknowledged an earlier text of the round was told of. Stamped before anything is sent (org_policy_reminders_claim, org_policy_remind_now, org_policy_correction_notices_claim): a failed send loses a reminder or a notice, it never repeats one. Goes with the account.';

-- ── Row security and privileges ──────────────────────────────────────────────
-- RLS on and no policy: no API role but service_role (which bypasses row
-- security) reads a row directly, and service_role only reads. Supabase's
-- default privileges give anon, authenticated and service_role every
-- privilege on a new public table; the change of 2026-10-30 (0402's note)
-- takes SELECT, INSERT, UPDATE and DELETE out of them. Everything is revoked
-- from all of them here, then service_role gets SELECT back by name, so every
-- table ends the same under either set of defaults.
alter table public.org_policies enable row level security;
alter table public.org_policy_versions enable row level security;
alter table public.org_policy_acknowledgements enable row level security;
alter table public.org_policy_reminders enable row level security;

revoke all on table public.org_policies from public, anon, authenticated, service_role;
grant select on table public.org_policies to service_role;
revoke all on table public.org_policy_versions from public, anon, authenticated, service_role;
grant select on table public.org_policy_versions to service_role;
revoke all on table public.org_policy_acknowledgements from public, anon, authenticated, service_role;
grant select on table public.org_policy_acknowledgements to service_role;
revoke all on table public.org_policy_reminders from public, anon, authenticated, service_role;
grant select on table public.org_policy_reminders to service_role;

-- ── The guards (triggers on the new tables only) ─────────────────────────────
-- SECURITY INVOKER: no API role can write these tables, so they run for the
-- functions below (as their owner), for a foreign key action (as the table's
-- owner) and for a direct write by the owner. Each refuses what the evidence
-- must never allow, whoever writes.

-- A policy: a draft (never published) may be deleted; a published or retired
-- one goes only with its organization. Its id, organization and creation time
-- never change; its state only moves forward (draft, published, retired);
-- its version number never goes back; a retired policy never changes.
create function public._org_policies_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'draft'
       or not exists (select 1 from public.organizations o where o.id = old.organization_id) then
      return old;
    end if;
    raise exception 'org_policy_kept'
      using errcode = '55000', hint = 'org_policy_kept',
            detail = 'A published policy is retired, never deleted; it goes only with its organization.';
  end if;

  if new.id is distinct from old.id
     or new.organization_id is distinct from old.organization_id
     or new.created_at is distinct from old.created_at
     or (old.status = 'retired' and pg_catalog.to_jsonb(new) <> pg_catalog.to_jsonb(old))
     or (old.status = 'published' and new.status not in ('published', 'retired'))
     or (old.current_version is not null and new.current_version < old.current_version)
     or (old.first_published_at is not null and new.first_published_at is distinct from old.first_published_at) then
    raise exception 'org_policy_changed_wrongly'
      using errcode = '55000', hint = 'org_policy_changed_wrongly';
  end if;
  return new;
end;
$$;

-- A version: it is inserted as a draft; a draft may change its words and be
-- published, with its publisher; a published version never changes, but for
-- one thing: deleting the publisher's account empties published_by (the
-- key's SET NULL; the name is kept, or the label when there was none). A draft may be deleted; a published version goes only
-- with its policy, which goes only with its organization.
create function public._org_policy_versions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.published_at is not null then
      raise exception 'org_policy_changed_wrongly'
        using errcode = '55000', hint = 'org_policy_changed_wrongly',
              detail = 'A version is inserted as a draft and published from it.';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.published_at is null
       or not exists (select 1 from public.org_policies p where p.id = old.policy_id) then
      return old;
    end if;
    raise exception 'org_policy_version_kept'
      using errcode = '55000', hint = 'org_policy_version_kept',
            detail = 'A published version is never deleted; it goes only with its organization.';
  end if;

  if old.published_at is not null then
    if old.published_by is not null and new.published_by is null
       and (pg_catalog.to_jsonb(new) - 'published_by') = (pg_catalog.to_jsonb(old) - 'published_by')
       and not exists (select 1 from public.user_profiles up where up.id = old.published_by) then
      -- The kept name, or the label for an account that had none, so the
      -- version never names nobody.
      new.published_by_name := coalesce(old.published_by_name, 'Former member, no name on the account');
      return new;
    end if;
    raise exception 'org_policy_version_frozen'
      using errcode = '55000', hint = 'org_policy_version_frozen',
            detail = 'A published version is never changed; publish a correction or a new version.';
  end if;

  if new.id is distinct from old.id
     or new.policy_id is distinct from old.policy_id
     or new.organization_id is distinct from old.organization_id
     or new.created_at is distinct from old.created_at
     or (new.published_at is not null and new.published_by is null) then
    raise exception 'org_policy_changed_wrongly'
      using errcode = '55000', hint = 'org_policy_changed_wrongly';
  end if;
  return new;
end;
$$;

-- An acknowledgement: inserted only for a published version, with that
-- version's number, round and hash, naming an account;
-- never changed but for an account deletion's SET NULL of user_id (the name
-- is kept, or the label when there was none); deleted only with its version
-- (so only with its organization).
create function public._org_policy_acknowledgements_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.user_id is null
       or not exists (select 1 from public.org_policy_versions v
                       where v.id = new.version_id
                         and v.published_at is not null
                         and v.version_number = new.version_number
                         and v.acknowledgement_round = new.acknowledgement_round
                         and v.text_hash = new.text_hash) then
      raise exception 'org_policy_acknowledgement_append_only'
        using errcode = '55000', hint = 'org_policy_acknowledgement_append_only',
              detail = 'An acknowledgement names an account and the number, round and hash of a published version.';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if not exists (select 1 from public.org_policy_versions v where v.id = old.version_id) then
      return old;
    end if;
    raise exception 'org_policy_acknowledgement_append_only'
      using errcode = '55000', hint = 'org_policy_acknowledgement_append_only',
            detail = 'An acknowledgement is never deleted; it goes only with its organization.';
  end if;

  if old.user_id is not null and new.user_id is null
     and (pg_catalog.to_jsonb(new) - 'user_id') = (pg_catalog.to_jsonb(old) - 'user_id')
     and not exists (select 1 from public.user_profiles up where up.id = old.user_id) then
    -- The kept name, or the label for an account that had none (with
    -- member_since, the row then says only when that member joined).
    new.user_name := coalesce(old.user_name, 'Former member, no name on the account');
    return new;
  end if;
  raise exception 'org_policy_acknowledgement_append_only'
    using errcode = '55000', hint = 'org_policy_acknowledgement_append_only',
          detail = 'An acknowledgement is never changed.';
end;
$$;

create function public._org_policy_refuse_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'org_policy_truncate_refused'
    using errcode = '55000', hint = 'org_policy_truncate_refused',
          detail = 'Policies, their versions and their acknowledgements are evidence: they are never truncated.';
end;
$$;

revoke all on function public._org_policies_guard() from public, anon, authenticated, service_role;
revoke all on function public._org_policy_versions_guard() from public, anon, authenticated, service_role;
revoke all on function public._org_policy_acknowledgements_guard() from public, anon, authenticated, service_role;
revoke all on function public._org_policy_refuse_truncate() from public, anon, authenticated, service_role;

create trigger org_policies_guard
  before update or delete on public.org_policies
  for each row execute function public._org_policies_guard();
create trigger org_policies_no_truncate
  before truncate on public.org_policies
  for each statement execute function public._org_policy_refuse_truncate();

create trigger org_policy_versions_guard
  before insert or update or delete on public.org_policy_versions
  for each row execute function public._org_policy_versions_guard();
create trigger org_policy_versions_no_truncate
  before truncate on public.org_policy_versions
  for each statement execute function public._org_policy_refuse_truncate();

create trigger org_policy_acknowledgements_guard
  before insert or update or delete on public.org_policy_acknowledgements
  for each row execute function public._org_policy_acknowledgements_guard();
create trigger org_policy_acknowledgements_no_truncate
  before truncate on public.org_policy_acknowledgements
  for each statement execute function public._org_policy_refuse_truncate();

comment on function public._org_policies_guard() is
  'org_policies_guard (0482): a draft policy may be deleted, a published or retired one only with its organization; id, organization and creation time never change; the state only moves forward, the version number never goes back, a retired policy never changes. 55000 org_policy_kept or org_policy_changed_wrongly.';
comment on function public._org_policy_versions_guard() is
  'org_policy_versions_guard (0482): a version is inserted as a draft (55000 org_policy_changed_wrongly otherwise); a draft may change and be published with its publisher, or deleted; a published version never changes (55000 org_policy_version_frozen) except that an account deletion empties published_by (keeping the name, or the label for an account with none), and is deleted only with its policy (55000 org_policy_version_kept).';
comment on function public._org_policy_acknowledgements_guard() is
  'org_policy_acknowledgements_guard (0482): an acknowledgement is inserted only for a published version with its number, round and hash and an account; it is never changed except that an account deletion empties user_id (keeping the name, or the label for an account with none), and deleted only with its version. 55000 org_policy_acknowledgement_append_only.';
comment on function public._org_policy_refuse_truncate() is
  'Refuses TRUNCATE of org_policies, org_policy_versions and org_policy_acknowledgements (0482): 55000 org_policy_truncate_refused.';

-- ── What a member reads ──────────────────────────────────────────────────────
-- The published policies of an organization the caller is a member of, and
-- the retired ones the caller acknowledged, each with its current version
-- and the caller's own acknowledgements. owed: published, the caller is a
-- current member (0422's rule) and has no acknowledgement in the current
-- version's round. Owed first, then by title.
create function public.org_policies_for_member(p_organization_id uuid)
returns table (
  policy_id                    uuid,
  kind                         text,
  status                       text,
  title                        text,
  version_id                   uuid,
  version_number               integer,
  needs_acknowledgement        boolean,
  published_at                 timestamptz,
  round_published_at           timestamptz,
  text_hash                    text,
  acknowledged                 boolean,
  owed                         boolean,
  acknowledged_at              timestamptz,
  acknowledged_version_number  integer,
  acknowledged_method          text,
  corrected_since_acknowledged boolean,
  last_corrected_at            timestamptz,
  my_acknowledgements          jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_current boolean;
begin
  if v_uid is null or p_organization_id is null
     or not coalesce(public.is_org_member(p_organization_id), false) then
    raise exception 'policy_not_allowed' using errcode = '42501', hint = 'policy_not_allowed';
  end if;
  v_current := coalesce(public._notify_is_current_member(p_organization_id, v_uid), false);

  return query
    with mine as (
      select a.policy_id as m_policy, a.version_number as m_number, a.acknowledgement_round as m_round,
             a.method as m_method, a.acknowledged_at as m_at
        from public.org_policy_acknowledgements a
       where a.organization_id = p_organization_id and a.user_id = v_uid
    ),
    listed as (
      select p.id as r_policy, p.kind as r_kind, p.status as r_status, cv.title as r_title, cv.id as r_version,
             cv.version_number as r_number, cv.needs_acknowledgement as r_needs, cv.published_at as r_published,
             rv.published_at as r_round_published, cv.text_hash as r_hash,
             last_ack.m_at as r_ack_at, last_ack.m_number as r_ack_number, last_ack.m_method as r_ack_method,
             case when not cv.needs_acknowledgement then cv.published_at end as r_corrected_at,
             coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                                'version_number', x.m_number, 'acknowledged_at', x.m_at, 'method', x.m_method)
                              order by x.m_at, x.m_number)
                         from mine x where x.m_policy = p.id), '[]'::jsonb) as r_mine
        from public.org_policies p
        join public.org_policy_versions cv on cv.policy_id = p.id and cv.version_number = p.current_version
        join public.org_policy_versions rv on rv.policy_id = p.id and rv.version_number = cv.acknowledgement_round
        left join lateral (
          select x.m_at, x.m_number, x.m_method
            from mine x
           where x.m_policy = p.id and x.m_round = cv.acknowledgement_round
           order by x.m_at desc, x.m_number desc
           limit 1) last_ack on true
       where p.organization_id = p_organization_id
         and (p.status = 'published'
              or (p.status = 'retired' and exists (select 1 from mine x where x.m_policy = p.id)))
    )
    select r.r_policy, r.r_kind, r.r_status, r.r_title, r.r_version, r.r_number, r.r_needs, r.r_published,
           r.r_round_published, r.r_hash,
           r.r_ack_at is not null,
           (r.r_status = 'published' and v_current and r.r_ack_at is null),
           r.r_ack_at, r.r_ack_number, r.r_ack_method,
           coalesce(r.r_ack_number < r.r_number, false), r.r_corrected_at, r.r_mine
      from listed r
     order by (r.r_status = 'published' and v_current and r.r_ack_at is null) desc,
              r.r_status, r.r_title, r.r_policy;
end;
$$;

revoke all on function public.org_policies_for_member(uuid) from public, anon, authenticated, service_role;
grant execute on function public.org_policies_for_member(uuid) to authenticated;

comment on function public.org_policies_for_member(uuid) is
  'For a member of the organization (is_org_member): its published policies, and the retired ones the caller acknowledged, each with its current version (id, number, title, text_hash, needs_acknowledgement, published_at, round_published_at), acknowledged (the caller has an acknowledgement in the current version''s round), owed (published, the caller is a current member by _notify_is_current_member and has not acknowledged), the caller''s latest acknowledgement in the round, corrected_since_acknowledged (that acknowledgement is of an earlier text of the round: the current version is a correction of it, which asks nothing), last_corrected_at (the current version''s publish time when it is a correction, else null) and my_acknowledgements (every one of the policy: version_number, acknowledged_at, method). Owed first, then by title. 42501 policy_not_allowed for anyone else. Never returns a draft.';

-- One version's words. A member reads the current version of a published
-- policy, any version they acknowledged, and the last version of a retired
-- policy they acknowledged; an owner or admin reads every published version
-- (a read only an admin may make asks for the authenticator rule).
-- p_version_number null: the current version; for a member and a retired
-- policy, the latest version they acknowledged (what they agreed to).
create function public.org_policy_text(p_policy_id uuid, p_version_number integer default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_p        public.org_policies%rowtype;
  v_v        public.org_policy_versions%rowtype;
  v_cur      public.org_policy_versions%rowtype;
  v_admin    boolean;
  v_mine     jsonb;
  v_number   integer := p_version_number;
  v_acked    integer;
  v_round_ack integer;
  v_member_may boolean;
begin
  if v_uid is null or p_policy_id is null then
    raise exception 'policy_not_allowed' using errcode = '42501', hint = 'policy_not_allowed';
  end if;
  select * into v_p from public.org_policies p where p.id = p_policy_id;
  if not found or not coalesce(public.is_org_member(v_p.organization_id), false) then
    raise exception 'policy_not_allowed' using errcode = '42501', hint = 'policy_not_allowed';
  end if;
  v_admin := coalesce(public.has_org_role(v_p.organization_id, 'admin'), false);

  if v_p.status = 'draft' then
    if v_admin then
      raise exception 'policy_not_published' using errcode = 'P0001', hint = 'policy_not_published';
    end if;
    raise exception 'policy_not_allowed' using errcode = '42501', hint = 'policy_not_allowed';
  end if;

  -- The latest version the caller acknowledged, of any round.
  select max(a.version_number) into v_acked
    from public.org_policy_acknowledgements a
   where a.policy_id = v_p.id and a.user_id = v_uid;
  if v_number is null then
    v_number := case when v_p.status = 'retired' and v_acked is not null then v_acked
                     else v_p.current_version end;
  end if;

  select * into v_v from public.org_policy_versions v
   where v.policy_id = v_p.id
     and v.version_number = v_number
     and v.published_at is not null;
  if not found then
    if v_admin then
      raise exception 'policy_version_not_found' using errcode = 'P0001', hint = 'policy_version_not_found';
    end if;
    raise exception 'policy_not_allowed' using errcode = '42501', hint = 'policy_not_allowed';
  end if;

  select pg_catalog.jsonb_build_object('acknowledged_at', a.acknowledged_at, 'method', a.method)
    into v_mine
    from public.org_policy_acknowledgements a
   where a.version_id = v_v.id and a.user_id = v_uid;

  -- What a member may read: the current version of a published policy, a
  -- version they acknowledged, the last version of a retired policy they
  -- acknowledged. Anything else only an admin reads, with the authenticator
  -- rule.
  v_member_may := (v_v.version_number = v_p.current_version
                   and (v_p.status = 'published' or v_acked is not null))
                  or v_mine is not null;
  if not v_member_may then
    if not v_admin then
      raise exception 'policy_not_allowed' using errcode = '42501', hint = 'policy_not_allowed';
    end if;
    perform public.security_events_reader_check(v_p.organization_id);
  end if;

  select * into v_cur from public.org_policy_versions v
   where v.policy_id = v_p.id and v.version_number = v_p.current_version;
  select max(a.version_number) into v_round_ack
    from public.org_policy_acknowledgements a
   where a.policy_id = v_p.id and a.acknowledgement_round = v_cur.acknowledgement_round
     and a.user_id = v_uid;

  return pg_catalog.jsonb_build_object(
    'policy_id', v_p.id,
    'organization_id', v_p.organization_id,
    'kind', v_p.kind,
    'status', v_p.status,
    'current_version_number', v_p.current_version,
    'version_id', v_v.id,
    'version_number', v_v.version_number,
    'is_current', v_v.version_number = v_p.current_version,
    'needs_acknowledgement', v_v.needs_acknowledgement,
    'acknowledgement_round', v_v.acknowledgement_round,
    'title', v_v.title,
    'body', v_v.body,
    'text_hash', v_v.text_hash,
    'published_at', v_v.published_at,
    'my_acknowledgement', v_mine,
    'acknowledged_in_current_round', v_round_ack is not null,
    'acknowledged_version_number', v_round_ack,
    'corrected_since_acknowledged', coalesce(v_round_ack < v_cur.version_number, false),
    'last_corrected_at', case when not v_cur.needs_acknowledgement then v_cur.published_at end,
    'owed', v_p.status = 'published' and v_round_ack is null
            and coalesce(public._notify_is_current_member(v_p.organization_id, v_uid), false));
end;
$$;

revoke all on function public.org_policy_text(uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.org_policy_text(uuid, integer) to authenticated;

comment on function public.org_policy_text(uuid, integer) is
  'One published version of a policy (p_version_number null: the current one; for a member and a retired policy, the latest version the caller acknowledged): title, body, text_hash, version_number, is_current, needs_acknowledgement, acknowledgement_round, published_at, the policy''s kind, status and current_version_number, my_acknowledgement (acknowledged_at, method of the caller''s acknowledgement of this version, or null), acknowledged_in_current_round, acknowledged_version_number (the caller''s latest in the current round), corrected_since_acknowledged (the current version is a later correction of it), last_corrected_at and owed. A member reads the current version of a published policy, any version they acknowledged and the last version of a retired policy they acknowledged; an owner or admin reads every published version, a read no member may make under the authenticator rule (security_events_reader_check: 42501 mfa_required, aal2_required). P0001 policy_not_published for a draft policy and policy_version_not_found for a number that is not published (an admin). 42501 policy_not_allowed otherwise, also for a policy that does not exist. Never returns a draft or the publisher.';

-- ── The acknowledgement ──────────────────────────────────────────────────────
create function public.org_policy_acknowledge(p_version_id uuid, p_text_hash text, p_method text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_uid   uuid := auth.uid();
  v_v     public.org_policy_versions%rowtype;
  v_p     public.org_policies%rowtype;
  v_id    uuid;
  v_at    timestamptz;
  v_meth  text;
  v_since timestamptz;
  v_already boolean := false;
begin
  -- The gate, in this body (security_invariants INV-25 reads it here): the
  -- signed-in account, for itself only.
  if v_uid is null then
    raise exception 'policy_not_allowed' using errcode = '42501', hint = 'policy_not_allowed';
  end if;
  if p_method is null or p_method not in ('web', 'phone') then
    raise exception 'policy_method_invalid' using errcode = '22023', hint = 'policy_method_invalid';
  end if;
  if p_text_hash is null or p_text_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'policy_hash_invalid' using errcode = '22023', hint = 'policy_hash_invalid';
  end if;

  select * into v_v from public.org_policy_versions v where v.id = p_version_id;
  -- Not found and not a current member give the same answer, so another
  -- organization's ids reveal nothing.
  if not found or not coalesce(public._notify_is_current_member(v_v.organization_id, v_uid), false) then
    raise exception 'policy_not_allowed' using errcode = '42501', hint = 'policy_not_allowed';
  end if;
  -- 0474's account rule: an account with a verified authenticator
  -- acknowledges only from a session that holds the second step.
  if exists (select 1 from auth.mfa_factors f where f.user_id = v_uid and f.status = 'verified')
     and coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then
    raise exception 'aal2_required' using errcode = '42501', hint = 'aal2_required';
  end if;

  -- The policy row is held FOR SHARE until commit, so a publish (FOR UPDATE)
  -- cannot change the current version between this check and the insert.
  select * into v_p from public.org_policies p where p.id = v_v.policy_id for share;
  if v_p.status = 'retired' then
    raise exception 'policy_retired' using errcode = 'P0001', hint = 'policy_retired';
  end if;
  if v_p.status <> 'published' or v_v.published_at is null or v_v.version_number <> v_p.current_version then
    raise exception 'policy_version_not_current' using errcode = 'P0001', hint = 'policy_version_not_current';
  end if;
  if v_v.text_hash <> p_text_hash then
    raise exception 'policy_text_changed' using errcode = 'P0001', hint = 'policy_text_changed';
  end if;
  -- When the membership began, kept with the record (a current member's is set).
  select m.accepted_at into v_since
    from public.organization_members m
   where m.organization_id = v_v.organization_id and m.user_id = v_uid;

  insert into public.org_policy_acknowledgements
    (organization_id, policy_id, version_id, version_number, acknowledgement_round, text_hash,
     user_id, user_name, member_since, method)
  values
    (v_v.organization_id, v_v.policy_id, v_v.id, v_v.version_number, v_v.acknowledgement_round, v_v.text_hash,
     v_uid, public._org_policy_person_name(v_uid), v_since, p_method)
  on conflict on constraint org_policy_acknowledgements_once do nothing
  returning id, acknowledged_at, method into v_id, v_at, v_meth;

  if v_id is null then
    v_already := true;
    select a.id, a.acknowledged_at, a.method into v_id, v_at, v_meth
      from public.org_policy_acknowledgements a
     where a.version_id = v_v.id and a.user_id = v_uid;
  end if;

  return pg_catalog.jsonb_build_object(
    'acknowledgement_id', v_id,
    'policy_id', v_v.policy_id,
    'version_id', v_v.id,
    'version_number', v_v.version_number,
    'acknowledged_at', v_at,
    'method', v_meth,
    'already', v_already);
end;
$$;

revoke all on function public.org_policy_acknowledge(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.org_policy_acknowledge(uuid, text, text) to authenticated;

comment on function public.org_policy_acknowledge(uuid, text, text) is
  'Records that the signed-in member pressed "I have read and agree" for a policy version (0482), for the caller''s own account only (auth.uid(); no account argument): p_text_hash is the hash that came with the words shown, p_method web or phone. Refuses 42501 policy_not_allowed (nobody signed in, no such version, not a current member of its organization by _notify_is_current_member: an act-as seat, a disabled account, an invitation, someone removed), 42501 aal2_required (a verified authenticator and no second step in the session), 22023 policy_method_invalid and policy_hash_invalid, P0001 policy_retired, policy_version_not_current (a draft, an older version) and policy_text_changed (the hash is not the version''s). A repeat for the same version writes nothing and answers the first row with already true. Answers acknowledgement_id, policy_id, version_id, version_number, acknowledged_at, method, already.';

-- ── What an owner or admin reads ─────────────────────────────────────────────
create function public.org_policies_for_admin(p_organization_id uuid)
returns table (
  policy_id                      uuid,
  kind                           text,
  status                         text,
  title                          text,
  current_version_id             uuid,
  current_version_number         integer,
  current_needs_acknowledgement  boolean,
  current_published_at           timestamptz,
  current_published_by_name      text,
  round_version_number           integer,
  round_published_at             timestamptz,
  first_published_at             timestamptz,
  retired_at                     timestamptz,
  has_draft                      boolean,
  draft_title                    text,
  draft_updated_at               timestamptz,
  last_remind_now_at             timestamptz,
  next_remind_now_at             timestamptz,
  members                        integer,
  acknowledged                   integer,
  acknowledged_before_correction integer,
  not_acknowledged               integer,
  created_at                     timestamptz,
  updated_at                     timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_organization_id is null
     or not coalesce(public.has_org_role(p_organization_id, 'admin'), false) then
    raise exception 'policy_admins_only' using errcode = '42501', hint = 'policy_admins_only';
  end if;
  -- The app's authenticator rule for owners and admins (0472, as 0474 calls it).
  perform public.security_events_reader_check(p_organization_id);

  return query
    with cm as (
      select m.user_id as c_user
        from public.organization_members m
       where m.organization_id = p_organization_id
         and public._notify_is_current_member(p_organization_id, m.user_id)
    ),
    listed as (
      select p.id as r_policy, p.kind as r_kind, p.status as r_status, p.title as r_title,
             cv.id as r_cv, cv.version_number as r_cv_number, cv.needs_acknowledgement as r_cv_needs,
             cv.published_at as r_cv_published, cv.published_by_name as r_cv_by_name,
             cv.acknowledgement_round as r_round,
             rv.published_at as r_round_published, p.first_published_at as r_first, p.retired_at as r_retired,
             d.id is not null as r_has_draft, d.title as r_draft_title, d.updated_at as r_draft_updated,
             p.last_remind_now_at as r_remind, p.created_at as r_created, p.updated_at as r_updated,
             case when cv.id is null then 0
                  else (select pg_catalog.count(*)::integer from cm
                         where exists (select 1 from public.org_policy_acknowledgements a
                                        where a.policy_id = p.id and a.acknowledgement_round = cv.acknowledgement_round
                                          and a.user_id = cm.c_user)) end as r_acked,
             -- Of those, the ones whose latest acknowledgement in the round is of an earlier text: the
             -- current version is a correction of what they agreed to.
             case when cv.id is null then 0
                  else (select pg_catalog.count(*)::integer from cm
                         where (select max(a.version_number) from public.org_policy_acknowledgements a
                                 where a.policy_id = p.id and a.acknowledgement_round = cv.acknowledgement_round
                                   and a.user_id = cm.c_user) < cv.version_number) end as r_acked_before
        from public.org_policies p
        left join public.org_policy_versions cv on cv.policy_id = p.id and cv.version_number = p.current_version
        left join public.org_policy_versions rv on rv.policy_id = p.id and rv.version_number = cv.acknowledgement_round
        left join public.org_policy_versions d on d.policy_id = p.id and d.published_at is null
       where p.organization_id = p_organization_id
    )
    select r.r_policy, r.r_kind, r.r_status, r.r_title, r.r_cv, r.r_cv_number, r.r_cv_needs, r.r_cv_published,
           r.r_cv_by_name, r.r_round, r.r_round_published, r.r_first, r.r_retired, r.r_has_draft, r.r_draft_title,
           r.r_draft_updated, r.r_remind,
           case when r.r_remind > pg_catalog.now() - interval '24 hours' then r.r_remind + interval '24 hours' end,
           (select pg_catalog.count(*)::integer from cm),
           r.r_acked, r.r_acked_before,
           case when r.r_cv is null then 0 else (select pg_catalog.count(*)::integer from cm) - r.r_acked end,
           r.r_created, r.r_updated
      from listed r
     order by case r.r_status when 'published' then 0 when 'draft' then 1 else 2 end, r.r_title, r.r_policy;
end;
$$;

revoke all on function public.org_policies_for_admin(uuid) from public, anon, authenticated, service_role;
grant execute on function public.org_policies_for_admin(uuid) to authenticated;

comment on function public.org_policies_for_admin(uuid) is
  'For the organization''s owners and admins (has_org_role admin): every policy, drafts included, with its current version, the round (the version that asked) and when it was published, the draft''s title and time if one is saved, Remind now''s last time and the next time it is allowed (null: now), current_published_by_name (who published the current version, as kept), and the counts of the current round: members (current members by _notify_is_current_member), acknowledged, acknowledged_before_correction (of those, the ones whose acknowledgement is of an earlier text the current version corrects) and not_acknowledged (0 for a policy never published). Published first, then drafts, then retired; by title. 42501 policy_admins_only for anyone else; mfa_required and aal2_required by the authenticator rule (security_events_reader_check).';

create function public.org_policy_draft(p_policy_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_p public.org_policies%rowtype;
  v_d public.org_policy_versions%rowtype;
  v_c public.org_policy_versions%rowtype;
begin
  select * into v_p from public.org_policies p where p.id = p_policy_id;
  if not found or not coalesce(public.has_org_role(v_p.organization_id, 'admin'), false) then
    raise exception 'policy_admins_only' using errcode = '42501', hint = 'policy_admins_only';
  end if;
  -- The app's authenticator rule for owners and admins (0472, as 0474 calls it).
  perform public.security_events_reader_check(v_p.organization_id);
  select * into v_d from public.org_policy_versions v where v.policy_id = v_p.id and v.published_at is null;
  select * into v_c from public.org_policy_versions v
   where v.policy_id = v_p.id and v.version_number = v_p.current_version;

  return pg_catalog.jsonb_build_object(
    'policy_id', v_p.id,
    'organization_id', v_p.organization_id,
    'kind', v_p.kind,
    'status', v_p.status,
    'title', v_p.title,
    'draft', case when v_d.id is null then null else pg_catalog.jsonb_build_object(
               'version_id', v_d.id, 'kind', v_d.kind, 'title', v_d.title, 'body', v_d.body,
               'text_hash', v_d.text_hash, 'created_at', v_d.created_at, 'updated_at', v_d.updated_at) end,
    'current', case when v_c.id is null then null else pg_catalog.jsonb_build_object(
                 'version_id', v_c.id, 'version_number', v_c.version_number, 'kind', v_c.kind,
                 'title', v_c.title, 'text_hash', v_c.text_hash,
                 'needs_acknowledgement', v_c.needs_acknowledgement,
                 'acknowledgement_round', v_c.acknowledgement_round, 'published_at', v_c.published_at,
                 'published_by', v_c.published_by, 'published_by_name', v_c.published_by_name) end,
    -- Every published version, oldest first: what changed, when, by whom (as kept).
    'versions', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                   'version_id', v.id, 'version_number', v.version_number, 'kind', v.kind, 'title', v.title,
                   'text_hash', v.text_hash, 'needs_acknowledgement', v.needs_acknowledgement,
                   'acknowledgement_round', v.acknowledgement_round, 'published_at', v.published_at,
                   'published_by', v.published_by, 'published_by_name', v.published_by_name)
                   order by v.version_number)
                 from public.org_policy_versions v
                where v.policy_id = v_p.id and v.published_at is not null), '[]'::jsonb));
end;
$$;

revoke all on function public.org_policy_draft(uuid) from public, anon, authenticated, service_role;
grant execute on function public.org_policy_draft(uuid) to authenticated;

comment on function public.org_policy_draft(uuid) is
  'For the organization''s owners and admins: a policy''s kind, status, title, its draft (version_id, kind, title, body, text_hash, created_at, updated_at; null when none is saved), its current version (version_id, version_number, kind, title, text_hash, needs_acknowledgement, acknowledgement_round, published_at, published_by, published_by_name; null when never published) and versions (every published version, oldest first, with the same fields: a correction is needs_acknowledgement false). 42501 policy_admins_only for anyone else and for a policy that does not exist; mfa_required and aal2_required by the authenticator rule.';

-- Who has and has not acknowledged the current round, by the current-member
-- rule (0422), and the invitations not yet accepted, apart.
create function public.org_policy_status(p_policy_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_p      public.org_policies%rowtype;
  v_cv     public.org_policy_versions%rowtype;
  v_rv     public.org_policy_versions%rowtype;
  v_ack    jsonb := '[]'::jsonb;
  v_not    jsonb := '[]'::jsonb;
  v_inv    jsonb := '[]'::jsonb;
begin
  select * into v_p from public.org_policies p where p.id = p_policy_id;
  if not found or not coalesce(public.has_org_role(v_p.organization_id, 'admin'), false) then
    raise exception 'policy_admins_only' using errcode = '42501', hint = 'policy_admins_only';
  end if;
  -- The app's authenticator rule for owners and admins (0472, as 0474 calls it).
  perform public.security_events_reader_check(v_p.organization_id);
  select * into v_cv from public.org_policy_versions v
   where v.policy_id = v_p.id and v.version_number = v_p.current_version;
  select * into v_rv from public.org_policy_versions v
   where v.policy_id = v_p.id and v.version_number = v_cv.acknowledgement_round;

  if v_cv.id is not null then
    with cm as (
      select m.user_id as c_user, m.role as c_role, m.accepted_at as c_joined,
             up.full_name as c_name, up.email::text as c_email
        from public.organization_members m
        join public.user_profiles up on up.id = m.user_id
       where m.organization_id = v_p.organization_id
         and public._notify_is_current_member(v_p.organization_id, m.user_id)
    ),
    latest as (
      select distinct on (a.user_id) a.user_id as l_user, a.version_number as l_number, a.method as l_method,
             a.acknowledged_at as l_at
        from public.org_policy_acknowledgements a
       where a.policy_id = v_p.id and a.acknowledgement_round = v_cv.acknowledgement_round
         and a.user_id is not null
       order by a.user_id, a.acknowledged_at desc, a.version_number desc
    )
    select
      coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'user_id', cm.c_user, 'name', cm.c_name, 'email', cm.c_email, 'role', cm.c_role,
                 'version_number', l.l_number, 'corrected_since', l.l_number < v_cv.version_number,
                 'method', l.l_method, 'acknowledged_at', l.l_at)
               order by pg_catalog.lower(coalesce(cm.c_name, cm.c_email)), cm.c_user)
               filter (where l.l_user is not null), '[]'::jsonb),
      coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'user_id', cm.c_user, 'name', cm.c_name, 'email', cm.c_email, 'role', cm.c_role,
                 'member_since', cm.c_joined,
                 'owed_since', greatest(v_rv.published_at, cm.c_joined),
                 'reminders_sent', coalesce(r.sent_count, 0),
                 'remind_now_count', coalesce(r.manual_count, 0),
                 'last_reminded_at', r.last_reminded_at)
               order by pg_catalog.lower(coalesce(cm.c_name, cm.c_email)), cm.c_user)
               filter (where l.l_user is null), '[]'::jsonb)
      into v_ack, v_not
      from cm
      left join latest l on l.l_user = cm.c_user
      left join public.org_policy_reminders r on r.round_version_id = v_rv.id and r.user_id = cm.c_user;
  end if;

  -- Invitations not yet accepted: open invitations, and membership rows not
  -- accepted. They are asked once they join, never before.
  select coalesce(pg_catalog.jsonb_agg(x.j order by x.k), '[]'::jsonb) into v_inv
    from (
      select pg_catalog.jsonb_build_object('email', i.email::text, 'role', i.role, 'invited_at', i.created_at,
                                           'expires_at', i.expires_at) as j,
             pg_catalog.lower(i.email::text) as k
        from public.organization_invites i
       where i.organization_id = v_p.organization_id
         and i.accepted_at is null and i.revoked_at is null and i.expires_at > pg_catalog.now()
      union all
      select pg_catalog.jsonb_build_object('email', up.email::text, 'role', m.role, 'invited_at', m.created_at,
                                           'expires_at', null),
             pg_catalog.lower(up.email::text)
        from public.organization_members m
        join public.user_profiles up on up.id = m.user_id
       where m.organization_id = v_p.organization_id
         and m.accepted_at is null and m.impersonation_expires_at is null
    ) x;

  return pg_catalog.jsonb_build_object(
    'policy', pg_catalog.jsonb_build_object(
      'policy_id', v_p.id, 'organization_id', v_p.organization_id, 'kind', v_p.kind, 'status', v_p.status,
      'title', v_p.title, 'current_version_id', v_cv.id, 'current_version_number', v_cv.version_number,
      'current_needs_acknowledgement', v_cv.needs_acknowledgement, 'current_published_at', v_cv.published_at,
      'current_published_by', v_cv.published_by, 'current_published_by_name', v_cv.published_by_name,
      'round_version_number', v_cv.acknowledgement_round, 'round_published_at', v_rv.published_at,
      'last_remind_now_at', v_p.last_remind_now_at,
      'next_remind_now_at', case when v_p.last_remind_now_at > pg_catalog.now() - interval '24 hours'
                                 then v_p.last_remind_now_at + interval '24 hours' end),
    'counts', pg_catalog.jsonb_build_object(
      'members', pg_catalog.jsonb_array_length(v_ack) + pg_catalog.jsonb_array_length(v_not),
      'acknowledged', pg_catalog.jsonb_array_length(v_ack),
      'not_acknowledged', pg_catalog.jsonb_array_length(v_not),
      'invited', pg_catalog.jsonb_array_length(v_inv)),
    'acknowledged', v_ack,
    'not_acknowledged', v_not,
    'invited', v_inv);
end;
$$;

revoke all on function public.org_policy_status(uuid) from public, anon, authenticated, service_role;
grant execute on function public.org_policy_status(uuid) to authenticated;

comment on function public.org_policy_status(uuid) is
  'For the organization''s owners and admins: a policy''s current round. policy (policy_id, kind, status, title, current and round version numbers, the current version''s needs_acknowledgement, published_at, published_by and published_by_name, round_published_at, last and next Remind now); counts (members, acknowledged, not_acknowledged, invited); acknowledged (each current member with an acknowledgement in the round: user_id, name, email, role, version_number of the latest and corrected_since, true when the current version is a later correction of it, method, acknowledged_at); not_acknowledged (each current member without one: user_id, name, email, role, member_since, owed_since, reminders_sent, remind_now_count, last_reminded_at); invited (open invitations and memberships not accepted: email, role, invited_at, expires_at). Current members by _notify_is_current_member: never an act-as seat, a disabled account or an invitation. For a retired policy the lists are of its last round; for a policy never published they are empty. By name, then email. 42501 policy_admins_only for anyone else; mfa_required and aal2_required by the authenticator rule.';

-- The whole record of a policy: every acknowledgement of every version, also
-- of former members and deleted accounts, oldest first. For the CSV.
create function public.org_policy_acknowledgement_record(p_policy_id uuid)
returns table (
  acknowledgement_id     uuid,
  version_id             uuid,
  version_number         integer,
  acknowledgement_round  integer,
  version_title          text,
  text_hash              text,
  user_id                uuid,
  name                   text,
  account_deleted        boolean,
  current_member         boolean,
  email                  text,
  member_since           timestamptz,
  method                 text,
  acknowledged_at        timestamptz,
  current_version_number integer,
  since_acknowledged     text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_cur public.org_policy_versions%rowtype;
begin
  select p.organization_id into v_org from public.org_policies p where p.id = p_policy_id;
  if v_org is null or not coalesce(public.has_org_role(v_org, 'admin'), false) then
    raise exception 'policy_admins_only' using errcode = '42501', hint = 'policy_admins_only';
  end if;
  -- The app's authenticator rule for owners and admins (0472, as 0474 calls it).
  perform public.security_events_reader_check(v_org);
  select v.* into v_cur from public.org_policy_versions v join public.org_policies p on p.id = v.policy_id
   where p.id = p_policy_id and v.version_number = p.current_version;

  return query
    select a.id, a.version_id, a.version_number, a.acknowledgement_round, v.title, a.text_hash,
           a.user_id, a.user_name, a.user_id is null,
           a.user_id is not null and coalesce(public._notify_is_current_member(v_org, a.user_id), false),
           case when a.user_id is not null and coalesce(public._notify_is_current_member(v_org, a.user_id), false)
                then (select up.email::text from public.user_profiles up where up.id = a.user_id) end,
           a.member_since, a.method, a.acknowledged_at, v_cur.version_number,
           -- What the current text is to this acknowledgement: the same version, a later correction of
           -- it (asks nothing), or a later version that asked everyone again.
           case when a.version_number = v_cur.version_number then 'unchanged'
                when a.acknowledgement_round = v_cur.acknowledgement_round then 'corrected'
                else 'new_version' end
      from public.org_policy_acknowledgements a
      join public.org_policy_versions v on v.id = a.version_id
     where a.policy_id = p_policy_id
     order by a.acknowledged_at, a.version_number, a.id;
end;
$$;

revoke all on function public.org_policy_acknowledgement_record(uuid) from public, anon, authenticated, service_role;
grant execute on function public.org_policy_acknowledgement_record(uuid) to authenticated;

comment on function public.org_policy_acknowledgement_record(uuid) is
  'For the organization''s owners and admins: every acknowledgement of every version of a policy, oldest first (the record and its CSV): version id, number, round and title, text_hash, user_id (null once the account was deleted), name (as it was when acknowledged; never an email; for a deleted account that had none, ''Former member, no name on the account'', a row that proves less), account_deleted, current_member (now, by _notify_is_current_member), email (only for a current member), member_since (when that membership began), method, acknowledged_at, current_version_number and since_acknowledged (unchanged: the current version is the one acknowledged; corrected: the current version is a later correction of it, which asks nothing; new_version: a later version asked everyone again). 42501 policy_admins_only for anyone else; mfa_required and aal2_required by the authenticator rule.';

-- ── What an owner or admin writes ────────────────────────────────────────────
-- Saves the draft of a policy; with p_policy_id null, makes a new policy (in
-- p_organization_id) with this draft. The kind, title and body are the
-- draft's until it is published (a policy never published shows the draft's
-- kind and title at once). The title and body must be in
-- normal form (the core normalises before it sends).
create function public.org_policy_save_draft(
  p_organization_id uuid,
  p_policy_id uuid,
  p_kind text,
  p_title text,
  p_body text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_p       public.org_policies%rowtype;
  v_problem text;
  v_hash    text;
  v_draft   uuid;
  v_now     timestamptz := pg_catalog.now();
begin
  if p_organization_id is null
     or not coalesce(public.has_org_role(p_organization_id, 'admin'), false) then
    raise exception 'policy_admins_only' using errcode = '42501', hint = 'policy_admins_only';
  end if;
  -- The app's authenticator rule for owners and admins (0472, as 0474 calls it).
  perform public.security_events_reader_check(p_organization_id);
  -- A support (act-as) seat reads and never writes (0481's rule).
  if public._org_policy_caller_is_act_as(p_organization_id) then
    raise exception 'policy_act_as_read_only' using errcode = '42501', hint = 'policy_act_as_read_only';
  end if;
  if p_policy_id is not null then
    select * into v_p from public.org_policies p
     where p.id = p_policy_id and p.organization_id = p_organization_id;
    if not found then
      raise exception 'policy_admins_only' using errcode = '42501', hint = 'policy_admins_only';
    end if;
  end if;

  if p_kind is null or p_kind not in ('acceptable_use', 'data_handling', 'other') then
    raise exception 'policy_kind_invalid' using errcode = '22023', hint = 'policy_kind_invalid';
  end if;
  v_problem := public._org_policy_title_problem(p_title);
  if v_problem is not null then
    raise exception 'policy_title_invalid' using errcode = '22023', hint = 'policy_title_invalid', detail = v_problem;
  end if;
  v_problem := public._org_policy_body_problem(p_body);
  if v_problem is not null then
    raise exception 'policy_body_invalid' using errcode = '22023', hint = 'policy_body_invalid', detail = v_problem;
  end if;
  v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_title || E'\n\n' || p_body, 'UTF8')), 'hex');

  if p_policy_id is null then
    insert into public.org_policies (organization_id, kind, title)
    values (p_organization_id, p_kind, p_title)
    returning * into v_p;
  else
    select * into v_p from public.org_policies p where p.id = p_policy_id for update;
    if v_p.status = 'retired' then
      raise exception 'policy_retired' using errcode = 'P0001', hint = 'policy_retired';
    end if;
    update public.org_policies p
       set kind = case when p.status = 'draft' then p_kind else p.kind end,
           title = case when p.status = 'draft' then p_title else p.title end,
           updated_at = v_now
     where p.id = v_p.id;
  end if;

  update public.org_policy_versions v
     set kind = p_kind, title = p_title, body = p_body, text_hash = v_hash, updated_at = v_now
   where v.policy_id = v_p.id and v.published_at is null
  returning v.id into v_draft;
  if v_draft is null then
    insert into public.org_policy_versions (organization_id, policy_id, kind, title, body, text_hash)
    values (v_p.organization_id, v_p.id, p_kind, p_title, p_body, v_hash)
    returning id into v_draft;
  end if;

  return pg_catalog.jsonb_build_object(
    'policy_id', v_p.id, 'draft_version_id', v_draft, 'text_hash', v_hash, 'updated_at', v_now,
    'created', p_policy_id is null);
end;
$$;

revoke all on function public.org_policy_save_draft(uuid, uuid, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.org_policy_save_draft(uuid, uuid, text, text, text) to authenticated;

comment on function public.org_policy_save_draft(uuid, uuid, text, text, text) is
  'For the organization''s owners and admins: saves a policy''s draft (kind, title, body; the last save wins; a published policy keeps its kind and title until the draft is published); with p_policy_id null, makes a new draft policy in p_organization_id. Title and body must be in the normal form of packages/core policy-text.ts. Answers policy_id, draft_version_id, text_hash (pass it to org_policy_publish), updated_at, created. 42501 policy_admins_only (not an admin of p_organization_id, or the policy is not in it), policy_act_as_read_only (a support seat), 22023 policy_kind_invalid, policy_title_invalid and policy_body_invalid (detail empty, too_long, too_many_lines, forbidden_character, too_many_marks or not_normal_form), P0001 policy_retired; mfa_required and aal2_required by the authenticator rule.';

create function public.org_policy_discard_draft(p_policy_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_p public.org_policies%rowtype;
  v_n integer;
begin
  select * into v_p from public.org_policies p where p.id = p_policy_id;
  if not found or not coalesce(public.has_org_role(v_p.organization_id, 'admin'), false) then
    raise exception 'policy_admins_only' using errcode = '42501', hint = 'policy_admins_only';
  end if;
  -- The app's authenticator rule for owners and admins (0472, as 0474 calls it).
  perform public.security_events_reader_check(v_p.organization_id);
  -- A support (act-as) seat reads and never writes (0481's rule).
  if public._org_policy_caller_is_act_as(v_p.organization_id) then
    raise exception 'policy_act_as_read_only' using errcode = '42501', hint = 'policy_act_as_read_only';
  end if;
  select * into v_p from public.org_policies p where p.id = p_policy_id for update;

  if v_p.status = 'draft' then
    delete from public.org_policies p where p.id = v_p.id;
    return pg_catalog.jsonb_build_object('policy_id', v_p.id, 'discarded', 'policy');
  end if;
  delete from public.org_policy_versions v where v.policy_id = v_p.id and v.published_at is null;
  get diagnostics v_n = row_count;
  return pg_catalog.jsonb_build_object('policy_id', v_p.id,
                                       'discarded', case when v_n > 0 then 'draft' else 'nothing' end);
end;
$$;

revoke all on function public.org_policy_discard_draft(uuid) from public, anon, authenticated, service_role;
grant execute on function public.org_policy_discard_draft(uuid) to authenticated;

comment on function public.org_policy_discard_draft(uuid) is
  'For the organization''s owners and admins: discards a policy''s draft. A policy never published is deleted with it (discarded: policy); a published or retired one keeps every published version (discarded: draft, or nothing when there was no draft). 42501 policy_admins_only for anyone else, policy_act_as_read_only for a support seat; mfa_required and aal2_required by the authenticator rule.';

-- Publishes the draft. p_change: new_version (every member is asked again;
-- the first publish is always one) or correction (nobody is asked again; the
-- round stays the corrected version's). p_text_hash: the draft's hash the
-- admin reviewed, so a draft another admin saved meanwhile is not published
-- unseen.
create function public.org_policy_publish(p_policy_id uuid, p_change text, p_text_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_uid    uuid := auth.uid();
  v_p      public.org_policies%rowtype;
  v_d      public.org_policy_versions%rowtype;
  v_c      public.org_policy_versions%rowtype;
  v_number integer;
  v_round  integer;
  v_needs  boolean;
  v_now    timestamptz := pg_catalog.now();
  v_asked  jsonb := '[]'::jsonb;
begin
  select * into v_p from public.org_policies p where p.id = p_policy_id;
  if not found or v_uid is null or not coalesce(public.has_org_role(v_p.organization_id, 'admin'), false) then
    raise exception 'policy_admins_only' using errcode = '42501', hint = 'policy_admins_only';
  end if;
  -- The app's authenticator rule for owners and admins (0472, as 0474 calls it).
  perform public.security_events_reader_check(v_p.organization_id);
  -- A support (act-as) seat reads and never writes (0481's rule).
  if public._org_policy_caller_is_act_as(v_p.organization_id) then
    raise exception 'policy_act_as_read_only' using errcode = '42501', hint = 'policy_act_as_read_only';
  end if;
  if p_change is null or p_change not in ('new_version', 'correction') then
    raise exception 'policy_change_invalid' using errcode = '22023', hint = 'policy_change_invalid';
  end if;
  if p_text_hash is null or p_text_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'policy_hash_invalid' using errcode = '22023', hint = 'policy_hash_invalid';
  end if;

  select * into v_p from public.org_policies p where p.id = p_policy_id for update;
  if v_p.status = 'retired' then
    raise exception 'policy_retired' using errcode = 'P0001', hint = 'policy_retired';
  end if;
  select * into v_d from public.org_policy_versions v where v.policy_id = v_p.id and v.published_at is null;
  if v_d.id is null then
    raise exception 'policy_no_draft' using errcode = 'P0001', hint = 'policy_no_draft';
  end if;
  if v_d.text_hash <> p_text_hash then
    raise exception 'policy_draft_changed' using errcode = 'P0001', hint = 'policy_draft_changed';
  end if;

  v_needs := p_change = 'new_version';
  if v_p.status = 'draft' then
    if not v_needs then
      raise exception 'policy_correction_needs_a_version' using errcode = 'P0001',
        hint = 'policy_correction_needs_a_version';
    end if;
    v_number := 1;
    v_round := 1;
  else
    select * into v_c from public.org_policy_versions v
     where v.policy_id = v_p.id and v.version_number = v_p.current_version;
    -- A correction fixes the words of the version it corrects and keeps
    -- its title and its kind: a change of either is a new version, which
    -- asks everyone again.
    if not v_needs and v_d.title <> v_c.title then
      raise exception 'policy_correction_changes_title' using errcode = 'P0001',
        hint = 'policy_correction_changes_title';
    end if;
    if not v_needs and v_d.kind <> v_c.kind then
      raise exception 'policy_correction_changes_kind' using errcode = 'P0001',
        hint = 'policy_correction_changes_kind';
    end if;
    if not v_needs and v_d.text_hash = v_c.text_hash then
      raise exception 'policy_draft_unchanged' using errcode = 'P0001', hint = 'policy_draft_unchanged';
    end if;
    v_number := v_p.current_version + 1;
    v_round := case when v_needs then v_number else v_c.acknowledgement_round end;
  end if;

  update public.org_policy_versions v
     set version_number = v_number,
         needs_acknowledgement = v_needs,
         acknowledgement_round = v_round,
         published_at = v_now,
         published_by = v_uid,
         published_by_name = public._org_policy_person_name(v_uid),
         updated_at = v_now
   where v.id = v_d.id;

  update public.org_policies p
     set status = 'published',
         current_version = v_number,
         kind = v_d.kind,
         title = v_d.title,
         first_published_at = coalesce(p.first_published_at, v_now),
         updated_at = v_now
   where p.id = v_p.id;

  -- Who is now asked (a new version only): the current members, for the
  -- notice the website sends.
  if v_needs then
    select coalesce(pg_catalog.jsonb_agg(m.user_id order by m.user_id), '[]'::jsonb) into v_asked
      from public.organization_members m
     where m.organization_id = v_p.organization_id
       and public._notify_is_current_member(v_p.organization_id, m.user_id);
  end if;

  return pg_catalog.jsonb_build_object(
    'policy_id', v_p.id, 'version_id', v_d.id, 'version_number', v_number,
    'needs_acknowledgement', v_needs, 'acknowledgement_round', v_round, 'published_at', v_now,
    'kind', v_d.kind, 'title', v_d.title, 'asked_user_ids', v_asked);
end;
$$;

revoke all on function public.org_policy_publish(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.org_policy_publish(uuid, text, text) to authenticated;

comment on function public.org_policy_publish(uuid, text, text) is
  'For the organization''s owners and admins: publishes the policy''s draft as its next version, and from then on the version never changes. p_change new_version (asks every current member again; the first publish must be one) or correction (asks nobody again; the round stays the corrected version''s; it keeps the current title and kind; the members who acknowledged an earlier text are told once by org_policy_correction_notices_claim). p_text_hash must be the draft''s (from org_policy_save_draft or org_policy_draft). Answers policy_id, version_id, version_number, needs_acknowledgement, acknowledgement_round, published_at, kind, title, asked_user_ids (the current members, by _notify_is_current_member, for a new version; empty for a correction). 42501 policy_admins_only, policy_act_as_read_only (a support seat), 22023 policy_change_invalid and policy_hash_invalid, P0001 policy_retired, policy_no_draft, policy_draft_changed (another save meanwhile), policy_correction_needs_a_version, policy_correction_changes_title, policy_correction_changes_kind, policy_draft_unchanged (a correction with the current words); mfa_required and aal2_required by the authenticator rule.';

create function public.org_policy_retire(p_policy_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_p   public.org_policies%rowtype;
  v_now timestamptz := pg_catalog.now();
begin
  select * into v_p from public.org_policies p where p.id = p_policy_id;
  if not found or not coalesce(public.has_org_role(v_p.organization_id, 'admin'), false) then
    raise exception 'policy_admins_only' using errcode = '42501', hint = 'policy_admins_only';
  end if;
  -- The app's authenticator rule for owners and admins (0472, as 0474 calls it).
  perform public.security_events_reader_check(v_p.organization_id);
  -- A support (act-as) seat reads and never writes (0481's rule).
  if public._org_policy_caller_is_act_as(v_p.organization_id) then
    raise exception 'policy_act_as_read_only' using errcode = '42501', hint = 'policy_act_as_read_only';
  end if;
  select * into v_p from public.org_policies p where p.id = p_policy_id for update;
  if v_p.status = 'draft' then
    raise exception 'policy_not_published' using errcode = 'P0001', hint = 'policy_not_published';
  end if;
  if v_p.status = 'retired' then
    return pg_catalog.jsonb_build_object('policy_id', v_p.id, 'retired_at', v_p.retired_at, 'already', true);
  end if;

  delete from public.org_policy_versions v where v.policy_id = v_p.id and v.published_at is null;
  update public.org_policies p
     set status = 'retired', retired_at = v_now, updated_at = v_now
   where p.id = v_p.id;
  return pg_catalog.jsonb_build_object('policy_id', v_p.id, 'retired_at', v_now, 'already', false);
end;
$$;

revoke all on function public.org_policy_retire(uuid) from public, anon, authenticated, service_role;
grant execute on function public.org_policy_retire(uuid) to authenticated;

comment on function public.org_policy_retire(uuid) is
  'For the organization''s owners and admins: retires a published policy for good (members are no longer asked or reminded; every version and acknowledgement is kept; a saved draft is discarded). Again on a retired policy: answers its retired_at with already true. Answers policy_id, retired_at, already. 42501 policy_admins_only, policy_act_as_read_only (a support seat), P0001 policy_not_published (never published: discard it instead); mfa_required and aal2_required by the authenticator rule.';

-- Remind now: once per 24 hours per policy, the current members who have not
-- acknowledged the current round. Stamp first: the reminder rows and the
-- policy's time are written before the website sends anything, so a failed
-- send loses a reminder and never repeats one. Nothing is stamped when nobody
-- is owed one.
create function public.org_policy_remind_now(p_policy_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_p      public.org_policies%rowtype;
  v_cv     public.org_policy_versions%rowtype;
  v_rv     public.org_policy_versions%rowtype;
  v_now    timestamptz := pg_catalog.now();
  v_owed   uuid[];
begin
  select * into v_p from public.org_policies p where p.id = p_policy_id;
  if not found or not coalesce(public.has_org_role(v_p.organization_id, 'admin'), false) then
    raise exception 'policy_admins_only' using errcode = '42501', hint = 'policy_admins_only';
  end if;
  -- The app's authenticator rule for owners and admins (0472, as 0474 calls it).
  perform public.security_events_reader_check(v_p.organization_id);
  -- A support (act-as) seat reads and never writes (0481's rule).
  if public._org_policy_caller_is_act_as(v_p.organization_id) then
    raise exception 'policy_act_as_read_only' using errcode = '42501', hint = 'policy_act_as_read_only';
  end if;
  -- FOR UPDATE: two admins pressing at once remind once.
  select * into v_p from public.org_policies p where p.id = p_policy_id for update;
  if v_p.status = 'draft' then
    raise exception 'policy_not_published' using errcode = 'P0001', hint = 'policy_not_published';
  end if;
  if v_p.status = 'retired' then
    raise exception 'policy_retired' using errcode = 'P0001', hint = 'policy_retired';
  end if;
  if v_p.last_remind_now_at is not null and v_p.last_remind_now_at > v_now - interval '24 hours' then
    return pg_catalog.jsonb_build_object(
      'policy_id', v_p.id, 'reminded', false, 'reason', 'too_soon',
      'next_allowed_at', v_p.last_remind_now_at + interval '24 hours', 'recipients', '[]'::jsonb);
  end if;

  select * into v_cv from public.org_policy_versions v
   where v.policy_id = v_p.id and v.version_number = v_p.current_version;
  select * into v_rv from public.org_policy_versions v
   where v.policy_id = v_p.id and v.version_number = v_cv.acknowledgement_round;

  select coalesce(pg_catalog.array_agg(m.user_id order by m.user_id), '{}'::uuid[]) into v_owed
    from public.organization_members m
   where m.organization_id = v_p.organization_id
     and public._notify_is_current_member(v_p.organization_id, m.user_id)
     and not exists (select 1 from public.org_policy_acknowledgements a
                      where a.policy_id = v_p.id and a.acknowledgement_round = v_cv.acknowledgement_round
                        and a.user_id = m.user_id);
  if pg_catalog.cardinality(v_owed) = 0 then
    return pg_catalog.jsonb_build_object(
      'policy_id', v_p.id, 'reminded', false, 'reason', 'nobody_owed', 'next_allowed_at', null,
      'recipients', '[]'::jsonb);
  end if;

  insert into public.org_policy_reminders as r
    (organization_id, policy_id, round_version_id, user_id, manual_count, last_reminded_at)
  select v_p.organization_id, v_p.id, v_rv.id, u, 1, v_now from pg_catalog.unnest(v_owed) u
  on conflict on constraint org_policy_reminders_once do update
    set manual_count = r.manual_count + 1,
        last_reminded_at = greatest(r.last_reminded_at, excluded.last_reminded_at);
  update public.org_policies p set last_remind_now_at = v_now, updated_at = v_now where p.id = v_p.id;

  return pg_catalog.jsonb_build_object(
    'policy_id', v_p.id, 'reminded', true, 'reason', null, 'reminded_at', v_now,
    'next_allowed_at', v_now + interval '24 hours',
    'version_id', v_cv.id, 'version_number', v_cv.version_number, 'title', v_cv.title,
    'recipients', pg_catalog.to_jsonb(v_owed));
end;
$$;

revoke all on function public.org_policy_remind_now(uuid) from public, anon, authenticated, service_role;
grant execute on function public.org_policy_remind_now(uuid) to authenticated;

comment on function public.org_policy_remind_now(uuid) is
  'For the organization''s owners and admins: "Remind now" for a published policy, at most once per 24 hours per policy. Stamps first (each recipient''s reminder row: manual_count + 1, last_reminded_at; the policy''s last_remind_now_at), then answers reminded true, reminded_at, next_allowed_at, version_id, version_number, title and recipients (user ids: the current members by _notify_is_current_member without an acknowledgement in the round), for the website to send. reminded false with reason too_soon (and next_allowed_at) or nobody_owed (nothing stamped). 42501 policy_admins_only, policy_act_as_read_only (a support seat), P0001 policy_not_published, policy_retired; mfa_required and aal2_required by the authenticator rule.';

-- ── The reminder job's claim (service_role) ──────────────────────────────────
-- Stamp first, then send (D in the code map): each due reminder is written
-- (sent_count + 1, last_sent_at, last_reminded_at) before it is handed out;
-- a crash after this loses a reminder, it never sends one twice. Two runs at
-- once: the transaction advisory lock (4820001, try only) lets one claim and
-- answers the other busy (more false: the next run claims them); and each
-- stamp is a compare-and-set on the row's count, so a claim made without the
-- lock still hands a reminder out once.
-- Due (packages/core policy-reminders.ts): a published policy; a current
-- member (0422) with no acknowledgement in the round; owed since the later
-- of the round's publish time and the member's joining; reminder n (1 to 6)
-- at 3, 7, 14, 21, 28, 35 days; never within 3 days of the last reminder of
-- either kind. Oldest owed first, at most p_limit (1 to 1000, default 200)
-- a call; more: true when more were due.
create function public.org_policy_reminders_claim(p_limit integer default 200)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  c_days    constant integer[] := array[3, 7, 14, 21, 28, 35];
  c_min_gap constant interval := interval '3 days';
  v_limit   integer := least(greatest(coalesce(p_limit, 200), 1), 1000);
  v_now     timestamptz := pg_catalog.now();
  v_claimed jsonb;
  v_due     integer;
begin
  -- The grant is the gate: service_role only. This second lock names no
  -- gate: the role setting names the caller inside this body too (0413).
  if coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon') then
    raise exception 'policy_not_allowed' using errcode = '42501', hint = 'policy_not_allowed';
  end if;
  if not pg_catalog.pg_try_advisory_xact_lock(4820001) then
    return pg_catalog.jsonb_build_object('busy', true, 'claimed', '[]'::jsonb, 'more', false, 'claimed_at', v_now);
  end if;

  with due as (
    select p.organization_id as d_org, p.id as d_policy, cv.title as d_title, cv.id as d_version,
           cv.version_number as d_number, rv.id as d_round, m.user_id as d_user,
           coalesce(r.sent_count, 0) as d_sent,
           greatest(rv.published_at, m.accepted_at) as d_owed
      from public.org_policies p
      join public.org_policy_versions cv on cv.policy_id = p.id and cv.version_number = p.current_version
      join public.org_policy_versions rv on rv.policy_id = p.id and rv.version_number = cv.acknowledgement_round
      join public.organization_members m on m.organization_id = p.organization_id
      left join public.org_policy_reminders r on r.round_version_id = rv.id and r.user_id = m.user_id
     where p.status = 'published'
       and coalesce(r.sent_count, 0) < pg_catalog.array_length(c_days, 1)
       and v_now >= greatest(rv.published_at, m.accepted_at)
                    + pg_catalog.make_interval(days => c_days[coalesce(r.sent_count, 0) + 1])
       and (r.last_reminded_at is null or v_now >= r.last_reminded_at + c_min_gap)
       and public._notify_is_current_member(p.organization_id, m.user_id)
       and not exists (select 1 from public.org_policy_acknowledgements a
                        where a.policy_id = p.id and a.acknowledgement_round = cv.acknowledgement_round
                          and a.user_id = m.user_id)
  ),
  picked as (
    select * from due order by d_owed, d_policy, d_user limit v_limit
  ),
  stamped as (
    insert into public.org_policy_reminders as r
      (organization_id, policy_id, round_version_id, user_id, sent_count, last_sent_at, last_reminded_at)
    select k.d_org, k.d_policy, k.d_round, k.d_user, k.d_sent + 1, v_now, v_now from picked k
    on conflict on constraint org_policy_reminders_once do update
      set sent_count = excluded.sent_count,
          last_sent_at = excluded.last_sent_at,
          last_reminded_at = excluded.last_reminded_at
      where r.sent_count = excluded.sent_count - 1
        and (r.last_reminded_at is null or r.last_reminded_at <= v_now - c_min_gap)
    returning r.round_version_id as s_round, r.user_id as s_user, r.sent_count as s_sent
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'organization_id', k.d_org, 'policy_id', k.d_policy, 'title', k.d_title,
           'version_id', k.d_version, 'version_number', k.d_number, 'round_version_id', k.d_round,
           'user_id', k.d_user, 'reminder_number', s.s_sent, 'owed_since', k.d_owed)
           order by k.d_owed, k.d_policy, k.d_user), '[]'::jsonb),
         (select pg_catalog.count(*)::integer from due)
    into v_claimed, v_due
    from picked k
    join stamped s on s.s_round = k.d_round and s.s_user = k.d_user;

  return pg_catalog.jsonb_build_object(
    'busy', false, 'claimed', v_claimed, 'more', v_due > v_limit, 'claimed_at', v_now);
end;
$$;

revoke all on function public.org_policy_reminders_claim(integer) from public, anon, authenticated, service_role;
grant execute on function public.org_policy_reminders_claim(integer) to service_role;

comment on function public.org_policy_reminders_claim(integer) is
  'For the daily reminder job (service_role only; 42501 policy_not_allowed when called as authenticated or anon): claims the automatic reminders now due, stamping each first (sent_count + 1, last_sent_at, last_reminded_at), oldest owed first, at most p_limit (1 to 1000, default 200). Due: a published policy, a current member (_notify_is_current_member) with no acknowledgement in the round, reminder n at 3, 7, 14, 21, 28, 35 days after the later of the round''s publish time and the member''s joining, at most 6, never within 3 days of the last reminder of either kind. Answers busy (another claim holds the lock: nothing claimed, try later), claimed (organization_id, policy_id, title, version_id, version_number, round_version_id, user_id, reminder_number, owed_since), more (more were due: call again), claimed_at. A stamp is a compare-and-set on the count: a reminder is handed out once however many claims overlap.';

-- ── The correction notices' claim (service_role) ─────────────────────────────
-- A correction asks nobody again, but it is never silent: each current member
-- whose latest acknowledgement in the round is of an earlier text is told
-- once, by the job that sends the reminders (one notice per correction; it
-- asks nothing: packages/core policyCorrectionNotice). Stamp first, as the
-- reminders: the member's reminder row of the round takes the correction's
-- number (correction_notice_number) before the notice is handed out, a
-- compare-and-set (only a later number replaces an earlier one), under the
-- transaction advisory lock 4820002 (try only: busy answers nothing). Two
-- corrections before a run: one notice, of the later. Oldest correction
-- first, at most p_limit (1 to 1000, default 200) a call; more: true when
-- more were due.
create function public.org_policy_correction_notices_claim(p_limit integer default 200)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_limit   integer := least(greatest(coalesce(p_limit, 200), 1), 1000);
  v_now     timestamptz := pg_catalog.now();
  v_claimed jsonb;
  v_due     integer;
begin
  -- The grant is the gate: service_role only. This second lock names no
  -- gate: the role setting names the caller inside this body too (0413).
  if coalesce(pg_catalog.current_setting('role', true), 'none') in ('authenticated', 'anon') then
    raise exception 'policy_not_allowed' using errcode = '42501', hint = 'policy_not_allowed';
  end if;
  if not pg_catalog.pg_try_advisory_xact_lock(4820002) then
    return pg_catalog.jsonb_build_object('busy', true, 'claimed', '[]'::jsonb, 'more', false, 'claimed_at', v_now);
  end if;

  with due as (
    select p.organization_id as d_org, p.id as d_policy, cv.title as d_title, cv.id as d_version,
           cv.version_number as d_number, cv.published_at as d_corrected_at, rv.id as d_round,
           m.user_id as d_user, la.l_number as d_acked
      from public.org_policies p
      join public.org_policy_versions cv on cv.policy_id = p.id and cv.version_number = p.current_version
      join public.org_policy_versions rv on rv.policy_id = p.id and rv.version_number = cv.acknowledgement_round
      join public.organization_members m on m.organization_id = p.organization_id
      cross join lateral (
        select max(a.version_number) as l_number
          from public.org_policy_acknowledgements a
         where a.policy_id = p.id and a.acknowledgement_round = cv.acknowledgement_round
           and a.user_id = m.user_id) la
      left join public.org_policy_reminders r on r.round_version_id = rv.id and r.user_id = m.user_id
     where p.status = 'published'
       and not cv.needs_acknowledgement
       and la.l_number < cv.version_number
       and (r.correction_notice_number is null or r.correction_notice_number < cv.version_number)
       and public._notify_is_current_member(p.organization_id, m.user_id)
  ),
  picked as (
    select * from due order by d_corrected_at, d_policy, d_user limit v_limit
  ),
  stamped as (
    insert into public.org_policy_reminders as r
      (organization_id, policy_id, round_version_id, user_id, correction_notice_number, correction_noticed_at)
    select k.d_org, k.d_policy, k.d_round, k.d_user, k.d_number, v_now from picked k
    on conflict on constraint org_policy_reminders_once do update
      set correction_notice_number = excluded.correction_notice_number,
          correction_noticed_at = excluded.correction_noticed_at
      where r.correction_notice_number is null or r.correction_notice_number < excluded.correction_notice_number
    returning r.round_version_id as s_round, r.user_id as s_user
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'organization_id', k.d_org, 'policy_id', k.d_policy, 'title', k.d_title,
           'version_id', k.d_version, 'version_number', k.d_number, 'corrected_at', k.d_corrected_at,
           'acknowledged_version_number', k.d_acked, 'user_id', k.d_user)
           order by k.d_corrected_at, k.d_policy, k.d_user), '[]'::jsonb),
         (select pg_catalog.count(*)::integer from due)
    into v_claimed, v_due
    from picked k
    join stamped s on s.s_round = k.d_round and s.s_user = k.d_user;

  return pg_catalog.jsonb_build_object(
    'busy', false, 'claimed', v_claimed, 'more', v_due > v_limit, 'claimed_at', v_now);
end;
$$;

revoke all on function public.org_policy_correction_notices_claim(integer) from public, anon, authenticated, service_role;
grant execute on function public.org_policy_correction_notices_claim(integer) to service_role;

comment on function public.org_policy_correction_notices_claim(integer) is
  'For the job that sends the reminders (service_role only; 42501 policy_not_allowed when called as authenticated or anon): claims the correction notices now due, stamping each first (the member''s reminder row of the round: correction_notice_number, correction_noticed_at). Due: a published policy whose current version is a correction, a current member (_notify_is_current_member) whose latest acknowledgement in the round is of an earlier version, not yet told of this correction. One notice per correction (two corrections before a run: one, of the later); it asks nothing. Oldest correction first, at most p_limit (1 to 1000, default 200). Answers busy (another claim holds lock 4820002: nothing claimed, try later), claimed (organization_id, policy_id, title, version_id, version_number, corrected_at, acknowledged_version_number, user_id), more, claimed_at. A stamp is a compare-and-set: a notice is handed out once however many claims overlap.';

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- THIS BLOCK DELETES EVERY ACKNOWLEDGEMENT AND EVERY PUBLISHED VERSION OF
-- EVERY ORGANIZATION. THEY ARE EVIDENCE. IT REFUSES TO RUN WHILE ANY
-- ACKNOWLEDGEMENT EXISTS (55000, hint org_policies_rollback_refused).
-- Nothing depends on these objects but the app code that follows this
-- migration. Leave them in place. If they ever have to go (only before any
-- real record exists), know that each drop table that names
-- public.organizations or public.user_profiles also removes its foreign
-- key's triggers there, which takes ACCESS EXCLUSIVE on that table until
-- commit: every signed-in request waits behind it. Run it in a quiet minute,
-- as one transaction with a short lock_timeout; if it gives up (55P03)
-- nothing is dropped, and it can be run again as it is. The only way past
-- the refusal is a setting named for what it does, set by a person in the
-- same transaction, right after begin (no kit, script or migration sets
-- it): set local org_policies.rollback_destroys_evidence to the words
-- 'yes, destroy every acknowledgement'.
--   begin;
--   set local lock_timeout = '900ms';
--   do $refuse$
--   declare
--     v_rows boolean := false;
--   begin
--     if pg_catalog.to_regclass('public.org_policy_acknowledgements') is not null then
--       execute 'select exists (select 1 from public.org_policy_acknowledgements)' into v_rows;
--     end if;
--     if v_rows and coalesce(pg_catalog.current_setting('org_policies.rollback_destroys_evidence', true), '')
--                   <> 'yes, destroy every acknowledgement' then
--       raise exception 'org_policies_rollback_refused: acknowledgements exist; they are evidence and this block would delete them'
--         using errcode = '55000', hint = 'org_policies_rollback_refused';
--     end if;
--   end
--   $refuse$;
--   drop function if exists public.org_policy_correction_notices_claim(integer);
--   drop function if exists public.org_policy_reminders_claim(integer);
--   drop function if exists public.org_policy_remind_now(uuid);
--   drop function if exists public.org_policy_retire(uuid);
--   drop function if exists public.org_policy_publish(uuid, text, text);
--   drop function if exists public.org_policy_discard_draft(uuid);
--   drop function if exists public.org_policy_save_draft(uuid, uuid, text, text, text);
--   drop function if exists public.org_policy_acknowledgement_record(uuid);
--   drop function if exists public.org_policy_status(uuid);
--   drop function if exists public.org_policy_draft(uuid);
--   drop function if exists public.org_policies_for_admin(uuid);
--   drop function if exists public.org_policy_acknowledge(uuid, text, text);
--   drop function if exists public.org_policy_text(uuid, integer);
--   drop function if exists public.org_policies_for_member(uuid);
--   drop table if exists public.org_policy_reminders;
--   drop table if exists public.org_policy_acknowledgements;
--   drop table if exists public.org_policy_versions;
--   drop table if exists public.org_policies;
--   drop function if exists public._org_policy_refuse_truncate();
--   drop function if exists public._org_policy_acknowledgements_guard();
--   drop function if exists public._org_policy_versions_guard();
--   drop function if exists public._org_policies_guard();
--   drop function if exists public._org_policy_caller_is_act_as(uuid);
--   drop function if exists public._org_policy_person_name(uuid);
--   drop function if exists public._org_policy_body_problem(text);
--   drop function if exists public._org_policy_title_problem(text);
--   commit;
