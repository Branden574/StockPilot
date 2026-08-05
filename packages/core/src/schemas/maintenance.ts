import { z } from 'zod';

import { MAINTENANCE_PRIORITIES } from '../maintenance/constants';

/**
 * Shared by the web RHF form, the mobile form, and BOTH server create
 * paths (server action + /api/v1). The server is the authority — it
 * re-parses with this same schema and then snapshots requester identity
 * from the SESSION, never from these values.
 *
 * `.strict()` at every object depth (there is exactly one depth here — no
 * nested `z.object`) so an unrecognized key is a hard rejection, never
 * silently stripped. This is the whole reason a recipient-shaped key
 * (`to`, `cc`, `bcc`, `recipient(s)`, ...) can never reach the server
 * through this schema: there is no field for one to land in, and `.strict()`
 * refuses the payload outright instead of quietly dropping the extra key
 * (the export-builder program's tautology — Global Constraint 19/plan
 * lesson — was exactly this failure mode at a DIFFERENT object depth).
 * Recipients are compile-time constants (`L4L_MAINTENANCE_EMAIL`) read
 * server-side; they are never client input and must never become one.
 */
export const maintenanceRequestFormSchema = z
  .object({
    subject: z
      .string()
      .trim()
      .min(5, 'Describe the issue in a few words (at least 5 characters).')
      .max(120, 'Keep the subject under 120 characters.')
      .refine(
        (v) => /[\p{L}\p{N}]{3,}/u.test(v.replace(/\s/g, '')),
        'Add a few words describing the issue.',
      )
      .refine((v) => !/[\r\n]/.test(v), 'The subject cannot contain line breaks.'),
    description: z
      .string()
      .trim()
      .min(10, 'Explain what is happening so the maintenance team can prepare.')
      .max(5000, 'Keep the description under 5,000 characters.'),
    category: z.string().trim().max(80).nullish(),
    priority: z.enum(MAINTENANCE_PRIORITIES).default('normal'),
    charterId: z.string().uuid().nullish(),
    warehouseId: z.string().uuid().nullish(),
    building: z.string().trim().max(200).nullish(),
    roomOrArea: z.string().trim().max(200).nullish(),
    department: z.string().trim().max(200).nullish(),
    accessInstructions: z.string().trim().max(2000).nullish(),
    requesterPhone: z.string().trim().max(40).nullish(),
    relatedItemId: z.string().uuid().nullish(),
    relatedOrderRequestId: z.string().uuid().nullish(),
    relatedRentalId: z.string().uuid().nullish(),
    relatedLocationId: z.string().uuid().nullish(),
  })
  .strict();

export type MaintenanceRequestFormValues = z.infer<typeof maintenanceRequestFormSchema>;
