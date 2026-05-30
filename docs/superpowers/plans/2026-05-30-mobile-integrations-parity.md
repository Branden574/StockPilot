# Mobile Integrations Parity (manage + monitor) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Mobile can view QuickBooks connection status + sync health, disconnect, and edit the account mapping. Connect stays web. Ships as web `/api/v1` endpoints + an Expo OTA (native-safe).

**Spec:** `docs/superpowers/specs/2026-05-30-mobile-integrations-parity-design.md`. Builds on shipped Phase 3a (`ConnectionsService`, the `integrations` module + `integrations:manage` perm, `org_connections`/`connection_sync_log`).

**Branch:** `feat/mobile-integrations-parity`. Conventions: commit per task; stage only task files (the repo has unrelated uncommitted WIP — `apps/web/src/lib/email/templates.tsx`, `apps/web/src/server/services/team.ts`, `apps/web/scripts/*.mjs` — never `git add -A`); commit trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; do NOT push (controller pushes at end). `tsc` clean before each commit.

## File structure

| File | Responsibility |
|---|---|
| `apps/web/src/app/api/v1/integrations/connections/route.ts` (new) | `GET` → list connections + health (Bearer, module-gated) |
| `apps/web/src/app/api/v1/integrations/connections/route.test.ts` (new) | GET route tests |
| `apps/web/src/app/api/v1/integrations/connections/[provider]/route.ts` (new) | `DELETE` → disconnect (perm-gated) |
| `apps/web/src/app/api/v1/integrations/connections/[provider]/account-mapping/route.ts` (new) | `POST` → save account mapping (perm-gated) |
| `apps/web/src/app/api/v1/integrations/connections/[provider]/route.test.ts` (new) | DELETE + mapping route tests |
| `apps/mobile/app/(drawer)/settings/integrations.tsx` (new) | Mobile Integrations screen |
| `apps/mobile/app/(drawer)/settings.tsx` (edit) | Gated "Integrations" row → navigate to the screen |
| `apps/mobile/src/lib/integrations-api.ts` (new, optional) | Thin typed wrappers over `api()` for the 3 calls |

---

## Task 1: Web `/api/v1/integrations/connections*` REST endpoints

**Files:** the 3 route files + 2 test files above. READ FIRST: `apps/web/src/app/api/v1/cycle-counts/route.ts` (the `withApiContext` + service + `ServiceError`→HTTP pattern to copy exactly), `apps/web/src/lib/auth/api-context.ts` (`withApiContext` shape), `apps/web/src/server/services/connections.ts` (`ConnectionsService` constructor + `list`/`disconnect`/`saveAccountMapping` + exported `ConnectionView`/`SyncHealthRow`/`AccountMapping` types + `ServiceError` codes), `@stockpilot/core` `ConnectorProviderId`.

- [ ] **Step 1: Failing tests** — `route.test.ts` (GET) + `[provider]/route.test.ts` (DELETE + mapping). Mirror the cycle-counts route test's mocking style. Cases:
  - GET: ctx present + module enabled → 200 `{ connections, health }` (assert `ConnectionsService.list` invoked); `withApiContext` returns null → 401; module disabled (service throws `ServiceError('module_disabled')`) → 403.
  - DELETE `[provider]`: happy → 200 `{ ok: true }` (assert `disconnect('quickbooks')`); missing `integrations:manage` (`ServiceError('forbidden')`) → 403; unknown provider (e.g. `/foo`) → 400.
  - POST `account-mapping`: happy → 200 (assert `saveAccountMapping('quickbooks', body)`); invalid body (missing a field) → 400; `forbidden` → 403.
- [ ] **Step 2: Run → FAIL** (`cd apps/web && npx vitest run src/app/api/v1/integrations`).
- [ ] **Step 3: Implement the GET route** (`connections/route.ts`):
```ts
import { NextResponse } from 'next/server';
import { withApiContext } from '@/lib/auth/api-context';
import { ConnectionsService } from '@/server/services/connections';
import { ServiceError } from '@/server/services/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    const data = await new ConnectionsService(ctx).list();
    return NextResponse.json(data);
  } catch (err) {
    return serviceErrorResponse(err); // shared helper — reuse cycle-counts' mapper
  }
}
```
  Use the SAME `ServiceError`→HTTP helper `/api/v1/cycle-counts` uses (find it; if it's inline there, extract a small shared `serviceErrorResponse(err)` into a lib used by both, or replicate the exact mapping: unauthenticated 401, forbidden 403, module_disabled 403, not_found 404, validation_error 400, else 500).
- [ ] **Step 4: Implement the DELETE route** (`[provider]/route.ts`): parse `params.provider`, validate it is `'quickbooks'` (else 400 `validation_error`); `withApiContext` 401-guard; `await new ConnectionsService(ctx).disconnect(provider)`; return `{ ok: true }`; same error mapper.
- [ ] **Step 5: Implement the POST mapping route** (`[provider]/account-mapping/route.ts`): validate provider; parse body `{ billExpense, inventoryAsset, valuationOffset }` (all required non-empty strings → else 400); `await new ConnectionsService(ctx).saveAccountMapping(provider, body)`; return `{ ok: true }`.
- [ ] **Step 6: Run tests → PASS; `cd apps/web && npx tsc --noEmit`.**
- [ ] **Step 7: Commit** `feat(web): /api/v1 integrations connections endpoints (list/disconnect/account-mapping)`.

---

## Task 2: Mobile Settings → Integrations screen

**Files:** `apps/mobile/app/(drawer)/settings/integrations.tsx` (new), `apps/mobile/app/(drawer)/settings.tsx` (edit), optional `apps/mobile/src/lib/integrations-api.ts`. READ FIRST: `apps/mobile/src/lib/api.ts` (the `api<T>(path, opts)` client — Bearer + `X-Organization-Id`), `apps/mobile/app/(drawer)/settings.tsx` (Section/SettingRow pattern + `router.push`), `apps/mobile/src/lib/use-role.ts` (`useRole` → `isAdmin`), `apps/mobile/src/lib/enabled-modules.ts` (`useEnabledModules`), an existing screen with data fetch + loading/error states (e.g. an admin screen) for the UI idiom, and `apps/mobile/src/components/ui/*` (Text, etc.).

- [ ] **Step 1: API wrappers** (`src/lib/integrations-api.ts`) — typed helpers over `api()`:
```ts
import { api } from './api';
export type ConnectionView = { id: string; providerId: string; status: 'pending'|'active'|'error'|'disconnected'; externalAccountId: string|null; accountIds: { billExpense?: string; inventoryAsset?: string; valuationOffset?: string }; lastSyncedAt: string|null; lastError: string|null };
export type SyncHealthRow = { topic: string; status: 'pending'|'success'|'error'|'dead'; attempts: number; externalId: string|null; lastError: string|null; completedAt: string|null; createdAt: string };
export const getConnections = () => api<{ connections: ConnectionView[]; health: SyncHealthRow[] }>('/api/v1/integrations/connections');
export const disconnect = (p: string) => api<{ ok: true }>(`/api/v1/integrations/connections/${p}`, { method: 'DELETE' });
export const saveAccountMapping = (p: string, body: { billExpense: string; inventoryAsset: string; valuationOffset: string }) =>
  api<{ ok: true }>(`/api/v1/integrations/connections/${p}/account-mapping`, { method: 'POST', body });
```
  (Match the real `api()` option names — confirm `body`/`method` keys against `src/lib/api.ts`.)
- [ ] **Step 2: The screen** (`settings/integrations.tsx`): on focus, `getConnections()` into state with loading/error. Find the `quickbooks` connection. Render:
  - QuickBooks card: status badge, realm (`externalAccountId`), `lastSyncedAt`, `lastError`.
  - If no active connection: hint "Connect QuickBooks from the web app (Settings → Integrations)." (no connect button).
  - Account-mapping form: 3 `TextInput`s prefilled from `accountIds`; **Save** → `saveAccountMapping` → toast + refetch; inline error on failure.
  - **Disconnect** button → confirm (`Alert.alert`) → `disconnect('quickbooks')` → refetch.
  - Sync-health list: recent `health` rows (topic, status icon, external id, attempts, last error).
  - **Gating guard:** `const { isAdmin } = useRole(); const enabled = useEnabledModules();` — if `!enabled.has('integrations') || !isAdmin`, render an empty state ("Integrations isn't enabled" / "Admins only"). Server still enforces; a 403 from any call → friendly inline message.
- [ ] **Step 3: Settings row** (edit `settings.tsx`): add an "Integrations" `SettingRow` (icon e.g. `Plug`/`Link`) inside a suitable Section, rendered only when `useEnabledModules().has('integrations') && useRole().isAdmin`, `onPress: () => router.push('/settings/integrations')`. Match the existing rows' style + chevron.
- [ ] **Step 4: `cd apps/mobile && npx tsc --noEmit`** (clean). If a mobile test setup exists, add a light test of the gating predicate + GET→view mapping; else rely on tsc + the manual checklist.
- [ ] **Step 5: Commit** `feat(mobile): Settings → Integrations screen (status, sync health, disconnect, account mapping)`.

---

## Final verification (DoD)
- [ ] `cd apps/web && npx tsc --noEmit` + `npx vitest run src/app/api/v1/integrations` green.
- [ ] `cd apps/mobile && npx tsc --noEmit` clean.
- [ ] Manual (post-ship): the row appears only for admins with the module on; the screen shows status/health; disconnect + save-mapping work; a non-admin / module-off sees the empty state; the not-connected hint points to web.
- [ ] Native-safety: confirm `apps/mobile/package.json` unchanged (no new dep) → OTA-safe.

## Self-review
- **Spec coverage:** GET/DELETE/POST endpoints (Task 1) ✓; mobile screen + gated row + status/health/disconnect/mapping (Task 2) ✓; connect-on-mobile correctly absent (deferred).
- **Types:** `ConnectionView`/`SyncHealthRow` mirror the web service's exports; the mobile wrappers consume exactly the GET shape; provider validated to `'quickbooks'`.
- **No placeholders:** endpoint code + error mapping + the screen's behaviors are concrete; "verify-at-impl" items are explicit checks.
