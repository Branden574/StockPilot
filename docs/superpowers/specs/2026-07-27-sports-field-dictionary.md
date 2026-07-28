# Sports inventory — field dictionary (deliverable 3)

Every column added by migrations `0294`-`0303`, plus every `PO_SCHEMA`
extraction field added for sports, with its meaning, type, required-when,
normalization rule, accepted aliases, key participation and display label.

Read against the migrations and schemas, not the plan. Where a bound differs
between the zod contract and the SQL column, both are stated — the difference is
never accidental.

Legend for **Key**: `GROUP` = participates in `buildGroupKey`, `VARIANT` =
participates in `buildVariantKey`, `—` = participates in neither.
Sources: `packages/core/src/sports/variant-keys.ts`,
`packages/core/src/sports/tracking-modes.ts`,
`packages/core/src/schemas/sports.ts`,
`packages/core/src/schemas/po-imports.ts`,
`apps/web/src/lib/po-scan/extract.ts`,
`apps/web/src/server/actions/import.ts`,
`apps/web/src/components/inventory/csv-import.tsx`.

Nothing added by this program is `NOT NULL` and nothing carries a back-filling
default. Every new column reads as "this org never opted in" when NULL.

---

## 1. `size_scales` (new table, 0294)

An ordered size vocabulary. `organization_id IS NULL` = a built-in system scale,
readable by every org and editable by nobody.

| Column | Type | Meaning | Required when | Normalization | Aliases | Key | Display label |
|---|---|---|---|---|---|---|---|
| `id` | `uuid` PK, `gen_random_uuid()` | Scale identity | always | — | — | — | — |
| `organization_id` | `uuid` -> `organizations` `on delete cascade`, nullable | Owner org. NULL = built-in system scale | never (NULL is meaningful) | — | — | — | "Built-in" when NULL |
| `key` | `text not null` | Stable machine key (`apparel_alpha`, `us_mens_shoe`) | always | lower_snake by convention; not enforced | — | — | not shown |
| `name` | `text not null` | Human name | always | — | — | — | Size scale |
| `kind` | `text not null`, CHECK `apparel_alpha \| shoe_numeric \| youth_numeric \| custom` | What shape the scale is | always | closed vocabulary | — | — | Kind |
| `size_system` | `text` nullable | `US_MENS`/`US_WOMENS`/`US_YOUTH`/`UK`/`EU`/`CM`/custom. NULL for apparel | when `kind` is numeric | upper snake by convention | — | — | Size system |
| `description` | `text` nullable | Admin note | never | — | — | — | Description |
| `created_at` / `updated_at` | `timestamptz not null default now()` | Audit stamps (`size_scales_set_updated_at` trigger) | always | — | — | — | — |
| `deleted_at` | `timestamptz` nullable | Soft delete; all indexes are `where deleted_at is null` | never | — | — | — | — |

Uniqueness: `size_scales_owner_key_uniq (organization_id, key) nulls not
distinct where deleted_at is null` — `NULLS NOT DISTINCT` so two system scales
cannot share a key either.

## 2. `size_scale_values` (new table, 0294)

| Column | Type | Meaning | Required when | Normalization | Aliases | Key | Display label |
|---|---|---|---|---|---|---|---|
| `id` | `uuid` PK | Row identity | always | — | — | — | — |
| `size_scale_id` | `uuid not null` -> `size_scales` `on delete cascade` | Owning scale | always | — | — | — | — |
| `value` | `text not null` | The size **as printed**: `XL`, `10.5`, `7`. Youth prints bare numerals, never a `Y` suffix | always | **none — preserved verbatim.** Never auto-converted between systems | — | — | Size |
| `normalized` | `text not null` | Match form. Never shown to a user | always | apparel: `upper(value)`. Numeric: identical to `value` | — | — | not shown |
| `sort_order` | `integer not null` | Display order within the scale. Sizes are ORDERED, not alphabetical | always | apparel: 10..100 (aliases share a neighbouring rank); numeric: `half_steps * 5` | — | — | not shown |
| `is_half` | `boolean not null default false` | True for `.5` sizes | always | derived at seed time | — | — | not shown |
| `created_at` | `timestamptz not null default now()` | — | always | — | — | — | — |

Uniqueness: `unique (size_scale_id, normalized)`.

## 3. `categories` — new columns (0294)

| Column | Type | Meaning | Required when | Normalization | Aliases | Key | Display label |
|---|---|---|---|---|---|---|---|
| `tracking_mode` | `text` nullable, CHECK one of the 7 `TRACKING_MODES` | The category's tracking POLICY. **NULL reads as `QUANTITY`** — the behaviour every existing category already has. A child inherits its parent's mode when its own is NULL (`category_tracking_mode`, one level only) | never | closed vocabulary, must mirror `TRACKING_MODES` | — | — | Tracking mode (`TRACKING_MODE_LABELS`) |
| `size_scale_id` | `uuid` -> `size_scales` `on delete set null` | Which scale this category's items size against. NULL = fall back to `APPAREL_ALPHA_SIZES` | never | — | — | — | Size scale |
| `default_unit_of_measure` | `text` nullable, CHECK `unit \| each \| pair \| set \| case` | Counting unit stamped onto items created here. **PAIR is display only — no conversion anywhere** | never | closed vocabulary, mirrors `COUNTING_UNITS` | `counting_unit` (CSV column) | — | Counting unit; pluralized by `countingUnitLabel` ("12 pairs") |
| `sports_subcategory_key` | `text` nullable | Sports subcategory key (`shoes`, `jerseys`, ...). NULL for every non-sports category, which is every category today | when the category IS a Sports subcategory | one of `SPORTS_SUBCATEGORIES`, or a custom key (1-64 chars) | `subcategory_name` (CSV, resolved by name) | GROUP (slot 1 — it decides the key SHAPE) | Subcategory (`profile.label`) |
| `tracking_profile` | `jsonb` nullable | Full `SubcategoryTrackingProfile` for a CUSTOM subcategory. A partial profile would leave its items with no rules at all | when the subcategory is custom | validated by `trackingProfileSchema` + `trackingProfileConsistencyError` | — | — | edited in the tracking-profile editor |

`categories.parent_id` is NOT new — it has existed dormant since 0002 and is now
the inheritance edge.

## 4. `inventory_items.tracking_type` (widened, 0295)

| Column | Type | Meaning | Required when | Normalization | Aliases | Key | Display label |
|---|---|---|---|---|---|---|---|
| `tracking_type` | `text`, CHECK widened to `none \| lot \| serial \| serial_optional` | The stamped per-item consequence of the category's mode. `post_receipt_v2` reads ONLY this | always (default `none`) | stamped server-side from `MODE_TO_TRACKING_TYPE`; a caller value wins only where the category expresses no policy | `tracking_mode` (CSV column — accepted, bounded, **not applied**) | — | derived from the mode label |

`serial_optional` semantics at receipt: 0..n serials where n <= accepted
quantity. Duplicate serial -> 23505 mapped to a conflict. `none`/`lot`/`serial`
branches are provably unchanged (0296).

## 5. `product_groups` (new table, 0298)

Shared product identity. **Owns no quantity, ever.**

| Column | Type / zod bound | Meaning | Required when | Normalization | Aliases | Key | Display label |
|---|---|---|---|---|---|---|---|
| `id` | `uuid` PK | Group identity | always | — | — | — | — |
| `organization_id` | `uuid not null` -> `organizations` cascade | Owning org. **Immutable** — `tg_pin_product_group_org` (0300) | always | — | — | — | — |
| `category_id` | `uuid` -> `categories` `on delete set null` | The category this group sits under | never | org-verified by `category_in_org` | `category_name` (CSV, by name) | — | Category |
| `subcategory_key` | `text`, zod `max(64)` | Sports subcategory | required by the linking tool (`linkFamilySchema` demands `min(1)`); optional on the base create schema | one of `SPORTS_SUBCATEGORIES` or a custom key | — | GROUP (slot 1) | Subcategory |
| `name` | `text not null`, zod `min(1).max(200).trim()` | Human product name ("Nike Pegasus 41"). **Display only** — identity is `group_key` | always | trimmed | — | GROUP (last-resort fallback slot ONLY, when every identifying slot is blank) | Product group |
| `brand` | `text`, zod `max(120)` | Brand | never | `norm` + `esc` inside the key | `brand` (CSV) | GROUP (shoes slot 2; jerseys slot 6) | Brand |
| `manufacturer` | `text`, zod `max(120)` | Manufacturer, kept INDEPENDENT of brand | never | as above | — | GROUP (jerseys slot 5) | Manufacturer |
| `model` | `text`, zod `max(120)` | Model / product line | never | as above | `model` (CSV) | GROUP (shoes slot 3) | Model |
| `style_number` | `text`, zod `max(64)` | Vendor style number ("FD2722") | never | as above | `style_number` (CSV) | GROUP (shoes slot 4; jerseys slot 7) | Style number |
| `colorway` | `text`, zod `max(64)` | Colourway at GROUP level ("Black/White") | never | as above | `colorway` (CSV) | GROUP (shoes slot 5) | Colorway |
| `team` | `text`, zod `max(120)` | Team / program | never | as above | `team` (CSV) | GROUP (jerseys slot 2) | Team |
| `league` | `text`, zod `max(120)` | League / program | never | as above | — | GROUP (jerseys slot 3) | League |
| `season` | `text`, zod `max(32)` | Season ("2026") | never | as above | `season` (CSV) | GROUP (jerseys slot 4) | Season |
| `home_away` | `text`, CHECK `home \| away \| alternate` | Kit variant | never | closed vocabulary | `home_away` (CSV) | GROUP (jerseys slot 5) | Home / away |
| `color` | `text`, zod `max(64)` | Colour at GROUP level (jerseys/uniforms) | never | as above | — | GROUP (jerseys slot 9) | Color |
| `size_scale_id` | `uuid` -> `size_scales` set null | Scale this group's sizes come from | never | — | — | — | Size scale |
| `default_counting_unit` | `text not null default 'each'`, CHECK `unit \| each \| pair \| set \| case` | Unit every roll-up against this group is expressed in | always | closed vocabulary; zod `.default('each')` | `counting_unit` (CSV) | — | Counting unit |
| `tracking_mode` | `text` nullable, CHECK the 7 modes | Group-level mode note | never | closed vocabulary | — | — | Tracking mode |
| `group_key` | `text not null` | **Deterministic identity.** `buildGroupKey(...)`, server-computed, unique per org | always | injective escaping (`\` -> `\\`, `\|` -> `\\\|`, `=` -> `\\=`) applied to each `norm`ed slot | — | is the GROUP key | not shown |
| `status` | `text not null default 'active'`, CHECK `active \| archived \| discontinued` | Lifecycle | always | closed vocabulary | — | — | Status |
| `created_by` / `updated_by` | `uuid` -> `user_profiles` set null | Actor stamps | never | — | — | — | — |
| `created_at` / `updated_at` | `timestamptz not null default now()` | Audit stamps | always | — | — | — | — |
| `deleted_at` | `timestamptz` nullable | Soft delete | never | — | — | — | — |

Uniqueness: `product_groups_org_key_uniq (organization_id, group_key) where
deleted_at is null`. This is the index a concurrent import converges on through
a real 23505 re-read.

## 6. `inventory_items` — variant columns (0298)

All nullable, ZERO backfill of `group_id` in either direction.

| Column | Type / zod bound | Meaning | Required when | Normalization | Aliases | Key | Display label |
|---|---|---|---|---|---|---|---|
| `group_id` | `uuid` -> `product_groups` `on delete set null` | The group this item is a variant of. **NULL = ungrouped**, which is every item in every org until a human links it. No heuristic ever writes it | never | RLS-pinned to the org (`product_group_in_org`); `sports` module gated in the service | — | — | Product group |
| `variant_size` | `text`, CHECK `length between 1 and 24`; zod `max(24)` | Normalized size for matching and ordering (`10.5`, `XL`) | when the subcategory lists `size` in `requiredAttributes` (shoes, jerseys, uniforms, sports apparel) | `normalizeSizeValue`: upper for alpha; trailing `.0` stripped, halves kept; redundant system prefix stripped only when it agrees with the system. Never converted between systems | `size` (CSV), `custom_fields.size` (legacy, dual-written) | VARIANT (`size=`) | Size |
| `variant_size_original` | `text`; zod `max(64)` | The size **exactly as imported or typed**. Never overwritten by normalization | whenever a size is recorded | **none — verbatim** | — | — | not shown (audit trail for a future approved mapping) |
| `variant_size_system` | `text`; zod enum `US_MENS \| US_WOMENS \| US_YOUTH \| UK \| EU \| CM \| ALPHA \| CUSTOM` | Which system the size is printed in. "A size of 9 means nothing without knowing whether it is US Men, UK or EU" | when the subcategory lists `size_system` (shoes) | upper-cased before the enum on the CSV path | `size_system` (CSV) | VARIANT (`system=`) | Size system |
| `variant_width` | `text`; zod `max(16)` | Shoe width, free text against N/M/W/2E/4E/Standard/Wide/Extra Wide. Deliberately NOT a scale | never | `norm` + `esc` in the key | `width` (CSV) | VARIANT (`width=`) | Width |
| `variant_fit` | `text`; zod `max(32)` | Fit / cut | never | as above | `fit` (CSV) | VARIANT (`fit=`) | Fit |
| `variant_color` | `text`; zod `max(64)` | Colour at VARIANT level, for groups whose variants differ by colour | never | as above | `color` (CSV) | VARIANT (`color=`) | Color |
| `jersey_number` | `text`, CHECK `length between 1 and 4 and ~ '^[0-9]+$'`; zod `/^[0-9]{1,4}$/` | Uniform number. **NOT UNIQUE, never part of any uniqueness key** — the same number legitimately repeats across sizes, groups, teams, seasons and warehouses. **NEVER a serial and never labelled as one** | optional per subcategory (open question 1: `jerseys.requiredAttributes` is `['size']`, not `['size','jersey_number']`) | `normalizeJerseyNumber`: strips leading `#` and whitespace; **leading zeroes preserved** (`0`, `00`, `07`, `7` are four distinct numbers); TEXT always, never an integer | `jersey_number` (CSV); AI header aliases "Jersey #", "Uniform No.", "Player Number", and the ambiguous bare "Number" | VARIANT (`number=`, first slot) | **Jersey number** |
| `player_name` | `text`; zod `max(120)` | Player / wearer | never | `norm` + `esc` if it were keyed | `player_name` (CSV) | VARIANT (`player=`) **in the builder, but no server write path passes it** — see open question 2 | Player |
| `variant_key` | `text` (no length CHECK); zod `max(240)` sanity bound on the derived string | **Deterministic variant identity within the group.** Server-computed ALWAYS; `variantAttributesSchema` does not carry it and zod strips a client-supplied value | whenever the row is sports-resolved OR carries a `group_id` | `buildVariantKey`: named slots `number/player/size/system/width/fit/color`, blanks omitted, `'default'` when empty, each value escaped injectively | — | is the VARIANT key | not shown |

Indexes: `inventory_items_group_idx (group_id)` — **non-partial on purpose**, it
is also what stops a `product_groups` delete from seq-scanning and row-locking
1.2 M items via the FK referential-integrity probe.
`inventory_items_jersey_number_idx (organization_id, jersey_number) where
jersey_number is not null and deleted_at is null` — non-unique by design.

## 7. `po_import_lines` — variant columns (0301)

These carry what the DOCUMENT said, not a normalized form: no trimming, no case
folding, no size-system inference. Matching happens later against the original.

| Column | Type / zod bound | Meaning | Required when | Normalization | Aliases | Key | Display label |
|---|---|---|---|---|---|---|---|
| `variant_size` | `text`; zod `max(64)` | Size read off the document | never | none at this layer | `size` (`PO_SCHEMA.size`) | via matching -> VARIANT | Size |
| `variant_size_original` | `text`; zod `max(256)` | The size **exactly as printed** | never | **none — verbatim** | — | — | not shown |
| `variant_size_system` | `text`; zod `max(32)` (looser than the item enum on purpose — an odd document value must import and go to review) | Size system if the document states one | never | normalized via `asSizeSystem`/`toVariantLine()` on both paths | `sizeSystem` | via matching | Size system |
| `variant_width` | `text`; zod `max(32)` | Width if printed | never | none | `width` | via matching | Width |
| `variant_fit` | `text`; zod `max(32)` | Fit if printed | never | none | — | via matching | Fit |
| `variant_color` | `text`; zod `max(64)` | Colour / colourway if printed | never | none | `colorway` | via matching | Color |
| `jersey_number` | `text`; zod `max(32)` — **deliberately NOT `jerseyNumberSchema`** | Uniform number read off the document, leading zeroes intact. Never written to a serial column, never an identity key here | never | none: `"#12"`, `"12A"` must import and go to review, not fail the parse. A NUMERIC value from the model is **dropped, not stringified** | `jerseyNumber` | via matching -> VARIANT | Jersey number |
| `player_name` | `text`; zod `max(120)` | Player if the line names one | never | none | `playerName` | — | Player |
| `group_hint` | `text`; zod `max(256)` | Free-text style/product identity read off the document ("Nike Pegasus 41 FD2722"). This is what lets several size lines resolve to ONE product | never | none; a candidate group key is built from it | `groupHint` | feeds GROUP resolution | Group |
| `serial_hint` | `text`; zod `max(128)` | **The serial the document PRINTED, verbatim, or NULL.** Never invented, never a placeholder (`N/A`, `0000`), never derived from a jersey number. Exists so a SERIALIZED line can be settled at review; receipt-time enforcement stays the authority | never | **none — verbatim** | `serialNumber` (`PO_SCHEMA`), `serial` (CSV column, accepted + bounded, not applied) | — | Serial |
| `suggested_group_id` | `uuid` -> `product_groups` `on delete set null` | **ADVISORY** group match. Never auto-linked — mirrors `suggested_item_id` (the 0233 suggestion-not-link discipline). A human accepts it in review | never | — | — | — | "Possible existing group" |
| `mapping_confidence` | `numeric(4,3)`; zod `number().min(0).max(1)` | Confidence the AI attached to its COLUMN MAPPING for this line — separate from `extraction_confidence` (how well it read the characters) | never | below `IMPORT_MAPPING_CONFIDENCE_THRESHOLD = 0.7`, a line that actually carries a sports mapping goes to confirmation (`lineNeedsMappingConfirmation`) | `mappingConfidence` | — | Mapping confidence |

Index: `po_import_lines_suggested_group_idx (suggested_group_id) where
suggested_group_id is not null`.

## 8. `size_count_sessions.product_group_id` (0302)

| Column | Type | Meaning | Required when | Normalization | Aliases | Key | Display label |
|---|---|---|---|---|---|---|---|
| `product_group_id` | `uuid` -> `product_groups` `on delete set null` | The product group these counted sizes belong to. Replaces the display-only `style_key`, which is derived from the item NAME and breaks on rename | never | — | supersedes `style_key` (retained, never dropped, still read for existing rows and ungrouped inventory) | — | Product group |

Instant Size Count remains REVIEW-ONLY. Naming a group does not let it write
inventory; groups own no quantity.

## 9. `inventory_items.sports_review_flag` (0303)

| Column | Type | Meaning | Required when | Normalization | Aliases | Key | Display label |
|---|---|---|---|---|---|---|---|
| `sports_review_flag` | `text` nullable, CHECK `ambiguous_size \| sized_but_ungrouped \| name_size_conflict` (added `NOT VALID` then validated, so the 1.2 M-row verify is not inlined on the `ADD COLUMN`) | Marks rows a human should look at. **Never blocks anything and never changes behaviour** — it only populates the review queue at `/dashboard/product-groups/link` | never | closed vocabulary; `name_size_conflict` deliberately overwrites `sized_but_ungrouped` | — | — | Review reason |

Values: `ambiguous_size` = `custom_fields.size` held something unparseable
(empty, over-long, or a non-string JSON value) so `variant_size` stayed NULL;
`sized_but_ungrouped` = has a size, has no group (the linking queue);
`name_size_conflict` = the letter-size token at the end of the item NAME
disagrees with the stored size, compared `upper()` on both sides, letter sizes
only (a numeric shoe run can never be flagged).

Index: `inventory_items_sports_review_idx (organization_id,
sports_review_flag) where sports_review_flag is not null and deleted_at is
null`, built AFTER the backfill so the flag updates keep the HOT path.

---

## 10. `PO_SCHEMA` sports line fields (`apps/web/src/lib/po-scan/extract.ts`)

Nine keys, all OPTIONAL — absent from the schema's `required` array, so a
non-sports PO returns them empty and behaves exactly as before. Eight arrived
with Task 13; `serialNumber` was added with Task 14 (commit `f432e77c`) when
`serial_hint` was folded into the still-unshipped 0301.

Every description instructs the model to leave the field EMPTY rather than
guess. The system prompt closes with a hard rule: "Never invent a serial number,
jersey number, size, quantity, SKU, team or player. If a value is not printed on
the document, return an empty string. A missing value must stay missing."

| `PO_SCHEMA` field | Type | Meaning | Model instruction / required-when | Normalization | Lands in | Display label |
|---|---|---|---|---|---|---|
| `size` | STRING | Size as printed (`10`, `10.5`, `XL`, `US 9`) | "Copy it exactly; do not convert between size systems." Empty if the line has no size | none at extraction | `po_import_lines.variant_size` (+ `_original`) | Size |
| `sizeSystem` | STRING | `US_MENS`/`US_WOMENS`/`US_YOUTH`/`UK`/`EU`/`CM`/`ALPHA` | Only if the document states one — "do NOT guess" | `asSizeSystem` via `toVariantLine()` | `variant_size_system` | Size system |
| `width` | STRING | Shoe width (N, M, W, 2E, 4E, Standard, Wide, Extra Wide) | Empty if not present | none | `variant_width` | Width |
| `colorway` | STRING | Colour / colourway as printed ("Black/White") | Empty if not present | none | `variant_color` | Color |
| `jerseyNumber` | STRING | Uniform / jersey number, **keeping leading zeroes** (`00`, `07`) | Only when the document clearly labels it a jersey/uniform/player number. **A bare "Number" column is ambiguous — leave empty and lower `mappingConfidence` instead. NEVER put a serial number or a quantity here** | none; a numeric value from the model is DROPPED, not coerced | `jersey_number` | Jersey number |
| `playerName` | STRING | Player / wearer if the line names one | "Never invent a name" | none | `player_name` | Player |
| `groupHint` | STRING | The style/product identity as printed — "what lets several size lines resolve to ONE product" | Empty if unclear | none | `group_hint` | Group |
| `serialNumber` | STRING | The serial printed on this line, copied exactly (dashes, letters, leading zeroes) | Only when the document explicitly labels it a serial/IMEI/asset serial. **NEVER a jersey number, quantity, SKU or style number, NEVER invented, and NEVER a placeholder like "N/A" or "0000"** | none — verbatim | `serial_hint` | Serial |
| `mappingConfidence` | NUMBER | Confidence that each value landed in the RIGHT FIELD | "Lower this sharply when a column header is ambiguous (a bare 'Number' could be a jersey number, a quantity, a serial, a style number or a PO line number). This is separate from `confidence`" | bounded 0..1 by `canonicalPoLineSchema`; column is `numeric(4,3)` | `mapping_confidence` | Mapping confidence |

`maxTokens` was raised from 4096 to 8192 because each line now emits these extra
keys, and the same 40-line PO that used to fit would otherwise truncate mid-JSON
and surface as "AI returned non-JSON". It is a ceiling only — output tokens are
billed as generated.

### Ambiguous-column vocabulary

When `mapping_confidence < 0.7` on a line that carries a sports mapping, the
review step asks a human what the column meant. The options are
`AMBIGUOUS_COLUMN_MEANINGS`: `jersey_number`, `quantity`, `serial`,
`style_number`, `line_number`, `ignore`. Nothing is ever chosen automatically.

---

## 11. CSV template columns and how they map

`TEMPLATE_HEADER` (`apps/web/src/components/inventory/csv-import.tsx`), validated
by `csvRowSchema` (`apps/web/src/server/actions/import.ts`).

**Applied to the created item** (`APPLIED_COLUMNS`): `name`, `sku`, `barcode`,
`description`, `unit_cost`, `retail_price`, `quantity_on_hand`, `reorder_point`,
`reorder_quantity`, `unit_of_measure`, `size`, `size_system`, `width`, `fit`,
`color`, `jersey_number`, `player_name`.

**Accepted, bounded, and deliberately NOT applied** — creating product groups
from a CSV is bulk identity creation, and the owner ruled that families link
through the review tool: `brand`, `model`, `style_number`, `colorway`, `team`,
`season`, `home_away`, `counting_unit`, `tracking_mode`, `serial`, `asset_tag`.
The UI states this; Task 18's linking tool is what consumes them.

`size_system` is case-folded (`us_mens` -> `US_MENS`) before the shared enum sees
it — the VALUE set is still the shared one, this widens nothing.
`jersey_number` reuses `jerseyNumberSchema`, so `07` stays `07` and `12A` is
REJECTED with a row error rather than imported wrong.

Known behaviour change carried from Task 13, flagged and unfixed: a generic CSV
row with an oversized `size`/`width` or a non-digit `jersey_number` now FAILS the
row where those values used to be silently stripped
(`apps/web/src/server/actions/import.ts:36-43`).

---

## 12. Fields this program deliberately did not add

- **No `upc` CSV column.** `barcode` is the repo's field; nothing was renamed.
- **No width scale.** Width is free text (`variant_width`), not a
  `size_scales` row.
- **No `asset_tag` column.** The CSV accepts and bounds the header; a per-unit
  identifier rides `serial_registry.serial_number` as it always has.
- **No alias mapping between `XXL` and `2XL`.** The seeded apparel scale holds
  both spellings so nothing that renders today stops rendering, and
  `size-order.ts` ranks them adjacently, but declaring them the same variant
  would merge stock. Unresolved — see the verification report's open questions.
- **No jersey-number uniqueness constraint of any kind.**
- **No group-level quantity column.** See the model doc, §2.
