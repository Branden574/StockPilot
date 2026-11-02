import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reportError } from '@/lib/error-reporter';
import { json, realSupabaseClient, type ClientRequest } from '@/test/postgrest-answers';
import { makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

import { enabledIntegrationOrgIds, MAX_ATTEMPTS, nextBackoff, runDrain } from './drainer';
import { quickbooksConnector } from './quickbooks';
import { sageIntacctConnector } from './sage-intacct';
import { INTACCT_MAY_HAVE_POSTED } from './sage-intacct/client';

vi.mock('@/lib/error-reporter', () => ({
  reportError: vi.fn(),
}));

vi.mock('./secret-store', () => ({
  getConnectionSecret: vi.fn(async () => ({
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  })),
  putConnectionSecret: vi.fn(async () => 'new-secret-id'),
}));

describe('nextBackoff', () => {
  it('is exponential and capped, jittered within bounds', () => {
    const b1 = nextBackoff(1),
      b8 = nextBackoff(8);
    expect(b1).toBeGreaterThan(0);
    expect(b8).toBeLessThanOrEqual(60 * 60 * 1000); // cap 1h
    expect(nextBackoff(2)).toBeGreaterThanOrEqual(nextBackoff(1) * 0.5);
  });
  it('MAX_ATTEMPTS is a small finite number', () => {
    expect(MAX_ATTEMPTS).toBeGreaterThan(3);
    expect(MAX_ATTEMPTS).toBeLessThanOrEqual(12);
  });
});

/**
 * Builds a minimal fake admin client. `tables` is a map of table name to the
 * data each `select()` should resolve. Mutating calls (upsert/update) are
 * recorded into `writes` so assertions can inspect them. Errors can be injected
 * per (table, op) via `errors`.
 */
function makeFakeAdmin(opts: {
  conns?: any[];
  events?: any[];
  /** keyed by `${connectionId}:${eventId}` */
  syncLog?: Record<string, any>;
  /** keyed by `${table}:${op}` -> error message */
  errors?: Record<string, string>;
  /** error message to inject on the candidate-selection RPC */
  candidatesRpcError?: string;
  /**
   * Org ids whose 'integrations' module is enabled (organization_modules gate,
   * migration 0144). Defaults to ALL conns' org ids (module on) so the existing
   * happy-path cases keep dispatching; pass [] to simulate a disabled module.
   */
  enabledModuleOrgIds?: string[];
}) {
  const enabledOrgIds =
    opts.enabledModuleOrgIds ??
    Array.from(new Set((opts.conns ?? []).map((c) => c.organization_id)));
  const writes: Array<{ table: string; op: string; values: any }> = [];
  /** records every connector_drain_candidates RPC call so tests can assert args */
  const candidateCalls: Array<{ fn: string; args: any }> = [];
  const err = (key: string) =>
    opts.errors?.[key] ? { message: opts.errors[key] } : null;

  function builder(table: string) {
    const state: { filters: Record<string, any> } = { filters: {} };
    const self: any = {
      select() {
        return self;
      },
      eq(col: string, val: any) {
        state.filters[col] = val;
        return self;
      },
      in() {
        return self;
      },
      is(col: string) {
        state.filters[col] = null;
        return self;
      },
      not() {
        return self;
      },
      order() {
        return self;
      },
      range() {
        return self;
      },
      limit() {
        return self;
      },
      maybeSingle() {
        if (table === 'connection_sync_log') {
          const key = `${state.filters.connection_id}:${state.filters.outbox_event_id}`;
          return Promise.resolve({
            data: opts.syncLog?.[key] ?? null,
            error: err('connection_sync_log:select'),
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      upsert(values: any) {
        writes.push({ table, op: 'upsert', values });
        return Promise.resolve({ error: err(`${table}:upsert`) });
      },
      update(values: any) {
        writes.push({ table, op: 'update', values });
        const chain: any = {
          eq() {
            return chain;
          },
          then(resolve: any) {
            return resolve({ error: err(`${table}:update`) });
          },
        };
        return chain;
      },
      // org_connections terminal select (.eq('status','active'))
      then(resolve: any) {
        if (table === 'org_connections') {
          return resolve({ data: opts.conns ?? [], error: err('org_connections:select') });
        }
        // organization_modules module-enabled gate (migration 0144): return the
        // enabled org ids as rows, or inject an error to exercise fail-closed.
        if (table === 'organization_modules') {
          return resolve({
            data: enabledOrgIds.map((organization_id) => ({ organization_id })),
            error: err('organization_modules:select'),
          });
        }
        return resolve({ data: [], error: null });
      },
    };
    return self;
  }

  return {
    from: (t: string) => builder(t),
    // Candidate selection is delegated to a SECURITY DEFINER RPC that excludes
    // terminal/backed-off events server-side (head-of-line starvation fix).
    rpc: vi.fn(async (fn: string, args: any) => {
      if (fn === 'connector_drain_candidates') {
        candidateCalls.push({ fn, args });
        if (opts.candidatesRpcError) {
          return { data: null, error: { message: opts.candidatesRpcError } };
        }
        return { data: opts.events ?? [], error: null };
      }
      return { data: null, error: null };
    }),
    __writes: writes,
    __candidateCalls: candidateCalls,
  };
}

const okConnector = (subscribedTopics: string[] = ['receipt.posted']) => ({
  id: 'quickbooks' as const,
  modes: ['push'] as const,
  subscribedTopics,
  handleOutboxEvent: vi.fn(async () => ({ ok: true, externalId: 'ext-1' })),
});

describe('runDrain error handling (fail-closed)', () => {
  it('throws when the org_connections select fails', async () => {
    const admin = makeFakeAdmin({ errors: { 'org_connections:select': 'db down' } });
    await expect(
      runDrain(admin as any, {}, new Date()),
    ).rejects.toThrow(/db down/);
  });

  it('throws when the candidate-selection RPC fails', async () => {
    const admin = makeFakeAdmin({
      conns: [
        {
          id: 'conn-1',
          organization_id: 'org-1',
          provider_id: 'quickbooks',
          status: 'active',
          secret_id: 'sec-1',
          settings: {},
        },
      ],
      candidatesRpcError: 'events boom',
    });
    await expect(
      runDrain(admin as any, { quickbooks: okConnector() } as any, new Date()),
    ).rejects.toThrow(/events boom/);
  });

  it('does NOT fire the connector when the pending-row upsert fails', async () => {
    const connector = okConnector();
    const admin = makeFakeAdmin({
      conns: [
        {
          id: 'conn-1',
          organization_id: 'org-1',
          provider_id: 'quickbooks',
          status: 'active',
          secret_id: 'sec-1',
          settings: {},
        },
      ],
      events: [
        {
          id: 'evt-1',
          organization_id: 'org-1',
          topic: 'receipt.posted',
          aggregate_type: 'receipt',
          aggregate_id: 'r1',
          payload: {},
          created_at: new Date().toISOString(),
        },
      ],
      errors: { 'connection_sync_log:upsert': 'write failed' },
    });
    const res = await runDrain(admin as any, { quickbooks: connector } as any, new Date());
    expect(connector.handleOutboxEvent).not.toHaveBeenCalled();
    expect(res.succeeded).toBe(0);
    expect(res.failed).toBe(1);
  });
});

describe('runDrain happy path', () => {
  it('dispatches a due event and records success', async () => {
    const connector = okConnector();
    const admin = makeFakeAdmin({
      conns: [
        {
          id: 'conn-1',
          organization_id: 'org-1',
          provider_id: 'quickbooks',
          status: 'active',
          secret_id: 'sec-1',
          settings: {},
        },
      ],
      events: [
        {
          id: 'evt-1',
          organization_id: 'org-1',
          topic: 'receipt.posted',
          aggregate_type: 'receipt',
          aggregate_id: 'r1',
          payload: {},
          created_at: new Date().toISOString(),
        },
      ],
    });
    const res = await runDrain(admin as any, { quickbooks: connector } as any, new Date());
    expect(connector.handleOutboxEvent).toHaveBeenCalledTimes(1);
    expect(res.processed).toBe(1);
    expect(res.succeeded).toBe(1);
    // pending upsert + success update + org_connections update
    const successUpdate = (admin.__writes as any[]).find(
      (w) => w.table === 'connection_sync_log' && w.op === 'update' && w.values.status === 'success',
    );
    expect(successUpdate).toBeTruthy();
  });

  it('bounds the candidate window via the RPC (org/topics/now/limit), not an unbounded NOT IN', async () => {
    // Head-of-line starvation fix: candidate selection delegates to a SECURITY
    // DEFINER RPC that excludes terminal/backed-off events server-side, bounded
    // by a work-remaining limit. Assert we call it with the connection scope and
    // a finite limit rather than fetching every terminal id into a NOT-IN list.
    const connector = okConnector(['receipt.posted']);
    const now = new Date('2026-05-30T00:00:00.000Z');
    const admin = makeFakeAdmin({
      conns: [
        {
          id: 'conn-1',
          organization_id: 'org-1',
          provider_id: 'quickbooks',
          status: 'active',
          secret_id: 'sec-1',
          settings: {},
        },
      ],
      events: [],
    });
    await runDrain(admin as any, { quickbooks: connector } as any, now);
    const calls = (admin as any).__candidateCalls as Array<{ fn: string; args: any }>;
    expect(calls).toHaveLength(1);
    const args = calls[0]!.args;
    expect(args).toMatchObject({
      p_connection_id: 'conn-1',
      p_organization_id: 'org-1',
      p_topics: ['receipt.posted'],
      p_now: now.toISOString(),
    });
    expect(typeof args.p_limit).toBe('number');
    expect(args.p_limit).toBeGreaterThan(0);
    // RPC returned [] → nothing dispatched and the unbounded terminal-id fetch
    // never happens.
    expect(connector.handleOutboxEvent).not.toHaveBeenCalled();
  });

  it('does not re-dispatch an event already terminal (success) for the connection', async () => {
    // Defense in depth on top of the RPC exclusion: even if a terminal event
    // slipped into the candidate set, the per-event ledger point-read skips it.
    const connector = okConnector(['receipt.posted']);
    const admin = makeFakeAdmin({
      conns: [
        {
          id: 'conn-1',
          organization_id: 'org-1',
          provider_id: 'quickbooks',
          status: 'active',
          secret_id: 'sec-1',
          settings: {},
        },
      ],
      events: [
        {
          id: 'evt-1',
          organization_id: 'org-1',
          topic: 'receipt.posted',
          aggregate_type: 'receipt',
          aggregate_id: 'r1',
          payload: {},
          created_at: new Date().toISOString(),
        },
      ],
      syncLog: { 'conn-1:evt-1': { status: 'success', attempts: 1 } },
    });
    const res = await runDrain(admin as any, { quickbooks: connector } as any, new Date());
    expect(connector.handleOutboxEvent).not.toHaveBeenCalled();
    expect(res.processed).toBe(0);
  });

  it('skips when secret_id is null on an active connection (no dispatch)', async () => {
    const connector = okConnector();
    const admin = makeFakeAdmin({
      conns: [
        {
          id: 'conn-1',
          organization_id: 'org-1',
          provider_id: 'quickbooks',
          status: 'active',
          secret_id: null,
          settings: {},
        },
      ],
      events: [
        {
          id: 'evt-1',
          organization_id: 'org-1',
          topic: 'receipt.posted',
          aggregate_type: 'receipt',
          aggregate_id: 'r1',
          payload: {},
          created_at: new Date().toISOString(),
        },
      ],
    });
    const res = await runDrain(admin as any, { quickbooks: connector } as any, new Date());
    expect(connector.handleOutboxEvent).not.toHaveBeenCalled();
    expect(res.succeeded).toBe(0);
  });
});

describe('runDrain gates on the integrations module (migration 0144)', () => {
  const connAndEvent = () => ({
    conns: [
      {
        id: 'conn-1',
        organization_id: 'org-1',
        provider_id: 'quickbooks',
        status: 'active',
        secret_id: 'sec-1',
        settings: {},
      },
    ],
    events: [
      {
        id: 'evt-1',
        organization_id: 'org-1',
        topic: 'receipt.posted',
        aggregate_type: 'receipt',
        aggregate_id: 'r1',
        payload: {},
        created_at: new Date().toISOString(),
      },
    ],
  });

  it('dispatches when the org integrations module is ENABLED', async () => {
    const connector = okConnector();
    const admin = makeFakeAdmin({ ...connAndEvent(), enabledModuleOrgIds: ['org-1'] });
    const res = await runDrain(admin as any, { quickbooks: connector } as any, new Date());
    expect(connector.handleOutboxEvent).toHaveBeenCalledTimes(1);
    expect(res.succeeded).toBe(1);
  });

  it('does NOT dispatch and writes NO success row when the module is DISABLED', async () => {
    const connector = okConnector();
    const admin = makeFakeAdmin({ ...connAndEvent(), enabledModuleOrgIds: [] });
    const res = await runDrain(admin as any, { quickbooks: connector } as any, new Date());
    // ZERO connector calls, ZERO QBO posts (the connector is never invoked).
    expect(connector.handleOutboxEvent).not.toHaveBeenCalled();
    expect(res.processed).toBe(0);
    expect(res.succeeded).toBe(0);
    // No candidate fetch and NO sync_log writes for the disabled org.
    expect((admin as any).__candidateCalls).toHaveLength(0);
    const successUpdate = (admin.__writes as any[]).find(
      (w) => w.table === 'connection_sync_log' && w.values?.status === 'success',
    );
    expect(successUpdate).toBeUndefined();
    expect(admin.__writes).toHaveLength(0);
  });

  it('FAIL-CLOSED: a module-gate query error skips dispatch (no connector call)', async () => {
    const connector = okConnector();
    const admin = makeFakeAdmin({
      ...connAndEvent(),
      errors: { 'organization_modules:select': 'gate down' },
    });
    const res = await runDrain(admin as any, { quickbooks: connector } as any, new Date());
    expect(connector.handleOutboxEvent).not.toHaveBeenCalled();
    expect(res.processed).toBe(0);
    expect((admin as any).__candidateCalls).toHaveLength(0);
  });
});

describe('runDrain honors PushResult.retryable', () => {
  /** One active connection + one due event, shared by the cases below. */
  const oneActiveConnWithEvent = () => ({
    conns: [
      {
        id: 'conn-1',
        organization_id: 'org-1',
        provider_id: 'quickbooks',
        status: 'active',
        secret_id: 'sec-1',
        settings: {},
      },
    ],
    events: [
      {
        id: 'evt-1',
        organization_id: 'org-1',
        topic: 'receipt.posted',
        aggregate_type: 'receipt',
        aggregate_id: 'r1',
        payload: {},
        created_at: new Date().toISOString(),
      },
    ],
  });

  /** Tiny stub connector — no real QBO client. `result` drives the failure mode. */
  const stubConnector = (result: () => Promise<any>) => ({
    id: 'quickbooks' as const,
    modes: ['push'] as const,
    subscribedTopics: ['receipt.posted'],
    handleOutboxEvent: vi.fn(result),
  });

  const errorUpdate = (admin: any) =>
    (admin.__writes as any[]).find(
      (w) =>
        w.table === 'connection_sync_log' &&
        w.op === 'update' &&
        (w.values.status === 'error' || w.values.status === 'dead'),
    );

  it('dead-letters immediately on {ok:false, retryable:false} (no retry scheduled) on the FIRST attempt', async () => {
    const connector = stubConnector(async () => ({ ok: false, retryable: false, error: 'bad request' }));
    const admin = makeFakeAdmin(oneActiveConnWithEvent());
    const res = await runDrain(admin as any, { quickbooks: connector } as any, new Date());

    expect(connector.handleOutboxEvent).toHaveBeenCalledTimes(1);
    const update = errorUpdate(admin);
    // Permanent failure → 'dead' on the first attempt, no backoff scheduled.
    expect(update?.values.status).toBe('dead');
    expect(update?.values.next_attempt_at).toBeNull();
    expect(res.deadlettered).toBe(1);
    expect(res.failed).toBe(0);
  });

  it('retries (status error + backoff) on {ok:false} without retryable=false', async () => {
    const connector = stubConnector(async () => ({ ok: false, error: 'transient' }));
    const admin = makeFakeAdmin(oneActiveConnWithEvent());
    const res = await runDrain(admin as any, { quickbooks: connector } as any, new Date());

    const update = errorUpdate(admin);
    expect(update?.values.status).toBe('error');
    expect(typeof update?.values.next_attempt_at).toBe('string');
    expect(res.failed).toBe(1);
    expect(res.deadlettered).toBe(0);
  });

  it('retries (status error + backoff) when the connector THROWS (fail-closed)', async () => {
    const connector = stubConnector(async () => {
      throw new Error('network blip');
    });
    const admin = makeFakeAdmin(oneActiveConnWithEvent());
    const res = await runDrain(admin as any, { quickbooks: connector } as any, new Date());

    const update = errorUpdate(admin);
    expect(update?.values.status).toBe('error');
    expect(typeof update?.values.next_attempt_at).toBe('string');
    expect(res.failed).toBe(1);
    expect(res.deadlettered).toBe(0);
  });
});

/**
 * The integrations module gate covers every org with an active connection.
 * One `.in()` of them fails past ~215 ids locally and ~395 in production
 * (after ~7 s of retries), which failed the gate on every tick and, fail
 * closed, stopped every org's exports. It now reads 100 orgs per request.
 */
describe('enabledIntegrationOrgIds with 250 orgs', () => {
  const orgId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  const orgs = Array.from({ length: 250 }, (_, i) => orgId(i));
  const inList = (call: MockCall) =>
    call.args[call.methods.indexOf('in')]![1] as string[];

  it('reads the gate in batches of 100 and finds an enabled org in the last batch', async () => {
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'organization_modules.select': (call) => {
        const ids = inList(call);
        lists.push(ids);
        // Every even org has the module on.
        return {
          data: ids
            .filter((id) => Number(id.slice(-3)) % 2 === 0)
            .map((organization_id) => ({ organization_id })),
          error: null,
        };
      },
    });
    const enabled = await enabledIntegrationOrgIds(stub.client, orgs);
    expect(lists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(enabled.size).toBe(125);
    expect(enabled.has(orgId(248))).toBe(true);
    expect(enabled.has(orgId(249))).toBe(false);
  });

  it('a failed batch throws (the callers fail closed), naming the gate read', async () => {
    let n = 0;
    const stub = makeSupabaseStub({
      'organization_modules.select': () =>
        ++n === 2 ? { data: null, error: { message: 'fetch failed' } } : { data: [], error: null },
    });
    await expect(enabledIntegrationOrgIds(stub.client, orgs)).rejects.toThrow(
      'organization_modules select: fetch failed',
    );
  });
});

/**
 * docket S27: getMapping is Intacct's only guard against posting a document
 * twice (Intacct has no provider-side dedupe key; sage-intacct/index.ts). It
 * read with maybeSingle(), and postgrest-js resolves an empty body there as
 * data null with no error: read as "no mapping", the purchase order was posted
 * to the customer's ERP again. An answer that is not a list now fails the
 * attempt into 'error' with backoff, posts nothing and is reported. Driven
 * through a real supabase-js client (a local fetch) and the real Intacct
 * connector, whose own fetch is a spy: no request leaves the test.
 */
describe('runDrain: an Intacct mapping read that answers no list posts nothing', () => {
  const NOW = new Date('2026-10-26T12:00:00Z');
  const CONN = {
    id: 'conn-si',
    organization_id: 'org-1',
    provider_id: 'sage_intacct',
    status: 'active',
    secret_id: 'secret-1',
    external_account_id: 'company-1',
    settings: { intacct: { defaultItemId: 'NONINV', defaultVendorId: 'VDEF' } },
  };
  const EVENT = {
    id: 'evt-1',
    organization_id: 'org-1',
    topic: 'purchase_order.ordered',
    aggregate_type: 'purchase_order',
    aggregate_id: 'po-1',
    payload: {},
    dedupe_key: null,
    created_at: NOW.toISOString(),
  };
  const MAPPING = { external_id: 'DOC-7', external_meta: {} };
  const intacctFetch = vi.fn(async () => json({ 'ia::result': { key: 'DOC-8' } }));

  beforeEach(() => {
    vi.mocked(reportError).mockClear();
    intacctFetch.mockClear();
    vi.stubGlobal('fetch', intacctFetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  /** One drain whose mapping read answers `mappingAnswer`; every other read
   *  answers as PostgREST would for this connection, event and order. */
  async function drain(mappingAnswer: () => Response) {
    const requests: ClientRequest[] = [];
    const admin = realSupabaseClient((req) => {
      requests.push(req);
      const path = req.url.pathname.replace(/^\/rest\/v1\//, '');
      if (req.method === 'GET' && path === 'org_connections') return json([CONN]);
      if (req.method === 'GET' && path === 'organization_modules')
        return json([{ organization_id: 'org-1' }]);
      if (path === 'rpc/connector_drain_candidates') return json([EVENT]);
      if (req.method === 'GET' && path === 'connection_sync_log') return json([]);
      if (req.method === 'GET' && path === 'connection_mappings') return mappingAnswer();
      if (req.method === 'GET' && path === 'purchase_orders') {
        return json([
          { id: 'po-1', po_number: 'PO-1', supplier_id: null, subtotal: 120, total: 120 },
        ]);
      }
      // The writes: the pending row, the outcome, the mapping, last_synced_at.
      return new Response(null, { status: 204 });
    });
    const result = await runDrain(admin, { sage_intacct: sageIntacctConnector }, NOW);
    const outcome = requests
      .filter((r) => r.method === 'PATCH' && r.url.pathname.endsWith('/connection_sync_log'))
      .map((r) => JSON.parse(r.body ?? '{}') as Record<string, unknown>);
    const mappingReports = vi
      .mocked(reportError)
      .mock.calls.filter(([, context]) => context?.tag === 'cron.drain-outbox.mapping');
    vi.mocked(reportError).mockClear();
    return { result, outcome, mappingReports };
  }

  function expectFailedAttempt(run: Awaited<ReturnType<typeof drain>>, lastError: string) {
    expect(intacctFetch).not.toHaveBeenCalled();
    expect(run.result).toEqual({ processed: 1, succeeded: 0, failed: 1, deadlettered: 0 });
    expect(run.outcome).toHaveLength(1);
    expect(run.outcome[0]).toMatchObject({ status: 'error', last_error: lastError });
    expect(new Date(run.outcome[0]!.next_attempt_at as string).getTime()).toBeGreaterThan(
      NOW.getTime(),
    );
  }

  it('an empty 200 body posts nothing, fails into error with backoff and is reported; an answered mapping and two rows behave as before', async () => {
    // The mapping answered: the document was posted before, so nothing is posted now.
    const answered = await drain(() => json([MAPPING]));
    expect(intacctFetch).not.toHaveBeenCalled();
    expect(answered.result).toEqual({ processed: 1, succeeded: 1, failed: 0, deadlettered: 0 });
    expect(answered.outcome[0]).toMatchObject({ status: 'success', external_id: 'DOC-7' });

    // The same read with an empty body.
    const empty = await drain(() => new Response('', { status: 200 }));
    expectFailedAttempt(empty, 'connection_mappings answered no list (status 200)');
    expect(empty.mappingReports).toHaveLength(1);
    expect((empty.mappingReports[0]?.[0] as Error).message).toBe(
      'connection_mappings answered no list (status 200)',
    );
    expect(empty.mappingReports[0]?.[1]).toEqual({
      tag: 'cron.drain-outbox.mapping',
      extra: { connectionId: 'conn-si', entityType: 'purchase_order' },
    });

    // Two rows for one document is no answer either (maybeSingle refused it too).
    const two = await drain(() => json([MAPPING, MAPPING]));
    expect(intacctFetch).not.toHaveBeenCalled();
    expect(two.result).toEqual({ processed: 1, succeeded: 0, failed: 1, deadlettered: 0 });
    expect(two.outcome[0]).toMatchObject({ status: 'error' });
  });

  it.each([
    ['an empty 404 body (status rewritten to 204)', () => new Response('', { status: 404 }), 204],
    ['a JSON object', () => json({ id: 'not-a-list' }), 200],
  ])(
    '%s posts nothing, fails into error with backoff and is reported',
    async (_shape, answer, status) => {
      const run = await drain(answer);
      expectFailedAttempt(run, `connection_mappings answered no list (status ${status})`);
      expect(run.mappingReports).toHaveLength(1);
    },
  );
});

/**
 * docket S27 review: QuickBooks and Sage Intacct read the supplier's mapping
 * inside the try whose catch decides `retryable` from the thrown error's
 * `status`, meant for the provider's HTTP status. A mapping read that answered
 * no list threw a ListReadError carrying PostgREST's status (200 or 204),
 * which read as a provider's caller error: the export went to 'dead' at once,
 * never offered again without a manual Replay. An error answer from the same
 * read carried no status and went to 'dead' the same way, before S27. Either
 * one is StockPilot's own read failing before anything is posted: the attempt
 * goes to 'error' with backoff, as a failed read outside the try always did.
 * Driven through a real supabase-js client (a local fetch) and the real
 * connectors, whose own fetch is a spy: no request leaves the test.
 */
describe('runDrain: a failed supplier mapping read retries the export with backoff', () => {
  const NOW = new Date('2026-10-26T12:00:00Z');
  const SUPPLIER = { id: 'sup-1', name: 'Placeholder Supplier' };
  const PO_ROW = { id: 'po-1', po_number: 'PO-1', supplier_id: 'sup-1', subtotal: 120, total: 120 };
  const QBO_CONN = {
    id: 'conn-qbo',
    organization_id: 'org-1',
    provider_id: 'quickbooks',
    status: 'active',
    secret_id: 'secret-1',
    external_account_id: 'realm-1',
    settings: { env: 'sandbox', accountIds: { billExpense: '42' } },
  };
  const INTACCT_CONN = {
    id: 'conn-si',
    organization_id: 'org-1',
    provider_id: 'sage_intacct',
    status: 'active',
    secret_id: 'secret-1',
    external_account_id: 'company-1',
    settings: { intacct: { defaultItemId: 'NONINV' } },
  };
  const outboxEvent = (topic: string, aggregateType: string, aggregateId: string) => ({
    id: 'evt-1',
    organization_id: 'org-1',
    topic,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    payload: {},
    dedupe_key: null,
    created_at: NOW.toISOString(),
  });

  /** The three exports that read the supplier's mapping inside the connector's try. */
  const EXPORTS: Array<{
    name: string;
    conn: Record<string, unknown>;
    event: Record<string, unknown>;
    connectors: Parameters<typeof runDrain>[1];
    /** What each rehydration read answers, by table. */
    rows: Record<string, unknown[]>;
  }> = [
    {
      name: 'QuickBooks receipt.posted (a Bill)',
      conn: QBO_CONN,
      event: outboxEvent('receipt.posted', 'receipt', 'rcpt-1'),
      connectors: { quickbooks: quickbooksConnector },
      rows: {
        receipts: [{ id: 'rcpt-1', purchase_order_id: 'po-1', receipt_number: 'RC-1' }],
        receipt_lines: [{ qty_accepted_base: 5, unit_cost: 2 }],
        purchase_orders: [{ supplier_id: 'sup-1' }],
        suppliers: [SUPPLIER],
      },
    },
    {
      name: 'QuickBooks purchase_order.ordered',
      conn: QBO_CONN,
      event: outboxEvent('purchase_order.ordered', 'purchase_order', 'po-1'),
      connectors: { quickbooks: quickbooksConnector },
      rows: { purchase_orders: [PO_ROW], suppliers: [SUPPLIER] },
    },
    {
      name: 'Sage Intacct purchase_order.ordered',
      conn: INTACCT_CONN,
      event: outboxEvent('purchase_order.ordered', 'purchase_order', 'po-1'),
      connectors: { sage_intacct: sageIntacctConnector },
      rows: { purchase_orders: [PO_ROW], suppliers: [SUPPLIER] },
    },
  ];

  /** The supplier mapping read's failed answers, with the attempt's last_error and
   *  whether getMapping reports it (it reports an answer that is not a list). */
  const FAILED_READS = [
    [
      'an empty 200 body',
      () => new Response('', { status: 200 }),
      'connection_mappings answered no list (status 200)',
      true,
    ],
    [
      'an empty 404 body (status rewritten to 204)',
      () => new Response('', { status: 404 }),
      'connection_mappings answered no list (status 204)',
      true,
    ],
    [
      'a JSON object',
      () => json({ id: 'not-a-list' }),
      'connection_mappings answered no list (status 200)',
      true,
    ],
    [
      'an error answer',
      () => json({ code: '57014', message: 'canceling statement due to statement timeout' }, 500),
      'connection_mappings select: canceling statement due to statement timeout',
      false,
    ],
  ] as const;

  /** The providers' own requests: QuickBooks and Intacct answer each create. */
  const providerFetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/bill')) return json({ Bill: { Id: 'BILL-1' } });
    if (url.includes('/purchaseorder')) return json({ PurchaseOrder: { Id: 'QPO-1' } });
    return json({ 'ia::result': { key: 'DOC-8' } });
  });

  beforeEach(() => {
    vi.mocked(reportError).mockClear();
    providerFetch.mockClear();
    vi.stubGlobal('fetch', providerFetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  /** One drain of `x` whose supplier mapping read answers `supplierMapping`;
   *  every other read answers as PostgREST would. */
  async function drain(x: (typeof EXPORTS)[number], supplierMapping: () => Response) {
    const requests: ClientRequest[] = [];
    const admin = realSupabaseClient((req) => {
      requests.push(req);
      const path = req.url.pathname.replace(/^\/rest\/v1\//, '');
      if (req.method === 'GET' && path === 'org_connections') return json([x.conn]);
      if (req.method === 'GET' && path === 'organization_modules')
        return json([{ organization_id: 'org-1' }]);
      if (path === 'rpc/connector_drain_candidates') return json([x.event]);
      if (req.method === 'GET' && path === 'connection_sync_log') return json([]);
      if (req.method === 'GET' && path === 'connection_mappings') {
        // Intacct's own purchase order mapping is not there yet: never posted.
        return req.url.searchParams.get('entity_type') === 'eq.supplier'
          ? supplierMapping()
          : json([]);
      }
      if (req.method === 'GET' && x.rows[path]) return json(x.rows[path]);
      // The writes: the pending row, the outcome, the mapping, last_synced_at.
      return new Response(null, { status: 204 });
    });
    const result = await runDrain(admin, x.connectors, NOW);
    const outcome = requests
      .filter((r) => r.method === 'PATCH' && r.url.pathname.endsWith('/connection_sync_log'))
      .map((r) => JSON.parse(r.body ?? '{}') as Record<string, unknown>);
    const mappingReports = vi
      .mocked(reportError)
      .mock.calls.filter(([, context]) => context?.tag === 'cron.drain-outbox.mapping');
    return { result, outcome, mappingReports };
  }

  describe.each(EXPORTS)('$name', (x) => {
    it('with the supplier mapping answered, posts once and succeeds', async () => {
      const run = await drain(x, () => json([{ external_id: 'VENDOR-7', external_meta: {} }]));
      expect(run.result).toEqual({ processed: 1, succeeded: 1, failed: 0, deadlettered: 0 });
      expect(providerFetch).toHaveBeenCalledTimes(1);
      expect(run.outcome[0]).toMatchObject({ status: 'success' });
    });

    it.each(FAILED_READS)(
      '%s posts nothing and goes to error with backoff, not to dead',
      async (_shape, answer, lastError, reported) => {
        const run = await drain(x, answer);
        expect(providerFetch).not.toHaveBeenCalled();
        expect(run.result).toEqual({ processed: 1, succeeded: 0, failed: 1, deadlettered: 0 });
        expect(run.outcome).toHaveLength(1);
        expect(run.outcome[0]).toMatchObject({ status: 'error', last_error: lastError });
        expect(new Date(run.outcome[0]!.next_attempt_at as string).getTime()).toBeGreaterThan(
          NOW.getTime(),
        );
        expect(run.mappingReports).toHaveLength(reported ? 1 : 0);
        if (reported) {
          expect(run.mappingReports[0]?.[1]).toEqual({
            tag: 'cron.drain-outbox.mapping',
            extra: { connectionId: x.conn.id, entityType: 'supplier' },
          });
        }
      },
    );
  });
});

/**
 * docket B81: when the call to Intuit or Intacct failed before any HTTP answer
 * (a failed lookup, a refused or reset connection, a timeout), fetch threw
 * with no status, both classifiers read the missing status as 0, a caller
 * error, and the export went to dead on its first try, never offered again
 * without a manual Replay. QuickBooks dedupes a repeat by its requestid, so any
 * failure that is not an Intuit answer now retries with backoff. Intacct
 * cannot dedupe, so a create retries only when it provably never left (its
 * lookup or its connect failed); a create that may have arrived stops at dead,
 * its message first saying to check Intacct before Replay. Driven through a
 * real supabase-js client (a local fetch) and the real connectors, whose own
 * fetch is a spy: no request leaves the test.
 */
describe('runDrain: a provider call that got no answer', () => {
  const NOW = new Date('2026-11-01T12:00:00Z');
  const SUPPLIER = { id: 'sup-1', name: 'Placeholder Supplier' };
  const QBO_CONN = {
    id: 'conn-qbo',
    organization_id: 'org-1',
    provider_id: 'quickbooks',
    status: 'active',
    secret_id: 'secret-1',
    external_account_id: 'realm-1',
    settings: {
      env: 'sandbox',
      accountIds: { billExpense: '42', returnCredit: '4900', inventoryAsset: '1200' },
    },
  };
  const INTACCT_CONN = {
    id: 'conn-si',
    organization_id: 'org-1',
    provider_id: 'sage_intacct',
    status: 'active',
    secret_id: 'secret-1',
    external_account_id: 'company-1',
    settings: {
      intacct: { defaultItemId: 'NONINV', defaultVendorId: 'VDEF' },
      accountIds: { returnCredit: '4900', inventoryAsset: '1200' },
    },
  };
  const outboxEvent = (topic: string, aggregateType: string, aggregateId: string) => ({
    id: 'evt-1',
    organization_id: 'org-1',
    topic,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    payload: {},
    dedupe_key: null,
    created_at: NOW.toISOString(),
  });
  const RETURN_ROWS = {
    returns: [{ id: 'ret-1', return_number: 'RMA-1' }],
    return_lines: [{ quantity: 2, order_request_line: { unit_cost_at_request: 10 } }],
  };

  interface Export {
    name: string;
    conn: Record<string, unknown>;
    event: Record<string, unknown>;
    connectors: Parameters<typeof runDrain>[1];
    /** What each rehydration read answers, by table. */
    rows: Record<string, unknown[]>;
  }

  const QBO_EXPORTS: Export[] = [
    {
      name: 'QuickBooks receipt.posted (a Bill)',
      conn: QBO_CONN,
      event: outboxEvent('receipt.posted', 'receipt', 'rcpt-1'),
      connectors: { quickbooks: quickbooksConnector },
      rows: {
        receipts: [{ id: 'rcpt-1', purchase_order_id: 'po-1', receipt_number: 'RC-1' }],
        receipt_lines: [{ qty_accepted_base: 5, unit_cost: 2 }],
        purchase_orders: [{ supplier_id: 'sup-1' }],
        suppliers: [SUPPLIER],
      },
    },
    {
      name: 'QuickBooks purchase_order.ordered',
      conn: QBO_CONN,
      event: outboxEvent('purchase_order.ordered', 'purchase_order', 'po-1'),
      connectors: { quickbooks: quickbooksConnector },
      rows: {
        purchase_orders: [
          { id: 'po-1', po_number: 'PO-1', supplier_id: 'sup-1', subtotal: 120, total: 120 },
        ],
        suppliers: [SUPPLIER],
      },
    },
    {
      name: 'QuickBooks return.closed (a JournalEntry)',
      conn: QBO_CONN,
      event: outboxEvent('return.closed', 'return', 'ret-1'),
      connectors: { quickbooks: quickbooksConnector },
      rows: RETURN_ROWS,
    },
  ];

  /** An Intacct purchase order with no supplier: the default vendor, no vendor read. */
  const INTACCT_PO: Export = {
    name: 'Sage Intacct purchase_order.ordered',
    conn: INTACCT_CONN,
    event: outboxEvent('purchase_order.ordered', 'purchase_order', 'po-1'),
    connectors: { sage_intacct: sageIntacctConnector },
    rows: {
      purchase_orders: [
        { id: 'po-1', po_number: 'PO-1', supplier_id: null, subtotal: 120, total: 120 },
      ],
    },
  };
  const INTACCT_RETURN: Export = {
    name: 'Sage Intacct return.closed',
    conn: INTACCT_CONN,
    event: outboxEvent('return.closed', 'return', 'ret-1'),
    connectors: { sage_intacct: sageIntacctConnector },
    rows: RETURN_ROWS,
  };
  /** An Intacct purchase order whose supplier has no mapping yet: the vendor read runs first. */
  const INTACCT_PO_VENDOR_READ: Export = {
    ...INTACCT_PO,
    name: 'Sage Intacct purchase_order.ordered with an unmapped supplier',
    rows: {
      purchase_orders: [
        { id: 'po-1', po_number: 'PO-1', supplier_id: 'sup-1', subtotal: 120, total: 120 },
      ],
      suppliers: [SUPPLIER],
    },
  };

  const fetchFailed = (cause: unknown) => new TypeError('fetch failed', { cause });
  const sysError = (code: string, syscall: string) =>
    Object.assign(new Error(`${syscall} ${code}`), { code, syscall });
  const undiciError = (name: string, code: string) =>
    Object.assign(new Error(name), { name, code });
  /** node's connect to a host with several addresses (loopback probe, 2026-11-01). */
  const aggregate = (errors: Error[]) =>
    Object.assign(new AggregateError(errors), {
      code: (errors[0] as { code?: string } | undefined)?.code,
    });
  const timeout = () =>
    new DOMException('The operation was aborted due to timeout', 'TimeoutError');

  /** What the provider's fetch does instead of answering: reject, or answer this. */
  type Failure = () => Promise<Response>;
  const rejects =
    (error: unknown): Failure =>
    () =>
      Promise.reject(error);
  /** A 2xx whose body is cut off part way: the create happened. */
  const cutBody =
    (status: number): Failure =>
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"ia::result":{"key":"DOC'));
            controller.error(new TypeError('terminated'));
          },
        }),
        { status },
      );

  /** Failures in which no request byte left StockPilot: the lookup or the connect failed. */
  const NEVER_SENT: Array<[string, Failure]> = [
    ['ENOTFOUND', rejects(fetchFailed(sysError('ENOTFOUND', 'getaddrinfo')))],
    ['EAI_AGAIN', rejects(fetchFailed(sysError('EAI_AGAIN', 'getaddrinfo')))],
    ['ECONNREFUSED', rejects(fetchFailed(sysError('ECONNREFUSED', 'connect')))],
    [
      'UND_ERR_CONNECT_TIMEOUT',
      rejects(fetchFailed(undiciError('ConnectTimeoutError', 'UND_ERR_CONNECT_TIMEOUT'))),
    ],
    ['EHOSTUNREACH on connect', rejects(fetchFailed(sysError('EHOSTUNREACH', 'connect')))],
    [
      'every address refused (an AggregateError)',
      rejects(
        fetchFailed(
          aggregate([sysError('ECONNREFUSED', 'connect'), sysError('ECONNREFUSED', 'connect')]),
        ),
      ),
    ],
    [
      'every address failed to connect, with mixed codes',
      rejects(
        fetchFailed(
          aggregate([sysError('ETIMEDOUT', 'connect'), sysError('ENETUNREACH', 'connect')]),
        ),
      ),
    ],
  ];
  /** Failures after which the create may have reached the provider. */
  const MAY_HAVE_ARRIVED: Array<[string, Failure]> = [
    ['UND_ERR_SOCKET', rejects(fetchFailed(undiciError('SocketError', 'UND_ERR_SOCKET')))],
    ['ECONNRESET on read', rejects(fetchFailed(sysError('ECONNRESET', 'read')))],
    [
      'UND_ERR_HEADERS_TIMEOUT',
      rejects(fetchFailed(undiciError('HeadersTimeoutError', 'UND_ERR_HEADERS_TIMEOUT'))),
    ],
    ['the timeout', rejects(timeout())],
    ['a 2xx whose body is cut off', cutBody(201)],
    [
      'an AggregateError with an inner error that is not a failed connect',
      rejects(
        fetchFailed(
          aggregate([sysError('ECONNREFUSED', 'connect'), sysError('ECONNRESET', 'read')]),
        ),
      ),
    ],
  ];

  /** The provider's fetch: `onCall(n)` answers its nth call (0-based). */
  let onCall: (n: number) => Promise<Response> = async () => json({});
  const providerFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    onCall(providerFetch.mock.calls.length - 1),
  );

  beforeEach(() => {
    vi.mocked(reportError).mockClear();
    providerFetch.mockClear();
    vi.stubGlobal('fetch', providerFetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  /** One drain of `x`; every read answers as PostgREST would, every supplier is mapped
   *  (unless `unmappedSupplier`), and nothing is posted yet. */
  async function drain(x: Export, opts: { unmappedSupplier?: boolean } = {}) {
    const requests: ClientRequest[] = [];
    const admin = realSupabaseClient((req) => {
      requests.push(req);
      const path = req.url.pathname.replace(/^\/rest\/v1\//, '');
      if (req.method === 'GET' && path === 'org_connections') return json([x.conn]);
      if (req.method === 'GET' && path === 'organization_modules')
        return json([{ organization_id: 'org-1' }]);
      if (path === 'rpc/connector_drain_candidates') return json([x.event]);
      if (req.method === 'GET' && path === 'connection_sync_log') return json([]);
      if (req.method === 'GET' && path === 'connection_mappings') {
        return req.url.searchParams.get('entity_type') === 'eq.supplier' && !opts.unmappedSupplier
          ? json([{ external_id: 'VENDOR-7', external_meta: {} }])
          : json([]);
      }
      if (req.method === 'GET' && x.rows[path]) return json(x.rows[path]);
      // The writes: the pending row, the outcome, the mapping, last_synced_at.
      return new Response(null, { status: 204 });
    });
    const result = await runDrain(admin, x.connectors, NOW);
    const outcome = requests
      .filter((r) => r.method === 'PATCH' && r.url.pathname.endsWith('/connection_sync_log'))
      .map((r) => JSON.parse(r.body ?? '{}') as Record<string, unknown>);
    expect(outcome).toHaveLength(1);
    return { result, outcome: outcome[0]! };
  }

  function expectRetriedWithBackoff(run: Awaited<ReturnType<typeof drain>>) {
    expect(run.result).toEqual({ processed: 1, succeeded: 0, failed: 1, deadlettered: 0 });
    expect(run.outcome.status).toBe('error');
    expect(new Date(run.outcome.next_attempt_at as string).getTime()).toBeGreaterThan(
      NOW.getTime(),
    );
  }

  describe.each(QBO_EXPORTS)('$name', (x) => {
    it.each([
      ...NEVER_SENT,
      ...MAY_HAVE_ARRIVED,
      ['a 200 whose body is not JSON', async () => new Response('not json', { status: 200 })],
    ] as Array<[string, Failure]>)(
      '%s: error with backoff, not dead (the requestid makes a repeat safe)',
      async (_shape, failure) => {
        onCall = () => failure();
        const run = await drain(x);
        expect(providerFetch).toHaveBeenCalledTimes(1);
        expectRetriedWithBackoff(run);
      },
    );
  });

  describe.each([INTACCT_PO, INTACCT_RETURN])('$name', (x) => {
    it.each(NEVER_SENT)(
      '%s: the create never left, so error with backoff',
      async (_shape, failure) => {
        onCall = () => failure();
        const run = await drain(x);
        expect(providerFetch).toHaveBeenCalledTimes(1);
        expectRetriedWithBackoff(run);
      },
    );

    it.each(MAY_HAVE_ARRIVED)(
      '%s: the create may have arrived, so dead with the check-before-Replay sentence first',
      async (_shape, failure) => {
        onCall = () => failure();
        const run = await drain(x);
        expect(providerFetch).toHaveBeenCalledTimes(1);
        expect(run.result).toEqual({ processed: 1, succeeded: 0, failed: 0, deadlettered: 1 });
        expect(run.outcome.status).toBe('dead');
        expect(run.outcome.next_attempt_at).toBeNull();
        expect(String(run.outcome.last_error).startsWith(`${INTACCT_MAY_HAVE_POSTED} `)).toBe(true);
      },
    );

    it.each([500, 502, 504])(
      'a create answered %i may have been committed: dead with the sentence first',
      async (status) => {
        onCall = async () => new Response('upstream error', { status });
        const run = await drain(x);
        expect(run.outcome.status).toBe('dead');
        expect(run.outcome.next_attempt_at).toBeNull();
        expect(run.outcome.last_error).toBe(
          `${INTACCT_MAY_HAVE_POSTED} Intacct POST ${
            x === INTACCT_PO
              ? '/objects/purchasing/document'
              : '/objects/general-ledger/journal-entry'
          } failed (status ${status}): upstream error`,
        );
      },
    );

    it.each([429, 503])('a create answered %i retries with backoff (unchanged)', async (status) => {
      onCall = async () => new Response('busy', { status });
      expectRetriedWithBackoff(await drain(x));
    });
  });

  describe('the Intacct vendor read', () => {
    it('a vendor read that got no answer retries with backoff, and nothing is created', async () => {
      onCall = () => Promise.reject(fetchFailed(undiciError('SocketError', 'UND_ERR_SOCKET')));
      const run = await drain(INTACCT_PO_VENDOR_READ, { unmappedSupplier: true });
      // Only the vendor read was made.
      expect(providerFetch).toHaveBeenCalledTimes(1);
      expect(String(providerFetch.mock.calls[0]?.[0])).toContain('/services/core/query');
      expectRetriedWithBackoff(run);
      expect(String(run.outcome.last_error)).not.toContain(INTACCT_MAY_HAVE_POSTED);
    });

    it('a vendor read answered 502 retries with backoff (unchanged)', async () => {
      onCall = async () => new Response('upstream error', { status: 502 });
      const run = await drain(INTACCT_PO_VENDOR_READ, { unmappedSupplier: true });
      expect(providerFetch).toHaveBeenCalledTimes(1);
      expectRetriedWithBackoff(run);
    });
  });
});
