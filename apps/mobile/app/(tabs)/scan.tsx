import { CameraView, useCameraPermissions } from 'expo-camera';
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
import { supabase } from '@/lib/supabase';
import { radius, space, theme } from '@/lib/theme';

interface FoundItem {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  quantity_on_hand: number;
  reorder_point: number;
  retail_price: number;
  unit_cost: number;
  primary_location_name: string | null;
  bin_location: string | null;
  custom_fields: Record<string, unknown> | null;
  image_url: string | null;
}

/**
 * Pulls the deep-link URL pattern out of a scanned QR/barcode value.
 * The /api/v1/items/[id]/barcode QR endpoint encodes
 *   <origin>/p/items/<uuid>          (current — public read-only page)
 *   <origin>/dashboard/inventory/<uuid>  (legacy — pre-2026-05-06 stickers)
 *   <origin>/dashboard/books/<uuid>      (legacy)
 * so we accept any of the three for back-compat with already-printed
 * labels.
 */
function parseItemId(scanned: string): string | null {
  const match = scanned.match(
    /\/(?:p\/items|dashboard\/(?:inventory|books))\/([0-9a-f-]{36})/i,
  );
  return match?.[1] ?? null;
}

function formatCurrency(n: number): string {
  return `$${n.toFixed(2)}`;
}

function readBookStorage(cf: Record<string, unknown> | null) {
  const f = cf ?? {};
  const rackNumber = f.book_rack_number ? String(f.book_rack_number) : null;
  const rackRow = f.book_rack_row ? String(f.book_rack_row) : null;
  const crateColor = f.book_crate_color ? String(f.book_crate_color) : null;
  const crateNumber = f.book_crate_number ? String(f.book_crate_number) : null;
  const grade = f.book_grade ? String(f.book_grade) : null;
  const rackLabel =
    rackNumber || rackRow ? [rackNumber, rackRow].filter(Boolean).join('-') : null;
  return { rackLabel, crateColor, crateNumber, grade };
}

const CRATE_HEX: Record<string, string> = {
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#eab308',
  green: '#22c55e',
  blue: '#3b82f6',
  purple: '#a855f7',
  pink: '#ec4899',
  black: '#27272a',
  white: '#f4f4f5',
  gray: '#9ca3af',
};

export default function Scan() {
  const { user } = useAuth();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = React.useState(true);
  const [orgId, setOrgId] = React.useState<string | null>(null);
  const [item, setItem] = React.useState<FoundItem | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [lastCode, setLastCode] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!user) return;
    supabase
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', user.id)
      .not('accepted_at', 'is', null)
      .limit(1)
      .maybeSingle()
      .then(({ data }) => setOrgId((data?.organization_id as string | undefined) ?? null));
  }, [user]);

  /** Loads an item's rich detail (with image + location name) by id. */
  async function loadItemById(id: string): Promise<FoundItem | null> {
    if (!orgId) return null;
    const { data: row } = await supabase
      .from('inventory_items')
      .select(
        `id, name, sku, barcode, quantity_on_hand, reorder_point,
         retail_price, unit_cost, bin_location, custom_fields,
         primary_location:locations!primary_location_id (name)`,
      )
      .eq('organization_id', orgId)
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle();
    if (!row) return null;

    // Primary image (or first image) — the path lives in item_images,
    // we sign a URL for the storage object.
    const { data: imgRow } = await supabase
      .from('item_images')
      .select('storage_path')
      .eq('item_id', (row as { id: string }).id)
      .order('is_primary', { ascending: false })
      .order('sort_order', { ascending: true })
      .limit(1)
      .maybeSingle();
    let imageUrl: string | null = null;
    if (imgRow?.storage_path) {
      const { data: signed } = await supabase.storage
        .from('item-images')
        .createSignedUrl(imgRow.storage_path as string, 60 * 60);
      imageUrl = signed?.signedUrl ?? null;
    }

    const r = row as Record<string, unknown>;
    const loc = r.primary_location as { name?: string } | { name?: string }[] | null;
    const locName = Array.isArray(loc) ? loc[0]?.name : loc?.name;
    return {
      id: r.id as string,
      name: r.name as string,
      sku: r.sku as string,
      barcode: (r.barcode as string | null) ?? null,
      quantity_on_hand: Number(r.quantity_on_hand) || 0,
      reorder_point: Number(r.reorder_point) || 0,
      retail_price: Number(r.retail_price) || 0,
      unit_cost: Number(r.unit_cost) || 0,
      primary_location_name: locName ?? null,
      bin_location: (r.bin_location as string | null) ?? null,
      custom_fields: (r.custom_fields as Record<string, unknown> | null) ?? null,
      image_url: imageUrl,
    };
  }

  /** Loads an item by scanned bare value (matches barcode or SKU). */
  async function loadItemByValue(value: string): Promise<FoundItem | null> {
    if (!orgId) return null;
    const { data: row } = await supabase
      .from('inventory_items')
      .select('id')
      .eq('organization_id', orgId)
      .or(`barcode.eq.${value},sku.eq.${value}`)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle();
    if (!row) return null;
    return loadItemById((row as { id: string }).id);
  }

  async function onBarCodeScanned({ data }: { data: string }) {
    if (busy || !orgId || data === lastCode) return;
    setLastCode(data);
    setBusy(true);
    setScanning(false);

    // QR code from a printed StockPilot label encodes a URL with
    // /dashboard/inventory/<id> — pull the id out and load by id
    // directly. Plain barcodes (Code 128 / EAN / UPC) don't carry the
    // URL prefix, so they fall through to barcode/sku lookup.
    const directId = parseItemId(data);
    const found = directId
      ? await loadItemById(directId)
      : await loadItemByValue(data);

    if (!found) {
      Alert.alert('Not found', `No item matches ${data}.`, [{ text: 'OK', onPress: reset }]);
      setBusy(false);
      return;
    }
    setItem(found);
    setBusy(false);
  }

  function reset() {
    setItem(null);
    setLastCode(null);
    setScanning(true);
  }

  async function adjust(delta: number) {
    if (!item) return;
    setBusy(true);
    const { error } = await supabase.rpc('adjust_stock', {
      p_item_id: item.id,
      p_quantity_change: delta,
      p_movement_type: delta > 0 ? 'add' : 'remove',
      p_location_id: null,
      p_reason: 'Mobile scan',
      p_notes: null,
    });
    setBusy(false);
    if (error) {
      Alert.alert('Could not adjust', error.message);
      return;
    }
    setItem({ ...item, quantity_on_hand: item.quantity_on_hand + delta });
  }

  if (!permission) return <CenterMessage>Loading camera permission…</CenterMessage>;
  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.permission}>
          <Text style={styles.permTitle}>Camera access needed</Text>
          <Text style={styles.permBody}>StockPilot uses the camera to scan barcodes and QR codes.</Text>
          <Pressable style={styles.cta} onPress={requestPermission}>
            <Text style={styles.ctaLabel}>Grant access</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const storage = item ? readBookStorage(item.custom_fields) : null;
  const crateHex =
    storage?.crateColor && CRATE_HEX[storage.crateColor]
      ? CRATE_HEX[storage.crateColor]
      : null;
  const lowStock =
    item && item.reorder_point > 0 && item.quantity_on_hand <= item.reorder_point;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {scanning && !item ? (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{
            barcodeTypes: ['qr', 'ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'code93', 'codabar', 'pdf417'],
          }}
          onBarcodeScanned={onBarCodeScanned}
        />
      ) : null}

      <View style={styles.overlay} pointerEvents="box-none">
        <View style={styles.frame} />
        <Text style={styles.hint}>{scanning && !item ? 'Point at a barcode or QR code' : ''}</Text>
      </View>

      {item && (
        <View style={styles.sheet}>
          <ScrollView contentContainerStyle={{ paddingBottom: space.md }}>
            <View style={styles.headerRow}>
              {item.image_url ? (
                <Image source={{ uri: item.image_url }} style={styles.thumb} />
              ) : (
                <View style={[styles.thumb, styles.thumbPlaceholder]}>
                  <Text style={styles.thumbPlaceholderText}>No image</Text>
                </View>
              )}
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.sheetSku} numberOfLines={1}>
                  {item.sku}
                  {item.barcode ? ` · ${item.barcode}` : ''}
                </Text>
                <Text style={styles.sheetName} numberOfLines={2}>
                  {item.name}
                </Text>
              </View>
            </View>

            <View style={styles.statRow}>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>On hand</Text>
                <Text
                  style={[styles.statValue, lowStock && { color: theme.warning }]}
                >
                  {item.quantity_on_hand}
                </Text>
              </View>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Reorder at</Text>
                <Text style={styles.statValueMuted}>{item.reorder_point}</Text>
              </View>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Price</Text>
                <Text style={styles.statValueMuted}>
                  {formatCurrency(item.retail_price)}
                </Text>
              </View>
            </View>

            {(item.primary_location_name ||
              item.bin_location ||
              storage?.rackLabel ||
              storage?.crateNumber ||
              storage?.grade) && (
              <View style={styles.locationBox}>
                {item.primary_location_name && (
                  <LocRow label="Location" value={item.primary_location_name} />
                )}
                {item.bin_location && (
                  <LocRow label="Bin/shelf" value={item.bin_location} />
                )}
                {storage?.rackLabel && (
                  <LocRow label="Rack" value={storage.rackLabel} mono />
                )}
                {storage?.crateNumber && crateHex && (
                  <View style={styles.locRow}>
                    <Text style={styles.locLabel}>Crate</Text>
                    <View
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
                    >
                      <View
                        style={[
                          styles.crateDot,
                          { backgroundColor: crateHex },
                        ]}
                      />
                      <Text style={styles.locValue}>{storage.crateNumber}</Text>
                    </View>
                  </View>
                )}
                {storage?.grade && (
                  <LocRow
                    label="Grade"
                    value={
                      /^\d{1,2}$/.test(storage.grade)
                        ? `Grade ${storage.grade}`
                        : storage.grade
                    }
                  />
                )}
              </View>
            )}

            <View style={styles.actions}>
              <ActionBtn label="−1" onPress={() => adjust(-1)} disabled={busy} />
              <ActionBtn label="+1" onPress={() => adjust(1)} disabled={busy} primary />
              <ActionBtn label="+5" onPress={() => adjust(5)} disabled={busy} primary />
              <ActionBtn label="+25" onPress={() => adjust(25)} disabled={busy} />
            </View>

            <Pressable style={styles.dismiss} onPress={reset}>
              <Text style={styles.dismissLabel}>Scan another</Text>
            </Pressable>
          </ScrollView>
        </View>
      )}

      {busy && !item && <ActivityIndicator style={styles.spinner} color={theme.primary} size="large" />}
    </SafeAreaView>
  );
}

function LocRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.locRow}>
      <Text style={styles.locLabel}>{label}</Text>
      <Text style={[styles.locValue, mono && { fontFamily: 'Menlo' }]}>{value}</Text>
    </View>
  );
}

function ActionBtn({ label, onPress, disabled, primary }: { label: string; onPress: () => void; disabled?: boolean; primary?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.actionBtn,
        primary && { backgroundColor: theme.primary },
        pressed && { opacity: 0.7 },
        disabled && { opacity: 0.4 },
      ]}
    >
      <Text style={[styles.actionLabel, primary && { color: '#fff' }]}>{label}</Text>
    </Pressable>
  );
}

function CenterMessage({ children }: { children: React.ReactNode }) {
  return (
    <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
      <Text style={{ color: theme.textMuted }}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 80,
  },
  frame: {
    width: 260,
    height: 260,
    borderWidth: 2,
    borderColor: theme.primary,
    borderRadius: radius.xl,
  },
  hint: { color: '#fff', marginTop: space.lg, fontSize: 13, fontWeight: '500' },
  sheet: {
    position: 'absolute',
    bottom: 90,
    left: space.lg,
    right: space.lg,
    maxHeight: '75%',
    backgroundColor: theme.card,
    borderRadius: radius.xl,
    padding: space.lg,
    borderWidth: 1,
    borderColor: theme.border,
  },
  headerRow: { flexDirection: 'row', gap: space.md, alignItems: 'center' },
  thumb: { width: 72, height: 72, borderRadius: radius.md, backgroundColor: theme.bgElevated },
  thumbPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  thumbPlaceholderText: { color: theme.textMuted, fontSize: 10 },
  sheetSku: { color: theme.textMuted, fontSize: 11, fontFamily: 'Menlo' },
  sheetName: { color: theme.text, fontSize: 17, fontWeight: '700', marginTop: 2 },
  statRow: {
    flexDirection: 'row',
    gap: space.md,
    marginTop: space.lg,
  },
  stat: { flex: 1 },
  statLabel: {
    color: theme.textMuted,
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontWeight: '600',
  },
  statValue: { color: theme.text, fontSize: 22, fontWeight: '700', marginTop: 2 },
  statValueMuted: { color: theme.text, fontSize: 14, fontWeight: '600', marginTop: 2 },
  locationBox: {
    marginTop: space.md,
    padding: space.md,
    backgroundColor: theme.bgElevated,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: theme.border,
    gap: 6,
  },
  locRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  locLabel: { color: theme.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 },
  locValue: { color: theme.text, fontSize: 13, fontWeight: '600' },
  crateDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: theme.border,
  },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.lg },
  actionBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: radius.md,
    backgroundColor: theme.bgElevated,
    borderWidth: 1,
    borderColor: theme.border,
    alignItems: 'center',
  },
  actionLabel: { color: theme.text, fontWeight: '700', fontSize: 14 },
  dismiss: { marginTop: space.md, alignItems: 'center', paddingVertical: 8 },
  dismissLabel: { color: theme.primary, fontSize: 13, fontWeight: '600' },
  permission: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: space.xl, backgroundColor: theme.bg },
  permTitle: { color: theme.text, fontSize: 20, fontWeight: '700' },
  permBody: { color: theme.textMuted, fontSize: 14, textAlign: 'center', marginTop: space.sm },
  cta: { backgroundColor: theme.primary, paddingHorizontal: space.lg, paddingVertical: 12, borderRadius: radius.md, marginTop: space.lg },
  ctaLabel: { color: '#fff', fontWeight: '600' },
  spinner: { position: 'absolute', top: '50%', left: '50%' },
});
