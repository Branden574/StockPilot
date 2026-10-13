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
 * every caller already treats as one more failed embed.
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
  embedInventoryItem,
  embedItemsBatch,
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

/** An item row and a ctx whose UPDATE answers `writeError`. */
function itemCtx(writeError: { message: string } | null = null) {
  const updates: Array<{ patch: Record<string, unknown>; eqs: Array<[string, string]> }> = [];
  const ctx = {
    organizationId: 'org-1',
    supabase: {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: 'itm-1', name: 'Widget', sku: 'W-1', barcode: null },
                error: null,
              }),
            }),
          }),
        }),
        update: (patch: Record<string, unknown>) => {
          const entry = { patch, eqs: [] as Array<[string, string]> };
          updates.push(entry);
          return {
            eq: (c1: string, v1: string) => {
              entry.eqs.push([c1, v1]);
              return {
                eq: async (c2: string, v2: string) => {
                  entry.eqs.push([c2, v2]);
                  return { error: writeError };
                },
              };
            },
          };
        },
      }),
    },
  };
  return { ctx, updates };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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

describe('embedInventoryItem', () => {
  it('writes the vector to that item only, scoped to the organization', async () => {
    vi.stubGlobal('fetch', answering());
    const { ctx, updates } = itemCtx();

    await embedInventoryItem('itm-1', ctx as never);

    expect(updates).toHaveLength(1);
    expect(Object.keys(updates[0]!.patch)).toEqual(['embedding']);
    expect(updates[0]!.eqs).toEqual([
      ['organization_id', 'org-1'],
      ['id', 'itm-1'],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a refused UPDATE is logged, never thrown', async () => {
    vi.stubGlobal('fetch', answering());
    const { ctx } = itemCtx({ message: 'permission denied for table inventory_items' });

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
});

/** Three items of one org with no embedding, as PostgREST would serve them. */
function batchTable() {
  const rows = [1, 2, 3].map((n) => ({
    id: `itm-${n}`,
    organization_id: 'org-1',
    name: `Item ${n}`,
    sku: `S-${n}`,
    barcode: null,
    description: null,
    custom_fields: {},
    deleted_at: null as string | null,
    embedding: null as string | null,
    created_at: `2026-10-0${n}T00:00:00Z`,
  }));
  const written: string[] = [];
  const stub = makeSupabaseStub({
    'inventory_items.select': (call: MockCall) => {
      const served = servedLikePostgrest(() => rows)(call);
      const head = (callArgs(call, 'select')?.[1] as { head?: boolean } | undefined)?.head;
      return head ? { data: null, error: null, count: (served.data as unknown[]).length } : served;
    },
    'inventory_items.update': (call: MockCall) => {
      const eqs = call.methods
        .map((m, i) => [m, call.args[i]] as const)
        .filter(([m]) => m === 'eq')
        .map(([, a]) => a as [string, string]);
      const org = eqs.find(([c]) => c === 'organization_id')?.[1];
      const id = eqs.find(([c]) => c === 'id')?.[1];
      const row = rows.find((r) => r.id === id && r.organization_id === org);
      if (row) {
        row.embedding = String((call.args[0]?.[0] as { embedding: string }).embedding);
        written.push(row.id);
      }
      return { data: null, error: null };
    },
  });
  return { client: stub.client, written };
}

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
    expect(result).toEqual({ embedded: 1, failed: 0, remaining: 2 });
  });

  it('without a deadline, embeds every item up to the limit, as before', async () => {
    vi.stubGlobal('fetch', answering());
    const { client, written } = batchTable();

    const result = await embedItemsBatch(
      { supabase: client, organizationId: 'org-1' },
      { limit: 3 },
    );

    expect(written).toEqual(['itm-1', 'itm-2', 'itm-3']);
    expect(result).toEqual({ embedded: 3, failed: 0, remaining: 0 });
  });
});
