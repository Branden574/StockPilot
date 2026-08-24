/**
 * THE GATE'S DECISION, as a pure function — so it can be tested against the
 * timestamps each platform ACTUALLY produces.
 *
 * ═══ WHY THIS FILE EXISTS: THE iOS UNITS BUG ═══
 *
 * The first hardware run of the hands-free counter counted nothing. Not "too
 * few" — nothing, with a sticker plainly in frame. The camera ran, the worklet
 * ran, and every frame returned before the fire logic, because
 * `Frame.timestamp` is in SECONDS on iOS and NANOSECONDS on Android:
 *
 *     ios/Hybrid Objects/Image Types/HybridFrame.swift:36
 *         return metadata.timestamp.seconds
 *     android/.../hybrids/instances/HybridFrame.kt:29
 *         get() = image.imageInfo.timestamp.toDouble()      // CameraX: ns
 *
 * and the gate assumed nanoseconds everywhere. With `now` in the thousands, the
 * refractory check `now - 0 < 350_000_000` was true on every frame, forever.
 * The typings say only "presentation timestamp"; the unit is documented nowhere
 * in the package, and the simulator has no camera, so nothing short of a real
 * phone could have exposed it.
 *
 * So two things changed. Timestamps are normalised to MILLISECONDS at the
 * boundary, per platform, with the two native lines above as the citation. And
 * the decision lives here, with no React Native imports, where a test can feed
 * it iPhone-shaped timestamps and prove it fires — the test this bug needed and
 * did not have.
 *
 * Every function here that the worklet calls carries the `'worklet'` directive:
 * a worklet may only call other worklets, and in Node the directive is an inert
 * string, so the same code runs in the camera runtime and under vitest.
 */

// ─── tuning (all in mean |delta| of 8-bit luma, so 0..255; times in ms) ─────
//
// NONE OF THESE ARE VALIDATED against a real floor yet. They are starting
// points from arithmetic; the HUD on the hands-free screen exists so they can
// be tuned against a live readout rather than guessed at twice.

/** How different the scene must be from the LAST CAPTURE before a new garment
 *  is believed to be present. The main dial: too low double-counts one shirt,
 *  too high skips shirts that resemble their predecessor. */
export const SCENE_CHANGED = 12;

/** Instantaneous frame-to-frame motion at or below which a frame is considered
 *  sharp enough to read. Not a stop — just a lull. */
export const SHARP_ENOUGH = 6;

/** Hard deadline. Once the scene has been "changed" for this long without ever
 *  going sharp, fire anyway on the calmest frame seen. A soft photo that reads
 *  beats a garment that was never photographed. */
export const FORCE_AFTER_MS = 700;

/** Minimum gap between captures. Belt-and-braces against a single garment
 *  firing twice; at one garment per second this costs nothing. */
export const REFRACTORY_MS = 350;

/**
 * Multiply a raw `Frame.timestamp` by this to get milliseconds.
 *
 * Resolved ONCE on the JS side and captured into the worklet as a number, so
 * the worklet never has to know which platform it is on.
 */
export function frameTimestampToMsFactor(os: string): number {
  // iOS: CMTime -> seconds (HybridFrame.swift:36).
  if (os === 'ios') return 1000;
  // Android: CameraX ImageInfo.timestamp, nanoseconds (HybridFrame.kt:29).
  return 1e-6;
}

/** The detector's timing state. Mutated in place — it lives inside the camera
 *  runtime and persists across frames. All values in milliseconds. */
export type GateTiming = {
  /** When the scene first differed from the reference. 0 = it currently
   *  matches, or the window was deliberately reset. */
  changedAt: number;
  /** When the gate last fired. 0 = never. */
  lastFiredAt: number;
};

/**
 * Decide whether THIS frame is the one to photograph.
 *
 * @param sceneDelta  mean |luma delta| against the last CAPTURED frame; 255
 *                    when there is no reference yet, so the first armed frame
 *                    always reads as "a new scene"
 * @param motion      mean |luma delta| against the PREVIOUS frame
 * @returns true exactly when the caller should capture and re-reference.
 */
export function decideGate(
  timing: GateTiming,
  nowMs: number,
  sceneDelta: number,
  motion: number,
  armed: boolean,
): boolean {
  'worklet';
  if (!armed) {
    // Disarmed (review sheet open). The caller keeps sampling so `prev` stays
    // current, but no change window may accumulate — otherwise the moment we
    // re-arm we fire on a stale one.
    timing.changedAt = 0;
    return false;
  }
  if (nowMs - timing.lastFiredAt < REFRACTORY_MS) return false;

  if (sceneDelta < SCENE_CHANGED) {
    // Same garment still under the camera. This is the branch that stops one
    // shirt being counted five times as it crosses.
    timing.changedAt = 0;
    return false;
  }

  // A different garment is present. Wait for a lull to get a sharp frame, but
  // not forever.
  if (timing.changedAt === 0) timing.changedAt = nowMs;
  const waited = nowMs - timing.changedAt;
  if (motion > SHARP_ENOUGH && waited < FORCE_AFTER_MS) return false;

  timing.changedAt = 0;
  timing.lastFiredAt = nowMs;
  return true;
}
