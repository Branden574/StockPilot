<!-- Provenance: compiled 2026-08-10. Every number below is quoted from a file in
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

There is no committed script for this — the "Playwright speed sweep" cited in the
inventory page comment was an ad-hoc manual sweep on 2026-05-21. To reproduce:
sign in, open DevTools with the network tab recording, hard-load the surface, then
soft-navigate between tabs. Record TTFB, transferred bytes and time to a
route-true skeleton. Do it before and after the change, on the same account and the
same data.

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

1. **Fill in `load-tests/README.md`'s capacity table** from one real run. It turns
   this document into a measured baseline.
2. **Emit `Server-Timing`** from the existing context hook so per-layer cost is
   observable in production without a log-scraping session.
3. **Record a browser-measured before/after** for the four do-not-regress surfaces,
   authenticated, and commit the numbers with their date and data shape. A dated
   number is worth far more than an undated one.
4. **Decide whether any of this becomes a CI gate.** Probably not the k6 suite —
   the egress cost is the stated reason it is not one — but a cheap check on
   transferred bytes for the inventory list would catch the specific regression
   that took that page to 3 MB.
