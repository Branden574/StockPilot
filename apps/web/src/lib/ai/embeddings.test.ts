// @vitest-environment node
import { GoogleGenerativeAIAbortError } from '@google/generative-ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Gemini call behind every item embedding, through the REAL SDK
 * (@google/generative-ai) with `fetch` stubbed, so these tests prove what the
 * SDK actually does with the options embedText gives it.
 *
 * WHY A TIMEOUT: the SDK sets no deadline of its own, so a call that never
 * answers held its invocation open for as long as the platform allowed: the
 * whole keepAlive window after a create, or a cron run's whole budget.
 * embedText now passes `timeout` in the SDK's request options; the SDK aborts
 * the fetch when it passes and throws GoogleGenerativeAIAbortError, which
 * every caller already treats as one more failed embed. embedQuery (the AI
 * assistant's search) passes the same timeout, so a stalled search call
 * cannot hold the chat request open either.
 *
 * WHY THE WRITE ERROR: embedInventoryItem ignored the { error } of its own
 * UPDATE, so a refused write was silent while embedItemsBatch's was logged.
 */

vi.mock('@/lib/env', () => ({ env: { GEMINI_API_KEY: 'test-key' } }));

import {
  callArgs,
  makeSupabaseStub,
  type MockCall,
  servedLikePostgrest,
} from '@/test/supabase-mock';

import {
  EMBED_TIMEOUT_MS,
  EMBEDDING_DIM,
  GEMINI_FAILURES_IN_A_ROW,
  embedInventoryItem,
  embedItemsBatch,
  embedQuery,
  embedText,
} from './embeddings';

const VECTOR = Array.from({ length: EMBEDDING_DIM }, (_, i) => i / EMBEDDING_DIM);

/** A fetch that answers like the embedContent endpoint. */
function answering() {
  return vi.fn(
    async (_url: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ embedding: { values: VECTOR } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

/** A fetch that never answers, and rejects the way fetch does when its signal aborts. */
function neverAnswering() {
  return vi.fn(
    (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('This operation was aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }),
  );
}

type ItemRow = {
  id: string;
  organization_id: string;
  name: string;
  sku: string;
  barcode: string | null;
  description: string | null;
  custom_fields: Record<string, unknown>;
  embedding: string | null;
  updated_at: string;
};

/** When the item was last changed, and a later change (0242 moves it). */
const T0 = '2026-10-13T10:00:00.000001+00:00';
const T1 = '2026-10-13T10:00:00.400002+00:00';

/** The UPDATE's own filters, as [method, column, value] (.update and .select
 *  are not filters). */
function filtersOf(call: MockCall): unknown[][] {
  return call.methods.flatMap((m, i) =>
    m === 'update' || m === 'select' ? [] : [[m, ...(call.args[i] ?? [])]],
  );
}

/**
 * One item, served the way PostgREST serves it: a read applies its own
 * filters and hands back a copy, and an UPDATE writes the row only when ALL
 * of its own filters match it, answering it to .select('id'). `afterRead`
 * runs after the nth read (1 = the read the text is built from, 2 = the
 * read just before the write). `writeError` refuses every UPDATE.
 */
function itemCtx(
  opts: {
    writeError?: { message: string };
    afterRead?: (n: number, row: ItemRow) => void;
  } = {},
) {
  const row: ItemRow = {
    id: 'itm-1',
    organization_id: 'org-1',
    name: 'Widget',
    sku: 'W-1',
    barcode: null,
    description: null,
    custom_fields: {},
    embedding: null,
    updated_at: T0,
  };
  const updates: Array<{ patch: Record<string, unknown>; filters: unknown[][]; written: number }> =
    [];
  let reads = 0;
  const stub = makeSupabaseStub({
    'inventory_items.select': (call: MockCall) => {
      reads += 1;
      const served = servedLikePostgrest(() => [row])(call);
      const copies = (served.data as ItemRow[]).map((r) => ({ ...r }));
      opts.afterRead?.(reads, row);
      return { data: copies, error: null };
    },
    'inventory_items.update': (call: MockCall) => {
      const patch = call.args[0]?.[0] as Record<string, unknown>;
      const filters = filtersOf(call);
      if (opts.writeError) {
        updates.push({ patch, filters, written: 0 });
        return { data: null, error: opts.writeError };
      }
      const keep = call.methods.map((m) => m !== 'update' && m !== 'select');
      const matched = servedLikePostgrest(() => [row])({
        ...call,
        methods: call.methods.filter((_, i) => keep[i]),
        args: call.args.filter((_, i) => keep[i]),
      }).data as ItemRow[];
      for (const r of matched) r.embedding = String(patch.embedding);
      updates.push({ patch, filters, written: matched.length });
      return {
        data: call.methods.includes('select') ? matched.map((r) => ({ id: r.id })) : null,
        error: null,
      };
    },
  });
  return { ctx: { organizationId: 'org-1', supabase: stub.client }, updates, row };
}

/** A fetch that answers like the embedContent endpoint, running `during`
 *  while the call is in flight. */
function answeringWhile(during: () => void) {
  const fetch = answering();
  fetch.mockImplementation(async () => {
    during();
    return new Response(JSON.stringify({ embedding: { values: VECTOR } }), { status: 200 });
  });
  return fetch;
}

let warn: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('embedText bounds the Gemini call', () => {
  it('answers with the vector when Gemini answers', async () => {
    const fetch = answering();
    vi.stubGlobal('fetch', fetch);

    await expect(embedText('Widget')).resolves.toHaveLength(EMBEDDING_DIM);
    // The request carries an abort signal: the SDK attaches one only when a
    // timeout (or a signal) is set in the request options.
    const init = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('a call that never answers is aborted after 10 s, not left open', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', neverAnswering());

    let outcome: unknown = 'pending';
    void embedText('Widget').then(
      () => {
        outcome = 'resolved';
      },
      (e: unknown) => {
        outcome = e;
      },
    );

    await vi.advanceTimersByTimeAsync(9_999);
    expect(outcome).toBe('pending');

    await vi.advanceTimersByTimeAsync(1);
    // The SDK's own abort error (its classes do not set `name`).
    expect(outcome).toBeInstanceOf(GoogleGenerativeAIAbortError);
  });

  it('the bound is EMBED_TIMEOUT_MS, 10 s', () => {
    expect(EMBED_TIMEOUT_MS).toBe(10_000);
  });
});

describe('embedQuery, the AI assistant search embedding, is bounded the same way', () => {
  it('answers with the vector, through a request that carries the abort signal', async () => {
    const fetch = answering();
    vi.stubGlobal('fetch', fetch);

    await expect(embedQuery('something for cleaning up spills')).resolves.toHaveLength(
      EMBEDDING_DIM,
    );
    const init = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    // The query side of the retrieval, as before.
    expect(JSON.parse(String(init?.body)).taskType).toBe('RETRIEVAL_QUERY');
  });

  it('a search whose call never answers is aborted after 10 s, not left open', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', neverAnswering());

    let outcome: unknown = 'pending';
    void embedQuery('something for cleaning up spills').then(
      () => {
        outcome = 'resolved';
      },
      (e: unknown) => {
        outcome = e;
      },
    );

    await vi.advanceTimersByTimeAsync(EMBED_TIMEOUT_MS - 1);
    expect(outcome).toBe('pending');

    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBeInstanceOf(GoogleGenerativeAIAbortError);
  });
});

describe('embedInventoryItem', () => {
  it('writes the vector to that item only, scoped to the organization, while it still has the text the vector was built from', async () => {
    vi.stubGlobal('fetch', answering());
    const { ctx, updates, row } = itemCtx();

    await embedInventoryItem('itm-1', ctx as never);

    expect(updates).toHaveLength(1);
    expect(Object.keys(updates[0]!.patch)).toEqual(['embedding']);
    // Guarded by the updated_at of the read just before the write. No "still
    // missing" guard: an edit's re-embed replaces the old vector.
    expect(updates[0]!.filters).toEqual([
      ['eq', 'organization_id', 'org-1'],
      ['eq', 'id', 'itm-1'],
      ['eq', 'updated_at', T0],
    ]);
    expect(row.embedding).not.toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a refused UPDATE is logged, never thrown', async () => {
    vi.stubGlobal('fetch', answering());
    const { ctx } = itemCtx({
      writeError: { message: 'permission denied for table inventory_items' },
    });

    await expect(embedInventoryItem('itm-1', ctx as never)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe('[embeddings] item embed write failed:');
    expect(warn.mock.calls[0]).toContain('permission denied for table inventory_items');
  });

  it('a Gemini call that times out is one more swallowed, logged failure, and writes nothing', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', neverAnswering());
    const { ctx, updates } = itemCtx();

    let settled = false;
    void embedInventoryItem('itm-1', ctx as never).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(settled).toBe(true);
    expect(updates).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe('[embeddings] item embed failed:');
  });

  it("replaces the vector an item already has: an edit's re-embed is not only for missing ones", async () => {
    vi.stubGlobal('fetch', answering());
    const { ctx, updates, row } = itemCtx();
    row.embedding = '[the vector of the text before the edit]';

    await embedInventoryItem('itm-1', ctx as never);

    expect(updates.map((u) => u.written)).toEqual([1]);
    expect(row.embedding.startsWith('[0,')).toBe(true);
  });

  it('an edit while Gemini embeds the item: nothing built from the old text is written over the new one', async () => {
    // Two quick edits: the first one's embed is still in flight when the
    // second saves. The second edit's own embed writes the new text.
    const { ctx, updates, row } = itemCtx();
    vi.stubGlobal(
      'fetch',
      answeringWhile(() => Object.assign(row, { name: 'Widget Pro', updated_at: T1 })),
    );

    await embedInventoryItem('itm-1', ctx as never);

    expect(updates).toEqual([]);
    expect(row.embedding).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(info.mock.calls).toEqual([
      ['[embeddings] item changed while it was embedded; nothing written:', 'itm-1'],
    ]);
  });

  it('a stock movement while Gemini embeds the item does not stop the write: the text is the same', async () => {
    // A create writes the opening movement right after starting the embed,
    // and a movement moves updated_at (any real change does).
    const { ctx, updates, row } = itemCtx();
    vi.stubGlobal(
      'fetch',
      answeringWhile(() => {
        row.updated_at = T1;
      }),
    );

    await embedInventoryItem('itm-1', ctx as never);

    expect(updates.map((u) => u.written)).toEqual([1]);
    expect(updates[0]!.filters).toContainEqual(['eq', 'updated_at', T1]);
    expect(row.embedding).not.toBeNull();
  });

  it('an edit that lands between the read just before the write and the write is not written over either', async () => {
    vi.stubGlobal('fetch', answering());
    const { ctx, updates, row } = itemCtx({
      afterRead: (n, r) => {
        if (n === 2) Object.assign(r, { name: 'Widget Pro', updated_at: T1 });
      },
    });

    await embedInventoryItem('itm-1', ctx as never);

    // Tried, and matched no row: its updated_at no longer held.
    expect(updates.map((u) => u.written)).toEqual([0]);
    expect(row.embedding).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
  });
});

/** `count` items of one org with no embedding (three by default), oldest
 *  first, as PostgREST would serve them; an UPDATE writes only the rows all of
 *  its own filters match. Item n's text is "Item n · SKU S-n". */
function batchTable(count = 3) {
  const rows = Array.from({ length: count }, (_, i) => i + 1).map((n) => ({
    id: `itm-${n}`,
    organization_id: 'org-1',
    name: `Item ${n}`,
    sku: `S-${n}`,
    barcode: null,
    description: null,
    custom_fields: {},
    deleted_at: null as string | null,
    embedding: null as string | null,
    created_at: `2026-10-${String(n).padStart(2, '0')}T00:00:00Z`,
    updated_at: `2026-10-${String(n).padStart(2, '0')}T00:00:00.000001+00:00`,
  }));
  const written: string[] = [];
  const stub = makeSupabaseStub({
    'inventory_items.select': (call: MockCall) => {
      const served = servedLikePostgrest(() => rows)(call);
      const head = (callArgs(call, 'select')?.[1] as { head?: boolean } | undefined)?.head;
      return head ? { data: null, error: null, count: (served.data as unknown[]).length } : served;
    },
    'inventory_items.update': (call: MockCall) => {
      const keep = call.methods.map((m) => m !== 'update' && m !== 'select');
      const matched = servedLikePostgrest(() => rows)({
        ...call,
        methods: call.methods.filter((_, i) => keep[i]),
        args: call.args.filter((_, i) => keep[i]),
      }).data as typeof rows;
      for (const row of matched) {
        row.embedding = String((call.args[0]?.[0] as { embedding: string }).embedding);
        written.push(row.id);
      }
      return {
        data: call.methods.includes('select') ? matched.map((r) => ({ id: r.id })) : null,
        error: null,
      };
    },
  });
  return { client: stub.client, written };
}

/**
 * A Gemini fetch that answers a vector, or, for a text containing one of the
 * `failures` keys, that HTTP status with that error message (and that
 * error.details, which the SDK hands on as errorDetails).
 */
function failingFor(
  failures: Record<string, { status: number; message: string; details?: unknown[] }>,
) {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    const text = (JSON.parse(String(init?.body)) as { content: { parts: Array<{ text: string }> } })
      .content.parts[0]!.text;
    const hit = Object.entries(failures).find(([needle]) => text.includes(needle));
    if (hit) {
      const { status, message, details } = hit[1];
      return new Response(JSON.stringify({ error: { message, ...(details ? { details } : {}) } }), {
        status,
      });
    }
    return new Response(JSON.stringify({ embedding: { values: VECTOR } }), { status: 200 });
  });
}

describe('embedItemsBatch: what a failed item leaves in the logs', () => {
  it('by default (the Settings > AI backfill) each failed item keeps its own line, with its id', async () => {
    vi.stubGlobal('fetch', failingFor({ 'Item 2': { status: 500, message: 'backend error' } }));
    const { client } = batchTable();

    const result = await embedItemsBatch(
      { supabase: client, organizationId: 'org-1' },
      { limit: 3 },
    );

    expect(result).toMatchObject({ embedded: 2, failed: 1, remaining: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.slice(0, 2)).toEqual(['[embedItemsBatch] embed failed:', 'itm-2']);
  });

  it("logEachFailure false (the hourly sweep): no line names a failed item, and the first failure's message is returned", async () => {
    vi.stubGlobal(
      'fetch',
      failingFor({
        'Item 2': { status: 500, message: 'backend error' },
        'Item 3': { status: 503, message: 'model overloaded' },
      }),
    );
    const { client } = batchTable();

    const result = await embedItemsBatch(
      { supabase: client, organizationId: 'org-1' },
      { limit: 3, logEachFailure: false },
    );

    expect(result).toMatchObject({ embedded: 1, failed: 2, remaining: 2 });
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(result.firstError).toContain('backend error');
    expect(result.firstError).not.toContain('itm-2');
    expect(result.firstError).not.toContain('Item 2');
  });
});

describe('embedItemsBatch with stopWhenGeminiFails (the hourly sweep)', () => {
  const quota = { status: 429, message: 'Resource has been exhausted (e.g. check quota).' };
  const down = { status: 503, message: 'The model is overloaded. Please try again later.' };
  const batch = (
    client: unknown,
    over: { limit: number; geminiFailuresInARow?: number; stopWhenGeminiFails?: boolean },
  ) =>
    embedItemsBatch(
      { supabase: client, organizationId: 'org-1' },
      { logEachFailure: false, stopWhenGeminiFails: true, ...over },
    );

  it("stops at Gemini's first 429: the key's limit is reached, so no further call is made", async () => {
    const fetch = failingFor({ Item: quota });
    vi.stubGlobal('fetch', fetch);
    const { client, written } = batchTable(5);

    const result = await batch(client, { limit: 5 });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(written).toEqual([]);
    expect(result).toMatchObject({
      embedded: 0,
      failed: 1,
      remaining: 5,
      stopped: 'gemini_rate_limited',
      geminiFailuresInARow: 1,
      firstError: expect.stringContaining('429'),
    });
  });

  it("stops at Gemini's first 400 that refuses the key itself (API_KEY_INVALID): every call would get it", async () => {
    // A revoked, expired or mistyped GEMINI_API_KEY. Gemini answers it with a
    // 400 INVALID_ARGUMENT, as it answers a bad item, but names the reason in
    // an ErrorInfo.
    const keyRefused = {
      status: 400,
      message: 'API key not valid. Please pass a valid API key.',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'API_KEY_INVALID',
          domain: 'googleapis.com',
          metadata: { service: 'generativelanguage.googleapis.com' },
        },
      ],
    };
    const fetch = failingFor({ Item: keyRefused });
    vi.stubGlobal('fetch', fetch);
    const { client, written } = batchTable(5);

    const result = await batch(client, { limit: 5 });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(written).toEqual([]);
    expect(result).toMatchObject({
      embedded: 0,
      failed: 1,
      remaining: 5,
      stopped: 'gemini_key_invalid',
      geminiFailuresInARow: 1,
      firstError: expect.stringContaining('API key not valid'),
    });
  });

  it('stops after three Gemini failures in a row (Gemini down: 5xx, timeouts)', async () => {
    const fetch = failingFor({ Item: down });
    vi.stubGlobal('fetch', fetch);
    const { client } = batchTable(5);

    const result = await batch(client, { limit: 5 });

    expect(GEMINI_FAILURES_IN_A_ROW).toBe(3);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      failed: 3,
      remaining: 5,
      stopped: 'gemini_failing',
      geminiFailuresInARow: 3,
    });
  });

  it("an answer resets the count, and so does a 400 about one item's own text", async () => {
    // Gemini fails, fails, answers, fails, refuses item 5's text, fails: never
    // three in a row, so all six are tried.
    const invalid = { status: 400, message: 'Request contains an invalid argument.' };
    const fetch = failingFor({
      'Item 1 ·': down,
      'Item 2 ·': down,
      'Item 4 ·': down,
      'Item 5 ·': invalid,
      'Item 6 ·': down,
    });
    vi.stubGlobal('fetch', fetch);
    const { client, written } = batchTable(6);

    const result = await batch(client, { limit: 6 });

    expect(fetch).toHaveBeenCalledTimes(6);
    expect(written).toEqual(['itm-3']);
    expect(result).toMatchObject({
      embedded: 1,
      failed: 5,
      stopped: null,
      geminiFailuresInARow: 1,
    });
  });

  it('carries the count in from the batch before it (the sweep, from one organization to the next)', async () => {
    const fetch = failingFor({ Item: down });
    vi.stubGlobal('fetch', fetch);
    const { client } = batchTable(3);

    const result = await batch(client, { limit: 3, geminiFailuresInARow: 2 });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ stopped: 'gemini_failing', geminiFailuresInARow: 3 });
  });

  it('without it (the Settings > AI backfill), every item is still tried, as before', async () => {
    const fetch = failingFor({ Item: quota });
    vi.stubGlobal('fetch', fetch);
    const { client } = batchTable(4);

    // As backfillItemEmbeddingsAction calls it: no option at all.
    const result = await embedItemsBatch(
      { supabase: client, organizationId: 'org-1' },
      { limit: 4 },
    );

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({ failed: 4, stopped: null });
  });
});

describe('embedItemsBatch stops at its deadline', () => {
  it('starts no item once the deadline has passed, and counts the rest as still missing', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    // Each Gemini call takes 10 s on this clock, so the deadline at 5 s passes
    // while the first item is being embedded.
    const fetch = answering();
    fetch.mockImplementation(async () => {
      now += 10_000;
      return new Response(JSON.stringify({ embedding: { values: VECTOR } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    const { client, written } = batchTable();

    const result = await embedItemsBatch(
      { supabase: client, organizationId: 'org-1' },
      { limit: 3, deadline: 5_000 },
    );

    expect(written).toEqual(['itm-1']);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      embedded: 1,
      failed: 0,
      changed: 0,
      remaining: 2,
      firstError: null,
      stopped: null,
      geminiFailuresInARow: 0,
    });
  });

  it('without a deadline, embeds every item up to the limit, as before', async () => {
    vi.stubGlobal('fetch', answering());
    const { client, written } = batchTable();

    const result = await embedItemsBatch(
      { supabase: client, organizationId: 'org-1' },
      { limit: 3 },
    );

    expect(written).toEqual(['itm-1', 'itm-2', 'itm-3']);
    expect(result).toEqual({
      embedded: 3,
      failed: 0,
      changed: 0,
      remaining: 0,
      firstError: null,
      stopped: null,
      geminiFailuresInARow: 0,
    });
  });
});
