import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { countFromText } from '@stockpilot/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { screenFunction, stateInitializer } from './__fixtures__/screen-functions';
import {
  countNotClearedAlert,
  countNotSavedAlert,
  createLineGoneNotice,
} from './count-save-refusal';
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
/** The outbox entry a saved count is queued as (made up). */
const QUEUED = { outboxId: 1, idempotencyKey: ['entry', '1'].join('-') };
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
    const notice = createLineGoneNotice(alert);
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
        lineGoneNotice: notice,
        setLineGoneAnswered,
        reportPhoneSaveFailure,
        Alert: { alert },
        setLines,
        setDraft,
        cycleCountSync: sync,
      },
    );
    return { saver: init(), alert, setLines, setDraft, sync, setLineGoneAnswered, notice };
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

  it('one "Count not saved" at a time: a second line gone while it is up says nothing more', async () => {
    const { saver, alert, setLineGoneAnswered } = lineSaver(vi.fn(async () => null));
    saver.persist('l1', '7');
    saver.persist('l2', '8');
    await settle();
    expect(alert).toHaveBeenCalledTimes(1);
    const buttons = alert.mock.calls[0]![2] as { onPress: () => void }[];
    buttons[0]!.onPress();
    // Pressed twice (or dismissed after OK): answered once.
    buttons[0]!.onPress();
    expect(setLineGoneAnswered).toHaveBeenCalledTimes(1);
    // Up again for the next one.
    saver.persist('l3', '9');
    await settle();
    expect(alert).toHaveBeenCalledTimes(2);
  });

  it('after the screen closed: a save that finds the line gone says nothing, and an OK still to come does nothing', async () => {
    const { saver, alert, setLineGoneAnswered, notice } = lineSaver(vi.fn(async () => null));
    saver.persist('l1', '7');
    await settle();
    const buttons = alert.mock.calls[0]![2] as { onPress: () => void }[];
    notice.close();
    buttons[0]!.onPress();
    expect(setLineGoneAnswered).not.toHaveBeenCalled();
    // The unmount's flush saves what was waiting; its answer is not said.
    saver.persist('l2', '8');
    await settle();
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('the screen closes the notice before it flushes the waiting saves on unmount', () => {
    const src = readFileSync(path.resolve(__dirname, '../..', COUNT), 'utf8').replace(/\s+/g, ' ');
    expect(src).toContain('return () => { lineGoneNotice.close(); lineSaver.flushAll(); };');
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
    const { saver, alert, setLines } = lineSaver(vi.fn(async () => QUEUED));
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
    const notice = createLineGoneNotice(alert);
    const run = screenFunction<(line: { id: string }, qty: number) => Promise<boolean>>(
      SCAN,
      'recordCount',
      {
        setBusy,
        updateLocalLine,
        reportPhoneSaveFailure,
        countNotSavedAlert,
        lineGoneNotice: notice,
        afterScanLineGone,
        Alert: { alert },
        setScannedMap,
        setLines,
        cycleCountSync: sync,
      },
    );
    return { run, alert, setScannedMap, setLines, setBusy, afterScanLineGone, sync, notice };
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

  it('one "Count not saved" at a time, and none once the scanner has closed', async () => {
    const { run, alert, afterScanLineGone, notice } = recordCount(vi.fn(async () => null));
    expect(await run({ id: 'l1' }, 3)).toBe(false);
    expect(await run({ id: 'l2' }, 4)).toBe(false);
    expect(alert).toHaveBeenCalledTimes(1);
    notice.close();
    const buttons = alert.mock.calls[0]![2] as { onPress: () => void }[];
    buttons[0]!.onPress();
    // Closed: the scanner does not read again or leave a second time.
    expect(afterScanLineGone).not.toHaveBeenCalled();
    expect(await run({ id: 'l3' }, 5)).toBe(false);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('the scanner closes the notice when it unmounts', () => {
    const src = readFileSync(path.resolve(__dirname, '../..', SCAN), 'utf8').replace(/\s+/g, ' ');
    expect(src).toContain('React.useEffect(() => () => lineGoneNotice.close(), [lineGoneNotice]);');
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
      // The scanner leaves by its own leave (back, or to the Cycle counts
      // tab when nothing is under it: count-scanner-leave.test.ts).
      leave: back,
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
    const { run, setScannedMap } = recordCount(vi.fn(async () => QUEUED));
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
