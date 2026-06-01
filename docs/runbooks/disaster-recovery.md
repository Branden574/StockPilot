# Disaster Recovery Runbook

Restoring the StockPilot Supabase (Postgres) backend after data loss or
corruption. This is a starting framework — the team MUST fill in the RTO/RPO
targets and confirm the backup tier below.

## RTO / RPO (FILL IN)

- **RPO (max acceptable data loss):** TODO — e.g. 24h on daily backups, or near-
  zero with Point-in-Time Recovery (PITR). Depends on the Supabase plan tier.
- **RTO (max acceptable downtime):** TODO — target time from incident to
  restored, verified service.

Confirm which backup tier the production project is on:

- **Daily backups** (default on lower tiers) — RPO is up to ~24h.
- **PITR** (Pro add-on / higher tiers) — restore to any second within the
  retention window; RPO approaches zero. If RPO matters for inventory ledgers,
  enable PITR.

Check at: Supabase Dashboard -> Project -> Database -> Backups.

## What to back up beyond Postgres

Postgres backups do NOT cover everything. A full recovery also needs:

- **Storage buckets** (item images, avatars/logos, order attachments) — these
  live in Supabase Storage, backed separately. Confirm bucket backup/retention.
- **Vault secrets** — connector OAuth tokens + the EasyPost API key live in
  Supabase Vault. A DB restore restores Vault rows, but a restore to a NEW
  project changes the encryption context; treat connectors as needing
  reconnection after a cross-project restore.
- **Environment variables / secrets** (Vercel + EAS): `CRON_SECRET`, Supabase
  service-role key, Resend, EasyPost, QBO client credentials. Keep an inventory
  outside the repo (per MEMORY: env files are being moved off the working tree).

## Restore procedure (Supabase)

1. **Stop writes.** Put the web app in maintenance / pause Vercel Cron so the
   drainer and reaper don't fire against a half-restored DB.
2. **Restore the database:**
   - Daily backup: Dashboard -> Database -> Backups -> Restore (restores to the
     backup timestamp).
   - PITR: Dashboard -> Database -> Backups -> Point in Time -> pick the target
     timestamp (just before the incident).
   - Restoring in-place overwrites the current DB; restoring to a NEW project is
     safer for forensic incidents but requires repointing all clients (Supabase
     URL + keys) afterward.
3. **Regenerate types if schema drifted:** `pnpm db:types` (linked) so the
   app's TypeScript matches the restored schema.
4. **Reconcile integrations:** verify QBO/EasyPost connections still authenticate
   (Settings -> Integrations). After a cross-project restore, expect to
   reconnect OAuth. Replay any dead-lettered `connection_sync_log` rows once
   healthy (see `connectors.md`).
5. **Re-enable writes + Cron**, then smoke-test: log in, view inventory, create a
   test order, confirm the drainer ticks (Settings -> Integrations shows
   success).

## Migration-apply order (IMPORTANT)

Migrations in `supabase/migrations/` are ordered by their numeric prefix and MUST
be applied in that order — later migrations depend on earlier objects (e.g.
returns invariants in `0153`-`0155` depend on `adjust_stock` from `0004`; the
drainer's candidate RPC is `0148`). The Supabase CLI applies them in filename
order; do not cherry-pick or reorder.

Useful scripts (root `package.json`):

- `pnpm db:migrate` — `supabase migration up` (apply pending migrations in order).
- `pnpm db:reset` — `supabase db reset` (LOCAL ONLY — drops + replays all
  migrations from scratch; never run against production).
- `pnpm db:push` — `supabase db push` (push local migrations to the linked
  remote; reserved for the deploy pipeline, not ad-hoc DR steps).
- `pnpm db:test` — `supabase test db` (runs the pgTAP suite in
  `supabase/tests/*.test.sql` against a local stack; use it to verify invariants
  after a restore-to-local before trusting a schema).

After any restore that replays migrations, run the pgTAP suite to confirm the
critical invariants (RLS, returns budget caps, notification writers) survived.
