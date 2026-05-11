# StockPilot load tests

k6-based load tests for capacity planning. **Not** for CI gates — they
push hundreds of MB of egress and thousands of DB hits per run, which
is a real cost when run repeatedly.

This suite tells you "at what concurrent user count does StockPilot
start to degrade?" so you can decide when to scale Supabase compute,
add a CDN tier, or rewrite a hot path.

---

## Hard rules

1. **Never run against `https://stockpilotusa.com`** unless you've
   explicitly chosen to. `run-all.sh` refuses to start when `BASE_URL`
   contains the prod domain unless you pass `ALLOW_PROD=1`.
2. **Default target is a Vercel preview URL.** Spin up a preview, point
   the test at it.
3. **Always have a test org and a test user.** Don't load-test against
   your real org. Writes scenarios will create real DB rows.
4. **Don't run scenario 02 (signin) against shared Supabase auth.**
   Supabase rate-limits sign-ins per IP (~30 / 5 min default). A long
   load test will trip the limiter and may briefly lock real users out.

---

## Install k6

```bash
# macOS (recommended)
brew install k6

# Linux
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6

# Docker (no install)
docker run --rm -i grafana/k6 run - < load-tests/k6/scenarios/01-anon-marketing.js
```

Verify: `k6 version` (should show v1.x or higher).

Artillery (optional, only needed if you want the YAML alternative):
`npm install -g artillery` (do **not** add to package.json — it's a
CLI tool, not a project dependency).

---

## First-time setup

1. **Spin up a preview deploy** on Vercel for the branch you want to
   test. Note the URL — that's `BASE_URL`.

2. **Create a test org and test user.** Use a throwaway email like
   `loadtest+$(date +%s)@yourdomain.com`. Add a few inventory items,
   a procedure, a shipment so the SSR pages have data to render.

3. **Get an access token** (the Supabase JWT). Two ways:

   - **(easy) Pre-issued JWT.** Sign in to the preview deploy in a
     real browser. Open devtools → Application → Cookies. Find the
     `sb-<project>-auth-token` cookie. Its value is a JSON-encoded
     object — the `access_token` field inside is your JWT. Set
     `SUPABASE_ACCESS_TOKEN=<that_jwt>`.

   - **(automated) Programmatic sign-in.** Set
     `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `TEST_EMAIL`,
     `TEST_PASSWORD`. The k6 scripts will sign in once in `setup()`
     and reuse the token. Won't work if the user has MFA enabled —
     use the pre-issued JWT path instead.

4. **Get a session cookie** (only needed for scenarios 03, 05, 07, 08
   which hit SSR dashboard pages — k6 can't forge the cookies, you
   have to paste them):

   - Sign in via browser. In devtools, copy the full `Cookie:`
     header from any authenticated request (Network tab → any
     /dashboard/* request → Request Headers).
   - Set `SUPABASE_AUTH_COOKIE='<paste here>'`. Should look like
     `sb-xxx-auth-token=...; sb-xxx-auth-token.0=...; ...`.
   - The cookie expires (~1 hour by default). Re-grab it if a run
     fails with 100% redirects.

5. **Stash env in a gitignored file** so you don't paste secrets into
   shell history:

   ```bash
   # load-tests/.env.local.loadtest (gitignored)
   export BASE_URL=https://preview-xxx.vercel.app
   export SUPABASE_URL=https://abcd.supabase.co
   export SUPABASE_ANON_KEY=eyJ...
   export SUPABASE_ACCESS_TOKEN=eyJ...
   export SUPABASE_AUTH_COOKIE='sb-xxx-auth-token=...; ...'
   export TEST_EMAIL=loadtest@yourdomain.com
   export TEST_PASSWORD='...'
   export ITEM_IDS='uuid1,uuid2,uuid3'
   export SHIPMENT_IDS='uuid1,uuid2'
   # uncomment when you actually want to exercise these:
   # export ENABLE_SIGNIN=1
   # export ENABLE_WRITES=1
   # export PO_ID=...
   # export PO_LINE_ITEM_ID=...
   ```

   Then `source load-tests/.env.local.loadtest` before running.

---

## Running one scenario

```bash
source load-tests/.env.local.loadtest
k6 run load-tests/k6/scenarios/03-inventory-list.js
```

Each script prints a summary on completion with p50/p95/p99 latency
per request name, throughput (`http_reqs`), and error rate
(`http_req_failed`). If a threshold trips, k6 exits non-zero.

## Running all scenarios

```bash
source load-tests/.env.local.loadtest
./load-tests/k6/run-all.sh
```

Summaries land in `load-tests/results/<scenario>-<timestamp>.json`
(gitignored).

---

## Scenario index

| # | File | What it hits | Auth |
|---|------|--------------|------|
| 01 | `01-anon-marketing.js` | `/`, `/pricing`, `/features` | none |
| 02 | `02-signin.js` | Supabase `/auth/v1/token` | n/a (this IS sign-in) |
| 03 | `03-inventory-list.js` | `/dashboard/inventory?...` with 15 filter combos | cookie |
| 04 | `04-search-palette.js` | `/api/search?q=...` with 20-term corpus | bearer |
| 05 | `05-item-detail.js` | `/dashboard/inventory/[id]` | cookie |
| 06 | `06-inventory-write.js` | `/api/v1/po/[id]/receive-line` (see note) | bearer |
| 07 | `07-procedure-list.js` | `/dashboard/procedures` | cookie |
| 08 | `08-shipment-detail.js` | `/dashboard/shipments/[id]` | cookie |

**Cookie vs bearer:** Next.js SSR pages read the Supabase session from
cookies (`sb-*-auth-token`), which k6 can't forge — you have to paste
a real cookie. API routes (`/api/*`) accept `Authorization: Bearer`
via `withApiContext()`'s bearer path (see
`apps/web/src/lib/auth/api-context.ts`). That's why the table splits.

**Scenario 06 note:** The brief asked for `POST /api/v1/items` and
`PATCH` for update — those endpoints **don't exist** in this codebase.
Item create/update happens via Next.js Server Actions, which aren't
callable from k6. The scenario uses the closest "real-write" public
API endpoint (`POST /api/v1/po/[id]/receive-line`) as a proxy for
write throughput. Same DB cost profile (single insert + trigger
fan-out). Disabled by default — pass `ENABLE_WRITES=1` to enable.

---

## What thresholds mean

Every scenario fails the run if:

- `p(95) http_req_duration < 1000ms` — 95% of responses must be under 1s
- `rate http_req_failed < 0.01` — fewer than 1% of requests can error

Scenario 02 (signin) bumps `http_req_failed` to 5% because Supabase
will throttle and that's expected, not a regression.

Scenario 06 (writes) bumps the latency ceiling to 2s — writes are
slower than reads and 1s is unrealistic for an insert + trigger.

---

## Reading the results

After a run, look at:

1. **`http_req_duration` p95.** Under 1s = healthy. Over 2s = something's
   slow — check the per-request breakdown to see which endpoint.
2. **`http_req_failed` rate.** Should be near zero. If non-zero, check
   `http_reqs{status:5xx}` in the summary — that's where errors are.
3. **`vus` peak.** This is your concurrent-user count at peak. If p95
   is fine at vus=50 but spikes at vus=100, your capacity ceiling for
   this scenario is somewhere between.

**Finding the breaking point:** Run a scenario, note p95. Edit the
script's `stages` to peak at `target: 100`, run again. Then 200, 500.
The VU count at which p95 climbs past 2s OR errors exceed 5% IS your
concurrent-user capacity for that endpoint.

---

## Capacity-planning summary

Fill in after first run:

| Scenario | VUs sustained at p95 < 1s | Breaking point (p95 > 2s) | Notes |
|----------|---------------------------|---------------------------|-------|
| 01 anon-marketing |  |  |  |
| 02 signin |  |  | Supabase rate-limit hit at ___ |
| 03 inventory-list |  |  |  |
| 04 search-palette |  |  |  |
| 05 item-detail |  |  |  |
| 06 inventory-write |  |  |  |
| 07 procedure-list |  |  |  |
| 08 shipment-detail |  |  |  |

---

## Cost warning

Each full run (`run-all.sh`) is roughly:

- **Vercel egress:** ~500 MB (8 scenarios x ~2 min x ~50 VUs x ~5 KB avg payload)
- **Supabase requests:** ~50,000 DB queries
- **Supabase auth calls:** ~5,000 sign-ins if scenario 02 is enabled

Pro tiers absorb this fine but watch your monthly usage if you're
running daily. Don't leave a load test running unattended.

---

## Troubleshooting

- **"BASE_URL env var is required"** — set `export BASE_URL=...` or
  pass it inline: `BASE_URL=... k6 run ...`.
- **All 30x responses with `Location: /signin`** — your
  `SUPABASE_AUTH_COOKIE` expired or is wrong. Re-grab it from a fresh
  browser sign-in.
- **All 401s on /api/search** — `SUPABASE_ACCESS_TOKEN` is invalid or
  expired. JWTs from Supabase typically last 1 hour.
- **Scenario 02 returns 429 immediately** — you hit Supabase auth
  rate limit. Wait 5 min, lower the VU ceiling in `options.stages`.
- **k6 inspect parses but k6 run errors at startup** — usually a
  missing required env var. The scripts fail loudly via `fail()` so
  read the first line of stderr.
