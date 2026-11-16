import { revalidatePath } from 'next/cache';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { isUuid } from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { apiContextGate } from '@/server/lib/api-context-gate';
import { CustomersService } from '@/server/services/customers';

import {
  CHANGE_BODY_NOT_JSON_MESSAGE,
  changeErrorResponse,
  changeRateLimitedResponse,
  changeValidationResponse,
} from '../../../change-error-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The sentence for a path id that is not a uuid. */
const CUSTOMER_ID_INVALID_MESSAGE = 'That account id is not valid.';

const bodySchema = z.object({ status: z.enum(['active', 'archived']) });

/**
 * PATCH /api/v1/customers/[id]/status: archive or restore one customer
 * account. Cookie, or a Bearer token for clients that hold one. `[id]` is the
 * customer's id, in either case; it is lower-cased before use.
 *
 * Body: `{ status: 'active' | 'archived' }`.
 *
 * The change is CustomersService.setStatus under the caller's own session:
 * the customer portal module and customers:manage (with the organization's
 * authenticator rule), the account read in the caller's organization, the
 * one status column written. The service writes one `organization.updated`
 * audit row (entity the customer, before and after status, `extra.action`
 * customer_archived or customer_restored), with the caller as the actor; this
 * route writes none. A save of the status the account already has changes
 * nothing and records nothing. An audit row that cannot be written is
 * reported, and the change stands.
 *
 * Answers:
 *   200 `{ ok: true, status, changed }`;
 *   400 `validation_error`: an id that is not a uuid, a body that is not JSON
 *       or not one of the two statuses;
 *   401 `unauthenticated`: no session, or a session that still owes its
 *       authenticator code (withApiContext gives it no context);
 *   403 `forbidden` (with `details.reason` mfa_required when the
 *       organization requires an authenticator and the account has none)
 *       or `module_disabled`;
 *   404 `not_found`: no such account in the caller's organization;
 *   409 `conflict`: the account's status was changed meanwhile;
 *   429 `rate_limited`, with Retry-After (60 a minute per account);
 *   500 `internal_error`, with a fixed sentence;
 *   503 `check_failed` from the API context gate: nothing here ran, and the
 *       same request may be sent again.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // First, before the id, the rate limit, the body or the write.
  const gate = await apiContextGate(req, { modules: ['b2b_portal'] });
  if ('response' in gate) return gate.response;
  const ctx = gate.ctx;
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const { id } = await params;
  if (!isUuid(id)) return changeValidationResponse(CUSTOMER_ID_INVALID_MESSAGE);
  const customerId = id.toLowerCase();

  const rl = await checkRateLimit(`customer-status:${ctx.userId}`, 60, 60_000);
  if (!rl.allowed) return changeRateLimitedResponse(rl.resetAt);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return changeValidationResponse(CHANGE_BODY_NOT_JSON_MESSAGE);
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return changeValidationResponse('Choose a status: active or archived.');
  }

  let result: { status: 'active' | 'archived'; changed: boolean };
  try {
    result = await new CustomersService(ctx).setStatus(customerId, parsed.data.status);
  } catch (e) {
    return changeErrorResponse(e, 'api.v1.customers.status', ctx.organizationId);
  }

  // The Accounts page lists the status; the web's customer actions refresh
  // it. The change is saved at this point, so a refresh that fails is reported.
  if (result.changed) {
    try {
      revalidatePath('/dashboard/customers');
    } catch (e) {
      void reportError(e, {
        tag: 'api.v1.customers.status.revalidate',
        organizationId: ctx.organizationId,
      });
    }
  }
  return NextResponse.json({ ok: true, status: result.status, changed: result.changed });
}
