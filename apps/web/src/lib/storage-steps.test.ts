import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  settleInTime,
  STORAGE_READ_TIMED_OUT,
  STORAGE_STEP_LIMIT_MS,
  stepTimeLimit,
  UPLOAD_CHECK_BUDGET_MS,
  withOwnSignal,
  withStorageDeadline,
} from './storage-steps';

/**
 * The time limits of storage steps, and the one deadline of a finalize check
 * (review round 3, R3-1 and R3-2): a step gets the shorter of its own limit
 * and the time its check has left, a step with no time left starts nothing,
 * and a check still waiting at its deadline answers at that moment.
 */

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const after = <T>(ms: number, value: T): Promise<T> =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

afterEach(() => {
  vi.useRealTimers();
});

describe('one deadline per finalize check (review round 3)', () => {
  it('the budget is 45 s for all the steps of one check together; a short step keeps its 8 s', () => {
    expect(UPLOAD_CHECK_BUDGET_MS).toBe(45_000);
    expect(STORAGE_STEP_LIMIT_MS).toBe(8_000);
  });

  it('a step gets the shorter of its own limit and the time the check has left; outside a check, its own limit', async () => {
    vi.useFakeTimers();
    expect(stepTimeLimit(STORAGE_STEP_LIMIT_MS)).toBe(STORAGE_STEP_LIMIT_MS);
    const seen: number[] = [];
    const checked = withStorageDeadline(
      10_000,
      async () => {
        seen.push(stepTimeLimit(STORAGE_STEP_LIMIT_MS));
        await after(6_000, null);
        seen.push(stepTimeLimit(STORAGE_STEP_LIMIT_MS));
        return 'answered';
      },
      () => 'spent',
    );
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await checked).toBe('answered');
    expect(seen).toEqual([STORAGE_STEP_LIMIT_MS, 4_000]);
  });

  it('a step that starts with no time left answers "timed out" at once and starts nothing', async () => {
    vi.useFakeTimers();
    const step = vi.fn(async () => 'value');
    let inner: unknown;
    const checked = withStorageDeadline(
      1_000,
      async () => {
        await after(1_000, null);
        inner = await settleInTime(STORAGE_STEP_LIMIT_MS, step);
        return 'checked';
      },
      () => 'spent',
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await checked;
    expect(inner).toBe(STORAGE_READ_TIMED_OUT);
    expect(step).not.toHaveBeenCalled();
  });

  it('a check still waiting at its deadline answers at that moment, not a moment before', async () => {
    vi.useFakeTimers();
    let answer: string | undefined;
    const checked = withStorageDeadline(UPLOAD_CHECK_BUDGET_MS, () => never<string>(), () => 'spent').then((v) => {
      answer = v;
    });
    await vi.advanceTimersByTimeAsync(UPLOAD_CHECK_BUDGET_MS - 1);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await checked;
    expect(answer).toBe('spent');
  });

  it('a check inside another keeps the earlier deadline', async () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    const checked = withStorageDeadline(
      5_000,
      () =>
        withStorageDeadline(
          UPLOAD_CHECK_BUDGET_MS,
          async () => {
            seen.push(stepTimeLimit(STORAGE_STEP_LIMIT_MS));
            return 'answered';
          },
          () => 'spent',
        ),
      () => 'outer spent',
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(await checked).toBe('answered');
    expect(seen).toEqual([5_000]);
  });
});

describe('settleInTime: one step under its time limit', () => {
  it('an answer, a failure and no answer in time are told apart; the step is aborted however it ends', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const answered = await settleInTime(STORAGE_STEP_LIMIT_MS, async (signal) => {
      signals.push(signal);
      return 7;
    });
    expect(answered).toEqual({ answered: true, value: 7 });
    const failed = await settleInTime(STORAGE_STEP_LIMIT_MS, async (signal) => {
      signals.push(signal);
      throw new Error('refused');
    });
    expect(failed).toMatchObject({ answered: false, error: expect.any(Error) });
    const late = settleInTime(STORAGE_STEP_LIMIT_MS, (signal) => {
      signals.push(signal);
      return never<number>();
    });
    await vi.advanceTimersByTimeAsync(STORAGE_STEP_LIMIT_MS);
    expect(await late).toBe(STORAGE_READ_TIMED_OUT);
    expect(signals).toHaveLength(3);
    for (const signal of signals) expect(signal.aborted).toBe(true);
  });

  it('a step that throws before it returns is a failure, not a throw out of here', async () => {
    const out = await settleInTime(STORAGE_STEP_LIMIT_MS, () => {
      throw new Error('at once');
    });
    expect(out).toMatchObject({ answered: false });
  });
});

describe('withOwnSignal: a storage download with a signal of its own (review round 3, R3-6)', () => {
  it('hands the download a signal, gives back its answer, and aborts the signal once it has answered', async () => {
    let given: AbortSignal | undefined;
    const out = await withOwnSignal(async (signal) => {
      given = signal;
      expect(signal.aborted).toBe(false);
      return { data: 'bytes', error: null };
    });
    expect(out).toEqual({ data: 'bytes', error: null });
    expect(given).toBeInstanceOf(AbortSignal);
    expect(given!.aborted).toBe(true);
  });

  it('a download that fails is still the caller to handle, and its signal is aborted too', async () => {
    let given: AbortSignal | undefined;
    await expect(
      withOwnSignal(async (signal) => {
        given = signal;
        throw new Error('storage down');
      }),
    ).rejects.toThrow('storage down');
    expect(given!.aborted).toBe(true);
  });
});
