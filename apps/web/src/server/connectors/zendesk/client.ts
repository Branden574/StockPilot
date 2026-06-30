import 'server-only';

export class ZendeskApiError extends Error {
  constructor(public status: number, message = `Zendesk API error ${status}`) {
    super(message);
    this.name = 'ZendeskApiError';
  }
}

export interface ZendeskConfig { subdomain: string; email: string; apiToken: string; }

/** OAuth bearer config — used by the per-user agent console path. */
export interface ZendeskBearerConfig { subdomain: string; accessToken: string; }

export interface CreateTicketInput {
  subject: string;
  body: string;
  tags?: string[];
  requesterName?: string;
  requesterEmail?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
}

/** A Zendesk ticket, mapped from the REST v2 JSON shape. */
export interface ZendeskTicket {
  id: number;
  subject: string;
  status: string;
  priority: string | null;
  description: string;
  createdAt: string;
  updatedAt: string;
  requesterId: number | null;
  assigneeId: number | null;
  /** Deep-link to the ticket in the agent's Zendesk UI. */
  url: string;
}

/** A single comment/audit on a Zendesk ticket. */
export interface ZendeskComment {
  id: number;
  authorId: number | null;
  body: string;
  public: boolean;
  createdAt: string;
}

/** Raw Zendesk ticket shape as returned by the REST API. */
interface RawTicket {
  id: number;
  subject?: string;
  status?: string;
  priority?: string | null;
  description?: string;
  created_at?: string;
  updated_at?: string;
  requester_id?: number | null;
  assignee_id?: number | null;
}

/** Raw Zendesk comment shape as returned by the REST API. */
interface RawComment {
  id: number;
  author_id?: number | null;
  body?: string;
  public?: boolean;
  created_at?: string;
}

// SSRF guard: subdomain is interpolated straight into the request host, so
// a value containing `.`, `/`, `:`, `@`, `#`, `?` or whitespace could retarget
// the host (e.g. `169.254.169.254#`). Allow only a DNS label.
const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function assertSubdomain(subdomain: string): void {
  if (!SUBDOMAIN_RE.test(subdomain)) {
    throw new ZendeskApiError(400, 'Invalid Zendesk subdomain');
  }
}

function mapTicket(raw: RawTicket, subdomain: string): ZendeskTicket {
  return {
    id: raw.id,
    subject: raw.subject ?? '',
    status: raw.status ?? '',
    priority: raw.priority ?? null,
    description: raw.description ?? '',
    createdAt: raw.created_at ?? '',
    updatedAt: raw.updated_at ?? '',
    requesterId: raw.requester_id ?? null,
    assigneeId: raw.assignee_id ?? null,
    url: `https://${subdomain}.zendesk.com/agent/tickets/${raw.id}`,
  };
}

function mapComment(raw: RawComment): ZendeskComment {
  return {
    id: raw.id,
    authorId: raw.author_id ?? null,
    body: raw.body ?? '',
    public: raw.public ?? false,
    createdAt: raw.created_at ?? '',
  };
}

/**
 * Thin Zendesk REST v2 client. Supports two auth modes:
 *   - Basic: `ZendeskConfig` → `Basic base64(email/token:apiToken)`
 *   - Bearer: `ZendeskBearerConfig` → `Bearer accessToken` (per-user OAuth)
 *
 * The token lives ONLY in the Authorization header — never logged or thrown.
 */
export class ZendeskClient {
  private readonly base: string;
  private readonly authHeader: string;
  private readonly subdomain: string;

  constructor(cfg: ZendeskConfig | ZendeskBearerConfig, private readonly fetchImpl: typeof fetch = fetch) {
    assertSubdomain(cfg.subdomain);
    this.subdomain = cfg.subdomain;
    this.base = `https://${cfg.subdomain}.zendesk.com/api/v2`;

    if ('accessToken' in cfg) {
      this.authHeader = `Bearer ${cfg.accessToken}`;
    } else {
      const token = Buffer.from(`${cfg.email}/token:${cfg.apiToken}`).toString('base64');
      this.authHeader = `Basic ${token}`;
    }
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

  /**
   * List tickets for the signed-in agent via the Zendesk Search API.
   *   view='assigned'  → `assignee:me` (default)
   *   view='requested' → `requester:me`
   * An optional free-form `query` string is appended (trimmed).
   */
  async listMyTickets(opts: { view?: 'assigned' | 'requested'; query?: string }): Promise<ZendeskTicket[]> {
    const viewTerm = opts.view === 'requested' ? 'requester:me' : 'assignee:me';
    const parts = [viewTerm, 'type:ticket'];
    const extra = opts.query?.trim();
    if (extra) parts.push(extra);
    const q = encodeURIComponent(parts.join(' '));
    const res = await this.fetchImpl(`${this.base}/search.json?query=${q}`, {
      headers: { Authorization: this.authHeader, Accept: 'application/json' },
    });
    if (!res.ok) throw new ZendeskApiError(res.status);
    const json = (await res.json()) as { results?: RawTicket[] };
    return (json.results ?? []).map((r) => mapTicket(r, this.subdomain));
  }

  /**
   * Fetch a single ticket and its comments in parallel.
   * Non-OK on either request throws `ZendeskApiError(status)`.
   */
  async getTicket(id: number): Promise<{ ticket: ZendeskTicket; comments: ZendeskComment[] }> {
    const [ticketRes, commentsRes] = await Promise.all([
      this.fetchImpl(`${this.base}/tickets/${id}.json`, {
        headers: { Authorization: this.authHeader, Accept: 'application/json' },
      }),
      this.fetchImpl(`${this.base}/tickets/${id}/comments.json`, {
        headers: { Authorization: this.authHeader, Accept: 'application/json' },
      }),
    ]);
    if (!ticketRes.ok) throw new ZendeskApiError(ticketRes.status);
    if (!commentsRes.ok) throw new ZendeskApiError(commentsRes.status);

    const ticketJson = (await ticketRes.json()) as { ticket?: RawTicket };
    const commentsJson = (await commentsRes.json()) as { comments?: RawComment[] };

    const raw = ticketJson.ticket;
    if (!raw) throw new ZendeskApiError(500, 'Zendesk returned no ticket data');

    return {
      ticket: mapTicket(raw, this.subdomain),
      comments: (commentsJson.comments ?? []).map(mapComment),
    };
  }
}
