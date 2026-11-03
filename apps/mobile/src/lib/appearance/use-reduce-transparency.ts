import * as React from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

/**
 * The OS Reduce Transparency setting, live (iOS: isReduceTransparencyEnabled
 * plus the 'reduceTransparencyChanged' event). Liquid Glass turns every layer
 * opaque while it is on, keeping the layout (plan 5.2); the person's chosen
 * appearance is not changed by it. Always false off iOS (Android draws glass
 * opaque anyway).
 *
 * New; nothing read this setting before (spec/native-current.md E).
 */
export function useReduceTransparency(): boolean {
  const [on, setOn] = React.useState(false);
  React.useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let alive = true;
    void AccessibilityInfo.isReduceTransparencyEnabled()
      .then((value) => {
        if (alive) setOn(value);
      })
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceTransparencyChanged', (value) => {
      setOn(value);
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return on;
}
