'use server';

import { revalidatePath } from 'next/cache';

import { uuidSchema } from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';
import { ServiceError, withContext } from '@/server/services/context';
import { ExceptionOccurrencesService } from '@/server/services/exception-occurrences';

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
 *
 * Only plain result objects cross this boundary. No type is re-exported from
 * here (recurring pattern #25: `export type { X }` in a 'use server' module
 * breaks the whole module under Turbopack); callers import service types
 * from the service.
 */

type Failure = { error: { message: string; reason: string | null } };

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
    return { error: { message: e.message, reason } };
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
