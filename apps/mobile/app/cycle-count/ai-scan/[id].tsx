import { CameraView, useCameraPermissions } from 'expo-camera';
import * as FileSystem from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SyncStatusBadge } from '@/components/SyncStatusBadge';
import { API_BASE } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import {
  getCycleCount,
  updateLocalLine,
  type CachedCycleCountLine,
} from '@/lib/cycle-count-cache';
import { cycleCountSync } from '@/lib/cycle-count-sync';
import { supabase } from '@/lib/supabase';
import { radius, space, theme } from '@/lib/theme';

const AI_CONFIDENCE_THRESHOLD = 0.85;
// Max compressed bytes before we refuse to upload. Matches the
// server-side cap in /api/cycle-counts/[id]/ai-scan/route.ts.
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
// Target longest-side after compression. Matches the master variant
// dimension used on the web; smaller is plenty for Gemini's vision
// input (it downsamples internally anyway).
const COMPRESS_MAX_DIMENSION = 1600;
const COMPRESS_QUALITY = 0.8;

/**
 * One row of the AI-proposed review list. `result` is undefined when
 * Gemini didn't see this line at all (greyed-out state) — the user
 * can still edit it manually.
 */
interface ReviewLine {
  line: CachedCycleCountLine;
  result?: {
    sku: string;
    count: number;
    confidence: number;
    notes?: string;
  };
  /** User-edited count override. Null until the user touches it. */
  override: string | null;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'capturing' }
  | { kind: 'uploading' }
  | {
      kind: 'review';
      scanId: string;
      photoSignedUrl: string;
      reviewLines: ReviewLine[];
    }
  | { kind: 'saving' };

/**
 * AI Shelf Scan capture + review screen.
 *
 * State machine:
 *   idle      — camera live, capture button enabled
 *   capturing — takePictureAsync running
 *   uploading — compressing + POSTing photo to /api/cycle-counts/.../ai-scan
 *   review    — server returned proposals; user reviews + confirms
 *   saving    — writing each line via the v1 record endpoint, then marking the scan confirmed
 *
 * On confirm, each line's counted_quantity writes through the existing
 * record endpoint (online; the AI scan is online-only by design),
 * with `aiScanId` set so the audit trail traces back to the scan.
 * The local SQLite cache is updated in lockstep so the cycle-count
 * detail screen reflects the new counts immediately.
 */
export default function AiScanScreen() {
  const router = useRouter();
  const { id: cycleCountId } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = React.useRef<CameraView | null>(null);

  const [phase, setPhase] = React.useState<Phase>({ kind: 'idle' });
  const [cachedLines, setCachedLines] = React.useState<CachedCycleCountLine[]>([]);

  React.useEffect(() => {
    if (!user || !cycleCountId) return;
    void (async () => {
      const snap = await getCycleCount(cycleCountId);
      if (!snap) {
        Alert.alert(
          'No cached lines',
          'Open this cycle count from the list once while online so it can be cached for AI scanning.',
          [{ text: 'OK', onPress: () => router.back() }],
        );
        return;
      }
      setCachedLines(snap.lines);
    })();
  }, [user, cycleCountId, router]);

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
      await uploadCapturedPhoto(captured.uri);
    } catch (e) {
      Alert.alert('Capture failed', e instanceof Error ? e.message : 'Try again.');
      setPhase({ kind: 'idle' });
    }
  }

  async function uploadCapturedPhoto(photoUri: string) {
    setPhase({ kind: 'uploading' });
    try {
      // Compress + downscale before upload — phone-camera raw JPEGs
      // are 4-10 MB; Gemini gets the same accuracy from 1600px JPEG
      // at quality 0.8 (~200-600 KB) and the round-trip is ~5x
      // faster on cellular.
      const compressed = await ImageManipulator.manipulateAsync(
        photoUri,
        [{ resize: { width: COMPRESS_MAX_DIMENSION } }],
        {
          compress: COMPRESS_QUALITY,
          format: ImageManipulator.SaveFormat.JPEG,
        },
      );

      // Sanity-check size after compression. (A fetch HEAD on a file:// URI
      // does NOT populate content-length, so the previous check was dead and
      // never fired.) getInfoAsync always returns size for file:// locations.
      const info = await FileSystem.getInfoAsync(compressed.uri, { size: true });
      if (info.exists && typeof info.size === 'number' && info.size > MAX_PHOTO_BYTES) {
        throw new Error('Photo too large after compression. Try again.');
      }

      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in.');

      const form = new FormData();
      // React Native's FormData accepts the {uri, name, type} shape.
      // The cast satisfies the DOM-flavored typing pulled in by the
      // web monorepo's tsconfig.
      form.append('image', {
        uri: compressed.uri,
        name: 'scan.jpg',
        type: 'image/jpeg',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      const res = await fetch(
        `${API_BASE}/api/cycle-counts/${cycleCountId}/ai-scan`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.access_token}` },
          body: form,
        },
      );
      if (!res.ok) {
        const text = await res.text();
        // Friendlier message for the common "no books in this count" case.
        if (res.status === 422) {
          throw new Error('This count has no books to scan.');
        }
        throw new Error(`Scan failed (${res.status}): ${text.slice(0, 200)}`);
      }
      const payload = (await res.json()) as {
        scanId: string;
        photoSignedUrl: string;
        results: Array<{
          lineId: string;
          sku: string;
          count: number;
          confidence: number;
          notes?: string;
        }>;
      };

      // Build the review-line list — every cached line, with its AI
      // result attached when one exists. Books-only filter for v1
      // means we only render book lines; non-books are hidden on the
      // review (they can still be counted from the regular detail
      // screen via barcode/manual).
      const resultsByLineId = new Map(payload.results.map((r) => [r.lineId, r]));
      const reviewLines: ReviewLine[] = cachedLines.map((line) => ({
        line,
        result: resultsByLineId.get(line.id),
        override: null,
      }));

      setPhase({
        kind: 'review',
        scanId: payload.scanId,
        photoSignedUrl: payload.photoSignedUrl,
        reviewLines,
      });
    } catch (e) {
      Alert.alert(
        'Scan failed',
        e instanceof Error ? e.message : 'Try again.',
      );
      setPhase({ kind: 'idle' });
    }
  }

  function setLineOverride(lineId: string, next: string | null) {
    if (phase.kind !== 'review') return;
    setPhase({
      ...phase,
      reviewLines: phase.reviewLines.map((rl) =>
        rl.line.id === lineId ? { ...rl, override: next } : rl,
      ),
    });
  }

  async function onConfirm() {
    if (phase.kind !== 'review') return;

    // Decide each line's final count.
    //   • User override wins.
    //   • Else high-confidence AI result auto-applies.
    //   • Low-confidence AI without override → SKIP (user didn't approve).
    //   • No AI result + no override → SKIP (user didn't touch the line).
    const toWrite: Array<{ lineId: string; count: number }> = [];
    for (const rl of phase.reviewLines) {
      if (rl.override !== null) {
        const n = Number(rl.override);
        if (Number.isFinite(n) && n >= 0) {
          toWrite.push({ lineId: rl.line.id, count: Math.floor(n) });
        }
        continue;
      }
      if (rl.result && rl.result.confidence >= AI_CONFIDENCE_THRESHOLD) {
        toWrite.push({ lineId: rl.line.id, count: rl.result.count });
      }
    }
    if (toWrite.length === 0) {
      Alert.alert(
        'Nothing to save',
        'Tap a line to confirm the AI count or enter a manual value.',
      );
      return;
    }

    // Capture the full review phase (incl. photoSignedUrl) so we can restore it
    // verbatim if the save fails — keeping the user's review list intact.
    const reviewPhase = phase;
    const scanId = phase.scanId;
    setPhase({ kind: 'saving' });
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in.');

      // Write each line via the existing v1 record endpoint (now accepting
      // aiScanId). Each line is recorded INDEPENDENTLY: a mid-batch failure
      // (network blip, a single line rejected, token expiry between lines)
      // must NOT abort the rest and discard the review list. record sets an
      // ABSOLUTE counted_quantity (not an increment), so re-recording a line
      // is idempotent and retry is always safe.
      const failed: string[] = [];
      for (const w of toWrite) {
        try {
          const res = await fetch(
            `${API_BASE}/api/v1/cycle-counts/${cycleCountId}/lines/${w.lineId}/record`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${session.access_token}`,
              },
              body: JSON.stringify({
                countedQuantity: w.count,
                aiScanId: scanId,
              }),
            },
          );
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`${res.status}: ${text.slice(0, 200)}`);
          }
          // Mirror into the local SQLite cache so the detail screen reflects
          // the new count without waiting for a sync round-trip.
          await updateLocalLine(w.lineId, w.count);
        } catch (lineErr) {
          console.warn('[cycle-count] line save failed', w.lineId, lineErr);
          failed.push(w.lineId);
        }
      }

      if (failed.length > 0) {
        // Partial save: KEEP the review list so the user can see their work
        // and retry. Re-confirming re-sends every line, but record is an
        // idempotent absolute SET so already-saved lines are unaffected.
        await cycleCountSync.refreshPendingCount();
        Alert.alert(
          'Partially saved',
          `${toWrite.length - failed.length} of ${toWrite.length} counts saved. ` +
            `${failed.length} couldn't save — check your connection and tap Confirm to retry.`,
        );
        setPhase(reviewPhase);
        return;
      }

      // Mark the scan confirmed. Best-effort — if this fails the lines are
      // still recorded; the scan just stays unconfirmed in the audit table.
      await fetch(
        `${API_BASE}/api/cycle-counts/${cycleCountId}/ai-scan/${scanId}/confirm`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.access_token}` },
        },
      ).catch(() => null);

      await cycleCountSync.refreshPendingCount();
      void cycleCountSync.forceSync();
      router.back();
    } catch (e) {
      // Only a non-per-line error (e.g. not signed in) reaches here. Keep the
      // review list rather than discarding it to the camera, so nothing is lost.
      Alert.alert(
        'Save failed',
        e instanceof Error ? e.message : 'Could not save. Check your connection and try again.',
      );
      setPhase(reviewPhase);
    }
  }

  // ─── Render branches ─────────────────────────────────────────────────

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
              ? 'AI Shelf Scan uses the camera to identify books on the shelf.'
              : 'Camera access is off for StockPilot. Turn it on in Settings to use AI Shelf Scan.'}
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
        onOverride={setLineOverride}
        onConfirm={onConfirm}
        onCancel={() => setPhase({ kind: 'idle' })}
      />
    );
  }

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ headerShown: false }} />
      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />
      <SafeAreaView style={StyleSheet.absoluteFill} edges={['top', 'bottom']} pointerEvents="box-none">
        <View style={styles.topBar} pointerEvents="auto">
          <Pressable style={styles.closeBtn} onPress={() => router.back()}>
            <Text style={styles.closeText}>Cancel</Text>
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerLabel}>AI Shelf Scan</Text>
            <Text style={styles.headerSub}>
              {cachedLines.length} {cachedLines.length === 1 ? 'book' : 'books'} in this count
            </Text>
          </View>
          <SyncStatusBadge />
        </View>

        <View style={styles.frameWrap} pointerEvents="none">
          <View style={styles.frame} />
          <Text style={styles.hint}>Frame one shelf row from straight on</Text>
        </View>

        <View style={styles.bottomBar} pointerEvents="auto">
          <Pressable
            style={[
              styles.captureBtn,
              (phase.kind === 'capturing' || phase.kind === 'uploading') && styles.captureBtnBusy,
            ]}
            onPress={onCapture}
            disabled={phase.kind !== 'idle'}
          >
            {phase.kind === 'capturing' || phase.kind === 'uploading' ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <View style={styles.captureBtnInner} />
            )}
          </Pressable>
          <Text style={styles.captureCaption}>
            {phase.kind === 'capturing'
              ? 'Capturing…'
              : phase.kind === 'uploading'
                ? 'Analyzing photo…'
                : 'Tap to capture'}
          </Text>
        </View>
      </SafeAreaView>
    </View>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Review screen — same component, different phase
// ───────────────────────────────────────────────────────────────────────

function ReviewView({
  phase,
  onOverride,
  onConfirm,
  onCancel,
}: {
  phase: Extract<Phase, { kind: 'review' } | { kind: 'saving' }>;
  onOverride: (lineId: string, next: string | null) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const reviewLines = phase.kind === 'review' ? phase.reviewLines : [];
  const saving = phase.kind === 'saving';

  // Group by AI status so the user reviews the easy stuff first.
  const high: ReviewLine[] = [];
  const low: ReviewLine[] = [];
  const undetected: ReviewLine[] = [];
  for (const rl of reviewLines) {
    if (!rl.result) undetected.push(rl);
    else if (rl.result.confidence >= AI_CONFIDENCE_THRESHOLD) high.push(rl);
    else low.push(rl);
  }

  return (
    <SafeAreaView style={styles.reviewRoot} edges={['top', 'bottom']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.reviewHeader}>
        <Pressable onPress={onCancel} disabled={saving}>
          <Text style={[styles.reviewBack, saving && { opacity: 0.4 }]}>← Back</Text>
        </Pressable>
        <Text style={styles.reviewTitle}>Review AI counts</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: space.md, gap: space.md }}>
        {phase.kind === 'review' && phase.photoSignedUrl ? (
          <Image
            source={{ uri: phase.photoSignedUrl }}
            style={styles.reviewPhoto}
            resizeMode="cover"
          />
        ) : null}

        {high.length > 0 && (
          <ReviewSection
            title="High confidence"
            subtitle="Tap to override if needed"
            color={theme.success}
            lines={high}
            onOverride={onOverride}
            disabled={saving}
          />
        )}
        {low.length > 0 && (
          <ReviewSection
            title="Low confidence — needs review"
            subtitle="Enter a count to confirm"
            color={theme.warning}
            lines={low}
            onOverride={onOverride}
            disabled={saving}
          />
        )}
        {undetected.length > 0 && (
          <ReviewSection
            title="Not detected"
            subtitle="AI didn't see these — enter manually if needed"
            color={theme.textMuted}
            lines={undetected}
            onOverride={onOverride}
            disabled={saving}
          />
        )}
      </ScrollView>

      <View style={styles.reviewFooter}>
        <Pressable
          style={[styles.btn, styles.btnPrimary, saving && { opacity: 0.5 }]}
          onPress={onConfirm}
          disabled={saving}
        >
          <Text style={styles.btnPrimaryLabel}>
            {saving ? 'Saving…' : 'Confirm counts'}
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

function ReviewSection({
  title,
  subtitle,
  color,
  lines,
  onOverride,
  disabled,
}: {
  title: string;
  subtitle: string;
  color: string;
  lines: ReviewLine[];
  onOverride: (lineId: string, next: string | null) => void;
  disabled: boolean;
}) {
  return (
    <View style={styles.section}>
      <View style={[styles.sectionAccent, { backgroundColor: color }]} />
      <View style={{ flex: 1 }}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <Text style={styles.sectionSubtitle}>{subtitle}</Text>
        <View style={{ marginTop: space.sm, gap: space.xs }}>
          {lines.map((rl) => (
            <ReviewRow key={rl.line.id} rl={rl} onOverride={onOverride} disabled={disabled} />
          ))}
        </View>
      </View>
    </View>
  );
}

function ReviewRow({
  rl,
  onOverride,
  disabled,
}: {
  rl: ReviewLine;
  onOverride: (lineId: string, next: string | null) => void;
  disabled: boolean;
}) {
  const proposed = rl.result?.count;
  const display = rl.override !== null
    ? rl.override
    : proposed !== undefined
      ? String(proposed)
      : '';
  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowName} numberOfLines={2}>
          {rl.line.itemName}
        </Text>
        <Text style={styles.rowMeta}>
          Expected {rl.line.expected}
          {rl.result ? ` · AI ${(rl.result.confidence * 100).toFixed(0)}%` : ''}
        </Text>
      </View>
      <TextInput
        style={styles.rowQty}
        value={display}
        onChangeText={(v) => onOverride(rl.line.id, v)}
        keyboardType="numeric"
        editable={!disabled}
        selectTextOnFocus
        placeholder="—"
        placeholderTextColor={theme.textMuted}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: space.xl,
    backgroundColor: theme.bg,
  },
  topBar: {
    flexDirection: 'row',
    gap: space.sm,
    padding: space.md,
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  closeBtn: {
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  closeText: { color: '#fff', fontWeight: '600' },
  headerLabel: { color: '#fff', fontWeight: '700', fontSize: 16 },
  headerSub: { color: 'rgba(255,255,255,0.7)', fontSize: 12, marginTop: 2 },
  frameWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: space.md,
  },
  frame: {
    width: 280,
    height: 360,
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.6)',
  },
  hint: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 13,
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.sm,
    textAlign: 'center',
  },
  bottomBar: {
    paddingHorizontal: space.lg,
    paddingBottom: space.lg,
    paddingTop: space.md,
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  captureBtn: {
    width: 78,
    height: 78,
    borderRadius: 39,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderWidth: 4,
    borderColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
  },
  captureBtnBusy: { opacity: 0.8 },
  captureBtnInner: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: '#fff',
  },
  captureCaption: { color: '#fff', fontSize: 13, fontWeight: '500' },
  permTitle: {
    color: theme.text,
    fontSize: 20,
    fontWeight: '700',
    marginBottom: space.sm,
  },
  permBody: {
    color: theme.textMuted,
    textAlign: 'center',
    marginBottom: space.lg,
  },
  cta: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    backgroundColor: theme.primary,
    borderRadius: radius.md,
  },
  ctaLabel: { color: '#fff', fontWeight: '600' },

  // Review screen
  reviewRoot: { flex: 1, backgroundColor: theme.bg },
  reviewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  reviewBack: { color: theme.primary, fontWeight: '600' },
  reviewTitle: { color: theme.text, fontWeight: '700', fontSize: 16 },
  reviewPhoto: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: radius.md,
    backgroundColor: theme.card,
  },
  section: { flexDirection: 'row', gap: space.sm },
  sectionAccent: { width: 4, borderRadius: 2 },
  sectionTitle: { color: theme.text, fontWeight: '700', fontSize: 14 },
  sectionSubtitle: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: theme.card,
    borderRadius: radius.sm,
    padding: space.sm,
  },
  rowName: { color: theme.text, fontSize: 14, fontWeight: '500' },
  rowMeta: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  rowQty: {
    width: 70,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: theme.border,
    color: theme.text,
    textAlign: 'center',
    fontWeight: '600',
    fontSize: 16,
  },
  reviewFooter: {
    padding: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
    backgroundColor: theme.bg,
  },
  btn: {
    paddingVertical: space.md,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnPrimary: { backgroundColor: theme.primary },
  btnPrimaryLabel: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
