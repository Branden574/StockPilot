import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The phone update, run through the real hook (use-ota-updates.ts) with
 * expo-updates and React Native replaced (B44).
 *
 * The owner's rule: the app opens once, with one launch screen. A new update
 * downloads quietly (expo-updates' own launch check does that), then a pop-up
 * says it is ready, and the app restarts only when Restart now is tapped. The
 * old hook checked, downloaded and reloaded by itself on every open from
 * closed, so a fresh update showed the launch screen twice with no reason.
 *
 * Each case loads a fresh copy of the module (it keeps one controller per
 * JavaScript runtime) under vi.doMock, and runs the hook in a stand-in React
 * (HookHost, from phone-shell-structure.test.ts) with fake timers.
 */

const OWNER_MESSAGE =
  'An update for StockPilot is ready. The app will restart to finish installing it.';

/**
 * Just enough of React's hooks to run one custom hook outside a renderer:
 * state cells, effects that run after a render when their dependencies change
 * (the previous cleanup first), a re-render when state changes from outside a
 * render, and an unmount that runs every cleanup.
 */
class HookHost<T> {
  private states: unknown[] = [];
  private effects: { deps?: readonly unknown[]; cleanup?: () => void }[] = [];
  private queue: (() => void)[] = [];
  private stateIndex = 0;
  private effectIndex = 0;
  private dirty = false;
  private rendering = false;
  value!: T;

  constructor(private readonly hook: () => T) {}

  readonly React = {
    useState: <S>(init: S | (() => S)): readonly [S, (next: S | ((prev: S) => S)) => void] => {
      const i = this.stateIndex++;
      if (i >= this.states.length) {
        this.states.push(typeof init === 'function' ? (init as () => S)() : init);
      }
      const set = (next: S | ((prev: S) => S)) => {
        const prev = this.states[i] as S;
        const value = typeof next === 'function' ? (next as (p: S) => S)(prev) : next;
        if (Object.is(value, prev)) return;
        this.states[i] = value;
        if (this.rendering) this.dirty = true;
        else this.render();
      };
      return [this.states[i] as S, set] as const;
    },
    useEffect: (fn: () => (() => void) | void, deps?: readonly unknown[]) => {
      const i = this.effectIndex++;
      const prev = this.effects[i];
      const changed =
        !prev ||
        !deps ||
        !prev.deps ||
        deps.length !== prev.deps.length ||
        deps.some((d, k) => !Object.is(d, prev.deps![k]));
      if (!changed) return;
      this.queue.push(() => {
        prev?.cleanup?.();
        const cleanup = fn();
        this.effects[i] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
      });
    },
  };

  render(): T {
    this.rendering = true;
    do {
      this.dirty = false;
      this.stateIndex = 0;
      this.effectIndex = 0;
      this.value = this.hook();
      for (const run of this.queue.splice(0)) run();
    } while (this.dirty);
    this.rendering = false;
    return this.value;
  }

  unmount(): void {
    for (const e of this.effects) e?.cleanup?.();
  }
}

/** The native updates context as expo-updates' emitter hands it to JavaScript. */
interface NativeContext {
  isStartupProcedureRunning: boolean;
  isUpdateAvailable: boolean;
  isUpdatePending: boolean;
  isChecking: boolean;
  isDownloading: boolean;
  isRestarting: boolean;
  restartCount: number;
  sequenceNumber: number;
  downloadProgress: number;
  downloadedManifest?: { id: string };
  rollback?: { commitTime: string };
  lastCheckForUpdateTime?: Date;
}

function nativeContext(over: Partial<NativeContext> = {}): NativeContext {
  return {
    isStartupProcedureRunning: false,
    isUpdateAvailable: false,
    isUpdatePending: false,
    isChecking: false,
    isDownloading: false,
    isRestarting: false,
    restartCount: 0,
    sequenceNumber: 1,
    downloadProgress: 0,
    ...over,
  };
}

interface AlertButtonLike {
  text?: string;
  style?: string;
  isPreferred?: boolean;
  onPress?: (value?: string) => void;
}

/** What the screen around the pop-up looks like (UpdatePromptHost feeds it). */
const CLEAR_SCREEN = {
  mounted: true,
  userId: 'user-1',
  routeKey: '(drawer)/(tabs)',
  splashActive: false,
  keyboardVisible: false,
  whatsNewOpen: false,
  slotTaken: false,
};

/** Today's module and the new one, read loosely so both load here. */
interface OtaModule {
  useOtaUpdates?: () => void;
  useOtaAutoReload?: () => void;
  updatePrompt?: {
    setScreen(screen: Partial<typeof CLEAR_SCREEN>): void;
    getPhase(): string;
  };
}

interface Loaded {
  mod: OtaModule;
  host: HookHost<void>;
  updates: ReturnType<typeof updatesMock>;
  alert: ReturnType<typeof vi.fn>;
  appState: { current: string; listeners: Set<(state: string) => void> };
  storage: Map<string, string>;
  online: { value: boolean };
  sentry: { captureMessage: ReturnType<typeof vi.fn> };
}

function updatesMock(over: { context?: NativeContext; flags?: Record<string, unknown> } = {}) {
  const listeners = new Set<(event: { context: NativeContext }) => void>();
  const mock = {
    isEnabled: true,
    isEmergencyLaunch: false,
    isEmbeddedLaunch: false,
    updateId: 'running-1',
    ...over.flags,
    latestContext: over.context ?? nativeContext(),
    checkForUpdateAsync: vi.fn(async () => ({
      isAvailable: true,
      isRollBackToEmbedded: false,
      manifest: { id: 'u1' },
    })),
    fetchUpdateAsync: vi.fn(async () => ({
      isNew: true,
      isRollBackToEmbedded: false,
      manifest: { id: 'u1' },
    })),
    reloadAsync: vi.fn(async (_options?: unknown) => {}),
    addUpdatesStateChangeListener: vi.fn((fn: (event: { context: NativeContext }) => void) => {
      listeners.add(fn);
      return {
        remove() {
          listeners.delete(fn);
        },
      };
    }),
    /** A native state change, as the emitter delivers it. */
    emit(context: NativeContext) {
      mock.latestContext = context;
      for (const fn of [...listeners]) fn({ context });
    },
  };
  return mock;
}

async function load(
  over: {
    context?: NativeContext;
    flags?: Record<string, unknown>;
    dev?: boolean;
    storage?: Record<string, string>;
  } = {},
): Promise<Loaded> {
  vi.resetModules();
  (globalThis as Record<string, unknown>).__DEV__ = over.dev ?? false;
  const updates = updatesMock(over);
  const alert = vi.fn();
  const appState = { current: 'active', listeners: new Set<(state: string) => void>() };
  const storage = new Map(Object.entries(over.storage ?? {}));
  const online = { value: true };
  const sentry = { captureMessage: vi.fn() };
  let mod: OtaModule = {};
  const host = new HookHost<void>(() => {
    const hook = mod.useOtaUpdates ?? mod.useOtaAutoReload;
    hook?.();
  });

  vi.doMock('react', () => ({ ...host.React, default: host.React }));
  vi.doMock('expo-updates', () => updates);
  vi.doMock('react-native', () => ({
    Alert: { alert },
    AppState: {
      get currentState() {
        return appState.current;
      },
      addEventListener: (_type: string, fn: (state: string) => void) => {
        appState.listeners.add(fn);
        return { remove: () => appState.listeners.delete(fn) };
      },
    },
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
    TextInput: { State: { currentlyFocusedInput: () => null } },
    Platform: { OS: 'ios' },
  }));
  vi.doMock('@react-native-async-storage/async-storage', () => ({
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
  }));
  vi.doMock('./sync', () => ({
    isOnline: vi.fn(async () => online.value),
    pauseSyncForRestart: vi.fn(() => () => {}),
    whenSyncSettled: vi.fn(async () => {}),
  }));
  vi.doMock('./cycle-count-sync', () => ({
    cycleCountSync: {
      pauseForRestart: vi.fn(() => () => {}),
      whenIdle: vi.fn(async () => {}),
    },
  }));
  vi.doMock('./sentry', () => ({
    Sentry: {
      captureMessage: sentry.captureMessage,
      withScope: (fn: (scope: { addEventProcessor: () => void }) => void) =>
        fn({ addEventProcessor: () => {} }),
    },
  }));
  vi.doMock('./restart-screen', () => ({
    LAUNCH_ICON: 1,
    RESTART_SCREEN: {
      backgroundColor: '#0a0f1f',
      image: 1,
      imageResizeMode: 'contain',
      imageFullScreen: false,
      spinner: { enabled: false },
      fade: true,
    },
  }));

  mod = (await import('./use-ota-updates')) as unknown as OtaModule;
  return { mod, host, updates, alert, appState, storage, online, sentry };
}

/** Moves AppState the way iOS reports it, to every listener. */
function setAppState(l: Loaded, state: string) {
  l.appState.current = state;
  for (const fn of [...l.appState.listeners]) fn(state);
}

let current: Loaded | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-31T09:00:00Z'));
});

afterEach(() => {
  current?.host.unmount();
  current = null;
  vi.useRealTimers();
  vi.resetModules();
  for (const name of [
    'react',
    'expo-updates',
    'react-native',
    '@react-native-async-storage/async-storage',
    './sync',
    './cycle-count-sync',
    './sentry',
    './restart-screen',
  ]) {
    vi.doUnmock(name);
  }
});

async function mount(over: Parameters<typeof load>[0] = {}): Promise<Loaded> {
  current = await load(over);
  current.host.render();
  await vi.advanceTimersByTimeAsync(0);
  return current;
}

function promptButtons(l: Loaded, call = 0): AlertButtonLike[] {
  return (l.alert.mock.calls[call]?.[2] ?? []) as AlertButtonLike[];
}

describe('no restart without a tap (B44)', () => {
  it('an update on the server never restarts the app without a tap', async () => {
    const l = await mount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(l.updates.reloadAsync).not.toHaveBeenCalled();
  });

  it('the open from closed makes no JavaScript update check', async () => {
    const l = await mount();
    await vi.advanceTimersByTimeAsync(5_000);
    // expo-updates checks at every open from closed by itself; a second check
    // from JavaScript only doubled the requests (and fed the old reload).
    expect(l.updates.checkForUpdateAsync).not.toHaveBeenCalled();
    expect(l.updates.fetchUpdateAsync).not.toHaveBeenCalled();
  });

  it('a downloaded update shows the pop-up, and only Restart now restarts', async () => {
    const l = await mount({
      context: nativeContext({
        isUpdatePending: true,
        isUpdateAvailable: true,
        downloadedManifest: { id: 'U1' },
      }),
    });
    l.mod.updatePrompt?.setScreen(CLEAR_SCREEN);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(l.updates.reloadAsync).not.toHaveBeenCalled();

    expect(l.alert).toHaveBeenCalledTimes(1);
    const [title, message] = l.alert.mock.calls[0]!;
    expect(title).toBe('Update ready');
    expect(message).toBe(OWNER_MESSAGE);
    const buttons = promptButtons(l);
    expect(buttons.map((b) => [b.text, b.style ?? null, b.isPreferred ?? false])).toEqual([
      ['Later', 'cancel', false],
      ['Restart now', null, true],
    ]);

    buttons[1]!.onPress!();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(l.updates.reloadAsync).toHaveBeenCalledTimes(1);
    expect(l.updates.reloadAsync.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ reloadScreenOptions: expect.any(Object) }),
    );
  });
});

describe('the check on a return to the app', () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

  async function returnToApp(l: Loaded) {
    setAppState(l, 'background');
    setAppState(l, 'active');
    await vi.advanceTimersByTimeAsync(0);
  }

  it('checks once after 30 minutes, downloads what is new, and never restarts', async () => {
    const l = await mount({ context: nativeContext({ lastCheckForUpdateTime: minutesAgo(31) }) });
    await returnToApp(l);
    expect(l.updates.checkForUpdateAsync).toHaveBeenCalledTimes(1);
    expect(l.updates.fetchUpdateAsync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(l.updates.reloadAsync).not.toHaveBeenCalled();
  });

  it('does not check 29 minutes after the last check, native or its own', async () => {
    const l = await mount({ context: nativeContext({ lastCheckForUpdateTime: minutesAgo(29) }) });
    await returnToApp(l);
    expect(l.updates.checkForUpdateAsync).not.toHaveBeenCalled();

    const own = await mount({ context: nativeContext({ lastCheckForUpdateTime: minutesAgo(31) }) });
    await returnToApp(own);
    expect(own.updates.checkForUpdateAsync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    await returnToApp(own);
    expect(own.updates.checkForUpdateAsync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await returnToApp(own);
    expect(own.updates.checkForUpdateAsync).toHaveBeenCalledTimes(2);
  });

  it('does not check on inactive to active (Face ID, Control Center, the app switcher)', async () => {
    const l = await mount();
    setAppState(l, 'inactive');
    setAppState(l, 'active');
    await vi.advanceTimersByTimeAsync(0);
    expect(l.updates.checkForUpdateAsync).not.toHaveBeenCalled();
  });

  it('does not check offline, and checks at the next return once online', async () => {
    const l = await mount();
    l.online.value = false;
    await returnToApp(l);
    expect(l.updates.checkForUpdateAsync).not.toHaveBeenCalled();
    l.online.value = true;
    await returnToApp(l);
    expect(l.updates.checkForUpdateAsync).toHaveBeenCalledTimes(1);
  });

  it('does not check while expo-updates is checking or downloading', async () => {
    const l = await mount({ context: nativeContext({ isDownloading: true }) });
    await returnToApp(l);
    expect(l.updates.checkForUpdateAsync).not.toHaveBeenCalled();
  });

  it('does not check while the pop-up is open or the app is restarting', async () => {
    const l = await mount({
      context: nativeContext({ isUpdatePending: true, downloadedManifest: { id: 'U1' } }),
    });
    l.mod.updatePrompt?.setScreen(CLEAR_SCREEN);
    await vi.advanceTimersByTimeAsync(600);
    expect(l.alert).toHaveBeenCalledTimes(1);
    await returnToApp(l);
    expect(l.updates.checkForUpdateAsync).not.toHaveBeenCalled();

    promptButtons(l)[1]!.onPress!();
    await returnToApp(l);
    expect(l.updates.checkForUpdateAsync).not.toHaveBeenCalled();
  });

  it('two returns during one check make one check', async () => {
    const l = await mount();
    l.updates.checkForUpdateAsync.mockImplementation(() => new Promise(() => {}));
    await returnToApp(l);
    await returnToApp(l);
    expect(l.updates.checkForUpdateAsync).toHaveBeenCalledTimes(1);
  });

  it('a check that fails waits for the next eligible return', async () => {
    const l = await mount();
    l.updates.checkForUpdateAsync.mockRejectedValue(new Error('offline'));
    await returnToApp(l);
    await returnToApp(l);
    expect(l.updates.checkForUpdateAsync).toHaveBeenCalledTimes(1);
    expect(l.updates.fetchUpdateAsync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await returnToApp(l);
    expect(l.updates.checkForUpdateAsync).toHaveBeenCalledTimes(2);
  });

  it('does not download the update already waiting, in either letter case', async () => {
    const l = await mount({
      context: nativeContext({ isUpdatePending: true, downloadedManifest: { id: 'U1' } }),
    });
    l.updates.checkForUpdateAsync.mockResolvedValue({
      isAvailable: true,
      isRollBackToEmbedded: false,
      manifest: { id: 'u1' },
    });
    await returnToApp(l);
    expect(l.updates.checkForUpdateAsync).toHaveBeenCalledTimes(1);
    expect(l.updates.fetchUpdateAsync).not.toHaveBeenCalled();
  });

  it('does not download an update that failed to launch before', async () => {
    const l = await mount();
    l.updates.checkForUpdateAsync.mockResolvedValue({
      isAvailable: false,
      isRollBackToEmbedded: false,
      reason: 'updatePreviouslyFailed',
    } as never);
    await returnToApp(l);
    expect(l.updates.checkForUpdateAsync).toHaveBeenCalledTimes(1);
    expect(l.updates.fetchUpdateAsync).not.toHaveBeenCalled();
  });

  it('downloads a roll back once: not again while one is waiting', async () => {
    const rollback = { isAvailable: false, isRollBackToEmbedded: true } as never;
    const waiting = await mount({
      context: nativeContext({
        isUpdatePending: true,
        rollback: { commitTime: '2026-10-30T00:00:00Z' },
      }),
    });
    waiting.updates.checkForUpdateAsync.mockResolvedValue(rollback);
    await returnToApp(waiting);
    expect(waiting.updates.checkForUpdateAsync).toHaveBeenCalledTimes(1);
    expect(waiting.updates.fetchUpdateAsync).not.toHaveBeenCalled();

    const none = await mount();
    none.updates.checkForUpdateAsync.mockResolvedValue(rollback);
    await returnToApp(none);
    expect(none.updates.fetchUpdateAsync).toHaveBeenCalledTimes(1);
  });
});

describe('never in development, with updates off, or after an emergency launch', () => {
  const pending = nativeContext({ isUpdatePending: true, downloadedManifest: { id: 'U1' } });

  it.each([
    ['development', { dev: true }],
    ['updates off', { flags: { isEnabled: false } }],
    ['an emergency launch', { flags: { isEmergencyLaunch: true } }],
  ] as const)('%s: no check, no pop-up, no restart', async (_label, over) => {
    const l = await mount({ context: pending, ...over });
    l.mod.updatePrompt?.setScreen(CLEAR_SCREEN);
    setAppState(l, 'background');
    setAppState(l, 'active');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(l.updates.checkForUpdateAsync).not.toHaveBeenCalled();
    expect(l.updates.fetchUpdateAsync).not.toHaveBeenCalled();
    expect(l.alert).not.toHaveBeenCalled();
    expect(l.updates.reloadAsync).not.toHaveBeenCalled();
  });

  it('an emergency launch sends one warning, however often the app renders', async () => {
    const l = await mount({ flags: { isEmergencyLaunch: true } });
    l.host.render();
    l.host.render();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(l.sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(l.sentry.captureMessage).toHaveBeenCalledWith('ota-update-prompt warning', {
      level: 'warning',
      tags: { feature: 'ota-update-prompt', stage: 'emergency-launch' },
      fingerprint: ['ota-update-prompt', 'emergency-launch'],
    });
  });
});
