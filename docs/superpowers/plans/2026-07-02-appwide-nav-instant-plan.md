# App-wide dashboard navigation — make every tab transition feel instant

**Date:** 2026-07-02 (session of 2026-07-01 evening)
**Scope:** every dashboard tab (Overview, Items, Books, Staging, Movements,
Orders, POs, Returns, Cycle counts, Locations, Suppliers, Reports, Admin…),
using the playbook that took `/dashboard/orders/new` from 5–6s to 46ms TTFB
(see `2026-07-01-orders-new-instant-plan.md`).
**Bar:** soft-nav between any two tabs shows a route-true skeleton <100ms and
real content <1s warm; a hard load after a deploy never regresses past ~2s.

---

## 0. What is ALREADY done — do not re-flag

Verified in code this session:

- `withContext()` request-dedupe: org row / modules / MFA factors ride
  `React.cache()` helpers shared with the layout
  (`src/server/services/context.ts:103`, `src/lib/dashboard/request-cache.ts`).
- `staleTimes: { dynamic: 90, static: 180 }` in `next.config.ts:55` — client
  router cache holds visited/prefetched tabs 90s.
- Overview, Items, Books, Staging stream their heavy body behind `<Suspense>`
  with the shell painting first; Items/Books paginate at 30 rows.
- Route-specific `loading.tsx` exists on 18 of 26 dashboard sections.
- Sidebar links are `prefetch={false}` with hover/focus/pointer-down intent
  warming (`src/components/dashboard/sidebar.tsx:225-235`).
- orders/new P1–P5 shipped: thumb backfill + capped signer, light warehouses
  via `getWarehousesForRequest`, stable loader module
  (`src/server/loaders/orders-new-catalog.ts`), prewarm cron
  (`/api/cron/prewarm-orders-catalog`, every 30 min), branded loading.tsx.
- Items/Books row thumbnails sign through a per-path 25-day data-cache
  (`getCachedItemImageSignedUrl`) — warm renders don't re-sign.
- Middleware matcher is an allowlist; anonymous surfaces skip the auth RTT
  (`src/proxy.ts:31`).
- The proxy forwards `x-stockpilot-user-id` / `x-stockpilot-user-email` only
  after `auth.getUser()` validation and deletes them otherwise
  (`src/lib/supabase/middleware.ts:107-113`).

Orders/new P6 (layout auth-RTT trim) and P7 (persisted signed URLs) were
explicitly left undone — P6 is picked up here as P1d; P7 stays a follow-up.

---

## 1. Evidence

### 1.1 What could and could not be measured

Vercel CLI runtime logs (`npx vercel logs --json`, 4.2-minute live capture,
63 unique entries, saved to session scratchpad) carry **no per-request
durations** — same limitation the orders/new investigation hit. The capture
confirms live traffic shape (owner navigating `/dashboard/books`,
`/dashboard/orders`, `/dashboard/orders/new`; every serverless entry
`cache: MISS`) and that 4 production deploys shipped in the 21 minutes before
capture — deploy-adjacent cold paths are still the owner's normal testing
condition. Layer timings below therefore come from: `pg_stat_statements` on
prod (direct SQL, this session), row counts on the owner's org, code-level
round-trip counting, and the measured layer costs from the 2026-07-01
investigation (middleware auth RTT ~50–150ms, GoTrue call ~40–100ms, cold
lambda init ~1–2.5s).

### 1.2 pg_stat_statements (prod, this session)

| Query (family) | Calls | Mean | Max | Total |
|---|---|---|---|---|
| **warehouses HEAVY embed** (`WarehousesService.list()`: manager profile + assignments + ALL item ids + charters) | 6,045 | 25.1ms | **731.7ms** | **152.0s** |
| stock_movements 30-day metrics w/ item embed (Overview `getThirtyDayMetrics`) | 1,068 | **81.3ms** | 346.4ms | 86.8s |
| stock_movements history family (Overview `getDashboardHistory` 30d/90d + `getItemTrends`, several statement shapes) | ~8,600 | 4–75ms | 714.8ms | ~100s combined |
| warehouses `select id` (`getWarehouseAccess`, every dashboard render) | 28,318 | 1.5ms | 428.9ms | 41.2s |
| warehouses `select id,name` (`getWarehousesForRequest` — the LIGHT list) | 6,737 | 1.5ms | 104.5ms | 9.8s |
| charters full list | 4,294 | 4.4–5.8ms | 283ms | 21.3s |
| inventory_items catalog select (orders/new) | 144 | 70.3ms | 173.7ms | 10.1s |

The single worst repeated statement in the dashboard's read path is the
warehouses heavy embed — and (verified below) almost every caller throws the
embed away.

### 1.3 Data shape (owner org L4L, prod SQL this session)

items 363 · warehouses 2 · locations 42 · suppliers 10 · POs 18 · returns 0 ·
cycle counts 12 · members 8 · movements 159 (30d) / 677 (90d).

Implication: today's slowness is **round-trips, herd concurrency, and cold
paths — not row volume**. The unbounded list queries (POs, returns,
locations, suppliers) are scale hazards to note, not current hotspots.

### 1.4 Per-route audit (what a soft-nav to each tab pays)

Every soft nav first pays the fixed tax: middleware `auth.getUser()` RTT →
page segment render → `requireOrgContext` (profile ∥ membership; +1
**sequential** membership query when the arbitrary `limit(1)` row isn't the
default org — real for the owner, who belongs to 2 orgs;
`src/lib/auth/session.ts:115-136`) → `withContext` (org row ∥ modules ∥ MFA
factors, request-cached). Owner role short-circuits the permissions read.
That is ~4–6 network hops before any page query starts.

| Route | Awaited before flush (beyond fixed tax) | Warm queries | Streams? | loading.tsx | Dominant cost / hazard |
|---|---|---|---|---|---|
| `/dashboard` (Overview) | orgRow + optional warehouse name | ~15 in one ∥ fan-out | ✓ body | **✗ (generic group-level)** | stock_movements family: 30d metrics 81ms mean + 2× history windows + trends, uncached per request |
| `/inventory` (Items) | racks distinct | ~15 (∥) | ✓ table | ✓ | 30 rows + full `custom_fields` per row; signed URLs (cached); placement expansion |
| `/books` | module gates ×2, racks | ~13 (∥) | ✓ table | ✓ | same as Items; book covers larger |
| `/inventory/staging` | — | 5 | ✓ table | inherits inventory's | **heavy warehouses embed** + 3-query worklist chain |
| `/movements` | — | 2 | ✗ | ✓ | 51 rows, well-shaped — already good |
| `/orders` | module gate | 2–3 | ✗ | ✓ | 51 rows + 3 embeds — fine |
| `/purchase-orders` | module gate + **sequential admin settings query** | 3–4 | ✗ | ✓ | `fetchAllRows` over ALL POs + suppliers + stats in JS (scale hazard; 18 rows today) |
| `/returns` | module gate | 2 | ✗ | **✗** | unbounded `select('*')` (0 rows today); generic skeleton |
| `/cycle-counts` | module gate | 4 | ✗ | ✓ | **heavy warehouses embed** + members query fired sequentially AFTER the lists |
| `/locations` | — | 2 | ✗ | ✓ | light — fine |
| `/suppliers` | module gate (sequential) | 2 | ✗ | ✓ | light — fine |
| `/reports` | module gate | ~1 | static | ✓ | fine |
| `/admin` | 2nd `auth.getUser` + 5 ∥ head-counts | 7 | ✗ | ✓ | fine |
| `/admin/warehouses` | — | 4 | ✗ | ✓ (admin) | **heavy warehouses embed, 100% of embed fields unused** |
| `/warehouses` | heavy embed (legit consumer of counts) | ~3 | ✗ | **✗** | embed ships ALL item ids per warehouse to count them |
| `/inventory/new`, `/books/new`, `/schedule/new`, `/procedures`, `/settings/public-requests`, `/admin/bins`, `/purchase-orders/imports/[id]` | heavy embed each | — | — | — | all verified to consume **only `{id, name}`** |

### 1.5 The prefetch herd, quantified

`sidebar.tsx:104-151`: on every **hard** landing the sidebar immediately
`router.prefetch()`s the top-5 routes, then at idle (≤600ms) prefetches the
remaining ~20 `DASHBOARD_NAV_HREFS`. `router.prefetch()` performs a full
dynamic RSC render per route. Cost per landing, server-side:
~25 lambda invocations + ~25 middleware `auth.getUser()` RTTs + on the order
of **150+ DB queries** (Items ~15, Overview ~15, POs fetch-all, cycle-counts
4 + heavy embed…) fired inside ~2s — exactly the 20:41:55–57 burst in the
2026-07-01 log timeline. All of it competes with the page the user is
actually reading (lambda concurrency, Supabase pool, GoTrue rate).
`staleTimes.dynamic = 90` means any herd entry not clicked within 90s is
re-fetched on nav anyway — the herd buys almost nothing beyond the top-5 +
intent warming that already exist. (This also explains `getWarehouseAccess`'s
28k calls — every prefetched segment re-runs it.)

### 1.6 The layout's own cost (hard loads + herd renders)

`(dashboard)/layout.tsx:45-93` awaits `requireOrgContext` →
`currentUserIsPlatformAdmin()` → **a second GoTrue `auth.getUser()` RTT**
(`platform-admin.ts:41-46`) → an 8-way ∥ fan-out (warehouse access, filter
cookie, org row, MFA factors, memberships+org embed, unread count, warehouses
light list, modules). The second `getUser()` exists only to decide whether to
show the "Platform admin" account-menu link. The middleware already validated
the user and forwards the verified email header on every matched route; the
page-context chain already trusts the sibling `x-stockpilot-user-id` header
for the entire org context (`session.ts:60-63`). Trusting
`x-stockpilot-user-email` for **link visibility only** is the same trust
chain; the hard gates (`requirePlatformAdmin`, `checkPlatformAdmin` — live
`getUser()` + AAL2 + fresh step-up) stay untouched.

---

## 2. The fix plan (prioritized)

### P1 — implemented this session (working tree)

**P1a — Take the heavy warehouses embed off every dropdown caller.**
Add `WarehousesService.listNames()` (`select id,name`, active-only, same RLS
client + ordering) and switch the 9+ verified `{id,name}`-only callers:
staging, cycle-counts, procedures, settings/public-requests, admin/bins,
admin/warehouses, inventory/new, books/new, schedule/new,
purchase-orders/imports/[id] (each re-verified at swap time).
*Evidence:* §1.2 row 1 (6,045 calls, max 732ms, 152s total); §1.4 caller
audit. *Gain:* removes a 25–732ms query + its transfer (hundreds of item ids
per warehouse) from ~10 pages' first flush; DB total for the statement family
drops toward the true consumers (the Warehouses page). *Risk:* low —
mechanical, active-only filter preserved; callers compile-checked.

**P1b — Cull the prefetch herd: keep top-5 + intent, drop the idle ~20.**
Remove the phase-2 `requestIdleCallback` warmup in `sidebar.tsx`; keep the
immediate top-5 warm and the hover/focus/pointer-down `warmRoute`.
*Evidence:* §1.5. *Gain:* ~20 lambda invocations, ~20 auth RTTs, ~150 DB
queries removed from every hard landing; less contention for the page being
read; herd entries were expiring at 90s unused. Perceived nav for non-top-5
tabs is preserved by pointer-down warming + route-true loading.tsx (P1c) —
the skeleton is client-cached and paints <100ms. *Risk:* low; first click on
a rarely-used tab from a keyboard (no hover) shows skeleton-first instead of
instant-full — acceptable, and identical to today-after-90s.

**P1c — Route-true `loading.tsx` for every remaining section.**
Add: `returns` (table skeleton), `insights`, `planning`, `ai`, `zendesk`,
`warehouses` (page skeletons — `warehouses/` has no index page, but the
boundary keeps its `[id]` detail off the Overview skeleton), and an
Overview-shaped `dashboard/loading.tsx` (greeting header + stat/chart blocks
mirroring `DashboardBodySkeleton`). With all children covered, the
Overview-shaped file applies only to `/dashboard` itself — any FUTURE child
section must ship its own loading.tsx or it will flash the Overview shape. *Evidence:* §1.4 loading column; the
orders/new P5 lesson — the generic `PageSkeleton` is what reads as "slow".
*Gain:* every tab paints a correctly-shaped skeleton in ~0ms on soft nav.
*Risk:* none.

**P1d — (orders/new P6) Drop the layout's second GoTrue RTT.**
New `currentUserIsPlatformAdminFromRequestHeader()` reads
`x-stockpilot-user-email` (middleware-verified, matcher-covered, deleted when
unauthenticated) and gates ONLY the account-menu link in
`(dashboard)/layout.tsx`. `getVerifiedEmail()` and every hard gate keep the
live `auth.getUser()` + AAL2 + step-up checks. Unit tests assert the header
path. *Evidence:* §1.6; prior plan P6. *Gain:* 40–100ms off first flush of
every hard dashboard load (and every herd render that survives P1b).
*Risk:* medium (security-sensitive) — mitigated by scope (cosmetic link
visibility), the documented trust chain, and unchanged hard gates.

**P1e — One-round-trip org-context resolution for multi-org users.**
`loadSessionAndContext` (`session.ts:66-136`) fetches ONE arbitrary
membership, then issues a **second sequential** membership query whenever it
isn't the default org — a per-request penalty for every multi-org user
(the owner). Fetch all accepted memberships in the same parallel pair and
pick the default in JS (same fallback semantics). *Gain:* one sequential DB
RTT removed from the fixed tax of ~50% of the owner's requests. *Risk:* low —
selection semantics preserved exactly; membership counts are tiny.

### P2 — Overview aggregates: stable cached loader + prewarm (NEXT, not done)

The Overview's `getThirtyDayMetrics` + `getDashboardHistory(30d)` +
`getDashboardHistory(90d)` + valuation views are ~7 of its ~15 queries and
the only ones with real weight (§1.2 row 2–3; 80–200ms of DB per visit,
uncached, recomputed every render and every prefetch). Move them into a
stable `src/server/loaders/dashboard-overview.ts` module wrapped in
`unstable_cache` keyed `(orgId, warehouseFilter)` with a 120–300s TTL +
`revalidateTag('dashboard-metrics-{org}')` fired from movement-writing
actions, and add the known-hot org pairs to the existing prewarm cron
(`/api/cron/prewarm-orders-catalog` — rename or add a sibling). Follow the
orders-new admin-client + page-perimeter pattern; counts are org-scoped, not
user-scoped, so no accessKey needed, but the low-stock list and "needs
attention" counts must stay live (they gate actions). NOT implemented now:
freshness semantics on the flagship page + tag wiring across many write
actions needs its own review pass.
*Expected gain:* Overview body resolve ~0.8–1.5s → ~100–300ms warm.

### P3 — Purchase-orders page diet

(a) Fold the admin approval-threshold `organization_modules` settings query
into the existing `Promise.all` (1 sequential RTT today,
`purchase-orders/page.tsx:106-111`). (b) Stop `fetchAllRows`-ing the whole PO
history to compute stats in JS — either SQL aggregates (count/sum by status)
or reuse the paginated page + a cached stats loader. 18 rows today, so (b) is
a scale guard, not urgent. *Risk:* low/medium.

### P4 — Cycle-counts: parallelize the members lookup

The `organization_members` query fires after the lists resolve
(`cycle-counts/page.tsx:50-55`); hoist into the first `Promise.all`. One RTT.
*Risk:* trivial.

### P5 — Layout memberships dedupe

The layout's org-switcher memberships query (`layout.tsx:76-80`) and
`loadSessionAndContext`'s membership read overlap; after P1e both fetch all
memberships. Extend the session loader's row (add `logo_url`) and share via a
request-cache helper — one query instead of two on hard loads. *Risk:* low,
but touches the auth loader — do deliberately, not in this pass.

### P6 — Warehouses page true-consumer embed diet

For the pages that DO show counts (`/dashboard/warehouses`), the embed ships
**every inventory_items id per warehouse** just to `.length` them
(`warehouses.ts:113`). Replace with count aggregates
(`items:inventory_items!warehouse_id(count)`) behind a spike to confirm
Supabase aggregate-function availability on this project, else two head-count
queries. Also add `warehouses/loading.tsx` (done in P1c). *Risk:* medium
(PostgREST aggregate support must be verified).

### P7 — (orders/new P7) Persisted signed thumb URLs

Unchanged from the prior plan: persist `signed_thumb_url`/`signed_until` on
`item_images` (migration 0221) so deploys stop rotating tokens and busting
the browser cache for ~348 thumbnails. Applies to orders/new AND the
Items/Books row thumbs (their 25-day data-cache entries also die on key
rotation whenever `item-images.ts` is edited). *Risk:* medium (new write
path from a read path — use `after()`/cron).

### Later / explicitly not now

- Disclosed caps for returns/locations/suppliers lists (bug-pattern #6:
  disclose silent caps) once any org approaches ~1k rows.
- PPR / `use cache` for the dashboard shell — same spike note as the prior
  plan.
- Per-section Suspense on the non-streaming list pages — loading.tsx already
  covers the perceived gap; only worth it if a single query dominates.

---

## 3. Acceptance test for the bar

From a logged-in browser after P1 ships: hard-load `/dashboard`, then click
through Items → Books → Staging → Orders → POs → Returns → Cycle counts →
Locations → Suppliers → Reports → Admin → Overview. Every transition must
paint a route-true skeleton <100ms; no generic `PageSkeleton` should appear
anywhere except sections that genuinely have no shaped skeleton yet; the
Network tab should show NO burst of ~20 RSC prefetches after landing; and
`pg_stat_statements` (reset, then a day of traffic) should show the heavy
warehouses embed called only from the Warehouses/admin surfaces that render
its fields.

## 4. Implemented in this working tree (see final report)

P1a–P1e as above. P1a swapped 24 `list()` call sites across 21 page files;
`admin/warehouses` was NOT swapped — verification showed it passes the full
rows to `WarehousesManager`, a true consumer (an earlier sweep had it wrong).
Also fixed a PRE-EXISTING red test unrelated to this work
(`inventory.barcode-filter.test.ts` — its query-chain stub predated the
`.gt('quantity', 0)` placement read; fails on clean HEAD too).

Gates run and green: `tsc --noEmit`, `eslint` (touched files + all dashboard
pages), `vitest` (services + auth + dashboard components, 624 tests),
`pnpm build`.
