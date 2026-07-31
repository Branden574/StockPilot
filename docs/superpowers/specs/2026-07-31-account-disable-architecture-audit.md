# Temporary Account Disable — Phase 1 Architecture Audit

Date: 2026-07-31
Scope: read-only audit of the StockPilot monorepo (apps/web, apps/mobile, packages/core, supabase/) plus live read-only SQL against the linked production project `xizpqmhhslgzbuqtjubv`, to ground the "God Admin temporarily disables an account" feature. Six auditors covered: web auth boundary, mobile auth boundary, roles/god-admin, sessions/revocation, user-management UI, audit/errors/precedents. This document is facts with evidence; the design is in the sibling file `2026-07-31-account-disable-design.md`. Everything marked **ABSENT** does not exist today.

---

## 1. Auth provider and session model (as-built)

### 1.1 Provider and versions

- Auth is Supabase (GoTrue) + Postgres RLS. Linked prod project: `xizpqmhhslgzbuqtjubv`.
- `@supabase/supabase-js` is declared `^2.46.1` in both apps (apps/web/package.json:31, apps/mobile/package.json:30) but the lockfile resolves **2.105.1**, with `@supabase/auth-js` 2.105.1 and `@supabase/ssr` 0.5.2 (pnpm-lock.yaml:2716). The installed admin API surface is the modern 2.105.x one.

### 1.2 Web: middleware and session restore

- Web middleware is Next 16's proxy convention: `apps/web/src/proxy.ts:9-44` exports `proxy()` delegating to `updateSession()` in `apps/web/src/lib/supabase/middleware.ts`. The matcher is an explicit **allowlist** — `/dashboard/*`, `/platform/*`, `/onboarding/*`, `/signin/*`, `/signup`, `/reset/*`, `/invite/*`, `/portal(/*)` — and **`/api/**` is intentionally EXCLUDED** ("API routes always handle their own auth"), as are all anonymous surfaces (proxy.ts:14-31).
- `updateSession()` (middleware.ts:19-20, 34-116, 143-152, 165-176): builds an `@supabase/ssr` server client over request cookies, verifies via `auth.getClaims()` — a **LOCAL ES256 JWT verify** against a module-global JWKS cache (10 min), refreshing a near-expiry (≤90 s) token over the network first — with `auth.getUser()` as network fallback. On success it forwards identity as headers `x-stockpilot-user-id` / `x-stockpilot-user-email` (set ONLY after verification, unconditionally deleted otherwise). Unauthenticated hits on `/dashboard|/platform|/onboarding` redirect to `/signin?redirect=…`.
- **Revocation semantics (critical):** a locally-verified access token is accepted **until `exp` even if the session was revoked server-side** — stated in the code's own SECURITY comment, which also notes Postgres RLS likewise accepts any validly-signed unexpired JWT without consulting GoTrue (middleware.ts:79-86 / 82-87).
- Session storage: Supabase SSR cookies `sb-<projectRef>-auth-token[.N]` (regex at apps/web/src/lib/auth/api-context.ts:272-274). Browser refresh re-reads and re-verifies; refreshed tokens are written back via `setAll` (middleware.ts:36-61). A `stockpilot-remember-session` cookie ('0'/'1') controls persistence — `applyRememberSession` strips maxAge/expires to make auth cookies session-scoped (apps/web/src/lib/supabase/session-cookies.ts:3-25; apps/web/src/lib/supabase/server.ts:23-48).

### 1.3 Web: page / Server-Action funnel (choke point 1)

- All RSC pages and org-scoped Server Actions resolve identity through **one React.cache()d function**: `loadSessionAndContext()` in `apps/web/src/lib/auth/session.ts:74-107` — reads the two middleware headers (never calls getUser itself), then fetches `user_profiles` + accepted `organization_members` in one parallel pair.
- `getServerSession`, `requireSession`, `requireOrgContext` (session.ts:182-237) and `withContext()` (`apps/web/src/server/services/context.ts:104-129`, the ServiceContext builder) all layer over it. Grep counts: **146 files** reference `requireOrgContext`, **114 files** reference `withContext()`. The dashboard layout itself calls `requireOrgContext` (app/(dashboard)/layout.tsx:49).
- Server Actions POST to their page's URL, so dashboard-page actions DO pass through the proxy and receive the headers.

### 1.4 Web: API funnel (choke point 2) — cookie AND Bearer

- `withApiContext(req)` in `apps/web/src/lib/auth/api-context.ts:202-315` is the single authenticator for user-principal API routes: **86 of 125** `app/api` route.ts files call it.
  - **Bearer path (mobile):** validates the JWT with a **live network call** `adminAuth.auth.getUser(bearer)` on EVERY request (api-context.ts:213), then binds an anon-key client with the Authorization header (bearer branch 206-255).
  - **Cookie path:** short-circuits when no `sb-*-auth-token` cookie, else `supabase.auth.getUser()` (network) per request (257-315, getUser at 283).
  - Both then resolve membership via `pickActiveMembership` (X-Organization-Id honored after membership verify, 141-185), MFA state, modules, permissions — returning a ServiceContext or `null` (caller 401s). No request-level cache on the API path.
- The ~39 route files NOT behind it are **non-user principals**: `/api/cron/*` (secret-guarded), `/api/webhooks/{stripe,easypost}`, `/api/public/v1/*` (API-key auth via `authorizePublicApi`→`withApiKey`, apps/web/src/lib/auth/public-api.ts:12-16 — "NO user session on the public API"; API keys are org-scoped, not user-scoped), token-based public endpoints, integration OAuth callbacks, `/api/health`, `/api/version`. An account-disable check in withApiContext would not (and need not) cover these.

### 1.5 No single chokepoint exists (fact)

- **No single function covers pages + Server Actions + cookie API + Bearer /api/v1.** The minimal covering set is TWO functions: `loadSessionAndContext()` (session.ts:74) and `withApiContext()` (api-context.ts:202). A middleware-only check cannot cover `/api` (matcher excludes it, proxy.ts:31).
- A GoTrue-level ban (`auth.users.banned_until`) is enforced **immediately** on both withApiContext paths (per-request getUser), but page requests keep passing the local `getClaims()` verify until token expiry (~1 h) unless paired with refresh-token revocation + the `user:{id}:sessions` 'revoked' broadcast (middleware.ts:63-116; api-context.ts:213, 281-284).

### 1.6 Mobile: session restore / resume

- Session persists in **expo-secure-store via a custom chunked adapter** (values >1900 bytes split into `<key>.N` entries with a `__chunked:N` manifest — SecureStore's 2 KB Keychain cap). Client options: `autoRefreshToken:true, persistSession:true, detectSessionInUrl:false` (apps/mobile/src/lib/supabase.ts:31-90).
- Cold launch: AuthProvider hydrates via `supabase.auth.getSession()`, then biometric opt-in (locked=true) and owed AAL1→AAL2 MFA challenge; **any hydrate failure fails CLOSED to sign-in**. RootGate routes session-less users to `/(auth)/welcome` and renders MfaChallengeScreen / BiometricLockScreen as full-screen early returns before the Stack (apps/mobile/src/lib/auth-context.tsx:99-141; apps/mobile/app/_layout.tsx:117-181).
- Exactly **ONE** `onAuthStateChange` subscription app-wide, in AuthProvider (auth-context.tsx:143-176): SIGNED_OUT clears state → RootGate redirects. Any programmatic signOut funnels through it — a disabled-account flow ending in signOut needs no new listener.
- AppState listeners: exactly two — `useSync` (foreground → syncNow() + 60 s interval; use-sync.ts:42-50, mounted _layout.tsx:124) and the `cycleCountSync` singleton (cycle-count-sync.ts:66/69/77). **ABSENT:** any `startAutoRefresh`/`stopAutoRefresh` AppState wiring (the Supabase-recommended RN pattern) — zero grep hits; refresh relies on supabase-js internals (supabase.ts:86).
- Bearer client: `api()` in apps/mobile/src/lib/api.ts attaches `Authorization: Bearer <access_token>` via `getSession()` per request, plus `X-Organization-Id` from AsyncStorage key `workspace.activeOrgId`; 20 s composed abort timeout (api.ts:59-98).
- **Mobile errors are unstructured:** on non-2xx, api() parses the body only if it starts with `{`, uses `{message}??{error}`; otherwise 401/403 collapse to the literal 'You do not have access to that.'. It throws a plain `Error` with **no status, no code field, no error class**; nothing signs out on 401. The shape is pinned verbatim by `apps/mobile/src/lib/api-errors.test.ts:21-44, 89-107` — changing it must update that test (api.ts:100-131).
- Reads bypass the server: mobile reads PostgREST **directly with the user JWT under RLS** ("Reads Supabase, writes REST") — e.g. screens/reports.tsx, components/po-attachments.tsx, use-push-notifications.ts:73.
- Force-logout listener: `useSessionRevocation` subscribes to `user:{userId}:sessions` / 'revoked' ({sessionIds:[]} or {keepId}), decodes its own session_id from the JWT, and on a hit calls `supabase.auth.signOut({scope:'local'})` (documented gotcha: global scope would cascade-revoke other devices). Mounted **exactly once, in DrawerContent (NOT RootGate)** with redirect to `/(auth)/sign-in` — RootGate's own redirect target is `/(auth)/welcome` (use-session-revocation.ts:17-81; drawer-content.tsx:50-54). Fail-silent; token expiry is the backstop.
- Forced sign-out does **NOT** wipe local data: the revocation path calls `signOut({scope:'local'})` only, never `wipeForSignOut()` — SQLite cache and outbox survive. User-initiated signOut is scope:'global' + full wipe (auth-context.tsx:219-229; db.ts:267-317; use-session-revocation.ts:56-64).
- Offline outbox: `pending_actions` in local SQLite (7 kinds, v4-UUID idempotency keys; queue.ts:13-56; db.ts:40-50, 174-186, 203-238). Legacy drain (sync.ts:297-326) retries failed rows **EVERY tick with no backoff and no cap** (listPending selects status IN ('pending','failed'), queue.ts:70-71) — a disabled account's 401s would loop forever. Only the cycle-count outbox has backoff + user-visible status (cycle-count-sync.ts:29-34, 171-218, 270-277). **ABSENT:** any queue-review UI for the legacy outbox (queue.ts listAll/retry have zero callers).
- Push: `usePushNotifications` upserts `public.push_tokens` directly via PostgREST (use-push-notifications.ts:73-81). **ABSENT:** push-token deregistration on sign-out or revocation.
- Realtime gotcha: `ensureRealtimeAuth()` (realtime-auth.ts:1-29) must push the JWT before private channels join (supabase-js skips it on INITIAL_SESSION restore). `useSessionRevocation` does NOT call it — works today only because the broadcast channel is public/non-RLS.

### 1.7 Token lifetimes

- Local config: `supabase/config.toml:50` → `jwt_expiry = 3600` (1 hour).
- **The HOSTED project's JWT expiry is a dashboard setting not readable via SQL — UNVERIFIED in this audit.** App code assumes ~1 h ('token expiry still lock the device out within the hour', session-revocation-listener.tsx:12-13; use-session-revocation.ts:8-11). Treat the do-nothing exposure window as **up to ~1 hour** of continued access on an already-issued token; confirm in the dashboard before finalizing.

---

## 2. Role model and the real God Admin

### 2.1 Org roles and permissions

- `ROLES = ['owner','admin','manager','staff','viewer']` (packages/core/src/constants/roles.ts:1-2); ASSIGNABLE_ROLES excludes owner (terminology.ts:84). SQL rank ladder owner=100 / admin=80 / manager=60 / staff=40 / viewer=20 in `has_org_role` (mig 0177).
- Configurable permissions (mig 0207): `role_default_permissions` (global mirror of TS ROLE_PERMISSIONS — changes require a parity migration + pgTAP count bump), `role_permission_overrides` (per-org per-role), `user_permission_overrides` (per-org per-user, beats role), resolved by `has_permission(org, perm)`; **owner is short-circuited always-true** so an org can never lock itself out (0207:1-27; 0177:77-104).

### 2.2 God Admin = "platform admin" (exact identity mechanism)

- A platform admin is identified **solely by a deploy-time env allowlist, never a DB table**: `isPlatformAdmin(email)` splits `STOCKPILOT_PLATFORM_ADMIN_EMAILS` (comma-separated, normalized to trimmed lowercase by the env schema) and checks membership. Empty/unset env = zero platform admins. The code comment states this is deliberate: "no DB write can ever escalate an account to god-mode" (apps/web/src/lib/auth/platform-admin.ts:22-29; apps/web/src/lib/env.ts:152-157).
- Authorization is gated exclusively on the **VERIFIED auth email** from `supabase.auth.getUser()` (`getVerifiedEmail`, React.cache'd), never `user_profiles.email` (users can update their own profile row). Defense-in-depth: mig 0177 trigger `pin_user_profile_email` silently reverts any UPDATE to user_profiles.email (platform-admin.ts:31-53; 0177:25-42).
- Gate functions:
  - **Pages:** `requirePlatformAdmin()` — signed-in session + allowlisted verified email + **AAL2**; any failure → `notFound()` (404, never 403, so the console's existence is hidden). Called in the `(platform)` group layout AND re-called in page bodies (layout/page render in parallel) (app/(platform)/layout.tsx:14-16; platform-admin.ts:152-157; in-page re-gate platform/page.tsx:63-68, orgs/[id]/page.tsx:40-46).
  - **Actions:** `checkPlatformAdmin({requireStepUp})` — additionally requires a **FRESH step-up**: `mfaAssertionAgeFromToken` parses the JWT `amr` claim for the latest totp/mfa assertion and requires age ≤ `STEP_UP_MAX_AGE_SECONDS = 15*60`; amr timestamps are not bumped by token refresh. Stale/unknown → reason `'aal2_required'` (platform-admin.ts:88-93, 100, 109-140, 174-187).
  - A header-based variant `currentUserIsPlatformAdminFromRequestHeader` is documented LINK-VISIBILITY-ONLY (cosmetic), never a real gate (platform-admin.ts:55-81).
- Console: `apps/web/src/app/(platform)/platform/{page.tsx, orgs/[id], provision, audit, support}`. Middleware PROTECTED_PREFIXES includes `/platform` (middleware.ts:15). **Web-only — no mobile and no /api/v1 platform-admin surface exists.**
- Existing precedent for platform-admin writes to arbitrary users (all via `createAdminClient()` service-role behind the gate; `apps/web/src/lib/supabase/admin.ts:12-22`):
  1. `createOrgForCustomerAction` creates auth users via `admin.auth.admin.generateLink({type:'invite'})` and deletes on rollback (`admin.auth.admin.deleteUser`, server/actions/platform-admin.ts:485), gated `checkPlatformAdmin({requireStepUp:true})`.
  2. `sendPasswordResetForUser` — any user cross-org, audited 'password_reset_sent' (server/services/platform/users.ts:28-64).
  3. Impersonation — inserts a real `organization_members` row (role owner, `impersonation_expires_at = now()+45min`) (server/services/platform/impersonation.ts:1-40, 14-236).
- Full admin-auth API usage inventory (grep): `signOut` (team.ts:561), `createUser` (actions/team.ts:516 — the ONLY auth-user creation path; public signup disabled), `deleteUser` (profile.ts:391/397, platform-admin.ts:485, api/v1/account/delete/route.ts:115/120), `generateLink` (4 sites), `admin.mfa` (mfa-recovery.ts:144/152). **`updateUserById` is called NOWHERE.**

### 2.3 Verified discrepancy: the "global sign-out by user id" precedent is broken as typed

- `TeamService.removeMember` calls `admin.auth.admin.signOut(removedUserId, 'global')` (apps/web/src/server/services/team.ts:561-564; re-read during this synthesis).
- The installed auth-js 2.105.1 signature is `signOut(jwt: string, scope?: SignOutScope)` with jsdoc "@param jwt **A valid, logged-in JWT**" (node_modules/.pnpm/@supabase+auth-js@2.105.1/.../GoTrueAdminApi.d.ts:55-65; re-read during this synthesis).
- The call therefore sends a bare UUID where a JWT is required; it is expected to error at runtime (the code is best-effort — `sessionRevoked = !signOutErr`, and the audit row records `session_revoked`; team.ts:565-585). Runtime behavior was NOT verified (read-only audit), but the type/doc mismatch is confirmed. **There is NO admin "sign out all sessions by user id" method in the installed API** — by-user-id revocation must go through SQL on `auth.sessions` (the mig-0213 pattern) or a GoTrue ban. Do not copy the team.ts:561 pattern.

---

## 3. Existing account-status concepts (complete inventory)

| Concept | Where | Semantics | Read at auth time? |
|---|---|---|---|
| `auth.users.banned_until` timestamptz | Prod-verified (information_schema) | GoTrue-native ban. Per Supabase's error registry (code `user_banned`): a user with active banned_until is rejected on **ALL Auth API endpoints** — including the `refresh_token` grant (so it blocks token REFRESH, not just new sign-ins) and `GET /user`. It does **NOT** invalidate already-issued access tokens at the data plane: PostgREST/Realtime/Storage verify JWTs statelessly and never consult it. Settable via `auth.admin.updateUserById(uid, { ban_duration: '876000h' \| 'none' })` (auth-js types.d.ts:386, 455-466) | **Never — zero app-code references anywhere** (grep of apps/web, apps/mobile, packages, supabase/migrations) |
| `auth.users.deleted_at`, `is_sso_user` | Prod auth schema | GoTrue built-ins | No |
| `user_profiles.deleted_at` | mig 0171 | Write-once self-delete tombstone stamped by `deleteOwnAccountAction` immediately before `auth.admin.deleteUser` ("not a hot-path filter") | **Never** (profile.ts:391; api/v1/account/delete/route.ts:115) |
| `organization_members.accepted_at` | schema | NULL = pending invite. All three RLS helpers (`is_org_member`/`user_org_role`/`has_org_role`, redefined in 0177) require it NOT NULL — membership removal is the de-facto lockout today | Yes (RLS + both chokepoints) |
| `organization_members.impersonation_expires_at` | migs 0176/0177 | NULL = real membership; non-NULL = auto-expiring platform impersonation grant. All three RLS helpers require NULL or > now(). **The only time-boxed access concept in the schema — the proven template for threading a status flag through the RLS helpers** (0176:22-26; 0177:45-104) | Yes |
| `organizations` status | — | **ABSENT.** No suspended/disabled column; only the 0175 billing-override dials (access_tier, billing_arrangement, custom_price_*, trial_*, all_modules_comp). No org kill switch (0175:20-41) | — |
| `customers.status` 'active'\|'archived' | mig 0250:24-33 | B2B buyer-**company**-level archive, not a user ban | — |
| `customer_users` per-user status | mig 0250:57-67 | **ABSENT** — only accepted_at. Portal users are real auth.users (never org_members), so an auth-level ban WOULD cover them; an org-member-level flag would NOT | — |
| "Auditor" | migs 0279-0281 | Not a status — 5 grantable read permissions + a preset on an ordinary member | — |

Prod column listings (information_schema, project xizpqmhhslgzbuqtjubv) confirm: `user_profiles` = id, email, full_name, avatar_url, default_organization_id, created_at, updated_at, digest flags, deleted_at, onboarding_dismissed_at — **no status column**. `organization_members` = id, organization_id, user_id, role, invited_by, invited_at, accepted_at, created_at, impersonation_expires_at, is_delivery_driver, all_warehouses — **no status column**.

**Bottom line: NO account-level allowed/disabled/suspended/locked check exists anywhere in any request path.** The only gates today are membership existence (401 / redirect to /onboarding), the org MFA policy gate, and the platform-admin env allowlist (session.ts:203-227; api-context.ts:226, 287-288).

---

## 4. Session-revocation machinery (as-built)

### 4.1 Prod auth schema shapes

- `auth.sessions`: id (PK), user_id, created_at, updated_at, factor_id, aal, not_after, refreshed_at, user_agent, ip, tag, oauth_client_id, refresh_token_hmac_key, refresh_token_counter, scopes. One row per login (prod-verified).
- `auth.refresh_tokens`: id, token, user_id, revoked, created_at, updated_at, parent, session_id — with FK `refresh_tokens_session_id_fkey REFERENCES auth.sessions(id) ON DELETE CASCADE` (prod-verified pg_constraint). **Deleting an auth.sessions row cascades away all its refresh tokens; the next refresh attempt 401s.**

### 4.2 Self-service revocation (migs 0213/0214)

- SECURITY DEFINER functions `list_my_sessions` / `revoke_my_session` / `revoke_my_other_sessions` DELETE from auth.sessions **scoped to auth.uid()** (0213:35-66; 0214 adds names). **Strictly self-scoped — a God Admin cannot reuse them against another user.** `createAdminClient()` cannot run raw SQL on the auth schema either (admin.ts:12-22) — an admin-scoped revocation function does not exist (ABSENT).

### 4.3 Broadcast eviction (instant UX layer)

- `broadcastToChannel()` POSTs `{SUPABASE_URL}/realtime/v1/api/broadcast` with the anon key; channels are **PUBLIC**, best-effort, 4 s timeout, never throws — payloads must stay non-sensitive (apps/web/src/lib/realtime/broadcast.ts:10-29).
- Channel `user:{userId}:sessions`, event `'revoked'`, payload `{sessionIds:[...]}` or `{keepId}`. **keepId semantics: every session whose id != keepId signs out — broadcasting a random UUID as keepId evicts ALL of a user's online devices.** Sent by server/actions/sessions.ts:30-99 after the 0213 RPCs.
- Listeners: web `SessionRevocationListener` mounted in dashboard-shell.tsx:208 (signs out → /signin; session-revocation-listener.tsx:50-66); mobile `useSessionRevocation` in DrawerContent only (§1.6). Both fail-silent; token expiry (~1 h) is the backstop.
- Second precedent channel: `perms:{organizationId}` / 'changed' (broadcast.ts:52-57) — live "your access changed" push is an established pattern.

### 4.4 Admin API surface (installed 2.105.1)

- `auth.admin.updateUserById(uid, { ban_duration: '876000h' | 'none' })` → sets/clears `banned_until` (GoTrueAdminApi.d.ts:573; types.d.ts:466). **Unused anywhere in the repo.**
- `auth.admin.deleteUser(id, shouldSoftDelete)` (d.ts:605) — used by platform console + self-delete.
- `auth.admin.signOut(jwt, scope)` — **takes a JWT, not a user id** (§2.3).
- `createAdminClient()` (admin.ts:12-22): service-role supabase-js client (SUPABASE_SERVICE_ROLE_KEY, no refresh/persist); full `auth.admin.*` + service-role PostgREST; **no raw SQL on auth schema**.

### 4.5 The exact enforcement gap per surface

| Surface | Verification performed | Does a GoTrue ban bite? | Latency |
|---|---|---|---|
| Bearer `/api/v1` (all mobile writes) | Live `getUser(bearer)` EVERY request (api-context.ts:213) | **Yes — immediately** | 0 |
| Cookie `/api` routes | `getUser()` per request (api-context.ts:283) | **Yes — immediately** | 0 |
| Web pages + Server Actions | Local `getClaims()` (middleware fast path) + header-fed loadSessionAndContext; no GoTrue call | **No** — coasts until token exp | up to ~1 h (unverified hosted TTL, §1.7) |
| Direct PostgREST (mobile reads), Realtime, Storage | Stateless JWT verify + RLS; never consults GoTrue | **No** — until exp; refresh then fails | up to ~1 h |
| Sign-in (`signInWithPassword`) | GoTrue | **Yes** — rejected with code `user_banned`; would currently land in signInAction's generic 'Invalid email or password' branch (server/actions/auth.ts:200-237) | 0 |

Sign-in flow context: `signInAction` (server/actions/auth.ts:172-289) — dual rate-limit, distinguishes 429 from bad credentials, audits `user.sign_in_failed`/`user.signed_in`, routes to /signin/mfa. Errors surface **as sonner toasts only** via typed ActionResult (sign-in-form.tsx:46-64, 77-95); no inline banner, no `?error=` rendering on /signin (signin/page.tsx:14-27).

---

## 5. User-management surfaces (three exist)

### 5.1 Org Team page (web) — `/dashboard/team`

- Server component gated on `can(ctx,'members:invite')` (viewers redirected); loads via TeamService; renders client `TeamManager` (page.tsx:17-51).
- `TeamManager` (1301-line client component): each member row has a shadcn/Radix `DropdownMenu` three-dot menu (team-manager.tsx:391-450). Items today: Change role, Mark/remove delivery driver, Warehouse access…, Charters…, Category access…, Send password reset… (accepted members), Transfer ownership… (owner), Remove (destructive).
- All mutations are Server Actions returning `ActionResult<T>` (server/actions/team.ts:44-555): invite/revoke/resend, updateMemberRole, setMemberDriver, removeMember, sendMemberPasswordReset, setMemberCharters, setMemberWarehouseAccess, transferOwnership, acceptInvite(+WithSignup). Refresh = toast + router.refresh() + revalidatePath.
- TeamService uses the USER-authed ctx.supabase (team.ts:35-155). Prod RLS: organization_members SELECT = is_org_member; INSERT/UPDATE = has_org_role(org,'admin'); DELETE = self OR admin. organization_invites all admin.
- `removeMember` (team.ts:495-601): deletes membership, clears warehouse assignments, attempts global signOut (**broken as typed, §2.3**), audits `'user.deactivated'` + `'user.session.invalidated'`.
- Confirmation primitive: `DestructiveConfirm` (ui/destructive-confirm.tsx:19-204) — Dialog-based; severity 'standard' or 'critical' (type-to-confirm + 'This cannot be undone.'); tone destructive|primary; pending-safe. **The platform console does NOT use it** — PasswordResetButton uses `window.confirm` (platform/password-reset-button.tsx:22).
- Status display today: the Team 'Status' column is **plain text 'Active'/'Invited'** (team-manager.tsx:369-382). `Badge` (ui/badge.tsx:6-22) has cva variants default/secondary/destructive/success/warning/outline; RoleBadge maps roles (team/role-badge.tsx:5-16). Mobile has a `Pill` (ok/warn/crit/default).
- `/dashboard/admin/users` is a bare `redirect('/dashboard/team')` (admin/users/page.tsx:8-10); the /dashboard/admin section gates on `can(ctx,'organization:update')` (admin/layout.tsx:14-17). Sidebar entries come from the shared module registry (packages/core/src/modules/registry.ts:208, 210).

### 5.2 Mobile admin Users screen

- Native screen `apps/mobile/app/(drawer)/admin/users.tsx` (576 lines): reads organization_members + user_profiles **directly via the Supabase client** (two-step fetch to dodge the dual-FK embed ambiguity), role pills, role update via direct `.update()` under admin RLS (users.tsx:1-90, 188-193). Owner rule: web features default to mobile too — but note the god-mode console is web-only (§2.2).

### 5.3 Platform console — org-detail Users tab (the only god-admin per-user surface)

- **ABSENT: any platform-wide user list/search.** Users appear only on `/platform/orgs/[id]?tab=users` (UsersTab): a server-rendered table (User / Role / Joined / Actions) fed by `getOrgMembers` — a `createAdminClient` (service-role) query on organization_members excluding impersonation grants, capped at DETAIL_PREVIEW_LIMIT (orgs/[id]/page.tsx:221-260; services/platform/orgs.ts:383-405).
- The ONLY per-user action: `PasswordResetButton` (inline button + window.confirm) → `sendUserPasswordResetAction` (`checkPlatformAdmin`, **no step-up**) → `sendPasswordResetForUser`, audited 'password_reset_sent' (platform/password-reset-button.tsx:12-40; actions/platform/users.ts:21-41; services/platform/users.ts:28-64).
- Data-loading per surface: Team = server component + user-authed services + Server Actions; Platform = force-dynamic server components on createAdminClient + in-page re-gate + checkPlatformAdmin actions; Mobile admin = direct client Supabase under RLS. **No /api routes are involved in any of the three.**
- Email plumbing: `sendPasswordResetEmail` is the single shared reset path — `generateLink({type:'recovery'})` → our /auth/confirm URL → Resend (lib/auth/password-reset-email.ts:30-87). Never `resetPasswordForEmail` (built-in mailer capped ~2/hr). Team invites mint their own token into organization_invites (/i/<token>); `acceptInviteWithSignupAction` is the only auth-user creation path (actions/team.ts:439-555). The repo deliberately avoids `listUsers` scans (auth_user_exists_by_email RPC, mig 0097).

---

## 6. Audit, error, step-up, and blocking-screen precedents

### 6.1 Org-level `audit_logs`

- mig 0002:307-317 — id, organization_id (FK cascade), user_id (FK set null), event text, metadata jsonb, ip inet, user_agent, created_at. Indexes 0002 + 0135/0272.
- RLS: exactly ONE policy in prod — `audit_logs_select` (SELECT, org-scoped via `rls_manager_org_ids()` since 0272 → **manager+ read**). No INSERT/UPDATE/DELETE policies; all writes via service-role in `audit()` (0272:27-30).
- `audit(payload, ctx?)` (services/audit.ts:9-348): ~200-member string-literal event union, convention **domain.noun.verbed** with WHY comments per cluster; target in metadata {entity_type, entity_id, before, after, reason, ...}; best-effort (never throws → reportError 'audit.write_failed'). **Bearer/API callers MUST pass their ServiceContext or the withContext() fallback throws NEXT_REDIRECT and the event is silently dropped** (audit.ts:309-312).
- **Naming collision to avoid:** `'user.deactivated'` / `'user.reactivated'` already exist (audit.ts:24-25) but `user.deactivated` means **permanent org-membership removal**, not a temporary disable (§5.1).

### 6.2 `platform_admin_audit` (god-mode trail)

- mig 0175:44-67: actor_user_id, actor_email, action, target_organization_id, target_user_id, detail jsonb. **RLS ON with ZERO policies (prod-verified) = service-role only.** Writes via `recordPlatformAudit()` (best-effort, never throws; services/platform/audit.ts:20-58).
- `action` has a **CHECK constraint**; current TS union: viewed_org, acted_as_start, acted_as_end, billing_changed, password_reset_sent, org_provisioned, ticket_updated, deletion_passphrase_set, org_deleted. **Adding 'user_disabled'/'user_reenabled' requires BOTH the TS union edit AND a migration re-creating `platform_admin_audit_action_check`** — precedent: mig 0241 dropped + re-added the constraint to add two actions (0241:24-30).

### 6.3 Error conventions

- `ServiceError(code, message, details?)`; codes: unauthenticated | forbidden | not_found | validation_error | plan_limit_exceeded | module_disabled | conflict | internal_error. `serviceErrorStatus` → 401/403/404/400/409/500; internal_error public messages genericized with internalDetail retained server-side (services/context.ts:131-229). Machine-readable sub-codes ride in `details: { code: '...' }` (inventory.ts:2313-2316).
- `ActionResult<T> = {ok:true,data} | {ok:false,error:{code,message,field?,details?}}`; ActionErrorCode = ServiceError codes + 'rate_limited' (packages/core/src/types/action.ts:1-29). Clients branch on error.code / error.details?.reason and show error.message **verbatim** — no central code→copy table.
- `/api/v1` shape: `NextResponse.json({ error: <code>, message, details })` with serviceErrorStatus; 401 {error:'unauthenticated'}; 429 + retry-after (e.g. api/v1/items/sized-variants/route.ts:37-109). Mobile's helper uses the JSON `message` (message wins over error) when parseable, else status-based fallback copy — **a 403 with a JSON message surfaces that exact sentence on mobile with zero client changes** (api-errors.test.ts:21-44).

### 6.4 MFA step-up precedents

- Client: `useStepUp()` → {ensure, modal}; on `error.details?.reason === 'aal2_required'`, `await ensure()` (in-place TOTP, no sign-out) then retry once (auth/step-up-modal.tsx:25-62). Exactly 5 wired sites: restore-snapshot-button, act-as-button, billing-panel, remove-org-dialog, deletion-passphrase-form.
- Server tiers: org-scoped `assertCurrentAal2(ctx)` throws forbidden + {reason:'aal2_required'} (context.ts:248-274); platform tier `checkPlatformAdmin({requireStepUp:true})` (15-min fresh, §2.2). Precedent: impersonation START is step-up-gated; STOP deliberately is not ("removing access is always safe") (actions/platform/impersonation.ts:14-68).

### 6.5 Blocking-screen precedents

- **ABSENT: any maintenance page, org-suspended page, or subscription-lapsed lockout.**
- Existing patterns: (1) `redirect('/onboarding')` when a session has no accepted membership (session.ts:203, 214, 227); (2) hard MFA gate — org policy 'all_required' without a verified factor redirects EVERY dashboard route to `/dashboard/settings/security?mfa=required` from the (dashboard) layout, **with the fix-it page itself exempted** (deliberate, after a redirect-loop bug) ((dashboard)/layout.tsx:123-155); (3) soft state = mfa-required-banner above content; (4) /platform 404s via notFound() for non-admins; mobile: BiometricLockScreen + ColdLaunchSplash full-screen early returns in RootGate, and the forced-signout path.

---

## 7. Permission matrix — TODAY (facts, not design)

Capabilities relevant to the feature, per principal, as currently enforced:

| Capability | viewer | staff | manager | admin | owner | platform admin |
|---|---|---|---|---|---|---|
| See Team page / member list (web) | No (page gates `members:invite`; viewers redirected — page.tsx:26) | per 0207 grants | per 0207 grants | Yes (default) | Yes | via org detail tab (service-role) |
| Read organization_members rows (RLS) | Yes (is_org_member SELECT) | Yes | Yes | Yes | Yes | service-role |
| Remove member (permanent) | No | No | No | Yes (`members:remove` + RLS admin) | Yes | No direct action (has deleteUser instead) |
| Send password reset (own org) | No | No | No | Yes (`members:invite`) | Yes | Yes (any user, cross-org; no step-up today) |
| Impersonate an org (act-as) | — | — | — | — | — | Yes (step-up gated) |
| Delete an auth user | self only (self-delete flow) | self | self | self | self | Yes (platform-admin.ts:485) |
| **Disable an account (temporary)** | **ABSENT** | **ABSENT** | **ABSENT** | **ABSENT** | **ABSENT** | **ABSENT — no action, no field, no UI** |
| **Re-enable an account** | **ABSENT** | **ABSENT** | **ABSENT** | **ABSENT** | **ABSENT** | **ABSENT** |
| **View disable status / reason** | **ABSENT — no field exists on any table** | | | | | |
| View org audit_logs | No | No | Yes (manager+ via rls_manager_org_ids, 0272) | Yes | Yes | service-role |
| View platform_admin_audit | No (RLS zero policies) | No | No | No | No | Yes (/platform/audit, service-role reads) |

---

## 8. Consolidated ABSENT register

Everything below was explicitly verified absent. The design must add or deliberately skip each item.

1. Any account-status column (disabled/suspended/banned/locked) on `user_profiles`, `organization_members`, `organizations`, or `customer_users` — confirmed against prod schema and all migrations.
2. Any code that reads or writes `auth.users.banned_until`; no `auth.admin.updateUserById` call anywhere in the repo (no wrapper/precedent for `ban_duration`).
3. Any auth-time consultation of `user_profiles.deleted_at` (write-only tombstone).
4. A single shared function covering pages + Server Actions + cookie API + Bearer /api/v1 — the minimum covering set is `loadSessionAndContext` + `withApiContext`.
5. Any 'account disabled' error code, copy, or UI on /signin (ActionResult codes limited to validation_error/rate_limited/unauthenticated/forbidden/internal_error paths; toasts only).
6. Any per-request database read of account status in either chokepoint (both read user_profiles/organization_members but select no status field — none exists).
7. Any platform-console UI for disabling users; no /platform/users cross-org list; no dropdown menu or DestructiveConfirm on platform user rows (lone inline button + window.confirm).
8. Middleware coverage of `/api/**` (matcher excludes it by design).
9. An admin-scoped session-revocation primitive: mig 0213 functions are auth.uid()-self-scoped; installed auth-js has no signOut-by-user-id (and the one existing by-user-id call, team.ts:561, is broken as typed — §2.3); no SECURITY DEFINER "revoke sessions of user X" exists.
10. Any RLS-level account-status enforcement — direct PostgREST access from mobile with a live token has no kill switch.
11. `platform_admin_audit` CHECK values (and TS union members) for disabling/re-enabling a user.
12. Org-level audit events for a temporary disable ('user.deactivated' is taken and means removal).
13. Any blocking "account disabled" screen, web or mobile; no maintenance-page precedent at all.
14. Structured mobile API errors (plain Error, no status/code); any sign-out-on-401 interceptor; retry cap/backoff on the legacy outbox; any legacy-queue review UI.
15. AppState-driven startAutoRefresh/stopAutoRefresh wiring on mobile.
16. Push-token deregistration on sign-out or forced revocation.
17. Local-data wipe on FORCED sign-out (scope-local revocation keeps SQLite cache + outbox).
18. `ensureRealtimeAuth()` before the useSessionRevocation subscribe (safe only while the channel stays public).
19. `useSessionRevocation` mounted anywhere but DrawerContent (auth-group and pre-drawer screens have no revocation listener; RootGate has none).
20. Any org-level kill switch (`organizations` has no status column; only 0175 billing dials).
21. A verified hosted JWT-expiry value (dashboard setting; local config says 3600 s; app comments assume ~1 h).
22. Any pgTAP or vitest coverage of account-status behavior (nearest analogues: users.password-reset.test.ts, team.password-reset.test.ts).
23. Any listUsers-based user directory (deliberately replaced by the auth_user_exists_by_email RPC, mig 0097).
24. Any mobile or /api/v1 platform-admin surface (the god-mode console is web-only).

---

## 9. Carry-forward repo constraints (from owner rules / memory)

- Migration numbering: highest on disk is `0307_edit_movement_note_sentinel_guard.sql` (verified 2026-07-31); prod is at 0307 → **next free is 0308**. Migrations are pushed with `supabase db push --linked` only after merge; pending migrations crash pages. Local pgTAP needs `supabase db reset` after new migrations.
- No emojis in any comms/copy; no Claude co-author trailers; never expand secrets in shell; NO GUESS FIXES (deep dive with evidence before fixing); every web feature defaults to mobile unless web-only; simulator-test any mobile change; walk features in Demo Co (org 71b27a4a-7948-4638-bc3f-535974713bd2).
- Recurring bug patterns to check new code against (24), notably: `.update().eq()` fail-open, `alter policy ... with check` REPLACES, requireOrgContext NEXT_REDIRECT in /api, PostgREST `not.in` drops NULLs.
