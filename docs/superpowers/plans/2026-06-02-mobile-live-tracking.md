# Mobile Live Tracking (background) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The assigned delivery driver shares live GPS from the native app — including in the background (locked phone) — while an order is `in_transit`; the customer sees it on the existing web map. Reuses the web `DeliveryTrackingService` + `live_tracking` module + `delivery_locations` (no migration).

**Architecture:** New Bearer endpoint `POST /api/v1/delivery/location` wraps `DeliveryTrackingService.shareLocation`. The mobile app uses `expo-location` + `expo-task-manager`: a registered background task POSTs the latest point (throttled by the OS location options) to that endpoint; a toggle on the order detail screen (gated to the assigned driver + in_transit + module on) starts/stops it. `expo-location` is native → an EAS build is required.

**Tech Stack:** Next.js route handler + `withApiContext`; React Native / Expo SDK 53 (`expo-location`, `expo-task-manager`, expo-router); vitest (server only).

**Spec:** [`docs/superpowers/specs/2026-06-02-mobile-live-tracking-design.md`](../specs/2026-06-02-mobile-live-tracking-design.md)

**Conventions (verified):**
- API route: `const ctx = await withApiContext(req); if(!ctx) return NextResponse.json({error:'unauthenticated'},{status:401});` then zod-parse body → 400; `new DeliveryTrackingService(ctx)`; catch `ServiceError`→status. Mirror `apps/web/src/app/api/v1/cycle-counts/route.ts`. `runtime='nodejs'`, `dynamic='force-dynamic'`.
- `DeliveryTrackingService` (`apps/web/src/server/services/delivery-tracking.ts`): public `constructor(ctx)`, `async shareLocation(orderId, {lat,lng,heading?,accuracy?})`. `ServiceError` from `@/server/services/context`.
- Mobile API: `api<T>(path,{method,body})` from `apps/mobile/src/lib/api.ts` (Bearer + org header; throws on non-2xx). Module gate: `useEnabledModules()` from `apps/mobile/src/lib/enabled-modules.ts`. Auth user: `useAuth()` from `apps/mobile/src/lib/auth-context`.
- `expo-location` + `expo-task-manager` are ALREADY installed by the controller (do NOT run `expo install`).
- Run: web `cd apps/web && pnpm vitest run <p>` / `pnpm tsc --noEmit`; mobile `cd apps/mobile && pnpm tsc --noEmit` (+ `pnpm lint` if present). Mobile runtime behavior = manual on device.

---

## Task 1: Server endpoint `POST /api/v1/delivery/location` (TDD)

**Files:**
- Create: `apps/web/src/app/api/v1/delivery/location/route.ts`
- Test: `apps/web/src/app/api/v1/delivery/location/route.test.ts`

- [ ] **Step 1: Read** `apps/web/src/app/api/v1/cycle-counts/route.ts` (the full `withApiContext` + body-parse + `ServiceError`→status mapping) to mirror it.

- [ ] **Step 2: Failing test** `route.test.ts`:
```typescript
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const withApiContext = vi.fn();
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: (...a: unknown[]) => withApiContext(...a) }));
const shareLocation = vi.fn();
vi.mock('@/server/services/delivery-tracking', () => ({
  DeliveryTrackingService: vi.fn().mockImplementation(() => ({ shareLocation })),
}));

import { POST } from './route';

function req(body: unknown) {
  return new NextRequest('http://localhost/api/v1/delivery/location', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/v1/delivery/location', () => {
  it('401 when unauthenticated', async () => {
    withApiContext.mockResolvedValueOnce(null);
    const res = await POST(req({ orderId: '11111111-1111-1111-1111-111111111111', lat: 1, lng: 2 }));
    expect(res.status).toBe(401);
  });

  it('400 on invalid body', async () => {
    withApiContext.mockResolvedValueOnce({ userId: 'u1', organizationId: 'o1' });
    const res = await POST(req({ orderId: 'not-a-uuid', lat: 999, lng: 2 }));
    expect(res.status).toBe(400);
  });

  it('delegates to shareLocation and returns 200', async () => {
    withApiContext.mockResolvedValueOnce({ userId: 'u1', organizationId: 'o1' });
    shareLocation.mockResolvedValueOnce(undefined);
    const res = await POST(req({ orderId: '11111111-1111-1111-1111-111111111111', lat: 36.7, lng: -119.7, heading: 90, accuracy: 5 }));
    expect(res.status).toBe(200);
    expect(shareLocation).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111', { lat: 36.7, lng: -119.7, heading: 90, accuracy: 5 });
  });

  it('maps a forbidden ServiceError to 403', async () => {
    withApiContext.mockResolvedValueOnce({ userId: 'u1', organizationId: 'o1' });
    const { ServiceError } = await import('@/server/services/context');
    shareLocation.mockRejectedValueOnce(new ServiceError('forbidden', 'nope'));
    const res = await POST(req({ orderId: '11111111-1111-1111-1111-111111111111', lat: 1, lng: 2 }));
    expect(res.status).toBe(403);
  });
});
```
Run (expect FAIL): `cd apps/web && pnpm vitest run src/app/api/v1/delivery/location/route.test.ts`.

- [ ] **Step 3: Implement** `route.ts`:
```typescript
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import { DeliveryTrackingService } from '@/server/services/delivery-tracking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  orderId: z.string().uuid(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  heading: z.number().min(0).max(360).optional(),
  accuracy: z.number().nonnegative().optional(),
});

// Mobile driver location ping. Bearer-auth'd; reuses the web service's gates
// (live_tracking module + assigned-driver + in_transit). Both foreground and
// the background TaskManager task POST here.
export async function POST(req: NextRequest) {
  try {
    const ctx = await withApiContext(req);
    if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

    const json = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid input' },
        { status: 400 },
      );
    }

    const { orderId, ...point } = parsed.data;
    const svc = new DeliveryTrackingService(ctx);
    await svc.shareLocation(orderId, point);
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e) {
    if (e instanceof ServiceError) {
      const status =
        e.code === 'not_found' ? 404
        : e.code === 'validation_error' ? 400
        : e.code === 'forbidden' || e.code === 'module_disabled' ? 403
        : 500;
      return NextResponse.json({ error: e.code, message: e.message }, { status });
    }
    return NextResponse.json({ error: 'internal_error', message: 'Unexpected error' }, { status: 500 });
  }
}
```
(`new DeliveryTrackingService(ctx)` — the constructor is public; the ctx from `withApiContext` already carries `enabledModules`/`userId`/`organizationId`/`supabase`, so the service's gates work unchanged.)

- [ ] **Step 4: Verify + commit**
```bash
cd apps/web && pnpm vitest run src/app/api/v1/delivery/location/route.test.ts && pnpm tsc --noEmit
git add "apps/web/src/app/api/v1/delivery/location/route.ts" "apps/web/src/app/api/v1/delivery/location/route.test.ts"
git commit -m "feat(live-tracking-mobile): POST /api/v1/delivery/location (Bearer) reusing DeliveryTrackingService"
```

---

## Task 2: Expo config — location permissions + plugin

**Files:**
- Modify: `apps/mobile/app.config.ts`
- (deps `expo-location` + `expo-task-manager` already added by the controller — confirm they're in `apps/mobile/package.json`)

- [ ] **Step 1: Confirm deps** — `grep -E "expo-location|expo-task-manager" apps/mobile/package.json` (both present). If missing, STOP and report BLOCKED (the controller installs them).

- [ ] **Step 2: iOS infoPlist** — in `app.config.ts` under `ios.infoPlist`, add:
```typescript
      NSLocationWhenInUseUsageDescription:
        'StockPilot shares your location with the customer while you deliver their order.',
      NSLocationAlwaysAndWhenInUseUsageDescription:
        'StockPilot shares your location with the customer while you deliver their order, even when the app is in the background.',
      UIBackgroundModes: ['location'],
```

- [ ] **Step 3: Android permissions** — change `android.permissions` to:
```typescript
    permissions: [
      'CAMERA',
      'READ_MEDIA_IMAGES',
      'ACCESS_FINE_LOCATION',
      'ACCESS_COARSE_LOCATION',
      'ACCESS_BACKGROUND_LOCATION',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_LOCATION',
    ],
```

- [ ] **Step 4: expo-location plugin** — add to the `plugins` array (after `expo-notifications`, before the local-auth/fmt entries is fine):
```typescript
    [
      'expo-location',
      {
        locationWhenInUsePermission:
          'StockPilot shares your location with the customer while you deliver their order.',
        locationAlwaysAndWhenInUsePermission:
          'StockPilot shares your location with the customer while you deliver their order, even when the app is in the background.',
        isAndroidBackgroundLocationEnabled: true,
        isIosBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
      },
    ],
```

- [ ] **Step 5: Verify + commit** — `cd apps/mobile && pnpm tsc --noEmit` (config typechecks).
```bash
git add apps/mobile/app.config.ts apps/mobile/package.json
git commit -m "feat(live-tracking-mobile): expo-location/task-manager deps + background-location config (iOS Always + UIBackgroundModes, Android bg + foreground service)"
```

---

## Task 3: Background location task + registration

**Files:**
- Create: `apps/mobile/src/lib/location-task.ts`
- Modify: `apps/mobile/app/_layout.tsx` (import the task module once so `defineTask` registers)

- [ ] **Step 1: Read** `apps/mobile/app/_layout.tsx` (find a top-level import spot) and `apps/mobile/src/lib/api.ts` (confirm the `api` import path + signature).

- [ ] **Step 2: Implement** `apps/mobile/src/lib/location-task.ts`:
```typescript
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import { api } from './api';

export const LIVE_LOCATION_TASK = 'stockpilot-live-location';
const ORDER_KEY = 'liveTracking.orderId';

interface LocationTaskBody {
  locations?: Location.LocationObject[];
}

// Background task: on each batch, POST the latest fix for the active order.
// Best-effort; a 4xx (order no longer in_transit / not the assigned driver)
// self-stops so a stale task can't keep firing.
TaskManager.defineTask(LIVE_LOCATION_TASK, async ({ data, error }) => {
  if (error) return;
  const orderId = await AsyncStorage.getItem(ORDER_KEY);
  if (!orderId) {
    await stopLiveLocation();
    return;
  }
  const locs = (data as LocationTaskBody)?.locations ?? [];
  const last = locs[locs.length - 1];
  if (!last) return;
  try {
    await api('/api/v1/delivery/location', {
      method: 'POST',
      body: {
        orderId,
        lat: last.coords.latitude,
        lng: last.coords.longitude,
        heading: last.coords.heading != null && last.coords.heading >= 0 ? last.coords.heading : undefined,
        accuracy: last.coords.accuracy ?? undefined,
      },
    });
  } catch (e) {
    // 4xx = order ended / not assigned / module off → stop. Other errors: keep
    // trying on the next OS tick (transient network).
    if (e instanceof Error && /API 4\d\d/.test(e.message)) {
      await stopLiveLocation();
    }
  }
});

export async function isLiveLocationActive(): Promise<boolean> {
  try {
    return await Location.hasStartedLocationUpdatesAsync(LIVE_LOCATION_TASK);
  } catch {
    return false;
  }
}

export async function startLiveLocation(orderId: string): Promise<void> {
  await AsyncStorage.setItem(ORDER_KEY, orderId);
  const alreadyOn = await isLiveLocationActive();
  if (alreadyOn) return;
  await Location.startLocationUpdatesAsync(LIVE_LOCATION_TASK, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: 12_000,
    distanceInterval: 25,
    showsBackgroundLocationIndicator: true,
    pausesUpdatesAutomatically: false,
    foregroundService: {
      notificationTitle: 'Sharing your delivery location',
      notificationBody: 'The customer can see you on the map until this delivery is complete.',
    },
  });
}

export async function stopLiveLocation(): Promise<void> {
  await AsyncStorage.removeItem(ORDER_KEY);
  try {
    if (await Location.hasStartedLocationUpdatesAsync(LIVE_LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(LIVE_LOCATION_TASK);
    }
  } catch {
    /* not started — nothing to stop */
  }
}
```

- [ ] **Step 3: Register** — in `apps/mobile/app/_layout.tsx`, add a side-effect import near the top (with the other imports): `import '@/lib/location-task';` (or the repo's relative path, e.g. `../src/lib/location-task` — match how `_layout.tsx` imports other `lib` modules). This ensures `defineTask` runs at app start. Add nothing else.

- [ ] **Step 4: Verify + commit** — `cd apps/mobile && pnpm tsc --noEmit`.
```bash
git add apps/mobile/src/lib/location-task.ts apps/mobile/app/_layout.tsx
git commit -m "feat(live-tracking-mobile): background location TaskManager task + start/stop helpers"
```

---

## Task 4: Share control on the order detail screen

**Files:**
- Modify: `apps/mobile/app/order/[id].tsx`

- [ ] **Step 1: Extend the order query + type.** In `apps/mobile/app/order/[id].tsx`:
  - Add `assigned_delivery_user_id, fulfillment_type` to the `.select(...)` string (the `order_requests` select ≈ line 160).
  - Add to the `OrderHeader` interface: `assignedDeliveryUserId: string | null;` + `fulfillmentType: string | null;`.
  - In the `setOrder({...})` mapping, add `assignedDeliveryUserId: (r.assigned_delivery_user_id as string | null) ?? null,` and `fulfillmentType: (r.fulfillment_type as string | null) ?? null,`.

- [ ] **Step 2: Add imports** near the top of the file:
```typescript
import { useEnabledModules } from '@/lib/enabled-modules';
import { isLiveLocationActive, startLiveLocation, stopLiveLocation } from '@/lib/location-task';
import * as Location from 'expo-location';
```
(Match the file's existing import alias style — it uses `@/lib/...`.)

- [ ] **Step 3: Add the control.** Inside the component, compute:
```typescript
  const enabledModules = useEnabledModules();
  const canShareLocation =
    order?.status === 'in_transit' &&
    order?.assignedDeliveryUserId === user?.id &&
    order?.fulfillmentType === 'delivery' &&
    enabledModules.has('live_tracking');
  const [sharing, setSharing] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    void isLiveLocationActive().then((on) => { if (active) setSharing(on); });
    return () => { active = false; };
  }, []);
  // Stop if the order is no longer in transit while the screen is open.
  React.useEffect(() => {
    if (order && order.status !== 'in_transit' && sharing) {
      void stopLiveLocation().then(() => setSharing(false));
    }
  }, [order?.status, sharing]);

  const onToggleShare = React.useCallback(async () => {
    if (sharing) {
      await stopLiveLocation();
      setSharing(false);
      return;
    }
    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') {
      Alert.alert('Location needed', 'Allow location access to share your delivery location with the customer.');
      return;
    }
    const bg = await Location.requestBackgroundPermissionsAsync();
    if (bg.status !== 'granted') {
      Alert.alert(
        'Background location off',
        'Sharing will pause when the app is in the background. Enable "Always" location in Settings for full live tracking while you drive.',
      );
    }
    if (!order) return;
    await startLiveLocation(order.id);
    setSharing(true);
  }, [sharing, order]);
```
Then render a control where the order actions live (near the status/signature section — read the surrounding JSX and match its `View`/`Text`/`Pressable`/`Button` components + theme tokens `c.*`). Minimal version:
```tsx
{canShareLocation ? (
  <View style={{ gap: 8 }}>
    <Text style={{ /* match the section heading style used elsewhere */ }}>Live delivery tracking</Text>
    <Text style={{ /* muted caption style */ }}>
      The customer can see you on the map until this delivery is complete. Keeps sharing in the background while you drive.
    </Text>
    <Pressable onPress={onToggleShare} style={{ /* match an existing primary/secondary button */ }}>
      <Text>{sharing ? 'Stop sharing location' : 'Share my live location'}</Text>
    </Pressable>
  </View>
) : null}
```
Use whatever button/typography primitives the file already imports (it has themed `c` colors, `Eyebrow`, etc.) — DO NOT introduce a new design system; match the existing components in this screen. Ensure `Alert` is imported from `react-native` (add to the existing RN import if not already present).

- [ ] **Step 4: Verify + commit** — `cd apps/mobile && pnpm tsc --noEmit` (+ `pnpm lint` if configured).
```bash
git add "apps/mobile/app/order/[id].tsx"
git commit -m "feat(live-tracking-mobile): driver share-location toggle on the order detail (in_transit + assigned + module-gated)"
```

---

## Final verification + ship
- [ ] `cd apps/web && pnpm tsc --noEmit && pnpm vitest run src/app/api/v1/delivery/location` → green.
- [ ] `cd apps/mobile && pnpm tsc --noEmit` → clean (+ lint if present).
- [ ] Spec coverage: endpoint (T1), expo config+deps (T2), background task (T3), driver toggle + query fields (T4). No migration (reuses 0164). Customer map already live on web.
- [ ] Ship: merge `mobile-live-tracking` → `main` → push (the web endpoint deploys to Vercel — safe/additive). Then **EAS build** (native module, no OTA): `eas build --profile preview --platform ios` for TestFlight device verification, then `--profile production` + `eas submit` (Android analogously). Owner owns Apple/EAS creds. Verify on device: enable `live_tracking`, open an in-transit delivery as the assigned driver, toggle sharing, confirm the point appears on the web `/r/track` (distance updates) and keeps updating with the app backgrounded. Update memory.

## Notes
- The native module means OTA can't deliver this — a fresh EAS build + store/TestFlight submit is required. The web endpoint itself ships immediately via Vercel and is harmless until a build calls it.
- v2 fast-follow: significant-change relaunch after app kill, battery/accuracy tuning, a global "you're sharing location" banner, and surfacing the live map inside the native app for managers.
