# Task 24: Full gate + honesty sweeps + verification log

Branch: `feat/maintenance-requests`
HEAD at start: `3fa52590b335e8c98c123dcb5bda990e2f31fc24` (clean working tree, confirmed via `git status --porcelain` before any command ran)
Run date: 2026-08-06 (local stack already running: `supabase_db_stockpilot` container up 16h prior to this run)
Node v22.22.2, pnpm 9.12.3, Supabase CLI 2.98.2

This is a verification-only task. No source files were modified. Step 3's tautology
re-scan found zero self-referential (`expect(X).toBe(X)`) comparisons across every
target test file — **no rewrite was necessary or made**.

---

## Step 1: Gate suites — REAL command output

All seven gates run sequentially (not in parallel) so output attribution is
unambiguous. All seven are GREEN.

### 1. `pnpm --filter @stockpilot/core test`

```
 Test Files  46 passed (46)
      Tests  873 passed (873)
   Start at  08:32:08
   Duration  1.44s (transform 1.19s, setup 0ms, collect 2.81s, tests 287ms, environment 5ms, prepare 3.23s)
```

Maintenance-relevant files in this run, all passing: `src/schemas/maintenance.test.ts`
(51 tests), `src/maintenance/email.test.ts` (53), `src/maintenance/constants.test.ts`
(15), `src/maintenance/mr-number.test.ts` (10), `src/maintenance/text.test.ts` (13),
`src/email/outlook-compose.test.ts` (14).

### 2. `pnpm --filter web test`

```
 Test Files  464 passed (464)
      Tests  5348 passed (5348)
   Start at  08:32:18
   Duration  43.90s (transform 13.76s, setup 91.05s, collect 130.04s, tests 90.93s, environment 63.63s, prepare 28.89s)
```

The four **R1 delivery pinning suites** (task-3/4/6/9 briefs identify these by name)
ran within this same suite and are confirmed green with their historical, unchanged
counts (120 + 50 + 10 + 14 = 194 total):

```
 ✓ src/components/orders/storefront/delivery-request-action.test.tsx (50 tests) 1289ms
 ✓ src/components/orders/storefront/storefront-overlays.test.tsx (14 tests) 630ms
 ✓ src/components/orders/storefront/storefront-logic.test.ts (120 tests) 59ms
 ✓ src/lib/site.test.ts (10 tests) 4ms
```

`stderr` lines throughout this run (`[env] Using dev fallback for
NEXT_PUBLIC_SUPABASE_URL...`) are expected — Vitest's env-fallback notice, not test
failures.

### 3. `pnpm --filter mobile test`

```
 Test Files  53 passed (53)
      Tests  1101 passed (1101)
   Start at  08:33:10
   Duration  1.80s (transform 1.38s, setup 0ms, collect 5.19s, tests 1.98s, environment 5ms, prepare 3.03s)
```

`stderr` lines from `src/lib/account-eviction.test.ts` (`[account-eviction]
signOutLocal failed Error: Keychain unavailable`, `db closed`, `navigator not
mounted`, `probe exploded`) are the test's own intentional failure-path
simulations — asserted-on `console.error` output from cases that verify the
eviction routine degrades gracefully, not real failures. The file still reports
`✓ ... (60 tests)`.

Maintenance-relevant files, all passing: `src/lib/maintenance-api.test.ts` (37),
`src/lib/maintenance-upload.test.ts` (21), `src/lib/maintenance-email-actions.test.ts`
(20), `src/lib/debounced-list-load.test.ts` (9).

### 4. `pnpm --filter web typecheck && pnpm --filter mobile typecheck`

Web:
```
> @stockpilot/web@0.1.0 typecheck /Users/brandenvincent-walker/Developer/InventorySystem/apps/web
> tsc --noEmit
```
(no output = zero type errors, exit 0)

Mobile:
```
> @stockpilot/mobile@0.1.0 typecheck /Users/brandenvincent-walker/Developer/InventorySystem/apps/mobile
> tsc --noEmit
```
(no output = zero type errors, exit 0)

### 5. `pnpm --filter web lint`

```
✖ 34 problems (0 errors, 34 warnings)
  0 errors and 14 warnings potentially fixable with the `--fix` option.
```
Exit 0. All 34 warnings are pre-existing (`react-hooks/set-state-in-effect`,
`react-hooks/refs`, unused eslint-disable directives) in files unrelated to the
maintenance-requests feature (`recurring-templates-seed-loader.tsx`,
`session-revocation-listener.tsx`, `blank-zero-number-input.tsx`,
`image-variants.worker.ts`, `pdf/*.test.ts`, `nav-settings.test.ts`,
`price-tracking.ts`). Zero warnings in any `maintenance` path.

### 6. `pnpm --filter web build`

```
▲ Next.js 16.3.0 (Turbopack)
✓ Compiled successfully in 1666ms
  Finished TypeScript in 3.2s ...
✓ Generating static pages using 11 workers (113/113) in 449ms
  Finalizing page optimization ...
```
Exit 0. `grep -n "Failed to compile\|Error:\|error TS\|Build failed"` over the full
build log returned zero matches. The route table includes the three maintenance
pages built as dynamic routes:
```
├ ƒ /dashboard/maintenance
├ ƒ /dashboard/maintenance/[id]
├ ƒ /dashboard/maintenance/new
```
plus `/dashboard/settings/maintenance` and `/api/v1/maintenance-requests` (and its
`[id]`, `[id]/share-link`, `[id]/draft-opened` children) and
`/api/cron/maintenance-draft-reminders`.

### 7. `supabase db reset && supabase test db`

`db reset` applied every migration through **0316** clean (NOTICEs throughout are
idempotent-skip messages for objects created earlier in the same migration file —
expected, not errors):

```
Applying migration 0314_maintenance_requests.sql...
NOTICE (00000): trigger "trg_assign_maintenance_request_number" for relation "public.maintenance_requests" does not exist, skipping
NOTICE (00000): trigger "trg_maintenance_requests_updated_at" for relation "public.maintenance_requests" does not exist, skipping
Applying migration 0315_maintenance_photos_bucket.sql...
NOTICE (00000): policy "maintenance-photos org write" for relation "storage.objects" does not exist, skipping
Applying migration 0316_maintenance_attachment_path_uniq.sql...
Seeding data from supabase/seed.sql...
Restarting containers...
Finished supabase db reset on branch feat/maintenance-requests.
```

`supabase test db`:

```
/Users/.../supabase/tests/0314_maintenance_requests.test.sql ........................... ok
/Users/.../supabase/tests/0315_maintenance_photos_bucket.test.sql ...................... ok
/Users/.../supabase/tests/0316_maintenance_attachment_path_uniq.test.sql ............... ok
All tests successful.
Files=114, Tests=1676,  4 wallclock secs ( 0.14 usr  0.07 sys +  0.47 cusr  0.16 csys =  0.84 CPU)
Result: PASS
```

**0207's pgTAP count confirmed at 119.** `supabase/tests/0207_permission_overrides.test.sql`
reported `ok`, and its own assertion (line 43-44) pins the row count against the
literal `119` with a comment documenting the full breakdown, including the maintenance
contribution:

```
supabase/tests/0207_permission_overrides.test.sql:43:  119,
supabase/tests/0207_permission_overrides.test.sql:44:  'role_default_permissions seeded with 119 rows (... +8 maintenance rows from 0314 — submit admin/manager/staff/viewer + read_all and manage admin/manager each)'
```

---

## Step 2: Honesty + boundary sweeps

### Zendesk grep (GC 9)

```
grep -rni "zendesk" apps/web/src/components/maintenance apps/web/src/server/services/maintenance* \
  apps/web/src/app/api/v1/maintenance-requests apps/mobile/app/maintenance packages/core/src/maintenance
```

39 hits, all classified below. **Every hit is a comment, doc-comment, disclosure
copy rendered to a user, or an honesty-sweep test's own banned-phrase literal
array — none is an executable Zendesk API call, import, or network reference.**

| File:line | Classification |
|---|---|
| `maintenance-request-form.test.tsx:183,186` | Test — banned-vocabulary array asserting `zendesk` never renders |
| `assign-owner-select.test.tsx:31,35` | Test — asserts the disclosure copy string below is rendered |
| `assign-owner-select.tsx:31` | Doc comment explaining "StockPilot owner" ≠ Zendesk assignee |
| `assign-owner-select.tsx:72` | User-facing DISCLOSURE copy: "Internal coordinator inside StockPilot. This is not a Zendesk assignment." |
| `maintenance-status-badge.test.tsx:19` | Test — banned-vocabulary array |
| `maintenance-status-badge.tsx:13` | Doc comment: status vocabulary never implies a Zendesk-observed outcome |
| `maintenance-email-action.test.tsx:245,392` | Test — asserts DUPLICATE_WARNING copy / banned-phrase array |
| `maintenance-settings-panel.test.tsx:48,53` | Test — banned-vocabulary array |
| `maintenance-notes-panel.test.tsx:26,28,30` | Test — banned-vocabulary array + own doc comment |
| `share-link-panel.test.tsx:56,61` | Test — banned-vocabulary array |
| `maintenance-email-action.tsx:30` | Doc comment: "no channel back from Zendesk/Outlook" |
| `maintenance-email-action.tsx:61` | DUPLICATE_WARNING user-facing copy: "...may create duplicate Zendesk tickets." (warns the user, does not call anything) |
| `maintenance-notes-panel.tsx:42,78` | Doc comment + user-facing DISCLOSURE copy: "...never part of a Zendesk ticket thread..." |
| `maintenance-requests.ts:693,837` | Doc comments on `assignLocalOwner`/`recordDraftOpened` explaining what StockPilot cannot observe |
| `api/v1/maintenance-requests/route.test.ts:81` | Test — asserts no outbound fetch occurs |
| `api/v1/maintenance-requests/route.ts:25` | Doc comment: "This route never calls anything Zendesk-shaped" |
| `[id]/draft-opened/route.ts:14` | Doc comment: same boundary statement |
| `packages/core/src/maintenance/email.ts:361` | Outbound EMAIL BODY copy (sent to `dc4@learn4life.org`, the live Zendesk intake): "Please reply to this email thread... same Zendesk ticket." — disclosure text inside the drafted email, not a program call |
| `apps/mobile/app/maintenance/[id].tsx:72` | User-facing DISCLOSURE copy: "Ticket replies happen in the Outlook/Zendesk email conversation and are not shown here." |
| `packages/core/src/maintenance/constants.test.ts:96` | Test — banned-vocabulary array |
| `packages/core/src/maintenance/email.test.ts:244,251,817` | Test — asserts the body copy above / banned-phrase array |
| `packages/core/src/maintenance/constants.ts:9` | Doc comment: "dc4@learn4life.org feeds a live Zendesk email intake" (explains why the address is a compile-time literal) |

**Verdict: no BLOCKED finding.** Zero executable Zendesk surface anywhere in the
swept paths.

### Forbidden-phrase grep (GC 8)

```
grep -rn "Ticket created\|Request submitted to Zendesk\|DC4 notified\|Andrew notified\|Ticket assigned\|Email sent" \
  apps/web/src/components/maintenance apps/mobile/app/maintenance packages/core/src/maintenance
```

As literally written (scanning both prod and test files in those directories), this
returns 34 hits — **every one of them inside a `.test.ts`/`.test.tsx` file**, all of
which are the honesty-sweep tests' own banned-phrase literal arrays (the strings
have to be written down somewhere to assert they are never rendered). Re-run scoped
to production source only, to confirm the actual production-code claim:

```
grep -rn "Ticket created\|Request submitted to Zendesk\|DC4 notified\|Andrew notified\|Ticket assigned\|Email sent" \
  apps/web/src/components/maintenance apps/mobile/app/maintenance packages/core/src/maintenance \
  --include="*.ts" --include="*.tsx" | grep -v "\.test\.ts"
```
Result: **zero hits** (exit 1). Confirmed clean.

### Emoji grep (GC 17)

```
git diff main --unified=0 | grep -P "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]" || echo "no emojis"
```
Output: `no emojis`

### Co-author trailer grep (GC 17)

```
git log main..HEAD --format=%B | grep -i "co-authored-by" || echo "no trailers"
```
Output: `no trailers`

### EXPO_ROUTES pin honesty (landmine 21)

```
test -f "apps/mobile/app/(drawer)/maintenance.tsx" && echo "drawer screen exists"
```
Output: `drawer screen exists`

---

## Step 3: Tautology re-scan (GC 19) — literal-pin table

Every cross-task contract value below was located pinned against a real literal in
at least one test file. No self-referential comparison (`expect(X).toBe(X)`) was
found anywhere in the swept files — confirmed by a targeted regex sweep
(`expect\(([A-Za-z0-9_.]+)\)\.toBe\(\1\)`) across every file in the brief's search
target list, which returned zero matches. **No rewrite was required.**

| Contract value | Literal pin (file:line) |
|---|---|
| `to` address `dc4@learn4life.org` | `packages/core/src/maintenance/constants.test.ts:23` — `expect(L4L_MAINTENANCE_EMAIL.to).toBe('dc4@learn4life.org')` |
| `cc` address `arosas@cvwest.org` | `packages/core/src/maintenance/constants.test.ts:24` — `expect(L4L_MAINTENANCE_EMAIL.cc).toBe('arosas@cvwest.org')` |
| Compose base URL `https://outlook.cloud.microsoft/mail/deeplink/compose` | `packages/core/src/email/outlook-compose.test.ts:45` — `expect(OUTLOOK_COMPOSE_BASE).toBe('https://outlook.cloud.microsoft/mail/deeplink/compose')` |
| `1800` (`DRAFT_URL_LIMIT`) | `packages/core/src/email/outlook-compose.test.ts:47` — `expect(DRAFT_URL_LIMIT).toBe(1800)` |
| Subject prefix `[StockPilot Maintenance <MR-number>]` | `packages/core/src/maintenance/email.test.ts:109` — `expect(draft.subject).toBe('[StockPilot Maintenance MR-2026-000123] Air conditioner is not working in Room 204')` |
| Status labels (`saved`/`draft_opened`/`archived`/`cancelled`) | `packages/core/src/maintenance/constants.test.ts:83-89` — `expect(MAINTENANCE_STATUS_LABELS).toEqual({ saved: 'Saved', draft_opened: 'Email draft opened', archived: 'Archived', cancelled: 'Cancelled' })`; also `apps/web/src/components/maintenance/maintenance-status-badge.test.tsx:9-15` (`getByText('Saved')`, etc.) |
| Route paths `/dashboard/maintenance`, `/dashboard/maintenance/new`, `/dashboard/maintenance/<id>` → mobile `/maintenance*` | `apps/mobile/src/lib/web-path-rewrite.test.ts:57-66` — `expect(rewriteWebPath('/dashboard/maintenance/...')).toBe('/maintenance/...')` (all three variants); also `apps/web/src/lib/onboarding/maintenance-onboarding.test.ts:66-67` — `expect(TOUR_ROUTES['maintenance-requests']).toBe('/dashboard/maintenance')` |
| 4 pref keys `push_maintenance_new_request`/`push_maintenance_urgent_request`/`push_maintenance_assigned`/`push_maintenance_draft_reminder` | `apps/web/src/server/services/maintenance-notify.test.ts:201-202` (`new_request`), `:358-381` (`assigned`), `:404-407` (all four keys asserted together as literal object keys) |
| Permission strings `maintenance_requests:submit`/`:read_all`/`:manage`/`:configure` | `packages/core/src/constants/permissions.test.ts:152-185` — e.g. `expect(ROLE_PERMISSIONS.manager).toContain('maintenance_requests:read_all')`, `expect(FULLY_GRANTABLE_PERMISSIONS.has('maintenance_requests:configure')).toBe(false)` |
| Bucket id `maintenance-photos` | `supabase/tests/0315_maintenance_photos_bucket.test.sql:60-61` — `exists (select 1 from storage.buckets where id = 'maintenance-photos' and public = false)` |
| 180-day expiry (`MAINTENANCE_SHARE_LINK_TTL_DAYS`) | `packages/core/src/maintenance/constants.test.ts:139` — `expect(MAINTENANCE_SHARE_LINK_TTL_DAYS).toBe(180)`; also `apps/web/src/server/services/maintenance-share-links.test.ts:270,305` — `new Date(Date.now() + 180 * DAY_MS).toISOString()` |

No contract value was found unpinned.

---

## Concerns / notes

- None of the seven gates required any code change to pass. The one source edit
  the brief permits (a tautology rewrite) was not needed — the targeted regex sweep
  for `expect(X).toBe(X)` across every file in the brief's Step 3 search list came
  back empty.
- Supabase CLI reports a newer version is available (2.98.2 installed, 2.111.0
  latest). Not acted on — out of scope for a verification task, and the brief
  didn't ask for a CLI upgrade.
- `git status --porcelain` after all seven gates and both sweep steps is still
  clean except for this new report file, confirming nothing else was touched.

---

# Task 25: Manual authed browser walk (the honest E2E)

Branch: `feat/maintenance-requests`, HEAD `a37c064eecf6cf57d12cccef0e14d4b87b51901b`
(clean tree at start). Run date: 2026-08-06, local stack only
(`http://127.0.0.1:54321`, dev server `pnpm --filter web dev` on
`http://localhost:3000`). Driven with Playwright MCP in headless Chromium. No
Playwright CI gate exists and `location.assign` is unstubbable in real
Chromium; this scripted walk plus the Task 14 component tests ARE the Brief
S31 E2E.

**NO-SEND posture, upheld throughout:** `window.open` was monkeypatched in
the page context and PROVEN patched (non-native source, probe URL captured,
zero pages opened) BEFORE every click of `Open in Outlook`. `Open in Default
Email App` (the mailto path) was never clicked. `/m/<token>` URLs were opened
only in browser tabs. No compose window, mail client, or external request to
outlook.cloud.microsoft / learn4life.org / cvwest.org ever occurred (session
network log audited: zero matches for outlook|microsoft|mailto|learn4life|cvwest).
No email was sent or could have been sent.

## Environment prep (all local)

- Local stack was up (Task 24's reset). Seeded via psql + GoTrue admin API:
  four users (`walk.requester@` / `walk.manager@` / `walk.staff2@test.local`
  in org A "Acme Demo Co" as staff/manager/staff; `walk.outsider@test.local`
  in new org B "Walk Org B"), one charter site for org A
  (`Desert Cove High - DC4` — the maintenance form's Site picker reads
  charters via `ChartersService.list()`, not locations), and the module
  enable using the plan's exact SQL shape:
  `update public.organization_modules set enabled = true where organization_id = <org A> and module_id = 'maintenance_requests';`
  Org B left grandfathered OFF (verified `enabled = f`).
- Photo fixtures: `walk-photo.heic` (real HEVC HEIF via `sips -s format heic`)
  and `walk-photo-2.png` (320x240 PNG), in the session scratchpad.

### Environment findings (not maintenance bugs, but they shaped the walk)

1. **Stale local `SUPABASE_SERVICE_ROLE_KEY`** in
   `~/Developer/stockpilot-env/apps/web/.env.local` (symlinked as
   `apps/web/.env.local`): it is an `sb_secret_` key that does NOT match the
   running local stack's secret. Result: every `createAdminClient()` path
   failed while user-authed reads worked — the exact signature of the
   2026-07-21 key-rotation outage, local edition. Symptoms observed before
   diagnosis: photo finalize returned 400 `invalid_image` from its
   download-failed branch (the object WAS uploaded and still existed — the
   sniff-mismatch branch would have deleted it, which is how the branch was
   identified), and `notifications.create_insert` RLS errors from
   `notifyPhotoRejected`. Fix used: restarted the dev server with
   `SUPABASE_SERVICE_ROLE_KEY`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` overridden in
   process env (process env beats `.env.local`; no file was edited). OWNER
   ACTION: refresh the local-stack keys in the stockpilot-env file.
2. **Local-dev CSP blocks the browser->storage leg**: the CSP allows
   `https://*.supabase.co` but the local stack is `http://127.0.0.1:54321`,
   so client-side signed-URL PUTs (and the notifications poll + realtime WS)
   are CSP-blocked in local dev. Prod URLs match the CSP; not a prod issue.
   Workaround for the photo-upload checks: a parallel Playwright context with
   `bypassCSP: true` sharing the same session cookies, driving the real,
   unmodified UI. (First attempt — stripping the CSP header via route
   interception — was abandoned: buffering the streamed document broke React
   hydration; recorded below as the trigger of the draft-opened anomaly.)

## The 20-check walk (Brief S31), plus controller checks 21-25

1. **Sign in** — PASS. `/signin` as `walk.requester@test.local`, landed on
   `/dashboard`.
2. **Create a request** — PASS. `/dashboard/maintenance/new` (form gated by
   module + `maintenance_requests:submit`). Save redirected to
   `/dashboard/maintenance/<id>?review=1`; row `MR-2026-000001` created.
3. **Custom subject typed** — PASS. "Walk E2E: HVAC compressor rattling
   loudly".
4. **Description typed** — PASS. Multi-sentence description (rooftop HVAC,
   mounting bolts, fan bearings).
5. **Site selected** — PASS. "Desert Cove High - DC4" (charter
   `c0000000-...-00c1`). Empty-picker gotcha recorded: with no charters in
   the org the Site select renders only "Select a site" — org needs at least
   one charter.
6. **Two photos uploaded, one HEIC** — PASS (via the bypassCSP context, real
   UI, real product code end to end). HEIC was transcoded CLIENT-SIDE
   (heic2any -> canvas pipeline) and stored as `image/webp`; the PNG stored
   as `image/png` with sniffed dimensions 320x240. DB proof:
   `maintenance_request_attachments` rows `walk-photo.heic | image/webp` and
   `walk-photo-2.png | image/png | 320 | 240`. Mint -> signed PUT (master +
   thumb) -> finalize all 200. Share link auto-minted on first photo
   (token prefix `be79e0`, expires 2027-02-02 = 180 days). Screenshot:
   scratchpad `walk-07-review-screen.png`.
7. **Review screen shows all of it** — PASS. `?review=1` shows request
   details (MR number, subject, priority, requester, site, building, room),
   description, Photos (2) with thumbnails and per-photo signed download
   links ("Download Photos for Outlook"), and the email preview (To/CC/
   subject/body). The body was SHORTENED (URL budget) with an honest on-page
   note; Copy Email Details is documented on-screen as always complete.
8. **Exactly ONE request row exists** — PASS in the database
   (`select count(*) from maintenance_requests` = 1; the duplicate-guard UI
   dialog in check 25 also proves the single-draft posture). **FAIL in the
   list UI** — see BUG 1: `/dashboard/maintenance` crashes whenever the list
   has rows, so the "refresh the list" half of this check could not pass.
9. **window.open patched, then click** — PASS. Patch installed in page
   context and PROVEN first: `String(window.open)` no longer `[native code]`,
   a probe call returned the stub object and logged INTERCEPTED, and
   `context.pages().length` stayed 1. Then `Open in Outlook` clicked: exactly
   one URL captured, nothing opened (still 1 page in context), success toast
   shown ("Outlook opened with your maintenance request...").
   Intercepted URL (share-link token REDACTED to its first 6 chars):

   `https://outlook.cloud.microsoft/mail/deeplink/compose?mailtouri=mailto%3AFresno%2520Warehouse%2520DC4%2520%253Cdc4%2540learn4life.org%253E%3Fcc%3DAndrew%2520Rosas%2520%253Carosas%2540cvwest.org%253E%26subject%3D%255BStockPilot%2520Maintenance%2520MR-2026-000001%255D%2520Walk%2520E2E%253A%2520HVAC%2520compressor%2520rattling%2520loudly%26body%3DMAINTENANCE%2520REQUEST%250A%250AStockPilot%2520Request%253A%2520MR-2026-000001%250A%250AREQUESTER%250A%250AName%253A%2520Walk%2520Requester%250ASite%253A%2520Desert%2520Cove%2520High%2520-%2520DC4%250A%250AISSUE%2520DESCRIPTION%250A%250AThe%2520rooftop%2520HVAC%2520compressor%2520above%2520Building%2520C%2520...%250A%250APHOTOS%250AView%2520request%2520photos%253A%250Ahttp%253A%252F%252Flocalhost%253A3000%252Fm%252Fbe79e0[REDACTED]%250A%250AGenerated%2520from%2520StockPilot.%250AStockPilot%2520Request%253A%2520MR-2026-000001`

10. **To is double-encoded** — PASS. The URL contains, verbatim:
    `dc4%2540learn4life.org` (inside
    `mailto%3AFresno%2520Warehouse%2520DC4%2520%253Cdc4%2540learn4life.org%253E`).
11. **CC in the cc field** — PASS. Verbatim:
    `cc%3DAndrew%2520Rosas%2520%253Carosas%2540cvwest.org%253E`.
12. **Subject param carries typed subject + MR number** — PASS. Verbatim:
    `subject%3D%255BStockPilot%2520Maintenance%2520MR-2026-000001%255D%2520Walk%2520E2E%253A%2520HVAC%2520compressor%2520rattling%2520loudly`.
13. **Body carries the description** — PASS ("The rooftop HVAC compressor
    above Building C has been rattling loudly..." present in the body param;
    body was the shortened variant, which still carries the full
    description).
14. **Body carries the `/m/<token>` share link** — PASS
    (`http://localhost:3000/m/be79e0...`, token matches the DB row's prefix).
15. **No email sent** — PASS. Nothing opened (patched stub returned a fake
    handle; 1 page in context throughout; network log has zero external
    mail-related requests). The draft-opened stamp is the only side effect.
16. **Request shows `Email draft opened`** — PASS. Status badge on review
    and detail; DB `status='draft_opened'`, `outlook_draft_opened_at` set,
    `outlook_draft_open_count=1`; audit row
    `maintenance_request.draft_opened` written; activity feed shows the
    draft event.
17. **Visible in My Requests** — **FAIL (BUG 1)**. The requester's
    `/dashboard/maintenance` crashes to the error boundary because the list
    now has a row. Service-level visibility is fine (the detail page renders
    for the requester); the list UI is broken.
18. **Manager sees it in All Requests** — **FAIL (BUG 1)**.
    `?scope=all` as `walk.manager@` crashes identically. The manager CAN
    open the detail URL directly (MR-2026-000001 renders, with manage-tier
    controls), so read_all/manage RLS is proven; the list UI is broken.
19. **Second staff CANNOT open the detail URL** — PASS. `walk.staff2@`
    hitting the detail URL gets the 404 page (row invisible under RLS; no
    existence leak, no 403 distinction). Staff2's own list renders fine
    (empty — which also brackets BUG 1 to non-empty lists).
20. **Second org gets no row** — PASS. `walk.outsider@` (org B): list shows
    the module-not-enabled fallback (module OFF for org B), and the org-A
    detail URL renders the same fallback — no row data, no existence leak.
    (The brief's "detail 404s" is superseded by the module gate rendering
    first for a module-off org; the isolation property holds. The
    404-for-an-in-module-user case is proven by check 19.)

### Controller-added checks

21. **Tour from /dashboard/help** — PASS for the tour itself, **FAIL on a
    non-empty list (BUG 1)**. The Help page lists "Maintenance requests - 5
    steps" with a Start link -> `/dashboard/maintenance?tour=maintenance-requests`.
    As the requester (1 row) the destination page crashes, so the tour
    cannot render. As `walk.staff2@` (empty list) the tour DOES render its
    step-1 card ("Report a facility or equipment issue...") and Next
    advances to step 2 ("Start a new request...") — first runtime proof the
    tour mounts and steps. Screenshots: scratchpad `walk-21-tour-step1.png`,
    `walk-21-tour-step2.png`.
22. **Module-off invisibility (org B)** — PASS. Sidebar nav contains no
    Maintenance entry (absent, not disabled); no report-a-problem
    affordances anywhere on the dashboard; direct `/dashboard/maintenance`
    shows "Maintenance requests isn't enabled / This module isn't turned on
    for your organization. / Ask an owner or admin to enable it."
23. **Real-data `/m/<token>`** — PASS. The share URL from the REAL
    form-created request (charter set by the form), opened in a FRESH
    unauthenticated context: HTTP 200, renders "MR-2026-000001", the
    subject, "Site: Desert Cove High - DC4" (the first unmocked proof of the
    C1 charter-name chain), the description, Photos (2) with both images,
    and the privacy note ("Internal notes are never shown here").
    Screenshot: scratchpad `walk-23-share-page.png`.
24. **Email input reality** — PASS. The intercepted URL's body carries the
    REAL site name (`Site%253A%2520Desert%2520Cove%2520High%2520-%2520DC4`)
    and the REAL MR number (`MR-2026-000001`) straight from the database
    through the 2-hop PostgREST embeds — no nulls, values match the DB rows
    exactly.
25. **Duplicate + copy fallback + revoke** — PASS (all four parts).
    - *Duplicate-draft dialog*: with persisted open-count 1, a second click
      of `Open in Outlook` (patch re-proven after the intervening reload,
      BEFORE the click) opened the confirm dialog — "Open another draft? / A
      maintenance email draft was already opened for this request. Sending
      multiple copies may create duplicate Zendesk tickets." — and NOTHING
      was opened (zero interceptions while the dialog gated). Cancelled.
    - *Copy fallback*: `Copy Email Details` wrote the COMPLETE email to the
      clipboard (TO/CC/SUBJECT plus the full unshortened body: full
      description, "PHOTOS / 2 photos were uploaded", the `/m/be79e0...`
      link, the Zendesk reply-thread note). Content saved into a scratch
      TEXT file (scratchpad `walk-copy-fallback.txt`) — never a mail client.
    - *Share page in a fresh incognito context*: see check 23.
    - *Revoke*: revoke is manage-only by design (requester panel shows
      Copy-only; `canRevoke={false}` — matches the plan). As the manager:
      Revoke -> confirm dialog ("The link stops granting photo access
      immediately...") -> panel shows no active link -> the SAME
      `/m/be79e0...` URL in a fresh unauthenticated context returns **HTTP
      404**. Note: the detail page auto-minted a REPLACEMENT link ~250ms
      after the revoke (new token, prefix `194576`) exactly as the confirm
      dialog says it may; the revoked token stays dead.

## BUG 1 (real, user-facing, found by this walk): non-empty maintenance list crashes

`/dashboard/maintenance` renders `<Pagination ... hrefForPage={(n) => buildMaintenanceHref(...)} />`
from the SERVER component page (`apps/web/src/app/(dashboard)/dashboard/maintenance/page.tsx:278`)
into the `'use client'` `Pagination` (`apps/web/src/components/ui/pagination.tsx:1`).
Passing a function across the RSC boundary throws
`Functions cannot be passed directly to Client Components... <... page={1} hasNext={false} hrefForPage={function hrefForPage}>`
(digest 3969804129), and the error boundary replaces the page. The pager
block is gated on `visible.length > 0`, so: empty list renders fine, ANY
list with rows crashes — for every persona (requester "My requests" and
manager "All requests" both reproduced, multiple loads). This also blocks
the tour on a non-empty list (check 21). Movements/PO-imports pass
`hrefForPage` the same way but their server-mode pager rows are rarely
rendered (movements defaults to instant/client mode), which is why the
pattern never surfaced before. NOT fixed in this task per the brief —
recorded for a fix task. Checks 8 (list half), 17, 18, and 21 (requester
path) FAIL on this bug alone.

## Anomaly investigated: one stray draft-opened stamp during environment debugging

While debugging the CSP workaround (before the key fix), a route-interception
experiment buffered the streamed document and broke React hydration on the
MCP-driven page; several synthetic events (clicks on "Add photos",
`setInputFiles`, a manual `change` dispatch) were delivered to that dead
page. Immediately after the recovery reload, the dev log shows a single
`recordMaintenanceDraftOpenedAction("5775d845-...")` invocation
(walk-dev-server.log line 76) that stamped the row `draft_opened` at
15:53:35 with NO audit row (the audit write needs the then-broken admin
path) and NO click on any email button having been made. Forensics:
- The action has exactly three entry points (the `/api/v1/.../draft-opened`
  route — absent from the logs — and two click-gated paths in
  `maintenance-email-action.tsx`).
- Four controlled reproductions on healthy pages (2 plain loads of detail +
  review with zero interaction, 2 failed-upload flows) never fired it, and
  page loads never touch the parent row.
- No popup, tab, or external request occurred at any point (single tab
  throughout; network log clean).
The stamp was reset via SQL and the REAL check-9 click later produced the
organic stamp + audit pair. Conclusion: an artifact of delivering synthetic
events to a hydration-broken page during environment debugging, not an
organic product path; nothing about it involved a real window.open or any
send. Residual uncertainty (which exact replayed event triggered it) is
recorded honestly; it does not reproduce under any normal usage.

## Explicitly NOT exercised (and why)

1. **Real popup-blocked behavior beyond the stubbed probe.** The blocked
   branch auto-fires `window.location.assign(mailtoUrl)` once per mount.
   `location.assign` cannot be stubbed in real Chromium
   (`Object.defineProperty` over `location` is refused), so a live
   `window.open = () => null` probe would run an unpatched mailto
   navigation. Per the brief this branch is verified ONLY by the Task 14
   component tests (blocked panel copy, one-mailto-per-mount guard, both
   recording paths).
2. **The real mailto path (`Open in Default Email App`).** Never clicked, on
   the same grounds: it navigates to a `mailto:` URL addressed to the REAL
   dc4/arosas addresses and cannot be intercepted in-page. Covered by Task
   14's component tests of `prepareMaintenanceEmail`'s mailto URL and the
   manual-mailto handler.

## Session artifacts (scratchpad only — not committed)

`walk-07-review-screen.png`, `walk-21-tour-step1.png`,
`walk-21-tour-step2.png`, `walk-23-share-page.png`,
`walk-copy-fallback.txt`, `walk-dev-server.log`, `walk-dev-server-2.log`,
fixtures (`walk-photo.heic`, `walk-photo-2.png`, `corrupt.png`).

## Walk verdict

21 of 25 checks PASS outright. Checks 8 (list half), 17, 18, and the
requester path of 21 FAIL — all four on the single BUG 1 (server->client
function prop crashes any non-empty maintenance list). Every email-safety
property held: one intercepted compose URL with correct double-encoded
recipients, subject, body, and share link; zero real opens; zero sends; the
only side effect was the designed draft-opened stamp. The C1 charter chain,
module gating, RLS isolation, HEIC transcode, share-link mint/expiry/revoke,
duplicate guard, and copy fallback are all proven against real data.

## Task 25 fix wave (2026-08-06): BUG 1 fixed and re-verified end to end

### The fix

Root cause (as recorded above): the server component
`apps/web/src/app/(dashboard)/dashboard/maintenance/page.tsx` passed an
inline function prop (`hrefForPage={(n) => buildMaintenanceHref(...)}`) into
the `'use client'` `Pagination`. RSC cannot serialize functions, so any
non-empty list crashed to the error boundary (digest 3969804129); the pager
block is gated on `visible.length > 0`, which is why every empty-list check,
JSDOM test, typecheck, and `next build` passed while real data crashed.

No existing server-component `Pagination` call site was a safe pattern to
mirror — movements and PO-imports pass the same function prop (latent, see
triage below), and the purchase-orders page hand-rolls plain `<Link>` hrefs
instead of using the shared component. So `Pagination` gained a SERIALIZABLE
link flavor (`components/ui/pagination.tsx`): `basePath` +
`baseParams: Record<string, string>` + `pageParamName` (default `'page'`).
The client component builds each page href itself — `baseParams` verbatim,
page param appended for pages > 1, omitted on page 1 — reproducing
`buildMaintenanceHref`'s exact URL shape. `hrefForPage` is untouched and
still first-class for CLIENT call sites (inventory table, movements instant
table, public-link editor — their tests still pass unmodified); the two
flavors resolve to one internal `linkForPage`, function flavor winning.

The maintenance page now passes `basePath="/dashboard/maintenance"` +
`baseParams={maintenanceListParams({ scope, status, q })}` —
`maintenanceListParams` is a new helper factored out of
`buildMaintenanceHref` so the filter pills and the pager derive the
`scope`/`status`/`q` query contract from the same definition and cannot
drift.

### Regression guard (+ its honest limits)

Two new tests in the page's own suite
(`.../maintenance/page.test.tsx`, "RSC serialization guard" block), in the
repo's wiring-pin idiom: a `readFileSync` source-text pin asserting the page
never spells the function-prop flavor (`hrefForPage=`) and does wire
`basePath`/`baseParams` via `maintenanceListParams`. HONEST LIMITS stated in
the test: a source-text assertion proves what the file says, not what React
does — RSC serialization is only truly proven by an authed browser walk over
a non-empty list (below).

Mutation check: re-introducing
`hrefForPage={(n) => buildMaintenanceHref({ scope, status, q, page: n })}`
(after snapshotting to a uniquely named scratchpad file) failed both guards:
`AssertionError: expected 'import { Wrench } from 'lucide-react…' not to
match /hrefForPage=/` and the basePath pin's mirror failure; suite went
2 failed | 27 passed. Restored from the snapshot; 29/29 green.

### End-to-end re-verify (the four failed checks re-run, real browser)

Local stack up (Task 25's seed intact: `MR-2026-000001`, walk users);
dev server started with the same process-env key overrides the walk used
(stale local `SUPABASE_SERVICE_ROLE_KEY` in stockpilot-env is STILL
unrotated — owner action still open). Walk-account passwords were reset via
the local GoTrue admin API (they were never recorded). Playwright-driven
Chromium, real UI:

- **Check 8 (list half) — PASS.** `/dashboard/maintenance` as
  `walk.requester@test.local` renders the table WITH the row:
  MR-2026-000001 / "Walk E2E: HVAC compressor rattling loudly" /
  Email draft opened / normal / Desert Cove High - DC4 / 2 photos. No error
  boundary. Console errors were solely the known local-dev CSP mismatch
  (notifications poll + realtime WS to 127.0.0.1:54321) — zero React/RSC
  errors, no digest.
- **Check 17 (requester's My Requests) — PASS.** Same page, "My maintenance
  requests" heading, row visible, row link resolves to the detail URL.
- **Check 18 (manager's All Requests) — PASS.** As
  `walk.manager@test.local`, `?scope=all` renders the row with the
  Requester column ("Walk Requester") and the search box. Clicking the
  "Email draft opened" status pill navigated to
  `?scope=all&status=draft_opened` and the row stayed — filters survive on
  a rows-bearing list.
- **Check 21 (tour on a rows-bearing page) — PASS.** As the requester
  (1 row — the exact persona that crashed in the walk):
  `/dashboard/help` lists "Maintenance requests / 5 steps"; Start →
  `/dashboard/maintenance?tour=maintenance-requests` mounted the spotlight
  (`data-tour-open="true"`) with step 1 "Report a facility or equipment
  issue", and Next advanced to step 2 "Start a new request" (Back/Next
  shown).
- **Pager states.** Only one row exists, so no page-2 link could be
  clicked; instead: the pager renders INERT with one page (Prev and Next
  both disabled, "Page 1") for both personas, and a `?page=2` deep link
  renders the "Nothing on this page" empty state with "Back to page 1" —
  no crash, URL contract intact.

No email affordance was touched: Open in Outlook was never clicked (not
needed for these checks; NO-SEND rules honored). Dev server stopped after
the walk; local stack left up.

### Latent-sibling triage (read once, NOT fixed on this branch)

- `dashboard/movements/page.tsx` — CONFIRMED latent: this server component
  passes a function `hrefForPage` into `Pagination` at both render sites
  (~lines 227/378), gated on `!instant`, so the page will crash exactly when
  an org's unfiltered movement count exceeds `MOVEMENTS_INSTANT_CAP` (or the
  count query fails) and the server-mode pager renders.
- `dashboard/purchase-orders/imports/page.tsx` — CONFIRMED latent: same
  function prop (`hrefForPage={pageHref}`, ~line 247) from a server
  component, rendered when `total > PAGE_SIZE || page > 1`, so it crashes
  once an org holds more than 30 imports or anyone deep-links `?page=2`.
  Both now have a ready-made fix (the serializable `basePath`/`baseParams`
  flavor) for a follow-up task.

### Gates (this fix wave)

Spot-run web tests: 19 files / 370 tests passed (page suite 29 incl. the 2
new guards; onboarding 10; all maintenance component/service/action suites;
inventory-table pagination client-mode 7). Typecheck clean x3 (web, mobile,
core). ESLint clean on the three touched files. Byte-hygiene grep -aPn
clean. package.json/pnpm-lock.yaml untouched. `pnpm --filter web build`
exit 0. Working tree clean after commit.
