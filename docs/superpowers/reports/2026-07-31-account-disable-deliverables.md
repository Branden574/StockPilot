# God-Admin Temporary Account Disable — Deliverables

**Branch:** `feat/account-disable` at `e01d7c7f` (22 commits ahead of `main`)
**Date:** 2026-07-31
**Status:** complete on the branch. **Nothing has been merged, deployed, or run against production, and
no migration has been applied anywhere but the local Docker stack.** The branch itself HAS been pushed
to `origin` — see §9.6, which corrects the verification report on this point.

Sources of truth for this document, in order of authority: the shipped code and migrations on this
branch; `.superpowers/sdd/progress.md` (the program ledger); the end-to-end verification report
(`docs/superpowers/reports/2026-07-31-account-disable-verification.md`, including its re-run); the
architecture audit and the design spec. Where the original plan and the shipped code disagree, the
code is what is recorded here — the plan drifted repeatedly and is not cited as evidence.

Every claim below is traceable to a file, a migration, a measured number, or a recorded run. Where
something was not verified, it says so.

---

## 1. Root-cause and architecture report

### 1.1 The real auth provider

Supabase GoTrue plus Postgres RLS. Linked production project `xizpqmhhslgzbuqtjubv`.

`@supabase/supabase-js` is declared `^2.46.1` in both apps but the lockfile resolves **2.105.1**
(`@supabase/auth-js` 2.105.1, `@supabase/ssr` 0.5.2). The installed admin surface is therefore the
modern 2.105.x one — which matters, because two of this feature's design decisions turn on exactly
what that version does and does not expose.

The GoTrue **server** version is a separate fact from the client library. The local stack runs
**v2.189.0**. **The production GoTrue version is UNVERIFIED.** This feature leans on GoTrue's ban
semantics (see §1.6 and §4), so that should be confirmed before deploy — it is listed as an open item
in §8.

### 1.2 Session model

- One `auth.sessions` row per login (id, user_id, aal, not_after, refreshed_at, user_agent, ip, …).
- `auth.refresh_tokens.session_id` references `auth.sessions(id)` **ON DELETE CASCADE**
  (prod-verified via `pg_constraint`). Deleting a session row cascades its refresh tokens away, and
  the next refresh attempt fails.
- Access tokens are ES256 JWTs. **The data plane never consults GoTrue**: PostgREST, Realtime and
  Storage verify the signature locally and authorize purely from RLS. A revoked session's access
  token therefore keeps working against PostgREST until `exp`.
- Local `supabase/config.toml` sets `jwt_expiry = 3600`. **The hosted project's access-token TTL is a
  dashboard setting and was NOT verified.** No exposure-window claim in this document is stated using
  the local number as though it were production's.

### 1.3 Web session restoration

`apps/web/src/proxy.ts` (Next 16's proxy convention) delegates to `updateSession()` in
`apps/web/src/lib/supabase/middleware.ts`. The matcher is an explicit **allowlist** —
`/dashboard/*`, `/platform/*`, `/onboarding/*`, `/signin/*`, `/signup`, `/reset/*`, `/invite/*`,
`/portal(/*)` — and **`/api/**` is deliberately excluded** ("API routes always handle their own
auth").

`updateSession()` verifies with `auth.getClaims()` — a **local ES256 verify** against a module-global
JWKS cache (10 min), refreshing a near-expiry token (≤90 s) over the network first — with
`auth.getUser()` as a network fallback. On success it forwards `x-stockpilot-user-id` /
`x-stockpilot-user-email`; those headers are set only after verification and unconditionally deleted
otherwise, so they are not spoofable. Session state lives in `sb-<projectRef>-auth-token[.N]` cookies;
`stockpilot-remember-session` decides whether they are persistent or session-scoped.

**The revocation-relevant fact:** a locally-verified access token is accepted **until `exp` even if
the session was revoked server-side**. The middleware's own SECURITY comment says so. This is the
root cause of why a ban alone could not deliver the brief's "logout on next validation" for pages.

### 1.4 Expo session restoration

Session persists in **expo-secure-store through a custom chunked adapter** (values over 1900 bytes
split into `<key>.N` entries with a `__chunked:N` manifest, because SecureStore's Keychain items cap
around 2 KB). Client options: `autoRefreshToken: true`, `persistSession: true`,
`detectSessionInUrl: false`.

Cold launch: `AuthProvider` hydrates via `supabase.auth.getSession()`, then applies the biometric lock
and any owed AAL1→AAL2 challenge; **any hydrate failure fails closed to sign-in**. There is exactly
**one** `onAuthStateChange` subscription app-wide. There is **no** `startAutoRefresh`/`stopAutoRefresh`
AppState wiring — refresh relies on supabase-js internals; foreground resume runs through `useSync`.

Writes go to `/api/v1` with `Authorization: Bearer <access_token>` and `X-Organization-Id`. **Reads
bypass the server**: mobile queries PostgREST directly with the user JWT under RLS. That asymmetry is
why the RLS closure (migration 0310) was necessary rather than optional.

A behaviour discovered on the device and worth recording, because the whole mobile half turns on it:
auth-js 2.105.1's `handleError` singles out `session_not_found` and rethrows it as
`AuthSessionMissingError`, whose constructor passes `undefined` for the code. The exact case this
feature depends on reaches the app as `{ name: 'AuthSessionMissingError', code: undefined, status: 400 }`.
A code-only classifier answers `'unknown'` to it. Also, on relaunch auth-js discards a revoked session
inside its own `initialize()` before `getSession()` returns, so the hydrate sees no session at all.

### 1.5 The role model

- `ROLES = ['owner','admin','manager','staff','viewer']` (`packages/core/src/constants/roles.ts`);
  SQL rank ladder owner=100 / admin=80 / manager=60 / staff=40 / viewer=20 in `has_org_role`
  (migration 0177).
- Configurable permissions (migration 0207): `role_default_permissions` (global mirror of the TS
  `ROLE_PERMISSIONS`), `role_permission_overrides` (per org, per role) and `user_permission_overrides`
  (per org, per user; beats role), resolved by `has_permission(org, perm)`. **Owner is
  short-circuited always-true**, so an org can never lock itself out.
- Membership is `organization_members`, and `accepted_at IS NULL` means a pending invite. All three
  RLS membership helpers require `accepted_at` non-null, which is why **membership removal was the
  de-facto lockout before this feature**.

### 1.6 The God-Admin authorization boundary

A platform admin is identified **solely by a deploy-time env allowlist, never a database table**:
`isPlatformAdmin(email)` splits `STOCKPILOT_PLATFORM_ADMIN_EMAILS` (comma-separated, normalized to
trimmed lowercase by the env schema). Empty or unset env means zero platform admins. The code comment
states the intent explicitly: **no DB write can ever escalate an account to god-mode.**

Authorization is gated on the **verified auth email** from `supabase.auth.getUser()`, never
`user_profiles.email` — users can update their own profile row, and migration 0177's
`pin_user_profile_email` trigger silently reverts any attempt to change that column anyway.

Two gates:

- **Pages:** `requirePlatformAdmin()` — signed-in session + allowlisted verified email + **AAL2**; any
  failure calls `notFound()` (404, never 403, so the console's existence stays hidden). Applied in the
  `(platform)` group layout and re-applied in page bodies, because layout and page render in parallel.
- **Actions:** `checkPlatformAdmin({ requireStepUp })` — additionally requires a **fresh step-up**:
  `mfaAssertionAgeFromToken` parses the JWT `amr` claim for the latest TOTP assertion and requires an
  age ≤ `STEP_UP_MAX_AGE_SECONDS` (15 minutes). `amr` timestamps are not bumped by token refresh.
  Stale or unknown returns `reason: 'aal2_required'`, which drives the existing `useStepUp()`
  prompt-and-retry loop.

Both new actions sit on the step-up tier. The **service does not trust the wrapper**: `disableUserAccount`
and `reenableUserAccount` re-resolve the actor's verified email from GoTrue (`auth.admin.getUserById`)
and re-check the allowlist themselves, and they accept only the actor's *id* from the caller. What they
cannot re-derive from a user id — step-up freshness — stays the wrapper's job.

The console is **web-only**. There is no mobile and no `/api/v1` platform-admin surface, so the
repo's "every web feature ships to mobile too" rule is waived for the admin action and honoured for
the disabled *screen*.

### 1.7 What account-status behaviour existed before this branch

**None.** The audit verified this against the production schema and every migration:

- No account-status column on `user_profiles`, `organization_members`, `organizations` or
  `customer_users`.
- `auth.users.banned_until` existed but had **zero references anywhere in the repo** — no
  `auth.admin.updateUserById` call existed at all.
- `user_profiles.deleted_at` (migration 0171) is a write-once self-delete tombstone, never read at
  auth time.
- No 'account disabled' error code, copy, screen or UI, on either platform. No maintenance-page or
  org-suspended precedent of any kind.
- No RLS-level status enforcement, so direct PostgREST access from a live token had no kill switch.
- No admin-scoped session revocation. Migration 0213's functions are `auth.uid()`-self-scoped;
  auth-js 2.105.1 has no signOut-by-user-id; and the one existing by-user-id call —
  `admin.auth.admin.signOut(removedUserId, 'global')` in `TeamService.removeMember` — passed a bare
  UUID where the API requires a JWT. **Member removal had never revoked a session.** That
  pre-existing bug is fixed on this branch as a side effect of building the real primitive.

The only pre-existing gates were membership existence, the org MFA policy gate, and the platform-admin
env allowlist.

### 1.8 The architectural root cause the feature had to solve

There was **no single chokepoint**. The audit's minimum covering set was two functions
(`loadSessionAndContext` + `withApiContext`), and middleware could not help because its matcher
excludes `/api` and it verifies JWTs locally anyway. The shipped implementation found that two was
still not enough:

| # | Funnel | How it resolves identity | Why it is separate |
|---|---|---|---|
| 1 | `loadSessionAndContext` (`lib/auth/session.ts`) | reads the proxy-set headers | all RSC pages + all org Server Actions |
| 2 | `withApiContext` (`lib/auth/api-context.ts`), both branches | live `getUser()` per request | cookie API + Bearer `/api/v1` |
| 3 | `resolvePortalContext` (`server/services/portal.ts`) | its own `createClient()` + `getUser()`, then reads with `createAdminClient()` — RLS bypassed | the B2B portal inherits nothing from 1 or 2 |
| 4 | QuickBooks / Sage Intacct OAuth callbacks | own `createClient()` + `getUser()` | could activate a connection with Vault writes and an audit row attributed to a disabled user |
| 5 | `changePasswordAction` | bare `getUser()` | a disabled user could otherwise rotate their own password |
| 6 | PostgREST itself | JWT signature only | **the big one** — no policy referenced `disabled_at`, so a live token authorized full CRUD on every business table |

Funnels 3-6 were each found by an adversarial sweep after the first three install points shipped, not
by the plan. Funnel 6 is closed by migration 0310.

---

## 2. Permission matrix

Grounded in the gates that shipped, not in the design's aspiration. Two things the design proposed
were deliberately **not built**: the org Team page Status column was left untouched
(`team-manager.tsx` is not in this branch's diff), and the mobile admin Users screen was left
untouched (it selects `id, full_name, avatar_url, email` and nothing else).

| Principal | View account status | View the internal reason | Disable | Re-enable | View disable/re-enable audit history |
|---|---|---|---|---|---|
| Org **owner** | No product surface shows it | No | No | No | No |
| Org **admin** | No product surface shows it | No | No | No | No |
| Org **manager** | No product surface shows it | No | No | No | No |
| Org **staff** | No product surface shows it | No | No | No | No |
| Org **viewer** | No product surface shows it | No | No | No | No |
| **Custom-permission grantee** (0207 role or user override) | No — no permission exists that grants it | No | No — the capability is not in the 0207 system at all | No | No |
| **B2B portal customer** (`customer_users`) | No | No | No | No | No |
| **Platform admin** (env allowlist + AAL2) | Yes — `/platform/orgs/[id]?tab=users` chip | Yes — `/platform/audit` Reason column, and `user_profiles.disabled_reason` via service role | Yes — `disableUserAccountAction`, `checkPlatformAdmin({ requireStepUp: true })`, refused for allowlisted targets | Yes — same gate, and never refused for allowlisted targets | Yes — `/platform/audit` |

**Enforcing mechanism, cell by cell:**

- **Status chip.** `getOrgMembers` (`server/services/platform/orgs.ts`) joins
  `user_profiles.disabled_at` through a `createAdminClient()` (service-role) query, rendered by the
  org-detail Users tab. That whole route is behind `requirePlatformAdmin()` in the `(platform)` layout
  **and** re-gated in the page body; a non-admin gets `notFound()`.
- **Reason.** Two stores: `user_profiles.disabled_reason` (written by the service role only) and
  `platform_admin_audit.detail.reason`. `platform_admin_audit` has **RLS enabled with zero policies**
  (prod-verified), so only the service-role console can read it. `auditDetailReason()` is the single
  predicate the audit page uses.
- **Disable / re-enable.** `apps/web/src/server/actions/platform/users.ts`. Gate:
  `checkPlatformAdmin({ requireStepUp: true })` on both. Defence in depth in
  `server/services/platform/account-status.ts`: the actor's email is re-resolved from GoTrue and
  re-checked against the allowlist, so a future caller that forgets the gate cannot hand anyone
  god-mode.
- **Protected targets.** Disable refuses **every** allowlisted email (`PROTECTED_ADMIN_ACCOUNT`). One
  rule covers three requirements: no self-disable, no disabling a peer god admin, and the last god
  admin can never be locked out — no "is this the last one" counting is possible or needed, because
  the allowlist is deploy-time env and cannot shrink at runtime. **Re-enable is deliberately NOT
  symmetric**: it has no protected-admin refusal, because a user disabled *before* being allowlisted
  would otherwise be permanently unrecoverable. Always restorable, never removable.
- **Audit history.** `/platform/audit` only, service-role read, six columns (When, Actor, Action,
  Target user, Reason, Target org). The target email is resolved at read time in one batched lookup
  and falls back to the uuid, so a failed name lookup can never blank out the trail.

**The disable capability is deliberately NOT in the 0207 configurable-permission system.** God-mode is
env-allowlist-only by explicit design ("no DB write can ever escalate an account to god-mode"), and a
DB-grantable disable permission would break exactly that invariant. No pgTAP permission count changes
as a result.

### 2.1 One honest caveat on "no org surface shows it"

The table above describes the **product surfaces**. The **database boundary is wider than the UI**:

`user_profiles_select_orgmates` (`supabase/migrations/0003_rls.sql:33-45`) is a row-level policy with
no column restriction. Postgres RLS filters rows, not columns. So an authenticated org-mate holding a
valid token could read `disabled_at`, `disabled_reason` and `disabled_by` for a co-member by querying
PostgREST directly — even though nothing in the web or mobile product ever selects those columns.

**This was subsequently probed, it reproduced, and it is now fixed.** The paragraph above originally
ended by conceding it was read from the policy text and *"not confirmed with a live probe"*. It has
since been confirmed with one: a plain `staff` member read a disabled colleague's full internal reason
and the God Admin's uid, both by naming the columns and via `select *`. **Migration 0311** closes it
with column-level `SELECT` privileges — see **§5.4** for the mechanism and the trap in it, and §8.10
for the disposition.

So the corrected statement of the boundary is: an org-mate can still see **that** a co-member is
disabled (`disabled_at` is deliberately retained — the enforcement guard reads it as the user), but no
longer **why**, and no longer **who** did it. Those two columns are now readable only by `service_role`.

The same policy also inlines its own membership check rather than calling one of the fifteen helpers
migration 0310 guards, so it is one of the roughly 25 inline-membership policies that a still-tokened
disabled user retains until their access token expires.

---

## 3. State-transition matrix

`ACTIVE` means `user_profiles.disabled_at IS NULL`. `TEMPORARILY_DISABLED` means it is non-null — any
non-blank value, including a future one, because a clock-skewed or hand-written timestamp must fail
closed (`isAccountDisabled` in `@stockpilot/core`).

### 3.1 The two headline transitions

| | ACTIVE → TEMPORARILY_DISABLED | TEMPORARILY_DISABLED → ACTIVE |
|---|---|---|
| **Authorized actor** | Platform admin only: `checkPlatformAdmin({ requireStepUp: true })` (allowlist + AAL2 + TOTP assertion ≤ 15 min), re-verified in the service against the actor's GoTrue email | Identical gate. Step-up is kept even though re-enable only *grants* access — the impersonation precedent leaves only access-REMOVING actions un-gated |
| **Required reason** | **Mandatory.** `disableReasonSchema`: category always required from a fixed taxonomy of six; free-text notes additionally required when the category is `other`; 500-character cap. Parsed by the dialog **and** re-parsed by the service, so a client cannot bypass it. Flattened server-side by `composeDisabledReason` | **None.** No reason field on re-enable |
| **Session effect** | 1. GoTrue ban `ban_duration: '876000h'` (~100 y) — blocks sign-in, token refresh and every `getUser()`. 2. `admin_revoke_user_sessions` deletes all `auth.sessions` rows; `auth.refresh_tokens` cascade. 3. Broadcast `user:{id}:sessions` / `revoked` with `{ keepId: null, reason: 'account_disabled' }` | Ban lifted (`ban_duration: 'none'`). **No revocation, no broadcast.** The sessions the disable killed stay dead — the user signs in again, which mints a fresh one |
| **Data effect** | Writes exactly four things: `user_profiles` (3 columns), `auth.users.banned_until`, deleted `auth.sessions` rows (pure session state), one `platform_admin_audit` row. Memberships, stock, orders, movements, POs, cycle counts and billing are never touched | Clears the same 3 columns, lifts the ban, writes one audit row |
| **Audit event** | `platform_admin_audit.action = 'user_disabled'`, `detail = { reason, reason_category, sessions_revoked, sessions_revoke_ok, banned, already_disabled }` | `action = 'user_reenabled'`, `detail = { ban_cleared, already_active }` |
| **User-facing behaviour** | **Web:** next page render or Server Action redirects to `/account-disabled` with the owner-approved copy; a sign-in attempt lands on the same screen. **Mobile, connected:** the disabled screen appears within seconds via the broadcast. **Mobile, relaunched or offline:** the sign-in screen, and the sign-in attempt produces the disabled screen. Queued offline work is terminally rejected on both paths | Nothing is shown. The user signs in normally and the app resumes with the same org and the same data |

### 3.2 Every other (state, action) pair

| Current state | Action | Result | Enforcing layer | Audit row? |
|---|---|---|---|---|
| Disabled | Disable again (replay / retry) | CAS matches 0 rows → `alreadyDisabled: true`; ban, revoke and broadcast all **re-run** (self-heal) | service CAS | **Yes** — deliberately. See §3.4 |
| Active | Re-enable (replay / heal) | CAS matches 0 rows → `alreadyActive: true`; `ban_duration: 'none'` applied anyway, healing a stray ban | service CAS | **Yes** — same reasoning |
| Active, ban set by hand (divergent) | Re-enable | Ban lifted even though the CAS matched nothing. Verified live (line 17) | Layer B always runs | Yes |
| Disabled | Sign-in | GoTrue `user_banned` → `signInAction` returns `account_disabled` → the form routes to `/account-disabled` | GoTrue + `isBannedUserAuthError` | `user.sign_in_failed` with `reason: 'account_disabled'` (org audit), plus a `DISABLED_ACCOUNT_LOGIN_BLOCKED` breadcrumb |
| Disabled | Token refresh | Refused. Observed code is `refresh_token_not_found`, not `user_banned`, because the refresh row cascades away on the session delete before the ban can be the reason | 0308 revoke + cascade | No |
| Disabled | Web page / Server Action with a still-valid JWT | `redirect('/account-disabled')` on the very next request, regardless of token validity | install point 1 | No — breadcrumb only |
| Disabled | `/api` (cookie or Bearer) | Uniform `401 {"error":"unauthenticated"}`, byte-identical to the anonymous control | GoTrue ban at `getUser()`, with install point 2 as the backstop | No — breadcrumb only |
| Disabled | B2B portal | `resolvePortalContext` returns null — treated as "not a portal user". **No portal-specific disabled screen exists** | install point 3 | No |
| Disabled | QuickBooks / Sage Intacct OAuth callback | Refused, mapped onto each route's own `forbidden` redirect vocabulary | install point 4 | No |
| Disabled | `changePasswordAction` | `forbidden` with the disabled copy, **before** the rate-limit budget is spent | install point 5 | No |
| Disabled | Direct PostgREST read or write with a live JWT | Refused for SELECT/INSERT/UPDATE/DELETE from the moment the flag is written, wherever the policy routes through one of the 15 guarded helpers | migration 0310 | No |
| Disabled | `PATCH /rest/v1/user_profiles {"disabled_at": null}` on self | **Silently reverted.** Returns 200, changes nothing; `full_name` in the same body still applies | migration 0309 pin trigger | No |
| Disabled | Org `removeMember`, role change, warehouse or charter edits | Unaffected — memberships are preserved by design | n/a | Existing `user.deactivated` etc. |
| Disabled | Platform `deleteUser` | Unaffected. Delete supersedes disable | existing flow | Existing |
| Disabled | Picking claim / cycle-count assignment RPCs | Refused — `user_can_access_inventory` and `user_can_see_item_category` are guarded (found late; see §3.5) | migration 0310 | No |
| **Protected admin** (allowlisted email) | Disable | Refused **before** the CAS: `PROTECTED_ADMIN_ACCOUNT`, `disabled_at` untouched | service, against the verified GoTrue email | **No** |
| Protected admin | Re-enable | **Allowed** — the asymmetry is deliberate (§2) | — | Yes |
| Any | Status read fails (DB error) | **Denies**, but never renders the disabled experience: web throws `AccountStatusUnavailableError` → the "Something went wrong / Try again" boundary; API returns 5xx, which mobile words as retryable; mobile's own gate uses a third `unverified` state | `resolveAccountStatus` / `accountIsDisabledOrThrow` | No — the failure is reported to the error reporter |

### 3.3 Concurrency

- **The CAS is the linearization point.** The guarded update
  (`.eq('id', …).is('disabled_at', null).select('id')`, and its inverse for re-enable) is a real
  conditional UPDATE, and the returned rows are checked — an unchecked `.update().eq()` that matched
  nothing is this repo's classic fail-open bug. Postgres row-level locking serializes concurrent
  presses; exactly one winner exists.
- **Convergence rule.** Both actions always execute their Layer B step even on a CAS miss, and disable
  re-runs revoke and broadcast on a miss. Any partial failure or interleaving is repaired by pressing
  whichever button matches the intended end state. No manual SQL is ever needed.
- **Fail-closed ordering.** Flag first, ban second, revoke third, broadcast fourth, audit last. A
  crash mid-sequence leaves the account at least as locked as the completed prefix, because Layer A is
  what all six enforcement points read.
- **A lost CAS is reported as `ACCOUNT_STATUS_CHANGED` → `conflict`, never `forbidden`.** The actor's
  allowlist membership was verified before the write, so telling a god admin "not authorized" for a
  race would send them hunting a permissions problem that does not exist.
- **Residual race, documented and accepted:** a disable and a re-enable racing can commit their CAS in
  one order and their Layer B writes in the other, leaving flag and ban divergent for one interleaving
  window. **App access always follows the FLAG**, and the next press of either button heals Layer B.
  With a single-digit god-admin population behind a 15-minute step-up, `pg_advisory_xact_lock(hashtext(user_id::text))`
  is the available upgrade if the owner rejects this.

### 3.4 Why a replay writes a second audit row

Pressing Disable on an already-disabled account writes a **second** `user_disabled` row, marked
`already_disabled: true`. This contradicts the e2e scenario's wording and is deliberate.

The earlier implementation short-circuited the audit write on the healing path. That is what turned a
*lost* audit row into a *permanently* lost one: the first press came back partial
(`ban_not_applied` + `not_audited`), the operator was told to press Disable again, and the second
press forced `audited = true`, reported a clean success, and left the `user_disabled` row missing
forever. Re-recording is the only thing that makes the advertised retry able to close the gap. The
owner ruled in favour of the implementation; the alternative on the table is a distinct
`user_disable_replayed` action so a genuine disable stays countable as one row.

### 3.5 Partial results are surfaced, never laundered

`ACCOUNT_STATUS_PARTIAL_REASONS` = `ban_not_applied` | `ban_not_lifted` | `sessions_not_revoked` |
`not_audited`. The action layer maps each to one clause and only promises "press it again" when
**every** named gap is healable (`.every`, not `.some` — the `.some` version told an operator to retry
a set that included a gap the retry could not close). All four are healable today, because the healing
path re-attempts the audit write.

---

## 4. Session-revocation design

### 4.1 Three layers

| Layer | Mechanism | What it actually stops | Failure posture |
|---|---|---|---|
| **A — the flag** | `user_profiles.disabled_at` | Every web page, Server Action, API route, the portal, the two OAuth callbacks, password change, and (via 0310) PostgREST itself | Authoritative. Written first, and it survives a Layer B failure |
| **B — the ban** | `auth.users.banned_until` via `auth.admin.updateUserById(id, { ban_duration: '876000h' })` | New sign-ins, token **refresh**, and the live `getUser()` that every `withApiContext` request performs. Also covers B2B `customer_users`, who are real auth users outside the org-member model | Reported as `ban_not_applied`; heals on retry |
| **C — revoke + evict** | `admin_revoke_user_sessions` (0308) + a broadcast on `user:{id}:sessions` | Kills the sessions outright and tells live devices immediately | RPC outcome returned as `ok`; broadcast is best-effort and never fails the call |

### 4.2 How existing sessions are invalidated

`public.admin_revoke_user_sessions(p_target_user_id uuid) returns setof uuid` — SQL, SECURITY DEFINER,
`search_path = auth, pg_temp`, body `delete from auth.sessions where user_id = p_target_user_id
returning id`. EXECUTE is revoked from `public`, `anon` and `authenticated`, then granted to
`service_role` only, so a user-authed client cannot reach it at all.

This exists because there was no alternative:

- migration 0213's `revoke_my_session` / `revoke_my_other_sessions` are `auth.uid()`-scoped, so an
  admin cannot use them against another user;
- auth-js 2.105.1 has **no** signOut-by-user-id — its `signOut(jwt, scope)` takes a JWT, which is
  why `TeamService`'s `admin.auth.admin.signOut(removedUserId, 'global')` could never have worked;
- `createAdminClient()` cannot run raw SQL against the `auth` schema.

`auth.refresh_tokens.session_id` cascades on the delete, so the refresh tokens disappear with the
session. `TeamService.removeMember` now routes through the same helper, closing a pre-existing bug in
which member removal recorded `session_revoked: false` every single time.

The wrapper (`server/services/platform/sessions.ts`) returns `{ ok, sessionIds }` rather than throwing:
both callers have already committed their authoritative change by the time they get here, so a throw
would abandon their audit trail mid-flight. Every caller records the outcome.

### 4.3 How old tokens are rejected

- **GoTrue endpoints** (sign-in, refresh, `getUser`): the ban rejects them. Refresh additionally fails
  because the token row is gone.
- **`/api` and `/api/v1`:** `withApiContext` performs a live `getUser()` on both branches, so the ban
  bites on the very next request. Layer A runs in parallel with the membership query as a backstop for
  the window where the flag landed but the ban write did not — deliberately in `Promise.all`, because
  `pickActiveMembership` returns before touching `user_profiles` whenever `X-Organization-Id` is
  present, which is every mobile request.
- **Web pages:** Layer A. The middleware's local `getClaims()` verify would otherwise accept the token
  until `exp`.
- **PostgREST / Realtime / Storage:** these never consult GoTrue. Migration **0310** is what stops
  them, by putting the `disabled_at` check inside the membership gate helpers so all 261 policies
  inherit it (§5).

### 4.4 How web refresh behaves

`updateSession()` refreshes over the network when the token is within 90 s of expiry. Post-disable
that refresh fails (`refresh_token_not_found`), the cookies are cleared, and the user is bounced to
`/signin`. But refresh is not the load-bearing path — Layer A redirects to `/account-disabled` on the
very next page render or Server Action, whatever life the token has left. Verified: a member's
already-open browser tab landed on `/account-disabled`, and navigating to `/dashboard/inventory`
while disabled goes there in a single hop with no loop.

### 4.5 How Expo resume behaves

Four paths can move the mobile gate, and only two can confirm a disable:

1. **Cold launch / session restore** — the hydrated session probes and gets `'signed-out'`, not
   `'disabled'`. The device signs out locally and lands on **`/(auth)/sign-in`**.
2. **Sign-in** — GoTrue answers `user_banned` to a disabled user's password grant. **This is the one
   path that can still confirm a disable outright**, and it is where every offline or relaunched
   device converges.
3. **Any protected request that 401s** — `api()` rings a pure unauthorized bus, which kicks off one
   `supabase.auth.getUser()` probe. Post-revocation this also answers `'signed-out'`.
4. **The live eviction broadcast** — the online fast path. The payload names the reason, and the gate
   believes it **only once the probe has corroborated that the session really is gone**
   (`gateForRevocation`). `gateForRevocation(claims=true, probe='active')` returns null: a forged
   reason is refused.

All four funnel into the same gate state, and the eviction runs exactly once per transition into
`disabled`. Keeping the outbox rejection on the **transition** rather than on either discovery path is
deliberate — wiring it to only one of them is precisely the bug the e2e run found.

The eviction sequence is fixed and fail-safe (it never rejects; it returns which steps failed):
abort in-flight requests → clear credentials → wipe caches → clear account-scoped storage
(`workspace.*` only; device preferences like the scanner tip are left alone) → reset navigation last.
Requests are cancelled *before* credentials are cleared so nothing lands afterwards and repopulates a
cache the eviction just wiped.

### 4.6 How offline actions are handled

Both outbox engines terminally reject, and they agree on the verdict through one shared classifier:

- `sync.ts::drainQueue` → `markRejected`; `CycleCountSyncEngine` → `outboxReject`, which clears
  `cycle_count_lines.local_dirty` in the same transaction as the status write.
- `classifyDrainFailure` treats exactly one combination as terminal: a **401 raised while the client
  already knows the account is disabled**. Everything else stays retryable, because the outbox holds
  real warehouse work. The verdict keys off the numeric HTTP status only, never `ApiError.code`.
- `rejectAllPending(ACCOUNT_DISABLED_REJECTION)` runs at the gate transition, so rows go terminal even
  if no drain tick happened to fire.
- `'rejected'` is excluded from `listPending()`, so rejected rows are no longer live work and cannot
  replay after a re-enable — structurally, not by timing.
- Rows are **preserved**, carrying "Account disabled: this queued change was never sent." Eviction
  calls `rejectAllPending()` **before** `wipeForSignOut()`, and the wipe spares rejected rows —
  otherwise the rows this feature preserves for the user would be deleted by the same eviction that
  created them.
- No `SCHEMA_VERSION` bump: a bump drops the outbox.

### 4.7 How re-enable affects old sessions

It does not resurrect them, and that is verified on both surfaces. Web: `/dashboard` after a re-enable
bounced to `/signin?redirect=%2Fdashboard`; after signing in it rendered with the same identity.
Mobile: relaunching produced the signed-out screen, not a restored session; after signing in the home
screen showed the same org and the same data. Re-enable performs no revocation and sends no broadcast,
because it only grants access.

### 4.8 The honest limitation the end-to-end run forced

**A revoked client cannot read its own account status.** This is not a shortfall being excused; it is
a property of the system.

The disable revokes sessions before anything else can happen. From that moment the device is mute: its
own `getUser()` answers `session_not_found` (which auth-js converts into an `AuthSessionMissingError`
with **no code at all**), and once the access token lapses the refresh answers
`refresh_token_not_found`, because the refresh row cascaded away with the session. **`user_banned` is
unreachable on every path that runs against a revoked session.** The first implementation accepted
only `user_banned` as proof, so the mobile disabled screen never appeared at all, the outbox was never
rejected, and the device drifted to the generic marketing screen.

The shipped design does not fake the distinction:

- **Connected device:** the eviction broadcast carries a fixed reason enum
  (`SESSION_REVOKED_REASON_DISABLED = 'account_disabled'`). The device reaches the disabled copy
  immediately. **That channel is public (`private: false`) and therefore forgeable**, so the reason is
  never trusted alone — the probe must corroborate that the session really is gone, and a forged
  reason against a healthy session is refused. The payload carries the enum and nothing else: never the
  operator's reason text, never the category, never the actor, never a timestamp. The field is purely
  additive — the two older broadcasters (global sign-out, password reset) still send the bare
  `{ keepId }` shape, and a payload without a `reason` behaves exactly as it always did.
- **Relaunched or offline device:** a 403 means "your session is gone", which justifies a local
  sign-out and the **sign-in screen** — and nothing more, because an ordinary sign-out-everywhere from
  another device produces the identical code. **The user therefore reaches the disabled copy after one
  sign-in attempt**, which is where GoTrue finally answers `user_banned`. One extra tap, and it is
  honest: the device genuinely does not know yet.

Both paths converge on the same gate transition, so the outbox rejection happens either way — confirmed
on the device for both.

---

## 5. Database changes

Three migrations, all additive, none pushed to any hosted project.

### 5.1 Migration 0308 — `0308_account_disable.sql` (78 lines)

**Columns.** `alter table public.user_profiles add column if not exists`:

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `disabled_at` | `timestamptz` | yes | none | NULL = active. Non-null = disabled. The single app-level source of truth |
| `disabled_reason` | `text` | yes | none | Category, plus notes when the category is `other`. Service-role visible; never shown to the disabled user |
| `disabled_by` | `uuid` | yes | none | Actor's auth uid. Attribution also lands in `platform_admin_audit` with the actor email |

All three carry `comment on column`. **No `NOT NULL`, no defaults, no FK on `disabled_by`, and no
index in 0308** — both readers fetch the row by primary key, mirroring migration 0171's
"not a hot-path filter" posture. (0310 later adds a *partial* index for a different reason; see 5.3.)

**Constraint.** `platform_admin_audit_action_check` is dropped and re-added with all **nine**
pre-existing values restated plus `user_disabled` and `user_reenabled`. The nine were read back out of
the database with `pg_get_constraintdef` at 0307, not copied from a migration file. Precedent:
migration 0241 did the same to add two actions. This is the CHECK-constraint analogue of recurring bug
#24 (`alter policy … with check` REPLACES rather than adds) — omitting a value silently breaks an
existing god-mode action at insert time. 0308's pgTAP asserts each old value still inserts.

**Function.** `public.admin_revoke_user_sessions(p_target_user_id uuid) returns setof uuid`, SQL,
SECURITY DEFINER, `set search_path = auth, pg_temp`. EXECUTE explicitly revoked from `public`, `anon`
and `authenticated` (Postgres grants to PUBLIC by default and Supabase's default privileges add
anon/authenticated), then granted to `service_role` alone.

**Backfill:** none. A null `disabled_at` **is** the active state, so every pre-existing profile stays
active untouched.

### 5.2 Migration 0309 — `0309_pin_user_profile_disable_flags.sql` (117 lines)

**What it stops:** a disabled user un-disabling themselves. `0003_rls.sql`'s
`user_profiles_update_self` is row-scoped with **no column restriction**, and PostgREST/RLS never
consult GoTrue — so a disabled user's still-valid access token could `PATCH
/rest/v1/user_profiles?id=eq.<self> {"disabled_at": null}` and clear Layer A. The console, reading the
same column, would report them active. The feature was defeatable by exactly the person it exists to
stop. **This was verified end-to-end over HTTP**: the attack PATCH returns 200 and changes nothing
while `full_name` in the same body still applies, and dropping the trigger reproduces the hole.

**The fix:** `tg_pin_user_profile_disable_flags()` + a `before update … for each row` trigger. It
**silently reverts** the three columns for any caller outside the allowlist — matching migration 0177's
`pin_user_profile_email` precedent. Raising an error would name the guarded column and tell an attacker
precisely what to probe for.

**Correction, 2026-07-31 — the `WHEN` clause is gone.** The first cut scoped the trigger with
`when (new.disabled_at is distinct from old.disabled_at or …)`, so it never fired for any other column
and a **disabled** user kept write access to the rest of their own row. Reproduced live: as role
`authenticated` with a disabled profile, `update user_profiles set full_name='DEFACED'` returned
`UPDATE 1` and stuck. `user_profiles` is not a private row — `full_name` and `avatar_url` are embedded
into every colleague's UI through `user_profiles!<fk> (full_name, avatar_url)` (team list, order
timeline actor, cycle-count assignee, movement actor, procedure author), so a user disabled for
suspected compromise could deface their identity **org-wide** for the remaining ~1h of their access
token, with the same token 0310 refuses everywhere else. The trigger now fires on every update and takes
one of three paths: an allowlisted role passes through untouched; **a row whose `disabled_at` is set has
the whole update dropped** (`return null` — no write at all, proven by a `RETURNING` row count of zero
in pgTAP); an active row has only the three disable columns pinned, so ordinary profile editing is
untouched. `supabase/tests/0309_*.test.sql` asserts both halves and pins `pg_trigger.tgqual IS NULL` so
the `WHEN` clause cannot come back.

**The rest of the self-scoped write class** (`saved_views`, `notification_preferences`, `push_tokens`,
`notifications`, `user_onboarding`) survives a disable the same way, because those policies are a bare
`<col> = auth.uid()` and reach no membership helper. Assessed one at a time: the four preference tables
are genuinely private — a disabled user toggling their own digest opt-in, device token, read flag or
tour progress changes nothing anyone else can see, and each carries a `WITH CHECK` of
`user_id = auth.uid()` so it cannot be aimed at another row — and they are **deliberately left alone**.
`saved_views` is not private: 0037's `is_shared` shows a row to the **whole org**, so a disabled user
could plant or re-share an org-visible view. Its three write policies are restated in 0310 (dropped and
recreated in full — never `alter policy … with check`, recurring bug #24) with
`is_org_member(organization_id)` added, which brings the disable guard **and** fixes the missing org
constraint the bare `user_id = auth.uid()` `WITH CHECK` left open.

**Why `current_user`, not `auth.role()`** (measured with real connections per role, not assumed):
`auth.role()` reads the `request.jwt.claims` GUC, which only PostgREST sets, so it is NULL on every
direct connection — an `auth.role()` rule would have to treat NULL as "allow", which is fail-OPEN.
`current_user` is set by Postgres itself, is never null, and is what PostgREST switches per request.
The allowed set is an **allowlist** (`service_role`, `postgres`, `supabase_admin`), so an unrecognised
role reverts; a denylist would silently grant write access to any request-facing role added later.
`postgres` is required or 0308's own pgTAP breaks.

### 5.3 Migration 0310 — `0310_rls_blocks_disabled_accounts.sql` (681 lines)

**What it stops:** the largest hole in the feature. No policy anywhere consulted `disabled_at`, so for
as long as an already-issued access token stayed signature-valid, a disabled user could talk straight
to `/rest/v1` and RLS would authorize the full CRUD surface of the product. The design document
previously called this exposure "read-only, because all mobile writes go through Bearer /api/v1" —
that describes *our* client, not an attacker holding the token. **The exposure was read AND write.**

**The predicate.** `public.account_is_disabled(p_user_id uuid) returns boolean`, SQL, **STABLE**,
SECURITY DEFINER, `search_path = public, pg_temp`; **EXECUTE granted to `service_role` only**.
Takes the user id as a parameter rather than reading `auth.uid()` internally, because
`user_can_access_warehouse` is itself parameterised by user id. Deliberately **not STRICT**: a null id
must answer FALSE, and `exists()` always returns a real boolean. A **missing profile row also reads
active**, matching `isAccountDisabled()` in `@stockpilot/core` — absence of a profile is an onboarding
state, not a disable.

**Correction, 2026-07-31 — the grant was an unauthenticated oracle.** The first cut wrote
`grant execute … to authenticated, anon, service_role`, which also leaves **PUBLIC** holding EXECUTE
(Postgres grants EXECUTE to PUBLIC on every new function and a later GRANT does not subtract it): the
live ACL was `=X/postgres,postgres=X,anon=X,authenticated=X,service_role=X`. Probed on the local stack:
as role `anon`, `select count(*) from user_profiles where id = '<uuid>'` returns 0 (every `user_profiles`
policy is `to authenticated`), but `select account_is_disabled('<uuid>')` returned `true` — so anyone
holding `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, which ships in every web bundle and mobile binary, could
POST `/rest/v1/rpc/account_is_disabled` and read a named individual's disable timeline with no
credential. User ids are not secret: they appear in audit-trail cells, notification payloads, the
eviction channel name `user:{id}:sessions`, and any row carrying `created_by`. 0310 now does
`revoke all on function … from public, anon, authenticated;` + `grant execute … to service_role;`,
matching 0308's treatment of its own helper and 0230's `rls_manager_org_ids()`. `authenticated` is
revoked too, not just `anon`, because the same call answers for uuids in orgs the caller has no
membership in — a cross-tenant read RLS otherwise refuses.

**Nothing needed the grant, and that is proven rather than assumed.** The Group A helpers call the
predicate as the **definer** (they are themselves SECURITY DEFINER owned by `postgres`, so the nested
call is checked against `postgres`, not the request role), the Group B helpers inline the predicate
instead, no policy references it directly, and no application path RPCs it. The pgTAP asserts both
halves: that `PUBLIC`/`anon`/`authenticated` hold no EXECUTE, and that **every** guarded helper still
answers correctly for an authenticated caller *after* the revoke.

> **pgTAP landmine.** Do not assert the refusal with `throws_ok(…, '42501')` under a `set local role`.
> On the Supabase CLI local image any function-permission denial raised under a switched role
> **segfaults the backend** (`signal 11`), restarting the cluster and killing every later test file with
> "the database system is in recovery mode". It is an image bug, not a migration bug — it reproduces
> identically on `rls_member_org_ids()` (which `anon` has never held EXECUTE on) and on a fresh plain
> SQL function with its PUBLIC grant revoked. The test asks `has_function_privilege(current_user, …)`
> from inside each role instead: same authority Postgres uses at call time, no crash.

**Index.** `create index if not exists user_profiles_disabled_at_idx on public.user_profiles (id)
where disabled_at is not null` — a **partial** index, so in a healthy org it is empty or near-empty and
the per-row probe is a root-page hit on a fully cached relation.

**Fifteen helpers guarded**, so all 261 policies inherit the check without any policy being edited
(editing 261 policies would be 261 chances to hit recurring bug #24):

`is_org_member`, `user_org_role`, `has_org_role`, `has_permission`, `rls_inv_read_full_warehouse_ids`,
`rls_inv_read_assigned_warehouse_ids`, `rls_inv_read_warehouse_charter_ids`,
`rls_cat_unrestricted_org_ids`, `rls_cat_allowed_category_ids`, `rls_member_org_ids`,
`rls_manager_org_ids`, `my_warehouse_ids`, `user_can_access_warehouse`, `user_can_access_inventory`,
`user_can_see_item_category`.

`rls_orgs_with_permission` is the sixteenth and is deliberately **not** given its own check — its body
already calls `has_permission`, so it inherits, and its pgTAP proves the inheritance rather than
trusting it. The rule: a function whose own body reads a membership table is guarded; one that only
delegates is pinned by a test.

Stopping at the two helpers the original finding named would have shipped a fix with large holes still
open: `has_permission` (43 policies) is an independent gate; `inventory_items_select` — the read path
on the largest table in the product — references **none** of the first three; `user_can_access_warehouse`
is the sole gate on all four verbs of `rentals`/`rental_lines`; and `user_can_access_inventory` is the
**sole** authorization check in `claim_picking` (proven live: a disabled admin claimed orders and
persisted `assigned_picker_id` as themselves). `user_can_see_item_category` was found in the re-audit —
the `has_org_role` inside it is a comment, not a call.

**`service_role` is deliberately outside the guard.** It carries no `request.jwt.claim.sub`, so
`auth.uid()` is null and `account_is_disabled(null)` is FALSE. That is load-bearing: the disable
service writes `user_profiles` through `createAdminClient` **while the user is disabled**, and a guard
that caught `service_role` would make the disable irreversible.

**Two forms, on purpose.** Group A (no row-dependent argument) calls `account_is_disabled()` directly
and the planner hoists it into a one-time InitPlan (`loops=1`). Group B (row-correlated:
`has_org_role(organization_id, …)`, `has_permission(organization_id, …)`,
`user_can_access_warehouse(auth.uid(), warehouse_id, …)`) cannot be hoisted and would re-execute per
candidate row — a nested SECURITY DEFINER call cost **3.3x** on a bulk scan (10.2 s → 33.5 s), so those
helpers **inline** the same predicate as a `NOT EXISTS` against the partial index. The duplication is
fenced by tests, not by discipline: the pgTAP asserts every helper in both groups, active and
disabled.

**Measured cost** (500k-row `inventory_items`, `authenticated` role, `EXPLAIN (ANALYZE, BUFFERS)`; full
numbers in `.superpowers/sdd/bypass-closure-report.md`):

| Shape | Before | After | Delta |
|---|---|---|---|
| Paged SELECT (`inventory-list-v2` shape) | 124.2 ms | 124.6 ms | ~0% |
| UPDATE by primary key (the real app write) | 3.81 ms | 4.02 ms | +5% |
| Bulk sequential-scan UPDATE (a shape the app does not issue) | 10.27 s | **13.13 s** | **+28%** |

**Correction, re-measured 2026-07-31.** The table above understated the blast radius by presenting the
regression as write-only. Its paged-SELECT row is an `inventory_items` read, and `inventory_items_select`
is gated entirely by the **Group A** `rls_*` helpers, which the planner hoists to a one-time InitPlan
(`loops=1`). About **70 other SELECT policies gate on a row-correlated (Group B) helper instead** —
`item_stock_levels_select` is `(select is_org_member(item_stock_levels.organization_id))`,
`activity_logs_select` is `(select has_org_role(activity_logs.organization_id,'manager'))`, and the same
shape covers `purchase_order_items`, `order_request_lines`, `cycle_count_lines`, `stock_reservations` and
~65 more. Those pay the disable probe **once per candidate row on reads**, exactly as the bulk UPDATE
does on writes.

Re-measured on the local stack: 500,002 `item_stock_levels` rows in one org; `user_profiles` at 10,001
rows of which 1,112 disabled (so the partial index is populated, not empty); role `authenticated` with
`request.jwt.claim.sub` set; `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF)`. The two helper sets were swapped
back and forth between **every single run** — 8 interleaved pre/post pairs — because measuring one block
and then the other on this stack produces drift of the same magnitude as the effect.

| Shape | Before | After | Delta |
|---|---|---|---|
| `select count(*) from item_stock_levels` — row-correlated SELECT policy, SubPlan `loops=500,002` | 3,556 ms (median) | **4,555 ms (median)** | **+28%** (paired deltas +24%…+49%, median +33%) |

Isolating the helper with a direct row-correlated call on the same fixture: `has_org_role` 3,458 ms →
4,551 ms (+32%), `is_org_member` 1,465 ms → 2,845 ms (+94%). Both are the **same absolute cost** — about
2.2–2.8 µs per invocation, the Index Only Scan on `user_profiles_disabled_at_idx` (`Heap Fetches: 0`).
It reads as +32% or +94% only because `is_org_member`'s body is cheaper to begin with; the percentage is
a property of the helper, not of the guard.

So the honest characterisation is that **any large scan through a Group B helper costs roughly +28% more,
on reads as well as writes** — the same band as the bulk UPDATE, not a separate pathological case. Paged
application queries are unaffected only because they scan a page; a query that scans the table pays per
row. The +28% is stated plainly, not called negligible, and is carried to the owner in §8.

**A completeness caveat.** 0310 closes the *helper-routed* policies. Roughly 25 policies inline their
own membership check rather than calling a helper (`user_profiles_select_orgmates` is one — see §2.1);
those do not inherit the guard. The known consequence is bounded to profile reads within an org, and
the write surface that mattered is covered.

### 5.4 Migration 0311 — `0311_restrict_disable_reason_visibility.sql`

Closes the confidentiality leak 0308 opened. This is the fix for what §8.10 recorded as an unprobed
addendum; it was probed, it reproduced, and it is now closed.

**Lock posture, added 2026-07-31.** `GRANT`/`REVOKE` on a table takes **AccessExclusiveLock** on it for
the whole transaction, and as of this branch **every authenticated request in the product reads
`user_profiles`** (`session.ts`, `api-context.ts`, `account-status.ts`) — the table moved from cold to
the single hottest read path. Postgres lock requests are FIFO, so if any open transaction holds even an
AccessShareLock when the push runs, the AccessExclusive request queues *and every subsequent reader
queues behind it*: a few seconds of blocking becomes a site-wide stall rather than a slow migration. The
work itself is instant (tiny row count); the exposure is purely the lock wait. 0311 now opens with
`set lock_timeout = '5s'` and ends with `reset lock_timeout`, the same precedent as 0295/0298/0303, so
the push fails fast (SQLSTATE 55P03) and is retried instead of pile-driving the request path. 0310 gets
the same treatment for its non-CONCURRENT `create index … on user_profiles` (ShareLock, blocks writes).
On timeout nothing is applied — each migration is a single transaction — so there is no half-applied
state and no window where the blanket grant is dropped without the keep-list being re-granted.

**The leak, reproduced.** `user_profiles_select_orgmates` (0003) returns the **whole row** to anyone
sharing an organization. That was harmless while the row held name/avatar/email. 0308 added
`disabled_at`, `disabled_reason` and `disabled_by` to that same row, and RLS is *row*-level: a policy
that grants the row grants every column in it. Probed on the local stack as a plain `staff` member
reading a `manager` colleague's row:

```text
set local role to 'authenticated';   -- sub = the ordinary colleague
select disabled_reason, disabled_by from public.user_profiles where id = <peer>;

 disabled_reason                                                       | disabled_by
 Suspected account compromise — notes: credential stuffing from        | 0311beef-…-a3
 203.0.113.44, pending SOC review, do not notify subject               |
```

`select *` returned it too — which is exactly what PostgREST serves for `/user_profiles?select=*`. This
violated the brief on two counts: the internal reason must never reach the disabled user (a colleague is
strictly worse), and the God Admin identity must not be revealed.

**Why column privileges and not a narrower policy.** RLS cannot express this. A policy decides which
*rows* you may see, never which columns of them, so no edit to `user_profiles_select_orgmates` could
hide two columns of a row it is otherwise correct to return. Column-level `GRANT`s sit *below* RLS —
the privilege check fires before any policy is evaluated — so the fix also covers the user's **own** row
via `user_profiles_select_self`, which is what makes "the reason is not shown to the disabled user" true
by construction rather than by the UI declining to render it. Editing the shared policy would also have
been the more dangerous change (recurring bug #24); 0309 declined to narrow this same policy for the
same reason.

**The trap: the obvious spelling is a silent no-op.** Measured, not assumed:

```sql
revoke select (disabled_reason, disabled_by) on public.user_profiles from authenticated;
```

reports `REVOKE`, changes nothing, and the column stays readable — `column_privileges` still showed all
16 columns held and the select above still returned the reason. Postgres treats a table-level `SELECT`
grant and per-column grants as **separate** privileges, and a column revoke cannot subtract from a
table-level one; `authenticated` holds a table-level grant here from Supabase's defaults. So 0311 drops
the table-level grant and re-grants an enumerated 14-column keep-list to `authenticated` and `anon`.
`service_role` is untouched — the platform console reads these columns through `createAdminClient()`.

**`disabled_at` is deliberately retained, and that is load-bearing.** Every enforcement funnel reads it
with the **user's own** client, never the admin client — traced before choosing the keep list:

| # | Funnel | Client for the status read |
|---|---|---|
| 1 | `loadSessionAndContext` (`lib/auth/session.ts:87`) | `createClient()` |
| 2 | `withApiContext` — Bearer (`api-context.ts:232`) / cookie (`:298`) | bearer `createClient` / `createClient()` |
| 3 | `resolvePortalContext` (`services/portal.ts:125`) | `createClient()` — `createAdminClient()` appears at `:145` but only *after* the status read |
| 4 | QuickBooks / Sage Intacct OAuth callbacks | `createClient()` |
| 5 | `changePasswordAction` (`actions/auth.ts:470`) | `createClient()` |

All five resolve through `loadAccountStatus` or the session select, and both ask for
`ACCOUNT_STATUS_COLUMNS = 'disabled_at'` — that column **only**. Neither reads `disabled_reason` or
`disabled_by`. Since the guard now fails **closed**, revoking `disabled_at` would not have weakened it —
it would have locked every user out of the entire product.

**No `select('*')` site had to be fixed.** `select *` on this table now *errors* for these roles
(asserted in pgTAP), so a wildcard read fails loudly rather than quietly. A full sweep of every
`user_profiles` read — 63 `.from()` call sites, every PostgREST embed including the two FK-name embeds
that never spell the table (`audit-log.ts`'s `actor:user_id`, `recovery.ts`'s `deleter:deleted_by`),
plus web, mobile, views and RPCs — found **zero** wildcard reads. Every read names explicit columns, and
every column named is on the keep-list. The eight `user_profiles`-reading functions in 0310 are
`SECURITY DEFINER`, so they bypass column privileges entirely and are unaffected.

**Writes are untouched on purpose.** Only `SELECT` is narrowed. 0309's `tg_pin_user_profile_disable_flags`
already silently reverts writes to these columns from any role outside its allowlist; converting that
into a hard permission error would change 0309's deliberate silent-revert posture and break its test plan.

> **Maintenance landmine.** Because the table-level grant is gone, `authenticated`/`anon` now hold
> `SELECT` on an *enumerated* list. **A column added to `user_profiles` later is unreadable by both
> roles until it is added to that list.** This fails closed on purpose — a new column on a table that
> now carries operator-only fields should be invisible until someone decides otherwise. The 0311 pgTAP
> pins the exact expected column set, so adding a column lands as a red test naming the decision rather
> than as a production read that fails at 3am.

### 5.5 Rollback and recovery

- **All four are additive.** Rolling back the **code** while the migrations stay applied is safe: the
  columns are simply unread, the trigger never fires (nothing writes those columns), and the guarded
  helpers answer FALSE for every non-disabled user, which is every user in a database where nothing
  ever set the flag. 0311 is safe under a code rollback for the same reason — no code path at any
  revision of this branch reads `disabled_reason` or `disabled_by` on a user-authed client.
- **Rolling back the schema is the dangerous direction and must never precede a code rollback**
  (see §9). If it is ever required: drop the 0309 trigger and function; re-create the fifteen helpers
  **from 0177's definitions, not 0001's** — 0177 added the impersonation-expiry semantics, and 0310
  restates them verbatim, so reverting to 0001's bodies would silently reopen the hole 0177 closed;
  drop `account_is_disabled` and `user_profiles_disabled_at_idx`; drop
  `admin_revoke_user_sessions`; restore the CHECK to its nine values (this fails if any
  `user_disabled` / `user_reenabled` row exists — delete or rewrite those rows first); drop the three
  columns.
- **Operator recovery without a rollback:** a stuck or divergent account is repaired by pressing
  Disable or Re-enable again — both actions always run their Layer B step, and the re-enable path lifts
  a stray ban even when the CAS matches nothing (verified live, e2e line 17). No manual SQL is
  expected in any scenario.

### 5.6 Compatibility

| Combination | Outcome |
|---|---|
| Migrations applied + this code | Correct |
| Migrations applied + **old** code | Harmless. The columns are unread, the trigger is dormant, the helpers answer FALSE for everyone |
| **Pre-0308 database** + this code | **TOTAL OUTAGE.** `select('… , disabled_at')` errors, the guard now fails CLOSED, and every page and API route refuses. See §9 |
| 0308 applied, 0309/0310 not | The feature works but is defeatable: a disabled user can clear their own flag (0309's hole) and can reach PostgREST directly (0310's hole). Do not split them |
| 0308 applied, **0311 not** | The feature works, but every org-mate can read the internal reason and the God Admin's uid off PostgREST. This is the leak 0311 exists to close — do not split them |
| 0311 applied + **old** code | Harmless. No code at any revision of this branch reads `disabled_reason`/`disabled_by` on a user-authed client, and `disabled_at` is retained |

### 5.7 Deployment order

**0308 → 0309 → 0310 → 0311, in that order, before any web deploy.** A single
`supabase db push --linked` applies them in numeric order, so no manual sequencing is needed — but the
four must go together, and they must land **before** the build that reads `disabled_at`. Full
deployment requirements in §9.

0311 must not be split from 0308 in particular: 0308 is the migration that puts the reason in a
row every org-mate can read, so any window in which 0308 is applied and 0311 is not is a window in
which the leak is live in production.

---

## 6. Files changed

75 files, +14,792 / −125 (`git diff --stat main...e01d7c7f`). Test files are listed with their
subjects rather than separately.

### Database (4 migrations, 5 pgTAP files)

| File | What it does |
|---|---|
| `supabase/migrations/0308_account_disable.sql` | The three `user_profiles` columns, the `platform_admin_audit` CHECK widen, and `admin_revoke_user_sessions` |
| `supabase/migrations/0309_pin_user_profile_disable_flags.sql` | The pin trigger that stops a disabled user clearing their own flag |
| `supabase/migrations/0310_rls_blocks_disabled_accounts.sql` | `account_is_disabled`, the partial index, and the fifteen guarded gate helpers |
| `supabase/migrations/0311_restrict_disable_reason_visibility.sql` | Column-level `SELECT` privileges that hide `disabled_reason`/`disabled_by` from `authenticated` and `anon` while retaining `disabled_at` (§5.4) |
| `supabase/tests/0308_account_disable.test.sql` | plan(39) — columns, CHECK values old and new, function ACL, search_path |
| `supabase/tests/0309_pin_user_profile_disable_flags.test.sql` | plan(28) — the revert behaves per role |
| `supabase/tests/0310_rls_blocks_disabled_accounts.test.sql` | plan(51) — every helper, both groups, active and disabled |
| `supabase/tests/0311_user_can_access_inventory_disable_guard.test.sql` | plan(39) — the picking-RPC gate found in the re-audit. **Note the number is a misnomer**: this file tests 0310's helpers, not migration 0311. It predates 0311 existing |
| `supabase/tests/0311_restrict_disable_reason_visibility.test.sql` | plan(27) — the grants, the exact readable column set, the org-mate refusal, the disabled user's own row, and the guard's read path |

### Shared vocabulary (`packages/core`)

| File | What it does |
|---|---|
| `packages/core/src/auth/account-status.ts` (new) | The one definition of the codes, the owner-approved copy, the reason taxonomy and zod schema, `composeDisabledReason`, `isAccountDisabled`, the broadcast reason enum and `isDisableRevocation` |
| `packages/core/src/auth/account-status.test.ts` (new) | Pins the copy byte-for-byte and the schema's `other`-requires-notes rule |
| `packages/core/src/index.ts` | Re-export |
| `packages/core/src/types/action.ts` | `ActionErrorCode += 'account_disabled'` |

### Web — the guard (three install points plus two inline funnels)

| File | What it does |
|---|---|
| `apps/web/src/lib/auth/account-status.ts` (new) | The guard module: `AccountStatusState` (`active`/`disabled`/`unreadable`), `resolveAccountStatus`, `loadAccountStatus`, `accountIsDisabledOrThrow`, `assertAccountActiveOrRedirect`, `AccountStatusUnavailableError`, `noteDisabledAccountBlocked` |
| `apps/web/src/lib/auth/account-status.test.ts` (new) | 408 lines covering the three states and the fail-closed posture |
| `apps/web/src/lib/auth/session.ts` | Install point 1 — `disabled_at` rides the existing PK select for free; classifies the read instead of null-checking it |
| `apps/web/src/lib/auth/api-context.ts` | Install point 2 — both branches, status read in `Promise.all` with membership |
| `apps/web/src/server/services/portal.ts` (+ test) | Install point 3 — the B2B portal, which inherits nothing from 1 or 2 |
| `apps/web/src/app/api/integrations/quickbooks/callback/route.ts` (+ test) | Install point 4a |
| `apps/web/src/app/api/integrations/sage_intacct/callback/route.ts` (+ test) | Install point 4b |
| `apps/web/src/server/actions/auth.ts` (+ 3 tests) | The `user_banned` sign-in branch, ordered before the generic invalid-credentials return; and install point 5, `changePasswordAction`, refusing before the rate-limit budget is spent |
| `apps/web/src/server/actions/auth-error-classify.ts` (+ test) (new) | `isBannedUserAuthError` |

### Web — the disable service and actions

| File | What it does |
|---|---|
| `apps/web/src/server/services/platform/account-status.ts` (+ test) (new) | The whole state machine: verified-email resolution, protected-admin refusal, both CASes, Layer B, revoke, audit, partial reporting |
| `apps/web/src/server/services/platform/sessions.ts` (+ test) (new) | `revokeAllSessionsForUser` — the one supported by-user-id revocation, plus the eviction broadcast |
| `apps/web/src/server/actions/platform/users.ts` (+ test) | `disableUserAccountAction` / `reenableUserAccountAction`, the exhaustive code→message table, and the partial-failure wording |
| `apps/web/src/server/services/platform/audit.ts` (+ test) | `recordPlatformAudit` now returns whether the row landed; `PlatformAuditAction` widened; `auditDetailReason`; target emails resolved in one batched lookup |
| `apps/web/src/server/services/platform/orgs.ts` (+ test) | `getOrgMembers` carries `disabledAt` |
| `apps/web/src/server/services/team.ts` | `removeMember` now revokes through 0308 instead of the broken `signOut(userId)` |

### Web — UI

| File | What it does |
|---|---|
| `apps/web/src/app/(auth)/account-disabled/page.tsx` (new) | The blocked-route screen. Inside the `(auth)` route group for chrome only — the URL stays `/account-disabled`, outside the proxy matcher, calling no session helper, so it can never redirect to itself |
| `apps/web/src/components/platform/user-actions-menu.tsx` (+ test) (new) | The console three-dot menu: password reset, Disable, Re-enable |
| `apps/web/src/components/platform/disable-account-dialog.tsx` (+ test) (new) | Category picker, notes, type-the-email confirmation, blast-radius copy |
| `apps/web/src/components/platform/password-reset-button.tsx` (**deleted**) | Replaced by the menu; no importers remained |
| `apps/web/src/app/(platform)/platform/orgs/[id]/page.tsx` | The Disabled chip and the row menu |
| `apps/web/src/app/(platform)/platform/audit/page.tsx` | Target user and Reason columns |
| `apps/web/src/components/auth/sign-in-form.tsx` | Routes `account_disabled` to the screen instead of a toast |

### Mobile

| File | What it does |
|---|---|
| `apps/mobile/src/lib/account-disabled-state.ts` (+ test) (new) | The module-level gate: `ok` / `disabled` / `unverified`, mirroring the web's three states |
| `apps/mobile/src/lib/account-disabled-probe.ts` (+ test) (new) | Classifies a GoTrue probe, including the `AuthSessionMissingError`-with-no-code case |
| `apps/mobile/src/lib/account-eviction.ts` (+ test) (new) | The fixed eviction order, `nextGateForProbe`, `gateForRevocation`, the session-ended latch and the sign-in destination |
| `apps/mobile/src/lib/use-account-gate.ts` (new) | The one place the gate is wired to the device, mounted by RootGate |
| `apps/mobile/src/lib/account-disabled-wiring.test.ts` (new) | Pins the wiring the simulator caught |
| `apps/mobile/src/components/account-disabled-screen.tsx` (new) | The disabled screen, same copy as web |
| `apps/mobile/app/_layout.tsx` | RootGate now mounts both `useSessionRevocation` and `useAccountGate` |
| `apps/mobile/src/components/drawer-content.tsx` | The DrawerContent-only listener mount is **removed** — that was the whole point |
| `apps/mobile/src/lib/use-session-revocation.ts` | Optional `onTargeted` first refusal; forwards the raw payload; stays dumb about the reason |
| `apps/mobile/src/lib/api.ts` (+ test) | Typed `ApiError { status, code }`, the unauthorized bus, in-flight registration |
| `apps/mobile/src/lib/request-cancellation.ts` (+ test) (new) | Aborts in-flight requests at eviction |
| `apps/mobile/src/lib/drain-failure.ts` (+ test) (new) | The shared terminal-vs-retryable verdict both engines use |
| `apps/mobile/src/lib/drain-rejection-wiring.test.ts` (new) | Pins that both engines actually reject |
| `apps/mobile/src/lib/queue.ts`, `sync.ts`, `db.ts`, `cycle-count-sync.ts`, `cycle-count-cache.ts` | `rejected` status, excluded from `listPending`, wipe spares rejected rows |
| `apps/mobile/src/lib/auth-context.tsx` | Cold-launch probe (detached, never awaited — RN fetch has no timeout), sign-in `user_banned` branch |

### Documentation

`docs/superpowers/specs/2026-07-31-account-disable-architecture-audit.md`,
`…-design.md`, `docs/superpowers/plans/2026-07-31-account-disable.md`,
`docs/superpowers/reports/2026-07-31-account-disable-verification.md`, and this file.

---

## 7. Test results

### 7.1 Automated gates — the real numbers, after the fix (`e01d7c7f`)

```
pnpm test
  @stockpilot/core:test:    Test Files  40 passed (40)    Tests   709 passed (709)
  @stockpilot/mobile:test:  Test Files  46 passed (46)    Tests   937 passed (937)
  @stockpilot/web:test:     Test Files 393 passed (393)   Tests  4170 passed (4170)
  Tasks: 3 successful, 3 total   EXIT=0

pnpm typecheck   Tasks: 3 successful, 3 total   EXIT=0
pnpm lint        0 errors, 102 warnings
```

**5,816 tests across the three packages**, up from 5,768 before the mobile fix. The 102 lint warnings
are all pre-existing: mobile was verified at 74 both before and after this work by linting the stashed
tree, and web is the same 28 the original report recorded.

```
supabase db reset && pnpm db:test
  0308_account_disable.test.sql ................................ ok
  0309_pin_user_profile_disable_flags.test.sql ................. ok
  0310_rls_blocks_disabled_accounts.test.sql ................... ok
  0311_restrict_disable_reason_visibility.test.sql ............. ok
  0311_user_can_access_inventory_disable_guard.test.sql ........ ok
  All tests successful.
  Files=108, Tests=1526
  EXIT=0
```

Declared plans read from the files, not assumed: 0308 → **39**, 0309 → **28**, 0310 → **51**,
0311 (picking gate) → **39**.

**`pnpm db:test` was NOT re-run after the mobile fix.** That fix adds no migration and touches no SQL,
so the 108/1526 result above stands unchanged from the run that produced it. Stated rather than
implied.

### 7.1a Re-run after migration 0311 — measured, not carried forward

The whole gate was re-run from a clean `supabase db reset --local` after 0311 landed. Turbo's cache was
bypassed with `--force` so these are real executions, not replayed summaries.

```
supabase db reset --local && pnpm db:test
  0311_restrict_disable_reason_visibility.test.sql ............. ok
  All tests successful.
  Files=109, Tests=1553          EXIT=0

pnpm turbo run test --force
  @stockpilot/core:test:    Test Files  40 passed (40)    Tests   709 passed (709)
  @stockpilot/mobile:test:  Test Files  46 passed (46)    Tests   937 passed (937)
  @stockpilot/web:test:     Test Files 393 passed (393)   Tests  4170 passed (4170)
  Tasks: 3 successful, 3 total   EXIT=0

pnpm turbo run typecheck --force   Tasks: 3 successful, 3 total   EXIT=0
pnpm turbo run lint --force        0 errors, 102 warnings (74 mobile + 28 web)   EXIT=0
```

pgTAP moves **108 → 109 files and 1,526 → 1,553 tests**: exactly the 27 assertions 0311's new test
declares, and **no change to any existing test**. That last point is the one worth stating plainly —
0311 revokes a privilege from `authenticated`, the role most of the RLS suite runs as, so the 0308,
0309 and 0310 plans staying green at their original counts is the evidence that the revoke is
surgical. The application suites are unchanged at **5,816 tests** because 0311 touches no TypeScript,
and lint holds at the same pre-existing 102 warnings for the same reason.

### 7.2 End-to-end scenario — per leg

Run against the **local stack only**. No migration was pushed, no production account was disabled, and
no hosted project was contacted. Environment discipline (both `.env.local` files backed up, repointed,
restored, and verified byte-identical by SHA-256) is documented in the verification report.

| # | Leg | Original run | Re-run after the fix | Final |
|---|---|---|---|---|
| 1 | Baseline (R1) — web + mobile | PASS | not re-run | PASS |
| 2 | Protected target (R3) | PASS | not re-run | PASS |
| 3 | Reason is mandatory | PASS | not re-run | PASS |
| 4 | Disable | PASS (toast text not captured) | not re-run | PASS, with the caveat below |
| 5 | Instant eviction — mobile | **FAIL** | **re-run → PASS** | PASS |
| 6 | Next validation — web | PASS | not re-run | PASS |
| 7 | Sign-in blocked | PASS | not re-run | PASS |
| 8 | Wrong password does not leak | **FAIL** | not re-run | **ACCEPTED — will not fix** |
| 9 | API blocked | PASS | not re-run | PASS |
| 10 | Token refresh blocked | PARTIAL | **re-run → PASS** | PASS |
| 11 | Offline replay rejected | **FAIL** | **re-run → PASS** | PASS |
| 12 | Idempotency | PARTIAL — state idempotent, audit is not | not re-run | **ACCEPTED — by design** |
| 13 | Data untouched (R2) | PASS | not re-run | PASS |
| 14 | Audit trail | PARTIAL — data complete, UI incomplete | **re-run → PASS** | PASS |
| 15 | Re-enable (R4) | PASS | not re-run | PASS |
| 16 | Re-enable idempotency | PARTIAL — same defect as 12 | not re-run | **ACCEPTED — by design** |
| 17 | Divergence heals | PASS | not re-run | PASS |

**Only legs 5, 10, 11 and 14 were re-run.** The others were not, because the fix touches neither the
server state machine, the web chokepoints, nor the reason validation. Their results above are the
ORIGINAL run's, carried forward unchanged.

The verification report states its post-fix counts as "13 PASS, 0 PARTIAL, 0 open FAIL, 3
accepted-as-designed (8, 12, 16)". Counting the seventeen rows of its own table gives 14 PASS plus 3
accepted; the report's summary arithmetic is off by one against its table (its pre-fix summary has the
same discrepancy). The per-leg table above is the authoritative record and is what should be read.

### 7.3 Things that were NOT run or NOT verified — carried forward honestly

- **`pnpm db:test` was not re-run after the mobile fix** (§7.1).
- **Leg 4's toast was never read.** The revoked-session count quoted (`sessions_revoked: 3`) comes from
  the audit row, not from the toast. No claim is made about the toast's text.
- **Leg 8 is a real, unfixed enumeration oracle**, accepted by owner ruling (§8).
- **Legs 12/16 remain non-idempotent in the audit**, accepted by owner ruling (§3.4).
- **Leg 11 declared a substitution.** The `record_count` row was created entirely through the real UI
  with no substitution. The `distribute_bundle` row was authored directly into `pending_actions`
  because the bundle detail screen hung on load locally; the row is byte-shaped exactly as
  `app/bundles/[id].tsx` writes it. The brief's "stock adjustment via sync.ts" is not achievable at
  all — no screen enqueues `adjust_stock`, and `sync.ts` throws for that kind.
- **Demo Co was NOT walked.** The repo rule is to walk every feature in Demo Co
  (`71b27a4a-7948-4638-bc3f-535974713bd2`), but that org exists only in production and this program is
  local-only. Two purpose-built local accounts in the seeded local org were used instead. **The Demo Co
  walkthrough is still owed and can only be done after deploy.**
- **The hosted access-token TTL is UNVERIFIED** — it is a dashboard setting. No exposure-window number
  in this document is asserted from the local `jwt_expiry = 3600`.
- **The production GoTrue version is UNVERIFIED** (local is v2.189.0).
- **Two temporary vitest files were deleted after the run** (they need a live local database and would
  break CI). Their assertions are reproduced in the verification report's Appendix A so they can be
  re-run.
- **47 screenshots** back the browser and simulator claims; each was read back and described rather
  than trusted by filename. They live in the session scratchpad, outside the repository.

### 7.4 What the simulator caught that the unit tests could not

Worth recording, because it is the strongest argument in the program for the hand-test rule. The first
fix commit was correct against the wire format and wrong against the client library and the navigator.
Three defects surfaced in sequence on the device, each hiding the next: (1) gotrue-js never surfaces
`session_not_found` — it rethrows `AuthSessionMissingError` with `code: undefined`; (2) the
destination was staked too late, because gotrue-js awaits `_removeSession()` — which notifies
`SIGNED_OUT` — from inside `getUser()`, so the redirect had already chosen a screen; (3) the latch was
read-and-clear and the redirect effect runs more than once, so the second pass saw a spent latch and
overwrote sign-in with the marketing screen. Plus, on relaunch, auth-js discards a revoked session
inside `initialize()` before `getSession()` returns. Every one is now pinned by a test that models what
actually arrives rather than what the protocol says. **None would have been found without booting the
simulator.**

---

## 8. Remaining policy decisions — the owner must decide these

Each is stated neutrally with its tradeoff. **None is decided here, and none may be implemented before
the owner rules.**

### 8.1 The brief's four

**1. Should the disabled user receive an email?** On disable, on re-enable, both, or neither.
*Tradeoff:* an email is the only channel that reaches a user whose account is already locked, and the
disabled screen deliberately tells them nothing. Against: it converts a quiet investigative disable
into a notification the subject cannot miss, which is exactly wrong when the category is
`suspected_compromise` or `security_investigation`. A second decision rides on this one — whether the
email names the reason, which is currently held strictly on platform surfaces. The Resend plumbing and
29 templates already exist, so the cost is small either way.

**2. Should managers and org owners be notified, and should an org-visible `audit_logs` row be
written?** *Tradeoff:* an org whose member vanishes mid-shift currently gets no explanation at all, and
`audit_logs` is where a manager would look. Against: this is a *platform* action against a *person*,
and publishing it to every org they belong to leaks a cross-org fact into each one. Note
`user.deactivated` is already taken and means permanent membership removal, so this needs a new event
name. This decision is what currently blocks promoting `DISABLED_ACCOUNT_LOGIN_BLOCKED` and
`DISABLED_ACCOUNT_REQUEST_BLOCKED` from breadcrumbs to real events.

**3. Should active assignments be flagged for reassignment?** A disabled user may hold live picking
claims (`assigned_picker_id`), cycle-count assignee locks, the delivery-driver flag and pending order
approvals. *Tradeoff:* auto-releasing them keeps the warehouse moving, but it destroys the state a
re-enable would restore and could yank work out from under a disable that turns out to be a mistake.
Flagging in the UI is the middle option and costs a query on every assignment screen. **This branch
leaves all of them untouched** — the disabled user still *holds* the claims, they simply cannot act on
them.

**4. Is scheduled auto-re-enable wanted?** *Tradeoff:* a `disabled_until` column plus a cron sweep,
with `ban_duration` set to match so GoTrue's expiry aligns, would suit routine cases like a leave of
absence and remove the risk of an account staying disabled because someone forgot. Against: it adds a
second source of truth for the state and a cron job that can silently restore access. **This branch is
indefinite-until-manual only.**

### 8.2 Org API keys are not revoked on disable

Org API keys are **org-scoped, not user-scoped** (`authorizePublicApi` → `withApiKey`; there is no
user session on the public API at all). Nothing in this feature revokes them, so a disabled admin who
holds one keeps `/api/public/v1` access.

*Tradeoff:* revoking on disable would close a genuine hole, but the key belongs to the **organization**
and may be driving integrations the org depends on — revoking it punishes the org for one person's
status. There is also no per-user attribution on those keys to revoke selectively. The alternatives are:
leave as-is and treat key rotation as a manual step in the offboarding runbook; add per-user key
ownership so only the disabled user's keys die; or revoke org-wide and accept the integration breakage.

### 8.3 The +28% large-scan cost from migration 0310 — on READS as well as writes

Measured, not estimated (§5.3). The UPDATE by primary key (3.81 → 4.02 ms) and the paged
`inventory_items` SELECT (124.2 → 124.6 ms) are unaffected — the first scans one row, the second one
page, and `inventory_items_select` runs entirely through the hoisted Group A helpers anyway. The **bulk
sequential-scan UPDATE on 500k rows went 10.27 s → 13.13 s, +28%.**

**This was originally written up as a write-only, "pathological" case. That was wrong, and the
re-measurement is in §5.3.** ~70 SELECT policies gate on a *row-correlated* helper, so they pay the same
probe per row on reads: a `select count(*)` over 500,002 `item_stock_levels` rows through
`item_stock_levels`'s row-correlated policy went **3,556 ms → 4,555 ms, +28%** (8 interleaved pre/post
pairs; paired deltas +24%…+49%). The absolute cost is ~2.2–2.8 µs per row-correlated helper invocation —
an Index Only Scan on the partial index, `Heap Fetches: 0`. So the exposure is any query that *scans*
through a Group B policy: a full `item_stock_levels` rollup, an `activity_logs` export, a wide
`purchase_order_items` report. Paged application queries stay unaffected.

*Tradeoff:* accept it, or spend a denormalised `disabled_at` on `organization_members` (kept in sync by
a trigger) to answer the row-correlated question at zero extra buffers. That trades a synchronous
trigger and a second copy of the truth for the last 28% — which, corrected, applies to large reads too,
not only to a write shape the product does not issue. It was judged not worth doing without the owner's
word, and it is flagged rather than buried.

### 8.4 Should the session-revocation broadcast channel be made private?

`broadcastToChannel` posts with `private: false`, so `user:{id}:sessions` is readable **and writable**
by anyone holding the shipped anon key who knows a user's uuid.

*Tradeoff:* the current design contains the risk — the payload is a fixed enum naming only the *kind*
of event (never the reason text, the category, the actor or a timestamp), and the mobile listener
**never trusts it alone**: the auth probe must corroborate that the session really is gone before the
gate moves, and a forged reason against a healthy session is refused. So the exploit is bounded to
nuisance. Even so, private is better, and the implementer recommended it. Against: the channel is
shared with two older broadcasters (global sign-out, password reset) and both listeners would need the
`ensureRealtimeAuth()` JWT push before subscribing — supabase-js skips it on `INITIAL_SESSION` restore,
which is a documented landmine in this repo.

### 8.5 The account-enumeration tradeoff (e2e leg 8)

GoTrue checks the ban **before** it verifies the password, so a **wrong** password on a disabled
account returns `user_banned`, exactly as a correct one does. Anyone who knows only an email address
can therefore learn that the account is disabled.

*Tradeoff:* the brief's leg 7 requires the dedicated screen on a correct password, and leg 8 requires
indistinguishability on a wrong one. **GoTrue supplies one answer for both, so as specified they cannot
both hold.** The current ruling is that leg 7 wins. Reinforcing it: the oracle is reachable directly
with the public anon key regardless of what the app does, so suppressing it server-side would be
theatre. The alternative is to abandon the dedicated screen on the web sign-in path and let a disabled
user see "Invalid email or password" — which sends a locked-out person to reset a password that is
perfectly fine.

### 8.6 The disabled screen's Sign out button lands on `/`

`signOutAction` ends with `redirect('/')` (`server/actions/auth.ts:349`), so the only affordance on the
disabled screen returns the user to the marketing home page rather than to `/signin`.

*Tradeoff:* `/signin` is arguably the more useful destination for someone who wants to try a different
account. But `signOutAction` is a **shared** action used by every sign-out in the product, so changing
its destination changes behaviour everywhere. The alternatives are: leave it; give `signOutAction` an
optional destination parameter; or give the disabled screen its own thin action. This was raised and
deliberately **not** changed, because it is a product behaviour change rather than a bug fix and was
not smuggled into a security branch.

### 8.7 `_notify_recipients` — a pre-existing, non-disable-specific leak

The complete SECURITY DEFINER audit run during this program (80 functions granted to `authenticated`;
23 read membership directly → 15 now guarded, 6 inherit via a guarded helper, 2 ruled out) turned up
one function that is a genuine leak and has **nothing to do with account disable**:
`public._notify_recipients(uuid)` (migration 0025) is granted EXECUTE to `authenticated`.

*Recommendation:* **revoke the `authenticated` grant.** All five callers are themselves SECURITY
DEFINER, so nothing breaks. *Tradeoff:* essentially none identified — it is a one-line migration — but
it is a pre-existing behaviour outside this feature's blast radius, so it is recorded for the owner
rather than bundled into this branch.

### 8.8 Production GoTrue version is UNVERIFIED

The local stack runs GoTrue **v2.189.0**. Production's version was not read. This feature leans on
GoTrue's ban semantics — that `banned_until` is enforced on all Auth API endpoints including the
refresh grant, and that the ban is checked before the password — and both of those are what the
enforcement floor and the enumeration tradeoff rest on.

*Recommendation:* confirm the production GoTrue version before deploy and re-check those two
behaviours against it. *Tradeoff:* none — this is a verification step, not a design choice. If prod's
semantics differ, Layer A and migration 0310 still hold the line (they do not depend on GoTrue at all),
but the refresh-blocking and sign-in-blocking claims in §4 would need restating.

### 8.9 `apps/web/.env.local`'s service-role key is wrong for the LOCAL stack

`SUPABASE_SERVICE_ROLE_KEY` in the local env file is a foreign `sb_secret_e3…` value. Against the local
stack it authenticates as **anonymous**, so every `createAdminClient()` path silently returns nothing:
the platform console reports "0 ORGANIZATIONS, 0 USERS, 0 ITEMS" on a database that plainly has them,
and nothing errors, because a 200 with an empty array is indistinguishable from "no data".

This is the local-dev twin of the 2026-07-21 key-rotation outage. **It fails closed and never reached
production** (the URL is `127.0.0.1`), but it blocks the console entirely for anyone doing local work.
It is a **developer-environment fix, not a product change**, and it is outside this branch: the file is
a symlink into `~/Developer/stockpilot-env/` and was restored byte-identical after both runs. The
second run avoided the file entirely by passing the local values as inline process env instead.

### 8.10 ~~Addendum — the org-mate could read the internal reason~~ — **CLOSED, no decision needed**

This was the one entry in §8 that was a **defect, not a policy question**, and it is now fixed rather
than tabled. The addendum originally recorded it as read from the policy text and *"not confirmed by a
live probe"*. It has since been probed on the local stack: it **reproduced**. A plain `staff` member,
reading as `authenticated`, got a disabled colleague's full internal reason text and the God Admin's
uid back — via an explicit column list and via `select *`.

Migration **0311** closes it with column-level privileges, the only mechanism in Postgres that can hide
a column of a row a policy is otherwise right to return. Full detail, including the no-op trap the
obvious spelling falls into, is in **§5.4**. Nothing here is left for the owner to rule on: the
alternative floated above — moving the reason out of `user_profiles` — is no longer needed, because the
column is now unreadable by every request-facing role.

---

## 9. Deployment requirements

**Read this section before deploying anything.**

### 9.1 The migrations MUST reach production BEFORE the web build

**Migrations 0308, 0309 and 0310 must be applied to production before the web build that contains this
code is promoted.** This is not a preference and it is not the usual "pending migrations crash pages"
advice — it is stronger.

The guard now **fails CLOSED**. That was a deliberate fix to a critical defect: the first version
failed open at `loadSessionAndContext`, so a failed status read gave a disabled user a full
`OrgContext` for every page and Server Action, silently, while the same error class failed closed at
the API and portal funnels. The fix made all three deny on an unreadable status.

The consequence for deployment is direct: **a pre-0308 database plus this code is a total page and API
outage, not a silent bypass.** `select('… , disabled_at')` errors against a table that has no such
column, `resolveAccountStatus` classifies that as `unreadable`, and every install point refuses. Users
see "Something went wrong / Try again" on the web and a retryable 5xx on mobile, everywhere, for
everyone.

The correct order is therefore:

1. Merge the branch.
2. `supabase db push --linked` against `xizpqmhhslgzbuqtjubv`. This applies 0308, 0309 and 0310 in
   numeric order. Confirm all three landed before proceeding.
3. Only then let the web deploy proceed. Per the repo's Vercel rule, the GitHub integration
   auto-deploys `main` on push — do **not** additionally POST `/v13/deployments`. If the merge itself
   would trigger the build, apply the migrations first and merge second.
4. `supabase db reset` locally afterwards so the local pgTAP suite matches.

### 9.2 Mobile must not ship before the migrations either

The mobile changes are pure JS, so `pnpm release:ota` from `apps/mobile` is sufficient — **never a raw
`eas update`**. But the OTA must **not** go out before the migrations: the mobile client's Bearer
requests hit the same fail-closed guard, and its typed 401/5xx handling assumes the server can read a
status column that would not yet exist. Ship the database, then the web, then the OTA.

### 9.3 Do not split the three migrations

0308 alone is a defeatable feature: a disabled user can clear their own flag (the hole 0309 closes,
verified exploitable over HTTP) and can reach PostgREST directly with a live token (the hole 0310
closes, with proven write impact including persisted picking claims). All three go together.

### 9.4 Before deploy

- **Confirm the production GoTrue version** and re-check the two ban behaviours this feature leans on
  (§8.8).
- **Confirm the hosted project's access-token TTL** in the Supabase dashboard, so any exposure-window
  statement made to anyone is production's number and not the local `3600` (§7.3).
- Decide, or explicitly defer, the items in §8. None of them blocks the deploy; each blocks the
  feature it names.

### 9.5 After deploy

- **Walk Demo Co** (`71b27a4a-7948-4638-bc3f-535974713bd2`) on web and mobile. It could not be walked
  during this program because it exists only in production (§7.3), and the repo rule stands.
- Verify a real disable and re-enable against a disposable account, on both surfaces, before relying on
  the feature operationally.

### 9.6 The state of this work right now

**Nothing has been merged, deployed, or run against production. The branch HAS been pushed.**

That last sentence corrects the verification report, which recorded "no remote branch
(no origin/feat/account-disable)". That was true when it was written; it is no longer true. Checked
while writing this document:

```text
$ git ls-remote origin feat/account-disable
e01d7c7f4f186455617729020d77ce0090b0aaca  refs/heads/feat/account-disable

$ git reflog show origin/feat/account-disable
e01d7c7f refs/remotes/origin/feat/account-disable@{0}: update by push
```

So the branch exists on GitHub at `e01d7c7f`. What that does and does not mean:

- **It is not a production deploy.** The Vercel GitHub integration auto-deploys **`main`** on push; a
  feature branch produces a **preview** deployment, not production. Production is untouched.
- **It is a real risk worth checking, though.** If a preview build was produced from that push and its
  environment points at the **production** database, that preview URL is running the fail-closed guard
  against a **pre-0308 schema** — which is exactly the total-outage combination described in §9.1, for
  that URL. Production traffic is unaffected. **Confirm the preview's database target before opening
  the preview to anyone.**
- **No pull request was opened and nothing was merged to `main`** by this program.

Everything else stands:

- 22 commits on `feat/account-disable` up to `e01d7c7f`, plus this document's commit, which is **local
  only and has not been pushed**.
- **No `supabase db push` and no MCP `apply_migration` was invoked at any point.** The only schema
  command run was `supabase db reset`, against the local Docker stack at `127.0.0.1:54322`.
- **No migration has been applied to any hosted project.** The three migrations exist only as commits.
- No production account was disabled. No hosted project was contacted during the e2e runs. Both
  `.env.local` files were restored byte-identical after each run, verified by SHA-256.
