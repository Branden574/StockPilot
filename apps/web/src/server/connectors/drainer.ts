import 'server-only';

import type {
  Connector,
  ConnectionRef,
  ConnectorProviderId,
  OutboxEvent,
} from '@stockpilot/core';

import { getConnectionSecret, putConnectionSecret } from './secret-store';

/**
 * Max delivery attempts per (connection, outbox_event) before the row is
 * dead-lettered (status='dead' in connection_sync_log). Kept small + finite so
 * a permanently-failing event can't spin forever each cron tick.
 */
export const MAX_ATTEMPTS = 8;

/**
 * Exponential backoff (ms) for the next delivery attempt, capped at 1h.
 *
 * Jitter is DETERMINISTIC — derived from the attempt number, never
 * Math.random() — so the function is pure and unit-testable. The Knuth
 * multiplicative hash (2654435761) spreads consecutive attempt numbers across
 * the jitter band, giving roughly ±12.5% spread around the base delay without
 * any randomness.
 */
export function nextBackoff(attempt: number): number {
  const base = Math.min(60 * 60 * 1000, 2 ** attempt * 1000); // cap 1h
  const jitter = base * 0.25 * ((attempt * 2654435761) % 1000 / 1000); // deterministic-ish jitter (no Math.random)
  return Math.round(base - base * 0.125 + jitter);
}

export interface DrainResult {
  processed: number;
  succeeded: number;
  failed: number;
  deadlettered: number;
}

/**
 * Drains the transactional outbox into every active connector.
 *
 * Fan-out semantics: multiple connectors may each consume the same
 * `outbox_events` row, so delivery is tracked per (connection_id,
 * outbox_event_id) in `connection_sync_log` — we NEVER touch
 * `outbox_events.published_at` (that flag is owned by the single-consumer
 * legacy path; flipping it here would silently starve other connectors).
 *
 * Idempotency + backoff:
 *  - skip events already 'success' or 'dead' for this connection
 *  - skip 'error' rows whose next_attempt_at is still in the future
 *  - on failure, schedule nextBackoff(attempts); dead-letter at MAX_ATTEMPTS
 *
 * Tokens are refreshed (when the connector supports it) if they expire within
 * 5 minutes, then re-persisted to Vault via putConnectionSecret. Full tokens
 * are never logged.
 *
 * `now` is injected so the orchestrator stays testable; app runtime passes
 * `new Date()`.
 */
export async function runDrain(
  admin: { from: (t: string) => any; rpc: (...args: any[]) => any },
  connectors: Partial<Record<ConnectorProviderId, Connector>>,
  now: Date,
): Promise<DrainResult> {
  const res: DrainResult = { processed: 0, succeeded: 0, failed: 0, deadlettered: 0 };
  // 1. active connections
  const { data: conns } = await admin.from('org_connections').select('*').eq('status', 'active');
  for (const c of (conns ?? []) as any[]) {
    const connector = connectors[c.provider_id as ConnectorProviderId];
    if (!connector) continue;
    const conn: ConnectionRef = {
      id: c.id,
      organizationId: c.organization_id,
      providerId: c.provider_id,
      status: c.status,
      externalAccountId: c.external_account_id,
      settings: c.settings ?? {},
    };
    // 2. candidate outbox events for this org with subscribed topics, not yet succeeded.
    const { data: events } = await admin
      .from('outbox_events')
      .select('*')
      .eq('organization_id', c.organization_id)
      .in('topic', connector.subscribedTopics)
      .order('created_at', { ascending: true })
      .limit(200);
    for (const e of (events ?? []) as any[]) {
      // skip if a success/dead log row exists, or an error row not yet due
      const { data: existing } = await admin
        .from('connection_sync_log')
        .select('*')
        .eq('connection_id', conn.id)
        .eq('outbox_event_id', e.id)
        .maybeSingle();
      if (existing && (existing.status === 'success' || existing.status === 'dead')) continue;
      if (
        existing &&
        existing.status === 'error' &&
        existing.next_attempt_at &&
        new Date(existing.next_attempt_at) > now
      )
        continue;
      const attempts = (existing?.attempts ?? 0) + 1;
      res.processed++;
      // upsert pending row
      await admin.from('connection_sync_log').upsert(
        {
          connection_id: conn.id,
          organization_id: conn.organizationId,
          outbox_event_id: e.id,
          topic: e.topic,
          status: 'pending',
          attempts,
          updated_at: now.toISOString(),
        },
        { onConflict: 'connection_id,outbox_event_id' },
      );
      try {
        const event: OutboxEvent = {
          id: e.id,
          organizationId: e.organization_id,
          topic: e.topic,
          aggregateType: e.aggregate_type,
          aggregateId: e.aggregate_id,
          payload: e.payload ?? {},
          dedupeKey: e.dedupe_key,
          createdAt: e.created_at,
        };
        let secrets = await getConnectionSecret(admin as any, c.secret_id);
        if (
          connector.refreshAuth &&
          new Date(secrets.expiresAt).getTime() < now.getTime() + 5 * 60 * 1000
        ) {
          secrets = await connector.refreshAuth(conn, secrets);
          await putConnectionSecret(admin as any, `connector:${conn.id}`, secrets);
        }
        const out = await connector.handleOutboxEvent(event, conn, secrets, makeDeps(admin));
        if (out.ok) {
          await admin
            .from('connection_sync_log')
            .update({
              status: 'success',
              external_id: out.externalId ?? null,
              completed_at: now.toISOString(),
              updated_at: now.toISOString(),
            })
            .eq('connection_id', conn.id)
            .eq('outbox_event_id', e.id);
          await admin
            .from('org_connections')
            .update({ last_synced_at: now.toISOString(), last_error: null })
            .eq('id', conn.id);
          res.succeeded++;
        } else {
          const dead = attempts >= MAX_ATTEMPTS;
          await admin
            .from('connection_sync_log')
            .update({
              status: dead ? 'dead' : 'error',
              last_error: out.error ?? 'unknown',
              next_attempt_at: new Date(now.getTime() + nextBackoff(attempts)).toISOString(),
              updated_at: now.toISOString(),
            })
            .eq('connection_id', conn.id)
            .eq('outbox_event_id', e.id);
          if (dead) res.deadlettered++;
          else res.failed++;
        }
      } catch (err) {
        const dead = attempts >= MAX_ATTEMPTS;
        await admin
          .from('connection_sync_log')
          .update({
            status: dead ? 'dead' : 'error',
            last_error: err instanceof Error ? err.message : 'error',
            next_attempt_at: new Date(now.getTime() + nextBackoff(attempts)).toISOString(),
            updated_at: now.toISOString(),
          })
          .eq('connection_id', conn.id)
          .eq('outbox_event_id', e.id);
        if (dead) res.deadlettered++;
        else res.failed++;
      }
    }
  }
  return res;
}

/**
 * Builds the injected service-layer seam handed to each connector. Keeps the
 * connector implementations free of the supabase dependency and unit-testable.
 */
export function makeDeps(admin: any) {
  return {
    admin,
    fetch,
    async getMapping(connectionId: string, entityType: string, localId: string | null) {
      let q = admin
        .from('connection_mappings')
        .select('external_id, external_meta')
        .eq('connection_id', connectionId)
        .eq('entity_type', entityType);
      q = localId === null ? q.is('local_id', null) : q.eq('local_id', localId);
      const { data } = await q.maybeSingle();
      return data
        ? { externalId: data.external_id, externalMeta: data.external_meta ?? {} }
        : null;
    },
    async putMapping(
      connectionId: string,
      organizationId: string,
      entityType: string,
      localId: string | null,
      externalId: string,
      externalMeta: Record<string, unknown> = {},
    ) {
      await admin.from('connection_mappings').upsert(
        {
          connection_id: connectionId,
          organization_id: organizationId,
          entity_type: entityType,
          local_id: localId,
          external_id: externalId,
          external_meta: externalMeta,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'connection_id,entity_type,local_id' },
      );
    },
  };
}
