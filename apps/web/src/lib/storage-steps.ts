import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * TIME LIMITS FOR STORAGE STEPS, AND ONE DEADLINE PER FINALIZE CHECK (lab
 * walk 5; review round 3, R3-1 and R3-2).
 *
 * Every step a finalize check waits on (the object's size, the signed link,
 * the first window, the whole read, the look for a record that still names
 * the object, the removal) runs under a time limit of its own. Inside one
 * check every step also shares that check's one deadline: a step gets the
 * shorter of its own limit and the time the check has left, a step that would
 * start with no time left answers "timed out" at once and starts nothing, and
 * the check itself answers at its deadline whatever it is still waiting on.
 *
 * The deadline is held in an AsyncLocalStorage, not passed as an argument (as
 * lib/auth/step-up-gate.ts holds its read), so every step inside the check
 * sees it, the reader's own steps (lib/storage-object-prefix.ts) included,
 * and every caller keeps its call shape. Its own module, so the many tests
 * that stand in for the reader need not stand in for this too.
 *
 * Server code only (node:async_hooks).
 */

/** The limit of one short step: the size, the signed link, the first window, the look, the removal. */
export const STORAGE_STEP_LIMIT_MS = 8_000;

/**
 * One finalize check's whole budget: all its steps together (review round 3,
 * R3-2). An item photo and its thumbnail, or a video and its poster, are two
 * checks, each with its own budget: at most 90 s of waiting for the request.
 */
export const UPLOAD_CHECK_BUDGET_MS = 45_000;

/** A step that did not answer inside its time limit: the object could not be checked. */
export type StorageReadTimedOut = { readonly timedOut: true };
export const STORAGE_READ_TIMED_OUT: StorageReadTimedOut = Object.freeze({ timedOut: true as const });

/** True for the timed-out answer (structural, so a test's stand-in need not import it). */
export function isStorageReadTimedOut(value: unknown): value is StorageReadTimedOut {
  return typeof value === 'object' && value !== null && (value as { timedOut?: unknown }).timedOut === true;
}

/** When the current check must have answered (ms since the epoch), or none outside a check. */
const deadlines = new AsyncLocalStorage<number>();

/** The time a step may take: its own limit, or less when the check it is part of has less left. */
export function stepTimeLimit(limitMs: number): number {
  const at = deadlines.getStore();
  return at === undefined ? limitMs : Math.min(limitMs, at - Date.now());
}

/** What one step came to: its answer, its failure, or no answer in time. */
export type StepOutcome<T> =
  | { readonly answered: true; readonly value: T }
  | { readonly answered: false; readonly error: unknown }
  | StorageReadTimedOut;

/**
 * Runs one step under its time limit (or less, inside a check with less
 * left). The step is handed the signal of its own AbortController; the
 * controller is aborted when the step ends, answered or not, and nothing
 * waits for that. A step that cannot be aborted (storage-js takes no signal
 * for a size, a signed link or a removal; the look is a database read) is
 * raced against the limit, and a late answer is dropped.
 */
export async function settleInTime<T>(
  limitMs: number,
  step: (signal: AbortSignal) => PromiseLike<T>,
): Promise<StepOutcome<T>> {
  const ms = stepTimeLimit(limitMs);
  if (!(ms > 0)) return STORAGE_READ_TIMED_OUT;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<StorageReadTimedOut>((resolve) => {
    timer = setTimeout(() => resolve(STORAGE_READ_TIMED_OUT), ms);
  });
  let started: PromiseLike<T>;
  try {
    started = step(controller.signal);
  } catch (error) {
    started = Promise.reject(error);
  }
  const work = Promise.resolve(started).then(
    (value): StepOutcome<T> => ({ answered: true, value }),
    (error: unknown): StepOutcome<T> => ({ answered: false, error }),
  );
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * Runs one finalize check under one deadline, `budgetMs` from now (or an
 * outer check's, when that comes first). Every step inside it gets at most
 * the time left, and the check answers `whenSpent()` at the deadline if it is
 * still waiting then: on anything, a step or not.
 */
export async function withStorageDeadline<T>(
  budgetMs: number,
  check: () => Promise<T>,
  whenSpent: () => T,
): Promise<T> {
  const outer = deadlines.getStore();
  const at = Math.min(Date.now() + budgetMs, outer ?? Number.POSITIVE_INFINITY);
  return deadlines.run(at, async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const spent = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(whenSpent()), Math.max(0, at - Date.now()));
    });
    try {
      return await Promise.race([check(), spent]);
    } finally {
      clearTimeout(timer);
    }
  });
}

/**
 * A storage download() with a signal of its own (review round 3, R3-6).
 * Inside the app, fetch is Next's: a GET with options and no signal is
 * deduped, which tees its body and keeps one branch for later, a whole second
 * copy of the file held until the request ends. A signal opts out of that.
 * The signal is aborted once the download has answered (storage-js has read
 * the body by then), however it ended.
 */
export async function withOwnSignal<T>(download: (signal: AbortSignal) => PromiseLike<T>): Promise<T> {
  const controller = new AbortController();
  try {
    return await download(controller.signal);
  } finally {
    controller.abort();
  }
}
