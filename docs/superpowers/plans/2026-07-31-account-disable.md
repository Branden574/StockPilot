# God-Admin Temporary Account Disable — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a god admin (platform admin) temporarily disable any non-admin account platform-wide from the platform console, kill that user's live sessions immediately, block every subsequent sign-in, page render, API call and offline replay behind one shared guard, show a dedicated "temporarily disabled" screen on web and mobile, and restore everything untouched on re-enable — without deleting data, without reassigning work, and without giving org admins any part of the capability.

**Architecture:** the status is stored twice on purpose, and nothing else in the system is written.

| Layer | Storage | Enforces | Latency |
|---|---|---|---|
| A — app truth | `public.user_profiles.disabled_at` / `disabled_reason` / `disabled_by` (migration 0308) | web pages + Server Actions (`loadSessionAndContext`), every cookie and Bearer API route (`withApiContext`) | next request |
| B — GoTrue mirror | `auth.users.banned_until` via `auth.admin.updateUserById(uid, { ban_duration })` | sign-in, token REFRESH, every `auth.getUser()` — including both `withApiContext` paths | immediate |
| Eviction | `DELETE FROM auth.sessions` (new `admin_revoke_user_sessions`) + the shipped `user:{id}:sessions` / `revoked` broadcast | live devices sign themselves out | ~1 s online |

Layer A alone cannot block a refresh; Layer B alone cannot give a page a structured redirect before the access token expires. Both are required, and the broadcast covers the UX gap for direct PostgREST reads on mobile.

**Tech Stack:** TypeScript, Next.js 16 App Router (RSC + Server Actions), React, Expo/React Native, Supabase Postgres + GoTrue + RLS, zod (`packages/core`), vitest, pgTAP.

---

## Global Constraints

Binding on every task. Copied in substance from the owner brief, `docs/superpowers/specs/2026-07-31-account-disable-architecture-audit.md` ("Audit §n") and `docs/superpowers/specs/2026-07-31-account-disable-design.md` ("Design §n").

1. **LOCAL COMMITS ONLY, on `feat/account-disable`.** Never push, never merge to main, never open a PR, never deploy. Every task ends at a local commit.
2. **NEVER run a migration against production.** No `supabase db push`, no `--linked`, no MCP `apply_migration`, no SQL against `xizpqmhhslgzbuqtjubv`. Migration 0308 is written and exercised LOCALLY only. The owner pushes it post-merge (Audit §9).
3. **pgTAP runs against a freshly reset local database:** `supabase db reset && pnpm db:test`. A bare `pnpm db:test` runs against a stale schema and produces false results (Audit §9).
4. **Mobile tests are pure modules only.** `apps/mobile/vitest.config.ts` includes `src/**/*.test.ts` and nothing under `app/`; anything importing expo/react-native at module scope cannot be tested here. Screens are verified by hand in the iOS simulator, never by asserting an untested claim.
5. **Shared zod, shared copy, and shared codes live in `packages/core`.** Web and Expo import ONE definition of the disabled copy, the reason schema and the structured codes. No duplicated sentences.
6. **God-mode is env-allowlist-only.** The disable capability is NEVER added to the 0207 configurable-permission system, never granted by a DB row, and never exposed to an org role. "No DB write can ever escalate an account to god-mode" (Audit §2.2).
7. **Refuse disabling any allowlisted platform-admin email.** This single rule covers self-disable AND the last-god-admin lockout at once, because the allowlist is deploy-time env and cannot shrink at runtime (Design §3 step 3). No counting logic exists or is needed.
8. **Never reveal the reason or the actor to the disabled user.** The disabled screens show generic copy only; the reason lives in `user_profiles.disabled_reason` and `platform_admin_audit.detail`, both service-role-only surfaces.
9. **Never log tokens, passwords, JWTs, session cookies or the disable reason to a public channel.** The `user:{id}:sessions` broadcast is a PUBLIC channel — payload carries session ids only (Audit §4.3).
10. **Every state transition is compare-and-set and idempotent.** Check the `RETURNING`/`.select()` rows on every update — the repo's recurring `.update().eq()` fail-open bug (Audit §9) is exactly this shape.
11. **B2B `customer_users` are OUT of scope.** They are a separate principal (real `auth.users`, never `organization_members`). The Layer B ban does lock a banned portal user out at sign-in and refresh as a side effect, but no portal disabled screen, no portal UI and no portal test is in scope; Design §10 Q8 stays open.
12. **Financial and operational data is untouched.** Disable writes ONLY `user_profiles` (3 columns), `auth.users.banned_until`, `auth.sessions` (deletes), `platform_admin_audit`. Memberships, stock, movements, orders, POs, picking claims, cycle-count assignments and billing are never written. No work is reassigned.
13. **The OPEN POLICY QUESTIONS from Design §10 stay OPEN.** Do not invent email notifications, push notifications, org-visible `audit_logs` rows, auto-reassignment of assignments, auto-re-enable timers, push-token deregistration, or a local-data wipe. Each is listed at the end of this plan and must be resolved WITH THE OWNER before any of it is built.
14. **TDD with real numbers.** Write the failing test, run it and record the real failure, implement, run it again and record the real pass. Never write "tests pass" without the command output in front of you.
15. **No emojis** anywhere — code, comments, copy, commit messages, docs.
16. **No Claude/Anthropic co-author trailer** on any commit. History is `Branden574` only.
17. **Do NOT reuse `admin.auth.admin.signOut(userId, ...)` anywhere.** auth-js 2.105.1's `signOut(jwt, scope)` takes a JWT, not a user id; the one existing call site is broken as typed (Audit §2.3). Task 3 replaces the mechanism and fixes that call site.
18. **Web-only admin surface.** The action ships on the platform console org-detail Users tab and nowhere else. The org Team page and the mobile admin Users screen are NOT touched — org admins must never see this capability. Mobile ships the disabled SCREEN only. The mobile-parity rule is waived for the action because the god-mode console has no mobile twin (Audit §2.2, Absent #24).

### Required regression assertions

Every task that touches a shared surface must keep these four green.

- **R1 — an ACTIVE user is unaffected.** Sign-in, page render, Server Actions, cookie API and Bearer `/api/v1` behave exactly as before, and `loadSessionAndContext` still issues the same two parallel queries (the status column rides the existing `user_profiles` select).
- **R2 — disable writes nothing else.** After a disable, `organization_members`, `inventory_items`, `stock_movements`, `order_requests`, `cycle_counts` and `purchase_orders` rows for that user are byte-identical to their pre-disable state.
- **R3 — an allowlisted platform-admin target is always refused,** before any write, with `PROTECTED_ADMIN_ACCOUNT`.
- **R4 — re-enable fully restores access.** The user signs in again, lands in the same orgs with the same roles, and every pre-disable row is still there.

### Shared surfaces requiring regression steps

`loadSessionAndContext` (session.ts:74) · `withApiContext` (api-context.ts:202, BOTH branches) · `signInAction` (actions/auth.ts:172) · `TeamService.removeMember` (team.ts:495-601) · mobile `api()` (api.ts:69) and every screen that catches its errors · mobile `drainQueue` (sync.ts:297) · `platform_admin_audit_action_check`.

### Conflicts between the two source documents, and how this plan resolves them

Recorded here so no implementer silently re-litigates them.

| # | Conflict | Resolution in this plan |
|---|---|---|
| C1 | Design §5 writes its own disabled copy; the owner brief specifies exact strings | The BRIEF's strings win, verbatim, and live once in `packages/core` (Task 2). Design §5's wording is superseded. |
| C2 | Design §6 lists only `user_banned` + `account_disabled`; the brief names six SCREAMING_SNAKE codes | Both. `account_disabled` joins `ActionErrorCode` (the transport code); the six named codes are the machine-readable sub-codes carried in `details.code`, which is the repo's established convention (Audit §6.3). `/api/v1` still returns a uniform 401 with no new code (Design §6) — mobile derives `ACCOUNT_TEMPORARILY_DISABLED` locally from the auth probe. |
| C3 | Design §3 step 2 makes the reason free text; the brief requires categories with Other implies notes | Categories + notes, composed server-side into the single `disabled_reason` text column. No schema change beyond 0308. |
| C4 | Design §4 adds a read-only "Disabled" chip to the org Team page; the brief says the Team page is NOT touched | The BRIEF wins — Team page untouched. Org-side visibility is entangled with Design §10 Q2 (org audit visibility), which stays open. |
| C5 | Design §1 claims the flag "rides the existing query with zero extra round trips" in BOTH chokepoints | True for `loadSessionAndContext` (it selects `user_profiles` unconditionally, session.ts:92-96). FALSE for `withApiContext`: `pickActiveMembership` returns at api-context.ts:147-156 without reading `user_profiles` whenever `X-Organization-Id` is present — which is EVERY mobile request (api.ts:75-80). Task 6 therefore issues the status read in parallel with the membership read on that path and documents the one extra round trip. |
| C6 | The brief names audit events `DISABLED_ACCOUNT_LOGIN_BLOCKED` / `DISABLED_ACCOUNT_REQUEST_BLOCKED`; neither source defines where they land | They are emitted as structured observability breadcrumbs (`reportError` tag on web) plus, for sign-in, the existing `user.sign_in_failed` audit row gains `reason: 'account_disabled'`. They are NOT new members of the org `audit_logs` event union, because an org-visible row is exactly what Design §10 Q2 leaves open. |

---

## Migration ledger

Next free number is **0308** (highest on disk and in prod is `0307_edit_movement_note_sentinel_guard.sql`, verified 2026-07-31).

| Migration | Contents | Task | Prod |
|---|---|---|---|
| `0308_account_disable.sql` | `user_profiles.disabled_at/_reason/_by`; `platform_admin_audit_action_check` widened with `user_disabled` + `user_reenabled`; `public.admin_revoke_user_sessions(uuid)` | 1 | NOT pushed in this workstream |

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `supabase/migrations/0308_account_disable.sql` | Columns, CHECK widen, admin session-revocation function | 1 |
| `supabase/tests/0308_account_disable.test.sql` | 16 pgTAP assertions | 1 |
| `packages/core/src/auth/account-status.ts` | Codes, exact copy, reason categories + zod, pure predicate | 2 |
| `packages/core/src/types/action.ts` | `ActionErrorCode` gains `account_disabled` | 2 |
| `apps/web/src/server/services/platform/sessions.ts` | `revokeAllSessionsForUser` (the ONE by-user-id revocation) | 3 |
| `apps/web/src/server/services/team.ts` | Broken `admin.auth.admin.signOut` call site replaced | 3 |
| `apps/web/src/server/services/platform/account-status.ts` | `disableUserAccount` / `reenableUserAccount` | 4 |
| `apps/web/src/server/services/platform/audit.ts` | `PlatformAuditAction` union += two actions | 4 |
| `apps/web/src/server/actions/platform/users.ts` | `disableUserAccountAction` / `reenableUserAccountAction` | 5 |
| `apps/web/src/lib/auth/account-status.ts` | The shared server guard | 6 |
| `apps/web/src/lib/auth/session.ts` | Chokepoint 1 wiring | 6 |
| `apps/web/src/lib/auth/api-context.ts` | Chokepoint 2 wiring (both branches) | 6 |
| `apps/web/src/app/account-disabled/page.tsx` | The blocked-route screen | 7 |
| `apps/web/src/server/actions/auth.ts` | `user_banned` branch in `signInAction` | 7 |
| `apps/web/src/components/auth/sign-in-form.tsx` | Routes `account_disabled` to the screen | 7 |
| `apps/web/src/components/platform/user-actions-menu.tsx` | Three-dot menu (reset / disable / re-enable) | 8 |
| `apps/web/src/components/platform/disable-account-dialog.tsx` | Critical confirm + reason category + notes | 8 |
| `apps/web/src/server/services/platform/orgs.ts` | `getOrgMembers` returns `disabledAt` | 8 |
| `apps/web/src/app/(platform)/platform/orgs/[id]/page.tsx` | Users tab renders the menu + chip | 8 |
| `apps/mobile/src/lib/api.ts` | `ApiError { status, code }` | 9 |
| `apps/mobile/src/lib/account-disabled-state.ts` | Pure subscribable flag | 10 |
| `apps/mobile/src/lib/account-disabled-probe.ts` | Pure 401 to disabled classifier | 10 |
| `apps/mobile/src/components/account-disabled-screen.tsx` | Full-screen state | 10 |
| `apps/mobile/app/_layout.tsx` | RootGate renders it; revocation listener moved here | 10 |
| `apps/mobile/src/components/drawer-content.tsx` | Listener removed (moved to RootGate) | 10 |
| `apps/mobile/src/lib/drain-failure.ts` | Pure terminal-vs-retry classifier | 11 |
| `apps/mobile/src/lib/queue.ts` | `rejected` terminal status | 11 |
| `apps/mobile/src/lib/sync.ts` | Drain uses the classifier | 11 |
| `docs/superpowers/reports/2026-07-31-account-disable-verification.md` | Real results of Task 12 | 12 |
| `docs/superpowers/specs/2026-07-31-account-disable-deliverables.md` | Matrices + files changed + open decisions | 13 |

---

# Phase 1 — Data and vocabulary

## Task 1: Migration 0308 — status columns, admin session revocation, audit vocabulary

Everything downstream needs these three things to exist. Additive only: three nullable columns with no default and no backfill, one new function, and a CHECK constraint re-created with its full existing value list plus two.

**Files:**
- Create: `supabase/migrations/0308_account_disable.sql`
- Create: `supabase/tests/0308_account_disable.test.sql`

**Interfaces:**
- Produces for Tasks 3, 4, 6, 8: `public.user_profiles.disabled_at | disabled_reason | disabled_by`; `public.admin_revoke_user_sessions(uuid) returns setof uuid`; `platform_admin_audit.action` accepts `'user_disabled'` and `'user_reenabled'`.
- Consumes: nothing.

**Steps:**

- [ ] Write the pgTAP file FIRST — `supabase/tests/0308_account_disable.test.sql`:

```sql
-- supabase/tests/0308_account_disable.test.sql
-- Proves migration 0308: the god-admin account-disable substrate.
--
-- Three independent things are asserted:
--   (a) user_profiles carries the three additive status columns, nullable, with
--       no default — an existing row must read as ACTIVE without a backfill;
--   (b) platform_admin_audit's action CHECK accepts the two new actions AND
--       still accepts every value it accepted before. The constraint is
--       DROPPED and RE-ADDED (0241's precedent), which is the CHECK analogue of
--       recurring bug #24: a re-add that forgets a value silently breaks every
--       existing god-mode action, so the old values are asserted explicitly;
--   (c) admin_revoke_user_sessions deletes exactly ONE user's auth.sessions
--       rows, returns their ids, is SECURITY DEFINER, and is executable by
--       service_role only. The 0213 self-service functions are auth.uid()-
--       scoped and cannot be reused by an admin acting on someone else, and the
--       installed auth-js has no signOut-by-user-id — this function is the ONLY
--       by-user-id revocation the platform gets.
--
-- Run via `supabase test db` after `supabase db reset`.

begin;

select plan(16);

\set u_target '\'ad080000-0000-0000-0000-0000000000a1\''
\set u_other  '\'ad080000-0000-0000-0000-0000000000a2\''
\set s_t1     '\'ad080000-0000-0000-0000-0000000000b1\''
\set s_t2     '\'ad080000-0000-0000-0000-0000000000b2\''
\set s_o1     '\'ad080000-0000-0000-0000-0000000000c1\''
\set actor    '\'ad080000-0000-0000-0000-0000000000d1\''

-- ── (a) columns ────────────────────────────────────────────────────────────
select has_column('public', 'user_profiles', 'disabled_at',     'user_profiles.disabled_at exists');
select has_column('public', 'user_profiles', 'disabled_reason', 'user_profiles.disabled_reason exists');
select has_column('public', 'user_profiles', 'disabled_by',     'user_profiles.disabled_by exists');
select col_type_is('public', 'user_profiles', 'disabled_at', 'timestamp with time zone',
  'disabled_at is timestamptz');
select col_hasnt_default('public', 'user_profiles', 'disabled_at',
  'disabled_at has NO default — an existing row reads as ACTIVE with no backfill');

insert into auth.users (id, email, raw_user_meta_data) values
  (:u_target, 'target@ad08.test', '{}'::jsonb),
  (:u_other,  'other@ad08.test',  '{}'::jsonb),
  (:actor,    'actor@ad08.test',  '{}'::jsonb);

select is(
  (select disabled_at from public.user_profiles where id = :u_target),
  null,
  'a freshly created profile is ACTIVE (disabled_at null)'
);

-- ── (b) audit action vocabulary ────────────────────────────────────────────
select lives_ok(
  $$insert into public.platform_admin_audit (actor_user_id, actor_email, action, target_user_id)
    values ('ad080000-0000-0000-0000-0000000000d1', 'actor@ad08.test', 'user_disabled',
            'ad080000-0000-0000-0000-0000000000a1')$$,
  'CHECK accepts user_disabled'
);
select lives_ok(
  $$insert into public.platform_admin_audit (actor_user_id, actor_email, action, target_user_id)
    values ('ad080000-0000-0000-0000-0000000000d1', 'actor@ad08.test', 'user_reenabled',
            'ad080000-0000-0000-0000-0000000000a1')$$,
  'CHECK accepts user_reenabled'
);
select lives_ok(
  $$insert into public.platform_admin_audit (actor_user_id, actor_email, action)
    values ('ad080000-0000-0000-0000-0000000000d1', 'actor@ad08.test', 'password_reset_sent')$$,
  'CHECK still accepts password_reset_sent (pre-0308 value)'
);
select lives_ok(
  $$insert into public.platform_admin_audit (actor_user_id, actor_email, action)
    values ('ad080000-0000-0000-0000-0000000000d1', 'actor@ad08.test', 'org_deleted')$$,
  'CHECK still accepts org_deleted (pre-0308 value)'
);
select throws_ok(
  $$insert into public.platform_admin_audit (actor_user_id, actor_email, action)
    values ('ad080000-0000-0000-0000-0000000000d1', 'actor@ad08.test', 'user_vaporized')$$,
  '23514',
  null,
  'CHECK still rejects an unknown action'
);

-- ── (c) admin_revoke_user_sessions ─────────────────────────────────────────
select has_function('public', 'admin_revoke_user_sessions', array['uuid'],
  'admin_revoke_user_sessions(uuid) exists');
select is(
  (select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'admin_revoke_user_sessions'),
  true,
  'admin_revoke_user_sessions is SECURITY DEFINER'
);
select ok(
  not has_function_privilege('authenticated', 'public.admin_revoke_user_sessions(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.admin_revoke_user_sessions(uuid)', 'execute'),
  'authenticated and anon CANNOT execute it — an ordinary user must never kill another user''s sessions'
);
select ok(
  has_function_privilege('service_role', 'public.admin_revoke_user_sessions(uuid)', 'execute'),
  'service_role CAN execute it — this is the platform actions'' admin client'
);

insert into auth.sessions (id, user_id, created_at, updated_at) values
  (:s_t1, :u_target, now(), now()),
  (:s_t2, :u_target, now(), now()),
  (:s_o1, :u_other,  now(), now());

select set_eq(
  $$select public.admin_revoke_user_sessions('ad080000-0000-0000-0000-0000000000a1'::uuid)$$,
  array['ad080000-0000-0000-0000-0000000000b1'::uuid,
        'ad080000-0000-0000-0000-0000000000b2'::uuid],
  'returns exactly the target user''s revoked session ids'
);
select is(
  (select count(*)::int from auth.sessions
    where user_id in ('ad080000-0000-0000-0000-0000000000a1'::uuid,
                      'ad080000-0000-0000-0000-0000000000a2'::uuid)),
  1,
  'the OTHER user''s session survives — revocation is scoped to one user id'
);

select * from finish();
rollback;
```

- [ ] Run `supabase db reset && pnpm db:test 2>&1 | grep -E "0308|not ok|Result:"`. Expect failures for every 0308 assertion (the columns and function do not exist yet). Record the real output.
- [ ] Create `supabase/migrations/0308_account_disable.sql`:

```sql
-- 0308_account_disable.sql
-- God-admin temporary account disable. ADDITIVE ONLY. Nothing is backfilled,
-- nothing is dropped, and no existing row changes meaning: a null disabled_at
-- IS the active state, so every pre-existing profile stays active untouched.
--
-- This migration is NOT pushed to production in this workstream. The owner
-- pushes it with `supabase db push --linked` after merge; pending migrations
-- crash pages, so the web deploy must follow, never lead.

-- ── 1) Layer A: the app-level account status ───────────────────────────────
-- Read per request by loadSessionAndContext (lib/auth/session.ts) and
-- withApiContext (lib/auth/api-context.ts). Both look the row up by PRIMARY
-- KEY, so this is not a hot-path filter and needs no index — same posture as
-- 0171's user_profiles.deleted_at.
alter table public.user_profiles
  add column if not exists disabled_at timestamptz,
  add column if not exists disabled_reason text,
  add column if not exists disabled_by uuid;

comment on column public.user_profiles.disabled_at is
  'Non-null = platform-admin temporary disable, effective across EVERY org. '
  'Null = active. Read per-request by loadSessionAndContext and withApiContext.';
comment on column public.user_profiles.disabled_reason is
  'Operator-supplied reason (category, plus notes when the category is other). '
  'Service-role visible only — never shown to the disabled user.';
comment on column public.user_profiles.disabled_by is
  'auth uid of the platform admin who disabled the account. Attribution also '
  'lands in platform_admin_audit with the actor email.';

-- ── 2) Widen the god-mode audit action vocabulary ──────────────────────────
-- Precedent: 0241 dropped and re-added this same constraint to add two values.
-- The re-add MUST restate every previously accepted value; omitting one
-- silently breaks an existing god-mode action at insert time. This is the
-- CHECK-constraint analogue of recurring bug #24 (`alter policy ... with check`
-- REPLACES rather than adds).
alter table public.platform_admin_audit
  drop constraint if exists platform_admin_audit_action_check;
alter table public.platform_admin_audit
  add constraint platform_admin_audit_action_check
  check (action in (
    'viewed_org', 'acted_as_start', 'acted_as_end',
    'billing_changed', 'password_reset_sent',
    'org_provisioned', 'ticket_updated',
    'deletion_passphrase_set', 'org_deleted',
    'user_disabled', 'user_reenabled'
  ));

-- ── 3) Admin-scoped session revocation ─────────────────────────────────────
-- The 0213 functions (list_my_sessions / revoke_my_session /
-- revoke_my_other_sessions) are auth.uid()-scoped: a god admin cannot use them
-- against another user. The installed auth-js 2.105.1 has NO signOut-by-user-id
-- (its signOut takes a JWT), so the existing team.ts call that passes a uuid is
-- broken as typed. This function is the ONE supported by-user-id revocation.
--
-- auth.refresh_tokens.session_id references auth.sessions(id) ON DELETE CASCADE
-- (prod-verified), so deleting the session rows cascades the refresh tokens
-- away and the next refresh attempt fails.
create or replace function public.admin_revoke_user_sessions(target_user_id uuid)
returns setof uuid
language sql
security definer
set search_path = auth, pg_temp
as $$
  delete from auth.sessions where user_id = target_user_id returning id;
$$;

-- Locked to the service-role client used behind the platform-admin gate. An
-- ordinary authenticated user must never be able to kill another user's
-- sessions, which is exactly what a public EXECUTE grant here would allow.
revoke all on function public.admin_revoke_user_sessions(uuid) from public;
revoke all on function public.admin_revoke_user_sessions(uuid) from anon;
revoke all on function public.admin_revoke_user_sessions(uuid) from authenticated;
grant execute on function public.admin_revoke_user_sessions(uuid) to service_role;
```

- [ ] Run `supabase db reset && pnpm db:test 2>&1 | grep -E "0308|not ok|Result:"`. All 16 assertions must pass and no other test file may regress. Record the real output.
- [ ] Regenerate local types so the new columns type-check downstream: `pnpm db:types:local`. Confirm `packages/core/src/types/database.ts` changed and `pnpm typecheck` is clean.
- [ ] Commit: `git commit -m "feat(auth): migration 0308 — account-disable columns, session revocation, audit actions"`.

---

## Task 2: Shared account-status vocabulary (pure core)

One definition of the codes, the exact user-facing copy, the reason categories and the active/disabled predicate, imported by the web server, the web client and Expo. Nothing else in the plan can be written until these names exist.

**Files:**
- Create: `packages/core/src/auth/account-status.ts`
- Create: `packages/core/src/auth/account-status.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/types/action.ts`

**Interfaces:**
- Produces for Tasks 4, 5, 6, 7, 8, 10, 11: `ACCOUNT_DISABLE_CODES`, `AccountDisableCode`, `ACCOUNT_DISABLED_TITLE`, `ACCOUNT_DISABLED_MESSAGE`, `ACCOUNT_DISABLED_PATH`, `DISABLE_REASON_CATEGORIES`, `DISABLE_REASON_CATEGORY_LABELS`, `DisableReasonCategory`, `disableReasonSchema`, `DisableReasonInput`, `composeDisabledReason`, `isAccountDisabled`, `DISABLED_ACCOUNT_EVENTS`; and `ActionErrorCode` gains `'account_disabled'`.
- Consumes: `zod`.

**Steps:**

- [ ] Write `packages/core/src/auth/account-status.test.ts` FIRST:

```ts
import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_DISABLED_MESSAGE,
  ACCOUNT_DISABLED_PATH,
  ACCOUNT_DISABLED_TITLE,
  ACCOUNT_DISABLE_CODES,
  DISABLE_REASON_CATEGORIES,
  composeDisabledReason,
  disableReasonSchema,
  isAccountDisabled,
} from './account-status';

describe('disabled copy', () => {
  it('is the owner-approved wording, character for character', () => {
    expect(ACCOUNT_DISABLED_TITLE).toBe('Your account has been temporarily disabled');
    expect(ACCOUNT_DISABLED_MESSAGE).toBe(
      'Your StockPilot account has been temporarily disabled. Please contact your system administrator for assistance.',
    );
    expect(ACCOUNT_DISABLED_PATH).toBe('/account-disabled');
  });

  it('never leaks a reason, an actor or a date to the user', () => {
    const copy = `${ACCOUNT_DISABLED_TITLE} ${ACCOUNT_DISABLED_MESSAGE}`.toLowerCase();
    for (const leak of ['reason', 'because', 'admin@', 'disabled by', 'until']) {
      expect(copy).not.toContain(leak);
    }
  });
});

describe('ACCOUNT_DISABLE_CODES', () => {
  it('carries every code the surfaces branch on', () => {
    expect(ACCOUNT_DISABLE_CODES).toEqual([
      'ACCOUNT_TEMPORARILY_DISABLED',
      'ACCOUNT_ALREADY_DISABLED',
      'ACCOUNT_NOT_DISABLED',
      'ACCOUNT_DISABLE_NOT_AUTHORIZED',
      'PROTECTED_ADMIN_ACCOUNT',
      'ACCOUNT_DISABLE_REASON_REQUIRED',
      'ACCOUNT_NOT_FOUND',
    ]);
  });
});

describe('isAccountDisabled', () => {
  it('treats null, undefined and a missing row as ACTIVE', () => {
    expect(isAccountDisabled({ disabled_at: null })).toBe(false);
    expect(isAccountDisabled({ disabled_at: undefined })).toBe(false);
    expect(isAccountDisabled(null)).toBe(false);
    expect(isAccountDisabled(undefined)).toBe(false);
  });

  it('treats any timestamp as DISABLED, including a future one', () => {
    expect(isAccountDisabled({ disabled_at: '2026-07-31T10:00:00.000Z' })).toBe(true);
    expect(isAccountDisabled({ disabled_at: '2099-01-01T00:00:00.000Z' })).toBe(true);
  });

  it('treats a blank string as ACTIVE rather than crashing', () => {
    expect(isAccountDisabled({ disabled_at: '   ' })).toBe(false);
  });
});

describe('disableReasonSchema', () => {
  it('accepts a known category with no notes', () => {
    const res = disableReasonSchema.safeParse({ category: 'security_investigation' });
    expect(res.success).toBe(true);
  });

  it('REQUIRES notes when the category is other', () => {
    const res = disableReasonSchema.safeParse({ category: 'other', notes: '   ' });
    expect(res.success).toBe(false);
    expect(res.success === false && res.error.issues[0]?.path).toEqual(['notes']);
  });

  it('accepts other with real notes', () => {
    expect(disableReasonSchema.safeParse({ category: 'other', notes: 'Duplicate account' }).success).toBe(true);
  });

  it('rejects an unknown category', () => {
    expect(disableReasonSchema.safeParse({ category: 'vibes' }).success).toBe(false);
  });

  it('caps notes at 500 characters', () => {
    expect(disableReasonSchema.safeParse({ category: 'other', notes: 'x'.repeat(501) }).success).toBe(false);
    expect(disableReasonSchema.safeParse({ category: 'other', notes: 'x'.repeat(500) }).success).toBe(true);
  });

  it('exposes every category to the dialog', () => {
    expect(DISABLE_REASON_CATEGORIES).toEqual([
      'security_investigation',
      'offboarding_in_progress',
      'suspected_compromise',
      'policy_violation',
      'customer_request',
      'other',
    ]);
  });
});

describe('composeDisabledReason', () => {
  it('stores the category label alone when there are no notes', () => {
    expect(composeDisabledReason({ category: 'policy_violation' })).toBe('Policy violation');
  });

  it('appends trimmed notes after an em dash', () => {
    expect(composeDisabledReason({ category: 'other', notes: '  Duplicate account  ' })).toBe(
      'Other — Duplicate account',
    );
  });

  it('never returns an empty string for a valid input', () => {
    for (const category of DISABLE_REASON_CATEGORIES) {
      const composed = composeDisabledReason({ category, notes: category === 'other' ? 'n' : undefined });
      expect(composed.trim().length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] Run `pnpm --filter @stockpilot/core test 2>&1 | tail -20`. Expect a module-not-found failure for `./account-status`. Record it.
- [ ] Create `packages/core/src/auth/account-status.ts`:

```ts
import { z } from 'zod';

/**
 * Shared vocabulary for the god-admin temporary account disable.
 *
 * This module is PURE (zod only, no platform imports) so the web server, the
 * web client and the Expo app all read ONE definition of the codes, the
 * user-facing sentences and the reason rules. The copy in particular must never
 * be retyped anywhere: it is owner-approved wording and it deliberately reveals
 * nothing about why the account was disabled or who did it.
 */

/**
 * Machine-readable sub-codes. These ride in `details.code` on an ActionResult /
 * ServiceError (the repo's existing convention) rather than becoming top-level
 * transport codes: `/api/v1` deliberately answers a disabled caller with the
 * same uniform 401 every unauthenticated caller gets, so an API probe teaches
 * an attacker nothing. Mobile derives ACCOUNT_TEMPORARILY_DISABLED locally from
 * its auth probe instead of being told by the server.
 *
 * ACCOUNT_NOT_FOUND is not in the original brief's list; it exists because
 * `auth.admin.getUserById` can legitimately miss (a user deleted between the
 * page render and the click) and that must not be reported as a disable
 * failure.
 */
export const ACCOUNT_DISABLE_CODES = [
  /** The caller's own account is disabled — the enforcement outcome. */
  'ACCOUNT_TEMPORARILY_DISABLED',
  /** Disable was requested for an account that is already disabled (no-op). */
  'ACCOUNT_ALREADY_DISABLED',
  /** Re-enable was requested for an account that is not disabled (no-op). */
  'ACCOUNT_NOT_DISABLED',
  /** The caller is not a platform admin, or the step-up has gone stale. */
  'ACCOUNT_DISABLE_NOT_AUTHORIZED',
  /** The target is on the platform-admin allowlist and can never be disabled. */
  'PROTECTED_ADMIN_ACCOUNT',
  /** A reason is mandatory on every disable. */
  'ACCOUNT_DISABLE_REASON_REQUIRED',
  /** No auth user with that id. */
  'ACCOUNT_NOT_FOUND',
] as const;
export type AccountDisableCode = (typeof ACCOUNT_DISABLE_CODES)[number];

/**
 * Observability event names for blocked traffic. These are structured
 * breadcrumbs (error-reporter tags / the existing user.sign_in_failed reason),
 * NOT new org-visible `audit_logs` events: whether an org may see that one of
 * its members was disabled by the platform is an OPEN policy question and must
 * not be answered by an implementation detail.
 */
export const DISABLED_ACCOUNT_EVENTS = {
  loginBlocked: 'DISABLED_ACCOUNT_LOGIN_BLOCKED',
  requestBlocked: 'DISABLED_ACCOUNT_REQUEST_BLOCKED',
} as const;

/** Web route for the blocked-route screen. Mobile renders the same copy. */
export const ACCOUNT_DISABLED_PATH = '/account-disabled';

/** Owner-approved wording. Do not paraphrase, shorten or localize in place. */
export const ACCOUNT_DISABLED_TITLE = 'Your account has been temporarily disabled';
export const ACCOUNT_DISABLED_MESSAGE =
  'Your StockPilot account has been temporarily disabled. Please contact your system administrator for assistance.';

/** Reason taxonomy shown in the confirm dialog. `other` requires free text. */
export const DISABLE_REASON_CATEGORIES = [
  'security_investigation',
  'offboarding_in_progress',
  'suspected_compromise',
  'policy_violation',
  'customer_request',
  'other',
] as const;
export type DisableReasonCategory = (typeof DISABLE_REASON_CATEGORIES)[number];

export const DISABLE_REASON_CATEGORY_LABELS: Record<DisableReasonCategory, string> = {
  security_investigation: 'Security investigation',
  offboarding_in_progress: 'Offboarding in progress',
  suspected_compromise: 'Suspected account compromise',
  policy_violation: 'Policy violation',
  customer_request: 'Customer request',
  other: 'Other',
};

/**
 * A reason is MANDATORY on every disable (owner requirement). The category is
 * always required; notes are required only for `other`, where the category
 * alone carries no information. Both the dialog and the server action parse
 * with this exact schema, so a payload valid on one is valid on the other.
 */
export const disableReasonSchema = z
  .object({
    category: z.enum(DISABLE_REASON_CATEGORIES),
    notes: z.string().max(500, 'Keep the note under 500 characters.').optional(),
  })
  .superRefine((value, ctx) => {
    if (value.category !== 'other') return;
    if (!value.notes || value.notes.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['notes'],
        message: 'Describe the reason when the category is Other.',
      });
    }
  });
export type DisableReasonInput = z.infer<typeof disableReasonSchema>;

/**
 * Flattens the structured reason into the single `user_profiles.disabled_reason`
 * text column. Composed on the SERVER so the stored string always matches the
 * taxonomy, whatever a client sends.
 */
export function composeDisabledReason(input: DisableReasonInput): string {
  const label = DISABLE_REASON_CATEGORY_LABELS[input.category];
  const notes = input.notes?.trim() ?? '';
  return notes.length > 0 ? `${label} — ${notes}` : label;
}

/**
 * The ONE predicate for "is this account disabled". Any non-blank timestamp
 * means disabled — including a future one, because a clock-skewed or
 * hand-written value must fail CLOSED, never open. A missing row (a user with
 * no profile) is treated as ACTIVE: absence of a profile is an onboarding
 * state, not a disable, and the membership checks already handle it.
 */
export function isAccountDisabled(
  profile: { disabled_at?: string | null } | null | undefined,
): boolean {
  const at = profile?.disabled_at;
  if (typeof at !== 'string') return false;
  return at.trim().length > 0;
}
```

- [ ] Add the export to `packages/core/src/index.ts` immediately after the `export * from './b2b/pricing-mode';` line:

```ts
export * from './auth/account-status';
```

- [ ] Add `'account_disabled'` to `ActionErrorCode` in `packages/core/src/types/action.ts`, replacing the union with:

```ts
export type ActionErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'validation_error'
  | 'plan_limit_exceeded'
  | 'module_disabled'
  | 'conflict'
  | 'rate_limited'
  /**
   * The credentials were VALID but the account is disabled by a platform
   * admin. Distinct from `unauthenticated` on purpose: the sign-in form routes
   * this one to the dedicated /account-disabled screen instead of toasting
   * "Invalid email or password", which would send a locked-out user on a
   * password-reset wild goose chase.
   */
  | 'account_disabled'
  | 'internal_error';
```

- [ ] Run `pnpm --filter @stockpilot/core test 2>&1 | tail -20`. All 15 assertions in the new file must pass. Run `pnpm typecheck` — clean.
- [ ] Commit: `git commit -m "feat(auth): shared account-status vocabulary, copy and reason schema"`.

---

# Phase 2 — Server enforcement

## Task 3: By-user-id session revocation, and the broken `signOut` call site it replaces

`TeamService.removeMember` calls `admin.auth.admin.signOut(removedUserId, 'global')` (team.ts:561). auth-js 2.105.1's signature is `signOut(jwt: string, scope?: SignOutScope)` with jsdoc "@param jwt A valid, logged-in JWT" — the call passes a bare uuid and is expected to error at runtime, silently recording `session_revoked` correctly only because the surrounding code is best-effort. This task introduces the ONE supported replacement and fixes that call site, because the disable flow is about to depend on the same mechanism.

**Files:**
- Create: `apps/web/src/server/services/platform/sessions.ts`
- Create: `apps/web/src/server/services/platform/sessions.test.ts`
- Modify: `apps/web/src/server/services/team.ts`

**Interfaces:**
- Produces for Tasks 4, 12: `revokeAllSessionsForUser(userId): Promise<{ ok: boolean; sessionIds: string[] }>`.
- Consumes from Task 1: `public.admin_revoke_user_sessions(uuid)`.

**Steps:**

- [ ] Write `apps/web/src/server/services/platform/sessions.test.ts` FIRST:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The repo's only prior by-user-id sign-out (team.ts) passed a uuid to
 * auth-js's signOut(jwt, scope), which takes a JWT. It could never have worked.
 * These pin the replacement: one RPC, one user id, ids returned, and a failure
 * that reports rather than throws.
 */

const rpc = vi.fn();
const reportError = vi.fn(async () => {});

vi.mock('@/lib/error-reporter', () => ({ reportError: (...a: unknown[]) => reportError(...a) }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ rpc: (...a: unknown[]) => rpc(...a) }),
}));

import { revokeAllSessionsForUser } from './sessions';

const USER = '55555555-5555-5555-5555-555555555555';

describe('revokeAllSessionsForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpc.mockResolvedValue({ data: ['s-1', 's-2'], error: null });
  });

  it('calls the admin RPC with the target user id and returns the revoked ids', async () => {
    const res = await revokeAllSessionsForUser(USER);

    expect(rpc).toHaveBeenCalledWith('admin_revoke_user_sessions', { target_user_id: USER });
    expect(res).toEqual({ ok: true, sessionIds: ['s-1', 's-2'] });
  });

  it('reports ok with zero ids when the user had no live sessions', async () => {
    rpc.mockResolvedValue({ data: [], error: null });

    expect(await revokeAllSessionsForUser(USER)).toEqual({ ok: true, sessionIds: [] });
  });

  it('never throws when the RPC fails — it reports and returns ok:false', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'permission denied' } });

    const res = await revokeAllSessionsForUser(USER);

    expect(res).toEqual({ ok: false, sessionIds: [] });
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('tolerates a null data payload', async () => {
    rpc.mockResolvedValue({ data: null, error: null });

    expect(await revokeAllSessionsForUser(USER)).toEqual({ ok: true, sessionIds: [] });
  });
});

// The old, broken mechanism must not survive anywhere.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('the broken by-user-id signOut is gone', () => {
  const src = readFileSync(join(__dirname, '../team.ts'), 'utf8');

  it('team.ts no longer calls auth.admin.signOut', () => {
    expect(src).not.toContain('auth.admin.signOut');
  });

  it('team.ts revokes through the supported helper instead', () => {
    expect(src).toContain('revokeAllSessionsForUser');
  });
});
```

- [ ] Run `pnpm --filter @stockpilot/web test src/server/services/platform/sessions.test.ts 2>&1 | tail -20`. Expect a module-not-found failure. Record it.
- [ ] Create `apps/web/src/server/services/platform/sessions.ts`:

```ts
import 'server-only';

import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Revoke EVERY auth session belonging to one user, by user id.
 *
 * This is the only supported by-user-id revocation in the codebase:
 *
 *   - migration 0213's revoke_my_session / revoke_my_other_sessions are
 *     auth.uid()-scoped, so an admin cannot use them against someone else;
 *   - the installed auth-js 2.105.1 has NO signOut-by-user-id — its
 *     `signOut(jwt, scope)` takes a JWT, which is why the previous
 *     `admin.auth.admin.signOut(userId, 'global')` in TeamService could never
 *     have worked;
 *   - the service-role client cannot run raw SQL against the auth schema.
 *
 * So it goes through the SECURITY DEFINER function added in 0308, which deletes
 * the user's auth.sessions rows. auth.refresh_tokens cascades on that delete,
 * so the next refresh attempt fails and the device is out for good once its
 * current access token expires. Pair it with the user:{id}:sessions broadcast
 * for instant eviction and with the GoTrue ban to block re-authentication.
 *
 * Best-effort by design: callers (member removal, account disable) have already
 * made the authoritative change, so a revocation failure must be reported, not
 * thrown — it degrades to "the device coasts until its token expires".
 */
export async function revokeAllSessionsForUser(
  userId: string,
): Promise<{ ok: boolean; sessionIds: string[] }> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc('admin_revoke_user_sessions', {
    target_user_id: userId,
  });

  if (error) {
    await reportError(new Error(error.message), {
      tag: 'platform.revoke-sessions',
      extra: { userId },
    });
    return { ok: false, sessionIds: [] };
  }

  const rows = (data ?? []) as unknown;
  const sessionIds = Array.isArray(rows)
    ? rows
        .map((r) => (typeof r === 'string' ? r : ((r as { id?: unknown })?.id as string | undefined)))
        .filter((id): id is string => typeof id === 'string')
    : [];

  return { ok: true, sessionIds };
}
```

- [ ] In `apps/web/src/server/services/team.ts`, add the import near the other service imports:

```ts
import { revokeAllSessionsForUser } from '@/server/services/platform/sessions';
```

- [ ] In the same file, replace the broken revocation block inside `removeMember` (the `// Kill the removed user's auth sessions globally.` comment through `sessionRevoked = !signOutErr;`) with:

```ts
      // Kill the removed user's auth sessions. This forces them to sign in
      // again — at which point RLS + the missing membership row keep them out
      // of this org. If the user belongs to multiple orgs we accept the
      // collateral sign-out (rare; membership is invite-only).
      //
      // This used to call `admin.auth.admin.signOut(removedUserId, 'global')`,
      // which could never have worked: auth-js's signOut takes a JWT, not a
      // user id, so the call errored and the audit row recorded
      // session_revoked=false every time. It now goes through the 0308
      // admin_revoke_user_sessions function, which deletes the user's
      // auth.sessions rows (refresh tokens cascade).
      const revoked = await revokeAllSessionsForUser(removedUserId);
      sessionRevoked = revoked.ok;
      sessionsRevokedCount = revoked.sessionIds.length;
```

- [ ] In the same function, declare the new counter beside `sessionRevoked` (`let sessionsRevokedCount = 0;`) and widen the existing `user.deactivated` audit `extra` to carry it:

```ts
        extra: {
          assignments_cleared: assignmentsCleared,
          session_revoked: sessionRevoked,
          sessions_revoked_count: sessionsRevokedCount,
        },
```

- [ ] Run `pnpm --filter @stockpilot/web test src/server/services/platform/sessions.test.ts 2>&1 | tail -20`. All 6 assertions must pass. Run `pnpm typecheck` — clean.
- [ ] **Regression:** confirm `removeMember`'s behaviour is otherwise unchanged — membership deletion, warehouse-assignment clearing, the `user.deactivated` row and the conditional `user.session.invalidated` row all still fire in the same order.
- [ ] Commit: `git commit -m "fix(auth): revoke sessions by user id through 0308 instead of the broken admin signOut"`.

---

## Task 4: The disable / re-enable service

The whole state machine in one testable place: verified-email lookup, protected-admin refusal, the compare-and-set that is the linearization point, the GoTrue ban, session revocation, the eviction broadcast, and the audit row. The action layer above it does nothing but gate and translate.

**Files:**
- Create: `apps/web/src/server/services/platform/account-status.ts`
- Create: `apps/web/src/server/services/platform/account-status.test.ts`
- Modify: `apps/web/src/server/services/platform/audit.ts`

**Interfaces:**
- Produces for Task 5: `disableUserAccount(input)`, `reenableUserAccount(input)`, `DisableUserAccountResult`, `ReenableUserAccountResult`.
- Consumes from Task 2: `ACCOUNT_DISABLE_CODES`. From Task 3: `revokeAllSessionsForUser`. From Task 1: the columns and audit actions.

**Steps:**

- [ ] Widen the audit union in `apps/web/src/server/services/platform/audit.ts` (this must match 0308's CHECK exactly):

```ts
export type PlatformAuditAction =
  | 'viewed_org'
  | 'acted_as_start'
  | 'acted_as_end'
  | 'billing_changed'
  | 'password_reset_sent'
  | 'org_provisioned'
  | 'ticket_updated'
  | 'deletion_passphrase_set'
  | 'org_deleted'
  /** Temporary platform-wide account disable (migration 0308). */
  | 'user_disabled'
  | 'user_reenabled';
```

- [ ] Write `apps/web/src/server/services/platform/account-status.test.ts` FIRST:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The disable state machine. Every assertion here maps to a rule the owner
 * stated: a platform admin can never be disabled (which is also what makes
 * self-disable and last-admin lockout impossible), a reason is mandatory, the
 * transition is compare-and-set so a double click cannot double-audit, and a
 * partial failure heals by pressing the button again.
 */

const getUserById = vi.fn();
const updateUserById = vi.fn();
const revokeAllSessionsForUser = vi.fn();
const broadcastToChannel = vi.fn(async () => {});
const recordPlatformAudit = vi.fn(async () => {});
const reportError = vi.fn(async () => {});

const dbState: { update: { data: Array<{ id: string }> | null; error: { message: string } | null } } = {
  update: { data: [{ id: 'target' }], error: null },
};
const updateArgs: Array<Record<string, unknown>> = [];

vi.mock('@/lib/error-reporter', () => ({ reportError: (...a: unknown[]) => reportError(...a) }));
vi.mock('@/lib/realtime/broadcast', () => ({
  broadcastToChannel: (...a: unknown[]) => broadcastToChannel(...a),
}));
vi.mock('@/server/services/platform/sessions', () => ({
  revokeAllSessionsForUser: (...a: unknown[]) => revokeAllSessionsForUser(...a),
}));
vi.mock('@/server/services/platform/audit', () => ({
  recordPlatformAudit: (...a: unknown[]) => recordPlatformAudit(...a),
}));
vi.mock('@/lib/auth/platform-admin', () => ({
  isPlatformAdmin: (email: string | null | undefined) =>
    typeof email === 'string' && email.toLowerCase() === 'god@stockpilotusa.com',
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    auth: { admin: { getUserById, updateUserById } },
    from: () => {
      const q: Record<string, unknown> = {};
      q.update = vi.fn((patch: Record<string, unknown>) => {
        updateArgs.push(patch);
        return q;
      });
      q.eq = vi.fn(() => q);
      q.is = vi.fn(() => q);
      q.not = vi.fn(() => q);
      q.select = vi.fn(async () => dbState.update);
      return q;
    },
  }),
}));

import { disableUserAccount, reenableUserAccount } from './account-status';

const TARGET = '11111111-1111-1111-1111-111111111111';
const ACTOR = { actorUserId: '22222222-2222-2222-2222-222222222222', actorEmail: 'god@stockpilotusa.com' };
const REASON = { category: 'security_investigation' as const };

describe('disableUserAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateArgs.length = 0;
    dbState.update = { data: [{ id: TARGET }], error: null };
    getUserById.mockResolvedValue({ data: { user: { id: TARGET, email: 'worker@acme.test' } }, error: null });
    updateUserById.mockResolvedValue({ data: { user: { id: TARGET } }, error: null });
    revokeAllSessionsForUser.mockResolvedValue({ ok: true, sessionIds: ['s-1', 's-2'] });
  });

  it('flags, bans, revokes, evicts and audits — in that order', async () => {
    const res = await disableUserAccount({ targetUserId: TARGET, reason: REASON, ...ACTOR });

    expect(res).toEqual({
      ok: true,
      alreadyDisabled: false,
      banned: true,
      sessionsRevoked: 2,
      partial: false,
    });
    expect(updateArgs[0]).toMatchObject({
      disabled_reason: 'Security investigation',
      disabled_by: ACTOR.actorUserId,
    });
    expect(typeof updateArgs[0]!.disabled_at).toBe('string');
    expect(updateUserById).toHaveBeenCalledWith(TARGET, { ban_duration: '876000h' });
    expect(revokeAllSessionsForUser).toHaveBeenCalledWith(TARGET);
    expect(broadcastToChannel).toHaveBeenCalledWith(`user:${TARGET}:sessions`, 'revoked', {
      sessionIds: ['s-1', 's-2'],
    });
    expect(recordPlatformAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user_disabled', targetUserId: TARGET }),
    );
  });

  it('NEVER puts the reason on the public broadcast channel', async () => {
    await disableUserAccount({
      targetUserId: TARGET,
      reason: { category: 'other', notes: 'Suspected credential sharing' },
      ...ACTOR,
    });

    const payload = JSON.stringify(broadcastToChannel.mock.calls[0]![2]);
    expect(payload).not.toContain('Suspected');
    expect(payload).not.toContain('other');
  });

  it('refuses an allowlisted platform admin BEFORE writing anything', async () => {
    getUserById.mockResolvedValue({ data: { user: { id: TARGET, email: 'God@StockPilotUSA.com' } }, error: null });

    const res = await disableUserAccount({ targetUserId: TARGET, reason: REASON, ...ACTOR });

    expect(res).toEqual({ ok: false, code: 'PROTECTED_ADMIN_ACCOUNT' });
    expect(updateArgs).toHaveLength(0);
    expect(updateUserById).not.toHaveBeenCalled();
    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
    expect(recordPlatformAudit).not.toHaveBeenCalled();
  });

  it('refuses an empty reason', async () => {
    const res = await disableUserAccount({
      targetUserId: TARGET,
      reason: { category: 'other', notes: '   ' },
      ...ACTOR,
    });

    expect(res).toEqual({ ok: false, code: 'ACCOUNT_DISABLE_REASON_REQUIRED' });
    expect(updateArgs).toHaveLength(0);
  });

  it('returns ACCOUNT_NOT_FOUND when the auth user is gone', async () => {
    getUserById.mockResolvedValue({ data: { user: null }, error: { message: 'not found' } });

    expect(await disableUserAccount({ targetUserId: TARGET, reason: REASON, ...ACTOR })).toEqual({
      ok: false,
      code: 'ACCOUNT_NOT_FOUND',
    });
  });

  it('is idempotent: a CAS miss skips the audit but still re-bans, re-revokes and re-evicts', async () => {
    dbState.update = { data: [], error: null };

    const res = await disableUserAccount({ targetUserId: TARGET, reason: REASON, ...ACTOR });

    expect(res).toMatchObject({ ok: true, alreadyDisabled: true, banned: true, sessionsRevoked: 2 });
    expect(recordPlatformAudit).not.toHaveBeenCalled();
    expect(updateUserById).toHaveBeenCalledTimes(1);
    expect(revokeAllSessionsForUser).toHaveBeenCalledTimes(1);
  });

  it('fails CLOSED on a ban error: the flag stays set and the caller is told it is partial', async () => {
    updateUserById.mockResolvedValue({ data: null, error: { message: 'gotrue down' } });

    const res = await disableUserAccount({ targetUserId: TARGET, reason: REASON, ...ACTOR });

    expect(res).toMatchObject({ ok: true, banned: false, partial: true });
    expect(revokeAllSessionsForUser).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalled();
  });

  it('surfaces a CAS write error instead of pretending it worked', async () => {
    dbState.update = { data: null, error: { message: 'deadlock detected' } };

    const res = await disableUserAccount({ targetUserId: TARGET, reason: REASON, ...ACTOR });

    expect(res).toEqual({ ok: false, code: 'ACCOUNT_DISABLE_NOT_AUTHORIZED' });
    expect(updateUserById).not.toHaveBeenCalled();
  });
});

describe('reenableUserAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateArgs.length = 0;
    dbState.update = { data: [{ id: TARGET }], error: null };
    getUserById.mockResolvedValue({ data: { user: { id: TARGET, email: 'worker@acme.test' } }, error: null });
    updateUserById.mockResolvedValue({ data: { user: { id: TARGET } }, error: null });
  });

  it('clears all three columns, lifts the ban and audits', async () => {
    const res = await reenableUserAccount({ targetUserId: TARGET, ...ACTOR });

    expect(res).toEqual({ ok: true, alreadyActive: false, banned: false, partial: false });
    expect(updateArgs[0]).toEqual({ disabled_at: null, disabled_reason: null, disabled_by: null });
    expect(updateUserById).toHaveBeenCalledWith(TARGET, { ban_duration: 'none' });
    expect(recordPlatformAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user_reenabled', targetUserId: TARGET }),
    );
  });

  it('heals a stray ban on a CAS miss: no audit row, but the ban is still lifted', async () => {
    dbState.update = { data: [], error: null };

    const res = await reenableUserAccount({ targetUserId: TARGET, ...ACTOR });

    expect(res).toMatchObject({ ok: true, alreadyActive: true });
    expect(updateUserById).toHaveBeenCalledWith(TARGET, { ban_duration: 'none' });
    expect(recordPlatformAudit).not.toHaveBeenCalled();
  });

  it('never revokes sessions or broadcasts — re-enable only grants access', async () => {
    await reenableUserAccount({ targetUserId: TARGET, ...ACTOR });

    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });
});
```

- [ ] Run `pnpm --filter @stockpilot/web test src/server/services/platform/account-status.test.ts 2>&1 | tail -20`. Expect a module-not-found failure. Record it.
- [ ] Create `apps/web/src/server/services/platform/account-status.ts`:

```ts
import 'server-only';

import { isPlatformAdmin } from '@/lib/auth/platform-admin';
import { reportError } from '@/lib/error-reporter';
import { broadcastToChannel } from '@/lib/realtime/broadcast';
import { createAdminClient } from '@/lib/supabase/admin';

import { recordPlatformAudit } from './audit';
import { revokeAllSessionsForUser } from './sessions';

import {
  composeDisabledReason,
  type AccountDisableCode,
  type DisableReasonInput,
} from '@stockpilot/core';

/**
 * God-admin temporary account disable — the whole state machine.
 *
 * The CALLER has already passed checkPlatformAdmin({ requireStepUp: true });
 * these functions assume it and take the actor identity for the audit row.
 *
 * Two layers are written, in a fail-closed order:
 *
 *   1. user_profiles.disabled_at (Layer A) — the compare-and-set that BOTH
 *      request chokepoints read. Doing this first means the account is locked
 *      out of every page, Server Action and API route even if the rest fails.
 *   2. auth.users.banned_until (Layer B) — the only thing that blocks token
 *      REFRESH, new sign-ins, and the live getUser() every API request makes.
 *
 * then session revocation and a broadcast for instant eviction, then the audit
 * row. A crash anywhere leaves the account at least as locked as the completed
 * prefix, and re-running the action heals it: both Layer B steps run even on a
 * CAS miss, which is what makes a divergent flag/ban pair self-repairing.
 */

/** ~100 years. GoTrue takes a duration string, not a timestamp. */
const DISABLE_BAN_DURATION = '876000h';
const CLEAR_BAN_DURATION = 'none';

export interface DisableUserAccountInput {
  targetUserId: string;
  reason: DisableReasonInput;
  actorUserId: string;
  actorEmail: string;
}

export interface ReenableUserAccountInput {
  targetUserId: string;
  actorUserId: string;
  actorEmail: string;
}

export type DisableUserAccountResult =
  | {
      ok: true;
      /** True when the CAS found the account already disabled (a safe replay). */
      alreadyDisabled: boolean;
      banned: boolean;
      sessionsRevoked: number;
      /** True when Layer A landed but Layer B or revocation did not. */
      partial: boolean;
    }
  | { ok: false; code: AccountDisableCode };

export type ReenableUserAccountResult =
  | { ok: true; alreadyActive: boolean; banned: boolean; partial: boolean }
  | { ok: false; code: AccountDisableCode };

/**
 * Resolves the target's VERIFIED auth email. Never `user_profiles.email`: RLS
 * lets a user update their own profile row, so that column is
 * attacker-controlled and using it here would let someone dodge the
 * protected-admin refusal by editing their own profile.
 */
async function verifiedEmailForUser(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<string | null | undefined> {
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error || !data?.user) return undefined;
  return data.user.email ?? null;
}

export async function disableUserAccount(
  input: DisableUserAccountInput,
): Promise<DisableUserAccountResult> {
  const admin = createAdminClient();

  const email = await verifiedEmailForUser(admin, input.targetUserId);
  if (email === undefined) return { ok: false, code: 'ACCOUNT_NOT_FOUND' };

  // Refusing EVERY allowlisted email covers three requirements at once: no
  // self-disable, no disabling a peer god admin, and no way to lock out the
  // last god admin. The allowlist is deploy-time env and cannot shrink at
  // runtime, so no "is this the last one" counting is possible or needed.
  if (isPlatformAdmin(email)) return { ok: false, code: 'PROTECTED_ADMIN_ACCOUNT' };

  const reason = composeDisabledReason(input.reason).trim();
  if (reason.length === 0) return { ok: false, code: 'ACCOUNT_DISABLE_REASON_REQUIRED' };

  // The linearization point. `.is('disabled_at', null)` makes this a
  // compare-and-set: two concurrent clicks produce exactly one winner, so
  // exactly one audit row. The returned rows are CHECKED — an unchecked
  // .update().eq() that matched nothing is the repo's classic fail-open bug.
  const { data: casRows, error: casError } = await admin
    .from('user_profiles')
    .update({
      disabled_at: new Date().toISOString(),
      disabled_reason: reason,
      disabled_by: input.actorUserId,
    })
    .eq('id', input.targetUserId)
    .is('disabled_at', null)
    .select('id');

  if (casError) {
    await reportError(new Error(casError.message), {
      tag: 'platform.account-disable.cas',
      extra: { targetUserId: input.targetUserId },
    });
    return { ok: false, code: 'ACCOUNT_DISABLE_NOT_AUTHORIZED' };
  }

  const alreadyDisabled = (casRows ?? []).length === 0;

  // Layer B runs even on a CAS miss so a flag-set/ban-missing divergence heals
  // by pressing Disable again.
  const { error: banError } = await admin.auth.admin.updateUserById(input.targetUserId, {
    ban_duration: DISABLE_BAN_DURATION,
  });
  if (banError) {
    await reportError(new Error(banError.message), {
      tag: 'platform.account-disable.ban',
      extra: { targetUserId: input.targetUserId },
    });
  }
  const banned = !banError;

  const revoked = await revokeAllSessionsForUser(input.targetUserId);

  // Instant eviction for devices that are online right now. The channel is
  // PUBLIC, so the payload carries session ids and nothing else — never the
  // reason, never the actor, never the email.
  await broadcastToChannel(`user:${input.targetUserId}:sessions`, 'revoked', {
    sessionIds: revoked.sessionIds,
  });

  if (!alreadyDisabled) {
    await recordPlatformAudit({
      actorUserId: input.actorUserId,
      actorEmail: input.actorEmail,
      action: 'user_disabled',
      targetUserId: input.targetUserId,
      detail: {
        reason,
        reason_category: input.reason.category,
        sessions_revoked: revoked.sessionIds.length,
        banned,
      },
    });
  }

  return {
    ok: true,
    alreadyDisabled,
    banned,
    sessionsRevoked: revoked.sessionIds.length,
    partial: !banned || !revoked.ok,
  };
}

export async function reenableUserAccount(
  input: ReenableUserAccountInput,
): Promise<ReenableUserAccountResult> {
  const admin = createAdminClient();

  const email = await verifiedEmailForUser(admin, input.targetUserId);
  if (email === undefined) return { ok: false, code: 'ACCOUNT_NOT_FOUND' };

  const { data: casRows, error: casError } = await admin
    .from('user_profiles')
    .update({ disabled_at: null, disabled_reason: null, disabled_by: null })
    .eq('id', input.targetUserId)
    .not('disabled_at', 'is', null)
    .select('id');

  if (casError) {
    await reportError(new Error(casError.message), {
      tag: 'platform.account-reenable.cas',
      extra: { targetUserId: input.targetUserId },
    });
    return { ok: false, code: 'ACCOUNT_DISABLE_NOT_AUTHORIZED' };
  }

  const alreadyActive = (casRows ?? []).length === 0;

  // Executed even on a CAS miss: a cleared flag with a stray ban is exactly the
  // divergence Re-enable exists to heal, and a user in that state cannot sign
  // in at all until the ban is lifted.
  const { error: banError } = await admin.auth.admin.updateUserById(input.targetUserId, {
    ban_duration: CLEAR_BAN_DURATION,
  });
  if (banError) {
    await reportError(new Error(banError.message), {
      tag: 'platform.account-reenable.unban',
      extra: { targetUserId: input.targetUserId },
    });
  }

  // No revocation and no broadcast: re-enable only GRANTS access. The user
  // simply signs in again, which mints a fresh session.
  if (!alreadyActive) {
    await recordPlatformAudit({
      actorUserId: input.actorUserId,
      actorEmail: input.actorEmail,
      action: 'user_reenabled',
      targetUserId: input.targetUserId,
      detail: { ban_cleared: !banError },
    });
  }

  return { ok: true, alreadyActive, banned: !!banError, partial: !!banError };
}
```

- [ ] Run `pnpm --filter @stockpilot/web test src/server/services/platform/account-status.test.ts 2>&1 | tail -20`. All 12 assertions must pass. Run `pnpm typecheck` — clean.
- [ ] **Regression (R2):** confirm by reading the file that the only tables written are `user_profiles`, `auth.users` (via the admin API), `auth.sessions` (via the RPC) and `platform_admin_audit`. No `organization_members`, no operational table, no reassignment.
- [ ] Commit: `git commit -m "feat(auth): disable and re-enable account service with CAS, ban, revoke and audit"`.

---

## Task 5: Platform server actions and the step-up gate

The thin translation layer: parse, gate on a FRESH step-up, call the service, map its code to an `ActionResult`. The step-up reason is passed through untouched so the shipped `useStepUp()` retry loop works without any new client machinery.

**Files:**
- Modify: `apps/web/src/server/actions/platform/users.ts`
- Create: `apps/web/src/server/actions/platform/users.account-status.test.ts`

**Interfaces:**
- Produces for Task 8: `disableUserAccountAction({ targetUserId, reason })`, `reenableUserAccountAction({ targetUserId })`.
- Consumes from Task 4: `disableUserAccount`, `reenableUserAccount`. From Task 2: `disableReasonSchema`.

**Steps:**

- [ ] Write `apps/web/src/server/actions/platform/users.account-status.test.ts` FIRST:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The gate is the whole point of this layer. Disabling an account is
 * destructive and cross-org, so it sits on the 15-minute FRESH step-up tier
 * (the same one act-as, billing and provisioning use), and a stale step-up must
 * come back as details.reason='aal2_required' or the shipped useStepUp() retry
 * loop cannot re-challenge in place.
 */

const checkPlatformAdmin = vi.fn();
const disableUserAccount = vi.fn();
const reenableUserAccount = vi.fn();

vi.mock('@/lib/auth/platform-admin', () => ({
  checkPlatformAdmin: (...a: unknown[]) => checkPlatformAdmin(...a),
}));
vi.mock('@/server/services/platform/account-status', () => ({
  disableUserAccount: (...a: unknown[]) => disableUserAccount(...a),
  reenableUserAccount: (...a: unknown[]) => reenableUserAccount(...a),
}));
vi.mock('@/server/services/platform/users', () => ({ sendPasswordResetForUser: vi.fn() }));

import { disableUserAccountAction, reenableUserAccountAction } from './users';

const TARGET = '11111111-1111-1111-1111-111111111111';
const SESSION = { userId: '22222222-2222-2222-2222-222222222222', email: 'god@stockpilotusa.com' };
const REASON = { category: 'security_investigation' as const };

describe('disableUserAccountAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkPlatformAdmin.mockResolvedValue({ ok: true, session: SESSION });
    disableUserAccount.mockResolvedValue({
      ok: true,
      alreadyDisabled: false,
      banned: true,
      sessionsRevoked: 2,
      partial: false,
    });
  });

  it('requires a FRESH step-up', async () => {
    await disableUserAccountAction({ targetUserId: TARGET, reason: REASON });

    expect(checkPlatformAdmin).toHaveBeenCalledWith({ requireStepUp: true });
  });

  it('passes aal2_required back so useStepUp can re-challenge in place', async () => {
    checkPlatformAdmin.mockResolvedValue({ ok: false, reason: 'aal2_required' });

    const res = await disableUserAccountAction({ targetUserId: TARGET, reason: REASON });

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error.details?.reason).toBe('aal2_required');
    expect(disableUserAccount).not.toHaveBeenCalled();
  });

  it('refuses a non-admin without calling the service', async () => {
    checkPlatformAdmin.mockResolvedValue({ ok: false, reason: 'forbidden' });

    const res = await disableUserAccountAction({ targetUserId: TARGET, reason: REASON });

    expect(res.ok === false && res.error.code).toBe('forbidden');
    expect(res.ok === false && res.error.details?.code).toBe('ACCOUNT_DISABLE_NOT_AUTHORIZED');
    expect(disableUserAccount).not.toHaveBeenCalled();
  });

  it('rejects a missing reason before the gate even matters', async () => {
    const res = await disableUserAccountAction({ targetUserId: TARGET, reason: { category: 'other' } });

    expect(res.ok === false && res.error.code).toBe('validation_error');
    expect(res.ok === false && res.error.details?.code).toBe('ACCOUNT_DISABLE_REASON_REQUIRED');
  });

  it('rejects a non-uuid target', async () => {
    const res = await disableUserAccountAction({ targetUserId: 'nope', reason: REASON });

    expect(res.ok === false && res.error.code).toBe('validation_error');
  });

  it('maps PROTECTED_ADMIN_ACCOUNT to a forbidden result with the sub-code', async () => {
    disableUserAccount.mockResolvedValue({ ok: false, code: 'PROTECTED_ADMIN_ACCOUNT' });

    const res = await disableUserAccountAction({ targetUserId: TARGET, reason: REASON });

    expect(res.ok === false && res.error.code).toBe('forbidden');
    expect(res.ok === false && res.error.details?.code).toBe('PROTECTED_ADMIN_ACCOUNT');
    expect(res.ok === false && res.error.message).toBe('Platform administrators cannot be disabled.');
  });

  it('reports a partial disable so the operator knows to press it again', async () => {
    disableUserAccount.mockResolvedValue({
      ok: true,
      alreadyDisabled: false,
      banned: false,
      sessionsRevoked: 0,
      partial: true,
    });

    const res = await disableUserAccountAction({ targetUserId: TARGET, reason: REASON });

    expect(res.ok === false && res.error.code).toBe('internal_error');
    expect(res.ok === false && res.error.message).toContain('Disable again');
  });

  it('returns the revoked-session count on success', async () => {
    const res = await disableUserAccountAction({ targetUserId: TARGET, reason: REASON });

    expect(res).toEqual({ ok: true, data: { sessionsRevoked: 2, alreadyDisabled: false } });
    expect(disableUserAccount).toHaveBeenCalledWith({
      targetUserId: TARGET,
      reason: REASON,
      actorUserId: SESSION.userId,
      actorEmail: SESSION.email,
    });
  });
});

describe('reenableUserAccountAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkPlatformAdmin.mockResolvedValue({ ok: true, session: SESSION });
    reenableUserAccount.mockResolvedValue({ ok: true, alreadyActive: false, banned: false, partial: false });
  });

  it('is step-up gated too — re-enable GRANTS access', async () => {
    await reenableUserAccountAction({ targetUserId: TARGET });

    expect(checkPlatformAdmin).toHaveBeenCalledWith({ requireStepUp: true });
  });

  it('succeeds idempotently when the account was already active', async () => {
    reenableUserAccount.mockResolvedValue({ ok: true, alreadyActive: true, banned: false, partial: false });

    expect(await reenableUserAccountAction({ targetUserId: TARGET })).toEqual({
      ok: true,
      data: { alreadyActive: true },
    });
  });

  it('reports a partial re-enable rather than claiming success', async () => {
    reenableUserAccount.mockResolvedValue({ ok: true, alreadyActive: false, banned: true, partial: true });

    const res = await reenableUserAccountAction({ targetUserId: TARGET });

    expect(res.ok === false && res.error.code).toBe('internal_error');
    expect(res.ok === false && res.error.message).toContain('Re-enable again');
  });
});
```

- [ ] Run `pnpm --filter @stockpilot/web test src/server/actions/platform/users.account-status.test.ts 2>&1 | tail -20`. Expect an import failure for the two new exports. Record it.
- [ ] Append to `apps/web/src/server/actions/platform/users.ts` (keeping `sendUserPasswordResetAction` unchanged), and add `disableReasonSchema` plus the service imports at the top:

```ts
import {
  disableReasonSchema,
  err,
  ok,
  type ActionResult,
  type AccountDisableCode,
} from '@stockpilot/core';

import {
  disableUserAccount,
  reenableUserAccount,
} from '@/server/services/platform/account-status';

const disableSchema = z.object({
  targetUserId: z.string().uuid(),
  reason: disableReasonSchema,
});
const reenableSchema = z.object({ targetUserId: z.string().uuid() });

/** Maps a service sub-code to the ActionResult transport code + operator copy. */
const DISABLE_CODE_MESSAGES: Record<AccountDisableCode, string> = {
  ACCOUNT_TEMPORARILY_DISABLED: 'That account is disabled.',
  ACCOUNT_ALREADY_DISABLED: 'That account is already disabled.',
  ACCOUNT_NOT_DISABLED: 'That account is not disabled.',
  ACCOUNT_DISABLE_NOT_AUTHORIZED: 'Not authorized.',
  PROTECTED_ADMIN_ACCOUNT: 'Platform administrators cannot be disabled.',
  ACCOUNT_DISABLE_REASON_REQUIRED: 'A reason is required.',
  ACCOUNT_NOT_FOUND: 'User not found.',
};

/**
 * Platform-admin action: temporarily disable any account, platform-wide.
 *
 * Destructive and cross-org, so it sits on the FRESH step-up tier (15-minute
 * MFA assertion) alongside act-as, billing changes and provisioning. A stale
 * step-up comes back as details.reason='aal2_required', which is what lets the
 * client's useStepUp() prompt for TOTP in place and retry once instead of
 * dumping the operator back to sign-in.
 *
 * The target's protected-admin status is decided in the SERVICE, against the
 * VERIFIED auth email — never a profile column a user can edit.
 */
export async function disableUserAccountAction(
  input: z.infer<typeof disableSchema>,
): Promise<ActionResult<{ sessionsRevoked: number; alreadyDisabled: boolean }>> {
  const parsed = disableSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const isReason = issue?.path[0] === 'reason';
    return err(
      'validation_error',
      issue?.message ?? 'Invalid input',
      isReason ? { code: 'ACCOUNT_DISABLE_REASON_REQUIRED' } : undefined,
    );
  }

  const gate = await checkPlatformAdmin({ requireStepUp: true });
  if (!gate.ok) {
    return err('forbidden', 'Not authorized.', {
      code: 'ACCOUNT_DISABLE_NOT_AUTHORIZED',
      ...(gate.reason === 'aal2_required' ? { reason: 'aal2_required' } : {}),
    });
  }

  const res = await disableUserAccount({
    targetUserId: parsed.data.targetUserId,
    reason: parsed.data.reason,
    actorUserId: gate.session.userId,
    actorEmail: gate.session.email,
  });

  if (!res.ok) {
    const message = DISABLE_CODE_MESSAGES[res.code];
    if (res.code === 'ACCOUNT_NOT_FOUND') return err('not_found', message, { code: res.code });
    if (res.code === 'ACCOUNT_DISABLE_REASON_REQUIRED')
      return err('validation_error', message, { code: res.code });
    return err('forbidden', message, { code: res.code });
  }

  if (res.partial) {
    // Layer A landed, so the account is already locked out of every page and
    // API route. Say exactly that, and say what fixes it — the action is safely
    // re-runnable and the second press heals the missing half.
    return err(
      'internal_error',
      'The account is flagged as disabled, but the sign-in block did not finish applying. Press Disable again to complete it.',
      { code: 'ACCOUNT_TEMPORARILY_DISABLED' },
    );
  }

  return ok({ sessionsRevoked: res.sessionsRevoked, alreadyDisabled: res.alreadyDisabled });
}

/**
 * Platform-admin action: lift a temporary disable. Step-up gated because it
 * GRANTS access — the impersonation precedent leaves only access-REMOVING
 * actions un-gated.
 */
export async function reenableUserAccountAction(
  input: z.infer<typeof reenableSchema>,
): Promise<ActionResult<{ alreadyActive: boolean }>> {
  const parsed = reenableSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid user id');

  const gate = await checkPlatformAdmin({ requireStepUp: true });
  if (!gate.ok) {
    return err('forbidden', 'Not authorized.', {
      code: 'ACCOUNT_DISABLE_NOT_AUTHORIZED',
      ...(gate.reason === 'aal2_required' ? { reason: 'aal2_required' } : {}),
    });
  }

  const res = await reenableUserAccount({
    targetUserId: parsed.data.targetUserId,
    actorUserId: gate.session.userId,
    actorEmail: gate.session.email,
  });

  if (!res.ok) {
    const message = DISABLE_CODE_MESSAGES[res.code];
    if (res.code === 'ACCOUNT_NOT_FOUND') return err('not_found', message, { code: res.code });
    return err('forbidden', message, { code: res.code });
  }

  if (res.partial) {
    return err(
      'internal_error',
      'The disable flag was cleared, but the sign-in block is still in place. Press Re-enable again to finish.',
      { code: 'ACCOUNT_NOT_DISABLED' },
    );
  }

  return ok({ alreadyActive: res.alreadyActive });
}
```

- [ ] Run `pnpm --filter @stockpilot/web test src/server/actions/platform/users.account-status.test.ts 2>&1 | tail -20`. All 11 assertions must pass. Run `pnpm typecheck` — clean.
- [ ] Commit: `git commit -m "feat(auth): platform actions for account disable and re-enable"`.

---

## Task 6: The enforcement guard at both chokepoints

There is no single function covering pages, Server Actions, cookie API and Bearer API. The minimal covering set is two, so the guard is written once and called from both. This is the security core of the feature — treat any change here as security-critical.

**Files:**
- Create: `apps/web/src/lib/auth/account-status.ts`
- Create: `apps/web/src/lib/auth/account-status.test.ts`
- Modify: `apps/web/src/lib/auth/session.ts`
- Modify: `apps/web/src/lib/auth/api-context.ts`

**Interfaces:**
- Produces for Tasks 7, 12: `assertAccountActiveOrRedirect(profile)`, `loadAccountStatus(supabase, userId)`, `accountIsDisabled(profile)`.
- Consumes from Task 2: `isAccountDisabled`, `ACCOUNT_DISABLED_PATH`, `DISABLED_ACCOUNT_EVENTS`.

**Steps:**

- [ ] Write `apps/web/src/lib/auth/account-status.test.ts` FIRST. It covers the pure helper AND the real `withApiContext` behaviour on both branches:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reportError = vi.fn(async () => {});
vi.mock('@/lib/error-reporter', () => ({ reportError: (...a: unknown[]) => reportError(...a) }));
vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  },
}));
vi.mock('@/lib/auth/effective-permissions', () => ({
  loadEffectivePermissions: async () => new Set<string>(),
}));

const USER_ID = '99999999-9999-9999-9999-999999999999';
const ORG_ID = '88888888-8888-8888-8888-888888888888';

const state: {
  profile: { id: string; default_organization_id: string | null; disabled_at: string | null } | null;
  member: { organization_id: string; role: string } | null;
} = {
  profile: { id: USER_ID, default_organization_id: ORG_ID, disabled_at: null },
  member: { organization_id: ORG_ID, role: 'staff' },
};

/** Minimal PostgREST-shaped fake: chainable, awaitable, and maybeSingle-able. */
function table(single: unknown, list: unknown[] = []) {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.select = self;
  q.eq = self;
  q.is = self;
  q.not = self;
  q.limit = self;
  q.order = self;
  q.maybeSingle = async () => ({ data: single, error: null });
  q.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: list, error: null }).then(resolve);
  return q;
}

function fakeClient() {
  return {
    from: (name: string) => {
      if (name === 'user_profiles') return table(state.profile);
      if (name === 'organization_members') return table(state.member);
      if (name === 'organizations') return table({ mfa_policy: 'optional' });
      if (name === 'organization_modules') return table(null, []);
      return table(null);
    },
    auth: {
      getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }),
    },
  };
}

vi.mock('@supabase/supabase-js', () => ({ createClient: () => fakeClient() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => fakeClient() }));

import { accountIsDisabled } from './account-status';
import { withApiContext } from './api-context';

function bearerRequest(): Request {
  return new Request('https://app.test/api/v1/items', {
    headers: { authorization: 'Bearer token.abc.def', 'x-organization-id': ORG_ID },
  });
}

function cookieRequest(): Request {
  return new Request('https://app.test/api/items', {
    headers: { cookie: 'sb-example-auth-token=abc' },
  });
}

describe('accountIsDisabled', () => {
  it('is active for null and for a missing row', () => {
    expect(accountIsDisabled({ disabled_at: null })).toBe(false);
    expect(accountIsDisabled(null)).toBe(false);
  });

  it('is disabled for any timestamp', () => {
    expect(accountIsDisabled({ disabled_at: '2026-07-31T00:00:00.000Z' })).toBe(true);
  });
});

describe('withApiContext refuses a disabled account', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.profile = { id: USER_ID, default_organization_id: ORG_ID, disabled_at: null };
    state.member = { organization_id: ORG_ID, role: 'staff' };
  });

  it('BEARER: returns a context for an active account', async () => {
    const ctx = await withApiContext(bearerRequest());

    expect(ctx).not.toBeNull();
    expect(ctx?.organizationId).toBe(ORG_ID);
    expect(ctx?.userId).toBe(USER_ID);
  });

  it('BEARER: returns null for a disabled account even with a valid token and a real membership', async () => {
    state.profile = { id: USER_ID, default_organization_id: ORG_ID, disabled_at: '2026-07-31T00:00:00.000Z' };

    expect(await withApiContext(bearerRequest())).toBeNull();
  });

  it('COOKIE: returns null for a disabled account', async () => {
    state.profile = { id: USER_ID, default_organization_id: ORG_ID, disabled_at: '2026-07-31T00:00:00.000Z' };

    expect(await withApiContext(cookieRequest())).toBeNull();
  });

  it('COOKIE: returns a context for an active account', async () => {
    expect(await withApiContext(cookieRequest())).not.toBeNull();
  });

  it('still returns null when there is no auth at all', async () => {
    expect(await withApiContext(new Request('https://app.test/api/items'))).toBeNull();
  });
});
```

- [ ] Run `pnpm --filter @stockpilot/web test src/lib/auth/account-status.test.ts 2>&1 | tail -25`. Expect a module-not-found failure for `./account-status`. Record it.
- [ ] Create `apps/web/src/lib/auth/account-status.ts`:

```ts
import 'server-only';

import { redirect } from 'next/navigation';

import { reportError } from '@/lib/error-reporter';

import {
  ACCOUNT_DISABLED_PATH,
  DISABLED_ACCOUNT_EVENTS,
  isAccountDisabled,
} from '@stockpilot/core';

/**
 * Account-status enforcement — ONE guard, installed at the only two identity
 * funnels this app has.
 *
 * There is deliberately no third install point:
 *   - the proxy matcher excludes /api by design, so middleware cannot cover it;
 *   - middleware verifies JWTs LOCALLY (getClaims), so it would accept a
 *     revoked session until the token expires anyway;
 *   - an RLS-level check would tax every query platform-wide. Direct PostgREST
 *     reads from mobile therefore coast on an already-issued access token until
 *     it expires; the broadcast eviction closes that window in about a second
 *     for any device that is online, and every mobile WRITE goes through Bearer
 *     /api/v1, which is covered here.
 */

/** The column set both chokepoints must select. Keep the readers in sync. */
export const ACCOUNT_STATUS_COLUMNS = 'disabled_at' as const;

export interface AccountStatusRow {
  disabled_at?: string | null;
}

/** Pure re-export of the shared predicate, so callers need one import. */
export function accountIsDisabled(profile: AccountStatusRow | null | undefined): boolean {
  return isAccountDisabled(profile);
}

/**
 * Page / Server-Action enforcement. Redirects to the dedicated disabled screen.
 *
 * Loop safety (the lesson from the MFA gate's redirect-loop bug): the
 * destination is a standalone route OUTSIDE the (dashboard) group and OUTSIDE
 * the proxy matcher, so it never receives the verified-identity headers, never
 * resolves a session, and therefore can never redirect to itself.
 */
export function assertAccountActiveOrRedirect(profile: AccountStatusRow | null | undefined): void {
  if (!accountIsDisabled(profile)) return;
  redirect(ACCOUNT_DISABLED_PATH);
}

/**
 * API enforcement helper: reads the caller's status row with whatever client
 * the request already built.
 *
 * On the Bearer path this is a REAL extra round trip, not a free ride:
 * pickActiveMembership short-circuits before touching user_profiles whenever
 * X-Organization-Id is present, and the mobile client always sends it. The cost
 * is one PK lookup issued in PARALLEL with the membership query, and it buys a
 * backstop for the window where the GoTrue ban write failed but the flag
 * landed. Fails CLOSED: an unreadable status row is treated as disabled.
 */
export async function loadAccountStatus(
   
  supabase: any,
  userId: string,
): Promise<{ disabled: boolean }> {
  try {
    const { data, error } = await supabase
      .from('user_profiles')
      .select(ACCOUNT_STATUS_COLUMNS)
      .eq('id', userId)
      .maybeSingle();
    if (error) {
      await reportError(new Error(error.message), {
        tag: 'auth.account-status.read',
        extra: { userId },
      });
      return { disabled: true };
    }
    return { disabled: accountIsDisabled(data as AccountStatusRow | null) };
  } catch (e) {
    await reportError(e, { tag: 'auth.account-status.read', extra: { userId } });
    return { disabled: true };
  }
}

/**
 * Structured breadcrumb for blocked traffic. Deliberately NOT an org-level
 * audit_logs event: whether an org may see that the platform disabled one of
 * its members is an open policy question, and an implementation detail must not
 * answer it. Never carries the reason, a token or a cookie.
 */
export function noteDisabledAccountBlocked(
  kind: 'login' | 'request',
  extra: { userId?: string | null; path?: string | null } = {},
): void {
  const event =
    kind === 'login' ? DISABLED_ACCOUNT_EVENTS.loginBlocked : DISABLED_ACCOUNT_EVENTS.requestBlocked;
  console.info(`[${event}]`, {
    userId: extra.userId ?? null,
    path: extra.path ?? null,
  });
}
```

- [ ] Wire chokepoint 1. In `apps/web/src/lib/auth/session.ts`, add the import and widen the profile query + shape, then enforce. Replace the `user_profiles` select with:

```ts
    supabase
      .from('user_profiles')
      // disabled_at rides this EXISTING select for free — the row is already
      // fetched by primary key on every authenticated render, so the
      // platform-wide account-disable check costs zero extra round trips here.
      .select('id, email, full_name, avatar_url, default_organization_id, disabled_at')
      .eq('id', userId)
      .maybeSingle(),
```

- [ ] In the same file, widen the profile type with `disabled_at: string | null;` and insert the guard immediately after the `profile` cast, BEFORE the `session` is built:

```ts
  // Account-status gate (chokepoint 1). This covers every RSC page and every
  // org-scoped Server Action, inherited by all 146 requireOrgContext and 114
  // withContext call sites without touching any of them.
  //
  // It is safe to redirect from inside this cache()d loader precisely because
  // `userId` can only come from the proxy-set header: an /api route never has
  // that header, returns early above, and therefore can never throw
  // NEXT_REDIRECT out of a route handler (recurring bug #23).
  if (profile) assertAccountActiveOrRedirect(profile);
```

with the import `import { assertAccountActiveOrRedirect } from '@/lib/auth/account-status';`.

- [ ] Wire chokepoint 2. In `apps/web/src/lib/auth/api-context.ts`, import `loadAccountStatus` and replace the membership resolution in the BEARER branch with:

```ts
    const requestedOrgId = req?.headers.get('x-organization-id') ?? null;
    // Status and membership in parallel. The status read is NOT free on this
    // path: pickActiveMembership returns before touching user_profiles whenever
    // an org header is present, which is every mobile request.
    const [member, status] = await Promise.all([
      pickActiveMembership(supabase, userRes.user.id, requestedOrgId),
      loadAccountStatus(supabase, userRes.user.id),
    ]);
    if (!member) return null;
    // A disabled account gets the same uniform 401 an anonymous caller gets.
    // The GoTrue ban normally rejects this request one line earlier at
    // getUser(); this is the backstop for the window where the flag landed but
    // the ban write did not.
    if (status.disabled) return null;
```

- [ ] Apply the same treatment to the COOKIE branch, replacing its membership resolution with:

```ts
  const requestedOrgId = req?.headers.get('x-organization-id') ?? null;
  const [member, status] = await Promise.all([
    pickActiveMembership(supabase, user.id, requestedOrgId),
    loadAccountStatus(supabase, user.id),
  ]);
  if (!member) return null;
  if (status.disabled) return null;
```

- [ ] Run `pnpm --filter @stockpilot/web test src/lib/auth/account-status.test.ts 2>&1 | tail -25`. All 7 assertions must pass. Run `pnpm typecheck` and `pnpm --filter @stockpilot/web test 2>&1 | tail -20` — the whole web suite must stay green.
- [ ] **Regression (R1):** confirm `loadSessionAndContext` still issues exactly two queries in one `Promise.all`, that the membership query's filters are untouched, and that an active user's context is byte-identical to before.
- [ ] Commit: `git commit -m "feat(auth): enforce account status at both request chokepoints"`.

---

# Phase 3 — Web surfaces

## Task 7: The disabled screen and the sign-in path

Two entry points for the same state: a blocked route (a live session whose account was just disabled) and a rejected sign-in (`user_banned` from GoTrue). Both land on the same screen with the same copy.

**Files:**
- Create: `apps/web/src/app/account-disabled/page.tsx`
- Modify: `apps/web/src/server/actions/auth.ts`
- Modify: `apps/web/src/components/auth/sign-in-form.tsx`
- Create: `apps/web/src/server/actions/auth.account-disabled.test.ts`

**Interfaces:**
- Consumes from Task 2: `ACCOUNT_DISABLED_TITLE`, `ACCOUNT_DISABLED_MESSAGE`, `ACCOUNT_DISABLED_PATH`. From Task 6: `noteDisabledAccountBlocked`.
- Produces for Task 12: the route `/account-disabled` and the `account_disabled` sign-in result.

**Steps:**

- [ ] Write `apps/web/src/server/actions/auth.account-disabled.test.ts` FIRST. It pins the classifier only, so the test does not need the whole action's rate-limit and cookie machinery:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isBannedUserAuthError } from './auth-error-classify';

/**
 * A banned user and a wrong password must be distinguishable server-side, but
 * the "temporarily disabled" sentence must NEVER be shown for a mere bad
 * credential — that would turn the sign-in form into an account-status oracle.
 * The only accepted signal is GoTrue's own structured `user_banned` code.
 */

describe('isBannedUserAuthError', () => {
  it('recognises the structured GoTrue code', () => {
    expect(isBannedUserAuthError({ code: 'user_banned' })).toBe(true);
  });

  it('does NOT fire on invalid credentials', () => {
    expect(isBannedUserAuthError({ code: 'invalid_credentials', message: 'Invalid login credentials' })).toBe(false);
  });

  it('does NOT fire on a rate limit', () => {
    expect(isBannedUserAuthError({ status: 429, code: 'over_email_send_rate_limit' })).toBe(false);
  });

  it('never infers a ban from free-text alone — an attacker-influenced message is not a signal', () => {
    expect(isBannedUserAuthError({ message: 'user_banned' })).toBe(false);
    expect(isBannedUserAuthError({ message: 'your user_banned account' })).toBe(false);
  });

  it('tolerates null and empty errors', () => {
    expect(isBannedUserAuthError(null)).toBe(false);
    expect(isBannedUserAuthError({})).toBe(false);
  });
});

describe('signInAction branches on the classifier before the generic collapse', () => {
  const src = readFileSync(join(__dirname, 'auth.ts'), 'utf8');

  it('checks the ban BEFORE returning invalid email or password', () => {
    const banIdx = src.indexOf('isBannedUserAuthError');
    const genericIdx = src.indexOf("'Invalid email or password'");
    expect(banIdx).toBeGreaterThan(-1);
    expect(genericIdx).toBeGreaterThan(-1);
    expect(banIdx).toBeLessThan(genericIdx);
  });

  it('returns the shared copy, not a retyped sentence', () => {
    expect(src).toContain('ACCOUNT_DISABLED_MESSAGE');
  });
});
```

- [ ] Create `apps/web/src/server/actions/auth-error-classify.ts` (a pure module so the classifier is testable without the action's dependencies):

```ts
/**
 * Whether a Supabase auth error means "this user is banned" (our temporary
 * account disable), as opposed to a bad password or a rate limit.
 *
 * ONLY the structured `code` is trusted. A message-string heuristic would be
 * both fragile and dangerous: error copy changes between SDK releases, and any
 * text an attacker can influence must never be able to make the sign-in form
 * confirm that an account exists and is disabled.
 */
export function isBannedUserAuthError(
  error: { code?: unknown; status?: unknown; message?: unknown } | null | undefined,
): boolean {
  return error?.code === 'user_banned';
}
```

- [ ] In `apps/web/src/server/actions/auth.ts`, add the imports and insert the ban branch inside `signInAction`'s `if (error) { ... }` block, immediately AFTER the `isRateLimit` computation and BEFORE the `emitAuthAudit` call:

```ts
    // A disabled account is not a credential problem. GoTrue rejects a banned
    // user with the structured code `user_banned` on every auth endpoint; left
    // alone it would fall into the generic "Invalid email or password" branch
    // below and send a locked-out user to reset a password that is perfectly
    // fine. Audited through the EXISTING sign-in-failure event with a distinct
    // reason rather than a new org-visible event — org visibility of a platform
    // disable is an open policy question.
    if (isBannedUserAuthError(errAny)) {
      noteDisabledAccountBlocked('login');
      await emitAuthAudit({
        event: 'user.sign_in_failed',
        userId: null,
        organizationId: null,
        extra: { email: parsed.data.email, reason: 'account_disabled' },
      });
      return err('account_disabled', ACCOUNT_DISABLED_MESSAGE);
    }
```

with these imports added at the top of the file:

```ts
import { isBannedUserAuthError } from '@/server/actions/auth-error-classify';
import { noteDisabledAccountBlocked } from '@/lib/auth/account-status';
import { ACCOUNT_DISABLED_MESSAGE, ACCOUNT_DISABLED_PATH } from '@stockpilot/core';
```

- [ ] Create `apps/web/src/app/account-disabled/page.tsx`:

```tsx
import type { Metadata } from 'next';

import { signOutAction } from '@/server/actions/auth';

import { ACCOUNT_DISABLED_MESSAGE, ACCOUNT_DISABLED_TITLE } from '@stockpilot/core';

export const metadata: Metadata = { title: 'Account disabled' };

/**
 * The blocked-route screen.
 *
 * Deliberately standalone: it lives OUTSIDE the (dashboard) route group, is not
 * in the proxy matcher, and calls no session helper. That is what makes the
 * redirect loop-safe — the destination of a blocking redirect must itself be
 * exempt from that redirect, which is the lesson the MFA gate learned the hard
 * way.
 *
 * It reveals nothing: no reason, no actor, no date, no support ticket id. The
 * only affordance is signing out, so the user can try a different account.
 */
export default function AccountDisabledPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <div className="w-full max-w-md space-y-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{ACCOUNT_DISABLED_TITLE}</h1>
        <p className="text-muted-foreground text-sm leading-relaxed">{ACCOUNT_DISABLED_MESSAGE}</p>
        <form action={signOutAction}>
          <button
            type="submit"
            className="border-border hover:border-foreground/30 rounded-md border px-4 py-2 text-sm font-medium"
          >
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
```

- [ ] In `apps/web/src/components/auth/sign-in-form.tsx`, replace the failure branch of `onSubmit` so a disabled account gets the screen instead of a toast:

```tsx
    if (!res.ok) {
      // A disabled account gets the dedicated screen, not a toast: the message
      // is not something a user can act on from the form, and a toast vanishes
      // before it can be read.
      if (res.error.code === 'account_disabled') {
        router.replace(ACCOUNT_DISABLED_PATH);
        return;
      }
      toast.error(res.error.message);
      return;
    }
```

with `import { ACCOUNT_DISABLED_PATH } from '@stockpilot/core';` added to the file's imports.

- [ ] Run `pnpm --filter @stockpilot/web test src/server/actions/auth.account-disabled.test.ts 2>&1 | tail -20`. All 7 assertions must pass.
- [ ] Run `pnpm --filter @stockpilot/web dev` and confirm by hand: visiting `/account-disabled` while signed out renders the screen with no redirect loop and no console error; the Sign out button returns to `/signin`.
- [ ] Run `pnpm typecheck` and `pnpm lint` — clean.
- [ ] Commit: `git commit -m "feat(auth): disabled-account screen and sign-in branch"`.

---

## Task 8: The platform console action surface

The only place the capability exists. The lone inline reset button becomes a three-dot menu matching the Team page's pattern, the disable path gets a critical type-to-confirm dialog with the mandatory reason, and a disabled row is unmistakable at a glance.

**Files:**
- Create: `apps/web/src/components/platform/user-actions-menu.tsx`
- Create: `apps/web/src/components/platform/disable-account-dialog.tsx`
- Modify: `apps/web/src/server/services/platform/orgs.ts`
- Modify: `apps/web/src/app/(platform)/platform/orgs/[id]/page.tsx`

**Interfaces:**
- Consumes from Task 5: `disableUserAccountAction`, `reenableUserAccountAction`. From Task 2: the reason taxonomy and schema.
- Produces for Task 12: the operator UI.

**Steps:**

- [ ] Widen `getOrgMembers` in `apps/web/src/server/services/platform/orgs.ts` so the tab can show status. Replace the select and the mapper's return:

```ts
  const { data, error } = await admin
    .from('organization_members')
    .select(
      'user_id, role, accepted_at, user_profiles:user_id (email, full_name, disabled_at)',
    )
    .eq('organization_id', orgId)
    .not('accepted_at', 'is', null)
    .is('impersonation_expires_at', null) // real members only, not "act as" grants
    .order('accepted_at', { ascending: true })
    .limit(DETAIL_PREVIEW_LIMIT);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
    const prof = r.user_profiles as
      | { email: string; full_name: string | null; disabled_at: string | null }
      | { email: string; full_name: string | null; disabled_at: string | null }[]
      | null;
    const p = Array.isArray(prof) ? (prof[0] ?? null) : prof;
    return {
      userId: (r.user_id as string | null) ?? null,
      email: p?.email ?? null,
      fullName: p?.full_name ?? null,
      role: r.role as string,
      joinedAt: (r.accepted_at as string | null) ?? null,
      disabledAt: p?.disabled_at ?? null,
    };
  });
```

and add `disabledAt: string | null;` to the `PlatformOrgMember` interface.

- [ ] Create `apps/web/src/components/platform/disable-account-dialog.tsx`:

```tsx
'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import {
  DISABLE_REASON_CATEGORIES,
  DISABLE_REASON_CATEGORY_LABELS,
  disableReasonSchema,
  type DisableReasonCategory,
  type DisableReasonInput,
} from '@stockpilot/core';

/**
 * Critical-severity confirm for a platform-wide account disable.
 *
 * Composes the same two safety devices the shared DestructiveConfirm uses —
 * type-to-confirm plus destructive tone — and adds the mandatory reason the
 * primitive has no slot for. The typed string is the target's EMAIL, so the
 * operator has to look at who they are about to lock out.
 *
 * The blast radius is stated explicitly: the platform console shows users
 * inside one org, but this action is not org-scoped, and an operator must not
 * discover that afterwards.
 */
export function DisableAccountDialog({
  open,
  onOpenChange,
  email,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  email: string;
  pending: boolean;
  onConfirm: (reason: DisableReasonInput) => void | Promise<void>;
}) {
  const [category, setCategory] = React.useState<DisableReasonCategory>('security_investigation');
  const [notes, setNotes] = React.useState('');
  const [typed, setTyped] = React.useState('');

  React.useEffect(() => {
    if (!open) {
      setCategory('security_investigation');
      setNotes('');
      setTyped('');
    }
  }, [open]);

  const parsed = disableReasonSchema.safeParse({
    category,
    notes: notes.trim().length > 0 ? notes : undefined,
  });
  const reasonError = parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Reason required');
  const canConfirm = parsed.success && typed === email && !pending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-destructive">Disable this account?</DialogTitle>
          <DialogDescription>
            This disables {email} across every organization, not just this one. They are signed out
            of every device immediately and cannot sign in again until an administrator re-enables
            the account. No data is deleted and no work is reassigned.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="disable-reason-category">Reason</Label>
            <select
              id="disable-reason-category"
              value={category}
              onChange={(e) => setCategory(e.target.value as DisableReasonCategory)}
              className="border-border bg-background w-full rounded-md border px-3 py-2 text-sm"
            >
              {DISABLE_REASON_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {DISABLE_REASON_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="disable-reason-notes">
              Notes{category === 'other' ? ' (required)' : ' (optional)'}
            </Label>
            <textarea
              id="disable-reason-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={500}
              className="border-border bg-background w-full rounded-md border px-3 py-2 text-sm"
            />
            {reasonError && <p className="text-destructive text-xs">{reasonError}</p>}
            <p className="text-muted-foreground text-xs">
              Recorded in the platform audit trail. Never shown to the user.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="disable-confirm">
              Type <span className="font-mono">{email}</span> to confirm
            </Label>
            <Input
              id="disable-confirm"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!canConfirm}
            onClick={() => {
              if (!parsed.success) return;
              void onConfirm(parsed.data);
            }}
          >
            {pending ? 'Disabling...' : 'Disable account'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] Create `apps/web/src/components/platform/user-actions-menu.tsx`:

```tsx
'use client';

import { MoreHorizontal } from 'lucide-react';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { useStepUp } from '@/components/auth/step-up-modal';
import { DisableAccountDialog } from '@/components/platform/disable-account-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  disableUserAccountAction,
  reenableUserAccountAction,
  sendUserPasswordResetAction,
} from '@/server/actions/platform/users';

import type { ActionResult, DisableReasonInput } from '@stockpilot/core';

/**
 * Per-user actions on the platform console's org-detail Users tab. This is the
 * ONLY surface in the product that can disable an account: the org Team page
 * and the mobile admin screen are org-admin surfaces and deliberately get
 * nothing.
 *
 * Disable is hidden entirely for a protected (allowlisted) platform admin
 * rather than shown-and-refused, so an operator never aims at a target the
 * server will reject. The server still refuses independently — the hidden menu
 * item is a courtesy, never the control.
 */
export function UserActionsMenu({
  userId,
  email,
  disabledAt,
  protectedAdmin,
}: {
  userId: string;
  email: string | null;
  disabledAt: string | null;
  protectedAdmin: boolean;
}) {
  const router = useRouter();
  const { ensure, modal } = useStepUp();
  const [pending, start] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const isDisabled = disabledAt !== null;

  /** Runs an action, and on a stale step-up re-challenges TOTP and retries ONCE. */
  async function withStepUp<T>(run: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
    const first = await run();
    if (first.ok || first.error.details?.reason !== 'aal2_required') return first;
    const ok = await ensure();
    if (!ok) return first;
    return run();
  }

  function onReset() {
    if (!window.confirm(`Email a password-reset link to ${email ?? 'this user'}?`)) return;
    start(async () => {
      const res = await sendUserPasswordResetAction({ targetUserId: userId });
      if (res.ok) toast.success(`Reset email sent to ${email ?? 'the user'}.`);
      else toast.error(res.error.message);
    });
  }

  function onDisable(reason: DisableReasonInput) {
    start(async () => {
      const res = await withStepUp(() => disableUserAccountAction({ targetUserId: userId, reason }));
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      setConfirmOpen(false);
      toast.success(
        res.data.sessionsRevoked > 0
          ? `Account disabled. ${res.data.sessionsRevoked} session${res.data.sessionsRevoked === 1 ? '' : 's'} revoked.`
          : 'Account disabled.',
      );
      router.refresh();
    });
  }

  function onReenable() {
    start(async () => {
      const res = await withStepUp(() => reenableUserAccountAction({ targetUserId: userId }));
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      toast.success('Account re-enabled. The user can sign in again.');
      router.refresh();
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" disabled={pending} aria-label="User actions">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onReset}>Send password reset...</DropdownMenuItem>
          {!protectedAdmin && !isDisabled && (
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={(e) => {
                e.preventDefault();
                setConfirmOpen(true);
              }}
            >
              Disable account...
            </DropdownMenuItem>
          )}
          {!protectedAdmin && isDisabled && (
            <DropdownMenuItem onSelect={onReenable}>Re-enable account</DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <DisableAccountDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        email={email ?? ''}
        pending={pending}
        onConfirm={onDisable}
      />
      {modal}
    </>
  );
}
```

- [ ] In `apps/web/src/app/(platform)/platform/orgs/[id]/page.tsx`, replace `UsersTab`'s row rendering so the status shows and the menu replaces the inline button, and add `import { isPlatformAdmin } from '@/lib/auth/platform-admin';` plus `import { UserActionsMenu } from '@/components/platform/user-actions-menu';`:

```tsx
              <td className="px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <div>
                    <div className="font-medium">{m.fullName ?? '—'}</div>
                    <div className="text-[11.5px] text-[var(--ed-ink-4)]">{m.email ?? '—'}</div>
                  </div>
                  {m.disabledAt ? (
                    <span
                      title={`Disabled ${new Date(m.disabledAt).toLocaleString()}`}
                      className="rounded-full border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:text-red-300"
                    >
                      Disabled
                    </span>
                  ) : null}
                </div>
              </td>
              <td className="px-4 py-2.5 text-[var(--ed-ink-3)]">{m.role}</td>
              <td className="px-4 py-2.5 text-[12px] text-[var(--ed-ink-4)]">
                {m.joinedAt ? new Date(m.joinedAt).toLocaleDateString() : '—'}
              </td>
              <td className="px-4 py-2.5 text-right">
                {m.userId ? (
                  <UserActionsMenu
                    userId={m.userId}
                    email={m.email}
                    disabledAt={m.disabledAt}
                    // Resolved on the SERVER from the deploy-time allowlist —
                    // the client never learns who is on it beyond this boolean.
                    protectedAdmin={isPlatformAdmin(m.email)}
                  />
                ) : (
                  <span className="text-[11.5px] text-[var(--ed-ink-4)]">—</span>
                )}
              </td>
```

- [ ] Delete the now-unused `PasswordResetButton` import from the page. Leave `apps/web/src/components/platform/password-reset-button.tsx` on disk only if something else imports it; run `grep -rn "PasswordResetButton" apps/web/src` and delete the file if the count is zero.
- [ ] Run `pnpm typecheck`, `pnpm lint`, and `pnpm --filter @stockpilot/web test 2>&1 | tail -10`. All clean.
- [ ] Hand-verify in `pnpm --filter @stockpilot/web dev` against a local platform-admin session: the three-dot menu opens; Disable is absent on an allowlisted row; the dialog refuses to enable its button until BOTH the reason parses and the email is typed exactly; cancelling writes nothing.
- [ ] Commit: `git commit -m "feat(auth): platform console disable and re-enable controls"`.

---

# Phase 4 — Mobile

## Task 9: Typed API errors (prerequisite)

Mobile throws a bare `Error` with no status and no code, so nothing downstream can tell a 401 from a 500. The disabled flow needs that distinction, and so does the outbox. The user-facing sentences must not change by a single character — `api-errors.test.ts` pins them verbatim after a real defect put raw HTML on screen.

**Files:**
- Modify: `apps/mobile/src/lib/api.ts`
- Modify: `apps/mobile/src/lib/api-errors.test.ts`

**Interfaces:**
- Produces for Tasks 10, 11: `ApiError extends Error { status: number; code?: string }`.

**Steps:**

- [ ] Append these assertions to `apps/mobile/src/lib/api-errors.test.ts`, inside the existing `describe('the real helper still keeps this contract', ...)` block:

```ts
  it('throws a typed ApiError carrying the status', () => {
    expect(src).toContain('export class ApiError extends Error');
    expect(src).toContain('readonly status: number');
    expect(src).toContain('readonly code?: string');
    expect(src).toContain('throw new ApiError(');
  });

  it('still never throws a bare Error for a failed response', () => {
    // The old shape was `throw new Error(message)` inside the !res.ok branch.
    const failureBranch = src.slice(src.indexOf('if (!res.ok)'), src.indexOf('return (await res.json())'));
    expect(failureBranch).not.toContain('throw new Error(');
  });

  it('keeps the fallback sentences byte-identical', () => {
    expect(src).toContain('You do not have access to that.');
    expect(src).toContain('That is not available on this version of the app. Update the app and try again.');
    expect(src).toContain('The server had a problem. Try again in a moment.');
    expect(src).toContain('`Request failed (${res.status}).`');
  });
```

- [ ] Run `pnpm --filter @stockpilot/mobile test src/lib/api-errors.test.ts 2>&1 | tail -20`. Expect the three new assertions to fail. Record it.
- [ ] In `apps/mobile/src/lib/api.ts`, add the error class above `api()`:

```ts
/**
 * Typed API failure. The app used to throw a bare Error with the message only,
 * so no caller could tell a 401 from a 500 — which is why nothing signed out on
 * auth failure and why the offline outbox retried a permanently rejected write
 * forever.
 *
 * `message` is unchanged from the previous behaviour and remains the ONLY thing
 * that should ever be shown to a person; `status` and `code` are for control
 * flow. `code` is our own JSON error code when the body carried one.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}
```

- [ ] In the same file, capture the code while parsing and throw the typed error. Replace the body-parsing block and the throw inside `if (!res.ok)`:

```ts
      const raw = await res.text().catch(() => '');
      let message: string | null = null;
      let code: string | undefined;
      if (raw.trimStart().startsWith('{')) {
        try {
          const body = JSON.parse(raw) as { message?: unknown; error?: unknown };
          const m = typeof body.message === 'string' ? body.message : null;
          const e = typeof body.error === 'string' ? body.error : null;
          message = m ?? e;
          code = e ?? undefined;
        } catch {
          message = null;
        }
      }
      if (!message) {
        message =
          res.status === 401 || res.status === 403
            ? 'You do not have access to that.'
            : res.status === 404
              ? 'That is not available on this version of the app. Update the app and try again.'
              : res.status >= 500
                ? 'The server had a problem. Try again in a moment.'
                : `Request failed (${res.status}).`;
      }
      throw new ApiError(message, res.status, code);
```

- [ ] Run `pnpm --filter @stockpilot/mobile test src/lib/api-errors.test.ts 2>&1 | tail -20`. All assertions must pass, old and new. Run `pnpm --filter @stockpilot/mobile test 2>&1 | tail -10` — the whole mobile suite green.
- [ ] **Regression:** `ApiError extends Error`, so every existing `catch (e) { e instanceof Error ? e.message : ... }` keeps working unchanged. Confirm with `grep -rn "instanceof Error" apps/mobile/src apps/mobile/app | wc -l` and spot-check three call sites.
- [ ] Commit: `git commit -m "feat(mobile): typed ApiError with status and code"`.

---

## Task 10: The mobile disabled screen, and the listener that evicts to it

Three ways in: the broadcast (online at disable time), a rejected sign-in, and an API 401 confirmed by an auth probe. The revocation listener also moves from the drawer to the root gate, so a user sitting on a pre-drawer or auth screen is evicted too.

**Files:**
- Create: `apps/mobile/src/lib/account-disabled-state.ts`
- Create: `apps/mobile/src/lib/account-disabled-state.test.ts`
- Create: `apps/mobile/src/lib/account-disabled-probe.ts`
- Create: `apps/mobile/src/lib/account-disabled-probe.test.ts`
- Create: `apps/mobile/src/components/account-disabled-screen.tsx`
- Modify: `apps/mobile/app/_layout.tsx`
- Modify: `apps/mobile/src/components/drawer-content.tsx`
- Modify: `apps/mobile/src/lib/sync.ts`

**Interfaces:**
- Produces for Task 11: `getAccountDisabled()`, `setAccountDisabled()`, `classifyAuthProbe()`.
- Consumes from Task 9: `ApiError`. From Task 2: the shared copy.

**Steps:**

- [ ] Write `apps/mobile/src/lib/account-disabled-state.test.ts` and `apps/mobile/src/lib/account-disabled-probe.test.ts` FIRST:

```ts
// apps/mobile/src/lib/account-disabled-state.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getAccountDisabled,
  resetAccountDisabled,
  setAccountDisabled,
  subscribeAccountDisabled,
} from './account-disabled-state';

describe('account-disabled flag', () => {
  beforeEach(() => resetAccountDisabled());

  it('starts false', () => {
    expect(getAccountDisabled()).toBe(false);
  });

  it('notifies subscribers on a real change only', () => {
    const seen = vi.fn();
    subscribeAccountDisabled(seen);

    setAccountDisabled(true);
    setAccountDisabled(true);

    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith(true);
    expect(getAccountDisabled()).toBe(true);
  });

  it('clears on re-enable so a fresh sign-in is not blocked by a stale flag', () => {
    setAccountDisabled(true);
    setAccountDisabled(false);

    expect(getAccountDisabled()).toBe(false);
  });

  it('unsubscribes cleanly', () => {
    const seen = vi.fn();
    const off = subscribeAccountDisabled(seen);
    off();

    setAccountDisabled(true);

    expect(seen).not.toHaveBeenCalled();
  });
});
```

```ts
// apps/mobile/src/lib/account-disabled-probe.test.ts
import { describe, expect, it } from 'vitest';

import { classifyAuthProbe, shouldProbeAfterFailure } from './account-disabled-probe';

/**
 * The server answers a disabled caller with the SAME uniform 401 an anonymous
 * caller gets — deliberately, so an API probe teaches an attacker nothing. The
 * client therefore has to ask GoTrue directly, and only a structured
 * `user_banned` counts. A network blip must never lock a working account out of
 * its own app.
 */

describe('shouldProbeAfterFailure', () => {
  it('probes on 401', () => {
    expect(shouldProbeAfterFailure({ status: 401 })).toBe(true);
  });

  it('does NOT probe on 403 — that is a permission answer, not an identity one', () => {
    expect(shouldProbeAfterFailure({ status: 403 })).toBe(false);
  });

  it('does not probe on 404, 500 or a plain network error', () => {
    expect(shouldProbeAfterFailure({ status: 404 })).toBe(false);
    expect(shouldProbeAfterFailure({ status: 500 })).toBe(false);
    expect(shouldProbeAfterFailure(null)).toBe(false);
    expect(shouldProbeAfterFailure(new Error('Network request failed'))).toBe(false);
  });
});

describe('classifyAuthProbe', () => {
  it('reports disabled for the structured user_banned code', () => {
    expect(classifyAuthProbe({ data: { user: null }, error: { code: 'user_banned' } })).toBe('disabled');
  });

  it('reports active when the user still resolves', () => {
    expect(classifyAuthProbe({ data: { user: { id: 'u1' } }, error: null })).toBe('active');
  });

  it('reports unknown for any other failure — never lock someone out on a blip', () => {
    expect(classifyAuthProbe({ data: { user: null }, error: { code: 'session_not_found' } })).toBe('unknown');
    expect(classifyAuthProbe({ data: { user: null }, error: { message: 'Network request failed' } })).toBe('unknown');
    expect(classifyAuthProbe(null)).toBe('unknown');
  });

  it('never infers a ban from free text', () => {
    expect(classifyAuthProbe({ data: { user: null }, error: { message: 'user_banned' } })).toBe('unknown');
  });
});
```

- [ ] Run `pnpm --filter @stockpilot/mobile test src/lib/account-disabled 2>&1 | tail -20`. Expect module-not-found failures. Record them.
- [ ] Create `apps/mobile/src/lib/account-disabled-state.ts`:

```ts
/**
 * Module-level "this account is disabled" flag.
 *
 * It lives outside React because the things that DISCOVER the state are not
 * components — the sync worker's failure handler and the outbox drain — while
 * the thing that RENDERS it is RootGate. A plain subscribable module keeps that
 * seam pure (and therefore testable in this vitest environment, which cannot
 * load react-native).
 */

let disabled = false;
const listeners = new Set<(next: boolean) => void>();

export function getAccountDisabled(): boolean {
  return disabled;
}

export function setAccountDisabled(next: boolean): void {
  if (disabled === next) return;
  disabled = next;
  for (const l of listeners) l(next);
}

export function subscribeAccountDisabled(listener: (next: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test helper and sign-out hook: clears the flag so a later sign-in is clean. */
export function resetAccountDisabled(): void {
  disabled = false;
  listeners.clear();
}
```

- [ ] Create `apps/mobile/src/lib/account-disabled-probe.ts`:

```ts
/**
 * Deciding "am I disabled?" from a client, given that the server refuses to say.
 *
 * /api/v1 answers a disabled caller with the same uniform 401 an anonymous
 * caller gets, on purpose. So a 401 is only a PROMPT to ask GoTrue directly
 * (supabase.auth.getUser()), and only GoTrue's structured `user_banned` code is
 * accepted as proof. Anything else — a session that simply expired, an offline
 * device, a transient 500 — resolves to 'unknown' and changes nothing, because
 * showing the disabled screen to a working account is worse than showing it
 * late.
 */

export type AuthProbeResult = 'disabled' | 'active' | 'unknown';

/** Whether a failed request justifies spending one getUser() round trip. */
export function shouldProbeAfterFailure(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 401;
}

/** Classifies a supabase.auth.getUser() result. */
export function classifyAuthProbe(
  res: { data?: { user?: unknown } | null; error?: { code?: unknown } | null } | null | undefined,
): AuthProbeResult {
  if (!res) return 'unknown';
  if (res.error?.code === 'user_banned') return 'disabled';
  if (res.data?.user) return 'active';
  return 'unknown';
}
```

- [ ] Create `apps/mobile/src/components/account-disabled-screen.tsx`:

```tsx
import * as React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AuthShell } from '@/components/auth/auth-shell';
import { Body, Display } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import { setAccountDisabled } from '@/lib/account-disabled-state';
import { ACCENT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

import { ACCOUNT_DISABLED_MESSAGE, ACCOUNT_DISABLED_TITLE } from '@stockpilot/core';

/**
 * Full-screen disabled state, rendered by RootGate as an early return in the
 * same slot as MfaChallengeScreen and BiometricLockScreen. Same copy as the
 * web screen, from the same shared constants — never retyped.
 *
 * Sign out uses the LOCAL-scope fallback path: a global sign-out would try to
 * reach GoTrue with a banned user's token, and the device is already
 * server-side revoked anyway.
 */
export function AccountDisabledScreen() {
  const { signOutToFallback } = useAuth();
  const { c } = useTheme();
  const [busy, setBusy] = React.useState(false);

  async function onSignOut() {
    if (busy) return;
    setBusy(true);
    // Clear the flag so a DIFFERENT account can sign in on this device without
    // being met by a stale disabled screen.
    setAccountDisabled(false);
    await signOutToFallback();
  }

  return (
    <AuthShell>
      <View style={styles.body}>
        <Display style={{ color: c.ink }}>{ACCOUNT_DISABLED_TITLE}</Display>
        <Body style={[styles.message, { color: c.ink3 }]}>{ACCOUNT_DISABLED_MESSAGE}</Body>
        <Pressable
          accessibilityRole="button"
          onPress={onSignOut}
          disabled={busy}
          style={[styles.button, { borderColor: ACCENT, opacity: busy ? 0.5 : 1 }]}
        >
          <Body style={{ color: ACCENT }}>Sign out</Body>
        </Pressable>
      </View>
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 24, paddingTop: 24, gap: 16 },
  message: { lineHeight: 22 },
  button: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 10,
    marginTop: 8,
  },
});
```

- [ ] In `apps/mobile/app/_layout.tsx`, mount the listener and the screen in `RootGate`. Add the imports, then insert inside `RootGate` above the existing `React.useEffect`:

```tsx
  // Mounted HERE, not in DrawerContent: a user sitting on an auth-group screen,
  // a pushed card screen, or the pre-drawer cold-launch path had no revocation
  // listener at all, so a force-logout simply did not reach them. RootGate is
  // the one component mounted on every screen.
  const onForcedSignOut = React.useCallback(() => {
    router.replace('/(auth)/welcome' as Href);
  }, [router]);
  useSessionRevocation(session?.user?.id ?? null, onForcedSignOut);

  const [accountDisabled, setDisabledState] = React.useState(getAccountDisabled);
  React.useEffect(() => subscribeAccountDisabled(setDisabledState), []);
```

and insert this early return ABOVE the MFA gate (a disabled account must not be asked for a TOTP code it can never usefully supply):

```tsx
  if (!loading && session && accountDisabled) {
    return <AccountDisabledScreen />;
  }
```

with:

```tsx
import { AccountDisabledScreen } from '@/components/account-disabled-screen';
import { getAccountDisabled, subscribeAccountDisabled } from '@/lib/account-disabled-state';
import { useSessionRevocation } from '@/lib/use-session-revocation';
```

- [ ] In `apps/mobile/src/components/drawer-content.tsx`, delete the `useSessionRevocation` call, its `handleForcedSignOut` callback and the now-unused import. Leave a one-line comment where it was:

```tsx
  // Force-logout lives in RootGate now (app/_layout.tsx) so it is mounted on
  // every screen, not only behind the drawer.
```

- [ ] In `apps/mobile/src/lib/sync.ts`, make `pullSnapshot`'s catch probe instead of swallowing. Replace its catch block:

```ts
  } catch (e) {
    console.warn('[sync] snapshot pull failed', e);
    // A 401 here is the app's earliest reliable signal that the account was
    // disabled while the device was offline or missed the broadcast. The server
    // will not say so (it answers a uniform 401 on purpose), so ask GoTrue
    // directly — once, only on a 401, and only a structured user_banned counts.
    if (shouldProbeAfterFailure(e)) {
      const probe = classifyAuthProbe(await supabase.auth.getUser());
      if (probe === 'disabled') {
        setAccountDisabled(true);
        // scope:'local' — the server already killed the session; a global
        // sign-out would cascade to the user's other devices.
        await supabase.auth.signOut({ scope: 'local' });
      }
    }
    return null;
  }
```

with the imports `import { supabase } from './supabase';` (if not already present), `import { classifyAuthProbe, shouldProbeAfterFailure } from './account-disabled-probe';` and `import { setAccountDisabled } from './account-disabled-state';`.

- [ ] Run `pnpm --filter @stockpilot/mobile test 2>&1 | tail -20`. All 13 new assertions plus the existing suite must pass.
- [ ] **Simulator hand-test** (owner rule; a mobile change is never done without one). Boot the iOS simulator, sign in as a Demo Co user, then from the platform console disable that account and confirm, recording pass or fail per line:
  1. The app is signed out within a few seconds while sitting on the ITEMS screen (proves the RootGate listener).
  2. Repeat while sitting on a pushed card screen (item detail) — also evicted (this is the case the DrawerContent mount missed).
  3. Signing in again shows the disabled screen with the exact shared copy.
  4. Sign out from that screen returns to Welcome, and a DIFFERENT account signs in normally.
  5. Re-enable, sign in, and confirm the app behaves exactly as before.
- [ ] Run `pnpm typecheck`. Commit: `git commit -m "feat(mobile): disabled-account screen, root-mounted revocation, auth probe"`.

---

## Task 11: Offline mutations are rejected, not retried forever

The legacy outbox selects `status in ('pending','failed')` and retries every tick with no backoff and no cap. A disabled account would loop on 401 indefinitely, and worse, a queued write must never replay after re-enable — the operator who disabled the account did so to stop exactly that.

**Files:**
- Create: `apps/mobile/src/lib/drain-failure.ts`
- Create: `apps/mobile/src/lib/drain-failure.test.ts`
- Modify: `apps/mobile/src/lib/queue.ts`
- Modify: `apps/mobile/src/lib/sync.ts`

**Interfaces:**
- Produces for Task 12: `rejected` as a terminal outbox status, `listRejected()`.
- Consumes from Tasks 9, 10: `ApiError`, `getAccountDisabled`.

**Steps:**

- [ ] Write `apps/mobile/src/lib/drain-failure.test.ts` FIRST:

```ts
import { describe, expect, it } from 'vitest';

import { classifyDrainFailure } from './drain-failure';

/**
 * A queued offline write that fails because the account was disabled must land
 * in a TERMINAL state. The legacy drain re-reads 'pending' and 'failed' every
 * tick forever, so leaving it 'failed' means the device hammers the API and,
 * far worse, the write lands the moment the account is re-enabled — replaying
 * exactly the activity the disable existed to stop.
 */

describe('classifyDrainFailure', () => {
  it('rejects a 401 while the account is known disabled', () => {
    expect(classifyDrainFailure({ status: 401 }, { accountDisabled: true })).toBe('rejected');
  });

  it('keeps a 401 retryable when the account is NOT disabled — that is a token blip', () => {
    expect(classifyDrainFailure({ status: 401 }, { accountDisabled: false })).toBe('failed');
  });

  it('never rejects a 5xx or a network error, even while disabled', () => {
    expect(classifyDrainFailure({ status: 500 }, { accountDisabled: true })).toBe('failed');
    expect(classifyDrainFailure(new Error('Network request failed'), { accountDisabled: true })).toBe('failed');
  });

  it('leaves 403 retryable — a permission change is not an identity verdict', () => {
    expect(classifyDrainFailure({ status: 403 }, { accountDisabled: true })).toBe('failed');
  });

  it('tolerates a null error', () => {
    expect(classifyDrainFailure(null, { accountDisabled: true })).toBe('failed');
  });
});
```

- [ ] Run `pnpm --filter @stockpilot/mobile test src/lib/drain-failure.test.ts 2>&1 | tail -20`. Expect a module-not-found failure. Record it.
- [ ] Create `apps/mobile/src/lib/drain-failure.ts`:

```ts
/**
 * Terminal-vs-retryable classification for the offline outbox.
 *
 * Only ONE combination is terminal: a 401 raised while the client already knows
 * the account is disabled. Everything else stays retryable, because the outbox
 * holds real operator work (received PO lines, stock adjustments, counts) and
 * discarding it on a transient failure would silently lose warehouse activity.
 */
export type DrainOutcome = 'rejected' | 'failed';

export function classifyDrainFailure(
  err: unknown,
  opts: { accountDisabled: boolean },
): DrainOutcome {
  if (!opts.accountDisabled) return 'failed';
  const status = (err as { status?: unknown } | null)?.status;
  return status === 401 ? 'rejected' : 'failed';
}
```

- [ ] In `apps/mobile/src/lib/queue.ts`, widen the status union and add the terminal writer plus a reader. Change `PendingActionRow['status']` to `'pending' | 'sending' | 'ok' | 'failed' | 'rejected'` and append:

```ts
/**
 * Terminal rejection. Used when the server will NEVER accept this write —
 * today, only when the account was disabled while the row was queued.
 *
 * The row is KEPT, not deleted: it is a local record of work the operator
 * believed they had completed, and support needs to be able to see it. It is
 * simply never sent again, because `listPending` selects only 'pending' and
 * 'failed'. No SCHEMA_VERSION bump is involved — a bump DROPS pending_actions,
 * which would destroy the very outbox this is protecting.
 */
export async function markRejected(id: number, error: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `update pending_actions
        set status = 'rejected',
            last_error = ?,
            last_attempt_at = ?
      where id = ?`,
    [error.slice(0, 1000), Date.now(), id],
  );
}

/** Rejected rows, newest first — the local record for support. */
export async function listRejected(limit = 100): Promise<PendingActionRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: number;
    kind: string;
    idempotency_key: string;
    payload_json: string;
    created_at: number;
    attempts: number;
    last_attempt_at: number | null;
    last_error: string | null;
    status: string;
  }>(
    `select * from pending_actions where status = 'rejected'
      order by created_at desc limit ?`,
    [limit],
  );
  return rows.map(rowFromDb);
}
```

- [ ] In `apps/mobile/src/lib/sync.ts`, use the classifier in `drainQueue`. Replace its catch block and return shape:

```ts
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 4xx (bad payload, validation) and 5xx / network errors both stay in
      // 'failed' and are re-read next tick. The ONE terminal case is a 401 on a
      // known-disabled account: that write must never replay after re-enable.
      const outcome = classifyDrainFailure(e, { accountDisabled: getAccountDisabled() });
      if (outcome === 'rejected') {
        await markRejected(action.id, msg);
        rejected += 1;
      } else {
        await markFailed(action.id, msg);
        failed += 1;
      }
    }
  }
  return { ok, failed, rejected };
}
```

declaring `let rejected = 0;` beside `ok`/`failed`, widening the signature to `Promise<{ ok: number; failed: number; rejected: number }>`, returning `{ ok: 0, failed: 0, rejected: 0 }` from the offline early return, and adding the imports:

```ts
import { classifyDrainFailure } from './drain-failure';
import { getAccountDisabled } from './account-disabled-state';
import { listPending, markFailed, markOk, markRejected, markSending } from './queue';
```

- [ ] Run `grep -rn "drainQueue(" apps/mobile/src apps/mobile/app` and update every caller that destructures the result to tolerate the new field. Run `pnpm typecheck` to prove none was missed.
- [ ] Run `pnpm --filter @stockpilot/mobile test 2>&1 | tail -20`. All 5 new assertions plus the existing suite must pass.
- [ ] **Simulator hand-test:** with the device in airplane mode, record a stock adjustment so it queues; disable the account from the console; restore connectivity; confirm the row lands in `rejected` (verify with a temporary `listRejected()` log), that the drain does NOT keep retrying it on later ticks, and that re-enabling the account does NOT send it.
- [ ] Commit: `git commit -m "feat(mobile): reject queued writes for a disabled account instead of retrying forever"`.

---

# Phase 5 — Verification and deliverables

## Task 12: The end-to-end regression scenario

The owner's required scenario, run for real, end to end, with the result of every line written down. Nothing in this feature may be called done before this task's evidence exists.

**Files:**
- Create: `docs/superpowers/reports/2026-07-31-account-disable-verification.md`

**Interfaces:**
- Consumes: every prior task.
- Produces for Task 13: the real test output and the pass/fail record.

**Steps:**

- [ ] Run the full local gate and record the REAL output of each:
  - `supabase db reset && pnpm db:test 2>&1 | tail -30` — every pgTAP file green, including the 16 new 0308 assertions.
  - `pnpm test 2>&1 | tail -30` — the whole vitest suite across core, web and mobile.
  - `pnpm typecheck` — clean.
  - `pnpm lint` — clean.
- [ ] Confirm the branch is still `feat/account-disable`, that every commit is LOCAL, and that nothing was pushed: `git status -sb && git log --oneline origin/main..HEAD`. There must be no `origin/feat/account-disable`.
- [ ] Confirm NO migration reached production: `git diff --stat main -- supabase/migrations` shows only 0308 added, and no `supabase db push` appears anywhere in this session's shell history.
- [ ] Set up the scenario locally against Demo Co (`71b27a4a-7948-4638-bc3f-535974713bd2`): one platform-admin account on the local `STOCKPILOT_PLATFORM_ADMIN_EMAILS` allowlist, and one ordinary member account signed in on BOTH a web browser and the iOS simulator at the same time.
- [ ] Run the scenario and record pass or fail per numbered line:
  1. **Baseline (R1).** As the ordinary user: load the dashboard, open an item, run a stock adjustment, and confirm mobile sync works. Everything behaves exactly as before the branch.
  2. **Protected target (R3).** In the console, open the Users tab for an org containing the platform admin. Confirm "Disable account..." is ABSENT on that row. Then call `disableUserAccountAction` directly against that user id from a scratch server action or a node REPL against the same code path and confirm it returns `forbidden` with `details.code === 'PROTECTED_ADMIN_ACCOUNT'` and that `user_profiles.disabled_at` is still null.
  3. **Reason is mandatory.** Open the dialog for the ordinary user, select Other, leave notes empty, and confirm the Disable button never enables.
  4. **Disable.** Select a category, type the email, confirm. Record the toast's revoked-session count.
  5. **Instant eviction — mobile.** The simulator signs itself out within a few seconds without being touched.
  6. **Next validation — web.** In the still-open browser tab, click any dashboard link. It lands on `/account-disabled` with the exact copy, and the screen does not loop.
  7. **Sign-in blocked.** Sign out and try to sign in with the correct password. The dedicated screen appears — NOT "Invalid email or password".
  8. **Wrong password does not leak.** Try signing in as that user with a WRONG password and confirm the response is indistinguishable from a normal bad-credential attempt for a non-disabled account.
  9. **API blocked.** With the mobile app's last access token (captured before the disable), curl `/api/v1/mobile/snapshot` with `Authorization: Bearer <token>` and confirm a 401 `{"error":"unauthenticated"}` with no extra detail.
  10. **Token refresh blocked.** Confirm the same token cannot be refreshed (GoTrue returns `user_banned`).
  11. **Offline replay rejected.** Follow Task 11's airplane-mode procedure and confirm the queued row ends `rejected` and never sends.
  12. **Idempotency.** Press Disable again on the already-disabled user (via the direct action call, since the menu item is hidden). Confirm no second `user_disabled` row appears in `platform_admin_audit`.
  13. **Data untouched (R2).** Compare row counts and updated_at values for that user's `organization_members`, `stock_movements`, `order_requests`, `cycle_counts` and `purchase_orders` against the pre-disable snapshot. Identical.
  14. **Audit trail.** `/platform/audit` shows one `user_disabled` row with the actor email, the target user and the reason in `detail`.
  15. **Re-enable (R4).** Re-enable from the console. Confirm the audit row, then sign in on web and mobile: same orgs, same roles, same data, and the "Disabled" chip is gone.
  16. **Re-enable idempotency.** Press Re-enable again and confirm no second `user_reenabled` row.
  17. **Divergence heals.** Manually set `banned_until` on an ACTIVE user with local SQL, then press Re-enable and confirm the ban is lifted even though the flag was already null.
- [ ] Confirm the hosted project's access-token TTL in the Supabase dashboard BEFORE writing any exposure-window number into the report. If it cannot be confirmed, write "unverified, local config says 3600 s" rather than a guess.
- [ ] Write `docs/superpowers/reports/2026-07-31-account-disable-verification.md` with the real result of every line above, the actual command output for the four gates, and any line that failed. Do not omit a failure.
- [ ] Commit: `git commit -m "docs(auth): account-disable end-to-end verification results"`.

---

## Task 13: Deliverables — matrices, files changed, and the decisions still open

The written artifacts the brief demands, assembled from what the implementation actually does rather than what it was meant to do.

**Files:**
- Create: `docs/superpowers/specs/2026-07-31-account-disable-deliverables.md`

**Interfaces:**
- Consumes: every prior task, plus Task 12's verification report.
- Produces: the final hand-off document.

**Steps:**

- [ ] Write the **permission matrix** — one row per capability, one column per principal (viewer / staff / manager, org admin / owner, platform admin), stating the enforcing mechanism for each cell. It must record that the disable capability is deliberately NOT in the 0207 configurable-permission system and why (a DB-grantable god-mode permission would break the "no DB write can ever escalate" invariant), and that `platform_admin_audit` has RLS on with zero policies, so only the console can read the trail.
- [ ] Write the **state-transition matrix** — every (current state, action) pair with its result: Active+Disable, Disabled+Disable, Disabled+Re-enable, Active+Re-enable, Disabled+sign-in, Disabled+refresh, Disabled+page, Disabled+API, Disabled+direct PostgREST read, Disabled+member removal, Disabled+platform delete, and protected-admin+Disable. Each cell names the enforcing layer and states whether an audit row is written. Include the concurrency section: the CAS is the linearization point, both actions always run their Layer B step so any partial failure heals on a re-press, and the one residual race (a disable and a re-enable interleaving so the flag and the ban disagree for a window) is documented as accepted, with the note that app access always follows the FLAG and that `pg_advisory_xact_lock(hashtext(user_id::text))` is the available upgrade if the owner ever rejects it.
- [ ] Write the **session-revocation design** — the three-layer picture (flag, ban, revoke + broadcast), why `auth.sessions` deletion is the only by-user-id mechanism available (0213 is self-scoped; auth-js has no signOut-by-user-id; the service-role client cannot run raw auth-schema SQL), that `auth.refresh_tokens` cascades on the delete, and the honest exposure window: direct PostgREST reads from a device that missed the broadcast coast until the access token expires, bounded by the TTL confirmed in Task 12.
- [ ] Write the **files changed** list — every file created or modified across Tasks 1-12, grouped by layer, each with a one-line statement of what it does. Sourced from `git diff --stat main...HEAD`.
- [ ] Copy in the **real test results** from Task 12's verification report. Never restate a result that was not run.
- [ ] Write the **remaining policy decisions** section, reproducing Design §10 unchanged and unanswered, each with the concrete change it would require. None of these may be implemented before the owner decides:
  1. **Email notifications** to the disabled user on disable and/or re-enable — which template archetype, and does it name the reason?
  2. **Manager/org alerts and org-visible audit rows** — should each accepted membership get an `audit_logs` row (a NEW event, since `user.deactivated` already means permanent removal)? This is what currently blocks promoting `DISABLED_ACCOUNT_LOGIN_BLOCKED` / `_REQUEST_BLOCKED` from breadcrumbs to org-visible events.
  3. **Assignment flagging** — the disabled user may hold live picking claims, cycle-count assignee locks, the delivery-driver flag and pending order approvals. Auto-release, flag for reassignment, or leave until re-enable? This plan leaves them untouched.
  4. **Auto-re-enable** — an optional `disabled_until` plus a cron sweep with a matching `ban_duration`, or indefinite-until-manual only? This plan is indefinite-only.
  5. **Billing/owner handling** — disabling an org OWNER, possibly the billing owner, when the org has no kill switch and owner is always-permitted. Warn, block for sole-owner orgs, or allow?
  6. **Reason visibility to the user** — the screens are generic by design; should a category ever be shown?
  7. **Push tokens** — a disabled device keeps its `push_tokens` row and keeps receiving pushes. Suppress, delete, or leave? This plan leaves them.
  8. **B2B portal scope** — banned `customer_users` are locked out at sign-in and refresh as a side effect of Layer B, but no portal disabled screen exists. Needed, or is the generic auth failure acceptable?
  9. **Device data retention** — forced sign-out keeps the local SQLite cache and the rejected outbox. Acceptable for a temporary disable, or should disable trigger `wipeForSignOut()`?
- [ ] Add the **hand-off note**: migration 0308 has NOT been applied to production; the owner applies it with `supabase db push --linked` against `xizpqmhhslgzbuqtjubv` BEFORE any dependent web deploy, because pending migrations crash pages. The mobile changes ship via `pnpm release:ota` from `apps/mobile` (never a raw `eas update`), and every change in this branch is pure JS, so OTA is sufficient.
- [ ] Commit: `git commit -m "docs(auth): account-disable permission and state matrices, session design, open decisions"`.

---

## Required deliverables and the task that produces each

| # | Deliverable (owner brief) | Produced by |
|---|---|---|
| 1 | Architecture audit with file:line evidence | Already delivered — `docs/superpowers/specs/2026-07-31-account-disable-architecture-audit.md` |
| 2 | Design with owner requirements and open questions | Already delivered — `docs/superpowers/specs/2026-07-31-account-disable-design.md` |
| 3 | Permission matrix | Task 13 |
| 4 | State-transition matrix | Task 13 |
| 5 | Session-revocation design | Task 13 (mechanism built in Tasks 1 and 3) |
| 6 | Files changed | Task 13, from `git diff --stat` |
| 7 | REAL test results, never claimed untested | Every task's final steps; consolidated in Task 12 |
| 8 | Remaining policy decisions, unanswered | Task 13 |

### Definition-of-Done coverage

| Owner clause | Task |
|---|---|
| God-admin only | 5 (step-up gate), 8 (only surface), 4 (protected-admin refusal) |
| Platform-wide, not per-org | 1 (`user_profiles`, not `organization_members`), 6 (both chokepoints) |
| Preserve everything, no data deleted | 4 (writes only 4 tables), 12 line 13 (R2) |
| Sessions revoked | 1 (`admin_revoke_user_sessions`), 3 (helper + the broken call site fixed), 4 (invocation) |
| Logout on next validation | 6 (chokepoint 1 redirect, chokepoint 2 401) |
| Dedicated disabled screen, web and mobile | 7 (web), 10 (mobile), 2 (one shared copy) |
| Required reason | 2 (schema + categories), 4 (server-composed), 8 (dialog) |
| Audit events | 1 (CHECK), 4 (audit rows), 7 (sign-in reason) |
| Additive migration | 1 |
| Protected-admin safeguards incl. last god admin | 4 (one rule covers all three cases) |
| Idempotent and race-safe | 4 (CAS both directions), 12 lines 12 and 16 |
| Offline mutations rejected | 11 |
| Financial/operational data untouched | 4, 12 line 13 |
| No prod migration in this workstream | Global Constraint 2, verified in 12 |
| No commits to main | Global Constraint 1, verified in 12 |

---

## Open policy questions

Reproduced from Design §10 and left OPEN by instruction. None blocks starting this plan; each blocks the feature it names, and none may be implemented without the owner's decision. The full list with the change each would require is written out in Task 13.

1. Email notifications on disable / re-enable.
2. Manager and org alerts, and whether an org-visible `audit_logs` row is written.
3. Assignment flagging (picking claims, cycle-count locks, driver flag, approvals).
4. Auto-re-enable after a duration.
5. Subscription and billing-owner handling when the target is an org owner.
6. Reason visibility to the disabled user.
7. Push-token handling for a disabled device.
8. B2B portal scope and whether it needs its own disabled screen.
9. Device data retention — wipe the local cache on a forced sign-out, or keep it.
