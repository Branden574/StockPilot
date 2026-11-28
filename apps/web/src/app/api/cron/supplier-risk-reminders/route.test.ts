import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type MockCall, type QueryResult } from '@/test/supabase-mock';

/**
 * Security invariant: the daily vendor review reminders
 * (app/api/cron/supplier-risk-reminders).
 *   - The cron secret first, fail closed: no secret set, none sent, or a
 *     wrong one is 401 and nothing is read.
 *   - The Suppliers module per organization from its explicit enabled rows,
 *     read before anything is claimed; a failed read claims and sends
 *     nothing (500). A row of an organization with the module off is never
 *     claimed, so it is sent when the module is on again.
 *   - Per row: CLAIM, then SEND, then CONFIRM (the due reminder). Nothing is
 *     sent unless the claim answered true; a claim that raised is skipped.
 *     A failed confirmation is tried again and the send is NEVER repeated.
 *     A reminder that reached nobody is not confirmed.
 *   - Two overlapping runs send each reminder once (the claim decides).
 *   - The run stops at its own deadline, after 20 reads, on an empty read,
 *     and when a read holds nothing new (asked once more at 500 rows).
 *   - Notices go to the owners and admins the database named, and open the
 *     risk register.
 */

const h = vi.hoisted(() => ({
  env: { CRON_SECRET: 'test-cron-secret' as string | undefined },
  admin: null as unknown,
  adminMade: 0,
  log: [] as string[],
  notify: vi.fn(),
  report: vi.fn(),
}));

vi.mock('@/lib/env', () => ({ env: h.env }));
vi.mock('@/lib/error-reporter', () => ({ reportError: (...a: unknown[]) => h.report(...a) }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    h.adminMade += 1;
    return h.admin;
  },
}));
vi.mock('@/server/services/notifications', () => ({
  createNotification: (args: { userId: string }) => {
    h.log.push(`notify:${args.userId}`);
    return h.notify(args);
  },
}));

import { GET } from './route';

const ORG = '0f1e2d3c-4b5a-4968-8776-655443322110';
const ORG_OFF = '0f1e2d3c-4b5a-4968-8776-655443322111';
const OWNER = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';

function dueRow(n: number, over: Record<string, unknown> = {}) {
  return {
    review_id: `e1e1e1e1-0000-4000-8000-${String(n).padStart(12, '0')}`,
    organization_id: ORG,
    supplier_id: `5a5a5a5a-0000-4000-8000-${String(n).padStart(12, '0')}`,
    supplier_name: `Example Supply Co ${n}`,
    kind: 'due',
    attempt: 1,
    next_review_on: '2026-11-27',
    org_today: '2026-11-27',
    admin_user_ids: [OWNER, ADMIN],
    ...over,
  };
}

type Answer = QueryResult | ((call: MockCall) => QueryResult);

function adminWith(opts: {
  due?: Answer;
  claim?: Answer;
  confirm?: Answer;
  enabled?: string[] | QueryResult;
}) {
  const stub = makeSupabaseStub({
    'organization_modules.select': Array.isArray(opts.enabled ?? [ORG])
      ? {
          data: ((opts.enabled as string[] | undefined) ?? [ORG]).map((organization_id) => ({
            organization_id,
          })),
          error: null,
        }
      : (opts.enabled as QueryResult),
    'rpc:supplier_risk_reminders_due': (call) => {
      h.log.push('due');
      const a = opts.due ?? { data: [], error: null };
      return typeof a === 'function' ? a(call) : a;
    },
    'rpc:supplier_risk_reminder_claim': (call) => {
      h.log.push('claim');
      const a = opts.claim ?? { data: true, error: null };
      return typeof a === 'function' ? a(call) : a;
    },
    'rpc:supplier_risk_due_reminder_sent': (call) => {
      h.log.push('confirm');
      const a = opts.confirm ?? { data: true, error: null };
      return typeof a === 'function' ? a(call) : a;
    },
  });
  h.admin = stub.client;
  return stub;
}

/** The due read answers these pages in turn, then nothing. */
function pages(...list: unknown[][]): (call: MockCall) => QueryResult {
  let i = 0;
  return () => ({ data: list[i++] ?? [], error: null });
}

const request = (auth?: string) =>
  new Request('https://test.local/api/cron/supplier-risk-reminders', {
    headers: auth === undefined ? {} : { authorization: auth },
  });
const run = () => GET(request('Bearer test-cron-secret'));

beforeEach(() => {
  h.env.CRON_SECRET = 'test-cron-secret';
  h.admin = null;
  h.adminMade = 0;
  h.log = [];
  h.notify.mockReset();
  h.notify.mockImplementation(async () => 'notice-id');
  h.report.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the cron secret, fail closed', () => {
  it('no secret configured is 401 and nothing is read', async () => {
    h.env.CRON_SECRET = undefined;
    adminWith({});
    const res = await GET(request('Bearer undefined'));
    expect(res.status).toBe(401);
    expect(h.adminMade).toBe(0);
  });

  it.each([
    ['no header', undefined],
    ['a wrong secret', 'Bearer test-cron-secreT'],
    ['a shorter one', 'Bearer test'],
    ['the secret without Bearer', 'test-cron-secret'],
  ])('%s is 401 and nothing is read', async (_n, auth) => {
    adminWith({});
    const res = await GET(request(auth));
    expect(res.status).toBe(401);
    expect(h.adminMade).toBe(0);
    expect(h.log).toEqual([]);
  });
});

describe('claim, then send, then confirm', () => {
  it('in that order, to each owner and admin named, with the register link', async () => {
    const stub = adminWith({ due: pages([dueRow(1)]) });
    const res = await run();
    expect(res.status).toBe(200);
    expect(h.log).toEqual(['due', 'claim', `notify:${OWNER}`, `notify:${ADMIN}`, 'confirm']);
    expect(h.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        type: 'supplier_risk.review_due',
        title: 'Vendor review due',
        link: '/dashboard/suppliers/risk',
      }),
    );
    const claim = stub.rpcCalls.find((c) => c.name === 'supplier_risk_reminder_claim');
    expect(claim?.args).toEqual({ p_review_id: dueRow(1).review_id, p_kind: 'due' });
    expect(await res.json()).toMatchObject({
      ok: true,
      remindersSent: 1,
      confirmed: 1,
      stoppedBy: 'last_page',
    });
  });

  it('a claim another run won (false) sends nothing', async () => {
    adminWith({ due: pages([dueRow(1)]), claim: { data: false, error: null } });
    const res = await run();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.log).not.toContain('confirm');
    expect(await res.json()).toMatchObject({ claimsLost: 1, remindersSent: 0 });
  });

  it('a claim that raised (55P03) sends nothing and the run goes on to the next row', async () => {
    let n = 0;
    adminWith({
      due: pages([dueRow(1), dueRow(2)]),
      claim: () =>
        n++ === 0
          ? { data: null, error: { message: 'lock', code: '55P03' } }
          : { data: true, error: null },
    });
    const res = await run();
    expect(h.log).toEqual([
      'due',
      'claim',
      'claim',
      `notify:${OWNER}`,
      `notify:${ADMIN}`,
      'confirm',
    ]);
    expect(await res.json()).toMatchObject({ claimsFailed: 1, remindersSent: 1 });
  });

  it('a due soon reminder is sent and never confirmed (nothing to confirm)', async () => {
    adminWith({ due: pages([dueRow(1, { kind: 'due_soon', next_review_on: '2026-12-24' })]) });
    await run();
    expect(h.log).toEqual(['due', 'claim', `notify:${OWNER}`, `notify:${ADMIN}`]);
    expect(h.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Vendor review due soon',
        body: 'The vendor review of Example Supply Co 1 is due on December 24, 2026. Open the risk register to review it.',
      }),
    );
  });

  it('each person once, even when the database named them twice', async () => {
    adminWith({ due: pages([dueRow(1, { admin_user_ids: [OWNER, OWNER] })]) });
    await run();
    expect(h.notify).toHaveBeenCalledTimes(1);
  });
});

describe('a send that failed, and a confirmation that failed', () => {
  it('a reminder that reached nobody is not confirmed (the database offers it again)', async () => {
    h.notify.mockImplementation(async () => null);
    adminWith({ due: pages([dueRow(1)]) });
    const res = await run();
    expect(h.log).not.toContain('confirm');
    expect(await res.json()).toMatchObject({ reachedNobody: 1, remindersSent: 0, confirmed: 0 });
  });

  it('a reminder that reached one of two is sent and confirmed', async () => {
    h.notify.mockImplementationOnce(async () => null);
    adminWith({ due: pages([dueRow(1)]) });
    const res = await run();
    expect(await res.json()).toMatchObject({ remindersSent: 1, confirmed: 1 });
  });

  it('a failed confirmation is tried again; the send is never repeated', async () => {
    let n = 0;
    adminWith({
      due: pages([dueRow(1)]),
      confirm: () =>
        n++ < 2
          ? { data: null, error: { message: 'x', code: '57014' } }
          : { data: true, error: null },
    });
    const res = await run();
    expect(h.log).toEqual([
      'due',
      'claim',
      `notify:${OWNER}`,
      `notify:${ADMIN}`,
      'confirm',
      'confirm',
      'confirm',
    ]);
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect(await res.json()).toMatchObject({ confirmed: 1, notConfirmed: 0 });
  });

  it('a confirmation that throws is tried again too', async () => {
    let n = 0;
    adminWith({
      due: pages([dueRow(1)]),
      confirm: () => {
        if (n++ === 0) throw new Error('network');
        return { data: true, error: null };
      },
    });
    const res = await run();
    expect(h.log.filter((l) => l === 'confirm')).toHaveLength(2);
    expect(await res.json()).toMatchObject({ confirmed: 1 });
  });

  it('a confirmation that never gets through is reported, three tries, one send', async () => {
    adminWith({
      due: pages([dueRow(1)]),
      confirm: { data: null, error: { message: 'x', code: '57014' } },
    });
    const res = await run();
    expect(h.log.filter((l) => l === 'confirm')).toHaveLength(3);
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect(await res.json()).toMatchObject({ confirmed: 0, notConfirmed: 1 });
    expect(h.report).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'cron.supplier-risk-reminders.confirm' }),
    );
  });

  it('a row that throws is caught and the next row is sent', async () => {
    h.notify.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    adminWith({
      due: pages([dueRow(1, { admin_user_ids: [OWNER] }), dueRow(2, { admin_user_ids: [ADMIN] })]),
    });
    const res = await run();
    expect(res.status).toBe(200);
    expect(h.log).toEqual([
      'due',
      'claim',
      `notify:${OWNER}`,
      'claim',
      `notify:${ADMIN}`,
      'confirm',
    ]);
  });
});

describe('two overlapping runs send each reminder once', () => {
  it('the claim decides: only the run whose claim answered true sends', async () => {
    const claimed = new Set<string>();
    const rows = [dueRow(1), dueRow(2)];
    adminWith({
      // Both runs read the same rows before either claims.
      due: (() => {
        const served = new Map<number, number>();
        let call = 0;
        return () => {
          const runNo = call++ < 1 ? 0 : 1;
          const k = served.get(runNo) ?? 0;
          served.set(runNo, k + 1);
          return { data: k === 0 ? rows : [], error: null };
        };
      })(),
      claim: (call) => {
        const id = (call.args[0]?.[0] as { p_review_id: string }).p_review_id;
        if (claimed.has(id)) return { data: false, error: null };
        claimed.add(id);
        return { data: true, error: null };
      },
    });
    const [a, b] = await Promise.all([run(), run()]);
    const ja = (await a.json()) as { remindersSent: number; claimsLost: number };
    const jb = (await b.json()) as { remindersSent: number; claimsLost: number };
    expect(ja.remindersSent + jb.remindersSent).toBe(2);
    expect(ja.claimsLost + jb.claimsLost).toBe(2);
    // Two reviews, two people each: four notices, never eight.
    expect(h.notify).toHaveBeenCalledTimes(4);
  });
});

describe('the Suppliers module, per organization', () => {
  it('a row of an organization with the module off is never claimed or sent', async () => {
    adminWith({ due: pages([dueRow(1, { organization_id: ORG_OFF }), dueRow(2)]) });
    const res = await run();
    expect(h.log).toEqual(['due', 'claim', `notify:${OWNER}`, `notify:${ADMIN}`, 'confirm']);
    expect(await res.json()).toMatchObject({ moduleOff: 1, remindersSent: 1 });
  });

  it('a module read that failed claims and sends nothing (500)', async () => {
    adminWith({
      due: pages([dueRow(1)]),
      enabled: { data: null, error: { message: 'x', code: '57014' } },
    });
    const res = await run();
    expect(res.status).toBe(500);
    expect(h.log).toEqual([]);
  });
});

describe('the loop', () => {
  it('a due read that failed (or a missing function) is 500 and nothing is claimed', async () => {
    for (const code of ['PGRST202', '57014']) {
      h.log = [];
      adminWith({ due: { data: null, error: { message: 'x', code } } });
      const res = await run();
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ ok: false, stoppedBy: 'read_failed' });
      expect(h.log).toEqual(['due']);
    }
  });

  it('stops at its own deadline: the rows after it are not claimed', async () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    h.notify.mockImplementation(async () => {
      now += 241_000;
      return 'notice-id';
    });
    adminWith({
      due: pages([dueRow(1, { kind: 'due_soon', admin_user_ids: [OWNER] }), dueRow(2)]),
    });
    const res = await run();
    expect(h.log).toEqual(['due', 'claim', `notify:${OWNER}`]);
    expect(await res.json()).toMatchObject({ stoppedBy: 'deadline', remindersSent: 1 });
  });

  it('at most 20 reads in one run', async () => {
    let page = 0;
    const stub = adminWith({
      due: (call) => {
        const limit = (call.args[0]?.[0] as { p_limit: number }).p_limit;
        const base = page++ * limit;
        return {
          data: Array.from({ length: limit }, (_, i) =>
            dueRow(base + i + 1, { organization_id: ORG_OFF }),
          ),
          error: null,
        };
      },
    });
    const res = await run();
    expect(stub.rpcCalls.filter((c) => c.name === 'supplier_risk_reminders_due')).toHaveLength(20);
    expect(await res.json()).toMatchObject({ stoppedBy: 'pages' });
  });

  it('a full read with nothing new is asked once more at 500 rows, which finds the rest', async () => {
    const off = Array.from({ length: 100 }, (_, i) => dueRow(i + 1, { organization_id: ORG_OFF }));
    const stub = adminWith({
      due: (call) => {
        const limit = (call.args[0]?.[0] as { p_limit: number }).p_limit;
        return { data: limit === 500 ? [...off, dueRow(500)] : off, error: null };
      },
    });
    const res = await run();
    expect(
      stub.rpcCalls
        .filter((c) => c.name === 'supplier_risk_reminders_due')
        .map((c) => (c.args as { p_limit: number }).p_limit),
    ).toEqual([100, 100, 500]);
    expect(await res.json()).toMatchObject({
      remindersSent: 1,
      moduleOff: 100,
      stoppedBy: 'last_page',
    });
  });

  it('nothing new even at 500 rows stops the run (no endless loop)', async () => {
    const off = Array.from({ length: 100 }, (_, i) => dueRow(i + 1, { organization_id: ORG_OFF }));
    const stub = adminWith({ due: { data: off, error: null } });
    const res = await run();
    expect(stub.rpcCalls.filter((c) => c.name === 'supplier_risk_reminders_due')).toHaveLength(3);
    expect(await res.json()).toMatchObject({ stoppedBy: 'nothing_new' });
    expect(h.log).not.toContain('claim');
  });

  it('an empty read ends the run', async () => {
    adminWith({ due: { data: [], error: null } });
    const res = await run();
    expect(await res.json()).toMatchObject({ ok: true, stoppedBy: 'empty' });
  });
});
