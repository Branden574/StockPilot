# StockPilot load tests

k6 load tests for capacity planning and before/after comparisons. They run
against a **local** production build of the app and a **local** Supabase stack,
signed in as real roles, doing real inventory and order work. They are not a CI
gate.

---

## Hard rules

1. **This machine only.** Every scenario and every tool refuses an address that
   is not `127.0.0.1` or `[::1]` (`k6/lib/safety.js`), before the first
   request. The name `localhost` is refused too: it is a name, and an
   environment proxy setting can send it elsewhere. There is no default address
   anywhere and no override. A preview deploy or the production site cannot be
   a target. k6 never follows a redirect, and the Node tools refuse one.
2. **The app under test calls no outside service.** Build and serve it only in
   a worktree with **no `apps/web/.env*` file** (Next.js reads those, and a
   checkout's file may hold real keys). The app env file written by
   `local-env.mjs` sets every outside-service key the app reads (email, AI,
   book lookups, payments, analytics, maps, accounting, push, error webhooks,
   hosting) to empty, so none can come from anywhere else
   (`k6/tools/app-env.mjs`). `run-scale.mjs` refuses to start when this
   checkout or the folder the app runs from has an `apps/web/.env*` file, or
   when the app's Content-Security-Policy names a Supabase address other than
   the local stack.
3. **Keys stay in the environment.** The env files live outside the repository
   (mode 600) and are loaded without printing. The service key is read only by
   the seeder and inside k6 `setup()`; it is never logged, tagged or written to
   a summary. The k6 summary drops `setup_data`, which holds the session tokens.
4. **Made-up data only.** The seeder makes a throwaway organization
   (`loadtest-<id>`, named `Load Test Org <id>`) with
   `loadtest+...@example.com` accounts; teardown removes all of it and fails if
   a row is left.
5. **A run fails loudly.** A redirect to sign-in, a 401, an authenticator
   demand, another warehouse's item seen by one-warehouse staff, a viewer write
   that is not refused, or a resend that does not replay stops or fails the run,
   as does a correctness check on the data afterwards. Slowness fails the p95
   targets, and a run that could not deliver its offered load (dropped
   iterations) fails too.

`apps/web/src/test/load-tests-safety.guard.test.ts` checks rules 1 and 2 and
the session cookie on every CI run.

---

## Set up once

You need Docker, the Supabase CLI (the version CI pins), k6 (`brew install k6`)
and Node 22.

Use a worktree with no `apps/web/.env*` file (`ls -a apps/web` shows none
but `.env.example`).

```bash
STACK=~/Developer/stockpilot-work/loadtest-stack     # any folder OUTSIDE the repo

# 1. A separate local Supabase stack (own project id and ports 58420-58424).
node load-tests/k6/tools/prepare-stack.mjs --dir "$STACK" --project-id spload --port-base 58420
supabase start --workdir "$STACK" -x studio,imgproxy,edge-runtime,logflare,vector,supavisor,postgres-meta,mailpit

# 2. The env files, written from the stack's status without printing a value.
supabase status -o env --workdir "$STACK" | \
  node load-tests/k6/tools/local-env.mjs --app-env "$STACK/app.env" --loadtest-env "$STACK/loadtest.env" --port 3600

# 3. Build and start the app against that stack (production build, port 3600).
cd apps/web
( set -a; . "$STACK/app.env"; set +a; pnpm build && exec npx next start -p 3600 -H 127.0.0.1 )
```

`prepare-stack.mjs` copies `supabase/` (never its `.temp` or `.branches`
folders, where a linked checkout keeps the link, and it checks the copy holds no
link) and changes only the copy's `config.toml`: its own project id and ports, studio and edge functions off, and
GoTrue's rate limits raised (one machine mints hundreds of sessions in
`setup()`; the default allows 30 sign-ins per 5 minutes). Rebuild the app
whenever the code under test changes; restart the stack (`supabase stop
--workdir "$STACK"`, then start) to begin from an empty database.

---

## Run a scale point

```bash
node --env-file="$STACK/loadtest.env" load-tests/k6/run-scale.mjs \
  --items 10001 --users-per-role 40 \
  --ladder 25,50,100,250 --duration 5m --warmup 60s \
  --label "main abc1234" --out load-tests/results/main-10k
```

One command: seed, warm up, run each step of the ladder, check the data after
each step, write `report.md` and `report.json` in `--out`, tear down.

| Option | Default | Meaning |
|---|---|---|
| `--items` | 1000 | Items to seed: 1,000 / 10,001 / 50,000 are the scale points |
| `--users-per-role` | 20 | Accounts per role; 40-50 for the 250 step so per-person limits are not the bottleneck |
| `--ladder` | 25,50,100,250 | Concurrent people per step |
| `--duration` | 3m | Steady time per step (at most 50m: sessions last an hour) |
| `--warmup` | 30s | One run at the first step before the ladder, not reported (`0` skips it) |
| `--manifest` | | Reuse an organization seeded earlier (no seeding, no teardown) |
| `--keep` | | Keep the seeded organization at the end |
| `--continue-on-fail` | | Run the next step even when a p95 target failed (a sign-in, scope or correctness failure always stops the ladder) |
| `--scenario` | `scenarios/10-roles-workload.js` | Another scenario built on `lib/workload.js` (only a `.js` file in `k6/scenarios/`) |

Other knobs, as environment variables: `LOADTEST_P95_SSR_MS` (1500),
`LOADTEST_P95_API_READ_MS` (800), `LOADTEST_P95_WRITE_MS` (2000),
`LOADTEST_MIX` (role shares as JSON, e.g. `{"staff":0.6,"viewer":0.4}`),
`LOADTEST_SESSIONS_PER_ROLE` (50), `LOADTEST_REPLAY_SHARE` (0.1),
`LOADTEST_MAX_DROPPED_PCT` (1: the share of planned iterations a step may drop).

For a before/after comparison, run the same command on both builds against
freshly started stacks and compare the two `report.md` files.

### Seed and tear down by hand

```bash
node --env-file="$STACK/loadtest.env" load-tests/k6/tools/seed.mjs --items 1000 --users-per-role 20 --out /tmp/lt/manifest.json
node --env-file="$STACK/loadtest.env" load-tests/k6/tools/teardown.mjs --manifest /tmp/lt/manifest.json
node --env-file="$STACK/loadtest.env" load-tests/k6/tools/teardown.mjs --all         # lists what it would delete
node --env-file="$STACK/loadtest.env" load-tests/k6/tools/teardown.mjs --all --yes   # deletes it
```

`--all` finds only what the seeder makes: organizations whose slug is
`loadtest-<4-16 letters or digits>` and whose name is `Load Test Org <the same
id>`, and `loadtest+<id>-<role>-<n>@example.com` accounts in no other
organization. `--manifest` deletes one seeded organization, its accounts and
only those accounts' rate-limit rows. Both refuse a database that is not on this
machine.

What the seeder makes: one organization (enterprise plan, every module on,
authenticator policy optional), accounts for owner, admin, manager, staff,
viewer and staff limited to the first warehouse, two warehouses (70% of items
in the first), 12 categories, 3 suppliers, N items with stock (the item insert
trigger `tg_seed_initial_level` creates each holding in the warehouse's
Unplaced location; an `initial` stock movement is written beside it, as the
app's create does), 8 open purchase orders x 25 lines of 1,000,000 units, then
`ANALYZE`. Writes go in transactions of at most ~36k rows (12k items, their
holdings and their opening movements). The manifest lists the accounts and the
id pools the workload draws from; it holds no keys or tokens.

---

## The workload (`k6/scenarios/10-roles-workload.js`)

Each role is a k6 scenario with a **constant arrival rate** (an open model: the
offered load is the same however slow the build is). One iteration is one
action by one signed-in person, then that person's think time: **3-8 s on the
web, 1-3 s on the phone**. The rate for `A` concurrent people is `A / (mean
think + mean answer)` per role, so "100 actors" means about 100 people working
at human speed. Default shares: staff 45%, viewer 20%, manager 15%, one-warehouse
staff 10%, admin 8%, owner 2%.

| Action | Surface | Kind | Request |
|---|---|---|---|
| dashboard_home | web | ssr | `GET /dashboard` |
| items_list | web | ssr | `GET /dashboard/inventory` pages 1-5, with status, low stock, sort or search |
| low_stock | web | ssr | `GET /dashboard/inventory?stock=low` |
| item_detail | web | ssr | `GET /dashboard/inventory/[id]` (must show the item's SKU) |
| web_search | web | api_read | `GET /api/search?q=` with the session cookie |
| orders_new | web | ssr | `GET /dashboard/orders/new` |
| phone_permissions | phone | api_read | `GET /api/v1/me/permissions` |
| phone_storefront | phone | api_read | `GET /api/v1/orders/storefront` |
| phone_catalog | phone | api_read | `GET /api/v1/orders/catalog?warehouseId=` |
| phone_lookup | phone | api_read | `GET /api/v1/items/lookup?code=` (barcode or SKU; must find the item) |
| phone_history | phone | api_read | `GET /api/v1/items/[id]/history?limit=50` |
| place_order | phone | write | `POST /api/v1/orders` (201); 10% resent with the same key must replay (200, same order) |
| adjust_pair | phone | write | `POST /api/v1/items/[id]/adjust` +1 then -1 |
| receive_line | phone | write | `POST /api/v1/po/[id]/receive-line` qty 1 (manager and above); 10% resent must answer the same receipt |
| viewer_write_denied | phone | write_refused | a viewer's adjust must be refused with 403 |
| scope_probe | web/phone | probe | one-warehouse staff search, scan, open and list the other warehouse's items and must see none |

Every request is tagged `kind`, `role` and `action`. The p95 targets hold the
timed kinds: `ssr`, `api_read` and `write` (a write that changes data). The
resends (`write_replay`, answered from the stored result), the viewer's refused
writes (`write_refused`) and the scope probes (`probe`) are reported apart, so
a fast refusal does not flatter the write numbers. Pages are sent with the
session cookie and `redirects: 0`; `/api/v1` with the bearer token, as the
phone sends them.

### Sessions

In `setup()` (`k6/lib/auth.js`), for each seeded account: the local GoTrue
password sign-in, `POST /auth/v1/token?grant_type=password` with the anon key,
the way the app's own sign-in does it. Each seeded account's password is derived
from the local stack's service key and its email (HMAC-SHA256, made up, never a
real person's): the seeder sets it and `setup()` derives it again, so no
password is stored anywhere. The answer must name the expected account. The
access token is the bearer; the same session encoded the way the installed `@supabase/ssr` stores it
is the cookie (`k6/lib/cookie.js`: name `sb-<host's first label>-auth-token`,
value `base64-` + base64url of the session JSON, split into `.0`, `.1`, ...
past 3180 characters). `setup()` then checks every account's
`/api/v1/me/permissions` answers its role, that a gated read (`/api/search`)
does not answer `mfa_required` (the permissions route answers even when an
authenticator is owed), and that one page per role opens with the cookie (200,
not a redirect).
Each VU keeps one session for the whole run.

### What fails a run

| Threshold | Fails when |
|---|---|
| `checks` | under 99% of checks pass |
| `auth_ok` (abort) | any answer is a 401, a redirect to sign-in or an authenticator demand |
| `signin_redirects`, `mfa_required` (abort) | any |
| `scope_violations` (abort) | one-warehouse staff see any other-warehouse item |
| `viewer_write_allowed` (abort) | a viewer write is not refused |
| `replay_mismatch` | a resend with the same key does not replay |
| `http_req_failed` | 1% or more of answers are not the expected status (2xx, or the 403/404 a probe expects; a 3xx counts as failed) |
| `http_req_duration{kind:ssr / api_read / write}` | p95 over 1500 / 800 / 2000 ms (configurable) |
| `dropped_iterations` | more than `LOADTEST_MAX_DROPPED_PCT` (1%) of the planned iterations could not start on time: the step did not deliver the load it reports |

After each step `tools/check-correctness.mjs` checks the data: on hand equals
the sum of holdings (items touched, and every item), no negative holding or on
hand, orders created equal the 201 answers with one order per submission key,
receipts equal the receive answers with no key used twice and one line and one
movement each, purchase order received quantities equal their receipt lines,
and adjust movements equal the adjust answers with a net change of up minus
down. The runner first waits for the database to go quiet (no request from the
app still running). A write the end of the step cut off (sent, never answered:
k6 stops requests still in flight when `gracefulStop` runs out) may or may not
have been committed; the check allows each such write either way and the
report shows how many there were (`unanswered writes`).

### The report

Per step: offered arrivals per role, planned and dropped iterations,
requests, throughput (workload requests over the configured step time; the
sign-ins in `setup()` and the graceful stop are left out), failures, checks,
unanswered writes,
p50/p95/p99 by kind, by kind and role and by action, response size, database
statements per request and the 15 costliest statements (pg_stat_statements
before and after, by database role, top-level statements only), connection
counts before, after and the sampled peak, and the correctness result.

---

## Single-purpose scenarios

All need the same environment plus `LOADTEST_MANIFEST` (a seeded
organization's manifest) except 01, 99 and 99b, which are signed out.

| # | File | What it does | Auth |
|---|------|--------------|------|
| 01 | `01-anon-marketing.js` | `/` and `/pricing` | none |
| 02 | `02-signin.js` | local Supabase `/auth/v1/token` password grant for one seeded account (`LOADTEST_SIGNIN_EMAIL`; `setup()` derives its password) | n/a |
| 03 | `03-inventory-list.js` | items list pages, filters, low stock (staff, managers) | cookie |
| 04 | `04-search-palette.js` | `/api/search` spread over every staff, viewer and manager account | cookie |
| 05 | `05-item-detail.js` | item pages | cookie |
| 06 | `06-inventory-write.js` | adjust pairs, receive lines, place orders | bearer |
| 07 | `07-procedure-list.js` | `/dashboard/procedures` | cookie |
| 10 | `10-roles-workload.js` | the full signed-in workload above | both |
| 99 | `99-capacity-anon.js` | signed-out stair-step to 500 VUs | none |
| 99b | `99b-sustained-250.js` | 250 signed-out VUs for 2 minutes | none |

```bash
set -a; . "$STACK/loadtest.env"; set +a
LOADTEST_MANIFEST=/tmp/lt/manifest.json LOADTEST_ACTORS=25 LOADTEST_DURATION=2m \
  k6 run --no-usage-report load-tests/k6/scenarios/03-inventory-list.js
LOADTEST_MANIFEST=/tmp/lt/manifest.json ./load-tests/k6/run-all.sh   # 01 and 03-07 in a row
```

Run them against a stack you can throw away: 06 writes.

---

## Capacity table

Measured with `run-scale.mjs` on a local production build and local stack
(one machine: the app, the database and k6 share its CPU, so these are
comparisons between builds, not production capacity). Fill in from
`report.md`; leave a cell empty until a run measured it. The 1,000 item rows
are the suite's proof runs (10 accounts per role, 2 minutes per step, after a
30 s warm-up, on an Apple silicon laptop that was also running the stack and
k6). The 25 row is from an earlier version of the runner: its requests/s
counted the `setup()` sign-ins in the step time, and its write p95 included the
viewer's refused writes and the resends.

| Scale point | Actors | Requests/s | Dropped | ssr p95 ms | api_read p95 ms | write p95 ms | Failed | Correctness | Build | Date |
|---|---|---|---|---|---|---|---|---|---|---|
| 1,000 items | 5 | 1.3 | 0 / 144 | 280 | 209 | 224 | 0.00% | pass | main d565102a7 | 2026-11-17 |
| 1,000 items | 10 | 2.8 | 0 / 296 | 190 | 138 | 153 | 0.00% | pass | main d565102a7 | 2026-11-17 |
| 1,000 items | 25 | (5.3) | | 1480 | 779 | (905) | 0.00% | pass | main d565102a7 | 2026-11-17 |
| 10,001 items | 25-250 | | | | | | | | | |
| 50,000 items | 25-250 | | | | | | | | | |

---

## Troubleshooting

- **"LOADTEST_BASE_URL is not set" / "does not point at this machine"**: load
  the env file (`node --env-file=...`, or `set -a; . file; set +a` for k6) and
  use a `127.0.0.1` address.
- **setup() stops with "answered /api/v1/me/permissions with 401"**: the app
  was built against another stack. Rebuild with the stack's `app.env`.
- **setup() stops with "did not open /dashboard: 307"**: the cookie was not
  accepted; check `NEXT_PUBLIC_SUPABASE_URL` in the build is the same address
  as `LOADTEST_SUPABASE_URL` (the cookie name comes from its host).
- **The password sign-in in `setup()` answers 429**: the stack was not
  prepared with `prepare-stack.mjs` (GoTrue's default sign-in limit). A 400
  `invalid_credentials` means the accounts were seeded against another stack's
  service key: seed again.
- **run-scale refuses with "app env files" or "connect-src"**: the app was
  built or is served from a checkout with an `apps/web/.env*` file, or built
  without the stack's `app.env`. Build it in a clean worktree with
  `set -a; . "$STACK/app.env"; set +a` in that shell.
- **`rate_limited` above 0**: more VUs than accounts in a role; seed more
  `--users-per-role`.
- **`dropped_iterations` above 0**: k6 needed more VUs than it had ready (it
  starts about twice the actors up front and more as needed, up to four
  times); a large number means the app fell behind the offered rate, and over
  the limit the step fails.
