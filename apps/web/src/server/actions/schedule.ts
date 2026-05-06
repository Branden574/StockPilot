'use server';

import { revalidatePath } from 'next/cache';

import { ScheduleService } from '@/server/services/schedule';
import { ServiceError } from '@/server/services/context';

import {
  createScheduleEventSchema,
  updateScheduleEventSchema,
  err,
  ok,
  type ActionResult,
  type CreateScheduleEventInput,
  type UpdateScheduleEventInput,
} from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) return err(error.code, error.message);
  return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
}

export async function createScheduleEventAction(
  input: CreateScheduleEventInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = createScheduleEventSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await ScheduleService.forCurrentUser();
    const ev = await svc.create(parsed.data);
    revalidatePath('/dashboard/schedule');
    return ok({ id: ev.id });
  } catch (e) {
    return toResult(e);
  }
}

export async function updateScheduleEventAction(
  id: string,
  input: UpdateScheduleEventInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = updateScheduleEventSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    const svc = await ScheduleService.forCurrentUser();
    await svc.update(id, parsed.data);
    revalidatePath('/dashboard/schedule');
    revalidatePath(`/dashboard/schedule/${id}`);
    return ok({ id });
  } catch (e) {
    return toResult(e);
  }
}

export async function deleteScheduleEventAction(
  id: string,
): Promise<ActionResult<void>> {
  try {
    const svc = await ScheduleService.forCurrentUser();
    await svc.delete(id);
    revalidatePath('/dashboard/schedule');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}
