import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { cronAttemptsTable } from '@/test/cron-attempts-table';
import { callArgs, makeSupabaseStub, type MockCall, type QueryResult } from '@/test/supabase-mock';

/**
 * The weekly digest reaches every organization: least recently reached
 * first, a soft deadline before maxDuration, one log line with what it left,
 * and one digest per member per week however often the tick is delivered
 * (the week's claim per organization and member).
 */

vi.mock('@/lib/env', () => ({
  env: { CRON_SECRET: 'test-cron-secret', NEXT_PUBLIC_APP_URL: 'https://app.example.test' },
}));
const reportError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/error-reporter', () => ({ reportError }));
const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => adminHolder.client) }));

const mailed: string[] = [];
const cost = { ms: 0, wait: false };
vi.mock('@/lib/email/resend', () => ({
  sendEmail: async (args: { to: string }) => {
    mailed.push(args.to);
    if (cost.ms > 0) vi.setSystemTime(Date.now() + cost.ms);
    if (cost.wait) await new Promise((r) => setTimeout(r, 1));
    return { ok: true };
  },
}));
vi.mock('@/lib/email/es/families/digest', () => ({
  DIGEST_FROM: 'StockPilot <digest@example.test>',
  renderWeeklyDigestHtml: vi.fn(() => '<html>digest</html>'),
  weeklyDigestSubject: vi.fn(() => 'Your weekly inventory digest'),
  weeklyDigestText: vi.fn(() => 'digest text'),
}));
vi.mock('@/server/services/digest', () => ({
  getDigestSource: vi.fn(async () => ({ lowStock: [], openPos: [], openCycleCounts: [] })),
  loadDigestReaderData: vi.fn(async () => ({})),
  digestReaderFor: vi.fn(() => ({})),
  buildDigestPayload: vi.fn(() => ({ lowStock: [], openPos: [], openCycleCounts: [] })),
  isDigestEmpty: vi.fn(() => false),
  applySectionOptIns: vi.fn((payload: unknown) => payload),
}));

import { GET, maxDuration } from './route';

const N = 6;
const orgOf = (k: number) => `org-${k}`;
const mailOf = (k: number) => `member${k}@example.test`;

/** idempotency_keys with its UNIQUE (organization_id, scope, key). */
function claimsTable() {
  const rows = new Map<string, Record<string, unknown>>();
  const keyOf = (r: Record<string, unknown>) => `${r.organization_id}|${r.scope}|${r.key}`;
  return {
    'idempotency_keys.insert': (call: MockCall): QueryResult => {
      const row = callArgs(call, 'insert')?.[0] as Record<string, unknown>;
      if (rows.has(keyOf(row))) {
        return {
          data: null,
          error: { code: '23505', message: 'duplicate key value violates unique constraint' },
        };
      }
      rows.set(keyOf(row), { id: `claim-${rows.size + 1}`, ...row });
      return { data: null, error: null };
    },
    'idempotency_keys.select': (call: MockCall): QueryResult => {
      const eq = Object.fromEntries(
        call.methods.flatMap((m, i) => (m === 'eq' ? [call.args[i] as [string, unknown]] : [])),
      );
      return { data: rows.get(keyOf(eq)) ?? null, error: null };
    },
  };
}

function client(table: ReturnType<typeof cronAttemptsTable>) {
  return makeSupabaseStub({
    ...table.results,
    ...claimsTable(),
    'user_profiles.select': {
      data: Array.from({ length: N }, (_, i) => ({
        id: `user-${i + 1}`,
        email: mailOf(i + 1),
        full_name: 'Sample Member',
        digest_section_low_stock: true,
        digest_section_open_pos: true,
        digest_section_cycle_counts: true,
        organization_members: [
          {
            organization_id: orgOf(i + 1),
            accepted_at: '2026-01-01T00:00:00Z',
            organizations: { id: orgOf(i + 1), name: `Sample ${i + 1}`, timezone: 'UTC' },
          },
        ],
      })),
      error: null,
    },
    'user_profiles.select.maybeSingle': {
      data: { email_digest_optin: true, disabled_at: null },
      error: null,
    },
    'organization_members.select.maybeSingle': {
      data: { user_id: 'user-x', accepted_at: '2026-01-01T00:00:00Z', role: 'admin' },
      error: null,
    },
  }).client;
}

const get = () =>
  GET(
    new Request('https://test.local/api/cron/weekly-digest', {
      headers: { authorization: 'Bearer test-cron-secret' },
    }),
  );

let info: MockInstance<Console['info']>;
beforeEach(() => {
  vi.clearAllMocks();
  mailed.length = 0;
  cost.ms = 0;
  cost.wait = false;
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  info.mockRestore();
});

const logLine = () =>
  JSON.parse(String(info.mock.calls.find((c) => c[0] === '[cron.weekly-digest]')?.[1])) as Record<
    string,
    unknown
  >;

describe('GET /api/cron/weekly-digest reaches every organization', () => {
  it('has room past the soft deadline: maxDuration 300', () => {
    expect(maxDuration).toBe(300);
  });

  it('stops starting organizations at the deadline, says how many it left, and the next week starts with them', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-16T14:00:00.000Z'));
    cost.ms = 100_000;
    const table = cronAttemptsTable();
    adminHolder.client = client(table);

    expect(await (await get()).json()).toMatchObject({ sent: 3, leftForNextRun: 3 });
    expect(mailed).toEqual([mailOf(1), mailOf(2), mailOf(3)]);
    expect(logLine()).toMatchObject({ organizations: 6, sent: 3, leftForNextRun: 3 });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'cron.weekly-digest.deadline' }),
    );

    mailed.length = 0;
    vi.setSystemTime(Date.parse('2026-11-23T14:00:00.000Z'));
    adminHolder.client = client(table); // a new week: no claims carried over
    await get();
    expect(mailed).toEqual([mailOf(4), mailOf(5), mailOf(6)]);
  });

  it('one tick delivered twice: each member is sent one digest', async () => {
    cost.wait = true;
    adminHolder.client = client(cronAttemptsTable());
    const [a, b] = await Promise.all([get(), get()]);
    const bodies = [await a.json(), await b.json()];
    expect([...mailed].sort()).toEqual(Array.from({ length: N }, (_, i) => mailOf(i + 1)).sort());
    expect(bodies[0].sent + bodies[1].sent).toBe(N);
  });
});
