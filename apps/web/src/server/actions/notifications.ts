'use server';

import { revalidatePath } from 'next/cache';

import { ServiceError } from '@/server/services/context';
import { NotificationsService } from '@/server/services/notifications';

import { err, ok, type ActionResult } from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) return err(error.code, error.message);
  console.error(error);
  return err('internal_error', error instanceof Error ? error.message : 'Unknown error');
}

export async function markNotificationReadAction(id: string): Promise<ActionResult<void>> {
  try {
    const svc = await NotificationsService.forCurrentUser();
    await svc.markRead(id);
    revalidatePath('/dashboard/notifications');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function markAllNotificationsReadAction(): Promise<ActionResult<void>> {
  try {
    const svc = await NotificationsService.forCurrentUser();
    await svc.markAllRead();
    revalidatePath('/dashboard/notifications');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}
