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
