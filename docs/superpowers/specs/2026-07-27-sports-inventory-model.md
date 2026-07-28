# Sports inventory — final model (deliverable 2)

The model as BUILT on branch `feat/sports-model-p2`, verified against the
migrations and the code rather than against the plan. Every claim below names
the file it can be checked in.

Status: migrations `0294`-`0303` are applied LOCALLY only. Nothing in this
document has been exercised against production data. Live verification is
tracked in `docs/superpowers/reports/2026-07-27-sports-verification.md`.

Sources: `docs/superpowers/specs/2026-07-27-sports-inventory-requirements.md`
(binding requirements), `docs/superpowers/specs/2026-07-27-sports-inventory-phase1-report.md`
(current-model audit), `docs/superpowers/plans/2026-07-27-sports-inventory-phases-2-7.md`
(the executed plan).

---

## 1. The three layers, on real tables

The requirements ask for `Group -> Variant -> optional Individual Physical Unit`.
No new stock-bearing entity was created. The hierarchy is laid OVER the existing
inventory table.

| Layer | Storage | Introduced by | Owns quantity? |
|---|---|---|---|
| GROUP — shared product identity ("Nike Pegasus 41", "Falcons Home Jersey") | `public.product_groups` | 0298 | **No. Ever.** |
| VARIANT — one attribute combination (size/width/fit, or number/size) | `public.inventory_items` rows carrying `group_id` + `variant_key` | 0298 (columns only) | **Yes — the only layer that does** |
| UNIT — an individually-tracked physical thing (a serialized Chromebook, a tagged helmet) | `public.serial_registry` (unchanged, from 0015) | — | No; it references an item |

There is no `product_variants` table and no `inventory_units` table. A variant
IS an `inventory_items` row. That single decision is what keeps every existing
flow — receiving, picking, transfers, adjustments, cycle counts, orders,
reporting, RLS, the audit trail — working without a parallel code path.

`serial_registry` was not touched by this program. Its shape is still
`(organization_id, item_id, serial_number, warehouse_id, current_status,
receipt_line_id)` with `unique (organization_id, item_id, serial_number)`. A
quantity variant creates ZERO rows there; that is regression assertion R2.

---

## 2. Why `inventory_items` remains the sole quantity owner

The ledger invariant is absolute:

```
SUM(stock_movements.quantity_change) = inventory_items.quantity_on_hand
```

Every quantity change in StockPilot is an audited movement written by
`adjust_stock` / `apply_level_delta` / the create-time `initial` movement. The
requirements restate it: "Every quantity change is an audited inventory
transaction ... never a direct update."

A group-level quantity column would have to be maintained by a second writer
that no existing movement path knows about. The moment a pick, a receipt, a
transfer or a cancellation moved a variant, the group total would be stale, and
there would be no ledger row explaining the difference. There is no way to
reconcile a stored group total against the movement ledger, because movements
are recorded per item. So the group stores nothing:

- `product_groups` has NO quantity column of any kind (0298, lines 33-72).
- The ONLY place a group total exists is the view
  `public.product_group_rollups` (0298 §5), recomputed on every read:
  `variant_count` = `count(distinct variant_key) filter (where variant_key is
  not null)`, `placement_count` = `count(id)`, `total_quantity` =
  `coalesce(sum(quantity_on_hand), 0)`, excluding soft-deleted and archived
  rows.
- The view carries `with (security_invoker = true)`. Without it a view runs with
  the OWNER's rights — the migration superuser, who bypasses RLS — and every
  org would read every other org's group totals. This was a real finding during
  Task 5, not a precaution.

Consequences that follow from this and are load-bearing elsewhere:

- Migration 0303 (the one backfill) writes no quantity and no movement, so the
  invariant holds trivially for every row it touched. Asserted in
  `supabase/tests/0303_variant_size_backfill.test.sql`.
- Instant Size Count stays REVIEW-ONLY after being re-keyed to
  `product_group_id` (0302). Naming a group does not give it stock to write.
- Roll-up labels are built by `groupRollupLabel()` in
  `packages/core/src/sports/variant-keys.ts` — display only.

---

## 3. Tracking mode -> `tracking_type`

A category carries a POLICY (`categories.tracking_mode`). An item carries the
stamped CONSEQUENCE (`inventory_items.tracking_type`). Keeping them separate is
what let `post_receipt_v2`'s enforcement seam stay intact: the RPC still reads
only `inventory_items.tracking_type`.

Source of truth: `MODE_TO_TRACKING_TYPE` in
`packages/core/src/sports/tracking-modes.ts`. The `categories_tracking_mode_check`
CHECK in 0294 mirrors `TRACKING_MODES` and must stay in lockstep with it.

| `categories.tracking_mode` | `inventory_items.tracking_type` | Serial requirement at receipt | Display label |
|---|---|---|---|
| `QUANTITY` | `none` | none | Quantity |
| `QUANTITY_BY_VARIANT` | `none` | none | Quantity by variant |
| `NUMBERED_VARIANT` | `none` | none | Numbered variant |
| `SERIALIZED` | `serial` | exactly one serial per accepted unit | Serialized |
| `OPTIONAL_SERIALIZED` | `serial_optional` | 0..n serials, n <= accepted qty | Optional serial |
| `INDIVIDUALLY_TAGGED` | `serial` | exactly one per unit (the asset tag rides `serial_registry`) | Individually tagged |
| `LOT_TRACKED` | `lot` | lot rules, unchanged | Lot tracked |

`serial_optional` is the ONE new `tracking_type` value. It was added by widening
the CHECK in 0295 and taught to `post_receipt_v2` in 0296 — the function's sixth
rewrite, verified as two hunks and one removed line against the live body. The
`none` / `lot` / `serial` branches are provably unchanged, which is what keeps
R1 (Electronics with no serial is still BLOCKED) true.

`INDIVIDUALLY_TAGGED -> 'serial'` is deliberate: a tagged helmet is a unit with
a mandatory identifier, and StockPilot already has exactly one place to put a
per-unit identifier.

### Resolution and inheritance

`public.category_tracking_mode(uuid)` and `public.category_default_uom(uuid)`
(0294 §4) resolve a category's policy:

- `coalesce(own, parent, 'QUANTITY')` — exactly ONE level up, through the
  dormant `categories.parent_id` that has existed since 0002.
- `NULL` reads as `QUANTITY`. Every category in every org is NULL today, so
  every existing org is bit-for-bit unaffected.
- Both are `STABLE SECURITY DEFINER` on purpose: a viewer with restricted
  category access might not see the PARENT row, and a per-caller tracking policy
  would be a correctness hole. Both are revoked from `public` and `anon` (a Task
  2 security fix — the original grant let anon read a foreign org's tracking
  mode over PostgREST RPC).

The server-side resolver is `resolveTrackingProfile()` in
`apps/web/src/server/services/sports-profiles.ts`, memoized per request under
`${organizationId}:${categoryId}`. `InventoryService.create()` stamps
`tracking_type` from it; a caller-supplied `trackingType` still wins wherever
the category expresses no policy (`modeIsExplicit === false`), so no existing
caller changed behaviour.

`resolveModeOverride()` allows an authorized per-create override
(`sports:manage`, must be in the subcategory's `allowedModes`, and
`INDIVIDUALLY_TAGGED` additionally needs `individualTrackingAllowed`). See §9
for what it does NOT do.

### Subcategory profiles

`DEFAULT_SUBCATEGORY_PROFILES` (same file) is the initial Sports subcategory
set. A CUSTOM subcategory must carry a COMPLETE profile, validated by
`trackingProfileSchema` + `trackingProfileConsistencyError()` in
`packages/core/src/schemas/sports.ts` and stored in
`categories.tracking_profile` (jsonb).

| Subcategory | Default mode | Required attributes | Counting unit | Individual tracking allowed |
|---|---|---|---|---|
| `shoes` | `QUANTITY_BY_VARIANT` | `size`, `size_system` | `pair` | no |
| `jerseys` | `NUMBERED_VARIANT` | `size` | `each` | yes |
| `uniforms` | `QUANTITY_BY_VARIANT` | `size` | `set` | no |
| `sports_apparel` | `QUANTITY_BY_VARIANT` | `size` | `each` | no |
| `protective_equipment` | `OPTIONAL_SERIALIZED` | none | `each` | yes |
| `balls` | `QUANTITY` | none | `each` | no |
| `training_equipment` | `OPTIONAL_SERIALIZED` | none | `each` | yes |
| `other_sports_equipment` | `QUANTITY` | none | `each` | yes (every mode allowed) |

Counting units are `each | pair | set | case | unit` (`COUNTING_UNITS`), mirrored
by `categories_default_uom_check` and `product_groups.default_counting_unit`.
**PAIR is a display convention only.** There is no conversion factor anywhere in
the stack; `countingUnitLabel()` pluralizes it for display ("12 pairs") and the
ledger is untouched. Owner decision, 2026-07-27.

---

## 4. Module gating

Sports is a self-contained premium module (`packages/core/src/modules/registry.ts`,
registered in the database by 0297).

- `tier: 'premium'`, `minPlan: 'business'`, `defaultOnFor: []` — OFF for every
  org, including new ones. 0297 grandfathers every existing org to
  `enabled = false`.
- `dependsOn: ['inventory']`. **No `lot_serial` dependency** (owner decision):
  the sports module grants its own serial modes for sports categories, and
  `lot_serial` stays grandfathered off and untouched.
- `permissions: ['sports:manage']`, seeded for admin + manager and fully
  grantable (0297 raises 0207's pgTAP permission count from 109 to 111).
- `ownsTables: ['product_groups', 'size_scales', 'size_scale_values']`,
  `apiPrefixes: ['/api/v1/product-groups']`.
- Placements: web sidebar `Product groups -> /dashboard/product-groups`, mobile
  drawer `Product groups -> /product-groups`, both `requires: 'sports:manage'`,
  both in the `inventory` section at sort order 25.

Where the gate is enforced:

- Every `ProductGroupsService` method and both linking entry points call
  `assertModuleEnabled(ctx, 'sports')` (13 + 2 sites).
- `CategoriesService` gates any write that touches the sports profile fields —
  including a write to null — on `sports:manage` AND the module.
- `InventoryService.create()` gates on the module when the row is sports-resolved
  OR carries a `groupId`, independently of the category. RLS already pins the
  group to the org (`product_group_in_org`, 0298) but says nothing about
  entitlement.
- The `lot_serial` gate in `create()` is deliberately UNCHANGED and still reads
  the CALLER's `input.trackingType`. A client posting `serial_optional` directly
  still needs `lot_serial`; the sports exception is a category-driven stamp
  resolved further down and gated on `sports` instead.

**Known gap:** the mobile drawer placement points at `/product-groups`, and no
such Expo route exists (`apps/mobile/app/` has no `product-groups` directory).
With the module off everywhere this is invisible today, but enabling `sports`
for an org would surface a drawer entry that dead-ends. Recorded in the
verification report.

---

## 5. Identity keys: computed on the server, never accepted

`packages/core/src/sports/variant-keys.ts` is the ONLY place a key is built.
Web, Expo and every server path call the same two functions, so a shoe added on
a phone and the same shoe arriving on a PO resolve to the same `group_key`.

### `buildGroupKey(parts)`

The subcategory decides which slots participate, so a shoe key and a jersey key
can never collide:

- jerseys / uniforms: `(subcat, team, league, season, home_away, manufacturer, brand, style_number, color)`
- everything else (shoes): `(subcat, brand, model, style_number, colorway)`

`manufacturer` and `brand` stay two INDEPENDENT slots (never folded with `??`),
or a manufacturer-only group and a brand-only group would collide on one slot.

When every identifying slot is blank the key falls back to
`` `${sub}|name:${slot(name)}` ``. That shape carries 2 fields where a real key
carries 5 or 9, and no slot can contain an unescaped `|`, so a name can never
impersonate an attribute. The fallback is marked weak so import review can flag
it — it is the escape hatch that keeps matching from ever being
name-string-only.

### `buildVariantKey(parts)`

NAMED slots, emitted in fixed order, blank slots omitted:
`number=`, `player=`, `size=`, `system=`, `width=`, `fit=`, `color=`, joined with
`|`; `'default'` when nothing is set. Named slots mean an absent width cannot
shift a value into the fit position.

### Injective escaping (Task 7 Critical)

Both keys join user text with `|` (and `=`). Without escaping, a value that
CONTAINS a delimiter rewrites the key's structure:

```
buildVariantKey({ size: '10|width=w' })  ===  buildVariantKey({ size: '10', width: 'w' })
```

`product_groups.group_key` is UNIQUE per org, so a forged collision does not
error — it silently MERGES two products and their stock. The fix is the classic
three-step escape, in this order (the escape character first, or the second pass
re-escapes its own output):

```
\  ->  \\        |  ->  \|        =  ->  \=
```

The mapping is injective, so distinct normalized tuples can never produce equal
keys, and any value containing none of the three characters passes through
byte-identical — keys already written stay stable.

### Server-only, at four layers

The same class was closed at every layer, not just in core:

1. `variantAttributesSchema` (the client-accepted contract) does not carry
   `variantKey`; zod strips a client-supplied one rather than rejecting it, so
   old builds keep working and the value never reaches a service.
2. `serverVariantAttributesSchema` is the write-path shape and is the only one
   that carries the key.
3. `duplicate_inventory_item` (0299) ignores a smuggled key and CLEARS the
   copied `variant_key` whenever a variant attribute is overridden; the service
   recomputes it (`inventory.ts`, the Task 8 recompute).
4. Every write path recomputes: `InventoryService.create()` /
   `bulkCreateSizedVariants()` / `update()` on a size change,
   `po-imports-variants.ts`, `product-group-linking.ts`,
   `ProductGroupsService.findOrCreate()`.

`item-form.tsx` also calls `buildVariantKey` — for the DISPLAY of the grouping
preview only. The server recomputes on save; a stale preview cannot become
identity.

### Normalization used by the keys

- `normalizeJerseyNumber`: strips a leading `#` and whitespace, returns null for
  blank. **Leading zeroes are preserved** — `0`, `00`, `07`, `7` are four
  distinct numbers. This is why the column is TEXT everywhere and never an
  integer.
- `normalizeSizeValue`: alpha sizes upper-cased; a numeric size loses a trailing
  `.0` but KEEPS halves (`10.0 -> 10`, `10.5 -> 10.5`); a redundant system
  prefix is stripped only when it agrees with the supplied system
  (`'US 10'` under `US_MENS` -> `'10'`). It **never converts between systems** —
  a UK 9 is not turned into a US 10, because that needs an approved mapping that
  does not exist.
- The original string is always kept alongside the normalized one
  (`variant_size_original`), so any future approved mapping stays auditable
  against the source.

---

## 6. Model B interaction: placements are not variants

StockPilot has carried "Model B" identity since 0234:

```sql
create unique index inventory_items_org_sku_charter_bin_unique
  on public.inventory_items (organization_id, sku, charter_id, bin_location)
  nulls not distinct where deleted_at is null;
```

One SKU may therefore legitimately exist as SEVERAL `inventory_items` rows —
one per (charter, bin) placement. That is orthogonal to variants:

- A **variant** is a distinct physical configuration (size 10 vs size 10.5).
- A **placement** is the same variant sitting in a second rack or under a second
  charter.

Both are `inventory_items` rows, so a group can hold more rows than it has
variants. This is why the roll-up view reports BOTH `variant_count`
(`count(distinct variant_key)`) and `placement_count` (`count(id)`).

**There is deliberately no `unique (group_id, variant_key)` index, and there must
never be one.** It would break Model B: the same variant in two bins is two
rows with the same `variant_key`, and the index would reject the second
placement. The bounded consequence (recorded at Task 15) is that a truly
concurrent double-submit can fork two variant rows with the same key and
different SKUs; the GROUP still converges through the real 23505 re-read on
`product_groups_org_key_uniq`. A uniqueness index is not the fix.

Related invariants that were preserved:

- 0298 pins 0234's `indexdef` byte-identical — the variant columns did not
  change Model B identity.
- 0299 makes `duplicate_inventory_item` carry all 14 variant/attribute columns,
  so a Model B duplicate keeps its variant identity, EXCEPT that
  `variant_key` is cleared when an attribute is overridden (and recomputed by
  the service).
- `VARIANT_ALREADY_EXISTS` in the linking tool fires on a cross-SKU same-key
  collision and **cannot** be bypassed with `force`; same-SKU Model B placements
  are allowed through.
- Charter is still applied at RECEIVE, and PO bill-to charter is still
  independent of item ownership charter. Nothing in this program changed either.

---

## 7. Sizes: scales, not hardcoded lists

`size_scales` + `size_scale_values` (0294) replace five inconsistent hardcoded
size lists. `organization_id IS NULL` means a built-in system scale readable by
every org and editable by nobody. Four are seeded:

| Key | Name | Kind | System | Values |
|---|---|---|---|---|
| `apparel_alpha` | Apparel (XS-5XL) | `apparel_alpha` | — | 14 rows: XS,S,M,L,XL,XXL,2XL,XXXL,3XL,XXXXL,4XL,XXXXXL,5XL,6XL |
| `us_mens_shoe` | US Men's shoe | `shoe_numeric` | `US_MENS` | 4.0-18.0 in half steps |
| `us_womens_shoe` | US Women's shoe | `shoe_numeric` | `US_WOMENS` | 4.0-18.0 in half steps |
| `us_youth_shoe` | US Youth shoe | `youth_numeric` | `US_YOUTH` | 1.0-7.0 in half steps |

UK, EU and CM are NOT seeded. Width is not a scale — it rides `variant_width` as
free text against the N/M/W/2E/4E vocabulary.

The apparel scale carries the UNION of every spelling the codebase has ever
emitted or parsed, so nothing that renders today stops rendering. That union is
right for MATCHING an inbound string and wrong for OFFERING choices to a person:
`APPAREL_ALPHA_SIZES` in `packages/core/src/inventory/apparel-sizes.ts` is the
nine canonical spellings the pickers show, because a picker offering both `XXL`
and `2XL` invites two inventory items for one physical size.

**Alias resolution is UNRESOLVED and intentionally absent.** Deciding that a
stored `XXL` and an imported `2XL` are the same variant would merge stock;
`size-order.ts` gives them the same RANK so they render adjacent, and
`isApparelAlphaSize('2XL')` returns false on purpose. See the open questions in
the verification report.

Ordering is `sports/size-order.ts`, with a deliberate precedence: the category
scale's `sort_order` first, then a numeric fallback, then an alpha ladder, then
alphabetical. String comparison gets both `'10' < '9'` and `'XL' < 'XS'` wrong,
so every surface that renders a run sorts through this one module.

---

## 8. Import model (summary; the field-level contract is the field dictionary)

- `po_import_lines` gains 12 variant columns (0301). The chassis — staging
  status machine, SHA256 file idempotency with supersede lineage, per-line
  extraction confidence, `needs_review` UI, the 0233 suggestion-not-link
  discipline — is untouched; `dedupe.ts` is byte-identical.
- `suggested_group_id` is ADVISORY. A human accepts it in review; nothing links
  automatically.
- `mapping_confidence` is separate from `extraction_confidence` on purpose: a
  perfectly legible column headed "Number" is still ambiguous.
  `IMPORT_MAPPING_CONFIDENCE_THRESHOLD = 0.7`; below it, a line that actually
  carries a sports mapping goes to the confirmation step
  (`lineNeedsMappingConfirmation`). Non-sports scans approve exactly as before —
  the gate is scoped, and that scoping is regression-tested.
- `AMBIGUOUS_COLUMN_MEANINGS = jersey_number | quantity | serial | style_number |
  line_number | ignore`. The human picks; nothing is chosen automatically.
- The review Result vocabulary is real, not Valid/Invalid: `create_new_group`,
  `add_new_variant`, `receive_into_existing_variant`, `create_serialized_units`,
  `possible_duplicate`, `missing_required_attribute`, `ambiguous_category`,
  `ambiguous_variant_match`, `serial_required`, `mapping_review_required`,
  `ready`. The last six BLOCK approval (`BLOCKING_LINE_RESULTS`).
- `serial_hint` holds the serial the DOCUMENT printed, verbatim or NULL. Never
  invented, never a placeholder, never derived from a jersey number.
  Receipt-time enforcement (`post_receipt_v2`) remains the authority on what
  actually arrives.

---

## 9. What this model deliberately does NOT do

- **No group-level quantity.** §2.
- **No name-heuristic backfill.** `group_id` is NULL for every historical row and
  0303 writes it in neither direction. Existing families link through the
  human-driven review tool at `/dashboard/product-groups/link`. Display-only
  name heuristics (`packages/core/src/inventory/size-run.ts`) remain the
  fallback for ungrouped inventory.
- **No jersey-number uniqueness.** `inventory_items_jersey_number_idx` is
  non-unique by design; the same number repeats across sizes, groups, teams,
  seasons and warehouses. A jersey number is never written to a serial column
  and is never labelled "Serial Number" on any surface.
- **No size-system conversion.** §5.
- **No player-name identity.** `buildVariantKey` accepts `playerName`, but no
  server write path passes it (`InventoryService.create()` omits it, and so does
  the grouping preview). In practice player name is an assignment/label, not
  variant identity. Recorded as open question 2 with that disposition.
- **No guided tracking-mode-change migration.** `TRACKING_MODE_CHANGE_REQUIRES_MIGRATION`
  exists in the error vocabulary with ZERO raisers in the codebase. The
  architecture makes the wizard less urgent than it looks — `tracking_type` is
  stamped at CREATE and never re-derived, so changing a category's
  `tracking_mode` affects only future items and never rewrites an item with
  movements. What is NOT built is a preflight/reconciliation flow for
  deliberately converting existing stock between modes. Open question 5; the
  error's current copy still says "Run the guided tracking-mode migration",
  which points at something that does not exist.
- **No half-size labels in the Instant Size Count training capture.** The chip
  UI cannot express `10.5`. Open owner question from Task 17.
