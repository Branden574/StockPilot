# Phase 6 v1 — Google Books price monitoring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Pull real list/retail price + metadata for book items from the free Google Books API (matched by ISBN in `barcode`), gated behind an off-by-default `price_tracking` module; on-demand + daily cron; books-only, web-only.

**Architecture:** A pure core parser + an ISBN pre-filter; a stateless Google Books client; ONE shared `recordBookObservation` / `refreshBookPricesForOrg` used by both the user-scoped service (on-demand, RLS) and the service-role cron (cross-org); an append-only `item_price_observations` table; a module-gated item-detail panel + Books-page bulk button. No per-org connection/Vault (free source). No mutation of `inventory_items`.

**Tech Stack:** Next.js (RSC + server actions + cron route), Supabase (Postgres + RLS), TypeScript, vitest, zod, `@stockpilot/core`.

**Spec:** [`docs/superpowers/specs/2026-06-01-phase6-price-tracking-design.md`](../specs/2026-06-01-phase6-price-tracking-design.md)

**Conventions (reuse):**
- Service class: `constructor(private readonly ctx: ServiceContext)`, `static forCurrentUser(){ return new X(await withContext()) }`, gate `assertModuleEnabled(this.ctx,'price_tracking')` + `assertPermission(this.ctx,'items:update')`, query `.eq('organization_id', this.ctx.organizationId)`, throw `ServiceError`.
- Action: `'use server'`, zod `safeParse`→`err`, `try { ok(...) } catch(e){ e instanceof ServiceError ? err(e.code,e.message) : err('internal_error',...) }`. `ok`/`err`/`ActionResult` from `@stockpilot/core`.
- Page gate: `const a = await checkModuleAccess('price_tracking'); if(!a.enabled) ...`.
- Cron: copy `apps/web/src/app/api/cron/drain-outbox/route.ts` header — `runtime='nodejs'`, `dynamic='force-dynamic'`, `maxDuration=60`, `secretsEqual(auth, 'Bearer '+env.CRON_SECRET)` fail-closed when `!env.CRON_SECRET`; `createAdminClient()` from `@/lib/supabase/admin`; `env` from `@/lib/env`; `reportError` from `@/lib/error-reporter`.
- Tests: `import { describe, expect, it, vi } from 'vitest'`; `makeServiceContext(stub.client,{enabledModules})` / `makeSupabaseStub({'table.op':{data,error}})` from `@/test/supabase-mock`. Default `enabledModules = DEFAULT_MODULE_IDS` (does NOT include `price_tracking`), so the default context THROWS on the gate; pass `new Set([...DEFAULT_MODULE_IDS,'price_tracking'])` for happy paths.
- Run: `cd apps/web && pnpm vitest run <path>` / `pnpm tsc --noEmit`; `cd packages/core && pnpm vitest run` / `pnpm tsc --noEmit`.

---

## Task 1: Migration 0163 + module registry + env

**Files:**
- Create: `supabase/migrations/0163_price_tracking_module_observations.sql`
- Modify: `packages/core/src/modules/registry.ts` (ModuleId union + MODULE_REGISTRY entry)
- Modify: `apps/web/src/lib/env.ts` (`GOOGLE_BOOKS_API_KEY`)

- [ ] **Step 1: Read 0162** so `seed_org_modules()` stays byte-identical plus the appended row: `sed -n '1,80p' supabase/migrations/0162_lot_serial_module_expiry.sql`.

- [ ] **Step 2: Write the migration.** Create `supabase/migrations/0163_price_tracking_module_observations.sql`:

```sql
-- ============================================================================
-- 0163_price_tracking_module_observations.sql
-- Phase 6 v1 — Google Books price monitoring.
-- 1) Grandfather the optional 'price_tracking' module OFF for existing orgs.
-- 2) Re-seed new orgs with it present-but-OFF.
-- 3) item_price_observations — append-only price/metadata history (RLS).
-- ============================================================================

set check_function_bodies = off;

-- ── 1) Grandfather existing orgs: 'price_tracking' OFF ──────────────────────
insert into public.organization_modules (organization_id, module_id, enabled, tier, enabled_at)
select o.id, 'price_tracking', false, 'optional', now()
from public.organizations o
on conflict (organization_id, module_id) do nothing;

-- ── 2) New-org seed: byte-identical to 0162 + 'price_tracking' optional OFF ──
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
    ('planning','optional', false),
    ('lot_serial','premium', false),
    -- net-new opt-in optional (OFF)
    ('price_tracking','optional', false)
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

-- ── 3) item_price_observations (append-only history) ────────────────────────
create table if not exists public.item_price_observations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  item_id          uuid not null references public.inventory_items(id) on delete cascade,
  source           text not null default 'google_books',
  isbn             text,
  list_price       numeric(12,2),
  retail_price     numeric(12,2),
  currency         text,
  title            text,
  authors          text,
  average_rating   numeric(3,2),
  ratings_count    integer,
  categories       text,
  thumbnail_url    text,
  info_link        text,
  saleability      text,
  observed_at      timestamptz not null default now()
);

create index if not exists item_price_observations_item_idx
  on public.item_price_observations (organization_id, item_id, observed_at desc);

alter table public.item_price_observations enable row level security;

drop policy if exists item_price_observations_select on public.item_price_observations;
create policy item_price_observations_select on public.item_price_observations
  for select using (
    exists (
      select 1 from public.organization_members m
      where m.user_id = auth.uid()
        and m.organization_id = item_price_observations.organization_id
        and m.accepted_at is not null
    )
  );

drop policy if exists item_price_observations_write on public.item_price_observations;
create policy item_price_observations_write on public.item_price_observations
  for all using (public.has_org_role(organization_id, 'manager'));
```

- [ ] **Step 3: Register the module.** In `packages/core/src/modules/registry.ts`:
  - Add `'price_tracking'` to the `ModuleId` union (line ~33, append to the premium-ish list: `... | 'api_access' | 'price_tracking';`).
  - Add a `MODULE_REGISTRY` entry (place near the other optional modules, after `planning` or before the premium block):

```typescript
  price_tracking: {
    id: 'price_tracking',
    tier: 'optional',
    title: 'Price monitoring',
    dependsOn: ['inventory'],
    permissions: [],
    surfaces: ['web'],
    apiPrefixes: [],
    ownsTables: ['item_price_observations'],
    minPlan: 'free',
    defaultOnFor: [],
    placements: [],
  },
```

  (Match the exact `ModuleDefinition` shape used by sibling entries — copy a neighbor's field set; `minPlan` only if the type requires it. If `minPlan` isn't on optional entries elsewhere, omit it to match.)

- [ ] **Step 4: Add the env var.** In `apps/web/src/lib/env.ts` `serverSchema`, add beside the other optional secrets:

```typescript
  GOOGLE_BOOKS_API_KEY: optionalSecret.transform((s) => s.trim()),
```

- [ ] **Step 5: Verify + commit**

Run: `cd packages/core && pnpm tsc --noEmit && pnpm vitest run` (registry/resolver tests still green) and `cd apps/web && pnpm tsc --noEmit`.
Expected: clean.

```bash
git add supabase/migrations/0163_price_tracking_module_observations.sql packages/core/src/modules/registry.ts apps/web/src/lib/env.ts
git commit -m "feat(p6): migration 0163 — price_tracking module grandfather OFF + item_price_observations + env"
```

---

## Task 2: Core — ISBN pre-filter + Google Books parser (pure, TDD)

**Files:**
- Create: `packages/core/src/pricing/google-books.ts`
- Test: `packages/core/src/pricing/google-books.test.ts`
- Modify: `packages/core/src/index.ts` (`export * from './pricing/google-books';`)

- [ ] **Step 1: Write the failing test.** Create `packages/core/src/pricing/google-books.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { isLikelyIsbn, parseGoogleBooksVolume } from './google-books';

describe('isLikelyIsbn', () => {
  it('accepts 13- and 10-digit ISBNs with/without hyphens', () => {
    expect(isLikelyIsbn('9780306406157')).toBe(true);
    expect(isLikelyIsbn('978-0-306-40615-7')).toBe(true);
    expect(isLikelyIsbn('0306406152')).toBe(true);
    expect(isLikelyIsbn('0-306-40615-2')).toBe(true);
  });
  it('rejects non-ISBN barcodes and empties', () => {
    expect(isLikelyIsbn('ABC123')).toBe(false);
    expect(isLikelyIsbn('12345')).toBe(false);
    expect(isLikelyIsbn('')).toBe(false);
    expect(isLikelyIsbn(null)).toBe(false);
  });
});

describe('parseGoogleBooksVolume', () => {
  it('extracts price + metadata from a priced volume', () => {
    const json = {
      items: [
        {
          volumeInfo: {
            title: 'Test Book',
            authors: ['Jane Doe', 'John Roe'],
            averageRating: 4.5,
            ratingsCount: 12,
            categories: ['Fiction'],
            imageLinks: { thumbnail: 'http://img/x' },
            infoLink: 'http://books/x',
          },
          saleInfo: {
            saleability: 'FOR_SALE',
            listPrice: { amount: 19.99, currencyCode: 'USD' },
            retailPrice: { amount: 14.99, currencyCode: 'USD' },
          },
        },
      ],
    };
    const got = parseGoogleBooksVolume(json);
    expect(got).toMatchObject({
      title: 'Test Book',
      authors: 'Jane Doe, John Roe',
      listPrice: 19.99,
      retailPrice: 14.99,
      currency: 'USD',
      averageRating: 4.5,
      ratingsCount: 12,
      categories: 'Fiction',
      thumbnailUrl: 'http://img/x',
      infoLink: 'http://books/x',
      saleability: 'FOR_SALE',
    });
  });
  it('returns metadata with null prices when not for sale', () => {
    const json = { items: [{ volumeInfo: { title: 'NoSale' }, saleInfo: { saleability: 'NOT_FOR_SALE' } }] };
    const got = parseGoogleBooksVolume(json);
    expect(got).toMatchObject({ title: 'NoSale', listPrice: null, retailPrice: null, saleability: 'NOT_FOR_SALE' });
  });
  it('returns null when there are no items', () => {
    expect(parseGoogleBooksVolume({ totalItems: 0, items: [] })).toBeNull();
    expect(parseGoogleBooksVolume({})).toBeNull();
  });
});
```

- [ ] **Step 2: Run; expect FAIL** — `cd packages/core && pnpm vitest run src/pricing/google-books.test.ts` → cannot find module.

- [ ] **Step 3: Implement.** Create `packages/core/src/pricing/google-books.ts`:

```typescript
/**
 * Pure helpers for Google Books price monitoring (Phase 6). No I/O.
 */

export interface ParsedBookObservation {
  listPrice: number | null;
  retailPrice: number | null;
  currency: string | null;
  title: string | null;
  authors: string | null;
  averageRating: number | null;
  ratingsCount: number | null;
  categories: string | null;
  thumbnailUrl: string | null;
  infoLink: string | null;
  saleability: string | null;
}

/** Cheap pre-filter: true iff the barcode is a 10- or 13-digit ISBN (hyphens/spaces ok). */
export function isLikelyIsbn(barcode: string | null | undefined): boolean {
  if (!barcode) return false;
  const digits = barcode.replace(/[\s-]/g, '');
  return /^[0-9]{13}$/.test(digits) || /^[0-9]{9}[0-9Xx]$/.test(digits);
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Parse a Google Books `volumes` response → the first item's price + metadata, or null. */
export function parseGoogleBooksVolume(json: unknown): ParsedBookObservation | null {
  const items = (json as { items?: unknown[] } | null)?.items;
  if (!Array.isArray(items) || items.length === 0) return null;
  const item = items[0] as {
    volumeInfo?: {
      title?: string;
      authors?: string[];
      averageRating?: number;
      ratingsCount?: number;
      categories?: string[];
      imageLinks?: { thumbnail?: string };
      infoLink?: string;
    };
    saleInfo?: {
      saleability?: string;
      listPrice?: { amount?: number; currencyCode?: string };
      retailPrice?: { amount?: number; currencyCode?: string };
    };
  };
  const vi = item.volumeInfo ?? {};
  const si = item.saleInfo ?? {};
  return {
    listPrice: num(si.listPrice?.amount),
    retailPrice: num(si.retailPrice?.amount),
    currency: si.retailPrice?.currencyCode ?? si.listPrice?.currencyCode ?? null,
    title: vi.title ?? null,
    authors: Array.isArray(vi.authors) && vi.authors.length ? vi.authors.join(', ') : null,
    averageRating: num(vi.averageRating),
    ratingsCount: num(vi.ratingsCount) === null ? null : Math.trunc(num(vi.ratingsCount) as number),
    categories: Array.isArray(vi.categories) && vi.categories.length ? vi.categories.join(', ') : null,
    thumbnailUrl: vi.imageLinks?.thumbnail ?? null,
    infoLink: vi.infoLink ?? null,
    saleability: si.saleability ?? null,
  };
}
```

- [ ] **Step 4: Barrel export** — append to `packages/core/src/index.ts`: `export * from './pricing/google-books';`

- [ ] **Step 5: Verify + commit** — `cd packages/core && pnpm vitest run src/pricing/google-books.test.ts && pnpm tsc --noEmit` → PASS/clean.

```bash
git add packages/core/src/pricing/google-books.ts packages/core/src/pricing/google-books.test.ts packages/core/src/index.ts
git commit -m "feat(p6-core): pure isLikelyIsbn + parseGoogleBooksVolume helpers"
```

---

## Task 3: Google Books client + PriceTrackingService (gated; TDD)

**Files:**
- Create: `apps/web/src/server/pricing/google-books-client.ts`
- Create: `apps/web/src/server/services/price-tracking.ts`
- Test: `apps/web/src/server/services/price-tracking.test.ts`

- [ ] **Step 1: Client.** Create `apps/web/src/server/pricing/google-books-client.ts`:

```typescript
import 'server-only';

import { env } from '@/lib/env';

export interface GoogleBooksClient {
  fetchVolumeByIsbn(isbn: string): Promise<unknown | null>;
}

/**
 * Stateless Google Books client. Free endpoint; `country=US` so saleInfo
 * prices are returned; optional API key (env.GOOGLE_BOOKS_API_KEY) raises
 * quota. Returns parsed JSON, or null on any non-200 (incl. 429) — a pull
 * miss is never a hard failure.
 */
export const googleBooksClient: GoogleBooksClient = {
  async fetchVolumeByIsbn(isbn: string): Promise<unknown | null> {
    const digits = isbn.replace(/[\s-]/g, '');
    const params = new URLSearchParams({ q: `isbn:${digits}`, country: 'US' });
    if (env.GOOGLE_BOOKS_API_KEY) params.set('key', env.GOOGLE_BOOKS_API_KEY);
    try {
      const res = await fetch(`https://www.googleapis.com/books/v1/volumes?${params.toString()}`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        console.warn(`[google-books] ${res.status} for isbn ${digits}`);
        return null;
      }
      return (await res.json()) as unknown;
    } catch (e) {
      console.warn('[google-books] fetch failed', e);
      return null;
    }
  },
};
```

- [ ] **Step 2: Write the failing service test.** Create `apps/web/src/server/services/price-tracking.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';
import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { PriceTrackingService, recordBookObservation } from './price-tracking';

const withPT = () => new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'price_tracking']);
const fakeClient = (json: unknown) => ({ fetchVolumeByIsbn: vi.fn(async () => json) });
const PRICED = {
  items: [{ volumeInfo: { title: 'B' }, saleInfo: { saleability: 'FOR_SALE', listPrice: { amount: 9.99, currencyCode: 'USD' }, retailPrice: { amount: 7.99, currencyCode: 'USD' } } }],
};

describe('PriceTrackingService gate', () => {
  it('throws module_disabled when price_tracking is off', async () => {
    const stub = makeSupabaseStub({});
    const svc = new PriceTrackingService(makeServiceContext(stub.client)); // no price_tracking
    await expect(svc.fetchItemPrice('item-1')).rejects.toMatchObject({ code: 'module_disabled' });
  });
});

describe('recordBookObservation', () => {
  it('writes an observation for an ISBN item with data', async () => {
    const stub = makeSupabaseStub({ 'item_price_observations.insert': { data: null, error: null } });
    const wrote = await recordBookObservation(
      stub.client, 'org-1', { id: 'i1', barcode: '9780306406157' }, fakeClient(PRICED),
    );
    expect(wrote).toBe(true);
    expect(stub.fromCalls).toContain('item_price_observations');
  });
  it('skips a non-ISBN barcode (no fetch, no write)', async () => {
    const stub = makeSupabaseStub({});
    const client = fakeClient(PRICED);
    const wrote = await recordBookObservation(stub.client, 'org-1', { id: 'i1', barcode: 'NOTISBN' }, client);
    expect(wrote).toBe(false);
    expect(client.fetchVolumeByIsbn).not.toHaveBeenCalled();
  });
  it('skips when the API returns no data', async () => {
    const stub = makeSupabaseStub({});
    const wrote = await recordBookObservation(stub.client, 'org-1', { id: 'i1', barcode: '9780306406157' }, fakeClient(null));
    expect(wrote).toBe(false);
  });
});

describe('PriceTrackingService.fetchItemPrice', () => {
  it('records + returns the latest observation for an enabled org', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: { id: 'i1', barcode: '9780306406157' }, error: null },
      'item_price_observations.insert': { data: null, error: null },
      'item_price_observations.select': { data: { item_id: 'i1', list_price: 9.99, retail_price: 7.99, currency: 'USD' }, error: null },
    });
    const svc = new PriceTrackingService(makeServiceContext(stub.client, { enabledModules: withPT() }), fakeClient(PRICED));
    const res = await svc.fetchItemPrice('i1');
    expect(res?.retail_price).toBe(7.99);
  });
});
```

- [ ] **Step 3: Run; expect FAIL** — `cd apps/web && pnpm vitest run src/server/services/price-tracking.test.ts`.

- [ ] **Step 4: Implement.** Create `apps/web/src/server/services/price-tracking.ts`:

```typescript
import 'server-only';

import { isLikelyIsbn, parseGoogleBooksVolume } from '@stockpilot/core';

import { assertModuleEnabled, assertPermission, ServiceError, withContext, type ServiceContext } from './context';
import { googleBooksClient, type GoogleBooksClient } from '@/server/pricing/google-books-client';

export interface PriceObservationRow {
  item_id: string;
  isbn: string | null;
  list_price: number | null;
  retail_price: number | null;
  currency: string | null;
  title: string | null;
  authors: string | null;
  average_rating: number | null;
  thumbnail_url: string | null;
  info_link: string | null;
  saleability: string | null;
  observed_at: string;
}

interface BookItem {
  id: string;
  barcode: string | null;
}

/**
 * Fetch one item's Google Books data (if its barcode is an ISBN) and insert an
 * observation. Works with ANY supabase client — the user-scoped one (on-demand,
 * RLS) or the service-role admin client (cron). Returns whether a row was written.
 */
export async function recordBookObservation(
  supabase: { from: (t: string) => any },
  orgId: string,
  item: BookItem,
  client: GoogleBooksClient,
): Promise<boolean> {
  if (!isLikelyIsbn(item.barcode)) return false;
  const json = await client.fetchVolumeByIsbn(item.barcode as string);
  const parsed = parseGoogleBooksVolume(json);
  if (!parsed) return false;
  const { error } = await supabase.from('item_price_observations').insert({
    organization_id: orgId,
    item_id: item.id,
    source: 'google_books',
    isbn: (item.barcode as string).replace(/[\s-]/g, ''),
    list_price: parsed.listPrice,
    retail_price: parsed.retailPrice,
    currency: parsed.currency,
    title: parsed.title,
    authors: parsed.authors,
    average_rating: parsed.averageRating,
    ratings_count: parsed.ratingsCount,
    categories: parsed.categories,
    thumbnail_url: parsed.thumbnailUrl,
    info_link: parsed.infoLink,
    saleability: parsed.saleability,
  });
  if (error) throw new ServiceError('internal_error', error.message);
  return true;
}

const RECENT_MS = 20 * 60 * 60 * 1000; // skip items observed within ~20h
const DEFAULT_LIMIT = 300;

/**
 * Batch-refresh book prices for one org. Client-agnostic (cron passes the admin
 * client; the service passes ctx.supabase). Pages active book items with an
 * ISBN-ish barcode, skips recently-observed, throttles, caps at `limit`.
 */
export async function refreshBookPricesForOrg(
  supabase: { from: (t: string) => any },
  orgId: string,
  client: GoogleBooksClient,
  opts: { limit?: number } = {},
): Promise<{ scanned: number; written: number; skipped: number }> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const { data: items, error } = await supabase
    .from('inventory_items')
    .select('id, barcode')
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .eq('status', 'active')
    .eq('item_type', 'book')
    .not('barcode', 'is', null)
    .limit(limit);
  if (error) throw new ServiceError('internal_error', error.message);

  // Recently-observed item ids (one query) to skip.
  const sinceIso = new Date(Date.now() - RECENT_MS).toISOString();
  const { data: recent } = await supabase
    .from('item_price_observations')
    .select('item_id')
    .eq('organization_id', orgId)
    .gte('observed_at', sinceIso);
  const recentIds = new Set((recent ?? []).map((r: { item_id: string }) => r.item_id));

  let written = 0;
  let skipped = 0;
  const list = (items ?? []) as BookItem[];
  for (const item of list) {
    if (recentIds.has(item.id) || !isLikelyIsbn(item.barcode)) {
      skipped += 1;
      continue;
    }
    const ok = await recordBookObservation(supabase, orgId, item, client);
    if (ok) written += 1;
    else skipped += 1;
    await new Promise((r) => setTimeout(r, 120)); // gentle throttle for Google's quota
  }
  return { scanned: list.length, written, skipped };
}

/**
 * PriceTrackingService — user-scoped (RLS) on-demand price pulls. Gated on the
 * price_tracking module + items:update. Delegates fetch/persist to the shared
 * helpers so the cron and the UI share one source of truth.
 */
export class PriceTrackingService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly client: GoogleBooksClient = googleBooksClient,
  ) {}

  static async forCurrentUser() {
    return new PriceTrackingService(await withContext());
  }

  async fetchItemPrice(itemId: string): Promise<PriceObservationRow | null> {
    assertModuleEnabled(this.ctx, 'price_tracking');
    assertPermission(this.ctx, 'items:update');
    const { data: item, error } = await this.ctx.supabase
      .from('inventory_items')
      .select('id, barcode')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', itemId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!item) throw new ServiceError('not_found', 'Item not found.');
    await recordBookObservation(this.ctx.supabase, this.ctx.organizationId, item as BookItem, this.client);
    return this.getLatestObservation(itemId);
  }

  async refreshOrgBookPrices(opts: { limit?: number } = {}) {
    assertModuleEnabled(this.ctx, 'price_tracking');
    assertPermission(this.ctx, 'items:update');
    return refreshBookPricesForOrg(this.ctx.supabase, this.ctx.organizationId, this.client, opts);
  }

  async getLatestObservation(itemId: string): Promise<PriceObservationRow | null> {
    assertModuleEnabled(this.ctx, 'price_tracking');
    const { data, error } = await this.ctx.supabase
      .from('item_price_observations')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('item_id', itemId)
      .order('observed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    return (data as PriceObservationRow | null) ?? null;
  }
}
```

- [ ] **Step 5: Verify + commit** — `cd apps/web && pnpm vitest run src/server/services/price-tracking.test.ts && pnpm tsc --noEmit` → PASS/clean.

```bash
git add apps/web/src/server/pricing/google-books-client.ts apps/web/src/server/services/price-tracking.ts apps/web/src/server/services/price-tracking.test.ts
git commit -m "feat(p6): GoogleBooksClient + PriceTrackingService (shared recordBookObservation/refreshBookPricesForOrg)"
```

---

## Task 4: Actions (TDD)

**Files:**
- Create: `apps/web/src/server/actions/price-tracking.ts`
- Test: `apps/web/src/server/actions/price-tracking.test.ts`

- [ ] **Step 1: Write the failing test.** Create `apps/web/src/server/actions/price-tracking.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';

const fetchItemPrice = vi.fn();
const refreshOrgBookPrices = vi.fn();
vi.mock('@/server/services/price-tracking', () => ({
  PriceTrackingService: { forCurrentUser: vi.fn(async () => ({ fetchItemPrice, refreshOrgBookPrices })) },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { fetchItemPriceAction, refreshBookPricesAction } from './price-tracking';

describe('price-tracking actions', () => {
  it('fetchItemPriceAction rejects a missing id', async () => {
    const res = await fetchItemPriceAction('');
    expect(res.ok).toBe(false);
  });
  it('fetchItemPriceAction returns ok on success', async () => {
    fetchItemPrice.mockResolvedValueOnce({ item_id: 'i1', retail_price: 7.99 });
    const res = await fetchItemPriceAction('i1');
    expect(res.ok).toBe(true);
  });
  it('refreshBookPricesAction returns the summary', async () => {
    refreshOrgBookPrices.mockResolvedValueOnce({ scanned: 5, written: 3, skipped: 2 });
    const res = await refreshBookPricesAction();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.written).toBe(3);
  });
});
```

- [ ] **Step 2: Run; expect FAIL.**

- [ ] **Step 3: Implement.** Create `apps/web/src/server/actions/price-tracking.ts`:

```typescript
'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { err, ok, type ActionResult } from '@stockpilot/core';
import { PriceTrackingService, type PriceObservationRow } from '@/server/services/price-tracking';
import { ServiceError } from '@/server/services/context';

export async function fetchItemPriceAction(itemId: string): Promise<ActionResult<PriceObservationRow | null>> {
  if (!z.string().min(1).safeParse(itemId).success) return err('validation_error', 'Missing item id.');
  try {
    const svc = await PriceTrackingService.forCurrentUser();
    const obs = await svc.fetchItemPrice(itemId);
    revalidatePath(`/dashboard/inventory/${itemId}`);
    return ok(obs);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

export async function refreshBookPricesAction(): Promise<ActionResult<{ scanned: number; written: number; skipped: number }>> {
  try {
    const svc = await PriceTrackingService.forCurrentUser();
    const summary = await svc.refreshOrgBookPrices();
    revalidatePath('/dashboard/books');
    return ok(summary);
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
```

- [ ] **Step 4: Verify + commit** — `cd apps/web && pnpm vitest run src/server/actions/price-tracking.test.ts && pnpm tsc --noEmit`.

```bash
git add apps/web/src/server/actions/price-tracking.ts apps/web/src/server/actions/price-tracking.test.ts
git commit -m "feat(p6): price-tracking server actions (fetchItemPrice, refreshBookPrices)"
```

---

## Task 5: Daily cron

**Files:**
- Create: `apps/web/src/app/api/cron/price-pull/route.ts`
- Modify: `apps/web/vercel.json` (add the cron schedule)

- [ ] **Step 1: Read the drain-outbox route** for the exact auth header pattern: `sed -n '1,170p' apps/web/src/app/api/cron/drain-outbox/route.ts`.

- [ ] **Step 2: Implement the cron.** Create `apps/web/src/app/api/cron/price-pull/route.ts`:

```typescript
import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { googleBooksClient } from '@/server/pricing/google-books-client';
import { refreshBookPricesForOrg } from '@/server/services/price-tracking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Daily Google Books price pull for every org with the price_tracking module enabled. */
export async function GET(req: Request) {
  if (!env.CRON_SECRET) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 503 });
  }
  const auth = req.headers.get('authorization') ?? '';
  if (!secretsEqual(auth, `Bearer ${env.CRON_SECRET}`)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: rows, error } = await admin
    .from('organization_modules')
    .select('organization_id')
    .eq('module_id', 'price_tracking')
    .eq('enabled', true);
  if (error) {
    void reportError(new Error(`price-pull org list: ${error.message}`), { tag: 'cron.price-pull' });
    return NextResponse.json({ error: 'org_list_failed' }, { status: 500 });
  }

  const orgIds = Array.from(new Set((rows ?? []).map((r) => r.organization_id as string)));
  const results: Array<{ orgId: string; scanned: number; written: number; skipped: number }> = [];
  for (const orgId of orgIds) {
    try {
      const r = await refreshBookPricesForOrg(admin, orgId, googleBooksClient);
      results.push({ orgId, ...r });
    } catch (e) {
      // FAIL-OPEN per org: report and continue; one org must not 500 the cron.
      void reportError(e, { tag: 'cron.price-pull', extra: { orgId } });
    }
  }
  return NextResponse.json({ ok: true, orgs: orgIds.length, results });
}
```

- [ ] **Step 3: Schedule it.** In `apps/web/vercel.json`, add to the `crons` array:

```json
    {
      "path": "/api/cron/price-pull",
      "schedule": "0 9 * * *"
    }
```

- [ ] **Step 4: Verify + commit** — `cd apps/web && pnpm tsc --noEmit` (clean). Manual: a GET without the Bearer secret returns 401; with it, iterates enabled orgs.

```bash
git add apps/web/src/app/api/cron/price-pull/route.ts apps/web/vercel.json
git commit -m "feat(p6): daily price-pull cron (CRON_SECRET, per-org price_tracking gate, fail-open)"
```

---

## Task 6: UI — item-detail Market price panel + Books-page refresh

**Files:**
- Create: `apps/web/src/components/inventory/market-price-panel.tsx`
- Modify: `apps/web/src/components/inventory/item-detail.tsx` (mount the panel)
- Modify: `apps/web/src/app/(dashboard)/dashboard/books/page.tsx` (bulk refresh button) — or a small client component it renders

- [ ] **Step 1: Create the panel.** `apps/web/src/components/inventory/market-price-panel.tsx`:

```tsx
'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { fetchItemPriceAction } from '@/server/actions/price-tracking';
import type { PriceObservationRow } from '@/server/services/price-tracking';

export function MarketPricePanel({
  itemId,
  initial,
  ourRetail,
  ourCost,
}: {
  itemId: string;
  initial: PriceObservationRow | null;
  ourRetail: number | null;
  ourCost: number | null;
}) {
  const [obs, setObs] = React.useState<PriceObservationRow | null>(initial);
  const [loading, setLoading] = React.useState(false);

  async function refresh() {
    setLoading(true);
    const res = await fetchItemPriceAction(itemId);
    setLoading(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setObs(res.data);
    toast.success(res.data ? 'Market price updated.' : 'No market data found for this ISBN.');
  }

  const money = (n: number | null, ccy: string | null) =>
    n == null ? '—' : `${ccy === 'USD' || !ccy ? '$' : ccy + ' '}${n.toFixed(2)}`;

  return (
    <div className="rounded-lg border p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium">Market price · Google Books</h3>
        <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={loading}>
          {loading ? 'Fetching…' : 'Refresh'}
        </Button>
      </div>
      {!obs ? (
        <p className="text-muted-foreground text-sm">No market data yet. Click Refresh to look it up by ISBN.</p>
      ) : (
        <div className="flex gap-4">
          {obs.thumbnail_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={obs.thumbnail_url} alt="" className="h-20 w-auto rounded border" />
          )}
          <dl className="grid flex-1 grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">List price</dt>
            <dd>{money(obs.list_price, obs.currency)}</dd>
            <dt className="text-muted-foreground">Retail price</dt>
            <dd>{money(obs.retail_price, obs.currency)}</dd>
            <dt className="text-muted-foreground">Your retail</dt>
            <dd>{money(ourRetail, 'USD')}</dd>
            <dt className="text-muted-foreground">Your cost</dt>
            <dd>{money(ourCost, 'USD')}</dd>
            {obs.average_rating != null && (
              <>
                <dt className="text-muted-foreground">Rating</dt>
                <dd>{obs.average_rating} ★</dd>
              </>
            )}
          </dl>
        </div>
      )}
      {obs?.info_link && (
        <a href={obs.info_link} target="_blank" rel="noreferrer" className="text-primary mt-2 inline-block text-xs hover:underline">
          View on Google Books →
        </a>
      )}
      {obs?.observed_at && (
        <p className="text-muted-foreground mt-2 text-[11px]">Observed {obs.observed_at.slice(0, 10)}</p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Mount it in `item-detail.tsx`.** Read `apps/web/src/components/inventory/item-detail.tsx` to learn how it loads the item + how it's structured (server component? which service loads the item; where the detail body / tabs render). Then:
  - Server-side, compute `const { enabled: priceTrackingEnabled } = await checkModuleAccess('price_tracking');`
  - When `priceTrackingEnabled` AND the item is a book with an ISBN-ish barcode (use `isLikelyIsbn(item.barcode)` from `@stockpilot/core`), load the latest observation: `const obs = await PriceTrackingService.forCurrentUser().then(s => s.getLatestObservation(item.id)).catch(() => null);` (catch so a read hiccup never breaks the page), and render `<MarketPricePanel itemId={item.id} initial={obs} ourRetail={item.retail_price ?? null} ourCost={item.unit_cost ?? null} />` in the detail body (a sensible section — match the existing layout).
  - Match the file's actual data-loading + prop conventions; keep the addition isolated and gated.

- [ ] **Step 3: Books-page bulk refresh.** Read `apps/web/src/app/(dashboard)/dashboard/books/page.tsx`. Gate on `checkModuleAccess('price_tracking')` (enabled) — when enabled, render a small client button component that calls `refreshBookPricesAction()` and toasts the `{scanned,written,skipped}` summary. Create `apps/web/src/components/inventory/refresh-book-prices-button.tsx` ('use client') for it; place the button near the page's existing header actions.

```tsx
'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { refreshBookPricesAction } from '@/server/actions/price-tracking';

export function RefreshBookPricesButton() {
  const [loading, setLoading] = React.useState(false);
  async function run() {
    setLoading(true);
    const res = await refreshBookPricesAction();
    setLoading(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(`Prices refreshed — ${res.data.written} updated, ${res.data.skipped} skipped of ${res.data.scanned}.`);
  }
  return (
    <Button type="button" variant="outline" size="sm" onClick={run} disabled={loading}>
      {loading ? 'Refreshing…' : 'Refresh book prices'}
    </Button>
  );
}
```

- [ ] **Step 4: Verify + commit** — `cd apps/web && pnpm tsc --noEmit` (clean). Manual: with module on + a book item that has an ISBN barcode, the panel shows + Refresh pulls a real price; with module off, neither surface appears.

```bash
git add apps/web/src/components/inventory/market-price-panel.tsx apps/web/src/components/inventory/refresh-book-prices-button.tsx apps/web/src/components/inventory/item-detail.tsx "apps/web/src/app/(dashboard)/dashboard/books/page.tsx"
git commit -m "feat(p6): market-price panel on item detail + Books-page refresh button (gated)"
```

---

## Final verification + ship

- [ ] **Full typecheck:** `cd packages/core && pnpm tsc --noEmit && cd ../../apps/web && pnpm tsc --noEmit` → clean.
- [ ] **Full tests:** `cd packages/core && pnpm vitest run && cd ../../apps/web && pnpm vitest run` → all green (new: google-books, price-tracking service + action; no regressions).
- [ ] **Spec coverage:** module gate (T1), observations table (T1), env (T1), core helpers (T2), client + service + shared fns (T3), actions (T4), cron + schedule (T5), UI (T6). No gaps.
- [ ] **Ship:** request review → merge `phase6-price-tracking` → `main` → push (Vercel). **Then APPLY migration 0163 to prod:** `supabase migration list --linked </dev/null` (confirm 0163 pending) → `printf 'Y\n' | supabase db push --linked` → re-verify applied. No mobile → no OTA. Set `GOOGLE_BOOKS_API_KEY` in Vercel env (optional; keyless works at low volume). Update memory.

## Notes / v1 limits
- Books-only (ISBN match); products/UPC need a different source (Keepa) — follow-on.
- Google Books `saleInfo` price is Google Play list/retail, present for many but not all titles; metadata is the reliable floor.
- Append-only observations enable a future price-trend chart + price-drop alerts.
- Cron caps ~300 items/org/run + skips <20h-observed → cycles a large catalog over days within Google's free quota.
