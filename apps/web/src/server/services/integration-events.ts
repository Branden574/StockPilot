import 'server-only';

import { createHmac, randomBytes } from 'node:crypto';

import { reportError } from '@/lib/error-reporter';
import { safeFetch, SsrfBlockedError } from '@/lib/ssrf-guard';
import { createAdminClient } from '@/lib/supabase/admin';

import {
  assertModuleEnabled,
  assertPermission,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';

/**
 * Outbound event delivery — the engine behind generic webhooks + Slack/Teams
 * alerts (migration 0169). Domain code calls `dispatchEvent(org, type, payload)`
 * (best-effort, never throws); it persists one `integration_deliveries` row per
 * subscribed endpoint (durable outbox) and attempts immediate delivery. The
 * every-5-min drain-outbox cron calls `drainIntegrationDeliveries` to retry
 * failures with exponential backoff (→ 'dead' at max_attempts).
 *
 * Webhooks are HMAC-SHA256 signed (Stripe-style `t=…,v1=…`) and delivered via
 * the SSRF-hardened `safeFetch` (blocks localhost/RFC-1918/metadata IPs +
 * DNS-rebinding). Slack/Teams post a formatted message to their incoming-webhook
 * URL. Outbound only — nothing here ingests data into StockPilot.
 */

export const INTEGRATION_EVENT_TYPES = [
  'stock.low',
  'order.created',
  'order.status_changed',
  'order.completed',
  'po.created',
  'po.received',
  'return.created',
  'cycle_count.completed',
  // Security feed (cybersecurity monitoring Phase 1, 2026-06-12): forensic-
  // relevant account/credential events an org admin wants in a #security
  // channel in real time. Payloads carry NO secrets — names/prefixes/roles
  // only (the delivery body lands in third-party Slack/Teams/webhook infra).
  'security.new_device_login',
  'security.mfa_unenrolled',
  'security.mfa_policy_changed',
  'security.api_key_created',
  'security.api_key_revoked',
  'security.member_role_changed',
  'security.export_rate_limited',
] as const;

export type IntegrationEventType = (typeof INTEGRATION_EVENT_TYPES)[number];

export type EndpointType = 'webhook' | 'slack' | 'teams';

const MAX_ATTEMPTS = 6;
const DELIVERY_TIMEOUT_MS = 8000;
/** Backoff: ~1m, 2m, 4m, 8m, 16m, capped at 30m. */
function backoffMs(attempt: number): number {
  return Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));
}

interface EndpointRow {
  id: string;
  organization_id: string;
  type: EndpointType;
  url: string;
  secret: string | null;
}

interface DeliveryRow {
  id: string;
  endpoint_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

type Admin = ReturnType<typeof createAdminClient>;

// ── Event → human-readable copy (for Slack/Teams cards) ─────────────────────
export function describeEvent(eventType: string, data: Record<string, unknown>): { title: string; summary: string } {
  const s = (k: string) => (typeof data[k] === 'string' ? (data[k] as string) : undefined);
  const n = (k: string) => (typeof data[k] === 'number' ? (data[k] as number) : undefined);
  switch (eventType) {
    case 'stock.low':
      return {
        title: '⚠️ Low stock',
        summary: `${s('name') ?? 'An item'}${s('sku') ? ` (${s('sku')})` : ''} is at ${n('quantity') ?? '?'} — at/under its reorder point${n('reorderPoint') != null ? ` of ${n('reorderPoint')}` : ''}.`,
      };
    case 'order.created':
      return { title: '🧾 New order', summary: `Order ${s('orderNumber') ?? s('id') ?? ''} was created${s('requester') ? ` by ${s('requester')}` : ''}.` };
    case 'order.status_changed':
      return { title: '🔄 Order updated', summary: `Order ${s('orderNumber') ?? s('id') ?? ''} → ${s('status') ?? 'updated'}.` };
    case 'order.completed':
      return { title: '✅ Order delivered', summary: `Order ${s('orderNumber') ?? s('id') ?? ''} was completed.` };
    case 'po.created':
      return { title: '📦 New purchase order', summary: `PO ${s('poNumber') ?? s('id') ?? ''} created${s('supplier') ? ` for ${s('supplier')}` : ''}.` };
    case 'po.received':
      return { title: '📥 PO received', summary: `PO ${s('poNumber') ?? s('id') ?? ''} was received.` };
    case 'return.created':
      return { title: '↩️ Return started', summary: `A return was started${s('orderNumber') ? ` for order ${s('orderNumber')}` : ''}.` };
    case 'cycle_count.completed':
      return { title: '🔢 Cycle count complete', summary: `A cycle count finished${s('warehouse') ? ` at ${s('warehouse')}` : ''}.` };
    case 'security.new_device_login':
      return {
        title: '🔐 New device sign-in',
        summary: `${s('email') ?? 'A member'} signed in from a device we haven't seen before${s('device') ? ` (${s('device')})` : ''}${s('ip') ? ` — IP ${s('ip')}` : ''}.`,
      };
    case 'security.mfa_unenrolled':
      return {
        title: '🚨 MFA disabled',
        summary: `${s('email') ?? 'A member'} removed their two-factor authentication. If this wasn't expected, review their account now.`,
      };
    case 'security.mfa_policy_changed':
      return {
        title: '🛡️ MFA policy changed',
        summary: `The organization MFA policy changed${s('from') ? ` from "${s('from')}"` : ''}${s('to') ? ` to "${s('to')}"` : ''}${s('email') ? ` (by ${s('email')})` : ''}.`,
      };
    case 'security.api_key_created':
      return {
        title: '🔑 API key created',
        summary: `A new API key "${s('name') ?? ''}"${s('prefix') ? ` (${s('prefix')}…)` : ''} was created${s('scopes') ? ` with scopes: ${s('scopes')}` : ''}.`,
      };
    case 'security.api_key_revoked':
      return { title: '🔑 API key revoked', summary: `An API key was revoked${s('name') ? ` ("${s('name')}")` : ''}.` };
    case 'security.member_role_changed':
      return {
        title: '🛡️ Member role changed',
        summary: `A member's role changed${s('from') ? ` from ${s('from')}` : ''}${s('to') ? ` to ${s('to')}` : ''}.`,
      };
    case 'security.export_rate_limited':
      return {
        title: '🚨 Export rate limit tripped',
        summary: `${s('email') ?? 'A member'} hit the bulk-export rate limit (40/hr) — possible scripted data exfiltration; review their recent activity.`,
      };
    case 'test.ping':
      return { title: '✅ StockPilot test', summary: 'Your alerts are connected — this is a test event.' };
    default:
      return { title: 'StockPilot event', summary: eventType };
  }
}

// ── Per-type request builders ───────────────────────────────────────────────
export function buildRequest(
  endpoint: EndpointRow,
  eventType: string,
  envelope: Record<string, unknown>,
): { body: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (endpoint.type === 'slack' || endpoint.type === 'teams') {
    const { title, summary } = describeEvent(eventType, (envelope.data as Record<string, unknown>) ?? {});
    // Slack: `text` renders mrkdwn. Teams: incoming webhook also accepts `{text}`
    // (markdown-ish). Keep it one shape that both accept.
    return { body: JSON.stringify({ text: `*${title}*\n${summary}` }), headers };
  }
  // Generic webhook: full signed JSON envelope.
  const body = JSON.stringify(envelope);
  if (endpoint.secret) {
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', endpoint.secret).update(`${ts}.${body}`).digest('hex');
    headers['X-StockPilot-Signature'] = `t=${ts},v1=${sig}`;
    headers['X-StockPilot-Event'] = eventType;
  }
  return { body, headers };
}

/** Exported for tests: deterministic signature over a known body. */
export function signWebhook(secret: string, body: string, ts: number): string {
  return `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
}

// ── Send one delivery + update its row ──────────────────────────────────────
async function attemptDelivery(admin: Admin, endpoint: EndpointRow, delivery: DeliveryRow): Promise<boolean> {
  const envelope = {
    id: delivery.id,
    event: delivery.event_type,
    organization_id: endpoint.organization_id,
    created_at: new Date().toISOString(),
    data: delivery.payload,
  };
  const { body, headers } = buildRequest(endpoint, delivery.event_type, envelope);

  let ok = false;
  let code: number | null = null;
  let errorMsg: string | null = null;
  try {
    const res = await safeFetch(endpoint.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    code = res.status;
    ok = res.status >= 200 && res.status < 300;
    if (!ok) errorMsg = `HTTP ${res.status}`;
  } catch (e) {
    // SSRF block is terminal (don't retry a poisoned URL); network errors retry.
    errorMsg = e instanceof Error ? e.message : 'delivery failed';
    if (e instanceof SsrfBlockedError) {
      await finalize(admin, endpoint, delivery, { ok: false, code: null, error: errorMsg, dead: true });
      return false;
    }
  }
  await finalize(admin, endpoint, delivery, { ok, code, error: errorMsg, dead: false });
  return ok;
}

async function finalize(
  admin: Admin,
  endpoint: EndpointRow,
  delivery: DeliveryRow,
  r: { ok: boolean; code: number | null; error: string | null; dead: boolean },
): Promise<void> {
  const attempts = delivery.attempts + 1;
  const nowIso = new Date().toISOString();
  const status = r.ok
    ? 'success'
    : r.dead || attempts >= (delivery.max_attempts || MAX_ATTEMPTS)
      ? 'dead'
      : 'failed'; // 'failed' is retryable; the drain re-queues by next_attempt_at
  const patch: Record<string, unknown> = {
    status: status === 'failed' ? 'pending' : status, // keep retryable rows 'pending' for the drain
    attempts,
    response_code: r.code,
    error: r.error,
    delivered_at: r.ok ? nowIso : null,
    next_attempt_at: r.ok || r.dead ? nowIso : new Date(Date.now() + backoffMs(attempts)).toISOString(),
  };
  await admin.from('integration_deliveries').update(patch).eq('id', delivery.id);
  await admin
    .from('integration_endpoints')
    .update({ last_delivery_at: nowIso, last_status: r.ok ? 'success' : (r.error ?? 'failed') })
    .eq('id', endpoint.id);
}

/**
 * Fan a domain event out to every enabled endpoint subscribed to it. Best-effort
 * + never throws — the calling write path must not fail because delivery setup
 * hiccuped. Persists a pending delivery row per endpoint (durable), then fires
 * an immediate attempt; the cron retries anything still pending.
 *
 * Call via `after(() => dispatchEvent(...))` (or `void`) so it's off the
 * response path.
 */
export async function dispatchEvent(
  organizationId: string,
  eventType: IntegrationEventType,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: endpoints, error } = await admin
      .from('integration_endpoints')
      .select('id, organization_id, type, url, secret')
      .eq('organization_id', organizationId)
      .eq('enabled', true)
      .contains('event_types', [eventType]);
    if (error || !endpoints || endpoints.length === 0) return;

    // Batch-insert one pending delivery per endpoint (single round trip), then
    // fire the immediate attempts in PARALLEL. Previously this was a per-endpoint
    // insert + sequential await — O(N) round trips that blocked each other on the
    // 8s delivery timeout (audit 2026-06-09). Failures stay 'pending' for the cron.
    const eps = endpoints as EndpointRow[];
    const { data: rows, error: insErr } = await admin
      .from('integration_deliveries')
      .insert(
        eps.map((ep) => ({
          organization_id: organizationId,
          endpoint_id: ep.id,
          event_type: eventType,
          payload: data,
          status: 'pending',
          max_attempts: MAX_ATTEMPTS,
        })),
      )
      .select('id, endpoint_id, event_type, payload, attempts, max_attempts');
    if (insErr || !rows || rows.length === 0) return;
    const epById = new Map(eps.map((e) => [e.id, e]));
    await Promise.allSettled(
      (rows as DeliveryRow[]).map((row) => {
        const ep = epById.get(row.endpoint_id);
        return ep ? attemptDelivery(admin, ep, row) : Promise.resolve(false);
      }),
    );
  } catch (e) {
    void reportError(e, { tag: 'integration-events.dispatch', extra: { eventType } });
  }
}

/**
 * Cron entry: deliver due pending rows (oldest first), retrying with backoff.
 * Called from the drain-outbox cron. Returns a small summary; never throws.
 */
export async function drainIntegrationDeliveries(
  admin: Admin,
  now: Date = new Date(),
  limit = 100,
): Promise<{ attempted: number; delivered: number }> {
  let attempted = 0;
  let delivered = 0;
  try {
    const { data: due } = await admin
      .from('integration_deliveries')
      .select('id, endpoint_id, event_type, payload, attempts, max_attempts')
      .eq('status', 'pending')
      .lte('next_attempt_at', now.toISOString())
      .order('next_attempt_at', { ascending: true })
      .limit(limit);
    if (!due || due.length === 0) return { attempted, delivered };

    // Batch-load the endpoints for the due rows.
    const endpointIds = Array.from(new Set(due.map((d) => (d as DeliveryRow).endpoint_id)));
    const { data: eps } = await admin
      .from('integration_endpoints')
      .select('id, organization_id, type, url, secret')
      .in('id', endpointIds);
    const epById = new Map((eps ?? []).map((e) => [(e as EndpointRow).id, e as EndpointRow]));

    // Partition into deliverable rows vs orphans (endpoint deleted out-of-band).
    const live: DeliveryRow[] = [];
    const deadIds: string[] = [];
    for (const d of due as DeliveryRow[]) {
      if (epById.has(d.endpoint_id)) live.push(d);
      else deadIds.push(d.id);
    }
    // ONE batch update for all orphans (was a sequential per-row update).
    if (deadIds.length > 0) {
      await admin
        .from('integration_deliveries')
        .update({ status: 'dead', error: 'endpoint removed' })
        .in('id', deadIds);
    }
    // Attempt all due deliveries in PARALLEL (was sequential — a single slow/hung
    // webhook blocked every later row for up to the 8s timeout). limit caps the
    // fan-out per tick (audit 2026-06-09).
    const results = await Promise.allSettled(
      live.map((d) => attemptDelivery(admin, epById.get(d.endpoint_id)!, d)),
    );
    attempted = live.length;
    delivered = results.filter((r) => r.status === 'fulfilled' && r.value === true).length;
  } catch (e) {
    void reportError(e, { tag: 'integration-events.drain' });
  }
  return { attempted, delivered };
}

// ── One-off test delivery (sends a synthetic event; persists no row) ─────────
export async function sendTest(endpoint: {
  type: EndpointType;
  url: string;
  secret: string | null;
}): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  const envelope = {
    id: 'test',
    event: 'test.ping',
    organization_id: 'test',
    created_at: new Date().toISOString(),
    data: { message: 'StockPilot test event' },
  };
  const { body, headers } = buildRequest(
    { id: 'test', organization_id: 'test', type: endpoint.type, url: endpoint.url, secret: endpoint.secret },
    'test.ping',
    envelope,
  );
  try {
    const res = await safeFetch(endpoint.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    const ok = res.status >= 200 && res.status < 300;
    return { ok, status: res.status, error: ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, status: null, error: e instanceof Error ? e.message : 'delivery failed' };
  }
}

// ── Admin-managed endpoint CRUD ──────────────────────────────────────────────
export interface ManagedEndpoint {
  id: string;
  type: EndpointType;
  url: string;
  eventTypes: string[];
  enabled: boolean;
  description: string | null;
  createdAt: string;
  lastDeliveryAt: string | null;
  lastStatus: string | null;
  hasSecret: boolean;
}

export class IntegrationEndpointsService {
  constructor(private readonly ctx: ServiceContext) {}
  static async forCurrentUser() {
    return new IntegrationEndpointsService(await withContext());
  }

  /** integrations module + admin-level manage permission (matches the RLS floor). */
  private gate() {
    assertModuleEnabled(this.ctx, 'integrations');
    assertPermission(this.ctx, 'integrations:manage');
  }

  async list(): Promise<ManagedEndpoint[]> {
    this.gate();
    const { data, error } = await this.ctx.supabase
      .from('integration_endpoints')
      .select(
        'id, type, url, event_types, enabled, description, created_at, last_delivery_at, last_status, secret',
      )
      .eq('organization_id', this.ctx.organizationId)
      .order('created_at', { ascending: false });
    if (error) throw new ServiceError('internal_error', error.message);
    return (data ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      return {
        id: row.id as string,
        type: row.type as EndpointType,
        url: row.url as string,
        eventTypes: (row.event_types as string[] | null) ?? [],
        enabled: Boolean(row.enabled),
        description: (row.description as string | null) ?? null,
        createdAt: row.created_at as string,
        lastDeliveryAt: (row.last_delivery_at as string | null) ?? null,
        lastStatus: (row.last_status as string | null) ?? null,
        hasSecret: Boolean(row.secret),
      };
    });
  }

  async create(input: {
    type: EndpointType;
    url: string;
    eventTypes: string[];
    description?: string | null;
  }): Promise<{ id: string; secret: string | null }> {
    this.gate();
    if (!['webhook', 'slack', 'teams'].includes(input.type)) {
      throw new ServiceError('validation_error', 'Unknown endpoint type.');
    }
    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      throw new ServiceError('validation_error', 'Enter a valid URL.');
    }
    if (parsed.protocol !== 'https:') {
      throw new ServiceError('validation_error', 'The URL must use https://.');
    }
    const events = input.eventTypes.filter((e) =>
      (INTEGRATION_EVENT_TYPES as readonly string[]).includes(e),
    );
    if (events.length === 0) {
      throw new ServiceError('validation_error', 'Choose at least one event to send.');
    }
    // Webhooks get an HMAC signing secret (shown once); Slack/Teams authenticate
    // via their unguessable incoming-webhook URL.
    const secret = input.type === 'webhook' ? `whsec_${randomBytes(24).toString('hex')}` : null;
    const { data, error } = await this.ctx.supabase
      .from('integration_endpoints')
      .insert({
        organization_id: this.ctx.organizationId,
        type: input.type,
        url: input.url,
        secret,
        event_types: events,
        description: input.description?.trim() || null,
        created_by: this.ctx.userId,
      })
      .select('id')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    return { id: (data as { id: string }).id, secret };
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    this.gate();
    const { error } = await this.ctx.supabase
      .from('integration_endpoints')
      .update({ enabled, updated_at: new Date().toISOString() })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
  }

  async remove(id: string): Promise<void> {
    this.gate();
    const { error } = await this.ctx.supabase
      .from('integration_endpoints')
      .delete()
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
  }

  async rotateSecret(id: string): Promise<{ secret: string }> {
    this.gate();
    const secret = `whsec_${randomBytes(24).toString('hex')}`;
    const { error } = await this.ctx.supabase
      .from('integration_endpoints')
      .update({ secret, updated_at: new Date().toISOString() })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .eq('type', 'webhook');
    if (error) throw new ServiceError('internal_error', error.message);
    return { secret };
  }

  async test(id: string): Promise<{ ok: boolean; status: number | null; error: string | null }> {
    this.gate();
    const { data, error } = await this.ctx.supabase
      .from('integration_endpoints')
      .select('type, url, secret')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Endpoint not found.');
    const row = data as { type: EndpointType; url: string; secret: string | null };
    return sendTest({ type: row.type, url: row.url, secret: row.secret ?? null });
  }
}
