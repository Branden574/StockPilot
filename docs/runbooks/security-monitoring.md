# Security monitoring (Cybersecurity Phase 1 + 2)

Status as of 2026-06-26: **anomaly alerting + uptime/SSL are LIVE.** The only
deferred item is external **log drains** (a Supabase Team-plan feature — see
below). All alerts land in the StockPilot Slack **#alerts** channel via
`ERROR_WEBHOOK_URL` (set in Vercel Production).

## Live monitors

| Monitor | What it watches | Cadence | Alerts to |
|---|---|---|---|
| `cron/audit-anomalies` | audit_logs over the last hour. 5 detectors: failed-login bursts (per email + per IP), password-reset bursts, privilege escalations (role → admin/owner), mass deletes/archives (per actor), export abuse (per actor). | hourly (`0 * * * *`) | Slack #alerts (reportError) |
| `cron/auth-anomalies` | `user_login_devices` — a user registering ≥4 new devices in 24h (account-sharing / takeover signal). | every 6h (`0 */6 * * *`) | Slack #alerts |
| `cron/ssl-check` | TLS cert expiry on the primary domain. | daily (`0 9 * * *`) | Slack #alerts |
| Security events (Phase 1) | 7 `security.*` events dispatched live: new-device login, MFA unenroll/policy change, API key create/revoke, role change, export-rate-limit trip. | real-time | Slack #security (integration webhook) + #alerts |
| UptimeRobot | `https://stockpilotusa.com/api/health` every 5 min. | external | email → branden574@gmail.com |

Thresholds for the anomaly crons live at the top of each route file and are
tunable as traffic grows. Each cron is CRON_SECRET-gated and paginates its query
(no silent 1000-row cap under an attack spike).

## Log drains — deferred (owner decision)

Supabase **Log Drains** stream Postgres/Auth/API logs to an external
destination (Datadog, Better Stack, Logflare, a generic HTTP sink, etc.) for
long-term retention + SIEM-style correlation beyond Supabase's built-in
retention (7 days on Pro).

**Decision (2026-06-26): defer.** Log drains require the Supabase **Team plan
(~$599/mo)** — not justified at current scale. The hourly anomaly crons + the
real-time security-event feed + 7-day built-in log retention + UptimeRobot cover
the practical detection/forensics need today.

**Revisit when:** a compliance requirement (SOC 2 / customer DPA) demands
centralized immutable logs, OR scale makes the 7-day window too short for
incident forensics.

**When ready (setup):**
1. Stand up a destination (Better Stack / Logflare are the cheapest log sinks;
   Datadog if you already use it).
2. Supabase Dashboard → Project Settings → **Log Drains** → add the destination
   (HTTP endpoint + auth header, or the native Datadog/Logflare integration).
3. Point a saved search / monitor at the high-signal events (auth failures,
   role changes, RLS denials) and route to Slack #alerts.
4. Upgrade to Team plan first (the feature is gated).
