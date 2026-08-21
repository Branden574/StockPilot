import { CameraView, useCameraPermissions } from 'expo-camera';
// `/legacy` is load-bearing: expo-file-system 19 (SDK 54) moved the URI-string
// API (getInfoAsync) to this subpath. The same names on the default export are
// still typed but THROW at runtime. See src/lib/maintenance-upload.ts.
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
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

import { SyncStatusBadge } from '@/components/SyncStatusBadge';
import { API_BASE } from '@/lib/api';
import { postMultipart } from '@/lib/multipart-upload';
import { enqueue } from '@/lib/queue';
import { supabase } from '@/lib/supabase';
import { syncNow } from '@/lib/sync';
import { TYPE_CEILING, capTo, radius, space, theme } from '@/lib/theme';

/**
 * AI SIZE SCAN — photograph a garment or a stack, review what was read, count it.
 *
 * ═══ NOTHING IS COUNTED WITHOUT A HUMAN SAYING SO ═══
 *
 * The scanner reads roughly nine stickers in ten correctly (the measurement
 * lives in apps/web/scripts/size-scan-eval/). That is worth a great deal of
 * tapping and it is NOT worth trusting blind: this feeds a physical stock
 * count, and a wrong size is one somebody has to find and unpick later.
 *
 * So the scan lands on a REVIEW list with the counts pre-filled and every
 * number adjustable, and only what the operator confirms is queued. The screen
 * is a faster way to reach the same tap-counted numbers, never a way around
 * them.
 *
 * The two things the review deliberately shows rather than hides:
 *   - readings the server DISCARDED, and why. "The scan missed one" and "the
 *     scan saw one and refused it" look identical from a bare count, and the
 *     operator needs to tell them apart to know whether to re-shoot.
 *   - sizes read that are OUTSIDE this session's group scale. A stray XXXL dot
 *     in a shoe-group box is real information, and silently dropping it would
 *     present a short count as a complete one.
 */

/** Matches SCAN_MAX_BYTES in the route. The compression below lands ~300 KB, so
 *  this only ever catches a device where the resize silently did nothing. */
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
/** 1600px / 0.8 — the same numbers the cycle-count scan and `resizeForUpload`
 *  use, and the same size the accuracy was MEASURED at. Sending something
 *  sharper would not help (the vision API downsamples to ~1568px regardless)
 *  and would measure a photo the product never sends. */
const COMPRESS_MAX_DIMENSION = 1600;
const COMPRESS_QUALITY = 0.8;

type ScanCount = { size: string; count: number };
type Discarded = { rawText: string; reason: 'on_a_label' | 'low_confidence' | 'unreadable' };

type ScanResponse = {
  counts: ScanCount[];
  outsideGroupScale: ScanCount[];
  stickers: { rawText: string; size: string; confidence: number }[];
  discarded: Discarded[];
  modelVersion: string | null;
  groupName: string | null;
};

type Phase =
  | { kind: 'idle' }
  | { kind: 'capturing' }
  | { kind: 'uploading' }
  | { kind: 'review'; scan: ScanResponse; counts: Record<string, number> }
  | { kind: 'saving'; scan: ScanResponse; counts: Record<string, number> };

/** Why a reading did not become a count, in words an operator can act on. */
const DISCARD_REASON: Record<Discarded['reason'], string> = {
  on_a_label: 'on a brand or care label, not a sticker',
  low_confidence: 'could not be read clearly',
  unreadable: 'not a size we recognise',
};

export default function SizeScanScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = React.useRef<CameraView | null>(null);
  const [phase, setPhase] = React.useState<Phase>({ kind: 'idle' });

  async function onCapture() {
    if (!cameraRef.current || phase.kind !== 'idle') return;
    setPhase({ kind: 'capturing' });
    try {
      const captured = await cameraRef.current.takePictureAsync({
        quality: 1,
        skipProcessing: false,
      });
      if (!captured?.uri) {
        Alert.alert('Capture failed', 'Try again.');
        setPhase({ kind: 'idle' });
        return;
      }
      await uploadPhoto(captured.uri);
    } catch (e) {
      Alert.alert('Capture failed', e instanceof Error ? e.message : 'Try again.');
      setPhase({ kind: 'idle' });
    }
  }

  async function uploadPhoto(photoUri: string) {
    setPhase({ kind: 'uploading' });
    try {
      const compressed = await ImageManipulator.manipulateAsync(
        photoUri,
        [{ resize: { width: COMPRESS_MAX_DIMENSION } }],
        { compress: COMPRESS_QUALITY, format: ImageManipulator.SaveFormat.JPEG },
      );
      const info = await FileSystem.getInfoAsync(compressed.uri);
      if (info.exists && typeof info.size === 'number' && info.size > MAX_PHOTO_BYTES) {
        throw new Error('Photo too large after compression. Try again.');
      }

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
      if (!res.ok) {
        const text = await res.text();
        // The refusals a person on the floor can actually do something about.
        if (res.status === 409) throw new Error('This size count is closed.');
        if (res.status === 429) throw new Error('Too many scans just now — wait a moment.');
        if (res.status === 503) throw new Error('Scanning is unavailable right now.');
        throw new Error(`Scan failed (${res.status}): ${text.slice(0, 160)}`);
      }
      const scan = (await res.json()) as ScanResponse;

      const counts: Record<string, number> = {};
      for (const c of scan.counts) counts[c.size] = c.count;
      setPhase({ kind: 'review', scan, counts });
    } catch (e) {
      Alert.alert('Scan failed', e instanceof Error ? e.message : 'Try again.');
      setPhase({ kind: 'idle' });
    }
  }

  function adjust(size: string, delta: 1 | -1) {
    setPhase((p) => {
      if (p.kind !== 'review') return p;
      const next = Math.max(0, (p.counts[size] ?? 0) + delta);
      return { ...p, counts: { ...p.counts, [size]: next } };
    });
  }

  async function onConfirm() {
    if (phase.kind !== 'review') return;
    const entries = Object.entries(phase.counts).filter(([, n]) => n > 0);
    if (entries.length === 0) {
      Alert.alert('Nothing to add', 'Set at least one size above zero, or discard this scan.');
      return;
    }
    setPhase({ ...phase, kind: 'saving' });
    try {
      // ONE EVENT PER SIZE, carrying the whole quantity. The ledger's tally is
      // SUM(quantity_delta), so three M's are one row of +3 rather than three
      // rows of +1 — fewer rows to replay through the outbox, and the audit
      // trail reads as the single reviewed decision it actually was.
      //
      // Queued rather than posted directly: this goes through the same offline
      // outbox as a tapped count, so a scan confirmed in a dead spot at the
      // back of the warehouse is not lost. The server dedups on
      // idempotency_key, so a replay is safe.
      for (const [size, quantity] of entries) {
        await enqueue('size_count_event', {
          sessionId: id,
          size,
          quantityDelta: quantity,
          // The ledger's own value for a photographed count, distinguishing
          // these rows from tapped ones for anyone auditing later.
          recognitionMethod: 'box_overview',
          confidence: confidenceFor(phase.scan, size),
          modelVersion: phase.scan.modelVersion,
          countedAt: new Date().toISOString(),
        });
      }
      void syncNow();
      router.back();
    } catch (e) {
      setPhase({ ...phase, kind: 'review' });
      Alert.alert('Could not add these', e instanceof Error ? e.message : 'Try again.');
    }
  }

  // ─── Render branches ───────────────────────────────────────────────────

  if (!permission) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.primary} />
      </View>
    );
  }
  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.center}>
          <Text style={styles.permTitle}>Camera access needed</Text>
          <Text style={styles.permBody}>
            {permission.canAskAgain
              ? 'Size scan uses the camera to read the size stickers on a garment.'
              : 'Camera access is off for StockPilot. Turn it on in Settings to scan sizes.'}
          </Text>
          {/* App Store 5.1.1(iv): neutral CTA; link to Settings once denied. */}
          {permission.canAskAgain ? (
            <Pressable style={styles.cta} onPress={requestPermission}>
              <Text style={styles.ctaLabel}>Continue</Text>
            </Pressable>
          ) : (
            <Pressable style={styles.cta} onPress={() => Linking.openSettings()}>
              <Text style={styles.ctaLabel}>Open Settings</Text>
            </Pressable>
          )}
        </View>
      </SafeAreaView>
    );
  }

  if (phase.kind === 'review' || phase.kind === 'saving') {
    return (
      <ReviewView
        phase={phase}
        onAdjust={adjust}
        onConfirm={onConfirm}
        onRetake={() => setPhase({ kind: 'idle' })}
      />
    );
  }

  const busy = phase.kind === 'capturing' || phase.kind === 'uploading';
  return (
    <View style={styles.root}>
      <Stack.Screen options={{ headerShown: false }} />
      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />
      <SafeAreaView
        style={StyleSheet.absoluteFill}
        edges={['top', 'bottom']}
        pointerEvents="box-none"
      >
        {/* Dynamic Type: the twin of the cycle-count scan topBar — pinned
            chrome labels take the chrome ceiling, the bar may wrap, and the
            title column keeps a width floor so the wrap can happen. */}
        <View style={styles.topBar} pointerEvents="auto">
          <Pressable style={styles.closeBtn} onPress={() => router.back()}>
            <Text style={styles.closeText} numberOfLines={1} maxFontSizeMultiplier={CLOSE_CAP}>
              Cancel
            </Text>
          </Pressable>
          <View style={styles.titleCol}>
            <Text style={styles.headerLabel} maxFontSizeMultiplier={TITLE_CAP}>
              Scan sizes
            </Text>
            <Text style={styles.headerSub}>You review every reading before it counts</Text>
          </View>
          <SyncStatusBadge />
        </View>

        <View style={styles.frameWrap} pointerEvents="none">
          <View style={styles.frame} />
          <Text style={styles.hint}>
            Fill the frame with the sticker. Any angle is fine — upside down reads correctly.
          </Text>
        </View>

        <View style={styles.bottomBar} pointerEvents="auto">
          <Pressable
            style={[styles.captureBtn, busy && styles.captureBtnBusy]}
            onPress={onCapture}
            disabled={busy}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <View style={styles.captureBtnInner} />}
          </Pressable>
          <Text style={styles.captureCaption}>
            {phase.kind === 'capturing'
              ? 'Capturing…'
              : phase.kind === 'uploading'
                ? 'Reading stickers…'
                : 'Tap to capture'}
          </Text>
        </View>
      </SafeAreaView>
    </View>
  );
}

/** The highest confidence reported for this size, recorded on the event so a
 *  later audit can tell a certain reading from a marginal one. Null when the
 *  operator typed the size in themselves rather than the scan proposing it. */
function confidenceFor(scan: ScanResponse, size: string): number | null {
  const matches = scan.stickers.filter((s) => s.size === size);
  if (matches.length === 0) return null;
  return Math.max(...matches.map((s) => s.confidence));
}

// ───────────────────────────────────────────────────────────────────────
// Review — the whole safety model of this screen
// ───────────────────────────────────────────────────────────────────────

function ReviewView({
  phase,
  onAdjust,
  onConfirm,
  onRetake,
}: {
  phase: Extract<Phase, { kind: 'review' } | { kind: 'saving' }>;
  onAdjust: (size: string, delta: 1 | -1) => void;
  onConfirm: () => void;
  onRetake: () => void;
}) {
  const saving = phase.kind === 'saving';
  const rows = Object.entries(phase.counts);
  const total = rows.reduce((a, [, n]) => a + n, 0);
  const { discarded, outsideGroupScale, groupName } = phase.scan;

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.reviewHeader}>
        <Text style={styles.reviewTitle} maxFontSizeMultiplier={TITLE_CAP}>
          Check this before adding
        </Text>
        <Text style={styles.reviewSub}>
          {rows.length === 0
            ? 'No size stickers were read in that photo.'
            : `Adjust anything that looks wrong.${groupName ? ` ${groupName}.` : ''}`}
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.reviewBody}>
        {rows.length === 0 ? (
          <Text style={styles.emptyNote}>
            Retake the photo with the sticker filling more of the frame, or go back and tap the
            sizes in by hand.
          </Text>
        ) : (
          rows.map(([size, n]) => (
            <View key={size} style={styles.row}>
              <Text style={styles.rowSize}>{size}</Text>
              <View style={styles.stepper}>
                <Pressable
                  onPress={() => onAdjust(size, -1)}
                  disabled={saving}
                  style={styles.stepBtn}
                  hitSlop={8}
                >
                  <Text style={styles.stepLabel}>−</Text>
                </Pressable>
                <Text style={styles.rowCount}>{n}</Text>
                <Pressable
                  onPress={() => onAdjust(size, 1)}
                  disabled={saving}
                  style={styles.stepBtn}
                  hitSlop={8}
                >
                  <Text style={styles.stepLabel}>+</Text>
                </Pressable>
              </View>
            </View>
          ))
        )}

        {/* NOT SILENTLY DROPPED. A size read but outside this session's scale is
            real information about what is in the box. */}
        {outsideGroupScale.length > 0 ? (
          <View style={styles.noteBlock}>
            <Text style={styles.noteTitle}>Read, but not in this count&apos;s size scale</Text>
            {outsideGroupScale.map((c) => (
              <Text key={c.size} style={styles.noteLine}>
                {c.size} × {c.count}
              </Text>
            ))}
          </View>
        ) : null}

        {/* "The scan missed one" and "the scan saw one and refused it" look the
            same from a bare count. The operator needs to tell them apart to
            know whether re-shooting would help. */}
        {discarded.length > 0 ? (
          <View style={styles.noteBlock}>
            <Text style={styles.noteTitle}>Seen but not counted</Text>
            {discarded.map((d, i) => (
              <Text key={`${d.rawText}-${i}`} style={styles.noteLine}>
                {d.rawText ? `“${d.rawText}” — ` : ''}
                {DISCARD_REASON[d.reason]}
              </Text>
            ))}
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.reviewFooter}>
        <Pressable onPress={onRetake} disabled={saving} style={styles.retakeBtn}>
          <Text style={styles.retakeLabel}>Retake</Text>
        </Pressable>
        <Pressable
          onPress={onConfirm}
          disabled={saving || total === 0}
          style={[styles.confirmBtn, (saving || total === 0) && styles.confirmBtnDisabled]}
        >
          {saving ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.confirmLabel}>Add {total}</Text>
          )}
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const CLOSE_CAP = capTo(14, TYPE_CEILING.chrome);
const TITLE_CAP = capTo(16, TYPE_CEILING.chrome);

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.lg },

  permTitle: { color: theme.text, fontSize: 18, fontWeight: '700', marginBottom: space.sm },
  permBody: { color: theme.textMuted, fontSize: 14, textAlign: 'center', marginBottom: space.lg },
  cta: {
    backgroundColor: theme.primary,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.md,
  },
  ctaLabel: { color: '#fff', fontWeight: '700', fontSize: 15 },

  topBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  closeBtn: { paddingVertical: space.xs, paddingRight: space.xs },
  closeText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  titleCol: { flex: 1, minWidth: 120 },
  headerLabel: { color: '#fff', fontSize: 16, fontWeight: '700' },
  headerSub: { color: 'rgba(255,255,255,0.75)', fontSize: 11, marginTop: 1 },

  frameWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  frame: {
    width: '68%',
    aspectRatio: 1,
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.85)',
  },
  hint: {
    color: '#fff',
    fontSize: 13,
    marginTop: space.md,
    textAlign: 'center',
    paddingHorizontal: space.lg,
  },

  bottomBar: { alignItems: 'center', paddingBottom: space.lg, gap: space.sm },
  captureBtn: {
    width: 74,
    height: 74,
    borderRadius: 37,
    borderWidth: 4,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureBtnBusy: { opacity: 0.6 },
  captureBtnInner: { width: 58, height: 58, borderRadius: 29, backgroundColor: '#fff' },
  captureCaption: { color: '#fff', fontSize: 13 },

  reviewHeader: {
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  reviewTitle: { color: theme.text, fontSize: 20, fontWeight: '700' },
  reviewSub: { color: theme.textMuted, fontSize: 13, marginTop: 2 },
  reviewBody: { padding: space.md, gap: space.sm },
  emptyNote: { color: theme.textMuted, fontSize: 14, lineHeight: 20 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: theme.card,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: space.md,
  },
  rowSize: { color: theme.text, fontSize: 20, fontWeight: '700', flex: 1 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  stepBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.bg,
  },
  stepLabel: { color: theme.primary, fontSize: 22, fontWeight: '700' },
  rowCount: { color: theme.text, fontSize: 20, fontWeight: '700', minWidth: 32, textAlign: 'center' },

  noteBlock: {
    marginTop: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  noteTitle: { color: theme.text, fontSize: 13, fontWeight: '700', marginBottom: 4 },
  noteLine: { color: theme.textMuted, fontSize: 12, lineHeight: 18 },

  reviewFooter: {
    flexDirection: 'row',
    gap: space.sm,
    padding: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
  },
  retakeBtn: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    justifyContent: 'center',
  },
  retakeLabel: { color: theme.text, fontWeight: '600', fontSize: 15 },
  confirmBtn: {
    flex: 1,
    backgroundColor: theme.primary,
    borderRadius: radius.md,
    paddingVertical: space.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmBtnDisabled: { opacity: 0.5 },
  confirmLabel: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
