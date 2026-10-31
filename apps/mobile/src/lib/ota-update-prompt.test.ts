import { existsSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  codeOf,
  createUpdatePromptController,
  EMPTY_MEMORY,
  FOCUS_RECHECK_MS,
  isWorkRoute,
  LAUNCH_SCREEN_GROUND,
  MEMORY_KEY,
  MEMORY_MAX_ENTRIES,
  nativeStateFromContext,
  offerability,
  parseMemory,
  promptBlocker,
  RELOAD_SLOW_MS,
  RESTART_FAILED_MESSAGE,
  RESTART_FAILED_OK,
  RESTART_FAILED_TITLE,
  RESTART_RECORD_MAX_AGE_MS,
  RESTART_SETTLE_MAX_MS,
  RESTART_WATCHDOG_MS,
  RESTARTING_LABEL,
  RETURN_CHECK_MIN_GAP_MS,
  serializeMemory,
  SHOW_SETTLE_MS,
  shouldFetch,
  shouldRunReturnCheck,
  UPDATE_PROMPT_LATER,
  UPDATE_PROMPT_LOCK_ID,
  UPDATE_PROMPT_MESSAGE,
  UPDATE_PROMPT_RESTART,
  UPDATE_PROMPT_TITLE,
  WORK_ROUTES,
  type NativeContextLike,
  type PromptBlocker,
  type PromptInputs,
  type ScreenInputs,
  type UpdateMemory,
  type UpdatePromptController,
  type UpdatePromptDeps,
} from './ota-update-prompt';

/**
 * The phone update pop-up's rules (B44), run with fake dependencies and a
 * fake clock: when "Update ready" shows, what waits for what, what Later and
 * Restart now do, and what the memory remembers between launches.
 */

const RUNNING = 'running-1';
const RUNTIME = 'runtime-now';

const WAITING_U1: NativeContextLike = { isUpdatePending: true, downloadedManifest: { id: 'U1' } };
const WAITING_U2: NativeContextLike = { isUpdatePending: true, downloadedManifest: { id: 'U2' } };
const WAITING_ROLLBACK: NativeContextLike = {
  isUpdatePending: true,
  rollback: { commitTime: '2026-10-30T00:00:00Z' },
};

const SCREEN: ScreenInputs = {
  mounted: true,
  userId: 'user-1',
  routeKey: '(drawer)/(tabs)',
  splashActive: false,
  keyboardVisible: false,
  whatsNewOpen: false,
  slotTaken: false,
};

interface Prompt {
  onLater: () => void;
  onRestartNow: () => void;
}

interface Harness {
  c: UpdatePromptController;
  deps: UpdatePromptDeps;
  spies: {
    showPrompt: ReturnType<typeof vi.fn>;
    showRestartFailed: ReturnType<typeof vi.fn>;
    restart: ReturnType<typeof vi.fn>;
    setSlot: ReturnType<typeof vi.fn>;
    announce: ReturnType<typeof vi.fn>;
    reportOnce: ReturnType<typeof vi.fn>;
    pauseWork: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    settle: ReturnType<typeof vi.fn>;
    checkForUpdate: ReturnType<typeof vi.fn>;
    fetchUpdate: ReturnType<typeof vi.fn>;
    saveMemory: ReturnType<typeof vi.fn>;
    isTextFocused: ReturnType<typeof vi.fn>;
    releaseHoldsUntilReturn: ReturnType<typeof vi.fn>;
  };
  prompts: Prompt[];
  held: { value: boolean };
  focused: { value: boolean };
  stored: { text: string | null };
  /** Every call, in order, of pauseWork, settle, saveMemory and restart. */
  order: string[];
}

type HarnessOver = Partial<UpdatePromptDeps> & { stored?: string | null };

function harness(over: HarnessOver = {}): Harness {
  const { stored: storedText = null, ...depOver } = over;
  const prompts: Prompt[] = [];
  const held = { value: false };
  const focused = { value: false };
  const stored = { text: storedText };
  const order: string[] = [];
  const resume = vi.fn();
  // A replaced restart, settle or check is still recorded by its spy.
  const spies = {
    showPrompt: vi.fn((onLater: () => void, onRestartNow: () => void) => {
      prompts.push({ onLater, onRestartNow });
    }),
    showRestartFailed: vi.fn(),
    restart: vi.fn(() => {
      order.push('restart');
      return depOver.restart ? depOver.restart() : Promise.resolve();
    }),
    setSlot: vi.fn(),
    announce: vi.fn(),
    reportOnce: vi.fn(),
    pauseWork: vi.fn(() => {
      order.push('pause');
      return resume;
    }),
    resume,
    settle: vi.fn(() => {
      order.push('settle');
      return depOver.settle ? depOver.settle() : Promise.resolve();
    }),
    checkForUpdate: vi.fn(() =>
      depOver.checkForUpdate ? depOver.checkForUpdate() : Promise.resolve({ isAvailable: false }),
    ),
    fetchUpdate: vi.fn(async () => {}),
    saveMemory: vi.fn(async (text: string) => {
      order.push(JSON.parse(text).restart ? 'save-restart' : 'save');
      stored.text = text;
    }),
    isTextFocused: vi.fn(() => focused.value),
    releaseHoldsUntilReturn: vi.fn(),
  };
  const deps: UpdatePromptDeps = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    isDev: false,
    isEnabled: true,
    isEmergencyLaunch: false,
    isEmbeddedLaunch: false,
    runningUpdateId: RUNNING,
    runtimeToken: RUNTIME,
    readNative: () => ({}),
    listenNative: () => () => {},
    currentAppState: () => 'active',
    listenAppState: () => () => {},
    isHeld: () => held.value,
    listenHolds: () => () => {},
    releaseHoldsUntilReturn: spies.releaseHoldsUntilReturn,
    isTextFocused: spies.isTextFocused,
    loadMemory: async () => stored.text,
    saveMemory: spies.saveMemory,
    isOnline: async () => true,
    fetchUpdate: spies.fetchUpdate,
    showPrompt: spies.showPrompt,
    showRestartFailed: spies.showRestartFailed,
    pauseWork: spies.pauseWork,
    setSlot: spies.setSlot,
    announce: spies.announce,
    reportOnce: spies.reportOnce,
    ...depOver,
    // Last, so a replacement runs through its spy (above).
    restart: spies.restart,
    settle: spies.settle,
    checkForUpdate: spies.checkForUpdate,
  };
  return {
    c: createUpdatePromptController(deps),
    deps,
    spies,
    prompts,
    held,
    focused,
    stored,
    order,
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** Started, with the memory loaded and `ctx` as the native state. */
async function started(ctx: NativeContextLike = {}, over: HarnessOver = {}): Promise<Harness> {
  const h = harness({ readNative: () => ctx, ...over });
  h.c.start();
  await flush();
  return h;
}

/** Started with U1 waiting, on a clear screen, the pop-up open. */
async function shown(over: HarnessOver = {}): Promise<Harness> {
  const h = await started(WAITING_U1, over);
  h.c.setScreen(SCREEN);
  await advance(SHOW_SETTLE_MS);
  expect(h.spies.showPrompt).toHaveBeenCalledTimes(1);
  return h;
}

/** A return to the app: iOS reports background, then active. */
function returnToApp(h: Harness): void {
  h.c.onAppState('background');
  h.c.onAppState('active');
}

function memoryOf(h: Harness): UpdateMemory {
  return parseMemory(h.stored.text);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-31T09:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the words', () => {
  it('are the owner’s, word for word', () => {
    expect(UPDATE_PROMPT_TITLE).toBe('Update ready');
    expect(UPDATE_PROMPT_MESSAGE).toBe(
      'An update for StockPilot is ready. The app will restart to finish installing it.',
    );
    expect(UPDATE_PROMPT_LATER).toBe('Later');
    expect(UPDATE_PROMPT_RESTART).toBe('Restart now');
    expect(RESTARTING_LABEL).toBe('Restarting StockPilot to finish the update');
    expect(RESTART_FAILED_TITLE).toBe('Update not finished');
    expect(RESTART_FAILED_MESSAGE).toBe(
      'StockPilot could not restart. Close the app and open it again to finish the update.',
    );
    expect(RESTART_FAILED_OK).toBe('OK');
  });

  it('carry no emoji', () => {
    for (const words of [
      UPDATE_PROMPT_TITLE,
      UPDATE_PROMPT_MESSAGE,
      UPDATE_PROMPT_LATER,
      UPDATE_PROMPT_RESTART,
      RESTARTING_LABEL,
      RESTART_FAILED_TITLE,
      RESTART_FAILED_MESSAGE,
      RESTART_FAILED_OK,
    ]) {
      expect(words).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it('keep the fixed names and times', () => {
    expect(UPDATE_PROMPT_LOCK_ID).toBe('update-prompt');
    expect(MEMORY_KEY).toBe('stockpilot.update-prompt.v1');
    expect(MEMORY_MAX_ENTRIES).toBe(10);
    expect(LAUNCH_SCREEN_GROUND).toBe('#0a0f1f');
    expect(RETURN_CHECK_MIN_GAP_MS).toBe(30 * 60_000);
    expect(SHOW_SETTLE_MS).toBe(600);
    expect(FOCUS_RECHECK_MS).toBe(2_000);
    expect(RESTART_SETTLE_MAX_MS).toBe(25_000);
    expect(RELOAD_SLOW_MS).toBe(15_000);
    expect(RESTART_WATCHDOG_MS).toBe(15_000);
  });
});

describe('nativeStateFromContext', () => {
  it('names a downloaded update in lowercase', () => {
    expect(nativeStateFromContext(WAITING_U1)).toEqual({
      pending: true,
      downloaded: { type: 'new', id: 'u1' },
      busy: false,
      lastCheckAt: null,
    });
  });

  it('reads a pending update with no manifest, or a rollback, as a roll back', () => {
    expect(nativeStateFromContext(WAITING_ROLLBACK).downloaded).toEqual({ type: 'rollback' });
    expect(nativeStateFromContext({ isUpdatePending: true }).downloaded).toEqual({
      type: 'rollback',
    });
    expect(nativeStateFromContext({}).downloaded).toBeNull();
    expect(nativeStateFromContext(null)).toEqual({
      pending: false,
      downloaded: null,
      busy: false,
      lastCheckAt: null,
    });
  });

  it('counts the launch check, a check and a download as busy', () => {
    expect(nativeStateFromContext({ isStartupProcedureRunning: true }).busy).toBe(true);
    expect(nativeStateFromContext({ isChecking: true }).busy).toBe(true);
    expect(nativeStateFromContext({ isDownloading: true }).busy).toBe(true);
    expect(nativeStateFromContext({ isUpdatePending: true }).busy).toBe(false);
  });

  it('turns the last check time into milliseconds', () => {
    const at = new Date('2026-10-31T08:00:00Z');
    expect(nativeStateFromContext({ lastCheckForUpdateTime: at }).lastCheckAt).toBe(at.getTime());
    expect(
      nativeStateFromContext({ lastCheckForUpdateTime: '2026-10-31T08:00:00Z' }).lastCheckAt,
    ).toBe(at.getTime());
    expect(nativeStateFromContext({ lastCheckForUpdateTime: 'not a date' }).lastCheckAt).toBeNull();
  });
});

describe('promptBlocker', () => {
  const CLEAR: PromptInputs = {
    never: false,
    memoryLoaded: true,
    offerable: true,
    nativeBusy: false,
    mounted: true,
    splashActive: false,
    appActive: true,
    keyboardVisible: false,
    textFocused: false,
    whatsNewOpen: false,
    slotTaken: false,
    workRoute: false,
    held: false,
    ownState: false,
  };
  // In priority order: each one's blocking value and its reason.
  const EACH: [keyof PromptInputs, boolean, PromptBlocker][] = [
    ['never', true, 'never'],
    ['memoryLoaded', false, 'memory-loading'],
    ['offerable', false, 'not-offerable'],
    ['nativeBusy', true, 'native-busy'],
    ['mounted', false, 'not-in-shell'],
    ['splashActive', true, 'splash'],
    ['appActive', false, 'not-active'],
    ['keyboardVisible', true, 'keyboard'],
    ['textFocused', true, 'text-focus'],
    ['whatsNewOpen', true, 'whats-new'],
    ['slotTaken', true, 'slot-taken'],
    ['workRoute', true, 'work-route'],
    ['held', true, 'held'],
    ['ownState', true, 'own-state'],
  ];

  it('is null when nothing is in the way', () => {
    expect(promptBlocker(CLEAR)).toBeNull();
  });

  it.each(EACH)('%s alone blocks with its own reason', (key, value, reason) => {
    expect(promptBlocker({ ...CLEAR, [key]: value })).toBe(reason);
  });

  it('answers in a stable order when several block', () => {
    let inputs: PromptInputs = { ...CLEAR };
    for (const [key, value] of EACH) inputs = { ...inputs, [key]: value };
    for (const [key, , reason] of EACH) {
      expect(promptBlocker(inputs)).toBe(reason);
      inputs = { ...inputs, [key]: CLEAR[key] };
    }
    expect(promptBlocker(inputs)).toBeNull();
  });
});

describe('the work routes', () => {
  it('are each a real screen', () => {
    const app = path.resolve(__dirname, '../../app');
    for (const key of WORK_ROUTES) {
      const file = path.join(app, `${key}.tsx`);
      const index = path.join(app, key, 'index.tsx');
      expect(existsSync(file) || existsSync(index), key).toBe(true);
    }
  });

  it('cover scanning, counting, new records and review, and not the home tabs', () => {
    for (const key of [
      '(drawer)/(tabs)/scan',
      'scan-po',
      'cycle-count/[id]',
      'cycle-count/new',
      'item/new',
      'order/new/checkout',
      'po-import/[id]',
    ]) {
      expect(isWorkRoute(key), key).toBe(true);
    }
    for (const key of ['(drawer)/(tabs)', '(drawer)/(tabs)/items', 'item/[id]', '']) {
      expect(isWorkRoute(key), key).toBe(false);
    }
  });
});

describe('shouldRunReturnCheck', () => {
  const now = Date.parse('2026-10-31T09:00:00Z');
  const base = {
    never: false,
    online: true,
    nativeBusy: false,
    ownCheckRunning: false,
    promptBusy: false,
    now,
    lastCheckAt: null,
    lastAttemptAt: null,
  };

  it('checks when nothing was checked yet, or the last check is 30 minutes old', () => {
    expect(shouldRunReturnCheck(base)).toBe(true);
    expect(shouldRunReturnCheck({ ...base, lastCheckAt: now - 31 * 60_000 })).toBe(true);
    expect(shouldRunReturnCheck({ ...base, lastCheckAt: now - 30 * 60_000 })).toBe(true);
  });

  it('waits 30 minutes from the later of the native check and its own attempt', () => {
    expect(shouldRunReturnCheck({ ...base, lastCheckAt: now - 29 * 60_000 })).toBe(false);
    expect(shouldRunReturnCheck({ ...base, lastAttemptAt: now - 29 * 60_000 })).toBe(false);
    expect(
      shouldRunReturnCheck({
        ...base,
        lastCheckAt: now - 40 * 60_000,
        lastAttemptAt: now - 29 * 60_000,
      }),
    ).toBe(false);
  });

  it.each([
    ['never', { never: true }],
    ['offline', { online: false }],
    ['native busy', { nativeBusy: true }],
    ['its own check running', { ownCheckRunning: true }],
    ['the pop-up open or restarting', { promptBusy: true }],
  ])('does not check when %s', (_label, over) => {
    expect(shouldRunReturnCheck({ ...base, ...over })).toBe(false);
  });
});

describe('shouldFetch', () => {
  it('downloads a new update that is not the waiting one', () => {
    expect(shouldFetch({ isAvailable: true, manifest: { id: 'u2' } }, null)).toBe(true);
    expect(
      shouldFetch({ isAvailable: true, manifest: { id: 'u2' } }, { type: 'new', id: 'u1' }),
    ).toBe(true);
    expect(shouldFetch({ isAvailable: true, manifest: { id: 'u2' } }, { type: 'rollback' })).toBe(
      true,
    );
  });

  it('does not download the waiting update again, in either letter case', () => {
    expect(
      shouldFetch({ isAvailable: true, manifest: { id: 'U1' } }, { type: 'new', id: 'u1' }),
    ).toBe(false);
    expect(
      shouldFetch({ isAvailable: true, manifest: { id: 'u1' } }, { type: 'new', id: 'u1' }),
    ).toBe(false);
  });

  it('does not download an update that failed before, or one with no id', () => {
    expect(shouldFetch({ isAvailable: false, reason: 'updatePreviouslyFailed' }, null)).toBe(false);
    expect(shouldFetch({ isAvailable: true, manifest: {} }, null)).toBe(false);
    expect(shouldFetch({ isAvailable: true, manifest: null }, null)).toBe(false);
  });

  it('downloads a roll back only when none is waiting', () => {
    expect(shouldFetch({ isAvailable: false, isRollBackToEmbedded: true }, null)).toBe(true);
    expect(
      shouldFetch({ isAvailable: false, isRollBackToEmbedded: true }, { type: 'new', id: 'u1' }),
    ).toBe(true);
    expect(
      shouldFetch({ isAvailable: false, isRollBackToEmbedded: true }, { type: 'rollback' }),
    ).toBe(false);
  });
});

describe('codeOf', () => {
  it('keeps an error code and nothing else', () => {
    expect(codeOf(Object.assign(new Error('x'), { code: 'ERR_UPDATES_RELOAD' }))).toBe(
      'ERR_UPDATES_RELOAD',
    );
    expect(codeOf(new Error('ERR_UPDATES_RELOAD'))).toBeNull();
    expect(codeOf({ code: 'a message with words' })).toBeNull();
    expect(codeOf(null)).toBeNull();
    expect(codeOf('ERR')).toBeNull();
  });
});

describe('the memory', () => {
  it('reads what it wrote, and anything unreadable as empty', () => {
    const memory: UpdateMemory = {
      v: 1,
      waiting: [{ id: 'u1', from: RUNNING, runtime: 'r', reported: false }],
      restart: { from: RUNNING, at: 5 },
    };
    expect(parseMemory(serializeMemory(memory))).toEqual(memory);
    for (const text of [null, '', '{not json', 'null', '{"v":2,"waiting":[]}', '{"v":1}']) {
      expect(parseMemory(text)).toEqual(EMPTY_MEMORY);
    }
    expect(
      parseMemory(
        '{"v":1,"waiting":[{"id":"u1"},{"id":"u2","from":null,"runtime":"r","reported":true}]}',
      ),
    ).toEqual({
      v: 1,
      waiting: [{ id: 'u2', from: null, runtime: 'r', reported: true }],
      restart: null,
    });
  });

  it('keeps the last ten entries', () => {
    const waiting = Array.from({ length: 12 }, (_, i) => ({
      id: `a${i}`,
      from: RUNNING,
      runtime: 'r',
      reported: false,
    }));
    const text = serializeMemory({ v: 1, waiting, restart: null });
    expect(parseMemory(text).waiting.map((e) => e.id)).toEqual(waiting.slice(2).map((e) => e.id));
  });
});

describe('offerability', () => {
  const running = { updateId: RUNNING, isEmbeddedLaunch: false };

  it('never offers the update already running, in either letter case', () => {
    expect(offerability({ type: 'new', id: 'running-1' }, running, EMPTY_MEMORY, RUNTIME)).toBe(
      'same-as-running',
    );
    expect(
      offerability(
        { type: 'new', id: 'running-1' },
        { updateId: 'RUNNING-1', isEmbeddedLaunch: false },
        EMPTY_MEMORY,
        RUNTIME,
      ),
    ).toBe('same-as-running');
    expect(
      offerability(
        { type: 'rollback' },
        { updateId: null, isEmbeddedLaunch: true },
        EMPTY_MEMORY,
        RUNTIME,
      ),
    ).toBe('same-as-running');
  });

  it('calls passed over an update an earlier launch of this same version saw waiting', () => {
    const memory: UpdateMemory = {
      v: 1,
      waiting: [{ id: 'u1', from: RUNNING, runtime: 'earlier', reported: false }],
      restart: null,
    };
    expect(offerability({ type: 'new', id: 'u1' }, running, memory, RUNTIME)).toBe('passed-over');
    // The same launch that saw it first may offer it.
    expect(offerability({ type: 'new', id: 'u1' }, running, memory, 'earlier')).toBe('offerable');
    expect(offerability({ type: 'new', id: 'u2' }, running, memory, RUNTIME)).toBe('offerable');
  });
});

describe('when the pop-up shows', () => {
  it('shows 600 ms after nothing is in the way, once, holding the slot', async () => {
    const h = await started(WAITING_U1);
    expect(h.c.getBlocker()).toBe('not-in-shell');
    h.c.setScreen(SCREEN);
    expect(h.c.getPhase()).toBe('settling');
    await advance(SHOW_SETTLE_MS - 1);
    expect(h.spies.showPrompt).not.toHaveBeenCalled();
    await advance(1);
    expect(h.spies.showPrompt).toHaveBeenCalledTimes(1);
    expect(h.c.getPhase()).toBe('open');
    expect(h.spies.setSlot.mock.calls).toEqual([[true]]);

    // Open: nothing shows it twice, and the slot stays held.
    h.c.setScreen({ routeKey: '(drawer)/(tabs)/items' });
    h.c.onHoldsChanged();
    h.c.setNative(WAITING_U1);
    await advance(60_000);
    expect(h.spies.showPrompt).toHaveBeenCalledTimes(1);
    expect(h.spies.setSlot.mock.calls).toEqual([[true]]);
  });

  it('starts the 600 ms again when something gets in the way meanwhile', async () => {
    const h = await started(WAITING_U1);
    h.c.setScreen(SCREEN);
    await advance(300);
    h.c.setScreen({ keyboardVisible: true });
    expect(h.c.getBlocker()).toBe('keyboard');
    await advance(5_000);
    expect(h.spies.showPrompt).not.toHaveBeenCalled();
    h.c.setScreen({ keyboardVisible: false });
    await advance(SHOW_SETTLE_MS - 1);
    expect(h.spies.showPrompt).not.toHaveBeenCalled();
    await advance(1);
    expect(h.spies.showPrompt).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the launch animation', { splashActive: true }, 'splash'],
    ['What’s New', { whatsNewOpen: true }, 'whats-new'],
    ['a tour or a notice in the slot', { slotTaken: true }, 'slot-taken'],
    ['a scan', { routeKey: '(drawer)/(tabs)/scan' }, 'work-route'],
    ['a count', { routeKey: 'cycle-count/[id]' }, 'work-route'],
    ['the sign-in screens', { mounted: false }, 'not-in-shell'],
  ] as const)('waits for %s', async (_label, over, reason) => {
    const h = await started(WAITING_U1);
    h.c.setScreen({ ...SCREEN, ...over });
    await advance(30_000);
    expect(h.c.getBlocker()).toBe(reason);
    expect(h.spies.showPrompt).not.toHaveBeenCalled();
    h.c.setScreen(SCREEN);
    await advance(SHOW_SETTLE_MS);
    expect(h.spies.showPrompt).toHaveBeenCalledTimes(1);
  });

  it('waits for a hold (a sheet, an alert, a photo, a draft, a write)', async () => {
    const h = await started(WAITING_U1);
    h.held.value = true;
    h.c.setScreen(SCREEN);
    await advance(30_000);
    expect(h.c.getBlocker()).toBe('held');
    h.held.value = false;
    h.c.onHoldsChanged();
    await advance(SHOW_SETTLE_MS);
    expect(h.spies.showPrompt).toHaveBeenCalledTimes(1);
  });

  it('waits for the app to be active and for native update work', async () => {
    const h = await started({ ...WAITING_U1, isDownloading: true });
    h.c.setScreen(SCREEN);
    expect(h.c.getBlocker()).toBe('native-busy');
    h.c.setNative(WAITING_U1);
    h.c.onAppState('inactive');
    expect(h.c.getBlocker()).toBe('not-active');
    await advance(10_000);
    h.c.onAppState('active');
    await advance(SHOW_SETTLE_MS);
    expect(h.spies.showPrompt).toHaveBeenCalledTimes(1);
  });

  it('looks again every 2 s while a field has focus, and leaves no timer behind', async () => {
    const h = await started(WAITING_U1);
    h.focused.value = true;
    h.c.setScreen(SCREEN);
    expect(h.c.getBlocker()).toBe('text-focus');
    const looks = h.spies.isTextFocused.mock.calls.length;
    await advance(FOCUS_RECHECK_MS * 3);
    expect(h.spies.isTextFocused.mock.calls.length).toBe(looks + 3);
    expect(h.spies.showPrompt).not.toHaveBeenCalled();

    await advance(500);
    h.focused.value = false;
    await advance(FOCUS_RECHECK_MS + SHOW_SETTLE_MS);
    expect(h.spies.showPrompt).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops looking when the update stops waiting', async () => {
    const h = await started(WAITING_U1);
    h.focused.value = true;
    h.c.setScreen(SCREEN);
    expect(vi.getTimerCount()).toBe(1);
    h.c.setNative({});
    expect(h.c.getPhase()).toBe('idle');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows a roll back with the same pop-up', async () => {
    const h = await started(WAITING_ROLLBACK);
    h.c.setScreen(SCREEN);
    await advance(SHOW_SETTLE_MS);
    expect(h.spies.showPrompt).toHaveBeenCalledTimes(1);
  });

  it('never shows in development, with updates off, or after an emergency launch', async () => {
    for (const over of [{ isDev: true }, { isEnabled: false }, { isEmergencyLaunch: true }]) {
      const h = await started(WAITING_U1, over);
      h.c.setScreen(SCREEN);
      returnToApp(h);
      await advance(60_000);
      expect(h.c.getPhase()).toBe('never');
      expect(h.spies.showPrompt).not.toHaveBeenCalled();
      expect(h.spies.checkForUpdate).not.toHaveBeenCalled();
      expect(h.spies.restart).not.toHaveBeenCalled();
    }
  });

  it('reports an emergency launch once', async () => {
    const h = await started(WAITING_U1, { isEmergencyLaunch: true });
    h.c.start();
    h.c.start();
    expect(h.spies.reportOnce.mock.calls).toEqual([['emergency-launch', null]]);
  });

  it('a hold until the next return (a tapped notification) keeps it away until then', async () => {
    vi.resetModules();
    const holds = await import('./update-prompt-holds');
    const h = await started(WAITING_U1, {
      isHeld: holds.isUpdatePromptHeld,
      listenHolds: holds.subscribeUpdatePromptHolds,
      releaseHoldsUntilReturn: holds.releaseHoldsUntilReturn,
    });
    holds.holdUpdatePromptUntilReturn('notification-open');
    h.c.setScreen(SCREEN);
    await advance(60_000);
    expect(h.c.getBlocker()).toBe('held');
    h.c.onAppState('inactive');
    h.c.onAppState('active');
    await advance(60_000);
    expect(h.spies.showPrompt).not.toHaveBeenCalled();

    returnToApp(h);
    await advance(SHOW_SETTLE_MS);
    expect(holds.isUpdatePromptHeld()).toBe(false);
    expect(h.spies.showPrompt).toHaveBeenCalledTimes(1);
    await advance(60_000);
    expect(h.spies.showPrompt).toHaveBeenCalledTimes(1);
  });
});

describe('Later', () => {
  it('gives the slot back and keeps the pop-up away for the rest of this return', async () => {
    const h = await shown();
    h.prompts[0]!.onLater();
    expect(h.c.getPhase()).toBe('dismissed');
    expect(h.spies.setSlot.mock.calls).toEqual([[true], [false]]);

    h.c.setScreen({ routeKey: '(drawer)/(tabs)/items' });
    h.c.setScreen({ routeKey: '(drawer)/(tabs)' });
    h.c.onHoldsChanged();
    h.c.setNative(WAITING_U1);
    h.c.setNative(WAITING_U2);
    h.c.onAppState('inactive');
    h.c.onAppState('active');
    await advance(60_000);
    expect(h.spies.showPrompt).toHaveBeenCalledTimes(1);
    expect(h.spies.restart).not.toHaveBeenCalled();
  });

  it('shows it again, once, at the next return to the app', async () => {
    const h = await shown();
    h.prompts[0]!.onLater();
    returnToApp(h);
    await advance(SHOW_SETTLE_MS);
    expect(h.spies.showPrompt).toHaveBeenCalledTimes(2);
    await advance(60_000);
    expect(h.spies.showPrompt).toHaveBeenCalledTimes(2);
  });

  it('lasts for the person who tapped it: another person sees it', async () => {
    const h = await shown();
    h.prompts[0]!.onLater();
    // The same person signs out and back in, in the same return.
    h.c.setScreen({ mounted: false });
    h.c.setScreen({ mounted: true, userId: 'user-1' });
    await advance(10_000);
    expect(h.spies.showPrompt).toHaveBeenCalledTimes(1);
    // Someone else signs in.
    h.c.setScreen({ mounted: false });
    h.c.setScreen({ mounted: true, userId: 'user-2' });
    await advance(SHOW_SETTLE_MS);
    expect(h.spies.showPrompt).toHaveBeenCalledTimes(2);
  });

  it('works after the screen behind the alert has gone', async () => {
    const h = await shown();
    h.c.setScreen({ mounted: false });
    h.prompts[0]!.onLater();
    expect(h.c.getPhase()).toBe('dismissed');
    expect(h.spies.setSlot).toHaveBeenLastCalledWith(false);
  });
});

describe('Restart now', () => {
  it('covers the app, pauses work, lets it settle, writes the record, then restarts once', async () => {
    let finishSettle!: () => void;
    const h = await shown({
      settle: vi.fn(() => {
        return new Promise<void>((resolve) => {
          finishSettle = resolve;
        });
      }),
    });
    h.order.length = 0;
    h.prompts[0]!.onRestartNow();
    expect(h.c.getPhase()).toBe('restarting');
    expect(h.spies.announce).toHaveBeenCalledWith(RESTARTING_LABEL);
    expect(h.spies.pauseWork).toHaveBeenCalledTimes(1);
    await advance(1_000);
    expect(h.spies.restart).not.toHaveBeenCalled();
    finishSettle();
    await flush();
    expect(h.spies.restart).toHaveBeenCalledTimes(1);
    expect(h.order).toEqual(['pause', 'settle', 'save-restart', 'restart']);
    expect(memoryOf(h).restart).toEqual({ from: RUNNING, at: Date.now() });
    // The slot stays held through the restart.
    expect(h.spies.setSlot.mock.calls).toEqual([[true]]);
  });

  it('pauses work before it waits for it', async () => {
    const h = await shown();
    h.order.length = 0;
    h.prompts[0]!.onRestartNow();
    await flush();
    expect(h.order).toEqual(['pause', 'settle', 'save-restart', 'restart']);
  });

  it('restarts after 25 s when work never settles', async () => {
    const h = await shown({ settle: vi.fn(() => new Promise<void>(() => {})) });
    h.prompts[0]!.onRestartNow();
    await advance(RESTART_SETTLE_MAX_MS - 1);
    expect(h.spies.restart).not.toHaveBeenCalled();
    await advance(1);
    expect(h.spies.restart).toHaveBeenCalledTimes(1);
  });

  it('waits for a download already running', async () => {
    const h = await shown();
    h.c.setNative({ ...WAITING_U2, isDownloading: true });
    h.prompts[0]!.onRestartNow();
    await advance(5_000);
    expect(h.spies.restart).not.toHaveBeenCalled();
    h.c.setNative(WAITING_U2);
    await flush();
    expect(h.spies.restart).toHaveBeenCalledTimes(1);
  });

  it('never restarts in the background: it waits for the app to be active', async () => {
    const h = await shown();
    h.prompts[0]!.onRestartNow();
    h.c.onAppState('background');
    await advance(60_000);
    expect(h.spies.restart).not.toHaveBeenCalled();
    h.c.onAppState('active');
    await flush();
    expect(h.spies.restart).toHaveBeenCalledTimes(1);
    // That return made no update check: the restart is under way.
    expect(h.spies.checkForUpdate).not.toHaveBeenCalled();
  });

  it('restarts exactly once, and nothing else ever restarts', async () => {
    const h = await shown();
    h.prompts[0]!.onRestartNow();
    h.prompts[0]!.onRestartNow();
    void h.c.onRestartNow();
    await flush();
    h.prompts[0]!.onLater();
    h.c.setNative(WAITING_U2);
    h.c.setScreen(SCREEN);
    h.c.onHoldsChanged();
    returnToApp(h);
    await h.c.runReturnCheck();
    await advance(10_000);
    expect(h.spies.restart).toHaveBeenCalledTimes(1);
  });

  it('keeps the cover up and reports once when the restart is slow', async () => {
    const h = await shown({ restart: vi.fn(() => new Promise<void>(() => {})) });
    h.prompts[0]!.onRestartNow();
    await advance(RELOAD_SLOW_MS - 1);
    expect(h.spies.reportOnce).not.toHaveBeenCalled();
    await advance(1);
    expect(h.spies.reportOnce.mock.calls).toEqual([['reload-slow', null]]);
    await advance(120_000);
    expect(h.spies.reportOnce).toHaveBeenCalledTimes(1);
    expect(h.c.getPhase()).toBe('restarting');
    expect(h.spies.setSlot.mock.calls).toEqual([[true]]);
    expect(h.spies.showRestartFailed).not.toHaveBeenCalled();
  });

  it('says so when the restart is refused, and never offers it again in this launch', async () => {
    const error = Object.assign(new Error('Could not reload'), { code: 'ERR_UPDATES_RELOAD' });
    const h = await shown({
      restart: vi.fn(async () => {
        throw error;
      }),
    });
    h.prompts[0]!.onRestartNow();
    await flush();
    expect(h.c.getPhase()).toBe('failed');
    expect(h.spies.setSlot).toHaveBeenLastCalledWith(false);
    expect(h.spies.resume).toHaveBeenCalledTimes(1);
    expect(memoryOf(h).restart).toBeNull();
    expect(h.spies.showRestartFailed).toHaveBeenCalledTimes(1);
    expect(h.spies.reportOnce.mock.calls).toEqual([['reload-rejected', 'ERR_UPDATES_RELOAD']]);

    // Nothing brings it back, and nothing reports again.
    h.c.setNative(WAITING_U2);
    returnToApp(h);
    h.prompts[0]!.onRestartNow();
    await advance(60_000);
    expect(h.spies.showPrompt).toHaveBeenCalledTimes(1);
    expect(h.spies.restart).toHaveBeenCalledTimes(1);
    expect(h.spies.reportOnce).toHaveBeenCalledTimes(1);
    expect(h.spies.showRestartFailed).toHaveBeenCalledTimes(1);
  });

  it('treats a restart that never came as failed, 15 s after it was promised', async () => {
    const h = await shown();
    h.prompts[0]!.onRestartNow();
    await flush();
    expect(h.spies.restart).toHaveBeenCalledTimes(1);
    await advance(RESTART_WATCHDOG_MS - 1);
    expect(h.c.getPhase()).toBe('restarting');
    await advance(1);
    expect(h.c.getPhase()).toBe('failed');
    expect(h.spies.reportOnce.mock.calls).toEqual([['reload-stuck', null]]);
    expect(h.spies.showRestartFailed).toHaveBeenCalledTimes(1);
    expect(h.spies.resume).toHaveBeenCalledTimes(1);
    expect(h.spies.setSlot).toHaveBeenLastCalledWith(false);
  });

  it('a newer download while the pop-up is open changes nothing: one pop-up, one restart', async () => {
    const h = await shown();
    h.c.setNative({ ...WAITING_U2, isDownloading: true });
    h.c.setNative(WAITING_U2);
    await advance(10_000);
    expect(h.spies.showPrompt).toHaveBeenCalledTimes(1);
    h.prompts[0]!.onRestartNow();
    await flush();
    expect(h.spies.restart).toHaveBeenCalledTimes(1);
  });

  it('works after the screen behind the alert has gone', async () => {
    const h = await shown();
    h.c.setScreen({ mounted: false });
    h.prompts[0]!.onRestartNow();
    await flush();
    expect(h.spies.restart).toHaveBeenCalledTimes(1);
  });
});

describe('the return check', () => {
  it('checks once when the app comes back, and downloads only something new', async () => {
    const h = await started(
      {},
      {
        checkForUpdate: vi.fn(async () => ({ isAvailable: true, manifest: { id: 'u9' } })),
      },
    );
    returnToApp(h);
    await flush();
    expect(h.spies.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(h.spies.fetchUpdate).toHaveBeenCalledTimes(1);
    expect(h.spies.releaseHoldsUntilReturn).toHaveBeenCalledTimes(1);
  });

  it('a check that throws counts as an attempt', async () => {
    const h = await started(
      {},
      { checkForUpdate: vi.fn(async () => Promise.reject(new Error('x'))) },
    );
    returnToApp(h);
    await flush();
    returnToApp(h);
    await flush();
    expect(h.spies.checkForUpdate).toHaveBeenCalledTimes(1);
    await advance(RETURN_CHECK_MIN_GAP_MS);
    returnToApp(h);
    await flush();
    expect(h.spies.checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it('holds the pop-up while it runs', async () => {
    let finishCheck!: () => void;
    const h = await started(WAITING_U1, {
      checkForUpdate: vi.fn(
        () =>
          new Promise<{ isAvailable: boolean }>((resolve) => {
            finishCheck = () => resolve({ isAvailable: false });
          }),
      ),
    });
    returnToApp(h);
    h.c.setScreen(SCREEN);
    await flush();
    expect(h.c.getBlocker()).toBe('native-busy');
    await advance(10_000);
    expect(h.spies.showPrompt).not.toHaveBeenCalled();
    finishCheck();
    await advance(SHOW_SETTLE_MS);
    expect(h.spies.showPrompt).toHaveBeenCalledTimes(1);
  });
});

describe('the memory between launches', () => {
  function stored(memory: Partial<UpdateMemory>): string {
    return JSON.stringify({ ...EMPTY_MEMORY, ...memory });
  }

  it('waits for the memory before it offers anything, and reads unreadable memory as empty', async () => {
    let finishLoad!: (text: string) => void;
    const h = harness({
      readNative: () => WAITING_U1,
      loadMemory: () =>
        new Promise<string | null>((resolve) => {
          finishLoad = resolve;
        }),
    });
    h.c.start();
    h.c.setScreen(SCREEN);
    await advance(10_000);
    expect(h.c.getBlocker()).toBe('memory-loading');
    expect(h.spies.showPrompt).not.toHaveBeenCalled();
    finishLoad('{not json');
    await advance(SHOW_SETTLE_MS);
    expect(h.spies.showPrompt).toHaveBeenCalledTimes(1);
  });

  it('writes a newly waiting update down, and keeps the last ten', async () => {
    const waiting = Array.from({ length: 10 }, (_, i) => ({
      id: `a${i}`,
      from: RUNNING,
      runtime: RUNTIME,
      reported: false,
    }));
    const h = await started(WAITING_U1, { stored: stored({ waiting }) });
    h.c.setScreen(SCREEN);
    await advance(SHOW_SETTLE_MS);
    expect(h.spies.showPrompt).toHaveBeenCalledTimes(1);
    const ids = memoryOf(h).waiting.map((e) => e.id);
    expect(ids).toEqual([...waiting.slice(1).map((e) => e.id), 'u1']);
    expect(memoryOf(h).waiting.at(-1)).toEqual({
      id: 'u1',
      from: RUNNING,
      runtime: RUNTIME,
      reported: false,
    });
  });

  it('never offers an update this version passed over at an earlier launch, and reports it once ever', async () => {
    const first = await started(WAITING_U1, {
      stored: stored({
        waiting: [{ id: 'u1', from: RUNNING, runtime: 'earlier', reported: false }],
      }),
    });
    first.c.setScreen(SCREEN);
    await advance(60_000);
    expect(first.c.getBlocker()).toBe('not-offerable');
    expect(first.spies.showPrompt).not.toHaveBeenCalled();
    expect(first.spies.reportOnce.mock.calls).toEqual([['update-passed-over', null]]);
    expect(memoryOf(first).waiting).toEqual([
      { id: 'u1', from: RUNNING, runtime: 'earlier', reported: true },
    ]);

    // The next launch remembers it reported.
    const second = await started(WAITING_U1, {
      stored: first.stored.text,
      runtimeToken: 'later',
    });
    second.c.setScreen(SCREEN);
    await advance(60_000);
    expect(second.spies.showPrompt).not.toHaveBeenCalled();
    expect(second.spies.reportOnce).not.toHaveBeenCalled();
  });

  it('forgets what was seen under another version, and offers the update', async () => {
    const h = await started(WAITING_U1, {
      stored: stored({
        waiting: [{ id: 'u1', from: 'older-0', runtime: 'earlier', reported: true }],
      }),
    });
    h.c.setScreen(SCREEN);
    await advance(SHOW_SETTLE_MS);
    expect(h.spies.showPrompt).toHaveBeenCalledTimes(1);
    expect(memoryOf(h).waiting).toEqual([
      { id: 'u1', from: RUNNING, runtime: RUNTIME, reported: false },
    ]);
  });

  it('never offers the update already running, or a roll back while the built-in update runs', async () => {
    const same = await started({ isUpdatePending: true, downloadedManifest: { id: 'RUNNING-1' } });
    same.c.setScreen(SCREEN);
    await advance(60_000);
    expect(same.c.getBlocker()).toBe('not-offerable');

    const embedded = await started(WAITING_ROLLBACK, {
      isEmbeddedLaunch: true,
      runningUpdateId: null,
    });
    embedded.c.setScreen(SCREEN);
    await advance(60_000);
    expect(embedded.c.getBlocker()).toBe('not-offerable');
    expect(same.spies.showPrompt).not.toHaveBeenCalled();
    expect(embedded.spies.showPrompt).not.toHaveBeenCalled();
  });

  it('reports a restart that left the same version running, once, and clears the record', async () => {
    const h = await started({}, { stored: stored({ restart: { from: RUNNING, at: 1 } }) });
    expect(h.spies.reportOnce.mock.calls).toEqual([['restart-no-change', null]]);
    expect(memoryOf(h).restart).toBeNull();
  });

  it('clears the record of a restart that worked, without a report', async () => {
    const h = await started({}, { stored: stored({ restart: { from: 'older-0', at: 1 } }) });
    expect(h.spies.reportOnce).not.toHaveBeenCalled();
    expect(memoryOf(h).restart).toBeNull();
  });
});

/**
 * "Keep me signed in" (B57) signs out at a real close but not at Restart now's
 * restart. The start clears the record from storage before any screen can
 * read it, so the controller keeps what the start found.
 */
describe('the restart record at start', () => {
  function stored(memory: Partial<UpdateMemory>): string {
    return JSON.stringify({ ...EMPTY_MEMORY, ...memory });
  }

  it('reports the record the start found, after the start has cleared it from storage', async () => {
    const record = { from: 'older-0', at: Date.now() - 3_000 };
    const h = await started({}, { stored: stored({ restart: record }) });
    expect(memoryOf(h).restart).toBeNull();
    expect(await h.c.restartRecordAtStart()).toEqual(record);
    // Reading it again gives the same answer, and the answer is a copy.
    const again = await h.c.restartRecordAtStart();
    expect(again).toEqual(record);
    again!.from = 'changed';
    expect(await h.c.restartRecordAtStart()).toEqual(record);
  });

  it('a restart that left the same version running is still a restart', async () => {
    const record = { from: RUNNING, at: Date.now() - 3_000 };
    const h = await started({}, { stored: stored({ restart: record }) });
    expect(await h.c.restartRecordAtStart()).toEqual(record);
    expect(h.spies.reportOnce.mock.calls).toEqual([['restart-no-change', null]]);
  });

  it('an ordinary open from closed has none', async () => {
    const empty = await started();
    expect(await empty.c.restartRecordAtStart()).toBeNull();
    const withList = await started(WAITING_U1, {
      stored: stored({ waiting: [{ id: 'u1', from: RUNNING, runtime: 'x', reported: false }] }),
    });
    expect(await withList.c.restartRecordAtStart()).toBeNull();
  });

  it('the record Restart now saves belongs to the next runtime, not this one', async () => {
    const h = await shown();
    h.prompts[0]!.onRestartNow();
    await flush();
    expect(h.spies.restart).toHaveBeenCalledTimes(1);
    expect(memoryOf(h).restart).toEqual({ from: RUNNING, at: Date.now() });
    expect(await h.c.restartRecordAtStart()).toBeNull();

    // The restart: a new runtime on the new update finds it.
    await advance(2_000);
    const next = await started({}, { stored: h.stored.text, runningUpdateId: 'u1' });
    expect(await next.c.restartRecordAtStart()).toEqual({ from: RUNNING, at: Date.now() - 2_000 });
    expect(memoryOf(next).restart).toBeNull();
  });

  it('a record older than a minute is from a restart that never came: an ordinary open', async () => {
    const edge = await started(
      {},
      {
        stored: stored({
          restart: { from: 'older-0', at: Date.now() - RESTART_RECORD_MAX_AGE_MS },
        }),
      },
    );
    expect(await edge.c.restartRecordAtStart()).not.toBeNull();

    const old = await started(
      {},
      {
        stored: stored({
          restart: { from: 'older-0', at: Date.now() - RESTART_RECORD_MAX_AGE_MS - 1 },
        }),
      },
    );
    expect(await old.c.restartRecordAtStart()).toBeNull();
    // Cleared all the same.
    expect(memoryOf(old).restart).toBeNull();
  });

  it('waits for the memory, and loads it when asked before the start; once', async () => {
    let finishLoad!: (text: string | null) => void;
    const loadMemory = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          finishLoad = resolve;
        }),
    );
    const h = harness({ loadMemory });
    let answer: unknown = 'pending';
    void h.c.restartRecordAtStart().then((r) => {
      answer = r;
    });
    await flush();
    expect(loadMemory).toHaveBeenCalledTimes(1);
    expect(answer).toBe('pending');
    h.c.start();
    finishLoad(stored({ restart: { from: 'older-0', at: Date.now() } }));
    await flush();
    expect(answer).toEqual({ from: 'older-0', at: Date.now() });
    expect(loadMemory).toHaveBeenCalledTimes(1);
  });

  it('unreadable memory is no record, never a rejection', async () => {
    const failed = await started({}, { loadMemory: () => Promise.reject(new Error('disk')) });
    await expect(failed.c.restartRecordAtStart()).resolves.toBeNull();
    const garbled = await started({}, { stored: '{not json' });
    await expect(garbled.c.restartRecordAtStart()).resolves.toBeNull();
  });

  it('an emergency launch after Restart now reads and clears the record too, and keeps the waiting list for the passed-over check', async () => {
    const record = { from: RUNNING, at: Date.now() - 3_000 };
    const waiting = [{ id: 'u1', from: RUNNING, runtime: 'earlier', reported: false }];
    const emergency = await started(
      {},
      {
        stored: stored({ restart: record, waiting }),
        isEmergencyLaunch: true,
        isEmbeddedLaunch: true,
        runningUpdateId: 'embedded-0',
      },
    );
    expect(await emergency.c.restartRecordAtStart()).toEqual(record);
    expect(memoryOf(emergency)).toEqual({ v: 1, waiting, restart: null });
    expect(emergency.spies.reportOnce.mock.calls).toEqual([['emergency-launch', null]]);

    // The next open from closed runs the update from before and is no restart;
    // the update that would not start is still never offered.
    const next = await started(WAITING_U1, {
      stored: emergency.stored.text,
      runtimeToken: 'later',
    });
    next.c.setScreen(SCREEN);
    await advance(60_000);
    expect(await next.c.restartRecordAtStart()).toBeNull();
    expect(next.c.getBlocker()).toBe('not-offerable');
    expect(next.spies.showPrompt).not.toHaveBeenCalled();
  });

  it('in development or with updates off, an empty memory is left alone', async () => {
    for (const over of [{ isDev: true }, { isEnabled: false }]) {
      const h = await started(WAITING_U1, over);
      expect(await h.c.restartRecordAtStart()).toBeNull();
      expect(h.spies.saveMemory).not.toHaveBeenCalled();
    }
  });
});
