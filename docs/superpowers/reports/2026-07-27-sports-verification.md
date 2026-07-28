# Sports inventory program — verification report

Branch `feat/sports-model-p2` @ `11a1cc55`, 36 commits off `09dfb52a`.
Plan: `docs/superpowers/plans/2026-07-27-sports-inventory-phases-2-7.md` (Tasks
1-20). Requirements: `docs/superpowers/specs/2026-07-27-sports-inventory-requirements.md`.

**Status: LOCAL ONLY.** Migrations `0294`-`0303` are applied to the local
database and green under pgTAP. Nothing has been pushed to production, no web
deploy has happened, no OTA has been published, and no line of the Demo Co
checklists below has been executed. Every unchecked box in sections 4 and 5 is
owner-gated on the production migration push and is recorded as NOT DONE, not as
passing.

This report records real results only. Where a result does not exist yet it says
so.

---

## 1. Per-task test evolution (real, recorded at each task's completion)

Every row is the gate state at the moment that task was accepted, taken from the
SDD ledger `.superpowers/sdd/progress.md`. "web" counts are `files/tests` where
both were recorded.

| Task | Commits | pgTAP | web vitest | core | mobile | Notes |
|---|---|---|---|---|---|---|
| 1 — tracking-mode vocabulary | `09dfb52a..988838a1` | — | — | 382/382 | — | typecheck clean on all packages |
| 2 — 0294 category profiles + size scales | `988838a1..aca2a3aa` | 0294 31/31; suite 91 files/1066 | — | — | — | 3 plan bugs fixed with evidence; SECURITY fix (both resolver fns were SECURITY DEFINER with PUBLIC EXECUTE — anon could read a foreign org's tracking mode over PostgREST; proven live, revoked, pgTAP asserts anon has no execute) |
| 3 — `serial_optional` + `post_receipt_v2` 6th rewrite | `647400e8`, `e1b363ae` | 0295 8/8, 0296 20/20; suite 93 files/1094 | 3359 | — | — | 2 hunks / 1 removed line verified against the live body; `none`/`lot`/`serial` provably unchanged; 17 `tracking_type` enumerator sites |
| 4 — `sports` module + `sports:manage` | `8deab870` | suite 94 files/1101 | 3359 | 382 | 632 | 0207 permission count 109 -> 111; review found ZERO issues |
| 5 — 0298 `product_groups` + variant columns | `ba75d5f2`, `c94d9787` | 0298 51/51; suite 95 files/1152 | — | — | — | 4 plan bugs fixed with mutation proof (missing `security_invoker`; missing WITH CHECK arms; RLS asymmetry on category-restricted viewers; partial `group_id` index unusable by the FK RI probe) |
| 6 — 0299 `duplicate_inventory_item` | `38e17a45` | 0299 47/47 incl. 4 mutation tests; suite 96 files/1199 | — | — | — | 5-hunk delta over live 0125, no drift; review found ZERO issues |
| 7 — key builders + shared zod | `f90c8fd2`, `43fc4ee1`, `c8456370` | suite 96 files/1200 | 343/3361 | 443/443 | — | **CRITICAL**: delimiter injection forged colliding keys (`'10\|width=w'` == `{size:'10',width:'w'}`); fixed with injective escaping + 15 adversarial/property tests, then chased through all three remaining layers |
| 8 — services + profile resolution + 0300 | `d96a9cf7`, `10d66e14` | suite 97 files/1210 | 346/3444 | 443 | 632 | 4 Important + 5 Minor all fixed; per-request `org:categoryId` memoization audited across ~25 call sites |
| 9 — `POST /api/v1/items` | `3df7e97a` | — | 347/3453 | — | — | Review found ZERO issues |
| 10 — mobile Add Item parity fix | `5dac7590`, `0034ba6f` | suite 97 files/1210 | 3463 | 448 | 697 | Client fan-out deleted; initial stock now lands Unplaced not Staging (double-count removed); sim-verified render in Demo Co |
| 11 — web Add Item + grouping preview | `1b2a1e76`, `ecb764c4` | suite 97 files/1210 | 351/3498 | 449 | 697 | Preview identity aligned to the server key with `playerName` OMITTED |
| 12 — subcategories + profile admin | `928a15e7`, `afc5863f` | suite 97 files/1210 | 353/3536 | 449 | 697 | **CRITICAL**: guard judged input-presence, so a nullable bypass poisoned categories into `SPORTS_SUBCATEGORY_REQUIRED` and blocked all receiving; now judges MERGED ROW STATE |
| 13 — 0301 import line columns + `PO_SCHEMA` | `b1b3fb5a`, `782621e2` | 0301 26/26; suite 98 files/1236 | 3556 | 456 | 697 | `jersey_number` verified string end-to-end — a numeric `7` from the model is DROPPED, not stringified. Chassis untouched (`dedupe.ts` byte-identical) |
| 14 — group-first matching + review modal | `e5e360bc`, `f432e77c` | 0301 30/30 (adds `serial_hint`); suite 98 files/1240 | 361/3622 | 467 | 697 | **CRITICAL**: `create_new_group` lines forked groups; fixed so one group is find-or-created (R2 e2e: 1 group / 3 items / 3 keys) |
| 15 — idempotency + e2e scenarios | `4f1abf03` | suite 98 files/1240 | 363/3634 | 467 | 697 | Re-entrancy mutation-proven; race converges to ONE group through the REAL 23505 re-read (reviewer deleted it to prove); R1/R2/R3 + cross-group/mixed-CSV/ambiguous-Number |
| 16 — size-run receiving | `1f48e3c4`, `bf73ca24` | suite 98 files/1240 | 367/3671 | 489 | 709 | Receiving seam UNTOUCHED (probe: original line order, exact 7-field key set); over-receipt still allowed; R1 blank-serial still blocks inside a run |
| 17 — variant cycle counts + 0302 re-key | `3910dcab`, `81042d86` | 0302 14; suite 99 files/1254 | 370/3704 | 496 | 720 | Instant Size Count stays REVIEW-ONLY (zero stock writes); 0282 takeover-exploit surface never reopened (policy diff verified live via `pg_policy`) |
| 18 — roll-ups + opt-in linking tool | `5041f303`, `21be6b1c` | suite 99 files/1254 | 373/3765 | 505 | 726 | Explicit item ids ONLY, no filter-bulk anywhere; `VARIANT_ALREADY_EXISTS` on cross-SKU same-key collision, and `force` CANNOT bypass it |
| 19 — 0303 backfill + dual-write | `08d0e945`, `11a1cc55` | 0303 31; suite **100 files/1285** | 374/3782 | 507 | 726 | ANTI-INFERENCE PROVEN: `group_id` NULL for every backfilled row, asserted twice; `custom_fields` never mutated; qoh unchanged; zero movements; xmin-proven idempotent no-op re-run |

Independent check of the final pgTAP figure: summing every `select plan(N)` across
`supabase/tests/*.sql` gives **1285 assertions across 100 files**, which matches
Task 19's recorded number.

Review outcomes: 20 tasks, every one reviewed. Three CRITICAL findings (Tasks 7,
12, 14) and one security finding (Task 2), all fixed with a re-review, plus one
Critical pair in the unrelated B2B branch that preceded this work. Six tasks
were approved on the first pass with zero findings (4, 6, 9, and the fix
re-reviews of 13 and 15).

---

## 2. Final local gate

Final run 2026-07-28, at branch head `040993ae` (after the whole-branch review
fix waves A/B/C and the compensation follow-up):

```
  supabase db reset && pnpm db:test   -> Files=100, Tests=1302, Result: PASS
  pnpm test                            -> core 526/35 files, mobile 726/36,
                                          web 3873/377 — all passed, Tasks 3/3
  pnpm typecheck                       -> Tasks: 3 successful, 3 total (clean)
  pnpm lint                            -> 0 errors (28 pre-existing warnings),
                                          Tasks: 3 successful, 3 total
```

`pnpm typecheck` is the only thing that proves no `tracking_type` enumerator
site was missed, because `apps/web/src/types/database.ts` is `any`.

`pnpm db:test` must be preceded by `supabase db reset` — a bare run executes
against a stale schema and reports false failures.

Lint note: the two `react/no-unescaped-entities` errors this branch inherited
from main (`apps/mobile/app/size-count/capture.tsx`,
`apps/mobile/app/zendesk/web.tsx`) were fixed here in `0bb9455d` so the gate
reads clean; both are one-character escapes in files the branch otherwise
never touched.

### Whole-branch review (final quality gate)

Run 2026-07-28 as a 40-agent workflow: 7 dimension reviewers over the full
`09dfb52a..0bb9455d` range, cross-dimension dedup, 2 adversarial refuters per
serious finding, and a completeness critic. Result: 16 serious findings, all
32 refuter verdicts UPHELD (zero refuted), 23 minors. All 16 serious findings
plus the actionable minors were fixed in three area-scoped commits
(`1b22ad6f` migrations, `4cc2c551` inventory/identity, `32f39f2e`
imports/UI/mobile) plus one follow-up (`040993ae`) closing a defect the
fix-wave re-review itself caught (failure-path compensation now zeroes seeded
`item_stock_levels` alongside `quantity_on_hand`). Every fix carried
red-first tests; the full gate above was re-run at the end. Deferred with
reasons (documented in `.superpowers/sdd/progress.md`): restore-point variant
identity, `vendor_product_number` in the import group key (owner question),
mobile group-scoped count start.

### GitHub CI

```
[PENDING — branch rollup not yet checked; the branch is unpushed]
```

CI has been a real gate since 2026-07-20. The branch's own rollup must be read,
not a neighbouring one. This cannot be green yet: `feat/sports-model-p2` has
never been pushed.

---

## 3. Files changed

36 commits, **197 files, 31766 insertions, 973 deletions**
(`git diff --stat 09dfb52a...11a1cc55`).

### Migrations (10) and their pgTAP (11 files, one pre-existing)

```
supabase/migrations/0294_category_tracking_profiles.sql
supabase/migrations/0295_tracking_type_serial_optional.sql
supabase/migrations/0296_post_receipt_v2_serial_optional.sql
supabase/migrations/0297_sports_module.sql
supabase/migrations/0298_product_groups_and_variants.sql
supabase/migrations/0299_duplicate_inventory_item_variants.sql
supabase/migrations/0300_product_group_org_immutable.sql
supabase/migrations/0301_po_import_line_variants.sql
supabase/migrations/0302_size_count_product_group.sql
supabase/migrations/0303_variant_size_backfill.sql
supabase/tests/0294_category_tracking_profiles.test.sql
supabase/tests/0295_tracking_type_serial_optional.test.sql
supabase/tests/0296_post_receipt_v2_serial_optional.test.sql
supabase/tests/0297_sports_module.test.sql
supabase/tests/0298_product_groups_and_variants.test.sql
supabase/tests/0299_duplicate_inventory_item_variants.test.sql
supabase/tests/0300_product_group_org_immutable.test.sql
supabase/tests/0301_po_import_line_variants.test.sql
supabase/tests/0302_size_count_product_group.test.sql
supabase/tests/0303_variant_size_backfill.test.sql
supabase/tests/0207_permission_overrides.test.sql        (count 109 -> 111)
```

### `packages/core` (20)

```
packages/core/src/constants/permissions.ts
packages/core/src/index.ts
packages/core/src/inventory/apparel-sizes.ts
packages/core/src/inventory/apparel-sizes.test.ts
packages/core/src/inventory/size-run.ts
packages/core/src/inventory/size-run.test.ts
packages/core/src/modules/registry.ts
packages/core/src/schemas/common.ts
packages/core/src/schemas/duplicate-item.ts
packages/core/src/schemas/index.ts
packages/core/src/schemas/inventory.ts
packages/core/src/schemas/inventory.test.ts
packages/core/src/schemas/po-imports.ts
packages/core/src/schemas/po-imports.test.ts
packages/core/src/schemas/receipts.ts
packages/core/src/schemas/schedule.ts
packages/core/src/schemas/sports.ts
packages/core/src/schemas/sports.test.ts
packages/core/src/sports/import-results.ts
packages/core/src/sports/import-results.test.ts
packages/core/src/sports/size-order.ts
packages/core/src/sports/size-order.test.ts
packages/core/src/sports/tracking-modes.ts
packages/core/src/sports/tracking-modes.test.ts
packages/core/src/sports/variant-keys.ts
packages/core/src/sports/variant-keys.test.ts
```

### `apps/web` — server services and actions

```
apps/web/src/server/services/audit.ts
apps/web/src/server/services/categories.ts
apps/web/src/server/services/categories.sports.test.ts
apps/web/src/server/services/context.ts
apps/web/src/server/services/cycle-counts.ts
apps/web/src/server/services/cycle-counts.group-scope.test.ts
apps/web/src/server/services/inventory.ts
apps/web/src/server/services/inventory.test.ts
apps/web/src/server/services/inventory.bulk-create-sized.test.ts
apps/web/src/server/services/inventory.bulk-create-sized.sports.test.ts
apps/web/src/server/services/inventory.dual-write.test.ts
apps/web/src/server/services/inventory.duplicate.test.ts
apps/web/src/server/services/inventory.listGroupVariants.test.ts
apps/web/src/server/services/inventory.sports-create.test.ts
apps/web/src/server/services/order-requests.ts
apps/web/src/server/services/po-imports.ts
apps/web/src/server/services/po-imports-lines.ts
apps/web/src/server/services/po-imports-variants.ts
apps/web/src/server/services/po-imports-idempotency.test.ts
apps/web/src/server/services/po-imports-lines.group-create.test.ts
apps/web/src/server/services/po-imports-lines.variants.test.ts
apps/web/src/server/services/po-imports-sports.integration.test.ts
apps/web/src/server/services/po-imports-variants.test.ts
apps/web/src/server/services/po-imports.mapping-review.test.ts
apps/web/src/server/services/po-imports.variant-lines.test.ts
apps/web/src/server/services/product-groups.ts
apps/web/src/server/services/product-groups.test.ts
apps/web/src/server/services/product-group-linking.ts
apps/web/src/server/services/product-group-linking.test.ts
apps/web/src/server/services/rack-shape.inventory-guard.test.ts
apps/web/src/server/services/receiving.ts
apps/web/src/server/services/receiving.serial-optional.test.ts
apps/web/src/server/services/size-counts.ts
apps/web/src/server/services/size-counts.test.ts
apps/web/src/server/services/size-run-display.ts
apps/web/src/server/services/sports-profiles.ts
apps/web/src/server/services/sports-profiles.test.ts
apps/web/src/server/actions/categories.ts
apps/web/src/server/actions/cycle-counts.ts
apps/web/src/server/actions/import.ts
apps/web/src/server/actions/import.test.ts
apps/web/src/server/actions/inventory.ts
apps/web/src/server/actions/po-imports.ts
apps/web/src/server/actions/product-groups.ts
apps/web/src/server/actions/product-group-linking.ts
apps/web/src/server/loaders/inventory-list.ts
apps/web/src/server/loaders/inventory-list.test.ts
```

### `apps/web` — routes, pages and components

```
apps/web/src/app/api/v1/items/route.ts                      (new)
apps/web/src/app/api/v1/items/route.test.ts                 (new)
apps/web/src/app/api/v1/items/sized-variants/route.ts       (new)
apps/web/src/app/api/v1/items/sized-variants/route.test.ts  (new)
apps/web/src/app/api/v1/items/lookup/route.ts
apps/web/src/app/api/v1/items/lookup/route.test.ts
apps/web/src/app/api/v1/product-groups/route.ts             (new)
apps/web/src/app/api/v1/product-groups/[id]/variants/route.ts (new)
apps/web/src/app/api/v1/product-groups/linking/route.ts     (new)
apps/web/src/app/api/v1/product-groups/linking/route.test.ts (new)
apps/web/src/app/api/v1/cycle-counts/route.ts
apps/web/src/app/api/v1/size-counts/route.ts
apps/web/src/app/api/cycle-counts/[id]/pdf/route.tsx
apps/web/src/app/api/cycle-counts/[id]/pdf/route.test.ts
apps/web/src/app/api/po-imports/[id]/export.csv/route.test.ts
apps/web/src/app/(dashboard)/dashboard/product-groups/page.tsx        (new)
apps/web/src/app/(dashboard)/dashboard/product-groups/loading.tsx    (new)
apps/web/src/app/(dashboard)/dashboard/product-groups/link/page.tsx  (new)
apps/web/src/app/(dashboard)/dashboard/books/[id]/edit/page.tsx
apps/web/src/app/(dashboard)/dashboard/categories/page.tsx
apps/web/src/app/(dashboard)/dashboard/cycle-counts/new/page.tsx
apps/web/src/app/(dashboard)/dashboard/inventory/page.tsx
apps/web/src/app/(dashboard)/dashboard/inventory/new/page.tsx
apps/web/src/app/(dashboard)/dashboard/inventory/[id]/edit/page.tsx
apps/web/src/app/(dashboard)/dashboard/purchase-orders/new/page.tsx
apps/web/src/app/(dashboard)/dashboard/purchase-orders/[id]/page.tsx
apps/web/src/app/(dashboard)/dashboard/purchase-orders/[id]/edit/page.tsx
apps/web/src/app/(dashboard)/dashboard/purchase-orders/imports/[id]/page.tsx
apps/web/src/components/categories/categories-manager.tsx
apps/web/src/components/categories/tracking-profile-editor.tsx        (new)
apps/web/src/components/categories/tracking-profile-editor.test.tsx   (new)
apps/web/src/components/cycle-counts/count-item-picker.tsx
apps/web/src/components/cycle-counts/count-item-picker.test.tsx
apps/web/src/components/cycle-counts/cycle-count-detail.tsx
apps/web/src/components/cycle-counts/cycle-count-detail.test.tsx
apps/web/src/components/cycle-counts/new-cycle-count.tsx
apps/web/src/components/cycle-counts/selection-confirm.tsx
apps/web/src/components/dashboard/icons.ts
apps/web/src/components/inventory/add-sized-variants-button.tsx
apps/web/src/components/inventory/csv-import.tsx
apps/web/src/components/inventory/group-linking-review.tsx            (new)
apps/web/src/components/inventory/grouping-preview.tsx                (new)
apps/web/src/components/inventory/grouping-preview.test.tsx           (new)
apps/web/src/components/inventory/inventory-table.tsx
apps/web/src/components/inventory/inventory-table.instant.test.tsx
apps/web/src/components/inventory/item-detail.tsx
apps/web/src/components/inventory/item-form.tsx
apps/web/src/components/inventory/item-form.test.tsx
apps/web/src/components/inventory/item-form.sports-fields.test.tsx    (new)
apps/web/src/components/inventory/product-group-rollup-list.tsx       (new)
apps/web/src/components/inventory/product-group-rollup-list.test.tsx  (new)
apps/web/src/components/inventory/sports-fields.tsx                   (new)
apps/web/src/components/po-imports/create-items-modal.tsx
apps/web/src/components/po-imports/create-items-modal.test.tsx
apps/web/src/components/po-imports/mapping-confirmation.tsx           (new)
apps/web/src/components/po-imports/po-import-detail.tsx
apps/web/src/components/po-imports/po-import-detail.charter.test.tsx
apps/web/src/components/po-imports/po-import-detail.review-results.test.tsx
apps/web/src/components/po-imports/po-import-detail.selection.test.tsx
apps/web/src/components/po-imports/po-import-detail.suggest.test.tsx
apps/web/src/components/po-imports/po-import-detail.test.tsx
apps/web/src/components/po/po-form.tsx
apps/web/src/components/po/po-form.test.tsx
apps/web/src/components/po/po-receive-dialog.tsx
apps/web/src/components/po/po-receive-dialog.test.tsx
apps/web/src/components/po/size-run-receive-grid.tsx                  (new)
apps/web/src/components/po/size-run-receive-grid.test.tsx             (new)
apps/web/src/lib/inventory/instant-mode.ts
apps/web/src/lib/inventory/instant-mode.run-aware.test.ts
apps/web/src/lib/pdf/cycle-count.tsx
apps/web/src/lib/pdf/cycle-count.group.test.ts
apps/web/src/lib/po-scan/extract.ts
apps/web/src/lib/po-scan/extract.test.ts
apps/web/src/lib/po-scan/dedupe.test.ts
```

### `apps/mobile` (25)

```
apps/mobile/app/(drawer)/(tabs)/inventory.tsx
apps/mobile/app/cycle-count/[id].tsx
apps/mobile/app/cycle-count/scan/[id].tsx
apps/mobile/app/item/[id].tsx
apps/mobile/app/item/new.tsx                       (THE PARITY FIX)
apps/mobile/app/po/[id].tsx
apps/mobile/app/po-import/[id].tsx
apps/mobile/app/size-count/[id].tsx
apps/mobile/app/size-count/capture.tsx
apps/mobile/app/size-count/new.tsx
apps/mobile/app/zendesk/web.tsx                    (lint-only)
apps/mobile/package.json                           (zod direct dependency)
apps/mobile/src/components/AddBookCard.tsx
apps/mobile/src/components/AddItemCard.tsx
apps/mobile/src/lib/cycle-count-cache.ts
apps/mobile/src/lib/db.ts
apps/mobile/src/lib/db.addColumnIfMissing.test.ts
apps/mobile/src/lib/inventory-grouping.ts
apps/mobile/src/lib/inventory-grouping.test.ts
apps/mobile/src/lib/item-create.ts
apps/mobile/src/lib/item-create.test.ts
apps/mobile/src/lib/po-size-run.ts
apps/mobile/src/lib/po-size-run.test.ts
apps/mobile/src/lib/size-count-chips.ts
apps/mobile/src/lib/size-count-chips.test.ts
apps/mobile/src/screens/categories.tsx
```

### Docs and lockfile

```
docs/superpowers/plans/2026-07-27-sports-inventory-phases-2-7.md   (Task 13 renumbering)
docs/superpowers/reports/2026-07-27-sports-migration-report.md
pnpm-lock.yaml
```

---

## 4. Live web verification — Demo Co

**OWNER-GATED: requires prod migrations.** Every line below is copied verbatim
from the plan's Task 20 and is UNEXECUTED. Prerequisites, in order:
`supabase db push --linked` applying 0294-0303 against `xizpqmhhslgzbuqtjubv`;
then the `main` push that auto-deploys web; then enabling the `sports` module for
Demo Co (`71b27a4a-7948-4638-bc3f-535974713bd2`). Record a pass or fail per line.

- [ ] 1. Categories: run "Set up Sports"; confirm a Sports root with eight subcategories, each showing its resolved mode and counting unit.
- [ ] 2. Create a custom subcategory WITHOUT a profile; confirm it is refused with the mapped message.
- [ ] 3. Add Item: pick Sports without a subcategory; confirm `SPORTS_SUBCATEGORY_REQUIRED`.
- [ ] 4. Add a shoe style in sizes 9, 10 and 11 with quantities 4, 6 and 2. Confirm the grouping preview reads "Serial: not required" and the counting unit reads pairs. Confirm ONE group, three variants, a roll-up of "3 variants · 12 pairs total", and ZERO serial rows. **(R2)**
- [ ] 5. Add jersey #12 in M(3) and XL(2). Confirm one group, two variants, a roll-up of 5, that the number field is labelled "Jersey number" and never "Serial Number", and that `07` and `7` can coexist. **(R3)**
- [ ] 6. Add a second group whose jersey number is also 12; confirm no conflict.
- [ ] 7. Electronics: create a serialized item, raise a PO, and try to receive with no serial. Confirm it is BLOCKED. **(R1)**
- [ ] 8. Protective equipment: receive 4 units with 2 serials. Confirm it succeeds, that 2 registry rows exist, and that 4 units posted to on-hand.
- [ ] 9. Receive the shoe PO as a size run; confirm per-size ordered/received and that sizes sort 9, 10, 11 — not alphabetically.
- [ ] 10. CSV import a mixed shoes-and-jerseys file; confirm the review table shows Group, Variant and a real Result vocabulary, and that an ambiguous "Number" column blocks approval until confirmed.
- [ ] 11. Re-upload the SAME file; confirm the duplicate is caught and that no second group appears.
- [ ] 12. Transfer, adjust, return, and pick a variant; confirm each writes a `stock_movements` row naming the variant.
- [ ] 13. Cycle count scoped to a product group; confirm counting by variant with no serial prompt.
- [ ] 14. Run the linking review tool on an existing sized family; confirm nothing changes until Link is pressed, then confirm the family collapses under a real group.
- [ ] 15. **Ledger check:** for every item touched above, confirm `SUM(stock_movements.quantity_change) = quantity_on_hand`.

Carried in from earlier tasks and folded into this checklist rather than claimed:
Task 11's web Add Item click-through was never done, and Task 16's size-run
receiving was never walked in Demo Co.

Note for line 4/9: no production sports category exists yet, and a sports
category with `supports_sizes` but no `size_scale_id` fails
`SHOE_SIZE_SYSTEM_REQUIRED` on the bulk path (matching `create()`). "Set up
Sports" seeds the scales, so run line 1 first.

## 5. Live mobile verification — iOS simulator, then a real device, in Demo Co

**OWNER-GATED: requires prod migrations.** Verbatim from the plan's Task 20,
UNEXECUTED. **Release order is load-bearing: mobile must NEVER ship before
0294-0303 reach production.** Verified failure mode if it does: the new Bearer
routes 404 loudly — no corruption.

- [ ] 1. Add Item: a plain product, a book, and a shoe style with three sizes. Confirm the shared-schema validation messages are friendly, that an empty SKU is accepted, and that a rack number now stamps `bin_location`.
- [ ] 2. Confirm an item created with on-hand 5 has `quantity_on_hand = 5`, not 10 — proving the removed client-side `adjust_stock` call is really gone.
- [ ] 3. Inventory list: confirm group roll-ups render and expand.
- [ ] 4. PO receive: receive a size run.
- [ ] 5. Size count: start a count against a product group and tally numeric sizes.
- [ ] 6. Cycle count: scan a variant barcode and confirm it increments that variant.
- [ ] 7. Confirm every notification link produced by these flows resolves on mobile.

Not simulator-verifiable and honestly recorded as such: the Scan-tab
`AddItemCard` / `AddBookCard` paths are camera-only, so Task 10 could only verify
that they now post through the Bearer route by code review and unit tests, not by
driving them on the simulator.

## 6. Mobile release — OTA sufficiency

Task 10 added `zod` as a direct dependency of `apps/mobile`
(`apps/mobile/package.json`), which is a dependency change and therefore needs an
explicit decision rather than an assumption.

**`zod` is pure JavaScript. It ships no native module, no config plugin, and no
iOS/Android build step, so it is bundled into the JS bundle exactly like any
application file. An OTA update is therefore sufficient and no new native build
(EAS) is required for this branch.**

Ship with `pnpm release:ota` from `apps/mobile` — never a raw `eas update`.
Confirm `runtimeVersion` matches `appVersion` (1.1.0) before publishing.

```
[PENDING — no OTA published. Update group / branch / platforms / source-map
upload to be recorded here after the migrations and web deploy land.]
```

---

## 7. Open policy questions and their current disposition

The plan assigned each of the six questions to the task that had to resolve it.
This is where each one actually stands in the code, not where the plan hoped it
would land.

### 1. Is a jersey number required, or optional per subcategory? (Task 12)

**Resolved as OPTIONAL, and now org-configurable.**
`DEFAULT_SUBCATEGORY_PROFILES.jerseys.requiredAttributes` is `['size']`, so a
school can stock blank numbered jerseys and number them later.
`assertVariantAttributesValid` enforces whatever the list says, and Task 12's
profile editor lets an org move `jersey_number` into `requiredAttributes` for a
custom subcategory without a code change. `JERSEY_NUMBER_INVALID` copy already
exists.

### 2. Does grouping ever key on player name? (Task 7)

**Currently resolved as "assignment/label, not variant identity."**
`buildVariantKey` still ACCEPTS `playerName` and would emit a `player=` slot, but
**no server write path passes it** — `InventoryService.create()` omits it, and so
does the web grouping preview (aligned deliberately at Task 11). In practice
player name is stored on `inventory_items.player_name` as a label and never
enters identity, so a jersey changing hands cannot fragment its group.

Open residue: the slot is still in the builder. If the owner confirms this
disposition permanently, the slot should be REMOVED from `buildVariantKey` so a
future caller cannot reintroduce fragmentation by passing it. Leaving it is safe
today and cheap to close.

### 3. Is colorway a group attribute or a variant attribute? (Task 5)

**Modelled as BOTH, and shipped that way.** `product_groups.colorway`
participates in the shoe group key; `inventory_items.variant_color` carries
colour per variant. The stated rule is that a group whose variants differ by
colourway leaves the group column NULL. `sports-fields.tsx` encodes which
subcategories put `color` at group level versus variant level.

Open residue: the owner has not stated the DEFAULT for shoes — whether "Pegasus
41 Black/White" is a different product from "Pegasus 41 Blue". The two answers
produce different group counts for the same catalog. As keyed today, it IS a
different group.

### 4. Which size scales seed first? (Task 2)

**Resolved: four.** `apparel_alpha`, `us_mens_shoe`, `us_womens_shoe`,
`us_youth_shoe`, all `organization_id = NULL` system scales. UK, EU and CM are
NOT seeded. Width is not a scale.

Open residue, and it grew during the program: the XXL / 2XL **alias** question.
The apparel scale deliberately holds both spellings (14 rows) so nothing that
renders today stops rendering, while `APPAREL_ALPHA_SIZES` offers only the nine
canonical spellings in pickers. Deciding that a stored `XXL` and an imported
`2XL` are the SAME variant would merge stock, so it was deferred from Task 2 to
Tasks 17/19 — and **neither resolved it**. `size-order.ts` gives them the same
rank so they render adjacently; `isApparelAlphaSize('2XL')` returns false on
purpose. This is an unresolved owner decision, not a defect.

### 5. What is the controlled tracking-mode-change migration? (Task 8)

**Resolved as refusal-only in intent; the wizard is deferred. What is actually
in the code is narrower than "refusal", and the owner should see the exact
shape.**

- `resolveModeOverride()` refuses an override that the subcategory does not
  allow, that escalates to `INDIVIDUALLY_TAGGED` without permission, or that
  comes from a caller without `sports:manage`. It raises
  `TRACKING_MODE_NOT_ALLOWED`.
- `TRACKING_MODE_CHANGE_REQUIRES_MIGRATION` exists in `SPORTS_ERROR_CODES` with
  full UI copy and has **ZERO raisers anywhere in the codebase** (verified by
  grep across `.ts`/`.tsx`).
- There is no transaction-history guard on changing `categories.tracking_mode`
  either. The architecture is what makes that tolerable: `tracking_type` is
  stamped at CREATE and never re-derived, so changing a category's mode affects
  only future items and can never silently rewrite an item that already has
  movements.
- What is NOT built is the guided flow for deliberately converting existing
  stock between modes (preflight, reconciliation, confirmation, audit reason).

Two consequences the owner must decide on: whether that conversion flow is in
scope as a follow-on, and — either way — that the error's current action copy
says "Run the guided tracking-mode migration with a reason," which points at
something that does not exist. The plan explicitly required that copy to point at
support instead if the wizard was out of scope. **It has not been changed.**

### 6. Are high-value jerseys individually tagged by default? (Task 12)

**Resolved as NO automatic escalation.** `jerseys.individualTrackingAllowed` is
`true` and `INDIVIDUALLY_TAGGED` is in its `allowedModes`, so an org CAN escalate
a jersey group to unit tracking, but nothing does it automatically and there is
no value threshold. A threshold would be a new per-subcategory profile setting in
the Task 12 editor. Not built; not requested.

### Additional open owner question, raised during Task 17

**Half sizes cannot be labelled in the Instant Size Count training capture.** The
capture screen tallies through size CHIPS, and the chip vocabulary cannot express
`10.5`. A numeric shoe run can be counted through the normal size-count flow but
not labelled in the training-capture UI. Logged for the Task 20 review; no code
change was made.

---

## 8. Known gaps carried into this branch's final review

Each of these is recorded rather than fixed, and none is claimed as verified.

1. **Mobile drawer dead route.** The `sports` module registers a `mobile_drawer`
   placement at `/product-groups`, and no such Expo route exists. Invisible while
   the module is off everywhere; enabling it for an org surfaces a drawer entry
   that dead-ends. Raised at Task 4, still open at Task 18.
2. **`TRACKING_MODE_CHANGE_REQUIRES_MIGRATION` is unraised and its copy names a
   non-existent wizard.** See open question 5.
3. **XXL / 2XL alias resolution is unresolved.** See open question 4.
4. **Concurrent double-submit can fork two variant rows** with the same
   `variant_key` and different SKUs. The GROUP still converges. A
   `unique (group_id, variant_key)` index would break Model B — the same variant
   in two bins is two rows — so an index is explicitly NOT the fix. Bounded
   behaviour, documented at Task 15.
5. **CSV row-failure behaviour change:** a generic row with an oversized
   `size`/`width` or a non-digit `jersey_number` now FAILS the row where those
   values used to be silently stripped
   (`apps/web/src/server/actions/import.ts:36-43`).
6. **`modelNumber` is hidden in sized mode on mobile, and web silently discards
   it in the same situation.** Flagged at Task 10, unfixed.
7. **Group-identity CSV columns are validated but not applied** (`brand`,
   `model`, `style_number`, `colorway`, `team`, `season`, `home_away`,
   `counting_unit`, `tracking_mode`, `serial`, `asset_tag`). Deliberate — bulk
   identity creation from a spreadsheet is what the owner ruled out — and the UI
   states it.
8. **Mobile PO-import select omits `variant_width` / `variant_fit` /
   `variant_size_original`**, so a mobile-side flag can lag web. Nit from
   Task 14.
9. **`instant_size_count` was never added to `seed_org_modules()` nor
   grandfathered.** Pre-existing drift, called out in 0297's header, deliberately
   not fixed there.
10. **The `custom_fields.size` dual-write is still on.** Its exit criteria are in
    the migration report and depend on 0303 reaching production and the
    `ambiguous_size` queue being worked.
