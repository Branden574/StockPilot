import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { Stack, useRouter } from 'expo-router';
import * as React from 'react';
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, API_BASE } from '@/lib/api';
import { shouldStackRow } from '@/lib/dynamic-type-layout';
/** Apparel letters and US shoe sizes (halves included) resolve through the ONE
 *  shared vocabulary in @stockpilot/core, which the API route and migration
 *  0305's CHECK also derive from — so a label this screen offers can never be
 *  one the server refuses. */
import {
  DEFAULT_TRAINING_LABEL_SET_KEY,
  nextTrainingLabelSetKey,
  resolveTrainingLabelSet,
  type TrainingLabelSetKey,
} from '@/lib/size-count-training-labels';
import { supabase } from '@/lib/supabase';
import { TYPE_CEILING, capTo, radius, space, theme } from '@/lib/theme';

const COMPRESS_MAX = 1280;
const COMPRESS_QUALITY = 0.85;
/** Burst sizes the shutter cycles through. 1 = burst off (single shot).
 *  Bigger bursts let one framing produce many training frames — the tool
 *  button cycles 1 → 5 → 20 → 50 → 1. */
const BURST_STEPS = [1, 5, 20, 50] as const;
/** Above this burst size, yield briefly between frames so the JS thread can
 *  drain the bounded upload queue and repaint the in-flight counter instead of
 *  blocking on a tight 50-iteration capture loop. */
const BURST_YIELD_ABOVE = 5;

/**
 * Opt-in training-data capture with three speed paths:
 *  1. tap a size = one fast shot (upload fires in the background so the shutter
 *     re-arms immediately — tap-tap-tap down a rack);
 *  2. Burst toggle = each tap grabs several frames of that size;
 *  3. Import = multi-select from the camera roll (shoot fast with the native
 *     camera, then label + upload a batch).
 * The size label is the ground truth; "Not a sticker" logs hard negatives.
 */
export default function TrainingCaptureScreen() {
  const router = useRouter();
  // Live scale (re-renders when the user changes Larger Text mid-session); the
  // threshold itself is the shared, unit-tested helper, not a second breakpoint.
  const { fontScale } = useWindowDimensions();
  const stackedBar = shouldStackRow(fontScale);
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = React.useRef<CameraView>(null);
  const [busy, setBusy] = React.useState(false); // capturing (blocks the shutter briefly)
  const [burstCount, setBurstCount] = React.useState<number>(1);
  const [inFlight, setInFlight] = React.useState(0); // uploads still in progress
  const [failed, setFailed] = React.useState(0);
  const [counts, setCounts] = React.useState<Record<string, number>>({});
  // Which vocabulary the size chips offer. Defaults to the FIRST set (Apparel),
  // which is exactly the row this screen showed before shoes existed — an
  // existing capturer sees no change until they choose to switch.
  const [labelSetKey, setLabelSetKey] = React.useState<TrainingLabelSetKey>(
    DEFAULT_TRAINING_LABEL_SET_KEY,
  );
  const labelSet = React.useMemo(() => resolveTrainingLabelSet(labelSetKey), [labelSetKey]);
  // Photos picked from the library, waiting for a size label.
  const [importUris, setImportUris] = React.useState<string[]>([]);

  const total = React.useMemo(
    () => Object.values(counts).reduce((a, b) => a + b, 0),
    [counts],
  );

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api<{ counts: Record<string, number> }>('/api/v1/size-counts/training');
        if (!cancelled && res.counts) setCounts(res.counts);
      } catch {
        /* offline — start from this visit */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Compress + upload one image. Concurrency is bounded by the queue below, so
  // rapid capture doesn't spawn dozens of simultaneous native image ops +
  // re-renders (that overloaded the Fabric renderer and crashed — EXC_BAD_ACCESS
  // in uiManagerDidFinishTransaction).
  const uploadSample = React.useCallback(
    async (uri: string, label: string, isNegative: boolean) => {
      try {
        const compressed = await ImageManipulator.manipulateAsync(
          uri,
          [{ resize: { width: COMPRESS_MAX } }],
          { compress: COMPRESS_QUALITY, format: ImageManipulator.SaveFormat.JPEG },
        );
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) throw new Error('not signed in');
        const form = new FormData();
        form.append('image', {
          uri: compressed.uri,
          name: 'sample.jpg',
          type: 'image/jpeg',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        form.append('sizeLabel', isNegative ? 'NONE' : label);
        if (isNegative) form.append('isNegative', 'true');
        const res = await fetch(`${API_BASE}/api/v1/size-counts/training`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.access_token}` },
          body: form,
        });
        if (!res.ok) throw new Error(String(res.status));
        const key = isNegative ? 'NONE' : label;
        setCounts((c) => ({ ...c, [key]: (c[key] ?? 0) + 1 }));
      } catch {
        setFailed((f) => f + 1);
      }
    },
    [],
  );

  // Bounded upload queue: at most MAX_CONCURRENT uploads run at once. inFlight
  // shows queued + active so the header reflects real remaining work.
  const MAX_CONCURRENT = 2;
  const queueRef = React.useRef<Array<{ uri: string; label: string; neg: boolean }>>([]);
  const activeRef = React.useRef(0);
  // Identity-stable drain ([] deps): everything is read through refs, and the
  // re-entry after each settle goes through runQueueRef instead of the
  // callback's own binding (compiler: accessed-before-declared). This also
  // fixes the stale-closure the old shape had - a .finally captured the drain
  // from ITS render, which used that render's uploadSample; now both always
  // resolve to the latest.
  const uploadSampleRef = React.useRef(uploadSample);
  React.useEffect(() => {
    uploadSampleRef.current = uploadSample;
  });
  const runQueueRef = React.useRef<() => void>(() => {});
  const runQueue = React.useCallback(() => {
    while (activeRef.current < MAX_CONCURRENT && queueRef.current.length > 0) {
      const job = queueRef.current.shift()!;
      activeRef.current += 1;
      void uploadSampleRef.current(job.uri, job.label, job.neg).finally(() => {
        activeRef.current -= 1;
        setInFlight((n) => Math.max(0, n - 1));
        runQueueRef.current();
      });
    }
  }, []);
  React.useEffect(() => {
    runQueueRef.current = runQueue;
  });
  const enqueueUpload = React.useCallback(
    (uri: string, label: string, neg: boolean) => {
      queueRef.current.push({ uri, label, neg });
      setInFlight((n) => n + 1);
      runQueue();
    },
    [runQueue],
  );

  // Take one (or a burst of) fast shots; uploads fire in the background.
  const shoot = React.useCallback(
    async (label: string, isNegative: boolean) => {
      if (busy || !cameraRef.current) return;
      setBusy(true);
      try {
        const n = burstCount;
        for (let i = 0; i < n; i++) {
          const shot = await cameraRef.current.takePictureAsync({
            quality: 0.7,
            skipProcessing: true, // faster shutter; fine for training frames
          });
          if (shot?.uri) enqueueUpload(shot.uri, label, isNegative);
          // Long bursts (20/50): hand the JS thread back between frames so the
          // upload queue drains and the in-flight counter repaints. Skipped for
          // small bursts to keep the 5-shot path as fast as it was.
          if (n > BURST_YIELD_ABOVE && i < n - 1) {
            await new Promise((r) => setTimeout(r, 40));
          }
        }
      } catch {
        setFailed((f) => f + 1);
      } finally {
        setBusy(false);
      }
    },
    [busy, burstCount, enqueueUpload],
  );

  // Import: pick many photos from the library, then label them all at once.
  const pickPhotos = React.useCallback(async () => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      quality: 1,
    });
    if (!res.canceled && res.assets?.length) {
      setImportUris(res.assets.map((a) => a.uri));
    }
  }, []);

  const labelImport = React.useCallback(
    (label: string, isNegative: boolean) => {
      const uris = importUris;
      setImportUris([]);
      for (const uri of uris) enqueueUpload(uri, label, isNegative);
    },
    [importUris, enqueueUpload],
  );

  if (!permission) {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      </SafeAreaView>
    );
  }
  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.center}>
          <Text style={styles.permTitle}>Camera access needed</Text>
          <Text style={styles.permBody}>
            Training capture uses the camera to photograph size stickers.
          </Text>
          <Pressable
            style={styles.primaryBtn}
            onPress={() => (permission.canAskAgain ? requestPermission() : Linking.openSettings())}
          >
            <Text style={styles.primaryLabel}>
              {permission.canAskAgain ? 'Continue' : 'Open Settings'}
            </Text>
          </Pressable>
          <Pressable style={styles.importOnly} onPress={pickPhotos}>
            <Text style={styles.importOnlyText}>Import from photos instead →</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const status =
    `${total} saved` +
    (inFlight > 0 ? ` · ${inFlight} uploading` : '') +
    (failed > 0 ? ` · ${failed} failed` : '');

  // Built once and ARRANGED twice, so the stacked bar cannot drift from the
  // row one: same nodes, same caps, same handlers — only the order changes.
  const doneBtn = (
    <Pressable onPress={() => router.back()} style={styles.closeBtn}>
      <Text style={styles.closeText} numberOfLines={1} maxFontSizeMultiplier={CLOSE_CAP}>
        Done
      </Text>
    </Pressable>
  );
  const reviewBtn = (
    <Pressable onPress={() => router.push('/size-count/review' as never)} style={styles.reviewBtn}>
      <Text style={styles.reviewText} numberOfLines={1} maxFontSizeMultiplier={REVIEW_CAP}>
        Review
      </Text>
    </Pressable>
  );
  const titleCol = (
    <View style={stackedBar ? styles.titleColStacked : styles.titleCol}>
      <Text style={styles.title}>Training capture</Text>
      <Text style={styles.subtitle}>{status}</Text>
    </View>
  );

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ headerShown: false }} />
      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />
      <SafeAreaView style={StyleSheet.absoluteFill} edges={['top', 'bottom']} pointerEvents="box-none">
        {/* Dynamic Type, AX5: the chrome above the controls is now ONE flex
            column that can grow and scroll, not two fixed blocks that collide.
            The viewfinder is full-bleed behind it, so nothing here can push the
            frame down: at AX5 the bar reaches ~290pt and the hint copy ~400pt
            against ~760pt of usable height, and with the controls pinned the
            hint had nowhere to go — it painted straight through both bars.
            Inside the scroll region the layout is unchanged whenever it fits
            (`flexGrow: 1` on the content container keeps the hint centred
            between bar and panel, pixel-identical at every non-accessibility
            size) and it scrolls instead of overlapping when it does not. So NO
            copy is dropped: the secondary hint is one swipe away at AX5 rather
            than hidden, which is the better half of the trade the brief allows.
            The controls panel stays PINNED and never shrinks — tap-to-shoot is
            untouched at every text size. */}
        <ScrollView
          style={styles.chromeScroll}
          contentContainerStyle={styles.chromeContent}
          // No rubber-band. Chrome that jiggles over a live viewfinder reads as
          // broken, and this region must look and behave EXACTLY as it did at
          // every size that already fits. `bounces={false}` suppresses only the
          // overscroll; real scrolling still happens once the content overflows.
          bounces={false}
        >
          {/* THE originally reported bug was the title fracturing into "Train /
              ing / capt / ure", and it is a WIDTH problem: Done and Review
              cannot shrink, so the title column fell to ~93pt while a 16pt
              title reaches 57pt of glyph. Capping the two buttons at the chrome
              ceiling bought it back to AX3; past the shared stack threshold the
              bar becomes a column instead, and the title gets the FULL width —
              369pt of a 393pt screen, less the bar's 12pt padding a side, where
              the longest word ("Training", ~250pt at AX5) fits whole. Buttons
              keep their familiar top-left / top-right corners. */}
          <View style={[styles.topBar, stackedBar && styles.topBarStacked]} pointerEvents="auto">
            {stackedBar ? (
              <>
                <View style={styles.topBarActions}>
                  {doneBtn}
                  {reviewBtn}
                </View>
                {titleCol}
              </>
            ) : (
              <>
                {doneBtn}
                {titleCol}
                {reviewBtn}
              </>
            )}
          </View>

          {/* pointerEvents="none" so the drag belongs to the scroll region
              above it — the hint is copy, never a target. */}
          <View style={styles.hintWrap} pointerEvents="none">
            <Text style={styles.hint}>Frame one sticker, then tap its size</Text>
            {/* The single most confusing thing about this screen: photographing
                stickers TRAINS the detector, it does not tally a count. The owner
                shot 2,171 photos and then found their count session reading zero
                (2026-07-22). Nothing on screen said the two were different, so
                say it here, next to the action itself. */}
            <Text style={styles.hintSub}>
              Photos train the size detector. They do not add to a count.
            </Text>
          </View>
        </ScrollView>

        <View style={styles.panel} pointerEvents="auto">
          {/* Horizontally scrollable, like the size row below it. This row used
              to hold two buttons and fit; the size-set toggle makes three, and
              at large Dynamic Type the third (Import photos) ran off the right
              edge and became completely untappable. Scrolling keeps every tool
              reachable at any text size. */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.toolRow}
          >
            <Pressable
              // Cycles 1 → 5 → 20 → 50 → 1 so one tap-and-frame can produce a
              // whole batch of training frames.
              onPress={() =>
                setBurstCount((c) => {
                  const i = BURST_STEPS.indexOf(c as (typeof BURST_STEPS)[number]);
                  return BURST_STEPS[(i + 1) % BURST_STEPS.length] ?? 1;
                })
              }
              style={[styles.toolBtn, burstCount > 1 && styles.toolBtnOn]}
            >
              <Text style={[styles.toolLabel, burstCount > 1 && styles.toolLabelOn]}>
                {burstCount > 1 ? `Burst ×${burstCount}` : 'Burst off'}
              </Text>
            </Pressable>
            <Pressable
              // Cycles through the label vocabularies (Apparel → Shoes → …),
              // the same tool-button idiom as Burst beside it. Lit whenever the
              // set is not the default, so it is obvious which chips are live.
              onPress={() => setLabelSetKey(nextTrainingLabelSetKey)}
              style={[
                styles.toolBtn,
                labelSetKey !== DEFAULT_TRAINING_LABEL_SET_KEY && styles.toolBtnOn,
              ]}
            >
              <Text
                style={[
                  styles.toolLabel,
                  labelSetKey !== DEFAULT_TRAINING_LABEL_SET_KEY && styles.toolLabelOn,
                ]}
              >
                Sizes: {labelSet.name}
              </Text>
            </Pressable>
            <Pressable onPress={pickPhotos} style={styles.toolBtn}>
              <Text style={styles.toolLabel}>Import photos</Text>
            </Pressable>
          </ScrollView>

          <ScrollView
            // Remounted per set so switching Apparel → Shoes starts the row at
            // the first size instead of stranding the user mid-scroll.
            key={labelSet.key}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.sizeRow}
          >
            {labelSet.labels.map((l) => (
              <Pressable
                key={l}
                disabled={busy}
                onPress={() => shoot(l, false)}
                style={[styles.sizeBtn, busy && styles.dim]}
              >
                <Text style={styles.sizeLabel}>{l}</Text>
                <Text style={styles.sizeSub}>{counts[l] ?? 0}</Text>
              </Pressable>
            ))}
          </ScrollView>
          <Pressable disabled={busy} onPress={() => shoot('NONE', true)} style={[styles.negBtn, busy && styles.dim]}>
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.negLabel}>Not a sticker  ·  {counts.NONE ?? 0}</Text>
            )}
          </Pressable>
        </View>
      </SafeAreaView>

      {/* Label picker for imported photos */}
      <Modal visible={importUris.length > 0} transparent animationType="fade" onRequestClose={() => setImportUris([])}>
        <Pressable style={styles.modalBackdrop} onPress={() => setImportUris([])}>
          <Pressable style={styles.sheet} onPress={() => undefined}>
            <Text style={styles.sheetTitle}>Label {importUris.length} photo{importUris.length === 1 ? '' : 's'}</Text>
            <Text style={styles.sheetBody}>What size are these? They&apos;ll all upload with this label.</Text>
            {/* The 35-chip shoe set does not fit, so the chips scroll while the
                title and Cancel stay pinned.

                The wrap MUST live on an inner View, never on the ScrollView's
                own contentContainerStyle. A wrapping row set as the content
                container gets measured against the ScrollView's bounded height,
                so contentSize comes back equal to the frame and scrolling never
                engages — the grid silently dead-ends (it stranded the run at 17,
                putting 17.5, 18 and the "Not a sticker" hard negative out of
                reach entirely). As a plain child the wrap is measured on its own
                and the default column content container grows to fit it.

                Height is bounded on the SHEET, not here: this view only needs to
                shrink out of the way of the pinned rows. */}
            <ScrollView style={styles.sheetGridScroll}>
              <View style={styles.sheetGrid}>
                {labelSet.labels.map((l) => (
                  <Pressable key={l} onPress={() => labelImport(l, false)} style={styles.sheetChip}>
                    <Text style={styles.sheetChipText}>{l}</Text>
                  </Pressable>
                ))}
                <Pressable onPress={() => labelImport('NONE', true)} style={[styles.sheetChip, styles.sheetChipNeg]}>
                  <Text style={styles.sheetChipText}>Not a sticker</Text>
                </Pressable>
              </View>
            </ScrollView>
            <Pressable onPress={() => setImportUris([])} style={styles.sheetCancel}>
              <Text style={styles.sheetCancelText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

/** Chrome caps for the two pinned viewfinder buttons (15pt Done, 14pt Review). */
const CLOSE_CAP = capTo(15, TYPE_CEILING.chrome);
const REVIEW_CAP = capTo(14, TYPE_CEILING.chrome);

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, backgroundColor: theme.bg },
  permTitle: { color: theme.text, fontSize: 20, fontWeight: '700', marginBottom: 8 },
  permBody: { color: theme.textMuted, fontSize: 14, textAlign: 'center', marginBottom: 20 },
  primaryBtn: {
    minHeight: 48, paddingHorizontal: 24, borderRadius: radius.md,
    backgroundColor: theme.primary, alignItems: 'center', justifyContent: 'center',
  },
  primaryLabel: { color: '#fff', fontSize: 15, fontWeight: '700' },
  importOnly: { marginTop: 18, paddingVertical: 8 },
  importOnlyText: { color: theme.primary, fontSize: 14, fontWeight: '600' },
  // The scrolling half of the overlay: bar + hint. `flex: 1` (shrink 1, basis
  // 0) makes it the ONLY child that yields, so the pinned panel below can never
  // be squeezed or pushed off the bottom of a small screen at AX5.
  chromeScroll: { flex: 1, minHeight: 0 },
  // flexGrow: 1 → the content is at least a viewport tall, so hintWrap still
  // centres the hint exactly as before whenever it all fits, and grows past the
  // viewport (i.e. scrolls) only when it does not.
  chromeContent: { flexGrow: 1 },
  topBar: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingHorizontal: space.md, paddingVertical: space.sm, backgroundColor: 'rgba(0,0,0,0.45)',
  },
  // Past the shared stack threshold: actions on their own row, title beneath at
  // full width. `alignItems: 'stretch'` is what hands the title that width.
  topBarStacked: { flexDirection: 'column', alignItems: 'stretch', gap: space.sm },
  topBarActions: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md,
  },
  titleCol: { flex: 1, minWidth: 0 },
  // No flex: in a column parent `flex: 1` would divide HEIGHT, not width.
  titleColStacked: { minWidth: 0 },
  closeBtn: { paddingVertical: 6, paddingHorizontal: 4, flexShrink: 0 },
  closeText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  reviewBtn: {
    paddingVertical: 6, paddingHorizontal: 12, borderRadius: radius.md,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)', flexShrink: 0,
  },
  reviewText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  title: { color: '#fff', fontSize: 16, fontWeight: '700' },
  subtitle: { color: 'rgba(255,255,255,0.85)', fontSize: 12, marginTop: 1 },
  // `flexGrow: 1`, deliberately NOT `flex: 1`. Both fill the leftover space
  // identically when the chrome fits — one growing child, same result — but
  // `flex: 1` also means `flexShrink: 1, flexBasis: 0`, and a shrinkable child
  // inside a scroll container is how you turn an overlap bug into a CLIPPING
  // bug: at AX5 the hint would be squeezed to whatever was left rather than
  // overflowing into scrollable content. RN defaults `flexShrink` to 0, so
  // growing without shrinking is exactly what this needs.
  hintWrap: {
    flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.md,
  },
  hint: {
    color: '#fff', fontSize: 14, fontWeight: '600',
    backgroundColor: 'rgba(0,0,0,0.45)', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 100,
  },
  hintSub: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 4,
  },
  // flexShrink: 0 is load-bearing, not decoration: the shutter (the size chips)
  // and the hard-negative button must keep their full height at AX5 — the
  // scroll region above absorbs every deficit instead.
  panel: {
    paddingHorizontal: space.md, paddingBottom: space.md, gap: space.sm, flexShrink: 0,
  },
  toolRow: { flexDirection: 'row', gap: space.xs },
  toolBtn: {
    minHeight: 40, paddingHorizontal: 14, borderRadius: radius.md, justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)',
  },
  toolBtnOn: { backgroundColor: theme.primary, borderColor: theme.primary },
  toolLabel: { color: '#fff', fontSize: 13, fontWeight: '700' },
  toolLabelOn: { color: '#fff' },
  sizeRow: { gap: space.xs, paddingVertical: space.xs },
  sizeBtn: {
    minWidth: 60, minHeight: 60, borderRadius: radius.md,
    backgroundColor: 'rgba(255,255,255,0.92)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10,
  },
  sizeLabel: { color: '#111', fontSize: 16, fontWeight: '800' },
  sizeSub: { color: '#555', fontSize: 11, marginTop: 2 },
  negBtn: {
    minHeight: 48, borderRadius: radius.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)',
    alignItems: 'center', justifyContent: 'center',
  },
  negLabel: { color: '#fff', fontSize: 14, fontWeight: '600' },
  dim: { opacity: 0.5 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  // Bounded HERE so the sheet can never grow past the screen and push Cancel
  // off. The chip scroller inside shrinks to whatever is left over.
  sheet: {
    backgroundColor: theme.card, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 22, paddingBottom: 36, maxHeight: '85%',
  },
  sheetTitle: { color: theme.text, fontSize: 18, fontWeight: '700' },
  sheetBody: { color: theme.textMuted, fontSize: 13, marginTop: 6 },
  // No fixed height: it shrinks out of the way of the pinned title and Cancel,
  // and stays content-sized when the set is small enough to fit (Apparel).
  sheetGridScroll: { flexShrink: 1, marginTop: 16 },
  sheetGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  sheetChip: {
    minHeight: 44, paddingHorizontal: 16, borderRadius: radius.md, borderWidth: 1, borderColor: theme.border,
    alignItems: 'center', justifyContent: 'center',
  },
  sheetChipNeg: { borderStyle: 'dashed' },
  sheetChipText: { color: theme.text, fontSize: 15, fontWeight: '700' },
  sheetCancel: { marginTop: 18, alignItems: 'center', paddingVertical: 8 },
  sheetCancelText: { color: theme.textMuted, fontSize: 15, fontWeight: '600' },
});
