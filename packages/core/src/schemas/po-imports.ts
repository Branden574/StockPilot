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
   * REQUIRED destination location within the warehouse the created PO
   * receives against. The server never auto-picks or auto-creates a
   * location — a missing/foreign id is rejected, not silently substituted.
   */
  locationId: z
    .string({ required_error: 'Pick a destination location for this warehouse.' })
    .uuid('Pick a destination location for this warehouse.'),
  /**
   * BILLING ONLY. The bill-to charter for the created PO — written to
   * purchase_orders.charter_id and read by exactly one consumer, the PO PDF's
   * "Bill to" block. It must NEVER influence operational placement: not the
   * receiving warehouse, not the destination location, not which charter owns
   * the stock, not list placement, not access. Verified against the org
   * server-side (a cross-tenant id is dropped, never substituted).
   */
  charterId: z.string().uuid().nullable().optional(),
  /**
   * OPERATIONAL. The item-OWNERSHIP charter — the same value passed to
   * createItemsFromPoLines. This is the ONLY input to approve() that may
   * affect inventory_items.charter_id.
   *
   * Tri-state on purpose (owner rule B3 — no silent fallback):
   *   • absent (undefined) → LEAVE EVERY ITEM'S OWNERSHIP EXACTLY AS IT IS.
   *     approve() skips re-chartering, sibling lookup, sibling creation and
   *     line remap entirely. This is also what an older mobile build sends,
   *     so shipping the server first is non-destructive.
   *   • null → an explicit choice: Generic (no charter).
   *   • uuid → an explicit choice of that charter.
   *
   * Deliberately has NO default derived from `charterId` — deriving one would
   * reintroduce exactly the billing→placement conflation this field exists to
   * end.
   */
  itemCharterId: z.string().uuid().nullable().optional(),
  /**
   * Optional expected delivery date for the created PO (ISO datetime). Prefilled
   * from the AI-extracted ship/delivery date when present; user can override.
   */
  expectedAt: z.string().datetime().nullable().optional(),
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
