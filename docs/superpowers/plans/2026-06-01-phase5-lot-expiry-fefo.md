# Phase 5 v1 — Food lot / expiry / FEFO Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a food-warehouse vertical — lot tracking, expiry/shelf-life, FEFO picking guidance, and aging/recall reports — gated behind an off-by-default `lot_serial` premium module, reusing the existing lot/serial DB layer + receiving capture UI.

**Architecture:** A **light** model — NO per-lot stock. Aggregate `quantity_on_hand`/`adjust_stock`/cycle-count/returns invariants are untouched. New per-item `shelf_life_days` + `expiry_policy` columns; a `lot_pick_events` audit table for FEFO traceability (no stock impact); pure core expiry/FEFO helpers; a gated `LotsService`; a tracking-type/shelf-life item-form section; an advisory FEFO hint on the pick surface; and two module-gated reports.

**Tech Stack:** Next.js (App Router, RSC + server actions), Supabase (Postgres + RLS), TypeScript, vitest, zod, shadcn/ui, `@stockpilot/core`.

**Spec:** [`docs/superpowers/specs/2026-06-01-phase5-lot-expiry-fefo-design.md`](../specs/2026-06-01-phase5-lot-expiry-fefo-design.md)

**Key conventions discovered (reuse, don't reinvent):**
- Service: `class X { constructor(private readonly ctx: ServiceContext) {}; static async forCurrentUser(){ return new X(await withContext()); } }`; gate with `assertModuleEnabled(this.ctx,'lot_serial')`; query `.eq('organization_id', this.ctx.organizationId)`; throw `new ServiceError(code,msg)`.
- Action: `'use server'` + zod `safeParse` → `err('validation_error',…)`; `try { … ok(...) } catch(e){ toResult(e) }` (or `err`).
- Page gate: `const a = await checkModuleAccess('lot_serial'); if(!a.enabled) return <ModuleNotEnabled moduleId="lot_serial" canManage={a.canManage}/>;`
- Tests: `import { describe, expect, it, vi } from 'vitest'`; `import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock'`. `makeServiceContext(stub.client, { enabledModules })` — default `enabledModules = DEFAULT_MODULE_IDS` (charter-school set, which does **NOT** include premium `lot_serial`), so the default context **throws** on the `lot_serial` gate; pass `withLotSerial()` for the happy path.
- `makeSupabaseStub({ 'table.select': { data, error }, 'rpc:fn': {...} })`.
- RLS idiom: `using ( exists ( select 1 from public.organization_members m where m.user_id = auth.uid() and m.organization_id = T.organization_id and m.accepted_at is not null))` for select; `public.has_org_role(organization_id,'manager')` (lowercase) for write.
- Run tests from `apps/web`: `pnpm vitest run <path>`. Run core tests from `packages/core`: `pnpm vitest run <path>`. Typecheck: `pnpm -C apps/web tsc --noEmit` and `pnpm -C packages/core tsc --noEmit` (confirm exact script in each package.json before first use).

---

## Task 1: Migration 0162 — module grandfather + expiry columns + lot_pick_events

**Files:**
- Create: `supabase/migrations/0162_lot_serial_module_expiry.sql`

This migration does NOT run locally in this harness (prod is a controller/human apply step, like 0158–0161). Verification = SQL self-review + the seed function staying byte-identical to 0161 plus the one new row. All app reads fail closed, so the branch is safe to merge before the migration is applied.

- [ ] **Step 1: Read the 0161 template** so the `seed_org_modules()` body stays byte-identical except the appended premium row.

Run: `sed -n '1,120p' supabase/migrations/0161_planning_module.sql`

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/0162_lot_serial_module_expiry.sql`:

```sql
-- ============================================================================
-- 0162_lot_serial_module_expiry.sql
-- Phase 5 v1 — food lot/expiry/FEFO (LIGHT model, no per-lot stock).
--
-- 1) Grandfather the premium 'lot_serial' module OFF for every existing org
--    (explicit opt-in; on for agriculture_food via applyIndustryPackAction's
--    modulesForPack, NOT this base trigger). Mirrors 0161/0147.
-- 2) Re-seed new orgs with 'lot_serial' present-but-OFF (premium).
-- 3) Per-item shelf life + expiry policy.
-- 4) lot_pick_events — FEFO traceability audit. NO stock impact.
-- ============================================================================

set check_function_bodies = off;

-- ── 1) Grandfather existing orgs: 'lot_serial' OFF ──────────────────────────
insert into public.organization_modules (organization_id, module_id, enabled, tier, enabled_at)
select o.id, 'lot_serial', false, 'premium', now()
from public.organizations o
on conflict (organization_id, module_id) do nothing;

-- ── 2) New-org seed: byte-identical to 0161 + 'lot_serial' premium OFF ──────
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
    -- net-new opt-in premium (OFF)
    ('lot_serial','premium', false)
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

-- ── 3) Per-item shelf life + expiry policy ──────────────────────────────────
alter table public.inventory_items
  add column if not exists shelf_life_days integer
    check (shelf_life_days is null or shelf_life_days > 0),
  add column if not exists expiry_policy text not null default 'warn'
    check (expiry_policy in ('none','warn','block'));

-- ── 4) lot_pick_events — FEFO traceability audit (NO stock impact) ──────────
create table if not exists public.lot_pick_events (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  order_request_id      uuid references public.order_requests(id) on delete set null,
  order_request_line_id uuid references public.order_request_lines(id) on delete set null,
  item_id               uuid not null references public.inventory_items(id) on delete restrict,
  lot_number            text not null,
  expiration_date       date,
  qty                   numeric(18,4) not null check (qty > 0),
  picked_by             uuid references auth.users(id) on delete set null,
  picked_at             timestamptz not null default now()
);

create index if not exists lot_pick_events_item_lot_idx
  on public.lot_pick_events(organization_id, item_id, lot_number);
create index if not exists lot_pick_events_line_idx
  on public.lot_pick_events(order_request_line_id);

alter table public.lot_pick_events enable row level security;

drop policy if exists lot_pick_events_select on public.lot_pick_events;
create policy lot_pick_events_select on public.lot_pick_events
  for select using (
    exists (
      select 1 from public.organization_members m
      where m.user_id = auth.uid()
        and m.organization_id = lot_pick_events.organization_id
        and m.accepted_at is not null
    )
  );

drop policy if exists lot_pick_events_write on public.lot_pick_events;
create policy lot_pick_events_write on public.lot_pick_events
  for all using (public.has_org_role(organization_id, 'manager'));
```

- [ ] **Step 3: Self-review** — diff the `seed_org_modules()` body against 0161 (only the appended `('lot_serial','premium', false)` line + its comment differ). Confirm `organization_members.accepted_at` is the correct membership-accept column (it is — matches `receipt_line_lots` RLS in 0015).

Run: `diff <(sed -n '/create or replace function public.seed_org_modules/,/\$\$;/p' supabase/migrations/0161_planning_module.sql) <(sed -n '/create or replace function public.seed_org_modules/,/\$\$;/p' supabase/migrations/0162_lot_serial_module_expiry.sql)`
Expected: only the `lot_serial` row (and surrounding comment) differs.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0162_lot_serial_module_expiry.sql
git commit -m "feat(p5): migration 0162 — lot_serial grandfather OFF + expiry cols + lot_pick_events"
```

---

## Task 2: Core — expiry/FEFO helpers (pure, TDD)

**Files:**
- Create: `packages/core/src/lots/expiry.ts`
- Test: `packages/core/src/lots/expiry.test.ts`
- Modify: `packages/core/src/index.ts` (add `export * from './lots/expiry';`)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/lots/expiry.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { computeLotExpiry, expiryBucket, sortLotsFefo } from './expiry';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-06-01T00:00:00.000Z');

describe('computeLotExpiry', () => {
  it('uses the explicit expiration date when present', () => {
    const got = computeLotExpiry(
      { expirationDate: '2026-07-01', receivedAt: '2026-05-01T00:00:00Z' },
      { shelfLifeDays: 10 },
    );
    expect(got?.toISOString().slice(0, 10)).toBe('2026-07-01');
  });

  it('falls back to receivedAt + shelfLifeDays when no explicit date', () => {
    const got = computeLotExpiry(
      { expirationDate: null, receivedAt: '2026-05-01T00:00:00.000Z' },
      { shelfLifeDays: 30 },
    );
    expect(got?.toISOString().slice(0, 10)).toBe('2026-05-31');
  });

  it('returns null when neither an explicit date nor shelf life is available', () => {
    expect(
      computeLotExpiry({ expirationDate: null, receivedAt: '2026-05-01T00:00:00Z' }, { shelfLifeDays: null }),
    ).toBeNull();
  });
});

describe('expiryBucket', () => {
  it('classifies by days to expiry relative to now', () => {
    expect(expiryBucket(new Date(now.getTime() - DAY), now)).toBe('expired');
    expect(expiryBucket(new Date(now.getTime() + 3 * DAY), now)).toBe('le7');
    expect(expiryBucket(new Date(now.getTime() + 20 * DAY), now)).toBe('le30');
    expect(expiryBucket(new Date(now.getTime() + 60 * DAY), now)).toBe('le90');
    expect(expiryBucket(new Date(now.getTime() + 200 * DAY), now)).toBe('ok');
    expect(expiryBucket(null, now)).toBe('unknown');
  });

  it('treats exactly-now as expired (boundary)', () => {
    expect(expiryBucket(new Date(now.getTime()), now)).toBe('expired');
  });
});

describe('sortLotsFefo', () => {
  it('orders earliest expiry first; null/unknown expiry sorts last', () => {
    const lots = [
      { id: 'c', expiry: null },
      { id: 'a', expiry: new Date(now.getTime() + 5 * DAY) },
      { id: 'b', expiry: new Date(now.getTime() + 50 * DAY) },
    ];
    expect(sortLotsFefo(lots).map((l) => l.id)).toEqual(['a', 'b', 'c']);
  });

  it('is a pure, stable sort (does not mutate input)', () => {
    const lots = [{ id: 'x', expiry: new Date(now.getTime() + DAY) }];
    const copy = [...lots];
    sortLotsFefo(lots);
    expect(lots).toEqual(copy);
  });
});
```

- [ ] **Step 2: Run it; expect failure**

Run: `pnpm -C packages/core vitest run src/lots/expiry.test.ts`
Expected: FAIL — `Cannot find module './expiry'`.

- [ ] **Step 3: Implement**

Create `packages/core/src/lots/expiry.ts`:

```typescript
/**
 * Pure lot-expiry + FEFO helpers (Phase 5 — food vertical). No DB, no I/O.
 * The LIGHT model carries no per-lot stock; these helpers only derive expiry
 * dates, classify them into urgency buckets, and order lots earliest-first.
 */

export type ExpiryBucket = 'expired' | 'le7' | 'le30' | 'le90' | 'ok' | 'unknown';

export interface LotExpiryInput {
  /** Explicit captured expiration date (YYYY-MM-DD) or null. */
  expirationDate: string | null;
  /** When the lot was received (ISO timestamp) — fallback anchor for shelf life. */
  receivedAt: string;
}

export interface ItemExpiryConfig {
  /** Per-item shelf life in days, or null when not configured. */
  shelfLifeDays: number | null;
}

/**
 * Effective expiry for a lot: the explicit captured date if present; else
 * receivedAt + shelfLifeDays; else null (unknowable — sorts last in FEFO).
 */
export function computeLotExpiry(lot: LotExpiryInput, item: ItemExpiryConfig): Date | null {
  if (lot.expirationDate) {
    const d = new Date(lot.expirationDate);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (item.shelfLifeDays && item.shelfLifeDays > 0) {
    const base = new Date(lot.receivedAt);
    if (Number.isNaN(base.getTime())) return null;
    return new Date(base.getTime() + item.shelfLifeDays * 24 * 60 * 60 * 1000);
  }
  return null;
}

/** Urgency bucket for an effective expiry relative to `now`. */
export function expiryBucket(expiry: Date | null, now: Date): ExpiryBucket {
  if (!expiry) return 'unknown';
  const ms = expiry.getTime() - now.getTime();
  if (ms <= 0) return 'expired';
  const days = ms / (24 * 60 * 60 * 1000);
  if (days <= 7) return 'le7';
  if (days <= 30) return 'le30';
  if (days <= 90) return 'le90';
  return 'ok';
}

/**
 * FEFO order: ascending by effective expiry, with null/unknown expiry LAST
 * (you can't first-expire what has no date). Pure — returns a new array.
 */
export function sortLotsFefo<T extends { expiry: Date | null }>(lots: readonly T[]): T[] {
  return [...lots].sort((a, b) => {
    if (a.expiry === null && b.expiry === null) return 0;
    if (a.expiry === null) return 1;
    if (b.expiry === null) return -1;
    return a.expiry.getTime() - b.expiry.getTime();
  });
}
```

- [ ] **Step 4: Add the barrel export**

In `packages/core/src/index.ts`, append after the last `export * from` line:

```typescript
export * from './lots/expiry';
```

- [ ] **Step 5: Run tests + typecheck; expect pass**

Run: `pnpm -C packages/core vitest run src/lots/expiry.test.ts && pnpm -C packages/core tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/lots/expiry.ts packages/core/src/lots/expiry.test.ts packages/core/src/index.ts
git commit -m "feat(p5-core): pure lot expiry/FEFO helpers (computeLotExpiry, expiryBucket, sortLotsFefo)"
```

---

## Task 3: Core — schema fields + registry ownsTables reconcile

**Files:**
- Modify: `packages/core/src/schemas/inventory.ts` (add `shelfLifeDays`, `expiryPolicy` to `createItemSchema`)
- Modify: `packages/core/src/modules/registry.ts` (`lot_serial.ownsTables`)

- [ ] **Step 1: Read the current schema** to place the new fields beside `trackingType`.

Run: `sed -n '35,70p' packages/core/src/schemas/inventory.ts`

- [ ] **Step 2: Add the fields** to `createItemSchema`, immediately after the `trackingType` line:

```typescript
  trackingType: z.enum(['none', 'lot', 'serial']).default('none'),
  /** Phase 5 (lot_serial module): per-item shelf life in days. */
  shelfLifeDays: z.preprocess(
    (v) => (v === '' || v === null ? null : v),
    z.coerce.number().int().positive().nullable().optional(),
  ),
  /** Phase 5: near/expired lot behavior. 'block' rejects FEFO picks of expired lots. */
  expiryPolicy: z.enum(['none', 'warn', 'block']).default('warn'),
```

(`updateItemSchema = createItemSchema.partial()` already picks these up.)

- [ ] **Step 3: Reconcile the registry `ownsTables`** for `lot_serial` (currently the placeholder `['lots','serials']`). In `packages/core/src/modules/registry.ts` (~line 553):

```typescript
    ownsTables: ['receipt_line_lots', 'serial_registry', 'lot_pick_events'],
```

- [ ] **Step 4: Typecheck + run any registry/schema tests**

Run: `pnpm -C packages/core tsc --noEmit && pnpm -C packages/core vitest run`
Expected: clean + green (existing core suites unaffected).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/schemas/inventory.ts packages/core/src/modules/registry.ts
git commit -m "feat(p5-core): item schema shelfLifeDays/expiryPolicy + reconcile lot_serial ownsTables"
```

---

## Task 4: LotsService (gated; TDD)

**Files:**
- Create: `apps/web/src/server/services/lots.ts`
- Test: `apps/web/src/server/services/lots.test.ts`

Data sources: lots live in `receipt_line_lots(receipt_line_id, lot_number, expiration_date, qty_base, created_at)`, joined to `receipt_lines(receipt_id,item_id)` → `receipts(organization_id, purchase_order_id, warehouse_id, receipt_number, created_at)`. Picks live in `lot_pick_events`. Since RLS already scopes `receipt_line_lots` by org membership, the service selects through the join and filters on `receipts.organization_id` for clarity.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/server/services/lots.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';
import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { LotsService } from './lots';

const withLotSerial = () => new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'lot_serial']);

describe('LotsService module gate', () => {
  it('throws module_disabled when lot_serial is not enabled', async () => {
    const stub = makeSupabaseStub({});
    const svc = new LotsService(makeServiceContext(stub.client)); // default: no lot_serial
    await expect(svc.getAgingInventory()).rejects.toMatchObject({ code: 'module_disabled' });
    await expect(svc.traceLot('LOT-1')).rejects.toMatchObject({ code: 'module_disabled' });
    await expect(svc.getFefoSuggestion('item-1')).rejects.toMatchObject({ code: 'module_disabled' });
  });
});

describe('LotsService.getAgingInventory', () => {
  it('nets recorded picks out of received qty and buckets by expiry', async () => {
    const stub = makeSupabaseStub({
      'receipt_line_lots.select': {
        data: [
          {
            lot_number: 'A', expiration_date: '2000-01-01', qty_base: 10, created_at: '2026-05-01T00:00:00Z',
            receipt_lines: { item_id: 'item-1', receipts: { organization_id: 'org-test' },
              inventory_items: { name: 'Milk', sku: 'MILK', shelf_life_days: null } },
          },
          {
            lot_number: 'B', expiration_date: '2099-01-01', qty_base: 5, created_at: '2026-05-01T00:00:00Z',
            receipt_lines: { item_id: 'item-1', receipts: { organization_id: 'org-test' },
              inventory_items: { name: 'Milk', sku: 'MILK', shelf_life_days: null } },
          },
        ],
        error: null,
      },
      'lot_pick_events.select': {
        data: [{ item_id: 'item-1', lot_number: 'A', qty: 4 }],
        error: null,
      },
    });
    const svc = new LotsService(makeServiceContext(stub.client, { enabledModules: withLotSerial() }));
    const rows = await svc.getAgingInventory();
    const a = rows.find((r) => r.lotNumber === 'A');
    const b = rows.find((r) => r.lotNumber === 'B');
    expect(a?.remaining).toBe(6); // 10 received - 4 picked
    expect(a?.bucket).toBe('expired');
    expect(b?.remaining).toBe(5);
    expect(b?.bucket).toBe('ok');
    // FEFO order: expired 'A' before ok 'B'
    expect(rows.map((r) => r.lotNumber)).toEqual(['A', 'B']);
  });

  it('drops fully-consumed lots (remaining <= 0)', async () => {
    const stub = makeSupabaseStub({
      'receipt_line_lots.select': {
        data: [{
          lot_number: 'A', expiration_date: '2099-01-01', qty_base: 4, created_at: '2026-05-01T00:00:00Z',
          receipt_lines: { item_id: 'item-1', receipts: { organization_id: 'org-test' },
            inventory_items: { name: 'X', sku: 'X', shelf_life_days: null } },
        }],
        error: null,
      },
      'lot_pick_events.select': { data: [{ item_id: 'item-1', lot_number: 'A', qty: 4 }], error: null },
    });
    const svc = new LotsService(makeServiceContext(stub.client, { enabledModules: withLotSerial() }));
    expect(await svc.getAgingInventory()).toEqual([]);
  });
});

describe('LotsService.recordLotPicks', () => {
  it('blocks an expired-lot pick when the item expiry_policy is "block"', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: { expiry_policy: 'block', shelf_life_days: null }, error: null },
    });
    const svc = new LotsService(makeServiceContext(stub.client, { enabledModules: withLotSerial() }));
    await expect(
      svc.recordLotPicks({
        orderRequestId: 'o1', orderRequestLineId: 'l1', itemId: 'item-1',
        picks: [{ lotNumber: 'A', qty: 1, expirationDate: '2000-01-01' }],
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('inserts pick events when policy allows (warn)', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: { expiry_policy: 'warn', shelf_life_days: null }, error: null },
      'lot_pick_events.insert': { data: null, error: null },
    });
    const svc = new LotsService(makeServiceContext(stub.client, { enabledModules: withLotSerial() }));
    await svc.recordLotPicks({
      orderRequestId: 'o1', orderRequestLineId: 'l1', itemId: 'item-1',
      picks: [{ lotNumber: 'A', qty: 2, expirationDate: '2000-01-01' }],
    });
    expect(stub.fromCalls).toContain('lot_pick_events');
  });
});
```

- [ ] **Step 2: Run it; expect failure**

Run: `pnpm -C apps/web vitest run src/server/services/lots.test.ts`
Expected: FAIL — `Cannot find module './lots'`.

- [ ] **Step 3: Implement the service**

Create `apps/web/src/server/services/lots.ts`:

```typescript
import 'server-only';

import {
  computeLotExpiry,
  expiryBucket,
  sortLotsFefo,
  type ExpiryBucket,
} from '@stockpilot/core';

import { assertModuleEnabled, ServiceError, withContext, type ServiceContext } from './context';

export interface AgingLotRow {
  itemId: string;
  itemName: string;
  sku: string | null;
  lotNumber: string;
  expirationDate: string | null;
  /** Effective expiry (explicit date or received + shelf life), ISO or null. */
  effectiveExpiry: string | null;
  bucket: ExpiryBucket;
  receivedQty: number;
  pickedQty: number;
  /** receivedQty - pickedQty, floored at 0. Approximate unless picks recorded. */
  remaining: number;
}

export interface FefoSuggestion {
  lotNumber: string;
  expirationDate: string | null;
  effectiveExpiry: string | null;
  bucket: ExpiryBucket;
  remaining: number;
  expired: boolean;
  nearExpiry: boolean;
}

export interface LotTraceResult {
  lotNumber: string;
  receipts: Array<{
    receiptNumber: string | null;
    receivedAt: string;
    itemId: string;
    itemName: string;
    qty: number;
    expirationDate: string | null;
  }>;
  picks: Array<{
    orderRequestId: string | null;
    qty: number;
    pickedAt: string;
    pickedBy: string | null;
  }>;
}

interface RawLotRow {
  lot_number: string;
  expiration_date: string | null;
  qty_base: number;
  created_at: string;
  receipt_lines: {
    item_id: string;
    receipts: { organization_id: string; receipt_number?: string | null } | null;
    inventory_items: { name: string; sku: string | null; shelf_life_days: number | null } | null;
  } | null;
}

/**
 * LotsService — food vertical lot/expiry/FEFO read + audit. LIGHT model: NO
 * per-lot stock. `remaining` = received − recorded picks (floored at 0), exact
 * only when picks are recorded via the FEFO action. Gated on `lot_serial`.
 */
export class LotsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new LotsService(await withContext());
  }

  /** Effective "now" — single source so tests/usage stay consistent. */
  private now(): Date {
    return new Date();
  }

  /** Sum recorded picks keyed by `${itemId}::${lotNumber}` (optionally one item). */
  private async pickTotals(itemId?: string): Promise<Map<string, number>> {
    let q = this.ctx.supabase
      .from('lot_pick_events')
      .select('item_id, lot_number, qty')
      .eq('organization_id', this.ctx.organizationId);
    if (itemId) q = q.eq('item_id', itemId);
    const { data, error } = await q;
    if (error) throw new ServiceError('internal_error', error.message);
    const totals = new Map<string, number>();
    for (const r of (data ?? []) as Array<{ item_id: string; lot_number: string; qty: number }>) {
      const key = `${r.item_id}::${r.lot_number}`;
      totals.set(key, (totals.get(key) ?? 0) + Number(r.qty));
    }
    return totals;
  }

  async getAgingInventory(): Promise<AgingLotRow[]> {
    assertModuleEnabled(this.ctx, 'lot_serial');
    // `!inner` on the embeds is REQUIRED for the nested org filter to actually
    // constrain top-level rows (a PostgREST gotcha — without it the filter on an
    // embedded column is a no-op). The user-scoped client also enforces RLS on
    // receipt_line_lots (org membership via the receipts join), so org scoping is
    // belt-and-suspenders. If PostgREST rejects the nested filter at runtime, drop
    // the `.eq(...)` and rely on RLS alone (rows are already org-scoped).
    const { data, error } = await this.ctx.supabase
      .from('receipt_line_lots')
      .select(
        `lot_number, expiration_date, qty_base, created_at,
         receipt_lines:receipt_line_id!inner (
           item_id,
           receipts:receipt_id!inner ( organization_id, receipt_number ),
           inventory_items:item_id ( name, sku, shelf_life_days )
         )`,
      )
      .eq('receipt_lines.receipts.organization_id', this.ctx.organizationId);
    if (error) throw new ServiceError('internal_error', error.message);

    const picks = await this.pickTotals();
    const now = this.now();

    // Aggregate received qty per (item, lot); keep latest item meta + min received date.
    const agg = new Map<string, { row: RawLotRow; received: number; receivedAt: string }>();
    for (const raw of (data ?? []) as RawLotRow[]) {
      const itemId = raw.receipt_lines?.item_id;
      if (!itemId) continue;
      const key = `${itemId}::${raw.lot_number}`;
      const prev = agg.get(key);
      const received = Number(raw.qty_base);
      if (prev) {
        prev.received += received;
        if (raw.created_at < prev.receivedAt) prev.receivedAt = raw.created_at;
      } else {
        agg.set(key, { row: raw, received, receivedAt: raw.created_at });
      }
    }

    const rows: Array<AgingLotRow & { expiry: Date | null }> = [];
    for (const [key, { row, received, receivedAt }] of agg) {
      const itemId = row.receipt_lines!.item_id;
      const item = row.receipt_lines!.inventory_items;
      const pickedQty = picks.get(key) ?? 0;
      const remaining = Math.max(0, received - pickedQty);
      if (remaining <= 0) continue;
      const expiry = computeLotExpiry(
        { expirationDate: row.expiration_date, receivedAt },
        { shelfLifeDays: item?.shelf_life_days ?? null },
      );
      rows.push({
        itemId,
        itemName: item?.name ?? '—',
        sku: item?.sku ?? null,
        lotNumber: row.lot_number,
        expirationDate: row.expiration_date,
        effectiveExpiry: expiry ? expiry.toISOString() : null,
        bucket: expiryBucket(expiry, now),
        receivedQty: received,
        pickedQty,
        remaining,
        expiry,
      });
    }
    return sortLotsFefo(rows).map(({ expiry: _expiry, ...rest }) => rest);
  }

  async getFefoSuggestion(itemId: string): Promise<FefoSuggestion[]> {
    assertModuleEnabled(this.ctx, 'lot_serial');
    const all = await this.getAgingInventory();
    const now = this.now();
    return all
      .filter((r) => r.itemId === itemId)
      .map((r) => {
        const expired = r.bucket === 'expired';
        return {
          lotNumber: r.lotNumber,
          expirationDate: r.expirationDate,
          effectiveExpiry: r.effectiveExpiry,
          bucket: r.bucket,
          remaining: r.remaining,
          expired,
          nearExpiry: expired || r.bucket === 'le7',
        };
      });
  }

  async traceLot(lotNumber: string): Promise<LotTraceResult> {
    assertModuleEnabled(this.ctx, 'lot_serial');
    const term = lotNumber.trim();
    if (!term) throw new ServiceError('validation_error', 'Enter a lot number to trace.');

    const { data: lotRows, error: lotErr } = await this.ctx.supabase
      .from('receipt_line_lots')
      .select(
        `lot_number, expiration_date, qty_base, created_at,
         receipt_lines:receipt_line_id (
           item_id,
           receipts:receipt_id ( organization_id, receipt_number ),
           inventory_items:item_id ( name )
         )`,
      )
      .eq('receipt_lines.receipts.organization_id', this.ctx.organizationId)
      .ilike('lot_number', `%${term}%`);
    if (lotErr) throw new ServiceError('internal_error', lotErr.message);

    const { data: pickRows, error: pickErr } = await this.ctx.supabase
      .from('lot_pick_events')
      .select('order_request_id, qty, picked_at, picked_by, lot_number')
      .eq('organization_id', this.ctx.organizationId)
      .ilike('lot_number', `%${term}%`);
    if (pickErr) throw new ServiceError('internal_error', pickErr.message);

    return {
      lotNumber: term,
      receipts: ((lotRows ?? []) as RawLotRow[]).map((r) => ({
        receiptNumber: r.receipt_lines?.receipts?.receipt_number ?? null,
        receivedAt: r.created_at,
        itemId: r.receipt_lines?.item_id ?? '',
        itemName: (r.receipt_lines?.inventory_items as { name?: string } | null)?.name ?? '—',
        qty: Number(r.qty_base),
        expirationDate: r.expiration_date,
      })),
      picks: ((pickRows ?? []) as Array<{
        order_request_id: string | null; qty: number; picked_at: string; picked_by: string | null;
      }>).map((p) => ({
        orderRequestId: p.order_request_id,
        qty: Number(p.qty),
        pickedAt: p.picked_at,
        pickedBy: p.picked_by,
      })),
    };
  }

  async recordLotPicks(input: {
    orderRequestId: string | null;
    orderRequestLineId: string | null;
    itemId: string;
    picks: Array<{ lotNumber: string; qty: number; expirationDate: string | null }>;
  }): Promise<void> {
    assertModuleEnabled(this.ctx, 'lot_serial');
    const picks = input.picks.filter((p) => p.lotNumber.trim() && p.qty > 0);
    if (picks.length === 0) throw new ServiceError('validation_error', 'No lot picks to record.');

    const { data: item, error: itemErr } = await this.ctx.supabase
      .from('inventory_items')
      .select('expiry_policy, shelf_life_days')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', input.itemId)
      .maybeSingle();
    if (itemErr) throw new ServiceError('internal_error', itemErr.message);
    const policy = (item as { expiry_policy?: string } | null)?.expiry_policy ?? 'warn';
    const shelfLifeDays = (item as { shelf_life_days?: number | null } | null)?.shelf_life_days ?? null;

    if (policy === 'block') {
      const now = this.now();
      for (const p of picks) {
        const expiry = computeLotExpiry(
          { expirationDate: p.expirationDate, receivedAt: now.toISOString() },
          { shelfLifeDays },
        );
        if (expiry && expiry.getTime() <= now.getTime()) {
          throw new ServiceError(
            'validation_error',
            `Lot ${p.lotNumber} is expired and this item blocks picking expired stock.`,
          );
        }
      }
    }

    const { error: insErr } = await this.ctx.supabase.from('lot_pick_events').insert(
      picks.map((p) => ({
        organization_id: this.ctx.organizationId,
        order_request_id: input.orderRequestId,
        order_request_line_id: input.orderRequestLineId,
        item_id: input.itemId,
        lot_number: p.lotNumber.trim(),
        expiration_date: p.expirationDate,
        qty: p.qty,
        picked_by: this.ctx.userId,
      })),
    );
    if (insErr) throw new ServiceError('internal_error', insErr.message);
  }
}
```

- [ ] **Step 4: Run tests + typecheck; expect pass**

Run: `pnpm -C apps/web vitest run src/server/services/lots.test.ts && pnpm -C apps/web tsc --noEmit`
Expected: PASS, tsc clean. (If the `block` test's `computeLotExpiry` of `2000-01-01` doesn't register expired, note the service anchors on the explicit `expirationDate` first — `2000-01-01` is in the past, so it is expired regardless of `receivedAt`.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/services/lots.ts apps/web/src/server/services/lots.test.ts
git commit -m "feat(p5): LotsService — aging, FEFO suggestion, lot trace, recordLotPicks (gated)"
```

---

## Task 5: recordLotPicksAction server action (TDD)

**Files:**
- Create: `apps/web/src/server/actions/lots.ts`
- Test: `apps/web/src/server/actions/lots.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/server/actions/lots.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';

const recordLotPicks = vi.fn();
vi.mock('@/server/services/lots', () => ({
  LotsService: { forCurrentUser: vi.fn(async () => ({ recordLotPicks })) },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { recordLotPicksAction } from './lots';

describe('recordLotPicksAction', () => {
  it('rejects invalid input (no picks)', async () => {
    const res = await recordLotPicksAction({
      orderRequestId: 'o1', orderRequestLineId: 'l1', itemId: 'i1', picks: [],
    });
    expect(res.ok).toBe(false);
  });

  it('delegates to the service and returns ok on success', async () => {
    recordLotPicks.mockResolvedValueOnce(undefined);
    const res = await recordLotPicksAction({
      orderRequestId: 'o1', orderRequestLineId: 'l1', itemId: 'i1',
      picks: [{ lotNumber: 'A', qty: 2, expirationDate: '2026-07-01' }],
    });
    expect(res.ok).toBe(true);
    expect(recordLotPicks).toHaveBeenCalledOnce();
  });

  it('maps a service ServiceError to err', async () => {
    recordLotPicks.mockRejectedValueOnce(
      Object.assign(new Error('blocked'), { name: 'ServiceError', code: 'validation_error' }),
    );
    const res = await recordLotPicksAction({
      orderRequestId: 'o1', orderRequestLineId: 'l1', itemId: 'i1',
      picks: [{ lotNumber: 'A', qty: 1, expirationDate: '2000-01-01' }],
    });
    expect(res.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it; expect failure**

Run: `pnpm -C apps/web vitest run src/server/actions/lots.test.ts`
Expected: FAIL — `Cannot find module './lots'`.

- [ ] **Step 3: Implement**

First confirm the shared result helpers (`ok`/`err`) and the `ServiceError`→result mapper (`toResult`) used by `inventory.ts`:

Run: `grep -n "toResult\|^import\|from '@stockpilot/core'" apps/web/src/server/actions/inventory.ts | head`

Create `apps/web/src/server/actions/lots.ts` (mirror `inventory.ts`'s imports for `ok`/`err`/`ActionResult`; reuse its `toResult` if exported, else inline the `ServiceError` mapping shown):

```typescript
'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { err, ok, type ActionResult } from '@stockpilot/core';
import { LotsService } from '@/server/services/lots';
import { ServiceError } from '@/server/services/context';

const schema = z.object({
  orderRequestId: z.string().uuid().nullable(),
  orderRequestLineId: z.string().uuid().nullable(),
  itemId: z.string().uuid(),
  picks: z
    .array(
      z.object({
        lotNumber: z.string().min(1),
        qty: z.coerce.number().positive(),
        expirationDate: z.string().nullable(),
      }),
    )
    .min(1),
});

export async function recordLotPicksAction(
  input: z.input<typeof schema>,
): Promise<ActionResult<{ recorded: number }>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid lot picks.');
  }
  try {
    const svc = await LotsService.forCurrentUser();
    await svc.recordLotPicks(parsed.data);
    if (parsed.data.orderRequestId) {
      revalidatePath(`/dashboard/orders/${parsed.data.orderRequestId}/pick`);
      revalidatePath(`/dashboard/orders/${parsed.data.orderRequestId}`);
    }
    return ok({ recorded: parsed.data.picks.length });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
```

- [ ] **Step 4: Run tests + typecheck; expect pass**

Run: `pnpm -C apps/web vitest run src/server/actions/lots.test.ts && pnpm -C apps/web tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/actions/lots.ts apps/web/src/server/actions/lots.test.ts
git commit -m "feat(p5): recordLotPicksAction server action (gated via LotsService)"
```

---

## Task 6: InventoryService gate + item-form Lot & expiry section

**Files:**
- Modify: `apps/web/src/server/services/inventory.ts` (`create`, `update`: write new columns + gate)
- Test: `apps/web/src/server/services/inventory.lot-gate.test.ts`
- Modify: `apps/web/src/components/inventory/item-form.tsx` (props, defaults, new section)
- Modify: the 5 `<ItemForm>` callers to pass `lotSerialEnabled`

- [ ] **Step 1: Write the failing service-gate test**

Create `apps/web/src/server/services/inventory.lot-gate.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';
import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { InventoryService } from './inventory';

const withLotSerial = () => new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'lot_serial']);

// A minimal create payload — the gate must fire BEFORE any DB write, so the
// stub returning nulls is fine.
const base = {
  name: 'Milk', unitCost: 0, retailPrice: 0, quantityOnHand: 0, reorderPoint: 0,
  reorderQuantity: 0, unitOfMeasure: 'each', trackingType: 'none' as const,
  itemType: 'product' as const, customFields: {}, status: 'active' as const,
  expiryPolicy: 'warn' as const,
};

describe('InventoryService lot gate', () => {
  it('rejects creating a lot-tracked item when lot_serial is disabled', async () => {
    const stub = makeSupabaseStub({});
    const svc = new InventoryService(makeServiceContext(stub.client)); // no lot_serial
    await expect(svc.create({ ...base, trackingType: 'lot' })).rejects.toMatchObject({
      code: 'module_disabled',
    });
  });

  it('allows tracking_type none when lot_serial is disabled', async () => {
    // create() proceeds past the gate; we only assert the gate does NOT throw.
    // (DB write is stubbed; a downstream null is acceptable for this assertion.)
    const stub = makeSupabaseStub({
      'inventory_items.insert': { data: { id: 'new' }, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));
    // Should not throw module_disabled. Other downstream effects are out of scope.
    await svc.create({ ...base }).catch((e) => {
      expect((e as { code?: string }).code).not.toBe('module_disabled');
    });
  });
});
```

- [ ] **Step 2: Run it; expect failure** (the gate doesn't exist yet — the lot create won't throw `module_disabled`).

Run: `pnpm -C apps/web vitest run src/server/services/inventory.lot-gate.test.ts`
Expected: FAIL on the first test.

- [ ] **Step 3: Add the gate + column writes** in `apps/web/src/server/services/inventory.ts`.

In `create()`, immediately after `assertPermission(this.ctx, 'items:create');`, add:

```typescript
    // Phase 5: lot/serial tracking + shelf-life/expiry are gated behind the
    // lot_serial module. Fail closed — a disabled org cannot make an item
    // lot/serial-tracked or set expiry config.
    if (input.trackingType !== 'none' || input.shelfLifeDays != null) {
      assertModuleEnabled(this.ctx, 'lot_serial');
    }
```

In the `.insert({...})` payload (next to `tracking_type: input.trackingType,`), add:

```typescript
      shelf_life_days: input.shelfLifeDays ?? null,
      expiry_policy: input.expiryPolicy ?? 'warn',
```

In `update()`, after `assertPermission(this.ctx, 'items:update');`, add:

```typescript
    if (
      (patch.trackingType !== undefined && patch.trackingType !== 'none') ||
      patch.shelfLifeDays != null ||
      (patch.expiryPolicy !== undefined && patch.expiryPolicy !== 'warn')
    ) {
      assertModuleEnabled(this.ctx, 'lot_serial');
    }
```

And in the `updates` builder (next to the `trackingType` line):

```typescript
    if (patch.shelfLifeDays !== undefined) updates.shelf_life_days = patch.shelfLifeDays;
    if (patch.expiryPolicy !== undefined) updates.expiry_policy = patch.expiryPolicy;
```

Confirm `assertModuleEnabled` is imported at the top of `inventory.ts` (it imports from `./context`); add it to the import if missing.

- [ ] **Step 4: Run the gate test + typecheck; expect pass**

Run: `pnpm -C apps/web vitest run src/server/services/inventory.lot-gate.test.ts && pnpm -C apps/web tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Add the form section.** In `apps/web/src/components/inventory/item-form.tsx`:

(a) Add to `ItemFormProps`:

```typescript
  /** Phase 5: when true, show the Lot & expiry section (lot_serial module on). */
  lotSerialEnabled?: boolean;
```

(b) Add to the form defaults block (beside `trackingType: defaults?.trackingType ?? 'none',`):

```typescript
      shelfLifeDays: defaults?.shelfLifeDays ?? null,
      expiryPolicy: defaults?.expiryPolicy ?? 'warn',
```

…and add `shelfLifeDays?: number | null; expiryPolicy?: 'none' | 'warn' | 'block';` to the `ItemFormDefaults` interface.

(c) Render the section (replace the removed-radio comment block near line ~1351). Gate on the prop; mirror the existing Item-type `Select` pattern:

```tsx
{lotSerialEnabled && (
  <div className="space-y-3 rounded-md border border-amber-200 bg-amber-50/30 p-3 dark:border-amber-900/40 dark:bg-amber-950/20">
    <div className="space-y-1.5">
      <Label>Lot / serial tracking</Label>
      <Select
        value={watch('trackingType') ?? 'none'}
        onValueChange={(v) =>
          setValue('trackingType', v as 'none' | 'lot' | 'serial', { shouldDirty: true })
        }
      >
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="none">None</SelectItem>
          <SelectItem value="lot">Lot (expiry / FEFO)</SelectItem>
          <SelectItem value="serial">Serial</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-muted-foreground text-[11px]">
        Lot-tracked items capture lot numbers + expiry at receiving and appear in aging / recall reports.
      </p>
    </div>
    {watch('trackingType') === 'lot' && (
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Shelf life (days)</Label>
          <Input
            type="number"
            min={1}
            step={1}
            value={watch('shelfLifeDays') ?? ''}
            onChange={(e) =>
              setValue('shelfLifeDays', e.target.value === '' ? null : Number(e.target.value), {
                shouldDirty: true,
              })
            }
            placeholder="e.g. 30"
          />
          <p className="text-muted-foreground text-[11px]">
            Used to estimate expiry when a lot has no explicit date.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label>Expiry policy</Label>
          <Select
            value={watch('expiryPolicy') ?? 'warn'}
            onValueChange={(v) =>
              setValue('expiryPolicy', v as 'none' | 'warn' | 'block', { shouldDirty: true })
            }
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Track only</SelectItem>
              <SelectItem value="warn">Warn (default)</SelectItem>
              <SelectItem value="block">Block expired picks</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    )}
  </div>
)}
```

Confirm `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem`, `Input`, `Label` are already imported in this file (they are — used elsewhere in the form).

- [ ] **Step 6: Thread `lotSerialEnabled` from the 5 callers.** In each of:
  - `apps/web/src/app/(dashboard)/dashboard/inventory/new/page.tsx`
  - `apps/web/src/app/(dashboard)/dashboard/inventory/[id]/edit/page.tsx`
  - `apps/web/src/app/(dashboard)/dashboard/books/new/page.tsx`
  - `apps/web/src/app/(dashboard)/dashboard/books/[id]/edit/page.tsx`
  - `apps/web/src/app/(dashboard)/dashboard/rentals/items/new/page.tsx`

add the import and read, then pass the prop:

```typescript
import { checkModuleAccess } from '@/lib/modules/module-gate';
// …inside the async server component, near the other awaits:
const { enabled: lotSerialEnabled } = await checkModuleAccess('lot_serial');
// …on the <ItemForm …/> element:
lotSerialEnabled={lotSerialEnabled}
```

For the two **edit** pages, also surface existing values so the form pre-fills: ensure the `defaults` passed to `<ItemForm>` include `shelfLifeDays` + `expiryPolicy` + `trackingType` from the loaded item (add these keys to the `defaults={{…}}` object, reading from the item row — the item query already selects `*` or add `shelf_life_days, expiry_policy, tracking_type` to its select).

(The prop defaults to `false` when omitted, so a missed caller simply hides the section — safe partial rollout.)

- [ ] **Step 7: Typecheck + lint; manual smoke**

Run: `pnpm -C apps/web tsc --noEmit`
Expected: clean. Manual: with `lot_serial` enabled, the New Item form shows the Lot & expiry section; selecting "Lot" reveals shelf-life + policy; saving persists (verify the row has `tracking_type='lot'`). With the module off, the section is hidden and a direct lot-create via the action returns `module_disabled`.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/server/services/inventory.ts apps/web/src/server/services/inventory.lot-gate.test.ts apps/web/src/components/inventory/item-form.tsx "apps/web/src/app/(dashboard)/dashboard/inventory" "apps/web/src/app/(dashboard)/dashboard/books" "apps/web/src/app/(dashboard)/dashboard/rentals"
git commit -m "feat(p5): item-form Lot & expiry section + InventoryService lot_serial gate"
```

---

## Task 7: FEFO picking hint on the pick surface

**Files:**
- Modify: `apps/web/src/server/services/order-requests.ts` (add `tracking_type` to the line select + `OrderRequestLineWithItem.item`)
- Modify: `apps/web/src/app/(dashboard)/dashboard/orders/[id]/pick/page.tsx` (gate-aware FEFO data)
- Create: `apps/web/src/components/orders/fefo-lot-hint.tsx`
- Modify: `apps/web/src/components/orders/digital-pick.tsx` (render the hint per lot-tracked line)

- [ ] **Step 1: Expose `tracking_type` per line.** In `apps/web/src/server/services/order-requests.ts`:

(a) In the `OrderRequestLineWithItem.item` interface (~line 105), add:

```typescript
    tracking_type: string | null;
```

(b) In the `get()` line select (~line 603), add `tracking_type` to the inline `item:inventory_items!item_id (...)` projection:

```typescript
       item:inventory_items!item_id (
         id, name, sku, quantity_on_hand, barcode, model_number, item_type, custom_fields, tracking_type
       )
```

- [ ] **Step 2: Feed FEFO suggestions into the pick page.** In `apps/web/src/app/(dashboard)/dashboard/orders/[id]/pick/page.tsx`, after `detail` is loaded and the status guard passes, compute a per-item suggestion map only when the module is on:

```typescript
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { LotsService } from '@/server/services/lots';
import type { FefoSuggestion } from '@/server/services/lots';
// …
const { enabled: lotSerialEnabled } = await checkModuleAccess('lot_serial');
let fefoByItemId: Record<string, FefoSuggestion[]> = {};
if (lotSerialEnabled) {
  const lotItemIds = Array.from(
    new Set(
      detail.lines
        .filter((l) => l.item?.tracking_type === 'lot')
        .map((l) => l.item!.id),
    ),
  );
  if (lotItemIds.length > 0) {
    const lotsSvc = await LotsService.forCurrentUser();
    const entries = await Promise.all(
      lotItemIds.map(async (id) => [id, await lotsSvc.getFefoSuggestion(id)] as const),
    );
    fefoByItemId = Object.fromEntries(entries);
  }
}
```

Pass to the component:

```tsx
<DigitalPick
  orderId={id}
  initialLines={detail.lines}
  lotSerial={lotSerialEnabled ? { enabled: true, fefoByItemId } : undefined}
/>
```

(Confirm the existing `<DigitalPick>` prop names — `orderId`/`initialLines` — by reading the component head; match them exactly.)

- [ ] **Step 3: Create the hint component.** `apps/web/src/components/orders/fefo-lot-hint.tsx`:

```tsx
'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { BlankZeroNumberInput } from '@/components/ui/blank-zero-number-input';
import { recordLotPicksAction } from '@/server/actions/lots';
import type { FefoSuggestion } from '@/server/services/lots';

const BADGE: Record<string, string> = {
  expired: 'bg-destructive/15 text-destructive',
  le7: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
  le30: 'bg-amber-50 text-amber-700 dark:bg-amber-950/20 dark:text-amber-300',
  le90: 'bg-muted text-muted-foreground',
  ok: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300',
  unknown: 'bg-muted text-muted-foreground',
};

export function FefoLotHint({
  orderId,
  orderLineId,
  itemId,
  suggestions,
}: {
  orderId: string;
  orderLineId: string;
  itemId: string;
  suggestions: FefoSuggestion[];
}) {
  const [qty, setQty] = React.useState<Record<string, number>>({});
  const [saving, setSaving] = React.useState(false);
  if (suggestions.length === 0) {
    return (
      <p className="text-muted-foreground mt-2 text-xs">
        No lots with remaining quantity recorded for this item.
      </p>
    );
  }

  async function record() {
    const picks = suggestions
      .map((s) => ({ lotNumber: s.lotNumber, qty: qty[s.lotNumber] ?? 0, expirationDate: s.expirationDate }))
      .filter((p) => p.qty > 0);
    if (picks.length === 0) {
      toast.error('Enter a quantity for at least one lot.');
      return;
    }
    setSaving(true);
    const res = await recordLotPicksAction({ orderRequestId: orderId, orderRequestLineId: orderLineId, itemId, picks });
    setSaving(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Lot picks recorded.');
    setQty({});
  }

  return (
    <div className="border-border/60 mt-3 rounded-lg border border-dashed p-3">
      <p className="mb-2 text-xs font-medium">Pick earliest-expiry first (FEFO)</p>
      <div className="space-y-2">
        {suggestions.map((s) => (
          <div key={s.lotNumber} className="flex items-center gap-2 text-xs">
            <span className="font-mono">{s.lotNumber}</span>
            <span className={`rounded px-1.5 py-0.5 ${BADGE[s.bucket]}`}>
              {s.effectiveExpiry ? s.effectiveExpiry.slice(0, 10) : 'no date'}
            </span>
            <span className="text-muted-foreground">avail {s.remaining}</span>
            <BlankZeroNumberInput
              min={0}
              max={s.remaining}
              value={qty[s.lotNumber] ?? 0}
              onValueChange={(n) =>
                setQty((m) => ({ ...m, [s.lotNumber]: Math.max(0, Math.min(s.remaining, n)) }))
              }
              className="ml-auto w-20"
              placeholder="0"
            />
          </div>
        ))}
      </div>
      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={record} disabled={saving}>
        {saving ? 'Recording…' : 'Record picked lots'}
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: Render the hint in `digital-pick.tsx`.** Add an optional prop and render `<FefoLotHint>` under each lot-tracked line. In `apps/web/src/components/orders/digital-pick.tsx`:

(a) Import + prop type:

```typescript
import { FefoLotHint } from '@/components/orders/fefo-lot-hint';
import type { FefoSuggestion } from '@/server/services/lots';
```

Add to the component's props interface:

```typescript
  lotSerial?: { enabled: boolean; fefoByItemId: Record<string, FefoSuggestion[]> };
```

(b) Inside the per-line `.map(...)` render, after the quantity input block (still inside the line's container `div`), add:

```tsx
{lotSerial?.enabled && line.item?.tracking_type === 'lot' && (
  <FefoLotHint
    orderId={orderId}
    orderLineId={line.id}
    itemId={line.item.id}
    suggestions={lotSerial.fefoByItemId[line.item.id] ?? []}
  />
)}
```

(Match the actual prop name the component uses for the order id — `orderId` per Step 2; adjust if the component names it differently.)

- [ ] **Step 5: Typecheck + manual smoke**

Run: `pnpm -C apps/web tsc --noEmit`
Expected: clean. Manual: on an order in `pick_slip_generated` with a lot-tracked line (module on), the FEFO hint lists lots earliest-expiry-first with badges; recording picks writes `lot_pick_events` and they appear in the recall report (Task 8). With the module off, no hint renders and the pick page behaves exactly as before.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/services/order-requests.ts apps/web/src/components/orders/fefo-lot-hint.tsx apps/web/src/components/orders/digital-pick.tsx "apps/web/src/app/(dashboard)/dashboard/orders/[id]/pick/page.tsx"
git commit -m "feat(p5): advisory FEFO picking hint on the pick surface (records lot_pick_events)"
```

---

## Task 8: Reports — Aging & expiry + Recall / lot trace

**Files:**
- Create: `apps/web/src/app/(dashboard)/dashboard/reports/lot-expiry/page.tsx`
- Create: `apps/web/src/app/(dashboard)/dashboard/reports/lot-trace/page.tsx`
- Create: `apps/web/src/components/reports/lot-trace-search.tsx` (client search box)
- Create: `apps/web/src/server/actions/lot-trace.ts` (server action backing the search)
- Modify: `apps/web/src/app/(dashboard)/dashboard/reports/page.tsx` (conditional REPORTS entries)

- [ ] **Step 1: Aging & expiry report page.** Create `apps/web/src/app/(dashboard)/dashboard/reports/lot-expiry/page.tsx`:

```tsx
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { LotsService } from '@/server/services/lots';

export const dynamic = 'force-dynamic';

const BUCKET_LABEL: Record<string, string> = {
  expired: 'Expired',
  le7: '≤ 7 days',
  le30: '≤ 30 days',
  le90: '≤ 90 days',
  ok: '> 90 days',
  unknown: 'No date',
};
const BUCKET_ORDER = ['expired', 'le7', 'le30', 'le90', 'ok', 'unknown'] as const;

export default async function LotExpiryReportPage() {
  const access = await checkModuleAccess('lot_serial');
  if (!access.enabled) return <ModuleNotEnabled moduleId="lot_serial" canManage={access.canManage} />;

  const svc = await LotsService.forCurrentUser();
  const rows = await svc.getAgingInventory();
  const counts = BUCKET_ORDER.map((b) => ({
    bucket: b,
    label: BUCKET_LABEL[b],
    count: rows.filter((r) => r.bucket === b).length,
  })).filter((c) => c.count > 0);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <h1 className="font-display text-2xl">Aging &amp; expiry</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Lots with remaining quantity, earliest expiry first. Remaining nets recorded FEFO picks
        out of received quantity.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {counts.map((c) => (
          <span key={c.bucket} className="bg-muted rounded-full px-3 py-1 text-xs">
            {c.label}: <strong>{c.count}</strong>
          </span>
        ))}
      </div>
      <div className="mt-4 overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground text-xs">
            <tr>
              <th className="px-3 py-2 text-left">Item</th>
              <th className="px-3 py-2 text-left">Lot #</th>
              <th className="px-3 py-2 text-left">Expiry</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-right">Remaining</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={5} className="text-muted-foreground px-3 py-6 text-center">No lots on hand.</td></tr>
            )}
            {rows.map((r) => (
              <tr
                key={`${r.itemId}-${r.lotNumber}`}
                className={`border-t ${r.bucket === 'expired' ? 'bg-destructive/5' : r.bucket === 'le7' ? 'bg-amber-50/50 dark:bg-amber-950/10' : ''}`}
              >
                <td className="px-3 py-2">
                  <div>{r.itemName}</div>
                  <div className="text-muted-foreground font-mono text-xs">{r.sku ?? '—'}</div>
                </td>
                <td className="px-3 py-2 font-mono">{r.lotNumber}</td>
                <td className="px-3 py-2">{r.effectiveExpiry ? r.effectiveExpiry.slice(0, 10) : '—'}</td>
                <td className="px-3 py-2">{BUCKET_LABEL[r.bucket]}</td>
                <td className="px-3 py-2 text-right">{r.remaining}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Lot-trace server action.** Create `apps/web/src/server/actions/lot-trace.ts`:

```typescript
'use server';

import { err, ok, type ActionResult } from '@stockpilot/core';
import { LotsService, type LotTraceResult } from '@/server/services/lots';
import { ServiceError } from '@/server/services/context';

export async function traceLotAction(lotNumber: string): Promise<ActionResult<LotTraceResult>> {
  if (!lotNumber?.trim()) return err('validation_error', 'Enter a lot number.');
  try {
    const svc = await LotsService.forCurrentUser();
    return ok(await svc.traceLot(lotNumber));
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
```

- [ ] **Step 3: Lot-trace search (client).** Create `apps/web/src/components/reports/lot-trace-search.tsx`:

```tsx
'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { traceLotAction } from '@/server/actions/lot-trace';
import type { LotTraceResult } from '@/server/services/lots';

export function LotTraceSearch() {
  const [term, setTerm] = React.useState('');
  const [result, setResult] = React.useState<LotTraceResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const res = await traceLotAction(term);
    setLoading(false);
    if (!res.ok) {
      setError(res.error.message);
      setResult(null);
      return;
    }
    setResult(res.data);
  }

  return (
    <div>
      <form onSubmit={run} className="flex gap-2">
        <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Lot number (partial ok)" />
        <Button type="submit" disabled={loading}>{loading ? 'Searching…' : 'Trace'}</Button>
      </form>
      {error && <p className="text-destructive mt-2 text-sm">{error}</p>}
      {result && (
        <div className="mt-4 space-y-4">
          <section>
            <h2 className="text-sm font-medium">Received ({result.receipts.length})</h2>
            <div className="mt-2 overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-muted-foreground text-xs">
                  <tr>
                    <th className="px-3 py-2 text-left">Receipt</th>
                    <th className="px-3 py-2 text-left">Item</th>
                    <th className="px-3 py-2 text-left">Received</th>
                    <th className="px-3 py-2 text-left">Expiry</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {result.receipts.map((r, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-3 py-2 font-mono">{r.receiptNumber ?? '—'}</td>
                      <td className="px-3 py-2">{r.itemName}</td>
                      <td className="px-3 py-2">{r.receivedAt.slice(0, 10)}</td>
                      <td className="px-3 py-2">{r.expirationDate ?? '—'}</td>
                      <td className="px-3 py-2 text-right">{r.qty}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section>
            <h2 className="text-sm font-medium">Picked / shipped ({result.picks.length})</h2>
            <div className="mt-2 overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-muted-foreground text-xs">
                  <tr>
                    <th className="px-3 py-2 text-left">Order</th>
                    <th className="px-3 py-2 text-left">When</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {result.picks.length === 0 && (
                    <tr><td colSpan={3} className="text-muted-foreground px-3 py-4 text-center">No recorded picks.</td></tr>
                  )}
                  {result.picks.map((p, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-3 py-2 font-mono">{p.orderRequestId ? p.orderRequestId.slice(0, 8).toUpperCase() : '—'}</td>
                      <td className="px-3 py-2">{p.pickedAt.slice(0, 10)}</td>
                      <td className="px-3 py-2 text-right">{p.qty}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Lot-trace report page.** Create `apps/web/src/app/(dashboard)/dashboard/reports/lot-trace/page.tsx`:

```tsx
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { LotTraceSearch } from '@/components/reports/lot-trace-search';

export const dynamic = 'force-dynamic';

export default async function LotTraceReportPage() {
  const access = await checkModuleAccess('lot_serial');
  if (!access.enabled) return <ModuleNotEnabled moduleId="lot_serial" canManage={access.canManage} />;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <h1 className="font-display text-2xl">Recall / lot trace</h1>
      <p className="text-muted-foreground mt-1 mb-4 text-sm">
        Enter a lot number to see every receipt it came in on and every order it was picked into.
      </p>
      <LotTraceSearch />
    </div>
  );
}
```

- [ ] **Step 5: Conditionally list the two reports.** In `apps/web/src/app/(dashboard)/dashboard/reports/page.tsx`, the page is already an async server component using `requireOrgContext`. Add a module read and append the two entries only when enabled:

```typescript
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { CalendarClock, Recycle } from 'lucide-react'; // add to the existing lucide import
// …inside the component, after the base REPORTS array is in scope:
const { enabled: lotSerialEnabled } = await checkModuleAccess('lot_serial');
const reports: Report[] = lotSerialEnabled
  ? [
      ...REPORTS,
      { slug: 'lot-expiry', name: 'Aging & expiry', desc: 'Lots by days-to-expiry · near-expiry & expired flagged', icon: CalendarClock },
      { slug: 'lot-trace', name: 'Recall / lot trace', desc: 'Trace a lot number across receipts + picks', icon: Recycle },
    ]
  : REPORTS;
// …then map over `reports` instead of `REPORTS` in the JSX.
```

(If the component currently maps directly over the module-level `REPORTS` constant, switch the `.map` source to the local `reports` variable. Confirm `CalendarClock`/`Recycle` exist in `lucide-react`; if not, reuse `Clock` and `AlertTriangle` already imported.)

- [ ] **Step 6: Typecheck + manual smoke**

Run: `pnpm -C apps/web tsc --noEmit`
Expected: clean. Manual: with `lot_serial` on, `/dashboard/reports` lists the two new reports; the aging page buckets lots and highlights expired/≤7d; the trace page returns receipts + picks for a known lot. With the module off, neither report is listed, and visiting the URLs directly renders `ModuleNotEnabled`.

- [ ] **Step 7: Commit**

```bash
git add "apps/web/src/app/(dashboard)/dashboard/reports/lot-expiry" "apps/web/src/app/(dashboard)/dashboard/reports/lot-trace" apps/web/src/components/reports/lot-trace-search.tsx apps/web/src/server/actions/lot-trace.ts "apps/web/src/app/(dashboard)/dashboard/reports/page.tsx"
git commit -m "feat(p5): aging/expiry + recall/lot-trace reports (module-gated)"
```

---

## Final verification (whole branch)

- [ ] **Step 1: Full typecheck**

Run: `pnpm -C packages/core tsc --noEmit && pnpm -C apps/web tsc --noEmit`
Expected: both clean.

- [ ] **Step 2: Full test suites (both packages)**

Run: `pnpm -C packages/core vitest run && pnpm -C apps/web vitest run`
Expected: all green — new suites (`expiry`, `lots` service, `lots` action, `inventory.lot-gate`) pass; no regression in existing suites.

- [ ] **Step 3: Lint**

Run: `pnpm -C apps/web lint` (confirm the exact lint script in `apps/web/package.json`).
Expected: clean (or only pre-existing warnings).

- [ ] **Step 4: Spec/plan coverage self-check** — confirm each spec section maps to a task: module gate (T1), expiry columns (T1/T3), `lot_pick_events` (T1), core helpers (T2), LotsService (T4), recordLotPicks action (T5), item-form control + service gate (T6), FEFO hint (T7), reports (T8). No gaps.

- [ ] **Step 5: Hand back to finishing-a-development-branch** — request code review (`superpowers:requesting-code-review`), then merge `phase5-lot-expiry-fefo` → `main` and push (Vercel deploys web). **No mobile changes → no OTA.** Flag migration 0162 as the prod controller step. Update memory `project_platform_program_progress`.

---

## Notes & known v1 limitations (carry to memory on ship)
- **`remaining` is approximate** — exact only when picks are recorded via the FEFO action; otherwise it equals received qty. Documented in the aging report copy. A true per-lot ledger is an explicit out-of-scope follow-on.
- **No per-lot stock** — aggregate `quantity_on_hand`/`adjust_stock`/cycle-count/returns invariants untouched, by design.
- **Web only** — mobile lot capture + iOS OTA is a follow-on; apparel variants (color + per-variant barcode) is Phase 5b; ag harvest-lot is Phase 5 v2.
- **`expiry_policy='block'`** only hard-stops recording a FEFO pick of an expired lot; it does not block receiving or any stock movement.
