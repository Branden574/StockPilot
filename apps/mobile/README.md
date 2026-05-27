# StockPilot — Mobile (Expo)

iOS + Android client for StockPilot. Connects to the same Supabase project as the web app and renders a warm-paper editorial UI that mirrors the web's design language.

## What ships today

- **Auth** — email/password sign-in, sign-up with confirm email, Face ID / Touch ID / Fingerprint unlock via `expo-local-authentication`, post-sign-in opt-in sheet.
- **Bottom tabs** — Home, Items, POs, Counts, Scan. BlurView tab bar on iOS, Material 3 active-indicator on Android.
- **Drawer** — 21+ surfaces mirroring the web sidebar exactly. Admin section gated by role.
- **Home** — live stat cards (items, value, low, out) with sparklines + Quick Adjust + Bundles entry.
- **Inventory + Books** — searchable lists with barcode scan, category filter chips, photos pulled from `item-images` storage.
- **Item detail** — Overview tab (big on-hand + quick adjust + "Adjust with reason" modal + meta card) and Movements tab (full `stock_movements` history per item).
- **Receive POs** — list of open POs + AI-scan packing-slip hero card.
- **Cycle counts** — in-progress counts, offline cache, sync pills.
- **Scan tab** — camera-based barcode/QR/ISBN lookup + UPC enrichment + AI book cover ID.
- **Drawer surfaces with real data** — Books, Movements, Categories, Tags, Orders, Locations, Suppliers, Procedures, Rentals (+ checkout MVP), Bundles, Purchase orders, PO imports, Reports, Schedule (+ event creation MVP), Notifications (with Supabase Realtime), Team, AI Assistant (native streaming chat).
- **Admin (owner/admin only)** — Charters, Warehouses, Bins, Users, Vendor mappings, UoM conversions, Reconciliation, Audit log.
- **Push notifications** — Expo token registration in `push_tokens`, foreground handler, allowlisted deep-link tap handler, server-side fan-out via `notifyUser()`.
- **Profile photo + name sync** — reads/writes `user_profiles.avatar_url` and `full_name`, same column the web's AvatarUploader uses.

## What's intentionally a follow-up

- Streaming UI fidelity on AI chat (citations, scroll-to-bottom on tool result, message edits).
- Rental check-in with item linking + automatic stock return.
- Recurring events + drag-reschedule on the schedule.
- Image upload + custom-field editor on item edit (currently deep-links to web).
- Multi-org workspace switcher.

## Setup

```bash
# from repo root
pnpm install

# create env (DO NOT commit this file — it's gitignored)
cp apps/mobile/.env.example apps/mobile/.env.local
# fill in:
#   EXPO_PUBLIC_SUPABASE_URL  (same as web)
#   EXPO_PUBLIC_SUPABASE_ANON_KEY (same as web)
#   EXPO_PUBLIC_API_URL  (e.g. https://stockpilotusa.com — needed for /api/ai/chat, /api/v1/mobile/snapshot, /api/v1/push/test)

cd apps/mobile
```

### Fresh-clone iOS build

The app uses native modules (`react-native-svg`, `expo-blur`, `expo-linear-gradient`, `expo-local-authentication`, `expo-camera`, `expo-sqlite`, `lucide-react-native`, three `@expo-google-fonts/*` families). After a fresh `git clone`, run:

```bash
# from apps/mobile, regenerates ios/ + android/ from the Expo config plugin
# (the fmt FMT_USE_CONSTEVAL=0 fix lives in plugins/with-fmt-consteval-fix.js
# and is required for Xcode 16+ — see app.config.ts plugin array)
pnpm expo prebuild --clean

# then run the full native build + install on a booted simulator
pnpm ios

# Android emulator (requires Android Studio)
pnpm android
```

A subsequent JS-only edit just needs the running Metro server to pick it up — no rebuild required. Native dependency changes (`package.json` edits in the lockfile section above) require re-running `pnpm ios` so the new pod ships in the binary.

### Physical device

```bash
pnpm start
# Then scan the QR code with the Expo Go app on iOS / Android.
# Note: push notifications require a real device — they no-op in
# simulators because Expo's APNs/FCM tokens don't issue there.
```

## Verifying push delivery

After signing in on a real device and granting the notifications permission, hit **Settings → Send test push**. The mobile app POSTs to `/api/v1/push/test`, which fans out an Expo push to every registered device for your user (read from `push_tokens`). If you see "Sent · 1 device", push delivery is working end-to-end. Production notifications (PO approvals, delivery assignments, low stock) flow through the same `notifyUser()` path on the server.

## Architecture notes

- **`app/`** — file-based routing via `expo-router` v5.
- **`app/(auth)/`** — public sign-in / sign-up + Face ID quick-sign-in.
- **`app/(drawer)/`** — authenticated drawer + bottom tabs.
- **`app/(drawer)/admin/`** — admin-only surfaces (role-gated in `drawer-content.tsx`).
- **`app/item/[id].tsx`** — Overview + Movements tabs for any item.
- **`app/rentals/new.tsx`, `app/schedule/new.tsx`, `app/ai/chat.tsx`** — MVP write surfaces.
- **`src/components/ui/`** — design primitives (Eyebrow, Display, Em, Button, Card, Pill, Field, StatCard, Sparkline, Avatar, etc.).
- **`src/components/brand/`** — BrandMark, Wordmark, BrandLockup.
- **`src/lib/theme.ts`** — warm-paper palette, fonts, radius, space, shadow tokens.
- **`src/lib/use-theme.ts`** — theme hook + dark mirror.
- **`src/lib/use-fonts.ts`** — Inter Tight + Instrument Serif Italic + JetBrains Mono via `@expo-google-fonts`.
- **`src/lib/use-org.ts`, `use-profile.ts`, `use-role.ts`** — cached session-scoped hooks.
- **`src/lib/supabase.ts`** — Supabase JS client backed by `expo-secure-store` for the session.
- **`src/lib/api.ts`** — typed REST client to the web app's `/api/v1/*` and `/api/ai/*`.
- **`plugins/with-fmt-consteval-fix.js`** — Expo config plugin that patches the Podfile so `fmt 11.0.2` compiles under Xcode 16+. Remove once RN ships fmt 11.1+.

## Sharing with web

The mobile app imports `@stockpilot/core` for shared types and constants. Database queries hit Supabase directly via the JS SDK using the same RLS policies as the web app — every mobile-side query is automatically scoped to the user's org.

Stock adjustments call the same `adjust_stock` RPC the web's stock-adjust dialog uses, so the ledger stays consistent. Notifications insert + fan out via `createNotification()` so a row in `notifications` always coincides with a push to that user's registered devices.

## Build for the stores

Once you're ready to ship to TestFlight / Play Internal:

```bash
npm install -g eas-cli
eas login
eas build --platform ios --profile preview
eas build --platform android --profile preview
```

EAS config (`eas.json`) and asset files (`./assets/icon.png`, `./assets/splash.png`, `./assets/adaptive-icon.png`) need to be added before the first build.
