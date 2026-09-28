import 'server-only';

import {
  ESCALATE_MODULE_OFF_COPY,
  ESCALATE_NOT_PERMITTED_COPY,
  ESCALATE_RESOLVED_COPY,
  ESCALATION_IN_PROGRESS_COPY,
  ESCALATION_NOT_LINKED_COPY,
  escalationDuplicateCopy,
  formatMaintenanceRequestNumber,
  maintenanceRequestFormSchema,
  type EscalateUnavailableReason,
} from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';

import {
  assertModuleEnabled,
  assertPermission,
  ServiceError,
  type ServiceContext,
} from './context';
import { MaintenanceRequestsService } from './maintenance-requests';
import { postgrestErrorText } from './lib/postgrest-error';

/**
 * ESCALATE AN EXCEPTION TO MAINTENANCE (F1-5, migration 0376; Outlook rule 3).
 *
 * A person taps "Escalate to maintenance" on an open occurrence. This saves
 * ONE ordinary maintenance request and links it to the occurrence:
 *
 *   1. the floors: the maintenance_requests module, maintenance_requests:submit
 *      and items:read (the database re-checks the first two, and visibility);
 *   2. the occurrence, read through the caller's own client (RLS decides
 *      whether they can see it): its item and location come from HERE, never
 *      from the request body, whatever ids the client sent;
 *   3. exception_escalation_claim: a request that is not cancelled is already
 *      linked -> 409 with its id and number (the client opens it); someone is
 *      escalating right now -> 409 escalation_in_progress;
 *   4. MaintenanceRequestsService.create(): the SAME path the request form
 *      uses, so it validates, rate-limits, audits and notifies exactly as a
 *      request made from its own form does, and nothing more;
 *   5. exception_escalation_finish: link, copy the number, write the
 *      escalated event;
 *   6. on any failure after the claim: release the claim, and cancel the
 *      request as its requester if it was created but not linked. A link
 *      that landed although its answer was lost is detected by re-reading
 *      the occurrence, and is a success, never cancelled.
 *
 * NOTHING IS SENT. The review screen's Outlook, mailto or copy handoff opens
 * only when the person taps it there. Escalating neither acknowledges nor
 * resolves the occurrence. Online only: there is no queued escalation, so an
 * offline replay can never create a request or open a composer.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The request the escalation saved (or found already linked). */
export interface EscalationResult {
  id: string;
  requestNumber: number;
  /** "MR-2026-000014". */
  reference: string | null;
  createdAt: string;
}

/** The four fields a person fills in. Everything else in a body is ignored. */
export interface EscalationFields {
  subject: unknown;
  description: unknown;
  priority?: unknown;
  category?: unknown;
}

/**
 * The app gate, before any database round trip (pattern #4: it mirrors
 * _exc_escalation_refusal, which claim and finish re-check).
 */
export function assertEscalateFloors(ctx: ServiceContext): void {
  assertModuleEnabled(ctx, 'maintenance_requests');
  assertPermission(ctx, 'maintenance_requests:submit');
  assertPermission(ctx, 'items:read');
}

/** Why this reader may not escalate, or null when they may: the floors as a
 *  reason, for the occurrence read's hint. */
export function escalateBlock(ctx: ServiceContext): EscalateUnavailableReason | null {
  try {
    assertEscalateFloors(ctx);
    return null;
  } catch (e) {
    return e instanceof ServiceError && e.code === 'module_disabled' ? 'module_disabled' : 'not_permitted';
  }
}

type OccurrenceLinkRow = {
  id: string;
  item_id: string;
  location_id: string | null;
  resolved_at: string | null;
  maintenance_request_id: string | null;
  escalation_number: number | string | null;
  escalation_request_created_at: string | null;
};

type RpcAnswer = { state?: unknown; id?: unknown; number?: unknown; createdAt?: unknown } | null;

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function linkedResult(answer: RpcAnswer): EscalationResult | null {
  if (!answer || answer.state !== 'linked' || typeof answer.id !== 'string') return null;
  const requestNumber = toNumber(answer.number);
  const createdAt = typeof answer.createdAt === 'string' ? answer.createdAt : null;
  if (requestNumber === null || createdAt === null) return null;
  return {
    id: answer.id,
    requestNumber,
    reference: formatMaintenanceRequestNumber(requestNumber, createdAt),
    createdAt,
  };
}

/** The 409 for an occurrence already escalated to a request that is not
 *  cancelled: its id and number ride in `details`, so the client opens it. */
function duplicateError(linked: EscalationResult): ServiceError {
  return new ServiceError('conflict', escalationDuplicateCopy(linked.reference), {
    reason: 'already_escalated',
    requestId: linked.id,
    requestNumber: linked.requestNumber,
    reference: linked.reference,
  });
}

/** claim/finish refusals, by SQLSTATE and hint (never by message text;
 *  pattern #28). */
function mapEscalationError(error: { code?: string; message: string; hint?: string | null }): ServiceError {
  switch (error.code) {
    case '42501':
      if (error.hint === 'module_disabled') {
        return new ServiceError('module_disabled', ESCALATE_MODULE_OFF_COPY, { reason: 'module_disabled' });
      }
      return new ServiceError('forbidden', ESCALATE_NOT_PERMITTED_COPY, { reason: 'not_permitted' });
    case 'P0002':
      return new ServiceError('not_found', 'Exception not found.');
    case 'P0001':
      switch (error.hint) {
        case 'occurrence_resolved':
          return new ServiceError('conflict', ESCALATE_RESOLVED_COPY, { reason: 'occurrence_resolved' });
        case 'escalation_in_progress':
          return new ServiceError('conflict', ESCALATION_IN_PROGRESS_COPY, {
            reason: 'escalation_in_progress',
            retryable: true,
          });
        case 'escalation_not_claimed':
        case 'request_not_eligible':
        case 'already_escalated':
          return new ServiceError('conflict', ESCALATION_NOT_LINKED_COPY, { reason: error.hint });
      }
      break;
    case '55P03':
      // lock_timeout: a sync or another escalation held the row past 5 s.
      return new ServiceError('conflict', 'This exception is busy. Try again in a moment.', {
        reason: 'busy',
        retryable: true,
      });
    case '22023':
      return new ServiceError('validation_error', 'That exception id is not valid.', { reason: 'bad_argument' });
  }
  return new ServiceError('internal_error', postgrestErrorText(error));
}

export class ExceptionEscalationService {
  constructor(private readonly ctx: ServiceContext) {}

  /**
   * Escalate one occurrence. Returns the request that was saved and linked.
   * Throws ServiceError: module_disabled, forbidden, not_found,
   * validation_error (the request form's own rules), or conflict with
   * `details.reason` already_escalated (+ requestId, requestNumber,
   * reference), escalation_in_progress, occurrence_resolved,
   * escalation_not_claimed, request_not_eligible or busy.
   */
  async escalate(occurrenceId: string, body: unknown): Promise<EscalationResult> {
    assertEscalateFloors(this.ctx);
    if (!UUID.test(occurrenceId)) throw new ServiceError('not_found', 'Exception not found.');
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new ServiceError('validation_error', 'Add a subject and a description.');
    }
    // Only the four fields a person fills in. An item, location, warehouse or
    // site id in the body is ignored: the item and location come from the
    // occurrence below, and create() re-derives each against this org.
    const b = body as Record<string, unknown>;
    const fields: EscalationFields = {
      subject: b.subject,
      description: b.description,
      ...(b.priority !== undefined ? { priority: b.priority } : {}),
      ...(b.category !== undefined ? { category: b.category } : {}),
    };

    // The request form's own rules, before the claim, so a subject that is
    // too short never holds the occurrence. create() parses again.
    const parsed = maintenanceRequestFormSchema.safeParse(fields);
    if (!parsed.success) {
      throw new ServiceError('validation_error', parsed.error.issues[0]?.message ?? 'Please check the form.');
    }

    const occurrence = await this.readOccurrence(occurrenceId);
    if (!occurrence) throw new ServiceError('not_found', 'Exception not found.');
    if (occurrence.resolved_at !== null) {
      throw new ServiceError('conflict', ESCALATE_RESOLVED_COPY, { reason: 'occurrence_resolved' });
    }

    const claim = await this.ctx.supabase.rpc('exception_escalation_claim', { p_id: occurrenceId });
    if (claim.error) throw mapEscalationError(claim.error);
    const claimAnswer = claim.data as RpcAnswer;
    const alreadyLinked = linkedResult(claimAnswer);
    if (alreadyLinked) throw duplicateError(alreadyLinked);
    if (!claimAnswer || claimAnswer.state !== 'claimed') {
      throw new ServiceError('internal_error', 'exception_escalation_claim returned an unknown answer');
    }

    let created: { id: string; requestNumber: number; createdAt: string };
    try {
      created = await new MaintenanceRequestsService(this.ctx).create({
        ...fields,
        relatedItemId: occurrence.item_id,
        relatedLocationId: occurrence.location_id,
      });
    } catch (e) {
      // Nothing was saved (or create refused): free the occurrence at once.
      await this.release(occurrenceId);
      throw e;
    }

    const result: EscalationResult = {
      id: created.id,
      requestNumber: created.requestNumber,
      reference: formatMaintenanceRequestNumber(created.requestNumber, created.createdAt),
      createdAt: created.createdAt,
    };

    const finish = await this.ctx.supabase.rpc('exception_escalation_finish', {
      p_id: occurrenceId,
      p_request_id: created.id,
    });
    const linked = finish.error ? null : linkedResult(finish.data as RpcAnswer);
    if (linked && linked.id === created.id) return result;

    // The link did not come back. It may have landed with its answer lost:
    // the occurrence says. A request that IS linked is never cancelled.
    const landed = await this.linkedTo(occurrenceId, created.id);
    if (landed === true) return result;

    await this.release(occurrenceId);
    if (landed === false) {
      await this.cancelUnlinked(occurrenceId, created.id);
    } else {
      // Unknown: the re-read failed. Leave the request as it is (it may be
      // the linked one) and say so; a retry answers 409 with the link if it
      // landed.
      void reportError(new Error('Escalation link could not be confirmed; the request was left as saved'), {
        tag: 'exceptions.escalate_unconfirmed',
        level: 'warning',
        organizationId: this.ctx.organizationId,
        extra: { occurrenceId, requestId: created.id },
      });
    }
    if (finish.error) throw mapEscalationError(finish.error);
    throw new ServiceError('internal_error', 'exception_escalation_finish returned an unknown answer');
  }

  /** The occurrence as the caller sees it (RLS), or null. A failed read throws. */
  private async readOccurrence(id: string): Promise<OccurrenceLinkRow | null> {
    const { data, error } = await this.ctx.supabase
      .from('exception_occurrences')
      .select('id, item_id, location_id, resolved_at, maintenance_request_id, escalation_number, escalation_request_created_at')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', postgrestErrorText(error));
    return (data as OccurrenceLinkRow | null) ?? null;
  }

  /** true: the occurrence links this request; false: it does not; null: the
   *  read failed, so nobody knows. */
  private async linkedTo(occurrenceId: string, requestId: string): Promise<boolean | null> {
    try {
      const row = await this.readOccurrence(occurrenceId);
      return row?.maintenance_request_id === requestId;
    } catch {
      return null;
    }
  }

  /** Free the caller's claim. Never throws: a claim that could not be
   *  released expires by itself after 2 minutes. */
  private async release(occurrenceId: string): Promise<void> {
    try {
      const { error } = await this.ctx.supabase.rpc('exception_escalation_finish', {
        p_id: occurrenceId,
        p_request_id: null,
      });
      if (error) throw new Error(postgrestErrorText(error));
    } catch (err) {
      void reportError(err, {
        tag: 'exceptions.escalate_release_failed',
        level: 'warning',
        organizationId: this.ctx.organizationId,
        extra: { occurrenceId },
      });
    }
  }

  /** Cancel a request this escalation saved but could not link, as its
   *  requester (the 0362 guard allows exactly that). Never throws: a request
   *  that could not be cancelled is reported, and stays in the requester's
   *  list where they can cancel it. */
  private async cancelUnlinked(occurrenceId: string, requestId: string): Promise<void> {
    try {
      await new MaintenanceRequestsService(this.ctx).cancel(requestId);
    } catch (err) {
      void reportError(err, {
        tag: 'exceptions.escalate_orphan_request',
        organizationId: this.ctx.organizationId,
        extra: { occurrenceId, requestId },
      });
    }
  }
}
