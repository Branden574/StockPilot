# /dashboard/orders/new — root cause of the 5–6s loads + the plan for a truly instant page

**Date:** 2026-07-01 (evening session, after perf fixes 4–6 shipped)
**Scope:** owner's account (branden574@gmail.com), org L4L North Region
(`63c13e64-92a6-4ea4-9936-6a2c26a85b4a`), warehouse DC4, 353 catalog items.
**Bar:** warm loads <500ms to the real storefront shell and <1.5s to the full
grid; cold loads never show a blank/generic skeleton for more than ~1s.

---

## 1. TL;DR — why it's still 5–6 seconds

The three perf fixes were correct but attacked the wrong dominant costs. The
measured evidence says the wait is four stacked layers, none of which was the
database (mean query times are 25–70ms):

1. **Every reload the owner did tonight hit a 0–5-minute-old deployment.**
   Three production deploys went out at ~20:08, ~20:25 and ~20:41 PT — each one
   edited `orders/new/page.tsx`, and `unstable_cache`'s implicit key includes a
   hash of the wrapped function, so **every deploy hard-reset all three caches**
   (catalog 60s, thumb map 4h, charters 5m). Combined with brand-new lambdas
   (cold init) the owner never once saw the warm path he was testing.
2. **The "batch signing" fix only batches 24% of the images.** Of 348 imaged
   items, only **85 have `thumb_path`** (batchable). The other **270 are legacy
   rows** that fall into the `transformBatch` branch — 270 *individual*
   `POST /object/sign/...` calls fired in one unbounded `Promise.all`, per cold
   recompute, per concurrently-missing request. The storage logs show exactly
   this: sign storms at 20:41:58 and 20:42:03 (two overlapping recomputes from
   his rapid reloads — `unstable_cache` doesn't coalesce concurrent misses).
   This is the multi-second tail of the catalog stream on every cold load.
3. **The pre-shell await chain is heavier than the page comment believes.**
   `WarehousesService.forCurrentUser().list()` is NOT "one small RLS-scoped
   query": it embeds `items:inventory_items!warehouse_id (id)` (363 item ids),
   `assignments`, `manager` profile and `wh_charters` through the RLS-authed
   client, and `forCurrentUser()` → `withContext()` adds the org row + MFA
   factors (GoTrue network call — org policy is `admins_required` and the owner
   is an admin, so the MFA branch always runs) + modules resolution **before
   the storefront shell can flush**. `pg_stat_statements`: that embed query has
   run 6,045 times, mean 25ms, **max 732ms**.
4. **The skeleton the owner sees is the generic `(dashboard)/loading.tsx`, and
   that's expected given the architecture.** On a soft navigation the shared
   dashboard layout does *not* re-render — only the page segment does — so the
   page bears the *entire* context chain alone (middleware `getUser` → profile
   + membership → effective-permissions pair → org row → MFA factors → modules
   → heavy warehouses embed → charters cache read), roughly 8–10 sequential
   network hops before the first byte of the storefront shell exists. Until
   then Next shows the nearest loading boundary, which is the generic
   `PageSkeleton`. On hard reloads the layout's own fan-out (including a
   *second* `auth.getUser()` inside `currentUserIsPlatformAdmin` →
   `getVerifiedEmail`) gates the first flush the same way.

There is also a hidden correctness/perception bug: re-signing on every deploy
rotates the token in every thumbnail URL, so the **browser cache is busted for
all ~348 thumbnails after each deploy** — the image burst the owner sees is a
full re-download, not a cache warm-up.

---

## 2. Evidence (what was measured, where)

### 2.1 Timeline correlation (Vercel logs × deploy list, PT, Jul 1)

| Time | Event |
|---|---|
| ~20:08 | Deploy `844dae80` (perf fix 4) Ready — edits `page.tsx` → all `unstable_cache` keys rotate |
| 20:12:33 | Owner GET `/dashboard/orders/new` (cold deploy, cold caches) |
| ~20:25 | Deploy `c80887d0` (perf fix 5) Ready — keys rotate again |
| 20:26:28→20:30:38 | Owner GETs ×4 (cold again) |
| ~20:41 | Deploy `c46410bb` (perf fix 6) Ready — keys rotate again |
| 20:41:46–50 | Owner GETs ×3 — logs show 20:41:47 served by **old** deployment `dpl_GWkQ…`, 20:41:50 by **new** `dpl_34sbe…` (alias flipped mid-session) |
| 20:41:55–57 | ~25 sidebar-route RSC prefetches hit the server in 2s (every dashboard route) — each runs the full layout fan-out |
| 20:41:58.4 & 20:42:03.4 | **Two storms of individual `POST /object/sign/item-images/...` from the lambda** (the 270 legacy transform signs; two overlapping cold recomputes) |
| 20:42:02–20:43:03 | Owner's browser re-downloads thumbnails (`GET /render/image/sign/...` + `GET /object/sign/...?token=…`) — token rotation broke HTTP cache |

Every single orders/new load tonight was within ~5 minutes of a fresh deploy.
The owner has effectively **never seen the warm path** of fixes 4–6.

### 2.2 Database is not the bottleneck (`pg_stat_statements`, prod)

| Query | Calls | Mean | Max |
|---|---|---|---|
| warehouses **heavy embed** (`WarehousesService.list`) | 6,045 | 25.1ms | **731.7ms** |
| inventory_items catalog select | 144 | 70.3ms | 173.7ms |

### 2.3 Data-shape facts (prod SQL, org L4L / warehouse DC4)

- 353 catalog items, 10 categories + 6 uncategorized (→ 11 sections in "All").
- 355 `item_images` rows; 348 items with an image.
- **85 rows have `thumb_path` (batch-signable); 270 are legacy** (`storage_path`
  only) → individual transform signs. The code comment says "typically a
  handful"; it is 76% of the catalog.
- LQIP total is 89KB (not the ~700KB the older comment assumed).
- 0 open stock reservations; warehouses: DC4 (362 raw items), ETC Lancaster (1).
- `organizations.mfa_policy = 'admins_required'` → MFA branch always runs for
  the owner.
- Estimated RSC flight for the catalog row: 353 items × ~450B + 348 signed
  URLs × ~310 chars ≈ **250–300KB** — meaningful but a secondary cost.

### 2.4 What could NOT be measured directly, and the plan for it

Vercel CLI runtime logs don't expose per-invocation durations/init durations,
unauthenticated reproduction is blocked by Bot Protection (curl → 429), and no
test-account credentials exist locally. §5 adds permanent, guarded
instrumentation so the next investigation reads numbers instead of inferring.

---

## 3. The waterfall as it exists today (cold, right after a deploy)

```
0ms      middleware (serverless): auth.getUser() network RTT            ~50–150ms
         [cold lambda init for a Next app this size]                    ~1000–2500ms
         ── hard reload: layout + page render concurrently ──
         layout: requireOrgContext (profile+member ∥, perms ∥)          ~60–120ms
                 + currentUserIsPlatformAdmin → 2nd auth.getUser()      ~40–100ms
                 + 8-way fan-out incl. auth.mfa.listFactors (GoTrue)    ~60–150ms
         page:   withContext (org row, factors, modules — mostly shared)
                 → warehouses HEAVY embed (25ms mean / 732ms max)       ~50–750ms
                 → charters unstable_cache MISS (query + cache write)   ~100–250ms
   ≈ first flush = layout done; loading.tsx (generic PageSkeleton) shows
   ≈ page pre-JSX done → storefront shell + CatalogSkeleton streams
         catalogPromise (background):
                 accessKey: 1–2 serial uncached queries                 ~40–90ms
                 catalog items MISS (70–175ms) + 3 ∥ queries            ~150–300ms
                 thumb map MISS: item_images query + 85-path batch sign
                 + **270 individual transform signs (unbounded ∥)**     ~1500–4000ms
         → grid streams in; browser downloads ~30–60 visible thumbs,
           ALL with cache-busted URLs                                   ~500–1500ms
────────────────────────────────────────────────────────────────────────
Total: ~4–7s cold — matches the owner's 5–6s report.
Soft nav: no layout re-render → page alone pays ctx chain (~0.5–1.5s of
generic skeleton) + catalog stream; warm-cache case is fine but the 60s
catalog TTL + deploy resets mean the owner rarely lands on it.
```

---

## 4. The fix plan (prioritized)

### P1 — Backfill `thumb_path` for the 270 legacy images + harden the signer
**What:** One-off idempotent script (service-role, same pattern as the
migration-0122-era thumb generation used by new uploads): for each
`item_images` row with `storage_path` and null `thumb_path`, download,
generate the 200px webp thumb, upload `<name>-thumb.webp`, set `thumb_path`.
Then in `loadCatalogThumbMapCached`:
(a) transform-batch concurrency-limit to ~8 (simple chunked loop) for any
stragglers, and (b) if >10% of per-path signs fail, **throw** (don't cache a
photo-less map for 4h — today per-path failures are silently cached).
**Why (evidence):** storage logs show the 270-call sign storm ×2 at 20:41:58
and 20:42:03; this is the multi-second tail of every cold catalog stream, and
the "batch" fix currently covers only 85/355 rows.
**Expected gain:** cold catalog resolve ~2–4s → ~0.4–0.8s (one item_images
query + ONE `createSignedUrls` POST for ~355 paths). Removes the storage
rate-limit / partial-map-cached-for-4h failure mode.
**Risk:** low. Script is offline + idempotent; signer change is fail-closed.

### P2 — Take the heavy service off the shell path
**What:** In `orders/new/page.tsx`, replace
`WarehousesService.forCurrentUser()` + `warehousesSvc.list()` with the
existing request-cached `getWarehousesForRequest(ctx.organizationId)`
(`src/lib/dashboard/request-cache.ts`) — the page uses only `{id, name}`.
This also removes `withContext()` (org row + MFA factors + modules) from the
page's await chain; permission gating stays via the already-shared
`requireOrgContext` + `can()`.
**Why:** the embed query pulls 363 item ids + assignments + manager +
charters through RLS (mean 25ms, max 732ms, 6,045 calls) purely to render two
`{id,name}` pairs; on hard loads the light helper is literally free (shared
with the layout's own call), on soft navs it's one tiny query instead of the
whole service context.
**Expected gain:** 100–700ms off time-to-shell on every load; biggest
percentage win on soft navigations (the generic-skeleton phase).
**Risk:** low. Behavior identical (active, org-scoped, name-sorted). Keep
`can(ctx,'orders:request')` gate unchanged.

### P3 — Stop deploy-time cache annihilation + prewarm
**What:**
1. Move the three cached loaders (`loadCatalogItemsCached`,
   `loadCatalogThumbMapCached`, `loadChartersForWarehouseCached`, plus
   `loadAccessibleCategoryKey`) out of `page.tsx` into
   `src/server/orders/storefront-catalog.ts`. `unstable_cache`'s implicit key
   hashes the wrapped closure — with the loaders in a rarely-touched module,
   UI edits to the page stop rotating cache keys on every deploy.
2. Add a secret-gated prewarm route (`/api/internal/prewarm-orders-catalog`,
   checks `CRON_SECRET`) that calls the cached loaders for each org's active
   warehouses (or, pragmatically, just the known-hot pairs), wired to a
   Vercel deploy webhook and/or a 30-min cron entry in `vercel.json`. This
   also soaks up the cold-lambda init before a human hits it.
**Why:** the deploy timeline is the single clearest correlation in the
evidence — the owner only ever saw post-deploy cold loads.
**Expected gain:** "reload right after deploy" becomes indistinguishable from
warm: shell <500ms, grid <1.5s.
**Risk:** low–medium. Prewarm route must be secret-gated and use the same
admin-client loaders (no user context); keep it HEAD-cheap and bounded.

### P4 — Tag-invalidated, longer-lived catalog cache + cached accessKey
**What:** Raise catalog TTL 60s → 600s and wire
`revalidateTag('orders-new-v2-catalog')` (and `orders-new-thumbmap` on image
writes) into the inventory item create/update/delete/import and image-upload
actions — the tags are already declared but today only
`server/actions/user-categories.ts` revalidates anything. Cache
`loadAccessibleCategoryKey` per (org, user) for 60s (it's 1–2 serial
uncached queries inside `catalogPromise` on every single request).
**Why:** the 60s TTL exists only because writes don't invalidate; with tags
wired, a longer TTL is *fresher* after writes and always-hot for reads.
**Expected gain:** warm-path catalog resolve becomes a single data-cache read
(~50ms) virtually always; removes 40–90ms of serial accessKey queries.
**Risk:** low. Submit path already re-validates stock server-side; cap
warnings handle advisory drift (same argument as fix 5's 30s→60s).

### P5 — Make the loading state the real storefront skeleton
**What:** Add `app/(dashboard)/dashboard/orders/new/loading.tsx` that renders
the storefront frame skeleton (dark-scoped page head + setup-bar placeholders
+ `CatalogSkeleton`), extracted into a shared component so the in-page
Suspense fallback and the route loading file can't drift.
**Why:** the owner's screenshots ARE `(dashboard)/loading.tsx` — the nearest
boundary today is the generic dashboard `PageSkeleton`, which reads as "the
page is broken/slow" instead of "the store is opening". On soft nav this
renders in ~0ms from the prefetched loading segment.
**Expected gain:** perceived-instant navigation regardless of server timing;
the generic-skeleton complaint disappears even before P1–P4 land.
**Risk:** none.

### P6 — Trim redundant auth round-trips in the dashboard layout
**What:** `getVerifiedEmail()` (`src/lib/auth/platform-admin.ts`) currently
makes a second `supabase.auth.getUser()` GoTrue call on every dashboard
render. The middleware already validated the user via `auth.getUser()` and
forwards `SESSION_HEADER_USER_EMAIL` (set only after validation, deleted
otherwise, matcher covers all of /dashboard). Read the header instead for the
layout's link-visibility check; keep the live `getUser()` for
`requirePlatformAdmin()`/`checkPlatformAdmin()` (the actual security gates on
/platform pages and actions).
**Why:** removes a ~40–100ms network call from the first-flush path of every
dashboard page for every user, twice over during prefetch bursts (the log
shows ~25 sidebar prefetches per landing, each paying the full layout
fan-out).
**Expected gain:** 40–100ms off first flush on all dashboard routes; a
meaningful drop in GoTrue call volume.
**Risk:** medium (security-sensitive) — must document the header trust chain
and keep the hard gates on live verification. Ship with a test asserting the
header path is only trusted under the middleware matcher.

### P7 — Persist signed thumb URLs so browser cache survives deploys
**What:** Store `signed_thumb_url` + `signed_until` on `item_images`
(migration 0221) at sign time; the 4h map recompute reads rows and only
re-signs when <7 days from expiry (URLs are 30-day valid). Image
upload/replace overwrites the row (natural invalidation).
**Why:** today every recompute/deploy rotates ~348 tokens → full thumbnail
re-download burst (observed 20:42–20:43). Stable URLs make repeat loads
render photos from HTTP cache instantly.
**Expected gain:** image phase on repeat visits ~0ms; also shrinks the flight
delta between visits.
**Risk:** medium — new column + write path from a read path (do the persist
via `after()` or the prewarm cron, not inline in the loader).

### Later / optional (explicitly NOT needed to hit the bar)
- **Hydration reduction:** ship only the 11 preview slices (~44 cards) +
  aisle counts initially, fetch the rest on category-expand/search focus, or
  virtualize. The full 353-item flight is ~250–300KB — real but secondary.
- **PPR / `use cache` shell:** prerender the storefront frame. Attractive but
  Next 16 cache-components interplay with the cookie-bound layout needs a
  spike; P2+P5 buy most of the same perceived win for near-zero risk.
- **Prefetch herd control:** the sidebar triggers ~25 dynamic RSC renders per
  landing (each a full layout fan-out). Consider `prefetch={false}` on
  low-traffic links or hoisting nav data into a cached segment. Systemic —
  not orders/new-specific.

---

## 5. Instrumentation to ADD with P1/P2 (so the next session reads, not infers)

Following the existing `DEBUG_CONTEXT_TIMING` pattern in
`server/services/context.ts` (guarded, structured, server-only):

- `page.tsx`: one JSON line per request —
  `{route:'orders/new', ctxMs, warehousesMs, chartersMs, shellReadyMs}`.
- `storefront-catalog.ts` loaders: `{catalogMs, thumbMapMs, thumbMode:
  'hit'|'recompute', signedBatch, signedIndividual, itemCount}`.
- Optionally surface as a `Server-Timing` header on the page response so the
  owner's own devtools show the split.
- Enable `DEBUG_CONTEXT_TIMING=1` in prod for a week; the Vercel log query
  `npx vercel logs -q "orders/new" --since 1h --json` then yields real
  durations per layer.

**Acceptance test for the bar:** after P1–P5, from a logged-in browser:
soft-nav Orders → Place an Order shows the storefront skeleton <100ms, real
shell <500ms, full grid <1.5s; then trigger a redeploy of an unrelated file
and hard-reload — grid <2s with photos from HTTP cache (P7) and NO individual
sign storm in the storage logs.

---

## 6. Ranked expected impact recap

| Fix | Layer | Cold saving | Warm saving |
|---|---|---|---|
| P1 thumb backfill + batch-complete | catalog stream | **1.5–3.5s** | — (protects 4h recompute) |
| P3 stable cache keys + prewarm | everything | **1–3s** (makes cold rare) | — |
| P2 light warehouses on shell path | time-to-shell | 0.1–0.7s | 0.1–0.7s (soft nav) |
| P4 tags + longer TTL + accessKey cache | catalog stream | 0.2–0.5s | 0.1–0.3s |
| P5 real loading skeleton | perception | entire generic-skeleton phase | same |
| P6 auth RTT trim | first flush | 40–100ms | 40–100ms |
| P7 stable image URLs | image phase | 0.5–1.5s repeat visits | same |
