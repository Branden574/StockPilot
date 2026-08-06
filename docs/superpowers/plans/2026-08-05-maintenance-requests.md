# L4L Maintenance Requests — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the L4L-only Maintenance Requests module end-to-end — form, saved request with a stable `MR-2026-000123` number, photo uploads with server-side verification, a review screen that opens a fully prefilled Outlook Web draft to `dc4@learn4life.org` CC `arosas@cvwest.org` (with mailto and clipboard fallbacks and duplicate-draft protection), revocable share links for photos, list/detail on web AND mobile, permissions + RLS, notifications, and honest status language throughout — with zero Zendesk API surface.

**Architecture:** The owner-tested Outlook transport is extracted from `apps/web/src/components/orders/storefront/storefront-logic.ts` into `packages/core/src/email/outlook-compose.ts` (the only workspace package mobile can import), with the delivery-request exports kept as byte-identical delegating wrappers so all four existing pinning test suites stay green unchanged. Everything maintenance-shaped is net-new but built on named house patterns: migration 0314 clones the 0297 module recipe + the 0254 advisory-lock numbering trigger + the 0261 share-token shape; the server layer is `ServiceContext` services behind `assertModuleEnabled` + `has_permission()` RLS; web routes follow the cycle-counts/returns page conventions and mobile follows the support-feature Bearer route-pair, shipping pure-JS OTA onto the live 1.1.0 binary. StockPilot records only what it can observe — a request was Saved, a draft was Opened — and Outlook/Zendesk own everything after that.

**Tech Stack:** TypeScript, Next.js 16 App Router, React 19, zod, Supabase (Postgres RLS + Storage + pgTAP), vitest + happy-dom + @testing-library/react, sonner, Radix Dialog, `@stockpilot/core`, Expo (expo-camera, expo-image-picker, expo-image-manipulator, expo-file-system, expo-linking — all already in the 1.1.0 binary), Resend is NOT used (no email is ever sent by StockPilot in this feature).

---

## Global Constraints

Binding on every task. "Brief §n" = `.superpowers/sdd/maintenance-requests-brief.md`; "Audit §n / landmine n / Qn" = `docs/superpowers/specs/2026-08-05-maintenance-requests-audit.md`.

1. **Outlook transport = the tenant-verified mechanics, verbatim.** `OUTLOOK_COMPOSE_BASE = 'https://outlook.cloud.microsoft/mail/deeplink/compose'` (never `outlook.office.com` — the domain-migration redirect eats the compose path); a SINGLE `mailtouri=` param wrapping an inner `mailto:` URI (plain `to=/cc=/subject=/body=` params are asserted ABSENT — OWA silently drops plain `cc=`); `encodeDraftQuery` = `k + '=' + encodeURIComponent(v)` joined with `&` — `%20` for spaces, NEVER URLSearchParams (`+` renders literally in RFC 6068 clients); `DRAFT_URL_LIMIT = 1800`; `window.open(url, '_blank')` with NO features string (`'noopener'` returns null even on success — the exact blocked-popup signal) and the component severs `opened.opener = null` manually in try/catch. Brief §16's conceptual snippet (office.com + URLSearchParams + noopener features) is ADJUDICATED OUT — recorded in the brief file itself at lines 258-262.
2. **NO-SEND PROHIBITION.** `dc4@learn4life.org` and `arosas@cvwest.org` are REAL addresses reaching a real Zendesk intake and a real person. Every test STRING-ASSERTS URLs and bodies; no test, no manual step, and no verification walk may EVER open a real compose window against them, navigate a `mailto:`, or exercise the popup-blocked path in a real browser (`window.location.assign` is unstubbable in Chromium — component tests only, via `Object.defineProperty`). The Task 25 manual walk stops at the review screen and inspects URLs via DevTools copy, never by clicking Open.
3. **Shared utility lives in `packages/core`** (`packages/core/src/email/outlook-compose.ts` — plain TS, no `'use server'`/`'server-only'`), because `apps/mobile/package.json:29` shows mobile's ONLY workspace dependency is `@stockpilot/core`. Delivery-request keeps delegating wrappers in `storefront-logic.ts` with the SAME exported names and signatures so `storefront-logic.test.ts`, `delivery-request-action.test.tsx`, `site.test.ts`, and `storefront-overlays.test.tsx` stay green BYTE-IDENTICAL (zero edits to those four files; Task 5 runs them as its gate).
4. **Module gating = `organization_modules` + `MODULE_REGISTRY`**, id `maintenance_requests`, tier `'optional'`, `defaultOnFor: []` (the zendesk shape, registry.ts:651-665). The L4L org id is resolved from PROD DATA at ship time: the Task 26 ship checklist runs `select id, name from organizations where name ilike '%learn%'` against prod, confirms `63c13e64-92a6-4ea4-9936-6a2c26a85b4a` (already double-sourced at `org-sweep.ts:18` and `0031_reset_l4l_fresno_test_data.sql:3`), and then runs a one-off enable UPDATE. NEVER name-matching, NEVER hardcoded in a migration — migration 0314 only grandfathers `enabled=false` rows.
5. **4 new permissions bump the 0207-mirror pgTAP count 111 → 119.** Verified: `supabase/tests/0207_permission_overrides.test.sql:41-45` pins `role_default_permissions` at exactly 111 rows today. 0314 seeds 8 rows (`submit` × admin/manager/staff/viewer + `read_all` × admin/manager + `manage` × admin/manager; `configure` seeds ZERO rows — owner-only via the has_permission owner short-circuit) and Task 1 edits the literal AND appends to the itemized provenance message in the same format.
6. **Every maintenance table carries `organization_id` + RLS** per the audit recipe: `enable row level security` PLUS explicit `grant select, insert, update, delete ... to authenticated` (or everything 42501s); write policies ADDITIVE (`has_org_role(organization_id, 'manager') or has_permission(organization_id, '...')`); requester-scoped SELECT inverts to `requester_user_id = auth.uid() or has_permission(...)`; child tables gate through an EXISTS join to the parent. `(select public.module_enabled(organization_id, 'maintenance_requests'))` appears on INSERT/UPDATE (write) policies ONLY — never on SELECT — so disabling the module stops new writes without hiding history (audit Q3).
7. **MIGRATIONS BEFORE WEB DEPLOY at ship.** Guards fail closed; code deployed before 0314/0315 are pushed = total feature outage (the account-disable program proved this). Ship order in Task 26: `supabase db push --linked` FIRST, then merge/deploy, then OTA.
8. **Accurate status language ONLY.** Local states: `Saved`, `Email draft opened`, `Archived`, `Cancelled`. NEVER: `Ticket created`, `Request submitted to Zendesk`, `DC4 notified`, `Andrew notified`, `Ticket assigned`, `Email sent`. Forbidden-phrase sweep tests (the delivery pattern, `delivery-request-action.test.tsx:742-756`) are cloned at every layer that renders copy (Tasks 7, 14, 15, 18, 20, 21).
9. **NO Zendesk API, OAuth, tokens, webhooks, or sync anywhere.** No `zendesk` import, no ticket-id column, no status polling. The Task 24 gate greps the diff for `zendesk` (case-insensitive) and requires zero hits outside comments/docs explaining the boundary.
10. **Every notification link passes `apps/mobile/src/lib/web-path-rewrite.ts`** for all THREE doors (`+native-intent.ts:19`, `use-push-notifications.ts:103`, `(drawer)/notifications.tsx:145`). The `/dashboard/*` catch-all silently rewrites unknown paths to home, so the `/dashboard/maintenance*` REWRITES rules + tests (Task 18) are SHIP-BLOCKERS for Phase F.
11. **Attachments: server-minted signed-upload URL + finalize step** with MAGIC-BYTE sniffing (PNG/JPEG/WEBP signature walk — the only in-repo parser is `readImageDimensions` at `inventory-export-xlsx.ts:58-95`, lifted into a new `image-signature.ts`) + `checkRateLimit` on BOTH mint and request creation (audit Q8 — closes the no-magic-byte and no-rate-limit holes; the direct browser→storage order-attachments flow is NOT copied). HEIC transcodes client-side to JPEG before upload on both platforms (heic2any via `compressImageVariants` on web; `resizeForUpload` forced-JPEG on mobile); the bucket is pinned to `png/jpeg/webp` like 0260:29-35. Mobile uploads use `fetch(uri).arrayBuffer()` or `FileSystem.createUploadTask` — NEVER `blob()` (0-byte uploads).
12. **Share links = new `maintenance_request_share_links` on the 0261 token pattern**: 256-bit hex token via `crypto.getRandomValues`, unique + length CHECK 16-128, `active` flag, `expires_at` = 180 days, revocable from the detail UI, closed-mode per-IP/per-token rate limits, generic 404s, audited. Raw signed storage URLs are DISQUALIFIED from email bodies (30-day max TTL, irrevocable — audit Q7, landmine 23). The share page resolves photos server-side at view time; storage paths never appear in any URL or log.
13. **Mobile phase is PURE-JS ONLY** — OTA-deliverable on the live 1.1.0 binary via `pnpm release:ota` (never raw `eas update`). NO new native modules: no expo-sharing, no expo-media-library, no clipboard module. Clipboard fallback = selectable `TextInput` (multiline, selectTextOnFocus) per audit Q9. Drawer screens registered as `Drawer.Screen`; stack screens in `app/_layout.tsx`. Simulator hand-test after any mobile change (owner rule).
14. **`related_order_request_id` → `public.order_requests(id) on delete set null`** — there is NO `orders` table; every existing FK is `order_request_id` (audit Q5). All related-record FKs use `on delete set null`. NO asset-tag column, form field, or email line — asset tags do not exist as data (`inventory_items` has no such column; the CSV importer validates-then-drops it — audit Q6). `model_number` DOES exist and IS included.
15. **MR numbering = clone the 0254 advisory-lock trigger**: BEFORE INSERT, `pg_advisory_xact_lock(hashtext('maintenance_request_number:' || org_id))`, `coalesce(max)+1`, unique `(organization_id, request_number)`, single per-org counter; the year in `MR-2026-000123` is COSMETIC, derived from `created_at` at format time (audit Q4). Never clone `next_po_number` (no lock, collides).
16. **Description sanitizer = NEW newline-preserving control-strip** `sanitizeDescriptionBlock` (strips C0 except `\n`, strips DEL, normalizes CRLF, caps consecutive newlines at 2) — `toPlainTextLine` COLLAPSES newlines and is correct for SUBJECTS only (audit Q14; the subject path uses the collapsing `sanitizeSubjectLine`). Condense policy per audit Q13: the condensed draft preserves recipients (constants, always), subject, request number, requester name + site, a truncated description with the byte-intact contiguous disclosure sentence, and the ONE share link; it drops location detail, related-record detail, and access instructions first. `clipboardText` is ALWAYS built from the FULL draft. `linkFits === false` opens NOTHING — not even mailto.
17. **No emojis anywhere** (code, copy, commits, docs). **No Claude/Anthropic co-author trailer** on any commit — history is `Branden574` only. Plain professional prose in all user-facing copy.
18. **Web test-harness idioms are mandatory:** `DialogContent` bakes `max-w-lg` — wide dialogs override per call site via className, never by editing `ui/dialog.tsx`; happy-dom lacks ARIAMixin — assert aria via `toHaveAttribute('aria-live', 'polite')` attribute form; `supabase-mock.ts` replays canned `'<table>.<op>'` data and IGNORES filters — pin query shapes via `chains`/`chainArgs` call-recording assertions AND pgTAP; `Object.defineProperty` (not `vi.stubGlobal`) for `window.location`/`navigator.clipboard`, restoring captured descriptors in `beforeEach`; definite-assignment (`let release!: () => void`) under strict tsconfig; decode inner `mailtouri` by slicing at the first `?` (opaque-path scheme), never `new URL().searchParams`; `makeServiceContext` defaults to the FULL `DEFAULT_MODULE_IDS` — gate tests use a ctx WITHOUT `maintenance_requests`.
19. **TEST-TAUTOLOGY RULE.** Every cross-task contract value (recipient addresses, compose base, URL limit, subject prefix, status labels, route paths, pref keys, permission strings, bucket id, share expiry) gets a LITERAL-pin test — assert against the literal string `'dc4@learn4life.org'`, never against the same live constant the implementation reads (8 tautologies shipped in the export-builder program before this rule). Where a test imports a constant, it must ALSO pin the literal at least once per suite.
20. **LOCAL COMMITS ONLY during execution** on branch `feat/maintenance-requests`. Never push, never merge, never `supabase db push`, never OTA — the controller ships at the end via the Task 26 checklist (db push → merge → OTA → L4L enable SQL → prod verify → Andrew grant via UI).
21. **Pattern #24:** never `alter policy ... with check` when touching both clauses — drop + recreate the policy verbatim. **Pattern #23:** `requireOrgContext` throws NEXT_REDIRECT in /api routes — API routes use `withApiContext`; best-effort actions use plain `createClient` reads; `audit()` from Bearer routes MUST pass `ctx`. PostgREST `not.in` drops NULL rows — lifecycle filters stay JS-side; SQL uses `is distinct from`.
22. **`seed_org_modules()` is rewritten WHOLESALE**: 0314 copies the 0297:26-87 body byte-for-byte and appends ONLY the `('maintenance_requests','optional', false)` row. An omission silently stops seeding for every future org.
23. **Notifications:** `createNotification()` is the ONE code insert path; the 0028 AFTER-INSERT trigger is the ONE push path (never also push from code). Pref keys live in the regular module `lib/notification-prefs.ts` (never a `'use server'` file); gates are fail-OPEN (only explicit `false` mutes). Maintenance audiences resolve from EFFECTIVE PERMISSION GRANTS (`effectivePermissions(role, roleOverrides, userOverrides)`) — never widen `_notify_recipients()`. Reminder cron stamps its dedupe column FIRST via `.is(guard, null)` guarded update.
24. **Storage policies carry the 0312 inline disabled-account guard** (`account_is_disabled()` EXECUTE is revoked from authenticated; only the inline `not exists (select 1 from public.user_profiles up where up.id = auth.uid() and up.disabled_at is not null)` form works in a storage policy).
25. **Nav gating uses `requiresAnyOf`** (not `requires`) so read_all/manage-only users still see the entry; the `workspace` section is already in SECTION_ORDER. Hand-maintained registries touched explicitly: settings hub tiles (`settings/page.tsx:13-129`), `ALL_TOURS`, `TOUR_ROUTES`, announcements-at-TOP, `EXPO_ROUTES` in `registry.test.ts`, `vercel.json` crons.
26. **E2E posture (audit Q10):** Playwright is NOT a CI gate and `location.assign` is unstubbable in real Chromium. Brief §31's 20-step web E2E is satisfied per the delivery precedent — exhaustive component tests (window.open interception, decodeCompose assertions, every fallback branch) + the Task 25 scripted manual authed browser walk, recorded in the §33 report. "E2E passes" means exactly that and the report says so.
27. **Never log** Outlook compose URLs, share tokens, signed storage URLs, or full request descriptions. Audit metadata is an explicit allow-list (the `delivery-request.ts:47-78` recorder is the template; recipient addresses are recorded as `recipient_type: 'dc4-maintenance-request'`, never copied).
28. **Site pickers stay sites-only / charter-based.** The site selector reuses the charter list (delivery-request precedent). Never backfill `locations.kind`; never write a rack id into `primary_location_id` (L4L DC4 is 413 items' primary).

### Controller adjudications beyond audit Q1-Q14 (binding, and reported in §33)

| # | Question the brief left open or contradicted | Resolution | Where |
|---|---|---|---|
| C1 | Brief §27's sketch has no `status` column but §20 defines four local states | Explicit `status text check in ('saved','draft_opened','archived','cancelled')` column, kept in lockstep with the timestamp columns by the service; display labels map from it | Task 1, 8, 12 |
| C2 | Brief §5 `configure` is "owner-only normally" but TS `admin` derives ALL_PERMISSIONS | `admin` filter becomes `p !== 'billing:manage' && p !== 'maintenance_requests:configure'`; zero SQL seed rows for configure; owner gets it via the has_permission owner short-circuit; NOT in FULLY_GRANTABLE | Task 3 |
| C3 | Brief §7 subject max "~120" | zod pins 120; the DB CHECK allows 200 as a safety margin (server clamps first) | Tasks 1, 6 |
| C4 | Brief §26 "photo upload failed" requester notification | Only server-observable failures notify: a REJECTED finalize (bad magic bytes / oversize) creates an in-app notification; a client-side network drop cannot be observed server-side and is handled by the UI retry affordance instead. Documented in §33 Limitations | Tasks 9, 21 |
| C5 | Brief §10 "Download Photos for Outlook" mechanism | Per-photo signed-URL `<a download>` anchors + a "Download all" that triggers them sequentially. No zip dependency added | Task 15 |
| C6 | Brief §8 "asset / assigned asset view" | Mapped to rentals (audit Q11): web rental detail gets the launch button; mobile skips it (no native rental screen); the email's rental block uses borrower + item names, never a fake "R-…" handle | Tasks 7, 17 |
| C7 | Brief §22 search "by asset tag" | Dropped with the asset-tag field (audit Q6); search covers request number (parsed handle), subject, description, requester, site, SKU, order number | Tasks 8, 12 |
| C8 | Brief §9 "reordering when useful" | `sort_order` column ships in 0314; the web UI ships remove-before-save but NOT drag-reorder in phase 1 (photo order is upload order). Recorded in §33 as a deliberate scope cut | Tasks 1, 13 |
| C9 | Brief §26 God-Admin per-user audience matrix | Per audit Q12: phase 1 ships permission-resolved audiences + standard self-service muteable prefs; the per-user matrix is stored as a simple `notifyAudience` map in `organization_modules.settings` editable from the settings page — `all` / `urgent_only` / `none` per user id | Tasks 16, 21 |
| C10 | Brief §25 mobile "download/share photos" | Pure-JS phase 1: mobile detail opens the share page URL / photo signed URLs via `Linking.openURL` (system browser handles saving). expo-sharing/media-library deferred to the EAS-build track (audit Q9) | Task 20 |

### Regression assertions — every task keeps these green

- **R1 — the four delivery pinning suites are untouched and green**: `storefront-logic.test.ts`, `delivery-request-action.test.tsx`, `site.test.ts`, `storefront-overlays.test.tsx` — zero edits to the test files, all passing after every task from Task 5 on.
- **R2 — `pnpm --filter web test`, `pnpm --filter web typecheck`, `pnpm --filter mobile test`, `pnpm --filter @stockpilot/core test` stay green at every commit.**
- **R3 — pgTAP suite passes locally** (`supabase db reset` then `supabase test db`) after every migration-touching task.
- **R4 — no existing module's nav, seeds, or permissions change**: the 0314 seed rewrite is byte-identical to 0297's body plus one appended row; `DEFAULT_MODULE_IDS` never contains `maintenance_requests`.

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `supabase/migrations/0314_maintenance_requests.sql` | NEW — module grandfather + seed rewrite + 8 permission seed rows + 4 tables + numbering trigger + RLS + grants + indexes + notification-pref columns | 1 |
| `supabase/tests/0314_maintenance_requests.test.sql` | NEW — pgTAP: RLS matrix, numbering, module-off insert block | 1 |
| `supabase/tests/0207_permission_overrides.test.sql` | MODIFIED — 111 → 119 + provenance message append | 1 |
| `supabase/migrations/0315_maintenance_photos_bucket.sql` | NEW — private bucket png/jpeg/webp 10MB + org-prefix INSERT policy with 0312 inline guard | 2 |
| `supabase/tests/0315_maintenance_photos_bucket.test.sql` | NEW — bucket pins + policy | 2 |
| `packages/core/src/modules/registry.ts` | MODIFIED — `maintenance_requests` ModuleId + registry entry | 3 |
| `packages/core/src/modules/registry.test.ts` | MODIFIED — `/maintenance` added to EXPO_ROUTES; entry shape pins | 3 |
| `packages/core/src/constants/permissions.ts` | MODIFIED — 4 permissions, role defaults, FULLY_GRANTABLE, PERMISSION_META 'Maintenance' group | 3 |
| `packages/core/src/constants/permissions.test.ts` | MODIFIED — literal pins for the 4 strings + role membership | 3 |
| `packages/core/src/email/outlook-compose.ts` | NEW — the shared transport: base, limit, encodeDraftQuery, composeOutlookWebUrl/composeMailtoUrl/composeClipboardText, createOutlookComposeEmail, assertSafeDisplayName | 4 |
| `packages/core/src/email/outlook-compose.test.ts` | NEW — transport pins incl. cc-optional | 4 |
| `apps/web/src/components/orders/storefront/storefront-logic.ts` | MODIFIED — transport internals replaced by delegating wrappers; same exports, same bytes out | 5 |
| `packages/core/src/maintenance/constants.ts` | NEW — L4L_MAINTENANCE_EMAIL(+NAMES), categories, priorities, caps, CC notice | 6 |
| `packages/core/src/maintenance/mr-number.ts` | NEW — formatMaintenanceRequestNumber / parseMaintenanceRequestNumber | 6 |
| `packages/core/src/maintenance/text.ts` | NEW — sanitizeSubjectLine / sanitizeDescriptionBlock | 6 |
| `packages/core/src/maintenance/{constants,mr-number,text}.test.ts` | NEW | 6 |
| `packages/core/src/schemas/maintenance.ts` | NEW — zod form schema shared web/mobile/server | 6 |
| `packages/core/src/maintenance/email.ts` | NEW — buildMaintenanceEmailDraft + prepareMaintenanceEmail (condense, measure, linkFits) | 7 |
| `packages/core/src/maintenance/email.test.ts` | NEW — the Brief §31 email-builder 21 + condense + no-send sweep | 7 |
| `packages/core/src/index.ts` | MODIFIED — export barrels for email/ + maintenance/ | 4, 6, 7 |
| `apps/web/src/server/services/maintenance-requests.ts` | NEW — create/list/get/update/archive/cancel/assignLocalOwner/notes/recordDraftOpened + email-input assembly | 8 |
| `apps/web/src/server/services/maintenance-requests.test.ts` | NEW — chains-pinned service tests | 8 |
| `apps/web/src/server/services/audit.ts` | MODIFIED — `maintenance_request.*` AuditEvent union members | 8 |
| `apps/web/src/server/actions/maintenance-requests.ts` | NEW — server actions wrapping the service for web forms | 8 |
| `apps/web/src/lib/image-signature.ts` | NEW — sniffImage(bytes): png/jpeg/webp kind + dimensions | 9 |
| `apps/web/src/lib/image-signature.test.ts` | NEW — real byte fixtures incl. fake-MIME rejection | 9 |
| `apps/web/src/server/services/maintenance-attachments.ts` | NEW — createUploadUrl (mint) / finalize (sniff+verify) / remove / signedViewUrls | 9 |
| `apps/web/src/server/services/maintenance-attachments.test.ts` | NEW | 9 |
| `apps/web/src/app/api/v1/maintenance-requests/[id]/attachments/route.ts` | NEW — POST mint | 9 |
| `apps/web/src/app/api/v1/maintenance-requests/[id]/attachments/finalize/route.ts` | NEW — POST finalize | 9 |
| `apps/web/src/app/api/v1/maintenance-requests/[id]/attachments/[attachmentId]/route.ts` | NEW — DELETE | 9 |
| `apps/web/src/server/services/maintenance-share-links.ts` | NEW — ensureActiveLink / revoke / resolveByToken | 10 |
| `apps/web/src/server/services/maintenance-share-links.test.ts` | NEW | 10 |
| `apps/web/src/app/m/[token]/page.tsx` | NEW — public share page (rate-limited, generic 404) | 10 |
| `apps/web/src/app/api/v1/maintenance-requests/route.ts` | NEW — GET list / POST create | 11 |
| `apps/web/src/app/api/v1/maintenance-requests/[id]/route.ts` | NEW — GET detail / PATCH update | 11 |
| `apps/web/src/app/api/v1/maintenance-requests/[id]/draft-opened/route.ts` | NEW — POST stamp | 11 |
| `apps/web/src/app/api/v1/maintenance-requests/[id]/share-link/route.ts` | NEW — POST create / DELETE revoke | 11 |
| `apps/web/src/app/api/v1/maintenance-requests/route.test.ts` (+ sibling route tests) | NEW | 11 |
| `apps/web/src/app/(dashboard)/dashboard/maintenance/page.tsx` | NEW — list (my/all) + filters + Zendesk-boundary note | 12 |
| `apps/web/src/app/(dashboard)/dashboard/maintenance/loading.tsx` | NEW — TablePageSkeleton | 12 |
| `apps/web/src/components/maintenance/maintenance-status-badge.tsx` | NEW — the 4 status labels | 12 |
| `apps/web/src/app/(dashboard)/dashboard/maintenance/new/page.tsx` | NEW — form page + prefill from searchParams | 13 |
| `apps/web/src/components/maintenance/maintenance-request-form.tsx` | NEW — RHF+zod form | 13 |
| `apps/web/src/components/maintenance/maintenance-photos-panel.tsx` | NEW — picker/drag-drop/camera + mint→PUT→finalize + previews + remove | 13 |
| `apps/web/src/components/maintenance/maintenance-request-form.test.tsx` | NEW | 13 |
| `apps/web/src/components/maintenance/maintenance-photos-panel.test.tsx` | NEW — preview + remove (Brief §31 component test 5) | 13 |
| `apps/web/src/components/maintenance/maintenance-email-action.tsx` | NEW — the 4 actions + popup-blocked fallback + duplicate-draft dialog + dual live regions | 14 |
| `apps/web/src/components/maintenance/maintenance-email-action.test.tsx` | NEW — the component-test heart of the program | 14 |
| `apps/web/src/components/maintenance/maintenance-review.tsx` | NEW — the review screen composition | 14 |
| `apps/web/src/app/(dashboard)/dashboard/maintenance/[id]/page.tsx` | NEW — detail: timeline, notes, photos, email preview, share-link manage, download | 15 |
| `apps/web/src/components/maintenance/maintenance-notes-panel.tsx` | NEW | 15 |
| `apps/web/src/components/maintenance/assign-owner-select.tsx` | NEW — member picker (accepted members embed) | 15 |
| `apps/web/src/components/maintenance/share-link-panel.tsx` | NEW — create/revoke + copy URL | 15 |
| `apps/web/src/app/(dashboard)/dashboard/settings/maintenance/page.tsx` | NEW — settings page | 16 |
| `apps/web/src/components/maintenance/maintenance-settings-panel.tsx` | NEW — categories, share-links-in-email toggle, notify audience map, roles-matrix link | 16 |
| `apps/web/src/app/(dashboard)/dashboard/settings/page.tsx` | MODIFIED — hub tile | 16 |
| `apps/web/src/components/maintenance/report-problem-button.tsx` | NEW — client launch button (primitive props) | 17 |
| `apps/web/src/components/inventory/item-detail.tsx` | MODIFIED — launch button in the sticky action row | 17 |
| `apps/web/src/app/(dashboard)/dashboard/orders/[id]/page.tsx` | MODIFIED — launch button in header actions | 17 |
| `apps/web/src/app/(dashboard)/dashboard/rentals/[id]/page.tsx` | MODIFIED — launch button | 17 |
| `apps/mobile/src/lib/web-path-rewrite.ts` | MODIFIED — 3 maintenance REWRITES rules | 18 |
| `apps/mobile/src/lib/web-path-rewrite.test.ts` | MODIFIED — rule tests | 18 |
| `apps/mobile/src/lib/maintenance-api.ts` | NEW — typed api() calls + upload task helper | 18 |
| `apps/mobile/app/(drawer)/maintenance.tsx` | NEW — list screen | 18 |
| `apps/mobile/app/(drawer)/_layout.tsx` | MODIFIED — Drawer.Screen registration | 18 |
| `apps/mobile/app/_layout.tsx` | MODIFIED — stack routes `maintenance/new`, `maintenance/[id]` | 18 |
| `apps/mobile/app/maintenance/new.tsx` | NEW — form + photos + progress/retry | 19 |
| `apps/mobile/app/maintenance/[id].tsx` | NEW — detail + email actions + selectable-text copy | 20 |
| `apps/mobile/app/(tabs → drawer)/(tabs)/scan.tsx` | MODIFIED — "Report a problem" secondary action | 20 |
| `apps/mobile/app/item/[id].tsx` | MODIFIED — "Report a problem" overview action | 20 |
| `apps/web/src/lib/notification-prefs.ts` | MODIFIED — 4 maintenance pref keys | 21 |
| `apps/web/src/components/settings/notification toggles (TOGGLE_DEFS site)` | MODIFIED — 4 toggle entries | 21 |
| `apps/web/src/server/services/maintenance-notify.ts` | NEW — audience resolution from effective permissions + emit helpers | 21 |
| `apps/web/src/server/services/maintenance-notify.test.ts` | NEW | 21 |
| `apps/web/src/app/api/cron/maintenance-draft-reminders/route.ts` | NEW — stamp-first reminder cron | 22 |
| `apps/web/vercel.json` | MODIFIED — cron entry | 22 |
| `apps/web/src/lib/onboarding/{tours,workflows,announcements}.ts` | MODIFIED — tour + TOUR_ROUTES + announcement at TOP | 23 |
| `docs/superpowers/reports/2026-08-05-maintenance-requests-verification.md` | NEW — real gate output + manual walk record | 24, 25 |
| `docs/superpowers/reports/2026-08-05-maintenance-requests-report.md` | NEW — the Brief §33 engineering report + ship checklist | 26 |

---

# Phase A — Migrations + core registry (locally testable via `supabase db reset`)

Everything the DB and the TS catalogs need, before any feature code. Independently testable: pgTAP green locally, core test suite green, zero web/mobile surface changes.

## Task 1: Migration 0314 — tables, permissions, module rows, numbering, RLS, pgTAP

**Files:**
- Create: `supabase/migrations/0314_maintenance_requests.sql`
- Create: `supabase/tests/0314_maintenance_requests.test.sql`
- Modify: `supabase/tests/0207_permission_overrides.test.sql:41-45` (count 111 → 119 + message append)

**Interfaces:**
- Consumes: `public.has_org_role(uuid, text)`, `public.has_permission(uuid, text)` (0207/0310), `public.module_enabled(uuid, text)` (0144), `public.seed_org_modules()` latest body (0297:26-87), 0254 trigger shape.
- Produces (later tasks rely on these EXACT names): tables `maintenance_requests`, `maintenance_request_attachments`, `maintenance_request_notes`, `maintenance_request_share_links`; columns as written below (services select them verbatim); permission strings `maintenance_requests:submit|read_all|manage|configure`; module id `maintenance_requests`; `notification_preferences` columns `push_maintenance_new_request`, `push_maintenance_urgent_request`, `push_maintenance_assigned`, `push_maintenance_draft_reminder`.

- [ ] **Step 1: Write the failing pgTAP test** — `supabase/tests/0314_maintenance_requests.test.sql`:

```sql
begin;
select plan(26);

-- ── Fixtures ────────────────────────────────────────────────────────────────
\set org_a '''a0000000-0000-0000-0000-00000000000a'''
\set org_b '''b0000000-0000-0000-0000-00000000000b'''
\set requester '''10000000-0000-0000-0000-000000000001'''
\set other_staff '''10000000-0000-0000-0000-000000000002'''
\set mgr '''10000000-0000-0000-0000-000000000003'''
\set andrew '''10000000-0000-0000-0000-000000000004'''
\set outsider '''10000000-0000-0000-0000-000000000005'''
\set org_owner '''10000000-0000-0000-0000-000000000006'''

insert into auth.users (id, email) values
  (:requester, 'req@test.local'), (:other_staff, 'staff2@test.local'),
  (:mgr, 'mgr@test.local'), (:andrew, 'andrew@test.local'), (:outsider, 'out@test.local'),
  (:org_owner, 'owner@test.local');
insert into public.user_profiles (id, full_name) values
  (:requester, 'Req One'), (:other_staff, 'Staff Two'), (:mgr, 'Mgr Three'),
  (:andrew, 'Andrew Rosas'), (:outsider, 'Out Sider'), (:org_owner, 'Org Owner')
on conflict (id) do nothing;

insert into public.organizations (id, name, slug) values
  (:org_a, 'Maint Org A', 'maint-org-a'), (:org_b, 'Maint Org B', 'maint-org-b');

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org_a, :requester, 'staff',  now()),
  (:org_a, :other_staff, 'staff', now()),
  (:org_a, :mgr, 'manager', now()),
  (:org_a, :andrew, 'viewer', now()),
  (:org_a, :org_owner, 'owner', now()),
  (:org_b, :outsider, 'staff', now());

-- Module ON for org A only (org B stays grandfathered OFF).
update public.organization_modules set enabled = true
 where organization_id = :org_a and module_id = 'maintenance_requests';

-- ── Structure ───────────────────────────────────────────────────────────────
select has_table('public', 'maintenance_requests', 'maintenance_requests exists');
select has_table('public', 'maintenance_request_attachments', 'attachments table exists');
select has_table('public', 'maintenance_request_notes', 'notes table exists');
select has_table('public', 'maintenance_request_share_links', 'share links table exists');
select col_not_null('public', 'maintenance_requests', 'organization_id', 'org id not null');

-- Grandfather: every org has a row, disabled by default (org B untouched).
select ok(
  exists (select 1 from public.organization_modules
           where organization_id = :org_b and module_id = 'maintenance_requests' and enabled = false),
  'module grandfathered OFF for other orgs');

-- Seed rows: 8 new defaults, configure seeded for NOBODY.
select is(
  (select count(*)::int from public.role_default_permissions where permission like 'maintenance_requests:%'), 8,
  'exactly 8 maintenance permission default rows');
select ok(
  not exists (select 1 from public.role_default_permissions where permission = 'maintenance_requests:configure'),
  'configure has zero default rows (owner-only)');

-- ── Requester can create own; number auto-assigns 1, 2 ─────────────────────
set local "request.jwt.claim.sub" to '10000000-0000-0000-0000-000000000001';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

insert into public.maintenance_requests
  (organization_id, requester_user_id, requester_name_snapshot, subject, description)
values (:org_a, :requester, 'Req One', 'AC not working in Room 204', 'Blowing warm air since yesterday.');
select is(
  (select request_number from public.maintenance_requests
    where organization_id = :org_a and subject = 'AC not working in Room 204'), 1::bigint,
  'first request gets number 1');

insert into public.maintenance_requests
  (organization_id, requester_user_id, requester_name_snapshot, subject, description)
values (:org_a, :requester, 'Req One', 'Leaking sink in break room', 'Steady drip under the sink.');
select is(
  (select max(request_number) from public.maintenance_requests where organization_id = :org_a), 2::bigint,
  'second request gets number 2');

-- Requester reads own rows only.
select is((select count(*)::int from public.maintenance_requests), 2, 'requester sees own 2 rows');

-- Requester cannot forge another user as requester.
select throws_ok(
  $$ insert into public.maintenance_requests
       (organization_id, requester_user_id, requester_name_snapshot, subject, description)
     values ('a0000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000003',
             'Mgr Three', 'Forged requester', 'nope') $$,
  '42501', null, 'cannot insert with someone else as requester');

-- ── Another staff member sees NOTHING (no read_all) ─────────────────────────
set local "request.jwt.claim.sub" to '10000000-0000-0000-0000-000000000002';
select is((select count(*)::int from public.maintenance_requests), 0, 'plain staff sees zero rows');

-- ── Manager holds read_all + manage by default: sees all, can update ────────
set local "request.jwt.claim.sub" to '10000000-0000-0000-0000-000000000003';
select is((select count(*)::int from public.maintenance_requests), 2, 'manager (read_all default) sees all');
update public.maintenance_requests set local_owner_user_id = '10000000-0000-0000-0000-000000000003'
 where organization_id = :org_a and request_number = 1;
select is(
  (select local_owner_user_id from public.maintenance_requests
    where organization_id = :org_a and request_number = 1),
  '10000000-0000-0000-0000-000000000003'::uuid, 'manager can assign local owner');

-- Manager adds an internal note; requester cannot read it.
insert into public.maintenance_request_notes (organization_id, maintenance_request_id, author_user_id, body)
select organization_id, id, '10000000-0000-0000-0000-000000000003', 'Called facilities, waiting on parts.'
  from public.maintenance_requests where organization_id = :org_a and request_number = 1;
select is((select count(*)::int from public.maintenance_request_notes), 1, 'manager reads own note');
set local "request.jwt.claim.sub" to '10000000-0000-0000-0000-000000000001';
select is((select count(*)::int from public.maintenance_request_notes), 0, 'requester cannot read internal notes');

-- ── Andrew: viewer + per-user override grant of read_all sees everything ────
set local role to postgres;
insert into public.user_permission_overrides (organization_id, user_id, permission, granted)
values (:org_a, :andrew, 'maintenance_requests:read_all', true);
set local "request.jwt.claim.sub" to '10000000-0000-0000-0000-000000000004';
set local role to 'authenticated';
select is((select count(*)::int from public.maintenance_requests), 2,
  'per-user override grants Andrew all-request visibility');

-- ── Owner: full access always (has_permission owner short-circuit) ──────────
set local "request.jwt.claim.sub" to '10000000-0000-0000-0000-000000000006';
select is((select count(*)::int from public.maintenance_requests), 2,
  'org owner retains full visibility without any seeded permission rows');

-- ── Cross-org: org B member sees zero rows, cannot insert into org A ────────
set local "request.jwt.claim.sub" to '10000000-0000-0000-0000-000000000005';
select is((select count(*)::int from public.maintenance_requests), 0, 'other org sees zero rows');
select throws_ok(
  $$ insert into public.maintenance_requests
       (organization_id, requester_user_id, requester_name_snapshot, subject, description)
     values ('a0000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000005',
             'Out Sider', 'Cross-org write', 'nope') $$,
  '42501', null, 'cross-org insert blocked');

-- Module OFF (org B enabled=false): its own member cannot insert either.
select throws_ok(
  $$ insert into public.maintenance_requests
       (organization_id, requester_user_id, requester_name_snapshot, subject, description)
     values ('b0000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-000000000005',
             'Out Sider', 'Module is off here', 'nope') $$,
  '42501', null, 'module-off org blocks INSERT at RLS');

-- SELECT is NOT module-gated: flip org A off, requester still sees history.
set local role to postgres;
update public.organization_modules set enabled = false
 where organization_id = :org_a and module_id = 'maintenance_requests';
set local "request.jwt.claim.sub" to '10000000-0000-0000-0000-000000000001';
set local role to 'authenticated';
select is((select count(*)::int from public.maintenance_requests), 2,
  'disabling the module does not hide existing history');

-- Share links: authenticated non-manager cannot read tokens.
select is((select count(*)::int from public.maintenance_request_share_links), 0,
  'requester cannot enumerate share links');

-- notification_preferences carries the four maintenance columns.
select has_column('public', 'notification_preferences', 'push_maintenance_new_request', 'pref col 1');
select has_column('public', 'notification_preferences', 'push_maintenance_draft_reminder', 'pref col 4');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `supabase db reset && supabase test db`
Expected: `0314_maintenance_requests.test.sql` FAILS with `ERROR:  relation "public.maintenance_requests" does not exist` (the migration is not written yet).

- [ ] **Step 3: Write the migration** — `supabase/migrations/0314_maintenance_requests.sql`:

```sql
-- 0314_maintenance_requests.sql
--
-- L4L Maintenance Requests module: tables + RLS + permissions + module rows +
-- MR numbering + notification-pref columns.
--
-- DELIBERATE DEVIATIONS FROM THE BRIEF SKETCH (§27), each adjudicated in the
-- plan: related_order_request_id (no `orders` table exists; every FK into
-- order_requests is *_order_request_id); no asset_tag column (no such data
-- exists anywhere); explicit `status` column backing the four §20 states.
--
-- L4L ENABLEMENT IS NOT HERE. This migration only grandfathers enabled=false
-- rows for every org. The one-off enable UPDATE runs at ship time against the
-- prod-verified L4L org id (plan Task 26) — never name-matching, never
-- hardcoded here.

-- ── 1) Permission default rows (TS mirror: packages/core permissions.ts) ────
-- submit: everyone incl. viewer (brief: any employee reports issues).
-- read_all + manage: admin + manager. configure: NO rows — owner-only via the
-- has_permission owner short-circuit. 0207 pgTAP count moves 111 -> 119.
insert into public.role_default_permissions (role, permission) values
  ('admin',   'maintenance_requests:submit'),
  ('manager', 'maintenance_requests:submit'),
  ('staff',   'maintenance_requests:submit'),
  ('viewer',  'maintenance_requests:submit'),
  ('admin',   'maintenance_requests:read_all'),
  ('manager', 'maintenance_requests:read_all'),
  ('admin',   'maintenance_requests:manage'),
  ('manager', 'maintenance_requests:manage')
on conflict (role, permission) do nothing;

-- ── 2) Grandfather every existing org: 'maintenance_requests' OFF ───────────
insert into public.organization_modules (organization_id, module_id, enabled, tier, enabled_at)
select o.id, 'maintenance_requests', false, 'optional', now()
from public.organizations o
on conflict (organization_id, module_id) do nothing;

-- ── 3) New-org seed: the 0297 body VERBATIM + the new row appended ──────────
-- Copied byte-for-byte from 0297_sports_module.sql (the latest wholesale
-- rewrite). Do not re-order, do not tidy, do not drop a module.
create or replace function public.seed_org_modules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.organization_modules (organization_id, module_id, tier, enabled)
  select new.id, m.module_id, m.tier, m.enabled
  from (values
    -- 12 core (enabled)
    ('overview','core', true),
    ('inventory','core', true),
    ('movements','core', true),
    ('categories','core', true),
    ('locations','core', true),
    ('reports','core', true),
    ('notifications','core', true),
    ('team','core', true),
    ('settings','core', true),
    ('admin_tools','core', true),
    ('charters','core', true),
    ('scan','core', true),
    -- 13 optional (enabled)
    ('books','optional', true),
    ('rentals','optional', true),
    ('bundles','optional', true),
    ('orders','optional', true),
    ('cycle_counts','optional', true),
    ('procedures','optional', true),
    ('purchase_orders','optional', true),
    ('receiving','optional', true),
    ('po_imports','optional', true),
    ('suppliers','optional', true),
    ('schedule','optional', true),
    ('ai','optional', true),
    ('public_requests','optional', true),
    -- returns: gate cleared + owner-enabled 2026-06-11 (0174)
    ('returns','optional', true),
    -- net-new opt-in optional (OFF)
    ('planning','optional', false),
    ('lot_serial','premium', false),
    ('price_tracking','optional', false),
    ('live_tracking','optional', false),
    -- net-new opt-in optional (OFF)
    ('zendesk','optional', false),
    -- sports: self-contained premium module, OFF by default (0297)
    ('sports','premium', false),
    -- maintenance requests: L4L-only for now, OFF by default (this migration)
    ('maintenance_requests','optional', false)
  ) as m(module_id, tier, enabled)
  on conflict (organization_id, module_id) do nothing;
  return new;
exception
  when others then
    raise warning 'seed_org_modules failed for org %: %', new.id, sqlerrm;
    return new;
end;
$$;

drop trigger if exists trg_seed_org_modules on public.organizations;
create trigger trg_seed_org_modules
  after insert on public.organizations
  for each row execute function public.seed_org_modules();

-- ── 4) maintenance_requests ─────────────────────────────────────────────────
create table if not exists public.maintenance_requests (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references public.organizations(id) on delete cascade,
  request_number            bigint,
  requester_user_id         uuid references auth.users(id) on delete set null,
  requester_name_snapshot   text not null check (length(requester_name_snapshot) between 1 and 200),
  requester_email_snapshot  text check (requester_email_snapshot is null or length(requester_email_snapshot) <= 320),
  requester_phone_snapshot  text check (requester_phone_snapshot is null or length(requester_phone_snapshot) <= 40),
  subject                   text not null check (length(subject) between 5 and 200),
  description               text not null check (length(description) between 1 and 5000),
  category                  text check (category is null or length(category) <= 80),
  priority                  text not null default 'normal'
                              check (priority in ('low','normal','high','urgent')),
  charter_id                uuid references public.charters(id) on delete set null,
  warehouse_id              uuid references public.warehouses(id) on delete set null,
  building                  text check (building is null or length(building) <= 200),
  room_or_area              text check (room_or_area is null or length(room_or_area) <= 200),
  department                text check (department is null or length(department) <= 200),
  access_instructions       text check (access_instructions is null or length(access_instructions) <= 2000),
  related_item_id           uuid references public.inventory_items(id) on delete set null,
  related_order_request_id  uuid references public.order_requests(id) on delete set null,
  related_rental_id         uuid references public.rentals(id) on delete set null,
  related_location_id       uuid references public.locations(id) on delete set null,
  local_owner_user_id       uuid references auth.users(id) on delete set null,
  status                    text not null default 'saved'
                              check (status in ('saved','draft_opened','archived','cancelled')),
  outlook_draft_opened_at   timestamptz,
  outlook_draft_open_count  integer not null default 0,
  draft_reminder_sent_at    timestamptz,
  archived_at               timestamptz,
  cancelled_at              timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

comment on table public.maintenance_requests is
  'L4L maintenance requests. StockPilot records Saved / Email draft opened / Archived / Cancelled ONLY — it can never observe whether the employee pressed Send or whether Zendesk created a ticket. No ticket-sync fields, ever.';

-- MR numbering: 0254 clone. Single per-org counter; the year in the display
-- handle (MR-2026-000123) is cosmetic, derived from created_at at format time.
create or replace function public.assign_maintenance_request_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.request_number is not null then
    return new; -- explicit numbers (restores) pass through
  end if;
  perform pg_advisory_xact_lock(hashtext('maintenance_request_number:' || new.organization_id::text));
  select coalesce(max(request_number), 0) + 1
    into new.request_number
    from public.maintenance_requests
   where organization_id = new.organization_id;
  return new;
end;
$$;

drop trigger if exists trg_assign_maintenance_request_number on public.maintenance_requests;
create trigger trg_assign_maintenance_request_number
  before insert on public.maintenance_requests
  for each row execute function public.assign_maintenance_request_number();

alter table public.maintenance_requests
  alter column request_number set not null;

create unique index if not exists maintenance_requests_org_number_uniq
  on public.maintenance_requests (organization_id, request_number);
create index if not exists maintenance_requests_org_created_idx
  on public.maintenance_requests (organization_id, created_at desc);
create index if not exists maintenance_requests_org_requester_idx
  on public.maintenance_requests (organization_id, requester_user_id, created_at desc);
create index if not exists maintenance_requests_org_status_idx
  on public.maintenance_requests (organization_id, status);

-- ── 5) maintenance_request_attachments ──────────────────────────────────────
create table if not exists public.maintenance_request_attachments (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations(id) on delete cascade,
  maintenance_request_id uuid not null references public.maintenance_requests(id) on delete cascade,
  storage_path           text not null check (length(storage_path) <= 500),
  thumbnail_path         text check (thumbnail_path is null or length(thumbnail_path) <= 500),
  original_filename      text not null check (length(original_filename) <= 300),
  safe_filename          text not null check (length(safe_filename) <= 300),
  mime_type              text not null check (mime_type in ('image/png','image/jpeg','image/webp')),
  byte_size              integer not null check (byte_size > 0 and byte_size <= 10485760),
  width                  integer,
  height                 integer,
  sort_order             integer not null default 0,
  verified_at            timestamptz,
  uploaded_by            uuid references auth.users(id) on delete set null,
  created_at             timestamptz not null default now()
);

create index if not exists maintenance_request_attachments_req_idx
  on public.maintenance_request_attachments (maintenance_request_id, sort_order, created_at);
create index if not exists maintenance_request_attachments_org_idx
  on public.maintenance_request_attachments (organization_id);

-- ── 6) maintenance_request_notes (internal StockPilot notes — NEVER Zendesk) ─
create table if not exists public.maintenance_request_notes (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations(id) on delete cascade,
  maintenance_request_id uuid not null references public.maintenance_requests(id) on delete cascade,
  author_user_id         uuid references auth.users(id) on delete set null,
  body                   text not null check (length(body) between 1 and 4000),
  created_at             timestamptz not null default now()
);

create index if not exists maintenance_request_notes_req_idx
  on public.maintenance_request_notes (maintenance_request_id, created_at);

-- ── 7) maintenance_request_share_links (0261 token pattern, request-scoped) ─
create table if not exists public.maintenance_request_share_links (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations(id) on delete cascade,
  maintenance_request_id uuid not null references public.maintenance_requests(id) on delete cascade,
  token                  text not null unique check (length(token) between 16 and 128),
  active                 boolean not null default true,
  expires_at             timestamptz not null,
  created_by             uuid references auth.users(id) on delete set null,
  revoked_at             timestamptz,
  created_at             timestamptz not null default now()
);

create index if not exists maintenance_request_share_links_req_idx
  on public.maintenance_request_share_links (maintenance_request_id);

-- ── 8) RLS ──────────────────────────────────────────────────────────────────
alter table public.maintenance_requests enable row level security;
alter table public.maintenance_request_attachments enable row level security;
alter table public.maintenance_request_notes enable row level security;
alter table public.maintenance_request_share_links enable row level security;

grant select, insert, update on public.maintenance_requests to authenticated;
grant select, insert, delete on public.maintenance_request_attachments to authenticated;
grant select, insert on public.maintenance_request_notes to authenticated;
grant select on public.maintenance_request_share_links to authenticated;

-- SELECT: requester-own OR read_all OR manage. NOT module-gated (Q3): history
-- stays visible after a disable. has_permission (0310 rewrite) already fails
-- for disabled accounts and short-circuits owner to true.
create policy maintenance_requests_select on public.maintenance_requests
  for select to authenticated
  using (
    (requester_user_id = auth.uid() and public.has_org_role(organization_id, 'viewer'))
    or public.has_permission(organization_id, 'maintenance_requests:read_all')
    or public.has_permission(organization_id, 'maintenance_requests:manage')
  );

-- INSERT: submitter creates OWN rows only; module must be enabled (Q3).
create policy maintenance_requests_insert on public.maintenance_requests
  for insert to authenticated
  with check (
    requester_user_id = auth.uid()
    and (
      public.has_org_role(organization_id, 'manager')
      or public.has_permission(organization_id, 'maintenance_requests:submit')
    )
    and (select public.module_enabled(organization_id, 'maintenance_requests'))
  );

-- UPDATE: requester edits own pre-archival rows; manage/manager edit any.
-- Allowed-FIELD narrowing (requester cannot flip local_owner_user_id etc.) is
-- enforced in the service layer; RLS enforces the row boundary.
create policy maintenance_requests_update on public.maintenance_requests
  for update to authenticated
  using (
    (requester_user_id = auth.uid() and archived_at is null and cancelled_at is null
      and public.has_org_role(organization_id, 'viewer'))
    or public.has_org_role(organization_id, 'manager')
    or public.has_permission(organization_id, 'maintenance_requests:manage')
  )
  with check (
    (
      (requester_user_id = auth.uid() and public.has_org_role(organization_id, 'viewer'))
      or public.has_org_role(organization_id, 'manager')
      or public.has_permission(organization_id, 'maintenance_requests:manage')
    )
    and (select public.module_enabled(organization_id, 'maintenance_requests'))
  );

-- Attachments: visibility follows the parent row.
create policy maintenance_request_attachments_select on public.maintenance_request_attachments
  for select to authenticated
  using (
    exists (
      select 1 from public.maintenance_requests r
       where r.id = maintenance_request_id
         and r.organization_id = organization_id
         and (
           (r.requester_user_id = auth.uid() and public.has_org_role(r.organization_id, 'viewer'))
           or public.has_permission(r.organization_id, 'maintenance_requests:read_all')
           or public.has_permission(r.organization_id, 'maintenance_requests:manage')
         )
    )
  );

create policy maintenance_request_attachments_insert on public.maintenance_request_attachments
  for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and (select public.module_enabled(organization_id, 'maintenance_requests'))
    and exists (
      select 1 from public.maintenance_requests r
       where r.id = maintenance_request_id
         and r.organization_id = organization_id
         and r.archived_at is null and r.cancelled_at is null
         and (
           r.requester_user_id = auth.uid()
           or public.has_org_role(r.organization_id, 'manager')
           or public.has_permission(r.organization_id, 'maintenance_requests:manage')
         )
    )
  );

create policy maintenance_request_attachments_delete on public.maintenance_request_attachments
  for delete to authenticated
  using (
    exists (
      select 1 from public.maintenance_requests r
       where r.id = maintenance_request_id
         and r.organization_id = organization_id
         and r.archived_at is null and r.cancelled_at is null
         and (
           r.requester_user_id = auth.uid()
           or public.has_org_role(r.organization_id, 'manager')
           or public.has_permission(r.organization_id, 'maintenance_requests:manage')
         )
    )
  );

-- Notes: manage-only in BOTH directions (brief: requester must never read
-- internal notes; read_all explicitly excludes notes).
create policy maintenance_request_notes_select on public.maintenance_request_notes
  for select to authenticated
  using (public.has_permission(organization_id, 'maintenance_requests:manage'));

create policy maintenance_request_notes_insert on public.maintenance_request_notes
  for insert to authenticated
  with check (
    author_user_id = auth.uid()
    and public.has_permission(organization_id, 'maintenance_requests:manage')
    and (select public.module_enabled(organization_id, 'maintenance_requests'))
  );

-- Share links: tokens are secrets. SELECT for manage only; ALL writes happen
-- through the service-role client (no authenticated write policies at all).
create policy maintenance_request_share_links_select on public.maintenance_request_share_links
  for select to authenticated
  using (public.has_permission(organization_id, 'maintenance_requests:manage'));

-- ── 9) Notification preference columns (0265 recipe) ────────────────────────
alter table public.notification_preferences
  add column if not exists push_maintenance_new_request    boolean not null default true,
  add column if not exists push_maintenance_urgent_request boolean not null default true,
  add column if not exists push_maintenance_assigned       boolean not null default true,
  add column if not exists push_maintenance_draft_reminder boolean not null default true;
```

- [ ] **Step 4: Run pgTAP again.**

Run: `supabase db reset && supabase test db`
Expected: `0314_maintenance_requests.test.sql` PASSES (24/24). `0207_permission_overrides.test.sql` now FAILS: `role_default_permissions seeded with 111 rows ... have: 119, want: 111` — the REAL count moved. Record the actual failure text.

- [ ] **Step 5: Bump the 0207 mirror pin.** In `supabase/tests/0207_permission_overrides.test.sql:41-45`, change the literal `111` to `119` and append to the provenance message in the same format, so the block reads:

```sql
select is(
  (select count(*)::int from public.role_default_permissions),
  119,
  'role_default_permissions seeded with 119 rows (admin/manager/staff/viewer flatten; +2 customers:manage rows from 0250; +1 public_links:manage row from 0261; +2 movements:edit_notes rows from 0274; +13 auditor read rows from 0279 — admin/manager 5 each + staff 3; +2 sports:manage rows from 0297; +8 maintenance rows from 0314 — submit admin/manager/staff/viewer + read_all and manage admin/manager each)'
);
```

- [ ] **Step 6: Run the full local pgTAP suite green.**

Run: `supabase db reset && supabase test db`
Expected: ALL files pass, including 0207 (119) and 0314 (24/24).

- [ ] **Step 7: Commit.**

```bash
git add supabase/migrations/0314_maintenance_requests.sql \
        supabase/tests/0314_maintenance_requests.test.sql \
        supabase/tests/0207_permission_overrides.test.sql
git commit -m "feat(maintenance): migration 0314 - tables, RLS, permissions, module rows, MR numbering"
```

## Task 2: Migration 0315 — private photos bucket + storage policies

**Files:**
- Create: `supabase/migrations/0315_maintenance_photos_bucket.sql`
- Create: `supabase/tests/0315_maintenance_photos_bucket.test.sql`

**Interfaces:**
- Consumes: the 0260 bucket-pin idiom; the 0312 inline disabled-account guard.
- Produces: bucket id `maintenance-photos` (path scheme `{organization_id}/{request_id}/{uuid}.{ext}` + `{uuid}-thumb.webp` — Task 9 mints exactly these paths); INSERT-only storage policy (reads are ALWAYS server-minted signed URLs).

- [ ] **Step 1: Write the failing pgTAP test** — `supabase/tests/0315_maintenance_photos_bucket.test.sql`:

```sql
begin;
select plan(4);

select ok(
  exists (select 1 from storage.buckets where id = 'maintenance-photos' and public = false),
  'maintenance-photos bucket exists and is private');
select is(
  (select allowed_mime_types from storage.buckets where id = 'maintenance-photos'),
  array['image/png','image/jpeg','image/webp'],
  'bucket pinned to png/jpeg/webp (HEIC must transcode client-side)');
select is(
  (select file_size_limit from storage.buckets where id = 'maintenance-photos'),
  10485760::bigint,
  'bucket capped at 10MB per object');
select ok(
  exists (select 1 from pg_policies
           where schemaname = 'storage' and tablename = 'objects'
             and policyname = 'maintenance-photos org write'),
  'org-prefix INSERT policy exists');

select * from finish();
rollback;
```

- [ ] **Step 2: Run to verify it fails.**

Run: `supabase db reset && supabase test db`
Expected: 0315 test FAILS (bucket row absent).

- [ ] **Step 3: Write the migration** — `supabase/migrations/0315_maintenance_photos_bucket.sql`:

```sql
-- 0315_maintenance_photos_bucket.sql
-- Private bucket for maintenance request photos.
--
-- Path scheme: {organization_id}/{maintenance_request_id}/{uuid}.{ext}
--              {organization_id}/{maintenance_request_id}/{uuid}-thumb.webp
--
-- Uploads are SERVER-MINTED (signed upload URLs from the attachments service,
-- which is where rate limiting + entity checks live); the INSERT policy below
-- is the defense-in-depth backstop keyed on the org prefix. There is NO select
-- policy: every read is a short-lived signed URL minted server-side after an
-- RLS-visible parent check. HEIC is deliberately NOT in allowed_mime_types —
-- both platforms transcode to JPEG client-side before upload (the
-- order-attachments bucket accepts raw HEIC and produced unrenderable
-- originals; we do not repeat that).

insert into storage.buckets (id, name, public, allowed_mime_types, file_size_limit)
values (
  'maintenance-photos', 'maintenance-photos', false,
  array['image/png','image/jpeg','image/webp'],
  10 * 1024 * 1024
)
on conflict (id) do nothing;

drop policy if exists "maintenance-photos org write" on storage.objects;

-- Org-prefix write, with the 0312 INLINE disabled-account guard:
-- account_is_disabled() is EXECUTE-revoked from `authenticated`, so only the
-- inlined not-exists form works inside a storage policy.
create policy "maintenance-photos org write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'maintenance-photos'
    and (storage.foldername(name))[1]::uuid in (
      select organization_id from public.organization_members
       where user_id = auth.uid() and accepted_at is not null
    )
    and not exists (
      select 1 from public.user_profiles up
       where up.id = auth.uid() and up.disabled_at is not null
    )
  );
```

- [ ] **Step 4: Run to verify it passes.**

Run: `supabase db reset && supabase test db`
Expected: ALL pgTAP files pass, 0315 4/4.

- [ ] **Step 5: Commit.**

```bash
git add supabase/migrations/0315_maintenance_photos_bucket.sql \
        supabase/tests/0315_maintenance_photos_bucket.test.sql
git commit -m "feat(maintenance): migration 0315 - private maintenance-photos bucket"
```

## Task 3: Core registry + permissions TS (the SQL mirror's other half)

**Files:**
- Modify: `packages/core/src/modules/registry.ts` (ModuleId union + entry)
- Modify: `packages/core/src/modules/registry.test.ts` (EXPO_ROUTES + entry pins)
- Modify: `packages/core/src/constants/permissions.ts` (4 perms, roles, grantable, meta)
- Modify: `packages/core/src/constants/permissions.test.ts` (literal pins)

**Interfaces:**
- Consumes: `Permission`, `ModuleDefinition`, `ROLE_PERMISSIONS`, `FULLY_GRANTABLE_PERMISSIONS`, `PERMISSION_META` shapes exactly as they exist.
- Produces: `ModuleId` includes `'maintenance_requests'`; `Permission` includes the 4 strings `'maintenance_requests:submit' | 'maintenance_requests:read_all' | 'maintenance_requests:manage' | 'maintenance_requests:configure'` — every later task's `can()`/`assertPermission`/`requiresAnyOf` uses these EXACT strings. Web nav href `/dashboard/maintenance`; mobile drawer href `/maintenance`.

- [ ] **Step 1: Write the failing tests.** Append to `packages/core/src/modules/registry.test.ts` (inside the existing describe):

```ts
describe('maintenance_requests module', () => {
  it('is registered as an off-by-default optional module (the zendesk shape)', () => {
    const def = MODULE_REGISTRY.maintenance_requests;
    expect(def.tier).toBe('optional');
    expect(def.defaultOnFor).toEqual([]);
    expect(def.surfaces).toEqual(['web', 'mobile', 'api']);
    expect(def.apiPrefixes).toContain('/api/v1/maintenance-requests');
  });

  it('never enters the default module set (landmine 22)', () => {
    expect(DEFAULT_MODULE_IDS).not.toContain('maintenance_requests');
  });

  it('nav placements gate on requiresAnyOf so read_all-only users still see it', () => {
    const def = MODULE_REGISTRY.maintenance_requests;
    const web = def.placements.find((p) => p.surface === 'web_sidebar');
    const mob = def.placements.find((p) => p.surface === 'mobile_drawer');
    // LITERAL pins (Global Constraint 19): the strings, not the constants.
    expect(web?.href).toBe('/dashboard/maintenance');
    expect(mob?.href).toBe('/maintenance');
    for (const p of [web, mob]) {
      expect(p?.requiresAnyOf).toEqual([
        'maintenance_requests:submit',
        'maintenance_requests:read_all',
        'maintenance_requests:manage',
      ]);
    }
  });
});
```

Also add `'/maintenance'` to the `EXPO_ROUTES` set in the "every mobile drawer href resolves to a real Expo route" test (registry.test.ts:137-145). NOTE: this makes Phase E's `(drawer)/maintenance.tsx` screen a HARD ship-dependency — the sports module shipped a dead tap exactly here; Task 24's gate re-verifies the screen file exists.

Append to `packages/core/src/constants/permissions.test.ts`:

```ts
describe('maintenance permissions', () => {
  const FOUR = [
    'maintenance_requests:submit',
    'maintenance_requests:read_all',
    'maintenance_requests:manage',
    'maintenance_requests:configure',
  ] as const;

  it('registers exactly the four maintenance permission strings (literal pins)', () => {
    for (const p of FOUR) expect(PERMISSIONS).toContain(p);
  });

  it('role defaults mirror migration 0314 exactly (8 seeded rows)', () => {
    expect(ROLE_PERMISSIONS.viewer).toContain('maintenance_requests:submit');
    expect(ROLE_PERMISSIONS.staff).toContain('maintenance_requests:submit');
    expect(ROLE_PERMISSIONS.manager).toContain('maintenance_requests:submit');
    expect(ROLE_PERMISSIONS.manager).toContain('maintenance_requests:read_all');
    expect(ROLE_PERMISSIONS.manager).toContain('maintenance_requests:manage');
    expect(ROLE_PERMISSIONS.admin).toContain('maintenance_requests:read_all');
    expect(ROLE_PERMISSIONS.admin).toContain('maintenance_requests:manage');
    // staff/viewer never see all requests or manage them by default:
    expect(ROLE_PERMISSIONS.staff).not.toContain('maintenance_requests:read_all');
    expect(ROLE_PERMISSIONS.viewer).not.toContain('maintenance_requests:read_all');
  });

  it('configure is owner-only: admin does NOT derive it (controller adjudication C2)', () => {
    expect(ROLE_PERMISSIONS.admin).not.toContain('maintenance_requests:configure');
    expect(effectivePermissions('owner').has('maintenance_requests:configure')).toBe(true);
    expect(effectivePermissions('admin').has('maintenance_requests:configure')).toBe(false);
  });

  it('submit/read_all/manage are fully grantable; configure is not', () => {
    expect(FULLY_GRANTABLE_PERMISSIONS.has('maintenance_requests:submit')).toBe(true);
    expect(FULLY_GRANTABLE_PERMISSIONS.has('maintenance_requests:read_all')).toBe(true);
    expect(FULLY_GRANTABLE_PERMISSIONS.has('maintenance_requests:manage')).toBe(true);
    expect(FULLY_GRANTABLE_PERMISSIONS.has('maintenance_requests:configure')).toBe(false);
  });

  it('every maintenance permission has meta in the Maintenance group', () => {
    for (const p of FOUR) expect(PERMISSION_META[p].group).toBe('Maintenance');
  });
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `pnpm --filter @stockpilot/core test`
Expected: FAIL — `maintenance_requests` not in MODULE_REGISTRY; `'maintenance_requests:submit'` not in PERMISSIONS (TS compile errors count as the failure here; record the real text).

- [ ] **Step 3: Implement.** In `packages/core/src/constants/permissions.ts`:

(a) Append to `PERMISSIONS` (before the closing `] as const;`):

```ts
  // Maintenance requests (maintenance_requests module — L4L only for now).
  // submit: create + view own + reopen own draft + add photos pre-archive.
  // read_all: see every request in the org (NOT internal notes, NOT config).
  // manage: assign a local StockPilot owner, internal notes, archive/correct.
  //   "Local owner" is a STOCKPILOT coordinator — never a Zendesk assignee.
  // configure: owner-only (filtered from admin below) — access grants,
  //   categories, notification audiences, share-link-in-email toggle.
  'maintenance_requests:submit',
  'maintenance_requests:read_all',
  'maintenance_requests:manage',
  'maintenance_requests:configure',
```

(b) Change the admin derivation:

```ts
  admin: ALL_PERMISSIONS.filter(
    (p) => p !== 'billing:manage' && p !== 'maintenance_requests:configure',
  ),
```

(c) Append to `manager`: `'maintenance_requests:submit', 'maintenance_requests:read_all', 'maintenance_requests:manage',` — to `staff`: `'maintenance_requests:submit',` — to `viewer`: `'maintenance_requests:submit',`.

(d) Append to `FULLY_GRANTABLE_PERMISSIONS` (RLS is has_permission-based from day one, mirroring the sports/public_links comments):

```ts
  // Maintenance requests (mig 0314) — RLS is has_permission-based from day
  // one, so grants are fully effective end-to-end. configure stays out:
  // owner-only by design (C2), not a rollout gap.
  'maintenance_requests:submit',
  'maintenance_requests:read_all',
  'maintenance_requests:manage',
```

(e) Append to `PERMISSION_META`:

```ts
  'maintenance_requests:submit': {
    group: 'Maintenance',
    label: 'Submit maintenance requests',
    description: 'Create maintenance requests, view own requests and photos, reopen the email draft.',
  },
  'maintenance_requests:read_all': {
    group: 'Maintenance',
    label: 'View all maintenance requests',
    description: 'See every maintenance request in the organization, with search and filters.',
  },
  'maintenance_requests:manage': {
    group: 'Maintenance',
    label: 'Manage maintenance requests',
    description: 'Assign a StockPilot owner, add internal notes, archive or correct requests.',
  },
  'maintenance_requests:configure': {
    group: 'Maintenance',
    label: 'Configure maintenance requests',
    description: 'Owner only: access grants, categories, notification audiences, share-link settings.',
  },
```

In `packages/core/src/modules/registry.ts`: add `| 'maintenance_requests'` to the `ModuleId` union, and add the entry after `zendesk`:

```ts
  maintenance_requests: {
    id: 'maintenance_requests',
    tier: 'optional',
    title: 'Maintenance requests',
    dependsOn: [],
    permissions: [
      'maintenance_requests:submit',
      'maintenance_requests:read_all',
      'maintenance_requests:manage',
      'maintenance_requests:configure',
    ],
    surfaces: ['web', 'mobile', 'api'],
    apiPrefixes: ['/api/v1/maintenance-requests'],
    ownsTables: [
      'maintenance_requests',
      'maintenance_request_attachments',
      'maintenance_request_notes',
      'maintenance_request_share_links',
    ],
    defaultOnFor: [],
    placements: [
      { surface: 'web_sidebar', section: 'workspace', label: 'Maintenance', href: '/dashboard/maintenance', iconName: 'Wrench', defaultSortOrder: 850, requiresAnyOf: ['maintenance_requests:submit', 'maintenance_requests:read_all', 'maintenance_requests:manage'] },
      { surface: 'mobile_drawer', section: 'workspace', label: 'Maintenance', href: '/maintenance', iconName: 'Wrench', defaultSortOrder: 850, requiresAnyOf: ['maintenance_requests:submit', 'maintenance_requests:read_all', 'maintenance_requests:manage'] },
    ],
  },
```

- [ ] **Step 4: Run to verify pass.**

Run: `pnpm --filter @stockpilot/core test && pnpm --filter web typecheck && pnpm --filter web test`
Expected: core suite PASSES (new + existing, including the 0207-parity-shaped permission tests); web typecheck/test stay green (the union widened — nothing narrows).

- [ ] **Step 5: Commit.**

```bash
git add packages/core/src/modules/registry.ts packages/core/src/modules/registry.test.ts \
        packages/core/src/constants/permissions.ts packages/core/src/constants/permissions.test.ts
git commit -m "feat(maintenance): register maintenance_requests module and four permissions"
```

---

# Phase B — The shared compose utility and the pure maintenance email builder

All pure TS in `packages/core`. Independently testable: `pnpm --filter @stockpilot/core test` green, the four delivery pinning suites green and untouched.

## Task 4: `packages/core/src/email/outlook-compose.ts` — the extracted transport

**Files:**
- Create: `packages/core/src/email/outlook-compose.ts`
- Create: `packages/core/src/email/outlook-compose.test.ts`
- Modify: `packages/core/src/index.ts` (export the new module from the barrel)

**Interfaces:**
- Consumes: nothing (pure, dependency-free).
- Produces (Tasks 5, 7, 14, 20 consume these EXACT names):
  - `OUTLOOK_COMPOSE_BASE: string`, `DRAFT_URL_LIMIT: number`
  - `encodeDraftQuery(params: Record<string, string>): string`
  - `interface ComposeInput { to: string; cc?: string; subject: string; body: string; toName?: string; ccName?: string }`
  - `interface ComposedEmail { to: string; cc?: string; subject: string; body: string; outlookWebUrl: string; mailtoUrl: string; clipboardText: string }`
  - `composeOutlookWebUrl(input: ComposeInput): string`
  - `composeMailtoUrl(input: Pick<ComposeInput, 'to' | 'cc' | 'subject' | 'body'>): string`
  - `composeClipboardText(input: Pick<ComposeInput, 'to' | 'cc' | 'subject' | 'body'>): string`
  - `createOutlookComposeEmail(input: ComposeInput): ComposedEmail` (the Brief §30 shape — `outlookWebUrl`/`mailtoUrl`/`clipboardText` keys exactly)
  - `assertSafeDisplayName(name: string): string` (throws on RFC 5322 specials)

- [ ] **Step 1: Write the failing tests** — `packages/core/src/email/outlook-compose.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  OUTLOOK_COMPOSE_BASE,
  DRAFT_URL_LIMIT,
  encodeDraftQuery,
  composeOutlookWebUrl,
  composeMailtoUrl,
  composeClipboardText,
  createOutlookComposeEmail,
  assertSafeDisplayName,
} from './outlook-compose';

/** Reference two-step decode. mailto: is an opaque-path scheme — slice at the
 *  first '?', never new URL().searchParams. */
function decodeCompose(url: string): { to: string; params: Record<string, string> } {
  const outerQuery = url.slice(url.indexOf('?') + 1);
  const mailtouri = outerQuery
    .split('&')
    .map((p) => p.split('='))
    .find(([k]) => k === 'mailtouri')?.[1];
  if (!mailtouri) throw new Error('no mailtouri param');
  const inner = decodeURIComponent(mailtouri);
  const q = inner.indexOf('?');
  const to = decodeURIComponent(inner.slice('mailto:'.length, q === -1 ? undefined : q));
  const params: Record<string, string> = {};
  if (q !== -1) {
    for (const pair of inner.slice(q + 1).split('&')) {
      const eq = pair.indexOf('=');
      params[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
    }
  }
  return { to, params };
}

const BASE_INPUT = {
  to: 'to@example.test',
  cc: 'cc@example.test',
  subject: 'Subject with spaces & specials',
  body: 'Line one\nLine two',
} as const;

describe('outlook-compose transport', () => {
  it('pins the tenant-verified compose base (LITERAL — never office.com)', () => {
    expect(OUTLOOK_COMPOSE_BASE).toBe('https://outlook.cloud.microsoft/mail/deeplink/compose');
    expect(OUTLOOK_COMPOSE_BASE).not.toContain('outlook.office.com');
    expect(DRAFT_URL_LIMIT).toBe(1800);
  });

  it('encodeDraftQuery uses %20, never +, never URLSearchParams form-encoding', () => {
    const q = encodeDraftQuery({ subject: 'a b', body: 'c d' });
    expect(q).toBe('subject=a%20b&body=c%20d');
    expect(q).not.toContain('+');
  });

  it('outlook URL is ONE mailtouri param; plain to=/cc=/subject=/body= are ABSENT', () => {
    const url = composeOutlookWebUrl(BASE_INPUT);
    expect(url.startsWith(`${OUTLOOK_COMPOSE_BASE}?mailtouri=`)).toBe(true);
    const outer = url.slice(url.indexOf('?') + 1);
    for (const k of ['to=', 'cc=', 'subject=', 'body=']) {
      expect(outer.split('&').some((p) => p.startsWith(k))).toBe(false);
    }
  });

  it('two encoding layers exactly: decode recovers the original values', () => {
    const { to, params } = decodeCompose(composeOutlookWebUrl(BASE_INPUT));
    expect(to).toBe('to@example.test');
    expect(params.cc).toBe('cc@example.test');
    expect(params.subject).toBe('Subject with spaces & specials');
    expect(params.body).toBe('Line one\nLine two');
  });

  it('display names ride as name-addr chips in the OWA url ONLY', () => {
    const url = composeOutlookWebUrl({ ...BASE_INPUT, toName: 'To Name', ccName: 'Cc Name' });
    const { to, params } = decodeCompose(url);
    expect(to).toBe('To Name <to@example.test>');
    expect(params.cc).toBe('Cc Name <cc@example.test>');
    // mailto + clipboard stay BARE-ADDRESS (OWA parser extension does not travel):
    expect(composeMailtoUrl(BASE_INPUT)).toBe(
      'mailto:to@example.test?cc=cc%40example.test&subject=Subject%20with%20spaces%20%26%20specials&body=Line%20one%0ALine%20two',
    );
    expect(composeClipboardText(BASE_INPUT)).toContain('TO: to@example.test');
    expect(composeClipboardText(BASE_INPUT)).not.toContain('To Name');
  });

  it('cc is OPTIONAL: omitted cc emits no cc param and no CC clipboard line', () => {
    const noCc = { to: 'to@example.test', subject: 'S', body: 'B' };
    const { params } = decodeCompose(composeOutlookWebUrl(noCc));
    expect('cc' in params).toBe(false);
    expect(composeMailtoUrl(noCc)).toBe('mailto:to@example.test?subject=S&body=B');
    expect(composeClipboardText(noCc)).not.toContain('CC:');
  });

  it('clipboard text carries labelled TO/CC/SUBJECT/MESSAGE blocks', () => {
    expect(composeClipboardText(BASE_INPUT)).toBe(
      ['TO: to@example.test', 'CC: cc@example.test', 'SUBJECT: Subject with spaces & specials', '', 'MESSAGE:', 'Line one\nLine two'].join('\n'),
    );
  });

  it('createOutlookComposeEmail returns the Brief section-30 shape', () => {
    const composed = createOutlookComposeEmail(BASE_INPUT);
    expect(composed.to).toBe('to@example.test');
    expect(composed.cc).toBe('cc@example.test');
    expect(composed.outlookWebUrl).toBe(composeOutlookWebUrl(BASE_INPUT));
    expect(composed.mailtoUrl).toBe(composeMailtoUrl(BASE_INPUT));
    expect(composed.clipboardText).toBe(composeClipboardText(BASE_INPUT));
  });

  it('assertSafeDisplayName rejects RFC 5322 specials (a comma splits recipients)', () => {
    expect(assertSafeDisplayName('Fresno Warehouse DC4')).toBe('Fresno Warehouse DC4');
    for (const bad of ['A, B', 'A <B>', 'A "B"', 'A @ B', 'A; B']) {
      expect(() => assertSafeDisplayName(bad)).toThrow();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `pnpm --filter @stockpilot/core test -- outlook-compose`
Expected: FAIL — module `./outlook-compose` does not exist.

- [ ] **Step 3: Implement** — `packages/core/src/email/outlook-compose.ts`:

```ts
/**
 * Shared Outlook Web compose transport — extracted VERBATIM from the
 * delivery-request assistant (apps/web storefront-logic.ts), where every
 * mechanic below was owner-tested against the live L4L Microsoft 365 tenant:
 *
 *  - outlook.cloud.microsoft, never outlook.office.com (2026-08-02: the
 *    office.com domain-migration redirect DROPS the compose path — bare
 *    inbox, no draft). No automated test can catch a host regression; it is
 *    constant-and-comment enforced. DO NOT "update" this URL.
 *  - a single `mailtouri=` param, never plain to=/cc=/subject=/body=
 *    (2026-08-01: OWA silently drops a plain `cc=` — the mandatory CC never
 *    landed).
 *  - %20 encoding via encodeDraftQuery, never URLSearchParams ('+' has no
 *    space meaning in RFC 6068; desktop clients render it literally).
 *  - display names are an OWA-only parser extension in the mailto PATH
 *    position; composeMailtoUrl and composeClipboardText stay BARE-ADDRESS.
 *
 * Plain TS, no server directives — imported by web client components, web
 * server code, and the Expo app (mobile's only workspace dep is
 * @stockpilot/core).
 */

export const OUTLOOK_COMPOSE_BASE = 'https://outlook.cloud.microsoft/mail/deeplink/compose';

/** Conservative compose-link ceiling; both transports truncate SILENTLY past
 *  ~2,000 chars. 1,800 leaves headroom for tenant redirect wrappers. */
export const DRAFT_URL_LIMIT = 1800;

/** %20 for spaces, never '+'. See module doc. */
export function encodeDraftQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
}

/** RFC 5322 specials that would split an UNQUOTED name-addr into two
 *  recipients (silently dropping the mandatory CC). Display names must be
 *  compile-time literals validated through here. */
const UNSAFE_NAME_CHARS = /[<>,"@;]/;

export function assertSafeDisplayName(name: string): string {
  if (UNSAFE_NAME_CHARS.test(name)) {
    throw new Error(
      'Display name contains RFC 5322 specials (< > , " @ ;) and cannot be safely interpolated into a name-addr.',
    );
  }
  return name;
}

export interface ComposeInput {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  /** Cosmetic OWA compose-chip names. Literals only; validated. */
  toName?: string;
  ccName?: string;
}

export interface ComposedEmail {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  outlookWebUrl: string;
  mailtoUrl: string;
  clipboardText: string;
}

/** OWA deep link: `?mailtouri=<encoded inner mailto URI>`. Two encoding
 *  layers exactly — one building the inner URI, one wrapping it. */
export function composeOutlookWebUrl(input: ComposeInput): string {
  const toValue = input.toName
    ? `${assertSafeDisplayName(input.toName)} <${input.to}>`
    : input.to;
  const query: Record<string, string> = {};
  if (input.cc) {
    query.cc = input.ccName
      ? `${assertSafeDisplayName(input.ccName)} <${input.cc}>`
      : input.cc;
  }
  query.subject = input.subject;
  query.body = input.body;
  const innerMailto = `mailto:${encodeURIComponent(toValue)}?${encodeDraftQuery(query)}`;
  return `${OUTLOOK_COMPOSE_BASE}?mailtouri=${encodeURIComponent(innerMailto)}`;
}

/** RFC 6068 mailto fallback. BARE addresses only — the name-addr path trick
 *  is an OWA extension, unverified on desktop clients. Do not extend. */
export function composeMailtoUrl(
  input: Pick<ComposeInput, 'to' | 'cc' | 'subject' | 'body'>,
): string {
  const query: Record<string, string> = {};
  if (input.cc) query.cc = input.cc;
  query.subject = input.subject;
  query.body = input.body;
  return `mailto:${input.to}?${encodeDraftQuery(query)}`;
}

/** Terminal fallback: labelled blocks so the user can rebuild the message by
 *  hand INCLUDING the CC. No URL-length limit — always the full body. */
export function composeClipboardText(
  input: Pick<ComposeInput, 'to' | 'cc' | 'subject' | 'body'>,
): string {
  const lines = [`TO: ${input.to}`];
  if (input.cc) lines.push(`CC: ${input.cc}`);
  lines.push(`SUBJECT: ${input.subject}`, '', 'MESSAGE:', input.body);
  return lines.join('\n');
}

/** The Brief section-30 convenience shape. */
export function createOutlookComposeEmail(input: ComposeInput): ComposedEmail {
  return {
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    body: input.body,
    outlookWebUrl: composeOutlookWebUrl(input),
    mailtoUrl: composeMailtoUrl(input),
    clipboardText: composeClipboardText(input),
  };
}
```

Then add to `packages/core/src/index.ts` (alongside the existing barrel exports):

```ts
export * from './email/outlook-compose';
```

- [ ] **Step 4: Run to verify pass.**

Run: `pnpm --filter @stockpilot/core test -- outlook-compose`
Expected: PASS (all cases above).

- [ ] **Step 5: Commit.**

```bash
git add packages/core/src/email/outlook-compose.ts packages/core/src/email/outlook-compose.test.ts packages/core/src/index.ts
git commit -m "feat(core): shared Outlook compose transport extracted from delivery request"
```

## Task 5: Delivery-request delegating wrappers — four pinning suites stay green, byte-identical

**Files:**
- Modify: `apps/web/src/components/orders/storefront/storefront-logic.ts:550-703` ONLY (the transport block). `buildDeliveryRequestDraft`, `prepareDeliveryRequest`, `DeliveryRequestDraft`, `toPlainTextLine`, and everything else in the file are UNTOUCHED.
- Test gate (NO edits): `storefront-logic.test.ts`, `delivery-request-action.test.tsx`, `site.test.ts`, `storefront-overlays.test.tsx`.

**Interfaces:**
- Consumes: `composeOutlookWebUrl`, `composeMailtoUrl`, `composeClipboardText`, `OUTLOOK_COMPOSE_BASE`, `DRAFT_URL_LIMIT` from `@stockpilot/core` (Task 4).
- Produces: the SAME exports `storefront-logic.ts` has today — `OUTLOOK_COMPOSE_BASE`, `DRAFT_URL_LIMIT`, `buildOutlookComposeUrl(draft)`, `buildMailtoUrl(draft)`, `buildClipboardText(draft)` — with byte-identical output for every input.

- [ ] **Step 1: Run the four pinning suites FIRST and record the pass counts** (the baseline you must return to):

Run: `pnpm --filter web test -- storefront-logic delivery-request-action site.test storefront-overlays`
Expected: PASS. Record the exact test counts.

- [ ] **Step 2: Replace the transport block with wrappers.** In `storefront-logic.ts`, delete the local `OUTLOOK_COMPOSE_BASE`, `DRAFT_URL_LIMIT`, and `encodeDraftQuery` definitions and the bodies of the three builders (KEEP every doc comment — they carry the tenant-test history; move them onto the wrappers), and write:

```ts
import {
  OUTLOOK_COMPOSE_BASE as CORE_OUTLOOK_COMPOSE_BASE,
  DRAFT_URL_LIMIT as CORE_DRAFT_URL_LIMIT,
  composeOutlookWebUrl,
  composeMailtoUrl,
  composeClipboardText,
} from '@stockpilot/core';

// Transport EXTRACTED to packages/core/src/email/outlook-compose.ts
// (2026-08-05, maintenance-requests program) so mobile can compose too.
// These re-exports + wrappers keep this module's public surface and BYTES
// OUT identical — the four pinning suites run against them unchanged.
export const OUTLOOK_COMPOSE_BASE = CORE_OUTLOOK_COMPOSE_BASE;
export const DRAFT_URL_LIMIT = CORE_DRAFT_URL_LIMIT;

export function buildOutlookComposeUrl(draft: DeliveryRequestDraft): string {
  return composeOutlookWebUrl({
    to: draft.to,
    cc: draft.cc,
    subject: draft.subject,
    body: draft.body,
    toName: DELIVERY_REQUEST_EMAIL_NAMES.to,
    ccName: DELIVERY_REQUEST_EMAIL_NAMES.cc,
  });
}

export function buildMailtoUrl(draft: DeliveryRequestDraft): string {
  return composeMailtoUrl({ to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body });
}

export function buildClipboardText(draft: DeliveryRequestDraft): string {
  return composeClipboardText({ to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body });
}
```

`prepareDeliveryRequest` and `buildDeliveryRequestDraft` remain EXACTLY as they are (they call the three names above, which still exist). The domain builder still takes NO recipient argument (pinned by storefront-logic.test.ts:536-554).

WHY the bytes are identical, argued once so the executor does not re-derive it: the core builders emit `cc, subject, body` in that key order (same as today's `encodeDraftQuery` call sites), the inner mailto shape is `mailto:<enc name-addr>?<query>` (same), and with `cc` always present for delivery the optional-cc branch never changes output.

- [ ] **Step 3: Run the four pinning suites again — ZERO edits to them, same counts as Step 1.**

Run: `pnpm --filter web test -- storefront-logic delivery-request-action site.test storefront-overlays`
Expected: PASS with the SAME test counts recorded in Step 1. If ANY assertion fails, the wrapper changed bytes — fix the wrapper, never the test.

- [ ] **Step 4: Full web suite + typecheck.**

Run: `pnpm --filter web test && pnpm --filter web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/components/orders/storefront/storefront-logic.ts
git commit -m "refactor(orders): delivery compose delegates to the shared core transport"
```

## Task 6: Maintenance constants, MR number formatter, sanitizers, form schema

**Files:**
- Create: `packages/core/src/maintenance/constants.ts`
- Create: `packages/core/src/maintenance/mr-number.ts`
- Create: `packages/core/src/maintenance/text.ts`
- Create: `packages/core/src/schemas/maintenance.ts`
- Create: `packages/core/src/maintenance/constants.test.ts`, `mr-number.test.ts`, `text.test.ts`
- Modify: `packages/core/src/index.ts` (barrel)

**Interfaces:**
- Produces (consumed by Tasks 7-21):
  - `L4L_MAINTENANCE_EMAIL: Readonly<{ to: 'dc4@learn4life.org'; cc: 'arosas@cvwest.org' }>`
  - `L4L_MAINTENANCE_EMAIL_NAMES: Readonly<{ to: 'Fresno Warehouse DC4'; cc: 'Andrew Rosas' }>`
  - `MAINTENANCE_CC_NOTICE: string`
  - `MAINTENANCE_CATEGORIES: readonly string[]` (the Brief §7 twelve)
  - `MAINTENANCE_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const` + `MaintenancePriority`
  - `MaintenanceStatus = 'saved' | 'draft_opened' | 'archived' | 'cancelled'`
  - `MAINTENANCE_STATUS_LABELS: Record<MaintenanceStatus, string>` = `Saved / Email draft opened / Archived / Cancelled`
  - `MAINTENANCE_MAX_PHOTOS = 8`, `MAINTENANCE_MAX_PHOTO_BYTES = 10 * 1024 * 1024`, `MAINTENANCE_SHARE_LINK_TTL_DAYS = 180`
  - `formatMaintenanceRequestNumber(n, createdAt): string | null` → `'MR-2026-000123'`
  - `parseMaintenanceRequestNumber(handle: string): number | null`
  - `sanitizeSubjectLine(value: string): string` (collapsing), `sanitizeDescriptionBlock(value: string): string` (newline-preserving)
  - `maintenanceRequestFormSchema` (zod) + `MaintenanceRequestFormValues`

- [ ] **Step 1: Write the failing tests.** `packages/core/src/maintenance/mr-number.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatMaintenanceRequestNumber, parseMaintenanceRequestNumber } from './mr-number';

describe('formatMaintenanceRequestNumber', () => {
  it('formats MR-<year>-<6-pad> with the year COSMETIC from created_at', () => {
    expect(formatMaintenanceRequestNumber(123, '2026-08-05T16:15:00Z')).toBe('MR-2026-000123');
    // Counter does NOT reset per year — same number, later year, still valid:
    expect(formatMaintenanceRequestNumber(123, '2027-01-02T00:00:00Z')).toBe('MR-2027-000123');
  });
  it('returns null for missing/invalid input, never a fake handle', () => {
    expect(formatMaintenanceRequestNumber(null, '2026-08-05T00:00:00Z')).toBeNull();
    expect(formatMaintenanceRequestNumber(0, '2026-08-05T00:00:00Z')).toBeNull();
    expect(formatMaintenanceRequestNumber(5, 'not-a-date')).toBeNull();
  });
});

describe('parseMaintenanceRequestNumber', () => {
  it('parses typed handles back to the bigint for search', () => {
    expect(parseMaintenanceRequestNumber('MR-2026-000123')).toBe(123);
    expect(parseMaintenanceRequestNumber('mr-2026-123')).toBe(123);
    expect(parseMaintenanceRequestNumber('MR-000123')).toBe(123);
    expect(parseMaintenanceRequestNumber('123')).toBe(123);
  });
  it('rejects non-handles', () => {
    expect(parseMaintenanceRequestNumber('SO-000049')).toBeNull();
    expect(parseMaintenanceRequestNumber('hello')).toBeNull();
    expect(parseMaintenanceRequestNumber('')).toBeNull();
  });
});
```

`packages/core/src/maintenance/text.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { sanitizeSubjectLine, sanitizeDescriptionBlock } from './text';

describe('sanitizeSubjectLine (collapsing — subjects ONLY)', () => {
  it('strips C0 + DEL and collapses all whitespace including newlines', () => {
    expect(sanitizeSubjectLine('  AC broken\r\nin Room\t204  ')).toBe('AC broken in Room 204');
  });
});

describe('sanitizeDescriptionBlock (newline-PRESERVING — audit Q14)', () => {
  it('preserves intentional line breaks', () => {
    expect(sanitizeDescriptionBlock('Line one\nLine two')).toBe('Line one\nLine two');
  });
  it('normalizes CRLF and strips other C0 controls + DEL', () => {
    expect(sanitizeDescriptionBlock('a\r\nb\u0007c\u007Fd')).toBe('a\nbcd');
  });
  it('caps consecutive newlines at two', () => {
    expect(sanitizeDescriptionBlock('a\n\n\n\n\nb')).toBe('a\n\nb');
  });
  it('trims outer whitespace only', () => {
    expect(sanitizeDescriptionBlock('\n\n  hello\nworld  \n\n')).toBe('hello\nworld');
  });
});
```

`packages/core/src/maintenance/constants.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  L4L_MAINTENANCE_EMAIL,
  L4L_MAINTENANCE_EMAIL_NAMES,
  MAINTENANCE_CC_NOTICE,
  MAINTENANCE_CATEGORIES,
  MAINTENANCE_PRIORITIES,
  MAINTENANCE_STATUS_LABELS,
  MAINTENANCE_MAX_PHOTOS,
  MAINTENANCE_MAX_PHOTO_BYTES,
  MAINTENANCE_SHARE_LINK_TTL_DAYS,
} from './constants';

describe('maintenance recipient constants', () => {
  it('pins the exact addresses (LITERALS — Global Constraint 19)', () => {
    expect(L4L_MAINTENANCE_EMAIL.to).toBe('dc4@learn4life.org');
    expect(L4L_MAINTENANCE_EMAIL.cc).toBe('arosas@cvwest.org');
    expect(Object.isFrozen(L4L_MAINTENANCE_EMAIL)).toBe(true);
  });
  it('display names are free of RFC 5322 specials', () => {
    for (const name of Object.values(L4L_MAINTENANCE_EMAIL_NAMES)) {
      expect(name).not.toMatch(/[<>,"@;]/);
    }
    expect(Object.isFrozen(L4L_MAINTENANCE_EMAIL_NAMES)).toBe(true);
  });
  it('CC notice promises only what StockPilot can observe', () => {
    expect(MAINTENANCE_CC_NOTICE).toBe(
      'The DC4 address creates the maintenance ticket in the email system. A copy will also be sent to arosas@cvwest.org.',
    );
    for (const banned of ['assigned', 'Ticket created', 'notified']) {
      expect(MAINTENANCE_CC_NOTICE).not.toContain(banned);
    }
  });
});

describe('status labels — the ONLY four states (brief section 20)', () => {
  it('pins the exact display strings', () => {
    expect(MAINTENANCE_STATUS_LABELS).toEqual({
      saved: 'Saved',
      draft_opened: 'Email draft opened',
      archived: 'Archived',
      cancelled: 'Cancelled',
    });
  });
});

describe('form option constants', () => {
  it('the twelve Brief section-7 categories, in order', () => {
    expect(MAINTENANCE_CATEGORIES).toEqual([
      'Facilities', 'Electrical', 'Plumbing', 'Heating or air conditioning',
      'Technology', 'Furniture', 'Vehicle', 'Security', 'Safety', 'Cleaning',
      'Inventory or equipment', 'Other',
    ]);
  });
  it('priorities and caps', () => {
    expect(MAINTENANCE_PRIORITIES).toEqual(['low', 'normal', 'high', 'urgent']);
    expect(MAINTENANCE_MAX_PHOTOS).toBe(8);
    expect(MAINTENANCE_MAX_PHOTO_BYTES).toBe(10 * 1024 * 1024);
    expect(MAINTENANCE_SHARE_LINK_TTL_DAYS).toBe(180);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `pnpm --filter @stockpilot/core test -- maintenance`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement.** `packages/core/src/maintenance/constants.ts`:

```ts
/**
 * Maintenance-request constants. The recipients are COMPILE-TIME LITERALS on
 * purpose (the delivery-request security posture, lib/site.ts:33-46): never
 * read from URL params, localStorage, form fields, request descriptions,
 * related-item data, or client API values. The email builder takes NO
 * recipient argument — it reads this object — so there is no parameter for a
 * caller to poison. Frozen so a stray assignment throws in strict mode.
 *
 * These are REAL addresses: dc4@learn4life.org feeds a live Zendesk email
 * intake and arosas@cvwest.org is a real person. No test, tool, or
 * verification step may ever open a compose window or navigate a mailto
 * against them — string assertions only (plan Global Constraint 2).
 */
export const L4L_MAINTENANCE_EMAIL = Object.freeze({
  to: 'dc4@learn4life.org',
  cc: 'arosas@cvwest.org',
} as const);

/** Cosmetic OWA chip names — same values the delivery assistant verified on
 *  the live tenant. Must stay free of RFC 5322 specials (< > , " @ ;). */
export const L4L_MAINTENANCE_EMAIL_NAMES = Object.freeze({
  to: 'Fresno Warehouse DC4',
  cc: 'Andrew Rosas',
} as const);

/** Accuracy, not optimism: no "assigned", no "ticket created", no "notified". */
export const MAINTENANCE_CC_NOTICE =
  'The DC4 address creates the maintenance ticket in the email system. A copy will also be sent to arosas@cvwest.org.';

export const MAINTENANCE_CATEGORIES = [
  'Facilities', 'Electrical', 'Plumbing', 'Heating or air conditioning',
  'Technology', 'Furniture', 'Vehicle', 'Security', 'Safety', 'Cleaning',
  'Inventory or equipment', 'Other',
] as const;

export const MAINTENANCE_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type MaintenancePriority = (typeof MAINTENANCE_PRIORITIES)[number];

export type MaintenanceStatus = 'saved' | 'draft_opened' | 'archived' | 'cancelled';

/** The ONLY status vocabulary (brief section 20). Never 'sent', never
 *  'ticket created' — StockPilot cannot observe either. */
export const MAINTENANCE_STATUS_LABELS: Record<MaintenanceStatus, string> = {
  saved: 'Saved',
  draft_opened: 'Email draft opened',
  archived: 'Archived',
  cancelled: 'Cancelled',
};

export const MAINTENANCE_MAX_PHOTOS = 8;
export const MAINTENANCE_MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const MAINTENANCE_SHARE_LINK_TTL_DAYS = 180;
```

`packages/core/src/maintenance/mr-number.ts`:

```ts
/**
 * Display format for maintenance request numbers, beside formatOrderNumber.
 * request_number is a single per-org bigint (0314 advisory-lock trigger);
 * the YEAR IS COSMETIC — derived from created_at at format time, never part
 * of the counter, never stored (audit Q4). The display string never exists
 * in the database, so search parses the handle back to the bigint.
 */
export function formatMaintenanceRequestNumber(
  n: number | null | undefined,
  createdAt: string | Date | null | undefined,
): string | null {
  if (!n || n <= 0) return null;
  const d = createdAt instanceof Date ? createdAt : createdAt ? new Date(createdAt) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return `MR-${d.getUTCFullYear()}-${String(n).padStart(6, '0')}`;
}

/** 'MR-2026-000123' | 'MR-000123' | '123' -> 123. Anything else -> null. */
export function parseMaintenanceRequestNumber(handle: string): number | null {
  const m = handle.trim().match(/^(?:mr-?(?:\d{4}-)?)?0*(\d{1,12})$/i);
  if (!m || !m[1]) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
```

`packages/core/src/maintenance/text.ts`:

```ts
/**
 * Client-safe plain-text sanitizers for maintenance email building.
 *
 * sanitizeSubjectLine is the collapsing variant (the toPlainTextLine
 * semantics from storefront-logic.ts:272-275): correct for SUBJECTS, where a
 * newline could forge a header-looking line.
 *
 * sanitizeDescriptionBlock is the NEW newline-PRESERVING variant (audit
 * Q14): the description's intentional line breaks are content (brief
 * section 7) and the collapsing variant would destroy them. C1 passthrough
 * is a documented scope boundary — every egress is percent-encoded.
 */
export function sanitizeSubjectLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function sanitizeDescriptionBlock(value: string): string {
  return (
    value
      .replace(/\r\n?/g, '\n')
      // C0 controls EXCEPT the newline itself, plus DEL:
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}
```

`packages/core/src/schemas/maintenance.ts`:

```ts
import { z } from 'zod';

import { MAINTENANCE_PRIORITIES } from '../maintenance/constants';

/** Shared by the web RHF form, the mobile form, and BOTH server create
 *  paths (server action + /api/v1). The server is the authority — it
 *  re-parses with this same schema and then snapshots requester identity
 *  from the SESSION, never from these values. */
export const maintenanceRequestFormSchema = z.object({
  subject: z
    .string()
    .trim()
    .min(5, 'Describe the issue in a few words (at least 5 characters).')
    .max(120, 'Keep the subject under 120 characters.')
    .refine((v) => /[\p{L}\p{N}]{3,}/u.test(v.replace(/\s/g, '')), 'Add a few words describing the issue.')
    .refine((v) => !/[\r\n]/.test(v), 'The subject cannot contain line breaks.'),
  description: z
    .string()
    .trim()
    .min(10, 'Explain what is happening so the maintenance team can prepare.')
    .max(5000, 'Keep the description under 5,000 characters.'),
  category: z.string().trim().max(80).nullish(),
  priority: z.enum(MAINTENANCE_PRIORITIES).default('normal'),
  charterId: z.string().uuid().nullish(),
  warehouseId: z.string().uuid().nullish(),
  building: z.string().trim().max(200).nullish(),
  roomOrArea: z.string().trim().max(200).nullish(),
  department: z.string().trim().max(200).nullish(),
  accessInstructions: z.string().trim().max(2000).nullish(),
  requesterPhone: z.string().trim().max(40).nullish(),
  relatedItemId: z.string().uuid().nullish(),
  relatedOrderRequestId: z.string().uuid().nullish(),
  relatedRentalId: z.string().uuid().nullish(),
  relatedLocationId: z.string().uuid().nullish(),
});

export type MaintenanceRequestFormValues = z.infer<typeof maintenanceRequestFormSchema>;
```

Barrel: add to `packages/core/src/index.ts`:

```ts
export * from './maintenance/constants';
export * from './maintenance/mr-number';
export * from './maintenance/text';
export * from './schemas/maintenance';
```

- [ ] **Step 4: Run to verify pass.**

Run: `pnpm --filter @stockpilot/core test -- maintenance`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/core/src/maintenance packages/core/src/schemas/maintenance.ts packages/core/src/index.ts
git commit -m "feat(core): maintenance constants, MR number formatter, sanitizers, form schema"
```

## Task 7: `createMaintenanceRequestEmail` — the pure builder, condense policy, fit measurement

**Files:**
- Create: `packages/core/src/maintenance/email.ts`
- Create: `packages/core/src/maintenance/email.test.ts`
- Modify: `packages/core/src/index.ts` (barrel)

**Interfaces:**
- Consumes: Task 4 transport (`composeOutlookWebUrl`, `composeMailtoUrl`, `composeClipboardText`, `DRAFT_URL_LIMIT`), Task 6 constants + sanitizers. The `requestNumber` field is the ALREADY-FORMATTED handle from `formatMaintenanceRequestNumber`.
- Produces (Tasks 8, 14, 20 consume these EXACT shapes):
  - `interface MaintenanceEmailInput` (fields exactly as in the implementation below — the server assembles it, the clients render from it)
  - `interface MaintenanceEmailDraft { to: string; cc: string; subject: string; body: string; condensed: boolean }`
  - `interface PreparedMaintenanceEmail { draft: MaintenanceEmailDraft; outlookUrl: string; mailtoUrl: string; clipboardText: string; linkFits: boolean }`
  - `MAINTENANCE_CONDENSED_DISCLOSURE: string`
  - `buildMaintenanceEmailDraft(input, opts?: { condensed?: boolean }): MaintenanceEmailDraft`
  - `prepareMaintenanceEmail(input): PreparedMaintenanceEmail`

- [ ] **Step 1: Write the failing tests** — `packages/core/src/maintenance/email.test.ts`. This file IS the Brief §31 email-builder checklist; the 21 numbered cases are tagged `(n)` in test names:

```ts
import { describe, expect, it } from 'vitest';

import {
  buildMaintenanceEmailDraft,
  prepareMaintenanceEmail,
  MAINTENANCE_CONDENSED_DISCLOSURE,
  type MaintenanceEmailInput,
} from './email';
import { OUTLOOK_COMPOSE_BASE, DRAFT_URL_LIMIT } from '../email/outlook-compose';

function decodeCompose(url: string): { to: string; params: Record<string, string> } {
  const outer = url.slice(url.indexOf('?') + 1);
  const mailtouri = outer.split('&').map((p) => p.split('=')).find(([k]) => k === 'mailtouri')?.[1];
  if (!mailtouri) throw new Error('no mailtouri');
  const inner = decodeURIComponent(mailtouri);
  const q = inner.indexOf('?');
  const to = decodeURIComponent(inner.slice('mailto:'.length, q === -1 ? undefined : q));
  const params: Record<string, string> = {};
  if (q !== -1) for (const pair of inner.slice(q + 1).split('&')) {
    const eq = pair.indexOf('=');
    params[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
  }
  return { to, params };
}

const FULL_INPUT: MaintenanceEmailInput = {
  requestNumber: 'MR-2026-000123',
  subject: 'Air conditioner is not working in Room 204',
  description: 'The air conditioner has been blowing warm air since yesterday afternoon.\nThe room is becoming too warm for normal use.',
  category: 'Heating or air conditioning',
  priority: 'high',
  submittedAtDisplay: 'August 5, 2026 at 9:15 AM',
  requesterName: 'Jane Smith',
  requesterEmail: 'jane.smith@learn4life.org',
  requesterPhone: '(555) 555-0199',
  siteName: 'Fresno Learning Center',
  department: 'Operations',
  building: 'Main Building',
  roomOrArea: 'Room 204',
  accessInstructions: 'Please contact the main office before entering the room.',
  relatedItem: { name: 'Wall-mounted HVAC unit', sku: 'HVAC-WALL-204', modelNumber: 'ACX-9000', url: 'https://stockpilotusa.com/dashboard/inventory/11111111-1111-1111-1111-111111111111' },
  relatedOrder: null,
  relatedRental: null,
  photoCount: 3,
  shareUrl: 'https://stockpilotusa.com/m/abcdef1234567890',
};

const MINIMAL_INPUT: MaintenanceEmailInput = {
  requestNumber: 'MR-2026-000007',
  subject: 'Door hinge squeaks badly',
  description: 'The front door hinge squeaks loudly.',
  category: null, priority: 'normal', submittedAtDisplay: 'August 5, 2026 at 9:15 AM',
  requesterName: 'Jane Smith', requesterEmail: null, requesterPhone: null,
  siteName: null, department: null, building: null, roomOrArea: null,
  accessInstructions: null, relatedItem: null, relatedOrder: null, relatedRental: null,
  photoCount: 0, shareUrl: null,
};

describe('buildMaintenanceEmailDraft — recipients and subject', () => {
  const draft = buildMaintenanceEmailDraft(FULL_INPUT);

  it('(1) To is the literal DC4 address; (2) CC is the literal Andrew address', () => {
    expect(draft.to).toBe('dc4@learn4life.org');
    expect(draft.cc).toBe('arosas@cvwest.org');
  });

  it('(3) subject keeps the requester wording; (4) subject includes the request number, never the UUID', () => {
    expect(draft.subject).toBe('[StockPilot Maintenance MR-2026-000123] Air conditioner is not working in Room 204');
  });

  it('avoids duplicated prefixes when the user pastes one in', () => {
    const d = buildMaintenanceEmailDraft({ ...FULL_INPUT, subject: '[StockPilot Maintenance MR-2026-000123] Air conditioner is not working in Room 204' });
    expect(d.subject.match(/\[StockPilot Maintenance/g)?.length).toBe(1);
  });

  it('recipients never appear in the BODY (they enter at the compose layer only)', () => {
    expect(draft.body).not.toContain('dc4@learn4life.org');
    expect(draft.body).not.toContain('arosas@cvwest.org');
  });
});

describe('buildMaintenanceEmailDraft — body blocks', () => {
  const body = buildMaintenanceEmailDraft(FULL_INPUT).body;

  it('(5) description block present with (15) line breaks intact', () => {
    expect(body).toContain('ISSUE DESCRIPTION');
    expect(body).toContain('since yesterday afternoon.\nThe room is becoming too warm');
  });
  it('(6) requester name; (7) site; (8) building and room', () => {
    expect(body).toContain('Name: Jane Smith');
    expect(body).toContain('Site: Fresno Learning Center');
    expect(body).toContain('Building: Main Building');
    expect(body).toContain('Room or Area: Room 204');
  });
  it('(9) related item block with SKU + model number + app link; NO asset-tag line ever (audit Q6)', () => {
    expect(body).toContain('Item: Wall-mounted HVAC unit');
    expect(body).toContain('SKU: HVAC-WALL-204');
    expect(body).toContain('Model Number: ACX-9000');
    expect(body).toContain('StockPilot Item: https://stockpilotusa.com/dashboard/inventory/');
    expect(body).not.toContain('Asset Tag');
  });
  it('(10) related order block renders when provided', () => {
    const withOrder = buildMaintenanceEmailDraft({
      ...MINIMAL_INPUT,
      relatedOrder: { handle: 'SO-000021', requestedFor: 'Room 12 teacher', url: 'https://stockpilotusa.com/dashboard/orders/22222222-2222-2222-2222-222222222222' },
    }).body;
    expect(withOrder).toContain('Order: SO-000021');
    expect(withOrder).toContain('StockPilot Order: https://stockpilotusa.com/dashboard/orders/');
  });
  it('related rental block identifies by borrower + items — never a fake R- handle (audit Q11)', () => {
    const withRental = buildMaintenanceEmailDraft({
      ...MINIMAL_INPUT,
      relatedRental: { itemNames: ['Projector', 'HDMI cable'], borrowerName: 'Sam Lee', url: 'https://stockpilotusa.com/dashboard/rentals/33333333-3333-3333-3333-333333333333' },
    }).body;
    expect(withRental).toContain('Rental of: Projector, HDMI cable');
    expect(withRental).toContain('Borrower: Sam Lee');
    expect(withRental).not.toMatch(/\bR-\d/);
  });
  it('(11) photo count; (12) secure share link when available', () => {
    expect(body).toContain('3 photos were uploaded with this request.');
    expect(body).toContain('View request photos:\nhttps://stockpilotusa.com/m/abcdef1234567890');
    expect(body).toContain('The requester may also attach the photos directly to this email before sending.');
  });
  it('uses singular copy for one photo', () => {
    expect(buildMaintenanceEmailDraft({ ...FULL_INPUT, photoCount: 1 }).body)
      .toContain('1 photo was uploaded with this request.');
  });
  it('(13) photo section omitted entirely when there are no photos', () => {
    const b = buildMaintenanceEmailDraft(MINIMAL_INPUT).body;
    expect(b).not.toContain('PHOTOS');
    expect(b).not.toContain('View request photos');
  });
  it('(17)(18) never renders undefined / null / Invalid Date / [object Object] or empty labels', () => {
    const b = buildMaintenanceEmailDraft(MINIMAL_INPUT).body;
    expect(b).not.toContain('undefined');
    expect(b).not.toMatch(/\bnull\b/);
    expect(b).not.toContain('Invalid Date');
    expect(b).not.toContain('[object Object]');
    // Whole optional blocks are omitted, not printed empty:
    expect(b).not.toContain('LOCATION');
    expect(b).not.toContain('RELATED STOCKPILOT RECORD');
    expect(b).not.toContain('ADDITIONAL ACCESS INFORMATION');
    expect(b).not.toContain('Email:');
    expect(b).not.toContain('Phone:');
  });
  it('ends with the reply-thread guidance and the StockPilot footer', () => {
    expect(body).toContain('Please reply to this email thread for updates so the responses remain attached to the same Zendesk ticket.');
    expect(body.trim().endsWith('StockPilot Request: MR-2026-000123')).toBe(true);
  });
  it('never claims a send happened (forbidden-phrase sweep, brief section 20)', () => {
    for (const phrase of ['Ticket created', 'Request submitted to Zendesk', 'DC4 notified', 'Andrew notified', 'Ticket assigned', 'Email sent']) {
      expect(body).not.toContain(phrase);
    }
  });
});

describe('prepareMaintenanceEmail — transport', () => {
  const prepared = prepareMaintenanceEmail(FULL_INPUT);

  it('(19) Outlook URL: cloud.microsoft base, single mailtouri, name-addr chips', () => {
    expect(prepared.outlookUrl.startsWith(`${OUTLOOK_COMPOSE_BASE}?mailtouri=`)).toBe(true);
    const { to, params } = decodeCompose(prepared.outlookUrl);
    expect(to).toBe('Fresno Warehouse DC4 <dc4@learn4life.org>');
    expect(params.cc).toBe('Andrew Rosas <arosas@cvwest.org>');
  });
  it('(14)(16) special characters encode once — decode recovers the exact body, %20 never +', () => {
    const { params } = decodeCompose(prepared.outlookUrl);
    expect(params.subject).toBe(prepared.draft.subject);
    expect(params.body).toBe(prepared.draft.body);
    expect(prepared.outlookUrl).not.toContain('+');
  });
  it('(20) mailto URL is bare-address RFC 6068 with cc/subject/body params', () => {
    expect(prepared.mailtoUrl.startsWith('mailto:dc4@learn4life.org?cc=arosas%40cvwest.org&subject=')).toBe(true);
  });
  it('(21) clipboard carries labelled TO and CC blocks', () => {
    expect(prepared.clipboardText).toContain('TO: dc4@learn4life.org');
    expect(prepared.clipboardText).toContain('CC: arosas@cvwest.org');
  });
  it('fits: normal input uses the FULL draft', () => {
    expect(prepared.draft.condensed).toBe(false);
    expect(prepared.linkFits).toBe(true);
  });
});

describe('prepareMaintenanceEmail — condense policy (audit Q13)', () => {
  const LONG = { ...FULL_INPUT, description: 'Detail line. '.repeat(400) };

  it('oversized input condenses: keeps number/requester/site/truncated description/share link, drops location + related + access', () => {
    const prepared = prepareMaintenanceEmail(LONG);
    expect(prepared.draft.condensed).toBe(true);
    const b = prepared.draft.body;
    expect(b).toContain('StockPilot Request: MR-2026-000123');
    expect(b).toContain('Name: Jane Smith');
    expect(b).toContain('Site: Fresno Learning Center');
    expect(b).toContain('View request photos:\nhttps://stockpilotusa.com/m/abcdef1234567890');
    expect(b).not.toContain('Building:');
    expect(b).not.toContain('RELATED STOCKPILOT RECORD');
    expect(b).not.toContain('ADDITIONAL ACCESS INFORMATION');
  });
  it('the disclosure sentence is byte-intact and contiguous', () => {
    const b = prepareMaintenanceEmail(LONG).draft.body;
    expect(b).toContain(MAINTENANCE_CONDENSED_DISCLOSURE);
  });
  it('clipboardText is ALWAYS the FULL draft even when the URLs condensed', () => {
    const prepared = prepareMaintenanceEmail(LONG);
    expect(prepared.clipboardText).toContain('Building: Main Building');
    expect(prepared.clipboardText).toContain('ADDITIONAL ACCESS INFORMATION');
  });
  it('both chosen URLs measure within DRAFT_URL_LIMIT when linkFits is true', () => {
    const prepared = prepareMaintenanceEmail(LONG);
    if (prepared.linkFits) {
      expect(prepared.outlookUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
      expect(prepared.mailtoUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    }
  });
  it('pathological names defeat even the condensed draft -> linkFits false (UI must open NOTHING)', () => {
    const prepared = prepareMaintenanceEmail({ ...LONG, requesterName: 'X'.repeat(2000) });
    expect(prepared.linkFits).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `pnpm --filter @stockpilot/core test -- maintenance/email`
Expected: FAIL — `./email` does not exist.

- [ ] **Step 3: Implement** — `packages/core/src/maintenance/email.ts`:

```ts
/**
 * Pure maintenance email builder. No React, no DOM, no network, no clock.
 * Takes NO recipient argument — it reads L4L_MAINTENANCE_EMAIL — so there is
 * no parameter through which client data could redirect the mail (the
 * delivery-request invariant, storefront-logic.ts:421-428).
 */
import {
  composeOutlookWebUrl,
  composeMailtoUrl,
  composeClipboardText,
  DRAFT_URL_LIMIT,
} from '../email/outlook-compose';
import {
  L4L_MAINTENANCE_EMAIL,
  L4L_MAINTENANCE_EMAIL_NAMES,
  type MaintenancePriority,
} from './constants';
import { sanitizeSubjectLine, sanitizeDescriptionBlock } from './text';

export interface MaintenanceEmailInput {
  requestNumber: string;
  subject: string;
  description: string;
  category: string | null;
  priority: MaintenancePriority;
  submittedAtDisplay: string;
  requesterName: string;
  requesterEmail: string | null;
  requesterPhone: string | null;
  siteName: string | null;
  department: string | null;
  building: string | null;
  roomOrArea: string | null;
  accessInstructions: string | null;
  relatedItem: { name: string; sku: string | null; modelNumber: string | null; url: string | null } | null;
  relatedOrder: { handle: string; requestedFor: string | null; url: string | null } | null;
  relatedRental: { itemNames: string[]; borrowerName: string | null; url: string | null } | null;
  photoCount: number;
  shareUrl: string | null;
}

export interface MaintenanceEmailDraft {
  to: string;
  cc: string;
  subject: string;
  body: string;
  condensed: boolean;
}

export interface PreparedMaintenanceEmail {
  draft: MaintenanceEmailDraft;
  outlookUrl: string;
  mailtoUrl: string;
  /** ALWAYS the full draft — the clipboard has no URL-length limit. */
  clipboardText: string;
  /** False means NEITHER link may be opened (silent truncation). */
  linkFits: boolean;
}

export const MAINTENANCE_CONDENSED_DISCLOSURE =
  'This message was shortened because the full request details did not fit in a compose link. The complete request is in StockPilot under the request number above.';

const SUBJECT_PREFIX_RE = /^\[StockPilot Maintenance [^\]]*\]\s*/i;
const CONDENSED_DESCRIPTION_CHARS = 400;

const PRIORITY_LABELS: Record<MaintenancePriority, string> = {
  low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent',
};

/** 'Label: value' only when the value is real — blocks omit empty lines
 *  entirely (never `undefined`, never `null`, never a bare label). */
function line(label: string, value: string | null | undefined): string | null {
  const v = typeof value === 'string' ? value.trim() : '';
  return v ? `${label}: ${v}` : null;
}

function block(heading: string, lines: (string | null)[]): string[] {
  const real = lines.filter((l): l is string => Boolean(l));
  return real.length ? [heading, '', ...real].map((s) => s) : [];
}

export function buildMaintenanceEmailDraft(
  input: MaintenanceEmailInput,
  opts: { condensed?: boolean } = {},
): MaintenanceEmailDraft {
  const condensed = opts.condensed === true;
  const cleanSubject = sanitizeSubjectLine(input.subject).replace(SUBJECT_PREFIX_RE, '');
  const subject = `[StockPilot Maintenance ${input.requestNumber}] ${cleanSubject}`;

  let description = sanitizeDescriptionBlock(input.description);
  if (condensed && description.length > CONDENSED_DESCRIPTION_CHARS) {
    const cut = description.slice(0, CONDENSED_DESCRIPTION_CHARS);
    const lastSpace = cut.lastIndexOf(' ');
    description = `${cut.slice(0, lastSpace > 200 ? lastSpace : CONDENSED_DESCRIPTION_CHARS)}...`;
  }

  const paragraphs: string[][] = [];
  paragraphs.push(['Hello DC4 Maintenance Team,']);
  paragraphs.push(['Please create a maintenance ticket for the issue below.']);

  paragraphs.push(block('MAINTENANCE REQUEST', [
    line('StockPilot Request', input.requestNumber),
    line('Issue', cleanSubject),
    condensed ? null : line('Category', input.category),
    line('Priority', PRIORITY_LABELS[input.priority]),
    line('Submitted', input.submittedAtDisplay),
  ]));

  paragraphs.push(block('REQUESTER', [
    line('Name', input.requesterName),
    condensed ? null : line('Email', input.requesterEmail),
    condensed ? null : line('Phone', input.requesterPhone),
    line('Site', input.siteName),
    condensed ? null : line('Department', input.department),
  ]));

  if (!condensed) {
    paragraphs.push(block('LOCATION', [
      line('Site', input.siteName),
      line('Building', input.building),
      line('Room or Area', input.roomOrArea),
    ]));
  }

  paragraphs.push(block('ISSUE DESCRIPTION', [description]));
  if (condensed) paragraphs.push([MAINTENANCE_CONDENSED_DISCLOSURE]);

  if (!condensed) {
    const related: (string | null)[] = [];
    if (input.relatedItem) {
      related.push(
        line('Item', input.relatedItem.name),
        line('SKU', input.relatedItem.sku),
        line('Model Number', input.relatedItem.modelNumber),
        line('StockPilot Item', input.relatedItem.url),
      );
    }
    if (input.relatedOrder) {
      related.push(
        line('Order', input.relatedOrder.handle),
        line('Requested for', input.relatedOrder.requestedFor),
        line('StockPilot Order', input.relatedOrder.url),
      );
    }
    if (input.relatedRental) {
      related.push(
        line('Rental of', input.relatedRental.itemNames.filter(Boolean).join(', ') || null),
        line('Borrower', input.relatedRental.borrowerName),
        line('StockPilot Rental', input.relatedRental.url),
      );
    }
    paragraphs.push(block('RELATED STOCKPILOT RECORD', related));
  }

  if (input.photoCount > 0) {
    const photoLines: (string | null)[] = [
      `${input.photoCount} ${input.photoCount === 1 ? 'photo was' : 'photos were'} uploaded with this request.`,
    ];
    if (input.shareUrl) photoLines.push('', 'View request photos:', input.shareUrl);
    photoLines.push('', 'The requester may also attach the photos directly to this email before sending.');
    // block() drops empty strings; keep deliberate spacing by joining here:
    paragraphs.push(['PHOTOS', '', ...photoLines.filter((l): l is string => l !== null)]);
  }

  if (!condensed) {
    paragraphs.push(block('ADDITIONAL ACCESS INFORMATION', [
      input.accessInstructions?.trim() || null,
    ]));
  }

  paragraphs.push([
    'Please reply to this email thread for updates so the responses remain attached to the same Zendesk ticket.',
  ]);
  paragraphs.push([
    'Thank you,',
    '',
    input.requesterName,
    ...(input.siteName ? [input.siteName] : []),
  ]);
  paragraphs.push([
    'Generated from StockPilot.',
    `StockPilot Request: ${input.requestNumber}`,
  ]);

  const body = paragraphs
    .filter((p) => p.length > 0)
    .map((p) => p.join('\n'))
    .join('\n\n');

  return {
    to: L4L_MAINTENANCE_EMAIL.to,
    cc: L4L_MAINTENANCE_EMAIL.cc,
    subject,
    body,
    condensed,
  };
}

function urlsFor(draft: MaintenanceEmailDraft): { outlookUrl: string; mailtoUrl: string } {
  return {
    outlookUrl: composeOutlookWebUrl({
      to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body,
      toName: L4L_MAINTENANCE_EMAIL_NAMES.to, ccName: L4L_MAINTENANCE_EMAIL_NAMES.cc,
    }),
    mailtoUrl: composeMailtoUrl(draft),
  };
}

/** Measure-then-degrade, the prepareDeliveryRequest pattern verbatim. */
export function prepareMaintenanceEmail(input: MaintenanceEmailInput): PreparedMaintenanceEmail {
  const full = buildMaintenanceEmailDraft(input);
  const fullUrls = urlsFor(full);
  const clipboardText = composeClipboardText(full);
  if (fullUrls.outlookUrl.length <= DRAFT_URL_LIMIT && fullUrls.mailtoUrl.length <= DRAFT_URL_LIMIT) {
    return { draft: full, ...fullUrls, clipboardText, linkFits: true };
  }
  const condensed = buildMaintenanceEmailDraft(input, { condensed: true });
  const condensedUrls = urlsFor(condensed);
  return {
    draft: condensed,
    ...condensedUrls,
    clipboardText, // ALWAYS the full draft
    linkFits:
      condensedUrls.outlookUrl.length <= DRAFT_URL_LIMIT &&
      condensedUrls.mailtoUrl.length <= DRAFT_URL_LIMIT,
  };
}
```

Barrel: add `export * from './maintenance/email';` to `packages/core/src/index.ts`.

NOTE for the executor on the PHOTOS block: `block()` filters empty strings, which would delete the deliberate blank line between the count and the link — that is why the PHOTOS paragraph is assembled inline. Keep it that way, or the `View request photos:\n<url>` adjacency assertions fail.

- [ ] **Step 4: Run to verify pass.**

Run: `pnpm --filter @stockpilot/core test`
Expected: PASS — the email suite plus everything from Tasks 4/6.

- [ ] **Step 5: Commit.**

```bash
git add packages/core/src/maintenance/email.ts packages/core/src/maintenance/email.test.ts packages/core/src/index.ts
git commit -m "feat(core): pure maintenance email builder with condense policy and fit measurement"
```

---

# Phase C — Server: services, uploads, share links, API routes

Independently testable: web vitest green (service + route suites), zero UI changes. Every service asserts the module + a permission; every mutation audits with allow-listed metadata; nothing here ever sends an email.

## Task 8: `MaintenanceRequestsService` + audit events + server actions

**Files:**
- Create: `apps/web/src/server/services/maintenance-requests.ts`
- Create: `apps/web/src/server/services/maintenance-requests.test.ts`
- Modify: `apps/web/src/server/services/audit.ts` (AuditEvent union — TS-only change; `audit_logs.event` has no CHECK)
- Create: `apps/web/src/server/actions/maintenance-requests.ts`

**Interfaces:**
- Consumes: `ServiceContext`, `assertModuleEnabled(ctx, 'maintenance_requests')`, `assertPermission(ctx, perm)`, `can(ctx, perm)`, `ServiceError` from `@/server/services/context`; `checkRateLimit` from `@/lib/rate-limit`; `audit(payload, ctx)` from `@/server/services/audit`; core: `maintenanceRequestFormSchema`, `formatMaintenanceRequestNumber`, `parseMaintenanceRequestNumber`, `sanitizeSubjectLine`, `sanitizeDescriptionBlock`, `type MaintenanceEmailInput`, `type MaintenanceStatus`, `type MaintenancePriority`.
- Produces (Tasks 11-16, 21, 22 consume):

```ts
export interface MaintenanceRequestListRow {
  id: string; requestNumber: number; createdAt: string; subject: string;
  status: MaintenanceStatus; priority: MaintenancePriority; category: string | null;
  siteName: string | null; requesterName: string; requesterUserId: string | null;
  photoCount: number; draftOpened: boolean; localOwnerUserId: string | null;
}
export interface MaintenanceRequestDetail extends MaintenanceRequestListRow {
  description: string; requesterEmail: string | null; requesterPhone: string | null;
  charterId: string | null; warehouseId: string | null; building: string | null;
  roomOrArea: string | null; department: string | null; accessInstructions: string | null;
  relatedItemId: string | null; relatedOrderRequestId: string | null;
  relatedRentalId: string | null; relatedLocationId: string | null;
  outlookDraftOpenedAt: string | null; outlookDraftOpenCount: number;
  archivedAt: string | null; cancelledAt: string | null; updatedAt: string;
}
export class MaintenanceRequestsService {
  constructor(ctx: ServiceContext);
  create(input: unknown): Promise<{ id: string; requestNumber: number; createdAt: string }>;
  list(args: { scope: 'mine' | 'all'; q?: string; status?: MaintenanceStatus | 'active'; limit?: number; offset?: number }): Promise<MaintenanceRequestListRow[]>;
  get(id: string): Promise<MaintenanceRequestDetail>;
  update(id: string, patch: unknown): Promise<void>;             // requester allowed-fields OR manage
  archive(id: string): Promise<void>;                            // manage
  cancel(id: string): Promise<void>;                             // requester own pre-archive, or manage
  assignLocalOwner(id: string, userId: string | null): Promise<void>; // manage
  addNote(id: string, body: string): Promise<{ id: string }>;    // manage
  listNotes(id: string): Promise<{ id: string; authorUserId: string | null; body: string; createdAt: string }[]>; // manage
  recordDraftOpened(id: string): Promise<{ openCount: number }>;
  emailInput(id: string, opts: { shareUrl: string | null }): Promise<MaintenanceEmailInput>;
}
```

- Server actions (Task 13/14/15 web forms consume): `createMaintenanceRequestAction(values: unknown): Promise<{ ok: true; id: string } | { error: { message: string } }>`, `updateMaintenanceRequestAction(id, values)`, `archiveMaintenanceRequestAction(id)`, `cancelMaintenanceRequestAction(id)`, `assignMaintenanceOwnerAction(id, userId | null)`, `addMaintenanceNoteAction(id, body)`, `recordMaintenanceDraftOpenedAction(id): Promise<{ ok: true; openCount: number } | { error: { message: string } }>`.

- [ ] **Step 1: Write the failing service tests** — `apps/web/src/server/services/maintenance-requests.test.ts`. Copy the import block (supabase mock + `makeServiceContext`) VERBATIM from `apps/web/src/server/services/__tests__`-style suites — the exact file to mirror is the one `modules.gate.test.ts` uses; keep its paths identical. Mock `@/lib/rate-limit` and `@/server/services/audit` per-file:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Per-file audit mock — global setup no-ops it; we assert on it (Task 8 gate).
vi.mock('@/server/services/audit', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/server/services/audit')>();
  return { ...mod, audit: vi.fn(async () => undefined) };
});
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() + 60000 })),
}));

import { audit } from '@/server/services/audit';
import { checkRateLimit } from '@/lib/rate-limit';
import { MaintenanceRequestsService } from './maintenance-requests';
// makeServiceContext + mock client: SAME imports modules.gate.test.ts uses.
import { makeServiceContext } from '@/test/service-context';

const VALID = {
  subject: 'AC not working in Room 204',
  description: 'Blowing warm air since yesterday.',
  priority: 'high',
};

function ctxWith(overrides: Parameters<typeof makeServiceContext>[0] = {}) {
  return makeServiceContext(overrides);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('create', () => {
  it('inserts with org + requester from the CONTEXT and snapshots from the profile — never the client body', async () => {
    const ctx = ctxWith({
      canned: {
        'user_profiles.select': { data: { full_name: 'Jane Smith', phone: null }, error: null },
        'maintenance_requests.insert': { data: { id: 'r1', request_number: 1, created_at: '2026-08-05T16:15:00Z' }, error: null },
      },
    });
    const svc = new MaintenanceRequestsService(ctx);
    const res = await svc.create({ ...VALID, requesterName: 'FORGED NAME' });
    expect(res.id).toBe('r1');
    // Pin the INSERT shape via the mock's call recording — the mock ignores
    // filters, so returned-row assertions prove nothing (landmine 37):
    const insert = ctx.chainArgs('maintenance_requests', 'insert')[0][0];
    expect(insert.organization_id).toBe(ctx.organizationId);
    expect(insert.requester_user_id).toBe(ctx.userId);
    expect(insert.requester_name_snapshot).toBe('Jane Smith'); // profile, not body
    expect(insert.status).toBe('saved');
    // Client cannot set these:
    expect(insert.local_owner_user_id).toBeUndefined();
    expect(insert.outlook_draft_open_count).toBeUndefined();
  });

  it('rejects when the module is disabled (ctxWithout pattern — landmine 22)', async () => {
    const ctx = ctxWith({ enabledModules: 'without:maintenance_requests' });
    await expect(new MaintenanceRequestsService(ctx).create(VALID)).rejects.toMatchObject({ code: 'module_disabled' });
  });

  it('rate-limits creation with a closed-mode per-user bucket', async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, count: 20, resetAt: Date.now() });
    const ctx = ctxWith({});
    await expect(new MaintenanceRequestsService(ctx).create(VALID)).rejects.toMatchObject({ code: 'conflict' });
    expect(checkRateLimit).toHaveBeenCalledWith(expect.stringContaining('maintenance:create:'), 20, 60 * 60 * 1000, 'closed');
  });

  it('audits maintenance_request.created with allow-listed metadata (no description copy)', async () => {
    const ctx = ctxWith({
      canned: {
        'user_profiles.select': { data: { full_name: 'Jane Smith', phone: null }, error: null },
        'maintenance_requests.insert': { data: { id: 'r1', request_number: 1, created_at: '2026-08-05T16:15:00Z' }, error: null },
      },
    });
    await new MaintenanceRequestsService(ctx).create(VALID);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'maintenance_request.created', entityType: 'maintenance_request', entityId: 'r1' }),
      ctx,
    );
    const payload = vi.mocked(audit).mock.calls[0]![0];
    expect(JSON.stringify(payload)).not.toContain('Blowing warm air'); // never log the description
  });
});

describe('list', () => {
  it("scope 'mine' pins a requester_user_id filter in the query chain", async () => {
    const ctx = ctxWith({ canned: { 'maintenance_requests.select': { data: [], error: null } } });
    await new MaintenanceRequestsService(ctx).list({ scope: 'mine' });
    expect(ctx.chains('maintenance_requests')).toContainEqual(
      expect.arrayContaining([['eq', 'requester_user_id', ctx.userId]]),
    );
  });

  it("scope 'all' without read_all/manage throws forbidden", async () => {
    const ctx = ctxWith({ permissions: ['maintenance_requests:submit'] });
    await expect(new MaintenanceRequestsService(ctx).list({ scope: 'all' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('search by typed handle parses MR-2026-000123 to the bigint 123', async () => {
    const ctx = ctxWith({
      permissions: ['maintenance_requests:submit', 'maintenance_requests:read_all'],
      canned: { 'maintenance_requests.select': { data: [], error: null } },
    });
    await new MaintenanceRequestsService(ctx).list({ scope: 'all', q: 'MR-2026-000123' });
    expect(ctx.chains('maintenance_requests')).toContainEqual(
      expect.arrayContaining([['eq', 'request_number', 123]]),
    );
  });
});

describe('recordDraftOpened', () => {
  it('stamps first-open time once, increments the count, moves saved -> draft_opened, audits draft OPENED (never sent)', async () => {
    const ctx = ctxWith({
      canned: {
        'maintenance_requests.select': { data: { id: 'r1', status: 'saved', outlook_draft_opened_at: null, outlook_draft_open_count: 0, archived_at: null, cancelled_at: null }, error: null },
        'maintenance_requests.update': { data: { outlook_draft_open_count: 1 }, error: null },
      },
    });
    const res = await new MaintenanceRequestsService(ctx).recordDraftOpened('r1');
    expect(res.openCount).toBe(1);
    const patch = ctx.chainArgs('maintenance_requests', 'update')[0][0];
    expect(patch.status).toBe('draft_opened');
    expect(patch.outlook_draft_open_count).toBe(1);
    expect(patch.outlook_draft_opened_at).toBeTruthy();
    const evt = vi.mocked(audit).mock.calls[0]![0];
    expect(evt.event).toBe('maintenance_request.draft_opened');
    expect(JSON.stringify(evt)).not.toMatch(/sent|ticket/i);
  });
});

describe('emailInput', () => {
  it('snapshots related-item facts SERVER-side and builds the app URL from the appUrl convention, never window.location', async () => {
    const ctx = ctxWith({
      canned: {
        'maintenance_requests.select': { data: {
          id: 'r1', request_number: 123, created_at: '2026-08-05T16:15:00Z', subject: 'AC broken',
          description: 'desc', category: null, priority: 'high', status: 'saved',
          requester_name_snapshot: 'Jane Smith', requester_email_snapshot: null, requester_phone_snapshot: null,
          charter_id: null, warehouse_id: null, building: null, room_or_area: null, department: null,
          access_instructions: null, related_item_id: 'i1', related_order_request_id: null, related_rental_id: null,
          related_location_id: null, outlook_draft_opened_at: null, outlook_draft_open_count: 0,
          archived_at: null, cancelled_at: null, local_owner_user_id: null, updated_at: '2026-08-05T16:15:00Z',
        }, error: null },
        'inventory_items.select': { data: { id: 'i1', name: 'HVAC unit', sku: 'HVAC-1', model_number: 'ACX', custom_fields: {} }, error: null },
        'maintenance_request_attachments.select': { data: [], count: 2, error: null },
      },
    });
    const input = await new MaintenanceRequestsService(ctx).emailInput('r1', { shareUrl: null });
    expect(input.requestNumber).toBe('MR-2026-000123');
    expect(input.relatedItem).toEqual({
      name: 'HVAC unit', sku: 'HVAC-1', modelNumber: 'ACX',
      url: expect.stringMatching(/^https:\/\/.+\/dashboard\/inventory\/i1$/),
    });
    expect(input.photoCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `pnpm --filter web test -- maintenance-requests`
Expected: FAIL — service module does not exist.

- [ ] **Step 3: Implement the audit union.** In `apps/web/src/server/services/audit.ts`, extend the `AuditEvent` union (beside the `order.delivery_request_drafted` block, reusing its doc-comment posture):

```ts
  /**
   * Maintenance requests (maintenance_requests module). draft_opened records
   * that a prefilled email DRAFT was OPENED and nothing more — StockPilot
   * cannot observe Send, delivery, or Zendesk ticket creation. Never widen
   * these events' meanings. No migration: audit_logs.event is un-CHECKed text.
   */
  | 'maintenance_request.created'
  | 'maintenance_request.updated'
  | 'maintenance_request.draft_opened'
  | 'maintenance_request.archived'
  | 'maintenance_request.cancelled'
  | 'maintenance_request.owner_assigned'
  | 'maintenance_request.note_added'
  | 'maintenance_request.attachment_added'
  | 'maintenance_request.attachment_removed'
  | 'maintenance_request.share_link_created'
  | 'maintenance_request.share_link_revoked'
  | 'maintenance_request.settings_updated'
```

- [ ] **Step 4: Implement the service** — `apps/web/src/server/services/maintenance-requests.ts`:

```ts
import 'server-only';

import {
  formatMaintenanceRequestNumber,
  parseMaintenanceRequestNumber,
  maintenanceRequestFormSchema,
  formatOrderNumber,
  type MaintenanceEmailInput,
  type MaintenancePriority,
  type MaintenanceStatus,
} from '@stockpilot/core';

import { checkRateLimit } from '@/lib/rate-limit';
import { audit } from '@/server/services/audit';
import {
  assertModuleEnabled,
  assertPermission,
  can,
  ServiceError,
  type ServiceContext,
} from '@/server/services/context';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://stockpilotusa.com';

const LIST_COLUMNS =
  'id, request_number, created_at, subject, status, priority, category, requester_user_id, requester_name_snapshot, local_owner_user_id, outlook_draft_opened_at, charter_id';

export interface MaintenanceRequestListRow {
  id: string; requestNumber: number; createdAt: string; subject: string;
  status: MaintenanceStatus; priority: MaintenancePriority; category: string | null;
  siteName: string | null; requesterName: string; requesterUserId: string | null;
  photoCount: number; draftOpened: boolean; localOwnerUserId: string | null;
}

export interface MaintenanceRequestDetail extends MaintenanceRequestListRow {
  description: string; requesterEmail: string | null; requesterPhone: string | null;
  charterId: string | null; warehouseId: string | null; building: string | null;
  roomOrArea: string | null; department: string | null; accessInstructions: string | null;
  relatedItemId: string | null; relatedOrderRequestId: string | null;
  relatedRentalId: string | null; relatedLocationId: string | null;
  outlookDraftOpenedAt: string | null; outlookDraftOpenCount: number;
  archivedAt: string | null; cancelledAt: string | null; updatedAt: string;
}

/** Fields a REQUESTER may edit on their own pre-archive request. Everything
 *  else (owner assignment, status flips, counters) is manage/service-only —
 *  RLS enforces the ROW boundary, this list enforces the FIELD boundary. */
const REQUESTER_EDITABLE = new Set([
  'subject', 'description', 'category', 'priority', 'charterId', 'warehouseId',
  'building', 'roomOrArea', 'department', 'accessInstructions', 'requesterPhone',
  'relatedItemId', 'relatedOrderRequestId', 'relatedRentalId', 'relatedLocationId',
]);

export class MaintenanceRequestsService {
  constructor(private ctx: ServiceContext) {}

  private get db() { return this.ctx.supabase; }

  private canReadAll(): boolean {
    return can(this.ctx, 'maintenance_requests:read_all') || can(this.ctx, 'maintenance_requests:manage');
  }

  async create(input: unknown): Promise<{ id: string; requestNumber: number; createdAt: string }> {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    assertPermission(this.ctx, 'maintenance_requests:submit');

    const parsed = maintenanceRequestFormSchema.safeParse(input);
    if (!parsed.success) {
      throw new ServiceError('validation_error', parsed.error.issues[0]?.message ?? 'Please check the form.');
    }
    const v = parsed.data;

    const limit = await checkRateLimit(`maintenance:create:${this.ctx.userId}`, 20, 60 * 60 * 1000, 'closed');
    if (!limit.allowed) {
      throw new ServiceError('conflict', 'Too many maintenance requests in the last hour. Please try again later.');
    }

    // Identity snapshots come from the SESSION + profile, never the body.
    const { data: profile } = await this.db
      .from('user_profiles')
      .select('full_name, phone')
      .eq('id', this.ctx.userId)
      .maybeSingle();
    const { data: authUser } = await this.db.auth.getUser();
    const email = authUser?.user?.email ?? null;

    const { data: row, error } = await this.db
      .from('maintenance_requests')
      .insert({
        organization_id: this.ctx.organizationId,
        requester_user_id: this.ctx.userId,
        requester_name_snapshot: (profile?.full_name as string | null) || email || 'Unknown requester',
        requester_email_snapshot: email,
        requester_phone_snapshot: v.requesterPhone ?? (profile?.phone as string | null) ?? null,
        subject: v.subject,
        description: v.description,
        category: v.category ?? null,
        priority: v.priority,
        charter_id: v.charterId ?? null,
        warehouse_id: v.warehouseId ?? null,
        building: v.building ?? null,
        room_or_area: v.roomOrArea ?? null,
        department: v.department ?? null,
        access_instructions: v.accessInstructions ?? null,
        related_item_id: v.relatedItemId ?? null,
        related_order_request_id: v.relatedOrderRequestId ?? null,
        related_rental_id: v.relatedRentalId ?? null,
        related_location_id: v.relatedLocationId ?? null,
        status: 'saved',
      })
      .select('id, request_number, created_at')
      .single();
    if (error || !row) throw new ServiceError('internal_error', error?.message ?? 'Could not save the request.');

    await audit(
      {
        event: 'maintenance_request.created',
        entityType: 'maintenance_request',
        entityId: row.id as string,
        extra: {
          request_number: row.request_number,
          priority: v.priority,
          category: v.category ?? null,
          has_related_item: Boolean(v.relatedItemId),
          // NEVER the description, subject, phone, or compose URLs (GC 27).
        },
      },
      this.ctx,
    );

    return {
      id: row.id as string,
      requestNumber: row.request_number as number,
      createdAt: row.created_at as string,
    };
  }

  async list(args: {
    scope: 'mine' | 'all'; q?: string; status?: MaintenanceStatus | 'active';
    limit?: number; offset?: number;
  }): Promise<MaintenanceRequestListRow[]> {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    if (args.scope === 'all' && !this.canReadAll()) {
      throw new ServiceError('forbidden', 'Missing permission: maintenance_requests:read_all');
    }

    let q = this.db
      .from('maintenance_requests')
      .select(`${LIST_COLUMNS}, charters!charter_id(name), maintenance_request_attachments(count)`)
      .eq('organization_id', this.ctx.organizationId)
      .order('created_at', { ascending: false })
      .range(args.offset ?? 0, (args.offset ?? 0) + Math.min(args.limit ?? 50, 100) - 1);

    if (args.scope === 'mine') q = q.eq('requester_user_id', this.ctx.userId);
    if (args.status && args.status !== 'active') q = q.eq('status', args.status);

    if (args.q?.trim()) {
      const handle = parseMaintenanceRequestNumber(args.q);
      if (handle) {
        q = q.eq('request_number', handle);
      } else {
        const term = args.q.trim().replace(/[%,]/g, ' ');
        q = q.or(`subject.ilike.%${term}%,description.ilike.%${term}%,requester_name_snapshot.ilike.%${term}%`);
      }
    }

    const { data, error } = await q;
    if (error) throw new ServiceError('internal_error', error.message);

    let rows = (data ?? []) as Record<string, unknown>[];
    // 'active' excludes archived/cancelled JS-SIDE — never PostgREST not.in,
    // which drops NULL rows (pattern #23).
    if (args.status === 'active') {
      rows = rows.filter((r) => r.status === 'saved' || r.status === 'draft_opened');
    }
    return rows.map((r) => this.toListRow(r));
  }

  private toListRow(r: Record<string, unknown>): MaintenanceRequestListRow {
    const charter = r.charters as { name?: string } | null;
    const att = r.maintenance_request_attachments as { count?: number }[] | null;
    return {
      id: r.id as string,
      requestNumber: r.request_number as number,
      createdAt: r.created_at as string,
      subject: r.subject as string,
      status: r.status as MaintenanceStatus,
      priority: r.priority as MaintenancePriority,
      category: (r.category as string | null) ?? null,
      siteName: charter?.name ?? null,
      requesterName: r.requester_name_snapshot as string,
      requesterUserId: (r.requester_user_id as string | null) ?? null,
      photoCount: att?.[0]?.count ?? 0,
      draftOpened: Boolean(r.outlook_draft_opened_at),
      localOwnerUserId: (r.local_owner_user_id as string | null) ?? null,
    };
  }

  async get(id: string): Promise<MaintenanceRequestDetail> {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    const { data: r, error } = await this.db
      .from('maintenance_requests')
      .select(`*, charters!charter_id(name), maintenance_request_attachments(count)`)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!r) throw new ServiceError('not_found', 'Maintenance request not found');
    const base = this.toListRow(r as Record<string, unknown>);
    const row = r as Record<string, unknown>;
    return {
      ...base,
      description: row.description as string,
      requesterEmail: (row.requester_email_snapshot as string | null) ?? null,
      requesterPhone: (row.requester_phone_snapshot as string | null) ?? null,
      charterId: (row.charter_id as string | null) ?? null,
      warehouseId: (row.warehouse_id as string | null) ?? null,
      building: (row.building as string | null) ?? null,
      roomOrArea: (row.room_or_area as string | null) ?? null,
      department: (row.department as string | null) ?? null,
      accessInstructions: (row.access_instructions as string | null) ?? null,
      relatedItemId: (row.related_item_id as string | null) ?? null,
      relatedOrderRequestId: (row.related_order_request_id as string | null) ?? null,
      relatedRentalId: (row.related_rental_id as string | null) ?? null,
      relatedLocationId: (row.related_location_id as string | null) ?? null,
      outlookDraftOpenedAt: (row.outlook_draft_opened_at as string | null) ?? null,
      outlookDraftOpenCount: (row.outlook_draft_open_count as number) ?? 0,
      archivedAt: (row.archived_at as string | null) ?? null,
      cancelledAt: (row.cancelled_at as string | null) ?? null,
      updatedAt: row.updated_at as string,
    };
  }

  async update(id: string, patch: unknown): Promise<void> {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    const detail = await this.get(id);
    const isManager = can(this.ctx, 'maintenance_requests:manage');
    const isRequester = detail.requesterUserId === this.ctx.userId;
    if (!isManager && !isRequester) throw new ServiceError('forbidden', 'Not your request.');
    if (!isManager && (detail.archivedAt || detail.cancelledAt)) {
      throw new ServiceError('conflict', 'This request is closed and can no longer be edited.');
    }

    const parsed = maintenanceRequestFormSchema.partial().safeParse(patch);
    if (!parsed.success) {
      throw new ServiceError('validation_error', parsed.error.issues[0]?.message ?? 'Please check the form.');
    }
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    const colFor: Record<string, string> = {
      subject: 'subject', description: 'description', category: 'category', priority: 'priority',
      charterId: 'charter_id', warehouseId: 'warehouse_id', building: 'building',
      roomOrArea: 'room_or_area', department: 'department', accessInstructions: 'access_instructions',
      requesterPhone: 'requester_phone_snapshot', relatedItemId: 'related_item_id',
      relatedOrderRequestId: 'related_order_request_id', relatedRentalId: 'related_rental_id',
      relatedLocationId: 'related_location_id',
    };
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value === undefined) continue;
      if (!isManager && !REQUESTER_EDITABLE.has(key)) continue;
      const col = colFor[key];
      if (col) updates[col] = value ?? null;
    }
    const { error } = await this.db
      .from('maintenance_requests')
      .update(updates)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
    await audit({ event: 'maintenance_request.updated', entityType: 'maintenance_request', entityId: id, extra: { changed_keys: Object.keys(updates).filter((k) => k !== 'updated_at') } }, this.ctx);
  }

  async archive(id: string): Promise<void> {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    assertPermission(this.ctx, 'maintenance_requests:manage');
    const now = new Date().toISOString();
    const { error } = await this.db
      .from('maintenance_requests')
      .update({ status: 'archived', archived_at: now, updated_at: now })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
    await audit({ event: 'maintenance_request.archived', entityType: 'maintenance_request', entityId: id }, this.ctx);
  }

  async cancel(id: string): Promise<void> {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    const detail = await this.get(id);
    const isManager = can(this.ctx, 'maintenance_requests:manage');
    if (!isManager && detail.requesterUserId !== this.ctx.userId) {
      throw new ServiceError('forbidden', 'Not your request.');
    }
    if (detail.archivedAt) throw new ServiceError('conflict', 'This request is archived.');
    const now = new Date().toISOString();
    const { error } = await this.db
      .from('maintenance_requests')
      .update({ status: 'cancelled', cancelled_at: now, updated_at: now })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
    await audit({ event: 'maintenance_request.cancelled', entityType: 'maintenance_request', entityId: id }, this.ctx);
  }

  async assignLocalOwner(id: string, userId: string | null): Promise<void> {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    assertPermission(this.ctx, 'maintenance_requests:manage');
    const { error } = await this.db
      .from('maintenance_requests')
      .update({ local_owner_user_id: userId, updated_at: new Date().toISOString() })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
    await audit({ event: 'maintenance_request.owner_assigned', entityType: 'maintenance_request', entityId: id, extra: { local_owner_user_id: userId } }, this.ctx);
  }

  async addNote(id: string, body: string): Promise<{ id: string }> {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    assertPermission(this.ctx, 'maintenance_requests:manage');
    const text = body.trim();
    if (!text || text.length > 4000) throw new ServiceError('validation_error', 'Notes must be 1 to 4,000 characters.');
    const { data, error } = await this.db
      .from('maintenance_request_notes')
      .insert({
        organization_id: this.ctx.organizationId,
        maintenance_request_id: id,
        author_user_id: this.ctx.userId,
        body: text,
      })
      .select('id')
      .single();
    if (error || !data) throw new ServiceError('internal_error', error?.message ?? 'Could not add the note.');
    await audit({ event: 'maintenance_request.note_added', entityType: 'maintenance_request', entityId: id }, this.ctx);
    return { id: data.id as string };
  }

  async listNotes(id: string) {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    assertPermission(this.ctx, 'maintenance_requests:manage');
    const { data, error } = await this.db
      .from('maintenance_request_notes')
      .select('id, author_user_id, body, created_at')
      .eq('organization_id', this.ctx.organizationId)
      .eq('maintenance_request_id', id)
      .order('created_at', { ascending: true });
    if (error) throw new ServiceError('internal_error', error.message);
    return (data ?? []).map((n) => ({
      id: n.id as string,
      authorUserId: (n.author_user_id as string | null) ?? null,
      body: n.body as string,
      createdAt: n.created_at as string,
    }));
  }

  /** Records that a DRAFT WAS OPENED. Nothing more is knowable (brief 20/21). */
  async recordDraftOpened(id: string): Promise<{ openCount: number }> {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    const detail = await this.get(id);
    const openCount = detail.outlookDraftOpenCount + 1;
    const now = new Date().toISOString();
    const { error } = await this.db
      .from('maintenance_requests')
      .update({
        outlook_draft_opened_at: detail.outlookDraftOpenedAt ?? now,
        outlook_draft_open_count: openCount,
        status: detail.status === 'saved' ? 'draft_opened' : detail.status,
        updated_at: now,
      })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
    await audit(
      {
        event: 'maintenance_request.draft_opened',
        entityType: 'maintenance_request',
        entityId: id,
        extra: { recipient_type: 'dc4-maintenance-request', included_cc_recipient: true, open_count: openCount },
      },
      this.ctx,
    );
    return { openCount };
  }

  /** Assembles the pure-builder input SERVER-side: related-record facts are
   *  snapshotted from the database (never client payloads — audit 2.7), and
   *  record URLs use the appUrl convention (never window.location). */
  async emailInput(id: string, opts: { shareUrl: string | null }): Promise<MaintenanceEmailInput> {
    const detail = await this.get(id);
    const requestNumber =
      formatMaintenanceRequestNumber(detail.requestNumber, detail.createdAt) ?? String(detail.requestNumber);

    let relatedItem: MaintenanceEmailInput['relatedItem'] = null;
    if (detail.relatedItemId) {
      const { data: item } = await this.db
        .from('inventory_items')
        .select('id, name, sku, model_number')
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', detail.relatedItemId)
        .maybeSingle();
      if (item) {
        relatedItem = {
          name: item.name as string,
          sku: (item.sku as string | null) ?? null,
          modelNumber: (item.model_number as string | null) ?? null,
          url: `${APP_URL}/dashboard/inventory/${item.id}`,
        };
      }
    }

    let relatedOrder: MaintenanceEmailInput['relatedOrder'] = null;
    if (detail.relatedOrderRequestId) {
      const { data: order } = await this.db
        .from('order_requests')
        .select('id, order_number, requested_for')
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', detail.relatedOrderRequestId)
        .maybeSingle();
      if (order) {
        relatedOrder = {
          handle: formatOrderNumber(order.order_number as number | null) ?? (order.id as string).slice(0, 8),
          requestedFor: (order.requested_for as string | null) ?? null,
          url: `${APP_URL}/dashboard/orders/${order.id}`,
        };
      }
    }

    let relatedRental: MaintenanceEmailInput['relatedRental'] = null;
    if (detail.relatedRentalId) {
      const { data: rental } = await this.db
        .from('rentals')
        .select('id, borrower_name, rental_items(inventory_items(name))')
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', detail.relatedRentalId)
        .maybeSingle();
      if (rental) {
        const items = ((rental.rental_items as { inventory_items: { name: string } | null }[] | null) ?? [])
          .map((ri) => ri.inventory_items?.name)
          .filter((n): n is string => Boolean(n));
        relatedRental = {
          itemNames: items,
          borrowerName: (rental.borrower_name as string | null) ?? null,
          url: `${APP_URL}/dashboard/rentals/${rental.id}`,
        };
      }
    }

    // Org timezone display for the Submitted line, formatted server-side.
    const { data: org } = await this.db
      .from('organizations')
      .select('timezone')
      .eq('id', this.ctx.organizationId)
      .maybeSingle();
    const tz = (org?.timezone as string | null) || 'America/Los_Angeles';
    const submittedAtDisplay = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'long', timeStyle: 'short', timeZone: tz,
    }).format(new Date(detail.createdAt));

    return {
      requestNumber,
      subject: detail.subject,
      description: detail.description,
      category: detail.category,
      priority: detail.priority,
      submittedAtDisplay,
      requesterName: detail.requesterName,
      requesterEmail: detail.requesterEmail,
      requesterPhone: detail.requesterPhone,
      siteName: detail.siteName,
      department: detail.department,
      building: detail.building,
      roomOrArea: detail.roomOrArea,
      accessInstructions: detail.accessInstructions,
      relatedItem,
      relatedOrder,
      relatedRental,
      photoCount: detail.photoCount,
      shareUrl: opts.shareUrl,
    };
  }
}
```

NOTE for the executor: `rentals.borrower_name` vs `borrower_user_id` — 0131 defines the rentals columns; VERIFY the actual name/display column with one Read of the migration before wiring `emailInput` and adjust the select (embedding `user_profiles` if the name is only on the borrower user). Same for `order_requests.requested_for`. Do not guess — the audit flagged both tables but not these two column names.

- [ ] **Step 5: Implement the server actions** — `apps/web/src/server/actions/maintenance-requests.ts`:

```ts
'use server';

import { revalidatePath } from 'next/cache';

import { withContext } from '@/server/services/context';
import { serviceErrorStatus, ServiceError } from '@/server/services/context';
import { MaintenanceRequestsService } from '@/server/services/maintenance-requests';

type ActionResult<T> = ({ ok: true } & T) | { error: { message: string } };

function fail(e: unknown): { error: { message: string } } {
  if (e instanceof ServiceError) return { error: { message: e.message } };
  return { error: { message: 'Something went wrong. Please try again.' } };
}

export async function createMaintenanceRequestAction(values: unknown): Promise<ActionResult<{ id: string; requestNumber: number; createdAt: string }>> {
  try {
    const ctx = await withContext();
    const res = await new MaintenanceRequestsService(ctx).create(values);
    revalidatePath('/dashboard/maintenance');
    return { ok: true, ...res };
  } catch (e) { return fail(e); }
}

export async function updateMaintenanceRequestAction(id: string, values: unknown): Promise<ActionResult<object>> {
  try {
    const ctx = await withContext();
    await new MaintenanceRequestsService(ctx).update(id, values);
    revalidatePath(`/dashboard/maintenance/${id}`);
    return { ok: true };
  } catch (e) { return fail(e); }
}

export async function archiveMaintenanceRequestAction(id: string): Promise<ActionResult<object>> {
  try {
    const ctx = await withContext();
    await new MaintenanceRequestsService(ctx).archive(id);
    revalidatePath('/dashboard/maintenance');
    return { ok: true };
  } catch (e) { return fail(e); }
}

export async function cancelMaintenanceRequestAction(id: string): Promise<ActionResult<object>> {
  try {
    const ctx = await withContext();
    await new MaintenanceRequestsService(ctx).cancel(id);
    revalidatePath('/dashboard/maintenance');
    return { ok: true };
  } catch (e) { return fail(e); }
}

export async function assignMaintenanceOwnerAction(id: string, userId: string | null): Promise<ActionResult<object>> {
  try {
    const ctx = await withContext();
    await new MaintenanceRequestsService(ctx).assignLocalOwner(id, userId);
    revalidatePath(`/dashboard/maintenance/${id}`);
    return { ok: true };
  } catch (e) { return fail(e); }
}

export async function addMaintenanceNoteAction(id: string, body: string): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await withContext();
    const res = await new MaintenanceRequestsService(ctx).addNote(id, body);
    revalidatePath(`/dashboard/maintenance/${id}`);
    return { ok: true, ...res };
  } catch (e) { return fail(e); }
}

/** Called AFTER window.open succeeds (R3 ordering — never before). Returns
 *  the new count so the duplicate-draft dialog can arm itself. */
export async function recordMaintenanceDraftOpenedAction(id: string): Promise<ActionResult<{ openCount: number }>> {
  try {
    const ctx = await withContext();
    const res = await new MaintenanceRequestsService(ctx).recordDraftOpened(id);
    return { ok: true, ...res };
  } catch (e) { return fail(e); }
}
```

- [ ] **Step 6: Run to verify pass.**

Run: `pnpm --filter web test -- maintenance-requests && pnpm --filter web typecheck`
Expected: PASS. (If `serviceErrorStatus` is imported unused, drop it — lint will catch it.)

- [ ] **Step 7: Commit.**

```bash
git add apps/web/src/server/services/maintenance-requests.ts \
        apps/web/src/server/services/maintenance-requests.test.ts \
        apps/web/src/server/services/audit.ts \
        apps/web/src/server/actions/maintenance-requests.ts
git commit -m "feat(maintenance): requests service, audit events, server actions"
```

## Task 9: Attachment hardening — magic-byte sniffing, mint + finalize, rate limits

**Files:**
- Create: `apps/web/src/lib/image-signature.ts`
- Create: `apps/web/src/lib/image-signature.test.ts`
- Create: `apps/web/src/server/services/maintenance-attachments.ts`
- Create: `apps/web/src/server/services/maintenance-attachments.test.ts`
- Create: `apps/web/src/app/api/v1/maintenance-requests/[id]/attachments/route.ts` (POST mint)
- Create: `apps/web/src/app/api/v1/maintenance-requests/[id]/attachments/finalize/route.ts` (POST)
- Create: `apps/web/src/app/api/v1/maintenance-requests/[id]/attachments/[attachmentId]/route.ts` (DELETE)

**Interfaces:**
- Consumes: `sanitizeFilenameSegment` from `@/lib/exports/filename` (safe filenames, already traversal/CRLF-tested); `checkRateLimit`; `withApiContext` from `@/lib/auth/api-context`; `createAdminClient` from `@/lib/supabase/admin`; bucket `maintenance-photos` (Task 2); constants `MAINTENANCE_MAX_PHOTOS`, `MAINTENANCE_MAX_PHOTO_BYTES` (Task 6).
- Produces:

```ts
// image-signature.ts — pure, no deps:
export type SniffedImage = { kind: 'png' | 'jpeg' | 'webp'; width: number | null; height: number | null };
export function sniffImage(data: Uint8Array): SniffedImage | null;
export const MIME_FOR_KIND: Record<SniffedImage['kind'], 'image/png' | 'image/jpeg' | 'image/webp'>;

// maintenance-attachments.ts:
export class MaintenanceAttachmentsService {
  constructor(ctx: ServiceContext);
  createUploadUrl(requestId: string, args: { fileExt: string; originalFilename: string }): Promise<{
    path: string; signedUrl: string; token: string;
    thumbPath: string; thumbSignedUrl: string; thumbToken: string;
  }>;
  finalize(requestId: string, args: { path: string; thumbPath: string | null; originalFilename: string; declaredMime: string }): Promise<{ id: string; width: number | null; height: number | null }>;
  remove(requestId: string, attachmentId: string): Promise<void>;
  signedViewUrls(requestId: string): Promise<{ id: string; originalFilename: string; url: string; thumbUrl: string | null; width: number | null; height: number | null }[]>;
}
```

- Route contracts (mobile Task 19 + web Task 13 consume): `POST /api/v1/maintenance-requests/[id]/attachments` body `{ fileExt, originalFilename }` → 200 mint payload | 401/403/404/429; `POST .../attachments/finalize` body `{ path, thumbPath?, originalFilename, declaredMime }` → 200 `{ id }` | 400 `{ error: 'invalid_image' }`; `DELETE .../attachments/[attachmentId]` → 200.

- [ ] **Step 1: Write the failing sniffer tests** — `apps/web/src/lib/image-signature.test.ts`. Build REAL byte fixtures in code (no binary files):

```ts
import { describe, expect, it } from 'vitest';
import { sniffImage, MIME_FOR_KIND } from './image-signature';

/** Minimal real headers, from the format specs. */
function pngBytes(width = 2, height = 3): Uint8Array {
  const b = new Uint8Array(26);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // signature
  b.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8); // IHDR len+tag
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}
function jpegBytes(width = 4, height = 5): Uint8Array {
  // SOI + one SOF0 segment carrying the dimensions.
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x00,
  ]);
}
function webpBytes(): Uint8Array {
  const b = new Uint8Array(16);
  b.set([0x52, 0x49, 0x46, 0x46]);        // 'RIFF'
  b.set([0x57, 0x45, 0x42, 0x50], 8);     // 'WEBP'
  return b;
}

describe('sniffImage', () => {
  it('identifies PNG with dimensions', () => {
    expect(sniffImage(pngBytes(2, 3))).toEqual({ kind: 'png', width: 2, height: 3 });
  });
  it('identifies JPEG with dimensions', () => {
    expect(sniffImage(jpegBytes(4, 5))).toEqual({ kind: 'jpeg', width: 4, height: 5 });
  });
  it('identifies WEBP (dimensions null — RIFF header only)', () => {
    expect(sniffImage(webpBytes())).toEqual({ kind: 'webp', width: null, height: null });
  });
  it('REJECTS fake MIME: an EXE/script/HTML body is null regardless of declared type (photo test 6)', () => {
    expect(sniffImage(new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]))).toBeNull(); // MZ
    expect(sniffImage(new TextEncoder().encode('<html><script>alert(1)</script>'))).toBeNull();
    expect(sniffImage(new Uint8Array(0))).toBeNull();
  });
  it('maps kinds to the exact bucket MIME pins', () => {
    expect(MIME_FOR_KIND).toEqual({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' });
  });
});
```

- [ ] **Step 2: Run to verify failure.** `pnpm --filter web test -- image-signature` → FAIL (module missing).

- [ ] **Step 3: Implement the sniffer** — `apps/web/src/lib/image-signature.ts`:

```ts
/**
 * Magic-byte image sniffing for upload FINALIZE (audit Q8). The bucket's
 * allowed_mime_types only checks the DECLARED Content-Type; this reads the
 * actual bytes. PNG/JPEG logic mirrors readImageDimensions
 * (inventory-export-xlsx.ts:58-95 — left in place, it is byte-pinned by the
 * export suite); WEBP added because the bucket allows it.
 */
export type SniffedImage = { kind: 'png' | 'jpeg' | 'webp'; width: number | null; height: number | null };

export const MIME_FOR_KIND = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
} as const;

export function sniffImage(data: Uint8Array): SniffedImage | null {
  // PNG: 8-byte signature, IHDR width at 16 / height at 20 (BE32).
  if (data.length > 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return { kind: 'png', width: view.getUint32(16), height: view.getUint32(20) };
  }
  // JPEG: SOI then walk markers to the first SOF.
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) { offset++; continue; }
      const marker = data[offset + 1]!;
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
      if (isSof) {
        const height = (data[offset + 5]! << 8) | data[offset + 6]!;
        const width = (data[offset + 7]! << 8) | data[offset + 8]!;
        return width > 0 && height > 0 ? { kind: 'jpeg', width, height } : { kind: 'jpeg', width: null, height: null };
      }
      const length = (data[offset + 2]! << 8) | data[offset + 3]!;
      if (length <= 0) return null;
      offset += 2 + length;
    }
    return { kind: 'jpeg', width: null, height: null };
  }
  // WEBP: 'RIFF'....'WEBP'.
  if (
    data.length >= 12 &&
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) {
    return { kind: 'webp', width: null, height: null };
  }
  return null;
}
```

Run: `pnpm --filter web test -- image-signature` → PASS.

- [ ] **Step 4: Write the failing attachments-service tests** — `apps/web/src/server/services/maintenance-attachments.test.ts` (same mock scaffolding as Task 8; storage calls mocked on the ctx client). Cases, each with real assertions:

```ts
// 1. createUploadUrl: verifies the parent request is visible + not closed
//    BEFORE minting (chainArgs pin on maintenance_requests.select), mints
//    paths `${orgId}/${requestId}/${uuid}.jpg` + `${uuid}-thumb.webp`, and
//    calls checkRateLimit(`maintenance:upload:${userId}`, 60, 3600000, 'closed').
// 2. createUploadUrl rejects a request that already has MAINTENANCE_MAX_PHOTOS
//    attachments (canned count = 8 -> ServiceError 'conflict').
// 3. createUploadUrl rejects extensions outside jpg/jpeg/png/webp
//    (ServiceError 'validation_error') — HEIC must be transcoded client-side.
// 4. finalize downloads the object (admin client storage.download mocked),
//    sniffs bytes: a PNG body with declaredMime image/png inserts a row whose
//    mime_type/byte_size/width/height come from the SNIFF, not the client.
// 5. finalize REJECTS a body whose magic bytes are not an image: removes the
//    uploaded object (storage.remove called with [path]) and throws
//    'validation_error' with message 'invalid_image' (photo test 6).
// 6. finalize rejects declaredMime mismatch (JPEG bytes + image/png declared).
// 7. finalize rejects oversize (byte length > MAINTENANCE_MAX_PHOTO_BYTES).
// 8. finalize re-asserts the org prefix on `path` — a forged path
//    'other-org/x/y.jpg' throws 'forbidden' BEFORE any storage call.
// 9. remove deletes row + storage objects (both master and thumb).
// 10. signedViewUrls mints signed URLs via the ADMIN client and THROWS on
//     signing failure (never caches a transient error — recurring bug #6).
```

Write each as a real `it(...)` with the canned-data + chainArgs idiom shown in Task 8 Step 1 — the comment block above is the case list, not the test code; the executor writes all ten bodies before implementing.

- [ ] **Step 5: Implement the service** — `apps/web/src/server/services/maintenance-attachments.ts`:

```ts
import 'server-only';

import { MAINTENANCE_MAX_PHOTOS, MAINTENANCE_MAX_PHOTO_BYTES } from '@stockpilot/core';

import { sanitizeFilenameSegment } from '@/lib/exports/filename';
import { sniffImage, MIME_FOR_KIND } from '@/lib/image-signature';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';
import { audit } from '@/server/services/audit';
import { assertModuleEnabled, ServiceError, type ServiceContext } from '@/server/services/context';

const BUCKET = 'maintenance-photos';
const ALLOWED_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp']);

export class MaintenanceAttachmentsService {
  constructor(private ctx: ServiceContext) {}

  /** Parent must be visible (RLS does the org/permission math) and open. */
  private async assertParentOpen(requestId: string) {
    const { data, error } = await this.ctx.supabase
      .from('maintenance_requests')
      .select('id, archived_at, cancelled_at')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', requestId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Maintenance request not found');
    if (data.archived_at || data.cancelled_at) {
      throw new ServiceError('conflict', 'This request is closed; photos can no longer change.');
    }
  }

  async createUploadUrl(requestId: string, args: { fileExt: string; originalFilename: string }) {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    await this.assertParentOpen(requestId);

    const ext = args.fileExt.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) {
      throw new ServiceError('validation_error', 'Photos must be JPEG, PNG, or WEBP. HEIC is converted on your device before upload.');
    }

    const limit = await checkRateLimit(`maintenance:upload:${this.ctx.userId}`, 60, 60 * 60 * 1000, 'closed');
    if (!limit.allowed) throw new ServiceError('conflict', 'Too many uploads in the last hour. Please try again later.');

    const { count, error: countErr } = await this.ctx.supabase
      .from('maintenance_request_attachments')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', this.ctx.organizationId)
      .eq('maintenance_request_id', requestId);
    if (countErr) throw new ServiceError('internal_error', countErr.message);
    if ((count ?? 0) >= MAINTENANCE_MAX_PHOTOS) {
      throw new ServiceError('conflict', `A request can carry at most ${MAINTENANCE_MAX_PHOTOS} photos.`);
    }

    const uuid = crypto.randomUUID();
    const path = `${this.ctx.organizationId}/${requestId}/${uuid}.${ext}`;
    const thumbPath = `${this.ctx.organizationId}/${requestId}/${uuid}-thumb.webp`;
    const [master, thumb] = await Promise.all([
      this.ctx.supabase.storage.from(BUCKET).createSignedUploadUrl(path),
      this.ctx.supabase.storage.from(BUCKET).createSignedUploadUrl(thumbPath),
    ]);
    if (master.error) throw new ServiceError('internal_error', master.error.message);
    if (thumb.error) throw new ServiceError('internal_error', thumb.error.message);
    return {
      path,
      signedUrl: master.data.signedUrl,
      token: master.data.token,
      thumbPath,
      thumbSignedUrl: thumb.data.signedUrl,
      thumbToken: thumb.data.token,
    };
  }

  /** Downloads the just-uploaded object, sniffs REAL bytes, records the row.
   *  A body that is not the image it claims to be is deleted, not stored. */
  async finalize(requestId: string, args: { path: string; thumbPath: string | null; originalFilename: string; declaredMime: string }) {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    await this.assertParentOpen(requestId);

    const prefix = `${this.ctx.organizationId}/${requestId}/`;
    if (!args.path.startsWith(prefix) || (args.thumbPath && !args.thumbPath.startsWith(prefix))) {
      throw new ServiceError('forbidden', 'Invalid upload path.');
    }

    const admin = createAdminClient();
    const { data: blob, error: dlErr } = await admin.storage.from(BUCKET).download(args.path);
    if (dlErr || !blob) throw new ServiceError('validation_error', 'invalid_image');
    const bytes = new Uint8Array(await blob.arrayBuffer());

    const sniffed = sniffImage(bytes);
    const declaredOk = sniffed && MIME_FOR_KIND[sniffed.kind] === args.declaredMime;
    const sizeOk = bytes.byteLength > 0 && bytes.byteLength <= MAINTENANCE_MAX_PHOTO_BYTES;
    if (!sniffed || !declaredOk || !sizeOk) {
      await admin.storage.from(BUCKET).remove([args.path, ...(args.thumbPath ? [args.thumbPath] : [])]);
      throw new ServiceError('validation_error', 'invalid_image');
    }

    const { data: row, error } = await this.ctx.supabase
      .from('maintenance_request_attachments')
      .insert({
        organization_id: this.ctx.organizationId,
        maintenance_request_id: requestId,
        storage_path: args.path,
        thumbnail_path: args.thumbPath,
        original_filename: args.originalFilename.slice(0, 300),
        safe_filename: sanitizeFilenameSegment(args.originalFilename).slice(0, 300) || 'photo',
        mime_type: MIME_FOR_KIND[sniffed.kind],
        byte_size: bytes.byteLength,
        width: sniffed.width,
        height: sniffed.height,
        uploaded_by: this.ctx.userId,
        verified_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (error || !row) {
      // RLS-rejected metadata insert leaves an orphan object: roll it back.
      await admin.storage.from(BUCKET).remove([args.path, ...(args.thumbPath ? [args.thumbPath] : [])]);
      throw new ServiceError('internal_error', error?.message ?? 'Could not record the photo.');
    }
    await audit({ event: 'maintenance_request.attachment_added', entityType: 'maintenance_request', entityId: requestId, extra: { attachment_id: row.id, byte_size: bytes.byteLength } }, this.ctx);
    return { id: row.id as string, width: sniffed.width, height: sniffed.height };
  }

  async remove(requestId: string, attachmentId: string): Promise<void> {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    const { data: att, error } = await this.ctx.supabase
      .from('maintenance_request_attachments')
      .select('id, storage_path, thumbnail_path')
      .eq('organization_id', this.ctx.organizationId)
      .eq('maintenance_request_id', requestId)
      .eq('id', attachmentId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!att) throw new ServiceError('not_found', 'Photo not found');
    const { error: delErr } = await this.ctx.supabase
      .from('maintenance_request_attachments')
      .delete()
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', attachmentId);
    if (delErr) throw new ServiceError('internal_error', delErr.message);
    const admin = createAdminClient();
    await admin.storage.from(BUCKET).remove([
      att.storage_path as string,
      ...((att.thumbnail_path as string | null) ? [att.thumbnail_path as string] : []),
    ]);
    await audit({ event: 'maintenance_request.attachment_removed', entityType: 'maintenance_request', entityId: requestId, extra: { attachment_id: attachmentId } }, this.ctx);
  }

  /** Short-lived signed URLs, minted per view AFTER the RLS-visible row read.
   *  THROWS on signing failure (never return a broken URL — bug #6). Never
   *  logged (GC 27). 1-hour TTL: these are for the app UI, NOT for emails —
   *  emails carry the /m/<token> share page only (landmine 23). */
  async signedViewUrls(requestId: string) {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    const { data: rows, error } = await this.ctx.supabase
      .from('maintenance_request_attachments')
      .select('id, storage_path, thumbnail_path, original_filename, width, height')
      .eq('organization_id', this.ctx.organizationId)
      .eq('maintenance_request_id', requestId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw new ServiceError('internal_error', error.message);
    const admin = createAdminClient();
    const out = [] as { id: string; originalFilename: string; url: string; thumbUrl: string | null; width: number | null; height: number | null }[];
    for (const r of rows ?? []) {
      const master = await admin.storage.from(BUCKET).createSignedUrl(r.storage_path as string, 3600);
      if (master.error || !master.data) throw new ServiceError('internal_error', 'Could not sign photo URL');
      let thumbUrl: string | null = null;
      if (r.thumbnail_path) {
        const thumb = await admin.storage.from(BUCKET).createSignedUrl(r.thumbnail_path as string, 3600);
        if (!thumb.error && thumb.data) thumbUrl = thumb.data.signedUrl;
      }
      out.push({
        id: r.id as string,
        originalFilename: r.original_filename as string,
        url: master.data.signedUrl,
        thumbUrl,
        width: (r.width as number | null) ?? null,
        height: (r.height as number | null) ?? null,
      });
    }
    return out;
  }
}
```

- [ ] **Step 6: Implement the three routes.** `apps/web/src/app/api/v1/maintenance-requests/[id]/attachments/route.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { serviceErrorStatus, ServiceError } from '@/server/services/context';
import { MaintenanceAttachmentsService } from '@/server/services/maintenance-attachments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const mintSchema = z.object({
  fileExt: z.string().trim().min(1).max(5),
  originalFilename: z.string().trim().min(1).max(300),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await params;
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }
  const parsed = mintSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'validation_error' }, { status: 400 });
  try {
    const res = await new MaintenanceAttachmentsService(ctx).createUploadUrl(id, parsed.data);
    return NextResponse.json(res);
  } catch (e) {
    if (e instanceof ServiceError) return NextResponse.json({ error: e.code, message: e.message }, { status: serviceErrorStatus(e.code) });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
```

`finalize/route.ts` mirrors it with `z.object({ path: z.string().min(1).max(500), thumbPath: z.string().max(500).nullish(), originalFilename: z.string().trim().min(1).max(300), declaredMime: z.enum(['image/png', 'image/jpeg', 'image/webp']) })` calling `finalize(id, { ...parsed.data, thumbPath: parsed.data.thumbPath ?? null })`. `[attachmentId]/route.ts` exports `DELETE` calling `remove(id, attachmentId)` with the same error mapping. Write both files in full — same imports, same ServiceError mapping, no shortcuts.

- [ ] **Step 7: Run to verify pass.**

Run: `pnpm --filter web test -- image-signature maintenance-attachments && pnpm --filter web typecheck`
Expected: PASS (all sniffer + all ten service cases).

- [ ] **Step 8: Commit.**

```bash
git add apps/web/src/lib/image-signature.ts apps/web/src/lib/image-signature.test.ts \
        apps/web/src/server/services/maintenance-attachments.ts \
        apps/web/src/server/services/maintenance-attachments.test.ts \
        apps/web/src/app/api/v1/maintenance-requests
git commit -m "feat(maintenance): hardened photo uploads - server mint, magic-byte finalize, rate limits"
```

## Task 10: Share links (0261 token pattern) + the public `/m/[token]` page

**Files:**
- Create: `apps/web/src/server/services/maintenance-share-links.ts`
- Create: `apps/web/src/server/services/maintenance-share-links.test.ts`
- Create: `apps/web/src/app/m/[token]/page.tsx`

**Interfaces:**
- Consumes: `maintenance_request_share_links` table (Task 1); `MAINTENANCE_SHARE_LINK_TTL_DAYS` (Task 6); `checkRateLimit`; `createAdminClient`; `MaintenanceAttachmentsService`-style signed reads (re-implemented on the admin client here — the anonymous viewer has no ServiceContext).
- Produces:

```ts
export class MaintenanceShareLinksService {
  constructor(ctx: ServiceContext);
  /** Returns the existing ACTIVE unexpired link or mints one. URL shape:
   *  `${APP_URL}/m/${token}` — an APP URL, never a signed storage URL. */
  ensureActiveLink(requestId: string): Promise<{ token: string; url: string; expiresAt: string }>;
  revoke(requestId: string): Promise<void>;
}
/** Anonymous resolution — module-scoped function, admin client, generic null on ANY miss. */
export function resolveMaintenanceShareToken(token: string): Promise<{
  requestNumber: string; subject: string; description: string; siteName: string | null;
  createdAt: string; photos: { url: string; thumbUrl: string | null; filename: string }[];
} | null>;
```

- [ ] **Step 1: Write the failing tests.** Cases (write each as a real `it()` with the Task 8 mock idiom):

```ts
// 1. ensureActiveLink requires maintenance_requests:submit on own request OR
//    manage; the parent visibility read is chainArgs-pinned.
// 2. Token minting: 64 hex chars from crypto.getRandomValues(32 bytes);
//    expires_at is ~180 days out (assert 179 < days < 181); insert runs on the
//    ADMIN client (share_links has no authenticated write policy).
// 3. Reusing: an existing active, unexpired row is returned, no new insert.
// 4. revoke sets active=false + revoked_at, audits share_link_revoked.
// 5. resolveMaintenanceShareToken: unknown token -> null; inactive -> null;
//    expired (expires_at < now) -> null — all INDISTINGUISHABLE (generic null).
// 6. resolve returns ONLY request number/subject/description/site/photos —
//    the shape above has no requester email/phone and no notes; assert the
//    resolved object's keys exactly.
// 7. resolve mints photo signed URLs at view time; storage paths never appear
//    in the return value (assert no '/maintenance-photos/' raw path leaks).
```

- [ ] **Step 2: Run to verify failure.** `pnpm --filter web test -- maintenance-share-links` → FAIL.

- [ ] **Step 3: Implement the service** (key parts — write the full file with the standard imports from Tasks 8/9):

```ts
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://stockpilotusa.com';
const BUCKET = 'maintenance-photos';

function mintToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class MaintenanceShareLinksService {
  constructor(private ctx: ServiceContext) {}

  async ensureActiveLink(requestId: string) {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    // Visibility: the RLS-scoped parent read answers "may this caller see it";
    // requester-own or read_all/manage both pass, matching brief section 5.
    const { data: parent, error } = await this.ctx.supabase
      .from('maintenance_requests')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', requestId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!parent) throw new ServiceError('not_found', 'Maintenance request not found');

    const admin = createAdminClient();
    const nowIso = new Date().toISOString();
    const { data: existing } = await admin
      .from('maintenance_request_share_links')
      .select('token, expires_at')
      .eq('organization_id', this.ctx.organizationId)
      .eq('maintenance_request_id', requestId)
      .eq('active', true)
      .gt('expires_at', nowIso)
      .maybeSingle();
    if (existing) {
      return { token: existing.token as string, url: `${APP_URL}/m/${existing.token}`, expiresAt: existing.expires_at as string };
    }

    const token = mintToken();
    const expiresAt = new Date(Date.now() + MAINTENANCE_SHARE_LINK_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { error: insErr } = await admin.from('maintenance_request_share_links').insert({
      organization_id: this.ctx.organizationId,
      maintenance_request_id: requestId,
      token,
      active: true,
      expires_at: expiresAt,
      created_by: this.ctx.userId,
    });
    if (insErr) throw new ServiceError('internal_error', insErr.message);
    await audit({ event: 'maintenance_request.share_link_created', entityType: 'maintenance_request', entityId: requestId, extra: { expires_at: expiresAt } }, this.ctx);
    return { token, url: `${APP_URL}/m/${token}`, expiresAt };
  }

  async revoke(requestId: string) {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    assertPermission(this.ctx, 'maintenance_requests:manage');
    const admin = createAdminClient();
    const { error } = await admin
      .from('maintenance_request_share_links')
      .update({ active: false, revoked_at: new Date().toISOString() })
      .eq('organization_id', this.ctx.organizationId)
      .eq('maintenance_request_id', requestId)
      .eq('active', true);
    if (error) throw new ServiceError('internal_error', error.message);
    await audit({ event: 'maintenance_request.share_link_revoked', entityType: 'maintenance_request', entityId: requestId }, this.ctx);
  }
}

export async function resolveMaintenanceShareToken(token: string) {
  if (!/^[0-9a-f]{16,128}$/i.test(token)) return null;
  const admin = createAdminClient();
  const { data: link } = await admin
    .from('maintenance_request_share_links')
    .select('maintenance_request_id, organization_id, active, expires_at')
    .eq('token', token)
    .maybeSingle();
  if (!link || !link.active || new Date(link.expires_at as string).getTime() < Date.now()) return null;

  const { data: req } = await admin
    .from('maintenance_requests')
    .select('request_number, created_at, subject, description, charters!charter_id(name)')
    .eq('id', link.maintenance_request_id as string)
    .maybeSingle();
  if (!req) return null;

  const { data: atts } = await admin
    .from('maintenance_request_attachments')
    .select('storage_path, thumbnail_path, safe_filename')
    .eq('maintenance_request_id', link.maintenance_request_id as string)
    .order('sort_order', { ascending: true });

  const photos = [] as { url: string; thumbUrl: string | null; filename: string }[];
  for (const a of atts ?? []) {
    const m = await admin.storage.from(BUCKET).createSignedUrl(a.storage_path as string, 3600);
    if (m.error || !m.data) continue; // one broken photo never breaks the page
    let thumbUrl: string | null = null;
    if (a.thumbnail_path) {
      const t = await admin.storage.from(BUCKET).createSignedUrl(a.thumbnail_path as string, 3600);
      if (!t.error && t.data) thumbUrl = t.data.signedUrl;
    }
    photos.push({ url: m.data.signedUrl, thumbUrl, filename: a.safe_filename as string });
  }

  const charter = (req as Record<string, unknown>).charters as { name?: string } | null;
  return {
    requestNumber:
      formatMaintenanceRequestNumber(req.request_number as number, req.created_at as string) ?? 'MR',
    subject: req.subject as string,
    description: req.description as string,
    siteName: charter?.name ?? null,
    createdAt: req.created_at as string,
    photos,
  };
}
```

- [ ] **Step 4: The public page** — `apps/web/src/app/m/[token]/page.tsx` (server component; per-IP closed-mode rate limit; generic 404 via `notFound()` for every miss so token probing learns nothing):

```tsx
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';

import { checkRateLimit } from '@/lib/rate-limit';
import { resolveMaintenanceShareToken } from '@/server/services/maintenance-share-links';

export const dynamic = 'force-dynamic';

export default async function MaintenanceSharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const h = await headers();
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const [ipLimit, tokenLimit] = await Promise.all([
    checkRateLimit(`maintenance:share:ip:${ip}`, 60, 60 * 60 * 1000, 'closed'),
    checkRateLimit(`maintenance:share:token:${token.slice(0, 32)}`, 120, 60 * 60 * 1000, 'closed'),
  ]);
  if (!ipLimit.allowed || !tokenLimit.allowed) notFound();

  const shared = await resolveMaintenanceShareToken(token);
  if (!shared) notFound();

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <header>
        <p className="text-sm text-muted-foreground">StockPilot maintenance request</p>
        <h1 className="text-xl font-semibold">{shared.requestNumber}</h1>
        <p className="mt-1">{shared.subject}</p>
        {shared.siteName ? <p className="text-sm text-muted-foreground">Site: {shared.siteName}</p> : null}
      </header>
      <section>
        <h2 className="text-sm font-medium">Issue description</h2>
        <p className="mt-1 whitespace-pre-line text-sm">{shared.description}</p>
      </section>
      {shared.photos.length > 0 ? (
        <section>
          <h2 className="text-sm font-medium">Photos ({shared.photos.length})</h2>
          <ul className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {shared.photos.map((p) => (
              <li key={p.url}>
                <a href={p.url} target="_blank" rel="noopener noreferrer">
                  {/* Signed URLs are short-lived; plain img is correct here. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.thumbUrl ?? p.url} alt={p.filename} className="h-32 w-full rounded-lg border object-cover" />
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <footer className="border-t pt-4 text-xs text-muted-foreground">
        This page shows one maintenance request shared from StockPilot. Internal notes are never shown here.
      </footer>
    </main>
  );
}
```

- [ ] **Step 5: Run to verify pass.** `pnpm --filter web test -- maintenance-share-links && pnpm --filter web typecheck` → PASS.

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/server/services/maintenance-share-links.ts \
        apps/web/src/server/services/maintenance-share-links.test.ts \
        apps/web/src/app/m
git commit -m "feat(maintenance): revocable share links and public share page"
```

## Task 11: `/api/v1/maintenance-requests` — list, create, detail, update, draft-opened, share-link

**Files:**
- Create: `apps/web/src/app/api/v1/maintenance-requests/route.ts` (GET list, POST create)
- Create: `apps/web/src/app/api/v1/maintenance-requests/[id]/route.ts` (GET detail incl. photos + email input, PATCH update)
- Create: `apps/web/src/app/api/v1/maintenance-requests/[id]/draft-opened/route.ts` (POST)
- Create: `apps/web/src/app/api/v1/maintenance-requests/[id]/share-link/route.ts` (POST ensure, DELETE revoke)
- Create: `apps/web/src/app/api/v1/maintenance-requests/route.test.ts` (+ one test file per sibling route, same scaffolding)

**Interfaces:**
- Consumes: Task 8/9/10 services; `withApiContext`; `serviceErrorStatus`.
- Produces (mobile Task 18-20 consumes these EXACT JSON shapes):
  - `GET /api/v1/maintenance-requests?scope=mine|all&q=&status=` → `{ requests: MaintenanceRequestListRow[] }`
  - `POST /api/v1/maintenance-requests` body = `MaintenanceRequestFormValues` → `{ id, requestNumber, createdAt }`
  - `GET /api/v1/maintenance-requests/[id]` → `{ request: MaintenanceRequestDetail, photos: {id,originalFilename,url,thumbUrl,width,height}[], emailInput: MaintenanceEmailInput, canManage: boolean }`
  - `PATCH .../[id]` body partial form values → `{ ok: true }`
  - `POST .../[id]/draft-opened` → `{ openCount: number }`
  - `POST .../[id]/share-link` → `{ url, expiresAt }`; `DELETE` → `{ ok: true }`

- [ ] **Step 1: Write the failing route tests.** Follow the house route-test scaffolding (mock `@/lib/auth/api-context` per-file). Cases per route, all real `it()` bodies:

```ts
// route.ts (list/create):
// 1. 401 with no context (withApiContext -> null).
// 2. GET default scope is 'mine'; scope=all forwards to the service (spy on
//    MaintenanceRequestsService.prototype.list).
// 3. POST parses the body with maintenanceRequestFormSchema through the
//    service and returns { id, requestNumber, createdAt }.
// 4. POST maps ServiceError('module_disabled') -> 403 (assert status).
// 5. GET NEVER touches Zendesk: assert global fetch spy uninvoked.
// [id]/route.ts:
// 6. GET returns detail + photos + emailInput; emailInput.shareUrl is null
//    when the org settings disable links-in-email, else the ensured link URL
//    (settings read mocked via organization_modules.select canned data).
// 7. PATCH forwards to service.update; 403 for foreign requester (ServiceError).
// draft-opened/route.ts:
// 8. POST returns { openCount } and calls service.recordDraftOpened once;
//    response body contains no 'sent'/'ticket' language (stringify sweep).
// share-link/route.ts:
// 9. POST returns { url, expiresAt } with url starting APP_URL + '/m/';
// 10. DELETE calls revoke; 403 without manage (ServiceError passthrough).
```

- [ ] **Step 2: Run to verify failure.** `pnpm --filter web test -- api/v1/maintenance-requests` → FAIL.

- [ ] **Step 3: Implement the routes.** `route.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { serviceErrorStatus, ServiceError } from '@/server/services/context';
import { MaintenanceRequestsService } from '@/server/services/maintenance-requests';
import type { MaintenanceStatus } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function mapError(e: unknown) {
  if (e instanceof ServiceError) {
    return NextResponse.json({ error: e.code, message: e.message }, { status: serviceErrorStatus(e.code) });
  }
  return NextResponse.json({ error: 'internal_error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const url = new URL(req.url);
  const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'mine';
  const q = url.searchParams.get('q') ?? undefined;
  const statusParam = url.searchParams.get('status');
  const status = (['saved', 'draft_opened', 'archived', 'cancelled', 'active'] as const).find((s) => s === statusParam);
  try {
    const requests = await new MaintenanceRequestsService(ctx).list({ scope, q, status: status as MaintenanceStatus | 'active' | undefined });
    return NextResponse.json({ requests });
  } catch (e) { return mapError(e); }
}

export async function POST(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }
  try {
    const res = await new MaintenanceRequestsService(ctx).create(body);
    return NextResponse.json(res, { status: 201 });
  } catch (e) { return mapError(e); }
}
```

`[id]/route.ts` (GET assembles detail + photos + emailInput; the share URL is included only when the org setting allows it):

```ts
import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { can, serviceErrorStatus, ServiceError } from '@/server/services/context';
import { MaintenanceRequestsService } from '@/server/services/maintenance-requests';
import { MaintenanceAttachmentsService } from '@/server/services/maintenance-attachments';
import { MaintenanceShareLinksService } from '@/server/services/maintenance-share-links';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function mapError(e: unknown) {
  if (e instanceof ServiceError) {
    return NextResponse.json({ error: e.code, message: e.message }, { status: serviceErrorStatus(e.code) });
  }
  return NextResponse.json({ error: 'internal_error' }, { status: 500 });
}

async function shareLinksEnabled(ctx: Awaited<ReturnType<typeof withApiContext>> & object): Promise<boolean> {
  const { data } = await ctx!.supabase
    .from('organization_modules')
    .select('settings')
    .eq('organization_id', ctx!.organizationId)
    .eq('module_id', 'maintenance_requests')
    .maybeSingle();
  const settings = (data?.settings as { includeShareLinksInEmail?: boolean } | null) ?? null;
  return settings?.includeShareLinksInEmail !== false; // default ON
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await params;
  try {
    const svc = new MaintenanceRequestsService(ctx);
    const request = await svc.get(id);
    const photos = await new MaintenanceAttachmentsService(ctx).signedViewUrls(id);
    let shareUrl: string | null = null;
    if (request.photoCount > 0 && (await shareLinksEnabled(ctx))) {
      shareUrl = (await new MaintenanceShareLinksService(ctx).ensureActiveLink(id)).url;
    }
    const emailInput = await svc.emailInput(id, { shareUrl });
    return NextResponse.json({
      request,
      photos,
      emailInput,
      canManage: can(ctx, 'maintenance_requests:manage'),
    });
  } catch (e) { return mapError(e); }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await params;
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }
  try {
    await new MaintenanceRequestsService(ctx).update(id, body);
    return NextResponse.json({ ok: true });
  } catch (e) { return mapError(e); }
}
```

`draft-opened/route.ts` — POST calling `recordDraftOpened(id)` returning `{ openCount }`; `share-link/route.ts` — POST calling `ensureActiveLink(id)` returning `{ url, expiresAt }` and DELETE calling `revoke(id)` returning `{ ok: true }`. Same imports, same `mapError`. Write both files in full.

- [ ] **Step 4: Run to verify pass.** `pnpm --filter web test -- api/v1/maintenance-requests && pnpm --filter web typecheck` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/app/api/v1/maintenance-requests
git commit -m "feat(maintenance): v1 API routes for requests, draft-opened, share links"
```

---

# Phase D — Web UI

Dashboard routes per the cycle-counts/returns conventions. Every page opens with `checkModuleAccess('maintenance_requests')` → `ModuleNotEnabled`, then `requireOrgContext` + permission gate. All copy obeys the status vocabulary; every rendered surface gets a forbidden-phrase sweep test. `sf-*` classes never appear (they are storefront-only CSS); the dialog work overrides `max-w-lg` per call site.

## Task 12: Navigation is live + the list page (my/all)

**Files:**
- Create: `apps/web/src/app/(dashboard)/dashboard/maintenance/page.tsx`
- Create: `apps/web/src/app/(dashboard)/dashboard/maintenance/loading.tsx`
- Create: `apps/web/src/components/maintenance/maintenance-status-badge.tsx`
- Create: `apps/web/src/components/maintenance/maintenance-status-badge.test.tsx`

**Interfaces:**
- Consumes: Task 3 nav placement (`/dashboard/maintenance` renders automatically once the module is enabled — `navForRole` derives from the registry; verify by enabling the module for the dev org locally); Task 8 `MaintenanceRequestsService.list`; `MAINTENANCE_STATUS_LABELS`, `formatMaintenanceRequestNumber` from core; `EmptyState` from `@/components/ui/empty-state`; `TablePageSkeleton` for loading.
- Produces: the list page URL contract `/dashboard/maintenance?scope=mine|all&status=&q=` (Tasks 13-15 link back to it); `MaintenanceStatusBadge({ status })`.

- [ ] **Step 1: Write the failing badge test** — `maintenance-status-badge.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MaintenanceStatusBadge } from './maintenance-status-badge';

describe('MaintenanceStatusBadge', () => {
  it('renders the four sanctioned labels and nothing else (brief section 20)', () => {
    const { rerender } = render(<MaintenanceStatusBadge status="saved" />);
    expect(screen.getByText('Saved')).toBeInTheDocument();
    rerender(<MaintenanceStatusBadge status="draft_opened" />);
    expect(screen.getByText('Email draft opened')).toBeInTheDocument();
    rerender(<MaintenanceStatusBadge status="archived" />);
    expect(screen.getByText('Archived')).toBeInTheDocument();
    rerender(<MaintenanceStatusBadge status="cancelled" />);
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  });
  it('never renders forbidden phrases', () => {
    render(<MaintenanceStatusBadge status="draft_opened" />);
    for (const banned of ['Email sent', 'Ticket created', 'submitted to Zendesk']) {
      expect(screen.queryByText(banned)).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure.** `pnpm --filter web test -- maintenance-status-badge` → FAIL (missing module).

- [ ] **Step 3: Implement.** `maintenance-status-badge.tsx`:

```tsx
import { Badge } from '@/components/ui/badge';
import { MAINTENANCE_STATUS_LABELS, type MaintenanceStatus } from '@stockpilot/core';

const VARIANTS: Record<MaintenanceStatus, string> = {
  saved: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
  draft_opened: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
  archived: 'bg-muted text-muted-foreground',
  cancelled: 'bg-muted text-muted-foreground line-through',
};

export function MaintenanceStatusBadge({ status }: { status: MaintenanceStatus }) {
  return <Badge className={VARIANTS[status]}>{MAINTENANCE_STATUS_LABELS[status]}</Badge>;
}
```

`page.tsx` (server component — the cycle-counts/returns shape: gate, then table with Link filter pills):

```tsx
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ModuleNotEnabled } from '@/components/modules/module-not-enabled';
import { requireOrgContext } from '@/lib/auth/session';
import { withContext, can } from '@/server/services/context';
import { MaintenanceRequestsService } from '@/server/services/maintenance-requests';
import { MaintenanceStatusBadge } from '@/components/maintenance/maintenance-status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatMaintenanceRequestNumber } from '@stockpilot/core';
import { Wrench } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function MaintenancePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const access = await checkModuleAccess('maintenance_requests');
  if (!access.enabled) return <ModuleNotEnabled moduleId="maintenance_requests" canManage={access.canManage} />;
  await requireOrgContext();
  const ctx = await withContext();
  if (!can(ctx, 'maintenance_requests:submit') && !can(ctx, 'maintenance_requests:read_all') && !can(ctx, 'maintenance_requests:manage')) {
    redirect('/dashboard');
  }

  const sp = await searchParams;
  const canReadAll = can(ctx, 'maintenance_requests:read_all') || can(ctx, 'maintenance_requests:manage');
  const scope = sp.scope === 'all' && canReadAll ? 'all' : 'mine';
  const status = (['saved', 'draft_opened', 'archived', 'cancelled', 'active'] as const).find((s) => s === sp.status);
  const rows = await new MaintenanceRequestsService(ctx).list({ scope, q: sp.q, status });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{scope === 'all' ? 'All maintenance requests' : 'My maintenance requests'}</h1>
          <p className="text-sm text-muted-foreground">
            Ticket updates and replies are handled through the Outlook/Zendesk email conversation and are not synchronized into StockPilot.
          </p>
        </div>
        <Button asChild><Link href="/dashboard/maintenance/new">New maintenance request</Link></Button>
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        <Link className={scope === 'mine' ? 'font-medium underline' : 'text-muted-foreground'} href="/dashboard/maintenance?scope=mine">My requests</Link>
        {canReadAll ? (
          <Link className={scope === 'all' ? 'font-medium underline' : 'text-muted-foreground'} href="/dashboard/maintenance?scope=all">All requests</Link>
        ) : null}
        {(['active', 'saved', 'draft_opened', 'archived', 'cancelled'] as const).map((s) => (
          <Link key={s} className={status === s ? 'font-medium underline' : 'text-muted-foreground'} href={`/dashboard/maintenance?scope=${scope}&status=${s}`}>
            {s === 'active' ? 'Active' : s === 'saved' ? 'Saved' : s === 'draft_opened' ? 'Email draft opened' : s === 'archived' ? 'Archived' : 'Cancelled'}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={Wrench} title="No maintenance requests" description="Report a facilities or equipment issue and StockPilot will prepare the email for you." />
      ) : (
        <div className="bg-card overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Request</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Site</TableHead>
                {scope === 'all' ? <TableHead>Requester</TableHead> : null}
                <TableHead>Photos</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link className="font-medium underline-offset-2 hover:underline" href={`/dashboard/maintenance/${r.id}`}>
                      {formatMaintenanceRequestNumber(r.requestNumber, r.createdAt) ?? r.requestNumber}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-[28ch] truncate">{r.subject}</TableCell>
                  <TableCell><MaintenanceStatusBadge status={r.status} /></TableCell>
                  <TableCell className="capitalize">{r.priority}</TableCell>
                  <TableCell>{r.siteName ?? '-'}</TableCell>
                  {scope === 'all' ? <TableCell>{r.requesterName}</TableCell> : null}
                  <TableCell>{r.photoCount || '-'}</TableCell>
                  <TableCell>{new Date(r.createdAt).toLocaleDateString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
```

`loading.tsx` renders the house `TablePageSkeleton` exactly as the returns route does (copy that file's one-liner).

NOTE: `ModuleNotEnabled` props — mirror the exact call cycle-counts/page.tsx:26-38 makes (Read it first; adjust the props line, not the pattern).

- [ ] **Step 4: Run to verify pass.** `pnpm --filter web test -- maintenance-status-badge && pnpm --filter web typecheck` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/app/\(dashboard\)/dashboard/maintenance apps/web/src/components/maintenance
git commit -m "feat(maintenance): web list page, status badge, loading skeleton"
```

## Task 13: The form, the photos panel, and `/dashboard/maintenance/new`

**Files:**
- Create: `apps/web/src/components/maintenance/maintenance-request-form.tsx`
- Create: `apps/web/src/components/maintenance/maintenance-request-form.test.tsx`
- Create: `apps/web/src/components/maintenance/maintenance-photos-panel.tsx`
- Create: `apps/web/src/components/maintenance/maintenance-photos-panel.test.tsx`
- Create: `apps/web/src/app/(dashboard)/dashboard/maintenance/new/page.tsx`

**Interfaces:**
- Consumes: `maintenanceRequestFormSchema`, `MAINTENANCE_CATEGORIES`, `MAINTENANCE_PRIORITIES`, `MAINTENANCE_MAX_PHOTOS` (core); `createMaintenanceRequestAction` (Task 8); attachment mint/finalize routes (Task 9) via `fetch`; `compressImageVariants` from `@/lib/image-variants` (HEIC transcode + thumb); sonner `toast`.
- Produces: `MaintenanceRequestForm({ defaults, sites, categories, onSaved })` where `defaults: Partial<MaintenanceRequestFormValues>` (launch-point prefill), `sites: { id: string; name: string }[]` (charters), `categories: string[]` (org-configured or the default twelve), `onSaved(id: string): void`; `MaintenancePhotosPanel({ requestId, photos, onChange })` used on BOTH the new flow (after save) and the detail page.

- [ ] **Step 1: Write the failing form tests** — `maintenance-request-form.test.tsx` (happy-dom; mock the server action per-file). Cases = Brief §31 component tests 1-4 + 13:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createAction = vi.fn(async () => ({ ok: true as const, id: 'r1', requestNumber: 1, createdAt: '2026-08-05T16:15:00Z' }));
vi.mock('@/server/actions/maintenance-requests', () => ({
  createMaintenanceRequestAction: (...args: unknown[]) => createAction(...args),
}));

import { MaintenanceRequestForm } from './maintenance-request-form';

const SITES = [{ id: '44444444-4444-4444-4444-444444444444', name: 'Fresno Learning Center' }];

beforeEach(() => vi.clearAllMocks());

function renderForm(defaults = {}) {
  const onSaved = vi.fn();
  render(<MaintenanceRequestForm defaults={defaults} sites={SITES} categories={['Facilities', 'Other']} onSaved={onSaved} />);
  return { onSaved };
}

describe('MaintenanceRequestForm', () => {
  it('(1) subject is required with the exact label and placeholder from brief section 7', async () => {
    renderForm();
    expect(screen.getByLabelText('What is the issue?')).toHaveAttribute('placeholder', 'Example: Air conditioner is not working in Room 204');
    await userEvent.click(screen.getByRole('button', { name: 'Save request' }));
    expect(await screen.findByText(/at least 5 characters/i)).toBeInTheDocument();
    expect(createAction).not.toHaveBeenCalled();
  });

  it('(2) description is required with its label and helper text', async () => {
    renderForm();
    expect(screen.getByLabelText('Describe the maintenance issue')).toBeInTheDocument();
    expect(screen.getByText('Explain what is happening, when it started, and anything the maintenance team should know before arriving.')).toBeInTheDocument();
  });

  it('(3) site defaults from the provided default charter', () => {
    renderForm({ charterId: '44444444-4444-4444-4444-444444444444' });
    expect(screen.getByText('Fresno Learning Center')).toBeInTheDocument();
  });

  it('(4) related item prepopulates from launch-point defaults and is shown to the user', () => {
    renderForm({ relatedItemId: '11111111-1111-1111-1111-111111111111' });
    expect(screen.getByText(/linked record/i)).toBeInTheDocument();
  });

  it('(13) there is NO recipient field anywhere — To/CC are not user-editable', () => {
    renderForm();
    expect(screen.queryByLabelText(/to\b/i)).toBeNull();
    expect(screen.queryByDisplayValue('dc4@learn4life.org')).toBeNull();
    expect(screen.queryByDisplayValue('arosas@cvwest.org')).toBeNull();
  });

  it('submits valid values and hands the new id to onSaved', async () => {
    const { onSaved } = renderForm();
    await userEvent.type(screen.getByLabelText('What is the issue?'), 'Air conditioner is not working in Room 204');
    await userEvent.type(screen.getByLabelText('Describe the maintenance issue'), 'Blowing warm air since yesterday afternoon.');
    await userEvent.click(screen.getByRole('button', { name: 'Save request' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('r1'));
    const submitted = createAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(submitted.subject).toBe('Air conditioner is not working in Room 204');
    // No recipient keys can ride along:
    expect('to' in submitted || 'cc' in submitted).toBe(false);
  });

  it('urgent priority shows the safety guidance without claiming emergency coverage', async () => {
    renderForm();
    await userEvent.click(screen.getByLabelText('Priority'));
    await userEvent.click(await screen.findByRole('option', { name: 'Urgent' }));
    expect(screen.getByText('For emergencies that put people in danger, follow your site emergency procedures first. StockPilot does not replace them.')).toBeInTheDocument();
  });
});
```

Also create `maintenance-photos-panel.test.tsx` (this is Brief §31 component test 5 — photos preview):

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MaintenancePhotosPanel } from './maintenance-photos-panel';

const PHOTOS = [
  { id: 'p1', originalFilename: 'leak.jpg', url: 'https://files.example.test/leak.jpg', thumbUrl: null },
  { id: 'p2', originalFilename: 'panel.png', url: 'https://files.example.test/panel.png', thumbUrl: 'https://files.example.test/panel-thumb.webp' },
];

afterEach(() => vi.unstubAllGlobals());

describe('MaintenancePhotosPanel (component test 5)', () => {
  it('previews every uploaded photo with a remove affordance and the count', () => {
    render(<MaintenancePhotosPanel requestId="r1" photos={PHOTOS} onChange={vi.fn()} />);
    expect(screen.getByAltText('leak.jpg')).toBeInTheDocument();
    expect(screen.getByAltText('panel.png')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove leak.jpg' })).toBeInTheDocument();
    expect(screen.getByText('Photos (2/8)')).toBeInTheDocument();
  });

  it('removing a photo calls the DELETE endpoint and notifies the parent to refetch', async () => {
    const onChange = vi.fn();
    const fetchSpy = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal('fetch', fetchSpy);
    render(<MaintenancePhotosPanel requestId="r1" photos={PHOTOS} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove leak.jpg' }));
    expect(fetchSpy).toHaveBeenCalledWith('/api/v1/maintenance-requests/r1/attachments/p1', { method: 'DELETE' });
    expect(onChange).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure.** `pnpm --filter web test -- maintenance-request-form` → FAIL.

- [ ] **Step 3: Implement the form** — `maintenance-request-form.tsx`. RHF + zodResolver on the shared schema; copy the `Field`/`Section` locals from `item-form.tsx:2248-2350` (they are file-local by convention — copy, don't import). The complete component:

```tsx
'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';

import {
  maintenanceRequestFormSchema,
  MAINTENANCE_PRIORITIES,
  type MaintenanceRequestFormValues,
} from '@stockpilot/core';
import { createMaintenanceRequestAction } from '@/server/actions/maintenance-requests';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

interface Props {
  defaults: Partial<MaintenanceRequestFormValues>;
  sites: { id: string; name: string }[];
  categories: string[];
  onSaved: (id: string) => void;
}

const PRIORITY_LABELS = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' } as const;

export function MaintenanceRequestForm({ defaults, sites, categories, onSaved }: Props) {
  const [busy, setBusy] = useState(false);
  const form = useForm<MaintenanceRequestFormValues>({
    resolver: zodResolver(maintenanceRequestFormSchema),
    defaultValues: { priority: 'normal', ...defaults },
  });
  const priority = form.watch('priority');
  const hasLinkedRecord = Boolean(
    defaults.relatedItemId || defaults.relatedOrderRequestId || defaults.relatedRentalId,
  );

  async function onSubmit(values: MaintenanceRequestFormValues) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await createMaintenanceRequestAction(values);
      if ('error' in res) {
        toast.error(res.error.message);
        return;
      }
      onSaved(res.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6" noValidate>
      <div className="space-y-2">
        <Label htmlFor="mr-subject">What is the issue?</Label>
        <Input id="mr-subject" placeholder="Example: Air conditioner is not working in Room 204" {...form.register('subject')} />
        {form.formState.errors.subject ? <p className="text-sm text-destructive">{form.formState.errors.subject.message}</p> : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="mr-description">Describe the maintenance issue</Label>
        <p className="text-sm text-muted-foreground">Explain what is happening, when it started, and anything the maintenance team should know before arriving.</p>
        <Textarea id="mr-description" rows={6} {...form.register('description')} />
        {form.formState.errors.description ? <p className="text-sm text-destructive">{form.formState.errors.description.message}</p> : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="mr-site">Site</Label>
          <Select value={form.watch('charterId') ?? ''} onValueChange={(v) => form.setValue('charterId', v || null)}>
            <SelectTrigger id="mr-site"><SelectValue placeholder="Select a site" /></SelectTrigger>
            <SelectContent>
              {sites.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="mr-category">Category</Label>
          <Select value={form.watch('category') ?? ''} onValueChange={(v) => form.setValue('category', v || null)}>
            <SelectTrigger id="mr-category"><SelectValue placeholder="Select a category" /></SelectTrigger>
            <SelectContent>
              {categories.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="mr-priority">Priority</Label>
          <Select value={priority} onValueChange={(v) => form.setValue('priority', v as MaintenanceRequestFormValues['priority'])}>
            <SelectTrigger id="mr-priority" aria-label="Priority"><SelectValue /></SelectTrigger>
            <SelectContent>
              {MAINTENANCE_PRIORITIES.map((p) => <SelectItem key={p} value={p}>{PRIORITY_LABELS[p]}</SelectItem>)}
            </SelectContent>
          </Select>
          {priority === 'urgent' ? (
            <p className="rounded-md border border-dashed p-2 text-sm text-muted-foreground">
              For emergencies that put people in danger, follow your site emergency procedures first. StockPilot does not replace them.
            </p>
          ) : null}
        </div>
        <div className="space-y-2">
          <Label htmlFor="mr-phone">Contact phone (optional)</Label>
          <Input id="mr-phone" {...form.register('requesterPhone')} />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="mr-building">Building</Label>
          <Input id="mr-building" placeholder="Main building" {...form.register('building')} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="mr-room">Room or area</Label>
          <Input id="mr-room" placeholder="Room 204" {...form.register('roomOrArea')} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="mr-department">Department</Label>
          <Input id="mr-department" {...form.register('department')} />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="mr-access">Additional access instructions</Label>
        <Textarea id="mr-access" rows={2} {...form.register('accessInstructions')} />
      </div>

      {hasLinkedRecord ? (
        <p className="rounded-md border border-dashed p-2 text-sm text-muted-foreground">
          Linked record attached. The related StockPilot record will be included in the email automatically.
        </p>
      ) : null}

      <Button type="submit" disabled={busy}>{busy ? 'Saving...' : 'Save request'}</Button>
    </form>
  );
}
```

- [ ] **Step 4: Implement the photos panel** — `maintenance-photos-panel.tsx`. Client component; mint → PUT (`uploadToSignedUrl` semantics via plain `fetch` PUT with the token URL) → finalize; HEIC handled inside `compressImageVariants` (it transcodes via heic2any in a worker and produces the 400px thumb — landmine 27 note: verify `image-variants.worker.ts:20` and fix the 200/400 drift IN PASSING or record that you inherit 200px thumbs):

```tsx
'use client';

import { useRef, useState } from 'react';
import { toast } from 'sonner';

import { MAINTENANCE_MAX_PHOTOS } from '@stockpilot/core';
import { compressImageVariants } from '@/lib/image-variants';
import { Button } from '@/components/ui/button';

export interface PanelPhoto {
  id: string; originalFilename: string; url: string; thumbUrl: string | null;
}

interface Props {
  requestId: string;
  photos: PanelPhoto[];
  onChange: () => void; // parent refetches
}

export function MaintenancePhotosPanel({ requestId, photos, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function uploadOne(file: File) {
    // 1) Client-side resize + HEIC->JPEG/WebP transcode + thumb generation.
    const variants = await compressImageVariants(file);
    const ext = variants.master.type === 'image/webp' ? 'webp' : variants.master.type === 'image/png' ? 'png' : 'jpg';
    // 2) Server mint (rate-limited, entity-checked).
    const mintRes = await fetch(`/api/v1/maintenance-requests/${requestId}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileExt: ext, originalFilename: file.name }),
    });
    if (!mintRes.ok) throw new Error((await mintRes.json().catch(() => null))?.message ?? 'Upload not allowed right now.');
    const mint = await mintRes.json();
    // 3) PUT master + thumb to the signed URLs.
    const putMaster = await fetch(mint.signedUrl, { method: 'PUT', headers: { 'Content-Type': variants.master.type }, body: variants.master });
    if (!putMaster.ok) throw new Error('Photo upload failed.');
    await fetch(mint.thumbSignedUrl, { method: 'PUT', headers: { 'Content-Type': 'image/webp' }, body: variants.thumb }).catch(() => null);
    // 4) Finalize: server downloads + magic-byte-verifies before recording.
    const finRes = await fetch(`/api/v1/maintenance-requests/${requestId}/attachments/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: mint.path, thumbPath: mint.thumbPath, originalFilename: file.name, declaredMime: variants.master.type }),
    });
    if (!finRes.ok) throw new Error('That file is not a supported photo.');
  }

  async function handleFiles(files: FileList | null) {
    if (!files?.length || busy) return;
    if (photos.length + files.length > MAINTENANCE_MAX_PHOTOS) {
      toast.error(`A request can carry at most ${MAINTENANCE_MAX_PHOTOS} photos.`);
      return;
    }
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        try {
          await uploadOne(file);
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Photo upload failed.');
        }
      }
      onChange();
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function removePhoto(id: string) {
    const res = await fetch(`/api/v1/maintenance-requests/${requestId}/attachments/${id}`, { method: 'DELETE' });
    if (!res.ok) { toast.error('Could not remove the photo.'); return; }
    onChange();
  }

  return (
    <section
      aria-label="Request photos"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); void handleFiles(e.dataTransfer.files); }}
      className="space-y-3 rounded-xl border border-dashed p-4"
    >
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Photos ({photos.length}/{MAINTENANCE_MAX_PHOTOS})</p>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? 'Uploading...' : 'Add photos'}
        </Button>
      </div>
      <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" capture="environment" multiple hidden onChange={(e) => void handleFiles(e.target.files)} />
      {photos.length > 0 ? (
        <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
          {photos.map((p) => (
            <li key={p.id} className="group relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.thumbUrl ?? p.url} alt={p.originalFilename} className="h-24 w-full rounded-lg border object-cover" />
              <button type="button" aria-label={`Remove ${p.originalFilename}`} className="absolute right-1 top-1 rounded bg-background/80 px-1.5 text-xs" onClick={() => void removePhoto(p.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Drag photos here, or use your camera. HEIC photos are converted automatically.</p>
      )}
    </section>
  );
}
```

NOTE: verify `compressImageVariants`' actual return shape at `image-variants.ts:192-239` before wiring (`master`/`thumb` Blob names above are the plan's contract — adjust the two property reads if the real names differ, not the flow).

- [ ] **Step 5: The `new` page** — `new/page.tsx`: server component that gates (as Task 12), loads charters via the house sites query, reads org categories from `organization_modules.settings` (fallback `MAINTENANCE_CATEGORIES`), reads launch-point prefill from `searchParams` (`itemId`, `orderRequestId`, `rentalId`, `charterId`, `subject`), and renders a small client wrapper that shows `MaintenanceRequestForm`, then after `onSaved(id)` router-pushes to `/dashboard/maintenance/${id}?review=1`. Write the page + the 30-line client wrapper (`'use client'`, useRouter) in full.

- [ ] **Step 6: Run to verify pass.** `pnpm --filter web test -- maintenance-request-form && pnpm --filter web typecheck` → PASS.

- [ ] **Step 7: Commit.**

```bash
git add apps/web/src/components/maintenance apps/web/src/app/\(dashboard\)/dashboard/maintenance/new
git commit -m "feat(maintenance): web request form, photo upload panel, new-request page"
```

## Task 14: The email action component + review screen (the no-send heart)

**Files:**
- Create: `apps/web/src/components/maintenance/maintenance-email-action.tsx`
- Create: `apps/web/src/components/maintenance/maintenance-email-action.test.tsx`
- Create: `apps/web/src/components/maintenance/maintenance-review.tsx`

**Interfaces:**
- Consumes: `prepareMaintenanceEmail`, `type MaintenanceEmailInput`, `MAINTENANCE_CC_NOTICE` (core); `recordMaintenanceDraftOpenedAction` (Task 8); Radix Dialog; sonner.
- Produces: `MaintenanceEmailAction({ requestId, emailInput, initialOpenCount, photoDownloads }: { requestId: string; emailInput: MaintenanceEmailInput; initialOpenCount: number; photoDownloads?: { url: string; filename: string }[] })` — when `photoDownloads` is present, a `Download Photos for Outlook` group (per-photo `<a download>` anchors) renders beside the actions AND inside the popup-blocked panel (brief §19 lists it among the recovery actions); and `MaintenanceReview({ requestId, detail, photos, emailInput, initialOpenCount })` — mounted by Task 15's detail page (`?review=1` renders the review layout).

Behavioral spec (each line is a test):
1. Primary button `Open in Outlook`. Handler ordering (R3): after the `linkFits` guard, `window.open(prepared.outlookUrl, '_blank')` is the FIRST side effect — no await, no setState, no analytics before it; the third argument is `undefined` (no features string); on success the handle's `opener` is severed in try/catch; `recordMaintenanceDraftOpenedAction` fires strictly AFTER.
2. Duplicate-draft dialog (brief §21): when `openCount > 0`, clicking `Open in Outlook` shows a dialog FIRST — `A maintenance email draft was already opened for this request. Sending multiple copies may create duplicate Zendesk tickets.` with `Cancel` / `Open Another Draft`. `Open Another Draft` runs the same R3 handler. Reopening is never permanently blocked.
3. Popup blocked (`window.open` returns null): show `Outlook could not be opened automatically.`, keep the request, offer Try Outlook Again / Open in Default Email App / Copy Email Details / Download Photos for Outlook. The mailto navigation fires at most once per mount (`mailtoAttemptedRef`).
4. `linkFits === false`: NOTHING opens — not even mailto; the clipboard path is presented as the way to send.
5. Copy: writes `prepared.clipboardText` via `navigator.clipboard.writeText`; toast exactly `Maintenance request copied. Create a new email to dc4@learn4life.org, CC arosas@cvwest.org, and paste the copied details.`; on clipboard failure a SELECTABLE `<textarea readOnly value={clipboardText}>` appears.
6. Success message exactly: `Outlook opened with your maintenance request. Review the information, attach any downloaded photos you want included directly, and click Send.` — mirrored to an `aria-live="polite"` region; a SECOND live region renders INSIDE any open DialogContent (Radix aria-hides siblings — landmine 10).
7. Never render forbidden phrases; a fetch spy proves the open click makes no network call before the open (the record action is mocked and called after).
8. Helper text on the review screen exactly: `Your request has been saved in StockPilot. Outlook will open with the email details filled in, but the email will not be sent automatically.` and the photos note: `Outlook cannot add StockPilot photos automatically. The photo links will be included in the message, and you can download the photos here if you want to attach them directly.`

- [ ] **Step 1: Write the failing component tests** — `maintenance-email-action.test.tsx`. Port the harness idioms from `delivery-request-action.test.tsx` VERBATIM (defineProperty for `window.open`/`location`/`clipboard`, captured-descriptor restore in beforeEach, isolation test, rest-param mocks). The complete skeleton with every case:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recordAction = vi.fn(async () => ({ ok: true as const, openCount: 1 }));
vi.mock('@/server/actions/maintenance-requests', () => ({
  recordMaintenanceDraftOpenedAction: (...args: unknown[]) => recordAction(...args),
}));

import { MaintenanceEmailAction } from './maintenance-email-action';
import type { MaintenanceEmailInput } from '@stockpilot/core';

const INPUT: MaintenanceEmailInput = {
  requestNumber: 'MR-2026-000123',
  subject: 'AC broken in Room 204',
  description: 'Warm air only.',
  category: null, priority: 'high', submittedAtDisplay: 'August 5, 2026 at 9:15 AM',
  requesterName: 'Jane Smith', requesterEmail: null, requesterPhone: null,
  siteName: 'Fresno Learning Center', department: null, building: null, roomOrArea: null,
  accessInstructions: null, relatedItem: null, relatedOrder: null, relatedRental: null,
  photoCount: 0, shareUrl: null,
};

let openSpy: ReturnType<typeof vi.fn>;
let originalOpen: PropertyDescriptor | undefined;
let originalClipboard: PropertyDescriptor | undefined;
let assignSpy: ReturnType<typeof vi.fn>;
let originalLocation: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  originalOpen = Object.getOwnPropertyDescriptor(window, 'open');
  openSpy = vi.fn(() => ({ opener: {} }) as unknown as Window);
  Object.defineProperty(window, 'open', { value: openSpy, configurable: true, writable: true });
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(async () => undefined) }, configurable: true,
  });
  assignSpy = vi.fn();
  originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
  Object.defineProperty(window, 'location', {
    value: { ...window.location, assign: assignSpy }, configurable: true,
  });
});

afterEach(() => {
  if (originalOpen) Object.defineProperty(window, 'open', originalOpen);
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
});

function renderAction(overrides: Partial<Parameters<typeof MaintenanceEmailAction>[0]> = {}) {
  return render(
    <MaintenanceEmailAction requestId="r1" emailInput={INPUT} initialOpenCount={0} {...overrides} />,
  );
}

describe('Open in Outlook (component tests 7, 14)', () => {
  it('opens the compose URL with NO features string and severs the opener', async () => {
    renderAction();
    await userEvent.click(screen.getByRole('button', { name: 'Open in Outlook' }));
    expect(openSpy).toHaveBeenCalledTimes(1);
    const [url, target, features] = openSpy.mock.calls[0]!;
    expect(String(url)).toContain('outlook.cloud.microsoft/mail/deeplink/compose?mailtouri=');
    expect(String(url)).toContain(encodeURIComponent(encodeURIComponent('dc4@learn4life.org')));
    expect(target).toBe('_blank');
    expect(features).toBeUndefined(); // 'noopener' would return null even on success
    const handle = openSpy.mock.results[0]!.value as { opener: unknown };
    expect(handle.opener).toBeNull();
  });

  it('R3 ordering: the record action fires AFTER the open, never before', async () => {
    const order: string[] = [];
    openSpy.mockImplementation(() => { order.push('open'); return { opener: {} } as unknown as Window; });
    recordAction.mockImplementation(async () => { order.push('record'); return { ok: true as const, openCount: 1 }; });
    renderAction();
    await userEvent.click(screen.getByRole('button', { name: 'Open in Outlook' }));
    await waitFor(() => expect(order).toEqual(['open', 'record']));
  });

  it('shows the exact accurate-status success message in an aria-live region', async () => {
    renderAction();
    await userEvent.click(screen.getByRole('button', { name: 'Open in Outlook' }));
    const msg = 'Outlook opened with your maintenance request. Review the information, attach any downloaded photos you want included directly, and click Send.';
    expect(await screen.findByText(msg)).toBeInTheDocument();
    expect(screen.getByText(msg).closest('[aria-live]')).toHaveAttribute('aria-live', 'polite');
  });

  it('makes NO network call on the open click (fetch spy)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    renderAction();
    await userEvent.click(screen.getByRole('button', { name: 'Open in Outlook' }));
    expect(fetchSpy).not.toHaveBeenCalled(); // record goes through the mocked action, not fetch
    vi.unstubAllGlobals();
  });
});

describe('duplicate-draft protection (component test 11; brief section 21)', () => {
  it('second open shows the warning dialog with Cancel / Open Another Draft', async () => {
    renderAction({ initialOpenCount: 1 });
    await userEvent.click(screen.getByRole('button', { name: 'Open in Outlook' }));
    expect(openSpy).not.toHaveBeenCalled(); // dialog first, open only on confirm
    expect(screen.getByText('A maintenance email draft was already opened for this request. Sending multiple copies may create duplicate Zendesk tickets.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open Another Draft' }));
    expect(openSpy).toHaveBeenCalledTimes(1);
  });
  it('Cancel closes without opening anything', async () => {
    renderAction({ initialOpenCount: 2 });
    await userEvent.click(screen.getByRole('button', { name: 'Open in Outlook' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe('popup blocked (component test 8; brief section 19)', () => {
  it('falls back: message, mailto once, all four recovery actions, still records ONE draft', async () => {
    openSpy.mockReturnValue(null as unknown as Window);
    renderAction();
    await userEvent.click(screen.getByRole('button', { name: 'Open in Outlook' }));
    expect(await screen.findByText('Outlook could not be opened automatically.')).toBeInTheDocument();
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(String(assignSpy.mock.calls[0]![0])).toMatch(/^mailto:dc4@learn4life\.org\?cc=arosas%40cvwest\.org/);
    for (const label of ['Try Outlook Again', 'Open in Default Email App', 'Copy Email Details']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(recordAction).toHaveBeenCalledTimes(1);
    // Second blocked click: no second mailto navigation, no second record.
    await userEvent.click(screen.getByRole('button', { name: 'Try Outlook Again' }));
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(recordAction).toHaveBeenCalledTimes(1);
  });
  it('never shows the success message when blocked', async () => {
    openSpy.mockReturnValue(null as unknown as Window);
    renderAction();
    await userEvent.click(screen.getByRole('button', { name: 'Open in Outlook' }));
    expect(screen.queryByText(/Outlook opened with your maintenance request/)).toBeNull();
  });
});

describe('oversized draft (linkFits false)', () => {
  it('opens NOTHING — not even mailto — and presents the clipboard path', async () => {
    renderAction({ emailInput: { ...INPUT, requesterName: 'X'.repeat(3000) } });
    await userEvent.click(screen.getByRole('button', { name: 'Open in Outlook' }));
    expect(openSpy).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/too long for an email link/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Email Details' })).toBeInTheDocument();
  });
});

describe('copy fallback (component test 9; brief section 18)', () => {
  it('copies the labelled blocks and toasts the exact instruction', async () => {
    renderAction();
    await userEvent.click(screen.getByRole('button', { name: 'Copy Email Details' }));
    const written = vi.mocked(navigator.clipboard.writeText).mock.calls[0]![0] as string;
    expect(written).toContain('TO: dc4@learn4life.org');
    expect(written).toContain('CC: arosas@cvwest.org');
    expect(await screen.findByText('Maintenance request copied. Create a new email to dc4@learn4life.org, CC arosas@cvwest.org, and paste the copied details.')).toBeInTheDocument();
  });
  it('clipboard failure reveals a selectable textarea with the full content', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('denied'));
    renderAction();
    await userEvent.click(screen.getByRole('button', { name: 'Copy Email Details' }));
    const area = await screen.findByRole('textbox');
    expect(area).toHaveAttribute('readonly');
    expect((area as HTMLTextAreaElement).value).toContain('TO: dc4@learn4life.org');
  });
});

describe('honesty sweep (component test 14; brief section 20)', () => {
  it('the rendered component never contains a forbidden phrase in any state', async () => {
    const { container } = renderAction();
    for (const banned of ['Ticket created', 'Request submitted to Zendesk', 'DC4 notified', 'Andrew notified', 'Ticket assigned', 'Email sent']) {
      expect(container.textContent).not.toContain(banned);
    }
  });
});

describe('photo-driven behavior (photo test 11; component test 10)', () => {
  it('removing a photo updates the email content (photoCount 3 -> 0 drops the PHOTOS section)', async () => {
    const { rerender } = renderAction({ emailInput: { ...INPUT, photoCount: 3, shareUrl: 'https://stockpilotusa.com/m/tok' } });
    await userEvent.click(screen.getByRole('button', { name: 'Copy Email Details' }));
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0]![0] as string).toContain('3 photos were uploaded');
    rerender(<MaintenanceEmailAction requestId="r1" emailInput={{ ...INPUT, photoCount: 0, shareUrl: null }} initialOpenCount={0} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy Email Details' }));
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[1]![0] as string).not.toContain('photos were uploaded');
  });

  it('the blocked panel offers Download Photos for Outlook when photos exist', async () => {
    openSpy.mockReturnValue(null as unknown as Window);
    renderAction({
      emailInput: { ...INPUT, photoCount: 2, shareUrl: 'https://stockpilotusa.com/m/tok' },
      photoDownloads: [
        { url: 'https://files.example.test/a.jpg', filename: 'a.jpg' },
        { url: 'https://files.example.test/b.jpg', filename: 'b.jpg' },
      ],
    });
    await userEvent.click(screen.getByRole('button', { name: 'Open in Outlook' }));
    expect(await screen.findByText('Outlook could not be opened automatically.')).toBeInTheDocument();
    expect(screen.getByText('Download Photos for Outlook')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'a.jpg' })).toHaveAttribute('download');
  });
});
```

- [ ] **Step 2: Run to verify failure.** `pnpm --filter web test -- maintenance-email-action` → FAIL.

- [ ] **Step 3: Implement the component** — `maintenance-email-action.tsx`. Port `delivery-request-action.tsx`'s handler logic exactly (the R3 block at :158-224 is the reference); dashboard Tailwind instead of `sf-*`; the duplicate-draft Dialog (plain `max-w-lg` is fine here — no z-[100], that was storefront-only); dual live regions (one page-level, one inside the DialogContent); `let openCount` state seeded from `initialOpenCount` and advanced from the record action's response; `mailtoAttemptedRef` one-shot; `prepared = useMemo(() => prepareMaintenanceEmail(emailInput), [emailInput])`. The full component follows the tested behavior above — write it in one pass, run the suite, iterate until green. Key handler, verbatim contract:

```tsx
function openDraft() {
  if (!prepared.linkFits) { setFallbackReason('oversized'); return; }
  // R3: nothing side-effecting precedes this line.
  let opened: Window | null = null;
  try {
    opened = window.open(prepared.outlookUrl, '_blank');
    if (opened) { try { opened.opener = null; } catch { /* best-effort */ } }
  } catch { opened = null; }

  if (opened) {
    setFallbackReason(null);
    setOpenCount((n) => n + 1);
    void recordMaintenanceDraftOpenedAction(requestId).then((r) => {
      if ('ok' in r) setOpenCount(r.openCount);
    });
    const msg = 'Outlook opened with your maintenance request. Review the information, attach any downloaded photos you want included directly, and click Send.';
    toast.success(msg);
    setAnnouncement(msg);
    return;
  }

  setFallbackReason('blocked');
  if (!mailtoAttemptedRef.current) {
    mailtoAttemptedRef.current = true;
    setOpenCount((n) => n + 1);
    void recordMaintenanceDraftOpenedAction(requestId);
    try { window.location.assign(prepared.mailtoUrl); } catch { /* panel is the recovery */ }
  }
}

function handlePrimaryClick() {
  if (openCount > 0) { setConfirmOpen(true); return; }
  openDraft();
}
```

- [ ] **Step 4: Implement the review composition** — `maintenance-review.tsx`: renders request number, subject, description, category, priority, requester, site, building/room, related summary, photo thumbnails, the To/CC display (bare addresses + `MAINTENANCE_CC_NOTICE`), the generated email subject + body in a `<pre className="whitespace-pre-wrap">`, the helper sentence from spec line 8, the photos-cannot-auto-attach note, `Download Photos for Outlook` (per-photo `<a download href={photo.url}>`), `Edit Request` (Link back to the form with state preserved server-side — it is a saved request; editing happens on the detail page), and `MaintenanceEmailAction` as the primary block. Title exactly `Review maintenance request`.

- [ ] **Step 5: Run to verify pass.** `pnpm --filter web test -- maintenance-email-action && pnpm --filter web typecheck` → PASS (every case in Step 1).

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/components/maintenance
git commit -m "feat(maintenance): Outlook email action with fallbacks, duplicate-draft dialog, review screen"
```

## Task 15: Detail page — timeline, notes, owner, share link, downloads

**Files:**
- Create: `apps/web/src/app/(dashboard)/dashboard/maintenance/[id]/page.tsx`
- Create: `apps/web/src/components/maintenance/maintenance-notes-panel.tsx`
- Create: `apps/web/src/components/maintenance/assign-owner-select.tsx`
- Create: `apps/web/src/components/maintenance/share-link-panel.tsx`
- Test: `apps/web/src/components/maintenance/maintenance-notes-panel.test.tsx`

**Interfaces:**
- Consumes: Task 8 service (get/listNotes/emailInput), Task 9 `signedViewUrls`, Task 10 `ensureActiveLink` URL via the settings-gated read (same helper as Task 11's route), Task 14 `MaintenanceReview` + `MaintenanceEmailAction` + `MaintenancePhotosPanel`; member picker query = `organization_members` embedding `user_profiles!user_id` filtered `.not('accepted_at', 'is', null)` (cycle-counts/new/page.tsx:36-57).
- Produces: `/dashboard/maintenance/[id]` and `/dashboard/maintenance/[id]?review=1` (the post-save review mode Task 13 redirects to).

- [ ] **Step 1: Failing notes-panel test** (requester never sees the panel; manage sees add + list; forbidden-phrase sweep):

```tsx
// maintenance-notes-panel.test.tsx — three cases:
// 1. renders nothing when canManage is false (requester must never see notes).
// 2. with canManage, lists notes and submits addMaintenanceNoteAction (mocked).
// 3. the panel labels notes 'Internal StockPilot notes' and never contains
//    'Zendesk comment' or any forbidden phrase.
```

Write the three `it()` bodies with the Task 13 mock idiom.

- [ ] **Step 2: Run to verify failure.** `pnpm --filter web test -- maintenance-notes-panel` → FAIL.

- [ ] **Step 3: Implement.** The page (server component) composes, in the returns/[id] two-column layout:
- Header: MR handle + `MaintenanceStatusBadge` + priority + created date.
- Left column: subject/description card; photos (`MaintenancePhotosPanel` — editable while not archived/cancelled); `MaintenanceReview`-mode when `?review=1`, else an "Email" card mounting `MaintenanceEmailAction` with `initialOpenCount = detail.outlookDraftOpenCount` and `photoDownloads={photos.map((p) => ({ url: p.url, filename: p.originalFilename }))}` (the component renders the `Download Photos for Outlook` anchors and `Copy Email Details` itself).
- Aside: Details `<dl>` (requester, site, building/room, department, related records as links, local owner via `AssignOwnerSelect` when canManage); STOCKPILOT-ONLY timeline — a static list labeled `StockPilot activity` deriving rows from data (`Request saved` at created_at; `Outlook draft opened` at outlook_draft_opened_at with `xN` count; `Local owner assigned` when set; `Request archived`/`Request cancelled`) — NO fake ticket conversation; `ShareLinkPanel` (canManage: shows active link state, Copy URL, Revoke via a server action calling `MaintenanceShareLinksService.revoke`); `MaintenanceNotesPanel` (canManage only).
- Archive/Cancel buttons (manage / requester respectively) wired to the Task 8 actions with confirm dialogs.

`assign-owner-select.tsx`: client Select over `{ userId, name }[]` props calling `assignMaintenanceOwnerAction`; label text `StockPilot owner` with helper `Internal coordinator inside StockPilot. This is not a Zendesk assignment.`

- [ ] **Step 4: Run to verify pass.** `pnpm --filter web test -- maintenance-notes && pnpm --filter web typecheck && pnpm --filter web build` → PASS (the build proves the server/client component split compiles).

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/app/\(dashboard\)/dashboard/maintenance/\[id\] apps/web/src/components/maintenance
git commit -m "feat(maintenance): detail page with StockPilot-only timeline, notes, owner, share link"
```

## Task 16: Settings page + hub tile

**Files:**
- Create: `apps/web/src/app/(dashboard)/dashboard/settings/maintenance/page.tsx`
- Create: `apps/web/src/components/maintenance/maintenance-settings-panel.tsx`
- Create: `apps/web/src/server/actions/maintenance-settings.ts`
- Modify: `apps/web/src/app/(dashboard)/dashboard/settings/page.tsx` (hub tile — hand-maintained array at :13-129; forgetting it makes the page URL-only)

**Interfaces:**
- Consumes: `organization_modules.settings` jsonb (the b2b pricingMode precedent); `can(ctx, 'maintenance_requests:configure')`; the roles matrix at `/dashboard/settings/roles` (Andrew's grants happen THERE — this page links to it, it does not duplicate the matrix).
- Produces: settings shape (Task 11's route + Task 21's notify already read it):

```ts
interface MaintenanceModuleSettings {
  categories?: string[];                 // fallback: MAINTENANCE_CATEGORIES
  includeShareLinksInEmail?: boolean;    // default true
  notifyAudience?: Record<string, 'all' | 'urgent_only' | 'none'>; // userId -> mode (C9)
}
```

- `updateMaintenanceSettingsAction(patch: Partial<MaintenanceModuleSettings>)` — configure-gated, merges into settings, audits `maintenance_request.settings_updated`.

- [ ] **Step 1: Failing action test** — configure-gated (owner passes, admin FAILS — C2), merge semantics (patch does not clobber unrelated keys), audit event emitted. Three `it()` bodies with the Task 8 service-test idiom against a small `MaintenanceSettingsService` or directly against the action with `withContext` mocked.

- [ ] **Step 2: Run to verify failure.**

Run: `pnpm --filter web test -- maintenance-settings`
Expected: FAIL.

- [ ] **Step 3: Implement.** Page: configure-gated (`can(ctx, 'maintenance_requests:configure')` else `redirect('/dashboard/settings')`); loads settings + accepted members (for the audience map rows); renders the panel. Panel (client): category list editor (add/remove strings, min 1), `includeShareLinksInEmail` switch with helper `When off, the email lists the photo count but carries no link.`, per-member audience select (All new requests / Urgent only / None), a prominent Link `Manage who can view or manage all requests` → `/dashboard/settings/roles` (the per-user exceptions matrix — Andrew's grant path, zero new code), and the recipients display: read-only To/CC values with the note `Recipients are fixed in this release. Contact support to change them.` Hub tile: append `{ href: '/dashboard/settings/maintenance', title: 'Maintenance requests', description: 'Categories, notification audiences, and photo link settings.' }` in the hand-maintained array following its exact object shape (Read the array first; match icon key style).

- [ ] **Step 4: Run to verify pass.** `pnpm --filter web test -- maintenance-settings && pnpm --filter web typecheck` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/app/\(dashboard\)/dashboard/settings apps/web/src/components/maintenance apps/web/src/server/actions/maintenance-settings.ts
git commit -m "feat(maintenance): settings page - categories, audiences, share-link toggle, hub tile"
```

## Task 17: Web launch points — item/book/rental detail + order detail

**Files:**
- Create: `apps/web/src/components/maintenance/report-problem-button.tsx`
- Create: `apps/web/src/components/maintenance/report-problem-button.test.tsx`
- Modify: `apps/web/src/components/inventory/item-detail.tsx:379-437` (sticky action row — covers items, books, AND rental-items routes; it is a SERVER component so the button is a client child taking primitive props)
- Modify: `apps/web/src/app/(dashboard)/dashboard/orders/[id]/page.tsx:551-583` (header action row)
- Modify: `apps/web/src/app/(dashboard)/dashboard/rentals/[id]/page.tsx` (action area — audit Q11's "assigned asset view")

**Interfaces:**
- Consumes: Task 13's `new` page prefill searchParams contract (`itemId` / `orderRequestId` / `rentalId` / `charterId`).
- Produces: `ReportProblemButton({ moduleEnabled, prefill }: { moduleEnabled: boolean; prefill: { itemId?: string; orderRequestId?: string; rentalId?: string } })` — renders NOTHING when the module is disabled (nav-invisible for non-L4L orgs), else a Link button `Report a problem` to `/dashboard/maintenance/new?...`.

- [ ] **Step 1: Failing tests:**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ReportProblemButton } from './report-problem-button';

describe('ReportProblemButton', () => {
  it('renders nothing when the module is disabled (no dead affordance in other orgs)', () => {
    const { container } = render(<ReportProblemButton moduleEnabled={false} prefill={{ itemId: 'i1' }} />);
    expect(container.firstChild).toBeNull();
  });
  it('links to the new-request form with the related-record prefill', () => {
    render(<ReportProblemButton moduleEnabled prefill={{ itemId: 'i1' }} />);
    const link = screen.getByRole('link', { name: 'Report a problem' });
    expect(link).toHaveAttribute('href', '/dashboard/maintenance/new?itemId=i1');
  });
  it('supports order and rental prefill params', () => {
    render(<ReportProblemButton moduleEnabled prefill={{ orderRequestId: 'o1' }} />);
    expect(screen.getByRole('link', { name: 'Report a problem' })).toHaveAttribute('href', '/dashboard/maintenance/new?orderRequestId=o1');
  });
});
```

- [ ] **Step 2: Run to verify failure.** `pnpm --filter web test -- report-problem-button` → FAIL.

- [ ] **Step 3: Implement** the 20-line component (build the query string from defined prefill keys only), then mount it: in `item-detail.tsx`'s action row pass `moduleEnabled` from the page's existing module context (each of the three wrapping pages already resolves org context; thread a boolean prop — compute with the same `module_enabled` RPC `checkModuleAccess` uses); in orders/[id] and rentals/[id] compute `checkModuleAccess('maintenance_requests')` alongside the existing gates and mount with the respective prefill.

- [ ] **Step 4: Run to verify pass + the existing detail suites stay green.**

Run: `pnpm --filter web test -- report-problem-button item-detail && pnpm --filter web typecheck`
Expected: PASS; zero changes to existing item-detail assertions.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/components/maintenance apps/web/src/components/inventory/item-detail.tsx \
        apps/web/src/app/\(dashboard\)/dashboard/orders apps/web/src/app/\(dashboard\)/dashboard/rentals
git commit -m "feat(maintenance): Report a problem launch points on item, order, and rental detail"
```

---

# Phase E — Mobile (pure JS, OTA-safe on the live 1.1.0 binary)

No new native modules anywhere in this phase (no expo-sharing, no media-library, no clipboard — Global Constraint 13). Screens follow the support-feature template; data flows through `api()` against the Task 11 routes; email actions use `Linking.openURL` with URLs built by the SAME core `prepareMaintenanceEmail`. After EVERY task in this phase: boot the iOS simulator and hand-test the affected flow (owner rule) — record what you walked.

## Task 18: Mobile registration, rewrite rules, API helper, list screen

**Files:**
- Modify: `apps/mobile/src/lib/web-path-rewrite.ts` (3 rules ABOVE the `/dashboard/*` catch-all)
- Modify: `apps/mobile/src/lib/web-path-rewrite.test.ts`
- Create: `apps/mobile/src/lib/maintenance-api.ts`
- Create: `apps/mobile/src/lib/maintenance-api.test.ts`
- Create: `apps/mobile/app/(drawer)/maintenance.tsx`
- Modify: `apps/mobile/app/(drawer)/_layout.tsx` (`<Drawer.Screen name="maintenance" options={{ drawerLabel: 'Maintenance' }} />` beside `support` at :58)
- Modify: `apps/mobile/app/_layout.tsx:226-241` (`<Stack.Screen name="maintenance/new" options={{ presentation: 'card' }} />` and `<Stack.Screen name="maintenance/[id]" options={{ presentation: 'card' }} />`)

**Interfaces:**
- Consumes: `api<T>(path, opts)` from `apps/mobile/src/lib/api.ts:97` (Bearer + X-Organization-Id); `useEnabledModules` from `apps/mobile/src/lib/enabled-modules.ts:71-91`; Task 11 JSON shapes.
- Produces: routes `/maintenance`, `/maintenance/new`, `/maintenance/[id]` (satisfying the Task 3 EXPO_ROUTES pin — the sports dead-tap bug is the reason this task MUST land before ship); `maintenance-api.ts` exports:

```ts
export interface MobileMaintenanceListRow { /* mirror of MaintenanceRequestListRow */ }
export function listMaintenanceRequests(args: { scope: 'mine' | 'all'; q?: string }): Promise<MobileMaintenanceListRow[]>;
export function getMaintenanceRequest(id: string): Promise<{ request: ...; photos: ...; emailInput: MaintenanceEmailInput; canManage: boolean }>;
export function createMaintenanceRequest(values: MaintenanceRequestFormValues): Promise<{ id: string }>;
export function recordDraftOpened(id: string): Promise<{ openCount: number }>;
export function mintPhotoUpload(id: string, args: { fileExt: string; originalFilename: string }): Promise<MintPayload>;
export function finalizePhoto(id: string, args: { path: string; thumbPath: string | null; originalFilename: string; declaredMime: string }): Promise<{ id: string }>;
```

- [ ] **Step 1: Write the failing rewrite tests** (mobile vitest is node-env pure logic — exactly this file's existing suite style):

```ts
describe('maintenance deep links (all three notification doors route through here)', () => {
  it('detail: /dashboard/maintenance/<uuid> -> /maintenance/<uuid>', () => {
    expect(rewriteWebPath('/dashboard/maintenance/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'))
      .toBe('/maintenance/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });
  it('new: /dashboard/maintenance/new -> /maintenance/new', () => {
    expect(rewriteWebPath('/dashboard/maintenance/new')).toBe('/maintenance/new');
  });
  it('list incl. query: /dashboard/maintenance?scope=all -> /maintenance', () => {
    expect(rewriteWebPath('/dashboard/maintenance')).toBe('/maintenance');
    expect(rewriteWebPath('/dashboard/maintenance?scope=all')).toBe('/maintenance');
  });
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `pnpm --filter mobile test -- web-path-rewrite`
Expected: FAIL — the catch-all rewrites all three to `/` (the exact dead-end landmine 31 warns about).

- [ ] **Step 3: Implement the rules.** In `REWRITES`, ABOVE the `/dashboard/*` catch-all (order matters — `new` before the UUID rule is unnecessary since `new` cannot match the 36-char UUID pattern, but keep detail first for symmetry with orders):

```ts
  { re: new RegExp(`/dashboard/maintenance/${UUID}`), to: (m) => `/maintenance/${m[1]}` },
  { re: /\/dashboard\/maintenance\/new$/, to: () => '/maintenance/new' },
  { re: /\/dashboard\/maintenance(\?.*)?$/, to: () => '/maintenance' },
```

Run: `pnpm --filter mobile test -- web-path-rewrite` → PASS.

- [ ] **Step 4: Implement `maintenance-api.ts`** (thin typed wrappers over `api()`), its test (pin the exact paths: `expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/v1/maintenance-requests?scope=mine'), ...)` following the existing mobile api-test idiom), the list screen, and the registrations. List screen skeleton (the support.tsx structure):

```tsx
// apps/mobile/app/(drawer)/maintenance.tsx
import { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';

import { useEnabledModules } from '@/lib/enabled-modules';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { listMaintenanceRequests, type MobileMaintenanceListRow } from '@/lib/maintenance-api';
import { formatMaintenanceRequestNumber, MAINTENANCE_STATUS_LABELS } from '@stockpilot/core';

export default function MaintenanceListScreen() {
  const { enabled } = useEnabledModules();
  const perms = useEffectivePermissions();
  const canReadAll = perms.has('maintenance_requests:read_all') || perms.has('maintenance_requests:manage');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<MobileMaintenanceListRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try { setRows(await listMaintenanceRequests({ scope, q: q || undefined })); }
    finally { setRefreshing(false); }
  }, [scope, q]);

  useEffect(() => { void load(); }, [load]);

  if (!enabled.has('maintenance_requests')) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Text>Maintenance requests are not enabled for this workspace.</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {/* scope toggle (All only when canReadAll), search box, New button -> router.push('/maintenance/new') */}
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load()} />}
        ListHeaderComponent={
          <Text style={{ padding: 12, opacity: 0.7 }}>
            Ticket updates and replies are handled through the Outlook/Zendesk email conversation and are not synchronized into StockPilot.
          </Text>
        }
        renderItem={({ item }) => (
          <TouchableOpacity onPress={() => router.push(`/maintenance/${item.id}`)} style={{ padding: 12 }}>
            <Text style={{ fontWeight: '600' }}>
              {formatMaintenanceRequestNumber(item.requestNumber, item.createdAt)} - {item.subject}
            </Text>
            <Text style={{ opacity: 0.7 }}>
              {MAINTENANCE_STATUS_LABELS[item.status]} | {item.priority} | {item.photoCount} photos
            </Text>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}
```

Style with the app's shared components/tokens (match support.tsx's imports); the skeleton above pins structure and copy, not styling. Register the drawer + stack screens exactly as listed in Files.

- [ ] **Step 5: Run + simulator.**

Run: `pnpm --filter mobile test && pnpm --filter mobile typecheck`
Expected: PASS.
Then boot the iOS simulator, enable the module for the dev org locally, and hand-test: drawer entry visible, list loads, module-off org hides the entry. Record the walk.

- [ ] **Step 6: Commit.**

```bash
git add apps/mobile/src/lib/web-path-rewrite.ts apps/mobile/src/lib/web-path-rewrite.test.ts \
        apps/mobile/src/lib/maintenance-api.ts apps/mobile/src/lib/maintenance-api.test.ts \
        apps/mobile/app/\(drawer\)/maintenance.tsx apps/mobile/app/\(drawer\)/_layout.tsx apps/mobile/app/_layout.tsx
git commit -m "feat(mobile): maintenance list screen, drawer/stack registration, deep-link rewrites"
```

## Task 19: Mobile new-request form + photos with progress and retry

**Files:**
- Create: `apps/mobile/app/maintenance/new.tsx`
- Create: `apps/mobile/src/lib/maintenance-upload.ts`
- Create: `apps/mobile/src/lib/maintenance-upload.test.ts`

**Interfaces:**
- Consumes: `maintenanceRequestFormSchema` (core — same zod on-device validation), `resizeForUpload` from `apps/mobile/src/lib/image-resize.ts:18-60` (1600px JPEG q0.85, forced HEIC transcode), `expo-image-picker` (camera + library, multi-select), `expo-image-manipulator` (400px thumb), `FileSystem.createUploadTask` from `expo-file-system` (the OTA-safe progress route — all already in the 1.1.0 binary), Task 18 `maintenance-api` mint/finalize.
- Produces: `uploadMaintenancePhoto(requestId, asset: { uri: string; fileName?: string }, onProgress: (fraction: number) => void): Promise<{ id: string }>` — throws typed `UploadError` so the screen can render per-photo retry.

- [ ] **Step 1: Failing upload-helper test** (node-env; mock maintenance-api + expo-file-system):

```ts
// maintenance-upload.test.ts — four cases:
// 1. resizes first (resizeForUpload mock called with the asset uri), then
//    mints with fileExt 'jpg' (the resize forces JPEG — HEIC never reaches
//    the server), then creates an upload task with httpMethod PUT +
//    binaryContent, then finalizes with declaredMime 'image/jpeg'.
// 2. onProgress receives fractions from the task callback (0.5 forwarded).
// 3. a failed PUT rejects with UploadError('upload_failed') and NEVER calls
//    finalize (no orphan row).
// 4. a rejected finalize (invalid_image) surfaces UploadError('rejected') so
//    the UI can say the photo was refused, not "network error".
```

Write the four `it()` bodies with `vi.mock('expo-file-system', ...)` and `vi.mock('@/lib/maintenance-api', ...)`.

- [ ] **Step 2: Run to verify failure.** `pnpm --filter mobile test -- maintenance-upload` → FAIL.

- [ ] **Step 3: Implement** — `maintenance-upload.ts`:

```ts
import * as FileSystem from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';

import { resizeForUpload } from '@/lib/image-resize';
import { finalizePhoto, mintPhotoUpload } from '@/lib/maintenance-api';

export class UploadError extends Error {
  constructor(public kind: 'upload_failed' | 'rejected', message: string) { super(message); }
}

export async function uploadMaintenancePhoto(
  requestId: string,
  asset: { uri: string; fileName?: string },
  onProgress: (fraction: number) => void,
): Promise<{ id: string }> {
  // 1) Resize + force-JPEG (HEIC transcodes here; never reaches the bucket).
  const resized = await resizeForUpload(asset.uri);
  const name = asset.fileName?.replace(/\.[a-z0-9]+$/i, '') || 'photo';

  // 2) Server mint (rate-limited, entity-checked).
  const mint = await mintPhotoUpload(requestId, { fileExt: 'jpg', originalFilename: `${name}.jpg` });

  // 3) PUT master with real progress via createUploadTask (pure JS, in-binary).
  const task = FileSystem.createUploadTask(
    mint.signedUrl,
    resized.uri,
    {
      httpMethod: 'PUT',
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: { 'Content-Type': 'image/jpeg' },
    },
    (progress) => {
      if (progress.totalBytesExpectedToSend > 0) {
        onProgress(progress.totalBytesSent / progress.totalBytesExpectedToSend);
      }
    },
  );
  const result = await task.uploadAsync();
  if (!result || result.status < 200 || result.status >= 300) {
    throw new UploadError('upload_failed', 'Photo upload failed. Check your connection and retry.');
  }

  // 4) Thumb (best-effort): 400px JPEG via ImageManipulator, PUT without progress.
  try {
    const thumb = await ImageManipulator.manipulateAsync(resized.uri, [{ resize: { width: 400 } }], {
      compress: 0.8, format: ImageManipulator.SaveFormat.JPEG,
    });
    await FileSystem.uploadAsync(mint.thumbSignedUrl, thumb.uri, {
      httpMethod: 'PUT',
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: { 'Content-Type': 'image/jpeg' },
    });
  } catch {
    // The master is what matters; a missing thumb renders the master.
  }

  // 5) Finalize: the server magic-byte-verifies before recording the row.
  try {
    return await finalizePhoto(requestId, {
      path: mint.path,
      thumbPath: mint.thumbPath,
      originalFilename: `${name}.jpg`,
      declaredMime: 'image/jpeg',
    });
  } catch {
    throw new UploadError('rejected', 'That photo was refused by the server.');
  }
}
```

NOTE: the mint's `thumbPath` extension is `-thumb.webp` (Task 9 contract) while mobile uploads a JPEG thumb; pass `thumbPath: null` in `finalizePhoto` IF the server's finalize sniffs the thumb too — it does not (it sniffs the MASTER only), so recording the path is safe; the bucket accepts image/jpeg. If the executor prefers strictness, extend Task 9's mint to accept a `thumbExt` — do it in Task 9, not here.

- [ ] **Step 4: The screen** — `new.tsx`: the support.tsx form structure + subject/description/priority/category/site (site list via the existing charters endpoint the delivery flow uses on mobile — reuse the same fetch helper), zod validation on submit, `createMaintenanceRequest` → then a photos step listing picked assets with per-photo progress bars driven by `uploadMaintenancePhoto`, a Retry button per failed row, camera (`ImagePicker.launchCameraAsync`) + library (`launchImageLibraryAsync({ allowsMultipleSelection: true })`), and finally `router.replace(`/maintenance/${id}`)`. Prefill support: `useLocalSearchParams()` for `itemId` (Task 20's scan/item launch points push with params).

- [ ] **Step 5: Run + simulator.**

Run: `pnpm --filter mobile test && pnpm --filter mobile typecheck`
Expected: PASS.
Simulator hand-test: create a request with camera + library photos, kill the network mid-upload to see retry, confirm the request appears in the list. Record it.

- [ ] **Step 6: Commit.**

```bash
git add apps/mobile/app/maintenance apps/mobile/src/lib/maintenance-upload.ts apps/mobile/src/lib/maintenance-upload.test.ts
git commit -m "feat(mobile): maintenance request form with multi-photo upload, progress, retry"
```

## Task 20: Mobile detail + email actions + scan/item launch points

**Files:**
- Create: `apps/mobile/app/maintenance/[id].tsx`
- Create: `apps/mobile/src/lib/maintenance-email-actions.ts`
- Create: `apps/mobile/src/lib/maintenance-email-actions.test.ts`
- Modify: `apps/mobile/app/(drawer)/(tabs)/scan.tsx:885-896` (secondaryActions row — item id/sku/name in scope)
- Modify: `apps/mobile/app/item/[id].tsx:1387-1421` (overview action stack)

**Interfaces:**
- Consumes: `prepareMaintenanceEmail` + `MAINTENANCE_STATUS_LABELS` + `MAINTENANCE_CC_NOTICE` (core — this is why the transport lives in packages/core); `Linking.openURL` (expo-linking, in-binary); Task 18 `getMaintenanceRequest` / `recordDraftOpened`.
- Produces: `openOutlookDraft(prepared: PreparedMaintenanceEmail): Promise<'opened' | 'blocked'>` and `openMailtoDraft(prepared): Promise<'opened' | 'blocked'>` — pure-logic wrappers testable in node-env.

- [ ] **Step 1: Failing email-actions tests:**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-linking', () => ({ openURL: vi.fn(async () => undefined), canOpenURL: vi.fn(async () => true) }));

import * as Linking from 'expo-linking';
import { openOutlookDraft, openMailtoDraft } from './maintenance-email-actions';
import { prepareMaintenanceEmail } from '@stockpilot/core';

const PREPARED = prepareMaintenanceEmail({
  requestNumber: 'MR-2026-000123', subject: 'AC broken', description: 'Warm air.',
  category: null, priority: 'high', submittedAtDisplay: 'August 5, 2026 at 9:15 AM',
  requesterName: 'Jane Smith', requesterEmail: null, requesterPhone: null,
  siteName: null, department: null, building: null, roomOrArea: null, accessInstructions: null,
  relatedItem: null, relatedOrder: null, relatedRental: null, photoCount: 0, shareUrl: null,
});

beforeEach(() => vi.clearAllMocks());

describe('mobile email actions (string assertions ONLY — never a real open in tests)', () => {
  it('outlook action opens the tenant-verified compose URL', async () => {
    await expect(openOutlookDraft(PREPARED)).resolves.toBe('opened');
    const url = vi.mocked(Linking.openURL).mock.calls[0]![0] as string;
    expect(url.startsWith('https://outlook.cloud.microsoft/mail/deeplink/compose?mailtouri=')).toBe(true);
  });
  it('mailto action opens the RFC 6068 URL with the CC intact', async () => {
    await expect(openMailtoDraft(PREPARED)).resolves.toBe('opened');
    const url = vi.mocked(Linking.openURL).mock.calls[0]![0] as string;
    expect(url.startsWith('mailto:dc4@learn4life.org?cc=arosas%40cvwest.org')).toBe(true);
  });
  it('linkFits=false refuses to open either transport', async () => {
    const oversized = { ...PREPARED, linkFits: false };
    await expect(openOutlookDraft(oversized)).resolves.toBe('blocked');
    await expect(openMailtoDraft(oversized)).resolves.toBe('blocked');
    expect(Linking.openURL).not.toHaveBeenCalled();
  });
  it('an openURL rejection reports blocked instead of throwing', async () => {
    vi.mocked(Linking.openURL).mockRejectedValueOnce(new Error('no handler'));
    await expect(openOutlookDraft(PREPARED)).resolves.toBe('blocked');
  });
});
```

- [ ] **Step 2: Run to verify failure.** `pnpm --filter mobile test -- maintenance-email-actions` → FAIL.

- [ ] **Step 3: Implement** — `maintenance-email-actions.ts`:

```ts
import * as Linking from 'expo-linking';

import type { PreparedMaintenanceEmail } from '@stockpilot/core';

/** Both refuse to open ANYTHING when linkFits is false — silent mail-client
 *  truncation is the failure these guards exist for. The selectable-text
 *  copy panel (screen-side) is the honest transport in that case. */
export async function openOutlookDraft(prepared: PreparedMaintenanceEmail): Promise<'opened' | 'blocked'> {
  if (!prepared.linkFits) return 'blocked';
  try { await Linking.openURL(prepared.outlookUrl); return 'opened'; } catch { return 'blocked'; }
}

export async function openMailtoDraft(prepared: PreparedMaintenanceEmail): Promise<'opened' | 'blocked'> {
  if (!prepared.linkFits) return 'blocked';
  try { await Linking.openURL(prepared.mailtoUrl); return 'opened'; } catch { return 'blocked'; }
}
```

- [ ] **Step 4: The detail screen** — `[id].tsx`: loads `getMaintenanceRequest(id)`; renders status (`MAINTENANCE_STATUS_LABELS`), subject/description, photos (via the signed `photos[].thumbUrl ?? url` — `expo-image`; NOTE landmine: `image-cache.ts` is hardcoded to the item-images bucket — use plain `expo-image` `source={{ uri }}` here, do NOT route through image-cache), To/CC display + `MAINTENANCE_CC_NOTICE`, and the action block:
  - `Open in Outlook`: duplicate-draft `Alert.alert` when `openCount > 0` (Cancel / Open Another Draft), then `openOutlookDraft(prepared)`; on `'opened'` call `recordDraftOpened(id)` AFTER (R3 mirrors web) and show the exact success copy from Task 14 spec line 6; on `'blocked'` show `Outlook could not be opened automatically.` and surface the remaining actions.
  - `Open in Default Email App`: `openMailtoDraft`.
  - `Copy Email Details`: NO clipboard module exists in the binary — render the selectable fallback directly: a collapsible `<TextInput multiline editable={false} selectTextOnFocus value={prepared.clipboardText} />` with helper `Press and hold inside the box to select and copy.` (audit Q9).
  - `View photos page`: `Linking.openURL(shareUrl)` when the email input carries one (C10).
  `prepared` comes from `prepareMaintenanceEmail(emailInput)` computed in a `useMemo`.

- [ ] **Step 5: Launch points.** `scan.tsx` secondaryActions: add `{ label: 'Report a problem', onPress: () => router.push({ pathname: '/maintenance/new', params: { itemId: item.id } }) }` rendered only when `enabled.has('maintenance_requests')` (the sheet already has the enabled-modules hook in scope — verify and reuse). `item/[id].tsx` overview stack: same gated button with the item id param.

- [ ] **Step 6: Run + simulator.**

Run: `pnpm --filter mobile test && pnpm --filter mobile typecheck`
Expected: PASS.
Simulator hand-test: detail renders, the selectable-copy box selects, scan → Report a problem prefills, duplicate-draft alert appears on the second open tap. DO NOT tap "Open in Outlook" past the alert with a signed-in mail account in the simulator — the simulator has no mail client, but record the guard anyway (Global Constraint 2). Record the walk.

- [ ] **Step 7: Commit.**

```bash
git add apps/mobile/app/maintenance apps/mobile/src/lib/maintenance-email-actions.ts \
        apps/mobile/src/lib/maintenance-email-actions.test.ts \
        "apps/mobile/app/(drawer)/(tabs)/scan.tsx" "apps/mobile/app/item/[id].tsx"
git commit -m "feat(mobile): maintenance detail, email actions with selectable-copy fallback, launch points"
```

---

# Phase F — Notifications, reminder cron, onboarding

## Task 21: Notification prefs, audience resolution, emit points

**Files:**
- Modify: `apps/web/src/lib/notification-prefs.ts` (4 keys — the file is a REGULAR module, never `'use server'`)
- Modify: the settings notification toggles component carrying `TOGGLE_DEFS` (locate with `grep -rn "TOGGLE_DEFS" apps/web/src` — one file; add 4 entries)
- Create: `apps/web/src/server/services/maintenance-notify.ts`
- Create: `apps/web/src/server/services/maintenance-notify.test.ts`
- Modify: `apps/web/src/server/services/maintenance-requests.ts` (create/assignLocalOwner emit hooks; finalize-failure hook in maintenance-attachments.ts)

**Interfaces:**
- Consumes: `createNotification` (`@/server/services/notifications` — the ONE insert path; push rides the 0028 trigger, NEVER pushed from code); `effectivePermissions(role, roleOverrides, userOverrides)` from core; `notification_preferences` columns (Task 1); settings `notifyAudience` map (Task 16).
- Produces:

```ts
export type MaintenanceNotifyEvent = 'new_request' | 'urgent_request' | 'assigned' | 'draft_reminder' | 'photo_rejected';
/** Resolves userIds holding read_all/manage EFFECTIVELY (role defaults + role
 *  overrides + user overrides), minus the actor, filtered by the org's
 *  notifyAudience map and each user's own pref column (fail-OPEN: only an
 *  explicit false mutes). NEVER _notify_recipients() (role-hardcoded, shared). */
export function resolveMaintenanceAudience(args: { organizationId: string; event: 'new_request' | 'urgent_request'; actorUserId: string }): Promise<string[]>;
export function notifyMaintenanceEvent(args: { organizationId: string; event: MaintenanceNotifyEvent; requestId: string; requestHandle: string; subject: string; actorUserId: string; targetUserId?: string }): Promise<void>;
```

- Pref keys (LITERAL-pinned in tests): `push_maintenance_new_request`, `push_maintenance_urgent_request`, `push_maintenance_assigned`, `push_maintenance_draft_reminder`.

- [ ] **Step 1: Failing tests** — `maintenance-notify.test.ts` cases (real `it()` bodies, admin-client mock):

```ts
// 1. resolveMaintenanceAudience computes via effectivePermissions: a VIEWER
//    with a user_permission_overrides grant of read_all IS included (the
//    Andrew case, permission test 10); a staff member without grants is NOT.
// 2. The actor is excluded from their own new_request fan-out.
// 3. notifyAudience map: a user set to 'none' is dropped; 'urgent_only' is
//    dropped for event new_request but kept for urgent_request.
// 4. Pref gate is fail-OPEN: missing row notifies; explicit false mutes.
// 5. notifyMaintenanceEvent calls createNotification ONCE per recipient with
//    link `/dashboard/maintenance/${requestId}` (the Task 18 rewrite rules
//    make this resolve on mobile) and NEVER any push/expo call (spy proves it).
// 6. Titles use accurate language: 'New maintenance request MR-...' /
//    'Urgent maintenance request MR-...' — sweep asserts no 'sent'/'ticket
//    created'/'notified DC4'.
```

- [ ] **Step 2: Run to verify failure.** `pnpm --filter web test -- maintenance-notify` → FAIL.

- [ ] **Step 3: Implement.** Key mechanics (write the full file): admin client reads `organization_members` (accepted, role) + `role_permission_overrides`-equivalent and `user_permission_overrides` rows for the two permissions (mirror how `apps/web/src/server/actions/permissions.ts:189-258` loads overrides — reuse its query shape), computes `effectivePermissions(role, roleOverrides, userOverrides)` per member, filters by settings map + `notification_preferences.<key> !== false`, then loops `createNotification({ organizationId, userId, type: 'maintenance_request', title, body: subject, link: '/dashboard/maintenance/' + requestId, metadata: { request_id: requestId, event } })`. Add the emit calls: `MaintenanceRequestsService.create` → after audit, fire-and-forget `notifyMaintenanceEvent({ event: priority === 'urgent' ? 'urgent_request' : 'new_request', ... })` (and ALSO always the `urgent_request` audience when urgent); `assignLocalOwner` → `event: 'assigned'` to `targetUserId` (pref-gated); `MaintenanceAttachmentsService.finalize` catch-path for `invalid_image` → `event: 'photo_rejected'` to the uploader (C4). Add the 4 keys to `NOTIFICATION_PREF_KEYS` + 4 `TOGGLE_DEFS` entries (labels: `New maintenance requests`, `Urgent maintenance requests`, `Maintenance assigned to me`, `Maintenance draft reminders`).

- [ ] **Step 4: Run to verify pass.** `pnpm --filter web test -- maintenance-notify maintenance-requests && pnpm --filter web typecheck` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/lib/notification-prefs.ts apps/web/src/server/services/maintenance-notify.ts \
        apps/web/src/server/services/maintenance-notify.test.ts apps/web/src/server/services/maintenance-requests.ts \
        apps/web/src/server/services/maintenance-attachments.ts $(grep -rl "TOGGLE_DEFS" apps/web/src | head -1)
git commit -m "feat(maintenance): permission-resolved notifications with muteable prefs"
```

## Task 22: Unsent-draft reminder cron

**Files:**
- Create: `apps/web/src/app/api/cron/maintenance-draft-reminders/route.ts`
- Create: `apps/web/src/app/api/cron/maintenance-draft-reminders/route.test.ts`
- Modify: `apps/web/vercel.json` (crons[]: `{ "path": "/api/cron/maintenance-draft-reminders", "schedule": "0 16 * * *" }`)

**Interfaces:**
- Consumes: the `schedule-reminders` skeleton (`api/cron/schedule-reminders/route.ts:17-227`): timingSafeEqual CRON_SECRET, stamp-FIRST dedupe; `draft_reminder_sent_at` column (Task 1); `createNotification`; pref key `push_maintenance_draft_reminder`.
- Produces: daily 16:00 UTC pass over requests where `status = 'saved'` (draft never opened), `created_at < now() - interval '24 hours'`, `draft_reminder_sent_at is null`, not archived/cancelled.

- [ ] **Step 1: Failing route test** cases:

```ts
// 1. 401 without the CRON_SECRET header (timingSafeEqual path).
// 2. Eligible row: the UPDATE stamping draft_reminder_sent_at runs with
//    .is('draft_reminder_sent_at', null) BEFORE createNotification (order
//    asserted via call sequence) — the 2026-07-11 duplicate-bug guard.
// 3. A row whose guarded update matched 0 rows (another instance won) sends
//    NOTHING.
// 4. Notification copy is accurate: 'Your maintenance request MR-... was
//    saved, but no email draft has been opened yet. Open it in StockPilot to
//    finish sending it to DC4.' — sweep: no 'Email sent', no 'ticket'.
// 5. Requester with push_maintenance_draft_reminder=false is muted.
```

- [ ] **Step 2: Run to verify failure.** `pnpm --filter web test -- maintenance-draft-reminders` → FAIL.

- [ ] **Step 3: Implement** the route on the skeleton: admin client select of eligible rows (limit 200), per-row guarded `update ... set draft_reminder_sent_at = now() ... .is('draft_reminder_sent_at', null).select('id')` and only when a row comes back, pref-check + `createNotification` to `requester_user_id` with link `/dashboard/maintenance/${id}`. Register the vercel.json cron entry.

- [ ] **Step 4: Run to verify pass.** `pnpm --filter web test -- maintenance-draft-reminders && pnpm --filter web typecheck` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/app/api/cron/maintenance-draft-reminders apps/web/vercel.json
git commit -m "feat(maintenance): unsent-draft reminder cron with stamp-first dedupe"
```

## Task 23: Onboarding — tour, help registry, announcement

**Files:**
- Modify: `apps/web/src/lib/onboarding/tours.ts` (new `maintenanceRequestsTour`)
- Modify: the `ALL_TOURS` registry (help page) and `TOUR_ROUTES` in `apps/web/src/lib/onboarding/workflows.ts`
- Modify: `apps/web/src/lib/onboarding/announcements.ts` (append at TOP)

**Interfaces:**
- Consumes: the registries are DATA (project memory) — follow the existing tour object shape exactly (Read one existing tour first).
- Produces: a 5-step tour over `/dashboard/maintenance` (list → New → form → review actions → detail timeline); a What's New announcement titled `Maintenance requests` with body copy that obeys the status vocabulary: `Report facilities and equipment issues from StockPilot. Your request is saved with a request number, and StockPilot prepares the complete Outlook email for you to review and send.`

- [ ] **Step 1: Write the failing registry test additions** (the onboarding suites pin registry membership — add: tour id present in ALL_TOURS; TOUR_ROUTES maps the tour to `/dashboard/maintenance`; the announcement is first in the array; announcement body contains no forbidden phrase).
- [ ] **Step 2: Run to verify failure.** `pnpm --filter web test -- onboarding` → FAIL.
- [ ] **Step 3: Implement the three registry edits** following each file's existing object shapes verbatim.
- [ ] **Step 4: Run to verify pass.** `pnpm --filter web test -- onboarding && pnpm --filter web typecheck` → PASS.
- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/lib/onboarding
git commit -m "feat(maintenance): onboarding tour, help registry, whats-new announcement"
```

---

# Phase G — Gates, manual walk, report, ship checklist

## Task 24: The full gate + honesty sweeps + verification log

**Files:**
- Create: `docs/superpowers/reports/2026-08-05-maintenance-requests-verification.md` (real command output only — never "passes" without the text in front of you)

- [ ] **Step 1: Run every suite and record REAL output** (each command + its tail lines go in the log):

```bash
pnpm --filter @stockpilot/core test
pnpm --filter web test
pnpm --filter mobile test
pnpm --filter web typecheck && pnpm --filter mobile typecheck
pnpm --filter web lint
pnpm --filter web build
supabase db reset && supabase test db
```

Expected: ALL green, including the four delivery pinning suites (R1) and 0207 at 119.

- [ ] **Step 2: Honesty + boundary sweeps** (each result recorded in the log):

```bash
# No Zendesk API surface anywhere in the new code (GC 9) — hits must be
# comments/copy explaining the boundary, nothing executable:
grep -rni "zendesk" apps/web/src/components/maintenance apps/web/src/server/services/maintenance* \
  apps/web/src/app/api/v1/maintenance-requests apps/mobile/app/maintenance packages/core/src/maintenance
# Forbidden phrases in maintenance sources (GC 8) — expect ZERO hits:
grep -rn "Ticket created\|Request submitted to Zendesk\|DC4 notified\|Andrew notified\|Ticket assigned\|Email sent" \
  apps/web/src/components/maintenance apps/mobile/app/maintenance packages/core/src/maintenance
# No emoji anywhere in the diff (GC 17):
git diff main --unified=0 | grep -P "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]" || echo "no emojis"
# No co-author trailers on the branch (GC 17):
git log main..HEAD --format=%B | grep -i "co-authored-by" || echo "no trailers"
# The EXPO_ROUTES pin is honest — the screen file exists (landmine 21):
test -f "apps/mobile/app/(drawer)/maintenance.tsx" && echo "drawer screen exists"
```

- [ ] **Step 3: Tautology re-scan (GC 19).** Walk every new test file and confirm each cross-task contract value is pinned at least once against a LITERAL (addresses, compose base, 1800, subject prefix, status labels, route paths, pref keys, permission strings, bucket id, 180-day expiry). Record the file:line of each literal pin in the log. A test that compares a constant against itself is rewritten on the spot.

- [ ] **Step 4: Commit the log.**

```bash
git add docs/superpowers/reports/2026-08-05-maintenance-requests-verification.md
git commit -m "docs(maintenance): verification log with real gate output"
```

## Task 25: Manual authed browser walk (the honest E2E — audit Q10)

No Playwright CI gate exists and `location.assign` is unstubbable in real Chromium; this scripted walk + the Task 14 component tests ARE the Brief §31 E2E, and the report says so. **NO-SEND RULES BIND EVERY STEP (GC 2): in a real browser, NEVER click `Open in Outlook` unpatched, NEVER trigger the mailto path, NEVER open `/m/<token>` links in an email client.**

- [ ] **Step 1: Local walk (full flow, window.open monkeypatched).** Local stack up (`supabase db reset`, dev server; note: `apps/web/.env.local` points at LOCAL supabase — sign-in is BLOCKED if the stack is down). Enable the module for the dev org via local SQL. Then walk the Brief §31 E2E checklist, numbered:
  1. Sign in. 2. Create a request. 3. Custom subject typed. 4. Description typed. 5. Site selected. 6. Two photos uploaded (one HEIC to prove transcode). 7. Review screen shows all of it. 8. Exactly ONE request row exists (refresh the list). 9. In DevTools Console run `window.open = (u) => { console.log('INTERCEPTED', u); return { opener: {} }; }` — THEN click `Open in Outlook`: the URL is INTERCEPTED, nothing opens. 10. Logged URL contains `dc4%2540learn4life.org` (double-encoded To). 11. Contains `arosas%2540cvwest.org` in the cc hfield. 12. Subject param carries the typed subject + MR number. 13. Body param carries the description. 14. Body carries the `/m/<token>` share link. 15. No email was sent (nothing to check — nothing opened; the draft-opened stamp is the ONLY side effect). 16. The request now shows `Email draft opened`. 17. Visible in My Requests. 18. A manager account sees it in All Requests. 19. A second staff account CANNOT open its detail URL. 20. A second org's account gets no row (list empty, detail 404s).
  Also: popup-blocked panel via `window.open = () => null` (mailto assign will fire — patch `window.location.assign` in the console FIRST: `Object.defineProperty` is not available over `location` in Chromium, so instead verify this branch ONLY via the Task 14 component tests and record that limitation here — do NOT attempt it live); duplicate-draft dialog on second click; copy fallback content pasted into a scratch text file (NOT a mail client); share page opens in an incognito tab; revoke → the same URL 404s.
- [ ] **Step 2: Record the walk** step-by-step with screenshots/notes appended to the verification log, including the two explicitly-not-exercised paths (real popup-block, real mailto) and why.
- [ ] **Step 3: Commit the updated log.**

```bash
git add docs/superpowers/reports/2026-08-05-maintenance-requests-verification.md
git commit -m "docs(maintenance): manual walk record for the E2E checklist"
```

## Task 26: Engineering report + ship checklist (controller executes the ship)

**Files:**
- Create: `docs/superpowers/reports/2026-08-05-maintenance-requests-report.md`

- [ ] **Step 1: Write the Brief §33 report** with these sections, each grounded in the built code: Repository inspection (systems reused, with file:line); User workflow; **Zendesk boundary** (the email to DC4 creates the ticket via Zendesk email intake; Outlook/Zendesk own replies; StockPilot never knows whether Send was clicked, the ticket number, status, or comments; replying to the thread keeps updates on the same ticket per the org's Zendesk email configuration); Photo behavior (storage, magic-byte verification, share-link generation, download, why Outlook cannot auto-attach); Permissions (requester / read_all / manage / owner-configure / Andrew's per-user grant path); Files changed; Data model (tables, indexes, RLS policies verbatim); Tests (EVERY command + actual result, lifted from the verification log); Limitations (no direct Zendesk integration; no confirmed ticket creation; no status tracking; no comment sync; no automatic attachment insertion; photo links require the share link or app access; users must click Send; Q2 residual risk: another org's admin could self-enable the optional module — drafts would still target the L4L constants; C4/C8/C10 scope cuts); Future option (an approved Zendesk API integration could create tickets directly, attach photos, return ticket numbers, sync status, display comments, allow in-app replies — explicitly not in this phase).

- [ ] **Step 2: Append the SHIP CHECKLIST for the controller** (LOCAL work ends here — GC 20; order is BINDING, GC 7):

```text
1. supabase db push --linked        # migrations 0314 + 0315 FIRST (linked project xizpqmhhslgzbuqtjubv)
2. Open PR feat/maintenance-requests -> main; merge after review.
   Vercel deploys on push — do NOT also POST /v13/deployments.
3. Prod verify: dashboard loads; /dashboard/maintenance 404-free but module-gated.
4. Mobile OTA: cd apps/mobile && pnpm release:ota   (never raw `eas update`)
5. L4L enable — PROD DATA resolution, never name-matching, never a migration:
     select id, name from public.organizations where id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a';
   -- confirm the row is Learn4Life, then:
     update public.organization_modules set enabled = true, enabled_at = now()
      where organization_id = '63c13e64-92a6-4ea4-9936-6a2c26a85b4a'
        and module_id = 'maintenance_requests';
6. Prod verify walk in Demo Co (71b27a4a-7948-4638-bc3f-535974713bd2):
   TEMPORARILY enable the module for Demo Co (same UPDATE shape), walk the
   Task 25 script's SAFE subset (create, review, Copy Email Details only —
   NEVER click Open in Outlook in prod), verify mobile drawer + deep link,
   then DISABLE the module for Demo Co again and record both SQL statements
   and timestamps in the report.
7. Andrew's grant via the UI (zero new code): /dashboard/settings/roles ->
   per-user exceptions -> grant maintenance_requests:read_all + :manage to
   Andrew's member row; confirm his session updates WITHOUT re-login
   (broadcastPermissionsChanged) on web and mobile.
8. Owner hand-test on the live L4L tenant: one real request, owner reviews
   the Outlook draft and decides whether to press Send. StockPilot's job
   ended at the draft.
```

- [ ] **Step 3: Commit.**

```bash
git add docs/superpowers/reports/2026-08-05-maintenance-requests-report.md
git commit -m "docs(maintenance): engineering report and ship checklist"
```

- [ ] **Step 4: STOP.** Report to the controller: branch name, commit list, gate results, open items. No push, no merge, no db push, no OTA from this session.

---

## Coverage — Brief §32 acceptance criteria (all 40)

| # | Criterion | Task(s) |
|---|---|---|
| 1 | Enabled only for L4L | 1 (grandfather OFF), 3 (defaultOnFor []), 26 step 5 (prod-verified enable); Q2 residual risk in report |
| 2 | Web and mobile versions exist | 12-17 (web), 18-20 (mobile) |
| 3 | Employees enter their own subject | 6 (schema), 13 (form test 1) |
| 4 | Detailed issue description | 6, 13 (form test 2) |
| 5 | Request saved before Outlook opens | 13 (save -> redirect to review), 14 (action requires a saved request id) |
| 6 | Human-readable request number | 1 (0254-clone trigger), 6 (formatter tests), 12 (list render) |
| 7 | Outlook To = dc4@learn4life.org | 6 (literal pin), 7 (email tests 1/19), 14 (open URL assertion) |
| 8 | Outlook CC = arosas@cvwest.org | 6, 7 (tests 2/19), 14 |
| 9 | Subject = employee issue + request number | 7 (tests 3/4) |
| 10 | Body includes complete description | 7 (tests 5/15) |
| 11 | Requester info auto-populated | 8 (session/profile snapshots test) |
| 12 | Site info auto-populated | 13 (form test 3), 8 (charter join) |
| 13 | Related item/order info when selected | 7 (tests 9/10), 8 (emailInput server snapshot), 17 (prefill) |
| 14 | Photo uploads | 9 (mint/finalize), 13 (web panel), 19 (mobile) |
| 15 | Photos visible inside StockPilot | 15 (detail), 20 (mobile detail) |
| 16 | Secure photo links in the email | 10 (share links), 7 (test 12), 11 (settings-gated shareUrl) |
| 17 | Photo download for manual attachment | 15 (C5 anchors), 20 (C10 Linking) |
| 18 | Clear cannot-auto-attach explanation | 14 (exact helper copy asserted) |
| 19 | No automatic sending | GC 2/8; 7, 14, 20, 24 sweeps; no send path exists anywhere |
| 20 | No ticket-created claims | 6 (labels), 12/14/15/18/20/21/22 sweeps |
| 21 | No Zendesk synchronization | GC 9; 24 Step 2 grep gate |
| 22 | Outlook/Zendesk handle replies | 7 (reply-thread guidance line), 12/18 (list note) |
| 23 | Requesters see own requests | 1 (pgTAP), 8 (list mine), 12 |
| 24 | Authorized users see all | 1 (pgTAP manager), 8 (scope all), 12 |
| 25 | Owner controls all-request access | 3 (configure owner-only, C2), 16 (roles-matrix link) |
| 26 | Andrew sees all when configured | 1 (pgTAP override test), 21 (audience test 1), 26 step 7 |
| 27 | Other orgs cannot access | 1 (pgTAP cross-org), 8 (org scoping pins) |
| 28 | Duplicate-draft warnings | 8 (recordDraftOpened), 14 (dialog tests), 20 (Alert) |
| 29 | Popup-blocked fallbacks | 14 (blocked suite) |
| 30 | Copy fallback | 14 (copy suite + textarea), 20 (selectable TextInput) |
| 31 | Photo security | 2 (bucket), 9 (sniff/rate/prefix), 10 (revocable links) |
| 32 | RLS tests pass | 1, 2 (pgTAP), 24 (supabase test db) |
| 33 | Unit tests pass | 4, 6, 7, 8, 9, 10, 11, 21, 22; 24 gate |
| 34 | Component tests pass | 12, 13, 14, 15, 17; 24 gate |
| 35 | Web E2E tests pass | GC 26: 14 (component flows) + 25 (scripted walk) — deviation documented in 26 |
| 36 | Mobile tests pass | 18, 19, 20; 24 gate |
| 37 | Typecheck passes | 24 |
| 38 | Lint passes | 24 |
| 39 | Production web build passes | 15 Step 4, 24 |
| 40 | Mobile build validation | 24 (mobile test + typecheck); OTA-safety = pure-JS audit in 24 Step 2 + GC 13 |

## Coverage — Brief sections 1-33

| § | Where |
|---|---|
| 1 Objective | 13 (prefill kills re-entry), 14 (one-click draft) |
| 2 Scope | GC 8/9; controller adjudications C1-C10 |
| 3 Inspect first | The Phase 1 audit; every task cites file:line |
| 4 L4L-only module | 1, 3, 26; Q2/landmine 19 risk recorded |
| 5 Permission model | 1 (seeds + RLS), 3 (registry/meta) |
| 6 God Admin config | 3 (C2 owner-only configure), 16 (settings + matrix link), 26 step 7; live propagation pre-exists (audit 2.2) |
| 7 Form | 6 (schema/sanitizers), 13 (labels/placeholders asserted) |
| 8 Related records | 8 (server snapshots), 13 (prefill), 17 (web launch points), 20 (mobile); Q5/Q6/Q11 |
| 9 Photo uploads | 2, 9, 13, 19; caps in 6 |
| 10 Outlook attachment limitation | 14 (notes + download), 10 (share links), C5/C10; Q7 |
| 11 Creation flow | 8 (create), 13 (save-then-review), 1 (numbering) |
| 12 Review screen | 14 (title, actions, helper copy asserted) |
| 13 Recipients | 6 (frozen literals, no override path), 7 (builder takes no recipient arg) |
| 14 Subject | 7 (prefix, dedupe, no UUID) |
| 15 Body | 7 (blocks, omission rules, never undefined/null) |
| 16 Compose strategy | GC 1 (adjudicated mechanics), 4, 14 |
| 17 mailto fallback | 4, 7 (test 20), 14, 20 |
| 18 Copy fallback | 4, 14 (exact toast + textarea), 20 (Q9) |
| 19 Popup-blocked | 14 (exact message + four actions) |
| 20 Status language | 6 (labels), GC 8 sweeps in 7/12/14/15/18/20/21/22/24 |
| 21 Duplicate protection | 8, 14, 20 |
| 22 List | 12 (web), 18 (mobile); search C7 |
| 23 Detail | 15 (StockPilot-only timeline), 20 |
| 24 Web interface | 12-17 (house conventions; no new UI library) |
| 25 Mobile interface | 18-20 (Expo routes, Bearer API, no DB creds) |
| 26 Notifications | 21 (audiences + prefs), 22 (reminder cron); C9/Q12 |
| 27 Data model | 1 (C1 status column; Q4/Q5 deviations documented in-file) |
| 28 RLS | 1 (policies + pgTAP), GC 6 |
| 29 Security & privacy | GC 2/12/27; 9 (sniff/rate/filenames), 10 (tokens), 24 sweeps |
| 30 Shared Outlook utility | 4 (createOutlookComposeEmail), 5 (wrappers), 7 (separate pure builder) |
| 31 Testing | Tables below; 24-25 gates |
| 32 Acceptance criteria | Table above |
| 33 Final report | 26 |

## Coverage — audit §4 landmines (all 39)

| Landmine | Encoded at |
|---|---|
| 1 compose mechanics superseded | GC 1; Task 4 (constants + comments + pins) |
| 2 R3 ordering | Task 14 test (order array) + handler; Task 20 Step 4 |
| 3 linkFits opens NOTHING | GC 16; Tasks 7/14/20 tests |
| 4 never unify To handling | Task 4 (mailto stays bare-address; test asserts) |
| 5 unquoted display names | Task 4 assertSafeDisplayName; Task 6 name test |
| 6 recipients never in body / builder takes none | Task 7 tests (body sweep; builder reads constants) |
| 7 disclosure byte-intact contiguous | Task 7 condense test |
| 8 forbidden-phrase sweeps at every layer | GC 8; Tasks 6/7/12/14/15/18/20/21/22/24 |
| 9 DialogContent max-w-lg; no z-[100] | GC 18; Task 14 Step 3 |
| 10 Radix aria-hides siblings -> live region inside dialog | Task 14 spec line 6 + Step 3 |
| 11 plain-button triggerRef focus restore | Task 14 Step 3: port delivery-request-action.tsx:108-116 onCloseAutoFocus + own ref |
| 12 sf-* storefront CSS | Phase D preamble; Task 14 Step 3 |
| 13 requiresAnyOf nav | GC 25; Task 3 (placement test) |
| 14 pattern #24 alter policy | GC 21 (0314 creates fresh policies; any later change drops+recreates) |
| 15 pattern #23 NEXT_REDIRECT + not.in | GC 21; Task 8 ('active' filter JS-side), Task 11 (withApiContext everywhere) |
| 16 seed_org_modules wholesale | GC 22; Task 1 Step 3 (0297 body verbatim + one row) |
| 17 pgTAP 111 -> N | GC 5 (=119); Task 1 Steps 4-5 (real failure text then bump) |
| 18 grants + additive policies + disabled-excluded | GC 6; Task 1 (grants + policy shapes) |
| 19 strict L4L-only unachievable | GC 4 + Q2 acceptance; Task 26 report Limitations |
| 20 0312 inline storage guard | GC 24; Task 2 policy |
| 21 EXPO_ROUTES dead-tap | Task 3 (adds '/maintenance' with the warning), Task 18 (ships the screen), Task 24 Step 2 (existence check) |
| 22 DEFAULT_MODULE_IDS / ctxWithout | Task 3 test; Task 8 module-off test; GC 18 |
| 23 signed URLs are not email links | GC 12; Task 9 (1h app-only TTL), Task 10 (/m token), Task 7 (shareUrl only) |
| 24 declared-MIME-only buckets | Task 9 (sniff at finalize) |
| 25 no upload rate limit today | Task 9 (checkRateLimit on mint, closed) |
| 26 HEIC unrenderable originals | GC 11; Task 2 (bucket pins), 13 (heic2any), 19 (forced JPEG) |
| 27 thumb 200/400 drift | Task 13 Step 4 note (fix or knowingly inherit, recorded) |
| 28 no on-demand transforms; throw-on-sign-failure | Task 9 (pre-generated thumbs; signedViewUrls throws) |
| 29 arrayBuffer/createUploadTask never blob | GC 11; Task 19 (BINARY_CONTENT) |
| 30 body URLs eat the 1800 budget | Task 7 (Q13 condense keeps ONE link) |
| 31 web-path-rewrite three doors | GC 10; Task 18 Steps 1-3 (rules + tests) |
| 32 one push path / one insert path | GC 23; Task 21 test 5 |
| 33 cron stamp-first dedupe | GC 23; Task 22 test 2/3 |
| 34 pref keys regular module; fail-open; never widen _notify_recipients | GC 23; Task 21 (resolveMaintenanceAudience) |
| 35 OTA pure-JS; drawer/stack registration; simulator rule | GC 13; Phase E preamble + every mobile task's simulator step |
| 36 sites-only site encoding | GC 28; Task 13 (charter-based site select; locations untouched) |
| 37 supabase-mock ignores filters | GC 18; Task 8 chains/chainArgs pins + Task 1 pgTAP |
| 38 happy-dom idioms | GC 18; Task 14 Step 1 harness (defineProperty + restore + attribute aria) |
| 39 no Playwright gate; location.assign unstubbable | GC 26; Task 25 (walk + documented not-exercised paths) |

## Coverage — Brief §31 test lists

**Email-builder (21):** all in `packages/core/src/maintenance/email.test.ts` (Task 7), tagged `(1)`-`(21)` in test names. **Permission (10):** (1)-(3) 0314 pgTAP requester block; (4) pgTAP manager; (5) pgTAP assign-owner; (6) pgTAP notes; (7) pgTAP owner-visibility check; (8) pgTAP cross-org; (9) pgTAP module-off insert + Task 8 module-disabled test; (10) pgTAP Andrew override + Task 21 audience test 1. **Photo (12):** (1)(2) `image-signature.test.ts` + attachments test 4; (3) Task 13 (heic2any) + Task 19 test 1 (forced JPEG); (4) attachments test 3 + sniffer rejects; (5) attachments test 7; (6) sniffer fake-MIME + attachments tests 5/6; (7) Task 13 variants thumb + Task 19 step 4; (8) attachments test 8 (prefix forgery) + 0314 attachment RLS; (9)(10) share-links test 5 (revoked/expired -> generic null); (11) Task 14 test "removing a photo updates the email preview" (photoCount rerender); (12) Task 10 (signing failure skips one photo, page still renders) + Task 14 (open path independent of photos). **Component (14):** (1)-(4) Task 13 form tests; (5) Task 13 photos-panel test; (6) Task 14 review render; (7)-(9) Task 14 open/blocked/copy suites; (10) Task 14 download-anchor presence test; (11) Task 14 duplicate-draft suite; (12) Task 15 (saved request + detail edit — no client-state loss possible); (13) Task 13 form test 13; (14) Task 14 honesty sweep. **E2E web (20):** Task 25 Step 1's numbered script (satisfied per GC 26; deviation documented). **Mobile:** form submission (Task 19 simulator + upload tests), camera/library (Task 19), item scan association (Task 20 launch point), Outlook/deep-link action (Task 20 tests), copy fallback (Task 20 selectable TextInput), permission-based list visibility (Task 18 canReadAll gate), request detail (Task 20), local notifications deep link (Task 18 rewrite tests + Task 21 link pin).

---

## Self-review (performed while writing; results inline)

**Spec coverage sweep.** Walked all 33 brief sections and 40 criteria against the tables above; every row points at a concrete task. Deliberate deviations are named, adjudicated, and routed to the §33 report: C1-C10 plus audit Q1-Q14 as resolved by the audit. Nothing in the brief is silently dropped; the three scope cuts (drag-reorder C8, client-network-failure notification C4, mobile native share sheet C10/Q9) are explicit.

**Placeholder scan.** No TBD/TODO/"similar to Task N" remains. Three spots intentionally direct the executor to verify a REAL value before wiring, each bounded and named: Task 8 (rentals/order display columns — verify against 0131/0044 before `emailInput`), Task 12 (`ModuleNotEnabled` exact props from cycle-counts), Task 13 (`compressImageVariants` return property names). These are verification steps against existing code, not missing design. Where a task says "same scaffolding as Task N Step M" the referenced code is complete in that step and the file paths differ only as listed.

**Type consistency.** Names fixed across tasks:

| Name | Defined | Consumed |
|---|---|---|
| `composeOutlookWebUrl / composeMailtoUrl / composeClipboardText / createOutlookComposeEmail / ComposeInput / ComposedEmail / OUTLOOK_COMPOSE_BASE / DRAFT_URL_LIMIT / encodeDraftQuery / assertSafeDisplayName` | 4 | 5, 7 |
| `L4L_MAINTENANCE_EMAIL(_NAMES) / MAINTENANCE_* constants / MaintenanceStatus / MaintenancePriority` | 6 | 7, 8, 12, 13, 14, 16, 18, 20 |
| `formatMaintenanceRequestNumber / parseMaintenanceRequestNumber` | 6 | 8, 12, 18 |
| `sanitizeSubjectLine / sanitizeDescriptionBlock` | 6 | 7 |
| `maintenanceRequestFormSchema / MaintenanceRequestFormValues` | 6 | 8, 13, 18, 19 |
| `MaintenanceEmailInput / MaintenanceEmailDraft / PreparedMaintenanceEmail / buildMaintenanceEmailDraft / prepareMaintenanceEmail / MAINTENANCE_CONDENSED_DISCLOSURE` | 7 | 8, 11, 14, 20 |
| `MaintenanceRequestsService (create/list/get/update/archive/cancel/assignLocalOwner/addNote/listNotes/recordDraftOpened/emailInput) / MaintenanceRequestListRow / MaintenanceRequestDetail` | 8 | 11, 12, 15, 21, 22 |
| server actions (`createMaintenanceRequestAction` ... `recordMaintenanceDraftOpenedAction`) | 8 | 13, 14, 15 |
| `sniffImage / MIME_FOR_KIND / SniffedImage` | 9 | 9 (service) |
| `MaintenanceAttachmentsService (createUploadUrl/finalize/remove/signedViewUrls)` | 9 | 11, 13 (routes/fetch), 19 (via API) |
| `MaintenanceShareLinksService (ensureActiveLink/revoke) / resolveMaintenanceShareToken` | 10 | 11, 15 |
| API JSON shapes (`GET/POST /api/v1/maintenance-requests...`) | 11 | 18, 19, 20 |
| `MaintenanceStatusBadge` | 12 | 15 |
| `MaintenanceRequestForm / MaintenancePhotosPanel / PanelPhoto` | 13 | 15 |
| `MaintenanceEmailAction / MaintenanceReview` | 14 | 15 |
| `MaintenanceModuleSettings / updateMaintenanceSettingsAction` | 16 | 11 (route reads settings), 21 (notifyAudience) |
| `listMaintenanceRequests / getMaintenanceRequest / createMaintenanceRequest / recordDraftOpened / mintPhotoUpload / finalizePhoto` | 18 | 19, 20 |
| `uploadMaintenancePhoto / UploadError` | 19 | 19 (screen) |
| `openOutlookDraft / openMailtoDraft` | 20 | 20 (screen) |
| `resolveMaintenanceAudience / notifyMaintenanceEvent / MaintenanceNotifyEvent` | 21 | 8 (emit hooks), 22 |
| Pref keys `push_maintenance_*` (4) | 1 (columns), 21 (TS keys) | 21, 22 |

**Cross-checks fixed inline while reviewing:** the 0314 pgTAP `plan()` count was recounted against its select list (26 including the owner-visibility check); the PHOTOS paragraph in the core builder is assembled inline because `block()` strips blank lines (noted in Task 7); the Task 19 thumb is JPEG against a `-thumb.webp` mint path — the note in Task 19 Step 3 resolves it (extend Task 9's mint with `thumbExt` if strictness is wanted, in Task 9); `serviceErrorStatus` unused-import note in Task 8 Step 6.
