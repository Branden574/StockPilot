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
     the same file. Nothing else in this document was re-verified. -->

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
  stale entry, and no entry whose body has grown an `INSERT`/`UPDATE`/`DELETE`),
  with INV-29 and INV-30 as the controls. Those two plant their own probes
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

### AR-2 — `item_stock_levels_select` stays org-scoped, not warehouse-scoped — **RESOLVED (0331)**

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
  same change that inverts the pin. Met in two halves: `0327` routed
  `post_cycle_count`'s Σ through the `SECURITY DEFINER` helper
  `_cycle_count_org_stock_sum`; `0331` made `apply_level_delta` (the last
  caller-scoped reader — its draw-down loops SELECT the holdings they consume)
  `SECURITY DEFINER` with an internal gate (staff+ member of the org owning
  the target item, derived from the item row; null-subject connections are the
  service path — anon EXECUTE is revoked), then recreated
  `item_stock_levels_select` in `0322`'s prescribed `purchase_orders_select`
  shape via the holding's location (`is_org_member` AND (manager+ OR the
  location's warehouse ∈ `my_warehouse_ids()` OR the location has no
  warehouse)). `adjust_stock`/`transfer_stock` never SELECT the table — their
  conditional draws run under the untouched FOR ALL write policy.
- **What it changes, honestly**: because `item_stock_levels_write` (0202) is
  `FOR ALL` with a **staff** `USING` floor and permissive policies OR, staff+
  keep org-wide SELECT visibility through the write policy; the narrowing
  bites **read-only members** (viewers — the actual warehouse-scoped
  population in production). Holdings are **charter-blind by design**:
  `my_warehouse_ids()` ignores charter scoping, so a charter-scoped viewer
  sees all holdings quantities at their warehouse even where item rows are
  charter-narrowed — 0322's prescription; anonymous quantities only.
- **Pinned at (inverted)**: `0322`'s test now asserts the **warehouse-scoped**
  `qual` verbatim;
  [`0331_ar2_warehouse_scope.test.sql`](../../supabase/tests/0331_ar2_warehouse_scope.test.sql)
  carries the behavioral halves — viewer narrowing (assigned + null-warehouse
  rows only), RPC parity for a warehouse-scoped caller (a draw spanning a
  hidden warehouse still succeeds with identical quantities; a transfer out of
  a hidden location still works), and the definer/grant structure of
  `apply_level_delta`. `0318`'s test inverted its `prosecdef = false` pin.

### Honest note on where these pins live

Both accepted risks are now **resolved and inverted**. AR-1's pins live in the
`0322`/`0324` tests (exactly one validated `CHECK`, by name) and `0327`'s test
(behavioral). AR-2's surviving pins live in `0322`'s test (the warehouse-scoped
`qual`, verbatim) and `0331`'s test (behavioral parity + structure). None are
duplicated in `security_invariants.test.sql` — duplicating would invite drift.
The cost of not duplicating should be named: **deleting a migration test file
removes its pins, and nothing in the invariant sweep would notice.** There is no
way to assert "a test file still exists" from inside pgTAP. Treat `0322`'s,
`0327`'s and `0331`'s test files as load-bearing.

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
  invariants**: 30 class-wide assertions in
  `supabase/tests/security_invariants.test.sql`, plus 38 security-focused pgTAP
  files and 56 security-focused vitest files, gated together as
  `pnpm security:test` and wired into CI.
- **Two risks are accepted and tracked**, not closed (section 7), each with a
  stated prerequisite and a pgTAP pin.
- **One known gap is recorded**: five storage-path columns lack the database
  traversal floor (INV-D2). They are in the test's allowlist, so they are visible
  in every CI run rather than forgotten.
- **The tests have been mutation-checked**: a deliberate violation of six
  distinct invariants turned 10 of the 23 assertions that existed at the time
  red, and the database was restored afterwards. The recipes for repeating that
  are in the test header. INV-25 and INV-26, added later, do not rely on that
  one-off exercise: INV-29 and INV-30 plant the violating probes themselves, so
  those two assertions are mutation-checked on every run.
- **What this does not establish**: no third-party penetration test has been
  performed, there is no SOC 2 or ISO 27001 process, and there is no bug bounty
  (`SECURITY.md`, "Things we haven't done"). Coverage of the invariants above is
  evidence about the properties they state, and nothing more.
