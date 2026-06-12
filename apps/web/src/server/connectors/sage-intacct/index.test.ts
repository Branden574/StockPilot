import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_APP_URL: 'https://app.test',
    SAGE_INTACCT_CLIENT_ID: 'client-id',
    SAGE_INTACCT_CLIENT_SECRET: 'client-secret',
  },
}));

import type { ConnectionRef, ConnectorDeps, OutboxEvent } from '@stockpilot/core';

import { sageIntacctConnector } from './index';

/** Chainable supabase-table mock: every chain method returns itself; terminal
 *  maybeSingle()/eq() resolve to the queued result. */
function tableMock(result: { data: unknown; error: { message: string } | null }) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'order', 'limit']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  // .eq(...) chains; a bare awaited list query resolves via then()
  (chain as { then?: unknown }).then = undefined;
  return chain as Record<string, ReturnType<typeof vi.fn>> & { maybeSingle: ReturnType<typeof vi.fn> };
}

function makeAdmin(tables: Record<string, unknown>) {
  return {
    from: vi.fn((t: string) => {
      const mock = tables[t];
      if (!mock) throw new Error(`unexpected table ${t}`);
      return mock;
    }),
  };
}

function makeDeps(admin: unknown, overrides: Partial<ConnectorDeps> = {}): ConnectorDeps {
  return {
    admin,
    fetch,
    getMapping: vi.fn().mockResolvedValue(null),
    putMapping: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const SECRETS = { accessToken: 'at', refreshToken: 'rt', expiresAt: new Date(Date.now() + 3600e3).toISOString() };

function conn(settings: Record<string, unknown>): ConnectionRef {
  return {
    id: 'conn-1',
    organizationId: 'org-1',
    providerId: 'sage_intacct',
    status: 'active',
    externalAccountId: 'co-1',
    settings,
  };
}

function poEvent(): OutboxEvent {
  return {
    id: 'evt-1',
    organizationId: 'org-1',
    topic: 'purchase_order.ordered',
    aggregateType: 'purchase_order',
    aggregateId: 'po-1',
    payload: {},
    dedupeKey: null,
    createdAt: new Date().toISOString(),
  };
}

function returnEvent(): OutboxEvent {
  return { ...poEvent(), topic: 'return.closed', aggregateType: 'return', aggregateId: 'ret-1' };
}

const GOOD_SETTINGS = {
  intacct: { defaultItemId: 'NONINV', poTxnDefinition: 'Purchase Order', defaultVendorId: 'VDEF', journalSymbol: 'GJ' },
  accountIds: { returnCredit: '4900', inventoryAsset: '1200' },
};

describe('sageIntacctConnector — purchase_order.ordered', () => {
  const fetchSpy = vi.fn();
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('acks an event with no aggregate id', async () => {
    const res = await sageIntacctConnector.handleOutboxEvent(
      { ...poEvent(), aggregateId: null },
      conn(GOOD_SETTINGS),
      SECRETS,
      makeDeps(makeAdmin({})),
    );
    expect(res).toEqual({ ok: true });
  });

  it('fails non-retryably when the default item is not configured', async () => {
    const res = await sageIntacctConnector.handleOutboxEvent(
      poEvent(),
      conn({ intacct: {} }),
      SECRETS,
      makeDeps(makeAdmin({})),
    );
    expect(res.ok).toBe(false);
    expect(res.retryable).toBe(false);
    expect(res.error).toMatch(/default item/i);
  });

  it('short-circuits via the existing mapping (idempotent replay)', async () => {
    const deps = makeDeps(makeAdmin({}), {
      getMapping: vi.fn().mockResolvedValue({ externalId: 'DOC-7', externalMeta: {} }),
    });
    const res = await sageIntacctConnector.handleOutboxEvent(poEvent(), conn(GOOD_SETTINGS), SECRETS, deps);
    expect(res).toEqual({ ok: true, externalId: 'DOC-7' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('THROWS on a transient PO read error (drainer retries — fail closed)', async () => {
    const admin = makeAdmin({
      purchase_orders: tableMock({ data: null, error: { message: 'timeout' } }),
    });
    await expect(
      sageIntacctConnector.handleOutboxEvent(poEvent(), conn(GOOD_SETTINGS), SECRETS, makeDeps(admin)),
    ).rejects.toThrow(/purchase_orders select/);
  });

  it('acks a genuinely-absent PO', async () => {
    const admin = makeAdmin({ purchase_orders: tableMock({ data: null, error: null }) });
    const res = await sageIntacctConnector.handleOutboxEvent(
      poEvent(),
      conn(GOOD_SETTINGS),
      SECRETS,
      makeDeps(admin),
    );
    expect(res).toEqual({ ok: true });
  });

  it('acks a zero-total PO without POSTing', async () => {
    const admin = makeAdmin({
      purchase_orders: tableMock({
        data: { id: 'po-1', po_number: 'PO-1', supplier_id: null, total: 0 },
        error: null,
      }),
    });
    const res = await sageIntacctConnector.handleOutboxEvent(
      poEvent(),
      conn(GOOD_SETTINGS),
      SECRETS,
      makeDeps(admin),
    );
    expect(res).toEqual({ ok: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('pushes the document, maps the PO, and uses the default vendor when no supplier', async () => {
    const admin = makeAdmin({
      purchase_orders: tableMock({
        data: { id: 'po-1', po_number: 'PO-1', supplier_id: null, total: 250 },
        error: null,
      }),
    });
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ 'ia::result': { key: '321', id: 'PO-1' } }), { status: 201 }),
    );
    const deps = makeDeps(admin);
    const res = await sageIntacctConnector.handleOutboxEvent(
      poEvent(),
      conn(GOOD_SETTINGS),
      SECRETS,
      deps,
    );
    expect(res.ok).toBe(true);
    expect(res.externalId).toBe('321');
    expect(deps.putMapping).toHaveBeenCalledWith('conn-1', 'org-1', 'purchase_order', 'po-1', '321');

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.intacct.com/ia/api/v1/objects/purchasing/document');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.vendor).toEqual({ id: 'VDEF' });
    expect((body.lines as unknown[]).length).toBe(1);
  });

  it("blank-saved settings ('' txn definition) still push with the documented default", async () => {
    // The settings card persists '' for fields left blank — `??` would let ''
    // through and POST txnDefinition {name: ''} (non-retryable 400 forever).
    const admin = makeAdmin({
      purchase_orders: tableMock({
        data: { id: 'po-1', po_number: 'PO-1', supplier_id: null, total: 250 },
        error: null,
      }),
    });
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ 'ia::result': { key: '99' } }), { status: 201 }),
    );
    const res = await sageIntacctConnector.handleOutboxEvent(
      poEvent(),
      conn({ intacct: { ...GOOD_SETTINGS.intacct, poTxnDefinition: '' } }),
      SECRETS,
      makeDeps(admin),
    );
    expect(res.ok).toBe(true);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { txnDefinition: { name: string } };
    expect(body.txnDefinition).toEqual({ name: 'Purchase Order' });
  });

  it('fails non-retryably when no vendor resolves and no default is configured', async () => {
    const admin = makeAdmin({
      purchase_orders: tableMock({
        data: { id: 'po-1', po_number: 'PO-1', supplier_id: null, total: 250 },
        error: null,
      }),
    });
    const settings = { intacct: { ...GOOD_SETTINGS.intacct, defaultVendorId: undefined } };
    const res = await sageIntacctConnector.handleOutboxEvent(
      poEvent(),
      conn(settings),
      SECRETS,
      makeDeps(admin),
    );
    expect(res.ok).toBe(false);
    expect(res.retryable).toBe(false);
    expect(res.error).toMatch(/vendor/i);
  });

  it('classifies a 429 as retryable and a 400 as not', async () => {
    const admin = () =>
      makeAdmin({
        purchase_orders: tableMock({
          data: { id: 'po-1', po_number: 'PO-1', supplier_id: null, total: 250 },
          error: null,
        }),
      });

    fetchSpy.mockResolvedValueOnce(new Response('rate limited', { status: 429 }));
    const r429 = await sageIntacctConnector.handleOutboxEvent(
      poEvent(),
      conn(GOOD_SETTINGS),
      SECRETS,
      makeDeps(admin()),
    );
    expect(r429.ok).toBe(false);
    expect(r429.retryable).toBe(true);

    fetchSpy.mockResolvedValueOnce(new Response('bad request', { status: 400 }));
    const r400 = await sageIntacctConnector.handleOutboxEvent(
      poEvent(),
      conn(GOOD_SETTINGS),
      SECRETS,
      makeDeps(admin()),
    );
    expect(r400.ok).toBe(false);
    expect(r400.retryable).toBe(false);
  });
});

describe('sageIntacctConnector — return.closed', () => {
  const fetchSpy = vi.fn();
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  function returnTables(lines: unknown[]) {
    // return_lines: the awaited terminal is .eq() — emulate a thenable chain.
    const linesChain: Record<string, unknown> = {};
    linesChain.select = vi.fn().mockReturnValue(linesChain);
    linesChain.eq = vi.fn().mockResolvedValue({ data: lines, error: null });
    return {
      returns: tableMock({ data: { id: 'ret-1', return_number: 'RET-1' }, error: null }),
      return_lines: linesChain,
    };
  }

  it('fails non-retryably when GL accounts are not configured', async () => {
    const res = await sageIntacctConnector.handleOutboxEvent(
      returnEvent(),
      conn({ intacct: GOOD_SETTINGS.intacct, accountIds: {} }),
      SECRETS,
      makeDeps(makeAdmin({})),
    );
    expect(res.ok).toBe(false);
    expect(res.retryable).toBe(false);
  });

  it('posts a balanced journal entry and maps the return', async () => {
    const admin = makeAdmin(
      returnTables([
        { quantity: 2, order_request_line: { unit_cost_at_request: 10 } },
      ]),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ 'ia::result': { key: '555' } }), { status: 201 }),
    );
    const deps = makeDeps(admin);
    const res = await sageIntacctConnector.handleOutboxEvent(
      returnEvent(),
      conn(GOOD_SETTINGS),
      SECRETS,
      deps,
    );
    expect(res.ok).toBe(true);
    expect(res.externalId).toBe('555');
    expect(deps.putMapping).toHaveBeenCalledWith('conn-1', 'org-1', 'return', 'ret-1', '555');

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.intacct.com/ia/api/v1/objects/general-ledger/journal-entry');
    const body = JSON.parse(String(init.body)) as { lines: Array<{ txnType: string; txnAmount: number }> };
    expect(body.lines[0]?.txnAmount).toBe(20);
    expect(body.lines[0]?.txnType).toBe('debit');
    expect(body.lines[1]?.txnType).toBe('credit');
  });

  it("blank-saved settings ('' journal symbol) still post with the GJ default", async () => {
    const admin = makeAdmin(
      returnTables([{ quantity: 1, order_request_line: { unit_cost_at_request: 5 } }]),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ 'ia::result': { key: '7' } }), { status: 201 }),
    );
    const res = await sageIntacctConnector.handleOutboxEvent(
      returnEvent(),
      conn({
        intacct: { ...GOOD_SETTINGS.intacct, journalSymbol: '' },
        accountIds: GOOD_SETTINGS.accountIds,
      }),
      SECRETS,
      makeDeps(admin),
    );
    expect(res.ok).toBe(true);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { journal: { id: string } };
    expect(body.journal).toEqual({ id: 'GJ' });
  });

  it('acks a zero-value return without POSTing', async () => {
    const admin = makeAdmin(
      returnTables([{ quantity: 1, order_request_line: { unit_cost_at_request: 0 } }]),
    );
    const res = await sageIntacctConnector.handleOutboxEvent(
      returnEvent(),
      conn(GOOD_SETTINGS),
      SECRETS,
      makeDeps(admin),
    );
    expect(res).toEqual({ ok: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('sageIntacctConnector — refreshAuth', () => {
  const fetchSpy = vi.fn();
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('spreads rotated tokens over existing secrets', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'at2', refresh_token: 'rt2', expires_in: 43200 }), {
        status: 200,
      }),
    );
    const out = await sageIntacctConnector.refreshAuth!(conn({}), { ...SECRETS, extra: 'keep' });
    expect(out.accessToken).toBe('at2');
    expect(out.refreshToken).toBe('rt2');
    expect(out.extra).toBe('keep');
  });
});
