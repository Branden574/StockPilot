# Live Order Tracking v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A customer tracking a delivery order sees the driver's live position + straight-line distance on a map (in the `/r/track` result) while the order is `in_transit`; gated behind an off-by-default, admin-toggleable `live_tracking` module. Web-only (driver shares via browser geolocation).

**Architecture:** Driver's authenticated dashboard page streams `navigator.geolocation` → a gated server action → upsert `delivery_locations` (latest point per order). The unauthenticated customer **polls** a token+id+email-scoped public endpoint (service-role) that returns the driver point + geocoded destination + haversine distance, rendered on a MapLibre map. No Realtime (anon/RLS), no native mobile.

**Tech Stack:** Next.js (RSC + server actions + route handler), Supabase (Postgres + RLS + admin client), MapLibre GL JS, Nominatim geocoding, vitest, `@stockpilot/core`.

**Spec:** [`docs/superpowers/specs/2026-06-02-live-order-tracking-design.md`](../specs/2026-06-02-live-order-tracking-design.md)

**Conventions (reuse):**
- Service: `class X { constructor(private readonly ctx: ServiceContext){}; static async forCurrentUser(){ return new X(await withContext()) } }`; gate `assertModuleEnabled(this.ctx,'live_tracking')` + throw `ServiceError`.
- Action: `'use server'` + zod `safeParse`→`err`; `try { ok(...) } catch(e){ e instanceof ServiceError ? err(e.code,e.message) : err('internal_error',...) }`. `ok`/`err`/`ActionResult` from `@stockpilot/core`.
- Public endpoint: mirror `apps/web/src/app/api/v1/public/order-requests/[id]/route.ts` — `runtime='nodejs'`, `dynamic='force-dynamic'`, `createAdminClient()`, generic `404`/empty on any verification failure (never leak which check failed).
- Module gate page/UI: `checkModuleAccess('live_tracking')`.
- Tests: `import { describe, expect, it, vi } from 'vitest'`; `makeServiceContext(stub.client,{enabledModules})` / `makeSupabaseStub({'table.op':{data,error}})` from `@/test/supabase-mock`; `DEFAULT_MODULE_IDS` excludes `live_tracking` (default ctx throws the gate; pass `new Set([...DEFAULT_MODULE_IDS,'live_tracking'])` for happy path).
- Run: `cd apps/web && pnpm vitest run <p>` / `pnpm tsc --noEmit`; `cd packages/core && pnpm vitest run <p>` / `pnpm tsc --noEmit`.

---

## Task 1: Migration 0164 + module registry

**Files:**
- Create: `supabase/migrations/0164_live_tracking.sql`
- Modify: `packages/core/src/modules/registry.ts`

- [ ] **Step 1: Read 0163** so `seed_org_modules()` stays byte-identical plus the appended row: `sed -n '1,70p' supabase/migrations/0163_price_tracking_module_observations.sql`.

- [ ] **Step 2: Write the migration** `supabase/migrations/0164_live_tracking.sql`:

```sql
-- ============================================================================
-- 0164_live_tracking.sql — Live delivery tracking (web v1).
-- 1) Grandfather the optional 'live_tracking' module OFF for existing orgs.
-- 2) Re-seed new orgs with it present-but-OFF.
-- 3) delivery_locations — latest driver point per active delivery order.
-- 4) charters geocode cache (destination lat/lng).
-- ============================================================================
set check_function_bodies = off;

-- ── 1) Grandfather existing orgs: 'live_tracking' OFF ───────────────────────
insert into public.organization_modules (organization_id, module_id, enabled, tier, enabled_at)
select o.id, 'live_tracking', false, 'optional', now()
from public.organizations o
on conflict (organization_id, module_id) do nothing;

-- ── 2) New-org seed: byte-identical to 0163 + 'live_tracking' optional OFF ──
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
    -- net-new opt-in optional (OFF)
    ('live_tracking','optional', false)
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

-- ── 3) delivery_locations — latest driver point per active delivery order ───
create table if not exists public.delivery_locations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  order_request_id uuid not null references public.order_requests(id) on delete cascade,
  driver_user_id   uuid references public.user_profiles(id) on delete set null,
  lat              double precision not null,
  lng              double precision not null,
  heading          double precision,
  accuracy         double precision,
  recorded_at      timestamptz not null default now(),
  unique (order_request_id)
);
create index if not exists delivery_locations_org_idx
  on public.delivery_locations (organization_id);

alter table public.delivery_locations enable row level security;

drop policy if exists delivery_locations_select on public.delivery_locations;
create policy delivery_locations_select on public.delivery_locations
  for select using (
    exists (
      select 1 from public.organization_members m
      where m.user_id = auth.uid()
        and m.organization_id = delivery_locations.organization_id
        and m.accepted_at is not null
    )
  );

-- Floor = 'staff' to match the service gate; the assigned-driver check is
-- enforced in the service/action. Customers never read via RLS — the public
-- poll endpoint uses the service-role admin client after verifying token+id+email.
drop policy if exists delivery_locations_write on public.delivery_locations;
create policy delivery_locations_write on public.delivery_locations
  for all using (public.has_org_role(organization_id, 'staff'));

-- ── 4) Destination geocode cache on charters (geocode each address once) ────
alter table public.charters
  add column if not exists geocoded_lat double precision,
  add column if not exists geocoded_lng double precision,
  add column if not exists geocoded_at  timestamptz;
```

- [ ] **Step 3: Register the module.** In `packages/core/src/modules/registry.ts`: (a) append `| 'live_tracking'` to the `ModuleId` union (the line currently ending `... | 'api_access' | 'price_tracking';`); (b) add a `MODULE_REGISTRY` entry immediately after the `price_tracking:` block, mirroring its exact field set:

```typescript
  live_tracking: {
    id: 'live_tracking',
    tier: 'optional',
    title: 'Live tracking',
    dependsOn: ['orders'],
    permissions: [],
    surfaces: ['web'],
    apiPrefixes: [],
    ownsTables: ['delivery_locations'],
    defaultOnFor: [],
    placements: [],
  },
```

`DEFAULT_MODULE_IDS = modulesForPack('charter_school')` auto-excludes it (`defaultOnFor: []`), so the default test context throws the gate — exactly what the service tests rely on.

- [ ] **Step 4: Verify + commit** — `cd packages/core && pnpm tsc --noEmit && pnpm vitest run` (registry tests green) and `cd apps/web && pnpm tsc --noEmit`.

```bash
git add supabase/migrations/0164_live_tracking.sql packages/core/src/modules/registry.ts
git commit -m "feat(live-tracking): migration 0164 — live_tracking module OFF + delivery_locations + charter geocode cache"
```

---

## Task 2: Core geo helpers (pure, TDD)

**Files:**
- Create: `packages/core/src/geo/distance.ts`
- Test: `packages/core/src/geo/distance.test.ts`
- Modify: `packages/core/src/index.ts` (`export * from './geo/distance';`)

- [ ] **Step 1: Write the failing test** `packages/core/src/geo/distance.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { haversineMiles, isStale } from './distance';

describe('haversineMiles', () => {
  it('is 0 for identical points', () => {
    expect(haversineMiles({ lat: 36.7, lng: -119.7 }, { lat: 36.7, lng: -119.7 })).toBe(0);
  });
  it('matches a known distance (LA ~ NYC ≈ 2445 mi, within 1%)', () => {
    const d = haversineMiles({ lat: 34.05, lng: -118.24 }, { lat: 40.71, lng: -74.01 });
    expect(d).toBeGreaterThan(2420);
    expect(d).toBeLessThan(2470);
  });
  it('rounds to one decimal', () => {
    const d = haversineMiles({ lat: 36.70, lng: -119.70 }, { lat: 36.71, lng: -119.70 });
    expect(d).toBeCloseTo(0.7, 1);
  });
});

describe('isStale', () => {
  const now = new Date('2026-06-02T12:00:00Z');
  it('false when recent', () => {
    expect(isStale('2026-06-02T11:59:00Z', now, 300)).toBe(false);
  });
  it('true when older than maxAge', () => {
    expect(isStale('2026-06-02T11:50:00Z', now, 300)).toBe(true);
  });
  it('true for an unparseable timestamp', () => {
    expect(isStale('not-a-date', now, 300)).toBe(true);
  });
});
```

- [ ] **Step 2: Run; expect FAIL** — `cd packages/core && pnpm vitest run src/geo/distance.test.ts`.

- [ ] **Step 3: Implement** `packages/core/src/geo/distance.ts`:

```typescript
/** Pure geo helpers for live delivery tracking. No I/O. */
export interface LatLng { lat: number; lng: number; }

/** Great-circle distance in miles, rounded to 1 decimal. */
export function haversineMiles(a: LatLng, b: LatLng): number {
  const R = 3958.7613; // earth radius, miles
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const miles = 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  return Math.round(miles * 10) / 10;
}

/** A recorded location is stale if older than maxAgeSec (or unparseable). */
export function isStale(recordedAtIso: string, now: Date, maxAgeSec: number): boolean {
  const t = new Date(recordedAtIso).getTime();
  if (Number.isNaN(t)) return true;
  return now.getTime() - t > maxAgeSec * 1000;
}
```

- [ ] **Step 4: Barrel export** — append `export * from './geo/distance';` to `packages/core/src/index.ts`.

- [ ] **Step 5: Verify + commit** — `cd packages/core && pnpm vitest run src/geo/distance.test.ts && pnpm tsc --noEmit`.

```bash
git add packages/core/src/geo/distance.ts packages/core/src/geo/distance.test.ts packages/core/src/index.ts
git commit -m "feat(live-tracking-core): haversineMiles + isStale geo helpers"
```

---

## Task 3: DeliveryTrackingService + geocoder (gated; TDD)

**Files:**
- Create: `apps/web/src/server/services/delivery-tracking.ts`
- Create: `apps/web/src/server/services/geocode.ts`
- Test: `apps/web/src/server/services/delivery-tracking.test.ts`

- [ ] **Step 1: Geocoder helper** `apps/web/src/server/services/geocode.ts`:

```typescript
import 'server-only';
import { haversineMiles, type LatLng } from '@stockpilot/core';

export { haversineMiles, type LatLng };

/**
 * Geocode a free-form address string via Nominatim (OSM, free, no key).
 * Returns null on any failure (caller fails soft → no destination marker).
 * Low volume only — callers MUST cache the result (we geocode each charter once).
 */
export async function geocodeAddress(address: string): Promise<LatLng | null> {
  const q = address.trim();
  if (!q) return null;
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
      { headers: { 'User-Agent': 'StockPilot/1.0 (delivery-tracking)' } },
    );
    if (!res.ok) return null;
    const arr = (await res.json()) as Array<{ lat?: string; lon?: string }>;
    const first = arr[0];
    if (!first?.lat || !first?.lon) return null;
    const lat = Number(first.lat);
    const lng = Number(first.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

/**
 * Turn a charter `address` jsonb into a single geocodable line. The stored
 * shape is the `charterAddressSchema` (apps/web/src/server/services/charters.ts):
 * { line1, line2, city, region, postalCode, country }.
 */
export function addressToLine(address: unknown): string {
  if (!address || typeof address !== 'object') return '';
  const a = address as Record<string, unknown>;
  return [a.line1, a.line2, a.city, a.region, a.postalCode, a.country]
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .join(', ');
}
```

(Verified against `charterAddressSchema` — `charters.address` jsonb keys are `line1/line2/city/region/postalCode/country`, persisted by migration 0149.)

- [ ] **Step 2: Write the failing service test** `apps/web/src/server/services/delivery-tracking.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';
import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';
import { DeliveryTrackingService } from './delivery-tracking';

const withLT = () => new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'live_tracking']);

describe('DeliveryTrackingService.shareLocation gating', () => {
  it('throws module_disabled when live_tracking is off', async () => {
    const stub = makeSupabaseStub({});
    const svc = new DeliveryTrackingService(makeServiceContext(stub.client)); // no live_tracking
    await expect(
      svc.shareLocation('order-1', { lat: 1, lng: 2 }),
    ).rejects.toMatchObject({ code: 'module_disabled' });
  });

  it('forbids a non-assigned user', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select': {
        data: { id: 'order-1', fulfillment_type: 'delivery', status: 'in_transit', assigned_delivery_user_id: 'someone-else' },
        error: null,
      },
    });
    const svc = new DeliveryTrackingService(
      makeServiceContext(stub.client, { enabledModules: withLT(), userId: 'driver-1' }),
    );
    await expect(svc.shareLocation('order-1', { lat: 1, lng: 2 })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects when the order is not in_transit', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select': {
        data: { id: 'order-1', fulfillment_type: 'delivery', status: 'approved', assigned_delivery_user_id: 'driver-1' },
        error: null,
      },
    });
    const svc = new DeliveryTrackingService(
      makeServiceContext(stub.client, { enabledModules: withLT(), userId: 'driver-1' }),
    );
    await expect(svc.shareLocation('order-1', { lat: 1, lng: 2 })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('upserts a location for the assigned driver of an in_transit delivery', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select': {
        data: { id: 'order-1', organization_id: 'org-test', fulfillment_type: 'delivery', status: 'in_transit', assigned_delivery_user_id: 'driver-1' },
        error: null,
      },
      'delivery_locations.upsert': { data: null, error: null },
    });
    const svc = new DeliveryTrackingService(
      makeServiceContext(stub.client, { enabledModules: withLT(), userId: 'driver-1' }),
    );
    await svc.shareLocation('order-1', { lat: 36.7, lng: -119.7, heading: 90, accuracy: 5 });
    expect(stub.fromCalls).toContain('delivery_locations');
  });
});
```

- [ ] **Step 3: Run; expect FAIL** — `cd apps/web && pnpm vitest run src/server/services/delivery-tracking.test.ts`.

- [ ] **Step 4: Implement** `apps/web/src/server/services/delivery-tracking.ts`:

```typescript
import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertModuleEnabled, ServiceError, withContext, type ServiceContext } from './context';
import { addressToLine, geocodeAddress } from './geocode';
import { haversineMiles, isStale } from '@stockpilot/core';

export interface DriverPoint { lat: number; lng: number; heading?: number; accuracy?: number; }

export interface PublicLocationResult {
  available: boolean;
  driver?: { lat: number; lng: number; heading: number | null; recordedAt: string };
  destination?: { lat: number; lng: number } | null;
  distanceMiles?: number | null;
}

const STALE_SEC = 5 * 60;

export class DeliveryTrackingService {
  constructor(private readonly ctx: ServiceContext) {}
  static async forCurrentUser() { return new DeliveryTrackingService(await withContext()); }

  /** DRIVER: record the assigned driver's latest point for an in-transit delivery. */
  async shareLocation(orderId: string, p: DriverPoint): Promise<void> {
    assertModuleEnabled(this.ctx, 'live_tracking');
    const { data: order, error } = await this.ctx.supabase
      .from('order_requests')
      .select('id, organization_id, fulfillment_type, status, assigned_delivery_user_id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', orderId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!order) throw new ServiceError('not_found', 'Order not found.');
    const o = order as { fulfillment_type: string; status: string; assigned_delivery_user_id: string | null };
    if (o.assigned_delivery_user_id !== this.ctx.userId) {
      throw new ServiceError('forbidden', 'Only the assigned driver can share location for this order.');
    }
    if (o.fulfillment_type !== 'delivery' || o.status !== 'in_transit') {
      throw new ServiceError('validation_error', 'Location sharing is only active for an in-transit delivery.');
    }
    const { error: upErr } = await this.ctx.supabase
      .from('delivery_locations')
      .upsert(
        {
          organization_id: this.ctx.organizationId,
          order_request_id: orderId,
          driver_user_id: this.ctx.userId,
          lat: p.lat,
          lng: p.lng,
          heading: p.heading ?? null,
          accuracy: p.accuracy ?? null,
          recorded_at: new Date().toISOString(),
        },
        { onConflict: 'order_request_id' },
      );
    if (upErr) throw new ServiceError('internal_error', upErr.message);
  }

  /** Delete the live point when an order leaves in_transit (completed/cancelled). */
  async purgeForOrder(orderId: string): Promise<void> {
    await this.ctx.supabase.from('delivery_locations').delete().eq('order_request_id', orderId);
  }
}

/**
 * CUSTOMER (unauthenticated) path — verified by token+id+email upstream in the
 * route. Uses the service-role admin client; returns {available:false} for any
 * gate miss (module off, not delivery, not in_transit, stale, no point).
 */
export async function getPublicDriverLocation(args: {
  orgId: string;
  orderId: string;
}): Promise<PublicLocationResult> {
  const admin = createAdminClient();

  // Module gate (service-role, by org).
  const { data: mod } = await admin
    .from('organization_modules')
    .select('enabled')
    .eq('organization_id', args.orgId)
    .eq('module_id', 'live_tracking')
    .maybeSingle();
  if (!(mod as { enabled?: boolean } | null)?.enabled) return { available: false };

  const { data: order } = await admin
    .from('order_requests')
    .select('id, fulfillment_type, status, delivery_charter_id')
    .eq('id', args.orderId)
    .eq('organization_id', args.orgId)
    .maybeSingle();
  const o = order as { fulfillment_type?: string; status?: string; delivery_charter_id?: string | null } | null;
  if (!o || o.fulfillment_type !== 'delivery' || o.status !== 'in_transit') return { available: false };

  const { data: loc } = await admin
    .from('delivery_locations')
    .select('lat, lng, heading, recorded_at')
    .eq('order_request_id', args.orderId)
    .maybeSingle();
  const l = loc as { lat: number; lng: number; heading: number | null; recorded_at: string } | null;
  if (!l || isStale(l.recorded_at, new Date(), STALE_SEC)) return { available: false };

  // Destination: the delivery charter's address (geocode once, cache on charters).
  let destination: { lat: number; lng: number } | null = null;
  if (o.delivery_charter_id) {
    const { data: ch } = await admin
      .from('charters')
      .select('address, geocoded_lat, geocoded_lng')
      .eq('id', o.delivery_charter_id)
      .maybeSingle();
    const c = ch as { address: unknown; geocoded_lat: number | null; geocoded_lng: number | null } | null;
    if (c?.geocoded_lat != null && c?.geocoded_lng != null) {
      destination = { lat: c.geocoded_lat, lng: c.geocoded_lng };
    } else if (c?.address) {
      const geo = await geocodeAddress(addressToLine(c.address));
      if (geo) {
        destination = geo;
        await admin.from('charters')
          .update({ geocoded_lat: geo.lat, geocoded_lng: geo.lng, geocoded_at: new Date().toISOString() })
          .eq('id', o.delivery_charter_id);
      }
    }
  }

  return {
    available: true,
    driver: { lat: l.lat, lng: l.lng, heading: l.heading, recordedAt: l.recorded_at },
    destination,
    distanceMiles: destination ? haversineMiles({ lat: l.lat, lng: l.lng }, destination) : null,
  };
}
```

(Verified: `order_requests.delivery_charter_id` (migration 0110) → `charters.address` is the delivery destination. A pickup/no-charter order returns `destination:null` — the driver marker still shows.)

- [ ] **Step 5: Verify + commit** — `cd apps/web && pnpm vitest run src/server/services/delivery-tracking.test.ts && pnpm tsc --noEmit`.

```bash
git add apps/web/src/server/services/delivery-tracking.ts apps/web/src/server/services/geocode.ts apps/web/src/server/services/delivery-tracking.test.ts
git commit -m "feat(live-tracking): DeliveryTrackingService (shareLocation/getPublicDriverLocation/purge) + Nominatim geocoder"
```

---

## Task 4: Driver action + UI (share location)

**Files:**
- Create: `apps/web/src/server/actions/delivery-tracking.ts`
- Test: `apps/web/src/server/actions/delivery-tracking.test.ts`
- Create: `apps/web/src/components/orders/delivery-location-share.tsx`
- Modify: the order detail (mount the share control)

- [ ] **Step 1: Write the failing action test** `apps/web/src/server/actions/delivery-tracking.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
const shareLocation = vi.fn();
vi.mock('@/server/services/delivery-tracking', () => ({
  DeliveryTrackingService: { forCurrentUser: vi.fn(async () => ({ shareLocation })) },
}));
import { shareDeliveryLocationAction } from './delivery-tracking';

describe('shareDeliveryLocationAction', () => {
  it('rejects invalid coords', async () => {
    const res = await shareDeliveryLocationAction({ orderId: 'o1', lat: 999, lng: 0 });
    expect(res.ok).toBe(false);
  });
  it('delegates valid input and returns ok', async () => {
    shareLocation.mockResolvedValueOnce(undefined);
    const res = await shareDeliveryLocationAction({ orderId: '11111111-1111-1111-1111-111111111111', lat: 36.7, lng: -119.7 });
    expect(res.ok).toBe(true);
    expect(shareLocation).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run; expect FAIL.**

- [ ] **Step 3: Implement** `apps/web/src/server/actions/delivery-tracking.ts`:

```typescript
'use server';
import { z } from 'zod';
import { err, ok, type ActionResult } from '@stockpilot/core';
import { DeliveryTrackingService } from '@/server/services/delivery-tracking';
import { ServiceError } from '@/server/services/context';

const schema = z.object({
  orderId: z.string().uuid(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  heading: z.number().min(0).max(360).optional(),
  accuracy: z.number().nonnegative().optional(),
});

export async function shareDeliveryLocationAction(input: z.input<typeof schema>): Promise<ActionResult<{ ok: true }>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid location.');
  try {
    const svc = await DeliveryTrackingService.forCurrentUser();
    const { orderId, ...point } = parsed.data;
    await svc.shareLocation(orderId, point);
    return ok({ ok: true });
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
```

- [ ] **Step 4: Verify the action** — `cd apps/web && pnpm vitest run src/server/actions/delivery-tracking.test.ts && pnpm tsc --noEmit`.

- [ ] **Step 5: Driver share island** `apps/web/src/components/orders/delivery-location-share.tsx`:

```tsx
'use client';
import * as React from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { shareDeliveryLocationAction } from '@/server/actions/delivery-tracking';

const MIN_INTERVAL_MS = 15_000;

export function DeliveryLocationShare({ orderId }: { orderId: string }) {
  const [sharing, setSharing] = React.useState(false);
  const watchId = React.useRef<number | null>(null);
  const lastSent = React.useRef(0);

  const stop = React.useCallback(() => {
    if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null;
    setSharing(false);
  }, []);

  React.useEffect(() => () => { if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current); }, []);

  function start() {
    if (!('geolocation' in navigator)) { toast.error('Location not available on this device.'); return; }
    setSharing(true);
    watchId.current = navigator.geolocation.watchPosition(
      async (pos) => {
        const now = Date.now();
        if (now - lastSent.current < MIN_INTERVAL_MS) return;
        lastSent.current = now;
        const res = await shareDeliveryLocationAction({
          orderId,
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          heading: pos.coords.heading ?? undefined,
          accuracy: pos.coords.accuracy ?? undefined,
        });
        if (!res.ok) { toast.error(res.error.message); stop(); }
      },
      (e) => { toast.error(`Location error: ${e.message}`); stop(); },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
    );
  }

  return (
    <div className="rounded-lg border p-3">
      <p className="text-sm font-medium">Live delivery tracking</p>
      <p className="text-muted-foreground mb-2 text-xs">
        While on, the customer can see your location on a map until this delivery completes. Foreground only.
      </p>
      <Button type="button" variant={sharing ? 'outline' : 'gradient'} size="sm" onClick={sharing ? stop : start}>
        {sharing ? 'Stop sharing' : 'Share my location'}
      </Button>
    </div>
  );
}
```

- [ ] **Step 6: Mount it on the order detail.** Find where the order detail renders for staff (e.g. `apps/web/src/components/orders/manager-actions-panel.tsx` or the `dashboard/orders/[id]` page). Render `<DeliveryLocationShare orderId={order.id} />` ONLY when: `checkModuleAccess('live_tracking')` enabled (server), the order `fulfillment_type==='delivery'`, `status==='in_transit'`, AND the current user is the `assigned_delivery_user_id`. Read the surrounding file to get the order + current-user + module flag and gate accordingly; keep it additive (no change when the conditions aren't met).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/server/actions/delivery-tracking.ts apps/web/src/server/actions/delivery-tracking.test.ts apps/web/src/components/orders/delivery-location-share.tsx apps/web/src/components/orders/manager-actions-panel.tsx
git commit -m "feat(live-tracking): driver share-location action + foreground geolocation control on the order detail"
```

---

## Task 5: Public location endpoint (token+id+email scoped)

**Files:**
- Create: `apps/web/src/app/api/v1/public/order-requests/[id]/location/route.ts`

- [ ] **Step 1: Read the sibling verification** to mirror it exactly: `sed -n '1,70p' apps/web/src/app/api/v1/public/order-requests/[id]/route.ts` (token→org via `public_request_token`, then order by id+org, then `requester_email` matches `?email=` case-insensitive; generic 404 on any miss).

- [ ] **Step 2: Implement** `apps/web/src/app/api/v1/public/order-requests/[id]/location/route.ts`:

```typescript
import { NextResponse, type NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getPublicDriverLocation } from '@/server/services/delivery-tracking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Live driver location for a public tracker. Verified by the SAME token+id+email
// triad as the status read; any miss returns { available:false } (never leaks).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  const email = (url.searchParams.get('email') ?? '').trim().toLowerCase();
  const token = (url.searchParams.get('token') ?? '').trim();
  if (!UUID_RE.test(id) || !email || !token) return NextResponse.json({ available: false });

  const admin = createAdminClient();
  const { data: org } = await admin.from('organizations').select('id').eq('public_request_token', token).maybeSingle();
  if (!org) return NextResponse.json({ available: false });
  const orgId = (org as { id: string }).id;

  const { data: header } = await admin
    .from('order_requests')
    .select('id, requester_email')
    .eq('id', id)
    .eq('organization_id', orgId)
    .maybeSingle();
  const h = header as { requester_email: string | null } | null;
  if (!h || (h.requester_email ?? '').trim().toLowerCase() !== email) return NextResponse.json({ available: false });

  const result = await getPublicDriverLocation({ orgId, orderId: id });
  return NextResponse.json(result);
}
```

- [ ] **Step 3: Verify + commit** — `cd apps/web && pnpm tsc --noEmit`. Manual: a GET with wrong token/email → `{available:false}`.

```bash
git add "apps/web/src/app/api/v1/public/order-requests/[id]/location/route.ts"
git commit -m "feat(live-tracking): public token+id+email-scoped driver-location endpoint"
```

---

## Task 6: MapLibre dep + customer map in the track result

**Files:**
- Modify: `apps/web/package.json` (add `maplibre-gl`)
- Create: `apps/web/src/components/orders/delivery-map.tsx`
- Modify: `apps/web/src/components/orders/track-form.tsx` (render the map for in-transit deliveries)

- [ ] **Step 1: Add the dep** — `cd apps/web && pnpm add maplibre-gl` (and `@types/...` is bundled; maplibre ships its own types). Verify it lands in `apps/web/package.json` dependencies.

- [ ] **Step 2: Create the map island** `apps/web/src/components/orders/delivery-map.tsx` (dynamically import maplibre so it stays client-only; poll the location endpoint every 12s):

```tsx
'use client';
import * as React from 'react';

interface LocationPayload {
  available: boolean;
  driver?: { lat: number; lng: number; heading: number | null; recordedAt: string };
  destination?: { lat: number; lng: number } | null;
  distanceMiles?: number | null;
}

export function DeliveryMap({ orderId, token, email }: { orderId: string; token: string; email: string }) {
  const mapRef = React.useRef<HTMLDivElement>(null);
  const [payload, setPayload] = React.useState<LocationPayload | null>(null);

  // Poll the token-scoped endpoint every 12s.
  React.useEffect(() => {
    let cancelled = false;
    const url = `/api/v1/public/order-requests/${orderId}/location?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
    async function tick() {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as LocationPayload;
        if (!cancelled) setPayload(data);
      } catch { /* keep last */ }
    }
    tick();
    const t = setInterval(tick, 12_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [orderId, token, email]);

  // Lazy-init MapLibre + update markers when payload changes.
  const mapObj = React.useRef<unknown>(null);
  const markers = React.useRef<{ driver?: unknown; dest?: unknown }>({});
  React.useEffect(() => {
    if (!payload?.available || !payload.driver || !mapRef.current) return;
    let disposed = false;
    (async () => {
      const maplibregl = (await import('maplibre-gl')).default;
      await import('maplibre-gl/dist/maplibre-gl.css');
      if (disposed || !mapRef.current) return;
      const d = payload.driver!;
      if (!mapObj.current) {
        mapObj.current = new maplibregl.Map({
          container: mapRef.current,
          style: 'https://demotiles.maplibre.org/style.json', // free OSM demo style (swap for MapTiler key in prod if rate-limited)
          center: [d.lng, d.lat],
          zoom: 12,
        });
      }
      const map = mapObj.current as InstanceType<typeof maplibregl.Map>;
      const setMarker = (key: 'driver' | 'dest', lng: number, lat: number, color: string) => {
        const m = markers.current[key] as InstanceType<typeof maplibregl.Marker> | undefined;
        if (m) m.setLngLat([lng, lat]);
        else markers.current[key] = new maplibregl.Marker({ color }).setLngLat([lng, lat]).addTo(map);
      };
      setMarker('driver', d.lng, d.lat, '#2563eb');
      if (payload.destination) setMarker('dest', payload.destination.lng, payload.destination.lat, '#16a34a');
      map.easeTo({ center: [d.lng, d.lat] });
    })();
    return () => { disposed = true; };
  }, [payload]);

  if (!payload) return null;
  if (!payload.available) {
    return <p className="text-muted-foreground mt-3 text-sm">Live location isn't available right now.</p>;
  }
  return (
    <div className="mt-4">
      <div ref={mapRef} className="h-64 w-full overflow-hidden rounded-lg border" />
      <p className="text-muted-foreground mt-2 text-sm">
        {payload.distanceMiles != null ? `Driver is about ${payload.distanceMiles} mi away` : 'Driver en route'}
        {payload.driver ? ` · updated ${new Date(payload.driver.recordedAt).toLocaleTimeString()}` : ''}
      </p>
    </div>
  );
}
```

- [ ] **Step 3: Render it in `track-form.tsx`.** In the result view, when `result.status === 'in_transit'`, render `<DeliveryMap orderId={result.id} token={token} email={email} />` (the form already has the token + email + the order id from the lookup — wire those props from the component's existing state). Keep it purely additive — the status display is unchanged; the map appears below it only for in-transit orders, and self-hides if `available:false`.

- [ ] **Step 4: Verify + commit** — `cd apps/web && pnpm tsc --noEmit` (clean) and `pnpm vitest run` (no regressions). Manual: track an in-transit delivery with a shared driver location → map shows driver + distance.

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/components/orders/delivery-map.tsx apps/web/src/components/orders/track-form.tsx
git commit -m "feat(live-tracking): MapLibre customer map polling the driver location in the track result"
```

---

## Task 7: Purge on completion (no long-term GPS trail)

**Files:**
- Modify: `apps/web/src/server/services/order-requests.ts` (the status-transition to `completed`/`cancelled`)

- [ ] **Step 1:** Find where an order transitions to `completed` and to `cancelled` in `order-requests.ts` (grep `completed_at`/`cancelled_at` writes). After a successful transition out of `in_transit`, delete the live point:

```typescript
// Live tracking: drop the driver's live location once the delivery ends.
await this.ctx.supabase.from('delivery_locations').delete().eq('order_request_id', orderId);
```

Place it in the complete + cancel paths (best-effort — wrap so it never fails the transition; a missing row is fine). Confirm the variable name for the order id in those methods.

- [ ] **Step 2: Verify + commit** — `cd apps/web && pnpm tsc --noEmit && pnpm vitest run src/server/services/order-requests` (existing order tests green).

```bash
git add apps/web/src/server/services/order-requests.ts
git commit -m "feat(live-tracking): purge delivery_locations when an order completes/cancels"
```

---

## Final verification + ship
- [ ] `cd packages/core && pnpm tsc --noEmit && pnpm vitest run` → clean/green.
- [ ] `cd apps/web && pnpm tsc --noEmit && pnpm vitest run` → clean/green.
- [ ] `cd apps/web && pnpm build` → compiles (maplibre is a client-only dynamic import; confirm no SSR break).
- [ ] Spec coverage: module+toggle (T1), table+geocode cache (T1), distance/stale core (T2), service share/getPublic/purge + geocoder (T3), driver action+UI (T4), public endpoint (T5), map+poll (T6), purge-on-complete (T7). No gaps.
- [ ] Ship: request review → merge `live-tracking` → `main` → push (Vercel). **Apply migration 0164 to prod** (`supabase db push --linked`). No mobile → no OTA. Update memory. Admin enables `live_tracking` in Settings → Modules to use it.

## Notes / v1 limits
- Web browser-geolocation, foreground-only (no native/background). Customer **polls** (12s) — not Realtime. Straight-line distance (no driving ETA). Destination = charter address (geocoded once via Nominatim, cached). MapLibre demo tiles → swap for a MapTiler key if rate-limited at volume. v2: native mobile capture + background, Realtime broadcast, driving-ETA, customer-location distance.
