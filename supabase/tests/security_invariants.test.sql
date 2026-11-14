-- supabase/tests/security_invariants.test.sql
-- ============================================================================
-- The machine-checkable subset of docs/security/SECURITY-INVARIANTS.md.
--
-- WHAT MAKES THIS FILE DIFFERENT FROM THE PER-MIGRATION TESTS
-- -----------------------------------------------------------
-- Every other file in this directory proves one migration: it names the objects
-- that migration touched and asserts their end state. That is the right shape
-- for a fix, and the wrong shape for an invariant — it says nothing about the
-- NEXT function, table, view or policy somebody adds.
--
-- This file is the other half. Each assertion sweeps a whole class of object,
-- states the property that must hold for every member of the class, and carries
-- an EXPLICIT ALLOWLIST of the members that are deliberately exempt. The
-- consequence is the one that matters: a new violation FAILS, because a new
-- object is not on any allowlist. Adding an exemption is a visible one-line
-- diff with a stated reason, reviewable on its own.
--
-- ASSERT THE PROPERTY, NEVER A SNAPSHOT
-- -------------------------------------
-- This program already shipped roughly eight tautological assertions once and
-- had to remove them, and it caught two PRE-EXISTING tests that were DEFENDING
-- vulnerabilities because they asserted observed behaviour instead of the
-- security property. So no assertion here is of the form "there are currently N
-- of X". Where a count appears it is a count of VIOLATIONS and the expected
-- value is 0, which stays correct as the schema grows.
--
-- VACUITY CONTROLS
-- ----------------
-- A sweep that selects nothing passes forever. Every section therefore carries
-- a control proving its detector still discriminates: that the privilege probe
-- returns true for a deliberately-open function and false for a deliberately-
-- closed one, that the tautology regex matches a synthetic tautology and not a
-- legitimate cross-relation comparison, that the constraint detector fires on a
-- constrained column and not on an unconstrained one, and that each population
-- being swept is non-empty. If a future refactor renames a catalog column or
-- breaks a regex, the control fails instead of the sweep silently passing.
--
-- HOW TO PROVE THIS FILE CAN FAIL (do this when you change it)
-- -----------------------------------------------------------
-- Introduce one violation, confirm the expected assertion goes red, revert:
--   * INV-1  create a SECURITY DEFINER function in public returning a non-
--            trigger type and leave the default PUBLIC grant in place.
--   * INV-5  create a table in public with an organization_id column and no
--            `alter table ... enable row level security`.
--   * INV-8  create a view in public WITHOUT `with (security_invoker = true)`.
--   * INV-11 create a policy on an org-scoped table with `using (true)`.
--   * INV-12 create a policy whose predicate contains `x.organization_id =
--            x.organization_id`.
--   * INV-15 add a `*_path` column to a table in public with no CHECK.
--   * INV-25 create a SECURITY DEFINER function in public, grant EXECUTE to
--            `authenticated`, and write a body with no auth.uid()/has_org_role/
--            has_permission/is_org_member in it (this is the 0342 shape).
--   * INV-27 create a function in public, ledger or gate without `set search_path`
--            (or `alter function ... reset search_path` on an existing one).
--
-- INV-29 and INV-30 need no hand recipe: they plant their own probes and are
-- the standing proof that INV-25/26 can still fail. The same holds for
-- INV-32, INV-34 and INV-36 (0371), the controls for INV-31, INV-33 and
-- INV-35, for INV-39 (0373), the control for INV-37 and INV-38, and for
-- INV-41 (0373), the control for INV-40, and for
-- INV-18b, INV-18c, INV-28b and INV-30c (T23), the controls for INV-15, INV-16,
-- INV-27 and INV-27b, and the allowlist audit INV-26 and INV-31 share, and
-- for INV-7b, INV-11b, INV-30d, INV-30e, INV-41b and INV-41c (T24), the
-- controls for the partitioned-table arm of INV-5, INV-6 and INV-11, the
-- side-effect arm of the allowlist audit, INV-40b and INV-40c, and for
-- INV-41d and INV-41e, the controls for INV-40d and for the SET-clause forms
-- INV-40b and INV-40c read.
--
-- Pure catalog introspection — no fixtures, no seeded rows, no roles switched.
-- `begin`/`rollback` for house consistency and so the temporary allowlist
-- tables never outlive the run.
-- ============================================================================

begin;

select plan(58);


-- ═══════════════════════════════════════════════════════════════════════════
-- ALLOWLISTS
--
-- Each row is an exemption someone has to defend. Keep the `why` column
-- populated: it is the review artifact, and an entry with no reason is a
-- finding in itself.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── A. SECURITY DEFINER functions in `public` that anon may execute ─────────
--
-- Keyed on proname, not on the full signature: an entry therefore exempts every
-- overload of that name from INV-1, and INV-2 checks every overload's body. The
-- looser key is deliberate — a new overload should inherit the scrutiny, not the
-- exemption.
--
-- Nothing here is exempt because it is harmless to call. Every one of these
-- carries its OWN authorization gate inside its body, which INV-2 verifies
-- structurally. `anon` reaching them means `auth.uid()` is null, and each then
-- either returns false/empty or raises.
create temporary table _sec_inv_anon_secdef_allow (proname text primary key, why text not null);
insert into _sec_inv_anon_secdef_allow (proname, why) values
  -- The three authorization predicates themselves. Referenced inside RLS
  -- policies, so `authenticated` must keep EXECUTE (see 0318's outage hazard);
  -- each resolves membership through auth.uid() and is false for anon.
  ('has_org_role',              'authorization predicate; resolves auth.uid() membership, false for anon'),
  ('has_permission',            'authorization predicate; resolves auth.uid() membership, false for anon'),
  ('is_org_member',             'authorization predicate; resolves auth.uid() membership, false for anon'),
  ('user_org_role',             'authorization predicate; returns null for a caller with no membership'),
  -- Order lifecycle RPCs. Each opens with a role/permission check on the
  -- order''s own organization.
  ('approve_order_request',     'gates on has_permission for the order''s org before mutating'),
  ('approve_partial',           'gates on has_permission for the order''s org before mutating'),
  ('cancel_order_request',      'gates on has_permission for the order''s org before mutating'),
  ('close_partial',             'gates on has_permission for the order''s org before mutating'),
  ('resume_fulfillment',        'gates on has_permission for the order''s org before mutating'),
  ('confirm_physical_signature','gates on has_permission for the order''s org before mutating'),
  -- Picking claim/lock RPCs (0237, 0289-0291). Identity-bound: they compare
  -- assigned_picker_id against auth.uid().
  ('assign_picking',            'gates on has_permission; assignment compared against auth.uid()'),
  ('claim_picking',             'claims FOR auth.uid(); a null uid cannot claim'),
  ('release_picking',           'releases only the claim held by auth.uid()'),
  ('complete_picking',          'gates on has_permission for the order''s org'),
  ('reopen_picking',            'manager override; gates on has_permission and records the actor'),
  ('partial_pick_line',         'gates on has_permission for the line''s org'),
  -- Cycle-count assignee lock (0282).
  ('assign_cycle_count',        'gates on has_permission for the count''s org'),
  ('release_cycle_count',       'releases only the assignment held by auth.uid()'),
  ('force_reassign_cycle_count','manager override; gates on has_permission and requires a reason'),
  -- Per-user MFA material (0027). Scoped to auth.uid() by construction.
  ('generate_mfa_recovery_codes','issues codes for auth.uid() only; anon has no row to write'),
  ('consume_mfa_recovery_code', 'consumes a code belonging to auth.uid() only'),
  -- Per-user session management (0213).
  ('revoke_my_other_sessions',  'operates on auth.uid()''s own sessions only'),
  ('revoke_my_session',         'operates on auth.uid()''s own sessions only'),
  -- Settings write.
  ('set_default_bin',           'gates on has_permission for the target org'),
  -- Movement note edit (0274/0307).
  ('edit_movement_note',        'gates on has_permission for the movement''s org');

-- ── E. SECURITY DEFINER functions in `public` that `authenticated` may execute
--       WITHOUT an authorization gate in their own body ─────────────────────
--
-- 0346 closed the class that this list exists to police: three definer
-- helpers (apply_cycle_count_location_delta, ensure_org_placement_locations,
-- ensure_warehouse_placement_locations) were executable by every signed-in
-- user with no in-body check — a viewer in another org could rewrite a victim
-- rack's holding with no ledger row. INV-25/26 below now apply to
-- `authenticated` the discipline INV-1..3 apply to anon.
--
-- Everything listed here is a READ-ONLY predicate that RLS policies and other
-- functions evaluate AS THE USER, so `authenticated` must keep EXECUTE, and
-- each exposes at most a BOOLEAN about a caller-supplied uuid. None writes.
-- Adding a name here must be defended in `why`; a function that WRITES must
-- never appear, nor one that reaches a write through what it calls (INV-26
-- follows its calls, T23), nor one with a side effect that is not a table
-- write: a setting, a sequence, a notification or an advisory lock (T24).
--
-- _cycle_count_location_facts was the one entry that exposed ATTRIBUTES rather
-- than a boolean (org, warehouse, kind, deleted_at for any location uuid) and
-- it is gone from this list: 0350 gave it post_cycle_count's own has_org_role
-- gate, so INV-25 now judges it on its body like everything else. The
-- exemption it held is the reason to distrust attribute-returning entries —
-- "reading past RLS is the point" justified the SECURITY DEFINER, never the
-- missing authorization check.
create temporary table _sec_inv_auth_secdef_nogate_allow (proname text primary key, why text not null);
insert into _sec_inv_auth_secdef_nogate_allow (proname, why) values
  ('item_in_org',                 'boolean FK-org predicate used by write RLS (0201-0206); null-tolerant by design'),
  ('location_in_org',             'boolean FK-org predicate used by write RLS (0201-0206)'),
  ('assert_location_in_org',      'raising variant of location_in_org used inside stock RPCs'),
  ('category_in_org',             'boolean FK-org predicate used by write RLS'),
  ('charter_in_org',              'boolean FK-org predicate used by write RLS'),
  ('supplier_in_org',             'boolean FK-org predicate used by write RLS'),
  ('warehouse_in_org',            'boolean FK-org predicate used by write RLS'),
  ('purchase_order_in_org',       'boolean FK-org predicate used by write RLS'),
  ('product_group_in_org',        'boolean FK-org predicate used by write RLS (0294+)'),
  ('module_enabled',              'boolean entitlement read (organization_modules row, OR organizations.all_modules_comp answered only to that org''s members, 0354) evaluated inside RLS/RPCs'),
  ('org_can_enable_module',       'boolean entitlement read (plan tier) used by module settings'),
  ('org_effective_tier',          'returns the org plan tier string; no tenant data'),
  ('user_can_access_inventory',   'boolean warehouse/charter access predicate used by inventory RLS'),
  ('user_can_access_warehouse',   'boolean warehouse access predicate used by RLS');

-- ── B. Tables in `public` allowed to run without RLS ───────────────────────
-- Intentionally EMPTY. Every table in this schema has RLS enabled today, and
-- there is no known class of table here that should not. A future non-tenant
-- reference table is the plausible exception — add it with a reason, and expect
-- the reason to be challenged.
create temporary table _sec_inv_rls_exempt_tables (relname text primary key, why text not null);

-- ── C. Views in `public` allowed to run without security_invoker ───────────
-- Intentionally EMPTY. A view without `security_invoker = true` executes with
-- its OWNER's privileges, so it reads straight through RLS: on this schema that
-- is a cross-tenant read of whatever it selects, available to anyone who holds
-- SELECT on the view. All six views carry the option today.
create temporary table _sec_inv_view_exempt (relname text primary key, why text not null);

-- ── D. Storage buckets allowed to be PUBLIC ────────────────────────────────
-- A public bucket serves every object in it to an unauthenticated URL with no
-- policy evaluation, so this list is the complete set of object classes we have
-- accepted as world-readable.
create temporary table _sec_inv_public_bucket_allow (id text primary key, why text not null);
insert into _sec_inv_public_bucket_allow (id, why) values
  ('org-logos',   'org logo is rendered on public order links and outbound email; not tenant data'),
  ('user-avatars','avatar is rendered in shared UI and email; READ scoping to the owner''s folder is asserted in 0322 s.2');

-- ── E. Path-bearing columns with no traversal CHECK yet (KNOWN GAP) ────────
-- EMPTY since 0326 closed the last five gaps (item_attachments,
-- cycle_count_ai_scans, import_jobs, size_count_training_samples,
-- support_tickets) — every path-bearing column in public now carries the 0323
-- predicate, and INV-15 enforces all of them with no exemptions. The table
-- stays so a future gap has somewhere visible to be recorded (and so INV-16
-- refuses a stale entry when that gap is later closed); an entry here is a
-- finding to be defended, never a default.
create temporary table _sec_inv_path_check_gap (relname text, attname text, why text not null,
  primary key (relname, attname));

-- ── The writer detector allowlists E and F are audited with (0395, L19) ────
--
-- An allowlisted entry must never write. Until 0395 the detector was
-- \m(insert\s+into|update\s+public\.|delete\s+from)\M, which missed MERGE INTO,
-- UPDATE ONLY, an unqualified UPDATE and a quoted "public". It is now 0387's
-- writer forms: INSERT INTO, MERGE INTO [ONLY], DELETE FROM [ONLY], and
-- UPDATE [ONLY] <table> [*] [alias] SET (the SET keeps "for update of" and
-- "on update cascade" out). The UPDATE arm takes a table in ANY schema
-- ("update ledger.t set" and "update auth.users set" count as much as
-- "update public.t set"), under any number of qualifiers, each name bare or
-- double-quoted, ONLY with or without parentheses, and the * that may follow
-- a table name; TRUNCATE counts (T23). The writer census of the allowlist
-- audit (INV-26, INV-30, INV-30c, INV-31) reads this one row against the raw
-- body and against the body with comments removed, so a comment between two
-- words of a form is read as the space it is. INV-30b plants a probe per
-- form.
create temporary table _sec_inv_writer_re (re text not null);
insert into _sec_inv_writer_re (re) values
  ($re$\m(insert\s+into|merge\s+into|delete\s+from|truncate)\M|\mupdate\s+(only\s*\(?\s*)?(("([^"]|"")+"|[a-z_][a-z0-9_$]*)\s*\.\s*)*("([^"]|"")+"|[a-z_][a-z0-9_$]*)(\s*\))?(\s*\*)?(\s+(as\s+)?("([^"]|"")+"|[a-z_][a-z0-9_$]*))?\s+set\M$re$);

-- The code skeleton of a body (T23), made in one left-to-right pass: each
-- comment becomes a space, each single-quoted literal becomes an empty
-- literal ('') and each double-quoted identifier is kept whole. The
-- replacement puts back the literal's two quotes (groups 1 and 2) or the
-- identifier (group 3); all three are empty for a comment. The allowlist
-- audit reads calls, EXECUTE and the side-effect forms from this text, so a
-- name in a comment or a message is not a call, and INV-40d reads from it
-- whether a set_config call names its setting with one literal. Writes are
-- not read from it: they are read from the raw body, so a write inside a
-- format() string still counts, and from the comments-only text below.
create temporary table _sec_inv_strip_re (re text not null, rep text not null);
insert into _sec_inv_strip_re (re, rep) values
  ($re$/\*(?:[^*]|\*+[^*/])*\*+/|--[^\n\r]*|(')(?:[^']|'')*(')|("(?:[^"]|"")*")$re$, ' \1\2\3 ');

-- Comments only (T24): the same pass, with each quoted literal and each
-- double-quoted identifier put back (group 1) behind a space, so a comment
-- between two words leaves them two words. The setting censuses read this
-- text, because a setting's name is a literal and must stay readable while a
-- name in a comment must not count.
create temporary table _sec_inv_comment_re (re text not null, rep text not null);
insert into _sec_inv_comment_re (re, rep) values
  ($re$/\*(?:[^*]|\*+[^*/])*\*+/|--[^\n\r]*|('(?:[^']|'')*'|"(?:[^"]|"")*")$re$, ' \1');

-- What the pass does not follow. It reads a body as SQL or PL/pgSQL text and
-- knows comments (a line comment ends at a line break or a carriage return,
-- as it does for Postgres), plain quoted literals and double-quoted
-- identifiers. Three forms of such a body put it out of step with the code
-- that runs, so that what follows them would be read as a literal or a
-- comment when it is code, or the other way round: a backslash-escaped quote
-- inside an E'' string (the string may go on across a line break), a
-- dollar-quoted literal, and a block comment inside a block comment. Each is
-- read from the raw body. INV-27b refuses a first-party function whose body
-- holds one, and with them a body in which a quote is left once the pass is
-- done, a function whose own SET clause names standard_conforming_strings
-- (with it off a plain literal takes backslash escapes too) and a function
-- written in any other language. The platform's own functions in storage
-- and graphql_public are read as they are. A plain literal that ends in a
-- backslash ('\', the LIKE escape) is none of the forms. INV-28b plants a
-- probe per form.
create temporary table _sec_inv_unread_re (form text primary key, re text not null);
insert into _sec_inv_unread_re (form, re) values
  ('a backslash-escaped quote in an E string', $re$(^|[^a-z0-9_$])e'([^'\\]|\\[^']|'(\s|--[^\n\r]*[\n\r])*')*\\'$re$),
  ('a dollar-quoted literal',                  $re$\$(([a-z_]|[^\x01-\x7f])([a-z0-9_]|[^\x01-\x7f])*)?\$$re$),
  ('a comment inside a comment',               $re$/\*([^*/]|\*+[^*/]|/+[^*/])*/+\*$re$);

-- Side effects that are not table writes (T24), read from the code skeleton:
-- a setting changed (set_config, or a SET or RESET statement), a sequence
-- moved (setval, nextval), a notification sent (pg_notify, NOTIFY) or an
-- advisory lock taken. A read-only predicate has none of them: a setting
-- changed inside a helper stays changed for the rest of the caller's
-- transaction. A function's name counts bare or double-quoted. SET, RESET
-- and NOTIFY count only where a statement starts (the start of the body,
-- after ";", THEN, ELSE, BEGIN or LOOP), so the SET of an UPDATE is left to
-- the writer forms above. INV-30d plants a probe per form.
create temporary table _sec_inv_side_effect_re (re text not null);
insert into _sec_inv_side_effect_re (re) values
  ($re$\m(set_config|setval|nextval|pg_notify|pg_(try_)?advisory_[a-z_]+)"?\s*\(|(^|;|\m(then|else|begin|loop))\s*(set|reset|notify)\M$re$);

-- An identity setting being set (T24). `re` is read from the body with
-- comments removed and quoted text kept: set_config with the literal name
-- request.jwt.* (auth.uid() and auth.role() read these), role or
-- session_authorization, or a SET or RESET statement naming one of them,
-- bare or double-quoted. `cfg` is read from each entry of the function's own
-- SET clause (pg_proc.proconfig holds "name=value"): a function created with
-- SET role = ... runs its body as that role.
create temporary table _sec_inv_identity_set_re (re text not null, cfg text not null);
insert into _sec_inv_identity_set_re (re, cfg) values
  ($re$\mset_config"?\s*\(\s*'\s*(request\.jwt[^']*|role|session_authorization)\s*'|(^|;|\m(then|else|begin|loop))\s*(set\s+(local\s+|session\s+)?|reset\s+)("?role\M|"?session_authorization\M|session\s+authorization\M|"?request\.jwt)$re$,
   $re$^(role|session_authorization|request\.jwt[^=]*)=$re$);

-- A stockpilot.* transaction flag being set (T24). `re` is read from the
-- same text: set_config with a literal name, or a SET statement. Its one
-- group is the flag's whole name, every dotted part of it; a name finished
-- at run time ('stockpilot.' || x) reads as "stockpilot." and is on no list
-- (INV-40d names that call as well). `cfg` is read from each entry of the
-- function's own SET clause; its one group is the flag's name.
create temporary table _sec_inv_flag_set_re (re text not null, cfg text not null);
insert into _sec_inv_flag_set_re (re, cfg) values
  ($re$(?:\mset_config"?\s*\(\s*'\s*|(?:^|;|\m(?:then|else|begin|loop))\s*set\s+(?:local\s+|session\s+)?"?)(stockpilot\.[a-z0-9_.$]*)$re$,
   $re$^(stockpilot\.[^=]*)=$re$);

-- A set_config call and the name it passes, read from the code skeleton,
-- where every literal is ''. `any_re` is a call; `literal_re` is a call
-- whose first argument is one quoted literal and nothing more, then a comma.
-- The two censuses above read a setting's name out of that literal, so a
-- name they could not read whole (two literals joined, a literal continued
-- on the next line, an E'' string, a variable, a format() call, a cast) has
-- to be refused: INV-40d holds the two counts equal for every function.
create temporary table _sec_inv_setting_call_re (any_re text not null, literal_re text not null);
insert into _sec_inv_setting_call_re (any_re, literal_re) values
  ($re$\mset_config"?\s*\($re$, $re$\mset_config"?\s*\(\s*''\s*,$re$);

-- ── F. SECURITY DEFINER functions in `ledger` that `authenticated` may execute
--       WITHOUT an authorization token in their own body (0371) ──────────────
--
-- INV-25 sweeps `public` only. The `ledger` schema (0359) is not exposed by
-- PostgREST, but `authenticated` holds USAGE on it and EXECUTE on its bodies,
-- because the INVOKER public wrappers call into it as the user. A DEFINER
-- function there is reachable from any INVOKER code path the user can start,
-- so it needs its own gate exactly as a public one does (the 0346 lesson).
-- 0371 added the first DEFINER writer there (ledger.apply_holding_delta); INV-31
-- makes the rule a catalog property. Same discipline as allowlist E: an entry
-- must be read-only (INV-31 withdraws it the day it writes) and defended here.
create temporary table _sec_inv_ledger_secdef_nogate_allow (proname text primary key, why text not null);
insert into _sec_inv_ledger_secdef_nogate_allow (proname, why) values
  ('cycle_count_line_superseded', 'boolean read of other counts'' movements for ledger.post_cycle_count (0369); answers only inside a ledger transaction (ledger.active()), writes nothing');

-- ── G. Tables whose SELECT is warehouse-scoped but that carry a permissive
--       FOR ALL policy (0371) ────────────────────────────────────────────────
--
-- A FOR ALL policy's USING clause also applies to SELECT, and permissive
-- policies OR together, so a FOR ALL write policy on a table whose SELECT
-- policy is warehouse-scoped silently widens that SELECT to everyone the
-- write policy admits. That is exactly how staff read every warehouse's
-- item_stock_levels until 0371. INV-35 forbids the shape; an entry here must
-- say why its FOR ALL USING cannot widen reads, or record a known gap.
create temporary table _sec_inv_forall_on_scoped_allow (relname text primary key, why text not null);
insert into _sec_inv_forall_on_scoped_allow (relname, why) values
  ('warehouses',      'warehouses_admin_write USING is has_org_role(admin), narrower than warehouses_select (member AND (manager+ OR user_can_access_warehouse read)), so it cannot widen reads'),
  ('purchase_orders', 'KNOWN GAP, deferred to 0372: purchase_orders_write (manager OR purchase_orders:manage) widens reads past purchase_orders:read and the warehouse scope. A plain split breaks PO numbering (next_po_number is INVOKER and counts only visible POs), so it needs its own prerequisite');

-- ── H. Functions that still call the NON-recording public.apply_level_delta
--       (0373) ──────────────────────────────────────────────────────────────
--
-- Since 0373 every null-location draw goes through ONE engine,
-- ledger.apply_level_delta_for, which records which holdings it touched for
-- the movement id its caller passes. public.apply_level_delta passes a NULL
-- id, so a caller of it moves stock with no provenance. INV-37 makes every
-- such caller a visible, defended exception.
create temporary table _sec_inv_ald_caller_allow (fn text primary key, why text not null);
insert into _sec_inv_ald_caller_allow (fn, why) values
  ('ledger.post_cycle_count', 'F1-frozen: its residual null-location draw stays unrecorded (0373 owner Q4); pgTAP 0373 D30 pins the gap so it flips on purpose when the count slice passes a movement id');

-- ── I. Callers of the draw engine, and the arguments each passes (0373) ────
--
-- A recorded draw is only true if the draw a caller writes into a movement
-- row is the one its OWN engine call just returned, for its own drawer.
-- INV-38 holds every caller to that shape: a recorder assigns every call to
-- v_prov with (record = true, drawer = v_user) and writes v_prov into the
-- next stock_movements INSERT; the non-recording wrapper passes
-- (false, null). A new caller must be listed here with its arguments.
create temporary table _sec_inv_engine_caller_allow (fn text primary key, rec_args text not null, why text not null);
insert into _sec_inv_engine_caller_allow (fn, rec_args, why) values
  ('public.apply_level_delta',          'false, null',  'the non-recording wrapper: moves holdings exactly as before, returns no draw (its callers are INV-37''s list)'),
  ('ledger.adjust_stock',               'true, v_user', 'every null-location adjust (phone, web, AI, restore, picking, reversal, cancel restock, receipt fallback)'),
  ('ledger.distribute_bundle',          'true, v_user', 'the pre-assembled kit drain and each component draw'),
  ('ledger.assemble_bundle',            'true, v_user', 'each component draw and the kit''s Staging landing'),
  ('ledger.process_return_disposition', 'true, v_user', 'the restock landing and the scrap draw, each written into its own leg''s row');


-- ── J. First-party functions deliberately left without a search_path pin
--       (T23) ────────────────────────────────────────────────────────────────
--
-- Keyed on the full signature (to_regprocedure text), not on the name: a new
-- overload must earn its own exemption, unlike allowlist A, whose name key is
-- safe because INV-2 re-checks every overload's body. INV-27 refuses an entry
-- whose function is gone or pinned now, and one that no longer meets the terms
-- that make an unpinned function harmless here: SECURITY INVOKER, and no API
-- role (anon, authenticated, service_role) may execute it.
create temporary table _sec_inv_search_path_allow (sig text primary key, why text not null);
insert into _sec_inv_search_path_allow (sig, why) values
  ('ledger._seal(uuid,uuid,uuid,text,public.stock_draw_holding[],uuid[])',
   'SECURITY INVOKER with no EXECUTE for any API role (0373:544-545); runs only under its one caller, the SECURITY DEFINER engine ledger.apply_level_delta_for, pinned to search_path = public; every name in its body is schema-qualified; a SET would cost a GUC save and restore per recorded draw (0373:417-421); 0373 A13 pins its proconfig NULL');

-- ── K. Functions with no first-party body that an allowlist E or F entry may
--       reach (T23) ─────────────────────────────────────────────────────────
--
-- The allowlist audit reads first-party SQL and PL/pgSQL bodies in public and
-- ledger. A function anywhere else, or an extension member anywhere (a C
-- function, net.http_post), has no body the audit can judge and may still
-- write, so an entry that reaches one loses its exemption unless it is listed
-- here with its reason. Keyed on schema.name (these are not our functions;
-- an overload would be the platform's). INV-26 refuses a stale row: the
-- function is gone, or no entry reaches it any more.
create temporary table _sec_inv_external_callee_allow (fn text primary key, why text not null);
insert into _sec_inv_external_callee_allow (fn, why) values
  ('auth.uid', 'reads the caller''s JWT subject and writes nothing (module_enabled calls it, and is_org_member under it)');

-- ── L. Functions that set an identity setting (T24) ────────────────────────
--
-- request.jwt.claim.sub and request.jwt.claims are what auth.uid() reads, and
-- role and session_authorization are who the statement runs as. A function
-- that sets one, in its body or through its own SET clause, changes who the
-- rest of the transaction (or its own body) acts as, so every first-party
-- function that does is listed here with its reason, keyed on its full
-- signature like allowlist J. INV-40b refuses a function that is not listed,
-- a row whose function is gone or sets none of them any more, and a listed
-- function that anon or authenticated may execute.
create temporary table _sec_inv_identity_setter_allow (sig text primary key, why text not null);
insert into _sec_inv_identity_setter_allow (sig, why) values
  ('public.exception_evidence_record(uuid,uuid,text,text,text,bigint,timestamptz,text)',
   'service_role only, and its body refuses authenticated and anon (0375); it puts the uploader''s id in request.jwt.claim.sub and request.jwt.claim.role for two helper calls that answer for auth.uid(), with is_local = true, and puts the previous values back before anything is written (0375:514-529); pinned per function by 0375 G7 and G12');

-- ── M. Functions that raise a stockpilot.* transaction flag (T24) ──────────
--
-- A stockpilot.* setting is a flag that a guard, a policy or a trigger reads
-- to tell a write made inside one of our functions from a direct one. Four
-- of the flags have a census of their own (stockpilot.ledger in 0359 test
-- 17, stockpilot.order_submit in 0391 G5, stockpilot.return_exchange in 0397
-- A1b, stockpilot.draw_scope in INV-40). This list holds every (flag,
-- function) pair, so a new flag, and a new function that raises an existing
-- one, are both a reviewed row here. Keyed on schema.name, as those censuses
-- are. INV-40c refuses a pair that is not listed and a row that matches no
-- function body or SET clause any more.
create temporary table _sec_inv_flag_setter_allow (flag text not null, fn text not null, why text not null, primary key (flag, fn));
insert into _sec_inv_flag_setter_allow (flag, fn, why) values
  ('stockpilot.ledger', 'public.adjust_stock',                'ledger wrapper: raises the flag around its call into ledger (0359; also 0359 test 17)'),
  ('stockpilot.ledger', 'public.assemble_bundle',             'ledger wrapper (0359; also 0359 test 17)'),
  ('stockpilot.ledger', 'public.distribute_bundle',           'ledger wrapper (0359; also 0359 test 17)'),
  ('stockpilot.ledger', 'public.post_cycle_count',            'ledger wrapper (0359; also 0359 test 17)'),
  ('stockpilot.ledger', 'public.post_receipt_v2',             'ledger wrapper (0359; also 0359 test 17)'),
  ('stockpilot.ledger', 'public.process_return_disposition',  'ledger wrapper (0359; also 0359 test 17)'),
  ('stockpilot.ledger', 'public.reverse_receipt',             'ledger wrapper (0359; also 0359 test 17)'),
  ('stockpilot.ledger', 'public.transfer_stock',              'ledger wrapper (0359; also 0359 test 17)'),
  ('stockpilot.order_submit', 'public.place_order_request',       'one of the two writers of order_submissions (0391; also 0391 G5)'),
  ('stockpilot.order_submit', 'public.withdraw_order_submission', 'one of the two writers of order_submissions (0391; also 0391 G5)'),
  ('stockpilot.return_exchange', 'public._return_exchange_on_cancel',        'no API role may execute it (0396, 0397; also 0397 A1b)'),
  ('stockpilot.return_exchange', 'public._return_replacement_cancel_order',  'no API role may execute it (0396, 0397; also 0397 A1b)'),
  ('stockpilot.return_exchange', 'public._return_replacement_close_partial', 'no API role may execute it (0397; also 0397 A1b)'),
  ('stockpilot.draw_scope', 'ledger._seal',                'the draw scope cache, not a guard; no API role may execute it (0373; also INV-40)'),
  ('stockpilot.draw_scope', 'ledger.tg_forget_draw_scope', 'clears the draw scope cache (0373; also INV-40)'),
  ('stockpilot.add_lines', 'public.add_order_request_lines', 'raises the flag around its own top-ups and new lines, and puts the previous value back; the top-up helper runs only under it (0413)'),
  ('stockpilot.exchange_kept_lines', 'public.change_return_replacement', 'names the exchange lines it keeps, one per item check, and puts the previous value back (0413)'),
  ('stockpilot.derived_write', 'public.set_order_catalog_visibility', 'writes the two order catalog columns without moving updated_at, and puts the previous value back (0413)'),
  ('stockpilot.derived_write', 'public._backfill_variant_size',       'the 0303 size backfill, which leaves updated_at alone');


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. anon / PUBLIC EXECUTE POSTURE ON SECURITY DEFINER FUNCTIONS
--
-- THE P0 THIS ENCODES: Postgres grants `EXECUTE TO PUBLIC` on every new
-- function, and `anon` inherits PUBLIC, so OMITTING a grant does not close a
-- function — it opens it. PostgREST publishes every EXECUTE-able function in
-- `public` at POST /rest/v1/rpc/<name>, and the anon key ships inside the web
-- bundle and the app binary. SECURITY DEFINER then executes the body with the
-- owner's rights, bypassing RLS. 0318 closed the 15 functions that were
-- genuinely exploitable; this section is what stops the sixteenth.
--
-- WHY TRIGGER-RETURNING FUNCTIONS ARE EXCLUDED, AND WHY THAT IS NOT A LOOPHOLE:
-- a function returning `trigger` cannot be invoked as an RPC. PostgREST refuses
-- to expose it and Postgres itself refuses a direct call ("trigger functions can
-- only be called as triggers"). The exclusion is therefore a PROPERTY of the
-- return type, not an observation about today's catalog — which is exactly why
-- 17 of the 58 originally-anon-executable functions were never exploitable.
-- ═══════════════════════════════════════════════════════════════════════════

-- INV-1. The sweep. Any SECURITY DEFINER function in `public` that anon can
-- execute and that is invocable as an RPC must be allowlisted above.
-- has_function_privilege resolves inherited privileges, so this single probe
-- catches a direct `anon=X` grant AND a PUBLIC grant anon would inherit AND a
-- null ACL (which is itself PUBLIC-executable).
select is(
  (select count(*)::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and p.prorettype <> 'trigger'::regtype
      and has_function_privilege('anon', p.oid, 'execute')
      and p.proname not in (select proname from _sec_inv_anon_secdef_allow)),
  0,
  'INV-1: every anon-EXECUTE SECURITY DEFINER function in public that is RPC-invocable is allowlisted'
);

-- INV-2. The allowlist polices itself. An entry only buys an exemption from
-- INV-1 if the function carries its own authorization gate, because that gate
-- is the entire reason the exemption is defensible. This is what stops "add the
-- name to the allowlist" from being a way to ship an ungated anon-callable
-- SECURITY DEFINER function.
select is(
  (select count(*)::int
     from _sec_inv_anon_secdef_allow a
     join pg_proc p on p.proname = a.proname
     join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
    where p.prosecdef
      and p.prosrc !~* '(auth\.uid|has_org_role|has_permission|is_org_member)'),
  0,
  'INV-2: every anon-EXECUTE allowlist entry gates authorization inside its own body'
);

-- INV-3. No stale entry. An allowlist that outlives its function is dead weight
-- that makes the real exemption set unreadable, and a renamed function would
-- keep an entry that no longer describes anything.
select is(
  (select count(*)::int
     from _sec_inv_anon_secdef_allow a
    where not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = a.proname and p.prosecdef)),
  0,
  'INV-3: no stale entry in the anon-EXECUTE allowlist'
);

-- INV-4. VACUITY CONTROL for the privilege probe. If has_function_privilege
-- ever stopped discriminating — a renamed role, a changed signature, a probe
-- that silently returns null — INV-1 would pass by selecting nothing. This pins
-- both directions against two functions whose posture 0318 fixed deliberately:
-- one that MUST stay open to anon (an RLS predicate) and one that MUST stay
-- closed (the cross-tenant notification purge).
select ok(
  has_function_privilege('anon', 'public.has_org_role(uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.purge_read_notifications(interval)', 'execute'),
  'INV-4 control: the anon EXECUTE probe still discriminates open from closed'
);


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. TENANT ISOLATION — RLS IS ENABLED
--
-- RLS is the only thing standing between one tenant's rows and another's for
-- every PostgREST caller, and `authenticated` holds table-level SELECT/INSERT/
-- UPDATE/DELETE on this schema by Supabase's default grants. A table with an
-- organization_id and RLS switched off is therefore not "unprotected pending
-- policies" — it is world-readable and world-writable to any signed-in user of
-- any organization the moment it exists.
-- ═══════════════════════════════════════════════════════════════════════════

-- The two sweeps' detector (T24), one view so INV-7b exercises the very same
-- text: a table in public with RLS switched off. A partitioned table
-- (relkind 'p') is swept with ordinary ones: a query through the parent is
-- filtered by the parent's own row level security, not by its partitions',
-- so a parent with RLS off is open even when every partition has it on.
create temporary view _sec_inv_rls_off as
  select c.relname::text as relname,
         exists (select 1 from pg_attribute a
                  where a.attrelid = c.oid and a.attname = 'organization_id'
                    and a.attnum > 0 and not a.attisdropped) as org_scoped
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity;

-- INV-5. No allowlist, deliberately. There is no defensible reason for a table
-- that carries an organization_id to run without RLS, so this one has no escape
-- hatch: closing a failure means enabling RLS and writing policies. Offenders
-- are named.
select is(
  (select coalesce(string_agg(v.relname, ', ' order by v.relname collate "C"), '')
     from _sec_inv_rls_off v where v.org_scoped),
  '',
  'INV-5: every table in public with an organization_id, ordinary or partitioned, has RLS enabled'
);

-- INV-6. The wider sweep, with an allowlist that is currently empty. A table
-- with no organization_id can still hold data worth protecting (per-user rows
-- keyed on auth.uid(), platform-level configuration), and "it has no org
-- column" is not by itself a reason to be open.
select is(
  (select coalesce(string_agg(v.relname, ', ' order by v.relname collate "C"), '')
     from _sec_inv_rls_off v
    where v.relname not in (select relname from _sec_inv_rls_exempt_tables)),
  '',
  'INV-6: every table in public, ordinary or partitioned, has RLS enabled unless explicitly allowlisted'
);

-- INV-7. VACUITY CONTROL. INV-5 passes trivially if the organization_id
-- detector stops matching anything (a renamed catalog column, a typo). Assert
-- the population it sweeps is substantial rather than empty.
select cmp_ok(
  (select count(*)::int
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     join pg_attribute a on a.attrelid = c.oid
      and a.attname = 'organization_id' and a.attnum > 0 and not a.attisdropped
    where n.nspname = 'public' and c.relkind in ('r', 'p')),
  '>',
  50,
  'INV-7 control: the org-scoped table sweep still finds the tenant tables'
);

-- INV-7b. MUTATION CONTROL for INV-5 and INV-6 on a partitioned table (T24).
-- A planted partitioned table with an organization_id and no RLS must be
-- named by the view both sweeps read. Dropped straight after (the enclosing
-- rollback is the second belt).
create table public._sec_inv_probe_parted (id uuid not null, organization_id uuid not null)
  partition by list (organization_id);
select is(
  (select coalesce(string_agg(v.relname || ' (org-scoped: ' || v.org_scoped::text || ')', ' | ' order by v.relname collate "C"), '')
     from _sec_inv_rls_off v where v.relname like '\_sec\_inv\_probe\_%'),
  '_sec_inv_probe_parted (org-scoped: true)',
  'INV-7b control: the RLS sweeps name a partitioned table that has an organization_id and RLS switched off'
);
drop table public._sec_inv_probe_parted;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. VIEWS AND MATERIALIZED VIEWS MUST NOT BYPASS RLS
--
-- A view executes with the privileges of its OWNER unless it is created `with
-- (security_invoker = true)`. Every view here is owned by the migration role,
-- which owns the underlying tables, so a view without the option reads the base
-- tables with RLS bypassed — a full cross-tenant read of whatever it selects,
-- reachable by anyone holding SELECT on the view. This is a quiet failure mode:
-- the view works, returns rows, and looks correct to the developer who created
-- it inside their own organization.
-- ═══════════════════════════════════════════════════════════════════════════

-- INV-8. Every view carries the option, explicitly set to true. A view whose
-- reloptions are null fails, which is the point: the DEFAULT is the unsafe one.
select is(
  (select count(*)::int
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
      and coalesce(
            (select option_value from pg_options_to_table(c.reloptions)
              where option_name = 'security_invoker'),
            'unset') <> 'true'
      and c.relname not in (select relname from _sec_inv_view_exempt)),
  0,
  'INV-8: every view in public is security_invoker = true (does not read through RLS as its owner)'
);

-- INV-9. No materialized views in `public`. A matview CANNOT have RLS at all —
-- Postgres does not support it — so a matview over tenant tables is an
-- unfilterable cross-tenant copy of that data, and its refresh runs as its
-- owner. If a reporting matview is ever genuinely needed, it belongs in a
-- non-exposed schema that PostgREST does not publish, and this assertion should
-- be the thing that forces that conversation.
select is(
  (select count(*)::int
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'm'),
  0,
  'INV-9: no materialized view exists in public (a matview cannot carry RLS)'
);

-- INV-10. VACUITY CONTROL for INV-8: there are views to check, and the
-- reloptions probe can actually read the option off one of them.
select cmp_ok(
  (select count(*)::int
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
      and (select option_value from pg_options_to_table(c.reloptions)
            where option_name = 'security_invoker') = 'true'),
  '>',
  0,
  'INV-10 control: the security_invoker probe still reads the option off a real view'
);


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. POLICY-PREDICATE HYGIENE — THE TWO PATTERNS THAT SHIPPED REAL HOLES
--
-- Pattern #25: an UNQUALIFIED column inside a policy's EXISTS subquery binds to
-- the INNER relation, turning the intended cross-check into
-- `organization_id = organization_id` — a tautology that is always true. This
-- shipped once as a real cross-tenant WRITE hole. It is invisible in review
-- because the source text reads like a comparison; only the PARSED predicate,
-- which is what pg_policies renders, shows the self-comparison. That makes it
-- detectable here and essentially undetectable by grepping migrations.
--
-- Pattern #24 is NOT directly checkable at this level and is not faked here:
-- `alter policy ... with check` REPLACES the whole clause rather than amending
-- it, so its failure mode is a predicate that lost a conjunct — still a valid
-- expression, still gated, just less gated. Detecting that requires knowing
-- which conjuncts were meant to be there, which is per-policy knowledge and
-- lives in the migration tests (0322 pins item_stock_levels_select's predicate
-- text verbatim for exactly this reason). The enforceable rule is procedural:
-- always `drop policy` + `create policy` restating every conjunct. What this
-- section CAN do generically is catch the two shapes a lost conjunct most often
-- degrades into — a literal true, and a self-comparison.
-- ═══════════════════════════════════════════════════════════════════════════

-- INV-11. No policy on an org-scoped table may have a literal-true predicate.
-- `using (true)` on a tenant table is an unrestricted cross-tenant read; a
-- literal-true WITH CHECK is an unrestricted cross-tenant write. Restricted to
-- org-scoped tables on purpose: a literal true is legitimate on a global
-- reference table (role_default_permissions_select is the live example), and an
-- assertion that failed on that would be reflexively neutered.
-- One view (T24), so INV-11b exercises the very same text. Partitioned
-- tables are judged with ordinary ones, for the reason given at INV-5.
create temporary view _sec_inv_literal_true_policies as
  select pol.tablename::text as relname, pol.tablename || '.' || pol.policyname as x
    from pg_policies pol
    join pg_class c on c.relname = pol.tablename
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = pol.schemaname
   where pol.schemaname = 'public'
     and c.relkind in ('r', 'p')
     and exists (select 1 from pg_attribute a
                  where a.attrelid = c.oid and a.attname = 'organization_id'
                    and a.attnum > 0 and not a.attisdropped)
     and (pol.qual = 'true' or pol.with_check = 'true');

select is(
  (select coalesce(string_agg(v.x, ', ' order by v.x collate "C"), '') from _sec_inv_literal_true_policies v),
  '',
  'INV-11: no policy on an org-scoped table, ordinary or partitioned, has a literal-true predicate'
);

-- INV-11b. MUTATION CONTROL for INV-11 on a partitioned table (T24): a
-- planted org-scoped partitioned table with RLS on and a using (true) policy
-- must be named. Dropped straight after.
create table public._sec_inv_probe_parted (id uuid not null, organization_id uuid not null)
  partition by list (organization_id);
alter table public._sec_inv_probe_parted enable row level security;
create policy _sec_inv_probe_open on public._sec_inv_probe_parted for select using (true);
select is(
  (select coalesce(string_agg(v.x, ' | ' order by v.x collate "C"), '')
     from _sec_inv_literal_true_policies v where v.relname like '\_sec\_inv\_probe\_%'),
  '_sec_inv_probe_parted._sec_inv_probe_open',
  'INV-11b control: the literal-true sweep names a using (true) policy on an org-scoped partitioned table'
);
drop table public._sec_inv_probe_parted;

-- INV-12. Pattern #25 sweep, in BOTH rendered forms. Which form the tautology
-- takes depends on where the unqualified column sat:
--   * inside an EXISTS subquery it binds to the inner relation and renders
--     QUALIFIED — `r.organization_id = r.organization_id`;
--   * written directly against the policy's own table it renders UNQUALIFIED —
--     `organization_id = organization_id`.
-- Only the first leg was written at first, and the second was added after a
-- mutation check showed a hand-made unqualified tautology sailing through. Both
-- legs are needed; neither is sufficient.
select is(
  (select count(*)::int
     from pg_policies
    where schemaname = 'public'
      and (coalesce(qual, '')       ~ '([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*) = \1\.\2'
        or coalesce(with_check, '') ~ '([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*) = \1\.\2'
        or coalesce(qual, '')       ~ '\m([a-z_][a-z0-9_]*) = \1\M'
        or coalesce(with_check, '') ~ '\m([a-z_][a-z0-9_]*) = \1\M')),
  0,
  'INV-12: no policy predicate in public contains a self-comparison tautology (pattern #25)'
);

-- INV-13. VACUITY CONTROL — both legs match the bug they exist for. Without
-- this, a back-reference that silently stopped working (a regex-flavour change,
-- an escaping slip) would make INV-12 pass on a schema full of tautologies. The
-- qualified leg is checked against the real rendered shape of the EXISTS form,
-- not a bare fragment.
select ok(
  '(EXISTS ( SELECT 1 FROM maintenance_requests r WHERE (r.organization_id = r.organization_id)))'
    ~ '([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*) = \1\.\2'
  and '(organization_id = organization_id)'
    ~ '\m([a-z_][a-z0-9_]*) = \1\M',
  'INV-13 control: both pattern-#25 legs match a synthetic self-comparison'
);

-- INV-14. VACUITY CONTROL — neither leg matches a correct predicate. The
-- complement matters as much: a regex that matched everything would make INV-12
-- fail permanently and get neutered. The first string is the exact CORRECT form
-- of the comparison pattern #25 corrupts; the others are the two most common
-- shapes in this schema's real policies.
select ok(
  'r.organization_id = maintenance_request_attachments.organization_id'
    !~ '([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*) = \1\.\2'
  and '(a.organization_id = b.organization_id)'
    !~ '\m([a-z_][a-z0-9_]*) = \1\M'
  and '(user_id = auth.uid())'
    !~ '\m([a-z_][a-z0-9_]*) = \1\M',
  'INV-14 control: neither pattern-#25 leg matches a legitimate comparison'
);


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. STORAGE PATH SHAPE — THE DATABASE FLOOR (HI-8)
--
-- The application fix for HI-8 replaced prefix checks with strict positive
-- shapes, because `path.startsWith(orgId + '/')` passes
-- `${org}/../../other-bucket/victim/x.jpg`: @supabase/storage-js interpolates
-- the path into a fetch() URL and the WHATWG parser resolves `..` before the
-- request leaves Node, escaping the org folder AND the bucket and returning a
-- service-role-signed URL that RLS never evaluated.
--
-- That fix lives in the service layer, and the service layer is not the only
-- writer: `authenticated` holds INSERT on these tables through PostgREST, and
-- at least one live client (the mobile PO-attachments screen) inserts directly.
-- 0323 is the structural floor for every writer. This invariant is what makes
-- the floor apply to the NEXT table that stores a storage path.
--
-- The check detects a constraint mentioning the column together with both the
-- `'..'` and `'%'` literals — the two clauses that refuse the traversal
-- alphabet and every percent-encoded form of it. It deliberately does not
-- fingerprint the whole predicate: pinning exact text would fail on a stricter
-- rewrite, which is the wrong thing to punish.
--
-- `strpos`, not `like`: the fingerprint being searched for CONTAINS a percent
-- sign, and in a LIKE pattern that would be a wildcard. Writing this as
-- `like '%''%''%'` silently degrades to "contains any two quotes", which every
-- constraint with a string literal satisfies — a detector that can no longer
-- fail. strpos has no metacharacters.
-- ═══════════════════════════════════════════════════════════════════════════

-- The binding (T23). A column is guarded when a CHECK constraint on its table
-- COVERS it (its attnum is in the constraint's conkey) and refuses both '..'
-- and '%'. Coverage, not the name: a column called path is not guarded by a
-- sibling photo_storage_path's CHECK because its name sits inside the
-- sibling's. INV-16 asks for the same whole floor as INV-15, so the two
-- agree about every column: a gap column with a '..'-only CHECK is still a
-- gap. INV-15 to INV-18c all read this one function. Residual: a
-- multi-column CHECK that covers a column but tests only its sibling still
-- passes; none exists (every floor CHECK covers exactly its own column).
create function pg_temp.sec_inv_path_guarded(p_rel oid, p_att int2) returns boolean
  language sql stable as $f$
  select exists (
    select 1 from pg_constraint k
     where k.conrelid = p_rel and k.contype = 'c'
       and p_att = any(k.conkey)
       and strpos(pg_get_constraintdef(k.oid), '''..''') > 0
       and strpos(pg_get_constraintdef(k.oid), '''%''') > 0)
$f$;

-- The two sweeps' detector (T23), one view so INV-18b and INV-18c exercise
-- the very same text: an unguarded path column that is not a recorded gap
-- (INV-15), and a gap row whose column is gone or guarded now (INV-16).
create temporary view _sec_inv_path_violations as
  select 'unguarded: ' || c.relname || '.' || a.attname as x, 'unguarded'::text as kind,
         c.relname::text as relname, a.attname::text as attname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
   where n.nspname = 'public' and c.relkind in ('r', 'p')
     and a.attname like '%path%'
     and not pg_temp.sec_inv_path_guarded(c.oid, a.attnum)
     and not exists (select 1 from _sec_inv_path_check_gap g
                      where g.relname = c.relname and g.attname = a.attname)
  union all
  select 'stale gap entry: ' || g.relname || '.' || g.attname, 'stale', g.relname, g.attname
    from _sec_inv_path_check_gap g
   where not exists (
     select 1 from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where n.nspname = 'public' and c.relname = g.relname and a.attname = g.attname
        and not pg_temp.sec_inv_path_guarded(c.oid, a.attnum));

-- INV-15. Every path-bearing column in public carries the traversal floor of
-- its own, unless it is on the recorded known-gap list. Offenders are named.
select is(
  (select coalesce(string_agg(v.x, ', ' order by v.x collate "C"), '') from _sec_inv_path_violations v where v.kind = 'unguarded'),
  '',
  'INV-15: every path-bearing column in public has a traversal-refusing CHECK of its own, or a recorded gap'
);

-- INV-16. No stale gap entry. When a gap is closed, its row here must go in
-- the same change — otherwise the list stops describing the real exposure and
-- the next reader trusts it. (This is how the original five 0323 gaps left:
-- 0326 constrained them and deleted their rows in one diff.)
select is(
  (select coalesce(string_agg(v.x, ', ' order by v.x collate "C"), '') from _sec_inv_path_violations v where v.kind = 'stale'),
  '',
  'INV-16: no stale entry in the storage-path known-gap list (column gone, or now guarded by a CHECK of its own)'
);

-- INV-17. VACUITY CONTROL — the constraint detector fires on a column 0323
-- constrained. If it silently stopped matching, INV-15 would pass by finding
-- nothing to complain about.
select ok(
  (select pg_temp.sec_inv_path_guarded(a.attrelid, a.attnum) from pg_attribute a
    where a.attrelid = 'public.item_images'::regclass and a.attname = 'storage_path'),
  'INV-17 control: the traversal-CHECK detector finds the constraint 0323 put on item_images.storage_path'
);

-- INV-18. VACUITY CONTROL — and does NOT fire on a column that has no such
-- constraint. inventory_items.name is chosen because it is not a path and will
-- never legitimately acquire a traversal CHECK, so this control cannot become a
-- false failure the way pointing it at a known gap would.
select ok(
  (select not pg_temp.sec_inv_path_guarded(a.attrelid, a.attnum) from pg_attribute a
    where a.attrelid = 'public.inventory_items'::regclass and a.attname = 'name'),
  'INV-18 control: the traversal-CHECK detector does not fire on an unconstrained column'
);

-- INV-18b. MUTATION CONTROL for INV-15's binding (T23). A probe table carries
-- the full floor on photo_storage_path, a '..'-only CHECK on thumb_path, and a
-- column called path with no CHECK at all. path and thumb_path are unguarded
-- and must both be named: path's name sits inside photo_storage_path, and a
-- binding by name would count the sibling's CHECK for it.
create table public._sec_inv_probe_path_cols (
  id int primary key,
  photo_storage_path text check (position('..' in photo_storage_path) = 0 and position('%' in photo_storage_path) = 0),
  thumb_path text check (position('..' in thumb_path) = 0),
  path text);
alter table public._sec_inv_probe_path_cols enable row level security;
select is(
  (select coalesce(string_agg(v.x, ' | ' order by v.x collate "C"), '')
     from _sec_inv_path_violations v where v.relname = '_sec_inv_probe_path_cols'),
  'unguarded: _sec_inv_probe_path_cols.path | unguarded: _sec_inv_probe_path_cols.thumb_path',
  'INV-18b control: a path column whose only traversal CHECK covers a sibling, and one whose CHECK lacks the percent clause, are both unguarded'
);

-- INV-18c. MUTATION CONTROL for INV-16's binding (T23): with all three probe
-- columns on the gap list, only photo_storage_path's row is stale. path's
-- row (no CHECK of its own) and thumb_path's ('..' only) are real gaps and
-- must not be called closed.
insert into _sec_inv_path_check_gap (relname, attname, why) values
  ('_sec_inv_probe_path_cols', 'photo_storage_path', 'control probe: guarded by its own CHECK, so stale; deleted below'),
  ('_sec_inv_probe_path_cols', 'thumb_path',         'control probe: a ''..''-only CHECK is a real gap; deleted below'),
  ('_sec_inv_probe_path_cols', 'path',               'control probe: no CHECK of its own is a real gap; deleted below');
select is(
  (select coalesce(string_agg(v.x, ' | ' order by v.x collate "C"), '')
     from _sec_inv_path_violations v where v.relname = '_sec_inv_probe_path_cols'),
  'stale gap entry: _sec_inv_probe_path_cols.photo_storage_path',
  'INV-18c control: the gap audit calls a row stale only when the column''s own CHECK carries the whole floor'
);
delete from _sec_inv_path_check_gap where why like 'control probe:%';
drop table public._sec_inv_probe_path_cols;


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. STORAGE BUCKET EXPOSURE
--
-- `storage.buckets.public = true` serves every object in the bucket from an
-- unauthenticated URL with NO policy evaluation. The object key is the only
-- secret, and object keys in this product are derived from ids that appear in
-- URLs and storage paths. So the public flag, not the bucket's policies, is the
-- decision that matters.
-- ═══════════════════════════════════════════════════════════════════════════

-- INV-19. No bucket becomes public without being added to the allowlist above.
select is(
  (select count(*)::int from storage.buckets b
    where b.public
      and b.id not in (select id from _sec_inv_public_bucket_allow)),
  0,
  'INV-19: no storage bucket is public unless explicitly allowlisted'
);

-- INV-20. Every bucket caps object size. An uncapped bucket is a
-- storage-exhaustion and cost-amplification primitive for any principal that
-- can write to it, and the cap is the only limit that applies to a direct
-- upload that never passes through our server.
select is(
  (select count(*)::int from storage.buckets where file_size_limit is null),
  0,
  'INV-20: every storage bucket sets a file_size_limit'
);

-- INV-21. VACUITY CONTROL. If storage.buckets were empty or unreadable from
-- this session, INV-19 and INV-20 would both pass having examined nothing.
select cmp_ok(
  (select count(*)::int from storage.buckets),
  '>',
  0,
  'INV-21 control: storage.buckets is visible and non-empty from the test session'
);


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. WRITE POLICIES REACHABLE BY anon / PUBLIC MUST BE GATED OR DENY
--
-- A policy created without `TO <role>` applies `TO PUBLIC`, which includes
-- `anon`. That is normal and mostly harmless here because the predicates gate
-- on identity — but it means the ROLE list is not the control, the PREDICATE is.
-- A public-role write policy whose predicate references no identity and no
-- authorization helper is an unauthenticated write, and it would look
-- unremarkable in a migration diff.
--
-- Two shapes are acceptable: the predicate consults identity/authorization, or
-- it is a literal `false` (the deny-all idiom used to make a table
-- append-only-by-trigger, as on mfa_recovery_codes).
-- ═══════════════════════════════════════════════════════════════════════════

-- INV-22. The sweep.
select is(
  (select count(*)::int
     from pg_policies
    where schemaname = 'public'
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
      and (roles @> array['anon']::name[] or roles @> array['public']::name[])
      -- not gated
      and (coalesce(qual, '') || ' ' || coalesce(with_check, ''))
          !~* '(auth\.uid|auth\.jwt|is_org_member|has_org_role|has_permission|current_customer|customer_user|public_link_eligible)'
      -- and not an explicit deny
      and not (coalesce(qual, 'false') = 'false' and coalesce(with_check, 'false') = 'false')),
  0,
  'INV-22: every anon/PUBLIC-reachable write policy consults identity or is an explicit deny'
);

-- INV-23. VACUITY CONTROL. The role test above is the fragile part — a change
-- in how pg_policies renders `roles` would empty the population and INV-22
-- would pass vacuously.
select cmp_ok(
  (select count(*)::int
     from pg_policies
    where schemaname = 'public'
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
      and (roles @> array['anon']::name[] or roles @> array['public']::name[])),
  '>',
  0,
  'INV-23 control: the anon/PUBLIC write-policy sweep still finds policies to judge'
);

-- INV-24. Every bucket pins allowed_mime_types. po-imports was the last
-- unpinned bucket (closed by 0325); an unpinned bucket accepts any
-- content-type on a presigned upload, which is exactly the surface the
-- magic-byte sniffer exists to close from the other side. This sweep makes
-- the property durable against future bucket additions. INV-21 above is the
-- vacuity control for this population too.
select is(
  (select count(*)::int from storage.buckets where allowed_mime_types is null),
  0,
  'INV-24: every storage bucket pins allowed_mime_types'
);


-- ═══════════════════════════════════════════════════════════════════════════
-- NOT ASSERTED HERE — ON PURPOSE
--
-- The ACCEPTED RISKS are pinned in
-- supabase/tests/0322_quantity_guards_avatar_scope_override_clears.test.sql,
-- next to the evidence that justifies them, and are NOT duplicated here:
--   * (RESOLVED by 0327) item_stock_levels.quantity was unconstrained while
--     adjust_stock committed negatives and transfer_stock wrote one before its
--     guard. 0327 fixed both RPCs and added the validated
--     item_stock_levels_quantity_nonneg constraint in the same change; the
--     0322/0324 pins are now INVERTED to assert exactly that constraint.
--   * (RESOLVED by 0331) item_stock_levels_select had to stay org-only while
--     apply_level_delta's draw-down selection ran under the caller's RLS.
--     0331 made apply_level_delta SECURITY DEFINER (with its own org/staff
--     gate) and warehouse-narrowed the policy in the same change; the 0322
--     pin (~line 630) is now INVERTED to assert the warehouse-scoped qual
--     verbatim, and 0331's own test carries the behavioral parity proof.
-- Duplicating those assertions would double the friction of the eventual fix
-- and invite the two copies to drift. The cost of not duplicating is real and
-- should be named: deleting that file removes the pin, and nothing in this
-- file would notice. See docs/security/SECURITY-INVARIANTS.md, "Accepted risks".
--
-- Also not asserted, because no honest generic form exists at this level:
-- pattern #23 (PostgREST `.in()`/`not.in` dropping NULL rows) and pattern #2
-- (`.update().eq()` without `.select().maybeSingle()` failing OPEN) are
-- client-library behaviours in TypeScript, invisible to the database catalog.
-- They are covered by targeted unit tests and by review; see the invariants
-- document.
-- ═══════════════════════════════════════════════════════════════════════════

-- INV-25. The `authenticated` sweep (0346). Every SECURITY DEFINER function in
-- `public` that `authenticated` can execute and that is RPC-invocable must
-- either gate authorization inside its own body or be a defended read-only
-- predicate in allowlist E. This is the check that would have failed on the
-- 0342 head: apply_cycle_count_location_delta wrote stock for any signed-in
-- caller with none of these tokens in its body.
select is(
  (select count(*)::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and p.prorettype <> 'trigger'::regtype
      and has_function_privilege('authenticated', p.oid, 'execute')
      and p.prosrc !~* '(auth\.uid|has_org_role|has_permission|is_org_member)'
      and p.proname not in (select proname from _sec_inv_auth_secdef_nogate_allow)),
  0,
  'INV-25: every authenticated-EXECUTE SECURITY DEFINER function in public gates in its body or is an allowlisted read-only predicate'
);

-- The allowlist audit (T23), read by INV-26 (allowlists E and K), INV-30,
-- INV-30c, INV-31 and INV-32 (allowlist F). An entry loses its exemption when
-- it is stale (no SECURITY DEFINER function of that name in its schema), when
-- its own body writes (the writer forms above, read from the raw text so a
-- write in a format() string counts, and from the text with comments
-- removed) or runs EXECUTE, when its own body has a side effect that is not
-- a table write (the side-effect forms above, T24), when a first-party
-- function it reaches through calls does any of these, or when it reaches a
-- function with no first-party body that is not on allowlist K.
--   * A call is a name followed by "(" in the code skeleton (the body with
--     comments and quoted text removed). A qualified name resolves to that
--     schema; a bare name to every schema on the CALLER's own pinned
--     search_path (public when it pins none), pg_catalog left out, every
--     overload counted, so a bare name can name more functions than the one
--     that runs.
--   * The walk follows first-party callees (non-extension functions in public
--     and ledger) until no new one appears: no depth limit.
--   * Anything else reached (another schema, an extension member anywhere, or
--     a qualified call into another schema that names no function yet) must
--     be on allowlist K.
--   * The writer census is the non-extension functions whose body has a
--     writer form, raw or with comments removed, or whose code skeleton runs
--     EXECUTE.
--   * The side-effect census (T24) is the non-extension functions whose
--     code skeleton has a side-effect form.
-- This reads text. INV-27b refuses a first-party body that holds a form the
-- pass does not follow (listed at _sec_inv_unread_re above), so the skeleton
-- of a body it lets through is split into code, comments and literals the
-- way Postgres splits it. Not seen, as for every text census in this file:
-- calls made through dynamic SQL (EXECUTE in an entry is refused by 0359
-- test 73, and in a callee by the census), operators, casts, triggers and
-- views; of pg_catalog's functions only the side-effect forms are judged.
create temporary view _sec_inv_fn_scope as
  select p.oid, n.nspname::text as nspname, p.proname::text as proname,
         n.nspname || '.' || p.proname as fn, p.prosecdef,
         exists (select 1 from pg_depend d
                  where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e') as ext,
         p.prosrc as raw, p.proconfig as config,
         (select l.lanname::text from pg_language l where l.oid = p.prolang) as lang,
         regexp_replace(p.prosrc, (select re from _sec_inv_strip_re), (select rep from _sec_inv_strip_re), 'g') as s,
         regexp_replace(p.prosrc, (select re from _sec_inv_comment_re), (select rep from _sec_inv_comment_re), 'g') as c,
         n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as sig,
         case when exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
              then coalesce((select array_agg(x)
                               from unnest(p.proconfig) c,
                                    unnest(string_to_array(regexp_replace(substr(c, 13), '[\s"]', '', 'g'), ',')) x
                              where c like 'search_path=%' and x not in ('', '$user', 'pg_temp', 'pg_catalog')), '{}')
              else array['public'] end as path
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname not in ('pg_catalog', 'information_schema')
     and n.nspname !~ '^pg_(toast_)?temp_';

create temporary view _sec_inv_writer_census as
  select f.oid, f.fn from _sec_inv_fn_scope f
   where not f.ext
     and (f.raw ~* (select re from _sec_inv_writer_re)
       or f.c ~* (select re from _sec_inv_writer_re)
       or f.s ~* '\mexecute\M');

create temporary view _sec_inv_side_effect_census as
  select f.oid, f.fn from _sec_inv_fn_scope f
   where not f.ext
     and f.s ~* (select re from _sec_inv_side_effect_re);

create temporary view _sec_inv_call_edges as
  with calls as (
    select f.oid as caller, lower(coalesce(m[1], '')) as qual, lower(m[2]) as nm, f.path
      from _sec_inv_fn_scope f
      cross join lateral regexp_matches(f.s, $re$(?:"?([a-z_][a-z0-9_$]*)"?\s*\.\s*)?"?\m([a-z_][a-z0-9_$]*)"?\s*\($re$, 'gi') m
     where f.nspname in ('public', 'ledger') and not f.ext)
  select c.caller, t.oid as callee, t.fn, (t.nspname in ('public', 'ledger') and not t.ext) as first_party
    from calls c
    join _sec_inv_fn_scope t on t.proname = c.nm
     and ((c.qual <> '' and t.nspname = c.qual) or (c.qual = '' and t.nspname = any(c.path)))
  union
  select c.caller, null, c.qual || '.' || c.nm, false
    from calls c
   where c.qual not in ('', 'public', 'ledger', 'pg_catalog')
     and not exists (select 1 from _sec_inv_fn_scope t where t.nspname = c.qual and t.proname = c.nm);

create temporary view _sec_inv_allowlist_audit as
  with recursive
  listed as (
    select 'E'::text as list, a.proname::text as entry, 'public'::text as nsp from _sec_inv_auth_secdef_nogate_allow a
    union all
    select 'F', a.proname::text, 'ledger' from _sec_inv_ledger_secdef_nogate_allow a),
  reach(list, entry, root, oid) as (
    select l.list, l.entry, f.oid, f.oid
      from listed l join _sec_inv_fn_scope f
        on f.nspname = l.nsp and f.proname = l.entry and f.prosecdef and not f.ext
    union
    select w.list, w.entry, w.root, e.callee
      from reach w join _sec_inv_call_edges e on e.caller = w.oid
     where e.first_party),
  outside as (
    select distinct w.list, w.entry, e.fn
      from reach w join _sec_inv_call_edges e on e.caller = w.oid
     where not e.first_party)
  select distinct v.list, v.entry, v.x from (
    select l.list, l.entry, 'stale allowlist-' || l.list || ' entry: ' || l.entry as x
      from listed l
     where not exists (select 1 from _sec_inv_fn_scope f
                        where f.nspname = l.nsp and f.proname = l.entry and f.prosecdef and not f.ext)
    union all
    select w.list, w.entry, 'allowlist-' || w.list || ' entry writes or runs EXECUTE: ' || f.fn
      from reach w join _sec_inv_fn_scope f on f.oid = w.oid
     where w.oid = w.root and w.oid in (select c.oid from _sec_inv_writer_census c)
    union all
    select w.list, w.entry, 'allowlist-' || w.list || ' entry ' || w.entry || ' reaches a writer: ' || f.fn
      from reach w join _sec_inv_fn_scope f on f.oid = w.oid
     where w.oid <> w.root and w.oid in (select c.oid from _sec_inv_writer_census c)
    union all
    select w.list, w.entry, 'allowlist-' || w.list || ' entry has a side effect (a setting, a sequence, a notification or an advisory lock): ' || f.fn
      from reach w join _sec_inv_fn_scope f on f.oid = w.oid
     where w.oid = w.root and w.oid in (select c.oid from _sec_inv_side_effect_census c)
    union all
    select w.list, w.entry, 'allowlist-' || w.list || ' entry ' || w.entry || ' reaches a function with a side effect (a setting, a sequence, a notification or an advisory lock): ' || f.fn
      from reach w join _sec_inv_fn_scope f on f.oid = w.oid
     where w.oid <> w.root and w.oid in (select c.oid from _sec_inv_side_effect_census c)
    union all
    select o.list, o.entry, 'allowlist-' || o.list || ' entry ' || o.entry || ' reaches a function with no first-party body, not on allowlist K: ' || o.fn
      from outside o
     where o.fn not in (select k.fn from _sec_inv_external_callee_allow k)
    union all
    select 'K', k.fn, 'stale allowlist-K entry: ' || k.fn
      from _sec_inv_external_callee_allow k
     where not exists (select 1 from _sec_inv_fn_scope f where f.fn = k.fn)
        or k.fn not in (select o.fn from outside o)) v;

-- INV-26. No stale entry in allowlist E, and no entry that WRITES or has a
-- side effect (T24), in its own body or through what it calls (T23); and no
-- stale entry in allowlist K. A predicate that grows a write must lose its
-- exemption the same day. Offenders are named.
select is(
  (select coalesce(string_agg(v.x, ', ' order by v.x collate "C"), '')
     from _sec_inv_allowlist_audit v where v.list in ('E', 'K')),
  '',
  'INV-26: allowlist E has no stale entry and no entry that writes, runs EXECUTE or has a side effect, reaches a function that does, or reaches a function with no first-party body that allowlist K does not list; allowlist K has no stale entry'
);


-- ═══════════════════════════════════════════════════════════════════════════
-- 9. EVERY FIRST-PARTY FUNCTION PINS search_path
--
-- An unpinned function resolves unqualified names through the CALLER's
-- search_path. For a SECURITY DEFINER function that is a privilege-escalation
-- primitive; for an invoker one it is still a correctness hazard the moment a
-- body stops schema-qualifying something.
--
-- 0329 pinned "every remaining unpinned first-party function" and proved it by
-- NAMING 22 of them. A name list cannot see the function it forgot:
-- next_po_number (0005) was never on it and stayed unpinned until 0350, and
-- the next `create function` that omits the pin would have been equally
-- invisible. This sweep replaces the enumeration with the property.
--
-- Extension members are excluded on purpose and this is the one exclusion that
-- must never be relaxed: citext lives in `public` because 0001 created it
-- there, and ALTERing an extension's member functions diverges them from the
-- extension's shipped state and breaks dump/restore and extension upgrades
-- (0329's header states this; its test #42 pins it from the other side).
-- ═══════════════════════════════════════════════════════════════════════════

-- The sweep's detector (T23): first-party functions in public, ledger and gate
-- (ledger, 0359, is ours: authenticated holds USAGE and EXECUTE there; so is
-- gate, 0455: anon, authenticated and service_role hold USAGE there), less
-- extension members, with no search_path in proconfig, less allowlist J; and
-- allowlist J's own audit.
create temporary view _sec_inv_search_path_violations as
  with fp as (
    select p.oid, p.oid::regprocedure::text as sig, p.prosecdef,
           exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%') as pinned
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'ledger', 'gate')
       and not exists (select 1 from pg_depend d
                        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')),
  j as (select a.sig, to_regprocedure(a.sig) as oid from _sec_inv_search_path_allow a)
  select 'unpinned: ' || fp.sig as x, fp.sig
    from fp
   where not fp.pinned
     and fp.oid not in (select j.oid from j where j.oid is not null)
  union all
  select 'stale allowlist-J entry (no such first-party function, or pinned now): ' || j.sig, j.sig
    from j
   where not exists (select 1 from fp where fp.oid = j.oid and not fp.pinned)
  union all
  select 'allowlist-J entry outside its terms (SECURITY DEFINER, or an API role may execute it): ' || j.sig, j.sig
    from j join fp on fp.oid = j.oid
   where not fp.pinned
     and (fp.prosecdef
      or has_function_privilege('anon', fp.oid, 'execute')
      or has_function_privilege('authenticated', fp.oid, 'execute')
      or has_function_privilege('service_role', fp.oid, 'execute'));

-- The first-party census (T23). Every migration runs as postgres and none
-- hands a function to another owner, so a first-party function is a
-- non-extension function owned by postgres; the platform's own functions
-- (auth, storage, realtime, extensions) belong to its own roles, and all of
-- net and cron are pg_net and pg_cron members. Three things are refused:
--   * a first-party function in a schema INV-27 does not sweep (a new schema
--     forces the decision here). USAGE is not the test: a trigger function
--     fires for a role with no USAGE on its schema, under that role's
--     search_path;
--   * a first-party function in public, ledger or gate with an SQL-standard body
--     (BEGIN ATOMIC, or RETURN with no AS string): its prosrc is empty, and
--     every text census in this suite reads prosrc, so such a body would be
--     invisible to all of them;
--   * a first-party function in public, ledger or gate whose body the strip pass
--     does not follow: one of the forms of _sec_inv_unread_re, a quote left
--     once the pass is done, standard_conforming_strings in the function's
--     own SET clause, or a body written in a language other than SQL or
--     PL/pgSQL. The text censuses read a body through that pass, so each of
--     them would misread what comes after such a form.
create temporary view _sec_inv_first_party_census as
  select 'unswept schema: ' || n.nspname as x, n.nspname::text as nspname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where pg_get_userbyid(p.proowner) = 'postgres'
     and n.nspname not in ('public', 'ledger', 'gate')
     and n.nspname !~ '^pg_(toast_)?temp_'
     and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
   group by n.nspname
  union all
  select 'sql-standard body: ' || p.oid::regprocedure::text, n.nspname::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'ledger', 'gate')
     and p.prosqlbody is not null
     and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  union all
  select 'body the text censuses do not follow (' || u.form || '): ' || f.sig, f.nspname
    from _sec_inv_fn_scope f join _sec_inv_unread_re u on f.raw ~* u.re
   where f.nspname in ('public', 'ledger', 'gate') and not f.ext
  union all
  select 'body the text censuses do not follow (a quote left after the pass): ' || f.sig, f.nspname
    from _sec_inv_fn_scope f
   where f.nspname in ('public', 'ledger', 'gate') and not f.ext
     and position('''' in replace(f.s, '''''', '')) > 0
  union all
  select 'body the text censuses do not follow (standard_conforming_strings in its SET clause): ' || f.sig, f.nspname
    from _sec_inv_fn_scope f
   where f.nspname in ('public', 'ledger', 'gate') and not f.ext
     and exists (select 1 from unnest(f.config) k where k ~* '^standard_conforming_strings=')
  union all
  select 'body the text censuses do not follow (written in ' || f.lang || ', not SQL or PL/pgSQL): ' || f.sig, f.nspname
    from _sec_inv_fn_scope f
   where f.nspname in ('public', 'ledger', 'gate') and not f.ext
     and f.lang not in ('sql', 'plpgsql');

-- INV-27. The sweep. Offenders are named.
select is(
  (select coalesce(string_agg(v.x, ', ' order by v.x collate "C"), '') from _sec_inv_search_path_violations v),
  '',
  'INV-27: every first-party function in public, ledger and gate pins search_path, or is on allowlist J and within its terms'
);

-- INV-27b. The census (T23): every first-party function lives in a schema
-- INV-27 sweeps, and none in public, ledger or gate hides its body from prosrc or
-- holds a form the strip pass does not follow.
select is(
  (select coalesce(string_agg(c.x, ', ' order by c.x collate "C"), '') from _sec_inv_first_party_census c),
  '',
  'INV-27b: every first-party function (non-extension, owned by postgres) lives in public, ledger or gate, and none there has an SQL-standard body or a body the text censuses do not follow'
);

-- INV-28. VACUITY CONTROL, both halves of the detector.
--   * The population is non-empty — if the pg_depend exclusion ever matched
--     everything, INV-27 would pass having judged nothing.
--   * The unpinned test still FIRES on something known to be unpinned. The
--     citext members are exactly that population (deliberately never ALTERed,
--     so their proconfig is NULL); if a catalog change broke the proconfig
--     probe so that it reported every function as pinned, this half goes red
--     instead of INV-27 going quietly green.
select ok(
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (select 1 from pg_depend d
                       where d.objid = p.oid and d.deptype = 'e')) > 20
  and
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'ledger'
      and not exists (select 1 from pg_depend d
                       where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')) > 0
  and
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and pg_get_userbyid(p.proowner) = 'postgres'
      and not exists (select 1 from pg_depend d
                       where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')) > 20
  and
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and exists (select 1 from pg_depend d
                   where d.objid = p.oid and d.deptype = 'e')
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c
                       where c like 'search_path=%')) > 0,
  'INV-28 control: the search_path sweep has first-party functions to judge in public and ledger, the census''s owner test sees them, and the unpinned detector still fires on the (excluded) extension members'
);

-- INV-28b. MUTATION CONTROL for INV-27 and INV-27b (T23). Planted: a ledger
-- function with no SET clause; a second, unpinned overload of the allowlisted
-- ledger._seal (the signature key must not exempt it); allowlist-J rows for a
-- missing function, for a pinned one, and for an unpinned SECURITY DEFINER
-- function authenticated may execute; a first-party function in a new schema;
-- a pinned ledger function with an SQL-standard body; and six pinned ledger
-- functions the strip pass does not follow (an E'' string with
-- backslash-escaped quotes, the same where the escaped quotes sit in the
-- part of the string that goes on after a line break, a dollar-quoted
-- literal, a comment inside a comment, a quote inside a double-quoted
-- identifier, which is left once the pass is done, and
-- standard_conforming_strings in the SET clause). Each must be named, by its
-- own form alone. A seventh holds what the pass does follow (plain literals
-- that end in a backslash, E'' strings with no escaped quote, two comments
-- in a row, a doubled quote, a quote in a line comment) and must not be
-- named. No function in another language can be planted by the role these
-- tests run as, so the language test is shown to fire on the extension
-- members it leaves out (citext's C functions in public), the way INV-28
-- shows the unpinned test. Everything planted is removed straight after.
create function ledger._sec_inv_probe_escaped_quote() returns int
  language plpgsql set search_path = public
  as $probe$ declare v text; begin v := E'it\'s' || E'a\'b'; return 1; end; $probe$;
create function ledger._sec_inv_probe_escaped_quote_continued() returns int
  language plpgsql set search_path = public
  as $probe$ declare v text; begin v := E'one'
    'it\'s' || E'two'
    'a\'b'; return 1; end; $probe$;
create function ledger._sec_inv_probe_dollar_literal() returns int
  language plpgsql set search_path = public
  as $probe$ declare v text; begin v := $q$it's$q$ || $q$it's$q$; return 1; end; $probe$;
create function ledger._sec_inv_probe_nested_comment() returns int
  language plpgsql set search_path = public
  as $probe$ begin /* outer /* inner */ don't, won't */ return 1; end; $probe$;
create function ledger._sec_inv_probe_quote_left() returns int
  language sql set search_path = public
  as $probe$ select 1 as "it's" $probe$;
create function ledger._sec_inv_probe_scs_off() returns int
  language sql set search_path = public set standard_conforming_strings = off
  as $probe$ select 1 $probe$;
create function ledger._sec_inv_probe_readable(text) returns text
  language sql immutable set search_path = public
  as $probe$
  /* one */ /* two */ select replace(replace($1, '\', '\\'), E'\\', E'\n') || 'it''s' -- done's
  $probe$;
revoke all on function ledger._sec_inv_probe_escaped_quote(), ledger._sec_inv_probe_escaped_quote_continued(),
  ledger._sec_inv_probe_dollar_literal(),
  ledger._sec_inv_probe_nested_comment(), ledger._sec_inv_probe_quote_left(), ledger._sec_inv_probe_scs_off(),
  ledger._sec_inv_probe_readable(text) from public, anon;
create function ledger._sec_inv_probe_unpinned() returns int
  language sql
  as $probe$ select 1 $probe$;
create function ledger._seal(p_probe integer) returns int
  language sql
  as $probe$ select 1 $probe$;
create function ledger._sec_inv_probe_unpinned_definer() returns int
  language sql
  security definer
  as $probe$ select 1 $probe$;
create function ledger._sec_inv_probe_atomic() returns int
  language sql
  set search_path = public
  begin atomic
    select 1;
  end;
revoke all on function ledger._sec_inv_probe_unpinned(), ledger._seal(integer), ledger._sec_inv_probe_atomic(),
  ledger._sec_inv_probe_unpinned_definer() from public, anon;
grant execute on function ledger._sec_inv_probe_unpinned_definer() to authenticated;
insert into _sec_inv_search_path_allow (sig, why) values
  ('ledger._sec_inv_probe_absent()',           'control probe: stale, no such function; deleted below'),
  ('ledger.active()',                          'control probe: stale, the function is pinned; deleted below'),
  ('ledger._sec_inv_probe_unpinned_definer()', 'control probe: outside the terms (DEFINER, authenticated EXECUTE); deleted below');
create schema _sec_inv_probe_schema;
create function _sec_inv_probe_schema.f() returns int
  language sql
  set search_path = public
  as $probe$ select 1 $probe$;

select is(
  (select coalesce(string_agg(q.x, ' | ' order by q.x collate "C"), '') from (
     select v.x from _sec_inv_search_path_violations v
      where v.sig like '%\_sec\_inv\_probe\_%' or v.sig in ('ledger._seal(integer)', 'ledger.active()')
     union all
     select c.x from _sec_inv_first_party_census c where c.x like '%\_sec\_inv\_probe\_%') q)
  || ' | the language test fires on an extension member: ' ||
  (exists (select 1 from _sec_inv_fn_scope f
            where f.nspname = 'public' and f.ext and f.lang not in ('sql', 'plpgsql')))::text,
  'allowlist-J entry outside its terms (SECURITY DEFINER, or an API role may execute it): ledger._sec_inv_probe_unpinned_definer() | '
  'body the text censuses do not follow (a backslash-escaped quote in an E string): ledger._sec_inv_probe_escaped_quote() | '
  'body the text censuses do not follow (a backslash-escaped quote in an E string): ledger._sec_inv_probe_escaped_quote_continued() | '
  'body the text censuses do not follow (a comment inside a comment): ledger._sec_inv_probe_nested_comment() | '
  'body the text censuses do not follow (a dollar-quoted literal): ledger._sec_inv_probe_dollar_literal() | '
  'body the text censuses do not follow (a quote left after the pass): ledger._sec_inv_probe_quote_left() | '
  'body the text censuses do not follow (standard_conforming_strings in its SET clause): ledger._sec_inv_probe_scs_off() | '
  'sql-standard body: ledger._sec_inv_probe_atomic() | '
  'stale allowlist-J entry (no such first-party function, or pinned now): ledger._sec_inv_probe_absent() | '
  'stale allowlist-J entry (no such first-party function, or pinned now): ledger.active() | '
  'unpinned: ledger._seal(integer) | '
  'unpinned: ledger._sec_inv_probe_unpinned() | '
  'unswept schema: _sec_inv_probe_schema'
  ' | the language test fires on an extension member: true',
  'INV-28b control: the search_path sweep reaches ledger and keys allowlist J on the signature, J''s audit names a missing, a pinned and an out-of-terms entry, and the census names a planted schema, an SQL-standard body and each form of body the strip pass does not follow, and its language test fires'
);

delete from _sec_inv_search_path_allow where why like 'control probe:%';
drop function ledger._sec_inv_probe_escaped_quote();
drop function ledger._sec_inv_probe_escaped_quote_continued();
drop function ledger._sec_inv_probe_dollar_literal();
drop function ledger._sec_inv_probe_nested_comment();
drop function ledger._sec_inv_probe_quote_left();
drop function ledger._sec_inv_probe_scs_off();
drop function ledger._sec_inv_probe_readable(text);
drop function ledger._sec_inv_probe_unpinned();
drop function ledger._seal(integer);
drop function ledger._sec_inv_probe_unpinned_definer();
drop function ledger._sec_inv_probe_atomic();
drop function _sec_inv_probe_schema.f();
drop schema _sec_inv_probe_schema;


-- ═══════════════════════════════════════════════════════════════════════════
-- 10. THE `authenticated` SWEEP MUST STILL BE ABLE TO FAIL
--
-- INV-25/26 shipped with 0346 and were green the day they landed, which is
-- also exactly what a check that has quietly stopped checking looks like.
-- Every other sweep in this file carries a control for that reason (INV-21,
-- INV-23, INV-28); these two arrived without one, and the defect class they
-- police — a SECURITY DEFINER helper holding `authenticated` EXECUTE with no
-- authorization gate in its body — is the one that kept a cross-org stock-write
-- primitive (apply_cycle_count_location_delta, 0342) reachable at
-- POST /rest/v1/rpc/ for twelve migrations while 55 green per-migration tests
-- and `pnpm security:test` reported success.
--
-- INV-29 RESTATES the predicate it exercises instead of sharing one expression
-- with INV-25. INV-30 and INV-30c read the allowlist audit view INV-26 reads
-- (T23), the way section 14's controls read its detector views: each plants
-- probes and expects their exact lines, so a view that stopped discriminating
-- fails here, and the call walk exists once instead of in copies that drift.
-- ═══════════════════════════════════════════════════════════════════════════

-- INV-29. VACUITY + MUTATION CONTROL for INV-25, both halves of the detector.
--   * The population is non-empty. `has_function_privilege('authenticated', …)`
--     is the fragile clause — a grants-posture change that emptied it would
--     leave INV-25 passing having judged nothing at all.
--   * The detector still FIRES. The probe below is created with exactly the
--     shape 0346 closed: SECURITY DEFINER, non-trigger return type, EXECUTE to
--     `authenticated`, and not one authorization token anywhere in its body.
--     INV-25's predicate must pick it out. The count is narrowed to the probe's
--     own name so this control stays truthful (and diagnostic) on a day when
--     INV-25 is legitimately red for some other function.
--
-- A bare `create function` grants EXECUTE to PUBLIC, which would make the probe
-- an anon-reachable definer function — the very thing INV-1 exists to catch —
-- so it is revoked immediately, then dropped once judged. The enclosing
-- `rollback` is the second belt on that.
create function public._sec_inv_probe_ungated_secdef() returns int
  language sql
  security definer
  set search_path = public
  as $probe$ select 1 $probe$;
revoke all on function public._sec_inv_probe_ungated_secdef() from public, anon;
grant execute on function public._sec_inv_probe_ungated_secdef() to authenticated;

select ok(
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and p.prorettype <> 'trigger'::regtype
      and has_function_privilege('authenticated', p.oid, 'execute')) > 20
  and
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and p.prorettype <> 'trigger'::regtype
      and has_function_privilege('authenticated', p.oid, 'execute')
      and p.prosrc !~* '(auth\.uid|has_org_role|has_permission|is_org_member)'
      and p.proname not in (select proname from _sec_inv_auth_secdef_nogate_allow)
      and p.proname = '_sec_inv_probe_ungated_secdef') = 1,
  'INV-29 control: the authenticated sweep has definer functions to judge, and its ungated-body detector still fires on a planted probe'
);

drop function public._sec_inv_probe_ungated_secdef();

-- INV-30. MUTATION CONTROL for INV-26, both of ITS detectors. INV-26 is what
-- stops allowlist E from becoming a place to hide: an entry naming a function
-- that no longer exists (or was never a definer function) is stale, and an
-- entry whose body has grown a write is an exemption that was granted for a
-- read-only predicate and no longer describes one. Two probe rows are planted
-- here — one absent name, one real function known to INSERT — and both must be
-- caught. The count is narrowed to the probe names for the same reason as
-- INV-29. The rows are deleted immediately after so nothing downstream sees a
-- doctored allowlist.
insert into _sec_inv_auth_secdef_nogate_allow (proname, why) values
  ('_sec_inv_probe_absent_function',   'control probe: stale entry; deleted two statements below'),
  ('apply_cycle_count_location_delta', 'control probe: allowlisted body that WRITES; deleted two statements below');

select is(
  (select string_agg(v.x, ' | ' order by v.x collate "C")
     from _sec_inv_allowlist_audit v
    where v.entry in ('_sec_inv_probe_absent_function', 'apply_cycle_count_location_delta')
      and (v.x like 'stale %' or v.x like '% entry writes or runs EXECUTE: %')),
  'allowlist-E entry writes or runs EXECUTE: public.apply_cycle_count_location_delta | stale allowlist-E entry: _sec_inv_probe_absent_function',
  'INV-30 control: the allowlist-E audit still catches both a stale entry and an entry whose body writes'
);

delete from _sec_inv_auth_secdef_nogate_allow where why like 'control probe:%';

-- INV-30b. MUTATION CONTROL for the writer detector itself (0395, L19): one
-- probe per writer form must match, and the read-only shapes that share a
-- keyword must not. A detector that lost a form would let an allowlisted
-- predicate grow that write unnoticed.
select is(
  (select string_agg(v.form || '=' || (v.src ~* (select re from _sec_inv_writer_re))::text, ', ' order by v.n)
     from (values
       (1, 'insert into',          $s$insert into public.t (a) values (1);$s$),
       (2, 'merge into',           $s$merge into public.t x using (select 1 as a) s on x.a = s.a when matched then delete;$s$),
       (3, 'merge into only',      $s$merge into only t x using (select 1 as a) s on x.a = s.a when not matched then insert (a) values (s.a);$s$),
       (4, 'update public',        $s$update public.t set a = 1;$s$),
       (5, 'update only',          $s$update only public.t set a = 1;$s$),
       (6, 'update unqualified',   $s$update t set a = 1 where a = 2;$s$),
       (7, 'update quoted alias',  $s$update "public"."t" as x set a = 1;$s$),
       (8, 'delete from only',     $s$delete from only public.t where a = 1;$s$),
       (9, 'read: for update of',  $s$select a from public.t x where a = 1 for update of x;$s$),
       (10, 'read: on update',     $s$select 1 where 'on update cascade' is not null;$s$),
       (11, 'update ledger',       $s$update ledger.t set a = 1;$s$),
       (12, 'update auth',         $s$update auth.users set a = 1;$s$),
       (13, 'update only quoted ledger alias', $s$update only "ledger"."t" as x set a = 1;$s$),
       (14, 'insert into ledger',  $s$insert into ledger.t (a) values (1);$s$),
       (15, 'delete from auth',    $s$delete from auth.users where false;$s$),
       (16, 'truncate',            $s$truncate public.t;$s$),
       (17, 'truncate table only', $s$truncate table only ledger.t restart identity;$s$),
       (18, 'read: for no key update', $s$select a from ledger.t for no key update skip locked;$s$),
       (19, 'read: date_trunc',    $s$select date_trunc('day', now());$s$),
       (20, 'read: truncated column', $s$select x.truncated, trunc(1.5) from public.t x;$s$),
       (21, 'update star',         $s$update public.t * set a = 1;$s$),
       (22, 'update only in parentheses', $s$update only (ledger.t) set a = 1;$s$),
       (23, 'update database-qualified', $s$update postgres.public.t set a = 1;$s$),
       (24, 'update quoted name with spaces', $s$update public."my big table" as x set a = 1;$s$),
       (25, 'read: for update nowait', $s$select a from public.t for update nowait;$s$),
       (26, 'read: update in trigger words', $s$select 'after insert or update of a on public.t' as t;$s$)) v(n, form, src)),
  'insert into=true, merge into=true, merge into only=true, update public=true, update only=true, '
  'update unqualified=true, update quoted alias=true, delete from only=true, read: for update of=false, read: on update=false, '
  'update ledger=true, update auth=true, update only quoted ledger alias=true, insert into ledger=true, delete from auth=true, '
  'truncate=true, truncate table only=true, read: for no key update=false, read: date_trunc=false, read: truncated column=false, '
  'update star=true, update only in parentheses=true, update database-qualified=true, update quoted name with spaces=true, '
  'read: for update nowait=false, read: update in trigger words=false',
  'INV-30b control: the writer detector catches every write form (INSERT, MERGE [ONLY], UPDATE [ONLY] of a table in any schema, under any qualifiers, quoted or not, with or without * or parentheses, DELETE FROM [ONLY], TRUNCATE) and no read'
);

-- INV-30c. MUTATION CONTROL for the walk (T23). Seven planted entries write
-- nothing in their own bodies, and each reaches something it must not: a
-- writer by a direct call (an UPDATE of a ledger table), a writer two calls
-- down and three calls down (the walk has no depth limit), a function that
-- runs EXECUTE, net.http_post (an extension member, no body to read), and,
-- through a callee pinned to search_path = public, extensions, a bare
-- extensions function; one is an allowlist-F entry. An eighth entry writes in
-- its own body, with a comment between the table and SET, a statement only
-- the comment-removed reading holds as one form. A planted allowlist-K row
-- naming no function is stale. Each must be named. Everything planted is
-- removed straight after (the enclosing rollback is the second belt).
create function public._sec_inv_probe_split_update() returns boolean
  language plpgsql security definer set search_path = public
  as $probe$
  begin
    update ledger._sec_inv_probe_absent_table -- a comment between the table and SET
       set a = 1 where false;
    return true;
  end; $probe$;
create function public._sec_inv_probe_writer() returns void
  language plpgsql security invoker set search_path = public
  as $probe$ begin update ledger._sec_inv_probe_absent_table set a = 1 where false; end; $probe$;
create function public._sec_inv_probe_reader() returns boolean
  language plpgsql security invoker set search_path = public
  as $probe$ begin perform public._sec_inv_probe_writer(); return true; end; $probe$;
create function public._sec_inv_probe_relay() returns boolean
  language plpgsql security invoker set search_path = public
  as $probe$ begin return _sec_inv_probe_reader(); end; $probe$;
create function public._sec_inv_probe_dynamic() returns boolean
  language plpgsql security invoker set search_path = public
  as $probe$ begin execute 'select 1'; return true; end; $probe$;
create function public._sec_inv_probe_ext_path() returns boolean
  language plpgsql security invoker set search_path = public, extensions
  as $probe$ begin perform gen_random_bytes(1); return true; end; $probe$;
create function public._sec_inv_probe_calls_writer() returns boolean
  language plpgsql security definer set search_path = public
  as $probe$ begin perform public._sec_inv_probe_writer(); return true; end; $probe$;
create function public._sec_inv_probe_calls_reader() returns boolean
  language plpgsql security definer set search_path = public
  as $probe$ begin return _sec_inv_probe_reader(); end; $probe$;
create function public._sec_inv_probe_calls_relay() returns boolean
  language plpgsql security definer set search_path = public
  as $probe$ begin return public._sec_inv_probe_relay(); end; $probe$;
create function public._sec_inv_probe_calls_dynamic() returns boolean
  language plpgsql security definer set search_path = public
  as $probe$ begin return public._sec_inv_probe_dynamic(); end; $probe$;
create function public._sec_inv_probe_calls_external() returns boolean
  language plpgsql security definer set search_path = public
  as $probe$ begin perform net.http_post('http://127.0.0.1/'); return true; end; $probe$;
create function public._sec_inv_probe_calls_ext_path() returns boolean
  language plpgsql security definer set search_path = public
  as $probe$ begin return public._sec_inv_probe_ext_path(); end; $probe$;
create function ledger._sec_inv_probe_calls_writer() returns boolean
  language plpgsql security definer set search_path = public
  as $probe$ begin perform public._sec_inv_probe_writer(); return true; end; $probe$;
revoke all on function public._sec_inv_probe_writer(), public._sec_inv_probe_reader(), public._sec_inv_probe_relay(),
  public._sec_inv_probe_dynamic(), public._sec_inv_probe_ext_path(), public._sec_inv_probe_calls_writer(),
  public._sec_inv_probe_calls_reader(), public._sec_inv_probe_calls_relay(), public._sec_inv_probe_calls_dynamic(),
  public._sec_inv_probe_calls_external(), public._sec_inv_probe_calls_ext_path(), ledger._sec_inv_probe_calls_writer(),
  public._sec_inv_probe_split_update()
  from public, anon;
insert into _sec_inv_auth_secdef_nogate_allow (proname, why) values
  ('_sec_inv_probe_split_update',   'control probe: writes in its own body, with a comment inside the statement; deleted below'),
  ('_sec_inv_probe_calls_writer',   'control probe: reaches a writer by a direct call; deleted below'),
  ('_sec_inv_probe_calls_reader',   'control probe: reaches a writer two calls down; deleted below'),
  ('_sec_inv_probe_calls_relay',    'control probe: reaches a writer three calls down; deleted below'),
  ('_sec_inv_probe_calls_dynamic',  'control probe: reaches a function that runs EXECUTE; deleted below'),
  ('_sec_inv_probe_calls_external', 'control probe: calls an extension member in another schema; deleted below'),
  ('_sec_inv_probe_calls_ext_path', 'control probe: reaches a bare extensions function; deleted below');
insert into _sec_inv_ledger_secdef_nogate_allow (proname, why) values
  ('_sec_inv_probe_calls_writer', 'control probe: allowlist-F entry reaching a writer; deleted below');
insert into _sec_inv_external_callee_allow (fn, why) values
  ('auth._sec_inv_probe_absent', 'control probe: stale, no such function; deleted below');

select is(
  (select coalesce(string_agg(v.x, ' | ' order by v.x collate "C"), '')
     from _sec_inv_allowlist_audit v where v.entry like '%\_sec\_inv\_probe\_%'),
  'allowlist-E entry _sec_inv_probe_calls_dynamic reaches a writer: public._sec_inv_probe_dynamic | '
  'allowlist-E entry _sec_inv_probe_calls_ext_path reaches a function with no first-party body, not on allowlist K: extensions.gen_random_bytes | '
  'allowlist-E entry _sec_inv_probe_calls_external reaches a function with no first-party body, not on allowlist K: net.http_post | '
  'allowlist-E entry _sec_inv_probe_calls_reader reaches a writer: public._sec_inv_probe_writer | '
  'allowlist-E entry _sec_inv_probe_calls_relay reaches a writer: public._sec_inv_probe_writer | '
  'allowlist-E entry _sec_inv_probe_calls_writer reaches a writer: public._sec_inv_probe_writer | '
  'allowlist-E entry writes or runs EXECUTE: public._sec_inv_probe_split_update | '
  'allowlist-F entry _sec_inv_probe_calls_writer reaches a writer: public._sec_inv_probe_writer | '
  'stale allowlist-K entry: auth._sec_inv_probe_absent',
  'INV-30c control: the allowlist audit follows calls to any depth and through a callee''s own search_path, names writers, EXECUTE and functions with no first-party body, for allowlists E and F, names a write with a comment inside the statement, and names a stale allowlist-K row'
);

delete from _sec_inv_auth_secdef_nogate_allow where why like 'control probe:%';
delete from _sec_inv_ledger_secdef_nogate_allow where why like 'control probe:%';
delete from _sec_inv_external_callee_allow where why like 'control probe:%';
drop function public._sec_inv_probe_split_update();
drop function public._sec_inv_probe_calls_writer();
drop function public._sec_inv_probe_calls_reader();
drop function public._sec_inv_probe_calls_relay();
drop function public._sec_inv_probe_calls_dynamic();
drop function public._sec_inv_probe_calls_external();
drop function public._sec_inv_probe_calls_ext_path();
drop function ledger._sec_inv_probe_calls_writer();
drop function public._sec_inv_probe_relay();
drop function public._sec_inv_probe_reader();
drop function public._sec_inv_probe_dynamic();
drop function public._sec_inv_probe_ext_path();
drop function public._sec_inv_probe_writer();

-- INV-30d. VACUITY + MUTATION CONTROL for the side-effect forms (T24), one
-- probe per form, read the way the census reads a body: comments and quoted
-- text removed first. Seven must not match: a setting read, the names in a
-- comment and in a message, an UPDATE's SET (the writer forms' business),
-- column names that contain the words, a row lock, a sequence read and a
-- double-quoted name that is none of the functions. The last one is a call
-- on the same line as a comment that a carriage return has ended: it is
-- code, and must match.
select is(
  (select string_agg(v.form || '=' ||
                     (regexp_replace(v.src, (select re from _sec_inv_strip_re), (select rep from _sec_inv_strip_re), 'g')
                        ~* (select re from _sec_inv_side_effect_re))::text, ', ' order by v.n)
     from (values
       (1, 'set_config',          $s$perform set_config('request.jwt.claim.sub', v, true);$s$),
       (2, 'setval',              $s$select setval('public.s', 1);$s$),
       (3, 'nextval',             $s$v := nextval('public.s');$s$),
       (4, 'pg_notify',           $s$perform pg_notify('ch', 'x');$s$),
       (5, 'advisory lock',       $s$perform pg_advisory_xact_lock(1);$s$),
       (6, 'try advisory lock',   $s$if pg_try_advisory_xact_lock(1, 2) then return true; end if;$s$),
       (7, 'set local',           $s$begin set local lock_timeout to '1s'; return true; end;$s$),
       (8, 'set role',            $s$if v then set role authenticated; end if;$s$),
       (9, 'reset',               $s$v := 1; reset role;$s$),
       (10, 'notify',             $s$v := 1; notify ch;$s$),
       (11, 'read: current_setting', $s$v := current_setting('request.jwt.claim.sub', true);$s$),
       (12, 'read: names in a comment and a message', $s$-- set_config( and ; set role
  v := 'pg_notify(1); reset all';$s$),
       (13, 'not a statement: update set', $s$update public.t set a = 1;$s$),
       (14, 'read: column names', $s$select t.reset_at, t.set_id, t.notify from public.t t;$s$),
       (15, 'read: for update',   $s$select 1 from public.t for update;$s$),
       (16, 'read: currval',      $s$v := currval('public.s');$s$),
       (17, 'quoted set_config',  $s$perform pg_catalog."set_config"('request.jwt.claim.sub', v, true);$s$),
       (18, 'quoted pg_notify',   $s$perform "pg_notify"('ch', 'x');$s$),
       (19, 'read: quoted position', $s$select "position"('a' in 'b');$s$),
       (20, 'set_config after a comment ended by a carriage return', E'-- a comment\rperform set_config(''a.b'', ''1'', true);')) v(n, form, src)),
  'set_config=true, setval=true, nextval=true, pg_notify=true, advisory lock=true, try advisory lock=true, '
  'set local=true, set role=true, reset=true, notify=true, read: current_setting=false, '
  'read: names in a comment and a message=false, not a statement: update set=false, read: column names=false, '
  'read: for update=false, read: currval=false, quoted set_config=true, quoted pg_notify=true, read: quoted position=false, '
  'set_config after a comment ended by a carriage return=true',
  'INV-30d control: the side-effect detector catches set_config, setval, nextval, pg_notify, an advisory lock (the function''s name bare or double-quoted) and a SET, RESET or NOTIFY statement, and no read'
);

-- INV-30e. MUTATION CONTROL for the side-effect arm of the audit (T24). Three
-- planted entries write no table: one sets request.jwt.claim.sub in its own
-- body, one reaches a function two calls down that sends a notification, and
-- an allowlist-F entry runs SET LOCAL. Each must be named. A fourth only
-- reads the setting and names the forms in a comment and a message; it must
-- not be named. Everything planted is removed straight after.
create function public._sec_inv_probe_notifier() returns boolean
  language plpgsql security invoker set search_path = public
  as $probe$ begin perform pg_notify('_sec_inv_probe', ''); return true; end; $probe$;
create function public._sec_inv_probe_notify_relay() returns boolean
  language plpgsql security invoker set search_path = public
  as $probe$ begin return public._sec_inv_probe_notifier(); end; $probe$;
create function public._sec_inv_probe_sets_claim() returns boolean
  language plpgsql security definer set search_path = public
  as $probe$ begin perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000000', true); return true; end; $probe$;
create function public._sec_inv_probe_reaches_notify() returns boolean
  language plpgsql security definer set search_path = public
  as $probe$ begin return public._sec_inv_probe_notify_relay(); end; $probe$;
create function public._sec_inv_probe_reads_claim() returns boolean
  language plpgsql security definer set search_path = public
  as $probe$
  -- set_config('request.jwt.claim.sub', ...) is only named here
  begin return current_setting('request.jwt.claim.sub', true) is distinct from 'set role; pg_notify('; end; $probe$;
create function ledger._sec_inv_probe_runs_set() returns boolean
  language plpgsql security definer set search_path = public
  as $probe$ begin set local lock_timeout to '1s'; return true; end; $probe$;
revoke all on function public._sec_inv_probe_notifier(), public._sec_inv_probe_notify_relay(),
  public._sec_inv_probe_sets_claim(), public._sec_inv_probe_reaches_notify(), public._sec_inv_probe_reads_claim(),
  ledger._sec_inv_probe_runs_set() from public, anon;
insert into _sec_inv_auth_secdef_nogate_allow (proname, why) values
  ('_sec_inv_probe_sets_claim',     'control probe: sets an identity setting in its own body; deleted below'),
  ('_sec_inv_probe_reaches_notify', 'control probe: reaches a notification two calls down; deleted below'),
  ('_sec_inv_probe_reads_claim',    'control probe: reads a setting and names the forms in a comment and a message; deleted below');
insert into _sec_inv_ledger_secdef_nogate_allow (proname, why) values
  ('_sec_inv_probe_runs_set', 'control probe: allowlist-F entry running SET LOCAL; deleted below');

select is(
  (select coalesce(string_agg(v.x, ' | ' order by v.x collate "C"), '')
     from _sec_inv_allowlist_audit v where v.entry like '%\_sec\_inv\_probe\_%'),
  'allowlist-E entry _sec_inv_probe_reaches_notify reaches a function with a side effect (a setting, a sequence, a notification or an advisory lock): public._sec_inv_probe_notifier | '
  'allowlist-E entry has a side effect (a setting, a sequence, a notification or an advisory lock): public._sec_inv_probe_sets_claim | '
  'allowlist-F entry has a side effect (a setting, a sequence, a notification or an advisory lock): ledger._sec_inv_probe_runs_set',
  'INV-30e control: the allowlist audit names an entry that changes a setting in its own body or reaches a notification through calls, for allowlists E and F, and leaves a setting read alone'
);

delete from _sec_inv_auth_secdef_nogate_allow where why like 'control probe:%';
delete from _sec_inv_ledger_secdef_nogate_allow where why like 'control probe:%';
drop function public._sec_inv_probe_sets_claim();
drop function public._sec_inv_probe_reaches_notify();
drop function public._sec_inv_probe_reads_claim();
drop function ledger._sec_inv_probe_runs_set();
drop function public._sec_inv_probe_notify_relay();
drop function public._sec_inv_probe_notifier();


-- ═══════════════════════════════════════════════════════════════════════════
-- 11. THE `ledger` SCHEMA IS SWEPT TOO (0371)
--
-- INV-25 looks at `public` only, because that is what PostgREST publishes. The
-- ledger schema is not published, but it is not private either: authenticated
-- holds USAGE and EXECUTE there, because the INVOKER public wrappers call the
-- ledger bodies as the user. A SECURITY DEFINER function in `ledger` with no
-- authorization in its body is therefore one INVOKER call away from any
-- signed-in user. 0371's ledger.apply_holding_delta is gated in its body; this
-- sweep is what keeps the next one honest.
-- ═══════════════════════════════════════════════════════════════════════════

-- INV-31. The sweep, plus allowlist F's own audit (the view INV-26 reads: no
-- stale entry, and no entry that writes, runs EXECUTE or has a side effect,
-- reaches a function that does, or reaches a function with no first-party
-- body that allowlist K does not list). Offenders are named in the failure
-- output.
select is(
  (select coalesce(string_agg(x, ', ' order by x collate "C"), '') from (
     select 'ungated: ledger.' || p.proname as x
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'ledger'
        and p.prosecdef
        and p.prorettype <> 'trigger'::regtype
        and has_function_privilege('authenticated', p.oid, 'execute')
        and p.prosrc !~* '(auth\.uid|has_org_role|has_permission|is_org_member)'
        and p.proname not in (select proname from _sec_inv_ledger_secdef_nogate_allow)
     union all
     select a.x from _sec_inv_allowlist_audit a where a.list = 'F') v),
  '',
  'INV-31: every authenticated-EXECUTE SECURITY DEFINER function in ledger gates in its body or is an allowlisted read-only predicate'
);

-- INV-32. VACUITY + MUTATION CONTROL for INV-31: the population is non-empty,
-- the ungated detector fires on a planted probe of the 0346 shape (in
-- ledger), and the allowlist audit fires on a planted stale entry. Counts are
-- narrowed to the probe names so this stays truthful on a day INV-31 is
-- legitimately red for something else.
create function ledger._sec_inv_probe_ungated_ledger_secdef() returns int
  language sql
  security definer
  set search_path = public
  as $probe$ select 1 $probe$;
revoke all on function ledger._sec_inv_probe_ungated_ledger_secdef() from public, anon;
grant execute on function ledger._sec_inv_probe_ungated_ledger_secdef() to authenticated;
insert into _sec_inv_ledger_secdef_nogate_allow (proname, why) values
  ('_sec_inv_probe_absent_ledger_function', 'control probe: stale entry; deleted below');

select ok(
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'ledger'
      and p.prosecdef
      and p.prorettype <> 'trigger'::regtype
      and has_function_privilege('authenticated', p.oid, 'execute')) >= 3
  and
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'ledger'
      and p.prosecdef
      and p.prorettype <> 'trigger'::regtype
      and has_function_privilege('authenticated', p.oid, 'execute')
      and p.prosrc !~* '(auth\.uid|has_org_role|has_permission|is_org_member)'
      and p.proname not in (select proname from _sec_inv_ledger_secdef_nogate_allow)
      and p.proname = '_sec_inv_probe_ungated_ledger_secdef') = 1
  and
  (select count(*)::int
     from _sec_inv_allowlist_audit v
    where v.list = 'F' and v.entry = '_sec_inv_probe_absent_ledger_function'
      and v.x = 'stale allowlist-F entry: _sec_inv_probe_absent_ledger_function') = 1,
  'INV-32 control: the ledger sweep has definer functions to judge, its ungated detector fires on a planted probe, and its allowlist audit fires on a stale entry'
);

drop function ledger._sec_inv_probe_ungated_ledger_secdef();
delete from _sec_inv_ledger_secdef_nogate_allow where why like 'control probe:%';


-- ═══════════════════════════════════════════════════════════════════════════
-- 12. NO API-CALLABLE SECURITY INVOKER CODE TOUCHES item_stock_levels (0371)
--
-- item_stock_levels_select is warehouse-scoped for every role below manager.
-- A SECURITY INVOKER function that reads or writes the table runs under that
-- scope: a conditional UPDATE outside it matches 0 rows (a wrong
-- 'insufficient_stock'), an ON CONFLICT upsert raises a raw RLS violation, and
-- a sum comes up short with no error. 0331 made the rule (make every RPC read
-- of the table independent of the caller's row visibility, then narrow) and
-- 0371 finished it: ledger.adjust_stock / ledger.transfer_stock write through
-- the SECURITY DEFINER ledger.apply_holding_delta. This turns the rule into a
-- catalog property. Comments are stripped first (ledger.post_cycle_count
-- names the table in a comment only).
-- ═══════════════════════════════════════════════════════════════════════════

-- INV-33. The sweep.
select is(
  (select coalesce(string_agg(n.nspname || '.' || p.proname, ', ' order by n.nspname, p.proname), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'ledger')
      and not p.prosecdef
      and has_function_privilege('authenticated', p.oid, 'execute')
      and regexp_replace(regexp_replace(p.prosrc, '/\*.*?\*/', '', 'g'), '--[^\n]*', '', 'g')
          ~* '\mitem_stock_levels\M'),
  '',
  'INV-33: no SECURITY INVOKER function authenticated can execute (public or ledger) references item_stock_levels'
);

-- INV-34. VACUITY + MUTATION CONTROL for INV-33, both directions: the
-- population is non-empty, a planted INVOKER reader of the table IS caught,
-- and a planted function that names the table only in a comment is NOT (the
-- comment stripping still works, which is what keeps post_cycle_count off the
-- list).
create function public._sec_inv_probe_invoker_holdings() returns bigint
  language sql
  security invoker
  set search_path = public
  as $probe$ select count(*) from public.item_stock_levels $probe$;
create function public._sec_inv_probe_invoker_comment_only() returns int
  language plpgsql
  security invoker
  set search_path = public
  as $probe$
begin
  -- names public.item_stock_levels in a comment only
  return 1;
end;
$probe$;
revoke all on function public._sec_inv_probe_invoker_holdings() from public, anon;
revoke all on function public._sec_inv_probe_invoker_comment_only() from public, anon;
grant execute on function public._sec_inv_probe_invoker_holdings() to authenticated;
grant execute on function public._sec_inv_probe_invoker_comment_only() to authenticated;

select is(
  (select coalesce(string_agg(p.proname, ', ' order by p.proname), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'ledger')
      and not p.prosecdef
      and has_function_privilege('authenticated', p.oid, 'execute')
      and regexp_replace(regexp_replace(p.prosrc, '/\*.*?\*/', '', 'g'), '--[^\n]*', '', 'g')
          ~* '\mitem_stock_levels\M'
      and p.proname in ('_sec_inv_probe_invoker_holdings', '_sec_inv_probe_invoker_comment_only'))
  || '|' ||
  ((select count(*)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'ledger')
       and not p.prosecdef
       and has_function_privilege('authenticated', p.oid, 'execute')) > 20)::text,
  '_sec_inv_probe_invoker_holdings|true',
  'INV-34 control: the INVOKER sweep has functions to judge, catches a planted reader, and ignores a comment-only mention'
);

drop function public._sec_inv_probe_invoker_holdings();
drop function public._sec_inv_probe_invoker_comment_only();


-- ═══════════════════════════════════════════════════════════════════════════
-- 13. NO FOR ALL POLICY WIDENS A WAREHOUSE-SCOPED SELECT (0371)
--
-- A permissive FOR ALL policy applies its USING clause to SELECT as well, and
-- permissive policies OR together. On a table whose SELECT policy is
-- warehouse-scoped, a FOR ALL write policy therefore hands everyone it admits
-- an unscoped read. item_stock_levels_write did exactly that for staff until
-- 0371 split it into INSERT and UPDATE policies. A table counts as
-- warehouse-scoped when a permissive SELECT policy's qual calls one of the
-- warehouse-scope helpers. Allowlist G holds the defended exceptions and the
-- one known gap; an entry that no longer matches the shape is stale.
-- ═══════════════════════════════════════════════════════════════════════════

-- INV-35. The sweep, plus allowlist G's stale-entry audit.
select is(
  (select coalesce(string_agg(x, ', ' order by x collate "C"), '') from (
     select 'FOR ALL on a warehouse-scoped table: ' || a.tablename || '.' || a.policyname as x
       from pg_policies a
      where a.schemaname = 'public'
        and a.cmd = 'ALL'
        and a.permissive = 'PERMISSIVE'
        and a.roles && array['authenticated', 'public', 'anon']::name[]
        and exists (
              select 1 from pg_policies s
               where s.schemaname = a.schemaname and s.tablename = a.tablename
                 and s.cmd = 'SELECT' and s.permissive = 'PERMISSIVE'
                 and s.qual ~* '(my_warehouse_ids|user_can_access_warehouse|user_can_access_inventory|rls_inv_read_|rls_exc_holding_location_ids)')
        and a.tablename not in (select relname from _sec_inv_forall_on_scoped_allow)
     union all
     select 'stale allowlist-G entry: ' || g.relname
       from _sec_inv_forall_on_scoped_allow g
      where not exists (
              select 1 from pg_policies a
               where a.schemaname = 'public' and a.tablename = g.relname
                 and a.cmd = 'ALL' and a.permissive = 'PERMISSIVE')
         or not exists (
              select 1 from pg_policies s
               where s.schemaname = 'public' and s.tablename = g.relname
                 and s.cmd = 'SELECT' and s.permissive = 'PERMISSIVE'
                 and s.qual ~* '(my_warehouse_ids|user_can_access_warehouse|user_can_access_inventory|rls_inv_read_|rls_exc_holding_location_ids)')) v),
  '',
  'INV-35: no permissive FOR ALL policy sits on a table whose SELECT is warehouse-scoped, except the allowlisted ones'
);

-- INV-36. VACUITY + MUTATION CONTROL for INV-35: the scoped population is
-- non-empty, a planted table with a warehouse-scoped SELECT and a FOR ALL write
-- policy IS caught, and a planted stale allowlist entry IS caught. Everything
-- planted is dropped straight after (and the enclosing rollback is the second
-- belt).
create table public._sec_inv_probe_scoped (id uuid primary key, organization_id uuid, warehouse_id uuid);
alter table public._sec_inv_probe_scoped enable row level security;
create policy _sec_inv_probe_scoped_select on public._sec_inv_probe_scoped for select to authenticated
  using (warehouse_id in (select mw.warehouse_id from public.my_warehouse_ids() mw));
create policy _sec_inv_probe_scoped_write on public._sec_inv_probe_scoped for all to authenticated
  using ((select public.has_org_role(organization_id, 'staff')));
insert into _sec_inv_forall_on_scoped_allow (relname, why) values
  ('_sec_inv_probe_absent_table', 'control probe: stale entry; deleted below');

select is(
  (select coalesce(string_agg(x, ', ' order by x collate "C"), '') from (
     select 'caught: ' || a.tablename as x
       from pg_policies a
      where a.schemaname = 'public'
        and a.cmd = 'ALL'
        and a.permissive = 'PERMISSIVE'
        and a.roles && array['authenticated', 'public', 'anon']::name[]
        and exists (
              select 1 from pg_policies s
               where s.schemaname = a.schemaname and s.tablename = a.tablename
                 and s.cmd = 'SELECT' and s.permissive = 'PERMISSIVE'
                 and s.qual ~* '(my_warehouse_ids|user_can_access_warehouse|user_can_access_inventory|rls_inv_read_|rls_exc_holding_location_ids)')
        and a.tablename not in (select relname from _sec_inv_forall_on_scoped_allow)
        and a.tablename = '_sec_inv_probe_scoped'
     union all
     select 'stale: ' || g.relname
       from _sec_inv_forall_on_scoped_allow g
      where g.relname = '_sec_inv_probe_absent_table'
        and not exists (
              select 1 from pg_policies a
               where a.schemaname = 'public' and a.tablename = g.relname
                 and a.cmd = 'ALL' and a.permissive = 'PERMISSIVE')
     union all
     select 'scoped tables: ' || (count(distinct s.tablename) >= 5)::text
       from pg_policies s
      where s.schemaname = 'public' and s.cmd = 'SELECT' and s.permissive = 'PERMISSIVE'
        and s.qual ~* '(my_warehouse_ids|user_can_access_warehouse|user_can_access_inventory|rls_inv_read_|rls_exc_holding_location_ids)') v),
  'caught: _sec_inv_probe_scoped, scoped tables: true, stale: _sec_inv_probe_absent_table',
  'INV-36 control: the FOR ALL sweep has scoped tables to judge, catches a planted FOR ALL on a scoped table, and catches a stale allowlist entry'
);

drop table public._sec_inv_probe_scoped;
delete from _sec_inv_forall_on_scoped_allow where why like 'control probe:%';


-- ═══════════════════════════════════════════════════════════════════════════
-- 14. DRAW PROVENANCE: ONE ENGINE, AND EVERY DRAW RIDES ON ITS OWN MOVEMENT
--     (0373)
--
-- ledger.apply_level_delta_for returns what a null-location draw touched;
-- the caller writes it into stock_movements.draw of the ONE row it inserts
-- next. Three things can make provenance lie without any error: a new
-- function drawing through the non-recording public.apply_level_delta
-- (INV-37); a caller that discards its draw, records another drawer, or
-- writes a stale draw into the wrong row (INV-38: a restock landing written
-- into the scrap row); and a function other than _seal planting the scope
-- cache (INV-40). INV-38 also keeps the read view read-only to every API role
-- and keeps every other function from writing draw: by naming it (d), or by
-- a whole-row write that never names it (d2-d4: an INSERT with no column
-- list, a stock_movements row populated from a record, or a stock_movements
-- row expanded with .*), or through MERGE (d5), whose INSERT and UPDATE
-- actions none of the other arms read. The stamp trigger lets any code
-- running inside a ledger transaction write any draw, so a whole-row insert
-- in a ledger body fed from caller jsonb would forge one; these arms keep
-- that shape out of the public and ledger schemas. (Dynamic SQL is out of
-- their reach, as it is for every text census here.)
--
-- The detectors are temporary views so INV-39 and INV-41 exercise the very
-- same text. Comments are stripped before matching.
-- ═══════════════════════════════════════════════════════════════════════════
create temporary view _sec_inv_ald_caller_violations as
  with src as (
    select n.nspname || '.' || p.proname as fn,
           regexp_replace(regexp_replace(p.prosrc, '/\*.*?\*/', '', 'g'), '--[^\n]*', '', 'g') as s
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'ledger')
  )
  select 'unlisted caller of public.apply_level_delta: ' || src.fn as x, src.fn
    from src
   where src.s ~* '(^|[^a-z0-9_.])(public\s*\.\s*)?apply_level_delta\s*\('
     and src.fn not in (select a.fn from _sec_inv_ald_caller_allow a)
  union all
  select 'stale allowlist-H entry: ' || a.fn, a.fn
    from _sec_inv_ald_caller_allow a
   where not exists (select 1 from src
                      where src.fn = a.fn
                        and src.s ~* '(^|[^a-z0-9_.])(public\s*\.\s*)?apply_level_delta\s*\(');

create temporary view _sec_inv_engine_violations as
  with src as (
    select n.nspname || '.' || p.proname as fn,
           regexp_replace(regexp_replace(p.prosrc, '/\*.*?\*/', '', 'g'), '--[^\n]*', '', 'g') as s,
           coalesce(p.proallargtypes, p.proargtypes::oid[]) as argtypes, p.proargnames as argnames
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'ledger')
  ),
  -- Per function, the names that hold a stock_movements row: variables
  -- declared as the rowtype (or its %rowtype), parameters of the rowtype, and
  -- FROM / JOIN / UPDATE aliases of the table; one regex alternation, or null.
  rowrefs as (
    select src.fn, src.s,
           (select string_agg(distinct regexp_replace(x.name, '\$', '\\$', 'g'), '|')
              from (select lower(m[1]) as name
                      from regexp_matches(src.s, '(?:^|[;\s(])(?!(?:from|into|join|update|table|only|truncate|lock|on|analyze|vacuum|references|using|delete|insert|exists)(?![a-z0-9_$]))"?([a-z_][a-z0-9_$]*)"?\s+(?:constant\s+)?(?:"?public"?\s*\.\s*)?"?stock_movements"?(?![a-z0-9_$])\s*(?:%\s*rowtype\s*)?(?:not\s+null\s*)?(?:;|:=|=|default(?![a-z0-9_$]))', 'gi') m
                    union all
                    select lower(m[1])
                      from regexp_matches(src.s, '(?:from|join|update)\s+(?:"?public"?\s*\.\s*)?"?stock_movements"?(?![a-z0-9_$])\s+(?:as\s+)?(?!(?:where|join|left|right|inner|full|cross|natural|on|using|group|order|limit|offset|fetch|for|union|except|intersect|returning|set|window|having|lateral|tablesample|only)(?![a-z0-9_$]))"?([a-z_][a-z0-9_$]*)"?', 'gi') m
                    union all
                    select lower(a.name)
                      from unnest(src.argtypes, src.argnames) a(typ, name)
                     where a.typ = 'public.stock_movements'::regtype and coalesce(a.name, '') <> '') x) as names
      from src
  ),
  listed as (
    select a.fn, a.rec_args, src.s
      from _sec_inv_engine_caller_allow a join src on src.fn = a.fn
  ),
  segs as (
    select l.fn, g.seg, g.ord
      from listed l
      cross join lateral regexp_split_to_table(l.s, 'v_prov\s*:=\s*ledger\s*\.\s*apply_level_delta_for\s*\(')
           with ordinality as g(seg, ord)
     where l.rec_args = 'true, v_user'
  )
  -- (a) the engine's callers are exactly the listed ones
  select 'unlisted engine caller: ' || src.fn as x, src.fn
    from src
   where src.s ~* 'apply_level_delta_for\s*\('
     and src.fn not in (select a.fn from _sec_inv_engine_caller_allow a)
  union all
  select 'stale allowlist-I entry: ' || a.fn, a.fn
    from _sec_inv_engine_caller_allow a
   where not exists (select 1 from src where src.fn = a.fn and src.s ~* 'apply_level_delta_for\s*\(')
  union all
  -- (b1) every engine call ends with the listed (record, drawer) arguments
  select 'engine call not passing ' || l.rec_args || ': ' || l.fn, l.fn
    from listed l
   where (select count(*) from regexp_matches(l.s, 'apply_level_delta_for\s*\(', 'gi'))
      <> (select count(*) from regexp_matches(l.s, 'apply_level_delta_for\s*\([^;]*,\s*'
                                                   || replace(l.rec_args, ', ', '\s*,\s*') || '\s*\)\s*;', 'gi'))
  union all
  -- (b2) a recorder assigns every call to v_prov (none discarded)
  select 'engine draw not assigned to v_prov: ' || l.fn, l.fn
    from listed l
   where l.rec_args = 'true, v_user'
     and (select count(*) from regexp_matches(l.s, 'apply_level_delta_for\s*\(', 'gi'))
      <> (select count(*) from regexp_matches(l.s, 'v_prov\s*:=\s*ledger\s*\.\s*apply_level_delta_for\s*\(', 'gi'))
  union all
  -- (b3) every assignment is followed, before the next one, by exactly one
  -- stock_movements INSERT that lists draw first and writes v_prov into it;
  -- no such INSERT precedes the first assignment; and no INSERT writes draw
  -- in any other shape.
  select 'unpaired draw: ' || s.fn || ' after assignment ' || (s.ord - 1), s.fn
    from segs s
   where (select count(*) from regexp_matches(s.seg, 'insert\s+into\s+public\.stock_movements\s*\(\s*draw\s*,[^;]*\)\s*values\s*\(\s*v_prov\s*,', 'gi'))
         <> case when s.ord = 1 then 0 else 1 end
      or (select count(*) from regexp_matches(s.seg, 'insert\s+into\s+(public\s*\.\s*)?stock_movements\s*\([^)]*\mdraw\M', 'gi'))
         <> (select count(*) from regexp_matches(s.seg, 'insert\s+into\s+public\.stock_movements\s*\(\s*draw\s*,[^;]*\)\s*values\s*\(\s*v_prov\s*,', 'gi'))
  union all
  -- (d) no other function writes draw (the stamp trigger refuses it outside
  -- a ledger transaction anyway; inside one, only the recorders may)
  select 'unlisted draw writer: ' || src.fn, src.fn
    from src
   where (src.s ~* 'insert\s+into\s+(public\s*\.\s*)?stock_movements\s*\([^)]*\mdraw\M'
          or src.s ~* 'update\s+(public\s*\.\s*)?stock_movements\s+set\s+[^;]*\mdraw\M\s*=')
     and src.fn not in (select a.fn from _sec_inv_engine_caller_allow a where a.rec_args = 'true, v_user')
  union all
  -- (d2) every INSERT into stock_movements names its columns (no exemption:
  -- the recorders name theirs), so no positional VALUES, SELECT *, (r).* or
  -- populated record can carry a draw in without naming it
  select 'insert into stock_movements without a column list: ' || src.fn, src.fn
    from src
   where (select count(*) from regexp_matches(src.s, 'insert\s+into\s+("?public"?\s*\.\s*)?"?stock_movements"?(?![a-z0-9_$])', 'gi'))
      <> (select count(*) from regexp_matches(src.s, 'insert\s+into\s+("?public"?\s*\.\s*)?"?stock_movements"?(?![a-z0-9_$])(\s+as\s+"?[a-z_][a-z0-9_$]*"?)?\s*\(\s*(?!(select|with|values|table)(?![a-z0-9_$]))"?[a-z_][a-z0-9_$]*"?\s*[,)]', 'gi'))
  union all
  -- (d3) no json/jsonb/hstore populate_record(set) over the stock_movements
  -- rowtype: the type named in its first argument, or a row variable,
  -- parameter or alias of it passed as the first argument
  select 'stock_movements row populated from a record: ' || r.fn, r.fn
    from rowrefs r
   where r.s ~* 'populate_record(set)?\s*\(\s*[^,;]*?("?public"?\s*\.\s*)?"?stock_movements"?(?![a-z0-9_$])'
      or (r.names is not null
          and r.s ~* ('populate_record(set)?\s*\(\s*\(?\s*"?(' || r.names || ')"?\s*\)?\s*,'))
  union all
  -- (d4) no .* over the stock_movements rowtype: the table itself, a value
  -- cast to it, or a row variable, parameter or alias of it
  select 'stock_movements row expanded with .*: ' || r.fn, r.fn
    from rowrefs r
   where r.s ~* '("?public"?\s*\.\s*)?"?stock_movements"?\s*\.\s*\*'
      or r.s ~* '(::\s*("?public"?\s*\.\s*)?"?stock_movements"?|\mas\s+("?public"?\s*\.\s*)?"?stock_movements"?\s*\))\s*\)\s*\.\s*\*'
      or (r.names is not null
          and r.s ~* ('(^|[^a-z0-9_$."])"?(' || r.names || ')"?\s*\)?\s*\.\s*\*'))
  union all
  -- (d5) no MERGE into stock_movements at all (no exemption: the recorders
  -- insert with a column list, and MERGE's WHEN NOT MATCHED THEN INSERT /
  -- WHEN MATCHED THEN UPDATE actions name no table, so arms d and d2 never
  -- see them)
  select 'merge into stock_movements: ' || src.fn, src.fn
    from src
   where src.s ~* 'merge\s+into\s+("?public"?\s*\.\s*)?"?stock_movements"?(?![a-z0-9_$])'
  union all
  -- (c) no API role can write the read view, and PUBLIC holds nothing on it
  select 'write privilege on stock_movement_holdings: ' || r.r || ' ' || pv.p, 'public.stock_movement_holdings'
    from unnest(array['anon', 'authenticated', 'service_role']) as r(r),
         unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) as pv(p)
   where has_table_privilege(r.r, 'public.stock_movement_holdings', pv.p)
      or (pv.p in ('INSERT', 'UPDATE', 'REFERENCES')
          and has_any_column_privilege(r.r, 'public.stock_movement_holdings', pv.p))
  union all
  select 'PUBLIC grant on stock_movement_holdings: ' || a.privilege_type, 'public.stock_movement_holdings'
    from pg_class c, aclexplode(c.relacl) a
   where c.oid = 'public.stock_movement_holdings'::regclass and a.grantee = 0;

-- The scope cache (stockpilot.draw_scope) is trusted like the ledger flag:
-- only set_config inside the same transaction can plant it. Its writers are
-- exactly ledger._seal and the forget trigger function.
create temporary view _sec_inv_draw_scope_writers as
  select n.nspname || '.' || p.proname as fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'storage', 'graphql_public', 'ledger', 'extensions')
     and p.prosrc ~* '(set_config|set\s+(local\s+)?)[^;]*stockpilot\.draw_scope';

-- INV-37. No unlisted function draws through the non-recording wrapper.
select is(
  (select coalesce(string_agg(v.x, ', ' order by v.x collate "C"), '') from _sec_inv_ald_caller_violations v),
  '',
  'INV-37: every function that still calls the non-recording public.apply_level_delta is allowlisted with a reason (0373)'
);

-- INV-38. The engine's callers are the listed ones with their listed
-- arguments; every recorded draw is assigned and written into exactly the
-- next movement row; nothing else writes draw, by name, by a whole-row
-- write (an INSERT with no column list, a populated or .*-expanded
-- stock_movements row) or by a MERGE; no API role can write the view.
select is(
  (select coalesce(string_agg(v.x, ', ' order by v.x collate "C"), '') from _sec_inv_engine_violations v),
  '',
  'INV-38: every draw-engine caller writes its own draw, for its own drawer, into exactly the movement row it inserts next; nothing else writes draw, by name, by a whole-row write (no column list, populate_record, .*) or by MERGE; no API role can write stock_movement_holdings (0373)'
);

-- INV-39. VACUITY + MUTATION CONTROL for INV-37 and INV-38: the populations
-- are non-empty, and each detector fires on a planted probe:
--   * a new function calling public.apply_level_delta (INV-37), and a stale
--     allowlist-H entry;
--   * an unlisted engine caller (INV-38a);
--   * a listed recorder that writes a stale draw before any call, records
--     another drawer (auth.uid() instead of v_user), and discards a draw
--     (INV-38b1-b3);
--   * an unlisted function writing draw (INV-38d);
--   * an INSERT into stock_movements with no column list (INV-38d2), a
--     jsonb_populate_record over the stock_movements rowtype (INV-38d3), a
--     (row).* over a stock_movements row variable (INV-38d4) and a MERGE
--     whose INSERT action names draw (INV-38d5), each planted alone so each
--     arm is shown to fire by itself;
--   * INSERT granted to authenticated on the view (INV-38c).
-- Everything planted is removed straight after (and the enclosing rollback
-- is the second belt).
create function public._sec_inv_probe_ald_caller() returns void
  language plpgsql security invoker set search_path = public
  as $probe$ begin perform public.apply_level_delta(null, 0); end; $probe$;
revoke all on function public._sec_inv_probe_ald_caller() from public, anon;
create function ledger._sec_inv_probe_engine_unlisted() returns void
  language plpgsql security invoker set search_path = public
  as $probe$ begin perform ledger.apply_level_delta_for(null, 0, 'placed', false, null); end; $probe$;
revoke all on function ledger._sec_inv_probe_engine_unlisted() from public, anon;
create function ledger._sec_inv_probe_engine_unpaired() returns void
  language plpgsql security invoker set search_path = public
  as $probe$
declare
  v_prov public.stock_draw;
  v_user uuid;
begin
  -- a stale draw written before any call,
  insert into public.stock_movements (draw, organization_id, item_id, movement_type, quantity_change,
                                      previous_quantity, new_quantity)
  values (v_prov, null, null, 'adjust', 0, 0, 0);
  -- then a call for another drawer, with nothing written after it,
  v_prov := ledger.apply_level_delta_for(null, 0, 'placed', true, auth.uid());
  -- and a draw thrown away.
  perform ledger.apply_level_delta_for(null, 0, 'placed', true, v_user);
end;
$probe$;
revoke all on function ledger._sec_inv_probe_engine_unpaired() from public, anon;
create function public._sec_inv_probe_draw_writer() returns void
  language plpgsql security invoker set search_path = public
  as $probe$ begin update public.stock_movements set draw = null where false; end; $probe$;
revoke all on function public._sec_inv_probe_draw_writer() from public, anon;
create function ledger._sec_inv_probe_insert_no_list() returns void
  language plpgsql security invoker set search_path = public
  as $probe$ begin insert into public.stock_movements select * from public.stock_movements where false; end; $probe$;
revoke all on function ledger._sec_inv_probe_insert_no_list() from public, anon;
create function ledger._sec_inv_probe_populate(p jsonb) returns void
  language plpgsql security invoker set search_path = public
  as $probe$ begin perform jsonb_populate_record(null::public.stock_movements, p); end; $probe$;
revoke all on function ledger._sec_inv_probe_populate(jsonb) from public, anon;
create function public._sec_inv_probe_row_star() returns void
  language plpgsql security invoker set search_path = public
  as $probe$
declare
  v_row public.stock_movements;
begin
  perform (v_row).*;
end;
$probe$;
revoke all on function public._sec_inv_probe_row_star() from public, anon;
create function ledger._sec_inv_probe_merge(p public.stock_draw) returns void
  language plpgsql security invoker set search_path = public
  as $probe$
begin
  merge into public.stock_movements m
  using (select 1) s on false
  when not matched then insert (draw, organization_id) values (p, null);
end;
$probe$;
revoke all on function ledger._sec_inv_probe_merge(public.stock_draw) from public, anon;
insert into _sec_inv_ald_caller_allow (fn, why) values
  ('ledger._sec_inv_probe_absent_function', 'control probe: stale entry; deleted below');
insert into _sec_inv_engine_caller_allow (fn, rec_args, why) values
  ('ledger._sec_inv_probe_engine_unpaired', 'true, v_user', 'control probe: listed but unpaired; deleted below');
grant insert on table public.stock_movement_holdings to authenticated;

select is(
  (select string_agg(x, ' | ' order by x collate "C") from (
     select v.x from _sec_inv_ald_caller_violations v
      where v.fn in ('public._sec_inv_probe_ald_caller', 'ledger._sec_inv_probe_absent_function')
     union all
     select v.x from _sec_inv_engine_violations v
      where v.fn in ('ledger._sec_inv_probe_engine_unlisted', 'ledger._sec_inv_probe_engine_unpaired',
                     'public._sec_inv_probe_draw_writer', 'ledger._sec_inv_probe_insert_no_list',
                     'ledger._sec_inv_probe_populate', 'public._sec_inv_probe_row_star',
                     'ledger._sec_inv_probe_merge')
         or v.x like 'write privilege on stock_movement_holdings: authenticated INSERT'
     union all
     select 'populations: ' || (
       (select count(*) from _sec_inv_engine_caller_allow) >= 5
       and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname in ('public', 'ledger') and p.prosrc ~* 'apply_level_delta') >= 6)::text) q),
  'engine call not passing true, v_user: ledger._sec_inv_probe_engine_unpaired | engine draw not assigned to v_prov: ledger._sec_inv_probe_engine_unpaired | insert into stock_movements without a column list: ledger._sec_inv_probe_insert_no_list | merge into stock_movements: ledger._sec_inv_probe_merge | populations: true | stale allowlist-H entry: ledger._sec_inv_probe_absent_function | stock_movements row expanded with .*: public._sec_inv_probe_row_star | stock_movements row populated from a record: ledger._sec_inv_probe_populate | unlisted caller of public.apply_level_delta: public._sec_inv_probe_ald_caller | unlisted draw writer: public._sec_inv_probe_draw_writer | unlisted engine caller: ledger._sec_inv_probe_engine_unlisted | unpaired draw: ledger._sec_inv_probe_engine_unpaired after assignment 0 | unpaired draw: ledger._sec_inv_probe_engine_unpaired after assignment 1 | write privilege on stock_movement_holdings: authenticated INSERT',
  'INV-39 control: the provenance detectors have callers to judge and fire on a planted wrapper caller, a stale entry, an unlisted engine caller, a stale draw, another drawer, a discarded draw, an unlisted draw writer, an INSERT with no column list, a populated stock_movements row, a .*-expanded stock_movements row, a MERGE into stock_movements and a write grant'
);

revoke insert on table public.stock_movement_holdings from authenticated;
drop function public._sec_inv_probe_ald_caller();
drop function ledger._sec_inv_probe_engine_unlisted();
drop function ledger._sec_inv_probe_engine_unpaired();
drop function public._sec_inv_probe_draw_writer();
drop function ledger._sec_inv_probe_insert_no_list();
drop function ledger._sec_inv_probe_populate(jsonb);
drop function public._sec_inv_probe_row_star();
drop function ledger._sec_inv_probe_merge(public.stock_draw);
delete from _sec_inv_ald_caller_allow where why like 'control probe:%';
delete from _sec_inv_engine_caller_allow where why like 'control probe:%';

-- INV-40. Exactly _seal and the forget trigger function write the scope
-- cache.
select is(
  array(select w.fn from _sec_inv_draw_scope_writers w order by 1),
  array['ledger._seal', 'ledger.tg_forget_draw_scope'],
  'INV-40: only ledger._seal and ledger.tg_forget_draw_scope write stockpilot.draw_scope (0373)'
);

-- INV-41. MUTATION CONTROL for INV-40: a planted writer is seen.
create function public._sec_inv_probe_draw_scope() returns void
  language plpgsql security invoker set search_path = public
  as $probe$ begin perform set_config('stockpilot.draw_scope', '', true); end; $probe$;
revoke all on function public._sec_inv_probe_draw_scope() from public, anon;
select is(
  array(select w.fn from _sec_inv_draw_scope_writers w order by 1),
  array['ledger._seal', 'ledger.tg_forget_draw_scope', 'public._sec_inv_probe_draw_scope'],
  'INV-41 control: the scope-cache census sees a planted writer'
);
drop function public._sec_inv_probe_draw_scope();


-- ═══════════════════════════════════════════════════════════════════════════
-- 15. WHO MAY SET AN IDENTITY SETTING OR RAISE A TRANSACTION FLAG (T24)
--
-- The setting censuses above and in the per-migration tests (0359 tests 17
-- and 18, 0391 G5, 0397 A1b, INV-40) cover the stockpilot.* flags. This one
-- covers the settings that say who the caller is: request.jwt.* (auth.uid()
-- reads request.jwt.claim.sub and request.jwt.claims), role and
-- session_authorization, set through set_config, through a SET or RESET
-- statement, or through the function's own SET clause (pg_proc.proconfig).
-- Every function in public, ledger, storage and graphql_public that sets one
-- is on allowlist L with its reason, and none of them is executable by anon
-- or authenticated. Extension members are not judged. The second census
-- holds every stockpilot.* flag and every function that raises it (allowlist
-- M), read the same three ways. Both read a set_config name out of one
-- quoted literal, so a third census (INV-40d) refuses a set_config call
-- whose first argument is anything else: every name is then one the first
-- two read whole. (0359 test 18 refuses a first argument that does not
-- start with a quote; INV-40d also refuses one that starts with a quote and
-- goes on.)
-- ═══════════════════════════════════════════════════════════════════════════

create temporary view _sec_inv_identity_setters as
  with setters as (
    select f.oid, f.sig
      from _sec_inv_fn_scope f
     where f.nspname in ('public', 'ledger', 'storage', 'graphql_public') and not f.ext
       and (f.c ~* (select re from _sec_inv_identity_set_re)
            or exists (select 1 from unnest(f.config) k
                        where k ~* (select cfg from _sec_inv_identity_set_re)))),
  l as (select a.sig, to_regprocedure(a.sig) as oid from _sec_inv_identity_setter_allow a)
  select 'unlisted identity setter: ' || s.sig as x, s.sig
    from setters s
   where s.oid not in (select l.oid from l where l.oid is not null)
  union all
  select 'stale allowlist-L entry (no such function, or it sets no identity setting now): ' || l.sig, l.sig
    from l
   where not exists (select 1 from setters s where s.oid = l.oid)
  union all
  select 'allowlist-L entry that anon or authenticated may execute: ' || l.sig, l.sig
    from l join setters s on s.oid = l.oid
   where has_function_privilege('anon', s.oid, 'execute')
      or has_function_privilege('authenticated', s.oid, 'execute');

-- INV-40b. The census. Offenders are named.
select is(
  (select coalesce(string_agg(v.x, ', ' order by v.x collate "C"), '') from _sec_inv_identity_setters v),
  '',
  'INV-40b: every function that sets request.jwt.*, role or session_authorization, in its body or through its own SET clause, is on allowlist L, and none of them is executable by anon or authenticated'
);

-- INV-41b. MUTATION CONTROL for INV-40b. Planted: a function in public that
-- sets request.jwt.claims through set_config and a ledger function that runs
-- SET LOCAL ROLE, neither listed; allowlist-L rows for a missing function,
-- for one that sets no identity setting (ledger.active()) and for a planted
-- setter authenticated may execute. Each must be named. A sixth function
-- only reads the setting and names set_config in a comment; it must not be
-- named. Six more unlisted setters, one per way of writing it, must each be
-- named: a function whose own SET clause names role (its body sets
-- nothing), set_config called under a schema-qualified, double-quoted name,
-- set_config straight after a comment with no space between, SET LOCAL
-- session_authorization (the setting's own name, with the underscore), SET
-- LOCAL "role" in double quotes, and set_config on the same line as a
-- comment that a carriage return has ended (that body is built with
-- format(), so that this file holds no bare carriage return). Everything
-- planted is removed straight after.
create function public._sec_inv_probe_role_clause() returns int
  language sql security invoker set search_path = public set role = 'authenticated'
  as $probe$ select 1 $probe$;
create function public._sec_inv_probe_quoted_call() returns void
  language plpgsql security invoker set search_path = public
  as $probe$ begin perform pg_catalog."set_config"('request.jwt.claims', '{}', true); end; $probe$;
create function ledger._sec_inv_probe_after_comment() returns void
  language plpgsql security invoker set search_path = public
  as $probe$ begin perform/**/set_config('role', 'authenticated', true); end; $probe$;
create function public._sec_inv_probe_sets_session_authorization() returns void
  language plpgsql security invoker set search_path = public
  as $probe$ begin set local session_authorization to 'authenticated'; end; $probe$;
create function public._sec_inv_probe_sets_quoted_role() returns void
  language plpgsql security invoker set search_path = public
  as $probe$ begin set local "role" to 'authenticated'; end; $probe$;
do $do$
begin
  execute format(
    'create function public._sec_inv_probe_cr_comment() returns void language plpgsql security invoker set search_path = public as %L',
    E'begin -- a comment\rperform set_config(''role'', ''authenticated'', true); end;');
end $do$;
revoke all on function public._sec_inv_probe_role_clause(), public._sec_inv_probe_quoted_call(),
  ledger._sec_inv_probe_after_comment(), public._sec_inv_probe_sets_session_authorization(),
  public._sec_inv_probe_sets_quoted_role(), public._sec_inv_probe_cr_comment() from public, anon;
create function public._sec_inv_probe_sets_claims() returns void
  language plpgsql security invoker set search_path = public
  as $probe$ begin perform set_config('request.jwt.claims', '{}', true); end; $probe$;
create function ledger._sec_inv_probe_sets_role() returns void
  language plpgsql security invoker set search_path = public
  as $probe$ begin set local role authenticated; end; $probe$;
create function public._sec_inv_probe_listed_setter() returns void
  language plpgsql security invoker set search_path = public
  as $probe$ begin perform set_config('request.jwt.claim.sub', '', true); end; $probe$;
create function public._sec_inv_probe_reads_claims() returns text
  language plpgsql security invoker set search_path = public
  as $probe$
  -- set_config('request.jwt.claims', ...) is only named here
  begin return current_setting('request.jwt.claims', true); end; $probe$;
revoke all on function public._sec_inv_probe_sets_claims(), ledger._sec_inv_probe_sets_role(),
  public._sec_inv_probe_listed_setter(), public._sec_inv_probe_reads_claims() from public, anon;
grant execute on function public._sec_inv_probe_listed_setter() to authenticated;
insert into _sec_inv_identity_setter_allow (sig, why) values
  ('public._sec_inv_probe_absent()',        'control probe: stale, no such function; deleted below'),
  ('ledger.active()',                       'control probe: stale, it sets no identity setting; deleted below'),
  ('public._sec_inv_probe_listed_setter()', 'control probe: listed, and authenticated may execute it; deleted below');

select is(
  (select coalesce(string_agg(v.x, ' | ' order by v.x collate "C"), '')
     from _sec_inv_identity_setters v
    where v.sig like '%\_sec\_inv\_probe\_%' or v.sig = 'ledger.active()'),
  'allowlist-L entry that anon or authenticated may execute: public._sec_inv_probe_listed_setter() | '
  'stale allowlist-L entry (no such function, or it sets no identity setting now): ledger.active() | '
  'stale allowlist-L entry (no such function, or it sets no identity setting now): public._sec_inv_probe_absent() | '
  'unlisted identity setter: ledger._sec_inv_probe_after_comment() | '
  'unlisted identity setter: ledger._sec_inv_probe_sets_role() | '
  'unlisted identity setter: public._sec_inv_probe_cr_comment() | '
  'unlisted identity setter: public._sec_inv_probe_quoted_call() | '
  'unlisted identity setter: public._sec_inv_probe_role_clause() | '
  'unlisted identity setter: public._sec_inv_probe_sets_claims() | '
  'unlisted identity setter: public._sec_inv_probe_sets_quoted_role() | '
  'unlisted identity setter: public._sec_inv_probe_sets_session_authorization()',
  'INV-41b control: the identity-setting census names an unlisted set_config (bare, double-quoted, straight after a comment, or after a comment ended by a carriage return), an unlisted SET of role or session_authorization (bare or double-quoted) and an unlisted SET role clause, a missing, a non-setting and an API-executable allowlist-L entry, and leaves a setting read alone'
);

delete from _sec_inv_identity_setter_allow where why like 'control probe:%';
drop function public._sec_inv_probe_role_clause();
drop function public._sec_inv_probe_quoted_call();
drop function ledger._sec_inv_probe_after_comment();
drop function public._sec_inv_probe_sets_session_authorization();
drop function public._sec_inv_probe_sets_quoted_role();
drop function public._sec_inv_probe_cr_comment();
drop function public._sec_inv_probe_sets_claims();
drop function ledger._sec_inv_probe_sets_role();
drop function public._sec_inv_probe_listed_setter();
drop function public._sec_inv_probe_reads_claims();

-- The flag census (T24): every (flag, function) pair found in a function
-- body or in a function's own SET clause in the same four schemas, against
-- allowlist M.
create temporary view _sec_inv_flag_setters as
  with found as (
    select distinct lower(m[1]) as flag, f.fn
      from _sec_inv_fn_scope f
      cross join lateral regexp_matches(f.c, (select re from _sec_inv_flag_set_re), 'gi') m
     where f.nspname in ('public', 'ledger', 'storage', 'graphql_public') and not f.ext
    union
    select lower((regexp_match(k, (select cfg from _sec_inv_flag_set_re), 'i'))[1]), f.fn
      from _sec_inv_fn_scope f
      cross join lateral unnest(f.config) k
     where f.nspname in ('public', 'ledger', 'storage', 'graphql_public') and not f.ext
       and k ~* (select cfg from _sec_inv_flag_set_re))
  select 'unlisted flag setter: ' || d.flag || ' <- ' || d.fn as x, d.flag, d.fn
    from found d
   where not exists (select 1 from _sec_inv_flag_setter_allow a where a.flag = d.flag and a.fn = d.fn)
  union all
  select 'stale allowlist-M entry (the function is gone, or does not set the flag): ' || a.flag || ' <- ' || a.fn, a.flag, a.fn
    from _sec_inv_flag_setter_allow a
   where not exists (select 1 from found d where d.flag = a.flag and d.fn = a.fn);

-- INV-40c. The census. Offenders are named.
select is(
  (select coalesce(string_agg(v.x, ', ' order by v.x collate "C"), '') from _sec_inv_flag_setters v),
  '',
  'INV-40c: every function that sets a stockpilot.* transaction flag, in its body or through its own SET clause, is on allowlist M for that flag, and allowlist M has no stale entry'
);

-- INV-41c. MUTATION CONTROL for INV-40c. Planted: a function that raises a
-- listed flag through set_config, one that sets a new flag with SET LOCAL,
-- and one that finishes the flag's name at run time, none of them listed;
-- and allowlist-M rows for a missing function and for one that sets no flag
-- (ledger.active). Each must be named. A sixth function only reads a flag
-- and names set_config in a comment; it must not be named. Three more
-- unlisted setters must each be named, with the name each one really sets:
-- set_config called under a schema-qualified, double-quoted name, SET LOCAL
-- with a comment straight after SET, and a flag whose name has a third
-- part (stockpilot.add_lines.more is not stockpilot.add_lines). Everything
-- planted is removed straight after.
create function public._sec_inv_probe_flag_quoted_call() returns void
  language plpgsql security invoker set search_path = public
  as $probe$ begin perform pg_catalog."set_config"('stockpilot.add_lines', '1', true); end; $probe$;
create function public._sec_inv_probe_flag_after_comment() returns void
  language plpgsql security invoker set search_path = public
  as $probe$ begin set/**/local stockpilot.add_lines to '1'; end; $probe$;
create function public._sec_inv_probe_longer_flag() returns void
  language plpgsql security invoker set search_path = public
  as $probe$ begin perform set_config('stockpilot.add_lines.more', '1', true); end; $probe$;
revoke all on function public._sec_inv_probe_flag_quoted_call(), public._sec_inv_probe_flag_after_comment(),
  public._sec_inv_probe_longer_flag() from public, anon;
create function public._sec_inv_probe_raises_flag() returns void
  language plpgsql security invoker set search_path = public
  as $probe$ begin perform set_config('stockpilot.add_lines', '1', true); end; $probe$;
create function ledger._sec_inv_probe_new_flag() returns void
  language plpgsql security invoker set search_path = public
  as $probe$ begin set local stockpilot._sec_inv_probe to 'on'; end; $probe$;
create function public._sec_inv_probe_built_flag() returns void
  language plpgsql security invoker set search_path = public
  as $probe$ begin perform set_config('stockpilot.' || 'add_lines', '1', true); end; $probe$;
create function public._sec_inv_probe_reads_flag() returns text
  language plpgsql security invoker set search_path = public
  as $probe$
  -- set_config('stockpilot.add_lines', ...) is only named here
  begin return current_setting('stockpilot.add_lines', true); end; $probe$;
revoke all on function public._sec_inv_probe_raises_flag(), ledger._sec_inv_probe_new_flag(),
  public._sec_inv_probe_built_flag(), public._sec_inv_probe_reads_flag() from public, anon;
insert into _sec_inv_flag_setter_allow (flag, fn, why) values
  ('stockpilot.ledger',    'public._sec_inv_probe_absent', 'control probe: stale, no such function; deleted below'),
  ('stockpilot.add_lines', 'ledger.active',                'control probe: stale, it sets no flag; deleted below');

select is(
  (select coalesce(string_agg(v.x, ' | ' order by v.x collate "C"), '')
     from _sec_inv_flag_setters v
    where v.fn like '%\_sec\_inv\_probe\_%' or v.fn = 'ledger.active'),
  'stale allowlist-M entry (the function is gone, or does not set the flag): stockpilot.add_lines <- ledger.active | '
  'stale allowlist-M entry (the function is gone, or does not set the flag): stockpilot.ledger <- public._sec_inv_probe_absent | '
  'unlisted flag setter: stockpilot. <- public._sec_inv_probe_built_flag | '
  'unlisted flag setter: stockpilot._sec_inv_probe <- ledger._sec_inv_probe_new_flag | '
  'unlisted flag setter: stockpilot.add_lines <- public._sec_inv_probe_flag_after_comment | '
  'unlisted flag setter: stockpilot.add_lines <- public._sec_inv_probe_flag_quoted_call | '
  'unlisted flag setter: stockpilot.add_lines <- public._sec_inv_probe_raises_flag | '
  'unlisted flag setter: stockpilot.add_lines.more <- public._sec_inv_probe_longer_flag',
  'INV-41c control: the flag census names an unlisted set_config (bare or double-quoted), an unlisted SET LOCAL (of a new flag, and with a comment inside it), a name finished at run time and a name with a third part, a missing and a non-setting allowlist-M entry, and leaves a flag read alone'
);

delete from _sec_inv_flag_setter_allow where why like 'control probe:%';
drop function public._sec_inv_probe_flag_quoted_call();
drop function public._sec_inv_probe_flag_after_comment();
drop function public._sec_inv_probe_longer_flag();
drop function public._sec_inv_probe_raises_flag();
drop function ledger._sec_inv_probe_new_flag();
drop function public._sec_inv_probe_built_flag();
drop function public._sec_inv_probe_reads_flag();

-- The setting-name census: the two censuses above read a setting's name out
-- of one quoted literal, so every set_config call in the same four schemas
-- has to pass its name that way. Per function, the calls that pass one
-- quoted literal as the name against all its calls, counted on the code
-- skeleton.
create temporary view _sec_inv_setting_names as
  select 'set_config call whose name is not one quoted literal (' || t.n_lit || ' of ' || t.n_all
           || ' calls pass one): ' || f.sig as x, f.sig
    from _sec_inv_fn_scope f
    cross join lateral (
      select (select count(*) from regexp_matches(f.s, r.any_re, 'gi')) as n_all,
             (select count(*) from regexp_matches(f.s, r.literal_re, 'gi')) as n_lit
        from _sec_inv_setting_call_re r) t
   where f.nspname in ('public', 'ledger', 'storage', 'graphql_public') and not f.ext
     and t.n_all <> t.n_lit;

-- INV-40d. The census. Offenders are named.
select is(
  (select coalesce(string_agg(v.x, ', ' order by v.x collate "C"), '') from _sec_inv_setting_names v),
  '',
  'INV-40d: every set_config call in public, ledger, storage and graphql_public names its setting with one quoted literal'
);

-- INV-41d. VACUITY + MUTATION CONTROL for INV-40d. The census has calls to
-- judge, and six planted functions must each be named: a name joined from
-- two literals (an identity setting, and a flag), a literal continued on the
-- next line, an E'' string, a variable, and a function with one good call
-- and one whose name is a format() call. A seventh passes one quoted
-- literal, under a schema-qualified, double-quoted set_config with comments
-- around the name, and names set_config in a comment and in its value; it
-- must not be named. Everything planted is removed straight after.
create function public._sec_inv_probe_name_joined() returns void
  language plpgsql security invoker set search_path = public
  as $probe$ begin perform set_config('request.' || 'jwt.claim.sub', '', true); end; $probe$;
create function public._sec_inv_probe_flag_joined() returns void
  language plpgsql security invoker set search_path = public
  as $probe$ begin perform set_config('stock' || 'pilot.ledger', '1', true); end; $probe$;
create function public._sec_inv_probe_name_continued() returns void
  language plpgsql security invoker set search_path = public
  as $probe$ begin perform set_config('request.jwt'
    '.claim.sub', '', true); end; $probe$;
create function public._sec_inv_probe_name_estring() returns void
  language plpgsql security invoker set search_path = public
  as $probe$ begin perform set_config(E'request.jwt.claim.sub', '', true); end; $probe$;
create function public._sec_inv_probe_name_variable(p_name text) returns void
  language plpgsql security invoker set search_path = public
  as $probe$ begin perform set_config(p_name, '1', true); end; $probe$;
create function public._sec_inv_probe_name_mixed() returns void
  language plpgsql security invoker set search_path = public
  as $probe$ begin
    perform set_config('sec_inv.probe', '1', true);
    perform set_config(format('%s', 'sec_inv.probe'), '1', true);
  end; $probe$;
create function ledger._sec_inv_probe_name_literal() returns void
  language plpgsql security invoker set search_path = public
  as $probe$
  -- set_config(p_name, ...) is only named here
  begin
    perform/**/pg_catalog."set_config"(/* the name */ 'sec_inv.probe' /* then the value */, 'set_config(x, 1)', true);
  end; $probe$;
revoke all on function public._sec_inv_probe_name_joined(), public._sec_inv_probe_flag_joined(),
  public._sec_inv_probe_name_continued(), public._sec_inv_probe_name_estring(),
  public._sec_inv_probe_name_variable(text), public._sec_inv_probe_name_mixed(),
  ledger._sec_inv_probe_name_literal() from public, anon;

select is(
  (select coalesce(string_agg(v.x, ' | ' order by v.x collate "C"), '')
     from _sec_inv_setting_names v where v.sig like '%\_sec\_inv\_probe\_%')
  || ' | calls to judge: ' ||
  ((select count(*) from _sec_inv_fn_scope f
     where f.nspname in ('public', 'ledger', 'storage', 'graphql_public') and not f.ext
       and f.proname not like '\_sec\_inv\_probe\_%'
       and f.s ~* (select any_re from _sec_inv_setting_call_re)) > 5)::text,
  'set_config call whose name is not one quoted literal (0 of 1 calls pass one): public._sec_inv_probe_flag_joined() | '
  'set_config call whose name is not one quoted literal (0 of 1 calls pass one): public._sec_inv_probe_name_continued() | '
  'set_config call whose name is not one quoted literal (0 of 1 calls pass one): public._sec_inv_probe_name_estring() | '
  'set_config call whose name is not one quoted literal (0 of 1 calls pass one): public._sec_inv_probe_name_joined() | '
  'set_config call whose name is not one quoted literal (0 of 1 calls pass one): public._sec_inv_probe_name_variable(text) | '
  'set_config call whose name is not one quoted literal (1 of 2 calls pass one): public._sec_inv_probe_name_mixed()'
  ' | calls to judge: true',
  'INV-41d control: the setting-name census has set_config calls to judge, names a name joined from two literals, continued on the next line, written as an E string, held in a variable or built by a call, and leaves a call that passes one quoted literal alone'
);

drop function public._sec_inv_probe_name_joined();
drop function public._sec_inv_probe_flag_joined();
drop function public._sec_inv_probe_name_continued();
drop function public._sec_inv_probe_name_estring();
drop function public._sec_inv_probe_name_variable(text);
drop function public._sec_inv_probe_name_mixed();
drop function ledger._sec_inv_probe_name_literal();

-- INV-41e. VACUITY + MUTATION CONTROL for the SET-clause forms INV-40b and
-- INV-40c read, one probe per form, on the text pg_proc.proconfig holds for
-- an entry ("name=value"). INV-41b plants a function with a SET role clause
-- and so proves the reading itself; the role these tests run as may not
-- create a function with a session_authorization, request.jwt.* or
-- stockpilot.* SET clause, so those forms are proved here. The last four
-- must be neither: the SET clauses first-party functions carry today, and
-- one more ordinary setting.
select is(
  (select string_agg(v.cfg || ' -> ' ||
                     case when v.cfg ~* (select cfg from _sec_inv_identity_set_re) then 'identity'
                          else coalesce('flag ' || lower((regexp_match(v.cfg, (select cfg from _sec_inv_flag_set_re), 'i'))[1]),
                                        'neither') end,
                     ', ' order by v.n)
     from (values
       (1, 'role=service_role'),
       (2, 'session_authorization=service_role'),
       (3, 'request.jwt.claim.sub=00000000-0000-0000-0000-000000000000'),
       (4, 'request.jwt.claims={}'),
       (5, 'stockpilot.derived_write=on'),
       (6, 'Stockpilot.Ledger=1'),
       (7, 'search_path=public, pg_temp'),
       (8, 'lock_timeout=5s'),
       (9, 'plan_cache_mode=force_custom_plan'),
       (10, 'row_security=off')) v(n, cfg)),
  'role=service_role -> identity, session_authorization=service_role -> identity, '
  'request.jwt.claim.sub=00000000-0000-0000-0000-000000000000 -> identity, request.jwt.claims={} -> identity, '
  'stockpilot.derived_write=on -> flag stockpilot.derived_write, Stockpilot.Ledger=1 -> flag stockpilot.ledger, '
  'search_path=public, pg_temp -> neither, lock_timeout=5s -> neither, plan_cache_mode=force_custom_plan -> neither, '
  'row_security=off -> neither',
  'INV-41e control: the SET-clause forms name role, session_authorization, request.jwt.* and a stockpilot.* flag, and no other setting'
);

select * from finish();
rollback;
