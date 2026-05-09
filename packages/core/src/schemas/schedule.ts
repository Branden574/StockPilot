import { z } from 'zod';

import { uuidSchema } from './common';

/**
 * Schedule event = a team-visible calendar entry. Used for jobs,
 * deliveries, donation drops, pickups, anything location/time scoped.
 *
 * Fields the user explicitly asked for: title, time, location,
 * requester, details. Plus warehouse pin for filtering and a status
 * enum so finished work can be marked done without losing history.
 */

export const scheduleStatusSchema = z.enum([
  'scheduled',
  'in_progress',
  'completed',
  'cancelled',
]);
export type ScheduleStatus = z.infer<typeof scheduleStatusSchema>;

const emptyToUndefined = (v: unknown) =>
  typeof v === 'string' && v.trim().length === 0 ? undefined : v;

// Base shape — no refines, so `.partial()` works directly off of it for
// the update schema. Both create + update apply the same refines on top.
const scheduleEventBaseSchema = z.object({
  title: z.string().min(1).max(200).trim(),
  /** ISO timestamp. The form sends "YYYY-MM-DDTHH:mm" which JS Date
   *  parses as local time then we serialize to UTC ISO. */
  startsAt: z.string().datetime({ offset: true }),
  /** Optional: open-ended events (all-day reminders, undefined-end
   *  jobs) leave this null. Must be ≥ startsAt when present. */
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  allDay: z.boolean().default(false),
  locationText: z.preprocess(
    emptyToUndefined,
    z.string().max(500).trim().optional(),
  ),
  warehouseId: uuidSchema.nullable().optional(),
  requesterName: z.preprocess(
    emptyToUndefined,
    z.string().max(200).trim().optional(),
  ),
  details: z.preprocess(
    emptyToUndefined,
    z.string().max(5000).trim().optional(),
  ),
  status: scheduleStatusSchema.default('scheduled'),
  /**
   * Optional bundle linkage. When all three are set, marking the
   * event 'completed' fires the bundle distribution automatically.
   * Either all three are non-null (linked) or all three are null
   * (no linkage) — DB CHECK enforces this too.
   */
  bundleId: uuidSchema.nullable().optional(),
  bundleQuantity: z.number().positive().max(1_000_000).nullable().optional(),
  bundleWarehouseId: uuidSchema.nullable().optional(),
});

const endAfterStart = {
  check: (v: { startsAt: string; endsAt?: string | null }) => {
    if (!v.endsAt) return true;
    return new Date(v.endsAt).getTime() >= new Date(v.startsAt).getTime();
  },
  msg: { message: 'End time must be on or after the start time', path: ['endsAt'] },
};
const bundleLinkageAllOrNone = {
  check: (v: {
    bundleId?: string | null;
    bundleQuantity?: number | null;
    bundleWarehouseId?: string | null;
  }) => {
    const linked = [v.bundleId, v.bundleQuantity, v.bundleWarehouseId];
    const set = linked.filter((x) => x !== null && x !== undefined);
    return set.length === 0 || set.length === 3;
  },
  msg: {
    message:
      'Bundle linkage requires bundleId + bundleQuantity + bundleWarehouseId together',
    path: ['bundleId'],
  },
};

export const createScheduleEventSchema = scheduleEventBaseSchema
  .refine(endAfterStart.check, endAfterStart.msg)
  .refine(bundleLinkageAllOrNone.check, bundleLinkageAllOrNone.msg);
export type CreateScheduleEventInput = z.infer<typeof createScheduleEventSchema>;

export const updateScheduleEventSchema = scheduleEventBaseSchema
  .partial()
  .refine(
    (v) => {
      if (v.startsAt === undefined || v.endsAt === undefined) return true;
      return endAfterStart.check({ startsAt: v.startsAt, endsAt: v.endsAt });
    },
    endAfterStart.msg,
  )
  .refine(bundleLinkageAllOrNone.check, bundleLinkageAllOrNone.msg);
export type UpdateScheduleEventInput = z.infer<typeof updateScheduleEventSchema>;
