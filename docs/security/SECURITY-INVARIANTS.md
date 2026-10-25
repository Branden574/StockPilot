<!-- Provenance: compiled 2026-08-10, at the close of the security program's
     waves A-E. Every "Enforced by" and "Tested at" reference is a path in this
     repository and is checkable by opening it. Every catalog figure quoted
     (function counts, table counts, view counts, bucket flags) was read out of
     a local Postgres with migrations 0001-0323 applied, and each is
     reproducible with the query printed beside it. Claims about production row
     counts are quoted from the migration that recorded them and have NOT been
     independently re-read here; re-run the query against production before
     using one in an attestation.

     AMENDED 2026-09-06 (SP-028b): section 2 was retitled and INV-B3 added,
     because the document described this class as the anon posture only while
     the test file had grown a matching `authenticated` sweep (INV-25/26 with
     controls INV-29/30, shipped with migration 0346). The figures in INV-B3 —
     the 14 allowlist-E entries, the four functions the 0345 sweep named —
     were read out of supabase/tests/security_invariants.test.sql and migrations
     0346/0350 as they stand at that date, NOT out of a live catalog; the
     reproduce query beside INV-B3 is how you check them against one. The
     assertion counts in section 10 were re-derived from `select plan(30)` in
     the same file. Nothing else in this document was re-verified.

     AMENDED 2026-09-25 (0371, staff holdings scope): AR-2's "What it
     changes" and "Pinned at" were rewritten (staff are now narrowed too), and
     INV-B4, INV-C3 and INV-C4 were added with their assertions INV-31..36.
     The catalog facts quoted in those entries were read out of a local
     Postgres at migration 0371; the assertion count in section 10 was
     re-derived from `select plan(36)`.

     AMENDED 2026-10-24 (docket S14): INV-E5 added, with a row in section 8.
     The route counts quoted in it were read by its sweep test on that date;
     the counts in section 10 were not re-derived.

     AMENDED 2026-10-25 (docket S14 review): INV-E5's GET inventory was
     wrong (it missed /auth/session-ended and the export routes), and it
     presented the /auth/confirm login CSRF as closed for browsers that send
     Fetch Metadata. Both corrected, with the defences added for them and the
     section 8 row updated. The GET list was read from the route files on
     that date; it is not a sweep. -->

# Security invariants

The properties that must hold for this system to be considered sound. This is
the specification the tests implement, not a summary of them: when an assertion
and this document disagree, one of the two is a bug and the disagreement has to
be resolved rather than papered over.

## How to read this

Every invariant below is written so it can be **falsified**. "Tenant data is
protected" is not an invariant — nothing observable makes it false. "Every table
in `public` carrying an `organization_id` has row-level security enabled" is:
one counterexample settles it.

Each entry carries four fields.

- **Invariant** — the property, stated as something a counterexample could break.
- **Why it matters** — the concrete failure that follows if it does not hold.
  Where this program found the failure in live code, that is named.
- **Enforced by** — the mechanism that makes it true. A comment is not a
  mechanism.
- **Tested at** — where a violation is caught, with the file and the assertion
  ID. `INV-n` refers to
  [`supabase/tests/security_invariants.test.sql`](../../supabase/tests/security_invariants.test.sql),
  which is the class-wide sweep; per-fix assertions live in the numbered pgTAP
  file for their migration.

Two words are used precisely throughout. **Allowlist** means the test carries an
explicit, reasoned list of exempt members, so a _new_ member fails until someone
adds it deliberately. **Control** means an assertion whose only job is to prove
another assertion can still fail — the counter to a sweep that silently stops
selecting anything.

### The rule that shaped every test here

Assert the property, never a snapshot of current behaviour. This program removed
roughly eight tautological assertions that had been written by transcribing what
the code did, and it found **two pre-existing tests that were defending
vulnerabilities** for the same reason: each asserted the observed (vulnerable)
response instead of the required one, so the hole had a passing test sitting on
top of it. A test that cannot fail is worse than no test, because it buys
confidence without paying for it.

Mutation testing is therefore the gate for this file. Nothing in it is trusted
until a deliberate violation has been shown to turn it red. The record of the
most recent such check is in the invariant test's own header.

---

## 1. Tenant isolation

This is a multi-tenant database where `authenticated` holds table-level
`SELECT`/`INSERT`/`UPDATE`/`DELETE` on nearly every table in `public`, because
that is Supabase's default grant. Table privileges are therefore **not** the
access control. Row-level security is. A table with RLS switched off is not
"awaiting policies"; it is readable and writable by any signed-in user of any
organization from the moment it exists.

### INV-A1 — RLS is enabled on every org-scoped table

- **Invariant**: every relation of kind `r` in schema `public` that has a
  column named `organization_id` has `relrowsecurity = true`.
- **Why it matters**: without it, one tenant reads and writes another's rows
  through PostgREST with no exploit required — just a different `organization_id`
  in the query string.
- **Enforced by**: `alter table ... enable row level security` in the migration
  that creates each table. There is no framework default doing this; it is a
  line someone has to write.
- **Tested at**: INV-5. **Deliberately no allowlist** — there is no defensible
  reason for an org-scoped table to run without RLS, so a failure must be closed
  by enabling RLS, not by adding an exemption. Current state: 89 org-scoped
  tables, 89 with RLS. INV-7 is the control that the `organization_id` detector
  still finds them.

Reproduce:

```sql
select c.relname from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id'
   and a.attnum > 0 and not a.attisdropped
 where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
```

### INV-A2 — RLS is enabled on every other table in `public` too

- **Invariant**: every relation of kind `r` in `public` has
  `relrowsecurity = true` unless it is on the exemption allowlist.
- **Why it matters**: a table without an `organization_id` can still hold data
  worth protecting — rows keyed on `auth.uid()`, platform configuration,
  per-user MFA material. "It has no org column" is not by itself a reason to be
  world-readable.
- **Enforced by**: same as INV-A1.
- **Tested at**: INV-6. The allowlist exists but is **empty**: every table in
  `public` has RLS today. A future non-tenant reference table is the plausible
  exception; adding it is a one-line diff that has to carry a reason.

### INV-A3 — no view reads through RLS as its owner

- **Invariant**: every view in `public` is defined `with (security_invoker =
true)`.
- **Why it matters**: this is the quietest tenant-isolation failure in the
  Postgres/Supabase model. A view executes with the privileges of its **owner**
  unless `security_invoker` is set, and every view here is owned by the role that
  owns the underlying tables. A view without the option therefore selects from
  the base tables with RLS bypassed — a full cross-tenant read of whatever it
  projects, available to anyone holding `SELECT` on the view. It does not error,
  does not log, and looks correct to the developer who tested it inside their own
  organization.
- **Enforced by**: the `with (security_invoker = true)` clause on each
  `create view`. Note the direction of the default: **omitting it is the unsafe
  choice**, which is the same trap as the `EXECUTE TO PUBLIC` default in section 2.
- **Tested at**: INV-8, with an empty allowlist. A view whose `reloptions` are
  null fails, which is the point. INV-10 is the control that the `reloptions`
  probe still reads the option off a real view. Current state: 6 views, all 6
  `security_invoker = true`.

### INV-A4 — no materialized view in `public`

- **Invariant**: there is no relation of kind `m` in `public`.
- **Why it matters**: Postgres does not support RLS on a materialized view at
  all. A matview over tenant tables is an unfilterable cross-tenant copy of that
  data, and its refresh runs with its owner's rights. There is no policy that can
  retrofit isolation onto it.
- **Enforced by**: nothing structural — this is a design constraint the test
  holds in place.
- **Tested at**: INV-9. If a reporting matview is ever genuinely needed it
  belongs in a schema PostgREST does not expose, and this assertion is meant to
  force that conversation rather than allow a quiet `create materialized view`.

### INV-A5 — no policy on an org-scoped table has a literal-true predicate

- **Invariant**: no row in `pg_policies` for an org-scoped table in `public` has
  `qual = 'true'` or `with_check = 'true'`.
- **Why it matters**: `using (true)` on a tenant table is an unrestricted
  cross-tenant read; a literal-true `with check` is an unrestricted cross-tenant
  write. Both are one word long and both look like a placeholder someone meant to
  come back to.
- **Enforced by**: review, plus this sweep.
- **Tested at**: INV-11. Scoped to org-scoped tables on purpose: a literal true
  is legitimate on a global reference table — `role_default_permissions_select`
  is the live example — and an assertion that failed on that would be reflexively
  neutered, which is how a real assertion gets lost.

---

## 2. The EXECUTE posture on `SECURITY DEFINER` functions — the P0 of this program

### The mechanism, stated plainly

Postgres grants `EXECUTE TO PUBLIC` on every newly created function. `anon`
inherits `PUBLIC`. Therefore **omitting a `GRANT` does not close a function — it
opens it.** Several migrations in this repository assumed the opposite, and one
of them said so out loud: migration 0093 documented a function as "keeping it
closed" while that function was `PUBLIC`-executable for its entire life.

The reach is not theoretical. The anon (publishable) key ships inside the web
bundle and the mobile app binary, so everyone who loads the site holds it.
PostgREST exposes every `EXECUTE`-able function in `public` at
`POST /rest/v1/rpc/<name>`. `SECURITY DEFINER` then runs the body with the
owner's rights, bypassing RLS entirely. "Callable by anon" means "callable by an
unauthenticated stranger with curl, as the table owner".

On top of the `PUBLIC` default, this project runs Supabase's standard
`alter default privileges ... grant execute on functions to anon, authenticated,
service_role`, so affected functions also carry a **direct** `anon=X` ACL entry.
That determines the shape of any fix: revoking from `PUBLIC` alone does not close
`anon`. Both grantees must be named.

Scale of the finding: **95** `SECURITY DEFINER` functions in `public`, **58**
were anon-executable, **15** genuinely exploitable. Migration
[`0318`](../../supabase/migrations/0318_revoke_anon_execute_secdef.sql) closed
those 15 with grants only — zero function bodies changed — so the privilege delta
stayed small and reviewable.

### The other half of the same mechanism — `authenticated` is not a gate either

`anon` is the loud half of this class, not the whole of it. A `SECURITY
DEFINER` body bypasses RLS for a signed-in stranger from another tenant exactly
as thoroughly as it does for an unauthenticated one — and here `EXECUTE`
usually **cannot** be taken away from `authenticated`. The pattern this
repository uses for privileged arithmetic is a `SECURITY INVOKER` RPC that runs
as the user and calls a definer helper as the user (`post_cycle_count` →
0342's `apply_cycle_count_location_delta`; `post_receipt_v2` → the `ensure_*`
bucket seeders). Revoking the grant takes the legitimate caller down with the
attacker; INV-C1 in section 3 is that same fact stated from the availability
side.

**When `EXECUTE` cannot be the control, the body has to be.** A definer
function that any signed-in user may call and that authorizes nothing is a
cross-tenant primitive at `POST /rest/v1/rpc/<name>`, reachable by anyone
holding any account on the platform. No exploit is involved: the caller
supplies a uuid.

That is not a projection either. A catalog sweep of the 0345 head found
**four** functions in exactly that shape, and on 2026-09-02 each was reproduced
from a foreign tenant's session, in a rolled-back transaction:

- `apply_cycle_count_location_delta` (0342) wrote `item_stock_levels` with no
  `auth.uid()`, `has_org_role`, `item_in_org` or `location_in_org` check. A
  **viewer in a different organization** — who could not `SELECT` the holding at
  all — inflated a victim rack from 10 to 5010 and then drained it to 0, leaving
  `inventory_items.quantity_on_hand` at 10 and **zero `stock_movements` rows**.
  Cross-tenant stock corruption with no ledger trail — finding **SP-001**, this
  program's most recent P0.
- `ensure_org_placement_locations` and `ensure_warehouse_placement_locations`
  (0188/0194) let any signed-in user insert `locations` rows into an arbitrary
  tenant, and tell a real warehouse uuid from an unknown one — finding
  **SP-059**.
- `_cycle_count_location_facts` (0342) resolved **any** location uuid to its
  owning organization, warehouse, kind and `deleted_at` for any signed-in
  caller — a read RLS denies. Closed by migration
  [`0350`](../../supabase/migrations/0350_location_facts_gate_and_catalog_metadata.sql).

The first three are closed by migration
[`0346`](../../supabase/migrations/0346_gate_secdef_stock_helpers.sql). All four
shipped green: every per-migration test passed, `pnpm security:test`
passed, and this file's own sweep passed — because until INV-25 there was not
one `has_function_privilege('authenticated', …)` probe anywhere in it. Reading
section 2 as "the anon posture" is what let 0342's helper stand from 0342 to
0346. The rule is the one below, and it is stated for both roles.

### INV-B1 — no ungated SECURITY DEFINER function is anon-executable

- **Invariant**: every `SECURITY DEFINER` function in `public` that can be
  invoked as an RPC and that `anon` can execute is on an explicit allowlist, and
  every allowlist entry carries its own authorization gate inside its body.
- **Why it matters**: this is the class the P0 belonged to. The 15 exploitable
  functions included an unauthenticated cross-tenant `DELETE` of every read
  notification in every organization, an account-existence oracle that makes
  credential stuffing efficient, a rate-limit primitive that let a stranger lock
  a named victim out of password reset for weeks, and anonymous row injection of
  `locations` rows into an arbitrary tenant.
- **Enforced by**: explicit `revoke execute ... from public, anon` in migration
  0318, plus an in-body gate (`auth.uid()`, `has_org_role`, `has_permission`,
  `is_org_member`) on each function that legitimately stays open.
- **Tested at**: INV-1 (the sweep), INV-2 (the allowlist polices itself),
  INV-3 (no stale entries), INV-4 (control). Per-function posture for the 15
  fixed functions is pinned in
  [`0318_secdef_grants.test.sql`](../../supabase/tests/0318_secdef_grants.test.sql).

Two design points in that test are load-bearing.

**Trigger-returning functions are excluded, and it is not a loophole.** A
function returning `trigger` cannot be invoked as an RPC: PostgREST refuses to
expose it and Postgres refuses a direct call. The exclusion is a property of the
return type, not an observation about today's catalog — which is precisely why
**17 of the original 58 were never exploitable**.

**The allowlist cannot be used as a bypass.** INV-2 requires every allowlisted
function to reference an authorization gate in its own body. Adding a name to
the allowlist for an ungated function fails INV-2 instead of buying an exemption.

Current state: 42 anon-executable `SECURITY DEFINER` functions — 17
trigger-returning (not RPC-invocable) and 25 RPC-invocable with in-body gates,
each listed with its reason in the test.

Reproduce:

```sql
select p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       (p.prorettype = 'trigger'::regtype)       as trigger_only
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prosecdef
   and has_function_privilege('anon', p.oid, 'execute')
 order by 3, 1;
```

`has_function_privilege` resolves inherited privileges, so that single probe
catches a direct `anon=X` grant, a `PUBLIC` grant `anon` would inherit, **and** a
null ACL — which is itself `PUBLIC`-executable, and is what a
`drop function; create function` silently reinstates.

### INV-B2 — anon/PUBLIC-reachable write policies consult identity or deny outright

- **Invariant**: every `INSERT`/`UPDATE`/`DELETE`/`ALL` policy in `public` whose
  role list includes `anon` or `public` either references an identity or
  authorization helper in its predicate, or is a literal `false`.
- **Why it matters**: a policy created without `TO <role>` applies `TO PUBLIC`,
  which includes `anon`. That is normal here and mostly harmless _because_ the
  predicates gate on identity — which means the role list is not the control, the
  predicate is. A public-role write policy whose predicate consults neither
  identity nor authorization is an unauthenticated write, and it would look
  unremarkable in a migration diff.
- **Enforced by**: the predicate on each policy.
- **Tested at**: INV-22, with INV-23 as the control that the population being
  judged is non-empty. Current state: 19 such policies — 16 gated, 3 explicit
  denies (the `mfa_recovery_codes_no_*` idiom that makes that table
  trigger-write-only).

### INV-B3 — no ungated SECURITY DEFINER function is authenticated-executable

- **Invariant**: every `SECURITY DEFINER` function in `public` that can be
  invoked as an RPC and that `authenticated` can execute either names an
  authorization gate (`auth.uid()`, `has_org_role`, `has_permission`,
  `is_org_member`) inside its own body, or is on **allowlist E** — the
  `_sec_inv_auth_secdef_nogate_allow` table in the invariant test, every entry
  of which is a read-only predicate that writes nothing. (Go by the table name:
  the test file currently letters two blocks `E`, this one and the storage
  path-gap list.)
- **Why it matters**: it is INV-B1's failure one role along, and it produced
  this program's most recent P0 — SP-001, described above: a cross-tenant
  `item_stock_levels` write, with no movement row, callable by a viewer in
  another organization. If anything the authenticated half is the worse of the
  two: `anon` held no `EXECUTE` on any of those four functions, so the only role
  that could reach them was the one every signup hands out.
- **Enforced by**: an in-body gate, written the way 0331, 0341, 0346 and 0350
  write it. `auth.uid() is null` means a `service_role`/`postgres` connection
  and keeps the historical behaviour unchanged. That branch is not reachable
  from the internet only because each of these migrations also re-states
  `revoke all ... from public, anon` — the null-`auth.uid()` shortcut is exactly
  as safe as that revoke and no safer. Every authenticated caller must then pass
  an explicit role or ownership check. 0346's
  arithmetic helper needs **both** halves — `has_org_role(p_org_id, 'manager')`
  *and* `item_in_org`/`location_in_org` — because a role check on the
  caller-supplied org alone still lets a manager of org B write a row tagged
  org B against org A's item and rack. 0350's `_cycle_count_location_facts`
  takes no org argument at all, so it gates on the org of the **location it
  looked up**.

  Grants are not the mechanism here and must not be pressed into being one:
  revoking `EXECUTE` from `authenticated` breaks the `SECURITY INVOKER` RPC
  that legitimately calls the helper (INV-C1). That is why each of these
  migrations re-states its `grant execute ... to authenticated, service_role`
  unchanged and puts the entire fix in the body.
- **Tested at**: INV-25 (the sweep), INV-26 (allowlist E polices itself: no
  stale entry, and no entry whose body has grown a write: `INSERT INTO`,
  `MERGE INTO [ONLY]`, `UPDATE [ONLY]` of any table, unqualified or quoted, or
  `DELETE FROM [ONLY]`; one detector shared with INV-30 and INV-31 since 0395,
  which also caught the forms the old `update public.` pattern missed), with
  INV-29, INV-30 and INV-30b as the controls (INV-30b plants one probe per
  write form and two reads that must not match). INV-29 and INV-30 plant their own probes
  inside the rolled-back transaction — an ungated definer function granted to
  `authenticated`, a stale allowlist row, and an allowlist row naming a
  function known to write — so INV-25 and INV-26 are proven able to fail on
  *every* run rather than once at review time. Per-function posture is pinned
  in
  [`0346_gate_secdef_stock_helpers.test.sql`](../../supabase/tests/0346_gate_secdef_stock_helpers.test.sql)
  and
  [`0350_location_facts_gate_and_catalog_metadata.test.sql`](../../supabase/tests/0350_location_facts_gate_and_catalog_metadata.test.sql).

Two design points in that pair of assertions are load-bearing, the same way
the trigger-return exclusion and the self-policing allowlist are under INV-B1.

**The allowlist cannot be used as a bypass, and it is not a place to park a
writer.** Its 14 entries are read-only predicates — the `*_in_org` FK-org
guards, `user_can_access_inventory`/`user_can_access_warehouse`,
`module_enabled`, `org_can_enable_module`, `org_effective_tier` — that RLS
policies and other function bodies evaluate *as the user*, which is precisely
why INV-C1 requires them to keep `authenticated` `EXECUTE`. Each answers a
boolean about a caller-supplied uuid — `assert_location_in_org` returns void and
raises instead, which is the same answer with a different calling convention —
and the single exception, `org_effective_tier`, returns the org's plan-tier
string, which is not tenant data. **None writes**, and that is the property the
exemption is bought with: INV-26 withdraws it the day one of them grows a write,
and INV-30 proves INV-26 can still see that happen.

**An attribute-returning entry is a smell, not a category.**
`_cycle_count_location_facts` was the single allowlist-E entry that returned
attributes rather than a boolean — org, warehouse, kind and `deleted_at` for
any location uuid — and it leaked all four across tenants. It is no longer
exempt: 0350 gave it `post_cycle_count`'s own `has_org_role` gate, so INV-25
now judges it on its body like everything else. "Reading past RLS is the point"
justifies the `SECURITY DEFINER`; it never justified the missing authorization
check.

Reproduce (the `authenticated` twin of the INV-B1 query above):

```sql
select p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       (p.prosrc ~* '(auth\.uid|has_org_role|has_permission|is_org_member)')
         as gated_in_body
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prosecdef
   and p.prorettype <> 'trigger'::regtype
   and has_function_privilege('authenticated', p.oid, 'execute')
 order by 3, 1;
```

### INV-B4 — the same rule holds in the `ledger` schema

- **Invariant**: every `SECURITY DEFINER` function in `ledger` that
  `authenticated` can execute names an authorization gate in its own body, or
  is on **allowlist F** (`_sec_inv_ledger_secdef_nogate_allow`), every entry of
  which is a read-only predicate.
- **Why it matters**: PostgREST does not publish `ledger` (0359), but that
  schema is not private. `authenticated` holds `USAGE` on it and `EXECUTE` on
  its bodies, because the `SECURITY INVOKER` public wrappers call them as the
  user. A definer function there is one invoker call away from any signed-in
  user. 0371 added the first definer WRITER there,
  `ledger.apply_holding_delta`, and INV-25 sweeps `public` only, so without
  this a future ungated ledger writer would be invisible to the suite.
- **Enforced by**: an in-body gate, the INV-B3 shape. `apply_holding_delta`
  checks, for a user caller: `ledger.active()` (so it runs only inside a
  ledger RPC), staff+ of the item's own org, the location in that org, and
  manager+ or `caller_can_write_location`. The one allowlisted entry,
  `ledger.cycle_count_line_superseded` (0369), returns a boolean, writes
  nothing, and answers only inside a ledger transaction.
- **Tested at**: INV-31 (the sweep, plus allowlist F's own audit: no stale
  entry, no entry whose body writes) and INV-32 (plants an ungated definer
  probe in `ledger` and a stale allowlist row; both must be caught). The
  helper's gate is pinned line by line in
  [`0371_holdings_staff_scope.test.sql`](../../supabase/tests/0371_holdings_staff_scope.test.sql)
  (section F), each line killed by its own live mutation.

---

## 3. RLS-versus-privilege interaction — the hazard that shapes every fix

### INV-C1 — a function named inside an RLS policy keeps `authenticated` EXECUTE

- **Invariant**: every function referenced from inside an RLS policy predicate
  retains `EXECUTE` for `authenticated`.
- **Why it matters**: **RLS policies are evaluated with the querying role's
  privileges.** Revoking `EXECUTE` on a helper that a policy names does not make
  the policy stricter — it makes every write through that policy fail with
  "permission denied for function". The `*_in_org` helpers are referenced inside
  25 or more write policies spanning stock, locations, receipts, purchase orders,
  orders and scheduling, so a single well-meaning "revoke everything from
  everyone" sweep is a total write outage.

  This is not a projection. It was proven empirically during the program: a
  mutation that added `authenticated` to the Group-2 revoke list in 0318 **took
  12 test files down**. That measurement is why 0318 is split into two groups
  with different treatments, and why the `authenticated` retentions are asserted
  as loudly as the `anon` revocations.

- **Enforced by**: the explicit `grant execute ... to authenticated, service_role`
  after each revoke in 0318. The explicit re-grant is not decoration: on a
  database where the surviving privilege happened to be `PUBLIC`-derived rather
  than direct, `revoke ... from public` would remove the very privilege the
  migration means to keep.
- **Tested at**: `0318_secdef_grants.test.sql` asserts `authenticated` **retains**
  `EXECUTE` on all 10 Group-2 functions, individually and as a sweep;
  `0322_quantity_guards_avatar_scope_override_clears.test.sql` does the same for
  `my_warehouse_ids()`, which policies added in 0321 and 0322 both name.

The generalization worth carrying forward: **a privilege change on a function
that a policy references is an availability change, not only a security change.**
Both directions need an assertion, and the outage-guard half is the one that will
actually fire.

### INV-C2 — the catalog, not the migration text, is the source of truth

- **Invariant**: any claim about whether a function is `SECURITY DEFINER` or
  `SECURITY INVOKER` is read from `pg_proc.prosecdef`.
- **Why it matters**: during 0318 two helpers were triaged as "service_role
  only" on the strength of migration comments, and closing `authenticated` on
  them would have broken stock adjustments, bundle assembly and distribution,
  cycle-count posting and PO receiving. The catalog said `SECURITY INVOKER` while
  a comment in the migration body said the opposite — migration 0292's
  `apply_level_delta` body contains the phrase "Use SECURITY DEFINER helper" in a
  comment while the function itself is declared `security invoker`.
- **Enforced by**: process, plus structural assertions that pin the precondition
  rather than leaving it in prose.
- **Tested at**: `0318_secdef_grants.test.sql` asserts `apply_level_delta` and
  `post_receipt_v2` are `SECURITY INVOKER` — the reason the `ensure_*` helpers
  must keep `authenticated` — and that all five `_notify_recipients` callers are
  `SECURITY DEFINER`, which is the reason closing `authenticated` on that helper
  is safe.

### INV-C3 — no API-callable `SECURITY INVOKER` code touches `item_stock_levels`

- **Invariant**: no function in `public` or `ledger` that `authenticated` can
  execute is `SECURITY INVOKER` and references `item_stock_levels` in its body
  (comments stripped).
- **Why it matters**: the table's SELECT is warehouse-scoped for every role
  below manager (AR-2). Invoker code runs under that scope, and a statement
  that reads the row fails in the wrong way when the row is outside it: a
  conditional `UPDATE` matches 0 rows and the RPC raises its own
  `insufficient_stock`; an `INSERT ... ON CONFLICT` raises a raw "new row
  violates row-level security policy"; a sum comes up short with no error at
  all. The failure is silent or misleading, never a clean refusal.
- **Enforced by**: every holdings statement runs in `SECURITY DEFINER` code:
  `ledger.apply_holding_delta` (0371, for `adjust_stock`/`transfer_stock`),
  `apply_level_delta` (0331), `apply_cycle_count_location_delta`,
  `_cycle_count_org_stock_sum`, `tg_seed_initial_level` and
  `compensate_opening_stock`. The invoker ledger bodies keep only the item
  lock, the gates, the on-hand update and the movement row.
- **Tested at**: INV-33 (the sweep) and INV-34 (plants an invoker reader,
  which must be caught, and a function that names the table only in a
  comment, which must not). Behaviourally, section E of
  [`0371_holdings_staff_scope.test.sql`](../../supabase/tests/0371_holdings_staff_scope.test.sql)
  replaces the SELECT policy with one that hides every holding from staff and
  shows staff adjust and transfer still succeed.

### INV-C4 — no `FOR ALL` policy widens a warehouse-scoped SELECT

- **Invariant**: no permissive `FOR ALL` policy exists on a table whose
  permissive SELECT policy is warehouse-scoped (its qual calls
  `my_warehouse_ids`, `user_can_access_warehouse`,
  `user_can_access_inventory`, an `rls_inv_read_*` helper or
  `rls_exc_holding_location_ids`), except the entries of **allowlist G**.
- **Why it matters**: a `FOR ALL` policy's `USING` clause also applies to
  SELECT, and permissive policies OR together. `item_stock_levels_write`
  (0202, `FOR ALL`, staff floor) therefore gave every staff member every
  warehouse's holdings while `item_stock_levels_select` looked scoped. Nothing
  in the catalog flagged it; it was found by review (2026-09-25) and closed by
  0371, which split it into `FOR INSERT` and `FOR UPDATE` policies.
- **Enforced by**: write policies on scoped tables are written per command.
  Allowlist G holds two entries: `warehouses` (its admin `USING` is narrower
  than its SELECT, so it cannot widen reads) and `purchase_orders`, a **known
  gap deferred to 0372** (`purchase_orders_write`, manager or
  `purchase_orders:manage`, widens reads past `purchase_orders:read` and the
  warehouse scope; a plain split breaks PO numbering, because
  `next_po_number` is invoker and counts only visible POs).
- **Tested at**: INV-35 (the sweep, plus a stale-entry audit of allowlist G)
  and INV-36 (plants a scoped table with a `FOR ALL` policy and a stale
  allowlist row; both must be caught). 0371's own test pins the exact policy
  set on `item_stock_levels` (A1-A4).

### INV-C5 — `order_submissions` is owner-only, and only the two writers insert into it

- **Invariant**: `order_submissions` (0391, one record per order submission
  key) has RLS on; `authenticated` holds SELECT and INSERT only, `anon` and
  PUBLIC nothing, `service_role` SELECT only. Its SELECT policy shows a member
  their own rows only (`user_id = auth.uid()` and a member of the row's
  organization). Its INSERT policy also requires
  `stockpilot.order_submit` to hold THIS transaction's id
  (`pg_current_xact_id()`), the 0359 carrier pattern, and exactly two
  functions raise that flag, inline around their one insert:
  `place_order_request` and `withdraw_order_submission`. There is no UPDATE or
  DELETE policy: a recorded outcome never changes. `user_id` has no foreign
  key, so deleting an account never fails on it.
- **Why it matters**: the record is what makes a resend of a lost order
  request answer the first outcome instead of placing a second order, and what
  makes "Don't send it" final. A caller who could insert a row directly could
  mark their own key withdrawn or placed without placing anything (harmless to
  others, but it would break the guarantee for that person), and one who could
  read another member's rows would learn their order activity. The flag rests
  on the 0359 premise: no API-callable function runs dynamic SQL or passes
  caller text to `set_config`, and `set_config` is not exposed.
- **Enforced by**: the two policies and the grants; the flag raised only
  inline (no helper function writes the table, because any helper would have
  to be executable by `authenticated` and could then be called with any
  outcome); `place_order_request` comparing the body's placer with
  `auth.uid()` before it looks at the key (a pending send left in a shared
  browser is never placed under another account). In the app (review round
  1): the New order page names its organization on every call and the
  account that sent the key on the status read and the withdraw, and
  `OrderRequestsService` refuses a mismatch (`organization_changed`,
  `placer_mismatch`) before any function runs, never settled, so a tab left
  in another workspace or under another account never settles a key it does
  not hold; every refusal names the organization that answered, and core
  `orderCallResultForOrganization` never lets an answer for another
  organization settle a key.
- **Tested at**: [`0391_place_order_request.test.sql`](../../supabase/tests/0391_place_order_request.test.sql)
  G1-G6 (grants, the two policies' text, the keys, the six functions' posture,
  the flag census, no dynamic SQL), I1-I3 (a direct insert of each outcome
  refused; `'on'` and another transaction's id refused; SELECT shows only your
  own rows), N1 (placer mismatch refused before the key) and D1-D3 (deletes);
  the 0359 census tests 17, 18 and 73 keep covering the new functions;
  `scripts/db-concurrency/0391_place_order_races.sh` proves the lock across
  two sessions; `order-requests.create.test.ts`, `order-requests.place-action.test.ts`,
  the two route tests, `order-submission.hook.test.tsx` and core
  `place-order.test.ts` cover the app's organization and account checks.

### INV-C6 — every RMA transition runs through a gated function; the database follows `returns:manage`

- **Invariant** (0394, returns RX-1): the RMA tables answer to the
  `returns:manage` permission, not to a role.
  - **Writes.** The `returns_insert`, `returns_update`, `return_lines_insert`
    and `return_lines_update` policies test
    `has_permission(organization_id, 'returns:manage')` (a revoke by
    override refuses a manager; a grant lets a staff member through) AND
    write access to the warehouse of the RMA's order
    (`user_can_access_inventory(auth.uid(), <order warehouse>, null,
    'write')`, the order read in the RMA's own organization). Because
    `returns:manage` is fully grantable, the warehouse is what bounds a
    grant: a staff member granted it for one warehouse cannot insert, approve,
    deny, receive or cancel another warehouse's RMA through PostgREST.
    `anon` and PUBLIC hold nothing on `returns`, `return_lines`,
    `return_decisions` or `return_overview`. Since 0398 (returns RX-4, the
    contract) `authenticated` holds SELECT only on `returns` and
    `return_lines`: RX-1's INSERT on both and UPDATE on the eight `returns`
    columns the old tabs' raw edges used (`status` and the approve, receive
    and deny stamps, `denial_reason`) are revoked, and no column ACL is left.
    DELETE, TRUNCATE, TRIGGER, REFERENCES and MAINTAIN were never held after
    0394. The four write policies and the two guards below stay as defence
    in depth: a grant restored by mistake still meets them (0398 K5).
  - **Guards** (`trg_returns_zz_api_guard`, `trg_return_lines_zz_api_guard`,
    INVOKER, firing only when `current_user` is `authenticated` or `anon`;
    since 0398 no API role can reach them, and they stay as defence in
    depth):
    an API insert of an RMA must be `requested`, `internal`, unstamped and
    carry no requester name or email (`return_insert_through_rpc`), and its
    RMA number is replaced by the server's; `requested_by` is the caller
    (`return_stamp_forged`); its order must be an order of the RMA's own
    organization the caller can see (`order_not_found`, P0002) in a
    warehouse the caller may write (`warehouse_write`), completed or
    delivered (`order_not_returnable`, the create functions' rule); an update moves one
    edge, sets only that edge's stamps naming the caller, with the time
    forced to `now()` (`return_stamp_forged`); no API update reaches `closed`
    (`return_close_through_rpc`); an API line insert must be unapplied and
    belong to a `requested` RMA the caller can see in the same organization
    (`return_line_insert_through_rpc`), name a line of that RMA's own order
    (`return_invalid`, so no other order loses return budget), and come from
    a caller who may write the order's warehouse (`warehouse_write`), and
    then, with the RMA held FOR SHARE (an approval, denial or cancel in
    flight is waited for and the status read again, so no line slips into an
    RMA approved a moment ago), only on an internal RMA the caller inserted
    itself that no function wrote (no decision row): a requester's RMA,
    another member's, or a function-created one takes no raw line. Between
    0394 and 0398 the old tabs' raw create, approve, deny, receive and
    cancel kept working within these rules; closing (the only edge that
    moves stock) was always function-only.
  - **The contract (0398, returns RX-4).** The raw edges are gone: an API
    insert, a status update, a line insert or update and a delete of either
    table are refused by privilege (42501) for every member, a manager with
    `returns:manage` and warehouse write included (0398 K2). No product
    code writes either table through a client
    (`returns-raw-writes.guard.test.ts`, a source scan: a literal or bound
    table name, `as const`, a chain bound to a variable, and any raw
    `/rest/v1/returns` or `/rest/v1/return_lines` URL; RX-1 deleted the last
    two writers, `RMAService.applyTransition` and the requester create's
    compensating delete).
  - **Accepted residuals after RX-4** (recorded 2026-10-11, RX4-NOTES B2 and
    B3). (1) The frozen 0359 wrapper `public.process_return_disposition`
    keeps EXECUTE for `authenticated` (plan 1.5, P30; five suites prove the
    stock body through it, and 0398 K7 pins the decision): a
    `returns:manage` holder with write access to the order's warehouse, the
    person `close_return` admits, can still close a received RMA through it
    without a decision row, an audit row, a requester notification or the
    Returns module check. Every stock rule holds on that path (status gate,
    budget, latch, the planned-rack revalidation, holdings = on hand). Its
    revoke, with those suites moved to `close_return`, is a later slice.
    (2) `idempotency_keys_write` still lets a manager write any key row of
    their organization, the return scopes included: the RMA functions never
    trust a row they did not complete (below), so a planted or edited row
    can only turn a replay into `return_changed` or `idempotency_conflict`;
    narrowing the policy would make supautils lock every policy_grants table
    at push time for no further gain. The read boundary is also wider than
    the app's `returns:read` gate: every member reads `returns`,
    `return_lines` and `return_overview` (requester email and the denial
    reason included); only `return_decisions` needs `returns:read` or
    `returns:manage`. MFA step-up is enforced by the web service, not inside
    the functions (plan follow-up 13.3).
  - **Decisions.** `return_decisions` is append-only (an UPDATE raises
    `return_decisions_append_only` for every role, the owner included);
    `authenticated` holds SELECT only, and its one policy shows rows to
    holders of `returns:read` or `returns:manage` (reasons and racks are
    staff information). Only the RMA functions write it.
  - **Functions.** `create_return_request`, `approve_return`, `deny_return`,
    `receive_return`, `cancel_return`, `plan_return_dispositions`,
    `close_return` and `return_restock_options` are SECURITY DEFINER with an
    in-body gate in this order: signed in, a member of the RMA's
    organization (a foreign RMA answers like a missing one, P0002), the
    Returns module on, `returns:manage`, then write access to the order's
    warehouse (`user_can_access_inventory(..., 'write')`). EXECUTE is
    granted to `authenticated` only; `create_requester_return_request` (the
    token page, the customer portal and member requesters) is EXECUTE for
    `service_role` only and copies the requester's identity from the order.
    The private helpers (`_return_*`, the three guard trigger functions) and
    the four `ledger.return_*` helpers hold no EXECUTE for PUBLIC, `anon`,
    `authenticated` or `service_role`; the `ledger` helpers are INVOKER, so
    0359 test 15 still lists exactly four DEFINER `ledger` functions. Every
    write locks the RMA row first under `lock_timeout = '5s'`, so a blocked
    caller is refused with 55P03, and no function raises 40001 or 40P01
    (PostgREST retries those forever). The functions never trust a key row
    in `idempotency_keys` they did not write (managers may write that table
    through the API): a create replays only an RMA of its own organization
    and order that the same caller created (the staff path: its
    `requested_by` and `created` decision; the requester path: a requester
    RMA created on the same channel by the same actor, the token path keyed
    per order), else `idempotency_conflict`; an approval takes over a key row
    with no `approved` decision at the next revision instead of answering
    `return_changed` or a false replay, and a replay answers the next
    revision and the exchange hook's replacement, never the stored response.
  - **The restock destination.** A restock to a rack is honoured only for a
    location the pick provenance proves (`stock_movements.draw`, 0373): the
    server offers `original` or a `source` location from the line's own
    draws of a handed-over order (an order in flight, or picks not handed
    over, are no provenance), a `source` capped at what is still unreturned
    there less the line's returns no rack leg recorded, and refuses anything
    else (`restock_location_not_offered`). `close_return` revalidates every
    destination under lock just before it moves stock (archived, no longer
    a placement, moved warehouse, inactive warehouse, deleted item) and
    refuses with `restock_location_unavailable` rather than falling back
    silently; a rack in a warehouse the closer may not stock is refused
    `restock_location_forbidden` (the holdings writer's own gate, answered
    with a hint), and a Staging or scrap leg in an item's current warehouse
    the closer may not write is refused `warehouse_write` (detail `itemId`).
    `close_return`'s legs, and the workbench, history and Staging-worklist
    reads, count ledger movements only (`via_ledger`), so a member's direct
    insert into `stock_movements` never reads as a leg of a return. The restated `ledger.process_return_disposition` keeps
    today's net-zero scrap and holdings = on hand; its bare refusals reach
    the app only with a hint (`close_return` raises them again, and the
    create does the same for the cap trigger's race-time
    `return_exceeds_fulfilled`), so nothing is mapped by its words.
  - **Account deletion** (with 0393, security slice A3). Nothing RX-1 adds
    refuses a deletion: `return_decisions.actor_user_id` has no foreign key,
    and the five RMA person columns keep 0393's SET NULL keys and
    `deleted_users` stamps (the API guard acts only for API roles, so the
    referential action and the stamp pass). The workbench and the list name
    a requester who deleted their account "Deleted user" (null and stamped,
    core `isDeletedPerson`) only when neither the RMA nor its order recorded
    a name or email, and the stamp columns' people the same way.
    `return_overview` carries `requested_by` and `deleted_users` for that.
    A requester whose account was deleted (the order's
    `requester_deleted_at`) is sent no return message, in the app or by
    email, not even at an address the order kept.
- **Why it matters**: before 0394 any member with an admin or manager role
  could PATCH an RMA straight to `closed` without the close's stock step,
  forge another person's approval, flip `return_lines.applied`, or insert an
  RMA already `received`, and `anon` kept Supabase's default table
  privileges. A permission revoked
  for one manager was ignored by the database. And a restock could only
  land in Staging; letting the client name a rack would let a caller place
  stock on any location in the organization.
- **Enforced by**: the grants (SELECT only for API roles since 0398), the
  four policies and the two guard triggers (defence in depth), the
  append-only trigger, and the in-body gates. In the app,
  `RMAService` calls only the functions (the raw edges are gone from new
  code), reads the RMA (or, for a create, the order) in the ACTIVE
  organization before any function runs and answers a miss as not found (the
  functions gate on the RMA's own organization, so a member of two
  organizations could otherwise act on the other one's RMA and have the
  audit row, the webhook and the inventory invalidation written into the
  active one), maps refusals by hint (core `return-error-map.ts`), and writes
  audit, outbox and webhooks only on `changed: true`. The list reads
  `return_overview` (security_invoker, so the caller's RLS applies) behind
  `returns:read` or `returns:manage`.
- **Tested at**: [`0394_returns_lifecycle_original_rack.test.sql`](../../supabase/tests/0394_returns_lifecycle_original_rack.test.sql)
  A (grants, the eight columns, function posture, the view's column order),
  B (unauthenticated, anon, foreign, module off, revoked by override for
  every function and for the raw policies, granted staff with and without
  warehouse write, granted staff refused on another warehouse's RMA by
  every function (B12), `returns:read` only, disabled), C (one-transaction
  create, key replay and conflict, the cap, the requester path), D (approval
  moves nothing), E to J (acceptance 36 to 40 and several sources, rule 9),
  K (every direct write refused, the old tabs' edges allowed, the raw
  paths bounded by the order's warehouse (K10) and tied to the order's
  organization and lines (K11)) and L
  (regression, organization deletion); each break named "Mutation:" in the
  file is caught by the test before it. The 0359 census (tests 15, 17, 18),
  INV-25 and the 0367 class guard cover the new functions.
  `scripts/db-concurrency/0394_return_close_races.sh` proves the close,
  approve and plan races across two sessions. The contract is
  [`0398_returns_contract.test.sql`](../../supabase/tests/0398_returns_contract.test.sql)
  (K1 grants, K2 every direct write refused, K3 reads unchanged, K4 every
  function path, K5 the guards behind a restored grant, K6 the guards and
  policies installed, K7 the wrapper residual); the 0394 and 0396 suites put
  0394's grants back inside their own transactions so the guards stay
  proven, and the 0158 suite writes its requested RMAs and line attempts as
  the owner (its caps fire for every role).
  `returns-rx4-migrations.guard.test.ts` fails any other pgTAP suite that
  writes the return tables as an API role without putting the grant back.
  RX-1's races 9a and 9b (the old tab's raw line insert) are skipped on a
  stack at or past the contract. App side: `returns-raw-writes.guard.test.ts`,
  `returns.test.ts`, `returns.requester.test.ts`, `returns.portal.test.ts`,
  the `/api/v1/returns` route tests and core `return-actions.test.ts`,
  `return-error-map.test.ts` and `restock-view.test.ts`.

### INV-C7 — an exchange's replacement order is written only by its RMA's functions, and waits for the returned item

- **Invariant** (0396, returns RX-2): a replacement order is an ordinary
  `order_requests` row linked to its RMA by `replacement_for_return_id`, and
  every write that makes, cancels, links, re-lines, moves (warehouse,
  delivery site, created_at) or closes as delivered-partial one runs inside
  the RMA's functions (security review F-1). The order path still picks,
  packs, stages, hands over and holds stock for a replacement, and edits its
  needed-by date and internal notes, each under its own gates and the
  return-first gate below.
  - **The link.** `authenticated` has no INSERT or UPDATE grant on
    `replacement_for_return_id` (0392 left it table-level SELECT and 13
    column INSERT grants; the new column gets none), so an API insert naming
    it is refused by privilege; `trg_zz_order_requests_replacement_link_ins`
    refuses it too for any API role (`replacement_link_server_only`) and
    `trg_zz_order_requests_replacement_link_upd` refuses every change of the
    column for every role, `postgres` included (`replacement_link_immutable`;
    both run `tg_order_requests_replacement_link`). The composite key
    `order_requests_replacement_return_fkey` (column, organization) keeps the
    RMA in the order's organization; a partial unique index allows one live
    (not cancelled or denied) replacement per RMA.
  - **The writers.** `_return_replacement_issue` (SECURITY DEFINER, no API
    EXECUTE) inserts the header and lines as `postgres` (the 0387 workflow
    guard exempts it; it is pinned in 0387 AL9 on purpose, critic K11) and
    approves through `approve_partial` (called, never restated): the same
    holds, the same free-stock rule (on hand minus every active hold). It
    copies the requester from the original order (member, email-only,
    portal customer, or a deleted requester's stamp), never mints a track
    token, and stamps `unit_cost_at_request` from the item. It checks
    `orders:approve` and write access to the original order's warehouse
    itself (security review F-4, defence in depth: every caller checks both
    first, so a future caller cannot forget them). The exchange
    functions (`change_return_replacement`, `cancel_return_replacement`,
    `release_return_replacement_early`) gate in this order: signed in, the
    RMA read without a lock (foreign answers like missing), the Returns and
    Orders modules, `returns:manage`, `orders:approve`, write access to the
    original order's warehouse; then the RMA row lock, then the live
    replacement's. `decline_return_replacement` ("Close as return only"
    after a replacement cancel) touches no order and gates on the Returns
    module, `returns:manage` and warehouse write, as declining an exchange at
    approval does. The hooks run inside the RX-1 functions, after their own
    gates and their RMA row lock: `approve_return` checks the Orders module
    and `orders:approve` for an exchange before its lock, while
    `_return_exchange_on_cancel` checks them for an approved exchange only
    AFTER `cancel_return`'s row lock (cancel_return is pinned and unchanged),
    so a caller without the permission can wait on that row for up to its
    5 s lock timeout before the refusal: accepted and recorded (desk check
    F8). One replacement per approved revision: the approval's key
    `<rma>:<revision>` (scope `return_approval`) and the change's (scope
    `return_replacement_change`) replay the order already issued, and another
    body at the same revision is `return_changed`. Stale screens: the
    replacement cancel and "Close as return only" need the revision the
    caller saw, and the early release names the replacement order the caller
    saw; anything newer is `return_changed` (desk check F7). The
    replacement cancel also names the replacement's status as the caller's
    screen showed it (`p_shown_status`): a replacement picked since a screen
    that showed it unpicked, or on its way since one that showed it in the
    building, is `return_changed`, so the screen reloads into its Staging and
    driver warnings (verification V1: a release, the pick, packing, staging
    and the departure never bump the revision). An API caller that names no
    status is not checked; its answer carries `drawn` and `inTransit`, and
    both screens say those after the call too.
  - **Never more out than returned, per original unit** (desk check F2;
    review S1). Every unit of an original order line is exchanged once,
    whatever RMA asks: an exchange quantity is capped by the RMA's returned
    quantity and by what the original line has left
    (`_return_exchange_line_budget`): its handed-over quantity, less every
    unit the other RMAs neither cancelled nor denied return or returned on it
    (the durable `returned_quantity` less this RMA's own applied units, and
    the others' unapplied lines), exchange or return only, less the units
    replacements already handed over for it under cancelled RMAs (the
    customer kept those units: a later RMA brings them back as a return
    only). A return only claims its units too (verification V2): units are
    alike, and one made BEFORE a cancelled hand-over cannot have brought back
    the unit that RMA replaced (RX-1's pool kept them apart), so counting
    only exchanges let that unit be exchanged a second time. The price,
    accepted: a return only made AFTER the cancel does not free another unit
    for exchange either (an exchange refused there can be handled as a return
    only plus an ordinary order). The create, the approval (approve and "Add
    a replacement"), a change and a re-issue refuse more with
    `exchange_already_sent` (detail quantity and available). Without a
    cancelled RMA's hand-over the budget never binds: it is RX-1's returnable
    pool with the RMA's own units put back. Every claim is a returned unit,
    fixed when its RMA is created, and creates on one line meet on the 0153
    cap trigger's row lock, so since V2 the line's budget lock is defence in
    depth. A replacement that handed anything over, whatever
    its status (a backorder, or one resumed into picking), is handed over:
    neither cancelled nor changed from its RMA (`replacement_handed_over`).
    A re-issue sends each exchange line at most its returned quantity minus
    what this RMA's replacements already handed over for it
    (`_return_exchange_fulfilled`), and at most the line budget.
  - **Lock order** (desk check F4; review S1, S3). Every exchange writer
    takes, before the first row naming an item, its item locks in id order
    (`_return_lock_items`): when it will insert an order, the organization's
    order-number advisory lock (the one `assign_order_request_number` takes)
    and then FOR UPDATE, so two issuing writers never hold key-share locks
    the other's FOR UPDATE needs; when it issues no order (the deny hook,
    "Close as return only", an approval that only declines), FOR KEY SHARE
    and no order-number lock (review S3: FOR UPDATE there deadlocked an
    ordinary order inserting its lines in payload order, race 13). A writer
    that may raise what an RMA claims on an original line (the create, an
    approval that approves or adds, a change, a re-issue) then takes that
    line's budget lock (`_return_lock_exchange_budget`, a transaction-scoped
    advisory lock per line, in id order) after every item lock, so no writer
    waits for an item while holding it (race 14). Accepted residual: the
    frozen RX-1 create takes key-share locks on the returned items before the
    requested ones, so a create with an exchange can still meet an id-ordered
    FOR UPDATE item locker on an order holding both items in a 40P01: the
    exchange writers, and on the order side `approve_partial`,
    `hold_order_stock`, `resume_fulfillment` and `complete_picking` (review
    S4; the window is the gap between two rows' foreign-key checks, so it is
    rare, and nothing is written). The RMA side answers it with the plain
    "Busy. Try again." (40P01, like 55P03 and 57014), and since returns RX-3
    so does the order side: every mapping place of the order service
    (`lib/order-busy.ts` `isOrderBusyError` / `orderBusyRefusal`: the named
    mappers keep their own busy words, the inline mappers of every order
    function, the gated pick-slip write, the line insert, the placement and
    the shortfall PO draft) answers 55P03, 57014 and 40P01 as a retryable
    409 instead of an internal error (`order-requests.busy.test.ts`).
  - **The return-first gate.** `trg_order_requests_zz_replacement_status`
    (SECURITY DEFINER, every role) refuses a replacement's move to
    `pick_slip_generated` (from `approved`, or a resume from `backordered`)
    unless its RMA is `received` or `closed`, or a `released_early` decision
    names THAT order (`replacement_waiting_for_return`); a substituted order
    needs its own release. It never lets one in while its RMA is cancelled
    or denied, released or not (`replacement_return_cancelled`, desk check
    F3); cancelling an RMA closes a replacement handed over in part as
    delivered-partial (`close_partial`) when it is on backorder and cancels a
    remainder already resumed into picking, so nothing more ships for a
    cancelled return. The same trigger refuses `cancelled` and `denied`
    unless the RMA's functions set the transaction-bound flag
    `stockpilot.return_exchange` (`replacement_cancel_via_return`), so a
    manager cancelling from the order page is refused and the RMA stays in
    step; the requester's own cancel is refused one step earlier by
    `cancel_order_request`'s pending-approval window (0395,
    `requester_pending_only`), since a replacement is approved in the
    transaction that creates it. A replacement already picked is cancelled through
    `cancel_order_request`'s drawn branch (the batch back to Staging, holds
    released) by "Cancel replacement" only: cancelling the RMA is refused
    while its replacement is picked, being packed, staged (for pickup or
    delivery) or in transit (`replacement_in_progress`, review S2), and
    "Cancel replacement" is refused when the replacement was picked or sent
    after its screen showed it (verification V1), so neither path restocks a
    unit nobody was warned about; one handed over is never cancelled
    (`replacement_handed_over`).
  - **The header guard** (security review F-1).
    `trg_order_requests_zz_replacement_header` (SECURITY INVOKER, every
    role, `postgres` included) refuses a change of a replacement's
    `warehouse_id`, `delivery_charter_id` or `created_at`, and its move from
    `backordered` to `completed` (`close_partial`, the order page's "close
    as delivered-partial"), unless an RMA function raised the
    transaction-bound flag (`replacement_cancel_via_return`): `created_at`
    orders the RMA's replacements (a re-issue inherits the newest one's
    fulfilment), and the replacement stays in the warehouse it was issued
    in. The RMA cancel raises the flag around its own `close_partial` (pinned
    by the 0396 preflight since verification V-3), and so does "Close the
    rest" (`close_return_replacement_rest`, 0397, returns RX-4; below). A
    data fix by the owner raises the flag the same way. Residual
    (verification V-1, recorded): the
    RMA's gates read the ORIGINAL order's warehouse, which this guard does not
    pin; `order_requests_update` still lets an `orders:approve` holder who
    writes both warehouses move a completed original by a raw PATCH (no
    screen or service writes an order's warehouse), and the RMA's warehouse
    scope follows it: staff of the new warehouse can then release or cancel
    the replacement in the old one (no order crosses warehouses: a change to
    an item of the old warehouse is `exchange_item_not_eligible`). Production
    had 0 such RMAs on 2026-10-11. "Close the rest" (RX-4) also asks write
    access to the live replacement's own warehouse, under its lock, so it is
    closed for that path (0397 B7); change, cancel and release keep the
    residual. Follow-up for a later returns slice: refuse a warehouse change
    on an order that has an RMA, or ask the replacement's warehouse in those
    three functions too.
  - **Close the rest** (0397, returns RX-4; RX-2 verification V3).
    `close_return_replacement_rest` (SECURITY DEFINER, EXECUTE for
    `authenticated` only, 5 s lock timeout) ends a replacement handed over
    in part whose rest is on backorder, once its RMA is received or closed
    (an approved RMA keeps `cancel_return`'s own close). Gates before any
    lock, in the 3.3.1 order: signed in; the RMA read without a lock (a
    foreign RMA answers like a missing one); the Returns and Orders modules;
    `returns:manage`; `orders:approve`; write access to the original order's
    warehouse; a reason (1 to 1,000 characters) and the revision the caller
    saw. Then the RMA row and the live replacement `FOR UPDATE` (the X-2
    order; it names no item, so it takes no item lock), write access to the
    replacement's warehouse, the revision (head kinds, unchanged:
    `return_changed`), the RMA status (`invalid_status_transition`), a
    replay (completed after an earlier close: `{changed: false}`), the
    status the caller's screen showed (`return_changed`), and a backorder
    that handed something over (`replacement_not_backordered`; a rest
    resumed into picking is out of scope). It calls the unchanged
    `close_partial` under the transaction-bound flag through the internal
    helper `_return_replacement_close_partial` (INVOKER, no EXECUTE for any
    role; it raises the flag and restores it), and appends the non-head
    decision `replacement_closed` (reason and order
    required, no revision: `return_decisions_replacement_closed_chk`), so no
    revision read changes. Nothing moves in stock; every hold on the rest is
    released. Races against itself, `resume_fulfillment`, `close_return`
    and Cancel replacement are
    `scripts/db-concurrency/0397_returns_followups_races.sh` R1 to R3 and R6.
    Its preflight pins, besides the gates and `close_partial`,
    `is_org_member`, `module_enabled` and the four `order_requests` trigger
    bodies the close relies on (the replacement ping, the replacement status
    rule, the transition table and the workflow guard), so a slice that
    restates one of them first stops this push (fix round 1, desk check
    stock S2).
  - **The flag** (security review F-5). `stockpilot.return_exchange` is the
    only barrier for SECURITY DEFINER callers of `cancel_order_request` and
    `close_partial` on a replacement, and of the header guard. It counts only
    when it holds the current transaction's id, and no API role can set it:
    PostgREST sets only `request.*` and the role, and no API-callable
    function sets it. Exactly three functions set it, each around one call
    of its own and each with no EXECUTE for any role:
    `_return_replacement_cancel_order`, `_return_exchange_on_cancel` and (RX-4)
    `_return_replacement_close_partial` (0397 A1b pins the list). Keep it
    that way: never add an API-callable function that sets this setting, or
    that takes a setting's name from its input.
  - **Fixed lines.** `trg_zz_order_request_lines_replacement_guard`
    (BEFORE INSERT only) refuses an API-role insert of a replacement's lines
    (`replacement_lines_fixed`); an update is refused by the
    `order_request_lines_no_update` policy, not by this trigger (desk check
    F8). The app refuses both before any write. Recorded (verification V7):
    unlike the header guard, the lines guard holds for API roles only; the
    service role bypasses the policy and the trigger returns early for it,
    so a service-role line insert or quantity update on a replacement would
    pass outside the exchange budget. Today every admin-client line edit goes
    through `loadEditableOrderHeader`, which refuses a replacement first; an
    every-role guard (allowed only under the flag, and only for the columns
    picking and approval write) is defence in depth for a later slice.
  - **Reads.** `return_exchange_lines`: members SELECT (RLS on the RMA's
    organization), no API write; `return_decisions.exchange_line_id` is a
    composite key to (exchange line, RMA). A line's decision (approved item,
    quantity, approver, replacement order and line, revision) changes only on
    a move into `approved` (`tg_return_exchange_lines_validate`, every role):
    a cancelled line, and one declined by "Close as return only", keeps the
    last replacement it named for display, and
    `return_exchange_lines_unapproved_chk` refuses a replacement on a
    `requested` line (desk check F9.2: the first CHECK also refused one on a
    declined line, so every "Close as return only" failed). `return_exchange_candidates` is
    SECURITY INVOKER (the caller's item scope applies; gate: the order
    readable, `returns:manage`); `return_exchange_options` (the requester
    tier, RX-3) is `service_role` only; `return_exchange_flags` answers the
    decision-log facts the security-invoker `return_overview` needs (released
    early, received at the counter, the revision; no reason, name or rack) to
    members and the service role.
  - **Notifications.** `trg_order_requests_notify` now fires only for an
    ordinary order (`WHEN replacement_for_return_id IS NULL`, the body
    unchanged); a replacement's own trigger pings nobody on insert,
    approval, cancel or denial, rewords the requester's ready, on the way,
    partly handed over and completed pings, and stays silent on ready for
    pickup after a counter receipt. Staff are never pinged for a replacement.
  - **The requester tier (RX-3).** A requester's exchange is created by
    `create_requester_return_request` (service role only) from the token
    page, the B2B portal and a member's own order (web and phone); the item
    must be one of the line's own options (`_return_exchange_item_ok`
    'requester', the same predicate as `return_exchange_options`), and any
    other item, known or not, other organization included, answers the same
    generic `exchange_item_not_eligible` 400 (no oracle). Since 0397 (RX-4;
    RX-3 security review, finding 2) the requester create key-shares only
    the named items that are options of their own line, still in id order
    before the budget lock, so a body naming any other id locks nothing of
    it (race R5a; R5b proves an option is still locked first). Since 0397
    `return_exchange_options` also leaves out a line whose exchange budget
    is used up (every unit of it already got a replacement, a cancelled RMA's
    included; RX-3 stock desk check F5), so its sizes are never offered. The
    screens still offer the warehouse-review note on such a line, as on any
    line without sizes, and the create refuses it after sending
    (`exchange_already_sent`); showing Return only there is a deferred UI
    follow-up (fix round 1, desk checks people M1 and complete C9). The
    `RETURNS_EXCHANGE_CREATE=off` switch refuses a new exchange on every
    create surface (and "Add a replacement") with `exchange_not_available`;
    a return still goes through.
  - **The requester surfaces (RX-3).** The sizes for the token page are a
    POST (`/api/v1/public/returns/options`) with the token in the BODY, never
    in a URL; every answer of it and of the public submit is
    `Cache-Control: no-store`; an unknown token, an order that cannot come
    back and the Returns module off answer one 404 shape; the limits are
    fail-closed and keyed by IP and by sha256(token), never the raw token.
    zod strips a disposition, an approved item, a status, a warehouse, an
    organization, a location and a replacement order id; the token never
    opens the catalog; `order_requests.return_token` is never read (tokens
    live only in `order_request_secrets`, read through
    `loadRequesterReturnContext` with the service role). The member routes
    (`/api/v1/orders/[id]/return-request`, its `options`) serve the caller's
    own order only (`requester_user_id` = the caller, never a portal order;
    anything else is the one 404), are module-gated, answer 401 for a
    disabled account (an account whose status cannot be read gets the
    route's own 500, no-store) and apply the MFA floor to the write. A
    requester payload carries only core's key lists
    (`requester-exchange-types.ts`); `forbiddenRequesterKeys` is run by the
    tests on every payload a requester receives (no organization, warehouse,
    rack, Staging, disposition, cost, quantity on record, note, reason or
    staff key); availability is two words, never a count. Tracking ("Your
    requests on this order") shows only the requester's own requests in core
    sentences. Photos are signed only for the order's returned items and the
    eligible options, chunked at 1,000 paths, never inside a cached
    function. The web order page shows a requester who cannot read returns
    each own request once, as tracking, never the staff card (reason,
    disposition, notes) beside it (core `requesterReturnsView`, the phone's
    rule too).
  - **The token lookup (RX-4, 0397; RX-3 security review, finding 1).**
    `orderIdForReturnToken` calls the service-role SECURITY DEFINER function
    `order_id_for_return_token` with `.rpc()`, a POST, so the raw token
    travels in the request body and never in a PostgREST query string the
    API gateway logs; a token that is not a uuid asks nothing. No product
    file filters on `return_token` (`order-secrets.test.ts`).
  - **Accepted residuals (RX-3, recorded; the token query string and the
    requester lock set were closed by 0397).** The app's API URLs and its
    own logs are clean (every RX-3 read and write carries the token in the
    body; `reportError` redacts). The token page's own path
    (`/returns/request/<token>`, and its refresh after a submit) is the
    emailed link by design (RX-1), so the hosting platform's request log
    records it. A comped organization with the Returns row explicitly off
    answers the member routes 404 rather than 403 (two module checks; fails
    closed). Off Vercel, `publicRequestIp` falls back to a client-settable
    `x-real-ip` (production runs on Vercel, where the platform sets
    `x-forwarded-for`). A member's web request on an order WITH a return
    token goes through the token page and is recorded as the token channel
    with no user (RX-1's design, D16); one without a token, and the phone,
    go through the member routes and record the member; moving the web's
    token path to the member routes is an owner decision.
  - **Accepted limits** (desk check F10, recorded). The kill switch is
    app-only: a `returns:manage` holder calling `create_return_request` with
    an exchange line, or `approve_return` with "add", straight through the
    API still starts an exchange (that caller already holds the permission
    the screens check; the database fallback after the first exchange is the
    forward "neutralise" migration kept with the revert kits). Cancelling a
    replacement out for delivery (`in_transit`) restocks the picked batch to
    Staging on record while the unit is still with the driver
    (`cancel_order_request`'s unchanged drawn branch); only "Cancel
    replacement" does this, its screens say to ask the driver to bring it
    back before and after the call, and a screen that showed the replacement
    before it left is refused (`return_changed`, verification V1); the RMA
    cancel is refused there (review S2).
    `return_exchange_lines.request_note`, the requester's own words, is
    readable by every member, the same posture as `returns.notes`.
    `return_exchange_candidates` (SECURITY INVOKER) checks neither the
    Returns module nor the warehouse (security review F-3): it reads items
    and holds under the caller's own RLS, so a member sees only what they
    may read already, and it writes nothing; the app gates the module. A
    part-handed-over replacement on backorder whose RMA is already received
    or closed is closed as delivered-partial only by "Close the rest" (RX-4,
    above); a rest already resumed into picking goes on through picking and
    hand-over on its order (the order page offers no cancel or close for a
    replacement). Whether such a rest can come back to backorder (a short
    pick) and then be closed is checked at the test stage.
- **Why it matters**: a replacement is stock promised to someone. Without
  these rules an exchange could be issued twice for one approval, picked and
  handed over before the item it replaces came back, cancelled from the
  order page while its RMA still promised it, edited to other items, or
  linked to another organization's RMA through the API.
- **Enforced by**: the column grants, the link, status and lines guards,
  the partial unique index, the in-body gates and the flag; in the app,
  `RMAService` (one function per action, audit, events and messages only on
  `changed: true`), `OrderRequestsService` (the hints mapped by
  `order-replacement.ts`, `loadEditableOrderHeader` refusing a
  replacement, `prepareForHandover` running each order step with its own
  gates and never signing) and the order email choke point (a replacement
  never gets the ordinary order emails).
- **Tested at**: [`0397_returns_followups.test.sql`](../../supabase/tests/0397_returns_followups.test.sql)
  (RX-4: Close the rest's posture, gates, states, the close, the replay,
  the flag restored, a closed RMA, a resumed rest; the token lookup; the
  requester lock set; used-up lines; a discontinued group and a foreign
  item on the requester tier; the decision shape; the frozen bodies) with
  `scripts/db-concurrency/0397_returns_followups_races.sh`, and
  [`0396_returns_exchange_staff.test.sql`](../../supabase/tests/0396_returns_exchange_staff.test.sql)
  (acceptance 36 end to end and 41, header inheritance, the staff tier, one
  replacement per revision, the link and lines guards, the cancel guard,
  X-1 and C-1, "Close as return only", a replacement handed over in part
  and the re-issue cap, the RMA cancel after a part hand-over, the lock
  order, stale screens, the early release, cancel and deny, the notify
  split, the status CASE, organization deletion, grants; the review fixes
  W1-W9: a second RMA on a line whose unit already got a replacement is a
  return only, the per-unit budget at the create, the approval, a change
  and a re-issue, the RMA cancel refused while the replacement is picked or
  in transit, the header guard and the issuer's own gates, with A10 and A12
  pinning the lock modes and order; each break named in the file's
  mutation table is caught by the test it names), re-pinned 0384 GO1, 0385
  Z2, 0387 AL9/AL10, 0388, 0391 and 0394;
  `scripts/db-concurrency/0396_exchange_races.sh` (two sessions: double
  approval, substitution against a pick slip, cancel against prepare,
  release against receive; two RMAs on one item, approval against approval
  and against substitution, a third session forcing the interleave: a wait,
  never 40P01; a denial against an ordinary order's lines, never waiting
  (race 13); two RMAs taking an original line's last unit, one refused after
  waiting on the budget lock (race 14)). App side:
  `returns-exchange.test.ts`, `order-requests.replacement.test.ts`,
  `order-replacement.test.ts`, `replacement-update.test.ts`, the exchange
  route tests, and core `return-actions.test.ts`, `exchange-status.test.ts`
  and `exchange-view.test.ts`.

---

## 4. Storage — path shape and bucket exposure

### The mechanism (HI-8)

Five services accepted a client-supplied storage path, gated it with
`path.startsWith(orgId + '/')`, and handed it to a Supabase Storage client. A
prefix check is a **negative** guard: it asserts what the front of the string
looks like and says nothing about the rest. `@supabase/storage-js` interpolates
the path directly into a `fetch()` URL, and the WHATWG URL parser resolves `..`
segments **before the request leaves Node**, so

```
${orgId}/../../item-images/<victim-org>/<victim-item>/cover.jpg
```

passes `startsWith`, escapes the org folder **and the bucket**, and comes back as
a **service-role-signed URL that RLS never evaluated**. The traversal is
invisible if you reason only about the string you think you received, because the
normalization happens downstream of your check.

The fix is a strict **positive shape**: the path must be exactly the form the
mint produces, built from server-known ids. A denylist has to enumerate every
encoding of "go up a level"; a positive shape only has to enumerate what a
legitimate path looks like, and `..`, `%2e%2e`, `%252e%252e`, a leading `/`, a
`\`, an embedded NUL and a different-bucket hop all fall outside it for free.

### INV-D1 — a caller-supplied storage path is validated against a positive shape

- **Invariant**: no code path signs, downloads or deletes a storage object at a
  client-supplied path without first matching that path against a strict
  anchored shape built from server-known ids.
- **Why it matters**: the signing client is the **service-role** client on
  several of these paths, so RLS is not a backstop. The prefix check was the only
  guard, and it did not hold.
- **Enforced by**: [`apps/web/src/lib/storage-path.ts`](../../apps/web/src/lib/storage-path.ts) —
  two deliberately redundant layers, a segment/character denylist
  (`hasUnsafeStorageSegment`) and then the anchored shape match, composed by
  `isValidStoragePath`. Callers must go through `isValidStoragePath`; the shape
  match alone is not the entry point.
- **Tested at**: `apps/web/src/lib/storage-path.test.ts` (the validator,
  including regex-metacharacter injection through the id arguments) and
  `apps/web/src/server/services/storage-path-traversal.test.ts` (every
  bucket-writing service refuses traversal and cross-org paths).
- **Not machine-checkable generically**: "no _future_ call site forgets to call
  the validator" cannot be asserted from the database, and a source-grep
  assertion for it would be brittle enough to be worse than the review rule. The
  mitigation is INV-D2, which does not depend on the call site behaving.

### INV-D2 — the database refuses the traversal alphabet regardless of writer

- **Invariant**: every column in `public` whose name contains `path` carries a
  `CHECK` constraint refusing `..`, `%`, a leading `/`, `//`, `\`, control
  characters, over-length and empty — or is on the recorded known-gap list.
- **Why it matters**: the service-layer shape check is bypassable, because the
  service layer is not the only writer. `authenticated` holds `INSERT` on these
  tables through PostgREST and their write policies gate the _role_ and FK-org
  consistency, never the _value_ of the path. Two live examples:
  `apps/mobile/src/components/po-attachments.tsx` inserts into
  `public.po_attachments` directly through PostgREST and never calls the service;
  and `maintenance_request_attachments`' `INSERT` policy lets a request's own
  requester insert a row, so a hand-rolled request can name any path it likes.
- **Enforced by**: migration
  [`0323`](../../supabase/migrations/0323_storage_path_shape_constraints.sql) —
  nine `CHECK` constraints, written inline rather than as a helper function on
  purpose. A `CHECK` that calls a function is only as immutable as that function:
  a later `create or replace` silently changes what every constraint means with
  no re-validation.
- **Tested at**: INV-15 (sweep with a known-gap allowlist), INV-16 (no stale gap
  entry), INV-17 and INV-18 (controls, in both directions).

The constraints are `NOT VALID` deliberately. Production was verified clean
before the change — 1,001 rows across the seven columns, zero `..`, zero `%`,
longest path 127 characters against a 400 cap — so a validating constraint would
very probably have succeeded. "Very probably" is the wrong risk posture for a
deploy: `add constraint` without `NOT VALID` takes an `ACCESS EXCLUSIVE` lock and
full-scans the table, and if one row disagrees the migration aborts, which in
this repo means pending migrations and crashed pages. `NOT VALID` enforces the
invariant on every new insert and update — the entire attack surface, since the
threat is a hostile write and not a legacy row. Promoting them with `validate
constraint` is a separate, safe owner step (`SHARE UPDATE EXCLUSIVE`, no read or
write block) and the re-check query is in 0323's header.

**Known gap, recorded rather than omitted.** Five path columns do not yet carry
the floor: `item_attachments.storage_path`, `cycle_count_ai_scans.photo_storage_path`,
`import_jobs.storage_path`, `size_count_training_samples.image_storage_path`,
`support_tickets.attachment_path`. They are listed in the invariant test's gap
allowlist so the exposure is visible in CI output, and so a _new_ path column
still fails INV-15 rather than joining the gap silently. Closing one means
deleting its row from the allowlist in the same change as the constraint
migration; INV-16 fails if that is forgotten.

### INV-D3 — bucket exposure is an allowlist

- **Invariant**: no `storage.buckets` row has `public = true` unless it is
  allowlisted, and every bucket sets a `file_size_limit`.
- **Why it matters**: a public bucket serves every object in it from an
  unauthenticated URL with **no policy evaluation** — the object key is the only
  secret, and object keys here are built from ids that appear in storage paths and
  dashboard URLs. And an uncapped bucket is a storage-exhaustion and
  cost-amplification primitive for any principal that can write to it, since the
  cap is the only limit that applies to a direct upload that never transits our
  server.
- **Enforced by**: the bucket definitions in their creating migrations.
- **Tested at**: INV-19, INV-20, with INV-21 as the control. Current state: 12
  buckets, 2 public (`org-logos`, `user-avatars` — both render in shared UI and
  outbound email), 12 with a size cap. Read scoping of `user-avatars` to the
  owning user's folder is proven end-to-end against `storage.objects` in
  `0322_quantity_guards_avatar_scope_override_clears.test.sql`, not merely as
  policy text.

---

## 5. Service-role boundary

The service-role key bypasses RLS completely. It is the one credential in the
system for which no database-level guard exists, so its boundary is drawn in
application structure.

### INV-E1 — the service-role key cannot reach a client bundle

- **Invariant**: no module that can be imported into a client bundle can reach
  `SUPABASE_SERVICE_ROLE_KEY`.
- **Why it matters**: a service-role key in a browser bundle is total compromise
  of every tenant's data, and it is a mistake that ships silently — the code
  works.
- **Enforced by**: mechanically, and this is the strong part. The key is only
  readable through [`apps/web/src/lib/env.ts`](../../apps/web/src/lib/env.ts),
  which begins `import 'server-only'`, so **any** client-bundle import of it is a
  **build error** rather than a review miss.
  [`apps/web/src/lib/supabase/admin.ts`](../../apps/web/src/lib/supabase/admin.ts)
  reads the key only from that module, and client components read
  `NEXT_PUBLIC_*` from `lib/env.client.ts` instead.
- **Tested at**: `pnpm build` is the test — the `server-only` guard fails the
  compile. That is a stronger enforcement than any assertion could be, and no
  unit test is added for it. Current state: zero client components reference
  `createAdminClient`.

### INV-E2 — a request-scoped read uses the caller's client, not the admin client

- **Invariant**: data returned to a user is read through the user-authenticated
  client (`ctx.supabase`) unless there is a stated reason the operation must
  bypass RLS.
- **Why it matters**: `createAdminClient()` returns rows from every tenant. Using
  it for convenience — to avoid debugging a policy, to "just make the query
  work" — converts an RLS-protected read into an unprotected one with no visible
  symptom. The legitimate uses are narrow: webhooks with no user, scheduled jobs,
  platform-admin tooling, and the few paths that must read across tenants by
  design.
- **Enforced by**: review, plus the service/context layering — `ctx.supabase` is
  the user-authed client and is what services receive.
- **Tested at**: **not covered by a generic executable assertion, and that is a
  real gap.** `createAdminClient` is referenced in 178 files in `apps/web/src`;
  no automated rule distinguishes a justified use from a lazy one, because the
  distinction is semantic. What _is_ tested is the consequence in specific
  places: AI tool reads are asserted org-scoped
  (`apps/web/src/lib/ai/tools.security.test.ts`,
  `supabase/tests/0320_semantic_search_org_scope.test.sql`), and the service-role
  storage-signing paths are asserted shape-constrained
  (`apps/web/src/server/services/public-items.test.ts`). Any new admin-client
  call site is a review item; treat "why is this not `ctx.supabase`?" as a
  required question, and the answer belongs in a comment at the call site.

### INV-E3 — a cron or webhook entry point authenticates before acting

- **Invariant**: every route that acts with service-role privileges on an
  unauthenticated inbound request validates a shared secret and fails closed if
  that secret is unset.
- **Why it matters**: these routes are the internet-facing half of the
  service-role boundary. Failing _open_ on a missing secret is the dangerous
  default, because a misconfigured deploy then exposes an unauthenticated
  privileged endpoint.
- **Enforced by**: `CRON_SECRET` / `STRIPE_WEBHOOK_SECRET` validation on every
  inbound call, both fail-closed if unset (`SECURITY.md`).
- **Tested at**: per-route gate tests (for example
  `apps/web/src/app/api/books/extract-isbns-ai/route.gates.test.ts`,
  `apps/web/src/app/api/v1/items/upc-lookup/route.gates.test.ts`). There is no
  generic sweep asserting that _every_ cron route is gated; adding one would be
  a worthwhile follow-up and is listed as such in the README.

### INV-E4 — a Bearer route reads as the caller, and an admin read waits for the caller's own perimeter

- **Invariant**: a route the phone calls with `Authorization: Bearer` makes
  every per-caller read through `ctx.supabase`, never through the cookie client
  (`@/lib/supabase/server` `createClient`), the request-cached helpers that use
  it (`getModulesForRequest`, `readWarehousesForRequest`) or a page-only helper
  (`withContext`, `requireOrgContext`). Where it reaches a shared admin-client
  read (a cached catalog, a site list, a photo map), it first checks the id it
  will read against what the caller can read with their own client. The phone
  storefront's three reads (phone ordering PO-3: `GET /api/v1/orders/storefront`,
  `/catalog`, `/catalog/photos`) are the first routes held to this by a test.
- **Why it matters**: on a Bearer request the cookie client is anonymous, and
  row level security answers an anonymous reader with nothing, not an error. A
  staff member or viewer then gets an empty warehouse list, an empty catalog,
  no kits and no Frequently ordered, silently; a test driven as a manager
  passes with the bug in place, because owner, admin and manager skip the
  catalog scope read. In the other direction, the storefront's sites loader
  reads with the admin client by warehouse id alone, so a foreign id would
  answer another organization's site names and addresses if no perimeter came
  first (`assertWarehouseAccess` returns early for full-access roles and is not
  enough).
- **Enforced by**: `OrderStorefrontService` (the gates, the kill switch, the
  warehouse perimeter from `warehouses_select` as the caller, then the loaders);
  the web loaders' optional caller parameters (`resolveCatalogScopeKey` and
  `loadCatalogItems` take the caller's client, `loadOrderKits` the caller's
  modules and client, `readFrequentlyOrdered` the caller's client), outside the
  cached callbacks, whose source text stays pinned.
- **Tested at**: `apps/web/src/app/api/v1/orders/storefront/bearer-safe.guard.test.ts`
  drives the three routes through the real service and loaders as a viewer
  with category grants and a charter-scoped assignment, with the cookie client
  and `getModulesForRequest` made to throw, and asserts the five scope helpers
  went to `ctx.supabase` and the answers are exactly the viewer's rows; the
  same file fails on any banned helper named in the routes, the service, the
  answer helper or `orders-phone-catalog.ts`.
  `apps/web/src/server/services/order-storefront.test.ts` covers the perimeter
  (a foreign, a hidden and an archived warehouse each refused before any
  shared read; an id in capitals read as the stored lower-case id) and the
  trimmed, price-free item.
- **Accepted, not enforced (same as the web)**: the photo map is signed once
  per organization and warehouse with the admin client, and every caller at
  that warehouse receives the same URL strings, each valid for 30 days from
  signing (`ORDER_PHOTO_URL_TTL_SECONDS`). The answer is filtered to the
  caller's own catalog, so a caller receives only photos of items they may
  see, but a viewer whose category grant or assignment is later removed keeps
  working URLs for the photos already received until they expire. The web
  storefront's thumbnail map behaves the same way (a 30-day sign the browser
  receives in the page payload), so the phone shows nobody anything new. The
  signer cannot be pointed at another organization's object: image row paths
  are held by 0381 (`item_image_row_path_ok` in the insert and update checks)
  and 0323 (`item_images_storage_path_safe`, `item_images_thumb_path_safe`).
  If removal must bite sooner, shorten the TTL of both maps together
  (`ORDER_PHOTO_URL_TTL_SECONDS` and the web loader's
  `THUMB_SIGNED_URL_TTL_SEC`).

### INV-E5 — a cookie-authenticated write that a browser did not send from this origin is refused

- **Invariant**: every route handler under `apps/web/src/app` that exports
  `POST`, `PUT`, `PATCH` or `DELETE` either builds its context through
  `withApiContext`, whose cookie path answers null (the route's own signed-out
  answer) for a write that carries no Bearer token unless the browser places
  it on a page of this origin: `Sec-Fetch-Site`, when present, is
  `same-origin`; `Origin`, when present, names a host the request was
  addressed to; and at least one of the two is present (a write with neither
  is refused, fail closed). Or it is on the reviewed exemption list in
  [`cookie-write-routes.guard.test.ts`](../../apps/web/src/test/cookie-write-routes.guard.test.ts),
  with how it authenticates and why it needs no cookie rule, and it imports no
  cookie-session reader. Every call of `withApiContext` or of the returns
  routes' two shared gates hands it the request it was given, or one rebuilt
  with the same URL, method and headers (changed only by `X-Organization-Id`).
- **Why it matters**: a browser attaches the session cookie to a request
  whatever page made it. The cookies are `SameSite=Lax`, which stops a page on
  another site from posting with them but not a page on a sibling subdomain
  (the same site), and Next.js checks `Origin` before a server action, never
  before a route handler. Found 2026-10-24 by the automated push review of the
  cycle-count clear route and confirmed as a class: 96 of the 150 route files
  that use `withApiContext` handled a write with the cookie session and no
  check. Only the order sign route and `/api/v1/me/release-state` refused a
  cross-site post, each with its own copy of the rule, and both skipped any
  `Authorization` header although `withApiContext` reads the cookie for anything
  but `Bearer <token>`. The same inventory found `/auth/confirm` verifying an
  emailed token posted from any site and setting the session from it, so a page
  holding a link for its own account could sign a visitor's browser into that
  account (login CSRF).
- **Enforced by**: `refusesCrossSiteCookieWrite` in
  [`cross-site-request.ts`](../../apps/web/src/lib/auth/cross-site-request.ts),
  called at the top of `withApiContext`'s cookie path, before `getUser`, and by
  the sign and release-state routes before they build a context (each keeps
  its own answer: the one 404, and 403). Never judged: a Bearer caller (the
  phone, which sends one on every signed-in call), `GET`, `HEAD` and
  `OPTIONS`. A write with neither header is refused because every browser the
  app supports (Chrome, Edge and Firefox 111+, Safari 16.4+) sends `Origin` on
  any request whose method is not `GET` or `HEAD` (the Fetch standard, "append
  a request Origin header"), so only a client, proxy or extension that strips
  both sends one; a test or script that drives a cookie write sends an
  `Origin`, as the app's own pages do. The `Origin` host is compared with the
  request URL's host, the `Host` header and the first `X-Forwarded-Host`: on
  Vercel all three name the public host, and under `next dev` the URL says
  `localhost` whatever the browser typed. `/auth/confirm` calls
  `fetchSiteIsElsewhere` before `verifyOtp`: its page is `no-referrer`, so its
  own form posts `Origin: null` and only `Sec-Fetch-Site` can be read. A post
  there with no `Sec-Fetch-Site` is verified and logged (type only), by
  decision: without that header no header tells its own post from another
  site's, so refusing would refuse every browser without Fetch Metadata on a
  page that loads no script and opens on whatever device holds the email.
  Its page names the account the browser is already signed in as, and where a
  link lands is fixed by its type
  ([`confirm-landing.ts`](../../apps/web/src/lib/auth/confirm-landing.ts)),
  not chosen by the link. The two `GET`s that spend something of the person's
  ask `sentFromAnotherOrigin` (`Sec-Fetch-Site` present and neither
  `same-origin` nor `none`): `/auth/session-ended` then clears only a session
  GoTrue no longer has and otherwise sends the browser to the dashboard, and
  `exportRateLimited` answers 403 before the export budget is touched.
- **Tested at**:
  [`cross-site-request.test.ts`](../../apps/web/src/lib/auth/cross-site-request.test.ts)
  (the rule: every method, both headers, neither header, `null` and malformed
  origins, Bearer and other `Authorization` schemes, local and proxied hosts);
  [`api-context.cross-site.test.ts`](../../apps/web/src/lib/auth/api-context.cross-site.test.ts)
  (the real `withApiContext` refuses before the session is read, a header-less
  cookie write included, and a same-origin write, a Bearer write and a `GET`
  still resolve);
  [`cookie-write-routes.guard.test.ts`](../../apps/web/src/test/cookie-write-routes.guard.test.ts)
  (the allowlist sweep over the route files' syntax trees, with a self-test;
  on 2026-10-24 it read 224 route files: 128 write handlers, 114 through a
  gate, 13 exempt and one re-export, and 193 gate calls); the record route's
  and release-state's `route.cross-site.test.ts` (end to end through Next's
  App Route module);
  [`auth/confirm/route.test.ts`](../../apps/web/src/app/auth/confirm/route.test.ts)
  (login CSRF: a post from another site, the signed-in notice, the fixed
  landing) and
  [`confirm-landing.test.ts`](../../apps/web/src/lib/auth/confirm-landing.test.ts)
  (each type's landings, and sweeps over the five link builders and the
  repository's sign-in harnesses);
  [`auth/session-ended/route.test.ts`](../../apps/web/src/app/auth/session-ended/route.test.ts)
  (another origin's link, image or frame leaves a live session alone and still
  clears a gone one); and
  [`export-rate-limit.test.ts`](../../apps/web/src/lib/export-rate-limit.test.ts)
  with
  [`export-routes.limit-order.test.ts`](../../apps/web/src/app/api/export-routes.limit-order.test.ts)
  (an export another origin's page asked for is refused before the budget,
  the audit row and the alert, and every export route hands the limiter its
  own request).
- **Not covered by this rule: a `GET`.** A top-level navigation from any site
  carries the `SameSite=Lax` cookie, and so does an image, script or frame a
  sibling subdomain loads (the same site), so a `GET` that changes state needs
  its own defence. The `GET` handlers that do, as read on 2026-10-25 (115 of
  the 224 route files export one), and each one's defence:
  - the cron jobs, behind `CRON_SECRET` (INV-E3);
  - the two accounting OAuth callbacks, which match their `state` against the
    pending connection row under RLS;
  - `/auth/callback`, which creates a session from a PKCE code: the code
    verifier is a cookie of the browser that started the flow, so a code from
    another browser fails;
  - `/auth/session-ended`, which ends this browser's session: for a request
    another origin's page made it clears only a session GoTrue no longer has
    (what the dashboard's own redirect sends there for), and a live one goes to
    the dashboard. The app's own link, an address typed or bookmarked (`none`)
    and a browser without Fetch Metadata sign out as before. Corrected
    2026-10-25: the first version of this entry missed it, and any page could
    sign the person out;
  - the 19 export routes (18 `GET`s and the `POST` builder): each export spends
    the person's one budget (40 an hour, fail closed), past it writes a
    `security.export_rate_limited` audit row and sends the organization's
    alert with their email, and five write an export audit row. Another page
    could lock the person out of exports for an hour and make them look like
    they were pulling data; a navigation that becomes a download leaves that
    page in place, so it can repeat. `exportRateLimited` now refuses an export
    another origin's page asked for, before all of that (also missed by the
    first version of this entry);
  - the per-minute read limits of 15 cookie `GET` routes (search, the
    dashboard value series, the ISBN and UPC lookups, bundles, product groups
    with their variants and linking suggestions, the order catalog,
    storefront, photos and submissions, staging, item history, the phone
    snapshot): each request adds one to a counter keyed by the person. A page
    on a sibling subdomain could hold one at its limit while it is open. It
    reads nothing (CORS), nothing is audited or sent, and the counters reset
    every minute, so this is accepted for now; the follow-up is a resource
    isolation rule in `withApiContext` (refuse a cookie `GET` that another
    origin's page made as anything but a top-level navigation).
  Whether a `GET` writes depends on the services it calls, so this list is a
  reading, not a sweep (section 8). Server actions are covered by Next's own
  `Origin` check, not by this rule.
- **Also not covered: login CSRF on `/auth/confirm`, which is narrowed, not
  closed.**
  - Navigate and press. Another site can send a browser to `/auth/confirm` with
    a link it holds for its own account (a reset link for its own address is
    one form away) and with the type it likes. The page must render for that
    navigation, because a click in webmail is a cross-site navigation too, and
    its form then posts from the app's own page, so `Sec-Fetch-Site` says
    `same-origin` and the press is verified. The page now names the account
    the browser is already signed in as, another site can no longer sign the
    browser out first, and the link lands where its type says, not on a page
    the other site chose. A browser that is signed out, whose person presses on
    for a link they did not ask for, is still signed in to the account the link
    belongs to. Closing that needs the link builders to add a recipient hint,
    signed so the page can show it ("this link signs in as j***@..."); that is
    an owner question. The first version of this entry presented the login
    CSRF as closed for every browser that sends Fetch Metadata; it was not.
  - A post from a browser that sends no `Sec-Fetch-Site` (one without Fetch
    Metadata, or one whose header an extension strips), which needs an unspent
    link for an account the attacker holds; the log line shows whether such
    posts happen.
  - A page on a sibling subdomain can also set cookies for the parent domain,
    which the browser then sends to the app beside its own. Supabase's session
    cookies do not use `__Host-` names (which a subdomain cannot set), so such
    a page may override or spoil the session cookie (a sign-out, or its own
    session) whatever the routes above check. Moving the session cookies to
    `__Host-` names is the follow-up.

---

## 6. The recurring bug patterns, as invariants

Four patterns in this codebase's ledger have each shipped at least once. They are
restated here as invariants because "remember pattern #24" is not an enforcement
mechanism.

### INV-F1 (pattern #24) — a policy change restates the whole predicate

- **Invariant**: a change to an existing policy is expressed as `drop policy`
  followed by `create policy` with **every** conjunct restated, never as
  `alter policy ... with check`.
- **Why it matters**: `alter policy ... with check` **replaces** the whole clause
  rather than amending it. The failure mode is a predicate that silently lost a
  conjunct: still valid SQL, still gated, just less gated than the author
  believed. There is no error and no log line.
- **Enforced by**: the migration convention, applied visibly — 0317, 0321 and
  0322 each carry a header explaining the drop-and-recreate and why.
- **Tested at**: **no honest generic assertion exists**, and none is faked here.
  Detecting a lost conjunct requires knowing which conjuncts were meant to be
  present, which is per-policy knowledge. It is covered two ways instead: the
  migration test for a changed policy pins its predicate — `0322` asserts
  `item_stock_levels_select`'s `qual` **text verbatim** for exactly this reason —
  and INV-11 plus INV-F2 catch the two shapes a lost conjunct most often degrades
  into (a literal true, and a self-comparison).

### INV-F2 (pattern #25) — no policy predicate contains a self-comparison

- **Invariant**: no parsed policy predicate in `public` contains
  `alias.column = alias.column` or `column = column`.
- **Why it matters**: an **unqualified** column inside a policy's `EXISTS`
  subquery binds to the **inner** relation, turning the intended cross-check into
  `organization_id = organization_id` — true for every row, gating nothing. This
  shipped once as a real **cross-tenant write hole**. It is close to invisible in
  review because the source text reads like a comparison; only the _parsed_
  predicate shows the self-comparison, which makes it detectable in the catalog
  and essentially undetectable by grepping migrations.
- **Enforced by**: qualifying every outer-table column in every policy subquery,
  stated in each affected migration's header.
- **Tested at**: INV-12, in **both** rendered forms — qualified (the `EXISTS`
  case) and unqualified (the direct case). Only the qualified leg existed at
  first; the unqualified leg was added after a mutation check showed a hand-made
  unqualified tautology sailing through. INV-13 and INV-14 are the controls that
  both legs match the bug and neither matches a legitimate comparison. Current
  state: zero hits.

### INV-F3 (pattern #23) — a filter that must include NULL rows does not use `.in()`

- **Invariant**: no PostgREST query relies on `.in()` or `.not.in()` to include
  rows whose filtered column may be NULL.
- **Why it matters**: PostgREST `.in()` / `not.in` **silently drops NULL rows**.
  The consequences here have been operational, not merely cosmetic: a
  `kind <> 'staging'` filter that dropped NULL-kind rows made stock held in site
  locations unpickable (migration 0292), and a `.in()` kind filter dropped
  NULL-kind site holdings in the set-rack path. In this schema NULL is
  **meaningful** — `locations.kind IS NULL` combined with a site-ish type _is_
  the encoding for a Site, and must never be backfilled.
- **Enforced by**: `is distinct from` in SQL, or filtering in JavaScript where
  the predicate cannot be expressed without dropping NULLs.
- **Tested at**: **not machine-checkable from the database** — this is a
  client-library behaviour in TypeScript, invisible to the catalog. Covered by
  the behavioural tests for the affected paths and by review. A lint rule banning
  `.in(` on nullable columns is not viable without type-aware analysis of the
  column's nullability; recorded as an unsolved enforcement problem rather than
  claimed as covered.

### INV-F4 (pattern #2) — a guarded write verifies it wrote

- **Invariant**: a conditional write expressed as `.update(...).eq(...)`
  terminates in `.select().maybeSingle()` (or equivalent) and the caller treats
  "no row returned" as a failure.
- **Why it matters**: `.update().eq()` **fails open**. If the `eq` matches
  nothing — because the row was already changed, or because the guard condition
  is what should have blocked the operation — PostgREST returns success with zero
  rows affected. A guard implemented this way reports that it enforced something
  it did not.
- **Enforced by**: the `.select().maybeSingle()` idiom, and services that raise
  on an empty result.
- **Tested at**: **not machine-checkable generically** (same reason as INV-F3).
  Covered by the guarded-write tests on the specific paths that use the pattern.
  Treat any new `.update().eq()` without a result check as a review blocker.

---

## 7. Accepted risks

Two fixes were **deliberately refused** during this program, with evidence.
Recording them as accepted, tracked risk — rather than leaving them off the list
as though they were done — is the point of this section. Both are pinned in
pgTAP, so a future change that quietly "fixes" one fails a test that explains why
it must not.

### AR-1 — `item_stock_levels.quantity` stays unconstrained — **RESOLVED (0327)**

- **The tempting fix**: add `check (quantity >= 0)`.
- **Why it was refused at the time**: it would convert an existing bug into a
  **mid-transaction failure**. `adjust_stock`'s explicit-location branch committed
  negatives, and `transfer_stock` wrote a negative before its guard ran.
  A `CHECK` would abort those transactions at the write instead of at the guard,
  turning a data-quality problem into a functional outage on stock adjustment and
  transfer — and the error the application maps would change from
  `insufficient_stock` (P0001) to a check violation.
- **The prerequisite, and how it was met**: migration `0327` made
  `adjust_stock`'s explicit-location draw conditional and moved
  `transfer_stock`'s sufficiency test into the draw itself (both still raise
  the same P0001 `insufficient_stock`), then added
  `item_stock_levels_quantity_nonneg` — `NOT VALID` plus an immediate
  `VALIDATE` (production checked 2026-08-11: zero negative rows) — in the
  **same change** that inverted the pins.
- **Pinned at (inverted)**: the `0322` and `0324` test files now assert
  **exactly one validated** `CHECK` constraint on that column, by name;
  [`0327_stock_rpc_integrity.test.sql`](../../supabase/tests/0327_stock_rpc_integrity.test.sql)
  asserts the behavioural halves — an over-transfer still raises
  `insufficient_stock` (P0001), **not** a 23514 from the constraint firing
  first, and an explicit-location over-draw no longer commits a negative row.

### AR-2 — `item_stock_levels_select` stays org-scoped, not warehouse-scoped — **RESOLVED (0331, completed for staff by 0371)**

- **The tempting fix**: narrow the policy to the caller's assigned warehouses,
  matching the warehouse scoping applied elsewhere in wave C.
- **Why it was refused at the time**: `post_cycle_count` derived its delta from
  a **sum over `item_stock_levels` evaluated under the caller's RLS**. Narrowing
  the policy makes that sum come up **short** for a caller with partial warehouse
  access, and the function then writes a **wrong number with no error**. That is
  silent stock corruption — strictly worse than the over-broad read it would be
  fixing, and undetectable without reconciling against physical count.
- **The prerequisite, and how it was met**: make every RPC read of the table
  independent of the caller's row visibility, then narrow the policy in the
  same change that inverts the pin. Met in three steps: `0327` routed
  `post_cycle_count`'s Σ through the `SECURITY DEFINER` helper
  `_cycle_count_org_stock_sum`; `0331` made `apply_level_delta` (its draw-down
  loops SELECT the holdings they consume) `SECURITY DEFINER` with an internal
  gate (staff+ member of the org owning the target item, derived from the item
  row; null-subject connections are the service path — anon EXECUTE is
  revoked), then recreated `item_stock_levels_select` in `0322`'s prescribed
  `purchase_orders_select` shape via the holding's location (`is_org_member`
  AND (manager+ OR the location's warehouse ∈ `my_warehouse_ids()` OR the
  location has no warehouse)); `0371` moved the last two caller-scoped
  statements — `adjust_stock`'s explicit-location upsert and conditional draw,
  and `transfer_stock`'s draw and destination upsert — into the
  `SECURITY DEFINER` `ledger.apply_holding_delta`, gated in its body
  (`ledger.active()`, staff+ of the item's org, location in that org, manager+
  or `caller_can_write_location`). The two ledger bodies stay
  `SECURITY INVOKER`: their `SELECT inventory_items ... FOR UPDATE` under the
  caller's RLS is the per-item authorization.
- **What it changes, honestly**: until 0371, `item_stock_levels_write` (0202)
  was `FOR ALL` with a **staff** `USING` floor, and permissive policies OR, so
  staff+ kept org-wide SELECT visibility through the write policy and 0331's
  narrowing bit only viewers. 0371 split that policy into
  `item_stock_levels_insert` and `item_stock_levels_update` (0202's predicates
  verbatim) which grant no SELECT, so **every role below manager, staff
  included, now sees only holdings in its assigned warehouses plus holdings at
  locations with no warehouse**. An unassigned staff member sees only the
  latter. Two gated `SECURITY DEFINER` read helpers keep screens honest:
  `item_holdings_elsewhere` gives a scoped member, per item they can read, the
  Staging / Unplaced / placed totals outside their scope, the ids of the placed
  locations holding them and how many of those are fine-grained placements
  (managers get nothing). There is no per-location quantity column, but a
  total that covers ONE location is that location's quantity (one hidden
  placed location; or the Staging or Unplaced of a single other warehouse).
  This is new information for viewers as well as staff. `location_stock_census` gives a manager or
  a `locations:manage` holder the org-wide count and total at one location for
  the archive guard. Holdings are still **charter-blind by design**:
  `my_warehouse_ids()` ignores charter scoping, so a charter-scoped member sees
  all holdings quantities at their warehouse even where item rows are
  charter-narrowed — 0322's prescription; anonymous quantities only. **Still
  open (owner decision, a follow-up)**: a null-location draw (the phone's quick
  −1, a manual removal in 'any' mode, `complete_picking`) goes through the
  frozen `apply_level_delta`, which draws the item's stock from any warehouse;
  the movement row records no from-location. **Also open (label-only parity,
  deferred by design)**: the phone's Books list, the web scanner lookup's rack
  holdings (item history dialog) and the count-sheet labels still build their
  placement LABEL from the holdings a staff member can see, with no "+N in
  other warehouses" and no "could not load" note. They never drive a write,
  but a book split between a Main crate and an Annex crate reads as Main-only
  there, while the web Books list says "+N in other warehouses". The phone
  Books list can reuse `readHoldingsElsewhere` (in parallel with
  `readPlacementHoldings`) when this is picked up.
- **Rollout (0371)**: the file sets `lock_timeout = '5s'` around its policy
  changes (ACCESS EXCLUSIVE on `item_stock_levels`); a push that meets a
  long-running reader fails with 55P03 and is retried, instead of queueing
  every stock read and write behind it (`holdings-migrations.guard.test.ts`
  pins this for every migration from 0370 that locks the table).
- **The web app's side (0371)**: `InventoryService.hiddenHoldingsFor` is the
  one caller of `item_holdings_elsewhere` (batches of at most 500 ids, in the
  POST body, started alongside the caller's own holdings read; skipped by
  ROLE for managers and above). It never throws: a failed read is
  `{ ok: false }`, never "nothing elsewhere". Guards FAIL CLOSED on it (the
  single and bulk item archive guards, the book crate prediction and
  reconciliation, bulk Set rack); displays say "Could not load stock in other
  warehouses" instead of printing a sum that may be missing a part (item page,
  Items and Books lists, transfer dialog). The location archive guard decides
  from `location_stock_census` and uses its own read only to name items. The
  transfer dialog offers scoped members only destinations they can write
  (owner decision Q4; `transfer_stock` still enforces it). `list()` asks only
  when the caller opts in (`withElsewhere`: the Items, Books and Rentals item
  lists), so search-as-you-type, pickers, exports and AI tools make no extra
  request; the pages that render the item tables are pinned to opt in. The
  bulk Set rack split rule and the list's split count add only hidden
  fine-grained placements (`placed_rack_locations`, classified with the same
  lists as `isRackShelfLocation`), so a Site in another warehouse no longer
  makes a single rack holding look split. The location archive refusal says
  "units in a warehouse you don't manage" when the caller cannot see the
  location's holdings at all, and "units of items you can't see" only for
  visible holdings of unreadable items. Every
  `item_stock_levels` reader under `apps/web/src/server` and `apps/web/src/app`
  is classified in `holdings-readers.guard.test.ts` (folds the hidden totals,
  complete by scope, label only, or service client), so a new reader that adds
  holdings up or decides from them cannot land without folding them in.
- **The phone's side (0371)**: `apps/mobile/src/lib/holdings-elsewhere.ts` is
  the phone's one caller of `item_holdings_elsewhere`, through the member's
  own client, with the same rules (skipped by ROLE for managers and above,
  where the role comes from `useRole`, whose shared cache is re-read once it
  is 30 s old and cleared on sign-out, so a demoted manager's phone does not
  keep skipping (`role-cache.ts`);
  batches of at most 500 ids in the POST body, started alongside the screen's
  own reads; never throws; a failure is `'unavailable'`, never "nothing
  elsewhere", and is not cached). The item screen and the scan sheet add an
  ELSEWHERE row ("+N in other warehouses") or the "Could not load stock in
  other warehouses" note, and never let holdings they know are incomplete
  refute the item's rack label. Move stock and Remove from rack name stock in
  other warehouses in their empty and partial states, say "Could not load this
  item's stock" when their own holdings read fails, and Move stock offers a
  scoped member only destinations in their assigned warehouses plus locations
  with no warehouse (Q4; read from `user_warehouse_assignments`, the rows the
  server's write check reads; a failed read narrows and says so). The phone
  writes still go through `/api/v1/items/[id]/transfer` and `remove-stock`,
  which enforce all of it. `holdings-elsewhere-wiring.test.ts` pins that no
  other phone file names the RPC.
- **Verification summaries (0374, F1-3)**: `item_verification_summaries(org,
  item ids)` is `SECURITY DEFINER` because it reads counts
  (`_latest_count_lines`, service_role only) and `stock_movements` past RLS; a
  member who can read an item but not its movements (no `activity_logs:read`
  and the item's warehouse outside `my_warehouse_ids()`) would otherwise get a
  silently low "movements since". It gates in its body (signed in,
  `is_org_member(org)`, `caller_can_read_item` per item, the item in the org),
  returns counts and the count's own facts only, never a movement row, and
  takes at most 500 ids. `location_holdings_visible(location)` is
  `item_stock_levels_select`'s location clause for one location
  (`SECURITY INVOKER`), held equal to the policy for every persona of its
  pgTAP file, so the location page says "not in your warehouses" instead of
  showing an empty location. Its open exceptions are read under the same
  location clause (`exception_occurrences` RLS, 0370), so there too it says
  they are not listed, and "none you can see" when items there are hidden
  from the reader, never "none recorded" (core `locationOpenIssuesEmptyCopy`).
  The web reader
  (`VerificationService.location`) is classified in
  `holdings-readers.guard.test.ts`. Pinned at
  [`0374_verification_summaries.test.sql`](../../supabase/tests/0374_verification_summaries.test.sql).
- **Pinned at (inverted)**: `0322`'s test asserts the **warehouse-scoped**
  `qual` verbatim;
  [`0331_ar2_warehouse_scope.test.sql`](../../supabase/tests/0331_ar2_warehouse_scope.test.sql)
  carries viewer and (since 0371, test 9 inverted) staff narrowing, RPC parity
  for a warehouse-scoped caller — now a behavioural kill for an invoker revert
  of `apply_level_delta`, because the staff caller really is narrowed — and the
  definer/grant structure of `apply_level_delta`. `0318`'s test inverted its
  `prosecdef = false` pin.
  [`0371_holdings_staff_scope.test.sql`](../../supabase/tests/0371_holdings_staff_scope.test.sql)
  pins the exact policy set, narrowing for six personas, both read helpers
  (including the complement property: visible + hidden = total), every staff
  RPC path with its error codes, the helper's gate line by line, and the
  divergence kill (a SELECT policy that hides every holding from staff, under
  which staff adjust and transfer still succeed). INV-33 and INV-35 turn the
  rule into catalog properties.

### Honest note on where these pins live

Both accepted risks are now **resolved and inverted**. AR-1's pins live in the
`0322`/`0324` tests (exactly one validated `CHECK`, by name) and `0327`'s test
(behavioral). AR-2's surviving pins live in `0322`'s test (the warehouse-scoped
`qual`, verbatim), `0331`'s test (behavioral parity + structure) and `0371`'s
test (the staff half, the helpers and the divergence kill). None are
duplicated in `security_invariants.test.sql` — duplicating would invite drift;
INV-33 and INV-35 there state the general rule, not these pins.
The cost of not duplicating should be named: **deleting a migration test file
removes its pins, and nothing in the invariant sweep would notice.** There is no
way to assert "a test file still exists" from inside pgTAP. Treat `0322`'s,
`0327`'s, `0331`'s and `0371`'s test files as load-bearing.

---

## 8. What is deliberately not covered by an executable test

Listing these is part of the deliverable. An invariants document that implies
everything is machine-checked is itself a form of overclaiming.

| Invariant                                       | Why no generic assertion                                                                                                    | What covers it instead                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| INV-D1 (every call site validates its path)     | "No future caller forgets" is not expressible in the catalog; a source-grep rule would be brittle enough to be net-negative | Per-service tests, plus INV-D2 as a writer-independent floor                                |
| INV-E2 (admin client used only where justified) | The distinction between a justified and a lazy bypass is semantic                                                           | Review, plus scoped tests on the AI and public-catalog read paths                           |
| INV-F1 (pattern #24)                            | Detecting a lost conjunct needs per-policy knowledge of the intended conjuncts                                              | Verbatim predicate pins in migration tests; INV-11 and INV-12 catch the common degradations |
| INV-F3 (pattern #23)                            | Client-library behaviour in TypeScript, invisible to Postgres; a lint rule needs column-nullability type analysis           | Behavioural tests on affected paths, review                                                 |
| INV-F4 (pattern #2)                             | Same                                                                                                                        | Guarded-write tests, review                                                                 |
| Cron-route secret gating (INV-E3)               | No sweep exists yet; one is feasible and is listed as a follow-up                                                           | Per-route gate tests                                                                        |
| A `GET` that changes state (INV-E5)             | Whether a `GET` writes depends on the services it calls, which a sweep over route files cannot read                         | The 2026-10-25 inventory in INV-E5, the export routes' sweep, review                        |

Also worth stating: `authenticated` holds table-level `INSERT`/`UPDATE`/`DELETE`
on essentially every table in `public`, because that is the Supabase default
grant. No invariant here asserts otherwise, and narrowing those grants is **not**
proposed as a quick win — RLS is the designed control, and revoking table
privileges would break PostgREST paths across the product. It is recorded so a
future reader does not mistake the absence of an assertion for an oversight.

---

## 9. Changing an invariant

The assertions are the specification. Making a red assertion green by editing the
assertion is the failure mode this document exists to prevent.

1. **A failing security assertion is a security regression until proven
   otherwise.** Establish which is wrong — the code or the invariant — before
   touching either.
2. **To add an allowlist entry**: put the reason in the `why` column, in the same
   commit as the change that needs it, and expect the reason to be challenged in
   review. An entry with no reason is a finding.
3. **To retire an invariant**: delete it here and in the test, in one commit,
   with the argument in the commit message. Do not leave a weakened assertion
   behind as a marker — a weakened assertion reads as coverage.
4. **After changing any assertion, run the mutation check.** Introduce the
   violation it is supposed to catch, confirm it goes red, revert. The recipes
   are in the invariant test's header. An assertion that has never been observed
   to fail has not been tested.

---

## 10. Confidence posture

Stated in measurable terms, because the alternative is a claim that cannot be
checked.

- **No known critical or high-severity vulnerability remains open** from waves
  A-E. The P0 (anon `EXECUTE` on ungated `SECURITY DEFINER` functions) is closed
  by migration 0318 for all 15 exploitable functions, and the class — not just
  those 15 — is now covered by an allowlist-based sweep.
- **The same class recurred once on the `authenticated` role** and is closed:
  SP-001, SP-059 and the `_cycle_count_location_facts` leak (section 2, INV-B3)
  — four definer functions any signed-in user could execute with no
  authorization in their bodies — closed by migrations 0346 and 0350 and swept
  from then on by INV-25/26. It is recorded on its own line rather than folded
  into the one above because it is the counterexample to reading that line as
  permanent: the sweep that would have caught it did not exist on the day the
  first P0 was declared closed.
- **A high-assurance baseline is implemented and covered by executable
  invariants**: 36 class-wide assertions in
  `supabase/tests/security_invariants.test.sql`, plus 38 security-focused pgTAP
  files and 56 security-focused vitest files, gated together as
  `pnpm security:test` and wired into CI.
- **Two risks are accepted and tracked**, not closed (section 7), each with a
  stated prerequisite and a pgTAP pin.
- **One known gap is recorded**: five storage-path columns lack the database
  traversal floor (INV-D2). They are in the test's allowlist, so they are visible
  in every CI run rather than forgotten.
- **One more known gap is recorded (0371)**: `purchase_orders_write` is a
  `FOR ALL` policy on a warehouse-scoped table, so a member holding
  `purchase_orders:manage` reads every warehouse's POs (INV-C4). It is on
  allowlist G as deferred to 0372, so it too is visible in every run.
- **The tests have been mutation-checked**: a deliberate violation of six
  distinct invariants turned 10 of the 23 assertions that existed at the time
  red, and the database was restored afterwards. The recipes for repeating that
  are in the test header. INV-25 and INV-26, added later, do not rely on that
  one-off exercise: INV-29 and INV-30 plant the violating probes themselves, so
  those two assertions are mutation-checked on every run. INV-31, INV-33 and
  INV-35 (0371) follow the same pattern through INV-32, INV-34 and INV-36.
- **What this does not establish**: no third-party penetration test has been
  performed, there is no SOC 2 or ISO 27001 process, and there is no bug bounty
  (`SECURITY.md`, "Things we haven't done"). Coverage of the invariants above is
  evidence about the properties they state, and nothing more.
