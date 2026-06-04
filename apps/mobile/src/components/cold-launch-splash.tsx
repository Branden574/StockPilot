import * as React from 'react';
import {
  AccessibilityInfo,
  Animated,
  type DimensionValue,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Svg, { Circle, Defs, Path, RadialGradient, Rect, Stop } from 'react-native-svg';

import { ACCENT, FONT, palette } from '@/lib/theme';

// ── Tunable durations (named so they're easy to adjust) ───────────────
export const LOADING_MS = 2000; // branded hold before hand-off
export const CROSSFADE_MS = 450; // splash-out → Face-ID-in dissolve
const REDUCED_HOLD_MS = 1100; // shortened static hold under reduce-motion

// Stroke-draw lengths (SVG user units). Slight over-estimates of the actual
// path lengths so each stroke is fully drawn at p=1 with a single clean dash
// segment (react-native-svg has no reliable pathLength normalization).
const RECT_LEN = 96; // rounded-square perimeter (~93.7)
const CURVE_LEN = 52; // S-curve path length (~47)

// The splash is ALWAYS dark per the brief (a branded dark loading screen),
// independent of the app's light/dark theme.
const D = palette('dark');

// ── math helpers (verbatim from the design prototype) ─────────────────
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
const easeOutBack = (x: number) => {
  const c = 1.70158;
  return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2);
};

// ── animated brand mark — the rounded-square + S-curve draw themselves on,
//    the teal pip pops at the end. `p` is 0..1 draw progress. ────────────
function SPMarkDraw({ size, p }: { size: number; p: number }) {
  const rectP = easeOut(clamp01(p / 0.5));
  const curveP = easeOut(clamp01((p - 0.28) / 0.72));
  const pipP = clamp01((p - 0.9) / 0.1);
  const sw = 1.7;
  const pipScale = 0.4 + 0.6 * easeOutBack(pipP || 0.0001);
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <Rect
        x={3}
        y={3}
        width={26}
        height={26}
        rx={6}
        stroke={D.ink}
        strokeWidth={sw}
        strokeLinecap="round"
        fill="none"
        strokeDasharray={[RECT_LEN, RECT_LEN]}
        strokeDashoffset={RECT_LEN * (1 - rectP)}
      />
      <Path
        d="M11 23.5 Q24 23.5 24 19.5 Q24 15.5 18 15.5 Q11 15.5 11 11.5 Q11 7.5 24 7.5"
        stroke={D.ink}
        strokeWidth={sw}
        strokeLinecap="round"
        fill="none"
        strokeDasharray={[CURVE_LEN, CURVE_LEN]}
        strokeDashoffset={CURVE_LEN * (1 - curveP)}
      />
      <Circle cx={24} cy={7.5} r={1.5 * pipScale} fill={ACCENT.pipTeal} opacity={pipP} />
    </Svg>
  );
}

interface ColdLaunchSplashProps {
  /** Fired when the dissolve BEGINS (at LOADING_MS or on skip/tap) — the parent
   *  uses this to release the biometric lock's Face-ID auto-prompt so it appears
   *  as the splash fades. */
  onHandoff?: () => void;
  /** Fired after the dissolve completes — the parent unmounts the splash. */
  onDone?: () => void;
}

/**
 * StockPilot cold-launch loading screen. Fire-once on a hard relaunch: the S
 * mark snaps + draws in, a branded hold runs to LOADING_MS with a stepped mono
 * status + 00→100% counter + mint hairline progress, then it cross-dissolves
 * (opacity, on two stacked layers) into the existing Face-ID lock screen
 * rendered underneath. Tapping anywhere — or the SKIP pill — hands off
 * immediately. Honors reduce-motion (static mark, short hold, then dissolve).
 */
export function ColdLaunchSplash({ onHandoff, onDone }: ColdLaunchSplashProps) {
  const [t, setT] = React.useState(0);
  const [reduceMotion, setReduceMotion] = React.useState(false);

  const fade = React.useRef(new Animated.Value(1)).current;
  const startRef = React.useRef<number | null>(null);
  const rafRef = React.useRef<number | null>(null);
  const handedOff = React.useRef(false);

  const handoff = React.useCallback(() => {
    if (handedOff.current) return;
    handedOff.current = true;
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    onHandoff?.();
    // Pure opacity crossfade on the stacked layer — never gates the incoming
    // (Face ID) layer's visibility, so an instant skip still reveals it.
    Animated.timing(fade, {
      toValue: 0,
      duration: CROSSFADE_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(() => onDone?.());
  }, [fade, onHandoff, onDone]);

  // Always call the latest handoff from the timeline without making the
  // timeline effect depend on (and restart on) callback identity.
  const handoffRef = React.useRef(handoff);
  handoffRef.current = handoff;

  // Detect reduce-motion once.
  React.useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((on) => {
      if (active) setReduceMotion(on);
    });
    return () => {
      active = false;
    };
  }, []);

  // Drive the timeline. Reduce-motion → static frame, short hold, then dissolve.
  // Depends only on reduceMotion so the rAF loop is never restarted by a
  // re-render; it calls the latest handoff via the ref.
  React.useEffect(() => {
    if (reduceMotion) {
      const id = setTimeout(() => handoffRef.current(), REDUCED_HOLD_MS);
      return () => clearTimeout(id);
    }
    const loop = (now: number) => {
      if (startRef.current == null) startRef.current = now;
      const elapsed = now - startRef.current;
      setT(elapsed);
      if (elapsed >= LOADING_MS) {
        handoffRef.current();
        return;
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [reduceMotion]);

  // Under reduce-motion, render the settled end-frame.
  const tt = reduceMotion ? LOADING_MS : t;

  // sub-timelines (ms) — verbatim from the prototype
  const draw = clamp01((tt - 60) / 820);
  const markIn = reduceMotion ? 1 : easeOut(clamp01((tt - 40) / 320));
  const word = clamp01((tt - 760) / 480);
  const meta = clamp01((tt - 1000) / 360);
  const prog = clamp01(tt / LOADING_MS);
  const settle = easeOut(clamp01((tt - 1700) / 300));

  const status =
    tt < 720
      ? 'INITIALIZING'
      : tt < 1350
        ? 'SYNCING LEDGER'
        : tt < 1850
          ? 'SECURING SESSION'
          : 'READY';

  const markScale = (0.86 + 0.14 * markIn) * (1 - 0.015 * settle);
  const counter = String(Math.round(prog * 100)).padStart(2, '0');

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.root, { opacity: fade }]}>
      {/* Tap anywhere to skip → hand off immediately. */}
      <Pressable style={StyleSheet.absoluteFill} onPress={handoff} accessibilityRole="button" accessibilityLabel="Skip intro">
        {/* faint mint radial wash, top-left */}
        <View
          pointerEvents="none"
          style={[styles.wash, { opacity: 0.4 + 0.6 * easeOut(draw) }]}
        >
          <Svg width={420} height={420}>
            <Defs>
              <RadialGradient id="cl-wash" cx="50%" cy="50%" r="50%">
                <Stop offset="0%" stopColor={ACCENT.mint} stopOpacity={0.16} />
                <Stop offset="65%" stopColor={ACCENT.mint} stopOpacity={0} />
              </RadialGradient>
            </Defs>
            <Rect x={0} y={0} width={420} height={420} fill="url(#cl-wash)" />
          </Svg>
        </View>

        {/* centered lockup: mark + wordmark */}
        <View style={styles.center}>
          <View style={{ transform: [{ scale: markScale }], opacity: markIn }}>
            <SPMarkDraw size={104} p={draw} />
          </View>

          <View
            style={{
              opacity: word,
              transform: [{ translateY: (1 - easeOut(word)) * 12 }],
            }}
          >
            <Text style={styles.wordmark} allowFontScaling={false}>
              Stock<Text style={styles.wordmarkLight}>Pilot</Text>
            </Text>
          </View>
        </View>

        {/* bottom: status readout + hairline progress */}
        <View style={[styles.bottom, { opacity: meta }]}>
          <View style={styles.statusRow}>
            <Text style={styles.statusLabel} allowFontScaling={false}>
              {'— '}
              {status}
            </Text>
            <Text style={styles.counter} allowFontScaling={false}>
              {counter}%
            </Text>
          </View>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${prog * 100}%` as DimensionValue }]} />
          </View>
        </View>
      </Pressable>

      {/* SKIP pill, top-right */}
      <Pressable
        onPress={handoff}
        hitSlop={12}
        style={styles.skip}
        accessibilityRole="button"
        accessibilityLabel="Skip"
      >
        <Text style={styles.skipText} allowFontScaling={false}>
          SKIP
        </Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: D.paper, overflow: 'hidden' },
  wash: { position: 'absolute', top: -120, left: -90, width: 420, height: 420 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 26,
  },
  wordmark: {
    fontFamily: FONT.displaySemi,
    fontSize: 27,
    letterSpacing: -0.8,
    color: D.ink,
    lineHeight: 28,
    includeFontPadding: false,
  },
  wordmarkLight: {
    fontFamily: FONT.displayRegular,
    color: 'rgba(250,250,247,0.5)',
  },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 32,
    paddingBottom: 44, // fixed — clears the home indicator (no SafeAreaProvider in tree)
    gap: 14,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statusLabel: {
    fontFamily: FONT.mono,
    fontSize: 10.5,
    letterSpacing: 2.1,
    color: D.ink3,
    includeFontPadding: false,
  },
  counter: {
    fontFamily: FONT.mono,
    fontSize: 10.5,
    letterSpacing: 0.8,
    color: D.ink4,
    fontVariant: ['tabular-nums'],
    includeFontPadding: false,
  },
  track: {
    height: 2,
    borderRadius: 100,
    backgroundColor: D.hair,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 100,
    backgroundColor: ACCENT.mint,
    shadowColor: ACCENT.mint,
    shadowOpacity: 0.55,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },
  skip: {
    position: 'absolute',
    top: 54, // fixed — clears the status bar / notch (no SafeAreaProvider in tree)
    right: 16,
    height: 28,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: D.hair,
    alignItems: 'center',
    justifyContent: 'center',
  },
  skipText: {
    fontFamily: FONT.mono,
    fontSize: 10.5,
    letterSpacing: 1.5,
    color: D.ink3,
    includeFontPadding: false,
  },
});
