import { z } from 'zod';

export const poImportLineTypeSchema = z.enum([
  'inventory',
  'tax',
  'freight',
  'service',
  'fee',
  'discount',
  'unknown',
]);
export type PoImportLineType = z.infer<typeof poImportLineTypeSchema>;

export const poImportMatchStatusSchema = z.enum([
  'exact_match',
  'mapped',
  'suggested',
  'needs_review',
  'rejected',
  'non_inventory',
]);
export type PoImportMatchStatus = z.infer<typeof poImportMatchStatusSchema>;

export const poImportStatusSchema = z.enum([
  'uploaded',
  'parsing',
  'parsed',
  'needs_review',
  'approved',
  'failed',
  'duplicate',
  'canceled',
]);
export type PoImportStatus = z.infer<typeof poImportStatusSchema>;

/**
 * Canonical parsed-line shape produced by the parser; mirrors the
 * po_import_lines columns. Numbers are JS-side numbers; nulls are the
 * canonical "missing" value.
 */
export const canonicalPoLineSchema = z.object({
  lineNumber: z.number().int().positive(),
  lineType: poImportLineTypeSchema,
  qtyOrderedOriginal: z.number().nonnegative().nullable(),
  uomOriginal: z.string().max(16).nullable(),
  description: z.string().max(500).nullable(),
  unitCost: z.number().nonnegative().nullable(),
  lineTotal: z.number().nullable(),
  vendorItemNumber: z.string().max(64).nullable(),
  vendorProductNumber: z.string().max(64).nullable(),
  auxiliaryNumber: z.string().max(64).nullable(),
  coaCode: z.string().max(32).nullable(),
});
export type CanonicalPoLine = z.infer<typeof canonicalPoLineSchema>;

export const canonicalPoSchema = z.object({
  poNumber: z.string().max(64).nullable(),
  vendorName: z.string().max(255).nullable(),
  poDate: z.string().max(32).nullable(),
  description: z.string().max(500).nullable(),
  preparedBy: z.string().max(120).nullable(),
  workflow: z.string().max(120).nullable(),
  reason: z.string().max(500).nullable(),
  comments: z.string().max(2000).nullable(),
  shippingAddress: z.string().max(500).nullable(),
  contactName: z.string().max(120).nullable(),
  contactPhone: z.string().max(40).nullable(),
  totalAmount: z.number().nullable(),
  lines: z.array(canonicalPoLineSchema),
});
export type CanonicalPo = z.infer<typeof canonicalPoSchema>;

export const upsertVendorItemMappingSchema = z.object({
  vendorId: z.string().uuid(),
  itemId: z.string().uuid(),
  vendorItemNumber: z.string().max(64).optional().nullable(),
  vendorProductNumber: z.string().max(64).optional().nullable(),
  auxiliaryNumber: z.string().max(64).optional().nullable(),
  vendorDescription: z.string().max(500).optional().nullable(),
  vendorUom: z.string().max(16).optional().nullable(),
  packQty: z.number().nonnegative().optional().nullable(),
  conversionFactor: z.number().nonnegative().optional().nullable(),
});
export type UpsertVendorItemMappingInput = z.infer<typeof upsertVendorItemMappingSchema>;

export const approvePoImportSchema = z.object({
  poImportId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  vendorId: z.string().uuid(),
  /**
   * Optional specific destination location within the warehouse. When set, the
   * created PO receives against it; otherwise a location in the warehouse is
   * auto-resolved.
   */
  locationId: z.string().uuid().nullable().optional(),
  /** Per-line overrides; caller can change line item / classification before approval. */
  lineOverrides: z
    .array(
      z.object({
        lineId: z.string().uuid(),
        itemId: z.string().uuid().nullable().optional(),
        lineType: poImportLineTypeSchema.optional(),
        skip: z.boolean().optional(),
      }),
    )
    .default([]),
});
export type ApprovePoImportInput = z.infer<typeof approvePoImportSchema>;
