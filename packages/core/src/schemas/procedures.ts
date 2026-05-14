import { z } from 'zod';

import { uuidSchema } from './common';

/** Hex color like #6366f1. Shared with tags/categories swatch renderers. */
const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color like #6366f1');

// ---------------------------------------------------------------------------
// procedure_categories — picklist (Plumbing / Lighting / HVAC / …)
// ---------------------------------------------------------------------------

export const createProcedureCategorySchema = z.object({
  name: z.string().trim().min(1).max(80),
  color: hexColor.nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});
export type CreateProcedureCategoryInput = z.infer<typeof createProcedureCategorySchema>;

export const updateProcedureCategorySchema = createProcedureCategorySchema.partial();
export type UpdateProcedureCategoryInput = z.infer<typeof updateProcedureCategorySchema>;

// ---------------------------------------------------------------------------
// procedures — the SOP record itself
// ---------------------------------------------------------------------------

export const createProcedureSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  body: z.string().max(50_000).nullable().optional(),
  categoryId: uuidSchema.nullable().optional(),
  authoringWarehouseId: uuidSchema.nullable().optional(),
});
export type CreateProcedureInput = z.infer<typeof createProcedureSchema>;

export const updateProcedureSchema = createProcedureSchema.partial();
export type UpdateProcedureInput = z.infer<typeof updateProcedureSchema>;

// ---------------------------------------------------------------------------
// procedure_videos — N per procedure, stored in Supabase storage
// ---------------------------------------------------------------------------

// 500 MB matches the storage bucket's `file_size_limit` from migration
// 0053. The previous 2 GB ceiling on this field meant a hostile caller
// could record a row claiming an absurd `size_bytes` even though the
// actual upload would have been rejected by storage RLS. Hard-pin to
// the bucket cap so the two layers agree.
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

export const recordProcedureVideoSchema = z.object({
  procedureId: uuidSchema,
  storagePath: z.string().min(1).max(1024),
  title: z.string().trim().max(200).nullable().optional(),
  durationSeconds: z.number().int().min(0).max(86_400).nullable().optional(),
  sizeBytes: z.number().int().min(0).max(MAX_VIDEO_BYTES).nullable().optional(),
  mimeType: z.string().max(100).nullable().optional(),
  orderIdx: z.number().int().min(0).max(9999).optional(),
});
export type RecordProcedureVideoInput = z.infer<typeof recordProcedureVideoSchema>;

// ---------------------------------------------------------------------------
// procedure_comments — single-level threaded discussion under each SOP
// ---------------------------------------------------------------------------

export const createProcedureCommentSchema = z.object({
  procedureId: uuidSchema,
  body: z.string().trim().min(1).max(5000),
  parentId: uuidSchema.nullable().optional(),
});
export type CreateProcedureCommentInput = z.infer<typeof createProcedureCommentSchema>;

export const updateProcedureCommentSchema = z.object({
  body: z.string().trim().min(1).max(5000),
});
export type UpdateProcedureCommentInput = z.infer<typeof updateProcedureCommentSchema>;
