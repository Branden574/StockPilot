// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  callArgs,
  makeSupabaseStub,
  type MockCall,
  servedLikePostgrest,
} from '@/test/supabase-mock';

/**
 * Security invariant: the hourly embeddings sweep (cron/embeddings-sweep)
 * reads and writes with the SERVICE ROLE, so RLS does not apply and the
 * organization filters are the only tenant boundary. Every read and write of
 * an item names one organization, every write names the item and that
 * organization, and only the `embedding` column is ever written.
 *
 * What the sweep is for: any item left with `embedding IS NULL`, whatever
 * left it (the books import and bulkCreate do not embed at once, a Gemini
 * failure, a call cut off, a path added later), is embedded within the hour,
 * within a strict budget per run.
 *
 * Driven through the REAL embedItemsBatch and the REAL Gemini SDK, with
 * `fetch` stubbed and the items table served the way PostgREST filters it
 * (servedLikePostgrest): a dropped organization filter shows up here as
 * another organization's rows.
 */

const h = vi.hoisted(() => ({
  env: { GEMINI_API_KEY: 'test-key' } as { GEMINI_API_KEY?: string },
  reportError: vi.fn(),
}));
vi.mock('@/lib/env', () => ({
  get env() {
    return h.env;
  },
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: h.reportError }));

import { EMBEDDING_DIM } from './embeddings';
import { EMBEDDINGS_SWEEP, sweepMissingEmbeddings } from './embeddings-sweep';

const VECTOR = Array.from({ length: EMBEDDING_DIM }, (_, i) => i / EMBEDDING_DIM);

type Row = {
  id: string;
  organization_id: string;
  name: string;
  sku: string;
  barcode: string | null;
  description: string | null;
  custom_fields: Record<string, unknown>;
  deleted_at: string | null;
  embedding: string | null;
  created_at: string;
};

let seq = 0;
function item(org: string, over: Partial<Row> = {}): Row {
  seq += 1;
  return {
    id: `item-${seq}`,
    organization_id: org,
    // Names that must never appear in a log line.
    name: `Private name ${org} ${seq}`,
    sku: `SKU-${seq}`,
    barcode: null,
    description: null,
    custom_fields: {},
    deleted_at: null,
    embedding: null,
    created_at: new Date(Date.UTC(2026, 8, 1) + seq * 60_000).toISOString(),
    ...over,
  };
}

/**
 * The items table behind a service-role stub. Reads are filtered like
 * PostgREST (count: 'exact', head: true answers a count); an UPDATE writes
 * only to the row its organization_id AND id filters both match, as Postgres
 * would, and is recorded either way.
 */
function table(rows: Row[], opts: { failReadFor?: string } = {}) {
  const writes: Array<{ keys: string[]; org: string | undefined; id: string | undefined }> = [];
  const stub = makeSupabaseStub({
    'inventory_items.select': (call: MockCall) => {
      const org = call.args[call.methods.indexOf('eq')]?.[1];
      if (opts.failReadFor && org === opts.failReadFor && call.methods.includes('limit')) {
        return { data: null, error: { message: 'canceling statement due to statement timeout' } };
      }
      const served = servedLikePostgrest(() => rows)(call);
      const head = (callArgs(call, 'select')?.[1] as { head?: boolean } | undefined)?.head;
      return head ? { data: null, error: null, count: (served.data as unknown[]).length } : served;
    },
    'inventory_items.update': (call: MockCall) => {
      const patch = call.args[0]?.[0] as Record<string, unknown>;
      const eqs = call.methods
        .map((m, i) => [m, call.args[i]] as const)
        .filter(([m]) => m === 'eq')
        .map(([, a]) => a as [string, string]);
      const org = eqs.find(([c]) => c === 'organization_id')?.[1];
      const id = eqs.find(([c]) => c === 'id')?.[1];
      writes.push({ keys: Object.keys(patch), org, id });
      const row = rows.find((r) => r.id === id && r.organization_id === org);
      if (row) row.embedding = String(patch.embedding);
      return { data: null, error: null };
    },
  });
  /** The embedItemsBatch reads (the ones that load rows to embed). */
  const batchReads = () =>
    (stub.chainArgsAll.get('inventory_items.select') ?? []).filter(
      (args, i) =>
        (stub.chainsAll.get('inventory_items.select')?.[i] ?? []).includes('limit') &&
        (args[0]?.[0] as string).startsWith('id, name'),
    );
  return { client: stub.client, stub, writes, batchReads };
}

/** A Gemini fetch: answers a vector, or fails for a text containing `failFor`. */
function gemini(opts: { failFor?: string; onCall?: () => void } = {}) {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    opts.onCall?.();
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      content?: { parts?: Array<{ text?: string }> };
    };
    const text = body.content?.parts?.[0]?.text ?? '';
    if (opts.failFor && text.includes(opts.failFor)) {
      return new Response(JSON.stringify({ error: { message: 'backend error' } }), {
        status: 500,
      });
    }
    return new Response(JSON.stringify({ embedding: { values: VECTOR } }), { status: 200 });
  });
}

const missing = (rows: Row[]) => rows.filter((r) => r.embedding === null && !r.deleted_at);

/** 2026-10-13 at hh:37 UTC, the sweep's minute. */
const at = (hh: number) => Date.UTC(2026, 9, 13, hh, 37);

let logged: unknown[][];
beforeEach(() => {
  seq = 0;
  h.env = { GEMINI_API_KEY: 'test-key' };
  h.reportError.mockReset();
  vi.spyOn(Date, 'now').mockReturnValue(at(0));
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the embeddings sweep', () => {
  it('nothing missing: one look, no Gemini call, no write', async () => {
    const rows = [item('org-a', { embedding: '[1]' }), item('org-b', { embedding: '[1]' })];
    const { client, stub, writes } = table(rows);
    const fetch = gemini();
    vi.stubGlobal('fetch', fetch);

    const result = await sweepMissingEmbeddings(client);

    expect(fetch).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(stub.fromCalls).toEqual(['inventory_items']);
    expect(result).toMatchObject({ orgs: 0, embedded: 0, failed: 0, remaining: 0 });
  });

  it("reads and writes each organization's items under that organization only", async () => {
    const rows = [
      item('org-a'),
      item('org-a'),
      item('org-a', { deleted_at: '2026-10-01T00:00:00Z' }),
      item('org-a', { embedding: '[1]' }),
      item('org-b'),
      item('org-b'),
      item('org-c', { embedding: '[1]' }),
    ];
    const { client, writes, batchReads } = table(rows);
    vi.stubGlobal('fetch', gemini());

    const result = await sweepMissingEmbeddings(client);

    expect(result).toMatchObject({
      orgs: 2,
      orgsProcessed: 2,
      embedded: 4,
      failed: 0,
      remaining: 0,
    });
    expect(missing(rows)).toEqual([]);
    // The deleted item is never embedded.
    expect(rows.find((r) => r.deleted_at)?.embedding).toBeNull();
    // Every write names one organization and an item OF that organization,
    // and writes the embedding and nothing else.
    expect(writes).toHaveLength(4);
    for (const w of writes) {
      expect(w.keys).toEqual(['embedding']);
      expect(rows.find((r) => r.id === w.id)?.organization_id).toBe(w.org);
    }
    // Every batch read names the organization it is for; org-c (nothing
    // missing) is never read beyond the scan.
    expect(batchReads().map((args) => args.find((a) => a[0] === 'organization_id')?.[1])).toEqual([
      'org-a',
      'org-b',
    ]);
  });

  it('embeds at most perOrgCap items of one organization in a run, oldest first', async () => {
    const rows = [...[1, 2, 3, 4, 5].map(() => item('org-a')), item('org-b')];
    const { client } = table(rows);
    vi.stubGlobal('fetch', gemini());

    const result = await sweepMissingEmbeddings(client, {
      ...EMBEDDINGS_SWEEP,
      perOrgCap: 3,
      runCap: 10,
    });

    expect(result).toMatchObject({ embedded: 4, remaining: 2 });
    // The two newest of org-a's five wait for the next run.
    expect(missing(rows)).toEqual([rows[3], rows[4]]);
  });

  it('embeds at most runCap items across all organizations in a run', async () => {
    const rows = [...[1, 2, 3].map(() => item('org-a')), ...[1, 2, 3].map(() => item('org-b'))];
    const { client } = table(rows);
    const fetch = gemini();
    vi.stubGlobal('fetch', fetch);

    const result = await sweepMissingEmbeddings(client, {
      ...EMBEDDINGS_SWEEP,
      perOrgCap: 3,
      runCap: 4,
    });

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({ embedded: 4, orgsProcessed: 2, orgsLeft: 0 });
    expect(missing(rows).map((r) => r.organization_id)).toEqual(['org-b', 'org-b']);
  });

  it('failed attempts count against the run cap: a failing Gemini is called at most runCap times', async () => {
    const rows = [
      ...[1, 2, 3].map(() => item('org-a', { name: 'Gemini refuses this one' })),
      ...[1, 2, 3].map(() => item('org-b')),
    ];
    const { client } = table(rows);
    const fetch = gemini({ failFor: 'Gemini refuses this one' });
    vi.stubGlobal('fetch', fetch);

    const result = await sweepMissingEmbeddings(client, {
      ...EMBEDDINGS_SWEEP,
      perOrgCap: 3,
      runCap: 3,
    });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ embedded: 0, failed: 3, orgsProcessed: 1, orgsLeft: 1 });
  });

  it('a different organization goes first each hour, so a capped run is fair over time', async () => {
    vi.mocked(Date.now).mockReturnValue(at(1));
    const rows = [...[1, 2, 3].map(() => item('org-a')), ...[1, 2, 3].map(() => item('org-b'))];
    const { client } = table(rows);
    vi.stubGlobal('fetch', gemini());

    await sweepMissingEmbeddings(client, { ...EMBEDDINGS_SWEEP, perOrgCap: 3, runCap: 4 });

    // At 01:37 the run starts with the second organization.
    expect(missing(rows).map((r) => r.organization_id)).toEqual(['org-a', 'org-a']);
  });

  it('an item Gemini fails is left for the next run, which embeds it', async () => {
    const rows = [item('org-a'), item('org-a', { name: 'Gemini refuses this one' }), item('org-a')];
    const { client } = table(rows);
    vi.stubGlobal('fetch', gemini({ failFor: 'Gemini refuses this one' }));

    const first = await sweepMissingEmbeddings(client);

    expect(first).toMatchObject({ embedded: 2, failed: 1, remaining: 1 });
    expect(missing(rows).map((r) => r.name)).toEqual(['Gemini refuses this one']);

    const fetch = gemini();
    vi.stubGlobal('fetch', fetch);
    const second = await sweepMissingEmbeddings(client);

    expect(second).toMatchObject({ embedded: 1, failed: 0, remaining: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(missing(rows)).toEqual([]);
  });

  it('starts nothing once the deadline has passed; the rest waits for the next run', async () => {
    let now = at(0);
    vi.mocked(Date.now).mockImplementation(() => now);
    // Each Gemini call takes 60 s on this clock: items start at 0, 60 and
    // 120 s; at 180 s the 150 s deadline has passed.
    const rows = [...[1, 2, 3, 4, 5].map(() => item('org-a')), item('org-b')];
    const { client } = table(rows);
    const fetch = gemini({ onCall: () => (now += 60_000) });
    vi.stubGlobal('fetch', fetch);

    const result = await sweepMissingEmbeddings(client, {
      ...EMBEDDINGS_SWEEP,
      deadlineMs: 150_000,
    });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ embedded: 3, timeUp: true, orgsProcessed: 1, orgsLeft: 1 });
    expect(missing(rows)).toHaveLength(3);
  });

  it('without a Gemini key it reads and writes nothing', async () => {
    h.env = { GEMINI_API_KEY: '' };
    const rows = [item('org-a')];
    const { client, stub } = table(rows);
    const fetch = gemini();
    vi.stubGlobal('fetch', fetch);

    const result = await sweepMissingEmbeddings(client);

    expect(result.skipped).toBe('no_gemini_key');
    expect(stub.fromCalls).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('an organization whose read fails is reported, and the others are still embedded', async () => {
    const rows = [item('org-a'), item('org-b'), item('org-c')];
    const { client } = table(rows, { failReadFor: 'org-b' });
    vi.stubGlobal('fetch', gemini());

    const result = await sweepMissingEmbeddings(client);

    expect(result).toMatchObject({ orgs: 3, orgsProcessed: 2, orgsFailed: 1, embedded: 2 });
    expect(missing(rows).map((r) => r.organization_id)).toEqual(['org-b']);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError.mock.calls[0]?.[1]).toMatchObject({
      tag: 'cron.embeddings-sweep.org',
      organizationId: 'org-b',
    });
  });

  it('looks at no more than maxOrgs organizations in a run', async () => {
    const rows = [item('org-a'), item('org-b'), item('org-c')];
    const { client } = table(rows);
    vi.stubGlobal('fetch', gemini());

    const result = await sweepMissingEmbeddings(client, { ...EMBEDDINGS_SWEEP, maxOrgs: 2 });

    expect(result).toMatchObject({ orgs: 2, moreOrgs: true, embedded: 2 });
    expect(missing(rows).map((r) => r.organization_id)).toEqual(['org-c']);
  });

  it('logs no item name and no organization id, whatever fails', async () => {
    const rows = [item('org-a', { name: 'Gemini refuses this one' }), item('org-b')];
    const { client } = table(rows, { failReadFor: 'org-b' });
    vi.stubGlobal('fetch', gemini({ failFor: 'Gemini refuses this one' }));

    await sweepMissingEmbeddings(client);

    const text = JSON.stringify(
      logged.map((args) => args.map((a) => (a instanceof Error ? a.message : a))),
    );
    for (const r of rows) {
      expect(text).not.toContain(r.name);
      expect(text).not.toContain(r.organization_id);
    }
  });

  it('the budget: 100 items per organization, 150 per run, 50 organizations, 150 s', () => {
    expect(EMBEDDINGS_SWEEP).toEqual({
      perOrgCap: 100,
      runCap: 150,
      maxOrgs: 50,
      deadlineMs: 150_000,
    });
  });
});
