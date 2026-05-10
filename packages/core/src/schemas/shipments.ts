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
  // Destination is now a CHARTER (the receiving site/school), not a
  // warehouse. The source warehouse ships TO the charter; the charter
  // must be in `warehouse_charters` for the chosen source.
  destinationCharterId: uuidSchema,
  attentionToName: trimmedNullable,
  notes: z.string().max(2000).optional().nullable().transform((v) => v ?? null),
  ccEmails: ccEmailsSchema,
});
export type CreateShipmentFromOrderRequestInput = z.infer<
  typeof createShipmentFromOrderRequestSchema
>;

export const manualCreateShipmentSchema = z.object({
  sourceWarehouseId: uuidSchema,
  // Destination is a CHARTER (see note on createShipmentFromOrderRequest).
  destinationCharterId: uuidSchema,
  attentionToName: trimmedNullable,
  notes: z.string().max(2000).optional().nullable().transform((v) => v ?? null),
  ccEmails: ccEmailsSchema,
  lines: z.array(lineInputSchema).min(1, 'Add at least one line item'),
});
export type ManualCreateShipmentInput = z.infer<typeof manualCreateShipmentSchema>;

/**
 * Phase 2B — public signature submission.
 *
 * The signature token is a 48-character hex string (24 bytes — see
 * ShipmentsService.insertShipmentWithLines). We accept 32..96 hex chars to
 * leave room for a future change to the token width without breaking the
 * schema. The signatureDataUrl must look like a PNG data URL; we cap it
 * at ~1MB (1.3M chars after base64 inflation) so a malicious caller can't
 * post a multi-MB blob.
 */
export const submitShipmentSignatureSchema = z.object({
  token: z
    .string()
    .min(32)
    .max(96)
    .regex(/^[a-f0-9]+$/i, 'Invalid signature token'),
  signatureDataUrl: z
    .string()
    .min(64, 'Signature is empty')
    .max(1_400_000, 'Signature image is too large')
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, 'Signature must be a PNG image'),
  signedByName: z
    .string()
    .trim()
    .min(1, 'Please type your name')
    .max(120, 'Name is too long'),
  email: emailSchema,
  notes: z
    .string()
    .max(2000)
    .optional()
    .nullable()
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : null)),
});
export type SubmitShipmentSignatureInput = z.infer<
  typeof submitShipmentSignatureSchema
>;
