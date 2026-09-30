import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  confirmationFactsRow,
  confirmCountDialogCopy,
  countConfirmationFor,
  describeTimelineEvent,
  EXCEPTION_CONFIRM_OFFLINE_COPY,
  occurrenceStateLabel,
  resolvedReasonCopy,
  VERIFICATION_SESSION_ENDED_COPY,
  type CountConfirmBlock,
} from '@stockpilot/core';

import { CONNECTION_FAILURE_COPY } from './connection-copy';
import { countVarianceView, displayedStateOf } from './exception-confirm-view';
import {
  confirmExceptionCount,
  describeConfirmCountError,
  exceptionSheetSubmit,
  getException,
  listExceptions,
  parseCountConfirm,
  type MobileExceptionDetail,
} from './exceptions-api';

/**
 * THE PHONE AGAINST THE R2 SERVER (count differences, migration 0386).
 *
 * The phone shipped its Confirm this count code in R1, dormant, and gets no
 * second release: R2 only turns the server on. So the phone's parser, view,
 * sheet gate and error words must read EXACTLY what the R2 server sends. This
 * file feeds the server's real answers through the phone's real code:
 *
 *   - ./__fixtures__/exception-confirm-server-0386.json holds the answers the
 *     R2 server (feat/exc-confirm-r2 at 6d7fb80c, migration 0386) gave on the
 *     phone's Bearer routes on the local stack, captured by
 *     stockpilot-work/exceptions-confirm/phone-contract/capture-0386*.sh: the
 *     count differences were raised by the real sync, the recount started
 *     through the real route, every refusal came from the real RPC. Only the
 *     uuids are replaced (stable placeholders); every key, type, null, number
 *     and sentence is as the server sent it.
 *   - Each answer goes through the REAL api() (only fetch, the session and
 *     the device storage are stubbed), so the status, the `error` code and
 *     `details` reach the phone exactly as they would on a device.
 */

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).__DEV__ = true;
});
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('./supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: 't', user: { id: 'u1' } } } })) },
  },
}));
vi.mock('./account-eviction', () => ({ notifyUnauthorized: vi.fn() }));
vi.mock('./request-cancellation', () => ({ registerInFlight: vi.fn(() => vi.fn()) }));

interface Answer {
  status: number;
  retryAfter: string | null;
  body: unknown;
}
interface Fixture {
  meta: {
    ids: { cycleCount: string; staff: string; manager: string; occurrences: Record<string, string> };
    requests: Record<string, { occurrence: string; body: Record<string, unknown> }>;
  };
  answers: Record<string, Answer>;
}

const FIXTURE = JSON.parse(
  readFileSync(path.resolve(__dirname, '__fixtures__/exception-confirm-server-0386.json'), 'utf8'),
) as Fixture;
const A = FIXTURE.answers;
const IDS = FIXTURE.meta.ids;
const OCC = IDS.occurrences;

function answer(name: string): Answer {
  const a = A[name];
  expect(a, name).toBeDefined();
  return a!;
}

/** The body of a captured answer, as an object. */
function body(name: string): Record<string, unknown> {
  return answer(name).body as Record<string, unknown>;
}

/** The server's countConfirm block in a captured detail. */
function serverBlock(name: string): Record<string, unknown> {
  return body(name).countConfirm as Record<string, unknown>;
}

// ── fetch, answered with the captured HTTP answers ──────────────────────────

type Sent = { url: string; method: string; body: unknown };
const sent: Sent[] = [];
const queue: (Answer | Error)[] = [];

function respond(a: Answer) {
  const text = a.body === null || a.body === undefined ? '' : JSON.stringify(a.body);
  return {
    ok: a.status >= 200 && a.status < 300,
    status: a.status,
    headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? a.retryAfter : null) },
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  };
}

const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
  sent.push({ url, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(init.body) });
  const next = queue.shift();
  if (next === undefined) throw new Error('no answer queued');
  if (next instanceof Error) throw next;
  return respond(next);
});

beforeEach(() => {
  sent.length = 0;
  queue.length = 0;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

function serve(...names: (string | Error)[]) {
  for (const n of names) queue.push(typeof n === 'string' ? answer(n) : n);
}

/** GET one captured detail through the phone's real read. */
async function detailFrom(name: string): Promise<MobileExceptionDetail> {
  const occurrenceId = (body(name).occurrence as { id: string }).id;
  serve(name);
  const d = await getException(occurrenceId);
  expect(sent.at(-1)).toMatchObject({ method: 'GET' });
  expect(sent.at(-1)!.url.endsWith(`/api/v1/exceptions/${occurrenceId}`)).toBe(true);
  return d;
}

/** A refusal as the phone's confirm call throws it, for a captured answer. */
async function refusal(name: string, occurrenceId = OCC.counter): Promise<unknown> {
  serve(name);
  return confirmExceptionCount(occurrenceId, { cycleCountId: IDS.cycleCount, countedQuantity: 1, note: null }).then(
    () => {
      throw new Error(`${name} did not refuse`);
    },
    (e: unknown) => e,
  );
}

/** Every open count difference the server described before any confirm. */
const OPEN_DETAILS = [
  'detail.staff.counter',
  'detail.staff.notCounter',
  'detail.staff.moved',
  'detail.staff.recount',
  'detail.staff.otherCount',
  'detail.staff.manager',
  'detail.staff.decimal',
  'detail.manager.counter',
  'detail.manager.notCounter',
  'detail.viewer.counter',
] as const;

/** The keys of core's CountConfirmBlock, which the phone parses. */
const BLOCK_KEYS: readonly (keyof CountConfirmBlock)[] = [
  'canConfirm',
  'counted',
  'countedBy',
  'countNumber',
  'cycleCountId',
  'onRecordBefore',
  'onRecordNow',
  'otherCount',
  'postedBy',
  'readerIsCounter',
  'state',
  'unavailableReason',
];

describe('the countConfirm block the R2 server sends', () => {
  it('every key the server sends is one the phone reads, and no more', () => {
    for (const name of OPEN_DETAILS) {
      expect(Object.keys(serverBlock(name)).sort(), name).toEqual([...BLOCK_KEYS].sort());
    }
  });

  it('parses losslessly: the phone holds exactly what the server said, for every reader and state', async () => {
    const seen = new Set<string>();
    for (const name of OPEN_DETAILS) {
      const d = await detailFrom(name);
      expect(d.countConfirm, name).toEqual(serverBlock(name));
      seen.add(`${d.countConfirm!.state}:${String(d.countConfirm!.canConfirm)}:${String(d.countConfirm!.unavailableReason)}`);
    }
    // The captures cover every reader-facing branch the server sent.
    expect([...seen].sort()).toEqual([
      'confirmable:false:not_counter',
      'confirmable:false:not_permitted',
      'confirmable:true:null',
      'count_in_progress:false:count_in_progress',
      'recount_in_progress:false:recount_in_progress',
      'stock_moved:false:stock_moved',
    ]);
  });

  it('what a confirm sends back (the count and the counted number) is exactly readable, decimals included', () => {
    for (const name of OPEN_DETAILS) {
      const block = parseCountConfirm(serverBlock(name))!;
      expect(block.cycleCountId).toBe(IDS.cycleCount);
      expect(typeof block.counted).toBe('number');
    }
    expect(parseCountConfirm(serverBlock('detail.staff.decimal'))).toMatchObject({ counted: 2.5, onRecordNow: 2.5 });
  });

  it('a resolved row carries no block, and the phone offers nothing', async () => {
    for (const name of ['detail.staff.counter.confirmed', 'detail.manager.manager.confirmed']) {
      expect(body(name).countConfirm).toBeNull();
      const d = await detailFrom(name);
      expect(d.countConfirm).toBeNull();
      expect(countVarianceView(d, { online: true })).toBeNull();
    }
  });
});

describe('the words and the gate for each reader, from the server\'s real answers', () => {
  it('staff who counted it: Confirm offered, with the numbers, the people and the consequence', async () => {
    const d = await detailFrom('detail.staff.counter');
    expect(d.occurrence.reference).toBe('EX-000001');
    const v = countVarianceView(d, { online: true })!;
    expect(v.clear.lead).toBe(
      'CC-000001 found 20 where 22 was on record, and posting it changed the stock on record by -2.',
    );
    // QA staff may not start counts (cycle_counts:assign), so the recount tail
    // asks a manager.
    expect(v.clear.options).toBe(
      'If 20 is right, confirm it with Confirm this count. If you are not sure, ask a manager who can assign counts for a recount. Acknowledging does not clear this.',
    );
    expect(v.clear).toMatchObject({
      reason: null,
      who: 'Counted by QA Staff, posted by QA Manager.',
      offerConfirm: true,
      confirmDisabledReason: null,
    });
    expect(v.acknowledgeHelp).toBe(
      'CC-000001 found 20 where 22 was on record, and posting it changed the stock on record by -2. Acknowledging tells others this is being looked at. It does not clear this exception. If you have checked that 20 is right, confirm the count instead.',
    );
    expect(v.confirm.unavailable).toBeNull();
    const dialog = confirmCountDialogCopy({ reference: d.occurrence.reference, confirm: v.confirm.block! });
    expect(dialog.numbers).toEqual(['Counted in CC-000001: 20', 'On record before the count: 22', 'On record now: 20']);
    expect(dialog.who).toBe('Counted by QA Staff, posted by QA Manager.');
    expect(dialog.consequence).toBe(
      'Confirming records that 20 is right. It closes EX-000001 now, without a second count. If a later count does not match the stock on record, a new exception opens.',
    );
    expect(dialog.success).toBe('Count confirmed. EX-000001 is closed.');
    const gate = (online: boolean) =>
      exceptionSheetSubmit({
        mode: 'confirm_count',
        note: '',
        submitting: false,
        online,
        canAct: d.occurrence.canAct,
        resolved: d.occurrence.resolvedAt !== null,
        canConfirm: v.confirm.block?.canConfirm === true,
        confirmUnavailable: v.confirm.unavailable,
      });
    expect(gate(true)).toEqual({ enabled: true, reason: null });
    // Offline: offered but disabled, with the reason, on the screen and in the sheet.
    expect(gate(false)).toEqual({ enabled: false, reason: EXCEPTION_CONFIRM_OFFLINE_COPY });
    expect(countVarianceView(d, { online: false })!.clear).toMatchObject({
      offerConfirm: true,
      confirmDisabledReason: EXCEPTION_CONFIRM_OFFLINE_COPY,
    });
  });

  it('staff who did not count it: no Confirm, and who can', async () => {
    const d = await detailFrom('detail.staff.notCounter');
    const v = countVarianceView(d, { online: true })!;
    expect(v.clear.options).toBe(
      'It clears when QA Manager, who counted it, or a manager confirms that 10 is right, or when a recount matches the stock on record. Acknowledging does not clear this.',
    );
    expect(v.clear.reason).toBe('Only QA Manager, who counted it, or a manager can confirm this count.');
    expect(v.clear.who).toBe('Counted and posted by QA Manager.');
    expect(v.clear.offerConfirm).toBe(false);
    expect(v.confirm.unavailable).toBe(v.clear.reason);
    expect(v.acknowledgeHelp).not.toContain('confirm the count instead');
    expect(
      exceptionSheetSubmit({
        mode: 'confirm_count',
        note: '',
        submitting: false,
        online: true,
        canAct: true,
        resolved: false,
        canConfirm: v.confirm.block?.canConfirm === true,
        confirmUnavailable: v.confirm.unavailable,
      }),
    ).toEqual({ enabled: false, reason: 'Only QA Manager, who counted it, or a manager can confirm this count.' });
  });

  it('the stock on record moved: no Confirm, and what clears it for staff', async () => {
    const v = countVarianceView(await detailFrom('detail.staff.moved'), { online: true })!;
    expect(v.clear.options).toBe(
      'The stock on record changed after this count (counted 2, on record now 5), so confirming it is not offered. Ask a manager who can assign counts for a recount. Acknowledging does not clear this.',
    );
    expect(v.clear.offerConfirm).toBe(false);
  });

  it('a recount in progress: names the recount and its progress', async () => {
    const d = await detailFrom('detail.staff.recount');
    const v = countVarianceView(d, { online: true })!;
    expect(v.clear.options).toBe(
      'Recount CC-000003 is in progress (0 of 1 counted). When it is posted, this clears if it matches the stock on record, or shows the new numbers if it does not. Acknowledging does not clear this.',
    );
    expect(v.clear.reason).toBe(
      'Confirm this count is not offered while recount CC-000003 is in progress. Its result will settle this, or a manager can cancel it.',
    );
    expect(v.confirm.errorContext.recountNumber).toBe(3);
  });

  it('another count in progress recorded a different number: names it and its number', async () => {
    const v = countVarianceView(await detailFrom('detail.staff.otherCount'), { online: true })!;
    expect(v.clear.options).toBe(
      'CC-000002, which is in progress, has already recorded 3 for this item. When it is posted, this exception shows its numbers. Acknowledging does not clear this.',
    );
    expect(v.clear.reason).toBe(
      'Confirm this count is not offered while CC-000002 is in progress with a different number for this item.',
    );
  });

  it('a manager: Confirm offered on a row staff counted (Recount beside it), and on their own', async () => {
    const onStaffRow = countVarianceView(await detailFrom('detail.manager.counter'), { online: true })!;
    expect(onStaffRow.confirm.block).toMatchObject({ canConfirm: true, readerIsCounter: false });
    expect(onStaffRow.clear.options).toBe(
      'If 20 is right, confirm it with Confirm this count. If you are not sure, count it once more with Recount. Acknowledging does not clear this.',
    );
    expect(onStaffRow.clear).toMatchObject({ offerConfirm: true, offerRecount: true, recountEmphasis: 'outline' });
    const onOwnRow = countVarianceView(await detailFrom('detail.manager.notCounter'), { online: true })!;
    expect(onOwnRow.confirm.block).toMatchObject({ canConfirm: true, readerIsCounter: true });
    expect(onOwnRow.clear.offerConfirm).toBe(true);
  });

  it('a viewer: the sentence only, with no Confirm and no Acknowledging line', async () => {
    const d = await detailFrom('detail.viewer.counter');
    expect(d.occurrence.canAct).toBe(false);
    const v = countVarianceView(d, { online: true })!;
    expect(v.clear.options).toBe(
      'It clears when QA Staff, who counted it, or a manager confirms that 20 is right, or when a recount matches the stock on record.',
    );
    expect(v.clear).toMatchObject({ offerConfirm: false, reason: null, offerRecount: false });
  });

  it('the decimal row reads its numbers as the stock on record prints them', async () => {
    const d = await detailFrom('detail.staff.decimal');
    const dialog = confirmCountDialogCopy({ reference: d.occurrence.reference, confirm: d.countConfirm! });
    expect(dialog.numbers).toEqual(['Counted in CC-000001: 2.5', 'On record before the count: 4', 'On record now: 2.5']);
  });
});

describe('confirming: what the phone sends, and how it reads the server\'s answer', () => {
  it('the sheet sends back the count and the number of the block it showed (pinned at source)', () => {
    const sheet = readFileSync(path.resolve(__dirname, '../components/exception-note-sheet.tsx'), 'utf8');
    expect(sheet).toMatch(
      /confirmExceptionCount\(occurrence\.id, \{\s+cycleCountId: block\.cycleCountId,\s+countedQuantity: block\.counted,\s+note: payloadNote,\s+\}\)/,
    );
  });

  it('the counter confirms: the request is the one the server accepted, and the answer reads as confirmed', async () => {
    const d = await detailFrom('detail.staff.counter');
    const block = d.countConfirm!;
    serve('confirm.staff.counter.200');
    const res = await confirmExceptionCount(d.occurrence.id, {
      cycleCountId: block.cycleCountId,
      countedQuantity: block.counted,
      note: 'Counted twice on the floor',
    });
    const req = FIXTURE.meta.requests['confirm.staff.counter.200']!;
    expect(sent.at(-1)).toMatchObject({ method: 'POST', body: req.body });
    expect(sent.at(-1)!.url.endsWith(`/api/v1/exceptions/${req.occurrence}/confirm-count`)).toBe(true);
    expect(res.replay).toBe(false);
    expect(res.occurrence).toMatchObject({ id: OCC.counter, resolvedReason: 'confirmed' });
    expect(res.occurrence.confirmation).toEqual({
      at: expect.any(String),
      by: { id: IDS.staff, label: 'QA Staff' },
      cycleCountId: IDS.cycleCount,
      countNumber: 1,
      quantity: 20,
      as: 'counter',
    });
  });

  it('a lost answer: the resend is the same request, and the server\'s replay is a success', async () => {
    const d = await detailFrom('detail.staff.counter');
    const block = d.countConfirm!;
    const input = { cycleCountId: block.cycleCountId, countedQuantity: block.counted, note: 'Counted twice on the floor' };
    serve(new TypeError('Network request failed'), 'confirm.staff.counter.replay');
    const first = await confirmExceptionCount(d.occurrence.id, input).catch((e: unknown) => e);
    expect(describeConfirmCountError(first, countVarianceView(d, { online: true })!.confirm.errorContext)).toBe(
      CONNECTION_FAILURE_COPY,
    );
    const second = await confirmExceptionCount(d.occurrence.id, input);
    expect(sent.at(-1)!.body).toEqual(sent.at(-2)!.body);
    expect(second.replay).toBe(true);
    expect(second.occurrence.resolvedReason).toBe('confirmed');
  });

  it('the decimal row: the counted number the block carried is accepted as sent', async () => {
    const d = await detailFrom('detail.staff.decimal');
    serve('confirm.staff.decimal.200');
    const res = await confirmExceptionCount(d.occurrence.id, {
      cycleCountId: d.countConfirm!.cycleCountId,
      countedQuantity: d.countConfirm!.counted,
      note: null,
    });
    expect(sent.at(-1)!.body).toEqual(FIXTURE.meta.requests['confirm.staff.decimal.200']!.body);
    expect(res.occurrence.confirmation).toMatchObject({ quantity: 2.5, as: 'counter' });
  });

  it('a manager confirms a row staff counted: recorded as a manager', async () => {
    serve('confirm.manager.manager.200');
    const res = await confirmExceptionCount(OCC.manager, { cycleCountId: IDS.cycleCount, countedQuantity: 30, note: null });
    expect(res.replay).toBe(false);
    expect(res.occurrence.confirmation).toMatchObject({ as: 'manager', by: { label: 'QA Manager' }, quantity: 30 });
  });
});

describe('after a confirm: the re-read, the list and the timeline', () => {
  it('the counter\'s row: the chip, the facts row, the history and the timeline say who confirmed it', async () => {
    const d = await detailFrom('detail.staff.counter.confirmed');
    const o = d.occurrence;
    expect(o.resolvedReason).toBe('confirmed');
    expect(occurrenceStateLabel(displayedStateOf(d))).toBe('Resolved: Confirmed by the counter');
    expect(confirmationFactsRow(o.confirmation!, 'Sep 30, 9:52 AM')).toEqual({
      label: 'Count confirmed',
      value: 'QA Staff, who counted it, Sep 30, 9:52 AM, without a second count',
    });
    expect(d.history.map((h) => resolvedReasonCopy(h.resolvedReason, h.confirmedAs))).toEqual(['Confirmed by the counter']);
    const confirmed = d.timeline.find((e) => e.kind === 'count_confirmed')!;
    expect(confirmed).toMatchObject({
      actor: { id: IDS.staff, label: 'QA Staff' },
      note: 'Counted twice on the floor',
      cycleCount: { id: IDS.cycleCount, countNumber: 1, outcome: null },
    });
    expect(
      describeTimelineEvent({
        kind: confirmed.kind,
        actorLabel: confirmed.actor?.label ?? null,
        cycleCountNumber: confirmed.cycleCount?.countNumber ?? null,
        resolvedReason: o.resolvedReason,
        recountOutcome: confirmed.cycleCount?.outcome ?? null,
        confirmation: countConfirmationFor(o.facts, o.confirmation?.as ?? null, confirmed.cycleCount?.countNumber ?? null),
      }),
    ).toBe(
      'Count confirmed by QA Staff, who counted it, without a second count: CC-000001 found 20 where 22 was on record (-2)',
    );
  });

  it('the manager\'s row reads "by a manager", "who did not count it"', async () => {
    const d = await detailFrom('detail.manager.manager.confirmed');
    const o = d.occurrence;
    expect(occurrenceStateLabel(displayedStateOf(d))).toBe('Resolved: Confirmed by a manager');
    const confirmed = d.timeline.find((e) => e.kind === 'count_confirmed')!;
    expect(
      describeTimelineEvent({
        kind: confirmed.kind,
        actorLabel: confirmed.actor?.label ?? null,
        cycleCountNumber: confirmed.cycleCount?.countNumber ?? null,
        resolvedReason: o.resolvedReason,
        confirmation: countConfirmationFor(o.facts, o.confirmation?.as ?? null, confirmed.cycleCount?.countNumber ?? null),
      }),
    ).toBe(
      'Count confirmed by QA Manager, who did not count it, without a second count: CC-000001 found 30 where 33 was on record (-3)',
    );
  });

  it('the lists: open rows carry no confirmation; resolved rows carry who confirmed them', async () => {
    serve('list.staff.open');
    const open = await listExceptions('open');
    expect(open.occurrences).toHaveLength(7);
    expect(open.unrecognized).toBe(0);
    expect(open.occurrences.every((o) => o.rule === 'count_variance' && o.confirmation === null)).toBe(true);
    serve('list.staff.resolved');
    const resolved = await listExceptions('resolved');
    expect(resolved.occurrences.map((o) => [o.resolvedReason, o.confirmation?.as ?? null]).sort()).toEqual([
      ['confirmed', 'counter'],
      ['confirmed', 'counter'],
      ['confirmed', 'manager'],
    ]);
    // The web's "closed without a second count" view parses too (the phone
    // does not ask for it; its Resolved chips already name the role).
    expect(body('list.staff.resolved.confirmed')).toEqual(body('list.staff.resolved'));
  });
});

describe('every refusal the R2 server answers, as the phone words it', () => {
  it('each 409 and the 403 not_counter by its reason, in the phone\'s words', async () => {
    const ctxOf = async (name: string) => countVarianceView(await detailFrom(name), { online: true })!.confirm.errorContext;
    const cases: [string, string, string][] = [
      ['confirm.staff.counter.409.resolved', 'detail.staff.counter', 'This exception has already been resolved. Pull down to refresh.'],
      ['confirm.staff.notCounter.403', 'detail.staff.notCounter', 'Only QA Manager, who counted it, or a manager can confirm this count.'],
      [
        'confirm.staff.moved.409',
        'detail.staff.moved',
        'The stock on record changed after this count, so it can no longer be confirmed. Ask a manager who can assign counts for a recount.',
      ],
      [
        'confirm.staff.recount.409',
        'detail.staff.recount',
        'Confirm this count is not offered while recount CC-000003 is in progress. Its result will settle this, or a manager can cancel it.',
      ],
      [
        'confirm.staff.otherCount.409',
        'detail.staff.otherCount',
        'Another count in progress has recorded a different number for this item. This exception shows its numbers when that count is posted.',
      ],
      [
        'confirm.manager.manager.409.changed',
        'detail.staff.manager',
        'A newer count of this item was posted. Pull down to refresh and see its numbers before confirming.',
      ],
      ['confirm.staff.counter.409.busy', 'detail.staff.counter', 'A check is running. Try again in a moment.'],
      ['confirm.staff.counter.409.unavailable', 'detail.staff.counter', 'Confirming is unavailable right now. Pull down to try again.'],
    ];
    for (const [answerName, detailName, words] of cases) {
      const ctx = await ctxOf(detailName);
      expect(describeConfirmCountError(await refusal(answerName), ctx), answerName).toBe(words);
    }
    // busy is the one the server marks retryable; the sheet re-enables its button.
    expect(body('confirm.staff.counter.409.busy')).toMatchObject({ details: { reason: 'busy', retryable: true } });
  });

  it('the rest read as every other exception action\'s', async () => {
    const ctx = countVarianceView(await detailFrom('detail.staff.counter'), { online: true })!.confirm.errorContext;
    const cases: [string, string][] = [
      ['confirm.viewer.counter.403', 'You do not have permission to act on this exception.'],
      ['confirm.viewer.notCounter.403', 'You do not have permission to act on this exception.'],
      ['confirm.staff.404', 'This exception is no longer available to you.'],
      ['confirm.staff.400.id', 'That exception id is not valid.'],
      ['confirm.staff.400.body', 'Send the count and the counted number that were shown, with an optional note.'],
      ['confirm.staff.400.json', 'The request body is not valid JSON.'],
      ['confirm.owner.429', 'Too many requests. Wait a moment and try again.'],
    ];
    for (const [answerName, words] of cases) {
      expect(describeConfirmCountError(await refusal(answerName), ctx), answerName).toBe(words);
    }
    expect(answer('confirm.owner.429').retryAfter).toMatch(/^\d+$/);
  });

  // Mutation caught: the route answers a 401 as { error: 'unauthenticated' }
  // with no sentence, api() then carries the code as the message, and the
  // sheet printed the bare code "unauthenticated" where a sentence belonged.
  it('a 401 (a session that ended) reads as a sentence, never the bare code', async () => {
    expect(body('confirm.none.401')).toEqual({ error: 'unauthenticated' });
    const ctx = countVarianceView(await detailFrom('detail.staff.counter'), { online: true })!.confirm.errorContext;
    expect(describeConfirmCountError(await refusal('confirm.none.401'), ctx)).toBe(VERIFICATION_SESSION_ENDED_COPY);
  });

  // (Every confirm sentence is core's; core's on-record wording guard checks
  // how they name the recorded quantity.)
  it('no refusal ever reads as a bare code, and each is a whole sentence', async () => {
    const ctx = countVarianceView(await detailFrom('detail.staff.counter'), { online: true })!.confirm.errorContext;
    for (const name of Object.keys(A).filter((n) => n.startsWith('confirm.') && answer(n).status >= 400)) {
      const words = describeConfirmCountError(await refusal(name), ctx);
      expect(words, name).not.toMatch(/^[a-z0-9_]+$/);
      expect(words, name).toMatch(/\.$/);
    }
  });
});
