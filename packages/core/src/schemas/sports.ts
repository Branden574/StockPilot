import { z } from 'zod';

import { COUNTING_UNITS, SPORTS_ATTRIBUTES, TRACKING_MODES } from '../sports/tracking-modes';
import { emptyToUndefined, uuidSchema } from './common';

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

/**
 * The size-system vocabulary. ONE list: the zod enum below and every picker
 * that offers these values derive from it (`sizeSystemEnum.options`), so a new
 * system can never be accepted by the schema while staying invisible in the UI
 * — or, worse, offered in a form and rejected on save.
 */
export const SIZE_SYSTEMS = [
  'US_MENS',
  'US_WOMENS',
  'US_YOUTH',
  'UK',
  'EU',
  'CM',
  'ALPHA',
  'CUSTOM',
] as const;
export type SizeSystem = (typeof SIZE_SYSTEMS)[number];

export const sizeSystemEnum = z.enum(SIZE_SYSTEMS);
export const sizeSystemSchema = z.preprocess(
  emptyToUndefined,
  sizeSystemEnum.nullable().optional(),
);

export const countingUnitSchema = z.enum(COUNTING_UNITS);
export const trackingModeSchema = z.enum(TRACKING_MODES);

/**
 * Full profile for a CUSTOM Sports subcategory (Task 12). Mirrors
 * `SubcategoryTrackingProfile` in ../sports/tracking-modes.ts field-for-field —
 * every field is REQUIRED here (no `.optional()` anywhere), because a partial
 * profile would leave items under it with no rules at all (requirements: "custom
 * subcategory MUST carry a full tracking profile").
 *
 * SHARED, not server-only, on purpose: the web dialog gates its Save button on
 * `isTrackingProfileComplete()` and the server gates the write on this schema.
 * Two hand-written field lists drifted (the UI's ignored `defaultCountingUnit`
 * and the four booleans), so the UI now derives its predicate from this object
 * and the drift cannot come back.
 */
export const trackingProfileSchema = z.object({
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
});
export type TrackingProfileInput = z.infer<typeof trackingProfileSchema>;

/**
 * The two CROSS-FIELD rules a profile must satisfy, on top of the shape above.
 * Shared for the same reason the schema is: `CategoriesService` refuses a write
 * that fails either, and the dialog keeps Save disabled until both hold.
 * Returns the offending message, or null when the profile is consistent.
 */
export function trackingProfileConsistencyError(p: TrackingProfileInput): string | null {
  for (const a of p.requiredAttributes) {
    if (!p.supportedAttributes.includes(a)) {
      return `"${a}" is required but not supported by this profile.`;
    }
  }
  if (!p.allowedModes.includes(p.defaultMode)) {
    return 'The default tracking mode must be one of the allowed modes.';
  }
  return null;
}

/**
 * The variant attributes an item may carry. Every one is optional.
 *
 * This is the CLIENT-ACCEPTED contract (web forms, Expo, /api/v1 bodies).
 * `variantKey` is deliberately ABSENT: it is derived, not supplied. zod strips
 * unknown keys, so a client that posts one has it dropped here rather than
 * rejected — old builds keep working and the value simply never reaches a
 * service. Use `serverVariantAttributesSchema` below on the write path.
 */
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
});
export type VariantAttributes = z.infer<typeof variantAttributesSchema>;

/**
 * SERVER-SIDE ONLY. The same attributes PLUS the computed `variantKey`.
 *
 * `variant_key` is the identity a variant is matched and de-duplicated on, so
 * a caller that chooses its own value chooses which physical stock its item
 * merges with. It must therefore always be DERIVED, never accepted:
 *
 *   Task 8+ (ProductGroupsService, PO-import matching, mobile parity) MUST
 *   recompute it with buildVariantKey(...) from the parsed attributes
 *   immediately before persisting, and MUST NEVER trust a client-supplied
 *   value. Parse the request with `variantAttributesSchema` (which strips the
 *   field), compute the key, then validate the row with this schema.
 *
 * The 240-char bound is a sanity cap on the derived string, not a contract
 * with any client — the DB column is plain `text` (migration 0298).
 */
export const serverVariantAttributesSchema = variantAttributesSchema.extend({
  variantKey: z.preprocess(emptyToUndefined, z.string().max(240).nullable().optional()),
});
export type ServerVariantAttributes = z.infer<typeof serverVariantAttributesSchema>;

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

/* ---- the opt-in group-linking review tool (Task 18) -------------------- */

/**
 * ONE member of an explicit link — an item id a human confirmed, plus the
 * variant attributes they confirmed for it.
 *
 * There is deliberately no "style key", "name pattern" or "match everything
 * like this" field anywhere in this schema. The write path can only ever be
 * handed item ids, so no client — web, phone or API — can ask the server to
 * apply a heuristic (owner decision 2026-07-27: NO name-heuristic backfill).
 */
export const linkFamilyMemberSchema = z.object({
  itemId: uuidSchema,
  // 24, matching inventory_items_variant_size_check (0298) and
  // variantAttributesSchema above. At 32 a 25-32 character size passed here,
  // reached the service, and tripped the DB CHECK MID-BATCH — linkFamily writes
  // row by row, so earlier members of the same link were already committed and
  // the reviewer got a 500 over a half-linked family instead of a 400 they
  // could act on.
  variantSize: z.preprocess(emptyToUndefined, z.string().max(24).nullable().optional()),
  variantSizeOriginal: z.preprocess(emptyToUndefined, z.string().max(64).nullable().optional()),
  variantSizeSystem: sizeSystemSchema,
  jerseyNumber: jerseyNumberSchema,
});
export type LinkFamilyMemberInput = z.infer<typeof linkFamilyMemberSchema>;

/** Cap on one link/unlink call — mirrors the service's own ceiling. */
export const MAX_LINK_FAMILY_MEMBERS = 200;

export const linkFamilySchema = z
  .object({
    groupId: uuidSchema.optional(),
    group: createProductGroupSchema.extend({ subcategoryKey: z.string().min(1).max(64) }).optional(),
    members: z.array(linkFamilyMemberSchema).min(1).max(MAX_LINK_FAMILY_MEMBERS),
    // REQUIRED, and it lands on every per-item audit event. A link is a
    // human's assertion about identity; an unattributed one is not reviewable.
    reason: z.string().trim().min(1, 'Say why these items are one product.').max(500),
    force: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.groupId) !== Boolean(v.group), {
    message: 'Pick an existing product group, or supply exactly one to create.',
    path: ['groupId'],
  });
export type LinkFamilyRequest = z.infer<typeof linkFamilySchema>;

export const unlinkItemsSchema = z.object({
  itemIds: z.array(uuidSchema).min(1).max(MAX_LINK_FAMILY_MEMBERS),
  reason: z.string().trim().min(1, 'Say why this grouping was wrong.').max(500),
});
export type UnlinkItemsRequest = z.infer<typeof unlinkItemsSchema>;
