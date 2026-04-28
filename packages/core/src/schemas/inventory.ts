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

export const createItemSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  sku: z.string().min(1).max(64).trim().optional(),
  barcode: z.string().max(128).trim().optional(),
  description: z.string().max(5000).optional(),
  categoryId: uuidSchema.nullable().optional(),
  supplierId: uuidSchema.nullable().optional(),
  primaryLocationId: uuidSchema.nullable().optional(),
  unitCost: numericMoney.default(0),
  retailPrice: numericMoney.default(0),
  quantityOnHand: numericQty.default(0),
  reorderPoint: numericQty.default(0),
  reorderQuantity: numericQty.default(0),
  unitOfMeasure: z.string().max(32).default('unit'),
  binLocation: z.string().max(64).optional(),
  customFields: z.record(z.string(), z.unknown()).default({}),
  status: itemStatusSchema.default('active'),
});
export type CreateItemInput = z.infer<typeof createItemSchema>;

export const updateItemSchema = createItemSchema.partial();
export type UpdateItemInput = z.infer<typeof updateItemSchema>;

export const adjustStockSchema = z.object({
  itemId: uuidSchema,
  quantityChange: z.coerce.number(),
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
