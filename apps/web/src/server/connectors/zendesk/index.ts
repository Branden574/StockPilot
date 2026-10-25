import 'server-only';

import type { Connector, ConnectorDeps, PushResult } from '@stockpilot/core';

import { ZendeskApiError, ZendeskClient } from './client';

type TopicBuilder = (payload: Record<string, unknown>) => {
  subject: string;
  body: string;
  tags: string[];
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  requesterName?: string;
  requesterEmail?: string;
};

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

const BUILDERS: Record<string, TopicBuilder> = {
  'return.created': (p) => ({
    subject: `Return ${str(p.returnNumber) ?? str(p.returnId) ?? ''}`.trim() || 'New return',
    body: `A return was created in StockPilot.\nReturn: ${str(p.returnNumber) ?? ''}\nOrder: ${str(p.orderRequestId) ?? ''}\nReason: ${str(p.reason) ?? '—'}`,
    tags: ['stockpilot', 'return'],
    requesterEmail: str(p.requesterEmail),
    requesterName: str(p.requesterName),
  }),
  'public_request.created': (p) => ({
    subject: `New order request from ${str(p.requesterName) ?? str(p.requesterEmail) ?? 'a customer'}`,
    body: `A public order request was submitted.\nOrder: ${str(p.orderRequestId) ?? ''}\nStatus: ${str(p.status) ?? ''}`,
    tags: ['stockpilot', 'public-request'],
    requesterEmail: str(p.requesterEmail),
    requesterName: str(p.requesterName),
  }),
  'order.problem': (p) => ({
    subject: `Order problem — ${str(p.orderRequestId) ?? ''}`.trim(),
    body: `An order was flagged with a problem in StockPilot.\nOrder: ${str(p.orderRequestId) ?? ''}\nReason: ${str(p.reason) ?? '—'}`,
    tags: ['stockpilot', 'order-problem'],
    priority: 'high',
    requesterEmail: str(p.requesterEmail),
    requesterName: str(p.requesterName),
  }),
};

/** The topics whose requester fields are the ORDER's requester, read from the
 *  order when the event was queued (order-requests deny, the public order
 *  route). return.created carries no person today. */
const ORDER_REQUESTER_TOPICS = new Set(['public_request.created', 'order.problem']);

/** The admin client surface the requester check reads through. */
type OrderReader = {
  from(table: 'order_requests'): {
    select(columns: 'requester_deleted_at'): {
      eq(column: 'organization_id', value: string): {
        eq(column: 'id', value: string): {
          maybeSingle(): PromiseLike<{
            data: { requester_deleted_at: string | null } | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
  };
};

/**
 * B23: may this ticket still name the order's requester? The payload carries
 * the requester as the order read when the event was QUEUED; the drainer may
 * send it much later (backoff, a connection repaired days on). Zendesk makes
 * the ticket's requester from requesterEmail and emails them, so a requester
 * who deleted their account in between (0388 stamps requester_deleted_at on
 * their orders) would be emailed after their deletion. The order is read
 * again at send time, in the connection's organization:
 *   - 'keep': the order is there and its requester's account was not deleted;
 *   - 'drop': the account was deleted, the order is gone, or the payload names
 *     no order to check against (nothing says the person may be named);
 *   - 'retry': the read failed: send nothing now (fail closed), try again.
 */
async function orderRequesterOnTicket(
  deps: ConnectorDeps,
  organizationId: string,
  payload: Record<string, unknown>,
): Promise<'keep' | 'drop' | 'retry'> {
  const orderId = str(payload.orderRequestId);
  if (!orderId) return 'drop';
  try {
    const { data, error } = await (deps.admin as OrderReader)
      .from('order_requests')
      .select('requester_deleted_at')
      .eq('organization_id', organizationId)
      .eq('id', orderId)
      .maybeSingle();
    if (error) return 'retry';
    if (!data) return 'drop';
    return data.requester_deleted_at ? 'drop' : 'keep';
  } catch {
    return 'retry';
  }
}

/**
 * Zendesk push connector. Turns 3 shell outbox topics into Zendesk tickets via
 * the REST client. Push-only: never pulls and never writes Zendesk data back
 * into StockPilot.
 *
 * Retry classification (the drainer uses PushResult.retryable for backoff /
 * dead-letter): 5xx + 429 are transient → retryable; other 4xx are caller
 * errors → dead-letter; an unknown (network) throw is retryable; an unsupported
 * topic or a missing-config connection is non-retryable (retrying won't fix it).
 */
export const zendeskConnector: Connector = {
  id: 'zendesk',
  modes: ['push'],
  subscribedTopics: ['return.created', 'public_request.created', 'order.problem'],

  async handleOutboxEvent(event, conn, secrets, deps): Promise<PushResult> {
    const build = BUILDERS[event.topic];
    if (!build) return { ok: false, retryable: false, error: `Unsupported topic: ${event.topic}` };

    const settings = conn.settings as { subdomain?: string; email?: string };
    if (!settings.subdomain || !settings.email || !secrets.accessToken) {
      return { ok: false, retryable: false, error: 'Zendesk connection is missing subdomain/email/token' };
    }

    // B23: the requester as the order reads NOW, never as it read when the
    // event was queued (orderRequesterOnTicket). Only a payload that names a
    // requester is checked.
    let payload = event.payload;
    if (
      ORDER_REQUESTER_TOPICS.has(event.topic) &&
      (str(payload.requesterEmail) !== undefined || str(payload.requesterName) !== undefined)
    ) {
      const verdict = await orderRequesterOnTicket(deps, conn.organizationId, payload);
      if (verdict === 'retry') {
        return { ok: false, retryable: true, error: "Could not check the order's requester" };
      }
      if (verdict === 'drop') {
        payload = { ...payload, requesterEmail: undefined, requesterName: undefined };
      }
    }

    const client = new ZendeskClient({
      subdomain: settings.subdomain,
      email: settings.email,
      apiToken: secrets.accessToken,
    });

    try {
      const ticketId = await client.createTicket(build(payload));
      return { ok: true, externalId: String(ticketId) };
    } catch (e) {
      if (e instanceof ZendeskApiError) {
        const retryable = e.status >= 500 || e.status === 429;
        return { ok: false, retryable, error: `Zendesk ${e.status}` };
      }
      return { ok: false, retryable: true, error: e instanceof Error ? e.message : 'Unknown Zendesk error' };
    }
  },
};
