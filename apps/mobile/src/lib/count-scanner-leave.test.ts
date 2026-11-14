import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { effectCallback, screenFunction } from './__fixtures__/screen-functions';

/** What the count screens say (screen-access.ts, pinned there). */
const NOT_SYNCED_YET =
  'This phone has not finished syncing this workspace yet. Check your connection and try again.';
type ScreenAccess = 'unknown' | 'unreadable' | 'not-synced' | 'allowed' | 'denied';

/**
 * A COUNT SCANNER OPENED STRAIGHT FROM A LINK: ONE ALERT FOR ONE CAUSE, AND A
 * WAY OUT.
 *
 * The barcode scanner and the AI shelf scan read the count's lines each time
 * the account, the workspace or the member's access changes. Opened from a
 * link on a phone that had not finished syncing, every one of those reads
 * refused with its own alert, so the lab walk saw three stacked at once. And
 * with the scanner the only screen (nothing under it), Done and the alerts'
 * OK went back to nothing and the scanner stayed. Now one alert is up at a
 * time, its OK leaves, and Done (Cancel on the AI scan) leaves to the Cycle
 * counts tab when there is nothing to go back to, as the count screen does.
 *
 * Each screen's own functions are RUN here (screen-functions.ts).
 */

const SCAN = 'app/cycle-count/scan/[id].tsx';
const AI_SCAN = 'app/cycle-count/ai-scan/[id].tsx';
const COUNT_ID = '0a000000-0000-0000-0000-0000000000e1';
const LINES = [{ id: 'l1', counted: null, itemBarcode: '0001', itemSku: 'P-1' }];

const flat = (file: string) =>
  readFileSync(path.resolve(__dirname, '../..', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ');

/** The one-at-a-time alert the screens hold (count-save-refusal.ts). */
async function oneAlert(alert: unknown) {
  const mod = (await import('./count-save-refusal')) as Record<string, unknown>;
  const make = mod.createOneAlert as
    ((show: unknown) => { say: unknown; close: () => void }) | undefined;
  return make ? make(alert) : undefined;
}

async function loader(
  file: string,
  name: string,
  opts: {
    access: ScreenAccess;
    stored?: unknown;
    fetchedHere?: boolean;
    shared?: { alert: ReturnType<typeof vi.fn<(...a: unknown[]) => void>>; notice: unknown };
  },
) {
  const alert = opts.shared?.alert ?? vi.fn<(...a: unknown[]) => void>();
  const back = vi.fn();
  const leave = vi.fn();
  const shown: unknown[] = [];
  const getCycleCount = vi.fn(async () =>
    opts.stored === undefined ? { lines: LINES } : opts.stored,
  );
  const run = screenFunction<() => Promise<void>>(file, name, {
    id: COUNT_ID,
    cycleCountId: COUNT_ID,
    access: opts.access,
    CYCLE_COUNTS_NOT_AVAILABLE: 'Cycle counts are not available to you in this workspace.',
    NOT_SYNCED_YET,
    SAVED_ACCESS_UNREADABLE:
      'What this phone saved about your access could not be read. Try again.',
    countStoredForLiveAccount: async () => opts.fetchedHere ?? false,
    getCycleCount,
    Alert: { alert },
    openNotice: opts.shared ? opts.shared.notice : await oneAlert(alert),
    router: { back },
    leave,
    setLines: (v: unknown) => shown.push(v),
    setCachedLines: (v: unknown) => shown.push(v),
    setScannedMap: () => undefined,
  });
  return { run, alert, back, leave, shown, getCycleCount };
}

describe.each([
  ['the barcode scanner', SCAN, 'loadLines'],
  ['the AI shelf scan', AI_SCAN, 'loadCachedLines'],
] as const)('%s', (_label, file, name) => {
  it('one cause, one alert: the reads that run again as the account, workspace or access change say it once', async () => {
    const h = await loader(file, name, { access: 'not-synced' });
    await h.run();
    await h.run();
    await h.run();
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(h.alert.mock.calls[0]![1]).toBe(NOT_SYNCED_YET);
    expect(h.shown).toEqual([]);
  });

  it('no lines on this phone, then refused: still one alert at a time', async () => {
    const alert = vi.fn<(...a: unknown[]) => void>();
    const shared = { alert, notice: await oneAlert(alert) };
    const none = await loader(file, name, { access: 'allowed', stored: null, shared });
    const refused = await loader(file, name, { access: 'not-synced', shared });
    await none.run();
    await refused.run();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0]![0]).toBe('No cached lines');
  });

  it("the alert's OK leaves, once", async () => {
    const h = await loader(file, name, { access: 'not-synced' });
    await h.run();
    const buttons = h.alert.mock.calls[0]![2] as { onPress: () => void }[];
    buttons[0]!.onPress();
    buttons[0]!.onPress();
    expect(h.leave).toHaveBeenCalledTimes(1);
    expect(h.back).not.toHaveBeenCalled();
  });

  it('leaving goes back when there is a screen to go back to, else to the Cycle counts tab', () => {
    const replace = vi.fn();
    const back = vi.fn();
    const leave = screenFunction<() => void>(file, 'leave', {
      router: { canGoBack: () => false, back, replace },
    });
    leave();
    expect(replace).toHaveBeenCalledWith('/cycle-counts');
    expect(back).not.toHaveBeenCalled();
    const withHistory = screenFunction<() => void>(file, 'leave', {
      router: { canGoBack: () => true, back, replace },
    });
    withHistory();
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('Done (Cancel on the AI scan) leaves the same way, and nothing goes back to nothing', () => {
    const code = flat(file);
    expect(code).toMatch(
      /onPress=\{leave\} accessibilityRole="button" accessibilityLabel="(Done|Cancel)"/,
    );
    // Back only inside leave, which falls back to the tab.
    expect(code.match(/router\.back\(\)/g)).toHaveLength(1);
  });
});

/**
 * WHERE THE LINES THE WALK SAW CAME FROM.
 *
 * In the walk, the scanner was open on a count while account A was signed in
 * and its access allowed, so it read A's lines from A's store. A signed out
 * (the store was wiped) and in again with the same scanner still mounted: on
 * 3b256b65a its read effect returned early with nobody signed in and never
 * cleared, so the lines and the tally read for A's first session stayed drawn
 * after the sign-out, and the scans against them found no line in the wiped
 * store ("Count not saved"). Since round 3 the effect clears what it drew
 * when the account changes (count-access-refresh.ts countLoadClearsScreen),
 * before it reads; the read then draws only what the store answers for the
 * account signed in (screen-access.ts, cycle-count-cache.ts).
 */
describe('the barcode scanner: lines only from a read for the account signed in', () => {
  it('replays the walk: A reads, A signs out (the lines go), A signs in not synced (nothing drawn)', async () => {
    const { countLoadClearsScreen, mergeScannedCounts } = await import('./count-access-refresh');
    const drawn = { lines: [] as unknown[], tally: new Map() as Map<string, number> };
    const lastLinesKey = { current: null };
    const step = async (user: { id: string } | null, access: ScreenAccess) => {
      const h = await loader(SCAN, 'loadLines', { access });
      const loadLines = screenFunction<() => Promise<void>>(SCAN, 'loadLines', {
        id: COUNT_ID,
        access,
        CYCLE_COUNTS_NOT_AVAILABLE: 'x',
        NOT_SYNCED_YET,
        SAVED_ACCESS_UNREADABLE: 'y',
        countStoredForLiveAccount: async () => false,
        getCycleCount: async () => ({ lines: LINES }),
        mergeScannedCounts,
        Alert: { alert: h.alert },
        openNotice: await oneAlert(h.alert),
        router: { back: h.back },
        leave: h.leave,
        setLines: (v: unknown[]) => {
          drawn.lines = v;
        },
        setScannedMap: (v: unknown) => {
          drawn.tally =
            typeof v === 'function'
              ? (v as (p: Map<string, number>) => Map<string, number>)(drawn.tally)
              : (v as Map<string, number>);
        },
      });
      const effect = effectCallback<() => void>(SCAN, 'void loadLines()', {
        id: COUNT_ID,
        orgId: 'org-a',
        user,
        access,
        lastLinesKey,
        countLoadClearsScreen,
        loadLines,
        setLines: (v: unknown[]) => {
          drawn.lines = v;
        },
        setScannedMap: (v: Map<string, number>) => {
          drawn.tally = v;
        },
        setSheet: () => undefined,
        countLoadDraftAction: () => 'drop',
      });
      effect();
      await new Promise((r) => setTimeout(r, 0));
    };
    await step({ id: 'user-a' }, 'allowed');
    expect(drawn.lines).toEqual(LINES);
    await step(null, 'allowed');
    expect(drawn.lines).toEqual([]);
    expect(drawn.tally.size).toBe(0);
    await step({ id: 'user-a' }, 'not-synced');
    expect(drawn.lines).toEqual([]);
  });
});
