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
--
-- Pure catalog introspection — no fixtures, no seeded rows, no roles switched.
-- `begin`/`rollback` for house consistency and so the temporary allowlist
-- tables never outlive the run.
-- ============================================================================

begin;

select plan(23);


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
-- 0323 put the structural traversal floor under the nine path columns whose
-- values reach a storage client. These five do not have it. They are recorded
-- here rather than omitted so the gap is visible in CI output and in review,
-- and so a NEW path column still fails INV-15 instead of joining the gap
-- silently. Closing one of these means deleting its row here in the same change
-- as the constraint migration.
create temporary table _sec_inv_path_check_gap (relname text, attname text, why text not null,
  primary key (relname, attname));
insert into _sec_inv_path_check_gap (relname, attname, why) values
  ('item_attachments',            'storage_path',       'not covered by 0323; table held 0 rows at the time of that change'),
  ('po_imports',                  'storage_path',       'placeholder to keep this table shape valid — replaced below if absent'),
  ('cycle_count_ai_scans',        'photo_storage_path', 'not covered by 0323; scan photos are written through the cycle-count service only'),
  ('import_jobs',                 'storage_path',       'not covered by 0323; import files are written through the import service only'),
  ('size_count_training_samples', 'image_storage_path', 'not covered by 0323; training images are written through the size-count service only'),
  ('support_tickets',             'attachment_path',    'not covered by 0323; support attachments are written through the support service only');
-- po_imports.storage_path IS constrained by 0323; it is not a gap. Removing it
-- here keeps the gap list honest (INV-16 refuses a stale entry, which is what
-- would fire if this delete were dropped).
delete from _sec_inv_path_check_gap where relname = 'po_imports';


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

-- INV-5. No allowlist, deliberately. There is no defensible reason for a table
-- that carries an organization_id to run without RLS, so this one has no escape
-- hatch: closing a failure means enabling RLS and writing policies.
select is(
  (select count(*)::int
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     join pg_attribute a on a.attrelid = c.oid
      and a.attname = 'organization_id' and a.attnum > 0 and not a.attisdropped
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity),
  0,
  'INV-5: every table in public with an organization_id has RLS enabled'
);

-- INV-6. The wider sweep, with an allowlist that is currently empty. A table
-- with no organization_id can still hold data worth protecting (per-user rows
-- keyed on auth.uid(), platform-level configuration), and "it has no org
-- column" is not by itself a reason to be open.
select is(
  (select count(*)::int
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and not c.relrowsecurity
      and c.relname not in (select relname from _sec_inv_rls_exempt_tables)),
  0,
  'INV-6: every table in public has RLS enabled unless explicitly allowlisted'
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
    where n.nspname = 'public' and c.relkind = 'r'),
  '>',
  50,
  'INV-7 control: the org-scoped table sweep still finds the tenant tables'
);


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
select is(
  (select count(*)::int
     from pg_policies pol
     join pg_class c on c.relname = pol.tablename
     join pg_namespace n on n.oid = c.relnamespace and n.nspname = pol.schemaname
    where pol.schemaname = 'public'
      and c.relkind = 'r'
      and exists (select 1 from pg_attribute a
                   where a.attrelid = c.oid and a.attname = 'organization_id'
                     and a.attnum > 0 and not a.attisdropped)
      and (pol.qual = 'true' or pol.with_check = 'true')),
  0,
  'INV-11: no policy on an org-scoped table has a literal-true predicate'
);

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

-- INV-15. Every path-bearing column in public carries the traversal floor
-- unless it is on the recorded known-gap list.
select is(
  (select count(*)::int
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where n.nspname = 'public' and c.relkind = 'r'
      and a.attname like '%path%'
      and not exists (
        select 1 from pg_constraint k
         where k.conrelid = c.oid and k.contype = 'c'
           and strpos(pg_get_constraintdef(k.oid), a.attname) > 0
           and strpos(pg_get_constraintdef(k.oid), '''..''') > 0
           and strpos(pg_get_constraintdef(k.oid), '''%''') > 0)
      and not exists (
        select 1 from _sec_inv_path_check_gap g
         where g.relname = c.relname and g.attname = a.attname)),
  0,
  'INV-15: every path-bearing column in public has a traversal-refusing CHECK, or a recorded gap'
);

-- INV-16. No stale gap entry. When one of the five gaps is closed, its row here
-- must go in the same change — otherwise the list stops describing the real
-- exposure and the next reader trusts it.
select is(
  (select count(*)::int
     from _sec_inv_path_check_gap g
    where not exists (
      select 1 from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
       where n.nspname = 'public' and c.relname = g.relname and a.attname = g.attname
         and not exists (
           select 1 from pg_constraint k
            where k.conrelid = c.oid and k.contype = 'c'
              and strpos(pg_get_constraintdef(k.oid), a.attname) > 0
              and strpos(pg_get_constraintdef(k.oid), '''..''') > 0))),
  0,
  'INV-16: no stale entry in the storage-path known-gap list (column gone, or now constrained)'
);

-- INV-17. VACUITY CONTROL — the constraint detector fires on a column 0323
-- constrained. If it silently stopped matching, INV-15 would pass by finding
-- nothing to complain about.
select ok(
  exists (
    select 1 from pg_constraint k
     where k.conrelid = 'public.item_images'::regclass and k.contype = 'c'
       and strpos(pg_get_constraintdef(k.oid), 'storage_path') > 0
       and strpos(pg_get_constraintdef(k.oid), '''..''') > 0),
  'INV-17 control: the traversal-CHECK detector finds the constraint 0323 put on item_images.storage_path'
);

-- INV-18. VACUITY CONTROL — and does NOT fire on a column that has no such
-- constraint. inventory_items.name is chosen because it is not a path and will
-- never legitimately acquire a traversal CHECK, so this control cannot become a
-- false failure the way pointing it at a known gap would.
select ok(
  not exists (
    select 1 from pg_constraint k
     where k.conrelid = 'public.inventory_items'::regclass and k.contype = 'c'
       and strpos(pg_get_constraintdef(k.oid), 'name') > 0
       and strpos(pg_get_constraintdef(k.oid), '''..''') > 0),
  'INV-18 control: the traversal-CHECK detector does not fire on an unconstrained column'
);


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


-- ═══════════════════════════════════════════════════════════════════════════
-- NOT ASSERTED HERE — ON PURPOSE
--
-- The two ACCEPTED RISKS are pinned in
-- supabase/tests/0322_quantity_guards_avatar_scope_override_clears.test.sql,
-- next to the evidence that justifies them, and are NOT duplicated here:
--   * item_stock_levels.quantity must stay unconstrained (0322 test, ~line 280)
--     — adjust_stock commits negatives today and transfer_stock writes a
--     negative before its guard, so a CHECK converts an existing bug into a
--     mid-transaction failure.
--   * item_stock_levels_select must stay org-only (0322 test, ~line 563) —
--     warehouse-scoping it makes post_cycle_count sum SHORT under the caller's
--     RLS and write a WRONG number with NO error: silent stock corruption.
-- Duplicating those assertions would double the friction of the eventual fix
-- and invite the two copies to drift. The cost of not duplicating is real and
-- should be named: deleting that file removes both pins, and nothing in this
-- file would notice. See docs/security/SECURITY-INVARIANTS.md, "Accepted risks".
--
-- Also not asserted, because no honest generic form exists at this level:
-- pattern #23 (PostgREST `.in()`/`not.in` dropping NULL rows) and pattern #2
-- (`.update().eq()` without `.select().maybeSingle()` failing OPEN) are
-- client-library behaviours in TypeScript, invisible to the database catalog.
-- They are covered by targeted unit tests and by review; see the invariants
-- document.
-- ═══════════════════════════════════════════════════════════════════════════

select * from finish();
rollback;
