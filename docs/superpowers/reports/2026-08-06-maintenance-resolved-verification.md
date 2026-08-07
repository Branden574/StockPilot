# Task 11: Full gate, honesty sweeps, authed browser walk — verification log

Branch `feat/maintenance-resolved`, HEAD `a6d80250` (working tree clean at start and end).
All work local: local Supabase stack, local dev server, local commits. No `--linked`, no `db push`, no OTA.

---

## Safety pre-flight (GC 1: no real email may leave a walk)

The controller's instruction was to run the walk with `RESEND_API_KEY` unset. The shell
environment was indeed unset:

```
$ [ -n "$RESEND_API_KEY" ] && echo SET || echo UNSET
UNSET
```

**That alone would NOT have been enough, and this is the single most important finding of the
pre-flight.** `apps/web/.env.local` (symlink to `~/Developer/stockpilot-env/apps/web/.env.local`)
contains a **populated 36-character `RESEND_API_KEY`**, and Next.js loads `.env.local` into the
dev server's own `process.env` at boot. A naive `pnpm dev` would have given the resolution sender
a live key, and step 4 of the walk would have attempted a **real send**.

The neutralisation was verified *before any server started*, by reproducing Next's exact env
resolution in a throwaway Node process (value never printed — only its length):

```
$ RESEND_API_KEY='' NODE_ENV=development node -e "loadEnvConfig(cwd, true); …"
typeof: string | length: 0 | falsy => DRY-RUN branch: true

$ NODE_ENV=development node -e "loadEnvConfig(cwd, true); …"      # control, no override
typeof: string | length: 36 | falsy => DRY-RUN branch: false
```

Mechanism (read out of `@next/env@16.3.0/dist/index.js`): `processEnv` only applies a parsed
dotenv key when `typeof p[key] === "undefined"`, where `p` is a snapshot of `process.env` taken
at first load. An explicitly-exported empty string is *defined*, so the file value is skipped.
`apps/web/src/lib/env.ts:61` parses it as `optionalSecret` (`z.string().optional().default('')`),
and `sendEmail` (`apps/web/src/lib/email/resend.ts:80`) branches on `!env.RESEND_API_KEY` — an
empty string is falsy, so the dry-run branch is taken.

The dev server was therefore launched as `RESEND_API_KEY='' pnpm dev`, and the dry-run branch was
confirmed empirically at the moment of the resolve (see Walk step 5).

Two further layers held throughout:
- Every walk request's requester was a **fabricated local account** (`walk.requester@test.local`,
  `walk.manager@test.local`) — no real address was ever a recipient.
- `window.open` was patched via `context.addInitScript`, i.e. **before any document script ran**,
  in every browser context. Final tally across every page of the walk: **0 calls**. No compose
  window was ever opened, and `dc4@learn4life.org` / `arosas@cvwest.org` were never contacted.

---

## Step 1: Gate suites — REAL command output

### 1. `pnpm --filter @stockpilot/core test`

```
 Test Files  46 passed (46)
      Tests  885 passed (885)
   Start at  21:09:41
   Duration  1.27s (transform 945ms, setup 0ms, collect 2.11s, tests 400ms, environment 5ms, prepare 2.96s)

EXIT_CODE=0
```

### 2. `pnpm --filter web test`

```
 Test Files  478 passed (478)
      Tests  5577 passed (5577)
   Start at  21:09:43
   Duration  36.74s (transform 12.06s, setup 77.36s, collect 116.24s, tests 74.87s, environment 41.63s, prepare 23.42s)

EXIT_CODE=0
```

### 3. `pnpm --filter mobile test`

```
 Test Files  55 passed (55)
      Tests  1175 passed (1175)
   Start at  21:10:20
   Duration  2.15s (transform 1.45s, setup 0ms, collect 7.01s, tests 2.44s, environment 8ms, prepare 3.58s)

EXIT_CODE=0
```

### 4. Typechecks — web, mobile, core

```
> @stockpilot/web@0.1.0 typecheck
> tsc --noEmit
EXIT_CODE=0

> @stockpilot/mobile@0.1.0 typecheck
> tsc --noEmit
EXIT_CODE=0

> @stockpilot/core@0.0.0 typecheck
> tsc --noEmit
EXIT_CODE=0
```

### 5. `pnpm --filter web lint`

```
✖ 34 problems (0 errors, 34 warnings)
  0 errors and 14 warnings potentially fixable with the `--fix` option.

EXIT_CODE=0
```

All 34 are pre-existing `Unused eslint-disable directive` warnings in files this branch does not
touch (e.g. `server/actions/nav-settings.test.ts`, `server/services/price-tracking.ts`). Zero errors.

### 6. `pnpm --filter web build`

`EXIT_CODE=0`. All five new API paths present in the route table, plus the two pre-existing
maintenance routes the program extended:

```
├ ƒ /api/v1/maintenance-requests/[id]/archive          <- new (T8)
├ ƒ /api/v1/maintenance-requests/[id]/assign-owner     <- new (T8)
├ ƒ /api/v1/maintenance-requests/[id]/notes            <- new (T8)
├ ƒ /api/v1/maintenance-requests/[id]/resolve          <- new (T8)
├ ƒ /api/v1/maintenance-requests/members               <- new (T8)
├ ƒ /api/v1/maintenance-requests/[id]/attachments
├ ƒ /api/v1/maintenance-requests/[id]/attachments/finalize
```

### 7. `supabase db reset && supabase test db`

```
RESET_EXIT=0
PGTAP_EXIT=0

…/supabase/tests/0314_maintenance_requests.test.sql ........................... ok
…/supabase/tests/0315_maintenance_photos_bucket.test.sql ...................... ok
…/supabase/tests/0316_maintenance_attachment_path_uniq.test.sql ............... ok
…/supabase/tests/0317_maintenance_resolved.test.sql ........................... ok
All tests successful.
Files=115, Tests=1694,  4 wallclock secs ( 0.13 usr  0.07 sys +  0.46 cusr  0.17 csys =  0.83 CPU)
Result: PASS
```

`grep -c "^not ok"` over the pgTAP output: **0**. 0317 suite green; `0207_permission_overrides`
still `ok` (untouched, 119).

### 8. GC 7 — OTA purity gate

```
$ git diff --stat main...HEAD -- apps/mobile/package.json pnpm-lock.yaml
(no output — empty diff)
```

**Gate verdict: ALL GREEN.** Nothing red, nothing skipped.

---

## Step 2: Honesty sweeps

### Forbidden-phrase sweep — the full 12-item GC-4/§11 list

Swept case-insensitively over `apps/web/src`, `apps/mobile/src`, `apps/mobile/app`,
`packages/core/src` (`*.ts`, `*.tsx`).

| Phrase | Hits | All hits are sweep arrays / comments? |
|---|---|---|
| `Email sent` | 35 | yes |
| `Ticket created` | 32 | yes |
| `Request submitted to Zendesk` | 19 | yes |
| `DC4 notified` | 22 | yes |
| `Andrew notified` | 23 | yes |
| `Ticket assigned` | 24 | yes |
| `Ticket closed` (new) | 19 | yes |
| `Ticket resolved` (new) | 21 | yes |
| `Zendesk ticket closed` (new) | 9 | yes |
| `Zendesk ticket updated` (new) | 8 | yes |
| `Zendesk ticket resolved` (new) | 10 | yes |
| `Issue verified fixed` (new) | 9 | yes |

Every hit is either inside a sweep test's banned array or inside a source **comment** that
documents the rule. The complete list of non-test hits was enumerated and read individually:

- Comments only: `api/v1/maintenance-requests/[id]/draft-opened/route.ts:16`,
  `components/maintenance/maintenance-status-badge.tsx:13`,
  `mobile/src/lib/maintenance-api.ts:164`, `mobile/app/maintenance/new.tsx:74-75`,
  `packages/core/src/maintenance/constants.ts:26,52`, `server/email/return-prompt.ts:36`.
- Two hits are pre-existing, non-maintenance product copy outside this branch's diff and outside
  the maintenance surface: `components/settings/org-name-editor.tsx:44` ("…on every email sent
  from your…", describing where the org name appears) and
  `components/platform/user-actions-menu.tsx:144` (`Reset email sent to …` — a platform-admin
  toast reporting an actual completed send). Neither is a maintenance surface and neither claims
  an unobservable outcome.

**Zero forbidden phrases in any maintenance product copy, status, notification, email or mobile
screen constant.** Independently corroborated at runtime: the rendered resolution email
(subject + text + html) was scanned against all 12 and returned `[]` (see Walk step 5).

### Zendesk sweep — zero executable surface in the new code

`grep -i zendesk` across all 71 branch-diff files: **97 hits**, distributed as

```
  2  apps/mobile/app/(drawer)/maintenance.tsx           1  apps/mobile/app/maintenance/[id].tsx
  3  apps/mobile/src/lib/maintenance-actions.ts         2  apps/mobile/src/lib/maintenance-api.ts
  2  apps/web/…/dashboard/maintenance/[id]/page.tsx     1  …/assign-owner/route.ts
  1  …/maintenance-status-badge.tsx                     1  …/resolve-request-dialog.tsx
  3  apps/web/src/lib/email/es/families/maintenance.ts  2  apps/web/src/server/services/audit.ts
  2  apps/web/src/server/services/maintenance-requests.ts
  1  supabase/migrations/0317_maintenance_resolved.sql
  … remainder in *.test.* sweep arrays and the spec/plan docs
```

Every non-test, non-doc hit was read. All 23 are **comments or disclosure copy** — sentences whose
whole purpose is to tell the user StockPilot does *not* touch the ticket, e.g. the shipped honesty
line and `resolve-request-dialog.tsx:115` ("It does not close or update the Zendesk ticket.").

The repo *does* contain an executable Zendesk connector (`server/connectors/zendesk/client.ts`,
`app/(dashboard)/dashboard/zendesk/`, `app/(drawer)/zendesk.tsx`) — that is the **pre-existing,
separate** Zendesk module. **None of those files is in this branch's diff.** The new code has
zero executable Zendesk surface: no client import, no API URL, no dispatch.

### Emoji + co-author trailers

```
$ git diff main...HEAD | grep -P '^\+.*[emoji ranges]'
(zero hits — no emoji in any added line)
```

**FINDING — co-author trailers present (2 commits).** `git log main..HEAD` contains
`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` in:

- `eee31022` `test(maintenance): cover the resolved-parent delete freeze and align pgTAP idioms`
- `d13b47b2` `test(maintenance): pin no-stamp guards and count filters; note delivery-time budget burn`

The other 16 commits on the branch are clean, and the last 50 commits on `main` carry **zero**
trailers — so this is a two-commit deviation from the established convention, not the norm.

Not remediated here, deliberately: stripping them rewrites those two SHAs and every descendant,
including `a6d80250` itself and the SHA ranges recorded throughout `progress.md`. That is a
history rewrite, not a verification action. **Carried to the ship checklist as a pre-PR step for
the controller to decide.**

### Log-leak sweep — no note text, token, or signed URL in any log call

Swept every branch-touched non-test source file for
`console.(log|info|warn|error|debug)`, `captureException`, `logger.`:

```
(end)   — ZERO log calls in any of the new/changed production source files
```

There is nothing to leak because the new code logs nothing at all. The only log on the resolution
path is the **pre-existing** `sendEmail` dry-run line, which deliberately logs `to`, `subject` and
`attachmentCount` only, with an in-code comment explaining that the body is withheld because it
carries recipient PII. Confirmed live in Walk step 5.

*Honest caveat (dev-only, not a product leak):* the Next.js **dev** server traces server-action
arguments, so `resolveMaintenanceRequestAction(...)` appears in the local terminal with the note
text inline. This is Turbopack dev instrumentation, not application logging —
`apps/web/next.config.ts` sets no `logging` config, so it does not occur under `next start`/prod.

### Negative send-guard

```
$ grep -rn "api.resend.com" apps/web/src
apps/web/src/server/email/maintenance-resolved.test.ts:334:  expect(src).not.toContain('api.resend.com');
apps/web/src/lib/email/resend.ts:113:  const res = await fetch('https://api.resend.com/emails', {
apps/web/src/lib/email/es/families/maintenance.test.ts:393:  expect(src).not.toContain('api.resend.com');
```

Exactly the one shipped hit — the `lib/email/resend.ts` seam. The two others are assertions that
the new sender and the new template do **not** reach the transport directly. Nothing new.
`maintenance-resolved.ts:12` imports `sendEmail` from that single seam, matching the eleven other
sanctioned callers.

### Literal-pin census (GC 9)

| Contract value | Pinned at |
|---|---|
| Five status label strings (exact object) | `packages/core/src/maintenance/constants.test.ts:86-93` |
| Status key **order** `['saved','draft_opened','resolved','archived','cancelled']` | `packages/core/src/maintenance/constants.test.ts:96-102` |
| `MAINTENANCE_ATTACHMENT_KINDS` = `['requester','resolution']` | `packages/core/src/maintenance/constants.test.ts:138` |
| `MAINTENANCE_RESOLUTION_NOTE_MAX` = `2000` | `packages/core/src/maintenance/constants.test.ts:142` |
| `MAINTENANCE_MAX_PHOTOS` = `8` | `packages/core/src/maintenance/constants.test.ts:167` |
| Template proof-embed cap = `4` | `apps/web/src/lib/email/es/families/maintenance.test.ts:188` |
| Honesty line (byte-exact) | `apps/web/src/lib/email/es/families/maintenance.test.ts:71` |
| Staged caption | `…/maintenance/[id]/page.test.tsx:837`, `mobile/src/lib/maintenance-filters.test.ts:123` |
| Resolved caption | `…/maintenance/[id]/page.test.tsx:776` |
| Five-label page pin (closes T2 debt) | `…/maintenance/[id]/page.test.tsx:851-854` |

**Gap (carried, matches the T6-I6 ledger entry):** the *sender-level* cap
`PROOF_PHOTO_EMBED_MAX = 4` at `apps/web/src/server/email/maintenance-resolved.ts:62` has **no
test pin**. The template independently re-caps at 4 and that cap *is* pinned, so the observable
behaviour is covered; the sender constant itself is not.

### Honesty line — byte-exactness in the shipped constant

```
LEN: 179
REPR: 'This resolution was recorded by your team in StockPilot. It does not close or update the
       Zendesk ticket — replies and ticket status stay in the Outlook/Zendesk email conversation.'
has U+2014 em dash: True
```

Declared once at `apps/web/src/lib/email/es/families/maintenance.ts:57-58` and referenced (never
re-typed) at `:203` (html) and `:251` (text). The identical 179-character string appears in the
spec, the plan and the family test. 179 chars and U+2014 both match the T5 ledger claim exactly.

---

## Step 3: Manual authed browser walk

### Environment prep (all local)

- `supabase db reset` had just wiped the stack, so everything was seeded fresh: two GoTrue users
  (`walk.manager@test.local` = **manager** role → holds `maintenance_requests:manage`;
  `walk.requester@test.local` = **staff** role → holds `submit` only), both accepted members of
  the seeded org `Acme Demo Co` (`00000000-…-0001`); one charter site `Desert Cove High - DC4`;
  the module enabled with the plan's exact SQL shape
  (`update public.organization_modules set enabled = true where organization_id = <org A> and module_id = 'maintenance_requests';`);
  and a second org `Walk Org B` (`00000000-…-00b2`) with the module left **off** for step 11.
- Photo fixtures: three 320x240 PNGs generated into the scratchpad.

### Environment findings (pre-existing, not maintenance bugs — both re-confirmed from the prior program's log)

1. **Stale local `SUPABASE_SERVICE_ROLE_KEY`** in the stockpilot-env `.env.local` — does not match
   the running local stack, so every `createAdminClient()` path fails. Worked around exactly as the
   prior walk did: the real local-stack keys were exported into the dev server's process env (which
   beats `.env.local`); **no file was edited**. Still owed to the owner as a housekeeping fix.
2. **Local-dev CSP blocks the browser→storage leg.** `connect-src` allows `https://*.supabase.co`
   but the local stack is `http://127.0.0.1:54321`, so the client-side signed-URL PUT is refused.
   Observed first-hand: the server-side **mint succeeded** (a signed upload URL was issued, proving
   the `kind='resolution'` mint path works) and only the browser PUT was blocked, surfacing as
   "Failed to fetch / Retry" in the dialog. Remedy, same as last time: drive the real, unmodified UI
   from a Playwright context with `bypassCSP: true`. Prod URLs match the CSP; not a prod issue.

### The 11-step walk

| # | Step | Verdict | What was actually seen |
|---|---|---|---|
| 1 | Create a request as the requester (real form) | **PASS** | `MR-2026-000001` created via the real form; DB row `status='saved'`, `requester_user_id` = the requester, all five resolution columns NULL. |
| 2 | Manager: Resolve → multi-line note + TWO proof photos → **CANCEL** | **PASS** | Both photos uploaded (2 rows, `kind='resolution'`, uploaded_by = manager). After Cancel + reload: badge still **Saved**, DB still `status='saved'` with every resolution column NULL, and the card reads **"Resolution proof (2)" / "Staged by the team while preparing to mark this request resolved."** The false "Added by the team when this request was marked resolved." is **absent**. The dialog also pre-discloses the behaviour: *"Proof photos upload immediately and stay attached to this request even if you close this dialog without confirming."* **This is the T7 honesty fix, proven in a real browser for the first time.** |
| 3 | Plain requester views the same still-open request | **PASS** | Requester sees "Resolution proof (2)" + the **staged** caption. No resolved caption, no "marked resolved by" text, no Resolution card, status still Saved, and no Resolve button (staff lacks `manage`). **No false claim is presented to the requester** — the exact failure mode the T7/T9 honesty bugs would have produced. |
| 4 | Manager: reopen Resolve, confirm with note + proof | **PASS** | "Mark resolved" disabled on an empty note, enabled once typed. After confirm: badge **Resolved**; Resolution card renders "Marked resolved by Walk Manager"; the note is **verbatim** — the rendered DOM node is byte-identical to the input including **both blank lines**, with computed `white-space: pre-wrap`; proof caption flips to **"Added by the team when this request was marked resolved."**; Resolve gone, Archive still offered. |
| 5 | The email, with the key neutralised | **PASS** | The sender took the dry-run branch — proof, from the dev-server log: `[email] (dry-run, no RESEND_API_KEY) → { to: 'walk.requester@test.local', subject: 'Maintenance request MR-2026-000001 marked resolved', attachmentCount: 0 }`. **No send occurred.** The body is deliberately not logged (PII), so it was captured separately by invoking the **shipped renderer** read-only with this walk's real data (no transport in that process). Full text body recorded below. Honesty line present **byte-exact in both html and text**; note **verbatim incl. blank lines**; resolver name present; **zero of the 12 forbidden phrases**. DB: `resolution_email_sent_at` stamped **exactly once**. |
| 6 | Requester's in-app notification + tap-through | **PASS** | Exactly one row for the requester: title "Maintenance request MR-2026-000001 marked resolved", link `/dashboard/maintenance/53f793e9-…`. Clicked in the real UI → lands on the detail page showing the Resolved badge. |
| 7 | Archive the resolved request (D1) | **PASS** | Archive offered on a resolved request and succeeds; badge → **Archived**; Resolution card and the resolved proof caption still render; note still verbatim. SQL after archive: `resolved_at`, `resolved_by`, `resolved_by_name_snapshot`, `resolution_note` (231 chars) and `resolution_email_sent_at` **byte-identical to before** — stamps intact. |
| 8 | Public share page `/m/<token>` → revoke → 404 | **PASS** | Run against request B (1 requester photo + 2 proof) so indices are meaningful. HTTP 200; Resolution block with the note verbatim; "Marked resolved · August 6, 2026"; **resolver name absent** (per spec); sections labelled "Photos (1)" and "Resolution proof (2)". Photo proxy URLs `/photo/0`, `/photo/1`, `/photo/2` = combined positions with requester first and the two proofs at 1 and 2; **all three loaded** (naturalWidth 320). After clicking the real **Revoke** button: page **404**, photo proxy **404**, and an unknown token also 404 (indistinguishable). |
| 9 | Self-resolve suppression | **PASS** | Request C created **by** the manager and resolved by the manager: `resolution_email_sent_at` **NULL** and **no notification row**. Both channels suppressed. Control: the two other-requester resolves both produced a notification and a stamp. |
| 10 | List: Resolved chip + five status labels | **PASS** | All five labels render on the list: Saved, Email draft opened, Resolved, Archived, Cancelled (the T7 five-label pin, live). `?scope=all&status=resolved` returns the row with a Resolved badge; `status=active` and `status=archived` correctly exclude it. (Under the default "My requests" scope the manager sees no row — correct, they are not the requester.) |
| 11 | Module OFF for a second org | **PASS** | Switched to `Walk Org B`: the Maintenance nav entry is **gone**, and `/dashboard/maintenance` renders the fallback "Maintenance requests isn't enabled — This module isn't turned on for your organization." Unchanged from the 0314 behaviour. |

**Walk score: 11 / 11 PASS. Zero bugs found. Zero source changes were needed.**

`window.open` call count across every context of the entire walk: **0**.

### Step 5 evidence — the rendered resolution email (real shipped renderer, no transport)

```
=== SUBJECT ===
Maintenance request MR-2026-000001 marked resolved
=== TEXT BODY ===
Hi Walk —

Marked resolved by Walk Manager.

Resolution note:
The issue for the leaking roof tile has been resolved.

What we did:
- Replaced the cracked ceiling tile above the gym entrance
- Resealed the flashing on the roof directly above it

Please report it again if you see any new water.

This resolution was recorded by your team in StockPilot. It does not close or update the Zendesk
ticket — replies and ticket status stay in the Outlook/Zendesk email conversation.

2 proof photos are on the request in StockPilot.

Request: MR-2026-000001 — Leaking roof tile above the DC4 gym entrance
Resolved: Aug 6, 2026 · 9:27 PM PT
Recorded by: Walk Manager

View request: http://localhost:3000/dashboard/maintenance/53f793e9-…

This resolution was recorded by your team in StockPilot. Sent once when a request you submitted
is marked resolved.
=== ASSERTIONS ===
honesty line in TEXT : true
honesty line in HTML : true
note verbatim in TEXT: true
note <br>-joined in HTML: true
resolver name in body: true
forbidden phrases present: []
```

### Controller-added adversarial checks (beyond the 11 steps)

| Check | Result |
|---|---|
| Re-resolve an already-resolved request via `POST /api/v1/…/resolve` | **409** `{"error":"conflict","message":"This request is already resolved."}` — and `resolution_email_sent_at` / `resolved_at` / note length all **unchanged** afterwards (at-most-once holds against a real second call). |
| Requester (no `manage`) resolves someone else's request | **403** `Missing permission: maintenance_requests:manage` |
| Requester lists internal notes | **403** `Missing permission: maintenance_requests:manage` |
| Requester archives | **403** `Missing permission: maintenance_requests:manage` |
| **Requester plants proof**: mints `kind='resolution'` on their **own open** request | **403** `Only a manage-holder may attach resolution proof photos.` |
| Control for the above: same requester mints `kind='requester'` | **200** with a signed upload URL — so the 403 is the kind gate biting, not a blanket refusal. **The requester-planted-proof attack the spec was designed around is closed, proven live.** |
| Unknown / revoked / malformed share tokens | all **404**, indistinguishable |

### Mobile — attempted once, blocked (as expected)

Per the brief, the simulator was attempted exactly once and not debugged. `xcrun simctl` booted
`iPhone 17 Pro` fine, but `npx expo start --ios` failed in the **Expo Go download** step before
any app code ran:

```
› Opening exp://10.0.0.90:8081 on iPhone 17 Pro
- Fetching Expo Go
TypeError: fetch failed
    at fetchWithCredentials (@expo/cli/src/api/rest/client.ts:98:24)
    at downloadExpoGoAsync (@expo/cli/src/utils/downloadExpoGoAsync.ts:106:5)
```

Same verdict class as the prior program's T20: a pre-existing environment/infra blocker that
halts before app code, so **no mobile maintenance screen was exercised**. Moved on.

**Explicitly owed: the T9 and T10 mobile screens remain hand-test-owed.** Their coverage today is
1175 passing unit tests plus review, with no device or simulator pass. This is the largest
remaining gap in the program.

### Explicitly NOT exercised, by rule

- Any real email send; the "Open in Outlook", mailto, and default-mail-app paths (`window.open`
  was patched shut and never invoked).
- `dc4@learn4life.org` / `arosas@cvwest.org` — never contacted in any form.
- Any remote database: no `--linked`, no `db push`, no OTA.

### Session artifacts (scratchpad only — nothing committed)

Driver scripts, 12 full-page screenshots, and captured page text for every step live in the
session scratchpad under `walk/`. No binaries were added to the repo; the temporary Playwright
fixture directory and the two dev-server-generated `apps/web/AGENTS.md` / `CLAUDE.md` files were
deleted, and `git status` is clean at `a6d80250`.

---

## Step 4: Ledgered-minor dispositions

Every minor recorded against Tasks 1-10 in `.superpowers/sdd/progress.md`, with its disposition.

| # | Ledgered minor (task) | Disposition |
|---|---|---|
| 1 | **0317 CHECK widen is drop+add without `NOT VALID`** → ACCESS EXCLUSIVE + full-table validate (T1) | **Accepted.** Table is days old with one org; the lock is momentary. Re-flagged in the ship checklist so a future widen at scale revisits it. |
| 2 | No pin on `resolveMaintenanceShareToken`'s select-column string (T3) | **Accepted, owed post-merge.** A future column widening stays invisible to tests. Cheap to add; not a correctness risk today. |
| 3 | `resolvedAtDisplay` uses server-local TZ (T3) | **Accepted.** Duplicates the existing `formatSubmittedDate` convention; day-boundary display drift only. Walk showed "August 6, 2026" correctly. Changing it should be a deliberate app-wide TZ decision, not a one-surface patch. |
| 4 | Mint forwards `parsed.data` wholesale vs finalize reconstructing (T3) | **Accepted.** Functionally equivalent, both tested. |
| 5 | **`cancel()` TOCTOU** — fresh pre-read, no write-time guard (T4) | **Accepted as PRE-EXISTING, owed post-merge.** Unchanged by this program. `resolve()` racing `cancel()`'s read/write gap could leave a row cancelled with resolution stamps. Not reachable in normal single-operator use; the alignment pass (give `cancel()` the same guarded `.is()` write `resolve()` uses) is a clean small follow-up. **Recommended for the fast-follow PR.** |
| 6 | I4 — no-link count validity-semantics divergence (T6) | **Accepted.** Practically inert under 0314's constraints. |
| 7 | I5 — `recipientEmail` inert plumbing in the render input (T6) | **Accepted, not pruned.** Final review's option to prune was declined: it is plan-mandated forward-compat, harmless, and pruning it now would touch shipped, reviewed, green code for zero behavioural gain. |
| 8 | I6 — sender-level embed cap unverified (T6) | **Confirmed still open** by this task's literal-pin census: `PROOF_PHOTO_EMBED_MAX = 4` (`maintenance-resolved.ts:62`) has no test pin. The template's cap of 4 *is* pinned (`families/maintenance.test.ts:188`) and both constants are equal, so behaviour is covered. **Owed post-merge**, one assertion. |
| 9 | `fetchAcceptedMembers` selects `email` then discards it (T8) | **Accepted.** Pre-existing, lifted verbatim, org-scoped, never logged or serialized — corroborated by this task's log sweep finding zero log calls in the new code. |
| 10 | Some ServiceError mapping tests assert status only, not body (T8) | **Accepted.** Matches the shipped sibling convention. Partially discharged by this walk, which asserted real response **bodies** for 409 and three 403s. |
| 11 | Mutation survivor (6) — loosening `MobileMaintenancePhoto.kind` to `string` passes vitest (T9) | **Accepted, structural.** Caught only incidentally by tsc. Unfixable at this harness level. |
| 12 | Mutation survivor (7) — dropping `status` from the list `useCallback` deps passes tests+typecheck (T9) | **Accepted, structural.** Caught only by the eslint `react-hooks/exhaustive-deps` **warning**; web lint runs 0 errors / 34 warnings, so it would not gate CI. |
| 13 | Screen-wiring gap (1) — `[id].tsx:298` `refreshKey` dep has zero coverage (T10) | **Accepted, structural — and now the mobile hand-test debt is the mitigation.** Not even a lint warning. |
| 14 | Screen-wiring gap (2) — `toggleNotesOpen`'s `ensureMembersLoaded()` uncovered (T10) | **Accepted, structural.** Silent degradation to the fallback author label. |
| 15 | Screen-wiring gap (3) — `addResolvePhotos` cap arithmetic can double-count mid-staging (T10) | **Accepted.** Worst case is a spurious "Too many photos"; no data loss. |
| 16 | Share-page rate budget: per-kind caps make worst case 17 req/view → ~7 full views/hr/link (T3/T6) | **Accepted and carried.** Compounded by the T6 discovery that Gmail/Outlook image proxies fetch embedded images at **delivery** time, burning up to 4 of the 120/hr bucket per email. Fine for DC4 + Andrew; **any future batch-resend must re-check this first.** |
| 17 | **NEW this task — `Co-Authored-By` trailers on 2 commits** | **Owed pre-PR (controller decision).** See the sweep above and ship-checklist step 0. |
| 18 | **NEW this task — populated `RESEND_API_KEY` in the local `.env.local`** | **Owed to the owner.** Not a code defect, but a live send key sitting in the local dev env is a standing footgun for exactly this kind of walk. Recommend blanking it locally. Also re-flags the still-stale local `SUPABASE_SERVICE_ROLE_KEY`. |

No ledgered minor was found to be mis-triaged, and none was upgraded to a blocker.

---

## Concerns / notes

1. **The two `Co-Authored-By` commits are the only convention breach found**, and the only item
   this task deliberately left unremediated. It needs a controller decision before the PR.
2. **Mobile is the real remaining risk.** T9/T10 shipped 1175 green unit tests and clean reviews,
   but no screen has ever been driven on a device or simulator, and three of the ledgered minors
   (13-15) are precisely the class of wiring bug that only a hand-test catches.
3. **Revoke mints a replacement.** Observed during step 8: revoking the share link and then simply
   loading the detail page immediately minted a *new* active link (a third row). This is the
   documented, reviewed T7 behaviour — `page.tsx` ensures an active link whenever the org setting is
   on and the request has photos — and the **revoked token stays permanently dead (404)**, which is
   what revocation must guarantee. Recording it because "Revoke" could read to an operator as
   "no share link exists any more", which is not what it means.
4. The email body is intentionally absent from the dry-run log. Anyone debugging a future send
   should use the renderer directly (as this task did) rather than adding a body log line.
