import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { ExceptionEscalationService } from '@/server/services/exception-escalation';

import { exceptionsErrorResponse, exceptionsRateLimitedResponse } from '../../error-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/exceptions/[id]/escalate — escalate an exception occurrence to
 * a maintenance request (F1-5). Cookie or Bearer. Online only: the phone
 * never queues it, so an offline replay can never create a request or open a
 * composer.
 *
 * Body: `{ subject, description, priority?, category? }`, the request form's
 * own rules (maintenanceRequestFormSchema). Any other key (an item, location,
 * warehouse or site id) is ignored: the item and location come from the
 * occurrence on the server.
 *
 * Who: the maintenance_requests module on, maintenance_requests:submit and
 * items:read, and the occurrence visible to the caller. The database
 * re-checks all of it (exception_escalation_claim / _finish).
 *
 * Answers:
 *   201 `{ id, requestNumber, reference, createdAt }`: the request that was
 *       saved and linked. Nothing was emailed; the request's review screen
 *       opens the draft only when the person taps it.
 *   400 bad id, bad JSON, or the form's rules (`message` says which);
 *   403 `module_disabled` or `forbidden` (details.reason aal2_required or
 *       mfa_required from the MFA gate); 404 not found or not visible;
 *   409 `details.reason`:
 *       already_escalated (+ requestId, requestNumber, reference: open that
 *         request), escalation_in_progress (retryable; + holder {self} or
 *         {self:false, label}: who is escalating),
 *         escalation_in_progress_elsewhere (retryable: this person is
 *         escalating another exception), occurrence_resolved,
 *         escalation_not_claimed or request_not_eligible (the exception
 *         changed meanwhile), busy (retryable), not_linked (a refusal this
 *         build does not name); a create refused by the maintenance rate
 *         limit is also 409 (the maintenance create route's contract);
 *   Any refusal AFTER the request was saved (409, 403 or 404) carries
 *       details.savedRequest {id, reference, cancelled}: whether that
 *       request was cancelled, which `message` also says (core
 *       escalationFailureCopy). Never "cancelled" unless it was.
 *   429 too many escalations from this user (the web action shares the
 *       limit and its key);
 *   500 a failure that leaves it unknown whether a request was saved or
 *       linked (the claim is kept for 2 minutes so a retry cannot save a
 *       second one); the phone says so (core ESCALATE_SERVER_PROBLEM_COPY).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json(
      { error: 'validation_error', message: 'That exception id is not valid.' },
      { status: 400 },
    );
  }

  const rl = await checkRateLimit(`exceptions-escalate:${ctx.userId}`, 10, 60_000);
  if (!rl.allowed) return exceptionsRateLimitedResponse(rl.resetAt);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'validation_error', message: 'The request body is not valid JSON.' },
      { status: 400 },
    );
  }

  try {
    const request = await new ExceptionEscalationService(ctx).escalate(id, body);
    return NextResponse.json(request, { status: 201 });
  } catch (e) {
    return exceptionsErrorResponse(e, 'api.v1.exceptions.escalate', ctx);
  }
}
