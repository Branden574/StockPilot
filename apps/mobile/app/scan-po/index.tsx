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
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { IconChip } from '@/components/ui/row';
import { useAuth } from '@/lib/auth-context';
import { API_BASE } from '@/lib/api';
import { resizeForUpload } from '@/lib/image-resize';
import { supabase } from '@/lib/supabase';
import { radius, space, theme } from '@/lib/theme';

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
 * On success we deep-link to the existing review page on the web —
 * we don't try to render the line-by-line review on mobile (the form
 * is dense and works much better on desktop).
 */
export default function ScanPo() {
  const router = useRouter();
  const { session } = useAuth();
  const [permission, requestPermission] = useCameraPermissions();
  const [frames, setFrames] = React.useState<CapturedFrame[]>([]);
  const [cameraOpen, setCameraOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const cameraRef = React.useRef<CameraView | null>(null);

  // Extraction progress. The scan is one request (upload + Gemini vision, ~6-10s)
  // with no server-streamed progress, so we drive an optimistic bar on elapsed
  // time: ease to ~92% over ~13s, hold there until the response lands, and cycle
  // descriptive stage labels so the user sees roughly where it is.
  const progressAnim = React.useRef(new Animated.Value(0)).current;
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

  function removeFrame(uri: string) {
    setFrames((cur) => cur.filter((f) => f.uri !== uri));
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
      const fd = new FormData();
      for (const f of frames) {
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
            console.warn('[scan-po] frame resize failed, uploading original', e);
          }
        }
        // React Native FormData wants a { uri, name, type } shape.
        fd.append('file', {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          uri,
          name,
          type,
        } as any);
      }
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
      let res: Response;
      try {
        res = await fetch(`${API_BASE}/api/po-imports/scan`, {
          method: 'POST',
          body: fd,
          headers: {
            Authorization: `Bearer ${token}`,
          },
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
      const reviewUrl = `${API_BASE}/dashboard/purchase-orders/imports/${json.id}`;
      Alert.alert(
        'Extracted',
        json.lowConfidenceLines > 0
          ? `${json.lowConfidenceLines} line${json.lowConfidenceLines === 1 ? '' : 's'} need a quick review on the web.`
          : 'Looks clean. Review and approve on the web.',
        [
          {
            text: 'Open in browser',
            onPress: () => Linking.openURL(reviewUrl),
          },
          { text: 'OK', style: 'cancel' },
        ],
      );
      setFrames([]);
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
      <ScrollView contentContainerStyle={{ padding: space.md, paddingBottom: 200 }}>
        <Text style={styles.title}>Scan a PO</Text>
        <Text style={styles.subtitle}>
          Take a photo of a printed purchase order. Up to {MAX_FRAMES} pages —
          we extract vendor, line items, and totals automatically. Review and
          approve on the web.
        </Text>

        <View style={styles.actionRow}>
          <Pressable
            style={({ pressed }) => [
              styles.primaryBtn,
              pressed && { opacity: 0.7 },
            ]}
            onPress={openCamera}
          >
            <Text style={styles.primaryBtnText}>📷  Take photo</Text>
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

        {frames.length > 0 && (
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
              ✨  Extract {frames.length} {frames.length === 1 ? 'page' : 'pages'}
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
