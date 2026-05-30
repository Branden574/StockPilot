# Warehouse-OS Phase 3a — Connector Framework + QuickBooks Export — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A reusable, off-by-default connector framework, proven by a QuickBooks Online push-only export (receipt → account-based Bill + monthly inventory-valuation journal entry), with StockPilot remaining the system-of-record (one-way export; no QBO Item sync; no QBO→StockPilot writes).

**Architecture:** New per-org tables (`org_connections`, `connection_mappings`, `connection_sync_log`) + Supabase-Vault token storage via service-role-only RPCs; a `Connector` interface + registry in `packages/core`; a Vercel-cron **outbox drainer** that dispatches unpublished `outbox_events` to enabled connectors and tracks per-`(connection,event)` delivery in `connection_sync_log` (NOT `outbox_events.published_at`, preserving fan-out); a QuickBooks connector (OAuth2 via `intuit-oauth` + raw `fetch` for entity creates). Gated by a new `integrations` entitlement module, grandfathered OFF.

**Tech Stack:** TypeScript, pnpm/turbo, Next.js 16 App Router, Supabase (Postgres + RLS + Vault), Vitest, `intuit-oauth`.

**Spec:** `docs/superpowers/specs/2026-05-30-warehouse-os-phase3a-connector-framework-quickbooks-design.md`. Builds on shipped Phase 1 (MODULE_REGISTRY + entitlements) and Phase 2 (control plane).

**Conventions (verified):**
- Migrations: latest is `0145`; this plan adds `0146` + `0147`.
- Per-org RLS: `select using ((select public.is_org_member(organization_id)))`, write `using ((select public.has_org_role(organization_id,'admin')))`; explicit `grant ... to authenticated`.
- Cron routes: `runtime='nodejs'`, `dynamic='force-dynamic'`, `maxDuration=60`; `secretsEqual(auth, \`Bearer ${env.CRON_SECRET}\`)` (fail-closed 401 if `!env.CRON_SECRET`); `createAdminClient()` (service-role, bypasses RLS). Register in `apps/web/vercel.json`.
- `receipt.posted` outbox payload = `{purchaseOrderId, warehouseId, receiptNumber, lineCount, totalAccepted, totalRejected}` (NO lines) — the connector fetches `receipts`/`receipt_lines`/PO `supplier` by `aggregate_id` (receipt id) at drain time.
- Server services use `Service.forCurrentUser()` + `ServiceContext` (`assertPermission`, `assertModuleEnabled`, `audit`). Connector *execution* runs only in the service-role worker, never under a user ctx.
- Commit per task with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Stage only each task's files (unrelated web WIP is uncommitted — never stage it). Do NOT push (controller pushes at the end).
- The implementer/controller runs on branch `feat/warehouse-os-phase3a` — `git checkout feat/warehouse-os-phase3a` first; re-confirm before each commit (the branch has flipped to main between agents before).

**Verify-at-implementation (flagged, not placeholders):**
1. Supabase Vault availability: run `select 1 from pg_available_extensions where name='supabase_vault';` against the linked DB. If installed → use Vault (Task 1b). If not → use the AES fallback variant documented in Task 1b. Pick one before writing `0146`.
2. Exact `vault.*` API (`vault.create_secret(secret text, name text, description text)` returns uuid; `vault.update_secret(uuid, secret)`; read via `select decrypted_secret from vault.decrypted_secrets where id=`) — confirm signatures against the installed version when writing the RPCs.
3. `intuit-oauth` package: `cd apps/web && pnpm add intuit-oauth` (confirm it installs; it's pure-JS, OTA/edge-safe concerns N/A — server-only).

---

## File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/0146_connector_framework.sql` (new) | 3 tables + RLS + grants + Vault secret RPCs. |
| `supabase/migrations/0147_integrations_module_grandfather.sql` (new) | Seed `organization_modules(integrations, enabled=false)` for existing orgs. |
| `packages/core/src/connectors/types.ts` (new) | `Connector`, `OutboxEvent`, `ConnectionRef`, `ConnectorSecrets`, `PushResult`, `ConnectorDeps`, `ConnectorProviderId`, `ConnectorMode`. |
| `packages/core/src/connectors/registry.ts` (new) | `CONNECTOR_REGISTRY` (metadata: id, title, modes, subscribedTopics, requiresModule, oauth shape). |
| `packages/core/src/connectors/{types,registry}.test.ts` (new) | Registry integrity. |
| `packages/core/src/index.ts` (edit) | Export connectors. |
| `packages/core/src/modules/registry.ts` (edit) | Add `integrations` ModuleId + def. |
| `packages/core/src/constants/permissions.ts` (edit) | Add `integrations:manage` to PERMISSIONS + owner/admin. |
| `apps/web/src/lib/env.ts` (edit) | `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_ENV`. |
| `apps/web/src/server/connectors/secret-store.ts` (new) | `putConnectionSecret`/`getConnectionSecret` (Vault RPC wrappers, admin client). |
| `apps/web/src/server/connectors/drainer.ts` (new) | Pure dispatch/eligibility/backoff logic (testable). |
| `apps/web/src/app/api/cron/drain-outbox/route.ts` (new) | Cron entry: auth + load eligible work + run drainer. |
| `apps/web/src/server/connectors/index.ts` (new) | Maps `ConnectorProviderId` → concrete impl (the impl registry). |
| `apps/web/src/server/connectors/quickbooks/{client,oauth,bill,valuation,index}.ts` (new) | QBO client (fetch wrapper), OAuth, Bill builder, valuation JE builder, the `Connector` impl. |
| `apps/web/src/server/services/connections.ts` (new) | `ConnectionsService` (beginConnect/disconnect/status). |
| `apps/web/src/server/actions/connections.ts` (new) | server actions wrapping ConnectionsService. |
| `apps/web/src/app/api/integrations/quickbooks/callback/route.ts` (new) | OAuth callback. |
| `apps/web/src/app/(dashboard)/dashboard/settings/integrations/page.tsx` (new) | Integrations settings page. |
| `apps/web/src/components/settings/integrations-panel.tsx` (new) | Client: connect/disconnect + sync health. |
| `apps/web/src/app/(dashboard)/dashboard/settings/page.tsx` (edit) | Integrations tile (gated `integrations:manage`). |
| `apps/web/vercel.json` (edit) | `drain-outbox` cron. |

---

## Task 1: Migration `0146` — framework tables + Vault secret RPCs

**Files:** Create `supabase/migrations/0146_connector_framework.sql`.

- [ ] **Step 1: Verify Vault.** Run `printf '' | supabase db execute "select exists(select 1 from pg_available_extensions where name='supabase_vault' and installed_version is not null) as vault" 2>/dev/null` (or `supabase db push --dry-run` then a query). If Vault is present, use the Vault RPCs below; if absent, use the AES-fallback note at the end of this task. Record which in the migration header comment.

- [ ] **Step 2: Write the migration** (`0146_connector_framework.sql`):

```sql
-- 0146_connector_framework.sql — multi-connector integration framework.
-- Vault-backed per-org connection secrets (verified available: <yes/no>).

create extension if not exists supabase_vault with schema vault;

-- 1. org_connections — one row per (org, provider).
create table if not exists public.org_connections (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  provider_id         text not null,
  status              text not null default 'pending'
                        check (status in ('pending','active','error','disconnected')),
  external_account_id text,
  secret_id           uuid,                       -- Vault secret handle; NEVER the token
  settings            jsonb not null default '{}'::jsonb,
  oauth_state         text,
  last_connected_at   timestamptz,
  last_synced_at      timestamptz,
  last_error          text,
  created_by          uuid references public.user_profiles(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (organization_id, provider_id)
);
create index if not exists org_connections_active_idx
  on public.org_connections (organization_id) where status = 'active';

-- 2. connection_mappings — local<->external id correspondence.
create table if not exists public.connection_mappings (
  id              uuid primary key default gen_random_uuid(),
  connection_id   uuid not null references public.org_connections(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  entity_type     text not null,
  local_id        uuid,
  external_id     text not null,
  external_meta   jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (connection_id, entity_type, local_id),
  unique (connection_id, entity_type, external_id)
);
create index if not exists connection_mappings_lookup_idx
  on public.connection_mappings (connection_id, entity_type);

-- 3. connection_sync_log — per-(connection,event) delivery ledger.
create table if not exists public.connection_sync_log (
  id              uuid primary key default gen_random_uuid(),
  connection_id   uuid not null references public.org_connections(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  outbox_event_id uuid not null references public.outbox_events(id) on delete cascade,
  topic           text not null,
  status          text not null default 'pending'
                    check (status in ('pending','success','error','dead')),
  attempts        int not null default 0,
  external_id     text,
  last_error      text,
  next_attempt_at timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (connection_id, outbox_event_id)
);
create index if not exists connection_sync_log_due_idx
  on public.connection_sync_log (status, next_attempt_at) where status in ('pending','error');

alter table public.org_connections     enable row level security;
alter table public.connection_mappings enable row level security;
alter table public.connection_sync_log enable row level security;

-- org_connections: member read (NO token exposed — secret_id is a UUID), admin write.
create policy org_connections_select on public.org_connections
  for select to authenticated using ((select public.is_org_member(organization_id)));
create policy org_connections_write on public.org_connections
  for all to authenticated
  using ((select public.has_org_role(organization_id,'admin')))
  with check ((select public.has_org_role(organization_id,'admin')));

create policy connection_mappings_select on public.connection_mappings
  for select to authenticated using ((select public.is_org_member(organization_id)));
create policy connection_mappings_write on public.connection_mappings
  for all to authenticated
  using ((select public.has_org_role(organization_id,'manager')))
  with check ((select public.has_org_role(organization_id,'manager')));

-- sync_log: member read (settings UI health); writes by service-role worker only (no auth'd write policy).
create policy connection_sync_log_select on public.connection_sync_log
  for select to authenticated using ((select public.is_org_member(organization_id)));

grant select, insert, update, delete on public.org_connections     to authenticated;
grant select, insert, update, delete on public.connection_mappings to authenticated;
grant select on public.connection_sync_log to authenticated;

-- Vault secret RPCs — service_role ONLY (revoke from authenticated/anon).
create or replace function public.connector_secret_put(p_secret jsonb, p_name text)
returns uuid language plpgsql security definer set search_path = public, vault as $$
declare v_id uuid;
begin
  select id into v_id from vault.secrets where name = p_name;
  if v_id is null then
    select vault.create_secret(p_secret::text, p_name, 'connector secret') into v_id;
  else
    perform vault.update_secret(v_id, p_secret::text);
  end if;
  return v_id;
end; $$;

create or replace function public.connector_secret_get(p_secret_id uuid)
returns jsonb language sql security definer set search_path = public, vault as $$
  select decrypted_secret::jsonb from vault.decrypted_secrets where id = p_secret_id;
$$;

create or replace function public.connector_secret_delete(p_secret_id uuid)
returns void language sql security definer set search_path = public, vault as $$
  delete from vault.secrets where id = p_secret_id;
$$;

revoke all on function public.connector_secret_put(jsonb, text)   from authenticated, anon;
revoke all on function public.connector_secret_get(uuid)          from authenticated, anon;
revoke all on function public.connector_secret_delete(uuid)       from authenticated, anon;
grant execute on function public.connector_secret_put(jsonb, text)   to service_role;
grant execute on function public.connector_secret_get(uuid)          to service_role;
grant execute on function public.connector_secret_delete(uuid)       to service_role;
```

> **AES fallback (only if Vault absent):** drop the `vault` extension line + the three RPCs; instead add `secret_ciphertext text` to `org_connections` (instead of `secret_id`), and implement `apps/web/src/server/connectors/crypto.ts` (Node `crypto` AES-256-GCM with a `CONNECTOR_SECRETS_KEY` env). Adjust Task 4 accordingly. Confirm the choice before writing.

- [ ] **Step 3: Verify SQL** — `supabase db reset` locally (or `db push --dry-run` then a careful apply on a copy). Expected: no errors; the three tables + three functions exist. Confirm `connector_secret_get` is NOT executable by `authenticated` (`select has_function_privilege('authenticated','public.connector_secret_get(uuid)','execute')` → false).

- [ ] **Step 4: Commit.**
```bash
git add supabase/migrations/0146_connector_framework.sql
git commit -m "feat(db): connector framework tables + Vault secret RPCs (0146)"
```

---

## Task 2: Connector interface + registry (`packages/core`)

**Files:** Create `packages/core/src/connectors/types.ts`, `registry.ts`, `registry.test.ts`; edit `packages/core/src/index.ts`.

- [ ] **Step 1: Write the failing test** (`registry.test.ts`):
```ts
import { describe, expect, it } from 'vitest';
import { CONNECTOR_REGISTRY, type ConnectorProviderId } from './registry';

describe('CONNECTOR_REGISTRY', () => {
  it('every entry id matches its key and declares ≥1 mode + ≥1 subscribed topic or pull', () => {
    for (const [key, def] of Object.entries(CONNECTOR_REGISTRY)) {
      expect(def.id).toBe(key);
      expect(def.modes.length).toBeGreaterThan(0);
      expect(def.requiresModule).toBe('integrations');
    }
  });
  it('quickbooks is push + subscribes to receipt.posted', () => {
    const qbo = CONNECTOR_REGISTRY['quickbooks' as ConnectorProviderId];
    expect(qbo.modes).toContain('push');
    expect(qbo.subscribedTopics).toContain('receipt.posted');
  });
});
```

- [ ] **Step 2: Run → FAIL.** `cd packages/core && npx vitest run src/connectors/registry.test.ts`

- [ ] **Step 3: Implement `types.ts`:**
```ts
import type { ModuleId } from '../modules/registry';

export type ConnectorMode = 'push' | 'pull' | 'bidi' | 'webhook';
export type ConnectorProviderId = 'quickbooks'; // grows: 'carrier' | 'amazon' | ...

export interface OutboxEvent {
  id: string; organizationId: string; topic: string;
  aggregateType: string; aggregateId: string | null;
  payload: Record<string, unknown>; dedupeKey: string | null; createdAt: string;
}
export interface ConnectionRef {
  id: string; organizationId: string; providerId: ConnectorProviderId;
  status: 'pending' | 'active' | 'error' | 'disconnected';
  externalAccountId: string | null;
  settings: Record<string, unknown>;
}
export interface ConnectorSecrets { accessToken: string; refreshToken: string; expiresAt: string; [k: string]: unknown; }
export interface PushResult { ok: boolean; externalId?: string; retryable?: boolean; error?: string; }

/** Injected seam to the service layer so connectors stay unit-testable. */
export interface ConnectorDeps {
  admin: unknown;                          // SupabaseClient (service-role) — typed `any`-stub in core
  fetch: typeof fetch;
  getMapping(connectionId: string, entityType: string, localId: string | null): Promise<{ externalId: string; externalMeta: Record<string, unknown> } | null>;
  putMapping(connectionId: string, organizationId: string, entityType: string, localId: string | null, externalId: string, externalMeta?: Record<string, unknown>): Promise<void>;
}

export interface Connector {
  readonly id: ConnectorProviderId;
  readonly modes: ConnectorMode[];
  readonly subscribedTopics: string[];
  handleOutboxEvent(event: OutboxEvent, conn: ConnectionRef, secrets: ConnectorSecrets, deps: ConnectorDeps): Promise<PushResult>;
  refreshAuth?(conn: ConnectionRef, secrets: ConnectorSecrets): Promise<ConnectorSecrets>;
  // YAGNI seams — unimplemented for QBO:
  scheduledPull?(conn: ConnectionRef, secrets: ConnectorSecrets, deps: ConnectorDeps): Promise<void>;
  verifyWebhook?(req: Request, conn: ConnectionRef, secrets: ConnectorSecrets): Promise<boolean>;
  handleWebhook?(req: Request, conn: ConnectionRef, secrets: ConnectorSecrets, deps: ConnectorDeps): Promise<void>;
}

export interface ConnectorMeta {
  id: ConnectorProviderId;
  title: string;
  modes: ConnectorMode[];
  subscribedTopics: string[];
  requiresModule: ModuleId;        // 'integrations'
  oauth: { authorizeBase: string; scopes: string[] };
}
```

- [ ] **Step 4: Implement `registry.ts`:**
```ts
import type { ConnectorMeta, ConnectorProviderId } from './types';
export type { ConnectorProviderId } from './types';

export const CONNECTOR_REGISTRY: Record<ConnectorProviderId, ConnectorMeta> = {
  quickbooks: {
    id: 'quickbooks',
    title: 'QuickBooks Online',
    modes: ['push'],
    subscribedTopics: ['receipt.posted'],
    requiresModule: 'integrations',
    oauth: {
      authorizeBase: 'https://appcenter.intuit.com/connect/oauth2',
      scopes: ['com.intuit.quickbooks.accounting'],
    },
  },
};
```

- [ ] **Step 5: Run → PASS;** `cd packages/core && npx tsc --noEmit`.
- [ ] **Step 6: Export + commit.** Add `export * from './connectors/types';` and `export * from './connectors/registry';` to `packages/core/src/index.ts`.
```bash
git add packages/core/src/connectors packages/core/src/index.ts
git commit -m "feat(core): connector interface + registry"
```

---

## Task 3: `integrations` entitlement module + permission + grandfather

**Files:** Edit `packages/core/src/modules/registry.ts`, `packages/core/src/constants/permissions.ts`; create `supabase/migrations/0147_integrations_module_grandfather.sql`. Tests: extend `packages/core/src/modules/registry.test.ts`.

- [ ] **Step 1: Add the permission.** In `permissions.ts`, add `'integrations:manage'` to the `PERMISSIONS` array (so `Permission` includes it). Verify owner/admin get it: `owner: ALL_PERMISSIONS`, `admin: ALL_PERMISSIONS.filter(p => p !== 'billing:manage')` already include all — so `integrations:manage` is auto-granted to owner+admin and NOT to manager/staff/viewer. Add a `/dashboard/settings/roles` reference entry for it (matching the existing `organization:update` entry shape).

- [ ] **Step 2: Add the module.** In `registry.ts`, add `'integrations'` to the `ModuleId` union and a `MODULE_REGISTRY.integrations` entry:
```ts
integrations: {
  id: 'integrations', tier: 'optional', title: 'Integrations',
  dependsOn: [], permissions: ['integrations:manage'],
  surfaces: ['api'], apiPrefixes: ['/api/integrations', '/api/cron/drain-outbox'],
  ownsTables: ['org_connections', 'connection_mappings', 'connection_sync_log'],
  defaultOnFor: [],   // net-new — OFF for every pack incl. charter; explicit opt-in only
  placements: [],     // surfaced via the Integrations settings page, not the main nav
},
```

- [ ] **Step 3: Update the registry test.** The Phase-1 `registry.test.ts` "DEFAULT_MODULE_IDS = charter pack" test: `integrations` has `defaultOnFor: []` and tier `optional`, so it is NOT in `DEFAULT_MODULE_IDS` — confirm the existing test still passes (it asserts core ⊆ DEFAULT and DEFAULT == modulesForPack('charter_school'); `integrations` is excluded correctly). Add an explicit assertion: `expect(DEFAULT_MODULE_IDS).not.toContain('integrations')`. Run `cd packages/core && npx vitest run src/modules` + `npx tsc --noEmit`.

- [ ] **Step 4: Grandfather migration** `0147_integrations_module_grandfather.sql`:
```sql
-- New optional module 'integrations' defaults OFF for all existing orgs.
insert into public.organization_modules (organization_id, module_id, enabled, tier, enabled_at)
select o.id, 'integrations', false, 'optional', now()
from public.organizations o
on conflict (organization_id, module_id) do nothing;
```
Apply + verify L4L has an `integrations` row with `enabled=false`.

- [ ] **Step 5: Commit.**
```bash
git add packages/core/src/modules/registry.ts packages/core/src/modules/registry.test.ts packages/core/src/constants/permissions.ts supabase/migrations/0147_integrations_module_grandfather.sql
git commit -m "feat(core,db): integrations module (grandfathered off) + integrations:manage perm"
```

---

## Task 4: Vault secret store (server)

**Files:** Create `apps/web/src/server/connectors/secret-store.ts`, `secret-store.test.ts`.

- [ ] **Step 1: Failing test** — mock a supabase admin client whose `.rpc('connector_secret_get', {p_secret_id})` resolves `{ data: {accessToken:'a',refreshToken:'r',expiresAt:'2026-01-01'}, error:null }`; assert `getConnectionSecret(admin, id)` returns the typed `ConnectorSecrets`; `putConnectionSecret(admin, name, secret)` calls `rpc('connector_secret_put', {p_secret, p_name})` and returns the uuid; both throw on `error`.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `secret-store.ts`:
```ts
import 'server-only';
import type { ConnectorSecrets } from '@stockpilot/core';

type Admin = { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> };

export async function putConnectionSecret(admin: Admin, name: string, secret: ConnectorSecrets): Promise<string> {
  const { data, error } = await admin.rpc('connector_secret_put', { p_secret: secret, p_name: name });
  if (error) throw new Error(`connector_secret_put: ${error.message}`);
  return data as string;
}
export async function getConnectionSecret(admin: Admin, secretId: string): Promise<ConnectorSecrets> {
  const { data, error } = await admin.rpc('connector_secret_get', { p_secret_id: secretId });
  if (error) throw new Error(`connector_secret_get: ${error.message}`);
  if (!data) throw new Error('connector secret not found');
  return data as ConnectorSecrets;
}
export async function deleteConnectionSecret(admin: Admin, secretId: string): Promise<void> {
  const { error } = await admin.rpc('connector_secret_delete', { p_secret_id: secretId });
  if (error) throw new Error(`connector_secret_delete: ${error.message}`);
}
```
(AES-fallback variant: encrypt/decrypt locally instead of RPC — implement only if Task 1 chose fallback.)

- [ ] **Step 4: Run → PASS;** `cd apps/web && npx tsc --noEmit`.
- [ ] **Step 5: Commit** `git add apps/web/src/server/connectors/secret-store.ts apps/web/src/server/connectors/secret-store.test.ts && git commit -m "feat(web): connector Vault secret store"`.

---

## Task 5: Outbox drainer (pure logic + cron route) with a no-op connector

**Files:** Create `apps/web/src/server/connectors/drainer.ts`, `drainer.test.ts`, `apps/web/src/server/connectors/index.ts`, `apps/web/src/app/api/cron/drain-outbox/route.ts`; edit `apps/web/vercel.json`.

- [ ] **Step 1: Failing test** for the pure backoff/eligibility helper (`drainer.test.ts`):
```ts
import { describe, expect, it } from 'vitest';
import { nextBackoff, MAX_ATTEMPTS } from './drainer';
describe('nextBackoff', () => {
  it('is exponential and capped, jittered within bounds', () => {
    const b1 = nextBackoff(1), b8 = nextBackoff(8);
    expect(b1).toBeGreaterThan(0);
    expect(b8).toBeLessThanOrEqual(60 * 60 * 1000); // cap 1h
    expect(nextBackoff(2)).toBeGreaterThanOrEqual(nextBackoff(1) * 0.5);
  });
  it('MAX_ATTEMPTS is a small finite number', () => { expect(MAX_ATTEMPTS).toBeGreaterThan(3); expect(MAX_ATTEMPTS).toBeLessThanOrEqual(12); });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `drainer.ts`** — the pure helpers + the `runDrain(admin, connectors)` orchestrator:
```ts
import 'server-only';
import type { Connector, ConnectorProviderId, OutboxEvent, ConnectionRef } from '@stockpilot/core';
import { getConnectionSecret, putConnectionSecret } from './secret-store';

export const MAX_ATTEMPTS = 8;
export function nextBackoff(attempt: number): number {
  const base = Math.min(60 * 60 * 1000, 2 ** attempt * 1000); // cap 1h
  const jitter = base * 0.25 * ((attempt * 2654435761) % 1000 / 1000); // deterministic-ish jitter (no Math.random)
  return Math.round(base - base * 0.125 + jitter);
}

export interface DrainResult { processed: number; succeeded: number; failed: number; deadlettered: number; }

export async function runDrain(
  admin: { from: (t: string) => any; rpc: Function },
  connectors: Record<ConnectorProviderId, Connector>,
  now: Date,
): Promise<DrainResult> {
  const res: DrainResult = { processed: 0, succeeded: 0, failed: 0, deadlettered: 0 };
  // 1. active connections
  const { data: conns } = await admin.from('org_connections').select('*').eq('status', 'active');
  for (const c of (conns ?? []) as any[]) {
    const connector = connectors[c.provider_id as ConnectorProviderId];
    if (!connector) continue;
    const conn: ConnectionRef = { id: c.id, organizationId: c.organization_id, providerId: c.provider_id, status: c.status, externalAccountId: c.external_account_id, settings: c.settings ?? {} };
    // 2. candidate outbox events for this org with subscribed topics, not yet succeeded.
    const { data: events } = await admin.from('outbox_events')
      .select('*').eq('organization_id', c.organization_id).in('topic', connector.subscribedTopics)
      .order('created_at', { ascending: true }).limit(200);
    for (const e of (events ?? []) as any[]) {
      // skip if a success/dead log row exists, or an error row not yet due
      const { data: existing } = await admin.from('connection_sync_log')
        .select('*').eq('connection_id', conn.id).eq('outbox_event_id', e.id).maybeSingle();
      if (existing && (existing.status === 'success' || existing.status === 'dead')) continue;
      if (existing && existing.status === 'error' && existing.next_attempt_at && new Date(existing.next_attempt_at) > now) continue;
      const attempts = (existing?.attempts ?? 0) + 1;
      res.processed++;
      // upsert pending row
      await admin.from('connection_sync_log').upsert({
        connection_id: conn.id, organization_id: conn.organizationId, outbox_event_id: e.id,
        topic: e.topic, status: 'pending', attempts, updated_at: now.toISOString(),
      }, { onConflict: 'connection_id,outbox_event_id' });
      try {
        const event: OutboxEvent = { id: e.id, organizationId: e.organization_id, topic: e.topic, aggregateType: e.aggregate_type, aggregateId: e.aggregate_id, payload: e.payload ?? {}, dedupeKey: e.dedupe_key, createdAt: e.created_at };
        let secrets = await getConnectionSecret(admin as any, c.secret_id);
        if (connector.refreshAuth && new Date(secrets.expiresAt).getTime() < now.getTime() + 5 * 60 * 1000) {
          secrets = await connector.refreshAuth(conn, secrets);
          await putConnectionSecret(admin as any, `connector:${conn.id}`, secrets);
        }
        const out = await connector.handleOutboxEvent(event, conn, secrets, makeDeps(admin));
        if (out.ok) {
          await admin.from('connection_sync_log').update({ status: 'success', external_id: out.externalId ?? null, completed_at: now.toISOString(), updated_at: now.toISOString() }).eq('connection_id', conn.id).eq('outbox_event_id', e.id);
          await admin.from('org_connections').update({ last_synced_at: now.toISOString(), last_error: null }).eq('id', conn.id);
          res.succeeded++;
        } else {
          const dead = attempts >= MAX_ATTEMPTS;
          await admin.from('connection_sync_log').update({ status: dead ? 'dead' : 'error', last_error: out.error ?? 'unknown', next_attempt_at: new Date(now.getTime() + nextBackoff(attempts)).toISOString(), updated_at: now.toISOString() }).eq('connection_id', conn.id).eq('outbox_event_id', e.id);
          dead ? res.deadlettered++ : res.failed++;
        }
      } catch (err) {
        const dead = attempts >= MAX_ATTEMPTS;
        await admin.from('connection_sync_log').update({ status: dead ? 'dead' : 'error', last_error: err instanceof Error ? err.message : 'error', next_attempt_at: new Date(now.getTime() + nextBackoff(attempts)).toISOString(), updated_at: now.toISOString() }).eq('connection_id', conn.id).eq('outbox_event_id', e.id);
        dead ? res.deadlettered++ : res.failed++;
      }
    }
  }
  return res;
}

function makeDeps(admin: any) {
  return {
    admin, fetch,
    async getMapping(connectionId: string, entityType: string, localId: string | null) {
      let q = admin.from('connection_mappings').select('external_id, external_meta').eq('connection_id', connectionId).eq('entity_type', entityType);
      q = localId === null ? q.is('local_id', null) : q.eq('local_id', localId);
      const { data } = await q.maybeSingle();
      return data ? { externalId: data.external_id, externalMeta: data.external_meta ?? {} } : null;
    },
    async putMapping(connectionId: string, organizationId: string, entityType: string, localId: string | null, externalId: string, externalMeta: Record<string, unknown> = {}) {
      await admin.from('connection_mappings').upsert({ connection_id: connectionId, organization_id: organizationId, entity_type: entityType, local_id: localId, external_id: externalId, external_meta: externalMeta, updated_at: new Date().toISOString() }, { onConflict: 'connection_id,entity_type,local_id' });
    },
  };
}
```
> Note `Date.now()`/`new Date()` are fine in app code (only the Workflow runtime forbids them). The `now` param keeps `runDrain` testable.

- [ ] **Step 4: `index.ts`** — the impl registry (echo/no-op until Task 9 wires QBO):
```ts
import type { Connector, ConnectorProviderId } from '@stockpilot/core';
export const CONNECTORS: Partial<Record<ConnectorProviderId, Connector>> = {};
```

- [ ] **Step 5: Cron route** `drain-outbox/route.ts` — copy `weekly-digest` auth EXACTLY, then `runDrain(createAdminClient(), CONNECTORS as any, new Date())`, return `NextResponse.json(result)`; wrap in try/catch + `reportError`.

- [ ] **Step 6: `vercel.json`** — add `{ "path": "/api/cron/drain-outbox", "schedule": "*/5 * * * *" }` to the `crons` array.

- [ ] **Step 7: Run drainer test → PASS;** `cd apps/web && npx tsc --noEmit`.
- [ ] **Step 8: Commit** the 4 files + vercel.json: `git commit -m "feat(web): outbox drainer cron + dispatch loop"`.

---

## Task 6: env additions

**Files:** Edit `apps/web/src/lib/env.ts`.

- [ ] **Step 1:** Add to the server schema (mirror the existing `optionalSecret`/string pattern): `QBO_CLIENT_ID` (optionalSecret), `QBO_CLIENT_SECRET` (optionalSecret), `QBO_ENV` (`z.enum(['sandbox','production']).default('sandbox')`). (If Task 1 chose AES fallback, also `CONNECTOR_SECRETS_KEY` optionalSecret.)
- [ ] **Step 2:** `cd apps/web && npx tsc --noEmit`.
- [ ] **Step 3:** Commit `git add apps/web/src/lib/env.ts && git commit -m "feat(web): QBO env vars"`.

---

## Task 7: ConnectionsService + Integrations settings page + tile + actions

**Files:** Create `apps/web/src/server/services/connections.ts`, `apps/web/src/server/actions/connections.ts`, `apps/web/src/app/(dashboard)/dashboard/settings/integrations/page.tsx`, `apps/web/src/components/settings/integrations-panel.tsx`; edit `apps/web/src/app/(dashboard)/dashboard/settings/page.tsx`. READ an existing service (e.g. `suppliers.ts`) + the Phase-2 `module-toggles.tsx`/`settings/page.tsx` for patterns first.

- [ ] **Step 1:** `ConnectionsService extends`-style class (mirror existing services): `forCurrentUser()` → ctx; methods: `list()` (org_connections + recent sync_log health), `beginConnect(provider)` (assertModuleEnabled(ctx,'integrations') + assertPermission(ctx,'integrations:manage'); upsert a `pending` org_connections row with a generated `oauth_state`; return the QBO authorize URL built from `CONNECTOR_REGISTRY.quickbooks.oauth` + `QBO_CLIENT_ID` + the callback redirect_uri + `state`), `disconnect(provider)` (assertCurrentAal2 + permission; delete Vault secret via admin `connector_secret_delete`; set status='disconnected', null secret_id; `audit({event:'integration.disconnected'})`). Add `integration.connected`/`integration.disconnected` to the `AuditEvent` union.

- [ ] **Step 2:** Server actions `connections.ts` wrapping the service (`beginConnectAction`, `disconnectAction`) returning `ActionResult` (mirror `module-settings.ts`).

- [ ] **Step 3:** Settings page (server) — gate `if (!hasPermission(ctx.role,'integrations:manage')) redirect('/dashboard')`; load `ConnectionsService.list()`; render `<IntegrationsPanel/>`. Client panel: a QuickBooks card with Connect (→ `beginConnectAction` → `window.location = authorizeUrl`) / Disconnect + status + last-sync + recent sync-log health. Add the **Integrations tile** to `settings/page.tsx` gated `hasPermission(ctx.role,'integrations:manage')`.

- [ ] **Step 4:** Tests — `connections.test.ts` (beginConnect requires module+permission → forbidden/module_disabled when off; disconnect deletes secret + audits); page redirect test. `cd apps/web && npx tsc --noEmit && npx vitest run src/server/services/connections.test.ts`.

- [ ] **Step 5:** Commit the service + actions + page + panel + settings tile + audit edit.

---

## Task 8: QuickBooks OAuth (connect URL build + callback + token store/refresh)

**Files:** Create `apps/web/src/server/connectors/quickbooks/oauth.ts`, `apps/web/src/server/connectors/quickbooks/client.ts`, `apps/web/src/app/api/integrations/quickbooks/callback/route.ts`. Add `intuit-oauth` dep.

- [ ] **Step 1:** `pnpm --filter @stockpilot/web add intuit-oauth` (or `cd apps/web && pnpm add intuit-oauth`). Confirm it installs.
- [ ] **Step 2:** `oauth.ts` — `buildAuthorizeUrl(state)` (uses `intuit-oauth` `authorizeUri` or constructs from `CONNECTOR_REGISTRY.quickbooks.oauth` + `QBO_CLIENT_ID` + redirect_uri + scopes + state); `exchangeCode(code, realmId)` (POST token endpoint, Basic auth client_id:client_secret, grant_type=authorization_code → `{access_token, refresh_token, expires_in, x_refresh_token_expires_in}`); `refreshTokens(refreshToken)` (grant_type=refresh_token → new tokens; **return the NEW refresh_token**). All via `intuit-oauth` where possible; explicit about persisting the rotated refresh token.
- [ ] **Step 3:** `client.ts` — `QboClient(realmId, secrets, env)` wrapping `fetch`: base URL per `env` (sandbox/prod), injects `Authorization: Bearer`, `?minorversion=75`, `Accept/Content-Type: application/json`; `post(path, body, requestId)`; `query(selectStmt)`; on 401 → caller refreshes (the drainer handles refresh before calling). Log `intuit_tid` header on errors.
- [ ] **Step 4:** Callback route — verify `state` against the `pending` org_connections row (under the user session); `exchangeCode`; capture `realmId`; `putConnectionSecret(admin, \`connector:${connectionId}\`, {accessToken, refreshToken, expiresAt})`; set `status='active'`, `external_account_id=realmId`, `secret_id`, clear `oauth_state`, `last_connected_at`; `audit('integration.connected')`; 302 to `/dashboard/settings/integrations?connected=quickbooks`.
- [ ] **Step 5:** Tests — `oauth.test.ts` (token-response parsing keeps the rotated refresh_token; expiresAt computed from expires_in); `client.test.ts` (URL/minorversion/requestid/headers assembled correctly via a fetch spy). `npx tsc --noEmit`.
- [ ] **Step 6:** Commit.

---

## Task 9: receipt → account-based Bill (+ Vendor mapping) + register the QBO connector

**Files:** Create `apps/web/src/server/connectors/quickbooks/bill.ts`, `apps/web/src/server/connectors/quickbooks/index.ts`; edit `apps/web/src/server/connectors/index.ts` (register).

- [ ] **Step 1: Failing tests** (`bill.test.ts`): `buildBillFromReceipt({ vendorId, billExpenseAccountId, lines:[{qtyAccepted:5, unitCost:2}], requestId })` →
```ts
{ VendorRef:{value:'<vendorId>'}, Line:[{ DetailType:'AccountBasedExpenseLineDetail', Amount:10, AccountBasedExpenseLineDetail:{ AccountRef:{value:'<acct>'} } }] }
```
(Amount = Σ qty×cost, 2-dp). And a `resolveVendor` test (query-then-create via a fake QboClient + deps.putMapping).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `bill.ts`** — `buildBillFromReceipt(args)` (pure, returns the Bill body; one AccountBasedExpenseLineDetail line with `Amount = round2(Σ qtyAccepted*unitCost)`; optionally one line per receipt line — keep one aggregate line for v1 simplicity, documented); `resolveVendor(client, deps, conn, supplier)` (deps.getMapping('supplier', supplierId) → else `client.query("select * from Vendor where DisplayName = '<escaped name>'")` → else create → `deps.putMapping`).

- [ ] **Step 4: Implement the connector** `quickbooks/index.ts`:
```ts
import type { Connector, OutboxEvent, ConnectionRef, ConnectorSecrets, ConnectorDeps, PushResult } from '@stockpilot/core';
import { QboClient } from './client';
import { refreshTokens } from './oauth';
import { buildBillFromReceipt, resolveVendor } from './bill';

export const quickbooksConnector: Connector = {
  id: 'quickbooks', modes: ['push'], subscribedTopics: ['receipt.posted'],
  async refreshAuth(conn, secrets) {
    const t = await refreshTokens(secrets.refreshToken);
    return { ...secrets, accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: new Date(Date.now() + t.expires_in * 1000).toISOString() };
  },
  async handleOutboxEvent(event, conn, secrets, deps): Promise<PushResult> {
    if (event.topic !== 'receipt.posted' || !event.aggregateId) return { ok: true }; // not ours / nothing to do
    const admin = deps.admin as any;
    // fetch receipt + lines + supplier (payload has no lines)
    const { data: receipt } = await admin.from('receipts').select('id, purchase_order_id, receipt_number').eq('id', event.aggregateId).maybeSingle();
    if (!receipt) return { ok: true };
    const { data: lines } = await admin.from('receipt_lines').select('qty_accepted_base, unit_cost').eq('receipt_id', receipt.id);
    const { data: po } = await admin.from('purchase_orders').select('supplier_id').eq('id', receipt.purchase_order_id).maybeSingle();
    const { data: supplier } = po?.supplier_id ? await admin.from('suppliers').select('id, name').eq('id', po.supplier_id).maybeSingle() : { data: null };
    const env = (conn.settings as any).env ?? 'sandbox';
    const client = new QboClient(conn.externalAccountId!, secrets, env);
    try {
      const vendorId = supplier ? await resolveVendor(client, deps, conn, supplier) : (conn.settings as any).accountIds?.defaultVendorId;
      const body = buildBillFromReceipt({
        vendorId,
        billExpenseAccountId: (conn.settings as any).accountIds.billExpense,
        lines: (lines ?? []).map((l: any) => ({ qtyAccepted: Number(l.qty_accepted_base), unitCost: Number(l.unit_cost) })),
      });
      const requestId = `rcpt-${receipt.id}`.slice(0, 50);
      const created = await client.post('/bill', body, requestId);
      return { ok: true, externalId: created?.Bill?.Id };
    } catch (e: any) {
      const status = e?.status ?? 0;
      return { ok: false, retryable: status === 429 || status >= 500 || status === 401, error: e?.message ?? 'qbo bill failed' };
    }
  },
};
```

- [ ] **Step 5:** Register in `connectors/index.ts`: `CONNECTORS.quickbooks = quickbooksConnector`.
- [ ] **Step 6:** Integration test — drive `runDrain` with a seeded active QBO connection + a `receipt.posted` outbox event + receipt/lines/supplier rows + a mocked `QboClient` (spy on `.post`/`.query`); assert one Bill posted, sync_log `success` + external_id, re-run = no second post (idempotent via existing success row). `cd apps/web && npx tsc --noEmit && npx vitest run src/server/connectors`.
- [ ] **Step 7:** Commit.

---

## Task 10: Monthly inventory-valuation journal entry

**Files:** Create `apps/web/src/server/connectors/quickbooks/valuation.ts`, `valuation.test.ts`; edit the drainer route to invoke the monthly check; edit the QBO connector if needed.

- [ ] **Step 1: Failing test** (`valuation.test.ts`): `buildInventoryValuationJE({ deltaValue: 100, inventoryAssetId:'A', valuationOffsetId:'B', txnDate:'2026-05-31' })` → balanced JE: Debit A 100 / Credit B 100. And for `deltaValue:-40` → Debit B 40 / Credit A 40 (swap). And `deltaValue:0` → returns `null` (no JE).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `valuation.ts`** — `buildInventoryValuationJE(args)` (pure; returns the balanced JE body or `null` if delta is 0); plus `maybePostMonthlyValuation(admin, conn, client, now)` — once per month per connection: compute total via the same logic as `ReportsService.inventoryValuation()` (import/reuse it, or query `inventory_items` `Σ qty_on_hand*unit_cost` for the org), read `settings.lastValuationSnapshotValue` (default 0), if `now` is past the next due month-end and delta≠0 → post the JE (requestId `val-<realmId>-<YYYY-MM>`), update `settings.lastValuationSnapshotValue` + a `settings.lastValuationAt`.

- [ ] **Step 4:** Wire the monthly check into the drainer route (after `runDrain`): for each active QBO connection due this run, call `maybePostMonthlyValuation`. (Date-check inside the existing `*/5` cron — no second cron; documented in spec open-item 3.)

- [ ] **Step 5:** Run tests → PASS; `npx tsc --noEmit`.
- [ ] **Step 6:** Commit.

---

## Final verification (DoD)
- [ ] `cd packages/core && npx vitest run` + `cd apps/web && npx vitest run` → all PASS; `npx tsc --noEmit` clean in `packages/core` and `apps/web`; `cd apps/mobile && npx tsc --noEmit` clean (mobile untouched but confirm core export changes didn't break it).
- [ ] Migrations `0146`+`0147` apply cleanly on a copy; `connector_secret_get` NOT executable by `authenticated`; L4L has `integrations` enabled=false.
- [ ] L4L with `integrations` off: no Integrations tile; `/dashboard/settings/integrations` redirects; drainer no-ops (no active connection); receiving/items/books unchanged.
- [ ] Sandbox e2e (manual, needs Intuit creds): connect a QBO sandbox company → status active; post a receipt → a Bill appears in QBO with the right vendor + amount; re-run the drainer → no duplicate Bill; trigger/await a valuation JE → balanced JE appears.
- [ ] Migrations `0146`/`0147` must be applied to prod (flag to user). Web ships via Vercel on merge; no mobile changes.

## Plan self-review
- **Spec coverage:** framework tables+Vault (T1) ✓, connector interface/registry (T2) ✓, integrations module+perm+grandfather (T3) ✓, secret store (T4) ✓, drainer+cron (T5) ✓, env (T6) ✓, ConnectionsService+settings (T7) ✓, QBO OAuth (T8) ✓, receipt→Bill+Vendor (T9) ✓, monthly valuation JE (T10) ✓. Out-of-scope items absent.
- **Placeholder scan:** the "verify-at-impl" items (Vault availability, exact `vault.*` signatures, `intuit-oauth` install) are explicit verification steps with a concrete fallback, not silent TODOs. The AES fallback is fully described where it diverges.
- **Type consistency:** `Connector`/`OutboxEvent`/`ConnectionRef`/`ConnectorSecrets`/`PushResult`/`ConnectorDeps`/`ConnectorProviderId` (T2) are used consistently in the drainer (T5) + QBO connector (T9); `connector_secret_put/get/delete` (T1) match the secret-store (T4) + callback (T8) + disconnect (T7); `buildBillFromReceipt`/`resolveVendor` (T9) + `buildInventoryValuationJE`/`maybePostMonthlyValuation` (T10) consistent; `integrations` module + `integrations:manage` (T3) used by the settings gate (T7).

## Open items for the implementer (read code, not placeholders)
1. Vault availability (T1) → Vault vs AES fallback; pick before writing `0146`.
2. Exact `ReportsService.inventoryValuation()` import path + return shape (T10) — reuse it rather than re-query if clean.
3. The QBO token endpoint + authorize specifics: prefer `intuit-oauth`'s `authorizeUri`/`createToken`/`refresh`; only hand-roll if the lib is awkward.
4. The settings client-component conventions (Switch/Dialog/toast) — match Phase-2 `module-toggles.tsx`.
