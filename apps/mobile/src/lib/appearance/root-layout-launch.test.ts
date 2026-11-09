import type { GlassRollout } from '@stockpilot/core';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppearanceController, type AppearanceController } from './controller';
import { PHONE_APPEARANCE_KEYS, type AppearanceStorage } from './store';

/**
 * WHAT A COLD LAUNCH DRAWS AT fontsReady (stage 4 audit F2).
 *
 * app/_layout.tsx holds the status bar, RootGate (with the Face ID lock and
 * every screen), the crash notice and the cold-launch splash until the
 * appearance is ready. Under EXPO_PUBLIC_LIQUID_GLASS=off nothing the stored
 * appearance says can change what is drawn (classic, following the device),
 * so the launch must be main's: the splash and RootGate mount the moment the
 * fonts are ready, whatever AsyncStorage is doing. Under 'default' and
 * 'opt-in' the hold is R9's design (a Classic chooser never sees a frame of
 * glass, a glass chooser never one of classic), capped at 4 s; what it shows
 * is the font gate's own ground, Classic's dark splash paper, and nothing
 * else.
 *
 * The suite has no React Native renderer (see touch-target.test.ts), so the
 * real root layout module is rendered here by a small stand-in renderer:
 * React's hook dispatcher is set to one that keeps each component's hook
 * state, runs mount effects once after the first pass, and reads contexts
 * from the providers above. The appearance provider and controller are the
 * real ones; the native modules and the screens below the root are stand-ins
 * that are only their names.
 */

// ── Stand-ins for everything native under the root ───────────────────────

const env = vi.hoisted(() => ({
  controller: null as unknown as AppearanceController,
  scheme: 'light' as 'light' | 'dark',
}));

vi.mock('react-native', () => ({
  View: 'View',
  Platform: { OS: 'ios', Version: '26.0' },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
  AccessibilityInfo: {
    isReduceTransparencyEnabled: () => new Promise(() => undefined),
    addEventListener: () => ({ remove: () => undefined }),
  },
  Appearance: { setColorScheme: () => undefined },
  useColorScheme: () => env.scheme,
}));
vi.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: 'GestureHandlerRootView',
}));
vi.mock('expo-router', () => ({
  Stack: 'Stack',
  useRouter: () => ({}),
  useSegments: () => [],
}));
vi.mock('expo-status-bar', () => ({ StatusBar: 'StatusBar' }));
vi.mock('expo-network', () => ({
  addNetworkStateListener: () => ({ remove: () => undefined }),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));

// The appearance layer: the real provider, context and theme, over the
// controller each test creates.
vi.mock('./singleton', () => ({ getAppearanceController: () => env.controller }));
vi.mock('./glass-module', () => ({ getGlassModule: () => null }));
vi.mock('./device-class', () => ({ isThisDeviceLowEnd: () => false }));
vi.mock('@/lib/appearance/provider', () => import('./provider'));
vi.mock('@/lib/use-theme', () => import('../use-theme'));
vi.mock('@/lib/theme', () => import('../theme'));
vi.mock('@/lib/appearance/session-bridge', () => ({
  AppearanceSessionBridge: 'AppearanceSessionBridge',
}));

// The root's own dependencies, each only its name.
vi.mock('@/components/account-disabled-screen', () => ({
  AccountDisabledScreen: 'AccountDisabledScreen',
}));
vi.mock('@/components/appearance-fallback-notice', () => ({
  AppearanceFallbackNotice: 'AppearanceFallbackNotice',
}));
vi.mock('@/components/biometric-lock-screen', () => ({
  BiometricLockScreen: 'BiometricLockScreen',
}));
vi.mock('@/components/cold-launch-splash', () => ({ ColdLaunchSplash: 'ColdLaunchSplash' }));
vi.mock('@/components/error-boundary', () => ({ AppErrorBoundary: 'AppErrorBoundary' }));
vi.mock('@/components/mfa-challenge-screen', () => ({
  MfaChallengeScreen: 'MfaChallengeScreen',
}));
vi.mock('@/components/onboarding/whats-new', () => ({ WhatsNew: 'WhatsNew' }));
vi.mock('@/components/update-prompt-host', () => ({ UpdatePromptHost: 'UpdatePromptHost' }));
vi.mock('@/lib/account-eviction', () => ({
  clearSessionEnded: () => undefined,
  signedOutRoute: () => '/',
}));
vi.mock('@/lib/alert-holds', () => ({ installAlertHolds: () => undefined }));
vi.mock('@/lib/auth-context', () => ({ AuthProvider: 'AuthProvider', useAuth: () => ({}) }));
vi.mock('@/lib/cold-launch-gate', () => ({ ColdLaunchGateProvider: 'ColdLaunchGateProvider' }));
vi.mock('@/lib/cycle-count-sync', () => ({
  cycleCountSync: { start: () => undefined, stop: () => undefined },
}));
vi.mock('@/lib/db', () => ({ initDb: () => new Promise(() => undefined) }));
vi.mock('@/lib/queue', () => ({ pruneRejected: async () => undefined }));
vi.mock('@/lib/order-storefront/runtime', () => ({ useHeldOrderSubmissions: () => undefined }));
vi.mock('@/lib/sentry', () => ({
  initSentry: () => undefined,
  Sentry: { wrap: <T>(component: T) => component },
}));
vi.mock('@/lib/use-account-gate', () => ({ useAccountGate: () => ({}) }));
// The bundled brand fonts are ready at the first render.
vi.mock('@/lib/use-fonts', () => ({ useBrandFonts: () => true }));
vi.mock('@/lib/use-ota-updates', () => ({ useOtaUpdates: () => undefined }));
vi.mock('@/lib/use-push-notifications', () => ({ usePushNotifications: () => undefined }));
vi.mock('@/lib/use-session-revocation', () => ({ useSessionRevocation: () => undefined }));
vi.mock('@/lib/use-activity-beacon', () => ({ useActivityBeacon: () => undefined }));
vi.mock('@/lib/use-sync', () => ({ useSync: () => undefined }));

// ── A stand-in renderer with a hook dispatcher ───────────────────────────

type Props = { children?: unknown; value?: unknown; [key: string]: unknown };
type Element = { type: unknown; props: Props };
type Context = { _currentValue: unknown };

const internals = (
  React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
  }
).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

const isElement = (n: unknown): n is Element =>
  typeof n === 'object' && n !== null && 'type' in n && 'props' in n;
const isContext = (t: unknown): t is Context =>
  typeof t === 'object' && t !== null && '_currentValue' in t;
const nameOf = (t: unknown): string =>
  typeof t === 'string' ? t : typeof t === 'function' ? t.name : '';

function createRoot(root: unknown) {
  /** Each component's hook slots, by its place in the tree. */
  const slots = new Map<string, unknown[]>();
  let effects: (() => unknown)[] = [];
  let mounted = false;
  let contexts: Map<Context, unknown> = new Map();
  let current: unknown[] = [];
  let index = 0;

  const slot = <T>(init: () => T): { get: () => T; set: (v: T) => void } => {
    const i = index++;
    if (!(i in current)) current[i] = init();
    const store = current;
    return { get: () => store[i] as T, set: (v: T) => void (store[i] = v) };
  };

  const dispatcher = {
    useState<T>(init: T | (() => T)) {
      const s = slot(() => (typeof init === 'function' ? (init as () => T)() : init));
      const set = (next: T | ((prev: T) => T)) =>
        s.set(typeof next === 'function' ? (next as (p: T) => T)(s.get()) : next);
      return [s.get(), set];
    },
    useReducer<S, A>(reducer: (s: S, a: A) => S, init: S) {
      const s = slot(() => init);
      return [s.get(), (a: A) => s.set(reducer(s.get(), a))];
    },
    useRef<T>(init: T) {
      return slot(() => ({ current: init })).get();
    },
    useMemo<T>(make: () => T) {
      slot(() => null);
      return make();
    },
    useCallback<T>(fn: T) {
      slot(() => null);
      return fn;
    },
    useEffect(effect: () => unknown) {
      slot(() => null);
      if (!mounted) effects.push(effect);
    },
    useLayoutEffect(effect: () => unknown) {
      dispatcher.useEffect(effect);
    },
    useInsertionEffect() {
      slot(() => null);
    },
    useContext(context: Context) {
      return contexts.has(context) ? contexts.get(context) : context._currentValue;
    },
    useSyncExternalStore<T>(_subscribe: unknown, getSnapshot: () => T) {
      slot(() => null);
      return getSnapshot();
    },
    useDebugValue() {},
    useId() {
      return ':r0:';
    },
  };

  /** Renders every function component, opens up contexts and fragments. */
  const draw = (node: unknown, at: string): unknown => {
    if (Array.isArray(node)) return node.map((n, i) => draw(n, `${at}.${i}`));
    if (!isElement(node)) return node;
    const { type, props } = node;
    if (typeof type === 'function' && type.name !== 'RootGate') {
      const key = `${at}/${type.name}`;
      const saved = { current, index };
      current = slots.get(key) ?? [];
      slots.set(key, current);
      index = 0;
      let out: unknown;
      try {
        out = (type as (p: Props) => unknown)(props);
      } finally {
        current = saved.current;
        index = saved.index;
      }
      return draw(out, key);
    }
    if (isContext(type)) {
      const before = contexts;
      contexts = new Map(contexts).set(type, props.value);
      try {
        return { type, props: { ...props, children: draw(props.children, `${at}/ctx`) } };
      } finally {
        contexts = before;
      }
    }
    return { type, props: { ...props, children: draw(props.children, `${at}/${nameOf(type)}`) } };
  };

  const render = (): unknown => {
    const before = internals.H;
    internals.H = dispatcher;
    try {
      return draw(root, '');
    } finally {
      internals.H = before;
    }
  };

  return {
    render,
    /** The first commit: render, then the mount effects, as React does. */
    mount(): unknown {
      const tree = render();
      mounted = true;
      const run = effects;
      effects = [];
      for (const effect of run) effect();
      return tree;
    },
  };
}

/** Every element of a type (a name, or a function by its name) in a tree. */
function every(tree: unknown, name: string): Element[] {
  const out: Element[] = [];
  const visit = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach(visit);
    else if (isElement(x)) {
      if (x.type === Symbol.for('react.fragment')) return visit(x.props.children);
      if (nameOf(x.type) === name) out.push(x);
      visit(x.props.children);
    }
  };
  visit(tree);
  return out;
}

const has = (tree: unknown, name: string) => every(tree, name).length > 0;

// ── The launch ───────────────────────────────────────────────────────────

/** AsyncStorage whose reads answer only when the test releases them. */
function heldStorage(): AppearanceStorage & { release(values: Record<string, string>): void } {
  const waiting: { key: string; resolve: (v: string | null) => void }[] = [];
  return {
    getItem: (key) => new Promise((resolve) => waiting.push({ key, resolve })),
    setItem: async () => undefined,
    removeItem: async () => undefined,
    release(values) {
      for (const { key, resolve } of waiting.splice(0)) resolve(values[key] ?? null);
    },
  };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

async function launch(rollout: GlassRollout) {
  vi.resetModules();
  const storage = heldStorage();
  env.controller = createAppearanceController({
    storage,
    account: {
      fetch: () => new Promise(() => undefined),
      save: () => new Promise(() => undefined),
    },
    now: () => Date.parse('2026-11-08T12:00:00Z'),
    rollout,
    holds: { isHeld: () => false, subscribe: () => () => undefined },
    // Signed out: the first-start account read (item 31) never applies.
    peekSignedInUser: async () => null,
  });
  // A fresh module per launch: `coldLaunchHandled` is false, as at a cold start.
  const layout = await import('../../../app/_layout');
  const theme = await import('../theme');
  const glassPapers = [
    theme.GLASS_DAY,
    theme.GLASS_NIGHT,
    theme.GLASS_DAY_OPAQUE,
    theme.GLASS_NIGHT_OPAQUE,
  ].map((p) => p.paper);
  const root = createRoot(React.createElement(layout.default as React.FC));
  return { storage, root, palette: theme.palette, glassPapers };
}

beforeEach(() => {
  vi.useFakeTimers();
  env.scheme = 'light';
});
afterEach(() => {
  vi.useRealTimers();
});

describe('root layout at fontsReady', () => {
  it('under off, a storage read that never answers holds nothing: the splash, RootGate and the status bar mount at fontsReady, as on main', async () => {
    const { root } = await launch('off');
    // The provider asks for the stored appearance in its mount effect; it never answers.
    const first = root.mount();
    for (const tree of [first, root.render()]) {
      expect(has(tree, 'ColdLaunchSplash')).toBe(true);
      expect(has(tree, 'RootGate')).toBe(true);
      expect(has(tree, 'StatusBar')).toBe(true);
      expect(has(tree, 'AuthProvider')).toBe(true);
      // main's order: RootGate under the cold-launch gate and the error boundary.
      const gate = every(tree, 'ColdLaunchGateProvider')[0];
      expect(gate?.props.splashActive).toBe(true);
      expect(has(every(gate, 'AppErrorBoundary')[0], 'RootGate')).toBe(true);
      // The splash's light status bar, as main.
      expect(every(tree, 'StatusBar')[0]?.props.style).toBe('light');
    }
    expect(env.controller.getSnapshot().ready).toBe(true);
  });

  it('under off, nothing the read returns changes what was drawn', async () => {
    const { root, storage } = await launch('off');
    const before = root.mount();
    storage.release({
      [PHONE_APPEARANCE_KEYS.device]: JSON.stringify({
        v: 2,
        style: 'liquid-glass',
        theme: 'dark',
      }),
    });
    await settle();
    const after = root.render();
    expect(env.controller.getSnapshot()).toMatchObject({ style: 'classic', theme: null });
    for (const name of ['ColdLaunchSplash', 'RootGate', 'StatusBar']) {
      expect(every(after, name)).toHaveLength(every(before, name).length);
    }
  });

  for (const rollout of ['default', 'opt-in'] as const) {
    it(`under ${rollout}, the hold (R9) shows only Classic's dark splash ground, never glass or a light page, and ends with the read or at 4 s`, async () => {
      const { root, storage, palette, glassPapers } = await launch(rollout);
      const held = root.mount();
      expect(env.controller.getSnapshot().ready).toBe(false);
      for (const name of [
        'ColdLaunchSplash',
        'RootGate',
        'StatusBar',
        'AppearanceFallbackNotice',
      ]) {
        expect(has(held, name), name).toBe(false);
      }
      // AuthProvider is already listening (finding 2).
      expect(has(held, 'AuthProvider')).toBe(true);
      const ground = every(held, 'GestureHandlerRootView')[0]?.props.style as {
        backgroundColor: string;
      };
      expect(ground.backgroundColor).toBe(palette('dark').paper);
      for (const glass of glassPapers) expect(ground.backgroundColor).not.toBe(glass);
      expect(ground.backgroundColor).not.toBe(palette('light').paper);

      // A Classic chooser's record lands (milliseconds on a real phone).
      storage.release({
        [PHONE_APPEARANCE_KEYS.device]: JSON.stringify({ v: 2, style: 'classic' }),
      });
      await settle();
      const shown = root.render();
      expect(env.controller.getSnapshot()).toMatchObject({ ready: true, style: 'classic' });
      expect(has(shown, 'ColdLaunchSplash')).toBe(true);
      expect(has(shown, 'RootGate')).toBe(true);
    });

    it(`under ${rollout}, a read that never answers holds for 4 s at most`, async () => {
      const { root } = await launch(rollout);
      root.mount();
      await vi.advanceTimersByTimeAsync(3999);
      expect(has(root.render(), 'RootGate')).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const shown = root.render();
      expect(has(shown, 'ColdLaunchSplash')).toBe(true);
      expect(has(shown, 'RootGate')).toBe(true);
    });
  }
});
