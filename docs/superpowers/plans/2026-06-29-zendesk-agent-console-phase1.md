# Zendesk Agent Console — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each StockPilot user connects their own Zendesk account via per-user OAuth and views their own tickets (list + detail), read-only, on web and mobile.

**Architecture:** A new per-user token store (`user_connections` + Vault) sits beside the existing per-org `org_connections`. Per-user OAuth start/callback routes obtain each user's token; a "current-user" API proxy resolves the signed-in user's token (auto-refreshing) and calls Zendesk's REST v2 API; web + mobile consoles render the results. The existing org-level push connector is untouched.

**Tech Stack:** Next.js 16 (App Router, route handlers, server actions), Supabase (Postgres 17 + RLS + Vault RPCs), Vitest, Expo/React Native (mobile), `expo-web-browser`/`expo-auth-session` for the native OAuth hop.

**Spec:** `docs/superpowers/specs/2026-06-29-zendesk-agent-console-design.md`. **Branch:** `feat/zendesk-agent-console` (already created; spec committed).

## Global Constraints

- **Credential wall:** ALL Zendesk HTTP is mocked in tests (fetch spy). No live Zendesk needed to land Phase 1. Live OAuth needs owner-provided `ZENDESK_OAUTH_CLIENT_ID` / `ZENDESK_OAUTH_CLIENT_SECRET`.
- **Per-user isolation is the core security property:** every `user_connections` row and every proxy call is scoped to `auth.uid()` / `ctx.userId`. A test MUST prove User A cannot read User B's connection or tickets.
- **Tokens live ONLY in Vault** (via `putConnectionSecret`), never in the table, never returned to the client, never logged.
- **Reuse, don't refactor:** model OAuth on `apps/web/src/server/connectors/quickbooks/oauth.ts`; vault via `apps/web/src/server/connectors/secret-store.ts`; routes via `withApiContext(req)` (returns `ctx` with `userId`, `organizationId`, `supabase`) like `apps/web/src/app/api/v1/zendesk/connect/route.ts`. Do NOT change `org_connections` or `connectors/zendesk/index.ts`.
- **SSRF guard:** subdomain is validated as a bare DNS label (`/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i`) before any host interpolation — reuse the existing regex in `connectors/zendesk/client.ts`.
- **Module + permission gate:** every route/service asserts `zendesk` module enabled + `zendesk:agent` permission.
- **Web + mobile parity:** the OAuth backend + proxy are shared; only the UI and the OAuth callback transport differ.
- **Error sanitization:** raw Zendesk/DB errors never reach the client (mirror the S13 posture — `ServiceError('internal_error', …)` surfaces a generic message).
- **Migration discipline:** the migration is the next sequential number after the current head in `supabase/migrations/`; apply to prod after merge via `supabase db push --linked`.
- **No Claude co-author trailer** on any commit.

---

## File Structure

**New (web):**
- `supabase/migrations/<next>_user_connections.sql` — table + RLS + indexes.
- `apps/web/src/server/connectors/zendesk/oauth.ts` — authorize URL, code exchange, token refresh (Zendesk OAuth2).
- `apps/web/src/server/connectors/zendesk/oauth-state.ts` — sign/verify the OAuth `state`.
- `apps/web/src/server/services/user-connections.ts` — `UserConnectionsService`: begin/complete connect, token resolution (+refresh), disconnect, status.
- `apps/web/src/app/api/v1/zendesk/oauth/start/route.ts`, `apps/web/src/app/api/v1/zendesk/oauth/callback/route.ts`.
- `apps/web/src/app/api/v1/zendesk/me/route.ts`, `apps/web/src/app/api/v1/zendesk/me/tickets/route.ts`, `apps/web/src/app/api/v1/zendesk/me/tickets/[id]/route.ts`, `apps/web/src/app/api/v1/zendesk/me/disconnect/route.ts`.
- `apps/web/src/components/zendesk/agent-console.tsx` (+ `ticket-list.tsx`, `ticket-detail.tsx`).

**Modified (web):**
- `apps/web/src/server/connectors/zendesk/client.ts` — add OAuth-bearer construction + `listMyTickets`, `getTicket`.
- `apps/web/src/app/(dashboard)/dashboard/zendesk/page.tsx` — render the console.
- `packages/core/src/constants/permissions.ts` — add `zendesk:agent`.
- `apps/web/src/lib/env.ts` — add `ZENDESK_OAUTH_CLIENT_ID`, `ZENDESK_OAUTH_CLIENT_SECRET` (optional at build, required at connect).

**New/Modified (mobile):**
- `apps/mobile/app/(drawer)/zendesk.tsx` — console screen.
- `apps/mobile/src/lib/zendesk-oauth.ts` — `expo-web-browser` hop + `stockpilot://zendesk/connected` callback.

---

## Task 1: `user_connections` table + per-user RLS

**Files:**
- Create: `supabase/migrations/<next>_user_connections.sql`
- Test: `supabase/tests/user_connections_rls.test.sql` (pgTAP — the repo runs pgTAP in CI/`supabase test db`)

**Interfaces:**
- Produces: table `public.user_connections (id, organization_id, user_id, provider_id, subdomain, external_account jsonb, secret_id uuid, status text, last_error text, last_connected_at timestamptz, created_at, updated_at)`; unique `(organization_id, user_id, provider_id)`; RLS so `auth.uid() = user_id`.

- [ ] **Step 1: Write the migration**

```sql
-- <next>_user_connections.sql — per-user external connections (Zendesk agent console).
-- Distinct from org_connections (per-org). One row per (org, user, provider).
create table if not exists public.user_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_id text not null,
  subdomain text,
  external_account jsonb not null default '{}'::jsonb,
  secret_id uuid,
  status text not null default 'active' check (status in ('active','disconnected','error')),
  last_error text,
  last_connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id, provider_id)
);
create index if not exists user_connections_org_user_idx on public.user_connections (organization_id, user_id);
create index if not exists user_connections_user_provider_idx on public.user_connections (user_id, provider_id);

alter table public.user_connections enable row level security;

-- A user may only see/manage THEIR OWN connection rows, within an org they belong to.
create policy user_connections_select on public.user_connections
  for select using (
    user_id = auth.uid()
    and exists (select 1 from public.organization_members m
                where m.organization_id = user_connections.organization_id
                  and m.user_id = auth.uid() and m.accepted_at is not null)
  );
create policy user_connections_insert on public.user_connections
  for insert with check (
    user_id = auth.uid()
    and exists (select 1 from public.organization_members m
                where m.organization_id = user_connections.organization_id
                  and m.user_id = auth.uid() and m.accepted_at is not null)
  );
create policy user_connections_update on public.user_connections
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy user_connections_delete on public.user_connections
  for delete using (user_id = auth.uid());

grant select, insert, update, delete on public.user_connections to authenticated;
```

- [ ] **Step 2: Write the pgTAP isolation test**

```sql
-- user_connections_rls.test.sql — prove a user can't see another user's row.
begin;
select plan(2);
-- (Insert two rows as service-role for two users in the same org, then set
--  request.jwt.claim.sub to user A and assert only A's row is visible.)
set local role authenticated;
select set_config('request.jwt.claim.sub', '<USER_A_UUID>', true);
select is( (select count(*)::int from public.user_connections), 1, 'user A sees only their own row');
select set_config('request.jwt.claim.sub', '<USER_B_UUID>', true);
select is( (select count(*)::int from public.user_connections), 1, 'user B sees only their own row');
select * from finish();
rollback;
```

- [ ] **Step 3: Run the test to verify it fails (table absent)** — `supabase test db` → FAIL "relation user_connections does not exist". (If local Docker stack unavailable, run the migration in a scratch DB and assert the policies exist via `pg_policies`.)
- [ ] **Step 4: Apply the migration locally + re-run** → PASS (both users see exactly 1 row).
- [ ] **Step 5: Commit** — `git add supabase/migrations/<next>_user_connections.sql supabase/tests/user_connections_rls.test.sql && git commit -m "feat(zendesk): user_connections table + per-user RLS"`

---

## Task 2: `zendesk:agent` permission

**Files:**
- Modify: `packages/core/src/constants/permissions.ts`
- Test: `packages/core/src/constants/permissions.test.ts`

**Interfaces:**
- Produces: a `'zendesk:agent'` permission string available to `assertPermission(ctx, 'zendesk:agent')` and the role/permission matrix.

- [ ] **Step 1: Add a failing test** asserting `'zendesk:agent'` is a known permission (mirror an existing membership test in `permissions.test.ts`).
- [ ] **Step 2: Run it → FAIL** (`pnpm --filter @stockpilot/core test permissions`).
- [ ] **Step 3: Add `'zendesk:agent'`** to the permission union/list in `permissions.ts` (follow the exact shape of a neighbor like `'integrations:manage'`; default it grantable to admin/manager — copy the neighbor's default flags).
- [ ] **Step 4: Run it → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(zendesk): add zendesk:agent permission"`

---

## Task 3: Zendesk OAuth helpers (`oauth.ts`)

**Files:**
- Create: `apps/web/src/server/connectors/zendesk/oauth.ts`
- Test: `apps/web/src/server/connectors/zendesk/oauth.test.ts`
- Modify: `apps/web/src/lib/env.ts` (add `ZENDESK_OAUTH_CLIENT_ID`, `ZENDESK_OAUTH_CLIENT_SECRET`)

**Interfaces:**
- Produces:
  - `buildAuthorizeUrl(subdomain: string, state: string, scopes: string): string`
  - `exchangeCode(subdomain: string, code: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: string }>`
  - `refreshTokens(subdomain: string, refreshToken: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: string }>`
- Consumes: `env.ZENDESK_OAUTH_CLIENT_ID/SECRET`, `env.NEXT_PUBLIC_APP_URL`.

- [ ] **Step 1: Write failing tests** (fetch spy, modeled on the QBO oauth test style):

```ts
import { describe, expect, it, vi } from 'vitest';
import { buildAuthorizeUrl, exchangeCode } from './oauth';

describe('zendesk oauth', () => {
  it('builds an authorize URL on the org subdomain with state + scopes', () => {
    const url = buildAuthorizeUrl('acme', 'STATE123', 'read');
    expect(url).toContain('https://acme.zendesk.com/oauth/authorizations/new');
    expect(url).toContain('response_type=code');
    expect(url).toContain('state=STATE123');
    expect(url).toContain('scope=read');
  });
  it('exchanges a code for tokens + derives expiresAt', async () => {
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
      { status: 200 },
    ));
    const r = await exchangeCode('acme', 'code123', fetchSpy as unknown as typeof fetch);
    expect(r.accessToken).toBe('at');
    expect(r.refreshToken).toBe('rt');
    expect(new Date(r.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(fetchSpy).toHaveBeenCalledWith('https://acme.zendesk.com/oauth/tokens', expect.objectContaining({ method: 'POST' }));
  });
});
```

- [ ] **Step 2: Run → FAIL** (`pnpm --filter web test oauth.test` — function not defined).
- [ ] **Step 3: Implement** (model on `quickbooks/oauth.ts`: raw fetch, `client_id`/`client_secret` in the body per Zendesk's OAuth, `expiresAtFrom`, accept an injectable `fetchImpl` for tests):

```ts
import 'server-only';
import { env } from '@/lib/env';

const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
function assertSubdomain(s: string) { if (!SUBDOMAIN_RE.test(s)) throw new Error('Invalid Zendesk subdomain'); }
function redirectUri() { return `${env.NEXT_PUBLIC_APP_URL}/api/v1/zendesk/oauth/callback`; }
function expiresAtFrom(sec: number) { return new Date(Date.now() + sec * 1000).toISOString(); }

export function buildAuthorizeUrl(subdomain: string, state: string, scopes: string): string {
  assertSubdomain(subdomain);
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: env.ZENDESK_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri(),
    scope: scopes,
    state,
  });
  return `https://${subdomain}.zendesk.com/oauth/authorizations/new?${q.toString()}`;
}

interface TokenResp { access_token: string; refresh_token: string; expires_in: number; }
async function postToken(subdomain: string, body: Record<string, string>, fetchImpl: typeof fetch): Promise<TokenResp> {
  assertSubdomain(subdomain);
  const res = await fetchImpl(`https://${subdomain}.zendesk.com/oauth/tokens`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...body, client_id: env.ZENDESK_OAUTH_CLIENT_ID, client_secret: env.ZENDESK_OAUTH_CLIENT_SECRET, redirect_uri: redirectUri() }),
  });
  if (!res.ok) throw new Error(`Zendesk token request failed (status ${res.status})`); // never log tokens
  return (await res.json()) as TokenResp;
}

export async function exchangeCode(subdomain: string, code: string, fetchImpl: typeof fetch = fetch) {
  const t = await postToken(subdomain, { grant_type: 'authorization_code', code, scope: 'read' }, fetchImpl);
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: expiresAtFrom(t.expires_in) };
}
export async function refreshTokens(subdomain: string, refreshToken: string, fetchImpl: typeof fetch = fetch) {
  const t = await postToken(subdomain, { grant_type: 'refresh_token', refresh_token: refreshToken }, fetchImpl);
  return { accessToken: t.access_token, refreshToken: t.refresh_token ?? refreshToken, expiresAt: expiresAtFrom(t.expires_in) };
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(zendesk): per-user OAuth code-exchange + refresh helpers"`

---

## Task 4: OAuth `state` signing (`oauth-state.ts`)

**Files:**
- Create: `apps/web/src/server/connectors/zendesk/oauth-state.ts`
- Test: `apps/web/src/server/connectors/zendesk/oauth-state.test.ts`

**Interfaces:**
- Produces: `signState(payload: { orgId: string; userId: string; platform: 'web'|'mobile' }): string` and `verifyState(state: string): { orgId; userId; platform } | null` (HMAC-signed with `env.AUTH_SECRET` or equivalent app secret, 10-min expiry, single-use nonce embedded).

- [ ] **Step 1: Failing test:** round-trips a payload; a tampered or expired state returns `null`; a different-secret signature returns `null`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** with `crypto.createHmac('sha256', secret)` over `base64url(JSON{...,exp,nonce})`, compare with `timingSafeEqual`; reject `exp < now`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(zendesk): signed single-use OAuth state"`

---

## Task 5: `UserConnectionsService`

**Files:**
- Create: `apps/web/src/server/services/user-connections.ts`
- Test: `apps/web/src/server/services/user-connections.test.ts`

**Interfaces:**
- Consumes: Task 3 (`buildAuthorizeUrl`/`exchangeCode`/`refreshTokens`), Task 4 (`signState`/`verifyState`), `secret-store` (`putConnectionSecret`/`getConnectionSecret`/`deleteConnectionSecret`), `ServiceContext` (`ctx.userId`, `ctx.organizationId`, `ctx.supabase`), `createAdminClient()`.
- Produces:
  - `beginZendeskConnect(platform): Promise<{ authorizeUrl: string }>` — assert module+perm, resolve org subdomain, sign state, build URL.
  - `completeZendeskConnect(code: string, state: string): Promise<void>` — verify state, `exchangeCode`, `validateToken`/`/users/me`, `putConnectionSecret`, upsert `user_connections` (status `active`).
  - `getValidAccessToken(): Promise<{ subdomain: string; accessToken: string }>` — read the caller's row + vault; if `expiresAt` past (or <60s), `refreshTokens` + re-vault + bump row; throw `ServiceError('not_found')` if not connected.
  - `status(): Promise<{ connected: boolean; account?: object }>`; `disconnect(): Promise<void>` (delete secret + row).

- [ ] **Step 1: Failing tests** (mock the oauth helpers, secret-store, and a supabase stub via the existing `makeSupabaseStub`):
  - `beginZendeskConnect` returns an authorize URL containing a valid state.
  - `completeZendeskConnect` rejects a bad state (no vault write, no upsert).
  - `completeZendeskConnect` with a good state vaults the bundle and upserts `active`.
  - `getValidAccessToken` refreshes when `expiresAt` is in the past and re-vaults the rotated token.
  - **isolation:** `getValidAccessToken` reads only `where user_id = ctx.userId` (assert the query filter).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** (follow `ConnectionsService.connectZendesk` for the assert/validate/vault/upsert shape; the secret name = `user:${ctx.userId}:zendesk`; the subdomain comes from the org's Zendesk setting — read from `org_connections` settings or an org setting; if absent, throw `ServiceError('validation_error', 'Set your organization\'s Zendesk subdomain first.')`).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(zendesk): UserConnectionsService (connect/refresh/disconnect)"`

---

## Task 6: Extend `ZendeskClient` for OAuth + reads

**Files:**
- Modify: `apps/web/src/server/connectors/zendesk/client.ts`
- Test: `apps/web/src/server/connectors/zendesk/client.test.ts`

**Interfaces:**
- Produces: a way to construct `ZendeskClient` with an OAuth bearer (`{ subdomain, accessToken }`) in addition to the existing Basic config; `listMyTickets(opts: { view?: 'assigned'|'requested'; query?: string }): Promise<Ticket[]>` (GET `/api/v2/search.json?query=...` or `/users/me/tickets`); `getTicket(id: number): Promise<{ ticket: Ticket; comments: Comment[] }>`.

- [ ] **Step 1: Failing tests** (fetch spy): bearer auth header set; `listMyTickets` hits the right endpoint + maps results; `getTicket` fetches ticket + comments; a 401 throws `ZendeskApiError(401)`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — add a second constructor path/overload that sets `authHeader = 'Bearer ' + accessToken`; add the two read methods (reuse the SSRF subdomain guard already in the file).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(zendesk): ZendeskClient OAuth bearer + ticket reads"`

---

## Task 7: OAuth routes (`start` + `callback`)

**Files:**
- Create: `apps/web/src/app/api/v1/zendesk/oauth/start/route.ts`, `apps/web/src/app/api/v1/zendesk/oauth/callback/route.ts`
- Test: `apps/web/src/app/api/v1/zendesk/oauth/oauth-routes.test.ts`

**Interfaces:**
- Consumes: `withApiContext(req)`, `UserConnectionsService`.

- [ ] **Step 1: Failing tests** (mock `withApiContext` + `UserConnectionsService`, mirroring `zendesk-routes.test.ts`): `start` 401 when unauthenticated; 302 to the authorize URL when authed; `callback` calls `completeZendeskConnect(code, state)` then 302s to `/dashboard/zendesk?connected=1` (web) or `stockpilot://zendesk/connected` (mobile, per state.platform).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** both route handlers (`runtime='nodejs'`, `dynamic='force-dynamic'`; `start` → `NextResponse.redirect(authorizeUrl)`; `callback` → complete then redirect; `ServiceError`→status mapping copied from the existing connect route).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(zendesk): per-user OAuth start + callback routes"`

---

## Task 8: Current-user API proxy

**Files:**
- Create: `apps/web/src/app/api/v1/zendesk/me/route.ts`, `me/tickets/route.ts`, `me/tickets/[id]/route.ts`, `me/disconnect/route.ts`
- Test: `apps/web/src/app/api/v1/zendesk/me/me-routes.test.ts`

**Interfaces:**
- Consumes: `withApiContext`, `UserConnectionsService.getValidAccessToken()`, `ZendeskClient` (bearer).

- [ ] **Step 1: Failing tests:** `GET /me` returns `{ connected, account }`; `GET /me/tickets` returns the mocked ticket list; `GET /me/tickets/:id` returns ticket+comments; **isolation:** a request as User B (no connection) gets `{ connected: false }` / 404, never User A's data; `POST /me/disconnect` deletes the row+secret. All Zendesk HTTP mocked.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** each handler: `ctx = withApiContext(req)` → `svc.getValidAccessToken()` → `new ZendeskClient({ subdomain, accessToken })` → call → normalized JSON; sanitize errors.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(zendesk): current-user tickets API proxy"`

---

## Task 9: Web console UI

**Files:**
- Create: `apps/web/src/components/zendesk/agent-console.tsx`, `ticket-list.tsx`, `ticket-detail.tsx`
- Modify: `apps/web/src/app/(dashboard)/dashboard/zendesk/page.tsx`
- Test: `apps/web/src/components/zendesk/agent-console.test.tsx` (render states; the proxy fetch mocked)

**Interfaces:**
- Consumes: the `/api/v1/zendesk/me*` proxy (client `fetch`).

- [ ] **Step 1: Failing test:** renders the "Connect my Zendesk" card when `GET /me` → `{connected:false}`; renders the ticket list when connected (mocked `/me/tickets`); clicking a row loads detail (mocked `/me/tickets/:id`).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the `'use client'` console: a connect card linking to `/api/v1/zendesk/oauth/start`; a ticket list (subject, requester, status/priority badge, updated-at) + a detail pane (conversation thread). The page server-component gates on `can(ctx,'zendesk:agent')` + module, then renders `<AgentConsole/>`. Follow `components/zendesk/zendesk-connect-card.tsx` for styling.
- [ ] **Step 4: Run → PASS** + `pnpm --filter web typecheck` + `pnpm --filter web build`.
- [ ] **Step 5: Commit** — `git commit -m "feat(zendesk): web agent console (connect + my tickets)"`

---

## Task 10: Mobile console screen

**Files:**
- Create: `apps/mobile/src/lib/zendesk-oauth.ts`
- Modify: `apps/mobile/app/(drawer)/zendesk.tsx`
- Test: `apps/mobile/src/lib/zendesk-oauth.test.ts` (the WebBrowser hop mocked)

**Interfaces:**
- Consumes: the `/api/v1/zendesk/me*` proxy via the app's Bearer `api()` client; `expo-web-browser`.

- [ ] **Step 1: Failing test:** `connectZendesk()` opens the start URL via `WebBrowser.openAuthSessionAsync` and resolves on the `stockpilot://zendesk/connected` redirect; the screen shows connect → list → detail off mocked `api()` responses.
- [ ] **Step 2: Run → FAIL** (`pnpm --filter mobile test`).
- [ ] **Step 3: Implement** `connectZendesk` (open `${API_URL}/api/v1/zendesk/oauth/start` with the Bearer token, await the deep-link return) and the screen (connect card → `api('/zendesk/me/tickets')` list → detail), gated by `useEnabledModules` (`zendesk`) + the `zendesk:agent` permission.
- [ ] **Step 4: Run → PASS** + `pnpm --filter mobile typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "feat(zendesk): mobile agent console (connect + my tickets)"`

---

## Self-Review

**Spec coverage:** §3 architecture → Tasks 1,5–8; §4 data model → Task 1; §5 OAuth → Tasks 3,4,7 (+ mobile transport Task 10); §6 proxy → Task 8; §7 UI → Tasks 9,10; §8 security (per-user RLS + isolation tests) → Tasks 1,5,8; §9 testing (mocked Zendesk) → every task. Permission gate (`zendesk:agent`) → Task 2. P2/P3 are out of this plan by design.

**Placeholder scan:** the migration number `<next>` and the pgTAP `<USER_A_UUID>` are resolved at execution (the implementer picks the next migration number and seeds real UUIDs) — not vague TBDs. All code steps carry real code.

**Type consistency:** `exchangeCode`/`refreshTokens` return `{accessToken, refreshToken, expiresAt}` (Task 3) → consumed verbatim by `UserConnectionsService` (Task 5) → vaulted as `ConnectorSecrets`. `getValidAccessToken` returns `{subdomain, accessToken}` (Task 5) → consumed by the proxy (Task 8) → `ZendeskClient({subdomain, accessToken})` (Task 6). `signState`/`verifyState` payload `{orgId,userId,platform}` (Task 4) → used by routes (Task 7). Consistent.
