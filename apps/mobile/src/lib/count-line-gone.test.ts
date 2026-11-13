import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { countFromText } from '@stockpilot/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { screenFunction, stateInitializer } from './__fixtures__/screen-functions';
import { countNotClearedAlert, countNotSavedAlert } from './count-save-refusal';
import { reportPhoneSaveFailure } from './phone-save-report';

/**
 * A COUNTED NUMBER THAT COULD NOT BE STORED IS NEVER SHOWN AS SAVED (S75).
 *
 * updateLocalLine (cycle-count-cache.ts) answers null when the line is no
 * longer in the copy of the count on this phone: a pull removed it, the count
 * was posted or cancelled, or the count is no longer sent to this member.
 * Nothing is saved or queued then. The count screen and the count scanner
 * ignored that answer and marked the line saved (and the scanner tallied
 * it). Both now say the count was not saved, keep the number unsaved, and
 * then load the count again (the count screen from the server, the scanner
 * from the copy on this phone), or leave when the count is no longer on this
 * phone or no longer open to the member. Each screen's own code is RUN here
 * (screen-functions.ts).
 */

const LINE_GONE = {
  title: 'Count not saved',
  message:
    'This line is no longer in the count saved on this phone, so this number was not saved. Tap OK to load the count again, or to close it if it is no longer open to you.',
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('./sentry', () => ({ Sentry: sentry }));

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const syncStub = () => ({
  refreshPendingCount: vi.fn(async () => undefined),
  forceSync: vi.fn(async () => undefined),
});

describe('the count screen', () => {
  const COUNT = 'app/cycle-count/[id].tsx';

  function lineSaver(updateLocalLine: ReturnType<typeof vi.fn>) {
    const alert = vi.fn();
    const setLines = vi.fn();
    const setDraft = vi.fn();
    const sync = syncStub();
    const setLineGoneAnswered = vi.fn();
    const init = stateInitializer<() => { persist: (lineId: string, raw: string) => void }>(
      COUNT,
      'lineSaver',
      {
        createDraftDebouncer: (_ms: number, persist: (lineId: string, raw: string) => void) => ({
          persist,
          schedule: vi.fn(),
          flushAll: vi.fn(),
        }),
        SAVE_DEBOUNCE_MS: 300,
        countFromBox: screenFunction(COUNT, 'countFromBox', {
          isEmptyBox: screenFunction(COUNT, 'isEmptyBox', {}),
          countFromText,
        }),
        isEmptyBox: screenFunction(COUNT, 'isEmptyBox', {}),
        updateLocalLine,
        clearLocalLine: vi.fn(async () => null),
        countNotSavedAlert,
        countNotClearedAlert,
        COUNT_LINE_NOT_SAVED: LINE_GONE,
        setLineGoneAnswered,
        reportPhoneSaveFailure,
        Alert: { alert },
        setLines,
        setDraft,
        cycleCountSync: sync,
      },
    );
    return { saver: init(), alert, setLines, setDraft, sync, setLineGoneAnswered };
  }

  it('a line no longer on the phone: said, never marked saved, nothing sent; OK loads again or leaves', async () => {
    const { saver, alert, setLines, setDraft, sync, setLineGoneAnswered } = lineSaver(
      vi.fn(async () => null),
    );
    saver.persist('l1', '7');
    await settle();
    expect(alert).toHaveBeenCalledTimes(1);
    const [title, message, buttons] = alert.mock.calls[0] as [
      string,
      string,
      { text: string; onPress?: () => void }[],
    ];
    expect([title, message]).toEqual([LINE_GONE.title, LINE_GONE.message]);
    expect(setLines).not.toHaveBeenCalled();
    expect(setDraft).not.toHaveBeenCalled();
    expect(sync.forceSync).not.toHaveBeenCalled();
    expect(buttons.map((b) => b.text)).toEqual(['OK']);
    // OK is answered: the screen's effect then reloads or leaves
    // (reloadAfterLineGone, run below).
    expect(setLineGoneAnswered).not.toHaveBeenCalled();
    buttons[0]!.onPress!();
    expect(setLineGoneAnswered).toHaveBeenCalledTimes(1);
  });

  it('the screen runs reloadAfterLineGone each time OK is answered', () => {
    const src = readFileSync(path.resolve(__dirname, '../..', COUNT), 'utf8')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\s+/g, ' ');
    expect(src).toContain(
      'const onLineGoneAnswered = React.useEffectEvent(() => { void reloadAfterLineGone(); });',
    );
    expect(src).toContain(
      'React.useEffect(() => { if (lineGoneAnswered > 0) onLineGoneAnswered(); }, [lineGoneAnswered]);',
    );
  });

  it('a saved count is still marked saved, with nothing said', async () => {
    const { saver, alert, setLines } = lineSaver(
      vi.fn(async () => ({ outboxId: 1, idempotencyKey: 'k1' })),
    );
    saver.persist('l1', '7');
    await settle();
    expect(alert).not.toHaveBeenCalled();
    expect(setLines).toHaveBeenCalledTimes(1);
  });

  function after(opts: { access: string; onPhone: boolean }) {
    const leave = vi.fn();
    const load = vi.fn(async () => undefined);
    const setLoading = vi.fn();
    const run = screenFunction<() => Promise<void>>(COUNT, 'reloadAfterLineGone', {
      id: 'cc1',
      access: opts.access,
      getCycleCount: vi.fn(async () => (opts.onPhone ? { header: {}, lines: [] } : null)),
      leave,
      load,
      setLoading,
      setReadError: vi.fn(),
      setEmptyState: vi.fn(),
    });
    return { run, leave, load };
  }

  it('the count still on this phone: it is read again from the server', async () => {
    const { run, leave, load } = after({ access: 'allowed', onPhone: true });
    await run();
    expect(load).toHaveBeenCalledTimes(1);
    expect(leave).not.toHaveBeenCalled();
  });

  it('the count gone from this phone, or no longer open to the member: the screen is left', async () => {
    for (const opts of [
      { access: 'allowed', onPhone: false },
      { access: 'denied', onPhone: true },
    ]) {
      const { run, leave, load } = after(opts);
      await run();
      expect(leave).toHaveBeenCalledTimes(1);
      expect(load).not.toHaveBeenCalled();
    }
  });
});

describe('the count scanner', () => {
  const SCAN = 'app/cycle-count/scan/[id].tsx';

  function recordCount(updateLocalLine: ReturnType<typeof vi.fn>) {
    const alert = vi.fn();
    const setScannedMap = vi.fn();
    const setLines = vi.fn();
    const setBusy = vi.fn();
    const afterScanLineGone = vi.fn(async () => undefined);
    const sync = syncStub();
    const run = screenFunction<(line: { id: string }, qty: number) => Promise<boolean>>(
      SCAN,
      'recordCount',
      {
        setBusy,
        updateLocalLine,
        reportPhoneSaveFailure,
        countNotSavedAlert,
        COUNT_LINE_NOT_SAVED: LINE_GONE,
        afterScanLineGone,
        Alert: { alert },
        setScannedMap,
        setLines,
        cycleCountSync: sync,
      },
    );
    return { run, alert, setScannedMap, setLines, setBusy, afterScanLineGone, sync };
  }

  it('a line no longer on the phone: said, not tallied, not marked saved; OK frees the scanner and loads again', async () => {
    const { run, alert, setScannedMap, setLines, setBusy, afterScanLineGone, sync } = recordCount(
      vi.fn(async () => null),
    );
    expect(await run({ id: 'l1' }, 3)).toBe(false);
    const [title, message, buttons, options] = alert.mock.calls[0] as [
      string,
      string,
      { text: string; onPress?: () => void }[],
      { onDismiss?: () => void },
    ];
    expect([title, message]).toEqual([LINE_GONE.title, LINE_GONE.message]);
    expect(setScannedMap).not.toHaveBeenCalled();
    expect(setLines).not.toHaveBeenCalled();
    expect(sync.forceSync).not.toHaveBeenCalled();
    // Busy until answered, as for a refused save.
    expect(setBusy).not.toHaveBeenCalledWith(false);
    buttons[0]!.onPress!();
    expect(setBusy).toHaveBeenLastCalledWith(false);
    expect(afterScanLineGone).toHaveBeenCalledTimes(1);
    expect(typeof options.onDismiss).toBe('function');
  });

  function afterScan(onPhone: boolean, access: 'allowed' | 'denied' = 'allowed') {
    const back = vi.fn();
    const setLines = vi.fn();
    const setScannedMap = vi.fn();
    const snap = { lines: [{ id: 'l2', counted: null }] };
    const getCycleCount = vi.fn(async () => (onPhone ? snap : null));
    const run = screenFunction<() => Promise<void>>(SCAN, 'afterScanLineGone', {
      id: 'cc1',
      access,
      getCycleCount,
      router: { back },
      setLines,
      setScannedMap,
    });
    return { run, back, setLines, getCycleCount };
  }

  it('afterwards: the lines on this phone are read again, or the scanner closes when the count is gone', async () => {
    const kept = afterScan(true);
    await kept.run();
    expect(kept.setLines).toHaveBeenCalledWith([{ id: 'l2', counted: null }]);
    expect(kept.back).not.toHaveBeenCalled();
    const gone = afterScan(false);
    await gone.run();
    expect(gone.back).toHaveBeenCalledTimes(1);
  });

  it('afterwards, for a member who may no longer see cycle counts: the scanner closes, nothing is read', async () => {
    const denied = afterScan(true, 'denied');
    await denied.run();
    expect(denied.getCycleCount).not.toHaveBeenCalled();
    expect(denied.back).toHaveBeenCalledTimes(1);
  });

  it('a saved scan is still tallied', async () => {
    const { run, setScannedMap } = recordCount(
      vi.fn(async () => ({ outboxId: 1, idempotencyKey: 'k1' })),
    );
    expect(await run({ id: 'l1' }, 3)).toBe(true);
    expect(setScannedMap).toHaveBeenCalledTimes(1);
  });
});

describe('the words', () => {
  it('are the shared alert', async () => {
    const words = (await import('./count-save-refusal')) as Record<string, unknown>;
    expect(words.COUNT_LINE_NOT_SAVED).toEqual(LINE_GONE);
  });
});
