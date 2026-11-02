import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PO_BILL_TO_WAIT_MS, poBillToLine, readPoBillToCharter } from './po-bill-to';

/**
 * B56: the phone's PO screen names the charter a purchase order is billed to
 * (purchase_orders.charter_id), as the web page and the PDF do. The read is a
 * label: the organization's charter by id at any status, bounded, and it never
 * rejects, so a failed or hung charter read can never hold or fail the
 * receiving screen. The line names only the charter of the PO on screen.
 */

const ORG = 'org-a';
const C = '0b000000-0000-4000-8000-0000000000c1';
const D = '0b000000-0000-4000-8000-0000000000d1';

type Answer = { data: unknown; error: { message: string } | null };

/** A structural client that records the chain and answers maybeSingle(). */
function fakeClient(answer: () => PromiseLike<Answer>) {
  const calls: [string, unknown[]][] = [];
  const chain = {
    select(...args: unknown[]) {
      calls.push(['select', args]);
      return chain;
    },
    eq(...args: unknown[]) {
      calls.push(['eq', args]);
      return chain;
    },
    maybeSingle() {
      calls.push(['maybeSingle', []]);
      return answer();
    },
  };
  const from = vi.fn((table: string) => {
    calls.push(['from', [table]]);
    return chain;
  });
  return { client: { from }, from, calls };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  vi.useRealTimers();
});

describe('readPoBillToCharter', () => {
  it('answers none, and reads nothing, for a purchase order billed to no charter', async () => {
    const fake = fakeClient(async () => ({ data: null, error: null }));
    await expect(readPoBillToCharter(fake.client, ORG, null)).resolves.toEqual({ state: 'none' });
    expect(fake.from).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads the organization's charter by id, at any status, as a plain read", async () => {
    const row = { id: C, name: 'North Campus', code: 'NC', status: 'archived' };
    const fake = fakeClient(async () => ({ data: row, error: null }));
    await expect(readPoBillToCharter(fake.client, ORG, C)).resolves.toEqual({
      state: 'found',
      charter: row,
    });
    expect(fake.calls).toEqual([
      ['from', ['charters']],
      ['select', ['id, name, code, status']],
      ['eq', ['organization_id', ORG]],
      ['eq', ['id', C]],
      ['maybeSingle', []],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each<[string, () => PromiseLike<Answer>]>([
    ['an error', async () => ({ data: null, error: { message: 'permission denied' } })],
    ['no row', async () => ({ data: null, error: null })],
    [
      'a row for another charter',
      async () => ({ data: { id: D, name: 'X', code: null, status: 'active' }, error: null }),
    ],
    ['a rejection', () => Promise.reject(new Error('Network request failed'))],
  ])('%s is unreadable, warned once, never a rejection', async (_why, answer) => {
    const fake = fakeClient(answer);
    await expect(readPoBillToCharter(fake.client, ORG, C)).resolves.toEqual({
      state: 'unreadable',
      charterId: C,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toBe('[po] bill-to charter read failed');
  });

  it('a client that throws is unreadable, warned once', async () => {
    const client = {
      from: () => {
        throw new Error('no client');
      },
    };
    await expect(readPoBillToCharter(client, ORG, C)).resolves.toEqual({
      state: 'unreadable',
      charterId: C,
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a read that never answers gives up at the bound: unreadable, warned once', async () => {
    vi.useFakeTimers();
    expect(PO_BILL_TO_WAIT_MS).toBe(8_000);
    const fake = fakeClient(() => new Promise<Answer>(() => {}));
    let settled: unknown = 'pending';
    void readPoBillToCharter(fake.client, ORG, C).then((v) => {
      settled = v;
    });
    await vi.advanceTimersByTimeAsync(PO_BILL_TO_WAIT_MS - 1);
    expect(settled).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ state: 'unreadable', charterId: C });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a late answer after the bound is not warned again', async () => {
    vi.useFakeTimers();
    let answerLate: (a: Answer) => void = () => {};
    const fake = fakeClient(
      () =>
        new Promise<Answer>((resolve) => {
          answerLate = resolve;
        }),
    );
    const read = readPoBillToCharter(fake.client, ORG, C, 50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(read).resolves.toEqual({ state: 'unreadable', charterId: C });
    answerLate({ data: null, error: { message: 'late' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('poBillToLine', () => {
  const found = (over: Record<string, unknown> = {}) => ({
    state: 'found' as const,
    charter: { id: C, name: 'North Campus', code: 'NC', status: 'active', ...over },
  });

  it('names the charter with the PDF line and the status mark', () => {
    expect(poBillToLine(C, found())).toBe('Bill to: North Campus (NC)');
    expect(poBillToLine(C, found({ status: 'archived' }))).toBe(
      'Bill to: North Campus (NC) (archived)',
    );
    expect(poBillToLine(C, found({ name: 'South Campus', code: null, status: 'inactive' }))).toBe(
      'Bill to: South Campus (inactive)',
    );
  });

  it('says a read that failed', () => {
    expect(poBillToLine(C, { state: 'unreadable', charterId: C })).toBe(
      'Bill to: Could not be loaded',
    );
  });

  it('shows nothing for a purchase order billed to no charter, or with no read', () => {
    expect(poBillToLine(null, found())).toBeNull();
    expect(poBillToLine(null, { state: 'unreadable', charterId: C })).toBeNull();
    expect(poBillToLine(C, { state: 'none' })).toBeNull();
  });

  it("never names another purchase order's charter (a read for another id)", () => {
    expect(poBillToLine(D, found())).toBeNull();
    expect(poBillToLine(D, { state: 'unreadable', charterId: C })).toBeNull();
  });
});
