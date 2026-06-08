import 'server-only';

import { createHmac } from 'node:crypto';

import { reportError } from '@/lib/error-reporter';
import { safeFetch, SsrfBlockedError } from '@/lib/ssrf-guard';
import { createAdminClient } from '@/lib/supabase/admin';

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

    for (const ep of endpoints as EndpointRow[]) {
      const { data: inserted, error: insErr } = await admin
        .from('integration_deliveries')
        .insert({
          organization_id: organizationId,
          endpoint_id: ep.id,
          event_type: eventType,
          payload: data,
          status: 'pending',
          max_attempts: MAX_ATTEMPTS,
        })
        .select('id, endpoint_id, event_type, payload, attempts, max_attempts')
        .single();
      if (insErr || !inserted) continue;
      // Immediate attempt (best-effort); failures stay 'pending' for the cron.
      await attemptDelivery(admin, ep, inserted as DeliveryRow).catch(() => {});
    }
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

    for (const d of due as DeliveryRow[]) {
      const ep = epById.get(d.endpoint_id);
      if (!ep) {
        // Endpoint deleted out from under a pending delivery → mark dead.
        await admin.from('integration_deliveries').update({ status: 'dead', error: 'endpoint removed' }).eq('id', d.id);
        continue;
      }
      attempted += 1;
      const ok = await attemptDelivery(admin, ep, d).catch(() => false);
      if (ok) delivered += 1;
    }
  } catch (e) {
    void reportError(e, { tag: 'integration-events.drain' });
  }
  return { attempted, delivered };
}
