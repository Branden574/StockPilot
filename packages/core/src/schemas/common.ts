import { z } from 'zod';

/**
 * Form fields default to '' when untouched by the user. min(1) on an
 * optional string would reject those, when the actual intent of an
 * empty SKU/barcode field is "auto-generate / leave blank". Normalize
 * empty + whitespace-only strings to undefined BEFORE validation so
 * the optional() path handles them cleanly. Real values pass through.
 *
 * Lives here because every schema module needs it: define it ONCE and import
 * it, so a future tweak (e.g. also folding a literal 'null' string) cannot
 * land in one copy and miss the others.
 */
export const emptyToUndefined = (v: unknown) =>
  typeof v === 'string' && v.trim().length === 0 ? undefined : v;

export const uuidSchema = z.string().uuid();
export const emailSchema = z.string().email().max(254).toLowerCase().trim();
export const slugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Use lowercase letters, numbers, and dashes');

export const paginationSchema = z.object({
  cursor: z.string().nullable().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export const passwordSchema = z
  .string()
  .min(8, 'At least 8 characters')
  .max(72, 'Too long')
  .regex(/[a-z]/, 'Include a lowercase letter')
  .regex(/[A-Z]/, 'Include an uppercase letter')
  .regex(/[0-9]/, 'Include a number');
