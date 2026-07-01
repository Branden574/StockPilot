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

export const updateProcedureSchema = createProcedureSchema.partial().extend({
  /**
   * ISO timestamp of the row's `updated_at` at the time the form was loaded.
   * When present, the update is guarded by `eq('updated_at', ifMatch)` —
   * a concurrent edit by another manager invalidates the match and the
   * service throws `conflict` instead of silently clobbering their work.
   * Omit for create-mode-style writes where the caller doesn't have a
   * baseline timestamp.
   */
  // `offset: true` allows the `+00:00` timezone offset format that
  // Supabase/PostgREST serializes timestamptz columns as. Default
  // `z.string().datetime()` requires a trailing `Z` and rejects
  // `2026-05-22T10:43:00.123456+00:00` → surfaced as "Invalid
  // datetime" on every procedure save.
  ifMatch: z.string().datetime({ offset: true }).optional(),
});
export type UpdateProcedureInput = z.infer<typeof updateProcedureSchema>;

// ---------------------------------------------------------------------------
// procedure_videos — N per procedure, stored in Supabase storage
// ---------------------------------------------------------------------------

// 1 GB matches the storage bucket's `file_size_limit` from migration
// 0187 (raised from the original 500 MB in 0053). Pinning this field to
// the bucket cap stops a hostile caller from recording a row claiming an
// absurd `size_bytes` even though the actual upload would have been
// rejected by storage. Keep the two layers in agreement.
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;

export const recordProcedureVideoSchema = z.object({
  procedureId: uuidSchema,
  storagePath: z.string().min(1).max(1024),
  /** Poster frame captured client-side at upload (JPEG in the same bucket,
   *  `{org}/{procedure}/{uuid}.poster.jpg`). Optional — capture is
   *  best-effort; the grid falls back to the video-first-frame trick. */
  thumbnailPath: z.string().min(1).max(1024).nullable().optional(),
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
