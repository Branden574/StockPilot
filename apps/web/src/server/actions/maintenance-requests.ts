'use server';

import { revalidatePath } from 'next/cache';

import { ServiceError, withContext } from '@/server/services/context';
import { MaintenanceRequestsService } from '@/server/services/maintenance-requests';

type ActionResult<T> = ({ ok: true } & T) | { error: { message: string } };

function fail(e: unknown): { error: { message: string } } {
  if (e instanceof ServiceError) return { error: { message: e.message } };
  return { error: { message: 'Something went wrong. Please try again.' } };
}

export async function createMaintenanceRequestAction(
  values: unknown,
): Promise<ActionResult<{ id: string; requestNumber: number; createdAt: string }>> {
  try {
    const ctx = await withContext();
    const res = await new MaintenanceRequestsService(ctx).create(values);
    revalidatePath('/dashboard/maintenance');
    return { ok: true, ...res };
  } catch (e) {
    return fail(e);
  }
}

export async function updateMaintenanceRequestAction(
  id: string,
  values: unknown,
): Promise<ActionResult<object>> {
  try {
    const ctx = await withContext();
    await new MaintenanceRequestsService(ctx).update(id, values);
    revalidatePath(`/dashboard/maintenance/${id}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function archiveMaintenanceRequestAction(id: string): Promise<ActionResult<object>> {
  try {
    const ctx = await withContext();
    await new MaintenanceRequestsService(ctx).archive(id);
    revalidatePath('/dashboard/maintenance');
    revalidatePath(`/dashboard/maintenance/${id}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function cancelMaintenanceRequestAction(id: string): Promise<ActionResult<object>> {
  try {
    const ctx = await withContext();
    await new MaintenanceRequestsService(ctx).cancel(id);
    revalidatePath('/dashboard/maintenance');
    revalidatePath(`/dashboard/maintenance/${id}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function assignMaintenanceOwnerAction(
  id: string,
  userId: string | null,
): Promise<ActionResult<object>> {
  try {
    const ctx = await withContext();
    await new MaintenanceRequestsService(ctx).assignLocalOwner(id, userId);
    revalidatePath(`/dashboard/maintenance/${id}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function addMaintenanceNoteAction(
  id: string,
  body: string,
): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await withContext();
    const res = await new MaintenanceRequestsService(ctx).addNote(id, body);
    revalidatePath(`/dashboard/maintenance/${id}`);
    return { ok: true, ...res };
  } catch (e) {
    return fail(e);
  }
}

/** Called AFTER window.open succeeds (R3 ordering — never before, so a
 *  popup-blocked draft is never mistakenly recorded as opened). Returns the
 *  new count so the duplicate-draft dialog can arm itself. */
export async function recordMaintenanceDraftOpenedAction(
  id: string,
): Promise<ActionResult<{ openCount: number }>> {
  try {
    const ctx = await withContext();
    const res = await new MaintenanceRequestsService(ctx).recordDraftOpened(id);
    return { ok: true, ...res };
  } catch (e) {
    return fail(e);
  }
}
