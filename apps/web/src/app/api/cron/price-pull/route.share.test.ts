import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { cronAttemptsTable } from '@/test/cron-attempts-table';
import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * The daily price pull shares its 200 Google lookups and its time: each
 * organization is offered an equal part of what is left, least recently
 * reached first, so an organization with a big backlog cannot take the whole
 * run, every day, and neither can the first one when the deadline binds.
 */

vi.mock('@/lib/env', () => ({ env: { CRON_SECRET: 'test-cron-secret' } }));
const reportError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/error-reporter', () => ({ reportError }));
const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => adminHolder.client) }));
vi.mock('@/server/loaders/inventory-list', () => ({ revalidateInventoryList: vi.fn() }));
vi.mock('@/server/pricing/google-books-client', () => ({ googleBooksClient: {} }));

/** Unpriced books per organization; a refresh looks up to its share, one
 *  book at a time, stopping at its deadline as the service does. With
 *  `cost.lookupMs` each lookup moves the (fake) clock; `unknown` books cost a
 *  lookup and give no price. */
const backlog = new Map<string, number>();
const unknown = new Map<string, number>();
const calls: Array<{ orgId: string; share: number; written: number; lookups?: number }> = [];
const cost = { wait: false, lookupMs: 0 };
/** With `answers` set, Google answers that many lookups in all, then stops
 *  answering (a rate limit): the refresh stops as the service does. */
const google = { answers: null as number | null, asked: 0 };
vi.mock('@/server/services/price-tracking', () => ({
  refreshBookPricesForOrg: async (
    _admin: unknown,
    orgId: string,
    _client: unknown,
    opts: { limit: number; maxLookups: number; deadlineMs: number },
  ) => {
    if (cost.wait) await new Promise((r) => setTimeout(r, 1));
    let lookups = 0;
    let written = 0;
    let googleUnavailable = false;
    while (lookups < opts.maxLookups && !(Date.now() > opts.deadlineMs)) {
      if (google.answers !== null && google.asked >= google.answers) {
        google.asked += 1;
        lookups += 1;
        googleUnavailable = true;
        break;
      }
      const unpriceable = unknown.get(orgId) ?? 0;
      const priceable = backlog.get(orgId) ?? 0;
      if (unpriceable + priceable === 0) break;
      if (unpriceable > 0) unknown.set(orgId, unpriceable - 1);
      else {
        backlog.set(orgId, priceable - 1);
        written += 1;
      }
      lookups += 1;
      google.asked += 1;
      if (cost.lookupMs > 0) vi.setSystemTime(Date.now() + cost.lookupMs);
    }
    calls.push({ orgId, share: opts.maxLookups, written, lookups });
    return { scanned: lookups, written, skipped: lookups - written, lookups, googleUnavailable };
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
  unknown.clear();
  calls.length = 0;
  cost.wait = false;
  cost.lookupMs = 0;
  google.answers = null;
  google.asked = 0;
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
    expect(calls.map(({ orgId, share, written }) => ({ orgId, share, written }))).toEqual([
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
      { orgId: 'org-001', scanned: 190, written: 190, skipped: 0, lookups: 190 },
      { orgId: 'org-002', scanned: 5, written: 5, skipped: 0, lookups: 5 },
      { orgId: 'org-003', scanned: 5, written: 5, skipped: 0, lookups: 5 },
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
    expect(log).toMatchObject({
      orgs: 300,
      lookups: 200,
      lookupCap: 200,
      written: 200,
      leftForNextRun: 100,
    });

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

  it('when the deadline binds, two organizations with backlogs each get about half of the run, every day', async () => {
    // 0.4 s a lookup: the 50 s deadline allows about 125, under the 200 cap.
    // A share of lookups alone gave the first organization its 100 and the
    // second the 25 left, every day (the order repeats when both are reached).
    vi.useFakeTimers({ toFake: ['Date'] });
    cost.lookupMs = 400;
    const orgs = orgIds(2);
    backlog.set('org-001', 100_000);
    backlog.set('org-002', 100_000);
    const table = cronAttemptsTable();
    const totals = new Map<string, number>();
    for (let day = 0; day < 4; day += 1) {
      vi.setSystemTime(Date.parse('2026-11-17T09:00:00.000Z') + day * 24 * 60 * 60_000);
      adminHolder.client = client(table, orgs);
      calls.length = 0;
      await get();
      const today = writtenBy();
      const a = today.get('org-001') ?? 0;
      const b = today.get('org-002') ?? 0;
      expect(a + b).toBeGreaterThanOrEqual(120);
      expect(Math.min(a, b) / Math.max(a, b)).toBeGreaterThan(0.9);
      for (const [o, n] of today) totals.set(o, (totals.get(o) ?? 0) + n);
    }
    expect(totals.get('org-001')).toBeGreaterThan(0);
    expect(Math.abs(totals.get('org-001')! - totals.get('org-002')!)).toBeLessThan(20);
  });

  it('counts Google lookups, not only prices, against the cap: books Google does not know cannot take more than the cap', async () => {
    const orgs = orgIds(1);
    unknown.set('org-001', 1000); // never priceable
    backlog.set('org-001', 1000);
    adminHolder.client = client(cronAttemptsTable(), orgs);

    await get();
    const lookups = calls.reduce((n, c) => n + (c.lookups ?? 0), 0);
    expect(lookups).toBe(200);
    const log = JSON.parse(String(info.mock.calls.find((c) => c[0] === '[cron.price-pull]')?.[1]));
    expect(log).toMatchObject({ lookups: 200, lookupCap: 200, written: 0 });
  });

  it('when Google stops answering (a rate limit), the run asks nothing more, reports it once, and the organizations not reached go first next run', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-17T09:00:00.000Z'));
    const orgs = orgIds(3);
    for (const o of orgs) backlog.set(o, 500);
    google.answers = 70;
    const table = cronAttemptsTable();
    adminHolder.client = client(table, orgs);

    const body = await (await get()).json();
    // org-001 gets its 67; org-002 three, then the call Google refuses; org-003
    // is never started, and nothing is asked after the refusal.
    expect(calls.map(({ orgId, written, lookups }) => [orgId, written, lookups])).toEqual([
      ['org-001', 67, 67],
      ['org-002', 3, 4],
    ]);
    expect(google.asked).toBe(71);
    expect(body.leftForNextRun).toBe(1);
    const google429 = reportError.mock.calls.filter(
      ([, c]) => (c as { tag?: string }).tag === 'cron.price-pull.google',
    );
    expect(google429).toHaveLength(1);
    const line = JSON.parse(
      String(info.mock.calls.find((c) => c[0] === '[cron.price-pull]')?.[1]),
    ) as Record<string, unknown>;
    expect(line).toMatchObject({ googleUnavailable: true, rounds: 1, leftForNextRun: 1 });

    calls.length = 0;
    google.answers = null;
    vi.setSystemTime(Date.parse('2026-11-18T09:00:00.000Z'));
    await get();
    expect(calls[0]!.orgId).toBe('org-003');
  });
});
