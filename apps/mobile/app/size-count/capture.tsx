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
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, API_BASE } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { radius, space, theme } from '@/lib/theme';

const LABELS = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL', 'XXXXXL'] as const;
const COMPRESS_MAX = 1280;
const COMPRESS_QUALITY = 0.85;
const BURST_COUNT = 5;

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
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = React.useRef<CameraView>(null);
  const [busy, setBusy] = React.useState(false); // capturing (blocks the shutter briefly)
  const [burst, setBurst] = React.useState(false);
  const [inFlight, setInFlight] = React.useState(0); // uploads still in progress
  const [failed, setFailed] = React.useState(0);
  const [counts, setCounts] = React.useState<Record<string, number>>({});
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

  // Compress + upload one image, tracking in-flight + success/fail. Not awaited
  // by the shutter, so capture stays snappy.
  const uploadSample = React.useCallback(
    async (uri: string, label: string, isNegative: boolean) => {
      setInFlight((n) => n + 1);
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
      } finally {
        setInFlight((n) => n - 1);
      }
    },
    [],
  );

  // Take one (or a burst of) fast shots; uploads fire in the background.
  const shoot = React.useCallback(
    async (label: string, isNegative: boolean) => {
      if (busy || !cameraRef.current) return;
      setBusy(true);
      try {
        const n = burst ? BURST_COUNT : 1;
        for (let i = 0; i < n; i++) {
          const shot = await cameraRef.current.takePictureAsync({
            quality: 0.7,
            skipProcessing: true, // faster shutter; fine for training frames
          });
          if (shot?.uri) void uploadSample(shot.uri, label, isNegative);
        }
      } catch {
        setFailed((f) => f + 1);
      } finally {
        setBusy(false);
      }
    },
    [busy, burst, uploadSample],
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
      for (const uri of uris) void uploadSample(uri, label, isNegative);
    },
    [importUris, uploadSample],
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

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ headerShown: false }} />
      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />
      <SafeAreaView style={StyleSheet.absoluteFill} edges={['top', 'bottom']} pointerEvents="box-none">
        <View style={styles.topBar} pointerEvents="auto">
          <Pressable onPress={() => router.back()} style={styles.closeBtn}>
            <Text style={styles.closeText}>Done</Text>
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Training capture</Text>
            <Text style={styles.subtitle}>{status}</Text>
          </View>
          <Pressable onPress={() => router.push('/size-count/review' as never)} style={styles.reviewBtn}>
            <Text style={styles.reviewText}>Review</Text>
          </Pressable>
        </View>

        <View style={styles.hintWrap} pointerEvents="none">
          <Text style={styles.hint}>Frame one sticker, then tap its size</Text>
        </View>

        <View style={styles.panel} pointerEvents="auto">
          <View style={styles.toolRow}>
            <Pressable
              onPress={() => setBurst((b) => !b)}
              style={[styles.toolBtn, burst && styles.toolBtnOn]}
            >
              <Text style={[styles.toolLabel, burst && styles.toolLabelOn]}>
                {burst ? `Burst ×${BURST_COUNT}` : 'Burst off'}
              </Text>
            </Pressable>
            <Pressable onPress={pickPhotos} style={styles.toolBtn}>
              <Text style={styles.toolLabel}>Import photos</Text>
            </Pressable>
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sizeRow}>
            {LABELS.map((l) => (
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
            <Text style={styles.sheetBody}>What size are these? They'll all upload with this label.</Text>
            <View style={styles.sheetGrid}>
              {LABELS.map((l) => (
                <Pressable key={l} onPress={() => labelImport(l, false)} style={styles.sheetChip}>
                  <Text style={styles.sheetChipText}>{l}</Text>
                </Pressable>
              ))}
              <Pressable onPress={() => labelImport('NONE', true)} style={[styles.sheetChip, styles.sheetChipNeg]}>
                <Text style={styles.sheetChipText}>Not a sticker</Text>
              </Pressable>
            </View>
            <Pressable onPress={() => setImportUris([])} style={styles.sheetCancel}>
              <Text style={styles.sheetCancelText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

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
  topBar: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingHorizontal: space.md, paddingVertical: space.sm, backgroundColor: 'rgba(0,0,0,0.45)',
  },
  closeBtn: { paddingVertical: 6, paddingHorizontal: 4 },
  closeText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  reviewBtn: {
    paddingVertical: 6, paddingHorizontal: 12, borderRadius: radius.md,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)',
  },
  reviewText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  title: { color: '#fff', fontSize: 16, fontWeight: '700' },
  subtitle: { color: 'rgba(255,255,255,0.85)', fontSize: 12, marginTop: 1 },
  hintWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  hint: {
    color: '#fff', fontSize: 14, fontWeight: '600',
    backgroundColor: 'rgba(0,0,0,0.45)', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 100,
  },
  panel: { paddingHorizontal: space.md, paddingBottom: space.md, gap: space.sm },
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
  sheet: { backgroundColor: theme.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 22, paddingBottom: 36 },
  sheetTitle: { color: theme.text, fontSize: 18, fontWeight: '700' },
  sheetBody: { color: theme.textMuted, fontSize: 13, marginTop: 6 },
  sheetGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginTop: 16 },
  sheetChip: {
    minHeight: 44, paddingHorizontal: 16, borderRadius: radius.md, borderWidth: 1, borderColor: theme.border,
    alignItems: 'center', justifyContent: 'center',
  },
  sheetChipNeg: { borderStyle: 'dashed' },
  sheetChipText: { color: theme.text, fontSize: 15, fontWeight: '700' },
  sheetCancel: { marginTop: 18, alignItems: 'center', paddingVertical: 8 },
  sheetCancelText: { color: theme.textMuted, fontSize: 15, fontWeight: '600' },
});
