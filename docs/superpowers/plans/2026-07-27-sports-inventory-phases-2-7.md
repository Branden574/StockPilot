# Sports Inventory — Implementation Plan, Phases 2-7

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make StockPilot express sports products — a shoe style with per-size quantities and no serials, a jersey style with (number, size) variants — without building a parallel inventory system, without changing behaviour for any existing org, and without weakening the serial rules Electronics depends on.

**Architecture:** `inventory_items` stays the ONLY stock-bearing entity. The hierarchy is laid OVER it:

| Layer | Storage | Note |
|---|---|---|
| GROUP | new `product_groups` table | Owns NO quantity, ever |
| VARIANT | existing `inventory_items` rows | A SKU family under a group; one or more placement rows per SKU (Model B) |
| UNIT | existing `serial_registry` rows | Individually-tracked stock only |

Tracking policy moves onto `categories` (`tracking_mode`, `size_scale_id`, `default_unit_of_measure`), inherited by subcategories through the DORMANT `categories.parent_id` that has existed since 0002. The category mode stamps `inventory_items.tracking_type` at creation, so `post_receipt_v2`'s proven enforcement seam is unchanged apart from ONE new branch for a new `'serial_optional'` value. Everything is packaged as a self-contained `sports` premium module.

**Tech Stack:** TypeScript, Next.js 16 App Router (RSC + server actions), React, Expo/React Native, Supabase Postgres + RLS, zod (`packages/core`), vitest, pgTAP.

---

## Global Constraints

These are copied verbatim in substance from `docs/superpowers/specs/2026-07-27-sports-inventory-requirements.md` and `docs/superpowers/specs/2026-07-27-sports-inventory-phase1-report.md`. They are binding on every task.

1. **The ledger invariant is absolute:** `SUM(stock_movements.quantity_change) = inventory_items.quantity_on_hand`. "Every quantity change is an audited inventory transaction — never a direct update." No task may write `quantity_on_hand` outside `adjust_stock` / `apply_level_delta` / the existing create-time `initial` movement pattern.
2. **`product_groups` own NO quantity, ever.** A group is identity only. Any total shown against a group is a derived roll-up of its variants' `quantity_on_hand`, computed at read time. Never a stored column.
3. **`group_id` is nullable so existing orgs are unaffected.** `null = untouched non-sports orgs`. No NOT NULL, no default that back-fills.
4. **Jersey number: non-unique normalized TEXT preserving leading zeroes** (`0`, `00`, `07`, `12`, `99`). "Serial number is NEVER group identity." "NO global uniqueness — same number may repeat across sizes, groups, teams, seasons, warehouses." It is NEVER stored in serial/asset-tag/name/notes, and the field is NEVER labelled "Serial Number".
5. **PAIR is a uom display convention. No conversions.** Owner decision 2026-07-27: "Category default uom 'pair'; every shoe quantity means pairs and every surface says so. No conversion logic; ledger invariants untouched." "Never silently convert pairs<->each."
6. **Opt-in group linking. NO name-heuristic backfill.** Owner decision 2026-07-27: "New items group at creation; existing families link via a bulk review tool the owner drives. Display heuristics remain as fallback. NO name-heuristic auto-backfill." Because "a name-heuristic backfill would bake wrong groupings into persistent identity."
7. **Self-contained `sports` module, NO `lot_serial` dependency.** Owner decision 2026-07-27: the `sports` entitlement "enables group/variant UI and grants its own serial modes for sports categories, with NO lot_serial dependency (that module stays grandfathered OFF and untouched)."
8. **Migrations reach prod via `supabase db push --linked` BEFORE any dependent web deploy.** Pending migrations crash pages. Project ref `xizpqmhhslgzbuqtjubv`.
9. **pgTAP is required** for every migration. Local runs need `supabase db reset && pnpm db:test` — a bare `pnpm db:test` runs against a stale schema and produces false failures. CI job `db-tests` gates `main`.
10. **Web and mobile share the zod rules.** "web+Expo share rules." Mobile's `app/item/new.tsx` currently re-implements creation with raw Supabase writes and no shared zod — this plan MOVES it onto the shared schemas (Task 10). Every web feature ships native too.
11. **Sports-only serial exception is SERVER-side; never trust the form.** Relaxed serial rules apply ONLY when: category=Sports AND valid subcategory AND profile permits non-serialized AND the org hasn't overridden to individual tracking. "Existing categories keep current behavior (Electronics stays serial-required where it is today)."
12. **NEVER fake serial placeholders** (`N/A`, `0000`, `NO SERIAL`). Quantity variants have no serial; nulls never trigger duplicate errors.
13. **Matching is deterministic and never name-string-only.** Ambiguous matches go to review. Never auto-merge uncertain matches. AI may SUGGEST but never invent serials, numbers, sizes, quantities, SKUs, teams, players. Missing stays missing.
14. **Backward compatibility:** existing serialized items stay serialized, grouped stay grouped. Never infer Sports subcategories for old records without evidence; flag ambiguous for review.
15. **No emojis** anywhere — code, copy, commits, PR bodies, release notes.
16. **No Claude/Anthropic co-author trailer** on any commit. History is `Branden574` only.
17. **Live verification in StockPilot Demo Co** (`71b27a4a-7948-4638-bc3f-535974713bd2`), web and mobile, before any phase is called done. Never claim untested.

### Required regression assertions (from the requirements doc, §Tests)

Every task that touches a shared surface must keep these three green:

- **R1 — Electronics import without serial still BLOCKED.** A `tracking_type='serial'` item receiving `qty_accepted > 0` with no serials still raises `serials_required`; with a wrong count still raises `serial_count_mismatch`.
- **R2 — Shoe sizes 9/10/11 form ONE group with no fake serials.** Three variants, one `product_groups` row, per-size quantity, zero `serial_registry` rows.
- **R3 — Jersey #12 in M(3) + XL(2) totals 5.** Two variants sharing one `jersey_number`, per-size quantities retained, group roll-up = 5, number is not a serial.

### Shared surfaces requiring regression steps

`post_receipt_v2` · `createItemSchema` · every `tracking_type` enumerator · `duplicate_inventory_item` · the PO-import create path (`po-imports-lines.ts` create branch, its `use_existing` sibling branch, and `po-imports.ts` `approve()` sibling branch).

---

## Migration ledger

Next free number is **0294** (highest existing is `0293_b2b_portal_pricing_mode_backfill.sql`).

| Migration | Contents | Task |
|---|---|---|
| `0294_category_tracking_profiles.sql` | `categories.tracking_mode` / `size_scale_id` / `default_unit_of_measure`; `size_scales` + `size_scale_values` | 2 |
| `0295_tracking_type_serial_optional.sql` | Widen the `inventory_items.tracking_type` CHECK | 3 |
| `0296_post_receipt_v2_serial_optional.sql` | `post_receipt_v2` sixth rewrite | 3 |
| `0297_sports_module.sql` | Grandfather + seed `sports`; `sports:manage` permission rows | 4 |
| `0298_product_groups_and_variants.sql` | `product_groups`; `inventory_items` variant columns | 5 |
| `0299_duplicate_inventory_item_variants.sql` | `duplicate_inventory_item` carries the new columns | 6 |
| `0301_po_import_line_variants.sql` | `po_import_lines` variant columns | 13 |
| `0302_size_count_product_group.sql` | `size_count_sessions.product_group_id` | 17 |
| `0303_variant_size_backfill.sql` | Dual-write backfill from `custom_fields.size` + ambiguity flags | 19 |

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `packages/core/src/sports/tracking-modes.ts` | Mode vocabulary, subcategory profiles, mode->tracking_type map, error codes | 1 |
| `packages/core/src/sports/variant-keys.ts` | Jersey/size normalizers, group + variant key builders | 7 |
| `packages/core/src/schemas/sports.ts` | `productGroupSchema`, sports fields for item create | 7 |
| `packages/core/src/schemas/inventory.ts` | `createItemSchema` gains the sports fields | 7 |
| `packages/core/src/modules/registry.ts` | `sports` module entry | 4 |
| `packages/core/src/constants/permissions.ts` | `sports:manage` | 4 |
| `apps/web/src/server/services/product-groups.ts` | `ProductGroupsService` | 8 |
| `apps/web/src/server/services/sports-profiles.ts` | Server-side tracking-profile resolver | 8 |
| `apps/web/src/server/services/inventory.ts` | `create()` threads group/variant fields | 8 |
| `apps/web/src/app/api/v1/items/route.ts` | `POST` — the mobile create seam | 9 |
| `apps/mobile/app/item/new.tsx` | Moved onto shared zod + the new endpoint (PARITY FIX) | 10 |
| `apps/web/src/components/inventory/item-form.tsx` | Sports fields + grouping preview | 11 |
| `apps/web/src/components/inventory/grouping-preview.tsx` | The preview card | 11 |
| `apps/web/src/components/categories/categories-manager.tsx` | Subcategories + tracking profiles | 12 |
| `apps/web/src/lib/po-scan/extract.ts` | `PO_SCHEMA` variant fields | 13 |
| `apps/web/src/server/services/po-imports-variants.ts` | Group-first matching | 14 |
| `apps/web/src/components/po-imports/po-import-detail.tsx` | Review table result vocabulary | 14 |
| `apps/web/src/server/services/product-group-linking.ts` | Opt-in linking review tool | 18 |

---

# Phase 2 — Tracking-mode foundation

## Task 1: Sports tracking-mode vocabulary (pure core)

Pure TypeScript with no platform imports, so web, mobile and the server all read ONE definition of the modes, the subcategory profiles and the error codes. Nothing else in the plan can be written until these names exist.

**Files:**
- Create: `packages/core/src/sports/tracking-modes.ts`
- Create: `packages/core/src/sports/tracking-modes.test.ts`
- Modify: `packages/core/src/index.ts` (add `export * from './sports/tracking-modes';`)

**Interfaces:**
- Produces for Tasks 2, 3, 4, 7, 8, 11, 12, 13, 14: `TRACKING_MODES`, `TrackingMode`, `trackingTypeForMode(mode: TrackingMode): TrackingTypeValue`, `TrackingTypeValue`, `SPORTS_SUBCATEGORIES`, `SportsSubcategoryKey`, `SubcategoryTrackingProfile`, `DEFAULT_SUBCATEGORY_PROFILES`, `COUNTING_UNITS`, `CountingUnit`, `SPORTS_ERROR_CODES`, `SportsErrorCode`.
- Consumes: nothing.

**Steps:**

- [ ] Create `packages/core/src/sports/tracking-modes.ts`:

```ts
/**
 * Sports tracking-mode vocabulary — the ONE definition shared by web, Expo and
 * the server. Modes describe a CATEGORY's policy; `tracking_type` on an item is
 * the stamped consequence (see `trackingTypeForMode`). Keeping the two separate
 * is what lets post_receipt_v2's proven enforcement seam stay untouched: the RPC
 * still only ever reads inventory_items.tracking_type.
 */

/** Category-level policy. Requirements doc, "Tracking modes". */
export const TRACKING_MODES = [
  'QUANTITY',
  'QUANTITY_BY_VARIANT',
  'NUMBERED_VARIANT',
  'SERIALIZED',
  'OPTIONAL_SERIALIZED',
  'INDIVIDUALLY_TAGGED',
  'LOT_TRACKED',
] as const;
export type TrackingMode = (typeof TRACKING_MODES)[number];

/** The per-item column values. 'serial_optional' is added by migration 0295. */
export const TRACKING_TYPE_VALUES = ['none', 'lot', 'serial', 'serial_optional'] as const;
export type TrackingTypeValue = (typeof TRACKING_TYPE_VALUES)[number];

/**
 * Category mode -> per-item tracking_type. This is the ONLY mapping; the server
 * stamps items with it at creation and nothing downstream re-derives it.
 *
 * INDIVIDUALLY_TAGGED maps to 'serial' on purpose: a tagged helmet is a unit
 * with a mandatory identifier, and the asset tag rides serial_registry.
 */
const MODE_TO_TRACKING_TYPE: Record<TrackingMode, TrackingTypeValue> = {
  QUANTITY: 'none',
  QUANTITY_BY_VARIANT: 'none',
  NUMBERED_VARIANT: 'none',
  SERIALIZED: 'serial',
  OPTIONAL_SERIALIZED: 'serial_optional',
  INDIVIDUALLY_TAGGED: 'serial',
  LOT_TRACKED: 'lot',
};

export function trackingTypeForMode(mode: TrackingMode): TrackingTypeValue {
  return MODE_TO_TRACKING_TYPE[mode];
}

/** True when the mode expects more than one variant row under one group. */
export function modeHasVariants(mode: TrackingMode): boolean {
  return mode === 'QUANTITY_BY_VARIANT' || mode === 'NUMBERED_VARIANT';
}

/** Counting unit. PAIR is a DISPLAY convention — never a conversion factor. */
export const COUNTING_UNITS = ['each', 'pair', 'set', 'case', 'unit'] as const;
export type CountingUnit = (typeof COUNTING_UNITS)[number];

/** Plural display label for a counting unit ("12 pairs"). */
export function countingUnitLabel(unit: CountingUnit, quantity: number): string {
  if (unit === 'each') return quantity === 1 ? 'each' : 'each';
  if (unit === 'box' as CountingUnit) return quantity === 1 ? 'box' : 'boxes';
  return quantity === 1 ? unit : `${unit}s`;
}

/** The initial Sports subcategory set. Admins may add more (Task 12). */
export const SPORTS_SUBCATEGORIES = [
  'shoes',
  'jerseys',
  'uniforms',
  'sports_apparel',
  'protective_equipment',
  'balls',
  'training_equipment',
  'other_sports_equipment',
] as const;
export type SportsSubcategoryKey = (typeof SPORTS_SUBCATEGORIES)[number];

/**
 * A full tracking profile. A CUSTOM subcategory must carry all of these too
 * (requirements: "custom subcategory MUST carry a full tracking profile").
 */
export interface SubcategoryTrackingProfile {
  key: string;
  label: string;
  defaultMode: TrackingMode;
  /** Modes an authorized user may override to for this subcategory. */
  allowedModes: TrackingMode[];
  /** Attributes the UI offers. */
  supportedAttributes: SportsAttribute[];
  /** Attributes the SERVER rejects a create without. */
  requiredAttributes: SportsAttribute[];
  defaultCountingUnit: CountingUnit;
  supportsNumbers: boolean;
  supportsSizes: boolean;
  supportsColors: boolean;
  /** Whether an org may escalate this subcategory to INDIVIDUALLY_TAGGED. */
  individualTrackingAllowed: boolean;
}

export const SPORTS_ATTRIBUTES = [
  'brand',
  'model',
  'style_number',
  'colorway',
  'size',
  'size_system',
  'width',
  'fit',
  'jersey_number',
  'player_name',
  'team',
  'league',
  'season',
  'home_away',
  'color',
] as const;
export type SportsAttribute = (typeof SPORTS_ATTRIBUTES)[number];

export const DEFAULT_SUBCATEGORY_PROFILES: Record<
  SportsSubcategoryKey,
  SubcategoryTrackingProfile
> = {
  shoes: {
    key: 'shoes',
    label: 'Shoes',
    defaultMode: 'QUANTITY_BY_VARIANT',
    allowedModes: ['QUANTITY_BY_VARIANT', 'QUANTITY', 'OPTIONAL_SERIALIZED'],
    supportedAttributes: [
      'brand', 'model', 'style_number', 'colorway',
      'size', 'size_system', 'width', 'fit',
    ],
    requiredAttributes: ['size', 'size_system'],
    defaultCountingUnit: 'pair',
    supportsNumbers: false,
    supportsSizes: true,
    supportsColors: true,
    individualTrackingAllowed: false,
  },
  jerseys: {
    key: 'jerseys',
    label: 'Jerseys',
    defaultMode: 'NUMBERED_VARIANT',
    allowedModes: ['NUMBERED_VARIANT', 'QUANTITY_BY_VARIANT', 'INDIVIDUALLY_TAGGED'],
    supportedAttributes: [
      'team', 'league', 'season', 'home_away', 'brand', 'style_number',
      'jersey_number', 'player_name', 'size', 'size_system', 'fit', 'color',
    ],
    requiredAttributes: ['size'],
    defaultCountingUnit: 'each',
    supportsNumbers: true,
    supportsSizes: true,
    supportsColors: true,
    individualTrackingAllowed: true,
  },
  uniforms: {
    key: 'uniforms',
    label: 'Uniforms',
    defaultMode: 'QUANTITY_BY_VARIANT',
    allowedModes: ['QUANTITY_BY_VARIANT', 'NUMBERED_VARIANT', 'QUANTITY'],
    supportedAttributes: [
      'team', 'league', 'season', 'brand', 'style_number',
      'size', 'size_system', 'fit', 'color',
    ],
    requiredAttributes: ['size'],
    defaultCountingUnit: 'set',
    supportsNumbers: true,
    supportsSizes: true,
    supportsColors: true,
    individualTrackingAllowed: false,
  },
  sports_apparel: {
    key: 'sports_apparel',
    label: 'Sports apparel',
    defaultMode: 'QUANTITY_BY_VARIANT',
    allowedModes: ['QUANTITY_BY_VARIANT', 'QUANTITY'],
    supportedAttributes: ['brand', 'model', 'style_number', 'size', 'size_system', 'fit', 'color'],
    requiredAttributes: ['size'],
    defaultCountingUnit: 'each',
    supportsNumbers: false,
    supportsSizes: true,
    supportsColors: true,
    individualTrackingAllowed: false,
  },
  protective_equipment: {
    key: 'protective_equipment',
    label: 'Protective equipment',
    defaultMode: 'OPTIONAL_SERIALIZED',
    allowedModes: ['OPTIONAL_SERIALIZED', 'INDIVIDUALLY_TAGGED', 'QUANTITY_BY_VARIANT', 'QUANTITY'],
    supportedAttributes: ['brand', 'model', 'style_number', 'size', 'size_system', 'color'],
    requiredAttributes: [],
    defaultCountingUnit: 'each',
    supportsNumbers: false,
    supportsSizes: true,
    supportsColors: true,
    individualTrackingAllowed: true,
  },
  balls: {
    key: 'balls',
    label: 'Balls',
    defaultMode: 'QUANTITY',
    allowedModes: ['QUANTITY', 'OPTIONAL_SERIALIZED', 'QUANTITY_BY_VARIANT'],
    supportedAttributes: ['brand', 'model', 'style_number', 'size', 'color'],
    requiredAttributes: [],
    defaultCountingUnit: 'each',
    supportsNumbers: false,
    supportsSizes: true,
    supportsColors: true,
    individualTrackingAllowed: false,
  },
  training_equipment: {
    key: 'training_equipment',
    label: 'Training equipment',
    defaultMode: 'OPTIONAL_SERIALIZED',
    allowedModes: ['OPTIONAL_SERIALIZED', 'QUANTITY', 'INDIVIDUALLY_TAGGED'],
    supportedAttributes: ['brand', 'model', 'style_number', 'color'],
    requiredAttributes: [],
    defaultCountingUnit: 'each',
    supportsNumbers: false,
    supportsSizes: false,
    supportsColors: true,
    individualTrackingAllowed: true,
  },
  other_sports_equipment: {
    key: 'other_sports_equipment',
    label: 'Other sports equipment',
    // "Other=org-configurable" — QUANTITY is the safe floor; every mode is
    // reachable by an authorized override.
    defaultMode: 'QUANTITY',
    allowedModes: [...TRACKING_MODES],
    supportedAttributes: [...SPORTS_ATTRIBUTES],
    requiredAttributes: [],
    defaultCountingUnit: 'each',
    supportsNumbers: true,
    supportsSizes: true,
    supportsColors: true,
    individualTrackingAllowed: true,
  },
};

/** Error codes mapped to user title/explanation/action/severity in the UI. */
export const SPORTS_ERROR_CODES = [
  'SPORTS_SUBCATEGORY_REQUIRED',
  'TRACKING_MODE_NOT_ALLOWED',
  'SERIAL_NUMBER_REQUIRED',
  'SERIAL_NUMBER_NOT_ALLOWED_FOR_GROUPED_IMPORT',
  'JERSEY_NUMBER_INVALID',
  'SHOE_SIZE_REQUIRED',
  'SHOE_SIZE_SYSTEM_REQUIRED',
  'COUNTING_UNIT_REQUIRED',
  'VARIANT_ALREADY_EXISTS',
  'POSSIBLE_PRODUCT_GROUP_DUPLICATE',
  'AMBIGUOUS_VARIANT_MATCH',
  'IMPORT_MAPPING_REVIEW_REQUIRED',
  'TRACKING_MODE_CHANGE_REQUIRES_MIGRATION',
] as const;
export type SportsErrorCode = (typeof SPORTS_ERROR_CODES)[number];

export interface SportsErrorMeta {
  title: string;
  explanation: string;
  action: string;
  severity: 'error' | 'warning' | 'info';
}

export const SPORTS_ERROR_META: Record<SportsErrorCode, SportsErrorMeta> = {
  SPORTS_SUBCATEGORY_REQUIRED: {
    title: 'Pick a Sports subcategory',
    explanation: 'Sports items are grouped by subcategory (Shoes, Jerseys, and so on).',
    action: 'Choose a subcategory, then continue.',
    severity: 'error',
  },
  TRACKING_MODE_NOT_ALLOWED: {
    title: 'That tracking mode is not allowed here',
    explanation: 'This subcategory does not permit the selected mode.',
    action: 'Pick a mode this subcategory allows, or change the subcategory.',
    severity: 'error',
  },
  SERIAL_NUMBER_REQUIRED: {
    title: 'Serial number required',
    explanation: 'This item is serialized, so every unit needs its own serial.',
    action: 'Enter one serial per unit received.',
    severity: 'error',
  },
  SERIAL_NUMBER_NOT_ALLOWED_FOR_GROUPED_IMPORT: {
    title: 'Serials are not used for this product',
    explanation: 'Quantity variants are counted, not serialized. Placeholder serials are never accepted.',
    action: 'Remove the serial column, or change the tracking mode.',
    severity: 'error',
  },
  JERSEY_NUMBER_INVALID: {
    title: 'Check the jersey number',
    explanation: 'A jersey number is 1-4 characters, digits only, and keeps leading zeroes.',
    action: 'Correct the number, or leave it blank.',
    severity: 'error',
  },
  SHOE_SIZE_REQUIRED: {
    title: 'Size required',
    explanation: 'Shoes are tracked per size, so each variant needs its own size.',
    action: 'Enter a size for every variant.',
    severity: 'error',
  },
  SHOE_SIZE_SYSTEM_REQUIRED: {
    title: 'Size system required',
    explanation: 'A size of 9 means nothing without knowing whether it is US Men, UK or EU.',
    action: 'Pick the size system this run is printed in.',
    severity: 'error',
  },
  COUNTING_UNIT_REQUIRED: {
    title: 'Counting unit required',
    explanation: 'The unit decides whether a quantity reads as pairs, each, sets or cases.',
    action: 'Pick a counting unit.',
    severity: 'error',
  },
  VARIANT_ALREADY_EXISTS: {
    title: 'That variant already exists',
    explanation: 'This group already has a variant with these attributes.',
    action: 'Receive into the existing variant instead of creating a second one.',
    severity: 'warning',
  },
  POSSIBLE_PRODUCT_GROUP_DUPLICATE: {
    title: 'Possible duplicate product group',
    explanation: 'An existing group looks very close to this one.',
    action: 'Review the candidates and either link or confirm a new group.',
    severity: 'warning',
  },
  AMBIGUOUS_VARIANT_MATCH: {
    title: 'More than one variant matches',
    explanation: 'The attributes on this row match several existing variants.',
    action: 'Pick the right variant. Nothing is merged automatically.',
    severity: 'warning',
  },
  IMPORT_MAPPING_REVIEW_REQUIRED: {
    title: 'Confirm the column mapping',
    explanation: 'A column such as "Number" could be a jersey number, a quantity, a serial or a style.',
    action: 'Confirm what each flagged column means, then re-run the import.',
    severity: 'warning',
  },
  TRACKING_MODE_CHANGE_REQUIRES_MIGRATION: {
    title: 'Changing tracking mode needs a migration',
    explanation: 'This product already has transactions, so the mode cannot change in place.',
    action: 'Run the guided tracking-mode migration with a reason.',
    severity: 'error',
  },
};
```

- [ ] Delete the stray `countingUnitLabel` `'box'` branch above before committing — it references a unit not in `COUNTING_UNITS` and exists only as a reminder that the label helper must stay exhaustive. Replace the body with:

```ts
export function countingUnitLabel(unit: CountingUnit, quantity: number): string {
  if (unit === 'each') return 'each';
  return quantity === 1 ? unit : `${unit}s`;
}
```

- [ ] Create `packages/core/src/sports/tracking-modes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SUBCATEGORY_PROFILES,
  SPORTS_ERROR_CODES,
  SPORTS_ERROR_META,
  SPORTS_SUBCATEGORIES,
  TRACKING_MODES,
  countingUnitLabel,
  modeHasVariants,
  trackingTypeForMode,
} from './tracking-modes';

describe('trackingTypeForMode', () => {
  it('maps every mode to a legal tracking_type', () => {
    for (const m of TRACKING_MODES) {
      expect(['none', 'lot', 'serial', 'serial_optional']).toContain(trackingTypeForMode(m));
    }
  });

  it('keeps quantity-shaped modes off serials entirely', () => {
    expect(trackingTypeForMode('QUANTITY')).toBe('none');
    expect(trackingTypeForMode('QUANTITY_BY_VARIANT')).toBe('none');
    expect(trackingTypeForMode('NUMBERED_VARIANT')).toBe('none');
  });

  it('keeps SERIALIZED strict (R1: Electronics is unaffected)', () => {
    expect(trackingTypeForMode('SERIALIZED')).toBe('serial');
    expect(trackingTypeForMode('INDIVIDUALLY_TAGGED')).toBe('serial');
  });

  it('routes OPTIONAL_SERIALIZED to the new relaxed value', () => {
    expect(trackingTypeForMode('OPTIONAL_SERIALIZED')).toBe('serial_optional');
  });
});

describe('DEFAULT_SUBCATEGORY_PROFILES', () => {
  it('covers every subcategory key', () => {
    for (const k of SPORTS_SUBCATEGORIES) {
      expect(DEFAULT_SUBCATEGORY_PROFILES[k]).toBeTruthy();
      expect(DEFAULT_SUBCATEGORY_PROFILES[k].key).toBe(k);
    }
  });

  it('always lists the default mode among the allowed modes', () => {
    for (const p of Object.values(DEFAULT_SUBCATEGORY_PROFILES)) {
      expect(p.allowedModes).toContain(p.defaultMode);
    }
  });

  it('never requires an attribute it does not support', () => {
    for (const p of Object.values(DEFAULT_SUBCATEGORY_PROFILES)) {
      for (const a of p.requiredAttributes) expect(p.supportedAttributes).toContain(a);
    }
  });

  it('defaults shoes to per-variant quantity counted in pairs', () => {
    const shoes = DEFAULT_SUBCATEGORY_PROFILES.shoes;
    expect(shoes.defaultMode).toBe('QUANTITY_BY_VARIANT');
    expect(shoes.defaultCountingUnit).toBe('pair');
    expect(shoes.supportsNumbers).toBe(false);
    expect(shoes.requiredAttributes).toEqual(['size', 'size_system']);
  });

  it('defaults jerseys to numbered variants that support numbers', () => {
    const j = DEFAULT_SUBCATEGORY_PROFILES.jerseys;
    expect(j.defaultMode).toBe('NUMBERED_VARIANT');
    expect(j.supportsNumbers).toBe(true);
    expect(j.supportedAttributes).toContain('jersey_number');
  });

  it('only allows individual tracking where the profile says so', () => {
    for (const p of Object.values(DEFAULT_SUBCATEGORY_PROFILES)) {
      if (!p.individualTrackingAllowed) {
        expect(p.allowedModes).not.toContain('INDIVIDUALLY_TAGGED');
      }
    }
  });
});

describe('modeHasVariants', () => {
  it('is true only for the two variant modes', () => {
    expect(modeHasVariants('QUANTITY_BY_VARIANT')).toBe(true);
    expect(modeHasVariants('NUMBERED_VARIANT')).toBe(true);
    expect(modeHasVariants('QUANTITY')).toBe(false);
    expect(modeHasVariants('SERIALIZED')).toBe(false);
  });
});

describe('countingUnitLabel', () => {
  it('pluralizes pair as the display convention (never a conversion)', () => {
    expect(countingUnitLabel('pair', 12)).toBe('pairs');
    expect(countingUnitLabel('pair', 1)).toBe('pair');
    expect(countingUnitLabel('each', 12)).toBe('each');
  });
});

describe('SPORTS_ERROR_META', () => {
  it('has meta for every code', () => {
    for (const c of SPORTS_ERROR_CODES) {
      const m = SPORTS_ERROR_META[c];
      expect(m.title.length).toBeGreaterThan(0);
      expect(m.action.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] Add `export * from './sports/tracking-modes';` to `packages/core/src/index.ts`, placed with the other inventory exports (after `export * from './inventory/movement-history';`).
- [ ] Run `pnpm --filter @stockpilot/core test` and confirm every assertion above passes.
- [ ] Run `pnpm typecheck` at the repo root. It must be clean.

---

## Task 2: Category tracking profiles and size scales (migration 0294)

Puts the policy where it belongs — on `categories` — and retires the five inconsistent hardcoded size lists by giving sizes a table. Subcategories need ZERO schema: `categories.parent_id` has existed since 0002 with an index and is completely unused.

**Files:**
- Create: `supabase/migrations/0294_category_tracking_profiles.sql`
- Create: `supabase/tests/0294_category_tracking_profiles.test.sql`

**Interfaces:**
- Consumes from Task 1: the `TRACKING_MODES` and `COUNTING_UNITS` string sets (mirrored into SQL CHECKs — the TS union and the CHECK must stay in lockstep).
- Produces for Tasks 8, 11, 12, 19: `categories.tracking_mode`, `categories.size_scale_id`, `categories.default_unit_of_measure`, tables `size_scales` and `size_scale_values`, and the resolver `public.category_tracking_mode(uuid)`.

**Steps:**

- [ ] Create `supabase/migrations/0294_category_tracking_profiles.sql`:

```sql
-- 0294_category_tracking_profiles.sql
--
-- Phase 2 of the Sports program: per-category tracking policy + structured
-- size scales.
--
-- WHY HERE: today `categories` carries zero tracking configuration, so the
-- sports-only serial exemption has nowhere to live, and the apparel size
-- vocabulary is duplicated across five places that already disagree (web form
-- offers 9 sizes, the server action zod caps at 7, plus the size-run regex,
-- the 0284 CHECK and mobile's own copy).
--
-- SUBCATEGORIES NEED NO SCHEMA. `categories.parent_id` has existed since 0002
-- (with index `categories_parent_idx`) and is written by the service layer but
-- never set by any UI. Sports subcategories reuse it; this migration only adds
-- the INHERITANCE resolver.
--
-- BACKWARD COMPATIBILITY: every new column is NULLABLE with no backfill.
-- `tracking_mode is null` reads as QUANTITY, which is exactly today's behaviour
-- for every existing category in every existing org.

-- ── 1) Size scales ──────────────────────────────────────────────────────────
-- organization_id NULL = a built-in system scale, readable by every org and
-- editable by nobody. A non-null org owns a private scale.
create table public.size_scales (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid references public.organizations(id) on delete cascade,
  key              text not null,
  name             text not null,
  kind             text not null
                     check (kind in ('apparel_alpha','shoe_numeric','youth_numeric','custom')),
  /* US Men / US Women / US Youth / UK / EU / CM / custom. NULL for apparel. */
  size_system      text,
  description      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

-- A key is unique per owner. NULLS NOT DISTINCT so two system scales cannot
-- share a key either.
create unique index size_scales_owner_key_uniq
  on public.size_scales (organization_id, key)
  nulls not distinct
  where deleted_at is null;

create index size_scales_org_idx
  on public.size_scales (organization_id) where deleted_at is null;

create trigger size_scales_set_updated_at
  before update on public.size_scales
  for each row execute function public.tg_set_updated_at();

comment on table public.size_scales is
  'Ordered size vocabularies (apparel letters, numeric shoe sizes with halves '
  'and widths, youth). organization_id NULL = a built-in system scale visible '
  'to every org. Retires the five hardcoded apparel size lists.';

-- ── 2) Size scale values ────────────────────────────────────────────────────
create table public.size_scale_values (
  id             uuid primary key default gen_random_uuid(),
  size_scale_id  uuid not null references public.size_scales(id) on delete cascade,
  /* As printed on the sticker: 'XL', '10.5', '7Y'. Preserved verbatim. */
  value          text not null,
  /* Case/space-normalized form used for matching. Never shown to a user. */
  normalized     text not null,
  /* Display order within the scale. Sizes are ORDERED, not alphabetical. */
  sort_order     integer not null,
  is_half        boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (size_scale_id, normalized)
);

create index size_scale_values_scale_idx
  on public.size_scale_values (size_scale_id, sort_order);

comment on column public.size_scale_values.value is
  'The size AS PRINTED. Never auto-converted between systems (requirements: '
  '"never auto-convert between systems without an approved mapping").';

-- ── 3) Category tracking profile columns ────────────────────────────────────
alter table public.categories
  add column if not exists tracking_mode text,
  add column if not exists size_scale_id uuid references public.size_scales(id) on delete set null,
  add column if not exists default_unit_of_measure text,
  /* Sports subcategory key from packages/core/src/sports/tracking-modes.ts.
     NULL for every non-sports category, which is every category today. */
  add column if not exists sports_subcategory_key text,
  /* Full profile for a CUSTOM subcategory (requirements: a custom subcategory
     MUST carry a full tracking profile). Shape = SubcategoryTrackingProfile. */
  add column if not exists tracking_profile jsonb;

alter table public.categories
  drop constraint if exists categories_tracking_mode_check;
alter table public.categories
  add constraint categories_tracking_mode_check
  check (tracking_mode is null or tracking_mode in (
    'QUANTITY','QUANTITY_BY_VARIANT','NUMBERED_VARIANT',
    'SERIALIZED','OPTIONAL_SERIALIZED','INDIVIDUALLY_TAGGED','LOT_TRACKED'
  ));

alter table public.categories
  drop constraint if exists categories_default_uom_check;
alter table public.categories
  add constraint categories_default_uom_check
  check (default_unit_of_measure is null or default_unit_of_measure in (
    'unit','each','pair','set','case'
  ));

comment on column public.categories.tracking_mode is
  'Category tracking policy. NULL reads as QUANTITY — the behaviour every '
  'existing category already has. A child category inherits its parent''s mode '
  'when its own is NULL (see public.category_tracking_mode).';

comment on column public.categories.default_unit_of_measure is
  'Default counting unit stamped onto items created in this category. PAIR is '
  'a DISPLAY convention only — there is no conversion anywhere (owner decision '
  '2026-07-27).';

-- ── 4) Inheritance resolver ─────────────────────────────────────────────────
-- Walks at most ONE level up (categories are a parent/child pair, not a deep
-- tree) and falls back to 'QUANTITY'. STABLE + security definer so RLS on
-- categories cannot make a child silently resolve differently per caller.
create or replace function public.category_tracking_mode(p_category_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    c.tracking_mode,
    p.tracking_mode,
    'QUANTITY'
  )
  from public.categories c
  left join public.categories p on p.id = c.parent_id and p.deleted_at is null
  where c.id = p_category_id and c.deleted_at is null;
$$;

grant execute on function public.category_tracking_mode(uuid) to authenticated;

-- Same shape for the counting unit.
create or replace function public.category_default_uom(p_category_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    c.default_unit_of_measure,
    p.default_unit_of_measure,
    'unit'
  )
  from public.categories c
  left join public.categories p on p.id = c.parent_id and p.deleted_at is null
  where c.id = p_category_id and c.deleted_at is null;
$$;

grant execute on function public.category_default_uom(uuid) to authenticated;

-- ── 5) RLS ──────────────────────────────────────────────────────────────────
alter table public.size_scales      enable row level security;
alter table public.size_scale_values enable row level security;

-- System scales (organization_id IS NULL) are readable by every member.
create policy size_scales_select on public.size_scales
  for select to authenticated
  using (
    organization_id is null
    or (select public.is_org_member(organization_id))
  );

create policy size_scales_insert on public.size_scales
  for insert to authenticated
  with check (
    organization_id is not null
    and (
      (select public.has_org_role(organization_id, 'manager'))
      or (select public.has_permission(organization_id, 'sports:manage'))
    )
  );

create policy size_scales_update on public.size_scales
  for update to authenticated
  using (
    organization_id is not null
    and (
      (select public.has_org_role(organization_id, 'manager'))
      or (select public.has_permission(organization_id, 'sports:manage'))
    )
  )
  with check (
    organization_id is not null
    and (
      (select public.has_org_role(organization_id, 'manager'))
      or (select public.has_permission(organization_id, 'sports:manage'))
    )
  );

create policy size_scales_delete on public.size_scales
  for delete to authenticated
  using (
    organization_id is not null
    and (select public.has_org_role(organization_id, 'manager'))
  );

-- Values inherit their scale's visibility exactly.
create policy size_scale_values_select on public.size_scale_values
  for select to authenticated
  using (
    exists (
      select 1 from public.size_scales s
      where s.id = size_scale_values.size_scale_id
        and (s.organization_id is null
             or (select public.is_org_member(s.organization_id)))
    )
  );

create policy size_scale_values_write on public.size_scale_values
  for all to authenticated
  using (
    exists (
      select 1 from public.size_scales s
      where s.id = size_scale_values.size_scale_id
        and s.organization_id is not null
        and (select public.has_org_role(s.organization_id, 'manager'))
    )
  )
  with check (
    exists (
      select 1 from public.size_scales s
      where s.id = size_scale_values.size_scale_id
        and s.organization_id is not null
        and (select public.has_org_role(s.organization_id, 'manager'))
    )
  );

-- EXPLICIT GRANTS. Migration 0283 omitted these and it is a documented defect
-- (0067: "on hardened Supabase projects, missing grants cause real-feature
-- 403s even when RLS would otherwise allow the row"). Do not repeat it.
grant select, insert, update, delete on public.size_scales to authenticated;
grant select, insert, update, delete on public.size_scale_values to authenticated;

-- ── 6) Seed the built-in system scales ──────────────────────────────────────
-- Owner-facing decision (see "Open policy questions"): these four are the
-- opening set. organization_id NULL so every org gets them without a per-org
-- backfill, and no org can mutate them.
insert into public.size_scales (id, organization_id, key, name, kind, size_system, description)
values
  ('5ca1e000-0000-0000-0000-000000000001', null, 'apparel_alpha', 'Apparel (XS-5XL)',
   'apparel_alpha', null, 'Letter sizing for jerseys, uniforms and apparel.'),
  ('5ca1e000-0000-0000-0000-000000000002', null, 'us_mens_shoe', 'US Men''s shoe',
   'shoe_numeric', 'US_MENS', 'US Men''s numeric shoe sizes, half sizes included.'),
  ('5ca1e000-0000-0000-0000-000000000003', null, 'us_womens_shoe', 'US Women''s shoe',
   'shoe_numeric', 'US_WOMENS', 'US Women''s numeric shoe sizes, half sizes included.'),
  ('5ca1e000-0000-0000-0000-000000000004', null, 'us_youth_shoe', 'US Youth shoe',
   'youth_numeric', 'US_YOUTH', 'US Youth numeric shoe sizes, half sizes included.')
on conflict do nothing;

-- Apparel letters, in wearing order. Deliberately the UNION of every list that
-- exists today: the 9 the writers emit plus the 2XL-6XL forms size-run.ts
-- already parses, so nothing that renders today stops rendering.
insert into public.size_scale_values (size_scale_id, value, normalized, sort_order, is_half)
select '5ca1e000-0000-0000-0000-000000000001', v.value, upper(v.value), v.ord, false
from (values
  ('XS', 10), ('S', 20), ('M', 30), ('L', 40), ('XL', 50),
  ('XXL', 60), ('2XL', 61), ('XXXL', 70), ('3XL', 71),
  ('XXXXL', 80), ('4XL', 81), ('XXXXXL', 90), ('5XL', 91), ('6XL', 100)
) as v(value, ord)
on conflict (size_scale_id, normalized) do nothing;

-- Numeric shoe sizes 4 through 18 in half steps, for all three shoe scales.
insert into public.size_scale_values (size_scale_id, value, normalized, sort_order, is_half)
select s.id,
       trim(to_char(n.size, 'FM990.9')),
       trim(to_char(n.size, 'FM990.9')),
       (n.size * 10)::int,
       (n.size * 2)::int % 2 = 1
from public.size_scales s
cross join (
  select generate_series(80, 360, 10) / 10.0 as size
) as n
where s.organization_id is null
  and s.key in ('us_mens_shoe', 'us_womens_shoe')
on conflict (size_scale_id, normalized) do nothing;

insert into public.size_scale_values (size_scale_id, value, normalized, sort_order, is_half)
select s.id,
       trim(to_char(n.size, 'FM990.9')),
       trim(to_char(n.size, 'FM990.9')),
       (n.size * 10)::int,
       (n.size * 2)::int % 2 = 1
from public.size_scales s
cross join (
  select generate_series(20, 140, 10) / 10.0 as size
) as n
where s.organization_id is null
  and s.key = 'us_youth_shoe'
on conflict (size_scale_id, normalized) do nothing;
```

- [ ] Create `supabase/tests/0294_category_tracking_profiles.test.sql`. Namespace `5c294000`. Wrapped in `begin`/`rollback` so nothing leaks.

```sql
-- supabase/tests/0294_category_tracking_profiles.test.sql
--
-- Proves 0294: category tracking profiles + size scales.
--
-- Fixture map: org 5c294000-...-01, admin user ...-02, parent category ...-03
-- (Sports, QUANTITY_BY_VARIANT), child category ...-04 (Shoes, NULL mode ->
-- inherits), unrelated category ...-05 (NULL mode, NULL parent -> QUANTITY).
--
-- Anti-vacuity: assertion 1 proves the child really has a NULL tracking_mode,
-- so the inheritance assertions are not passing on a stamped value.
--
-- Namespace: 5c294000. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(16);

\set org    '\'5c294000-0000-0000-0000-000000000001\''
\set admin  '\'5c294000-0000-0000-0000-000000000002\''
\set parent '\'5c294000-0000-0000-0000-000000000003\''
\set child  '\'5c294000-0000-0000-0000-000000000004\''
\set plain  '\'5c294000-0000-0000-0000-000000000005\''

insert into auth.users (id, email) values (:admin, 'admin-0294@example.test')
  on conflict (id) do nothing;
insert into public.organizations (id, name) values (:org, 'Sports 0294 Org')
  on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :admin, 'admin', now()) on conflict do nothing;

insert into public.categories (id, organization_id, name, tracking_mode, default_unit_of_measure)
  values (:parent, :org, 'Sports', 'QUANTITY_BY_VARIANT', 'pair')
  on conflict (id) do nothing;
insert into public.categories (id, organization_id, parent_id, name, sports_subcategory_key)
  values (:child, :org, :parent, 'Shoes', 'shoes')
  on conflict (id) do nothing;
insert into public.categories (id, organization_id, name)
  values (:plain, :org, 'Office Supplies')
  on conflict (id) do nothing;

-- ── Schema shape ────────────────────────────────────────────────────────────
select has_column('public', 'categories', 'tracking_mode', 'categories.tracking_mode exists');
select has_column('public', 'categories', 'size_scale_id', 'categories.size_scale_id exists');
select has_column('public', 'categories', 'default_unit_of_measure', 'categories.default_unit_of_measure exists');
select has_column('public', 'categories', 'sports_subcategory_key', 'categories.sports_subcategory_key exists');
select has_column('public', 'categories', 'tracking_profile', 'categories.tracking_profile exists');

-- ── Anti-vacuity: the child genuinely has no mode of its own ────────────────
select is(
  (select tracking_mode from public.categories where id = :child),
  null,
  'fixture check: the child category has a NULL tracking_mode (inheritance is really under test)');

-- ── Inheritance resolver ────────────────────────────────────────────────────
select is(
  public.category_tracking_mode(:parent),
  'QUANTITY_BY_VARIANT',
  'a category with its own mode resolves to that mode');

select is(
  public.category_tracking_mode(:child),
  'QUANTITY_BY_VARIANT',
  'a child with NULL mode inherits its parent (subcategories via the dormant parent_id)');

select is(
  public.category_tracking_mode(:plain),
  'QUANTITY',
  'a category with no mode and no parent reads as QUANTITY — today''s behaviour, unchanged');

select is(
  public.category_default_uom(:child),
  'pair',
  'the child inherits the parent''s counting unit (PAIR rides the existing uom)');

select is(
  public.category_default_uom(:plain),
  'unit',
  'an unconfigured category still counts in ''unit'' — existing orgs unaffected');

-- ── CHECK constraints reject nonsense ───────────────────────────────────────
select throws_ok(
  $$ update public.categories
       set tracking_mode = 'TOTALLY_MADE_UP'
     where id = '5c294000-0000-0000-0000-000000000005' $$,
  '23514',
  null,
  'an unknown tracking_mode is rejected by the CHECK');

select throws_ok(
  $$ update public.categories
       set default_unit_of_measure = 'furlong'
     where id = '5c294000-0000-0000-0000-000000000005' $$,
  '23514',
  null,
  'an unknown counting unit is rejected by the CHECK');

-- ── Seeded system scales ────────────────────────────────────────────────────
select is(
  (select count(*)::int from public.size_scales where organization_id is null),
  4,
  'four built-in system size scales are seeded');

select ok(
  (select count(*) from public.size_scale_values v
     join public.size_scales s on s.id = v.size_scale_id
    where s.key = 'apparel_alpha') >= 14,
  'the apparel scale carries every letter size the app can render today');

select ok(
  (select count(*) from public.size_scale_values v
     join public.size_scales s on s.id = v.size_scale_id
    where s.key = 'us_mens_shoe' and v.is_half) > 0,
  'numeric shoe scales include half sizes');

select * from finish();
rollback;
```

- [ ] Run `supabase db reset && pnpm db:test 2>&1 | grep -E "0294|Result:"`. All 16 assertions must pass.
- [ ] **Regression (`categories` is a shared surface):** confirm `supabase/tests/*` still passes in full, and specifically that `pnpm db:test` reports no new failures in `0128`/`0129`/`0140`/`0212` (the categories RLS lineage). The new columns are additive and the policies are untouched, so a failure here means the ALTER hit an unexpected constraint name.
- [ ] **Regression (existing orgs unaffected):** assert by inspection that no `update public.categories set tracking_mode = ...` statement exists in the migration outside the test fixtures. Every existing category must still resolve to `QUANTITY` / `unit`.

---

## Task 3: `serial_optional` tracking type and the `post_receipt_v2` sixth rewrite

The highest-risk task in the plan. `post_receipt_v2` has been fully re-bodied five times (0013/0015/0069/0190/0231/0285) and is the ONE path in the app where serials are mandatory. This adds a fourth `tracking_type` value and exactly ONE new branch, and proves by pgTAP that every pre-existing path is byte-for-byte unchanged in behaviour.

Both migrations ship together because the CHECK widen is meaningless without the RPC branch, and the RPC branch is unreachable without the CHECK.

**Files:**
- Create: `supabase/migrations/0295_tracking_type_serial_optional.sql`
- Create: `supabase/migrations/0296_post_receipt_v2_serial_optional.sql`
- Create: `supabase/tests/0295_tracking_type_serial_optional.test.sql`
- Create: `supabase/tests/0296_post_receipt_v2_serial_optional.test.sql`
- Modify: `apps/web/src/server/services/receiving.ts` (error mapping)
- Modify: `packages/core/src/schemas/inventory.ts` (`trackingType` enum)
- Modify: `apps/web/src/components/po/po-receive-dialog.tsx` (union + branch)
- Modify: `apps/web/src/server/loaders/inventory-list.ts` (row type union)
- Modify: `apps/web/src/server/services/inventory.ts` (unions at 876, 1016, 1038-1041, 1853)
- Modify: `apps/web/src/server/services/po-imports.ts:1243`, `apps/web/src/server/services/po-imports-lines.ts:484`
- Modify: `apps/web/src/app/(dashboard)/dashboard/purchase-orders/[id]/page.tsx:119`, `.../books/[id]/edit/page.tsx:163-165`, `.../inventory/[id]/edit/page.tsx:157-161`
- Modify: `apps/web/src/components/inventory/item-form.tsx:1557`, `apps/web/src/components/inventory/item-detail.tsx:302`
- Modify: `apps/mobile/app/item/[id].tsx` (serials tab gate)

**Interfaces:**
- Consumes from Task 1: `TRACKING_TYPE_VALUES`, `trackingTypeForMode`.
- Produces for Tasks 8, 11, 13, 16: a receipt path that accepts 0..N serials on a `serial_optional` item, and `ServiceError` mapping for the new failure mode.

**Steps:**

- [ ] Create `supabase/migrations/0295_tracking_type_serial_optional.sql`:

```sql
-- 0295_tracking_type_serial_optional.sql
--
-- Adds a fourth tracking_type: 'serial_optional'.
--
-- WHY: the Sports "OPTIONAL_SERIALIZED" mode (protective equipment, training
-- equipment, balls) means a receipt MAY carry unit-level serials for some of
-- the quantity and none for the rest. Today tracking_type is a three-value
-- CHECK from 0015 and post_receipt_v2 has exactly two branches, so there is no
-- way to express "serials welcome, not required" without either lying
-- ('none', losing the units) or forcing fake placeholder serials — which the
-- requirements explicitly forbid ("NEVER fake placeholders (N/A, 0000,
-- NO SERIAL)").
--
-- The CHECK from 0015 was added via ADD COLUMN ... CHECK and is therefore
-- auto-named `inventory_items_tracking_type_check`. Drop by that name (IF
-- EXISTS so a re-run is safe) and re-add with an EXPLICIT name so the next
-- migration never has to guess.
--
-- NOTHING IS BACKFILLED. Every existing row keeps its exact tracking_type.
-- 'none'/'lot'/'serial' behaviour is untouched; the new value is only ever
-- written by a category whose mode is OPTIONAL_SERIALIZED.

alter table public.inventory_items
  drop constraint if exists inventory_items_tracking_type_check;

alter table public.inventory_items
  add constraint inventory_items_tracking_type_check
  check (tracking_type in ('none', 'lot', 'serial', 'serial_optional'));

comment on column public.inventory_items.tracking_type is
  'Per-item capture requirement at receive time. none = quantity only; lot = '
  'lot rows required and must sum to qty_accepted; serial = exactly '
  'qty_accepted serials required; serial_optional = 0..qty_accepted serials '
  'accepted, never required (added 0295 for the Sports OPTIONAL_SERIALIZED '
  'mode). Stamped from the category tracking_mode at creation.';

-- The 0015 partial index `where tracking_type <> 'none'` already covers the
-- new value; no index change is needed. Asserted in the pgTAP file.
```

- [ ] Create `supabase/tests/0295_tracking_type_serial_optional.test.sql`. Namespace `d0295000`.

```sql
-- supabase/tests/0295_tracking_type_serial_optional.test.sql
--
-- Proves 0295: the tracking_type CHECK now admits 'serial_optional' and still
-- rejects everything else, and that no existing row was mutated.
--
-- Namespace: d0295000. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(8);

\set org   '\'d0295000-0000-0000-0000-000000000001\''
\set user1 '\'d0295000-0000-0000-0000-000000000002\''
\set wh    '\'d0295000-0000-0000-0000-000000000003\''
\set item  '\'d0295000-0000-0000-0000-000000000004\''

insert into auth.users (id, email) values (:user1, 'u-0295@example.test')
  on conflict (id) do nothing;
insert into public.organizations (id, name) values (:org, 'Serial Optional 0295')
  on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :user1, 'admin', now()) on conflict do nothing;
insert into public.warehouses (id, organization_id, name)
  values (:wh, :org, 'WH 0295') on conflict (id) do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:item, :org, :wh, 'SO-0295', 'Optional Serial Item', 0, 'active', 'none')
  on conflict (id) do nothing;

-- Anti-vacuity: the fixture really starts on the OLD value.
select is(
  (select tracking_type from public.inventory_items where id = :item),
  'none',
  'fixture check: the item starts on ''none''');

select lives_ok(
  $$ update public.inventory_items
       set tracking_type = 'serial_optional'
     where id = 'd0295000-0000-0000-0000-000000000004' $$,
  '''serial_optional'' is now an accepted tracking_type');

select is(
  (select tracking_type from public.inventory_items where id = :item),
  'serial_optional',
  'the new value persists');

-- The three original values still work, unchanged.
select lives_ok(
  $$ update public.inventory_items set tracking_type = 'serial'
     where id = 'd0295000-0000-0000-0000-000000000004' $$,
  '''serial'' still accepted (Electronics is unaffected)');
select lives_ok(
  $$ update public.inventory_items set tracking_type = 'lot'
     where id = 'd0295000-0000-0000-0000-000000000004' $$,
  '''lot'' still accepted');
select lives_ok(
  $$ update public.inventory_items set tracking_type = 'none'
     where id = 'd0295000-0000-0000-0000-000000000004' $$,
  '''none'' still accepted');

-- Anything else is still rejected — the CHECK was widened, not removed.
select throws_ok(
  $$ update public.inventory_items set tracking_type = 'serialised'
     where id = 'd0295000-0000-0000-0000-000000000004' $$,
  '23514',
  null,
  'an unknown tracking_type is still rejected (CHECK widened, not dropped)');

-- The 0015 partial index still covers the new value.
select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'inventory_items_tracking_type_idx'
  ),
  'the 0015 partial tracking_type index survives the constraint swap');

select * from finish();
rollback;
```

- [ ] Create `supabase/migrations/0296_post_receipt_v2_serial_optional.sql`. This is a FULL re-body. It is byte-identical to `0285_allow_over_receipt.sql` except for the single `elsif v_tracking = 'serial_optional'` validation branch and the widened serial-persist condition. Do not "improve" anything else in it.

```sql
-- 0296_post_receipt_v2_serial_optional.sql
--
-- SIXTH full-body rewrite of post_receipt_v2 (after 0013, 0015, 0069, 0190,
-- 0231, 0285). Every prior rewrite re-asserted the same rule: a serial item
-- must supply exactly qty_accepted serials. That rule is UNCHANGED here.
--
-- THE ONLY BEHAVIOURAL DELTA: a new 'serial_optional' branch that accepts
-- between 0 and qty_accepted serials and persists whichever were supplied.
-- Concretely:
--   * v_tracking = 'none'            -> unchanged (no capture)
--   * v_tracking = 'lot'             -> unchanged (lots required, must sum)
--   * v_tracking = 'serial'          -> unchanged (exact count, serials_required)
--   * v_tracking = 'serial_optional' -> NEW: null/absent is fine; if supplied,
--                                       the count must not EXCEED qty_accepted
--                                       (serial_count_exceeds_quantity), and
--                                       the rows land in serial_registry.
--
-- Why "must not exceed" rather than "must equal": mixed unit-level + quantity
-- receipts must not double-count (requirements, Serial rules). N serials
-- against N accepted units is a fully-tagged receipt; k < N is a partially
-- tagged one; k > N would claim more units than arrived.
--
-- The over-receipt allowance from 0285 is preserved verbatim (no guard).
-- The grant made in 0013/0190/0231 survives create-or-replace, exactly as it
-- did through 0285; the pgTAP file asserts it.

create or replace function public.post_receipt_v2(
  p_purchase_order_id uuid,
  p_warehouse_id uuid,
  p_lines jsonb,
  p_idempotency_key text,
  p_request_hash text,
  p_notes text default null::text
)
returns receipts
language plpgsql
set search_path to 'public', 'extensions'
as $function$
declare
  v_receipt       public.receipts%rowtype;
  v_existing      public.idempotency_keys%rowtype;
  v_line          record;
  v_po            public.purchase_orders%rowtype;
  v_org           uuid;
  v_item_id       uuid;
  v_tracking      text;
  v_inserted_line uuid;
  v_lot           record;
  v_serial        text;
  v_lot_sum       numeric;
  v_serial_count  int;
  v_po_line       record;
  v_staging       uuid;
begin
  select * into v_po from public.purchase_orders where id = p_purchase_order_id for update;
  if not found then raise exception 'po_not_found' using errcode = 'P0002'; end if;
  v_org := v_po.organization_id;

  select * into v_existing
    from public.idempotency_keys
    where organization_id = v_org
      and scope = 'receipt'
      and key = p_idempotency_key
    for update;
  if found then
    if v_existing.request_hash = p_request_hash then
      select * into v_receipt from public.receipts where id = v_existing.resource_id;
      return v_receipt;
    else
      raise exception 'idempotency_conflict' using errcode = '40001';
    end if;
  end if;

  if not public.has_org_role(v_org, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_po.status not in ('draft','expected_inbound','ordered','partially_received') then
    raise exception 'po_already_closed' using errcode = '22023';
  end if;

  -- Resolve (creating if needed) the warehouse Staging location.
  perform public.ensure_warehouse_placement_locations(p_warehouse_id);
  select id into v_staging from public.locations
    where warehouse_id = p_warehouse_id and kind = 'staging' and deleted_at is null
    limit 1;

  insert into public.receipts(
    organization_id, purchase_order_id, warehouse_id, receipt_number,
    received_by, idempotency_key, immutable_hash, notes
  ) values (
    v_org, v_po.id, p_warehouse_id,
    'R-' || to_char(now(),'YYYYMMDD-HH24MISS') || '-' || substr(gen_random_uuid()::text, 1, 6),
    auth.uid(), p_idempotency_key,
    encode(digest(p_request_hash, 'sha256'), 'hex'),
    p_notes
  ) returning * into v_receipt;

  for v_line in select * from jsonb_to_recordset(p_lines) as x(
    po_line_id uuid, qty_received numeric, qty_accepted numeric,
    qty_rejected numeric, unit_cost numeric, notes text,
    lots jsonb, serials jsonb
  ) loop
    -- Quantity sanity: per-line quantities must be non-negative. Over-receipt
    -- (accepted + already-received > ordered) is ALLOWED (owner decision
    -- 2026-07-21) — vendors over-ship; the receipt Notes record why.
    if coalesce(v_line.qty_received, 0) < 0
       or coalesce(v_line.qty_accepted, 0) < 0
       or coalesce(v_line.qty_rejected, 0) < 0 then
      raise exception 'negative_quantity' using errcode = '23514';
    end if;

    select id, item_id, quantity_received, quantity_ordered
      into v_po_line
      from public.purchase_order_items
      where id = v_line.po_line_id
        and purchase_order_id = v_po.id
      for update;
    if not found then
      raise exception 'po_line_not_found' using errcode = 'P0002';
    end if;
    v_item_id := v_po_line.item_id;

    -- (over-receive guard removed 2026-07-21 — see migration 0285 header)

    select tracking_type into v_tracking
      from public.inventory_items where id = v_item_id;

    -- Validate tracking-type-specific inputs BEFORE doing any writes.
    if v_tracking = 'lot' then
      if v_line.qty_accepted > 0 then
        if v_line.lots is null or jsonb_array_length(v_line.lots) = 0 then
          raise exception 'lot_required' using errcode = '23514';
        end if;
        select coalesce(sum((elem->>'qty_base')::numeric), 0) into v_lot_sum
          from jsonb_array_elements(v_line.lots) elem;
        if abs(v_lot_sum - v_line.qty_accepted) > 0.0001 then
          raise exception 'lot_qty_mismatch' using errcode = '23514';
        end if;
      end if;
    elsif v_tracking = 'serial' then
      if v_line.qty_accepted > 0 then
        if v_line.serials is null then
          raise exception 'serials_required' using errcode = '23514';
        end if;
        v_serial_count := jsonb_array_length(v_line.serials);
        if v_serial_count <> v_line.qty_accepted::int then
          raise exception 'serial_count_mismatch' using errcode = '23514';
        end if;
      end if;
    elsif v_tracking = 'serial_optional' then
      -- NEW (0296). Serials are WELCOME, never required. A null/absent array
      -- and an empty array are both a legitimate pure-quantity receipt — this
      -- is the branch that makes fake placeholder serials unnecessary.
      -- The only failure is claiming MORE tagged units than actually arrived,
      -- which would double-count against the quantity posted below.
      if v_line.qty_accepted > 0 and v_line.serials is not null then
        v_serial_count := jsonb_array_length(v_line.serials);
        if v_serial_count > v_line.qty_accepted::int then
          raise exception 'serial_count_exceeds_quantity' using errcode = '23514';
        end if;
      end if;
    end if;

    if v_line.qty_accepted > 0 then
      perform public.adjust_stock(
        v_item_id,
        v_line.qty_accepted,
        'receive_po',
        v_staging,       -- route accepted qty into the warehouse Staging location
        'PO ' || coalesce(v_po.po_number, 'receipt'),
        v_receipt.id::text
      );
    end if;

    insert into public.receipt_lines(
      receipt_id, purchase_order_line_id, item_id,
      qty_received_base, qty_accepted_base, qty_rejected_base,
      unit_cost, notes
    ) values (
      v_receipt.id, v_line.po_line_id, v_item_id,
      v_line.qty_received, v_line.qty_accepted, coalesce(v_line.qty_rejected, 0),
      coalesce(v_line.unit_cost, 0), v_line.notes
    ) returning id into v_inserted_line;

    -- Persist lot rows (only when tracking_type='lot' and qty_accepted > 0)
    if v_tracking = 'lot' and v_line.qty_accepted > 0 then
      for v_lot in select * from jsonb_to_recordset(v_line.lots) as x(
        lot_number text, expiration_date date, qty_base numeric
      ) loop
        insert into public.receipt_line_lots(
          receipt_line_id, lot_number, expiration_date, qty_base
        ) values (
          v_inserted_line, v_lot.lot_number, v_lot.expiration_date, v_lot.qty_base
        );
      end loop;
    end if;

    -- Serial persistence. 'serial' is unchanged. 'serial_optional' joins it,
    -- guarded on a non-null array so the common no-serials case does no work.
    if v_tracking in ('serial', 'serial_optional')
       and v_line.qty_accepted > 0
       and v_line.serials is not null then
      for v_serial in select * from jsonb_array_elements_text(v_line.serials) loop
        insert into public.serial_registry(
          organization_id, item_id, serial_number, warehouse_id, receipt_line_id
        ) values (
          v_org, v_item_id, v_serial, p_warehouse_id, v_inserted_line
        );
      end loop;
    end if;

    update public.purchase_order_items
      set quantity_received = quantity_received + v_line.qty_accepted
      where id = v_line.po_line_id;
  end loop;

  perform public.recompute_po_status(v_po.id);

  insert into public.idempotency_keys(
    organization_id, scope, key, request_hash, status, resource_type, resource_id
  ) values (
    v_org, 'receipt', p_idempotency_key, p_request_hash, 'completed',
    'receipt', v_receipt.id
  );

  return v_receipt;
end;
$function$;
```

- [ ] Create `supabase/tests/0296_post_receipt_v2_serial_optional.test.sql`. This is the FULL regression file — it re-proves every pre-existing serial path alongside the new one. Namespace `d0296000`.

```sql
-- supabase/tests/0296_post_receipt_v2_serial_optional.test.sql
--
-- Proves the SIXTH rewrite of post_receipt_v2 changed exactly one thing.
--
-- Structure:
--   Assertions 1-2   grant + fixture anti-vacuity
--   Assertions 3-6   REGRESSION R1: tracking_type='serial' is byte-identical
--                    (serials_required on null, serial_count_mismatch on the
--                    wrong count, success on the exact count, registry rows)
--   Assertions 7-9   REGRESSION: tracking_type='lot' unchanged
--   Assertions 10-12 REGRESSION: tracking_type='none' unchanged, and 0285's
--                    over-receipt allowance survives
--   Assertions 13-18 NEW: 'serial_optional' accepts null / empty / partial /
--                    full, rejects an over-count, and posts quantity in every
--                    case (the ledger invariant holds)
--
-- Negative control: with 0285's function re-created locally in place of 0296,
-- assertions 13-17 fail (serial_optional falls through every branch, so
-- serials are silently discarded and the over-count is never caught) while
-- 3-12 still pass. That is the proof this file is testing the delta.
--
-- Namespace: d0296000. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(18);

\set org      '\'d0296000-0000-0000-0000-000000000001\''
\set mgr      '\'d0296000-0000-0000-0000-000000000002\''
\set wh       '\'d0296000-0000-0000-0000-000000000003\''
\set itemSer  '\'d0296000-0000-0000-0000-000000000004\''
\set itemLot  '\'d0296000-0000-0000-0000-000000000005\''
\set itemNone '\'d0296000-0000-0000-0000-000000000006\''
\set itemOpt  '\'d0296000-0000-0000-0000-000000000007\''
\set po       '\'d0296000-0000-0000-0000-000000000008\''
\set lineSer  '\'d0296000-0000-0000-0000-000000000009\''
\set lineLot  '\'d0296000-0000-0000-0000-000000000010\''
\set lineNone '\'d0296000-0000-0000-0000-000000000011\''
\set lineOpt1 '\'d0296000-0000-0000-0000-000000000012\''
\set lineOpt2 '\'d0296000-0000-0000-0000-000000000013\''
\set lineOpt3 '\'d0296000-0000-0000-0000-000000000014\''
\set lineOpt4 '\'d0296000-0000-0000-0000-000000000015\''

insert into auth.users (id, email) values (:mgr, 'mgr-0296@example.test')
  on conflict (id) do nothing;
insert into public.organizations (id, name) values (:org, 'Receipt 0296 Org')
  on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :mgr, 'manager', now()) on conflict do nothing;
insert into public.warehouses (id, organization_id, name)
  values (:wh, :org, 'WH 0296') on conflict (id) do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
values
  (:itemSer,  :org, :wh, 'R96-SER',  'Serial Item',     0, 'active', 'serial'),
  (:itemLot,  :org, :wh, 'R96-LOT',  'Lot Item',        0, 'active', 'lot'),
  (:itemNone, :org, :wh, 'R96-NONE', 'Plain Item',      0, 'active', 'none'),
  (:itemOpt,  :org, :wh, 'R96-OPT',  'Optional Serial', 0, 'active', 'serial_optional')
on conflict (id) do nothing;

delete from public.item_stock_levels
  where item_id in (:itemSer, :itemLot, :itemNone, :itemOpt);

insert into public.purchase_orders (id, organization_id, po_number, status)
  values (:po, :org, 'PO-0296-1', 'ordered') on conflict (id) do nothing;

insert into public.purchase_order_items
  (id, organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost)
values
  (:lineSer,  :org, :po, :itemSer,  100, 0, 1),
  (:lineLot,  :org, :po, :itemLot,  100, 0, 1),
  (:lineNone, :org, :po, :itemNone, 10,  0, 1),
  (:lineOpt1, :org, :po, :itemOpt,  100, 0, 1),
  (:lineOpt2, :org, :po, :itemOpt,  100, 0, 1),
  (:lineOpt3, :org, :po, :itemOpt,  100, 0, 1),
  (:lineOpt4, :org, :po, :itemOpt,  100, 0, 1)
on conflict (id) do nothing;

-- ── 1. Grant unchanged across the rewrite ───────────────────────────────────
select ok(
  has_function_privilege('authenticated',
    'public.post_receipt_v2(uuid, uuid, jsonb, text, text, text)', 'EXECUTE'),
  'authenticated can still EXECUTE post_receipt_v2 (grant survives the 6th rewrite)');

-- ── 2. Anti-vacuity: the optional item really carries the new value ─────────
select is(
  (select tracking_type from public.inventory_items where id = :itemOpt),
  'serial_optional',
  'fixture check: the optional item is really on tracking_type ''serial_optional''');

set local "request.jwt.claim.sub" to 'd0296000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ── 3-6. REGRESSION R1: 'serial' behaviour is IDENTICAL ─────────────────────
select throws_ok(
  $$ select public.post_receipt_v2(
       'd0296000-0000-0000-0000-000000000008'::uuid,
       'd0296000-0000-0000-0000-000000000003'::uuid,
       jsonb_build_array(jsonb_build_object(
         'po_line_id','d0296000-0000-0000-0000-000000000009',
         'qty_received',3,'qty_accepted',3,'qty_rejected',0,'unit_cost',1)),
       'idem-0296-ser-null','hash-0296-ser-null',null) $$,
  '23514',
  'serials_required',
  'R1: a serial item receiving qty>0 with NO serials is still BLOCKED');

select throws_ok(
  $$ select public.post_receipt_v2(
       'd0296000-0000-0000-0000-000000000008'::uuid,
       'd0296000-0000-0000-0000-000000000003'::uuid,
       jsonb_build_array(jsonb_build_object(
         'po_line_id','d0296000-0000-0000-0000-000000000009',
         'qty_received',3,'qty_accepted',3,'qty_rejected',0,'unit_cost',1,
         'serials', jsonb_build_array('SN-A','SN-B'))),
       'idem-0296-ser-short','hash-0296-ser-short',null) $$,
  '23514',
  'serial_count_mismatch',
  'R1: a serial item with the WRONG serial count is still BLOCKED');

select lives_ok(
  $$ select public.post_receipt_v2(
       'd0296000-0000-0000-0000-000000000008'::uuid,
       'd0296000-0000-0000-0000-000000000003'::uuid,
       jsonb_build_array(jsonb_build_object(
         'po_line_id','d0296000-0000-0000-0000-000000000009',
         'qty_received',3,'qty_accepted',3,'qty_rejected',0,'unit_cost',1,
         'serials', jsonb_build_array('SN-A','SN-B','SN-C'))),
       'idem-0296-ser-ok','hash-0296-ser-ok',null) $$,
  'R1: a serial item with exactly qty_accepted serials still succeeds');

select is(
  (select count(*)::int from public.serial_registry where item_id = :itemSer),
  3,
  'R1: three serial_registry rows were written, one per unit');

-- ── 7-9. REGRESSION: 'lot' behaviour is IDENTICAL ───────────────────────────
select throws_ok(
  $$ select public.post_receipt_v2(
       'd0296000-0000-0000-0000-000000000008'::uuid,
       'd0296000-0000-0000-0000-000000000003'::uuid,
       jsonb_build_array(jsonb_build_object(
         'po_line_id','d0296000-0000-0000-0000-000000000010',
         'qty_received',5,'qty_accepted',5,'qty_rejected',0,'unit_cost',1)),
       'idem-0296-lot-null','hash-0296-lot-null',null) $$,
  '23514',
  'lot_required',
  'lot item with no lots is still BLOCKED');

select throws_ok(
  $$ select public.post_receipt_v2(
       'd0296000-0000-0000-0000-000000000008'::uuid,
       'd0296000-0000-0000-0000-000000000003'::uuid,
       jsonb_build_array(jsonb_build_object(
         'po_line_id','d0296000-0000-0000-0000-000000000010',
         'qty_received',5,'qty_accepted',5,'qty_rejected',0,'unit_cost',1,
         'lots', jsonb_build_array(jsonb_build_object(
           'lot_number','L1','expiration_date','2027-01-01','qty_base',2)))),
       'idem-0296-lot-short','hash-0296-lot-short',null) $$,
  '23514',
  'lot_qty_mismatch',
  'lot quantities that do not sum to qty_accepted are still BLOCKED');

select lives_ok(
  $$ select public.post_receipt_v2(
       'd0296000-0000-0000-0000-000000000008'::uuid,
       'd0296000-0000-0000-0000-000000000003'::uuid,
       jsonb_build_array(jsonb_build_object(
         'po_line_id','d0296000-0000-0000-0000-000000000010',
         'qty_received',5,'qty_accepted',5,'qty_rejected',0,'unit_cost',1,
         'lots', jsonb_build_array(jsonb_build_object(
           'lot_number','L1','expiration_date','2027-01-01','qty_base',5)))),
       'idem-0296-lot-ok','hash-0296-lot-ok',null) $$,
  'a lot receipt whose lots sum correctly still succeeds');

-- ── 10-12. REGRESSION: 'none', over-receipt (0285), and the ledger ──────────
select lives_ok(
  $$ select public.post_receipt_v2(
       'd0296000-0000-0000-0000-000000000008'::uuid,
       'd0296000-0000-0000-0000-000000000003'::uuid,
       jsonb_build_array(jsonb_build_object(
         'po_line_id','d0296000-0000-0000-0000-000000000011',
         'qty_received',25,'qty_accepted',25,'qty_rejected',0,'unit_cost',1)),
       'idem-0296-over','hash-0296-over',null) $$,
  '0285 over-receipt allowance survives: 25 accepted against 10 ordered still posts');

select is(
  (select quantity_on_hand from public.inventory_items where id = :itemNone),
  25::numeric(14,4),
  'the over-received quantity landed on quantity_on_hand');

select is(
  (select coalesce(sum(quantity_change), 0) from public.stock_movements
     where item_id = 'd0296000-0000-0000-0000-000000000006'::uuid),
  25::numeric,
  'LEDGER INVARIANT: SUM(stock_movements) equals quantity_on_hand for the plain item');

-- ── 13-18. NEW: 'serial_optional' ───────────────────────────────────────────
select lives_ok(
  $$ select public.post_receipt_v2(
       'd0296000-0000-0000-0000-000000000008'::uuid,
       'd0296000-0000-0000-0000-000000000003'::uuid,
       jsonb_build_array(jsonb_build_object(
         'po_line_id','d0296000-0000-0000-0000-000000000012',
         'qty_received',4,'qty_accepted',4,'qty_rejected',0,'unit_cost',1)),
       'idem-0296-opt-null','hash-0296-opt-null',null) $$,
  'serial_optional accepts a receipt with NO serials at all (no fake placeholders needed)');

select lives_ok(
  $$ select public.post_receipt_v2(
       'd0296000-0000-0000-0000-000000000008'::uuid,
       'd0296000-0000-0000-0000-000000000003'::uuid,
       jsonb_build_array(jsonb_build_object(
         'po_line_id','d0296000-0000-0000-0000-000000000013',
         'qty_received',4,'qty_accepted',4,'qty_rejected',0,'unit_cost',1,
         'serials', jsonb_build_array())),
       'idem-0296-opt-empty','hash-0296-opt-empty',null) $$,
  'serial_optional accepts an EMPTY serials array (which ''serial'' would reject)');

select lives_ok(
  $$ select public.post_receipt_v2(
       'd0296000-0000-0000-0000-000000000008'::uuid,
       'd0296000-0000-0000-0000-000000000003'::uuid,
       jsonb_build_array(jsonb_build_object(
         'po_line_id','d0296000-0000-0000-0000-000000000014',
         'qty_received',4,'qty_accepted',4,'qty_rejected',0,'unit_cost',1,
         'serials', jsonb_build_array('OPT-1','OPT-2'))),
       'idem-0296-opt-partial','hash-0296-opt-partial',null) $$,
  'serial_optional accepts a PARTIAL tagging (2 serials against 4 units)');

select is(
  (select count(*)::int from public.serial_registry where item_id = :itemOpt),
  2,
  'exactly the two supplied serials were registered — the untagged 2 units created no rows');

select throws_ok(
  $$ select public.post_receipt_v2(
       'd0296000-0000-0000-0000-000000000008'::uuid,
       'd0296000-0000-0000-0000-000000000003'::uuid,
       jsonb_build_array(jsonb_build_object(
         'po_line_id','d0296000-0000-0000-0000-000000000015',
         'qty_received',2,'qty_accepted',2,'qty_rejected',0,'unit_cost',1,
         'serials', jsonb_build_array('OPT-X','OPT-Y','OPT-Z'))),
       'idem-0296-opt-over','hash-0296-opt-over',null) $$,
  '23514',
  'serial_count_exceeds_quantity',
  'serial_optional REJECTS more serials than accepted units (no double-counting)');

select is(
  (select quantity_on_hand from public.inventory_items where id = :itemOpt),
  12::numeric(14,4),
  'LEDGER INVARIANT: all three successful optional receipts (4+4+4) posted quantity');

select * from finish();
rollback;
```

- [ ] Run `supabase db reset && pnpm db:test 2>&1 | grep -E "0295|0296|Result:"`. All 8 + 18 assertions must pass.
- [ ] **Run the negative control.** In a scratch psql session (NOT a committed file), re-create the 0285 body over the 0296 one and re-run `supabase/tests/0296_post_receipt_v2_serial_optional.test.sql`. Record which assertions fail. Expect 13-17 to fail and 1-12 to pass. If assertions 3-12 fail under the OLD function, the regression half of the file is wrong and must be fixed before proceeding.
- [ ] Map the new error in `apps/web/src/server/services/receiving.ts` (the mapping block at ~187-256). Anything unmapped surfaces as a bare `internal_error` — exactly the failure 0285's header calls out. Add alongside the existing `serials_required`/`serial_count_mismatch` arm:

```ts
    if (msg.includes('serial_count_exceeds_quantity')) {
      throw new ServiceError(
        'validation_error',
        'More serial numbers were entered than units accepted. Remove the extras, or raise the accepted quantity.',
      );
    }
```

- [ ] While in `receiving.ts`, map the currently-unmapped duplicate-serial constraint violation, which `serial_optional` makes much easier to hit (staff scanning the same tag twice):

```ts
    if ((e as { code?: string }).code === '23505' && msg.includes('serial_registry')) {
      throw new ServiceError(
        'conflict',
        'That serial number is already registered for this item.',
      );
    }
```

- [ ] Widen the zod enum in `packages/core/src/schemas/inventory.ts`. Replace the `trackingType` line and its doc comment:

```ts
  /**
   * 'none' (default), 'lot', 'serial', or 'serial_optional'. Drives capture
   * requirements at receive time. 'serial_optional' (0295) accepts 0..qty
   * serials and never requires them — the Sports OPTIONAL_SERIALIZED mode.
   */
  trackingType: z.enum(['none', 'lot', 'serial', 'serial_optional']).default('none'),
```

- [ ] Widen the inline `'none' | 'lot' | 'serial'` unions at every site the audit enumerated. Each becomes `'none' | 'lot' | 'serial' | 'serial_optional'`:
  - `apps/web/src/server/loaders/inventory-list.ts:276`
  - `apps/web/src/server/services/inventory.ts:876`, `:1016`, `:1038-1041`, `:1853`
  - `apps/web/src/server/services/po-imports.ts:1243`
  - `apps/web/src/server/services/po-imports-lines.ts:484`
  - `apps/web/src/components/po/po-receive-dialog.tsx:30`
  - `apps/web/src/components/inventory/item-form.tsx:1557`
  - `apps/web/src/app/(dashboard)/dashboard/purchase-orders/[id]/page.tsx:119`
  - `apps/web/src/app/(dashboard)/dashboard/books/[id]/edit/page.tsx:163-165`
  - `apps/web/src/app/(dashboard)/dashboard/inventory/[id]/edit/page.tsx:157-161`
- [ ] Teach the receive dialog the new branch. In `apps/web/src/components/po/po-receive-dialog.tsx`, the serial UI currently renders only for `=== 'serial'` and validates an exact count. Change the render gate to include the new value and relax the count rule for it only:

```tsx
const wantsSerials =
  line.trackingType === 'serial' || line.trackingType === 'serial_optional';
const serialsRequired = line.trackingType === 'serial';
// ...
if (serialsRequired && serials.length !== qtyAccepted) {
  return 'Enter one serial per accepted unit.';
}
if (!serialsRequired && serials.length > qtyAccepted) {
  return 'You have entered more serials than units accepted.';
}
```

  Keep the existing within-line duplicate-serial check for both values — it is a real guard the RPC does not have.
- [ ] Reveal the serials panel for the new value. `apps/web/src/components/inventory/item-detail.tsx:302` becomes `['serial', 'serial_optional'].includes(item.tracking_type ?? 'none')`. Mirror it in `apps/mobile/app/item/[id].tsx` (the `item.tracking_type === 'serial' || serialCount > 0` gate).
- [ ] Add `'item.tracking_type.changed'` coverage: no change needed — the audit event already exists (`apps/web/src/server/services/audit.ts:76`) and is value-agnostic.
- [ ] Run `pnpm typecheck` and `pnpm test`. Both must be clean; the typecheck is what proves no enumerator site was missed.
- [ ] **Regression (mobile receive path):** `apps/mobile/app/po/[id].tsx:323-330` never sends `lots` or `serials`. Confirm a `serial_optional` item receives cleanly from mobile with no payload change — that is the whole point of the null-tolerant branch. Also delete the now-stale comment at `apps/mobile/app/po/[id].tsx:272-286` claiming the RPC hard-blocks over-receipt (0285 removed that guard; the comment has been wrong since).

---

## Task 4: The `sports` module and its permission

Packaging. Owner decision: a self-contained `sports` module that grants its own serial modes with NO `lot_serial` dependency. `lot_serial` stays grandfathered OFF and untouched.

**Files:**
- Modify: `packages/core/src/modules/registry.ts`
- Modify: `packages/core/src/constants/permissions.ts`
- Create: `supabase/migrations/0297_sports_module.sql`
- Create: `supabase/tests/0297_sports_module.test.sql`
- Modify: `supabase/tests/0207_permission_overrides.test.sql` (row count 109 -> 111)
- Modify: `apps/web/src/components/dashboard/icons.ts`, `apps/mobile/src/lib/nav-icons.ts`

**Interfaces:**
- Consumes from Task 1: nothing directly (the module gates the UI the later tasks build).
- Produces for Tasks 8-19: `ModuleId` value `'sports'`, `Permission` value `'sports:manage'`, and `assertModuleEnabled(ctx, 'sports')` as the server gate.

**Steps:**

- [ ] Add `'sports'` to the `ModuleId` union in `packages/core/src/modules/registry.ts` — append to the premium line:

```ts
  | 'lot_serial' | 'reports_advanced' | 'ai_shelf_scan' | 'instant_size_count' | 'api_access' | 'price_tracking' | 'live_tracking' | 'zendesk' | 'sports';
```

- [ ] Add the `MODULE_REGISTRY.sports` entry, placed with the other premium modules (after `instant_size_count`):

```ts
  sports: {
    id: 'sports',
    tier: 'premium',
    title: 'Sports inventory',
    // NO lot_serial dependency (owner decision 2026-07-27). This module grants
    // its OWN serial modes for sports categories; lot_serial stays
    // grandfathered off and untouched for every org.
    dependsOn: ['inventory'],
    permissions: ['sports:manage'],
    surfaces: ['web', 'mobile'],
    apiPrefixes: ['/api/v1/product-groups'],
    ownsTables: ['product_groups', 'size_scales', 'size_scale_values'],
    minPlan: 'business',
    // Off by default everywhere — enabled per-org for sports customers.
    defaultOnFor: [],
    placements: [
      {
        surface: 'web_sidebar',
        section: 'inventory',
        label: 'Product groups',
        href: '/dashboard/product-groups',
        iconName: 'Layers',
        defaultSortOrder: 25,
        requires: 'sports:manage',
      },
      {
        surface: 'mobile_drawer',
        section: 'inventory',
        label: 'Product groups',
        href: '/product-groups',
        iconName: 'Layers',
        defaultSortOrder: 25,
        requires: 'sports:manage',
      },
    ],
  },
```

- [ ] Register the `Layers` icon in BOTH icon maps or the nav silently falls back: `apps/web/src/components/dashboard/icons.ts` (`NAV_ICONS`, lucide-react, falls back to `Boxes`) and `apps/mobile/src/lib/nav-icons.ts` (lucide-react-native, falls back to `Box`).
- [ ] Add the permission in `packages/core/src/constants/permissions.ts` — all FOUR required edits, or the build breaks or the matrix misbehaves:
  1. Append `'sports:manage',` to the `PERMISSIONS` array.
  2. Add it to `ROLE_PERMISSIONS` for `manager` (owner/admin derive from `ALL_PERMISSIONS` automatically).
  3. Add a `PERMISSION_META` entry — this record is exhaustive, so omitting it is a compile error:

```ts
  'sports:manage': {
    group: 'Inventory',
    label: 'Manage sports products',
    description:
      'Create sports categories and subcategories, edit tracking profiles and size scales, override product grouping, and change an item tracking mode.',
  },
```

  4. Add `'sports:manage'` to `FULLY_GRANTABLE_PERMISSIONS` — the write-path RLS in 0294 uses `has_permission()`, so it qualifies.
- [ ] Create `supabase/migrations/0297_sports_module.sql`. The `seed_org_modules()` VALUES list must be rebuilt on top of the LATEST version, which is in `0174_enable_returns_module.sql` — not 0162. Copy that list verbatim and append one row.

```sql
-- 0297_sports_module.sql
--
-- Registers the self-contained 'sports' premium module and its permission.
--
-- OWNER DECISION 2026-07-27: sports is self-contained. It grants its own
-- serial modes for sports categories and has NO lot_serial dependency;
-- lot_serial stays grandfathered OFF and untouched for every org.
--
-- Note: 'instant_size_count' was never added to seed_org_modules() nor
-- grandfathered — that is pre-existing drift and this migration does not
-- attempt to fix it (a separate decision).

-- ── 1) Grandfather every existing org: 'sports' OFF ─────────────────────────
insert into public.organization_modules (organization_id, module_id, enabled, tier, enabled_at)
select o.id, 'sports', false, 'premium', now()
from public.organizations o
on conflict (organization_id, module_id) do nothing;

-- ── 2) New-org seed: the 0174 list verbatim + 'sports' premium OFF ──────────
-- IMPLEMENTER: copy the VALUES list from 0174_enable_returns_module.sql
-- EXACTLY as it stands, then append the final ('sports','premium', false) row.
-- Do not re-order, do not tidy, do not drop a module — this function is
-- rewritten wholesale by each module migration and any omission silently
-- stops seeding that module for every org created afterwards.
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
    -- <<< VERBATIM COPY of the VALUES rows from 0174_enable_returns_module.sql >>>
    ('sports','premium', false)
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

-- ── 3) minPlan parity with the TS registry (mirrors 0219) ───────────────────
-- The TS entry sets minPlan 'business'. Without this arm the SQL falls to
-- `else 0` and RLS would let any plan enable it — the exact drift
-- instant_size_count already has.
create or replace function public.org_can_enable_module(org_id uuid, p_module text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce((select all_modules_comp from public.organizations where id = org_id), false)
    or (
      case public.org_effective_tier(org_id)
        when 'pro' then 1 when 'business' then 2 when 'enterprise' then 3 else 0
      end
    ) >= (
      case p_module
        when 'lot_serial' then 2
        when 'reports_advanced' then 2
        when 'ai_shelf_scan' then 2
        when 'sports' then 2
        when 'api_access' then 3
        else 0
      end
    );
$$;

-- ── 4) Seed the permission defaults (mirrors 0279) ──────────────────────────
-- Owner/admin derive from ALL_PERMISSIONS in TS; the table flattens
-- admin/manager/staff/viewer, so two rows here. The 0207 pgTAP count moves
-- from 109 to 111.
insert into public.role_default_permissions (role, permission) values
  ('admin',   'sports:manage'),
  ('manager', 'sports:manage')
on conflict (role, permission) do nothing;
```

- [ ] Create `supabase/tests/0297_sports_module.test.sql`. Namespace `50297000`.

```sql
-- supabase/tests/0297_sports_module.test.sql
--
-- Proves 0297: the sports module is registered OFF everywhere, seeds OFF for
-- new orgs, is plan-gated, and does NOT touch lot_serial.
--
-- Namespace: 50297000. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(7);

\set orgOld '\'50297000-0000-0000-0000-000000000001\''
\set orgNew '\'50297000-0000-0000-0000-000000000002\''

-- An org that existed BEFORE the migration is represented by the grandfather
-- insert having already run; assert the shape holds for every org.
insert into public.organizations (id, name) values (:orgOld, 'Pre-existing 0297')
  on conflict (id) do nothing;

select is(
  (select count(*)::int from public.organizations o
    where not exists (
      select 1 from public.organization_modules om
      where om.organization_id = o.id and om.module_id = 'sports')),
  0,
  'every organization has a sports module row (grandfather insert covered them all)');

select is(
  (select count(*)::int from public.organization_modules
    where module_id = 'sports' and enabled),
  0,
  'sports is DISABLED for every org — nothing is switched on by the migration');

-- New orgs get the row from seed_org_modules().
insert into public.organizations (id, name) values (:orgNew, 'Fresh org 0297')
  on conflict (id) do nothing;

select is(
  (select enabled from public.organization_modules
    where organization_id = :orgNew and module_id = 'sports'),
  false,
  'a newly created org seeds sports OFF');

select is(
  (select tier from public.organization_modules
    where organization_id = :orgNew and module_id = 'sports'),
  'premium',
  'sports seeds at the premium tier');

-- The seed rebuild did not drop a pre-existing module.
select ok(
  (select count(*) from public.organization_modules where organization_id = :orgNew) >= 30,
  'the seed_org_modules rebuild kept every pre-existing module (no VALUES row was lost)');

-- lot_serial is untouched (owner decision: no dependency, stays off).
select is(
  (select enabled from public.organization_modules
    where organization_id = :orgNew and module_id = 'lot_serial'),
  false,
  'lot_serial is still grandfathered OFF and untouched by the sports module');

-- Plan gate parity with the TS minPlan.
select is(
  public.org_can_enable_module(:orgNew, 'sports'),
  false,
  'a starter-plan org cannot enable sports (minPlan business is mirrored in SQL)');

select * from finish();
rollback;
```

- [ ] Update the row-count assertion in `supabase/tests/0207_permission_overrides.test.sql` from `109` to `111`, and extend the explanatory string with `; +2 sports:manage rows from 0297`.
- [ ] Run `supabase db reset && pnpm db:test 2>&1 | grep -E "0207|0297|Result:"`.
- [ ] Run `pnpm --filter @stockpilot/core test`. The registry guard tests in `packages/core/src/modules/registry.test.ts` must pass, specifically: every module id matches its record key; `dependsOn` is acyclic and known; every nav placement href is unique per surface; and each module's `permissions` array is a superset of the `requires` it uses (this one fails if `'sports:manage'` is omitted from the entry's `permissions`).
- [ ] **Regression:** confirm `/dashboard/settings/modules` lists "Sports inventory" automatically (that page iterates `Object.values(MODULE_REGISTRY)`), and that toggling it on for Demo Co is refused unless Demo Co is on the business plan or carries `all_modules_comp`.

---

# Phase 3 — Group / variant / unit model

## Task 5: `product_groups` and the `inventory_items` variant columns (migration 0298)

The whole schema delta for the hierarchy. `product_groups` is identity ONLY — it owns no quantity column, and never will. `inventory_items` gains first-class variant attributes because `custom_fields` is unindexed and unconstrained.

**Files:**
- Create: `supabase/migrations/0298_product_groups_and_variants.sql`
- Create: `supabase/tests/0298_product_groups_and_variants.test.sql`

**Interfaces:**
- Consumes from Task 2: `size_scales` (for `product_groups.size_scale_id`). From Task 4: nothing at the DB level (the module gate is application-side).
- Produces for Tasks 6, 7, 8, 13, 14, 17, 18, 19: table `product_groups`; columns `inventory_items.group_id`, `variant_size`, `variant_size_original`, `variant_size_system`, `variant_width`, `variant_fit`, `variant_color`, `jersey_number`, `player_name`, `variant_key`; and the view `product_group_rollups`.

**Steps:**

- [ ] Create `supabase/migrations/0298_product_groups_and_variants.sql`:

```sql
-- 0298_product_groups_and_variants.sql
--
-- Phase 3 of the Sports program: the GROUP overlay and first-class VARIANT
-- attributes.
--
-- ARCHITECTURE (forced by the Phase 1 audit): inventory_items stays the ONLY
-- stock-bearing entity. Every operational flow FKs item_id and the ledger
-- invariant SUM(stock_movements) = quantity_on_hand makes inventory_items the
-- mandatory quantity owner. So: GROUP = this new table (identity only),
-- VARIANT = an inventory_items SKU family, UNIT = serial_registry. That is the
-- only shape that leaves adjust_stock / apply_level_delta untouched.
--
-- product_groups OWNS NO QUANTITY, EVER. There is deliberately no
-- quantity_on_hand, no total, no cached count. Roll-ups are derived at read
-- time from the variants (see the view at the end).
--
-- group_id IS NULLABLE WITH NO BACKFILL. null = every item in every existing
-- org, whose behaviour is completely unchanged. There is NO name-heuristic
-- backfill anywhere in this migration (owner decision 2026-07-27: existing
-- families link opt-in via a review tool; a heuristic backfill would bake
-- wrong groupings into persistent identity).
--
-- jersey_number IS DELIBERATELY NON-UNIQUE. The same number legitimately
-- repeats across sizes, groups, teams, seasons and warehouses. The Model B
-- uniqueness key (organization_id, sku, charter_id, bin_location) is NOT
-- touched by this migration.

-- ── 1) product_groups ───────────────────────────────────────────────────────
create table public.product_groups (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  category_id      uuid references public.categories(id) on delete set null,
  /* Denormalized subcategory key for fast filtering; mirrors the category. */
  subcategory_key  text,
  name             text not null,
  brand            text,
  manufacturer     text,
  model            text,
  style_number     text,
  /* Colorway lives at GROUP level by default (see the open policy question).
     A group whose variants differ by colorway sets this NULL and carries the
     colorway on inventory_items.variant_color instead. */
  colorway         text,
  /* Jersey identity attributes. */
  team             text,
  league           text,
  season           text,
  home_away        text check (home_away is null or home_away in ('home','away','alternate')),
  color            text,
  size_scale_id    uuid references public.size_scales(id) on delete set null,
  default_counting_unit text not null default 'each'
                     check (default_counting_unit in ('unit','each','pair','set','case')),
  tracking_mode    text
                     check (tracking_mode is null or tracking_mode in (
                       'QUANTITY','QUANTITY_BY_VARIANT','NUMBERED_VARIANT',
                       'SERIALIZED','OPTIONAL_SERIALIZED','INDIVIDUALLY_TAGGED','LOT_TRACKED'
                     )),
  /* Deterministic identity key. Built by packages/core/src/sports/variant-keys.ts
     and written by the service — never derived in SQL, so the TS normalizers
     stay the single source of truth. */
  group_key        text not null,
  status           text not null default 'active'
                     check (status in ('active','archived','discontinued')),
  created_by       uuid references public.user_profiles(id) on delete set null,
  updated_by       uuid references public.user_profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

-- One group per identity per org. This is what makes "shoe sizes 9/10/11 are
-- ONE group" enforceable rather than aspirational.
create unique index product_groups_org_key_uniq
  on public.product_groups (organization_id, group_key)
  where deleted_at is null;

create index product_groups_org_status_idx
  on public.product_groups (organization_id, status) where deleted_at is null;
create index product_groups_category_idx
  on public.product_groups (organization_id, category_id) where deleted_at is null;
-- Supports the group-first import matcher (Task 14).
create index product_groups_brand_style_idx
  on public.product_groups (organization_id, lower(brand), lower(style_number))
  where deleted_at is null;
create index product_groups_team_season_idx
  on public.product_groups (organization_id, lower(team), lower(season))
  where deleted_at is null;

create trigger product_groups_set_updated_at
  before update on public.product_groups
  for each row execute function public.tg_set_updated_at();

comment on table public.product_groups is
  'Shared product identity (Nike Pegasus 41; Falcons Home Jersey). OWNS NO '
  'QUANTITY, EVER — quantity lives only on inventory_items. Variants are the '
  'inventory_items rows whose group_id points here.';

comment on column public.product_groups.group_key is
  'Deterministic identity key built by packages/core/src/sports/variant-keys.ts. '
  'Never a name string alone (requirements: matching is deterministic, never '
  'name-string-only).';

-- ── 2) inventory_items variant columns ──────────────────────────────────────
alter table public.inventory_items
  /* NULL = not part of a group. Every existing row, in every existing org. */
  add column if not exists group_id uuid references public.product_groups(id) on delete set null,
  /* Normalized size for matching and ordering ('10.5', 'XL'). */
  add column if not exists variant_size text,
  /* The size EXACTLY as imported/typed. Never overwritten by normalization. */
  add column if not exists variant_size_original text,
  add column if not exists variant_size_system text,
  add column if not exists variant_width text,
  add column if not exists variant_fit text,
  add column if not exists variant_color text,
  /* Normalized TEXT preserving meaningful leading zeroes. NON-UNIQUE BY
     DESIGN — see the migration header. */
  add column if not exists jersey_number text,
  add column if not exists player_name text,
  /* Deterministic variant identity within the group. Written by the service. */
  add column if not exists variant_key text;

-- Length guards. These are the constraints custom_fields could never give us.
alter table public.inventory_items
  drop constraint if exists inventory_items_jersey_number_check;
alter table public.inventory_items
  add constraint inventory_items_jersey_number_check
  check (
    jersey_number is null
    or (length(jersey_number) between 1 and 4 and jersey_number ~ '^[0-9]+$')
  );

alter table public.inventory_items
  drop constraint if exists inventory_items_variant_size_check;
alter table public.inventory_items
  add constraint inventory_items_variant_size_check
  check (variant_size is null or length(variant_size) between 1 and 24);

comment on column public.inventory_items.jersey_number is
  'Uniform number as normalized TEXT, preserving meaningful leading zeroes '
  '(0, 00, 07, 12, 99). NOT UNIQUE and never part of any uniqueness key — the '
  'same number legitimately repeats across sizes, groups, teams, seasons and '
  'warehouses. NEVER a serial number, and never labelled as one in any UI.';

comment on column public.inventory_items.variant_size_original is
  'The size string exactly as imported or typed. Kept alongside the normalized '
  'form so an approved cross-system mapping is always auditable against the '
  'source (requirements: "Keep original imported text + normalized form").';

comment on column public.inventory_items.group_id is
  'The product group this item is a variant of. NULL = ungrouped, which is '
  'every item in every org until an opt-in link is made. No heuristic backfill '
  'ever writes this column.';

-- Variant lookup: the group detail page and the import matcher both start here.
create index inventory_items_group_idx
  on public.inventory_items (group_id)
  where group_id is not null and deleted_at is null;

-- Variant identity within a group. Not UNIQUE: Model B allows several
-- PLACEMENT rows for one variant (same sku, different charter/bin), and each
-- carries the same variant_key.
create index inventory_items_group_variant_idx
  on public.inventory_items (group_id, variant_key)
  where group_id is not null and deleted_at is null;

-- Jersey-number search, per org. Non-unique on purpose.
create index inventory_items_jersey_number_idx
  on public.inventory_items (organization_id, jersey_number)
  where jersey_number is not null and deleted_at is null;

-- ── 3) RLS on product_groups ────────────────────────────────────────────────
alter table public.product_groups enable row level security;

create policy product_groups_select on public.product_groups
  for select to authenticated
  using ((select public.is_org_member(organization_id)));

create policy product_groups_insert on public.product_groups
  for insert to authenticated
  with check (
    (select public.has_org_role(organization_id, 'manager'))
    or (select public.has_permission(organization_id, 'sports:manage'))
    or (select public.has_permission(organization_id, 'items:create'))
  );

create policy product_groups_update on public.product_groups
  for update to authenticated
  using (
    (select public.has_org_role(organization_id, 'manager'))
    or (select public.has_permission(organization_id, 'sports:manage'))
  )
  with check (
    (select public.has_org_role(organization_id, 'manager'))
    or (select public.has_permission(organization_id, 'sports:manage'))
  );

create policy product_groups_delete on public.product_groups
  for delete to authenticated
  using ((select public.has_org_role(organization_id, 'manager')));

-- EXPLICIT GRANT (0067). Missing grants cause real 403s on hardened projects
-- even when RLS would allow the row. Migration 0283 omitted this; do not.
grant select, insert, update, delete on public.product_groups to authenticated;

-- ── 4) Derived roll-up view ─────────────────────────────────────────────────
-- The ONLY place a group total exists. Recomputed on every read, never stored.
-- "6 variants · 52 pairs total" comes from here.
create or replace view public.product_group_rollups as
select
  g.id                                                as group_id,
  g.organization_id,
  count(distinct i.variant_key)
    filter (where i.variant_key is not null)          as variant_count,
  count(i.id)                                         as placement_count,
  coalesce(sum(i.quantity_on_hand), 0)                as total_quantity,
  g.default_counting_unit                             as counting_unit
from public.product_groups g
left join public.inventory_items i
  on i.group_id = g.id
 and i.deleted_at is null
 and i.status <> 'archived'
where g.deleted_at is null
group by g.id, g.organization_id, g.default_counting_unit;

comment on view public.product_group_rollups is
  'Derived group totals. product_groups stores NO quantity — this view is the '
  'only source of a group-level total, and it is recomputed on every read.';

-- The view inherits RLS from product_groups and inventory_items because it is
-- a plain (security invoker) view over RLS-protected tables.
grant select on public.product_group_rollups to authenticated;
```

- [ ] Create `supabase/tests/0298_product_groups_and_variants.test.sql`. Namespace `9e298000`. This file carries the R2 and R3 regression proofs.

```sql
-- supabase/tests/0298_product_groups_and_variants.test.sql
--
-- Proves 0298: the group overlay, variant columns, and the two headline
-- requirements scenarios.
--
-- Assertion index:
--   1-6    schema shape (columns exist, group has NO quantity column)
--   7      anti-vacuity: existing items really have a NULL group_id
--   8-11   R2: shoe sizes 9/10/11 -> ONE group, per-size qty, ZERO serials
--   12-15  R3: jersey #12 in M(3) + XL(2) -> total 5, number repeats, not a serial
--   16-17  jersey_number CHECK: leading zeroes preserved, junk rejected
--   18     group_key uniqueness per org
--   19     Model B key untouched
--
-- Namespace: 9e298000. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(19);

\set org    '\'9e298000-0000-0000-0000-000000000001\''
\set usr    '\'9e298000-0000-0000-0000-000000000002\''
\set wh     '\'9e298000-0000-0000-0000-000000000003\''
\set gShoe  '\'9e298000-0000-0000-0000-000000000004\''
\set gJers  '\'9e298000-0000-0000-0000-000000000005\''
\set s9     '\'9e298000-0000-0000-0000-000000000006\''
\set s10    '\'9e298000-0000-0000-0000-000000000007\''
\set s11    '\'9e298000-0000-0000-0000-000000000008\''
\set j12m   '\'9e298000-0000-0000-0000-000000000009\''
\set j12xl  '\'9e298000-0000-0000-0000-000000000010\''
\set legacy '\'9e298000-0000-0000-0000-000000000011\''

insert into auth.users (id, email) values (:usr, 'u-0298@example.test')
  on conflict (id) do nothing;
insert into public.organizations (id, name) values (:org, 'Sports 0298 Org')
  on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :usr, 'manager', now()) on conflict do nothing;
insert into public.warehouses (id, organization_id, name)
  values (:wh, :org, 'WH 0298') on conflict (id) do nothing;

-- ── 1-6. Schema shape ───────────────────────────────────────────────────────
select has_column('public', 'inventory_items', 'group_id', 'inventory_items.group_id exists');
select has_column('public', 'inventory_items', 'variant_size', 'inventory_items.variant_size exists');
select has_column('public', 'inventory_items', 'variant_size_original', 'the ORIGINAL imported size text is preserved in its own column');
select has_column('public', 'inventory_items', 'jersey_number', 'inventory_items.jersey_number exists');
select has_column('public', 'inventory_items', 'variant_key', 'inventory_items.variant_key exists');

-- THE invariant: a group must never own quantity.
select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'product_groups'
      and column_name in ('quantity_on_hand','quantity','total_quantity','on_hand')),
  0,
  'product_groups owns NO quantity column — not now, not ever');

-- ── 7. Anti-vacuity: a plain legacy item is ungrouped ───────────────────────
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:legacy, :org, :wh, 'LEGACY-0298', 'Ordinary Widget', 7, 'active', 'none')
  on conflict (id) do nothing;

select is(
  (select group_id from public.inventory_items where id = :legacy),
  null,
  'an item created without a group has a NULL group_id — existing orgs are untouched');

-- ── 8-11. R2: shoe sizes 9/10/11 are ONE group with no fake serials ─────────
insert into public.product_groups
  (id, organization_id, name, brand, model, style_number, group_key,
   default_counting_unit, tracking_mode)
  values (:gShoe, :org, 'Nike Pegasus 41', 'Nike', 'Pegasus 41', 'FD2722',
          'shoes|nike|pegasus 41|fd2722|black-white', 'pair', 'QUANTITY_BY_VARIANT')
  on conflict (id) do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status,
   tracking_type, group_id, variant_size, variant_size_original,
   variant_size_system, unit_of_measure, variant_key)
values
  (:s9,  :org, :wh, 'PEG41-9',  'Nike Pegasus 41 - 9',  4, 'active', 'none',
   :gShoe, '9',  'US 9',  'US_MENS', 'pair', 'size=9|system=US_MENS'),
  (:s10, :org, :wh, 'PEG41-10', 'Nike Pegasus 41 - 10', 6, 'active', 'none',
   :gShoe, '10', 'US 10', 'US_MENS', 'pair', 'size=10|system=US_MENS'),
  (:s11, :org, :wh, 'PEG41-11', 'Nike Pegasus 41 - 11', 2, 'active', 'none',
   :gShoe, '11', 'US 11', 'US_MENS', 'pair', 'size=11|system=US_MENS')
on conflict (id) do nothing;

select is(
  (select count(distinct group_id)::int from public.inventory_items
    where id in (:s9, :s10, :s11)),
  1,
  'R2: sizes 9, 10 and 11 all hang off exactly ONE product group');

select is(
  (select variant_count::int from public.product_group_rollups where group_id = :gShoe),
  3,
  'R2: the roll-up reports 3 variants');

select is(
  (select total_quantity from public.product_group_rollups where group_id = :gShoe),
  12::numeric,
  'R2: per-size quantities (4+6+2) roll up to 12 pairs — derived, never stored');

select is(
  (select count(*)::int from public.serial_registry
    where item_id in (:s9, :s10, :s11)),
  0,
  'R2: ZERO serial rows — no fake placeholders were created for a quantity product');

-- ── 12-15. R3: jersey #12 in M(3) + XL(2) totals 5 ──────────────────────────
insert into public.product_groups
  (id, organization_id, name, team, season, home_away, group_key,
   default_counting_unit, tracking_mode)
  values (:gJers, :org, 'Falcons Home Jersey', 'Falcons', '2026', 'home',
          'jerseys|falcons|2026|home', 'each', 'NUMBERED_VARIANT')
  on conflict (id) do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status,
   tracking_type, group_id, jersey_number, variant_size, unit_of_measure, variant_key)
values
  (:j12m,  :org, :wh, 'FALC-12-M',  'Falcons Home Jersey 12 - M',  3, 'active',
   'none', :gJers, '12', 'M',  'each', 'number=12|size=M'),
  (:j12xl, :org, :wh, 'FALC-12-XL', 'Falcons Home Jersey 12 - XL', 2, 'active',
   'none', :gJers, '12', 'XL', 'each', 'number=12|size=XL')
on conflict (id) do nothing;

select is(
  (select count(*)::int from public.inventory_items
    where group_id = :gJers and jersey_number = '12'),
  2,
  'R3: number 12 exists in TWO sizes — the number is not unique and never blocks');

select is(
  (select total_quantity from public.product_group_rollups where group_id = :gJers),
  5::numeric,
  'R3: M(3) + XL(2) totals 5');

select is(
  (select quantity_on_hand from public.inventory_items where id = :j12m),
  3::numeric(14,4),
  'R3: the per-size quantity is retained, not merged away');

select is(
  (select count(*)::int from public.serial_registry
    where serial_number = '12' and organization_id = :org),
  0,
  'R3: the jersey number never leaked into serial_registry — a number is not a serial');

-- ── 16-17. jersey_number normalization rules ────────────────────────────────
select lives_ok(
  $$ update public.inventory_items set jersey_number = '07'
     where id = '9e298000-0000-0000-0000-000000000009' $$,
  'a leading zero is preserved — ''07'' is a legal, distinct number');

select throws_ok(
  $$ update public.inventory_items set jersey_number = 'ABC'
     where id = '9e298000-0000-0000-0000-000000000009' $$,
  '23514',
  null,
  'a non-numeric jersey number is rejected (JERSEY_NUMBER_INVALID)');

-- ── 18. group_key uniqueness ────────────────────────────────────────────────
select throws_ok(
  $$ insert into public.product_groups (organization_id, name, group_key)
     values ('9e298000-0000-0000-0000-000000000001',
             'Duplicate Pegasus',
             'shoes|nike|pegasus 41|fd2722|black-white') $$,
  '23505',
  null,
  'two groups cannot share a group_key within one org');

-- ── 19. Model B uniqueness is UNTOUCHED ─────────────────────────────────────
select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'inventory_items_org_sku_charter_bin_unique'
  ),
  'the Model B (org, sku, charter, bin) uniqueness index survives — variants did not change it');

select * from finish();
rollback;
```

- [ ] Run `supabase db reset && pnpm db:test 2>&1 | grep -E "0298|Result:"`. All 19 must pass.
- [ ] **Regression (`inventory_items` is the most shared table in the app):** run the FULL pgTAP suite, not a filtered one. Ten new nullable columns plus three indexes must not disturb `0234` (SKU uniqueness per charter placement), `0292` (placed draw-down), `0244`/`0245` (backorder accounting) or `0289`-`0291` (reopen picking). Any failure means an index or constraint collided.
- [ ] **Regression (no backfill):** grep the migration for `update public.inventory_items` — there must be ZERO matches. The only writes are `alter table` and `create index`.

---

## Task 6: `duplicate_inventory_item` carries the variant columns (migration 0299)

A Model B copy path. The 0125 RPC uses an explicit 24-column INSERT list, so every column added since is silently dropped on duplicate — `model_number`, `is_rental`, `shelf_life_days` and eight others. Duplicating a shoe variant today would produce an item detached from its group. This fixes the sports columns and, while the function is being re-bodied, closes the pre-existing gaps that are unambiguously bugs.

**Files:**
- Create: `supabase/migrations/0299_duplicate_inventory_item_variants.sql`
- Create: `supabase/tests/0299_duplicate_inventory_item_variants.test.sql`
- Modify: `packages/core/src/schemas/duplicate-item.ts` (optional variant overrides)
- Modify: `apps/web/src/server/services/inventory.ts` (`duplicateItem` overrides map, ~1555-1573)

**Interfaces:**
- Consumes from Task 5: the new `inventory_items` columns.
- Produces for Task 11: a duplicate path that keeps a variant inside its group, with `variant_size` / `jersey_number` overridable so "duplicate this variant as the next size" works.

**Steps:**

- [ ] Create `supabase/migrations/0299_duplicate_inventory_item_variants.sql`:

```sql
-- 0299_duplicate_inventory_item_variants.sql
--
-- Re-bodies duplicate_inventory_item so a duplicated VARIANT stays inside its
-- product group.
--
-- The 0125 original uses an explicit 24-column INSERT list, so every column
-- added to inventory_items since then is silently dropped on duplicate. This
-- migration adds the Phase 3 variant columns AND closes the pre-existing gaps
-- that are plainly defects rather than intent:
--   * model_number   (0133) — a duplicated item losing its model number is a bug
--   * is_rental      (0131) — a duplicated rental asset must stay a rental
--   * shelf_life_days / expiry_policy (0162) — lot policy must survive a copy
--
-- Deliberately NOT copied (DB defaults are correct for a fresh row):
--   zero_since, auto_archived, archived_at, awaiting_first_receipt,
--   last_priced_at, created_from_purchase_order_id, public_* — a duplicate is
--   a NEW row with its own lifecycle and its own visibility decision.
--
-- group_id is copied straight from the original: duplicating a variant means
-- "another placement/variant of the same product", never a new group.
-- variant_size / jersey_number / variant_key are OVERRIDABLE via p_overrides
-- so "duplicate size 10 as size 11" works in one call.

create or replace function public.duplicate_inventory_item(
  p_original_id uuid,
  p_overrides   jsonb
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_new_id uuid := gen_random_uuid();
  v_original public.inventory_items%rowtype;
  v_qty numeric := coalesce((p_overrides->>'quantity')::numeric, 0);
  v_new_sku text := nullif(p_overrides->>'sku', '');
  v_new_bin text := nullif(p_overrides->>'bin_location', '');
  v_new_cf jsonb;
  v_uid uuid := auth.uid();
  v_variant_size text;
  v_variant_size_original text;
  v_variant_size_system text;
  v_variant_width text;
  v_variant_fit text;
  v_variant_color text;
  v_jersey_number text;
  v_player_name text;
  v_variant_key text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select * into v_original
  from public.inventory_items
  where id = p_original_id and deleted_at is null
  for share;

  if not found then
    raise exception 'original_not_found' using errcode = 'P0002';
  end if;
  if v_new_sku is null then
    raise exception 'sku_required' using errcode = '22023';
  end if;

  -- Variant attributes: an override wins, otherwise inherit the original.
  -- coalesce over `p_overrides ? 'key'` so an explicit JSON null CLEARS the
  -- field rather than silently inheriting it.
  v_variant_size := case when p_overrides ? 'variant_size'
    then nullif(p_overrides->>'variant_size', '') else v_original.variant_size end;
  v_variant_size_original := case when p_overrides ? 'variant_size_original'
    then nullif(p_overrides->>'variant_size_original', '')
    else v_original.variant_size_original end;
  v_variant_size_system := case when p_overrides ? 'variant_size_system'
    then nullif(p_overrides->>'variant_size_system', '')
    else v_original.variant_size_system end;
  v_variant_width := case when p_overrides ? 'variant_width'
    then nullif(p_overrides->>'variant_width', '') else v_original.variant_width end;
  v_variant_fit := case when p_overrides ? 'variant_fit'
    then nullif(p_overrides->>'variant_fit', '') else v_original.variant_fit end;
  v_variant_color := case when p_overrides ? 'variant_color'
    then nullif(p_overrides->>'variant_color', '') else v_original.variant_color end;
  v_jersey_number := case when p_overrides ? 'jersey_number'
    then nullif(p_overrides->>'jersey_number', '') else v_original.jersey_number end;
  v_player_name := case when p_overrides ? 'player_name'
    then nullif(p_overrides->>'player_name', '') else v_original.player_name end;
  v_variant_key := case when p_overrides ? 'variant_key'
    then nullif(p_overrides->>'variant_key', '') else v_original.variant_key end;

  v_new_cf := coalesce(v_original.custom_fields, '{}'::jsonb);
  if v_original.item_type = 'book' then
    v_new_cf := (v_new_cf
                 - 'book_rack_number'
                 - 'book_rack_row'
                 - 'book_crate_color'
                 - 'book_crate_number')
                || jsonb_strip_nulls(jsonb_build_object(
                     'book_rack_number',  p_overrides->>'book_rack_number',
                     'book_rack_row',     p_overrides->>'book_rack_row',
                     'book_crate_color',  p_overrides->>'book_crate_color',
                     'book_crate_number', p_overrides->>'book_crate_number'
                   ));
  else
    v_new_cf := (v_new_cf - 'rack_number' - 'rack_row')
                || jsonb_strip_nulls(jsonb_build_object(
                     'rack_number', p_overrides->>'rack_number',
                     'rack_row',    p_overrides->>'rack_row'
                   ));
  end if;

  -- Keep custom_fields.size in step with the first-class column during the
  -- dual-write window (see migration 0303).
  if v_variant_size is not null then
    v_new_cf := v_new_cf || jsonb_build_object('size', v_variant_size);
  end if;

  insert into public.inventory_items (
    id, organization_id, warehouse_id, charter_id, sku, barcode,
    name, description, category_id, supplier_id, primary_location_id,
    unit_cost, retail_price, quantity_on_hand, reorder_point,
    reorder_quantity, unit_of_measure, bin_location, tracking_type,
    item_type, custom_fields, status, created_by, updated_by,
    -- Pre-existing gaps closed by this migration:
    model_number, is_rental, shelf_life_days, expiry_policy,
    -- Phase 3 variant columns:
    group_id, variant_size, variant_size_original, variant_size_system,
    variant_width, variant_fit, variant_color, jersey_number, player_name,
    variant_key
  ) values (
    v_new_id, v_original.organization_id, v_original.warehouse_id,
    v_original.charter_id, v_new_sku, v_original.barcode,
    v_original.name, v_original.description, v_original.category_id,
    v_original.supplier_id, v_original.primary_location_id,
    v_original.unit_cost, v_original.retail_price, v_qty,
    v_original.reorder_point, v_original.reorder_quantity,
    v_original.unit_of_measure, v_new_bin, v_original.tracking_type,
    v_original.item_type, v_new_cf, v_original.status, v_uid, v_uid,
    v_original.model_number, v_original.is_rental,
    v_original.shelf_life_days, v_original.expiry_policy,
    v_original.group_id, v_variant_size, v_variant_size_original,
    v_variant_size_system, v_variant_width, v_variant_fit, v_variant_color,
    v_jersey_number, v_player_name, v_variant_key
  );

  insert into public.item_tags (item_id, tag_id)
  select v_new_id, tag_id
  from public.item_tags
  where item_id = p_original_id;

  insert into public.item_images (
    organization_id, item_id, storage_path, thumb_path, lqip,
    alt, sort_order, is_primary
  )
  select v_original.organization_id, v_new_id, storage_path, thumb_path,
         lqip, alt, sort_order, is_primary
  from public.item_images
  where item_id = p_original_id;

  if v_qty > 0 then
    insert into public.stock_movements (
      organization_id, item_id, movement_type, quantity_change,
      previous_quantity, new_quantity, user_id, to_location_id, reason,
      reference_type, reference_id
    ) values (
      v_original.organization_id, v_new_id, 'initial', v_qty,
      0, v_qty, v_uid, v_original.primary_location_id,
      'duplicate_initial_count',
      'duplicate', p_original_id
    );
  end if;

  return v_new_id;
end;
$$;

revoke all on function public.duplicate_inventory_item(uuid, jsonb) from public;
revoke all on function public.duplicate_inventory_item(uuid, jsonb) from anon;
grant execute on function public.duplicate_inventory_item(uuid, jsonb) to authenticated;
```

- [ ] Create `supabase/tests/0299_duplicate_inventory_item_variants.test.sql`. Namespace `d0299000`.

```sql
-- supabase/tests/0299_duplicate_inventory_item_variants.test.sql
--
-- Proves 0299: a duplicated variant stays in its group, variant attributes
-- are overridable, the previously-dropped columns now survive, and every
-- 0125 behaviour is intact.
--
-- Namespace: d0299000. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(14);

\set org  '\'d0299000-0000-0000-0000-000000000001\''
\set usr  '\'d0299000-0000-0000-0000-000000000002\''
\set wh   '\'d0299000-0000-0000-0000-000000000003\''
\set grp  '\'d0299000-0000-0000-0000-000000000004\''
\set src  '\'d0299000-0000-0000-0000-000000000005\''

insert into auth.users (id, email) values (:usr, 'u-0299@example.test')
  on conflict (id) do nothing;
insert into public.organizations (id, name) values (:org, 'Dup 0299 Org')
  on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :usr, 'manager', now()) on conflict do nothing;
insert into public.warehouses (id, organization_id, name)
  values (:wh, :org, 'WH 0299') on conflict (id) do nothing;

insert into public.product_groups (id, organization_id, name, group_key, default_counting_unit)
  values (:grp, :org, 'Pegasus 41', 'shoes|nike|pegasus 41', 'pair')
  on conflict (id) do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status,
   tracking_type, group_id, variant_size, variant_size_original, variant_size_system,
   variant_key, model_number, is_rental, unit_of_measure)
  values (:src, :org, :wh, 'PEG41-10', 'Nike Pegasus 41 - 10', 6, 'active',
          'none', :grp, '10', 'US 10', 'US_MENS', 'size=10|system=US_MENS',
          'FD2722-001', false, 'pair')
  on conflict (id) do nothing;

select ok(
  has_function_privilege('authenticated',
    'public.duplicate_inventory_item(uuid, jsonb)', 'EXECUTE'),
  'authenticated can still EXECUTE duplicate_inventory_item (grant survives the re-body)');

set local "request.jwt.claim.sub" to 'd0299000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ── Duplicate INHERITING every variant attribute ────────────────────────────
create temporary table dup_ids (which text, id uuid) on commit drop;

do $$
declare v_id uuid;
begin
  v_id := public.duplicate_inventory_item(
    'd0299000-0000-0000-0000-000000000005'::uuid,
    jsonb_build_object('sku', 'PEG41-10-B', 'quantity', 2));
  insert into dup_ids values ('inherit', v_id);
end$$;

select is(
  (select group_id from public.inventory_items
    where id = (select id from dup_ids where which = 'inherit')),
  'd0299000-0000-0000-0000-000000000004'::uuid,
  'a duplicated variant stays inside the SAME product group');

select is(
  (select variant_size from public.inventory_items
    where id = (select id from dup_ids where which = 'inherit')),
  '10',
  'variant_size is inherited when not overridden');

select is(
  (select variant_size_original from public.inventory_items
    where id = (select id from dup_ids where which = 'inherit')),
  'US 10',
  'the ORIGINAL imported size text is carried through the copy');

select is(
  (select variant_key from public.inventory_items
    where id = (select id from dup_ids where which = 'inherit')),
  'size=10|system=US_MENS',
  'variant_key is inherited when not overridden');

-- ── Pre-existing gaps now closed ────────────────────────────────────────────
select is(
  (select model_number from public.inventory_items
    where id = (select id from dup_ids where which = 'inherit')),
  'FD2722-001',
  'model_number now survives a duplicate (0125 dropped it — pre-existing bug, closed)');

select is(
  (select is_rental from public.inventory_items
    where id = (select id from dup_ids where which = 'inherit')),
  false,
  'is_rental now survives a duplicate');

-- ── Duplicate OVERRIDING the size (the "add the next size" flow) ────────────
do $$
declare v_id uuid;
begin
  v_id := public.duplicate_inventory_item(
    'd0299000-0000-0000-0000-000000000005'::uuid,
    jsonb_build_object(
      'sku', 'PEG41-11',
      'quantity', 3,
      'variant_size', '11',
      'variant_size_original', 'US 11',
      'variant_key', 'size=11|system=US_MENS'));
  insert into dup_ids values ('override', v_id);
end$$;

select is(
  (select variant_size from public.inventory_items
    where id = (select id from dup_ids where which = 'override')),
  '11',
  'variant_size can be overridden — duplicating size 10 as size 11');

select is(
  (select group_id from public.inventory_items
    where id = (select id from dup_ids where which = 'override')),
  'd0299000-0000-0000-0000-000000000004'::uuid,
  'overriding the size does NOT spawn a new group');

select is(
  (select variant_count::int from public.product_group_rollups
    where group_id = 'd0299000-0000-0000-0000-000000000004'::uuid),
  3,
  'the group now rolls up 3 distinct variants (10, 10-copy shares key, 11)');

-- ── 0125 behaviours intact ──────────────────────────────────────────────────
select is(
  (select quantity_on_hand from public.inventory_items
    where id = (select id from dup_ids where which = 'override')),
  3::numeric(14,4),
  'the override quantity is applied to the new row');

select is(
  (select count(*)::int from public.stock_movements
    where item_id = (select id from dup_ids where which = 'override')
      and movement_type = 'initial'
      and reference_type = 'duplicate'),
  1,
  'LEDGER INVARIANT: the duplicate wrote its initial stock_movement');

select throws_ok(
  $$ select public.duplicate_inventory_item(
       'd0299000-0000-0000-0000-000000000005'::uuid,
       jsonb_build_object('quantity', 1)) $$,
  '22023',
  'sku_required',
  'a duplicate with no SKU is still rejected (0125 behaviour intact)');

select throws_ok(
  $$ select public.duplicate_inventory_item(
       'd0299000-0000-0000-0000-0000000000ff'::uuid,
       jsonb_build_object('sku', 'X-1', 'quantity', 1)) $$,
  'P0002',
  'original_not_found',
  'duplicating a non-existent item is still rejected (0125 behaviour intact)');

select * from finish();
rollback;
```

- [ ] Extend `packages/core/src/schemas/duplicate-item.ts` with optional variant overrides on both arms of the discriminated union:

```ts
/**
 * Optional variant overrides. Present-but-null CLEARS the field; absent
 * inherits from the original (matching the `p_overrides ? 'key'` test in the
 * 0299 RPC). Never required — a plain duplicate passes none of these.
 */
const variantOverrides = {
  variantSize: z.string().max(24).nullable().optional(),
  variantSizeOriginal: z.string().max(64).nullable().optional(),
  variantSizeSystem: z.string().max(32).nullable().optional(),
  variantWidth: z.string().max(16).nullable().optional(),
  variantFit: z.string().max(32).nullable().optional(),
  variantColor: z.string().max(64).nullable().optional(),
  jerseyNumber: z
    .string()
    .regex(/^[0-9]{1,4}$/, 'A jersey number is 1-4 digits.')
    .nullable()
    .optional(),
  playerName: z.string().max(120).nullable().optional(),
  variantKey: z.string().max(240).nullable().optional(),
};
```

- [ ] Thread those into the `overrides` record built in `InventoryService.duplicateItem` (`apps/web/src/server/services/inventory.ts`, ~1555-1573). Only set a key when the caller supplied it, so absent stays absent:

```ts
    if ('variantSize' in input) overrides.variant_size = input.variantSize;
    if ('variantSizeOriginal' in input) overrides.variant_size_original = input.variantSizeOriginal;
    if ('variantSizeSystem' in input) overrides.variant_size_system = input.variantSizeSystem;
    if ('variantWidth' in input) overrides.variant_width = input.variantWidth;
    if ('variantFit' in input) overrides.variant_fit = input.variantFit;
    if ('variantColor' in input) overrides.variant_color = input.variantColor;
    if ('jerseyNumber' in input) overrides.jersey_number = input.jerseyNumber;
    if ('playerName' in input) overrides.player_name = input.playerName;
    if ('variantKey' in input) overrides.variant_key = input.variantKey;
```

- [ ] Run `supabase db reset && pnpm db:test 2>&1 | grep -E "0299|Result:"`, then `pnpm typecheck` and `pnpm test`.
- [ ] **Regression (duplicate is a shared surface):** hand-verify in Demo Co that duplicating a plain, ungrouped book and a plain product still works and now retains `model_number`. Confirm the duplicate modal's existing rack/crate override behaviour is unchanged.

---

## Task 7: Variant key builders and the shared zod contract

The normalizers are pure and live in `packages/core` so web, Expo and the server produce byte-identical keys. If these ever diverge, matching silently fragments a group.

**Files:**
- Create: `packages/core/src/sports/variant-keys.ts`
- Create: `packages/core/src/sports/variant-keys.test.ts`
- Create: `packages/core/src/schemas/sports.ts`
- Modify: `packages/core/src/schemas/inventory.ts`
- Modify: `packages/core/src/schemas/index.ts`, `packages/core/src/index.ts`

**Interfaces:**
- Consumes from Task 1: `TrackingMode`, `CountingUnit`, `SportsSubcategoryKey`.
- Produces for Tasks 8-19: `normalizeJerseyNumber`, `normalizeSizeValue`, `buildGroupKey`, `buildVariantKey`, `productGroupSchema`, `CreateProductGroupInput`, and `createItemSchema` extended with `groupId` + the variant fields.

**Steps:**

- [ ] Create `packages/core/src/sports/variant-keys.ts`:

```ts
/**
 * Deterministic group + variant identity. Pure, no platform imports.
 *
 * These functions are the ONLY place identity keys are built. Web, Expo and
 * the server all call them, so a shoe added on a phone and the same shoe
 * arriving on a PO resolve to the same group_key. Requirements: "Matching
 * deterministic (keys above), never name-string-only."
 */

import type { SportsSubcategoryKey } from './tracking-modes';

/** Lower-case, collapse internal whitespace, trim. Never used for display. */
function norm(v: string | null | undefined): string {
  if (v == null) return '';
  return v.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Normalize a jersey/uniform number.
 *
 * Leading zeroes are MEANINGFUL and preserved: 0, 00, 07 and 7 are four
 * distinct numbers, and a player wearing 00 is not the same as one wearing 0.
 * This is why the value is TEXT and never an integer anywhere in the stack.
 *
 * Returns null for blank input. Throws nothing — validation lives in zod so
 * the caller controls the error surface.
 */
export function normalizeJerseyNumber(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  // Strip a leading '#' and surrounding whitespace, which is how these arrive
  // from spreadsheets ("#12", " 07 ").
  const trimmed = raw.trim().replace(/^#+/, '').trim();
  if (trimmed.length === 0) return null;
  return trimmed;
}

/** True when the value is a legal jersey number: 1-4 digits, digits only. */
export function isValidJerseyNumber(v: string): boolean {
  return /^[0-9]{1,4}$/.test(v);
}

/**
 * Normalize a size for MATCHING. The caller must keep the original string
 * separately (inventory_items.variant_size_original) — requirements: "Keep
 * original imported text + normalized form".
 *
 * Rules, deliberately conservative:
 *   * Alpha sizes upper-case: ' xl ' -> 'XL'
 *   * Numeric sizes lose a trailing '.0' but KEEP halves: '10.0' -> '10',
 *     '10.5' -> '10.5'
 *   * A leading size-system word is stripped ONLY when it is redundant with
 *     the sizeSystem argument: normalizeSizeValue('US 10', 'US_MENS') -> '10'
 *
 * NEVER converts between systems. A UK 9 is not silently turned into a US 10;
 * that requires an approved mapping which does not exist yet.
 */
export function normalizeSizeValue(
  raw: string | null | undefined,
  sizeSystem?: string | null,
): string | null {
  if (raw == null) return null;
  let s = raw.trim();
  if (s.length === 0) return null;

  // Strip a redundant system prefix ('US 10' under US_MENS -> '10').
  if (sizeSystem) {
    const prefix = sizeSystem.split('_')[0]?.toLowerCase();
    if (prefix) {
      const re = new RegExp(`^${prefix}\\s+`, 'i');
      s = s.replace(re, '').trim();
    }
  }

  // Numeric size: strip a trailing '.0' but never round a half away.
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return Number.isInteger(n) ? String(n) : String(n);
  }

  return s.toUpperCase();
}

/** Attributes that identify a GROUP. Every field is optional; the key is the join. */
export interface GroupKeyParts {
  subcategoryKey: SportsSubcategoryKey | string;
  brand?: string | null;
  model?: string | null;
  styleNumber?: string | null;
  colorway?: string | null;
  team?: string | null;
  league?: string | null;
  season?: string | null;
  homeAway?: string | null;
  manufacturer?: string | null;
  color?: string | null;
  /** Fallback identity when nothing else is supplied. */
  name?: string | null;
}

/**
 * Build the group identity key.
 *
 * Shoes:   (subcat, brand, model, style_number, colorway)
 * Jerseys: (subcat, team, league, season, home_away, manufacturer, style, color)
 *
 * The subcategory decides which slots participate, so a shoe key and a jersey
 * key can never collide. `name` is the LAST-RESORT slot and only participates
 * when every identifying attribute is blank — that is what stops this from
 * being name-string-only matching.
 */
export function buildGroupKey(parts: GroupKeyParts): string {
  const sub = norm(parts.subcategoryKey);
  const slots: string[] =
    sub === 'jerseys' || sub === 'uniforms'
      ? [
          norm(parts.team),
          norm(parts.league),
          norm(parts.season),
          norm(parts.homeAway),
          norm(parts.manufacturer ?? parts.brand),
          norm(parts.styleNumber),
          norm(parts.color),
        ]
      : [
          norm(parts.brand),
          norm(parts.model),
          norm(parts.styleNumber),
          norm(parts.colorway),
        ];

  const identifying = slots.filter((s) => s.length > 0);
  if (identifying.length === 0) {
    // Nothing identifying at all — fall back to the name so a group can still
    // be created, but mark it so the import review can flag it as weak.
    return `${sub}|name:${norm(parts.name)}`;
  }
  return [sub, ...slots].join('|');
}

/** Attributes that identify a VARIANT within its group. */
export interface VariantKeyParts {
  size?: string | null;
  sizeSystem?: string | null;
  width?: string | null;
  fit?: string | null;
  color?: string | null;
  jerseyNumber?: string | null;
  /** Only participates when the org groups jerseys by player (see open questions). */
  playerName?: string | null;
}

/**
 * Build the variant identity key. Slots are NAMED so an absent width and an
 * absent fit cannot shift a value into the wrong position.
 */
export function buildVariantKey(parts: VariantKeyParts): string {
  const pairs: Array<[string, string]> = [];
  const push = (k: string, v: string | null | undefined) => {
    const n = norm(v);
    if (n.length > 0) pairs.push([k, n]);
  };
  // jersey_number FIRST so a numbered variant sorts and reads naturally.
  push('number', parts.jerseyNumber);
  push('player', parts.playerName);
  push('size', parts.size);
  push('system', parts.sizeSystem);
  push('width', parts.width);
  push('fit', parts.fit);
  push('color', parts.color);
  if (pairs.length === 0) return 'default';
  return pairs.map(([k, v]) => `${k}=${v}`).join('|');
}

/** Human roll-up label: "6 variants · 52 pairs total". */
export function groupRollupLabel(
  variantCount: number,
  totalQuantity: number,
  countingUnitPlural: string,
): string {
  const v = `${variantCount} ${variantCount === 1 ? 'variant' : 'variants'}`;
  return `${v} · ${totalQuantity} ${countingUnitPlural} total`;
}
```

- [ ] Create `packages/core/src/sports/variant-keys.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  buildGroupKey,
  buildVariantKey,
  groupRollupLabel,
  isValidJerseyNumber,
  normalizeJerseyNumber,
  normalizeSizeValue,
} from './variant-keys';

describe('normalizeJerseyNumber', () => {
  it('preserves meaningful leading zeroes', () => {
    expect(normalizeJerseyNumber('0')).toBe('0');
    expect(normalizeJerseyNumber('00')).toBe('00');
    expect(normalizeJerseyNumber('07')).toBe('07');
    expect(normalizeJerseyNumber('7')).toBe('7');
  });

  it('treats 0, 00, 07 and 7 as four distinct numbers', () => {
    const all = ['0', '00', '07', '7'].map((v) => normalizeJerseyNumber(v));
    expect(new Set(all).size).toBe(4);
  });

  it('strips a leading hash and surrounding whitespace', () => {
    expect(normalizeJerseyNumber(' #12 ')).toBe('12');
    expect(normalizeJerseyNumber('##00')).toBe('00');
  });

  it('returns null for blank input rather than inventing a value', () => {
    expect(normalizeJerseyNumber('')).toBeNull();
    expect(normalizeJerseyNumber('   ')).toBeNull();
    expect(normalizeJerseyNumber(null)).toBeNull();
    expect(normalizeJerseyNumber(undefined)).toBeNull();
  });
});

describe('isValidJerseyNumber', () => {
  it('accepts 1 to 4 digits', () => {
    for (const v of ['0', '00', '07', '12', '99', '0000']) {
      expect(isValidJerseyNumber(v)).toBe(true);
    }
  });

  it('rejects non-digits and over-long values', () => {
    for (const v of ['A', '12A', '#12', '', '12345', '1.5', '-1']) {
      expect(isValidJerseyNumber(v)).toBe(false);
    }
  });
});

describe('normalizeSizeValue', () => {
  it('upper-cases alpha sizes', () => {
    expect(normalizeSizeValue(' xl ')).toBe('XL');
    expect(normalizeSizeValue('m')).toBe('M');
  });

  it('keeps half sizes and drops a redundant .0', () => {
    expect(normalizeSizeValue('10.5')).toBe('10.5');
    expect(normalizeSizeValue('10.0')).toBe('10');
    expect(normalizeSizeValue('10')).toBe('10');
  });

  it('strips a redundant system prefix but only the matching one', () => {
    expect(normalizeSizeValue('US 10', 'US_MENS')).toBe('10');
    expect(normalizeSizeValue('UK 9', 'US_MENS')).toBe('UK 9');
  });

  it('NEVER converts between size systems', () => {
    // A UK 9 stays a UK 9. Cross-system conversion needs an approved mapping
    // that does not exist; silently converting would corrupt stock counts.
    expect(normalizeSizeValue('9', 'UK')).toBe('9');
    expect(normalizeSizeValue('9', 'US_MENS')).toBe('9');
  });

  it('returns null for blank rather than a placeholder', () => {
    expect(normalizeSizeValue('')).toBeNull();
    expect(normalizeSizeValue(null)).toBeNull();
  });
});

describe('buildGroupKey', () => {
  it('collapses sizes of one shoe style onto ONE key', () => {
    const base = {
      subcategoryKey: 'shoes',
      brand: 'Nike',
      model: 'Pegasus 41',
      styleNumber: 'FD2722',
      colorway: 'Black/White',
    };
    // Size is NOT part of the group key — that is the whole point.
    expect(buildGroupKey(base)).toBe(buildGroupKey({ ...base }));
    expect(buildGroupKey(base)).toBe('shoes|nike|pegasus 41|fd2722|black/white');
  });

  it('is case and whitespace insensitive', () => {
    expect(
      buildGroupKey({ subcategoryKey: 'shoes', brand: '  NIKE ', model: 'Pegasus  41' }),
    ).toBe(buildGroupKey({ subcategoryKey: 'shoes', brand: 'nike', model: 'pegasus 41' }));
  });

  it('separates a shoe key from a jersey key even with identical text', () => {
    expect(buildGroupKey({ subcategoryKey: 'shoes', brand: 'Falcons' })).not.toBe(
      buildGroupKey({ subcategoryKey: 'jerseys', team: 'Falcons' }),
    );
  });

  it('uses the jersey slots for jerseys', () => {
    expect(
      buildGroupKey({
        subcategoryKey: 'jerseys',
        team: 'Falcons',
        season: '2026',
        homeAway: 'home',
      }),
    ).toBe('jerseys|falcons||2026|home||||');
  });

  it('falls back to the name ONLY when nothing identifying is present', () => {
    expect(buildGroupKey({ subcategoryKey: 'balls', name: 'Practice Ball' })).toBe(
      'balls|name:practice ball',
    );
  });
});

describe('buildVariantKey', () => {
  it('distinguishes shoe sizes within one group', () => {
    const k9 = buildVariantKey({ size: '9', sizeSystem: 'US_MENS' });
    const k10 = buildVariantKey({ size: '10', sizeSystem: 'US_MENS' });
    expect(k9).not.toBe(k10);
    expect(k9).toBe('size=9|system=us_mens');
  });

  it('distinguishes jersey sizes sharing ONE number (R3)', () => {
    const m = buildVariantKey({ jerseyNumber: '12', size: 'M' });
    const xl = buildVariantKey({ jerseyNumber: '12', size: 'XL' });
    expect(m).not.toBe(xl);
    expect(m).toBe('number=12|size=m');
  });

  it('distinguishes numbers that differ only by a leading zero', () => {
    expect(buildVariantKey({ jerseyNumber: '07', size: 'M' })).not.toBe(
      buildVariantKey({ jerseyNumber: '7', size: 'M' }),
    );
  });

  it('uses named slots so an absent width cannot shift the fit', () => {
    expect(buildVariantKey({ size: '10', fit: 'wide' })).toBe('size=10|fit=wide');
    expect(buildVariantKey({ size: '10', width: 'wide' })).toBe('size=10|width=wide');
  });

  it('returns a stable sentinel when there are no variant attributes', () => {
    expect(buildVariantKey({})).toBe('default');
  });
});

describe('groupRollupLabel', () => {
  it('renders the counting unit as the requirements phrase it', () => {
    expect(groupRollupLabel(6, 52, 'pairs')).toBe('6 variants · 52 pairs total');
    expect(groupRollupLabel(1, 3, 'each')).toBe('1 variant · 3 each total');
  });
});
```

- [ ] Create `packages/core/src/schemas/sports.ts`:

```ts
import { z } from 'zod';

import { COUNTING_UNITS, TRACKING_MODES } from '../sports/tracking-modes';
import { uuidSchema } from './common';

const emptyToUndefined = (v: unknown) =>
  typeof v === 'string' && v.trim().length === 0 ? undefined : v;

/** 1-4 digits, digits only, leading zeroes preserved. Never an integer. */
export const jerseyNumberSchema = z.preprocess(
  (v) => {
    if (typeof v !== 'string') return v;
    const t = v.trim().replace(/^#+/, '').trim();
    return t.length === 0 ? undefined : t;
  },
  z
    .string()
    .regex(/^[0-9]{1,4}$/, 'A jersey number is 1 to 4 digits, and leading zeroes are kept.')
    .nullable()
    .optional(),
);

export const sizeSystemSchema = z.preprocess(
  emptyToUndefined,
  z
    .enum(['US_MENS', 'US_WOMENS', 'US_YOUTH', 'UK', 'EU', 'CM', 'ALPHA', 'CUSTOM'])
    .nullable()
    .optional(),
);

export const countingUnitSchema = z.enum(COUNTING_UNITS);
export const trackingModeSchema = z.enum(TRACKING_MODES);

/** The variant attributes an item may carry. Every one is optional. */
export const variantAttributesSchema = z.object({
  groupId: uuidSchema.nullable().optional(),
  variantSize: z.preprocess(emptyToUndefined, z.string().max(24).nullable().optional()),
  variantSizeOriginal: z.preprocess(emptyToUndefined, z.string().max(64).nullable().optional()),
  variantSizeSystem: sizeSystemSchema,
  variantWidth: z.preprocess(emptyToUndefined, z.string().max(16).nullable().optional()),
  variantFit: z.preprocess(emptyToUndefined, z.string().max(32).nullable().optional()),
  variantColor: z.preprocess(emptyToUndefined, z.string().max(64).nullable().optional()),
  jerseyNumber: jerseyNumberSchema,
  playerName: z.preprocess(emptyToUndefined, z.string().max(120).nullable().optional()),
  variantKey: z.preprocess(emptyToUndefined, z.string().max(240).nullable().optional()),
});
export type VariantAttributes = z.infer<typeof variantAttributesSchema>;

export const createProductGroupSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  categoryId: uuidSchema.nullable().optional(),
  subcategoryKey: z.preprocess(emptyToUndefined, z.string().max(64).nullable().optional()),
  brand: z.preprocess(emptyToUndefined, z.string().max(120).nullable().optional()),
  manufacturer: z.preprocess(emptyToUndefined, z.string().max(120).nullable().optional()),
  model: z.preprocess(emptyToUndefined, z.string().max(120).nullable().optional()),
  styleNumber: z.preprocess(emptyToUndefined, z.string().max(64).nullable().optional()),
  colorway: z.preprocess(emptyToUndefined, z.string().max(64).nullable().optional()),
  team: z.preprocess(emptyToUndefined, z.string().max(120).nullable().optional()),
  league: z.preprocess(emptyToUndefined, z.string().max(120).nullable().optional()),
  season: z.preprocess(emptyToUndefined, z.string().max(32).nullable().optional()),
  homeAway: z.enum(['home', 'away', 'alternate']).nullable().optional(),
  color: z.preprocess(emptyToUndefined, z.string().max(64).nullable().optional()),
  sizeScaleId: uuidSchema.nullable().optional(),
  defaultCountingUnit: countingUnitSchema.default('each'),
  trackingMode: trackingModeSchema.nullable().optional(),
});
export type CreateProductGroupInput = z.infer<typeof createProductGroupSchema>;

export const updateProductGroupSchema = createProductGroupSchema.partial();
export type UpdateProductGroupInput = z.infer<typeof updateProductGroupSchema>;
```

- [ ] Extend `createItemSchema` in `packages/core/src/schemas/inventory.ts`. Merge the variant attributes in and add the sports-context fields the server needs to resolve a profile. This is the shared contract mobile will adopt in Task 10:

```ts
import { variantAttributesSchema } from './sports';

// ... existing createItemSchema object ...
export const createItemSchema = z
  .object({
    /* ...every existing field, unchanged... */
  })
  .merge(variantAttributesSchema)
  .extend({
    /**
     * Sports only. When the chosen category resolves to a variant-shaped
     * tracking mode, the server may CREATE the group from these attributes if
     * `groupId` is absent. Never trusted for authorization — the org always
     * comes from the service context.
     */
    productGroup: createProductGroupSchema.optional(),
    /**
     * An authorized override of the category's default tracking mode. The
     * SERVER checks it against the subcategory profile's allowedModes and
     * against the `sports:manage` permission; the form is never trusted.
     */
    trackingModeOverride: trackingModeSchema.optional(),
  });
```

- [ ] Add `export * from './sports';` to `packages/core/src/schemas/index.ts`, and `export * from './sports/variant-keys';` to `packages/core/src/index.ts`.
- [ ] Run `pnpm --filter @stockpilot/core test` and `pnpm typecheck`.
- [ ] **Regression (`createItemSchema` is a shared surface):** every new field is `.optional()`, so an existing `CreateItemInput` construction site must still typecheck untouched. Prove it by running `pnpm typecheck` with NO edits to the eight existing callers (`books-bulk-import.ts`, `import.ts`, `sage50-import.ts`, `books-import.ts`, `intacct-import.ts`, `po-imports-lines.ts`, `restore-points.ts`, `item-form.tsx`). If any of them now errors, a field was made required by mistake.
- [ ] **Regression:** add an explicit test asserting the empty-object default path still works:

```ts
it('still parses a pre-sports payload with no variant fields', () => {
  const parsed = createItemSchema.parse({ name: 'Plain Widget' });
  expect(parsed.groupId).toBeUndefined();
  expect(parsed.jerseyNumber).toBeUndefined();
  expect(parsed.trackingType).toBe('none');
});
```

---

## Task 8: `ProductGroupsService`, profile resolution, and item-create threading

Server-side enforcement. The relaxed serial rule is decided HERE, from the category, never from the form.

**Files:**
- Create: `apps/web/src/server/services/product-groups.ts`
- Create: `apps/web/src/server/services/product-groups.test.ts`
- Create: `apps/web/src/server/services/sports-profiles.ts`
- Create: `apps/web/src/server/services/sports-profiles.test.ts`
- Modify: `apps/web/src/server/services/inventory.ts` (`create`, `bulkCreateSizedVariants`)
- Modify: `apps/web/src/server/services/audit.ts` (new events)
- Modify: `apps/web/src/server/loaders/inventory-list.ts` (`ITEM_SELECT_COLUMNS` + row type)

**Interfaces:**
- Consumes from Tasks 1, 5, 7: profiles, tables, key builders, zod.
- Produces for Tasks 9-19:
  - `class ProductGroupsService { static forCurrentUser(); list(filters); get(id); findByKey(groupKey: string): Promise<ProductGroupRow | null>; findOrCreate(input: CreateProductGroupInput & { subcategoryKey: string }): Promise<{ group: ProductGroupRow; created: boolean }>; update(id, patch); rollups(groupIds: string[]): Promise<Map<string, GroupRollup>>; variants(groupId: string): Promise<VariantRow[]>; candidates(parts: GroupKeyParts): Promise<ProductGroupRow[]>; }`
  - `resolveTrackingProfile(ctx, categoryId: string | null): Promise<ResolvedTrackingProfile>`
  - `assertVariantAttributesValid(profile, input): void`
  - `interface GroupRollup { variantCount: number; totalQuantity: number; countingUnit: CountingUnit }`

**Steps:**

- [ ] Create `apps/web/src/server/services/sports-profiles.ts`. This is the server-side authority for the sports-only serial exception:

```ts
import {
  DEFAULT_SUBCATEGORY_PROFILES,
  type SportsSubcategoryKey,
  type SubcategoryTrackingProfile,
  type TrackingMode,
  type TrackingTypeValue,
  trackingTypeForMode,
} from '@stockpilot/core';

import { ServiceError, type ServiceContext } from './context';

export interface ResolvedTrackingProfile {
  categoryId: string | null;
  /** The mode after category + parent inheritance. */
  mode: TrackingMode;
  /** What an item created here is stamped with. */
  trackingType: TrackingTypeValue;
  countingUnit: string;
  sizeScaleId: string | null;
  subcategoryKey: string | null;
  /** Null when the category is not a Sports subcategory. */
  profile: SubcategoryTrackingProfile | null;
  /** True when the parent category is the org's Sports root. */
  isSports: boolean;
}

/**
 * Resolve the tracking profile for a category.
 *
 * SERVER-SIDE ONLY, and never trusts a client-supplied mode. The relaxed
 * serial rules apply ONLY when: the category is a Sports subcategory AND the
 * subcategory profile permits a non-serialized mode. Every other category
 * resolves to QUANTITY / 'none', which is exactly today's behaviour — this is
 * what keeps Electronics serial-required where it is today.
 */
export async function resolveTrackingProfile(
  ctx: ServiceContext,
  categoryId: string | null,
): Promise<ResolvedTrackingProfile> {
  if (!categoryId) {
    return {
      categoryId: null,
      mode: 'QUANTITY',
      trackingType: 'none',
      countingUnit: 'unit',
      sizeScaleId: null,
      subcategoryKey: null,
      profile: null,
      isSports: false,
    };
  }

  const { data, error } = await ctx.supabase
    .from('categories')
    .select(
      'id, parent_id, tracking_mode, size_scale_id, default_unit_of_measure, sports_subcategory_key, tracking_profile',
    )
    .eq('id', categoryId)
    .eq('organization_id', ctx.organizationId)
    .is('deleted_at', null)
    .maybeSingle();
  // Fail CLOSED. A read error must never silently downgrade a serialized
  // category to a relaxed one.
  if (error) throw new ServiceError('internal_error', error.message);
  if (!data) throw new ServiceError('not_found', 'Category not found.');

  // One level of inheritance, matching public.category_tracking_mode.
  let parent: {
    tracking_mode: string | null;
    default_unit_of_measure: string | null;
    size_scale_id: string | null;
  } | null = null;
  if (data.parent_id) {
    const { data: p, error: pErr } = await ctx.supabase
      .from('categories')
      .select('tracking_mode, default_unit_of_measure, size_scale_id')
      .eq('id', data.parent_id)
      .eq('organization_id', ctx.organizationId)
      .is('deleted_at', null)
      .maybeSingle();
    if (pErr) throw new ServiceError('internal_error', pErr.message);
    parent = p ?? null;
  }

  const subcategoryKey = (data.sports_subcategory_key as string | null) ?? null;
  const builtIn = subcategoryKey
    ? DEFAULT_SUBCATEGORY_PROFILES[subcategoryKey as SportsSubcategoryKey]
    : undefined;
  // A CUSTOM subcategory must carry a full profile in the jsonb column
  // (requirements). If it carries neither, it is not a sports subcategory.
  const custom = (data.tracking_profile as SubcategoryTrackingProfile | null) ?? null;
  const profile = builtIn ?? custom ?? null;

  const mode = ((data.tracking_mode as string | null) ??
    parent?.tracking_mode ??
    profile?.defaultMode ??
    'QUANTITY') as TrackingMode;

  return {
    categoryId,
    mode,
    trackingType: trackingTypeForMode(mode),
    countingUnit:
      (data.default_unit_of_measure as string | null) ??
      parent?.default_unit_of_measure ??
      profile?.defaultCountingUnit ??
      'unit',
    sizeScaleId: (data.size_scale_id as string | null) ?? parent?.size_scale_id ?? null,
    subcategoryKey,
    profile,
    isSports: profile != null,
  };
}

/**
 * Apply an authorized mode override. Refuses anything the subcategory profile
 * does not allow, and anything at all without `sports:manage`.
 */
export function resolveModeOverride(
  ctx: ServiceContext,
  resolved: ResolvedTrackingProfile,
  requested: TrackingMode | undefined,
): ResolvedTrackingProfile {
  if (!requested || requested === resolved.mode) return resolved;
  if (!resolved.profile) {
    throw new ServiceError(
      'validation_error',
      'Tracking mode can only be overridden on a Sports subcategory.',
      { code: 'TRACKING_MODE_NOT_ALLOWED' },
    );
  }
  if (!resolved.profile.allowedModes.includes(requested)) {
    throw new ServiceError(
      'validation_error',
      `This subcategory does not allow the ${requested} tracking mode.`,
      { code: 'TRACKING_MODE_NOT_ALLOWED' },
    );
  }
  if (requested === 'INDIVIDUALLY_TAGGED' && !resolved.profile.individualTrackingAllowed) {
    throw new ServiceError(
      'validation_error',
      'This subcategory cannot be escalated to individual tracking.',
      { code: 'TRACKING_MODE_NOT_ALLOWED' },
    );
  }
  return { ...resolved, mode: requested, trackingType: trackingTypeForMode(requested) };
}

/** Enforce the subcategory's required attributes. Codes match SPORTS_ERROR_CODES. */
export function assertVariantAttributesValid(
  profile: SubcategoryTrackingProfile | null,
  input: {
    variantSize?: string | null;
    variantSizeSystem?: string | null;
    jerseyNumber?: string | null;
  },
): void {
  if (!profile) return;
  for (const attr of profile.requiredAttributes) {
    if (attr === 'size' && !input.variantSize) {
      throw new ServiceError('validation_error', 'A size is required for this product.', {
        code: 'SHOE_SIZE_REQUIRED',
      });
    }
    if (attr === 'size_system' && !input.variantSizeSystem) {
      throw new ServiceError('validation_error', 'A size system is required for this product.', {
        code: 'SHOE_SIZE_SYSTEM_REQUIRED',
      });
    }
    if (attr === 'jersey_number' && !input.jerseyNumber) {
      throw new ServiceError('validation_error', 'A number is required for this product.', {
        code: 'JERSEY_NUMBER_INVALID',
      });
    }
  }
  if (input.jerseyNumber && !profile.supportsNumbers) {
    throw new ServiceError(
      'validation_error',
      'This product type does not use numbers.',
      { code: 'JERSEY_NUMBER_INVALID' },
    );
  }
}
```

- [ ] Create `apps/web/src/server/services/product-groups.ts` with the class described under Interfaces. The decisive parts:

```ts
  /**
   * Find an existing group by its deterministic key, or create one.
   *
   * NEVER fuzzy-matches. `candidates()` is the separate, advisory path that
   * surfaces near-misses for a HUMAN to resolve — this method is exact-key
   * only, so an import can never auto-merge an uncertain match.
   */
  async findOrCreate(
    input: CreateProductGroupInput & { subcategoryKey: string },
  ): Promise<{ group: ProductGroupRow; created: boolean }> {
    assertPermission(this.ctx, 'items:create');
    assertModuleEnabled(this.ctx, 'sports');

    const groupKey = buildGroupKey({
      subcategoryKey: input.subcategoryKey,
      brand: input.brand,
      model: input.model,
      styleNumber: input.styleNumber,
      colorway: input.colorway,
      team: input.team,
      league: input.league,
      season: input.season,
      homeAway: input.homeAway,
      manufacturer: input.manufacturer,
      color: input.color,
      name: input.name,
    });

    const existing = await this.findByKey(groupKey);
    if (existing) {
      void audit(
        { event: 'sports.group.matched', entityType: 'product_group', entityId: existing.id },
        this.ctx,
      );
      return { group: existing, created: false };
    }

    const { data, error } = await this.ctx.supabase
      .from('product_groups')
      .insert({
        organization_id: this.ctx.organizationId,
        category_id: input.categoryId ?? null,
        subcategory_key: input.subcategoryKey,
        name: input.name,
        brand: input.brand ?? null,
        manufacturer: input.manufacturer ?? null,
        model: input.model ?? null,
        style_number: input.styleNumber ?? null,
        colorway: input.colorway ?? null,
        team: input.team ?? null,
        league: input.league ?? null,
        season: input.season ?? null,
        home_away: input.homeAway ?? null,
        color: input.color ?? null,
        size_scale_id: input.sizeScaleId ?? null,
        default_counting_unit: input.defaultCountingUnit,
        tracking_mode: input.trackingMode ?? null,
        group_key: groupKey,
        created_by: this.ctx.userId,
        updated_by: this.ctx.userId,
      })
      .select('*')
      .single();

    if (error) {
      // 23505 = a concurrent writer won the race on product_groups_org_key_uniq.
      // Re-read rather than failing: both callers wanted the same identity.
      if ((error as { code?: string }).code === '23505') {
        const raced = await this.findByKey(groupKey);
        if (raced) return { group: raced, created: false };
      }
      throw new ServiceError('internal_error', error.message);
    }

    void audit(
      { event: 'sports.group.created', entityType: 'product_group', entityId: data.id as string },
      this.ctx,
    );
    return { group: data as ProductGroupRow, created: true };
  }

  /**
   * Advisory near-miss candidates for the review UI. Suggestion, never a link
   * (the 0233 discipline). Returns at most 5, ordered by how many identifying
   * attributes agree.
   */
  async candidates(parts: GroupKeyParts): Promise<ProductGroupRow[]> {
    const q = this.ctx.supabase
      .from('product_groups')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .is('deleted_at', null)
      .limit(5);
    if (parts.styleNumber) return (await q.ilike('style_number', parts.styleNumber)).data ?? [];
    if (parts.brand && parts.model) {
      return (await q.ilike('brand', parts.brand).ilike('model', parts.model)).data ?? [];
    }
    if (parts.team) return (await q.ilike('team', parts.team)).data ?? [];
    return [];
  }

  /** Derived roll-ups. Reads the view; never a stored total. */
  async rollups(groupIds: string[]): Promise<Map<string, GroupRollup>> {
    if (groupIds.length === 0) return new Map();
    const { data, error } = await this.ctx.supabase
      .from('product_group_rollups')
      .select('group_id, variant_count, total_quantity, counting_unit')
      .in('group_id', groupIds);
    if (error) throw new ServiceError('internal_error', error.message);
    const out = new Map<string, GroupRollup>();
    for (const r of data ?? []) {
      out.set(r.group_id as string, {
        variantCount: Number(r.variant_count),
        totalQuantity: Number(r.total_quantity),
        countingUnit: r.counting_unit as CountingUnit,
      });
    }
    return out;
  }
```

- [ ] Thread the profile into `InventoryService.create()` in `apps/web/src/server/services/inventory.ts`. Insert AFTER the existing `assertCustomFieldsValid` call and BEFORE the SKU resolution, so nothing about the existing guard order changes:

```ts
    // ── Sports profile resolution (server-side; the form is never trusted) ──
    // For every non-sports category this returns QUANTITY / 'none' / 'unit',
    // which is exactly the behaviour that existed before this block.
    const profile = resolveModeOverride(
      this.ctx,
      await resolveTrackingProfile(this.ctx, input.categoryId ?? null),
      input.trackingModeOverride,
    );
    assertVariantAttributesValid(profile.profile, input);

    let resolvedGroupId: string | null = input.groupId ?? null;
    let resolvedVariantKey: string | null = input.variantKey ?? null;
    if (profile.isSports) {
      assertModuleEnabled(this.ctx, 'sports');
      if (!resolvedGroupId && input.productGroup) {
        const groups = new ProductGroupsService(this.ctx);
        const { group } = await groups.findOrCreate({
          ...input.productGroup,
          subcategoryKey: profile.subcategoryKey ?? 'other_sports_equipment',
          categoryId: input.categoryId ?? null,
          defaultCountingUnit: (input.productGroup.defaultCountingUnit ??
            profile.countingUnit) as CountingUnit,
        });
        resolvedGroupId = group.id;
      }
      resolvedVariantKey ??= buildVariantKey({
        size: input.variantSize,
        sizeSystem: input.variantSizeSystem,
        width: input.variantWidth,
        fit: input.variantFit,
        color: input.variantColor,
        jerseyNumber: input.jerseyNumber,
      });
    }

    // The category mode STAMPS tracking_type. An explicit input.trackingType
    // still wins for non-sports categories so every existing caller is
    // unaffected; a sports category overrides it because the profile is the
    // authority (requirement 11: server-side, never trust the form).
    const stampedTrackingType = profile.isSports ? profile.trackingType : input.trackingType;
```

- [ ] Extend the insert map in `create()` (currently lines 1444-1487) with the new columns, placed after `tracking_type`:

```ts
        tracking_type: stampedTrackingType,
        group_id: resolvedGroupId,
        variant_size: input.variantSize ?? null,
        variant_size_original: input.variantSizeOriginal ?? input.variantSize ?? null,
        variant_size_system: input.variantSizeSystem ?? null,
        variant_width: input.variantWidth ?? null,
        variant_fit: input.variantFit ?? null,
        variant_color: input.variantColor ?? null,
        jersey_number: input.jerseyNumber ?? null,
        player_name: input.playerName ?? null,
        variant_key: resolvedVariantKey,
        // Counting unit: an explicit input wins; otherwise the category default
        // (PAIR for shoes). Display convention only — no conversion anywhere.
        unit_of_measure:
          input.unitOfMeasure !== 'unit' ? input.unitOfMeasure : profile.countingUnit,
```

- [ ] Replace the hardcoded 9-value size union in `bulkCreateSizedVariants` (`inventory.ts:1659`) with a free string validated against the category's size scale, and have it stamp `group_id` / `variant_size` / `variant_key` on every row it inserts. The `variants` array becomes:

```ts
    variants: Array<{ size: string; quantity: number }>;
```

  and each built row gains:

```ts
      group_id: resolvedGroupId,
      variant_size: normalizeSizeValue(v.size, sizeSystem),
      variant_size_original: v.size,
      variant_size_system: sizeSystem,
      variant_key: buildVariantKey({ size: normalizeSizeValue(v.size, sizeSystem), sizeSystem }),
```

- [ ] Fix the latent `.max(7)` bug in `apps/web/src/server/actions/inventory.ts:167` while here: the form offers 9 apparel sizes and a shoe run can be 20+, so the cap silently rejected valid input. Change `.min(1).max(7)` to `.min(1).max(60)` and the `size` field from the 9-value `z.enum` to `z.string().min(1).max(24)`.
- [ ] Add the audit events to the union in `apps/web/src/server/services/audit.ts`, placed with the other inventory events:

```ts
  | 'sports.group.created'
  | 'sports.group.matched'
  | 'sports.variant.created'
  | 'sports.variant.imported'
  | 'sports.import.mapping_confirmed'
  | 'sports.import.match_overridden'
```

- [ ] Extend `ITEM_SELECT_COLUMNS` in `apps/web/src/server/loaders/inventory-list.ts` with `group_id, variant_size, variant_size_system, jersey_number, variant_key`, and add the matching fields to `InventoryListRowBase`. The comment above it says it is a verbatim copy of `InventoryService.list()`'s select list — update BOTH or the cached and live paths drift.
- [ ] Write `apps/web/src/server/services/sports-profiles.test.ts` covering: a null category resolves to QUANTITY/none/unit; a non-sports category with no mode resolves the same; a Sports/Shoes child inherits the parent mode; an override to a disallowed mode throws `TRACKING_MODE_NOT_ALLOWED`; `INDIVIDUALLY_TAGGED` on a profile with `individualTrackingAllowed: false` throws; a missing size on Shoes throws `SHOE_SIZE_REQUIRED`; a jersey number on Shoes throws `JERSEY_NUMBER_INVALID`; and a read error throws rather than defaulting to relaxed.
- [ ] Write `apps/web/src/server/services/product-groups.test.ts` covering: `findOrCreate` returns `created: true` then `created: false` for the same key; a 23505 race re-reads instead of throwing; `candidates` never returns a match on name alone; `rollups` reads the view and returns 0 for a group with no variants.
- [ ] Run `pnpm test` and `pnpm typecheck`.
- [ ] **Regression (`create()` is the most shared write path in the app):** run the full vitest suite. Then hand-verify in Demo Co that creating (a) a plain product with no category, (b) a book, and (c) a rental asset all still work and write `group_id = null`. If any of these now demands a size or a subcategory, `resolveTrackingProfile` is not returning the non-sports default.
- [ ] **Regression (R1):** create an item under a category with `tracking_mode = 'SERIALIZED'` and confirm it is stamped `tracking_type = 'serial'`, then confirm a PO receipt against it with no serials is still refused.

---

# Phase 4 — Add Item (web + Expo) with grouping preview

## Task 9: `POST /api/v1/items` — the shared create seam

There is no create-item HTTP endpoint anywhere in the app today, which is exactly why mobile writes raw Supabase inserts. This endpoint is the prerequisite for the parity fix, and it hands mobile every guard it currently lacks for free.

**Files:**
- Create: `apps/web/src/app/api/v1/items/route.ts`
- Create: `apps/web/src/app/api/v1/items/route.test.ts`
- Modify: `apps/web/src/app/api/v1/items/lookup/route.ts` (return the variant fields)

**Interfaces:**
- Consumes from Tasks 7, 8: `createItemSchema`, `InventoryService.create`.
- Produces for Task 10: `POST /api/v1/items` accepting a `CreateItemInput` body and returning `{ id }` with 201.

**Steps:**

- [ ] Create `apps/web/src/app/api/v1/items/route.ts`, following the `apps/web/src/app/api/v1/cycle-counts/route.ts` template exactly (the precedent whose own doc comment states the pattern: "The mobile app has no server actions, so this goes through here with the standard Bearer-token auth"):

```ts
import { NextResponse, type NextRequest } from 'next/server';

import { createItemSchema } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { ForbiddenError } from '@/lib/auth/warehouse';
import { reportError } from '@/lib/error-reporter';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Create one inventory item.
 *
 * The mobile app has no server actions, so item creation goes through here
 * with the standard Bearer-token auth. Mirrors createItemAction on the web and
 * shares its EXACT zod schema, so a payload valid on one surface is valid on
 * the other. Everything the raw-PostgREST mobile path used to skip —
 * permission, plan limit, custom-field validation, warehouse resolution and
 * access, charter/warehouse pairing, the sports tracking profile, the audit
 * event and the search embedding — is enforced here by InventoryService.
 */
export async function POST(req: NextRequest) {
  try {
    const ctx = await withApiContext(req);
    if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

    const json = await req.json().catch(() => null);
    const parsed = createItemSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'validation_error',
          message: parsed.error.issues[0]?.message ?? 'Invalid input',
          // The field path lets the native form highlight the offending input
          // instead of showing a bare alert.
          path: parsed.error.issues[0]?.path ?? [],
        },
        { status: 400 },
      );
    }

    const svc = new InventoryService(ctx);
    const item = await svc.create(parsed.data);
    return NextResponse.json({ id: item.id }, { status: 201 });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json(
        // `details` carries the SPORTS_* code when the service set one, so the
        // native client can render the mapped title/action rather than raw text.
        { error: e.code, message: e.message, details: e.details ?? null },
        { status: serviceErrorStatus(e.code) },
      );
    }
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: 'forbidden', message: e.message }, { status: 403 });
    }
    void reportError(e, { tag: 'api.v1.items.create' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
```

- [ ] Write `apps/web/src/app/api/v1/items/route.test.ts` covering: 401 with no Bearer token; 400 with a `path` on a schema failure; 201 with `{ id }` on success; 403 when the caller lacks `items:create`; 400 when the sports profile rejects a missing size; and that the body is parsed with the SAME `createItemSchema` the web action uses (assert by importing both and comparing a representative payload's parse result).
- [ ] Extend `apps/web/src/app/api/v1/items/lookup/route.ts` so a scanned variant barcode returns `group_id`, `variant_size`, `jersey_number` and `unit_of_measure` on `ItemLookupMatch`. Scanning a variant barcode must resolve to THAT variant (requirements: "scanning a variant barcode adds/counts that variant").
- [ ] Run `pnpm test` and `pnpm typecheck`.
- [ ] **Regression:** confirm no existing route under `apps/web/src/app/api/v1/items/` changed behaviour. `lookup` gains fields; it must not lose any, or the mobile scanner breaks.

---

## Task 10: Mobile Add Item onto the shared schema — THE PARITY FIX

`apps/mobile/app/item/new.tsx` is 1074 lines that re-implement item creation with raw Supabase inserts and no zod. The Phase 1 report names this as a top migration risk: "Mobile parity drift (new.tsx raw writes — fix by moving it onto shared schemas)". Every gap below is a real defect that exists today, independent of sports.

The precedent for exactly this move is `apps/mobile/src/lib/cycle-count-sync.ts`, which already replaced a raw `cycle_count_lines` update with an API call and carries a comment explaining why.

**Files:**
- Modify: `apps/mobile/app/item/new.tsx`
- Create: `apps/mobile/src/lib/item-create.ts`
- Create: `apps/mobile/src/lib/item-create.test.ts`
- Modify: `apps/mobile/package.json` (add `zod` as a direct dependency)

**Interfaces:**
- Consumes from Tasks 7, 9: `createItemSchema`, `CreateItemInput`, `POST /api/v1/items`.
- Produces for Task 11: `buildCreateItemInput(form: ItemFormState): CreateItemInput` and `submitCreateItem(input: CreateItemInput): Promise<{ id: string }>` — the two functions the screen calls.

**Steps:**

- [ ] Add `"zod": "^3.23.8"` to `apps/mobile/package.json` dependencies. It arrives transitively via `@stockpilot/core` today, which works but is fragile; the screen will import `z` for its own error narrowing.
- [ ] Create `apps/mobile/src/lib/item-create.ts`:

```ts
/**
 * Native item creation, on the SHARED schema.
 *
 * Before this file, app/item/new.tsx built a raw PostgREST insert with three
 * imperative Alert guards and no zod, which meant mobile silently skipped:
 * every length cap, every numeric bound, the warehouse-required check, the
 * charter/warehouse pairing check, custom-field validation, the plan limit,
 * the permission check, the audit event, the search embedding, and
 * bin_location entirely (so mobile-created items never appeared correctly on
 * pick lists). It also demanded a SKU the web treats as optional.
 *
 * Everything now goes through POST /api/v1/items, exactly as cycle-count
 * recording already does (see src/lib/cycle-count-sync.ts).
 */
import { createItemSchema, type CreateItemInput } from '@stockpilot/core';

import { api } from './api';

export interface ItemFormState {
  name: string;
  sku: string;
  barcode: string;
  modelNumber: string;
  description: string;
  categoryId: string | null;
  supplierId: string | null;
  primaryLocationId: string | null;
  warehouseId: string | null;
  charterId: string | null;
  rackNumber: string;
  rackRow: string;
  unitCost: string;
  retailPrice: string;
  onHand: string;
  reorderPoint: string;
  reorderQuantity: string;
  unitOfMeasure: string;
  itemType: 'product' | 'book';
  customFields: Record<string, unknown>;
  // Sports
  variantSize?: string | null;
  variantSizeOriginal?: string | null;
  variantSizeSystem?: string | null;
  variantWidth?: string | null;
  variantFit?: string | null;
  variantColor?: string | null;
  jerseyNumber?: string | null;
  playerName?: string | null;
  groupId?: string | null;
  productGroup?: CreateItemInput['productGroup'];
}

export interface BuildResult {
  ok: true;
  input: CreateItemInput;
}
export interface BuildFailure {
  ok: false;
  message: string;
  /** Dotted field path so the screen can focus the offending input. */
  field: string | null;
}

/**
 * Validate the form with the SAME schema the web uses. Returns a failure
 * rather than throwing so the screen keeps its Alert-based UX.
 *
 * Note SKU is intentionally NOT required here: createItemSchema treats an
 * empty SKU as "auto-generate", which is what the web does. The old native
 * "SKU required" alert was a divergence, not a rule.
 */
export function buildCreateItemInput(form: ItemFormState): BuildResult | BuildFailure {
  const parsed = createItemSchema.safeParse({
    name: form.name,
    sku: form.sku,
    barcode: form.barcode,
    modelNumber: form.itemType === 'book' ? undefined : form.modelNumber,
    description: form.description,
    categoryId: form.categoryId,
    supplierId: form.supplierId,
    primaryLocationId: form.primaryLocationId,
    warehouseId: form.warehouseId,
    charterId: form.charterId,
    unitCost: form.unitCost || 0,
    retailPrice: form.retailPrice || 0,
    quantityOnHand: form.onHand || 0,
    reorderPoint: form.reorderPoint || 0,
    reorderQuantity: form.reorderQuantity || 0,
    unitOfMeasure: form.unitOfMeasure || 'unit',
    itemType: form.itemType,
    customFields: form.customFields,
    status: 'active',
    groupId: form.groupId,
    variantSize: form.variantSize,
    variantSizeOriginal: form.variantSizeOriginal ?? form.variantSize,
    variantSizeSystem: form.variantSizeSystem,
    variantWidth: form.variantWidth,
    variantFit: form.variantFit,
    variantColor: form.variantColor,
    jerseyNumber: form.jerseyNumber,
    playerName: form.playerName,
    productGroup: form.productGroup,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      message: issue?.message ?? 'Check the form and try again.',
      field: issue?.path.join('.') ?? null,
    };
  }
  return { ok: true, input: parsed.data };
}

/** POST the validated payload. The server owns every remaining guard. */
export async function submitCreateItem(input: CreateItemInput): Promise<{ id: string }> {
  return api<{ id: string }>('/api/v1/items', { method: 'POST', body: input });
}
```

- [ ] Rewrite `save()` in `apps/mobile/app/item/new.tsx`. Delete the entire raw-insert body (currently lines 376-547) and both branches. The replacement:

```tsx
  async function save() {
    if (busy) return;
    if (!user || !orgId) {
      Alert.alert('Not signed in', 'Sign in again to add inventory.');
      return;
    }

    // DECOMPOSE the rack fields through the ONE shared parser (web parity).
    const rack = normalizeRackFields({ number: rackNumber, row: rackRow });
    const rackNum = rack.number;
    const rackRowValue = rackNum ? (rack.row ?? '').toUpperCase() : '';
    const cf: Record<string, unknown> = {};
    if (isBook) {
      if (modelNumber.trim()) cf.author = modelNumber.trim();
      if (rackNum) cf.book_rack_number = rackNum;
      if (rackRowValue) cf.book_rack_row = rackRowValue;
    } else {
      if (rackNum) cf.rack_number = rackNum;
      if (rackRowValue) cf.rack_row = rackRowValue;
    }

    setBusy(true);
    try {
      // Sized / variant create: one POST per variant. Each goes through the
      // same server guards as a single create, so a partial failure reports
      // exactly which size failed instead of a raw Postgres string.
      if (variantsEnabled) {
        const variants = variantRows.filter((v) => v.quantity > 0);
        if (variants.length === 0) {
          Alert.alert('Pick at least one size', 'Set a quantity on at least one size.');
          setBusy(false);
          return;
        }
        const createdIds: string[] = [];
        for (const v of variants) {
          const built = buildCreateItemInput({
            ...formState,
            customFields: { ...cf, size: v.size },
            onHand: String(v.quantity),
            name: `${name.trim()} - ${v.size}`,
            sku: sku.trim() ? `${sku.trim()}-${v.size}` : '',
            variantSize: v.size,
            variantSizeOriginal: v.sizeOriginal ?? v.size,
            variantSizeSystem: sizeSystem,
            jerseyNumber: v.jerseyNumber ?? jerseyNumber || null,
            groupId: resolvedGroupId,
            productGroup: resolvedGroupId ? undefined : productGroupDraft,
          });
          if (!built.ok) {
            Alert.alert('Check this size', `${v.size}: ${built.message}`);
            setBusy(false);
            return;
          }
          const res = await submitCreateItem(built.input);
          createdIds.push(res.id);
          // The FIRST create resolves or creates the group; every later
          // variant reuses that id so the run lands in ONE group.
          resolvedGroupId ??= await fetchGroupIdFor(res.id);
        }
        for (const id of createdIds) await uploadPhotosFor(id);
        Alert.alert(
          'Variants created',
          `${createdIds.length} ${createdIds.length === 1 ? 'variant' : 'variants'} added.`,
        );
        router.replace('/');
        return;
      }

      // Single item.
      const built = buildCreateItemInput({ ...formState, customFields: cf });
      if (!built.ok) {
        Alert.alert('Check the form', built.message);
        setBusy(false);
        return;
      }
      const { id } = await submitCreateItem(built.input);
      await uploadPhotosFor(id);
      router.replace({ pathname: '/item/[id]', params: { id } });
    } catch (e) {
      Alert.alert('Could not add', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }
```

- [ ] Delete the hardcoded `ALL_SIZES` block at `apps/mobile/app/item/new.tsx:257-261` and drive the size chips from the category's size scale, fetched with the categories list. A shoe category must offer numeric sizes with halves, not the nine apparel letters.
- [ ] Delete the now-dead `adjust_stock` RPC call in the single-item path. The server's `create()` writes the `initial` stock movement itself, so calling it from the client would double-count. Verify by asserting `quantity_on_hand` after a native create with `onHand = 5` equals exactly 5.
- [ ] Write `apps/mobile/src/lib/item-create.test.ts` covering: an empty SKU is ACCEPTED (the web behaviour mobile used to refuse); a 300-character name is REJECTED with `field === 'name'`; a negative unit cost is REJECTED; a valid minimal payload parses; a jersey number of `'07'` survives the round trip as `'07'`; and a jersey number of `'ABC'` is rejected with `field === 'jerseyNumber'`.
- [ ] Simulator-test on iOS. Boot the simulator and hand-test, in Demo Co: add a plain product; add a book; add a product with a rack number and confirm `bin_location` is now stamped (it never was before); add a shoe style with three sizes and confirm one group; attempt a 300-character name and confirm a friendly message rather than a Postgres string.
- [ ] **Regression:** confirm the barcode-prefill entry (`params.barcode`) and the photo upload path still work, and that creating an item while offline surfaces the API timeout message rather than hanging.

---

## Task 11: Web Add Item — sports fields and the grouping preview

The requirements' UX flow: Category -> (Sports implies required subcategory) -> load tracking profile -> subcategory-appropriate fields -> authorized mode override -> grouping preview -> validate -> save.

**Files:**
- Modify: `apps/web/src/components/inventory/item-form.tsx`
- Create: `apps/web/src/components/inventory/sports-fields.tsx`
- Create: `apps/web/src/components/inventory/grouping-preview.tsx`
- Create: `apps/web/src/components/inventory/grouping-preview.test.tsx`
- Modify: `apps/web/src/app/(dashboard)/dashboard/inventory/new/page.tsx` (pass the profile lookups)

**Interfaces:**
- Consumes from Tasks 1, 7, 8: profiles, key builders, `createItemSchema`.
- Produces for Task 12: `<SportsFields profile={...} />` and `<GroupingPreview />`.

**Steps:**

- [ ] Extend `ItemFormProps.categories` so the form can resolve a profile without a round trip. The prop is currently `Array<{ id; name; supports_sizes?: boolean }>`:

```ts
  categories: Array<{
    id: string;
    name: string;
    supports_sizes?: boolean;
    parent_id?: string | null;
    tracking_mode?: TrackingMode | null;
    sports_subcategory_key?: string | null;
    default_unit_of_measure?: string | null;
    size_scale_id?: string | null;
  }>;
  /** Ordered size values per scale id, from size_scale_values. */
  sizeScales?: Record<string, Array<{ value: string; isHalf: boolean }>>;
  /** True when the org has the sports module on. */
  sportsEnabled?: boolean;
```

- [ ] Create `apps/web/src/components/inventory/grouping-preview.tsx`. The decisive part — this is the exact card the requirements specify, and the "Serial: not required" line is the reassurance that stops staff inventing placeholder serials:

```tsx
export interface GroupingPreviewProps {
  groupName: string | null;
  variantLabel: string | null;
  mode: TrackingMode;
  countingUnit: CountingUnit;
  /** Existing groups that look close. Advisory only — never auto-linked. */
  candidates?: Array<{ id: string; name: string }>;
  onUseCandidate?: (id: string) => void;
}

export function GroupingPreview({
  groupName, variantLabel, mode, countingUnit, candidates = [], onUseCandidate,
}: GroupingPreviewProps) {
  const serialLine =
    mode === 'SERIALIZED' || mode === 'INDIVIDUALLY_TAGGED'
      ? 'Serial: required, one per unit'
      : mode === 'OPTIONAL_SERIALIZED'
        ? 'Serial: optional'
        : 'Serial: not required';

  return (
    <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
      <div className="mb-2 font-medium">This will be saved as</div>
      <dl className="grid grid-cols-[9rem_1fr] gap-y-1">
        <dt className="text-muted-foreground">Product group</dt>
        <dd>{groupName ?? 'New group'}</dd>
        <dt className="text-muted-foreground">Variant</dt>
        <dd>{variantLabel ?? 'Single variant'}</dd>
        <dt className="text-muted-foreground">Tracking</dt>
        <dd>{TRACKING_MODE_LABELS[mode]}</dd>
        <dt className="text-muted-foreground">Counting unit</dt>
        <dd>{countingUnitLabel(countingUnit, 2)}</dd>
        <dt className="text-muted-foreground">Serial</dt>
        <dd>{serialLine}</dd>
      </dl>

      {candidates.length > 0 && (
        <div className="mt-3 border-t border-border pt-3">
          <div className="mb-1 text-xs text-muted-foreground">
            These existing groups look similar. Nothing is linked automatically.
          </div>
          <ul className="space-y-1">
            {candidates.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2">
                <span>{c.name}</span>
                <button type="button" className="text-xs underline"
                        onClick={() => onUseCandidate?.(c.id)}>
                  Use this group
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
```

- [ ] Create `apps/web/src/components/inventory/sports-fields.tsx` rendering the subcategory-appropriate inputs from `profile.supportedAttributes`. Two rules are non-negotiable:
  - The number input is labelled **"Jersey number"** (or the org's term) and NEVER "Serial Number". Its helper text reads "Numbers repeat across sizes and teams. Leading zeroes are kept."
  - When the mode is not serialized, the serial input is hidden entirely — not rendered disabled, and never pre-filled with a placeholder.
- [ ] Wire the profile resolution into `item-form.tsx`. Add beside the existing `watchedCategoryId` effect:

```tsx
  const watchedCategoryId = watch('categoryId');
  const selectedCategory = React.useMemo(
    () => categories.find((c) => c.id === watchedCategoryId) ?? null,
    [categories, watchedCategoryId],
  );
  const parentCategory = React.useMemo(
    () => categories.find((c) => c.id === selectedCategory?.parent_id) ?? null,
    [categories, selectedCategory],
  );
  const subcategoryKey = selectedCategory?.sports_subcategory_key ?? null;
  const profile = subcategoryKey
    ? (DEFAULT_SUBCATEGORY_PROFILES[subcategoryKey as SportsSubcategoryKey] ?? null)
    : null;
  const effectiveMode: TrackingMode =
    watch('trackingModeOverride') ??
    selectedCategory?.tracking_mode ??
    parentCategory?.tracking_mode ??
    profile?.defaultMode ??
    'QUANTITY';
  const countingUnit = (selectedCategory?.default_unit_of_measure ??
    parentCategory?.default_unit_of_measure ??
    profile?.defaultCountingUnit ??
    'unit') as CountingUnit;
```

- [ ] Enforce SPORTS_SUBCATEGORY_REQUIRED in the form: when the selected category IS the Sports root (it has children with `sports_subcategory_key` set) and the user has not picked a child, block submit with the mapped message. The server enforces this too — the form check is only for a fast, kind failure.
- [ ] Replace the fixed nine-chip size selector (lines 1102-1168) with chips driven by `sizeScales[selectedCategory.size_scale_id]`, falling back to the apparel scale. Keep the existing per-size quantity inputs and the existing "On hand is set above" swap.
- [ ] Render `<GroupingPreview>` immediately above the submit row, and only when `sportsEnabled && profile`. Feed `candidates` from a debounced call to a new `findGroupCandidatesAction` wrapping `ProductGroupsService.candidates`.
- [ ] Write `apps/web/src/components/inventory/grouping-preview.test.tsx` asserting: a QUANTITY_BY_VARIANT preview renders "Serial: not required"; SERIALIZED renders "Serial: required, one per unit"; OPTIONAL_SERIALIZED renders "Serial: optional"; a pair counting unit renders "pairs"; candidates render with a "Use this group" control and firing it calls `onUseCandidate` with the id (proving nothing links without an explicit click).
- [ ] Run `pnpm test`, `pnpm typecheck`, `pnpm lint`.
- [ ] **Regression (`item-form.tsx` serves items, books, assets, consumables and rentals):** hand-verify in Demo Co that the form is visually and behaviourally unchanged for a category with no tracking mode — no preview card, no sports fields, no subcategory requirement. Confirm the existing `supports_sizes` apparel flow still creates one row per size.

---

## Task 12: Subcategories and tracking-profile administration

`categories.parent_id` becomes visible for the first time. This is where a custom subcategory gets its mandatory full profile.

**Files:**
- Modify: `apps/web/src/components/categories/categories-manager.tsx`
- Create: `apps/web/src/components/categories/tracking-profile-editor.tsx`
- Modify: `apps/web/src/server/services/categories.ts`
- Modify: `apps/web/src/server/actions/categories.ts`
- Modify: `apps/mobile/src/screens/categories.tsx` (render the hierarchy)
- Create: `apps/web/src/server/services/categories.sports.test.ts`

**Interfaces:**
- Consumes from Tasks 1, 2, 4: profiles, columns, the `sports:manage` permission.
- Produces for Tasks 13-18: categories that resolve a real tracking mode, and a Sports root with subcategory children.

**Steps:**

- [ ] Extend `createCategorySchema` in `apps/web/src/server/services/categories.ts` (which already carries `parentId`, written but never set by any UI):

```ts
  trackingMode: trackingModeSchema.nullable().optional(),
  sportsSubcategoryKey: z.string().max(64).nullable().optional(),
  defaultUnitOfMeasure: countingUnitSchema.nullable().optional(),
  sizeScaleId: z.string().uuid().nullable().optional(),
  /** REQUIRED when creating a custom Sports subcategory. */
  trackingProfile: z
    .object({
      key: z.string().min(1).max(64),
      label: z.string().min(1).max(120),
      defaultMode: trackingModeSchema,
      allowedModes: z.array(trackingModeSchema).min(1),
      supportedAttributes: z.array(z.enum(SPORTS_ATTRIBUTES)),
      requiredAttributes: z.array(z.enum(SPORTS_ATTRIBUTES)),
      defaultCountingUnit: countingUnitSchema,
      supportsNumbers: z.boolean(),
      supportsSizes: z.boolean(),
      supportsColors: z.boolean(),
      individualTrackingAllowed: z.boolean(),
    })
    .nullable()
    .optional(),
```

- [ ] Enforce the custom-subcategory rule in the service, server-side:

```ts
    // Requirements: "custom subcategory MUST carry a full tracking profile
    // (default mode, serial requirement, supported/required attributes,
    // counting unit, numbers/sizes/colors support, individual tracking
    // allowed)". A built-in key supplies its own; a custom one must not be
    // creatable without one, or items under it have no rules at all.
    const isBuiltIn =
      input.sportsSubcategoryKey != null &&
      (SPORTS_SUBCATEGORIES as readonly string[]).includes(input.sportsSubcategoryKey);
    if (input.parentId && input.sportsSubcategoryKey && !isBuiltIn && !input.trackingProfile) {
      throw new ServiceError(
        'validation_error',
        'A custom Sports subcategory needs a full tracking profile before it can be saved.',
        { code: 'SPORTS_SUBCATEGORY_REQUIRED' },
      );
    }
    if (input.trackingMode != null || input.trackingProfile != null) {
      assertPermission(this.ctx, 'sports:manage');
    }
    // Reject a required attribute the profile does not support — the same rule
    // the core vitest asserts for the built-ins.
    if (input.trackingProfile) {
      for (const a of input.trackingProfile.requiredAttributes) {
        if (!input.trackingProfile.supportedAttributes.includes(a)) {
          throw new ServiceError(
            'validation_error',
            `"${a}" is required but not supported by this profile.`,
          );
        }
      }
      if (!input.trackingProfile.allowedModes.includes(input.trackingProfile.defaultMode)) {
        throw new ServiceError(
          'validation_error',
          'The default tracking mode must be one of the allowed modes.',
        );
      }
    }
```

- [ ] Render the hierarchy in `apps/web/src/components/categories/categories-manager.tsx`: children indented under their parent, a "Add subcategory" control on each root, and a Tracking column showing the resolved mode with an inherited marker when the mode comes from the parent.
- [ ] Add a "Set up Sports" action visible with `sports:manage` and the module on: creates a `Sports` root plus the eight built-in subcategories from `DEFAULT_SUBCATEGORY_PROFILES`, each stamped with its `sports_subcategory_key`, `tracking_mode`, `default_unit_of_measure` and the matching `size_scale_id` (apparel for jerseys/uniforms/apparel; `us_mens_shoe` for shoes). This is the ONLY way sports categories get created — nothing is seeded per-org by a migration.
- [ ] Create `tracking-profile-editor.tsx` — the form for a custom subcategory. Every `SubcategoryTrackingProfile` field is a control, and the save button is disabled until all are set. No field may default silently.
- [ ] Update `apps/mobile/src/screens/categories.tsx` to render the hierarchy. It already selects `parent_id` into its type at line 18/41 and then renders a flat list.
- [ ] Write `apps/web/src/server/services/categories.sports.test.ts` covering: a custom subcategory without a profile is refused; one with a profile whose required attribute is unsupported is refused; one whose default mode is not in `allowedModes` is refused; a built-in key needs no profile; and setting `trackingMode` without `sports:manage` throws `forbidden`.
- [ ] Run `pnpm test`, `pnpm typecheck`. Simulator-test the mobile categories screen.
- [ ] **Regression:** confirm existing flat categories still list, create, rename, soft-delete and reorder exactly as before, and that `supports_sizes` still behaves. A category with no parent and no mode must render with no sports affordances at all.

---

# Phase 5 — CSV and AI import

## Task 13: Variant columns on import lines and in the extraction schema (migration 0301)

The PO-imports chassis is prod-hardened but extracts a FLAT line schema with no size/variant/group fields. This threads variant data through every layer of it. The audit enumerated eight places a new `po_import_lines` column must reach — miss one and the value is silently dropped.

**Files:**
- Create: `supabase/migrations/0301_po_import_line_variants.sql`
- Create: `supabase/tests/0301_po_import_line_variants.test.sql`
- Modify: `apps/web/src/lib/po-scan/extract.ts` (`PO_SCHEMA`, `ExtractedPo`, the normalization mapper)
- Modify: `packages/core/src/schemas/po-imports.ts` (`canonicalPoLineSchema`)
- Modify: `apps/web/src/server/services/po-imports.ts` (`PoImportLineRow`, both line-payload mappers)
- Modify: `apps/web/src/server/services/po-imports-lines.ts` (the line SELECT at ~300-306)
- Modify: `apps/web/src/components/inventory/csv-import.tsx` (`TEMPLATE_HEADER`)
- Modify: `apps/web/src/server/actions/import.ts` (`csvRowSchema`)

**Interfaces:**
- Consumes from Tasks 5, 7: the item variant columns, the key builders.
- Produces for Task 14: `po_import_lines.variant_size` / `variant_size_original` / `variant_size_system` / `variant_width` / `variant_fit` / `variant_color` / `jersey_number` / `player_name` / `group_hint` / `suggested_group_id` / `mapping_confidence`.

**Steps:**

- [ ] Create `supabase/migrations/0301_po_import_line_variants.sql`:

```sql
-- 0301_po_import_line_variants.sql
--
-- Extends the PO-imports chassis with variant fields so a size run arrives as
-- a size run instead of N unrelated lines.
--
-- The chassis itself (staging status machine, SHA256 idempotency with
-- supersede lineage, per-line confidence, needs_review UI, and the 0233
-- suggestion-not-link discipline) is untouched. suggested_group_id follows
-- that discipline exactly: it is ADVISORY, and a human must accept it.

alter table public.po_import_lines
  add column if not exists variant_size text,
  /* The size EXACTLY as printed on the document. Never overwritten. */
  add column if not exists variant_size_original text,
  add column if not exists variant_size_system text,
  add column if not exists variant_width text,
  add column if not exists variant_fit text,
  add column if not exists variant_color text,
  add column if not exists jersey_number text,
  add column if not exists player_name text,
  /* Free-text style/group hint the extractor read off the document
     ("Nike Pegasus 41 FD2722"). Used to build a candidate group key. */
  add column if not exists group_hint text,
  /* ADVISORY group match. Never auto-linked — mirrors suggested_item_id (0233). */
  add column if not exists suggested_group_id uuid
    references public.product_groups(id) on delete set null,
  /* Confidence the AI attached to its COLUMN MAPPING for this line, separate
     from extraction_confidence (how well it read the characters). */
  add column if not exists mapping_confidence numeric(4,3);

comment on column public.po_import_lines.suggested_group_id is
  'Advisory "possible existing product group" for this line. Informational '
  'only — the user must accept it in review before anything is linked. Never '
  'linked automatically (the 0233 suggestion-not-link discipline).';

comment on column public.po_import_lines.jersey_number is
  'Uniform number read off the document, as TEXT with leading zeroes intact. '
  'NEVER written to a serial column, and never used as an identity key.';

comment on column public.po_import_lines.variant_size_original is
  'The size string exactly as printed. Requirements: "preserve source values".';

create index if not exists po_import_lines_suggested_group_idx
  on public.po_import_lines (suggested_group_id)
  where suggested_group_id is not null;
```

- [ ] Create `supabase/tests/0301_po_import_line_variants.test.sql`. Namespace `b0300000`. Assert: all eleven columns exist; `suggested_group_id` FKs `product_groups` with `on delete set null` (delete a group and confirm the line survives with a null); a jersey number of `'07'` round-trips; the columns are all nullable so an existing import path inserting without them still works (insert a line with only the pre-existing columns and assert it succeeds).
- [ ] Extend `PO_SCHEMA` in `apps/web/src/lib/po-scan/extract.ts`, inside `lines.items.properties`. Every description must instruct the model NOT to invent:

```ts
          size: {
            type: SchemaType.STRING,
            description:
              'The size AS PRINTED for this line (e.g. "10", "10.5", "XL", "US 9"). Copy it exactly; do not convert between size systems. Empty string if the line has no size.',
          },
          sizeSystem: {
            type: SchemaType.STRING,
            description:
              "The size system if the document states one: 'US_MENS', 'US_WOMENS', 'US_YOUTH', 'UK', 'EU', 'CM', or 'ALPHA' for letter sizes. Empty string if the document does not say — do NOT guess.",
          },
          width: {
            type: SchemaType.STRING,
            description:
              'Shoe width if printed (N, M, W, 2E, 4E, Standard, Wide, Extra Wide). Empty string if not present.',
          },
          colorway: {
            type: SchemaType.STRING,
            description:
              'Colour or colourway as printed ("Black/White"). Empty string if not present.',
          },
          jerseyNumber: {
            type: SchemaType.STRING,
            description:
              'The UNIFORM/JERSEY number for this line, as text, KEEPING leading zeroes ("00", "07"). Only fill this when the document clearly labels it as a jersey/uniform/player number. A bare "Number" column is ambiguous — leave this empty and lower mappingConfidence instead. NEVER put a serial number or a quantity here.',
          },
          playerName: {
            type: SchemaType.STRING,
            description:
              'Player or wearer name if the line names one. Empty string if not present. Never invent a name.',
          },
          groupHint: {
            type: SchemaType.STRING,
            description:
              'The style/product identity this line belongs to, as printed ("Nike Pegasus 41 FD2722", "Falcons Home Jersey 2026"). This is what lets several size lines resolve to ONE product. Empty string if unclear.',
          },
          mappingConfidence: {
            type: SchemaType.NUMBER,
            description:
              'Your confidence (0.0-1.0) that you assigned each value to the RIGHT FIELD. Lower this sharply when a column header is ambiguous (a bare "Number" could be a jersey number, a quantity, a serial, a style number or a PO line number). This is separate from `confidence`, which is about reading the characters correctly.',
          },
```

- [ ] Add the same keys to the `ExtractedPo['lines']` interface (lines 147-169) AND to the post-parse normalization mapper (lines 258-301). That mapper rebuilds each line field-by-field from a whitelist, so **any field not added there is silently dropped** — this is the single most likely place to lose the work. Normalize as you map:

```ts
      size: typeof l.size === 'string' ? l.size.trim() : '',
      sizeSystem: typeof l.sizeSystem === 'string' ? l.sizeSystem.trim().toUpperCase() : '',
      width: typeof l.width === 'string' ? l.width.trim() : '',
      colorway: typeof l.colorway === 'string' ? l.colorway.trim() : '',
      // Keep leading zeroes: never Number() this value.
      jerseyNumber: typeof l.jerseyNumber === 'string' ? l.jerseyNumber.trim() : '',
      playerName: typeof l.playerName === 'string' ? l.playerName.trim() : '',
      groupHint: typeof l.groupHint === 'string' ? l.groupHint.trim() : '',
      mappingConfidence:
        typeof l.mappingConfidence === 'number' && Number.isFinite(l.mappingConfidence)
          ? Math.min(1, Math.max(0, l.mappingConfidence))
          : null,
```

- [ ] Extend `SYSTEM_PROMPT` in the same file with the anti-invention rule:

```
Never invent a serial number, jersey number, size, quantity, SKU, team or
player. If a value is not printed on the document, return an empty string.
A missing value must stay missing. If a column header is ambiguous, leave the
specific field empty and lower mappingConfidence rather than guessing.
```

- [ ] Extend `canonicalPoLineSchema` in `packages/core/src/schemas/po-imports.ts` with the matching optional fields (`variantSize`, `variantSizeOriginal`, `variantSizeSystem`, `variantWidth`, `variantColor`, `jerseyNumber`, `playerName`, `groupHint`, `mappingConfidence`), all `.nullable()`.
- [ ] Extend `PoImportLineRow` (`po-imports.ts:95-120`) and BOTH line-payload mappers — `createFromScan` (~832-874) and `parseImport` (~980-1023). Both must write the new columns or a scanned import and a CSV import diverge.
- [ ] Extend the explicit line SELECT in `po-imports-lines.ts:300-306`. It is a hand-written column list; the create path cannot see a column that is not in it:

```ts
    .select(
      'id, po_import_id, line_number, line_type, description, qty_ordered_original, uom_original, unit_cost, vendor_item_number, vendor_product_number, auxiliary_number, item_id, variant_size, variant_size_original, variant_size_system, variant_width, variant_fit, variant_color, jersey_number, player_name, group_hint, suggested_group_id',
    )
```

- [ ] Extend `TEMPLATE_HEADER` in `apps/web/src/components/inventory/csv-import.tsx` with the sports columns the requirements list, and add matching optional fields to `csvRowSchema` in `apps/web/src/server/actions/import.ts`:

```ts
const TEMPLATE_HEADER = [
  'name', 'sku', 'barcode', 'description',
  'unit_cost', 'retail_price', 'quantity_on_hand',
  'reorder_point', 'reorder_quantity', 'unit_of_measure',
  'category_name', 'subcategory_name',
  'brand', 'model', 'style_number', 'colorway',
  'team', 'season', 'home_away', 'jersey_number', 'player_name',
  'size', 'size_system', 'width', 'fit', 'color',
  'counting_unit', 'tracking_mode',
  'serial', 'asset_tag', 'warehouse_name', 'location_name',
];
```

- [ ] Run `supabase db reset && pnpm db:test 2>&1 | grep -E "0301|Result:"`, then `pnpm test` and `pnpm typecheck`.
- [ ] **Regression (the PO-import create path is a shared surface):** re-run the existing po-imports tests. Then upload a real, NON-sports PO in Demo Co end to end (scan, review, approve) and confirm nothing about the flow changed. Every new column is nullable and every new extraction field is optional, so a PO with no sizes must behave identically.

---

## Task 14: Group-first matching, multi-candidate review, and mapping confirmation

Where deterministic matching and the no-invention rule are actually enforced. Requirements: "Matching deterministic (keys above), never name-string-only, ambiguous -> review, never auto-merge uncertain matches."

**Files:**
- Create: `apps/web/src/server/services/po-imports-variants.ts`
- Create: `apps/web/src/server/services/po-imports-variants.test.ts`
- Modify: `apps/web/src/server/services/po-imports-lines.ts` (the create path)
- Modify: `apps/web/src/server/services/po-imports.ts` (the two sibling-create paths)
- Modify: `apps/web/src/components/po-imports/po-import-detail.tsx` (review table)
- Modify: `apps/web/src/components/po-imports/create-items-modal.tsx` (per-line variant inputs)
- Create: `apps/web/src/components/po-imports/mapping-confirmation.tsx`

**Interfaces:**
- Consumes from Tasks 7, 8, 13: key builders, `ProductGroupsService`, the line columns.
- Produces for Task 15: `resolveLineVariant(deps, line): Promise<LineResolution>` and the `LineResult` vocabulary the review table renders.

**Steps:**

- [ ] Create `apps/web/src/server/services/po-imports-variants.ts`. The core resolver:

```ts
/** The review-table verdict for one line. Not just Valid/Invalid. */
export type LineResult =
  | 'create_new_group'
  | 'add_new_variant'
  | 'receive_into_existing_variant'
  | 'create_serialized_units'
  | 'possible_duplicate'
  | 'missing_required_attribute'
  | 'ambiguous_category'
  | 'ambiguous_variant_match'
  | 'serial_required'
  | 'mapping_review_required'
  | 'ready';

export interface LineResolution {
  result: LineResult;
  groupId: string | null;
  /** More than one -> ambiguous, and the user must choose. */
  groupCandidates: Array<{ id: string; name: string }>;
  variantItemId: string | null;
  variantCandidates: Array<{ id: string; name: string; sku: string }>;
  variantKey: string | null;
  message: string | null;
  errorCode: SportsErrorCode | null;
}

/**
 * Resolve one import line to a group and a variant.
 *
 * ORDER MATTERS and is deliberate:
 *   1. Mapping confidence gate — an ambiguous column blocks before anything
 *      is matched, so a mis-mapped "Number" never becomes a jersey number.
 *   2. GROUP FIRST, by exact deterministic key. Several size lines sharing a
 *      groupHint collapse onto one group here — that is the whole point.
 *   3. If the exact key misses, look for CANDIDATES. Zero -> create new. One
 *      -> still a suggestion, never a link. Two or more -> ambiguous, review.
 *   4. VARIANT within the resolved group, by exact variant key.
 *   5. Required attributes last, so the message names the group it belongs to.
 *
 * Nothing in here ever merges on a name string alone, and nothing auto-links.
 */
export async function resolveLineVariant(
  deps: { groups: ProductGroupsService; supabase: ServiceContext['supabase']; organizationId: string },
  line: PoImportLineRow,
  profile: ResolvedTrackingProfile,
): Promise<LineResolution> {
  const empty: LineResolution = {
    result: 'ready', groupId: null, groupCandidates: [], variantItemId: null,
    variantCandidates: [], variantKey: null, message: null, errorCode: null,
  };

  // 1. Mapping confidence gate.
  if (line.mapping_confidence != null && line.mapping_confidence < 0.7) {
    return {
      ...empty,
      result: 'mapping_review_required',
      errorCode: 'IMPORT_MAPPING_REVIEW_REQUIRED',
      message:
        'Confirm what the ambiguous column on this line means before importing.',
    };
  }

  if (!profile.isSports) return empty;

  // 2. Group by exact deterministic key.
  const parts: GroupKeyParts = {
    subcategoryKey: profile.subcategoryKey ?? 'other_sports_equipment',
    brand: line.brand_hint ?? null,
    model: line.group_hint ?? null,
    styleNumber: line.vendor_product_number ?? null,
    colorway: line.variant_color ?? null,
    name: line.group_hint ?? line.description ?? null,
  };
  const key = buildGroupKey(parts);
  let group = await deps.groups.findByKey(key);

  // 3. No exact hit -> candidates.
  let groupCandidates: Array<{ id: string; name: string }> = [];
  if (!group) {
    const cands = await deps.groups.candidates(parts);
    groupCandidates = cands.map((c) => ({ id: c.id, name: c.name }));
    if (groupCandidates.length > 1) {
      return {
        ...empty,
        result: 'ambiguous_variant_match',
        groupCandidates,
        errorCode: 'AMBIGUOUS_VARIANT_MATCH',
        message: 'Several existing product groups match this line. Pick one.',
      };
    }
    if (groupCandidates.length === 1) {
      // A SUGGESTION, not a link. The line stays in review until accepted.
      return {
        ...empty,
        result: 'possible_duplicate',
        groupCandidates,
        errorCode: 'POSSIBLE_PRODUCT_GROUP_DUPLICATE',
        message: 'An existing group looks like this one. Link it, or confirm a new group.',
      };
    }
  }

  // 4. Required attributes.
  const size = line.variant_size ?? null;
  if (profile.profile?.requiredAttributes.includes('size') && !size) {
    return {
      ...empty, groupId: group?.id ?? null,
      result: 'missing_required_attribute',
      errorCode: 'SHOE_SIZE_REQUIRED',
      message: 'This line has no size, and this product is tracked per size.',
    };
  }
  if (profile.profile?.requiredAttributes.includes('size_system') && !line.variant_size_system) {
    return {
      ...empty, groupId: group?.id ?? null,
      result: 'missing_required_attribute',
      errorCode: 'SHOE_SIZE_SYSTEM_REQUIRED',
      message: 'A size of "' + String(size) + '" needs a size system (US Men, UK, EU).',
    };
  }

  // 5. Variant within the group, by exact key.
  const variantKey = buildVariantKey({
    size, sizeSystem: line.variant_size_system, width: line.variant_width,
    fit: line.variant_fit, color: line.variant_color, jerseyNumber: line.jersey_number,
  });
  if (!group) {
    return { ...empty, result: 'create_new_group', variantKey, groupCandidates };
  }
  const variants = await deps.groups.variantsByKey(group.id, variantKey);
  if (variants.length > 1) {
    return {
      ...empty, groupId: group.id, variantKey,
      variantCandidates: variants,
      result: 'ambiguous_variant_match',
      errorCode: 'AMBIGUOUS_VARIANT_MATCH',
      message: 'More than one existing variant matches. Pick the right one.',
    };
  }
  if (variants.length === 1) {
    return {
      ...empty, groupId: group.id, variantKey,
      variantItemId: variants[0].id,
      result: 'receive_into_existing_variant',
    };
  }
  return { ...empty, groupId: group.id, variantKey, result: 'add_new_variant' };
}
```

- [ ] Add the serial guard to the resolver — the requirements forbid serials on a grouped import:

```ts
  // A quantity variant must never carry a serial. Refuse rather than dropping
  // it silently, so a mis-mapped serial column is visible.
  if (line.serial_hint && profile.trackingType === 'none') {
    return {
      ...empty, result: 'serial_required', errorCode: 'SERIAL_NUMBER_NOT_ALLOWED_FOR_GROUPED_IMPORT',
      message: 'This product is counted, not serialized. Remove the serial column mapping.',
    };
  }
  if (!line.serial_hint && profile.trackingType === 'serial' && Number(line.qty_ordered_original ?? 0) > 0) {
    return {
      ...empty, result: 'serial_required', errorCode: 'SERIAL_NUMBER_REQUIRED',
      message: 'This product is serialized. Every unit needs its own serial.',
    };
  }
```

- [ ] Thread the resolution into the create branch of `apps/web/src/server/services/po-imports-lines.ts` (~501-571). The `inventorySvc.create(...)` call gains the variant fields and the resolved group:

```ts
      const item = await inventorySvc.create(
        {
          name: finalName,
          sku: generateSku(),
          barcode: bookIsbn ?? vendorItemNumber ?? vendorProductNumber ?? undefined,
          unitCost: Number(l.unit_cost ?? 0) || 0,
          retailPrice: 0,
          quantityOnHand: 0,
          reorderPoint: 0,
          reorderQuantity: 0,
          unitOfMeasure: (l.uom_original as string | null)?.toLowerCase() ?? 'unit',
          supplierId: input.vendorId,
          warehouseId: input.warehouseId,
          charterId,
          categoryId: input.categoryId ?? null,
          primaryLocationId,
          // The category profile stamps the real value server-side; 'none' is
          // only the pre-sports default for a category with no mode.
          trackingType: 'none',
          itemType: input.itemType ?? 'product',
          customFields: {},
          status: 'active',
          // Phase 5: variant identity resolved above. groupId is only ever set
          // from an EXACT key hit or an explicitly accepted candidate.
          groupId: resolution.groupId,
          variantKey: resolution.variantKey,
          variantSize: l.variant_size ?? null,
          variantSizeOriginal: l.variant_size_original ?? l.variant_size ?? null,
          variantSizeSystem: l.variant_size_system ?? null,
          variantWidth: l.variant_width ?? null,
          variantFit: l.variant_fit ?? null,
          variantColor: l.variant_color ?? null,
          jerseyNumber: l.jersey_number ?? null,
          playerName: l.player_name ?? null,
        },
        { awaitingFirstReceipt: true },
      );
```

- [ ] Apply the SAME field list to the other two item-spawning paths, or a charter sibling loses its group: `po-imports-lines.ts:468-495` (the `use_existing` different-charter sibling) and `po-imports.ts:1228-1254` (the `approve()` ownership-charter sibling). Both read the source item with an explicit column list first (`po-imports-lines.ts:422-424`, `po-imports.ts:1148-1150`) — extend those SELECTs with `group_id, variant_size, variant_size_original, variant_size_system, variant_width, variant_fit, variant_color, jersey_number, player_name, variant_key` or the copy reads undefined.
- [ ] Extend the review table in `apps/web/src/components/po-imports/po-import-detail.tsx`. The header (currently 8 columns at ~672-684) gains Group, Variant and Result:

```tsx
  <TableHead className="w-12">#</TableHead>
  <TableHead>Description</TableHead>
  <TableHead>Vendor #</TableHead>
  <TableHead>Group</TableHead>
  <TableHead>Variant</TableHead>
  <TableHead>Qty / UOM</TableHead>
  <TableHead>Cost</TableHead>
  <TableHead>Type</TableHead>
  <TableHead>Serial status</TableHead>
  <TableHead>Result</TableHead>
  <TableHead>Internal item</TableHead>
  <TableHead className="w-20 text-right">Skip</TableHead>
```

  The Result cell renders the `LineResult` through a label map — never a bare "Valid"/"Invalid". Rows whose result is `ambiguous_variant_match`, `possible_duplicate`, `mapping_review_required`, `missing_required_attribute` or `serial_required` are visually flagged and BLOCK approval until resolved.
- [ ] Create `apps/web/src/components/po-imports/mapping-confirmation.tsx` — the AI mapping confirmation step. Rendered before the review table when any line has `mapping_confidence < 0.7`. It shows each ambiguous source column with the candidate meanings and their confidences, requires an explicit choice, and preserves the source value alongside:

```tsx
/**
 * Requirements: "Never silently guess: show candidate mappings + confidence,
 * require confirmation, preserve source values, block import until required
 * mappings resolved."
 *
 * A bare "Number" column is the canonical case — it could be a jersey number,
 * a quantity, a serial, a style number, or a PO line number.
 */
const CANDIDATE_MEANINGS = [
  { value: 'jersey_number', label: 'Jersey / uniform number' },
  { value: 'quantity', label: 'Quantity' },
  { value: 'serial', label: 'Serial number' },
  { value: 'style_number', label: 'Style / model number' },
  { value: 'line_number', label: 'PO line number' },
  { value: 'ignore', label: 'Ignore this column' },
] as const;
```

  Confirming writes an audit event `sports.import.mapping_confirmed` and clears the block.
- [ ] Extend `create-items-modal.tsx` with per-line variant inputs (size, size system, number) beside the existing per-line name override, so a reviewer can supply a missing required attribute without leaving the screen.
- [ ] Write `apps/web/src/server/services/po-imports-variants.test.ts` covering:
  - Three lines with the same `groupHint` and sizes 9/10/11 resolve to ONE group and three distinct variant keys (R2).
  - Two lines with jersey number `12` and sizes M/XL resolve to one group, two variants, and neither is treated as a serial (R3).
  - A line whose group matches two candidates returns `ambiguous_variant_match` and creates nothing.
  - A single candidate returns `possible_duplicate` and does NOT link.
  - `mapping_confidence: 0.4` returns `mapping_review_required` before any matching happens.
  - A serial on a `tracking_type: 'none'` line returns `SERIAL_NUMBER_NOT_ALLOWED_FOR_GROUPED_IMPORT`.
  - A `tracking_type: 'serial'` line with no serial returns `SERIAL_NUMBER_REQUIRED` (R1, at import time).
  - Two groups whose names are similar but whose style numbers differ never merge.
- [ ] Run `pnpm test`, `pnpm typecheck`, `pnpm lint`.
- [ ] **Regression:** run the full existing po-imports test set. Import a real non-sports PO in Demo Co and confirm the review table's original eight columns still read correctly and approval still works with the new columns empty.

---

## Task 15: Import idempotency and the end-to-end import scenarios

Proves the requirements' idempotency rule holds once lines can create groups: "batch id + source-row identity + idempotency key + org scope + resulting txn id. Distinguish same-request retry from an intentional second shipment — never permanently block a file hash."

**Files:**
- Create: `apps/web/src/server/services/po-imports-idempotency.test.ts`
- Create: `apps/web/src/server/services/po-imports-sports.integration.test.ts`
- Modify: `apps/web/src/server/services/po-imports.ts` (`createItemsFromLines` guard)

**Interfaces:**
- Consumes from Tasks 8, 14: `ProductGroupsService.findOrCreate`, `resolveLineVariant`.
- Produces: the evidence the DoD requires.

**Steps:**

- [ ] Add a re-entrancy guard to `createItemsFromPoLines`. It already tracks `item_created` per line; groups need the same discipline so a retried request cannot spawn a second group:

```ts
    // Same-request retry safety. findOrCreate is exact-key and re-reads on a
    // 23505 race, so re-running a partially-completed batch converges on the
    // SAME group rather than creating a second one. A line already carrying an
    // item_id is skipped outright — that is what distinguishes a RETRY from an
    // intentional second shipment, which arrives as a NEW import with its own
    // lines and legitimately receives more quantity into the same variant.
    if (l.item_id) { skipped++; continue; }
```

- [ ] Write `apps/web/src/server/services/po-imports-idempotency.test.ts` covering:
  - Running `createItemsFromPoLines` twice with the same `lineIds` creates the groups and items ONCE; the second run reports them as skipped.
  - A concurrent `findOrCreate` race (simulate a 23505) yields ONE group, and both callers receive the same id.
  - A second import of the SAME file after its PO was cancelled proceeds (the 0286/0287 supersede lineage), creates NO duplicate group, and receives additional quantity into the existing variants — proving a file hash is never permanently blocked.
  - Approving an import twice does not double the quantity.
- [ ] Write `apps/web/src/server/services/po-imports-sports.integration.test.ts` — the requirements' named integration scenarios, end to end through the service layer:
  - **R1:** a serialized Chromebook line imported with no serial is BLOCKED, with `SERIAL_NUMBER_REQUIRED`.
  - **R2:** a CSV of one shoe style in sizes 9, 10 and 11 produces ONE group, three variants, per-size quantities, and ZERO `serial_registry` rows.
  - **R3:** a CSV of jersey #12 in M and XL produces one group, two variants sharing the number, and a group roll-up of 5.
  - The same number across two different groups creates two independent variants and no conflict.
  - A mixed CSV of shoes and jerseys resolves each subcategory with its own profile in one file.
  - An AI extraction with an ambiguous "Number" column blocks approval until the mapping is confirmed.
  - A bulk import of 200 lines across 12 groups completes and the roll-ups are arithmetically correct.
- [ ] Run `pnpm test` and record the REAL output. Never claim a test passes without running it.
- [ ] **Regression:** re-run the full vitest and pgTAP suites. Both must be green before Phase 6 starts.

---

# Phase 6 — Operational flows

## Task 16: Size-run receiving on purchase orders

A PO size run is currently only expressible as N unrelated lines. This makes per-size ordered/received visible without changing the receipt RPC — the lines are already per-variant because a variant IS an `inventory_items` row.

**Files:**
- Modify: `apps/web/src/components/po/po-receive-dialog.tsx`
- Create: `apps/web/src/components/po/size-run-receive-grid.tsx`
- Create: `apps/web/src/components/po/size-run-receive-grid.test.tsx`
- Modify: `apps/web/src/app/(dashboard)/dashboard/purchase-orders/[id]/page.tsx`
- Modify: `apps/web/src/components/po/po-line-picker.tsx` (add a size-run add mode)
- Modify: `apps/mobile/app/po/[id].tsx`

**Interfaces:**
- Consumes from Tasks 5, 8: `group_id` / `variant_size` on items, `ProductGroupsService.rollups`.
- Produces for Task 20: a receive dialog that groups lines by product group.

**Steps:**

- [ ] Group PO lines by `item.group_id` in the receive dialog. Lines whose item has a null group render exactly as they do today — that is every line in every existing org.

```tsx
/**
 * Group receive lines by product group so a size run reads as one block with
 * per-size ordered/received, instead of N unrelated rows.
 *
 * Lines whose item has no group_id fall through to the existing flat renderer
 * untouched, which is every line for every non-sports org.
 */
const runs = React.useMemo(() => {
  const byGroup = new Map<string, ReceiveLine[]>();
  const loose: ReceiveLine[] = [];
  for (const l of lines) {
    const g = l.item?.groupId;
    if (!g) { loose.push(l); continue; }
    const arr = byGroup.get(g) ?? [];
    arr.push(l);
    byGroup.set(g, arr);
  }
  // A single-line "run" is not a run — render it loose so nothing collapses
  // that has nothing to collapse.
  const real: Array<{ groupId: string; lines: ReceiveLine[] }> = [];
  for (const [groupId, arr] of byGroup) {
    if (arr.length < 2) { loose.push(...arr); continue; }
    real.push({ groupId, lines: arr.sort(bySizeOrder) });
  }
  return { runs: real, loose };
}, [lines]);
```

- [ ] Create `size-run-receive-grid.tsx` — one row per size with Ordered / Already received / Receiving / Accepted / Rejected columns, a run subtotal, and a "receive all ordered" shortcut. Each size still posts as its own `p_lines` entry, so `post_receipt_v2` sees exactly what it sees today.
- [ ] Show the counting unit in the subtotal: "Receiving 24 pairs across 6 sizes". Read it from the group's `default_counting_unit`, never inferred.
- [ ] Sort sizes by the size scale's `sort_order`, not alphabetically. `10` must follow `9`, and `XL` must follow `L`.
- [ ] Add a "Add size run" mode to the PO line picker: pick a product group, then enter a quantity per size, producing one PO line per variant in one action.
- [ ] Mirror the grouping in `apps/mobile/app/po/[id].tsx`. Mobile never sends `lots` or `serials`, which is fine for quantity variants and now also fine for `serial_optional`.
- [ ] Write `size-run-receive-grid.test.tsx` covering: 3 grouped lines render as one run; 1 grouped line renders loose; ungrouped lines render loose; sizes sort by scale order not alphabetically; the subtotal sums the per-size receiving quantities and names the counting unit.
- [ ] Run `pnpm test`, `pnpm typecheck`. Simulator-test the mobile PO receive screen.
- [ ] **Regression (`post_receipt_v2` payload shape is unchanged):** confirm the dialog still emits the same `p_lines` recordset shape (`po_line_id, qty_received, qty_accepted, qty_rejected, unit_cost, notes, lots, serials`). Receive a non-sports PO in Demo Co, partially, then fully, and confirm the PO closes. Confirm the existing serial-capture UI still appears for a `serial` item inside a run.

---

## Task 17: Cycle counts by variant, and re-keying Instant Size Count

Two things. Counts must be countable per variant with no serial scan for ordinary pairs and jerseys. And Instant Size Count's `style_key` must re-key to `group_id`, or sports counts detach from the products they counted — named as a migration risk in the Phase 1 report.

**Files:**
- Create: `supabase/migrations/0302_size_count_product_group.sql`
- Create: `supabase/tests/0302_size_count_product_group.test.sql`
- Modify: `apps/web/src/server/services/size-counts.ts`
- Modify: `apps/web/src/app/api/v1/size-counts/route.ts`
- Modify: `apps/mobile/app/size-count/new.tsx`, `apps/mobile/app/size-count/[id].tsx`
- Modify: `apps/web/src/server/services/cycle-counts.ts`
- Modify: `apps/web/src/components/cycle-counts/count-item-picker.tsx`, `cycle-count-detail.tsx`
- Modify: `apps/mobile/app/cycle-count/[id].tsx`, `apps/mobile/app/cycle-count/scan/[id].tsx`

**Interfaces:**
- Consumes from Tasks 5, 8: `group_id`, `variant_size`, `ProductGroupsService`.
- Produces for Task 18: counts that name their variant, and size-count sessions bound to a real group.

**Steps:**

- [ ] Create `supabase/migrations/0302_size_count_product_group.sql`:

```sql
-- 0302_size_count_product_group.sql
--
-- Re-keys Instant Size Count from the display-only style_key to a real
-- product_group_id.
--
-- WHY: size_count_sessions.style_key is a nullable, unindexed text column
-- holding the output of packages/core/src/inventory/size-run.ts —
-- `stripSizeSuffix(name).toLowerCase()`. That key is derived from the item
-- NAME, so renaming an item silently detaches every historical count from the
-- product it counted. It is also never actually populated: mobile's
-- app/size-count/new.tsx posts only { mode, boxId }.
--
-- style_key is KEPT, not dropped. Existing rows carry it, the display-only
-- fallback still uses it for ungrouped inventory, and dropping it would
-- destroy the little provenance those rows have.

alter table public.size_count_sessions
  add column if not exists product_group_id uuid
    references public.product_groups(id) on delete set null;

comment on column public.size_count_sessions.product_group_id is
  'The product group these counted sizes belong to. Replaces the display-only '
  'style_key as the durable identity — style_key is derived from the item NAME '
  'and breaks when an item is renamed. style_key is retained for existing rows '
  'and for ungrouped inventory.';

create index if not exists size_count_sessions_group_idx
  on public.size_count_sessions (product_group_id)
  where product_group_id is not null;

-- NO BACKFILL. Mapping an old style_key to a group would be exactly the
-- name-heuristic inference the owner ruled out on 2026-07-27. Historical
-- sessions keep their style_key and no group.
```

- [ ] Create `supabase/tests/0302_size_count_product_group.test.sql`. Namespace `51301000`. Assert: the column and index exist; `on delete set null` holds (delete the group, the session survives with a null); `style_key` still exists and is still nullable; and — the anti-regression — a session inserted with only the pre-0302 columns still succeeds.
- [ ] Add `productGroupId` to `createSession` in `apps/web/src/server/services/size-counts.ts` and to the zod in `apps/web/src/app/api/v1/size-counts/route.ts` (alongside the existing `styleKey`).
- [ ] Make `apps/mobile/app/size-count/new.tsx` actually send an identity. It currently posts `{ mode: 'rapid_pass', boxId }` only. Add a product-group picker (searchable, group name + variant count) and post `productGroupId`. Keep `styleKey` optional for orgs without the sports module.
- [ ] Drive the size chips in `apps/mobile/app/size-count/[id].tsx` and `capture.tsx` from the group's size scale rather than the hardcoded nine (`SIZES` at `[id].tsx:20-21`, `LABELS` at `capture.tsx:22`, `FILTERS` at `review.tsx:20`). A shoe count must be able to tally 9, 9.5 and 10.
- [ ] Show the variant in cycle counts. `cycle_count_lines` already FKs `item_id` and a variant IS an item, so no schema change is needed — the lines just need to say what they are. Extend `CycleCountLineWithItem`:

```ts
export interface CycleCountLineWithItem extends CycleCountLineRow {
  item: {
    id: string; name: string; sku: string; unit_of_measure: string; barcode: string | null;
    // Phase 6: so a count sheet reads "Pegasus 41 - size 10" rather than a
    // bare SKU, and jerseys read "#12 - XL".
    group_id: string | null;
    variant_size: string | null;
    jersey_number: string | null;
  } | null;
}
```

- [ ] Add a "count by product group" scope to `CycleCountsService.start`. The existing `scope: 'selection'` path already takes `selectionItemIds`; a group scope resolves to every variant's item ids, which keeps the atomic snapshot RPC untouched.
- [ ] Ensure NO serial scan is demanded for ordinary pairs and jerseys. Audit `apps/mobile/app/cycle-count/scan/[id].tsx`: scanning a variant barcode must resolve to that variant and increment its count. The barcode scope is explicit — group barcodes are not scannable for counting, variant barcodes are.
- [ ] Group the count sheet by product group in `apps/web/src/lib/pdf/cycle-count.tsx` with a per-group subtotal, and print the counting unit.
- [ ] Run `supabase db reset && pnpm db:test 2>&1 | grep -E "0302|Result:"`, `pnpm test`, `pnpm typecheck`.
- [ ] Simulator-test both mobile flows: start a size count against a group, tally numeric sizes, review; and start a cycle count scoped to a group and scan a variant barcode.
- [ ] **Regression (cycle counts are assignee-locked since 0282):** confirm the assignee lock, release and force-reassign still behave, and that a count over ungrouped items renders exactly as before with no group headers.

---

## Task 18: List roll-ups and the opt-in group-linking review tool

Two pieces of the same idea: `group_id` becomes the PRIMARY grouping signal, with the existing name heuristic demoted to a fallback for ungrouped inventory — and the tool that lets the owner promote existing families from the fallback to real identity.

**Files:**
- Modify: `packages/core/src/inventory/size-run.ts` (accept an explicit group id)
- Modify: `packages/core/src/inventory/size-run.test.ts`
- Modify: `apps/web/src/components/inventory/inventory-table.tsx`
- Modify: `apps/mobile/src/lib/inventory-grouping.ts`
- Create: `apps/web/src/server/services/product-group-linking.ts`
- Create: `apps/web/src/server/services/product-group-linking.test.ts`
- Create: `apps/web/src/app/(dashboard)/dashboard/product-groups/page.tsx`
- Create: `apps/web/src/app/(dashboard)/dashboard/product-groups/link/page.tsx`
- Create: `apps/web/src/components/inventory/group-linking-review.tsx`

**Interfaces:**
- Consumes from Tasks 5, 8: `group_id`, `product_group_rollups`, `ProductGroupsService`.
- Produces for Task 20: the review tool the owner drives, and group-aware lists on both surfaces.

**Steps:**

- [ ] Extend `SizeRunEntryMeta` in `packages/core/src/inventory/size-run.ts` with an explicit group id, and prefer it over the name regex:

```ts
export interface SizeRunEntryMeta {
  key: string;
  name: string;
  quantity: number;
  groupable: boolean;
  /**
   * The item's stored product_groups id. When present this is the ONLY
   * grouping signal used — the name regex is never consulted, so renaming an
   * item can no longer break or forge a family.
   *
   * NULL keeps the legacy name-suffix heuristic, which is the display-only
   * fallback for every ungrouped item in every org (owner decision
   * 2026-07-27: heuristics remain as fallback, and there is no backfill).
   */
  groupId?: string | null;
  /** Stored variant size, shown on the member row instead of a parsed token. */
  variantSize?: string | null;
}
```

  and in `groupBySizeRun`, replace both `sizeRunStyleKey(m.name)` calls with:

```ts
    // Stored identity wins. A `group:` prefix keeps the two key spaces
    // disjoint so a group id can never collide with a derived style key.
    const key = m.groupable
      ? (m.groupId ? `group:${m.groupId}` : sizeRunStyleKey(m.name))
      : null;
```

- [ ] Extend `SizeRunGroup<T>` with `groupId: string | null` and `countingUnit: string | null` so the header can render "6 variants · 52 pairs total" instead of the current name-derived label.
- [ ] Add tests to `size-run.test.ts`: two items with the SAME `groupId` but unrelated names group together (a rename cannot break the family); two items with the same name base but DIFFERENT `groupId` do NOT group (a name collision cannot forge one); items with no `groupId` still group by the legacy name heuristic exactly as before (assert the existing test cases still pass verbatim).
- [ ] Feed `groupId` and `variantSize` through `apps/web/src/components/inventory/inventory-table.tsx` and `apps/mobile/src/lib/inventory-grouping.ts` (`GroupableItem` gains both fields). Both already consume the shared `size-run.ts`, so this is a data-plumbing change, not a logic one.
- [ ] Render the roll-up header with the counting unit and hide the serial column for quantity products — requirements: "no blank serial columns for quantity products". Show the tracking mode in admin views only.
- [ ] Create `apps/web/src/server/services/product-group-linking.ts` — the opt-in tool:

```ts
/**
 * The opt-in group-linking review tool.
 *
 * OWNER DECISION 2026-07-27: "New items group at creation; existing families
 * link via a bulk review tool the owner drives. Display heuristics remain as
 * fallback. NO name-heuristic auto-backfill."
 *
 * So: `suggestFamilies` PROPOSES, using the same display heuristic the lists
 * already use. `linkFamily` WRITES, and only ever from an explicit call
 * carrying the exact item ids a human confirmed. There is no code path in
 * this file that writes group_id without an explicit item id list.
 */
export interface FamilySuggestion {
  styleKey: string;
  baseName: string;
  members: Array<{ id: string; name: string; sku: string; parsedSize: string | null; quantity: number }>;
  /** Why this is only a suggestion: what the heuristic could not tell. */
  caveats: string[];
}

export async function suggestFamilies(
  deps: { supabase: ServiceContext['supabase']; organizationId: string },
  opts: { categoryId?: string | null; warehouseId?: string | null; limit?: number },
): Promise<FamilySuggestion[]>;

export interface LinkFamilyInput {
  /** The group to link into. Absent means create one from `group`. */
  groupId?: string;
  group?: CreateProductGroupInput & { subcategoryKey: string };
  /** EXPLICIT item ids. Nothing is inferred at write time. */
  members: Array<{
    itemId: string;
    variantSize: string | null;
    variantSizeOriginal: string | null;
    variantSizeSystem: string | null;
    jerseyNumber: string | null;
  }>;
  /** Required. Stored on the audit event. */
  reason: string;
}

export async function linkFamily(
  deps: { groups: ProductGroupsService; supabase: ServiceContext['supabase']; ctx: ServiceContext },
  input: LinkFamilyInput,
): Promise<{ groupId: string; linked: number }>;

/** Undo. A link is reversible precisely because nothing else depends on it. */
export async function unlinkItems(
  deps: { supabase: ServiceContext['supabase']; ctx: ServiceContext },
  input: { itemIds: string[]; reason: string },
): Promise<{ unlinked: number }>;
```

  `linkFamily` must: assert `sports:manage`; assert every `itemId` belongs to the caller's org (never trust client ids); refuse an item that already has a DIFFERENT `group_id` unless an explicit `force` is passed; write `group_id` + the variant fields + a computed `variant_key`; and emit one audit event per item with the reason. It must NOT touch `quantity_on_hand`, and must NOT write any `stock_movements` row — linking is an identity change, not a stock event.
- [ ] Build `group-linking-review.tsx`: suggested families as cards, each member row editable (size, size system, number), a per-family "Link" action, a "Not a family" dismissal, and a required reason field. The header states plainly that nothing is linked until Link is pressed.
- [ ] Create `/dashboard/product-groups` (list with roll-ups, gated on the `sports` module and `sports:manage`) and `/dashboard/product-groups/link` (the review tool). These are the hrefs the Task 4 registry entry points at.
- [ ] Write `product-group-linking.test.ts` covering: `suggestFamilies` returns proposals and writes NOTHING (assert zero mutations); `linkFamily` with three item ids writes exactly three `group_id` values; an item from another org is rejected; an item already in a different group is refused without `force`; `quantity_on_hand` is unchanged after linking; no `stock_movements` row is created; `unlinkItems` restores `group_id` to null.
- [ ] Run `pnpm test`, `pnpm typecheck`, `pnpm lint`. Simulator-test the mobile inventory list for both grouped and ungrouped orgs.
- [ ] **Regression (list grouping is a do-not-regress perf surface):** the app-wide nav and inventory-list performance notes forbid regressions here. Confirm `loadInventoryList` still uses `ITEM_SELECT_COLUMNS` with the 60s cache, that group-aware pagination (`runAwarePages`) still keeps a group's rows on one page, and that the ungrouped legacy path renders byte-identically. Measure the inventory list authed in a real browser before and after.

---

# Phase 7 — Migration and verification

## Task 19: `variant_size` dual-write backfill and ambiguity flags (migration 0303)

The ONE backfill in this plan, and it is deliberately narrow. `custom_fields.size` is a value the app itself wrote at create time from an explicit user choice — it is stored data, not a guess. Copying it into the indexed column is safe. Deriving a GROUP from an item name is not, and this migration does none of that.

**Files:**
- Create: `supabase/migrations/0303_variant_size_backfill.sql`
- Create: `supabase/tests/0303_variant_size_backfill.test.sql`
- Modify: `apps/web/src/server/services/inventory.ts` (`update()` dual-write)
- Create: `apps/web/src/server/services/inventory.dual-write.test.ts`
- Create: `docs/superpowers/reports/2026-07-27-sports-migration-report.md`

**Interfaces:**
- Consumes from Tasks 5, 8: the variant columns and the create path.
- Produces for Task 20: `inventory_items.variant_size` populated for every historically sized item, and `sports_review_flag` marking what could not be resolved.

**Steps:**

- [ ] Create `supabase/migrations/0303_variant_size_backfill.sql`:

```sql
-- 0303_variant_size_backfill.sql
--
-- Copies the STORED size out of custom_fields into the indexed column, and
-- flags what a human must look at.
--
-- WHAT IS BACKFILLED AND WHY IT IS SAFE:
-- custom_fields.size was written by bulkCreateSizedVariants at create time
-- from a size the user explicitly picked. It is recorded data, not inference.
-- Copying it into variant_size loses nothing and gains an index and a CHECK.
--
-- WHAT IS *NOT* BACKFILLED:
-- group_id. Deriving a group from an item NAME is exactly the name-heuristic
-- backfill the owner ruled out on 2026-07-27 ("existing families link via a
-- bulk review tool the owner drives"), because a wrong guess would bake a
-- wrong grouping into persistent identity. Every existing item keeps
-- group_id = NULL and continues to render through the display-only heuristic
-- until a human links it in /dashboard/product-groups/link.
--
-- Also not backfilled: jersey_number (no historical source exists — the field
-- has never existed anywhere, and inventing one from a name would be exactly
-- the fabrication the requirements forbid).
--
-- ROLLBACK: `update public.inventory_items set variant_size = null,
-- variant_size_original = null, sports_review_flag = null where ...` —
-- custom_fields is never modified by this migration, so the source of truth
-- for every backfilled value survives intact.

-- ── 1) Review flag ──────────────────────────────────────────────────────────
alter table public.inventory_items
  add column if not exists sports_review_flag text
    check (sports_review_flag is null or sports_review_flag in (
      'ambiguous_size',        -- custom_fields.size held something unparseable
      'sized_but_ungrouped',   -- has a size, no group: a linking candidate
      'name_size_conflict'     -- the name suffix disagrees with the stored size
    ));

comment on column public.inventory_items.sports_review_flag is
  'Set by the 0303 backfill to mark rows a human should look at. Never blocks '
  'anything and never changes behaviour — it only populates the review queue '
  'in /dashboard/product-groups/link.';

create index if not exists inventory_items_sports_review_idx
  on public.inventory_items (organization_id, sports_review_flag)
  where sports_review_flag is not null and deleted_at is null;

-- ── 2) Backfill variant_size from the STORED custom_fields.size ─────────────
-- Only where custom_fields.size is a non-empty string and variant_size is
-- still null, so a re-run is a no-op and nothing already set is overwritten.
update public.inventory_items
set variant_size          = upper(trim(custom_fields->>'size')),
    variant_size_original = custom_fields->>'size'
where deleted_at is null
  and variant_size is null
  and custom_fields ? 'size'
  and jsonb_typeof(custom_fields->'size') = 'string'
  and length(trim(custom_fields->>'size')) between 1 and 24;

-- ── 3) Flag rows a human should see ─────────────────────────────────────────
-- 3a. A stored size that is too long or empty to be a real size.
update public.inventory_items
set sports_review_flag = 'ambiguous_size'
where deleted_at is null
  and variant_size is null
  and custom_fields ? 'size'
  and jsonb_typeof(custom_fields->'size') = 'string'
  and length(trim(custom_fields->>'size')) not between 1 and 24;

-- 3b. Sized but ungrouped: the linking review queue.
update public.inventory_items
set sports_review_flag = 'sized_but_ungrouped'
where deleted_at is null
  and variant_size is not null
  and group_id is null
  and sports_review_flag is null;

-- 3c. The name suffix disagrees with the stored size — evidence the two
-- sources already diverged, so neither should be trusted silently.
update public.inventory_items i
set sports_review_flag = 'name_size_conflict'
where i.deleted_at is null
  and i.variant_size is not null
  and i.name ~* '(\s-\s|\s)(6XL|5XL|4XL|3XL|2XL|XXXXXL|XXXXL|XXXL|XXL|XL|XS|L|M|S)\s*$'
  and upper(regexp_replace(i.name, '^.*[\s-]([A-Za-z0-9]+)\s*$', '\1')) <> i.variant_size;

-- ── 4) Prove the ledger is untouched ────────────────────────────────────────
-- This migration writes NO quantity column and NO stock_movements row. The
-- pgTAP file asserts SUM(stock_movements) = quantity_on_hand still holds for
-- every touched item.
```

- [ ] Create `supabase/tests/0303_variant_size_backfill.test.sql`. Namespace `bf302000`. Assert: an item with `custom_fields.size = 'XL'` gets `variant_size = 'XL'` and `variant_size_original = 'XL'`; `custom_fields` is UNCHANGED (select it back and compare); an item with no `custom_fields.size` gets a null `variant_size`; **`group_id` is still NULL for every backfilled row** (the headline anti-inference assertion); a sized ungrouped item is flagged `sized_but_ungrouped`; `quantity_on_hand` is unchanged; no `stock_movements` row was created; and re-running the UPDATE statements is a no-op.
- [ ] Add the dual-write to `InventoryService.update()`. During the transition both places must agree, or a size edited on the item form drifts from the size the list groups by:

```ts
    // DUAL-WRITE (transition window, migration 0303). variant_size is the
    // durable column; custom_fields.size is what five older surfaces still
    // read. Writing one without the other lets them disagree, so update()
    // always writes both. Remove the custom_fields half only when every
    // reader has moved — tracked in the migration report.
    if (patch.variantSize !== undefined) {
      row.variant_size = patch.variantSize;
      row.variant_size_original = patch.variantSizeOriginal ?? patch.variantSize;
      row.custom_fields = {
        ...(existing.custom_fields ?? {}),
        ...(patch.variantSize ? { size: patch.variantSize } : {}),
      };
    }
```

- [ ] Write `inventory.dual-write.test.ts`: updating `variantSize` writes both places; updating other fields leaves both alone; clearing `variantSize` to null removes neither silently but nulls the column and leaves `custom_fields.size` for the reader migration to handle.
- [ ] Write `docs/superpowers/reports/2026-07-27-sports-migration-report.md` with the four sections the deliverables require: **schema** (every table and column added, 0294-0303), **backfills** (exactly what 0303 wrote and what it deliberately did not), **ambiguous rows** (the counts per `sports_review_flag` from prod after the push), and **rollback** (the exact statements, per migration, and the note that `custom_fields` is never mutated so the source survives).
- [ ] Run `supabase db reset && pnpm db:test 2>&1 | grep -E "0303|Result:"`.
- [ ] **Regression:** run the FULL pgTAP suite and the FULL vitest suite. Then confirm the existing size-run display grouping still works for a backfilled-but-ungrouped family — that is the fallback path the owner decision depends on.

---

## Task 20: Full-suite gates, production migration, and live Demo Co verification

Nothing ships until this task's evidence exists. Never claim untested.

**Files:**
- Modify: `docs/superpowers/reports/2026-07-27-sports-migration-report.md` (fill in the prod counts)
- Create: `docs/superpowers/reports/2026-07-27-sports-verification.md`
- Create: `docs/superpowers/specs/2026-07-27-sports-field-dictionary.md`
- Create: `docs/superpowers/specs/2026-07-27-sports-inventory-model.md`

**Interfaces:**
- Consumes: every prior task.
- Produces: the deliverables checklist below, evidenced.

**Steps:**

- [ ] Run the full local gate and record the REAL output of each:
  - `supabase db reset && pnpm db:test` — every pgTAP file green, including all nine new ones.
  - `pnpm test` — the whole vitest suite.
  - `pnpm typecheck` — clean. This is the only thing that proves no `tracking_type` enumerator site was missed, because `database.ts` is `any`.
  - `pnpm lint` — clean.
- [ ] Confirm the GitHub CI rollup is green on the branch. CI has been a real gate since 2026-07-20; check the branch's own rollup, not a neighbouring one.
- [ ] **Push migrations to production FIRST, then deploy.** `supabase db push --linked` against `xizpqmhhslgzbuqtjubv`, applying 0294 through 0303 in order. Pending migrations crash pages, so the web deploy must follow, never lead. Deploy by pushing to `main` only — the GitHub integration auto-deploys; do NOT also POST `/v13/deployments`.
- [ ] Fill in the migration report's ambiguous-row counts from production:

```sql
select organization_id, sports_review_flag, count(*)
from public.inventory_items
where sports_review_flag is not null and deleted_at is null
group by 1, 2 order by 3 desc;
```

- [ ] Enable the `sports` module for Demo Co (`71b27a4a-7948-4638-bc3f-535974713bd2`) and run the **live web verification**, recording a pass or fail per line:
  1. Categories: run "Set up Sports"; confirm a Sports root with eight subcategories, each showing its resolved mode and counting unit.
  2. Create a custom subcategory WITHOUT a profile; confirm it is refused with the mapped message.
  3. Add Item: pick Sports without a subcategory; confirm `SPORTS_SUBCATEGORY_REQUIRED`.
  4. Add a shoe style in sizes 9, 10 and 11 with quantities 4, 6 and 2. Confirm the grouping preview reads "Serial: not required" and the counting unit reads pairs. Confirm ONE group, three variants, a roll-up of "3 variants · 12 pairs total", and ZERO serial rows. **(R2)**
  5. Add jersey #12 in M(3) and XL(2). Confirm one group, two variants, a roll-up of 5, that the number field is labelled "Jersey number" and never "Serial Number", and that `07` and `7` can coexist. **(R3)**
  6. Add a second group whose jersey number is also 12; confirm no conflict.
  7. Electronics: create a serialized item, raise a PO, and try to receive with no serial. Confirm it is BLOCKED. **(R1)**
  8. Protective equipment: receive 4 units with 2 serials. Confirm it succeeds, that 2 registry rows exist, and that 4 units posted to on-hand.
  9. Receive the shoe PO as a size run; confirm per-size ordered/received and that sizes sort 9, 10, 11 — not alphabetically.
  10. CSV import a mixed shoes-and-jerseys file; confirm the review table shows Group, Variant and a real Result vocabulary, and that an ambiguous "Number" column blocks approval until confirmed.
  11. Re-upload the SAME file; confirm the duplicate is caught and that no second group appears.
  12. Transfer, adjust, return, and pick a variant; confirm each writes a `stock_movements` row naming the variant.
  13. Cycle count scoped to a product group; confirm counting by variant with no serial prompt.
  14. Run the linking review tool on an existing sized family; confirm nothing changes until Link is pressed, then confirm the family collapses under a real group.
  15. **Ledger check:** for every item touched above, confirm `SUM(stock_movements.quantity_change) = quantity_on_hand`.
- [ ] Run the **live mobile verification** in the iOS simulator, then on a real device, in Demo Co:
  1. Add Item: a plain product, a book, and a shoe style with three sizes. Confirm the shared-schema validation messages are friendly, that an empty SKU is accepted, and that a rack number now stamps `bin_location`.
  2. Confirm an item created with on-hand 5 has `quantity_on_hand = 5`, not 10 — proving the removed client-side `adjust_stock` call is really gone.
  3. Inventory list: confirm group roll-ups render and expand.
  4. PO receive: receive a size run.
  5. Size count: start a count against a product group and tally numeric sizes.
  6. Cycle count: scan a variant barcode and confirm it increments that variant.
  7. Confirm every notification link produced by these flows resolves on mobile.
- [ ] Ship the mobile build: `pnpm release:ota` from `apps/mobile`. Never a raw `eas update`. Confirm `runtimeVersion` matches `appVersion`; a native dependency change (the `zod` direct dependency in Task 10) needs a decision on whether OTA is sufficient — `zod` is pure JS, so OTA is sufficient, but state that explicitly in the verification report.
- [ ] Write `docs/superpowers/specs/2026-07-27-sports-inventory-model.md` — the final inventory model doc: the group/variant/unit mapping onto real tables, why `inventory_items` remains the sole quantity owner, and the tracking-mode-to-`tracking_type` table.
- [ ] Write `docs/superpowers/specs/2026-07-27-sports-field-dictionary.md` — one row per field with meaning, type, required-when, normalization rule, accepted aliases, whether it participates in the group key or the variant key, and its display label. Cover every column added in 0294-0303 plus every `PO_SCHEMA` field added in Task 13.
- [ ] Write `docs/superpowers/reports/2026-07-27-sports-verification.md` — the real results of every line above, with the files-changed list and the actual test output. If a line failed, record the failure; do not omit it.
- [ ] Update `docs/superpowers/reports/2026-07-27-sports-migration-report.md` to final.

---

## Required deliverables (§35) and the task that produces each

| # | Deliverable | Produced by |
|---|---|---|
| 1 | Root-cause current-model report | Already delivered — `docs/superpowers/specs/2026-07-27-sports-inventory-phase1-report.md` (Phase 1) |
| 2 | Final inventory model doc | Task 20 (`docs/superpowers/specs/2026-07-27-sports-inventory-model.md`) |
| 3 | Field dictionary (meaning / type / required / normalization / aliases / grouping / display) | Task 20 (`docs/superpowers/specs/2026-07-27-sports-field-dictionary.md`), sourced from Tasks 5, 7, 13 |
| 4 | Import mappings including AI confidence states | Task 13 (`PO_SCHEMA` + `mapping_confidence`) and Task 14 (`mapping-confirmation.tsx`), documented in Task 20 |
| 5 | Migration report (schema, backfills, ambiguous, rollback) | Task 19 drafts it; Task 20 fills in the production counts |
| 6 | Files changed | Task 20 (`2026-07-27-sports-verification.md`) |
| 7 | REAL test results, never claimed untested | Every task's final steps; consolidated in Task 20 |
| 8 | Remaining policy decisions | The section below; each is assigned to the task that must resolve it with the owner |

### Definition-of-Done coverage

| DoD clause | Task |
|---|---|
| Sports category with required subcategories | 12 (UI + server rule), 2 (schema) |
| Shoes/jerseys grouped without serials | 5, 8, 11 — proved by R2/R3 in 0298 pgTAP and Task 15 |
| Per-variant quantities | 5 (variants are items), 8 |
| Size structured, not name-only | 2 (size scales), 5 (`variant_size`), 19 (backfill) |
| PAIR counting | 1 (`countingUnitLabel`), 2 (`default_unit_of_measure`), 8 (stamping), 11/16/18 (display) |
| Jersey number separate from serial, repeatable | 5 (non-unique column + CHECK), 7 (normalizer), 11 (never labelled Serial) |
| Existing categories unaffected | 2 (null reads as QUANTITY), 8 (non-sports default), regression steps throughout |
| Custom subcategories need profiles | 12 |
| CSV + AI sports-aware with review and no invention | 13, 14 |
| Deterministic matching | 7 (key builders), 14 (`resolveLineVariant`) |
| Idempotent imports | 15 |
| PO receiving preserves variant quantities | 16 |
| Counts support variants | 17 |
| Web and Expo share rules | 7 (shared zod), 9 (API seam), 10 (the parity fix) |
| Auditable transactions | 8 (audit events), the ledger assertions in 0296/0298/0299/0302 |
| Mode changes require migration | 8 (`resolveModeOverride`), 12 — see open question 5 |
| Safe data migration | 19 |
| Tests cover shoes, jerseys and existing serialized | 15 (R1/R2/R3 integration), 3 (R1 at the RPC), 5 (R2/R3 at the schema) |

---

## Open policy questions

Each must be resolved WITH THE OWNER inside the named task, before that task's code is written. None blocks starting the plan; all block their own task.

### 1. Is a jersey number required, or optional per subcategory? — resolve in **Task 12**

Currently modelled as optional: `DEFAULT_SUBCATEGORY_PROFILES.jerseys.requiredAttributes` is `['size']`, not `['size', 'jersey_number']`. That choice lets a school stock blank numbered jerseys and number them later, which is common. If the owner wants it required, move `'jersey_number'` into `requiredAttributes` for `jerseys` — `assertVariantAttributesValid` already enforces the list, and `SPORTS_ERROR_META.JERSEY_NUMBER_INVALID` already has the copy. The decision must be made before Task 12 ships the profile editor, because a per-subcategory override becomes an org-visible setting at that point.

### 2. Does grouping ever key on player name? — resolve in **Task 7**

`buildVariantKey` accepts `playerName` and includes it in the key when present, but nothing populates it today, so in practice player name is a label. The question is whether a jersey assigned to a named player is a distinct VARIANT (Smith #12 M is not Jones #12 M) or the same variant with an assignment. If it is a distinct variant, `playerName` must be added to `jerseys.requiredAttributes` and the key stays as written. If it is an assignment, remove `playerName` from `buildVariantKey` entirely and model assignment separately — leaving it in the key would fragment a group every time a jersey changes hands. Decide before Task 7's tests are frozen, because the key is persisted in `variant_key` and changing it later requires a re-key migration.

### 3. Is colorway a group attribute or a variant attribute? — resolve in **Task 5**

Modelled as BOTH: `product_groups.colorway` (group level, and part of the shoe group key) and `inventory_items.variant_color` (variant level). The migration comment states the rule — a group whose variants differ by colorway leaves the group column NULL and carries colour on the variant. That is flexible but ambiguous in practice, and the two produce different group counts for the same catalog. The owner must state the default for shoes: is "Pegasus 41 Black/White" a different product from "Pegasus 41 Blue" (group-level, as currently keyed), or one product in two colours (variant-level)? Decide before 0298 ships, because it determines whether `colorway` stays in `buildGroupKey`'s shoe slots.

### 4. Which size scales seed first? — resolve in **Task 2**

Four are proposed: apparel alpha (XS-6XL, the union of every list that exists today), US Men's shoe, US Women's shoe, US Youth shoe — all numeric shoe scales spanning half sizes. Not proposed: UK, EU, CM, and any width vocabulary as a separate scale (widths ride `variant_width` as free text against the N/M/W/2E/4E list). The owner should confirm the opening four and say whether UK/EU are needed for the first customer, because a scale added later is a data migration for any item already using a neighbouring one.

### 5. What is the controlled tracking-mode-change migration? — resolve in **Task 8**

The requirements specify that changing tracking mode after transactions requires "elevated permission, preflight, reconciliation, confirmation, audit reason", and `TRACKING_MODE_CHANGE_REQUIRES_MIGRATION` is already in the error vocabulary. This plan enforces the REFUSAL (an item with movements cannot silently change mode) but does not build the guided migration flow. The owner must decide whether that flow is in scope for this program or a follow-on: if in scope, it becomes a task between 8 and 11; if not, Task 8 must hard-refuse the change and the error copy must point at support rather than a non-existent wizard.

### 6. Are high-value jerseys individually tagged by default? — resolve in **Task 12**

`jerseys.individualTrackingAllowed` is `true` and `INDIVIDUALLY_TAGGED` is in its `allowedModes`, but the default is `NUMBERED_VARIANT`. So an org CAN escalate a jersey group to unit tracking, but nothing does it automatically. If the owner wants a value threshold to drive it, that is a new per-subcategory setting on the profile and belongs in the Task 12 editor.
