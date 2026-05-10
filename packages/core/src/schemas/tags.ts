import { z } from 'zod';

import { uuidSchema } from './common';

/**
 * A hex color like #6366f1. Tags use the same format as categories so
 * downstream renderers can share swatch components.
 */
const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color like #6366f1');

export const createTagSchema = z.object({
  name: z.string().min(1).max(60).trim(),
  color: hexColor.nullable().optional(),
});
export type CreateTagInput = z.infer<typeof createTagSchema>;

export const updateTagSchema = createTagSchema.partial();
export type UpdateTagInput = z.infer<typeof updateTagSchema>;

export const setItemTagsSchema = z.object({
  itemId: uuidSchema,
  tagIds: z.array(uuidSchema).max(100),
});
export type SetItemTagsInput = z.infer<typeof setItemTagsSchema>;

export const bulkItemTagsSchema = z.object({
  itemIds: z.array(uuidSchema).min(1).max(500),
  tagIds: z.array(uuidSchema).min(1).max(100),
});
export type BulkItemTagsInput = z.infer<typeof bulkItemTagsSchema>;
