import * as React from 'react';
import { Platform } from 'react-native';
import { CommonResolutions, useFrameOutput } from 'react-native-vision-camera';
import { createSynchronizable, scheduleOnRN } from 'react-native-worklets';

import {
  createGateState,
  frameTimestampToMsFactor,
  resetGateState,
  stepGate,
  type GatePhase,
} from './size-scan-gate-core';

/**
 * THE GATE'S CAMERA WIRING — sampling, buffers and dispatch. The DECISION
 * lives entirely in ./size-scan-gate-core (the garment lifecycle state
 * machine), where it is unit-tested against realistic frame sequences.
 *
 * ═══ DIVISION OF LABOUR ═══
 *
 *   this file   owns the pixels: sparse luma sampling of the counting lane,
 *               the three sample buffers (background / current / previous),
 *               and crossing runtime boundaries (worklet -> JS)
 *   the core    owns the decision: CALIBRATING -> WAITING -> PRESENT ->
 *               LOCKED, and every threshold
 *
 * Per frame this computes exactly two numbers and hands them to the core:
 *
 *   bgDelta   how unlike the calibrated EMPTY lane the lane looks now —
 *             presence and departure
 *   motion    how unlike the previous frame this frame looks — stillness
 *             and sharpness
 *
 * The core answers with an action: adopt the current frame as the background
 * ('setBackground' / 'clearLane'), photograph now ('fire'), or nothing.
 *
 * ═══ WHY THE LOCK LIVES IN THE CORE AND NOT IN `armed` ═══
 *
 * The first shipped version tried to prevent double counts with a timer and a
 * comparison against the last captured frame — and the first floor run
 * counted 23 passes for roughly ten shirts, because one MOVING shirt keeps
 * producing "changed" frames. Identity is now the LOCKED phase of the state
 * machine: a counted garment holds the lane until the lane sustainedly looks
 * empty again. `armed` remains only a run/stop switch — it no longer
 * participates in dedup at all, and nothing re-arms per capture.
 *
 * ═══ PERFORMANCE SHAPE (unchanged) ═══
 *
 * VGA yuv frames, 24×24 sparse luma reads (576 per frame), zero per-frame
 * allocation, dropFramesWhileBusy, throttled debug dispatch. The photo is a
 * separate full-quality output; this stream only drives the gate.
 */

/** Raw `Frame.timestamp` -> milliseconds, resolved ONCE on the JS thread and
 *  captured into the worklet as a plain number. iOS reports SECONDS, Android
 *  NANOSECONDS (see the citation in the core) — assuming ns jammed the first
 *  OTA's gate shut on iPhone entirely. */
const TS_TO_MS = frameTimestampToMsFactor(Platform.OS);

/** Sparse sample grid over the counting lane. 24*24 = 576 luma reads a frame,
 *  nothing next to decoding it. Sampling geometry, not decision logic, so it
 *  lives with the camera wiring rather than in the pure core. */
const GRID = 24;
/** Centred fraction of the frame that is sampled — THE COUNTING LANE. Edges
 *  are excluded: that is where the operator's hands and the next/previous
 *  garment live, and none of those may count as presence. The screen draws
 *  this same region so the operator can see what the gate watches. */
export const ROI = 0.6;

export type GateDebug = {
  /** Where the lifecycle is — drives the operator status line. */
  phase: GatePhase;
  /** Lane difference vs the calibrated empty background. */
  bgDelta: number;
  /** Frame-to-frame difference. */
  motion: number;
  armed: boolean;
};

export function useSizeScanGate(opts: {
  /** Fires ONCE per accepted garment traversal, on the JS thread. */
  onGarment: () => void;
  /** Live readout — phase for the status line, numbers for the tuning HUD.
   *  Throttled inside the worklet; never per-frame. */
  onDebug?: (d: GateDebug) => void;
}) {
  // Written in an effect, never during render: React may render a component
  // more than once before committing, and a ref mutated on a discarded render
  // is a value nothing asked for.
  const onGarmentRef = React.useRef(opts.onGarment);
  const onDebugRef = React.useRef(opts.onDebug);
  React.useEffect(() => {
    onGarmentRef.current = opts.onGarment;
    onDebugRef.current = opts.onDebug;
  }, [opts.onGarment, opts.onDebug]);

  /** Run/stop switch, JS -> worklet. NOT part of garment identity — the LOCKED
   *  phase owns dedup. A Synchronizable because the worklet runs on the camera
   *  runtime and cannot see React state. */
  const armed = React.useMemo(() => createSynchronizable(true), []);
  const setArmed = React.useCallback((v: boolean) => armed.setBlocking(v), [armed]);

  /** Reset request, JS -> worklet: bump the counter and the worklet re-enters
   *  CALIBRATING with fresh buffers on its next frame. Start and Keep-going
   *  call this so no stale lock or background leaks between runs. */
  const resetSeq = React.useMemo(() => createSynchronizable(0), []);
  const resetCounter = React.useRef(0);
  const resetGate = React.useCallback(() => {
    resetCounter.current += 1;
    resetSeq.setBlocking(resetCounter.current);
  }, [resetSeq]);

  /**
   * Stable dispatchers, captured into the worklet ONCE; they read the current
   * handler through a ref. THIS MATTERS: useFrameOutput reinstalls in an
   * effect keyed on `onFrame`'s identity, and reinstalling re-serializes the
   * closure — which would wipe the lifecycle state and the background,
   * making the gate forget a LOCKED garment. Nothing here may change identity.
   */
  const fire = React.useCallback(() => onGarmentRef.current(), []);
  // The null/undefined decision happens HERE, on the JS thread, where the ref
  // is live — never inside the worklet, whose captured objects are a
  // serialization-time snapshot (frozen in dev builds).
  const debug = React.useCallback(
    (phase: GatePhase, bgDelta: number, motion: number, isArmed: boolean) =>
      onDebugRef.current?.({ phase, bgDelta, motion, armed: isArmed }),
    [],
  );

  /** Sample buffers + lifecycle state, serialized into the camera runtime once
   *  and then mutated in place across frames. */
  const scratch = React.useMemo(
    () => ({
      /** The calibrated EMPTY lane — presence/departure reference. */
      bg: new Uint8Array(GRID * GRID),
      hasBg: false,
      /** This frame's sample (filled fresh each frame). */
      cur: new Uint8Array(GRID * GRID),
      /** The previous frame's sample — motion reference. */
      prev: new Uint8Array(GRID * GRID),
      hasPrev: false,
      gate: createGateState(),
      seenReset: 0,
      debugTick: 0,
      /** Last phase sent to JS — a transition bypasses the throttle so the
       *  operator status line changes the same frame the machine does. */
      lastSentPhase: '',
    }),
    [],
  );

  const onFrame = React.useCallback(
    (frame: {
      isPlanar: boolean;
      width: number;
      height: number;
      timestamp: number;
      getPlanes: () => { isValid: boolean; bytesPerRow: number; getPixelBuffer: () => ArrayBuffer }[];
      dispose: () => void;
    }) => {
      'worklet';
      try {
        // Consume a pending reset BEFORE anything else: fresh calibration,
        // forget the background and the previous frame.
        const wantReset = resetSeq.getDirty();
        if (wantReset !== scratch.seenReset) {
          scratch.seenReset = wantReset;
          resetGateState(scratch.gate);
          scratch.hasBg = false;
          scratch.hasPrev = false;
        }

        // 'yuv' is requested below precisely so plane 0 IS the 8-bit luma
        // plane — brightness, already separated, no conversion to pay for.
        if (!frame.isPlanar) return;
        const planes = frame.getPlanes();
        const luma = planes[0];
        if (luma == null || !luma.isValid) return;

        const buf = new Uint8Array(luma.getPixelBuffer());
        // INDEX WITH bytesPerRow, NEVER a plane width. On Android
        // FramePlane.width is rowStride/pixelStride — a stride, not an image
        // width — so using it silently samples a sheared, meaningless grid.
        const stride = luma.bytesPerRow;
        const fw = frame.width;
        const fh = frame.height;
        if (stride <= 0 || fw <= 0 || fh <= 0) return;

        const x0 = Math.floor((fw * (1 - ROI)) / 2);
        const y0 = Math.floor((fh * (1 - ROI)) / 2);
        const w = Math.floor(fw * ROI);
        const h = Math.floor(fh * ROI);

        const bg = scratch.bg;
        const cur = scratch.cur;
        const prev = scratch.prev;
        let bgSum = 0;
        let motionSum = 0;
        let i = 0;

        for (let gy = 0; gy < GRID; gy += 1) {
          const rowBase = (y0 + Math.floor((gy * h) / GRID)) * stride;
          for (let gx = 0; gx < GRID; gx += 1) {
            const idx = rowBase + x0 + Math.floor((gx * w) / GRID);
            // A short buffer degrades to 0 rather than throwing: this runs on
            // every frame, and an exception here stalls the camera pipeline.
            const v = idx < buf.length ? buf[idx]! : 0;
            cur[i] = v;
            if (scratch.hasBg) {
              const d = v - bg[i]!;
              bgSum += d < 0 ? -d : d;
            }
            if (scratch.hasPrev) {
              const d = v - prev[i]!;
              motionSum += d < 0 ? -d : d;
            }
            i += 1;
          }
        }

        const n = GRID * GRID;
        const motion = scratch.hasPrev ? motionSum / n : 255;
        const bgDelta = scratch.hasBg ? bgSum / n : 0;
        // Milliseconds — see TS_TO_MS. The unit is the whole 1.4.0 bug.
        const now = frame.timestamp * TS_TO_MS;
        const isArmed = armed.getDirty();

        // This frame becomes the next frame's motion reference.
        prev.set(cur);
        scratch.hasPrev = true;

        const action = stepGate(scratch.gate, now, bgDelta, motion, isArmed);

        // Dispatch AFTER the step so the phase shown is the phase entered
        // this frame — review measured the old pre-step dispatch lagging a
        // transition by up to ~8 frames, which put "Counted — slide it out"
        // a quarter of a garment-cycle late at the target pace. A phase
        // CHANGE bypasses the throttle entirely; unchanged frames stay
        // throttled because each dispatch crosses a runtime boundary.
        // No worklet-side null check on the ref: a serialized closure sees a
        // SNAPSHOT of captured objects (and dev builds freeze them), so the
        // decision to drop the callback lives on the JS side, which always
        // reads the live ref.
        const phaseNow = scratch.gate.phase;
        scratch.debugTick += 1;
        if (phaseNow !== scratch.lastSentPhase || scratch.debugTick >= 7) {
          scratch.debugTick = 0;
          scratch.lastSentPhase = phaseNow;
          scheduleOnRN(debug, phaseNow, bgDelta, motion, isArmed);
        }

        if (action === 'setBackground' || action === 'clearLane') {
          // Adopt the current frame as the empty lane: calibration completing,
          // quiet-lane drift adaptation, or re-baselining after a counted
          // garment left (which is how a slowly emptying box stays counted).
          bg.set(cur);
          scratch.hasBg = true;
          return;
        }
        if (action === 'fire') {
          scheduleOnRN(fire);
        }
      } finally {
        // NON-NEGOTIABLE. An undisposed frame holds a buffer the pipeline
        // needs back; skip it and the camera starves within a second.
        frame.dispose();
      }
    },
    [scratch, armed, resetSeq, fire, debug],
  );

  const frameOutput = useFrameOutput({
    // 'yuv' EXPLICITLY. 'native' may resolve to 'private' — a GPU-only buffer
    // where getPixelBuffer() throws rather than returning pixels.
    pixelFormat: 'yuv',
    // VGA is far more resolution than a 24x24 grid needs, and asking for less
    // work per frame is free accuracy elsewhere. The PHOTO is captured
    // separately at full quality; this stream only drives the gate.
    targetResolution: CommonResolutions.VGA_16_9,
    dropFramesWhileBusy: true,
    onFrame,
  });

  return { frameOutput, setArmed, resetGate };
}
