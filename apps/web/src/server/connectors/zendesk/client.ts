import 'server-only';

export class ZendeskApiError extends Error {
  constructor(public status: number, message = `Zendesk API error ${status}`) {
    super(message);
    this.name = 'ZendeskApiError';
  }
}

export interface ZendeskConfig { subdomain: string; email: string; apiToken: string; }

export interface CreateTicketInput {
  subject: string;
  body: string;
  tags?: string[];
  requesterName?: string;
  requesterEmail?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
}

/**
 * Thin Zendesk REST v2 client. Auth = Basic base64(`${email}/token:${apiToken}`).
 * The token lives ONLY in the Authorization header — never logged or thrown.
 */
export class ZendeskClient {
  private readonly base: string;
  private readonly authHeader: string;
  constructor(cfg: ZendeskConfig, private readonly fetchImpl: typeof fetch = fetch) {
    this.base = `https://${cfg.subdomain}.zendesk.com/api/v2`;
    const token = Buffer.from(`${cfg.email}/token:${cfg.apiToken}`).toString('base64');
    this.authHeader = `Basic ${token}`;
  }

  /** Cheap authenticated GET to validate credentials at connect time. */
  async validateToken(): Promise<void> {
    const res = await this.fetchImpl(`${this.base}/users/me.json`, {
      headers: { Authorization: this.authHeader, Accept: 'application/json' },
    });
    if (!res.ok) throw new ZendeskApiError(res.status);
  }

  /** Create a ticket; returns the new ticket id. */
  async createTicket(input: CreateTicketInput): Promise<number> {
    const ticket: Record<string, unknown> = {
      subject: input.subject,
      comment: { body: input.body },
    };
    if (input.tags?.length) ticket.tags = input.tags;
    if (input.priority) ticket.priority = input.priority;
    if (input.requesterEmail) {
      ticket.requester = { name: input.requesterName ?? input.requesterEmail, email: input.requesterEmail };
    }
    const res = await this.fetchImpl(`${this.base}/tickets.json`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ ticket }),
    });
    if (!res.ok) throw new ZendeskApiError(res.status);
    const json = (await res.json()) as { ticket?: { id?: number } };
    const id = json.ticket?.id;
    if (typeof id !== 'number') throw new ZendeskApiError(res.status, 'Zendesk returned no ticket id');
    return id;
  }
}
