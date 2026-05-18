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

export const duplicateItemAsProductSchema = z.object({
  originalId: z.string().uuid(),
  itemType: z.literal('product'),
  rackNumber: trimmedNonEmpty,
  rackRow: optionalTrimmed,
  quantity: quantitySchema,
});

export const duplicateItemAsBookSchema = z.object({
  originalId: z.string().uuid(),
  itemType: z.literal('book'),
  rackNumber: trimmedNonEmpty,
  rackRow: optionalTrimmed,
  crateColor: trimmedNonEmpty,
  crateNumber: trimmedNonEmpty,
  quantity: quantitySchema,
});

export const duplicateItemSchema = z.discriminatedUnion('itemType', [
  duplicateItemAsProductSchema,
  duplicateItemAsBookSchema,
]);

export type DuplicateItemInput = z.infer<typeof duplicateItemSchema>;
export type DuplicateItemProductInput = z.infer<typeof duplicateItemAsProductSchema>;
export type DuplicateItemBookInput = z.infer<typeof duplicateItemAsBookSchema>;
