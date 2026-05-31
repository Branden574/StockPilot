# Dashboard Load Performance — Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Cut the ~2s skeleton on dashboard first-load + navigation (items/books/categories/overview) WITHOUT removing features. Grounded in the read-only investigation (workflow wporvrv96): images/bundle/count are already optimal; the cost is (1) a per-request auth/context waterfall that re-fetches what the layout already loaded, and (2) no client/navigation caching (skeleton on every click).

**Branch:** `perf/dashboard-load`. Conventions: commit per task; stage only task files (unrelated WIP `templates.tsx`/`team.ts`/`scripts/*.mjs` must NOT be staged); trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; `tsc` clean before commit; do NOT push (controller ships). Every task adds **regression tests** (no feature/behavior change) and where useful **Server-Timing instrumentation** to make the gain measurable. No DB migration.

**Hard invariant (T1):** the MFA/auth fail-closed gate behavior must be **byte-for-byte preserved** — same `mfaRequired`/`mfaSatisfied` outcome for every case (no factor, factor+policy, AAL1 vs AAL2). The adversarial reviewer verifies this explicitly.

---

## Task 1: Collapse the `withContext` auth waterfall (dedupe + parallelize + short-circuit)
**Files:** `apps/web/src/server/services/context.ts` (`withContext`, `resolveMfaState`), `apps/web/src/lib/auth/request-cache.ts` (request-cache helpers — find `getOrgRowForRequest`/`getMfaFactorsForRequest`/modules helper), maybe `apps/web/src/lib/auth/session.ts`. READ all three first + the dashboard layout (`apps/web/src/app/(dashboard)/layout.tsx`) to see what it already fetches.

- [ ] **Step 1: Characterize current behavior + write a regression test FIRST** — a test (`context.test.ts` or extend existing) that pins `resolveMfaState`/`withContext` outputs for: (a) no verified MFA factor + policy required → `mfaRequired=true, mfaSatisfied=false` (fail-closed); (b) verified factor + AAL2 → satisfied; (c) verified factor + AAL1 → not satisfied; (d) policy not required → `mfaRequired=false`. Mock the supabase calls. These MUST keep passing unchanged after the refactor.
- [ ] **Step 2: Dedupe** — `resolveMfaState` reads `organizations.mfa_policy` via its own SELECT (context.ts ~line 40-44); source it from the already-request-cached `getOrgRowForRequest(orgId)` instead (the layout already fetched that row → free). Likewise add/reuse a `getModulesForRequest(orgId)` React.cache helper and call it from BOTH the layout and `withContext` so `organization_modules` is fetched once per request, not twice.
- [ ] **Step 3: Parallelize** — the modules read and the mfa-policy read are independent; run them with `Promise.all` instead of sequentially.
- [ ] **Step 4: Short-circuit AAL** — `resolveMfaState` calls `supabase.auth.mfa.getAuthenticatorAssuranceLevel()` (an auth round-trip) even when there is no verified factor. Pass/derive the request-cached MFA factor list (`getMfaFactorsForRequest`); if there is NO verified factor, set `mfaSatisfied=false` WITHOUT the AAL call. Only call AAL when a verified factor exists AND policy requires MFA. Preserve the exact fail-closed result.
- [ ] **Step 5: Instrument** — add lightweight `Server-Timing` marks (or timing logs behind a debug flag) around context resolution so the round-trip reduction is observable in prod. Keep it cheap + non-breaking.
- [ ] **Step 6:** Run the regression tests (all pass, unchanged outcomes) + `cd apps/web && npx tsc --noEmit`. Commit `perf(web): dedupe + parallelize withContext auth/MFA resolution (preserve fail-closed gate)`.

## Task 2: RSC cache window + nav prefetch (instant tab/back-nav within a session)
**Files:** `apps/web/next.config.ts` (`experimental.staleTimes`), the dashboard sidebar nav component (find the `<Link>`s). READ both.
- [ ] **Step 1:** Bump `experimental.staleTimes.dynamic` from 30 to ~180 (keep `static` as-is) so the warm RSC payload is reused for tab/back navigation within a normal working session.
- [ ] **Step 2:** Ensure the sidebar/dashboard nav `<Link>`s use `prefetch` (default true in App Router, but confirm none disable it; for the main item/books/categories/overview links, prefetch should be on) so the RSC payload is fetched on hover/viewport before the click.
- [ ] **Step 3:** `cd apps/web && npx tsc --noEmit`. Commit `perf(web): widen RSC stale window + prefetch dashboard nav`. (Config/markup only; no test needed beyond tsc — note the tradeoff: data up to ~180s stale on soft-nav, refreshed on hard nav/mutations via revalidatePath which already exists.)

## Task 3: Suspense-stream the page body (chrome paints instantly; only the table skeletons)
**Files:** the 4 dashboard pages — `apps/web/src/app/(dashboard)/dashboard/{inventory,books,categories,page}.tsx` (overview is `dashboard/page.tsx`) + a `TableBodySkeleton` if needed. READ each page + its `loading.tsx`.
- [ ] **Step 1:** For each list page (inventory, books, categories): render the non-data chrome (h1/description, filter toolbar, New/Import buttons, view toggles) **synchronously**, and move the awaited data fetch into an **inner async Server Component** wrapped in `<Suspense fallback={<TableBodySkeleton/>}>`. The page shell returns immediately; only the table body streams. (The existing `loading.tsx` still covers the very first navigation transition; the in-page Suspense makes the chrome appear without waiting for data.)
- [ ] **Step 2:** Overview (`dashboard/page.tsx`): wrap the heavier data sections (stats, low-stock, movements, trends) in `<Suspense>` so the page header + layout paint immediately and each section streams in. Keep security-critical gates (org/MFA) blocking.
- [ ] **Step 3:** Verify no feature/data change (same components, same props — just relocated behind Suspense). `cd apps/web && npx tsc --noEmit`. Add/keep a light render test if the repo has one for these pages. Commit `perf(web): stream dashboard page bodies via Suspense (chrome paints before data)`.

## Task 4: Client data cache (SWR) — DEFERRED (intentionally not built now)
**Decision (2026-05-31):** pivoted to the recommended safe set (T1-T3); PARKED the client cache. Rationale: Task 2 (RSC stale window ~180s + nav prefetch) already makes warm tab/back-nav near-instant at ZERO risk, so SWR's marginal gain is small at current scale (one org, few users); and a client cache layered on SSR is a freshness footgun on an inventory list where stock must be trustworthy (stale-after-write, cache-key/filter/pagination mismatches, mutation invalidation). REVISIT only when many concurrent power-users navigate heavily across >~3-min spans. If/when warranted: add `swr`, seed the items/books list tables from server props as `fallbackData`, fetcher to `/api/items/search`, key by `{itemType,filters,page,sort}`, and wire `mutate`/revalidation on every create/edit/delete/import to prevent stale-after-write.

---

## Final verification (DoD)
- [ ] `cd apps/web && npx tsc --noEmit` clean; `cd packages/core && npx tsc --noEmit` clean.
- [ ] `cd apps/web && npx vitest run` — all green, incl. the new MFA-gate regression tests (unchanged outcomes).
- [ ] No feature removed: filters, sorting, pagination, archive toggle, import, image thumbnails, the MFA gate — all still work.
- [ ] OTA-safety N/A (web-only; no mobile change).
- [ ] Measurement: Server-Timing shows fewer context round-trips; the chrome paints before data (Suspense); back/tab nav reuses the warm RSC payload. Note expected: ~2-3 fewer round-trips/page + instant warm-nav.

## Self-review
- **Coverage:** waterfall (T1), nav caching (T2 RSC stale window + prefetch), perceived first-paint (T3) — the two root causes + perceived latency all addressed; images/count/bundle correctly left alone (already optimal); client cache (T4) deferred by design.
- **Risk control:** T1 is gated by an MFA-behavior regression test + adversarial review (fail-closed gate byte-for-byte preserved). T2/T3 are config/structure only. T4 (medium risk) intentionally not built.
- **No placeholders:** each task has concrete files, the exact dedupe/parallelize/short-circuit edits, and test intents.
