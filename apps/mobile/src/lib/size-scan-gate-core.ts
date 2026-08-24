/**
 * THE GARMENT LIFECYCLE — a state machine over what is physically in the
 * counting lane, as a pure module so every transition can be unit-tested.
 *
 * ═══ WHY A STATE MACHINE, NOT A SCENE-CHANGE THRESHOLD ═══
 *
 * The first shipped gate asked one question per frame: "does this frame look
 * different from the frame I last photographed?" — and fired whenever the
 * answer was yes. The first real floor run showed why that is the wrong
 * question: 23 "garments" passed for roughly ten real shirts, because ONE
 * SHIRT THAT MOVES answers yes too. Folds shift, fabric bends, shadows slide,
 * the operator's hand crosses, exposure breathes — the same physical garment
 * keeps producing "different" frames, and after the 350ms refractory each one
 * fired again. A timer is not identity.
 *
 * The question that maps onto the physical workflow is not "did the scene
 * change?" but "WHERE IN THE GARMENT'S LIFECYCLE ARE WE?":
 *
 *     CALIBRATING   the lane is being learned while empty
 *          ↓
 *     WAITING       lane matches the empty background — ready
 *          ↓        (sustained presence above PRESENT_MIN)
 *     PRESENT       a garment has arrived; wait for a sharp frame
 *          ↓        (lull, or the force deadline)
 *        FIRE       photograph it — exactly once
 *          ↓
 *     LOCKED        that garment is COUNTED. However it moves, folds or
 *          ↓        shimmers, it cannot count again.
 *          ↓        (sustained return towards the empty background)
 *     WAITING       lane is clear again; the NEXT garment may count
 *
 * The lock is the identity model: one continuous traversal of the lane is one
 * count, and the only way out of LOCKED is the lane going back to looking
 * EMPTY — compared against the calibrated background, not against the
 * garment's own last appearance. A shirt fidgeting in the lane keeps the lane
 * un-empty, so it stays locked, so it stays counted once. That is the whole
 * fix.
 *
 * ═══ WHY THE BACKGROUND RE-BASELINES ON EVERY CLEAR ═══
 *
 * Real lanes drift: shirts get lifted out of the box the camera can also see,
 * lighting moves, the table gathers lint. When the lane clears, whatever it
 * now looks like IS the new empty — so the caller re-captures the background
 * on every 'clearLane'. Between garments, a slow adaptation ('setBackground'
 * after ADAPT_MS of quiet) absorbs exposure drift so an untouched lane can
 * never creep across the presence threshold on its own.
 *
 * ═══ HYSTERESIS, SUSTAIN, AND WHAT THEY PREVENT ═══
 *
 * Presence and clearance use DIFFERENT thresholds (PRESENT_MIN far above
 * CLEAR_MAX) with a dead band between them where nothing changes state — one
 * threshold used for both directions chatters when the signal hovers near it.
 * Every transition also requires its condition to hold for a sustained window
 * (CANDIDATE_MS, CLEAR_MS, CAL_STABLE_MS), so a single odd frame — a hand
 * shadow, an exposure pulse, one blurred sample — moves nothing.
 *
 * ═══ THE ADOPTION CASCADE, AND WHERE IT IS BROKEN ═══
 *
 * When a GARMENT gets adopted as background (a counted shirt parked
 * dead-still past LOCKED_REBASE_MS — the documented trade), a paced stream of
 * same-level garments can enter a cycle: each arrival reads ~0 against the
 * garment-background and releases the previous lock, each DEPARTURE reads as
 * presence and fires — so every photo in the cycle shows an empty lane and
 * the whole stream lands unread (pass-per-garment parity holds; readability
 * does not). The machine cannot break this cycle from scalars alone; the
 * SCREEN breaks it: consecutive nothing-visible reads trigger a recalibration
 * (see the hands-free screen), which re-learns the true empty lane at the
 * next gap. Worst case before the breaker trips: a few unread garments the
 * operator is already told to re-pass.
 *
 * ═══ WHAT THIS HONESTLY CANNOT DO ═══
 *
 * It cannot separate two garments with NO visible gap between them. The lock
 * releases on CLEAR_MS (250ms) of the lane looking empty; garments slid
 * conveyor-style with sub-250ms gaps merge into one traversal and count once
 * — the opposite failure direction from the double-count this machine fixes,
 * and inherent to traversal identity. The operator contract is a visible gap
 * between garments; the "Counted — slide it out" status line is the cue.
 *
 * It cannot recognise a specific shirt. If the operator carries a counted
 * garment fully out and later presents it again, it counts again — without a
 * barcode/RFID there is no visual guarantee two identical shirts are the same
 * object, and pretending otherwise would undercount stock. The contract is
 * exactly: ONE CONTINUOUS TRAVERSAL = ONE COUNT.
 *
 * ═══ THE iOS UNITS LESSON, KEPT ═══
 *
 * `Frame.timestamp` is SECONDS on iOS and NANOSECONDS on Android — verified
 * against the installed react-native-vision-camera 5.2.3 native source, since
 * the typings say only "presentation timestamp":
 *
 *     ios/Hybrid Objects/Image Types/HybridFrame.swift:36
 *         return metadata.timestamp.seconds
 *     android/.../hybrids/instances/HybridFrame.kt:29
 *         get() = image.imageInfo.timestamp.toDouble()      // CameraX: ns
 *
 * Assuming ns everywhere made the first OTA's refractory window 350,000,000ms
 * on iPhone — the gate could not fire at all. Everything here is MILLISECONDS,
 * converted once at the boundary by frameTimestampToMsFactor.
 *
 * Every function the camera worklet calls carries the 'worklet' directive; in
 * Node it is an inert string, so the same code runs under vitest.
 */

// ─── tuning ─────────────────────────────────────────────────────────────────
//
// Deltas are mean |difference| of 8-bit luma (0..255); times are ms. These are
// STARTING POINTS, not measurements — the floor run that exposed the identity
// bug never exercised these because the old gate had no lifecycle at all. The
// hands-free HUD shows phase/bgDelta/motion live so they can be tuned against
// real lighting, garments and slide speed instead of guessed at again.

/** Lane-vs-background difference above which a garment is believed PRESENT.
 *  The hysteresis high side. Too low: hands/shadows become garments. Too
 *  high: dark shirts on dark tables never register. */
export const PRESENT_MIN = 18;

/** Lane-vs-background difference below which the lane is believed EMPTY
 *  again. The hysteresis low side — deliberately far under PRESENT_MIN; in
 *  between, the state HOLDS. Also the ceiling under which the background is
 *  allowed to adapt. */
export const CLEAR_MAX = 8;

/** How long presence must be sustained before a garment is credible. Filters
 *  a hand flashing across the lane; a real garment dwells at least this long
 *  even at a brisk one-per-second pace. */
export const CANDIDATE_MS = 150;

/** How long the lane must look empty before LOCKED releases. Filters one
 *  deceptive mid-motion frame from ending a lock early. */
export const CLEAR_MS = 250;

/** How long the scene must hold still (motion <= STABLE_MOTION) to finish
 *  calibration and capture the empty background. */
export const CAL_STABLE_MS = 600;

/** Frame-to-frame motion at or below which the scene counts as STILL — used
 *  for calibration and background adaptation. */
export const STABLE_MOTION = 3;

/** Quiet time in WAITING after which the background re-captures, absorbing
 *  exposure and lighting drift so an empty lane cannot slowly walk across
 *  PRESENT_MIN on its own. */
export const ADAPT_MS = 1200;

/** Frame-to-frame motion at or below which a PRESENT garment is sharp enough
 *  to photograph. Not a stop — a lull. */
export const SHARP_ENOUGH = 6;

/** Once PRESENT, fire no later than this even if no lull ever comes — a soft
 *  photo that reads beats a garment that was never photographed, because a
 *  miss is silent and a soft read shows up as unread. */
export const FORCE_AFTER_MS = 700;

/** Absolute floor between fires. Belt-and-braces UNDER the lifecycle, never a
 *  substitute for it — the 1.4.x bug was treating this timer as identity. */
export const REFRACTORY_MS = 350;

/**
 * The lock's clear threshold — deliberately LOOSER than CLEAR_MAX.
 *
 * The lock only exists because presence proved bgDelta >= PRESENT_MIN (18).
 * So once the lane sustains BELOW this value, the thing that was counted is
 * demonstrably gone — what remains (a permanent lighting step, an exposure
 * shift, the box minus one shirt) is background error, and the clear's
 * re-baseline adopts it. This is what heals a background that shifted by up
 * to 12 during a traversal WITHOUT the widened-adaptation approach that
 * review proved poisonous, and without waiting for the 2.5s stillness
 * recovery. The 6-point gap to PRESENT_MIN keeps hysteresis real; shifts of
 * 13..17 still wedge briefly and heal via LOCKED_REBASE_MS.
 */
export const CLEAR_RELAXED_MAX = 12;

/**
 * LOCKED's recovery exit: if the scene holds STILL this long while locked,
 * adopt it as the new background and stand ready.
 *
 * WHY THIS EXISTS — adversarial review confirmed two deadlocks without it:
 * (a) calibration over a garment (Start/Keep-going with a shirt already in the
 * lane) leaves a background the empty lane can never match, and (b) any
 * permanent scene shift > CLEAR_MAX during a traversal (a light switching, an
 * exposure step, one shirt leaving a visible box) leaves the old background
 * permanently unreachable. Both froze the lock FOREVER and silently uncounted
 * every later garment.
 *
 * The recovery's reasoning: garments in this workflow are continuously
 * handled, so a lane that has been dead-still for 2.5s is not a garment
 * mid-traversal — it is the (possibly shifted) empty lane, or an operator
 * pause. Adopting it costs a bounded, VISIBLE failure in the pause case: a
 * parked garment becomes background, and its later departure fires one
 * phantom pass that lands in `unread` (the reader sees an empty lane). That
 * trade is deliberate — an occasional visible unread beats an invisible,
 * unbounded count stall, which is the exact failure the file's own
 * FORCE_AFTER_MS note calls the worst kind.
 */
export const LOCKED_REBASE_MS = 2500;

/**
 * Multiply a raw `Frame.timestamp` by this to get milliseconds.
 * Resolved ONCE on the JS side and captured into the worklet as a number.
 */
export function frameTimestampToMsFactor(os: string): number {
  // iOS: CMTime -> seconds (HybridFrame.swift:36).
  if (os === 'ios') return 1000;
  // Android: CameraX ImageInfo.timestamp, nanoseconds (HybridFrame.kt:29).
  return 1e-6;
}

/** Where the lane is in the garment lifecycle. Shown on the HUD and driving
 *  the operator status line, so the names are user-meaningful. */
export type GatePhase = 'calibrating' | 'waiting' | 'present' | 'locked';

/**
 * What the caller (the camera worklet) must DO after this frame. The state
 * machine owns the decision; the worklet owns the buffers.
 *
 *   'none'           nothing
 *   'setBackground'  copy the current frame sample into the background
 *                    reference (calibration finished, or quiet-lane adaptation)
 *   'fire'           photograph NOW — exactly one garment traversal accepted
 *   'clearLane'      the counted garment left: copy the current frame sample
 *                    into the background (re-baseline) and stand ready
 */
export type GateAction = 'none' | 'setBackground' | 'fire' | 'clearLane';

/** The machine's mutable state. Lives inside the camera runtime, mutated in
 *  place every frame. All times ms; 0 means "window not open". */
export type GateState = {
  phase: GatePhase;
  /** Stability window while calibrating. */
  calStart: number;
  /** Sustained-presence window while waiting. */
  presenceStart: number;
  /** Quiet-lane adaptation window while waiting. */
  adaptStart: number;
  /** When the phase became 'present' — the force deadline counts from here. */
  presentSince: number;
  /** Sustained-clear window while locked. */
  clearStart: number;
  /** Sustained-stillness window while locked — the recovery exit. */
  lockStillStart: number;
  lastFiredAt: number;
};

export function createGateState(): GateState {
  return {
    phase: 'calibrating',
    calStart: 0,
    presenceStart: 0,
    adaptStart: 0,
    presentSince: 0,
    clearStart: 0,
    lockStillStart: 0,
    lastFiredAt: 0,
  };
}

/** Reset to a fresh calibration. Used on Start and Keep-going, so a stopped
 *  run never leaks a stale lock or background into the next one. */
export function resetGateState(s: GateState): void {
  'worklet';
  s.phase = 'calibrating';
  s.calStart = 0;
  s.presenceStart = 0;
  s.adaptStart = 0;
  s.presentSince = 0;
  s.clearStart = 0;
  s.lockStillStart = 0;
  s.lastFiredAt = 0;
}

/**
 * Advance the lifecycle by one frame.
 *
 * @param bgDelta  mean |luma delta| of the lane against the calibrated EMPTY
 *                 background. Meaningless while calibrating (pass 0).
 * @param motion   mean |luma delta| against the previous frame.
 * @param armed    false while stopped/paused: sampling continues so buffers
 *                 stay warm, but no window accrues and nothing fires — a pause
 *                 must never bank up a stale transition.
 */
export function stepGate(
  s: GateState,
  nowMs: number,
  bgDelta: number,
  motion: number,
  armed: boolean,
): GateAction {
  'worklet';
  if (!armed) {
    s.calStart = 0;
    s.presenceStart = 0;
    s.adaptStart = 0;
    s.clearStart = 0;
    s.lockStillStart = 0;
    // A garment confirmed 'present' before a pause must NOT keep its force
    // deadline across the pause — re-arming would fire instantly on a stale,
    // possibly swapped scene. Demote to waiting; presence re-proves itself.
    // LOCKED deliberately survives a pause: the counted garment may well
    // still be sitting there, and forgetting that would double-count it.
    if (s.phase === 'present') {
      s.phase = 'waiting';
      s.presentSince = 0;
    }
    return 'none';
  }

  if (s.phase === 'calibrating') {
    // Learn the empty lane: require CAL_STABLE_MS of stillness, then adopt
    // that scene as the background. A garment (or hand) moving through resets
    // the window — calibration cannot complete over a moving scene.
    if (motion <= STABLE_MOTION) {
      if (s.calStart === 0) s.calStart = nowMs;
      if (nowMs - s.calStart >= CAL_STABLE_MS) {
        s.phase = 'waiting';
        s.calStart = 0;
        return 'setBackground';
      }
    } else {
      s.calStart = 0;
    }
    return 'none';
  }

  if (s.phase === 'waiting') {
    if (bgDelta >= PRESENT_MIN) {
      // Something is in the lane. Credible only when SUSTAINED — one frame of
      // hand shadow or exposure pulse must not become a garment.
      s.adaptStart = 0;
      if (s.presenceStart === 0) s.presenceStart = nowMs;
      if (nowMs - s.presenceStart >= CANDIDATE_MS) {
        s.phase = 'present';
        s.presentSince = nowMs;
        s.presenceStart = 0;
      }
      return 'none';
    }
    s.presenceStart = 0;
    // Quiet lane: slowly re-adopt the background so drift (exposure, light)
    // never accumulates into a phantom presence. The band is DELIBERATELY
    // tight (<= CLEAR_MAX): a first fix widened it to < PRESENT_MIN to absorb
    // permanent 9..17 shifts, and adversarial review proved that adopts a
    // sub-threshold garment that pauses or creeps (sim: background walked
    // 0->12->26->39 under a slow glide; a poisoned background then wedged
    // LOCKED and counted 1 of 10 real garments). The 9..17 shift case is
    // handled at the LOCK instead — see CLEAR_RELAXED_MAX.
    if (bgDelta <= CLEAR_MAX && motion <= STABLE_MOTION) {
      if (s.adaptStart === 0) s.adaptStart = nowMs;
      if (nowMs - s.adaptStart >= ADAPT_MS) {
        s.adaptStart = 0;
        return 'setBackground';
      }
    } else {
      s.adaptStart = 0;
    }
    return 'none';
  }

  if (s.phase === 'present') {
    if (bgDelta <= CLEAR_MAX) {
      // Whatever arrived left again before it could be photographed — a hand,
      // a garment snatched straight back. Not a traversal; no count.
      s.phase = 'waiting';
      s.presentSince = 0;
      return 'none';
    }
    // Photograph at the first sharp lull, or at the deadline. The refractory
    // is a floor UNDER the lifecycle, never the identity mechanism.
    const lull = motion <= SHARP_ENOUGH;
    const forced = nowMs - s.presentSince >= FORCE_AFTER_MS;
    if ((lull || forced) && nowMs - s.lastFiredAt >= REFRACTORY_MS) {
      s.phase = 'locked';
      s.lastFiredAt = nowMs;
      s.presentSince = 0;
      s.clearStart = 0;
      return 'fire';
    }
    return 'none';
  }

  // LOCKED. The counted garment owns the lane. The ONLY exit is the lane
  // sustainedly returning towards the empty background — appearance changes of
  // the garment itself (folds, movement, shadow, exposure) keep bgDelta high
  // and therefore keep the lock. This branch is the fix for the reported
  // "same shirt counts over and over" bug.
  if (bgDelta <= CLEAR_RELAXED_MAX) {
    if (s.clearStart === 0) s.clearStart = nowMs;
    if (nowMs - s.clearStart >= CLEAR_MS) {
      s.phase = 'waiting';
      s.clearStart = 0;
      s.lockStillStart = 0;
      // Whatever the lane looks like now IS the new empty — re-baselining
      // here absorbs both a box emptying shirt by shirt AND a background
      // that stepped by up to CLEAR_RELAXED_MAX during the traversal.
      return 'clearLane';
    }
  } else {
    s.clearStart = 0;
  }
  // THE RECOVERY EXIT (see LOCKED_REBASE_MS). A lane dead-still for 2.5s is
  // not a garment mid-traversal: adopt it as the new background and stand
  // ready. This is what un-wedges a lock whose old background became
  // unreachable (calibrated over a garment; permanent light/exposure shift;
  // a visible box changing as it empties). Cost when it IS a parked garment:
  // one phantom unread on its departure — bounded and visible, never a
  // silent stall.
  if (motion <= STABLE_MOTION) {
    if (s.lockStillStart === 0) s.lockStillStart = nowMs;
    if (nowMs - s.lockStillStart >= LOCKED_REBASE_MS) {
      s.phase = 'waiting';
      s.lockStillStart = 0;
      s.clearStart = 0;
      return 'clearLane';
    }
  } else {
    s.lockStillStart = 0;
  }
  return 'none';
}
