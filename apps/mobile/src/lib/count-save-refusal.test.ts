import { countFromText } from '@stockpilot/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { screenFunction, stateInitializer } from './__fixtures__/screen-functions';
import { reviewNotACountMessage } from './count-box-words';
import { COUNT_NOT_SAVED_ON_PHONE, countNotSavedAlert } from './count-save-refusal';
import {
  OutboxOwnerUnknownError,
  OutboxWorkspaceLoadingError,
  outboxRefusalSentence,
} from './outbox-scope';
import { reportPhoneSaveFailure } from './phone-save-report';

/**
 * docket B10, integrator decision 2: updateLocalLine now refuses a count
 * while the saved workspace is another account's (OutboxWorkspaceLoadingError,
 * beside OutboxOwnerUnknownError), and every caller says the refusal in the
 * outbox's own sentence. The count screen and the count scanner let the throw
 * escape (nothing said; the scanner stayed busy and ignored every scan after
 * it). The AI shelf scan no longer queues its copy of a count the server
 * recorded, so it is never refused (last block). Each screen's own handler is
 * RUN here from its source (screen-functions.ts).
 */

const LOADING = 'Your workspace is still loading. Try again in a moment.';
const NO_ACCOUNT = 'No signed-in account to queue this change for. Sign in and try again.';

/** Lets a fire-and-forget save (`void (async () => ...)()`) finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// reportPhoneSaveFailure runs for real; only Sentry itself is stood in for.
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('./sentry', () => ({ Sentry: sentry }));

beforeEach(() => {
  sentry.captureException.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const refused = () => vi.fn(async () => Promise.reject(new OutboxWorkspaceLoadingError()));
const saved = () => vi.fn(async () => ({ outboxId: 1, idempotencyKey: 'k1' }));

function syncStub() {
  return {
    refreshPendingCount: vi.fn(async () => undefined),
    forceSync: vi.fn(async () => undefined),
  };
}

describe('what a count screen says when the phone did not save a count', () => {
  it("the outbox's two refusals are said in their own sentence", () => {
    expect(countNotSavedAlert(new OutboxWorkspaceLoadingError())).toEqual({
      title: 'Count not saved',
      message: LOADING,
    });
    expect(countNotSavedAlert(new OutboxOwnerUnknownError())).toEqual({
      title: 'Count not saved',
      message: NO_ACCOUNT,
    });
  });

  it("any other failure is the phone's store, never its raw text", () => {
    const disk = new Error('SQLITE_FULL: database or disk is full');
    expect(countNotSavedAlert(disk).message).toBe(COUNT_NOT_SAVED_ON_PHONE);
    expect(countNotSavedAlert('a string').message).toBe(COUNT_NOT_SAVED_ON_PHONE);
    expect(outboxRefusalSentence(disk)).toBeNull();
    expect(outboxRefusalSentence(undefined)).toBeNull();
  });
});

describe('the count screen (app/cycle-count/[id].tsx): a typed count the phone refused', () => {
  const COUNT = 'app/cycle-count/[id].tsx';

  /** The screen's line saver, built by its own useState initializer. */
  function lineSaver(updateLocalLine: ReturnType<typeof vi.fn>) {
    const alert = vi.fn();
    const setLines = vi.fn();
    const setDraft = vi.fn();
    const sync = syncStub();
    const init = stateInitializer<
      () => { persist: (lineId: string, raw: string) => void; schedule: ReturnType<typeof vi.fn> }
    >(COUNT, 'lineSaver', {
      // The debouncer's timing is draft-debouncer.test.ts's; here the save
      // runs when the test calls persist.
      createDraftDebouncer: (_ms: number, persist: (lineId: string, raw: string) => void) => ({
        persist,
        schedule: vi.fn(),
        flushAll: vi.fn(),
      }),
      SAVE_DEBOUNCE_MS: 300,
      // The screen's own box rules (B4a: an emptied box, core countFromText).
      countFromBox: screenFunction(COUNT, 'countFromBox', {
        isEmptyBox: screenFunction(COUNT, 'isEmptyBox', {}),
        countFromText,
      }),
      isEmptyBox: screenFunction(COUNT, 'isEmptyBox', {}),
      updateLocalLine,
      countNotSavedAlert,
      reportPhoneSaveFailure,
      Alert: { alert },
      setLines,
      setDraft,
      cycleCountSync: sync,
    });
    return { saver: init(), alert, setLines, setDraft, sync };
  }

  it('is said in the sentence, nothing is marked saved, and Try again saves the same count again', async () => {
    const save = refused();
    const { saver, alert, setLines, setDraft, sync } = lineSaver(save);

    saver.persist('l1', '7');
    await settle();

    expect(save).toHaveBeenCalledWith('l1', 7);
    expect(alert).toHaveBeenCalledTimes(1);
    const [title, message, buttons] = alert.mock.calls[0] as [
      string,
      string,
      { text: string; style?: string; onPress?: () => void }[],
    ];
    expect([title, message]).toEqual(['Count not saved', LOADING]);
    expect(buttons.map((b) => [b.text, b.style])).toEqual([
      ['Cancel', 'cancel'],
      ['Try again', undefined],
    ]);
    // The box keeps the number (the draft stays) and nothing claims a save.
    expect(setLines).not.toHaveBeenCalled();
    expect(setDraft).not.toHaveBeenCalled();
    expect(sync.forceSync).not.toHaveBeenCalled();

    buttons[1]!.onPress!();
    expect(saver.schedule).toHaveBeenCalledWith('l1', '7');
    // Expected and retryable: never reported to the team.
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("the phone's store failing is said too, and reported to the team", async () => {
    const disk = new Error('SQLITE_IOERR: disk I/O error');
    const { saver, alert } = lineSaver(vi.fn(async () => Promise.reject(disk)));
    saver.persist('l1', '7');
    await settle();
    expect(alert.mock.calls[0]?.slice(0, 2)).toEqual(['Count not saved', COUNT_NOT_SAVED_ON_PHONE]);
    // Caught to say it, so no longer an unhandled rejection Sentry reports.
    expect(sentry.captureException).toHaveBeenCalledWith(disk, {
      tags: { area: 'cycle-count.save' },
    });
  });

  it('a saved count is marked saved and sent, with nothing said', async () => {
    const { saver, alert, setLines, setDraft, sync } = lineSaver(saved());
    saver.persist('l1', '7');
    await settle();
    expect(alert).not.toHaveBeenCalled();
    expect(setLines).toHaveBeenCalledTimes(1);
    expect(setDraft).toHaveBeenCalledTimes(1);
    expect(sync.forceSync).toHaveBeenCalledTimes(1);
  });
});

describe('the count scanner (app/cycle-count/scan/[id].tsx): a scanned count the phone refused', () => {
  const SCANNER = 'app/cycle-count/scan/[id].tsx';

  function recordCount(updateLocalLine: ReturnType<typeof vi.fn>) {
    const alert = vi.fn();
    const setBusy = vi.fn();
    const setScannedMap = vi.fn();
    const sync = syncStub();
    const run = screenFunction<(line: { id: string }, qty: number) => Promise<boolean>>(
      SCANNER,
      'recordCount',
      {
        setBusy,
        updateLocalLine,
        countNotSavedAlert,
        reportPhoneSaveFailure,
        Alert: { alert },
        setScannedMap,
        setLines: vi.fn(),
        cycleCountSync: sync,
      },
    );
    return { run, alert, setBusy, setScannedMap, sync };
  }

  it('is said in the sentence, and the scanner takes the next scan once the alert is answered', async () => {
    const { run, alert, setBusy, setScannedMap, sync } = recordCount(refused());

    await expect(run({ id: 'l1' }, 3)).resolves.toBe(false);

    expect(alert).toHaveBeenCalledTimes(1);
    const [title, message, buttons, options] = alert.mock.calls[0] as [
      string,
      string,
      { text: string; onPress?: () => void }[],
      { cancelable?: boolean; onDismiss?: () => void },
    ];
    expect([title, message]).toEqual(['Count not saved', LOADING]);
    // Paused while the alert is up (the camera stays on the code)...
    expect(setBusy.mock.calls).toEqual([[true]]);
    expect(setScannedMap).not.toHaveBeenCalled();
    expect(sync.forceSync).not.toHaveBeenCalled();
    // ...and free once it is answered: OK, or (Android) dismissed.
    expect(buttons.map((b) => b.text)).toEqual(['OK']);
    buttons[0]!.onPress!();
    expect(setBusy.mock.calls).toEqual([[true], [false]]);
    expect(options.cancelable).toBe(true);
    options.onDismiss!();
    expect(setBusy.mock.calls.at(-1)).toEqual([false]);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("the phone's store failing is said and reported to the team", async () => {
    const disk = new Error('SQLITE_FULL: database or disk is full');
    const { run, alert } = recordCount(vi.fn(async () => Promise.reject(disk)));
    await expect(run({ id: 'l1' }, 3)).resolves.toBe(false);
    expect(alert.mock.calls[0]?.slice(0, 2)).toEqual(['Count not saved', COUNT_NOT_SAVED_ON_PHONE]);
    expect(sentry.captureException).toHaveBeenCalledWith(disk, {
      tags: { area: 'cycle-count.scan' },
    });
  });

  /**
   * One scanner visit in Burst, the camera held on one barcode. Each scan is
   * handled by the onBarcode and recordCount of the render it lands in (a
   * render's handlers read that render's state), rebuilt here from the
   * screen's source with the state at that moment.
   */
  function burstSession(updateLocalLine: ReturnType<typeof vi.fn>) {
    const state = {
      busy: false,
      lastScan: null as { code: string; at: number } | null,
      scannedMap: new Map<string, number>(),
    };
    const alert = vi.fn();
    const line = { id: 'l1', itemBarcode: 'CODE-1', itemSku: 'SKU-1', counted: 2, expected: 5 };
    let clock = 1000;
    const sync = syncStub();
    function scan(code: string) {
      const recordCount = screenFunction(SCANNER, 'recordCount', {
        setBusy: (v: boolean) => {
          state.busy = v;
        },
        updateLocalLine,
        countNotSavedAlert,
        reportPhoneSaveFailure: vi.fn(),
        Alert: { alert },
        setScannedMap: (f: (m: Map<string, number>) => Map<string, number>) => {
          state.scannedMap = f(state.scannedMap);
        },
        setLines: vi.fn(),
        cycleCountSync: sync,
      });
      const onBarcode = screenFunction<(e: { data: string }) => Promise<void>>(
        SCANNER,
        'onBarcode',
        {
          busy: state.busy,
          lastScan: state.lastScan,
          setLastScan: (v: { code: string; at: number }) => {
            state.lastScan = v;
          },
          Date: { now: () => clock },
          findLineByCode: screenFunction(SCANNER, 'findLineByCode', { lines: [line] }),
          Alert: { alert },
          burstMode: true,
          scannedMap: state.scannedMap,
          recordCount,
          setSheet: vi.fn(),
        },
      );
      const done = onBarcode({ data: code });
      clock += 700; // the camera fires again past the 600 ms de-dupe
      return done;
    }
    return { scan, alert, state };
  }

  it('in Burst, scans during a refusal wait for the alert: one alert, not one per scan', async () => {
    const save = vi.fn(async (): Promise<{ outboxId: number; idempotencyKey: string }> => {
      throw new OutboxWorkspaceLoadingError();
    });
    const { scan, alert, state } = burstSession(save);

    await scan('CODE-1');
    await scan('CODE-1');
    await scan('CODE-1');

    expect(save).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0]!.slice(0, 2)).toEqual(['Count not saved', LOADING]);

    // Answered, and the workspace has loaded: the next scan is taken.
    (alert.mock.calls[0]![2] as { onPress: () => void }[])[0]!.onPress();
    save.mockResolvedValue({ outboxId: 1, idempotencyKey: 'k1' });
    await scan('CODE-1');
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith('l1', 3);
    expect(state.scannedMap.get('l1')).toBe(3);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('a saved count answers true and is sent', async () => {
    const { run, alert, setBusy, sync } = recordCount(saved());
    await expect(run({ id: 'l1' }, 3)).resolves.toBe(true);
    expect(alert).not.toHaveBeenCalled();
    expect(setBusy.mock.calls).toEqual([[true], [false]]);
    expect(sync.forceSync).toHaveBeenCalledTimes(1);
  });

  it('the Counted sheet closes only once the count is saved, so Save can try the same number again', async () => {
    for (const [wasSaved, closed] of [
      [false, false],
      [true, true],
    ] as const) {
      const setSheet = vi.fn();
      const confirmSheet = screenFunction<() => Promise<void>>(SCANNER, 'confirmSheet', {
        sheet: { line: { id: 'l1' }, qty: '4' },
        countFromText,
        Alert: { alert: vi.fn() },
        recordCount: vi.fn(async () => wasSaved),
        setSheet,
      });
      await confirmSheet();
      expect(setSheet.mock.calls).toEqual(closed ? [[null]] : []);
    }
  });
});

/**
 * The AI shelf scan records each line on the server, then copies the count to
 * the phone. It copied it with updateLocalLine, which since decision 2 refuses
 * to queue while the saved workspace is another account's, so a count the
 * server had saved was said to be not saved, the review list stayed and the
 * scan was not confirmed (docket B10 review). It now copies it with
 * mirrorRecordedCount, which queues nothing and so needs no workspace
 * (outbox-owner.sqlite.test.ts runs it on a real SQLite).
 */
describe('the AI shelf scan (app/cycle-count/ai-scan/[id].tsx): a count the server recorded', () => {
  const AI_SCAN = 'app/cycle-count/ai-scan/[id].tsx';
  const RETRY =
    "1 of 2 counts saved. 1 couldn't save — check your connection and tap Confirm to retry.";

  /** `recorded`: whether the server took each line's count, in order. */
  function onConfirm(mirror: ReturnType<typeof vi.fn>, recorded: boolean[] = [true, true]) {
    const alert = vi.fn();
    const setPhase = vi.fn();
    const back = vi.fn();
    const reviewPhase = {
      kind: 'review',
      scanId: 'scan-1',
      reviewLines: [
        { line: { id: 'l1' }, override: '3' },
        { line: { id: 'l2' }, override: '4' },
      ],
    };
    let line = 0;
    const fetch = vi.fn(async (url: string) => {
      const ok = url.endsWith('/confirm') || (recorded[line++] ?? true);
      return { ok, status: ok ? 200 : 503, text: async () => '' };
    });
    const run = screenFunction<() => Promise<void>>(AI_SCAN, 'onConfirm', {
      phase: reviewPhase,
      overrideNotACount: screenFunction(AI_SCAN, 'overrideNotACount', { countFromText }),
      reviewNotACountMessage,
      lineCountToWrite: (rl: { override: string }) => Number(rl.override),
      Alert: { alert },
      setPhase,
      supabase: {
        auth: {
          getSession: async () => ({
            data: { session: { access_token: 'token-a', user: { id: 'u-a' } } },
          }),
        },
      },
      fetch,
      API_BASE: 'https://api.example.test',
      cycleCountId: 'cc1',
      orgHeader: async () => ({}),
      mirrorRecordedCount: mirror,
      cycleCountSync: syncStub(),
      router: { back },
      console: { warn: vi.fn() },
    });
    const confirmed = () => fetch.mock.calls.some(([url]) => String(url).endsWith('/confirm'));
    return { run, alert, setPhase, back, reviewPhase, confirmed };
  }

  it('each recorded count is copied for the account that sent it, with nothing queued: nothing said, the scan confirmed', async () => {
    const mirror = vi.fn(async () => undefined);
    const { run, alert, back, confirmed } = onConfirm(mirror);

    await run();

    expect(mirror.mock.calls).toEqual([
      ['l1', 3, 'u-a'],
      ['l2', 4, 'u-a'],
    ]);
    expect(alert).not.toHaveBeenCalled();
    expect(confirmed()).toBe(true);
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('a count the server did not take is not copied, and Partially saved keeps the review list for Confirm', async () => {
    const mirror = vi.fn(async () => undefined);
    const { run, alert, setPhase, back, reviewPhase, confirmed } = onConfirm(mirror, [true, false]);

    await run();

    expect(mirror.mock.calls).toEqual([['l1', 3, 'u-a']]);
    expect(alert.mock.calls).toEqual([['Partially saved', RETRY]]);
    expect(setPhase.mock.calls.at(-1)).toEqual([reviewPhase]);
    expect(back).not.toHaveBeenCalled();
    expect(confirmed()).toBe(false);
  });

  it("the phone's store failing to copy a count keeps the line for Confirm, as before", async () => {
    const mirror = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('SQLITE_IOERR: disk I/O error'));
    const { run, alert, back } = onConfirm(mirror);
    await run();
    expect(alert.mock.calls).toEqual([['Partially saved', RETRY]]);
    expect(back).not.toHaveBeenCalled();
  });
});
