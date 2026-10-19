import { CameraView, useCameraPermissions } from 'expo-camera';
// `/legacy` is load-bearing: expo-file-system 19 (SDK 54) moved the URI-string
// API (getInfoAsync) to this subpath. The same names on the default export are
// still typed but THROW at runtime. See src/lib/maintenance-upload.ts.
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
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
import { Button } from '@/components/ui/button';
import { PHOTO_BACKGROUND } from '@/components/ui/tones';
import { API_BASE, orgHeader } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import {
  getCycleCount,
  outboxAck,
  updateLocalLine,
  type CachedCycleCountLine,
} from '@/lib/cycle-count-cache';
import { cycleCountSync } from '@/lib/cycle-count-sync';
import { postMultipart } from '@/lib/multipart-upload';
import { supabase } from '@/lib/supabase';
import { FONT, TYPE_CEILING, capTo, palette, radius, space } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

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
 * What Confirm writes for one review line, or null for nothing:
 *   • the person's own number, when they typed one (it wins);
 *   • else the AI's count, when it is confident;
 *   • else nothing (a low-confidence or undetected line the person left
 *     alone was never approved).
 * A box the person emptied holds no number, so nothing is written for it:
 * Number('') is 0, and an emptied box used to record a count of 0, which a
 * post then applies as the loss of every one expected (the count scanner's
 * fix, P3.8; the count screen never saves an empty box either).
 */
function lineCountToWrite(rl: ReviewLine): number | null {
  if (rl.override !== null) {
    if (rl.override.trim() === '') return null;
    const n = Number(rl.override);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  }
  if (rl.result && rl.result.confidence >= AI_CONFIDENCE_THRESHOLD) return rl.result.count;
  return null;
}

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
 * detail screen reflects the new counts immediately — and the outbox row
 * that mirror creates is acked on the spot, because the server already
 * has the write (see the SP-036 note in onConfirm).
 */
export default function AiScanScreen() {
  const router = useRouter();
  const { id: cycleCountId } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = React.useRef<CameraView | null>(null);
  // The permission screen follows the device's mode; the camera chrome is
  // dark in both (CAMERA, below).
  const { c } = useTheme();

  const [phase, setPhase] = React.useState<Phase>({ kind: 'idle' });
  const [cachedLines, setCachedLines] = React.useState<CachedCycleCountLine[]>([]);

  React.useEffect(() => {
    if (!user || !cycleCountId) return;
    void (async () => {
      // The lines saved on this phone. A read that fails is said, and the
      // screen goes back: it used to be an unhandled rejection that left
      // "0 books in this count" over a camera that could only scan nothing.
      let snap: Awaited<ReturnType<typeof getCycleCount>>;
      try {
        snap = await getCycleCount(cycleCountId);
      } catch {
        Alert.alert('Could not load this count', 'This count could not be read on this phone.', [
          { text: 'OK', onPress: () => router.back() },
        ]);
        return;
      }
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
      // No `{ size: true }` opt-in any more: expo-file-system 19 dropped
      // `size` from legacy `InfoOptions` (it only carries `md5` now) because
      // the native handler populates `size` unconditionally and `FileInfo.size`
      // became non-optional. Same bytes reported, one fewer argument.
      const info = await FileSystem.getInfoAsync(compressed.uri);
      if (info.exists && typeof info.size === 'number' && info.size > MAX_PHOTO_BYTES) {
        throw new Error('Photo too large after compression. Try again.');
      }

      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in.');

      const res = await postMultipart(
        `${API_BASE}/api/cycle-counts/${cycleCountId}/ai-scan`,
        {
          files: [
            {
              field: 'image',
              uri: compressed.uri,
              fileName: 'scan.jpg',
              contentType: 'image/jpeg',
            },
          ],
          headers: { Authorization: `Bearer ${session.access_token}`, ...(await orgHeader()) },
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
        results: {
          lineId: string;
          sku: string;
          count: number;
          confidence: number;
          notes?: string;
        }[];
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

    // Decide each line's final count (lineCountToWrite):
    //   • User override wins (an emptied box writes nothing, never a 0).
    //   • Else high-confidence AI result auto-applies.
    //   • Low-confidence AI without override → SKIP (user didn't approve).
    //   • No AI result + no override → SKIP (user didn't touch the line).
    const toWrite: { lineId: string; count: number }[] = [];
    for (const rl of phase.reviewLines) {
      const count = lineCountToWrite(rl);
      if (count !== null) toWrite.push({ lineId: rl.line.id, count });
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
                ...(await orgHeader()),
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
          //
          // ═══ AND ACK IT IMMEDIATELY (SP-036) ═══
          // `updateLocalLine` is the OFFLINE edit path: besides writing
          // `counted` it sets local_dirty=1 and enqueues a `record_count`
          // outbox row carrying {cycleCountId, lineId, countedQuantity} —
          // and NOTHING ELSE. The server has already accepted this exact
          // count one statement above, so letting that row replay (the
          // `forceSync()` at the end of this function drains it seconds
          // later) did two kinds of damage:
          //
          //   1. the replay POSTs this same route WITHOUT aiScanId, and the
          //      route records a missing aiScanId as NULL — wiping the
          //      ai_scan_id the direct write just set, so the audit link
          //      from the count back to the scan photo was lost on every
          //      AI-confirmed line;
          //   2. it doubled request volume (N direct + N replays) against
          //      the route's 120/min per-user rate limit, so a ~60-line
          //      confirm tripped 429s → rows to 'failed' with backoff →
          //      "Sync issue · retrying" and posting blocked by hasPending.
          //
          // `outboxAck` is exactly the "the server has this" bookkeeping:
          // it deletes the outbox row and clears local_dirty in ONE
          // transaction. Nothing is lost by acking — this screen is
          // online-only by design, so there is no offline edit to preserve,
          // and the count itself is already durable server-side.
          const mirrored = await updateLocalLine(w.lineId, w.count);
          if (mirrored) await outboxAck(mirrored.outboxId);
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
          headers: { Authorization: `Bearer ${session.access_token}`, ...(await orgHeader()) },
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
      <View style={[styles.center, { backgroundColor: c.paper }]}>
        <ActivityIndicator color={c.ink} />
      </View>
    );
  }
  if (!permission.granted) {
    return (
      <SafeAreaView style={[styles.permRoot, { backgroundColor: c.paper }]} edges={['top']}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.center}>
          <Text style={[styles.permTitle, { color: c.ink }]}>Camera access needed</Text>
          <Text style={[styles.permBody, { color: c.ink3 }]}>
            {permission.canAskAgain
              ? 'AI Shelf Scan uses the camera to identify books on the shelf.'
              : 'Camera access is off for StockPilot. Turn it on in Settings to use AI Shelf Scan.'}
          </Text>
          {/* App Store 5.1.1(iv): neutral CTA; link to Settings once denied. */}
          {permission.canAskAgain ? (
            <Button onPress={requestPermission} style={styles.cta}>
              Continue
            </Button>
          ) : (
            <Button onPress={() => Linking.openSettings()} style={styles.cta}>
              Open Settings
            </Button>
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
      {/* The bars are dark in both modes, so the clock and battery over them
          are light (the root's dark words sat on the dark bar in light mode).
          The review that follows is an ordinary screen and takes the device's. */}
      <StatusBar style="light" />
      {/* Dynamic Type: the exact twin of the cycle-count scan topBar — a
          `flex: 1` title column between non-shrinking chrome and a
          SyncStatusBadge that may claim 60% of the bar. Same fix: the two
          pinned labels take the chrome ceiling, the bar may wrap to a second
          line, and the title column keeps a real width floor so that wrap
          can actually happen. */}
      <SafeAreaView edges={['top']} style={styles.barArea}>
        <View style={styles.topBar}>
          <Pressable
            style={styles.closeFrame}
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          >
            <View style={styles.closeBtn}>
              <Text style={styles.closeText} numberOfLines={1} maxFontSizeMultiplier={CLOSE_CAP}>
                Cancel
              </Text>
            </View>
          </Pressable>
          <View style={styles.titleCol}>
            <Text style={styles.headerLabel} maxFontSizeMultiplier={TITLE_CAP}>
              AI Shelf Scan
            </Text>
            <Text style={styles.headerSub}>
              {cachedLines.length} {cachedLines.length === 1 ? 'book' : 'books'} in this count
            </Text>
          </View>
          {/* Drawn for the always-dark bar (P3.8's camera surface), so its
              outline and words read on it in both modes. */}
          <SyncStatusBadge surface="camera" />
        </View>
      </SafeAreaView>

      <View style={styles.viewfinder}>
        <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />
        <View style={styles.frameWrap} pointerEvents="none">
          <ShelfFrame />
          <View style={styles.hintPill}>
            <Text style={styles.hint}>Frame one shelf row from straight on</Text>
          </View>
        </View>
      </View>

      <SafeAreaView edges={['bottom']} style={styles.bottomBar}>
        <Pressable
          style={[
            styles.captureBtn,
            (phase.kind === 'capturing' || phase.kind === 'uploading') && styles.captureBtnBusy,
          ]}
          onPress={onCapture}
          disabled={phase.kind !== 'idle'}
          accessibilityRole="button"
          accessibilityLabel="Capture photo"
          accessibilityState={{
            disabled: phase.kind !== 'idle',
            busy: phase.kind === 'capturing' || phase.kind === 'uploading',
          }}
        >
          {phase.kind === 'capturing' || phase.kind === 'uploading' ? (
            <ActivityIndicator color={CAMERA.ink} />
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
      </SafeAreaView>
    </View>
  );
}

/**
 * The finder over the live picture: the reference's four corner brackets in
 * the dark-mode mint (DESIGN-SPEC 6.20), in the shelf-row frame this screen
 * always had (it was a white rounded outline). No scan line: this camera
 * takes a photo, it does not read a barcode. Nothing on it moves.
 */
function ShelfFrame() {
  return (
    <View style={styles.frame}>
      <View style={[styles.corner, styles.cornerTL]} />
      <View style={[styles.corner, styles.cornerTR]} />
      <View style={[styles.corner, styles.cornerBL]} />
      <View style={[styles.corner, styles.cornerBR]} />
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
  const { c } = useTheme();
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
    <SafeAreaView
      style={[styles.reviewRoot, { backgroundColor: c.paper }]}
      edges={['top', 'bottom']}
    >
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.reviewHeader, { borderBottomColor: c.hair }]}>
        <Pressable
          onPress={onCancel}
          disabled={saving}
          style={styles.reviewBackBtn}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Text style={[styles.reviewBack, { color: c.ink }, saving && { opacity: 0.4 }]}>
            ← Back
          </Text>
        </Pressable>
        <Text accessibilityRole="header" style={[styles.reviewTitle, { color: c.ink }]}>
          Review AI counts
        </Text>
        <View style={{ width: 60 }} />
      </View>

      {/* The keyboard: each line's box opens a number pad, which covered the
          lower lines; the scroll insets itself by it on iOS and brings the
          box being typed in into view. */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: space.md, gap: space.md }}
        automaticallyAdjustKeyboardInsets
      >
        {phase.kind === 'review' && phase.photoSignedUrl ? (
          <Image
            source={{ uri: phase.photoSignedUrl }}
            style={[styles.reviewPhoto, { backgroundColor: PHOTO_BACKGROUND, borderColor: c.hair }]}
            resizeMode="cover"
          />
        ) : null}

        {high.length > 0 && (
          <ReviewSection
            title="High confidence"
            subtitle="Tap to override if needed"
            color={c.accent}
            lines={high}
            onOverride={onOverride}
            disabled={saving}
          />
        )}
        {low.length > 0 && (
          <ReviewSection
            title="Low confidence — needs review"
            subtitle="Enter a count to confirm"
            color={c.warnText}
            lines={low}
            onOverride={onOverride}
            disabled={saving}
          />
        )}
        {undetected.length > 0 && (
          <ReviewSection
            title="Not detected"
            subtitle="AI didn't see these — enter manually if needed"
            color={c.ink3}
            lines={undetected}
            onOverride={onOverride}
            disabled={saving}
          />
        )}
      </ScrollView>

      <View style={[styles.reviewFooter, { borderTopColor: c.hair, backgroundColor: c.paper }]}>
        {/* Confirm writes the counts: the screen's one ink button. */}
        <Button block onPress={onConfirm} disabled={saving}>
          {saving ? 'Saving…' : 'Confirm counts'}
        </Button>
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
  const { c } = useTheme();
  return (
    <View style={styles.section}>
      <View style={[styles.sectionAccent, { backgroundColor: color }]} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.sectionTitle, { color: c.ink }]}>{title}</Text>
        <Text style={[styles.sectionSubtitle, { color: c.ink3 }]}>{subtitle}</Text>
        {/* The lines are one hairline card (DESIGN-SPEC 6.7). */}
        <View style={[styles.rows, { backgroundColor: c.card, borderColor: c.hair }]}>
          {lines.map((rl, i) => (
            <ReviewRow
              key={rl.line.id}
              rl={rl}
              first={i === 0}
              onOverride={onOverride}
              disabled={disabled}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

function ReviewRow({
  rl,
  first,
  onOverride,
  disabled,
}: {
  rl: ReviewLine;
  first: boolean;
  onOverride: (lineId: string, next: string | null) => void;
  disabled: boolean;
}) {
  const { c } = useTheme();
  const proposed = rl.result?.count;
  const display = rl.override !== null
    ? rl.override
    : proposed !== undefined
      ? String(proposed)
      : '';
  return (
    <View style={[styles.row, !first && { borderTopWidth: 1, borderTopColor: c.hair }]}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowName, { color: c.ink }]} numberOfLines={2}>
          {rl.line.itemName}
        </Text>
        <Text style={[styles.rowMeta, { color: c.ink3 }]}>
          Expected {rl.line.expected}
          {rl.result ? ` · AI ${(rl.result.confidence * 100).toFixed(0)}%` : ''}
        </Text>
      </View>
      {/* Named for its line, so VoiceOver says which book a count is for (it
          read only the number). A floor, not a width: the typed number grows
          with the text size instead of clipping. */}
      <TextInput
        style={[styles.rowQty, { borderColor: c.hair2, backgroundColor: c.sunk, color: c.ink }]}
        value={display}
        onChangeText={(v) => onOverride(rl.line.id, v)}
        keyboardType="numeric"
        editable={!disabled}
        selectTextOnFocus
        placeholder="—"
        placeholderTextColor={c.ink3}
        accessibilityLabel={`Counted, ${rl.line.itemName}`}
      />
    </View>
  );
}

/** Pinned viewfinder chrome: 14pt Cancel, 16pt screen name. */
const CLOSE_CAP = capTo(14, TYPE_CEILING.chrome);
const TITLE_CAP = capTo(16, TYPE_CEILING.chrome);

/**
 * THE CAMERA CHROME IS DARK IN BOTH MODES, as on the count scanner
 * (app/cycle-count/scan/[id].tsx, whose CAMERA block this one matches). The
 * bars and the viewfinder sit over a live camera, which does not change with
 * the device's mode, so they draw from the dark palette whatever the mode is
 * (DESIGN-SPEC 10: the viewfinder and the reticle are fixed colours). The
 * bars are solid (they were translucent black over the picture), so every
 * word on them reads the same over any scene. The permission screen and the
 * review are ordinary screens and follow the device (`useTheme`).
 */
const CAMERA_PALETTE = palette('dark');
const CAMERA = {
  /** The bars and the ground behind the camera: the reference viewfinder. */
  surface: '#0a0b09',
  ink: CAMERA_PALETTE.ink,
  ink2: CAMERA_PALETTE.ink2,
  ink3: CAMERA_PALETTE.ink3,
  /** A control on the bar: the raised fill with an outline at 3:1. */
  chip: CAMERA_PALETTE.card,
  chipBorder: CAMERA_PALETTE.ink4,
  /** Corner brackets: the reference's dark-mode mint. */
  reticle: CAMERA_PALETTE.accent,
  /** Behind the hint over the live picture, so it reads over a white shelf. */
  scrim: 'rgba(10, 11, 9, 0.72)',
} as const;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: CAMERA.surface },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: space.xl,
  },
  permRoot: { flex: 1 },
  /** The status bar's strip and the bar under it, one solid dark band. */
  barArea: { backgroundColor: CAMERA.surface },
  topBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    padding: space.md,
    alignItems: 'center',
    backgroundColor: CAMERA.surface,
  },
  /** See the scan twin: a FLOOR, so `flexWrap` has something to wrap against. */
  titleCol: { flex: 1, minWidth: 120 },
  // Cancel is a button in a frame at least 44pt tall around the same pill
  // (it was the ~25pt pill). -8 top and bottom leaves a 28pt slot, under the
  // title column's height, so the bar keeps its height; the frame reaches
  // into the bar's 12pt padding.
  closeFrame: { minHeight: 44, minWidth: 44, justifyContent: 'center', marginVertical: -8, flexShrink: 0 },
  closeBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: CAMERA.chipBorder,
    backgroundColor: CAMERA.chip,
    flexShrink: 0,
  },
  closeText: { color: CAMERA.ink, fontFamily: FONT.displaySemi, fontWeight: '600', fontSize: 14 },
  headerLabel: { color: CAMERA.ink, fontFamily: FONT.displaySemi, fontWeight: '600', fontSize: 16 },
  headerSub: { color: CAMERA.ink2, fontFamily: FONT.displayRegular, fontSize: 12, marginTop: 2 },
  viewfinder: { flex: 1, backgroundColor: CAMERA.surface },
  frameWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: space.md,
  },
  // The shelf-row frame it always was (280 x 360), allowed to shrink when the
  // bars grow at the larger text sizes so it never runs under them.
  frame: { width: 280, height: 360, maxWidth: '80%', maxHeight: '75%' },
  corner: { position: 'absolute', width: 26, height: 26, borderColor: CAMERA.reticle },
  cornerTL: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 8 },
  cornerTR: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 8 },
  cornerBL: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 3,
    borderLeftWidth: 3,
    borderBottomLeftRadius: 8,
  },
  cornerBR: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 3,
    borderRightWidth: 3,
    borderBottomRightRadius: 8,
  },
  hintPill: {
    marginHorizontal: space.lg,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: CAMERA.scrim,
  },
  hint: {
    color: CAMERA.ink2,
    fontFamily: FONT.display,
    fontWeight: '500',
    fontSize: 13,
    textAlign: 'center',
  },
  bottomBar: {
    paddingHorizontal: space.lg,
    paddingBottom: space.lg,
    paddingTop: space.md,
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: CAMERA.surface,
  },
  // The shutter: the raised chip fill inside a light ring, a light disc
  // within (it was white on a translucent white).
  captureBtn: {
    width: 78,
    height: 78,
    borderRadius: 39,
    backgroundColor: CAMERA.chip,
    borderWidth: 4,
    borderColor: CAMERA.ink,
    justifyContent: 'center',
    alignItems: 'center',
  },
  captureBtnBusy: { opacity: 0.8 },
  captureBtnInner: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: CAMERA.ink,
  },
  captureCaption: { color: CAMERA.ink2, fontFamily: FONT.display, fontWeight: '500', fontSize: 13 },
  permTitle: {
    fontFamily: FONT.displaySemi,
    fontWeight: '600',
    fontSize: 20,
    marginBottom: space.sm,
    textAlign: 'center',
  },
  permBody: {
    fontFamily: FONT.displayRegular,
    fontSize: 14.5,
    textAlign: 'center',
    marginBottom: space.lg,
  },
  cta: { minWidth: 200 },

  // Review screen
  reviewRoot: { flex: 1 },
  reviewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // "← Back" is a button in a frame at least 44pt tall (it was the ~17pt
  // text). The frame takes the header's 8pt padding above and below, so the
  // header is about 9pt taller, and nothing overlaps.
  reviewBackBtn: { minHeight: 44, minWidth: 44, justifyContent: 'center', marginVertical: -space.sm },
  reviewBack: { fontFamily: FONT.display, fontWeight: '500', fontSize: 14 },
  reviewTitle: { fontFamily: FONT.displaySemi, fontWeight: '600', fontSize: 16 },
  // The shelf photo on the photo ground (white in both modes, DESIGN-SPEC
  // 6.14) with a hairline edge.
  reviewPhoto: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  section: { flexDirection: 'row', gap: space.sm },
  sectionAccent: { width: 4, borderRadius: 2 },
  sectionTitle: { fontFamily: FONT.displaySemi, fontWeight: '600', fontSize: 14 },
  sectionSubtitle: { fontFamily: FONT.displayRegular, fontSize: 12, marginTop: 2 },
  rows: {
    marginTop: space.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.sm,
  },
  rowName: { fontFamily: FONT.display, fontWeight: '500', fontSize: 14 },
  rowMeta: { fontFamily: FONT.displayRegular, fontSize: 12, marginTop: 2 },
  // A 44pt target (the box was about 29pt tall); minHeight and minWidth, so
  // the typed number grows the box instead of clipping.
  rowQty: {
    minHeight: 44,
    minWidth: 70,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
    textAlign: 'center',
    fontFamily: FONT.mono,
    fontSize: 16,
  },
  reviewFooter: {
    padding: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
