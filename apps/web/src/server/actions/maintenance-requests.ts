'use server';

import { revalidatePath } from 'next/cache';

import { uuidSchema } from '@stockpilot/core';

import { ServiceError, withContext } from '@/server/services/context';
import { MaintenanceRequestsService } from '@/server/services/maintenance-requests';

type ActionResult<T> = ({ ok: true } & T) | { error: { message: string } };

function fail(e: unknown): { error: { message: string } } {
  if (e instanceof ServiceError) return { error: { message: e.message } };
  return { error: { message: 'Something went wrong. Please try again.' } };
}

/**
 * M6: every action below takes an `id` straight off a URL segment or a
 * client call — untyped, un-narrowed. Without this, a malformed value (a
 * truncated paste, a hand-edited URL) reaches `.eq('id', id)` in the
 * service and comes back from Postgres as an opaque 22P02 internal_error
 * instead of a clear, actionable validation_error. Checked at THIS
 * boundary (not inside the service) because the service's own test suite
 * exercises every method with short mock ids ('r1', 'note1', ...) that
 * are valid stand-ins for a row id but not valid UUIDs — pushing the
 * check into the service would mean rewriting that entire fixture set for
 * a concern that only ever originates here, at the untrusted edge.
 */
function assertValidId(id: string): void {
  if (!uuidSchema.safeParse(id).success) {
    throw new ServiceError('validation_error', 'That request id is not valid.');
  }
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
    assertValidId(id);
    const ctx = await withContext();
    await new MaintenanceRequestsService(ctx).update(id, values);
    // M8: the list view (status/subject columns) can go stale after an
    // edit too, not just the detail page — every other mutating action in
    // this file already revalidates both paths.
    revalidatePath('/dashboard/maintenance');
    revalidatePath(`/dashboard/maintenance/${id}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function archiveMaintenanceRequestAction(id: string): Promise<ActionResult<object>> {
  try {
    assertValidId(id);
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
    assertValidId(id);
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
    assertValidId(id);
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
    assertValidId(id);
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
    assertValidId(id);
    const ctx = await withContext();
    const res = await new MaintenanceRequestsService(ctx).recordDraftOpened(id);
    return { ok: true, ...res };
  } catch (e) {
    return fail(e);
  }
}
