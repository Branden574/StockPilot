// packages/core/src/schemas/duplicate-item.ts
import { z } from 'zod';

const trimmedNonEmpty = z
  .string()
  .trim()
  .min(1, 'Required')
  .max(40, 'Too long');

const optionalTrimmed = z
  .string()
  .trim()
  .max(40, 'Too long')
  .optional()
  .nullable();

const quantitySchema = z
  .number()
  .int('Whole numbers only')
  .min(0, 'Must be 0 or more')
  .max(1_000_000, 'Too large');

/**
 * Optional variant overrides (migration 0299).
 *
 * ABSENT inherits the original's value; PRESENT-BUT-NULL clears the field.
 * That mirrors the `p_overrides ? 'key'` presence test in the RPC exactly, so
 * `duplicateItem` must only set a key when the caller supplied one — see
 * `InventoryService.duplicateItem`. None of these is ever required: a plain
 * duplicate passes none of them and inherits everything.
 *
 * The bounds match the DB CHECKs added in 0298: variant_size is 1-24 chars,
 * jersey_number is 1-4 digits with leading zeroes preserved ('0', '00', '07').
 * An empty string reaches the RPC as `nullif(..., '')` and therefore clears,
 * which is why the free-text fields do not carry a `.min(1)`.
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

export const duplicateItemAsProductSchema = z.object({
  originalId: z.string().uuid(),
  itemType: z.literal('product'),
  rackNumber: trimmedNonEmpty,
  rackRow: optionalTrimmed,
  quantity: quantitySchema,
  ...variantOverrides,
});

export const duplicateItemAsBookSchema = z.object({
  originalId: z.string().uuid(),
  itemType: z.literal('book'),
  rackNumber: trimmedNonEmpty,
  rackRow: optionalTrimmed,
  crateColor: trimmedNonEmpty,
  crateNumber: trimmedNonEmpty,
  quantity: quantitySchema,
  ...variantOverrides,
});

export const duplicateItemSchema = z.discriminatedUnion('itemType', [
  duplicateItemAsProductSchema,
  duplicateItemAsBookSchema,
]);

export type DuplicateItemInput = z.infer<typeof duplicateItemSchema>;
export type DuplicateItemProductInput = z.infer<typeof duplicateItemAsProductSchema>;
export type DuplicateItemBookInput = z.infer<typeof duplicateItemAsBookSchema>;
