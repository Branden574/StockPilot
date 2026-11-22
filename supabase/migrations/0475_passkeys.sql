-- 0475_passkeys.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- The records behind a passkey as the second step (part 2, version 2): a
-- member signs in with their password, then confirms with a passkey that our
-- own server checks. Supabase's own passkey sign-in stays switched off. When
-- the passkey check passes, the server answers a hidden authenticator factor
-- of the account (the "bridge"), so the session reaches the second step the
-- way an authenticator app's code takes it there today. This file only adds
-- the tables, the switches and the functions; nothing reads or writes them
-- until the app code that follows it, and every switch starts OFF. This
-- file's number is in its name, its test's name and labels, and the manifest
-- entry in scripts/security-test.sh.
--
-- WHAT IT ADDS (tier A: four new tables, their indexes, fifteen functions
-- and grants; three new columns on public.platform_settings. No stored row, no
-- existing function, policy, trigger, constraint or grant changes. The
-- existing objects touched are public.user_profiles and public.organizations,
-- which gain the internal triggers of the new foreign keys: deleting a
-- profile, which deleting an account does, deletes that account's rows here;
-- deleting an organization deletes its switch row.)
--   1. public.member_passkeys. One row per passkey a member added: the
--      credential id and public key (never shown to anyone), the signature
--      counter, the transports the browser reported (from a fixed list), the
--      backup flags (for the "synced to your other devices" label), the site
--      it was made for (rp_id), the member's name for it, when it was added
--      and last used, and when and why it was removed (member, recovery_code,
--      setup_failed, support). A removed row is kept so a removal stopped half
--      way can be finished; the purge deletes it after 90 days. It holds no
--      model or vendor of the device (AAGUID) and no attestation. The name
--      holds no dot, so no site name can be written in it. No email is to
--      print it (the plan's rule for the app; the app's tests pin it).
--   2. public.passkey_bridges. One row per passkey holder: the id of the
--      account's bridge factor at Supabase Auth (a plain uuid, no foreign
--      key into auth), its secret encrypted by the app (AES-256-GCM with a
--      dedicated key that is not in the database, "v<key version>.<iv>.
--      <ciphertext>.<tag>"), the key version, and when the row was last
--      written (made, repaired or re-encrypted). passkey_register() and
--      passkey_replace_bridge() refuse a factor id that is not a TOTP factor
--      of the same account carrying the reserved name sp-passkey-bridge- (so
--      an app bug cannot record the member's own authenticator app, or
--      another account's factor, as the bridge). A bridge row exists only
--      while the account has an active passkey: removing the last one deletes
--      it in the same transaction.
--   3. public.passkey_challenges. One row per passkey ceremony the server
--      starts: the account, the Auth session it was started for, what for
--      (second_step, password_reset, register, confirm_add, finish_setup),
--      the challenge, the SHA-256 of a cookie only that browser holds, the
--      site, when it ends (2 minutes after it was issued, set by
--      issue_passkey_challenge(); the table refuses more than 5) and when it
--      was spent. Spent once, by take_passkey_challenge().
--   4. public.organization_passkey_switches. One row per organization that
--      has passkeys switched on (a row means on). Only service_role writes it
--      (the platform console, a later stage). A member may add a passkey only
--      when every organization they belong to has a row here. A passkey
--      belongs to the account, so once added it works in every organization
--      the account belongs to.
--   5. Three platform-wide settings on public.platform_settings, all default
--      false; no settings row means all off:
--      passkeys_on      the kill switch. Off: no passkey step is offered or
--                       accepted anywhere and none can be added.
--      passkey_adds_on  "new passkeys". Off: no passkey can be added, and the
--                       ones that exist keep working (so a fault in adding can
--                       be stopped without locking anyone out).
--      passkey_check_ends_sessions  Off: the server's check of bridge-raised
--                       sessions only reports a raise it cannot explain. On:
--                       it also ends that one session. Off first, so the
--                       first runs can be compared with known-honest raises
--                       before anything is ended. Turning it on affects
--                       raises found from then on: one reported while it was
--                       off is not ended later.
--   What guards them is row security on public.platform_settings with no
--   policy (0241): 0402 grants anon and authenticated every privilege on the
--   table, and those grants reach no row. This file changes no grant there,
--   the preflight refuses to run if the table has a policy or row security
--   is off, and the test pins that a member and a signed-out caller can
--   neither read nor change the row.
--   The console's audit words for the switches are NOT added here: they come
--   with the console control (a later stage), because changing
--   platform_admin_audit's action check is not additive and 0413's test pins
--   that check.
--   6. Functions (each with an empty search_path: every table, and every
--      function outside pg_catalog, is named with its schema, so the
--      built-ins can only be pg_catalog's; all SECURITY DEFINER except the
--      private check _passkey_bridge_factor_ok):
--      my_passkeys()                  the signed-in member's own active
--                                     passkeys, with no key material
--      passkey_add_allowed(uuid)      why an account may or may not add one
--      passkey_register(...)          a new passkey row, and a new bridge row
--                                     when the account has none (insert only),
--                                     re-checking the rule in one transaction
--      issue_passkey_challenge(...)   a new challenge, 2 minutes, by the
--                                     database clock
--      take_passkey_challenge(...)    spends a challenge that matches all five
--                                     of its bindings, or nothing; refused
--                                     while the kill switch is off
--      passkey_mark_removed(...)      removes one passkey (soft); the last one
--                                     takes the bridge row with it
--      passkey_remove_all(uuid, text) removes every passkey and the bridge
--                                     row (a recovery code, or support)
--      consume_recovery_code_with_passkeys(uuid, text)
--                                     spends a recovery code of the account
--                                     and, only when it was valid, removes
--                                     every passkey and the bridge row, in
--                                     one transaction
--      passkey_replace_bridge(...)    puts a new bridge in place of the one
--                                     expected (compare and swap; never a
--                                     verified bridge for an unverified one)
--      passkey_drop_bridge(...)       deletes the bridge row if it is the
--                                     one named and no passkey is active
--      passkey_account_states(text)   every account whose passkeys, bridge
--                                     row and reserved-name factors are not
--                                     healthy, with a state word and the
--                                     facts behind it
--      passkey_bridge_sessions(...)   the Auth sessions whose second step is
--                                     now held by a reserved-name factor,
--                                     with the time of their newest TOTP
--                                     answer (auth.mfa_amr_claims)
--      passkey_end_bridge_session(uuid)
--                                     ends ONE Auth session, and only one
--                                     whose second step is held now by the
--                                     account's recorded bridge factor
--      purge_passkey_records()        retention
--      _passkey_bridge_factor_ok(...) private: is this factor a reserved-name
--                                     TOTP factor of this account
--
-- WHAT THE DATABASE LEAVES TO THE SERVER
--   - A use (counter, last_used_at, backed_up) is a direct update by the
--     server. That the counter only goes up and that only an active passkey
--     is used are in the server's WHERE, not in a database rule. The use
--     write is where the counter is stored, so the server writes a
--     last_used_at no earlier than the row's created_at, which it has just
--     read (the table refuses a use written as earlier than the add), and a
--     use write that changes no row or is refused refuses the sign-in.
--   - The public key: the table checks its length and that its first byte
--     opens a CBOR map, as every COSE key does (so a key sent as base64 or
--     hex text is refused); that it parses, and its algorithm, are the
--     server's check.
--   - The state of one account on a request: passkey_account_states()
--     answers the sweep, the console and the check after a restore, with the
--     facts behind each word. The server reads the same facts for one account
--     and branches on the facts, as that function does; there is no
--     single-account read here.
--   - A new key version for the same bridge factor (rotation) is
--     passkey_replace_bridge() with the old and the new factor the same.
--   - The platform console's allowlist, the audit rows and the emails.
--
-- WHO CAN READ AND WRITE
--   - RLS is on with NO policy on the four tables, and no role but
--     service_role and the owner has a privilege on any of them. (No policy
--     is created, so this file takes none of the locks a CREATE POLICY takes
--     on this platform: 0418's note.)
--   - A member reads their own active passkeys through my_passkeys(). It
--     refuses with 42501 (passkeys_not_allowed) when nobody is signed in and
--     when the account is disabled (user_profiles.disabled_at, the mark
--     has_org_role reads since 0310), before anything else. Then the part of
--     the app's authenticator rule that needs no organization (0474's): an
--     account with a verified authenticator reads only from a session that
--     holds the second step (42501, message and hint aal2_required). It never
--     returns the credential id, the public key, the counter or the site.
--   - service_role (the app's server) reads the four tables. It writes
--     member_passkeys directly only to record a use (counter, last_used_at,
--     backed_up) and a new name: column grants, nothing else. Every other
--     write goes through the functions above, which only service_role may
--     call: a new passkey only through passkey_register(), which re-checks
--     the rules inside its own transaction; a challenge only through
--     issue_passkey_challenge() and take_passkey_challenge(); a bridge only
--     through passkey_register() (insert), passkey_replace_bridge() (compare
--     and swap) and the removal functions. It inserts and deletes switch rows
--     directly (the platform console, a later stage).
--   - service_role can end ONE Auth session, through
--     passkey_end_bridge_session(): only a session whose second step is held
--     now (aal2) by the account's recorded bridge factor; any other session is
--     refused. The delete cascades to that session's refresh tokens, Auth's
--     method rows and its name. Nothing else in auth is written by this file.
--   - consume_recovery_code_with_passkeys() is for service_role only: the app
--     checks the member's password and holds the verified account before it
--     calls it. The member's own consume_mfa_recovery_code (0103, granted to
--     authenticated) is unchanged and removes no passkey, so a direct call
--     with a member's token cannot strip passkeys without the password.
--   Explicit for all three API roles (apps/web/src/test/migration-grants.ts),
--   right with and without Supabase's default grants.
--
-- ROLLBACK
--   Nothing reads or writes these until the app code that follows this
--   migration, and every switch starts off. Leave them in place. If they ever
--   have to go: first remove every bridge factor at Supabase Auth (or members
--   whose only second step is a passkey owe a step nobody can answer), and
--   never roll the web app back past the release that hides the bridge once a
--   bridge exists. Then, in a quiet minute, as one transaction. Its locks
--   (measured, see LOCKS): ACCESS EXCLUSIVE on public.user_profiles and
--   public.organizations (each drop table removes its foreign key's triggers
--   there), on public.platform_settings (the three drop column) and on the four
--   tables it drops; nothing in auth. While they are held, until the commit
--   (milliseconds), EVERY request that reads a profile or an organization
--   waits: every signed-in request. The lock line takes all seven at once,
--   NOWAIT, so it never waits holding one and nothing queues behind it: a
--   busy table ends it at once with 55P03 and nothing dropped (measured: 34
--   ms behind an open read of user_profiles), and it is run again as it is.
--   (After it has run, a second run stops at the lock line, because the four
--   tables are gone, and changes nothing.)
--     begin;
--     set local lock_timeout = '900ms';
--     lock table only public.user_profiles, public.organizations, public.platform_settings,
--       public.member_passkeys, public.passkey_bridges, public.passkey_challenges,
--       public.organization_passkey_switches in access exclusive mode nowait;
--     drop function if exists public.purge_passkey_records();
--     drop function if exists public.passkey_end_bridge_session(uuid);
--     drop function if exists public.passkey_bridge_sessions(timestamptz);
--     drop function if exists public.passkey_account_states(text);
--     drop function if exists public.passkey_drop_bridge(uuid, uuid);
--     drop function if exists public.passkey_replace_bridge(uuid, uuid, uuid, text, smallint);
--     drop function if exists public.consume_recovery_code_with_passkeys(uuid, text);
--     drop function if exists public.passkey_remove_all(uuid, text);
--     drop function if exists public.passkey_mark_removed(uuid, uuid, text);
--     drop function if exists public.take_passkey_challenge(uuid, uuid, uuid, text, text);
--     drop function if exists public.issue_passkey_challenge(uuid, uuid, text, text, text, text);
--     drop function if exists public.passkey_register(uuid, text, bytea, bigint, text[], boolean, boolean, text, text, uuid, text, smallint);
--     drop function if exists public.passkey_add_allowed(uuid);
--     drop function if exists public.my_passkeys();
--     drop function if exists public._passkey_bridge_factor_ok(uuid, uuid);
--     drop table if exists public.organization_passkey_switches;
--     drop table if exists public.passkey_challenges;
--     drop table if exists public.passkey_bridges;
--     drop table if exists public.member_passkeys;
--     alter table public.platform_settings drop column if exists passkey_check_ends_sessions;
--     alter table public.platform_settings drop column if exists passkey_adds_on;
--     alter table public.platform_settings drop column if exists passkeys_on;
--     commit;
-- ─────────────────────────────────────────────────────────────────────────────

-- LOCKS (measured with scripts/db-concurrency/0475_migration_lock_footprint.sh
-- on a local stack at the head before this file, and with ROLLBACK=1 at the
-- head with it, for the rollback above).
-- The file takes every existing table it needs in ONE prelude, NOWAIT, after
-- the preflight (catalog reads only, no table lock) and before any other
-- statement:
--   - public.user_profiles: SHARE ROW EXCLUSIVE, the mode the three foreign
--     keys take. Every WRITE of a profile row waits while it is held:
--     sign-up's profile row, profile and avatar edits, notification
--     preferences, onboarding, invitations, workspace creation and
--     switching, act-as, an email change, an account disabled, enabled or
--     deleted. Reads of profiles, row locks on them (FOR UPDATE and the
--     like) and inserts into tables that point at them do not wait.
--   - public.organizations: SHARE ROW EXCLUSIVE, for the switch table's
--     foreign key. Every WRITE of an organization row waits (settings,
--     policy and billing changes, a new workspace, a deletion); reads, so
--     the request context every signed-in request builds, do not.
--   - public.platform_settings: ACCESS EXCLUSIVE, for the three new columns (a
--     constant default: no rewrite). Every read and write of it waits; only
--     the platform console reads it (the deletion passphrase); no member
--     request touches it.
--   Nothing after the prelude locks an existing table it did not take (the
--   foreign keys add ACCESS SHARE on user_profiles and organizations and the
--   COMMENT ON COLUMN adds SHARE UPDATE EXCLUSIVE on platform_settings, all
--   on tables the prelude holds), so the file never waits while holding one
--   and cannot deadlock. A busy table fails the attempt at once; its
--   subtransaction releases what it took and the next attempt starts after
--   50 to 150 ms holding no table lock. NOWAIT never queues, so no request
--   ever waits behind a waiting file: readers of profiles and organizations,
--   and row locks on profiles, do not even delay it (measured). Behind an
--   open write of any of the three tables, or an open read of
--   platform_settings, the 40 attempts took about 4 to 5 s (measured), then
--   the 55P03 is raised as it is and nothing is applied: run the push again.
--   A running ANALYZE or autovacuum of one of the three tables makes every
--   attempt busy, and NOWAIT never cancels it. From the prelude to the end of
--   the file the writes listed above (and every use of platform_settings)
--   wait for the hold: 27 ms measured, then the push's own history row and
--   the commit.
--   No policy is created and no trigger dropped, so supautils takes nothing
--   on the auth, storage and realtime tables, and creating the functions
--   takes no table lock: every body is plpgsql, so auth.mfa_factors,
--   auth.sessions, auth.mfa_amr_claims and public.mfa_recovery_codes are
--   read only when a function is called (a sql body would be resolved, and
--   its tables locked, when it is created). The one function that writes
--   in auth, passkey_end_bridge_session(), deletes a single auth.sessions
--   row when it is called, in one statement that also checks it (no lock
--   of its own beyond the delete's row lock on that session): the cascade
--   deletes its rows in auth.refresh_tokens and auth.mfa_amr_claims and its
--   public.user_session_names row (the same delete admin_revoke_user_sessions()
--   of 0308 makes for every session of an account); a lock wait there ends
--   after 2 s (55P03). Nothing when the file runs. lock_timeout 900ms
--   bounds anything unforeseen; it is not reset at the end of the file, so
--   the push's own last write, made in the same transaction, has the same
--   limit.
set lock_timeout = '900ms';

-- ── Preflight ────────────────────────────────────────────────────────────────
-- Reads the catalogs only (no table lock outside pg_catalog). Refuses to run
-- when a name this file creates is taken (applied already, or half applied
-- by hand); when a table, column or function the bodies read is missing;
-- when this role (the functions' owner) could not read auth.mfa_factors,
-- auth.sessions and auth.mfa_amr_claims, could not delete an auth.sessions
-- row, or would see none of their rows through row security (the functions
-- would then answer as if no factor existed); when auth.mfa_amr_claims does
-- not keep one row per session and method (the raise time's meaning); and when
-- public.platform_settings is not guarded the way the three settings need
-- (row security on, no policy).
do $$
declare
  v_bad text := '';
begin
  if to_regclass('auth.mfa_factors') is null or to_regclass('auth.sessions') is null
     or to_regclass('auth.mfa_amr_claims') is null then
    v_bad := v_bad || ' auth.mfa_factors, auth.sessions or auth.mfa_amr_claims is missing;';
  else
    if not has_table_privilege('auth.mfa_factors', 'select')
       or not has_table_privilege('auth.sessions', 'select')
       or not has_table_privilege('auth.mfa_amr_claims', 'select') then
      v_bad := v_bad || ' this role may not read auth.mfa_factors, auth.sessions or auth.mfa_amr_claims;';
    end if;
    if not has_table_privilege('auth.sessions', 'delete') then
      v_bad := v_bad || ' this role may not delete an auth.sessions row;';
    end if;
    if not (select r.rolsuper or r.rolbypassrls from pg_catalog.pg_roles r where r.rolname = current_user)
       and exists (select 1 from pg_catalog.pg_class c
                    where c.oid in ('auth.mfa_factors'::regclass, 'auth.sessions'::regclass,
                                    'auth.mfa_amr_claims'::regclass)
                      and c.relrowsecurity) then
      v_bad := v_bad || ' row security would hide auth.mfa_factors, auth.sessions or auth.mfa_amr_claims from this role;';
    end if;
    -- The auth columns the bodies read (factor_id and friendly_name are read
    -- by no earlier migration; the claim columns by none either).
    if (select count(*) from pg_catalog.pg_attribute a
         where a.attnum > 0 and not a.attisdropped
           and ((a.attrelid = 'auth.mfa_factors'::regclass
                 and a.attname in ('id', 'user_id', 'friendly_name', 'factor_type', 'status', 'created_at'))
                or (a.attrelid = 'auth.sessions'::regclass
                    and a.attname in ('id', 'user_id', 'factor_id', 'aal', 'created_at', 'updated_at'))
                or (a.attrelid = 'auth.mfa_amr_claims'::regclass
                    and a.attname in ('session_id', 'authentication_method', 'updated_at')))) <> 15 then
      v_bad := v_bad || ' a column of auth.mfa_factors, auth.sessions or auth.mfa_amr_claims the functions read is missing;';
    end if;
    -- Auth's rule of one row per session and method: a valid unique index on
    -- exactly those two columns, over every row (not partial).
    if not exists (
      select 1 from pg_catalog.pg_index i
       where i.indrelid = 'auth.mfa_amr_claims'::regclass
         and i.indisunique and i.indisvalid and i.indpred is null and i.indnkeyatts = 2
         and (select array_agg(a.attname::text order by a.attname)
                from pg_catalog.pg_attribute a
               where a.attrelid = i.indrelid and a.attnum = any (i.indkey)
                 and a.attnum > 0)
             = array['authentication_method', 'session_id']
    ) then
      v_bad := v_bad || ' auth.mfa_amr_claims does not keep one row per session and method;';
    end if;
  end if;
  if to_regclass('public.mfa_recovery_codes') is null
     or to_regprocedure('extensions.digest(text, text)') is null then
    v_bad := v_bad || ' public.mfa_recovery_codes or extensions.digest(text, text) is missing;';
  end if;
  if to_regclass('public.platform_settings') is null
     or not coalesce((select c.relrowsecurity from pg_catalog.pg_class c
                       where c.oid = to_regclass('public.platform_settings')), false)
     or exists (select 1 from pg_catalog.pg_policy pol where pol.polrelid = to_regclass('public.platform_settings')) then
    v_bad := v_bad || ' public.platform_settings is missing, or its row security is off, or it has a policy;';
  end if;
  if to_regclass('public.member_passkeys') is not null
     or to_regclass('public.passkey_bridges') is not null
     or to_regclass('public.passkey_challenges') is not null
     or to_regclass('public.organization_passkey_switches') is not null
     or exists (select 1 from pg_catalog.pg_attribute a
                 where a.attrelid = to_regclass('public.platform_settings')
                   and a.attname in ('passkeys_on', 'passkey_adds_on', 'passkey_check_ends_sessions')
                   and not a.attisdropped)
     or exists (select 1 from pg_catalog.pg_proc p
                 where p.pronamespace = 'public'::regnamespace
                   and p.proname in ('my_passkeys', 'passkey_add_allowed', 'passkey_register',
                                     'issue_passkey_challenge', 'take_passkey_challenge',
                                     'passkey_mark_removed', 'passkey_remove_all',
                                     'consume_recovery_code_with_passkeys',
                                     'passkey_replace_bridge', 'passkey_drop_bridge',
                                     'passkey_account_states', 'passkey_bridge_sessions',
                                     'passkey_end_bridge_session',
                                     'purge_passkey_records', '_passkey_bridge_factor_ok')) then
    v_bad := v_bad || ' the passkey objects already exist;';
  end if;
  if v_bad <> '' then
    raise exception 'passkeys_preflight:%', v_bad;
  end if;
end;
$$;

-- ── The lock prelude (see LOCKS above) ───────────────────────────────────────
-- Inside DO because the CLI batch is not a transaction block (a top-level
-- LOCK TABLE refuses there, 0373); the locks last until the batch commits.
-- Both LOCK statements are in one subtransaction: when the second table is
-- busy, the rollback of the attempt releases the first, so between attempts
-- the file holds no table lock.
do $lock_pk$
declare
  v_try integer := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      lock table only public.user_profiles, public.organizations in share row exclusive mode nowait;
      lock table only public.platform_settings in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if v_try >= 40 then
        raise;
      end if;
    end;
    perform pg_sleep(0.05 + random() * 0.1);
  end loop;
end $lock_pk$;

-- ── 1. member_passkeys ───────────────────────────────────────────────────────
create table public.member_passkeys (
  id                             uuid        primary key default gen_random_uuid(),
  user_id                        uuid        not null references public.user_profiles(id) on delete cascade,
  credential_id                  text        not null,
  public_key                     bytea       not null,
  counter                        bigint      not null default 0,
  transports                     text[]      not null default '{}'::text[],
  backup_eligible                boolean     not null,
  backed_up                      boolean     not null,
  user_verified_at_registration  boolean     not null,
  rp_id                          text        not null,
  name                           text        not null,
  created_at                     timestamptz not null default now(),
  last_used_at                   timestamptz,
  removed_at                     timestamptz,
  removed_reason                 text,
  constraint member_passkeys_credential_id_key unique (credential_id),
  -- base64url with no padding: 16 to 1023 bytes (22 to 1364 characters;
  -- WebAuthn's upper limit). The length is checked apart: a regular
  -- expression here counts to 255 only.
  constraint member_passkeys_credential_id
    check (credential_id ~ '^[A-Za-z0-9_-]+$' and char_length(credential_id) between 22 and 1364),
  -- A COSE public key: 32 bytes is below the smallest (Ed25519, about 42),
  -- 2048 above an RSA-4096 key. A COSE key is a CBOR map, so its first byte
  -- is 0xA0 to 0xBF; a key sent as text (base64 or hex letters, all below
  -- 0x80) is refused. That it parses is the server's check.
  constraint member_passkeys_public_key
    check (octet_length(public_key) between 32 and 2048
           and substring(public_key from 1 for 1) between '\xa0'::bytea and '\xbf'::bytea),
  constraint member_passkeys_counter
    check (counter between 0 and 4294967295),
  -- The transports WebAuthn names, nothing else, at most seven.
  constraint member_passkeys_transports
    check (transports <@ array['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']::text[]
           and cardinality(transports) <= 7),
  -- A passkey that is backed up can be backed up.
  constraint member_passkeys_backup_flags
    check (backup_eligible or not backed_up),
  -- The device checked it was the member (face, fingerprint or device PIN)
  -- when the passkey was made. A row without that cannot exist.
  constraint member_passkeys_user_verified
    check (user_verified_at_registration),
  -- A host name in lower case: stockpilotusa.com in production, localhost
  -- on a developer's machine and in the lab.
  constraint member_passkeys_rp_id
    check (rp_id ~ '^[a-z0-9.-]{1,253}$'),
  -- The member's name for it: letters, digits, spaces and ( ) + ' _ - only,
  -- 1 to 60 characters, no space at either end. No control or invisible
  -- character, no markup, and no dot, so no site name or link can be
  -- written in it. No email is to print it (the plan's rule for the app's
  -- security emails, which say "a passkey"; the app's tests pin it).
  constraint member_passkeys_name
    check (name ~ '^[A-Za-z0-9 ()+''_-]{1,60}$' and name = btrim(name)),
  -- Who removed it: the member, a recovery code, a set-up that failed, or
  -- the operator's support procedure. There is no organization admin reset.
  constraint member_passkeys_removed_reason
    check (removed_reason in ('member', 'recovery_code', 'setup_failed', 'support')),
  -- A removal has its reason; an active passkey has neither.
  constraint member_passkeys_removed_with_reason
    check ((removed_at is null) = (removed_reason is null)),
  constraint member_passkeys_last_used_after_added
    check (last_used_at is null or last_used_at >= created_at)
);

-- An account's passkeys, newest first (my_passkeys, the counts in the
-- functions); also serves the cascade from user_profiles.
create index member_passkeys_user_created_idx
  on public.member_passkeys (user_id, created_at desc);

-- The purge reads removed rows, oldest first.
create index member_passkeys_removed_idx
  on public.member_passkeys (removed_at)
  where removed_at is not null;

comment on table public.member_passkeys is
  'One row per passkey a member added as their second step: credential id and public key (never returned to a member), signature counter, transports, backup flags, the site it was made for (rp_id), the member''s name for it, when it was added, last used and removed. A removed row is kept until the purge (90 days) so a removal stopped half way can be finished. No device model, no attestation. Written by the app''s server through passkey_register() and the removal functions, and directly only for a use (counter, last_used_at, backed_up) and a new name; read by the member through my_passkeys().';
comment on column public.member_passkeys.credential_id is
  'The WebAuthn credential id, base64url without padding, 16 to 1023 bytes. Unique across all accounts. Never returned to a member.';
comment on column public.member_passkeys.public_key is
  'The COSE public key the passkey signs with (a CBOR map: the first byte is 0xA0 to 0xBF). Never returned to a member.';
comment on column public.member_passkeys.counter is
  'The signature counter last seen. A passkey that reports a counter that does not go up (when either is above 0) is refused by the server: a sign of a copied key. Synced passkeys report 0.';
comment on column public.member_passkeys.rp_id is
  'The site the passkey was made for. Production reads only rows of stockpilotusa.com.';
comment on column public.member_passkeys.removed_at is
  'When it was removed (removed_reason: member, recovery_code, setup_failed or support). A removed passkey is never accepted.';

-- ── 2. passkey_bridges ───────────────────────────────────────────────────────
create table public.passkey_bridges (
  user_id            uuid        primary key references public.user_profiles(id) on delete cascade,
  -- The id of the bridge factor at Supabase Auth. No foreign key: a key to
  -- an auth table would lock a sign-in table when this file is applied. The
  -- functions that write it check it against auth.mfa_factors instead.
  factor_id          uuid        not null,
  secret_ciphertext  text        not null,
  key_version        smallint    not null,
  created_at         timestamptz not null default now(),
  constraint passkey_bridges_factor_id_key unique (factor_id),
  constraint passkey_bridges_key_version
    check (key_version between 1 and 999),
  -- "v<key version>.<iv>.<ciphertext>.<tag>", base64url without padding: a
  -- 12-byte IV, the ciphertext, a 16-byte GCM tag. Never a plain secret.
  constraint passkey_bridges_secret_ciphertext
    check (secret_ciphertext ~ '^v[0-9]{1,3}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16,200}\.[A-Za-z0-9_-]{22}$'
           and split_part(secret_ciphertext, '.', 1) = 'v' || key_version::text)
);

comment on table public.passkey_bridges is
  'One row per passkey holder: the id of the account''s hidden bridge factor at Supabase Auth and its secret, encrypted by the app (AES-256-GCM with a dedicated key that is not in the database; key_version says which). The server answers the bridge only after a passkey of the same account passed its check. A row exists only while the account has an active passkey. service_role reads it; written only through passkey_register() (insert), passkey_replace_bridge() (compare and swap) and the removal functions (delete). The two that store a factor id refuse one that is not a reserved-name TOTP factor of the same account.';
comment on column public.passkey_bridges.secret_ciphertext is
  'The bridge factor''s secret, encrypted by the app: v<key version>.<iv>.<ciphertext>.<tag>, base64url. A copy of this table holds nothing usable without the app''s key. (Supabase Auth keeps its own copy of the same secret, as it does for every authenticator app.)';
comment on column public.passkey_bridges.created_at is
  'When the row was last written: made by passkey_register(), or rewritten by passkey_replace_bridge() (a repair or a new key version). Not when the factor was made at Supabase Auth.';

-- ── 3. passkey_challenges ────────────────────────────────────────────────────
create table public.passkey_challenges (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null references public.user_profiles(id) on delete cascade,
  -- The Auth session the ceremony was started for. No foreign key (as
  -- above); the server spends the challenge only for this session.
  session_id    uuid        not null,
  purpose       text        not null,
  challenge     text        not null,
  binding_hash  text        not null,
  rp_id         text        not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  used_at       timestamptz,
  constraint passkey_challenges_challenge_key unique (challenge),
  constraint passkey_challenges_purpose
    check (purpose in ('second_step', 'password_reset', 'register', 'confirm_add', 'finish_setup')),
  -- 32 random bytes, base64url without padding.
  constraint passkey_challenges_challenge
    check (challenge ~ '^[A-Za-z0-9_-]{43}$'),
  -- The SHA-256 (lower-case hex) of the cookie only that browser holds.
  constraint passkey_challenges_binding_hash
    check (binding_hash ~ '^[0-9a-f]{64}$'),
  constraint passkey_challenges_rp_id
    check (rp_id ~ '^[a-z0-9.-]{1,253}$'),
  -- At most 5 minutes; issue_passkey_challenge() sets 2.
  constraint passkey_challenges_lifetime
    check (expires_at > created_at and expires_at <= created_at + interval '5 minutes'),
  constraint passkey_challenges_used_after_created
    check (used_at is null or used_at >= created_at)
);

-- An account's challenges (issue_passkey_challenge's clean-up and count);
-- also serves the cascade from user_profiles.
create index passkey_challenges_user_created_idx
  on public.passkey_challenges (user_id, created_at);

-- The purge reads ended challenges, oldest first.
create index passkey_challenges_expires_idx
  on public.passkey_challenges (expires_at);

comment on table public.passkey_challenges is
  'One row per passkey ceremony the server starts: the account, the Auth session, the purpose, the challenge, the SHA-256 of a cookie only that browser holds, the site, when it ends (at most 5 minutes) and when it was spent. Issued by issue_passkey_challenge(), spent once by take_passkey_challenge(), removed by purge_passkey_records() a day after it ends. service_role only.';

-- ── 4. organization_passkey_switches ─────────────────────────────────────────
create table public.organization_passkey_switches (
  organization_id  uuid        primary key references public.organizations(id) on delete cascade,
  switched_on_at   timestamptz not null default now()
);

comment on table public.organization_passkey_switches is
  'One row per organization that has passkeys switched on (a row means on). Written by service_role only (the platform console, a later stage). A member may add a passkey only when every organization they belong to has a row here; a passkey belongs to the account, so once added it works in all of them. service_role only.';

-- ── RLS and privileges ───────────────────────────────────────────────────────
-- RLS on and no policy: no API role but service_role (which bypasses row
-- security) reads a row directly.
alter table public.member_passkeys enable row level security;
alter table public.passkey_bridges enable row level security;
alter table public.passkey_challenges enable row level security;
alter table public.organization_passkey_switches enable row level security;

-- Supabase's default privileges give anon, authenticated and service_role
-- every privilege on a new public table; the change Supabase set for
-- 2026-10-30 (0402's note) takes SELECT, INSERT, UPDATE and DELETE out of
-- them. Everything is revoked from all of them here, then service_role gets
-- back by name only what the server needs, so the tables end the same under
-- either set of defaults.
revoke all on table public.member_passkeys from public, anon, authenticated, service_role;
grant select on table public.member_passkeys to service_role;
-- A use (counter, when, the backup flag the device reports now) and a new
-- name. Nothing else is written directly.
grant update (counter, last_used_at, backed_up, name) on table public.member_passkeys to service_role;

revoke all on table public.passkey_bridges from public, anon, authenticated, service_role;
grant select on table public.passkey_bridges to service_role;

revoke all on table public.passkey_challenges from public, anon, authenticated, service_role;
grant select on table public.passkey_challenges to service_role;

revoke all on table public.organization_passkey_switches from public, anon, authenticated, service_role;
grant select, insert, delete on table public.organization_passkey_switches to service_role;

-- ── 5. The three platform settings ───────────────────────────────────────────
-- On the platform's one settings row (0241: RLS on with no policy). 0402
-- restated its grants, which give anon and authenticated every privilege on
-- the table; they reach no row through row security, and this file changes
-- none of them (the preflight checks row security is on and no policy
-- exists; the test checks a member and a signed-out caller can neither read
-- nor change the row). No row, or a column false: off. The row may not
-- exist, so whoever switches upserts it.
alter table public.platform_settings
  add column passkeys_on boolean not null default false,
  add column passkey_adds_on boolean not null default false,
  add column passkey_check_ends_sessions boolean not null default false;

comment on column public.platform_settings.passkeys_on is
  'The platform-wide passkey kill switch (default false). Off, or no settings row: no passkey step is offered or accepted anywhere and no passkey can be added. Read by passkey_add_allowed(), passkey_register() and take_passkey_challenge(). Row security with no policy keeps every API role but service_role from the row; written by service_role only (the platform console, a later stage).';
comment on column public.platform_settings.passkey_adds_on is
  'The platform-wide "new passkeys" switch (default false). Off, or no settings row: no passkey can be added; passkeys that exist keep working while passkeys_on is on. Lets a fault in adding be stopped without locking passkey holders out. Read by passkey_add_allowed() and passkey_register(); written by service_role only (the platform console, a later stage).';
comment on column public.platform_settings.passkey_check_ends_sessions is
  'Whether the server''s check of bridge-raised sessions ends a session it cannot explain (default false). Off, or no settings row: it reports the session and ends nothing. On: it also ends that one session through passkey_end_bridge_session(). Turning it on affects raises found from then on: one reported while it was off is not ended later. Read by the server only; written by service_role only (the platform console, a later stage).';

-- ── 6. Functions ─────────────────────────────────────────────────────────────

-- Private: is this factor a TOTP factor of this account carrying the
-- reserved bridge name? Only the bridge functions below call it (as their
-- owner); no API role may.
create function public._passkey_bridge_factor_ok(p_user_id uuid, p_factor_id uuid)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
begin
  -- plpgsql, not sql: a sql body is resolved when it is created, which would
  -- lock auth.mfa_factors while this file runs.
  return exists (
    select 1 from auth.mfa_factors f
     where f.id = p_factor_id
       and f.user_id = p_user_id
       and f.factor_type = 'totp'
       and left(coalesce(f.friendly_name, ''), 18) = 'sp-passkey-bridge-'
  );
end;
$$;

revoke all on function public._passkey_bridge_factor_ok(uuid, uuid) from public, anon, authenticated, service_role;

comment on function public._passkey_bridge_factor_ok(uuid, uuid) is
  'True when the factor is a TOTP factor of the account at Supabase Auth whose name starts with the reserved sp-passkey-bridge-. Used by passkey_register() and passkey_replace_bridge() to refuse anything else as a bridge, and by passkey_end_bridge_session() to refuse any other session. No API role may call it.';

-- The member's own active passkeys, with no key material.
create function public.my_passkeys()
returns table (
  id               uuid,
  name             text,
  created_at       timestamptz,
  last_used_at     timestamptz,
  backup_eligible  boolean,
  backed_up        boolean,
  transports       text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
begin
  -- The gate, in this body (security_invariants INV-25 reads it here): the
  -- signed-in account, and only its own rows.
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'passkeys_not_allowed' using errcode = '42501';
  end if;
  -- A disabled account is closed (0310), before the authenticator gate, so
  -- a disabled caller learns nothing from its hint.
  if exists (select 1 from public.user_profiles up
              where up.id = v_uid and up.disabled_at is not null) then
    raise exception 'passkeys_not_allowed' using errcode = '42501';
  end if;
  -- The part of the app's authenticator rule that needs no organization
  -- (0474's): an account with a verified factor (an authenticator app or a
  -- bridge) reads only from a session that holds the second step.
  if exists (select 1 from auth.mfa_factors f
              where f.user_id = v_uid and f.status = 'verified')
     and coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then
    raise exception 'aal2_required' using errcode = '42501', hint = 'aal2_required';
  end if;

  return query
    select p.id, p.name, p.created_at, p.last_used_at, p.backup_eligible, p.backed_up,
           p.transports
      from public.member_passkeys p
     where p.user_id = v_uid
       and p.removed_at is null
     order by p.created_at desc, p.id
     limit 20;
end;
$$;

-- Supabase's default privileges grant EXECUTE on a new public function to
-- anon, authenticated and service_role, and Postgres grants it to PUBLIC.
revoke all on function public.my_passkeys() from public, anon, authenticated, service_role;
grant execute on function public.my_passkeys() to authenticated;

comment on function public.my_passkeys() is
  'The signed-in member''s own active passkeys, newest first, at most 20: id, name, when added and last used, backup flags, transports. Never the credential id, the public key, the counter or the site. 42501 when nobody is signed in or the account is disabled, and 42501 aal2_required when the account has a verified authenticator and the session does not hold the second step.';

-- Why an account may or may not add a passkey now, as one word.
create function public.passkey_add_allowed(p_user_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_user_id is null
     or not exists (select 1 from public.user_profiles up where up.id = p_user_id) then
    return 'no_profile';
  end if;
  if exists (select 1 from public.user_profiles up
              where up.id = p_user_id and up.disabled_at is not null) then
    return 'disabled';
  end if;
  -- The kill switch, then the "new passkeys" switch: no settings row, or a
  -- column false, is off.
  if not coalesce((select s.passkeys_on from public.platform_settings s where s.id), false) then
    return 'kill_switch_off';
  end if;
  if not coalesce((select s.passkey_adds_on from public.platform_settings s where s.id), false) then
    return 'adds_off';
  end if;
  -- Memberships are the accepted ones that are not act-as seats (0413's and
  -- 0474's rule): an invitation not accepted and an act-as seat count for
  -- nothing here.
  if not exists (select 1 from public.organization_members m
                  where m.user_id = p_user_id
                    and m.accepted_at is not null
                    and m.impersonation_expires_at is null) then
    return 'no_membership';
  end if;
  if exists (select 1 from public.organization_members m
              where m.user_id = p_user_id
                and m.accepted_at is not null
                and m.impersonation_expires_at is null
                and not exists (select 1 from public.organization_passkey_switches s
                                 where s.organization_id = m.organization_id)) then
    return 'organization_off';
  end if;
  if (select count(*) from public.member_passkeys p
       where p.user_id = p_user_id and p.removed_at is null) >= 10 then
    return 'too_many';
  end if;
  return 'ok';
end;
$$;

revoke all on function public.passkey_add_allowed(uuid) from public, anon, authenticated, service_role;
grant execute on function public.passkey_add_allowed(uuid) to service_role;

comment on function public.passkey_add_allowed(uuid) is
  'Whether an account may add a passkey now, as one word: ok, no_profile, disabled, kill_switch_off, adds_off (the "new passkeys" switch), no_membership (no accepted membership that is not an act-as seat), organization_off (one of its organizations has passkeys off) or too_many (10 active). The platform console allowlist lives in the app and is checked there. service_role only.';

-- A new passkey row, and a new bridge row when the account has none.
create function public.passkey_register(
  p_user_id            uuid,
  p_credential_id      text,
  p_public_key         bytea,
  p_counter            bigint,
  p_transports         text[],
  p_backup_eligible    boolean,
  p_backed_up          boolean,
  p_name               text,
  p_rp_id              text,
  p_factor_id          uuid,
  p_secret_ciphertext  text,
  p_key_version        smallint
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_id     uuid;
begin
  if p_user_id is null then
    raise exception 'passkey_not_allowed' using errcode = '42501', hint = 'no_profile';
  end if;
  -- One registration (or removal) of an account at a time, so the cap of 10,
  -- "the account has a bridge" and "the last passkey" are exact. FOR NO KEY
  -- UPDATE does not block rows that point at the profile being inserted
  -- elsewhere.
  perform 1 from public.user_profiles up where up.id = p_user_id for no key update;
  if not found then
    raise exception 'passkey_not_allowed' using errcode = '42501', hint = 'no_profile';
  end if;
  -- The rule again, inside this transaction: it may have changed since the
  -- ceremony started.
  v_reason := public.passkey_add_allowed(p_user_id);
  if v_reason <> 'ok' then
    raise exception 'passkey_not_allowed' using errcode = '42501', hint = v_reason;
  end if;

  -- The bridge: all three values to add the account's first bridge row (only
  -- when it has none: a row is never overwritten here, so two registrations
  -- in two tabs cannot leave a bridge whose secret is lost), none to keep the
  -- account's present one (which must exist). Replacing a bridge is
  -- passkey_replace_bridge()'s job alone.
  if p_factor_id is null and p_secret_ciphertext is null and p_key_version is null then
    if not exists (select 1 from public.passkey_bridges b where b.user_id = p_user_id) then
      raise exception 'passkey_bridge_missing' using errcode = '55000';
    end if;
  elsif p_factor_id is not null and p_secret_ciphertext is not null and p_key_version is not null then
    if exists (select 1 from public.passkey_bridges b where b.user_id = p_user_id) then
      raise exception 'passkey_bridge_exists' using errcode = '55000';
    end if;
    if not public._passkey_bridge_factor_ok(p_user_id, p_factor_id) then
      raise exception 'passkey_bridge_not_ours' using errcode = '22023';
    end if;
    insert into public.passkey_bridges (user_id, factor_id, secret_ciphertext, key_version)
    values (p_user_id, p_factor_id, p_secret_ciphertext, p_key_version);
  else
    raise exception 'passkey_bridge_incomplete' using errcode = '22023';
  end if;

  insert into public.member_passkeys
    (user_id, credential_id, public_key, counter, transports, backup_eligible, backed_up,
     user_verified_at_registration, rp_id, name)
  values
    (p_user_id, p_credential_id, p_public_key, coalesce(p_counter, 0), coalesce(p_transports, '{}'::text[]),
     p_backup_eligible, p_backed_up, true, p_rp_id, p_name)
  returning member_passkeys.id into v_id;

  return v_id;
end;
$$;

revoke all on function public.passkey_register(uuid, text, bytea, bigint, text[], boolean, boolean, text, text, uuid, text, smallint)
  from public, anon, authenticated, service_role;
grant execute on function public.passkey_register(uuid, text, bytea, bigint, text[], boolean, boolean, text, text, uuid, text, smallint)
  to service_role;

comment on function public.passkey_register(uuid, text, bytea, bigint, text[], boolean, boolean, text, text, uuid, text, smallint) is
  'Stores a passkey the server has verified (user verification required), in one transaction under a lock on the account''s profile row: re-checks passkey_add_allowed() (42501 passkey_not_allowed, the reason as hint); with all three bridge values, adds the account''s first bridge row (55000 passkey_bridge_exists when it has one; 22023 passkey_bridge_not_ours when the factor is not a reserved-name TOTP factor of the account), with none of them keeps the present one (55000 passkey_bridge_missing when there is none); a credential id already stored anywhere is refused (23505). Returns the new passkey''s id. service_role only.';

-- A new challenge for a ceremony, by the database clock.
create function public.issue_passkey_challenge(
  p_user_id       uuid,
  p_session_id    uuid,
  p_purpose       text,
  p_challenge     text,
  p_binding_hash  text,
  p_rp_id         text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_user_id is null or p_session_id is null then
    raise exception 'passkey_challenge_refused' using errcode = '22023';
  end if;
  -- The account's spent and ended challenges go now, so the table stays
  -- small between purges.
  delete from public.passkey_challenges c
   where c.user_id = p_user_id
     and (c.used_at is not null or c.expires_at <= pg_catalog.now());
  -- About 10 live at once per account (the app's own limiter comes first;
  -- this bounds the table if it ever does not). Not exact: no lock is
  -- taken, so two calls at the same moment can both count 9.
  if (select count(*) from public.passkey_challenges c where c.user_id = p_user_id) >= 10 then
    raise exception 'passkey_challenges_busy' using errcode = '54000';
  end if;
  insert into public.passkey_challenges
    (user_id, session_id, purpose, challenge, binding_hash, rp_id, created_at, expires_at)
  values
    (p_user_id, p_session_id, p_purpose, p_challenge, p_binding_hash, p_rp_id,
     pg_catalog.now(), pg_catalog.now() + interval '2 minutes')
  returning passkey_challenges.id into v_id;
  return v_id;
end;
$$;

revoke all on function public.issue_passkey_challenge(uuid, uuid, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.issue_passkey_challenge(uuid, uuid, text, text, text, text) to service_role;

comment on function public.issue_passkey_challenge(uuid, uuid, text, text, text, text) is
  'Stores a new ceremony challenge for an account, its Auth session, a purpose, the SHA-256 of the browser''s binding cookie and the site, ending 2 minutes from now by the database clock; first deletes the account''s spent and ended challenges; refuses one when the account already holds 10 live (54000 passkey_challenges_busy; two calls at the same moment can both pass the count, so the bound is about 10, not exact). Returns its id. service_role only.';

-- Spends a challenge that matches all five of its bindings, or nothing.
create function public.take_passkey_challenge(
  p_id            uuid,
  p_user_id       uuid,
  p_session_id    uuid,
  p_purpose       text,
  p_binding_hash  text
)
returns table (challenge text, rp_id text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  -- The kill switch, read here as well as by the server: while it is off no
  -- ceremony is accepted, so no passkey answer can raise a session even if
  -- a server path forgot to read it. The challenge stays unspent.
  if not coalesce((select s.passkeys_on from public.platform_settings s where s.id), false) then
    raise exception 'passkey_not_allowed' using errcode = '42501', hint = 'kill_switch_off';
  end if;
  -- One statement: two calls at the same moment cannot both spend it.
  return query
    update public.passkey_challenges c
       set used_at = pg_catalog.now()
     where c.id = p_id
       and c.user_id = p_user_id
       and c.session_id = p_session_id
       and c.purpose = p_purpose
       and c.binding_hash = p_binding_hash
       and c.used_at is null
       and c.expires_at > pg_catalog.now()
    returning c.challenge, c.rp_id;
end;
$$;

revoke all on function public.take_passkey_challenge(uuid, uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.take_passkey_challenge(uuid, uuid, uuid, text, text) to service_role;

comment on function public.take_passkey_challenge(uuid, uuid, uuid, text, text) is
  'Spends the challenge with this id when its account, Auth session, purpose and binding hash all match and it is unspent and not ended (database clock), returning its challenge and site; otherwise returns no row and changes nothing. A spent challenge never returns again. While the kill switch (platform_settings.passkeys_on) is off it spends nothing and raises 42501 passkey_not_allowed, hint kill_switch_off. service_role only.';

-- Removes one passkey (soft); the last one takes the bridge row with it.
create function public.passkey_mark_removed(
  p_user_id     uuid,
  p_passkey_id  uuid,
  p_reason      text
)
returns table (removed boolean, active_left integer, bridge_factor_id uuid, bridge_dropped boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count   integer;
  v_left    integer;
  v_factor  uuid;
  v_dropped boolean := false;
begin
  if p_reason is null or p_reason not in ('member', 'setup_failed', 'support') then
    raise exception 'passkey_removal_refused' using errcode = '22023';
  end if;
  perform 1 from public.user_profiles up where up.id = p_user_id for no key update;
  update public.member_passkeys p
     set removed_at = pg_catalog.now(), removed_reason = p_reason
   where p.id = p_passkey_id
     and p.user_id = p_user_id
     and p.removed_at is null;
  get diagnostics v_count = row_count;
  select count(*)::integer into v_left from public.member_passkeys a
   where a.user_id = p_user_id and a.removed_at is null;
  if v_count = 1 and v_left = 0 then
    -- This call removed the last active passkey: the bridge row goes in this
    -- same transaction, so no other request can find it and keep it. The
    -- server removes the factor at Supabase next. A call that removed
    -- nothing never deletes a bridge row, even when no passkey is active (a
    -- bridge row with no active passkey is a state for passkey_drop_bridge(),
    -- which names the factor, and the health list).
    delete from public.passkey_bridges b where b.user_id = p_user_id
    returning b.factor_id into v_factor;
    v_dropped := v_factor is not null;
  else
    select b.factor_id into v_factor from public.passkey_bridges b where b.user_id = p_user_id;
  end if;
  return query select v_count = 1, v_left, v_factor, v_dropped;
end;
$$;

revoke all on function public.passkey_mark_removed(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.passkey_mark_removed(uuid, uuid, text) to service_role;

comment on function public.passkey_mark_removed(uuid, uuid, text) is
  'Removes one active passkey of the account (reason member, setup_failed or support; 22023 otherwise) under a lock on its profile row. When it removed the last active passkey it deletes the bridge row in the same transaction. Answers whether it removed one (false for another account''s passkey or one already removed), how many are left, the bridge factor id (the deleted row''s when it was dropped) and whether it was dropped, so the server removes that factor at Supabase next. A call that removed nothing changes nothing: it never drops a bridge row, even when no passkey is active (that state is passkey_drop_bridge()''s, which names the factor). service_role only.';

-- Removes every passkey of an account and its bridge row.
create function public.passkey_remove_all(p_user_id uuid, p_reason text)
returns table (removed integer, bridge_factor_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count  integer;
  v_factor uuid;
begin
  if p_reason is null or p_reason not in ('recovery_code', 'support') then
    raise exception 'passkey_removal_refused' using errcode = '22023';
  end if;
  perform 1 from public.user_profiles up where up.id = p_user_id for no key update;
  update public.member_passkeys p
     set removed_at = pg_catalog.now(), removed_reason = p_reason
   where p.user_id = p_user_id
     and p.removed_at is null;
  get diagnostics v_count = row_count;
  delete from public.passkey_bridges b where b.user_id = p_user_id
  returning b.factor_id into v_factor;
  return query select v_count, v_factor;
end;
$$;

revoke all on function public.passkey_remove_all(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.passkey_remove_all(uuid, text) to service_role;

comment on function public.passkey_remove_all(uuid, text) is
  'Removes every active passkey of the account (reason recovery_code or support; 22023 otherwise) and deletes its bridge row, in one transaction under a lock on its profile row; answers how many and the deleted bridge''s factor id, which the server removes at Supabase next. service_role only.';

-- Spends a recovery code and, only then, removes every passkey and the
-- bridge row: one transaction.
create function public.consume_recovery_code_with_passkeys(p_user_id uuid, p_code text)
returns table (consumed boolean, passkeys_removed integer, bridge_factor_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_canonical text;
  v_legacy    text;
  v_code_id   uuid;
  v_count     integer := 0;
  v_factor    uuid;
begin
  if p_user_id is null then
    raise exception 'recovery_code_refused' using errcode = '22023';
  end if;
  if p_code is null or length(trim(p_code)) = 0 then
    return query select false, 0, null::uuid;
    return;
  end if;
  perform 1 from public.user_profiles up where up.id = p_user_id for no key update;
  -- The same two forms consume_mfa_recovery_code (0103) accepts: the
  -- canonical one (letters and digits, upper case) and the legacy one (upper
  -- case, trimmed, dashes kept).
  v_canonical := pg_catalog.encode(extensions.digest(
                   pg_catalog.regexp_replace(pg_catalog.upper(p_code), '[^A-Z0-9]', '', 'g'), 'sha256'), 'hex');
  v_legacy := pg_catalog.encode(extensions.digest(pg_catalog.upper(pg_catalog.btrim(p_code)), 'sha256'), 'hex');
  select c.id into v_code_id
    from public.mfa_recovery_codes c
   where c.user_id = p_user_id
     and c.used_at is null
     and (c.code_hash = v_canonical or c.code_hash = v_legacy)
   order by c.created_at, c.id
   limit 1
   for update;
  if v_code_id is null then
    return query select false, 0, null::uuid;
    return;
  end if;
  update public.mfa_recovery_codes c set used_at = pg_catalog.now() where c.id = v_code_id;

  update public.member_passkeys p
     set removed_at = pg_catalog.now(), removed_reason = 'recovery_code'
   where p.user_id = p_user_id
     and p.removed_at is null;
  get diagnostics v_count = row_count;
  delete from public.passkey_bridges b where b.user_id = p_user_id
  returning b.factor_id into v_factor;
  return query select true, v_count, v_factor;
end;
$$;

revoke all on function public.consume_recovery_code_with_passkeys(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.consume_recovery_code_with_passkeys(uuid, text) to service_role;

comment on function public.consume_recovery_code_with_passkeys(uuid, text) is
  'Spends one unused recovery code of the account (the forms consume_mfa_recovery_code accepts) and, only when one matched, marks every active passkey removed (recovery_code) and deletes the bridge row, all in one transaction under a lock on the profile row. Answers whether a code was spent, how many passkeys were removed and the deleted bridge''s factor id. For the app''s server only, after it checked the member''s password: service_role only, never authenticated.';

-- Puts a new bridge in place of the one expected (compare and swap), never
-- a verified bridge for one that is not verified.
create function public.passkey_replace_bridge(
  p_user_id            uuid,
  p_old_factor_id      uuid,
  p_new_factor_id      uuid,
  p_secret_ciphertext  text,
  p_key_version        smallint
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_user_id is null or p_new_factor_id is null or p_secret_ciphertext is null
     or p_key_version is null then
    raise exception 'passkey_bridge_incomplete' using errcode = '22023';
  end if;
  -- One change of an account's passkeys or bridge at a time (the lock every
  -- writer here takes first).
  perform 1 from public.user_profiles up where up.id = p_user_id for no key update;
  -- A bridge serves passkeys: none active, no bridge.
  if not exists (select 1 from public.member_passkeys p
                  where p.user_id = p_user_id and p.removed_at is null) then
    raise exception 'passkey_none_active' using errcode = '55000';
  end if;
  if not public._passkey_bridge_factor_ok(p_user_id, p_new_factor_id) then
    raise exception 'passkey_bridge_not_ours' using errcode = '22023';
  end if;
  -- A verified bridge is replaced only by a verified one (the server answers
  -- the new factor before it swaps), so a swap stopped half way never leaves
  -- the account with an unverified bridge where a verified one stood. The
  -- same factor (a new key version) passes as it is, and a bridge that is
  -- not verified, or gone, may be replaced by any factor of ours.
  if p_old_factor_id is not null
     and exists (select 1 from auth.mfa_factors f
                  where f.id = p_old_factor_id and f.user_id = p_user_id and f.status = 'verified')
     and not exists (select 1 from auth.mfa_factors f
                      where f.id = p_new_factor_id and f.user_id = p_user_id and f.status = 'verified') then
    raise exception 'passkey_bridge_not_verified' using errcode = '55000';
  end if;
  if p_old_factor_id is null then
    -- Expected: no bridge row yet (a set-up not finished).
    insert into public.passkey_bridges (user_id, factor_id, secret_ciphertext, key_version)
    values (p_user_id, p_new_factor_id, p_secret_ciphertext, p_key_version)
    on conflict (user_id) do nothing;
  else
    update public.passkey_bridges b
       set factor_id = p_new_factor_id,
           secret_ciphertext = p_secret_ciphertext,
           key_version = p_key_version,
           created_at = pg_catalog.now()
     where b.user_id = p_user_id
       and b.factor_id = p_old_factor_id;
  end if;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

revoke all on function public.passkey_replace_bridge(uuid, uuid, uuid, text, smallint)
  from public, anon, authenticated, service_role;
grant execute on function public.passkey_replace_bridge(uuid, uuid, uuid, text, smallint) to service_role;

comment on function public.passkey_replace_bridge(uuid, uuid, uuid, text, smallint) is
  'Puts a new bridge in place for an account that has an active passkey, under a lock on its profile row: when p_old_factor_id is null, only if the account has no bridge row (a set-up not finished); otherwise only if its bridge is that factor (a repair, or a new key version for the same factor, with the old and new factor the same). Returns false and changes nothing when the expectation does not hold; 55000 passkey_none_active when the account has no active passkey; 55000 passkey_bridge_not_verified when a verified factor would be replaced by another that is not verified; 22023 when a value is missing or the new factor is not a reserved-name TOTP factor of the account. The row''s created_at becomes now (when it was last written). service_role only.';

-- Deletes the account's bridge row if it is the factor named and no passkey
-- is active.
create function public.passkey_drop_bridge(p_user_id uuid, p_factor_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  -- The account lock, so no registration can add a passkey between the check
  -- below and the delete.
  perform 1 from public.user_profiles up where up.id = p_user_id for no key update;
  if exists (select 1 from public.member_passkeys p
              where p.user_id = p_user_id and p.removed_at is null) then
    raise exception 'passkey_still_active' using errcode = '55000';
  end if;
  delete from public.passkey_bridges b
   where b.user_id = p_user_id
     and b.factor_id = p_factor_id;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

revoke all on function public.passkey_drop_bridge(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.passkey_drop_bridge(uuid, uuid) to service_role;

comment on function public.passkey_drop_bridge(uuid, uuid) is
  'Deletes the account''s bridge row when its factor id is the one named, under a lock on its profile row; refuses (55000 passkey_still_active) while the account has an active passkey. Returns whether it deleted one. service_role only.';

-- ── Reads for the server's checks ────────────────────────────────────────────
-- Every account whose passkeys, bridge row and reserved-name factors at
-- Supabase are not healthy, for the sweep, the console's lists and the check
-- after a restore. Healthy: at least one active passkey of the site, a
-- bridge row whose factor is a verified reserved-name TOTP factor of the
-- account, and no other reserved-name factor. The states, first match wins:
--   reserved_factor_without_row    a verified reserved-name factor that is
--                                  not the bridge row's, while the account
--                                  has an active passkey or a bridge row
--   bridge_newer_than_removal      no active passkey, removed rows, and a
--                                  verified reserved-name factor (the bridge
--                                  row's, or one with no row) made AFTER the
--                                  newest removal
--   removal_unfinished             a verified reserved-name factor, no bridge
--                                  row, no active passkey, removed rows, and
--                                  every such factor made no later than the
--                                  newest removal
--   bridge_without_passkey         a verified reserved-name factor, or a
--                                  bridge row, and never a passkey row
--   bridge_row_without_passkey     a bridge row and no active passkey (its
--                                  factor verified and made no later than the
--                                  newest removal, or not verified, or gone)
--   other_site_only                active passkeys only for another site
--   no_bridge                      active passkeys, no bridge row (a set-up
--                                  not finished: no step owed)
--   bridge_factor_missing          a bridge row whose factor is gone
--   bridge_factor_unverified       a bridge row whose factor is not verified
--   unverified_reserved_factor     an unverified reserved-name factor that is
--                                  not the bridge row's (a set-up in flight,
--                                  or left over)
-- Why the time: a factor that served a passkey was made before that passkey
-- was removed, so in a removal that stopped half way every verified
-- reserved-name factor is older than the newest removal. A verified one made
-- after it served a passkey these rows do not hold: a restore of public
-- older than auth, which lost the member's live passkey. That state is
-- never finished automatically (it fails closed, as a bridge with no
-- passkey does). The factor's time is Auth's clock and the removal's the
-- database's. With Auth's clock ahead, a removal stopped half way can read
-- as the closed state. With it behind by more than the time between a
-- removal and the member's next passkey, a restore could read as the open
-- one; the two clocks would have to differ by seconds. The hosted platform
-- keeps them on one clock as far as we know; that is not proven. Whether
-- such a factor exists is asked on its own (exists), never through its
-- time, and a verified factor or bridge with no time at all is read as
-- made after the removal (closed): Auth always sets the time, but the
-- list must not miss a factor if it ever did not.
-- One word can cover several cases, so callers branch on the returned
-- facts, not on the word alone: reserved_factor_without_row is a factor with
-- no row beside an active passkey when bridge_factor_id is null, a row whose
-- factor is gone (bridge_factor_status null) or not verified next to another
-- verified one, and a healthy bridge with a second verified reserved-name
-- factor beside it (bridge_factor_status verified); bridge_row_without_passkey
-- is told apart by bridge_factor_status in the same way.
-- Returns no secret and no key: ids, counts, statuses and times only.
create function public.passkey_account_states(p_rp_id text)
returns table (
  user_id                   uuid,
  state                     text,
  active_passkeys           integer,
  other_site_passkeys       integer,
  removed_passkeys          integer,
  last_removed_at           timestamptz,
  bridge_factor_id          uuid,
  bridge_factor_status      text,
  bridge_factor_created_at  timestamptz,
  reserved_factors          jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- Without a site every passkey would count as another site's.
  if p_rp_id is null or p_rp_id !~ '^[a-z0-9.-]{1,253}$' then
    raise exception 'passkey_site_required' using errcode = '22023';
  end if;
  return query
  with accounts as (
    select p.user_id from public.member_passkeys p
    union
    select b.user_id from public.passkey_bridges b
    union
    select f.user_id from auth.mfa_factors f
     where f.factor_type = 'totp'
       and left(coalesce(f.friendly_name, ''), 18) = 'sp-passkey-bridge-'
  ),
  facts as (
    select a.user_id,
           (select count(*)::integer from public.member_passkeys p
             where p.user_id = a.user_id and p.removed_at is null and p.rp_id = p_rp_id) as active,
           (select count(*)::integer from public.member_passkeys p
             where p.user_id = a.user_id and p.removed_at is null and p.rp_id <> p_rp_id) as other_site,
           (select count(*)::integer from public.member_passkeys p
             where p.user_id = a.user_id and p.removed_at is not null) as removed,
           (select max(p.removed_at) from public.member_passkeys p
             where p.user_id = a.user_id) as last_removed,
           b.factor_id as bridge_id,
           bf.status as bridge_status,
           bf.created_at as bridge_created,
           exists (select 1 from auth.mfa_factors f
                    where f.user_id = a.user_id and f.factor_type = 'totp' and f.status = 'verified'
                      and left(coalesce(f.friendly_name, ''), 18) = 'sp-passkey-bridge-'
                      and f.id is distinct from b.factor_id) as has_other_verified,
           (select max(f.created_at) from auth.mfa_factors f
             where f.user_id = a.user_id and f.factor_type = 'totp' and f.status = 'verified'
               and left(coalesce(f.friendly_name, ''), 18) = 'sp-passkey-bridge-'
               and f.id is distinct from b.factor_id) as newest_other_verified,
           exists (select 1 from auth.mfa_factors f
                    where f.user_id = a.user_id and f.factor_type = 'totp' and f.status = 'verified'
                      and left(coalesce(f.friendly_name, ''), 18) = 'sp-passkey-bridge-'
                      and f.id is distinct from b.factor_id
                      and f.created_at is null) as other_verified_untimed,
           coalesce((select jsonb_agg(jsonb_build_object(
                              'factor_id', f.id, 'status', f.status::text, 'created_at', f.created_at)
                              order by f.created_at, f.id)
                       from auth.mfa_factors f
                      where f.user_id = a.user_id and f.factor_type = 'totp'
                        and left(coalesce(f.friendly_name, ''), 18) = 'sp-passkey-bridge-'
                        and f.id is distinct from b.factor_id), '[]'::jsonb) as others
      from accounts a
      left join public.passkey_bridges b on b.user_id = a.user_id
      left join lateral (
        select f.status::text as status, f.created_at
          from auth.mfa_factors f
         where f.id = b.factor_id and f.user_id = a.user_id and f.factor_type = 'totp'
           and left(coalesce(f.friendly_name, ''), 18) = 'sp-passkey-bridge-'
      ) bf on true
  ),
  judged as (
    select x.*,
           case
             when (x.active > 0 or x.bridge_id is not null)
                  and x.has_other_verified
               then 'reserved_factor_without_row'
             when x.active = 0 and x.other_site = 0 and x.removed > 0
                  and (x.newest_other_verified > x.last_removed
                       or x.other_verified_untimed
                       or (x.bridge_status = 'verified'
                           and (x.bridge_created is null or x.bridge_created > x.last_removed)))
               then 'bridge_newer_than_removal'
             when x.bridge_id is null and x.active = 0 and x.other_site = 0 and x.removed > 0
                  and x.has_other_verified
               then 'removal_unfinished'
             when x.active = 0 and x.other_site = 0 and x.removed = 0
                  and (x.bridge_id is not null or x.has_other_verified)
               then 'bridge_without_passkey'
             when x.bridge_id is not null and x.active = 0 and x.other_site = 0
               then 'bridge_row_without_passkey'
             when x.active = 0 and x.other_site > 0
               then 'other_site_only'
             when x.active > 0 and x.bridge_id is null
               then 'no_bridge'
             when x.active > 0 and x.bridge_status is null
               then 'bridge_factor_missing'
             when x.active > 0 and x.bridge_status <> 'verified'
               then 'bridge_factor_unverified'
             when jsonb_array_length(x.others) > 0
               then 'unverified_reserved_factor'
             when x.active > 0
               then 'healthy'
             else 'nothing'
           end as state
      from facts x
  )
  select j.user_id, j.state, j.active, j.other_site, j.removed, j.last_removed, j.bridge_id,
         j.bridge_status, j.bridge_created, j.others
    from judged j
   where j.state not in ('healthy', 'nothing')
   order by j.user_id
   limit 5000;
end;
$$;

revoke all on function public.passkey_account_states(text) from public, anon, authenticated, service_role;
grant execute on function public.passkey_account_states(text) to service_role;

comment on function public.passkey_account_states(text) is
  'Every account (at most 5,000) whose passkeys of the given site, bridge row and reserved-name TOTP factors at Supabase Auth are not healthy, with a state word (reserved_factor_without_row, bridge_newer_than_removal, removal_unfinished, bridge_without_passkey, bridge_row_without_passkey, other_site_only, no_bridge, bridge_factor_missing, bridge_factor_unverified, unverified_reserved_factor) and the facts behind it: the counts, the newest removal, the bridge factor id, status and when Auth made it, and the other reserved-name factors (id, status, when made). One word can cover several cases: callers branch on the facts, not on the word alone. bridge_newer_than_removal (a verified reserved-name factor made after the newest removal, no active passkey) is never finished automatically. 22023 passkey_site_required without a valid site. No secret, no key. service_role only.';

-- The Auth sessions whose second step is held now by a reserved-name factor
-- (the recorded bridge, or any other), for the server's own check of those
-- sessions. It reads auth.sessions, auth.mfa_factors and auth.mfa_amr_claims
-- as its owner (the preflight refuses an owner that cannot see their rows).
-- An empty list is not proof on its own.
--
-- raised_at is the updated_at of the session's totp row in
-- auth.mfa_amr_claims: the time of its newest TOTP answer, by Auth's clock
-- (one row per session and method, which the preflight checks; read with
-- max() so it is one value either way). NULL when there is no such row. A
-- session is listed when its own time (updated_at, else created_at) or its
-- raised_at is at or after p_since.
create function public.passkey_bridge_sessions(p_since timestamptz)
returns table (
  session_id   uuid,
  user_id      uuid,
  factor_id    uuid,
  recorded     boolean,
  aal          text,
  created_at   timestamptz,
  updated_at   timestamptz,
  raised_at    timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  select s.id, s.user_id, s.factor_id,
         exists (select 1 from public.passkey_bridges b
                  where b.user_id = s.user_id and b.factor_id = s.factor_id),
         s.aal::text, s.created_at, s.updated_at,
         r.raised_at
    from auth.sessions s
    join auth.mfa_factors f on f.id = s.factor_id and f.user_id = s.user_id
    left join lateral (
      select max(c.updated_at) as raised_at
        from auth.mfa_amr_claims c
       where c.session_id = s.id and c.authentication_method = 'totp'
    ) r on true
   where f.factor_type = 'totp'
     and left(coalesce(f.friendly_name, ''), 18) = 'sp-passkey-bridge-'
     and (coalesce(s.updated_at, s.created_at) >= coalesce(p_since, pg_catalog.now() - interval '1 day')
          or r.raised_at >= coalesce(p_since, pg_catalog.now() - interval '1 day'))
   order by greatest(coalesce(s.updated_at, s.created_at), r.raised_at) desc, s.id
   limit 5000;
end;
$$;

revoke all on function public.passkey_bridge_sessions(timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.passkey_bridge_sessions(timestamptz) to service_role;

comment on function public.passkey_bridge_sessions(timestamptz) is
  'The Auth sessions (at most 5,000, newest first) whose second step is held now by a reserved-name factor and that were made, refreshed or raised since p_since (default a day ago): session id, account, factor, whether that factor is the account''s recorded bridge, level, times, and raised_at: when the session last answered a TOTP factor (auth.mfa_amr_claims, Auth''s clock; NULL when there is no such row). No address, no device. For the server''s own check of those sessions; an empty list is not proof on its own. service_role only.';

-- Ends ONE Auth session, for the server's own check of those sessions. Modelled on
-- admin_revoke_user_sessions() (0308): owned by the migration role, SECURITY
-- DEFINER, a delete from auth.sessions. Narrower: one session, and only one
-- whose second step is held now by the account's RECORDED bridge factor (a
-- reserved-name TOTP factor of that account, the factor of its
-- passkey_bridges row) at aal2. Any other session that exists is refused
-- (22023 passkey_session_not_bridge_raised), so it cannot end arbitrary
-- sessions. No session with that id: false (already gone; nothing ended).
-- The check and the delete are one statement, so the row deleted is the row
-- checked: a session changed meanwhile (moved to another factor, dropped to
-- aal1) is checked again on its new version, and no lock is taken but the
-- delete's own. Two calls for one session at once: one ends it, the other
-- finds it gone (false).
-- The delete cascades to the session's auth.refresh_tokens (so it cannot be
-- refreshed), its auth.mfa_amr_claims and its public.user_session_names row.
-- An access token already issued stays valid until it expires; devices learn
-- through the app's own broadcast on the account's sessions channel (as for
-- admin_revoke_user_sessions), not from this function. No factor and no
-- passkey is touched.
create function public.passkey_end_bridge_session(p_session_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
begin
  if p_session_id is null then
    raise exception 'passkey_session_required' using errcode = '22023';
  end if;

  delete from auth.sessions s
   where s.id = p_session_id
     and s.aal::text = 'aal2'
     and exists (select 1 from public.passkey_bridges b
                  where b.user_id = s.user_id and b.factor_id = s.factor_id)
     and public._passkey_bridge_factor_ok(s.user_id, s.factor_id);
  if found then
    return true;
  end if;

  if exists (select 1 from auth.sessions s where s.id = p_session_id) then
    raise exception 'passkey_session_not_bridge_raised' using errcode = '22023';
  end if;
  return false;
end;
$$;

revoke all on function public.passkey_end_bridge_session(uuid) from public, anon, authenticated, service_role;
grant execute on function public.passkey_end_bridge_session(uuid) to service_role;

comment on function public.passkey_end_bridge_session(uuid) is
  'Ends one Auth session, and only one whose second step is held now (aal2) by the account''s recorded bridge factor (a reserved-name TOTP factor named in passkey_bridges): deletes that auth.sessions row, which cascades to its refresh tokens, its auth.mfa_amr_claims rows and its user_session_names row, and returns true. The check and the delete are one statement. Any other existing session: 22023 passkey_session_not_bridge_raised; no id: 22023 passkey_session_required; no such session (or one another call just ended): false. An access token already issued lasts until it expires; devices learn through the app''s broadcast, as for admin_revoke_user_sessions(). No factor and no passkey is touched. A lock wait ends after 2 s (55P03). service_role only.';

-- ── Retention ────────────────────────────────────────────────────────────────
create function public.purge_passkey_records()
returns table (challenges_deleted integer, removed_passkeys_deleted integer)
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_challenges integer;
  v_passkeys   integer;
begin
  -- Challenges a day after they ended, oldest first. One that ended exactly
  -- a day ago stays.
  with doomed as (
    select c.id
      from public.passkey_challenges c
     where c.expires_at < pg_catalog.now() - interval '1 day'
     order by c.expires_at
     limit 5000
  )
  delete from public.passkey_challenges c using doomed d where c.id = d.id;
  get diagnostics v_challenges = row_count;

  -- Removed passkeys 90 days after their removal, oldest first; one removed
  -- exactly 90 days ago stays. Kept while the account has no active passkey
  -- but still has a bridge row or a verified reserved-name factor at
  -- Supabase (removal_unfinished, bridge_newer_than_removal and
  -- bridge_row_without_passkey in the health list): the rows, and their
  -- times, are what tell a removal stopped half way from a restore.
  with doomed as (
    select p.id
      from public.member_passkeys p
     where p.removed_at < pg_catalog.now() - interval '90 days'
       and not (
         not exists (select 1 from public.member_passkeys a
                      where a.user_id = p.user_id and a.removed_at is null)
         and (exists (select 1 from public.passkey_bridges b where b.user_id = p.user_id)
              or exists (select 1 from auth.mfa_factors f
                          where f.user_id = p.user_id and f.factor_type = 'totp'
                            and f.status = 'verified'
                            and left(coalesce(f.friendly_name, ''), 18) = 'sp-passkey-bridge-')))
     order by p.removed_at
     limit 5000
  )
  delete from public.member_passkeys p using doomed d where p.id = d.id;
  get diagnostics v_passkeys = row_count;

  return query select v_challenges, v_passkeys;
end;
$$;

revoke all on function public.purge_passkey_records() from public, anon, authenticated, service_role;
grant execute on function public.purge_passkey_records() to service_role;

comment on function public.purge_passkey_records() is
  'Deletes passkey challenges more than a day after they ended and passkeys removed more than 90 days ago (kept while the account has no active passkey but still has a bridge row or a verified reserved-name factor: a removal not finished, or a restore), oldest first, at most 5,000 of each a call, and returns both counts; a caller repeats it until both are under 5,000. A lock wait ends after 2 s (55P03). service_role only.';
