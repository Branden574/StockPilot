import 'server-only';

import type {
  Connector,
  ConnectionRef,
  ConnectorProviderId,
  OutboxEvent,
} from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';

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
 *
 * NOTE: the 1h cap is currently unreachable — nextBackoff(MAX_ATTEMPTS=8) is
 * ~3.8min, so the Math.min cap is dead code for the present config. It only
 * goes live if MAX_ATTEMPTS grows past ~12 (2**22 ms > 1h). Kept as defensive
 * code so growing MAX_ATTEMPTS can't blow the delay out to days.
 */
export function nextBackoff(attempt: number): number {
  const base = Math.min(60 * 60 * 1000, 2 ** attempt * 1000); // cap 1h (see note above)
  const jitter = base * 0.25 * ((attempt * 2654435761) % 1000 / 1000); // deterministic-ish jitter (no Math.random)
  return Math.round(base - base * 0.125 + jitter);
}

/**
 * How many candidate outbox events to consider per connection per tick. The
 * candidate set is computed SERVER-SIDE by the connector_drain_candidates RPC
 * (migration 0148): oldest-first events for the org+topics that are NOT yet
 * terminal (success/dead) for this connection AND not an error row still inside
 * its backoff window. Because the RPC bounds the result by work-REMAINING (this
 * limit) rather than work-DONE, the window always advances and there is no
 * unbounded NOT-IN exclusion list to truncate or blow the request URL.
 */
const CANDIDATE_LIMIT = 200;

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
 *  - the candidate window is computed by the connector_drain_candidates RPC,
 *    which EXCLUDES events terminal (success/dead) for this connection AND error
 *    rows still inside their backoff window, ordered oldest-first and bounded by
 *    work-remaining (CANDIDATE_LIMIT). The window advances instead of re-scanning
 *    an already-delivered head of the queue (head-of-line starvation fix), with
 *    no unbounded NOT-IN list that could truncate at PostgREST's max-rows cap
 *  - per event, defensively re-check the ledger: skip a 'success'/'dead' row,
 *    and skip 'error' rows whose next_attempt_at is still in the future
 *  - on failure, schedule nextBackoff(attempts); dead-letter at MAX_ATTEMPTS
 *
 * Error handling is FAIL-CLOSED (mirrors services/digest.ts which throws on any
 * query error): a failed top-level select throws so the cron route returns 500
 * (a masked DB outage is worse than a visible one). A failed ledger write
 * (pending upsert / success / error update) is reported via reportError and the
 * event is skipped/counted-failed rather than proceeding as if the write
 * succeeded — a silently-lost 'success' write would otherwise re-dispatch the
 * already-delivered side effect next tick.
 *
 * Tokens are refreshed (when the connector supports it) if they expire within
 * 5 minutes, then re-persisted to Vault via putConnectionSecret; the returned
 * Vault id is written back to org_connections.secret_id so the next tick reads
 * the rotated secret (no orphaned-secret / refresh-loop). Full tokens are never
 * logged.
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
  // 1. active connections. Fail-closed (throw) on a query error so a DB outage
  //    surfaces as a 500 instead of a silent {processed:0}.
  const { data: conns, error: connsErr } = await admin
    .from('org_connections')
    .select('*')
    .eq('status', 'active');
  if (connsErr) throw new Error(`org_connections select: ${connsErr.message}`);
  for (const c of (conns ?? []) as any[]) {
    const connector = connectors[c.provider_id as ConnectorProviderId];
    if (!connector) continue;
    // An 'active' connection with no Vault secret handle is malformed — the
    // OAuth flow must have set secret_id. Skip (and report) rather than calling
    // getConnectionSecret(undefined) and throwing the whole run.
    if (!c.secret_id) {
      void reportError(new Error('active connection missing secret_id'), {
        tag: 'cron.drain-outbox.connection',
        extra: { connectionId: c.id, providerId: c.provider_id },
      });
      continue;
    }
    const conn: ConnectionRef = {
      id: c.id,
      organizationId: c.organization_id,
      providerId: c.provider_id,
      status: c.status,
      externalAccountId: c.external_account_id,
      settings: c.settings ?? {},
    };

    // 2. candidate outbox events for this org on subscribed topics. Computed
    //    server-side by connector_drain_candidates (SECURITY DEFINER, migration
    //    0148): oldest-first, EXCLUDING events terminal (success/dead) for this
    //    connection AND error rows still inside their backoff window, bounded by
    //    CANDIDATE_LIMIT. Bounding by work-REMAINING (not a NOT-IN list of all
    //    work-done) means the window advances and can never truncate at the
    //    PostgREST max-rows cap (head-of-line starvation fix). Fail-closed.
    const { data: events, error: eventsErr } = await admin.rpc('connector_drain_candidates', {
      p_connection_id: conn.id,
      p_organization_id: c.organization_id,
      p_topics: connector.subscribedTopics,
      p_now: now.toISOString(),
      p_limit: CANDIDATE_LIMIT,
    });
    if (eventsErr) throw new Error(`connector_drain_candidates: ${eventsErr.message}`);

    for (const e of (events ?? []) as any[]) {
      // The candidate set already excludes terminal rows; we still point-read
      // the ledger to recover the attempt count + the backoff gate for 'error'.
      const { data: existing, error: existingErr } = await admin
        .from('connection_sync_log')
        .select('*')
        .eq('connection_id', conn.id)
        .eq('outbox_event_id', e.id)
        .maybeSingle();
      if (existingErr) throw new Error(`connection_sync_log select: ${existingErr.message}`);
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
      // Upsert the pending row. If THIS write fails we must NOT fire the
      // connector — a lost pending row means a lost terminal row later, which
      // would re-dispatch the external side effect every tick with no backoff.
      const { error: pendingErr } = await admin.from('connection_sync_log').upsert(
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
      if (pendingErr) {
        void reportError(new Error(`connection_sync_log upsert: ${pendingErr.message}`), {
          tag: 'cron.drain-outbox.pending',
          extra: { connectionId: conn.id, eventId: e.id },
        });
        res.failed++;
        continue;
      }
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
          const newSecretId = await putConnectionSecret(
            admin as any,
            `connector:${conn.id}`,
            secrets,
          );
          // Write the (possibly new) Vault id back so the next tick reads the
          // rotated secret. connector_secret_put upserts by NAME and may return
          // a fresh id; without this the connection keeps pointing at the stale
          // (now-expiring) secret → refresh loop + orphaned Vault rows.
          if (newSecretId && newSecretId !== c.secret_id) {
            const { error: secretIdErr } = await admin
              .from('org_connections')
              .update({ secret_id: newSecretId, updated_at: now.toISOString() })
              .eq('id', conn.id);
            if (secretIdErr) {
              void reportError(
                new Error(`org_connections secret_id update: ${secretIdErr.message}`),
                {
                  tag: 'cron.drain-outbox.secret-rotate',
                  extra: { connectionId: conn.id },
                },
              );
            } else {
              c.secret_id = newSecretId;
            }
          }
        }
        const out = await connector.handleOutboxEvent(event, conn, secrets, makeDeps(admin));
        if (out.ok) {
          const { error: successErr } = await admin
            .from('connection_sync_log')
            .update({
              status: 'success',
              external_id: out.externalId ?? null,
              completed_at: now.toISOString(),
              updated_at: now.toISOString(),
            })
            .eq('connection_id', conn.id)
            .eq('outbox_event_id', e.id);
          if (successErr) {
            // The external side effect already fired but we couldn't record it.
            // Report loudly — next tick will re-dispatch (only safe if the
            // connector is idempotent via connection_mappings).
            void reportError(new Error(`connection_sync_log success update: ${successErr.message}`), {
              tag: 'cron.drain-outbox.success',
              extra: { connectionId: conn.id, eventId: e.id },
            });
          }
          await admin
            .from('org_connections')
            .update({ last_synced_at: now.toISOString(), last_error: null })
            .eq('id', conn.id);
          res.succeeded++;
        } else {
          const dead = attempts >= MAX_ATTEMPTS;
          const { error: errUpdateErr } = await admin
            .from('connection_sync_log')
            .update({
              status: dead ? 'dead' : 'error',
              last_error: out.error ?? 'unknown',
              next_attempt_at: new Date(now.getTime() + nextBackoff(attempts)).toISOString(),
              updated_at: now.toISOString(),
            })
            .eq('connection_id', conn.id)
            .eq('outbox_event_id', e.id);
          if (errUpdateErr) {
            // A failed 'error' write leaves no backoff row → re-dispatch every
            // tick with no delay. Report so it's visible.
            void reportError(new Error(`connection_sync_log error update: ${errUpdateErr.message}`), {
              tag: 'cron.drain-outbox.error',
              extra: { connectionId: conn.id, eventId: e.id },
            });
          }
          if (dead) res.deadlettered++;
          else res.failed++;
        }
      } catch (err) {
        const dead = attempts >= MAX_ATTEMPTS;
        const { error: catchUpdateErr } = await admin
          .from('connection_sync_log')
          .update({
            status: dead ? 'dead' : 'error',
            last_error: err instanceof Error ? err.message : 'error',
            next_attempt_at: new Date(now.getTime() + nextBackoff(attempts)).toISOString(),
            updated_at: now.toISOString(),
          })
          .eq('connection_id', conn.id)
          .eq('outbox_event_id', e.id);
        if (catchUpdateErr) {
          void reportError(new Error(`connection_sync_log error update: ${catchUpdateErr.message}`), {
            tag: 'cron.drain-outbox.error',
            extra: { connectionId: conn.id, eventId: e.id },
          });
        }
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
function makeDeps(admin: any) {
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
