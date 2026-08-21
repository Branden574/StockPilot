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
import { enqueue } from '@/lib/queue';
import { useSizeScanGate, type GateDebug } from '@/lib/size-scan-gate';
import { postMultipart } from '@/lib/multipart-upload';
import { supabase } from '@/lib/supabase';
import { syncNow } from '@/lib/sync';
import { TYPE_CEILING, capTo, radius, space, theme } from '@/lib/theme';

/**
 * HANDS-FREE SIZE COUNT — prop the phone up, slide garments past, tap nothing.
 *
 * ═══ WHY THIS IS A SEPARATE SCREEN ═══
 *
 * The manual scan screen stays exactly as it is, on expo-camera. This one is
 * the only place react-native-vision-camera is mounted, for three reasons:
 *
 *   1. Two camera libraries must never contend for one AVCaptureSession. Two
 *      screens that cannot be open at once cannot contend.
 *   2. `useCameraDevice()` returns null on the simulator, which has no camera.
 *      Confining that to a screen the smoke suite does not walk keeps the
 *      manual flow's simulator coverage green.
 *   3. If the gate misbehaves on the floor, the manual shutter is still there
 *      and still works. A new mechanism that can be stepped around is one you
 *      can ship before you fully trust it.
 *
 * ═══ THE THING THAT MAKES ONE-PER-SECOND POSSIBLE ═══
 *
 * The gate RE-ARMS THE MOMENT THE PHOTO IS TAKEN — not when its read comes
 * back. A read takes about four seconds; garments arrive about every one. Wait
 * for the read and three garments go past uncounted.
 *
 * So reads run concurrently and land out of order, which is why the tally is
 * assembled from arrivals rather than kept in sequence. Measured against
 * production: 25 captures fired a second apart completed in 24.6s, because the
 * network time hides entirely underneath the operator's hands.
 *
 * ═══ WHY THE COUNTER SHOWS THREE NUMBERS ═══
 *
 *      passed        the gate saw this many garments go by
 *      read          this many produced a size
 *      unread        this many did not
 *
 * `passed` comes from the gate, `read` from the cloud, and keeping them apart
 * is the whole reason this can be trusted. A garment that goes by sticker-down
 * is invisible to the reader but NOT to the gate — so it shows up as unread
 * instead of silently shortening the count. You know the box holds fifty; a
 * run that ends "50 passed · 47 read" tells you to re-pass three. A run that
 * just says 47 tells you nothing, and looks confident doing it.
 */

const COMPRESS_MAX_DIMENSION = 1600;
const COMPRESS_QUALITY = 0.8;

/** Reads allowed in flight at once. The server permits 90/min; this bounds
 *  memory and keeps a stall from queueing an unbounded pile of photos. */
const MAX_IN_FLIGHT = 8;

type Tally = Record<string, number>;

export default function HandsFreeSizeCountScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');
  // v5 captures through the OUTPUT, not through a ref on the view — outputs are
  // first-class objects handed to <Camera outputs={[...]}/>, which is also what
  // lets the gate's frame output be attached and detached independently.
  const photoOutput = usePhotoOutput();

  const [running, setRunning] = React.useState(false);
  const [passed, setPassed] = React.useState(0);
  const [readCount, setReadCount] = React.useState(0);
  const [unread, setUnread] = React.useState(0);
  const [inFlight, setInFlight] = React.useState(0);
  const [tally, setTally] = React.useState<Tally>({});
  const [debug, setDebug] = React.useState<GateDebug | null>(null);
  const [showHud, setShowHud] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  // Read through refs inside the capture path: it is driven from a worklet
  // dispatch, not a render, so it must not close over stale state.
  const runningRef = React.useRef(false);
  const inFlightRef = React.useRef(0);

  // ONE INDIRECTION, ON PURPOSE. `onGarment` must keep a STABLE identity for the
  // life of the screen: useFrameOutput reinstalls in an effect keyed on it, and
  // reinstalling re-serializes the worklet closure — which wipes the gate's
  // reference frame and refractory, and a gate that forgets what it last
  // photographed double-counts. But the capture itself depends on props and
  // state that do change. So the stable callback calls through a ref that an
  // effect keeps pointed at the current capture function.
  const captureRef = React.useRef<() => Promise<void>>(async () => {});
  const onGarment = React.useCallback(() => {
    if (!runningRef.current) return;
    // Backpressure: if the reader is this far behind, the photo would only
    // queue. Skipping the capture is honest — the garment still counts as
    // passed, so it lands in `unread` rather than vanishing.
    if (inFlightRef.current >= MAX_IN_FLIGHT) {
      setPassed((n) => n + 1);
      setUnread((n) => n + 1);
      return;
    }
    setPassed((n) => n + 1);
    void captureRef.current();
  }, []);

  const { frameOutput, setArmed } = useSizeScanGate({
    onGarment,
    onDebug: showHud ? setDebug : undefined,
  });

  const captureAndRead = React.useCallback(async () => {
    inFlightRef.current += 1;
    setInFlight(inFlightRef.current);
    try {
      // capturePhotoToFile, not the in-memory capturePhoto: the bytes are going
      // straight to a multipart upload, so a file path is what both this and
      // ImageManipulator want, and nothing has to hold a decoded image.
      const photo = await photoOutput.capturePhotoToFile({ flashMode: 'off' }, {});
      // RE-ARM HERE, not after the read. The photo is in hand; the four seconds
      // the reader takes belong to the next garment, not this one.
      setArmed(true);

      if (!photo?.filePath) throw new Error('no photo');
      // `filePath` is a filesystem path, NOT a file:// URL — the type doc says
      // so explicitly, and ImageManipulator needs the scheme.
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
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) throw new Error(`scan ${res.status}`);
      const body = (await res.json()) as { counts: { size: string; count: number }[] };

      if (body.counts.length === 0) {
        // A garment went by and no sticker was read. NOT silent: this is the
        // number that tells the operator to re-pass it.
        setUnread((n) => n + 1);
        return;
      }
      setReadCount((n) => n + 1);
      setTally((t) => {
        const next = { ...t };
        for (const c of body.counts) next[c.size] = (next[c.size] ?? 0) + c.count;
        return next;
      });
    } catch {
      // A failed read is an UNREAD garment, never a dropped one. The gate saw it
      // pass; losing that fact is how a count silently comes up short.
      setUnread((n) => n + 1);
      setArmed(true);
    } finally {
      inFlightRef.current -= 1;
      setInFlight(inFlightRef.current);
    }
  }, [id, photoOutput, setArmed]);

  React.useEffect(() => {
    captureRef.current = captureAndRead;
  }, [captureAndRead]);

  const start = React.useCallback(() => {
    runningRef.current = true;
    setRunning(true);
    setArmed(true);
  }, [setArmed]);

  const stop = React.useCallback(() => {
    runningRef.current = false;
    setRunning(false);
    setArmed(false);
  }, [setArmed]);

  const total = React.useMemo(
    () => Object.values(tally).reduce((a, b) => a + b, 0),
    [tally],
  );

  const commit = React.useCallback(async () => {
    stop();
    const entries = Object.entries(tally).filter(([, n]) => n > 0);
    if (entries.length === 0) {
      router.back();
      return;
    }
    setSaving(true);
    try {
      // Through the SAME offline outbox as a tapped count — one event per size
      // carrying its whole quantity, since the ledger's tally is
      // SUM(quantity_delta).
      for (const [size, quantity] of entries) {
        await enqueue('size_count_event', {
          sessionId: id,
          size,
          quantityDelta: quantity,
          recognitionMethod: 'box_overview',
          countedAt: new Date().toISOString(),
        });
      }
      void syncNow();
      router.back();
    } catch (e) {
      setSaving(false);
      Alert.alert('Could not add these', e instanceof Error ? e.message : 'Try again.');
    }
  }, [id, router, stop, tally]);

  const onStopPressed = React.useCallback(() => {
    stop();
    if (unread > 0) {
      Alert.alert(
        `${unread} garment${unread === 1 ? '' : 's'} not read`,
        `${passed} went past and ${readCount} produced a size. Re-pass the ${unread} the camera could not read, or add the ${total} it did read and tap the rest in by hand.`,
        [
          { text: 'Keep going', onPress: start },
          { text: `Add ${total}`, onPress: () => void commit() },
        ],
      );
      return;
    }
    void commit();
  }, [commit, passed, readCount, start, stop, total, unread]);

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
        outputs={running ? [photoOutput, frameOutput] : [photoOutput]}
      />
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
            <Text style={styles.headerSub}>
              {running ? 'Slide garments past — no tapping' : 'Prop the phone over the table'}
            </Text>
          </View>
          <Pressable onPress={() => setShowHud((v) => !v)} hitSlop={10} style={styles.hudToggle}>
            <Text style={styles.hudToggleLabel}>{showHud ? 'Hide' : 'Tune'}</Text>
          </Pressable>
        </View>

        {/* THREE NUMBERS, NOT ONE. `passed` is the gate, `read` is the cloud, and
            the gap between them is the only thing that can tell an operator a
            garment went by unread. */}
        <View style={styles.counters} pointerEvents="none">
          <Counter n={passed} label="passed" />
          <Counter n={readCount} label="read" />
          <Counter n={unread} label="unread" warn={unread > 0} />
        </View>

        {showHud ? (
          <View style={styles.hud} pointerEvents="none">
            <Text style={styles.hudText}>
              scene {debug ? debug.sceneDelta.toFixed(1) : '—'} (fires above 12) · motion{' '}
              {debug ? debug.motion.toFixed(1) : '—'} (sharp below 6) ·{' '}
              {debug?.armed ? 'armed' : 'held'} · {inFlight} reading
            </Text>
          </View>
        ) : null}

        <View style={{ flex: 1 }} pointerEvents="none" />

        <ScrollView horizontal style={styles.tallyStrip} contentContainerStyle={styles.tallyRow}>
          {Object.entries(tally).map(([size, n]) => (
            <View key={size} style={styles.chip}>
              <Text style={styles.chipSize}>{size}</Text>
              <Text style={styles.chipCount}>{n}</Text>
            </View>
          ))}
        </ScrollView>

        <View style={styles.bottomBar} pointerEvents="auto">
          {running ? (
            <Pressable style={[styles.bigBtn, styles.stopBtn]} onPress={onStopPressed} disabled={saving}>
              {saving ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.bigBtnLabel}>Stop · add {total}</Text>
              )}
            </Pressable>
          ) : (
            <Pressable style={[styles.bigBtn, styles.startBtn]} onPress={start}>
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
  headerSub: { color: 'rgba(255,255,255,0.75)', fontSize: 11, marginTop: 1 },
  hudToggle: { paddingHorizontal: space.sm, paddingVertical: space.xs },
  hudToggleLabel: { color: 'rgba(255,255,255,0.8)', fontSize: 12, fontWeight: '600' },

  counters: { flexDirection: 'row', justifyContent: 'center', gap: space.lg, paddingTop: space.lg },
  counter: { alignItems: 'center', minWidth: 76 },
  counterN: { color: '#fff', fontSize: 40, fontWeight: '800' },
  counterWarn: { color: '#ffb020' },
  counterLabel: { color: 'rgba(255,255,255,0.8)', fontSize: 12, marginTop: -4 },

  hud: { marginTop: space.sm, marginHorizontal: space.md, padding: space.sm, borderRadius: radius.sm, backgroundColor: 'rgba(0,0,0,0.6)' },
  hudText: { color: '#8fe', fontSize: 11, fontVariant: ['tabular-nums'] },

  tallyStrip: { maxHeight: 68, flexGrow: 0 },
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
