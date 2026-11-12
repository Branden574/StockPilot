import {
  brandDeliveryRecipients,
  canSendReturnRequest,
  ccNotice,
  prepareReturnRequestEmail,
  RETURN_REQUEST_COPY,
  returnRequestContentFromTracking,
  returnRequestContentFromWorkbench,
  type DeliveryRequestRecipients,
  type PreparedReturnRequestEmail,
  type RequesterTrackingReturn,
  type ReturnRequestEmailContent,
  type ReturnRequestOrderFacts,
  type ReturnRequestSite,
  type ReturnRequestWorkbenchSource,
} from '@stockpilot/core';

import { api } from './api';
import {
  composeTransportForProbe,
  openMeasuredDraft,
  type MeasuredOpenResult,
  type OpenedTransport,
  type OutlookPlatform,
} from './outlook-transport';

/**
 * The return request email on the phone (F14): the decisions and the words
 * of the RETURN REQUEST section, as pure functions vitest can reach (the
 * screens only draw what these answer). It is the third user of the shared
 * transport (./outlook-transport), after the maintenance request and the
 * delivery request, and adds no transport rule of its own.
 *
 * WHO DECIDES WHAT. The server decides the mailboxes and the link and sends
 * them resolved (GET /api/v1/returns/[id] `returnRequestEmail`, GET
 * /api/v1/orders/[id]/return-request-email): a plain pair, or null when the
 * organization has none saved or the saved value is invalid. The phone
 * re-validates the pair through core's factory and shows nothing on a value
 * it refuses. An answer with no such field (an older server) is "none":
 * there is no compiled fallback pair here, so the phone can never address a
 * return request to a mailbox the organization did not save.
 *
 * WHAT IS RECORDED. Only an open the operating system confirmed
 * (openMeasuredDraft's onOpened), through POST
 * /api/v1/orders/[id]/return-request-drafted, which checks the organization,
 * the module, and requester or returns permission itself. A failed record is
 * dropped: the person already has their draft.
 *
 * The words are core's RETURN_REQUEST_COPY, shared with the website.
 */

export { shouldConfirmBeforeOpening } from './outlook-transport';
export { RETURN_REQUEST_COPY };

// ── The server's answers, read defensively ──────────────────────────────────

function readRecipients(raw: unknown): DeliveryRequestRecipients | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.to !== 'string' || typeof r.cc !== 'string') return null;
  try {
    return brandDeliveryRecipients({
      to: r.to,
      cc: r.cc,
      ...(typeof r.toName === 'string' ? { toName: r.toName } : {}),
      ...(typeof r.ccName === 'string' ? { ccName: r.ccName } : {}),
    });
  } catch {
    // A pair the factory refuses is no pair: the section does not show.
    return null;
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** Name, code and address: the server sends no id and the draft prints none. */
function readSite(raw: unknown): ReturnRequestSite | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.name !== 'string' || !s.name.trim()) return null;
  const address =
    s.address !== null && typeof s.address === 'object' && !Array.isArray(s.address)
      ? (s.address as ReturnRequestSite['address'])
      : null;
  return { name: s.name, code: typeof s.code === 'string' ? s.code : null, address };
}

/** The return screen's `returnRequestEmail` field. */
export interface ReturnRequestEmailForReturn {
  recipients: DeliveryRequestRecipients | null;
  link: string | null;
}

export function returnRequestEmailFromWorkbench(raw: unknown): ReturnRequestEmailForReturn {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { recipients: null, link: null };
  const r = raw as Record<string, unknown>;
  return { recipients: readRecipients(r.recipients), link: str(r.link) };
}

/** The order screen's answer (GET .../return-request-email). */
export interface ReturnRequestEmailForOrder {
  recipients: DeliveryRequestRecipients | null;
  order: ReturnRequestOrderFacts;
}

const NO_ORDER_FACTS: ReturnRequestOrderFacts = {
  orderNumber: null,
  requestedBy: null,
  requesterEmail: null,
  site: null,
  warehouseName: null,
  link: null,
};

export function returnRequestEmailFromOrderAnswer(raw: unknown): ReturnRequestEmailForOrder {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { recipients: null, order: NO_ORDER_FACTS };
  const r = raw as Record<string, unknown>;
  const o = r.order !== null && typeof r.order === 'object' && !Array.isArray(r.order) ? (r.order as Record<string, unknown>) : {};
  return {
    recipients: readRecipients(r.recipients),
    order: {
      orderNumber: str(o.orderNumber),
      requestedBy: str(o.requestedBy),
      requesterEmail: str(o.requesterEmail),
      site: readSite(o.site),
      warehouseName: str(o.warehouseName),
      link: str(o.link),
    },
  };
}

/** The order screen's read. A refusal (404, 403, offline) is "nothing to show". */
export async function getReturnRequestEmailForOrder(orderId: string): Promise<ReturnRequestEmailForOrder | null> {
  try {
    return returnRequestEmailFromOrderAnswer(
      await api<unknown>(`/api/v1/orders/${encodeURIComponent(orderId)}/return-request-email`),
    );
  } catch {
    return null;
  }
}

// ── The gate and the content, per screen ────────────────────────────────────

/** Whether the order screen needs the read above at all: an open, numbered request. */
export function anyReturnRequestSendable(tracking: readonly RequesterTrackingReturn[] | null | undefined): boolean {
  return (tracking ?? []).some((t) => canSendReturnRequest(t.returnStatus, t.returnNumber));
}

/**
 * The order screen, one of the requester's own requests: the draft's content,
 * or null (no section) when the mailboxes are missing or the request is
 * closed, denied, cancelled or has no number. Core's mapping, the website's
 * too, so both say what the card says.
 */
export function returnRequestContentForTracking(
  tracking: RequesterTrackingReturn,
  email: ReturnRequestEmailForOrder | null,
): ReturnRequestEmailContent | null {
  if (!email?.recipients) return null;
  if (!canSendReturnRequest(tracking.returnStatus, tracking.returnNumber)) return null;
  return returnRequestContentFromTracking(tracking, email.order);
}

/** The return screen (returns:read or returns:manage): the same rule, from the workbench. */
export function returnRequestContentForWorkbench(
  workbench: ReturnRequestWorkbenchSource,
  email: ReturnRequestEmailForReturn,
): ReturnRequestEmailContent | null {
  if (!email.recipients) return null;
  if (!canSendReturnRequest(workbench.return.status, workbench.return.returnNumber)) return null;
  return returnRequestContentFromWorkbench(workbench, { link: email.link });
}

// ── Prepare, open, record ───────────────────────────────────────────────────

/**
 * Measured against the link the phone will open: `nativeOutlook` is the ONE
 * canOpenURL probe's answer (null before it answered: the web link, the
 * longest, so a body is never fitted to a link that is not the one opened).
 */
export function prepareMobileReturnRequest(
  content: ReturnRequestEmailContent,
  recipients: DeliveryRequestRecipients,
  nativeOutlook: boolean | null = null,
): PreparedReturnRequestEmail {
  return prepareReturnRequestEmail(
    { ...content, recipients },
    { transport: composeTransportForProbe(nativeOutlook) },
  );
}

export type ReturnRequestOpenResult = MeasuredOpenResult;

/** Opens the draft through the shared transport; `onOpened` fires only after a real open. */
export async function openReturnRequestDraft(
  prepared: PreparedReturnRequestEmail,
  platform: OutlookPlatform,
  onOpened: () => void,
): Promise<ReturnRequestOpenResult> {
  return openMeasuredDraft('outlook', prepared, platform, onOpened);
}

/** Best-effort bookkeeping after a confirmed open. Never rejects. */
export async function recordReturnRequestDrafted(input: {
  orderId: string;
  returnNumber: string;
  isCondensed: boolean;
  surface: 'order' | 'return';
}): Promise<void> {
  try {
    await api(`/api/v1/orders/${encodeURIComponent(input.orderId)}/return-request-drafted`, {
      method: 'POST',
      body: { returnNumber: input.returnNumber, isCondensed: input.isCondensed, surface: input.surface },
    });
  } catch {
    // The person already has their draft; a lost row is not their problem.
  }
}

// ── What the section says ───────────────────────────────────────────────────

/** "This request will be emailed to … A copy will also be sent to …" */
export function returnRequestRecipientsText(recipients: { to: string; cc: string }): string {
  return ccNotice(recipients);
}

/** Worded from what ACTUALLY opened, never from the button that was pressed. */
export function returnRequestSuccessMessage(used: OpenedTransport | null): string {
  return used === 'default-mail' ? RETURN_REQUEST_COPY.mailAppSuccess : RETURN_REQUEST_COPY.success;
}

export function returnRequestBlockedHeadline(attempted: OpenedTransport | null): string {
  return attempted === 'default-mail' ? RETURN_REQUEST_COPY.mailAppBlocked : RETURN_REQUEST_COPY.blocked;
}

/** A blocked open and a draft too long for a link are different failures. */
export function shouldShowReturnRequestBlocked(
  prepared: Pick<PreparedReturnRequestEmail, 'linkFits'>,
  result: ReturnRequestOpenResult | null,
): boolean {
  return prepared.linkFits && result?.outcome === 'blocked';
}

export function shouldShowReturnRequestCondensed(
  prepared: Pick<PreparedReturnRequestEmail, 'linkFits' | 'draft'>,
): boolean {
  return prepared.linkFits && prepared.draft.condensed;
}

/** As soon as one draft was opened, so it is read before the second press. */
export function shouldWarnReturnRequestDuplicate(openCount: number): boolean {
  return openCount > 0;
}

/** The label of the return screen's launch point (the item screen's words). */
export const RETURN_PROBLEM_LABEL = 'Report a problem';

/** "Report a problem" from a return: the order attached, the return named in the subject. */
export function returnProblemLaunchParams(ret: {
  orderRequestId: string;
  returnNumber: string | null;
}): { orderRequestId: string; subject?: string } {
  return ret.returnNumber && ret.returnNumber.trim()
    ? { orderRequestId: ret.orderRequestId, subject: `Return ${ret.returnNumber}: ` }
    : { orderRequestId: ret.orderRequestId };
}
