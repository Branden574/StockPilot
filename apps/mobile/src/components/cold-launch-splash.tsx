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
 * Timings and easings are the design package's, shared verbatim with the web
 * intro so the two surfaces cannot drift.
 */

// ── timeline (ms) — mirrors the web intro exactly ─────────────────────
const GRID_IN = 200;
const BEAM_START = 120;
const BEAM_END = 620;
const PULSE_START = 640;
const ANIM_DONE = 900; // full sequence complete
const REDUCED_DONE = 300; // opacity-only lane
export const CROSSFADE_MS = 460; // splash-out → Face-ID-in dissolve
const REDUCED_CROSSFADE_MS = 240;

// Brand surface. ALWAYS dark — a branded loading screen, independent of theme.
// Ink matches the landing hero so the two surfaces are the same colour.
const INK = '#0b0c0a';
const PAPER = '#faf9f4';
const MINT = '#5db89f';
const GRID_LINE = 'rgba(250,249,244,0.045)';
const GRID_CELL = 56;

// ── easings (verbatim from the design prototype) ──────────────────────
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const seg = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
const easeInOut = (x: number) =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

/**
 * The mark, in the landing nav's geometry — the S and the pip are carved
 * negative space through a mask, never drawn as foreground strokes. Kept
 * identical to the web intro's mark so both surfaces show one logo.
 */
function IntroMark({ size }: { size: number }) {
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
}

/** Confirmation pulse, anchored to the pip at (72%, 24%) of the mark box. */
function Pulse({ markSize, p }: { markSize: number; p: number }) {
  if (p <= 0 || p >= 1) return null;
  const ring = easeOut(p);
  const dot = clamp01(p / 0.25) * (1 - clamp01((p - 0.45) / 0.55));
  return (
    <View
      pointerEvents="none"
      style={[styles.pulse, { left: markSize * 0.72, top: markSize * 0.24 }]}
    >
      <View
        style={[
          styles.pulseRing,
          { transform: [{ scale: 0.4 + ring * 1.9 }], opacity: 0.75 * (1 - ring) },
        ]}
      />
      <View style={[styles.pulseDot, { opacity: dot }]} />
    </View>
  );
}

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
  const [t, setT] = React.useState(0);
  const [reduceMotion, setReduceMotion] = React.useState(false);

  const fade = React.useRef(new Animated.Value(1)).current;
  const rafRef = React.useRef<number | null>(null);
  const startRef = React.useRef<number | null>(null);
  const handedOff = React.useRef(false);
  /** Real lockup width, from layout. The beam-driven reveal needs the true
   *  width to know where the lockup starts and ends on screen; an estimate
   *  makes the wipe finish early or late, and a percentage-width curtain does
   *  not resolve reliably against a content-sized row in React Native. */
  const [lockW, setLockW] = React.useState(0);

  // Lockup geometry — the web intro's small breakpoint (phones are <= 480px).
  const markSize = 56;
  const wordSize = 34;
  const gap = 14;

  const handoff = React.useCallback(() => {
    if (handedOff.current) return;
    handedOff.current = true;
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    onHandoff?.();
    Animated.timing(fade, {
      toValue: 0,
      duration: reduceMotion ? REDUCED_CROSSFADE_MS : CROSSFADE_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(() => onDone?.());
  }, [fade, onHandoff, onDone, reduceMotion]);

  // Hold the latest handoff so the timeline effect never restarts on re-render.
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

  // Drive the timeline. Depends only on reduceMotion.
  React.useEffect(() => {
    const done = reduceMotion ? REDUCED_DONE : ANIM_DONE;
    const loop = (now: number) => {
      if (startRef.current == null) startRef.current = now;
      const elapsed = now - startRef.current;
      setT(elapsed);
      if (elapsed >= done) {
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

  // ── the frame ───────────────────────────────────────────────────────
  let gridOpacity: number;
  let lockOpacity: number;
  let hiddenPx = 0; // px of the lockup still behind the curtain, from the right
  let beam: { x: number; opacity: number } | null = null;
  let pulseP = 0;

  if (reduceMotion) {
    // Opacity only: static grid, no beam, no pulse, nothing translates.
    gridOpacity = 0.5;
    lockOpacity = easeOut(seg(t, 0, REDUCED_DONE));
  } else {
    gridOpacity = easeOut(seg(t, 0, GRID_IN)) * 0.9;
    const sweep = easeInOut(seg(t, BEAM_START, BEAM_END));
    const span = Math.min(vw * 0.56, 700);
    const beamX = vw / 2 - span / 2 + sweep * span;
    const beamO = seg(t, BEAM_START, 190) * (1 - seg(t, 560, 650));
    if (beamO > 0.01) beam = { x: beamX, opacity: beamO };
    // Hold the lockup fully hidden until we have measured it — revealing it
    // against a guessed width is what made it pop in rather than wipe in.
    const left = vw / 2 - lockW / 2;
    const cov = lockW === 0 ? 0 : t >= BEAM_END ? 1 : clamp01((beamX - left) / lockW);
    hiddenPx = (1 - cov) * lockW;
    lockOpacity = t < BEAM_START ? 0 : 1;
    pulseP = seg(t, PULSE_START, ANIM_DONE);
  }

  const rows = Math.ceil(vh / GRID_CELL) + 1;
  const cols = Math.ceil(vw / GRID_CELL) + 1;

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.root, { opacity: fade }]}>
      {/* The whole surface is the skip affordance — no SKIP pill, as on web. */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={() => handoffRef.current()}
        accessibilityRole="button"
        accessibilityLabel="Loading StockPilot"
      >
        {/* warehouse grid, mirroring the landing hero's */}
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: gridOpacity }]}>
          {Array.from({ length: rows }).map((_, i) => (
            <View key={`h${i}`} style={[styles.gridH, { top: i * GRID_CELL - 28 }]} />
          ))}
          {Array.from({ length: cols }).map((_, i) => (
            <View key={`v${i}`} style={[styles.gridV, { left: i * GRID_CELL - 28 }]} />
          ))}
        </View>

        {/* the scan beam: 1.5px leading edge + trailing gradient */}
        {beam ? (
          <View pointerEvents="none" style={[styles.beam, { left: beam.x - 90, opacity: beam.opacity }]}>
            <View style={styles.beamTail} />
            <View style={styles.beamEdge} />
          </View>
        ) : null}

        {/* the lockup, revealed in the beam's wake, centred at 44% of the
            viewport height exactly as the design specifies */}
        <View pointerEvents="none" style={[styles.lockWrap, { top: vh * 0.44 }]}>
          <View
            onLayout={(e) => setLockW(e.nativeEvent.layout.width)}
            style={[styles.lock, { opacity: lockOpacity }]}
          >
            <View>
              <IntroMark size={markSize} />
              <Pulse markSize={markSize} p={pulseP} />
            </View>
            <Text style={[styles.word, { fontSize: wordSize, marginLeft: gap }]}>
              Stock<Text style={styles.wordDim}>Pilot</Text>
            </Text>
            {/* React Native has no clip-path, so the not-yet-revealed remainder
                is covered by an ink curtain that retreats with the beam. Same
                result, and it stays on the surface colour so there is no seam. */}
            {hiddenPx > 0.5 ? (
              <View pointerEvents="none" style={[styles.curtain, { width: hiddenPx }]} />
            ) : null}
          </View>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: INK, zIndex: 100 },
  gridH: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: GRID_LINE },
  gridV: { position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: GRID_LINE },
  beam: { position: 'absolute', top: 0, bottom: 0, width: 91.5 },
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
  curtain: { position: 'absolute', top: -20, bottom: -20, right: 0, backgroundColor: INK },
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
