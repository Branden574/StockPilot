import * as React from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import Svg, { Circle, Defs, Mask, Path, Rect } from 'react-native-svg';

import { FONT } from '@/lib/theme';

/**
 * StockPilot cold-launch screen — the native twin of the landing page's
 * "Scanline" intro (apps/web/src/components/marketing/landing-intro).
 *
 * A thin beam sweeps the ink surface and reveals the finished lockup in its
 * wake, one green confirm pulses on the pip, then it cross-dissolves into the
 * Face-ID lock rendered underneath. One pass, one pulse, and deliberately NO
 * progress theater: no percentage counter, no progress bar, no status line and
 * no SKIP pill. The whole surface is the skip affordance, exactly as on web —
 * a progress bar that is not measuring anything is a lie told sixty times a
 * second, and the previous 0-100% counter was doing precisely that.
 *
 * PERFORMANCE: every moving part is an Animated.Value with useNativeDriver, so
 * the sequence runs on the UI thread and React re-renders ZERO times while it
 * plays. The first cut drove it from a rAF loop calling setState each frame,
 * which re-rendered the whole tree — grid included — around sixty times a
 * second and visibly stuttered on device. Only transform and opacity are
 * animated here; that is also exactly what the native driver supports.
 */

// ── timeline (ms) — mirrors the web intro exactly ─────────────────────
const GRID_IN = 200;
const BEAM_START = 120;
const BEAM_SWEEP = 500; // 120 → 620
const BEAM_FADE_IN = 70; // 120 → 190
const BEAM_HOLD = 370; // 190 → 560
const BEAM_FADE_OUT = 90; // 560 → 650
const PULSE_START = 640;
const PULSE_DUR = 260; // 640 → 900
const ANIM_DONE = 900;
const REDUCED_DONE = 300;
export const CROSSFADE_MS = 460;
const REDUCED_CROSSFADE_MS = 240;

// Brand surface. ALWAYS dark — a branded loading screen, independent of theme.
// Ink matches the landing hero so the two surfaces are the same colour.
const INK = '#0b0c0a';
const PAPER = '#faf9f4';
const MINT = '#5db89f';
const GRID_LINE = 'rgba(250,249,244,0.045)';
const GRID_CELL = 56;

/** The design's cubic-in-out, as an Easing the native driver can run. */
const EASE_IN_OUT = Easing.bezier(0.65, 0, 0.35, 1);

/**
 * The mark, in the landing nav's geometry — the S and the pip are carved
 * negative space through a mask, never drawn as foreground strokes. Kept
 * identical to the web intro's mark so both surfaces show one logo.
 *
 * Memoised: it takes no animated input, so it must never re-render mid-sequence.
 */
const IntroMark = React.memo(function IntroMark({ size }: { size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <Mask id="cl-mark">
          <Rect width={100} height={100} fill="#fff" />
          <Path
            d="M64 38 q0 -10 -14 -10 q-14 0 -14 11 q0 9 14 11 q14 2 14 11 q0 11 -14 11 q-14 0 -14 -10"
            fill="none"
            stroke="#000"
            strokeWidth={9}
            strokeLinecap="round"
          />
        </Mask>
      </Defs>
      <Rect x={12} y={12} width={76} height={76} rx={16} fill={PAPER} mask="url(#cl-mark)" />
      <Circle cx={72} cy={24} r={6} fill={MINT} />
    </Svg>
  );
});

/**
 * The warehouse grid. Memoised on its dimensions so the ~25 hairline Views are
 * built once for the whole sequence; only the parent's opacity animates.
 */
const Grid = React.memo(function Grid({ w, h }: { w: number; h: number }) {
  const rows = Math.ceil(h / GRID_CELL) + 1;
  const cols = Math.ceil(w / GRID_CELL) + 1;
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <View key={`h${i}`} style={[styles.gridH, { top: i * GRID_CELL - 28 }]} />
      ))}
      {Array.from({ length: cols }, (_, i) => (
        <View key={`v${i}`} style={[styles.gridV, { left: i * GRID_CELL - 28 }]} />
      ))}
    </>
  );
});

interface ColdLaunchSplashProps {
  /** Fired when the dissolve BEGINS (at the end of the sequence, or on tap) —
   *  the parent uses this to release the biometric lock's Face-ID auto-prompt
   *  so it appears as the splash fades. */
  onHandoff?: () => void;
  /** Fired after the dissolve completes — the parent unmounts the splash. */
  onDone?: () => void;
}

export function ColdLaunchSplash({ onHandoff, onDone }: ColdLaunchSplashProps) {
  const { width: vw, height: vh } = useWindowDimensions();
  const [reduceMotion, setReduceMotion] = React.useState<boolean | null>(null);
  /** Real lockup width, from layout — the reveal needs it to know where the
   *  lockup starts and ends. Set once; not animated. */
  const [lockW, setLockW] = React.useState(0);

  // Lockup geometry — the web intro's small breakpoint (phones are <= 480px).
  const markSize = 56;
  const wordSize = 34;
  const gap = 14;

  // ── animated values: the entire sequence, all native-driven ─────────
  const fade = React.useRef(new Animated.Value(1)).current; // crossfade out
  const gridV = React.useRef(new Animated.Value(0)).current; // 0 → 1
  const beamV = React.useRef(new Animated.Value(0)).current; // sweep 0 → 1
  const beamO = React.useRef(new Animated.Value(0)).current; // beam opacity
  const lockV = React.useRef(new Animated.Value(0)).current; // lockup opacity
  const pulseV = React.useRef(new Animated.Value(0)).current; // 0 → 1

  const handedOff = React.useRef(false);
  const onHandoffRef = React.useRef(onHandoff);
  const onDoneRef = React.useRef(onDone);
  React.useEffect(() => {
    onHandoffRef.current = onHandoff;
    onDoneRef.current = onDone;
  });

  const handoff = React.useCallback(() => {
    if (handedOff.current) return;
    handedOff.current = true;
    onHandoffRef.current?.();
    Animated.timing(fade, {
      toValue: 0,
      duration: reduceMotion ? REDUCED_CROSSFADE_MS : CROSSFADE_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(() => onDoneRef.current?.());
  }, [fade, reduceMotion]);

  const handoffRef = React.useRef(handoff);
  handoffRef.current = handoff;

  React.useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((on) => {
      if (active) setReduceMotion(on);
    });
    return () => {
      active = false;
    };
  }, []);

  // Run the sequence once, when we know the lane and the lockup's real width.
  const started = React.useRef(false);
  React.useEffect(() => {
    if (started.current || reduceMotion === null) return;
    if (!reduceMotion && lockW === 0) return; // wait for the measurement
    started.current = true;

    if (reduceMotion) {
      // Opacity only: static grid, no beam, no pulse, nothing translates.
      gridV.setValue(0.5 / 0.9); // grid renders at 0.5 via the interpolation
      Animated.timing(lockV, {
        toValue: 1,
        duration: REDUCED_DONE,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) handoffRef.current();
      });
      return;
    }

    Animated.parallel([
      Animated.timing(gridV, {
        toValue: 1,
        duration: GRID_IN,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.sequence([
        Animated.delay(BEAM_START),
        Animated.timing(beamV, {
          toValue: 1,
          duration: BEAM_SWEEP,
          easing: EASE_IN_OUT,
          useNativeDriver: true,
        }),
      ]),
      Animated.sequence([
        Animated.delay(BEAM_START),
        Animated.timing(beamO, { toValue: 1, duration: BEAM_FADE_IN, useNativeDriver: true }),
        Animated.delay(BEAM_HOLD),
        Animated.timing(beamO, { toValue: 0, duration: BEAM_FADE_OUT, useNativeDriver: true }),
      ]),
      Animated.sequence([
        Animated.delay(BEAM_START),
        Animated.timing(lockV, { toValue: 1, duration: 1, useNativeDriver: true }),
      ]),
      Animated.sequence([
        Animated.delay(PULSE_START),
        Animated.timing(pulseV, {
          toValue: 1,
          duration: PULSE_DUR,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
      // Nothing visual; just holds the parallel open to the full sequence length
      // so the completion callback fires at ANIM_DONE.
      Animated.delay(ANIM_DONE),
    ]).start(({ finished }) => {
      if (finished) handoffRef.current();
    });
  }, [reduceMotion, lockW, gridV, beamV, beamO, lockV, pulseV]);

  // ── derived styles, all interpolations of the values above ──────────
  const span = Math.min(vw * 0.56, 700);
  const beamFrom = vw / 2 - span / 2;

  const gridStyle = { opacity: gridV.interpolate({ inputRange: [0, 1], outputRange: [0, 0.9] }) };

  const beamStyle = {
    opacity: beamO,
    transform: [
      {
        translateX: beamV.interpolate({
          inputRange: [0, 1],
          outputRange: [beamFrom - 90, beamFrom + span - 90],
        }),
      },
    ],
  };

  // The curtain hides the not-yet-revealed remainder and slides right exactly
  // with the beam, so the wipe and the beam can never drift apart — they are
  // driven by the same value.
  const curtainStyle = {
    transform: [
      {
        translateX: beamV.interpolate({
          inputRange: [0, 1],
          outputRange: [(lockW - span) / 2, span + (lockW - span) / 2],
          extrapolate: 'clamp' as const,
        }),
      },
    ],
  };

  const pulseRingStyle = {
    opacity: pulseV.interpolate({ inputRange: [0, 1], outputRange: [0.75, 0] }),
    transform: [{ scale: pulseV.interpolate({ inputRange: [0, 1], outputRange: [0.4, 2.3] }) }],
  };
  const pulseDotStyle = {
    opacity: pulseV.interpolate({
      inputRange: [0, 0.25, 0.45, 1],
      outputRange: [0, 1, 1, 0],
    }),
  };

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.root, { opacity: fade }]}>
      {/* The whole surface is the skip affordance — no SKIP pill, as on web. */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={() => handoffRef.current()}
        accessibilityRole="button"
        accessibilityLabel="Loading StockPilot"
      >
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, gridStyle]}>
          <Grid w={vw} h={vh} />
        </Animated.View>

        {/* the scan beam: 1.5px leading edge + trailing gradient */}
        <Animated.View pointerEvents="none" style={[styles.beam, beamStyle]}>
          <View style={styles.beamTail} />
          <View style={styles.beamEdge} />
        </Animated.View>

        {/* the lockup, revealed in the beam's wake, centred at 44% of the
            viewport height exactly as the design specifies */}
        <View pointerEvents="none" style={[styles.lockWrap, { top: vh * 0.44 }]}>
          <Animated.View
            onLayout={(e) => setLockW(e.nativeEvent.layout.width)}
            style={[styles.lock, { opacity: lockV }]}
          >
            <View>
              <IntroMark size={markSize} />
              <View style={[styles.pulse, { left: markSize * 0.72, top: markSize * 0.24 }]}>
                <Animated.View style={[styles.pulseRing, pulseRingStyle]} />
                <Animated.View style={[styles.pulseDot, pulseDotStyle]} />
              </View>
            </View>
            <Text style={[styles.word, { fontSize: wordSize, marginLeft: gap }]}>
              Stock<Text style={styles.wordDim}>Pilot</Text>
            </Text>
            {/* React Native has no clip-path, so the remainder is covered by an
                ink curtain that slides right with the beam. translateX (not
                width) so it can run on the native driver. */}
            {!reduceMotion && lockW > 0 ? (
              <Animated.View
                pointerEvents="none"
                style={[styles.curtain, { width: lockW }, curtainStyle]}
              />
            ) : null}
          </Animated.View>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: INK, zIndex: 100 },
  gridH: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: GRID_LINE },
  gridV: { position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: GRID_LINE },
  beam: { position: 'absolute', top: 0, bottom: 0, left: 0, width: 91.5 },
  beamTail: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 1.5,
    width: 90,
    backgroundColor: 'rgba(250,249,244,0.10)',
  },
  beamEdge: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    width: 1.5,
    backgroundColor: PAPER,
    opacity: 0.9,
  },
  // Positioned by `top` from the render (44% of viewport height, per the
  // design) and pulled back up by half its own height so 44% is its CENTRE.
  lockWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    transform: [{ translateY: -28 }],
  },
  lock: { flexDirection: 'row', alignItems: 'center', overflow: 'hidden' },
  curtain: { position: 'absolute', top: -20, bottom: -20, left: 0, backgroundColor: INK },
  word: { fontFamily: FONT.display, color: PAPER, letterSpacing: -0.85 },
  wordDim: { opacity: 0.55 },
  pulse: { position: 'absolute', width: 0, height: 0 },
  pulseRing: {
    position: 'absolute',
    left: -7,
    top: -7,
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: MINT,
  },
  pulseDot: {
    position: 'absolute',
    left: -3.5,
    top: -3.5,
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: MINT,
  },
});
