# StockPilot — Mobile (Expo)

iOS + Android client for StockPilot. Connects to the same Supabase project as the web app.

## What works in this Phase 7 preview

- Auth (signin / signup / signout) shared with web (Supabase Auth)
- Home dashboard with KPIs (item count, value, low stock, out of stock)
- Inventory list with search, pull-to-refresh
- Item detail with stock-adjust buttons
- **Camera barcode + QR scanner** that looks up the item by barcode/SKU and lets you adjust stock with one tap
- Settings tab with sign-out

## What's deferred

- Push notifications registration (`expo-notifications`)
- Offline queue (WatermelonDB / PowerSync)
- Image capture for items (`expo-image-picker` + presigned upload)
- Native QR generation for printing labels
- Multi-org switcher

## Setup

```bash
# from repo root
pnpm install

# create env
cp apps/mobile/.env.example apps/mobile/.env.local
# fill in:
#   EXPO_PUBLIC_SUPABASE_URL  (same as web)
#   EXPO_PUBLIC_SUPABASE_ANON_KEY (same as web)
#   EXPO_PUBLIC_API_URL  (your web app URL — http://localhost:3000 in dev)

cd apps/mobile

# Run on iOS simulator (requires Xcode)
pnpm ios

# Run on Android emulator (requires Android Studio)
pnpm android

# Run on a physical device
pnpm start
# Then scan the QR code with the Expo Go app
```

## Architecture notes

- **`app/`** — file-based routing via `expo-router` v4
- **`app/(auth)/`** — public sign-in / sign-up
- **`app/(tabs)/`** — authenticated tab bar (Home / Inventory / Scan / Settings)
- **`app/_layout.tsx`** — root gate: redirects to `(auth)` when no session, else `(tabs)`
- **`src/lib/supabase.ts`** — Supabase JS client backed by `expo-secure-store` for the session
- **`src/lib/auth-context.tsx`** — minimal session provider
- **`src/lib/api.ts`** — typed REST client to the web app's `/api/v1/*` (used for endpoints that need server-only logic, like barcode label generation)

## Sharing with web

The mobile app imports `@stockpilot/core` for shared Zod schemas and types. Database queries hit Supabase directly via the JS SDK using the same RLS policies as the web app — every mobile-side query is automatically scoped to the user's org.

Stock adjustments call the same `adjust_stock` RPC as the web's stock-adjust dialog, so the ledger stays consistent across clients.

## Build for the stores

Once you're ready to ship to TestFlight / Play Internal:

```bash
npm install -g eas-cli
eas login
eas build --platform ios --profile preview
eas build --platform android --profile preview
```

EAS config (eas.json) and assets (./assets/icon.png, ./assets/splash.png, ./assets/adaptive-icon.png) need to be added before the first build.
