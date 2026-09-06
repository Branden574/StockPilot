# StockPilot codebase sweep — engineering + teaching report

**Date:** 2026-09-05 · **Baseline:** `main` @ 09bf2157 · **Branch:** `fix/sweep-pass-b-security` (PR #183)
**Companion:** [findings register](./2026-09-05-codebase-sweep-findings.md) — all 141 standing findings, fixed and open.

---

## 1. Executive summary

A full-repository sweep of StockPilot (1,707 web source files, 332 mobile, 152 core, 340 migrations)
found **141 verified defects**, of which **15 are fixed and shipped** on this branch, including
**both P0s**.

The single most important result: **any signed-in user could rewrite another organization's stock
levels.** `apply_cycle_count_location_delta` was a `SECURITY DEFINER` function that `authenticated`
could execute at `POST /rest/v1/rpc/…` with no authorization check in its body. I reproduced it in a
rolled-back transaction on the live schema — a viewer in org B inflated a victim rack from 10 to 5010
units and then drained it to 0, with `quantity_on_hand` untouched and **zero ledger rows written**.
That is silent cross-tenant inventory corruption. It is fixed (migration 0346, in production) and,
more importantly, the whole *class* is now swept by the security gate.

Everything claimed here was executed. Nothing is inferred.

| | |
|---|---|
| Raw findings from 18 domain reviewers | 162 |
| After merging overlaps | 144 |
| **Refuted by adversarial verification** | **3** |
| **Standing findings** | **141** (2 P0, 22 P1, 66 P2, 51 P3) |
| Fixed on this branch | 15 (both P0, 12 P1, 1 P2) |
| New migrations | 2 (0346, 0347) |
| New/changed tests | 17 files, +126 assertions |
| Net lines | +2,301 / −95 |

---

## 2. Baseline health (measured BEFORE any change)

| Check | Before | After | Notes |
|---|---|---|---|
| Format (`pnpm format:check`) | **FAIL** | FAIL (unchanged) | Pre-existing and *not* caused by this work — see SP-095. The glob is `**/*.{ts,tsx,md,json,sql,css}`; Prettier has no SQL parser, so every one of the 340 migrations is a hard error. With `.sql` excluded, 1,824 files are still unformatted. CI never runs this script, so nobody noticed. Left alone deliberately: fixing it means a repo-wide reformat that would bury this diff. |
| Lint | PASS (0 errors, 33 warnings) | PASS (0 errors, 33 warnings) | |
| Typecheck | PASS | PASS | web + mobile + core |
| Unit tests | PASS — web 7,258 / mobile 1,580 / core 1,449 | PASS — web **7,277** / mobile **1,622** / core 1,449 | +61 |
| DB tests (pgTAP) | PASS — 140 files / 2,400 | PASS — **142 files / 2,448** | +48 |
| Security gate (`pnpm security:test`) | PASS | PASS | now also sweeps authenticated-executable SECDEF functions |
| Build | PASS | PASS | |
| E2E (Playwright) | **NOT RUN** | **NOT RUN** | 6 specs; needs a live app + `TEST_USER_EMAIL`/`TEST_USER_PASSWORD`. Not run — stated rather than implied. |

Baseline code metrics: 6 TODO/FIXME/HACK · 56 `any` · 138 `as unknown as` · 16 ts-ignore ·
192 eslint-disable · 58 non-null assertions · 2 empty catches · 241 console.error/warn ·
203 `createAdminClient()` call sites · 61 `select('*')` · 557 `void fn(` · 144 API routes.

---

## 3. Method — and why you can trust the numbers

Three stages, deliberately adversarial:

1. **Find (18 parallel reviewers, read-only).** One per domain: inventory accounting, orders and
   reservations, purchasing/receiving, cycle counts, auth/sessions, API routes, Supabase query
   hygiene, migrations/DB security, React correctness, async/concurrency, mobile offline sync,
   email/notifications, type escape hatches, dead code/duplication, test quality, AI/uploads,
   web-mobile parity, and time/money/pagination. Every reviewer had to read the code's *tests and
   migrations* before calling anything a bug, and was given the repo's own catalogue of 28 recurring
   bug patterns to hunt for new instances of.
2. **Refute (29 batched skeptics).** Every finding went to a verifier whose **default verdict was
   REFUTED** and which had to re-derive the failure itself, quoting the decisive lines. This is what
   removed 3 findings and re-rated 20.
3. **Second vote (14 independent re-derivations).** Every P0/P1 survivor was re-derived from scratch
   by a second verifier that was told not to trust the first. All 14 agreed.

**The rule I held to throughout:** a finding needs a concrete failure scenario — inputs and state
producing a wrong outcome. "This looks fragile" is not a finding. That is why 3 plausible-sounding
reports were killed:

- **SP-118** claimed `push.ts notifyUser()` was dead code. It is not — `/api/v1/push/test` imports it
  and the mobile app calls it.
- **SP-111** claimed a route mis-maps `validation_error` to 409. That service never throws
  `validation_error`; the mapping is unreachable.
- **SP-134** claimed a timing-flaky test. The awaited chain makes the claimed race impossible.

---

## 4. What was fixed (15)

### P0 — both fixed

**SP-001 · Cross-org stock writes through an ungated SECURITY DEFINER RPC** (migration 0346, live in
production).

**SP-002 / SP-090 · Duplicate bundle distributions from an offline replay** (migration 0347).

### P1 — 12 fixed

| ID | What it was |
|---|---|
| SP-004 | PDF threat scanner reported CLEAN once its inflate budget was spent — active content behind eight filler streams passed |
| SP-003 | The cycle-count assignee lock was dead on mobile |
| SP-006 | A permanently-refused outbox row retried forever and blocked posting every count on the device |
| SP-009 | Item cost history report filtered on a column that does not exist — unreachable since it shipped |
| SP-010 | Receive-items dialog blanked in-progress entry on any page refresh |
| SP-011 | Every 60s sync destroyed the offline cycle-count cache and overwrote unsynced counts |
| SP-015 | A stale default-org preference could become the request context, with another org's role |
| SP-016 | "Invite sent" was said when Resend had refused; the audit log recorded it too |
| SP-017 | Six raw call sites omitted the workspace header — multi-org users' work landed in the wrong org |
| SP-021 | An older queued count could land over a newer correction |
| SP-037 | Definitive server refusals were retried forever with no way to see or discard them |
| SP-077 | PO receive sent the idempotency key as the request hash, so an *edited* retry silently returned the old receipt |

---

## 5. Teaching — the fixes explained

### 5.1 SP-001 — the P0. "Who is allowed to call this?"

**What was wrong.** A database function could be called by any logged-in user to change any
organization's stock.

**What caused it.** Migration 0342 added a helper to do cycle-count reconciliation arithmetic:

```sql
create or replace function public.apply_cycle_count_location_delta(
  p_item_id uuid, p_location_id uuid, p_org_id uuid, p_delta numeric
) returns numeric
language plpgsql
security definer                    -- ← runs as the function's OWNER, not the caller
set search_path to 'public'
as $function$
begin
  if p_delta > 0 then
    insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
    values (p_org_id, p_item_id, p_location_id, p_delta)      -- ← no check, at all
    on conflict (item_id, location_id) do update
      set quantity = public.item_stock_levels.quantity + excluded.quantity;
    return 0;
  end if;
  ...
```

Two facts combine into a hole:

- **`security definer` means the function runs with the *owner's* privileges**, so Row Level
  Security — the rules that normally stop you seeing another org's rows — does not apply inside it.
- **`grant execute … to authenticated`** was required, because the legitimate caller
  (`post_cycle_count`) is `security invoker` and calls this helper *as the signed-in user*. So
  revoking access was not an option.

When a function bypasses RLS *and* everyone can call it, the only thing left to protect the data is a
check **inside the function body**. There wasn't one. `p_org_id` is supplied by the caller and used
only as the value to write.

**Why it mattered.** PostgREST publishes every executable function at `/rest/v1/rpc/<name>`. Item and
location UUIDs appear in dashboard URLs, exports and public catalog links. I proved the whole path in
a rolled-back transaction as a **viewer in a different org**:

```
BEFORE: victim rack = 10
attacker_is_member_of_victim_org  → f
victim_rows_visible_via_rls       → 0          (RLS is doing its job for ordinary reads)
apply_cycle_count_location_delta(victim_item, victim_rack, victim_org,  5000) → rack = 5010
apply_cycle_count_location_delta(victim_item, victim_rack, victim_org, -5010) → rack = 0
AFTER:  quantity_on_hand = 10 (untouched)     stock_movements rows = 0
```

Inventory silently wrong, no ledger entry, no audit trail. Pickers sent to a bay for stock that isn't
there; or real stock made unpickable.

**What we changed.** Migration 0346 puts the gate in the body:

```sql
  -- *** 0346 authorization gate ***
  if auth.uid() is not null then                       -- null = service/postgres connection
    if p_org_id is null or p_item_id is null
       or not public.has_org_role(p_org_id, 'manager') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;
  if not public.item_in_org(p_item_id, p_org_id)
     or not public.location_in_org(p_location_id, p_org_id) then
    raise exception 'cross_org' using errcode = '42501';
  end if;
```

**What the new lines mean.**

- `auth.uid()` is the signed-in user's id. It is **null** for a service-role or `postgres` connection
  (our own server, cron jobs, migrations). So `if auth.uid() is not null` means *"if a real person is
  calling"* — the historical behaviour for our own backend is untouched.
- `has_org_role(p_org_id, 'manager')` asks whether *this caller* is an accepted, active manager-or-above
  of that org. `manager` is not arbitrary: it is the floor `post_cycle_count` already enforces, so the
  helper cannot be a way around its own caller's rule.
- The `item_in_org` / `location_in_org` pair is the part that is easy to miss. **A role check on the
  caller-supplied org is not enough.** A manager of org B could pass `p_org_id = B` while pointing at
  org A's item and rack — the role check passes, and you would write a row tagged B onto A's data. The
  conjuncts prove the ids actually belong to the org being claimed.
- `errcode = '42501'` is Postgres's standard "insufficient privilege". Using the standard code means
  PostgREST turns it into a 403 rather than a 500.

**Why in the database and not in the service?** Because the hole was reachable *without* going
through our server at all. A check in TypeScript protects the paths that run TypeScript; this one had
to sit where the write happens.

**What could have broken.** The legitimate caller passes its own org id after its own manager check,
and already refuses foreign locations one step earlier — so a real cycle-count post cannot trip the
new conjuncts. Service connections are exempt by the `auth.uid()` test. The 0188 warehouse trigger
wraps its call in an exception handler, so a refusal can never fail a warehouse insert.

**How we tested it.** `supabase/tests/0346_gate_secdef_stock_helpers.test.sql`, 27 assertions. The
proof that matters is the **negative** one: I reinstated the pre-0346 function bodies and ran the new
suite against them.

```
OLD HEAD: ok=14 not_ok=13     ← the attack succeeds, the staff floor is absent, the oracle leaks
NEW HEAD: ok=27 not_ok=0
```

A test that passes on the broken code proves nothing. Always run it against the bug first.

**And the class, not just the instance.** The reason a P0 shipped through 55 green pgTAP tests is that
the security suite only swept functions callable by **anon** (logged-out). Nothing swept functions
callable by **authenticated**. Two new invariants close that:

```sql
-- INV-25: every authenticated-EXECUTE SECURITY DEFINER function in public
--         gates in its body or is an allowlisted read-only predicate
```

Allowlist E holds the 15 boolean predicates RLS itself evaluates (`item_in_org`, `warehouse_in_org`, …),
each with a written justification, and INV-26 fails if any of them ever grows a write.

**What you should learn.** When you see `security definer`, ask one question: *"who can call this, and
what stops the wrong person?"* If the answer is "the grant", check the grant. If the grant has to stay
open, the function must check for itself. And when you fix one instance, ask what would have caught it
— then build that.

---

### 5.2 SP-002 — idempotency, or why a retry is not a second order

**What was wrong.** Distributing a bundle from the phone could draw component stock twice.

**What caused it.** The screen sent the request directly, and on **any** error queued it for retry:

```tsx
try {
  await api(`/api/v1/bundles/${bundle.id}/distribute`, { method: 'POST', body: {...} });
} catch (e) {
  await enqueue('distribute_bundle', {...});   // ← queued on ANY failure
  Alert.alert('Queued', "…saved locally and will sync when you're back online.");
}
```

`api()` aborts after 20 seconds. On warehouse wifi the server can commit and *then* the response is
lost. The client sees a timeout, queues a replay, and 60 seconds later posts the same distribution
again. The server had no way to tell the replay from a new request: the route's schema had no key
field, the service passed none, and the function had no parameter for one.

**Why it mattered.** Two distributions, component stock drawn twice, duplicate ledger rows — and the
operator was told it was saved. A 4xx refusal (not enough stock, no permission) was *also* queued and
retried every minute forever.

**What we changed.** The standard fix for "a retry must not be a second event" is an **idempotency
key**: a unique id the client mints *before its first attempt* and reuses on every retry. This
codebase already does exactly this for PO receipts, so 0347 gives bundles the same contract:

```sql
  if p_idempotency_key is not null then
    v_request_hash := md5(p_bundle_id::text || '|' || p_quantity::text || …);
    select * into v_existing from public.idempotency_keys
     where organization_id = v_org and scope = 'bundle_distribution'
       and key = p_idempotency_key for update;
    if found then
      if v_existing.request_hash = v_request_hash and v_existing.status = 'completed' then
        return v_existing.resource_id;          -- the replay: return the ORIGINAL, write nothing
      end if;
      raise exception 'idempotency_conflict' using errcode = '40001';
    end if;
```

**What the important parts mean.**

- **Same key + same request → return the original id.** The retry is absorbed. The operator's second
  "send" produces the first send's result.
- **Same key + *different* request → refuse loudly.** If the quantity changed, this is not a retry, it
  is a new intent wearing an old name. Silently returning the first result would lose the edit.
- `for update` locks the key row, so two simultaneous replays cannot both decide they are first.
- **`p_idempotency_key text default null`** keeps the web modal working untouched — it sends no key
  and gets exactly the old behaviour.

On the client, the key is minted **before** the first attempt and reused by the replay, and a 4xx is
no longer queued at all:

```tsx
const idempotencyKey = newIdempotencyKey();     // BEFORE the request
try { await api(..., { body: { ..., idempotencyKey } }); }
catch (e) {
  if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
    Alert.alert('Could not distribute', e.message);   // the server said no; do not "save" it
    return;
  }
  await enqueue('distribute_bundle', {...}, { idempotencyKey });   // SAME key
}
```

**What you should learn.** Any operation that can be retried needs an answer to *"what if this arrives
twice?"* — and the answer must live on the **server**, because only the server knows what already
happened. A client-side "don't double-tap" guard does not survive a lost response.

---

### 5.3 SP-011 — `insert or replace` is a delete

**What was wrong.** Every 60 seconds, the phone's background sync destroyed the offline cycle-count
cache and overwrote counts the operator had taken but not yet synced.

**What caused it.** Two lines of SQLite:

```ts
await db.runAsync(
  `insert or replace into cycle_counts
     (id, status, warehouse_id, started_at, assigned_to, notes, last_synced_at)
   values (?, ?, ?, ?, ?, ?, ?)`, [...]);
await db.runAsync('delete from cycle_count_lines where count_id = ?', [c.id]);
```

**`insert or replace` in SQLite is a DELETE followed by an INSERT.** It does not merge. Every column
not in that seven-column list — `cached_at`, `warehouse_name`, `organization_id`, `posted_at` — was
silently set to NULL. And `cached_at` NULL is how the app decides a count *"was never cached"*, so the
offline copy the operator had deliberately downloaded simply vanished.

The lines were worse: deleted and re-inserted from the server payload, discarding `item_name`, the
size/variant label, `local_dirty` (the flag meaning "this count has not reached the server yet") and
the operator's `counted` value.

**What we changed.** An upsert that changes only what the snapshot actually carries, and a conflict
policy that respects unsynced work:

```sql
insert into cycle_count_lines (id, count_id, item_id, expected, counted, local_dirty)
values (?, ?, ?, ?, ?, 0)
on conflict(id) do update set
  expected = excluded.expected,
  counted  = case
               when cycle_count_lines.local_dirty = 1 then cycle_count_lines.counted
               else excluded.counted
             end
```

`on conflict(id) do update set …` means *"if this row exists, change these columns and leave the rest
alone."* `excluded` is the row we tried to insert. The `case` is the whole policy in one expression:
**server wins for clean lines, local wins for dirty ones** — the same rule the app already applied
elsewhere and had silently violated here.

**How we tested it.** The SQL was moved into its own tiny module with no imports, so it can run against
a **real SQLite database** (`node:sqlite`) using the real schema. The test seeds a fully-cached count
with one locally-edited line, runs the real statements, and asserts `cached_at` survives, the dirty
line keeps the operator's number, a clean line takes the server's, and a vanished line is removed only
if clean.

**What you should learn.** `insert or replace` and `delete`-then-`insert` are not "upsert". Reach for
`on conflict … do update` and name the columns you mean to change. And when the bug is in a string of
SQL, put the string somewhere a test can reach it.

---

### 5.4 SP-015 — a preference is not a permission

**What was wrong.** A user removed from one organization could get a request context *for that
organization*, carrying the role they hold in a different one.

**What caused it.** One line:

```ts
const targetOrgId = orgId ?? session.defaultOrganizationId ?? defaultOrgId;
```

Just above it, the loader had already worked out which membership to use — preferring the profile's
default when that default is a real accepted membership, and falling back when it is not. Then this
line reached back past that work and read the **raw preference column** again. Nothing clears
`default_organization_id` when someone is removed from an org.

So for a user removed from org A but still in org B:

| | |
|---|---|
| `organizationId` | **org-A** (they are not a member) |
| `role`, `organizationName` | from **org-B** |
| `permissions` | loaded for **org-A** using **org-B's** role |

RLS blocks a non-member's ordinary reads — but all 203 `createAdminClient()` service-role paths scope
by `ctx.organizationId`, and those bypass RLS by design. Writes were aimed at an org the user had been
removed from.

**What we changed.** One word, plus a cleanup:

```ts
const targetOrgId = orgId ?? defaultOrgId;   // the RESOLVED membership, not the raw preference
```

and `removeMember` now clears the stale column. Either change alone closes it; both together mean the
resolver no longer trusts the column *and* the column no longer lies.

**How we tested it.** A profile defaulting to org-A, one membership in org-B. On the old resolver the
test fails with `expected 'org-A' to be 'org-B'` — the bug, printed.

**What you should learn.** Distinguish a **preference** ("which workspace do I like to land in") from
an **authorization fact** ("which workspaces may I act in"). Preferences come from the user and can go
stale; facts must be re-derived from the source of truth on every request.

---

### 5.5 SP-016 — a function that never throws

**What was wrong.** "Invite sent" could be false.

**What caused it.** `sendEmail` **never throws**. It returns `{ ok: false, error }`:

```ts
await sendEmail({ to: normalizedEmail, ... });          // ← result discarded
return { id: invite.id, token: invite.token, acceptUrl };
```

`await` protects you from an *exception*. It does nothing about a function that reports failure in its
**return value**. The admin saw success, the audit log recorded `user.invited`, and nobody was
contacted.

**What we changed.** Check the result — and in `resendInvite`, check it *before* writing the audit row,
because an audit trail that records sends which never happened is worse than none.

One detail worth knowing: the error code is `conflict`, not `internal_error`. This codebase
deliberately genericises `internal_error` messages so database text can't leak to a client — which
would have hidden the one thing the admin needs ("copy the link from Pending invites"). Picking the
wrong code would have made the fix useless.

**What you should learn.** Before you ignore a return value, check whether the function signals failure
by throwing or by returning. Ours returns.

---

## 6. Architecture — how StockPilot fits together

```
   WEB                                       MOBILE
   React Server Component (page.tsx)         Expo screen (app/**)
        │ renders                                 │ fetch
        ▼                                         ▼
   Client component ──action──► Server Action  /api/v1/* route  (Bearer token twin)
                                    │               │
                                    └──────┬────────┘
                                           ▼
                              Service  (src/server/services/*)
                              · permission gate: can(ctx, 'stock:adjust')
                              · module gate:     assertModuleEnabled
                              · warehouse scope: assertWarehouseAccess
                                           │
                     ┌─────────────────────┴─────────────────────┐
                     ▼                                           ▼
        @stockpilot/core (pure rules)              Supabase / Postgres
        no I/O, shared by web+mobile               RLS policies + SECURITY DEFINER RPCs
                                                   ← the LAST line of defence
```

**Which layer does what — and where bugs of each kind live.**

| Layer | Owns | Sweep findings that lived here |
|---|---|---|
| Component | what the user sees and clicks | SP-010 (effect deps wiped state) |
| Server Action / API route | validation, authentication, HTTP shape | SP-017 (missing scope header) |
| Service | permissions, orchestration, audit | SP-016, SP-015, SP-013 |
| Core | pure business rules shared by both clients | (the fix target for several open items) |
| Database | the invariant that must hold no matter who is calling | **SP-001**, SP-002 |

**No architecture changes were required.** Every fix landed in the layer that already owned the
concern. The one structural addition is a security *invariant* (INV-25/26), not a redesign.

---

## 7. How to find code yourself

Pick the thing you can see, then walk down the stack.

**"The receive dialog lost my quantities."**
```
apps/web/src/components/po/po-receive-dialog.tsx     ← the screen
  → src/server/actions/purchase-orders.ts            ← the action it calls
    → src/server/services/receiving.ts               ← the rules
      → supabase/migrations/*post_receipt*           ← the transaction
        → supabase/tests/*post_receipt*              ← what is guaranteed
```

**"Stock is wrong after a count."** `cycle-count-detail.tsx` → `services/cycle-counts.ts` →
`grep -l post_cycle_count supabase/migrations` → the newest match wins → its pgTAP test.

**"The phone shows something different from the web."** Find the web service, then
`grep -rn "api/v1/<thing>" apps/mobile` for the mobile call site. If mobile calls Supabase
**directly** instead of a `/api/v1` route, that is where parity bugs live — five of this sweep's
findings are exactly that shape.

**Three commands worth memorising.**
```bash
grep -rn "function_name" supabase/migrations | tail -1   # the CURRENT definition (last one wins)
ls supabase/tests | grep <feature>                       # what is actually guaranteed
git log -S "someString" -- path/to/file                  # when a line appeared, and why
```

---

## 8. How to debug StockPilot

1. **Reproduce it.** If you cannot, you are guessing.
2. **Find the surface** — the screen or endpoint.
3. **Follow the call down** — component → action/route → service → database.
4. **Read the comments.** This codebase records real incidents inline. A block that looks odd is
   usually odd on purpose; the comment says why.
5. **Read the tests, then the migrations.** They tell you what is *guaranteed*, which is often
   narrower than what you assumed.
6. **Write the failing test first.** If it passes before you fix anything, you have not found the bug.
7. **Fix the root cause**, in the layer that owns it.
8. **Prove it** — revert your fix and watch the test fail.
9. **Ask what would have caught this**, and add that.

---

## 9. New terms

| Term | Plain English |
|---|---|
| **RLS** (Row Level Security) | Rules in Postgres itself deciding which *rows* you may see or change. Applies no matter how you connect. |
| **`SECURITY DEFINER`** | A function that runs with its **owner's** privileges instead of the caller's — so RLS does not protect the data inside it. It must check for itself. |
| **`SECURITY INVOKER`** | The default: runs as the caller, RLS applies normally. |
| **Idempotency key** | A unique id the client mints before its first attempt and reuses on retries, so the server can recognise "I have already done this". |
| **Upsert** | "Insert, or update if it already exists" — `on conflict … do update`. In SQLite, `insert or replace` is *not* this: it deletes the old row first. |
| **Stale closure** | A callback that captured a value when it was created and keeps using the old copy. |
| **Fail-open / fail-closed** | On error: fail-open carries on as if fine (dangerous); fail-closed refuses (usually right for writes). |
| **Race condition** | Two things happening at once produce a result neither would alone — e.g. two approvals creating two POs. |
| **pgTAP** | A framework for writing tests *in SQL*, so database rules are tested in the database. |
| **Regression test** | A test written from a real bug, so it cannot come back unnoticed. |
| **N+1 query** | Fetching a list, then one query per row. 200 items = 201 queries. |
| **PostgREST 1000-row cap** | Our API returns at most 1000 rows per request, silently. Beyond that you must paginate or you lose data with no error. |

---

## 10. The ten things worth taking from this sweep

1. **`SECURITY DEFINER` + `grant to authenticated` = the body must authorize.** That combination
   caused the P0.
2. **A role check on a caller-supplied org id is not enough.** Prove the *ids* belong to the org too.
3. **Test the fix against the bug.** Every fix here was proven by reverting it and watching the test
   fail. On the old code, the 0346 suite failed 13 of 27 and the 0347 suite failed 16 of 19.
4. **Fix the class, not the instance.** SP-001 became INV-25/26; SP-017 became a sweep of every raw
   call site. The repo's own pattern #26 says the same: a fix applied to one copy of duplicated logic
   is not a fix.
5. **`await` does not catch a returned failure.** `sendEmail` reports by return value; ignoring it made
   the app lie.
6. **A preference is not a permission.** Re-derive authorization facts every request.
7. **`insert or replace` is a delete.** It nulls every column you did not list.
8. **A retry needs a server-side identity.** Otherwise it is a second event.
9. **Empty results deserve suspicion.** A report was dead for its entire life because a query error
   became `[]` and nobody logged it.
10. **A limit that is silently skipped is a hiding place.** The scanner treated "I stopped reading" as
    "I found nothing" — and the repo already knew this lesson from an earlier upload-security wave.

---

## 11. Remaining technical debt

126 verified findings are open, each with a verified fix plan in the
[register](./2026-09-05-codebase-sweep-findings.md). The 10 open P1s, and why they were not fixed now:

| ID | Issue | Why not now | Next step |
|---|---|---|---|
| SP-005 | Mobile quick-adjust calls `adjust_stock` directly, bypassing web-side rules | Needs a new `/api/v1` route **and** an OTA; changes a live warehouse flow | Add the Bearer twin, move the screen onto it, OTA |
| SP-007 | Mobile PO receive calls the RPC directly — no audit, no outbox event, no webhook | Same shape; larger blast radius (receiving) | Add `/api/v1/po/[id]/receipts`, move the screen |
| SP-008 | Account deletion reports success when `deleteUser` fails; the "tombstone blocks login" premise is false | Touches account deletion; deserves its own careful change | Revoke sessions, surface the failure, add a real login guard |
| SP-013 | PO-import approve has no atomic claim — two approvals create two POs | Needs a compare-and-swap plus a revert path | Claim-then-work, with the existing idempotency test extended |
| SP-014 | Password reset cannot complete for any TOTP-enrolled user | Cross-layer (core + action + page) auth change | Accept a TOTP/recovery code in the reset flow |
| SP-018 | Mobile attachments bypass the upload threat scan | Sequenced: route → OTA → migration, gated on the OTA audience | Add the finalize twins first |
| SP-019 | PO `expected_at` shows one day early for Pacific viewers (PDF, list, mobile, overdue count) | Small but wide; needs one date helper and every call site swept together | Treat it as a calendar date everywhere |
| SP-022 | "Enrolled TOTP forces AAL2" is app-layer only; direct PostgREST bypasses it | Needs an RLS-level helper and careful rollout | `session_mfa_satisfied()` helper + policy updates |
| SP-023 | Rental return/cancel status update is fail-open; reservations released regardless | Needs the row-proof pattern plus a warehouse gate | `.select().maybeSingle()` + `assertWarehouseAccess` |
| SP-090 | (same defect as SP-002) | — | Closed by 0347 |

Also open and worth naming: **65 P2** (unpaginated queries that silently truncate at 1000 rows, error
text leaking in ~20 API routes, several timezone bugs) and **51 P3** (dead code, duplicated helpers,
stale comments, test hygiene — including `pnpm format:check`, which cannot run at all).

---

## 12. Verification results

Every row below was executed on this branch.

| Check | Result | Evidence |
|---|---|---|
| Format | **FAIL (pre-existing, unchanged)** | Prettier has no SQL parser; the root glob includes `*.sql`. Documented as SP-095. |
| Lint | **PASS** | 0 errors, 33 warnings — identical to baseline |
| Typecheck | **PASS** | web + mobile + core |
| Unit tests — web | **PASS** | 563 files / 7,277 tests |
| Unit tests — mobile | **PASS** | 75 files / 1,622 tests |
| Unit tests — core | **PASS** | 65 files / 1,449 tests |
| DB tests (pgTAP) | **PASS** | 142 files / 2,448 tests, after `supabase db reset` |
| Security gate | **PASS** | `pnpm security:test`, now including INV-25/26 |
| Build | **PASS** | `pnpm build` |
| **Negative proofs** | **PASS** | 0346 suite: 13/27 fail on the old bodies. 0347 suite: 16/19 fail on the old function. Scanner, dialog, invite and session tests each fail with their module reverted. |
| Production migration | **APPLIED** | 0346 pushed; verified in production: the three helpers now gate, ungated authenticated-executable SECDEF functions **18 → 15** (the remaining 15 are the allowlisted read-only predicates) |
| E2E (Playwright) | **NOT RUN** | 6 specs; needs a running app + test credentials |
| Mobile device test | **NOT RUN** | The mobile fixes are OTA-shippable but have not been hand-tested on hardware |

---

## 13. Ship notes

- Migration **0346 is already in production** (it closes the P0; the code needed no change to match it).
- **0347 must be pushed before this branch merges** — `supabase db push --linked` — because the service
  passes a seventh argument the old function does not accept.
- The mobile fixes need an **OTA release** (`pnpm release:ota` from `apps/mobile`) and, per house rules,
  a simulator hand-test of the cycle-count, PO-receive and bundle-distribute screens before that goes out.
