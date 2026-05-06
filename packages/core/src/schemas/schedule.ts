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

export const createScheduleEventSchema = z
  .object({
    title: z.string().min(1).max(200).trim(),
    /** ISO timestamp. The form sends "YYYY-MM-DDTHH:mm" which JS Date
     *  parses as local time then we serialize to UTC ISO. */
    startsAt: z.string().datetime({ offset: true }),
    /** Optional: open-ended events (all-day reminders, undefined-end
     *  jobs) leave this null. Must be ≥ startsAt when present. */
    endsAt: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .optional(),
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
  })
  .refine(
    (v) => {
      if (!v.endsAt) return true;
      return new Date(v.endsAt).getTime() >= new Date(v.startsAt).getTime();
    },
    { message: 'End time must be on or after the start time', path: ['endsAt'] },
  );
export type CreateScheduleEventInput = z.infer<typeof createScheduleEventSchema>;

export const updateScheduleEventSchema = createScheduleEventSchema.innerType().partial();
export type UpdateScheduleEventInput = z.infer<typeof updateScheduleEventSchema>;
