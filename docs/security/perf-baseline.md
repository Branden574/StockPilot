<!-- Provenance: compiled 2026-08-10; section 6 and the edits to sections 0, 3.5
     and 5 added 2026-09-20 from a measured run (see section 6 for its conditions). Every number below is quoted from a file in
     this repository with its path, and is a MEASUREMENT SOMEONE RECORDED AT A
     POINT IN TIME, not a live figure and not a target. Nothing here was
     re-measured while writing this document. Thresholds quoted from load-tests/
     are encoded in the scripts and are reproducible. Where no number exists, the
     command to obtain one is given instead of an estimate. -->

# Performance baseline

Performance belongs in the security documentation set for one reason: several
controls in this system are on hot paths, and the standing temptation when a page
feels slow is to remove a check. This document records what is measured, how, and
which figures must not regress — so that a proposed optimization can be evaluated
against a recorded number instead of a feeling.

## 0. The honest state of measurement

Read this before quoting anything below.

- **There is no CI performance gate.** CI runs typecheck, tests, build, pgTAP and
  `pnpm security:test`. No timing assertion runs anywhere.
- **There are no recorded load-test results.** `load-tests/` contains a complete
  k6 suite with encoded thresholds, but the README's capacity-planning table is a
  blank template and `load-tests/results/` is gitignored. **Zero k6 numbers exist
  in this repository.**
- **There are no Lighthouse scores.** `BLUEPRINT.md` states a Lighthouse
  aspiration; no Lighthouse tooling is installed.
- **There IS now a browser-measured baseline** (2026-09-20, section 6), taken
  with the committed harness in `apps/web/tests/perf` (`pnpm perf`). It is a
  PRODUCTION SYNTHETIC measurement: a scripted, signed-in browser against the
  live site. It is not field data from real users, and it is not a CI gate.
- **No `Server-Timing` header is emitted.** The instrumentation hook exists
  (`apps/web/src/server/services/context.ts`, gated on `DEBUG_CONTEXT_TIMING`) but
  nothing serves the header.
- **The recorded numbers are point-in-time measurements from plan documents and
  code comments.** They are the best evidence available and they are real
  measurements, but they were taken on the data shape and deployment of their date.
  Treat them as **regression tripwires**, not as a current baseline.

The consequence: a claim like "the dashboard loads in 1.5s" cannot be verified from
this repository today. A claim like "the dashboard fan-out was measured at 1.5s
warm on 2026-05-31 and was 3.7s before it" can, and that is the form used below.

## 1. Do-not-regress surfaces

Four surfaces carry explicit do-not-regress rules in code. A change touching any
of them needs a before-and-after measurement, taken **authenticated, in a real
browser** — not a curl of the marketing page.

### 1.1 App-wide navigation

The rules live in `apps/web/src/components/dashboard/sidebar.tsx` and are there
because the naive version was expensive:

- **Prefetch is limited to the top five sidebar entries**, warmed with a 150ms gap.
  The comment records why: every warmed route is a full dynamic RSC render
  server-side, so eager prefetch of the ~25 sidebar links fired "~20 lambda
  invocations + ~20 middleware auth round-trips + on the order of 150 DB queries"
  within seconds of every hard landing.
- **Eager prefetch is disabled** (`prefetch={false}`); routes warm on
  `onFocus` / `onPointerEnter` / `onPointerDown` instead.
- With `staleTimes.dynamic = 90`, an entry not clicked within 90 seconds was
  re-fetched on navigation anyway — so the eager warm was paying for nothing.

Recorded figures:

| Figure                                                        | Value                                                   | Source                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------- |
| First-click dead time before the pending-state fix            | up to ~1.2s in production                               | `apps/web/src/components/dashboard/nav-link-pending.tsx`        |
| `/dashboard/orders/new` TTFB after the instant-nav playbook   | 46ms                                                    | `docs/superpowers/plans/2026-07-02-appwide-nav-instant-plan.md` |
| Heavy `warehouses` embed, before replacement by `listNames()` | 6,045 calls, 25.1ms mean, **731.7ms max**, 152.0s total | same plan, `pg_stat_statements` on production                   |
| `getWarehouseAccess` light select                             | 28,318 calls, 1.5ms mean, 428.9ms max                   | same                                                            |
| 30-day movement metrics with item embed                       | 1,068 calls, **81.3ms mean**, 346.4ms max               | same                                                            |

**The rule that matters most**: dropdowns use
`WarehousesService.listNames()` (24 call sites), not the heavy embed. Reintroducing
the embed for a dropdown regresses the worst query in the recorded table.

`next.config.ts` holds two settings deliberately: `staleTimes.dynamic = 90` and
`static = 180` (90 chosen over a higher 180 as a deliberate balance), and
`minimumCacheTTL = 86400` for the image optimizer, because the Vercel default of
60s meant "re-fetching the same signed URL ~10,000× over the URL's lifetime".

### 1.2 Orders storefront loaders

**Structural rule, and it is the load-bearing one**: the cached loaders must stay
in `apps/web/src/server/loaders/orders-new-catalog.ts` and UI concerns must stay
out of that file. `unstable_cache`'s implicit key includes a hash of the wrapped
closure, so **every edit to the module containing a cached loader rotates its cache
key on deploy.** While these loaders lived in `page.tsx`, every UI tweak hard-reset
the catalog, thumb-map and charters caches, and a reload right after a deploy
always hit the fully cold path.

Encoded budgets in that file: catalog TTL 60s, charters 300s, access key 60s,
thumb map 4h; thumbnail signed-URL TTL 30 days; transform width 200px; sign
concurrency 20; sign-failure throw ratio 0.1.

The recorded cold waterfall (`docs/superpowers/plans/2026-07-01-orders-new-instant-plan.md`)
totalled **~4-7s cold**, with the two dominant terms being **270 individual
transform signs, unbounded parallel, at ~1500-4000ms** and cold lambda init. The
stated bar after the fix: **warm shell under 500ms, full grid under 1.5s, skeleton
under 100ms, and a post-deploy hard load never past ~2s.**

That plan is also explicit about the limits of its own method: Vercel CLI runtime
logs expose no per-invocation durations, unauthenticated reproduction is blocked by
Bot Protection (curl returns 429), and no local test credentials existed. Anyone
re-measuring will hit the same three walls.

### 1.3 Dashboard load

- `apps/web/src/app/(dashboard)/dashboard/page.tsx` records: **"cut /dashboard FCP
  from ~3.7s to ~1.5s on warm cache"**, achieved by collapsing two serial
  `Promise.all` blocks (15 queries) into a single parallel fan-out.
- Value-chart comparisons fetch **on demand, never eagerly on mount**. Adding eager
  work to the dashboard mount is the specific regression this rule exists to
  prevent.
- Per-section `loading.tsx` files exist for 30 dashboard routes, so a soft
  navigation paints a route-true skeleton rather than a generic one.

### 1.4 Inventory list

- `PAGE_SIZE = 30`, dropped from 50 after a Playwright speed sweep measured the
  list "pulling ~3 MB and 6.2s to load on a warm cache" — roughly 40% off load
  weight (`apps/web/src/app/(dashboard)/dashboard/inventory/page.tsx`). The value
  must stay in sync between `inventory/page.tsx`, `books/page.tsx` and the loader's
  `DEFAULT_VIEW_PAGE_SIZE`.
- Cache tags and TTL live in `apps/web/src/server/loaders/inventory-list.ts`:
  `LIST_TTL_SEC = 60`, tags `inventory-list-v3`, `inventory-lookups-v1`,
  `inventory-value-v1`, `inventory-trend-buckets-v2`, `inventory-dataset-v1`.
- The same file carries an unusually explicit instruction: an unused column is left
  **off** the select on purpose because this is "a hot, 60s-cached, do-not-regress
  list path", and columns are added only when a real consumer needs one.
- `INSTANT_MODE_MAX_ROWS = 2000` caps the client-side instant dataset per view.

### 1.5 Related recorded figures worth not regressing

| Figure                                               | Value                                                           | Source                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| Anonymous `/api/ai/chat` rejection                   | ~676ms → **under 50ms** after avoiding a `getUser()` round trip | `apps/web/src/lib/auth/api-context.ts`                          |
| Middleware GoTrue round trip avoided per request     | ~40-150ms of TTFB                                               | `apps/web/src/lib/supabase/middleware.ts`                       |
| 30-day movement window scan before snapshot rollups  | ~791ms at 1.2M movements                                        | `apps/web/src/server/services/movements.ts`                     |
| Thumbnail signing tax before caching                 | 200-500ms per thumbnail on revisits                             | `apps/web/src/server/services/item-images.ts`                   |
| Cold visit to a non-hot org before the prewarm sweep | ~4.8s at 50k-item scale                                         | `apps/web/src/app/api/cron/prewarm-orders-catalog/route.ts`     |
| Post-deploy cold loader wave paid by the first human | ~1.5-2.5s                                                       | `.github/workflows/prewarm-on-deploy.yml`                       |
| Per-org prewarm cost                                 | ~150-400ms warm, ~1-3s fully cold                               | `apps/web/src/app/api/cron/prewarm-orders-catalog/org-sweep.ts` |

Note the disclosed cap in that last file: `ORG_SWEEP_CAP = 50`, sized against the
route's `maxDuration = 60` because 50 orgs × ~1s ≈ 50s worst case. This repo's rule
is that caps are disclosed rather than silent, and this is the worked example.

## 2. The warm-cache machinery

Three independent paths keep the caches warm, and they exist because a deploy
rotates the loader cache keys:

1. **`.github/workflows/prewarm-on-deploy.yml`** — fires on
   `deployment_status` success in Production, calls
   `/api/cron/prewarm-orders-catalog` with a bearer secret, 3 attempts with
   backoff, ~30-90s after the deploy goes ready. A robot pays the cold wave
   instead of the first human.
2. **A Vercel cron every 30 minutes** — `apps/web/vercel.json`, path
   `/api/cron/prewarm-orders-catalog`, schedule `*/30 * * * *`.
3. **Boot self-warm** — `apps/web/src/instrumentation.ts`, production only, always
   with `?scope=hot`. The `scope=hot` parameter is mandatory: a deploy cold-starts
   K instances simultaneously, and K concurrent full sweeps would be a thundering
   herd against Supabase.

**If you change a cached loader, check all three still make sense.** A new cache tag
that the prewarm route does not warm is a new cold path for the first human after
every deploy.

## 3. How to measure

### 3.1 Load testing (k6)

The suite exists and is not a CI gate by design: a full run pushes roughly 500 MB
of Vercel egress and ~50,000 Supabase queries, which is real money to spend
repeatedly.

```bash
brew install k6
source load-tests/.env.local.loadtest          # gitignored, off-repo secrets
k6 run load-tests/k6/scenarios/03-inventory-list.js
./load-tests/k6/run-all.sh                     # summaries → load-tests/results/
```

`run-all.sh` refuses to target production unless `ALLOW_PROD=1` is set. Leave that
guard alone.

Encoded thresholds — these are the numbers the suite fails on:

| Scenario                      | Threshold                                                                         | File                                            |
| ----------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------- |
| Default (most scenarios)      | `p(95)<1000`, `http_req_failed rate<0.01`; stages 30s→50 VU, 1m plateau, 30s down | `load-tests/k6/lib/auth.js`                     |
| Sign-in                       | `rate<0.05` — Supabase throttling is expected; peak 10 VU                         | `load-tests/k6/scenarios/02-signin.js`          |
| Inventory write               | `p(95)<2000` — writes are slower than reads; peak 25 VU                           | `load-tests/k6/scenarios/06-inventory-write.js` |
| Anonymous capacity stair-step | `p(95)<1500`, `rate<0.05`, `abortOnFail: false`; 10→50→100→250→500 VU             | `load-tests/k6/scenarios/99-capacity-anon.js`   |
| Sustained 250 VU              | **no thresholds block** — observation run only, and it defaults to production     | `load-tests/k6/scenarios/99b-sustained-250.js`  |
| Artillery alternative         | `p95: 1000`, at least 99% HTTP 200                                                | `load-tests/artillery/basic.yml`                |

Two things to know before running: scenario `08-shipment-detail` is indexed by
`run-all.sh` and the README but **the script file does not exist**, so that entry
prints a skip; and `99b` defaults to `https://stockpilotusa.com`, so read its
`BASE_URL` before starting it.

**Filling in the capacity table in `load-tests/README.md` is the single
highest-value performance action available.** It converts this document from
"tripwires from old plan docs" into a real baseline.

### 3.2 Per-layer server timing

```bash
# Set DEBUG_CONTEXT_TIMING=1 in the Vercel environment, redeploy, then:
npx vercel logs -q "orders/new" --since 1h --json
```

The hook is `apps/web/src/server/services/context.ts` and is a no-op without the
variable. The plan doc that introduced it recommends leaving it on for about a week
to get real per-layer durations.

### 3.3 Database query cost

```sql
-- Reset, let a representative day of traffic run, then read the top consumers.
select calls, mean_exec_time, max_exec_time, total_exec_time, query
  from pg_stat_statements
 order by total_exec_time desc
 limit 30;
```

This is the method that produced the `warehouses` embed finding and is the most
reliable instrument available for this stack. **Measure RLS as `authenticated`, not
as the table owner** — policy evaluation cost is invisible to a superuser session.

### 3.4 The prewarm route as a self-serve timer

```bash
curl -fsS -H "Authorization: Bearer $BACKFILL_ADMIN_SECRET" \
  https://stockpilotusa.com/api/cron/prewarm-orders-catalog
```

The JSON response reports `totalMs`, `prewarmed`, `inventoryPrewarmed` and
`orgSweep.{cap, activeOrgTotal, swept, truncatedByCap, skippedForBudget}`. Add
`?scope=hot` for the hot tier only. This is the only timing instrument in the
system that requires no setup.

### 3.5 Front-end, authenticated, in a browser

```bash
cd apps/web
PERF_BASE_URL=https://stockpilotusa.com PERF_USER_EMAIL=<qa account> \
PERF_SUPABASE_URL=https://<ref>.supabase.co PERF_ENV_FILE=.env.local \
PERF_ROLE=admin PERF_DATASET="<what is being measured>" PERF_SERVER_STATE=steady \
PERF_ITERATIONS=40 PERF_LABEL=before-my-change pnpm perf

PERF_BEFORE=perf-results/<before> PERF_AFTER=perf-results/<after> pnpm perf:compare
```

`apps/web/tests/perf/README.md` is the manual. The rules that matter here:

- It measures the site from OUTSIDE, so a "before" number needs no deploy.
- Take the baseline twice on the same build and compare the two (an A/A
  comparison) before judging any change: that is the harness's own noise.
- Do not run tests, builds or other heavy work on the machine during a run.
- A result file holds timings, image CLASSES and keyed hashes. Never a photo URL
  (they are 30-day bearer credentials), an item name, a SKU or an email.
- It signs in with an admin-minted one-time link, so no password is typed or
  stored. The saved session is signed out and deleted when the run ends.

## 4. Where security and performance actually collide

Named explicitly, because these are the trades most likely to come up.

| Control                                    | Cost                                     | Correct response to "make it faster"                                                                                                                                   |
| ------------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RLS predicates on hot list paths           | Evaluated per row per query              | Optimize the **predicate** (the 0229 hashed-org-set rewrite is the model), never widen the policy. Migration 0229 has a test asserting the rewrite kept its semantics. |
| Warehouse scoping on movements and PO list | An extra set membership per row          | Keep it. It is a tenant-isolation control (0321, 0322), not a filter.                                                                                                  |
| Signed URLs for storage                    | A signing call per object                | Cache the signature — the 30-day signed URL plus a 25-day data cache is exactly this fix. Do **not** make the bucket public.                                           |
| Path-shape validation before signing       | Microseconds per call                    | Not a performance factor. Never a candidate for removal.                                                                                                               |
| Magic-byte upload verification             | Reads the first bytes of the upload      | Not a performance factor at this volume.                                                                                                                               |
| MFA AAL check in `assertPermission`        | Reads session state                      | Cache the session read, never the authorization decision.                                                                                                              |
| Prewarm crons                              | Real Supabase query volume on a schedule | Tune the cap (`ORG_SWEEP_CAP`) with the budget math written down, as that file already does.                                                                           |

**The rule**: a control is optimized by making the same decision faster, never by
making a weaker decision. If a proposed change alters what the check would answer,
it is a security change and needs the invariant test to agree with it.

## 5. What to add next

In value order.

1. **A benchmark dataset.** Demo Co has 33 small photos; the largest customer has 443. A separate "Perf Lab" organization, shaped like that customer's measured
   photo distribution and holding one account per role, is the precondition for
   any verdict on photo loading and for the role matrix. Seeding it in production
   needs the owner's explicit go.
2. **Fill in `load-tests/README.md`'s capacity table** from one real run.
3. **Emit `Server-Timing`** from the existing context hook so per-layer cost is
   observable in production without a log-scraping session.
4. **Runs in the other server states** (`PERF_SERVER_STATE=post-deploy`,
   `post-idle`): the owner's post-deploy budget (useful content p95 2000 ms)
   cannot be judged from a warm server, and section 6 does not try to.
5. **WebKit and Firefox runs**, the public catalog, back/forward and the mobile
   drawer: listed as not yet measured in the harness README.
6. **Decide whether any of this becomes a CI gate.** Not before the harness has
   shown stable A/A comparisons over several days.

## 6. Browser-measured baseline, 2026-09-20

**Conditions.** Production synthetic. `stockpilotusa.com`, build `03f6577e3785`
(built 2026-09-18). Harness `2026-09-20.4`. Chromium 153, 1440x900, DPR 2, no
throttling, measured round trip to the site 112 ms, Apple M3 Pro. Signed in as
the QA admin (role verified by the server) in Demo Co: 29 rows in the Items list,
8 photos on screen, 33 photos in the org. Server warm (`steady`). 40 timed
samples per scenario (10 for the empty-browser-cache scenarios), one separate
warm-up each, **0 failed iterations**. Results folder:
`perf-results/2026-09-20T23-10-02-584Z-baseline-A-chromium` (gitignored; the
numbers below are copied from its `summary.md`).

Percentiles are nearest-rank, so every cell is a value that was observed.

| Scenario                                          |    p50 |     p75 |     p95 | Owner budget (p75 / p95) | Result |
| ------------------------------------------------- | -----: | ------: | ------: | ------------------------ | ------ |
| Dashboard → Inventory                             | 715 ms |  746 ms |  880 ms | 500 / 1000 ms            | over   |
| Dashboard → Orders                                | 447 ms |  546 ms |  764 ms | 500 / 1000 ms            | over   |
| Inventory → Item                                  | 666 ms |  723 ms |  897 ms | 500 / 1000 ms            | over   |
| Inventory first-row photos (warm browser cache)   | 715 ms |  746 ms |  880 ms | none yet                 |        |
| Inventory all visible photos (warm browser cache) | 715 ms |  746 ms |  880 ms | none yet                 |        |
| Hard-load Inventory (warm browser cache)          | 780 ms |  861 ms | 1085 ms | none yet                 |        |
| Orders → Order                                    | 530 ms |  612 ms |  781 ms | 500 / 1000 ms            | over   |
| Dashboard → Books                                 | 729 ms |  793 ms |  881 ms | 500 / 1000 ms            | over   |
| Orders → New order (storefront)                   | 396 ms |  420 ms |  703 ms | 500 / 1000 ms            | within |
| Inventory revisit within 90 s                     |  51 ms |   52 ms |   54 ms | 500 / 1000 ms            | within |
| Click → visible response (sidebar)                |  31 ms |   32 ms |   33 ms | 75 / 150 ms              | within |
| Click → visible response (item row)               |  45 ms |   49 ms |   56 ms | 75 / 150 ms              | within |
| Page-data fetch, request → first byte (Inventory) | 131 ms |  145 ms |  240 ms | 300 / 600 ms             | within |
| Page-data fetch, request → first byte (Orders)    | 131 ms |  189 ms |  241 ms | 300 / 600 ms             | within |
| Page-data fetch, request → first byte (Item)      | 149 ms |  165 ms |  200 ms | 300 / 600 ms             | within |
| Hard-load Inventory: LCP                          | 488 ms |  748 ms | 1044 ms | 2500 ms (p75)            | within |
| Hard-load Inventory: layout shift (sum)           |  0.048 |   0.048 |   0.048 | 0.1 (p75)                | within |
| Dashboard → Inventory, empty browser cache        | 796 ms |  881 ms | 1212 ms | none (warm server)       |        |
| Hard-load Inventory, empty browser cache          | 987 ms | 1231 ms | 2330 ms | none (warm server)       |        |

The two photo rows equal the navigation row on purpose: in 40 of 40 samples
every visible photo had its bytes before the rows painted, so a photo became
visible when its row did. Count a change there once, not three times. With an
empty browser cache the photos finish 85 to 130 ms after the rows.

**Where the time goes (p50, same run).**

| Navigation            | Skeleton visible | Page data: first byte | Page data: stream ends | Content visible |
| --------------------- | ---------------: | --------------------: | ---------------------: | --------------: |
| Dashboard → Inventory |            47 ms |                138 ms |                 545 ms |          716 ms |
| Dashboard → Books     |            46 ms |                144 ms |                 523 ms |          730 ms |
| Dashboard → Orders    |            46 ms |                142 ms |                 431 ms |          447 ms |
| Inventory → Item      |           184 ms |                158 ms |                 646 ms |          673 ms |
| Orders → Order        |            78 ms |                152 ms |                 564 ms |          531 ms |
| Orders → storefront   |            79 ms |                145 ms |                 350 ms |          397 ms |

What this says, and what it does not:

- The click is acknowledged in 31 ms and the server's first byte arrives in about
  140 ms. Neither is the problem, and neither control on the hot path (session
  verification, RLS) is what the budgets are missing by.
- On Orders and Item the page-data STREAM is the long pole: content appears
  within about 30 ms of the stream ending. The work is server-side data time
  after the first byte.
- On Inventory and Books the rows appear 170 to 200 ms AFTER the last byte has
  arrived, with zero long-task time. That is a client-side wait, not a server
  one. The leading hypothesis is React's throttled reveal of a nested Suspense
  boundary (route skeleton, then page chrome, then the table). It is a
  hypothesis until a change moves the number.
- Item rows show their skeleton at 184 ms against 47 ms for sidebar links: the
  list does not warm detail routes and the detail route has no skeleton of its own.

**Other measured facts from the same run.**

- One navigation to Inventory makes 52 requests. A hard load of Inventory fires
  20 background route prefetches.
- The Orders list prefetches 14 order-detail routes on every view. The owner's
  rule is none; the navigation those prefetches serve (Orders → Order) is measured
  above so that removing them can be judged on what it costs.
- Every view of a page with a guided tour calls the `getTourStateAction` server
  action, tour finished or not (about 450 ms, measured separately on 2026-09-18).
- Item photos are fetched through signed URLs whose responses carry NO
  `Cache-Control` header. The browser still reuses them (heuristic freshness from
  `Last-Modified`): 0 of the warm-view photos went to the network and 0 were
  revalidated. The missing header costs a freshly uploaded photo, not an old one.
- Empty browser cache, hard-load Inventory: 571 KB of script, 482 KB of images.
  Warm: 59 KB on the wire.
- 0 broken photos, 0 failed page-data fetches, 0 hydration errors, 0 console errors.

**How much the same build moves on its own (A/A).** The baseline was taken twice,
30 minutes apart, on the same build, same machine, same everything (run B:
`perf-results/2026-09-20T23-40-43-*-baseline-B-chromium`). p75, run A then run B:

| Row                                      |   Run A |   Run B | Moved |
| ---------------------------------------- | ------: | ------: | ----: |
| Dashboard → Inventory                    |  746 ms |  732 ms |   -2% |
| Dashboard → Books                        |  793 ms |  812 ms |   +2% |
| Inventory → Item                         |  723 ms |  748 ms |   +4% |
| Orders → Order                           |  612 ms |  561 ms |   -8% |
| Orders → storefront                      |  420 ms |  454 ms |   +8% |
| Dashboard → Orders                       |  546 ms |  480 ms |  -12% |
| Hard-load Inventory (warm browser cache) |  861 ms | 1018 ms |  +18% |
| Hard-load Inventory: LCP                 |  748 ms |  868 ms |  +16% |
| Page-data first byte (Inventory)         |  145 ms |  174 ms |  +20% |
| Page-data first byte (Item)              |  165 ms |  217 ms |  +32% |
| Click → loading skeleton (Item)          |  200 ms |  261 ms |  +31% |
| Hard-load Inventory, empty browser cache | 1231 ms | 1546 ms |  +26% |
| Click → visible response (sidebar)       |   32 ms |   32 ms |    0% |

Nothing changed between those runs, so every one of those movements is drift:
the server answering differently half an hour later. Two consequences:

- A change smaller than its row's drift is not a result. `perf:compare` takes the
  A/A pair (`PERF_DRIFT_A`, `PERF_DRIFT_B`) and reports such a change as drift.
  The main navigation rows hold to a few percent; anything that rides on server
  first byte, hard loads and the empty-cache rows needs a change of 20 to 30%
  before it can be believed from one run a side. Take two runs a side for those.
- In run B, ONE of 40 Dashboard → Inventory navigations showed no rows within
  30 seconds (2026-09-20T23:42:09Z, code `timeout:useful`). It is ranked as the
  slowest sample, not dropped. One in forty is an anecdote, not a rate, but it is
  the kind of event a person remembers as "the app hung", and the harness now
  counts them so a rate can be established.

**What a deploy does (measured 2026-09-21T00:27Z).** Build `ab202032e32c` (a
two-file privacy fix that did not touch image code) went live, and a run was
started about two minutes later with `PERF_SERVER_STATE=post-deploy`
(`perf-results/2026-09-21T00-29-36-*-post-deploy-chromium`, n=20).

- **Signed photo URLs did NOT rotate.** 18 signed photos were seen both before and
  after the deploy; all 18 kept the same signed URL. The Phase 1 audit's claim
  that "every deploy rotates every photo URL" does not hold for an ordinary
  deploy. It stays open only for a deploy that edits the signing module
  (`server/services/item-images.ts`) or changes how that module compiles; repeat
  this check on the first such deploy.
- **First request after the deploy** (one observation each, not a percentile):
  Dashboard → Inventory 1260 ms (page-data first byte 498 ms), Inventory → Item
  914 ms, Orders → Order 830 ms, hard-load storefront 1010 ms. All inside the
  owner's post-deploy limit of 2000 ms. One deploy is one sample; the limit is a
  p95 and needs several.
- In the fifteen minutes after the deploy the tail was slower than the warm
  baseline (Orders → Order p95 930 ms against 613 ms in run B). `perf:compare` labels that
  comparison NOT FAIR, correctly: the server state differs.

**What this baseline cannot say.** Anything about photo loading at customer
scale (Demo Co's storefront photos are about 220 px for a 468 px need, which is
not what a customer has); any role other than admin; any browser other than
Chromium; a cold server. Those are items 1, 4 and 5 of section 5.
