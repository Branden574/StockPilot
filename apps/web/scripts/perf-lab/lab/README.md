# Production-model lab (LOCAL ONLY)

Measures a LOCAL production build (`next build` + `next start`) against the
LOCAL Supabase stack holding the Perf Lab copy, with production's cost of a
call put back in. Nothing here touches production.

Why: a local stack answers a PostgREST call in ~2 ms, where production's
server calls (Vercel iad1 -> Supabase) cost p50 36 ms, p75 58, p90 137, p95 389,
p99 1675 (edge_logs `response.origin_time`, server UA, entering IAD,
2026-09-22 13:00-21:00Z). Without that cost, calls made one after another
look free and the lab cannot see a serial chain.

| File | What it does |
| --- | --- |
| `latency-relay.mjs` | HTTP + WebSocket relay on :54400 in front of the local API (:54321). Mode from `.latency-mode`: `off`, `fixed:<ms>` (every request waits that long), or `empirical` (a seeded draw from the quantiles above). Re-read every second. `TRACE_FILE=<path>` writes one line per request: start, injected wait, total ms, method, path WITHOUT query string (storage paths cut to the bucket), status, server or browser. `GET /__mark/<label>` writes a marker line. |
| `trace-nav.mjs` | Signs a lab account in (local service key, magic link), then clicks through Items, Books, Orders, Item, the Movements and Activity tabs, an order, and an adjust-then-see, bracketing each with relay markers. Browser round trip 130 ms (emulated). |
| `trace-summary.mjs` | Per navigation: Supabase calls (server / browser), serial waves, time to content. `DETAIL=1` prints one navigation's call timeline. |
| `seed-history.local.sql` | Production-shaped item history for the lab org (per item: movements p90 5 / max 28, audits p90 6 / max 57, production 2026-09-22; the 40 most recently updated items get the max). |

Build the app against the relay (NEXT_PUBLIC_* is inlined at build time).
Override the email, payment and AI provider variables with empty values in the
same shell so nothing can leave the machine:

```bash
# local keys, never printed
eval "$(supabase status -o env | grep -E '^(ANON_KEY|SERVICE_ROLE_KEY)=')"
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54400 NEXT_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY" \
SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" pnpm build
# same variables for `npx next start -p 3000`
echo fixed:36 > scripts/perf-lab/lab/.latency-mode
node scripts/perf-lab/lab/latency-relay.mjs &
```

Then the harness with `PERF_BASE_URL=http://localhost:3000`,
`PERF_SUPABASE_URL=http://127.0.0.1:54321`, `PERF_NETWORK=rtt-130`.

Lab numbers leave out what only production has: Vercel's Data Cache latency,
Fluid instance contention and cold starts, and correlated gateway stalls. Use
them to compare builds under the same condition, never as production numbers.
