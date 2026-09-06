import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useAnimatedValue,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { IconChip } from '@/components/ui/row';
import { useAuth } from '@/lib/auth-context';
import { API_BASE, orgHeader } from '@/lib/api';
import { scanDocumentPages } from '@/lib/document-scanner';
import { resizeForUpload } from '@/lib/image-resize';
import { postMultipart, type MultipartFilePart } from '@/lib/multipart-upload';
import { buildDisplayNames } from '@/lib/po-scan-display-names';
import { supabase } from '@/lib/supabase';
import { radius, space, theme } from '@/lib/theme';

import { PO_IMPORT_DISPLAY_NAME_MAX } from '@stockpilot/core';

interface CapturedFrame {
  uri: string;
  fileName: string;
  mimeType: string;
}

const MAX_FRAMES = 5;

/**
 * Phone-scanned PO flow. The user takes one or more photos (or picks
 * existing photos / a PDF), and we POST them all to /api/po-imports/scan
 * which runs Gemini Flash extraction and creates a po_imports row.
 *
 * On success we route to the NATIVE review screen (app/po-import/[id]) —
 * parse retry, per-line matching, and the full approve flow all run on
 * device now; the web review page remains available via "Open in browser".
 */
export default function ScanPo() {
  const router = useRouter();
  const { session } = useAuth();
  const [permission, requestPermission] = useCameraPermissions();
  const [frames, setFrames] = React.useState<CapturedFrame[]>([]);
  /**
   * The human name for each capture, INDEX-ALIGNED with `frames` — the same
   * alignment the API's `displayNames` array is defined by (see
   * lib/po-scan-display-names). Index 0 doubles as the single combined-mode
   * field, exactly as it does on web, so a name typed before a second page was
   * added carries over to the first PO instead of vanishing.
   *
   * Deliberately NOT prefilled from the file name: a phone capture is called
   * `image.jpg` or `po-frame-1.jpg`, which is the noise this field replaces.
   */
  const [names, setNames] = React.useState<string[]>([]);
  const [cameraOpen, setCameraOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  // With 2+ captures: true = each file is its OWN PO import (default); false =
  // combine as pages of ONE PO. Ignored for a single capture.
  const [separate, setSeparate] = React.useState(true);
  const cameraRef = React.useRef<CameraView | null>(null);

  // Extraction progress. The scan is one request (upload + Gemini vision, ~6-10s)
  // with no server-streamed progress, so we drive an optimistic bar on elapsed
  // time: ease to ~92% over ~13s, hold there until the response lands, and cycle
  // descriptive stage labels so the user sees roughly where it is.
  const progressAnim = useAnimatedValue(0);
  const [stageLabel, setStageLabel] = React.useState('');
  const stageTimer = React.useRef<ReturnType<typeof setInterval> | null>(null);

  const stopProgress = React.useCallback(() => {
    if (stageTimer.current) {
      clearInterval(stageTimer.current);
      stageTimer.current = null;
    }
    progressAnim.stopAnimation();
  }, [progressAnim]);

  // Clear the interval if the screen unmounts mid-extraction.
  React.useEffect(() => () => stopProgress(), [stopProgress]);

  async function openCamera() {
    if (!permission?.granted) {
      const r = await requestPermission();
      if (!r.granted) {
        Alert.alert(
          'Camera permission needed',
          'Enable camera access in Settings to scan POs.',
        );
        return;
      }
    }
    setCameraOpen(true);
  }

  async function captureFrame() {
    if (!cameraRef.current) return;
    if (frames.length >= MAX_FRAMES) {
      Alert.alert('Limit reached', `Up to ${MAX_FRAMES} frames per scan.`);
      return;
    }
    const photo = await cameraRef.current.takePictureAsync({
      quality: 0.85,
      // Skipping base64 here — we'll read the file later when uploading.
      base64: false,
    });
    if (!photo) return;
    setFrames((cur) => [
      ...cur,
      {
        uri: photo.uri,
        fileName: `po-frame-${cur.length + 1}.jpg`,
        mimeType: 'image/jpeg',
      },
    ]);
  }

  async function pickFromLibrary() {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      selectionLimit: MAX_FRAMES - frames.length,
      quality: 0.85,
    });
    if (res.canceled || !res.assets) return;
    setFrames((cur) => [
      ...cur,
      ...res.assets.map((a, i) => ({
        uri: a.uri,
        fileName: a.fileName ?? `po-pick-${cur.length + i + 1}.jpg`,
        mimeType: a.mimeType ?? 'image/jpeg',
      })),
    ]);
  }

  /**
   * Native document scanner (iOS VisionKit / Android ML Kit) — edge
   * detection + perspective crop, so the AI parser gets a clean flattened
   * page instead of a skewed photo (owner request 2026-07-18). Multi-page
   * scans append one frame per page: the scan endpoint already accepts
   * multiple frames, so no PDF assembly is needed here (unlike
   * po-attachments, which archives the pages as a single document).
   * scanDocumentPages lazy-loads the native module — an old binary without
   * it degrades to a friendly alert, never a crash.
   */
  async function scanCleanDocument() {
    if (frames.length >= MAX_FRAMES) {
      Alert.alert('Limit reached', `Up to ${MAX_FRAMES} frames per scan.`);
      return;
    }
    const result = await scanDocumentPages();
    if (result.status === 'cancelled') return;
    if (result.status === 'unavailable') {
      Alert.alert(
        'Scanner unavailable',
        'Document scanning needs the latest app build. Use Take photo instead.',
      );
      return;
    }
    setFrames((cur) => [
      ...cur,
      ...result.pages.slice(0, MAX_FRAMES - cur.length).map((uri, i) => ({
        uri,
        fileName: `po-scan-${cur.length + i + 1}.jpg`,
        mimeType: 'image/jpeg',
      })),
    ]);
  }

  function removeFrame(uri: string) {
    // Remove BY INDEX so the name at that slot goes with the photo. Filtering
    // the two lists on different criteria is how name 3 ends up on page 2.
    const idx = frames.findIndex((f) => f.uri === uri);
    if (idx < 0) return;
    setFrames((cur) => cur.filter((_, i) => i !== idx));
    setNames((cur) => cur.filter((_, i) => i !== idx));
  }

  function setName(index: number, value: string) {
    setNames((cur) => {
      const next = [...cur];
      // Pad rather than leave holes: a sparse array serializes `null` holes and
      // reads back `undefined`, which the builder would have to special-case.
      for (let i = next.length; i < index; i++) next[i] = '';
      next[index] = value;
      return next;
    });
  }

  /** Both capture lists are cleared together — a stale name must never attach
   *  itself to the NEXT scan's first page. */
  function resetCaptures() {
    setFrames([]);
    setNames([]);
  }

  async function submit() {
    if (frames.length === 0) {
      Alert.alert('Nothing to scan', 'Take at least one photo first.');
      return;
    }
    if (!session) {
      Alert.alert('Not signed in', 'Sign in again and retry.');
      return;
    }
    setBusy(true);

    // Kick off the optimistic progress bar + rotating stage labels.
    const STAGES = [
      'Uploading photos…',
      'Reading the document…',
      'Extracting vendor & line items…',
      'Finishing up…',
    ];
    setStageLabel(STAGES[0]!);
    let si = 0;
    stageTimer.current = setInterval(() => {
      si = Math.min(si + 1, STAGES.length - 1);
      setStageLabel(STAGES[si]!);
    }, 3200);
    progressAnim.setValue(0);
    Animated.timing(progressAnim, {
      toValue: 0.92,
      duration: 13000,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false, // animating width %, not a transform
    }).start();

    try {
      const fileParts: MultipartFilePart[] = [];
      // Frames whose resize failed and were skipped — surfaced to the user
      // rather than silently omitted from the scan.
      const droppedFrames: string[] = [];
      // Indices (into `frames`/`names`) of the frames that SURVIVE to the wire,
      // in send order. The name array is built through this, never through the
      // captured order — a dropped page must take its name with it.
      const sentIndices: number[] = [];
      for (const [frameIndex, f] of frames.entries()) {
        let uri = f.uri;
        let name = f.fileName;
        let type = f.mimeType;
        // Resize image frames before upload. Full-res phone photos (3-5MB each,
        // or a HEIC library pick >8MB) blow past the server's 8MB/file + 24MB
        // total caps on a multi-page scan, getting hard-rejected (413) AFTER the
        // user already waited through the upload. maxEdge 2000 keeps small print
        // legible for OCR. PDFs are passed through untouched (can't client-resize).
        if (f.mimeType.startsWith('image/')) {
          try {
            const resized = await resizeForUpload(f.uri, { maxEdge: 2000, quality: 0.82 });
            uri = resized.uri;
            type = resized.ext === 'png' ? 'image/png' : 'image/jpeg';
            name = f.fileName.replace(/\.[^.]+$/, `.${resized.ext}`);
          } catch (e) {
            // Resize failed. The ORIGINAL is now dangerous to send: the helper
            // buffers the whole body in JS (it cannot stream — see
            // lib/multipart-upload.ts), and an un-resized library pick is
            // 4-12MB, so a multi-frame scan would allocate tens of MB twice
            // before the server rejected it anyway at MAX_BYTES_PER_FILE (8MB,
            // api/po-imports/scan/route.ts:27). Drop the frame instead of
            // risking an on-device OOM for an upload that cannot succeed.
            console.warn('[scan-po] frame resize failed, dropping frame', e);
            droppedFrames.push(f.fileName);
            continue;
          }
        }
        // Repeated 'file' field, one per frame, in capture order — the route
        // reads form.getAll('file') and treats that order as page order.
        fileParts.push({ field: 'file', uri, fileName: name, contentType: type });
        sentIndices.push(frameIndex);
      }
      // Every frame failed to resize: there is nothing safe to send.
      if (fileParts.length === 0) {
        Alert.alert(
          'Could not prepare the photos',
          'None of the captured pages could be processed for upload. Retake them and try again.',
        );
        return;
      }
      // Never let a dropped page pass silently — the user must know the scan
      // covers fewer pages than they captured.
      const droppedSuffix =
        droppedFrames.length > 0
          ? `\n\n${droppedFrames.length} page${droppedFrames.length === 1 ? '' : 's'} could not be processed and ${droppedFrames.length === 1 ? 'was' : 'were'} left out.`
          : '';
      const {
        data: { session: fresh },
      } = await supabase.auth.getSession();
      const token = fresh?.access_token ?? session.access_token;

      // RN fetch has no default timeout — a dead-air / captive-portal stall
      // would leave the promise unsettled and the progress bar stuck at 92%
      // forever. Bound it just past the server's 60s maxDuration so a real
      // hang surfaces as a retryable error instead of an endless spinner.
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 70_000);
      // Only meaningful for 2+ frames; the server treats a single file as
      // combined regardless. Unchanged from before naming shipped.
      const mode = frames.length > 1 && separate ? 'separate' : 'combined';
      // `displayNames` — ONE JSON array entry per IMPORT, built from the files
      // ACTUALLY being sent. `null` means "omit the field", which keeps an
      // unnamed scan byte-identical to the request this screen sent before
      // naming existed (and is exactly what the route's old-client path
      // expects). See lib/po-scan-display-names for the full contract.
      const displayNames = buildDisplayNames({ names, sentIndices, mode });
      let res: Response;
      try {
        res = await postMultipart(`${API_BASE}/api/po-imports/scan`, {
          files: fileParts,
          fields: [
            { name: 'mode', value: mode },
            ...(displayNames
              ? [{ name: 'displayNames', value: JSON.stringify(displayNames) }]
              : []),
          ],
          headers: { Authorization: `Bearer ${token}`, ...(await orgHeader()) },
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      const json = await res.json().catch(() => ({}) as Record<string, unknown>);
      if (!res.ok || !json.ok) {
        // A 429 means the per-minute scan cap was hit — show a clear retry
        // hint even when the body has no message (e.g. an edge/platform 429).
        const msg =
          res.status === 429
            ? (json.message as string) ||
              'Too many scans in a short window. Wait about a minute and try again.'
            : (json.message as string) || `Scan failed (HTTP ${res.status}). Please try again.`;
        Alert.alert('Scan failed', msg);
        return;
      }
      // Snap the bar to 100% so the success feels complete before the alert.
      setStageLabel('Done');
      Animated.timing(progressAnim, {
        toValue: 1,
        duration: 250,
        useNativeDriver: false,
      }).start();

      // Separate mode: N imports created — send the user to the imports list to
      // review/approve each (there's no single detail to open).
      if (json.mode === 'separate' && Array.isArray(json.imports)) {
        const made = (json.imports as unknown[]).length;
        const failedCount = Array.isArray(json.failed) ? (json.failed as unknown[]).length : 0;
        resetCaptures();
        Alert.alert(
          'Imported',
          `${made} import${made === 1 ? '' : 's'} created${
            failedCount > 0 ? ` · ${failedCount} file${failedCount === 1 ? '' : 's'} couldn't be read` : ''
          }. Review and approve each.`,
          [
            { text: 'Review', onPress: () => router.replace('/po-imports') },
            { text: 'Later', style: 'cancel' },
          ],
        );
        return;
      }
      // Native review screen exists now (app/po-import/[id]) — land there by
      // default; the web review page stays one tap away for desk work.
      const importId = String(json.id);
      const reviewUrl = `${API_BASE}/dashboard/purchase-orders/imports/${importId}`;
      Alert.alert(
        'Extracted',
        (json.lowConfidenceLines > 0
          ? `${json.lowConfidenceLines} line${json.lowConfidenceLines === 1 ? '' : 's'} need a quick review.`
          : 'Looks clean. Review and approve the import.') + droppedSuffix,
        [
          {
            text: 'Review now',
            onPress: () =>
              router.replace({ pathname: '/po-import/[id]', params: { id: importId } }),
          },
          {
            text: 'Open in browser',
            onPress: () => Linking.openURL(reviewUrl),
          },
          { text: 'Later', style: 'cancel' },
        ],
      );
      resetCaptures();
    } catch (err) {
      const msg =
        err instanceof Error && err.name === 'AbortError'
          ? 'The scan timed out. Check your connection and try again.'
          : err instanceof Error
            ? err.message
            : 'Network error';
      Alert.alert('Scan failed', msg);
    } finally {
      stopProgress();
      setBusy(false);
    }
  }

  // 2+ captures each becoming their OWN import means each needs its OWN name,
  // so the single field above the buttons gives way to one input per page —
  // the same split the web scan form makes.
  const perFileNames = frames.length > 1 && separate;

  if (cameraOpen) {
    return (
      <SafeAreaView style={styles.cameraRoot} edges={['top']}>
        <CameraView ref={cameraRef} style={styles.camera} facing="back" />
        <View style={styles.cameraOverlay}>
          <Text style={styles.frameCount}>
            {frames.length}/{MAX_FRAMES} captured
          </Text>
          <View style={styles.cameraButtons}>
            <Pressable
              onPress={() => setCameraOpen(false)}
              style={styles.cancelBtn}
            >
              <Text style={styles.cancelBtnText}>Done</Text>
            </Pressable>
            <Pressable
              onPress={captureFrame}
              style={({ pressed }) => [
                styles.shutter,
                pressed && { transform: [{ scale: 0.92 }] },
              ]}
            />
            <View style={{ width: 60 }} />
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.topbar}>
        <IconChip
          icon={ChevronLeft}
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace('/');
          }}
        />
      </View>
      <ScrollView
        contentContainerStyle={{ padding: space.md, paddingBottom: 200 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <Text style={styles.title}>Scan a PO</Text>
        <Text style={styles.subtitle}>
          Take a photo of a printed purchase order. Up to {MAX_FRAMES} pages —
          we extract vendor, line items, and totals automatically, then you
          review and approve right here.
        </Text>

        {!perFileNames && (
          <View style={styles.nameField}>
            <Text style={styles.nameLabel}>PO name</Text>
            <TextInput
              value={names[0] ?? ''}
              onChangeText={(v) => setName(0, v)}
              placeholder="Example: August DC4 Book Order"
              placeholderTextColor={theme.textMuted}
              maxLength={PO_IMPORT_DISPLAY_NAME_MAX}
              editable={!busy}
              autoCapitalize="words"
              returnKeyType="done"
              style={styles.nameInput}
            />
            <Text style={styles.nameHint}>
              Optional — without one it is listed by its file name.
            </Text>
          </View>
        )}

        <View style={styles.actionRow}>
          <Pressable
            style={({ pressed }) => [
              styles.primaryBtn,
              pressed && { opacity: 0.7 },
            ]}
            onPress={scanCleanDocument}
          >
            <Text style={styles.primaryBtnText}>Scan document</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.secondaryBtn,
              pressed && { opacity: 0.7 },
            ]}
            onPress={openCamera}
          >
            <Text style={styles.secondaryBtnText}>Take photo</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.secondaryBtn,
              pressed && { opacity: 0.7 },
            ]}
            onPress={pickFromLibrary}
          >
            <Text style={styles.secondaryBtnText}>From library</Text>
          </Pressable>
        </View>

        {frames.length > 0 &&
          (perFileNames ? (
            // Each capture is its own PO, so each gets its own row + name.
            <View style={styles.frameList}>
              {frames.map((f, i) => (
                <View key={f.uri} style={styles.frameRow}>
                  <Pressable
                    onLongPress={() => removeFrame(f.uri)}
                    style={styles.frameRowThumb}
                  >
                    <Image source={{ uri: f.uri }} style={styles.thumbnailImage} />
                    <View style={styles.thumbnailOverlay}>
                      <Text style={styles.thumbnailHint}>Hold</Text>
                    </View>
                  </Pressable>
                  <View style={styles.frameRowBody}>
                    <Text style={styles.nameLabel}>PO {i + 1} name</Text>
                    <TextInput
                      value={names[i] ?? ''}
                      onChangeText={(v) => setName(i, v)}
                      placeholder="Example: August DC4 Book Order"
                      placeholderTextColor={theme.textMuted}
                      maxLength={PO_IMPORT_DISPLAY_NAME_MAX}
                      editable={!busy}
                      autoCapitalize="words"
                      returnKeyType="done"
                      style={styles.nameInput}
                    />
                  </View>
                </View>
              ))}
              <Text style={styles.nameHint}>
                Names are optional. Hold a photo to remove it.
              </Text>
            </View>
          ) : (
            <View style={styles.thumbnails}>
              {frames.map((f) => (
                <Pressable
                  key={f.uri}
                  onLongPress={() => removeFrame(f.uri)}
                  style={styles.thumbnail}
                >
                  <Image source={{ uri: f.uri }} style={styles.thumbnailImage} />
                  <View style={styles.thumbnailOverlay}>
                    <Text style={styles.thumbnailHint}>Hold to remove</Text>
                  </View>
                </Pressable>
              ))}
            </View>
          ))}

        {frames.length > 1 && !busy && (
          <View style={styles.modeCard}>
            <Text style={styles.modeQuestion}>
              {frames.length} captures — are these…
            </Text>
            <View style={styles.modeRow}>
              <Pressable
                onPress={() => setSeparate(true)}
                style={[styles.modeBtn, separate && styles.modeBtnActive]}
              >
                <Text style={[styles.modeBtnTitle, separate && styles.modeBtnTitleActive]}>
                  Separate POs
                </Text>
                <Text style={styles.modeBtnSub}>Each becomes its own import</Text>
              </Pressable>
              <Pressable
                onPress={() => setSeparate(false)}
                style={[styles.modeBtn, !separate && styles.modeBtnActive]}
              >
                <Text style={[styles.modeBtnTitle, !separate && styles.modeBtnTitleActive]}>
                  One multi-page PO
                </Text>
                <Text style={styles.modeBtnSub}>Combine as pages of one PO</Text>
              </Pressable>
            </View>
          </View>
        )}

        {frames.length > 0 && !busy && (
          <Pressable
            onPress={submit}
            style={({ pressed }) => [
              styles.extractBtn,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text style={styles.extractBtnText}>
              ✨  Extract {frames.length}{' '}
              {frames.length > 1 && separate ? 'POs' : frames.length === 1 ? 'page' : 'pages'}
            </Text>
          </Pressable>
        )}

        {busy && (
          <View style={styles.progressCard}>
            <View style={styles.progressHeaderRow}>
              <ActivityIndicator color={theme.primary} />
              <Text style={styles.progressLabel}>{stageLabel || 'Working…'}</Text>
            </View>
            <View style={styles.progressTrack}>
              <Animated.View
                style={[
                  styles.progressFill,
                  {
                    width: progressAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: ['0%', '100%'],
                    }),
                  },
                ]}
              />
            </View>
            <Text style={styles.progressHint}>
              Extracting with AI — this usually takes a few seconds. Keep the app open.
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  topbar: {
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 4,
    flexDirection: 'row',
    alignItems: 'center',
  },
  cameraRoot: { flex: 1, backgroundColor: '#000' },
  camera: { flex: 1 },
  cameraOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: space.md,
    paddingBottom: space.xl,
    alignItems: 'center',
  },
  frameCount: {
    color: '#fff',
    fontSize: 13,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    marginBottom: space.md,
  },
  cameraButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: space.lg,
  },
  cancelBtn: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.md,
    minWidth: 60,
    alignItems: 'center',
  },
  cancelBtnText: { color: '#fff', fontWeight: '600' },
  shutter: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#fff',
    borderWidth: 4,
    borderColor: 'rgba(255,255,255,0.4)',
  },
  title: { color: theme.text, fontSize: 26, fontWeight: '700' },
  subtitle: {
    color: theme.textMuted,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 6,
    marginBottom: space.lg,
  },
  actionRow: {
    flexDirection: 'row',
    gap: space.sm,
    marginBottom: space.lg,
  },
  primaryBtn: {
    flex: 2,
    backgroundColor: theme.primary,
    paddingVertical: space.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  secondaryBtn: {
    flex: 1,
    backgroundColor: theme.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    paddingVertical: space.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  secondaryBtnText: { color: theme.text, fontSize: 13 },
  thumbnails: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    marginBottom: space.lg,
  },
  thumbnail: {
    width: 100,
    height: 130,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: theme.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  thumbnailImage: { width: '100%', height: '100%' },
  thumbnailOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingVertical: 4,
    alignItems: 'center',
  },
  thumbnailHint: { color: '#fff', fontSize: 10 },
  nameField: { gap: 6, marginBottom: space.lg },
  nameLabel: { color: theme.textMuted, fontSize: 12, fontWeight: '600' },
  nameInput: {
    backgroundColor: theme.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: radius.md,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    color: theme.text,
    fontSize: 15,
  },
  nameHint: { color: theme.textMuted, fontSize: 12, lineHeight: 16 },
  frameList: { gap: space.sm, marginBottom: space.lg },
  frameRow: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  frameRowThumb: {
    width: 56,
    height: 72,
    borderRadius: radius.sm,
    overflow: 'hidden',
    backgroundColor: theme.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  frameRowBody: { flex: 1, gap: 4 },
  modeCard: {
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: radius.md,
    padding: space.sm,
    marginTop: space.sm,
    gap: space.xs,
  },
  modeQuestion: { color: theme.textMuted, fontSize: 12, fontWeight: '600' },
  modeRow: { flexDirection: 'row', gap: space.xs },
  modeBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: radius.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
    gap: 2,
  },
  modeBtnActive: { borderColor: theme.primary, backgroundColor: theme.bg },
  modeBtnTitle: { color: theme.text, fontSize: 13, fontWeight: '700' },
  modeBtnTitleActive: { color: theme.primary },
  modeBtnSub: { color: theme.textMuted, fontSize: 11 },
  extractBtn: {
    backgroundColor: theme.primary,
    paddingVertical: space.md,
    borderRadius: radius.md,
    alignItems: 'center',
    marginTop: space.sm,
  },
  extractBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  progressCard: {
    marginTop: space.md,
    backgroundColor: theme.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.sm,
  },
  progressHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  progressLabel: { color: theme.text, fontSize: 14, fontWeight: '600' },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.border,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: 4, backgroundColor: theme.primary },
  progressHint: { color: theme.textMuted, fontSize: 12 },
});
