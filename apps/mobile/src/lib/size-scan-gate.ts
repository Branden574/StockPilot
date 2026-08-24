import * as React from 'react';
import { Platform } from 'react-native';
import { CommonResolutions, useFrameOutput } from 'react-native-vision-camera';
import { createSynchronizable, scheduleOnRN } from 'react-native-worklets';

import { decideGate, frameTimestampToMsFactor } from './size-scan-gate-core';

/**
 * THE GATE — the thing that decides when a garment has passed, without asking
 * anyone to tap.
 *
 * A phone is propped over a table. Garments are SLID past underneath it, one
 * after another, at roughly one a second. The gate has to fire exactly one
 * cloud read per garment: never twice for one shirt, never zero for a shirt
 * that went by.
 *
 * ═══ WHY THIS IS A SCENE-CHANGE GATE AND NOT A MOTION-SETTLE ONE ═══
 *
 * The obvious design is "wait for the scene to go still, then shoot" — an item
 * arrives, settles, gets photographed. That is what a conveyor SCANNER does and
 * it is what the first draft of this file did.
 *
 * It does not work here, because nothing ever settles. Garments are slid, not
 * placed: there is no still moment to trigger on, and waiting for one either
 * fires never (the scene is always moving) or fires on whatever incidental
 * pause happens to occur. Building the settle version and discovering that on
 * the floor would have cost a hardware round trip.
 *
 * So the question is not "has it stopped?" but "IS WHAT I AM LOOKING AT NOW
 * DIFFERENT FROM WHAT I LAST PHOTOGRAPHED?". That question has a clean answer
 * during continuous motion, and it is the one that maps onto the actual
 * requirement:
 *
 *   - the same shirt still crossing the frame  -> looks like the last capture
 *                                                 -> DOES NOT FIRE  (no double count)
 *   - a different shirt now under the camera   -> looks unlike it
 *                                                 -> FIRES           (no missed item)
 *
 * Two shirts of the SAME SIZE in a row still fire twice, because the reference
 * is the last captured IMAGE, not the last read SIZE. Different fabric, fold
 * and position make the frames differ even when the letters on the dot match.
 * That is the exact case that defeated the alternative design — asking the
 * model to dedup across frames merged three consecutive XS shirts into one.
 *
 * ═══ THE SECOND CONDITION: SHARP ENOUGH TO READ ═══
 *
 * Difference alone would fire mid-sweep, on a motion-blurred frame the reader
 * cannot resolve. So a capture needs BOTH:
 *
 *   1. the scene differs from the last capture   (a new garment is present)
 *   2. instantaneous motion is momentarily low   (this frame is sharp)
 *
 * Even a fast slide has a lull as the garment is centred, which is exactly the
 * moment worth photographing. If the lull never comes, the deadline below fires
 * anyway on the least-bad frame — a slightly soft photo that reads is worth far
 * more than a missed garment, because a miss is silent and a soft read is not.
 *
 * ═══ WHAT THIS DELIBERATELY DOES NOT DO ═══
 *
 * It does not recognise stickers, garments or sizes. It counts SCENE CHANGES.
 * All reading happens in the cloud, where it is measured at 99.3%. Keeping the
 * two apart is what makes "52 passed · 49 read · 3 unread" possible: the gate
 * knows how many garments went by even when the reader could not see a sticker
 * on one, so an unreadable garment announces itself instead of quietly
 * shortening the count.
 *
 * ═══ NONE OF THE THRESHOLDS BELOW ARE VALIDATED ═══
 *
 * They are starting points from arithmetic, not measurements — no camera has
 * ever run this. Warehouse lighting, table colour, garment colour and slide
 * speed all move them. `onDebug` exists so they can be tuned against a live
 * readout on hardware rather than guessed at twice.
 */

// The tuning constants (SCENE_CHANGED, SHARP_ENOUGH, FORCE_AFTER_MS,
// REFRACTORY_MS) and the whole fire decision live in ./size-scan-gate-core —
// a pure, React-Native-free module so the decision can be unit-tested against
// the timestamps each platform actually produces. This file is the CAMERA
// wiring; that file is the LOGIC. GRID and ROI come from there too.

/** Raw `Frame.timestamp` -> milliseconds, resolved ONCE on the JS thread and
 *  captured into the worklet as a plain number. iOS reports seconds, Android
 *  nanoseconds; see frameTimestampToMsFactor for the citation. This is the fix
 *  for the 1.4.0 "counts nothing" bug — the gate assumed nanoseconds and its
 *  refractory window became 350,000,000 ms, permanently open. */
const TS_TO_MS = frameTimestampToMsFactor(Platform.OS);

/** Sparse sample grid over the region of interest. 24*24 = 576 luma reads a
 *  frame, nothing next to decoding it. Sampling geometry, not decision logic,
 *  so it lives with the camera wiring rather than in the pure core. */
const GRID = 24;
/** Centred fraction of the frame that is sampled. Excludes the edges, where
 *  the operator's hands live and would otherwise read as scene change. */
const ROI = 0.6;

export type GateDebug = {
  /** Difference against the last captured frame — drives condition 1. */
  sceneDelta: number;
  /** Difference against the previous frame — drives condition 2. */
  motion: number;
  armed: boolean;
};

export function useSizeScanGate(opts: {
  /** Fires ONCE per garment, on the JS thread. Take the photo here. */
  onGarment: () => void;
  /** Live readout for the tuning HUD. Throttled; never per-frame. */
  onDebug?: (d: GateDebug) => void;
}) {
  // Written in an effect, never during render: React may render a component
  // more than once before committing, and a ref mutated on a discarded render
  // is a value nothing asked for. The effect runs after commit and long before
  // the next camera frame, so the worklet never reads a stale handler.
  const onGarmentRef = React.useRef(opts.onGarment);
  const onDebugRef = React.useRef(opts.onDebug);
  React.useEffect(() => {
    onGarmentRef.current = opts.onGarment;
    onDebugRef.current = opts.onDebug;
  }, [opts.onGarment, opts.onDebug]);

  /**
   * JS -> worklet, disarmed while the review sheet is open or the session is
   * closed. A Synchronizable rather than a ref because the worklet runs on the
   * camera runtime and cannot see React state.
   */
  const armed = React.useMemo(() => createSynchronizable(true), []);
  const setArmed = React.useCallback((v: boolean) => armed.setBlocking(v), [armed]);

  /**
   * Stable dispatchers. Captured into the worklet ONCE; they read the current
   * handler through a ref, so re-rendering with a new callback does not change
   * the worklet's identity.
   *
   * THIS MATTERS MORE THAN IT LOOKS: useFrameOutput reinstalls in an effect
   * keyed on `onFrame`'s identity, and reinstalling RE-SERIALIZES the closure —
   * which resets `scratch`, losing the reference frame and the refractory. A
   * gate that silently forgets what it last photographed double-counts.
   */
  const fire = React.useCallback(() => onGarmentRef.current(), []);
  const debug = React.useCallback(
    (sceneDelta: number, motion: number, isArmed: boolean) =>
      onDebugRef.current?.({ sceneDelta, motion, armed: isArmed }),
    [],
  );

  /** Detector state, serialized into the camera runtime once then mutated in
   *  place. Not readable from JS, which is fine — it is nobody else's business. */
  const scratch = React.useMemo(
    () => ({
      /** The grid sample of the last frame we CAPTURED. The reference. */
      ref: new Uint8Array(GRID * GRID),
      hasRef: false,
      /** The grid sample of the immediately preceding frame, for sharpness. */
      prev: new Uint8Array(GRID * GRID),
      hasPrev: false,
      /** Timestamp the scene first differed from the reference. 0 = it doesn't. */
      changedAt: 0,
      lastFiredAt: 0,
      debugTick: 0,
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
        // Geometry comes from the FRAME.
        const stride = luma.bytesPerRow;
        const fw = frame.width;
        const fh = frame.height;
        if (stride <= 0 || fw <= 0 || fh <= 0) return;

        const x0 = Math.floor((fw * (1 - ROI)) / 2);
        const y0 = Math.floor((fh * (1 - ROI)) / 2);
        const w = Math.floor(fw * ROI);
        const h = Math.floor(fh * ROI);

        const ref = scratch.ref;
        const prev = scratch.prev;
        let sceneSum = 0;
        let motionSum = 0;
        let i = 0;

        for (let gy = 0; gy < GRID; gy += 1) {
          const rowBase = (y0 + Math.floor((gy * h) / GRID)) * stride;
          for (let gx = 0; gx < GRID; gx += 1) {
            const idx = rowBase + x0 + Math.floor((gx * w) / GRID);
            // A short buffer degrades to 0 rather than throwing: this runs on
            // every frame, and an exception here stalls the camera pipeline.
            const v = idx < buf.length ? buf[idx]! : 0;
            if (scratch.hasRef) {
              const d = v - ref[i]!;
              sceneSum += d < 0 ? -d : d;
            }
            if (scratch.hasPrev) {
              const d = v - prev[i]!;
              motionSum += d < 0 ? -d : d;
            }
            prev[i] = v;
            i += 1;
          }
        }
        scratch.hasPrev = true;

        const n = GRID * GRID;
        const motion = motionSum / n;
        const sceneDelta = scratch.hasRef ? sceneSum / n : 255;
        // Normalised to MILLISECONDS — see TS_TO_MS. Was `frame.timestamp`
        // (nanoseconds assumed), which is seconds on iOS and jammed the gate.
        const now = frame.timestamp * TS_TO_MS;
        const isArmed = armed.getDirty();

        if (onDebugRef.current != null) {
          // Throttled: every call crosses a runtime boundary, and doing that
          // per frame is its own performance problem.
          scratch.debugTick += 1;
          if (scratch.debugTick >= 7) {
            scratch.debugTick = 0;
            scheduleOnRN(debug, sceneDelta, motion, isArmed);
          }
        }

        // THE DECISION lives in the pure core so it can be unit-tested against
        // real iPhone/Android timestamps (see size-scan-gate-core.test.ts).
        // `scratch` supplies the two mutable timing fields decideGate needs;
        // it mutates them in place — both run on the camera runtime, so this is
        // a direct worklet call with no serialization.
        if (!decideGate(scratch, now, sceneDelta, motion, isArmed)) return;

        // Fired: this frame becomes the new reference so the SAME garment does
        // not fire again as it finishes crossing.
        ref.set(prev);
        scratch.hasRef = true;
        scheduleOnRN(fire);
      } finally {
        // NON-NEGOTIABLE. An undisposed frame holds a buffer the pipeline needs
        // back; skip it and the camera starves within a second.
        frame.dispose();
      }
    },
    [scratch, armed, fire, debug],
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

  return { frameOutput, setArmed };
}
