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
 * organization filters are the only tenant boundary. It works only for the
 * organizations that switched the AI module on (their own organization_modules
 * row; a comp does not count, as for every cron): any other organization's
 * items are never read, sent to Gemini or written. Every read and write of an
 * item names one organization, every write names the item and that
 * organization, and only the `embedding` column is ever written. No log line
 * or alert names an item, whatever fails, and an organization is named (by
 * id) only in the error report of its own failed read, as every cron reports
 * one: the real reportError runs here, so what it prints and posts is seen.
 *
 * What the sweep is for: any item left with `embedding IS NULL`, whatever
 * left it (the books import and bulkCreate do not embed at once, a Gemini
 * failure, a call cut off, an edit whose re-embed failed after trigger 0401
 * cleared its old vector, a path added later), is embedded by the next run
 * that reaches it, within a strict budget per run (100 items per
 * organization, 150 per run, so a larger backlog clears over several runs).
 *
 * Driven through the REAL embedItemsBatch and the REAL Gemini SDK, with
 * `fetch` stubbed and the items table served the way PostgREST filters it
 * (servedLikePostgrest): a dropped organization filter shows up here as
 * another organization's rows.
 */

const h = vi.hoisted(() => ({
  env: { GEMINI_API_KEY: 'test-key' } as { GEMINI_API_KEY?: string },
}));
vi.mock('@/lib/env', () => ({
  get env() {
    return h.env;
  },
}));
// The REAL reportError, watched: what it prints (console.error) and posts
// (the webhook, through the stubbed fetch) is what a run would log.
vi.mock('@/lib/error-reporter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/error-reporter')>();
  return { ...actual, reportError: vi.fn(actual.reportError) };
});

import { reportError } from '@/lib/error-reporter';

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
  updated_at: string;
};

let seq = 0;
function item(org: string, over: Partial<Row> = {}): Row {
  seq += 1;
  const created = new Date(Date.UTC(2026, 8, 1) + seq * 60_000).toISOString();
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
    created_at: created,
    updated_at: created,
    ...over,
  };
}

/** A later updated_at: what any real change to a row writes (0242). */
const LATER = '2026-10-13T00:37:20.123456+00:00';

type ModuleRow = { organization_id: string; module_id: string; enabled: boolean };

/** The 'ai' module switched on, by its own row, for each of `orgs`. */
const aiOn = (...orgs: string[]): ModuleRow[] =>
  orgs.map((organization_id) => ({ organization_id, module_id: 'ai', enabled: true }));

/**
 * The items table behind a service-role stub, answering as PostgREST and
 * Postgres would. A read applies its own filters (count: 'exact', head: true
 * answers a count) and hands back copies, so a row changed after a read is
 * not changed in what that read returned. An UPDATE writes only the rows ALL
 * of its own filters match (organization_id and id, and any guard such as
 * updated_at or embedding IS NULL), answers them to .select('id'), and is
 * recorded either way. `afterReadAgain` runs right after a read of items with
 * no .limit(), which is the read of one item just before its write.
 *
 * `modules` is organization_modules, served the same way; by default the 'ai'
 * module is switched on for every organization in `rows`. `orgs` is the
 * organizations table (an all_modules_comp a test offers). `failReadFor`
 * fails that organization's batch read (embedItemsBatch's read of the items
 * to embed); `failModulesRead` fails the read of organization_modules.
 * `afterLook` runs after the sweep's look at one organization for an item
 * without an embedding (a read of `id` alone, with a .limit()).
 */
function table(
  rows: Row[],
  opts: {
    failReadFor?: string;
    failModulesRead?: boolean;
    afterReadAgain?: (row: Row) => void;
    afterLook?: (org: string) => void;
    modules?: ModuleRow[];
    orgs?: Array<{ id: string; all_modules_comp: boolean }>;
  } = {},
) {
  const modules = opts.modules ?? aiOn(...new Set(rows.map((r) => r.organization_id)));
  const writes: Array<{
    keys: string[];
    org: string | undefined;
    id: string | undefined;
    written: number;
  }> = [];
  const stub = makeSupabaseStub({
    'organization_modules.select': (call: MockCall) =>
      opts.failModulesRead
        ? { data: null, error: { message: 'canceling statement due to statement timeout' } }
        : servedLikePostgrest(() => modules)(call),
    'organizations.select': (call: MockCall) => servedLikePostgrest(() => opts.orgs ?? [])(call),
    'inventory_items.select': (call: MockCall) => {
      const org = call.args[call.methods.indexOf('eq')]?.[1];
      const isBatchRead =
        call.methods.includes('limit') &&
        String(callArgs(call, 'select')?.[0] ?? '').startsWith('id, name');
      if (opts.failReadFor && org === opts.failReadFor && isBatchRead) {
        return { data: null, error: { message: 'canceling statement due to statement timeout' } };
      }
      const served = servedLikePostgrest(() => rows)(call);
      const head = (callArgs(call, 'select')?.[1] as { head?: boolean } | undefined)?.head;
      if (head) return { data: null, error: null, count: (served.data as unknown[]).length };
      const copies = (served.data as Row[]).map((r) => ({ ...r }));
      if (!call.methods.includes('limit')) {
        for (const r of served.data as Row[]) opts.afterReadAgain?.(r);
      }
      if (call.methods.includes('limit') && callArgs(call, 'select')?.[0] === 'id') {
        opts.afterLook?.(String(org));
      }
      return { data: copies, error: null };
    },
    'inventory_items.update': (call: MockCall) => {
      const patch = call.args[0]?.[0] as Record<string, unknown>;
      const eqOf = (col: string) =>
        call.methods.flatMap((m, i) =>
          m === 'eq' && call.args[i]?.[0] === col ? [call.args[i]?.[1] as string] : [],
        )[0];
      // The UPDATE's own filters, applied like PostgREST (.update and
      // .select are not filters).
      const filter = call.methods.map((m) => m !== 'update' && m !== 'select');
      const matched = servedLikePostgrest(() => rows)({
        ...call,
        methods: call.methods.filter((_, i) => filter[i]),
        args: call.args.filter((_, i) => filter[i]),
      }).data as Row[];
      for (const r of matched) r.embedding = String(patch.embedding);
      writes.push({
        keys: Object.keys(patch),
        org: eqOf('organization_id'),
        id: eqOf('id'),
        written: matched.length,
      });
      return {
        data: call.methods.includes('select') ? matched.map((r) => ({ id: r.id })) : null,
        error: null,
      };
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

/**
 * A Gemini fetch: answers a vector, or fails for a text containing `failFor`.
 * `onCall` runs while the call is in flight, with the text being embedded.
 */
function gemini(opts: { failFor?: string; onCall?: (text: string) => void } = {}) {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      content?: { parts?: Array<{ text?: string }> };
    };
    const text = body.content?.parts?.[0]?.text ?? '';
    opts.onCall?.(text);
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
  vi.mocked(reportError).mockClear();
  // No alert webhook unless a test sets one.
  vi.stubEnv('ERROR_WEBHOOK_URL', '');
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
  vi.unstubAllEnvs();
});

describe('the embeddings sweep', () => {
  it('nothing missing: one look per organization with AI on, no Gemini call, no write', async () => {
    const rows = [
      item('org-a', { embedding: '[1]' }),
      // A deleted item is never missing: it is not searched.
      item('org-a', { deleted_at: '2026-10-01T00:00:00Z' }),
      item('org-b', { embedding: '[1]' }),
    ];
    const { client, stub, writes } = table(rows);
    const fetch = gemini();
    vi.stubGlobal('fetch', fetch);

    const result = await sweepMissingEmbeddings(client);

    expect(fetch).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    // The organizations with AI on, then one look at each for a missing item.
    expect(stub.fromCalls).toEqual(['organization_modules', 'inventory_items', 'inventory_items']);
    expect(result).toMatchObject({ aiOrgs: 2, orgs: 0, embedded: 0, failed: 0, remaining: 0 });
  });

  it('an organization without the AI module switched on is never read, sent to Gemini or written', async () => {
    // Only the AI assistant's search reads an embedding, so the sweep works
    // only for the organizations that switched AI on. org-b switched it off,
    // org-c has other modules but no AI row, and org-d is comped (every
    // module unlocked) with its AI switch off: a comp unlocks for members, it
    // does not start a machine (lib/modules/effective-modules.ts), the same
    // rule the daily briefing follows.
    const rows = [item('org-a'), item('org-b'), item('org-c'), item('org-d'), item('org-a')];
    const { client, stub, writes } = table(rows, {
      modules: [
        ...aiOn('org-a'),
        { organization_id: 'org-b', module_id: 'ai', enabled: false },
        { organization_id: 'org-c', module_id: 'schedule', enabled: true },
        { organization_id: 'org-d', module_id: 'ai', enabled: false },
        { organization_id: 'org-d', module_id: 'schedule', enabled: true },
      ],
      orgs: [{ id: 'org-d', all_modules_comp: true }],
    });
    const texts: string[] = [];
    vi.stubGlobal('fetch', gemini({ onCall: (text) => texts.push(text) }));

    const result = await sweepMissingEmbeddings(client);

    expect(result).toMatchObject({ aiOrgs: 1, orgs: 1, embedded: 2, remaining: 0 });
    // Every item read and every write named org-a, and only org-a.
    const named = [
      ...(stub.chainArgsAll.get('inventory_items.select') ?? []),
      ...(stub.chainArgsAll.get('inventory_items.update') ?? []),
    ].map((args) => args.find((a) => a[0] === 'organization_id')?.[1]);
    expect(named.length).toBeGreaterThan(0);
    expect(new Set(named)).toEqual(new Set(['org-a']));
    // Gemini saw org-a's two items and nothing else.
    expect(texts).toHaveLength(2);
    for (const t of texts) expect(t).toContain('Private name org-a');
    expect(writes.map((w) => w.org)).toEqual(['org-a', 'org-a']);
    expect(missing(rows).map((r) => r.organization_id)).toEqual(['org-b', 'org-c', 'org-d']);
    // The comp is never looked at.
    expect(stub.fromCalls).not.toContain('organizations');
  });

  it('the AI switch is read from organization_modules: the AI module, switched on', async () => {
    const { client, stub } = table([item('org-a')]);
    vi.stubGlobal('fetch', gemini());

    await sweepMissingEmbeddings(client);

    const [methods] = stub.chainsAll.get('organization_modules.select') ?? [];
    const [args] = stub.chainArgsAll.get('organization_modules.select') ?? [];
    const filters = (methods ?? []).flatMap((m, i) =>
      m === 'eq' || m === 'is' ? [[m, ...(args?.[i] ?? [])]] : [],
    );
    expect(filters).toEqual([
      ['eq', 'module_id', 'ai'],
      ['eq', 'enabled', true],
    ]);
  });

  it('when the AI switches cannot be read, the run reads and writes no item, and throws for the route to report', async () => {
    const rows = [item('org-a')];
    const { client, stub } = table(rows, { failModulesRead: true });
    const fetch = gemini();
    vi.stubGlobal('fetch', fetch);

    // In the database's words, for the route's report.
    await expect(sweepMissingEmbeddings(client)).rejects.toThrow(
      'embeddings sweep: could not read the AI switches: canceling statement due to statement timeout',
    );

    expect(stub.fromCalls).toEqual(['organization_modules']);
    expect(fetch).not.toHaveBeenCalled();
    expect(missing(rows)).toHaveLength(1);
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
    // Two of org-a's three fail, never three in a row (that would stop the
    // run on its own): the cap alone stops it.
    const rows = [
      item('org-a', { name: 'Gemini refuses this one' }),
      item('org-a'),
      item('org-a', { name: 'Gemini refuses this one' }),
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
    expect(result).toMatchObject({
      embedded: 1,
      failed: 2,
      orgsProcessed: 1,
      orgsLeft: 1,
      stopped: null,
    });
  });

  it("Gemini's first 429 stops the whole run: the key is shared, so no other organization is tried", async () => {
    // The key has reached its per-minute or daily limit. Every call would
    // be refused, and the AI assistant's own searches need the same key.
    const rows = [...[1, 2, 3].map(() => item('org-a')), ...[1, 2, 3].map(() => item('org-b'))];
    const { client } = table(rows);
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'Resource has been exhausted' } }), {
          status: 429,
        }),
    );
    vi.stubGlobal('fetch', fetch);

    const result = await sweepMissingEmbeddings(client);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      stopped: 'gemini_rate_limited',
      embedded: 0,
      failed: 1,
      orgsProcessed: 1,
      orgsLeft: 1,
      firstError: expect.stringContaining('429'),
    });
    expect(missing(rows)).toHaveLength(6);
  });

  it('three Gemini failures in a row stop the run, counted across organizations', async () => {
    // Gemini is down (every call a 500). Two items in each of three
    // organizations: the third failure, org-b's first, stops the run.
    const rows = ['org-a', 'org-a', 'org-b', 'org-b', 'org-c', 'org-c'].map((o) => item(o));
    const { client } = table(rows);
    const fetch = gemini({ failFor: 'Private name' });
    vi.stubGlobal('fetch', fetch);

    const result = await sweepMissingEmbeddings(client);

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      stopped: 'gemini_failing',
      geminiFailuresInARow: 3,
      failed: 3,
      orgsProcessed: 2,
      orgsLeft: 1,
    });
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

  it("an item edited while the run embeds it keeps the edit's own newer embedding: nothing is written over it", async () => {
    // A books import left a wrong title; the run read it. While Gemini embeds
    // that text, a staff member fixes the title and update() re-embeds the
    // record with the right one.
    const rows = [item('org-a', { name: 'Wrong title' })];
    const { client } = table(rows);
    vi.stubGlobal(
      'fetch',
      gemini({
        onCall: () => {
          Object.assign(rows[0]!, {
            name: 'Right title',
            updated_at: LATER,
            embedding: "[the edit's own vector]",
          });
        },
      }),
    );

    const result = await sweepMissingEmbeddings(client);

    // (A prefix: a full vector in a failure message is 20 KB of numbers.)
    expect(rows[0]!.embedding?.slice(0, 40)).toBe("[the edit's own vector]");
    expect(result).toMatchObject({ embedded: 0, changed: 1, failed: 0, remaining: 0 });
  });

  it('an item edited while the run embeds it, before its own embed lands, is left for the next run, which embeds its new text', async () => {
    const rows = [item('org-a', { name: 'Wrong title' })];
    const { client } = table(rows);
    vi.stubGlobal(
      'fetch',
      gemini({
        onCall: () => {
          Object.assign(rows[0]!, { name: 'Right title', updated_at: LATER });
        },
      }),
    );

    const first = await sweepMissingEmbeddings(client);

    // Nothing built from the old text was written.
    expect(rows[0]!.embedding?.slice(0, 40) ?? null).toBeNull();
    expect(first).toMatchObject({ embedded: 0, changed: 1, remaining: 1 });

    const texts: string[] = [];
    vi.stubGlobal('fetch', gemini({ onCall: (text) => texts.push(text) }));
    const second = await sweepMissingEmbeddings(client);

    expect(second).toMatchObject({ embedded: 1, changed: 0, remaining: 0 });
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('Right title');
    expect(texts[0]).not.toContain('Wrong title');
  });

  it('an edit that lands between the read just before the write and the write is not written over either', async () => {
    const rows = [item('org-a', { name: 'Wrong title' })];
    const { client, writes } = table(rows, {
      afterReadAgain: (r) => Object.assign(r, { name: 'Right title', updated_at: LATER }),
    });
    vi.stubGlobal('fetch', gemini());

    const result = await sweepMissingEmbeddings(client);

    expect(rows[0]!.embedding?.slice(0, 40) ?? null).toBeNull();
    expect(result).toMatchObject({ embedded: 0, changed: 1, remaining: 1 });
    // The write was tried and matched no row: its updated_at no longer held.
    expect(writes.map((w) => w.written)).toEqual([0]);
  });

  it('a stock movement while the run embeds an item does not stop its write: the text is the same', async () => {
    // A movement moves updated_at too (any real change does), but the text
    // the vector was built from is still the item's text.
    const rows = [item('org-a')];
    const { client } = table(rows);
    vi.stubGlobal(
      'fetch',
      gemini({
        onCall: () => {
          rows[0]!.updated_at = LATER;
        },
      }),
    );

    const result = await sweepMissingEmbeddings(client);

    expect(result).toMatchObject({ embedded: 1, changed: 0, remaining: 0 });
    expect(missing(rows)).toEqual([]);
  });

  it('a vector another path wrote meanwhile (the Settings > AI backfill, an edit) is never replaced: the run fills only missing ones', async () => {
    // An embedding-only write keeps updated_at (0242), so only the
    // "still missing" guard on the write can see it.
    const rows = [item('org-a')];
    const { client } = table(rows);
    vi.stubGlobal(
      'fetch',
      gemini({
        onCall: () => {
          rows[0]!.embedding = "[the backfill's vector]";
        },
      }),
    );

    const result = await sweepMissingEmbeddings(client);

    expect(rows[0]!.embedding?.slice(0, 40)).toBe("[the backfill's vector]");
    expect(result).toMatchObject({ embedded: 0, changed: 1 });
  });

  it('attempts on items that changed meanwhile count against the run cap too', async () => {
    const rows = [item('org-a'), item('org-a'), item('org-b'), item('org-b'), item('org-b')];
    const { client } = table(rows);
    // Every org-a item is edited while Gemini embeds it.
    const fetch = gemini({
      onCall: (text) => {
        const r = rows.find((x) => x.organization_id === 'org-a' && text.includes(x.name));
        if (r) Object.assign(r, { name: `${r.name} (edited)`, updated_at: LATER });
      },
    });
    vi.stubGlobal('fetch', fetch);

    const result = await sweepMissingEmbeddings(client, {
      ...EMBEDDINGS_SWEEP,
      perOrgCap: 3,
      runCap: 3,
    });

    // Two attempts in org-a, so org-b gets one.
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ embedded: 1, changed: 2, failed: 0, orgsProcessed: 2 });
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
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportError).mock.calls[0]?.[1]).toMatchObject({
      tag: 'cron.embeddings-sweep.org',
      organizationId: 'org-b',
    });
  });

  it("returns only once an organization's failure report is sent: its alert POST is never left in flight", async () => {
    // org-b, the last organization of the run, fails its read. The real
    // reportError prints its line, then posts to the alert webhook; the run
    // must not return (and the route must not answer) before that POST ends.
    vi.stubEnv('ERROR_WEBHOOK_URL', 'https://alerts.test.local/hook');
    const rows = [item('org-a'), item('org-b')];
    const { client } = table(rows, { failReadFor: 'org-b' });
    const geminiFetch = gemini();
    let answerAlert: (() => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        if (String(url) === 'https://alerts.test.local/hook') {
          await new Promise<void>((resolve) => {
            answerAlert = resolve;
          });
          return new Response('ok', { status: 200 });
        }
        return geminiFetch(url, init);
      }),
    );

    let returned = false;
    const run = sweepMissingEmbeddings(client).then((r) => {
      returned = true;
      return r;
    });
    for (let i = 0; i < 50 && !answerAlert; i += 1) await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(answerAlert).toBeTypeOf('function');
    expect(returned).toBe(false);
    answerAlert!();
    await expect(run).resolves.toMatchObject({ orgsProcessed: 1, orgsFailed: 1, embedded: 1 });
  });

  it('looks at no more than maxOrgs organizations in a run', async () => {
    const rows = [item('org-a'), item('org-b'), item('org-c')];
    const { client } = table(rows);
    vi.stubGlobal('fetch', gemini());

    const result = await sweepMissingEmbeddings(client, { ...EMBEDDINGS_SWEEP, maxOrgs: 2 });

    expect(result).toMatchObject({ aiOrgs: 3, orgs: 2, moreOrgs: true, embedded: 2 });
    expect(missing(rows).map((r) => r.organization_id)).toEqual(['org-c']);
  });

  it('stops looking for organizations at the deadline, and starts nothing after it', async () => {
    let now = at(0);
    vi.mocked(Date.now).mockImplementation(() => now);
    const rows = [item('org-a'), item('org-b'), item('org-c')];
    // The look at org-b takes the run past its deadline (a Supabase stall).
    const looked: string[] = [];
    const { client } = table(rows, {
      afterLook: (org) => {
        looked.push(org);
        if (org === 'org-b') now += EMBEDDINGS_SWEEP.deadlineMs;
      },
    });
    const fetch = gemini();
    vi.stubGlobal('fetch', fetch);

    const result = await sweepMissingEmbeddings(client);

    expect(looked).toEqual(['org-a', 'org-b']);
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ orgs: 2, moreOrgs: true, embedded: 0, timeUp: true });
    expect(missing(rows)).toHaveLength(3);
  });

  it('no log line, alert or summary names an item, whatever fails; an organization is named only in the report of its own failed read', async () => {
    // org-a's item is refused by Gemini; org-b's read fails. The real
    // reportError prints its payload and posts it to the alert webhook. A
    // failed item is counted, never logged on its own line (that line would
    // carry its id), and the run keeps only the first failure's message for
    // its summary.
    vi.stubEnv('ERROR_WEBHOOK_URL', 'https://alerts.test.local/hook');
    const rows = [item('org-a', { name: 'Gemini refuses this one' }), item('org-b')];
    const { client } = table(rows, { failReadFor: 'org-b' });
    const geminiFetch = gemini({ failFor: 'Gemini refuses this one' });
    const alerts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        if (String(url) === 'https://alerts.test.local/hook') {
          alerts.push(String(init?.body));
          return new Response('ok', { status: 200 });
        }
        return geminiFetch(url, init);
      }),
    );

    const result = await sweepMissingEmbeddings(client);

    const lines = logged.map((args) =>
      JSON.stringify(args.map((a) => (a instanceof Error ? a.message : a))),
    );
    // The result is the route's one summary line.
    const everything = [...lines, ...alerts, JSON.stringify(result)];
    // The report was seen (it is printed and posted), and the failed item's
    // error reached the summary: the checks below are not vacuous.
    expect(alerts).toHaveLength(1);
    expect(result).toMatchObject({
      failed: 1,
      firstError: expect.stringContaining('backend error'),
    });
    for (const r of rows) {
      for (const text of everything) {
        expect(text).not.toContain(r.name);
        expect(text).not.toContain(r.id);
      }
    }
    expect(everything.filter((t) => t.includes('org-a'))).toEqual([]);
    const namingB = everything.filter((t) => t.includes('org-b'));
    expect(namingB).toHaveLength(2);
    for (const t of namingB) expect(t).toContain('cron.embeddings-sweep.org');
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
