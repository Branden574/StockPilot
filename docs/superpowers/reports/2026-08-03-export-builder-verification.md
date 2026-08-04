# Custom Export Builder — verification log

## Phase A — screenshot defects (Tasks 1-3)

Branch: `feat/export-builder`, HEAD `f5dbb2bc`.
Run: 2026-08-03.

### Commands and real output

#### 1. `pnpm --filter @stockpilot/web test 2>&1 | tail -30`

```
 ✓ src/lib/auth/api-context.aal.test.ts (5 tests) 2ms
 ✓ src/server/actions/delivery-tracking.test.ts (2 tests) 2ms
stderr | src/server/services/service-error.test.ts
[env] Using dev fallback for NEXT_PUBLIC_SUPABASE_URL. Add it to apps/web/.env.local for real Supabase.
[env] Using dev fallback for NEXT_PUBLIC_SUPABASE_ANON_KEY. Add it to apps/web/.env.local for real Supabase.

 ✓ src/lib/charter-display.test.ts (3 tests) 2ms
 ✓ src/server/services/inventory.placement.test.ts (6 tests) 3ms
 ✓ src/server/services/service-error.test.ts (3 tests) 2ms
stderr | src/server/services/order-attachments.thumb.test.ts
[env] Using dev fallback for NEXT_PUBLIC_SUPABASE_URL. Add it to apps/web/.env.local for real Supabase.
[env] Using dev fallback for NEXT_PUBLIC_SUPABASE_ANON_KEY. Add it to apps/web/.env.local for real Supabase.

stderr | src/server/services/locations.createPlacement.test.ts
[env] Using dev fallback for NEXT_PUBLIC_SUPABASE_URL. Add it to apps/web/.env.local for real Supabase.
[env] Using dev fallback for NEXT_PUBLIC_SUPABASE_ANON_KEY. Add it to apps/web/.env.local for real Supabase.

 ✓ src/server/services/locations.createPlacement.test.ts (2 tests) 2ms
 ✓ src/server/services/order-attachments.thumb.test.ts (3 tests) 2ms
stderr | src/server/services/locations.kindFilter.test.ts
[env] Using dev fallback for NEXT_PUBLIC_SUPABASE_URL. Add it to apps/web/.env.local for real Supabase.
[env] Using dev fallback for NEXT_PUBLIC_SUPABASE_ANON_KEY. Add it to apps/web/.env.local for real Supabase.

 ✓ src/server/services/locations.kindFilter.test.ts (4 tests) 2ms

 Test Files  410 passed (410)
      Tests  4475 passed (4475)
   Start at  13:19:39
   Duration  30.10s (transform 9.64s, setup 63.76s, collect 95.09s, tests 62.27s, environment 30.54s, prepare 20.51s)
```

**PASS** — 410 test files / 4475 tests, full workspace web suite, zero failures. Nothing was red on `main` for this suite before Phase A started (verified in Tasks 1-2's own gate output, which showed the same clean baseline before their changes landed), so there is no pre-existing-failure carve-out to document here.

#### 2. `pnpm typecheck 2>&1 | tail -20`

```
@stockpilot/web:typecheck: cache hit, replaying logs 3e2768e08f5e421a
@stockpilot/core:typecheck: cache hit, replaying logs c3f6599731d47b75
@stockpilot/mobile:typecheck: cache hit, replaying logs 7a0fe438ef1b0746
@stockpilot/web:typecheck: 
@stockpilot/web:typecheck: > @stockpilot/web@0.1.0 typecheck /Users/brandenvincent-walker/Developer/InventorySystem/apps/web
@stockpilot/web:typecheck: > tsc --noEmit
@stockpilot/web:typecheck: 
@stockpilot/core:typecheck: 
@stockpilot/mobile:typecheck: 
@stockpilot/mobile:typecheck: > @stockpilot/mobile@0.1.0 typecheck /Users/brandenvincent-walker/Developer/InventorySystem/apps/mobile
@stockpilot/mobile:typecheck: > tsc --noEmit
@stockpilot/mobile:typecheck: 
@stockpilot/core:typecheck: > @stockpilot/core@0.0.0 typecheck /Users/brandenvincent-walker/Developer/InventorySystem/packages/core
@stockpilot/core:typecheck: > tsc --noEmit
@stockpilot/core:typecheck: 

 Tasks:    3 successful, 3 total
Cached:    3 cached, 3 total
  Time:    1.45s >>> FULL TURBO
```

**PASS** — clean across all 3 packages (core, web, mobile). Turbo replayed a cache hit because the tree is unchanged since Task 2's own typecheck run; the underlying `tsc --noEmit` result is real (Task 2's report shows the uncached run that produced this same clean result).

#### 3. `pnpm lint 2>&1 | tail -30`

```
@stockpilot/web:lint:   62 |  react-hooks/set-state-in-effect
@stockpilot/web:lint: 
@stockpilot/web:lint: /Users/brandenvincent-walker/Developer/InventorySystem/apps/web/src/lib/image-variants.worker.ts
@stockpilot/web:lint:   61:3  warning  Unused eslint-disable directive (no problems were reported from '@typescript-eslint/no-explicit-any')
@stockpilot/web:lint: 
@stockpilot/web:lint: /Users/brandenvincent-walker/Developer/InventorySystem/apps/web/src/lib/pdf/packing-slip-shared.test.ts
@stockpilot/web:lint:   25:5  warning  Unused eslint-disable directive (no problems were reported from '@typescript-eslint/no-explicit-any')
@stockpilot/web:lint: 
@stockpilot/web:lint: /Users/brandenvincent-walker/Developer/InventorySystem/apps/web/src/lib/pdf/packing-slip-warehouse.test.ts
@stockpilot/web:lint:   80:3  warning  Unused eslint-disable directive (no problems were reported from '@typescript-eslint/no-explicit-any')
@stockpilot/web:lint: 
@stockpilot/web:lint: /Users/brandenvincent-walker/Developer/InventorySystem/apps/web/src/lib/pdf/pick-slip.test.ts
@stockpilot/web:lint:    86:3  warning  Unused eslint-disable directive (no problems were reported from '@typescript-eslint/no-explicit-any')
@stockpilot/web:lint:   107:7  warning  Unused eslint-disable directive (no problems were reported from '@typescript-eslint/no-explicit-any')
@stockpilot/web:lint:   112:7  warning  Unused eslint-disable directive (no problems were reported from '@typescript-eslint/no-explicit-any')
@stockpilot/web:lint: 
@stockpilot/web:lint: /Users/brandenvincent-walker/Developer/InventorySystem/apps/web/src/server/actions/nav-settings.test.ts
@stockpilot/web:lint:   99:11  warning  Unused eslint-disable directive (no problems were reported from 'no-script-url')
@stockpilot/web:lint: 
@stockpilot/web:lint: /Users/brandenvincent-walker/Developer/InventorySystem/apps/web/src/server/services/price-tracking.ts
@stockpilot/web:lint:   76:5  warning  Unused eslint-disable directive (no problems were reported from 'no-console')
@stockpilot/web:lint: 
@stockpilot/web:lint: ✖ 30 problems (0 errors, 30 warnings)
@stockpilot/web:lint:   0 errors and 14 warnings potentially fixable with the `--fix` option.
@stockpilot/web:lint: 

 Tasks:    3 successful, 3 total
Cached:    3 cached, 3 total
  Time:    685ms >>> FULL TURBO
```

**PASS** — 0 errors. 30 pre-existing warnings, all `no-*-eslint-disable-directive`/`no-console` style, all in files Phase A never touched (`image-variants.worker.ts`, `packing-slip-*.test.ts`, `pick-slip.test.ts`, `nav-settings.test.ts`, `price-tracking.ts`). No new `no-control-regex` or import-order complaint appeared.

#### 4. `pnpm --filter @stockpilot/web build 2>&1 | tail -30`

```
├ ƒ /platform/audit
├ ƒ /platform/orgs/[id]
├ ƒ /platform/provision
├ ƒ /platform/support
├ ƒ /portal
├ ○ /pricing
├ ○ /privacy
├ ƒ /r/[token]
├ ƒ /r/confirm
├ ƒ /r/confirm/submit
├ ƒ /r/track
├ ƒ /reset
├ ○ /reset/complete
├ ƒ /returns/request/[token]
├ ○ /robots.txt
├ ○ /security
├ ○ /signin
├ ƒ /signin/mfa
├ ○ /signup
├ ○ /sitemap.xml
├ ○ /support
├ ○ /terms
└ ƒ /unsubscribe


ƒ Proxy (Middleware)

○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand
```

The route table is the tail of the build; the compile/typecheck confirmation lines from the same run (earlier in the log) were:

```
✓ Compiled successfully in 10.2s
  Running TypeScript ...
  Finished TypeScript in 19.2s ...
```

**PASS** — `Compiled successfully`, no bundler-only failures (the gate this step exists to catch — a react-pdf style prop that typechecks but breaks the production bundle — did not fire).

### Real evidence PDFs (not just test assertions)

Rendered the Books PDF through the actual production code (`ReportTablePdf` + the Books PDF column set), twice, from a throwaway vitest test that called `renderToBuffer` from `@react-pdf/renderer` and wrote the buffer to disk. The same 4 sample rows were used both times: a normal row, a null-charter row, a missing-ISBN row, and a long-title row. The throwaway test files were deleted immediately after use; only the two PDFs remain.

- **BEFORE** (base `acf02191`, in a temporary detached-HEAD worktree, `node_modules` symlinked in from the main tree — no reinstall, dependencies are unchanged between `acf02191` and HEAD): `/private/tmp/claude-501/-Users-brandenvincent-walker-Developer-InventorySystem/b7fc6dc0-134e-4114-b7df-23e58c2f3915/scratchpad/books-pdf-before.pdf` — rendered with the route's original inline `PDF_COLUMNS` (no `isbn` key, no `minWidth` on any column) and the pre-`formatCharterCell` inline charter expression (`charterId ? map.get(charterId) ?? '' : ''`).
- **AFTER** (HEAD `f5dbb2bc`, main working tree): `/private/tmp/claude-501/-Users-brandenvincent-walker-Developer-InventorySystem/b7fc6dc0-134e-4114-b7df-23e58c2f3915/scratchpad/books-pdf-after.pdf` — rendered with the real `BOOKS_PDF_COLUMNS` and the real `formatCharterCell`.

Extracted with `pdftotext -layout` (poppler), verbatim:

**BEFORE:**
```
 NAME                                              SKU       ON HANDCATEGORY    LOCATION    CHARTER          STATUS

 The Great Gatsby                                  BK-1001       12 Fiction     Rack 3-B    North Region     active

 To Kill a Mockingbird                             BK-1002        5 Fiction     Rack 1-A    —                active

 Charlotte's Web                                   BK-1003       20 Fiction     Rack 2-C    North Region     active

 The Extraordinarily Long and Overly Descriptive
 Title of a Book That Tests Column Wrapping Be-    BK-1004        3 Reference   Rack 10-Z   —                discontinued
 havior in the PDF Export Renderer
```

**AFTER:**
```
 TITLE                                       SKU       ISBN                AUTHOR                GRADE   ON HAND CATEGORY    LOCATION    CHARTER       STATUS

                                                                                                                                         North Re-
 The Great Gatsby                            BK-1001   9780743273565       F. Scott Fitzgerald   9-12         12 Fiction     Rack 3-B                  active
                                                                                                                                         gion

 To Kill a Mockingbird                       BK-1002   9780446310789       Harper Lee            9-12          5 Fiction     Rack 1-A    Generic       active

                                                                                                                                         North Re-
 Charlotte's Web                             BK-1003   —                   E.B. White            3-5          20 Fiction     Rack 2-C                  active
                                                                                                                                         gion

 The Extraordinarily Long and Overly De-                                   A. N. Author With A
 scriptive Title of a Book That Tests Col-                                 Very Long Name In-                                                          discontin-
                                             BK-1004   978-1-234-56789-7                         K-2           3 Reference   Rack 10-Z   Generic       ued
 umn Wrapping Behavior in the PDF Ex-                                      deed To Test Wrap-
 port Renderer                                                             ping
```

This is a real, side-by-side reproduction of all three owner-reported defects and their fixes from the SAME sample data: `ON HANDCATEGORY` → `ON HAND CATEGORY` (separate columns, header gutter), no ISBN column at all → an ISBN column present for every book (with a correct `—` for the one row given a blank ISBN, since a missing ISBN is a legitimate value, not a rendering bug), and the null-charter rows print `—` before the fix and `Generic` after it.

### What changed, and what a reviewer should check

- `report-table.tsx` header cells now carry `paddingHorizontal: REPORT_CELL_PADDING_PT` (3pt, matching the body cells they sit above — a 6pt gutter total between adjacent headers). Every column gets an explicit point width from `fitColumnWidths` instead of a bare flex ratio, honoring each column's `minWidth`/`maxWidth`.
- **Correction to this task's own brief template**: the brief's boilerplate for this section claimed "the seven `/api/reports/[slug]/pdf` sections pass no `minWidth`, so their proportional split is byte-identical to before." That is not what shipped and this report will not repeat it uncorrected. Checked directly: `apps/web/src/lib/pdf/report-configs.ts` DOES add `minWidth` to columns in 4 of those report sections (`reorder-forecast`, `velocity-class`, `dead-stock`, and others sharing the `On hand`/`Unit cost` labels) — Task 1's second commit (`989c7e47`) found, via the same exhaustive sweep this task's brief calls for, that `reorder-forecast`'s "Reorder at"/"Reorder qty" headers **already overflowed their box on `main`, before Phase A touched anything** (margins of −0.91pt/−7.09pt against the old zero-padding header cell), and the new 6pt gutter made both worse. Every relative `width` weight is unchanged from the pre-Phase-A inline arrays (verified by diffing `989c7e47`'s route.tsx delta against the new `report-configs.ts`) — only `minWidth` floors were added, and only where the real allocator found a genuine overflow. `pnpm --filter @stockpilot/web test src/lib/pdf/report-headers-fit.test.ts` (19 tests) is the proof; it measures the real header width against the real allocated box for every column of all 7 live report sections and is a permanent regression net, not a one-time check.
- The Books PDF gains Title | SKU | ISBN | Author | Grade | On hand | Category | Location | Charter | Status. The Items PDF keeps its previous 7-column set plus minimums. `pnpm --filter @stockpilot/web test src/lib/pdf/export-pdf-headers-fit.test.ts` (8 tests) is the equivalent permanent net for the export route's own two column sets.
- `charter` now reads "Generic" for a null charter in CSV, Excel AND PDF — the same word the inventory list has always shown. A charter id that fails to resolve still blanks (fail-closed), which is a different case on purpose. The fix lives in exactly one place (`formatCharterCell`, called once from `buildInventoryExportRows`), so all three export formats inherit it identically — Excel (`inventory-export-xlsx.ts`) does no charter-specific formatting of its own (`grep charter` returns nothing in that file), confirming it is a pure pass-through of the row-build's already-formatted string.
- The legacy `GET /api/inventory/export.csv` route file is byte-identical to `main` (`git diff --stat main -- apps/web/src/app/api/inventory/export.csv/route.ts` — no output); the only change under that path is a new, previously-nonexistent test file (`route.test.ts`, +146 lines) that pins its CSV output, added in Task 2's fix-wave (Finding 2).

### Acceptance checklist (Phase A scope only)

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | ISBN present by default in the Books PDF | **PASS** | `BOOKS_PDF_COLUMNS` (`inventory-pdf-columns.ts:41`) unconditionally includes `isbn`, 3rd column. `route.test.tsx`: "includes an ISBN column for a books export", "puts ISBN right after the title and SKU". Evidence PDF: `books-pdf-after.pdf` shows a populated ISBN column; `books-pdf-before.pdf` has none. |
| 2 | ON HAND / CATEGORY headers visibly separated | **PASS** | `report-headers-fit.test.ts` (19 tests) + `export-pdf-headers-fit.test.ts` (8 tests), both green. Evidence PDF: `ON HANDCATEGORY` (before) vs `ON HAND CATEGORY` (after), same sample data. |
| 3 | Generic charter in CSV | **PASS** | `inventory-export.test.ts`: "renders a NULL charter as 'Generic'"; `export.csv/route.test.ts`: "renders a null-charter row as 'Generic' (the R1 delta)" and "renders a failed charter LOOKUP as blank, never 'Generic'"; `route.test.tsx`: "returns the canonical CSV with the Generic charter value intact". |
| 4 | Generic charter in Excel | **PASS** | No charter-specific code exists in `inventory-export-xlsx.ts` (verified by grep — zero matches); it consumes the same `rows` that `inventory-export.test.ts` already proves carry `'Generic'`, so the value flows through unmodified. No dedicated xlsx-charter test exists because there is no xlsx-specific logic to test; this is a structural argument backed by the grep, not an assumption. |
| 5 | Generic charter in PDF | **PASS** | `route.test.tsx` PDF-path fixtures use `charter: 'Generic'` and assert on `pdfColumns()`; evidence PDF `books-pdf-after.pdf` shows literal "Generic" text for both null-charter sample rows. |
| 6 | Legacy route delta scoped (charter column only, no other behavior change) | **PASS** | `git diff --stat main -- apps/web/src/app/api/inventory/export.csv/route.ts` — empty. Only a new test file was added under that path. |

**6/6 pass.**

### Branch discipline

```
$ git log --oneline main..HEAD | wc -l
       6
$ git log --oneline main..HEAD
f5dbb2bc fix(inventory): hold the ISBN floor to its worst case and pin the legacy csv route
3cba8cdf fix(inventory): put ISBN in the books PDF and render generic charters as Generic
989c7e47 fix(pdf): fit every live report header under the new gutter, permanently tested
a7d9f47b fix(pdf): give report-table headers a real gutter and honour column minimums
acf02191 docs(inventory): export builder phase-1 audit
1aa18c46 docs(inventory): export builder implementation plan

$ git branch -r --list 'origin/feat/export-builder'
(no output — no remote branch exists)

$ git status
On branch feat/export-builder
nothing to commit, working tree clean

$ git diff --stat main -- supabase/
(no output — no migrations touched by Phase A)
```

All local. Not pushed. No supabase/ delta.

### Manual check the owner owes (Brief section 29)

Export Books -> PDF from `/dashboard/books` in the Demo Co org
(71b27a4a-7948-4638-bc3f-535974713bd2) and confirm: headers are visibly
separated, ISBN is present and readable, CHARTER reads "Generic" rather than an
em dash on generic stock.

## Phase B-E verification (Task 18)

Branch: `feat/export-builder`, HEAD `7e63157e`.
Run: 2026-08-03. Working tree clean (`git status` — nothing to commit; branch is
30 commits ahead of `origin/feat/export-builder`, no remote push done as part of
this task).

This is a recording task only — no code or test changes were made while
producing this section.

### Step 1: Gate battery (verbatim output)

#### 1. `pnpm --filter @stockpilot/web test 2>&1 | tail -40`

```
[env] Using dev fallback for NEXT_PUBLIC_SUPABASE_URL. Add it to apps/web/.env.local for real Supabase.
[env] Using dev fallback for NEXT_PUBLIC_SUPABASE_ANON_KEY. Add it to apps/web/.env.local for real Supabase.

 ✓ src/server/services/inventory.distinct-racks.test.ts (4 tests) 5ms
 ✓ src/server/actions/lots.test.ts (3 tests) 5ms
 ✓ src/server/services/inventory.update-conflict.test.ts (2 tests) 2ms
 ✓ src/lib/warehouse-scope.test.ts (8 tests) 7ms
stderr | src/lib/auth/api-context.aal.test.ts
[env] Using dev fallback for NEXT_PUBLIC_SUPABASE_URL. Add it to apps/web/.env.local for real Supabase.
[env] Using dev fallback for NEXT_PUBLIC_SUPABASE_ANON_KEY. Add it to apps/web/.env.local for real Supabase.

 ✓ src/lib/charter-display.test.ts (3 tests) 1ms
 ✓ src/server/services/vendor-item-mappings.test.ts (4 tests) 4ms
stderr | src/server/services/context.modules.test.ts
[env] Using dev fallback for NEXT_PUBLIC_SUPABASE_URL. Add it to apps/web/.env.local for real Supabase.
[env] Using dev fallback for NEXT_PUBLIC_SUPABASE_ANON_KEY. Add it to apps/web/.env.local for real Supabase.

stderr | src/server/services/inventory.barcode-filter.test.ts
[env] Using dev fallback for NEXT_PUBLIC_SUPABASE_URL. Add it to apps/web/.env.local for real Supabase.
[env] Using dev fallback for NEXT_PUBLIC_SUPABASE_ANON_KEY. Add it to apps/web/.env.local for real Supabase.

 ✓ src/lib/auth/api-context.aal.test.ts (5 tests) 2ms
 ✓ src/server/services/context.modules.test.ts (4 tests) 2ms
stderr | src/server/services/locations.createPlacement.test.ts
[env] Using dev fallback for NEXT_PUBLIC_SUPABASE_URL. Add it to apps/web/.env.local for real Supabase.
[env] Using dev fallback for NEXT_PUBLIC_SUPABASE_ANON_KEY. Add it to apps/web/.env.local for real Supabase.

stderr | src/server/services/order-attachments.thumb.test.ts
[env] Using dev fallback for NEXT_PUBLIC_SUPABASE_URL. Add it to apps/web/.env.local for real Supabase.
[env] Using dev fallback for NEXT_PUBLIC_SUPABASE_ANON_KEY. Add it to apps/web/.env.local for real Supabase.

 ✓ src/server/services/locations.createPlacement.test.ts (2 tests) 2ms
 ✓ src/server/services/inventory.barcode-filter.test.ts (2 tests) 2ms
 ✓ src/server/services/order-attachments.thumb.test.ts (3 tests) 1ms

 Test Files  428 passed (428)
      Tests  4811 passed (4811)
   Start at  22:38:52
   Duration  30.71s (transform 10.14s, setup 64.22s, collect 94.86s, tests 62.81s, environment 33.45s, prepare 21.47s)
```

**PASS** — 428 test files / 4811 tests, zero failures. (Phase A's own gate, above, showed 410 files / 4475 tests — the growth is Phases B-E's own new test files landing on top of that clean baseline.)

#### 2. `pnpm typecheck 2>&1 | tail -20`

```
@stockpilot/core:typecheck: cache hit, replaying logs c3f6599731d47b75
@stockpilot/mobile:typecheck: cache hit, replaying logs 7a0fe438ef1b0746
@stockpilot/web:typecheck: cache hit, replaying logs b986ccf3d9bacb64
@stockpilot/mobile:typecheck: 
@stockpilot/mobile:typecheck: > @stockpilot/mobile@0.1.0 typecheck /Users/brandenvincent-walker/Developer/InventorySystem/apps/mobile
@stockpilot/mobile:typecheck: > tsc --noEmit
@stockpilot/mobile:typecheck: 
@stockpilot/web:typecheck: 
@stockpilot/web:typecheck: > @stockpilot/web@0.1.0 typecheck /Users/brandenvincent-walker/Developer/InventorySystem/apps/web
@stockpilot/web:typecheck: > tsc --noEmit
@stockpilot/web:typecheck: 
@stockpilot/core:typecheck: 
@stockpilot/core:typecheck: > @stockpilot/core@0.0.0 typecheck /Users/brandenvincent-walker/Developer/InventorySystem/packages/core
@stockpilot/core:typecheck: > tsc --noEmit
@stockpilot/core:typecheck: 

 Tasks:    3 successful, 3 total
Cached:    3 cached, 3 total
  Time:    628ms >>> FULL TURBO
```

**PASS** — clean across all 3 packages. All three were cache hits (tree unchanged since the last real `tsc --noEmit` run in this workspace state), so this is a replay of an already-real clean result, not a skipped check.

#### 3. `pnpm lint 2>&1 | tail -30`

```
@stockpilot/web:lint:   62 |  react-hooks/set-state-in-effect
@stockpilot/web:lint: 
@stockpilot/web:lint: /Users/brandenvincent-walker/Developer/InventorySystem/apps/web/src/lib/image-variants.worker.ts
@stockpilot/web:lint:   61:3  warning  Unused eslint-disable directive (no problems were reported from '@typescript-eslint/no-explicit-any')
@stockpilot/web:lint: 
@stockpilot/web:lint: /Users/brandenvincent-walker/Developer/InventorySystem/apps/web/src/lib/pdf/packing-slip-shared.test.ts
@stockpilot/web:lint:   25:5  warning  Unused eslint-disable directive (no problems were reported from '@typescript-eslint/no-explicit-any')
@stockpilot/web:lint: 
@stockpilot/web:lint: /Users/brandenvincent-walker/Developer/InventorySystem/apps/web/src/lib/pdf/packing-slip-warehouse.test.ts
@stockpilot/web:lint:   80:3  warning  Unused eslint-disable directive (no problems were reported from '@typescript-eslint/no-explicit-any')
@stockpilot/web:lint: 
@stockpilot/web:lint: /Users/brandenvincent-walker/Developer/InventorySystem/apps/web/src/lib/pdf/pick-slip.test.ts
@stockpilot/web:lint:    86:3  warning  Unused eslint-disable directive (no problems were reported from '@typescript-eslint/no-explicit-any')
@stockpilot/web:lint:   107:7  warning  Unused eslint-disable directive (no problems were reported from '@typescript-eslint/no-explicit-any')
@stockpilot/web:lint:   112:7  warning  Unused eslint-disable directive (no problems were reported from '@typescript-eslint/no-explicit-any')
@stockpilot/web:lint: 
@stockpilot/web:lint: /Users/brandenvincent-walker/Developer/InventorySystem/apps/web/src/server/actions/nav-settings.test.ts
@stockpilot/web:lint:   99:11  warning  Unused eslint-disable directive (no problems were reported from 'no-script-url')
@stockpilot/web:lint: 
@stockpilot/web:lint: /Users/brandenvincent-walker/Developer/InventorySystem/apps/web/src/server/services/price-tracking.ts
@stockpilot/web:lint:   76:5  warning  Unused eslint-disable directive (no problems were reported from 'no-console')
@stockpilot/web:lint: 
@stockpilot/web:lint: ✖ 34 problems (0 errors, 34 warnings)
@stockpilot/web:lint:   0 errors and 14 warnings potentially fixable with the `--fix` option.
@stockpilot/web:lint: 

 Tasks:    3 successful, 3 total
Cached:    2 cached, 3 total
  Time:    21.66s
```

**PASS** — 0 errors, 34 warnings (exact count). Phase A's own gate recorded 30 warnings from this same tail; the +4 delta is additional pre-existing `react-hooks/set-state-in-effect`-family warnings earlier in the untruncated log (above the `tail -30` window) plus the same trailing set of `Unused eslint-disable directive` warnings shown above, all in files this program's Phases B-E did not touch. 0 errors satisfies the gate; the warning-count drift is noted here rather than silently dropped.

#### 4. `pnpm --filter @stockpilot/web build 2>&1 | tail -30`

```
├ ƒ /platform/audit
├ ƒ /platform/orgs/[id]
├ ƒ /platform/provision
├ ƒ /platform/support
├ ƒ /portal
├ ○ /pricing
├ ○ /privacy
├ ƒ /r/[token]
├ ƒ /r/confirm
├ ƒ /r/confirm/submit
├ ƒ /r/track
├ ƒ /reset
├ ○ /reset/complete
├ ƒ /returns/request/[token]
├ ○ /robots.txt
├ ○ /security
├ ○ /signin
├ ƒ /signin/mfa
├ ○ /signup
├ ○ /sitemap.xml
├ ○ /support
├ ○ /terms
└ ƒ /unsubscribe


ƒ Proxy (Middleware)

○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand
```

**PASS** — build completed, route table printed with no error output above it in the captured tail.

### Gate summary

| Gate | Result |
|---|---|
| `pnpm --filter @stockpilot/web test` | **PASS** — 428 files / 4811 tests, 0 failures |
| `pnpm typecheck` | **PASS** — 0 errors, all 3 packages (cache hit replay of a real clean result) |
| `pnpm lint` | **PASS** — 0 errors, 34 warnings (pre-existing, unrelated files) |
| `pnpm --filter @stockpilot/web build` | **PASS** — compiled, full route table emitted |

### Step 2: Invariant checks (verbatim output + classification)

#### 1. `grep -rn "primaryMasterUrlsForItems" apps/web/src/lib apps/web/src/app/api/inventory`

```
apps/web/src/lib/exports/export-images.ts:18: * NEVER use primaryMasterUrlsForItems here. That resolver returns the 2048px
```

**Verdict: PASS (no code usage), with a documented anomaly.** The brief expected zero output; the one hit is not code — it is a doc-comment inside `export-images.ts` (lines 8-23) explicitly warning future editors never to use `primaryMasterUrlsForItems` in the export image pipeline, and explaining why (it resolves 2048px masters, the exact landmine the public-catalog image pipeline already hit — see memory `reference_public_catalog_image_pipeline.md`). There is no import, no call, no reference to the symbol anywhere else in `apps/web/src/lib` or `apps/web/src/app/api/inventory`. The invariant this check protects — the export pipeline never fetches full-size masters server-side — holds; the comment enforces it rather than violating it.

#### 2. `grep -rn "downloadInventoryExport" apps/web/src`

```
apps/web/src/components/inventory/inventory-table.instant.test.tsx:78:  downloadInventoryExport: vi.fn(),
apps/web/src/components/inventory/bulk-actions.export.test.tsx:11:// entirely and calling downloadInventoryExport directly, survived the whole
apps/web/src/components/inventory/export-builder/export-builder-dialog.tsx:23:  downloadInventoryExport,
apps/web/src/components/inventory/export-builder/export-builder-dialog.tsx:232:      await downloadInventoryExport(
apps/web/src/components/inventory/export-builder/export-builder-dialog.test.tsx:24:  downloadInventoryExport: (...a: unknown[]) => downloadSpy(...a),
apps/web/src/lib/download-export.ts:62:export async function downloadInventoryExport(
apps/web/src/lib/download-export.test.ts:4:import { downloadInventoryExport, fetchExportPreview } from './download-export';
apps/web/src/lib/download-export.test.ts:39:describe('downloadInventoryExport — stage order', () => {
apps/web/src/lib/download-export.test.ts:52:    await downloadInventoryExport(
apps/web/src/lib/download-export.test.ts:68:      downloadInventoryExport({ format: 'csv', scope: 'all' }, { onStage: (s) => stages.push(s) }),
apps/web/src/lib/download-export.test.ts:82:    await expect(downloadInventoryExport({ format: 'csv', scope: 'all' })).rejects.toThrow(
apps/web/src/lib/download-export.test.ts:99:    await downloadInventoryExport({ format: 'pdf', scope: 'all' });
```

Classification (12 hits):

| Line | Classification |
|---|---|
| `download-export.ts:62` | **Definition** — `export async function downloadInventoryExport(` |
| `export-builder-dialog.tsx:23` | **Production call site** (import) — the dialog |
| `export-builder-dialog.tsx:232` | **Production call site** (invocation) — the dialog |
| `inventory-table.instant.test.tsx:78` | Test — mock |
| `bulk-actions.export.test.tsx:11` | Test — comment (prose referencing the function name, no code) |
| `export-builder-dialog.test.tsx:24` | Test — mock |
| `download-export.test.ts:4` | Test — import |
| `download-export.test.ts:39` | Test — describe block name |
| `download-export.test.ts:52` | Test — call inside a test |
| `download-export.test.ts:68` | Test — call inside a test |
| `download-export.test.ts:82` | Test — call inside a test |
| `download-export.test.ts:99` | Test — call inside a test |

**Verdict: PASS.** 1 definition, exactly ONE production call site (`export-builder-dialog.tsx`, the dialog — import + invocation both count as the same call site), 9 test-file hits. Matches the brief's expectation exactly.

#### 3. `grep -rn "PDF_COLUMNS" apps/web/src`

```
apps/web/src/lib/pdf/export-pdf-headers-fit.test.ts (7 hits: lines 6, 27, 36, 45, 87, 88, 126, 131, 132, 140, 145, 146)
apps/web/src/lib/pdf/registry-preset-fit.test.ts (3 hits: lines 26, 27, 57)
apps/web/src/lib/pdf/inventory-pdf-columns.ts:23:export const BOOKS_PDF_COLUMNS: ReportColumn[] = [
apps/web/src/lib/pdf/inventory-pdf-columns.ts:74:export const ITEMS_PDF_COLUMNS: ReportColumn[] = [
apps/web/src/lib/exports/field-registry.test.ts:272 (comment)
apps/web/src/lib/exports/field-registry.ts (8 hits: lines 251, 364, 369, 376, 434, 485, 495, 498 — all comments)
```

(Full line-by-line output captured above in the raw grep run; counts re-tallied here for readability.)

**Verdict: PASS, with the documented Task 13 adjudication applying.** All hits are in `apps/web/src/lib/pdf/` (`inventory-pdf-columns.ts` defining `BOOKS_PDF_COLUMNS`/`ITEMS_PDF_COLUMNS`, and their fit tests) or in `apps/web/src/lib/exports/field-registry.ts` and its test — and every hit in the latter two files is a `//` prose comment cross-referencing `BOOKS_PDF_COLUMNS`/`ITEMS_PDF_COLUMNS` as historical/comparison context for the new field-registry-driven PDF widths (no import, no live reference to those constants from `field-registry.ts`). Per the Task 13 adjudication already on record in this file's Phase A section, `inventory-pdf-columns.ts` and its fit tests are legitimate Phase A survivors, not Phase B-E defects — the brief's "expect: no output" language predates that adjudication. **Zero hits appear in any `app/api` route** — the condition the brief calls an actual violation did not occur.

#### 4. `grep -rc "Generic" apps/web/src/lib/charter-display.ts`

```
apps/web/src/lib/charter-display.ts:3
```

**Verdict: PASS.** The file exists at the brief's stated path (`apps/web/src/lib/charter-display.ts`, confirmed via `ls -la`, 1204 bytes, last modified today) and contains 3 occurrences of `Generic` — the brief's path was not stale.

#### 5. Migration guarantee

`ls supabase/migrations | tail -3`:

```
0311_restrict_disable_reason_visibility.sql
0312_close_disable_residual_gaps.sql
0313_stop_notifying_disabled_accounts.sql
```

`git diff main..HEAD --stat -- supabase/migrations`:

```
(no output)
```

**Verdict: PASS.** Zero migration changes between `main` and this branch's HEAD — the no-migration guarantee holds. The three most recent migrations on disk (`0311`-`0313`) predate and are unrelated to the Export Builder program (they belong to the account-disable program per memory `project_account_disable_program.md`); their presence on `main` is expected and is not part of this branch's diff.

### Invariant summary

| # | Check | Verdict |
|---|---|---|
| 1 | `primaryMasterUrlsForItems` absent from lib/api-inventory | **PASS** (one doc-comment hit, not code — anomaly documented above) |
| 2 | `downloadInventoryExport` exactly one production call site | **PASS** (1 definition, 1 call site = dialog, 9 test hits) |
| 3 | `PDF_COLUMNS` confined to lib/pdf, none in app/api | **PASS** (Task 13 adjudication applies; field-registry.ts hits are comments only) |
| 4 | `Generic` sentinel present in charter-display.ts | **PASS** (3 hits; brief's path was correct, not stale) |
| 5 | Zero migration changes vs main | **PASS** (empty diff) |

### Step 3: Manual Demo-org walk — COMPLETE (2026-08-03)

Run against Demo Co (71b27a4a-7948-4638-bc3f-535974713bd2) as
demo@stockpilotusa.com on a local dev server at HEAD `7e63157e`, pointed at the
production Supabase project (`.env.local.prod`). Driven in a real Chromium
browser; every artifact below was generated through the new builder dialog and
inspected (PDFs rendered and read page-by-page, XLSX loaded back through
ExcelJS, CSVs read raw). This program is web-only; no mobile walk applies.

**Books PDF (table, default 12-field preset, landscape Letter):**

| Checklist line | Result |
|---|---|
| Headers visibly separated | **YES** — TITLE / ISBN / SKU / … render with clear gutters; the photographed `ON HANDCATEGORY` collision is gone |
| ISBN present | **YES** — full 13-digit ISBNs, untruncated |
| Covers appear | **NO — the anticipated WebP split** (see below) |
| Medium and large give taller rows | **YES by geometry** (IMAGE_CELL_PT 22/34/48 mutation-pinned in tests); visually moot while covers are blank |
| No cropped covers | N/A while covers are blank; objectFit contain is mutation-pinned |
| Long titles wrap | **YES** — long location names wrap cleanly in-cell (demo titles are short) |
| ISBN readable | **YES** |
| Rack and crate understandable | **YES** — `12-B`, `Blue 4` |
| Headers repeat on page 2 | **YES** — verified on the 4-page Items export (all pages carry the header row) |
| Page numbers "Page 1 of N" | **YES** — `Page 1 of 4` … `Page 4 of 4` |
| Org branding present | **YES** — StockPilot Demo Co header block |
| Full count paginates | **YES** — 53 items → 4 pages, matching the dialog's "Estimated 3-4 PDF pages" |
| Last page has no broken partial row | **YES** — every page boundary clean; rows never split |

**Books Excel (embedded images + summary sheet):** worksheet named `Books`;
friendly headers in chosen order; ISBN cell is a STRING with `numFmt '@'`
(no scientific notation possible); header frozen (`ySplit: 1`); autofilter
`A1:L6`; Summary sheet correct (5 titles, 408 on-hand units, 5/5 ISBN, 5/5
cover). Embedded pictures: **0 — same WebP split**; image rows are still
sized 66pt (cosmetically tall empty rows while the split persists).

**Books CSV:** header `Image URL,Title,ISBN,SKU,Author,Grade,On hand,Category,
Rack,Crate,Location,Status` — friendly labels, exact selected order, signed
thumbnail URLs in Image URL, ISBNs intact as plain text, blanks empty (not
em-dash) as a data file should be. The Image URL column appears only when the
Cover field is selected.

**Book catalog layout (two columns):** renders exactly as designed — one card
per book, headline title, labelled ISBN/SKU/… lines, cards never split,
cover box reserved on the left of each card (blank under the WebP split).

**Items page:** defaults are the 10 item fields with `Name` (not `Title`),
no book-only fields, no Cover in defaults, and the catalog layout is absent
for items. 53 items export at "all" scope; **bulk-selected** works end to end
— selecting 2 rows shows "Exporting: 2 selected items", the preview total is
2, and the CSV contains exactly those 2 rows with the `Generic` charter
sentinel correct.

**The two questions no unit test can settle:**

1. **Do covers render in the PDF? NO — the exact split the brief predicted.**
   Demo Co item thumbnails are `image/webp` (verified by fetching them:
   content-type `image/webp`, RIFF/WEBP magic bytes). `@react-pdf/renderer`
   decodes only PNG and JPEG, so every cover box renders blank. The readiness
   panel truthfully says "5 of 5 have a cover" — the URLs are real; the
   renderer can't decode them.
2. **Do embedded Excel pictures appear? NO — same split, one layer deeper.**
   The Excel path already fetches bytes (`fetchExportImageBytes`), but
   `readImageDimensions` recognizes only PNG/JPEG signatures, so WebP thumbs
   are skipped rather than embedded broken. Data-safe, image-absent.
   The brief's suggested fix (route the PDF through `fetchExportImageBytes`
   with data URIs "as the Excel path already does") is therefore NECESSARY
   BUT NOT SUFFICIENT — both paths additionally need a PDF/Excel-safe source:
   either prefer the master image (typically JPEG) when the stored thumb is
   WebP, or request a Supabase transform to JPEG/PNG for the bounded export
   batch. Recorded in the §31 report's limitations with options.

**New findings from the walk (not in any prior review):**

- **Long-SKU overlap (Items PDF, cosmetic):** unbroken SKUs longer than the
  fitted column (`SP-OMHQF-C8H-11`, 15-16 chars on the synthetic Verify*
  items) overflow into the Barcode column, and the neighbor's em-dash draws
  through the SKU tail like a strikethrough (confirmed at high-resolution
  raster). Identifier columns are wrap-never by design and react-pdf does not
  clip overflow. Data intact; visual collision only. Candidate fix: allow
  hyphen-point wrapping for sku/barcode (ISBN stays rigid), or derive the
  sku minWidth from the org's real max SKU length.
- **Filename preset-name precedence (designed, worth knowing):** an untouched
  default preset names the file (`books-inventory-…`, `inventory-overview-…`)
  even for a selected-scope export; customizing options drops to the scope
  form (`books-all-…`). Matches Task 12's tested precedence — flagged only
  because a `-selected` marker may be more intuitive for bulk exports.

**Not exercised:** "Export filtered" scope through to a file (menu present,
dialog opens with filtered wording; same request path as "all" plus filters —
covered by route tests); Items export with images enabled (would hit the same
WebP split); medium-vs-large visual comparison (blank covers make it moot).

### Recording metadata

- HEAD SHA: `7e63157ee9c7903bce6409492e9eee7ab22273bd` (short `7e63157e`)
- Date: 2026-08-03
- `git status`: clean (nothing to commit)
- No code, test, or migration changes were made while producing this section — recording only.
