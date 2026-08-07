# Maintenance Resolved — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the owner-approved Resolved close-out to the shipped Maintenance Requests module (PR #73, migrations 0314-0316): a fifth `resolved` status recorded by a manage-holder through a dialog requiring a resolution note and allowing optional proof photos (the shipped attachment pipeline, new `kind`), requester notification on BOTH channels (muteable in-app/push ping + an at-most-once Resend email carrying the resolver's name, the verbatim note, proof photos via the 180-day share-photo proxy, and the non-negotiable honesty line), proof labeled distinctly on the detail page and the public `/m/` share page, full-history semantics (resolved keeps its own pill; archive only re-buckets), and full mobile parity in the same program — resolved status/badge/filter plus Resolve/Archive/Assign owner/Internal notes actions, pure-JS OTA-safe on the live 1.1.0 binary.

**Design:** `docs/superpowers/specs/2026-08-06-maintenance-resolved-design.md` (binding; encodes owner decisions D1-D5 — do not reopen them). "Spec §n" below refers to that file.

**Architecture:** One migration (0317) widens the status CHECK, adds the resolution columns + the at-most-once email stamp + `maintenance_request_attachments.kind` + the `push_maintenance_resolved` pref column, and recreates three RLS policies (drop+create, never `alter policy`). The service grows `resolve()` mirroring `archive()`'s guarded-update discipline; `archive()` becomes the D1 re-bucket (accepts resolved AND cancelled rows). The email is a new es-registry row (`maintenance-resolved`, new `maintenance` family) rendered by the shared component layer and dispatched by a `return-prompt.ts`-twin at-most-once sender through the ONE `sendEmail` seam. Mobile ships four new Bearer routes' worth of actions on the existing detail screen, pure JS.

**Tech Stack:** TypeScript, Next.js 16 App Router, React 19, zod, Supabase (Postgres RLS + Storage + pgTAP), vitest + happy-dom + @testing-library/react, Resend (server-side transactional email, ALWAYS stubbed in tests), sonner, Radix Dialog, `@stockpilot/core`, Expo (nothing new — 1.1.0 binary as-is).

---

## Global Constraints

Binding on every task. "Spec §n" = `docs/superpowers/specs/2026-08-06-maintenance-resolved-design.md`. Constraints 1-20 carry forward from `docs/superpowers/plans/2026-08-05-maintenance-requests.md` where still applicable; the email-specific ones are new.

1. **NO REAL EMAIL, EVER.** `dc4@learn4life.org` / `arosas@cvwest.org` remain real addresses no test may compose toward (string assertions only, unchanged). NEW and equally binding: the resolution email path is REAL sending code — **every test that can reach it stubs the transport seam with `vi.hoisted(() => vi.fn())` + `vi.mock('@/lib/email/resend', () => ({ sendEmail: sendEmailMock }))`, the exact `apps/web/src/server/email/return-prompt.test.ts:22-25` pattern.** `sendEmail`'s no-API-key dry-run is NOT an acceptable substitute for the stub. No test, tool, walk step, or verification command may ever cause a real email to be sent to anyone; the manual walk runs against the local stack with no `RESEND_API_KEY` and only ever resolves a request whose requester is the demo account itself.
2. **Email transport = `sendEmail` from `@/lib/email/resend` only.** Never the Supabase built-in mailer (capped ~2/hr, silent failures — the auth-email landmine), never a direct `fetch` to `api.resend.com`, never a second send path. Sender address `StockPilot <maintenance@stockpilotusa.com>` rides the verified domain.
3. **AT-MOST-ONCE per request** for the resolution email: `resolution_email_sent_at` stamped via guarded update (`.is('resolution_email_sent_at', null).select('id').maybeSingle()`) BEFORE the send; only the claim winner sends; the marker stays set after a failed send (missed-email-over-duplicate — the 0278 returns posture, verbatim).
4. **Accurate status language ONLY** — the spec §11 vocabulary. Newly allowed for the new state: `Resolved`, `Marked resolved`, `marked resolved by <name>`, "recorded by your team in StockPilot". Forbidden everywhere, tests sweep for them: `Email sent`, `Ticket created`, `Request submitted to Zendesk`, `DC4 notified`, `Andrew notified`, `Ticket assigned`, `Ticket closed`, `Ticket resolved`, `Zendesk ticket closed`, `Zendesk ticket updated`, `Zendesk ticket resolved`, `Issue verified fixed`. The honesty line is verbatim and literal-pinned: **"This resolution was recorded by your team in StockPilot. It does not close or update the Zendesk ticket — replies and ticket status stay in the Outlook/Zendesk email conversation."**
5. **Pattern #24:** never `alter policy ... with check` — every touched policy is `drop policy` + `create policy` with the FULL predicate text. **Pattern #25:** every correlated EXISTS keeps its outer-table qualification (`r.organization_id = <child_table>.organization_id`) verbatim. **Pattern #23:** PostgREST `not.in`/`.neq` drops NULL rows — lifecycle filters stay JS-side (the shipped `list()` 'active' filter is already JS and gains nothing); SQL uses `is distinct from` where needed; API routes use `withApiContext`, never `requireOrgContext`.
6. **MIGRATIONS BEFORE WEB DEPLOY at ship.** 0317 pushes via `supabase db push --linked` (project `xizpqmhhslgzbuqtjubv`) BEFORE the code merge deploys — `resolve()` writes a status value the old CHECK rejects, so code-before-migration is an outage class (the account-disable lesson). Ship order in Task 11's checklist is binding.
7. **Mobile is PURE JS / OTA-safe on the live 1.1.0 binary.** No new native modules, no new packages: `git diff` on `apps/mobile/package.json` and `pnpm-lock.yaml` must be EMPTY across the whole program (Task 11 gate-checks this literally). OTA ships via `cd apps/mobile && pnpm release:ota` — never raw `eas update`. Simulator hand-test owed after mobile tasks (owner rule; record honestly if the pre-existing dev-client boot crash blocks it).
8. **Web test-harness idioms are mandatory:** `supabase-mock.ts` replays canned `'<table>.<op>'` data and IGNORES filters — every `.eq`/`.is` guard that matters is pinned via `chains`/`chainArgs` call-recording assertions AND (for RLS) pgTAP; vocabulary sweeps drive `document.body` across ALL dialog/UI states (Radix portals — the Task 14 lesson); happy-dom aria via `toHaveAttribute`; `Object.defineProperty` for window globals.
9. **TEST-TAUTOLOGY RULE.** Every cross-task contract value gets a LITERAL pin at least once per suite — the five status literals + labels, `push_maintenance_resolved`, the honesty line, `maintenance@stockpilotusa.com`, the subject shape `Maintenance request MR-… marked resolved`, route paths (`/resolve`, `/archive`, `/assign-owner`, `/notes`, `/members`), kind literals `requester`/`resolution`, the 2000-char note cap, the proxy URL shape `/m/<token>/photo/<n>`. Never only a comparison against the same imported constant the implementation reads.
10. **Mutation self-checks are per-task and uniquely named** (`T<task>-M<n>`). Each task's self-check step lists its mutations, the exact test expected to kill each, and requires the implementer to RUN at least the listed ones (revert-verify). A mutation surviving = the task is not done.
11. **Notification discipline:** `createNotification()` is the ONE insert path; push rides the 0028 AFTER-INSERT trigger; the new pref key lives in the regular module `lib/notification-prefs.ts`; the gate is fail-OPEN (only explicit `false` mutes); the link literal `/dashboard/maintenance/${requestId}` is already covered by the shipped `web-path-rewrite.ts` rules — do not change its shape.
12. **History is sacred (D4):** no DELETE of any maintenance row anywhere in this program; SELECT policies untouched; `archive()` preserves `resolved_at`/`resolved_by`/`resolved_by_name_snapshot`/`resolution_note`/`cancelled_at` — a test pins that the archive update object contains none of those keys.
13. **No emojis anywhere** (code, copy, commits, docs). **No Claude/Anthropic co-author trailer** on any commit — history is `Branden574` only. Plain professional prose.
14. **LOCAL COMMITS ONLY during execution** on branch `feat/maintenance-resolved` (cut from `main`). Never push, never merge, never `supabase db push`, never OTA — the controller ships via Task 11's checklist.
15. **Regression assertions at every commit:** `pnpm --filter @stockpilot/core test`, `pnpm --filter web test`, `pnpm --filter mobile test`, `pnpm --filter web typecheck`, `pnpm --filter mobile typecheck` all green; pgTAP green locally after migration-touching tasks (`supabase db reset` first — the local stack requires a reset to pick up new migrations); the four delivery pinning suites and the shipped 441-test maintenance surface stay green unmodified except where a task explicitly updates a pin (each such update is itemized in that task).
16. **Never log** share tokens, signed storage URLs, resolution-note content, or compose URLs. Audit `extra` for `maintenance_request.resolved` is `{ has_note, proof_photo_count }` — never the note text (GC 27 posture).

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `supabase/migrations/0317_maintenance_resolved.sql` | NEW — status CHECK widen; resolution columns + email stamp; attachments `kind`; 3 RLS policy recreates; pref column | 1 |
| `supabase/tests/0317_maintenance_resolved.test.sql` | NEW — pgTAP for all of the above | 1 |
| `packages/core/src/maintenance/constants.ts` | MODIFIED — `resolved` status + label; `MAINTENANCE_ATTACHMENT_KINDS`; `MAINTENANCE_RESOLUTION_NOTE_MAX` | 2 |
| `packages/core/src/schemas/maintenance.ts` | MODIFIED — `maintenanceResolveSchema` | 2 |
| `packages/core/src/maintenance/constants.test.ts`, `packages/core/src/schemas/maintenance.test.ts` (or sibling suite) | MODIFIED — literal pins | 2 |
| `apps/web/src/components/maintenance/maintenance-status-badge.tsx` (+ test) | MODIFIED — `resolved` variant (typecheck-forced) | 2 |
| `apps/mobile/app/maintenance/[id].tsx`, `apps/mobile/app/(drawer)/maintenance.tsx` | MODIFIED (minimal in T2: `STATUS_PILL.resolved` typecheck fix) | 2, 9, 10 |
| `apps/web/src/server/services/maintenance-attachments.ts` (+ test) | MODIFIED — `kind` end-to-end, per-kind caps, manage gate for `resolution` | 3 |
| `apps/web/src/app/api/v1/maintenance-requests/[id]/attachments/route.ts`, `.../finalize/route.ts` (+ tests) | MODIFIED — optional `kind` field | 3 |
| `apps/web/src/components/maintenance/maintenance-photos-panel.tsx` (+ test) | MODIFIED — `kind` prop threaded into mint/finalize bodies | 3 |
| `apps/web/src/server/services/maintenance-share-links.ts` (+ test) | MODIFIED — `kind` in projection; `resolution` block; ordering tiebreaker | 3 |
| `apps/web/src/app/m/[token]/page.tsx` (+ test) | MODIFIED — Resolution proof section + resolution note/status line | 3 |
| `apps/web/src/server/services/maintenance-requests.ts` (+ test) | MODIFIED — `resolve()`; archive/cancel/update/recordDraftOpened guard changes; detail fields | 4 |
| `apps/web/src/server/services/audit.ts` | MODIFIED — `maintenance_request.resolved` union member | 4 |
| `apps/web/src/server/services/maintenance-notify.ts` (+ test) | MODIFIED — `resolved` event + pref key + title | 4 |
| `apps/web/src/lib/notification-prefs.ts` | MODIFIED — `push_maintenance_resolved` | 4 |
| `apps/web/src/components/settings/notification-preferences-form.tsx` (+ test) | MODIFIED — 1 TOGGLE_DEFS row | 4 |
| `apps/web/src/app/api/cron/maintenance-draft-reminders/route.ts` (+ test) | MODIFIED — `.is('resolved_at', null)` hedge | 4 |
| `apps/web/src/server/actions/maintenance-requests.ts` (+ test) | MODIFIED — `resolveMaintenanceRequestAction` | 4 |
| `apps/web/src/lib/email/es/registry.ts` (+ `registry.test.ts` 29→30) | MODIFIED — `maintenance` family + `maintenance-resolved` row | 5 |
| `apps/web/src/lib/email/es/families/maintenance.ts` (+ test) | NEW — `renderMaintenanceResolvedEmail` + `MAINTENANCE_RESOLVED_HONESTY_LINE` | 5 |
| `apps/web/src/server/email/maintenance-resolved.ts` (+ test) | NEW — `maybeSendMaintenanceResolvedEmail` (at-most-once) | 6 |
| `apps/web/src/components/maintenance/resolve-request-dialog.tsx` (+ test) | NEW — note + proof + confirm | 7 |
| `apps/web/src/app/(dashboard)/dashboard/maintenance/[id]/detail-client.tsx` + `page.tsx` (+ tests) | MODIFIED — Resolve action, gating, Resolution card, proof section, timeline row, archive copy | 7 |
| `apps/web/src/app/(dashboard)/dashboard/maintenance/page.test.tsx` | MODIFIED — five-label pill pin | 7 |
| `apps/web/src/app/api/v1/maintenance-requests/[id]/{resolve,archive,assign-owner,notes}/route.ts`, `apps/web/src/app/api/v1/maintenance-requests/members/route.ts` (+ tests) | NEW — mobile parity routes | 8 |
| `apps/web/src/app/api/v1/maintenance-requests/[id]/route.ts` (+ test) | MODIFIED — detail response gains resolution fields | 8 |
| `apps/mobile/src/lib/maintenance-api.ts` (+ test) | MODIFIED — status param; detail/photo mirrors; 6 new wrappers | 9, 10 |
| `apps/mobile/app/(drawer)/maintenance.tsx` (+ helper test) | MODIFIED — status chips row | 9 |
| `apps/mobile/app/maintenance/[id].tsx` | MODIFIED — Resolution card + proof section (9); actions cards (10) | 9, 10 |
| `apps/mobile/src/lib/maintenance-upload.ts` (+ test) | MODIFIED — `kind` threading | 10 |
| `apps/mobile/src/lib/maintenance-actions.ts` (+ test) | NEW — extracted pure decision helpers for the action cards | 10 |
| `docs/superpowers/reports/2026-08-06-maintenance-resolved-verification.md` | NEW — gate output + walk record | 11 |
| `docs/superpowers/reports/2026-08-06-maintenance-resolved-report.md` | NEW — engineering report + ship checklist | 11 |

---

# Phase 1 — Database + core vocabulary

## Task 1: Migration 0317 — status widen, resolution columns, attachment kind, RLS recreates, pref column, pgTAP

**Files:**
- Create: `supabase/migrations/0317_maintenance_resolved.sql`
- Create: `supabase/tests/0317_maintenance_resolved.test.sql`

**Interfaces:**
- Consumes: 0314's tables/policies verbatim (policy names `maintenance_requests_update`, `maintenance_request_attachments_insert`, `maintenance_request_attachments_delete`); `public.has_org_role` / `has_permission` / `module_enabled`; the 0316 unique index (must survive).
- Produces (later tasks rely on EXACT names): columns `maintenance_requests.resolved_at`, `.resolved_by`, `.resolved_by_name_snapshot`, `.resolution_note`, `.resolution_email_sent_at`; `maintenance_request_attachments.kind` (`'requester'|'resolution'`, default `'requester'`); `notification_preferences.push_maintenance_resolved`; the widened 5-value status CHECK.
- NO permission seed changes: the 0207 pgTAP count stays 119.

- [ ] **Step 1: Write the failing pgTAP test** — `supabase/tests/0317_maintenance_resolved.test.sql`:

```sql
begin;
select plan(17);

-- ── Fixtures (0314-test conventions) ────────────────────────────────────────
\set org_a '''a0000000-0000-0000-0000-00000000001a'''
\set requester '''20000000-0000-0000-0000-000000000001'''
\set mgr '''20000000-0000-0000-0000-000000000002'''

insert into auth.users (id, email) values
  (:requester, 'res-req@test.local'), (:mgr, 'res-mgr@test.local');
insert into public.user_profiles (id, full_name) values
  (:requester, 'Res Req'), (:mgr, 'Res Mgr')
on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:org_a, 'Resolved Org A', 'resolved-org-a');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org_a, :requester, 'staff', now()),
  (:org_a, :mgr, 'manager', now());
update public.organization_modules set enabled = true
 where organization_id = :org_a and module_id = 'maintenance_requests';

-- ── Structure ───────────────────────────────────────────────────────────────
select has_column('public', 'maintenance_requests', 'resolved_at', 'resolved_at exists');
select has_column('public', 'maintenance_requests', 'resolved_by', 'resolved_by exists');
select has_column('public', 'maintenance_requests', 'resolved_by_name_snapshot', 'name snapshot exists');
select has_column('public', 'maintenance_requests', 'resolution_note', 'resolution_note exists');
select has_column('public', 'maintenance_requests', 'resolution_email_sent_at', 'email stamp exists');
select has_column('public', 'maintenance_request_attachments', 'kind', 'attachment kind exists');
select has_column('public', 'notification_preferences', 'push_maintenance_resolved', 'pref column exists');
-- 0316 uniqueness must survive this migration untouched.
select has_index('public', 'maintenance_request_attachments',
  'maintenance_request_attachments_org_path_uniq', '0316 unique index still present');
-- 0207 seed count is deliberately UNTOUCHED by this program (119) — no
-- maintenance permissions are added; do not bump that suite.

-- ── Create an OPEN request as the requester ─────────────────────────────────
set local "request.jwt.claim.sub" to '20000000-0000-0000-0000-000000000001';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

insert into public.maintenance_requests
  (organization_id, requester_user_id, requester_name_snapshot, subject, description)
values (:org_a, :requester, 'Res Req', 'Leaking roof tile in Hall B', 'Water drips during rain.');

-- ── RLS: the kind clause, tested on the still-OPEN parent ───────────────────
-- Deliberately BEFORE the resolve below: on an open request the kind clause
-- is the ONLY thing refusing this insert, so mutation T1-M2 (deleting the
-- clause) is genuinely killable here — after the resolve, the parent-open
-- clause would mask it.
select throws_ok(
  $$ insert into public.maintenance_request_attachments
       (organization_id, maintenance_request_id, storage_path, original_filename,
        safe_filename, mime_type, byte_size, uploaded_by, kind)
     select 'a0000000-0000-0000-0000-00000000001a', id,
        'a0000000-0000-0000-0000-00000000001a/' || id || '/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg',
        'p.jpg', 'p.jpg', 'image/jpeg', 100, '20000000-0000-0000-0000-000000000001', 'resolution'
       from public.maintenance_requests limit 1 $$,
  '42501', null, 'requester cannot insert kind=resolution on their own OPEN request');
reset role;

-- ── Status CHECK ────────────────────────────────────────────────────────────
update public.maintenance_requests
   set status = 'resolved', resolved_at = now(), resolved_by = :mgr,
       resolved_by_name_snapshot = 'Res Mgr',
       resolution_note = 'The issue for the leaking roof tile has been resolved.'
 where organization_id = :org_a;
select is(
  (select status from public.maintenance_requests where organization_id = :org_a),
  'resolved', 'status CHECK accepts resolved');
select throws_ok(
  $$ update public.maintenance_requests set status = 'zendesk_closed'
      where organization_id = 'a0000000-0000-0000-0000-00000000001a' $$,
  '23514', null, 'status CHECK rejects unknown values');

-- ── RLS: requester cannot edit own RESOLVED row ─────────────────────────────
set local "request.jwt.claim.sub" to '20000000-0000-0000-0000-000000000001';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.maintenance_requests set subject = 'edited after resolve'
 where organization_id = :org_a;
reset role;
select is(
  (select subject from public.maintenance_requests where organization_id = :org_a),
  'Leaking roof tile in Hall B', 'requester UPDATE on resolved row matched 0 rows');

-- ── RLS: photos freeze on a resolved parent (even kind=requester) ───────────
set local "request.jwt.claim.sub" to '20000000-0000-0000-0000-000000000001';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  $$ insert into public.maintenance_request_attachments
       (organization_id, maintenance_request_id, storage_path, original_filename,
        safe_filename, mime_type, byte_size, uploaded_by, kind)
     select 'a0000000-0000-0000-0000-00000000001a', id,
        'a0000000-0000-0000-0000-00000000001a/' || id || '/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg',
        'p.jpg', 'p.jpg', 'image/jpeg', 100, '20000000-0000-0000-0000-000000000001', 'requester'
       from public.maintenance_requests limit 1 $$,
  '42501', null, 'photos freeze on a resolved parent');
reset role;

-- ── Archive re-buckets resolved AND cancelled (D1) ──────────────────────────
update public.maintenance_requests
   set status = 'archived', archived_at = now()
 where organization_id = :org_a;
select is(
  (select status from public.maintenance_requests where organization_id = :org_a),
  'archived', 'resolved row archives (re-bucket)');
select ok(
  (select resolved_at is not null and resolution_note is not null
     from public.maintenance_requests where organization_id = :org_a),
  'archive preserves the resolution stamps');

-- kind CHECK + default
select is(
  (select count(*)::int from information_schema.check_constraints
    where constraint_name = 'maintenance_request_attachments_kind_check'), 1,
  'kind CHECK constraint exists');
select is(
  (select column_default like '%requester%' from information_schema.columns
    where table_name = 'maintenance_request_attachments' and column_name = 'kind'),
  true, 'kind defaults to requester');

select * from finish();
rollback;
```

- [ ] **Step 2: Run to verify failure.** `supabase db reset && supabase test db` → the 0317 suite fails (missing columns).

- [ ] **Step 3: Write the migration** — `supabase/migrations/0317_maintenance_resolved.sql`, exactly this content (policy texts are the 0314 originals with ONLY the itemized additions — do not restyle):

```sql
-- 0317_maintenance_resolved.sql
--
-- Maintenance Resolved (owner decisions D1-D5, spec
-- docs/superpowers/specs/2026-08-06-maintenance-resolved-design.md).
-- Adds the fifth status 'resolved' + resolution columns + the at-most-once
-- resolution-email stamp + attachments.kind + the muteable pref column, and
-- recreates (pattern #24: drop + create, never `alter policy`) the three
-- policies whose predicates change. SELECT policies are deliberately
-- untouched (D4: history stays visible forever). No permission seeds — the
-- 0207 pgTAP count stays 119.

-- ── 1) Status CHECK: 4 → 5 values ───────────────────────────────────────────
alter table public.maintenance_requests
  drop constraint maintenance_requests_status_check;
alter table public.maintenance_requests
  add constraint maintenance_requests_status_check
  check (status in ('saved','draft_opened','resolved','archived','cancelled'));

-- ── 2) Resolution columns ───────────────────────────────────────────────────
-- resolved_by_name_snapshot: the requester_name_snapshot precedent (0314) —
-- display + email read the snapshot; no cross-profile read or embed needed.
-- resolution_email_sent_at: the 0278 return_prompt_sent_at twin (at-most-once).
alter table public.maintenance_requests
  add column if not exists resolved_at               timestamptz,
  add column if not exists resolved_by               uuid references auth.users(id) on delete set null,
  add column if not exists resolved_by_name_snapshot text
    check (resolved_by_name_snapshot is null or length(resolved_by_name_snapshot) between 1 and 200),
  add column if not exists resolution_note           text
    check (resolution_note is null or length(resolution_note) between 1 and 2000),
  add column if not exists resolution_email_sent_at  timestamptz;

comment on column public.maintenance_requests.resolved_at is
  'StockPilot-local close-out record. Never an observation of Zendesk state — StockPilot cannot see the ticket.';

-- ── 3) Attachment kind ──────────────────────────────────────────────────────
-- One column, not a second table: the 0316 (org, storage_path) uniqueness
-- must keep covering proof photos (phantom-photo cap bypass), and the share
-- page + photo proxy index into ONE shared ordered list.
alter table public.maintenance_request_attachments
  add column if not exists kind text not null default 'requester'
    check (kind in ('requester','resolution'));

-- ── 4) RLS recreates (pattern #24; EXISTS qualification per pattern #25) ────
-- 4a. maintenance_requests_update: the requester's own-row arm now also
--     requires resolved_at IS NULL (resolved is a closed state).
drop policy if exists maintenance_requests_update on public.maintenance_requests;
create policy maintenance_requests_update on public.maintenance_requests
  for update to authenticated
  using (
    (requester_user_id = (select auth.uid()) and archived_at is null and cancelled_at is null
      and resolved_at is null
      and (select public.has_org_role(organization_id, 'viewer')))
    or (select public.has_org_role(organization_id, 'manager'))
    or (select public.has_permission(organization_id, 'maintenance_requests:manage'))
  )
  with check (
    (
      (requester_user_id = (select auth.uid()) and (select public.has_org_role(organization_id, 'viewer')))
      or (select public.has_org_role(organization_id, 'manager'))
      or (select public.has_permission(organization_id, 'maintenance_requests:manage'))
    )
    and (select public.module_enabled(organization_id, 'maintenance_requests'))
  );

-- 4b. attachments INSERT: parent must also be un-resolved; only a
--     manage-holder may label a row 'resolution' (a requester inserting
--     straight through PostgREST must not be able to plant a self-supplied
--     image labeled as staff proof on the share page / email).
drop policy if exists maintenance_request_attachments_insert on public.maintenance_request_attachments;
create policy maintenance_request_attachments_insert on public.maintenance_request_attachments
  for insert to authenticated
  with check (
    uploaded_by = (select auth.uid())
    and (select public.module_enabled(organization_id, 'maintenance_requests'))
    and (
      kind = 'requester'
      or (select public.has_permission(organization_id, 'maintenance_requests:manage'))
    )
    and exists (
      select 1 from public.maintenance_requests r
       where r.id = maintenance_request_id
         and r.organization_id = maintenance_request_attachments.organization_id
         and r.archived_at is null and r.cancelled_at is null and r.resolved_at is null
         and (
           r.requester_user_id = (select auth.uid())
           or (select public.has_org_role(r.organization_id, 'manager'))
           or (select public.has_permission(r.organization_id, 'maintenance_requests:manage'))
         )
    )
  );

-- 4c. attachments DELETE: photos of a resolved request are frozen history.
drop policy if exists maintenance_request_attachments_delete on public.maintenance_request_attachments;
create policy maintenance_request_attachments_delete on public.maintenance_request_attachments
  for delete to authenticated
  using (
    exists (
      select 1 from public.maintenance_requests r
       where r.id = maintenance_request_id
         and r.organization_id = maintenance_request_attachments.organization_id
         and r.archived_at is null and r.cancelled_at is null and r.resolved_at is null
         and (
           r.requester_user_id = (select auth.uid())
           or (select public.has_org_role(r.organization_id, 'manager'))
           or (select public.has_permission(r.organization_id, 'maintenance_requests:manage'))
         )
    )
  );

-- ── 5) Muteable pref column (0265 recipe; fail-open in code) ────────────────
alter table public.notification_preferences
  add column if not exists push_maintenance_resolved boolean not null default true;
```

- [ ] **Step 4: Run to verify pass.** `supabase db reset && supabase test db` → 0317 suite `ok`, every prior suite (incl. 0314/0315/0316 and 0207 at 119) still green.

- [ ] **Step 5: Mutation self-check** (revert each, observe the named kill, restore):
  - **T1-M1** — remove `and resolved_at is null` from 4a's USING → pgTAP "requester UPDATE on resolved row matched 0 rows" fails (the subject edit lands).
  - **T1-M2** — remove the kind clause from 4b → pgTAP "requester cannot insert kind=resolution on their own OPEN request" fails (the test deliberately runs on the still-open parent, where the kind clause is the ONLY refusing predicate — see its inline comment).
  - **T1-M3** — change `r.organization_id = maintenance_request_attachments.organization_id` in 4b to `r.organization_id = r.organization_id` → self-comparison tautology; existing 0314 cross-tenant pgTAP coverage plus this file must fail. If nothing fails, ADD the missing cross-org assertion before proceeding (pattern #25 is not optional).
  - **T1-M4** — drop the status CHECK recreate (leave 4 values) → "status CHECK accepts resolved" fails with 23514.

- [ ] **Step 6: Commit.**

```bash
git add supabase/migrations/0317_maintenance_resolved.sql supabase/tests/0317_maintenance_resolved.test.sql
git commit -m "feat(maintenance): migration 0317 - resolved status, resolution columns, attachment kind, RLS"
```

---

## Task 2: Core vocabulary — status union, labels, kinds, resolve schema (+ the two Record typecheck fixes)

**Files:**
- Modify: `packages/core/src/maintenance/constants.ts`
- Modify: `packages/core/src/schemas/maintenance.ts`
- Modify: `packages/core/src/maintenance/constants.test.ts` (label pins) and the schema test suite (add resolve-schema cases; create `packages/core/src/schemas/maintenance.test.ts` if none exists — check first: the form schema's tests may live in `constants.test.ts`'s sibling; put them where the form schema's tests already are)
- Modify: `apps/web/src/components/maintenance/maintenance-status-badge.tsx` + its test (the `VARIANTS: Record<MaintenanceStatus, string>` stops typechecking without a `resolved` entry — GC 15 requires green typecheck at every commit, so the minimal entry lands HERE, richer UI in Task 7)
- Modify: `apps/mobile/app/maintenance/[id].tsx` AND `apps/mobile/app/(drawer)/maintenance.tsx` — ONLY the `STATUS_PILL: Record<MaintenanceStatus, …>` maps gain `resolved: 'ok'` (same typecheck forcing; both files carry a copy — grep `STATUS_PILL` to confirm the exact set before editing)

**Interfaces:**
- Produces (exact names, consumed by every later task):

```ts
// packages/core/src/maintenance/constants.ts
export type MaintenanceStatus = 'saved' | 'draft_opened' | 'resolved' | 'archived' | 'cancelled';
// MAINTENANCE_STATUS_LABELS gains `resolved: 'Resolved'` INSERTED BETWEEN
// draft_opened and archived — insertion order drives the web pill order and
// the REST route's STATUS_VALUES with zero changes there (spec §1.1).
export const MAINTENANCE_ATTACHMENT_KINDS = ['requester', 'resolution'] as const;
export type MaintenanceAttachmentKind = (typeof MAINTENANCE_ATTACHMENT_KINDS)[number];
export const MAINTENANCE_RESOLUTION_NOTE_MAX = 2000;

// packages/core/src/schemas/maintenance.ts
export const maintenanceResolveSchema: z.ZodType<{ note: string }, …>;  // .strict(), spec §3.1 verbatim
export type MaintenanceResolveValues = z.infer<typeof maintenanceResolveSchema>;
```

- [ ] **Step 1: Failing tests.** Core suite additions (literal pins per GC 9):

```ts
// constants.test.ts
// 1. Labels record pins ALL FIVE literals: { saved: 'Saved', draft_opened:
//    'Email draft opened', resolved: 'Resolved', archived: 'Archived',
//    cancelled: 'Cancelled' } — toEqual against the LITERAL object.
// 2. Object.keys(MAINTENANCE_STATUS_LABELS) order pinned literally:
//    ['saved','draft_opened','resolved','archived','cancelled'] — the web
//    pills and STATUS_VALUES derive from this order (spec §1.1).
// 3. MAINTENANCE_ATTACHMENT_KINDS toEqual(['requester','resolution']).
// 4. MAINTENANCE_RESOLUTION_NOTE_MAX === 2000 (literal).

// resolve-schema tests
// 5. Valid: { note: 'The issue for the leaking roof tile has been resolved.' }
//    parses; output note is the same string (owner's example, verbatim).
// 6. .strict(): { note: 'x'.repeat(10), resolverName: 'spoof' } REJECTED.
// 7. Sanitize-then-check: a note of 2001 raw chars whose control bytes
//    sanitize away to exactly 2000 is ACCEPTED (mirror of the form schema's
//    ORDERING DECISION); a clean 2001-char note is REJECTED.
// 8. Newlines PRESERVED: 'line one\n\nline two' round-trips (the note is
//    sanitizeDescriptionBlock, never sanitizeSubjectLine).
// 9. min bound: 4 meaningful chars rejected, 5 accepted (literal messages
//    pinned: 'Describe how this was resolved (at least 5 characters).' /
//    'Keep the resolution note under 2,000 characters.').
```

- [ ] **Step 2: Run to verify failure.** `pnpm --filter @stockpilot/core test -- maintenance` → FAIL.

- [ ] **Step 3: Implement.** Constants + schema exactly per spec §1.1/§3.1. Then the two platform Record fixes: badge `VARIANTS` gains `resolved: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'` (+ badge test: renders literal text `Resolved` for `status="resolved"`); both mobile `STATUS_PILL` maps gain `resolved: 'ok'`.

- [ ] **Step 4: Run to verify pass.** `pnpm --filter @stockpilot/core test && pnpm --filter web test -- maintenance-status-badge && pnpm --filter web typecheck && pnpm --filter mobile typecheck` → PASS. (Web/mobile FULL suites too — the label-derived STATUS_FILTERS pin in `page.test.tsx` may fail here; if it does, that pin update belongs to Task 7 — as an interim, verify the failure is EXACTLY the expected new-pill drift and note it in the commit message; do not weaken the pin.) If `page.test.tsx` fails on the new label set, update its literal pin NOW to the five-label list (it is a vocabulary pin, not UI work): `['Active','Saved','Email draft opened','Resolved','Archived','Cancelled']`.

- [ ] **Step 5: Mutation self-check:**
  - **T2-M1** — label `resolved: 'Ticket resolved'` → the literal label pin fails AND the (Task 4+) vocabulary sweeps would fail; the pin must fail on its own here.
  - **T2-M2** — swap schema to `sanitizeSubjectLine` → test 8 (newlines preserved) fails.
  - **T2-M3** — drop `.strict()` → test 6 fails.

- [ ] **Step 6: Commit.**

```bash
git add packages/core/src/maintenance/constants.ts packages/core/src/schemas/maintenance.ts \
        packages/core/src/maintenance/constants.test.ts packages/core/src/schemas/ \
        apps/web/src/components/maintenance/maintenance-status-badge.tsx \
        apps/web/src/components/maintenance/maintenance-status-badge.test.tsx \
        "apps/mobile/app/maintenance/[id].tsx" "apps/mobile/app/(drawer)/maintenance.tsx" \
        "apps/web/src/app/(dashboard)/dashboard/maintenance/page.test.tsx"
git commit -m "feat(maintenance): resolved status vocabulary, resolve schema, attachment kinds"
```

---

# Phase 2 — Attachment kind + share surfaces

## Task 3: Proof-photo kind end-to-end — service, routes, panel, share resolver, share page

**Files:**
- Modify: `apps/web/src/server/services/maintenance-attachments.ts` + `.test.ts`
- Modify: `apps/web/src/app/api/v1/maintenance-requests/[id]/attachments/route.ts` + `finalize/route.ts` (+ their tests)
- Modify: `apps/web/src/components/maintenance/maintenance-photos-panel.tsx` + `.test.tsx`
- Modify: `apps/web/src/server/services/maintenance-share-links.ts` + `.test.ts`
- Modify: `apps/web/src/app/m/[token]/page.tsx` + `page.test.tsx` (photo proxy route needs no change beyond the resolver's passthrough — verify with its existing tests)

**Interfaces:**
- Consumes: `MaintenanceAttachmentKind` / `MAINTENANCE_ATTACHMENT_KINDS` (Task 2); `kind` column (Task 1).
- Produces:

```ts
// maintenance-attachments.ts
createUploadUrl(requestId, args: { fileExt: string; originalFilename: string; kind?: MaintenanceAttachmentKind })
finalize(requestId, args: { path: string; originalFilename: string; declaredMime: string; kind?: MaintenanceAttachmentKind })
export interface SignedMaintenancePhoto { …existing fields…; kind: MaintenanceAttachmentKind }

// maintenance-share-links.ts
export interface ResolvedMaintenanceShare {
  …existing…;
  photos: { filename: string; kind: MaintenanceAttachmentKind }[];
  resolution: { note: string; resolvedAtDisplay: string } | null;  // NO resolver name (spec §4.2)
}
```

- [ ] **Step 1: Failing tests** (each a real `it()`; supabase-mock `chains`/`chainArgs` pins per GC 8):

```ts
// maintenance-attachments.test.ts additions
// 1. mint default: no kind supplied → cap count query carries .eq('kind','requester')
//    (chainArgs pin) and the insert path is unchanged.
// 2. mint kind='resolution' WITHOUT manage → ServiceError 'forbidden'; WITH
//    manage → allowed; cap count query pinned to .eq('kind','resolution').
// 3. finalize records kind on the INSERT payload (chainArgs pin on the insert
//    object: kind: 'resolution'); finalize kind='resolution' without manage → forbidden
//    BEFORE any storage download (chains prove no storage call happened).
// 4. per-kind caps: 8 canned 'requester' rows do NOT block a 'resolution'
//    mint (the count replay is canned — the assertion is the .eq('kind', …)
//    pin plus the JS branch; state it honestly in the test name).
// 5. assertParentOwnedAndOpen: a parent row with resolved_at set → conflict
//    'This request is closed; photos can no longer change.' (literal).
// 6. signedViewUrls maps kind through (canned rows carry kind; result pinned).
// 7. invalid kind literal ('proof') → validation_error, LITERAL-pinned
//    against the string 'requester'/'resolution' allow-list.

// route tests: mint/finalize schemas accept optional kind enum, forward it;
//    unknown kind → 400. Literal pin: body { kind: 'resolution' } reaches the
//    service argument.

// maintenance-share-links.test.ts additions
// 8. photos entries carry kind; ordering is sort_order asc then created_at
//    asc (chainArgs pins BOTH .order calls — the tiebreaker is new).
// 9. resolution block: canned request row with resolved_at + resolution_note
//    → { note, resolvedAtDisplay } present; unresolved → null. The note is
//    passed VERBATIM (no truncation — literal round-trip pin).
// 10. resolver name NEVER in the projection: assert the resolved object has
//    no key/value containing the canned resolved_by_name_snapshot.

// m/[token]/page.test.tsx additions
// 11. two labeled sections render: 'Photos' (requester entries) and
//    'Resolution proof' (resolution entries); each <img> src is STILL the
//    combined-list index `/m/<token>/photo/<i>` (literal-pinned for a mixed
//    fixture: requester at 0, resolution at 1).
// 12. resolved fixture renders 'Marked resolved' + the note verbatim; the
//    §11 forbidden sweep runs over document.body for this page state
//    (incl. 'Ticket closed', 'Zendesk ticket closed').
```

- [ ] **Step 2: Run to verify failure.** `pnpm --filter web test -- maintenance-attachments maintenance-share-links "m/"` → FAIL.

- [ ] **Step 3: Implement.**
  - `maintenance-attachments.ts`: `kind` param (default `'requester'`, validate against `MAINTENANCE_ATTACHMENT_KINDS`, `forbidden` for `resolution` without `can(ctx,'maintenance_requests:manage')` — checked immediately after `assertParentOwnedAndOpen`, before rate-limit/storage); `.eq('kind', kind)` on BOTH cap counts; `kind` in the finalize insert payload; `assertParentOwnedAndOpen` selects + checks `resolved_at`; `signedViewUrls` selects `kind` and maps it through.
  - Routes: `mintSchema`/`finalizeSchema` gain `kind: z.enum(MAINTENANCE_ATTACHMENT_KINDS).optional()`, forwarded verbatim.
  - Photos panel: new prop `kind?: 'requester' | 'resolution'` (default `'requester'`) included in BOTH fetch bodies (mint + finalize). No visual change here.
  - `maintenance-share-links.ts`: `AttachmentRow` + select gain `kind`; `fetchValidAttachments` adds `.order('created_at', { ascending: true })` after the existing sort_order order (the deterministic tiebreaker, spec §12.1 — both public functions share the ONE fetch, so page/proxy indices cannot drift); `resolveMaintenanceShareToken`'s request select adds `resolved_at, resolution_note`; projection gains `photos[].kind` + `resolution` (formatted date via the page's existing `formatSubmittedDate`-style helper — keep formatting IN the page, pass the ISO string as `resolvedAtDisplay` pre-formatted with `toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })` to match the Submitted line).
  - Share page: split render into the two labeled sections (indices computed against the combined list — `shared.photos.map((p, i) => …)` with a kind filter per section, PRESERVING `i` from the combined array); resolution block under the description: heading `Resolution`, line `Marked resolved · {resolvedAtDisplay}`, note in `whitespace-pre-line`. Footer disclosure unchanged.

- [ ] **Step 4: Run to verify pass.** `pnpm --filter web test -- maintenance && pnpm --filter web typecheck` → PASS (the `[n]` photo proxy suite must pass UNMODIFIED — it rides the shared fetch).

- [ ] **Step 5: Mutation self-check:**
  - **T3-M1** — remove the manage gate on `kind='resolution'` in the service → test 2/3 fail.
  - **T3-M2** — drop `.eq('kind', kind)` from the finalize cap count → test 3's chainArgs pin fails.
  - **T3-M3** — render section indices from the FILTERED arrays (`requesterPhotos.map((p, i)`) instead of combined-list indices → test 11's literal `/photo/1` pin fails.
  - **T3-M4** — leak `resolved_by_name_snapshot` into the projection → test 10 fails.

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/server/services/maintenance-attachments.ts apps/web/src/server/services/maintenance-attachments.test.ts \
        "apps/web/src/app/api/v1/maintenance-requests/[id]/attachments" \
        apps/web/src/components/maintenance/maintenance-photos-panel.tsx apps/web/src/components/maintenance/maintenance-photos-panel.test.tsx \
        apps/web/src/server/services/maintenance-share-links.ts apps/web/src/server/services/maintenance-share-links.test.ts \
        "apps/web/src/app/m/[token]"
git commit -m "feat(maintenance): resolution-proof attachment kind across upload, share page, and proxy"
```

---

# Phase 3 — The resolve service + notifications

## Task 4: `resolve()` + guard changes + notify event + pref + action + cron hedge

**Files:**
- Modify: `apps/web/src/server/services/maintenance-requests.ts` + `.test.ts`
- Modify: `apps/web/src/server/services/audit.ts` (union member `'maintenance_request.resolved'`)
- Modify: `apps/web/src/server/services/maintenance-notify.ts` + `.test.ts`
- Modify: `apps/web/src/lib/notification-prefs.ts`
- Modify: `apps/web/src/components/settings/notification-preferences-form.tsx` (+ its test)
- Modify: `apps/web/src/app/api/cron/maintenance-draft-reminders/route.ts` (+ its test)
- Modify: `apps/web/src/server/actions/maintenance-requests.ts` (+ its test)

**Interfaces:**
- Consumes: `maintenanceResolveSchema` (T2); columns (T1); `notifyMaintenanceEvent` shape (shipped); `MaintenanceShareLinksService.ensureActiveLink` (shipped); `maybeSendMaintenanceResolvedEmail` (T6 — this task wires a STUB SEAM: `resolve()` calls a module-level function imported from `@/server/email/maintenance-resolved`; until T6 lands, create that module NOW with the full result-type signature and a body that only returns `{ sent: false, reason: 'error' }` after a `reportError` no-op — the import graph and tests stay stable and T6 replaces the body).
- Produces:

```ts
// maintenance-requests.ts
async resolve(id: string, input: unknown): Promise<void>
export interface MaintenanceRequestDetail { …; resolvedAt: string | null; resolvedByName: string | null; resolutionNote: string | null }

// maintenance-notify.ts
export type MaintenanceNotifyEvent = 'new_request' | 'urgent_request' | 'assigned' | 'draft_reminder' | 'photo_rejected' | 'resolved';
// EVENT_PREF_KEY gains resolved: 'push_maintenance_resolved' (LITERAL string)
// titleFor gains: `Maintenance request ${requestHandle} marked resolved`
```

- [ ] **Step 1: Failing tests** (real `it()` bodies; the service suite's existing fixture conventions):

```ts
// maintenance-requests.test.ts additions
// 1. resolve happy path: manage ctx; parse ok; ONE update carrying EXACTLY
//    { status:'resolved', resolved_at, resolved_by, resolved_by_name_snapshot,
//      resolution_note, updated_at } (chainArgs pin on the update object's
//    keys) with .is('resolved_at',null).is('archived_at',null)
//    .is('cancelled_at',null) pinned; audit event 'maintenance_request.resolved'
//    with extra { has_note: true, proof_photo_count } and NEVER the note text
//    (assert JSON.stringify(auditCall) does not contain the note literal).
// 2. resolve without manage → forbidden. Module off → module_disabled.
// 3. resolve on archived/cancelled/already-resolved (three cases) → conflict,
//    per-cause message literals pinned.
// 4. zero-row guarded update → conflict (C2 fail-closed), audit NOT written.
// 5. notify emit: event 'resolved', targetUserId = requester; SUPPRESSED when
//    requester === actor and when requester_user_id is null.
// 6. email hook: maybeSendMaintenanceResolvedEmail called ONCE with the
//    request id AFTER the update+audit (call-order assertion); its rejection
//    does not reject resolve() (fire-and-forget .catch).
// 7. ensureActiveLink called only when photoCount > 0 AND the org setting
//    allows; a ServiceError from it degrades silently (resolve still succeeds).
// 8. archive() now ACCEPTS a cancelled row and a resolved row (D1); the
//    update object contains NO resolved_*/cancelled_at keys (GC 12 pin);
//    archive on archived → conflict.
// 9. cancel() on resolved → conflict 'This request is resolved and can no
//    longer be cancelled.' (literal).
// 10. update()/recordDraftOpened(): requester on OWN resolved row → conflict
//    (closed guard widened); manage still bypasses for update().
// 11. get() maps resolvedAt/resolvedByName/resolutionNote from the row.

// maintenance-notify.test.ts additions
// 12. EVENT_PREF_KEY.resolved === 'push_maintenance_resolved' (LITERAL).
// 13. resolved is a TARGETED event: pref-gated fail-open (missing row
//    notifies; explicit false mutes); createNotification once, link
//    literal-pinned '/dashboard/maintenance/<id>'.
// 14. title literal: 'Maintenance request MR-2026-000123 marked resolved';
//    forbidden sweep over the title ('Ticket closed', 'Ticket resolved',
//    'Zendesk' never appear in ANY titleFor output).

// notification-prefs / TOGGLE_DEFS
// 15. NOTIFICATION_PREF_KEYS contains literal 'push_maintenance_resolved';
//    TOGGLE_DEFS has a push-group entry with label literal
//    'Maintenance request resolved'.

// cron test addition
// 16. the reminders query chain now includes .is('resolved_at', null)
//    (chainArgs pin), alongside the existing saved/archived/cancelled pins.

// actions test addition
// 17. resolveMaintenanceRequestAction: uuid-validates id; calls
//    service.resolve(id, values); revalidates BOTH list and detail paths;
//    ServiceError → { error: { message } }.
```

- [ ] **Step 2: Run to verify failure.** `pnpm --filter web test -- maintenance-requests maintenance-notify notification maintenance-draft-reminders` → FAIL.

- [ ] **Step 3: Implement `resolve()`** (complete method — mirrors `archive()`'s discipline; place after `cancel()`):

```ts
  /** manage-only close-out (owner decision D1/D2). Records a StockPilot-local
   *  resolution: status + resolved_at + resolved_by + name snapshot + the
   *  note, in ONE guarded write. Proof photos are uploaded by the dialog
   *  BEFORE this call (kind='resolution', request still open) — this method
   *  never touches Storage. Requester notification (both channels) fires
   *  fire-and-forget AFTER the audit write; the email is at-most-once via
   *  resolution_email_sent_at (server/email/maintenance-resolved.ts). */
  async resolve(id: string, input: unknown): Promise<void> {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    assertPermission(this.ctx, 'maintenance_requests:manage');

    const parsed = maintenanceResolveSchema.safeParse(input);
    if (!parsed.success) {
      throw new ServiceError('validation_error', parsed.error.issues[0]?.message ?? 'Please check the resolution note.');
    }
    const note = parsed.data.note;

    const { data: header, error: hErr } = await this.db
      .from('maintenance_requests')
      .select('archived_at, cancelled_at, resolved_at, requester_user_id, request_number, created_at, subject')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (hErr) throw new ServiceError('internal_error', hErr.message);
    if (!header) throw new ServiceError('not_found', 'Maintenance request not found.');
    const h = header as {
      archived_at: string | null; cancelled_at: string | null; resolved_at: string | null;
      requester_user_id: string | null; request_number: number | null; created_at: string | null;
      subject: string | null;
    };
    if (h.archived_at) throw new ServiceError('conflict', 'This request is archived and can no longer be resolved.');
    if (h.cancelled_at) throw new ServiceError('conflict', 'This request is cancelled and can no longer be resolved.');
    if (h.resolved_at) throw new ServiceError('conflict', 'This request is already resolved.');

    // Resolver display-name snapshot — the create() identity-snapshot pattern:
    // the authenticated profile, never client input.
    const { data: profile } = await this.db
      .from('user_profiles').select('full_name, email').eq('id', this.ctx.userId).maybeSingle();
    const resolverName =
      ((profile?.full_name as string | null | undefined)?.trim() ||
        (profile?.email as string | null | undefined) || 'Unknown').slice(0, 200);

    const { count: proofCount } = await this.db
      .from('maintenance_request_attachments')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', this.ctx.organizationId)
      .eq('maintenance_request_id', id)
      .eq('kind', 'resolution');

    const now = new Date().toISOString();
    const { data, error } = await this.db
      .from('maintenance_requests')
      .update({
        status: 'resolved',
        resolved_at: now,
        resolved_by: this.ctx.userId,
        resolved_by_name_snapshot: resolverName,
        resolution_note: note,
        updated_at: now,
      })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .is('resolved_at', null)
      .is('archived_at', null)
      .is('cancelled_at', null)
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) {
      throw new ServiceError('conflict', 'This request changed state and can no longer be resolved this way. Reload and try again.');
    }

    await audit(
      {
        event: 'maintenance_request.resolved',
        entityType: 'maintenance_request',
        entityId: id,
        // NEVER the note text (GC 16 / GC 27 posture).
        extra: { has_note: true, proof_photo_count: proofCount ?? 0 },
      },
      this.ctx,
    );

    const handle =
      formatMaintenanceRequestNumber(h.request_number, h.created_at) ?? `MR-${id.slice(0, 8)}`;

    // Channel (a): in-app/push — suppressed for self-resolve, pref-gated
    // fail-open inside notifyMaintenanceEvent.
    if (h.requester_user_id && h.requester_user_id !== this.ctx.userId) {
      this.emitNotify({
        organizationId: this.ctx.organizationId,
        event: 'resolved',
        requestId: id,
        requestHandle: handle,
        subject: h.subject ?? '',
        actorUserId: this.ctx.userId,
        targetUserId: h.requester_user_id,
      });
    }

    // Share link for the email's proof-photo proxy URLs — same conditions as
    // the detail page (photos of ANY kind + org setting), manage always
    // eligible; ServiceError degrades to "no link" (the email falls back to
    // its in-app line).
    try {
      const { count: anyPhotos } = await this.db
        .from('maintenance_request_attachments')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', this.ctx.organizationId)
        .eq('maintenance_request_id', id);
      if ((anyPhotos ?? 0) > 0 && (await maintenanceShareLinksEnabled(this.ctx))) {
        await new MaintenanceShareLinksService(this.ctx).ensureActiveLink(id);
      }
    } catch (e) {
      if (!(e instanceof ServiceError)) throw e;
    }

    // Channel (b): the at-most-once email. Fire-and-forget; the stamp column
    // makes replays safe regardless of what happens to this promise.
    void maybeSendMaintenanceResolvedEmail(createAdminClient(), id, { appUrl: APP_URL }).catch((err) => {
      void reportError(err instanceof Error ? err : new Error(String(err)), {
        tag: 'maintenance_resolved.email',
        extra: { requestId: id },
      });
    });
  }
```

  Notes for the implementer: `maintenanceShareLinksEnabled(ctx)` is the `includeShareLinksInEmail !== false` read — the detail page and `[id]/route.ts` each carry a private copy today; add a THIRD private copy here or (better) lift ONE shared helper into `maintenance-share-links.ts` and point all three at it (small refactor, keep the two call sites' tests green unmodified). Adjacent changes: `archive()` drops its cancelled-refusal pre-read branch (now refuses only `archived_at`), `cancel()` adds the resolved conflict, `update()`/`recordDraftOpened()` closed guards add `detail.resolvedAt`, `get()` maps the three new fields, `attachments` import of `MaintenanceShareLinksService`/`createAdminClient` already exists in the file's sibling services — check imports. `maintenance-notify.ts` per the Interfaces block. `TOGGLE_DEFS` entry: `{ key: 'push_maintenance_resolved', label: 'Maintenance request resolved', hint: 'In-app notification when a maintenance request you submitted is marked resolved.', group: 'push' }`. Cron: add `.is('resolved_at', null)` after the existing `.is('cancelled_at', null)`. Action: clone `archiveMaintenanceRequestAction` with the values pass-through.

- [ ] **Step 4: Run to verify pass.** `pnpm --filter web test -- maintenance notification && pnpm --filter web typecheck` → PASS.

- [ ] **Step 5: Mutation self-check:**
  - **T4-M1** — drop `.is('archived_at', null)` from the guarded update → test 1's chainArgs pin fails.
  - **T4-M2** — include `resolution_note` in the audit extra → test 1's negative pin fails.
  - **T4-M3** — notify unconditionally (remove the self-resolve suppression) → test 5 fails.
  - **T4-M4** — `archive()` update object gains `resolved_at: null` (a "cleanup" a future hand might add) → test 8's GC-12 pin fails.
  - **T4-M5** — titleFor resolved → `'Maintenance request ${h} resolved by the team'` → test 14's literal pin fails.

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/server/services/maintenance-requests.ts apps/web/src/server/services/maintenance-requests.test.ts \
        apps/web/src/server/services/audit.ts apps/web/src/server/services/maintenance-notify.ts \
        apps/web/src/server/services/maintenance-notify.test.ts apps/web/src/lib/notification-prefs.ts \
        apps/web/src/components/settings/notification-preferences-form.tsx \
        apps/web/src/app/api/cron/maintenance-draft-reminders apps/web/src/server/actions/maintenance-requests.ts \
        apps/web/src/server/email/maintenance-resolved.ts
git commit -m "feat(maintenance): resolve() close-out with guarded write, notify event, muteable pref"
```

(Include the T6 seam stub file `server/email/maintenance-resolved.ts` in this commit with the signature + inert body + a `TODO(T6)` comment.)

---

# Phase 4 — The resolution email

## Task 5: es registry row + the `maintenance` family renderer + honesty line

**Files:**
- Modify: `apps/web/src/lib/email/es/registry.ts` (family union + one row) and `registry.test.ts` (29 → 30 + EXPECTED entry — the 0207-count analog; update the count assertions at registry.test.ts:306-308 and the family/status tallies, with a provenance comment naming this program)
- Create: `apps/web/src/lib/email/es/families/maintenance.ts`
- Create: `apps/web/src/lib/email/es/families/maintenance.test.ts`

**Interfaces:**
- Consumes: the shared component layer (`brandStrip`/`statusPill`/`headline`/`bodyText`/`detailRows`/`verbatimMessage`/`eyebrow`/`section`/`ctaRow`/`footer`/`emailShell`/`escapeHtml`/`assertEmailWeight` — `families/support.ts` is the structural template); `esEmailById`; motion asset `'check'`; archetype rules (dark-block byte-fidelity, no ink classes on tonal fills — reuse the components verbatim, never hand-roll markup).
- Produces:

```ts
export const MAINTENANCE_RESOLVED_FROM: string; // 'StockPilot <maintenance@stockpilotusa.com>' via the registry row
export const MAINTENANCE_RESOLVED_HONESTY_LINE =
  'This resolution was recorded by your team in StockPilot. It does not close or update the Zendesk ticket — replies and ticket status stay in the Outlook/Zendesk email conversation.';
export interface MaintenanceResolvedEmailParams {
  requestHandle: string;            // 'MR-2026-000123'
  requestSubject: string;
  recipientFirstName?: string | null;
  recipientEmail: string;           // footer reason only
  resolverName: string;
  resolutionNote: string;           // rendered VERBATIM (escaped, \n → <br>)
  resolvedOnDisplay: string;        // pre-formatted org-tz datetime
  proofPhotos: { src: string; alt: string }[]; // ABSOLUTE /m/ proxy URLs; may be []
  proofPhotoTotal: number;          // total kind='resolution' count (for the +N line / fallback line)
  requestUrl: string;               // `${appUrl}/dashboard/maintenance/${id}`
}
export function renderMaintenanceResolvedEmail(params: MaintenanceResolvedEmailParams): { subject: string; html: string; text: string };
```

- [ ] **Step 1: Failing tests:**

```ts
// registry.test.ts — bump 29 → 30 in all three count assertions + add the
// EXPECTED row (subject sample: 'Maintenance request MR-2026-000123 marked
// resolved'); family tally gains maintenance: 1; status tally live +1.

// families/maintenance.test.ts
// 1. subject literal: 'Maintenance request MR-2026-000123 marked resolved'.
// 2. HONESTY LINE literal-pinned in BOTH html and text outputs (the full
//    two-sentence string, byte-exact).
// 3. note VERBATIM: fixture note with an apostrophe + two lines → escaped
//    html contains line1<br> and the text output contains the raw note.
// 4. resolver line: 'Marked resolved by Dana Keeler' (fixture literal).
// 5. proof imgs: 2 fixtures → exactly 2 <img whose src are the literal
//    fixture URLs 'https://app.example.com/m/abc…/photo/1' etc; 6 fixtures
//    with proofPhotoTotal 6 → 4 <img> + a '+2 more photos on the request'
//    line; [] with proofPhotoTotal 0 → no <img>, no fallback line; [] with
//    proofPhotoTotal 3 → the literal fallback '3 proof photos are on the
//    request in StockPilot.'
// 6. NEGATIVE: html contains NO 'supabase.co', NO '/storage/v1/', NO
//    'token=' substring (signed-URL leak guard).
// 7. cta href literal-pinned to params.requestUrl; from
//    'StockPilot <maintenance@stockpilotusa.com>' literal-pinned via the
//    registry row AND re-pinned as a string literal here (GC 9).
// 8. forbidden sweep over subject+html+text: the GC-4 list incl. 'Ticket
//    closed', 'Zendesk ticket closed', 'Ticket resolved' (the sweep array is
//    the only place the phrases appear).
// 9. assertEmailWeight does not throw for the maximal fixture (2000-char
//    note + 4 imgs).
```

- [ ] **Step 2: Run to verify failure.** `pnpm --filter web test -- es/families/maintenance es/registry` → FAIL.

- [ ] **Step 3: Implement.** Registry row per spec §6.1 (family `'maintenance'` added to `EsEmailFamily`; row fields verbatim from the spec table; `motionAsset: 'check'`; `category: 'ess'`, `footer: 'ess'`). Renderer structure (support-resolved as the skeleton): brandStrip(tag 'Maintenance') → section with statusPill(ok, 'Marked resolved') + headline(lead `Marked resolved.`, turn = requestSubject escaped) + bodyText(`${greeting} ${escapeHtml('Marked resolved by ')}…` — compose: greeting, then `<strong>` resolver name, on the pattern of support.ts's bodyText usage) → eyebrow 'Resolution note — verbatim' + verbatimMessage(escaped note with `<br>`) → the honesty line as its own bodyText paragraph → proof-photo block (a simple table of `<img src width="120" style="…border-radius:8px">` cells, 2 per row, max 4, from the components' existing img conventions; the +N / fallback lines as bodyText) → detailRows(Request / Resolved / Recorded by) → ctaRow(primary 'View request') → footer(kind 'ess', reason = honesty-line first sentence + ' Sent once when a request you submitted is marked resolved.', urls.support → requestUrl). `text` output: plain-text mirror (subject, resolver line, note verbatim, honesty line, proof fallback line, request URL). `assertEmailWeight(html)` before return.

- [ ] **Step 4: Run to verify pass.** `pnpm --filter web test -- es && pnpm --filter web typecheck` → PASS (every other family suite green unmodified).

- [ ] **Step 5: Mutation self-check:**
  - **T5-M1** — reword the honesty line ('does not close the ticket') → test 2's byte-exact pin fails in html AND text.
  - **T5-M2** — truncate the note at 500 chars → test 3 (2000-char fixture round-trip in text) fails.
  - **T5-M3** — swap a proof src to a signed-URL-shaped fixture → test 6's negative pins fail.
  - **T5-M4** — subject → 'Resolved: {subject}' → tests 1 and the registry EXPECTED pin fail.

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/lib/email/es/registry.ts apps/web/src/lib/email/es/registry.test.ts \
        apps/web/src/lib/email/es/families/maintenance.ts apps/web/src/lib/email/es/families/maintenance.test.ts
git commit -m "feat(maintenance): maintenance-resolved email template with verbatim note and honesty line"
```

---

## Task 6: The at-most-once sender + wiring into resolve()

**Files:**
- Modify: `apps/web/src/server/email/maintenance-resolved.ts` (replace the T4 stub body)
- Create: `apps/web/src/server/email/maintenance-resolved.test.ts`

**Interfaces:**
- Consumes: `renderMaintenanceResolvedEmail` / `MAINTENANCE_RESOLVED_FROM` (T5); `sendEmail` (`@/lib/email/resend` — the ONE seam, GC 2); `formatMaintenanceRequestNumber`; `formatOrgDateTime`/`ORG_TIMEZONE_DEFAULT` (the emailInput() timezone convention); the share tables (active link token + `kind='resolution'` attachments, admin reads).
- Produces (already declared by the T4 stub):

```ts
export type MaintenanceResolvedEmailResult =
  | { sent: true }
  | { sent: false; reason: 'request_not_found' | 'not_resolved' | 'no_requester_email' | 'self_resolve'
      | 'already_sent' | 'lost_race' | 'send_failed' | 'error' };
export async function maybeSendMaintenanceResolvedEmail(
  admin: SupabaseClient, requestId: string, opts: { appUrl: string },
): Promise<MaintenanceResolvedEmailResult>;
```

- [ ] **Step 1: Failing tests** (Resend seam stubbed per GC 1 — `vi.hoisted` + `vi.mock('@/lib/email/resend')`; supabase stub via `makeSupabaseStub`):

```ts
// 1. Happy path: resolved row + requester email + null stamp → the GUARDED
//    CLAIM (.update({resolution_email_sent_at}).is('resolution_email_sent_at',
//    null)) is recorded BEFORE sendEmailMock is called (call-order pin);
//    sendEmail receives { to: requester email, from: literal
//    'StockPilot <maintenance@stockpilotusa.com>', subject containing literal
//    'marked resolved' } → { sent: true }.
// 2. Guard skips, each literal-pinned by reason: missing row
//    ('request_not_found'), status 'saved' ('not_resolved'), null
//    requester_email_snapshot ('no_requester_email'), resolved_by ===
//    requester_user_id ('self_resolve'), stamp already set ('already_sent'),
//    guarded update returns null ('lost_race'). sendEmail NEVER called in any
//    of these (spy count 0).
// 3. send throws → { sent: false, reason: 'send_failed' }, reportError
//    called, and NO second update clearing the stamp (chains prove exactly
//    one maintenance_requests.update) — marker stays set.
// 4. Proof photos: canned active share link + 3 kind='resolution' rows among
//    5 total → proofPhotos srcs are `${appUrl}/m/<token>/photo/<i>` for the
//    COMBINED-list indices of the resolution rows (literal pin with a mixed
//    fixture; the ordering contract is fetchValidAttachments's — the sender
//    must reuse the shared helper, not re-implement ordering).
// 5. No active link (or org setting off) → proofPhotos [] with
//    proofPhotoTotal 3 (the renderer's fallback line takes over); sendEmail
//    still called (photos are not a send precondition).
// 6. Whole function never rejects: a throwing admin read resolves
//    { sent: false, reason: 'error' }.
```

- [ ] **Step 2: Run to verify failure.** `pnpm --filter web test -- maintenance-resolved` → FAIL.

- [ ] **Step 3: Implement.** `return-prompt.ts` is the module template — mirror its structure, guard order, and comments discipline: single admin read of the request row (`id, organization_id, status, resolved_at, resolved_by, resolved_by_name_snapshot, resolution_note, requester_user_id, requester_email_snapshot, requester_name_snapshot, request_number, created_at, subject, resolution_email_sent_at`); guards per test 2 in that order; **the guarded claim BEFORE any rendering/photo assembly**; then assemble: org timezone read → `resolvedOnDisplay` via `formatOrgDateTime`; share photos via a NEW exported helper on `maintenance-share-links.ts` — `listResolutionProofProxyPhotos(admin, organizationId, requestId): Promise<{ token: string; entries: { index: number; filename: string }[] } | null>` (reads the active unexpired link row + the shared `fetchValidAttachments`, returns combined-list indices of `kind='resolution'` rows; null when no usable link) — plus the org-setting read (`includeShareLinksInEmail !== false`); cap embedded photos at 4; `renderMaintenanceResolvedEmail(…)`; `sendEmail({ to, subject, html, text, from: MAINTENANCE_RESOLVED_FROM })`; failure → `send_failed` with the marker left set. Replace the T4 stub body; keep the exported signature byte-identical.

- [ ] **Step 4: Run to verify pass.** `pnpm --filter web test -- maintenance-resolved maintenance-requests && pnpm --filter web typecheck` → PASS (the T4 test 6 call-wiring now exercises the real module's import).

- [ ] **Step 5: Mutation self-check:**
  - **T6-M1** — move the guarded claim AFTER `sendEmail` → test 1's call-order pin fails.
  - **T6-M2** — clear the stamp on send failure → test 3's single-update chains pin fails.
  - **T6-M3** — drop the self_resolve guard → test 2's spy-count-0 fails for that case.
  - **T6-M4** — build proof URLs from a locally re-implemented ordering (filtered-list indices) → test 4's combined-index literal pin fails.

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/server/email/maintenance-resolved.ts apps/web/src/server/email/maintenance-resolved.test.ts \
        apps/web/src/server/services/maintenance-share-links.ts apps/web/src/server/services/maintenance-share-links.test.ts
git commit -m "feat(maintenance): at-most-once resolution email through the Resend seam"
```

---

# Phase 5 — Web UI

## Task 7: Resolve dialog, detail page resolution surfaces, list pin

**Files:**
- Create: `apps/web/src/components/maintenance/resolve-request-dialog.tsx` + `.test.tsx`
- Modify: `apps/web/src/app/(dashboard)/dashboard/maintenance/[id]/detail-client.tsx` + `detail-client.test.tsx`
- Modify: `apps/web/src/app/(dashboard)/dashboard/maintenance/[id]/page.tsx` + `page.test.tsx`
- Modify: `apps/web/src/app/(dashboard)/dashboard/maintenance/page.test.tsx` (five-label pill pin, if not already updated in T2 Step 4)

**Interfaces:**
- Consumes: `resolveMaintenanceRequestAction` (T4); `MaintenancePhotosPanel` `kind` prop (T3); `SignedMaintenancePhoto.kind` (T3); detail fields (T4).
- Produces: `ResolveRequestDialog({ requestId, requesterName, open, onOpenChange, onResolved })`; `MaintenanceRequestActions` props gain `showResolve: boolean` and `requesterName: string`.

- [ ] **Step 1: Failing tests:**

```ts
// resolve-request-dialog.test.tsx
// 1. Confirm disabled until the note is non-empty; typing enables it.
// 2. Confirm calls resolveMaintenanceRequestAction(requestId, { note }) —
//    argument object pinned; success → onResolved fired + toast.
// 3. ServiceError result → toast.error with the server message; dialog stays
//    open; no onResolved.
// 4. Dialog copy pins (document.body — Radix portals): the literal
//    disclosure 'It does not close or update the Zendesk ticket.' and the
//    proof-photo caption; §GC-4 forbidden sweep across closed/open/
//    submitting/error states.
// 5. The photos panel inside receives kind="resolution" (prop pin via mock).

// detail-client.test.tsx additions
// 6. showResolve renders the Resolve button; click opens the dialog;
//    showResolve false → absent.
// 7. Archive confirm copy updated: literal 'Use this to tidy up old resolved
//    or cancelled requests, or duplicates.' (replaces the stale sentence —
//    pin the OLD sentence as ABSENT).

// page.test.tsx ([id]) additions
// 8. Resolved fixture: Resolution card renders note verbatim +
//    'Marked resolved by Dana Keeler'; timeline row 'Marked resolved';
//    'Resolution proof' section lists kind='resolution' photos only;
//    requester 'Photos' card excludes them (counts pinned).
// 9. Gating fixture matrix: resolved+manage → Archive visible, Resolve
//    absent, Cancel absent; open+manage → Resolve+Archive+no Cancel (unless
//    owner); open+owning-requester (no manage) → Cancel only; cancelled+
//    manage → Archive visible (D1 re-bucket), Resolve absent.
// 10. §GC-4 sweep over the full resolved-state page body.
```

- [ ] **Step 2: Run to verify failure.** `pnpm --filter web test -- resolve-request-dialog detail-client "maintenance/\[id\]"` → FAIL.

- [ ] **Step 3: Implement.**
  - Dialog: Radix Dialog (house `DialogContent` + className width override per GC idiom), `Textarea` bound to local state (maxLength hint `MAINTENANCE_RESOLUTION_NOTE_MAX`), `MaintenancePhotosPanel kind="resolution" requestId={requestId} photos={…}` (panel loads/uploads immediately — pre-flip staging per spec §12.5, with the removable-rows disclosure sentence), disclosure copy: `Marks this request resolved in StockPilot and emails ${requesterName} the note and any proof photos. It does not close or update the Zendesk ticket.` Confirm → action → toast/`onResolved`.
  - `detail-client.tsx`: `showResolve` prop + button (variant default, before Archive) + dialog state; archive `DestructiveConfirm` description updated per test 7.
  - `[id]/page.tsx`: `closed` becomes `Boolean(detail.archivedAt || detail.cancelledAt || detail.resolvedAt)`; actions props `showResolve={canManage && !closed}`, `showArchive={canManage && !detail.archivedAt}`, `showCancel={isOwningRequester && !closed}`, `requesterName={detail.requesterName}`; photos split by `kind` (requester card + read-only "Resolution proof (N)" card with the caption `Added by the team when this request was marked resolved.`); Resolution card (note `whitespace-pre-wrap`, `Marked resolved by {resolvedByName} · {formatRelative(resolvedAt)}`); timeline `Marked resolved` row off `resolvedAt` (before the archived row).

- [ ] **Step 4: Run to verify pass.** `pnpm --filter web test -- maintenance && pnpm --filter web typecheck && pnpm --filter web build` → PASS (build proves the RSC boundary carries only serializable props — the 2026-08-05 walk's BUG-1 class; `requesterName` and the booleans are strings/bools, never closures).

- [ ] **Step 5: Mutation self-check:**
  - **T7-M1** — `showArchive={canManage && !closed}` (the old gate) → test 9's resolved+manage row fails (Archive must stay for the D1 tidy-up).
  - **T7-M2** — render proof photos inside the requester card → test 8's counts fail.
  - **T7-M3** — dialog confirm enabled with empty note → test 1 fails.
  - **T7-M4** — plant 'Ticket closed in Zendesk.' in the dialog success toast → test 4's body sweep fails.

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/components/maintenance/resolve-request-dialog.tsx apps/web/src/components/maintenance/resolve-request-dialog.test.tsx \
        "apps/web/src/app/(dashboard)/dashboard/maintenance/[id]" "apps/web/src/app/(dashboard)/dashboard/maintenance/page.test.tsx"
git commit -m "feat(maintenance): resolve dialog, resolution card, proof section, re-bucket archive gating"
```

---

# Phase 6 — Mobile parity routes

## Task 8: Bearer routes — resolve, archive, assign-owner, notes, members (+ detail fields)

**Files:**
- Create: `apps/web/src/app/api/v1/maintenance-requests/[id]/resolve/route.ts` + `.test.ts`
- Create: `apps/web/src/app/api/v1/maintenance-requests/[id]/archive/route.ts` + `.test.ts`
- Create: `apps/web/src/app/api/v1/maintenance-requests/[id]/assign-owner/route.ts` + `.test.ts`
- Create: `apps/web/src/app/api/v1/maintenance-requests/[id]/notes/route.ts` + `.test.ts`
- Create: `apps/web/src/app/api/v1/maintenance-requests/members/route.ts` + `.test.ts`
- Modify: `apps/web/src/app/api/v1/maintenance-requests/[id]/route.ts` + `.test.ts` (GET response fields)

**Interfaces:**
- Consumes: the services (all logic stays there); `withApiContext`; `serviceErrorStatus`; the `[id]/route.ts` conventions (uuid edge validation, invalid_json 400, ServiceError mapping, `reportError` tag per route).
- Produces (mobile consumes EXACTLY these):

```
POST /api/v1/maintenance-requests/[id]/resolve       body { note: string }        → 200 { ok: true }
POST /api/v1/maintenance-requests/[id]/archive       (no body)                    → 200 { ok: true }
POST /api/v1/maintenance-requests/[id]/assign-owner  body { userId: string|null } → 200 { ok: true }
GET  /api/v1/maintenance-requests/[id]/notes                                       → 200 { notes: { id, authorUserId, body, createdAt }[] }
POST /api/v1/maintenance-requests/[id]/notes         body { body: string }        → 201 { id }
GET  /api/v1/maintenance-requests/members                                          → 200 { members: { userId: string; name: string }[] }
GET  /api/v1/maintenance-requests/[id]  — response `request` gains resolvedAt/resolvedByName/resolutionNote; photos[] gains kind
```

- [ ] **Step 1: Failing tests** (route-test conventions from `[id]/route.test.ts`): per route — 401 unauthenticated; uuid 400; delegation argument pinned (e.g. resolve forwards the RAW body to `service.resolve(id, body)` — the service owns the schema, the route never re-parses, matching the PATCH precedent and its landmine comment); ServiceError mapping literal (forbidden → 403, conflict → 409); notes GET/POST surface the service's manage-only forbidden; members route is manage-gated (`can(ctx,'maintenance_requests:manage')` before the query — pin a 403 for a submit-only ctx) and maps the accepted-members query (the web page's `fetchAcceptedMembers` shape — lift that function out of `[id]/page.tsx` into a small shared server module `apps/web/src/server/lib/maintenance-members.ts` so page and route share ONE query; page test stays green). Detail GET: response includes the three new fields + photo kind (literal fixture pins).

- [ ] **Step 2: Run to verify failure.** `pnpm --filter web test -- "api/v1/maintenance-requests"` → FAIL.

- [ ] **Step 3: Implement.** Each route is the `draft-opened/route.ts` shape: `withApiContext` → uuid check → try/delegate/map. `resolve` passes the parsed JSON body straight through (`await new MaintenanceRequestsService(ctx).resolve(id, body)`). `members/route.ts` carries a comment that the static segment coexists with `[id]` (App Router prefers static) and ids are uuid-validated regardless.

- [ ] **Step 4: Run to verify pass.** `pnpm --filter web test -- maintenance && pnpm --filter web typecheck && pnpm --filter web build` → PASS (build route table shows the five new paths).

- [ ] **Step 5: Mutation self-check:**
  - **T8-M1** — members route drops the manage gate → its 403 test fails.
  - **T8-M2** — resolve route re-parses with a local `z.object({ note: z.string() })` and forwards the parsed copy → the delegation pin (raw body identity) fails — the service schema must stay the single authority.
  - **T8-M3** — notes POST returns 200 instead of 201 → status pin fails.

- [ ] **Step 6: Commit.**

```bash
git add "apps/web/src/app/api/v1/maintenance-requests" apps/web/src/server/lib/maintenance-members.ts \
        "apps/web/src/app/(dashboard)/dashboard/maintenance/[id]/page.tsx"
git commit -m "feat(maintenance): mobile parity routes - resolve, archive, assign-owner, notes, members"
```

---

# Phase 7 — Mobile (pure JS, OTA-safe)

## Task 9: Mobile status parity — wrappers, list filter chips, resolved detail display

**Files:**
- Modify: `apps/mobile/src/lib/maintenance-api.ts` + `.test.ts`
- Modify: `apps/mobile/app/(drawer)/maintenance.tsx`
- Modify: `apps/mobile/app/maintenance/[id].tsx`
- Create (if list-chip logic warrants extraction): `apps/mobile/src/lib/maintenance-filters.ts` + `.test.ts` (pure helper: chip list derivation + selected-chip → query param)

**Interfaces:**
- Consumes: `MAINTENANCE_STATUS_LABELS` (5 entries, T2); list route `status` param (shipped — the wrapper comment claiming "no params beyond scope/q" is STALE and must be corrected, spec §12.3); detail/photo response fields (T8).
- Produces:

```ts
// maintenance-api.ts
listMaintenanceRequests(args: { scope: 'mine' | 'all'; q?: string; status?: MaintenanceStatus | 'active' })
export interface MobileMaintenanceRequestDetail { …; resolvedAt: string | null; resolvedByName: string | null; resolutionNote: string | null }
export interface MobileMaintenancePhoto { …; kind: 'requester' | 'resolution' }

// maintenance-filters.ts
export const MAINTENANCE_STATUS_CHIPS: { value: MaintenanceStatus | 'active' | undefined; label: string }[];
//   derived: All (undefined) · Active · then Object.entries(MAINTENANCE_STATUS_LABELS)
export function statusQueryParam(selected: …): string | undefined;
```

- [ ] **Step 1: Failing tests:**

```ts
// maintenance-api.test.ts additions
// 1. status forwarded: listMaintenanceRequests({ scope:'mine',
//    status:'resolved' }) fetches literal
//    '/api/v1/maintenance-requests?scope=mine&status=resolved' (URL pin);
//    absent status → param absent.
// 2. detail mirror: the three new fields + photo kind typecheck and
//    round-trip a canned response (field-for-field mirror rule — a payload
//    missing resolvedByName is a type error, not a silent undefined).

// maintenance-filters.test.ts
// 3. chip list literal-pinned: ['All','Active','Saved','Email draft opened',
//    'Resolved','Archived','Cancelled'] in that order (derived from the ONE
//    labels record + the two synthetic entries — a label drift fails here
//    AND in core, both directions).
// 4. statusQueryParam: 'All' → undefined; 'Active' → 'active'; 'Resolved' →
//    'resolved'.
```

- [ ] **Step 2: Run to verify failure.** `pnpm --filter mobile test -- maintenance` → FAIL.

- [ ] **Step 3: Implement.** Wrapper: optional `status` into the existing `URLSearchParams` build; fix the stale doc comment (the route DOES accept `status`; limit/offset remain absent — keep that half of the comment). Mirrors extended. List screen: a horizontal chip row (the existing scope-`Pill` pattern) under the scope row, driving `status` through the existing debounced load (`debounced-list-load.ts` — pass status into its key so a chip tap cancels stale responses, the Task 18 guard); chips from `MAINTENANCE_STATUS_CHIPS`. Detail screen: Resolution card (Eyebrow `RESOLUTION`, note Body, `Marked resolved by {resolvedByName}` line) rendered when `resolvedAt`; photo grid split — existing `PHOTOS · N` card shows `kind === 'requester'`; a `RESOLUTION PROOF · N` card shows the rest; both reuse the existing `expo-image` cell (URLs arrive signed; the item-images cache helpers stay unrelated, per the shipped comment).

- [ ] **Step 4: Run to verify pass.** `pnpm --filter mobile test && pnpm --filter mobile typecheck` → PASS. `git diff --stat apps/mobile/package.json pnpm-lock.yaml` → EMPTY (GC 7).

- [ ] **Step 5: Mutation self-check:**
  - **T9-M1** — chip list hand-typed (drop the derivation) with 'Ticket resolved' → test 3 fails.
  - **T9-M2** — status param sent as `filter=` → test 1's literal URL pin fails.
  - **T9-M3** — proof photos rendered in the main PHOTOS card → the detail-screen split assertion (extracted-helper or source pin, whichever the screen test uses — prefer a pure `splitPhotosByKind` helper in `maintenance-filters.ts` with real unit tests) fails.

- [ ] **Step 6: Commit.**

```bash
git add apps/mobile/src/lib/maintenance-api.ts apps/mobile/src/lib/maintenance-api.test.ts \
        apps/mobile/src/lib/maintenance-filters.ts apps/mobile/src/lib/maintenance-filters.test.ts \
        "apps/mobile/app/(drawer)/maintenance.tsx" "apps/mobile/app/maintenance/[id].tsx"
git commit -m "feat(mobile): resolved status filter, badge, and resolution display on maintenance"
```

---

## Task 10: Mobile close-out actions — Resolve (note + proof), Archive, Assign owner, Internal notes

**Files:**
- Modify: `apps/mobile/src/lib/maintenance-api.ts` + `.test.ts` (6 new wrappers)
- Modify: `apps/mobile/src/lib/maintenance-upload.ts` + `.test.ts` (`kind` threading)
- Create: `apps/mobile/src/lib/maintenance-actions.ts` + `.test.ts` (pure decision helpers — GC: RN screens cannot render under this repo's vitest, so every DECISION lives in a genuinely-tested helper, never a source-text pin)
- Modify: `apps/mobile/app/maintenance/[id].tsx` (the action cards — orchestration + rendering only)

**Interfaces:**
- Consumes: T8 routes (paths verbatim); `canManage` from the existing GET response; `uploadMaintenancePhoto` orchestration (mint→PUT→finalize) and `UploadError` kinds (shipped).
- Produces:

```ts
// maintenance-api.ts
resolveMaintenanceRequest(id: string, note: string): Promise<{ ok: true }>        // POST …/resolve { note }
archiveMaintenanceRequest(id: string): Promise<{ ok: true }>                       // POST …/archive
assignMaintenanceOwner(id: string, userId: string | null): Promise<{ ok: true }>   // POST …/assign-owner { userId }
listMaintenanceNotes(id: string): Promise<{ id: string; authorUserId: string | null; body: string; createdAt: string }[]>
addMaintenanceNote(id: string, body: string): Promise<{ id: string }>
listMaintenanceMembers(): Promise<{ userId: string; name: string }[]>              // GET …/members

// maintenance-upload.ts — uploadMaintenancePhoto gains kind?: 'requester' | 'resolution'
//   (default 'requester'), threaded into BOTH the mint body and the finalize body.

// maintenance-actions.ts (pure, unit-tested)
export function availableCloseoutActions(d: { canManage: boolean; isOwnRequest: boolean;
  archivedAt: string | null; cancelledAt: string | null; resolvedAt: string | null }):
  { resolve: boolean; archive: boolean; cancelNote: boolean; assignOwner: boolean; notes: boolean };
export function canConfirmResolve(note: string): boolean;   // trimmed length >= 5 (mirror the schema min; server is authority)
export const MOBILE_RESOLVE_DISCLOSURE =
  'Marks this request resolved in StockPilot and emails the requester the note and any proof photos. It does not close or update the Zendesk ticket.';
```

- [ ] **Step 1: Failing tests:**

```ts
// maintenance-api.test.ts — per wrapper: method + literal path pin
//    ('/api/v1/maintenance-requests/abc/resolve' etc) + body pin
//    ({ note }, { userId: null } round-trips null, not undefined).
// maintenance-upload.test.ts — kind threading: kind:'resolution' appears in
//    BOTH recorded bodies (mint + finalize); default omits it or sends
//    'requester' (match the web panel's choice — pin whichever; be
//    consistent across platforms: send the field explicitly on both).
// maintenance-actions.test.ts —
// 1. availableCloseoutActions truth table (literal cases): open+manage →
//    all true except cancelNote; resolved+manage → { resolve:false,
//    archive:true, assignOwner:false, notes:true }; cancelled+manage →
//    archive:true, resolve:false; archived+manage → all false except notes;
//    open+not-manage → all false (cancel remains the shipped requester flow,
//    untouched by this program).
// 2. canConfirmResolve: '    ' false, 'Fixed' true (5 chars), 4 chars false.
// 3. MOBILE_RESOLVE_DISCLOSURE literal-pinned + §GC-4 forbidden sweep over
//    every exported copy constant in the module.
```

- [ ] **Step 2: Run to verify failure.** `pnpm --filter mobile test -- maintenance` → FAIL.

- [ ] **Step 3: Implement.** Wrappers via the existing `api()` client (409-not-429 contract note carried onto `resolveMaintenanceRequest` — the create-route precedent). Upload: `kind` param into `mintPhotoUpload`/`finalizePhoto` call bodies (both explicitly send the field). Screen: a `CLOSE-OUT` Card rendered from `availableCloseoutActions` (fed by the GET response + `detail`): Resolve = inline expanding section (the `copyOpen` pattern) with a multiline `TextInput`, `MOBILE_RESOLVE_DISCLOSURE` Body line, "Add proof photo" using the existing picker flow from `new.tsx` routed through `uploadMaintenancePhoto(…, { kind: 'resolution' })` with the shipped progress/retry affordances, and a confirm `Button` disabled until `canConfirmResolve(note)`; success → reload the detail (the screen's existing load effect re-fires via a refresh key). Archive = `Alert.alert` confirm → `archiveMaintenanceRequest`. Assign owner = lazy `listMaintenanceMembers()` on expand → tappable member rows + a Clear row → `assignMaintenanceOwner`. Notes = lazy `listMaintenanceNotes()` on expand (manage-only per `availableCloseoutActions`) → list + `TextInput` + Add. All new copy lives in `maintenance-actions.ts` constants (sweepable).

- [ ] **Step 4: Run to verify pass.** `pnpm --filter mobile test && pnpm --filter mobile typecheck` → PASS. `git diff --stat apps/mobile/package.json pnpm-lock.yaml` → EMPTY. Boot the iOS simulator and hand-test the four actions if the dev client runs; if the pre-existing boot crash still blocks it, record that honestly in the task report (owner rule; the infra rebuild is a separate track).

- [ ] **Step 5: Mutation self-check:**
  - **T10-M1** — `availableCloseoutActions` returns `resolve: true` for a resolved row → truth-table case fails.
  - **T10-M2** — drop `kind` from the finalize body only → upload test's finalize-body pin fails (a mint-only threading would record proof rows as requester photos server-side — the default).
  - **T10-M3** — `assignMaintenanceOwner(id, null)` sends `{}` → the null round-trip body pin fails (clearing the owner must reach the service as an explicit null).
  - **T10-M4** — disclosure reworded to 'and closes the ticket' → the sweep + literal pin fail.

- [ ] **Step 6: Commit.**

```bash
git add apps/mobile/src/lib/maintenance-api.ts apps/mobile/src/lib/maintenance-api.test.ts \
        apps/mobile/src/lib/maintenance-upload.ts apps/mobile/src/lib/maintenance-upload.test.ts \
        apps/mobile/src/lib/maintenance-actions.ts apps/mobile/src/lib/maintenance-actions.test.ts \
        "apps/mobile/app/maintenance/[id].tsx"
git commit -m "feat(mobile): maintenance close-out actions - resolve with proof, archive, assign owner, notes"
```

---

# Phase 8 — Verification and ship

## Task 11: Full gate, honesty sweeps, manual walk, verification log, report, ship checklist

**Files:**
- Create: `docs/superpowers/reports/2026-08-06-maintenance-resolved-verification.md`
- Create: `docs/superpowers/reports/2026-08-06-maintenance-resolved-report.md`

- [ ] **Step 1: Full gate — run and record REAL output** (no paraphrase) in the verification log:

```bash
pnpm --filter @stockpilot/core test
pnpm --filter web test
pnpm --filter mobile test
pnpm --filter web typecheck && pnpm --filter mobile typecheck
pnpm --filter web lint
pnpm --filter web build          # route table must show the 5 new API paths
supabase db reset && supabase test db   # 0317 suite ok; 0207 still at 119
git diff --stat main...HEAD -- apps/mobile/package.json pnpm-lock.yaml   # MUST be empty (GC 7)
```

- [ ] **Step 2: Honesty sweeps** (record the commands + counts):
  - Forbidden-phrase grep over production source for the FULL GC-4 list (raw hits allowed ONLY inside sweep tests' banned arrays and this plan/spec).
  - `grep -ri zendesk` across every file this program touched — every hit must be a comment/disclosure/test-array, zero executable surface (the shipped 39-hit baseline may grow only by disclosure copy and the honesty line).
  - Emoji + `Co-Authored-By` grep across the branch diff and commits: zero.
  - Literal-pin census: the GC-9 contract values each pinned somewhere, file:line recorded.
  - Negative send-guard: `grep -rn "api.resend.com" apps/web/src` — exactly the one shipped hit in `lib/email/resend.ts` (the seam), nothing new.

- [ ] **Step 3: Manual authed browser walk** (local stack, `RESEND_API_KEY` UNSET — the sender dry-runs; GC 1: no real email may leave a walk; only ever resolve a request whose requester IS the signed-in demo account):
  1. As demo manager, create a request with 1 photo; open its detail; Resolve with the owner's example note + 1 proof photo; verify: dialog gating, toast, badge flips to Resolved, Resolution card + proof section render, requester Photos card unchanged, Archive still offered, Resolve/Cancel gone.
  2. List: Resolved pill filters to the row; Active excludes it; All statuses shows it.
  3. Share page: open the `/m/` link — Resolution proof section labeled, combined-index photo URLs load through the proxy, note + Marked resolved line render, no resolver name present.
  4. DB spot-checks (SQL in the log): `status='resolved'`, all five resolution columns populated, `resolution_email_sent_at` STAMPED exactly once (the dry-run send still claims the marker — expected and correct); re-running resolve on the same row via the API returns 409.
  5. Archive the resolved request; verify re-bucket (badge Archived, resolution card still renders, pill filters move it).
  6. Notification row exists for the requester persona with link `/dashboard/maintenance/{id}` (and, where a second demo user is available, the resolve-of-another's-request path pings them; self-resolve pinged nobody).
  7. Mobile simulator (if bootable — else record the blocker): drawer list chips, resolved badge, detail resolution card, the four action cards, one proof upload end-to-end against the local API.

- [ ] **Step 4: Engineering report** — `2026-08-06-maintenance-resolved-report.md`: what shipped per D1-D5, the §12 honest-resistance items and how they landed, test counts, walk results, limitations (reopen deferred; WEBP-in-Outlook caveat; simulator status), and the ship checklist below verbatim.

- [ ] **Step 5: Commit the docs.**

```bash
git add docs/superpowers/reports/2026-08-06-maintenance-resolved-verification.md \
        docs/superpowers/reports/2026-08-06-maintenance-resolved-report.md
git commit -m "docs(maintenance): resolved program verification log and engineering report"
```

### Ship checklist (controller executes — order binding, GC 6)

```text
1. supabase db push --linked          # 0317 FIRST (project xizpqmhhslgzbuqtjubv).
                                      # resolve() writes a status the old CHECK
                                      # rejects — code-before-migration is an outage.
2. Open PR feat/maintenance-resolved -> main; merge after review.
   Vercel deploys on push — do NOT also POST /v13/deployments.
3. Prod verify (Demo Co, module temporarily enabled exactly as the 0314 ship
   log did — record enable/disable SQL + timestamps): resolve a request whose
   requester IS the demo account; verify pill/detail/share page; verify
   resolution_email_sent_at stamped; the REAL email to demo@stockpilotusa.com
   is the ONE sanctioned live-send verification — inspect it for the honesty
   line, the verbatim note, the resolver name, and working proof-photo images.
   NEVER resolve a request belonging to a real L4L requester during verification.
4. Mobile OTA: cd apps/mobile && pnpm release:ota   (never raw `eas update`;
   pure-JS verified by the empty package.json/lockfile diff).
5. Owner hand-test on L4L when ready; Andrew needs no new grants
   (read_all/manage already cover every new surface).
```
