import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { screenFunction } from './__fixtures__/screen-functions';
import { createOneAlert } from './count-save-refusal';

/** What the count screens say (screen-access.ts CYCLE_COUNTS_NOT_AVAILABLE, pinned there). */
const CYCLE_COUNTS_NOT_AVAILABLE = 'Cycle counts are not available to you in this workspace.';
const NOT_SYNCED_YET =
  'This phone has not finished syncing this workspace yet. Check your connection and try again.';
const SAVED_ACCESS_UNREADABLE =
  'What this phone saved about your access could not be read. Try again.';
type ScreenAccess = 'unknown' | 'unreadable' | 'not-synced' | 'allowed' | 'denied';

/**
 * THE COUNT SCANNERS OPEN THE COUNT SAVED ON THIS PHONE ONLY FOR A MEMBER WHO
 * MAY SEE CYCLE COUNTS (S75).
 *
 * The barcode scanner (cycle-count/scan/[id].tsx) and the AI shelf scan
 * (cycle-count/ai-scan/[id].tsx) read the count's lines from the phone, and
 * can be opened by a link as well as from the count screen. They now ask the
 * count screen's question first (screen-access.ts, the side menu's rule): a
 * member who may not is told so and taken back, nothing is read; until it is
 * known, nothing is read. A member who may keeps every path as before.
 *
 * Each screen's own load function is RUN here (screen-functions.ts).
 */

const SCAN = 'app/cycle-count/scan/[id].tsx';
const AI_SCAN = 'app/cycle-count/ai-scan/[id].tsx';
const COUNT_ID = '0a000000-0000-0000-0000-0000000000b2';
const LINES = [{ id: 'l1', counted: 3 }];

function harness(file: string, name: string, access: ScreenAccess, fetchedHere = false) {
  const getCycleCount = vi.fn(async () => ({ header: { id: COUNT_ID }, lines: LINES }));
  const countStoredForLiveAccount = vi.fn(async () => fetchedHere);
  const alert = vi.fn();
  const back = vi.fn();
  const shown: unknown[] = [];
  const run = screenFunction<() => Promise<void>>(file, name, {
    id: COUNT_ID,
    cycleCountId: COUNT_ID,
    access,
    CYCLE_COUNTS_NOT_AVAILABLE,
    NOT_SYNCED_YET,
    SAVED_ACCESS_UNREADABLE,
    countStoredForLiveAccount,
    getCycleCount,
    Alert: { alert },
    // One alert at a time, and its OK leaves (count-scanner-leave.test.ts).
    openNotice: createOneAlert(alert),
    leave: back,
    router: { back },
    setLines: (v: unknown) => shown.push(v),
    setCachedLines: (v: unknown) => shown.push(v),
    setScannedMap: () => undefined,
  });
  return { run, getCycleCount, alert, back, shown };
}

describe.each([
  ['the barcode scanner', SCAN, 'loadLines'],
  ['the AI shelf scan', AI_SCAN, 'loadCachedLines'],
] as const)('%s', (_label, file, name) => {
  it('a member who may see cycle counts gets the lines saved on this phone, as before', async () => {
    const h = harness(file, name, 'allowed');
    await h.run();
    expect(h.getCycleCount).toHaveBeenCalledWith(COUNT_ID);
    expect(h.shown).toContainEqual(LINES);
    expect(h.alert).not.toHaveBeenCalled();
  });

  it('a member who may not is told so and taken back; nothing is read', async () => {
    const h = harness(file, name, 'denied');
    await h.run();
    expect(h.getCycleCount).not.toHaveBeenCalled();
    expect(h.shown).toEqual([]);
    expect(h.alert).toHaveBeenCalledTimes(1);
    const [, message, buttons] = h.alert.mock.calls[0] as [
      string,
      string,
      { onPress: () => void }[],
    ];
    expect(message).toBe(CYCLE_COUNTS_NOT_AVAILABLE);
    buttons[0]!.onPress();
    expect(h.back).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['not synced yet, not fetched here by this account', 'not-synced', NOT_SYNCED_YET],
    ['the saved access could not be read', 'unreadable', SAVED_ACCESS_UNREADABLE],
  ] as const)('%s: said and taken back; nothing is read', async (_l, access, words) => {
    const h = harness(file, name, access);
    await h.run();
    expect(h.getCycleCount).not.toHaveBeenCalled();
    expect(h.shown).toEqual([]);
    expect(h.alert.mock.calls[0]![1]).toBe(words);
    (h.alert.mock.calls[0]![2] as { onPress: () => void }[])[0]!.onPress();
    expect(h.back).toHaveBeenCalledTimes(1);
  });

  it('not synced yet, a count this account fetched here: its lines, as before', async () => {
    const h = harness(file, name, 'not-synced', true);
    await h.run();
    expect(h.getCycleCount).toHaveBeenCalledWith(COUNT_ID);
    expect(h.shown).toContainEqual(LINES);
    expect(h.alert).not.toHaveBeenCalled();
  });

  it('before it is known, nothing is read and nothing is said', async () => {
    const h = harness(file, name, 'unknown');
    await h.run();
    expect(h.getCycleCount).not.toHaveBeenCalled();
    expect(h.alert).not.toHaveBeenCalled();
  });

  it("asks the count screen's question, and loads again when the answer changes", () => {
    const src = readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
    expect(src).toContain("const access = useDrawerEntryAccess('/cycle-counts');");
    // Both also name the workspace (another workspace's lines are cleared
    // before the read).
    expect(src).toMatch(/\}, \[user, (id|cycleCountId), orgId, access\]\);/);
  });
});
