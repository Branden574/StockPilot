# Cycle-Count Security & Workflow Rebuild — Implementation Plan

> **For agentic workers:** execute task-by-task; gate (typecheck + targeted tests, pgTAP where a migration changed) after each. Steps use `- [ ]`.

**Goal:** Lock a cycle count to its assigned employee end-to-end (server + RLS authoritative), add explicit release-with-reason, manager reassign / force-reassign, concurrency versioning, and harden the mobile counting screen + AI Shelf Scan — mirroring the proven order-picking claim/lock model without removing any existing cycle-count capability.

**Architecture:** One gated service (`CycleCountsService`) is the single write path for both web server actions and mobile Bearer routes. Ownership + state transitions are enforced in `SECURITY DEFINER` Postgres RPCs and RLS so a direct PostgREST/mobile write cannot bypass them. Mobile gating is defense-in-depth, never the gate. The order-picking backend (migrations 0236–0240, `assigned_picker_id` + `claim/assign/release` RPCs + `not_assigned_picker` lock) is the reference template.

**Tech Stack:** Next.js 15 App Router (apps/web) + Supabase Postgres/RLS (migrations start at **0282**) + pgTAP (supabase/tests) + Expo/expo-router (apps/mobile) + packages/core shared TS.

## Global Constraints (from the owner + master prompt)

- **Assignment model:** manager-assigned-only (no staff self-claim). A count must be assigned before a non-manager may count it. Managers may act as override.
- **Owner decisions (locked):** released/partial progress is **preserved with per-line counter attribution**; managers **may force-reassign an active count** (elevated permission + required reason + audit + notify previous assignee); AI Shelf Scan **pre-fills high-confidence per-line for confirmation and never auto-applies low-confidence**; submission is **threshold-gated variance review** (small/zero auto-apply, above-threshold holds for manager approval). Blind counting is **deferred** (v1 keeps show-expected).
- Migrations applied to prod via `supabase db push --linked` BEFORE deploying web that reads new columns; pgTAP for every migration.
- Web + mobile parity; mobile via Bearer `/api/v1` + OTA (`pnpm release:ota`).
- No Claude co-author trailer; commits Branden574-only.
- Preserve existing modes (warehouse + selection scope, AI scan, offline queue). `status` values stay `in_progress|completed|canceled`; assignment lock is a separate concern from lifecycle status (mirrors picking, where `assigned_picker_id` is orthogonal to `status`).
- Structured error codes: `CYCLE_COUNT_ASSIGNED_TO_ANOTHER_USER`, `CYCLE_COUNT_RELEASE_REASON_REQUIRED`, `CYCLE_COUNT_VERSION_CONFLICT`, `CYCLE_COUNT_NOT_EDITABLE`, `CYCLE_COUNT_ALREADY_COMPLETED`.

---

## Root cause (confirmed exploitable, audit wf_e5716fa5-b93)

`cycle_counts.assigned_to` (mig 0038) is advisory only. No layer reads it back on a mutation: the Bearer record route only auth/rate-limits; `recordCount()` (cycle-counts.ts:808) gates module + `stock:adjust` + warehouse write; the `cycle_count_lines` UPDATE RLS (0143 USING + 0203 WITH CHECK) gates staff-role + `status='in_progress'` + `counted_by∈{null,self}` — the `counted_by=auth.uid()` clause is toothless because the service always stamps `counted_by` to the caller. Any same-warehouse `staff` coworker (default role carries `stock:adjust`) can overwrite an assignee's counts; a non-assignee manager can additionally post/cancel. Picking's `not_assigned_picker` lock was never mirrored.

---

## Phase 1 — Server + RLS assignee-lock (the security fix; decision-independent)

Fixes the confirmed exploit. No product-policy dependency. Ship first.

### Task 1.1: Migration 0282 — assignee-lock columns + RLS predicate + assign/release/force-reassign RPCs

**Files:** Create `supabase/migrations/0282_cycle_count_assignment_lock.sql`; Test `supabase/tests/0282_cycle_count_assignment_lock.test.sql`

**Interfaces produced (RPCs, all `security definer`, `grant execute … to authenticated`):**
- `assign_cycle_count(p_count_id uuid, p_user_id uuid) returns cycle_counts` — manager+ only; target must be accepted org member with warehouse write; `FOR UPDATE`; sets `assigned_to`, `assignment_claimed_at`, `assignment_claimed_by=auth.uid()`, bumps `assignment_version`.
- `release_cycle_count(p_count_id uuid, p_reason text) returns cycle_counts` — self (current assignee) or manager+; requires non-blank `p_reason` (raise `release_reason_required` P0001 on blank/whitespace); clears `assigned_to`/claimed cols, bumps version, writes a `cycle_count_release` audit row; **preserves counted lines** (owner decision).
- `force_reassign_cycle_count(p_count_id uuid, p_user_id uuid, p_reason text) returns cycle_counts` — manager+ only, requires reason; reassigns an *active* (assigned) count; bumps version; audit `cycle_count_force_reassigned` with previous assignee.

**Columns added to `cycle_counts`:** `assignment_claimed_at timestamptz`, `assignment_claimed_by uuid references user_profiles(id) on delete set null`, `assignment_version integer not null default 0`. (`assigned_to` already exists, 0038.)

**RLS change — `cycle_count_lines_update`** (drop + recreate both USING and WITH CHECK, per recurring-bug #24 — do NOT use bare `alter policy … with check`): add the assignee predicate to the existing staff+in_progress+warehouse gate:
```
and (
  cc.assigned_to = (select auth.uid())          -- the assignee
  or cc.assigned_to is null                       -- legacy/unassigned: preserve today's open behavior
  or public.has_org_role(cc.organization_id, 'manager')  -- manager override
)
```
Keep the existing `counted_by ∈ {null, self}` clause and `warehouse_in_org` in WITH CHECK. Rationale for `assigned_to is null`: the CRITICAL bug is a coworker writing to a count assigned to *someone else*; permitting writes when unassigned preserves existing warehouse-count flows and is closed by Phase 3's assign-before-count workflow.

- [ ] Step 1: pgTAP first — assert (a) assignee can update a line on their assigned count; (b) a non-assignee non-manager staff of the same warehouse is BLOCKED (0 rows updated / RLS denies); (c) a manager (non-assignee) can update (override); (d) unassigned in-progress count still writable by staff; (e) `release_cycle_count` with blank reason raises; (f) `assign_cycle_count` by non-manager raises `forbidden`. Run `supabase db reset` then the test; expect FAIL (RPCs/policy absent).
- [ ] Step 2: write the migration (columns, drop+recreate `cycle_count_lines_update`, three RPCs mirroring 0237 structure + grants + column comments).
- [ ] Step 3: `supabase db reset` + rerun pgTAP; expect PASS. Bump any policy-count assertion in the 0207 permissions test only if a permission was added (none here).
- [ ] Step 4: Commit.

### Task 1.2: Service-layer enforcement (defense-in-depth) + structured errors

**Files:** Modify `apps/web/src/server/services/cycle-counts.ts` (add assignee guard to `recordCount`, `clearCount`, and the AI-confirm write path); Modify `apps/web/src/server/services/errors.ts` (or wherever `ServiceError` codes live) to add the new codes; Test `apps/web/src/server/services/cycle-counts.assignment.test.ts`

**Interfaces consumed:** `assertSessionAccess` already loads the header; extend it (or add `assertAssignee(cycleCountId)`) to also select `assigned_to` and compare to `ctx.userId`, allowing managers via `isManagerOrAbove(ctx.role)`.

- [ ] Step 1: failing unit test — a non-assignee staff `recordCount` throws `CYCLE_COUNT_ASSIGNED_TO_ANOTHER_USER`; assignee succeeds; manager override succeeds; unassigned count allows staff (parity with RLS).
- [ ] Step 2: add `assertAssignee` (selects `assigned_to`; throws when set, `!= ctx.userId`, and `!isManagerOrAbove`); call it in `recordCount`, `clearCount`, and `markAiScanConfirmed`'s record path. Add the error code + user-facing mapping.
- [ ] Step 3: run the new test + the existing cycle-counts suite; expect PASS.
- [ ] Step 4: Commit.

### Task 1.3: Service wrappers for assign/release/force-reassign RPCs + Bearer routes

**Files:** Modify `cycle-counts.ts` (replace the app-layer CAS `assign()` with an `assign_cycle_count` RPC call; add `release()` + `forceReassign()`); Create/modify Bearer routes under `app/api/v1/cycle-counts/[id]/{assign,release,reassign}/route.ts`; server actions in `server/actions/cycle-counts.ts`; tests.

- [ ] Step 1: failing tests for each wrapper (maps raw errcodes → ServiceError; audits).
- [ ] Step 2: implement wrappers (thin: module + permission gate, RPC call, errcode map, audit) mirroring the picking service.
- [ ] Step 3: tests pass; typecheck.
- [ ] Step 4: Commit. **Apply 0282 to prod (`supabase db push --linked`) before any deploy of these routes.**

---

## Phase 2 — Concurrency / optimistic locking

Uses `assignment_version` from 0282 + a new `record_version` on lines.

- Task 2.1: Migration 0283 — add `version integer not null default 0` to `cycle_count_lines`; a `record_cycle_count_line(p_line_id, p_qty, p_expected_version, …)` RPC that does compare-and-set (raise `version_conflict` P0001 when stale) and stamps `counted_by`. pgTAP for stale-write rejection.
- Task 2.2: Route `recordCount` through the RPC; surface `CYCLE_COUNT_VERSION_CONFLICT` (409) so the mobile app shows "this count changed — refresh". Offline sync (`cycle-count-sync.ts`) revalidates assignee + version before draining the outbox; on conflict, preserve the local entry as a conflict record instead of overwriting.

## Phase 3 — Mobile queue + release/reassign UI + the two UI fixes

- Task 3.1: **Header safe-area fix (owner screenshot).** `apps/mobile/app/cycle-count/scan/[id].tsx` header collides with the status bar because the route is a `fullScreenModal` hoisted out of the root `SafeAreaProvider` (top inset → 0). Fix in `apps/mobile/app/_layout.tsx` (register the scan route inside the provider, matching the AI Shelf Scan route which renders correctly) OR wrap the scan screen in its own `SafeAreaProvider`. Verify against the AI-scan reference.
- Task 3.2: **Scan-button sizing.** Give the regular Scan launch button and the AI Scan button a shared style (min-width, ≥44pt touch target, no overflow) via a shared component; test long labels + small/large devices.
- Task 3.3: **Assigned-to-Me queue.** `cycle-counts.tsx` list: split "Assigned to Me" vs others; do NOT present Start/Continue on counts assigned to another employee — show the read-only "Assigned to {name}" unavailable state. Remove the non-functional "Filter" label.
- Task 3.4: **Release sheet.** Destructive confirm sheet (reason category picker + required notes for "Other") → `POST /api/v1/cycle-counts/[id]/release`. Visually distinct from the primary Continue action.
- Task 3.5: **Manager reassign / force-reassign** UI on web + mobile (manager only), each requiring a reason.
- Task 3.6: OTA + simulator hand-test (owner sim rule) both scan flows + release + unauthorized state.

## Phase 4 — AI Shelf Scan hardening

- Task 4.1: Move the `stock:adjust` permission check + `in_progress` guard + **assignee check** BEFORE the vision call and photo upload (currently deferred until after the paid call). Add a module/permission gate on the mobile AI Scan button.
- Task 4.2: **Per-line confirmation** (owner decision): high-confidence pre-fills each line for explicit confirm; low-confidence never auto-applies (prompt barcode/manual). Replace the one-tap bulk apply.
- Task 4.3: Cost controls — per-org (not just per-user) rate cap that fails CLOSED on DB error; clean up orphaned scan photos on vision/insert failure; don't hard-gate the endpoint on `GEMINI_API_KEY` when the active provider is Claude.

## Phase 5 — Submission, variance review, idempotent adjustments, audit

- Task 5.1: Threshold-gated variance review (owner decision) — configurable threshold (org/warehouse); small/zero variances auto-apply, above-threshold holds for manager approval before `post`. New status/flag for "variance_review".
- Task 5.2: Idempotent `post` (guard against double-submit / retry) keyed on the count; audit every entry (`cycle_count.line_counted`) and attribute the stock movement to the counter, not just the poster.
- Task 5.3: Structured error-code map + user-facing copy across web + mobile.

## Phase 6 — Verification

Full web suite + pgTAP, mobile typecheck, multi-user authorization tests (assignee / non-assignee / manager), concurrency tests, offline-conflict test, simulator hand-test iOS, then owner Android/device pass. Report results honestly; readiness rating.

---

## Self-review notes

- The `assigned_to is null` allowance in Phase 1 RLS is deliberate (non-breaking) and closed by Phase 3's assign-before-count queue; flagged so a reviewer doesn't read it as an oversight.
- Managers bypass the assignee lock (parity with picking `has_org_role(manager)`), consistent with the force-reassign decision.
- Do NOT convert `status` into the assignment state — assignment lock is orthogonal (picking precedent).
