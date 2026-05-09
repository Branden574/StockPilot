# Security

This document captures the security posture of StockPilot for the
operators of the production deployment. Last refreshed: 2026-05-09.

## Reporting a vulnerability

Email **branden574@gmail.com** with subject `[security] StockPilot`.
Please include reproduction steps, the affected URL/endpoint, and
your contact info. Acknowledged within 48 hours.

Do not file public GitHub issues for vulnerabilities.

## Threat model

StockPilot is an **invite-only internal tool** for L4L Fresno and
similar partner organizations. The threat actors we design against
are, in priority order:

1. **A signed-in viewer or staff member** who tries to act outside
   their permission scope (escalation, cross-org reads, mass
   deletion). Mitigated by RLS, server-side `assertPermission()`,
   and SECURITY DEFINER RPCs that gate by role.
2. **An external partner with a public order link** who tries to
   submit garbage / spam / cross-org references. Mitigated by
   rate limit, books-only filter, single-warehouse scope, manager
   approval.
3. **An anonymous attacker on the internet** who finds the marketing
   site and probes it. Mitigated by HSTS+CSP, no public sign-up,
   no leaked enumeration paths, hardened headers.

Out of scope: nation-state attackers, physical access to a signed-in
device, social engineering of org owners, supply-chain attacks
against Vercel/Supabase/Resend themselves.

## What we've hardened

Tracked across migrations 0040–0048 and the security commits in May
2026:

- RLS `WITH CHECK` on every `FOR UPDATE` / `FOR ALL` policy in the
  schema (12 tables, migration 0046).
- SECURITY DEFINER on the bundle/order RPCs with `has_org_role`
  guards inside.
- MFA AAL2 server-side enforcement: every `assertPermission()` gate
  refuses to fire if the org's `mfa_policy` requires MFA and the
  current session is at AAL1.
- SSRF blocklist (`lib/ssrf-guard.ts`) on every server-side `fetch()`
  of a user-supplied URL.
- Persistent rate limit (Postgres-backed atomic counter, migration
  0048).
- Storage buckets pinned with `allowed_mime_types` + `file_size_limit`.
- CSP with `strict-dynamic`, HSTS preload, redacted error messages,
  CSV formula-injection guard, scheme allowlists on link rendering.
- `signOut({ scope: 'global' })` revokes all refresh tokens for the
  user across every device.

## Recommended Supabase project settings

These live outside the repo (Supabase dashboard) and are easy to
forget. Set them once per project:

### JWT TTL

Default: **3600 seconds** (1 hour). The access token stays valid for
this long after issuance; even after `signOut({ scope: 'global' })`,
already-issued access tokens remain valid until expiry.

**Recommendation: drop to 600 seconds.** Cuts the cross-tab leak
window from 1 hour to 10 minutes for an account compromise scenario,
without meaningfully impacting UX (Supabase auto-refreshes tokens in
the background). Set in Supabase → Authentication → Sessions → JWT
expiry.

### Email confirmation

Should be **required** for password sign-up. Verify via dashboard:
Authentication → Providers → Email → "Confirm email" enabled. (Org
membership is invite-only, so this only matters for the org owner's
own account.)

### Rate limits

Supabase ships built-in per-IP rate limits on `/auth/*` endpoints.
Defaults are sane; only revisit if you see legitimate users hitting
them. Authentication → Rate Limits.

### MFA policy

Set per-org via `organizations.mfa_policy` (`optional` |
`admins_required` | `all_required`). The dashboard layout shows a
banner and every server action enforces AAL2 server-side when
required (since 62a71ef).

### Webhook secrets

`STRIPE_WEBHOOK_SECRET` and `CRON_SECRET` are validated on every
inbound call. Both fail closed if unset (since 28c0270). Rotate any
secret if you ever paste it in Slack/email/screenshot.

## Vendor data flow

Every external service the app talks to and what data crosses the
wire. Use this when answering "what data leaves the system?" for
partners or audits.

### Supabase (database, auth, storage, realtime)

Hosted Postgres + auth + object storage + WebSocket realtime. **All**
inventory rows, audit logs, and uploaded images live here. RLS
applies to every row read; storage bucket policies apply to every
file. Customer data is **never** sent to a third party other than
the ones below.

- Region: configured in Supabase project settings; choose us-east
  for L4L Fresno alignment.
- Backups: Supabase managed, daily; restore via support.

### Resend (transactional email)

Used for: order request confirmation, status updates (approved,
denied, packaging, ready, delivered), weekly inventory digest.

- Data sent: recipient email, recipient name, request id, line
  summary (item names + qty), org name + logo URL.
- Data NOT sent: cost basis, supplier names, internal notes,
  warehouse locations, member emails other than the requester.
- Stored at Resend: 7-day delivery log retention by default.
  Adjust in Resend dashboard.

### Stripe (billing, deferred — currently quiet for L4L Fresno)

Used for: subscription checkout, customer portal, webhook events.

- Data sent: org id (as Stripe customer metadata), plan id, owner
  email.
- Data NOT sent: any inventory data, member list, items, etc.
- Stored at Stripe: standard customer + subscription objects.

### Google Gemini (AI assistant + Vision)

Used for: chat-driven inventory queries, ISBN lookup, photo-based
book identification, PO scan extraction.

- Data sent **per chat turn**: the user's message + matching tool
  call results (item names, quantities, etc.). Org name and member
  identities are NOT sent.
- Data sent **per Vision call**: a single uploaded image (≤6 MB)
  + a short prompt.
- Stored at Google: AI Studio retention is 30 days for abuse review
  per Google's policy. Free tier; production traffic should be on a
  paid project to opt out of training data use.
- The chat tool catalog is the ONLY way data flows out — every tool
  result that gets fed back to the model has been filtered server-
  side through ServiceContext + RLS.

### Vercel (hosting, edge, image optimization)

Used for: web app hosting, edge cache, image optimization for
public covers.

- Data observable in Vercel logs: HTTP method, path, status, IP,
  user agent. Bodies are NOT logged. Function stdout from
  `console.error` IS logged (we route all sensitive errors through
  `reportError()` instead).

### Expo Push Notifications

Used for: cycle-count assignment alerts, low-stock pings, bundle
shortage alerts.

- Data sent per push: device push token + title + body + a deep-
  link payload like `{ link: '/dashboard/inventory/<uuid>' }`.
- Stored at Expo: 30 days for delivery receipts.

## Audit trail of security work

Every fix is in git. Run `git log --grep="fix(security)"` and
`git log -- 'supabase/migrations/004*.sql'` for the full record.
Major commits:

- `1340f2a`, `3dbd0db`, `28c0270`, `5353668`, `fe30b74`, `6ef053b`,
  `59879b6`, `e64b242`, `5941129`, `e4b08fd`, `7a44761`, `62a71ef`,
  `9f24266`, `fdb3b6d` (May 2026 hardening pass)

## Things we haven't done

Honest list:

- **No formal third-party penetration test.** Eight in-house
  audits + offensive sweep have caught a lot, but a paid pentester
  with Burp will probably find more. Schedule one if revenue or
  regulatory requirements warrant.
- **No SOC 2 / ISO 27001 process.** Not relevant at L4L Fresno
  scale; revisit if commercial customers ever appear.
- **No bug bounty program.** Reporting goes through the email at
  the top of this file.
