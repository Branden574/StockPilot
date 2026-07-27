import { z } from 'zod';

import { TRACKING_TYPE_VALUES } from '../sports/tracking-modes';
import { uuidSchema } from './common';
import { createProductGroupSchema, trackingModeSchema, variantAttributesSchema } from './sports';

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

export const createItemSchema = z
  .object({
    name: z.string().min(1).max(200).trim(),
    sku: z.preprocess(emptyToUndefined, z.string().min(1).max(64).trim().nullable().optional()),
    barcode: z.preprocess(emptyToUndefined, z.string().max(128).trim().nullable().optional()),
    modelNumber: z.preprocess(
      emptyToUndefined,
      z.string().max(120).trim().nullable().optional(),
    ),
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
    /**
     * 'none' (default), 'lot', 'serial', or 'serial_optional'. Drives capture
     * requirements at receive time. 'serial_optional' (0295) accepts 0..qty
     * serials and never requires them — the Sports OPTIONAL_SERIALIZED mode.
     *
     * The values come from TRACKING_TYPE_VALUES (packages/core/src/sports/
     * tracking-modes.ts), which is the ONE vocabulary shared with
     * trackingTypeForMode(). Never re-list the literals here — a second list is
     * exactly how an enumerator drifts out of sync with the DB CHECK.
     */
    trackingType: z.enum(TRACKING_TYPE_VALUES).default('none'),
    /** Phase 5 (lot_serial module): per-item shelf life in days. */
    shelfLifeDays: z.preprocess(
      (v) => (v === '' || v === null ? null : v),
      z.coerce.number().int().positive().nullable().optional(),
    ),
    /**
     * Phase 5: near/expired lot behavior. 'block' rejects FEFO picks of expired
     * lots. Optional (NOT defaulted) so existing CreateItemInput construction
     * sites need no change; the default 'warn' is applied by InventoryService
     * (`input.expiryPolicy ?? 'warn'`) and the DB column default.
     */
    expiryPolicy: z.enum(['none', 'warn', 'block']).optional(),
    /** 'product' (default), 'book', 'asset', or 'consumable'. Drives which UI tab the row appears under. */
    itemType: z.enum(['product', 'book', 'asset', 'consumable']).default('product'),
    // Bounded to stop a writer from bloating the JSONB column (e.g. 1000 keys ×
    // multi-MB values): 64-char keys (matches isSnakeCaseKey), ≤50 keys, and no
    // single string value over 10k chars. Keys without an active field definition
    // are ignored by validateCustomFields, but the raw payload still lands in the
    // column, so the gate belongs here at the schema boundary.
    customFields: z
      .record(z.string().max(64), z.unknown())
      .refine((v) => Object.keys(v).length <= 50, 'Too many custom fields (max 50).')
      .refine(
        (v) => Object.values(v).every((x) => typeof x !== 'string' || x.length <= 10_000),
        'A custom field value is too long (max 10000 characters).',
      )
      .default({}),
    status: itemStatusSchema.default('active'),
    /**
     * When true, marks the item as a rental asset (canopy, equipment, etc.).
     * Rental items appear ONLY on /dashboard/rentals/items — they are hidden
     * from the regular inventory list and order picker. Default false.
     */
    isRental: z.boolean().optional(),
  })
  // Sports (Task 7): every variant field is optional, so no existing
  // CreateItemInput construction site needs to change. See variantAttributesSchema
  // in ./sports for the field-by-field contract shared with web, Expo and the
  // server's group/variant resolution (Tasks 8-19).
  .merge(variantAttributesSchema)
  .extend({
    /**
     * Sports only. When the chosen category resolves to a variant-shaped
     * tracking mode, the server may CREATE the group from these attributes if
     * `groupId` is absent. Never trusted for authorization — the org always
     * comes from the service context.
     */
    productGroup: createProductGroupSchema.optional(),
    /**
     * An authorized override of the category's default tracking mode. The
     * SERVER checks it against the subcategory profile's allowedModes and
     * against the `sports:manage` permission; the form is never trusted.
     */
    trackingModeOverride: trackingModeSchema.optional(),
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

/**
 * Remove (write off) a quantity of ONE item from ONE specific location — the
 * rack-scoped removal Andrew reached for when he tried to archive a
 * consolidated rack. A reason is MANDATORY and free-text (owner ask: review how
 * the reason is captured), trimmed and stored verbatim on the resulting
 * stock_movements row so the item history reads truthfully. The quantity is
 * capped at the holding server-side; the schema only enforces "positive and
 * sane" (the numeric(14,4) column bound mirrors adjustStock).
 */
export const removeStockFromLocationSchema = z.object({
  itemId: uuidSchema,
  locationId: uuidSchema,
  quantity: z.coerce.number().positive().finite().max(1_000_000),
  reason: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim() : v),
    z.string().min(1, 'A reason is required to remove stock.').max(500),
  ),
});
export type RemoveStockFromLocationInput = z.infer<typeof removeStockFromLocationSchema>;

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
