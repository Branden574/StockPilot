import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ChevronLeft, Sparkles } from 'lucide-react-native';
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

import { Button } from '@/components/ui/button';
import { IconChip } from '@/components/ui/row';
import { Body, Display } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import { API_BASE, orgHeader } from '@/lib/api';
import { scanDocumentPages } from '@/lib/document-scanner';
import { resizeForUpload } from '@/lib/image-resize';
import { postMultipart, type MultipartFilePart } from '@/lib/multipart-upload';
import { buildDisplayNames } from '@/lib/po-scan-display-names';
import { supabase } from '@/lib/supabase';
import {
  FONT,
  RADIUS,
  SPACE,
  TYPE_CEILING,
  capTo,
  palette,
  type Palette,
  type ThemeMode,
} from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

import { PO_IMPORT_DISPLAY_NAME_MAX } from '@stockpilot/core';

interface CapturedFrame {
  uri: string;
  fileName: string;
  mimeType: string;
}

const MAX_FRAMES = 5;

/**
 * A captured page is removed by holding it ("Hold to remove"). VoiceOver and
 * TalkBack offer the same removal as an action named Remove, since a hold is
 * a gesture they never announce.
 */
const REMOVE_PAGE_ACTIONS = [{ name: 'remove', label: 'Remove' }];

/**
 * The captures after adding `incoming`, never more than `max`: a source that
 * returns more than the slots left keeps only as many as fit, in order. The
 * scan route refuses a request of more than five files outright, after the
 * whole upload, so a capture past the limit must never be kept.
 */
function appendFrames<T>(cur: T[], incoming: T[], max: number): T[] {
  return [...cur, ...incoming.slice(0, Math.max(0, max - cur.length))];
}

/**
 * Phone-scanned PO flow. The user takes one or more photos (or picks
 * existing photos / a PDF), and we POST them all to /api/po-imports/scan
 * which runs Gemini Flash extraction and creates a po_imports row.
 *
 * On success we route to the NATIVE review screen (app/po-import/[id]) —
 * parse retry, per-line matching, and the full approve flow all run on
 * device now; the web review page remains available via "Open in browser".
 *
 * Drawn in the device's mode; the camera's chrome is dark in both (CAMERA,
 * below). It was on the light-only legacy theme and stayed light in dark mode.
 */
export default function ScanPo() {
  const router = useRouter();
  const { session } = useAuth();
  const { c, mode: themeMode } = useTheme();
  const styles = SCAN_PO_STYLES[themeMode];
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
  // Which name box has focus (its border deepens to ink, as the shared
  // Field's does), or null.
  const [focusedName, setFocusedName] = React.useState<number | null>(null);
  const [cameraOpen, setCameraOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  // With 2+ captures: true = each file is its OWN PO import (default); false =
  // combine as pages of ONE PO. Ignored for a single capture.
  const [separate, setSeparate] = React.useState(true);
  const cameraRef = React.useRef<CameraView | null>(null);
  // One photo at a time: a second tap on the shutter while the first photo
  // was still being taken read the old count, passed the limit check and
  // could add a sixth page, which the server refuses for the whole scan.
  const capturingRef = React.useRef(false);
  // Synchronous re-entry guard for Extract: a quick second tap fired before
  // the button went away sent the same pages twice (two extractions).
  const submittingRef = React.useRef(false);

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
        Alert.alert('Camera permission needed', 'Enable camera access in Settings to scan POs.');
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
    if (capturingRef.current) return;
    capturingRef.current = true;
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.85,
        // Skipping base64 here — we'll read the file later when uploading.
        base64: false,
      });
      if (!photo) return;
      setFrames((cur) =>
        appendFrames(
          cur,
          [
            {
              uri: photo.uri,
              fileName: `po-frame-${cur.length + 1}.jpg`,
              mimeType: 'image/jpeg',
            },
          ],
          MAX_FRAMES,
        ),
      );
    } catch (e) {
      // The camera could not take this one (not ready yet): the shutter is
      // there for another try. It used to escape as an unhandled rejection.
      console.warn('[scan-po] capture failed', e instanceof Error ? e.message : e);
    } finally {
      capturingRef.current = false;
    }
  }

  async function pickFromLibrary() {
    // With every slot taken there is nothing to pick: the picker reads a
    // selection limit of 0 as no limit at all, so it offered the whole
    // library and the scan went past the five pages the server takes.
    if (frames.length >= MAX_FRAMES) {
      Alert.alert('Limit reached', `Up to ${MAX_FRAMES} frames per scan.`);
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      selectionLimit: MAX_FRAMES - frames.length,
      quality: 0.85,
    });
    if (res.canceled || !res.assets) return;
    const assets = res.assets;
    setFrames((cur) =>
      appendFrames(
        cur,
        assets.map((a, i) => ({
          uri: a.uri,
          fileName: a.fileName ?? `po-pick-${cur.length + i + 1}.jpg`,
          mimeType: a.mimeType ?? 'image/jpeg',
        })),
        MAX_FRAMES,
      ),
    );
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
    setFrames((cur) =>
      appendFrames(
        cur,
        result.pages.map((uri, i) => ({
          uri,
          fileName: `po-scan-${cur.length + i + 1}.jpg`,
          mimeType: 'image/jpeg',
        })),
        MAX_FRAMES,
      ),
    );
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
    // Checked and set synchronously, before the button re-renders away.
    if (submittingRef.current) return;
    submittingRef.current = true;
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
            failedCount > 0
              ? ` · ${failedCount} file${failedCount === 1 ? '' : 's'} couldn't be read`
              : ''
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
      submittingRef.current = false;
    }
  }

  // 2+ captures each becoming their OWN import means each needs its OWN name,
  // so the single field above the buttons gives way to one input per page —
  // the same split the web scan form makes.
  const perFileNames = frames.length > 1 && separate;

  if (cameraOpen) {
    return (
      // THE CAMERA CHROME IS DARK IN BOTH MODES (CAMERA, below): a solid bar
      // over the camera with Done and the count, and the shutter under it.
      <View style={cameraStyles.root}>
        {/* Light clock and battery over the dark bar (they were dark text on
            the black camera ground in light mode). */}
        <StatusBar style="light" />
        <SafeAreaView edges={['top']} style={cameraStyles.bar}>
          <View style={cameraStyles.barRow}>
            <Pressable
              onPress={() => setCameraOpen(false)}
              accessibilityRole="button"
              accessibilityLabel="Done"
              style={({ pressed }) => [cameraStyles.closeFrame, pressed && { opacity: 0.7 }]}
            >
              <View style={cameraStyles.closeBtn}>
                <Text
                  style={cameraStyles.closeText}
                  numberOfLines={1}
                  maxFontSizeMultiplier={CLOSE_CAP}
                >
                  Done
                </Text>
              </View>
            </Pressable>
            <Text style={cameraStyles.frameCount}>
              {frames.length}/{MAX_FRAMES} captured
            </Text>
          </View>
        </SafeAreaView>
        <CameraView ref={cameraRef} style={cameraStyles.camera} facing="back" />
        <SafeAreaView edges={['bottom']} style={cameraStyles.shutterBar}>
          {/* The shutter had no name for VoiceOver: it takes the photo. */}
          <Pressable
            onPress={captureFrame}
            accessibilityRole="button"
            accessibilityLabel="Take photo"
            style={({ pressed }) => [
              cameraStyles.shutter,
              pressed && { transform: [{ scale: 0.92 }] },
            ]}
          />
        </SafeAreaView>
      </View>
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
          accessibilityLabel="Back"
          minTap
        />
      </View>
      {/* A name box low on the page scrolls clear of the keyboard. */}
      <ScrollView
        contentContainerStyle={{ padding: SPACE.md, paddingBottom: 200 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
      >
        <Display size={28} accessibilityRole="header">
          Scan a PO
        </Display>
        <Body muted size={13.5} style={styles.subtitle}>
          Take a photo of a printed purchase order. Up to {MAX_FRAMES} pages — we extract vendor,
          line items, and totals automatically, then you review and approve right here.
        </Body>

        {!perFileNames && (
          <View style={styles.nameField}>
            <Text style={styles.nameLabel}>PO name</Text>
            <TextInput
              value={names[0] ?? ''}
              onChangeText={(v) => setName(0, v)}
              placeholder="Example: August Restock Order"
              placeholderTextColor={c.ink3}
              maxLength={PO_IMPORT_DISPLAY_NAME_MAX}
              editable={!busy}
              autoCapitalize="words"
              returnKeyType="done"
              accessibilityLabel="PO name"
              onFocus={() => setFocusedName(0)}
              onBlur={() => setFocusedName((f) => (f === 0 ? null : f))}
              style={[styles.nameInput, focusedName === 0 && styles.nameInputFocused]}
            />
            <Text style={styles.nameHint}>
              Optional — without one it is listed by its file name.
            </Text>
          </View>
        )}

        {/* One full-width button under another at every text size: side by
            side, "From library" and "Take photo" lost their words to an
            ellipsis. Scan document stays the lead (the accent: it starts a
            new scan); Extract below is the one ink button, which commits. */}
        <View style={styles.actions}>
          <Button variant="accent" block onPress={scanCleanDocument}>
            Scan document
          </Button>
          <Button variant="outline" block onPress={openCamera}>
            Take photo
          </Button>
          <Button variant="outline" block onPress={pickFromLibrary}>
            From library
          </Button>
        </View>

        {frames.length > 0 &&
          (perFileNames ? (
            // Each capture is its own PO, so each gets its own row + name.
            <View style={styles.frameList}>
              {frames.map((f, i) => (
                <View key={f.uri} style={styles.frameRow}>
                  <Pressable
                    onLongPress={() => removeFrame(f.uri)}
                    accessibilityActions={REMOVE_PAGE_ACTIONS}
                    onAccessibilityAction={(e) => {
                      if (e.nativeEvent.actionName === 'remove') removeFrame(f.uri);
                    }}
                    style={styles.frameRowThumb}
                  >
                    <Image source={{ uri: f.uri }} style={styles.thumbnailImage} />
                    <View style={styles.thumbnailOverlay}>
                      <Text style={styles.thumbnailHint} maxFontSizeMultiplier={HINT_CAP}>
                        Hold
                      </Text>
                    </View>
                  </Pressable>
                  <View style={styles.frameRowBody}>
                    <Text style={styles.nameLabel}>PO {i + 1} name</Text>
                    <TextInput
                      value={names[i] ?? ''}
                      onChangeText={(v) => setName(i, v)}
                      placeholder="Example: August Restock Order"
                      placeholderTextColor={c.ink3}
                      maxLength={PO_IMPORT_DISPLAY_NAME_MAX}
                      editable={!busy}
                      autoCapitalize="words"
                      returnKeyType="done"
                      accessibilityLabel={`PO ${i + 1} name`}
                      onFocus={() => setFocusedName(i)}
                      onBlur={() => setFocusedName((cur) => (cur === i ? null : cur))}
                      style={[styles.nameInput, focusedName === i && styles.nameInputFocused]}
                    />
                  </View>
                </View>
              ))}
              <Text style={styles.nameHint}>Names are optional. Hold a photo to remove it.</Text>
            </View>
          ) : (
            <View style={styles.thumbnails}>
              {frames.map((f) => (
                <Pressable
                  key={f.uri}
                  onLongPress={() => removeFrame(f.uri)}
                  accessibilityActions={REMOVE_PAGE_ACTIONS}
                  onAccessibilityAction={(e) => {
                    if (e.nativeEvent.actionName === 'remove') removeFrame(f.uri);
                  }}
                  style={styles.thumbnail}
                >
                  <Image source={{ uri: f.uri }} style={styles.thumbnailImage} />
                  <View style={styles.thumbnailOverlay}>
                    <Text style={styles.thumbnailHint} maxFontSizeMultiplier={HINT_CAP}>
                      Hold to remove
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          ))}

        {frames.length > 1 && !busy && (
          <View style={styles.modeCard}>
            <Text style={styles.modeQuestion}>{frames.length} captures — are these…</Text>
            {/* Two choices, one of them on: radio buttons to VoiceOver, with
                the chosen one checked (they were two unnamed elements). */}
            <View style={styles.modeRow} accessibilityRole="radiogroup">
              <Pressable
                onPress={() => setSeparate(true)}
                accessibilityRole="radio"
                accessibilityState={{ checked: separate }}
                style={[styles.modeBtn, separate && styles.modeBtnActive]}
              >
                <Text style={styles.modeBtnTitle}>Separate POs</Text>
                <Text style={styles.modeBtnSub}>Each becomes its own import</Text>
              </Pressable>
              <Pressable
                onPress={() => setSeparate(false)}
                accessibilityRole="radio"
                accessibilityState={{ checked: !separate }}
                style={[styles.modeBtn, !separate && styles.modeBtnActive]}
              >
                <Text style={styles.modeBtnTitle}>One multi-page PO</Text>
                <Text style={styles.modeBtnSub}>Combine as pages of one PO</Text>
              </Pressable>
            </View>
          </View>
        )}

        {frames.length > 0 && !busy && (
          // Committing the pages: the screen's one ink button. The sparkle
          // emoji in the words became an icon beside them.
          <Button
            block
            onPress={submit}
            style={styles.extractBtn}
            leading={<Sparkles size={16} color={c.paper} strokeWidth={1.75} />}
          >
            Extract {frames.length}{' '}
            {frames.length > 1 && separate ? 'POs' : frames.length === 1 ? 'page' : 'pages'}
          </Button>
        )}

        {busy && (
          <View style={styles.progressCard}>
            <View style={styles.progressHeaderRow}>
              <ActivityIndicator color={c.ink} />
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

/**
 * THE CAMERA CHROME IS DARK IN BOTH MODES. The bar and the ground behind the
 * camera draw from the dark palette whatever the mode is: the same camera as
 * the Scan tab and the count scanner (DESIGN-SPEC 10).
 */
const CAMERA_PALETTE = palette('dark');
const CAMERA = {
  /** The bar and the ground behind the camera: the reference viewfinder. */
  surface: '#0a0b09',
  ink: CAMERA_PALETTE.ink,
  ink2: CAMERA_PALETTE.ink2,
  /** A control on the bar: the raised fill with an outline at 3:1. */
  chip: CAMERA_PALETTE.card,
  chipBorder: CAMERA_PALETTE.ink4,
  /** The shutter: white in both modes, the camera's own control, ringed in
   *  the faint ink (the old ring was white at 40% over this ground). */
  shutter: '#ffffff',
  shutterRing: CAMERA_PALETTE.ink4,
} as const;

/** Done sits on the camera bar: chrome, capped at its ceiling. */
const CLOSE_CAP = capTo(13, TYPE_CEILING.chrome);

/**
 * "Hold" and "Hold to remove" sit inside a page's fixed photo frame (56 and
 * 100pt wide): chrome, capped at its ceiling. Uncapped, "Hold" broke mid-word
 * in the 56pt frame from the larger accessibility sizes, and the longer hint
 * covered the whole page.
 */
const HINT_CAP = capTo(10.5, TYPE_CEILING.chrome);

/**
 * Behind the words over a captured page ("Hold to remove"): the camera's
 * scrim, so the words read the same over a white page or a dark one, in both
 * modes. It sits over a photo, which does not change with the mode.
 */
const PHOTO_SCRIM = 'rgba(10, 11, 9, 0.72)';

/** The screen's styles for one mode's palette, built once per mode at load. */
function makeStyles(c: Palette) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.paper },
    // The back chip's 44pt frame (IconChip minTap) is 3pt wider than the 38pt
    // chip on every side, so the bar takes 3pt off each padding (12, 8, 4): the
    // chip and the page under it sit where they did.
    topbar: {
      paddingHorizontal: 9,
      paddingTop: 5,
      paddingBottom: 1,
      flexDirection: 'row',
      alignItems: 'center',
    },
    subtitle: { marginTop: 8, marginBottom: SPACE.lg },
    actions: { gap: SPACE.sm, marginBottom: SPACE.lg },
    thumbnails: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: SPACE.sm,
      marginBottom: SPACE.lg,
    },
    thumbnail: {
      width: 100,
      height: 130,
      borderRadius: RADIUS.card,
      overflow: 'hidden',
      backgroundColor: c.card,
      borderWidth: 1,
      borderColor: c.hair,
    },
    thumbnailImage: { width: '100%', height: '100%' },
    thumbnailOverlay: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: PHOTO_SCRIM,
      paddingVertical: 4,
      alignItems: 'center',
    },
    thumbnailHint: { color: CAMERA.ink, fontFamily: FONT.display, fontSize: 10.5 },
    nameField: { gap: 6, marginBottom: SPACE.lg },
    nameLabel: { color: c.ink3, fontFamily: FONT.display, fontSize: 12.5 },
    // The shared Field's box: the card fill, the stronger border that deepens
    // to ink on focus. The typed name grows with the text size, as before.
    nameInput: {
      backgroundColor: c.card,
      borderWidth: 1,
      borderColor: c.hair2,
      borderRadius: RADIUS.tile,
      paddingHorizontal: SPACE.md,
      paddingVertical: SPACE.sm,
      minHeight: 44,
      color: c.ink,
      fontFamily: FONT.displayRegular,
      fontSize: 15,
    },
    nameInputFocused: { borderColor: c.ink },
    nameHint: { color: c.ink3, fontFamily: FONT.displayRegular, fontSize: 12.5, lineHeight: 17 },
    frameList: { gap: SPACE.sm, marginBottom: SPACE.lg },
    frameRow: { flexDirection: 'row', gap: SPACE.sm, alignItems: 'center' },
    frameRowThumb: {
      width: 56,
      height: 72,
      borderRadius: RADIUS.tile,
      overflow: 'hidden',
      backgroundColor: c.card,
      borderWidth: 1,
      borderColor: c.hair,
    },
    frameRowBody: { flex: 1, gap: 4 },
    modeCard: {
      backgroundColor: c.card,
      borderWidth: 1,
      borderColor: c.hair,
      borderRadius: RADIUS.card,
      padding: SPACE.sm,
      marginTop: SPACE.sm,
      gap: SPACE.xs,
    },
    modeQuestion: { color: c.ink3, fontFamily: FONT.display, fontSize: 12.5 },
    modeRow: { flexDirection: 'row', gap: SPACE.xs },
    modeBtn: {
      flex: 1,
      minHeight: 44,
      borderWidth: 1,
      borderColor: c.hair2,
      borderRadius: RADIUS.tile,
      paddingVertical: SPACE.sm,
      paddingHorizontal: SPACE.sm,
      gap: 2,
    },
    // The chosen one: the accent edge on the accent wash (DESIGN-SPEC 6.21's
    // selected row), so it does not rest on the words' colour.
    modeBtnActive: { borderColor: c.accent, backgroundColor: c.accentWash },
    modeBtnTitle: { color: c.ink, fontFamily: FONT.display, fontSize: 13.5 },
    modeBtnSub: { color: c.ink3, fontFamily: FONT.displayRegular, fontSize: 12 },
    extractBtn: { marginTop: SPACE.sm },
    progressCard: {
      marginTop: SPACE.md,
      backgroundColor: c.card,
      borderWidth: 1,
      borderColor: c.hair,
      borderRadius: RADIUS.card,
      padding: SPACE.md,
      gap: SPACE.sm,
    },
    progressHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
    progressLabel: { color: c.ink, fontFamily: FONT.display, fontSize: 14, flexShrink: 1 },
    // The reference's 4pt progress bar: the accent on the stronger-border track.
    progressTrack: {
      height: 4,
      borderRadius: 2,
      backgroundColor: c.hair2,
      overflow: 'hidden',
    },
    progressFill: { height: '100%', borderRadius: 2, backgroundColor: c.accent },
    progressHint: {
      color: c.ink3,
      fontFamily: FONT.displayRegular,
      fontSize: 12.5,
      lineHeight: 17,
    },
  });
}

const SCAN_PO_STYLES: Record<ThemeMode, ReturnType<typeof makeStyles>> = {
  light: makeStyles(palette('light')),
  dark: makeStyles(palette('dark')),
};

const cameraStyles = StyleSheet.create({
  root: { flex: 1, backgroundColor: CAMERA.surface },
  bar: { backgroundColor: CAMERA.surface },
  barRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACE.md,
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.xs,
  },
  // Done is a button in a frame at least 44pt tall around the pill.
  closeFrame: { minHeight: 44, minWidth: 44, justifyContent: 'center' },
  closeBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: CAMERA.chipBorder,
    backgroundColor: CAMERA.chip,
  },
  closeText: { color: CAMERA.ink, fontFamily: FONT.displaySemi, fontWeight: '600', fontSize: 13 },
  // The live tally of pages: content, so it grows with the text size.
  frameCount: { color: CAMERA.ink2, fontFamily: FONT.mono, fontSize: 13, flexShrink: 1 },
  camera: { flex: 1 },
  shutterBar: {
    backgroundColor: CAMERA.surface,
    alignItems: 'center',
    paddingTop: SPACE.md,
    paddingBottom: SPACE.md,
  },
  shutter: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: CAMERA.shutter,
    borderWidth: 4,
    borderColor: CAMERA.shutterRing,
  },
});
