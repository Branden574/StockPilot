# Account-disable — end-to-end verification (Task 12)

**Branch:** `feat/account-disable` (from `cdc63c88`)
**Date:** 2026-07-31
**Verdict:** the four local gates are green; the scenario is **NOT fully green**. Four scenario
lines fail and two more pass only partially. Details and evidence below — nothing here is inferred.

**Everything in this report ran against the LOCAL stack only.** No migration was pushed, no
production account was disabled, and no hosted project was contacted. The proof for that claim is in
[Environment and safety](#environment-and-safety).

---

## Summary

| Scenario line | Result |
|---|---|
| 1. Baseline (R1) — web + mobile | PASS |
| 2. Protected target (R3) | PASS |
| 3. Reason is mandatory | PASS |
| 4. Disable | PASS (toast text not captured — see note) |
| 5. Instant eviction — mobile | **FAIL** |
| 6. Next validation — web | PASS |
| 7. Sign-in blocked | PASS |
| 8. Wrong password does not leak | **FAIL** |
| 9. API blocked | PASS |
| 10. Token refresh blocked | PARTIAL |
| 11. Offline replay rejected | **FAIL** |
| 12. Idempotency | PARTIAL — state idempotent, audit is not |
| 13. Data untouched (R2) | PASS |
| 14. Audit trail | PARTIAL — data complete, UI incomplete |
| 15. Re-enable (R4) | PASS |
| 16. Re-enable idempotency | PARTIAL — same as 12 |
| 17. Divergence heals | PASS |

**Counts: 9 PASS, 4 PARTIAL, 4 FAIL, 0 NOT-RUN.** (Line 12 and 16 are the same defect counted twice
because the scenario lists them separately.)

The four FAILs are:

- **Line 5 / Line 11 share one root cause** and are the most serious finding in this report: the
  disable revokes the user's sessions, so the device's auth probe can never see `user_banned`, the
  account gate never reaches `disabled`, and the whole mobile eviction path — disabled screen,
  outbox rejection, cache wipe — never runs.
- **Line 8** is an account-status enumeration oracle that the app cannot currently close.
- Line 12/16's audit behaviour is a deliberate implementation decision that contradicts the
  scenario's wording; it needs an owner ruling, not a code change on my authority.

---

## Gate 1 — the four local gates

All four were run after `supabase db reset` on this branch. Real output.

### `supabase db reset && pnpm db:test`

```
/…/supabase/tests/0308_account_disable.test.sql ................................ ok
/…/supabase/tests/0309_pin_user_profile_disable_flags.test.sql ................. ok
/…/supabase/tests/0310_rls_blocks_disabled_accounts.test.sql ................... ok
/…/supabase/tests/0311_user_can_access_inventory_disable_guard.test.sql ........ ok
All tests successful.
Files=108, Tests=1526,  3 wallclock secs ( 0.14 usr  0.08 sys +  0.46 cusr  0.18 csys =  0.86 CPU)
Result: PASS
EXIT=0
```

`supabase db reset` applied 0308, 0309 and 0310 cleanly (exit 0).

Declared pgTAP plans, read from the files rather than assumed:

| File | `select plan(N)` |
|---|---|
| `0308_account_disable.test.sql` | **39** |
| `0309_pin_user_profile_disable_flags.test.sql` | 28 |
| `0310_rls_blocks_disabled_accounts.test.sql` | 51 |
| `0311_user_can_access_inventory_disable_guard.test.sql` | 39 |

This matches the drift correction: 0308's plan is 39, not 16. Note the plan lists **three** new
migrations and **four** new pgTAP files, not the one the task brief anticipated.

### `pnpm test`

```
@stockpilot/core:test:    Test Files  40 passed (40)
@stockpilot/core:test:         Tests  705 passed (705)
@stockpilot/mobile:test:  Test Files  46 passed (46)
@stockpilot/mobile:test:       Tests  906 passed (906)
@stockpilot/web:test:     Test Files  393 passed (393)
@stockpilot/web:test:          Tests  4157 passed (4157)
 Tasks:    3 successful, 3 total
EXIT=0
```

5,768 tests across the three packages, all green.

### `pnpm typecheck`

```
 Tasks:    3 successful, 3 total
Cached:    2 cached, 3 total
  Time:    6.19s
EXIT=0
```

### `pnpm lint`

```
✖ 28 problems (0 errors, 28 warnings)
 Tasks:    3 successful, 3 total
EXIT=0
```

Clean by the exit code. The 28 warnings are pre-existing (e.g. unused `eslint-disable` directives in
`price-tracking.ts`) and are not introduced by this branch.

---

## Gate 2 — the branch is local, and no migration reached production

```
$ git status -sb
## feat/account-disable          (clean)

$ git log --oneline origin/main..HEAD | wc -l
18

$ git branch -r | grep -i account-disable
NONE (no origin/feat/account-disable)

$ git diff --stat main -- supabase/migrations
 supabase/migrations/0308_account_disable.sql              |  78 +++
 supabase/migrations/0309_pin_user_profile_disable_flags.sql | 117 ++++
 supabase/migrations/0310_rls_blocks_disabled_accounts.sql   | 681 +++++++++++++
 3 files changed, 876 insertions(+)
```

18 local commits, no remote branch, nothing pushed.

Per the drift correction, the "no `supabase db push` in shell history" check is not mechanically
verifiable for an agent. The substitute, stated honestly: **no `supabase db push` and no MCP
`apply_migration` was invoked at any point in this task.** The only schema command run was
`supabase db reset`, which targets the local Docker stack (`postgresql://…@127.0.0.1:54322`). The
three migrations exist only as local commits.

---

## Environment and safety

The plan's setup step would have run half the scenario against production. The BLOCKING correction
was followed exactly.

### What was changed, and put back

| File | Change for the run | Reverted |
|---|---|---|
| `apps/mobile/.env.local` | `EXPO_PUBLIC_SUPABASE_URL` → `http://127.0.0.1:54321`; `EXPO_PUBLIC_SUPABASE_ANON_KEY` → local anon key; `EXPO_PUBLIC_API_URL` → `http://localhost:3000` | **Yes** |
| `apps/web/.env.local` | appended `platform.admin@local.example.com` to `STOCKPILOT_PLATFORM_ADMIN_EMAILS`; repointed `SUPABASE_SERVICE_ROLE_KEY` at the local stack (see finding E1) | **Yes** |

Both files are symlinks into `~/Developer/stockpilot-env/`. Both were copied to the scratchpad before
being touched and restored from those copies afterwards. Restoration verified by SHA-256:

```
=== mobile .env.local sha256 vs backup ===
   2 2a37ed4ec60662eb10961465ea7807ed1e28d3ee694c9c30af34defc2da8bec8
=== web .env.local sha256 vs backup ===
   2 dac9fb130f0bd49acb26a3a3ba6ebfabf5e364344c5166e9b90c701e53e0221f
```

A count of `2` for a single hash means the live file and its backup are byte-identical.

`apps/mobile/.env.local` key names after the revert (names only, no values):

```
EXPO_PUBLIC_SUPABASE_URL=
EXPO_PUBLIC_SUPABASE_ANON_KEY=
EXPO_PUBLIC_API_URL=
EXPO_PUBLIC_SENTRY_DSN=
SENTRY_AUTH_TOKEN=
SENTRY_ORG=
SENTRY_PROJECT=

EXPO_PUBLIC_SUPABASE_URL: no localhost (reverted)
EXPO_PUBLIC_API_URL: no localhost (reverted)
```

`apps/web/.env.local` allowlist no longer contains the local test account (`grep -c` → `0`), and
`SUPABASE_SERVICE_ROLE_KEY` is back to its original `sb_secret_e3…` value.

### Proof the simulator never touched production

`resolveApiUrl()` (`apps/mobile/src/lib/api.ts:29-42`) prefers `Constants.expoConfig.extra.apiUrl`
over the env var, and falls back to `https://stockpilotusa.com` when `!__DEV__`. That fallback made
it worth proving, not assuming, where the device was pointed. The bundle Metro actually served was
fetched and inspected:

```
EXPO_PUBLIC_API_URL": { enumerable: true, value: "http://localhost:3000"
EXPO_PUBLIC_SUPABASE_URL": { enumerable: true, value: "http://127.0.0.1:54321"
```

Corroborated behaviourally: the app's home screen rendered the **local** fixture data (2 SKUs,
`$900` = 105 × $5 + 50 × $7.50, items named "E2E Widget Alpha/Beta"), which exists only in the local
database.

### Accounts

Demo Co (`71b27a4a-…`) was **not** used — it exists only in production. Both accounts were created
against the local stack in the seeded local org `00000000-0000-0000-0000-000000000001` ("Acme Demo
Co"):

| Role | Email | uid |
|---|---|---|
| Platform admin (allowlisted, owner) | `platform.admin@local.example.com` | `e190e187-8ba7-4123-abab-a0b3bca17483` |
| Ordinary member (staff) | `member.user@local.example.com` | `5a87c235-a5d7-4f8b-8755-6f91df180531` |

**Deviation from the correction's wording:** the correction says "create both accounts by signing
up". Public sign-up is disabled in this product — `signUpAction` returns `forbidden` with "Public
sign-up is disabled" (`apps/web/src/server/actions/auth.ts:166-172`). The accounts were therefore
created through the GoTrue admin API against the local stack, with `organization_members` and
`user_profiles` rows inserted to match what the invite-acceptance flow produces. Local fixtures also
required a `warehouses` row and a `user_warehouse_assignments` row, because `supabase/seed.sql`
creates neither and the inventory RLS predicate keys on `warehouse_id`.

TOTP was enrolled on the platform admin (`auth.mfa_factors` → one `totp` factor, status `verified`)
and step-up completed, per the advisory. Without it the console returns `aal2_required` — confirmed
directly during the run, see finding E2.

---

## The scenario, line by line

### 1. Baseline (R1) — PASS

Web, as the ordinary member: `/dashboard` rendered ("Good evening, Local.", sidebar identity "Local
Member · Warehouse User · Acme Demo Co"), the item page for `E2E-SKU-001` rendered (100 units,
`$500.00` value), and a stock adjustment of +5 applied — `quantity_on_hand` went `100 → 105` in the
database.

Mobile, same account on the simulator: signed in against the local stack, home screen showed "Acme
Demo Co · synced now" with `2 SKUs` and `$900` — matching the post-adjustment local data. Sync works.

### 2. Protected target (R3) — PASS

Two independent halves, per the drift correction (the "node REPL" option was dropped — the action is
a `'use server'` function needing cookies plus AAL2).

**Service seam.** A vitest file was run against the real `disableUserAccount` with a real
service-role client pointed at the local database:

```
✓ src/server/services/platform/account-status.r3-local.test.ts (2 tests) 123ms
  ✓ refuses PROTECTED_ADMIN_ACCOUNT and leaves disabled_at null
  ✓ an ordinary member is NOT protected (control)
```

The refusal returns exactly `{ ok: false, code: 'PROTECTED_ADMIN_ACCOUNT' }`,
`user_profiles.disabled_at` for the admin stays `null`, and no `user_disabled` audit row is written
for the refused attempt. The control case proves the refusal is target-specific rather than a blanket
failure.

**Browser.** On the Users tab, the platform admin's row action menu contains only
`Send password reset...`. The member's row contains `Send password reset...` **and**
`Disable account...`. Confirmed on screen, not from the DOM alone.

This test file was temporary (it needs a live local database and would break CI) and was deleted
after the run. It is reproduced in [Appendix A](#appendix-a--the-temporary-scenario-test-files).

### 3. Reason is mandatory — PASS

Disable-button state at each step of the dialog:

```
initial (no category, no email):                          disabled=true
category=Other, notes empty, email empty:                 disabled=true
category=Other, notes EMPTY, email typed:                 disabled=true
category=Other, notes WHITESPACE-ONLY, email typed:       disabled=true
category=Other, notes real, email typed:                  disabled=false
notes real, email MISTYPED:                               disabled=true
notes real, email correct again:                          disabled=false
```

The button never enables without notes when the category is `Other`, whitespace-only notes do not
satisfy it, and the typed-email confirmation is independently required. On screen the dialog shows
"Notes (required)" and the inline error "Describe the reason when the category is Other." with the
confirm button greyed out.

### 4. Disable — PASS (with one thing not captured)

Performed from the console dialog with category `Security investigation` and notes "Task 12 scenario
line 4 — scripted disable", by an admin holding a fresh AAL2 step-up. Afterwards the member's row
shows a red **Disabled** chip and the actions menu offers **Re-enable account**.

Audit row written:

```json
{
  "banned": true,
  "reason": "Security investigation — Task 12 scenario line 4 — scripted disable",
  "reason_category": "security_investigation",
  "already_disabled": false,
  "sessions_revoked": 3,
  "sessions_revoke_ok": true
}
```

**Not captured:** the scenario asks to "record the toast's revoked-session count". The toast had
already dismissed by the time the screenshot was taken, so I did not see it. The revoked-session
count is recorded here from the audit row (`sessions_revoked: 3`), not from the toast. I am not
claiming to have read the toast.

### 5. Instant eviction — mobile — **FAIL**

**Expected:** the simulator signs itself out within a few seconds and lands on the disabled screen
with the exact copy.

**Observed:** the app did leave its authenticated session, but it landed on the **generic
signed-out marketing screen** ("Inventory software quiet enough to actually use." with a `Sign in`
link) — not on the disabled screen, and the owner-approved copy was never shown on the device.

Root cause, proven at the protocol level:

`disableUserAccount` writes the flag, applies the GoTrue ban, and then **revokes the user's
sessions** (`admin_revoke_user_sessions` deletes the `auth.sessions` rows). By the time the device
probes, its session no longer exists, so GoTrue answers:

```
$ curl /auth/v1/user  -H "Authorization: Bearer <pre-disable token>"
{"code":403,"error_code":"session_not_found","msg":"Session from session_id claim in JWT does not exist"}
HTTP 403
```

`classifyAuthProbe` (`apps/mobile/src/lib/account-disabled-probe.ts`) accepts **only**
`error.code === 'user_banned'` as proof of a disable; a 403 `session_not_found` falls through to
`'unknown'`. So the gate never transitions to `disabled`, `useAccountGate`'s eviction effect never
fires, and `runAccountEviction` — the disabled screen, `rejectAllPending`, `wipeForSignOut`,
`clearAccountStorage` — never runs at all. supabase-js's own session handling signs the user out
locally, which is why the device ends up on the marketing screen instead.

This is a design conflict inside the feature, not a wiring mistake: the session revocation that makes
the disable effective is the very thing that stops the client from ever learning it was a *disable*
rather than an ordinary session expiry. The probe's fail-safe posture ("showing the disabled screen
to a working account is worse than showing it late") is sound in isolation; combined with revocation
it means the disabled branch is unreachable on the eviction path.

### 6. Next validation — web — PASS

The member's still-open browser tab landed on `/account-disabled`. Copy read off the rendered page:

```
Your account has been temporarily disabled

Your StockPilot account has been temporarily disabled. Please contact your system administrator for assistance.

Sign out
```

Byte-identical to `ACCOUNT_DISABLED_TITLE` and `ACCOUNT_DISABLED_MESSAGE` in
`packages/core/src/auth/account-status.ts`. Page title `Account disabled · StockPilot`.

No loop: navigating to `/dashboard/inventory` while disabled lands on `/account-disabled` in a single
hop and stays there.

### 7. Sign-in blocked — PASS

Signing in with the **correct** password lands on `/account-disabled` with the dedicated copy, not
"Invalid email or password".

### 8. Wrong password does not leak — **FAIL**

| Attempt | Result |
|---|---|
| Disabled account + **correct** password | `/account-disabled`, disabled copy |
| Disabled account + **wrong** password | `/account-disabled`, disabled copy |
| Active account + **wrong** password (control) | stays on `/signin`, "Invalid email or password" |

The disabled account's response is trivially distinguishable from a normal bad-credential attempt, so
anyone who knows only an email address can learn that the account is disabled without knowing the
password.

The cause is upstream of the app. GoTrue rejects a banned user **before** it verifies the password:

```
disabled user + wrong password →  {"error_code":"user_banned","msg":"User is banned"}       HTTP 400
active   user + wrong password →  {"error_code":"invalid_credentials", …}                    HTTP 400
```

`signInAction`'s `isBannedUserAuthError` branch therefore fires for *any* password, and the
application genuinely cannot distinguish the two cases — GoTrue never tells it whether the password
was right.

Note this is in direct tension with line 7: line 7 requires the dedicated screen on a correct
password, line 8 requires indistinguishability on a wrong one, and GoTrue supplies exactly one answer
for both. **As specified, lines 7 and 8 cannot both hold.** This needs an owner decision on which
guarantee wins.

### 9. API blocked — PASS

With the mobile-style access token captured **before** the disable, still cryptographically valid
(2,675 s of life left at the time of the call):

```
$ curl /api/v1/mobile/snapshot -H "Authorization: Bearer <pre-disable token>"
{"error":"unauthenticated"}
HTTP 401

$ curl /api/v1/mobile/snapshot          # no token at all, control
{"error":"unauthenticated"}
HTTP 401
```

Byte-identical to the anonymous control. No extra detail, no disabled-specific code.

### 10. Token refresh blocked — PARTIAL

The refresh is blocked, but not with the code the scenario expects:

```
$ curl /auth/v1/token?grant_type=refresh_token -d '{"refresh_token":"<pre-disable>"}'
{"code":400,"error_code":"refresh_token_not_found","msg":"Invalid Refresh Token: Refresh Token Not Found"}
HTTP 400
```

The scenario expects `user_banned`. The refresh token is gone rather than banned because
`auth.refresh_tokens.session_id` cascades on the session delete, so revocation removes the row before
the ban can be the reason. The security outcome is the same — arguably stronger — but the observed
code differs from the scenario, so this is recorded as partial rather than a clean pass.

`user_banned` *is* returned for a password grant against the same account, so the ban is applied:

```
$ curl /auth/v1/token?grant_type=password …
{"code":400,"error_code":"user_banned","msg":"User is banned"}
```

### 11. Offline replay rejected — **FAIL**

Both engines were loaded with a genuine outbox row before the disable:

| Engine | Kind | How it was created |
|---|---|---|
| `CycleCountSyncEngine` | `record_count` | **Real UI** — a count of `97` typed into the cycle-count screen on the simulator while `:3000` was unreachable |
| `sync.ts::drainQueue` | `distribute_bundle` | Row inserted directly into the app's `pending_actions` table (substitution — see below) |

State immediately before the disable:

```
id  kind               status   attempts
1   record_count       failed   2
2   distribute_bundle  pending  0
```

**Expected:** both rows end `rejected`, are preserved, and never send.

**Observed:** after the disable and an app resume, both rows are still `failed` — the *retryable*
status — and stayed that way for the rest of the run:

```
id  kind               status  attempts  last_error
1   record_count       failed  8         unauthenticated
2   distribute_bundle  failed  8         unauthenticated
```

Neither row ever reached `rejected`. This follows directly from the line-5 root cause: terminal
rejection has two possible sources and the disable defeats both.

1. Per-row classification — `classifyDrainFailure(err, { accountDisabled })` only returns `'rejected'`
   when `getAccountDisabled()` is already true. It never becomes true, for the reason in line 5.
2. Bulk rejection at eviction — `rejectAllPending(ACCOUNT_DISABLED_REJECTION)` is called from
   `useAccountGate`'s eviction effect, which never runs.

So Task 11's guarantee (3) — "preserve a local record long enough to explain what happened" — is not
delivered in the real disable path: the rows survive, but as ordinary retryable failures with
`last_error: "unauthenticated"`, not as the self-explanatory rejected rows the design intends. And
guarantee (4) — "must not auto-replay after the account is re-enabled" — is **not structurally
enforced**: rows in `failed` are exactly what `listPending()` selects, so they remain live work.

**Did they replay after re-enable?** No data changed — after re-enable and a fresh mobile sign-in,
`counted_lines=0`, `bundle_distributions=0`, quantities still `105`/`50`, watched over ~2 minutes
with attempt counters climbing (`record_count` 6→8, `distribute_bundle` 2→8). **But I cannot report
this as the guarantee holding.** The rows did not replay because the requests kept failing, not
because they were terminally rejected. The drains were actively retrying the whole time, which is the
opposite of the intended end state. Treat "no replay observed" here as a timing accident, not a pass.

**Substitution declared.** The brief asks for "a stock adjustment via sync.ts". That is not
achievable from the app: no screen enqueues `adjust_stock`, and `sync.ts:376-381` throws
`'adjust_stock queueing not yet wired — adjust online for now'` for that kind. The only kinds any
screen actually enqueues today are `record_count`, `distribute_bundle` and `size_count_event`. I used
`distribute_bundle` — a kind the app genuinely queues, on the `sync.ts::drainQueue` path — and
authored the row directly into `pending_actions` rather than through the bundle screen, because the
bundle detail screen hung on load in this local environment. The row is byte-shaped exactly as
`app/bundles/[id].tsx:171` writes it; only the authoring step is substituted. The `record_count` row
was created entirely through the real UI with no substitution.

### 12. Idempotency — PARTIAL

The **state machine is idempotent**. A second `disableUserAccount` against the already-disabled
account:

```
result = {"ok":true,"alreadyDisabled":true,"banned":true,"sessionsRevoked":0,"partial":false,"partialReasons":[]}
disabled_at unchanged?     true
disabled_reason unchanged? true  ("Other — E2E regression scenario line 3/4")
```

The compare-and-set correctly wrote nothing and reported the replay.

**The audit is not idempotent, by design.** `user_disabled` rows went from 1 to 2:

```
user_disabled audit rows: before=1 after=2
newest detail = {"banned":true,"reason":"Security investigation",
                 "reason_category":"security_investigation","already_disabled":true,
                 "sessions_revoked":0,"sessions_revoke_ok":true}
```

The scenario says "confirm no second `user_disabled` row appears". The implementation deliberately
does the opposite — `account-status.ts:226-233` documents it at length, because attempting the audit
only on the first press is what turned a lost audit row into a permanently lost one, and re-recording
is what makes the advertised "press it again" retry able to close the gap. The replay row is honestly
marked `already_disabled: true`.

I have **not** changed this. It is a spec-versus-implementation conflict where the implementation has
the better argument, and it needs an owner ruling: either the scenario line is reworded, or the audit
gains a distinct `user_disable_replayed` action so a genuine disable is still countable as one row.

### 13. Data untouched (R2) — PASS

Pre-disable and post-re-enable snapshots differ in exactly one row, and it is my own fixture:

```
4c4
< cycle_counts|0|-
---
> cycle_counts|1|2026-07-31 20:07:33.956592+00
```

That cycle count was created by me at 20:07:33Z as scenario scaffolding — **before** the disable at
20:24:55Z. Everything else is identical: `organization_members`, `stock_movements`, `order_requests`,
`purchase_orders`, `inventory_items` counts, quantities and `updated_at` values all unchanged.

Made airtight by asserting nothing was written at or after the disable timestamp:

```
 inventory_items      | 0
 stock_movements      | 0
 cycle_counts         | 0
 cycle_count_lines    | 0
 order_requests       | 0
 purchase_orders      | 0
 bundle_distributions | 0
 organization_members | 1   (the membership row itself, untouched)
```

The disable and the re-enable changed no inventory, PO, order, cycle-count or financial row.

### 14. Audit trail — PARTIAL

**Data layer: complete.** The `platform_admin_audit` row carries the actor uid, the actor email, the
action, `target_user_id`, and the composed reason plus category in `detail` (quoted under line 4).

**UI layer: incomplete.** `/platform/audit` renders four columns — WHEN, ACTOR, ACTION, **TARGET
ORG**. For the disable rows it shows the actor email and "Disabled account" correctly, but:

- there is no target-**user** column, so `target_user_id` renders as `—`;
- the reason is not surfaced anywhere on the page.

The scenario asks the page to show "the actor email, the target user and the reason in `detail`". It
shows one of the three. An operator auditing a disable from this screen cannot see who was disabled
or why without querying the database.

### 15. Re-enable (R4) — PASS

From the console: toast "Account re-enabled. The user can sign in again.", the **Disabled** chip is
gone from the member row, and the menu returns to offering `Disable account...`.

Service-level:

```
result = {"ok":true,"alreadyActive":false,"banned":false,"partial":false,"partialReasons":[]}
disabled_at = null   banned_until = null
user_reenabled audit detail = {"ban_cleared":true,"already_active":false}
```

**A fresh login is required and old sessions are not resurrected** — verified on both surfaces:

- Web: navigating to `/dashboard` after the re-enable bounced to `/signin?redirect=%2Fdashboard`;
  after signing in, `/dashboard` rendered with the same identity ("Local Member · Warehouse User ·
  Acme Demo Co") and no Disabled chip.
- Mobile: relaunching produced the signed-out screen, not a restored session. After signing in, the
  home screen showed the same org and the same data (2 SKUs, `$900`).

### 16. Re-enable idempotency — PARTIAL

```
second result = {"ok":true,"alreadyActive":true,"banned":false,"partial":false,"partialReasons":[]}
user_reenabled audit rows after second press = 2
```

State is idempotent (`alreadyActive: true`, `disabled_at` still null); the audit row count increments.
Identical to the line-12 finding and the same owner decision applies.

### 17. Divergence heals — PASS

`banned_until` was hand-written onto an **active** account (flag null, GoTrue banned), then Re-enable
pressed:

```
diverged: disabled_at=null  banned_until=2126-07-07T20:15:26Z
result  = {"ok":true,"alreadyActive":true,"banned":false, …}
healed  : banned_until=null
```

The stray ban is lifted even though the CAS matched nothing — the self-repair path works.

---

## Additional findings (outside the numbered scenario)

### E1 — `apps/web/.env.local` ships a service-role key that is wrong for the local stack

`SUPABASE_SERVICE_ROLE_KEY` in the local env file is a foreign `sb_secret_e3…` value. Against the
local stack it authenticates as **anonymous** rather than service-role:

```
web SRK       → GET /rest/v1/organizations  HTTP 200  []                                    ← RLS-filtered, no rows
local secret  → GET /rest/v1/organizations  HTTP 200  [{"id":"00000000-…","name":"Acme Demo Co"}]
```

Every `createAdminClient()` path in local dev therefore returns nothing, silently. The visible symptom
is the platform console reporting **"0 ORGANIZATIONS, 0 USERS, 0 ITEMS"** and "No organizations yet."
on a database that plainly has them. Nothing errors, because 200-with-an-empty-array is
indistinguishable from "no data" to the calling code.

This is the local-dev twin of the 2026-07-21 key-rotation outage recorded in project memory: reads
stay up while every service-role path quietly fails. It **fails closed and never reached production**
(the URL is `127.0.0.1`), but it blocks the console entirely for anyone doing local work. I repointed
it at the local secret for this run and reverted it afterwards; the underlying stale value is still in
the file and is worth fixing separately.

### E2 — the AAL2 gate works, and one step-up misreport is an artifact

Two things worth recording:

- **The gate is real.** Attempting the disable without a fresh step-up produced a
  `disableUserAccountAction` call that returned `aal2_required` and **did not disable the account** —
  confirmed in the dev-server log and by `disabled_at` still being null afterwards.
- **A misleading error, but not a product bug.** With a client session left stale by a dev-server
  restart, the step-up modal reported "No authenticator is enrolled. Add one in Settings → Security
  first." while `auth.mfa_factors` held a verified TOTP factor and GoTrue's `/user` endpoint returned
  it. `step-up-modal.tsx:79-89` treats an empty `mfa.listFactors()` result as "none enrolled" rather
  than distinguishing "could not read your session". On a clean session the modal behaves correctly
  and the disable completed. Recorded as an environment artifact of my own server restarts, not a
  defect — though the copy is misleading in the failure case and could be worth hardening.

### E3 — an unattributed disable early in the session

The first disable fired earlier in the run than my scripted step, carrying the reason I had typed into
the dialog at that moment ("Other — E2E regression scenario line 3/4"). I could not attribute it to a
specific click, and I am recording that rather than glossing it.

What I established, so this is not left as a vague worry:

- **Cancel is exonerated.** A controlled re-test — open the dialog, fill it validly so the confirm
  button is enabled, click **only** Cancel — left `user_disabled` at its prior count and
  `disabled_at` null. The dialog is not a `<form>`; Cancel calls `onOpenChange(false)` and nothing
  else (`disable-account-dialog.tsx:158-161`).
- **The guard was satisfied, not bypassed.** The disable carried a valid reason and the correct
  confirmation string, and the confirm gate is proven correct in both directions in line 3.

Most likely an automation-driven activation of a legitimately-enabled button. No evidence of a
product defect, and no evidence the confirmation can be circumvented.

---

## What this means for the feature

The server-side state machine is in good shape: the CAS is correct, the protected-admin refusal holds,
the reason is genuinely mandatory, the AAL2 gate bites, divergence self-heals, no business data is
touched, and both web chokepoints behave exactly as specified with the exact approved copy.

The mobile half does not currently deliver its two headline promises. Line 5 and line 11 are one bug,
and it is a design-level conflict rather than a loose wire: **session revocation makes the disabled
state undetectable by the client.** Until the device can distinguish "you were disabled" from "your
session ended", the disabled screen cannot appear on mobile and queued offline work cannot be
terminally rejected. Any fix has to give the client a signal that survives revocation — the natural
candidates are keeping `user_banned` reachable (probe with the refresh token, or check the ban before
deleting the session) or letting the eviction broadcast carry the reason — but choosing between them
is a design decision, not something to patch blind, and it belongs to the owner.

Line 8 needs an owner ruling because lines 7 and 8 are mutually unsatisfiable as written. Lines 12/16
need an owner ruling on audit-replay semantics. Line 14's UI gap is a small, self-contained fix.

---

## Appendix A — the temporary scenario test files

Two vitest files were created to drive the service seam against the local database, then deleted (they
require a live local stack and would break CI). They are recorded here so the assertions can be
re-run.

`apps/web/src/server/services/platform/account-status.r3-local.test.ts` — scenario line 2. Imports the
real `disableUserAccount`, builds a real service-role client against `http://127.0.0.1:54321`, and
asserts:

- disabling the allowlisted admin returns exactly `{ ok: false, code: 'PROTECTED_ADMIN_ACCOUNT' }`;
- `user_profiles.disabled_at` for that admin is `null` both before and after;
- no `user_disabled` audit row exists for the refused attempt;
- a control call against the ordinary member stops at `ACCOUNT_DISABLE_REASON_REQUIRED` (proving the
  refusal is target-specific, without actually disabling anyone).

`apps/web/src/server/services/platform/account-status.scenario.test.ts` — scenario lines 12, 15, 16
and 17. Same seam and client; asserts replay-idempotency of the CAS, a clean re-enable, replay of the
re-enable, and the divergence heal, logging the audit row counts quoted throughout this report.

Both were run with `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and
`STOCKPILOT_PLATFORM_ADMIN_EMAILS` pointed at the local stack and the two local uids passed as
`E2E_ADMIN_ID` / `E2E_MEMBER_ID`.

## Appendix B — evidence

47 screenshots were taken and each was read back and described rather than trusted by filename. They
cover the baseline dashboard and item page, the mobile sign-in and synced home screen, the console
org and Users tab, both row action menus, the disable dialog in its blocked and unblocked states, the
web `/account-disabled` screen, all three sign-in outcomes for lines 7 and 8, the post-disable Users
tab, the mobile screen after eviction, and `/platform/audit`.

They are outside the repository, in the session scratchpad:
`…/b7fc6dc0-134e-4114-b7df-23e58c2f3915/scratchpad/acctdisable-e2e/`.
