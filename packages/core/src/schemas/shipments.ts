import { z } from 'zod';

import { emailSchema } from './common';

/**
 * Public signature submission for the historical /s/[token] route.
 *
 * The shipments workflow is deprecated (orders workflow replaces it),
 * but the public signature page must keep accepting submissions on
 * already-issued tokens — warehouses may have paper packing slips in
 * the field with QR codes pointing here. The create / manual-create /
 * mark-shipped / mark-cancelled / mark-delivered action schemas were
 * removed alongside the orphaned components that called them.
 *
 * The signature token is a 48-character hex string (24 bytes — see
 * ShipmentsService.insertShipmentWithLines). F10: min is 48 (down from
 * 32) so the schema matches the generator exactly; 96 max leaves room
 * to widen the generator later without a coordinated schema rollout.
 * The signatureDataUrl must look like a PNG data URL; we cap it at
 * ~1MB (1.3M chars after base64 inflation) so a malicious caller
 * can't post a multi-MB blob.
 */
export const submitShipmentSignatureSchema = z.object({
  token: z
    .string()
    .min(48)
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
