# Platform Super-Admin Console — Design

**Date:** 2026-06-14
**Status:** Approved (brainstorm), implementation in phases
**Owner:** branden574@gmail.com (sole platform admin via env allowlist)

## Goal

Give the platform owner a single, secure console at `/platform` to operate **above** any single organization: see every org's data, manage their billing/tier/trial, reset any user's password, and — deliberately and audited — act inside any org. The multi-tenant isolation guarantee (RLS) is preserved; god-mode lives in one isolated, gated, audited place.

## Non-goals

- No database-level RLS bypass (no global "platform admin can read everything" policy). Cross-org reads use the service-role client on purpose-built, gated server paths only.
- No DB-backed admin promotion. Platform-admin status stays a deploy-time env allowlist (`STOCKPILOT_PLATFORM_ADMIN_EMAILS`) so no DB write can escalate to god-mode.
- No new self-serve billing UI for tenants. The existing Stripe checkout/webhook stays as-is.

## Access model (decided)

- **Hybrid impersonation:** view-only by default; an explicit, 2FA-stepped-up **"Act as this org"** enters impersonation with a loud banner and full audit; auto-expires.
- **Billing = both:** internal admin overrides AND real Stripe coexist. Precedence: **admin override → live Stripe subscription → active trial → free.** A manual override always wins; Stripe is honored only when no override contradicts it.
- **Two dials, not one word:**
  - **Access tier:** Free / Pro / Business / **Enterprise (full access)**.
  - **Billing arrangement:** Standard / **Comped (no charge)** / Trial / Custom price / Stripe.
  - "Full access, no charge, permanent" = Access **Enterprise** + Billing **Comped** (+ optionally all premium modules on).

## Security (decided)

- **Gate:** `requirePlatformAdmin()` — signed in + email in allowlist + MFA at AAL2. Any failure → **404** (existence not revealed).
- **MFA required:** a platform admin without an enrolled factor cannot use the console.
- **Step-up:** a fresh AAL2 step-up is required immediately before the two dangerous actions — "Act as this org" and any billing change.
- **Audit:** every god-mode action writes a `platform_admin_audit` row (actor, action, target org/user, detail, time). Platform-admin-only readable.

## Data model

Migration `0175_platform_super_admin.sql`:

**New columns on `organizations`:**
- `access_tier text` — admin-forced tier override (`free|pro|business|enterprise`), null = no override (defer to Stripe/trial/default).
- `billing_arrangement text` — `standard|comped|trial|custom|stripe`, null/`standard` = default. Display + intent label.
- `custom_price_cents integer` — recorded agreed price (bookkeeping/display only; no charge unless via Stripe).
- `custom_price_interval text` — `month|year`, null otherwise.
- `trial_started_at timestamptz` — when a manual trial began (`trial_ends_at` already exists for the end).
- `trial_tier text` — tier the trial unlocks (default top sellable tier).
- `billing_notes text` — free-text admin context.
- `all_modules_comp boolean default false` — when true, the entitlement layer treats every premium module as enabled for this org (used with Comped/Enterprise).

**New table `platform_admin_audit`:**
- `id uuid pk default gen_random_uuid()`
- `actor_user_id uuid not null`, `actor_email text not null`
- `action text not null` (`viewed_org|acted_as_start|acted_as_end|billing_changed|password_reset_sent|org_provisioned|ticket_updated`)
- `target_organization_id uuid`, `target_user_id uuid`
- `detail jsonb not null default '{}'`
- `created_at timestamptz not null default now()`
- RLS: enabled, **no policies** (service-role only; the console reads it via the admin client behind the gate). Index on `(created_at desc)` and `(target_organization_id, created_at desc)`.

**Effective-plan resolver** (pure fn in `packages/core`): `resolveEffectivePlan(org) -> { tier: PlanId; source: 'override'|'stripe'|'trial'|'default'; trialDaysRemaining: number|null; arrangement }`. Encodes the precedence rule. Unit-tested across all combinations.

## Architecture / components

A new top-level route group `apps/web/src/app/(platform)/platform/...` — **not** nested under `(dashboard)` (which is org-scoped). Its layout calls `requirePlatformAdmin()` once.

- **`lib/auth/platform-admin.ts`** — extend with `requirePlatformAdmin()` (session + allowlist + AAL2; 404 on fail) and `assertPlatformAdminAal2()` for step-up.
- **`server/services/platform/` (the ONLY cross-org code):**
  - `platform-orgs.ts` — `listOrgs(search?)`, `getOrgOverview(orgId)`, `getOrgInventory(orgId, page)`, `getOrgMembers(orgId)`, `getOrgOrders(orgId, page)`. All service-role reads, each begins by re-asserting platform admin, each returns plain DTOs.
  - `platform-billing.ts` — `setBilling(orgId, input)` (tier/arrangement/custom price/notes/all-modules), `startTrial(orgId, days, tier)`, `extendTrial`, audited; step-up enforced in the action layer.
  - `platform-users.ts` — `sendPasswordReset(targetUserId)` via Supabase admin auth (`generateLink`/`resetPasswordForEmail`), audited.
  - `platform-audit.ts` — `record(action, ...)` insert helper + `listAudit(filter)`.
  - `platform-impersonation.ts` — `mintActAsToken(adminUserId, orgId)`, `verifyActAsToken(raw)`; HMAC-SHA256 signed (key derived from `SUPABASE_SERVICE_ROLE_KEY`), short TTL (~45 min), payload `{adminUserId, orgId, iat, exp, nonce}`.
- **`server/actions/platform/`** — thin action wrappers (provision + support fold in here).
- **Impersonation in `lib/auth/session.ts`:** `requireOrgContext` gains a branch — if a valid Act-As cookie is present AND `isPlatformAdmin(session.email)` AND the user is not a real member of the target org, build the OrgContext for the target org with `role: 'owner'` and an `impersonating: true` flag. Normal members and non-admins are unaffected. A `<ImpersonationBanner/>` renders in the dashboard layout whenever the flag is set.
- **UI pages:** `/platform` (Org Directory), `/platform/orgs/[id]` (detail w/ tabs: overview, inventory, users, orders, billing), `/platform/provision`, `/platform/support`, `/platform/audit`. Mirror the existing admin page styling.

## Build phases (each shippable + committed)

- **Phase 0 — Foundation:** migration; `requirePlatformAdmin()`; `(platform)` route group + layout + nav shell; Org Directory (list/search all orgs with resolved billing status); fold in Provision + Support. `platform_admin_audit` table + `record()` helper. Effective-plan resolver + tests.
- **Phase 1 — Viewing + password reset:** org detail read-only tabs (overview/inventory/users/orders) via `platform-orgs.ts`; "viewed_org" audit on detail open; per-user "Send password reset" button + action.
- **Phase 2 — Billing control:** billing panel (tier, arrangement, custom price, trial start/extend + days-remaining, notes, all-modules); `platform-billing.ts`; wire resolver into entitlement/plan reads; Stripe webhook respects override precedence; step-up on save.
- **Phase 3 — Act as this org:** token mint/verify; `requireOrgContext` impersonation branch; banner; step-up; start/end audit; exit.
- **Phase 4 — Audit screen:** `/platform/audit` feed with filters.

## Testing / safety bar (must pass before each commit)

- Non-admin (and admin without MFA) → 404 from every `/platform` page and every `platform/*` service.
- A platform admin's **normal** (non-impersonating) session still cannot read other orgs through the regular app (no RLS weakening).
- Forged / expired / wrong-org Act-As tokens are rejected; impersonation context is scoped to exactly the target org.
- `resolveEffectivePlan` returns the correct tier/source/days for every override/Stripe/trial/standard combination.
- Every god-mode action writes a `platform_admin_audit` row.
- Migration applies cleanly to the local stack; `tsc`, `eslint`, full test suite, and build all green.

## Rollout

Gated to `STOCKPILOT_PLATFORM_ADMIN_EMAILS` (only branden574@gmail.com). Invisible to everyone else; goes live on the real site only when that env var is set in Vercel production. No behavior changes for existing orgs until used.
