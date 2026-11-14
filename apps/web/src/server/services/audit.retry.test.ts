import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An audit row whose write is not answered is sent again, with the id chosen
 * before the first try, so a try that landed late is never written twice.
 *
 * Every writer (audit, insertAuditRowReported, auditMany) shapes its rows in
 * one place: each row gets an id there (never the caller's), and an address
 * the inet column takes. The first try is the INSERT it always was, and the
 * caller waits for it alone (at most AUDIT_INSERT_TIMEOUT_MS). A try that was
 * not written, unless the database refused the row itself, is sent again after
 * the response, at most twice, as "insert, skip a row with this id that is
 * already there", with the time of the event on every row. The alerts say so
 * twice: at the first try that was not written ("sending it again") and when
 * the tries end ("written on try N", or "never written"), with the event, the
 * row id, the account and the tries in the message text itself, which is all a
 * chat channel shows. Both are held with the write, and so is the wait for the
 * organization's count report when they were folded into one.
 *
 * Here the delays are exact: Math.random is 0.5, so a delay is its nominal
 * value (1 s, then 3 s).
 */

const h = vi.hoisted(() => ({
  insert: vi.fn(),
  upsert: vi.fn(),
  reportError: vi.fn(),
  withContext: vi.fn(),
  after: vi.fn(),
  headerValues: null as Record<string, string> | null,
}));

vi.mock('next/server', () => ({ after: h.after }));
vi.mock('next/headers', () => ({
  headers: async () => {
    const values: Record<string, string> = h.headerValues ?? {
      'x-forwarded-for': '203.0.113.7',
      'user-agent': 'lab-agent/1.0',
    };
    return { get: (k: string) => values[k] ?? null };
  },
}));

/** A lazy, thenable builder like postgrest's, carrying an optional abort signal. */
function builder(answer: (signal: AbortSignal | undefined) => unknown) {
  let signal: AbortSignal | undefined;
  const b = {
    abortSignal(s: AbortSignal) {
      signal = s;
      return b;
    },
    then(onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) {
      return Promise.resolve()
        .then(() => answer(signal))
        .then(onOk, onErr);
    },
  };
  return b;
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      insert: (rows: unknown) => builder((signal) => h.insert(rows, signal, table)),
      upsert: (rows: unknown, options: unknown) =>
        builder((signal) => h.upsert(rows, options, signal, table)),
    }),
  }),
}));
vi.mock('@/lib/error-reporter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/error-reporter')>()),
  reportError: h.reportError,
}));
vi.mock('./context', () => ({ withContext: h.withContext }));
// src/test/setup.ts stubs this module for every other test; this file tests
// the real one.
vi.unmock('@/server/services/audit');

import {
  audit,
  AUDIT_INSERT_TIMEOUT_MS,
  AUDIT_LOSS_REPORT_WINDOW_MS,
  AUDIT_RETRY_DELAYS_MS,
  AUDIT_RETRY_SLOTS,
  AUDIT_WRITE_TRIES,
  auditMany,
  insertAuditRowReported,
  resetAuditLossReportsForTests,
  type AuditPayload,
} from './audit';
import type { ServiceContext } from './context';

const ORG = '0a800000-0000-4000-8000-0000000000a1';
const USER = '0a800000-0000-4000-8000-0000000000b1';
const ctx = { organizationId: ORG, userId: USER } as unknown as ServiceContext;
const SENSITIVE = 'Item name that must never reach a report';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function payload(i: number): AuditPayload {
  return {
    event: 'inventory.item.updated',
    entityType: 'inventory_item',
    entityId: `item-${i}`,
    before: { bin_location: SENSITIVE },
    after: { bin_location: '947-Q' },
  };
}

const signIn = {
  organization_id: null,
  user_id: USER,
  event: 'user.sign_in_failed' as const,
  ip: '203.0.113.7',
  user_agent: 'lab-agent/1.0',
  metadata: { entity_type: 'user', entity_id: USER, attempted_email: SENSITIVE },
};

const ok = { error: null, status: 201, statusText: 'Created' };
const badGateway = { error: { message: '', code: '' }, status: 502, statusText: 'Bad Gateway' };
const refused = (code: string) => ({
  error: { message: `Failing row contains (${SENSITIVE})`, code },
  status: 400,
  statusText: 'Bad Request',
});
const never = () => new Promise(() => {});

type Row = Record<string, unknown> & { id?: string; created_at?: string };
const insertedRows = (call = 0): Row[] => {
  const rows = h.insert.mock.calls[call]![0] as Row | Row[];
  return Array.isArray(rows) ? rows : [rows];
};
const upsertedRows = (call = 0): Row[] => {
  const rows = h.upsert.mock.calls[call]![0] as Row | Row[];
  return Array.isArray(rows) ? rows : [rows];
};
/** The text of the n-th report: what a chat channel shows. */
const reportText = (n: number) => (h.reportError.mock.calls[n]![0] as Error).message;
const reportExtra = (n: number) =>
  (h.reportError.mock.calls[n]![1] as { extra: Record<string, unknown> }).extra;
/** The promise the writer handed to after(): everything the write still does. */
const held = () => h.after.mock.calls[0]![0] as Promise<unknown>;

function watch(p: Promise<unknown>) {
  const state = { settled: false };
  void p.then(() => {
    state.settled = true;
  });
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  h.insert.mockReset();
  h.upsert.mockReset();
  h.reportError.mockReset();
  h.reportError.mockResolvedValue(undefined);
  h.withContext.mockReset();
  h.after.mockReset();
  h.headerValues = null;
  vi.stubEnv('VERCEL', '1');
  resetAuditLossReportsForTests();
});

afterEach(() => {
  resetAuditLossReportsForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('the rows as sent', () => {
  it('every row of a batch has its own id, chosen before the first try', async () => {
    h.insert.mockResolvedValue(ok);
    await auditMany(
      Array.from({ length: 150 }, (_, i) => payload(i)),
      ctx,
    );
    const ids = [...insertedRows(0), ...insertedRows(1)].map((r) => r.id);
    expect(ids).toHaveLength(150);
    expect(ids.every((id) => typeof id === 'string' && UUID.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(150);
  });

  it("an id on the caller's row is not used", async () => {
    h.insert.mockResolvedValue(ok);
    const chosen = '0a800000-0000-4000-8000-00000000c0de';
    await insertAuditRowReported({ ...signIn, id: chosen } as typeof signIn);
    const [row] = insertedRows();
    expect(row!.id).toMatch(UUID);
    expect(row!.id).not.toBe(chosen);
  });

  it('the first try leaves the time to the database', async () => {
    h.insert.mockResolvedValue(ok);
    await audit(payload(1), ctx);
    expect(insertedRows()[0]).not.toHaveProperty('created_at');
  });

  it.each([['not-an-address'], ['fe80::1%eth0'], ['unknown']])(
    'an address that is not an IP literal (%s) is stored as none',
    async (ip) => {
      h.insert.mockResolvedValue(ok);
      await insertAuditRowReported({ ...signIn, ip });
      expect(insertedRows()[0]).toMatchObject({ ip: null });
    },
  );

  it('an IP literal is kept as it is', async () => {
    h.insert.mockResolvedValue(ok);
    await insertAuditRowReported({ ...signIn, ip: '2001:db8::5' });
    expect(insertedRows()[0]).toMatchObject({ ip: '2001:db8::5' });
  });
});

describe('a write answered in time', () => {
  it('sends one request, no later try and no report', async () => {
    h.insert.mockResolvedValue(ok);
    await audit(payload(1), ctx);
    await vi.runAllTimersAsync();
    expect(h.insert).toHaveBeenCalledTimes(1);
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.reportError).not.toHaveBeenCalled();
  });
});

describe('a row whose first try was not written', () => {
  it('is sent again after the delay, and the outcome says it was written on try 2', async () => {
    h.insert.mockResolvedValue(badGateway);
    h.upsert.mockResolvedValue(ok);
    await audit(payload(1), ctx);
    const rowId = insertedRows()[0]!.id!;

    // At once: the alert that it is being sent again.
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(reportExtra(0)).toMatchObject({ outcome: 'sending_again', rowIds: rowId, tries: 1 });
    expect(h.upsert).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(AUDIT_RETRY_DELAYS_MS[0]);
    expect(h.upsert).toHaveBeenCalledTimes(1);

    // The outcome is folded into the organization's open window and sent with it.
    await vi.advanceTimersByTimeAsync(AUDIT_LOSS_REPORT_WINDOW_MS);
    expect(h.reportError).toHaveBeenCalledTimes(2);
    expect(reportExtra(1)).toMatchObject({ writtenLate: 1, lost: 0 });
    expect(reportText(1)).toContain(rowId);
    expect(reportText(1)).toContain('written on a later try');
    expect(h.insert).toHaveBeenCalledTimes(1);
    expect(h.upsert).toHaveBeenCalledTimes(1);
  });

  it('the later try carries the id of the first and asks the database to skip a row already there', async () => {
    h.insert.mockResolvedValue(badGateway);
    h.upsert.mockResolvedValue(ok);
    await insertAuditRowReported(signIn);
    await vi.advanceTimersByTimeAsync(AUDIT_RETRY_DELAYS_MS[0]);

    const [first] = insertedRows();
    const [again] = upsertedRows();
    expect(again!.id).toBe(first!.id);
    expect(h.upsert.mock.calls[0]![1]).toEqual({ onConflict: 'id', ignoreDuplicates: true });
    // Everything else is the row the first try sent.
    const { created_at: _t, ...rest } = again!;
    expect(rest).toEqual(first);
  });

  it('the later try carries the time of the event, not the time it is sent', async () => {
    vi.setSystemTime(new Date('2026-11-14T10:00:00.000Z'));
    h.insert.mockResolvedValue(badGateway);
    h.upsert.mockResolvedValue(ok);
    await audit(payload(1), ctx);
    await vi.advanceTimersByTimeAsync(AUDIT_RETRY_DELAYS_MS[0]);
    expect(upsertedRows()[0]!.created_at).toBe('2026-11-14T10:00:00.000Z');
  });

  it('the caller waits for the first try only; the later tries are held with the write', async () => {
    h.insert.mockImplementation(never);
    h.upsert.mockImplementation(never);
    const returned = watch(audit(payload(1), ctx));
    const all = watch(held());

    await vi.advanceTimersByTimeAsync(AUDIT_INSERT_TIMEOUT_MS);
    expect(returned.settled).toBe(true);
    expect(all.settled).toBe(false);

    // Try 2 at 5 s + 1 s, try 3 at 11 s + 3 s, each with its own deadline.
    await vi.advanceTimersByTimeAsync(AUDIT_RETRY_DELAYS_MS[0] + AUDIT_INSERT_TIMEOUT_MS);
    expect(h.upsert).toHaveBeenCalledTimes(1);
    expect(all.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(AUDIT_RETRY_DELAYS_MS[1] + AUDIT_INSERT_TIMEOUT_MS);
    expect(h.upsert).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(all.settled).toBe(true);
    expect(AUDIT_WRITE_TRIES).toBe(3);
  });

  it('a row no try could write: sending again at once, then never written after 3 tries, with the ids in the text and never the row', async () => {
    h.insert.mockImplementation(never);
    h.upsert.mockImplementation(never);
    void audit(payload(1), ctx);
    await vi.advanceTimersByTimeAsync(AUDIT_INSERT_TIMEOUT_MS);
    const rowId = insertedRows()[0]!.id!;

    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(reportText(0)).toContain('inventory.item.updated');
    expect(reportText(0)).toContain(rowId);
    expect(reportText(0)).toContain(USER);
    expect(reportText(0)).toMatch(/try 1 of 3/);
    expect(reportText(0)).toMatch(/sending it again/);

    await vi.runAllTimersAsync();
    expect(h.upsert).toHaveBeenCalledTimes(2);
    expect(h.reportError).toHaveBeenCalledTimes(2);
    expect(reportExtra(1)).toMatchObject({
      outcome: 'not_written',
      event: 'inventory.item.updated',
      userId: USER,
      rowIds: rowId,
      tries: 3,
      lost: 1,
      timedOut: true,
    });
    expect(reportText(1)).toMatch(/never written after 3 tries/);
    expect(reportText(1)).toContain(rowId);
    expect(reportText(1)).toContain(USER);
    expect(JSON.stringify(h.reportError.mock.calls)).not.toContain(SENSITIVE);
  });

  it('a 401 is sent again (a credential changing), and so is a thrown fetch', async () => {
    h.insert
      .mockResolvedValueOnce({ error: { message: 'JWT', code: 'PGRST301' }, status: 401 })
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    h.upsert.mockResolvedValue(ok);
    await insertAuditRowReported(signIn);
    await insertAuditRowReported(signIn);
    await vi.advanceTimersByTimeAsync(AUDIT_RETRY_DELAYS_MS[0]);
    expect(h.upsert).toHaveBeenCalledTimes(2);
  });

  it('a later try the database refuses is not tried again, and is reported never written', async () => {
    h.insert.mockResolvedValue(badGateway);
    // The account was deleted in between (user_id references user_profiles).
    h.upsert.mockResolvedValue(refused('23503'));
    void insertAuditRowReported(signIn);
    await vi.runAllTimersAsync();
    expect(h.upsert).toHaveBeenCalledTimes(1);
    // The outcome is folded into the window the first alert opened (that
    // alert went out at once, so the window counts only the outcome).
    expect(h.reportError).toHaveBeenCalledTimes(2);
    expect(reportExtra(0)).toMatchObject({ outcome: 'sending_again', status: 502 });
    expect(reportExtra(1)).toMatchObject({ sentAgain: 0, writtenLate: 0, lost: 1, total: 0 });
    expect(reportText(1)).toContain(insertedRows()[0]!.id!);
    expect(JSON.stringify(h.reportError.mock.calls)).not.toContain(SENSITIVE);
  });

  it('outside a request (after() throws) the later tries still run and settle', async () => {
    h.after.mockImplementation(() => {
      throw new Error('`after` was called outside a request scope.');
    });
    h.insert.mockResolvedValue(badGateway);
    h.upsert.mockResolvedValue(ok);
    await audit(payload(1), ctx);
    await vi.advanceTimersByTimeAsync(AUDIT_RETRY_DELAYS_MS[0]);
    expect(h.upsert).toHaveBeenCalledTimes(1);
  });
});

describe('a row the database refused', () => {
  it('is not sent again, and is reported at once', async () => {
    h.insert.mockResolvedValue(refused('23502'));
    await expect(insertAuditRowReported(signIn)).resolves.toBe(false);
    await vi.runAllTimersAsync();
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(reportExtra(0)).toMatchObject({
      outcome: 'not_written',
      lost: 1,
      tries: 1,
      code: '23502',
    });
    expect(reportText(0)).toContain(insertedRows()[0]!.id!);
    expect(JSON.stringify(h.reportError.mock.calls)).not.toContain(SENSITIVE);
  });
});

describe('auditMany', () => {
  it('sends an unanswered chunk again with the same ids and the event time on every row, and reports only the rows no try wrote', async () => {
    let n = 0;
    h.insert.mockImplementation(async () => {
      n += 1;
      // Chunk 2 of 3 is not answered; chunk 3 is refused for good.
      if (n === 2) return badGateway;
      if (n === 3) return refused('23514');
      return ok;
    });
    h.upsert.mockResolvedValue(ok);
    const res = await auditMany(
      Array.from({ length: 250 }, (_, i) => payload(i)),
      ctx,
    );
    // The counts still mean "after the first try".
    expect(res).toEqual({ written: 100, lost: 150 });

    await vi.advanceTimersByTimeAsync(AUDIT_RETRY_DELAYS_MS[0]);
    expect(h.upsert).toHaveBeenCalledTimes(1);
    const again = upsertedRows();
    expect(again.map((r) => r.id)).toEqual(insertedRows(1).map((r) => r.id));
    expect(again.every((r) => typeof r.id === 'string' && typeof r.created_at === 'string')).toBe(
      true,
    );

    await vi.runAllTimersAsync();
    // First: the refused chunk (50 rows, not sent again) and the 100 being sent again.
    const extras = h.reportError.mock.calls.map(([, r]) => r.extra as Record<string, unknown>);
    expect(extras[0]).toMatchObject({
      outcome: 'not_written',
      lost: 50,
      total: 250,
      code: '23514',
    });
    // The rest comes with the window: 100 sent again, then written on a later try.
    expect(extras.at(-1)).toMatchObject({ sentAgain: 100, writtenLate: 100 });
    expect(JSON.stringify(h.reportError.mock.calls)).not.toContain(SENSITIVE);
  });
});

describe('at most AUDIT_RETRY_SLOTS writes in their later tries at once on one instance', () => {
  it('the 21st unanswered write is reported at once and not sent again', async () => {
    expect(AUDIT_RETRY_SLOTS).toBe(20);
    h.insert.mockResolvedValue(badGateway);
    h.upsert.mockImplementation(never);
    for (let i = 0; i < 21; i += 1) await audit(payload(i), ctx);
    const twentyFirst = insertedRows(20)[0]!.id!;
    await vi.runAllTimersAsync();
    // 20 writes, two later tries each; none for the 21st.
    expect(h.upsert).toHaveBeenCalledTimes(40);
    expect(h.upsert.mock.calls.some(([rows]) => (rows as Row).id === twentyFirst)).toBe(false);
  });

  it('a slot is freed when its tries end', async () => {
    h.insert.mockResolvedValue(badGateway);
    h.upsert.mockResolvedValue(ok);
    for (let i = 0; i < 20; i += 1) await audit(payload(i), ctx);
    await vi.runAllTimersAsync();
    expect(h.upsert).toHaveBeenCalledTimes(20);

    await audit(payload(99), ctx);
    await vi.runAllTimersAsync();
    expect(h.upsert).toHaveBeenCalledTimes(21);
  });
});

describe('the write is held until its reports are sent', () => {
  it('a report folded into the open window holds the write until that window is sent', async () => {
    h.insert.mockResolvedValue(badGateway);
    h.upsert.mockResolvedValue(ok);
    await audit(payload(1), ctx);
    const first = watch(held());
    h.after.mockClear();
    // A second write, while the window the first opened is still open.
    await audit(payload(2), ctx);
    const second = watch(held());

    await vi.advanceTimersByTimeAsync(AUDIT_RETRY_DELAYS_MS[0]);
    // Both rows written on try 2, both outcomes waiting for the window.
    expect(h.upsert).toHaveBeenCalledTimes(2);
    expect(first.settled).toBe(false);
    expect(second.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(AUDIT_LOSS_REPORT_WINDOW_MS);
    expect(first.settled).toBe(true);
    expect(second.settled).toBe(true);
  });

  it('the report itself is awaited: the write settles only once the alert has been sent', async () => {
    let sent!: () => void;
    h.insert.mockResolvedValue(refused('23502'));
    h.reportError.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        sent = resolve;
      }),
    );
    await insertAuditRowReported(signIn);
    const all = watch(held());
    await vi.advanceTimersByTimeAsync(0);
    expect(all.settled).toBe(false);
    sent();
    await vi.advanceTimersByTimeAsync(0);
    expect(all.settled).toBe(true);
  });

  it('the count report of a window names the rows, up to ten', async () => {
    h.insert.mockResolvedValue(refused('23502'));
    for (let i = 0; i < 14; i += 1) await audit(payload(i), ctx);
    await vi.advanceTimersByTimeAsync(AUDIT_LOSS_REPORT_WINDOW_MS);
    expect(h.reportError).toHaveBeenCalledTimes(2);
    const ids = String(reportExtra(1).rowIds).split(',');
    expect(ids).toHaveLength(10);
    expect(ids[0]).toBe(insertedRows(1)[0]!.id);
    for (const id of ids) expect(reportText(1)).toContain(id);
    expect(reportExtra(1)).toMatchObject({ lost: 13, total: 13 });
  });
});
