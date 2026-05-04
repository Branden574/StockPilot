import { z } from 'zod';

export const lotEntrySchema = z.object({
  lotNumber: z.string().min(1).max(120).trim(),
  expirationDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .optional()
    .nullable(),
  qtyBase: z.number().positive(),
});
export type LotEntry = z.infer<typeof lotEntrySchema>;

export const postReceiptLineSchema = z
  .object({
    poLineId: z.string().uuid(),
    qtyReceived: z.number().nonnegative(),
    qtyAccepted: z.number().nonnegative(),
    qtyRejected: z.number().nonnegative().default(0),
    unitCost: z.number().nonnegative().optional(),
    notes: z.string().max(2000).optional(),
    /** Required when item.tracking_type='lot' and qtyAccepted > 0. */
    lots: z.array(lotEntrySchema).optional(),
    /** Required when item.tracking_type='serial' and qtyAccepted > 0. One serial per accepted unit. */
    serials: z.array(z.string().min(1).max(120).trim()).optional(),
  })
  .refine(
    (v) => v.qtyAccepted + v.qtyRejected <= v.qtyReceived + 0.0001,
    { message: 'accepted + rejected cannot exceed received' },
  );
export type PostReceiptLineInput = z.infer<typeof postReceiptLineSchema>;

export const postReceiptSchema = z.object({
  purchaseOrderId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  lines: z.array(postReceiptLineSchema).min(1),
  notes: z.string().max(2000).optional(),
  /** Required from the client. UUID v4 generated once per receive form session. */
  idempotencyKey: z.string().uuid(),
});
export type PostReceiptInput = z.infer<typeof postReceiptSchema>;

export const reverseReceiptSchema = z.object({
  receiptId: z.string().uuid(),
  reason: z.string().min(3).max(500),
});
export type ReverseReceiptInput = z.infer<typeof reverseReceiptSchema>;
