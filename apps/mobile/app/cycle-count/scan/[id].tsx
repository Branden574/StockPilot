import { CameraView, useCameraPermissions } from 'expo-camera';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { SyncStatusBadge } from '@/components/SyncStatusBadge';
import { useAuth } from '@/lib/auth-context';
import {
  getCycleCount,
  updateLocalLine,
  type CachedCycleCountLine,
} from '@/lib/cycle-count-cache';
import { cycleCountSync } from '@/lib/cycle-count-sync';
import { radius, space, theme } from '@/lib/theme';

interface SheetState {
  line: CachedCycleCountLine;
  qty: string;
}

/**
 * Scan-to-count flow. Opens the camera; each scan resolves an item by
 * matching its barcode/sku against the *cached cycle count's* line set
 * — purely local, no Supabase round-trip — so this works offline.
 *
 * Each confirm calls `updateLocalLine` which writes to SQLite and
 * enqueues an outbox row. The sync engine drains the outbox when
 * online.
 *
 * Burst-mode toggle: re-scanning the same barcode within 600ms is
 * de-duped; in burst mode subsequent scans of the same item just
 * increment counted by 1.
 *
 * BARCODE SCOPE IS EXPLICIT, AND IT IS THE VARIANT.
 *
 * `cycle_count_lines` FKs an item and a variant IS an item, so every line in
 * the cached set is already a single variant with its own barcode and SKU.
 * Scanning a variant barcode therefore resolves to that variant and counts
 * exactly it. There is no group barcode to scan: a product group is identity
 * and owns no quantity, so a group-level scan has no line to land on and none
 * is invented — an unmatched code says so and counts nothing.
 *
 * NO SERIAL SCAN IS DEMANDED, and none may be added here. An ordinary pair of
 * shoes or a jersey is quantity-tracked: it has no serial, and a jersey NUMBER
 * is not one. This screen counts a QUANTITY against a line and never reads,
 * requires or validates a serial — nothing below asks for one, and the confirm
 * sheet's only input is a number.
 */
// This route is presented as a `fullScreenModal` (see app/_layout.tsx), which
// on iOS renders in a container OUTSIDE the root SafeAreaProvider — so the
// inner SafeAreaView insets resolve to 0 and the top bar collides with the
// status bar. Give the modal its own SafeAreaProvider so `edges={['top']}`
// resolves correctly. The AI Shelf Scan route (presentation: 'card') stays
// inside the root provider and does not need this.
export default function CycleCountScanScreen() {
  return (
    <SafeAreaProvider>
      <CycleCountScanScreenInner />
    </SafeAreaProvider>
  );
}

function CycleCountScanScreenInner() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const [permission, requestPermission] = useCameraPermissions();

  const [lines, setLines] = React.useState<CachedCycleCountLine[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [sheet, setSheet] = React.useState<SheetState | null>(null);
  const [burstMode, setBurstMode] = React.useState(false);
  const [lastScan, setLastScan] = React.useState<{ code: string; at: number } | null>(null);
  const [scannedMap, setScannedMap] = React.useState<Map<string, number>>(new Map());

  React.useEffect(() => {
    if (!user || !id) return;
    void loadLines();
  }, [user, id]);

  async function loadLines() {
    if (!id) return;
    const snap = await getCycleCount(id);
    if (!snap) {
      // Detail screen handles the offline-uncached state; if we land
      // here without a cache there's nothing to scan against.
      Alert.alert(
        'No cached lines',
        'Open this cycle count from the list once while online so it can be cached for offline scanning.',
        [{ text: 'OK', onPress: () => router.back() }],
      );
      return;
    }
    setLines(snap.lines);
    // Seed the per-line counted map from cache so the header tally
    // reflects already-counted lines.
    const seed = new Map<string, number>();
    for (const l of snap.lines) if (l.counted != null) seed.set(l.id, l.counted);
    setScannedMap(seed);
  }

  async function recordCount(line: CachedCycleCountLine, qty: number) {
    if (!Number.isFinite(qty) || qty < 0) return;
    setBusy(true);
    await updateLocalLine(line.id, qty);
    setScannedMap((m) => new Map(m).set(line.id, qty));
    setLines((curr) =>
      curr.map((l) =>
        l.id === line.id ? { ...l, counted: qty, localDirty: true } : l,
      ),
    );
    await cycleCountSync.refreshPendingCount();
    void cycleCountSync.forceSync();
    setBusy(false);
  }

  function findLineByCode(code: string): CachedCycleCountLine | null {
    const norm = code.trim();
    if (!norm) return null;
    const byBarcode = lines.find((l) => l.itemBarcode && l.itemBarcode === norm);
    if (byBarcode) return byBarcode;
    const bySku = lines.find((l) => l.itemSku === norm);
    return bySku ?? null;
  }

  async function onBarcode({ data }: { data: string }) {
    const code = data.trim();
    if (!code || busy) return;

    // De-dupe rapid double-fires from the same code.
    const now = Date.now();
    if (lastScan && lastScan.code === code && now - lastScan.at < 600) return;
    setLastScan({ code, at: now });

    const line = findLineByCode(code);
    if (!line) {
      // Never guess. A code that matches no line in the snapshot counts
      // nothing — inventing a line would post stock against an item this
      // count never scoped.
      Alert.alert(
        'Not in this count',
        `No item with barcode/SKU "${code}" in this cycle count's scope. Scan the barcode on the individual size or number, not a shared product label.`,
      );
      return;
    }

    if (burstMode) {
      const current = scannedMap.get(line.id) ?? line.counted ?? 0;
      const next = current + 1;
      await recordCount(line, next);
      return;
    }

    setSheet({ line, qty: String(line.expected) });
  }

  async function confirmSheet() {
    if (!sheet) return;
    const num = Number(sheet.qty);
    if (!Number.isFinite(num) || num < 0) {
      Alert.alert('Invalid count', 'Enter a non-negative number.');
      return;
    }
    await recordCount(sheet.line, num);
    setSheet(null);
  }

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
        <View style={styles.center}>
          <Text style={styles.permTitle}>Camera access needed</Text>
          <Text style={styles.permBody}>
            {permission.canAskAgain
              ? 'Scan-to-count uses the camera to read item barcodes.'
              : 'Camera access is off for StockPilot. Turn it on in Settings to scan-to-count.'}
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

  const total = lines.length;
  const counted = lines.filter(
    (l) => scannedMap.has(l.id) || l.counted != null,
  ).length;

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ headerShown: false }} />
      {!sheet ? (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{
            barcodeTypes: ['qr', 'ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'code93', 'codabar', 'pdf417'],
          }}
          onBarcodeScanned={onBarcode}
        />
      ) : null}

      <SafeAreaView style={StyleSheet.absoluteFill} edges={['top', 'bottom']} pointerEvents="box-none">
        <View style={styles.topBar} pointerEvents="auto">
          <Pressable style={styles.closeBtn} onPress={() => router.back()}>
            <Text style={styles.closeText}>Done</Text>
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerLabel}>Counting</Text>
            <Text style={styles.headerSub}>
              {counted} of {total} done
            </Text>
          </View>
          <SyncStatusBadge />
          <Pressable
            style={[styles.burstBtn, burstMode && styles.burstBtnOn]}
            onPress={() => setBurstMode((v) => !v)}
          >
            <Text style={[styles.burstLabel, burstMode && styles.burstLabelOn]}>
              {burstMode ? 'Burst' : 'Burst off'}
            </Text>
          </Pressable>
        </View>

        {!sheet && (
          <View style={styles.frameWrap} pointerEvents="none">
            <View style={styles.frame} />
            <Text style={styles.hint}>
              {burstMode
                ? 'Burst mode — scan to add 1 to count'
                : 'Scan a barcode to record the line'}
            </Text>
          </View>
        )}

        {sheet && (
          <View style={styles.sheet}>
            <Text style={styles.sheetSku}>{sheet.line.itemSku || sheet.line.itemId.slice(0, 8)}</Text>
            <Text style={styles.sheetName} numberOfLines={2}>
              {sheet.line.itemName}
            </Text>
            {/* WHICH VARIANT was scanned. Six sizes of one shoe carry six
                barcodes and near-identical names; without this the counter
                cannot tell which line the sheet is about. */}
            {sheet.line.itemVariantLabel ? (
              <Text style={styles.sheetVariant}>{sheet.line.itemVariantLabel}</Text>
            ) : null}
            <View style={styles.row}>
              <View style={styles.kv}>
                <Text style={styles.kvLabel}>Expected</Text>
                <Text style={styles.kvValue}>{sheet.line.expected}</Text>
              </View>
              <View style={[styles.kv, { flex: 1 }]}>
                <Text style={styles.kvLabel}>Counted</Text>
                <TextInput
                  style={styles.qtyInput}
                  keyboardType="numeric"
                  value={sheet.qty}
                  onChangeText={(v) => setSheet({ ...sheet, qty: v })}
                  selectTextOnFocus
                />
              </View>
            </View>
            <View style={styles.actions}>
              <Pressable style={[styles.btn, styles.btnGhost]} onPress={() => setSheet(null)} disabled={busy}>
                <Text style={styles.btnGhostLabel}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.btn, styles.btnPrimary, busy && { opacity: 0.5 }]}
                onPress={confirmSheet}
                disabled={busy}
              >
                <Text style={styles.btnPrimaryLabel}>{busy ? 'Saving…' : 'Save'}</Text>
              </Pressable>
            </View>
          </View>
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: space.xl, backgroundColor: theme.bg },
  topBar: {
    flexDirection: 'row',
    gap: space.sm,
    padding: space.md,
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  closeBtn: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: radius.sm, backgroundColor: 'rgba(255,255,255,0.12)' },
  closeText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  headerLabel: { color: '#fff', fontSize: 12, opacity: 0.7 },
  headerSub: { color: '#fff', fontSize: 14, fontWeight: '700' },
  burstBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  burstBtnOn: { backgroundColor: theme.primary },
  burstLabel: { color: '#fff', fontWeight: '700', fontSize: 12 },
  burstLabelOn: { color: '#fff' },
  frameWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  frame: { width: 260, height: 260, borderWidth: 2, borderColor: theme.primary, borderRadius: radius.xl },
  hint: { color: '#fff', marginTop: space.lg, fontSize: 13, fontWeight: '500' },
  sheet: {
    position: 'absolute',
    bottom: 30,
    left: space.lg,
    right: space.lg,
    padding: space.lg,
    borderRadius: radius.xl,
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.border,
  },
  sheetSku: { color: theme.textMuted, fontFamily: 'Menlo', fontSize: 11 },
  sheetName: { color: theme.text, fontSize: 17, fontWeight: '700', marginTop: 2 },
  sheetVariant: { color: theme.primary, fontSize: 14, fontWeight: '700', marginTop: 2 },
  row: { flexDirection: 'row', gap: space.md, marginTop: space.md },
  kv: { flex: 1 },
  kvLabel: { color: theme.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 },
  kvValue: { color: theme.text, fontSize: 22, fontWeight: '700', marginTop: 2 },
  qtyInput: {
    backgroundColor: theme.bgElevated,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: theme.border,
    color: theme.text,
    fontSize: 22,
    fontWeight: '700',
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginTop: 2,
  },
  actions: { flexDirection: 'row', gap: space.md, marginTop: space.lg },
  btn: { flex: 1, paddingVertical: 14, borderRadius: radius.md, alignItems: 'center' },
  btnGhost: { backgroundColor: theme.bgElevated, borderWidth: 1, borderColor: theme.border },
  btnGhostLabel: { color: theme.text, fontWeight: '600', fontSize: 14 },
  btnPrimary: { backgroundColor: theme.primary },
  btnPrimaryLabel: { color: '#fff', fontWeight: '700', fontSize: 14 },
  permTitle: { color: theme.text, fontSize: 20, fontWeight: '700' },
  permBody: { color: theme.textMuted, fontSize: 14, textAlign: 'center', marginTop: space.sm },
  cta: { backgroundColor: theme.primary, paddingHorizontal: space.lg, paddingVertical: 12, borderRadius: radius.md, marginTop: space.lg },
  ctaLabel: { color: '#fff', fontWeight: '600' },
});
