import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  INTACCT_MAY_HAVE_POSTED,
  IntacctApiError,
  IntacctClient,
  IntacctNoAnswerError,
} from './client';

const SECRETS = { accessToken: 'bearer-secret-xyz', refreshToken: 'rt', expiresAt: '' };

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('IntacctClient.queryPage', () => {
  const fetchSpy = vi.fn();
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('parses the documented envelope and advances the cursor', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        'ia::result': [{ id: 'A' }, { id: 'B' }],
        'ia::meta': { totalCount: 5, start: 1, numRemaining: 3 },
      }),
    );
    const page = await new IntacctClient(SECRETS).queryPage({
      object: 'inventory-control/item',
      fields: ['id'],
      start: 1,
      size: 2,
    });
    expect(page.records).toHaveLength(2);
    expect(page.nextStart).toBe(3);
  });

  it('terminates when numRemaining is 0', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ 'ia::result': [{ id: 'A' }], 'ia::meta': { numRemaining: 0 } }),
    );
    const page = await new IntacctClient(SECRETS).queryPage({
      object: 'inventory-control/item',
      fields: ['id'],
    });
    expect(page.nextStart).toBeNull();
  });

  it('GUARD: an empty records page terminates even when meta claims more remain', async () => {
    // Envelope-shape drift (meta parses, records do not) would otherwise pin
    // nextStart === start and spin callers forever against the Intacct quota.
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ unexpected: { shape: true }, 'ia::meta': { start: 1, numRemaining: 100 } }),
    );
    const page = await new IntacctClient(SECRETS).queryPage({
      object: 'inventory-control/item',
      fields: ['id'],
      start: 1,
    });
    expect(page.records).toHaveLength(0);
    expect(page.nextStart).toBeNull();
  });

  it('throws a token-free IntacctApiError on a non-OK response', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('denied', { status: 403 }));
    const err = await new IntacctClient(SECRETS)
      .queryPage({ object: 'x', fields: ['id'] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntacctApiError);
    expect((err as IntacctApiError).status).toBe(403);
    expect((err as IntacctApiError).message).not.toContain('bearer-secret-xyz');
  });
});

/** What fetch rejects with when no HTTP answer came, as undici builds it. */
function fetchFailed(cause: unknown): TypeError {
  return new TypeError('fetch failed', { cause });
}
/** A system error from the socket or the resolver: its code and syscall. */
function sysError(code: string, syscall: string): Error {
  return Object.assign(new Error(`${syscall} ${code}`), { code, syscall });
}
/** An undici error: a code and no syscall. */
function undiciError(name: string, code: string): Error {
  return Object.assign(new Error(name), { name, code });
}
/** node's connect to a host with several addresses: an AggregateError that
 *  carries its first inner error's code itself (loopback probe, 2026-11-01). */
function aggregate(errors: Error[]): AggregateError {
  const code = (errors[0] as { code?: string } | undefined)?.code;
  return Object.assign(new AggregateError(errors), code ? { code } : {});
}

/** Failures in which no request byte left StockPilot: the lookup or the connect failed. */
const NEVER_SENT: Array<[string, unknown, string]> = [
  ['ENOTFOUND', fetchFailed(sysError('ENOTFOUND', 'getaddrinfo')), 'ENOTFOUND'],
  ['EAI_AGAIN', fetchFailed(sysError('EAI_AGAIN', 'getaddrinfo')), 'EAI_AGAIN'],
  ['ECONNREFUSED', fetchFailed(sysError('ECONNREFUSED', 'connect')), 'ECONNREFUSED'],
  [
    'UND_ERR_CONNECT_TIMEOUT',
    fetchFailed(undiciError('ConnectTimeoutError', 'UND_ERR_CONNECT_TIMEOUT')),
    'UND_ERR_CONNECT_TIMEOUT',
  ],
  ['EHOSTUNREACH on connect', fetchFailed(sysError('EHOSTUNREACH', 'connect')), 'EHOSTUNREACH'],
  [
    'every address refused (an AggregateError)',
    fetchFailed(
      aggregate([sysError('ECONNREFUSED', 'connect'), sysError('ECONNREFUSED', 'connect')]),
    ),
    'ECONNREFUSED',
  ],
  [
    'every address failed to connect, with mixed codes',
    fetchFailed(aggregate([sysError('ETIMEDOUT', 'connect'), sysError('ENETUNREACH', 'connect')])),
    'ETIMEDOUT',
  ],
];

/** Failures after which the request may have reached Intacct. */
const MAY_HAVE_ARRIVED: Array<[string, unknown, string]> = [
  ['UND_ERR_SOCKET', fetchFailed(undiciError('SocketError', 'UND_ERR_SOCKET')), 'UND_ERR_SOCKET'],
  ['ECONNRESET on read', fetchFailed(sysError('ECONNRESET', 'read')), 'ECONNRESET'],
  [
    'UND_ERR_HEADERS_TIMEOUT',
    fetchFailed(undiciError('HeadersTimeoutError', 'UND_ERR_HEADERS_TIMEOUT')),
    'UND_ERR_HEADERS_TIMEOUT',
  ],
  [
    'the timeout',
    new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    'TimeoutError',
  ],
  [
    'an AggregateError with an inner error that is not a failed connect',
    fetchFailed(aggregate([sysError('ECONNREFUSED', 'connect'), sysError('ECONNRESET', 'read')])),
    'ECONNREFUSED',
  ],
  ['an empty AggregateError', fetchFailed(new AggregateError([])), 'AggregateError'],
  ['a TypeError with no cause', new TypeError('fetch failed'), 'TypeError'],
];

/** A 2xx whose body is cut off part way: the create happened. */
function cutBody(status: number): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ia::result":{"key":"DOC'));
      controller.error(new TypeError('terminated'));
    },
  });
  return new Response(stream, { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * docket B81: fetch's own failure (no HTTP answer) reached the connector with
 * no status, and its classifier read that as a caller error: the export went
 * to dead on its first try. Intacct REST v1 has no requestid, so a create may
 * be sent again only when it provably never left: its lookup or its connect
 * failed. Any other create failure says so first, for an admin to check
 * Intacct before Replay. A read is always safe to repeat.
 */
describe('IntacctClient: a call that got no answer', () => {
  const fetchSpy = vi.fn();
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  const client = () => new IntacctClient(SECRETS);
  const create = () => client().post('/objects/purchasing/document', { a: 1 });
  const reads: Array<[string, () => Promise<unknown>, string]> = [
    [
      'queryPage()',
      () => client().queryPage({ object: 'accounts-payable/vendor', fields: ['id'] }),
      'POST /services/core/query',
    ],
    [
      'get()',
      () => client().get('/objects/purchasing/document/7'),
      'GET /objects/purchasing/document/7',
    ],
  ];

  it.each(NEVER_SENT)('%s: a create may be sent again', async (_shape, failure, code) => {
    fetchSpy.mockRejectedValueOnce(failure);
    const err = await create().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntacctNoAnswerError);
    expect((err as IntacctNoAnswerError).retryable).toBe(true);
    expect((err as Error).message).toBe(
      `Intacct POST /objects/purchasing/document got no answer (${code})`,
    );
    expect((err as Error).cause).toBe(failure);
  });

  it.each(MAY_HAVE_ARRIVED)(
    '%s: a create stops, and its message starts with the check-before-Replay sentence',
    async (_shape, failure, code) => {
      fetchSpy.mockRejectedValueOnce(failure);
      const err = await create().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IntacctNoAnswerError);
      expect((err as IntacctNoAnswerError).retryable).toBe(false);
      expect((err as Error).message).toBe(
        `${INTACCT_MAY_HAVE_POSTED} Intacct POST /objects/purchasing/document got no answer (${code})`,
      );
      expect((err as Error).message).not.toContain('bearer-secret-xyz');
    },
  );

  it.each([...NEVER_SENT, ...MAY_HAVE_ARRIVED])(
    '%s: a read may always be made again',
    async (_shape, failure, code) => {
      for (const [, read, what] of reads) {
        fetchSpy.mockRejectedValueOnce(failure);
        const err = await read().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(IntacctNoAnswerError);
        expect((err as IntacctNoAnswerError).retryable).toBe(true);
        expect((err as Error).message).toBe(`Intacct ${what} got no answer (${code})`);
      }
    },
  );

  it('a 2xx whose body cannot be read: a read may be made again; a create happened, so it stops', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{"ia::result": [', { status: 200 }));
    const readErr = await client()
      .queryPage({ object: 'accounts-payable/vendor', fields: ['id'] })
      .catch((e: unknown) => e);
    expect(readErr).toBeInstanceOf(IntacctNoAnswerError);
    expect((readErr as IntacctNoAnswerError).retryable).toBe(true);
    expect((readErr as Error).message).not.toContain(INTACCT_MAY_HAVE_POSTED);

    fetchSpy.mockResolvedValueOnce(cutBody(201));
    const createErr = await create().catch((e: unknown) => e);
    expect(createErr).toBeInstanceOf(IntacctNoAnswerError);
    expect((createErr as IntacctNoAnswerError).retryable).toBe(false);
    expect((createErr as Error).message).toBe(
      `${INTACCT_MAY_HAVE_POSTED} Intacct POST /objects/purchasing/document answered 201 with a body that could not be read (TypeError)`,
    );
  });

  it('a create answered 500, 502 or 504 may have been committed; 503 and a read answered 5xx were not', async () => {
    for (const status of [500, 502, 504]) {
      fetchSpy.mockResolvedValueOnce(new Response('upstream', { status }));
      const err = await create().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IntacctApiError);
      expect((err as IntacctApiError).status).toBe(status);
      expect((err as IntacctApiError).mayHavePosted).toBe(true);
      expect((err as Error).message).toBe(
        `${INTACCT_MAY_HAVE_POSTED} Intacct POST /objects/purchasing/document failed (status ${status}): upstream`,
      );
    }

    fetchSpy.mockResolvedValueOnce(new Response('busy', { status: 503 }));
    const busy = await create().catch((e: unknown) => e);
    expect((busy as IntacctApiError).mayHavePosted).toBe(false);
    expect((busy as Error).message).toBe(
      'Intacct POST /objects/purchasing/document failed (status 503): busy',
    );

    fetchSpy.mockResolvedValueOnce(new Response('upstream', { status: 502 }));
    const readErr = await client()
      .queryPage({ object: 'accounts-payable/vendor', fields: ['id'] })
      .catch((e: unknown) => e);
    expect((readErr as IntacctApiError).status).toBe(502);
    expect((readErr as IntacctApiError).mayHavePosted).toBe(false);
  });

  it('sends a timeout signal only when built with one (the import builds it without)', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    fetchSpy.mockImplementation(
      async () => new Response(JSON.stringify({ 'ia::result': [] }), { status: 200 }),
    );

    await new IntacctClient(SECRETS).queryPage({ object: 'x', fields: ['id'] });
    expect(timeoutSpy).not.toHaveBeenCalled();
    expect((fetchSpy.mock.calls[0]?.[1] as RequestInit).signal).toBeUndefined();

    await new IntacctClient(SECRETS, { requestTimeoutMs: 15_000 }).post('/objects/x', {});
    expect(timeoutSpy.mock.calls).toEqual([[15_000]]);
    expect((fetchSpy.mock.calls[1]?.[1] as RequestInit).signal).toBe(
      timeoutSpy.mock.results[0]?.value,
    );
  });
});

/**
 * The failure shapes above were copied from a loopback probe on Node 22 and
 * undici 6; production runs Node 24, as CI does. These run the never-sent rule
 * against this runtime's own fetch, over 127.0.0.1 only: a refused connect,
 * to a host with one address or two, must read as never sent; a connection
 * the server drops after reading the whole request, and a request it read and
 * never answered, must not.
 */
describe('IntacctClient against the runtime fetch (loopback only)', () => {
  const runtimeFetch = globalThis.fetch;
  let target = '';
  /** Merged into the next call's options (the two-address case's dispatcher). */
  let extraInit: Record<string, unknown> = {};
  let server: Server | null = null;
  const sockets = new Set<Socket>();
  beforeEach(() => {
    vi.stubGlobal('fetch', (_input: RequestInfo | URL, init?: RequestInit) =>
      runtimeFetch(target, { ...init, ...extraInit } as RequestInit),
    );
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    extraInit = {};
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    const open = server;
    server = null;
    if (open?.listening) await new Promise<void>((resolve) => open.close(() => resolve()));
  });

  async function listen(onConnection?: (socket: Socket) => void): Promise<number> {
    server = createServer((socket) => {
      sockets.add(socket);
      onConnection?.(socket);
    });
    const listening = server;
    await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve));
    return (listening.address() as AddressInfo).port;
  }

  /** A loopback port nothing listens on: a connect to it is refused. */
  async function refusedPort(): Promise<number> {
    const port = await listen();
    const closing = server!;
    server = null;
    await new Promise<void>((resolve) => closing.close(() => resolve()));
    return port;
  }

  it('a refused connection was never sent: a create may be sent again', async () => {
    const port = await refusedPort();
    target = `http://127.0.0.1:${port}/objects/x`;

    const err = await new IntacctClient(SECRETS, { requestTimeoutMs: 5_000 })
      .post('/objects/x', {})
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(IntacctNoAnswerError);
    expect((err as Error).message).toBe('Intacct POST /objects/x got no answer (ECONNREFUSED)');
    expect((err as IntacctNoAnswerError).retryable).toBe(true);
  });

  it('a connection dropped after the whole request was read may have arrived: a create stops', async () => {
    const port = await listen((socket) => {
      let received = '';
      socket.on('data', (chunk) => {
        received += chunk.toString();
        // The headers and the two-byte body '{}' are all in: drop the connection.
        if (received.includes('\r\n\r\n') && received.endsWith('{}')) socket.destroy();
      });
    });
    target = `http://127.0.0.1:${port}/objects/x`;

    const err = await new IntacctClient(SECRETS, { requestTimeoutMs: 5_000 })
      .post('/objects/x', {})
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(IntacctNoAnswerError);
    expect((err as Error).message).toMatch(
      /^This export may have reached Sage Intacct\. .* got no answer \((UND_ERR_SOCKET|ECONNRESET)\)$/,
    );
    expect((err as IntacctNoAnswerError).retryable).toBe(false);
  });

  it('a request the server read and never answered may have arrived: the create stops at its timeout', async () => {
    // Reads everything and answers nothing.
    const port = await listen((socket) => socket.on('data', () => undefined));
    target = `http://127.0.0.1:${port}/objects/x`;

    const err = await new IntacctClient(SECRETS, { requestTimeoutMs: 300 })
      .post('/objects/x', {})
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(IntacctNoAnswerError);
    expect((err as Error).message).toBe(
      `${INTACCT_MAY_HAVE_POSTED} Intacct POST /objects/x got no answer (TimeoutError)`,
    );
    expect((err as IntacctNoAnswerError).retryable).toBe(false);
  });

  it('a refused connect to a host with two addresses was never sent: a create may be sent again', async () => {
    const port = await refusedPort();
    // The runtime's own undici Agent, the one its fetch uses, set up on the
    // first call. Its lookup answers two addresses, one per family, for one
    // name, so the connect tries both (on Node 22 and undici 6 the failure is
    // an AggregateError whose inner errors carry syscall 'connect').
    await runtimeFetch(`http://127.0.0.1:${port}/`).catch(() => undefined);
    const runtimeDispatcher = (globalThis as unknown as Record<symbol, unknown>)[
      Symbol.for('undici.globalDispatcher.1')
    ];
    expect(runtimeDispatcher).toBeTruthy();
    const RuntimeAgent = (
      runtimeDispatcher as { constructor: new (options: unknown) => { close(): Promise<void> } }
    ).constructor;
    const agent = new RuntimeAgent({
      connect: {
        lookup: (
          _hostname: string,
          options: { all?: boolean } | undefined,
          callback: (...args: unknown[]) => void,
        ) => {
          const addresses = [
            { address: '127.0.0.1', family: 4 },
            { address: '::ffff:127.0.0.1', family: 6 },
          ];
          if (options?.all) callback(null, addresses);
          else callback(null, addresses[0]!.address, addresses[0]!.family);
        },
      },
    });
    extraInit = { dispatcher: agent };
    target = `http://two-addresses.invalid:${port}/objects/x`;

    try {
      const err = await new IntacctClient(SECRETS, { requestTimeoutMs: 5_000 })
        .post('/objects/x', {})
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(IntacctNoAnswerError);
      expect((err as Error).message).toMatch(
        /^Intacct POST \/objects\/x got no answer \(E[A-Z]+\)$/,
      );
      expect((err as IntacctNoAnswerError).retryable).toBe(true);
    } finally {
      await agent.close();
    }
  });
});
