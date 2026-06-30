# Per-user Zendesk Agent Console — Design Spec

**Date:** 2026-06-29
**Status:** Approved (design) — pending spec review → implementation plan
**Module:** `zendesk`
**Apps:** web (`apps/web`) + mobile (`apps/mobile`)

---

## 1. Goal

Let each StockPilot user **connect their own Zendesk account** (per-user OAuth) and **view and work their own Zendesk tickets — as their own Zendesk identity — inside StockPilot**, on both web and mobile, with the option to surface linked StockPilot order/return/item context.

This replaces the gap in today's integration: a single org-level API token (one shared "agent email") that cannot represent individual agents. The existing org-level **push connector** (auto-creating tickets from events) is **unchanged** and coexists with this.

### Success criteria
- A user clicks "Connect my Zendesk," completes OAuth, and sees **their own** tickets (P1).
- User A can never read or act on User B's tickets or token (per-user isolation, proven by test).
- The whole feature is built and unit/integration-tested with **Zendesk mocked** ("credential wall"): it goes live once the owner registers one Zendesk OAuth client and supplies its credentials. No live Zendesk is required to land the code.

---

## 2. Scope & Phasing

Each phase is independently shippable and testable.

- **Phase 1 — Connect + Read (web + mobile):** per-user OAuth connect/disconnect; list "my" tickets (open/pending + search) and view a ticket's detail (conversation, requester, status, priority, tags). Read-only.
- **Phase 2 — Act (web + mobile):** add a public reply and an internal note; update status / priority / assignee / tags; create a new ticket — all attributed to the signed-in user.
- **Phase 3 — Linked context:** link a ticket ↔ a StockPilot order / return / item; show StockPilot context beside a ticket, and a "Linked tickets" panel on order/return pages.

**This spec drives Phase 1 first.** P2 and P3 reuse the same backend (token store + proxy) and are additive.

### Global constraints
- Build to the **credential wall**: all code + tests ship with Zendesk mocked. Live OAuth requires the owner to register one Zendesk OAuth client (client_id/secret + redirect) and add it as a secret; each agent needs a Zendesk seat. These gate **go-live**, not the build.
- **Web + mobile parity** (per the standing "web features ship on mobile too" rule). The OAuth backend and API proxy are shared; only the UI + the OAuth callback transport differ.
- Reuse existing patterns; do not refactor the org-level connector or `org_connections`.
- Subdomain handling keeps the existing **SSRF guard** (bare DNS label only).

---

## 3. Architecture

Two halves coexist:

1. **Org push connector (unchanged):** `connectors/zendesk/*` keeps turning `return.created` / `public_request.created` / `order.problem` outbox events into tickets under the org service token (`org_connections`, provider `zendesk`).
2. **Per-user console (new):** each user's own OAuth token (`user_connections`); all reads/writes are attributed to that user.

### Reuse (already in the codebase)
- **OAuth flow shape:** `apps/web/src/server/connectors/quickbooks/oauth.ts` and `sage-intacct/oauth.ts` (authorize → callback → exchange → refresh).
- **Vault secret store:** `apps/web/src/server/connectors/secret-store.ts` — `putConnectionSecret` / `getConnectionSecret` / `deleteConnectionSecret`, storing `{ accessToken, refreshToken, expiresAt }`.
- **Zendesk REST client:** `apps/web/src/server/connectors/zendesk/client.ts` (`ZendeskClient`) — extend from Basic-token-only to also accept an OAuth bearer, and add read methods (`listMyTickets`, `getTicket`, and P2 `createTicket` already exists, plus `addComment`, `updateTicket`).
- **Module gating:** `assertModuleEnabled(ctx, 'zendesk')`; the `zendesk` module already exists (mig 0165).

### New
- `user_connections` table + a `UserConnectionsService` (or extend `ConnectionsService` with per-user methods).
- Per-user OAuth start/callback routes.
- A current-user API proxy for tickets.
- Web console UI + mobile console screen.
- A new `zendesk:agent` permission.

---

## 4. Data Model

New table **`public.user_connections`** (migration, next number after the current head):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `organization_id` | uuid NOT NULL | FK → organizations |
| `user_id` | uuid NOT NULL | FK → auth.users |
| `provider_id` | text NOT NULL | e.g. `'zendesk'` (free-text, mirrors org_connections) |
| `subdomain` | text | the Zendesk subdomain |
| `external_account` | jsonb | the connected Zendesk user (id, email, name) from `/users/me` |
| `secret_id` | uuid | vault secret reference (token bundle) |
| `status` | text | `'active' | 'disconnected' | 'error'` |
| `last_error` | text | last failure message (sanitized) |
| `last_connected_at` | timestamptz | |
| `created_at` / `updated_at` | timestamptz | |

- **Unique:** `(organization_id, user_id, provider_id)` — one connection per user per provider per org.
- **RLS:** SELECT/INSERT/UPDATE/DELETE allowed **only** where `user_id = auth.uid()` AND the user is a member of `organization_id`. A user can only ever touch **their own** connection row. (The vault secret itself is written/read by the service-role helper, never exposed to the client.)
- **Indexes:** `(organization_id, user_id)`; `(user_id, provider_id)`.

The token bundle (`accessToken`, `refreshToken`, `expiresAt`) lives in the vault via `putConnectionSecret`, keyed by `secret_id` — **not** in the table.

---

## 5. OAuth Flow

One Zendesk OAuth client (owner-registered) is shared by all users; the per-user distinction is the **token**, not the client.

### Web
1. `GET /api/v1/zendesk/oauth/start` — requires the `zendesk` module + `zendesk:agent`. Generates a signed, single-use **`state`** (encodes org_id + user_id + nonce + expiry), stores the nonce server-side (or signs it), and 302-redirects to `https://{subdomain}.zendesk.com/oauth/authorizations/new?...` with `response_type=code`, the client_id, redirect_uri, and the requested **scopes** (P1: `read`; P2 adds `tickets:write`).
2. `GET /api/v1/zendesk/oauth/callback?code&state` — validates `state` (CSRF), exchanges `code` for `{ access_token, refresh_token, expires_in }` at Zendesk's token endpoint, calls `/users/me` to capture the agent identity, `putConnectionSecret`, and upserts the user's `user_connections` row as `active`. Redirects back to the console.

### Mobile
Same backend. The native app opens the authorize URL via `expo-web-browser`/`expo-auth-session`, and the OAuth `redirect_uri` returns to the app via the existing **`stockpilot://`** deep-link scheme; the app then calls the finalize endpoint (Bearer) with the `code`+`state`. (If a single redirect_uri must serve both, the callback detects platform via `state` and either 302s to the web console or deep-links to `stockpilot://zendesk/connected`.)

### Refresh
A `getValidUserToken(userId)` helper reads the vault bundle; if `expiresAt` is past (or within a skew), it refreshes via the refresh token, re-vaults, and returns the fresh access token. Mirrors the QBO/Sage refresh path. All proxy calls go through this helper.

### Subdomain
Where does the per-user subdomain come from? Default to the **org's** Zendesk subdomain (from the org connection / a setting) so users don't each type it; allow an override only if needed. Keep the DNS-label SSRF guard.

---

## 6. API Proxy (current-user)

Thin StockPilot endpoints; each resolves the **signed-in user's** token (cookie on web, Bearer `/api/v1` on mobile), refreshes if needed, calls Zendesk, returns **normalized JSON** (never the raw token):

- `GET /api/v1/zendesk/me` — connection status + connected Zendesk identity.
- `GET /api/v1/zendesk/me/tickets?view=assigned|requested|search&q=` — my tickets (paginated).
- `GET /api/v1/zendesk/me/tickets/:id` — ticket + comments.
- **P2:** `POST /api/v1/zendesk/me/tickets` (create), `POST …/tickets/:id/comments` (public/internal), `PUT …/tickets/:id` (status/priority/assignee/tags).
- `POST /api/v1/zendesk/me/disconnect` — revoke + delete the user's token + row.

Errors map to clean `ActionResult`/HTTP codes; raw Zendesk/DB errors never reach the client (matches the S13 sanitization posture).

---

## 7. Console UI

### Web — `/dashboard/zendesk` (replaces the current shell page)
- **Not connected:** a "Connect my Zendesk" card → `oauth/start`.
- **Connected:** header shows the connected Zendesk identity + Disconnect; a **ticket list** (my open/pending, a search box, status/priority badges, requester, updated-at) and a **detail pane** (full conversation thread, requester, tags, status/priority). P2 adds the reply composer (public reply / internal note toggle) and status/assignee controls; a "New ticket" action.

### Mobile — `(drawer)/zendesk` (replaces the current shell screen)
- Mirrors web: connect card → ticket list → ticket detail → (P2) reply. Uses the Bearer `/api/v1` proxy and `useEnabledModules` so it only shows when the org has `zendesk` on and the user has `zendesk:agent`.

Both gate on `zendesk` module + `zendesk:agent` permission; both show a clear empty/disconnected state.

---

## 8. Security

- **Per-user isolation:** `user_connections` RLS restricts every row to `user_id = auth.uid()`; the API proxy resolves the token from the **caller's** row only. Test: User A cannot read User B's tickets or token.
- **Tokens** live in the vault (encrypted), never returned to the client; logs never include them.
- **OAuth CSRF:** signed single-use `state` with org_id+user_id+expiry; callback rejects mismatches/expired state.
- **SSRF:** subdomain validated as a bare DNS label before any host interpolation (existing guard).
- **Gating:** `assertModuleEnabled('zendesk')` + `assertPermission('zendesk:agent')` on every route/action.
- **Disconnect / offboarding:** disconnect revokes at Zendesk (best-effort) + deletes the vault secret + row; removing a user from the org cascades (FK).

---

## 9. Testing (Zendesk mocked)

Mirror the existing `zendesk-routes.test.ts` / `connections.zendesk.test.ts` mocking style:
- **OAuth:** start builds the correct authorize URL + signs state; callback validates state, exchanges the code (mocked token endpoint), captures `/users/me`, vaults the bundle, upserts `active`.
- **Refresh:** an expired `expiresAt` triggers a refresh before the call; a refresh failure marks the connection `error` without throwing the page.
- **Per-user RLS isolation:** a request as User A cannot read User B's connection/tickets (service + route level).
- **API proxy:** list/detail normalize Zendesk responses; raw errors are sanitized.
- **UI:** connect/disconnect states; list + detail render; (P2) reply/update call the right endpoints.
- No live Zendesk; all Zendesk HTTP is mocked.

---

## 10. Dependencies & Out of Scope

**Owner (gates go-live, not the build):**
- Register **one** Zendesk OAuth client (client_id/secret + redirect URI) and add the credentials as a secret/env (`ZENDESK_OAUTH_CLIENT_ID` / `ZENDESK_OAUTH_CLIENT_SECRET`).
- Ensure each agent has a **Zendesk agent seat** (per-user profiles require Zendesk licenses).

**Out of scope:** changing the org-level push connector; SLA/agent-performance reporting; Zendesk automation/trigger management; non-ticket Zendesk objects (Help Center, chat).

---

## 11. File-level touch list (for the plan)

**New (web):**
- `supabase/migrations/0xxx_user_connections.sql` — table + RLS + indexes.
- `apps/web/src/server/connectors/zendesk/oauth.ts` — authorize URL + token exchange/refresh (model on quickbooks/oauth.ts).
- `apps/web/src/server/services/user-connections.ts` — per-user connect/refresh/disconnect + token resolution.
- `apps/web/src/app/api/v1/zendesk/oauth/start/route.ts`, `…/oauth/callback/route.ts`.
- `apps/web/src/app/api/v1/zendesk/me/route.ts`, `…/me/tickets/route.ts`, `…/me/tickets/[id]/route.ts`, `…/me/disconnect/route.ts`.
- `apps/web/src/components/zendesk/agent-console.tsx` (+ list/detail subcomponents).

**Modified (web):**
- `apps/web/src/server/connectors/zendesk/client.ts` — OAuth-bearer support + `listMyTickets`/`getTicket` (P2: `addComment`/`updateTicket`).
- `apps/web/src/app/(dashboard)/dashboard/zendesk/page.tsx` — render the console.
- `packages/core/src/permissions/*` — add `zendesk:agent`.

**New/Modified (mobile):**
- `apps/mobile/app/(drawer)/zendesk.tsx` — the console screen (connect → list → detail).
- mobile OAuth helper using `expo-web-browser`/`expo-auth-session` + `stockpilot://` callback.

---

_End of design spec._
