import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as React from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { isManagerOrAbove, type Role } from '@stockpilot/core';

import { ScannerTip } from '@/components/scanner-tip';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import {
  PdfTooLargeError,
  assemblePdf,
  routeScannedPages,
  scanDocumentPages,
  scanFileName,
} from '@/lib/document-scanner';
import { extractApiErrorMessage } from '@/lib/po-import-approve';
import { hasSeenScanTip, markScanTipSeen } from '@/lib/scanner-tip-flag';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { resizeForUpload } from '@/lib/image-resize';
import { fileSizeOf, uploadFileToBucket } from '@/lib/storage-upload';
import { supabase } from '@/lib/supabase';
import { radius, space, theme } from '@/lib/theme';
import { useWorkspace } from '@/lib/use-workspace';

const BUCKET = 'po-attachments';

interface AttachmentRow {
  id: string;
  storage_path: string;
  file_name: string | null;
  url: string | null;
}

const MAX_BYTES = 15 * 1024 * 1024; // must match the bucket's file_size_limit (mig 0211)

/**
 * Extension for the storage object's filename, derived from the picked file's
 * name. Sanitised to lowercase alphanumerics AND bounded to 10 characters,
 * falling back to 'bin'.
 *
 * The bound is not cosmetic. Since SP-018 the row is recorded by the server,
 * whose positive path shape (lib/storage-path.ts OBJECT_FILENAME_SEGMENT)
 * accepts an extension of 1-10 alphanumerics — so a file named `scan.#$%`
 * (sanitises to an EMPTY extension, path ending in a bare '.') or
 * `notes.verylongextension` would upload fine and then be refused at
 * finalize, leaving the user with a failed attach for a perfectly good file.
 * The real content type is settled server-side by the byte sniff regardless
 * of what this says.
 */
function safeExt(fileName: string): string {
  const raw = (fileName.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return raw.length > 0 && raw.length <= 10 ? raw : 'bin';
}

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
 * supplier packing slip. Two steps, exactly like the web panel: PUT the bytes
 * into the private po-attachments bucket (RLS-enforced signed-URL upload),
 * then FINALIZE on the server via POST /api/v1/purchase-orders/[id]/
 * attachments, which is the Bearer twin of `addPoAttachmentAction` and the
 * only path that byte-verifies the object before recording the row (SP-018 —
 * see uploadToPo). Mirrors the web PO attachments.
 *
 * Four sources: camera, photo library (both resized), the Files app
 * (PDFs / images via expo-document-picker, uploaded raw), and the native
 * document scanner (1 page → image, 2+ pages → one PDF). 15 MB cap, matching
 * the bucket.
 */
export function PoAttachments({ poId }: { poId: string }) {
  const { user } = useAuth();
  const { activeRole } = useWorkspace();
  const permissions = useEffectivePermissions();
  // When the effective permission set is loaded, trust it (it reflects org
  // overrides). Until it loads (e.g. a freshly-launched build before its first
  // snapshot sync), fall back to the role so managers/admins/owners can attach
  // immediately instead of seeing no button. Mirrors the web `can()` fallback.
  const canManage = permissions
    ? permissions.has('purchase_orders:manage')
    : isManagerOrAbove((activeRole ?? 'viewer') as Role);

  const [orgId, setOrgId] = React.useState<string | null>(null);
  const [items, setItems] = React.useState<AttachmentRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  /** Real transported percentage for the active upload, or null when idle.
   *  Never synthesised — see lib/storage-upload.ts. Held at 99 until the
   *  metadata row is in too, so the bar can't read done while it isn't. */
  const [uploadPercent, setUploadPercent] = React.useState<number | null>(null);
  const [tipVisible, setTipVisible] = React.useState(false);
  // Resolver for the pending scan tap while the one-time tip is up. Resolving
  // true lets that SAME tap continue into the scanner (no second tap needed).
  const tipResolveRef = React.useRef<((proceed: boolean) => void) | null>(null);

  const load = React.useCallback(async () => {
    // The PO's own org (RLS-scoped) — used for the storage path + the insert.
    const { data: po } = await supabase
      .from('purchase_orders')
      .select('organization_id')
      .eq('id', poId)
      .maybeSingle();
    const org = (po?.organization_id as string | undefined) ?? null;
    setOrgId(org);

    const { data: rows, error: rowsErr } = await supabase
      .from('po_attachments')
      .select('id, storage_path, file_name')
      .eq('purchase_order_id', poId)
      .order('created_at', { ascending: false });
    // A failed read must NOT masquerade as the "No files attached." empty
    // state (that hid a real outage as "there are no files" — undebuggable
    // from a user report). Surface it distinctly instead.
    setLoadError(rowsErr ? rowsErr.message : null);
    const list = (rows ?? []) as { id: string; storage_path: string; file_name: string | null }[];

    const signed = new Map<string, string>();
    if (list.length > 0) {
      const { data: urls } = await supabase.storage
        .from(BUCKET)
        .createSignedUrls(list.map((r) => r.storage_path), 60 * 60);
      for (const u of (urls ?? []) as { path?: string | null; signedUrl: string }[]) {
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: every set is post-await; the effect synchronizes with the server
    void load();
  }, [load]);

  /**
   * Core upload shared by every attach source (camera, library, Files app,
   * document scanner): storage object first, then the server finalize that
   * records the po_attachments row. Rolls the orphaned object back if the
   * finalize is refused (e.g. the user lacks purchase_orders:manage, or the
   * server's byte scan rejects the file). The bytes stream straight off disk
   * via lib/storage-upload's native createUploadTask (signed-URL PUT, same
   * RLS insert gate enforced at mint) — which also retires this call site's
   * fetch('file://').arrayBuffer() and gives REAL upload progress. Callers
   * own the busy state.
   */
  async function uploadToPo(file: {
    uri: string;
    ext: string;
    fileName: string;
    contentType?: string;
    sizeBytes?: number;
  }) {
    if (!orgId || !user) {
      Alert.alert('Not ready', 'Try again in a moment.');
      return;
    }
    const rand = Math.random().toString(36).slice(2, 14);
    const path = `${orgId}/${poId}/${rand}.${file.ext}`;
    const contentType = file.contentType ?? mimeForExt(file.ext);
    // Size read from the filesystem (the streaming route never holds the
    // bytes, so there is no byteLength to fall back on anymore).
    const sizeBytes = file.sizeBytes ?? (await fileSizeOf(file.uri));
    setUploadPercent(0);
    try {
      const up = await uploadFileToBucket({
        bucket: BUCKET,
        path,
        fileUri: file.uri,
        contentType,
        // Floor + hold at 99: 100 is claimed only by genuine completion of
        // the upload AND the server finalize, never by rounding.
        onProgress: (fraction) => setUploadPercent(Math.min(99, Math.floor(fraction * 100))),
      });
      if (!up.ok) {
        Alert.alert('Upload failed', up.error);
        return;
      }
      // ═══ FINALIZE ON THE SERVER, NEVER STRAIGHT INTO POSTGREST (SP-018) ═══
      //
      // This used to insert the po_attachments row itself. Going straight to
      // PostgREST skipped PoAttachmentsService.add() →
      // verifyStoredDocumentOrDelete(), which sniffs the object's REAL magic
      // bytes AND scans it for active content (a genuine PDF carrying
      // /OpenAction /Launch passes any client-side magic-byte check — that is
      // precisely why the scan lives on the server), deleting the object on
      // failure. So a file attached from a phone was never scanned, and
      // `contentType` — the client's word, taken raw from
      // `asset.mimeType` in pickDocument — was what the row recorded and what
      // every downstream reader trusted: the web panel signs it for the whole
      // org and api/purchase-orders/[id]/attachments.zip bundles it.
      //
      // The route below is the Bearer twin of the web `addPoAttachmentAction`,
      // so both surfaces now run the same gate and the row records the SNIFFED
      // mime. `contentType` is still sent for parity, but the server ignores
      // the claim.
      //
      // The storage rollback below is kept on purpose: the server removes the
      // object itself when the SNIFF fails, but every other refusal
      // (purchase_orders:manage revoked, a wrong path shape, the PO not in
      // this org) would otherwise strand the bytes in the bucket. A double
      // remove is harmless; a missing one is a leak.
      //
      // NOT changed here: the `authenticated` INSERT policy on po_attachments
      // (0211) stays until the old-binary OTA audience has moved — those
      // builds still insert directly, and revoking it now would break them.
      // Same shape in apps/mobile/app/order/[id].tsx (order_request_attachments);
      // the mobile item_images inserts are still on the old path.
      try {
        await api(`/api/v1/purchase-orders/${poId}/attachments`, {
          method: 'POST',
          body: {
            storagePath: path,
            fileName: file.fileName,
            contentType,
            sizeBytes,
          },
        });
      } catch (e) {
        await supabase.storage.from(BUCKET).remove([path]);
        Alert.alert(
          'Could not attach',
          extractApiErrorMessage(e, 'That file was refused. Please try a different one.'),
        );
        return;
      }
      await load();
    } finally {
      setUploadPercent(null);
    }
  }

  async function uploadAsset(asset: ImagePicker.ImagePickerAsset) {
    setBusy(true);
    try {
      const resized = await resizeForUpload(asset.uri);
      const fileName =
        (asset.fileName && asset.fileName.trim()) ||
        `slip-${new Date().toISOString().slice(0, 10)}.${resized.ext}`;
      await uploadToPo({ uri: resized.uri, ext: resized.ext, fileName });
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
    if (typeof asset.size === 'number' && asset.size > MAX_BYTES) {
      Alert.alert('File too large', 'Files must be 15 MB or smaller.');
      return;
    }
    setBusy(true);
    try {
      const name = (asset.name && asset.name.trim()) || 'file';
      const ext = safeExt(name);
      await uploadToPo({
        uri: asset.uri,
        ext,
        fileName: name,
        contentType: asset.mimeType || mimeForExt(ext),
        sizeBytes: asset.size ?? undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  /**
   * One-time scanner tip gate. Resolves true immediately once the tip has
   * been seen (zero friction on every later tap). On the very first tap it
   * shows the animated tip modal and resolves when the user acts on it:
   * true from the primary button (continue into the scanner), false from
   * Android hardware back (dismiss without scanning). Both paths mark the
   * tip seen fire-and-forget — a persistence failure never blocks scanning
   * (scanner-tip-flag.ts degrades to once-per-session in memory).
   */
  function maybeShowScannerTip(): Promise<boolean> {
    // A tap is already parked on the tip — don't stack a second resolver
    // (two `true`s would launch the scanner twice).
    if (tipResolveRef.current) return Promise.resolve(false);
    return hasSeenScanTip().then((seen) => {
      if (seen) return true;
      return new Promise<boolean>((resolve) => {
        tipResolveRef.current = resolve;
        setTipVisible(true);
      });
    });
  }

  function closeScannerTip(proceed: boolean) {
    setTipVisible(false);
    void markScanTipSeen(); // fire-and-forget — never awaited on the scan path
    tipResolveRef.current?.(proceed);
    tipResolveRef.current = null;
  }

  /**
   * Native document scanner (iOS VisionKit / Android ML Kit — edge detection,
   * perspective crop, multi-page). One page uploads exactly like Take Photo
   * (resized image); two-plus pages become a single fit-to-page PDF. The
   * scanner module is lazy-loaded inside scanDocumentPages, so an old binary
   * without it gets a friendly alert instead of a crash.
   */
  async function scanDocument() {
    // First scan ever: show the auto-capture/Manual-shutter tip, then flow
    // this same tap straight into the scanner when the user taps "Got it".
    if (!(await maybeShowScannerTip())) return;
    const scan = await scanDocumentPages();
    if (scan.status === 'unavailable') {
      Alert.alert(
        'Scanner unavailable',
        'Document scanning is not supported by this version of the app. Update from the App Store and try again.',
      );
      return;
    }
    if (scan.status === 'cancelled') return;
    const plan = routeScannedPages(scan.pages);
    if (!plan) return;
    setBusy(true);
    try {
      if (plan.kind === 'image') {
        const resized = await resizeForUpload(plan.uri);
        await uploadToPo({
          uri: resized.uri,
          ext: resized.ext,
          fileName: scanFileName(resized.ext),
        });
      } else {
        const pdf = await assemblePdf(plan.uris);
        await uploadToPo({
          uri: pdf.uri,
          ext: 'pdf',
          fileName: scanFileName('pdf'),
          contentType: 'application/pdf',
          // bytes can be 0 if sizing failed — fall back to the buffer length.
          sizeBytes: pdf.bytes || undefined,
        });
      }
    } catch (e) {
      if (e instanceof PdfTooLargeError) {
        Alert.alert(
          'Scan too large',
          'Even compressed, this scan is over the 15 MB attachment limit. Scan fewer pages per attachment and try again.',
        );
      } else {
        Alert.alert('Scan failed', 'Could not process the scanned document. Please try again.');
      }
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

      {canManage && (
        <Pressable
          onPress={() => void scanDocument()}
          disabled={busy}
          style={({ pressed }) => [
            styles.scanBtn,
            pressed && { opacity: 0.7 },
            busy && { opacity: 0.5 },
          ]}
        >
          <Text style={styles.scanBtnText}>📄 Scan Document</Text>
        </Pressable>
      )}

      {busy && uploadPercent !== null && (
        // Real transported progress for the in-flight upload — same track/fill
        // idiom as the maintenance photo rows (app/maintenance/new.tsx).
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${Math.max(4, uploadPercent)}%` }]} />
        </View>
      )}

      {loading ? (
        <ActivityIndicator color={theme.primary} style={{ marginTop: space.sm }} />
      ) : loadError && items.length === 0 ? (
        <Pressable onPress={() => void load()}>
          <Text style={styles.errorText}>
            Couldn’t load attachments — tap to retry. ({loadError})
          </Text>
        </Pressable>
      ) : items.length === 0 ? (
        <Text style={styles.muted}>
          {canManage ? 'No files yet. Add a photo or PDF of the packing slip.' : 'No files attached.'}
        </Text>
      ) : (
        items.map((row) => (
          <View key={row.id} style={styles.fileRow}>
            <Pressable
              style={{ flex: 1 }}
              onPress={() => {
                if (row.url) {
                  void Linking.openURL(row.url);
                } else {
                  // Signed-URL minting failed (offline, or a storage-RLS
                  // denial) — say so instead of a dead tap.
                  Alert.alert(
                    'Couldn’t open file',
                    'No download link is available right now. Pull to refresh and try again.',
                  );
                }
              }}
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

      <ScannerTip
        visible={tipVisible}
        onContinue={() => closeScannerTip(true)}
        onRequestClose={() => closeScannerTip(false)}
      />
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
  scanBtn: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: radius.sm,
    paddingVertical: 8,
    alignItems: 'center',
    marginTop: space.sm,
  },
  scanBtnText: { color: theme.text, fontWeight: '700', fontSize: 13 },
  progressTrack: {
    marginTop: space.sm,
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: theme.border,
  },
  progressFill: {
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.text,
  },
  muted: { color: theme.textMuted, fontSize: 13, marginTop: space.sm },
  errorText: { color: '#c0392b', fontSize: 13, marginTop: space.sm },
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
