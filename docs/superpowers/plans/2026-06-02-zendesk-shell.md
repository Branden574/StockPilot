# Zendesk Integration — Shell (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A dormant, off-by-default `zendesk` module — nav item with the Zendesk logo → an in-app Zendesk page (connect/status now; agent console is Phase 2) — plus a `zendesk` connector that turns 3 StockPilot events into Zendesk tickets the moment an org connects its API token.

**Architecture:** Rides the existing connector framework (CONNECTOR_REGISTRY + outbox drainer + Vault). New `zendesk` connector (push-only) subscribes to 3 new outbox topics; `ConnectionsService` gains a `connectZendesk`/`getZendeskConnection` path (token in Vault, EasyPost-style); the page hosts the connect card; 3 service/route seams emit the topics (best-effort). No new tables — `org_connections.provider_id` is free-text.

**Tech Stack:** Next.js (RSC + server actions + route handlers), Supabase (Postgres + RLS + Vault RPCs), `@stockpilot/core`, vitest, zod.

**Spec:** [`docs/superpowers/specs/2026-06-02-zendesk-shell-design.md`](../specs/2026-06-02-zendesk-shell-design.md)

**Conventions (verified):**
- Module gate: `assertModuleEnabled(ctx,'zendesk')` (throws `module_disabled`); page guard `checkModuleAccess('zendesk')` → `{enabled,canManage}` → `<ModuleNotEnabled moduleId="zendesk" canManage={...}/>` from `@/components/dashboard/module-not-enabled`.
- Manage gate: reuse `assertPermission(ctx,'integrations:manage')` (exists; owners/admins). No new Permission.
- Service: `class X { constructor(private ctx){}; static forCurrentUser(){return new X(await withContext())} }`; `ServiceError(code,msg)` codes `forbidden|not_found|validation_error|module_disabled|internal_error|conflict`.
- Action: `'use server'` + zod `safeParse` → `err`; `ok`/`err`/`ActionResult` from `@stockpilot/core` (discriminant `res.ok`, error `res.error.message`); catch `ServiceError`→`err(e.code,e.message)`.
- Outbox emit = `supabase.rpc('publish_outbox',{ p_org_id, p_topic, p_aggregate_type, p_aggregate_id, p_payload, p_dedupe_key })`, best-effort (a publish failure must NOT fail the action) — mirror `returns.ts` `publishReturnClosed`.
- Tests: `makeServiceContext(stub.client,{enabledModules,userId,role})` + `makeSupabaseStub({'table.op':{data,error}})` from `@/test/supabase-mock`; `DEFAULT_MODULE_IDS` from `@stockpilot/core` EXCLUDES `zendesk` (default ctx throws the gate; pass `new Set([...DEFAULT_MODULE_IDS,'zendesk'])` for happy paths).
- Vault: `putConnectionSecret(admin, name, secret)` / `deleteConnectionSecret(admin, secretId)` from `@/server/connectors/secret-store`; `createAdminClient()` from `@/lib/supabase/admin` (cast `as never` to satisfy the narrow `admin` type, as `connections.ts` does).
- Run: `cd apps/web && pnpm vitest run <p>` / `pnpm tsc --noEmit`; `cd packages/core && pnpm vitest run` / `pnpm tsc --noEmit`.

---

## Task 1: Migration 0165 + core registries (module + connector)

**Files:**
- Create: `supabase/migrations/0165_zendesk_module.sql`
- Modify: `packages/core/src/connectors/types.ts`, `packages/core/src/connectors/registry.ts`, `packages/core/src/modules/registry.ts`

- [ ] **Step 1: Read 0164** to copy `seed_org_modules()` byte-for-byte: `sed -n '1,75p' supabase/migrations/0164_live_tracking.sql`.

- [ ] **Step 2: Write** `supabase/migrations/0165_zendesk_module.sql` — identical structure to 0164's module section, appending ONE row. (No `delivery_locations`/charter bits — zendesk adds no tables.)

```sql
-- ============================================================================
-- 0165_zendesk_module.sql — Zendesk integration shell (Phase 1).
-- 1) Grandfather the optional 'zendesk' module OFF for existing orgs.
-- 2) Re-seed new orgs with it present-but-OFF (byte-identical to 0164 + 1 row).
-- No new tables: Zendesk rides org_connections (provider_id is free-text).
-- ============================================================================
set check_function_bodies = off;

insert into public.organization_modules (organization_id, module_id, enabled, tier, enabled_at)
select o.id, 'zendesk', false, 'optional', now()
from public.organizations o
on conflict (organization_id, module_id) do nothing;

create or replace function public.seed_org_modules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.organization_modules (organization_id, module_id, tier, enabled)
  select new.id, m.module_id, m.tier, m.enabled
  from (values
    -- 12 core (enabled)
    ('overview','core', true),
    ('inventory','core', true),
    ('movements','core', true),
    ('categories','core', true),
    ('locations','core', true),
    ('reports','core', true),
    ('notifications','core', true),
    ('team','core', true),
    ('settings','core', true),
    ('admin_tools','core', true),
    ('charters','core', true),
    ('scan','core', true),
    -- 13 optional (enabled)
    ('books','optional', true),
    ('rentals','optional', true),
    ('bundles','optional', true),
    ('orders','optional', true),
    ('cycle_counts','optional', true),
    ('procedures','optional', true),
    ('purchase_orders','optional', true),
    ('receiving','optional', true),
    ('po_imports','optional', true),
    ('suppliers','optional', true),
    ('schedule','optional', true),
    ('ai','optional', true),
    ('public_requests','optional', true),
    -- net-new opt-in optional (OFF)
    ('planning','optional', false),
    ('lot_serial','premium', false),
    ('price_tracking','optional', false),
    ('live_tracking','optional', false),
    -- net-new opt-in optional (OFF)
    ('zendesk','optional', false)
  ) as m(module_id, tier, enabled)
  on conflict (organization_id, module_id) do nothing;
  return new;
exception
  when others then
    raise warning 'seed_org_modules failed for org %: %', new.id, sqlerrm;
    return new;
end;
$$;

drop trigger if exists trg_seed_org_modules on public.organizations;
create trigger trg_seed_org_modules
  after insert on public.organizations
  for each row execute function public.seed_org_modules();
```
(Reconcile the VALUES list against the actual 0164 file from Step 1 — it MUST be 0164's list verbatim plus the single `('zendesk','optional', false)` row.)

- [ ] **Step 3: ConnectorProviderId** — in `packages/core/src/connectors/types.ts` change `export type ConnectorProviderId = 'quickbooks' | 'easypost';` → `... | 'easypost' | 'zendesk';`.

- [ ] **Step 4: Connector meta** — in `packages/core/src/connectors/registry.ts` add after the `easypost` entry:
```typescript
  zendesk: {
    id: 'zendesk',
    title: 'Zendesk',
    // Push-only: we create tickets from outbox events via the REST client.
    // Inbound webhooks (ticket status sync) are Phase 2. Auth = an API token
    // (Basic email/token) stored in Vault.
    modes: ['push'],
    subscribedTopics: ['return.created', 'public_request.created', 'order.problem'],
    requiresModule: 'zendesk',
  },
```

- [ ] **Step 5: Module registry** — in `packages/core/src/modules/registry.ts`: (a) append `| 'zendesk'` to the `ModuleId` union (currently ends `... | 'price_tracking' | 'live_tracking';` → add `| 'zendesk';`); (b) add a `MODULE_REGISTRY.zendesk` entry (place it after `live_tracking`/`price_tracking`):
```typescript
  zendesk: {
    id: 'zendesk',
    tier: 'optional',
    title: 'Zendesk',
    dependsOn: [],
    permissions: ['integrations:manage'],
    surfaces: ['web'],
    apiPrefixes: [],
    ownsTables: [],
    defaultOnFor: [],
    placements: [
      { surface: 'web_sidebar', section: 'workspace', label: 'Zendesk', href: '/dashboard/zendesk', iconName: 'Zendesk', defaultSortOrder: 900 },
    ],
  },
```

- [ ] **Step 6: Verify** — `cd packages/core && pnpm tsc --noEmit && pnpm vitest run` (registry tests green; if a test enumerates module/connector counts, update the expectation to include zendesk and say so) and `cd apps/web && pnpm tsc --noEmit`.

- [ ] **Step 7: Commit**
```bash
git add supabase/migrations/0165_zendesk_module.sql packages/core/src/connectors/types.ts packages/core/src/connectors/registry.ts packages/core/src/modules/registry.ts
git commit -m "feat(zendesk): migration 0165 + zendesk module/connector registry entries (OFF by default)"
```

---

## Task 2: Zendesk REST client (TDD)

**Files:**
- Create: `apps/web/src/server/connectors/zendesk/client.ts`
- Test: `apps/web/src/server/connectors/zendesk/client.test.ts`

- [ ] **Step 1: Failing test** `client.test.ts`:
```typescript
import { describe, expect, it, vi } from 'vitest';
import { ZendeskApiError, ZendeskClient } from './client';

const cfg = { subdomain: 'acme', email: 'agent@acme.com', apiToken: 'tok_123' };

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

describe('ZendeskClient', () => {
  it('validateToken resolves on 200', async () => {
    const f = mockFetch(200, { user: { id: 1 } });
    await expect(new ZendeskClient(cfg, f).validateToken()).resolves.toBeUndefined();
    const [url, init] = (f as unknown as vi.Mock).mock.calls[0];
    expect(url).toBe('https://acme.zendesk.com/api/v2/users/me.json');
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });

  it('validateToken throws ZendeskApiError on 401', async () => {
    const f = mockFetch(401, { error: 'Couldn\'t authenticate you' });
    await expect(new ZendeskClient(cfg, f).validateToken()).rejects.toBeInstanceOf(ZendeskApiError);
  });

  it('createTicket posts the ticket envelope and returns the new id', async () => {
    const f = mockFetch(201, { ticket: { id: 4242 } });
    const id = await new ZendeskClient(cfg, f).createTicket({
      subject: 'Return RMA-1', body: 'A return was created.', tags: ['stockpilot', 'return'],
      requesterName: 'Pat', requesterEmail: 'pat@x.com', priority: 'normal',
    });
    expect(id).toBe(4242);
    const [url, init] = (f as unknown as vi.Mock).mock.calls[0];
    expect(url).toBe('https://acme.zendesk.com/api/v2/tickets.json');
    expect(init.method).toBe('POST');
    const sent = JSON.parse(init.body as string);
    expect(sent.ticket.subject).toBe('Return RMA-1');
    expect(sent.ticket.comment.body).toBe('A return was created.');
    expect(sent.ticket.requester).toEqual({ name: 'Pat', email: 'pat@x.com' });
  });
});
```
Run (expect FAIL): `cd apps/web && pnpm vitest run src/server/connectors/zendesk/client.test.ts`.

- [ ] **Step 2: Implement** `client.ts`:
```typescript
import 'server-only';

export class ZendeskApiError extends Error {
  constructor(public status: number, message = `Zendesk API error ${status}`) {
    super(message);
    this.name = 'ZendeskApiError';
  }
}

export interface ZendeskConfig { subdomain: string; email: string; apiToken: string; }

export interface CreateTicketInput {
  subject: string;
  body: string;
  tags?: string[];
  requesterName?: string;
  requesterEmail?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
}

/**
 * Thin Zendesk REST v2 client. Auth = Basic base64(`${email}/token:${apiToken}`).
 * The token lives ONLY in the Authorization header — never logged or thrown.
 */
export class ZendeskClient {
  private readonly base: string;
  private readonly authHeader: string;
  constructor(cfg: ZendeskConfig, private readonly fetchImpl: typeof fetch = fetch) {
    this.base = `https://${cfg.subdomain}.zendesk.com/api/v2`;
    const token = Buffer.from(`${cfg.email}/token:${cfg.apiToken}`).toString('base64');
    this.authHeader = `Basic ${token}`;
  }

  /** Cheap authenticated GET to validate credentials at connect time. */
  async validateToken(): Promise<void> {
    const res = await this.fetchImpl(`${this.base}/users/me.json`, {
      headers: { Authorization: this.authHeader, Accept: 'application/json' },
    });
    if (!res.ok) throw new ZendeskApiError(res.status);
  }

  /** Create a ticket; returns the new ticket id. */
  async createTicket(input: CreateTicketInput): Promise<number> {
    const ticket: Record<string, unknown> = {
      subject: input.subject,
      comment: { body: input.body },
    };
    if (input.tags?.length) ticket.tags = input.tags;
    if (input.priority) ticket.priority = input.priority;
    if (input.requesterEmail) {
      ticket.requester = { name: input.requesterName ?? input.requesterEmail, email: input.requesterEmail };
    }
    const res = await this.fetchImpl(`${this.base}/tickets.json`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ ticket }),
    });
    if (!res.ok) throw new ZendeskApiError(res.status);
    const json = (await res.json()) as { ticket?: { id?: number } };
    const id = json.ticket?.id;
    if (typeof id !== 'number') throw new ZendeskApiError(res.status, 'Zendesk returned no ticket id');
    return id;
  }
}
```
(If the test's `vi.Mock` typing is awkward, the implementer may adjust the test's mock typing — keep the three intents. `Buffer` is available in the Node runtime used by these server modules.)

- [ ] **Step 3: Verify + commit**
```bash
cd apps/web && pnpm vitest run src/server/connectors/zendesk/client.test.ts && pnpm tsc --noEmit
git add apps/web/src/server/connectors/zendesk/client.ts apps/web/src/server/connectors/zendesk/client.test.ts
git commit -m "feat(zendesk): REST client (validateToken + createTicket)"
```

---

## Task 3: Zendesk connector (TDD) + registration

**Files:**
- Create: `apps/web/src/server/connectors/zendesk/index.ts`
- Test: `apps/web/src/server/connectors/zendesk/index.test.ts`
- Modify: `apps/web/src/server/connectors/index.ts` (register in `CONNECTORS`)

- [ ] **Step 1: Read** `apps/web/src/server/connectors/index.ts` and `apps/web/src/server/connectors/quickbooks/index.ts` (the `Connector` shape + how `CONNECTORS` maps id→connector + how QBO reads `event.topic`/`event.payload` and builds a client from `secrets`/`conn.settings`).

- [ ] **Step 2: Failing test** `index.test.ts` — mock the client module, assert each topic maps to a ticket and the retry classification:
```typescript
import { describe, expect, it, vi } from 'vitest';

const createTicket = vi.fn();
const validateToken = vi.fn();
vi.mock('./client', () => ({
  ZendeskApiError: class ZendeskApiError extends Error { constructor(public status: number){ super(`z${status}`);} },
  ZendeskClient: vi.fn().mockImplementation(() => ({ createTicket, validateToken })),
}));

import { zendeskConnector } from './index';
import { ZendeskApiError } from './client';

const conn = { id: 'c1', organizationId: 'org1', providerId: 'zendesk', status: 'active', externalAccountId: 'acme', settings: { subdomain: 'acme', email: 'a@acme.com' } } as const;
const secrets = { accessToken: 'tok', refreshToken: '', expiresAt: '' };
const deps = { admin: {}, fetch: globalThis.fetch, getMapping: vi.fn(), putMapping: vi.fn() } as never;
const evt = (topic: string, payload: Record<string, unknown>) => ({ id: 'e1', organizationId: 'org1', topic, aggregateType: 'x', aggregateId: 'a1', payload, dedupeKey: null, createdAt: '2026-06-02T00:00:00Z' });

describe('zendeskConnector', () => {
  it('subscribes to the 3 shell topics', () => {
    expect(zendeskConnector.subscribedTopics).toEqual(['return.created', 'public_request.created', 'order.problem']);
  });

  it('creates a ticket for return.created and returns the external id', async () => {
    createTicket.mockResolvedValueOnce(99);
    const r = await zendeskConnector.handleOutboxEvent(
      evt('return.created', { returnNumber: 'RMA-1', orderRequestId: 'o1', requesterEmail: 'p@x.com' }) as never,
      conn as never, secrets as never, deps,
    );
    expect(r.ok).toBe(true);
    expect(r.externalId).toBe('99');
    expect(createTicket).toHaveBeenCalledOnce();
  });

  it('treats a 4xx as non-retryable (dead-letter)', async () => {
    createTicket.mockRejectedValueOnce(new ZendeskApiError(422));
    const r = await zendeskConnector.handleOutboxEvent(evt('order.problem', { reason: 'x' }) as never, conn as never, secrets as never, deps);
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(false);
  });

  it('treats a 5xx as retryable', async () => {
    createTicket.mockRejectedValueOnce(new ZendeskApiError(503));
    const r = await zendeskConnector.handleOutboxEvent(evt('public_request.created', { requesterEmail: 'p@x.com' }) as never, conn as never, secrets as never, deps);
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
  });
});
```
Run (expect FAIL).

- [ ] **Step 3: Implement** `index.ts`:
```typescript
import 'server-only';
import type { Connector, PushResult } from '@stockpilot/core';
import { ZendeskApiError, ZendeskClient } from './client';

type TopicBuilder = (payload: Record<string, unknown>) => {
  subject: string; body: string; tags: string[]; priority?: 'low' | 'normal' | 'high' | 'urgent';
  requesterName?: string; requesterEmail?: string;
};

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

const BUILDERS: Record<string, TopicBuilder> = {
  'return.created': (p) => ({
    subject: `Return ${str(p.returnNumber) ?? str(p.returnId) ?? ''}`.trim() || 'New return',
    body: `A return was created in StockPilot.\nReturn: ${str(p.returnNumber) ?? ''}\nOrder: ${str(p.orderRequestId) ?? ''}\nReason: ${str(p.reason) ?? '—'}`,
    tags: ['stockpilot', 'return'],
    requesterEmail: str(p.requesterEmail),
    requesterName: str(p.requesterName),
  }),
  'public_request.created': (p) => ({
    subject: `New order request from ${str(p.requesterName) ?? str(p.requesterEmail) ?? 'a customer'}`,
    body: `A public order request was submitted.\nOrder: ${str(p.orderRequestId) ?? ''}\nStatus: ${str(p.status) ?? ''}`,
    tags: ['stockpilot', 'public-request'],
    requesterEmail: str(p.requesterEmail),
    requesterName: str(p.requesterName),
  }),
  'order.problem': (p) => ({
    subject: `Order problem — ${str(p.orderRequestId) ?? ''}`.trim(),
    body: `An order was flagged with a problem in StockPilot.\nOrder: ${str(p.orderRequestId) ?? ''}\nReason: ${str(p.reason) ?? '—'}`,
    tags: ['stockpilot', 'order-problem'],
    priority: 'high',
    requesterEmail: str(p.requesterEmail),
    requesterName: str(p.requesterName),
  }),
};

export const zendeskConnector: Connector = {
  id: 'zendesk',
  modes: ['push'],
  subscribedTopics: ['return.created', 'public_request.created', 'order.problem'],
  async handleOutboxEvent(event, conn, secrets): Promise<PushResult> {
    const build = BUILDERS[event.topic];
    if (!build) return { ok: false, retryable: false, error: `Unsupported topic: ${event.topic}` };
    const settings = conn.settings as { subdomain?: string; email?: string };
    if (!settings.subdomain || !settings.email || !secrets.accessToken) {
      return { ok: false, retryable: false, error: 'Zendesk connection is missing subdomain/email/token' };
    }
    const client = new ZendeskClient(
      { subdomain: settings.subdomain, email: settings.email, apiToken: secrets.accessToken },
    );
    try {
      const ticketId = await client.createTicket(build(event.payload));
      return { ok: true, externalId: String(ticketId) };
    } catch (e) {
      if (e instanceof ZendeskApiError) {
        const retryable = e.status >= 500 || e.status === 429;
        return { ok: false, retryable, error: `Zendesk ${e.status}` };
      }
      return { ok: false, retryable: true, error: e instanceof Error ? e.message : 'Unknown Zendesk error' };
    }
  },
};
```
**IMPORTANT:** Delete the `_types-shim` line — import `Connector`, `OutboxEvent`, `PushResult`, `ConnectionRef`, `ConnectorSecrets` from wherever `quickbooks/index.ts` imports them (`@stockpilot/core`). Match the QBO connector's exact import + the `handleOutboxEvent(event, conn, secrets, deps)` signature (the 4th `deps` arg is unused here — omit or accept it to satisfy the type).

- [ ] **Step 4: Register** in `apps/web/src/server/connectors/index.ts` — add `zendesk: zendeskConnector` (or push into the `CONNECTORS` array/record) exactly how `quickbooks`/`easypost` are registered (read the file first).

- [ ] **Step 5: Verify + commit**
```bash
cd apps/web && pnpm vitest run src/server/connectors/zendesk/index.test.ts && pnpm tsc --noEmit
git add apps/web/src/server/connectors/zendesk/index.ts apps/web/src/server/connectors/zendesk/index.test.ts apps/web/src/server/connectors/index.ts
git commit -m "feat(zendesk): push connector — outbox topics → Zendesk tickets (retry classification)"
```

---

## Task 4: ConnectionsService.connectZendesk + getZendeskConnection + disconnect branch (TDD)

**Files:**
- Modify: `apps/web/src/server/services/connections.ts`
- Test: `apps/web/src/server/services/connections.zendesk.test.ts`

- [ ] **Step 1: Read** `connections.ts` around `connectApiKey` (≈395–495) and `disconnect` (≈513) to mirror the Vault-put + upsert + the disconnect branch structure.

- [ ] **Step 2: Failing test** `connections.zendesk.test.ts`:
```typescript
import { describe, expect, it, vi } from 'vitest';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';
import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

const validateToken = vi.fn();
vi.mock('@/server/connectors/zendesk/client', () => ({
  ZendeskApiError: class extends Error { constructor(public status: number){ super('z'); } },
  ZendeskClient: vi.fn().mockImplementation(() => ({ validateToken })),
}));
vi.mock('@/server/connectors/secret-store', () => ({
  putConnectionSecret: vi.fn(async () => 'secret-id-1'),
  deleteConnectionSecret: vi.fn(async () => {}),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }));

import { ConnectionsService } from './connections';

const withZ = () => new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'zendesk']);
const input = { subdomain: 'acme', email: 'a@acme.com', apiToken: 'tok' };

describe('ConnectionsService.connectZendesk', () => {
  it('throws module_disabled when zendesk is off', async () => {
    const stub = makeSupabaseStub({});
    const svc = new ConnectionsService(makeServiceContext(stub.client)); // no zendesk
    await expect(svc.connectZendesk(input)).rejects.toMatchObject({ code: 'module_disabled' });
  });

  it('throws forbidden for a non-admin', async () => {
    const stub = makeSupabaseStub({});
    const svc = new ConnectionsService(makeServiceContext(stub.client, { enabledModules: withZ(), role: 'staff' }));
    await expect(svc.connectZendesk(input)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects a bad token as validation_error', async () => {
    validateToken.mockRejectedValueOnce(Object.assign(new Error('z'), { status: 401 }));
    const stub = makeSupabaseStub({ 'org_connections.select': { data: null, error: null } });
    const svc = new ConnectionsService(makeServiceContext(stub.client, { enabledModules: withZ(), role: 'admin' }));
    await expect(svc.connectZendesk(input)).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('connects: validates, stores secret, upserts org_connections', async () => {
    validateToken.mockResolvedValueOnce(undefined);
    const stub = makeSupabaseStub({
      'org_connections.select': { data: null, error: null },
      'org_connections.upsert': { data: { id: 'conn-1' }, error: null },
    });
    const svc = new ConnectionsService(makeServiceContext(stub.client, { enabledModules: withZ(), role: 'admin' }));
    await svc.connectZendesk(input);
    expect(stub.fromCalls).toContain('org_connections');
  });
});
```
(If `ZendeskApiError` instanceof checks matter, the mock throws an Error with a `.status`; in the service, catch any error from `validateToken` → `validation_error` regardless, so the test's plain-error rejection still maps to `validation_error`.)
Run (expect FAIL).

- [ ] **Step 3: Implement** — add to `ConnectionsService` (mirror `connectApiKey` but gated on `zendesk` + `integrations:manage`; settings carry `subdomain`+`email`; secret carries the token as `accessToken`). Add imports at the top of `connections.ts`: `import { ZendeskClient } from '@/server/connectors/zendesk/client';`.
```typescript
  /** Connect Zendesk via an API token (subdomain + agent email + token). */
  async connectZendesk(input: { subdomain: string; email: string; apiToken: string }): Promise<void> {
    assertModuleEnabled(this.ctx, 'zendesk');
    assertPermission(this.ctx, 'integrations:manage');
    const subdomain = input.subdomain.trim().replace(/\.zendesk\.com$/i, '').replace(/^https?:\/\//i, '');
    const email = input.email.trim();
    const apiToken = input.apiToken.trim();
    if (!subdomain || !email || !apiToken) {
      throw new ServiceError('validation_error', 'Subdomain, agent email, and API token are all required.');
    }
    try {
      await new ZendeskClient({ subdomain, email, apiToken }).validateToken();
    } catch {
      throw new ServiceError('validation_error', 'Zendesk rejected these credentials. Check the subdomain, agent email, and API token.');
    }

    const { data: existing, error: selErr } = await this.ctx.supabase
      .from('org_connections')
      .select('id, settings, created_by')
      .eq('organization_id', this.ctx.organizationId)
      .eq('provider_id', 'zendesk')
      .maybeSingle();
    if (selErr) throw new ServiceError('internal_error', selErr.message);
    const currentSettings = ((existing as { settings: Record<string, unknown> | null } | null)?.settings) ?? {};
    const createdBy = ((existing as { created_by: string | null } | null)?.created_by) ?? this.ctx.userId;

    const secretName = `connector:${(existing as { id: string } | null)?.id ?? `${this.ctx.organizationId}:zendesk`}`;
    const secretId = await putConnectionSecret(createAdminClient() as never, secretName, {
      accessToken: apiToken,
      refreshToken: '',
      expiresAt: '',
    });

    const { data: upserted, error: upErr } = await this.ctx.supabase
      .from('org_connections')
      .upsert(
        {
          organization_id: this.ctx.organizationId,
          provider_id: 'zendesk',
          status: 'active',
          secret_id: secretId,
          external_account_id: subdomain,
          oauth_state: null,
          settings: { ...currentSettings, subdomain, email },
          created_by: createdBy,
          last_connected_at: new Date().toISOString(),
        },
        { onConflict: 'organization_id,provider_id' },
      )
      .select('id')
      .maybeSingle();
    if (upErr) throw new ServiceError('internal_error', upErr.message);

    void audit(
      { event: 'integration.connected', entityType: 'org_connection', entityId: (upserted as { id: string } | null)?.id ?? null, extra: { provider: 'zendesk' } },
      this.ctx,
    );
  }

  /** Read this org's Zendesk connection (member-level). Null if never connected. */
  async getZendeskConnection(): Promise<{ status: string; subdomain: string | null; lastConnectedAt: string | null; lastError: string | null } | null> {
    assertModuleEnabled(this.ctx, 'zendesk');
    const { data, error } = await this.ctx.supabase
      .from('org_connections')
      .select('status, external_account_id, settings, last_connected_at, last_error')
      .eq('organization_id', this.ctx.organizationId)
      .eq('provider_id', 'zendesk')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) return null;
    const r = data as { status: string; external_account_id: string | null; settings: Record<string, unknown> | null; last_connected_at: string | null; last_error: string | null };
    return {
      status: r.status,
      subdomain: r.external_account_id ?? (r.settings?.subdomain as string | undefined) ?? null,
      lastConnectedAt: r.last_connected_at,
      lastError: r.last_error,
    };
  }
```
Then extend the existing `disconnect(provider)` so a `'zendesk'` provider gates on the `zendesk` module + `integrations:manage` (read the method's current branch logic ≈513–560 and add a zendesk case mirroring the easypost/integrations gate; the Vault-delete + row-update body is provider-agnostic and can be reused).

- [ ] **Step 4: Verify + commit**
```bash
cd apps/web && pnpm vitest run src/server/services/connections.zendesk.test.ts && pnpm tsc --noEmit
git add apps/web/src/server/services/connections.ts apps/web/src/server/services/connections.zendesk.test.ts
git commit -m "feat(zendesk): ConnectionsService connect/read/disconnect for the zendesk provider"
```

---

## Task 5: Zendesk actions + connect-card island (TDD on the action)

**Files:**
- Create: `apps/web/src/server/actions/zendesk.ts`
- Test: `apps/web/src/server/actions/zendesk.test.ts`
- Create: `apps/web/src/components/zendesk/zendesk-connect-card.tsx`

- [ ] **Step 1: Failing action test** `zendesk.test.ts`:
```typescript
import { describe, expect, it, vi } from 'vitest';
const connectZendesk = vi.fn();
const disconnect = vi.fn();
vi.mock('@/server/services/connections', () => ({
  ConnectionsService: { forCurrentUser: vi.fn(async () => ({ connectZendesk, disconnect })) },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
import { connectZendeskAction, disconnectZendeskAction } from './zendesk';

describe('zendesk actions', () => {
  it('rejects empty fields', async () => {
    const res = await connectZendeskAction({ subdomain: '', email: '', apiToken: '' });
    expect(res.ok).toBe(false);
  });
  it('connects with valid input', async () => {
    connectZendesk.mockResolvedValueOnce(undefined);
    const res = await connectZendeskAction({ subdomain: 'acme', email: 'a@acme.com', apiToken: 'tok' });
    expect(res.ok).toBe(true);
    expect(connectZendesk).toHaveBeenCalledOnce();
  });
  it('disconnects', async () => {
    disconnect.mockResolvedValueOnce(undefined);
    const res = await disconnectZendeskAction();
    expect(res.ok).toBe(true);
    expect(disconnect).toHaveBeenCalledWith('zendesk');
  });
});
```
Run (expect FAIL).

- [ ] **Step 2: Implement** `zendesk.ts`:
```typescript
'use server';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { err, ok, type ActionResult } from '@stockpilot/core';
import { ConnectionsService } from '@/server/services/connections';
import { ServiceError } from '@/server/services/context';

const connectSchema = z.object({
  subdomain: z.string().min(1).max(120),
  email: z.string().email().max(254),
  apiToken: z.string().min(1).max(512),
});

export async function connectZendeskAction(input: z.input<typeof connectSchema>): Promise<ActionResult> {
  const parsed = connectSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid Zendesk credentials.');
  try {
    const svc = await ConnectionsService.forCurrentUser();
    await svc.connectZendesk(parsed.data);
    revalidatePath('/dashboard/zendesk');
    return ok({});
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

export async function disconnectZendeskAction(): Promise<ActionResult> {
  try {
    const svc = await ConnectionsService.forCurrentUser();
    await svc.disconnect('zendesk');
    revalidatePath('/dashboard/zendesk');
    return ok({});
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
```
(Confirm `ActionResult` with no type-arg is valid in this repo — if it requires a type arg, use `ActionResult<Record<string, never>>` and `ok({})`; match how `disconnectEasyPostAction` is typed in `apps/web/src/server/actions/connections.ts`.)

- [ ] **Step 3: Verify the action** — `cd apps/web && pnpm vitest run src/server/actions/zendesk.test.ts && pnpm tsc --noEmit`.

- [ ] **Step 4: Connect-card island** `apps/web/src/components/zendesk/zendesk-connect-card.tsx` — match the EasyPost connect form in `apps/web/src/components/settings/integrations-panel.tsx` (read it for the Button/Input/Label/toast imports + the connect/disconnect button pattern):
```tsx
'use client';
import * as React from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { connectZendeskAction, disconnectZendeskAction } from '@/server/actions/zendesk';

interface Props {
  status: string | null;
  subdomain: string | null;
}

export function ZendeskConnectCard({ status, subdomain }: Props) {
  const [busy, setBusy] = React.useState(false);
  const connected = status === 'active';

  async function onConnect(formData: FormData) {
    setBusy(true);
    const res = await connectZendeskAction({
      subdomain: String(formData.get('subdomain') ?? ''),
      email: String(formData.get('email') ?? ''),
      apiToken: String(formData.get('apiToken') ?? ''),
    });
    setBusy(false);
    if (res.ok) toast.success('Zendesk connected.');
    else toast.error(res.error.message);
  }

  async function onDisconnect() {
    setBusy(true);
    const res = await disconnectZendeskAction();
    setBusy(false);
    if (res.ok) toast.success('Zendesk disconnected.');
    else toast.error(res.error.message);
  }

  if (connected) {
    return (
      <div className="rounded-lg border p-4">
        <p className="text-sm font-medium">Connected{subdomain ? ` to ${subdomain}.zendesk.com` : ''}</p>
        <Button type="button" variant="outline" size="sm" className="mt-3" disabled={busy} onClick={onDisconnect}>
          Disconnect
        </Button>
      </div>
    );
  }

  return (
    <form action={onConnect} className="space-y-3 rounded-lg border p-4">
      <div>
        <Label htmlFor="zd-subdomain">Zendesk subdomain</Label>
        <Input id="zd-subdomain" name="subdomain" placeholder="acme (from acme.zendesk.com)" required />
      </div>
      <div>
        <Label htmlFor="zd-email">Agent email</Label>
        <Input id="zd-email" name="email" type="email" placeholder="you@company.com" required />
      </div>
      <div>
        <Label htmlFor="zd-token">API token</Label>
        <Input id="zd-token" name="apiToken" type="password" placeholder="Zendesk API token" required />
      </div>
      <Button type="submit" variant="gradient" size="sm" disabled={busy}>
        {busy ? 'Connecting…' : 'Connect Zendesk'}
      </Button>
    </form>
  );
}
```
(Confirm `Input`/`Label` import paths against `integrations-panel.tsx`; adjust if they differ.)

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/server/actions/zendesk.ts apps/web/src/server/actions/zendesk.test.ts apps/web/src/components/zendesk/zendesk-connect-card.tsx
git commit -m "feat(zendesk): connect/disconnect actions + connect-card island"
```

---

## Task 6: Zendesk logo icon + nav registration + the /dashboard/zendesk page

**Files:**
- Create: `apps/web/src/components/dashboard/zendesk-logo.tsx`
- Modify: `apps/web/src/components/dashboard/icons.ts`
- Create: `apps/web/src/app/(dashboard)/dashboard/zendesk/page.tsx`

- [ ] **Step 1: Logo component** `zendesk-logo.tsx` — a lucide-compatible `forwardRef` SVG (fill `currentColor`, accepts `size`/`className`), so it slots into `NAV_ICONS`:
```tsx
import * as React from 'react';
import type { LucideProps } from 'lucide-react';

// Simplified Zendesk-style mark (two angular wedges) in currentColor so it
// inherits the nav's color states. Lucide-shaped props so it drops into NAV_ICONS.
export const ZendeskLogo = React.forwardRef<SVGSVGElement, LucideProps>(
  ({ size = 24, className, ...rest }, ref) => (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
      {...rest}
    >
      <path d="M11 8.5V19H3z" />
      <path d="M13 15.5V5h8z" />
    </svg>
  ),
);
ZendeskLogo.displayName = 'ZendeskLogo';
```

- [ ] **Step 2: Register the icon** — in `apps/web/src/components/dashboard/icons.ts`: import the component (`import { ZendeskLogo } from './zendesk-logo';`) and add `Zendesk: ZendeskLogo,` to the `NAV_ICONS` record. If tsc complains the value isn't assignable to `LucideIcon`, cast: `Zendesk: ZendeskLogo as unknown as LucideIcon`.

- [ ] **Step 3: The page** `apps/web/src/app/(dashboard)/dashboard/zendesk/page.tsx` — read an existing simple dashboard page (e.g. the settings/integrations page) for the `withContext`/`checkModuleAccess`/`hasPermission` imports + the page-shell markup, then:
```tsx
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { ConnectionsService } from '@/server/services/connections';
import { ZendeskConnectCard } from '@/components/zendesk/zendesk-connect-card';
import { ZendeskLogo } from '@/components/dashboard/zendesk-logo';
import { withContext } from '@/server/services/context';
import { hasPermission } from '@stockpilot/core';

export const dynamic = 'force-dynamic';

export default async function ZendeskPage() {
  const access = await checkModuleAccess('zendesk');
  if (!access.enabled) return <ModuleNotEnabled moduleId="zendesk" canManage={access.canManage} />;

  const ctx = await withContext();
  const canManage = hasPermission(ctx.role, 'integrations:manage');

  const svc = await ConnectionsService.forCurrentUser();
  const conn = await svc.getZendeskConnection();

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="flex items-center gap-3">
        <ZendeskLogo size={28} className="text-foreground" />
        <div>
          <h1 className="font-display text-2xl">Zendesk</h1>
          <p className="text-muted-foreground text-sm">Support tickets + (soon) an in-app agent console.</p>
        </div>
      </header>

      <section className="bg-card rounded-xl border p-4">
        <h2 className="text-sm font-medium">Connection</h2>
        {conn?.status === 'active' ? (
          <p className="text-muted-foreground mt-1 text-sm">
            Connected{conn.subdomain ? ` to ${conn.subdomain}.zendesk.com` : ''}
            {conn.lastConnectedAt ? ` · since ${new Date(conn.lastConnectedAt).toLocaleString()}` : ''}.
          </p>
        ) : (
          <p className="text-muted-foreground mt-1 text-sm">
            {conn?.lastError ? `Last error: ${conn.lastError}` : 'Not connected yet.'}
          </p>
        )}
        {canManage ? (
          <div className="mt-3">
            <ZendeskConnectCard status={conn?.status ?? null} subdomain={conn?.subdomain ?? null} />
          </div>
        ) : (
          <p className="text-muted-foreground mt-3 text-xs">Ask an admin to connect Zendesk.</p>
        )}
      </section>

      <section className="bg-card rounded-xl border p-4">
        <h2 className="text-sm font-medium">Agent console</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Coming next: view and reply to tickets, set status/priority/assignee, search, and macros — with the
          requesting order &amp; inventory context side-by-side, right here in StockPilot. Once connected, these
          events automatically open tickets: new returns, public order requests, and order problems.
        </p>
      </section>
    </div>
  );
}
```
(Adjust imports to the repo's real exports — confirm `hasPermission` is exported from `@stockpilot/core` and `withContext` from `@/server/services/context`; the settings/integrations page already uses both patterns.)

- [ ] **Step 4: Verify + commit** — `cd apps/web && pnpm tsc --noEmit && pnpm vitest run` (no regressions). Confirm the nav item renders (the registry placement + `NAV_ICONS['Zendesk']`).
```bash
git add apps/web/src/components/dashboard/zendesk-logo.tsx apps/web/src/components/dashboard/icons.ts "apps/web/src/app/(dashboard)/dashboard/zendesk/page.tsx"
git commit -m "feat(zendesk): nav logo + /dashboard/zendesk page (connection status + connect card + console stub)"
```

---

## Task 7: Trigger emits (best-effort) — return.created, order.problem, public_request.created

**Files:**
- Modify: `apps/web/src/server/services/returns.ts`
- Modify: `apps/web/src/server/services/order-requests.ts`
- Modify: `apps/web/src/app/api/v1/public/order-requests/route.ts`

- [ ] **Step 1: `returns.ts` `createFromOrder`** — after the existing `await audit({ event:'return.created', ... })` block and BEFORE `return { ...header, ... }` (≈ line 510), emit:
```typescript
    // Zendesk shell: surface a new return as a ticket (best-effort; dormant
    // until a zendesk connection is active — the drainer skips otherwise).
    try {
      await this.ctx.supabase.rpc('publish_outbox', {
        p_org_id: this.ctx.organizationId,
        p_topic: 'return.created',
        p_aggregate_type: 'return',
        p_aggregate_id: header.id,
        p_payload: {
          returnId: header.id,
          returnNumber: header.return_number,
          orderRequestId,
        },
        p_dedupe_key: `return.created:${header.id}`,
      });
    } catch {
      /* best-effort: a publish failure must not fail the created return */
    }
```
(`header`, `orderRequestId`, `this.ctx` are all in scope there.)

- [ ] **Step 2: `order-requests.ts` `deny`** — after the `await audit({ event:'order_request.denied', ... })` block and the `void this.notifyEmail(row,'denied')` line, before `return row;` (≈ line 1349), emit:
```typescript
    // Zendesk shell: a denied order is an "order problem" ticket (best-effort).
    try {
      await this.ctx.supabase.rpc('publish_outbox', {
        p_org_id: this.ctx.organizationId,
        p_topic: 'order.problem',
        p_aggregate_type: 'order_request',
        p_aggregate_id: id,
        p_payload: {
          orderRequestId: id,
          requesterEmail: row.requester_email,
          requesterName: row.requester_name,
          reason,
        },
        p_dedupe_key: `order.problem:${id}`,
      });
    } catch {
      /* best-effort */
    }
```
(Confirm `OrderRequestRow` has `requester_name`; if not, drop that field. `row`, `id`, `reason`, `this.ctx` are in scope.)

- [ ] **Step 3: public route** `apps/web/src/app/api/v1/public/order-requests/route.ts` — after the line-insert success (after the `if (lineErr) { … }` block, ≈ line 500, where `header` + `organizationId` are in scope), emit via the `admin` client:
```typescript
  // Zendesk shell: a new public order request opens a support ticket
  // (best-effort; dormant until a zendesk connection is active). NOTE: fires at
  // submit, before email confirmation — acceptable for v1; a follow-up could
  // move this to the confirmation RPC to avoid unconfirmed/bot submissions.
  try {
    await admin.rpc('publish_outbox', {
      p_org_id: organizationId,
      p_topic: 'public_request.created',
      p_aggregate_type: 'order_request',
      p_aggregate_id: header.id,
      p_payload: {
        orderRequestId: header.id,
        requesterEmail,
        requesterName: body.requesterName,
        status: 'pending_confirmation',
      },
      p_dedupe_key: `public_request.created:${header.id}`,
    });
  } catch {
    /* best-effort: never fail the submission on a publish error */
  }
```
(`admin`, `organizationId`, `header`, `requesterEmail`, `body.requesterName` are all in scope — verified.)

- [ ] **Step 4: Verify + commit** — `cd apps/web && pnpm tsc --noEmit && pnpm vitest run src/server/services/returns src/server/services/order-requests` (existing tests green).
```bash
git add apps/web/src/server/services/returns.ts apps/web/src/server/services/order-requests.ts "apps/web/src/app/api/v1/public/order-requests/route.ts"
git commit -m "feat(zendesk): emit return.created / order.problem / public_request.created to the outbox (best-effort)"
```

---

## Final verification + ship
- [ ] `cd packages/core && pnpm tsc --noEmit && pnpm vitest run` → clean/green.
- [ ] `cd apps/web && pnpm tsc --noEmit && pnpm vitest run` → clean/green.
- [ ] `cd apps/web && pnpm build` → compiles (new RSC page + client islands).
- [ ] Spec coverage: module+migration (T1), connector registry (T1), REST client (T2), connector handler (T3), connect/read/disconnect (T4), actions+card (T5), nav logo+page (T6), 3 emits (T7). `critical alerts` trigger + inbound webhook + agent console = Phase 2 (documented, not in scope).
- [ ] Ship: merge `zendesk` → `main` → push (Vercel). **Apply migration 0165 to prod** (`supabase db push --linked`). No mobile → no OTA. Update memory. Admin enables `zendesk` in Settings → Modules, opens the Zendesk nav item, pastes subdomain + agent email + API token → connected; the 3 triggers create tickets for future events.

## Notes / scope
- Dormant by design: nothing fires until an org has an ACTIVE zendesk connection (the drainer module-gates + skips orgs without one). Outbound only (push). Token in Vault; connect/disconnect gated on `integrations:manage` + the `zendesk` module.
- Phase 2 (next sub-project): the native agent console (tickets list/views, open ticket, public+internal replies, status/priority/assignee/tags, search, macros, attachments, requester + order/inventory context), the inbound webhook (`/api/webhooks/zendesk`), and the critical-alerts trigger.
