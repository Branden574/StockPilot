'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import * as React from 'react';
import { toast } from 'sonner';

import {
  APPEARANCE_STORAGE_KEYS,
  defaultStyle,
  INITIAL_APPEARANCE_STATE,
  parseThemeSetting,
  reduceAppearance,
  shownStyle as shownStyleOf,
  type AppearanceEffect,
  type AppearanceEvent,
  type AppearancePatch,
  type AppearanceState,
  type AppearanceStyle,
  type AppearanceSyncStatus,
  type GlassRollout,
  type ThemeSetting,
} from '@stockpilot/core';

import { isControlFlow } from '@/lib/control-flow';
import { getMyAppearanceAction, setMyAppearanceAction } from '@/server/actions/appearance';

import {
  APPEARANCE_SIGNED_OUT_EVENT,
  clearCrashFallback,
  ensureStyleCookie,
  isCrashFallbackActive,
  isGlassShowing,
  markCrashFallbackShown,
  markIntroSeen,
  readAnonFlowRaw,
  readAppearanceCookie,
  readCrashFallback,
  readDeviceRecordRaw,
  readIntroSeen,
  readSyncRecordRaw,
  writeAnonFlow,
  writeDeviceRecord,
  writeSyncRecord,
} from './appearance-cookie';
import {
  isMarketingPath,
  liquidGlassRollout,
  MARKETING_TWINS_BUILT,
  twinSelected,
} from './appearance-flag';
import {
  APPEARANCE_ATTRIBUTE,
  EXEMPT_PATHS,
  isLowPowerBrowser,
  LIQUID_GLASS_ATTRIBUTE_VALUE,
  LOW_POWER_ATTRIBUTE,
  LOW_POWER_ATTRIBUTE_VALUE,
  type LowPowerNavigator,
} from './appearance-script';
import { removeEarlyHide, VARIANT_GUARD_STYLE_ATTRIBUTE } from './twin-first-paint';

/**
 * The appearance layer next to next-themes (Liquid Glass plan 1-3, as revised
 * by plans/REVISION-DEFAULT.md R1-R8 and R13).
 *
 * TWO CHOICES. A person chooses a Design (Liquid Glass or Classic) and a Theme
 * (Light, Dark or System), each on its own; switching the Design never
 * changes the Theme. next-themes keeps owning the colour scheme exactly as
 * today: the `light`/`dark` class on <html>, `color-scheme` and localStorage
 * `theme`. This provider calls next-themes' setTheme only when a Theme is
 * chosen or adopted from the person's account, never for a Design. It owns the
 * `data-appearance="liquid-glass"` attribute on <html> (and the low-power
 * `data-lg-material="reduced"` that goes with it), which every glass rule is
 * scoped to, so portals inherit it.
 *
 * ONE ATTRIBUTE WRITER. The attribute is on exactly when the Design shown
 * (core's shownStyle: the choice, else the rollout's default, through the
 * crash fallback) is Liquid Glass and the page is not the print route
 * (EXEMPT_PATHS). It is written in layout effects, on hydrate and on every
 * pathname change, so a client navigation into or out of the print route is
 * right before paint. Until hydrate the head script's attribute stands. Each
 * write is also kept as `glassApplied`, for the selectors (below).
 *
 * NO REMOUNT. The provider is mounted once in app/layout.tsx, renders its
 * children as given, never keys anything and never branches the tree on the
 * appearance. The context value does not depend on the pathname, except
 * `glassApplied`, which changes only when the attribute does (into and out of
 * the print route). Only the selectors read this context
 * (appearance-render.guard.test.ts).
 *
 * PERSISTENCE AND SYNC follow core's pure reducer (packages/core/src/
 * appearance). This file performs its effects: the device record and the
 * Design cookie, the account sync record, this tab's signed-out stamp, and the
 * account row through the self-only server actions. The account is known only
 * where a page names its signed-in person (<AppearanceAccountSync>: the
 * dashboard shell and the portal).
 *
 * KILL SWITCH (R5). Under `off` the provider is inert: no hydrate writes, no
 * account read or save, no cookie, and both attributes removed. Every stored
 * value is kept for when the flag comes back.
 *
 * CRASH FALLBACK (plan 5.6). After an error boundary caught a render error in
 * glass, this tab shows classic until it is closed or the person turns glass
 * back on, and the first classic load says so once.
 *
 * INTRO NOTICE (R13). Under `default`, a signed-in person whose Design is not
 * their own choice gets one notice on their first glass view, once their
 * account was read: "Use classic design" or "Keep Liquid Glass".
 */

export interface AppearanceContextValue {
  /** False until the device records were read after mount (server render and first paint). */
  hydrated: boolean;
  /** The Design the person chose (null: never chose, the rollout's default shows). */
  style: AppearanceStyle | null;
  /** The Theme in use (next-themes' setting), or undefined before hydrate. */
  theme: ThemeSetting | undefined;
  /** The Design on screen: the choice through the rollout and the crash fallback. */
  shownStyle: AppearanceStyle;
  /**
   * <html> carries data-appearance="liquid-glass", as this provider last
   * wrote it after hydrate (so false on the print route, and following a
   * marketing page's twin). False on the server, in the first client render
   * and under `off`: a name that follows it (the header menu's trigger,
   * DECISIONS.md F6) hydrates as classic and changes only after mount.
   */
  glassApplied: boolean;
  /** This build's rollout (the kill switch). */
  rollout: GlassRollout;
  chooseStyle: (style: AppearanceStyle) => void;
  chooseTheme: (theme: ThemeSetting) => void;
  /** The intro notice's "Keep Liquid Glass": the default becomes the person's choice. */
  keepGlass: () => void;
  /** Account sync, for the selector's status line. */
  status: AppearanceSyncStatus;
  /** Try the account save again. */
  retry: () => void;
  /**
   * The signed-in person a page named (<AppearanceAccountSync>: the dashboard
   * shell, the portal), or null when none did. Read when needed: the error
   * boundaries' Use classic design marks the Design dirty for this person
   * only, never for whoever a leftover sync record names (R4, SR1, SR4).
   */
  signedInUserId: () => string | null;
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
 * Rendered by the dashboard shell and the portal, which know the user.
 * Renders nothing.
 */
export function AppearanceAccountSync({ userId }: { userId: string }) {
  const api = React.useContext(AccountContext);
  React.useEffect(() => {
    api?.authenticate(userId);
  }, [api, userId]);
  return null;
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

/** The single writer of both glass attributes on <html>. */
function setGlassAttributes(on: boolean): void {
  const root = document.documentElement;
  const isOn = root.getAttribute(APPEARANCE_ATTRIBUTE) === LIQUID_GLASS_ATTRIBUTE_VALUE;
  if (isOn !== on) {
    withoutTransitions(() => {
      if (on) root.setAttribute(APPEARANCE_ATTRIBUTE, LIQUID_GLASS_ATTRIBUTE_VALUE);
      else root.removeAttribute(APPEARANCE_ATTRIBUTE);
    });
  }
  const reduced = on && isLowPowerBrowser(navigator as Navigator & LowPowerNavigator);
  if (reduced) root.setAttribute(LOW_POWER_ATTRIBUTE, LOW_POWER_ATTRIBUTE_VALUE);
  else root.removeAttribute(LOW_POWER_ATTRIBUTE);
}

const FALLBACK_NOTICE = 'Liquid Glass hit a problem, so StockPilot opened in the classic look.';
export const INTRO_NOTICE =
  'StockPilot has a new look. You can switch back to the classic design at any time.';
export const USE_CLASSIC_LABEL = 'Use classic design';
export const KEEP_GLASS_LABEL = 'Keep Liquid Glass';

const noop = () => {};

function currentPath(pathname: string | null): string {
  if (pathname) return pathname;
  return typeof window === 'undefined' ? '' : window.location.pathname;
}

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const rollout = liquidGlassRollout();
  const inert = rollout === 'off';
  const pathname = currentPath(usePathname());
  const { theme: nextTheme, setTheme } = useTheme();
  const themeRef = React.useRef(nextTheme);
  const setThemeRef = React.useRef(setTheme);
  // Kept current before any effect of this tree runs that reaches apply().
  React.useLayoutEffect(() => {
    themeRef.current = nextTheme;
    setThemeRef.current = setTheme;
  }, [nextTheme, setTheme]);

  const stateRef = React.useRef<AppearanceState>(INITIAL_APPEARANCE_STATE);
  const hydratedRef = React.useRef(false);
  const userIdRef = React.useRef<string | null>(null);
  const pathnameRef = React.useRef(pathname);
  const fallbackRef = React.useRef(false);
  /** The variant guard's word on a marketing page whose twin and cookie disagree (R8). */
  const twinOverrideRef = React.useRef<boolean | null>(null);
  /** The Theme the last apply carried: a later apply changes next-themes only when it differs. */
  const appliedThemeRef = React.useRef<ThemeSetting | null>(null);
  const [snapshot, setSnapshot] = React.useState<AppearanceState>(INITIAL_APPEARANCE_STATE);
  const [hydrated, setHydrated] = React.useState(false);
  const [fallback, setFallback] = React.useState(false);
  /** The signed-in person's row was read (for the intro notice). */
  const [accountRead, setAccountRead] = React.useState<string | null>(null);
  /** What the last write after hydrate put on <html> (the context's glassApplied). */
  const [glassApplied, setGlassApplied] = React.useState(false);

  const writeAttributes = React.useCallback(() => {
    if (inert) {
      setGlassAttributes(false);
      return;
    }
    // Until hydrate the head script's attribute stands.
    if (!hydratedRef.current) return;
    const shown = shownStyleOf(stateRef.current.style, rollout, fallbackRef.current);
    let on = shown === 'liquid-glass' && !EXEMPT_PATHS.test(pathnameRef.current);
    if (twinOverrideRef.current !== null) on = twinOverrideRef.current;
    setGlassAttributes(on);
    // Only ever after a write in an effect or a handler, never in render.
    setGlassApplied(on);
  }, [inert, rollout]);

  // dispatch and run are mutually recursive through the async effects.
  const dispatchRef = React.useRef<(event: AppearanceEvent) => void>(noop);

  const run = React.useCallback(
    (effect: AppearanceEffect) => {
      switch (effect.type) {
        case 'apply': {
          // next-themes hears only a Theme that was chosen or adopted, never
          // a Design and never 'system' for glass (R2). On hydrate it already
          // holds what this device uses.
          if (effect.source === 'hydrate') {
            appliedThemeRef.current = effect.theme;
          } else if (effect.theme !== null && effect.theme !== appliedThemeRef.current) {
            appliedThemeRef.current = effect.theme;
            if (themeRef.current !== effect.theme) {
              themeRef.current = effect.theme;
              setThemeRef.current(effect.theme);
            }
          }
          writeAttributes();
          return;
        }
        case 'persist-device':
          writeDeviceRecord(effect.record);
          return;
        case 'persist-sync':
          writeSyncRecord(effect.record);
          return;
        case 'persist-anon-flow':
          writeAnonFlow(effect.record);
          return;
        case 'save': {
          const { userId, gen, axes } = effect;
          void setMyAppearanceAction({ userId, ...(axes as AppearancePatch) }).then(
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
                if (userIdRef.current === userId) setAccountRead(userId);
              } else {
                const missing = !answer.ok && answer.reason === 'missing-table';
                dispatchRef.current({
                  type: 'fetch-failed',
                  userId,
                  gen,
                  reason: missing ? 'missing-table' : 'error',
                });
                if (missing && userIdRef.current === userId) setAccountRead(userId);
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
    [writeAttributes],
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

  /** Read the device records once, before anything else is reduced. */
  const ensureHydrated = React.useCallback(() => {
    if (inert || hydratedRef.current) return;
    hydratedRef.current = true;
    fallbackRef.current = isCrashFallbackActive();
    setFallback(fallbackRef.current);
    const now = Date.now();
    reduce({
      type: 'hydrate',
      device: readDeviceRecordRaw(),
      sync: readSyncRecordRaw(),
      anonFlow: readAnonFlowRaw(),
      now,
    });
    // The head script painted from the cookie; this load applied the
    // localStorage record. Repair a cookie that is missing or disagrees (and
    // let the server re-issue it), or ask the server to re-issue a matching
    // one at most once a day; a matching cookie is never written by script
    // (WebKit would cap it at 7 days again).
    ensureStyleCookie(now);
    setHydrated(true);
  }, [inert, reduce]);

  const dispatch = React.useCallback(
    (event: AppearanceEvent) => {
      if (inert) return;
      ensureHydrated();
      reduce(event);
    },
    [inert, ensureHydrated, reduce],
  );
  React.useLayoutEffect(() => {
    dispatchRef.current = dispatch;
  }, [dispatch]);

  // Hydrate before the first paint after mount (a layout effect runs before
  // every passive effect, the children's included), then write the attributes.
  React.useLayoutEffect(() => {
    if (inert) {
      setGlassAttributes(false);
      return;
    }
    ensureHydrated();
    writeAttributes();
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Every pathname change: the print route is never glass (R6).
  React.useLayoutEffect(() => {
    pathnameRef.current = pathname;
    writeAttributes();
  }, [pathname, writeAttributes]);

  const setTwinOverride = React.useCallback(
    (on: boolean | null) => {
      if (twinOverrideRef.current === on) return;
      twinOverrideRef.current = on;
      writeAttributes();
    },
    [writeAttributes],
  );

  const chooseStyle = React.useCallback(
    (style: AppearanceStyle) => {
      // Choosing glass again is the way back from the crash fallback.
      if (style === 'liquid-glass' && fallbackRef.current) {
        clearCrashFallback();
        fallbackRef.current = false;
        setFallback(false);
      }
      dispatch({
        type: 'choose',
        axis: 'style',
        value: style,
        userId: userIdRef.current,
        now: Date.now(),
      });
    },
    [dispatch],
  );

  const chooseTheme = React.useCallback(
    (theme: ThemeSetting) => {
      dispatch({
        type: 'choose',
        axis: 'theme',
        value: theme,
        userId: userIdRef.current,
        now: Date.now(),
      });
    },
    [dispatch],
  );

  const keepGlass = React.useCallback(() => {
    dispatch({ type: 'keep-glass', userId: userIdRef.current, now: Date.now() });
  }, [dispatch]);

  const retry = React.useCallback(() => {
    dispatch({ type: 'retry', userId: userIdRef.current });
  }, [dispatch]);

  const signedInUserId = React.useCallback(() => (inert ? null : userIdRef.current), [inert]);

  const account = React.useMemo<AccountApi>(
    () => ({
      authenticate: (userId) => {
        if (inert || userIdRef.current === userId) return;
        userIdRef.current = userId;
        setAccountRead(null);
        dispatch({ type: 'authenticated', userId, now: Date.now() });
      },
    }),
    [inert, dispatch],
  );

  React.useEffect(() => {
    if (inert) return;

    // The one-time notice after a glass crash (plan 5.6). The stored choice
    // is untouched unless the person picks Use classic design.
    if (
      shownStyleOf(stateRef.current.style, rollout, false) === 'liquid-glass' &&
      readCrashFallback() === 'pending'
    ) {
      markCrashFallbackShown();
      toast(FALLBACK_NOTICE, {
        duration: Infinity,
        action: {
          label: 'Turn Liquid Glass back on',
          onClick: () => {
            clearCrashFallback();
            fallbackRef.current = false;
            setFallback(false);
            writeAttributes();
          },
        },
        cancel: {
          label: USE_CLASSIC_LABEL,
          onClick: () => chooseStyle('classic'),
        },
      });
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key === APPEARANCE_STORAGE_KEYS.webDevice && event.newValue !== null) {
        dispatchRef.current({ type: 'device-changed', device: event.newValue, now: Date.now() });
      }
    };
    const onSignedOut = () => {
      userIdRef.current = null;
      setAccountRead(null);
      dispatchRef.current({ type: 'signed-out' });
    };
    const onRetryMoment = () => {
      const { status } = stateRef.current;
      if (status === 'failed') dispatchRef.current({ type: 'retry', userId: userIdRef.current });
    };
    // A page restored from the back/forward cache (a static marketing page
    // left by a whole-document link, say to /signin) was frozen while another
    // page of this tab made a choice, and storage events never reach a frozen
    // page: read the device record again, as another tab's choice (that page
    // saved it). The variant guard then checks the twin on screen (R8); until
    // it has, the attribute follows the twin on screen, so no frame shows a
    // twin on the other design's CSS (a pageshow render may come after a
    // paint).
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      if (MARKETING_TWINS_BUILT && isMarketingPath(window.location.pathname)) {
        twinOverrideRef.current = document.querySelector(`[${TWIN_MARKER}]`) !== null;
      }
      const device = readDeviceRecordRaw();
      if (device !== null) dispatchRef.current({ type: 'device-changed', device, now: Date.now() });
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener(APPEARANCE_SIGNED_OUT_EVENT, onSignedOut);
    window.addEventListener('focus', onRetryMoment);
    window.addEventListener('online', onRetryMoment);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener(APPEARANCE_SIGNED_OUT_EVENT, onSignedOut);
      window.removeEventListener('focus', onRetryMoment);
      window.removeEventListener('online', onRetryMoment);
    };
    // Mount only: every handler reads the refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The one-time "new look" notice (R13): default rollout, signed in, the
  // account read, no Design of their own, glass on screen, not seen on this
  // device. Never on the print route or in classic (the attribute decides).
  const introShownRef = React.useRef(false);
  React.useEffect(() => {
    if (rollout !== 'default' || introShownRef.current) return;
    if (accountRead === null || accountRead !== userIdRef.current) return;
    if (snapshot.style !== null || !isGlassShowing() || readIntroSeen()) return;
    introShownRef.current = true;
    toast(INTRO_NOTICE, {
      duration: Infinity,
      action: {
        label: USE_CLASSIC_LABEL,
        onClick: () => {
          markIntroSeen();
          chooseStyle('classic');
        },
      },
      cancel: {
        label: KEEP_GLASS_LABEL,
        onClick: () => {
          markIntroSeen();
          keepGlass();
        },
      },
      onDismiss: () => markIntroSeen(),
    });
  }, [rollout, accountRead, snapshot.style, pathname, fallback, chooseStyle, keepGlass]);

  const theme = hydrated ? (parseThemeSetting(nextTheme) ?? 'system') : undefined;
  const shownStyle = hydrated
    ? shownStyleOf(snapshot.style, rollout, fallback)
    : inert
      ? 'classic'
      : defaultStyle(rollout);

  const value = React.useMemo<AppearanceContextValue>(
    () =>
      inert
        ? {
            hydrated: true,
            style: null,
            theme,
            shownStyle: 'classic',
            glassApplied: false,
            rollout,
            chooseStyle: noop,
            chooseTheme: noop,
            keepGlass: noop,
            status: 'signed-out',
            retry: noop,
            signedInUserId,
          }
        : {
            hydrated,
            style: snapshot.style,
            theme,
            shownStyle,
            glassApplied,
            rollout,
            chooseStyle,
            chooseTheme,
            keepGlass,
            status: snapshot.status,
            retry,
            signedInUserId,
          },
    [
      inert,
      hydrated,
      snapshot.style,
      snapshot.status,
      theme,
      shownStyle,
      glassApplied,
      rollout,
      chooseStyle,
      chooseTheme,
      keepGlass,
      retry,
      signedInUserId,
    ],
  );

  return (
    <AccountContext.Provider value={account}>
      <AppearanceContext.Provider value={value}>
        {MARKETING_TWINS_BUILT && !inert ? (
          <MarketingVariantGuard
            rollout={rollout}
            hydrated={hydrated}
            shownStyle={shownStyle}
            fallback={fallback}
            setOverride={setTwinOverride}
          />
        ) : null}
        {children}
      </AppearanceContext.Provider>
    </AccountContext.Provider>
  );
}

/** The inert marker the glass-site layout puts on its root (stage 3). */
export const TWIN_MARKER = 'data-lg-twin';
/** How long the guard keeps a mismatched page hidden before it shows it as it is. */
export const VARIANT_GUARD_TIMEOUT_MS = 2000;

/**
 * The marketing variant guard (R8, round 2 finding 2). The client router
 * cache and Back/Forward can show the twin of the other Design after a choice
 * made elsewhere. On the 7 marketing paths, in every spelling the rewrites
 * take (isMarketingPath: one trailing slash and any case, so /pricing/,
 * /Pricing and /PRICING/ as well as /pricing; FOLLOWUPS F7), after every
 * pathname change and every change of the shown Design, it compares the twin
 * on screen (the [data-lg-twin] marker) with the twin the cookie selects:
 *   - a match: nothing to do;
 *   - a mismatch: the page is hidden, router.refresh() asks for this URL with
 *     the current cookie, and the page is shown when the right twin arrives;
 *   - no match within 2 s (offline, a failed request): the page is shown and
 *     the attribute follows the twin on screen for this page only, so layout
 *     and CSS agree; the choice applies at the next navigation;
 *   - the crash fallback: a glass twin cannot render classic, so the attribute
 *     follows the twin on screen;
 *   - a page restored from the back/forward cache (Back to a marketing page
 *     left by a whole-document link) runs the check again: the cookie may
 *     have changed while the page was frozen;
 *   - a marketing document read again from the HTTP cache under a cookie that
 *     no longer selects it was hidden before its first paint: a twin by the
 *     twin layout's script (twin-first-paint.ts), a classic page under a
 *     cookie that selects glass by the head script (appearance-script.ts);
 *     the guard removes that early hide once it has decided, as it removes
 *     its own.
 * Rendered by the provider only once the twins exist (MARKETING_TWINS_BUILT).
 */
export function MarketingVariantGuard({
  rollout,
  hydrated,
  shownStyle,
  fallback,
  setOverride,
}: {
  rollout: GlassRollout;
  hydrated: boolean;
  shownStyle: AppearanceStyle;
  fallback: boolean;
  setOverride: (on: boolean | null) => void;
}) {
  const router = useRouter();
  const pathname = currentPath(usePathname());
  /** Bumped by every restore from the back/forward cache, to run the check again. */
  const [restored, setRestored] = React.useState(0);
  React.useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) setRestored((n) => n + 1);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);
  React.useLayoutEffect(() => {
    if (!hydrated) return;
    if (!isMarketingPath(pathname)) {
      setOverride(null);
      removeEarlyHide();
      return;
    }
    const twinOnScreen = () => document.querySelector(`[${TWIN_MARKER}]`) !== null;
    const settled = (): boolean => {
      const onScreen = twinOnScreen();
      if (fallback) {
        setOverride(onScreen);
        return true;
      }
      const selected = twinSelected(rollout, readAppearanceCookie(document.cookie));
      if (onScreen !== selected) return false;
      setOverride(null);
      return true;
    };
    if (settled()) {
      removeEarlyHide();
      return;
    }

    const hide = document.createElement('style');
    hide.setAttribute(VARIANT_GUARD_STYLE_ATTRIBUTE, '');
    hide.appendChild(document.createTextNode('html{visibility:hidden!important}'));
    document.head.appendChild(hide);
    let done = false;
    const observer = new MutationObserver(() => {
      if (settled()) finish();
    });
    const timer = window.setTimeout(() => {
      setOverride(twinOnScreen());
      finish();
    }, VARIANT_GUARD_TIMEOUT_MS);
    function finish() {
      if (done) return;
      done = true;
      observer.disconnect();
      window.clearTimeout(timer);
      hide.remove();
      removeEarlyHide();
    }
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    router.refresh();
    return finish;
  }, [hydrated, pathname, shownStyle, fallback, rollout, router, setOverride, restored]);
  return null;
}
