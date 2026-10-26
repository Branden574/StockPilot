import { z } from 'zod';

import { uuidSchema } from './common';
import { hexColorSchema } from './hex-color';

/** A tag's colour is the same `#rrggbb` form as a category's (hex-color.ts). */
export const createTagSchema = z.object({
  name: z.string().min(1).max(60).trim(),
  color: hexColorSchema.nullable().optional(),
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
