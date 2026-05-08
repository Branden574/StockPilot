# Weekly Email Digest

**Date:** 2026-05-08
**Status:** Approved (proceeding to implementation)
**Owner:** Branden Vincent-Walker

## Goal

Send a single weekly email each Monday morning summarizing what needs attention in an org's inventory. Users opt in via a toggle in settings; default off so the cron can't spam anyone before they explicitly enable it. Adds a "Send preview now" button so the digest is testable without waiting a week.

## Scope

- **In:** weekly summary email (low stock + open POs + open cycle counts), opt-in toggle, preview button, Vercel cron, schema migration for the opt-in flag
- **Out:** per-section opt-in, configurable cadence, Slack/SMS/push, daily digests, HTML editor, localization, archive of past digests

## User-visible behavior

### Settings page (new toggle + button)

In `/dashboard/settings` (probably under a "Notifications" subsection — verify at impl time), add:

- Toggle: **"Email me a weekly inventory digest"** (off by default)
- Below it: **"Send preview now"** button — fires the digest immediately to the current user. Disabled while the toggle is off; clicking it enables a one-shot test send regardless of opt-in state. Surfaces toast feedback (`Sent` / error message).

### Cron run

Every Monday at 14:00 UTC (~ 7 AM Pacific, ~ 10 AM Eastern), the cron route fires. For each opted-in user across all orgs:

1. Compute the digest payload for that user's org
2. If all three sections are empty → skip the send entirely (no "all clear" emails)
3. Otherwise send via Resend, subject like `StockPilot weekly digest — May 5, 2026`

### Email content (3 sections)

Each section is skipped when its data is empty.

1. **Low / out of stock** — top 20 items at or below reorder point or with qty <= 0. Grouped by warehouse. CTA: link to `/dashboard/inventory?stock=low&type=all`.
2. **Open purchase orders** — POs with status `ordered | expected_inbound | partially_received`. Overdue ones (expected date past today) flagged. CTA: link to `/dashboard/purchase-orders`.
3. **Cycle counts in progress** — open cycle counts with progress %. CTA: link to `/dashboard/cycle-counts`.

Footer includes: link to settings to unsubscribe / manage frequency.

## Architecture

### Migration

`supabase/migrations/00XX_user_email_digest_optin.sql` (number set at impl time):

- Add `email_digest_optin boolean not null default false` to the user-profile table the app already uses
- Verify whether profile data lives in `user_profiles` or auth.users metadata at impl time; if a `preferences` jsonb already exists, use a `digest_optin` key inside it instead of a new column
- No RLS change needed (column inherits the table's row policy, which already gates by user id)

### New service: `apps/web/src/server/services/digest.ts`

```ts
export interface DigestPayload {
  lowStock: Array<{
    warehouseName: string;
    items: Array<{ id: string; sku: string; name: string; qty: number; reorderPoint: number }>;
  }>;
  openPos: Array<{
    id: string; po_number: string; supplier_name: string | null;
    expected_at: string | null; status: string; is_overdue: boolean;
  }>;
  openCycleCounts: Array<{
    id: string; name: string; warehouse_name: string | null;
    items_total: number; items_counted: number;
  }>;
}

export async function getDigestData(orgId: string): Promise<DigestPayload>;
```

- Single org id parameter (not a `ServiceContext`) because the cron iterates orgs with the admin client
- Three queries in `Promise.all`: top-20 low stock, open POs, open cycle counts
- All three queries scoped by `organization_id`
- Returns empty arrays when nothing matches (cron uses `lowStock.length + openPos.length + openCycleCounts.length === 0` to skip)

### Email template additions

`apps/web/src/lib/email/templates.ts` gains:

```ts
export function weeklyDigestHtml(payload: DigestPayload, opts: { orgName: string; appUrl: string; settingsUrl: string }): string;
export function weeklyDigestText(payload: DigestPayload, opts: { orgName: string; appUrl: string; settingsUrl: string }): string;
export function weeklyDigestSubject(): string; // "StockPilot weekly digest — <human date>"
```

Visual style mirrors the existing invite template — same wordmark, same CTA-button styling, same footer pattern. No new design system needed.

### New cron route: `apps/web/src/app/api/cron/weekly-digest/route.ts`

```text
GET /api/cron/weekly-digest

1. Validate Authorization: Bearer ${CRON_SECRET} (same gate as purge-ai-chat-history)
2. admin = createAdminClient()
3. List opted-in recipients across all orgs:
     select user_id, organization_id, email
     from user_profiles up join organization_members om on …
     where up.email_digest_optin = true
4. Group recipients by organization_id
5. For each org: payload = getDigestData(orgId)
   if isEmpty(payload): continue
   for each recipient: sendEmail({ to, subject, html, text }) — sequential, swallow individual errors so one bad address doesn't kill the run
6. Return { ok: true, sent: N, skipped: M, failed: K }
```

### Vercel cron config

`apps/web/vercel.json` gains:
```json
{ "path": "/api/cron/weekly-digest", "schedule": "0 14 * * 1" }
```

### Settings UI changes

`apps/web/src/app/(dashboard)/dashboard/settings/...` — locate the existing settings page (or notifications subsection). Add:

- A `<Switch>` component (verify availability — if not present, use `<Checkbox>` from inventory-table or build a small one)
- Bound to a server action `setDigestOptinAction(boolean)` that updates the user's profile row
- A button "Send preview now" → calls `sendDigestPreviewAction()`. Server action computes the digest for the calling user's org and sends it to their email immediately. Returns `{ ok, sent, skipped }`. UI shows toast.

### Server actions

`apps/web/src/server/actions/digest.ts` (new):

- `setDigestOptinAction(optIn: boolean)` — updates the user's row, asserts authenticated user
- `sendDigestPreviewAction()` — gets calling user's email + org, calls `getDigestData`, builds template, calls `sendEmail`. Bypasses the empty-skip rule (so the user can confirm the email arrives even when there's nothing to flag — empty sections rendered as "Nothing here. ✓").

## Edge cases

- **No recipients across all orgs** → cron returns `{ ok: true, sent: 0 }` immediately, doesn't query org data
- **All sections empty for an org** → entire send skipped (per spec)
- **Single user opted in but `user_profiles.email` is null/invalid** → log + skip that recipient, keep going
- **`RESEND_API_KEY` unset** → `sendEmail` early-returns with the dry-run path; cron still completes `{ ok: true, sent: N }` based on what it intended to send. Useful before email is fully wired in lower environments.
- **Preview button when sections are empty** → still send (so the user sees confirmation the pipeline works)
- **User opts in, then leaves the org** — `organization_members` join filters them out automatically; their preference row stays harmless

## Testing

Manual:
- Toggle on in settings, click "Send preview now", verify email lands in inbox with all three sections
- Manually create a low-stock condition, regenerate preview, verify Low Stock section appears
- Verify cron auth: hitting `/api/cron/weekly-digest` without `Authorization: Bearer <CRON_SECRET>` returns 401
- Verify empty-digest skip: log-in as a fresh org with no data, click preview, verify the email still sends (preview override)

Automated: not adding unit tests for the email rendering this round — output is mostly string concatenation; eyeball QA on preview email is faster.

## Out-of-scope follow-ups

- Per-section opt-in
- Daily / configurable cadence
- Localization & timezone awareness (pick org timezone for the date in the subject)
- Past-digests archive page
- Slack / SMS delivery channels
- HTML editor

## Decision log

| Decision | Why |
| --- | --- |
| Default off | Resend just got wired; we should not auto-send to anyone before they explicitly opt in |
| Empty digest = skip send | Prevents the digest from becoming noise; absence of a digest is itself a signal |
| Live queries, not the `notifications` table | Notification rows can be stale (e.g. low-stock notif from yesterday but already restocked); fresh queries always reflect reality |
| Single weekly cadence, no UI knob | YAGNI — one schedule until someone needs more |
| "Send preview now" bypasses empty-skip | Lets the user confirm the pipeline works without waiting for real data |
| One email per recipient (sequential) | Simpler than batching; volumes are tiny in an internal tool |
| Reuse existing CRON_SECRET pattern | Same gate as purge-ai-chat-history; one fewer concept to learn |
