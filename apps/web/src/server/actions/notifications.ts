'use server';

import { revalidatePath } from 'next/cache';

import { rethrowControlFlow } from '@/lib/control-flow';
import { NotificationsService } from '@/server/services/notifications';
import { actionErrorResult } from '@/server/lib/action-error-result';

import { ok, type ActionResult } from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  rethrowControlFlow(error);
  return actionErrorResult(error, 'actions.notifications');
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
