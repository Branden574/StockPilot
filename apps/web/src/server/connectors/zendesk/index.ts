import 'server-only';

import type { Connector, PushResult } from '@stockpilot/core';

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

  async handleOutboxEvent(event, conn, secrets): Promise<PushResult> {
    const build = BUILDERS[event.topic];
    if (!build) return { ok: false, retryable: false, error: `Unsupported topic: ${event.topic}` };

    const settings = conn.settings as { subdomain?: string; email?: string };
    if (!settings.subdomain || !settings.email || !secrets.accessToken) {
      return { ok: false, retryable: false, error: 'Zendesk connection is missing subdomain/email/token' };
    }

    const client = new ZendeskClient({
      subdomain: settings.subdomain,
      email: settings.email,
      apiToken: secrets.accessToken,
    });

    try {
      const ticketId = await client.createTicket(build(event.payload));
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
