import 'server-only';

import {
  ESCALATE_MODULE_OFF_COPY,
  ESCALATE_NOT_PERMITTED_COPY,
  ESCALATE_RESOLVED_COPY,
  ESCALATION_BUSY_COPY,
  ESCALATION_CHANGED_COPY,
  ESCALATION_IN_PROGRESS_ELSEWHERE_COPY,
  ESCALATION_LINK_FAILED_COPY,
  escalationDuplicateCopy,
  escalationFailureCopy,
  escalationInProgressCopy,
  formatMaintenanceRequestNumber,
  maintenanceRequestFormSchema,
  type EscalateUnavailableReason,
  type EscalationHolder,
  type EscalationSavedRequest,
} from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';

import {
  assertModuleEnabled,
  assertPermission,
  ServiceError,
  type ServiceContext,
} from './context';
import { MaintenanceRequestsService } from './maintenance-requests';
import { isDefiniteRefusal, postgrestErrorText } from './lib/postgrest-error';

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
 *      escalating right now -> 409 escalation_in_progress, naming who; this
 *      person is escalating another exception -> 409
 *      escalation_in_progress_elsewhere;
 *   4. MaintenanceRequestsService.create(): the SAME path the request form
 *      uses, so it validates, rate-limits, audits and notifies exactly as a
 *      request made from its own form does, and nothing more;
 *   5. exception_escalation_finish: link, copy the number, write the
 *      escalated event.
 *
 * WHEN SOMETHING FAILS, only what is known is acted on and said:
 *   - create refused (a SQLSTATE, or any app refusal): nothing was saved;
 *     the claim is released.
 *   - create's answer lost (insertUnconfirmed: no database answer): the
 *     request may exist. The claim is KEPT (it expires in 2 minutes), so an
 *     immediate retry cannot save a second request; reported, and the
 *     person is told it is not known whether it was saved.
 *   - finish answered 55P03 (the row was held past the lock wait): finish is
 *     idempotent and the claim is still held, so it is sent again, up to
 *     FINISH_ATTEMPTS times, before giving up.
 *   - finish's answer lost (no SQLSTATE): sent again (a replay of a link
 *     that landed answers "linked"; one that never ran links now). Only a
 *     definite refusal is acted on.
 *   - finish refused definitely (a SQLSTATE): the link did not happen. The
 *     claim is released and the request cancelled as its requester; the
 *     answer says whether that cancel worked (it cannot while the
 *     maintenance module is off: the update policy requires it).
 *   - still unknown after the retries: the occurrence is re-read; a link
 *     that landed is a success. Otherwise nothing is released or cancelled
 *     (the link may yet land), it is reported, and the person is told it is
 *     not known.
 *
 * NOTHING IS SENT. The review screen's Outlook, mailto or copy handoff opens
 * only when the person taps it there. Escalating neither acknowledges nor
 * resolves the occurrence. Online only: there is no queued escalation, so an
 * offline replay can never create a request or open a composer.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How many times finish is sent before its answer is taken as final. */
export const FINISH_ATTEMPTS = 3;
/** The pause before each resend (ms), after a 55P03 or a lost answer. */
const FINISH_BACKOFF_MS = [250, 750] as const;

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
type RpcError = { code?: string; message: string; hint?: string | null; details?: string | null };

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

/** A request this escalation saved and could not link, as `details` carry
 *  it (the phone words it with the same core sentence). */
type SavedRequestDetail = EscalationSavedRequest & { id: string };

/**
 * claim/finish refusals, by SQLSTATE and hint (never by message text;
 * pattern #28). `saved`: the request this escalation saved before the
 * refusal, and whether it was cancelled; the message then says which, and
 * `details.savedRequest` carries it.
 */
function mapEscalationError(
  error: RpcError,
  opts: { saved?: SavedRequestDetail | null; holder?: EscalationHolder | null } = {},
): ServiceError {
  const saved = opts.saved ?? null;
  const extra: Record<string, unknown> = saved ? { savedRequest: saved } : {};
  const say = (base: string) => escalationFailureCopy(base, saved);
  switch (error.code) {
    case '42501':
      if (error.hint === 'module_disabled') {
        return new ServiceError('module_disabled', say(ESCALATE_MODULE_OFF_COPY), {
          reason: 'module_disabled',
          ...extra,
        });
      }
      return new ServiceError('forbidden', say(ESCALATE_NOT_PERMITTED_COPY), { reason: 'not_permitted', ...extra });
    case 'P0002':
      return new ServiceError('not_found', say('Exception not found.'), saved ? { ...extra } : undefined);
    case 'P0001':
      switch (error.hint) {
        case 'occurrence_resolved':
          return new ServiceError('conflict', say(ESCALATE_RESOLVED_COPY), { reason: 'occurrence_resolved', ...extra });
        case 'escalation_in_progress':
          return new ServiceError('conflict', escalationInProgressCopy(opts.holder ?? null), {
            reason: 'escalation_in_progress',
            retryable: true,
            ...(opts.holder ? { holder: opts.holder } : {}),
          });
        case 'escalation_in_progress_elsewhere':
          return new ServiceError('conflict', ESCALATION_IN_PROGRESS_ELSEWHERE_COPY, {
            reason: 'escalation_in_progress_elsewhere',
            retryable: true,
          });
        case 'escalation_not_claimed':
        case 'request_not_eligible':
        case 'already_escalated':
          return new ServiceError('conflict', say(ESCALATION_CHANGED_COPY), { reason: error.hint, ...extra });
      }
      break;
    case '55P03':
      // lock_timeout: a sync or another escalation held the row past 5 s.
      return new ServiceError('conflict', say(ESCALATION_BUSY_COPY), { reason: 'busy', retryable: true, ...extra });
    case '22023':
      return new ServiceError('validation_error', 'That exception id is not valid.', { reason: 'bad_argument' });
  }
  // A refusal this build does not name. After a request was saved, say what
  // is known (it was not linked, and what became of the request) rather than
  // "not known whether it was saved".
  if (saved) {
    return new ServiceError('conflict', say(ESCALATION_LINK_FAILED_COPY), { reason: 'not_linked', ...extra });
  }
  return new ServiceError('internal_error', postgrestErrorText(error));
}

/** The claim/finish refusals mapEscalationError names. */
const NAMED_P0001 = new Set([
  'occurrence_resolved',
  'escalation_in_progress',
  'escalation_in_progress_elsewhere',
  'escalation_not_claimed',
  'request_not_eligible',
  'already_escalated',
]);
function isNamedRefusal(error: RpcError): boolean {
  if (error.code === 'P0001') return NAMED_P0001.has(error.hint ?? '');
  return ['42501', 'P0002', '55P03', '22023'].includes(error.code ?? '');
}

/** The outcome of sending finish: linked (to the request created), a
 *  definite refusal, an answer that names something else, or unknown. */
type FinishOutcome =
  | { kind: 'linked' }
  | { kind: 'refused'; error: RpcError }
  | { kind: 'unexpected' }
  | { kind: 'unknown'; error: RpcError | null };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ExceptionEscalationService {
  private readonly finishBackoffMs: readonly number[];

  /** `opts.finishBackoffMs`: the pauses before each resend of finish (tests
   *  pass zeros); FINISH_BACKOFF_MS otherwise. */
  constructor(
    private readonly ctx: ServiceContext,
    opts: { finishBackoffMs?: readonly number[] } = {},
  ) {
    this.finishBackoffMs = opts.finishBackoffMs ?? FINISH_BACKOFF_MS;
  }

  /**
   * Escalate one occurrence. Returns the request that was saved and linked.
   * Throws ServiceError: module_disabled, forbidden, not_found,
   * validation_error (the request form's own rules), internal_error (a
   * failure that leaves it unknown whether a request was saved or linked),
   * or conflict with `details.reason` already_escalated (+ requestId,
   * requestNumber, reference), escalation_in_progress (+ holder),
   * escalation_in_progress_elsewhere, occurrence_resolved,
   * escalation_not_claimed, request_not_eligible or busy. A refusal after
   * the request was saved carries `details.savedRequest` {id, reference,
   * cancelled}, and its message says which.
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
    if (claim.error) {
      const holder =
        claim.error.code === 'P0001' && claim.error.hint === 'escalation_in_progress'
          ? await this.holderOf(claim.error.details)
          : null;
      throw mapEscalationError(claim.error, { holder });
    }
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
      if (e instanceof ServiceError && e.code === 'internal_error' && e.details?.insertUnconfirmed === true) {
        // The insert's answer never came: the request may exist (and its
        // notification may have gone). Keep the claim, so a retry within 2
        // minutes is refused rather than saving a second request, and say
        // it is not known.
        void reportError(new Error('Escalation: the request insert was not confirmed'), {
          tag: 'exceptions.escalate_unconfirmed',
          level: 'warning',
          organizationId: this.ctx.organizationId,
          extra: { occurrenceId, stage: 'create', detail: e.internalDetail ?? null },
        });
        throw new ServiceError('internal_error', 'escalation: the request insert was not confirmed');
      }
      // Refused (or failed before its insert): nothing was saved. Free the
      // occurrence at once.
      await this.release(occurrenceId);
      throw e;
    }

    const result: EscalationResult = {
      id: created.id,
      requestNumber: created.requestNumber,
      reference: formatMaintenanceRequestNumber(created.requestNumber, created.createdAt),
      createdAt: created.createdAt,
    };

    const outcome = await this.finish(occurrenceId, created.id);
    if (outcome.kind === 'linked') return result;

    if (outcome.kind === 'refused') {
      // A definite refusal: the link did not happen, and the request is ours
      // to cancel. Say whether the cancel worked.
      await this.release(occurrenceId);
      const cancelled = await this.cancelUnlinked(occurrenceId, created.id);
      if (!isNamedRefusal(outcome.error)) {
        void reportError(new Error(`exception_escalation_finish refused: ${postgrestErrorText(outcome.error)}`), {
          tag: 'exceptions.escalate_finish_failed',
          organizationId: this.ctx.organizationId,
          extra: { occurrenceId, requestId: created.id, cancelled, code: outcome.error.code ?? null },
        });
      }
      throw mapEscalationError(outcome.error, {
        saved: { id: created.id, reference: result.reference, cancelled },
      });
    }

    // Unknown, or an answer naming something else: what does the occurrence
    // link now? A committed link to this request is a success.
    const landed = await this.linkedTo(occurrenceId, created.id);
    if (landed === true) return result;

    if (outcome.kind === 'unexpected' && landed === false) {
      // finish answered without an error but not with this request, and the
      // occurrence does not link it: it never will (finish links only the
      // request it was sent). Ours to cancel.
      await this.release(occurrenceId);
      const cancelled = await this.cancelUnlinked(occurrenceId, created.id);
      void reportError(new Error('exception_escalation_finish returned an unknown answer'), {
        tag: 'exceptions.escalate_finish_failed',
        organizationId: this.ctx.organizationId,
        extra: { occurrenceId, requestId: created.id, cancelled },
      });
      throw new ServiceError('internal_error', 'exception_escalation_finish returned an unknown answer');
    }

    // Still unknown: the link may yet land (a finish can outlive its lost
    // answer). Release nothing and cancel nothing; the claim expires by
    // itself. Reported, and the person is told it is not known.
    void reportError(new Error('Escalation link could not be confirmed; the request was left as saved'), {
      tag: 'exceptions.escalate_unconfirmed',
      level: 'warning',
      organizationId: this.ctx.organizationId,
      extra: {
        occurrenceId,
        requestId: created.id,
        stage: 'finish',
        detail: outcome.kind === 'unknown' && outcome.error ? postgrestErrorText(outcome.error) : null,
      },
    });
    throw new ServiceError('internal_error', 'escalation: the link could not be confirmed');
  }

  /**
   * Send finish until its answer is final. finish is idempotent (a link
   * that landed answers "linked" again, with no second event) and the claim
   * is ours for 2 minutes, so a resend after a lock wait (55P03) or a lost
   * answer is safe. A 55P03 after a lost answer stays unknown: the first
   * send may still be holding the row.
   */
  private async finish(occurrenceId: string, requestId: string): Promise<FinishOutcome> {
    let answerLost = false;
    let last: RpcError | null = null;
    for (let attempt = 0; attempt < FINISH_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        const pause = this.finishBackoffMs[Math.min(attempt - 1, this.finishBackoffMs.length - 1)] ?? 0;
        if (pause > 0) await sleep(pause);
      }
      const res = await this.ctx.supabase.rpc('exception_escalation_finish', {
        p_id: occurrenceId,
        p_request_id: requestId,
      });
      if (!res.error) {
        const linked = linkedResult(res.data as RpcAnswer);
        return linked && linked.id === requestId ? { kind: 'linked' } : { kind: 'unexpected' };
      }
      last = res.error as RpcError;
      if (!isDefiniteRefusal(last)) {
        answerLost = true;
        continue;
      }
      if (last.code === '55P03') continue;
      // Any other SQLSTATE: this send ran and was refused. finish re-reads
      // the row under its lock, so an earlier send that had landed would
      // have been answered "linked" here: the refusal is final.
      return { kind: 'refused', error: last };
    }
    // Out of attempts: a lock wait on every send is a definite "busy" unless
    // an answer was lost on the way (that send may still land).
    if (last && last.code === '55P03' && !answerLost) return { kind: 'refused', error: last };
    return { kind: 'unknown', error: last };
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

  /**
   * Who holds the escalation under way, from the claim's refusal DETAIL (the
   * holder's user id, 0376). This person, or a coworker named as every other
   * person on the occurrence is (their profile, read under the reader's own
   * RLS: user_profiles_select_orgmates). The read feeds what the person is
   * told, so its error is bound: a failed or empty read names nobody.
   */
  private async holderOf(detail: unknown): Promise<EscalationHolder | null> {
    if (typeof detail !== 'string' || !UUID.test(detail)) return null;
    if (detail.toLowerCase() === this.ctx.userId.toLowerCase()) return { self: true };
    try {
      const { data, error } = await this.ctx.supabase
        .from('user_profiles')
        .select('full_name, email')
        .eq('id', detail)
        .maybeSingle();
      if (error) {
        void reportError(new Error('Escalation: the claim holder could not be read'), {
          tag: 'exceptions.escalate_holder_read',
          level: 'warning',
          organizationId: this.ctx.organizationId,
          extra: { detail: postgrestErrorText(error) },
        });
        return { self: false, label: null };
      }
      const profile = data as { full_name: string | null; email: string | null } | null;
      return { self: false, label: profile?.full_name?.trim() || profile?.email?.trim() || null };
    } catch (err) {
      void reportError(err, {
        tag: 'exceptions.escalate_holder_read',
        level: 'warning',
        organizationId: this.ctx.organizationId,
      });
      return { self: false, label: null };
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

  /**
   * Cancel a request this escalation saved but could not link, as its
   * requester (the 0362 guard allows exactly that). Returns whether it was
   * cancelled. Never throws: a request that could not be cancelled (the
   * maintenance module was turned off meanwhile, which the update policy
   * refuses; a failed write) is reported, stays in the requester's list
   * where they can cancel it, and the answer says so.
   */
  private async cancelUnlinked(occurrenceId: string, requestId: string): Promise<boolean> {
    try {
      await new MaintenanceRequestsService(this.ctx).cancel(requestId);
      return true;
    } catch (err) {
      void reportError(err, {
        tag: 'exceptions.escalate_orphan_request',
        organizationId: this.ctx.organizationId,
        extra: { occurrenceId, requestId },
      });
      return false;
    }
  }
}
