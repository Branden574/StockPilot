'use client';

import { useTheme } from 'next-themes';
import * as React from 'react';
import { toast } from 'sonner';

import {
  APPEARANCE_STORAGE_KEYS,
  effectiveAppearance,
  INITIAL_APPEARANCE_STATE,
  reduceAppearance,
  schemeSettingOf,
  type AppearanceEffect,
  type AppearanceEvent,
  type AppearanceMode,
  type AppearanceState,
  type AppearanceSyncStatus,
} from '@stockpilot/core';

import { isControlFlow } from '@/lib/control-flow';
import { getMyAppearanceAction, setMyAppearanceAction } from '@/server/actions/appearance';

import {
  APPEARANCE_SIGNED_OUT_EVENT,
  clearCrashFallback,
  isCrashFallbackActive,
  markCrashFallbackShown,
  readCrashFallback,
  readDeviceRecordRaw,
  readLegacyTheme,
  readSyncRecordRaw,
  refreshAppearanceCookie,
  writeDeviceRecord,
  writeSyncRecord,
} from './appearance-cookie';
import { isLiquidGlassEnabled } from './appearance-flag';
import { APPEARANCE_ATTRIBUTE, LIQUID_GLASS_ATTRIBUTE_VALUE } from './appearance-script';

/**
 * The appearance layer next to next-themes (Liquid Glass plan 1-3, D2).
 *
 * TWO AXES. next-themes keeps owning the colour scheme exactly as today: the
 * `light`/`dark` class on <html>, `color-scheme` and localStorage `theme`.
 * This provider owns the style: the `data-appearance="liquid-glass"`
 * attribute on <html> (and nothing else on that element), which every glass
 * rule is scoped to, so portals (dialogs, menus, toasts, tours) inherit it.
 * Choosing Dark, Light or System hands that word to next-themes; choosing
 * Liquid Glass hands it `system` (glass follows the device for its Day or
 * Night version, plan D3). next-themes, sonner and `color-scheme` therefore
 * never see the word 'liquid-glass'.
 *
 * NO REMOUNT. The provider is mounted once in app/layout.tsx, renders its
 * children as given, never keys anything and never branches the tree on the
 * appearance. A switch flips one attribute (behind the same no-transition
 * guard next-themes uses) and, at most, next-themes' class, so the route,
 * scroll, typed values, selection and open dialogs all survive it. Only the
 * selectors read this context (appearance-render.guard.test.ts).
 *
 * PERSISTENCE AND SYNC follow core's pure reducer (packages/core/src/appearance,
 * plan 3.4). This file performs its effects: the device record (cookie +
 * localStorage), the account sync record, and the account row through the
 * self-only server actions in server/actions/appearance.ts. The account is
 * known only where a page names its signed-in person (<AppearanceAccountSync>,
 * rendered by the dashboard shell); everywhere else a choice stays on the
 * device, as the plan's pre-sign-in rules expect.
 *
 * KILL SWITCH (plan D12). With NEXT_PUBLIC_LIQUID_GLASS off, a stored
 * 'liquid-glass' renders as classic System and the attribute is removed if
 * anything set it; the stored value is kept.
 *
 * CRASH FALLBACK (plan 5.6). After an error boundary caught a render error in
 * glass, this tab shows classic until it is closed or the person turns glass
 * back on, and the first classic load says so once.
 */

export interface AppearanceContextValue {
  /** False until the device records were read after mount (server render and first paint). */
  hydrated: boolean;
  /** The stored choice. */
  mode: AppearanceMode;
  /** What is on screen: the choice through the kill switch and the crash fallback. */
  shown: AppearanceMode;
  /** Account sync, for the selector's status line. */
  status: AppearanceSyncStatus;
  /** Whether this build offers Liquid Glass at all (the kill switch). */
  glassAvailable: boolean;
  /** The person's explicit choice. */
  choose: (mode: AppearanceMode) => void;
  /** Try the account save again. */
  retry: () => void;
}

const AppearanceContext = React.createContext<AppearanceContextValue | null>(null);

/** For the selectors and the recovery action only (appearance-render.guard.test.ts). */
export function useAppearance(): AppearanceContextValue | null {
  return React.useContext(AppearanceContext);
}

interface AccountApi {
  authenticate: (userId: string) => void;
}
const AccountContext = React.createContext<AccountApi | null>(null);

/**
 * Names the signed-in person to the appearance layer, so a choice is saved to
 * their account and their account's choice is adopted (plan 3.4 rule 4).
 * Rendered by the dashboard shell, which knows the user. Renders nothing.
 */
export function AppearanceAccountSync({ userId }: { userId: string }) {
  const api = React.useContext(AccountContext);
  React.useEffect(() => {
    api?.authenticate(userId);
  }, [api, userId]);
  return null;
}

/** The scheme to hand next-themes for what is shown. */
function themeFor(shown: AppearanceMode): string {
  return schemeSettingOf(shown);
}

/**
 * Turn transitions off for one frame while the attribute flips, like
 * next-themes' disableTransitionOnChange, so nothing animates halfway through
 * a switch.
 */
function withoutTransitions(change: () => void): void {
  const style = document.createElement('style');
  style.appendChild(
    document.createTextNode(
      '*,*::before,*::after{-webkit-transition:none!important;transition:none!important}',
    ),
  );
  document.head.appendChild(style);
  change();
  window.getComputedStyle(document.body);
  window.setTimeout(() => style.remove(), 1);
}

function setGlassAttribute(on: boolean): void {
  const root = document.documentElement;
  const isOn = root.getAttribute(APPEARANCE_ATTRIBUTE) === LIQUID_GLASS_ATTRIBUTE_VALUE;
  if (isOn === on) return;
  withoutTransitions(() => {
    if (on) root.setAttribute(APPEARANCE_ATTRIBUTE, LIQUID_GLASS_ATTRIBUTE_VALUE);
    else root.removeAttribute(APPEARANCE_ATTRIBUTE);
  });
}

function shownFor(mode: AppearanceMode, glassEnabled: boolean): AppearanceMode {
  const effective = effectiveAppearance(mode, glassEnabled);
  if (effective === 'liquid-glass' && isCrashFallbackActive()) return 'system';
  return effective;
}

const FALLBACK_NOTICE = 'Liquid Glass hit a problem, so StockPilot opened in the classic look.';

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const glassEnabled = isLiquidGlassEnabled();
  const { theme, setTheme } = useTheme();
  const themeRef = React.useRef(theme);
  const setThemeRef = React.useRef(setTheme);
  // Kept current before any effect of this tree runs (layout effects run
  // before every passive effect), so a child's effect that reaches apply()
  // reads next-themes' latest values.
  React.useLayoutEffect(() => {
    themeRef.current = theme;
    setThemeRef.current = setTheme;
  }, [theme, setTheme]);

  const stateRef = React.useRef<AppearanceState>(INITIAL_APPEARANCE_STATE);
  const hydratedRef = React.useRef(false);
  const userIdRef = React.useRef<string | null>(null);
  const [snapshot, setSnapshot] = React.useState<AppearanceState>(INITIAL_APPEARANCE_STATE);
  const [hydrated, setHydrated] = React.useState(false);
  const [shown, setShown] = React.useState<AppearanceMode>('system');

  const apply = React.useCallback(
    (mode: AppearanceMode) => {
      const next = shownFor(mode, glassEnabled);
      setGlassAttribute(next === 'liquid-glass');
      const wanted = themeFor(next);
      if (themeRef.current !== wanted) {
        themeRef.current = wanted;
        setThemeRef.current(wanted);
      }
      setShown(next);
    },
    [glassEnabled],
  );

  // dispatch and run are mutually recursive through the async effects.
  const dispatchRef = React.useRef<(event: AppearanceEvent) => void>(() => {});

  const run = React.useCallback(
    (effect: AppearanceEffect) => {
      switch (effect.type) {
        case 'apply':
          apply(effect.mode);
          return;
        case 'persist-device':
          writeDeviceRecord(effect.record);
          return;
        case 'persist-sync':
          writeSyncRecord(effect.record);
          return;
        case 'save': {
          const { userId, gen, mode } = effect;
          void setMyAppearanceAction({ userId, appearance: mode }).then(
            (answer) => {
              if (answer.ok && answer.userId === userId) {
                dispatchRef.current({ type: 'save-succeeded', userId, gen, row: answer.row });
              } else {
                dispatchRef.current({
                  type: 'save-failed',
                  userId,
                  gen,
                  reason:
                    !answer.ok && answer.reason === 'missing-table' ? 'missing-table' : 'error',
                });
              }
            },
            (e: unknown) => {
              // The router is already navigating (control flow): stop quietly.
              if (isControlFlow(e)) return;
              dispatchRef.current({ type: 'save-failed', userId, gen, reason: 'error' });
            },
          );
          return;
        }
        case 'fetch': {
          const { userId, gen } = effect;
          void getMyAppearanceAction(userId).then(
            (answer) => {
              if (answer.ok && answer.userId === userId) {
                dispatchRef.current({ type: 'fetch-succeeded', userId, gen, row: answer.row });
              } else {
                dispatchRef.current({
                  type: 'fetch-failed',
                  userId,
                  gen,
                  reason:
                    !answer.ok && answer.reason === 'missing-table' ? 'missing-table' : 'error',
                });
              }
            },
            (e: unknown) => {
              if (isControlFlow(e)) return;
              dispatchRef.current({ type: 'fetch-failed', userId, gen, reason: 'error' });
            },
          );
          return;
        }
      }
    },
    [apply],
  );

  const reduce = React.useCallback(
    (event: AppearanceEvent) => {
      const { state, effects } = reduceAppearance(stateRef.current, event);
      stateRef.current = state;
      setSnapshot(state);
      for (const effect of effects) run(effect);
    },
    [run],
  );

  /** Read the device records once, before anything else is reduced (children's effects run first). */
  const ensureHydrated = React.useCallback(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    reduce({
      type: 'hydrate',
      device: readDeviceRecordRaw(),
      sync: readSyncRecordRaw(),
      legacyTheme: readLegacyTheme(),
    });
    // The head script painted from the cookie; this load applied the
    // localStorage record. Make the cookie say what was applied, so the next
    // load paints it first time (a cookie Safari let expire after 7 days, or
    // one the person cleared, would otherwise flash classic on every load).
    refreshAppearanceCookie();
    setHydrated(true);
  }, [reduce]);

  const dispatch = React.useCallback(
    (event: AppearanceEvent) => {
      ensureHydrated();
      reduce(event);
    },
    [ensureHydrated, reduce],
  );
  React.useLayoutEffect(() => {
    dispatchRef.current = dispatch;
  }, [dispatch]);

  const choose = React.useCallback(
    (mode: AppearanceMode) => {
      // Choosing glass again is the way back from the crash fallback.
      if (mode === 'liquid-glass') clearCrashFallback();
      dispatch({ type: 'choose', mode, userId: userIdRef.current, now: Date.now() });
    },
    [dispatch],
  );

  const retry = React.useCallback(() => {
    dispatch({ type: 'retry', userId: userIdRef.current });
  }, [dispatch]);

  const account = React.useMemo<AccountApi>(
    () => ({
      authenticate: (userId) => {
        if (userIdRef.current === userId) return;
        userIdRef.current = userId;
        dispatch({ type: 'authenticated', userId, now: Date.now() });
      },
    }),
    [dispatch],
  );

  React.useEffect(() => {
    ensureHydrated();

    // The one-time notice after a glass crash (plan 5.6). The stored choice
    // is untouched unless the person picks Use classic.
    if (
      glassEnabled &&
      stateRef.current.mode === 'liquid-glass' &&
      readCrashFallback() === 'pending'
    ) {
      markCrashFallbackShown();
      toast(FALLBACK_NOTICE, {
        duration: Infinity,
        action: {
          label: 'Turn Liquid Glass back on',
          onClick: () => {
            clearCrashFallback();
            apply(stateRef.current.mode);
          },
        },
        cancel: {
          label: 'Use classic',
          onClick: () => choose(stateRef.current.lastClassic),
        },
      });
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key === APPEARANCE_STORAGE_KEYS.webDevice && event.newValue !== null) {
        dispatchRef.current({ type: 'device-changed', device: event.newValue });
      }
    };
    const onSignedOut = () => {
      userIdRef.current = null;
      dispatchRef.current({ type: 'signed-out' });
    };
    const onRetryMoment = () => {
      const { status } = stateRef.current;
      if (status === 'failed') dispatchRef.current({ type: 'retry', userId: userIdRef.current });
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(APPEARANCE_SIGNED_OUT_EVENT, onSignedOut);
    window.addEventListener('focus', onRetryMoment);
    window.addEventListener('online', onRetryMoment);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(APPEARANCE_SIGNED_OUT_EVENT, onSignedOut);
      window.removeEventListener('focus', onRetryMoment);
      window.removeEventListener('online', onRetryMoment);
    };
    // Mount only: every handler reads the refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = React.useMemo<AppearanceContextValue>(
    () => ({
      hydrated,
      mode: snapshot.mode,
      shown,
      status: snapshot.status,
      glassAvailable: glassEnabled,
      choose,
      retry,
    }),
    [hydrated, snapshot.mode, snapshot.status, shown, glassEnabled, choose, retry],
  );

  return (
    <AccountContext.Provider value={account}>
      <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>
    </AccountContext.Provider>
  );
}
