import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as Linking from 'expo-linking';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/lib/auth-context';
import { API_BASE } from '@/lib/api';
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
  const { session } = useAuth();
  const [permission, requestPermission] = useCameraPermissions();
  const [frames, setFrames] = React.useState<CapturedFrame[]>([]);
  const [cameraOpen, setCameraOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const cameraRef = React.useRef<CameraView | null>(null);

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
    try {
      const fd = new FormData();
      for (const f of frames) {
        // React Native FormData wants a { uri, name, type } shape.
        fd.append('file', {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          uri: f.uri,
          name: f.fileName,
          type: f.mimeType,
        } as any);
      }
      const {
        data: { session: fresh },
      } = await supabase.auth.getSession();
      const token = fresh?.access_token ?? session.access_token;

      const res = await fetch(`${API_BASE}/api/po-imports/scan`, {
        method: 'POST',
        body: fd,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        Alert.alert('Scan failed', json.message || `HTTP ${res.status}`);
        return;
      }
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
      Alert.alert('Scan failed', err instanceof Error ? err.message : 'Network error');
    } finally {
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

        {frames.length > 0 && (
          <Pressable
            onPress={submit}
            disabled={busy}
            style={({ pressed }) => [
              styles.extractBtn,
              (pressed || busy) && { opacity: 0.7 },
            ]}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.extractBtnText}>
                ✨  Extract {frames.length} {frames.length === 1 ? 'page' : 'pages'}
              </Text>
            )}
          </Pressable>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
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
});
