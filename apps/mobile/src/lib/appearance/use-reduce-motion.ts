import * as React from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * The OS Reduce Motion setting, live (isReduceMotionEnabled plus the
 * 'reduceMotionChanged' event), for the glass primitives. One shared hook for
 * new code; the seven ad-hoc readers that exist today (scan, biometric lock,
 * cold-launch splash, tour, What's New, scanner tip, customize tabs; listed in
 * spec/native-current.md E) are left as they are.
 */
export function useReduceMotion(): boolean {
  const [on, setOn] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (alive) setOn(value);
      })
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
      setOn(value);
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return on;
}
