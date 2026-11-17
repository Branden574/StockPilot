import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { cronAttemptsTable } from '@/test/cron-attempts-table';
import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * The daily price pull shares its 200 observations: each organization is
 * offered an equal part of what is left, least recently reached first, so an
 * organization with a big backlog cannot take the whole run, every day.
 */

vi.mock('@/lib/env', () => ({ env: { CRON_SECRET: 'test-cron-secret' } }));
const reportError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/error-reporter', () => ({ reportError }));
const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => adminHolder.client) }));
vi.mock('@/server/loaders/inventory-list', () => ({ revalidateInventoryList: vi.fn() }));
vi.mock('@/server/pricing/google-books-client', () => ({ googleBooksClient: {} }));

/** Unpriced books per organization; a refresh prices up to its limit. */
const backlog = new Map<string, number>();
const calls: Array<{ orgId: string; share: number; written: number }> = [];
const cost = { wait: false };
vi.mock('@/server/services/price-tracking', () => ({
  refreshBookPricesForOrg: async (
    _admin: unknown,
    orgId: string,
    _client: unknown,
    opts: { limit: number; maxWritten: number },
  ) => {
    if (cost.wait) await new Promise((r) => setTimeout(r, 1));
    const written = Math.min(opts.maxWritten, backlog.get(orgId) ?? 0);
    backlog.set(orgId, (backlog.get(orgId) ?? 0) - written);
    calls.push({ orgId, share: opts.maxWritten, written });
    return { scanned: written, written, skipped: 0 };
  },
}));

import { GET } from './route';

const orgIds = (n: number) =>
  Array.from({ length: n }, (_, i) => `org-${String(i + 1).padStart(3, '0')}`);

function client(table: ReturnType<typeof cronAttemptsTable>, orgs: string[]) {
  return makeSupabaseStub({
    ...table.results,
    'organization_modules.select': (call) => {
      const [from, to] = (call.args[call.methods.indexOf('range')] ?? [0, 999]) as [number, number];
      return { data: orgs.slice(from, to + 1).map((id) => ({ organization_id: id })), error: null };
    },
  }).client;
}

const get = () =>
  GET(
    new Request('https://test.local/api/cron/price-pull', {
      headers: { authorization: 'Bearer test-cron-secret' },
    }),
  );

let info: MockInstance<Console['info']>;
beforeEach(() => {
  vi.clearAllMocks();
  backlog.clear();
  calls.length = 0;
  cost.wait = false;
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  info.mockRestore();
});

const writtenBy = () => {
  const out = new Map<string, number>();
  for (const c of calls) out.set(c.orgId, (out.get(c.orgId) ?? 0) + c.written);
  return out;
};

describe('GET /api/cron/price-pull — a fair share of the run per organization', () => {
  it('three organizations with big backlogs split the 200, instead of the first taking all of it', async () => {
    const orgs = orgIds(3);
    for (const o of orgs) backlog.set(o, 500);
    adminHolder.client = client(cronAttemptsTable(), orgs);

    await get();
    expect(calls.map((c) => [c.orgId, c.share, c.written])).toEqual([
      ['org-001', 67, 67],
      ['org-002', 67, 67],
      ['org-003', 66, 66],
    ]);
  });

  it('what the small organizations leave goes round again to the one with a backlog, so the budget is used', async () => {
    const orgs = orgIds(3);
    backlog.set('org-001', 1000);
    backlog.set('org-002', 5);
    backlog.set('org-003', 5);
    adminHolder.client = client(cronAttemptsTable(), orgs);

    const body = await (await get()).json();
    // Round one: org-001 is offered a third, the other two use 5 each and
    // pass the rest on; round two: org-001 is offered what is left.
    expect(calls).toEqual([
      { orgId: 'org-001', share: 67, written: 67 },
      { orgId: 'org-002', share: 67, written: 5 },
      { orgId: 'org-003', share: 128, written: 5 },
      { orgId: 'org-001', share: 123, written: 123 },
    ]);
    expect(writtenBy()).toEqual(
      new Map([
        ['org-001', 190],
        ['org-002', 5],
        ['org-003', 5],
      ]),
    );
    // One result per organization, summed over the rounds.
    expect(body.results).toEqual([
      { orgId: 'org-001', scanned: 190, written: 190, skipped: 0 },
      { orgId: 'org-002', scanned: 5, written: 5, skipped: 0 },
      { orgId: 'org-003', scanned: 5, written: 5, skipped: 0 },
    ]);
  });

  it('more organizations than observations: the ones the budget did not reach go first the next day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-17T09:00:00.000Z'));
    const orgs = orgIds(300);
    for (const o of orgs) backlog.set(o, 10);
    const table = cronAttemptsTable();
    adminHolder.client = client(table, orgs);

    const day1 = await (await get()).json();
    expect(calls).toHaveLength(200);
    expect(calls.every((c) => c.share === 1)).toBe(true);
    expect(day1).toMatchObject({ leftForNextRun: 100 });
    const log = JSON.parse(String(info.mock.calls.find((c) => c[0] === '[cron.price-pull]')?.[1]));
    expect(log).toMatchObject({ orgs: 300, written: 200, leftForNextRun: 100 });

    calls.length = 0;
    vi.setSystemTime(Date.parse('2026-11-18T09:00:00.000Z'));
    await get();
    expect(calls.slice(0, 100).map((c) => c.orgId)).toEqual(orgs.slice(200));
  });

  it('one tick delivered twice: no organization is priced by both runs', async () => {
    cost.wait = true;
    const orgs = orgIds(4);
    for (const o of orgs) backlog.set(o, 500);
    adminHolder.client = client(cronAttemptsTable(), orgs);

    const [a, b] = await Promise.all([get(), get()]);
    const byRun = [await a.json(), await b.json()].map(
      (body: { results: Array<{ orgId: string }> }) => body.results.map((r) => r.orgId),
    );
    // Each organization is priced by exactly one of the two runs.
    expect([...byRun[0]!, ...byRun[1]!].sort()).toEqual(orgs);
  });
});
