import * as Updates from 'expo-updates';
import * as React from 'react';
import { Pressable, Text, View } from 'react-native';

import { Sentry } from '@/lib/sentry';

interface State {
  error: Error | null;
}

/**
 * App-wide render-error boundary.
 *
 * React unmounts the ENTIRE subtree on an uncaught render-phase throw. With no
 * boundary above the app's screens, a throw anywhere (e.g. `value.toFixed()` on
 * a null aggregate from drifted/partial SQLite-cached data) blanks the whole
 * app to a white screen with no recovery but force-quit. This boundary catches
 * those throws and degrades to a branded "Something went wrong — Reload" screen.
 *
 * Colors are hardcoded on purpose: a last-resort screen must not depend on the
 * theme/context layer, which could itself be the thing that threw.
 *
 * Scope note: this catches RENDER-phase throws only. A MODULE-INIT throw (e.g.
 * a build shipped without EXPO_PUBLIC_SUPABASE_* inlined) happens before React
 * mounts and cannot be caught here — supabase.ts is made fail-soft separately.
 */
export class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.warn('[error-boundary] caught render error', error, info?.componentStack);
    // React swallows render-phase throws, so the global handler never sees them
    // — report here. No-op until Sentry has a DSN.
    Sentry.captureException(error, {
      contexts: { react: { componentStack: info?.componentStack ?? undefined } },
    });
  }

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
            backgroundColor: '#0c0d0a',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <Text
            style={{
              fontSize: 19,
              fontWeight: '700',
              color: '#f5f5f0',
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
              color: '#a8a89c',
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
              backgroundColor: '#c8a44d',
              paddingHorizontal: 28,
              paddingVertical: 13,
              borderRadius: 12,
            }}
          >
            <Text style={{ color: '#0c0d0a', fontWeight: '700', fontSize: 15 }}>Reload</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}
