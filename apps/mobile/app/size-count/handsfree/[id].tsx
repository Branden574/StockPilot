import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as ImageManipulator from 'expo-image-manipulator';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Camera,
  usePhotoOutput,
  useCameraDevice,
  useCameraPermission,
} from 'react-native-vision-camera';

import { API_BASE } from '@/lib/api';
import { enqueue, newIdempotencyKey } from '@/lib/queue';
import { ROI, useSizeScanGate, type GateDebug } from '@/lib/size-scan-gate';
import { postMultipart } from '@/lib/multipart-upload';
import { supabase } from '@/lib/supabase';
import { syncNow } from '@/lib/sync';
import { TYPE_CEILING, capTo, radius, space, theme } from '@/lib/theme';

/**
 * HANDS-FREE SIZE COUNT — prop the phone up, slide garments past, tap nothing.
 *
 * ═══ THE INVARIANT THIS SCREEN EXISTS TO KEEP ═══
 *
 *      ONE PHYSICAL GARMENT PASS  =  AT MOST ONE COUNT
 *
 * Three layers enforce it, and each covers a different failure:
 *
 *   1. THE GATE (size-scan-gate-core): a garment lifecycle state machine.
 *      A counted garment LOCKS the lane until the lane sustainedly returns
 *      to the calibrated empty background — so a shirt that moves, folds or
 *      sits for ten seconds fires exactly once. The first floor run proved a
 *      scene-change threshold cannot do this (23 "passes" for ~10 shirts).
 *   2. THE READER CONTRACT (mode=handsfree): the server returns AT MOST ONE
 *      garment reading per photo — never a multi-sticker tally. The first
 *      floor run also proved the overview contract leaks here: 7 reads
 *      produced 9 tally units because frames caught neighbouring stickers.
 *   3. THE LEDGER (captureId): every accepted pass gets a unique id and its
 *      AI response is applied exactly once, however the network retries or
 *      re-orders. Reads stay concurrent — a read takes ~4s and garments
 *      arrive ~1/s, so blocking on the response would make this unusable.
 *
 * ═══ WHY THE COUNTER SHOWS THREE NUMBERS ═══
 *
 *      passed        accepted garment traversals (the state machine's count)
 *      read          traversals that produced exactly one size
 *      unread        traversals that did not — sticker down, blurred,
 *                    ambiguous frame, network failure, backpressure
 *
 * passed = read + unread + still-reading, always. You know the box holds
 * fifty; "50 passed · 47 read" says re-pass three. A run that just says 47
 * tells you nothing, and looks confident doing it.
 */

const COMPRESS_MAX_DIMENSION = 1600;
const COMPRESS_QUALITY = 0.8;

/** Reads allowed in flight at once. The server permits 90/min; this bounds
 *  memory and keeps a stall from queueing an unbounded pile of photos. */
const MAX_IN_FLIGHT = 8;

/** Recent passes kept for the operator's LAST-READS strip and Undo. */
const RECENT_LIMIT = 6;

type Tally = Record<string, number>;

type PassStatus = 'reading' | 'read' | 'unread';
type PassEntry = { captureId: string; status: PassStatus; size: string | null; note: string | null };

/** Local id for one physical garment pass. Dedup key for applying the AI
 *  response exactly once — not a secret, not sent to the server. */
function newCaptureId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** What the hands-free endpoint answers with — see parseHandsfreeScanResponse
 *  on the web side. `target` is AT MOST ONE garment, by contract. */
type HandsfreeScanBody = {
  target: { size: string; rawText: string; confidence: number } | null;
  ambiguity: 'none_visible' | 'multiple_stickers' | null;
  outsideScale: boolean;
  modelVersion: string | null;
};

/**
 * Project the gate's sampled ROI (a centred fraction of the BUFFER) onto the
 * view under cover-crop semantics. The stream is VGA_16_9, displayed portrait,
 * so the buffer effectively has a 9:16 aspect; cover scales it until both view
 * axes are filled, cropping the overflow — and whatever fraction of the buffer
 * remains visible, the ROI must be drawn relative to the BUFFER, not the view.
 */
function laneRectForCover(viewW: number, viewH: number): { width: number; height: number } {
  if (viewW <= 0 || viewH <= 0) return { width: 0, height: 0 };
  const bufW = 9;
  const bufH = 16;
  const scale = Math.max(viewW / bufW, viewH / bufH);
  const visibleFracW = Math.min(1, viewW / (bufW * scale));
  const visibleFracH = Math.min(1, viewH / (bufH * scale));
  return {
    width: Math.min(viewW, (ROI / visibleFracW) * viewW),
    height: Math.min(viewH, (ROI / visibleFracH) * viewH),
  };
}

/** The operator status line for each lifecycle phase. The phase names come
 *  from the gate core; these are the words a person on the floor needs. */
const PHASE_LINE: Record<GateDebug['phase'], string> = {
  calibrating: 'Clear the counting area — calibrating…',
  waiting: 'Ready — slide the next garment in',
  present: 'Hold it steady…',
  locked: 'Counted — slide it out',
};

export default function HandsFreeSizeCountScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');
  // v5 captures through the OUTPUT, not through a ref on the view — outputs are
  // first-class objects handed to <Camera outputs={[...]}/>, which is also what
  // lets the gate's frame output be attached and detached independently.
  const photoOutput = usePhotoOutput();
  const { width: winW, height: winH } = useWindowDimensions();

  /**
   * The SESSION phase — three UI states, not a boolean. Review confirmed the
   * boolean version rendered an ENABLED Start button through the whole settle
   * window (stop() flipped it before the wait began): tapping it resumed
   * counting while the settle loop still polled, and the loop then committed
   * and closed the screen under an actively counting operator.
   *   counting  gate armed, frame output attached, Stop visible
   *   settling  gate disarmed, waiting for in-flight reads; ONE disabled
   *             button that says so
   *   idle      Start visible
   */
  const [phase, setPhase] = React.useState<'idle' | 'counting' | 'settling'>('idle');
  const [passed, setPassed] = React.useState(0);
  const [readCount, setReadCount] = React.useState(0);
  const [unread, setUnread] = React.useState(0);
  const passedRef = React.useRef(0);
  const readRef = React.useRef(0);
  const unreadRef = React.useRef(0);
  React.useEffect(() => {
    passedRef.current = passed;
    readRef.current = readCount;
    unreadRef.current = unread;
  }, [passed, readCount, unread]);
  const [inFlight, setInFlight] = React.useState(0);
  const [tally, setTally] = React.useState<Tally>({});
  const [recent, setRecent] = React.useState<PassEntry[]>([]);
  const [debug, setDebug] = React.useState<GateDebug | null>(null);
  const [showHud, setShowHud] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  // Read through refs inside the capture path: it is driven from a worklet
  // dispatch, not a render, so it must not close over stale state.
  const runningRef = React.useRef(false);
  const inFlightRef = React.useRef(0);
  // Mirrors read by the settle/commit path, which runs across awaits and must
  // not act on a stale closure snapshot of state.
  const tallyRef = React.useRef<Tally>({});
  const recentRef = React.useRef<PassEntry[]>([]);
  React.useEffect(() => {
    tallyRef.current = tally;
  }, [tally]);
  React.useEffect(() => {
    recentRef.current = recent;
  }, [recent]);
  /** Which model read this session's garments — recorded on the committed
   *  events so an audit can tell which model produced a given count. Constant
   *  per deploy, so first-read capture is enough. */
  const modelVersionRef = React.useRef<string | null>(null);
  const [settling, setSettling] = React.useState(0);
  /** captureIds whose outcome has been APPLIED. The apply-once ledger: a
   *  duplicate or replayed response for the same physical pass is a no-op. */
  const appliedRef = React.useRef<Set<string>>(new Set());
  /** The SETTLED outcome per captureId, written synchronously in applyOutcome
   *  — the truth Undo reads. Review caught the race: `recent` (React state)
   *  lags a just-applied outcome by one render, so an Undo tapped in that gap
   *  classified a settled read as 'reading' and left its tally increment
   *  behind while decrementing `passed`. */
  const outcomesRef = React.useRef<Map<string, { status: 'read' | 'unread'; size: string | null }>>(
    new Map(),
  );
  /** captureIds currently in flight — so a settle timeout can mark exactly
   *  the hung ones unread (recent is capped and may have evicted them). */
  const inFlightIdsRef = React.useRef<Set<string>>(new Set());
  /** Consecutive nothing-visible reads. Three in a row is the signature of
   *  the ADOPTION CASCADE (see the gate core header): a garment became the
   *  background and every fire now photographs an empty lane. The breaker
   *  recalibrates, which re-learns the true empty lane at the next gap. For
   *  honest sticker-down streaks the recalibration is harmless — it completes
   *  in the empty gap between garments. */
  const noneStreakRef = React.useRef(0);
  /** The gate's reset, reached through a ref: applyOutcome (the breaker) must
   *  be declared BEFORE the gate hook that produces resetGate, because the
   *  hook consumes onGarment which consumes applyOutcome. */
  const resetGateRef = React.useRef<() => void>(() => {});
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const pushRecent = React.useCallback((entry: PassEntry) => {
    setRecent((r) => [entry, ...r].slice(0, RECENT_LIMIT));
  }, []);
  const settleRecent = React.useCallback(
    (captureId: string, status: PassStatus, size: string | null, note: string | null) => {
      setRecent((r) => r.map((e) => (e.captureId === captureId ? { ...e, status, size, note } : e)));
    },
    [],
  );

  /**
   * Apply ONE outcome for ONE physical pass, exactly once. Every path a
   * response can arrive by — success, failure, retry, out-of-order — funnels
   * through here, and the ledger makes a second arrival a no-op. `read` and
   * `unread` can therefore never drift from `passed`.
   */
  const applyOutcome = React.useCallback(
    (captureId: string, outcome: { size: string | null; note: string | null }) => {
      if (appliedRef.current.has(captureId)) return;
      appliedRef.current.add(captureId);
      // The synchronous ledger first — Undo consults THIS, never the lagging
      // render state.
      outcomesRef.current.set(captureId, {
        status: outcome.size != null ? 'read' : 'unread',
        size: outcome.size,
      });
      // THE CASCADE BREAKER. Three consecutive photos with nothing visible
      // means the gate is firing on an empty lane (a garment got adopted as
      // background); recalibrate so the machine re-learns the real empty.
      if (outcome.size == null && outcome.note === 'no sticker readable') {
        noneStreakRef.current += 1;
        if (noneStreakRef.current >= 3 && runningRef.current) {
          noneStreakRef.current = 0;
          resetGateRef.current();
        }
      } else {
        noneStreakRef.current = 0;
      }
      if (!mountedRef.current) return; // late response after close: ledger only
      if (outcome.size != null) {
        const size = outcome.size;
        setReadCount((n) => n + 1);
        // EXACTLY ONE unit. Never a count from the response — one physical
        // pass moves the tally by at most one, whatever a frame contained.
        setTally((t) => ({ ...t, [size]: (t[size] ?? 0) + 1 }));
        settleRecent(captureId, 'read', size, null);
      } else {
        setUnread((n) => n + 1);
        settleRecent(captureId, 'unread', null, outcome.note);
      }
    },
    [settleRecent],
  );

  // ONE INDIRECTION, ON PURPOSE. `onGarment` must keep a STABLE identity for
  // the life of the screen: useFrameOutput reinstalls in an effect keyed on
  // it, and reinstalling re-serializes the worklet closure — which wipes the
  // gate's lifecycle state and background. But the capture depends on state
  // that changes, so the stable callback calls through a ref.
  const captureRef = React.useRef<(captureId: string) => Promise<void>>(async () => {});
  const onGarment = React.useCallback(() => {
    if (!runningRef.current) return;
    const captureId = newCaptureId();
    // `passed` increments HERE and only here: one accepted traversal from the
    // state machine. The lock in the gate is what makes this truthful.
    setPassed((n) => n + 1);
    if (inFlightRef.current >= MAX_IN_FLIGHT) {
      // Backpressure: the reader is too far behind to photograph this one.
      // The garment still PASSED — it lands in unread rather than vanishing,
      // and the gate's lock still prevents it counting twice.
      pushRecent({ captureId, status: 'reading', size: null, note: null });
      applyOutcome(captureId, { size: null, note: 'reader busy' });
      return;
    }
    pushRecent({ captureId, status: 'reading', size: null, note: null });
    void captureRef.current(captureId);
  }, [applyOutcome, pushRecent]);

  const { frameOutput, setArmed, resetGate } = useSizeScanGate({
    onGarment,
    // Always on: the status line needs the phase. The dispatch is throttled
    // inside the worklet, so this costs a few messages per second.
    onDebug: setDebug,
  });
  React.useEffect(() => {
    resetGateRef.current = resetGate;
  }, [resetGate]);

  const captureAndRead = React.useCallback(
    async (captureId: string) => {
      inFlightRef.current += 1;
      inFlightIdsRef.current.add(captureId);
      if (mountedRef.current) setInFlight(inFlightRef.current);
      try {
        // capturePhotoToFile, not the in-memory capturePhoto: the bytes go
        // straight to a multipart upload, so a file path is what both this and
        // ImageManipulator want, and nothing has to hold a decoded image.
        const photo = await photoOutput.capturePhotoToFile({ flashMode: 'off' }, {});
        if (!photo?.filePath) throw new Error('no photo');
        // NOTE deliberately ABSENT here: no setArmed(true). The old re-arm
        // dance was part of the double-count bug — identity now lives in the
        // gate's LOCKED phase, and `armed` is purely the run/stop switch.
        const compressed = await ImageManipulator.manipulateAsync(
          `file://${photo.filePath}`,
          [{ resize: { width: COMPRESS_MAX_DIMENSION } }],
          { compress: COMPRESS_QUALITY, format: ImageManipulator.SaveFormat.JPEG },
        );
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) throw new Error('Not signed in.');

        const res = await postMultipart(`${API_BASE}/api/v1/size-counts/${id}/scan`, {
          files: [
            { field: 'image', uri: compressed.uri, fileName: 'scan.jpg', contentType: 'image/jpeg' },
          ],
          // The single-target contract. The server composes the measured
          // prompt with the hands-free addendum and enforces ≤1 reading.
          fields: [{ name: 'mode', value: 'handsfree' }],
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (!res.ok) throw new Error(`scan ${res.status}`);
        const body = (await res.json()) as HandsfreeScanBody;

        if (body.modelVersion) modelVersionRef.current = body.modelVersion;
        if (body.target != null && !body.outsideScale) {
          applyOutcome(captureId, { size: body.target.size, note: null });
        } else {
          const note =
            body.ambiguity === 'multiple_stickers'
              ? 'more than one sticker in frame'
              : body.outsideScale
                ? `read ${body.target?.size ?? '?'} — outside this count's sizes`
                : 'no sticker readable';
          applyOutcome(captureId, { size: null, note });
        }
      } catch {
        // A failed read is an UNREAD garment, never a dropped one. The gate
        // saw it pass; losing that fact is how a count silently comes up
        // short. The ledger keeps a retried/raced failure from applying twice.
        applyOutcome(captureId, { size: null, note: 'read failed' });
      } finally {
        inFlightRef.current -= 1;
        inFlightIdsRef.current.delete(captureId);
        if (mountedRef.current) setInFlight(inFlightRef.current);
      }
    },
    [applyOutcome, id, photoOutput],
  );

  React.useEffect(() => {
    captureRef.current = captureAndRead;
  }, [captureAndRead]);

  const start = React.useCallback(() => {
    // Fresh calibration EVERY start: no stale lock, no stale background. The
    // status line asks for a clear lane while it runs (~a second).
    resetGate();
    runningRef.current = true;
    setPhase('counting');
    setArmed(true);
  }, [resetGate, setArmed]);

  const stop = React.useCallback(() => {
    runningRef.current = false;
    setPhase('idle');
    setArmed(false);
  }, [setArmed]);

  /** Disarm WITHOUT going idle — the settle window. The gate stops firing but
   *  the UI stays in a single disabled state until the reads land. */
  const beginSettling = React.useCallback(() => {
    runningRef.current = false;
    setPhase('settling');
    setArmed(false);
  }, [setArmed]);

  const total = React.useMemo(
    () => Object.values(tally).reduce((a, b) => a + b, 0),
    [tally],
  );

  /** Undo the NEWEST pass — the safety net for the moment an operator sees a
   *  double-fire happen. Review confirmed the first version undid the newest
   *  SETTLED pass instead: at 1 garment/s with ~4s reads the last few entries
   *  are always still 'reading', so Undo removed an older, legitimate garment
   *  while the duplicate landed anyway seconds later. Now the newest entry is
   *  undone whatever its status — for a 'reading' entry, its captureId is
   *  pre-marked applied so the in-flight response becomes a no-op. */
  const undoLast = React.useCallback(() => {
    const entry = recentRef.current[0];
    if (!entry) return;
    // Guard a fast double-tap racing the state update: consume through
    // appliedRef, which is synchronous.
    const undoneKey = `undone:${entry.captureId}`;
    if (appliedRef.current.has(undoneKey)) return;
    appliedRef.current.add(undoneKey);
    // STATUS FROM THE SYNCHRONOUS LEDGER, never the render state — review
    // caught an Undo tapped in the one-render gap after a response applied:
    // the entry still SHOWED 'reading', so the old code decremented only
    // `passed` and left the just-applied tally increment behind.
    const settled = outcomesRef.current.get(entry.captureId);
    if (settled == null) {
      // Genuinely still in flight: pre-mark applied so the pending response
      // becomes a no-op. Neither read nor unread was ever incremented.
      appliedRef.current.add(entry.captureId);
    }
    setRecent((r) => r.filter((e) => e.captureId !== entry.captureId));
    setPassed((n) => Math.max(0, n - 1));
    if (settled?.status === 'read' && settled.size) {
      const size = settled.size;
      setReadCount((n) => Math.max(0, n - 1));
      setTally((t) => {
        const next = { ...t, [size]: Math.max(0, (t[size] ?? 0) - 1) };
        if (next[size] === 0) delete next[size];
        return next;
      });
    } else if (settled?.status === 'unread') {
      setUnread((n) => Math.max(0, n - 1));
    }
  }, []);

  const commitAgainRef = React.useRef<() => void>(() => {});
  const commit = React.useCallback(async () => {
    // Through the REF, not the closure: commit is reached after awaits (the
    // settle wait, the alert) and must act on the tally as it stands.
    const entries = Object.entries(tallyRef.current).filter(([, n]) => n > 0);
    if (entries.length === 0) {
      stop();
      router.back();
      return;
    }
    setSaving(true);
    try {
      // ONE outbox row for the WHOLE commit — atomic by construction. Review
      // proved every per-size-loop variant loses: a partial enqueue failure
      // followed by a retry either double-counts (fresh keys) or silently
      // drops a grown/edited quantity (stable keys + the server's
      // ignoreDuplicates upsert). A single row cannot partially fail, its
      // sync replay carries identical per-event keys, and the server dedupes
      // each event. 'rapid_pass_gate' is the 0283 enum value minted for
      // exactly this mechanism, so audits can tell these rows from
      // overview-photo counts.
      const countedAt = new Date().toISOString();
      await enqueue('size_count_event', {
        sessionId: id,
        events: entries.map(([size, quantity]) => ({
          idempotencyKey: newIdempotencyKey(),
          size,
          quantityDelta: quantity,
          recognitionMethod: 'rapid_pass_gate',
          modelVersion: modelVersionRef.current,
          countedAt,
        })),
      });
      void syncNow();
      stop();
      router.back();
    } catch (e) {
      setSaving(false);
      stop();
      Alert.alert('Could not add these', e instanceof Error ? e.message : 'Try again.', [
        { text: 'Not now' },
        { text: 'Try again', onPress: () => commitAgainRef.current() },
      ]);
    }
  }, [id, router, stop]);

  React.useEffect(() => {
    commitAgainRef.current = () => void commit();
  }, [commit]);

  /** After settling, show the unread alert or commit — always on FINAL
   *  numbers read through refs. */
  const finishRun = React.useCallback(() => {
    const finalTotal = Object.values(tallyRef.current).reduce((a, b) => a + b, 0);
    if (unreadRef.current > 0) {
      Alert.alert(
        `${unreadRef.current} garment${unreadRef.current === 1 ? '' : 's'} not read`,
        `${passedRef.current} went past and ${readRef.current} produced a size. Re-pass the ${unreadRef.current} the camera could not read, or add the ${finalTotal} it did read and tap the rest in by hand.`,
        [
          { text: 'Keep going', onPress: start },
          { text: `Add ${finalTotal}`, onPress: () => void commit() },
        ],
      );
      return;
    }
    void commit();
  }, [commit, start]);

  const settleAgainRef = React.useRef<() => void>(() => {});
  const settleThenFinish = React.useCallback(async (): Promise<void> => {
    // WAIT FOR THE READS. Reads take ~4s and garments arrive ~1/s, so at the
    // moment the operator stops there are almost always captures in flight —
    // review confirmed the first version committed before they landed,
    // silently dropping every late read (50 passed / 47 committed, nothing on
    // screen saying so). The session phase is 'settling' throughout: the gate
    // is disarmed and the only button is disabled, so Start cannot race this
    // loop (the second confirmed failure of the boolean version).
    const deadline = Date.now() + 30_000;
    while (inFlightRef.current > 0 && Date.now() < deadline) {
      if (mountedRef.current) setSettling(inFlightRef.current);
      await new Promise((r) => setTimeout(r, 150));
    }
    if (mountedRef.current) setSettling(0);
    if (inFlightRef.current > 0) {
      // The cap breached with reads still hung. NEVER silently commit without
      // them — that is the exact short-count this wait exists to prevent.
      const hung = inFlightRef.current;
      Alert.alert(
        `${hung} read${hung === 1 ? '' : 's'} still finishing`,
        'The network is slow. Keep waiting, or mark them unread and re-pass those garments.',
        [
          { text: 'Keep waiting', onPress: () => settleAgainRef.current() },
          {
            text: `Mark ${hung} unread`,
            onPress: () => {
              // Exactly the hung captures — recent may have evicted them, so
              // the id set is the source. applyOutcome's ledger makes the
              // late real response a no-op.
              for (const cid of Array.from(inFlightIdsRef.current)) {
                applyOutcome(cid, { size: null, note: 'timed out' });
              }
              finishRun();
            },
          },
        ],
      );
      return;
    }
    finishRun();
  }, [applyOutcome, finishRun]);

  React.useEffect(() => {
    settleAgainRef.current = () => void settleThenFinish();
  }, [settleThenFinish]);

  const onStopPressed = React.useCallback(() => {
    beginSettling();
    void settleThenFinish();
  }, [beginSettling, settleThenFinish]);

  // ─── render branches ────────────────────────────────────────────────────

  if (!hasPermission) {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.center}>
          <Text style={styles.permTitle}>Camera access needed</Text>
          <Text style={styles.permBody}>
            Hands-free counting uses the camera to read size stickers as garments pass.
          </Text>
          <Pressable style={styles.cta} onPress={() => void requestPermission()}>
            <Text style={styles.ctaLabel}>Continue</Text>
          </Pressable>
          <Pressable style={styles.linkBtn} onPress={() => void Linking.openSettings()}>
            <Text style={styles.linkLabel}>Open Settings</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (device == null) {
    // The simulator has no camera. Say so plainly instead of rendering a black
    // rectangle that looks like a hang.
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.center}>
          <Text style={styles.permTitle}>No camera on this device</Text>
          <Text style={styles.permBody}>
            Hands-free counting needs a real camera. Use the tap counter, or the single-photo
            scan, instead.
          </Text>
          <Pressable style={styles.cta} onPress={() => router.back()}>
            <Text style={styles.ctaLabel}>Go back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const statusLine =
    phase === 'counting'
      ? PHASE_LINE[debug?.phase ?? 'calibrating']
      : phase === 'settling'
        ? 'Finishing the last reads…'
        : 'Prop the phone over the table';
  // Any pass is undoable — review caught the settled-only version greying the
  // button out during the exact all-still-reading window (a double-fire in
  // the first seconds of a run) that Undo exists for.
  const canUndo = recent.length > 0;
  const laneRect = laneRectForCover(winW, winH);

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ headerShown: false }} />
      <Camera
        style={StyleSheet.absoluteFill}
        device={device}
        isActive
        // The gate's frame output is attached ONLY while running. Detaching it
        // when stopped means no luma sampling, no dispatches and no battery
        // spend while the review alert is up.
        outputs={phase === 'counting' ? [photoOutput, frameOutput] : [photoOutput]}
      />
      {/* THE COUNTING LANE — the centred region the gate actually samples,
          projected onto the PREVIEW. The camera is absoluteFill, so the
          cover-crop happens against the WINDOW: review caught the first
          version measuring against the leftover flex space between chrome,
          where the math degenerates to the naive 60% box (and is centred on
          the wrong thing). On a 19.5:9 phone over the 16:9 stream the real
          sampled band is ~73% of visible width — hands resting between the
          drawn edge and the real band fired phantom passes. First-order
          correct; verify against the HUD in the on-device pass. */}
      {phase === 'counting' ? (
        <View style={styles.laneOverlay} pointerEvents="none">
          <View style={[styles.lane, laneRect]} />
        </View>
      ) : null}
      <SafeAreaView style={StyleSheet.absoluteFill} edges={['top', 'bottom']} pointerEvents="box-none">
        <View style={styles.topBar} pointerEvents="auto">
          <Pressable style={styles.closeBtn} onPress={() => { stop(); router.back(); }}>
            <Text style={styles.closeText} numberOfLines={1} maxFontSizeMultiplier={CHROME_CAP}>
              Cancel
            </Text>
          </Pressable>
          <View style={styles.titleCol}>
            <Text style={styles.headerLabel} maxFontSizeMultiplier={CHROME_CAP}>
              Hands-free
            </Text>
            {/* THE LIFECYCLE, IN OPERATOR WORDS. "Counted — slide it out" is
                what makes the lock legible: the phone tells you when a garment
                has been accepted and what it is waiting for next. */}
            <Text style={styles.headerSub}>{statusLine}</Text>
          </View>
          <Pressable onPress={() => setShowHud((v) => !v)} hitSlop={10} style={styles.hudToggle}>
            <Text style={styles.hudToggleLabel}>{showHud ? 'Hide' : 'Tune'}</Text>
          </Pressable>
        </View>

        {/* passed = read + unread + still-reading, always. */}
        <View style={styles.counters} pointerEvents="none">
          <Counter n={passed} label="passed" />
          <Counter n={readCount} label="read" />
          <Counter n={unread} label="unread" warn={unread > 0} />
        </View>

        {showHud ? (
          <View style={styles.hud} pointerEvents="none">
            <Text style={styles.hudText}>
              {debug?.phase ?? '—'} · lane {debug ? debug.bgDelta.toFixed(1) : '—'} (present ≥18 ·
              lock clears ≤12) · motion {debug ? debug.motion.toFixed(1) : '—'} ·{' '}
              {debug?.armed ? 'armed' : 'held'} · {inFlight} reading
            </Text>
          </View>
        ) : null}

        <View style={{ flex: 1 }} pointerEvents="none" />

        {/* Recent passes, newest first: #n size / unread. The floor-glance
            answer to "did that one just count?" */}
        {recent.length > 0 ? (
          <View style={styles.recentRow} pointerEvents="auto">
            <ScrollView horizontal contentContainerStyle={styles.recentStrip}>
              {recent.map((e, i) => (
                <View key={e.captureId} style={[styles.recentChip, e.status === 'unread' && styles.recentChipWarn]}>
                  <Text style={styles.recentText}>
                    #{passed - i} {e.status === 'reading' ? '…' : e.status === 'read' ? e.size : 'unread'}
                  </Text>
                </View>
              ))}
            </ScrollView>
            <Pressable
              onPress={undoLast}
              disabled={!canUndo}
              style={[styles.undoBtn, !canUndo && styles.undoBtnDisabled]}
            >
              <Text style={styles.undoLabel}>Undo</Text>
            </Pressable>
          </View>
        ) : null}

        <ScrollView horizontal style={styles.tallyStrip} contentContainerStyle={styles.tallyRow}>
          {Object.entries(tally).map(([size, n]) => (
            <View key={size} style={styles.chip}>
              <Text style={styles.chipSize}>{size}</Text>
              <Text style={styles.chipCount}>{n}</Text>
            </View>
          ))}
        </ScrollView>

        <View style={styles.bottomBar} pointerEvents="auto">
          {phase === 'counting' ? (
            <Pressable style={[styles.bigBtn, styles.stopBtn]} onPress={onStopPressed}>
              <Text style={styles.bigBtnLabel}>Stop · add {total}</Text>
            </Pressable>
          ) : phase === 'settling' ? (
            <Pressable style={[styles.bigBtn, styles.stopBtn]} disabled>
              {saving ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.bigBtnLabel}>
                  Finishing {settling > 0 ? settling : 'the last'} read{settling === 1 ? '' : 's'}…
                </Text>
              )}
            </Pressable>
          ) : (
            <Pressable style={[styles.bigBtn, styles.startBtn]} onPress={start} disabled={saving}>
              <Text style={styles.bigBtnLabel}>Start counting</Text>
            </Pressable>
          )}
        </View>
      </SafeAreaView>
    </View>
  );
}

function Counter({ n, label, warn }: { n: number; label: string; warn?: boolean }) {
  return (
    <View style={styles.counter}>
      <Text style={[styles.counterN, warn && styles.counterWarn]}>{n}</Text>
      <Text style={styles.counterLabel}>{label}</Text>
    </View>
  );
}

const CHROME_CAP = capTo(16, TYPE_CEILING.chrome);

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.lg, backgroundColor: theme.bg },
  permTitle: { color: theme.text, fontSize: 18, fontWeight: '700', marginBottom: space.sm },
  permBody: { color: theme.textMuted, fontSize: 14, textAlign: 'center', marginBottom: space.lg },
  cta: { backgroundColor: theme.primary, paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.md },
  ctaLabel: { color: '#fff', fontWeight: '700', fontSize: 15 },
  linkBtn: { marginTop: space.md },
  linkLabel: { color: theme.primary, fontSize: 14 },

  topBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  closeBtn: { paddingVertical: space.xs, paddingRight: space.xs },
  closeText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  titleCol: { flex: 1, minWidth: 120 },
  headerLabel: { color: '#fff', fontSize: 16, fontWeight: '700' },
  headerSub: { color: 'rgba(255,255,255,0.9)', fontSize: 12, marginTop: 1, fontWeight: '600' },
  hudToggle: { paddingHorizontal: space.sm, paddingVertical: space.xs },
  hudToggleLabel: { color: 'rgba(255,255,255,0.8)', fontSize: 12, fontWeight: '600' },

  counters: { flexDirection: 'row', justifyContent: 'center', gap: space.lg, paddingTop: space.lg },
  counter: { alignItems: 'center', minWidth: 76 },
  counterN: { color: '#fff', fontSize: 40, fontWeight: '800' },
  counterWarn: { color: '#ffb020' },
  counterLabel: { color: 'rgba(255,255,255,0.8)', fontSize: 12, marginTop: -4 },

  hud: { marginTop: space.sm, marginHorizontal: space.md, padding: space.sm, borderRadius: radius.sm, backgroundColor: 'rgba(0,0,0,0.6)' },
  hudText: { color: '#8fe', fontSize: 11, fontVariant: ['tabular-nums'] },

  // The lane overlay is centred on the PREVIEW (the full window), because
  // that is what the camera cover-fills and what the gate samples.
  laneOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lane: {
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.55)',
    borderRadius: radius.lg,
    borderStyle: 'dashed',
  },

  recentRow: { flexDirection: 'row', alignItems: 'center', paddingRight: space.md },
  recentStrip: { paddingHorizontal: space.md, gap: space.xs, alignItems: 'center' },
  recentChip: {
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
  },
  recentChipWarn: { backgroundColor: 'rgba(192,57,43,0.75)' },
  recentText: { color: '#fff', fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  undoBtn: {
    marginLeft: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(255,255,255,0.92)',
  },
  undoBtnDisabled: { opacity: 0.4 },
  undoLabel: { color: theme.text, fontSize: 12, fontWeight: '700' },

  tallyStrip: { maxHeight: 68, flexGrow: 0, marginTop: space.sm },
  tallyRow: { paddingHorizontal: space.md, gap: space.sm, alignItems: 'center' },
  chip: {
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    alignItems: 'center',
    minWidth: 56,
  },
  chipSize: { color: theme.text, fontSize: 12, fontWeight: '600' },
  chipCount: { color: theme.text, fontSize: 20, fontWeight: '800' },

  bottomBar: { padding: space.md },
  bigBtn: { borderRadius: radius.md, paddingVertical: space.md, alignItems: 'center', justifyContent: 'center' },
  startBtn: { backgroundColor: theme.primary },
  stopBtn: { backgroundColor: '#c0392b' },
  bigBtnLabel: { color: '#fff', fontWeight: '800', fontSize: 17 },
});
