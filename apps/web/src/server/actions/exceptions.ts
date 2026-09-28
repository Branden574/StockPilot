'use server';

import { revalidatePath } from 'next/cache';

import { can, RECOUNT_MAX_ITEMS, uuidSchema, type RecountUnavailableReason } from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';
import { fetchCountAssignees } from '@/server/lib/count-assignees';
import { ServiceError, withContext } from '@/server/services/context';
import { ExceptionEscalationService } from '@/server/services/exception-escalation';
import { ExceptionEvidenceService } from '@/server/services/exception-evidence';
import { ExceptionOccurrencesService } from '@/server/services/exception-occurrences';
import { ExceptionRecountService } from '@/server/services/exception-recount';
import type { ExceptionRecountResult } from '@/server/services/exception-recount';
import type { EscalationResult } from '@/server/services/exception-escalation';
import type {
  EvidenceUploadTicket,
  RecordedEvidence,
  RemovedEvidence,
} from '@/server/services/exception-evidence';

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
 *   - listItemsRecountTargetsAction: the same for several items, for the
 *     location page's "Recount items here" (F1-3).
 *   - escalateExceptionAction: "Escalate to maintenance" (F1-5), the same
 *     ExceptionEscalationService.escalate the phone reaches through
 *     POST /api/v1/exceptions/[id]/escalate. It saves one maintenance request
 *     linked to the occurrence; nothing is emailed (the request's review
 *     screen opens a draft only when the person taps it). An occurrence
 *     already escalated answers reason already_escalated with the linked
 *     request's id, which the form opens instead.
 *   - startExceptionEvidenceUploadAction, finalizeExceptionEvidenceAction,
 *     removeExceptionEvidenceAction: photo evidence (F1-4), the same
 *     ExceptionEvidenceService calls the phone reaches through
 *     /api/v1/exceptions/[id]/evidence. The browser PUTs the photo to the
 *     signed URL between the first two. Online only.
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

/**
 * Which open exceptions a recount of these items can settle, for the location
 * page's "Recount items here" (F1-3), so the count is linked to them the way
 * "Count this item" links an item's own. At most RECOUNT_MAX_ITEMS ids (a
 * recount's own cap). The open list is the Exception Center's own read
 * (ExceptionOccurrencesService.list, under the reader's RLS, with its
 * per-row canRecount), filtered to these items. `truncated`: the open list
 * stopped at its cap, so some exceptions may be left unlinked (the after-post
 * check still sees them).
 */
export async function listItemsRecountTargetsAction(itemIds: string[]): Promise<
  | {
      ok: true;
      canRecount: boolean;
      recountUnavailableReason: RecountUnavailableReason | null;
      occurrenceIds: string[];
      truncated: boolean;
    }
  | Failure
> {
  try {
    if (
      !Array.isArray(itemIds) ||
      itemIds.length === 0 ||
      itemIds.length > RECOUNT_MAX_ITEMS ||
      !itemIds.every((id) => uuidSchema.safeParse(id).success)
    ) {
      throw new ServiceError('validation_error', 'Those item ids are not valid.');
    }
    const wanted = new Set(itemIds.map((id) => id.toLowerCase()));
    const ctx = await withContext();
    const res = await new ExceptionOccurrencesService(ctx).list({ status: 'open' });
    return {
      ok: true,
      canRecount: res.canRecount,
      recountUnavailableReason: res.recountUnavailableReason,
      occurrenceIds: res.occurrences
        .filter((o) => o.canRecount && wanted.has(o.itemId.toLowerCase()))
        .map((o) => o.id),
      truncated: res.truncated,
    };
  } catch (e) {
    return fail(e, 'actions.exceptions.items_recount_targets');
  }
}

/** Starts a photo upload (F1-4): returns the signed URL the browser PUTs the
 *  photo to, and the path to finalize. */
export async function startExceptionEvidenceUploadAction(
  id: string,
  input: { fileExt: string },
): Promise<{ ok: true; ticket: EvidenceUploadTicket } | Failure> {
  try {
    if (!uuidSchema.safeParse(id).success) {
      throw new ServiceError('validation_error', 'That exception id is not valid.');
    }
    const ctx = await withContext();
    const ticket = await new ExceptionEvidenceService(ctx).createUploadUrl(id, {
      fileExt: typeof input?.fileExt === 'string' ? input.fileExt : '',
    });
    return { ok: true, ticket };
  } catch (e) {
    return fail(e, 'actions.exceptions.evidence_mint');
  }
}

/** Records an uploaded photo (F1-4): the server checks the bytes, removes the
 *  photo's metadata (location included) and records it. On a refusal nothing
 *  is recorded and the upload is deleted, except when the per-person finalize
 *  limit refused it (reason rate_limited: the same finalize can be sent
 *  again) or it is already recorded (reason already_recorded: success for
 *  the caller). The limit is ExceptionEvidenceService's, the same one the
 *  /api/v1 route applies. */
export async function finalizeExceptionEvidenceAction(
  id: string,
  input: { path: string; declaredMime: string; capturedAt?: string | null; note?: string | null },
): Promise<{ ok: true; evidence: RecordedEvidence } | Failure> {
  try {
    if (!uuidSchema.safeParse(id).success) {
      throw new ServiceError('validation_error', 'That exception id is not valid.');
    }
    const ctx = await withContext();
    const evidence = await new ExceptionEvidenceService(ctx).finalize(id, {
      path: typeof input?.path === 'string' ? input.path : '',
      declaredMime: typeof input?.declaredMime === 'string' ? input.declaredMime : '',
      capturedAt: typeof input?.capturedAt === 'string' ? input.capturedAt : null,
      note: typeof input?.note === 'string' ? input.note : null,
    });
    revalidatePath(`/dashboard/exceptions/${id}`);
    return { ok: true, evidence };
  } catch (e) {
    return fail(e, 'actions.exceptions.evidence_finalize');
  }
}

/** Removes a photo (F1-4): a soft remove that keeps the file and records who
 *  removed it and why. */
export async function removeExceptionEvidenceAction(
  id: string,
  evidenceId: string,
  reason?: string | null,
): Promise<{ ok: true; evidence: RemovedEvidence } | Failure> {
  try {
    if (!uuidSchema.safeParse(id).success || !uuidSchema.safeParse(evidenceId).success) {
      throw new ServiceError('validation_error', 'That photo id is not valid.');
    }
    const ctx = await withContext();
    const evidence = await new ExceptionEvidenceService(ctx).remove(
      id,
      evidenceId,
      typeof reason === 'string' ? reason : null,
    );
    revalidatePath(`/dashboard/exceptions/${id}`);
    return { ok: true, evidence };
  } catch (e) {
    return fail(e, 'actions.exceptions.evidence_remove');
  }
}

/**
 * "Escalate to maintenance" (F1-5). `values` is the request form's four
 * fields (subject, description, priority, category); any other key is
 * ignored, and the item and location come from the occurrence on the server.
 * Online only, never queued.
 *
 * A failure carries `reason` (already_escalated, escalation_in_progress,
 * occurrence_resolved, escalation_not_claimed, request_not_eligible, busy,
 * module_disabled; aal2_required from the MFA step-up), and for
 * already_escalated the linked
 * request's `requestId` and `reference`, so the form can open it.
 */
export async function escalateExceptionAction(
  id: string,
  values: unknown,
): Promise<
  | ({ ok: true } & EscalationResult)
  | { error: { message: string; reason: string | null; retryable?: boolean; requestId?: string; reference?: string | null } }
> {
  try {
    if (!uuidSchema.safeParse(id).success) {
      throw new ServiceError('validation_error', 'That exception id is not valid.');
    }
    const ctx = await withContext();
    const request = await new ExceptionEscalationService(ctx).escalate(id, values);
    revalidatePath('/dashboard/exceptions');
    revalidatePath(`/dashboard/exceptions/${id}`);
    revalidatePath('/dashboard/maintenance');
    return { ok: true, ...request };
  } catch (e) {
    const failure = fail(e, 'actions.exceptions.escalate');
    if (e instanceof ServiceError && e.code === 'module_disabled' && failure.error.reason === null) {
      failure.error.reason = 'module_disabled';
    }
    const details = e instanceof ServiceError && e.code !== 'internal_error' ? e.details : undefined;
    if (failure.error.reason === 'already_escalated' && typeof details?.requestId === 'string') {
      return {
        error: {
          ...failure.error,
          requestId: details.requestId,
          reference: typeof details.reference === 'string' ? details.reference : null,
        },
      };
    }
    return failure;
  }
}
