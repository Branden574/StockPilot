import {
  requesterRefusalRecovery,
  RETURNS_COPY,
  type RequesterExchangeOptionsAnswer,
  type RequesterReturnSheet,
} from '@stockpilot/core';

import { api, ApiError } from './api';
import {
  parseRequesterExchangeOptions,
  parseRequesterReturnCreated,
  parseRequesterReturnSheet,
  restartRequesterDraft,
  type RequesterDraft,
  type RequesterReturnBody,
} from './requester-returns';
import { describeReturnError, returnErrorReason } from './returns-api';

/**
 * The phone's client for a member's own "Return or exchange" (returns RX-3):
 * the three member routes, Bearer like every other *-api.ts here, each
 * answer read through requester-returns.ts's parsers.
 *
 *   GET  /api/v1/orders/[id]/return-request          the sheet (lines, the switch, own requests)
 *   POST /api/v1/orders/[id]/return-request/options  the sizes, loaded once on the first Exchange
 *   POST /api/v1/orders/[id]/return-request          the request (core's requester schema)
 *
 * The order is named by its id in the path and nothing else: no token ever
 * travels (the member's session is the credential), the sizes request sends
 * no body at all (no item, group, warehouse or quantity input, so the answer
 * is no oracle), and every answer is no-store on the server.
 *
 * ONLINE ONLY. Nothing here is ever queued (no outbox kind exists for a
 * return; queue.ts is unchanged and a wiring test pins it): a request
 * promises the person something, so it needs the server's answer before the
 * screen may say it was received.
 */

function path(orderId: string): string {
  return `/api/v1/orders/${encodeURIComponent(orderId)}/return-request`;
}

/** An answer that is not the route's shape (an older server, a proxy page). */
export class RequesterAnswerError extends Error {
  constructor() {
    super('Something went wrong. Try again.');
    this.name = 'RequesterAnswerError';
  }
}

export async function getRequesterReturnSheet(orderId: string): Promise<RequesterReturnSheet> {
  const sheet = parseRequesterReturnSheet(await api<unknown>(path(orderId)));
  if (!sheet) throw new RequesterAnswerError();
  return sheet;
}

export async function getRequesterExchangeOptions(orderId: string): Promise<RequesterExchangeOptionsAnswer> {
  const answer = parseRequesterExchangeOptions(await api<unknown>(`${path(orderId)}/options`, { method: 'POST' }));
  if (!answer) throw new RequesterAnswerError();
  return answer;
}

export async function sendRequesterReturn(
  orderId: string,
  body: RequesterReturnBody,
): Promise<{ id: string; returnNumber: string | null; replay: boolean }> {
  const created = parseRequesterReturnCreated(await api<unknown>(path(orderId), { method: 'POST', body }));
  if (!created) throw new RequesterAnswerError();
  return created;
}

// ── Refusals ────────────────────────────────────────────────────────────────

/**
 * The words for a failed request. A body the server's schema refused
 * (`return_invalid`) shows the schema's own words, which name the problem
 * ("A replacement can't be more than the quantity returned."); every other
 * refusal is mapped by its reason through core (describeReturnError: never by
 * message text), and an order that is not the person's, not returnable or in
 * an organization with Returns off reads the server's one sentence.
 */
export function describeRequesterReturnError(e: unknown): string {
  if (e instanceof ApiError && returnErrorReason(e) === 'return_invalid' && e.message) return e.message;
  if (e instanceof RequesterAnswerError) return e.message;
  return describeReturnError(e);
}

/**
 * The order is not (or no longer) one this person may ask about from here:
 * signed out or disabled (401), Returns off (403 module_disabled), or the
 * one 404 (another member's order, a portal order, an order that cannot come
 * back). The screen then offers nothing and shows the order's own returns.
 * An MFA step-up (403 with a reason) is not a closed door.
 */
export function requesterDoorClosed(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  if (e.status === 401 || e.status === 404) return true;
  return e.status === 403 && e.code === 'module_disabled';
}

/**
 * A refusal that means the sheet on screen is behind the server (what can
 * come back, the sizes, an earlier request): read the sheet again (core
 * requesterRefusalRecovery, the web form's rule; and the one 404). The draft
 * is checked against the new sheet.
 */
export function requesterRefusalRefreshes(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  return requesterRefusalRecovery(returnErrorReason(e)) !== null || e.status === 404;
}

/**
 * What the sheet does after a refused send (RX-3 fix round 1, desk check F3;
 * core requesterRefusalRecovery, one rule with the web form):
 *   - idempotency_conflict: the earlier send with this key went through with
 *     other details, so the draft starts over with nothing chosen and a new
 *     key, the words say so, and the sheet is read again (it then shows the
 *     earlier request among "Your requests on this order");
 *   - a refusal that means the sheet is behind: the draft and its key stay
 *     (the refused transaction rolled its key row back), the sheet and the
 *     sizes are read again;
 *   - anything else (busy, a fault): nothing changes; the same send under the
 *     same key is safe.
 */
export function requesterDraftAfterRefusal(
  draft: RequesterDraft,
  e: unknown,
  mintKey?: () => string,
): { draft: RequesterDraft; message: string; reload: boolean } {
  const recovery = e instanceof ApiError ? requesterRefusalRecovery(returnErrorReason(e)) : null;
  if (recovery === 'restart') {
    return {
      draft: restartRequesterDraft(draft, mintKey ? mintKey() : undefined),
      message: RETURNS_COPY.requesterEarlierRequestSent,
      reload: true,
    };
  }
  return { draft, message: describeRequesterReturnError(e), reload: requesterRefusalRefreshes(e) };
}
