import { z } from 'zod';

import { uuidSchema, emailSchema } from './common';

/**
 * Phase 2A — print-and-paper-sign packing slip path. The signature_token
 * is generated server-side at create time but is not yet exercised by any
 * client; the public /s/[token] route + Resend integration are Phase 2B.
 */

const trimmedNullable = z
  .string()
  .max(200)
  .trim()
  .optional()
  .nullable()
  .transform((v) => (v && v.length > 0 ? v : null));

const ccEmailsSchema = z.array(emailSchema).max(20).optional();

const lineInputSchema = z.object({
  itemId: uuidSchema,
  qtyShipped: z.coerce.number().nonnegative().max(1_000_000),
  qtyBackOrdered: z.coerce.number().nonnegative().max(1_000_000).default(0),
});

export const createShipmentFromOrderRequestSchema = z.object({
  orderRequestId: uuidSchema,
  sourceWarehouseId: uuidSchema,
  attentionToName: trimmedNullable,
  notes: z.string().max(2000).optional().nullable().transform((v) => v ?? null),
  ccEmails: ccEmailsSchema,
});
export type CreateShipmentFromOrderRequestInput = z.infer<
  typeof createShipmentFromOrderRequestSchema
>;

export const manualCreateShipmentSchema = z.object({
  sourceWarehouseId: uuidSchema,
  destinationWarehouseId: uuidSchema,
  attentionToName: trimmedNullable,
  notes: z.string().max(2000).optional().nullable().transform((v) => v ?? null),
  ccEmails: ccEmailsSchema,
  lines: z.array(lineInputSchema).min(1, 'Add at least one line item'),
});
export type ManualCreateShipmentInput = z.infer<typeof manualCreateShipmentSchema>;
