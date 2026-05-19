import { z } from 'zod';

const trimmed = (max: number) => z.string().trim().min(1).max(max);
const quantity = z.coerce.number().positive().max(10_000);

export const createRentalSchema = z.object({
  warehouseId: z.string().uuid(),
  /**
   * When the borrower is a team member, pass their user_profile id.
   * Service auto-fills borrowerName from the member's display name.
   * When the borrower isn't in the system (vendor, parent, etc.),
   * leave this null and the caller-supplied borrowerName is used
   * as-is.
   */
  borrowerUserId: z.string().uuid().nullable().optional(),
  borrowerName: trimmed(120),
  borrowerEmail: z.string().trim().email().max(254).nullable().optional(),
  /** ISO timestamp; must be in the future (validated at the service). */
  expectedReturnAt: z.string().datetime(),
  notes: z.string().max(2000).nullable().optional(),
  lines: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        quantity,
        notes: z.string().max(500).nullable().optional(),
      }),
    )
    .min(1, 'Add at least one item.')
    .max(100, 'Too many items in one rental.'),
});

export const markReturnedSchema = z.object({
  id: z.string().uuid(),
  returnNotes: z.string().max(2000).nullable().optional(),
});

export const cancelRentalSchema = z.object({
  id: z.string().uuid(),
  reason: trimmed(500),
});

export type CreateRentalInput = z.infer<typeof createRentalSchema>;
export type MarkReturnedInput = z.infer<typeof markReturnedSchema>;
export type CancelRentalInput = z.infer<typeof cancelRentalSchema>;
