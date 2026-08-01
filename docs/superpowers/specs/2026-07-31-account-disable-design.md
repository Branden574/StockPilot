# God-Admin Temporary Account Disable — Design

Date: 2026-07-31
Basis: every decision below cites the sibling fact document `2026-07-31-account-disable-architecture-audit.md` ("Audit §n"). Where the audit marked something ABSENT, this design adds it or deliberately skips it.

Owner brief (restated): god-admin-only; platform-wide account disable; preserve everything (no data deleted); sessions revoked; logout on next validation; dedicated disabled screen web + mobile; required reason; audit events; additive migration; protected-admin safeguards including last-god-admin; idempotent + race-safe; offline mutations rejected; financial/operational data untouched; NO prod migration execution in this workstream; NO commits to main.

---

## 1. Account-status model

**Dual-layer status. Layer A is the app-level truth; Layer B is the GoTrue enforcement mirror.**

### Layer A — three new nullable columns on `public.user_profiles`

| Column | Type | Meaning |
|---|---|---|
| `disabled_at` | timestamptz NULL | NULL = active. Non-NULL = disabled since this instant. The single app-level source of truth. |
| `disabled_reason` | text NULL | Required at disable time (server-validated); cleared on re-enable. |
| `disabled_by` | uuid NULL | Actor auth uid (attribution also lands in platform_admin_audit with actor_email — Audit §6.2). |

Why `user_profiles`, not `organization_members`: the brief says **platform-wide** — a user can hold several memberships (Audit §2.1), and both server chokepoints already SELECT `user_profiles` per request, so the flag rides the existing query with **zero extra round trips** (Audit §1.3, §1.4; sessions piggyback facts). Why not `organizations`: no org kill switch is in scope (Audit §3).

Why additive-only and nothing else touched: "preserve everything / financial-operational data untouched" is satisfied **by construction** — disable writes only `user_profiles` (3 columns), `auth.users.banned_until`, `auth.sessions` (deletes rows that are pure session state), and audit tables. Memberships, stock, orders, movements, billing are never written.

### Layer B — GoTrue ban mirror

On disable: `createAdminClient().auth.admin.updateUserById(userId, { ban_duration: '876000h' })`; on re-enable: `{ ban_duration: 'none' }`. The column `auth.users.banned_until` already exists in prod and the installed auth-js 2.105.1 exposes exactly this API — currently unused anywhere (Audit §3, §4.4; Absent #2).

Why the ban is mandatory, not optional: it is the ONLY mechanism that (a) blocks token **refresh** (GoTrue rejects a banned user on all Auth API endpoints, error code `user_banned` — Audit §3), (b) fails the live `getUser()` that **every** withApiContext request performs on both Bearer and cookie paths (Audit §4.5), (c) blocks new sign-ins, and (d) covers B2B portal `customer_users`, who are real auth.users outside the org-member model (Audit §3). Layer A alone cannot do any of that; Layer B alone cannot give pages a structured redirect before token expiry. Both are required.

### State encoding

| State | `disabled_at` | `banned_until` |
|---|---|---|
| Active | NULL | NULL or past |
| Disabled | set | far future (~100 y) |
| Divergent (partial failure) | either mismatch | self-healed by re-running the action; see §8 |

---

## 2. Enforcement: one guard, two funnels, plus the ban floor

The audit proves **no single existing function covers pages + Server Actions + cookie API + Bearer** (Audit §1.5; Absent #4), and middleware cannot cover /api (Absent #8). The design therefore defines ONE new guard and installs it at the only two identity funnels that exist:

**New module: `apps/web/src/lib/auth/account-status.ts`** — exports `isAccountDisabled(profile)` plus the disabled redirect/error behavior. All copy and logic live here once.

| # | Call site | Change | Effect when disabled | Covers |
|---|---|---|---|---|
| 1 | `loadSessionAndContext()` (apps/web/src/lib/auth/session.ts:74-107) | widen the existing user_profiles SELECT with `disabled_at` | `redirect('/account-disabled')` | ALL dashboard/platform/onboarding pages + ALL org Server Actions, inherited free by the 146 `requireOrgContext` / 114 `withContext` call sites (Audit §1.3) |
| 2 | `withApiContext()` (apps/web/src/lib/auth/api-context.ts:202-315), both branches | widen the profile/membership SELECT with `disabled_at`; if set → return `null` | uniform 401 from every caller, no changes to the 86 routes (Audit §1.4) | all cookie + Bearer API routes |
| — | (floor) GoTrue ban | none — already enforced | Bearer/cookie getUser fails per-request; refresh dies; sign-in rejected `user_banned` | API immediately; everything else within token TTL (Audit §4.5) |

This closes the documented middleware fast-path gap ("locally-verified token accepted until exp", Audit §1.2): a disabled user's very next page render or Server Action hits the Layer A check regardless of JWT validity — that is the brief's "logout on next validation".

**Now CLOSED by migration 0310 — this section previously understated the risk.**

The original text called the residual exposure "read-only", reasoning that all mobile writes go through Bearer /api/v1. That reasoning was wrong: it describes what **our** client does, not what an attacker holding the token can do. PostgREST is not the Next.js server — it verifies the JWT signature locally and never asks GoTrue whether the session was revoked — so anyone holding a still-valid access token could issue **any verb PostgREST exposes**, including POST/PATCH/DELETE, against every business table. The pre-0310 exposure was read **and write**, for the full token lifetime.

The window is the access-token TTL. `supabase/config.toml` sets `jwt_expiry = 3600` for the LOCAL stack. **The hosted project's value is configured in the Supabase dashboard and has not been verified** — it is not asserted here, and the risk should not be described using the local number as though it were production's.

Migration `0310_rls_blocks_disabled_accounts.sql` closes this at the database. `user_profiles.disabled_at` is now consulted by the membership gate helpers themselves, so all 261 policies in the schema inherit the check without being edited. A disabled user is refused for SELECT, INSERT, UPDATE and DELETE the moment the flag is written, regardless of how much life their token has left. `service_role` is unaffected (its `auth.uid()` is null), which is what keeps re-enable possible.

The earlier objection — that an RLS check "would tax every query platform-wide" — was tested rather than assumed, and it holds only for the naive implementation. Measured on a 500k-row `inventory_items` fixture: the read path is hoisted into a one-time InitPlan and is unchanged (paged SELECT 124.2 ms → 122.7 ms; UPDATE by primary key 3.8 ms → 4.0 ms). Calling the check as a nested SECURITY DEFINER function from the row-correlated helpers *did* cost 3.3x on a bulk scan (10.2 s → 33.5 s), so those helpers inline the predicate instead, which brings the same worst case to 13.1 s (+28%) on a query shape the application does not issue. Full numbers: `.superpowers/sdd/bypass-closure-report.md`.

**Machine-readable signal to clients** is deliberately GoTrue's own `user_banned` code (sign-in, refresh, getUser) plus the web ActionResult code below — not a per-route 403 rewrite of 86 API routes (§6).

---

## 3. Disable / re-enable sequences (server actions)

New actions in `apps/web/src/server/actions/platform/users.ts` beside `sendUserPasswordResetAction`, with the service logic in `apps/web/src/server/services/platform/users.ts` (Audit §5.3 layering). All auth mutations via `createAdminClient()` (Audit §2.2 precedent).

### `disableUserAccountAction(targetUserId, reason)`

1. **Gate:** `checkPlatformAdmin({ requireStepUp: true })` — destructive, so the 15-min-fresh AAL2 tier, same as provisioning/act-as (Audit §2.2, §6.4). On stale step-up return `err('forbidden', …, { reason: 'aal2_required' })` so the existing `useStepUp()` retry loop works (Audit §6.4).
2. **Validate:** `reason` required — zod, trimmed, non-empty, max 500 chars. Resolve the target's **verified auth email** via `admin.auth.admin.getUserById(targetUserId)` — never `user_profiles.email` (the platform-admin rule, Audit §2.2).
3. **Protected-admin safeguard:** if `isPlatformAdmin(targetEmail)` → refuse (`forbidden`, "Platform administrators cannot be disabled."). Because the allowlist is deploy-time env and cannot shrink at runtime (Audit §2.2), refusing ALL allowlisted emails simultaneously guarantees: no self-disable, no disabling another god admin, and **the last god admin can never be locked out** — the "last-admin" case needs no counting logic.
4. **CAS (the linearization point):** service-role
   `UPDATE public.user_profiles SET disabled_at = now(), disabled_reason = $1, disabled_by = $2 WHERE id = $3 AND disabled_at IS NULL RETURNING id`.
   Check the RETURNING row (recurring-bug guard: `.update().eq()` fail-open — Audit §9). 0 rows → already disabled → **skip step 7's audit but still run steps 5-6** (idempotent replay that self-heals partial failures).
5. **Ban (Layer B):** `updateUserById(targetUserId, { ban_duration: '876000h' })` (Audit §4.4). On failure: leave the flag set (fail-closed for web + API via Layer A), surface the error to the admin UI; the action is safely re-runnable.
6. **Revoke sessions + instant eviction:**
   a. Call the NEW `public.admin_revoke_user_sessions(target_user_id)` SECURITY DEFINER function (§7) via the service-role client; it deletes the user's `auth.sessions` rows and returns the revoked session ids. Refresh tokens cascade away automatically (`ON DELETE CASCADE`, Audit §4.1). Required because mig 0213's functions are self-scoped and the installed auth-js has **no** signOut-by-user-id — the existing `team.ts:561` call passes a uuid where a JWT is required and is broken as typed; do not copy it (Audit §2.3, §4.2; Absent #9).
   b. `broadcastToChannel(\`user:${targetUserId}:sessions\`, 'revoked', { sessionIds })` — the shipped web + mobile listeners sign the devices out in ~1 s (Audit §4.3). Payload carries session ids only, **never the reason** (public channel — Audit §4.3).
7. **Audit:** `recordPlatformAudit({ action: 'user_disabled', target_user_id, detail: { reason, sessions_revoked: n, banned: true } })` (CHECK + TS union widened in §7; Audit §6.2). No org-level audit_logs row in v1 — org visibility is an open question (§10 Q2), and `'user.deactivated'` is already taken meaning permanent removal (Audit §6.1).

### `reenableUserAccountAction(targetUserId)`

1. `checkPlatformAdmin({ requireStepUp: true })`. The impersonation precedent leaves the un-gated path for *removing* access (Audit §6.4); re-enable **grants** access, so it stays step-up-gated.
2. **CAS:** `UPDATE … SET disabled_at = NULL, disabled_reason = NULL, disabled_by = NULL WHERE id = $1 AND disabled_at IS NOT NULL RETURNING id`.
3. `updateUserById(targetUserId, { ban_duration: 'none' })` — **executed even on CAS miss** (0 rows), so a stray ban with a clear flag is always healable by pressing Re-enable (see §8).
4. No session revocation, no broadcast — the user simply signs in again.
5. `recordPlatformAudit('user_reenabled', …)` on CAS win only.

---

## 4. UI placement

**The action lives on the platform console org-detail Users tab (`/platform/orgs/[id]?tab=users`) — and only there.**

Why this surface and not the other two: the feature is god-admin-only (brief), the platform console is the ONLY god-admin per-user surface that exists, and it is web-only by design (Audit §2.2, §5.3; Absent #7, #24). The org Team page and the mobile admin Users screen are **org-admin** surfaces (Audit §5.1, §5.2) and get no action. The mobile-parity rule is explicitly waived for the admin action because the console has no mobile twin (Audit §2.2); mobile ships only the disabled *screen* (§5).

Changes on the Users tab (each maps to an audit fact):

1. Replace the lone inline `PasswordResetButton` with the Team page's `DropdownMenu` three-dot pattern (Audit §5.1): items = Send password reset…, Disable account… (hidden for allowlisted emails), Re-enable account… (shown only when disabled).
2. Confirmation: `DestructiveConfirm` severity `'critical'` (type-to-confirm), replacing the console's `window.confirm` habit (Audit §5.1). The dialog gains a required **reason** textarea (extend DestructiveConfirm with an optional field slot, or a thin sibling dialog composing it). Dialog copy must state the platform-wide blast radius: "This disables the account across every organization, not just this one."
3. Status: a `Badge variant="destructive"` "Disabled" chip in the row (Audit §5.1 badge facts), title-attribute with the disabled_at date. `getOrgMembers` (services/platform/orgs.ts:383-405) joins `user_profiles.disabled_at` into its service-role select — possible only after the §7 migration (Audit §5.3 noted user_profiles carries no status today).
4. Wire `useStepUp()` around both actions (aal2_required retry-once loop; sixth wired site — Audit §6.4).
5. Cross-org discovery stays as-is: the absent /platform/users list (Absent #7) is out of scope; a user is disabled from whichever org tab surfaces them, with platform-wide effect.

**Org Team page (view-only, small):** the Status column is upgraded from plain text to show a "Disabled" destructive Badge when `disabled_at` is set (listMembers already embeds user_profiles — Audit §5.1). Org admins see the *status*; the *reason* never leaves platform surfaces (§9 matrix). The mobile admin Users screen may mirror the chip (it already reads user_profiles directly — Audit §5.2); optional, low-risk.

---

## 5. Disabled-screen flows

### Web

- **New route `apps/web/src/app/account-disabled/page.tsx`** — a standalone page outside the `(dashboard)` group, NOT wrapped by `requireOrgContext`, and not added to the proxy matcher (it needs no session to render). Content: "This account has been temporarily disabled by an administrator." + support contact + a Sign out button (posts the existing signOutAction). No reason shown (server-held; §10 Q6). Loop-safety follows the MFA-gate lesson: the destination of a blocking redirect must itself be exempt from the redirect (Audit §6.5).
- `loadSessionAndContext()` → disabled → `redirect('/account-disabled')` (§2).
- **Sign-in:** in `signInAction`, branch on the Supabase error code `user_banned` BEFORE the generic invalid-credentials collapse (Audit §4.5) → `err('account_disabled', 'This account has been temporarily disabled. Contact support if you believe this is an error.')`. Surfaces via the existing ActionResult→sonner-toast path — the only error surface /signin has (Audit §4.5, §6.3).

### Mobile

- **New full-screen `AccountDisabledScreen`** slotted into RootGate's existing early-return gate position, exactly like MfaChallengeScreen / BiometricLockScreen (Audit §1.6). Same copy as web; button = "Sign out" → local sign-out → welcome screen.
- Entry triggers:
  1. Sign-in attempt → `signInWithPassword` error code `user_banned` → show the screen state.
  2. Online at disable time → the existing `user:{id}:sessions` broadcast signs the device out (Audit §4.3); the next sign-in attempt hits trigger 1.
  3. Typed API 401s → auth probe: after the api() error upgrade (below), a 401 during sync/drain triggers one `supabase.auth.getUser()`; an AuthApiError with code `user_banned` → screen + `signOut({scope:'local'})`. Hook the probe into `pullSnapshot`'s catch (sync.ts:129-134), which currently swallows auth failures — no new AppState listener needed (Audit §1.6 recommendation).
- **Listener mount fix:** mount `useSessionRevocation` in RootGate (or move it there from DrawerContent) so pre-drawer and auth-group screens are also evicted; unify the redirect target (today DrawerContent → /(auth)/sign-in vs RootGate → /(auth)/welcome — Audit §1.6; Absent #19).
- **api() typed errors (prerequisite):** upgrade `api()` to throw `ApiError extends Error { status: number; code?: string }` while keeping the exact user-facing fallback sentences; update `api-errors.test.ts` in the same change since it pins the current shape verbatim (Audit §1.6; Absent #14).
- **Offline mutations rejected:** on entering the disabled state (trigger 3 or sign-in rejection), mark the user's `pending_actions` rows `status='rejected'` and exclude 'rejected' from `listPending` (today it selects pending+failed and retries forever — Audit §1.6). Rows are preserved locally for support (brief's "preserve everything" applies to server data; rejected offline mutations must never replay after re-enable). Server-side, replay is independently blocked: every drain POST is Bearer /api/v1 → banned getUser → 401 (Audit §4.5). SQLite change uses the existing column via a new status value + the listPending filter — no SCHEMA_VERSION bump (a bump drops the outbox — Audit §1.6).
- **No local wipe:** forced sign-out keeps the SQLite cache today (Audit §1.6); a temporary disable keeps that behavior (data returns when re-enabled). Listed as §10 Q9 if the owner wants a wipe.
- Push tokens keep flowing to the device (no dereg exists — Absent #16); §10 Q7.

---

## 6. Structured error codes

| Layer | Code | Where | Why |
|---|---|---|---|
| GoTrue | `user_banned` (built-in) | sign-in, token refresh, any auth.getUser | Free, canonical, reaches mobile + portal with zero API-route changes (Audit §3, §4.5) |
| ActionResult (web) | `account_disabled` — NEW member of `ActionErrorCode` (packages/core/src/types/action.ts:1-29) | signInAction; available to future actions | Distinguishable toast on /signin (Audit §6.3; Absent #5) |
| /api/v1 | none new — `withApiContext` returns null → uniform 401 `{error:'unauthenticated'}` | all 86 routes unchanged | ServiceError's code union is fixed and status-mapped (Audit §6.3); a disabled caller must not learn more from an API probe than an attacker would. Client-side disambiguation = the auth probe (§5) |
| Mobile | `ApiError.status` + auth probe result | api.ts | §5 |

---

## 7. Migration sketch — `supabase/migrations/0308_account_disable.sql`

Next free number verified 2026-07-31: highest on disk and in prod is 0307 → **0308** (Audit §9). Additive only. **Not executed against prod in this workstream** (owner brief; push happens via the owner's post-merge `supabase db push --linked` flow — Audit §9).

```sql
-- 0308_account_disable.sql
-- 1) App-level account status (Layer A). Additive; no defaults; no backfill.
alter table public.user_profiles
  add column if not exists disabled_at timestamptz,
  add column if not exists disabled_reason text,
  add column if not exists disabled_by uuid;
comment on column public.user_profiles.disabled_at is
  'Non-null = platform-admin temporary disable. Read per-request by '
  'loadSessionAndContext and withApiContext (PK lookups; no index needed).';

-- 2) Widen the god-mode audit action CHECK (precedent: 0241 drop + re-add).
alter table public.platform_admin_audit
  drop constraint platform_admin_audit_action_check;
alter table public.platform_admin_audit
  add constraint platform_admin_audit_action_check check (action in (
    'viewed_org','acted_as_start','acted_as_end','billing_changed',
    'password_reset_sent','org_provisioned','ticket_updated',
    'deletion_passphrase_set','org_deleted',
    'user_disabled','user_reenabled'));

-- 3) Admin-scoped session revocation (mig-0213 mirror, service-role only).
--    refresh_tokens FK cascades on session delete (prod-verified).
create or replace function public.admin_revoke_user_sessions(target_user_id uuid)
returns setof uuid
language sql
security definer
set search_path = auth, pg_temp
as $$
  delete from auth.sessions where user_id = target_user_id returning id;
$$;
revoke execute on function public.admin_revoke_user_sessions(uuid)
  from public, anon, authenticated;
-- executable by service_role/postgres only (the platform actions' admin client).
```

Notes for the implementer:
- No index on `disabled_at`: both readers fetch the row by PK (Audit §1.3, §1.4); mirrors 0171's "not a hot-path filter" posture.
- The CHECK re-add must restate ALL existing values — verify the live constraint list first; the current TS union is in Audit §6.2 (and 0241/0175 are the source migrations). Pattern warning: this is the CHECK-constraint analogue of recurring bug #24 (`alter policy … with check` REPLACES).
- TS edits shipped alongside: `PlatformAuditAction` union += 'user_disabled' | 'user_reenabled' (services/platform/audit.ts); `ActionErrorCode` += 'account_disabled' (packages/core).
- pgTAP (fresh — Absent #22): columns exist; CHECK accepts the two new actions and still accepts all old ones; `admin_revoke_user_sessions` exists, is security definer, and EXECUTE is denied to `authenticated`/`anon`. No 0207 pgTAP count bump (no new permission is added). Local suite needs `supabase db reset` after the new migration (Audit §9).

---

## 8. State-transition matrix and concurrency

### Transitions

| Current state | Action | Result |
|---|---|---|
| Active | Disable | CAS wins → banned + sessions revoked + broadcast + audited → Disabled |
| Disabled | Disable (repeat/retry) | CAS 0 rows → no audit; ban + revoke + broadcast re-run (self-heal) → Disabled. Idempotent |
| Disabled | Re-enable | CAS wins → ban cleared → audited → Active. User signs in again |
| Active | Re-enable | CAS 0 rows → no audit; `ban_duration:'none'` still applied (heals stray ban) → Active. Idempotent |
| Disabled | Sign-in / token refresh / getUser | Rejected by GoTrue (`user_banned`) |
| Disabled | Web page / Server Action with live JWT | Layer A → /account-disabled on next request |
| Disabled | /api (cookie or Bearer) | 401 (ban fails getUser; Layer A null-ctx as backstop) |
| Disabled | Direct PostgREST **read** with live JWT | Blocked by RLS from the moment the flag is written (mig 0310). Was: succeeded until token exp |
| Disabled | Direct PostgREST **write** (POST/PATCH/DELETE) with live JWT | Blocked by RLS (mig 0310). Was: **also succeeded** — the pre-0310 exposure was never read-only, because "writes go through Bearer /api/v1" constrains our client, not an attacker holding the token |
| Disabled | Org removeMember / role change | Unaffected — memberships preserved (brief) |
| Disabled | Platform deleteUser | Unaffected — existing flow (Audit §2.2); delete supersedes disable |
| Disabled target is allowlisted admin | Disable | Refused before CAS (§3 step 3) — unreachable state |

### Concurrency and partial failure

- **Linearization:** the guarded UPDATE on `user_profiles.disabled_at` is the single compare-and-set; Postgres row-level locking serializes concurrent disable/enable on the same user. Exactly one CAS winner writes the audit row.
- **Convergence rule:** BOTH actions always execute their Layer B step (ban / unban) even on CAS miss, and disable re-runs revoke+broadcast on CAS miss. Consequence: any interleaving or partial failure (flag set but ban write failed; ban set but flag clear) is repaired by re-running whichever action matches the intended end state — no manual SQL ever needed.
- **Fail-closed ordering:** flag first (blocks web + API through Layer A immediately), ban second, revoke third, broadcast fourth, audit last. A crash mid-sequence leaves the account at least as locked as the completed prefix.
- **Idempotent enforcement steps:** setting an identical ban twice, deleting zero sessions, and re-broadcasting are all harmless; the broadcast listener signs out at most once per device (Audit §4.3).
- **Residual race (documented, accepted):** disable(A) and re-enable(B) racing can commit CAS in one order and Layer B writes in the other, leaving flag/ban divergent for one interleaving window. App access always follows the FLAG (Layer A is what the chokepoints read), and the next press of either button heals Layer B (convergence rule). With a single-digit god-admin population behind step-up, an advisory-lock upgrade (`pg_advisory_xact_lock(hashtext(user_id::text))`) is available but not required for v1.

---

## 9. Permission matrix (target)

| Capability | viewer / staff / manager | org admin / owner | platform admin (god) |
|---|---|---|---|
| View "Disabled" status chip | only if granted Team-page access (`members:invite`, 0207-configurable — Audit §7) | Yes (Team page Status column) | Yes (org-detail Users tab) |
| View disable reason | No | No — reason never leaves platform surfaces | Yes (platform_admin_audit detail + tab) |
| Disable account | No | No | Yes — `checkPlatformAdmin({requireStepUp:true})`; refused for allowlisted targets |
| Re-enable account | No | No | Yes — same gate |
| View disable/enable audit trail | No (platform_admin_audit has zero RLS policies — Audit §6.2) | No | Yes (/platform/audit) |
| Org audit_logs rows for disable | n/a in v1 (open question Q2) | n/a in v1 | n/a |

The disable capability is deliberately NOT added to the 0207 configurable-permission system: god-admin powers are env-allowlist-only by explicit design ("no DB write can ever escalate" — Audit §2.2), and a DB-grantable disable permission would violate that invariant.

---

## 10. Open policy questions (stated, not decided)

1. **Email notifications** — should the disabled user receive an email on disable and/or re-enable (Resend + the es template family exist — Audit §5.3)? If yes: template archetype, and does it include the reason?
2. **Manager/org alerts** — should org owners/admins of the user's orgs be notified, and/or should an org-visible `audit_logs` row (new events, e.g. `user.account_disabled` — distinct from the taken `user.deactivated`, Audit §6.1) be written per accepted membership, making the platform action visible to manager+ org audit readers?
3. **Assignment flagging** — the disabled user may hold live operational assignments: picking claims (`assigned_picker_id`), cycle-count assignee locks, delivery-driver flag, order approvals. Auto-release, flag for reassignment in UI, or leave untouched until re-enable?
4. **Auto-re-enable** — should disable support an optional duration (a `disabled_until` column + cron sweep, with `ban_duration` set to match so GoTrue expiry aligns), or remain indefinite-until-manual only?
5. **Subscription/billing-owner handling** — disabling an org OWNER (possibly the billing owner): the org has no kill switch and owner is immutable/always-permitted (Audit §3, §2.1). Does the org continue operating without its owner, should sole-owner orgs warn or block, and what happens to Stripe-side ownership?
6. **Reason visibility to the user** — the disabled screens show generic copy; should the reason (or a category) be shown to the user?
7. **Push tokens** — a disabled device keeps its `push_tokens` row and keeps receiving pushes (Absent #16). Suppress sends to disabled users' tokens, delete rows on disable, or leave?
8. **B2B portal scope** — banned portal `customer_users` are locked out at sign-in/refresh by Layer B (Audit §3), but no portal-specific disabled screen is designed. Is a portal screen needed, or is the generic auth failure acceptable there?
9. **Device data retention** — forced sign-out keeps the local SQLite cache and (rejected) outbox on the disabled device (Audit §1.6). Acceptable for a temporary disable, or should disable trigger `wipeForSignOut()`?

---

## 11. Delivery constraints (non-negotiable, from brief + repo rules)

- Migration 0308 is written but **NOT pushed to prod** in this workstream; owner flow pushes post-merge (Audit §9).
- **No commits to main** — branch-first.
- Before "done": vitest for the new actions (allowlist refusal, required reason, CAS idempotency, partial-failure re-run; analogues: users.password-reset.test.ts, team.password-reset.test.ts — Audit §8 register), updated api-errors.test.ts, fresh pgTAP (§7), simulator hand-test of the mobile flows, and a Demo Co walkthrough (org 71b27a4a-7948-4638-bc3f-535974713bd2) — owner rules (Audit §9).
- Confirm the hosted project's access-token TTL in the Supabase dashboard before publishing any exposure-window claim to the owner (Audit §1.7; Absent #21).
- Do NOT reuse `admin.auth.admin.signOut(userId, …)` anywhere — broken as typed (Audit §2.3). Separately worth a fix ticket for `team.ts:561`.
