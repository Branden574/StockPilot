import { z } from 'zod';

import { uuidSchema } from './common';

export const itemStatusSchema = z.enum(['active', 'archived', 'discontinued']);
export type ItemStatus = z.infer<typeof itemStatusSchema>;

export const movementTypeSchema = z.enum([
  'add',
  'remove',
  'adjust',
  'transfer',
  'receive_po',
  'return',
  'damage',
  'loss',
  'correction',
  'initial',
]);
export type MovementType = z.infer<typeof movementTypeSchema>;

const numericMoney = z.coerce.number().nonnegative().max(1_000_000_000);
const numericQty = z.coerce.number().max(1_000_000_000);

/**
 * Form fields default to '' when untouched by the user. min(1) on an
 * optional string would reject those, when the actual intent of an
 * empty SKU/barcode field is "auto-generate / leave blank". Normalize
 * empty + whitespace-only strings to undefined BEFORE validation so
 * the optional() path handles them cleanly. Real values pass through.
 */
const emptyToUndefined = (v: unknown) =>
  typeof v === 'string' && v.trim().length === 0 ? undefined : v;

export const createItemSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  sku: z.preprocess(emptyToUndefined, z.string().min(1).max(64).trim().nullable().optional()),
  barcode: z.preprocess(emptyToUndefined, z.string().max(128).trim().nullable().optional()),
  description: z.string().max(5000).nullable().optional(),
  categoryId: uuidSchema.nullable().optional(),
  supplierId: uuidSchema.nullable().optional(),
  primaryLocationId: uuidSchema.nullable().optional(),
  warehouseId: uuidSchema.nullable().optional(),
  /** null/undefined = generic stock (any charter the warehouse services can use). */
  charterId: uuidSchema.nullable().optional(),
  unitCost: numericMoney.default(0),
  retailPrice: numericMoney.default(0),
  quantityOnHand: numericQty.default(0),
  reorderPoint: numericQty.default(0),
  reorderQuantity: numericQty.default(0),
  unitOfMeasure: z.string().max(32).default('unit'),
  binLocation: z.string().max(64).nullable().optional(),
  /** 'none' (default), 'lot', or 'serial'. Drives capture requirements at receive time. */
  trackingType: z.enum(['none', 'lot', 'serial']).default('none'),
  /** 'product' (default), 'book', 'asset', or 'consumable'. Drives which UI tab the row appears under. */
  itemType: z.enum(['product', 'book', 'asset', 'consumable']).default('product'),
  customFields: z.record(z.string(), z.unknown()).default({}),
  status: itemStatusSchema.default('active'),
});
export type CreateItemInput = z.infer<typeof createItemSchema>;

export const updateItemSchema = createItemSchema.partial();
export type UpdateItemInput = z.infer<typeof updateItemSchema>;

export const adjustStockSchema = z.object({
  itemId: uuidSchema,
  // Caps deliberately wide enough for realistic restocks (a pallet of
  // 50,000 books from a vendor) but tight enough that an attacker
  // can't pass Number.MAX_SAFE_INTEGER and either overflow the
  // numeric(14,4) column or push quantity_on_hand into nonsense
  // territory that downstream reports/aggregations choke on.
  quantityChange: z.coerce
    .number()
    .finite()
    .min(-1_000_000)
    .max(1_000_000),
  movementType: movementTypeSchema.default('adjust'),
  locationId: uuidSchema.nullable().optional(),
  reason: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
});
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;

export const transferStockSchema = z
  .object({
    itemId: uuidSchema,
    fromLocationId: uuidSchema,
    toLocationId: uuidSchema,
    quantity: z.coerce.number().positive(),
    notes: z.string().max(2000).optional(),
  })
  .refine((v) => v.fromLocationId !== v.toLocationId, {
    message: 'Source and destination must differ',
    path: ['toLocationId'],
  });
export type TransferStockInput = z.infer<typeof transferStockSchema>;

export const lookupByBarcodeSchema = z.object({
  barcode: z.string().min(1).max(128),
});
export type LookupByBarcodeInput = z.infer<typeof lookupByBarcodeSchema>;
