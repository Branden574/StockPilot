# Mobile Integrations Parity (manage + monitor) — Design

**Goal:** Bring QuickBooks/integrations management to the mobile app — view connection **status + sync health**, **disconnect**, and **edit the account mapping**. The one-time OAuth **connect stays on web** (Option 2). Ships as: new web `/api/v1` endpoints (Vercel) + a mobile screen (Expo **OTA**, native-safe — no app-store build).

**Why this scope (decided 2026-05-30):** Connecting QBO is a one-time owner/admin setup (natural on web). The recurring mobile value is *visibility* ("did my receipts post? any failures?") plus the occasional disconnect / account-mapping tweak. Connect-on-mobile (Option 1) is a clean later add (a Connect button + `begin` endpoint + `openAuthSessionAsync` + a callback deep-link branch) with zero rework — explicitly deferred.

## Scope

**IN:**
- 3 web REST endpoints under `/api/v1/integrations/connections*` (Bearer + `withApiContext`), reusing `ConnectionsService`.
- A mobile **Settings → Integrations** screen (status, sync health, disconnect, account-mapping form).
- Gating: visible only when the `integrations` module is enabled AND the user is an admin (client-side `isAdmin`); the server enforces the real `integrations:manage` permission.

**OUT (unchanged / deferred):**
- Mobile OAuth **connect** (stays web; deferred Option-1 upgrade).
- The drainer / connector / Bill / valuation engine (server-side, surface-agnostic — untouched).
- The OAuth callback route (unchanged — connect is web-only, so no mobile deep-link needed yet).
- No shared-registry `mobile_drawer` placement — surfaced via a Settings row instead (less churn, mirrors web's "Settings → Integrations").

## Architecture

**Backend (deploys with web on merge):** Three thin route handlers that mirror `apps/web/src/app/api/v1/cycle-counts/route.ts` — `const ctx = await withApiContext(req); if (!ctx) return 401;` then construct `new ConnectionsService(ctx)` and call the existing method. All gating (`assertModuleEnabled('integrations')`, `assertPermission('integrations:manage')`) already lives in `ConnectionsService`; the routes only map `ServiceError` → HTTP. `withApiContext` resolves org (via `X-Organization-Id` → default → any membership) + role + enabled modules + MFA, same as the other mobile endpoints. `ConnectionsService` is constructed directly from the api ctx (it already accepts a `ServiceContext` via its constructor; `forCurrentUser()` is the web/cookie variant).

**Mobile (ships as OTA — native-safe, runtime 1.0.0 / build #23):** A new screen reached from a gated row in the existing monolithic `app/(drawer)/settings.tsx`. Uses the existing `api<T>()` client (`src/lib/api.ts`: Bearer token + `X-Organization-Id`). Config writes (disconnect, save mapping) are **direct online calls** (not the offline queue — these are admin settings actions performed while connected, not field operations). No new native dependency, no scheme change.

## Endpoints

| Method + path | Body | Returns | Gates |
|---|---|---|---|
| `GET /api/v1/integrations/connections` | — | `{ connections: ConnectionView[], health: SyncHealthRow[] }` | `withApiContext` + `assertModuleEnabled('integrations')` (member-read; mirrors `ConnectionsService.list()`) |
| `DELETE /api/v1/integrations/connections/[provider]` | — | `{ ok: true }` | + `assertPermission('integrations:manage')` |
| `POST /api/v1/integrations/connections/[provider]/account-mapping` | `{ billExpense, inventoryAsset, valuationOffset }` | `{ ok: true }` | + `assertPermission('integrations:manage')` |

`provider` is validated against `ConnectorProviderId` (`'quickbooks'`) → 400 on unknown. `ServiceError` → HTTP map (mirror cycle-counts): `unauthenticated`→401, `forbidden`→403, `module_disabled`→403, `not_found`→404, `validation_error`→400, `internal_error`→500. `ConnectionView`/`SyncHealthRow`/`ConnectionsListResult` types are exported from `apps/web/src/server/services/connections.ts` (reuse them).

## Mobile screen (`Settings → Integrations`)

- **On focus:** `GET /api/v1/integrations/connections`. Render a QuickBooks card: status badge (`active`/`error`/`disconnected`/`pending`), realm id (`externalAccountId`), `lastSyncedAt`, `lastError`.
- **Not connected** (no row, or status `disconnected`/`pending`): show an inline hint — "Connect QuickBooks from the web app (Settings → Integrations)." No mobile connect button.
- **Account mapping:** three text inputs (`Expense` / `Inventory asset` / `Valuation offset`) prefilled from `accountIds`; **Save** → POST → toast + refetch.
- **Disconnect:** confirm dialog → DELETE → refetch.
- **Sync health:** list recent rows (topic, status icon, external id, attempts, last error, completed time).
- **Gating:** the Settings row renders only when `enabledModules.has('integrations') && isAdmin` (`useEnabledModules` + `useRole`). If a non-admin or module-off user reaches the screen, show an empty "Integrations isn't enabled / admins only" state. The server is the source of truth (403 → friendly message).

## Error handling

`api()` throws on non-OK (status + body). The screen surfaces: network/500 → "Couldn't load integrations, retry"; 403 → "You don't have permission" or "Integrations isn't enabled for this workspace"; empty → the not-connected hint. Saves/disconnect show a toast on success and an inline error on failure (no silent failures).

## Testing

- **Backend:** a route test per endpoint mirroring the cycle-counts route test — 200 happy path (service method invoked, shape returned), 401 when `withApiContext` yields no ctx, 403 when the module is disabled, 403 when the role lacks `integrations:manage` (disconnect + mapping), 400 on unknown provider. Mock `ConnectionsService` / `withApiContext`.
- **Mobile:** if the mobile package has a test setup, a light test of the data→view mapping + the gating predicate (`isAdmin && module enabled`); otherwise covered by tsc + the manual checklist.
- Full `tsc` clean across `apps/web` and `apps/mobile`.

## Native-safety / shipping

OTA-safe: no new native dependency, no `scheme`/config change, no native module. Backend ships via Vercel on merge to `main`; mobile ships via `eas update --branch production` (runtime 1.0.0, build #23). `eas-cli` is not installed in the build env — publish with `npx eas-cli@latest update --branch production` (stored `~/.expo` auth) or hand the command to the user.

## Self-review

- **Placeholders:** none — endpoint contracts, types, gates, and the error map are concrete. The two "verify-at-impl" items below are explicit checks, not TODOs.
- **Consistency:** `ConnectionView`/`SyncHealthRow` reused from the service; endpoint gates match `ConnectionsService`'s own asserts; the mobile screen consumes exactly the GET shape.
- **Scope:** single, self-contained slice (3 endpoints + 1 screen); connect-on-mobile cleanly deferred.

## Verify at implementation

1. `withApiContext(req)`'s returned ctx satisfies `ConnectionsService`'s `ServiceContext` (the grounding confirms it's used with the cycle-counts service; confirm the `supabase`/`organizationId`/`userId`/`role`/`enabledModules`/MFA fields line up, and that `assertModuleEnabled`/`assertPermission` read them).
2. The exact `ServiceError`→HTTP mapping helper used by `/api/v1/cycle-counts` (reuse it rather than re-implement).
3. Mobile `useRole()` exposes `isAdmin` and `useEnabledModules()` exposes the enabled set as the grounding described; confirm the Settings-row gating predicate.
