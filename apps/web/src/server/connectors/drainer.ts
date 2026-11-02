import 'server-only';

import type {
  Connector,
  ConnectionRef,
  ConnectorProviderId,
  OutboxEvent,
} from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';
import { fetchAllRowsByIds, rawErrorText } from '@/server/services/lib/fetch-by-ids';
import { ListReadError, listRows } from '@/server/services/lib/list-rows';
import { postgrestErrorText } from '@/server/services/lib/postgrest-error';

import { MappingReadError } from './mapping-read-error';
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

/**
 * How long after the drain-outbox cron starts its work must be done (docket
 * B81). The route has maxDuration 60: nothing is started that could not finish
 * by this long after the route starts, and the last 10 s stay spare for the
 * response and a cold start. The route hands this deadline to the export
 * drain and the monthly valuation; the webhook drain runs first, inside its
 * own share of the run (integration-events.ts WEBHOOK_DRAIN_SHARE_MS).
 */
export const DRAIN_OUTBOX_DEADLINE_MS = 50_000;

/**
 * No connection's candidate read and no outbox event is started with less than
 * this left before the deadline. An event not started gets no pending row, so
 * it stays a candidate for the next tick.
 */
export const CONNECTOR_START_RESERVE_MS = 25_000;

/**
 * How often the drain-outbox cron runs (vercel.json: every 10 minutes). Each
 * run starts its connection loop one connection further on (connectionsInTurn).
 */
export const DRAIN_OUTBOX_INTERVAL_MS = 10 * 60_000;

export interface DrainResult {
  processed: number;
  succeeded: number;
  failed: number;
  deadlettered: number;
  /**
   * Set when the run's deadline left work for the next tick: a connection or
   * an event not started, or an export a connector held back (docket B81).
   */
  skipped?: 'deadline';
}

/**
 * The active connections in the order this run drains them: by id, starting
 * one further on at each run (the run's number counted in
 * DRAIN_OUTBOX_INTERVAL_MS). A run that reaches its deadline leaves the rest
 * for the next tick, and the connection read has no order: the same
 * connections came first on every tick, so with a backlog they could take
 * every tick's time while the others were never reached (docket B81). Turns
 * rather than "least recently synced first": last_synced_at moves only on a
 * success, so a connection whose exports keep failing would stay first.
 */
export function connectionsInTurn<T extends { id: string }>(conns: T[], now: Date): T[] {
  const byId = [...conns].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (byId.length < 2) return byId;
  const first = Math.floor(now.getTime() / DRAIN_OUTBOX_INTERVAL_MS) % byId.length;
  return [...byId.slice(first), ...byId.slice(0, first)];
}

/**
 * Module-enabled gate for the connector engine.
 *
 * Returns the subset of `orgIds` whose 'integrations' module is currently
 * enabled (organization_modules.enabled=true, module_id='integrations' — see
 * migration 0144). The cron drain + valuation passes consume this at the point
 * of dispatch so disabling the module in Settings -> Modules immediately stops
 * exports, and re-enabling auto-resumes with NO reactivation logic (we never
 * cascade on the toggle).
 *
 * FAIL-CLOSED: on a query error the caller MUST treat every org as disabled
 * (skip dispatch) rather than exporting — a masked module-gate failure that
 * keeps pushing Bills/JEs to QBO is the exact regression this guards against.
 * We surface that by THROWING here so the caller's try/catch can fail closed.
 */
export async function enabledIntegrationOrgIds(
  admin: { from: (t: string) => any },
  orgIds: string[],
): Promise<Set<string>> {
  if (orgIds.length === 0) return new Set();
  // Every org with an active connection, which no cap bounds: one `.in()` of
  // them fails past ~215 ids locally and ~395 in production (after ~7 s of
  // retries), so they go 100 per request. Any failed batch still throws.
  let rows: Array<{ organization_id: string }>;
  try {
    rows = await fetchAllRowsByIds<{ organization_id: string }>(orgIds, (batch) => (from, to) =>
      admin
        .from('organization_modules')
        .select('organization_id')
        .eq('module_id', 'integrations')
        .eq('enabled', true)
        .in('organization_id', batch)
        // One row per org for this module: a stable page order.
        .order('organization_id', { ascending: true })
        .range(from, to),
    );
  } catch (err) {
    throw new Error(`organization_modules select: ${rawErrorText(err)}`);
  }
  return new Set(rows.map((r) => r.organization_id));
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
 *
 * `opts.deadlineAt` (epoch ms, from the cron route): no connection or event is
 * started with less than CONNECTOR_START_RESERVE_MS left, and every connector
 * gets it in its deps. Absent (tests, other callers): no deadline. Work the
 * deadline left for the next tick sets `skipped: 'deadline'`; the connections
 * take turns going first (connectionsInTurn), and an export a connector held
 * back for time is not counted as an attempt.
 * `opts.clock` is a test seam for the time the deadline is measured against.
 */
export async function runDrain(
  admin: { from: (t: string) => any; rpc: (...args: any[]) => any },
  connectors: Partial<Record<ConnectorProviderId, Connector>>,
  now: Date,
  opts: { deadlineAt?: number; clock?: () => number } = {},
): Promise<DrainResult> {
  const res: DrainResult = { processed: 0, succeeded: 0, failed: 0, deadlettered: 0 };
  const clock = opts.clock ?? Date.now;
  const { deadlineAt } = opts;
  /** Whether too little time is left to start another connection or event. */
  const outOfTime = () =>
    deadlineAt !== undefined && deadlineAt - clock() < CONNECTOR_START_RESERVE_MS;
  // 1. active connections. Fail-closed (throw) on a query error so a DB outage
  //    surfaces as a 500 instead of a silent {processed:0}.
  const { data: conns, error: connsErr } = await admin
    .from('org_connections')
    .select('*')
    .eq('status', 'active');
  if (connsErr) throw new Error(`org_connections select: ${connsErr.message}`);

  // 1b. Module-enabled gate. An admin who connected a provider and later
  //     disabled the 'integrations' module in Settings -> Modules must stop
  //     getting exports — we gate at consumption (no cascade on the toggle), so
  //     re-enabling auto-resumes cleanly with no reactivation logic. Fetch the
  //     enabled org set ONCE for all active connections; FAIL-CLOSED: if the
  //     gate query errors, report and treat EVERY org as disabled (skip
  //     dispatch) rather than exporting against a possibly-disabled module.
  const orgIds: string[] = Array.from(
    new Set(((conns ?? []) as any[]).map((c) => c.organization_id as string)),
  );
  let enabledOrgIds: Set<string>;
  try {
    enabledOrgIds = await enabledIntegrationOrgIds(admin, orgIds);
  } catch (gateErr) {
    void reportError(
      gateErr instanceof Error ? gateErr : new Error('integrations module gate failed'),
      { tag: 'cron.drain-outbox.module-gate' },
    );
    enabledOrgIds = new Set();
  }

  connections: for (const c of connectionsInTurn((conns ?? []) as any[], now)) {
    const connector = connectors[c.provider_id as ConnectorProviderId];
    if (!connector) continue;
    // SKIP any connection whose org's integrations module is not enabled. A
    // disabled-module org yields ZERO connector.handleOutboxEvent calls and ZERO
    // QBO posts (no candidate fetch, no ledger writes) — disabling the module
    // truly stops exports.
    if (!enabledOrgIds.has(c.organization_id)) continue;
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
    if (outOfTime()) {
      res.skipped = 'deadline';
      break;
    }
    const { data: events, error: eventsErr } = await admin.rpc('connector_drain_candidates', {
      p_connection_id: conn.id,
      p_organization_id: c.organization_id,
      p_topics: connector.subscribedTopics,
      p_now: now.toISOString(),
      p_limit: CANDIDATE_LIMIT,
    });
    if (eventsErr) throw new Error(`connector_drain_candidates: ${eventsErr.message}`);

    for (const e of (events ?? []) as any[]) {
      // Not started: no pending row, so the event stays a candidate (docket B81).
      if (outOfTime()) {
        res.skipped = 'deadline';
        break connections;
      }
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
        const out = await connector.handleOutboxEvent(
          event,
          conn,
          secrets,
          makeDeps(admin, deadlineAt),
        );
        if (!out.ok && out.notStarted) {
          // Held back for time by the connector: nothing was sent, so it is
          // not an attempt (docket B81). Its ledger row goes back to what it
          // was before this run's pending write: removed when there was none,
          // else its status and attempts, the only columns that write changed
          // (updated_at aside: the table's trigger sets it on every write).
          // So it neither moves toward MAX_ATTEMPTS nor waits a backoff. A
          // failed rollback leaves the pending row, a candidate again at the
          // next tick with one attempt more: reported.
          res.processed--;
          res.skipped = 'deadline';
          const rollback = existing
            ? admin
                .from('connection_sync_log')
                .update({ status: existing.status, attempts: existing.attempts })
                .eq('connection_id', conn.id)
                .eq('outbox_event_id', e.id)
            : admin
                .from('connection_sync_log')
                .delete()
                .eq('connection_id', conn.id)
                .eq('outbox_event_id', e.id);
          const rollbackRes = await rollback;
          if (rollbackRes.error) {
            void reportError(
              new Error(
                `connection_sync_log rollback: ${postgrestErrorText(rollbackRes.error, rollbackRes)}`,
              ),
              {
                tag: 'cron.drain-outbox.not-started',
                extra: { connectionId: conn.id, eventId: e.id },
              },
            );
          }
          continue;
        }
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
          // A connector that explicitly returns retryable:false is signalling a
          // PERMANENT failure (e.g. a 4xx the request will never recover from) —
          // dead-letter it immediately rather than burning the full MAX_ATTEMPTS
          // budget retrying something that can't succeed. next_attempt_at is null
          // so no further attempt is ever scheduled. Retryable/unknown failures
          // keep the backoff path and only dead-letter at MAX_ATTEMPTS. (The catch
          // block below stays fail-closed: a THROWN error is always retryable.)
          // One network outcome is permanent on purpose: a Sage Intacct create
          // that may have reached Intacct (sage-intacct/client.ts
          // INTACCT_MAY_HAVE_POSTED). Intacct cannot dedupe a repeat, so it
          // stops here for an admin to check Intacct before Replay (docket B81).
          const permanent = out.retryable === false;
          const dead = permanent || attempts >= MAX_ATTEMPTS;
          const { error: errUpdateErr } = await admin
            .from('connection_sync_log')
            .update({
              status: dead ? 'dead' : 'error',
              last_error: out.error ?? 'unknown',
              next_attempt_at: permanent
                ? null
                : new Date(now.getTime() + nextBackoff(attempts)).toISOString(),
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
            // Mirror the else-branch's permanent handling: a dead-lettered row
            // schedules NO further attempt (null), only an 'error' row gets a
            // future backoff. Inert today (a thrown error at MAX_ATTEMPTS won't
            // be re-read anyway) but correct + consistent.
            next_attempt_at: dead
              ? null
              : new Date(now.getTime() + nextBackoff(attempts)).toISOString(),
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
 * `deadlineAt` is the cron run's (ConnectorDeps.deadlineAt), or undefined.
 */
function makeDeps(admin: any, deadlineAt: number | undefined) {
  return {
    admin,
    fetch,
    deadlineAt,
    async getMapping(connectionId: string, entityType: string, localId: string | null) {
      let q = admin
        .from('connection_mappings')
        .select('external_id, external_meta')
        .eq('connection_id', connectionId)
        .eq('entity_type', entityType);
      q = localId === null ? q.is('local_id', null) : q.eq('local_id', localId);
      // A list of at most two, not maybeSingle(): maybeSingle() resolves an
      // empty body as data null with no error, which read as "no mapping"
      // (docket S27).
      const res = await q.limit(2);
      // FAIL CLOSED: this read is the idempotency guard for connectors without
      // a provider-side dedupe key (Intacct has no QBO-style requestid). A
      // transient query error must NOT read as "no mapping" — that would
      // re-POST and duplicate the document in the customer's ERP. Every
      // failure throws a MappingReadError, which fails the attempt into
      // 'error' with backoff wherever the connector reads it, even inside the
      // try around its provider calls (mapping-read-error.ts); a duplicate
      // export is not recoverable.
      if (res.error) {
        throw new MappingReadError(new Error(`connection_mappings select: ${res.error.message}`));
      }
      let rows: Array<{ external_id: string; external_meta: Record<string, unknown> | null }>;
      try {
        rows = listRows('connection_mappings', res);
      } catch (err) {
        // Reported here: the attempt's catch stores a thrown error as the
        // row's last_error and reports only a failed write.
        if (err instanceof ListReadError) {
          void reportError(err, {
            tag: 'cron.drain-outbox.mapping',
            extra: { connectionId, entityType },
          });
          throw new MappingReadError(err);
        }
        throw err;
      }
      // Two rows for one local id is no answer either (maybeSingle refused it too).
      if (rows.length > 1) {
        throw new MappingReadError(new Error('connection_mappings answered more than one mapping'));
      }
      const data = rows[0];
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
      const res = await admin.from('connection_mappings').upsert(
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
      // Reported, never thrown (docket B81). For a connector with no
      // provider-side dedupe key (Intacct) this row is the idempotency guard,
      // so a failed write must be seen. But the create it records already
      // happened: a throw inside the connector's try would turn a posted
      // document into a dead export, and its Replay would post it again.
      if (res.error) {
        void reportError(
          new Error(`connection_mappings upsert: ${postgrestErrorText(res.error, res)}`),
          { tag: 'cron.drain-outbox.mapping-write', extra: { connectionId, entityType } },
        );
      }
    },
  };
}
