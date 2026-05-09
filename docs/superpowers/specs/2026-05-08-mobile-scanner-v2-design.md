# Mobile Scanner v2 — Design Spec

**Date:** 2026-05-08
**Status:** Approved, ready for implementation plan
**Branch target:** `main`

## 1. Problem

The current Expo mobile app at `apps/mobile/` has a working camera scanner (Code 128 / EAN / UPC / QR), QR-encoded label parsing, and barcode-or-SKU lookup against `inventory_items`, plus a one-tap stock-adjust on the item card. It is read-and-tweak only.

What's missing:

- No "scan an unknown ISBN, AI looks it up, one tap to add to inventory" flow. Today, scanning a book that isn't yet in the system returns `not found` and stops.
- No `identifyFromPhoto` integration. Donations arriving without barcodes (loose paperbacks, ARCs) can't be scanned at all.
- No scan-to-receive against POs. Receiving is web-only.
- No scan-to-count for cycle counts. Counters type ISBN-by-ISBN.
- No image capture into `item-images`. Phones that walk the floor can't document condition.
- No push notifications. Cycle-count assignments and low-stock alerts only land in the web UI.
- No offline support. Donation drives at off-site events with weak Wi-Fi can't transact.

This spec turns the mobile app into a real warehouse + book intake tool that works offline and reaches floor staff via push.

## 2. Goals

- Scan-to-receive against an open PO, with a per-line receiving sheet
- Scan-to-count inside an active cycle count, with burst-mode for stacks of identical books
- ISBN-not-in-inventory → AI lookup → one-tap add (uses existing `lookupIsbn` chain server-side)
- Image capture into the `item-images` bucket from any item card
- Cover ID via the existing `identifyFromPhoto` Vision tool, exposed as a REST endpoint for mobile
- Local SQLite with a sync engine: cached snapshots for offline reads, a pending-actions queue for offline writes
- Expo Push for cycle-count assignment, low-stock crossings, bundle distribution shortages

## 3. Non-goals (v1)

- Mobile-side bundle creation / editing (read + distribute via scanner only; create stays web)
- Real-time collaboration (two counters on the same count syncing live)
- Multi-account on one device (one signed-in user at a time)
- Native widgets / Apple Watch / iPad-specific layouts
- Reusable scanner SDK for third-party use

## 4. Architecture

### 4.1 New Expo packages

- `expo-sqlite` — local DB
- `expo-image-picker` — camera capture for item images
- `expo-network` — online/offline detection
- `expo-notifications` + `expo-device` — push registration
- `expo-server-sdk` (server-side, on web app) — Expo push fanout

### 4.2 Local SQLite schema (mobile)

Mirrors only what mobile needs to read offline. Snapshots are pulled from the web; mobile is never authoritative.

```sql
items (
  id text primary key,
  sku text not null,
  name text not null,
  barcode text,
  image_signed_url text,
  image_expires_at integer,
  quantity_on_hand_cached real,
  unit_cost real,
  warehouse_id text,
  is_book integer default 0,
  last_synced_at integer not null
);
create index items_barcode_idx on items(barcode);

warehouses (id text primary key, name text not null);

purchase_orders (
  id text primary key,
  po_number text,
  status text,
  warehouse_id text,
  expected_at text,
  last_synced_at integer
);

po_lines (
  po_id text not null,
  item_id text not null,
  qty_ordered real not null,
  qty_received_cached real not null default 0,
  primary key (po_id, item_id)
);

cycle_counts (
  id text primary key,
  status text,
  warehouse_id text,
  started_at text,
  last_synced_at integer
);

cycle_count_lines (
  count_id text not null,
  item_id text not null,
  expected real not null,
  counted_cached real,
  primary key (count_id, item_id)
);

bundles (
  id text primary key,
  name text not null,
  sku text,
  preassembled_qty real default 0,
  last_synced_at integer
);

pending_actions (
  id integer primary key autoincrement,
  kind text not null,
  payload_json text not null,
  idempotency_key text not null unique,
  created_at integer not null,
  attempts integer not null default 0,
  last_error text,
  status text not null default 'pending'  -- pending | sending | ok | failed
);
create index pending_actions_status_idx on pending_actions(status);

meta (
  key text primary key,
  value text
);  -- holds 'schema_version', 'last_full_sync_at', etc.
```

### 4.3 Sync engine

Three layers:

1. **Snapshot pull** — fires on app open, on pull-to-refresh, and every 60 seconds while foregrounded. Calls `GET /api/v1/mobile/snapshot?since=<iso>` → returns delta of items / warehouses / open POs / open counts / bundles, scoped to the user's warehouse access. Mobile upserts into local DB and bumps `last_synced_at`.
2. **Action queue** — every write enqueues a row in `pending_actions` with a UUID `idempotency_key`. Worker drains while online, sending to existing server actions via REST. Settles to `status='ok'` (delete) or `status='failed'` (keep, with `last_error`).
3. **Conflict surfacing** — when the server response indicates the item state changed since the optimistic local write, mobile shows a non-destructive toast: "Stock for X was 12 when you scanned, now 8 after sync." Human decides whether to redo.

### 4.4 Schema versioning

`meta(key='schema_version')` row. Bumping the schema on a new mobile build wipes the local DB and re-pulls (acceptable — local DB isn't authoritative). No backward-compat migrations on device.

## 5. Server-side endpoints (new)

All bearer-authed via the existing `withApiContext` flow. RLS still applied.

- `GET /api/v1/mobile/snapshot?since=<iso>` — bundled delta of all entities the mobile app caches
- `GET /api/v1/items/lookup?code=<barcode_or_sku>` — single-item resolver
- `GET /api/v1/books/isbn-lookup?isbn=<isbn>` — wraps `lookupIsbn` for mobile
- `POST /api/v1/ai/identify-from-photo` (multipart) — wraps `identifyFromPhoto`
- `POST /api/v1/items` — create-or-upsert item (already exists; verify shape)
- `POST /api/v1/items/[id]/images` — image upload (verify; may already exist)
- `POST /api/v1/po/[id]/receive-line` — receive helper that enforces single-line idempotency
- `POST /api/v1/cycle-counts/[id]/lines/[lineId]/record` — record a count
- `POST /api/v1/push/register` — upsert push token
- `GET /api/v1/bundles?include=preassembled_qty` — list for mobile
- `POST /api/v1/bundles/[id]/distribute` — distribute via mobile

### 5.1 Idempotency

Every action endpoint accepts an `Idempotency-Key` header. The server stashes `(idempotency_key, response_json)` for 24 hours; replays return the cached response. Mobile uses the SQLite row id of the queued action as the key.

## 6. UI surfaces (mobile)

### 6.1 Tab structure

Existing tabs:
- Scan (general lookup + new modes added)
- Cycle counts
- Receive

New tabs:
- Bundles

### 6.2 Scan tab — modes

Mode chips at top: `Lookup | Add book | Cover ID`

- **Lookup** (default) — current behavior. Camera reads code; matched item card opens.
- **Add book** — camera reads ISBN. If item exists, opens lookup card. If not, hits `/books/isbn-lookup`, opens **AddBookCard** modal pre-filled with title/author/cover/SKU. Confirm creates the item + sets initial stock.
- **Cover ID** — camera shows a "frame the cover" overlay; tap shutter captures photo; uploads to `/ai/identify-from-photo`; **CoverConfirmCard** shows `{title, author, ISBN, confidence}` + photo thumbnail. "Looks right" → opens AddBookCard pre-filled with Vision data + photo as initial item image.

### 6.3 Per-task scanners

Opened from inside an existing entity, not the Scan tab.

#### Receive
- From a PO detail screen, tap **Scan to receive**.
- Camera with header `Receiving against PO-2024-103 · 14 lines open`.
- On scan match → bottom sheet with item card + `Receiving now: [N]` qty stepper. Confirm enqueues `receive_po_line`.
- On miss → toast `Not on this PO` + `Add as new line` button.

#### Cycle count
- From a count detail screen, tap **Scan to count**.
- Camera with header `Counting · 47 lines · 12 done`.
- On scan match → bottom sheet pre-filled with `expected` qty; tap to edit. Confirm enqueues `record_count`.
- **Burst mode** toggle in header — re-scanning the same code within 2 seconds increments counted-qty by 1 instead of opening the sheet.
- `Post count` button surfaces in the header once every line has a counted value.

#### Bundle distribution
- From a bundle detail screen, tap **Distribute**.
- Same modal pattern as the web's DistributeBundleModal but native: quantity, warehouse, schedule_event picker, live preview, button label flips for shortage.

### 6.4 Image capture

- Camera-icon button next to the existing image strip on any item card.
- Tap → `expo-image-picker` opens in camera mode.
- Compressed to ~1024px wide WebP (matches the web pipeline's transform).
- POST to `/api/v1/items/[id]/images` (multipart). Optimistic placeholder until upload settles.
- Offline: queue as `kind='upload_image'`, file URI persisted locally.

## 7. Push notifications

### 7.1 Registration

On first sign-in (or app upgrade): permission prompt → on accept, call `Notifications.getDevicePushTokenAsync()` → POST to `/api/v1/push/register` with `{ token, platform, deviceId }`. Server upserts into `push_tokens`.

### 7.2 Dispatch

New shared module `apps/web/src/lib/push/dispatch.ts`:

```ts
export async function dispatchPush(
  userId: string,
  payload: { title: string; body: string; data?: Record<string, unknown> },
): Promise<void>;
```

Uses `expo-server-sdk` to send to Expo's `/v1/push/send`. Handles receipt-checking (Expo dedupes + reports `DeviceNotRegistered`, which we use to clean up stale tokens).

Wired into:
- `cycle_count.assigned` → push to assignee
- `cycle_count.posted` → push to managers
- `inventory.item.low_stock_crossed` → push to subscribed users
- `bundle.distributed` with `shortage_recorded=true` → push to managers

### 7.3 Tap routing

`data.kind` field selects deep link:
- `cycle_count` → `/cycle-counts/[id]`
- `low_stock` → `/items/[itemId]`
- `bundle_distribution` → `/bundles/[bundleId]`

Uses Expo Router's `stockpilot://` URL scheme.

### 7.4 Token cleanup

When `dispatchPush` receives a `DeviceNotRegistered` receipt, server deletes the `push_tokens` row. No cron required.

## 8. Migration footprint

Single migration `0042_push_token_metadata.sql`:

```sql
alter table public.push_tokens
  add column if not exists notifications_enabled boolean not null default true,
  add column if not exists last_seen_at timestamptz;

create index if not exists push_tokens_user_active_idx
  on public.push_tokens(user_id) where notifications_enabled;
```

(`push_tokens.user_id` already exists from migration 0002 — confirmed in 0002_inventory.sql.)

## 9. Implementation file list

### Server (`apps/web/`)

- `apps/web/src/app/api/v1/mobile/snapshot/route.ts`
- `apps/web/src/app/api/v1/items/lookup/route.ts`
- `apps/web/src/app/api/v1/books/isbn-lookup/route.ts`
- `apps/web/src/app/api/v1/ai/identify-from-photo/route.ts`
- `apps/web/src/app/api/v1/po/[id]/receive-line/route.ts`
- `apps/web/src/app/api/v1/cycle-counts/[id]/lines/[lineId]/record/route.ts`
- `apps/web/src/app/api/v1/push/register/route.ts`
- `apps/web/src/app/api/v1/bundles/route.ts`
- `apps/web/src/app/api/v1/bundles/[id]/distribute/route.ts`
- `apps/web/src/lib/push/dispatch.ts`
- Hooks into existing services (cycle-counts, inventory, bundles) to call `dispatchPush`
- Migration `supabase/migrations/0042_push_token_metadata.sql`

### Mobile (`apps/mobile/`)

- `app/_layout.tsx` — push registration on first sign-in
- `app/(tabs)/scan.tsx` — modes (Lookup / Add book / Cover ID), AddBookCard, CoverConfirmCard
- `app/(tabs)/bundles.tsx` + `app/bundles/[id].tsx`
- `app/cycle-counts/[id]/scan.tsx` — scan-to-count
- `app/po/[id]/receive.tsx` — scan-to-receive
- `lib/db/schema.ts`
- `lib/db/migrations.ts`
- `lib/db/sync.ts` — pull + push sync
- `lib/db/queue.ts` — pending_actions worker
- `lib/api/*.ts` — typed clients for the new endpoints
- `lib/network.ts` — online/offline state hook (expo-network wrapper)
- `components/AddBookCard.tsx`, `CoverConfirmCard.tsx`, `ScanReceiveSheet.tsx`, `ScanCountSheet.tsx`, `DistributeBundleSheet.tsx`
- `app.json` — add `expo-notifications`, `expo-image-picker`, `expo-sqlite`, `expo-network` plugins

## 10. Edge cases

| Case | Behavior |
|------|----------|
| Scan unknown code in Lookup mode | Toast `Not in inventory` + `Add as book` quick action |
| Receive scan that's already fully received | Toast `Already fully received: 24/24`, soft buzz, stays in scan mode |
| Receive scan not on PO | Toast + `Add as new line` button (logs receipt against item even if PO didn't list it) |
| Cycle count scan not in scope | Toast + `Add to count` button (creates new line at qty_on_hand) |
| Burst-mode same code rapid-fire | Increments counted-qty without opening sheet; toast badge shows `Counting: <name> × N` |
| ISBN lookup misses all sources | AddBookCard becomes manual mode (title required, ISBN editable, no cover) |
| Cover ID confidence is low | Card always renders (no auto-add); confidence is informational |
| Cover ID offline | Capture works; image queues in a "TBD covers" stack for later identification |
| Image upload fails offline | Queue as `kind='upload_image'`, retry when online |
| Stock changed since scan (conflict) | Toast informs of new value; user decides whether to redo |
| Push token rejected by Expo | Server deletes the row; user re-registers next sign-in |
| Schema version bumped on upgrade | Wipe local DB, re-pull from snapshot |

## 11. Testing

- Unit (mobile): sync engine pull/push merging, queue worker retry/backoff, schema version detection
- Unit (server): idempotency replay returns cached response, push dispatch handles DeviceNotRegistered
- Integration: end-to-end scan-to-receive against a fixture PO; scan-to-count posts adjust movements; ISBN-add creates inventory_item + initial movement
- Manual QA on real device: airplane mode → make scans + adjusts → reconnect → verify all queued actions settled
- Manual QA: send a test push from the dispatch helper, confirm tap-deep-link works on iOS + Android

## 12. Rollout

Three-phase ship:

1. **Migration 0042** + push dispatch helper. Apply migration, then push commit. Web behavior unchanged.
2. **Server endpoints** for the mobile API (snapshot, isbn-lookup, identify-from-photo, push/register, receive-line, record-count, bundle endpoints). One commit, ships independently. No mobile traffic until mobile catches up.
3. **Mobile app** in waves:
   - Wave A: local DB + sync engine + Lookup mode polish (existing scanner uses the new cache)
   - Wave B: scan-to-receive, scan-to-count
   - Wave C: AddBookCard (ISBN) + CoverConfirmCard (Vision) + image capture
   - Wave D: push notifications + bundle distribution

Each mobile wave ships as a TestFlight / EAS internal build; you opt-in to QA before promoting.

## 13. Open questions

- **Expo project ID + push credentials**: need `EXPO_ACCESS_TOKEN` + EAS project to be set up. Confirm during migration 0042 phase.
- **EAS build vs bare Expo Go**: Expo Go can't carry custom native modules; the new push setup likely needs an EAS dev build. Worth confirming the team can run a custom dev client before Wave D.
- **Sync cadence default**: 60s is the proposal; tune based on field testing. Adjustable via env or remote config later.
