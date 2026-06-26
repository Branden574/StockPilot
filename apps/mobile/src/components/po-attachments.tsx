import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as React from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/lib/auth-context';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { resizeForUpload } from '@/lib/image-resize';
import { supabase } from '@/lib/supabase';
import { radius, space, theme } from '@/lib/theme';

const BUCKET = 'po-attachments';

interface AttachmentRow {
  id: string;
  storage_path: string;
  file_name: string | null;
  url: string | null;
}

const MAX_BYTES = 15 * 1024 * 1024; // must match the bucket's file_size_limit (mig 0211)

function mimeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'heic':
    case 'heif':
      return 'image/heic';
    case 'pdf':
      return 'application/pdf';
    default:
      return 'image/jpeg';
  }
}

/**
 * Attach photos (camera or library) to a purchase order from the phone — e.g. a
 * supplier packing slip. All client-side via the RLS-enforced Supabase client:
 * upload to the private po-attachments bucket, then insert the metadata row
 * (RLS gates both on purchase_orders:manage). Mirrors the web PO attachments.
 *
 * Three sources: camera, photo library (both resized), and the Files app
 * (PDFs / images via expo-document-picker, uploaded raw). 15 MB cap, matching
 * the bucket.
 */
export function PoAttachments({ poId }: { poId: string }) {
  const { user } = useAuth();
  const permissions = useEffectivePermissions();
  const canManage = !!permissions && permissions.has('purchase_orders:manage');

  const [orgId, setOrgId] = React.useState<string | null>(null);
  const [items, setItems] = React.useState<AttachmentRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    // The PO's own org (RLS-scoped) — used for the storage path + the insert.
    const { data: po } = await supabase
      .from('purchase_orders')
      .select('organization_id')
      .eq('id', poId)
      .maybeSingle();
    const org = (po?.organization_id as string | undefined) ?? null;
    setOrgId(org);

    const { data: rows } = await supabase
      .from('po_attachments')
      .select('id, storage_path, file_name')
      .eq('purchase_order_id', poId)
      .order('created_at', { ascending: false });
    const list = (rows ?? []) as Array<{ id: string; storage_path: string; file_name: string | null }>;

    const signed = new Map<string, string>();
    if (list.length > 0) {
      const { data: urls } = await supabase.storage
        .from(BUCKET)
        .createSignedUrls(list.map((r) => r.storage_path), 60 * 60);
      for (const u of (urls ?? []) as Array<{ path?: string | null; signedUrl: string }>) {
        if (u.path) signed.set(u.path, u.signedUrl);
      }
    }
    setItems(
      list.map((r) => ({
        id: r.id,
        storage_path: r.storage_path,
        file_name: r.file_name,
        url: signed.get(r.storage_path) ?? null,
      })),
    );
    setLoading(false);
  }, [poId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function uploadAsset(asset: ImagePicker.ImagePickerAsset) {
    if (!orgId || !user) {
      Alert.alert('Not ready', 'Try again in a moment.');
      return;
    }
    setBusy(true);
    try {
      const resized = await resizeForUpload(asset.uri);
      const rand = Math.random().toString(36).slice(2, 14);
      const path = `${orgId}/${poId}/${rand}.${resized.ext}`;
      const arrayBuffer = await (await fetch(resized.uri)).arrayBuffer();
      const contentType = mimeForExt(resized.ext);
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, arrayBuffer, { contentType });
      if (upErr) {
        Alert.alert('Upload failed', upErr.message);
        return;
      }
      const fileName =
        (asset.fileName && asset.fileName.trim()) ||
        `slip-${new Date().toISOString().slice(0, 10)}.${resized.ext}`;
      const { error: rowErr } = await supabase.from('po_attachments').insert({
        organization_id: orgId,
        purchase_order_id: poId,
        storage_path: path,
        file_name: fileName,
        content_type: contentType,
        size_bytes: arrayBuffer.byteLength,
        uploaded_by: user.id,
      });
      if (rowErr) {
        // Roll back the orphaned object if the metadata insert was rejected
        // (e.g. RLS — the user lacks purchase_orders:manage).
        await supabase.storage.from(BUCKET).remove([path]);
        Alert.alert('Could not attach', rowErr.message);
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function takePhoto() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Camera permission needed', 'Enable camera access in Settings to take a photo.');
      return;
    }
    try {
      const res = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 1,
      });
      if (!res.canceled && res.assets[0]) await uploadAsset(res.assets[0]);
    } catch {
      Alert.alert('Camera unavailable', 'Could not open the camera on this device.');
    }
  }

  async function pickFromLibrary() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Photos permission needed', 'Enable photo access in Settings to choose a file.');
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 1,
    });
    if (!res.canceled && res.assets[0]) await uploadAsset(res.assets[0]);
  }

  /** Pick a PDF or image file from the Files app (no resize — raw upload). */
  async function pickDocument() {
    const res = await DocumentPicker.getDocumentAsync({
      type: ['application/pdf', 'image/*'],
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (res.canceled || !res.assets?.[0]) return;
    const asset = res.assets[0];
    if (!orgId || !user) {
      Alert.alert('Not ready', 'Try again in a moment.');
      return;
    }
    if (typeof asset.size === 'number' && asset.size > MAX_BYTES) {
      Alert.alert('File too large', 'Files must be 15 MB or smaller.');
      return;
    }
    setBusy(true);
    try {
      const name = (asset.name && asset.name.trim()) || 'file';
      const ext = (name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
      const rand = Math.random().toString(36).slice(2, 14);
      const path = `${orgId}/${poId}/${rand}.${ext}`;
      const arrayBuffer = await (await fetch(asset.uri)).arrayBuffer();
      const contentType = asset.mimeType || mimeForExt(ext);
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, arrayBuffer, { contentType });
      if (upErr) {
        Alert.alert('Upload failed', upErr.message);
        return;
      }
      const { error: rowErr } = await supabase.from('po_attachments').insert({
        organization_id: orgId,
        purchase_order_id: poId,
        storage_path: path,
        file_name: name,
        content_type: contentType,
        size_bytes: asset.size ?? arrayBuffer.byteLength,
        uploaded_by: user.id,
      });
      if (rowErr) {
        await supabase.storage.from(BUCKET).remove([path]);
        Alert.alert('Could not attach', rowErr.message);
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  function addFile() {
    Alert.alert('Attach a file', 'Add a packing slip, photo, or PDF to this PO.', [
      { text: 'Take Photo', onPress: () => void takePhoto() },
      { text: 'Choose from Library', onPress: () => void pickFromLibrary() },
      { text: 'Choose File (PDF)', onPress: () => void pickDocument() },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  function confirmDelete(row: AttachmentRow) {
    Alert.alert('Remove file?', row.file_name ?? 'This file', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await supabase.storage.from(BUCKET).remove([row.storage_path]);
          await supabase.from('po_attachments').delete().eq('id', row.id);
          await load();
        },
      },
    ]);
  }

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Attachments</Text>
        {canManage && (
          <Pressable
            onPress={addFile}
            disabled={busy}
            style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.7 }]}
          >
            {busy ? (
              <ActivityIndicator color={theme.bg} size="small" />
            ) : (
              <Text style={styles.addBtnText}>＋ Attach</Text>
            )}
          </Pressable>
        )}
      </View>

      {loading ? (
        <ActivityIndicator color={theme.primary} style={{ marginTop: space.sm }} />
      ) : items.length === 0 ? (
        <Text style={styles.muted}>
          {canManage ? 'No files yet. Add a photo or PDF of the packing slip.' : 'No files attached.'}
        </Text>
      ) : (
        items.map((row) => (
          <View key={row.id} style={styles.fileRow}>
            <Pressable
              style={{ flex: 1 }}
              onPress={() => row.url && void Linking.openURL(row.url)}
            >
              <Text style={styles.fileName} numberOfLines={1}>
                📎 {row.file_name ?? 'File'}
              </Text>
            </Pressable>
            {canManage && (
              <Pressable onPress={() => confirmDelete(row)} hitSlop={10}>
                <Text style={styles.delete}>Remove</Text>
              </Pressable>
            )}
          </View>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.bg,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: radius.md,
    padding: space.md,
    marginTop: space.md,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: theme.text, fontSize: 15, fontWeight: '700' },
  addBtn: {
    backgroundColor: theme.text,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    minWidth: 78,
    alignItems: 'center',
  },
  addBtnText: { color: theme.bg, fontWeight: '700', fontSize: 13 },
  muted: { color: theme.textMuted, fontSize: 13, marginTop: space.sm },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: theme.border,
    marginTop: space.sm,
  },
  fileName: { color: theme.text, fontSize: 14 },
  delete: { color: '#c0392b', fontSize: 13, fontWeight: '600' },
});
