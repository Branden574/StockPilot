import { CameraView, useCameraPermissions } from 'expo-camera';
import * as FileSystem from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import { Stack, useRouter } from 'expo-router';
import * as React from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { API_BASE } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { radius, space, theme } from '@/lib/theme';

// The 9 sizes to label + a hard-negative bucket ("not a size sticker").
const LABELS = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL', 'XXXXXL'] as const;
const COMPRESS_MAX = 1280;
const COMPRESS_QUALITY = 0.85;

/**
 * Opt-in training-data capture. Frame a size sticker, tap its size → the frame
 * is captured, labeled, and uploaded to the private training bucket. "Not a
 * sticker" captures a hard negative. This builds the dataset for the on-device
 * detector; it is not everyday counting.
 */
export default function TrainingCaptureScreen() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = React.useRef<CameraView>(null);
  const [busy, setBusy] = React.useState(false);
  const [counts, setCounts] = React.useState<Record<string, number>>({});
  const [lastLabel, setLastLabel] = React.useState<string | null>(null);

  const total = React.useMemo(
    () => Object.values(counts).reduce((a, b) => a + b, 0),
    [counts],
  );

  async function capture(label: string, isNegative: boolean) {
    if (busy || !cameraRef.current) return;
    setBusy(true);
    try {
      const shot = await cameraRef.current.takePictureAsync({ quality: 1, skipProcessing: false });
      if (!shot?.uri) throw new Error('capture failed');
      const compressed = await ImageManipulator.manipulateAsync(
        shot.uri,
        [{ resize: { width: COMPRESS_MAX } }],
        { compress: COMPRESS_QUALITY, format: ImageManipulator.SaveFormat.JPEG },
      );
      const info = await FileSystem.getInfoAsync(compressed.uri, { size: true });
      if (info.exists && typeof info.size === 'number' && info.size > 10 * 1024 * 1024) {
        throw new Error('image too large');
      }
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
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`upload ${res.status}: ${t}`);
      }
      const key = isNegative ? 'NONE' : label;
      setCounts((c) => ({ ...c, [key]: (c[key] ?? 0) + 1 }));
      setLastLabel(key);
    } catch {
      // Non-fatal — capture is idempotent-friendly (just recapture). Keep the
      // flow snappy; a transient failure just means that frame wasn't saved.
      setLastLabel('failed');
    } finally {
      setBusy(false);
    }
  }

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
            onPress={() =>
              permission.canAskAgain ? requestPermission() : Linking.openSettings()
            }
          >
            <Text style={styles.primaryLabel}>
              {permission.canAskAgain ? 'Continue' : 'Open Settings'}
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

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
            <Text style={styles.subtitle}>
              {total} saved{lastLabel ? ` · last: ${lastLabel === 'failed' ? 'retry' : lastLabel}` : ''}
            </Text>
          </View>
        </View>

        <View style={styles.hintWrap} pointerEvents="none">
          <Text style={styles.hint}>Frame one sticker, then tap its size</Text>
        </View>

        <View style={styles.panel} pointerEvents="auto">
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sizeRow}>
            {LABELS.map((l) => (
              <Pressable
                key={l}
                disabled={busy}
                onPress={() => capture(l, false)}
                style={[styles.sizeBtn, busy && styles.dim]}
              >
                <Text style={styles.sizeLabel}>{l}</Text>
                <Text style={styles.sizeSub}>{counts[l] ?? 0}</Text>
              </Pressable>
            ))}
          </ScrollView>
          <Pressable
            disabled={busy}
            onPress={() => capture('NONE', true)}
            style={[styles.negBtn, busy && styles.dim]}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.negLabel}>Not a sticker  ·  {counts.NONE ?? 0}</Text>
            )}
          </Pressable>
        </View>
      </SafeAreaView>
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
  topBar: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingHorizontal: space.md, paddingVertical: space.sm,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  closeBtn: { paddingVertical: 6, paddingHorizontal: 4 },
  closeText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  title: { color: '#fff', fontSize: 16, fontWeight: '700' },
  subtitle: { color: 'rgba(255,255,255,0.8)', fontSize: 12, marginTop: 1 },
  hintWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  hint: {
    color: '#fff', fontSize: 14, fontWeight: '600',
    backgroundColor: 'rgba(0,0,0,0.45)', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 100,
  },
  panel: { paddingHorizontal: space.md, paddingBottom: space.md, gap: space.sm },
  sizeRow: { gap: space.xs, paddingVertical: space.xs },
  sizeBtn: {
    minWidth: 60, minHeight: 60, borderRadius: radius.md,
    backgroundColor: 'rgba(255,255,255,0.92)', alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 10,
  },
  sizeLabel: { color: '#111', fontSize: 16, fontWeight: '800' },
  sizeSub: { color: '#555', fontSize: 11, marginTop: 2 },
  negBtn: {
    minHeight: 48, borderRadius: radius.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)',
    alignItems: 'center', justifyContent: 'center',
  },
  negLabel: { color: '#fff', fontSize: 14, fontWeight: '600' },
  dim: { opacity: 0.5 },
});
