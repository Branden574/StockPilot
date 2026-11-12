import { GoogleGenerativeAIAbortError, GoogleGenerativeAIFetchError } from '@google/generative-ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';
import { VISION_FAILED_MESSAGE } from '@/server/lib/api-error-response';
import type { ServiceContext } from '@/server/services/context';

/**
 * Wave B security regressions for the AI tool surface.
 *
 * Each block names its finding and asserts the SPECIFIC property that was
 * missing, not just that the tool still works — a test that only checks the
 * happy path would have passed against the vulnerable code too.
 */

const listMock = vi.fn();
const adjustStockMock = vi.fn();
const getMock = vi.fn();
const checkRateLimitMock = vi.fn();
const safeFetchMock = vi.fn();
const embedQueryMock = vi.fn();
const embedItemsBatchMock = vi.fn();
const reportErrorMock = vi.fn();
const updateMock = vi.fn();
const generateContentMock = vi.fn();
const auditMock = vi.fn();
// Settable per test: a missing model key is one of the cases under test.
const envMock = vi.hoisted(() => ({
  GEMINI_API_KEY: 'test-key',
  GEMINI_MODEL: 'gemini-2.0-flash',
  ANTHROPIC_API_KEY: '',
  ANTHROPIC_MODEL: 'claude-haiku-4-5',
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.test',
  NEXT_PUBLIC_APP_URL: 'https://app.stockpilot.test',
}));

vi.mock('@/server/services/inventory', () => ({
  InventoryService: class {
    list(...args: unknown[]) {
      return listMock(...args);
    }
    adjustStock(...args: unknown[]) {
      return adjustStockMock(...args);
    }
    get(...args: unknown[]) {
      return getMock(...args);
    }
    update(...args: unknown[]) {
      return updateMock(...args);
    }
  },
}));
vi.mock('@/server/services/movements', () => ({
  MovementsService: class {},
  getDashboardActions: vi.fn(),
  getDashboardSummary: vi.fn(),
  getLowStockItems: vi.fn(),
}));
vi.mock('@/server/services/categories', () => ({ CategoriesService: class {} }));
vi.mock('@/server/services/suppliers', () => ({ SuppliersService: class {} }));
vi.mock('@/server/services/warehouses', () => ({ WarehousesService: class {} }));
vi.mock('@/server/services/order-requests', () => ({ OrderRequestsService: class {} }));
vi.mock('@/server/services/purchase-orders', () => ({ PurchaseOrdersService: class {} }));
vi.mock('@/server/services/bundles', () => ({ BundlesService: class {} }));
vi.mock('@/server/services/books-import', () => ({ BooksImportService: class {} }));
vi.mock('@/server/services/forecasting', () => ({
  getItemVelocity: vi.fn(),
  suggestReorderPoint: vi.fn(),
}));
vi.mock('@/lib/books/lookup', () => ({ lookupIsbn: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
}));
// SSRF guard is stubbed at the module seam so no test performs real egress.
// The two classes keep the real module's shape: a failed lookup extends a
// refusal.
vi.mock('@/lib/ssrf-guard', () => {
  class SsrfBlockedError extends Error {
    constructor(public reason: string) {
      super(`Blocked by SSRF guard: ${reason}`);
      this.name = 'SsrfBlockedError';
    }
  }
  class SsrfLookupFailedError extends SsrfBlockedError {
    constructor(reason: string) {
      super(reason);
      this.name = 'SsrfLookupFailedError';
    }
  }
  return {
    safeFetch: (...args: unknown[]) => safeFetchMock(...args),
    SsrfBlockedError,
    SsrfLookupFailedError,
  };
});
vi.mock('@/lib/error-reporter', () => ({
  reportError: (...args: unknown[]) => reportErrorMock(...args),
}));
vi.mock('@/server/services/audit', () => ({
  audit: (...args: unknown[]) => auditMock(...args),
}));
// The real error classes (the tools tell failures apart by them); only the
// client is stubbed, so no test reaches the AI service.
vi.mock('@google/generative-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google/generative-ai')>()),
  GoogleGenerativeAI: class {
    getGenerativeModel() {
      return { generateContent: (...args: unknown[]) => generateContentMock(...args) };
    }
  },
}));
vi.mock('@/lib/ai/embeddings', () => ({
  embedQuery: (...args: unknown[]) => embedQueryMock(...args),
  embedItemsBatch: (...args: unknown[]) => embedItemsBatchMock(...args),
  vectorLiteral: (v: number[]) => `[${v.join(',')}]`,
}));
// A model key must be present or identifyFromPhoto short-circuits on "not
// configured" before reaching the controls under test. The two URLs below are
// what VISION_HOST_ALLOWLIST is derived from, so they also pin WHICH hosts the
// allowlist ends up containing. No key here reaches a real provider — every
// egress and model seam in this file is stubbed.
vi.mock('@/lib/env', () => ({ env: envMock }));
vi.mock('./provider', () => ({ resolveAiProvider: () => 'gemini' }));

import { SsrfBlockedError, SsrfLookupFailedError } from '@/lib/ssrf-guard';

import { classifyToolErrorMessage, executeToolCall } from './chat';
import {
  TOOL_FAILURE_SENTENCES,
  ToolRefusal,
  ToolUnavailableError,
  type ToolFailureKind,
} from './tool-errors';
import { TOOL_CATALOG } from './tools';

const ORG = 'org-aaaa';
const OTHER_ORG = 'org-bbbb';

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: a queued once-value a test did not use
  // must never be the next test's answer.
  vi.resetAllMocks();
  envMock.GEMINI_API_KEY = 'test-key';
  checkRateLimitMock.mockResolvedValue({ allowed: true, resetAt: Date.now() + 60_000 });
});

/** The thrown failure of a tool call that must not resolve. */
async function failureOf(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (e) {
    return e;
  }
  throw new Error('the tool call resolved; it was expected to throw');
}

/** `e` is the typed failure for `tool` and `kind`, carrying that fixed sentence. */
function expectUnavailable(
  e: unknown,
  tool: keyof typeof TOOL_FAILURE_SENTENCES,
  kind: ToolFailureKind,
): ToolUnavailableError {
  expect(e).toBeInstanceOf(ToolUnavailableError);
  const failure = e as ToolUnavailableError;
  expect(failure.tool).toBe(tool);
  expect(failure.kind).toBe(kind);
  expect(failure.message).toBe(TOOL_FAILURE_SENTENCES[tool][kind]);
  expect(classifyToolErrorMessage(failure)).toBe(TOOL_FAILURE_SENTENCES[tool][kind]);
  return failure;
}

// ═══════════════════════════════════════════════════════════════════════════
// HI-4 — listSuppliers had no organization filter.
// ═══════════════════════════════════════════════════════════════════════════

describe('HI-4: listSuppliers organization scoping', () => {
  it('filters suppliers by ctx.organizationId', async () => {
    const stub = makeSupabaseStub({
      'suppliers.select': {
        data: [{ id: 's-1', name: 'Acme', email: 'a@acme.test', phone: '555' }],
        error: null,
      },
    });
    const ctx = makeServiceContext(stub.client, {
      organizationId: ORG,
    }) as unknown as ServiceContext;

    await TOOL_CATALOG.listSuppliers!.execute({}, ctx);

    // The eq('organization_id', ORG) must be part of the query chain. Before
    // the fix the chain was select -> is -> order -> limit with no eq at all.
    const chain = stub.chains.get('suppliers.select') ?? [];
    const args = stub.chainArgs.get('suppliers.select') ?? [];
    const eqPairs = chain
      .map((method, i) => ({ method, args: args[i] }))
      .filter((c) => c.method === 'eq');
    expect(eqPairs).toEqual([{ method: 'eq', args: ['organization_id', ORG] }]);
  });

  it("does not return another organization's supplier PII", async () => {
    // Model the DB honouring the filter: the org-scoped query returns only the
    // caller's row. The assertion that matters is the one above (the filter is
    // sent); this pins the observable outcome the finding described — another
    // org's name/email/phone must not appear in the tool result.
    const stub = makeSupabaseStub({
      'suppliers.select': {
        data: [{ id: 's-1', name: 'Acme', email: 'a@acme.test', phone: '555-0100' }],
        error: null,
      },
    });
    const ctx = makeServiceContext(stub.client, {
      organizationId: ORG,
    }) as unknown as ServiceContext;

    const rows = (await TOOL_CATALOG.listSuppliers!.execute({}, ctx)) as Array<{
      name: unknown;
      email: unknown;
    }>;
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('Foreign Vendor');
    expect(serialized).not.toContain('leak@other.test');
    expect(rows).toHaveLength(1);
    // Supplier name + email stay fenced as data (they are free text + PII).
    expect(rows[0]!.name).toBe('<data>Acme</data>');
    expect(rows[0]!.email).toBe('<data>a@acme.test</data>');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// HI-3 — searchInventorySemantic had no organization filter.
// ═══════════════════════════════════════════════════════════════════════════

describe('HI-3: searchInventorySemantic organization scoping', () => {
  beforeEach(() => {
    embedQueryMock.mockResolvedValue([0.1, 0.2, 0.3]);
  });

  it('passes p_org_id from ctx to the RPC (never from the model)', async () => {
    const stub = makeSupabaseStub({
      'rpc:match_inventory_items_by_embedding': { data: [], error: null },
    });
    const ctx = makeServiceContext(stub.client, {
      organizationId: ORG,
    }) as unknown as ServiceContext;

    await TOOL_CATALOG.searchInventorySemantic!.execute(
      // A model that tries to supply its own org id must be ignored.
      { query: 'cleaning spills', organizationId: OTHER_ORG, p_org_id: OTHER_ORG },
      ctx,
    );

    expect(stub.rpcCalls).toHaveLength(1);
    const call = stub.rpcCalls[0]!;
    expect(call.name).toBe('match_inventory_items_by_embedding');
    expect((call.args as { p_org_id: string }).p_org_id).toBe(ORG);
  });

  it("post-filters rows that are not in the caller's org", async () => {
    // The RPC hands back a foreign row (this is what the un-migrated database
    // does, and what any future act-as path would do). The app layer must drop
    // it before the model ever sees it.
    const stub = makeSupabaseStub({
      'rpc:match_inventory_items_by_embedding': {
        data: [
          { id: 'item-mine', name: 'My Mop', sku: 'M-1', warehouse_id: 'w1', quantity_on_hand: 4, similarity: 0.91 },
          { id: 'item-foreign', name: 'Foreign Mop', sku: 'F-1', warehouse_id: 'w2', quantity_on_hand: 9, similarity: 0.99 },
        ],
        error: null,
      },
      // The confirmation query returns only the row that really is in this org.
      'inventory_items.select': { data: [{ id: 'item-mine' }], error: null },
    });
    const ctx = makeServiceContext(stub.client, {
      organizationId: ORG,
    }) as unknown as ServiceContext;

    const rows = (await TOOL_CATALOG.searchInventorySemantic!.execute(
      { query: 'mop' },
      ctx,
    )) as Array<{ id: string }>;

    expect(rows.map((r) => r.id)).toEqual(['item-mine']);
    // The foreign item's NAME must not survive anywhere in the payload — the
    // leak in the finding was item names and quantities reaching the model.
    expect(JSON.stringify(rows)).not.toContain('Foreign Mop');
    // Note the higher similarity on the foreign row: vector ranking has no
    // notion of tenancy, so the leaked row was often the TOP hit.
  });

  it('fails closed when the ownership confirmation query errors', async () => {
    const stub = makeSupabaseStub({
      'rpc:match_inventory_items_by_embedding': {
        data: [
          { id: 'item-x', name: 'Thing', sku: 'X', warehouse_id: null, quantity_on_hand: 1, similarity: 0.8 },
        ],
        error: null,
      },
      'inventory_items.select': { data: null, error: { message: 'boom' } },
    });
    const ctx = makeServiceContext(stub.client, {
      organizationId: ORG,
    }) as unknown as ServiceContext;

    // Unverified rows are NOT returned on a confirmation failure: the call
    // throws, and the database's word is in the cause, not in the message.
    const failure = expectUnavailable(
      await failureOf(TOOL_CATALOG.searchInventorySemantic!.execute({ query: 'thing' }, ctx)),
      'searchInventorySemantic',
      'failed',
    );
    expect(failure.message).not.toContain('boom');
    expect(failure.cause).toEqual({ message: 'boom' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// S30: a tool reports a failure by throwing a typed error whose message is a
// fixed sentence. The database's or the AI service's own words are kept as
// the cause, for the report, and are never in what the model reads.
// ═══════════════════════════════════════════════════════════════════════════

describe('S30: the semantic search and backfill tools fail by type, with a fixed sentence', () => {
  const RAW = 'relation "public.item_embeddings" violates row-level security policy p_example';

  function ctxFor(stub: ReturnType<typeof makeSupabaseStub>, role: 'staff' | 'admin' = 'staff') {
    return makeServiceContext(stub.client, {
      organizationId: ORG,
      role,
    }) as unknown as ServiceContext;
  }

  const search = (stub: ReturnType<typeof makeSupabaseStub>, query = 'mop') =>
    failureOf(TOOL_CATALOG.searchInventorySemantic!.execute({ query }, ctxFor(stub)));

  it('the search call fails: kind failed, no function name and no migration number', async () => {
    embedQueryMock.mockResolvedValueOnce([0.1, 0.2]);
    const error = {
      code: 'PGRST202',
      message: 'Could not find the function public.match_inventory_items_by_embedding in the schema cache',
    };
    const failure = expectUnavailable(
      await search(
        makeSupabaseStub({
          'rpc:match_inventory_items_by_embedding': { data: null, error },
        }),
      ),
      'searchInventorySemantic',
      'failed',
    );
    expect(failure.message).not.toContain('match_inventory_items_by_embedding');
    expect(failure.message).not.toContain('0320');
    expect(failure.message).not.toContain('schema cache');
    expect(failure.cause).toBe(error);
  });

  it('the ownership check fails: kind failed, and no row is returned', async () => {
    embedQueryMock.mockResolvedValueOnce([0.1, 0.2]);
    const failure = expectUnavailable(
      await search(
        makeSupabaseStub({
          'rpc:match_inventory_items_by_embedding': {
            data: [
              {
                id: 'item-x',
                name: 'Thing',
                sku: 'X',
                warehouse_id: null,
                quantity_on_hand: 1,
                similarity: 0.8,
              },
            ],
            error: null,
          },
          'inventory_items.select': { data: null, error: { message: RAW } },
        }),
      ),
      'searchInventorySemantic',
      'failed',
    );
    expect(failure.message).not.toContain('row-level security');
  });

  it.each([
    [
      'the AI service answers 429',
      'unavailable',
      () => new GoogleGenerativeAIFetchError('quota text from the service', 429, 'Too Many Requests'),
    ],
    [
      'the AI service answers 503',
      'unavailable',
      () => new GoogleGenerativeAIFetchError('overloaded text from the service', 503, 'Unavailable'),
    ],
    [
      'the call times out',
      'unavailable',
      () => new GoogleGenerativeAIAbortError('Request aborted when fetching the embedding'),
    ],
    [
      'the AI service refuses the key',
      'not_set_up',
      () =>
        new GoogleGenerativeAIFetchError('bad request text from the service', 400, 'Bad Request', [
          { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' },
        ]),
    ],
    ['the vector has the wrong shape', 'failed', () => new Error(RAW)],
  ] as const)('the query embedding fails because %s: kind %s', async (_case, kind, thrown) => {
    const cause = thrown();
    embedQueryMock.mockRejectedValueOnce(cause);
    const failure = expectUnavailable(
      await search(makeSupabaseStub({})),
      'searchInventorySemantic',
      kind,
    );
    expect(failure.message).not.toContain('service');
    expect(failure.message).not.toContain('row-level security');
    expect(failure.cause).toBe(cause);
  });

  it('with no model key: not set up, and nothing is embedded', async () => {
    envMock.GEMINI_API_KEY = '';
    expectUnavailable(await search(makeSupabaseStub({})), 'searchInventorySemantic', 'not_set_up');
    expect(embedQueryMock).not.toHaveBeenCalled();

    expectUnavailable(
      await failureOf(
        TOOL_CATALOG.backfillEmbeddings!.execute({}, ctxFor(makeSupabaseStub({}), 'admin')),
      ),
      'backfillEmbeddings',
      'not_set_up',
    );
    expect(embedItemsBatchMock).not.toHaveBeenCalled();
  });

  it('an empty query is refused in the tool’s own words', async () => {
    const failure = await search(makeSupabaseStub({}), '   ');
    expect(failure).toBeInstanceOf(ToolRefusal);
    expect((failure as Error).message).toBe('query is required');
    expect(embedQueryMock).not.toHaveBeenCalled();
  });

  it('nothing found is still an empty list, not a failure', async () => {
    embedQueryMock.mockResolvedValueOnce([0.1, 0.2]);
    const stub = makeSupabaseStub({
      'rpc:match_inventory_items_by_embedding': { data: [], error: null },
    });
    await expect(
      TOOL_CATALOG.searchInventorySemantic!.execute({ query: 'mop' }, ctxFor(stub)),
    ).resolves.toEqual([]);
  });

  it('the backfill’s own read fails: kind failed, the error kept as the cause', async () => {
    const cause = new Error(RAW);
    embedItemsBatchMock.mockRejectedValueOnce(cause);
    const failure = expectUnavailable(
      await failureOf(
        TOOL_CATALOG.backfillEmbeddings!.execute({}, ctxFor(makeSupabaseStub({}), 'admin')),
      ),
      'backfillEmbeddings',
      'failed',
    );
    expect(failure.message).not.toContain('row-level security');
    expect(failure.cause).toBe(cause);
    // Reported once, by the chat loop (toolFailureForModel), not here as well.
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it.each([
    ['gemini_key_invalid', 'not_set_up'],
    ['gemini_rate_limited', 'unavailable'],
    ['gemini_failing', 'unavailable'],
  ] as const)(
    'a batch that stopped early (%s) answers its counts and says why',
    async (stopped, kind) => {
      embedItemsBatchMock.mockResolvedValueOnce({
        embedded: 1,
        failed: 1,
        changed: 0,
        remaining: 40,
        firstError: 'quota text from the service',
        stopped,
        geminiFailuresInARow: 3,
      });
      const out = await TOOL_CATALOG.backfillEmbeddings!.execute(
        {},
        ctxFor(makeSupabaseStub({}), 'admin'),
      );
      expect(out).toEqual({
        embedded: 1,
        failed: 1,
        changed: 0,
        remaining: 40,
        note: TOOL_FAILURE_SENTENCES.backfillEmbeddings[kind],
      });
    },
  );

  it('a refused or failed backfill is audited as failed (through the chat loop’s boundary)', async () => {
    const viewer = makeServiceContext(makeSupabaseStub({}).client, {
      organizationId: ORG,
      role: 'viewer',
      permissions: new Set<string>(),
    }) as unknown as ServiceContext;
    await expect(
      executeToolCall(TOOL_CATALOG.backfillEmbeddings!, 'backfillEmbeddings', {}, viewer),
    ).rejects.toThrow(/permission/);
    expect(embedItemsBatchMock).not.toHaveBeenCalled();

    embedItemsBatchMock.mockRejectedValueOnce(new Error(RAW));
    await expect(
      executeToolCall(
        TOOL_CATALOG.backfillEmbeddings!,
        'backfillEmbeddings',
        {},
        ctxFor(makeSupabaseStub({}), 'admin'),
      ),
    ).rejects.toBeInstanceOf(ToolUnavailableError);

    expect(auditMock).toHaveBeenCalledTimes(2);
    for (const [payload] of auditMock.mock.calls) {
      expect(payload.event).toBe('ai.write_tool_invoked');
      expect(payload.extra).toMatchObject({ tool: 'backfillEmbeddings', ok: false });
    }
  });
});

describe('S30: identifyFromPhoto fails by type, with a fixed sentence', () => {
  const URL = 'https://project.supabase.test/storage/v1/object/sign/photos/cover.jpg';
  const SENTENCES = TOOL_FAILURE_SENTENCES.identifyFromPhoto;

  function ctxFor() {
    return makeServiceContext(makeSupabaseStub({}).client, {
      organizationId: ORG,
      userId: 'user-1',
    }) as unknown as ServiceContext;
  }

  const identify = () =>
    failureOf(TOOL_CATALOG.identifyFromPhoto!.execute({ imageUrl: URL }, ctxFor()));

  function answer(status: number, headers: Record<string, string> = {}, body = 'x'): Response {
    return new Response(status === 204 ? null : body, { status, statusText: 'Status Text', headers });
  }

  /** HEAD and GET both answer a small image, so the call reaches the model. */
  function imageDownloads() {
    safeFetchMock.mockImplementation(async () => answer(200, { 'content-type': 'image/jpeg' }));
  }

  /** A refusal in fixed words that names nothing from the failure. */
  function expectRefusal(e: unknown, sentence: string) {
    expect(e).toBeInstanceOf(ToolRefusal);
    expect((e as Error).message).toBe(sentence);
    expect(classifyToolErrorMessage(e)).toBe(sentence);
  }

  it('the failed sentence is the one the phone’s photo route answers', () => {
    expect(SENTENCES.failed).toBe(VISION_FAILED_MESSAGE);
  });

  it('with no model key: not set up, before any fetch', async () => {
    envMock.GEMINI_API_KEY = '';
    expectUnavailable(await identify(), 'identifyFromPhoto', 'not_set_up');
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 410])(
    'the address answers HEAD %i: the download sentence, not a permission or not-found one',
    async (status) => {
      safeFetchMock.mockResolvedValueOnce(answer(status));
      const e = await identify();
      expectRefusal(
        e,
        'The image could not be downloaded from that address. Attach the photo again.',
      );
      expect((e as Error).message).not.toContain(String(status));
      expect((e as Error).message).not.toContain('Status Text');
      // The status is kept for the report.
      expect(((e as Error).cause as Error).message).toBe(`image HEAD answered ${status}`);
      expect(safeFetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('the address guard refuses the address: the address sentence, without the guard’s reason', async () => {
    const refused = new SsrfBlockedError('files.example.com resolves to private IPv4 10.0.0.1');
    safeFetchMock.mockRejectedValueOnce(refused);
    const e = await identify();
    expectRefusal(e, 'That image address is not allowed. Attach the photo in the chat instead.');
    expect((e as Error).message).not.toContain('10.0.0.1');
    expect((e as Error).cause).toBe(refused);
  });

  it('the host’s lookup fails: unavailable right now, not a refused address', async () => {
    const lookup = new SsrfLookupFailedError('DNS resolution failed for project.supabase.test: EAI_AGAIN');
    safeFetchMock.mockRejectedValueOnce(lookup);
    const failure = expectUnavailable(await identify(), 'identifyFromPhoto', 'unavailable');
    expect(failure.message).not.toContain('DNS');
    expect(failure.cause).toBe(lookup);
  });

  it.each([429, 503])('the download answers %i: unavailable right now', async (status) => {
    safeFetchMock
      .mockResolvedValueOnce(answer(405)) // HEAD not supported: the GET decides
      .mockResolvedValueOnce(answer(status));
    const failure = expectUnavailable(await identify(), 'identifyFromPhoto', 'unavailable');
    expect((failure.cause as Error).message).toBe(`image GET answered ${status}`);
  });

  it('the download answers 403: the download sentence', async () => {
    safeFetchMock.mockResolvedValueOnce(answer(405)).mockResolvedValueOnce(answer(403));
    expectRefusal(
      await identify(),
      'The image could not be downloaded from that address. Attach the photo again.',
    );
  });

  it('the network fails on both tries: unavailable right now, without the failure’s text', async () => {
    safeFetchMock.mockRejectedValue(new Error('connect ECONNRESET 203.0.113.7:443'));
    const failure = expectUnavailable(await identify(), 'identifyFromPhoto', 'unavailable');
    expect(failure.message).not.toContain('ECONNRESET');
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['HEAD', 'GET'])('the address returns a web page (%s): not an image, without the content type', async (seen) => {
    if (seen === 'GET') safeFetchMock.mockResolvedValueOnce(answer(405));
    safeFetchMock.mockResolvedValueOnce(answer(200, { 'content-type': 'text/html; charset=utf-8' }));
    const e = await identify();
    expectRefusal(e, 'That address did not return an image.');
    expect((e as Error).message).not.toContain('text/html');
  });

  it.each(['HEAD', 'GET'])('the image is over the limit (%s): too large, without the byte count', async (seen) => {
    if (seen === 'GET') safeFetchMock.mockResolvedValueOnce(answer(405));
    safeFetchMock.mockResolvedValueOnce(
      answer(200, { 'content-type': 'image/jpeg', 'content-length': '7000000' }),
    );
    const e = await identify();
    expectRefusal(e, 'That image is too large to read. The limit is 6 MB.');
    expect((e as Error).message).not.toContain('7000000');
  });

  it.each([
    [
      'refuses the key (401)',
      'not_set_up',
      () => new GoogleGenerativeAIFetchError('key text from the service', 401, 'Unauthorized'),
    ],
    [
      'is over its rate (429)',
      'unavailable',
      () => new GoogleGenerativeAIFetchError('quota text from the service', 429, 'Too Many Requests'),
    ],
    [
      'refuses the request (400)',
      'failed',
      () => new GoogleGenerativeAIFetchError('request text from the service', 400, 'Bad Request'),
    ],
  ] as const)('the AI service %s: kind %s', async (_case, kind, thrown) => {
    imageDownloads();
    const cause = thrown();
    generateContentMock.mockRejectedValueOnce(cause);
    const failure = expectUnavailable(await identify(), 'identifyFromPhoto', kind);
    expect(failure.message).not.toContain('service');
    expect(failure.cause).toBe(cause);
  });

  it('an answer that is not JSON: could not be read', async () => {
    imageDownloads();
    generateContentMock.mockResolvedValueOnce({ response: { text: () => 'not json at all' } });
    expectUnavailable(await identify(), 'identifyFromPhoto', 'failed');
  });

  it('still answers a readable photo', async () => {
    imageDownloads();
    generateContentMock.mockResolvedValueOnce({
      response: { text: () => '```json\n{"title":"Field Guide","confidence":"high"}\n```' },
    });
    const out = (await TOOL_CATALOG.identifyFromPhoto!.execute({ imageUrl: URL }, ctxFor())) as {
      title: string;
      confidence: string;
    };
    expect(out.title).toContain('Field Guide');
    expect(out.confidence).toContain('high');
  });
});

describe('S30: a tool’s own refusal reaches the model in the tool’s words', () => {
  function adminCtx() {
    return makeServiceContext(makeSupabaseStub({}).client, {
      organizationId: ORG,
      role: 'admin',
    }) as unknown as ServiceContext;
  }

  /** The sentence the chat loop would hand the model for this call. */
  async function sentenceFor(name: string, args: Record<string, unknown>) {
    const failure = await failureOf(executeToolCall(TOOL_CATALOG[name]!, name, args, adminCtx()));
    expect(failure).toBeInstanceOf(ToolRefusal);
    return classifyToolErrorMessage(failure);
  }

  it('a reorder point on a kit’s pre-assembled stock gives the kit sentence, and nothing is written', async () => {
    getMock.mockResolvedValue({ id: 'i-1', name: 'Starter kit', is_bundle: true });
    expect(await sentenceFor('applyReorderPoint', { itemId: 'i-1', reorderPoint: 5 })).toBe(
      "That item is a kit's pre-assembled stock, which is built from its components and never ordered, so it has no reorder point. Set reorder points on the kit's components instead.",
    );
    expect(updateMock).not.toHaveBeenCalled();
    expect(auditMock.mock.calls[0]![0].extra).toMatchObject({ tool: 'applyReorderPoint', ok: false });
  });

  it('a reorder point the database did not keep says it was not saved', async () => {
    getMock.mockResolvedValue({ id: 'i-1', name: 'Widget', is_bundle: false, reorder_point: 2 });
    updateMock.mockResolvedValue({ name: 'Widget', reorder_point: 2 });
    expect(await sentenceFor('applyReorderPoint', { itemId: 'i-1', reorderPoint: 5 })).toBe(
      'The reorder point was not saved. The item is unchanged.',
    );
  });

  it.each([
    ['adjustStock', { delta: 1, reason: 'r' }, 'itemId is required'],
    ['adjustStock', { itemId: 'i-1', delta: 0, reason: 'r' }, 'delta must be a non-zero number'],
    ['adjustStock', { itemId: 'i-1', delta: 1 }, 'reason is required'],
    ['applyReorderPoint', { itemId: 'i-1', reorderPoint: -1 }, 'reorderPoint must be a number ≥ 0'],
    ['denyOrder', { orderId: 'o-1' }, 'reason is required and must be non-empty'],
    ['executeBulkBookImport', { isbns: [] }, 'isbns must be a non-empty array'],
    ['lookupIsbn', {}, 'isbn is required'],
    ['predictRunout', {}, 'itemId is required'],
    ['previewBundleDistribution', { bundleId: 'b-1' }, 'bundleId and warehouseId are required'],
    ['identifyFromPhoto', { imageUrl: 'file:///tmp/x' }, 'imageUrl must be an http or https URL'],
  ] as const)('%s with %j says "%s"', async (name, args, sentence) => {
    expect(await sentenceFor(name, args)).toBe(sentence);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MED-19 — adjustStock wrote a model-chosen movementType with no allowlist.
// ═══════════════════════════════════════════════════════════════════════════

describe('MED-19: adjustStock movementType allowlist', () => {
  function ctxFor() {
    const stub = makeSupabaseStub({});
    return makeServiceContext(stub.client, {
      organizationId: ORG,
      role: 'admin',
    }) as unknown as ServiceContext;
  }

  beforeEach(() => {
    adjustStockMock.mockResolvedValue(undefined);
    getMock.mockResolvedValue({ id: 'i-1', quantity_on_hand: 5 });
  });

  it.each(['adjust', 'damage', 'loss', 'correction'])(
    'accepts the allowlisted movementType %s',
    async (movementType) => {
      await TOOL_CATALOG.adjustStock!.execute(
        { itemId: 'i-1', delta: -1, reason: 'r', movementType },
        ctxFor(),
      );
      expect(adjustStockMock).toHaveBeenCalledWith(
        expect.objectContaining({ movementType }),
      );
    },
  );

  it('defaults to adjust when movementType is omitted', async () => {
    await TOOL_CATALOG.adjustStock!.execute(
      { itemId: 'i-1', delta: 1, reason: 'r' },
      ctxFor(),
    );
    expect(adjustStockMock).toHaveBeenCalledWith(
      expect.objectContaining({ movementType: 'adjust' }),
    );
  });

  it.each([
    // The two values the OLD declaration advertised — neither exists in
    // movementTypeSchema, so `as never` was writing a bogus movement_type.
    'shrinkage',
    'count',
    // Types owned by other flows: letting the model stamp these forges a
    // provenance the activity feed and every type-filtered report trust.
    'receive_po',
    'transfer',
    'return',
    'initial',
    // Outright junk.
    'DROP TABLE',
  ])('rejects the non-allowlisted movementType %s and does not write', async (movementType) => {
    await expect(
      TOOL_CATALOG.adjustStock!.execute(
        { itemId: 'i-1', delta: -1, reason: 'r', movementType },
        ctxFor(),
      ),
    ).rejects.toThrow(/movementType must be one of adjust, damage, loss, correction/);
    expect(adjustStockMock).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MED-18 — identifyFromPhoto did model-chosen egress with no ctx, no host
// allowlist and no rate limit.
// ═══════════════════════════════════════════════════════════════════════════

describe('MED-18: identifyFromPhoto egress controls', () => {
  function ctxFor() {
    const stub = makeSupabaseStub({});
    return makeServiceContext(stub.client, {
      organizationId: ORG,
      userId: 'user-1',
    }) as unknown as ServiceContext;
  }

  it('passes a non-empty hostAllowlist to safeFetch', async () => {
    // Fail the fetch immediately — we only care about the options safeFetch
    // was called with, and this keeps the test off the model path entirely.
    safeFetchMock.mockRejectedValue(new Error('network down'));

    await expect(
      TOOL_CATALOG.identifyFromPhoto!.execute(
        { imageUrl: 'https://evil.example.com/cover.jpg' },
        ctxFor(),
      ),
    ).rejects.toThrow();

    expect(safeFetchMock).toHaveBeenCalled();
    for (const call of safeFetchMock.mock.calls) {
      const opts = call[1] as { hostAllowlist?: ReadonlyArray<string> };
      // Literal, not just "is an array": the allowlist is exactly our own
      // Supabase project host and app host, derived from env.
      expect(opts.hostAllowlist).toEqual([
        'project.supabase.test',
        'app.stockpilot.test',
      ]);
      // The attacker-supplied host must not be in the allowlist.
      expect(opts.hostAllowlist).not.toContain('evil.example.com');
    }
  });

  it('rate-limits per user and refuses when over budget', async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, resetAt: Date.now() + 1000 });

    await expect(
      TOOL_CATALOG.identifyFromPhoto!.execute(
        { imageUrl: 'https://storage.test/cover.jpg' },
        ctxFor(),
      ),
    ).rejects.toThrow(/Rate limit reached for photo identification/);

    // Keyed on the USER, fail-closed, and it short-circuits BEFORE any egress.
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      'ai-identify-photo:user-1',
      20,
      60_000,
      'closed',
    );
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('still rejects a non-http scheme before touching the network', async () => {
    await expect(
      TOOL_CATALOG.identifyFromPhoto!.execute(
        { imageUrl: 'file:///etc/passwd' },
        ctxFor(),
      ),
    ).rejects.toThrow(/must be an http or https URL/);
    expect(safeFetchMock).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// HI-5 (c) — the authorization boundary must not regress.
// ═══════════════════════════════════════════════════════════════════════════

describe('HI-5: write tools keep their authorization boundary', () => {
  it('flags every tool whose declaration says WRITE with write: true', () => {
    // The chat loops derive the write guard (taint refusal + audit) from this
    // flag, so a write tool that forgets it silently opts out of both.
    const missing = Object.entries(TOOL_CATALOG)
      .filter(([, tool]) => /\bWRITE\b/.test(tool.declaration.description ?? ''))
      .filter(([, tool]) => tool.write !== true)
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('has the expected write-tool inventory', () => {
    // Pinned literally so ADDING a mutating tool forces a deliberate update
    // here, and REMOVING a flag by accident fails.
    const writeTools = Object.entries(TOOL_CATALOG)
      .filter(([, tool]) => tool.write === true)
      .map(([name]) => name)
      .sort();
    expect(writeTools).toEqual([
      'adjustStock',
      'applyReorderPoint',
      'approveOrder',
      'backfillEmbeddings',
      'cancelOrder',
      'createScheduleEvent',
      'denyOrder',
      'draftPos',
      'draftPosFromForecast',
      'executeBulkBookImport',
    ]);
  });

  it('refuses every write tool for a viewer (assertPermission still gates)', async () => {
    const stub = makeSupabaseStub({});
    const viewerCtx = makeServiceContext(stub.client, {
      organizationId: ORG,
      role: 'viewer',
      permissions: new Set<string>(),
    }) as unknown as ServiceContext;

    const throwing = [
      'adjustStock',
      'applyReorderPoint',
      'approveOrder',
      'backfillEmbeddings',
      'cancelOrder',
      'createScheduleEvent',
      'denyOrder',
      'draftPos',
      'draftPosFromForecast',
      'executeBulkBookImport',
    ];
    for (const name of throwing) {
      const tool = TOOL_CATALOG[name]!;
      await expect(
        tool.execute(
          {
            itemId: 'i-1',
            delta: 1,
            reason: 'r',
            orderId: 'o-1',
            reorderPoint: 1,
            isbns: ['9780306406157'],
            warehouseId: 'w-1',
            title: 'x',
            startsAt: '2099-01-01T00:00:00-07:00',
          },
          viewerCtx,
        ),
        `${name} must refuse a viewer`,
      ).rejects.toThrow(/permission|forbidden/i);
    }
    // The viewer's backfill stopped at the gate.
    expect(embedItemsBatchMock).not.toHaveBeenCalled();
  });

  it("backfillEmbeddings answers an admin with counts only, never the batch's first error text", async () => {
    // The batch's first failure's message is for the hourly sweep's summary
    // line; it can carry the database's own words, which the model would
    // then repeat to the user.
    embedItemsBatchMock.mockResolvedValueOnce({
      embedded: 2,
      failed: 1,
      changed: 0,
      remaining: 4,
      firstError: 'write failed: permission denied for table inventory_items',
      stopped: null,
      geminiFailuresInARow: 0,
    });
    const adminCtx = makeServiceContext(makeSupabaseStub({}).client, {
      organizationId: ORG,
      role: 'admin',
    }) as unknown as ServiceContext;

    const out = await TOOL_CATALOG.backfillEmbeddings!.execute({ limit: 3 }, adminCtx);

    // stopWhenGeminiFails: without it the batch can never say it stopped.
    expect(embedItemsBatchMock).toHaveBeenCalledWith(adminCtx, {
      limit: 3,
      stopWhenGeminiFails: true,
    });
    expect(out).toEqual({ embedded: 2, failed: 1, changed: 0, remaining: 4 });
  });
});
