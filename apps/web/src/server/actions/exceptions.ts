'use server';

import { revalidatePath } from 'next/cache';

import { can, uuidSchema, type RecountUnavailableReason } from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';
import { fetchCountAssignees } from '@/server/lib/count-assignees';
import { ServiceError, withContext } from '@/server/services/context';
import { ExceptionOccurrencesService } from '@/server/services/exception-occurrences';
import { ExceptionRecountService } from '@/server/services/exception-recount';
import type { ExceptionRecountResult } from '@/server/services/exception-recount';

/**
 * Server actions for the Exception Center (F1-1). Thin wrappers over
 * ExceptionOccurrencesService, the same methods the /api/v1/exceptions routes
 * call for the phone, so the web and the phone apply one set of rules.
 *
 *   - actOnExceptionAction: acknowledge an occurrence, or add a note. Nobody
 *     can resolve one; the system does that when a check no longer finds the
 *     condition. exception_occurrence_act re-checks the caller either way.
 *   - requestExceptionCheckAction: a manager's "Check now". It SCHEDULES a
 *     sync to run after the response and returns at once (owner decision F1
 *     Q9: nothing a person does waits for a sync).
 *   - startRecountAction: a manager's targeted recount (F1-2), the same
 *     ExceptionRecountService.start the phone reaches through
 *     POST /api/v1/exceptions/recount. The dialog mints `idempotencyKey` once
 *     and resends it on a retry, so a double tap starts one count.
 *   - listCountAssigneesAction: the recount dialog's "Assign to" list, loaded
 *     when the dialog opens (count-assignees.ts, the member source the count
 *     screens use), so no page pays for it on load.
 *   - listItemRecountTargetsAction: the item page's "Count this item" asks
 *     which of the item's open exceptions a recount can settle, so the count
 *     is linked to them (the database links only the exceptions it is named).
 *
 * Only plain result objects cross this boundary. No type is re-exported from
 * here (recurring pattern #25: `export type { X }` in a 'use server' module
 * breaks the whole module under Turbopack); callers import service types
 * from the service.
 */

/** `retryable`: nothing was saved and sending the same request again (with
 *  the same idempotency key) is safe. */
type Failure = { error: { message: string; reason: string | null; retryable?: boolean } };

function fail(e: unknown, tag: string): Failure {
  if (!(e instanceof ServiceError) || e.code === 'internal_error') {
    // A bug or a database failure: reported, and answered generically (the
    // /api/v1/exceptions routes report the same way).
    void reportError(e, { tag });
  }
  if (e instanceof ServiceError) {
    // Only app-authored reasons are forwarded (never an internal_error's raw
    // database text).
    const details = e.code !== 'internal_error' ? e.details : undefined;
    const reason =
      details && typeof details === 'object' && typeof (details as { reason?: unknown }).reason === 'string'
        ? (details as { reason: string }).reason
        : null;
    if (e.code === 'internal_error') {
      return { error: { message: 'Something went wrong. Please try again.', reason: null } };
    }
    const retryable =
      details && typeof details === 'object' && (details as { retryable?: unknown }).retryable === true;
    return { error: { message: e.message, reason, ...(retryable ? { retryable: true } : {}) } };
  }
  return { error: { message: 'Something went wrong. Please try again.', reason: null } };
}

export async function actOnExceptionAction(
  id: string,
  input: { action: 'acknowledge' | 'note'; note?: string | null; clientEventId?: string | null },
): Promise<{ ok: true } | Failure> {
  try {
    if (!uuidSchema.safeParse(id).success) {
      throw new ServiceError('validation_error', 'That exception id is not valid.');
    }
    const ctx = await withContext();
    await new ExceptionOccurrencesService(ctx).act(id, {
      action: input.action,
      note: input.note ?? null,
      clientEventId: input.clientEventId ?? null,
    });
    revalidatePath('/dashboard/exceptions');
    revalidatePath(`/dashboard/exceptions/${id}`);
    return { ok: true };
  } catch (e) {
    return fail(e, 'actions.exceptions.act');
  }
}

export async function requestExceptionCheckAction(): Promise<
  { ok: true; scheduled: boolean; retryAfterSeconds: number; lastSyncedAt: string | null } | Failure
> {
  try {
    const ctx = await withContext();
    const res = await new ExceptionOccurrencesService(ctx).requestCheck();
    return { ok: true, ...res };
  } catch (e) {
    return fail(e, 'actions.exceptions.check_now');
  }
}

export async function startRecountAction(input: {
  occurrenceIds?: string[] | null;
  itemIds?: string[] | null;
  assignedTo?: string | null;
  idempotencyKey?: string | null;
}): Promise<{ ok: true; result: ExceptionRecountResult } | Failure> {
  try {
    const ctx = await withContext();
    const result = await new ExceptionRecountService(ctx).start({
      occurrenceIds: Array.isArray(input?.occurrenceIds) ? input.occurrenceIds : null,
      itemIds: Array.isArray(input?.itemIds) ? input.itemIds : null,
      assignedTo: typeof input?.assignedTo === 'string' ? input.assignedTo : null,
      idempotencyKey: typeof input?.idempotencyKey === 'string' ? input.idempotencyKey : null,
    });
    revalidatePath('/dashboard/exceptions');
    revalidatePath('/dashboard/cycle-counts');
    return { ok: true, result };
  } catch (e) {
    return fail(e, 'actions.exceptions.recount');
  }
}

export async function listCountAssigneesAction(): Promise<
  { ok: true; members: Array<{ id: string; name: string }> } | Failure
> {
  try {
    const ctx = await withContext();
    // The same permission every count assignee picker is shown behind.
    if (!can(ctx, 'cycle_counts:assign')) {
      throw new ServiceError('forbidden', 'Only a manager can assign counts.');
    }
    const members = await fetchCountAssignees(ctx.supabase, ctx.organizationId);
    // Names only: the dialog shows nothing else.
    return { ok: true, members: members.map((m) => ({ id: m.id, name: m.name })) };
  } catch (e) {
    return fail(e, 'actions.exceptions.count_assignees');
  }
}

export async function listItemRecountTargetsAction(
  itemId: string,
): Promise<
  | {
      ok: true;
      canRecount: boolean;
      recountUnavailableReason: RecountUnavailableReason | null;
      occurrenceIds: string[];
    }
  | Failure
> {
  try {
    if (!uuidSchema.safeParse(itemId).success) {
      throw new ServiceError('validation_error', 'That item id is not valid.');
    }
    const ctx = await withContext();
    const res = await new ExceptionOccurrencesService(ctx).list({ status: 'open', itemId });
    return {
      ok: true,
      canRecount: res.canRecount,
      recountUnavailableReason: res.recountUnavailableReason,
      occurrenceIds: res.occurrences.filter((o) => o.canRecount).map((o) => o.id),
    };
  } catch (e) {
    return fail(e, 'actions.exceptions.item_recount_targets');
  }
}
