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
