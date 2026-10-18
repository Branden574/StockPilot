import { CameraView, useCameraPermissions } from 'expo-camera';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { SyncStatusBadge } from '@/components/SyncStatusBadge';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth-context';
import {
  getCycleCount,
  updateLocalLine,
  type CachedCycleCountLine,
} from '@/lib/cycle-count-cache';
import { cycleCountSync } from '@/lib/cycle-count-sync';
import { shouldStackRow } from '@/lib/dynamic-type-layout';
import { FONT, TYPE_CEILING, capTo, palette, radius, space } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

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
  // The confirm sheet and the permission screen follow the device's mode;
  // the camera chrome is dark in both (CAMERA, below).
  const { c } = useTheme();
  const stacked = shouldStackRow(useWindowDimensions().fontScale);

  const [lines, setLines] = React.useState<CachedCycleCountLine[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [sheet, setSheet] = React.useState<SheetState | null>(null);
  const [burstMode, setBurstMode] = React.useState(false);
  const [lastScan, setLastScan] = React.useState<{ code: string; at: number } | null>(null);
  const [scannedMap, setScannedMap] = React.useState<Map<string, number>>(new Map());

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

  React.useEffect(() => {
    if (!user || !id) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: every set is post-await; the effect synchronizes with the server
    void loadLines();
    // loadLines is a plain function, new on every render (it reads only id
    // and the router): listing it would load the lines on every render. The
    // lines load once per signed-in user and count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, id]);


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
    // An emptied box is not a count of 0. Number('') is 0, so a box cleared to
    // type a new number and saved before the typing recorded zero stock for
    // the line; the count screen records nothing from an empty box either. A
    // typed 0 is still a count of 0.
    const raw = sheet.qty.trim();
    const num = raw === '' ? Number.NaN : Number(raw);
    if (!Number.isFinite(num) || num < 0) {
      Alert.alert('Invalid count', 'Enter a non-negative number.');
      return;
    }
    await recordCount(sheet.line, num);
    setSheet(null);
  }

  if (!permission) {
    return (
      <View style={[styles.center, { backgroundColor: c.paper }]}>
        <ActivityIndicator color={c.ink} />
      </View>
    );
  }
  if (!permission.granted) {
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: c.paper }]} edges={['top']}>
        <View style={styles.center}>
          <Text style={[styles.permTitle, { color: c.ink }]}>Camera access needed</Text>
          <Text style={[styles.permBody, { color: c.ink3 }]}>
            {permission.canAskAgain
              ? 'Scan-to-count uses the camera to read item barcodes.'
              : 'Camera access is off for StockPilot. Turn it on in Settings to scan-to-count.'}
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

  const total = lines.length;
  const counted = lines.filter(
    (l) => scannedMap.has(l.id) || l.counted != null,
  ).length;

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ headerShown: false }} />
      {/* The bar is dark in both modes, so the clock and battery over it are light. */}
      <StatusBar style="light" />
      {/* Dynamic Type: camera chrome over a LIVE viewfinder cannot grow the
          bar or scroll it, and the `flex: 1` tally column is the only
          shrinkable child — so uncapped Done and Burst eat the whole deficit
          and the live count (the reason the bar exists) disappears. Cap the
          two controls at the chrome ceiling; the tally itself keeps scaling. */}
      <SafeAreaView edges={['top']} style={styles.barArea}>
        <View style={styles.topBar}>
          <Pressable
            style={styles.closeFrame}
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Done"
          >
            <View style={styles.closeBtn}>
              <Text style={styles.closeText} numberOfLines={1} maxFontSizeMultiplier={CLOSE_CAP}>
                Done
              </Text>
            </View>
          </Pressable>
          <View style={styles.titleCol}>
            <Text style={styles.headerLabel} maxFontSizeMultiplier={TITLE_CAP}>
              Counting
            </Text>
            <Text style={styles.headerSub}>
              {counted} of {total} done
            </Text>
          </View>
          <SyncStatusBadge surface="camera" />
          {/* The reference's Single / Batch switch: "Burst off" is Single (each
              scan opens the confirm sheet), "Burst" is Batch (each scan adds 1).
              One control, as before: a tap anywhere on it flips the mode. */}
          <Pressable
            style={styles.burstFrame}
            onPress={() => setBurstMode((v) => !v)}
            accessibilityRole="switch"
            accessibilityLabel="Burst"
            accessibilityState={{ checked: burstMode }}
          >
            <View style={styles.burstTrack}>
              <View style={[styles.burstSegment, !burstMode && styles.burstSegmentOn]}>
                <Text
                  style={[styles.burstLabel, !burstMode && styles.burstLabelOn]}
                  numberOfLines={1}
                  maxFontSizeMultiplier={BURST_CAP}
                >
                  Burst off
                </Text>
              </View>
              <View style={[styles.burstSegment, burstMode && styles.burstSegmentOn]}>
                <Text
                  style={[styles.burstLabel, burstMode && styles.burstLabelOn]}
                  numberOfLines={1}
                  maxFontSizeMultiplier={BURST_CAP}
                >
                  Burst
                </Text>
              </View>
            </View>
          </Pressable>
        </View>
      </SafeAreaView>

      <View style={styles.viewfinder}>
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

        {/* The keyboard is a decimal pad, which has no key that puts it away:
            with the sheet left under it, the Counted box and Save were hidden
            the moment the box took focus. The sheet now rides above it. */}
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.fill}
          pointerEvents="box-none"
        >
          <SafeAreaView style={styles.fill} edges={['bottom']} pointerEvents="box-none">
            {!sheet && (
              <View style={styles.frameWrap} pointerEvents="none">
                <ScanFrame />
                <View style={styles.hintPill}>
                  <Text style={styles.hint}>
                    {burstMode
                      ? 'Burst mode — scan to add 1 to count'
                      : 'Scan a barcode to record the line'}
                  </Text>
                </View>
              </View>
            )}

            {sheet && (
              <View style={styles.sheetWrap}>
                <View style={[styles.sheet, { backgroundColor: c.card, borderColor: c.hair }]}>
                  <Text style={[styles.sheetSku, { color: c.ink3 }]}>
                    {sheet.line.itemSku || sheet.line.itemId.slice(0, 8)}
                  </Text>
                  <Text style={[styles.sheetName, { color: c.ink }]} numberOfLines={2}>
                    {sheet.line.itemName}
                  </Text>
                  {/* WHICH VARIANT was scanned. Six sizes of one shoe carry six
                      barcodes and near-identical names; without this the counter
                      cannot tell which line the sheet is about. */}
                  {sheet.line.itemVariantLabel ? (
                    <Text style={[styles.sheetVariant, { color: c.ink2 }]}>
                      {sheet.line.itemVariantLabel}
                    </Text>
                  ) : null}
                  <View style={[styles.row, stacked && styles.rowStacked]}>
                    <View style={styles.kv}>
                      <Text style={[styles.kvLabel, { color: c.ink3 }]}>Expected</Text>
                      <Text style={[styles.kvValue, { color: c.ink }]}>{sheet.line.expected}</Text>
                    </View>
                    <View style={styles.kv}>
                      <Text style={[styles.kvLabel, { color: c.ink3 }]}>Counted</Text>
                      <TextInput
                        style={[
                          styles.qtyInput,
                          { backgroundColor: c.sunk, borderColor: c.hair2, color: c.ink },
                        ]}
                        keyboardType="numeric"
                        value={sheet.qty}
                        onChangeText={(v) => setSheet({ ...sheet, qty: v })}
                        selectTextOnFocus
                        accessibilityLabel="Counted"
                      />
                    </View>
                  </View>
                  <View style={styles.actions}>
                    <Button
                      variant="outline"
                      onPress={() => setSheet(null)}
                      disabled={busy}
                      style={styles.actionBtn}
                    >
                      Cancel
                    </Button>
                    {/* Save commits the count: the ink button (redesign button rule). */}
                    <Button onPress={confirmSheet} disabled={busy} style={styles.actionBtn}>
                      {busy ? 'Saving…' : 'Save'}
                    </Button>
                  </View>
                </View>
              </View>
            )}
          </SafeAreaView>
        </KeyboardAvoidingView>
      </View>
    </View>
  );
}

/**
 * The reference viewfinder's finder: four corner brackets and a scan line in
 * the dark-mode mint (DESIGN-SPEC 6.20). It sits still, as the frame it
 * replaces did: nothing on this screen moves.
 */
function ScanFrame() {
  return (
    <View style={styles.frame}>
      <View style={[styles.corner, styles.cornerTL]} />
      <View style={[styles.corner, styles.cornerTR]} />
      <View style={[styles.corner, styles.cornerBL]} />
      <View style={[styles.corner, styles.cornerBR]} />
      <View style={styles.scanLine} />
    </View>
  );
}

/**
 * THE CAMERA CHROME IS DARK IN BOTH MODES. The bar and the viewfinder sit
 * over a live camera, which does not change with the device's mode, so they
 * draw from the dark palette whatever the mode is (DESIGN-SPEC 10: the
 * viewfinder and the reticle are fixed colours). The bar is solid, so every
 * word on it reads the same over any scene. The permission screen and the
 * confirm sheet are ordinary screens and follow the device (`useTheme`).
 */
const CAMERA_PALETTE = palette('dark');
const CAMERA = {
  /** The bar and the ground behind the camera: the reference viewfinder. */
  surface: '#0a0b09',
  ink: CAMERA_PALETTE.ink,
  ink2: CAMERA_PALETTE.ink2,
  ink3: CAMERA_PALETTE.ink3,
  /** A control on the bar: the raised fill with an outline at 3:1. */
  chip: CAMERA_PALETTE.card,
  chipBorder: CAMERA_PALETTE.ink4,
  /** The Burst switch's track, and the fill of its selected half. */
  track: CAMERA_PALETTE.hair2,
  segment: CAMERA_PALETTE.hair,
  /** Corner brackets and scan line: the reference's dark-mode mint. */
  reticle: CAMERA_PALETTE.accent,
  /** Behind the hint over the live picture, so it reads over a white shelf. */
  scrim: 'rgba(10, 11, 9, 0.72)',
} as const;

/** Chrome caps for the two pinned viewfinder controls (13pt Done, 12.5pt Burst). */
const CLOSE_CAP = capTo(13, TYPE_CEILING.chrome);
const BURST_CAP = capTo(12.5, TYPE_CEILING.chrome);
/**
 * The screen name is chrome too — it is the one thing in this bar the user
 * already knows, having just tapped the button that opened it. Capping it is
 * what buys the live tally beneath it the width to stay whole.
 */
const TITLE_CAP = capTo(12, TYPE_CEILING.chrome);

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: CAMERA.surface },
  fill: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: space.xl },
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
  /**
   * A FLOOR, not `minWidth: 0`. `flexWrap` on the bar can only move a sibling
   * to a second line if some child actually demands width, and Yoga measures
   * a text column against the space it is offered — so with `minWidth: 0` the
   * title silently reported ~0, nothing ever wrapped, and Done + the 60%-wide
   * SyncStatusBadge + Burst (all `flexShrink: 0`) squeezed the title to ~55pt
   * until "Counting" fractured into "Co / unt / ing".
   *
   * 120pt covers "Counting" at the 20pt title ceiling (~84pt) and the tally's
   * longest word, "done", at AX5 (14pt × 3.57 ≈ 108pt), so the tally wraps at
   * word boundaries rather than per character. At default size the title's own
   * content is wider than this, so nothing about the bar changes. The Burst
   * switch is the widest control on the bar and, on a phone, the one that
   * wraps to the bar's second line.
   */
  titleCol: { flex: 1, minWidth: 120 },
  // Done is a button in a frame at least 44pt tall around the same pill (it
  // was the ~28pt pill). -8 top and bottom leaves a 28pt slot, under the
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
  closeText: { color: CAMERA.ink, fontFamily: FONT.displaySemi, fontWeight: '600', fontSize: 13 },
  headerLabel: { color: CAMERA.ink2, fontFamily: FONT.display, fontSize: 12 },
  headerSub: { color: CAMERA.ink, fontFamily: FONT.displaySemi, fontWeight: '600', fontSize: 14 },
  // The switch is a frame at least 44pt tall around the 40pt track; -2 top
  // and bottom gives the bar back the difference.
  burstFrame: { minHeight: 44, justifyContent: 'center', marginVertical: -2, flexShrink: 0 },
  burstTrack: {
    flexDirection: 'row',
    gap: 2,
    padding: 3,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: CAMERA.track,
  },
  burstSegment: {
    minHeight: 32,
    paddingHorizontal: 10,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The selected half carries an outline at 3:1 as well as its fill, so which
  // mode is on never rests on a fill of 1.2:1 or on the words' weight alone.
  burstSegmentOn: { backgroundColor: CAMERA.segment, borderColor: CAMERA.chipBorder },
  burstLabel: { color: CAMERA.ink3, fontFamily: FONT.display, fontWeight: '500', fontSize: 12.5 },
  burstLabelOn: { color: CAMERA.ink, fontFamily: FONT.displaySemi, fontWeight: '600' },
  viewfinder: { flex: 1, backgroundColor: CAMERA.surface },
  frameWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  frame: { width: 260, height: 220 },
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
  scanLine: {
    position: 'absolute',
    left: '8%',
    right: '8%',
    top: '50%',
    marginTop: -1,
    height: 2,
    borderRadius: 1,
    backgroundColor: CAMERA.reticle,
    opacity: 0.7,
  },
  hintPill: {
    marginTop: space.lg,
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
  sheetWrap: { flex: 1, justifyContent: 'flex-end', padding: space.lg },
  sheet: {
    padding: space.lg,
    borderRadius: 16,
    borderWidth: 1,
  },
  sheetSku: { fontFamily: FONT.mono, fontSize: 11.5 },
  sheetName: {
    fontFamily: FONT.displaySemi,
    fontWeight: '600',
    fontSize: 17,
    lineHeight: 22,
    marginTop: 4,
  },
  sheetVariant: { fontFamily: FONT.displaySemi, fontWeight: '600', fontSize: 14, marginTop: 2 },
  row: { flexDirection: 'row', gap: space.md, marginTop: space.md },
  rowStacked: { flexDirection: 'column' },
  kv: { flex: 1, minWidth: 0 },
  kvLabel: {
    fontFamily: FONT.mono,
    fontSize: 10.5,
    letterSpacing: 10.5 * 0.12,
    textTransform: 'uppercase',
  },
  kvValue: { fontFamily: FONT.display, fontWeight: '500', fontSize: 28, marginTop: 4 },
  qtyInput: {
    borderRadius: radius.md,
    borderWidth: 1,
    fontFamily: FONT.display,
    fontWeight: '500',
    fontSize: 22,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginTop: 4,
  },
  actions: { flexDirection: 'row', gap: space.md, marginTop: space.lg },
  actionBtn: { flex: 1 },
  permTitle: { fontFamily: FONT.displaySemi, fontWeight: '600', fontSize: 20, textAlign: 'center' },
  permBody: {
    fontFamily: FONT.displayRegular,
    fontSize: 14.5,
    lineHeight: 21,
    textAlign: 'center',
    marginTop: space.sm,
  },
  cta: { marginTop: space.lg, minWidth: 200 },
});
