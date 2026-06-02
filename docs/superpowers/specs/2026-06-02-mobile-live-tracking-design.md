# Mobile Live Tracking (background) — design

**Date:** 2026-06-02
**Status:** approved (owner: native mobile + **background** tracking, 2026-06-02). Extends the web live-tracking v1 (`live_tracking` module, migration 0164) to the native app per the standing rule "every web feature also ships on mobile."

## Goal
The assigned delivery **driver** shares live GPS from the **native StockPilot app** — **including in the background** (phone locked / app switched away, Uber/Domino's-style) — while an order is `in_transit`. The customer keeps seeing it on the existing web map at `/r/track`. Off-by-default `live_tracking` module; nothing runs unless the driver explicitly turns sharing on.

## What exists (reuse — verified)
- **`DeliveryTrackingService.shareLocation(orderId, {lat,lng,heading?,accuracy?})`** (`apps/web/src/server/services/delivery-tracking.ts`) — already gates `live_tracking` module + `ctx.userId === assigned_delivery_user_id` + order is `delivery`+`in_transit`, then upserts `delivery_locations`. The mobile path reuses it verbatim (just a new transport).
- **`delivery_locations`** table + the `live_tracking` module (migration 0164, applied to prod). No new migration needed.
- **Bearer API:** `apps/mobile/src/lib/api.ts` `api<T>(path,{method,body,signal})` attaches `Authorization: Bearer <supabase access_token>` + `X-Organization-Id`. Server: `withApiContext(req)` (`apps/web/src/lib/auth/api-context.ts`) → `ServiceContext`; routes do `const ctx = await withApiContext(req); if(!ctx) 401; new Service(ctx)` (pattern: `apps/web/src/app/api/v1/cycle-counts/route.ts`).
- **Mobile module gate:** `useEnabledModules(): Set<ModuleId>` (`apps/mobile/src/lib/enabled-modules.ts`) → `.has('live_tracking')`.
- **Order detail screen:** `apps/mobile/app/order/[id].tsx` (expo-router) — loads an order via Supabase RLS into `OrderHeader`, has `useAuth().user`. Its select does NOT yet fetch `assigned_delivery_user_id`/`fulfillment_type` — we add them.
- **Permission pattern:** probe → request → `Alert.alert` on denial (camera at `order/[id].tsx`, biometric at `settings.tsx`).
- **Expo:** SDK 53, RN 0.79, newArch on; `app.config.ts` (plugins + iOS `infoPlist` + android `permissions`). `expo-location` / `expo-task-manager` NOT installed. EAS profiles (`eas.json`): `preview` (internal/TestFlight, API `https://stockpilotusa.com`) + `production` (autoIncrement, API `https://stockpilotusa.com`).

## Decisions (locked)
- **Background tracking** (not just foreground): `expo-location` background updates via `expo-task-manager`. Needs iOS `NSLocationAlwaysAndWhenInUseUsageDescription` + `UIBackgroundModes:['location']` + the "Always" permission (blue status-bar indicator), and Android `ACCESS_BACKGROUND_LOCATION` + a foreground service. Owner accepted the App-Store-review tradeoff.
- **New native module → EAS build required** (OTA can't ship native code). Ship via a `preview` (TestFlight) build, then `production`.
- **One active tracked order at a time** — the active order id lives in AsyncStorage (`liveTracking.orderId`); the background task reads it. Starting tracking on a new order overwrites.
- Customer tracker stays **web** (`/r/track`) — it's an unauthenticated external link, not a staff surface; the native work is the driver capture only.
- Throttle via `expo-location` options (`timeInterval ≈ 12s`, `distanceInterval ≈ 25m`) — not a JS timer (background JS timers are unreliable).

## Components & boundaries

### Server — `POST /api/v1/delivery/location` (`apps/web/src/app/api/v1/delivery/location/route.ts`)
`runtime='nodejs'`, `dynamic='force-dynamic'`. `withApiContext(req)` → 401 if null. zod body `{ orderId: uuid, lat: -90..90, lng: -180..180, heading?: 0..360, accuracy?: ≥0 }`. `new DeliveryTrackingService(ctx)` then `await svc.shareLocation(orderId, { lat,lng,heading,accuracy })`. Map `ServiceError`: `module_disabled|forbidden`→403, `validation_error`→400, `not_found`→404, else 500. Return `{ ok:true }` 200. (Reuses the web service's assigned-driver + in_transit + module gates — no new auth logic. Serves both foreground and background posts.)

### Mobile — background location task (`apps/mobile/src/lib/location-task.ts`)
- `export const LIVE_LOCATION_TASK = 'stockpilot-live-location';`
- `TaskManager.defineTask(LIVE_LOCATION_TASK, async ({ data, error }) => {...})` — on each batch, take the most recent `Location.LocationObject`, read `liveTracking.orderId` from AsyncStorage; if absent → `stopLocationUpdatesAsync` + return; else POST the latest point via `api('/api/v1/delivery/location', { method:'POST', body:{ orderId, lat, lng, heading, accuracy } })`. Wrap in try/catch (best-effort); if the POST fails with a 4xx (order no longer in_transit / not assigned), stop updates + clear the AsyncStorage key so a stale task doesn't keep firing.
- Helpers exported for the UI: `startLiveLocation(orderId)` (persist orderId, `Location.startLocationUpdatesAsync(LIVE_LOCATION_TASK, { accuracy: Balanced, timeInterval: 12000, distanceInterval: 25, showsBackgroundLocationIndicator: true, pausesUpdatesAutomatically: false, foregroundService: { notificationTitle, notificationBody } })`) and `stopLiveLocation()` (`stopLocationUpdatesAsync` if started + clear key) and `isLiveLocationActive()` (`hasStartedLocationUpdatesAsync(LIVE_LOCATION_TASK)`).
- The task module is imported once at app start (in `apps/mobile/app/_layout.tsx`) so `defineTask` registers before any updates fire.

### Mobile — permissions (in the share control)
On enable: `Location.requestForegroundPermissionsAsync()` → if granted, `Location.requestBackgroundPermissionsAsync()`. If foreground denied → Alert ("Location permission is needed to share your delivery location"). If background denied but foreground granted → proceed (foreground still works; Alert explains background needs "Always" for locked-phone tracking, link to Settings). Mirror the camera/biometric probe→request→alert convention.

### Mobile — share control on the order detail (`apps/mobile/app/order/[id].tsx`)
- Add `assigned_delivery_user_id` + `fulfillment_type` to the order select + `OrderHeader` (`assignedDeliveryUserId: string|null`, `fulfillmentType: string|null`).
- A `DeliveryLocationShareControl` (inline or `apps/mobile/src/components/delivery-location-share.tsx`) rendered only when `order.status === 'in_transit'` && `order.assignedDeliveryUserId === user.id` && `useEnabledModules().has('live_tracking')`.
- A toggle reflecting `isLiveLocationActive()` on mount: ON → request permissions → `startLiveLocation(orderId)`; OFF → `stopLiveLocation()`. Copy: "Share my live location — the customer can see you on the map until this delivery is complete. Keeps sharing in the background while you drive." Stop automatically if the screen sees `status !== 'in_transit'`.

### Expo config (`apps/mobile/app.config.ts`)
- iOS `infoPlist`: add `NSLocationWhenInUseUsageDescription`, `NSLocationAlwaysAndWhenInUseUsageDescription` ("StockPilot shares your location with the customer while you deliver their order, even in the background."), and `UIBackgroundModes: ['location']`.
- Android `permissions`: add `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`.
- `plugins`: add `['expo-location', { locationAlwaysAndWhenInUsePermission: '…', locationWhenInUsePermission: '…', isAndroidBackgroundLocationEnabled: true, isIosBackgroundLocationEnabled: true }]`.
- Add deps `expo-location` + `expo-task-manager` (SDK-53-compatible versions via `npx expo install`).

## Security & privacy
- Server reuses the web gates: module on + caller is the order's `assigned_delivery_user_id` + order is `delivery`+`in_transit`. A Bearer token for any other user → `forbidden`; module off → 403. Customer visibility unchanged (token+id+email + in_transit + 5-min staleness, latest-point-only, purge-on-complete — all already shipped).
- Driver explicitly opts in per delivery; iOS shows the blue background indicator; the Android foreground-service notification makes background sharing visible. Stops on toggle-off, on completion/cancel (server rejects + task self-stops), and the existing purge clears the point.

## Error handling
- Permission denied → Alert, no tracking. Background POST failure → swallowed (best-effort), retried next tick; a 4xx self-stops the task (order ended). App killed by OS → iOS may relaunch the task for significant updates; acceptable for v1 (driver can re-toggle). All fail-soft; never crashes the order screen.

## Testing
- Server: `route.test.ts` — 401 when no ctx; 400 on bad body; delegates to `shareLocation` and maps `ServiceError` codes to status (mock `withApiContext` + the service).
- Mobile background task + permissions + the toggle = **manual on device** (background GPS can't be unit-tested meaningfully). Lint + tsc must pass.

## Ship
- `pnpm tsc`/lint green (web + mobile). Merge → `main` → push (web endpoint deploys to Vercel).
- **EAS build** (native module — no OTA): `eas build --profile preview --platform ios` (TestFlight) for device verification, then `--profile production` + `eas submit`. Android analogously. Owner owns the Apple/EAS credentials (App Store/TestFlight pipeline). Update memory.
- **Fast-follow / v2:** richer background reliability (significant-change relaunch, battery tuning), an in-app "you're sharing" banner across screens, and parity polish.
