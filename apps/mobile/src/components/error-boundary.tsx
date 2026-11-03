import { styleOf } from '@stockpilot/core';
import * as Updates from 'expo-updates';
import * as React from 'react';
import { Pressable, Text, View } from 'react-native';

import { isLiquidGlassEnabled } from '@/lib/appearance/flag';
import { RECOVERY_ACTION_LABEL } from '@/lib/appearance/labels';
import { markCrashFallback, recoverToClassicInStorage } from '@/lib/appearance/recovery';
import { peekAppearanceController } from '@/lib/appearance/singleton';
import { asyncStorageAppearance } from '@/lib/appearance/store';
import { Sentry } from '@/lib/sentry';
import { palette } from '@/lib/theme';

interface State {
  error: Error | null;
  /** Liquid Glass is the stored choice: offer "Use classic appearance" (plan 5.6). */
  glass: boolean;
}

/** The style being drawn when the error happened, for Sentry's tag (never data). */
function appearanceTag(): string {
  try {
    const snapshot = peekAppearanceController()?.getSnapshot();
    return snapshot ? styleOf(snapshot.effective) : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The fallback's colours: the dark palette, read once at module load. A plain
 * constant, never the theme hook or a context, so the screen still draws when
 * the theme layer is what threw; dark in both modes, as it always was.
 */
const SCREEN = palette('dark');

/**
 * App-wide render-error boundary.
 *
 * React unmounts the ENTIRE subtree on an uncaught render-phase throw. With no
 * boundary above the app's screens, a throw anywhere (e.g. `value.toFixed()` on
 * a null aggregate from drifted/partial SQLite-cached data) blanks the whole
 * app to a white screen with no recovery but force-quit. This boundary catches
 * those throws and degrades to a branded "Something went wrong — Reload" screen.
 *
 * Colors are fixed on purpose: a last-resort screen must not depend on the
 * theme/context layer, which could itself be the thing that threw. They are
 * the dark palette's tokens (SCREEN above), with the system font, and Reload
 * is the reference's ink button at the shared 52pt height and radius 14.
 *
 * Liquid Glass (plan 5.6): a Reload alone would come straight back into a
 * glass layer that throws, so when Liquid Glass is the stored choice this
 * screen also offers "Use classic appearance" (the person's previous classic
 * choice, saved to their account after the reload), and the crash owes the
 * next launch one classic start with a notice (markCrashFallback). Both talk
 * to AsyncStorage directly, never through the appearance provider, which may
 * be what threw. In classic nothing here changes: the action is not shown and
 * the look is the same fixed dark screen.
 *
 * Scope note: this catches RENDER-phase throws only. A MODULE-INIT throw (e.g.
 * a build shipped without EXPO_PUBLIC_SUPABASE_* inlined) happens before React
 * mounts and cannot be caught here — supabase.ts is made fail-soft separately.
 */
export class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { error: null, glass: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    // The way back is offered only once storage says Liquid Glass is stored
    // (componentDidCatch below), never from an earlier error's answer.
    return { error, glass: false };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.warn('[error-boundary] caught render error', error, info?.componentStack);
    // React swallows render-phase throws, so the global handler never sees them
    // — report here. No-op until Sentry has a DSN.
    Sentry.captureException(error, {
      contexts: { react: { componentStack: info?.componentStack ?? undefined } },
      tags: { appearance: appearanceTag() },
    });
    // Owe the next launch one classic start when Liquid Glass is stored, and
    // offer the way back now. Never throws: a failed read shows Reload alone.
    void markCrashFallback(asyncStorageAppearance, isLiquidGlassEnabled())
      .then((glass) => {
        if (glass) this.setState({ glass: true });
      })
      .catch(() => undefined);
  }

  private handleUseClassic = async () => {
    try {
      const classic = await recoverToClassicInStorage(asyncStorageAppearance);
      // The live controller, if it still answers, shows classic at once (and
      // saves it) in case the reload below cannot run.
      try {
        peekAppearanceController()?.choose(classic);
      } catch {
        // The stored choice is classic already; the reload reads it.
      }
    } catch {
      // Storage refused: Reload still runs; the notice path covers the rest.
    }
    this.setState({ glass: false });
    await this.handleReload();
  };

  private handleReload = async () => {
    try {
      // Prefer an OTA-aware reload (picks up any pending update too).
      await Updates.reloadAsync();
    } catch {
      // Dev client / Expo Go / Updates disabled — just clear and re-mount.
      this.setState({ error: null });
    }
  };

  render() {
    if (this.state.error) {
      return (
        <View
          style={{
            flex: 1,
            backgroundColor: SCREEN.paper,
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <Text
            accessibilityRole="header"
            style={{
              fontSize: 19,
              fontWeight: '700',
              color: SCREEN.ink,
              marginBottom: 8,
              textAlign: 'center',
            }}
          >
            Something went wrong
          </Text>
          <Text
            style={{
              fontSize: 14,
              lineHeight: 20,
              color: SCREEN.ink3,
              marginBottom: 28,
              textAlign: 'center',
            }}
          >
            The app hit an unexpected error. Reloading usually fixes it.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={this.handleReload}
            style={{
              backgroundColor: SCREEN.ink,
              minHeight: 52,
              justifyContent: 'center',
              paddingHorizontal: 28,
              paddingVertical: 13,
              borderRadius: 14,
            }}
          >
            <Text style={{ color: SCREEN.paper, fontWeight: '700', fontSize: 15 }}>Reload</Text>
          </Pressable>
          {this.state.glass ? (
            <Pressable
              accessibilityRole="button"
              onPress={this.handleUseClassic}
              style={{
                marginTop: 12,
                minHeight: 52,
                justifyContent: 'center',
                paddingHorizontal: 28,
                paddingVertical: 13,
                borderRadius: 14,
                borderWidth: 1,
                borderColor: SCREEN.hair2,
              }}
            >
              <Text style={{ color: SCREEN.ink, fontWeight: '700', fontSize: 15 }}>
                {RECOVERY_ACTION_LABEL}
              </Text>
            </Pressable>
          ) : null}
        </View>
      );
    }
    return this.props.children;
  }
}
