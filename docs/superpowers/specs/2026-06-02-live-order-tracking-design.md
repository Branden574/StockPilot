# Live Order Tracking v1 — design

**Date:** 2026-06-02
**Status:** approved (owner, 2026-06-02). Web-only v1 (browser geolocation; no mobile build).

## Goal
A customer tracking a **delivery** order sees the driver's **live position on a map** + **straight-line distance** ("2.3 mi away") while the order is `in_transit`. Off-by-default, **admin-toggleable** via a `live_tracking` module. Web-only (driver shares via browser geolocation; no native mobile build/OTA).

## What exists (reuse)
- Delivery orders: `order_requests.fulfillment_type='delivery'`, `assigned_delivery_user_id`, status `in_transit` (`in_transit_at`/`in_transit_by`). Driver acts on the order detail via `manager-actions-panel.tsx` / `assign-delivery-dialog.tsx`.
- Customer tracking: the **track form** (`/r/track` → `components/orders/track-form.tsx`) — customer submits **token (`?t=` = org `public_request_token`) + request id + email** to a public GET (`/api/v1/public/order-requests/[id]`) and sees a **redacted status** payload (shows `in_transit`, etc.). The live map lives in this result view; the location read uses the **same token+id+email** auth.
- Destination address: `charters.address` (jsonb, migration 0149) — the delivery destination.
- Module framework (registry + `seed_org_modules` grandfather), `checkModuleAccess`/`assertModuleEnabled`, Vault not needed (no external secret beyond an optional geocoder key).
- Supabase Realtime exists but uses `postgres_changes` (RLS-gated) → **NOT usable by the unauthenticated customer**, so the customer **polls** instead (see Data flow).

## Decisions (locked)
- **Driver share = browser geolocation (web)** — ships via Vercel, no native build. Foreground-only.
- **Customer = poll** a token-scoped endpoint (~12s) — not Realtime (anon/RLS issue). Realtime broadcast = a v2 optimization.
- **Map = MapLibre GL JS + free OSM tiles** (no paid maps key). **Geocoding = Nominatim (OSM, free, no key)**, cached per charter (1 geocode per address; note Nominatim's 1 req/s + attribution policy — caching keeps us well under it). MapTiler is the drop-in upgrade if volume grows.
- **Distance = haversine** (driver → destination). Driving-ETA = deferred (paid routing API).
- Customer's own location is **not** required (distance is to the delivery address).

## Data model — migration `0164_live_tracking.sql`
1. **Grandfather `live_tracking` OFF** for existing orgs + add to `seed_org_modules()` OFF (premium or optional — **optional**, defaultOnFor []). (Mirror 0161/0162/0163.)
2. **`delivery_locations`** — latest driver point per active order:
   ```sql
   create table if not exists public.delivery_locations (
     id               uuid primary key default gen_random_uuid(),
     organization_id  uuid not null references public.organizations(id) on delete cascade,
     order_request_id uuid not null references public.order_requests(id) on delete cascade,
     driver_user_id   uuid references auth.users(id) on delete set null,
     lat              double precision not null,
     lng              double precision not null,
     heading          double precision,
     accuracy         double precision,
     recorded_at      timestamptz not null default now(),
     unique (order_request_id)            -- upsert: one live point per order
   );
   ```
   RLS: select for org members; write for `has_org_role(organization_id,'staff')` (the assigned-driver check is enforced in the action/service — RLS is the floor). The customer NEVER reads via RLS (the public poll endpoint uses the service-role admin client after verifying token+id+email).
3. **Destination geocode cache** on charters (avoid re-geocoding each poll):
   ```sql
   alter table public.charters
     add column if not exists geocoded_lat double precision,
     add column if not exists geocoded_lng double precision,
     add column if not exists geocoded_at  timestamptz;
   ```

## Components & boundaries

### Core (`packages/core`, pure, unit-tested)
`packages/core/src/geo/distance.ts`: `haversineMiles(a, b)` + `isStale(recordedAtIso, now, maxAgeSec)` (driver location considered live only if recent). Unit-tested.

### Service (`apps/web/src/server/services/delivery-tracking.ts`), all gated `assertModuleEnabled('live_tracking')`
- `shareLocation(orderId, { lat, lng, heading?, accuracy? })` — DRIVER path: assert the order exists, `fulfillment_type='delivery'`, status `in_transit`, and `ctx.userId === order.assigned_delivery_user_id` (else `forbidden`); upsert `delivery_locations` (on order_request_id). Throws on bad state.
- `getPublicDriverLocation({ token, orderId, email })` — CUSTOMER path (service-role admin client): verify the token resolves to an org + the order matches id + requester email (mirror the existing public status check's verification), AND order is delivery + `in_transit` + the org's `live_tracking` enabled; else return `{ available: false }`. Read the latest `delivery_locations` row (drop if stale > ~5 min), geocode the charter destination (cache on charters), compute `distanceMiles = haversineMiles(driver, dest)`, return `{ available, driver:{lat,lng,heading,recordedAt}, destination:{lat,lng}, distanceMiles }`.
- `purgeForOrder(orderId)` — delete `delivery_locations` when an order leaves `in_transit` (completed/cancelled). Call from the status-transition path + a safety cron.
- Geocoder: a small `geocodeAddress(address)` helper (Nominatim fetch, proper User-Agent) used by `getPublicDriverLocation`, caching to `charters.geocoded_*`.

### Driver action + UI (web dashboard)
- `shareDeliveryLocationAction(orderId, point)` (`'use server'`) → `DeliveryTrackingService.shareLocation`. Returns `ActionResult`.
- `DeliveryLocationShare` client island on the order detail (rendered only when `live_tracking` enabled AND viewer `=== assigned_delivery_user_id` AND status `in_transit`): a "Share my location" toggle → `navigator.geolocation.watchPosition` → throttled (~every 15s / on significant move) `shareDeliveryLocationAction`. Stops on toggle-off, status change, or unmount (foreground-only). Clear "your location is shared with the customer while delivering" copy.

### Customer poll + map (track-form result)
- `GET /api/v1/public/order-requests/[id]/location?t=<token>&email=<email>` → `DeliveryTrackingService.getPublicDriverLocation`. Returns the location payload or `{ available:false }` (fail-soft). `dynamic='force-dynamic'`, no caching.
- In `track-form.tsx` result view: when the status payload is a delivery + `in_transit` (+ module on, surfaced by the status payload), render a lazy `DeliveryMap` island (MapLibre GL) that polls the location endpoint every ~12s: driver marker (+ heading), destination marker, and "Driver is {distanceMiles} mi away · updated {ago}". If `available:false` or stale → "Live location unavailable" + the existing status display. Never blocks the status view.

### Module
- Add `live_tracking` to `ModuleId` + `MODULE_REGISTRY` (tier optional, surfaces ['web'], dependsOn ['orders'], defaultOnFor [], placements []). No nav item (it's surfaced inside the order detail + /r/track).

## Security & privacy
- **Visible only** via the order's token + id + email (same as the status check) **and only while `in_transit`** + module on. Before/after → `{ available:false }`, no location.
- **Write auth:** only the order's `assigned_delivery_user_id`, only while `in_transit`, module-gated; rate-limit the action.
- **Data minimization:** one latest point per order (upsert); **purge on completion/cancel** (status transition + safety cron). No long-term staff GPS trail.
- **Foreground-only** (browser geolocation) — no background tracking, no app-store review.
- Geocoder: only the destination address is sent to Nominatim (not customer/driver live coords); cached.

## Error handling
- Geocode failure → destination marker omitted, distance "unavailable", driver marker still shows. Stale driver point (>~5 min) → treated as unavailable. Endpoint failures → poll retries; status view unaffected. All fail-soft.

## Testing
- Core: `distance.test.ts` — haversine known distances + `isStale` boundaries.
- Service: `delivery-tracking.test.ts` — `shareLocation` gating (module off → throws; non-assigned user → forbidden; not in_transit → rejects); `getPublicDriverLocation` (module off / wrong email / not in_transit → `{available:false}`; happy path returns distance). Use `makeServiceContext`/`makeSupabaseStub`.
- Action: gating happy/forbidden.
- Map/geolocation/poll = manual.

## Ship
Web merge → Vercel. **Apply migration 0164 to prod** (agent's job). No mobile changes → no OTA. Admin enables `live_tracking` in Settings → Modules to use it. v2 (later): native mobile driver capture + background, Realtime broadcast, driving-ETA, customer-location distance.
