# Sports Inventory Model — Requirements (owner master prompt, 2026-07-27)

Condensed faithfully from the owner's master prompt. Every rule, list and DoD
item is preserved; only redundant prose/examples were trimmed. This is the
requirements source for the multi-phase Sports program.

## Core architecture

Separate: **Product/Item Group → Variant → optional Individual Physical Unit.**
- Group = shared product identity (Nike Pegasus 41; Falcons Home Jersey; Dell
  Chromebook 3100).
- Variant = attribute combination (size/width/fit/colorway; jerseyNumber/size).
- Unit = only for individually-tracked stock (serialized Chromebook, tagged
  helmet). NEVER one unit row per ordinary shoe pair/jersey.

## Tracking modes (names may adapt to repo conventions)

`SERIALIZED · QUANTITY · QUANTITY_BY_VARIANT · NUMBERED_VARIANT ·
INDIVIDUALLY_TAGGED · LOT_TRACKED · OPTIONAL_SERIALIZED`
- Not a single isSerialized boolean; provide backward-compatible mapping for
  existing records.

## Sports category rule

- Category "Sports" REQUIRES a Sports subcategory. Initial set: Shoes, Jerseys,
  Uniforms, Sports Apparel, Protective Equipment, Balls, Training Equipment,
  Other Sports Equipment. Admins can add more (custom subcategory MUST carry a
  full tracking profile: default mode, serial requirement, supported/required
  attributes, counting unit, numbers/sizes/colors support, individual tracking
  allowed).
- Default modes: Shoes=QUANTITY_BY_VARIANT; Jerseys=NUMBERED_VARIANT;
  Uniforms/Apparel=QUANTITY_BY_VARIANT; Protective=OPTIONAL_SERIALIZED;
  Balls=QUANTITY or OPTIONAL_SERIALIZED; Training=OPTIONAL_SERIALIZED;
  Other=org-configurable. Defaults configurable.

## Sports-only serial exception

Relaxed serial rules apply ONLY when: category=Sports AND valid subcategory AND
profile permits non-serialized AND org hasn't overridden to individual tracking.
Existing categories keep current behavior (Electronics stays serial-required
where it is today). SERVER-side enforcement; never trust the form.

## Grouping rules

- Serial number is NEVER group identity. Explicit group + variant keys.
- Shoe group ~ (org, brand, product/model, style number, colorway, subcat);
  variant ~ (group, size_system, size, width, fit[, colorway]).
- Jersey group ~ (org, team, league/program, style, home/away, season, mfr,
  color); variant ~ (group, jerseyNumber, size, fit, color).
- Verify against the real data model before adopting keys.

## Jersey numbers

Dedicated field (jerseyNumber/uniformNumber — repo-fit name). NOT stored in
serial/asset-tag/name/notes. Normalized TEXT preserving meaningful leading
zeroes (0, 00, 07, 12, 99). Validate length/charset/blank/org formats. NO
global uniqueness — same number may repeat across sizes, groups, teams,
seasons, warehouses.

## Shoe sizes

Structured fields: size value, size system (US Men/US Women/US Youth/UK/EU/CM/
custom), width (N/M/W/2E/4E/Standard/Wide/Extra Wide), gender/fit, youth/adult.
Keep original imported text + normalized form; never auto-convert between
systems without an approved mapping; half sizes supported.

## Counting unit

`PAIR · EACH · SET · CASE`. Shoes default PAIR. Never silently convert
pairs<->each. Display the unit ("12 pairs"). Transactions preserve the unit.

## Data model sketch (adapt to real schema; NO parallel inventory system)

ItemGroup(id, org, category, subcategory, name, brand, mfr, model,
style_number, tracking_mode, default_counting_unit, status). Variant(id,
group_id, sku, upc, barcode, size, size_system, width, fit, color, colorway,
jersey_number, player_name, team, season, home_away, counting_unit,
variant_key, status). InventoryUnit(variant_id, serial, asset_tag, barcode,
rfid, condition, status, warehouse, location) — individually tracked only.
Balance(variant, warehouse, location, on_hand/available/reserved/damaged).

## Serial rules

- Serialized modes: unique within org-defined scope; blanks rejected;
  duplicates blocked/reviewed; normalization intact; import idempotent.
- Quantity variants: serial not required, not part of grouping, nulls never
  trigger duplicate errors. NEVER fake placeholders (N/A, 0000, NO SERIAL).
- Optional-serialized: mixed unit-level + quantity must not double-count;
  changing tracking mode after transactions requires controlled migration
  (elevated permission, preflight, reconciliation, confirmation, audit reason).

## Add Item UX (web + Expo, shared rules)

Category → (Sports ⇒ required subcategory) → load tracking profile →
subcategory-appropriate fields → authorized mode override → **grouping preview**
("Product group / Variant / Tracking / Counting unit / Serial: not required")
→ validate → save. Shoe fields incl. brand/model/style/colorway/size system/
size/width/fit/unit/SKU/UPC/qty; serial hidden-or-optional. Jersey fields incl.
team/program/style/season/home-away/number/player/size/fit/color/qty; NEVER
label the number field "Serial Number".

## CSV import + AI

- Template gains the sports columns (category, subcategory, brand, model,
  style, team, season, home/away, jersey number, player, size, size system,
  width, fit, color(way), counting unit, tracking mode, sku/upc/barcode,
  serial, asset tag, qty, warehouse, location).
- Importer: detect Sports → resolve subcategory → tracking profile → normalize
  attributes → match group → match-or-create variant → serials only when
  required → quantity in safely → idempotent → every decision visible in
  review.
- AI mapping: "Jersey #/Uniform No./Player Number/Number" → jerseyNumber etc.,
  CONTEXT-AWARE ("Number" is ambiguous: jersey/qty/serial/style/PO-line). Never
  silently guess: show candidate mappings + confidence, require confirmation,
  preserve source values, block import until required mappings resolved. AI may
  SUGGEST category/subcategory/tracking/fields but never invent serials,
  numbers, sizes, quantities, SKUs, teams, players. Missing stays missing.
- Review table: Source Row / Category / Subcategory / Group / Variant /
  Tracking / Qty / Serial status / Result — results like Create New Group, Add
  New Variant, Receive into Existing Variant, Create Serialized Units, Possible
  Duplicate, Missing Required Attribute, Ambiguous Category/Subcategory, Serial
  Required, Ready. Not just Valid/Invalid.
- Matching deterministic (keys above), never name-string-only, ambiguous →
  review, never auto-merge uncertain matches.
- Idempotency: batch id + source-row identity + idempotency key + org scope +
  resulting txn id. Distinguish same-request retry from an intentional second
  shipment — never permanently block a file hash.

## Ops flows

Must work through POs (size-run receiving: per-size ordered/received), PO
imports, receiving, partial receiving, cancellations, returns, transfers,
adjustments, cycle counts (count by variant; barcode variant lookup; no serial
scan for ordinary pairs/jerseys), orders/picking, reporting. Barcode scope is
explicit (group vs variant vs unit); scanning a variant barcode adds/counts
that variant. Lists show group rollups ("6 variants · 52 pairs total") with
per-variant expansion; no blank serial columns for quantity products; tracking
mode visible in admin views. Every quantity change is an audited inventory
transaction (org, group, variant, unit?, warehouse, location, prev qty, delta,
new qty, unit, type, source, user, ts, batch, PO ref) — never a direct update.

## AuthZ

Permission checks for: creating sports categories/subcats, changing tracking
profiles, importing, resolving ambiguity, overriding grouping, changing
tracking mode, adjusting inventory, creating serialized units. Never trust
client-supplied org/warehouse/category/mode ids.

## Error codes (mapped to user title/explanation/action/severity/analytics)

SPORTS_SUBCATEGORY_REQUIRED · TRACKING_MODE_NOT_ALLOWED ·
SERIAL_NUMBER_REQUIRED · SERIAL_NUMBER_NOT_ALLOWED_FOR_GROUPED_IMPORT ·
JERSEY_NUMBER_INVALID · SHOE_SIZE_REQUIRED · SHOE_SIZE_SYSTEM_REQUIRED ·
COUNTING_UNIT_REQUIRED · VARIANT_ALREADY_EXISTS ·
POSSIBLE_PRODUCT_GROUP_DUPLICATE · AMBIGUOUS_VARIANT_MATCH ·
IMPORT_MAPPING_REVIEW_REQUIRED · TRACKING_MODE_CHANGE_REQUIRES_MIGRATION

## Audit events

SPORTS_ITEM_GROUP_CREATED/MATCHED · SPORTS_VARIANT_CREATED/IMPORTED ·
SPORTS_IMPORT_MAPPING_CONFIRMED · SPORTS_IMPORT_MATCH_OVERRIDDEN ·
TRACKING_MODE_CHANGED · SERIALIZED_UNIT_CREATED · INVENTORY_QUANTITY_RECEIVED
(actor, org, warehouse, group, variant, batch, before/after, reason, ts).

## Tests (required)

Unit: category/subcat rules, default profiles, serial resolution, shoe/jersey
variant keys, jersey-number + size normalization, counting units, AI mapping,
matching, dup detection, idempotency, mode transitions.
Integration: serialized Chromebook still requires serial (import w/o serial
BLOCKED); shoe group + sizes 9/10/11 with no serials, one group, per-size qty,
no fake serial rows; jersey #12 in M(3) + XL(2) both allowed, number ≠ serial,
total 5, per-size retained; same number across groups; CSV shoes+jerseys; AI
ambiguous "Number" column asks for review; bulk import; PO import; receiving;
transfer; cycle count; return; adjustment.

## Phases

1 Audit (start with how Chromebooks group model+serials today) · 2 tracking-
mode foundation + category policies + server validation · 3 group/variant/unit
model + attributes + counting units + indexes · 4 Add Item web+Expo + preview ·
5 CSV+AI import (mapping, confidence review, matching, idempotency) · 6 ops
flows (PO/receiving/transfer/counts/orders/reporting) · 7 migration + verify
(web, Expo iOS/Android, prod-like imports). Backward compat: existing
serialized stay serialized, grouped stay grouped; never infer Sports subcats
for old records without evidence; flag ambiguous for review.

## Deliverables

Root-cause current-model report · final inventory model doc · field dictionary
(meaning/type/required/normalization/aliases/grouping/display) · import
mappings incl. AI confidence states · migration report (schema, backfills,
ambiguous, rollback) · files changed · REAL test results (never claim untested)
· remaining policy decisions (jersey grouping by player? number required?
size systems? colorway group-vs-variant? subcat serial overrides? high-value
jerseys individually tagged?).

## Definition of Done (abridged, all binding)

Sports category with required subcats; shoes/jerseys grouped without serials;
per-variant quantities; size structured (not name-only); PAIR counting; jersey
number separate from serial, repeatable across sizes/groups; existing
categories unaffected; custom subcats need profiles; CSV+AI sports-aware with
review + no invention; deterministic matching; idempotent imports; PO receiving
preserves variant quantities; counts support variants; web+Expo share rules;
auditable transactions; mode changes require migration; safe data migration;
tests cover shoes+jerseys+existing serialized.
