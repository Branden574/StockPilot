# Cybersecurity Phase 2 — Audit-log anomaly alerting

**Date:** 2026-06-24
**Status:** Approved (design)

## Goal

Extend the existing security-monitoring framework (`server/security/monitors.ts`
+ the `auth-anomalies` cron, which already alerts on new-device spikes) with
audit-log-driven anomaly detectors that flag likely attacks/insider actions and
alert the platform operator's `#alerts` Slack feed via `reportError`.

No new tables — everything runs off the existing `public.audit_logs`
(`organization_id, user_id, event, metadata jsonb, ip inet, created_at`).

Supabase **log drains** (the other half of the original "Phase 2" note) require
the paid Supabase Team plan; that is owner platform config, not code, and is
explicitly out of scope here. Synthetic uptime + SSL checks are already live
(UptimeRobot + the `ssl-check` cron).

## Detectors

All are pure, side-effect-free functions in `server/security/monitors.ts`
(unit-testable in isolation, like `detectDeviceSpikes`). Each takes the
relevant `audit_logs` rows (already filtered by event + window) and returns the
findings to alert on. Default thresholds are tunable consts in the cron.

| # | Detector | Source event(s) | Group key | Threshold (1h window) |
|---|----------|-----------------|-----------|------------------------|
| 1 | Failed-login burst | `user.sign_in_failed` | `metadata.email` AND `ip` | ≥8 per email, ≥15 per IP |
| 2 | Password-reset burst | `user.password.reset_requested` | `metadata.email` | ≥5 per email |
| 3 | Privilege escalation | `user.role.changed` where `metadata.after.role ∈ {admin, owner}` | `organization_id` | ≥3 per org |
| 4 | Mass deletion/archival | `inventory.item.deleted` + `inventory.item.archived` | `(organization_id, user_id)` | ≥25 per actor |
| 5 | Export abuse | `security.export_rate_limited` (newly audited — see below) | `(organization_id, user_id)` | ≥3 per actor |

`metadata` is a flat jsonb: `{ entity_type, entity_id, warehouse_id, before,
after, reason, ...extra }`. So the attempted email lands at `metadata.email`
(the `user.sign_in_failed` action passes `extra: { email }`) and the new role at
`metadata.after.role` (role change writes `after: { role }`).

## Cron

New route `apps/web/src/app/api/cron/audit-anomalies/route.ts`, cloned from
`auth-anomalies`:

- `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`, `maxDuration = 60`.
- Auth: constant-time Bearer `CRON_SECRET` compare, **fail-closed** when unset.
- One paginated (`PAGE_SIZE = 1000`, `.range()`) query over `audit_logs` for the
  union of the detector events with `created_at >= now − 60min`, ordered by `id`.
- Run each detector over its event slice; `reportError(new Error('<label>'),
  { tag: 'cron.audit-anomaly', level: 'warning', extra: {...finding} })` per
  finding (→ `#alerts` Slack, same path as the device-spike monitor).
- Return a JSON summary `{ window, checked, flagged: {byDetector} }`.
- Registered **hourly** (`"0 * * * *"`) in `apps/web/vercel.json`.

### Dedup / windowing

Hourly cron with an exactly-1h look-back gives **non-overlapping** windows, so
each audit row is evaluated once — no repeat-spam of the same condition. All
five detectors use the uniform 1h window (export abuse included; ≥3 trips/hour is
already a strong signal since each trip means the user hit the export ceiling).
Thresholds carry margin, so a rare burst split across the hour boundary still
trips on the following window if the attack sustains. No state table needed.

## Supporting change

`apps/web/src/lib/export-rate-limit.ts` currently only `dispatchEvent`s
`security.export_rate_limited` (per-org webhook, gated to 1 alert/hour/user) — it
writes no `audit_logs` row, so the export-abuse detector has nothing to count.
Add an un-deduped `audit('security.export_rate_limited', { extra: { email } })`
write on each trip so the true per-hour trip count is captured. The existing
dedup-gated per-org dispatch is unchanged.

## Testing

Unit tests in `server/security/monitors.test.ts` for each new detector:
threshold boundary (at / just below), grouping correctness, the role-elevation
filter (a lateral move like staff→manager is NOT flagged; staff→admin is),
empty input, and the dual email/IP grouping for failed logins. No DB needed —
detectors are pure.

## Out of scope / follow-ups

- Supabase log drains (paid Team plan; owner config).
- Per-org dispatch of a `security.anomaly_detected` event so tenant orgs with a
  configured webhook also see anomalies in their own org (v1 alerts only the
  platform operator via `reportError`).
- Threshold tuning once real traffic volume is known.
